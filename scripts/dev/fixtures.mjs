#!/usr/bin/env node
/**
 * fixtures.mjs —— 行为断言调度入口：默认按测试域派生隔离子进程并发实跑，支持 `--domain` / `--only` / `--jobs`。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { killProcessTree, supportsSafeDetachedSpawn } from '../../kit/skills/lib/exec.mjs'
import { initTestBackupDir, traceFixtureStage } from './fixtures-helpers.mjs'
import { registerCoreCases } from './fixtures-core.mjs'
import { registerSurveyCases } from './fixtures-survey.mjs'
import { registerContractCases } from './fixtures-contracts.mjs'
import { registerReviewCases } from './fixtures-review.mjs'
import { registerClaimsCases } from './fixtures-claims.mjs'
import { registerFlowDocsCases } from './fixtures-flow-docs.mjs'
import { registerDocRuleCases } from './fixtures-doc-rules.mjs'
import { registerDocShapeCases } from './fixtures-doc-shapes.mjs'
import { registerDocTriageCases } from './fixtures-doc-triage.mjs'
import { registerHandoffReviewCases } from './fixtures-handoff-review.mjs'
import { registerExploreCases } from './fixtures-explore.mjs'
import { registerDocsCases } from './fixtures-docs.mjs'
import { registerFlowCases } from './fixtures-flow.mjs'
import { registerFlowCleanupCases } from './fixtures-flow-cleanup.mjs'
import { registerFlowStateCases } from './fixtures-flow-state.mjs'
import { registerFlowParallelCases } from './fixtures-flow-parallel.mjs'
import { registerLifecycleCases } from './fixtures-lifecycle.mjs'
import { registerReviewGovernCases } from './fixtures-review-govern.mjs'
import { registerGovernCases } from './fixtures-govern.mjs'
import { registerEquipCases } from './fixtures-equip.mjs'
import { registerPlatformCases } from './fixtures-platform.mjs'
import { registerReviewEmpiricalCases } from './fixtures-review-empirical.mjs'
import { registerOnboardingCases } from './fixtures-onboarding.mjs'
import { registerDocDepthCases } from './fixtures-doc-depth.mjs'
import { registerIssue50Cases } from './fixtures-issue50.mjs'

initTestBackupDir()

const DOMAIN_REGISTRY = [
  ['flow', registerFlowCases],
  ['flow-cleanup', registerFlowCleanupCases],
  ['flow-state', registerFlowStateCases],
  ['flow-parallel', registerFlowParallelCases],
  ['lifecycle', registerLifecycleCases],
  ['review-govern', registerReviewGovernCases],
  ['review-empirical', registerReviewEmpiricalCases],
  ['govern', registerGovernCases],
  ['claims', registerClaimsCases],
  ['flow-docs', registerFlowDocsCases],
  ['doc-rules', registerDocRuleCases],
  ['doc-shapes', registerDocShapeCases],
  ['doc-depth', registerDocDepthCases],
  ['doc-triage', registerDocTriageCases],
  ['handoff-review', registerHandoffReviewCases],
  ['equip', registerEquipCases],
  ['onboarding', registerOnboardingCases],
  ['docs', registerDocsCases],
  ['platform', registerPlatformCases],
  ['explore', registerExploreCases],
  ['contracts', registerContractCases],
  ['core', registerCoreCases],
  ['review', registerReviewCases],
  ['survey', registerSurveyCases],
  ['issue50', registerIssue50Cases],
]

function parseCliFlags(argv) {
  let prefer = ''
  let bailOn = ''
  let only = ''
  let domain = ''
  let shard = ''
  let worker = false
  let jobsArg
  let profile = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prefer' && i + 1 < argv.length) { prefer = argv[++i]; continue }
    if (arg.startsWith('--prefer=')) { prefer = arg.slice('--prefer='.length); continue }
    if (arg === '--bail-on' && i + 1 < argv.length) { bailOn = argv[++i]; continue }
    if (arg.startsWith('--bail-on=')) { bailOn = arg.slice('--bail-on='.length); continue }
    if (arg === '--only' && i + 1 < argv.length) { only = argv[++i]; continue }
    if (arg.startsWith('--only=')) { only = arg.slice('--only='.length); continue }
    if (arg === '--domain' && i + 1 < argv.length) { domain = argv[++i]; continue }
    if (arg.startsWith('--domain=')) { domain = arg.slice('--domain='.length); continue }
    if (arg === '--shard' && i + 1 < argv.length) { shard = argv[++i]; continue }
    if (arg.startsWith('--shard=')) { shard = arg.slice('--shard='.length); continue }
    if (arg === '--worker') { worker = true; continue }
    if (arg === '--profile') { profile = true; continue }
    if (arg === '--jobs' && i + 1 < argv.length) { jobsArg = Number(argv[++i]); continue }
    if (arg.startsWith('--jobs=')) { jobsArg = Number(arg.slice('--jobs='.length)); continue }
  }
  return { prefer, bailOn, only, domain, shard, worker, profile, jobsArg }
}

/** 用例命中的判据：标题或函数体里出现关键字即算命中。 */
function caseMatches(fn, keyword) {
  return fn[0].includes(keyword) || fn[1].toString().includes(keyword)
}

const RAW_STDOUT_WRITE = process.stdout.write.bind(process.stdout)

async function runCase([name, fn]) {
  const t0 = performance.now()
  traceFixtureStage(`case-start:${name.slice(0, 60)}`, true)
  try {
    const outcome = await fn()
    const ms = Math.round(performance.now() - t0)
    if (outcome === true) return { ok: true, name, ms }
    return { ok: false, name, ms, entry: `${name} —— ${outcome}` }
  } catch (error) {
    const ms = Math.round(performance.now() - t0)
    const msg = error instanceof Error ? `${error.message} [${error.stack?.split('\n').slice(1, 3).map((s) => s.trim()).join(' <- ') ?? ''}]` : String(error)
    return { ok: false, name, ms, entry: `${name} —— 抛异常：${msg}` }
  }
}

/**
 * 派发顺序：**最贵的先跑**。
 *
 * 用例可以带第三段声明自己的成本（毫秒，`--profile` 实测值）：
 *
 *   cases.push(['名字', async () => { ... }, 3800])
 *
 * 不声明的按 0 处理。多核并行时先派长任务，尾巴最短；
 * 而「哪个长」是**用例自己说的**，不是框架靠名字猜的——
 * 名字一改就该照常工作，不该悄悄换一个调度顺序。
 */
function buildDispatchOrder(allCases) {
  return allCases
    .map(([, , costMs], index) => ({ index, cost: Number(costMs) > 0 ? Number(costMs) : 0 }))
    .sort((a, b) => (b.cost - a.cost) || (a.index - b.index))
    .map((x) => x.index)
}

const WORKER_TASK_TIMEOUT_MS = 90000
const WORKER_MSG_PREFIX = '__PF_W__:'

function runDynamicWorkerPool(scriptPath, dispatchOrder, lanes, workerBkRoot, caseNames = []) {
  return new Promise((done) => {
    let cursor = 0
    let passed = 0
    const failures = []
    const timings = []
    let activeWorkers = lanes
    const activeChildren = new Set()

    const cleanupWorkers = (sig) => {
      for (const ch of activeChildren) killProcessTree(ch, false)
      process.exit(sig === 'SIGINT' ? 130 : 143)
    }
    const onSigTerm = () => cleanupWorkers('SIGTERM')
    const onSigInt = () => cleanupWorkers('SIGINT')
    process.once('SIGTERM', onSigTerm)
    process.once('SIGINT', onSigInt)

    const onWorkerFinished = () => {
      activeWorkers -= 1
      if (activeWorkers === 0) {
        process.off('SIGTERM', onSigTerm)
        process.off('SIGINT', onSigInt)
        done({ passed, failures, timings })
      }
    }

    for (let i = 0; i < lanes; i += 1) {
      const tag = `w-${i}`
      const traceFile = join(workerBkRoot, `${tag}.trace`)
      const child = spawn(process.execPath, [scriptPath, '--worker'], {
        env: {
          ...process.env,
          PF_NO_REAL_AUTH_PROBE: process.env.PF_NO_REAL_AUTH_PROBE || '1',
          PF_BACKUP_DIR: join(workerBkRoot, tag),
          PF_FIXTURE_WORKER: '1',
          PF_TRACE_FILE: traceFile,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      activeChildren.add(child)
      child.stdin?.on('error', () => {})
      let outBuf = ''
      let errBuf = ''
      let currentIdx = null
      let taskStartedAt = 0
      let finalized = false
      let taskTimer = null
      let closeFallback = null
      let timedOutMsg = null
      child.stderr?.on('data', (c) => { errBuf += c })

      const clearTaskTimer = () => {
        if (taskTimer) { clearTimeout(taskTimer); taskTimer = null }
      }

      const sendWorkerMsg = (obj) => {
        try {
          if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
            child.stdin.write(`${JSON.stringify(obj)}\n`)
          }
        } catch { /* worker exiting */ }
      }

      const readTraceSummary = () => {
        if (!existsSync(traceFile)) return ''
        try {
          const raw = readFileSync(traceFile, 'utf8').trim()
          if (!raw) return ''
          const sp = raw.indexOf(' ')
          const ts = sp > 0 ? Number(raw.slice(0, sp)) : NaN
          const stage = sp > 0 ? raw.slice(sp + 1).trim() : raw
          const stageAge = Number.isFinite(ts) ? `, stageAge=${Date.now() - ts}ms` : ''
          const totalElapsed = taskStartedAt ? `, elapsed=${Date.now() - taskStartedAt}ms` : ''
          return `; lastStage=${stage}${stageAge}${totalElapsed}`
        } catch { return '' }
      }

      const finishWorker = (code) => {
        if (finalized) return
        finalized = true
        activeChildren.delete(child)
        clearTaskTimer()
        if (closeFallback) { clearTimeout(closeFallback); closeFallback = null }
        if (timedOutMsg) {
          failures.push(timedOutMsg)
        } else if (currentIdx !== null) {
          failures.push(`工作进程 ${tag} 在用例 #${currentIdx}（${caseNames[currentIdx] ?? 'unknown'}）异常退出 (${code})：${errBuf.trim()}${readTraceSummary()}`)
        }
        onWorkerFinished()
      }

      const armTaskWatchdog = (idx) => {
        clearTaskTimer()
        taskStartedAt = Date.now()
        taskTimer = setTimeout(() => {
          const name = caseNames[idx] ?? 'unknown'
          timedOutMsg = `工作进程 ${tag} 在用例 #${idx}（${name}）执行超时 (>${WORKER_TASK_TIMEOUT_MS}ms${readTraceSummary()})`
          killProcessTree(child, false)
          closeFallback = setTimeout(() => finishWorker(124), 3000)
          closeFallback.unref?.()
        }, WORKER_TASK_TIMEOUT_MS)
        taskTimer.unref?.()
      }

      const dispatchNext = () => {
        clearTaskTimer()
        if (cursor < dispatchOrder.length) {
          currentIdx = dispatchOrder[cursor++]
          armTaskWatchdog(currentIdx)
          sendWorkerMsg({ type: 'run', index: currentIdx })
        } else {
          currentIdx = null
          sendWorkerMsg({ type: 'stop' })
          try { child.stdin?.end() } catch { /* ignore */ }
        }
      }

      const handleWorkerMessage = (msg) => {
        if (!msg) return
        if (msg.type === 'ready') {
          dispatchNext()
        } else if (msg.type === 'done') {
          currentIdx = null
          clearTaskTimer()
          if (Number.isFinite(msg.ms)) timings.push({ index: msg.index, name: msg.name, ms: msg.ms, worker: tag })
          if (msg.ok) passed += 1
          else failures.push(msg.entry)
          dispatchNext()
        }
      }

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        outBuf += chunk
        let nl
        while ((nl = outBuf.indexOf('\n')) >= 0) {
          const line = outBuf.slice(0, nl).trim()
          outBuf = outBuf.slice(nl + 1)
          if (!line.startsWith(WORKER_MSG_PREFIX)) continue
          try {
            handleWorkerMessage(JSON.parse(line.slice(WORKER_MSG_PREFIX.length)))
          } catch { /* ignore malformed non-protocol line */ }
        }
      })

      child.on('close', (code) => finishWorker(code))

      child.on('error', (error) => {
        if (finalized) return
        finalized = true
        activeChildren.delete(child)
        clearTaskTimer()
        if (closeFallback) { clearTimeout(closeFallback); closeFallback = null }
        failures.push(`工作进程 ${tag} 启动失败：${error.message}`)
        onWorkerFinished()
      })
    }
  })
}

async function main() {
  const { prefer, bailOn, only, domain, shard, worker, profile, jobsArg } = parseCliFlags(process.argv.slice(2))

  if (worker) {
    const allCases = []
    for (const [, registerFn] of DOMAIN_REGISTRY) registerFn(allCases)
    process.stdout.write = (chunk, enc, cb) => {
      if (typeof enc === 'function') enc()
      else if (typeof cb === 'function') cb()
      return true
    }
    const emit = (obj) => RAW_STDOUT_WRITE(`${WORKER_MSG_PREFIX}${JSON.stringify(obj)}\n`)
    let inBuf = ''
    let queue = Promise.resolve()
    let stopped = false
    const handleCommand = async (line) => {
      if (!line || stopped) return
      let msg
      try { msg = JSON.parse(line) } catch { return }
      if (msg.type === 'stop') {
        stopped = true
        await flushAndExit(0)
        return
      }
      if (msg.type === 'run') {
        const entry = allCases[msg.index]
        const res = entry ? await runCase(entry) : { ok: false, entry: `缺失用例索引 ${msg.index}` }
        emit({ type: 'done', index: msg.index, ...res })
      }
    }
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      inBuf += chunk
      let nl
      while ((nl = inBuf.indexOf('\n')) >= 0) {
        const line = inBuf.slice(0, nl).trim()
        inBuf = inBuf.slice(nl + 1)
        queue = queue.then(() => handleCommand(line))
      }
    })
    process.stdin.on('end', () => {
      queue = queue.then(async () => {
        if (!stopped) await flushAndExit(0)
      })
    })
    emit({ type: 'ready' })
    return new Promise(() => {})
  }

  if (domain) {
    const found = DOMAIN_REGISTRY.find(([name]) => name === domain)
    if (!found) {
      process.stderr.write(`未知测试域：${domain}（可用：${DOMAIN_REGISTRY.map(([n]) => n).join(', ')}）\n`)
      return 2
    }
    const domainCases = []
    found[1](domainCases)
    const filtered = only ? domainCases.filter((fn) => caseMatches(fn, only)) : domainCases
    let passed = 0
    const failures = []
    for (const entry of filtered) {
      const result = await runCase(entry)
      if (result.ok) passed += 1
      else {
        failures.push(result.entry)
        if (bailOn && `FAIL  ${result.entry}`.includes(bailOn)) break
      }
    }
    if (process.env.PF_FIXTURE_WORKER === '1') {
      process.stdout.write(`\n__PF_WORKER_JSON__:${JSON.stringify({ tag: domain, passed, failures })}\n`)
      return failures.length === 0 ? 0 : 1
    }
    if (failures.length === 0) {
      process.stdout.write(`行为断言：${passed} 项通过，0 项失败（--domain ${domain}）。\n`)
      return 0
    }
    for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
    process.stderr.write(`\n行为断言：${passed} 通过 / ${failures.length} 失败（--domain ${domain}）。\n`)
    return 1
  }

  if (shard) {
    const sm = /^(\d+)\/(\d+)$/.exec(shard)
    if (!sm) {
      process.stderr.write(`非法 --shard 参数：${shard}（应为 <index>/<total>）\n`)
      return 2
    }
    const shardIdx = Number(sm[1])
    const shardTotal = Number(sm[2])
    if (shardTotal < 1 || shardIdx < 0 || shardIdx >= shardTotal) {
      process.stderr.write(`非法 --shard 范围：${shard}\n`)
      return 2
    }
    const allCases = []
    for (const [, registerFn] of DOMAIN_REGISTRY) registerFn(allCases)
    const myCases = allCases.filter((_, idx) => idx % shardTotal === shardIdx)
    let passed = 0
    const failures = []
    for (const entry of myCases) {
      const result = await runCase(entry)
      if (result.ok) passed += 1
      else failures.push(result.entry)
    }
    if (process.env.PF_FIXTURE_WORKER === '1') {
      process.stdout.write(`\n__PF_WORKER_JSON__:${JSON.stringify({ tag: shard, passed, failures })}\n`)
      return failures.length === 0 ? 0 : 1
    }
    if (failures.length === 0) {
      process.stdout.write(`行为断言：${passed} 项通过，0 项失败（--shard ${shard}）。\n`)
      return 0
    }
    for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
    process.stderr.write(`\n行为断言：${passed} 通过 / ${failures.length} 失败（--shard ${shard}）。\n`)
    return 1
  }

  // 全量跑且未传 --only / --bail-on 时，默认按动态工作窃取队列派生隔离子进程池（macOS Node < 20 限 2 并发防调度拥塞，>= 12 核主机开 9 并发兼顾吞吐与低上下文切换）
  const isMacLegacyNode = process.platform === 'darwin' && !supportsSafeDetachedSpawn()
  const cpuCount = cpus().length
  const defaultCap = isMacLegacyNode ? 2 : (cpuCount >= 12 ? 9 : 8)
  const defaultJobs = only || bailOn ? 1 : Math.min(defaultCap, Math.max(2, cpuCount))
  const lanes = Number.isFinite(jobsArg) && jobsArg >= 1
    ? Math.min(Math.floor(jobsArg), Math.max(1, cpus().length))
    : defaultJobs

  if (lanes > 1 && !only && !bailOn) {
    const allCases = []
    for (const [, registerFn] of DOMAIN_REGISTRY) registerFn(allCases)
    const scriptPath = fileURLToPath(import.meta.url)
    const workerBkRoot = mkdtempSync(join(tmpdir(), 'pf-fix-pool-'))
    try {
      const dispatchOrder = buildDispatchOrder(allCases)
      const { passed: totalPassed, failures: allFailures, timings } = await runDynamicWorkerPool(
        scriptPath,
        dispatchOrder,
        Math.min(lanes, allCases.length),
        workerBkRoot,
        allCases.map(([name]) => name),
      )
      if (profile) {
        const sorted = [...timings].sort((a, b) => b.ms - a.ms)
        const sumMs = sorted.reduce((acc, item) => acc + item.ms, 0)
        process.stdout.write(`\n[profile] total_case_cpu=${sumMs}ms top25:\n`)
        for (const item of sorted.slice(0, 25)) {
          process.stdout.write(`  ${String(item.ms).padStart(5)}ms [#${item.index} ${item.worker}] ${item.name}\n`)
        }
      }
      if (allFailures.length === 0) {
        process.stdout.write(`行为断言：${totalPassed} 项通过，0 项失败（${lanes} 隔离子进程动态并发）。\n`)
        return 0
      }
      for (const f of allFailures) process.stderr.write(`FAIL  ${f}\n`)
      process.stderr.write(`\n行为断言：${totalPassed} 通过 / ${allFailures.length} 失败。\n`)
      return 1
    } finally {
      try { rmSync(workerBkRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ }
    }
  }

  const cases = []
  for (const [, registerFn] of DOMAIN_REGISTRY) registerFn(cases)
  const selected = only ? cases.filter((fn) => caseMatches(fn, only)) : cases
  if (only && selected.length === 0) {
    process.stderr.write(`没有用例匹配 --only ${only}：关键字写错时会一条都不跑，而「没跑」看着和「全过」一样。\n`)
    return 1
  }
  const orderedCases = prefer
    ? [...selected.filter((fn) => caseMatches(fn, prefer)), ...selected.filter((fn) => !caseMatches(fn, prefer))]
    : selected

  let passed = 0
  const failures = []
  for (const entry of orderedCases) {
    const result = await runCase(entry)
    if (result.ok) passed += 1
    else {
      failures.push(result.entry)
      if (bailOn && `FAIL  ${result.entry}`.includes(bailOn)) break
    }
  }
  if (failures.length === 0) {
    const scope = only ? `（--only ${only}，共 ${passed} 项）` : ''
    process.stdout.write(`行为断言：${passed} 项通过，0 项失败${scope}。\n`)
    return 0
  }
  for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
  process.stderr.write(`\n行为断言：${passed} 通过 / ${failures.length} 失败。\n`)
  return 1
}

main().then((code) => flushAndExit(code))
