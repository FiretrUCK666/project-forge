/**
 * workflow-policy-next.mjs —— 状态机路由（evaluateNextState）、规划态路由、`needs-*` 并行可见、
 * 审查闭环强校（review-pack record）与合法并发 `--jobs` 校验。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 workflow-policy.mjs 重导出。
 */

import { EXIT } from './exit-codes.mjs'
import { buildMultiTaskWavePlan, buildSliceGraph, collectPlanDocs, scanUnstartedReadySlices } from './doc-slice-graph.mjs'
import { posixPath } from './git-core.mjs'
import { classifyTaskLiveness, nextReviewRound } from './ledger.mjs'
import { evaluateMutability } from './mutability.mjs'

const CLOSED_STATUSES = new Set(['submitted', 'local-ready', 'awaiting-upstream-merge', 'merged', 'aborted'])
const TERMINAL_SPEC_STATUSES = new Set(['implemented', 'done', 'superseded', 'dropped', 'archived'])

/** 从未启动切片元数据推导所属 Case 档位（独立 Todo 归 Case 3，SPEC 归 Case 4）。 */
export function caseTypeOfSlice(slice) {
  const explicit = Number(slice?.caseType)
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 5) return explicit
  if (slice?.kind === 'todo' && !slice?.specFile) return 3
  return 4
}

function findInFlightPlanOrMaster(repoRoot) {
  if (!repoRoot) return null
  try {
    const docs = collectPlanDocs(repoRoot).filter((d) => !d.archived)
    const active = docs.filter((d) => !TERMINAL_SPEC_STATUSES.has(String(d.data?.status ?? 'draft').trim().toLowerCase()))
    const draftDoc = active.find((d) => {
      const st = String(d.data?.status ?? 'draft').trim().toLowerCase()
      return (d.kind === 'spec' || d.kind === 'todo') && (st === 'draft' || st === 'pending')
    })
    if (draftDoc) return { kind: 'draft', doc: draftDoc }
    const masterPrd = active.find((d) => d.kind === 'prd' && (d.data?.multi_spec === true || ['draft', 'pending', 'active'].includes(String(d.data?.status ?? 'draft').trim().toLowerCase())))
    if (masterPrd) return { kind: 'master', doc: masterPrd }
  } catch { /* ignore unreadable docs */ }
  return null
}

/** 剥离合法并发参数（`--jobs` / `-j` / `--maxWorkers` / `--workers` / `--bail` / `--config.verify-deps-before-run`）。 */
export function normalizeConcurrentVerifyCommand(cmd) {
  return String(cmd ?? '')
    .replace(/(?:^|\s)(?:--jobs(?:=\S+|\s+\d+)|-j(?:\s*\d+)?)(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)--(?:maxWorkers|max-workers|workers)(?:=\S+|\s+\S+)(?=\s|$)/gi, ' ')
    .replace(/(?:^|\s)--bail(?:=(?:true|false|\d+))?(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)--(?:config\.)?verify-deps-before-run(?:=\S+|\s+\S+)?(?=\s|$)/g, ' ')
    .replace(/(?:^|\s)--no-verify-deps-before-run(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 校验实际执行的 verify 命令是否与 Dev Profile 配置一致（放行合法 `--jobs N` 并发标志）。 */
export function isEquivalentConcurrentCommand(actualCmd, configuredCmd) {
  const rawActual = String(actualCmd ?? '').trim()
  const rawConfigured = String(configuredCmd ?? '').trim()
  if (!rawActual || !rawConfigured) return false
  if (rawActual === rawConfigured) return true
  return normalizeConcurrentVerifyCommand(rawActual) === normalizeConcurrentVerifyCommand(rawConfigured)
}

/**
 * 强校独立审查闭环是否真正经 `review-pack record` 落盘并消费一次性令牌。
 * 防止绕过 `review-pack record` 手工篡改 `reviewPassed: true` 直接放行 merge。
 */
export function validateReviewRecordClosure({ ledger, lastRound, policy, hasDevReview = true, stopLossActive = false } = {}) {
  const rounds = Array.isArray(ledger?.rounds) ? ledger.rounds : []
  const requiresReview = hasDevReview && (policy?.independentReviewRequired || (policy?.riskTier !== 'low' && (rounds.length > 0 || Boolean(ledger?.lastReview))))
  if (!requiresReview || stopLossActive) return { ok: true, code: null }

  if (!lastRound || lastRound.verdict !== 'pass' || (lastRound.blockers ?? []).length > 0) {
    return {
      ok: false,
      code: 'BLOCKED_REVIEW_NOT_PASSED',
      exitCode: EXIT.FACT,
      reason: '缺少有效的 review-pack record PASS 轮次记录，禁止合并。',
    }
  }
  const hasRecordEvidence = Boolean(
    lastRound.rehydratedFromRemote
    || (typeof lastRound.reviewEvidence === 'string' && lastRound.reviewEvidence.trim())
    || lastRound.recordedAt,
  )
  if (!hasRecordEvidence) {
    return {
      ok: false,
      code: 'BLOCKED_REVIEW_NOT_PASSED',
      exitCode: EXIT.FACT,
      reason: `Round ${lastRound.round ?? '?'} 缺少 review-pack record 实证佐证记录。`,
    }
  }
  if (!lastRound.optionalLowRisk && !lastRound.rehydratedFromRemote) {
    const tokens = Array.isArray(ledger?.reviewTokens) ? ledger.reviewTokens : []
    const consumedForRound = tokens.some((t) => t && Number(t.round) === Number(lastRound.round) && Boolean(t.consumedAt))
    if (!consumedForRound) {
      return {
        ok: false,
        code: 'BLOCKED_REVIEW_NOT_PASSED',
        exitCode: EXIT.FACT,
        reason: `Round ${lastRound.round ?? '?'} 缺少经 review-pack record 消费的一次性审查令牌（reviewTokens）。`,
      }
    }
  }
  return { ok: true, code: null }
}

function enrichActiveTasksFromSliceSpecs(activeTasks = [], repoRoot = null) {
  if (!Array.isArray(activeTasks) || activeTasks.length === 0) return []
  const byTaskId = new Map()
  const bySpecRel = new Map()
  const multiSpecKeys = new Set()
  const multiSpecRels = new Set()
  if (repoRoot) {
    try {
      const graph = buildSliceGraph(repoRoot)
      for (const s of graph.slices ?? []) {
        if (s.kind !== 'spec') continue
        const isMasterContainer = s.data?.multi_spec === true
        if (isMasterContainer) {
          if (s.key) multiSpecKeys.add(s.key)
          if (s.rel) multiSpecRels.add(posixPath(s.rel))
          continue
        }
        if (s.key) byTaskId.set(s.key, s)
        if (s.rel) bySpecRel.set(posixPath(s.rel), s)
      }
    } catch { /* ignore slice graph read fallback */ }
  }
  const enriched = []
  for (const t of activeTasks) {
    if (!t || !t.taskId) continue
    const specNorm = t.specFile ? posixPath(t.specFile) : ''
    if (multiSpecKeys.has(t.taskId) || (specNorm && multiSpecRels.has(specNorm))) continue
    const specSlice = byTaskId.get(t.taskId) ?? (specNorm ? bySpecRel.get(specNorm) : null)
    if (specSlice && TERMINAL_SPEC_STATUSES.has(String(specSlice.status ?? '').toLowerCase())) continue
    const mergedDeps = [...new Set([
      ...(Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : []),
      ...(Array.isArray(specSlice?.dependsOn) ? specSlice.dependsOn.map(String) : []),
      ...(Array.isArray(specSlice?.deps) ? specSlice.deps.map(String) : []),
    ])]
    const mergedFiles = [...new Set([
      ...(Array.isArray(t.files) ? t.files : []),
      ...(Array.isArray(t.scopeFiles) ? t.scopeFiles : []),
      ...(Array.isArray(specSlice?.scopeFiles) ? specSlice.scopeFiles : []),
    ].filter(Boolean))]
    enriched.push({
      ...t,
      ...(mergedDeps.length > 0 ? { dependsOn: mergedDeps } : {}),
      ...(mergedFiles.length > 0 ? { files: mergedFiles, scopeFiles: mergedFiles } : {}),
    })
  }
  return enriched
}

function inferCandidatePhaseAndMutability(t) {
  const st = String(t?.status ?? '').trim().toLowerCase()
  const rounds = Array.isArray(t?.rounds) ? t.rounds : []
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const stopLossActive = Boolean((t?.lastReview?.stopLossTriggered || lastRound?.stopLossTriggered) && !t?.humanApprovedStopLoss)
  let candPhase
  if (t?.planning === true || st === 'planning') candPhase = 'planning'
  else if (st === 'released') candPhase = 'released'
  else if (st === 'started' && !t?.claimedAt && t?.role !== 'inbound-external-pr') candPhase = 'needs-claim'
  else if (st === 'merged') candPhase = 'needs-cleanup'
  else if (st === 'aborted' || st === 'dropped') candPhase = st
  else if (stopLossActive) candPhase = 'stop-loss-escalated'
  else if (st === 'rework' && t?.queueConflict) candPhase = 'needs-rework'
  else if (st === 'verify-failed') candPhase = 'needs-verify'
  else if (st === 'awaiting-upstream-merge') candPhase = 'awaiting-upstream-merge'
  else if (st === 'rework' || st === 'changes') candPhase = 'needs-rework'
  else if (t?.reviewPassed === true && (t?.submitted || t?.localReady)) candPhase = 'ready-to-merge'
  else if (t?.submitted || t?.localReady) candPhase = 'needs-review'
  else if (lastRound?.verdict === 'changes') candPhase = 'needs-rework'
  else if (Number(t?.caseType ?? 3) >= 3 && !t?.explored?.at) candPhase = 'needs-explore'
  else candPhase = 'implementing'
  const mut = evaluateMutability({ ledger: t, phase: candPhase, taskId: t?.taskId })
  return { phase: candPhase, mutability: mut.mutability, mutable: mut.mutable, terminal: mut.terminal }
}

/** 评估唯一活跃任务或集合状态并给出单一入口下一步路由与精简上下文。 */
export function evaluateNextState({
  activeTasks = [],
  allLedgers = activeTasks,
  pendingCleanupTasks = [],
  selectedTask = null,
  taskRuntime = null,
  multiTaskFiles = null,
  repoRoot = null,
} = {}) {
  const liveActiveTasks = []
  const cleanupBucket = Array.isArray(pendingCleanupTasks) ? [...pendingCleanupTasks] : []
  const seenCleanup = new Set(cleanupBucket.map((c) => c?.taskId).filter(Boolean))
  for (const t of Array.isArray(activeTasks) ? activeTasks : []) {
    const liveness = classifyTaskLiveness(t, { repoRoot })
    if (liveness === 'active') {
      liveActiveTasks.push(t)
    } else if (liveness === 'terminal-pending-cleanup' && t?.taskId && !seenCleanup.has(t.taskId)) {
      seenCleanup.add(t.taskId)
      cleanupBucket.push({ taskId: t.taskId, status: t.status, branch: t.branch ?? null, worktreePath: t.worktreePath ?? null })
    }
  }

  if (!selectedTask) {
    const readySlices = repoRoot ? scanUnstartedReadySlices(repoRoot, allLedgers) : []
    const enrichedActive = enrichActiveTasksFromSliceSpecs(liveActiveTasks, repoRoot)
    if (enrichedActive.length === 0) {
      const wavePlan = readySlices.length > 0 ? buildMultiTaskWavePlan(readySlices) : null
      const parallelDispatch = Boolean(wavePlan?.parallelDispatch)
      const firstReady = wavePlan?.order?.[0] ?? null
      const firstSlice = firstReady ? (readySlices.find((s) => s.taskId === firstReady) ?? readySlices[0]) : null
      const inFlightPlan = !firstReady ? findInFlightPlanOrMaster(repoRoot) : null
      if (inFlightPlan) {
        const doc = inFlightPlan.doc
        const isMaster = inFlightPlan.kind === 'master'
        return {
          taskId: null,
          phase: 'planning',
          ownerRole: 'coordinator',
          parallelDispatch: false,
          readySlices,
          ...(cleanupBucket.length > 0 ? { pendingCleanupTasks: cleanupBucket } : {}),
          nextAction: isMaster
            ? `检测到在途总控 PRD（${doc.rel}），请继续拆解或推进切片规划（而非重新 triage）。`
            : `检测到在途 draft 规划文档（${doc.rel}），请推进规划审计与内审（而非重新 triage）。`,
          command: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" next --file "${doc.rel}" --handoff`,
          blockingReasons: [],
          worktreePath: null,
          reviewWorktreePath: null,
          policy: null,
          coordinatorGuidance: {
            delegateImpl: false,
            delegateFreshReview: false,
            note: `发现未完结规划 ${doc.rel}，按 doc-plan next 续推。`,
          },
          compactContext: null,
          candidates: [],
        }
      }
      return {
        taskId: null,
        phase: 'idle',
        ownerRole: 'coordinator',
        parallelDispatch,
        readySlices,
        ...(wavePlan ? { wavePlan, waves: wavePlan.waves } : {}),
        ...(cleanupBucket.length > 0 ? { pendingCleanupTasks: cleanupBucket } : {}),
        nextAction: parallelDispatch
          ? `检测到 ${wavePlan.waves[0].tasks.length} 个无冲突就绪切片（${wavePlan.parallelizable.join(', ')}），主会话仅纯调度并行派发隔离实施子代理。`
          : (firstReady
              ? `检测到 1 个就绪切片（${firstReady}），按单一主动作启动隔离工作区。`
              : '当前无活跃任务；请先运行 doc-plan.mjs triage 或 flow.mjs start --task <id> 启动任务。'),
        command: parallelDispatch
          ? 'node ".agents/skills/dev-flow/scripts/flow.mjs" batch plan --json'
          : (firstReady
              ? `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${firstReady} --case ${caseTypeOfSlice(firstSlice)}`
              : 'node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug>'),
        blockingReasons: [],
        worktreePath: null,
        reviewWorktreePath: null,
        policy: null,
        coordinatorGuidance: {
          delegateImpl: false,
          delegateFreshReview: false,
          note: parallelDispatch ? '主会话保持纯调度，严禁将并行 Wave 1 折叠成单一任务。' : '无活跃任务，先规划或 start 新建隔离工作位。',
        },
        compactContext: null,
        candidates: [],
      }
    }
    const candidateItems = liveActiveTasks.map((t) => {
      const info = inferCandidatePhaseAndMutability(t)
      return {
        taskId: t.taskId,
        status: t.status,
        phase: info.phase,
        mutability: info.mutability,
        terminal: info.terminal,
        branch: t.branch ?? null,
        worktreePath: t.worktreePath ?? null,
      }
    })
    const dispatchableActive = enrichedActive.filter((t) => inferCandidatePhaseAndMutability(t).mutable)
    const activeIds = new Set(dispatchableActive.map((t) => t.taskId))
    const allLiveIds = new Set(enrichedActive.map((t) => t.taskId))
    const dedupReady = readySlices.filter((s) => !activeIds.has(s.taskId) && !allLiveIds.has(s.taskId))
    const combined = [...dispatchableActive, ...dedupReady]
    const wavePlan = combined.length > 0
      ? buildMultiTaskWavePlan(combined, multiTaskFiles)
      : { totalTasks: 0, parallelDispatch: false, waves: [], order: [], parallelizable: [] }
    const parallelDispatch = Boolean(wavePlan.parallelDispatch)
    const waveSummary = wavePlan.waves
      .map((w) => `Wave ${w.wave}(${w.canParallel ? '可并行' : '串行'}): ${w.tasks.map((t) => t.taskId).join(',')}`)
      .join(' -> ')
    const firstTask = wavePlan.order[0] ?? liveActiveTasks[0].taskId
    return {
      taskId: null,
      phase: 'ambiguous',
      ownerRole: 'coordinator',
      parallelDispatch,
      readySlices,
      ...(cleanupBucket.length > 0 ? { pendingCleanupTasks: cleanupBucket } : {}),
      nextAction: parallelDispatch
        ? `检测到 Wave 1 有 ${wavePlan.waves[0].tasks.length} 个可并行任务/就绪切片（${wavePlan.parallelizable.join(', ')}）：${waveSummary}。主会话保持纯调度并并行派发。`
        : (combined.length > 0
            ? `检测到 ${combined.length} 个可推进任务/切片，按波次顺序推进：${waveSummary}。`
            : `当前 ${liveActiveTasks.length} 个活跃任务均处于冻结/待审态（LOCKED），请指定 --task 查看或通过 --reopen 解锁。`),
      command: parallelDispatch
        ? `node ".agents/skills/dev-flow/scripts/flow.mjs" batch plan --tasks ${wavePlan.parallelizable.join(',')} --json`
        : `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${firstTask}`,
      blockingReasons: ['MULTIPLE_ACTIVE_TASKS'],
      worktreePath: null,
      reviewWorktreePath: null,
      policy: null,
      wavePlan,
      waves: wavePlan.waves,
      coordinatorGuidance: {
        delegateImpl: false,
        delegateFreshReview: false,
        note: `共 ${wavePlan.waves.length} 波次（Wave 1：${wavePlan.parallelizable.join(', ') || firstTask}；parallelDispatch=${parallelDispatch}）。`,
      },
      compactContext: null,
      candidates: candidateItems,
    }
  }

  const t = selectedTask
  const rt = taskRuntime ?? {}
  const policy = rt.policy ?? null
  const rounds = Array.isArray(t.rounds) ? t.rounds : []
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const nextRound = nextReviewRound(t)
  const currentHead = rt.headSha ?? null
  const evidenceVal = rt.evidenceValidation ?? { ok: false, code: 'BLOCKED_NOT_VERIFIED' }
  const needsFinalize = t.caseType === 3 || t.caseType === 4 || Boolean(t.todoFile) || Boolean(t.specFile)
  const nothingImplementedYet = Boolean(
    !CLOSED_STATUSES.has(t.status)
    && !t.finalized
    && !(t.rounds ?? []).length
    && !(rt.dirty > 0)
    && !((rt.commitsAheadOfBase ?? 0) > 0),
  )
  const finalizeStale = Boolean(needsFinalize && (!t.finalized || (t.finalizedHead && currentHead && t.finalizedHead !== currentHead && rt.nonDocChangesAfterFinalize)))
  const stopLossActive = Boolean((t.lastReview?.stopLossTriggered || lastRound?.stopLossTriggered) && !t.humanApprovedStopLoss)
  const reviewCoversHead = Boolean(t.reviewPassed === true && (!currentHead || t.reviewPassedHead === currentHead) && (!lastRound || !currentHead || lastRound.headSha === currentHead))
  const skipLocalIssueLoop = t.role === 'local-only'
    || t.role === 'generic-git'
    || t.providerId === 'none'
    || t.providerId === 'generic-git'
  const rawUnavailIssues = Array.isArray(t.issueContextUnavailable)
    ? t.issueContextUnavailable.map(Number).filter((n) => Number.isInteger(n) && n > 0)
    : []
  const unavailIssues = skipLocalIssueLoop ? [] : rawUnavailIssues
  const ack = t.issueContextAck
  const ackedSet = new Set(Array.isArray(ack?.issues) ? ack.issues.map(Number).filter(Boolean) : [])
  const hasValidIssueAck = Boolean(
    ack && typeof ack.reason === 'string' && ack.reason.trim().length > 0
    && unavailIssues.every((n) => ackedSet.has(n)),
  )
  const unackedIssues = unavailIssues.length > 0 && !hasValidIssueAck ? unavailIssues : []

  let phase
  let ownerRole = 'implementer'
  let nextAction
  let command
  const blockingReasons = []

  if (rt.opInProgress) {
    phase = 'blocked'
    ownerRole = 'implementer'
    blockingReasons.push('BLOCKED_GIT_CONFLICT_IN_PROGRESS')
    nextAction = `工作区处于 ${rt.opName ?? 'git'} 冲突状态，请先解决冲突`
    command = 'git status'
  } else if (t.role === 'clone-readonly') {
    phase = 'blocked'
    ownerRole = 'human'
    blockingReasons.push('ACTION_REQUIRED_CLONE_CHOICE')
    nextAction = '当前仓库为只读克隆，请确认 --clone-choice <fork|standalone|local>'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${t.taskId} --clone-choice <fork|standalone|local>`
  } else if (t.planning === true || t.status === 'planning') {
    phase = 'planning'
    ownerRole = 'coordinator'
    nextAction = '任务处于隔离规划期：请完成 doc-plan.mjs audit -> 独立 Critique -> approve，再执行 flow.mjs start 转入实施'
    command = t.specFile
      ? `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${t.specFile}"`
      : `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${t.taskId}`
  } else if (t.status === 'released') {
    phase = 'released'
    ownerRole = 'coordinator'
    nextAction = '任务已被释放认领，请先重新 claim 后继续'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${t.taskId}`
  } else if (t.status === 'started' && !t.claimedAt && t.role !== 'inbound-external-pr') {
    phase = 'needs-claim'
    ownerRole = 'implementer'
    blockingReasons.push('BLOCKED_NOT_CLAIMED')
    nextAction = '先认领再动手：认领会往关联 Issue 留开工痕迹，并记下谁在做'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${t.taskId}`
  } else if (t.status === 'merged') {
    phase = 'needs-cleanup'
    ownerRole = 'coordinator'
    nextAction = '分支已合入，请向用户列清单确认后再执行 cleanup --confirm --preview-hash <hash>'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${t.taskId}`
  } else if (t.role === 'inbound-external-pr') {
    const hasDevReview = rt.hasDevReview ?? true
    if (!hasDevReview) {
      phase = 'blocked'
      ownerRole = 'human'
      blockingReasons.push('BLOCKED_REQUIRES_DEV_REVIEW')
      nextAction = '当前项目未装配 dev-review 技能，外部 PR 不可信扫描与隔离审查须先通过 project-forge 运行 equip 补齐完整技能集'
      command = 'node "<project-forge>/scripts/equip.mjs" .'
    } else {
      ownerRole = 'reviewer'
      if (!reviewCoversHead) {
        phase = 'needs-review'
        nextAction = `对外部 PR #${t.prNumber ?? ''} 运行安全扫描与隔离审查`
        command = `node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${t.prNumber} --untrusted-scan`
      } else {
        phase = 'ready-to-merge'
        nextAction = '外部 PR 独立审查已通过，按合并权限合并'
        command = `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${t.taskId}`
      }
    }
  } else if (rt.dirty > 0) {
    phase = 'implementing'
    ownerRole = 'implementer'
    const actorHint = t.claimedBy ?? t.implementerId
    nextAction = actorHint && actorHint !== 'local-agent'
      ? `隔离工作位存在未提交改动（原认领者：${actorHint}）；优先唤醒原 implementer 续做，若原会话中断则新派 implementer 带 --takeover 接手（严禁协调者直接代改代提）`
      : '实施工作位存在未提交改动，完成后提交并继续 finalize/verify'
    command = `git -C "${t.worktreePath ?? '.'}" status`
  } else if (unackedIssues.length > 0) {
    phase = 'needs-issue-context'
    ownerRole = 'implementer'
    blockingReasons.push('ISSUE_CONTEXT_UNAVAILABLE')
    const nums = unackedIssues.join('、')
    const fetchHint = t.providerId === 'github' && t.role !== 'local-only'
      ? 'gh issue view <N> --repo <声明仓库> 并重跑 flow start'
      : 'node ".agents/skills/dev-flow/scripts/flow.mjs" issue view --issue <N> 或补充正文后重跑 flow start'
    nextAction = `拿不到 Issue #${nums} 的正文，先取回来再动手：${fetchHint}，`
      + `或显式确认凭现有信息继续：flow.mjs next --task ${t.taskId} --ack-no-issue-context --reason "<原因>"`
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${t.taskId} --ack-no-issue-context --reason "<无法读取 Issue 上下文的原因>"`
  } else if (stopLossActive) {
    phase = 'stop-loss-escalated'
    ownerRole = 'human'
    blockingReasons.push('STOP_LOSS_ESCALATE')
    nextAction = '已触发停损熔断，须人类审阅后执行 override 解锁'
    command = `node ".agents/skills/dev-review/scripts/review-pack.mjs" override --task ${t.taskId} --human-approved --reason "<理由>"`
  } else if (t.status === 'rework' && t.queueConflict) {
    phase = 'needs-rework'
    ownerRole = 'implementer'
    blockingReasons.push(t.queueConflict.code || 'BLOCKED_TRIAL_MERGE_CONFLICT')
    nextAction = `合并队列试合失败（${t.queueConflict.code ?? 'conflict'}），请先同步基线（flow.mjs sync）解决冲突并重跑 verify`
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" sync --task ${t.taskId}`
  } else if (lastRound?.verdict === 'changes' && lastRound?.headSha && currentHead && lastRound.headSha === currentHead) {
    phase = 'needs-rework'
    ownerRole = 'implementer'
    blockingReasons.push('CHANGES_REQUESTED')
    nextAction = `Round ${lastRound.round} 已退回修改，请在 ${t.worktreePath ?? '原分支'} 修复并提交新 commit 后执行 verify + submit`
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" rework --task ${t.taskId}`
  } else if (Number(t.caseType ?? 3) >= 3 && !t.explored?.at) {
    phase = 'needs-explore'
    ownerRole = 'explore'
    blockingReasons.push('BLOCKED_UNEXPLORED_TASK')
    nextAction = 'Case >= 3 任务须先运行只读 dev-explore 探索收集架构与复用证据，再进入实施与归档'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" explore --task ${t.taskId}`
  } else if (nothingImplementedYet) {
    phase = 'implementing'
    ownerRole = 'implementer'
    nextAction = '按交接包实施，改完提交；提交后按 flow next 继续'
    command = `git -C "${t.worktreePath ?? '.'}" status`
  } else if (finalizeStale) {
    phase = 'needs-finalize'
    ownerRole = 'implementer'
    blockingReasons.push(!t.finalized ? 'BLOCKED_NOT_FINALIZED' : 'BLOCKED_STALE_FINALIZE')
    nextAction = '请先运行 finalize 完成验收勾选与文档成对归档'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${t.taskId}`
  } else if (!evidenceVal.ok) {
    phase = 'needs-verify'
    ownerRole = 'implementer'
    if (evidenceVal.code) blockingReasons.push(evidenceVal.code)
    const recTier = evidenceVal.requiredTier ?? policy?.requiredGates?.[0] ?? 'full'
    const modeFlag = policy?.riskTier === 'low' ? '' : ` --mode ${recTier}`
    const e2eHint = policy?.smokeRequired ? ' --e2e-evidence "<运行观察实证>"' : ''
    nextAction = evidenceVal.reason ?? '请运行匹配的 verify 门禁锁定当前 HEAD'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${t.taskId}${modeFlag}${e2eHint}`
  } else if (!['submitted', 'local-ready', 'awaiting-upstream-merge'].includes(t.status) || (t.lastSubmittedHead && currentHead && t.lastSubmittedHead !== currentHead)) {
    phase = 'needs-submit'
    ownerRole = 'implementer'
    nextAction = '实证已锁定当前 HEAD，由实施者执行 submit 推送并提 PR/同步审查工作位'
    const submitAgent = t.claimedBy ?? t.implementerId ?? '<id>'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${t.taskId} --agent ${submitAgent}`
  } else if (policy?.independentReviewRequired !== false && !reviewCoversHead) {
    phase = 'needs-review'
    ownerRole = 'reviewer'
    nextAction = `请新建独立审查子代理执行 Round ${nextRound} 审查（禁止复用旧上下文）`
    command = `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${t.taskId} --round ${nextRound}`
  } else if (t.role === 'contributor-fork') {
    phase = 'awaiting-upstream-merge'
    ownerRole = 'human'
    nextAction = '独立审查已通过，等待上游维护者合并 PR，合并前严禁删除 Fork 分支'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" status --task ${t.taskId}`
  } else if (t.role === 'generic-git') {
    phase = 'awaiting-remote-mr'
    ownerRole = 'human'
    const approveSuffix = policy?.humanApprovalRequired ? ' --human-approved --reason "<确认原因>"' : ''
    nextAction = policy?.humanApprovalRequired
      ? '请先在远端托管完成合并，再带 --human-approved --reason "<确认原因>" 收尾（合并结果由现场取回远端核验）'
      : '请先在远端托管完成合并，再执行 merge 收尾（合并结果由现场取回远端核验）'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${t.taskId}${approveSuffix}`
  } else {
    phase = 'ready-to-merge'
    ownerRole = policy?.humanApprovalRequired ? 'human' : 'reviewer'
    nextAction = policy?.humanApprovalRequired
      ? '当前仓库未装配 dev-review 且触及高风险/one-way 边界，请人类确认后带 --human-approved --reason "<确认原因>" 执行 merge'
      : (policy?.independentReviewRequired === false
        ? '门禁与实证全部就绪，可执行 merge 完成合并'
        : '门禁与审查全部就绪，由审查者执行 merge 完成合并')
    command = policy?.humanApprovalRequired
      ? `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${t.taskId} --human-approved --reason "<确认原因>"`
      : `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${t.taskId}`
  }

  const warnings = []
  if ((rt.mainDirtyCount ?? 0) > 0 && t.worktreePath) {
    warnings.push({
      code: 'WARN_WORKING_IN_MAIN_CHECKOUT',
      message: `主工作区有 ${rt.mainDirtyCount} 处未提交改动，而这条任务的实施位是 ${t.worktreePath}`
        + '——Case 2/3/4 的活应该落在隔离位；小改动（Case 1）才在主工作区直接改。'
        + '请在主仓合并前整理并清理或迁出这些未提交改动，以免被脏主仓门禁拦截或混入无关修改。',
    })
  }

  // C6: selectedTask 处于 needs-* 阶段时保持并行切片与波次可见
  let parallelFields = {}
  if (phase.startsWith('needs-') && repoRoot) {
    const readySlices = scanUnstartedReadySlices(repoRoot, allLedgers)
    const combined = [...liveActiveTasks, ...readySlices]
    const wavePlan = combined.length > 0 ? buildMultiTaskWavePlan(combined, multiTaskFiles) : null
    parallelFields = {
      parallelDispatch: Boolean(wavePlan?.parallelDispatch),
      readySlices,
      waves: wavePlan?.waves ?? [],
      ...(wavePlan ? { wavePlan } : {}),
    }
  }

  const singleMut = evaluateMutability({ ledger: t, phase, taskId: t.taskId })
  return {
    taskId: t.taskId,
    phase,
    mutability: singleMut.mutability,
    ownerRole,
    nextAction,
    command,
    blockingReasons,
    warnings,
    ...(cleanupBucket.length > 0 ? { pendingCleanupTasks: cleanupBucket } : {}),
    ...parallelFields,
    worktreePath: t.worktreePath ?? null,
    reviewWorktreePath: t.reviewWorktreePath ?? null,
    policy,
    coordinatorGuidance: {
      delegateImpl: t.caseType >= 2 && t.caseType <= 4 && ['implementing', 'needs-rework', 'needs-finalize', 'needs-verify', 'needs-submit'].includes(phase),
      delegateFreshReview: phase === 'needs-review',
      freshReviewRequiredForRound2Plus: nextRound >= 2,
      note: phase === 'needs-review' && nextRound >= 2
        ? 'Round 2+ 必须新建独立 review 子代理，并在增量视野硬锁下复审。'
        : (t.caseType >= 2 && t.caseType <= 4 ? 'Case 2/3/4 单任务在隔离 impl worktree 由 impl 子代理闭环实施、verify 与 submit 提 PR。' : '按 nextAction 推进。'),
    },
    compactContext: {
      taskId: t.taskId,
      caseType: t.caseType,
      role: t.role,
      branch: t.branch ?? null,
      baseBranch: t.baseBranch ?? null,
      headSha: currentHead,
      riskTier: policy?.riskTier ?? 'medium',
      requiredGates: policy?.requiredGates ?? [],
      round: rounds.length,
      lastVerdict: lastRound?.verdict ?? null,
      prNumber: t.prNumber ?? null,
      issueContext: Array.isArray(t.issueContext) ? t.issueContext : [],
      issueContextUnavailable: unavailIssues,
      issueContextAck: t.issueContextAck ?? null,
      prContext: t.prContext ?? null,
      prContextUnavailable: t.prContextUnavailable ?? null,
      prBaseSha: t.prBaseSha ?? null,
      prHeadSha: t.prHeadSha ?? null,
    },
  }
}
