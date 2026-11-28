/**
 * flow-sandbox.mjs —— 隔离沙箱工作树启动（start --sandbox）、内环/外环边界守卫与真实差分晋升流水线（promote）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层/lib 模块），保持紧文件 <= 800 行。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasSkillSupport, printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { formatConcurrencyRadarLines, projectConcurrencyRadar } from '../../lib/concurrency-radar.mjs'
import { parseDocFrontmatter } from '../../lib/docs.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import {
  ensureWorktreesIgnored, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ, posixPath, readTextSafe,
} from '../../lib/git.mjs'
import { readGitConfigFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { isNonImplRoleActor, isValidActorName } from '../../lib/harness-context.mjs'
import {
  createDefaultLedger, createExploredEvidence, readTaskLedger, recordMountedDepsInLedger,
  resolveTaskContext, updateTaskLedger,
} from '../../lib/ledger.mjs'
import { indexPlanDocs } from '../../lib/plan-index.mjs'
import {
  detectDeclaredRepo, parseIssueNumbers, parseRemoteUrls,
} from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import {
  isInnerVerifyMode, normalizeWriteScope, registerImplementer,
} from '../../lib/sandbox-scope.mjs'
import {
  CODE_EXT_RE, TEST_FILE_RE, detectGateWeakening, gitDiffRawEntriesAndText, isUiVisualFile,
} from '../../lib/static-gates.mjs'
import { checkTddSyncParity } from '../../lib/tdd-parity.mjs'
import {
  determineWorkflowPolicy, hasRepoCiWorkflow, resolveEffectiveBaseSha,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, resolveAndHydrateTaskContexts } from './flow-context.mjs'
import {
  checkStartMainCleanAndSlot, emitBlockedStart, evaluateIssueBindingExemption,
  inheritExploredCredentials, resolveOrBindStartIssue, resolveStartIdentity,
} from './flow-start-helpers.mjs'
import { mountSharedDeps } from './worktree-deps.mjs'

const DOMAIN_CONTAINER_DIRS = new Set([
  'src', 'lib', 'packages', 'apps', 'services', 'backend', 'frontend', 'modules', 'cmd', 'internal',
])

function emitBlockedSandbox(opts, roots, payload, nextSteps = []) {
  const msg = `${payload.code}: ${payload.reason}`
  const body = { ok: false, blocked: true, ...payload }
  if (opts.json) {
    const out = nextSteps.length > 0 ? withNextSteps(body, nextSteps, { repoRoot: roots?.mainRoot }) : body
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  }
  process.stderr.write(`${msg}\n`)
  if (!opts.json && nextSteps.length > 0) printNextStep(nextSteps, { repoRoot: roots?.mainRoot })
  return { ok: false, blocked: true, code: payload.code, exitCode: payload.exitCode ?? EXIT.FACT, reason: payload.reason }
}

/** 拦截未晋升沙箱执行 finalize / submit / merge，杜绝提前归档或绕过外环合入。 */
export function guardSandboxPreSubmitOrFinalize(ledger, opts = {}, stage = 'submit') {
  if (ledger?.sandboxMode !== true) return { ok: true }
  const code = 'BLOCKED_SANDBOX_PROMOTE_REQUIRED'
  const reason = `任务 ${ledger.taskId} 仍处于隔离沙箱态（status=${ledger.status ?? 'sandbox-iterating'}），禁止直接执行 ${stage}；请先提交沙箱改动并运行 flow.mjs promote --task ${ledger.taskId} 晋升至外环。`
  const nextCmd = `node ".agents/skills/dev-flow/scripts/flow.mjs" promote --task ${ledger.taskId}`
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps({
      ok: false, blocked: true, code, taskId: ledger.taskId, stage, reason,
    }, [{ skill: 'dev-flow', text: nextCmd }]), null, 2)}\n`)
  }
  process.stderr.write(`${code}: ${reason}\n`)
  return { ok: false, blocked: true, code, exitCode: EXIT.FACT, reason }
}

/** 解析 verify 阶段的内环标志与账本回写状态（沙箱内环保活沙箱态，不误覆写为外环 verified）。 */
export function resolveSandboxVerifyMode(ledger, opts = {}) {
  const inner = isInnerVerifyMode(ledger, { ...opts, _stage: 'verify' })
  const nextStatus = (allOk, dirty) => {
    if (ledger?.sandboxMode === true) {
      if (ledger.status === 'sandbox-needs-spec') return 'sandbox-needs-spec'
      return allOk && !dirty ? 'sandbox-ready-to-promote' : 'sandbox-iterating'
    }
    return allOk ? 'verified' : 'verify-failed'
  }
  return { inner, nextStatus }
}

async function resolveSandboxBaseRef(opts, roots, state) {
  let baseBranch = state.defaultBranch ?? (state.commits === 0 && state.branch && state.branch !== '(detached)' ? state.branch : null)
  let baseSha = state.head
  const explicitBase = String(opts.base ?? '').trim()
  if (explicitBase) {
    let found = false
    for (const cand of [`refs/heads/${explicitBase}`, `refs/remotes/origin/${explicitBase}`, explicitBase]) {
      const sha = resolveRefShaFast(roots.gitDir, cand)
      if (sha) { baseBranch = explicitBase; baseSha = sha; found = true; break }
      const r = await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', cand])
      if (r.ok && r.stdout.trim()) { baseBranch = explicitBase; baseSha = r.stdout.trim(); found = true; break }
    }
    if (!found) throw new Error(`--base 指定的分支不存在：${explicitBase}`)
  } else if (!baseBranch && state.commits > 0) {
    return { ok: false, code: 'BLOCKED_MISSING_DEFAULT_BRANCH', exitCode: EXIT.FACT, reason: '找不到可用默认分支，请先检出默认分支或显式传入 --base。' }
  } else if (state.commits > 0 && !(state.branch === baseBranch && state.head)) {
    for (const candRef of [`refs/heads/${baseBranch}`, `refs/remotes/origin/${baseBranch}`]) {
      const fastSha = resolveRefShaFast(roots.gitDir, candRef)
      if (fastSha) { baseSha = fastSha; break }
      const r = await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', candRef])
      if (r.ok && r.stdout.trim()) { baseSha = r.stdout.trim(); break }
    }
  }
  return { ok: true, baseBranch, baseSha }
}

/** 处理 `flow.mjs start --sandbox`：创建/复用 `.worktrees/sandbox-<id>/`、多代理写域登记与双向 Issue 优先级。 */
export async function handleSandboxStart({
  opts, roots, state, taskId, slug, role, providerId, linkedIssues = [],
}) {
  const { startIdentity, implementerId } = resolveStartIdentity({ isPlanning: false, state, opts })
  const explicitActor = opts.agent ?? opts.implementer
  const effectiveActor = explicitActor !== undefined ? explicitActor : implementerId
  const writeScope = normalizeWriteScope(opts['write-scope'])
  const now = new Date().toISOString()

  const existing = readTaskLedger(roots.mainRoot, taskId)
  if (
    existing
    && existing.status !== 'cleaned'
    && existing.status !== 'aborted'
    && existing.sandboxMode === true
    && existing.worktreePath
    && existsSync(join(roots.mainRoot, existing.worktreePath))
  ) {
    const reg = registerImplementer(existing, { actor: effectiveActor, writeScope, phase: 'sandbox' })
    if (!reg.ok) return emitBlockedStart(opts, reg)
    if (linkedIssues.length > 0) {
      existing.linkedIssues = [...new Set([...(existing.linkedIssues ?? []), ...linkedIssues])]
      if (existing.issueBinding?.mode !== 'reused') {
        existing.issueBinding = { mode: 'reused', source: 'args', issues: [...existing.linkedIssues], at: now }
      }
    }
    await updateTaskLedger(roots.mainRoot, existing.taskId, (cur) => ({ ...(cur ?? existing), ...existing }), { createIfMissing: true })
    const reuseSteps = [
      { skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId} --inner` },
      { skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" promote --task ${taskId}` },
    ]
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(withNextSteps({ ...existing, registeredImplementer: reg.actor, writeScope: reg.writeScope }, reuseSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    } else {
      process.stdout.write(`沙箱任务 ${taskId} 已登记实施者 ${reg.actor}（writeScope=${reg.writeScope.join(',') || '**'}，共 ${existing.implementers.length} 人）。\n`)
      printNextStep(reuseSteps, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  const slotChk = await checkStartMainCleanAndSlot(roots.mainRoot, {
    caseType: Math.max(2, Number(opts.case ?? 3)),
    commits: state.commits,
    creatingIsolatedWorktree: true,
  })
  if (!slotChk.ok) return emitBlockedStart(opts, slotChk)
  if (Number(state.commits ?? 0) <= 0) {
    return emitBlockedStart(opts, {
      code: 'BLOCKED_MAIN_SLOT_VIOLATION',
      exitCode: EXIT.FACT,
      reason: '仓库尚无初始提交，无法创建隔离沙箱工作树（请先提交初始 commit）。',
    })
  }

  const probeReg = registerImplementer({ implementers: [] }, { actor: effectiveActor, writeScope, phase: 'sandbox' })
  if (!probeReg.ok) return emitBlockedStart(opts, probeReg)

  const baseInfo = await resolveSandboxBaseRef(opts, roots, state)
  if (!baseInfo.ok) return emitBlockedStart(opts, baseInfo)
  const { baseBranch, baseSha } = baseInfo

  await ensureWorktreesIgnored(roots.mainRoot, roots.gitDir)
  const branch = opts.branch ? String(opts.branch).trim() : `sandbox/${slug}`
  const sandboxRel = `.worktrees/sandbox-${taskId}`
  const reviewRel = `.worktrees/review-${taskId}`
  const sandboxAbs = join(roots.mainRoot, sandboxRel)

  if (!existsSync(sandboxAbs)) {
    const checkedOutAt = (state.worktrees ?? []).find((w) => w.branch === branch)
    if (checkedOutAt) {
      const msg = `BLOCKED_BRANCH_IN_USE: 分支 ${branch} 已在工作树 ${checkedOutAt.path} 检出，请传入 --branch <新分支名> 或清理原工作树。`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_BRANCH_IN_USE', branch, checkedOutAt: checkedOutAt.path }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT }
    }
    const hasBranch = Boolean(resolveRefShaFast(roots.gitDir, `refs/heads/${branch}`))
      || (await gitRun(roots.mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).ok
    const addArgs = hasBranch ? ['worktree', 'add', sandboxAbs, branch] : ['worktree', 'add', '-b', branch, sandboxAbs, baseSha]
    const wtRes = await gitRun(roots.mainRoot, addArgs)
    if (!wtRes.ok) throw new Error(`创建隔离沙箱 worktree 失败：${wtRes.stderr}`)
  }

  const depMount = mountSharedDeps(roots.mainRoot, sandboxAbs)
  let issueBinding
  if (linkedIssues.length > 0) {
    issueBinding = { mode: 'reused', source: 'args', issues: [...linkedIssues], at: now }
  } else {
    const ex = evaluateIssueBindingExemption({
      mainRoot: roots.mainRoot,
      caseType: Number(opts.case ?? 3),
      role,
      opts: { ...opts, sandbox: true },
      implementerId: probeReg.actor,
    })
    issueBinding = {
      mode: 'exempt',
      exemptKind: ex.exempt ? ex.exemptKind : 'sandbox',
      reason: ex.reason ?? '沙箱探索阶段暂不强制建单',
      at: now,
    }
  }

  let hydrated = { issueContext: [], issueContextUnavailable: [], prContext: null, prContextUnavailable: null, prPatch: {} }
  if (linkedIssues.length > 0) {
    const { targetRepo } = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, null, { cwd: roots.mainRoot, providerHint: providerId })
    hydrated = await resolveAndHydrateTaskContexts({
      mainRoot: roots.mainRoot, gitDir: roots.gitDir, remoteUrls: state.remoteUrls ?? {},
      providerId, role, targetRepo, issueNumbers: linkedIssues, prNumber: null, opts,
    })
  }

  const ledger = createDefaultLedger({
    taskId,
    slug,
    caseType: Number(opts.case ?? 3),
    tier: 2,
    isolation: 'worktree',
    role,
    providerId,
    branch,
    baseBranch,
    baseSha,
    worktreePath: sandboxRel,
    sandboxWorktreePath: sandboxRel,
    reviewWorktreePath: reviewRel,
    depsMode: depMount.mode,
    todoFile: opts.todo ?? null,
    specFile: opts.spec ?? null,
    prdFile: opts.prd ?? null,
    linkedIssues: [...linkedIssues],
    issueBinding,
    implementerId: probeReg.actor,
    account: startIdentity.account,
    verifiedPlatformLogin: startIdentity.verifiedPlatformLogin,
    agent: probeReg.actor,
    implementers: probeReg.implementers,
    sandboxMode: true,
    promotedFromSandbox: false,
    promotedAt: null,
    pocStatus: null,
    status: 'sandbox-iterating',
    issueContext: hydrated.issueContext,
    issueContextUnavailable: hydrated.issueContextUnavailable,
    prContext: hydrated.prContext,
    prContextUnavailable: hydrated.prContextUnavailable,
    ...hydrated.prPatch,
  })
  recordMountedDepsInLedger(ledger, sandboxRel, depMount)
  await updateTaskLedger(roots.mainRoot, ledger.taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  const nextSteps = [
    { skill: 'dev-flow', text: `1. 在 ${sandboxRel} 高频试错并运行内环快检：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId} --inner` },
    { skill: 'dev-flow', text: `2. 收敛提交后按真实 diff 晋升：node ".agents/skills/dev-flow/scripts/flow.mjs" promote --task ${taskId}` },
  ]
  const sbRadar = projectConcurrencyRadar(roots.mainRoot, { currentTaskId: taskId, currentWorkRoot: sandboxAbs, currentWriteScope: writeScope, baseBranch, baseSha })
  const sbWarnings = [...(slotChk.dirtyMainWarning ? [slotChk.dirtyMainWarning] : []), ...(sbRadar.warnings ?? [])]
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps({ ...ledger, depsMount: depMount, concurrencyRadar: sbRadar, ...(sbWarnings.length > 0 ? { warnings: sbWarnings } : {}) }, nextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(`隔离沙箱任务 ${taskId} 已就绪：\n`)
    process.stdout.write(`- 沙箱工作位: ${sandboxRel}（分支: ${branch}，依赖模式: ${depMount.mode}）\n`)
    process.stdout.write(`- 实施者: ${probeReg.actor}（writeScope=${probeReg.writeScope.join(',') || '**'}） | 工单绑定: ${issueBinding.mode}${issueBinding.exemptKind ? `(${issueBinding.exemptKind})` : ''}\n`)
    for (const w of sbWarnings) process.stdout.write(`- [提醒] ${w.message}\n`)
    for (const rl of formatConcurrencyRadarLines(sbRadar)) process.stdout.write(`${rl}\n`)
    printNextStep(nextSteps, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}

function collectCoreSourceDomains(changedFiles = []) {
  const domains = new Set()
  for (const raw of changedFiles) {
    const f = posixPath(raw).replace(/^\.\//, '')
    if (!f || !CODE_EXT_RE.test(f) || TEST_FILE_RE.test(f) || /^(?:docs|\.worktrees|\.agents)\//.test(f)) continue
    const segs = f.split('/').filter(Boolean)
    if (segs.length >= 3 && segs[0] === 'kit' && segs[1] === 'skills') {
      domains.add(`kit/skills/${segs[2]}`)
    } else if (segs.length >= 2 && DOMAIN_CONTAINER_DIRS.has(segs[0].toLowerCase())) {
      domains.add(`${segs[0]}/${segs[1]}`)
    } else if (segs.length >= 1) {
      domains.add(segs[0])
    }
  }
  return [...domains].sort()
}

function diffTouchesExportContract(diffText, parity) {
  if ((parity?.changedExportsOrCli?.length ?? 0) > 0) return true
  if (typeof diffText !== 'string' || !diffText) return false
  return /^[+-](?![+-]{2})\s*(?:export\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+|pub\s+(?:fn|struct|enum|trait)\s+)/m.test(diffText)
}

function pickPrimaryImplementer(ledger, opts = {}) {
  const candidates = [
    opts.agent,
    opts.implementer,
    ledger?.implementerId,
    ...(Array.isArray(ledger?.implementers) ? ledger.implementers.map((x) => (typeof x === 'string' ? x : x?.actor)) : []),
    ledger?.claimedBy,
    ledger?.agent,
  ]
  for (const cand of candidates) {
    if (!isValidActorName(cand)) continue
    const clean = String(cand).trim()
    if (clean === 'local-agent' || isNonImplRoleActor(clean)) continue
    return clean
  }
  return (ledger?.implementerId && isValidActorName(ledger.implementerId)) ? String(ledger.implementerId).trim() : 'sandbox-implementer'
}

/** 基于真实 `git diff <baseRef>...HEAD` 合成满足 `validateIssueBodyQuality` 五项结构底线的合规 Issue 正文。 */
export async function synthesizeIssueBodyFromDiff({
  workRoot, effectiveBase, currentHead, changedFiles = [], policy, resolvedCase, taskId, slug, baseBranch = 'main',
}) {
  const logRes = effectiveBase
    ? await gitRun(workRoot, ['log', '--format=%s', `${effectiveBase}..HEAD`])
    : { ok: false, stdout: '' }
  const subjects = (logRes.ok ? logRes.stdout : '').split('\n').map((s) => s.trim()).filter(Boolean)
  const primaryTitle = subjects[0] || slug || taskId
  const filesPreview = changedFiles.slice(0, 10).map((f) => `\`${f}\``).join('、')
  const riskLabel = policy?.riskTier ?? 'medium'
  const shortBase = String(effectiveBase ?? '').slice(0, 7) || baseBranch
  const shortHead = String(currentHead ?? '').slice(0, 7) || 'HEAD'

  const criteriaLines = [
    `- [ ] C1: 确认沙箱改动（${changedFiles.slice(0, 5).map((f) => `\`${f}\``).join('、')}）在目标基线 \`${baseBranch}\` 通过外环 \`flow.mjs verify\` 实证与独立审查。`,
  ]
  if (policy?.visualCheckRequired && (policy.visualFilesChanged?.length ?? 0) > 0) {
    criteriaLines.push(`- [ ] C2: 视觉/UI 文件（${policy.visualFilesChanged.slice(0, 4).map((f) => `\`${f}\``).join('、')}）完成真实渲染与交互状态核验。`)
  }

  const body = [
    '## 背景与现象',
    '',
    `任务 \`${taskId}\`（Case ${resolvedCase}）在隔离沙箱完成迭代并提交（\`${shortBase}..${shortHead}\`），核心提交：${subjects.slice(0, 5).join('；') || primaryTitle}。`,
    '',
    '## 影响面与严重度',
    '',
    `- 影响路径：${filesPreview}`,
    `- severity=${riskLabel}；visualCheckRequired=${Boolean(policy?.visualCheckRequired)}；smokeRequired=${Boolean(policy?.smokeRequired)}；仅限上述局部改动，不涉及鉴权、数据迁移或破坏性公共契约变更。`,
    '',
    '## 期望与方案',
    '',
    `基于真实 diff（\`git diff ${shortBase}...${shortHead}\`）将沙箱改动原位晋升至外环实施态，随后在 \`${baseBranch}\` 基线上完成外环验证、独立审查与合入。`,
    '',
    '## 验收标准',
    '',
    ...criteriaLines,
    '',
    '## 不在本次范围',
    '',
    `- 不修改本次沙箱提交 diff（${changedFiles.slice(0, 5).map((f) => `\`${f}\``).join('、')}）之外的无关模块，不引入第三方依赖或跨模块重构。`,
  ].join('\n')

  return { title: primaryTitle, body }
}

/** 处理 `flow.mjs promote --task <id>`：基于真实 `git diff <baseRef>...HEAD` 的确定性晋升分类器。 */
export async function handlePromote(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx

  if (ledger.sandboxMode !== true) {
    return emitBlockedSandbox(opts, roots, {
      code: 'BLOCKED_NOT_SANDBOX_TASK',
      exitCode: EXIT.FACT,
      taskId,
      reason: `任务 ${taskId} 当前不处于隔离沙箱态（sandboxMode=false），无需或不支持 promote。`,
    })
  }

  const workRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(workRoot)) throw new Error(`沙箱工作树目录不存在：${workRoot}`)

  const stZ = await gitStatusPorcelainZ(workRoot)
  if ((stZ.entries?.length ?? 0) > 0) {
    return emitBlockedSandbox(opts, roots, {
      code: 'BLOCKED_DIRTY_WORKTREE',
      exitCode: EXIT.FACT,
      taskId,
      dirtyCount: stZ.entries.length,
      reason: `沙箱工作树（${ledger.worktreePath ?? workRoot}）存在 ${stZ.entries.length} 处未提交改动，请先 commit 后再执行 flow.mjs promote。`,
    })
  }

  const effectiveBase = await resolveEffectiveBaseSha(workRoot, ledger, { gitCommonDir: roots.gitDir })
  const headRes = await gitRun(workRoot, ['rev-parse', 'HEAD'])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  const rangeSpec = effectiveBase ? `${effectiveBase}...HEAD` : null
  const diffNs = rangeSpec ? await gitDiffNameStatusZ(workRoot, [rangeSpec]) : { ok: false, entries: [] }
  const diffEntries = diffNs.ok ? (diffNs.entries ?? []) : []
  const changedFiles = [...new Set(
    diffEntries.map((e) => posixPath(e.file ?? '').replace(/^\.\//, '')).filter(Boolean),
  )].sort()

  if (changedFiles.length === 0) {
    return emitBlockedSandbox(opts, roots, {
      code: 'BLOCKED_SANDBOX_EMPTY_DIFF',
      exitCode: EXIT.FACT,
      taskId,
      baseSha: effectiveBase,
      headSha: currentHead,
      reason: `沙箱相对基线（${String(effectiveBase ?? '').slice(0, 7) || 'base'}）无任何提交改动，无法晋升。`,
    })
  }

  const diffRaw = rangeSpec ? await gitDiffRawEntriesAndText(workRoot, rangeSpec) : null
  const diffText = diffRaw?.ok ? diffRaw.diffText : ''
  const [gateFindings, parity] = await Promise.all([
    detectGateWeakening(workRoot, effectiveBase, ledger.baseBranch, { headSha: currentHead, nameStatusEntries: diffEntries }),
    checkTddSyncParity(workRoot, changedFiles, { ...ledger, baseSha: effectiveBase }, {
      statusEntries: [], diffEntries, diffText,
    }),
  ])

  const incomingIssues = parseIssueNumbers([opts.issues, opts.issue], { strict: true })
  const preservedIssues = [...new Set([...(ledger.linkedIssues ?? []), ...incomingIssues])]

  // Step A: Case 5 TDD 冲突闸门（仅删除/破坏已在 TDD 登记的模块 staleModulesInTdd 或显式 --conflicts-tdd，绝不对正常新增 missingModulesInTdd 误触）
  const staleInTdd = Array.isArray(parity?.staleModulesInTdd) ? parity.staleModulesInTdd : []
  const isCase5Conflict = staleInTdd.length > 0 || Boolean(opts['conflicts-tdd'])
  if (isCase5Conflict) {
    ledger.status = 'sandbox-needs-spec'
    ledger.pocStatus = 'needs-tdd'
    ledger.linkedIssues = preservedIssues
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    const tddNext = [{ skill: 'dev-plan', text: 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "docs/TDD.md"' }]
    const detail = staleInTdd.length > 0
      ? `删除/破坏了 docs/TDD.md 已登记架构模块（${staleInTdd.join(', ')}）`
      : '显式标记了 --conflicts-tdd 架构冲突'
    return emitBlockedSandbox(opts, roots, {
      code: 'BLOCKED_CASE_5_TDD_CONFLICT',
      exitCode: EXIT.FACT,
      taskId,
      status: ledger.status,
      pocStatus: ledger.pocStatus,
      staleModulesInTdd: staleInTdd,
      linkedIssues: ledger.linkedIssues,
      reason: `沙箱改动命中 Case 5 架构冲突（${detail}），已阻断晋升且不提前建单；请先修订并批准 docs/TDD.md。`,
    }, tddNext)
  }

  // Step B: 单源三轴策略分类
  const profile = parseAgentsProfile(existsSync(join(workRoot, 'AGENTS.md')) ? workRoot : roots.mainRoot)
  const hasDevReview = hasSkillSupport(roots.mainRoot, 'dev-review')
  const policy = determineWorkflowPolicy({
    changedFiles,
    ownArchived: [],
    caseType: 2,
    highRiskGlobs: profile.highRisk,
    doNotEditGlobs: profile.doNotEdit,
    gateWeakeningHits: gateFindings,
    hasRemote: ledger.role !== 'local-only',
    hasCiWorkflow: hasRepoCiWorkflow(workRoot),
    visualFilesChanged: changedFiles.filter((f) => isUiVisualFile(f, { repoRoot: workRoot })),
    profile,
    hasDevReview,
    repoRoot: workRoot,
  })
  const findApprovedSpecForPromote = () => {
    const checkSpecRel = (rawRel) => {
      if (!rawRel) return null
      const norm = posixPath(String(rawRel)).replace(/^\.\//, '')
      for (const base of [workRoot, roots.mainRoot]) {
        const abs = resolve(base, norm)
        if (!existsSync(abs)) continue
        const fm = parseDocFrontmatter(readTextSafe(abs) ?? '')
        const st = String(fm.data?.status ?? '').toLowerCase()
        if (st === 'approved' || fm.data?.approved === true) return norm
      }
      return null
    }
    const explicitHit = checkSpecRel(opts.spec ?? ledger.specFile)
    if (explicitHit) return explicitHit
    for (const base of [workRoot, roots.mainRoot]) {
      const specs = indexPlanDocs(base, { includeArchive: false, includeWorktrees: false, managedOnly: true })
        .filter((d) => d.kind === 'spec' && (String(d.status).toLowerCase() === 'approved' || d.data?.approved === true))
      const hit = specs.find((d) => d.taskId === taskId || d.slug === ledger.slug || d.slug === taskId)
      if (hit) return hit.rel
    }
    return null
  }
  const approvedSpecRel = findApprovedSpecForPromote()
  const coreDomains = collectCoreSourceDomains(changedFiles)
  const touchesContract = diffTouchesExportContract(diffText, parity)
  const needsSpec = ((policy.oneWayBoundaryHits?.length ?? 0) > 0 || (coreDomains.length >= 3 && touchesContract) || Number(opts.case) === 4) && !approvedSpecRel

  if (needsSpec) {
    ledger.status = 'sandbox-needs-spec'
    ledger.pocStatus = 'needs-spec'
    ledger.promotedPolicy = policy
    ledger.linkedIssues = preservedIssues
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    const specSlug = ledger.slug ?? taskId
    const nextCmd = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind pair --slug ${specSlug} --title "${specSlug}" --agent <id>`
    const nextSteps = [{ skill: 'dev-plan', text: nextCmd }]
    const payload = {
      ok: true,
      outcome: 'needs-spec',
      code: 'SANDBOX_PROMOTE_NEEDS_SPEC',
      taskId,
      status: ledger.status,
      pocStatus: ledger.pocStatus,
      sandboxMode: true,
      policy,
      coreDomains,
      linkedIssues: ledger.linkedIssues,
    }
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(withNextSteps(payload, nextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    } else {
      process.stdout.write(`SANDBOX_PROMOTE_NEEDS_SPEC: 沙箱改动命中 Case 4 / 高风险边界（${policy.reasons.join('；') || `跨 ${coreDomains.length} 域契约`}），已标记为已验证 PoC（status=sandbox-needs-spec，不提前新建远端 Issue）。\n`)
      printNextStep(nextSteps, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  // Step C: Case 2 / Case 3 / 已批准 SPEC 的 Case 4 原地晋升外环实施态
  const todoRel = opts.todo ?? ledger.todoFile ?? null
  const specRel = approvedSpecRel ?? ledger.specFile ?? null
  const hasAddedCoreModule = diffEntries.some(
    (e) => /^[AR]/i.test(String(e.status ?? '')) && CODE_EXT_RE.test(e.file ?? '') && !TEST_FILE_RE.test(e.file ?? '') && !/^docs\//.test(e.file ?? ''),
  )
  const resolvedCase = approvedSpecRel
    ? 4
    : ((todoRel || hasAddedCoreModule || (policy.highRiskHits?.length ?? 0) > 0 || coreDomains.length >= 2 || changedFiles.length >= 4) ? 3 : 2)
  const primaryImplementer = pickPrimaryImplementer(ledger, opts)

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const promoState = { remoteUrls, declaredRepo, inputs: {} }

  const hasExplicitBody = opts.body !== undefined || opts['body-file'] !== undefined
  const hasTodoOnDisk = Boolean(todoRel && (existsSync(join(workRoot, todoRel)) || existsSync(join(roots.mainRoot, todoRel))))
  const promoteExemption = evaluateIssueBindingExemption({
    mainRoot: roots.mainRoot,
    caseType: resolvedCase,
    isPlanning: false,
    role: ledger.role,
    externalPr: null,
    ledger,
    opts: { ...opts, sandbox: false },
    implementerId: primaryImplementer,
  })

  let effectiveBindOpts = { ...opts, sandbox: false }
  if (preservedIssues.length === 0 && !promoteExemption.exempt && !promoteExemption.blocked && !hasExplicitBody && !hasTodoOnDisk) {
    const synth = await synthesizeIssueBodyFromDiff({
      workRoot,
      effectiveBase,
      currentHead,
      changedFiles,
      policy,
      resolvedCase,
      taskId,
      slug: ledger.slug,
      baseBranch: ledger.baseBranch ?? 'main',
    })
    effectiveBindOpts = {
      ...effectiveBindOpts,
      title: opts.title ?? synth.title,
      body: synth.body,
    }
  }

  const bindRes = await resolveOrBindStartIssue({
    roots,
    docRoot: workRoot,
    state: promoState,
    role: ledger.role,
    providerId: ledger.providerId,
    prelimTaskId: taskId,
    caseType: resolvedCase,
    isPlanning: false,
    externalPr: null,
    linkedIssues: preservedIssues,
    docs: { spec: specRel, todo: todoRel, prd: ledger.prdFile },
    ledger,
    opts: effectiveBindOpts,
    implementerId: primaryImplementer,
    commandName: 'promote',
  })
  if (bindRes.blocked) {
    if (!bindRes.alreadyEmitted) emitBlockedStart(opts, bindRes)
    return { exitCode: bindRes.exitCode }
  }

  const now = new Date().toISOString()
  ledger.sandboxMode = false
  ledger.promotedFromSandbox = true
  ledger.promotedAt = now
  ledger.pocStatus = 'in-place-promoted'
  ledger.caseType = resolvedCase
  ledger.status = 'started'
  ledger.verifiedHead = null
  ledger.lastVerifyExitCode = null
  ledger.linkedIssues = [...new Set(bindRes.linkedIssues)]
  ledger.issueBinding = bindRes.issueBinding
  if (specRel) ledger.specFile = specRel
  if (todoRel) ledger.todoFile = todoRel
  if (!ledger.claimedAt) {
    ledger.claimedAt = now
    ledger.claimedBy = primaryImplementer
  }
  if (!ledger.implementerId || ledger.implementerId === 'local-agent') {
    ledger.implementerId = primaryImplementer
  }
  if (!Array.isArray(ledger.implementers) || ledger.implementers.length === 0) {
    ledger.implementers = [{ actor: primaryImplementer, writeScope: [], phase: 'sandbox', registeredAt: now, updatedAt: now }]
  }
  if (resolvedCase >= 3 && !ledger.explored?.at) {
    inheritExploredCredentials({ mainRoot: roots.mainRoot, docRoot: workRoot, ledger, implementerId: primaryImplementer })
    if (!ledger.explored?.at) {
      ledger.explored = createExploredEvidence({
        at: now,
        source: 'sandbox-promote',
        tier: 'sandbox-diff',
        symbolCount: changedFiles.length,
        by: primaryImplementer,
      })
    }
  }
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  const boundIssFlag = ledger.linkedIssues?.[0] ? ` --issue ${ledger.linkedIssues[0]}` : ''
  const nextSteps = resolvedCase === 3 && !ledger.todoFile
    ? [
        {
          skill: 'dev-plan',
          text: `由非实施者角色（不得为 ${ledger.implementers.map((x) => x.actor).join('/') || primaryImplementer}）落盘 Case 3 Todo 复用单一工单：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind todo --slug ${ledger.slug ?? taskId} --title "${ledger.slug ?? taskId}" --task ${taskId}${boundIssFlag} --in-place --agent <nonImplOwner>`,
        },
        { skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}` },
      ]
    : (resolvedCase === 3
        ? [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}` }]
        : [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId} --mode ${policy.requiredGates?.[0] ?? 'full'}` }])

  const payload = {
    ok: true,
    outcome: 'promoted',
    taskId,
    caseType: resolvedCase,
    sandboxMode: false,
    promotedFromSandbox: true,
    pocStatus: ledger.pocStatus,
    status: ledger.status,
    linkedIssues: ledger.linkedIssues,
    issueBinding: ledger.issueBinding,
    ...(bindRes.createdIssue ? { createdIssue: bindRes.createdIssue } : {}),
    claimedBy: ledger.claimedBy,
    claimedAt: ledger.claimedAt,
    explored: ledger.explored,
    policy,
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps(payload, nextSteps, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(`沙箱任务 ${taskId} 已原地晋升为外环 Case ${resolvedCase}（status=started，verifiedHead 已清零，linkedIssues=${ledger.linkedIssues.join(',') || '无'}）。\n`)
    printNextStep(nextSteps, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}
