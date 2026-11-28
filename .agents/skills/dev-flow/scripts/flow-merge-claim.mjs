/**
 * flow-merge-claim.mjs —— 任务认领/接管/释放、合并前溯源/视觉门检查与 1:N 总控 Issue 关单保护。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 flow-merge.mjs 以严守单文件 <= 800 行红线。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { buildContextBrief, extractDocBriefSeeds, formatContextBriefLines } from '../../lib/context-brief.mjs'
import { formatAttribution } from '../../lib/docs.mjs'
import { buildSliceGraph } from '../../lib/doc-slice-graph.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { gitRun, posixPath } from '../../lib/git.mjs'
import { readGitConfigFast } from '../../lib/git-fast.mjs'
import { isNonImplRoleActor, isValidActorName, resolveHostMode } from '../../lib/harness-context.mjs'
import { rememberPreviousImplementer, resolveTaskContext, sanitizeTaskId, updateTaskLedger, verifyPlanningProvenance } from '../../lib/ledger.mjs'
import { collectMasterIssueCriteriaState } from '../../lib/master-criteria-sync.mjs'
import {
  detectDeclaredRepo, isVerifiedTier, parseFlowInputs, parseIssueNumbers, parsePfStateTags, parsePrNumber,
  parseRemoteUrls, probeForWrite, resolveIdentityLayers,
} from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext, syncTaskDocsSafe } from './flow-context.mjs'

export { collectMasterIssueCriteriaState }

const TERMINAL_SLICE_STATUSES = new Set(['implemented', 'done', 'superseded', 'dropped', 'archived'])

/** 解析 Issue 评论流中的最新有效认领状态（claim/takeover 激活，release 释放）。 */
export function analyzeIssueClaimState(comments = []) {
  let activeClaim = null
  for (const c of Array.isArray(comments) ? comments : []) {
    const states = Array.isArray(c?.pfStates) && c.pfStates.length > 0 ? c.pfStates : (c?.pfState ? [c.pfState] : parsePfStateTags(c?.body ?? ''))
    for (const st of states) {
      const action = String(st?.action ?? '').toLowerCase()
      if (action === 'claim' || action === 'takeover') {
        activeClaim = {
          action, actor: st.agent || st.actor || st.owner || c?.author || null,
          account: st.account ?? null,
          verifiedPlatformLogin: Boolean(st.verifiedPlatformLogin),
          agent: st.agent ?? null,
          login: c?.author ?? null, taskId: st.taskId ?? null, branch: st.branch ?? null,
          reason: st.reason ?? null, commentId: c?.id ?? null, createdAt: c?.createdAt ?? null,
        }
      } else if (action === 'release') {
        const relActor = st.agent || st.actor || c?.author || null
        if (!activeClaim || !relActor || !activeClaim.actor
          || String(relActor).toLowerCase() === String(activeClaim.actor).toLowerCase()
          || (c?.author && activeClaim.login && c.author.toLowerCase() === activeClaim.login.toLowerCase())
          || (st.taskId && activeClaim.taskId && st.taskId === activeClaim.taskId)) {
          activeClaim = null
        }
      }
    }
  }
  return activeClaim
}

function isSameClaimant(activeClaim, actor, viewerLogin) {
  if (!activeClaim) return true
  const aNorm = String(actor ?? '').trim().toLowerCase()
  const cNorm = String(activeClaim.actor ?? '').trim().toLowerCase()
  if (cNorm && aNorm) return cNorm === aNorm
  if (viewerLogin && activeClaim.login) return String(viewerLogin).trim().toLowerCase() === String(activeClaim.login).trim().toLowerCase()
  return false
}

/** 校验认领与合并前规划溯源基线及作者/实施者分离（拒绝手工篡改 `owner:` 与自建自改）。 */
export function assertClaimOrMergeProvenance({
  mainRoot, docRoot = mainRoot, ledger = {}, taskId = null, actor = null, opts = {},
} = {}) {
  const hostMode = resolveHostMode(opts)
  const humanApproved = Boolean(opts['human-approved'])
  const caseNum = Number(ledger?.caseType ?? 3)
  const cleanActor = isValidActorName(actor) ? String(actor).trim() : null

  if (cleanActor && caseNum >= 2 && hostMode !== 'single-session' && isNonImplRoleActor(cleanActor)) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_MISSING_ACTOR',
      exitCode: EXIT.USAGE,
      reason: `Case ${caseNum} 多代理模式下，实施认领者（${cleanActor}）不能为调度协调者或审查角色。`,
    }
  }

  const docRels = [ledger?.specFile, ledger?.todoFile, ledger?.prdFile].filter(Boolean)
  const effectiveDocRoot = docRels.some((rel) => existsSync(resolve(docRoot, rel))) ? docRoot : mainRoot
  return verifyPlanningProvenance({
    mainRoot,
    docRoot: effectiveDocRoot,
    docRels,
    taskId: taskId ?? ledger?.taskId ?? null,
    ledger,
    implementerId: cleanActor,
    hostMode,
    humanApproved,
    isGit: existsSync(resolve(mainRoot, '.git')),
  })
}

/**
 * Root Cause B：1:N 总控 Issue 关单保护。
 * 经 `buildSliceGraph(mainRoot)` 检查关联 Issue 是否对应 `multi_spec: true` 总控 PRD 且仍有未完成兄弟切片；
 * 只要还有任意兄弟切片未完（`!done && !archived`），严禁自动关闭总控 Issue（仅记录进展）。
 */
export function evaluateMasterIssueCloseGuard({
  mainRoot,
  implRoot = null,
  issueNumber,
  ledger = {},
  taskId = null,
  baseBranch = null,
} = {}) {
  const issNum = Number(issueNumber)
  if (!mainRoot || !Number.isInteger(issNum) || issNum <= 0) {
    return { shouldClose: true, isMasterPrd: false, remainingSiblings: [], progressNote: null }
  }
  const graph = buildSliceGraph(mainRoot)
  const prds = [...(graph.masters ?? []), ...(graph.prds ?? [])]
    .filter((p) => p && p.data?.multi_spec === true)
  if (prds.length === 0) {
    return { shouldClose: true, isMasterPrd: false, remainingSiblings: [], progressNote: null }
  }

  const implSliceState = new Map()
  let implGraph = null
  if (implRoot && existsSync(implRoot)) {
    try {
      implGraph = buildSliceGraph(implRoot)
      for (const s of implGraph.slices ?? []) {
        if (s.kind === 'spec' && s.key) implSliceState.set(s.key, s)
      }
    } catch { /* ignore */ }
  }

  const ledgerPrdNorm = ledger?.prdFile ? posixPath(ledger.prdFile) : (ledger?.archivedPrdFile ? posixPath(ledger.archivedPrdFile) : null)
  const ledgerSpecNorm = ledger?.specFile ? posixPath(ledger.specFile) : (ledger?.archivedSpecFile ? posixPath(ledger.archivedSpecFile) : null)
  const allSlices = [...(graph.slices ?? []), ...(implGraph?.slices ?? [])]
  const isSliceSpecIssue = allSlices.some((s) => s.kind === 'spec' && Number(s.data?.issue) === issNum)
  const isSliceTaskOwnIssue = Boolean(ledgerSpecNorm) && ledger?.planBootstrap !== true
  const master = prds.find((p) => {
    const masterIssue = Number(p.data?.issue)
    if (Number.isInteger(masterIssue) && masterIssue > 0) return masterIssue === issNum
    if (isSliceSpecIssue || isSliceTaskOwnIssue) return false
    if (ledgerPrdNorm && (posixPath(p.rel) === ledgerPrdNorm || posixPath(p.rel).endsWith(`/${ledgerPrdNorm.split('/').pop()}`))) return true
    return false
  })
  if (!master) {
    return { shouldClose: true, isMasterPrd: false, remainingSiblings: [], progressNote: null }
  }

  if (ledger?.planBootstrap === true) {
    return {
      shouldClose: false,
      isMasterPrd: true,
      masterPrd: master.rel,
      reason: 'plan-bootstrap-master-issue',
      remainingSiblings: [],
      progressNote: `[规划引导合并保护] 本 PR 为总控 PRD \`${master.rel}\` 的规划引导拆分（planBootstrap），保留 Master Issue #${issNum} 开启。`,
    }
  }

  const siblings = (graph.slices ?? []).filter((s) => s.kind === 'spec' && s.masterRel === master.rel)
  const remainingSiblings = []
  for (const sib of siblings) {
    const implOverlay = sib.key ? implSliceState.get(sib.key) : null
    const st = String(implOverlay?.status ?? sib.status ?? '').toLowerCase()
    const isSelf = (taskId && sib.key === taskId)
      || (ledgerSpecNorm && (posixPath(sib.rel) === ledgerSpecNorm || posixPath(sib.rel).split('/').pop() === ledgerSpecNorm.split('/').pop()))
    const isTerminal = isSelf || Boolean(sib.done || sib.archived || implOverlay?.done || implOverlay?.archived || TERMINAL_SLICE_STATUSES.has(st))
    if (!isTerminal) {
      remainingSiblings.push({
        taskId: sib.key,
        rel: sib.rel,
        status: st || 'pending',
      })
    }
  }

  if (remainingSiblings.length > 0) {
    const baseLabel = baseBranch || ledger?.baseBranch || '默认基线'
    const names = remainingSiblings.map((s) => `\`${s.taskId}\` (${s.status})`).join('、')
    const progressNote = [
      `[1:N 切片合并进展] 切片 \`${taskId ?? ledger?.taskId ?? 'unknown'}\` 已合入 \`${baseLabel}\`。`,
      `- 关联总控 PRD：\`${master.rel}\`（\`multi_spec: true\`）`,
      `- 尚有 ${remainingSiblings.length} 个未完成兄弟切片：${names}`,
      `- 按总控关单保护门禁保留 Issue #${issNum} 开启，待全部兄弟切片达成终态后自动关闭。`,
    ].join('\n')
    return {
      shouldClose: false,
      isMasterPrd: true,
      masterPrd: master.rel,
      reason: 'master-prd-incomplete-slices',
      remainingSiblings,
      progressNote,
    }
  }

  return {
    shouldClose: true,
    isMasterPrd: true,
    masterPrd: master.rel,
    reason: 'all-slices-terminal',
    remainingSiblings: [],
    progressNote: null,
  }
}

const claimRef = (taskId) => `refs/pf/claims/${sanitizeTaskId(taskId)}`
const claimWildcardSpec = () => ['+refs/pf/claims/', '*:refs/pf/claims/', '*'].join('')
const claimRemote = (remoteUrls, role) => (!remoteUrls || Object.keys(remoteUrls).length === 0 || role === 'local-only') ? null : (remoteUrls.origin ? 'origin' : Object.keys(remoteUrls)[0])
export async function fetchGitClaimRefs(mainRoot, { remoteUrls = {}, role = 'local-only', branch = null, opts = {} } = {}) {
  const remote = claimRemote(remoteUrls, role)
  if (!remote || opts?.['skip-fetch'] || opts?._ghClient) return { ok: false, skipped: true, remote }
  const res = await gitRun(mainRoot, ['fetch', '--no-tags', remote, claimWildcardSpec()]).catch(() => ({ ok: false }))
  if (branch) await gitRun(mainRoot, ['fetch', '--no-tags', remote, branch]).catch(() => null)
  return { ok: Boolean(res?.ok), remote }
}
export async function readGitClaimLease(mainRoot, taskId) {
  const ref = claimRef(taskId)
  const show = await gitRun(mainRoot, ['show-ref', '--verify', '--', ref]).catch(() => ({ ok: false, stdout: '' }))
  if (!show?.ok) return null
  const oid = show.stdout.trim().split(/\s+/)[0]
  const body = await gitRun(mainRoot, ['log', '-1', '--format=%B', oid]).catch(() => ({ ok: false, stdout: '' }))
  try { return { ref, oid, ...(JSON.parse(body.stdout.trim() || '{}')) } } catch { return { ref, oid } }
}
export async function acquireGitClaimLease(mainRoot, taskId, payload = {}, { remoteUrls = {}, role = 'local-only', takeover = false, opts = {} } = {}) {
  await fetchGitClaimRefs(mainRoot, { remoteUrls, role, branch: payload.branch, opts })
  const existing = await readGitClaimLease(mainRoot, taskId)
  const nextActor = String(payload.actor || payload.agent || payload.account || '').trim().toLowerCase()
  const prevActor = String(existing?.actor || existing?.agent || existing?.account || '').trim().toLowerCase()
  if (existing && !takeover && (!prevActor || !nextActor || prevActor !== nextActor)) return { ok: false, blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', lease: existing }
  const treeRes = await gitRun(mainRoot, ['mktree'], { input: '' }).catch(() => ({ ok: false, stdout: '' }))
  const treeOid = (treeRes?.ok && treeRes.stdout.trim()) ? treeRes.stdout.trim() : '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
  const commit = await gitRun(mainRoot, ['-c', 'user.name=pf', '-c', 'user.email=pf@local', 'commit-tree', treeOid, '-m', JSON.stringify(payload)])
  if (!commit.ok) return { ok: true, skipped: true }
  const newOid = commit.stdout.trim()
  const ref = claimRef(taskId)
  const cas = await gitRun(mainRoot, ['update-ref', ref, newOid, existing?.oid ?? ''])
  if (!cas.ok) return { ok: false, blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', lease: await readGitClaimLease(mainRoot, taskId) }
  const remote = claimRemote(remoteUrls, role)
  if (remote && !opts?.['skip-push'] && !opts?._ghClient) {
    const pushRes = await gitRun(mainRoot, ['push', remote, `${ref}:${ref}`, `--force-with-lease=${ref}:${existing?.oid ?? ''}`])
    if (!pushRes.ok && /(stale info|rejected|failed to push)/i.test(pushRes.stderr || '')) {
      await gitRun(mainRoot, existing?.oid ? ['update-ref', ref, existing.oid] : ['update-ref', '-d', ref]).catch(() => null)
      await fetchGitClaimRefs(mainRoot, { remoteUrls, role, opts })
      return { ok: false, blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', lease: await readGitClaimLease(mainRoot, taskId) }
    }
  }
  return { ok: true, ref, oid: newOid }
}
export async function releaseGitClaimLease(mainRoot, taskId, { remoteUrls = {}, role = 'local-only', opts = {} } = {}) {
  const ref = claimRef(taskId)
  await gitRun(mainRoot, ['update-ref', '-d', ref]).catch(() => null)
  const remote = claimRemote(remoteUrls, role)
  if (remote && !opts?.['skip-push'] && !opts?._ghClient) await gitRun(mainRoot, ['push', remote, `:${ref}`]).catch(() => null)
}

export async function handleRelease(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const reason = String(opts.reason ?? '').trim()

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const targetCtx = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, null, { cwd: roots.mainRoot, providerHint: ledger.providerId })
  const { targetRepo } = targetCtx

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || targetCtx.capabilities?.api !== true || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
  const releaseResults = []
  if (!skipApi) {
    const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
    const ghClient = opts._ghClient ?? ghProbe.client
    const backend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, client: ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const relLayers = resolveIdentityLayers({
      explicitAgent: opts.agent,
      ghLogin: ghProbe.env?.trackB?.login ?? ghClient?.login,
      ghTier: ghProbe.env?.trackB?.tier ?? ghClient?.tier ?? (ghClient ? 'authenticated' : null),
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const actorDisplay = formatAttribution({ ...relLayers, capabilities: backend.capabilities })
    const rel = await backend.releaseTask({
      taskId, issues: ledger.linkedIssues,
      account: relLayers.account, verifiedPlatformLogin: relLayers.verifiedPlatformLogin, agent: relLayers.agent,
      actor: relLayers.agent || relLayers.account, actorDisplay, branch: ledger.branch, reason,
    })
    releaseResults.push(...(rel.results ?? []))
  } else {
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const relLayers = resolveIdentityLayers({
      explicitAgent: opts.agent,
      ledgerAccount: ledger.account,
      ledgerAgent: ledger.agent ?? ledger.claimedBy ?? ledger.implementerId,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const actorDisplay = formatAttribution({ ...relLayers, capabilities: localBackend.capabilities })
    await localBackend.releaseTask({
      taskId, issues: ledger.linkedIssues,
      account: relLayers.account, verifiedPlatformLogin: relLayers.verifiedPlatformLogin, agent: relLayers.agent,
      actor: relLayers.agent || relLayers.account, actorDisplay, branch: ledger.branch, reason,
    })
  }

  ledger.status = 'released'
  ledger.releasedAt = new Date().toISOString()
  ledger.releaseReason = reason || null
  ledger.claimedAt = null
  ledger.claimedBy = null
  await releaseGitClaimLease(roots.mainRoot, taskId, { remoteUrls, role: ledger.role, opts })
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  const releaseNext = [
    { skill: 'dev-flow', text: `如需由其他人接手：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --agent <agent>` },
    { skill: 'dev-flow', text: `或安全放弃任务与工作区：node ".agents/skills/dev-flow/scripts/flow.mjs" abort --task ${taskId} --confirm` },
  ]
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps({ ok: true, taskId, role: ledger.role, mode: skipApi ? 'local-ledger-only' : 'remote-synced', status: ledger.status, reason: ledger.releaseReason, releaseResults }, releaseNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已释放认领（status=released${skipApi ? '，仅本地账本' : `, issues=${ledger.linkedIssues.join(',')}`}）。\n`)
    printNextStep(releaseNext, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}

function buildClaimNextSteps(ledger, taskId) {
  const slotLabel = ledger?.worktreePath ? posixPath(ledger.worktreePath) : '当前工作区'
  return [
    { skill: 'dev-edit', text: `1. 在隔离工作位 ${slotLabel} 内完成修改并运行编辑门禁自检：node ".agents/skills/dev-edit/scripts/edit-gate.mjs" --changed --json` },
    { skill: 'dev-flow', text: `2. 改动完成后执行归档与提交前同步：node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}` },
    { skill: 'dev-flow', text: `3. 提交后运行分层实证锁定当前 HEAD：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` },
  ]
}

function computeClaimContextBrief(roots, claimRoot, ledger, taskId) {
  const docRels = [ledger?.specFile, ledger?.todoFile, ledger?.prdFile].filter(Boolean)
  const seeds = extractDocBriefSeeds([claimRoot, roots?.mainRoot], docRels)
  const paths = [...new Set([...seeds.paths, ...(Array.isArray(ledger?.files) ? ledger.files : [])])]
  const keywords = [taskId, ledger?.slug, ...seeds.keywords].filter(Boolean)
  const briefRoot = claimRoot && existsSync(claimRoot) ? claimRoot : (roots?.mainRoot ?? claimRoot)
  return buildContextBrief(briefRoot, { paths, keywords, excludeFiles: docRels })
}

export async function handleClaim(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const parsedPos = parseFlowInputs(opts._ ?? [])
  const extraIssues = [
    ...(opts.issue || opts.issues ? parseIssueNumbers([opts.issue, opts.issues], { strict: true }) : []),
    ...parsedPos.issues.map((i) => i.number),
  ]
  if (extraIssues.length > 0) ledger.linkedIssues = [...new Set([...(ledger.linkedIssues ?? []), ...extraIssues])]
  const claimPr = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : (parsedPos.prs[0]?.number ?? null)
  if (claimPr) ledger.prNumber = claimPr

  const isTakeover = Boolean(opts.takeover)
  const takeoverReason = String(opts.reason ?? '').trim()
  if (isTakeover && !takeoverReason) {
    process.stderr.write('BLOCKED_TAKEOVER_REASON_REQUIRED: --takeover 必须同时传入 --reason "<接管原因>"。\n')
    return { exitCode: EXIT.FACT }
  }
  if (isTakeover && !isValidActorName(opts.agent)) {
    const msg = 'BLOCKED_MISSING_ACTOR: --takeover 接管认领必须显式指定合法 --agent <id>，禁止匿名回退旧实施者。'
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_MISSING_ACTOR', reason: msg }, null, 2)}\n`)
    process.stderr.write(`${msg}\n`)
    return { exitCode: EXIT.USAGE }
  }

  const rawPrevAgent = ledger.agent ?? ledger.claimedBy ?? ledger.implementerId ?? null
  const prevAgent = (rawPrevAgent && String(rawPrevAgent).trim() !== 'local-agent') ? String(rawPrevAgent).trim() : null
  const claimRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const explicitOrAgent = String(opts.agent ?? '').trim() || prevAgent || null
  const provGate = assertClaimOrMergeProvenance({
    mainRoot: roots.mainRoot, docRoot: claimRoot, ledger, taskId, actor: explicitOrAgent, opts,
  })
  if (provGate.blocked) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, ...provGate }, null, 2)}\n`)
    process.stderr.write(`${provGate.code}: ${provGate.reason}\n`)
    return { exitCode: provGate.exitCode ?? EXIT.FACT }
  }

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const targetCtx = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, null, { cwd: roots.mainRoot, providerHint: ledger.providerId })
  const { targetRepo } = targetCtx

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || targetCtx.capabilities?.api !== true || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
  if (skipApi) {
    const gitNameRes = await gitRun(roots.mainRoot, ['config', 'user.name']).catch(() => ({ ok: false, stdout: '' }))
    const localLayers = resolveIdentityLayers({
      explicitAgent: opts.agent,
      gitName: gitNameRes.ok ? gitNameRes.stdout.trim() : null,
      ledgerAccount: ledger.account,
      ledgerAgent: prevAgent,
      ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
    })
    const nextLocalActor = String(opts.agent ?? '').trim() || localLayers.agent || localLayers.account || null
    if (nextLocalActor) {
      ledger.previousImplementers = rememberPreviousImplementer(ledger, nextLocalActor)
    }
    if (localLayers.account) {
      ledger.account = localLayers.account
      ledger.verifiedPlatformLogin = localLayers.verifiedPlatformLogin
    }
    if (localLayers.agent) {
      ledger.agent = localLayers.agent
      ledger.implementerId = localLayers.agent
    } else if (!ledger.implementerId && localLayers.account) {
      ledger.implementerId = localLayers.account
    }
    if ((ledger.linkedIssues ?? []).length > 0 && existsSync(claimRoot)) {
      await syncTaskDocsSafe(claimRoot, ledger)
    }
    const localBackend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
    const actorDisplay = formatAttribution({ ...localLayers, capabilities: localBackend.capabilities })
    const localClaim = await localBackend.claimTask({
      taskId, issues: ledger.linkedIssues, prNumber: ledger.prNumber,
      account: localLayers.account, verifiedPlatformLogin: localLayers.verifiedPlatformLogin, agent: localLayers.agent,
      actor: localLayers.agent || localLayers.account, actorDisplay, branch: ledger.branch,
      takeover: isTakeover, reason: takeoverReason,
    })
    if (localClaim?.blocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, taskId, ...localClaim }, null, 2)}\n`)
      process.stderr.write(`${localClaim.message}\n`)
      return { exitCode: localClaim.exitCode ?? EXIT.FACT }
    }
    const casClaim = await acquireGitClaimLease(roots.mainRoot, taskId, {
      taskId, actor: String(opts.agent ?? '').trim() || localLayers.agent || localLayers.account || null,
      branch: ledger.branch, claimedAt: new Date().toISOString(), takeover: isTakeover,
    }, { remoteUrls, role: ledger.role, takeover: isTakeover, opts })
    if (casClaim?.blocked) {
      const msg = `BLOCKED_ISSUE_ALREADY_CLAIMED: 任务 ${taskId} 的 Git 租约 ${casClaim.lease?.ref ?? ''} 已被 ${casClaim.lease?.actor ?? '他人'} 持有，如需接管请传 --takeover --agent <id> --reason "<原因>"。`
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', taskId, lease: casClaim.lease }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT }
    }
    ledger.status = 'claimed'
    ledger.claimedAt = new Date().toISOString()
    ledger.claimedBy = localLayers.agent || localLayers.account || String(opts.agent ?? '').trim() || null
    if (isTakeover) {
      ledger.takeoverReason = takeoverReason
      ledger.takenOverAt = ledger.claimedAt
    }
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    const contextBrief = computeClaimContextBrief(roots, claimRoot, ledger, taskId)
    const localClaimNext = buildClaimNextSteps(ledger, taskId)
    if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps({ taskId, role: ledger.role, mode: 'local-ledger-only', status: ledger.status, takeover: isTakeover, contextBrief }, localClaimNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
    else {
      process.stdout.write(`已在本地账本登记认领（role=${ledger.role}，未触碰平台 API）。\n`)
      const briefLines = formatContextBriefLines(contextBrief)
      if (briefLines.length > 0) process.stdout.write(`${briefLines.join('\n')}\n`)
      printNextStep(localClaimNext, { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
  const ghClient = opts._ghClient ?? ghProbe.client
  const backend = createTaskBackend({ role: ledger.role, providerId: ledger.providerId, targetRepo, client: ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir })
  const onlineLayers = resolveIdentityLayers({
    explicitAgent: opts.agent,
    ghLogin: ghProbe.env?.trackB?.login ?? ghClient?.login,
    ghTier: ghProbe.env?.trackB?.tier ?? ghClient?.tier ?? (ghClient ? 'authenticated' : null),
    ledgerAccount: ledger.account,
    ledgerAgent: prevAgent,
    ledgerVerifiedPlatformLogin: ledger.verifiedPlatformLogin,
  })
  const nextOnlineActor = String(opts.agent ?? '').trim() || onlineLayers.agent || onlineLayers.account || null
  if (nextOnlineActor) {
    ledger.previousImplementers = rememberPreviousImplementer(ledger, nextOnlineActor)
  }
  if (onlineLayers.account) {
    ledger.account = onlineLayers.account
    ledger.verifiedPlatformLogin = onlineLayers.verifiedPlatformLogin
  }
  if (onlineLayers.agent) {
    ledger.agent = onlineLayers.agent
    ledger.implementerId = onlineLayers.agent
  } else if (!ledger.implementerId && onlineLayers.account) {
    ledger.implementerId = onlineLayers.account
  }
  if ((ledger.linkedIssues ?? []).length > 0 && existsSync(claimRoot)) {
    await syncTaskDocsSafe(claimRoot, ledger)
  }
  const actorKey = onlineLayers.agent || onlineLayers.account
  const actorDisplay = formatAttribution({ ...onlineLayers, capabilities: backend.capabilities })
  const canQueryComments = Boolean(opts._ghClient) || isVerifiedTier(ghProbe?.env?.trackB?.tier)
  const activeClaimsByIssue = new Map()
  if (canQueryComments) {
    for (const num of ledger.linkedIssues) {
      const listRes = await backend.listComments({ repo: targetRepo, number: num })
      if (!listRes.ok) continue
      const activeClaim = analyzeIssueClaimState(listRes.comments)
      if (activeClaim && !isSameClaimant(activeClaim, actorKey, ghProbe.env.trackB.login)) {
        if (!isTakeover) {
          const takeoverCmd = `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --takeover --agent <id> --reason "<接管原因>"`
          if (opts.json) {
            process.stdout.write(`${JSON.stringify(withNextSteps({
              blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', taskId, issue: num, activeClaim,
              nextStep: takeoverCmd,
            }, [{ skill: 'dev-flow', text: takeoverCmd }], { repoRoot: roots.mainRoot }), null, 2)}\n`)
          }
          process.stderr.write(`BLOCKED_ISSUE_ALREADY_CLAIMED: Issue #${num} 已被 ${activeClaim.actor ?? activeClaim.login ?? '他人'} 认领（分支=${activeClaim.branch ?? '未知'}），且尚无 release/takeover；如需接管请传 --takeover --agent <id> --reason "<接管原因>"。\n`)
          return { exitCode: EXIT.FACT }
        }
        activeClaimsByIssue.set(num, activeClaim)
      }
    }
  }

  const casClaim = await acquireGitClaimLease(roots.mainRoot, taskId, {
    taskId, actor: String(opts.agent ?? '').trim() || actorKey || null,
    branch: ledger.branch, claimedAt: new Date().toISOString(), takeover: isTakeover,
  }, { remoteUrls, role: ledger.role, takeover: isTakeover, opts })
  if (casClaim?.blocked) {
    const msg = `BLOCKED_ISSUE_ALREADY_CLAIMED: 任务 ${taskId} 的 Git 租约 ${casClaim.lease?.ref ?? ''} 已被 ${casClaim.lease?.actor ?? '他人'} 持有，如需接管请传 --takeover --agent <id> --reason "<原因>"。`
    if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', taskId, lease: casClaim.lease }, null, 2)}\n`)
    process.stderr.write(`${msg}\n`)
    return { exitCode: EXIT.FACT }
  }

  const prevClaim = [...activeClaimsByIssue.values()][0] ?? null
  const prevActors = [...activeClaimsByIssue.values()].map((c) => c.agent ?? c.actor ?? c.login).filter(Boolean)
  if (isTakeover && prevActors.length > 0 && nextOnlineActor) {
    for (const prev of prevActors) {
      ledger.previousImplementers = rememberPreviousImplementer(
        { previousImplementers: ledger.previousImplementers, implementerId: prev },
        nextOnlineActor,
      )
    }
  }
  const claimOut = await backend.claimTask({
    taskId, issues: ledger.linkedIssues, prNumber: ledger.prNumber,
    account: onlineLayers.account, verifiedPlatformLogin: onlineLayers.verifiedPlatformLogin,
    agent: onlineLayers.agent, actor: actorKey, actorDisplay, branch: ledger.branch,
    takeover: isTakeover, reason: takeoverReason,
    previousActor: prevActors[0] ?? null, previousAccount: prevClaim?.account ?? null,
    previousVerifiedPlatformLogin: Boolean(prevClaim?.verifiedPlatformLogin),
    previousAgent: prevClaim?.agent ?? prevActors[0] ?? null,
  })
  const claimResults = claimOut.results ?? []
  const prTakeoverResult = claimOut.prResult ?? null

  ledger.status = 'claimed'
  ledger.claimedAt = new Date().toISOString()
  ledger.claimedBy = onlineLayers.agent || onlineLayers.account || String(opts.agent ?? '').trim() || null
  if (isTakeover) {
    ledger.takeoverReason = takeoverReason
    ledger.takenOverAt = ledger.claimedAt
  }
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  const contextBrief = computeClaimContextBrief(roots, claimRoot, ledger, taskId)
  const claimNext = buildClaimNextSteps(ledger, taskId)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps({ taskId, role: ledger.role, targetRepo, takeover: isTakeover, claimResults, ...(prTakeoverResult ? { prTakeoverResult } : {}), contextBrief }, claimNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已${isTakeover ? '接管' : '认领'}（target=${targetRepo}, issues=${ledger.linkedIssues.join(',')}）。\n`)
    const briefLines = formatContextBriefLines(contextBrief)
    if (briefLines.length > 0) process.stdout.write(`${briefLines.join('\n')}\n`)
    printNextStep(claimNext, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}
