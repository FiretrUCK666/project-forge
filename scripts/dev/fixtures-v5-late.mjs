import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitInit, loadPreflight,
  readDirRefs, rmTree, runAbs, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'

export function registerV5LateCases(cases) {
cases.push(['survey.mjs + compose-agents.mjs Wave 3：自有技能共存路由、reentry 漂移校准、explorationStrategy 与纯本地非 GitHub 提示', async () => {
  const { toMarkdown } = await import('../lib/render.mjs')
  const { FORBIDDEN_PLATFORM_RE } = await import('../lib/protocol.mjs')
  const { equip } = await import('../equip.mjs')

  // 1. 自有扩展技能（.agents/skills + .claude/skills）自动进入 AGENTS.md 意图路由且与 --check / equip 共存
  const customDir = tmpProject({
    'package.json': JSON.stringify({ name: 'custom-sk', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# custom-sk\n\n自有扩展技能并存与重入测试项目。\n',
    'src/app.mjs': 'export const ok = 1\n',
    '.agents/skills/my-billing/SKILL.md': [
      '---',
      'name: my-billing',
      'description: Reconcile invoices and ledger entries cleanly. Ignore second sentence details.',
      '---',
      '# my-billing',
    ].join('\n'),
    '.claude/skills/deploy-guard/SKILL.md': [
      '---',
      'name: deploy-guard',
      'description: Pre-deploy verification checklist for production releases',
      '---',
      '# deploy-guard',
    ].join('\n'),
  })
  gitInit(customDir)

  // 2. 跨月重入漂移仓（AGENTS 失效路径+脚本、TDD 失效路径、未登记 src/new-module、非 GitHub 远端）
  const reentryDir = tmpProject({
    'package.json': JSON.stringify({ name: 'reentry-demo', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# reentry-demo\n\n跨月重入校准与非 GitHub 远端导航测试仓。\n',
    'src/existing.mjs': 'export const e = 1\n',
    'src/new-module/service.mjs': 'export const s = 2\n',
    'docs/TDD.md': [
      '# TDD',
      '',
      '现有模块 `src/existing.mjs`，已删源码 `src/deleted-tdd.mjs`。',
      '未来规划示例 `docs/future/plan.md` 与外链 `https://example.com/a.js` 不应误报。',
    ].join('\n'),
    'AGENTS.md': [
      '# reentry-demo',
      '',
      '## Dev Profile',
      '```yaml',
      'quick-test: npm test',
      'full-test: npm run removed-script',
      '```',
      '',
      '## 架构',
      '核心文件：`src/existing.mjs`、`src/old/deleted.mjs`。',
    ].join('\n'),
  })
  gitInit(reentryDir)
  spawnSync('git', ['remote', 'add', 'origin', 'https://code.example.org/org/reentry-demo.git'], { cwd: reentryDir, stdio: 'ignore' })

  // 3. 空目录与小型干净仓 vs 大仓（> 80 代码文件）explorationStrategy 分级
  const emptyDir = tmpProject({})
  const smallCleanDir = tmpProject({
    'package.json': JSON.stringify({ name: 'small-clean', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# small-clean\n\n小型干净单仓。\n',
    'src/only.mjs': 'export const a = 1\n',
  })
  gitInit(smallCleanDir)
  const largeFiles = { 'README.md': '# large-repo\n\n大仓多文件分片探索测试。\n', 'package.json': '{"name":"large-repo","version":"1.0.0"}\n' }
  for (let i = 0; i < 85; i += 1) largeFiles[`src/m${i}.mjs`] = `export const v${i} = ${i}\n`
  const largeDir = tmpProject(largeFiles)

  try {
    // 验证自有技能装配、渲染共存与卸载恢复
    equip(customDir, { noBackup: true })
    const gen1 = runAbs('scripts/compose-agents.mjs', [customDir, '--no-backup'])
    if (gen1.status !== 0) return `compose-agents customDir 失败：${gen1.stderr}`
    const filledCustom = readFileSync(join(customDir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(customDir, 'AGENTS.md'), filledCustom)

    const agentsCustom = readFileSync(join(customDir, 'AGENTS.md'), 'utf8')
    if (!agentsCustom.includes('### 项目自有技能（自动识别，与上方研发流并存）') || !agentsCustom.includes('.agents/skills/my-billing/SKILL.md') || !agentsCustom.includes('.claude/skills/deploy-guard/SKILL.md')) {
      return `AGENTS.md 未包含项目自有扩展技能路由块：\n${agentsCustom.slice(0, 1200)}`
    }
    const chkCustom = runAbs('scripts/compose-agents.mjs', [customDir, '--check'])
    if (chkCustom.status !== 0) return `含自有技能的 AGENTS.md --check 失败：${chkCustom.stderr}`

    const sCustom = await survey(customDir)
    if ((sCustom.kit?.customSkills?.length ?? 0) !== 2 || !sCustom.kit.customSkills.some((s) => s.name === 'my-billing' && s.summary)) {
      return `survey customSkills 识别不对：${JSON.stringify(sCustom.kit?.customSkills)}`
    }

    // 删掉自有技能 -> 重跑 compose-agents 后自有技能区块消失
    rmTree(join(customDir, '.agents/skills/my-billing'))
    rmTree(join(customDir, '.claude/skills/deploy-guard'))
    runAbs('scripts/compose-agents.mjs', [customDir, '--no-backup'])
    if (readFileSync(join(customDir, 'AGENTS.md'), 'utf8').includes('### 项目自有技能')) {
      return '移除自有技能后 AGENTS.md 未清理自有技能条件块'
    }

    // 验证重入漂移、docs.tdd-stale-paths 与非 GitHub 远端无禁词渲染
    const sRe = await survey(reentryDir)
    if (!sRe.reentry?.isReentry || !sRe.reentry?.drifted) return `重入仓未检出 drifted：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleAgentPaths.includes('src/old/deleted.mjs')) return `staleAgentPaths 漏检：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleAgentScripts.includes('removed-script')) return `staleAgentScripts 漏检：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleTddPaths.includes('src/deleted-tdd.mjs')) return `reentry.staleTddPaths 未检出失效 TDD 路径：${JSON.stringify(sRe.reentry)}`
    if (sRe.reentry.staleTddPaths.some((p) => p.includes('docs/future') || p.includes('example.com'))) {
      return `staleTddPaths 误报了未来路径或 URL：${JSON.stringify(sRe.reentry.staleTddPaths)}`
    }
    if (!sRe.reentry.unregisteredTopDirs.includes('src/new-module')) {
      return `unregisteredTopDirs 未检出新增顶层目录：${JSON.stringify(sRe.reentry.unregisteredTopDirs)}`
    }
    if (sRe.explorationStrategy?.tier !== 'parallel-subagents' || !sRe.explorationStrategy.shards.some((s) => s.id === 'conventions-and-skills')) {
      return `重入漂移仓未切换 parallel-subagents：${JSON.stringify(sRe.explorationStrategy)}`
    }

    const mdRe = toMarkdown(sRe)
    if (FORBIDDEN_PLATFORM_RE.test(mdRe)) return '非 GitHub 远端导航或 Markdown 渲染输出了受限平台词汇'
    if (!mdRe.includes('远端不在 GitHub 上') || !mdRe.includes('跨月重入失步校准')) {
      return `toMarkdown 缺少非 GitHub 声明或重入校准摘要：\n${mdRe}`
    }

    const revRe = runAbs('scripts/review.mjs', [reentryDir])
    if (revRe.status !== 0 && !revRe.stdout) return `review.mjs reentryDir 异常退出：${revRe.stderr}`
    const { reviewProject } = await import('../review.mjs')
    const revReObj = await reviewProject(reentryDir)
    if (!revReObj.missing.some((f) => f.id === 'docs.tdd-stale-paths')) {
      return `review.mjs 未产出 docs.tdd-stale-paths：${JSON.stringify(revReObj.missing)}`
    }

    // 验证 explorationStrategy 三档分级：empty -> none、small -> single-pass、>80 files -> parallel-subagents
    const [sEmpty, sSmall, sLarge] = await Promise.all([survey(emptyDir), survey(smallCleanDir), survey(largeDir)])
    if (sEmpty.explorationStrategy?.tier !== 'none') return `empty 目录探索策略错误：${JSON.stringify(sEmpty.explorationStrategy)}`
    if (sSmall.explorationStrategy?.tier !== 'single-pass') return `小型干净仓探索策略错误：${JSON.stringify(sSmall.explorationStrategy)}`
    if (sLarge.explorationStrategy?.tier !== 'parallel-subagents') return `大型仓未触发 parallel-subagents：${JSON.stringify(sLarge.explorationStrategy)}`

    return true
  } finally {
    rmTree(customDir)
    rmTree(reentryDir)
    rmTree(emptyDir)
    rmTree(smallCleanDir)
    rmTree(largeDir)
  }
}])

cases.push(['equip.mjs + survey.mjs Wave 4 (C19)：五语言空目录闭环、computeArtifactPlan 与 docs/todo 优先探测', async () => {
  const { toMarkdown } = await import('../lib/render.mjs')
  const { computeArtifactPlan } = await import('../survey.mjs')

  const langs = [
    { lang: 'node', name: 'demo-node', expected: ['package.json', 'src/index.mjs', 'test/smoke.test.mjs'], entry: 'src/index.mjs' },
    { lang: 'python', name: 'demo-py', expected: ['pyproject.toml', 'src/demo_py/__init__.py', 'tests/test_smoke.py'], entry: 'src/demo_py/__init__.py' },
    { lang: 'go', name: 'demo-go', expected: ['go.mod', 'hello.go', 'hello_test.go'], entry: 'hello.go' },
    { lang: 'rust', name: 'demo-rust', expected: ['Cargo.toml', 'src/lib.rs'], entry: 'src/lib.rs' },
    { lang: 'docs', name: 'demo-docs', expected: ['docs/guide.md'], entry: 'README.md' },
  ]
  const dirs = []
  try {
    for (const item of langs) {
      const dir = tmpProject({})
      dirs.push(dir)
      const res = runAbs('scripts/equip.mjs', [dir, '--bootstrap-empty', '--lang', item.lang, '--name', item.name, '--description', `Desc ${item.lang}`])
      if (res.status !== 0) return `bootstrap-empty(${item.lang}) 失败：${res.stderr}`
      for (const reqRel of ['.gitattributes', '.gitignore', 'README.md', 'docs/TDD.md', ...item.expected]) {
        if (!existsSync(join(dir, reqRel))) return `bootstrap-empty(${item.lang}) 缺文件：${reqRel}`
      }
      if (!readFileSync(join(dir, '.gitattributes'), 'utf8').includes('* text=auto eol=lf')) {
        return `bootstrap-empty(${item.lang}) .gitattributes 缺 eol=lf`
      }
      if (!readFileSync(join(dir, '.gitignore'), 'utf8').includes('.worktrees/')) {
        return `bootstrap-empty(${item.lang}) .gitignore 缺 .worktrees/`
      }
      const readme = readFileSync(join(dir, 'README.md'), 'utf8')
      if (readme.includes('project-forge: fill') || readme.includes('img.shields.io')) {
        return `bootstrap-empty(${item.lang}) README 含占位或假徽章`
      }
      const tdd = readFileSync(join(dir, 'docs/TDD.md'), 'utf8')
      if (tdd.includes('<待补充>') || !tdd.includes(item.entry) || !tdd.includes('arch-rules: none')) {
        return `bootstrap-empty(${item.lang}) docs/TDD.md 未填实：${tdd}`
      }
      if (item.lang === 'node') {
        const nt = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
        if (nt.status !== 0) return `bootstrap-empty(node) 单测未过：${nt.stderr || nt.stdout}`
      }
      if (item.lang === 'python') {
        const pyBin = ['python3', 'python'].find((b) => spawnSync(b, ['--version'], { stdio: 'ignore' }).status === 0)
        if (pyBin) {
          const pt = spawnSync(pyBin, ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
          if (pt.status !== 0) return `bootstrap-empty(python) unittest 未过：${pt.stderr || pt.stdout}`
        }
      }
      if (item.lang === 'node' || item.lang === 'python') {
        const sBoot = await survey(dir)
        if ((sBoot.reentry?.staleTddPaths?.length ?? 0) > 0) {
          return `bootstrap-empty(${item.lang}) TDD 存在失效路径：${JSON.stringify(sBoot.reentry.staleTddPaths)}`
        }
      }
    }

    // 反面与保护：已有 .agents 自有技能时允许起步且保留；已有 README.md 时拒绝执行且不覆盖
    const withCustomAgentDir = tmpProject({
      '.agents/skills/keep-me/SKILL.md': '---\nname: keep-me\ndescription: Custom keep skill.\n---\n# keep-me\n',
    })
    dirs.push(withCustomAgentDir)
    const keepRes = runAbs('scripts/equip.mjs', [withCustomAgentDir, '--bootstrap-empty', '--lang', 'node', '--name', 'keep-demo'])
    if (keepRes.status !== 0) return `含 .agents 自有技能的空目录拒绝起步：${keepRes.stderr}`
    if (!readFileSync(join(withCustomAgentDir, '.agents/skills/keep-me/SKILL.md'), 'utf8').includes('Custom keep skill.')) {
      return 'bootstrap-empty 破坏了既有自有技能文件'
    }

    const nonEmptyDir = tmpProject({ 'README.md': '# Custom Handcrafted README\n' })
    dirs.push(nonEmptyDir)
    const blockRes = runAbs('scripts/equip.mjs', [nonEmptyDir, '--bootstrap-empty', '--lang', 'node', '--name', 'block-demo'])
    if (blockRes.status === 0) return '非空目录存在 README.md 时未拒绝 --bootstrap-empty'
    if (readFileSync(join(nonEmptyDir, 'README.md'), 'utf8') !== '# Custom Handcrafted README\n') {
      return '被拒绝的 --bootstrap-empty 意外修改了既有 README.md'
    }

    // computeArtifactPlan 空白仓 vs 异构存量仓 + docs/todo 优先于 docs/work
    const blankDir = tmpProject({})
    dirs.push(blankDir)
    const sBlank = await survey(blankDir)
    const blankPlan = Object.fromEntries((sBlank.artifactPlan ?? []).map((x) => [x.id, x]))
    if (blankPlan['pre-backup']?.action !== 'skip' || blankPlan['docs-tdd']?.action !== 'skip' || blankPlan['agents-contract']?.action !== 'skip') {
      return `空白仓 artifactPlan 不符：${JSON.stringify(sBlank.artifactPlan)}`
    }

    const heteroDir = tmpProject({
      '.gitattributes': '* text=auto eol=lf\n',
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': '{"name":"hetero","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'src/index.mjs': 'export const ok = true\n',
      'README.md': '# Custom Legacy README\n',
      'CONTRIBUTING.md': '# Contributing\n',
      'LICENSE': 'Dual License (MIT OR Apache-2.0)\n',
      'docs/TDD.md': '# TDD\n\n入口 `src/index.mjs`。\n',
      'docs/todo/261114-item.md': '# Todo\n',
      '.agents/skills/custom-ops/SKILL.md': '---\nname: custom-ops\ndescription: Custom ops skill.\n---\n# custom-ops\n',
      '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs: {}\n',
    })
    dirs.push(heteroDir)
    gitInit(heteroDir)
    const sHetero = await survey(heteroDir)
    if (sHetero.conventions?.workDir !== 'docs/todo') {
      return `存在 docs/todo 时 workDir 未优先选用 docs/todo：${sHetero.conventions?.workDir}`
    }
    const planMap = Object.fromEntries((sHetero.artifactPlan ?? []).map((x) => [x.id, x]))
    if (planMap.readme?.action !== 'preserve') {
      return `computeArtifactPlan 未将已有 README 标为 preserve：${JSON.stringify(planMap.readme)}`
    }
    if (planMap['pre-backup']?.action !== 'snapshot' || planMap.contributing?.action !== 'preserve' || planMap.license?.action !== 'preserve') {
      return `异构存量仓 artifactPlan 关键动作错误：${JSON.stringify(sHetero.artifactPlan)}`
    }
    if (planMap['kit-skills']?.action !== 'equip' || !planMap['kit-skills'].detail.includes('custom-ops')) {
      return `kit-skills 处置计划未提示保留自有技能：${JSON.stringify(planMap['kit-skills'])}`
    }
    const purePlan = computeArtifactPlan(sHetero)
    if ((purePlan?.length ?? 0) < 10) return 'computeArtifactPlan 导出项数不足 10 项'
    const mdHetero = toMarkdown(sHetero)
    if (!mdHetero.includes('## 逐项处置计划') || !mdHetero.includes('preserve')) {
      return `render.mjs 未输出逐项处置计划表格：\n${mdHetero}`
    }

    const legacyWorkDir = tmpProject({ 'README.md': '# legacy\n', 'docs/work/01-task.md': '# Task\n' })
    dirs.push(legacyWorkDir)
    const sLegacy = await survey(legacyWorkDir)
    if (sLegacy.conventions?.workDir !== 'docs/work') {
      return `仅存在存量 docs/work 时未兼容保留：${sLegacy.conventions?.workDir}`
    }

    return true
  } finally {
    for (const d of dirs) rmTree(d)
  }
}])

cases.push(['templates/readme.md 与文档口径 Wave 4 (C20)：HTML 注释配对、零残留占位与 tier 对齐', async () => {
  const { residualConditionMarkers } = await import('../lib/template.mjs')
  for (const relPath of ['templates/readme.md', 'templates/releasing.md', 'templates/release-notes.md']) {
    const raw = readFileSync(join(SKILL_ROOT, relPath), 'utf8')
    const opens = (raw.match(/<!--/g) ?? []).length
    const closes = (raw.match(/-->/g) ?? []).length
    if (opens === 0 || opens !== closes) return `${relPath} HTML 注释未成对闭合（open=${opens}, close=${closes}）`
  }
  const readmeTpl = readFileSync(join(SKILL_ROOT, 'templates/readme.md'), 'utf8')
  const residual = residualConditionMarkers(readmeTpl)
  const vars = [...new Set([...readmeTpl.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]))]
  if (residual.length > 0 || vars.length > 0) {
    return `templates/readme.md 残留条件或未求值变量：${JSON.stringify({ residual, vars })}`
  }
  if (!readmeTpl.includes('存量仓库严禁重写覆盖')) return 'templates/readme.md 缺少存量防覆盖约束'

  const skillMd = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')
  const surveyMd = readFileSync(join(SKILL_ROOT, 'references/survey.md'), 'utf8')
  if (/\bexplorationStrategy\.mode\b/.test(skillMd) || /\bexplorationStrategy\.mode\b/.test(surveyMd)) {
    return 'SKILL.md 或 references/survey.md 仍残留过期字段 explorationStrategy.mode'
  }
  if (!skillMd.includes('explorationStrategy.tier') || !surveyMd.includes('explorationStrategy.tier')) {
    return 'SKILL.md 或 references/survey.md 缺少 explorationStrategy.tier'
  }
  return true
}])

cases.push(['assets/readme/*.svg 与打包边界 Wave 4 (C21)：SVG 安全结构与 isProductLayerPath 正反双向', async () => {
  const { isProductLayerPath } = await import('./preflight.mjs')
  const { FORBIDDEN_PLATFORM_RE } = await import('../lib/protocol.mjs')
  const EMOJI_RE = /\p{Extended_Pictographic}/u

  const expectedSvgs = [
    'assets/readme/hero.svg',
    'assets/readme/hero-en.svg',
    'assets/readme/workflow.svg',
    'assets/readme/workflow-en.svg',
    'assets/readme/architecture.svg',
    'assets/readme/architecture-en.svg',
  ]
  for (const relPath of expectedSvgs) {
    if (!existsSync(join(SKILL_ROOT, relPath))) return `缺少视觉 SVG 卡片：${relPath}`
    if (!isProductLayerPath(relPath)) return `isProductLayerPath 拒绝了 assets/readme 资产：${relPath}`
    const raw = readFileSync(join(SKILL_ROOT, relPath), 'utf8')
    if (!/<svg\b/i.test(raw) || !/<\/svg>/i.test(raw) || !/\bviewBox\s*=\s*["'][^"']+["']/i.test(raw) || !/<title\b/i.test(raw)) {
      return `SVG 结构或无障碍标签不完整：${relPath}`
    }
    if (/<script\b|<foreignObject\b|<image\b/i.test(raw)) return `SVG 含禁用元素：${relPath}`
    const stripped = raw.replace(/\bxmlns(?::[a-z0-9_-]+)?\s*=\s*["']http:\/\/www\.w3\.org\/[^"']*["']/gi, '')
    if (/https?:\/\//i.test(stripped)) return `SVG 含非标准外链 URL：${relPath}`
    if (EMOJI_RE.test(raw) || FORBIDDEN_PLATFORM_RE.test(raw)) return `SVG 含 Emoji 或禁用平台词：${relPath}`
  }

  for (const bad of ['assets/other/junk.bin', 'assets/readme/nested/a.svg', 'assets/readme/hero.png', 'docs/TDD.md']) {
    if (isProductLayerPath(bad)) return `isProductLayerPath 误放行了非法路径：${bad}`
  }
  return true
}])

cases.push(['govern-audit.mjs release-prep Wave 4 (C22)：多版本跳号采集、噪音过滤、unaccountedPublicFiles 与单提交冷启动', async () => {
  const multiDir = tmpProject({
    '.gitignore': 'node_modules/\n',
    'package.json': `${JSON.stringify({
      name: 'demo-cli',
      version: '1.0.0',
      bin: { demo: 'bin/cli.mjs' },
      engines: { node: '>=16' },
    }, null, 2)}\n`,
    'SKILL.md': '---\nname: demo-cli\nmetadata:\n  version: "1.0.0"\n---\n# demo-cli\n',
    'README.md': '# demo-cli\n',
    'bin/cli.mjs': 'export function runCli() { return 1 }\n',
    'src/core.mjs': 'export const core = 1\n',
    'test/core.test.mjs': 'export const t = 1\n',
  })
  gitInit(multiDir)
  const tagRes = spawnSync('git', ['tag', 'v1.0.0'], { cwd: multiDir, encoding: 'utf8' })
  if (tagRes.status !== 0) throw new Error(`git tag failed: ${tagRes.stderr}`)

  const commitIn = (dir, files, msg) => {
    for (const [r, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, r)), { recursive: true })
      writeFileSync(join(dir, r), c)
    }
    const opts = { cwd: dir, encoding: 'utf8' }
    const addRes = spawnSync('git', ['add', '-A'], opts)
    if (addRes.status !== 0) throw new Error(`git add failed: ${addRes.stderr}`)
    const cRes = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', msg], opts)
    if (cRes.status !== 0) throw new Error(`git commit failed (${msg}): ${cRes.stderr}`)
  }

  commitIn(multiDir, { 'src/core.mjs': 'export const core = 2\n' }, 'feat: C9 Wave 4 support streaming exports')
  commitIn(multiDir, {
    'package.json': `${JSON.stringify({
      name: 'demo-cli',
      version: '1.0.0',
      bin: { demo: 'bin/cli.mjs' },
      engines: { node: '>=18' },
    }, null, 2)}\n`,
  }, 'feat!: raise minimum Node version to 18')
  commitIn(multiDir, {
    'docs/specs/261114-stream.md': '# 流式导出规范\n\nStatus: implemented\n\n支持大文件流式导出输出。\n',
    'docs/archive/todo/261114-stream.md': '# 任务单：流式导出\n\n## 完成后的记录\n\n已完成流式导出并同步文档。\n',
  }, 'docs: record stream spec and archive todo')
  commitIn(multiDir, { 'test/core.test.mjs': 'export const t = 2\n' }, 'feat: add test assertions for streaming')
  commitIn(multiDir, { '.gitignore': 'node_modules/\ntmp/\n' }, 'chore: ignore tmp files')
  commitIn(multiDir, { 'bin/cli.mjs': 'export function runCli() { return 2 }\n' }, 'update')

  const changelogDir = tmpProject({
    'pyproject.toml': '[project]\nname = "py-app"\nversion = "0.2.0"\nrequires-python = ">=3.11"\n',
    'CHANGELOG.md': '# Changelog\n',
    'README.md': '# py-app\n',
  })
  gitInit(changelogDir)

  const nonGitDir = tmpProject({ 'README.md': '# plain\n' })

  try {
    const prepJsonRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', multiDir, '--version', '3.0.0', '--json'])
    if (prepJsonRes.status !== 0) return `release-prep 多标签跳版本失败：${prepJsonRes.stderr}`
    const parsed = JSON.parse(prepJsonRes.stdout)
    if (parsed.range?.from !== 'v1.0.0' || parsed.version?.targetTag !== 'v3.0.0') {
      return `release-prep 区间或跳版本解析错误：${JSON.stringify({ range: parsed.range, version: parsed.version })}`
    }
    if ((parsed.stats?.filteredInternalCount ?? 0) < 2) {
      return `release-prep 未过滤纯测试或配置噪音提交：${JSON.stringify(parsed.stats)}`
    }
    if (!parsed.userFacingCandidates?.some((c) => c.summary === 'support streaming exports')) {
      return `release-prep 未清洗内部前缀或漏掉功能提交：${JSON.stringify(parsed.userFacingCandidates)}`
    }
    if (!parsed.breakingSignals?.some((b) => b.field === 'engines.node')) {
      return `release-prep 未探测 engines.node 下限变化：${JSON.stringify(parsed.breakingSignals)}`
    }
    if ((parsed.implementedSpecs?.length ?? 0) !== 1 || (parsed.archivedOutcomes?.length ?? 0) !== 1) {
      return `release-prep 未采集已实现规格或归档任务摘要：${JSON.stringify({ specs: parsed.implementedSpecs, todos: parsed.archivedOutcomes })}`
    }
    if (!parsed.unaccountedPublicFiles?.some((u) => u.file === 'bin/cli.mjs')) {
      return `unaccountedPublicFiles 未检出含糊公开入口 bin/cli.mjs：${JSON.stringify(parsed.unaccountedPublicFiles)}`
    }

    const prepTextRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', multiDir, '--version', '3.0.0'])
    if (prepTextRes.status !== 0 || !prepTextRes.stdout.includes('v3.0.0') || !prepTextRes.stdout.includes('[AUDIT_ALERT]') || !prepTextRes.stdout.includes('[NEXT STEP]')) {
      return `release-prep 文本输出缺失关键字段：exit=${prepTextRes.status}\n${prepTextRes.stdout}`
    }

    const chgRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', changelogDir, '--version', '1.0.0', '--json'])
    if (chgRes.status !== 0) return `release-prep 无标签 CHANGELOG 仓失败：${chgRes.stderr}`
    const chgJson = JSON.parse(chgRes.stdout)
    if (!chgJson.range?.isInitialRelease || chgJson.notesMode?.mode !== 'changelog' || !chgJson.breakingSignals?.some((b) => b.field === 'requires-python')) {
      return `无标签 CHANGELOG 仓结果异常：${JSON.stringify({ range: chgJson.range, notesMode: chgJson.notesMode, breaking: chgJson.breakingSignals })}`
    }

    const nonGitRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['release-prep', nonGitDir])
    if (nonGitRes.status === 0) return '非 Git 目录运行 release-prep 未拦截'

    return true
  } finally {
    rmTree(multiDir)
    rmTree(changelogDir)
    rmTree(nonGitDir)
  }
}])

cases.push(['多维护者团队协同 Wave 5 (C23)：team-collaborator 与 owner 区分、C4 防误判底线、零提交/外部 Fork 与离线 teamProbeHint', async () => {
  const { classifyWorkspaceIdentity } = await import('../lib/platform/github.mjs')
  const { resolveWorkspaceIdentity } = await import('../../kit/skills/lib/shared.mjs')
  const { toMarkdown } = await import('../lib/render.mjs')

  const baseGitFacts = {
    present: true,
    remote: 'https://github.com/org-a/team-app.git',
    remoteUrls: { origin: 'https://github.com/org-a/team-app.git' },
    commitCount: 3,
    historyAuthors: ['Lead <lead@org-a.example>'],
    userName: 'NewMember',
    userEmail: 'new@org-a.example',
  }

  // 1. 正面（团队写权限协作者）：origin === declaredRepo 且登录账号不同于 originOwner -> maintainer + team-collaborator，无 teamProbeHint
  const ghTeam = classifyWorkspaceIdentity({
    gitFacts: baseGitFacts,
    declaredRepo: 'org-a/team-app',
    probeApi: { canPush: true, viewerPermission: 'WRITE', login: 'teammate-dev' },
  })
  if (ghTeam.role !== 'maintainer' || ghTeam.collaborationScope !== 'team-collaborator' || ghTeam.teamProbeHint) {
    return `github.mjs 未将写权限团队协作者判为 team-collaborator：${JSON.stringify(ghTeam)}`
  }
  const shTeam = resolveWorkspaceIdentity({
    remoteUrls: baseGitFacts.remoteUrls,
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
    apiProbe: { canPush: true, viewerPermission: 'WRITE', viewerLogin: 'teammate-dev' },
  })
  if (shTeam.role !== 'maintainer' || shTeam.collaborationScope !== 'team-collaborator' || shTeam.teamProbeHint) {
    return `shared.mjs 未将写权限团队协作者判为 team-collaborator：${JSON.stringify(shTeam)}`
  }

  // 2. 正面（所有者）：账号与 originOwner 同名 -> owner
  const ghOwner = classifyWorkspaceIdentity({
    gitFacts: { ...baseGitFacts, remote: 'https://github.com/alice/my-app.git', remoteUrls: { origin: 'https://github.com/alice/my-app.git' } },
    declaredRepo: 'alice/my-app',
    probeApi: { canPush: true, viewerPermission: 'ADMIN', login: 'alice' },
  })
  const shOwner = resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://github.com/alice/my-app.git' },
    declaredRepo: 'alice/my-app',
    apiProbe: { canPush: true, viewerPermission: 'ADMIN', viewerLogin: 'alice' },
  })
  if (ghOwner.role !== 'maintainer' || ghOwner.collaborationScope !== 'owner' || shOwner.role !== 'maintainer' || shOwner.collaborationScope !== 'owner') {
    return `owner 判定异常：gh=${JSON.stringify(ghOwner)}, sh=${JSON.stringify(shOwner)}`
  }

  // 3. 反面（C4 底线 + 离线 teamProbeHint）：同源无探针且历史作者非本机 -> 保守 clone-readonly + 带 teamProbeHint
  const ghOffline = classifyWorkspaceIdentity({ gitFacts: baseGitFacts, declaredRepo: 'org-a/team-app' })
  const shOffline = resolveWorkspaceIdentity({
    remoteUrls: baseGitFacts.remoteUrls,
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
  })
  if (ghOffline.role !== 'clone-readonly' || !ghOffline.teamProbeHint?.includes('--probe-auth')) {
    return `github.mjs 离线同源未保留 clone-readonly + teamProbeHint：${JSON.stringify(ghOffline)}`
  }
  if (shOffline.role !== 'clone-readonly' || !shOffline.teamProbeHint?.includes('--probe-auth')) {
    return `shared.mjs 离线同源未保留 clone-readonly + teamProbeHint：${JSON.stringify(shOffline)}`
  }

  // 4. 零提交同源无写证明 -> 保守 undetermined + 带 teamProbeHint
  const ghZero = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/org-a/empty-repo.git',
      remoteUrls: { origin: 'https://github.com/org-a/empty-repo.git' },
      commitCount: 0,
      historyAuthors: [],
      userName: 'NewMember',
      userEmail: 'new@org-a.example',
    },
    declaredRepo: 'org-a/empty-repo',
  })
  const shZero = resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://github.com/org-a/empty-repo.git' },
    declaredRepo: 'org-a/empty-repo',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: [],
    commits: 0,
  })
  if (ghZero.role !== 'undetermined' || !ghZero.teamProbeHint || shZero.role !== 'undetermined' || !shZero.teamProbeHint) {
    return `零提交同源未保守归入 undetermined + teamProbeHint：gh=${JSON.stringify(ghZero)}, sh=${JSON.stringify(shZero)}`
  }

  // 5. 外部 Fork（origin !== declaredRepo 或 upstream !== origin）与已确认只读 API -> 不应误出 teamProbeHint
  const ghFork = classifyWorkspaceIdentity({
    gitFacts: {
      ...baseGitFacts,
      remote: 'https://github.com/contrib/team-app.git',
      remoteUrls: { origin: 'https://github.com/contrib/team-app.git', upstream: 'https://github.com/org-a/team-app.git' },
    },
    declaredRepo: 'org-a/team-app',
  })
  const shFork = resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://github.com/contrib/team-app.git' },
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
  })
  if (ghFork.role !== 'contributor-fork' || ghFork.teamProbeHint || shFork.role !== 'contributor-fork' || shFork.teamProbeHint) {
    return `外部 Fork 异常或误出 teamProbeHint：gh=${JSON.stringify(ghFork)}, sh=${JSON.stringify(shFork)}`
  }

  const ghApiRead = classifyWorkspaceIdentity({
    gitFacts: baseGitFacts,
    declaredRepo: 'org-a/team-app',
    probeApi: { canPush: false, viewerPermission: 'READ', login: 'outsider' },
  })
  const shApiRead = resolveWorkspaceIdentity({
    remoteUrls: baseGitFacts.remoteUrls,
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
    apiProbe: { canPush: false, viewerPermission: 'READ', viewerLogin: 'outsider' },
  })
  if (ghApiRead.role !== 'clone-readonly' || ghApiRead.teamProbeHint || shApiRead.role !== 'clone-readonly' || shApiRead.teamProbeHint) {
    return `已确认 API 只读不应再输出 teamProbeHint：gh=${JSON.stringify(ghApiRead)}, sh=${JSON.stringify(shApiRead)}`
  }

  // 6. 临时仓联动：flow.mjs inspect（离线带 teamProbeHint）与 survey.mjs + render.mjs
  const teamDir = tmpProject({
    'package.json': `${JSON.stringify({ name: 'team-app', version: '1.0.0', repository: 'org-a/team-app', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': '# team-app\n',
    'src/index.mjs': 'export const ok = true\n',
  })
  try {
    spawnSync('git', ['init', '-q'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=Lead', '-c', 'user.email=lead@org-a.example', 'add', '-A'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=Lead', '-c', 'user.email=lead@org-a.example', 'commit', '-qm', 'init by lead'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 'NewTeammate'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'new@org-a.example'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/org-a/team-app.git'], { cwd: teamDir, stdio: 'ignore' })

    const flowJsonRes = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['inspect', '--json'], { cwd: teamDir })
    if (flowJsonRes.status !== 0) return `flow.mjs inspect --json 失败：${flowJsonRes.stderr}`
    const flowJson = JSON.parse(flowJsonRes.stdout)
    if (flowJson.identity?.role !== 'clone-readonly' || !flowJson.identity?.teamProbeHint?.includes('--probe-auth')) {
      return `flow.mjs inspect --json 离线同源未给出 teamProbeHint：${JSON.stringify(flowJson.identity)}`
    }

    const flowTextRes = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['inspect'], { cwd: teamDir })
    if (flowTextRes.status !== 0 || !flowTextRes.stdout.includes('团队权限提示') || !flowTextRes.stdout.includes('--probe-auth')) {
      return `flow.mjs inspect 文本缺少团队权限提示：\n${flowTextRes.stdout}`
    }

    const sOff = await survey(teamDir)
    const mdOff = toMarkdown(sOff)
    if (sOff.git?.role !== 'clone-readonly' || !sOff.git?.teamProbeHint || !mdOff.includes('协同提示：') || !mdOff.includes('团队/组织协作者写权限')) {
      return `survey + render 离线未展现 teamProbeHint：\n${mdOff}`
    }

    const sTeam = await survey(teamDir, { probeApi: { canPush: true, viewerPermission: 'WRITE', login: 'new-teammate' } })
    const mdTeam = toMarkdown(sTeam)
    if (sTeam.git?.role !== 'maintainer' || sTeam.git?.collaborationScope !== 'team-collaborator' || sTeam.git?.teamProbeHint || !mdTeam.includes('角色 `maintainer`（团队协作者）')) {
      return `survey + render 团队协作者展示异常：${JSON.stringify(sTeam.git)}\n${mdTeam}`
    }
    return true
  } finally {
    rmTree(teamDir)
  }
}])

cases.push(['通用自适应 TDD 与本仓 docs/TDD.md 重塑 Wave 5 (C24)：目录锚点、Mermaid/arch-rules/FeatureMap 与漂移拦截', async () => {
  const { validateDocTocAnchors } = await import('./preflight.mjs')
  const { templateVarsOf } = await import('../lib/protocol.mjs')

  const tddRaw = readFileSync(join(SKILL_ROOT, 'docs/TDD.md'), 'utf8')
  const tddErrors = validateDocTocAnchors(tddRaw)
  if (tddErrors.length > 0) return `docs/TDD.md 目录锚点有误：${tddErrors.join('；')}`

  const mermaidCount = (tddRaw.match(/```mermaid\b/g) ?? []).length
  if (mermaidCount < 2 || !tddRaw.includes('flowchart') || !tddRaw.includes('stateDiagram-v2')) {
    return `docs/TDD.md Mermaid 架构/状态图缺失（count=${mermaidCount}）`
  }
  if (!/```yaml[\s\S]*?\barch-rules:[\s\S]*?->[\s\S]*?```/.test(tddRaw)) {
    return 'docs/TDD.md 缺少可执行 arch-rules yaml 块'
  }

  const mapRes = runAbs('kit/skills/dev-explore/scripts/repo-map.mjs', [SKILL_ROOT, '--json'])
  if (mapRes.status !== 0) return `repo-map.mjs --json 失败：${mapRes.stderr}`
  const mapJson = JSON.parse(mapRes.stdout)
  const tddFeatures = (mapJson.featureMap ?? []).filter((x) => x.origin === 'docs/TDD.md')
  if (tddFeatures.length < 10 || !tddFeatures.every((x) => Boolean(x.source))) {
    return `repo-map.mjs 未从 docs/TDD.md 解析出完整 Feature Map：${JSON.stringify(mapJson.featureMap)}`
  }

  const sSelf = await survey(SKILL_ROOT)
  if ((sSelf.reentry?.staleTddPaths?.length ?? 0) > 0) {
    return `本仓 docs/TDD.md 存在失效路径：${JSON.stringify(sSelf.reentry.staleTddPaths)}`
  }

  const tplRaw = readFileSync(join(SKILL_ROOT, 'templates/docs-tdd.md'), 'utf8')
  const tplErrors = validateDocTocAnchors(tplRaw)
  if (tplErrors.length > 0) return `templates/docs-tdd.md 目录锚点有误：${tplErrors.join('；')}`
  if (!tplRaw.includes('[按需保留，不适用整节删除]') || tplRaw.includes('references/') || templateVarsOf(tplRaw).length > 0) {
    return 'templates/docs-tdd.md 未满足自适应按需标记或纯净度要求'
  }

  // 反面 1：validateDocTocAnchors 必须抓出悬空锚点
  const brokenErrors = validateDocTocAnchors('## 目录\n\n- [幽灵章节](#missing-anchor)\n\n## 真实章节\n')
  if (brokenErrors.length === 0) return 'validateDocTocAnchors 未拦截失效目录锚点'

  // 反面 2：docs/TDD.md 注入幽灵路径后，survey 与 govern-audit 必须共同抓出
  const ghostDir = tmpProject({
    'package.json': '{"name":"tdd-ghost","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'README.md': '# tdd-ghost\n',
    'src/ok.mjs': 'export const ok = true\n',
    'docs/TDD.md': '# tdd-ghost TDD\n\n## 目录\n\n- [模块](#模块)\n\n## 模块\n\n正常入口：`src/ok.mjs`，幽灵路径：`src/ghost-nonexistent-module.mjs`。\n',
  })
  try {
    gitInit(ghostDir)
    const sGhost = await survey(ghostDir)
    if (!sGhost.reentry?.drifted || !sGhost.reentry?.staleTddPaths?.includes('src/ghost-nonexistent-module.mjs') || sGhost.reentry?.staleTddPaths?.includes('src/ok.mjs')) {
      return `survey 未准确识别 TDD 幽灵路径：${JSON.stringify(sGhost.reentry)}`
    }
    const auditRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', ghostDir, '--json'])
    if (auditRes.status !== 0) return `govern-audit 失败：${auditRes.stderr}`
    const auditJson = JSON.parse(auditRes.stdout)
    const hit = (auditJson.findings ?? []).some((f) => f.id === 'docs.tdd-stale-path.src/ghost-nonexistent-module.mjs')
    if (!hit) return `govern-audit 未报出 docs.tdd-stale-path：${JSON.stringify(auditJson.findings?.map((f) => f.id))}`
    return true
  } finally {
    rmTree(ghostDir)
  }
}])

}
