/**
 * flow-batch.mjs —— 宿主无关并行波次规划（plan）、文件互斥校验（check-disjoint）、
 * FIFO 串行合并队列（merge-queue）与跨会话句柄轮换（resume-session）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零特定宿主名称耦合。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { buildSliceGraph } from '../../lib/doc-slice-graph.mjs'
import {
  gitRun, posixPath, readJsonSafe, resolveDefaultBranch, withFileLock, writeJsonAtomic,
} from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, readRefsFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { buildHandoff } from '../../lib/handoff-package.mjs'
import { listTaskLedgers, readTaskLedger, sanitizeTaskId, updateTaskLedger } from '../../lib/ledger.mjs'
import { evaluateMutability } from '../../lib/mutability.mjs'
import { detectDeclaredRepo, parseRemotesTopology, parseRemoteUrls, probeForWrite } from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { evaluateRemoteChecks } from '../../lib/gate-truth.mjs'
import { buildMultiTaskWavePlan, evaluateNextState, hasRepoCiWorkflow, scanUnstartedReadySlices } from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, getChangedFiles } from './flow-inspect.mjs'
import { assertPreMergeGates, syncPostMergeTargets } from './flow-merge.mjs'
import { runTrialMerge } from './flow-trial-merge.mjs'

function resolveQueuePaths(mainRoot, gitDir) {
  const base = gitDir ? join(gitDir, 'project-forge-flow') : join(mainRoot, '.worktrees', '.state')
  return {
    lockPath: join(base, 'locks', 'merge-queue.lock'),
    statePath: join(base, 'merge-queue.json'),
  }
}

function parseTasksList(opts, mainRoot) {
  if (opts.tasks && String(opts.tasks).trim()) {
    return String(opts.tasks).split(/[\s,]+/).map((s) => sanitizeTaskId(s)).filter(Boolean)
  }
  return listTaskLedgers(mainRoot, { includeTerminal: false })
    .filter((t) => !['merged', 'cleaned', 'aborted'].includes(String(t.status ?? '').toLowerCase()))
    .map((t) => t.taskId)
}

async function collectTaskTouchedFiles(mainRoot, ledger) {
  const files = new Set()
  for (const f of ledger.files ?? ledger.scopeFiles ?? []) {
    const clean = posixPath(f).replace(/^\.\//, '').trim()
    if (clean) files.add(clean)
  }
  const implRoot = ledger.worktreePath ? resolve(mainRoot, ledger.worktreePath) : null
  if (implRoot && existsSync(implRoot)) {
    try {
      for (const cf of await getChangedFiles(implRoot, ledger.baseSha)) {
        if (cf) files.add(posixPath(cf))
      }
    } catch { /* ignore */ }
  }
  return [...files].sort()
}

/**
 * 为一枚切片装配交接包。
 *
 * 复用 `handoff-package.mjs` 的 `buildHandoff`——它是审查、返工、接管共用的同一份
 * 交接包生成器，判据（验收标准怎么抽、路径怎么认、角色边界怎么写）只该有一处。
 * 这里只做三件它不做的事：
 *
 * 1. 把「还没开工的切片」翻译成它认识的 ledger 形状（`buildHandoff` 收的是账本）；
 * 2. 补上 `scopeFiles` / `dependsOn` / 派发命令——这三项来自切片图，账本里还没有；
 * 3. 把结果压成适合批量消费的字段，`prompt` 原样保留，子代理拿到的仍是那份完整提示。
 */
function buildSliceHandoff({ mainRoot, task, slice, profile }) {
  const pseudoLedger = {
    taskId: task.taskId,
    specFile: slice?.specFile ?? task.specFile ?? null,
    todoFile: slice?.todoFile ?? task.todoFile ?? null,
    worktreePath: null,
    linkedIssues: [],
  }
  let payload = null
  try {
    payload = buildHandoff({ mainRoot, ledger: pseudoLedger, profile, ownerRole: 'implementer' })
  } catch {
    // 规划文档读不到时不让整批波次规划失败：交接包是附加信息，缺了它波次拓扑照样有用。
    payload = null
  }
  const criteria = payload?.fields?.criteria ?? []
  const scopeFiles = slice?.scopeFiles ?? task.files ?? []
  const dependsOn = slice?.dependsOn ?? task.dependsOn ?? []
  const caseType = caseTypeOfSlice(slice, task)
  return {
    taskId: task.taskId,
    sourceDoc: payload?.fields?.sourceDoc ?? slice?.specFile ?? null,
    criteriaCount: payload?.fields?.criteriaCount ?? criteria.length,
    criteria: criteria.map((c) => (typeof c === 'string' ? c : (c?.id ? `${c.id}: ${c.text ?? ''}`.trim() : String(c)))),
    scopeFiles,
    dependsOn,
    caseType,
    dispatchCommand: buildDispatchCommand({ taskId: task.taskId, caseType, slice }),
    prompt: payload?.prompt ?? '',
  }
}

/** 按档位拼派发命令：Case 3 没有 SPEC，硬塞一个 `--spec "<spec>"` 会让命令直接跑不通。 */
function buildDispatchCommand({ taskId, caseType, slice }) {
  const parts = [`node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${taskId} --case ${caseType}`]
  const spec = slice?.specFile
  const todo = slice?.todoFile
  if (spec) parts.push(`--spec "${spec}"`)
  else if (caseType >= 4) parts.push('--spec "<spec>"')
  if (todo) parts.push(`--todo "${todo}"`)
  return parts.join(' ')
}

/**
 * 切片该按哪一档派发。
 *
 * 不能一律写死 `--case 4`：那会让 Case 3 的切片（只有 Todo、没有 SPEC）拿到一个
 * 它根本不满足的档位要求，派发命令直接跑不起来。判据取自切片自己声明的档位信息：
 *
 * - 显式写了 `case_type`（或 `case`）就用它；
 * - 否则按规划级别推：切片有 SPEC = 走过 `L3` 档的设计单 = Case 4；
 *   只有 Todo = `L2` 档的功能调整 = Case 3。
 *
 * 两者都拿不到时退回 Case 4——宁可让派发命令要求更严，也不要让一片真需要 SPEC 的
 * 工作按 Case 3 溜过去。
 */
function caseTypeOfSlice(slice, task) {
  const explicit = Number(slice?.caseType ?? slice?.data?.case_type ?? slice?.data?.case ?? task?.caseType ?? NaN)
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 5) return explicit
  if (slice?.specFile) return 4
  if (slice?.todoFile) return 3
  return 4
}

function readProfileSafe(mainRoot) {
  try {
    return parseAgentsProfile(mainRoot)
  } catch {
    return null
  }
}

async function handleBatchPlan(opts, roots) {
  const explicitTasks = Boolean(opts.tasks && String(opts.tasks).trim())
  const taskIds = parseTasksList(opts, roots.mainRoot)
  const graph = buildSliceGraph(roots.mainRoot)
  const sliceMetaByRel = new Map(graph.slices.map((s) => [s.rel, s]))
  const excludedLockedTasks = []
  const items = (await Promise.all(taskIds.map(async (id) => {
    const ledger = readTaskLedger(roots.mainRoot, id)
    if (!ledger) throw new Error(`找不到任务账本：${id}`)
    if (ledger.prdFile && !ledger.specFile && !ledger.todoFile) return null
    const mut = evaluateMutability({ ledger, taskId: id })
    if (!mut.mutable) {
      excludedLockedTasks.push({ taskId: id, status: ledger.status, mutability: mut.mutability, terminal: mut.terminal, reason: mut.reason })
      return null
    }
    const diskSlice = sliceMetaByRel.get(ledger.specFile) ?? sliceMetaByRel.get(ledger.todoFile) ?? null
    const files = [...new Set([
      ...(await collectTaskTouchedFiles(roots.mainRoot, ledger)),
      ...(diskSlice?.scopeFiles ?? []),
    ])].sort()
    const deps = [...new Set([
      ...(Array.isArray(ledger.dependsOn) ? ledger.dependsOn.map(String) : []),
      ...(ledger.parentTaskId ? [String(ledger.parentTaskId)] : []),
      ...(diskSlice?.dependsOn ?? []),
    ])]
    return {
      taskId: id,
      slug: ledger.slug ?? id,
      specFile: ledger.specFile ?? null,
      todoFile: ledger.todoFile ?? null,
      files,
      dependsOn: deps,
      status: ledger.status,
      mutability: mut.mutability,
      branch: ledger.branch,
    }
  }))).filter(Boolean)

  const allLedgers = listTaskLedgers(roots.mainRoot, { includeTerminal: true })
  const readySlices = explicitTasks ? [] : scanUnstartedReadySlices(roots.mainRoot, allLedgers)
  const combined = [...items, ...readySlices]
  const filesMap = Object.fromEntries(combined.map((it) => [it.taskId, it.files ?? []]))
  const wavePlan = buildMultiTaskWavePlan(combined, filesMap)
  const waves = wavePlan.waves

  const out = {
    ok: true,
    totalTasks: wavePlan.totalTasks,
    parallelDispatch: wavePlan.parallelDispatch,
    readySlicesCount: readySlices.length,
    ...(excludedLockedTasks.length > 0 ? { excludedLockedTasks } : {}),
    slices: combined.map((it) => ({
      taskId: it.taskId,
      slug: it.slug ?? it.taskId,
      rel: it.specFile ?? it.todoFile ?? null,
      specFile: it.specFile ?? null,
      todoFile: it.todoFile ?? null,
      mutability: it.mutability ?? 'OPEN',
      dependsOn: it.dependsOn ?? [],
      scopeFiles: it.files ?? [],
    })),
    waves,
    order: wavePlan.order,
    parallelizable: wavePlan.parallelizable,
  }

  // `--handoff`：为当前可执行波次里的每个切片配上交接包。
  //
  // 只在显式要求时才算，因为交接包要读规划全文、抽验收标准与路径，成本远高于算波次；
  // 日常只看波次拓扑的人不该为它付这份开销。
  if (opts.handoff) {
    const sliceByKey = new Map()
    for (const s of graph.slices) {
      if (!s.key) continue
      const prev = sliceByKey.get(s.key)
      // SPEC 与 Todo 是同一片的两面：合并成一份对外视图，验收标准以 SPEC 为准。
      sliceByKey.set(s.key, prev ? { ...prev, todoFile: s.kind === 'todo' ? s.rel : prev.todoFile, specFile: s.kind === 'spec' ? s.rel : prev.specFile } : {
        ...s,
        specFile: s.kind === 'spec' ? s.rel : null,
        todoFile: s.kind === 'todo' ? s.rel : null,
      })
    }
    const targetWave = waves[0] ? [waves[0]] : []
    for (const w of targetWave) {
      w.handoffs = w.tasks.map((t) => buildSliceHandoff({
        mainRoot: roots.mainRoot, task: t, slice: sliceByKey.get(t.taskId) ?? null, profile: readProfileSafe(roots.mainRoot),
      }))
    }
    out.handoffWave = targetWave[0]?.wave ?? null
  }

  const wave1 = waves[0]?.tasks ?? []
  const batchPlanNext = wave1.length >= 2
    ? [{ skill: 'dev-flow', text: `并行派发 Wave 1（${wave1.map((t) => t.taskId).join(', ')}）至各自隔离工作位` }]
    : (wave1.length === 1
      ? [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${wave1[0].taskId}` }]
      : [])
  if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(out, batchPlanNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  else {
    process.stdout.write(`并行波次规划（共 ${out.totalTasks} 个任务/就绪切片，${waves.length} 个波次，parallelDispatch=${out.parallelDispatch}）：\n`)
    for (const w of waves) process.stdout.write(`  Wave ${w.wave} (${w.canParallel ? '可并行' : '串行'}): ${w.tasks.map((t) => t.taskId).join(', ')}\n`)
    if (out.handoffWave !== null && out.handoffWave !== undefined) {
      const hw = waves.find((w) => w.wave === out.handoffWave)
      for (const h of hw?.handoffs ?? []) {
        process.stdout.write(`\n[交接包] ${h.taskId}（依据 ${h.sourceDoc ?? '无规划文档'}，验收标准 ${h.criteriaCount} 条）\n`)
        process.stdout.write(`  派发：${h.dispatchCommand}\n`)
        if (h.scopeFiles.length > 0) process.stdout.write(`  写域：${h.scopeFiles.join(', ')}\n`)
        if (h.dependsOn.length > 0) process.stdout.write(`  依赖：${h.dependsOn.join(', ')}\n`)
      }
    }
    if (batchPlanNext.length > 0) printNextStep(batchPlanNext, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK, ...out }
}

async function handleCheckDisjoint(opts, roots) {
  const taskIds = parseTasksList(opts, roots.mainRoot)
  const fileOwners = new Map()
  const perTask = await Promise.all(taskIds.map(async (id) => {
    const ledger = readTaskLedger(roots.mainRoot, id)
    if (!ledger) throw new Error(`找不到任务账本：${id}`)
    return { taskId: id, files: await collectTaskTouchedFiles(roots.mainRoot, ledger) }
  }))
  for (const { taskId: id, files } of perTask) {
    for (const f of files) {
      if (!fileOwners.has(f)) fileOwners.set(f, [])
      fileOwners.get(f).push(id)
    }
  }

  const overlaps = []
  for (const [file, owners] of fileOwners.entries()) {
    if (owners.length > 1) overlaps.push({ file, tasks: owners })
  }

  if (overlaps.length > 0) {
    const out = {
      ok: false,
      blocked: true,
      disjoint: false,
      code: 'BLOCKED_OVERLAPPING_SLICE_FILES',
      exitCode: EXIT.FACT,
      overlaps,
      message: `BLOCKED_OVERLAPPING_SLICE_FILES: 并行切片存在文件重叠（${overlaps.map((o) => `${o.file}: [${o.tasks.join(', ')}]`).join('; ')}），必须拆波串行执行。`,
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    process.stderr.write(`${out.message}\n`)
    return { exitCode: EXIT.FACT, ...out }
  }

  const out = { ok: true, disjoint: true, tasks: perTask, overlaps: [] }
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else process.stdout.write(`并行切片互斥校验通过：${taskIds.length} 个任务零文件重叠。\n`)
  return { exitCode: EXIT.OK, ...out }
}

async function handleMergeQueue(opts, roots) {
  const { lockPath, statePath } = resolveQueuePaths(roots.mainRoot, roots.gitDir)
  return withFileLock(lockPath, async () => {
    const state = readJsonSafe(statePath) ?? null
    const hadStateFile = state !== null
    const baseState = state ?? { queue: [], history: [] }
    const queue = Array.isArray(baseState.queue) ? [...baseState.queue] : []
    const queueBefore = [...queue]
    if (opts.enqueue) {
      const enqId = sanitizeTaskId(opts.enqueue)
      if (!queue.includes(enqId)) queue.push(enqId)
    }
    if (opts.tasks && String(opts.tasks).trim()) {
      for (const raw of String(opts.tasks).split(/[\s,]+/).filter(Boolean)) {
        const id = sanitizeTaskId(raw)
        if (!queue.includes(id)) queue.push(id)
      }
    }

    // 零工作量不落盘。
    //
    // 空跑一次顺手写一份 `{queue:[],history:[]}`，后续读取会把它当成真实状态——
    // 而它只是「这次没事可做」。判据是「这次有没有真的改变队列或历史」，
    // 不是「队列是不是空的」：后者会把「处理完清空队列」也一并跳过，历史随之丢失。
    const queueChanged = JSON.stringify(queue) !== JSON.stringify(queueBefore)
    if (queueChanged) writeJsonAtomic(statePath, { queue, history: baseState.history ?? [] })

    if (opts['enqueue-only']) {
      const out = { ok: true, action: 'enqueued', queue }
      if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
      else process.stdout.write(`已入队 FIFO 合并队列：${queue.join(', ')}\n`)
      return { exitCode: EXIT.OK, ...out }
    }

    const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
    const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
    const remoteUrls = parseRemoteUrls(remoteRes.stdout)
    const topology = parseRemotesTopology(remoteRes.stdout)
    const declaredRepo = detectDeclaredRepo(roots.mainRoot)
    const defaultBranch = (roots.gitDir ? readRefsFast(roots.gitDir, null, fastCfg?.initDefaultBranch, { strict: true }) : null)
      ?? await resolveDefaultBranch(roots.mainRoot, { strict: true })
    let sharedGhProbe = opts._ghProbe ?? null
    const results = []
    let stoppedWithFailure = false
    let exitCode = 0

    while (queue.length > 0) {
      const taskId = queue.shift()
      const ledger = readTaskLedger(roots.mainRoot, taskId)
      if (!ledger) throw new Error(`合并队列找不到任务账本：${taskId}`)

      const targetCtx = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)
      const originFull = targetCtx.targetRepo ?? targetCtx.originFull
      const pushRemote = targetCtx.pushRemote
      const canUseGhApi = Boolean(ledger.role === 'maintainer' && targetCtx.capabilities?.api === true && originFull)
      const needsOnlineRemoteMerge = Boolean(canUseGhApi && ledger.prNumber && !opts['trial-local'])
      if (needsOnlineRemoteMerge && !sharedGhProbe && !opts._ghClient) {
        sharedGhProbe = await probeForWrite({ cwd: roots.mainRoot, remoteUrls })
      }
      const backend = createTaskBackend({
        role: ledger.role,
        providerId: ledger.providerId && ledger.providerId !== 'none' ? ledger.providerId : targetCtx.providerId,
        targetRepo: originFull,
        client: opts._ghClient ?? sharedGhProbe?.client,
        pushRemote,
        mainRoot: roots.mainRoot,
        gitDir: roots.gitDir,
      })

      const gate = await assertPreMergeGates({
        mainRoot: roots.mainRoot,
        gitDir: roots.gitDir,
        taskId,
        ledger,
        opts: { ...opts, json: false },
        backend,
        targetRepo: originFull,
      })
      if (!gate.ok) {
        queue.unshift(taskId)
        results.push({ taskId, ok: false, blocked: true, code: gate.code, exitCode: gate.exitCode })
        stoppedWithFailure = true
        exitCode = gate.exitCode ?? EXIT.FACT
        break
      }

      if (needsOnlineRemoteMerge && gate.currentHead) {
        const checks = await backend.getCommitChecks({ repo: originFull, ref: gate.currentHead })
        const ciRequired = hasRepoCiWorkflow(gate.implRoot)
        const verdict = evaluateRemoteChecks(checks, { ciRequired, headSha: gate.currentHead })
        if (verdict.blocking && !opts['human-approved']) {
          queue.unshift(taskId)
          process.stderr.write(`${verdict.message}\n`)
          results.push({ taskId, ok: false, blocked: true, code: verdict.code, exitCode: EXIT.FACT, checks })
          stoppedWithFailure = true
          exitCode = EXIT.FACT
          break
        }
      }

      const baseBranch = ledger.baseBranch || defaultBranch
      if (!baseBranch) {
        queue.unshift(taskId)
        results.push({ taskId, ok: false, blocked: true, code: 'BLOCKED_MISSING_DEFAULT_BRANCH', exitCode: EXIT.FACT })
        stoppedWithFailure = true
        exitCode = EXIT.FACT
        break
      }
      const fastBaseSha = resolveRefShaFast(roots.gitDir, `refs/heads/${baseBranch}`)
      const curBaseRes = fastBaseSha ? { ok: true, stdout: fastBaseSha } : await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`])
      const currentBaseSha = curBaseRes.ok ? curBaseRes.stdout.trim() : null
      const baseDrifted = Boolean(ledger.baseSha && currentBaseSha && ledger.baseSha !== currentBaseSha)

      let mergeRes
      if (needsOnlineRemoteMerge) {
        mergeRes = await backend.mergePr({ repo: originFull, number: ledger.prNumber, method: opts.method ?? 'merge' })
      } else if (ledger.role === 'generic-git' || ledger.providerId === 'generic-git') {
        mergeRes = await backend.mergePr({
          humanApproved: Boolean(opts['human-approved']),
          reason: opts.reason ?? '',
          ledger,
          branch: ledger.branch,
          baseBranch,
        })
      } else {
        mergeRes = await runTrialMerge({
          mainRoot: roots.mainRoot,
          ledger,
          baseBranch,
          profile: gate.profile,
          evidence: gate.evidence,
          policy: gate.policy,
          changedFiles: gate.changed,
          runVerify: true,
        })
      }

      if (!mergeRes?.ok || mergeRes.blocked) {
        const conflictInfo = {
          code: mergeRes?.code || 'BLOCKED_TRIAL_MERGE_CONFLICT',
          message: mergeRes?.message || mergeRes?.error || 'merge-queue 试合失败',
          baseBranch,
          baseShaAtQueue: currentBaseSha,
          driftedFromBaseSha: ledger.baseSha ?? null,
          baseDrifted,
          detectedAt: new Date().toISOString(),
        }
        await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({
          ...cur,
          status: 'rework',
          queueConflict: conflictInfo,
        }))
        results.push({ taskId, ok: false, status: 'rework', baseDrifted, queueConflict: conflictInfo })
        stoppedWithFailure = true
        exitCode = mergeRes?.exitCode ?? EXIT.FACT
        break
      }

      let syncOut = { mergeComments: [], syncFailures: [], issueCloseDecisions: [] }
      if (mergeRes?.merged !== false
        && ((ledger.linkedIssues ?? []).length > 0 || (ledger.escalatedIssues ?? []).length > 0 || (needsOnlineRemoteMerge && ledger.prNumber))) {
        syncOut = await syncPostMergeTargets({
          backend,
          repo: needsOnlineRemoteMerge ? originFull : null,
          mainRoot: roots.mainRoot,
          implRoot: gate.implRoot,
          ledger,
          taskId,
          baseBranch,
          currentHead: gate.currentHead,
          mergeRes,
          effectiveReviewer: gate.effectiveReviewer,
          stopLossActive: gate.stopLossActive,
          gateFindings: gate.gateFindings,
          ghLogin: sharedGhProbe?.env?.trackB?.login,
          ghTier: sharedGhProbe?.env?.trackB?.tier,
          includePrComment: Boolean(needsOnlineRemoteMerge && ledger.prNumber),
        })
      }

      await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({
        ...cur,
        status: 'merged',
        ...(mergeRes?.state === 'MERGED' || mergeRes?.merged === true ? { prState: 'MERGED' } : {}),
        mergedAt: new Date().toISOString(),
        queueConflict: null,
        mergedIntoSha: mergeRes.mergedSha ?? null,
        ...(syncOut.mergeComments.length > 0 ? { mergeComments: syncOut.mergeComments } : {}),
        ...(syncOut.syncFailures.length > 0 ? {
          syncFailures: [...(Array.isArray(cur?.syncFailures) ? cur.syncFailures : []), ...syncOut.syncFailures],
        } : {}),
      }))
      results.push({
        taskId,
        ok: true,
        status: 'merged',
        baseDrifted,
        mergedSha: mergeRes.mergedSha ?? null,
        ...(syncOut.issueCloseDecisions.length > 0 ? { issueCloseDecisions: syncOut.issueCloseDecisions } : {}),
      })
    }

    // 这一路同理：只有真处理了东西（或队列发生了变化）才落盘。
    // 队列里本来有条目、这次一个都没跑成，那也不叫空跑——照常写，历史要留下痕迹。
    const historyChanged = results.length > 0
    if (historyChanged || queueChanged || (hadStateFile && state !== null && queue.length !== queueBefore.length)) {
      const nextHistory = [...(baseState.history ?? []), ...results].slice(-50)
      writeJsonAtomic(statePath, { queue, history: nextHistory })
    }
    const out = {
      ok: !stoppedWithFailure,
      exitCode,
      processed: results,
      remainingQueue: queue,
      ...(historyChanged || queueChanged ? {} : { skippedWrite: '本次零工作量：没有入队、没有可处理项、队列未变，未写队列状态文件' }),
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else {
      process.stdout.write(`FIFO 合并队列执行完成：处理 ${results.length} 项，剩余队列 ${queue.length} 项。\n`)
      for (const r of results) {
        const statusLabel = r.ok ? `merged (drifted=${r.baseDrifted})` : (r.queueConflict ? `rework (${r.queueConflict.code})` : `blocked (${r.code})`)
        process.stdout.write(`- ${r.taskId}: ${statusLabel}\n`)
      }
    }
    return { exitCode, ...out }
  })
}

async function handleResumeSession(opts, roots) {
  if (!opts.task) throw new Error('batch resume-session 需要指定 --task <taskId>')
  const taskId = sanitizeTaskId(opts.task)
  const existing = readTaskLedger(roots.mainRoot, taskId)
  if (!existing) throw new Error(`找不到任务账本：${taskId}`)

  const implRoot = existing.worktreePath ? resolve(roots.mainRoot, existing.worktreePath) : roots.mainRoot
  const fastResumeHead = existsSync(implRoot) ? (readHeadFast(resolveGitDirFast(implRoot), roots.gitDir)?.oid ?? null) : null
  const headRes = existsSync(implRoot)
    ? (fastResumeHead ? { ok: true, stdout: fastResumeHead } : await gitRun(implRoot, ['rev-parse', 'HEAD']))
    : { ok: false, stdout: '' }
  const headSha = headRes.ok ? headRes.stdout.trim() : null
  const nextState = evaluateNextState({ activeTasks: [existing], selectedTask: existing, taskRuntime: { headSha } })
  const prevEpoch = Number(existing.sessionHandle?.epoch) || 0
  const sessionHandle = {
    epoch: prevEpoch + 1,
    handoffToken: randomBytes(8).toString('hex'),
    lastPhase: nextState.phase,
    headSha,
    resumedAt: new Date().toISOString(),
  }
  const { ledger } = await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({ ...cur, sessionHandle }))
  const out = {
    ok: true,
    taskId,
    sessionHandle: ledger.sessionHandle,
    compactContext: nextState.compactContext,
    nextAction: nextState.nextAction,
    command: nextState.command,
  }
  const resumeNext = [{ skill: 'dev-flow', text: nextState.command }]
  if (opts.json) process.stdout.write(`${JSON.stringify(withNextSteps(out, resumeNext, { repoRoot: roots.mainRoot }), null, 2)}\n`)
  else {
    process.stdout.write(`会话句柄已轮换（task=${taskId}, epoch=${sessionHandle.epoch}, token=${sessionHandle.handoffToken}）。\n`)
    printNextStep(resumeNext, { repoRoot: roots.mainRoot })
  }
  return { exitCode: EXIT.OK, ...out }
}

export async function handleBatch(opts, roots) {
  const action = opts._?.[0] ?? opts.action
  if (action === 'plan') return handleBatchPlan(opts, roots)
  if (action === 'check-disjoint') return handleCheckDisjoint(opts, roots)
  if (action === 'merge-queue') return handleMergeQueue(opts, roots)
  if (action === 'resume-session') return handleResumeSession(opts, roots)
  throw new Error(`batch 子命令仅支持 plan | check-disjoint | merge-queue | resume-session，收到：${action ?? '未指定'}`)
}
