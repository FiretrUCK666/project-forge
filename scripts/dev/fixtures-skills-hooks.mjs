/**
 * fixtures-skills-hooks.mjs —— 技能动态发现、自有技能保护、分支保护与 Git Hooks 双向行为夹具。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  GENERIC_GIT_PROVIDER,
  getHostingProvider as getKitHostingProvider,
} from '../../kit/skills/lib/platform.mjs'
import {
  discoverCustomSkills,
  discoverKitSkills,
  discoverKitSkillsDetailed,
  parseSkillFrontmatter,
} from '../../kit/skills/lib/skill-discovery.mjs'
import { renderAgentsTemplate } from '../compose-agents.mjs'
import { protectBranch } from '../equip-ci.mjs'
import { checkEquip, equip } from '../equip.mjs'
import { renderKitRoutingRows } from '../lib/agents-defaults.mjs'
import { buildSwitchABranchProtectionPayload, createGitHubClient } from '../lib/platform/github-client.mjs'
import { GITHUB_PROVIDER } from '../lib/platform/github.mjs'
import { GENERIC_GIT_PROVIDER as ENGINE_GENERIC_GIT_PROVIDER, getHostingProvider as getEngineHostingProvider } from '../lib/platform/registry.mjs'
import { FORBIDDEN_PLATFORM_RE, getKitSkills } from '../lib/protocol.mjs'
import { toMarkdown } from '../lib/render.mjs'
import { detectKit } from '../lib/survey-reentry.mjs'
import { computeArtifactPlan, summarizeRemoteCapabilities } from '../survey.mjs'
import { gitCommitFast, gitInit, gitInitBare, gitSync, rmTree, runNode, SKILL_ROOT, survey, tmpProject } from './fixtures-helpers.mjs'
import { checkKitSuite } from './preflight-suite.mjs'

function walkFiles(dir, pred) {
  const out = []
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue
      out.push(...walkFiles(abs, pred))
    } else if (!pred || pred(abs)) {
      out.push(abs)
    }
  }
  return out
}

function makeSuiteCtx(root) {
  const errors = []
  const notes = []
  const rel = (abs) => relative(root, abs).replace(/\\/g, '/')
  return {
    errors,
    notes,
    ctx: {
      ROOT: root,
      rel,
      readText: (abs) => readFileSync(abs, 'utf8'),
      countLines: (t) => t.replace(/\r\n/g, '\n').split('\n').length,
      walk: walkFiles,
      fail: (msg) => errors.push(msg),
      note: (msg) => notes.push(msg),
    },
  }
}

function minimalSkillMd(name, desc, extraMetaLines = []) {
  const meta = extraMetaLines.length > 0 ? ['metadata:', ...extraMetaLines.map((l) => `  ${l}`)] : []
  return ['---', `name: ${name}`, `description: ${desc}`, ...meta, '---', '', `# ${name}`, ''].join('\n')
}

export function registerStageBOnboardingCases(cases) {
  // C1 正向：动态发现 5 技能顺序、无 metadata 安全默认值，以及无源码修改识别临时第 6 个内置技能
  cases.push(['StageB C1 正向：动态发现、无硬编码扫描与临时第 6 技能零改码接入全链路', async () => {
    const realKit = join(SKILL_ROOT, 'kit', 'skills')
    const { skills, diagnostics } = discoverKitSkillsDetailed(realKit)
    if (diagnostics.length > 0) return `真实 kit/skills 存在元数据诊断错误：${JSON.stringify(diagnostics)}`
    if (skills.length < 5) return `发现数量异常：${skills.length}`
    for (let i = 1; i < skills.length; i += 1) {
      if (skills[i - 1].order > skills[i].order) return `排序未按 metadata.order 升序：${skills.map((s) => `${s.dirName}:${s.order}`).join(',')}`
    }

    // 省略 metadata 时应用安全默认值（通过 discoverKitSkillsDetailed 验证）
    const defaultDir = mkdtempSync(join(tmpdir(), 'pf-c1-def-'))
    try {
      mkdirSync(join(defaultDir, 'dev-sample'), { recursive: true })
      writeFileSync(join(defaultDir, 'dev-sample', 'SKILL.md'), minimalSkillMd('dev-sample', '默认元数据技能说明'))
      const parsedDefault = parseSkillFrontmatter(readFileSync(join(defaultDir, 'dev-sample', 'SKILL.md'), 'utf8'))
      const defDisc = discoverKitSkillsDetailed(defaultDir)
      const defSkill = defDisc.skills[0]
      if (!parsedDefault.valid || defDisc.diagnostics.length > 0 || defSkill?.order !== 500 || defSkill?.script !== '') {
        return `缺省 metadata 默认值错误：${JSON.stringify({ parsedValid: parsedDefault.valid, defDisc })}`
      }
    } finally {
      rmTree(defaultDir)
    }

    // 静态扫描指定 8 份核心文件，确认无 KNOWN_KIT_SKILLS 或 5 技能字面数组
    const scanFiles = [
      'scripts/lib/protocol.mjs',
      'kit/skills/lib/cli.mjs',
      'scripts/equip.mjs',
      'scripts/compose-agents.mjs',
      'scripts/lib/agents-defaults.mjs',
      'scripts/lib/agents-sections.mjs',
      'scripts/lib/survey-reentry.mjs',
      'scripts/handoff.mjs',
    ]
    const fiveLiteralRe = /\[\s*['"]dev-explore['"]\s*,\s*['"]dev-plan['"]\s*,\s*['"]dev-flow['"]/
    for (const relPath of scanFiles) {
      const text = readFileSync(join(SKILL_ROOT, relPath), 'utf8')
      if (/\bKNOWN_KIT_SKILLS\b/.test(text)) return `${relPath} 仍残留 KNOWN_KIT_SKILLS`
      if (fiveLiteralRe.test(text)) return `${relPath} 仍包含硬编码多技能字面列表`
    }
    const tplText = readFileSync(join(SKILL_ROOT, 'templates', 'agents-project.md'), 'utf8')
    if (!tplText.includes('{{KIT_ROUTING_ROWS}}')) return 'templates/agents-project.md 缺少 {{KIT_ROUTING_ROWS}} 占位符'

    // 临时复制套件并投入第 6 个合规范内置技能（tier: both + script + order: 60）
    const scratch = mkdtempSync(join(tmpdir(), 'pf-c1-6th-'))
    try {
      const repoCopy = join(scratch, 'forge-copy')
      mkdirSync(join(repoCopy, 'kit'), { recursive: true })
      writeFileSync(join(repoCopy, 'SKILL.md'), '---\nname: project-forge\ndescription: tmp\n---\n')
      cpSync(realKit, join(repoCopy, 'kit', 'skills'), { recursive: true })
      const tempKit = join(repoCopy, 'kit', 'skills')
      mkdirSync(join(tempKit, 'dev-sixth', 'scripts'), { recursive: true })
      writeFileSync(
        join(tempKit, 'dev-sixth', 'SKILL.md'),
        minimalSkillMd('dev-sixth', '第六个动态扩展内置技能', [
          'tier: both',
          'intent: 第六扩展意图',
          'script: node .agents/skills/dev-sixth/scripts/sixth.mjs',
          'order: 60',
        ]),
      )
      writeFileSync(join(tempKit, 'dev-sixth', 'scripts', 'sixth.mjs'), 'export const ok = true\n')

      const allNames = getKitSkills(tempKit)
      if (!allNames.includes('dev-sixth')) {
        return `getKitSkills 未动态识别 dev-sixth：all=${allNames.join(',')}`
      }

      // 统一 equip 自动装配 dev-sixth
      const targetFull = tmpProject({ 'package.json': '{"name":"c1-full"}\n' })
      try {
        await gitInit(targetFull)
        const resFull = equip(targetFull, { kitDir: tempKit, noBackup: true })
        if (!resFull.added.includes('dev-sixth/SKILL.md') || !existsSync(join(targetFull, '.agents/skills/dev-sixth/scripts/sixth.mjs'))) {
          return `equip 未安装 dev-sixth：${JSON.stringify(resFull.added)}`
        }

        // compose-agents {{KIT_ROUTING_ROWS}} 与 preflight checkKitSuite 零改源码通过
        const fullSurvey = await survey(targetFull)
        const renderedFull = renderAgentsTemplate(fullSurvey, tplText, targetFull, { kitDir: tempKit })
        if (!renderedFull.includes('第六扩展意图') || !renderedFull.includes('.agents/skills/dev-sixth/SKILL.md')) {
          return 'compose-agents {{KIT_ROUTING_ROWS}} 未渲染 dev-sixth 路由行'
        }
        const noRemoteRows = renderKitRoutingRows({
          hasRemote: false,
          discoveredSkills: discoverKitSkills(tempKit),
        })
        if (/\bPR\b|\borigin\b|\bpush\b/i.test(noRemoteRows) || !noRemoteRows.includes('第六扩展意图')) {
          return `no-remote 动态路由行泄露 PR/origin/push 或漏掉第 6 技能：${noRemoteRows}`
        }

        // checkKitSuite 对含合法第 6 技能的套件副本通过
        equip(repoCopy, { kitDir: tempKit, noBackup: true })
        const suitePass = makeSuiteCtx(repoCopy)
        checkKitSuite(suitePass.ctx, new Map())
        if (suitePass.errors.length > 0) {
          return `checkKitSuite 对合规范第 6 技能意外报错：${suitePass.errors.join('；')}`
        }
      } finally {
        rmTree(targetFull)
      }
      return true
    } finally {
      rmTree(scratch)
    }
  }])

  // C1 反向：残缺或越界 metadata 应产出诊断，并被 checkKitSuite 拦截
  cases.push(['StageB C1 反向：缺失/非法 metadata 跳过并被 checkKitSuite 拦截，非 dev-* 目录不混入', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'pf-c1-neg-'))
    try {
      const repoCopy = join(scratch, 'forge-bad')
      mkdirSync(join(repoCopy, 'kit', 'skills'), { recursive: true })
      writeFileSync(join(repoCopy, 'SKILL.md'), '---\nname: project-forge\ndescription: tmp\n---\n')
      cpSync(join(SKILL_ROOT, 'kit', 'skills'), join(repoCopy, 'kit', 'skills'), { recursive: true })

      // 添加合法之外的非 dev-* 目录名与非法 order 的 dev-bad
      const tempKit = join(repoCopy, 'kit', 'skills')
      mkdirSync(join(tempKit, 'notes-only'), { recursive: true })
      mkdirSync(join(tempKit, 'dev-bad'), { recursive: true })
      writeFileSync(join(tempKit, 'dev-bad', 'SKILL.md'), minimalSkillMd('dev-bad', '坏序号技能', ['order: not-a-number']))

      const { skills, diagnostics } = discoverKitSkillsDetailed(tempKit)
      if (skills.some((s) => s.dirName === 'dev-bad' || s.dirName === 'notes-only')) {
        return `非法或无 SKILL.md 目录不应进入发现列表：${skills.map((s) => s.dirName).join(',')}`
      }
      if (!diagnostics.some((d) => d.dirName === 'dev-bad')) {
        return `非法 metadata.order 未产生诊断：${JSON.stringify(diagnostics)}`
      }

      equip(repoCopy, { kitDir: tempKit, noBackup: true })
      const suiteFail = makeSuiteCtx(repoCopy)
      checkKitSuite(suiteFail.ctx, new Map())
      if (!suiteFail.errors.some((e) => e.includes('dev-bad'))) {
        return `checkKitSuite 未拦截无效元数据 dev-bad：${JSON.stringify(suiteFail.errors)}`
      }

      // 超 180 行上限的 SKILL.md 也必须被 checkKitSuite 拦下
      rmTree(join(tempKit, 'dev-bad'))
      mkdirSync(join(tempKit, 'dev-long'), { recursive: true })
      const filler = Array.from({ length: 185 }, (_, i) => `line-${i + 1}`).join('\n')
      writeFileSync(join(tempKit, 'dev-long', 'SKILL.md'), `${minimalSkillMd('dev-long', '超长技能', ['order: 90'])}\n${filler}\n`)
      equip(repoCopy, { kitDir: tempKit, noBackup: true })
      const suiteLong = makeSuiteCtx(repoCopy)
      checkKitSuite(suiteLong.ctx, new Map())
      if (!suiteLong.errors.some((e) => e.includes('dev-long') && e.includes('180'))) {
        return `checkKitSuite 未拦截超 180 行 SKILL.md：${JSON.stringify(suiteLong.errors)}`
      }
      return true
    } finally {
      rmTree(scratch)
    }
  }])

  // C2 正向：隐藏/非隐藏/同名自有技能全量扫描入 AGENTS.md 并在 S1-S4 升级后无损保留，零宿主/业务名硬编码
  cases.push(['StageB C2 正向：隐藏/非隐藏/同名自有技能全量进 AGENTS.md 并在 S1-S4 升级后无损保留', async () => {
    // 套件源码、技能发现与装配/契约脚本禁止硬编码 AI 宿主目录名；所有 kit/ 与非 dev scripts/ 禁止硬编码业务技能名
    const hostDirsRe = /\.(?:claude|cursor|windsurf|codex|trae|copilot|cline|roo)\b/i
    const bizSkillRe = /\b(?:video-subtitle|video-info|video-search|oil-tone|image-hunter)\b/
    const hostCheckFiles = [
      ...walkFiles(join(SKILL_ROOT, 'kit'), (f) => /\.(?:mjs|md)$/i.test(f)),
      ...[
        'scripts/equip.mjs',
        'scripts/compose-agents.mjs',
        'scripts/handoff.mjs',
        'scripts/survey.mjs',
        'scripts/lib/protocol.mjs',
        'scripts/lib/agents-defaults.mjs',
        'scripts/lib/agents-sections.mjs',
        'scripts/lib/survey-reentry.mjs',
        'scripts/lib/equip-bootstrap.mjs',
      ].map((p) => join(SKILL_ROOT, p)),
    ]
    for (const file of hostCheckFiles) {
      const content = readFileSync(file, 'utf8')
      const relPath = relative(SKILL_ROOT, file).replace(/\\/g, '/')
      const hostHit = hostDirsRe.exec(content)
      if (hostHit) return `${relPath} 硬编码了 AI 宿主目录「${hostHit[0]}」`
    }
    const productFiles = [
      ...walkFiles(join(SKILL_ROOT, 'kit'), (f) => /\.(?:mjs|md)$/i.test(f)),
      ...walkFiles(join(SKILL_ROOT, 'scripts'), (f) => /\.(?:mjs|md)$/i.test(f) && !f.replace(/\\/g, '/').includes('/scripts/dev/')),
    ]
    for (const file of productFiles) {
      const content = readFileSync(file, 'utf8')
      const relPath = relative(SKILL_ROOT, file).replace(/\\/g, '/')
      const bizHit = bizSkillRe.exec(content)
      if (bizHit) return `${relPath} 硬编码了业务技能名「${bizHit[0]}」`
    }

    const customSpecs = [
      { rel: 'skills/team-lint/SKILL.md', name: 'team-lint', desc: '团队代码规范检查与格式化统一约定，涵盖全栈多包。' },
      { rel: '.acme-ide/skills/api-helper/SKILL.md', name: 'api-helper', desc: '本地接口契约与 OpenAPI 对齐辅助工具。' },
      { rel: 'skills/dev-flow/SKILL.md', name: 'dev-flow', desc: '项目自留的同名发布钩子流程说明，不可被内置套件覆盖。' },
      { rel: '.agents/skills/team-untracked/SKILL.md', name: 'team-untracked', desc: '直接在共享目录创建的项目级自定义技能。' },
    ]
    const initialFiles = { 'package.json': '{"name":"c2-custom-demo","version":"1.0.0"}\n' }
    for (const item of customSpecs) {
      initialFiles[item.rel] = minimalSkillMd(item.name, item.desc)
    }

    const dir = tmpProject(initialFiles)
    try {
      await gitInit(dir)
      const facts1 = await survey(dir)
      const foundPaths = new Set((facts1.kit?.customSkills ?? []).map((s) => s.path))
      for (const item of customSpecs) {
        const skillDirRel = item.rel.replace(/\/SKILL\.md$/, '')
        if (!foundPaths.has(skillDirRel)) {
          return `survey kit.customSkills 漏扫自有技能 ${skillDirRel}：${JSON.stringify([...foundPaths])}`
        }
        const matched = facts1.kit.customSkills.find((s) => s.path === skillDirRel)
        if (matched?.name !== item.name || matched?.description !== item.desc) {
          return `自有技能 ${skillDirRel} 提取 name/description 不完整：${JSON.stringify(matched)}`
        }
      }

      // 执行 S1-S4（equip + compose-agents）并验证只读、全量写入 AGENTS.md、重复幂等保留
      const snapshotsBefore = Object.fromEntries(customSpecs.map((s) => [s.rel, readFileSync(join(dir, s.rel), 'utf8')]))
      const eq = await runNode('equip.mjs', [dir, '--no-backup'])
      if (eq.status !== 0) return `C2 equip 失败：${eq.stderr}`
      const comp = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (comp.status !== 0) return `C2 compose-agents 失败：${comp.stderr}`

      const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      const agentsBytes = Buffer.byteLength(agentsText, 'utf8')
      if (agentsBytes > 30720) return `C2 AGENTS.md 超过 30720B：${agentsBytes}`
      for (const item of customSpecs) {
        const after = readFileSync(join(dir, item.rel), 'utf8')
        if (after !== snapshotsBefore[item.rel]) return `自有技能文件被改写：${item.rel}`
        if (!agentsText.includes(item.desc) || !agentsText.includes(item.name)) {
          return `AGENTS.md 意图路由未保留完整 name/description（${item.rel}）`
        }
      }

      // 升级重跑仍保留所有自有技能且 --check 为 0
      const eqAgain = await runNode('equip.mjs', [dir, '--no-backup'])
      const eqChk = await runNode('equip.mjs', [dir, '--check'])
      if (eqAgain.status !== 0 || eqChk.status !== 0) {
        return `C2 重跑或 --check 失败：${eqChk.stdout || eqChk.stderr}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  // C2 反向：忽略 .git/.worktrees/.github 内目录，跳过坏 frontmatter 且不重复收录已托管内置技能
  cases.push(['StageB C2 反向：忽略仓库内部隐藏目录，跳过坏 frontmatter 并过滤已托管内置技能', async () => {
    const dir = tmpProject({
      'package.json': '{"name":"c2-neg"}\n',
      '.worktrees/tmp-task/skills/ignored-wt/SKILL.md': minimalSkillMd('ignored-wt', '工作树内应被忽略'),
      '.github/skills/ignored-gh/SKILL.md': minimalSkillMd('ignored-gh', 'GitHub 目录应被忽略'),
      'skills/broken-custom/SKILL.md': '# broken without frontmatter\n',
      'skills/valid-custom/SKILL.md': minimalSkillMd('valid-custom', '唯一应识别的合法自有技能'),
    })
    try {
      await gitInit(dir)
      const eq = await runNode('equip.mjs', [dir, '--no-backup'])
      if (eq.status !== 0) return `equip 失败：${eq.stderr}`

      const facts = await survey(dir)
      const custom = facts.kit?.customSkills ?? []
      if (custom.some((s) => s.name === 'ignored-wt' || s.name === 'ignored-gh' || s.dirName === 'broken-custom')) {
        return `不应收录内部目录或坏 frontmatter 技能：${JSON.stringify(custom)}`
      }
      if (custom.filter((s) => s.name === 'valid-custom').length !== 1) {
        return `合法自有技能未被唯一识别：${JSON.stringify(custom)}`
      }
      if (custom.some((s) => s.path?.startsWith('.agents/skills/dev-'))) {
        return `已托管内置技能误入 customSkills：${JSON.stringify(custom)}`
      }
      // 直接验证 .git/skills 也被 discoverCustomSkills 忽略
      mkdirSync(join(dir, '.git', 'skills', 'ignored-git'), { recursive: true })
      writeFileSync(join(dir, '.git', 'skills', 'ignored-git', 'SKILL.md'), minimalSkillMd('ignored-git', '内部 git'))
      const directCustom = discoverCustomSkills(dir, new Set(getKitSkills()), facts.kit)
      if (directCustom.some((s) => s.name === 'ignored-git')) {
        return 'discoverCustomSkills 未排除 .git 内部目录'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  // C3 正向：旧标准化仓缺失新版内置技能（非墓碑）自动标记 upgrade 并无损补齐，保留墓碑/定制/自有技能
  cases.push(['StageB C3 正向：旧仓缺新版内置技能识别 upgrade 并无损补装，保留墓碑/定制/自有技能', async () => {
    const dir = tmpProject({
      'package.json': '{"name":"c3-upgrade","version":"1.0.0"}\n',
      'skills/team-ops/SKILL.md': minimalSkillMd('team-ops', '自有运维检查技能，升级必须无损保留。'),
    })
    const customKitScratch = mkdtempSync(join(tmpdir(), 'pf-c3-kit-'))
    try {
      await gitInit(dir)
      // 1. 统一完整装配初始化已标准化旧仓（生成 AGENTS.md 并完结人类待填节），再登记定制文件 + 墓碑文件
      const initEq = await runNode('equip.mjs', [dir, '--no-backup'])
      if (initEq.status !== 0) return `C3 初始化失败：${initEq.stderr}`
      const initComp = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (initComp.status !== 0) return `C3 初始 compose-agents 失败：${initComp.stderr}`
      const agentsPath = join(dir, 'AGENTS.md')
      let stdAgents = readFileSync(agentsPath, 'utf8')
      for (const sec of ['项目定位', 'Dev Profile', '架构与关键不变量', '修改守则补充', '高风险路径', '改哪看哪']) {
        stdAgents = stdAgents.replace(`<!-- project-forge: begin ${sec} -->`, `<!-- project-forge: begin ${sec} customized -->`)
      }
      stdAgents = stdAgents
        .replace(/^[ \t]*<!--\s*project-forge:\s*fill\b[^>]*-->[ \t]*\r?\n?/gm, '')
        .replace(/^((?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit):\s*)<[^>\n]+>/gm, '$1none')
      writeFileSync(agentsPath, stdAgents)

      const expSkill = join(dir, '.agents/skills/dev-explore/SKILL.md')
      const origExp = readFileSync(expSkill, 'utf8')
      writeFileSync(expSkill, `${origExp}\n<!-- custom explore note -->\n`)
      const adoptRes = await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-explore/SKILL.md', '--no-backup'])
      if (adoptRes.status !== 0) return `--adopt-custom 失败：${adoptRes.stderr}`

      // 构造删除墓碑与定制豁免，再移除 dev-govern 模拟旧仓升级前状态
      const manifestPath = join(dir, '.agents', 'skills', '.pf-manifest.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      manifest.disabledSkills = ['legacy-retired-skill']
      manifest.removedFiles = { 'dev-flow/README-old.md': { at: '2026-01-01T00:00:00Z' } }
      for (const key of Object.keys(manifest.files)) {
        if (key.startsWith('dev-govern/')) delete manifest.files[key]
      }
      rmTree(join(dir, '.agents/skills/dev-govern'))
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

      // 运行真实 survey：应检测到 uninstalledKitSkills=['dev-govern'] 与 artifactPlan kit-skills action='upgrade'
      const oldFacts = await survey(dir)
      if (!(oldFacts.kit?.uninstalledKitSkills ?? []).includes('dev-govern')) {
        return `旧仓缺 dev-govern 未进入 uninstalledKitSkills：${JSON.stringify(oldFacts.kit)}`
      }
      const kitPlan = (oldFacts.artifactPlan ?? []).find((x) => x.id === 'kit-skills')
      if (kitPlan?.action !== 'upgrade') {
        return `artifactPlan kit-skills 应为 upgrade：${JSON.stringify(kitPlan)}`
      }

      // 执行 S1-S4 升级后恢复 dev-govern，保留定制/墓碑/自有技能，且 --check 退出 0
      const upEq = await runNode('equip.mjs', [dir, '--no-backup'])
      const upComp = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (upEq.status !== 0 || upComp.status !== 0) return `C3 升级失败：${upEq.stderr || upComp.stderr}`

      if (!existsSync(join(dir, '.agents/skills/dev-govern/SKILL.md'))) return '升级未补齐缺失内置技能 dev-govern'
      if (!readFileSync(expSkill, 'utf8').includes('<!-- custom explore note -->')) return '定制豁免 dev-explore/SKILL.md 内容丢失'
      if (!existsSync(join(dir, 'skills/team-ops/SKILL.md'))) return '自有技能 team-ops 丢失'

      const newManifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const hasRemoved = Array.isArray(newManifest.removedFiles)
        ? newManifest.removedFiles.includes('dev-flow/README-old.md')
        : Object.prototype.hasOwnProperty.call(newManifest.removedFiles ?? {}, 'dev-flow/README-old.md')
      const hasCustom = Array.isArray(newManifest.customizedFiles)
        ? newManifest.customizedFiles.includes('dev-explore/SKILL.md')
        : Object.prototype.hasOwnProperty.call(newManifest.customizedFiles ?? {}, 'dev-explore/SKILL.md')
      if (!(newManifest.disabledSkills ?? []).includes('legacy-retired-skill')) return 'disabledSkills 墓碑丢失'
      if (!hasRemoved) return 'removedFiles 墓碑丢失'
      if (!hasCustom) return 'customizedFiles 豁免丢失'

      const eqChk = await runNode('equip.mjs', [dir, '--check'])
      const cmpChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (eqChk.status !== 0 || cmpChk.status !== 0) {
        return `升级后 --check 非零：equip=${eqChk.status}(${eqChk.stderr || eqChk.stdout}) compose=${cmpChk.status}(${cmpChk.stderr || cmpChk.stdout})`
      }

      // 补充模拟上游 kit/skills 新增第 6 技能时 detectKit + computeArtifactPlan 也标 upgrade
      cpSync(join(SKILL_ROOT, 'kit', 'skills'), join(customKitScratch, 'skills'), { recursive: true })
      const nextKit = join(customKitScratch, 'skills')
      mkdirSync(join(nextKit, 'dev-sixth'), { recursive: true })
      writeFileSync(join(nextKit, 'dev-sixth', 'SKILL.md'), minimalSkillMd('dev-sixth', '新版第 6 技能', ['tier: both', 'order: 60']))
      const kNext = detectKit(dir, { kitDir: nextKit })
      const planNext = computeArtifactPlan({ kit: kNext })
      if (!(kNext.uninstalledKitSkills ?? []).includes('dev-sixth')) {
        return `新 kitDir 下 detectKit 未检出 dev-sixth：${JSON.stringify(kNext.uninstalledKitSkills)}`
      }
      if (planNext.find((x) => x.id === 'kit-skills')?.action !== 'upgrade') {
        return '新 kitDir 下 artifactPlan 未标为 upgrade'
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(customKitScratch)
    }
  }])

  // C3 反向：已墓碑禁用或 removedFiles 删除的技能不误判为待安装，干净装配状态保持 preserve
  cases.push(['StageB C3 反向：disabledSkills/removedFiles 墓碑不强行补齐，干净装配保持 preserve', async () => {
    const dir = tmpProject({ 'package.json': '{"name":"c3-neg"}\n' })
    const cleanDir = tmpProject({ 'package.json': '{"name":"c3-clean-neg"}\n' })
    try {
      await gitInit(dir)
      await gitInit(cleanDir)

      // 场景 1：用户主动删除 dev-govern（记录在 disabledSkills），survey 不得要求升级补回且 equip 保持删除
      const eq = await runNode('equip.mjs', [dir, '--no-backup'])
      if (eq.status !== 0) return `初始化失败：${eq.stderr}`
      rmTree(join(dir, '.agents/skills/dev-govern'))
      const eq2 = await runNode('equip.mjs', [dir, '--no-backup'])
      if (eq2.status !== 0) return `记录墓碑失败：${eq2.stderr}`

      const tombFacts = await survey(dir)
      if ((tombFacts.kit?.uninstalledKitSkills ?? []).includes('dev-govern')) {
        return `disabledSkills 中的 dev-govern 不应进入 uninstalledKitSkills：${JSON.stringify(tombFacts.kit)}`
      }
      // 测试 removedFiles 里登记 SKILL.md 时同样不触发 uninstalledKitSkills
      const mfPath = join(dir, '.agents/skills/.pf-manifest.json')
      const mf = JSON.parse(readFileSync(mfPath, 'utf8'))
      mf.disabledSkills = []
      mf.removedFiles = ['dev-govern/SKILL.md']
      writeFileSync(mfPath, `${JSON.stringify(mf, null, 2)}\n`)
      const rmFacts = await survey(dir)
      if ((rmFacts.kit?.uninstalledKitSkills ?? []).includes('dev-govern')) {
        return `removedFiles 含 dev-govern/SKILL.md 时不应进入 uninstalledKitSkills：${JSON.stringify(rmFacts.kit)}`
      }

      // 场景 2：完整装配干净状态下 artifactPlan 保持 preserve
      const eqClean = await runNode('equip.mjs', [cleanDir, '--no-backup'])
      if (eqClean.status !== 0) return `干净装配失败：${eqClean.stderr}`
      const cleanFacts = await survey(cleanDir)
      if ((cleanFacts.kit?.uninstalledKitSkills ?? []).length > 0) {
        return `干净装配不应误报技能缺失：${JSON.stringify(cleanFacts.kit.uninstalledKitSkills)}`
      }
      const cleanPlan = (cleanFacts.artifactPlan ?? []).find((x) => x.id === 'kit-skills')
      if (cleanPlan?.action !== 'preserve') {
        return `干净装配状态下 artifactPlan 应为 preserve：${JSON.stringify(cleanPlan)}`
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(cleanDir)
    }
  }])

  // C4 双向：branchProtection 三端对齐、开关 A 禁设审批>=1、403 降级、REST 重试与 redirect:'manual'、--protect-branch 非 GitHub 安全退出 0
  cases.push(['StageB C4 双向：branchProtection 能力位、开关 A 载荷防线、403 降级、429/5xx/TLS 重试与 equip-ci 退出 0', async () => {
    const kitGh = getKitHostingProvider('github')
    const engGh = getEngineHostingProvider('github')
    if (ENGINE_GENERIC_GIT_PROVIDER.capabilities.branchProtection !== false || GENERIC_GIT_PROVIDER.capabilities.branchProtection !== false
      || GITHUB_PROVIDER.capabilities.branchProtection !== true || engGh?.capabilities?.branchProtection !== true || kitGh?.capabilities?.branchProtection !== true) {
      return 'branchProtection 能力位三端对齐失败'
    }
    if (summarizeRemoteCapabilities(null, {}).branchProtection !== null || summarizeRemoteCapabilities(null, { providerId: 'none' }).branchProtection !== false) {
      return 'summarizeRemoteCapabilities 三态 branchProtection 不符预期'
    }

    // 正反校验 Switch A 载荷与禁 required_approving_review_count >= 1
    const switchAPayload = buildSwitchABranchProtectionPayload({ requiredChecks: ['check'] })
    if (switchAPayload.required_pull_request_reviews?.required_approving_review_count !== 0
      || switchAPayload.enforce_admins !== true || switchAPayload.allow_force_pushes !== false
      || switchAPayload.allow_deletions !== false || !switchAPayload.required_status_checks?.contexts.includes('check')) {
      return `开关 A 载荷结构异常：${JSON.stringify(switchAPayload)}`
    }
    let rejectedApprove = false
    try { buildSwitchABranchProtectionPayload({ requiredApprovingReviewCount: 1 }) } catch { rejectedApprove = true }
    if (!rejectedApprove) return 'buildSwitchABranchProtectionPayload 未拦截 required_approving_review_count >= 1'

    // REST 429/5xx/TLS 超时指数退避重试 + 非重试状态 + redirect:'manual'
    const sleeps = []
    let retryAttempt = 0
    const seenRedirects = []
    const retryClient = createGitHubClient({
      channel: 'node-https-token',
      env: { GH_TOKEN: 'tok-test' },
      maxRetries: 2,
      retryBaseDelayMs: 1,
      sleep: async (ms) => { sleeps.push(ms) },
      httpRequest: async (req) => {
        seenRedirects.push(req.redirect)
        retryAttempt += 1
        if (retryAttempt === 1) return { status: 429, data: { message: 'rate limit' } }
        if (retryAttempt === 2) {
          const tlsErr = new Error('TLS handshake timeout')
          tlsErr.code = 'ETIMEDOUT'
          throw tlsErr
        }
        if (req.method === 'PUT') return { status: 200, data: { url: 'ok', required_pull_request_reviews: { required_approving_review_count: 0 } } }
        return { status: 200, data: { protected: true } }
      },
    })
    const okSwitchA = await retryClient.applyBranchProtectionSwitchA('acme/demo', 'main', { requiredChecks: ['check'] })
    if (!okSwitchA.ok || okSwitchA.payload?.required_pull_request_reviews?.required_approving_review_count !== 0
      || sleeps.join(',') !== '1,2' || seenRedirects.some((r) => r !== 'manual')) {
      return `REST 指数退避重试或 redirect:'manual' 异常：ok=${JSON.stringify(okSwitchA)}, sleeps=${sleeps}, redirects=${seenRedirects}`
    }

    let calls403 = 0
    const fallbackClient = createGitHubClient({
      channel: 'node-https-token',
      env: { GH_TOKEN: 'tok-test' },
      maxRetries: 2,
      retryBaseDelayMs: 1,
      httpRequest: async () => { calls403 += 1; return { status: 403, data: { message: 'Upgrade to GitHub Pro' } } },
    })
    const fb403 = await fallbackClient.applyBranchProtectionSwitchA('acme/demo', 'main', { requiredChecks: ['check'] })
    if (fb403.ok !== false || fb403.fallbackToHooks !== true || fb403.status !== 403 || !fb403.reason || calls403 !== 1) {
      return `HTTP 403 未降级或不重试失效：calls=${calls403}, res=${JSON.stringify(fb403)}`
    }
    const bp403 = await fallbackClient.getBranchProtection('acme/demo', 'main')
    if (bp403.ok !== false || bp403.fallbackToHooks !== true) return `getBranchProtection 403 未降级：${JSON.stringify(bp403)}`

    for (const noRetryStatus of [302, 400, 401, 403, 405, 409, 413]) {
      let count = 0
      const c = createGitHubClient({
        channel: 'node-https-token',
        env: { GH_TOKEN: 'tok-test' },
        maxRetries: 2,
        retryBaseDelayMs: 1,
        httpRequest: async (req) => { count += 1; if (req.redirect !== 'manual') throw new Error('missing redirect:manual'); return { status: noRetryStatus, data: { message: `HTTP ${noRetryStatus}` } } },
      })
      let threw = false
      try { await c.rest('GET', '/repos/acme/demo') } catch (e) { threw = e.status === noRetryStatus }
      if (!threw || count !== 1) return `状态码 ${noRetryStatus} 不应重试（count=${count}, threw=${threw}）`
    }

    const dirGen = tmpProject({ 'index.js': '1\n' })
    const dirGh = tmpProject({ '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  gate-job:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n' })
    try {
      gitInit(dirGen, { origin: 'https://git.internal.corp/team/demo.git' })
      gitInit(dirGh, { origin: 'https://github.com/acme/demo.git' })
      const fGen = await survey(dirGen)
      const fGh = await survey(dirGh)
      if (fGen.git.capabilities?.branchProtection !== false || fGh.git.capabilities?.branchProtection !== true) {
        return `survey capabilities.branchProtection 异常：gen=${fGen.git.capabilities?.branchProtection}, gh=${fGh.git.capabilities?.branchProtection}`
      }
      const cliGen = await runNode('equip-ci.mjs', [dirGen, '--protect-branch', '--json'])
      if (cliGen.status !== 0) return `非 GitHub --protect-branch 应安全退出 0，实际 ${cliGen.status}：${cliGen.stderr}`
      const genJson = JSON.parse(cliGen.stdout)
      if (genJson.status !== 'SKIPPED_UNSUPPORTED' || FORBIDDEN_PLATFORM_RE.test(cliGen.stdout)) {
        return `非 GitHub --protect-branch 输出违例：${cliGen.stdout}`
      }
      const dryGh = await protectBranch(dirGh, { dryRun: true })
      if (!dryGh.ok || dryGh.status !== 'DRY_RUN' || dryGh.payload?.required_pull_request_reviews?.required_approving_review_count !== 0
        || !dryGh.payload?.required_status_checks?.contexts.includes('gate-job')) {
        return `GitHub --protect-branch --dry-run 异常：${JSON.stringify(dryGh)}`
      }
      return true
    } finally { rmTree(dirGen); rmTree(dirGh) }
  }])

  // C5 双向：q.branch-protection、取舍防重问、SSH/HTTP(S) 通用远端向导（过 checkPlatformLock）与 --bootstrap-empty
  cases.push(['StageB C5 双向：q.branch-protection/取舍防重问、SSH/HTTP(S) 通用向导与 --bootstrap-empty', async () => {
    const dirGh = tmpProject({ 'package.json': '{"name":"c5-gh","private":true}\n' })
    const dirGen = tmpProject({ 'package.json': '{"name":"c5-gen","private":true}\n' })
    const dirBoot = mkdtempSync(join(tmpdir(), 'pf-c5-boot-'))
    try {
      gitInit(dirGh, { origin: 'https://github.com/acme/c5.git' })
      gitInit(dirGen, { origin: 'https://git.internal.corp/team/c5.git' })

      const fGh = await survey(dirGh)
      const qGh = fGh.questions.find((q) => q.id === 'q.branch-protection')
      const mdGh = toMarkdown(fGh)
      if (!qGh || !qGh.text.includes('equip-ci.mjs') || !qGh.text.includes('--protect-branch') || !mdGh.includes('--protect-branch')) {
        return `GitHub 仓缺少 q.branch-protection 或 equip-ci 指引：${JSON.stringify(fGh.questions)}`
      }

      const fGen = await survey(dirGen)
      const qGen = fGen.questions.find((q) => q.id === 'q.branch-protection')
      const mdGen = toMarkdown(fGen)
      if (!qGen || FORBIDDEN_PLATFORM_RE.test(qGen.text) || FORBIDDEN_PLATFORM_RE.test(mdGen) || !mdGen.includes('--with-hooks')) {
        return `generic-git q.branch-protection/render 违反平台锁或缺少降级指引：${qGen?.text}`
      }

      writeFileSync(join(dirGh, 'AGENTS.md'), '# AGENTS\n\n## 取舍\n\n```text\n- `branch-protection`: 已启用开关 A\n```\n', 'utf8')
      writeFileSync(join(dirGen, 'AGENTS.md'), '# AGENTS\n\n## 取舍\n\n```text\n- `no-branch-protection`: 私有暂不开启\n```\n', 'utf8')
      const fGhDec = await survey(dirGh)
      const fGenDec = await survey(dirGen)
      if (fGhDec.questions.some((q) => q.id === 'q.branch-protection') || fGenDec.questions.some((q) => q.id === 'q.branch-protection')) {
        return 'AGENTS.md 取舍写入 branch-protection/no-branch-protection 后仍重复提问'
      }

      const bootRes = await runNode('equip.mjs', [dirBoot, '--bootstrap-empty', '--no-backup'])
      if (bootRes.status !== 0) return `--bootstrap-empty 失败：${bootRes.stderr}`
      const fBoot = await survey(dirBoot)
      const qRemote = fBoot.questions.find((q) => q.id === 'q.remote-setup')
      const mdBoot = toMarkdown(fBoot)
      if (!qRemote || !/SSH/.test(qRemote.text) || !/HTTP\(S\)/.test(qRemote.text) || FORBIDDEN_PLATFORM_RE.test(qRemote.text) || FORBIDDEN_PLATFORM_RE.test(mdBoot)) {
        return `q.remote-setup 或 render 未泛化 SSH/HTTP(S) 或违背平台锁：${qRemote?.text}`
      }
      if (!mdBoot.includes('SSH Ed25519') || !mdBoot.includes('HTTP(S) + PAT') || !mdBoot.includes('GitHub gh CLI') || !mdBoot.includes('--with-hooks')) {
        return `--bootstrap-empty 渲染缺少 SSH/HTTPS/GitHub 向导或 --with-hooks：\n${mdBoot}`
      }
      return true
    } finally { rmTree(dirGh); rmTree(dirGen); rmTree(dirBoot) }
  }])

  // C6 双向：S3 [NEXT STEP] --with-hooks 推荐与冲突 preserve、真实 bare 仓 pre-push 拦直推/放行删分支/PF_ALLOW_DIRECT_PUSH
  cases.push(['StageB C6 双向：S3 自动 --with-hooks、既有 Hook preserve 与真实 bare 仓 git push 拦截/删分支放行', async () => {
    const bareDir = mkdtempSync(join(tmpdir(), 'pf-c6-bare-'))
    const workDir = tmpProject({ 'README.md': '# hook-test\n' })
    const huskyDir = tmpProject({ '.husky/pre-push': '#!/bin/sh\necho husky\n' })
    const customHookDir = tmpProject({ '.githooks/pre-push': '#!/bin/sh\n# custom\nexit 0\n' })
    const lefthookDir = tmpProject({ 'lefthook.yml': 'pre-push:\n  commands:\n    lint:\n      run: echo ok\n' })
    const noHookDir = tmpProject({ 'AGENTS.md': '# AGENTS\n\n## 取舍\n\n```text\n- `no-git-hooks`: 手动约束\n```\n' })
    try {
      gitInitBare(bareDir)
      gitSync(undefined, ['--git-dir', bareDir, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
      gitInit(workDir, { branch: 'main', origin: bareDir.replace(/\\/g, '/'), name: 'Dev', email: 'dev@example.com' })
      gitInit(huskyDir)
      gitInit(customHookDir)
      gitInit(lefthookDir)
      gitInit(noHookDir)

      // 1) 无冲突自动推荐 --with-hooks；冲突或 no-git-hooks 不附带
      const fClean = await survey(workDir)
      const mdClean = toMarkdown(fClean)
      if (fClean.nextStep?.withHooks !== true || !mdClean.includes('[NEXT STEP]') || !mdClean.includes('--with-hooks')) {
        return `无冲突仓库 S3 [NEXT STEP] 未自动附带 --with-hooks：${JSON.stringify(fClean.nextStep)}`
      }
      const fNoHook = await survey(noHookDir)
      if (fNoHook.nextStep?.withHooks !== false || (fNoHook.nextStep?.command ?? '').includes('--with-hooks')) {
        return `no-git-hooks 仓库不应推荐 --with-hooks：${JSON.stringify(fNoHook.nextStep)}`
      }

      // 2) .husky / custom .githooks/pre-push / lefthook.yml / 自定义 core.hooksPath 一律 preserve
      const fHusky = await survey(huskyDir)
      if (!fHusky.git.hooks?.hasConflict || fHusky.nextStep?.withHooks !== false) return `.husky 冲突未识别：${JSON.stringify(fHusky.git.hooks)}`
      const eqHusky = await runNode('equip.mjs', [huskyDir, '--with-hooks', '--no-backup'])
      if (eqHusky.status !== 0 || JSON.parse(eqHusky.stdout).hooks?.action !== 'preserve' || existsSync(join(huskyDir, '.githooks/pre-push'))) {
        return `.husky 场景未 preserve：${eqHusky.stdout}`
      }
      const eqLefthook = await runNode('equip.mjs', [lefthookDir, '--with-hooks', '--no-backup'])
      if (eqLefthook.status !== 0 || JSON.parse(eqLefthook.stdout).hooks?.action !== 'preserve' || existsSync(join(lefthookDir, '.githooks/pre-push'))) {
        return `lefthook 场景未 preserve：${eqLefthook.stdout}`
      }
      const eqCustom = await runNode('equip.mjs', [customHookDir, '--with-hooks', '--no-backup'])
      if (eqCustom.status !== 0 || JSON.parse(eqCustom.stdout).hooks?.action !== 'preserve' || !readFileSync(join(customHookDir, '.githooks/pre-push'), 'utf8').includes('# custom')) {
        return `已有非 forge pre-push 被篡改：${eqCustom.stdout}`
      }
      gitSync(huskyDir, ['config', '--local', 'core.hooksPath', 'custom-hooks'])
      rmTree(join(huskyDir, '.husky'))
      const eqCustomPath = await runNode('equip.mjs', [huskyDir, '--with-hooks', '--no-backup'])
      if (JSON.parse(eqCustomPath.stdout).hooks?.action !== 'preserve' || gitSync(huskyDir, ['config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim() !== 'custom-hooks') {
        return `自定义 core.hooksPath 未 preserve：${eqCustomPath.stdout}`
      }

      // 3) 真实安装 --with-hooks + 真实 bare 仓 git push 测试
      const eqHook = await runNode('equip.mjs', [workDir, '--with-hooks', '--no-backup'])
      if (eqHook.status !== 0 || JSON.parse(eqHook.stdout).hooks?.action !== 'installed') return `equip --with-hooks 失败：${eqHook.stdout} ${eqHook.stderr}`
      const hookContent = readFileSync(join(workDir, '.githooks/pre-push'), 'utf8')
      if (/\r\n/.test(hookContent) || (process.platform !== 'win32' && (statSync(join(workDir, '.githooks/pre-push')).mode & 0o111) === 0)) {
        return '写入的 .githooks/pre-push 非 LF 或缺少可执行位'
      }
      if (gitSync(workDir, ['config', '--local', '--get', 'core.hooksPath'], { encoding: 'utf8' }).stdout.trim() !== '.githooks') {
        return '局部 core.hooksPath 未设为 .githooks'
      }

      const blockedPush = gitSync(workDir, ['push', 'origin', 'main'], { encoding: 'utf8' })
      const blockedMsg = `${blockedPush.stdout ?? ''}\n${blockedPush.stderr ?? ''}`
      if (blockedPush.status === 0 || !blockedMsg.includes('[NEXT STEP]') || !blockedMsg.includes('flow.mjs start')) {
        return `直推默认分支未被 .githooks/pre-push 拦截或缺少 [NEXT STEP]：code=${blockedPush.status}, out=${blockedMsg}`
      }
      const bypassPush = gitSync(workDir, ['push', 'origin', 'main'], { encoding: 'utf8', env: { ...process.env, PF_ALLOW_DIRECT_PUSH: '1' } })
      if (bypassPush.status !== 0) return `PF_ALLOW_DIRECT_PUSH=1 未放行：${bypassPush.stderr}`

      gitSync(workDir, ['checkout', '-b', 'feat/c6-ok'])
      writeFileSync(join(workDir, 'feat.txt'), 'ok\n')
      gitCommitFast(workDir, 'feat commit')
      if (gitSync(workDir, ['push', 'origin', 'feat/c6-ok'], { encoding: 'utf8' }).status !== 0) return '特性分支正常推送被误拦'
      const delPush = gitSync(workDir, ['push', 'origin', '--delete', 'feat/c6-ok'], { encoding: 'utf8' })
      if (delPush.status !== 0) return `删除远端分支（全零 local_sha）被 pre-push 误拦：${delPush.stderr}`
      return true
    } finally { rmTree(bareDir); rmTree(workDir); rmTree(huskyDir); rmTree(customHookDir); rmTree(lefthookDir); rmTree(noHookDir) }
  }])
}
