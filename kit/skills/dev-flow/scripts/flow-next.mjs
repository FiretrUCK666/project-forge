/**
 * flow-next.mjs —— 单一入口 `flow.mjs next [--task id] [--probe-auth] [--json]` 状态路由与惰性水合。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），保持默认无外网 <= 300ms 预算。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { hasSkillSupport, printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { collectExcludedReviewers } from '../../lib/critique-rounds.mjs'
import { gitRun, readJsonSafe } from '../../lib/git.mjs'
import { readGitConfigFast } from '../../lib/git-fast.mjs'
import { buildHandoff } from '../../lib/handoff-package.mjs'
import { buildPlanHandoff, evaluatePlanNextState } from '../../lib/plan-next.mjs'
import { buildSessionOrientation } from '../../lib/session-orient.mjs'
import { readSessionState } from '../../lib/session-state.mjs'
import { getVisualBriefSummary } from '../../lib/visual-brief.mjs'
import { collectTaskLivenessBuckets, ensureReviewToken, nextReviewRound, rememberPreviousImplementer, resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import { detectDeclaredRepo, detectGitModeMarkers, isVerifiedTier, parsePfStateTags, parseRemotesTopology, parseRemoteUrls, probeForWrite } from '../../lib/platform.mjs'
import { computeSignalFingerprint, readSignalsJsonl } from '../../lib/signals.mjs'
import { evaluateNextState } from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, detectRemoteDriftWarnings, getChangedFiles } from './flow-context.mjs'
import { collectTaskRuntimeSnapshot } from './flow-lifecycle-helpers.mjs'

async function hydrateRemotePfState({ roots, ledger, opts }) {
  if (!opts['probe-auth']) return { rehydrated: false }
  if (process.env.PF_NO_REAL_AUTH_PROBE === '1' && !opts._ghClient && !opts._ghProbe) {
    return { rehydrated: false, reason: 'PF_NO_REAL_AUTH_PROBE' }
  }
  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const targetCtx = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, null, { cwd: roots.mainRoot, providerHint: ledger.providerId })
  const { targetRepo } = targetCtx
  if (!targetRepo || ledger.role === 'local-only' || ledger.role === 'generic-git' || targetCtx.capabilities?.api !== true) {
    return { rehydrated: false, reason: 'no-api-target' }
  }
  if (ledger.role === 'clone-readonly') {
    return { rehydrated: false, reason: 'write-auth-required' }
  }

  const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
  const ghClient = opts._ghClient ?? ghProbe.client
  const tier = ghProbe?.env?.trackB?.tier ?? (opts._ghClient?.tier ?? null)
  const hasWriteChannel = isVerifiedTier(tier) || Boolean(opts._ghClient)
  if (!hasWriteChannel || typeof ghClient?.listComments !== 'function') {
    return { rehydrated: false, reason: 'write-auth-required' }
  }
  if (typeof ghClient?.getRepoMeta === 'function') {
    const meta = await ghClient.getRepoMeta(targetRepo).catch(() => null)
    if (meta?.ok && meta.permissions && meta.permissions.push === false) {
      return { rehydrated: false, reason: 'write-auth-required' }
    }
  }

  const commentTargets = []
  const prNumVal = Number(ledger.prNumber)
  if (Number.isInteger(prNumVal) && prNumVal > 0) commentTargets.push({ number: prNumVal, isPr: true })
  const seenIssueNums = new Set()
  for (const rawNum of Array.isArray(ledger.linkedIssues) ? ledger.linkedIssues : []) {
    const n = Number(rawNum)
    if (Number.isInteger(n) && n > 0 && !seenIssueNums.has(n)) {
      seenIssueNums.add(n)
      commentTargets.push({ number: n, isPr: false })
    }
  }

  let changed = false
  if (ledger.prNumber && typeof ghClient.getPr === 'function') {
    const pr = await ghClient.getPr(targetRepo, ledger.prNumber)
    if (pr?.ok && pr.state && pr.state !== ledger.prState) {
      ledger.prState = pr.state
      if (pr.merged && ledger.status !== 'merged' && ledger.status !== 'cleaned') ledger.status = 'merged'
      changed = true
    }
  }

  const remoteRounds = []
  for (const target of commentTargets) {
    const cRes = await ghClient.listComments({ repo: targetRepo, number: target.number, ...(target.isPr ? { isPr: true } : {}) })
    if (!cRes?.ok || !Array.isArray(cRes.comments)) continue
    for (const c of cRes.comments) {
      const states = Array.isArray(c.pfStates) && c.pfStates.length > 0 ? c.pfStates : parsePfStateTags(c.body)
      for (const st of states) {
        if (st.taskId && st.taskId !== ledger.taskId) continue
        if (st.action === 'claim' || st.action === 'takeover') {
          if (st.account && st.account !== ledger.account) {
            ledger.account = st.account
            if (st.verifiedPlatformLogin !== undefined) ledger.verifiedPlatformLogin = Boolean(st.verifiedPlatformLogin)
            changed = true
          }
          const stAgent = st.agent || st.actor || null
          if (stAgent && stAgent !== ledger.agent) {
            ledger.agent = stAgent
            changed = true
          }
          const nextOwner = stAgent || st.account || null
          if (nextOwner && nextOwner !== ledger.implementerId) {
            // 换人之前先记账：历史集合是自审判定的依据，覆写而不记等于没换过人。
            ledger.previousImplementers = rememberPreviousImplementer(ledger, nextOwner)
            ledger.implementerId = nextOwner
            changed = true
          }
          if (stAgent && stAgent !== ledger.claimedBy) {
            ledger.claimedBy = stAgent
            changed = true
          }
        } else if (st.action === 'pr-created' && st.prNumber && !ledger.prNumber) {
          ledger.prNumber = Number(st.prNumber)
          changed = true
        } else if (st.action === 'review' && Number.isInteger(Number(st.round))) {
          remoteRounds.push({
            round: Number(st.round),
            verdict: st.verdict,
            headSha: st.headSha ?? null,
            reviewerId: st.reviewerId ?? null,
            stopLossTriggered: Boolean(st.stopLossTriggered),
          })
        }
      }
    }
  }

  if (remoteRounds.length > 0) {
    const existingByRound = new Map((ledger.rounds ?? []).map((r) => [Number(r.round), r]))
    for (const rr of remoteRounds) {
      if (!existingByRound.has(rr.round)) {
        existingByRound.set(rr.round, { ...rr, mustFix: [], shouldFix: [], rehydratedFromRemote: true })
        changed = true
      }
    }
    const mergedRounds = [...existingByRound.values()].sort((a, b) => a.round - b.round)
    const last = mergedRounds[mergedRounds.length - 1]
    ledger.rounds = mergedRounds
    if (last && (!ledger.lastReview || last.round >= Number(ledger.lastReview.round ?? 0))) {
      ledger.lastReview = {
        round: last.round, verdict: last.verdict, headSha: last.headSha,
        reviewerId: last.reviewerId, stopLossTriggered: Boolean(last.stopLossTriggered),
      }
      ledger.reviewerId = last.reviewerId ?? ledger.reviewerId
      ledger.reviewPassed = last.verdict === 'pass' && !last.stopLossTriggered
      ledger.reviewPassedHead = ledger.reviewPassed ? last.headSha : null
    }
  }

  if (changed) {
    await updateTaskLedger(roots.mainRoot, ledger.taskId, () => ({
      ...ledger,
    }))
  }
  return { rehydrated: true, changed, remoteRoundsCount: remoteRounds.length }
}

function buildRetroHint({ mainRoot, gitDir, isGit }) {
  const governState = readJsonSafe(join(mainRoot, '.worktrees', '.state', 'govern-state.json'))
  const lastRetro = governState?.lastRetro ?? null
  const lastAtMs = lastRetro?.at ? Date.parse(lastRetro.at) : NaN
  const overdueDays = Number.isFinite(lastAtMs) ? (Date.now() - lastAtMs) / (24 * 3600 * 1000) : 0
  const overdue = Boolean(lastRetro?.at && overdueDays >= 7)

  const { events } = readSignalsJsonl({ mainRoot, gitDir, isGit })
  const clusterCounts = new Map()
  for (const ev of events) {
    const sev = String(ev?.severity ?? 'medium').toLowerCase()
    const pat = String(ev?.pattern ?? 'signal')
    if (sev === 'info' || /\.pass$/.test(pat)) continue
    if (Number.isFinite(lastAtMs) && ev?.ts) {
      const evMs = Date.parse(ev.ts)
      if (Number.isFinite(evMs) && evMs <= lastAtMs) continue
    }
    const fp = ev.fingerprint || computeSignalFingerprint({
      ruleId: ev.ruleId || pat,
      defectClass: ev.defectClass || 'general',
      moduleRoot: ev.module || 'repo',
    })
    const prev = clusterCounts.get(fp) ?? { fingerprint: fp, pattern: pat, module: ev.module || 'repo', count: 0 }
    prev.count += 1
    clusterCounts.set(fp, prev)
  }
  const undigestedClusters = [...clusterCounts.values()].filter((c) => c.count >= 2).sort((a, b) => b.count - a.count)
  const tier1Count = Number(lastRetro?.tier1Count ?? 0)
  const tier2Count = Number(lastRetro?.tier2Count ?? 0)
  const today = new Date().toISOString().slice(0, 10)
  const expiredTier3 = (Array.isArray(governState?.tier3Fallbacks) ? governState.tier3Fallbacks : [])
    .filter((x) => x?.expires && String(x.expires) < today).length

  if (!overdue && tier1Count === 0 && tier2Count === 0 && undigestedClusters.length === 0 && expiredTier3 === 0) {
    return null
  }
  const parts = []
  if (tier1Count > 0 || tier2Count > 0) parts.push(`上次 retro 遗留 Tier1=${tier1Count}、Tier2=${tier2Count}`)
  if (undigestedClusters.length > 0) parts.push(`未消化复发聚簇 ${undigestedClusters.length} 组`)
  if (overdue) parts.push(`距上次 retro 已逾 ${Math.floor(overdueDays)} 天`)
  if (expiredTier3 > 0) parts.push(`过期 Tier3 条款 ${expiredTier3} 条`)

  return {
    code: 'WARN_RETRO_PENDING',
    overdue,
    lastRetroAt: lastRetro?.at ?? null,
    lastRetroTaskId: lastRetro?.taskId ?? null,
    tier1Count,
    tier2Count,
    expiredTier3,
    undigestedClusterCount: undigestedClusters.length,
    undigestedClusters: undigestedClusters.slice(0, 5),
    command: 'node ".agents/skills/dev-govern/scripts/govern-audit.mjs" retro --auto --json',
    message: `治理复盘提醒（${parts.join('，')}）；建议运行 \`govern-audit.mjs retro --auto --json\` 收口升格。`,
  }
}

/** 唯一路由入口：处理 0 任务 idle、多任务 ambiguous 与单任务全态判定。 */
export async function handleNext(opts, roots) {
  const buckets = collectTaskLivenessBuckets(roots.mainRoot, { repoRoot: roots.mainRoot })
  const allLedgers = buckets.all
  const activeTasks = buckets.active
  const pendingCleanupTasks = buckets.pendingCleanup.map((t) => ({
    taskId: t.taskId,
    status: t.status,
    branch: t.branch ?? null,
    worktreePath: t.worktreePath ?? null,
  }))
  let selectedTask = null

  if (opts.task && String(opts.task).trim() !== '') {
    const ctx = await resolveTaskContext(roots, opts, { requireExisting: true })
    selectedTask = ctx.ledger
  } else if (activeTasks.length > 0) {
    try {
      const ctx = await resolveTaskContext(roots, opts, { requireExisting: true })
      selectedTask = ctx.ledger
    } catch {
      selectedTask = null
    }
  }

  if (opts['ack-no-issue-context']) {
    const reason = String(opts.reason ?? '').trim()
    if (!selectedTask) {
      const msg = 'BLOCKED_ACK_REQUIRES_TASK: --ack-no-issue-context 必须指定单个任务（传 --task <id>）。'
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, code: 'BLOCKED_ACK_REQUIRES_TASK', error: msg }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.USAGE }
    }
    if (!reason) {
      const msg = 'BLOCKED_ACK_MISSING_REASON: --ack-no-issue-context 必须附带非空 --reason "<无法取得 Issue 上下文的原因>"。'
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, code: 'BLOCKED_ACK_MISSING_REASON', taskId: selectedTask.taskId, error: msg }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.USAGE }
    }
    const unavail = Array.isArray(selectedTask.issueContextUnavailable)
      ? selectedTask.issueContextUnavailable.map(Number).filter((n) => Number.isInteger(n) && n > 0)
      : []
    const ackIssues = unavail.length > 0
      ? unavail
      : (Array.isArray(selectedTask.linkedIssues) ? selectedTask.linkedIssues.map(Number).filter((n) => Number.isInteger(n) && n > 0) : [])
    const ackEntry = {
      issues: ackIssues,
      reason,
      at: new Date().toISOString(),
      by: String(opts.agent ?? selectedTask.implementerId ?? 'human').trim() || 'human',
    }
    const { ledger: acked } = await updateTaskLedger(roots.mainRoot, selectedTask.taskId, { issueContextAck: ackEntry })
    selectedTask = acked
  }

  let hydration = { rehydrated: false }
  let taskRuntime = null
  const hasDevReview = hasSkillSupport(roots.mainRoot, 'dev-review')
  if (selectedTask) {
    hydration = await hydrateRemotePfState({ roots, ledger: selectedTask, opts })
    const snap = await collectTaskRuntimeSnapshot({
      mainRoot: roots.mainRoot,
      gitDir: roots.gitDir,
      ledger: selectedTask,
      hasDevReview,
      includeMainDirty: true,
      evaluateNext: false,
    })
    taskRuntime = snap.taskRuntime
  }

  let multiTaskFiles = null
  if (!selectedTask && activeTasks.length > 0) {
    multiTaskFiles = {}
    await Promise.all(activeTasks.map(async (t) => {
      const files = new Set(Array.isArray(t.files) ? t.files : (Array.isArray(t.scopeFiles) ? t.scopeFiles : []))
      const tRoot = t.worktreePath ? resolve(roots.mainRoot, t.worktreePath) : null
      if (tRoot && existsSync(tRoot)) {
        try {
          for (const f of await getChangedFiles(tRoot, t.baseSha)) files.add(f)
        } catch { /* ignore */ }
      }
      multiTaskFiles[t.taskId] = [...files].sort()
    }))
  }

  let out = evaluateNextState({
    activeTasks, allLedgers, pendingCleanupTasks, selectedTask, taskRuntime, hasDevReview, multiTaskFiles, repoRoot: roots.mainRoot,
  })

  if (roots.isGit) {
    const cfgFast = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
    const remoteOut = cfgFast ? cfgFast.remoteText : (await gitRun(roots.mainRoot, ['remote', '-v'])).stdout
    const remoteUrls = parseRemoteUrls(remoteOut ?? '')
    const hasAnyRemote = Object.keys(remoteUrls).length > 0
    const markers = roots.gitDir ? detectGitModeMarkers(roots.gitDir, { hasRemote: hasAnyRemote }) : { localMode: false }
    if (hasAnyRemote && !markers.localMode) {
      const topo = parseRemotesTopology(remoteOut ?? '')
      const driftWarnings = detectRemoteDriftWarnings({
        mainRoot: roots.mainRoot,
        gitDir: roots.gitDir,
        role: selectedTask?.role && selectedTask.role !== 'local-only' ? selectedTask.role : 'maintainer',
        providerId: topo.providerId ?? 'none',
      })
      if (selectedTask?.role === 'local-only') {
        driftWarnings.push({
          code: 'WARN_TASK_STARTED_BEFORE_REMOTE',
          message: `远端漂移提醒：任务 ${selectedTask.taskId} 启动时为 local-only，但当前仓库已绑定远端；建议重跑 S1–S4 或运行 \`flow.mjs issue migrate\` 后同步任务角色。`,
        })
      }
      if (driftWarnings.length > 0) {
        const merged = [...(out.warnings ?? [])]
        for (const w of driftWarnings) {
          if (!merged.some((m) => m.code === w.code)) merged.push(w)
        }
        out = { ...out, warnings: merged }
      }
    }
  }

  // 待审查时签发一枚一次性令牌。
  //
  // 独立审查的身份不能只靠 `--reviewer-id` 一个自由字符串：谁能编一个不一样的名字。
  // 令牌由这里现场签发、写进账本，`review-pack record` 必须持有它且只能消费一次。
  // 它不承担「防伪到不可伪造」——它承担的是「把随便编个名的成本从 0 抬成一件显眼的事」。
  //
  // `--json` 也要带：只看 JSON 的调用方拿不到令牌就永远记不了审查。
  if (out.phase === 'needs-review' && selectedTask) {
    // 轮次只能有一个派生式（`ledger.mjs` 的 `nextReviewRound`）。
    // 按条数算会在轮次有空档时算错，而空档是正常历史。
    const round = nextReviewRound(selectedTask)
    const { token } = ensureReviewToken(roots.mainRoot, selectedTask, round, {
      reviewerId: opts['reviewer-id'] ?? null,
      headSha: taskRuntime?.headSha ?? null,
    })
    const excludedReviewers = collectExcludedReviewers(selectedTask.rounds, selectedTask.implementerId)
    out = {
      ...out,
      reviewToken: token,
      excludedReviewers,
      recordCommand: `node ".agents/skills/dev-review/scripts/review-pack.mjs" record --task ${selectedTask.taskId} --round ${round} --verdict <pass|changes> --reviewer-id <新审查子代理名> --review-token ${token}`,
    }
  } else if (selectedTask && (selectedTask.rounds?.length > 0 || selectedTask.implementerId)) {
    out = {
      ...out,
      excludedReviewers: collectExcludedReviewers(selectedTask.rounds, selectedTask.implementerId),
    }
  }

  // 审核阶段也必须给交接包。派 review 子代理时，协调者同样只能拿到一个命令，
  // 于是自己去 SPEC 里摘判据、摘上一轮意见——摘漏一条，那一轮就等于没审。
  if (opts.handoff && !selectedTask && out.phase === 'ambiguous') {
    // 多任务消歧时没有单一对象，跳过后面的交接包即可。
  }

  if (out.phase === 'planning' && selectedTask) {
    const planRoot = selectedTask.worktreePath ? resolve(roots.mainRoot, selectedTask.worktreePath) : roots.mainRoot
    const planState = await evaluatePlanNextState({
      repoRoot: existsSync(planRoot) ? planRoot : roots.mainRoot,
      mainRoot: roots.mainRoot,
      gitDir: roots.gitDir,
      isGit: roots.isGit,
      taskId: selectedTask.taskId,
      ledger: selectedTask,
    })
    out = {
      ...out,
      ownerRole: planState.ownerRole ?? out.ownerRole,
      nextAction: planState.nextAction ?? out.nextAction,
      command: planState.command ?? out.command,
      blockingReasons: [...new Set([...(out.blockingReasons ?? []), ...(planState.blockingReasons ?? [])])],
      planState,
    }
    if (opts.handoff) {
      const ph = buildPlanHandoff({ state: planState, deliveryMode: planState.deliveryMode })
      out = { ...out, handoff: ph.fields, handoffPrompt: ph.prompt }
    }
  } else if (opts.handoff && selectedTask) {
    const handoff = buildHandoff({
      mainRoot: roots.mainRoot,
      ledger: selectedTask,
      policy: out.policy ?? taskRuntime?.policy ?? null,
      headSha: taskRuntime?.headSha ?? null,
      ownerRole: out.ownerRole ?? null,
      // Dev Profile 决定「必过门」那条命令长什么样——不传就只剩一个档位名。
      profile: taskRuntime?.profile ?? out.profile ?? null,
      // flow next 刚算出来的这一格，直接搬进交接包——丢掉它，子代理就不知道此刻要干什么。
      current: out,
    })
    out = { ...out, handoff: handoff.fields, handoffPrompt: handoff.prompt }
  }

  const retroHint = buildRetroHint({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, isGit: roots.isGit })
  if (retroHint) {
    const mergedWarnings = [...(out.warnings ?? [])]
    if (!mergedWarnings.some((w) => w.code === retroHint.code)) {
      mergedWarnings.push({ code: retroHint.code, message: retroHint.message })
    }
    out = { ...out, warnings: mergedWarnings }
  }

  const orient = out.phase === 'idle' ? buildSessionOrientation(roots.mainRoot) : null
  const sessionState = readSessionState(roots.mainRoot)
  const visualBrief = out.planState?.visualBrief ?? getVisualBriefSummary(roots.mainRoot, {
    briefKey: selectedTask?.briefKey ?? (sessionState?.activeTopic ? sessionState.topics?.[sessionState.activeTopic]?.briefKey : null) ?? null,
    taskId: selectedTask?.taskId ?? null,
    topicId: sessionState?.activeTopic ?? null,
    masterPrdRel: selectedTask?.prdFile ?? null,
  })
  const payload = {
    ...out,
    hydration,
    visualBrief,
    ...(retroHint ? { retroHint } : {}),
    ...(sessionState ? { sessionState } : {}),
    ...(orient ? { orientation: { docs: orient.docs, stuck: orient.stuck, nextSteps: orient.nextSteps } } : {}),
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps(payload, [{ skill: 'dev-flow', text: payload.command }], { repoRoot: roots.mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(`# flow next (${payload.phase} | owner=${payload.ownerRole})\n`)
    // 冷启动：没有任何任务时，光说「去 start」等于让新会话自己翻目录。
    // 把仓里已有的进度摆出来——那些信息一直都在，只是没有入口。
    if (orient) {
      process.stdout.write('\n')
      process.stdout.write(orient.text)
    }
    if (payload.taskId) process.stdout.write(`- 任务: ${payload.taskId} | risk=${payload.policy?.riskTier ?? '-'} | worktree=${payload.worktreePath ?? 'branch'}\n`)
    process.stdout.write(`- 下一步: ${payload.nextAction}\n`)
    if (payload.parallelDispatch !== undefined) process.stdout.write(`- 并行派发: ${payload.parallelDispatch ? 'true (Wave 1 >= 2)' : 'false'}\n`)
    if (payload.excludedReviewers?.length > 0 && payload.phase === 'needs-review') {
      process.stdout.write(`- 排除历史审查人: ${payload.excludedReviewers.join(', ')}\n`)
    }
    if (payload.blockingReasons.length > 0) process.stdout.write(`- 阻塞原因: ${payload.blockingReasons.join(', ')}\n`)
    for (const w of payload.warnings ?? []) {
      process.stdout.write(`- 提醒 ${w.code}: ${w.message}\n`)
    }
    if (payload.waves?.length > 0) {
      process.stdout.write('- 波次计划:\n')
      for (const w of payload.waves) {
        process.stdout.write(`  Wave ${w.wave} (${w.canParallel ? '可并行' : '单列/串行'}): ${w.tasks.map((t) => t.taskId).join(', ')}\n`)
      }
    }
    if (payload.candidates?.length > 0) {
      for (const c of payload.candidates) {
        process.stdout.write(`  * --task ${c.taskId} (status=${c.status}, phase=${c.phase ?? '-'}, mutability=${c.mutability ?? '-'}, branch=${c.branch ?? '-'})\n`)
      }
    }
    if (payload.handoffPrompt) {
      process.stdout.write('\n--- 交接包（可直接粘给子代理）---\n\n')
      process.stdout.write(payload.handoffPrompt)
    }
    printNextStep([{ skill: 'dev-flow', text: payload.command }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK, payload }
}
