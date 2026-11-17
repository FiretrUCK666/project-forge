/**
 * flow-next.mjs —— 单一入口 `flow.mjs next [--task id] [--probe-auth] [--json]` 状态路由与惰性水合。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），保持默认无外网 <= 300ms 预算。
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { detectInProgressGitOp, gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ } from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { buildHandoff } from '../../lib/handoff-package.mjs'
import { buildSessionOrientation } from '../../lib/session-orient.mjs'
import { ensureReviewToken, listTaskLedgers, resolveTaskContext, writeTaskLedger, nextReviewRound } from '../../lib/ledger.mjs'
import { detectDeclaredRepo, parsePfStateTags, parseRemoteUrls, probeGitHubEnv } from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { detectGateWeakening, gitDiffRawEntriesAndText } from '../../lib/static-gates.mjs'
import {
  determineWorkflowPolicy, evaluateNextState, hasRepoCiWorkflow,
  readVerificationEvidence, validateVerificationEvidence,
} from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, getChangedFiles } from './flow-inspect.mjs'

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

  const ghProbe = opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls, probeNetwork: true }))
  const ghClient = opts._ghClient ?? ghProbe.client
  const canApi = Boolean(opts._ghClient || opts._ghProbe) || ghProbe.env?.trackB?.tier === 'gh-cli' || ghProbe.env?.trackB?.tier === 'node-https-token'
  if (!canApi || typeof ghClient?.listComments !== 'function') return { rehydrated: false, reason: 'api-unavailable' }

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

  if (changed) writeTaskLedger(roots.mainRoot, ledger)
  return { rehydrated: true, changed, remoteRoundsCount: remoteRounds.length }
}

/** 唯一路由入口：处理 0 任务 idle、多任务 ambiguous 与单任务全态判定。 */
export async function handleNext(opts, roots) {
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

  let hydration = { rehydrated: false }
  let taskRuntime = null
  if (selectedTask) {
    hydration = await hydrateRemotePfState({ roots, ledger: selectedTask, opts })
    const implRoot = selectedTask.worktreePath ? resolve(roots.mainRoot, selectedTask.worktreePath) : roots.mainRoot
    const exists = existsSync(implRoot)
    const profile = parseAgentsProfile(roots.mainRoot)
    const fastHeadOid = exists ? (readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null) : null
    const [stZ, headRes, diffRawRes] = exists
      ? await Promise.all([
          gitStatusPorcelainZ(implRoot),
          fastHeadOid ? Promise.resolve({ ok: true, stdout: fastHeadOid }) : gitRun(implRoot, ['rev-parse', 'HEAD']),
          !selectedTask.baseSha
            ? Promise.resolve(null)
            : (fastHeadOid && fastHeadOid === selectedTask.baseSha ? Promise.resolve({ ok: true, entries: [] }) : gitDiffRawEntriesAndText(implRoot, `${selectedTask.baseSha}..HEAD`)),
        ])
      : [{ ok: true, entries: [] }, { ok: false, stdout: '' }, null]
    const headSha = headRes.ok ? headRes.stdout.trim() : null
    const sharedEntries = diffRawRes?.ok ? diffRawRes.entries : undefined
    const [op, changedFiles, gateHits] = exists
      ? await Promise.all([
          detectInProgressGitOp(implRoot, { statusEntries: stZ.entries }),
          getChangedFiles(implRoot, selectedTask.baseSha, { statusEntries: stZ.entries, diffEntries: sharedEntries }),
          detectGateWeakening(implRoot, selectedTask.baseSha, selectedTask.baseBranch, { headSha, nameStatusEntries: sharedEntries }),
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
    }
  }

  let out = evaluateNextState({ activeTasks, selectedTask, taskRuntime })

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
    out = {
      ...out,
      reviewToken: token,
      command: `${out.command} --reviewer-id <新审查子代理名> --review-token ${token}`,
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
    if (payload.blockingReasons.length > 0) process.stdout.write(`- 阻塞原因: ${payload.blockingReasons.join(', ')}\n`)
    for (const w of payload.warnings ?? []) {
      process.stdout.write(`- 提醒 ${w.code}: ${w.message}\n`)
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
