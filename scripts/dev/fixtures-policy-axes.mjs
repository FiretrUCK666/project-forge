/**
 * fixtures-policy-axes.mjs —— Wave 1 (`single-source-policy-core`) C1..C4 正反双向行为断言：
 *   - C1: 三轴正交策略（UI 视觉解耦 high/low、故障注入绑定 high/one-way/Case>=4、review-empirical 单源对齐与 smokeExplicitNone）
 *   - C2: 内外环证据隔离（inner:true 写入与外环顶层/单门禁硬拒 BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER）
 *   - C3: 六维干净 HEAD 回执缓存（单次 flow verify 架构图仅校验 1 次、headless 无 taskId 缓存、脏树/配置漂移失效、唯一生产者）
 *   - C4: 探索/内环/quick/沙箱静默防刷屏（保留本地诊断与信号，Mock 远端 createIssue=0；外环或 --escalate 正常建单）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { ARCHITECTURE_MAP_REL, renderArchitectureMapFromRepo } from '../../kit/skills/lib/architecture-map.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { readSignalsJsonl, resolveGovernStateDir } from '../../kit/skills/lib/signals.mjs'
import {
  determineWorkflowPolicy, readVerificationEvidence, validateVerificationEvidence,
} from '../../kit/skills/lib/workflow-policy.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { checkArchitectureMapSyncOnVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'
import {
  collectTaskRuntimeSnapshot, handleVerifyE2eFailure, recordVerifyEvidenceForFlow,
} from '../../kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs'
import { auditHygiene } from '../../kit/skills/dev-govern/scripts/govern-checks.mjs'
import { runIterationSuites } from '../../kit/skills/dev-iterate/scripts/iterate.mjs'
import { computeEmpiricalRequirements } from '../../kit/skills/dev-review/scripts/review-empirical.mjs'
import { handleEmpiricalE2eFailure } from '../../kit/skills/dev-review/scripts/review-empirical-state.mjs'
import { evaluatePassBlockers } from '../../kit/skills/dev-review/scripts/review-locks.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

function makeMockGhHarness() {
  let createIssueCalls = 0
  const created = []
  const client = {
    tier: 'node-https-token',
    createIssue: async (payload) => {
      createIssueCalls += 1
      const num = 900 + createIssueCalls
      created.push({ number: num, ...payload })
      return { ok: true, number: num, url: `https://github.com/acme/demo/issues/${num}` }
    },
    listIssues: async () => ({ ok: true, items: [] }),
    addLabels: async () => ({ ok: true }),
    ensureLabel: async () => ({ ok: true }),
  }
  const probe = {
    client,
    env: { providerId: 'github', trackB: { ok: true, tier: 'node-https-token', login: 'bot-dev' } },
  }
  return {
    get calls() { return createIssueCalls },
    created,
    client,
    probe,
  }
}

export function registerPolicyAxesCases(cases) {
  cases.push(['[Policy-C1] 三轴正交策略：UI 视觉解耦 high/low、高危故障注入绑定与 review-empirical 单源对齐', () => {
    // 1. UI-only (.tsx / .css) without high-risk/one-way/Case>=4 -> medium + visualCheckRequired=true + faultInjectionRequired=false
    const uiPol = determineWorkflowPolicy({
      changedFiles: ['src/components/Button.tsx', 'src/styles/theme.css'],
      caseType: 2,
      highRiskGlobs: ['src/auth/'],
      profile: { smokeVerify: 'node smoke.mjs' },
    })
    if (uiPol.riskTier !== 'medium' || uiPol.visualCheckRequired !== true || uiPol.faultInjectionRequired !== false) {
      return `UI-only 改动应为 medium + visualCheckRequired=true + faultInjectionRequired=false：${JSON.stringify(uiPol)}`
    }

    // 2. Pure HTML / SVG UI asset & explicit visual doc with Case 1 must NOT fall into low (isLow explicitly excludes effectiveVisual)
    for (const uiAsset of ['public/landing.html', 'src/components/icon.svg']) {
      const pAsset = determineWorkflowPolicy({ changedFiles: [uiAsset], caseType: 1 })
      if (pAsset.riskTier !== 'medium' || pAsset.visualCheckRequired !== true || pAsset.faultInjectionRequired !== false) {
        return `UI 视觉资产 ${uiAsset} 不得误跌入 low 或误抬入 high：${JSON.stringify(pAsset)}`
      }
    }
    const pVisualMd = determineWorkflowPolicy({ changedFiles: ['docs/ui-preview.md'], visualFilesChanged: ['docs/ui-preview.md'], caseType: 1 })
    if (pVisualMd.riskTier !== 'medium' || pVisualMd.visualCheckRequired !== true || pVisualMd.faultInjectionRequired !== false) {
      return `带视觉标记的文档不得误跌入 low（isLow 须排视觉）：${JSON.stringify(pVisualMd)}`
    }

    // 3. Pure non-executable doc -> low + visualCheckRequired=false + faultInjectionRequired=false
    const docPol = determineWorkflowPolicy({ changedFiles: ['docs/guide.md'], caseType: 2 })
    if (docPol.riskTier !== 'low' || docPol.visualCheckRequired !== false || docPol.faultInjectionRequired !== false) {
      return `纯文档改动应为 low + visual=false + fault=false：${JSON.stringify(docPol)}`
    }

    // 4. High-risk / one-way / Case>=4 -> high + faultInjectionRequired=true
    const hrPol = determineWorkflowPolicy({ changedFiles: ['src/auth/login.mjs'], caseType: 2, highRiskGlobs: ['src/auth/'] })
    const owPol = determineWorkflowPolicy({ changedFiles: ['db/migrations/001.sql'], caseType: 2 })
    const c4Pol = determineWorkflowPolicy({ changedFiles: ['src/util.mjs'], caseType: 4 })
    const uiHighPol = determineWorkflowPolicy({ changedFiles: ['src/App.tsx'], caseType: 2, highRiskGlobs: ['src/App.tsx'] })
    if (hrPol.riskTier !== 'high' || hrPol.faultInjectionRequired !== true) return `high-risk 未触发 faultInjectionRequired：${JSON.stringify(hrPol)}`
    if (owPol.riskTier !== 'high' || owPol.faultInjectionRequired !== true) return `one-way 未触发 faultInjectionRequired：${JSON.stringify(owPol)}`
    if (c4Pol.riskTier !== 'high' || c4Pol.faultInjectionRequired !== true) return `Case>=4 未触发 faultInjectionRequired：${JSON.stringify(c4Pol)}`
    if (uiHighPol.riskTier !== 'high' || uiHighPol.visualCheckRequired !== true || uiHighPol.faultInjectionRequired !== true) {
      return `命中 high-risk 的 UI 文件应同时满足 high + visual + fault：${JSON.stringify(uiHighPol)}`
    }

    // 5. review-empirical computeEmpiricalRequirements single-source parity + smokeExplicitNone
    const reqMed = computeEmpiricalRequirements({
      diff: { files: [{ file: 'src/app.mjs', status: 'M' }], untracked: [], bytes: 120 },
      behavioralGate: { runtimeFilesTouched: ['src/app.mjs'], smokeRequired: true, visualFilesChanged: [], empiricalVisualCheckRequired: false },
      effectiveProfile: { 'smoke-verify': ['node smoke.mjs'], 'high-risk': [] },
      task: { caseType: 2 },
    })
    if (reqMed.riskTier !== 'medium' || reqMed.faultRequired !== false) {
      return `普通 medium 运行时改动不应强制 faultRequired：${JSON.stringify(reqMed)}`
    }

    const reqUi = computeEmpiricalRequirements({
      diff: { files: [{ file: 'src/App.tsx', status: 'M' }], untracked: [], bytes: 120 },
      behavioralGate: { runtimeFilesTouched: ['src/App.tsx'], smokeRequired: true, visualFilesChanged: ['src/App.tsx'], empiricalVisualCheckRequired: true },
      effectiveProfile: { 'smoke-verify': ['node smoke.mjs'], 'high-risk': [] },
      task: { caseType: 2 },
    })
    if (reqUi.riskTier !== 'medium' || reqUi.visualCheckRequired !== true || reqUi.faultRequired !== false) {
      return `UI 改动 computeEmpiricalRequirements 应满足 medium + visual=true + fault=false：${JSON.stringify(reqUi)}`
    }

    const reqHigh = computeEmpiricalRequirements({
      diff: { files: [{ file: 'src/auth.mjs', status: 'M' }], untracked: [], bytes: 120 },
      behavioralGate: { runtimeFilesTouched: ['src/auth.mjs'], smokeRequired: true, visualFilesChanged: [], empiricalVisualCheckRequired: false },
      effectiveProfile: { 'smoke-verify': ['node smoke.mjs'], 'high-risk': ['src/auth.mjs'] },
      task: { caseType: 2 },
    })
    if (reqHigh.riskTier !== 'high' || reqHigh.faultRequired !== true) {
      return `高危运行时改动应触发 faultRequired=true：${JSON.stringify(reqHigh)}`
    }

    const reqHighSmokeNone = computeEmpiricalRequirements({
      diff: { files: [{ file: 'src/auth.mjs', status: 'M' }], untracked: [], bytes: 120 },
      behavioralGate: { runtimeFilesTouched: ['src/auth.mjs'], smokeRequired: false, visualFilesChanged: [], empiricalVisualCheckRequired: false },
      effectiveProfile: { 'quick-test': ['node --test'], 'high-risk': ['src/auth.mjs'], explicitNone: new Set(['smoke-verify']) },
      task: { caseType: 4 },
    })
    if (reqHighSmokeNone.faultRequired !== false) {
      return `smoke-verify: none 边界下 faultRequired 应与 review-locks 对齐返回 false：${JSON.stringify(reqHighSmokeNone)}`
    }
    return true
  }])

  cases.push(['[Policy-C2] 内外环证据硬隔离：inner:true 写入、外环硬拒顶层与单门禁偷渡、外环覆写放行', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c2\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
      'src/app.mjs': 'export const a = 1\n',
    })
    gitInit(dir, { branch: 'main' })
    try {
      const roots = await resolveRepoRoots(dir)
      const headSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const policy = determineWorkflowPolicy({
        changedFiles: ['src/app.mjs'],
        caseType: 2,
        profile: { fullTest: 'exit 0', smokeVerify: null, explicitNone: new Set(['smoke-verify']) },
      })
      const profile = { fullTest: 'exit 0', explicitNone: new Set(['smoke-verify']) }

      // 1. 内环/沙箱模式写入 inner: true
      recordVerifyEvidenceForFlow({
        roots,
        implRoot: dir,
        taskId: 't-inner',
        ledger: { taskId: 't-inner', baseSha: headSha, sandboxMode: true },
        profileKey: 'full-test',
        currentHead: headSha,
        dirty: false,
        policy,
        modeName: 'full',
        targetVal: null,
        cmdStr: 'exit 0',
        customCmd: false,
        exitCode: 0,
        explicitNoneSkipped: false,
        docStaticRes: null,
      })
      const evInner = readVerificationEvidence(roots.gitDir, 't-inner')
      if (evInner?.inner !== true || evInner?.gates?.full?.inner !== true) {
        return `内环实证未记录 inner:true：${JSON.stringify(evInner)}`
      }

      // 2. 外环默认硬拒顶层 inner: true
      const outerBlocked = validateVerificationEvidence({ policy, evidence: evInner, headSha, profile })
      if (outerBlocked.ok || outerBlocked.code !== 'BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER' || outerBlocked.exitCode !== EXIT.FACT) {
        return `外环未硬拒顶层 inner:true：${JSON.stringify(outerBlocked)}`
      }

      // 3. 伪造顶层 inner: false 但单门禁项夹带 inner: true 同样必须硬拒
      const smuggled = {
        ...evInner,
        inner: false,
        gates: { full: { ...evInner.gates.full, inner: true } },
      }
      const smuggledBlocked = validateVerificationEvidence({ policy, evidence: smuggled, headSha, profile })
      if (smuggledBlocked.ok || smuggledBlocked.code !== 'BLOCKED_INNER_EVIDENCE_FORBIDDEN_IN_OUTER' || smuggledBlocked.exitCode !== EXIT.FACT) {
        return `伪造顶层 inner:false 夹带单条 inner 门禁竟绕过拦截：${JSON.stringify(smuggledBlocked)}`
      }

      // 4. allowInner: true 内环自检放行
      const innerOk = validateVerificationEvidence({ policy, evidence: evInner, headSha, profile, allowInner: true })
      if (!innerOk.ok) return `allowInner:true 时内环实证应放行：${JSON.stringify(innerOk)}`

      // 5. 外环全量验证覆写为 inner: false 后正常放行
      recordVerifyEvidenceForFlow({
        roots,
        implRoot: dir,
        taskId: 't-inner',
        ledger: { taskId: 't-inner', baseSha: headSha, sandboxMode: false },
        profileKey: 'full-test',
        currentHead: headSha,
        dirty: false,
        policy,
        modeName: 'full',
        targetVal: null,
        cmdStr: 'exit 0',
        customCmd: false,
        exitCode: 0,
        explicitNoneSkipped: false,
        docStaticRes: null,
      })
      const evOuter = readVerificationEvidence(roots.gitDir, 't-inner')
      const outerPass = validateVerificationEvidence({ policy, evidence: evOuter, headSha, profile })
      if (evOuter?.inner !== false || !outerPass.ok) {
        return `外环覆写为 inner:false 后未放行：ev=${JSON.stringify(evOuter)} res=${JSON.stringify(outerPass)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['[Policy-C3] 六维干净 HEAD 门禁回执：单次校验去重、headless 缓存、脏树/漂移失效与唯一生产者', async () => {
    const gr = await import('../../kit/skills/lib/gate-receipt.mjs')
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': [
        '# c3-demo',
        '',
        '```yaml',
        'quick-test: exit 0',
        'full-test: exit 0',
        'smoke-verify: none',
        'merge-gate: exit 0',
        'arch-rules: src/a/** -> src/b/**',
        'high-risk: none',
        'do-not-edit: docs/archive/',
        '```',
        '',
      ].join('\n'),
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        domains: [{ id: 'core', name: 'Core', entrypoints: ['src/a/mod.mjs'] }],
        features: [{
          id: 'core-mod', name: 'Core Mod', domain: 'core',
          entrypoints: ['src/a/mod.mjs'], modules: ['src/a/mod.mjs'],
          businessFlows: ['run'], verificationTools: [], testRefs: [],
        }],
      }, null, 2),
      'src/a/mod.mjs': 'export const mod = () => 1\n',
      'src/b/secret.mjs': 'export const secret = () => 2\n',
    })
    const genRes = renderArchitectureMapFromRepo(dir)
    if (!genRes.ok) return `初始化架构图失败：${JSON.stringify(genRes)}`
    gitInit(dir, { branch: 'main' })
    try {
      const roots = await resolveRepoRoots(dir)
      const baseSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      gitSync(dir, ['checkout', '-b', 'feat/c3-receipt'])
      writeFileSync(join(dir, 'src/a/mod.mjs'), 'export const mod = () => 2\n', 'utf8')
      gitCommitFast(dir, 'feat: update mod')
      const headSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

      // 1. 脏树与 UNBORN 严禁生成有效键或写入回执
      const dirtyKey = gr.computeGateReceiptKey({ workTreeRoot: dir, dirty: true, headSha, baseSha, changedFiles: ['src/a/mod.mjs'], diffText: '' })
      const unbornKey = gr.computeGateReceiptKey({ workTreeRoot: dir, dirty: false, headSha: 'UNBORN', baseSha, changedFiles: [], diffText: '' })
      if (dirtyKey.valid || unbornKey.valid) return `脏树或 UNBORN 竟产出有效回执键：dirty=${JSON.stringify(dirtyKey)} unborn=${JSON.stringify(unbornKey)}`
      const refuseWrite = gr.writeGateReceipt({ gitCommonDir: roots.gitDir, taskId: 't-c3', key: dirtyKey, producer: 'edit-gate', checks: { archRules: { ok: true } } })
      if (refuseWrite !== null) return '脏树键竟允许写入回执'

      // 2. edit-gate --final 干净 HEAD 写入回执（仅 structuralHygiene/archRules/architectureMapSync，不伪造 gateWeakening）
      const eg = await runEditGate({ dir, task: 't-c3', mode: 'verify', final: true })
      if (!eg.ok) return `edit-gate --final 应通过：${JSON.stringify(eg.blockers)}`
      const taskRcptPath = gr.gateReceiptPath({ gitCommonDir: roots.gitDir, taskId: 't-c3', workTreeRoot: dir })
      if (!existsSync(taskRcptPath)) return `edit-gate --final 未写出任务回执：${taskRcptPath}`
      const savedTaskRcpt = JSON.parse(readFileSync(taskRcptPath, 'utf8'))
      if (!savedTaskRcpt.checks?.structuralHygiene?.ok || !savedTaskRcpt.checks?.archRules?.ok || !savedTaskRcpt.checks?.architectureMapSync?.ok) {
        return `任务回执缺少预期通过项：${JSON.stringify(savedTaskRcpt)}`
      }
      if (savedTaskRcpt.checks?.gateWeakening) {
        return `edit-gate 不得伪造 gateWeakening 回执：${JSON.stringify(savedTaskRcpt.checks)}`
      }

      // 3. checkArchitectureMapSyncOnVerify 在干净同 HEAD 下命中回执（跳过重复 verifyArchitectureMapSync）
      const ledger = { taskId: 't-c3', baseSha, baseBranch: 'main', caseType: 2, verifiedHead: headSha }
      const hookReuse = await checkArchitectureMapSyncOnVerify({ implRoot: dir, mainRoot: dir, gitDir: roots.gitDir, ledger })
      if (!hookReuse.ok || hookReuse.reason !== 'reused-gate-receipt') {
        return `同 HEAD verify 钩子未复用 architectureMapSync 回执：${JSON.stringify(hookReuse)}`
      }

      // 4. collectTaskRuntimeSnapshot 在干净 HEAD 产出 gateWeakening 回执；evaluatePassBlockers 可复用
      const snap = await collectTaskRuntimeSnapshot({ mainRoot: dir, gitDir: roots.gitDir, ledger, evaluateNext: false })
      if (snap.gateHits.length !== 0) return `干净任务误报 gateHits：${JSON.stringify(snap.gateHits)}`
      const savedAfterSnap = JSON.parse(readFileSync(taskRcptPath, 'utf8'))
      if (!savedAfterSnap.checks?.gateWeakening?.ok) {
        return `collectTaskRuntimeSnapshot 未落盘 gateWeakening 回执：${JSON.stringify(savedAfterSnap)}`
      }
      const passEval = await evaluatePassBlockers({
        mainRoot: dir, targetRoot: dir, gitDir: roots.gitDir, taskId: 't-c3', ledger, headSha, enforceGates: true,
      })
      if (passEval.blocked) return `干净合法任务 evaluatePassBlockers 误拦：${JSON.stringify(passEval)}`

      // 5. Headless 无 taskId 场景：cache/gate-receipt-<hash>.json 落盘与 govern-checks --changed 复用，全仓不复用
      const headlessPath = gr.gateReceiptPath({ gitCommonDir: roots.gitDir, taskId: null, workTreeRoot: dir })
      const egHeadless = await runEditGate({ dir, mode: 'standalone', changed: true, final: true })
      if (!egHeadless.ok || !existsSync(headlessPath)) {
        return `headless edit-gate 未产出 cache 回执：ok=${egHeadless.ok} path=${headlessPath}`
      }
      const changedFindings = []
      const hygChanged = await auditHygiene(dir, dir, true, [{ full: join(dir, 'src/a/mod.mjs'), rel: 'src/a/mod.mjs', name: 'mod.mjs', size: 28 }], 'main', { 'arch-rules': ['src/a/** -> src/b/**'] }, changedFindings, { changedFilesSet: new Set(['src/a/mod.mjs']) })
      if (!hygChanged.reusedGateReceipt?.structuralHygiene || !hygChanged.reusedGateReceipt?.archRules) {
        return `govern-checks --changed 未复用干净 HEAD 回执：${JSON.stringify(hygChanged.reusedGateReceipt)}`
      }
      const fullFindings = []
      const hygFull = await auditHygiene(dir, dir, true, [{ full: join(dir, 'src/a/mod.mjs'), rel: 'src/a/mod.mjs', name: 'mod.mjs', size: 28 }], 'main', { 'arch-rules': ['src/a/** -> src/b/**'] }, fullFindings, {})
      if (hygFull.reusedGateReceipt?.structuralHygiene || hygFull.reusedGateReceipt?.archRules) {
        return `全仓 audit 不得复用局部回执跳过全扫：${JSON.stringify(hygFull.reusedGateReceipt)}`
      }

      // 6. 工作树变脏或架构图漂移立即失效重扫并捕获 BLOCKED_ARCHITECTURE_MAP_DRIFT
      const origHtml = readFileSync(join(dir, ARCHITECTURE_MAP_REL), 'utf8')
      writeFileSync(join(dir, ARCHITECTURE_MAP_REL), origHtml.replace(/[0-9a-f]{64}/i, '0'.repeat(64)), 'utf8')
      const driftCheck = await checkArchitectureMapSyncOnVerify({ implRoot: dir, mainRoot: dir, gitDir: roots.gitDir, ledger })
      if (driftCheck.ok || driftCheck.code !== 'BLOCKED_ARCHITECTURE_MAP_DRIFT') {
        return `架构图漂移后回执未失效或未拦截 BLOCKED_ARCHITECTURE_MAP_DRIFT：${JSON.stringify(driftCheck)}`
      }
      writeFileSync(join(dir, ARCHITECTURE_MAP_REL), origHtml, 'utf8')

      // 7. AGENTS.md 配置变化后 profileHash 改变，回执立即失效
      writeFileSync(join(dir, 'AGENTS.md'), readFileSync(join(dir, 'AGENTS.md'), 'utf8') + '\n<!-- rule-change -->\n', 'utf8')
      gitCommitFast(dir, 'chore: change agents')
      const afterCfgChange = await checkArchitectureMapSyncOnVerify({ implRoot: dir, mainRoot: dir, gitDir: roots.gitDir, ledger })
      if (afterCfgChange.reason === 'reused-gate-receipt') {
        return `AGENTS.md 与 HEAD 变化后仍错误复用了旧回执：${JSON.stringify(afterCfgChange)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['[Policy-C4] 探索/内环/quick/沙箱静默防刷屏，保留诊断与信号，外环阻断与 --escalate 正常建单', async () => {
    const { shouldAutoEscalateFailure } = await import('../../kit/skills/lib/gate-receipt.mjs')
    // 1. 策略矩阵正反断言
    if (shouldAutoEscalateFailure({ stage: 'verify', mode: 'smoke', ledger: { sandboxMode: true }, opts: { escalate: true } }).escalate !== false) {
      return 'sandboxMode=true 时即使传 escalate 也不得自动刷远端工单'
    }
    if (shouldAutoEscalateFailure({ stage: 'verify', mode: 'smoke', opts: { inner: true } }).escalate !== false) {
      return 'inner=true 时不得自动建单'
    }
    if (shouldAutoEscalateFailure({ stage: 'verify', mode: 'quick' }).escalate !== false) {
      return 'verify quick 模式不得自动建单'
    }
    if (shouldAutoEscalateFailure({ stage: 'review', mode: 'local' }).escalate !== false) {
      return 'review local 模式不得自动建单'
    }
    if (shouldAutoEscalateFailure({ stage: 'iterate', mode: 'run' }).escalate !== false) {
      return 'iterate run 默认应静默不建单'
    }
    if (shouldAutoEscalateFailure({ stage: 'iterate', mode: 'run', opts: { escalate: true } }).escalate !== true) {
      return 'iterate run 显式 --escalate 应开启建单'
    }
    if (shouldAutoEscalateFailure({ stage: 'verify', mode: 'smoke', ledger: { sandboxMode: false } }).escalate !== true) {
      return '外环 verify smoke 失败应正常触发建单'
    }
    if (shouldAutoEscalateFailure({ stage: 'review', mode: 'task', ledger: { sandboxMode: false } }).escalate !== true) {
      return '外环 review task 失败应正常触发建单'
    }

    // 2. Mock 远端实测：内环/沙箱/local/iterate 默认 createIssue === 0 且保留诊断与信号；外环与 --escalate createIssue === 1
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': JSON.stringify({ name: 'c4-silent', type: 'module' }, null, 2),
      'src/app.mjs': 'export const ok = () => false\n',
      'test/fail.test.mjs': "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('fail', () => { assert.equal(1, 2) })\n",
    })
    gitInit(dir, { branch: 'main', origin: 'https://github.com/acme/demo.git' })
    try {
      const roots = await resolveRepoRoots(dir)
      const headSha = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

      // 2a. flow-lifecycle-helpers handleVerifyE2eFailure: sandbox/quick -> 0 calls; outer smoke -> 1 call
      const ghV = makeMockGhHarness()
      const sandFail = await handleVerifyE2eFailure({
        roots, taskId: 't-sand', ledger: { taskId: 't-sand', caseType: 2, sandboxMode: true },
        mode: 'smoke', cmd: 'node smoke.mjs', runRes: { code: 2, stdout: '', stderr: 'boom' },
        currentHead: headSha, changedFiles: ['src/app.mjs'], opts: { _ghProbe: ghV.probe, _ghClient: ghV.client },
      })
      const quickFail = await handleVerifyE2eFailure({
        roots, taskId: 't-q', ledger: { taskId: 't-q', caseType: 2, sandboxMode: false },
        mode: 'quick', cmd: 'node test/fail.test.mjs', runRes: { code: 1, stdout: '', stderr: 'fail' },
        currentHead: headSha, changedFiles: ['src/app.mjs'], opts: { _ghProbe: ghV.probe, _ghClient: ghV.client },
      })
      if (ghV.calls !== 0 || !sandFail.diagnostic?.Evidence?.length || !quickFail.diagnostic?.Evidence?.length) {
        return `沙箱/quick verify 失败竟调用了远端 createIssue (${ghV.calls}) 或丢了诊断包`
      }
      const outerFail = await handleVerifyE2eFailure({
        roots, taskId: 't-out', ledger: { taskId: 't-out', caseType: 2, sandboxMode: false },
        mode: 'smoke', cmd: 'node smoke.mjs', runRes: { code: 2, stdout: '', stderr: 'outer boom' },
        currentHead: headSha, changedFiles: ['src/app.mjs'], opts: { _ghProbe: ghV.probe, _ghClient: ghV.client },
      })
      if (ghV.calls !== 1 || !outerFail.escalation?.ok) {
        return `外环 verify smoke 失败未按分级策略建单：calls=${ghV.calls} esc=${JSON.stringify(outerFail.escalation)}`
      }

      // 2b. review-empirical-state handleEmpiricalE2eFailure: local -> 0 calls; outer task -> 1 call
      const ghR = makeMockGhHarness()
      const localRevFail = await handleEmpiricalE2eFailure({
        mainRoot: dir, gitDir: roots.gitDir, task: null, mode: 'local',
        failedCmdRes: { cmd: 'node test/fail.test.mjs', exitCode: 1, stdoutExcerpt: '', stderrExcerpt: 'fail' },
        headSha, changedFiles: ['src/app.mjs'], opts: { _ghProbe: ghR.probe, _ghClient: ghR.client },
      })
      if (ghR.calls !== 0 || !localRevFail.diagnostic?.Evidence?.length) {
        return `review local 失败竟调用了远端 createIssue (${ghR.calls}) 或丢了诊断包`
      }
      const taskRevFail = await handleEmpiricalE2eFailure({
        mainRoot: dir, gitDir: roots.gitDir, task: { taskId: 't-rev', caseType: 3, sandboxMode: false }, mode: 'task',
        failedCmdRes: { cmd: 'node test/fail.test.mjs', exitCode: 1, stdoutExcerpt: '', stderrExcerpt: 'task fail' },
        headSha, changedFiles: ['src/app.mjs'], opts: { _ghProbe: ghR.probe, _ghClient: ghR.client },
      })
      if (ghR.calls !== 1 || !taskRevFail.escalation?.ok) {
        return `外环 review task 失败未正常建单：calls=${ghR.calls} esc=${JSON.stringify(taskRevFail.escalation)}`
      }

      // 2c. iterate runIterationSuites: default silent (0 calls + signal written) vs explicit escalate:true (1 call)
      const ghI = makeMockGhHarness()
      const iterSilent = await runIterationSuites(dir, {
        targets: ['test/fail.test.mjs'], writeSignals: true, isGit: true, gitDir: roots.gitDir,
        _ghProbe: ghI.probe, _ghClient: ghI.client,
      })
      if (ghI.calls !== 0 || iterSilent.escalations.length !== 0 || iterSilent.signalsWritten < 1) {
        return `iterate 默认应静默建单但写信号：calls=${ghI.calls} esc=${iterSilent.escalations.length} sigs=${iterSilent.signalsWritten}`
      }
      const iterEsc = await runIterationSuites(dir, {
        targets: ['test/fail.test.mjs'], escalate: true, writeSignals: false, isGit: true, gitDir: roots.gitDir,
        _ghProbe: ghI.probe, _ghClient: ghI.client,
      })
      if (ghI.calls !== 1 || iterEsc.escalations.length !== 1) {
        return `iterate 显式 escalate:true 未建单：calls=${ghI.calls} esc=${JSON.stringify(iterEsc.escalations)}`
      }

      // 2d. 本地 signals.jsonl 保留记录 + iterate --help 文案对齐
      const sigs = readSignalsJsonl(resolveGovernStateDir(dir, roots.gitDir, true))
      if (!sigs.events.some((e) => e.pattern === 'e2e.runtime-fail') || !sigs.events.some((e) => e.source === 'dev-iterate')) {
        return `静默模式下本地 signals.jsonl 缺失记录：${JSON.stringify(sigs.events.map((e) => e.pattern))}`
      }
      const helpRes = await runAbsAsync('kit/skills/dev-iterate/scripts/iterate.mjs', ['--help'], { cwd: dir })
      if (helpRes.status !== 0 || helpRes.stdout.includes('默认开启') || !helpRes.stdout.includes('默认静默')) {
        return `iterate.mjs --help 帮助文案未同步更新默认静默说明：\n${helpRes.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
