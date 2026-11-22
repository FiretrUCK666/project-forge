/**
 * flow-merge-claim.mjs —— 任务认领/接管/释放、合并前溯源/视觉门检查与 1:N 总控 Issue 关单保护。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 flow-merge.mjs 以严守单文件 <= 800 行红线。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { formatAttribution } from '../../lib/docs.mjs'
import { buildSliceGraph } from '../../lib/doc-slice-graph.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { gitRun, posixPath } from '../../lib/git.mjs'
import { readGitConfigFast } from '../../lib/git-fast.mjs'
import { isNonImplRoleActor, isValidActorName, resolveHostMode } from '../../lib/harness-context.mjs'
import { rememberPreviousImplementer, resolveTaskContext, updateTaskLedger, verifyPlanningProvenance } from '../../lib/ledger.mjs'
import {
  detectDeclaredRepo, parseFlowInputs, parseIssueNumbers, parsePfStateTags, parsePrNumber, parseRemoteUrls,
  probeForWrite, resolveIdentityLayers,
} from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext } from './flow-inspect.mjs'

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
  baseBranch = 'main',
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

  const ledgerPrdNorm = ledger?.prdFile ? posixPath(ledger.prdFile) : (ledger?.archivedPrdFile ? posixPath(ledger.archivedPrdFile) : null)
  const ledgerSpecNorm = ledger?.specFile ? posixPath(ledger.specFile) : (ledger?.archivedSpecFile ? posixPath(ledger.archivedSpecFile) : null)
  const master = prds.find((p) => {
    if (Number(p.data?.issue) === issNum) return true
    if (ledgerPrdNorm && (posixPath(p.rel) === ledgerPrdNorm || posixPath(p.rel).endsWith(`/${ledgerPrdNorm.split('/').pop()}`))) return true
    return (graph.slices ?? []).some((s) => s.kind === 'spec' && s.masterRel === p.rel && Number(s.data?.issue) === issNum)
  })
  if (!master) {
    return { shouldClose: true, isMasterPrd: false, remainingSiblings: [], progressNote: null }
  }

  const implSliceState = new Map()
  if (implRoot && existsSync(implRoot)) {
    try {
      const implGraph = buildSliceGraph(implRoot)
      for (const s of implGraph.slices ?? []) {
        if (s.kind === 'spec' && s.key) implSliceState.set(s.key, s)
      }
    } catch { /* ignore */ }
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
    const names = remainingSiblings.map((s) => `\`${s.taskId}\` (${s.status})`).join('、')
    const progressNote = [
      `[1:N 切片合并进展] 切片 \`${taskId ?? ledger?.taskId ?? 'unknown'}\` 已合入 \`${baseBranch}\`。`,
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

export async function handleRelease(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const reason = String(opts.reason ?? '').trim()

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
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
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, taskId, role: ledger.role, mode: skipApi ? 'local-ledger-only' : 'remote-synced', status: ledger.status, reason: ledger.releaseReason, releaseResults }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已释放认领（status=released${skipApi ? '，仅本地账本' : `, issues=${ledger.linkedIssues.join(',')}`}）。\n`)
    printNextStep([
      { skill: 'dev-flow', text: `如需由其他人接手：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --agent <agent>` },
      { skill: 'dev-flow', text: `或安全放弃任务与工作区：node ".agents/skills/dev-flow/scripts/flow.mjs" abort --task ${taskId} --confirm` },
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
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

  const prevAgent = ledger.agent ?? ledger.claimedBy ?? ledger.implementerId ?? null
  const claimRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const explicitOrAgent = String(opts.agent ?? '').trim() || (prevAgent && prevAgent !== 'local-agent' ? String(prevAgent).trim() : null)
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
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)

  const skipApi = ledger.role === 'local-only' || ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || (ledger.linkedIssues ?? []).length === 0 || !targetRepo
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
      const { syncTaskDocsSafe } = await import('./flow-inspect.mjs')
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
    ledger.status = 'claimed'
    ledger.claimedAt = new Date().toISOString()
    ledger.claimedBy = String(opts.agent ?? '').trim() || localLayers.agent || localLayers.account || null
    if (isTakeover) {
      ledger.takeoverReason = takeoverReason
      ledger.takenOverAt = ledger.claimedAt
    }
    await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
    if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, mode: 'local-ledger-only', status: ledger.status, takeover: isTakeover }, null, 2)}\n`)
    else {
      process.stdout.write(`已在本地账本登记认领（role=${ledger.role}，未触碰平台 API）。\n`)
      const nextCmd = `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}`
      printNextStep([{ skill: 'dev-flow', text: nextCmd }], { repoRoot: roots.mainRoot })
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
    const { syncTaskDocsSafe } = await import('./flow-inspect.mjs')
    await syncTaskDocsSafe(claimRoot, ledger)
  }
  const actorKey = onlineLayers.agent || onlineLayers.account
  const actorDisplay = formatAttribution({ ...onlineLayers, capabilities: backend.capabilities })
  const canQueryComments = Boolean(opts._ghClient) || ghProbe.env.trackB.tier === 'gh-cli' || ghProbe.env.trackB.tier === 'node-https-token'
  const activeClaimsByIssue = new Map()
  if (canQueryComments) {
    for (const num of ledger.linkedIssues) {
      const listRes = await backend.listComments({ repo: targetRepo, number: num })
      if (!listRes.ok) continue
      const activeClaim = analyzeIssueClaimState(listRes.comments)
      if (activeClaim && !isSameClaimant(activeClaim, actorKey, ghProbe.env.trackB.login)) {
        if (!isTakeover) {
          if (opts.json) {
            process.stdout.write(`${JSON.stringify({
              blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', taskId, issue: num, activeClaim,
              nextStep: `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${taskId} --takeover --reason "<接管原因>"`,
            }, null, 2)}\n`)
          }
          process.stderr.write(`BLOCKED_ISSUE_ALREADY_CLAIMED: Issue #${num} 已被 ${activeClaim.actor ?? activeClaim.login ?? '他人'} 认领（分支=${activeClaim.branch ?? '未知'}），且尚无 release/takeover；如需接管请传 --takeover --reason "<接管原因>"。\n`)
          return { exitCode: EXIT.FACT }
        }
        activeClaimsByIssue.set(num, activeClaim)
      }
    }
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
  ledger.claimedBy = String(opts.agent ?? '').trim() || onlineLayers.agent || onlineLayers.account || null
  if (isTakeover) {
    ledger.takeoverReason = takeoverReason
    ledger.takenOverAt = ledger.claimedAt
  }
  await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...(cur ?? ledger), ...ledger }), { createIfMissing: true })
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, targetRepo, takeover: isTakeover, claimResults, ...(prTakeoverResult ? { prTakeoverResult } : {}) }, null, 2)}\n`)
  } else {
    process.stdout.write(`任务 ${taskId} 已${isTakeover ? '接管' : '认领'}（target=${targetRepo}, issues=${ledger.linkedIssues.join(',')}）。\n`)
    const nextCmd = `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${taskId}`
    printNextStep([{ skill: 'dev-flow', text: nextCmd }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK }
}
