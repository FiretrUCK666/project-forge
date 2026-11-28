/**
 * fixtures-r8-bugfixes.mjs —— R8 OpenCode E2E 10 项根因缺陷（C1..C10）正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { formatAgentCliArg } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs'
import { walkFiles } from '../../kit/skills/dev-govern/scripts/govern-checks.mjs'
import { computeEmpiricalRequirements } from '../../kit/skills/dev-review/scripts/review-empirical.mjs'
import { parseCritiqueStamp } from '../../kit/skills/lib/critique-diff.mjs'
import { normalizeWindowsLeadingRelativeCmd } from '../../kit/skills/lib/exec.mjs'
import { mergeFeatureMapIncremental } from '../../kit/skills/lib/feature-map.mjs'
import { writeAtomic } from '../../kit/skills/lib/git-core.mjs'
import { detectOptionalNativeCheckers } from '../../kit/skills/lib/profile-sniffer.mjs'
import { detectNonNodePackageCommands } from '../../kit/skills/lib/profile-sniffer-packages.mjs'
import { parseAgentsProfile } from '../../kit/skills/lib/profile.mjs'
import { resolveNativeTestDir } from '../../kit/skills/lib/suite-inventory.mjs'
import { GenericRemoteBackend } from '../../kit/skills/lib/task-backend-local.mjs'
import { pruneStaleBriefs, upsertVisualBrief } from '../../kit/skills/lib/visual-brief.mjs'
import { renderVisualHtml } from '../../kit/skills/lib/visual-render.mjs'
import { validateDevProfileRegion } from '../lib/agents-sections.mjs'
import { installGitHooks } from '../lib/equip-bootstrap.mjs'
import { renderAgentsTemplate } from '../compose-agents.mjs'
import { gitCommitFast, gitInit, gitInitBare, gitSync, rmTree, runAbsAsync, runNode, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerR8BugfixesCases(cases) {
  cases.push(['[R8-1] generic-git 裸仓快进合并识别 branch-protection: no-branch-protection 并透传 PF_ALLOW_DIRECT_PUSH', async () => {
    const bare = tmpProject({})
    const work = tmpProject({
      'AGENTS.md': [
        '# A',
        '```yaml',
        'quick-test: none',
        'full-test: none',
        'smoke-verify: none',
        '```',
        '## 取舍',
        '```text',
        '- `branch-protection`: `no-branch-protection`（单人本地仓库）',
        '```',
      ].join('\n'),
      'a.txt': 'v1\n',
    })
    try {
      gitInitBare(bare)
      gitInit(work, { branch: 'main' })
      gitSync(work, ['remote', 'add', 'origin', bare])
      gitSync(work, ['push', '-u', 'origin', 'main'])
      installGitHooks(work)

      gitSync(work, ['checkout', '-b', 'feat/bp-kv'])
      writeFileSync(join(work, 'a.txt'), 'v2\n', 'utf8')
      gitCommitFast(work, 'feat: bp-kv')
      const headSha = gitSync(work, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(work, ['push', '-u', 'origin', 'feat/bp-kv'])

      const backend = new GenericRemoteBackend({ pushRemote: 'origin', mainRoot: work, gitDir: join(work, '.git') })
      const ffOk = await backend.mergePr({
        branch: 'feat/bp-kv',
        baseBranch: 'main',
        ledger: { branch: 'feat/bp-kv', baseBranch: 'main', reviewPassed: true, reviewPassedHead: headSha },
      })
      if (!ffOk.merged || !ffOk.localBareFastForward) {
        return `branch-protection: no-branch-protection 未放行或被 pre-push 拒绝：${JSON.stringify(ffOk)}`
      }

      gitSync(work, ['checkout', '-b', 'feat/bp-strict'])
      writeFileSync(join(work, 'AGENTS.md'), '# A\n## 取舍\n- `branch-protection`: required\n', 'utf8')
      gitCommitFast(work, 'docs: require protection')
      const strictSha = gitSync(work, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(work, ['push', '-u', 'origin', 'feat/bp-strict'])
      const blocked = await backend.mergePr({
        branch: 'feat/bp-strict',
        baseBranch: 'main',
        ledger: { branch: 'feat/bp-strict', baseBranch: 'main', reviewPassed: true, reviewPassedHead: strictSha },
      })
      if (blocked.merged) return `branch-protection: required 竟误放行裸仓快进：${JSON.stringify(blocked)}`
      return true
    } finally {
      rmTree(work)
      rmTree(bare)
    }
  }])

  cases.push(['[R8-2] suite-inventory.mjs 改名落地与 detectOptionalNativeCheckers 返回契约（无 .agents/ 猜测建议）', async () => {
    if (existsSync(join(process.cwd(), 'kit/skills/lib/test-inventory.mjs'))) {
      return 'kit/skills/lib/test-inventory.mjs 仍残留未重命名'
    }
    if (!existsSync(join(process.cwd(), 'kit/skills/lib/suite-inventory.mjs'))) {
      return '缺少 kit/skills/lib/suite-inventory.mjs'
    }
    const dirWithPrettier = tmpProject({
      'package.json': '{"name":"p","scripts":{"format":"prettier --check ."}}\n',
      '.prettierrc': '{}\n',
    })
    const dirEmpty = tmpProject({
      'README.md': '# empty\n',
    })
    try {
      const c1 = detectOptionalNativeCheckers(dirWithPrettier)
      if (!c1.hasNativeConfig || !c1.configured.some((x) => x.tool === 'prettier')) {
        return `未检出原生 prettier 配置：${JSON.stringify(c1)}`
      }
      if ('agentIgnoreAdvice' in c1) {
        return `detectOptionalNativeCheckers 不应再产出静态 agentIgnoreAdvice：${JSON.stringify(c1)}`
      }
      const c2 = detectOptionalNativeCheckers(dirEmpty)
      if (c2.hasNativeConfig || c2.configured.length !== 0) {
        return `无原生检查器仓库误报 hasNativeConfig：${JSON.stringify(c2)}`
      }
      return true
    } finally {
      rmTree(dirWithPrettier)
      rmTree(dirEmpty)
    }
  }])

  cases.push(['[R8-3] writeAtomic 原子写入与失败清理零残留临时文件（正反双向）', () => {
    const dir = tmpProject({})
    try {
      const file = join(dir, 'nested/data.txt')
      writeAtomic(file, 'hello-v1\n')
      writeAtomic(file, 'hello-v2\n')
      if (readFileSync(file, 'utf8') !== 'hello-v2\n') return 'writeAtomic 覆盖内容不匹配'

      const existingDir = join(dir, 'as-dir')
      mkdirSync(existingDir, { recursive: true })
      let threw = false
      try { writeAtomic(existingDir, 'boom') } catch { threw = true }
      if (!threw) return 'writeAtomic 对目录路径未抛出异常'
      const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp-'))
      if (leftovers.length > 0) return `writeAtomic 失败后残留临时文件：${leftovers.join(', ')}`
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[R8-4] validateDevProfileRegion 与 isCalibratedDevProfile 支持多行 YAML 列表并拦截空列表/占位值', () => {
    const validMd = [
      '<!-- project-forge: begin Dev Profile -->',
      '## Dev Profile',
      '```yaml',
      'quick-test: node --test',
      'full-test: node --test',
      'smoke-verify: none',
      'merge-gate: node --test',
      'arch-rules:',
      '  - src/a/** -> src/b/**',
      'high-risk:',
      '  - scripts/lib/',
      'do-not-edit:',
      '  - docs/archive/',
      '```',
      '<!-- project-forge: end Dev Profile -->',
    ].join('\n')
    const okRes = validateDevProfileRegion(validMd)
    if (!okRes.ok) return `多行 YAML 列表误判失败：${JSON.stringify(okRes)}`

    const emptyListMd = validMd.replace('  - src/a/** -> src/b/**\n', '')
    const emptyRes = validateDevProfileRegion(emptyListMd)
    if (emptyRes.ok) return '空多行 YAML 列表竟被放行'

    const placeholderListMd = validMd.replace('  - scripts/lib/', '  - <待补充>')
    const phRes = validateDevProfileRegion(placeholderListMd)
    if (phRes.ok) return '含占位符的多行 YAML 列表竟被放行'

    const dir = tmpProject({ 'AGENTS.md': validMd })
    try {
      const parsed = parseAgentsProfile(dir)
      if (parsed.archRules.length !== 1 || parsed.highRisk[0] !== 'scripts/lib/') {
        return `parseAgentsProfile 解析多行列表异常：${JSON.stringify(parsed)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[R8-5] Python .venv pytest 嗅探与 Windows 首段正斜杠相对命令归一化（正反双向）', () => {
    const venvSub = process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python'
    const expectedPy = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'
    const dirVenv = tmpProject({
      'pyproject.toml': '[project]\nname="py"\n[tool.pytest.ini_options]\ntestpaths=["tests"]\n',
      [venvSub]: 'stub\n',
      'tests/test_x.py': 'def test_x(): assert True\n',
    })
    const dirPlain = tmpProject({
      'pyproject.toml': '[project]\nname="py2"\n',
      'tests/test_x.py': 'def test_x(): assert True\n',
    })
    try {
      const bucket = { dirRel: '', ecosystems: new Set(['python']), commands: {} }
      detectNonNodePackageCommands(dirVenv, bucket)
      if (bucket.commands.python?.quickTest !== `${expectedPy} -m pytest`) {
        return `profile-sniffer-packages 未优先选用 .venv python -m pytest：${JSON.stringify(bucket.commands)}`
      }
      const natVenv = resolveNativeTestDir(dirVenv, { ecosystem: 'python', tier: 'integration' })
      if (natVenv.runnerHint !== `${expectedPy} -m pytest`) {
        return `suite-inventory 未优先选用 .venv python -m pytest：${JSON.stringify(natVenv)}`
      }
      const natPlain = resolveNativeTestDir(dirPlain, { ecosystem: 'python', tier: 'integration' })
      if (natPlain.runnerHint !== 'python3 -m unittest') {
        return `无 pytest 配置与 .venv 时应回退 python3 -m unittest：${JSON.stringify(natPlain)}`
      }

      const winFixed = normalizeWindowsLeadingRelativeCmd('./.venv/Scripts/python.exe -m pytest tests/a.py', 'win32')
      if (winFixed !== '.\\.venv\\Scripts\\python.exe -m pytest tests/a.py') {
        return `Windows 首段正斜杠路径未转换或误伤参数：${winFixed}`
      }
      const winQuoted = normalizeWindowsLeadingRelativeCmd('".venv/Scripts/python.exe" -m pytest', 'win32')
      if (winQuoted !== '".venv\\Scripts\\python.exe" -m pytest') {
        return `Windows 带引号首段相对路径未转换：${winQuoted}`
      }
      const winNode = normalizeWindowsLeadingRelativeCmd('node --test tests/a.test.mjs', 'win32')
      if (winNode !== 'node --test tests/a.test.mjs') {
        return `非相对路径首段命令被误改：${winNode}`
      }
      return true
    } finally {
      rmTree(dirVenv)
      rmTree(dirPlain)
    }
  }])

  cases.push(['[R8-6] flow nextSteps 对含空格 --agent 参数加引号，无空格保持裸写（正反双向）', () => {
    if (formatAgentCliArg('OpenCode Agent') !== '"OpenCode Agent"') {
      return `含空格 agent 未加引号：${formatAgentCliArg('OpenCode Agent')}`
    }
    if (formatAgentCliArg('impl-r8') !== 'impl-r8') {
      return `无空格 agent 被多余加引号：${formatAgentCliArg('impl-r8')}`
    }
    return true
  }])

  cases.push(['[R8-7] contributor-fork + generic-git (prNumber=null) 允许已确认 cleanup，GitHub OPEN PR 仍严格硬锁', async () => {
    const upBare = tmpProject({})
    const forkDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# fork-generic\n',
      'AGENTS.md': '# F\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'a.txt': 'v1\n',
    })
    try {
      gitInitBare(upBare)
      gitInit(forkDir, { branch: 'main', origin: 'https://git.example.com/fork/demo.git' })
      gitSync(forkDir, ['remote', 'add', 'upstream', 'https://git.example.com/up/demo.git'])

      const s = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'gf-t', '--case', '1', '--slug', 'gf', '--json'], { cwd: forkDir })
      if (s.status !== 0) return `generic-git fork start 失败：${s.stderr}`
      const lFile = join(forkDir, '.worktrees', '.state', 'tasks', 'gf-t.json')
      const led = JSON.parse(readFileSync(lFile, 'utf8'))
      led.role = 'contributor-fork'
      led.providerId = 'generic-git'
      led.prNumber = null
      led.status = 'awaiting-upstream-merge'
      writeFileSync(lFile, JSON.stringify(led, null, 2), 'utf8')

      const pre = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 'gf-t', '--json'], { cwd: forkDir })
      const hash = JSON.parse(pre.stdout).previewHash
      const okClean = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 'gf-t', '--confirm', '--preview-hash', hash, '--json'], { cwd: forkDir })
      if (okClean.status !== 0) {
        return `generic-git contributor-fork (prNumber=null) 仍被 BLOCKED_OPEN_FORK_PR 死锁：exit=${okClean.status} out=${okClean.stdout} err=${okClean.stderr}`
      }
      return true
    } finally {
      rmTree(forkDir)
      rmTree(upBare)
    }
  }])

  cases.push(['[R8-8] PRIMARY_README 模板变量渲染非 README.md 主文件名与默认值回退（正反双向）', async () => {
    const enDir = tmpProject({ 'README.en.md': '# English Project\n\nPrimary doc.\n' })
    try {
      const f = await survey(enDir)
      const tpl = readFileSync(join(process.cwd(), 'templates', 'agents-project.md'), 'utf8')
      const out = renderAgentsTemplate(f, tpl, enDir, {})
      if (!out.includes('`README.en.md`') || out.includes('{{PRIMARY_README}}') || out.includes('面向人的文档见 `README.md`')) {
        return `PRIMARY_README 未替换为主文件名 README.en.md：\n${out.slice(0, 600)}`
      }
      return true
    } finally {
      rmTree(enDir)
    }
  }])

  cases.push(['[R8-9] installGitHooks 仅对已跟踪 .githooks/pre-push 修正 100755 位，未跟踪时不误暂存', () => {
    const dir = tmpProject({ 'README.md': '# hooks\n' })
    try {
      gitInit(dir, { branch: 'main' })
      installGitHooks(dir)
      const untrackedStage = gitSync(dir, ['ls-files', '--stage', '--', '.githooks/pre-push'], { encoding: 'utf8' }).stdout.trim()
      if (untrackedStage) return `未跟踪 .githooks/pre-push 被意外暂存：${untrackedStage}`

      gitSync(dir, ['add', '.githooks/pre-push'])
      gitSync(dir, ['update-index', '--chmod=-x', '.githooks/pre-push'])
      installGitHooks(dir)
      const trackedStage = gitSync(dir, ['ls-files', '--stage', '--', '.githooks/pre-push'], { encoding: 'utf8' }).stdout.trim()
      if (!/^100755\s/.test(trackedStage)) {
        return `已跟踪 .githooks/pre-push 未修正为 100755：${trackedStage}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[R8-10] feature-map dependsOn:[] 保留、govern walkFiles 跳过 _build/.gitignore、review-empirical/critique-diff/visual-render/docAnchors/pruneStaleBriefs', async () => {
    // 1. mergeFeatureMapIncremental 保留显式 dependsOn: []
    const mRes = mergeFeatureMapIncremental(
      { version: 2, features: [{ id: 'leaf', name: 'Leaf', dependsOn: [], entrypoints: ['src/a.mjs'], modules: ['src/a.mjs'], verificationTools: [], testRefs: [] }] },
      { version: 2, features: [{ id: 'leaf', name: 'Leaf', dependsOn: ['other'], entrypoints: ['src/a.mjs'], modules: ['src/a.mjs'], verificationTools: [], testRefs: [] }] },
    )
    const leaf = mRes.featureMap.features.find((f) => f.id === 'leaf')
    if (!Array.isArray(leaf?.dependsOn) || leaf.dependsOn.length !== 0) {
      return `显式 dependsOn: [] 被增量合并覆盖：${JSON.stringify(leaf)}`
    }

    // 2. govern-checks walkFiles 跳过 _build 与 .gitignore 目录，不漏扫描源码
    const govDir = tmpProject({
      '.gitignore': 'docs/_build/\nsite/\n',
      'docs/_build/html/searchindex.js': 'eval("x")\n',
      '_build/out.js': 'eval("x")\n',
      'site/index.js': 'eval("x")\n',
      'src/real.mjs': 'export const x = 1\n',
    })
    try {
      const walked = walkFiles(govDir).map((f) => f.rel)
      if (!walked.includes('src/real.mjs') || walked.some((r) => r.includes('_build/') || r.startsWith('site/'))) {
        return `walkFiles 未跳过 _build 或 .gitignore 目录：${JSON.stringify(walked)}`
      }
    } finally {
      rmTree(govDir)
    }

    // 3. review-empirical 纯文档无测试命令高风险不强要求 check-fault；有代码改动仍要求
    const reqDocNoCmd = computeEmpiricalRequirements({
      diff: { files: [{ file: 'AGENTS.md', status: 'M' }], untracked: [], bytes: 10 },
      behavioralGate: { runtimeFilesTouched: [], smokeRequired: false },
      effectiveProfile: { 'high-risk': ['AGENTS.md'], explicitNone: new Set(['quick-test', 'full-test', 'smoke-verify', 'merge-gate']) },
      task: { caseType: 3 },
    })
    if (reqDocNoCmd.faultRequired !== false) {
      return `无运行时文件且无测试命令的高风险文档改动误要求 faultRequired：${JSON.stringify(reqDocNoCmd)}`
    }
    const reqRuntimeMed = computeEmpiricalRequirements({
      diff: { files: [{ file: 'src/app.mjs', status: 'M' }], untracked: [], bytes: 10 },
      behavioralGate: { runtimeFilesTouched: ['src/app.mjs'], smokeRequired: false },
      effectiveProfile: { 'quick-test': ['node --test'] },
      task: { caseType: 3 },
    })
    if (reqRuntimeMed.faultRequired !== false) {
      return `普通 medium 运行时改动不应强制 faultRequired：${JSON.stringify(reqRuntimeMed)}`
    }
    const reqRuntimeHigh = computeEmpiricalRequirements({
      diff: { files: [{ file: 'src/app.mjs', status: 'M' }], untracked: [], bytes: 10 },
      behavioralGate: { runtimeFilesTouched: ['src/app.mjs'], smokeRequired: false },
      effectiveProfile: { 'quick-test': ['node --test'], 'high-risk': ['src/app.mjs'] },
      task: { caseType: 3 },
    })
    if (reqRuntimeHigh.faultRequired !== true) {
      return `高危运行时代码改动未要求 faultRequired：${JSON.stringify(reqRuntimeHigh)}`
    }

    // 4. parseCritiqueStamp 支持 summary 内嵌括号
    const stamp = parseCritiqueStamp('rejected (reviewer=critic-1, round=2, sha=abcdef12, summary=fix auth (issue #1) and (edge))')
    if (stamp?.summary !== 'fix auth (issue #1) and (edge)' || stamp?.reviewer !== 'critic-1' || stamp?.round !== 2) {
      return `parseCritiqueStamp 截断了内嵌括号 summary：${JSON.stringify(stamp)}`
    }

    // 5. visual-render 不静默截断 >12 modules
    const mods = Array.from({ length: 15 }, (_, i) => `src/m${i}.mjs`)
    const { html } = renderVisualHtml({
      visualModel: {
        title: 'Full Modules',
        tree: {
          domains: [{ id: 'd1', x: 0, y: 0, w: 300, h: 200, row: 0, col: 0, innerCols: 1, innerRows: 1 }],
          nodes: [{ id: 'n1', title: 'N1', domain: 'd1', risk: 'medium', x: 10, y: 10, w: 200, h: 100, cx: 110, cy: 60, modules: mods }],
          edges: [],
        },
        flow: { width: 680, height: 320, lanes: [], stages: [], nodes: [], edges: [], flows: [] },
      },
    })
    if (!html.includes('src/m14.mjs')) return 'visual-render 仍截断了第 13+ 个 modules'

    // 6. verify-tools audit 拦截缺失 docAnchors 目标文件，真实存在的 #fragment 通过
    const vtDir = tmpProject({
      'docs/TDD.md': '# TDD\n',
      'src/a.mjs': 'export const a = 1\n',
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        features: [{
          id: 'fa', name: 'FA', entrypoints: ['src/a.mjs'], modules: ['src/a.mjs'],
          businessFlows: ['flow'], verificationTools: [{ id: 'vt-a', kind: 'command', command: 'exit 0', riskLevel: 'medium' }],
          testRefs: [], docAnchors: ['docs/TDD.md#sec', 'docs/MISSING.md#sec'],
        }],
      }, null, 2),
    })
    try {
      const vtRes = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['audit', vtDir, '--json'])
      const vtJson = JSON.parse(vtRes.stdout || '{}')
      if (vtRes.status !== 3 || !vtJson.zombies?.some((z) => z.kind === 'missing-doc-anchor' && z.path === 'docs/MISSING.md#sec')) {
        return `verify-tools audit 未拦截缺失 docAnchors：exit=${vtRes.status} out=${vtRes.stdout}`
      }
    } finally {
      rmTree(vtDir)
    }

    // 7. pruneStaleBriefs 清理归属同一 parentBriefKey 的子 brief，保留无关活跃 brief
    const brDir = tmpProject({ '.gitignore': '.worktrees/\n' })
    try {
      upsertVisualBrief(brDir, { briefKey: 'child-1', kind: 'task', taskId: 'child-1', parentBriefKey: 'parent-task', title: 'Child' })
      upsertVisualBrief(brDir, { briefKey: 'keep-other', kind: 'task', taskId: 'keep-other', title: 'Other' })
      const pr = pruneStaleBriefs(brDir, { taskId: 'parent-task' })
      if (!pr.pruned.includes('child-1') || pr.pruned.includes('keep-other')) {
        return `pruneStaleBriefs 未连带清理关联子 brief 或误删无关 brief：${JSON.stringify(pr)}`
      }
    } finally {
      rmTree(brDir)
    }
    return true
  }])

  cases.push(['Slice1 C8/C9：通用 SQL ALTER TABLE FK / SQLAlchemy 2.0 / @Table ERD 核、四图有界截断、扫描线与 cache v2 + Rust mod', async () => {
    const { extractErdEvidence } = await import('../../kit/skills/lib/static-evidence-erd.mjs')
    const { layoutTreeDiagram, layoutErdDiagram, layoutClassDiagram, MAX_TREE_NODES, MAX_ERD_NODES, MAX_CLASS_NODES } = await import('../../kit/skills/lib/visual-layout-diagrams.mjs')
    const { layoutDataflowDiagram, MAX_DATAFLOW_NODES } = await import('../../kit/skills/lib/visual-layout-charts.mjs')
    const { verifyDiagramGeometry } = await import('../../kit/skills/lib/visual-geometry-check.mjs')
    const { analyzeRepoStatic, ANALYSIS_CACHE_SCHEMA_VERSION, MAX_ANALYSIS_CACHE_BYTES } = await import('../../kit/skills/lib/static-analyzer.mjs')

    const dir = tmpProject({
      'db/schema.sql': [
        'CREATE TABLE users (id INT PRIMARY KEY, email TEXT);',
        'CREATE TABLE orders (id INT PRIMARY KEY, user_id INT);',
        'ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id);',
      ].join('\n'),
      'models/account.py': [
        'class Account(Base):',
        '    __tablename__ = "accounts"',
        '    id: Mapped[str] = mapped_column(String, primary_key=True)',
        '    org_id: Mapped[str] = mapped_column(ForeignKey("orgs.id"))',
      ].join('\n'),
      'models/doc.ts': [
        '@Table({ tableName: "documents" })',
        'export class DocumentModel extends Model {',
        '  @Column title: string',
        '  @BelongsTo(() => Account)',
        '  account: Account',
        '}',
      ].join('\n'),
      'src/lib.rs': 'mod worker;\nuse crate::worker::run;\n',
      'src/worker.rs': 'pub fn run() {}\n',
    })
    const cacheDir = tmpProject({})
    try {
      // C8: ERD 最小通用核
      const erd = extractErdEvidence(dir, ['db/schema.sql', 'models/account.py', 'models/doc.ts'])
      if (!erd.active) return `C8 ERD 未激活：${JSON.stringify(erd)}`
      if (!erd.data.relations.some((r) => r.from === 'orders' && r.to === 'users')) {
        return `C8 SQL ALTER TABLE FOREIGN KEY 关系漏检：${JSON.stringify(erd.data.relations)}`
      }
      const acct = erd.data.entities.find((e) => e.name === 'Account')
      if (!acct || !acct.fields.includes('id') || !acct.fields.includes('org_id')) {
        return `C8 SQLAlchemy 2.0 Mapped/mapped_column 字段漏检：${JSON.stringify(acct)}`
      }
      if (!erd.data.entities.some((e) => e.name === 'DocumentModel' && e.fields.includes('title'))) {
        return `C8 通用 @Table 实体/字段漏检：${JSON.stringify(erd.data.entities)}`
      }

      // C9: 四类图硬节点上限 + meta.truncated
      const bigTree = { name: 'root', path: '', children: Array.from({ length: 150 }, (_, i) => ({ name: `f${i}.mjs`, path: `f${i}.mjs`, isFile: true, fileCount: 1 })) }
      const tLayout = layoutTreeDiagram({ root: bigTree })
      if (tLayout.nodes.length > MAX_TREE_NODES || !tLayout.meta.truncated || tLayout.meta.totalBeforeTruncate !== 151) {
        return `C9 tree 未执行 <=${MAX_TREE_NODES} 截断：${JSON.stringify(tLayout.meta)}`
      }
      const bigErd = {
        entities: Array.from({ length: 70 }, (_, i) => ({ name: `E${i}`, fields: ['id:int'] })),
        relations: Array.from({ length: 69 }, (_, i) => ({ from: `E${i + 1}`, to: `E${i}`, label: 'fk' })),
      }
      const eLayout = layoutErdDiagram(bigErd)
      if (eLayout.nodes.length > MAX_ERD_NODES || !eLayout.meta.truncated) {
        return `C9 erd 未执行 <=${MAX_ERD_NODES} 截断：${JSON.stringify(eLayout.meta)}`
      }
      const bigClass = {
        classes: Array.from({ length: 80 }, (_, i) => `Cls${i}`),
        edges: Array.from({ length: 79 }, (_, i) => ({ from: `Cls${i + 1}`, to: `Cls${i}`, kind: 'extends' })),
      }
      const cLayout = layoutClassDiagram(bigClass)
      if (cLayout.nodes.length > MAX_CLASS_NODES || !cLayout.meta.truncated) {
        return `C9 class 未执行 <=${MAX_CLASS_NODES} 截断：${JSON.stringify(cLayout.meta)}`
      }
      const bigDf = {
        stages: Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, label: `S${i}` })),
        edges: Array.from({ length: 79 }, (_, i) => ({ from: `s${i}`, to: `s${i + 1}` })),
      }
      const dfLayout = layoutDataflowDiagram(bigDf)
      if (dfLayout.nodes.length > MAX_DATAFLOW_NODES || !dfLayout.meta.truncated) {
        return `C9 dataflow 未执行 <=${MAX_DATAFLOW_NODES} 截断：${JSON.stringify(dfLayout.meta)}`
      }

      // C9: Sweep-Line 大规模无重叠校验 + 重叠/穿盒反例检出
      const gridNodes = Array.from({ length: 400 }, (_, i) => ({
        id: `n${i}`, x: (i % 20) * 120 + 20, y: Math.floor(i / 20) * 80 + 20, w: 90, h: 40,
      }))
      const geoOk = verifyDiagramGeometry({ id: 'big', width: 2600, height: 1700, nodes: gridNodes, edges: [] })
      if (!geoOk.ok) return `C9 Sweep-Line 误报无重叠网格：${JSON.stringify(geoOk.violations.slice(0, 3))}`
      const geoOverlap = verifyDiagramGeometry({
        id: 'ov', width: 500, height: 300,
        nodes: [{ id: 'a', x: 20, y: 20, w: 100, h: 50 }, { id: 'b', x: 80, y: 40, w: 100, h: 50 }],
        edges: [],
      })
      if (geoOverlap.ok || geoOverlap.stats.overlaps !== 1) return `C9 Sweep-Line 漏报重叠：${JSON.stringify(geoOverlap)}`
      const geoCross = verifyDiagramGeometry({
        id: 'cr', width: 500, height: 300,
        nodes: [{ id: 'a', x: 10, y: 40, w: 40, h: 40 }, { id: 'mid', x: 100, y: 30, w: 60, h: 60 }, { id: 'b', x: 220, y: 40, w: 40, h: 40 }],
        edges: [{ id: 'e1', fromId: 'a', toId: 'b', points: [{ x: 50, y: 60 }, { x: 220, y: 60 }] }],
      })
      if (geoCross.ok || geoCross.stats.crossings !== 1) return `C9 Sweep-Line 漏报边穿盒：${JSON.stringify(geoCross)}`

      // C9: cache v2 (128 MB 上限) 精简不含 candidates + 缓存命中保真 Rust mod 边
      if (ANALYSIS_CACHE_SCHEMA_VERSION !== 2 || MAX_ANALYSIS_CACHE_BYTES !== 128 * 1024 * 1024) {
        return `C9 cache 常量异常：v=${ANALYSIS_CACHE_SCHEMA_VERSION} bytes=${MAX_ANALYSIS_CACHE_BYTES}`
      }
      const a1 = await analyzeRepoStatic(dir, { useCache: true, cacheRoot: cacheDir, includeGitChurn: false })
      const cacheRaw = readFileSync(a1.cacheStats.cachePath, 'utf8')
      if (cacheRaw.includes('"candidates"')) return 'C9 cache v2 仍残留冗余 candidates 字段'
      const a2 = await analyzeRepoStatic(dir, { useCache: true, cacheRoot: cacheDir, includeGitChurn: false })
      if (a2.cacheStats.hits === 0 || a2.cacheStats.misses !== 0) {
        return `C9 二次分析未命中缓存：${JSON.stringify(a2.cacheStats)}`
      }
      if (!a2.edges.some((e) => e.from === 'src/lib.rs' && e.to === 'src/worker.rs')) {
        return `C9 cache v2 命中后 Rust mod 边丢失：${JSON.stringify(a2.edges)}`
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(cacheDir)
    }
  }])
}
