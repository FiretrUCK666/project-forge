/**
 * flow-batch.mjs —— 宿主无关并行波次规划（plan）、文件互斥校验（check-disjoint）、
 * FIFO 串行合并队列（merge-queue）与跨会话句柄轮换（resume-session）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零特定宿主名称耦合。
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import {
  gitRun, posixPath, readJsonSafe, resolveDefaultBranch, withFileLock, writeJsonAtomic,
} from '../../lib/git.mjs'
import { readGitConfigFast, readHeadFast, readRefsFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { listTaskLedgers, readTaskLedger, sanitizeTaskId, updateTaskLedger } from '../../lib/ledger.mjs'
import { detectDeclaredRepo, parseRemotesTopology, parseRemoteUrls, probeForWrite } from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildMultiTaskWavePlan, evaluateNextState, hasRepoCiWorkflow, scanUnstartedReadySlices } from '../../lib/workflow-policy.mjs'
import { buildTargetRepoContext, EXIT_POLICY_BLOCK, getChangedFiles } from './flow-inspect.mjs'
import { assertPreMergeGates } from './flow-merge.mjs'
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

async function handleBatchPlan(opts, roots) {
  const explicitTasks = Boolean(opts.tasks && String(opts.tasks).trim())
  const taskIds = parseTasksList(opts, roots.mainRoot)
  const items = await Promise.all(taskIds.map(async (id) => {
    const ledger = readTaskLedger(roots.mainRoot, id)
    if (!ledger) throw new Error(`找不到任务账本：${id}`)
    const files = await collectTaskTouchedFiles(roots.mainRoot, ledger)
    const deps = [
      ...(Array.isArray(ledger.dependsOn) ? ledger.dependsOn.map(String) : []),
      ...(ledger.parentTaskId ? [String(ledger.parentTaskId)] : []),
    ]
    return { taskId: id, files, dependsOn: deps, status: ledger.status, branch: ledger.branch }
  }))

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
    waves,
    order: wavePlan.order,
    parallelizable: wavePlan.parallelizable,
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else {
    process.stdout.write(`并行波次规划（共 ${out.totalTasks} 个任务/就绪切片，${waves.length} 个波次，parallelDispatch=${out.parallelDispatch}）：\n`)
    for (const w of waves) process.stdout.write(`  Wave ${w.wave} (${w.canParallel ? '可并行' : '串行'}): ${w.tasks.map((t) => t.taskId).join(', ')}\n`)
    const wave1 = waves[0]?.tasks ?? []
    if (wave1.length >= 2) {
      printNextStep([{ skill: 'dev-flow', text: `并行派发 Wave 1（${wave1.map((t) => t.taskId).join(', ')}）至各自隔离工作位` }], { repoRoot: roots.mainRoot })
    } else if (wave1.length === 1) {
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${wave1[0].taskId}` }], { repoRoot: roots.mainRoot })
    }
  }
  return { exitCode: 0, ...out }
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
      exitCode: EXIT_POLICY_BLOCK,
      overlaps,
      message: `BLOCKED_OVERLAPPING_SLICE_FILES: 并行切片存在文件重叠（${overlaps.map((o) => `${o.file}: [${o.tasks.join(', ')}]`).join('; ')}），必须拆波串行执行。`,
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    process.stderr.write(`${out.message}\n`)
    return { exitCode: EXIT_POLICY_BLOCK, ...out }
  }

  const out = { ok: true, disjoint: true, tasks: perTask, overlaps: [] }
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else process.stdout.write(`并行切片互斥校验通过：${taskIds.length} 个任务零文件重叠。\n`)
  return { exitCode: 0, ...out }
}

async function handleMergeQueue(opts, roots) {
  const { lockPath, statePath } = resolveQueuePaths(roots.mainRoot, roots.gitDir)
  return withFileLock(lockPath, async () => {
    const state = readJsonSafe(statePath) ?? { queue: [], history: [] }
    const queue = Array.isArray(state.queue) ? [...state.queue] : []
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
    writeJsonAtomic(statePath, { queue, history: state.history ?? [] })

    if (opts['enqueue-only']) {
      const out = { ok: true, action: 'enqueued', queue }
      if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
      else process.stdout.write(`已入队 FIFO 合并队列：${queue.join(', ')}\n`)
      return { exitCode: 0, ...out }
    }

    const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
    const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(roots.mainRoot, ['remote', '-v'])
    const remoteUrls = parseRemoteUrls(remoteRes.stdout)
    const topology = parseRemotesTopology(remoteRes.stdout)
    const declaredRepo = detectDeclaredRepo(roots.mainRoot)
    const defaultBranch = (roots.gitDir ? readRefsFast(roots.gitDir, null, fastCfg?.initDefaultBranch) : null)
      ?? await resolveDefaultBranch(roots.mainRoot)
    let sharedGhProbe = opts._ghProbe ?? null
    const results = []
    let stoppedWithFailure = false
    let exitCode = 0

    while (queue.length > 0) {
      const taskId = queue.shift()
      const ledger = readTaskLedger(roots.mainRoot, taskId)
      if (!ledger) throw new Error(`合并队列找不到任务账本：${taskId}`)

      const { originFull, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)
      const canUseGhApi = Boolean(ledger.role === 'maintainer' && ledger.providerId !== 'generic-git' && originFull)
      const needsOnlineRemoteMerge = Boolean(canUseGhApi && ledger.prNumber && !opts['trial-local'])
      if (needsOnlineRemoteMerge && !sharedGhProbe && !opts._ghClient) {
        sharedGhProbe = await probeForWrite({ cwd: roots.mainRoot, remoteUrls })
      }
      const backend = createTaskBackend({
        role: ledger.role,
        providerId: ledger.providerId,
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
        exitCode = gate.exitCode ?? EXIT_POLICY_BLOCK
        break
      }

      if (needsOnlineRemoteMerge && gate.currentHead) {
        const checks = await backend.getCommitChecks({ repo: originFull, ref: gate.currentHead })
        const ciRequired = hasRepoCiWorkflow(gate.implRoot)
        let ciBlock = null
        if (checks?.ok) {
          if (checks.bucket === 'fail' && !opts['human-approved']) {
            const list = (checks.failed ?? []).map((c) => `${c.name}[${c.state}]`).join(', ')
            ciBlock = { code: 'BLOCKED_CI_FAILED', msg: `BLOCKED_CI_FAILED: 当前 HEAD (${gate.currentHead.slice(0, 7)}) 远端 CI 检查未通过（${list}），禁止带病合并。` }
          } else if (checks.bucket === 'pending' && !opts['human-approved']) {
            const list = (checks.pending ?? []).map((c) => `${c.name}[${c.state}]`).join(', ')
            ciBlock = { code: 'BLOCKED_CI_PENDING', msg: `BLOCKED_CI_PENDING: 当前 HEAD (${gate.currentHead.slice(0, 7)}) 远端 CI 仍在运行或排队（${list}），请等待全部变绿后再执行 merge。` }
          } else if (checks.bucket === 'none' && ciRequired && !opts['human-approved']) {
            ciBlock = { code: 'BLOCKED_CI_PENDING', msg: `BLOCKED_CI_PENDING: 仓库存在检查工作流，但当前 HEAD (${gate.currentHead.slice(0, 7)}) 远端尚未注册 check-run，请等待检查变绿后再执行 merge。` }
          }
        } else if (checks && !checks.skipped && ciRequired && !opts['human-approved']) {
          ciBlock = { code: 'BLOCKED_CI_UNVERIFIED', msg: `BLOCKED_CI_UNVERIFIED: 无法核验当前 HEAD (${gate.currentHead.slice(0, 7)}) 远端 CI 状态（${checks.error ?? 'unknown'}），拒绝盲目合并。` }
        }
        if (ciBlock) {
          queue.unshift(taskId)
          process.stderr.write(`${ciBlock.msg}\n`)
          results.push({ taskId, ok: false, blocked: true, code: ciBlock.code, exitCode: EXIT_POLICY_BLOCK, checks })
          stoppedWithFailure = true
          exitCode = EXIT_POLICY_BLOCK
          break
        }
      }

      const baseBranch = ledger.baseBranch || defaultBranch || 'main'
      const fastBaseSha = resolveRefShaFast(roots.gitDir, `refs/heads/${baseBranch}`)
      const curBaseRes = fastBaseSha ? { ok: true, stdout: fastBaseSha } : await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`])
      const currentBaseSha = curBaseRes.ok ? curBaseRes.stdout.trim() : null
      const baseDrifted = Boolean(ledger.baseSha && currentBaseSha && ledger.baseSha !== currentBaseSha)

      let mergeRes
      if (needsOnlineRemoteMerge) {
        mergeRes = await backend.mergePr({ repo: originFull, number: ledger.prNumber, method: opts.method ?? 'merge' })
      } else if (ledger.role === 'generic-git' || ledger.providerId === 'generic-git') {
        mergeRes = await backend.mergePr({
          remoteMerged: Boolean(opts['remote-merged']),
          humanApproved: Boolean(opts['human-approved']),
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
        exitCode = mergeRes?.exitCode ?? EXIT_POLICY_BLOCK
        break
      }

      await updateTaskLedger(roots.mainRoot, taskId, (cur) => ({
        ...cur,
        status: 'merged',
        mergedAt: new Date().toISOString(),
        queueConflict: null,
        mergedIntoSha: mergeRes.mergedSha ?? null,
      }))
      results.push({ taskId, ok: true, status: 'merged', baseDrifted, mergedSha: mergeRes.mergedSha ?? null })
    }

    const nextHistory = [...(state.history ?? []), ...results].slice(-50)
    writeJsonAtomic(statePath, { queue, history: nextHistory })
    const out = { ok: !stoppedWithFailure, exitCode, processed: results, remainingQueue: queue }
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
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else {
    process.stdout.write(`会话句柄已轮换（task=${taskId}, epoch=${sessionHandle.epoch}, token=${sessionHandle.handoffToken}）。\n`)
    printNextStep([{ skill: 'dev-flow', text: nextState.command }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0, ...out }
}

export async function handleBatch(opts, roots) {
  const action = opts._?.[0] ?? opts.action
  if (action === 'plan') return handleBatchPlan(opts, roots)
  if (action === 'check-disjoint') return handleCheckDisjoint(opts, roots)
  if (action === 'merge-queue') return handleMergeQueue(opts, roots)
  if (action === 'resume-session') return handleResumeSession(opts, roots)
  throw new Error(`batch 子命令仅支持 plan | check-disjoint | merge-queue | resume-session，收到：${action ?? '未指定'}`)
}
