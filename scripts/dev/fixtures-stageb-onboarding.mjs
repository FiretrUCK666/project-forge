/**
 * fixtures-stageb-onboarding.mjs —— Stage B 接入与发现层双向行为夹具（C1–C3）。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

import {
  discoverCustomSkills,
  discoverKitSkills,
  discoverKitSkillsDetailed,
  parseSkillFrontmatter,
} from '../../kit/skills/lib/skill-discovery.mjs'
import { renderAgentsTemplate } from '../compose-agents.mjs'
import { checkEquip, equip } from '../equip.mjs'
import { renderKitRoutingRows } from '../lib/agents-defaults.mjs'
import { getKitSkills, getLightweightKitSkills } from '../lib/protocol.mjs'
import { detectKit } from '../lib/survey-reentry.mjs'
import { computeArtifactPlan } from '../survey.mjs'
import { gitInit, rmTree, runNode, SKILL_ROOT, survey, tmpProject } from './fixtures-helpers.mjs'
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
      if (!parsedDefault.valid || defDisc.diagnostics.length > 0 || defSkill?.tier !== 'both' || defSkill?.order !== 500 || defSkill?.script !== '') {
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
      const lightNames = getLightweightKitSkills(tempKit)
      if (!allNames.includes('dev-sixth') || !lightNames.includes('dev-sixth')) {
        return `getKitSkills/getLightweightKitSkills 未动态识别 dev-sixth：all=${allNames.join(',')} light=${lightNames.join(',')}`
      }

      // equip full & lightweight 均自动装配 dev-sixth
      const targetFull = tmpProject({ 'package.json': '{"name":"c1-full"}\n' })
      const targetLight = tmpProject({ 'package.json': '{"name":"c1-light"}\n' })
      try {
        await gitInit(targetFull)
        await gitInit(targetLight)
        const resFull = equip(targetFull, { kitDir: tempKit, tier: 'full', noBackup: true })
        const resLight = equip(targetLight, { kitDir: tempKit, tier: 'lightweight', noBackup: true })
        if (!resFull.added.includes('dev-sixth/SKILL.md') || !existsSync(join(targetFull, '.agents/skills/dev-sixth/scripts/sixth.mjs'))) {
          return `equip full 未安装 dev-sixth：${JSON.stringify(resFull.added)}`
        }
        if (!resLight.added.includes('dev-sixth/SKILL.md')) {
          return `equip lightweight 未安装 tier=both 的 dev-sixth：${JSON.stringify(resLight.added)}`
        }

        // compose-agents {{KIT_ROUTING_ROWS}} 与 preflight checkKitSuite 零改源码通过
        const fullSurvey = await survey(targetFull)
        const renderedFull = renderAgentsTemplate(fullSurvey, tplText, targetFull, { tier: 'full', kitDir: tempKit })
        if (!renderedFull.includes('第六扩展意图') || !renderedFull.includes('.agents/skills/dev-sixth/SKILL.md')) {
          return 'compose-agents {{KIT_ROUTING_ROWS}} 未渲染 dev-sixth 路由行'
        }
        const noRemoteRows = renderKitRoutingRows({
          tier: 'full',
          hasRemote: false,
          discoveredSkills: discoverKitSkills(tempKit),
        })
        if (/\bPR\b|\borigin\b|\bpush\b/i.test(noRemoteRows) || !noRemoteRows.includes('第六扩展意图')) {
          return `no-remote 动态路由行泄露 PR/origin/push 或漏掉第 6 技能：${noRemoteRows}`
        }

        // full-only 第 6 技能在 lightweight 下被过滤
        writeFileSync(
          join(tempKit, 'dev-sixth', 'SKILL.md'),
          minimalSkillMd('dev-sixth', '仅完整版扩展技能', [
            'tier: full',
            'intent: 仅完整版第六意图',
            'script: node .agents/skills/dev-sixth/scripts/sixth.mjs',
            'order: 60',
          ]),
        )
        const lightRows = renderKitRoutingRows({
          tier: 'lightweight',
          hasRemote: true,
          discoveredSkills: discoverKitSkills(tempKit),
        })
        if (lightRows.includes('dev-sixth') || lightRows.includes('仅完整版第六意图')) {
          return `lightweight 模式不应渲染 tier=full 的 dev-sixth：${lightRows}`
        }

        // checkKitSuite 对含合法第 6 技能的套件副本通过
        equip(repoCopy, { kitDir: tempKit, tier: 'full', noBackup: true })
        const suitePass = makeSuiteCtx(repoCopy)
        checkKitSuite(suitePass.ctx, new Map())
        if (suitePass.errors.length > 0) {
          return `checkKitSuite 对合规范第 6 技能意外报错：${suitePass.errors.join('；')}`
        }
      } finally {
        rmTree(targetFull)
        rmTree(targetLight)
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

      // 添加合法第 5 之外的非 dev-* 目录名与非法 tier 的 dev-bad
      const tempKit = join(repoCopy, 'kit', 'skills')
      mkdirSync(join(tempKit, 'notes-only'), { recursive: true })
      mkdirSync(join(tempKit, 'dev-bad'), { recursive: true })
      writeFileSync(join(tempKit, 'dev-bad', 'SKILL.md'), minimalSkillMd('dev-bad', '坏档位技能', ['tier: platinum']))

      const { skills, diagnostics } = discoverKitSkillsDetailed(tempKit)
      if (skills.some((s) => s.dirName === 'dev-bad' || s.dirName === 'notes-only')) {
        return `非法或无 SKILL.md 目录不应进入发现列表：${skills.map((s) => s.dirName).join(',')}`
      }
      if (!diagnostics.some((d) => d.dirName === 'dev-bad')) {
        return `非法 metadata.tier 未产生诊断：${JSON.stringify(diagnostics)}`
      }

      equip(repoCopy, { kitDir: tempKit, tier: 'full', noBackup: true })
      const suiteFail = makeSuiteCtx(repoCopy)
      checkKitSuite(suiteFail.ctx, new Map())
      if (!suiteFail.errors.some((e) => e.includes('dev-bad'))) {
        return `checkKitSuite 未拦截无效元数据 dev-bad：${JSON.stringify(suiteFail.errors)}`
      }

      // 超 180 行上限的 SKILL.md 也必须被 checkKitSuite 拦下
      rmTree(join(tempKit, 'dev-bad'))
      mkdirSync(join(tempKit, 'dev-long'), { recursive: true })
      const filler = Array.from({ length: 185 }, (_, i) => `line-${i + 1}`).join('\n')
      writeFileSync(join(tempKit, 'dev-long', 'SKILL.md'), `${minimalSkillMd('dev-long', '超长技能', ['tier: full'])}\n${filler}\n`)
      equip(repoCopy, { kitDir: tempKit, tier: 'full', noBackup: true })
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
      const eq = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
      if (eq.status !== 0) return `C2 equip 失败：${eq.stderr}`
      const comp = await runNode('compose-agents.mjs', [dir, '--tier', 'full', '--no-backup'])
      if (comp.status !== 0) return `C2 compose-agents 失败：${comp.stderr}`

      const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      const agentsBytes = Buffer.byteLength(agentsText, 'utf8')
      if (agentsBytes > 30720) return `C2 full AGENTS.md 超过 30720B：${agentsBytes}`
      for (const item of customSpecs) {
        const after = readFileSync(join(dir, item.rel), 'utf8')
        if (after !== snapshotsBefore[item.rel]) return `自有技能文件被改写：${item.rel}`
        if (!agentsText.includes(item.desc) || !agentsText.includes(item.name)) {
          return `AGENTS.md 意图路由未保留完整 name/description（${item.rel}）`
        }
      }

      // 升级重跑仍保留所有自有技能且 --check 为 0
      const eqAgain = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
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
      const eq = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
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
      // 1. 以 full 档初始化已标准化旧仓（生成 AGENTS.md 并完结人类待填节），再登记定制文件 + 墓碑文件
      const initEq = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
      if (initEq.status !== 0) return `C3 初始化失败：${initEq.stderr}`
      const initComp = await runNode('compose-agents.mjs', [dir, '--tier', 'full', '--no-backup'])
      if (initComp.status !== 0) return `C3 初始 compose-agents 失败：${initComp.stderr}`
      const agentsPath = join(dir, 'AGENTS.md')
      let stdAgents = readFileSync(agentsPath, 'utf8')
      for (const sec of ['项目定位', 'Dev Profile', '架构与关键不变量', '修改守则补充', '高风险路径', '改哪看哪']) {
        stdAgents = stdAgents.replace(`<!-- project-forge: begin ${sec} -->`, `<!-- project-forge: begin ${sec} customized -->`)
      }
      stdAgents = stdAgents.replace(/^[ \t]*<!--\s*project-forge:\s*fill\b[^>]*-->[ \t]*\r?\n?/gm, '')
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

  // C3 反向：已墓碑禁用或 removedFiles 删除的技能不误判为待安装，lightweight 档缺失 full-only 技能保持 preserve
  cases.push(['StageB C3 反向：disabledSkills/removedFiles 墓碑不强行补齐，lightweight 档不提示 full 技能缺失', async () => {
    const dir = tmpProject({ 'package.json': '{"name":"c3-neg"}\n' })
    const lightDir = tmpProject({ 'package.json': '{"name":"c3-light-neg"}\n' })
    try {
      await gitInit(dir)
      await gitInit(lightDir)

      // 场景 1：full 档用户主动删除 dev-govern（记录在 disabledSkills），survey 不得要求升级补回且 equip 保持删除
      const eq = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
      if (eq.status !== 0) return `初始化失败：${eq.stderr}`
      rmTree(join(dir, '.agents/skills/dev-govern'))
      const eq2 = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
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

      // 场景 2：lightweight 档缺失 full-only 技能属正常裁剪，artifactPlan 保持 preserve
      const eqL = await runNode('equip.mjs', [lightDir, '--tier', 'lightweight', '--no-backup'])
      if (eqL.status !== 0) return `lightweight 装配失败：${eqL.stderr}`
      const lightFacts = await survey(lightDir)
      if ((lightFacts.kit?.uninstalledKitSkills ?? []).length > 0) {
        return `lightweight 不应误报 full 技能缺失：${JSON.stringify(lightFacts.kit.uninstalledKitSkills)}`
      }
      const lightPlan = (lightFacts.artifactPlan ?? []).find((x) => x.id === 'kit-skills')
      if (lightPlan?.action !== 'preserve') {
        return `lightweight 干净状态下 artifactPlan 应为 preserve：${JSON.stringify(lightPlan)}`
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(lightDir)
    }
  }])
}
