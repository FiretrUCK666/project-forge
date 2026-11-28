#!/usr/bin/env node
/**
 * fixtures-runtime-contracts.mjs —— 8 技能运行时崩溃修复、UI 视觉实证防自死锁、
 * doc-plan/claim/verify [NEXT STEP] 对齐、submit 溯源与默认分支写护栏的正反双向行为断言。
 *
 * 自动被 `scripts/dev/fixtures.mjs` 发现执行，也可直接运行 `node scripts/dev/fixtures-runtime-contracts.mjs`。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { isMainModule, resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { readTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { evaluateNextState, readVerificationEvidence } from '../../kit/skills/lib/workflow-policy.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleVerify, handleSubmit } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { assertSubmitOwnership } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'
import { handleClaim } from '../../kit/skills/dev-flow/scripts/flow-merge-claim.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, runNode, SKILL_ROOT, tmpProject } from './fixtures-helpers.mjs'

const VT_SCRIPT = 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs'
const RP_SCRIPT = 'kit/skills/dev-review/scripts/review-pack.mjs'
const DP_SCRIPT = 'kit/skills/dev-plan/scripts/doc-plan.mjs'
const IT_SCRIPT = 'kit/skills/dev-iterate/scripts/iterate.mjs'
const GV_SCRIPT = 'kit/skills/dev-govern/scripts/govern-audit.mjs'

async function withQuietIo(fn) {
  let out = ''
  let err = ''
  const origOut = process.stdout.write
  const origErr = process.stderr.write
  process.stdout.write = (chunk) => { out += String(chunk); return true }
  process.stderr.write = (chunk) => { err += String(chunk); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function registerRuntimeContractsCases(cases) {
  cases.push(['C1：verify-tools 补齐缺失导入、裸 run 默认 --changed 与 --allow-medium-fallback 强校 --live-e2e-cmd（正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c1-vt\n\n## Dev Profile\n```yaml\nquick-test: node -e "process.exit(0)"\nsmoke-verify: none\n```\n',
      'src/math.mjs': 'export function add(a, b) { return a + b }\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@vt.test' })
    try {
      // 1. 无 feature-map 时裸 run 走 generateRepoMap + prefillFeatureMapFromRepoMap（不抛 ReferenceError）且默认 --changed
      const bareNoMap = await runAbsAsync(VT_SCRIPT, ['run', '--json'], { cwd: dir })
      if (bareNoMap.status !== 0 || /ReferenceError/.test(bareNoMap.stderr)) {
        return `无 feature-map 裸 run 失败或抛 ReferenceError：exit=${bareNoMap.status} err=${bareNoMap.stderr} out=${bareNoMap.stdout}`
      }
      const noMapJson = JSON.parse(bareNoMap.stdout)
      if (noMapJson.mapSource !== 'prefill-in-memory' || noMapJson.status !== 'NOT_APPLICABLE') {
        return `无 feature-map 裸 run 返回异常：${bareNoMap.stdout}`
      }

      // 2. create --promote 正常调用 renderArchitectureMapFromRepo（不抛 ReferenceError）并生成架构图
      const draftRes = await runAbsAsync(VT_SCRIPT, [
        'create', '--feature', 'math', '--task', 't-vt', '--draft-only', '--draft-file', 'probe-math.mjs',
        '--draft-content', 'import { add } from "../src/math.mjs"\nif (add(1, 2) !== 3) process.exit(1)\nconsole.log("MATH_OK")\n',
        '--json',
      ], { cwd: dir })
      if (draftRes.status !== 0) return `create --draft-only 失败：${draftRes.stderr}`

      const promRes = await runAbsAsync(VT_SCRIPT, [
        'create', '--feature', 'math', '--task', 't-vt', '--from-scratch', 'probe-math.mjs',
        '--script', 'scripts/verify-math.mjs', '--entrypoints', 'src/math.mjs', '--modules', 'src/math.mjs',
        '--risk', 'medium', '--promote', '--json',
      ], { cwd: dir })
      if (promRes.status !== 0 || /ReferenceError/.test(promRes.stderr)) {
        return `create --promote 失败或抛 ReferenceError：exit=${promRes.status} err=${promRes.stderr} out=${promRes.stdout}`
      }
      if (!existsSync(join(dir, 'docs/architecture-map.html'))) {
        return 'create --promote 未生成 docs/architecture-map.html'
      }

      // 3. 改 src/math.mjs 后裸 run（不传 --changed）自动反查匹配工具并按 medium stale 阻断；再测试 --allow-medium-fallback 正反双向
      writeFileSync(join(dir, 'src/math.mjs'), 'export function addV2(a, b) { return a + b }\n', 'utf8')
      const bareChanged = await runAbsAsync(VT_SCRIPT, ['run', '--json'], { cwd: dir })
      if (bareChanged.status !== 3 || JSON.parse(bareChanged.stdout).code !== 'STALE_MEDIUM_FALLBACK') {
        return `裸 run 未默认按 --changed 匹配工具：exit=${bareChanged.status} out=${bareChanged.stdout}`
      }

      // 反面：--allow-medium-fallback 缺 --live-e2e-cmd 必须返回 EXIT.USAGE (2)
      const missingLive = await runAbsAsync(VT_SCRIPT, ['run', '--tool', 'verify-math', '--allow-medium-fallback', '--json'], { cwd: dir })
      if (missingLive.status !== EXIT.USAGE || JSON.parse(missingLive.stdout).code !== 'MISSING_LIVE_E2E_CMD') {
        return `--allow-medium-fallback 缺 --live-e2e-cmd 未返回 EXIT.USAGE：exit=${missingLive.status} out=${missingLive.stdout}`
      }

      // 正面：补齐 --live-e2e-cmd 后放行
      const withLive = await runAbsAsync(VT_SCRIPT, [
        'run', '--tool', 'verify-math', '--allow-medium-fallback', '--live-e2e-cmd', 'node -e "console.log(\'LIVE_OK\')"', '--json',
      ], { cwd: dir })
      if (withLive.status !== 0 || JSON.parse(withLive.stdout).results?.[0]?.usedLiveOverride !== true) {
        return `--allow-medium-fallback 配 --live-e2e-cmd 未放行：exit=${withLive.status} out=${withLive.stdout}`
      }

      // help 文案对齐默认写入与 --dry-run
      const helpRes = await runAbsAsync(VT_SCRIPT, ['--help'], { cwd: dir })
      if (!helpRes.stdout.includes('sync writes by default')) {
        return `verify-tools --help 未对齐 sync 默认写入说明：\n${helpRes.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C2：UI 视觉实证 smoke->full 复用不死锁、quick/--inner 免阻断、explicit-none 暂存附件与 review check-empirical 同源（正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': [
        '# ui-app',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: node -e "process.exit(0)"',
        'full-test: node -e "process.exit(0)"',
        'smoke-verify: node -e "process.exit(0)"',
        'merge-gate: none',
        'high-risk: none',
        'do-not-edit: docs/archive/',
        '```',
      ].join('\n'),
      'src/App.tsx': 'export const App = () => "v1"\n',
      'shots/ui.png': 'fake-png-bytes-non-empty\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@ui.test' })
    try {
      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({
        task: 'ui-deadlock', case: '2', slug: 'ui-deadlock', agent: 'impl-ui',
        'no-issue': true, reason: '验证 UI smoke 与 full 连续实证无自死锁',
      }, roots))
      const implWt = join(dir, '.worktrees', 'impl-ui-deadlock')
      writeFileSync(join(implWt, 'src/App.tsx'), 'export const App = () => "v2"\n', 'utf8')
      gitCommitFast(implWt, 'feat: update App', { updateOnly: true })
      const headSha = gitSync(implWt, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

      // 1. quick 模式不因缺 --artifact 阻断
      const qRes = await withQuietIo(() => handleVerify({ task: 'ui-deadlock', mode: 'quick', json: true }, roots))
      if (qRes.res.exitCode !== 0) return `UI quick 模式不应阻断 BLOCKED_UI_ARTIFACT_REQUIRED：${qRes.err} ${qRes.out}`

      // 2. 反面：full 模式在无任何已存视觉证据且无 --artifact 时仍须阻断 BLOCKED_UI_ARTIFACT_REQUIRED
      const fNoArt = await withQuietIo(() => handleVerify({ task: 'ui-deadlock', mode: 'full', json: true }, roots))
      if (fNoArt.res.exitCode !== EXIT.FACT || !`${fNoArt.out}${fNoArt.err}`.includes('BLOCKED_UI_ARTIFACT_REQUIRED')) {
        return `无视觉实证时 full 模式未阻断：exit=${fNoArt.res.exitCode} out=${fNoArt.out} err=${fNoArt.err}`
      }

      // 3. 正面：先 smoke 带 --artifact + --e2e-evidence 通过，再跑 full 不重传 --artifact 必须通过且保留 verifiedHead
      const smk = await withQuietIo(() => handleVerify({
        task: 'ui-deadlock', mode: 'smoke', artifact: [join(implWt, 'shots/ui.png')],
        'e2e-evidence': '在预览环境打开 App 页面确认浅深色主题卡片无遮挡且按钮点击正常', json: true,
      }, roots))
      if (smk.res.exitCode !== 0) return `smoke 带 --artifact 失败：${smk.err} ${smk.out}`

      const fullAfterSmoke = await withQuietIo(() => handleVerify({ task: 'ui-deadlock', mode: 'full', json: true }, roots))
      if (fullAfterSmoke.res.exitCode !== 0) {
        return `smoke 落账视觉实证后 full 发生自死锁：exit=${fullAfterSmoke.res.exitCode} err=${fullAfterSmoke.err} out=${fullAfterSmoke.out}`
      }
      const ledgerAfterFull = readTaskLedger(dir, 'ui-deadlock')
      if (ledgerAfterFull?.verifiedHead !== headSha) {
        return `full 后 verifiedHead 被意外清空：${JSON.stringify({ expected: headSha, got: ledgerAfterFull?.verifiedHead })}`
      }

      // 4. submit 后 review-pack check-empirical 不重传 --artifact 自动复用同 HEAD evidence.json，不死锁
      const subRes = await withQuietIo(() => handleSubmit({ task: 'ui-deadlock', agent: 'impl-ui', json: true }, roots))
      if (subRes.res.exitCode !== 0) return `submit 失败：${subRes.err} ${subRes.out}`

      const packPre = await runAbsAsync(RP_SCRIPT, ['--task', 'ui-deadlock', '--round', '1', '--json'], { cwd: dir })
      if (packPre.status !== 0) return `review-pack 机械包失败：${packPre.stderr}`
      const empNoReArt = await runAbsAsync(RP_SCRIPT, [
        'check-empirical', '--task', 'ui-deadlock', '--round', '1',
        '--e2e-evidence', '审查工作位复核 App 页面渲染与点击状态正常，与附件截图一致', '--json',
      ], { cwd: dir })
      if (empNoReArt.status !== 0) {
        return `review check-empirical 未复用同 HEAD 存储视觉证据而死锁：exit=${empNoReArt.status} out=${empNoReArt.stdout} err=${empNoReArt.stderr}`
      }
      const incDiff = await runAbsAsync(RP_SCRIPT, ['--task', 'ui-deadlock', '--round', '1', '--include-diff', '--json'], { cwd: dir })
      if (incDiff.status !== 0 || JSON.parse(incDiff.stdout).diff?.diffIncluded !== true) {
        return `check-empirical 复用视觉证据后 --include-diff 未解锁：exit=${incDiff.status} out=${incDiff.stdout}`
      }

      // 5. sandbox --inner 在有 UI 改动且无 --artifact 时绝不阻断
      await withQuietIo(() => handleStart({
        task: 'ui-sb', slug: 'ui-sb', sandbox: true, agent: 'impl-sb',
      }, roots))
      const sbWt = join(dir, '.worktrees', 'sandbox-ui-sb')
      writeFileSync(join(sbWt, 'src/App.tsx'), 'export const App = () => "v-sb"\n', 'utf8')
      const sbVerify = await withQuietIo(() => handleVerify({ task: 'ui-sb', mode: 'full', inner: true, json: true }, roots))
      if (sbVerify.res.exitCode !== 0) {
        return `sandbox --inner verify 在 UI 改动下被误拦：exit=${sbVerify.res.exitCode} err=${sbVerify.err} out=${sbVerify.out}`
      }

      // 6. explicit-none 静态 HTML 仓：verify 带 --artifact 时必须先暂存附件（stagedPath 落账）
      const staticDir = tmpProject({
        '.gitignore': '.worktrees/\n',
        'AGENTS.md': [
          '# static-site',
          '',
          '## Dev Profile',
          '```yaml',
          'quick-test: none',
          'full-test: none',
          'smoke-verify: none',
          'merge-gate: none',
          '```',
        ].join('\n'),
        'public/index.html': '<h1>v1</h1>\n',
        'shots/page.png': 'png-payload-12345\n',
      })
      gitInit(staticDir, { branch: 'main', name: 'dev', email: 'dev@static.test' })
      try {
        const sRoots = await resolveRepoRoots(staticDir)
        await withQuietIo(() => handleStart({
          task: 'st-ui', case: '2', slug: 'st-ui', agent: 'impl-st',
          'no-issue': true, reason: '验证 explicit-none 静态仓暂存视觉附件',
        }, sRoots))
        const stWt = join(staticDir, '.worktrees', 'impl-st-ui')
        writeFileSync(join(stWt, 'public/index.html'), '<h1>v2</h1>\n', 'utf8')
        gitCommitFast(stWt, 'feat: update index.html', { updateOnly: true })
        const stVer = await withQuietIo(() => handleVerify({
          task: 'st-ui', mode: 'full', artifact: [join(stWt, 'shots/page.png')],
          'e2e-evidence': '在浏览器打开静态页面验证标题更新且浅深色排版正常', json: true,
        }, sRoots))
        if (stVer.res.exitCode !== 0) return `static explicit-none verify 失败：${stVer.err} ${stVer.out}`
        const stEv = readVerificationEvidence(sRoots.gitDir, 'st-ui')
        const stagedPath = stEv?.artifacts?.[0]?.stagedPath
        if (!stagedPath || !existsSync(stagedPath)) {
          return `explicit-none 路径未暂存附件 stagedPath：${JSON.stringify(stEv?.artifacts)}`
        }
      } finally { rmTree(staticDir) }

      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C3：doc-plan --dir 前置 archive --drop、tdd 帮助词、approve 带 --spec 与 sandbox init 带 --agent（正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# dp-c3\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@dp.test' })
    try {
      // 1. --help 包含 tdd
      const help = await runAbsAsync(DP_SCRIPT, ['--help'], { cwd: dir })
      if (!help.stdout.includes('prd|spec|todo|tdd|pair|all')) {
        return `doc-plan --help 缺少 tdd 类型说明：\n${help.stdout}`
      }

      // 2. 反面：init 省略 --agent 在 multi-agent 模式仍拦截 INVALID_OWNER 且提示 --agent
      const noAgent = await runAbsAsync(DP_SCRIPT, ['init', '--kind', 'todo', '--slug', 'no-ag', '--title', 'No Agent', '--in-place', '--json'], { cwd: dir })
      if (noAgent.status !== EXIT.USAGE || !`${noAgent.stdout}${noAgent.stderr}`.includes('--agent')) {
        return `init 省略 --agent 未按 INVALID_OWNER 阻断或缺少 --agent 提示：exit=${noAgent.status} err=${noAgent.stderr}`
      }

      // 3. SPEC approve 的 nextStep 必须携带 --spec "<file>" 与 --agent
      const initSpec = await runAbsAsync(DP_SCRIPT, [
        'init', '--kind', 'spec', '--slug', 'spec-hint', '--title', 'Spec Hint', '--agent', 'arch-c3', '--in-place', '--json',
      ], { cwd: dir })
      if (initSpec.status !== 0) return `init spec 失败：${initSpec.stderr}`
      const specRel = JSON.parse(initSpec.stdout).file
      writeFileSync(join(dir, specRel), readFileSync(join(dir, specRel), 'utf8')
        .replace('<two-way | one-way>', 'two-way')
        .replace(/<[^>]+>/g, '`src/app.mjs` 真实设计')
        .replace(/^- \[ \] C1:.*$/m, '- [x] C1: `src/app.mjs` verified')
        .replace(/^- \[ \] C2:.*$/m, '- [x] C2: `src/app.mjs` verified'), 'utf8')
      await runAbsAsync(DP_SCRIPT, ['critique-pass', '--file', specRel, '--reviewer', 'critic-c3'], { cwd: dir })
      const appRes = await runAbsAsync(DP_SCRIPT, ['approve', '--file', specRel, '--json'], { cwd: dir })
      if (appRes.status !== 0) return `approve 失败：${appRes.stderr}`
      const appJson = JSON.parse(appRes.stdout)
      if (!appJson.nextStep?.includes(`--spec "${specRel}"`) || !appJson.nextStep?.includes('--agent')) {
        return `approve nextStep 缺少 --spec 或 --agent：${JSON.stringify(appJson.nextStep)}`
      }

      // 4. --dir 在 archive 之前时，--drop 必须正常归一化：无 --reason 报 MISSING_DROP_REASON，有 --reason 正常落 dropped
      const dropNoReason = await runAbsAsync(DP_SCRIPT, ['--dir', dir, 'archive', specRel, '--drop', '--json'])
      if (dropNoReason.status === 0 || !`${dropNoReason.stdout}${dropNoReason.stderr}`.includes('MISSING_DROP_REASON')) {
        return `--dir 前置 archive --drop 缺 --reason 未阻断：exit=${dropNoReason.status} out=${dropNoReason.stdout} err=${dropNoReason.stderr}`
      }
      const dropOk = await runAbsAsync(DP_SCRIPT, ['--dir', dir, 'archive', specRel, '--drop', '--reason', '方向已变更取消该方案', '--json'])
      if (dropOk.status !== 0) {
        return `--dir 前置 archive --drop --reason 失败：exit=${dropOk.status} err=${dropOk.stderr} out=${dropOk.stdout}`
      }

      // 5. evaluateNextState sandbox-needs-spec 命令携带 --agent
      const nxSb = evaluateNextState({
        selectedTask: { taskId: 'sb-x', slug: 'sb-x', sandboxMode: true, status: 'sandbox-needs-spec', pocStatus: 'needs-spec', worktreePath: '.worktrees/sandbox-sb-x' },
        taskRuntime: { dirty: 0, commitsAheadOfBase: 1, headSha: 'a'.repeat(40) },
      })
      if (!nxSb.command.includes('doc-plan.mjs') || !nxSb.command.includes('--agent')) {
        return `sandbox-needs-spec 命令缺少 --agent：${nxSb.command}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C4：claim 状态驱动 NEXT STEP、takeover 含 --agent、verify 视觉提示含 --artifact 与 submit claimedBy 溯源防绕过（正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c4-flow\n\n## Dev Profile\n```yaml\nquick-test: node -e "process.exit(0)"\nsmoke-verify: none\n```\n',
      'src/app.mjs': 'export const ok = 1\n',
      '.agents/skills/dev-edit/SKILL.md': '---\nname: dev-edit\ndescription: edit\n---\n',
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@c4.test' })
    try {
      const roots = await resolveRepoRoots(dir)
      // 1. claim 后 NEXT STEP 引导在 worktree 改码并跑 edit-gate，再 finalize/verify
      const todoInit = await runAbsAsync(DP_SCRIPT, [
        'init', '--kind', 'todo', '--slug', 'claim-next', '--title', 'Claim Next', '--agent', 'plan-c4', '--in-place', '--json',
      ], { cwd: dir })
      if (todoInit.status !== 0) return `init todo 失败：${todoInit.stderr}`
      const todoRel = JSON.parse(todoInit.stdout).file
      gitCommitFast(dir, 'docs: add claim-next todo')
      const stRes = await withQuietIo(() => handleStart({
        task: 't-claim-next', case: '3', slug: 'claim-next', todo: todoRel, agent: 'impl-c4',
        'no-issue': true, reason: '验证 claim 后状态驱动 NEXT STEP',
      }, roots))
      if (stRes.res.exitCode !== 0) return `start 失败：exit=${stRes.res.exitCode} err=${stRes.err} out=${stRes.out}`
      const clRes = await withQuietIo(() => handleClaim({ task: 't-claim-next', agent: 'impl-c4', json: true }, roots))
      if (clRes.res.exitCode !== 0) return `claim 失败：${clRes.err}`
      const clJson = JSON.parse(clRes.out)
      const nsStr = (clJson.nextSteps ?? []).join('\n')
      if (!nsStr.includes('edit-gate.mjs') || !nsStr.includes('.worktrees/impl-t-claim-next') || !nsStr.includes('finalize')) {
        return `claim nextSteps 未按工作位->edit-gate->finalize 引导：${JSON.stringify(clJson.nextSteps)}`
      }

      // 2. claim 冲突时 BLOCKED_ISSUE_ALREADY_CLAIMED 的 takeover nextStep 包含 --agent
      const { createGitHubClient } = await import('../../kit/skills/lib/shared.mjs')
      const ledger = readTaskLedger(dir, 't-claim-next')
      ledger.role = 'maintainer'
      ledger.providerId = 'github'
      ledger.linkedIssues = [77]
      writeTaskLedger(dir, ledger)
      gitSync(dir, ['remote', 'add', 'origin', 'https://github.com/acme/c4-repo.git'])
      const fakeGh = createGitHubClient({
        tier: 'gh-cli',
        login: 'me',
        runner: async (cmd, args) => {
          if (cmd === 'gh' && args[0] === 'api' && /issues\/77\/comments/.test(args[1] ?? '')) {
            return {
              ok: true, code: 0, stderr: '',
              stdout: JSON.stringify([{
                id: 1,
                user: { login: 'other-user' },
                body: '<!-- pf-state:{"action":"claim","agent":"impl-other","branch":"feat/x"} -->',
              }]),
            }
          }
          return { ok: true, code: 0, stdout: '[]', stderr: '' }
        },
      })
      const conflictRes = await withQuietIo(() => handleClaim({
        task: 't-claim-next', agent: 'impl-c4', json: true,
        _ghProbe: { env: { trackB: { login: 'me', tier: 'gh-cli' } }, client: fakeGh },
        _ghClient: fakeGh,
      }, roots))
      if (conflictRes.res.exitCode !== EXIT.FACT) return `claim 冲突应返回 EXIT.FACT：${conflictRes.res.exitCode}`
      const confJson = JSON.parse(conflictRes.out)
      if (!confJson.nextStep?.includes('--takeover') || !confJson.nextStep?.includes('--agent')) {
        return `claim 冲突 takeover nextStep 缺少 --agent：${JSON.stringify(confJson)}`
      }

      // 3. evaluateNextState needs-verify 在 visualCheckRequired=true 时包含 --artifact 与 --e2e-evidence，false 时不含 --artifact
      const nxVis = evaluateNextState({
        selectedTask: { taskId: 't-vis', caseType: 2, status: 'claimed', claimedAt: '2026-01-01', worktreePath: '.worktrees/impl-t-vis' },
        taskRuntime: {
          dirty: 0, commitsAheadOfBase: 1, headSha: 'b'.repeat(40),
          policy: { riskTier: 'medium', requiredGates: ['full'], smokeRequired: false, visualCheckRequired: true },
          evidenceValidation: { ok: false, code: 'BLOCKED_NOT_VERIFIED' },
        },
      })
      if (!nxVis.command.includes('--artifact') || !nxVis.command.includes('--e2e-evidence')) {
        return `visualCheckRequired=true 时 verify 命令缺少 --artifact/--e2e-evidence：${nxVis.command}`
      }
      const nxNoVis = evaluateNextState({
        selectedTask: { taskId: 't-novis', caseType: 2, status: 'claimed', claimedAt: '2026-01-01', worktreePath: '.worktrees/impl-t-novis' },
        taskRuntime: {
          dirty: 0, commitsAheadOfBase: 1, headSha: 'b'.repeat(40),
          policy: { riskTier: 'medium', requiredGates: ['full'], smokeRequired: false, visualCheckRequired: false },
          evidenceValidation: { ok: false, code: 'BLOCKED_NOT_VERIFIED' },
        },
      })
      if (nxNoVis.command.includes('--artifact')) {
        return `visualCheckRequired=false 时不应包含 --artifact：${nxNoVis.command}`
      }

      // 4. assertSubmitOwnership 在 claimedBy 匹配时仍须执行 checkProvenanceForSubmit（阻断同人规划实施）
      const specInit = await runAbsAsync(DP_SCRIPT, [
        'init', '--kind', 'spec', '--slug', 'prov-sub', '--title', 'Prov Sub', '--agent', 'same-author', '--in-place', '--json',
      ], { cwd: dir })
      const specFile = JSON.parse(specInit.stdout).file
      const badLedger = { taskId: 't-prov', caseType: 4, claimedBy: 'same-author', implementerId: 'same-author', specFile }
      const provBlocked = assertSubmitOwnership(badLedger, { agent: 'same-author' }, { mainRoot: dir, docRoot: dir })
      if (provBlocked.ok || provBlocked.code !== 'BLOCKED_AUTHOR_IS_IMPLEMENTER') {
        return `claimedBy 匹配时绕过了 submit 溯源校验：${JSON.stringify(provBlocked)}`
      }
      const goodLedger = { taskId: 't-prov', caseType: 4, claimedBy: 'other-impl', implementerId: 'other-impl', specFile }
      const provOk = assertSubmitOwnership(goodLedger, { agent: 'other-impl' }, { mainRoot: dir, docRoot: dir })
      if (!provOk.ok) {
        return `不同实施者应通过 submit 溯源校验：${JSON.stringify(provOk)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C5：iterate 默认分支动态解析、govern plan --write-todo 主干写护栏、equip 退出码文案与 SKILL 契约（正反双向）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c5-trunk\n\n## Dev Profile\n```yaml\nquick-test: node -e "process.exit(0)"\n```\n',
      'src/service.mjs': 'export function calc(x) { return x * 2 }\n',
    })
    gitInit(dir, { branch: 'trunk', name: 'dev', email: 'dev@c5.test' })
    try {
      // 1. iterate generate --write 在非 main/master 默认分支（trunk）有提交时必须阻断 BLOCKED_MAIN_SLOT_VIOLATION
      const itBlock = await runAbsAsync(IT_SCRIPT, ['generate', '--write', '--json'], { cwd: dir })
      if (itBlock.status !== EXIT.FACT || !`${itBlock.stdout}${itBlock.stderr}`.includes('BLOCKED_MAIN_SLOT_VIOLATION')) {
        return `iterate generate --write 在默认分支 trunk 未阻断：exit=${itBlock.status} out=${itBlock.stdout} err=${itBlock.stderr}`
      }

      // 2. govern-audit plan --write-todo 在默认分支 trunk 有提交且未传 --allow-main 时阻断，不写文件
      const gvBlock = await runAbsAsync(GV_SCRIPT, ['plan', '--write-todo', '--json'], { cwd: dir })
      if (gvBlock.status !== EXIT.FACT || !`${gvBlock.stdout}${gvBlock.stderr}`.includes('BLOCKED_MAIN_SLOT_VIOLATION')) {
        return `govern plan --write-todo 在默认分支 trunk 未阻断：exit=${gvBlock.status} out=${gvBlock.stdout} err=${gvBlock.stderr}`
      }
      if (existsSync(join(dir, 'docs/todo'))) {
        return 'govern plan --write-todo 被阻断后仍写入了 docs/todo'
      }

      // 3. 正面：切到特性分支后，iterate generate --write 与 govern plan --write-todo 均正常放行
      gitSync(dir, ['checkout', '-qb', 'feat/c5-work'])
      const itOk = await runAbsAsync(IT_SCRIPT, ['generate', '--write', '--json'], { cwd: dir })
      if (itOk.status !== 0) return `特性分支 iterate generate --write 失败：exit=${itOk.status} err=${itOk.stderr}`
      const gvOk = await runAbsAsync(GV_SCRIPT, ['plan', '--write-todo', '--json'], { cwd: dir })
      if (gvOk.status !== 0) return `特性分支 govern plan --write-todo 失败：exit=${gvOk.status} err=${gvOk.stderr}`

      // 4. equip --help 退出码文案为 3；SKILL.md 对齐 dev-iterate 默认 --escalate 行为
      const eqHelp = await runNode('equip.mjs', ['--help'])
      if (!eqHelp.stdout.includes('不一致退出码 3')) {
        return `equip --help 未将 --check 退出码更正为 3：\n${eqHelp.stdout}`
      }
      const skillText = readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')
      if (!skillText.includes('`run` 默认不自动建单、`cycle` 默认 `--escalate`')) {
        return 'SKILL.md 第 59 行未对齐 dev-iterate 的 run/cycle --escalate 默认行为'
      }
      return true
    } finally { rmTree(dir) }
  }])
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const cases = []
  registerRuntimeContractsCases(cases)
  let failed = 0
  for (const [name, fn] of cases) {
    const out = await fn()
    if (out === true) process.stdout.write(`PASS  ${name}\n`)
    else { failed += 1; process.stderr.write(`FAIL  ${name} —— ${out}\n`) }
  }
  process.stdout.write(`\nruntime-contracts 断言汇总：${cases.length - failed} 通过 / ${failed} 失败。\n`)
  await flushAndExit(failed === 0 ? 0 : 1)
}
