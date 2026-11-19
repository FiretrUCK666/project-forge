/**
 * flow-next.mjs —— 单一入口 `flow.mjs next [--task id] [--probe-auth] [--json]` 状态路由与惰性水合。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），保持默认无外网 <= 300ms 预算。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { hasSkillSupport, printNextStep } from '../../lib/cli.mjs'
import { collectExcludedReviewers } from '../../lib/critique-rounds.mjs'
import { detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ } from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { buildHandoff } from '../../lib/handoff-package.mjs'
import { buildSessionOrientation } from '../../lib/session-orient.mjs'
import { ensureReviewToken, listTaskLedgers, resolveTaskContext, updateTaskLedger, nextReviewRound } from '../../lib/ledger.mjs'
import { detectDeclaredRepo, detectGitModeMarkers, parsePfStateTags, parseRemotesTopology, parseRemoteUrls, probeForWrite } from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { detectGateWeakening, gitDiffRawEntriesAndText } from '../../lib/static-gates.mjs'
import {
  determineWorkflowPolicy, evaluateNextState, hasRepoCiWorkflow,
  readVerificationEvidence, resolveEffectiveBaseSha, validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, detectRemoteDriftWarnings, getChangedFiles } from './flow-context.mjs'

async function hydrateRemotePfState({ roots, ledger, opts }) {
  if (!opts['probe-auth']) return { rehydrated: false }
  if (process.env.PF_NO_REAL_AUTH_PROBE === '1' && !opts._ghClient && !opts._ghProbe) {
    return { rehydrated: false, reason: 'PF_NO_REAL_AUTH_PROBE' }
  }
  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { targetRepo } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo)
  if (!targetRepo || ledger.role === 'local-only' || ledger.role === 'generic-git') {
    return { rehydrated: false, reason: 'no-github-target' }
  }
  if (ledger.role === 'clone-readonly') {
    return { rehydrated: false, reason: 'write-auth-required' }
  }

  const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls }))
  const ghClient = opts._ghClient ?? ghProbe.client
  const tier = ghProbe?.env?.trackB?.tier ?? (opts._ghClient?.tier ?? null)
  const hasWriteChannel = tier === 'gh-cli' || tier === 'node-https-token' || Boolean(opts._ghClient)
  if (!hasWriteChannel || typeof ghClient?.listComments !== 'function') {
    return { rehydrated: false, reason: 'write-auth-required' }
  }
  if (typeof ghClient?.getRepoMeta === 'function') {
    const meta = await ghClient.getRepoMeta(targetRepo).catch(() => null)
    if (meta?.ok && meta.permissions && meta.permissions.push === false) {
      return { rehydrated: false, reason: 'write-auth-required' }
    }
  }

  const numbers = [
    ...(ledger.prNumber ? [Number(ledger.prNumber)] : []),
    ...(Array.isArray(ledger.linkedIssues) ? ledger.linkedIssues.map(Number) : []),
  ].filter((n, idx, arr) => Number.isInteger(n) && n > 0 && arr.indexOf(n) === idx)

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
  for (const num of numbers) {
    const cRes = await ghClient.listComments({ repo: targetRepo, number: num })
    if (!cRes?.ok || !Array.isArray(cRes.comments)) continue
    for (const c of cRes.comments) {
      const states = Array.isArray(c.pfStates) && c.pfStates.length > 0 ? c.pfStates : parsePfStateTags(c.body)
      for (const st of states) {
        if (st.taskId && st.taskId !== ledger.taskId) continue
        if ((st.action === 'claim' || st.action === 'takeover') && st.agent && st.agent !== ledger.implementerId) {
          ledger.implementerId = st.agent
          changed = true
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

/** 唯一路由入口：处理 0 任务 idle、多任务 ambiguous 与单任务全态判定。 */
export async function handleNext(opts, roots) {
  const allLedgers = listTaskLedgers(roots.mainRoot, { includeTerminal: true })
  const activeTasks = listTaskLedgers(roots.mainRoot, { includeTerminal: false })
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
      return { exitCode: 2 }
    }
    if (!reason) {
      const msg = 'BLOCKED_ACK_MISSING_REASON: --ack-no-issue-context 必须附带非空 --reason "<无法取得 Issue 上下文的原因>"。'
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, code: 'BLOCKED_ACK_MISSING_REASON', taskId: selectedTask.taskId, error: msg }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: 2 }
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
    const implRoot = selectedTask.worktreePath ? resolve(roots.mainRoot, selectedTask.worktreePath) : roots.mainRoot
    const exists = existsSync(implRoot)
    const profile = parseAgentsProfile(roots.mainRoot)
    const fastHeadOid = exists ? (readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null) : null
    const effectiveBase = exists ? await resolveEffectiveBaseSha(implRoot, selectedTask, { gitCommonDir: roots.gitDir }) : selectedTask.baseSha
    const [stZ, headRes, diffRawRes] = exists
      ? await Promise.all([
          gitStatusPorcelainZ(implRoot),
          fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
          !effectiveBase
            ? Promise.resolve(null)
            : (fastHeadOid && fastHeadOid === effectiveBase ? Promise.resolve({ ok: true, entries: [] }) : gitDiffRawEntriesAndText(implRoot, `${effectiveBase}..HEAD`)),
        ])
      : [{ ok: true, entries: [] }, { ok: false, stdout: '' }, null]
    const headSha = headRes.ok ? headRes.stdout.trim() : null
    const sharedEntries = diffRawRes?.ok ? diffRawRes.entries : undefined
    const [op, changedFiles, gateHits] = exists
      ? await Promise.all([
          detectInProgressGitOp(implRoot, { statusEntries: stZ.entries }),
          getChangedFiles(implRoot, effectiveBase, { statusEntries: stZ.entries, diffEntries: sharedEntries }),
          detectGateWeakening(implRoot, effectiveBase, selectedTask.baseBranch, { headSha, nameStatusEntries: sharedEntries }),
        ])
      : [{ inProgress: false }, [], []]
    const ownArchived = [selectedTask.archivedTodoFile, selectedTask.archivedSpecFile, selectedTask.archivedPrdFile].filter(Boolean)
    const policy = determineWorkflowPolicy({
      changedFiles,
      ownArchived,
      caseType: selectedTask.caseType,
      highRiskGlobs: profile.highRisk,
      doNotEditGlobs: profile.doNotEdit,
      gateWeakeningHits: gateHits,
      hasRemote: selectedTask.role !== 'local-only',
      hasCiWorkflow: hasRepoCiWorkflow(exists ? implRoot : roots.mainRoot),
      profile,
      hasDevReview,
    })

    const evidence = readVerificationEvidence(roots.gitDir, selectedTask.taskId)
    const evidenceValidation = validateVerificationEvidence({ policy, evidence, headSha, profile })

    let nonDocChangesAfterFinalize = false
    if (selectedTask.finalized && selectedTask.finalizedHead && headSha && selectedTask.finalizedHead !== headSha && exists) {
      const postFin = await gitDiffNameStatusZ(implRoot, [`${selectedTask.finalizedHead}..${headSha}`])
      nonDocChangesAfterFinalize = postFin.entries.some((e) => e.file && !/^docs\//.test(e.file))
    }

    // 主工作区直接改文件：这是「绕过隔离位」的早期信号。
    //
    // Case 2/3/4 的活该在 `.worktrees/impl-<id>/` 里干。主 Agent 若在自己的工作区直接 write，
    // 隔离位形同虚设，而「这次改动包含什么」也就说不清了——可这条此前没有任何东西看得见。
    //
    // 它是**警告不是拦截**：小改动（Case 1）本来就该在主工作区做，拦死会把正常路径也堵住。
    // 真正的硬拦留在 merge。
    const mainStatus = selectedTask.worktreePath && roots.mainRoot !== implRoot
      ? await gitStatusPorcelainZ(roots.mainRoot)
      : null
    const mainDirtyCount = mainStatus?.ok ? mainStatus.entries.length : 0

    // 分支上有没有基线没有的提交。rebase 会把基线的提交带进来，
    // 所以这个数不因同步基线而变——只有真写了东西才会涨。
    let commitsAheadOfBase = 0
    if (exists) {
      const baseRef = selectedTask.baseBranch || selectedTask.baseSha
      if (baseRef) {
        const countRes = await gitRun(implRoot, ['rev-list', '--count', `${baseRef}..HEAD`])
        if (countRes.ok) commitsAheadOfBase = Number(countRes.stdout.trim()) || 0
      }
    }

    taskRuntime = {
      opInProgress: Boolean(op.inProgress),
      opName: op.op ?? null,
      headSha,
      dirty: stZ.entries.length,
      mainDirtyCount,
      policy,
      evidenceValidation,
      nonDocChangesAfterFinalize,
      profile,
      commitsAheadOfBase,
      hasDevReview,
    }
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
    activeTasks, allLedgers, selectedTask, taskRuntime, hasDevReview, multiTaskFiles, repoRoot: roots.mainRoot,
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
        providerId: topo.providerId ?? 'github',
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
    const { token } = ensureReviewToken(roots.mainRoot, selectedTask, round)
    const excludedReviewers = collectExcludedReviewers(selectedTask.rounds, selectedTask.implementerId)
    out = {
      ...out,
      reviewToken: token,
      excludedReviewers,
      command: `${out.command} --reviewer-id <新审查子代理名> --review-token ${token}`,
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

  if (opts.handoff && selectedTask) {
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

  const payload = { ...out, hydration }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`# flow next (${payload.phase} | owner=${payload.ownerRole})\n`)
    // 冷启动：没有任何任务时，光说「去 start」等于让新会话自己翻目录。
    // 把仓里已有的进度摆出来——那些信息一直都在，只是没有入口。
    if (payload.phase === 'idle') {
      const orient = buildSessionOrientation(roots.mainRoot)
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
      for (const c of payload.candidates) process.stdout.write(`  * --task ${c.taskId} (status=${c.status}, branch=${c.branch ?? '-'})\n`)
    }
    if (payload.handoffPrompt) {
      process.stdout.write('\n--- 交接包（可直接粘给子代理）---\n\n')
      process.stdout.write(payload.handoffPrompt)
    }
    printNextStep([{ skill: 'dev-flow', text: payload.command }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0, payload }
}
