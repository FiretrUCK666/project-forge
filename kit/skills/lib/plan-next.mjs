/**
 * plan-next.mjs —— 跨宿主抗压缩规划状态机与交接包生成器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 `doc-plan.mjs next --handoff`
 * 与 `flow.mjs next --handoff`（`planning` 态）单源共用。
 *
 * 设计约束：
 * - 所有状态从磁盘重建（docs/ + 活跃规划 worktree + privateDocsDir + 账本/sidecar），
 *   主 Agent 经历上下文压缩或重开会话也能 1 步无损恢复全量盘面。
 * - `planner` / `implementer`（写手）优先续聊/发消息给既有原写手，支持断连新建兜底；
 *   `critic` / `reviewer` Round 2+ 强制新建独立子代理，严禁复用历史上下文。
 */

import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { buildContextBrief, extractDocPaths, formatContextBriefLines } from './context-brief.mjs'
import { collectExcludedReviewers, critiqueTextFingerprint, parseCritiqueRounds, readPlanCritiqueEntrySync } from './critique-rounds.mjs'
import { parseDocFrontmatter } from './docs.mjs'
import { gitStatusPorcelainZ, posixPath, readTextSafe } from './git.mjs'
import { readTaskLedger, sanitizeTaskId } from './ledger.mjs'
import { analyzePendingDecisions, normalizePlanMode } from './pending-decisions.mjs'
import { resolveCritiqueReadiness } from './plan-exit-gate.mjs'
import { indexPlanDocs, inferPlanDocKind, isPlanDocApproved, resolveLinkedPlanGraph } from './plan-index.mjs'
import { readPreInitState } from './session-state.mjs'

const TERMINAL_PLAN_STATUSES = new Set(['done', 'archived', 'implemented', 'superseded', 'dropped'])

function resolveExplicitDoc(repoRoot, mainRoot, file) {
  const raw = String(file ?? '').trim()
  if (!raw) return null
  for (const base of [repoRoot, mainRoot].filter(Boolean)) {
    const abs = resolve(base, raw)
    if (!existsSync(abs)) continue
    const text = readTextSafe(abs)
    if (text === undefined) continue
    const rel = posixPath(relative(base, abs))
    const fm = parseDocFrontmatter(text)
    return {
      root: base,
      rel,
      abs,
      kind: inferPlanDocKind(rel, fm.data),
      status: String(fm.data?.status ?? 'draft').trim().toLowerCase(),
      data: fm.data ?? {},
      text,
      locationType: resolve(base).toLowerCase() === resolve(mainRoot).toLowerCase() ? 'main' : 'worktree',
    }
  }
  return null
}

function selectTargetPlanningDoc({ explicitDoc, taskId, ledger, allDocs, prdDocs, specDocs, todoDocs }) {
  if (explicitDoc) return { selectedDoc: explicitDoc, masterPrd: null, childSlices: [] }

  const activeDocs = allDocs.filter((d) => !TERMINAL_PLAN_STATUSES.has(d.status) && !d.rel.startsWith('docs/archive/'))
  const boundFiles = new Set([ledger?.prdFile, ledger?.specFile, ledger?.todoFile].filter(Boolean).map((p) => posixPath(p)))
  if (taskId || boundFiles.size > 0) {
    const taskMatches = activeDocs.filter((d) => {
      if (boundFiles.has(d.rel)) return true
      return Boolean(taskId && d.data?.task_id && sanitizeTaskId(d.data.task_id) === sanitizeTaskId(taskId))
    })
    if (taskMatches.length > 0) {
      const hit = taskMatches.find((d) => d.kind === 'spec')
        ?? taskMatches.find((d) => d.kind === 'prd')
        ?? taskMatches[0]
      return { selectedDoc: hit, masterPrd: null, childSlices: [] }
    }
  }

  // 1:N 总控 PRD 优先：未就绪先收口总控 PRD；总控已就绪再挑下一片未过审切片，避免弱模型混改
  const activePrds = prdDocs.filter((d) => !TERMINAL_PLAN_STATUSES.has(d.status) && !d.rel.startsWith('docs/archive/'))
  const masterPrd = activePrds.find((p) => p.data?.multi_spec === true) ?? activePrds[0] ?? null
  const activeSpecs = specDocs.filter((d) => !TERMINAL_PLAN_STATUSES.has(d.status) && !d.rel.startsWith('docs/archive/'))
  const activeTodos = todoDocs.filter((d) => !TERMINAL_PLAN_STATUSES.has(d.status) && !d.rel.startsWith('docs/archive/'))

  const childSlices = masterPrd
    ? activeSpecs.filter((s) => typeof s.data?.related_prd === 'string' && s.data.related_prd.includes(masterPrd.rel.split('/').pop()))
    : []

  if (masterPrd && !isPlanDocApproved(masterPrd)) {
    return { selectedDoc: masterPrd, masterPrd, childSlices }
  }
  const nextSlice = (childSlices.length > 0 ? childSlices : activeSpecs).find((s) => !isPlanDocApproved(s))
    ?? activeSpecs[0]
    ?? activeTodos[0]
    ?? masterPrd
    ?? null
  return { selectedDoc: nextSlice, masterPrd, childSlices }
}

async function inspectWorktreeInterruption({ mainRoot, selectedDoc, taskId, ledger }) {
  const effTask = taskId
    ?? (selectedDoc?.data?.task_id ? sanitizeTaskId(selectedDoc.data.task_id) : null)
  const wtRel = ledger?.worktreePath
    ?? (selectedDoc && resolve(selectedDoc.root).toLowerCase() !== resolve(mainRoot).toLowerCase()
      ? posixPath(relative(mainRoot, selectedDoc.root))
      : (effTask && existsSync(resolve(mainRoot, '.worktrees', `impl-${effTask}`)) ? `.worktrees/impl-${effTask}` : null))
  if (!wtRel) return { exists: false, worktreePath: null, branch: ledger?.branch ?? null, dirtyCount: 0, activeActor: null, owner: selectedDoc?.data?.owner ?? null }
  const wtAbs = resolve(mainRoot, wtRel)
  if (!existsSync(wtAbs)) return { exists: false, worktreePath: wtRel, branch: ledger?.branch ?? null, dirtyCount: 0, activeActor: null, owner: selectedDoc?.data?.owner ?? null }

  let dirtyCount = 0
  try {
    const st = await gitStatusPorcelainZ(wtAbs)
    if (st.ok) dirtyCount = (st.entries ?? []).length
  } catch { /* ignore */ }
  const activeActor = ledger?.claimedBy ?? ledger?.implementerId ?? selectedDoc?.data?.owner ?? null
  return {
    exists: true,
    worktreePath: wtRel,
    branch: ledger?.branch ?? selectedDoc?.data?.branch ?? null,
    dirtyCount,
    activeActor: activeActor && activeActor !== 'local-agent' ? activeActor : null,
    owner: selectedDoc?.data?.owner ?? null,
  }
}

/**
 * 评估当前仓库或指定规划文档/任务的单一确定性下一步状态（抗压缩、跨宿主通用）。
 */
export async function evaluatePlanNextState({
  repoRoot = process.cwd(),
  mainRoot = repoRoot,
  gitDir = null,
  isGit = false,
  taskId = null,
  file = null,
  planOnly = false,
  ledger = null,
  auditDocFn = null,
} = {}) {
  const effMain = resolve(mainRoot || repoRoot)
  const resolvedTaskId = taskId ? sanitizeTaskId(taskId) : null
  const activeLedger = ledger ?? (resolvedTaskId ? readTaskLedger(effMain, resolvedTaskId) : null)
  const explicitDoc = resolveExplicitDoc(repoRoot, effMain, file)
  const allDocs = indexPlanDocs({
    repoRoot,
    mainRoot: effMain,
    taskId: resolvedTaskId,
    ledger: activeLedger,
    file,
    includeArchive: false,
    includeWorktrees: true,
    managedOnly: true,
  })
  const prdDocs = allDocs.filter((d) => d.kind === 'prd')
  const specDocs = allDocs.filter((d) => d.kind === 'spec')
  const todoDocs = allDocs.filter((d) => d.kind === 'todo')
  const { selectedDoc, masterPrd, childSlices } = selectTargetPlanningDoc({
    explicitDoc, taskId: resolvedTaskId, ledger: activeLedger, allDocs, prdDocs, specDocs, todoDocs,
  })
  const preInit = readPreInitState(effMain)

  if (!selectedDoc) {
    const contextBrief = buildContextBrief(repoRoot || effMain, {
      paths: preInit?.anchors ?? [],
      keywords: preInit?.topic ? [preInit.topic] : [],
      excludeFiles: ['AGENTS.md'],
    })
    return {
      ok: true,
      phase: 'needs-triage',
      ownerRole: 'coordinator',
      deliveryMode: planOnly ? 'plan-only' : 'impl',
      doc: null,
      taskId: resolvedTaskId,
      planMode: null,
      masterPrd: null,
      sliceSummary: null,
      interruptedWorktree: { exists: false, worktreePath: null, branch: null, dirtyCount: 0, activeActor: null, owner: null },
      pendingDecisions: { found: false, total: 0, unresolved: [] },
      critique: { round: 0, nextRound: 1, excludedReviewers: [], findings: [], stopLossActive: false, readiness: null },
      reviewChoices: [],
      preInit,
      contextBrief,
      nextAction: '当前无在途规划文档；先跑 dev-explore 核清仓内复用，再执行 doc-plan.mjs triage 定档分流。',
      command: 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<需求描述>"',
      blockingReasons: [],
    }
  }

  const relDoc = selectedDoc.rel
  const effTask = resolvedTaskId ?? (selectedDoc.data?.task_id ? sanitizeTaskId(selectedDoc.data.task_id) : null)
  const docLedger = activeLedger ?? (effTask ? readTaskLedger(effMain, effTask) : null)
  const docPlanMode = normalizePlanMode(selectedDoc.data?.plan_mode) || 'autonomous'
  const interruptedWorktree = await inspectWorktreeInterruption({ mainRoot: effMain, selectedDoc, taskId: effTask, ledger: docLedger })
  const docScopePaths = [
    ...(Array.isArray(selectedDoc.data?.scope_files) ? selectedDoc.data.scope_files : []),
    ...extractDocPaths(selectedDoc.text),
    ...(preInit?.anchors ?? []),
  ]
  const contextBrief = buildContextBrief(selectedDoc.root || repoRoot || effMain, {
    paths: docScopePaths,
    keywords: [effTask, selectedDoc.data?.title, preInit?.topic].filter(Boolean),
    excludeFiles: [relDoc, 'AGENTS.md'],
  })

  const masterPrdInfo = masterPrd
    ? { file: masterPrd.rel, status: masterPrd.status, approved: isPlanDocApproved(masterPrd) }
    : null
  const sliceSummary = childSlices.length > 0
    ? {
        totalSlices: childSlices.length,
        approvedSlices: childSlices.filter((s) => isPlanDocApproved(s)).length,
        pendingSlices: childSlices.filter((s) => !isPlanDocApproved(s)).map((s) => s.rel),
      }
    : null

  if (TERMINAL_PLAN_STATUSES.has(selectedDoc.status) || relDoc.startsWith('docs/archive/')) {
    return {
      ok: true,
      phase: 'terminal-archived',
      ownerRole: 'coordinator',
      deliveryMode: planOnly ? 'plan-only' : 'impl',
      doc: { file: relDoc, kind: selectedDoc.kind, status: selectedDoc.status, approved: isPlanDocApproved(selectedDoc), root: selectedDoc.root, locationType: selectedDoc.locationType },
      taskId: effTask,
      planMode: docPlanMode,
      masterPrd: masterPrdInfo,
      sliceSummary,
      interruptedWorktree,
      pendingDecisions: { found: false, total: 0, unresolved: [] },
      critique: { round: 0, nextRound: 1, excludedReviewers: [], findings: [], stopLossActive: false, readiness: null },
      reviewChoices: [],
      preInit,
      contextBrief,
      nextAction: `文档 ${relDoc} 已处于终态（status=${selectedDoc.status}），无需继续规划或开工；如需新需求请另建规划或运行 flow next。`,
      command: 'node ".agents/skills/dev-flow/scripts/flow.mjs" next',
      blockingReasons: [],
    }
  }

  const pending = analyzePendingDecisions(selectedDoc.text)
  const { entry: critiqueEntry } = readPlanCritiqueEntrySync({
    repoRoot: selectedDoc.root, mainRoot: effMain, gitDir, taskId: effTask, fmData: selectedDoc.data, relDoc,
  })
  const rounds = parseCritiqueRounds(selectedDoc.data, selectedDoc.text, critiqueEntry)
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const nextRound = rounds.reduce((m, r) => Math.max(m, Number(r?.round) || 0), 0) + 1
  const excludedReviewers = collectExcludedReviewers(rounds, selectedDoc.data?.owner)
  const currentSha = critiqueTextFingerprint(selectedDoc.text)
  const readiness = resolveCritiqueReadiness({
    rel: relDoc, kind: selectedDoc.kind, docType: selectedDoc.kind, text: selectedDoc.text,
    data: selectedDoc.data, ledgerEntry: critiqueEntry,
  })
  const auditRes = typeof auditDocFn === 'function' ? auditDocFn({ repoRoot: selectedDoc.root, file: relDoc }) : null
  const auditNonPendingErrors = (auditRes?.errors ?? []).filter((e) => e.code !== 'BLOCKED_PENDING_DECISIONS')

  const continueActive = Boolean(critiqueEntry?.continued?.active)
  const continueFromSha = critiqueEntry?.continued?.fromSha ?? critiqueEntry?.continued?.sha ?? null
  const continueShaUnchanged = Boolean(continueActive && (!continueFromSha || continueFromSha === currentSha))
  const rejectUnfixed = Boolean(lastRound?.verdict === 'rejected' && (!lastRound.sha || lastRound.sha === currentSha))
  const stopLossActive = Boolean(lastRound?.stopLossTriggered && readiness.blocked && !continueActive)

  const reviewFindings = []
  if (continueActive && critiqueEntry?.continued?.reason) {
    reviewFindings.push(`[用户修改意见] ${critiqueEntry.continued.reason}`)
  }
  if (lastRound?.verdict === 'rejected') {
    for (const item of lastRound.findings ?? []) reviewFindings.push(String(item))
    if ((lastRound.findings ?? []).length === 0 && lastRound.summary) reviewFindings.push(lastRound.summary)
  }

  let phase
  let ownerRole = 'planner'
  let nextAction
  let command
  const blockingReasons = []
  let reviewChoices = []

  if (pending.unresolved.length > 0) {
    phase = 'needs-clarification'
    ownerRole = 'human'
    blockingReasons.push('BLOCKED_PENDING_DECISIONS')
    nextAction = `还有 ${pending.unresolved.length} 条待拍板项未清空；请对照常青文档与源码逐项向用户确认后写入 \`doc-plan clarify --by user\`（interactive 绝不代拍）。`
    command = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" clarify --file "${relDoc}" --question "${pending.unresolved[0].text.slice(0, 60)}" --decision "已定：<结论>" --by user`
  } else if (auditNonPendingErrors.length > 0) {
    phase = 'needs-audit-fix'
    ownerRole = 'planner'
    blockingReasons.push(auditNonPendingErrors[0].code || 'AUDIT_FAILED')
    nextAction = `文档自审未通过（${auditNonPendingErrors[0].code}: ${auditNonPendingErrors[0].message}）；请续聊或恢复 planner 在原稿修通后再审。`
    command = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${relDoc}"`
  } else if (selectedDoc.kind === 'todo') {
    phase = planOnly ? 'plan-only-handoff' : 'ready-for-impl'
    ownerRole = planOnly ? 'coordinator' : 'implementer'
    nextAction = planOnly
      ? 'Todo 自审通过：提交纯文档 PR 并同步 Master Issue 后停止，交由其他成员各自认领切片。'
      : 'Todo 自审通过（Case 3 无需 Critique）：派发独立 implementer 子代理进隔离 worktree 启动实施。'
    command = planOnly
      ? 'node ".agents/skills/dev-flow/scripts/flow.mjs" next'
      : `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${effTask ?? 'task'} --case 3 --todo "${relDoc}"`
  } else if (stopLossActive) {
    phase = 'stop-loss'
    ownerRole = 'human'
    blockingReasons.push('STOP_LOSS_ESCALATE')
    nextAction = `规划 Critique 已触发第 ${lastRound?.round ?? 3} 轮停损熔断；须由人类审阅后决定 critique-override 放行或 critique-continue 带修改意见打回重写。`
    command = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-override --file "${relDoc}" --human-approved --reason "<维护者裁决原因>"`
  } else if (continueShaUnchanged || rejectUnfixed) {
    phase = 'needs-revision'
    ownerRole = 'planner'
    blockingReasons.push(continueShaUnchanged ? 'HUMAN_REVISION_REQUESTED' : 'CRITIQUE_REJECTED')
    nextAction = continueShaUnchanged
      ? '收到人类修改意见：优先续聊/发消息给既有 planner 子代理先读最新文档与意见后修订，重跑 audit 并由新独立 critic 复核。'
      : `Round ${lastRound?.round ?? 1} 独立 Critique 退回修改：优先续聊既有 planner 子代理逐条修清 Must Fix 后重跑 audit，再换新 critic 复审。`
    command = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${relDoc}"`
  } else if (readiness.blocked || continueActive) {
    phase = 'needs-critique'
    ownerRole = 'critic'
    blockingReasons.push(readiness.basis || (continueActive ? 'HUMAN_REVISION_REQUESTED' : 'CRITIQUE_UNREADY'))
    nextAction = `请新建独立只读 critic 子代理（排除：${excludedReviewers.join(', ') || '作者'}）运行 critique-scope 并按事实给出 Round ${nextRound} 结论。`
    command = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-scope --file "${relDoc}" --round ${nextRound}`
  } else if (!isPlanDocApproved(selectedDoc)) {
    phase = 'needs-human-review'
    ownerRole = 'human'
    reviewChoices = [
      { id: 'approve-impl', label: 'Approve（锁定并转入隔离实现）', command: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${relDoc}"` },
      { id: 'approve-plan-only', label: 'Approve · Plan-Only（仅合入规划文档与 Issue 供团队认领）', command: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${relDoc}" && node ".agents/skills/dev-plan/scripts/doc-plan.mjs" next --file "${relDoc}" --plan-only --handoff` },
      { id: 'dismiss-revise', label: 'Dismiss / 要求修改（记录意见退回 planner 续改）', command: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-continue --file "${relDoc}" --reason "<具体修改意见>"` },
      { id: 'keep-planning', label: 'Keep planning（留在本轮澄清，对照常青文档与源码继续追问）', command: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" clarify --file "${relDoc}" --question "<待继续核实项>" --decision "<已定：...>" --by user` },
    ]
    nextAction = '规划内审与结构检查均已通过；请用户做最终拍板：Approve（转实现或 Plan-Only 团队交付）/ Dismiss（打回 planner 修订）/ Keep planning（继续澄清）。'
    command = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${relDoc}"`
  } else if (planOnly) {
    const graph = resolveLinkedPlanGraph({
      repoRoot: selectedDoc.root || repoRoot,
      mainRoot: effMain,
      file: relDoc,
      doc: selectedDoc,
      allDocs,
    })
    const graphUnready = graph.nodes.filter((n) => {
      if (n.inert) return false
      if (!isPlanDocApproved(n)) return true
      if (n.kind === 'prd' || n.kind === 'spec') {
        const { entry: nEntry } = readPlanCritiqueEntrySync({
          repoRoot: n.root || selectedDoc.root, mainRoot: effMain, gitDir,
          taskId: n.taskId ?? effTask, fmData: n.data, relDoc: n.rel,
        })
        return resolveCritiqueReadiness({ rel: n.rel, kind: n.kind, docType: n.kind, text: n.text, data: n.data, ledgerEntry: nEntry }).blocked
      }
      return false
    })
    if (graphUnready.length > 0) {
      const targetNode = graphUnready[0]
      phase = targetNode.kind === 'todo' ? 'needs-spec-approval' : 'needs-critique'
      ownerRole = targetNode.kind === 'todo' ? 'human' : 'critic'
      blockingReasons.push('BLOCKED_PLAN_NOT_READY')
      nextAction = `关联规划图仍有未就绪节点 ${targetNode.rel} (status=${targetNode.status})，须整图审批就绪后才可进入 Plan-Only 团队交付。`
      command = targetNode.kind === 'todo'
        ? `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${targetNode.data?.related_spec ? targetNode.rel : relDoc}"`
        : `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" next --file "${targetNode.rel}" --plan-only --handoff`
    } else {
      phase = 'plan-only-handoff'
      ownerRole = 'coordinator'
      nextAction = '规划已批准（Plan-Only 团队异步交付）：将规划文档 PR 合入默认分支并确认 Master Issue 已同步切片清单后停下，等待其他成员各自认领 readySlices。'
      command = 'node ".agents/skills/dev-flow/scripts/flow.mjs" next'
    }
  } else {
    phase = 'ready-for-impl'
    ownerRole = 'implementer'
    nextAction = selectedDoc.kind === 'prd' && masterPrdInfo && childSlices.length === 0
      ? '总控 PRD 已就绪，请为下一切片创建 SPEC+Todo，或启动对应切片隔离实现。'
      : '规划已批准，移交独立 implementer 子代理在隔离 worktree 内开工实现并完成 verify/submit。'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${effTask ?? 'task'} --case ${selectedDoc.kind === 'todo' ? 3 : 4}${selectedDoc.kind === 'spec' ? ` --spec "${relDoc}"` : ''}`
  }

  return {
    ok: true,
    phase,
    ownerRole,
    deliveryMode: planOnly ? 'plan-only' : 'impl',
    doc: {
      file: relDoc,
      kind: selectedDoc.kind,
      status: selectedDoc.status,
      approved: isPlanDocApproved(selectedDoc),
      root: selectedDoc.root,
      locationType: selectedDoc.locationType,
      sha: currentSha,
    },
    taskId: effTask,
    planMode: docPlanMode,
    masterPrd: masterPrdInfo,
    sliceSummary,
    interruptedWorktree,
    pendingDecisions: pending,
    critique: {
      round: rounds.length,
      nextRound,
      excludedReviewers,
      findings: reviewFindings,
      stopLossActive,
      continueActive,
      readiness,
    },
    reviewChoices,
    preInit,
    contextBrief,
    nextAction,
    command,
    blockingReasons,
  }
}

/**
 * 组装抗压缩规划交接包：显式区分写手续聊优先、复审强制换新、中断恢复禁止主代理代干，以及 1:N / Plan-Only 边界。
 */
export function buildPlanHandoff({ state, deliveryMode = state?.deliveryMode ?? 'impl' } = {}) {
  const s = state ?? {}
  const docFile = s.doc?.file ?? '(待通过 triage 确定)'
  const wt = s.interruptedWorktree ?? {}
  const role = s.ownerRole ?? 'coordinator'
  const lines = [
    `## 规划态交接包（phase=${s.phase ?? 'unknown'} | owner=${role} | mode=${deliveryMode}）`,
    '',
    `- **目标文档**：\`${docFile}\`${s.doc?.kind ? ` (${s.doc.kind}, status=${s.doc.status}, sha=${s.doc.sha ?? '-'})` : ''}`,
    `- **隔离工作位**：${wt.worktreePath ? `\`${wt.worktreePath}\` (branch=${wt.branch ?? '-'}, dirty=${wt.dirtyCount})` : '尚未建隔离 worktree（Case 3/4 写改默认落独立规划 worktree）'}`,
  ]
  if (s.masterPrd) {
    lines.push(`- **总控 PRD（1:N）**：\`${s.masterPrd.file}\` (status=${s.masterPrd.status})${s.sliceSummary ? ` | 切片进度：已过审 ${s.sliceSummary.approvedSlices}/${s.sliceSummary.totalSlices}` : ''}`)
  }
  if (s.preInit) {
    lines.push('', '### 预初始化讨论缓冲（init 前保留）')
    if (s.preInit.topic) lines.push(`- 主题：${s.preInit.topic}`)
    if (s.preInit.decisions?.length > 0) lines.push(`- 已定结论：${s.preInit.decisions.join('；')}`)
    if (s.preInit.exclusions?.length > 0) lines.push(`- 明确不做：${s.preInit.exclusions.join('；')}`)
    if (s.preInit.anchors?.length > 0) lines.push(`- 锚点：${s.preInit.anchors.join('、')}`)
    if (s.preInit.openQuestions?.length > 0) lines.push(`- 待拍板：${s.preInit.openQuestions.join('；')}`)
  }
  if (s.pendingDecisions?.unresolved?.length > 0) {
    lines.push('', '### 未清空待拍板问题（须逐项问到零）')
    for (const u of s.pendingDecisions.unresolved.slice(0, 6)) {
      lines.push(`- L${u.line}: ${u.text}`)
    }
  }
  if (s.critique?.findings?.length > 0) {
    lines.push('', '### 本轮须闭环修改意见 / 退回 Findings')
    for (const f of s.critique.findings) lines.push(`- ${f}`)
  }
  const briefLines = formatContextBriefLines(s.contextBrief)
  if (briefLines.length > 0) {
    lines.push('', ...briefLines)
  }
  if (s.reviewChoices?.length > 0) {
    lines.push('', '### 人类最终拍板三态出口（仅主 Agent 可退出规划）')
    for (const ch of s.reviewChoices) lines.push(`- **${ch.label}**：\`${ch.command}\``)
  }

  lines.push('', '### 调度与断点防跑偏约束')
  if (role === 'planner' || role === 'implementer') {
    lines.push(
      `- **写手续聊优先**：优先向当前仍活跃或休眠的原 \`${role}\` 子代理直接发送更新指令（附上述文档路径与退回意见，要求先读盘面最新状态再修改）；若宿主不支持续聊或原会话已结束，再新建同角色子代理读盘面续作。`,
    )
    if (wt.exists && wt.dirtyCount > 0) {
      lines.push(
        `- **中断恢复红线**：检测到工作树 \`${wt.worktreePath}\` 留有 ${wt.dirtyCount} 处半成品改动（原认领者：${wt.activeActor ?? '未知'}）。主 Agent 严禁直接替子代理续写业务/文档或代提，必须唤醒原同角色子代理或新派同角色子代理带 \`--takeover --reason "subagent interrupted"\` 进原 worktree 接手。`,
      )
    }
  } else if (role === 'critic') {
    lines.push(`- **复审强制换新**：每次进入 \`needs-critique\` 必须**新建全新独立只读 critic 子代理**，严禁复用规划作者或任意历史轮次复核人（排除：${(s.critique?.excludedReviewers ?? []).join(', ') || '作者'}）。`)
  } else if (role === 'human') {
    lines.push('- **禁代拍与禁子代理擅自退场**：只有主 Agent 能在 `pendingDecisions` 归零后向用户发起最终三态确认，子代理不得越权批准或结束规划。')
  }
  if (deliveryMode === 'plan-only' || s.phase === 'plan-only-handoff') {
    lines.push('- **Plan-Only 团队交付**：仅合入纯规划文档 PR 到默认分支并保持 Master Issue 摘要同步，完成后立即停下，不要在本地擅自启动实施代码改动，交由其他成员各自认领 `readySlices`。')
  }
  lines.push('', `- **下一步命令**：\`${s.command ?? ''}\``)

  return {
    fields: {
      phase: s.phase,
      ownerRole: role,
      deliveryMode,
      taskId: s.taskId ?? null,
      docFile: s.doc?.file ?? null,
      worktreePath: wt.worktreePath ?? null,
      interruptedDirtyCount: wt.dirtyCount ?? 0,
      masterPrd: s.masterPrd?.file ?? null,
      excludedReviewers: s.critique?.excludedReviewers ?? [],
      findingsCount: s.critique?.findings?.length ?? 0,
      pendingCount: s.pendingDecisions?.unresolved?.length ?? 0,
      command: s.command ?? null,
    },
    prompt: `${lines.join('\n')}\n`,
  }
}
