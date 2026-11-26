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

  cases.push(['[R8-2] suite-inventory.mjs 改名落地与 detectOptionalNativeCheckers .prettierignore 探测（正反双向）', async () => {
    if (existsSync(join(process.cwd(), 'kit/skills/lib/test-inventory.mjs'))) {
      return 'kit/skills/lib/test-inventory.mjs 仍残留未重命名'
    }
    if (!existsSync(join(process.cwd(), 'kit/skills/lib/suite-inventory.mjs'))) {
      return '缺少 kit/skills/lib/suite-inventory.mjs'
    }
    const dirNeed = tmpProject({
      'package.json': '{"name":"p","scripts":{"format":"prettier --check ."}}\n',
      '.prettierrc': '{}\n',
      '.prettierignore': 'dist/\n',
    })
    const dirClean = tmpProject({
      'package.json': '{"name":"p2","scripts":{"format":"prettier --check ."}}\n',
      '.prettierignore': 'dist/\n.agents/\n.worktrees/\n',
    })
    try {
      const c1 = detectOptionalNativeCheckers(dirNeed)
      const adv1 = c1.agentIgnoreAdvice.find((a) => a.tool === 'prettier')
      if (!adv1 || adv1.alreadyIgnored !== false || !adv1.suggestion.includes('.prettierignore')) {
        return `未检出 .prettierignore 缺失忽略建议：${JSON.stringify(c1)}`
      }
      const c2 = detectOptionalNativeCheckers(dirClean)
      const adv2 = c2.agentIgnoreAdvice.find((a) => a.tool === 'prettier')
      if (!adv2 || adv2.alreadyIgnored !== true) {
        return `已包含 .agents/ 与 .worktrees/ 的 .prettierignore 仍误报：${JSON.stringify(c2)}`
      }
      return true
    } finally {
      rmTree(dirNeed)
      rmTree(dirClean)
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
    const reqRuntime = computeEmpiricalRequirements({
      diff: { files: [{ file: 'src/app.mjs', status: 'M' }], untracked: [], bytes: 10 },
      behavioralGate: { runtimeFilesTouched: ['src/app.mjs'], smokeRequired: false },
      effectiveProfile: { 'quick-test': ['node --test'] },
      task: { caseType: 3 },
    })
    if (reqRuntime.faultRequired !== true) {
      return `运行时代码改动未要求 faultRequired：${JSON.stringify(reqRuntime)}`
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
}
