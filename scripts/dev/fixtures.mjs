#!/usr/bin/env node
/**
 * fixtures.mjs —— 行为断言调度入口：默认按测试域派生隔离子进程并发实跑，支持 `--domain` / `--only` / `--jobs`。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { killProcessTree, supportsSafeDetachedSpawn } from '../../kit/skills/lib/exec.mjs'
import { applyLowPriority, resolveWorkerConcurrency } from '../../kit/skills/lib/proc-budget.mjs'
import { isMainModule } from '../lib/text.mjs'
import { initTestBackupDir, traceFixtureStage } from './fixtures-helpers.mjs'

initTestBackupDir()

// 重型测试域靠前调度以均衡并发子进程耗时；其余按文件名升序自动发现注册
const PRIORITY_DOMAINS = [
  'flow', 'flow-cleanup', 'flow-state', 'flow-parallel', 'lifecycle', 'sandbox-dual-loop', 'heterogeneous-dual-loop',
  'review-govern', 'review-empirical', 'govern', 'claims', 'flow-docs',
  'doc-rules', 'doc-shapes', 'doc-depth', 'doc-triage', 'handoff-review',
  'equip', 'onboarding', 'docs', 'platform', 'explore', 'contracts',
  'core', 'review', 'review-contracts', 'survey',
]
const PRIORITY_INDEX = new Map(PRIORITY_DOMAINS.map((name, i) => [name, i]))

// 通用自动发现并注册全部 `scripts/dev/fixtures-*.mjs` 功能域模块（自动跳过不含 register*Cases 的纯辅助模块）
const FIXTURES_DIR = dirname(fileURLToPath(import.meta.url))
const DISCOVERED_FILES = readdirSync(FIXTURES_DIR)
  .filter((n) => /^fixtures-[^/]+\.mjs$/.test(n) && n !== 'fixtures-helpers.mjs')
  .sort((a, b) => {
    const da = a.replace(/^fixtures-/, '').replace(/\.mjs$/, '')
    const db = b.replace(/^fixtures-/, '').replace(/\.mjs$/, '')
    const pa = PRIORITY_INDEX.has(da) ? PRIORITY_INDEX.get(da) : Number.MAX_SAFE_INTEGER
    const pb = PRIORITY_INDEX.has(db) ? PRIORITY_INDEX.get(db) : Number.MAX_SAFE_INTEGER
    return pa !== pb ? pa - pb : da.localeCompare(db)
  })

const DISCOVERED_SET = new Set(DISCOVERED_FILES)
const LOADED_DOMAIN_CACHE = new Map()
let cachedImportGraph = null

async function loadDomainFile(file) {
  if (LOADED_DOMAIN_CACHE.has(file)) return LOADED_DOMAIN_CACHE.get(file)
  const mod = await import(pathToFileURL(join(FIXTURES_DIR, file)).href)
  const regFn = Object.entries(mod).find(([k, v]) => typeof v === 'function' && /^register.*Cases$/.test(k))?.[1]
    ?? (typeof mod.default === 'function' ? mod.default : null)
  const entry = regFn ? [file.replace(/^fixtures-/, '').replace(/\.mjs$/, ''), regFn] : null
  LOADED_DOMAIN_CACHE.set(file, entry)
  return entry
}

async function loadDomainRegistry(files = DISCOVERED_FILES) {
  const registry = []
  for (const file of files) {
    const entry = await loadDomainFile(file)
    if (entry) registry.push(entry)
  }
  return registry
}

const LOCAL_FIXTURE_IMPORT_RE = /(?:\bfrom\s+|import\s*\(\s*)['"]\.\/(fixtures-[^'"/]+\.mjs)['"]/g

function getFixtureImportGraph() {
  if (cachedImportGraph) return cachedImportGraph
  const texts = new Map()
  const deps = new Map()
  const reverseDeps = new Map()
  for (const f of DISCOVERED_FILES) {
    deps.set(f, new Set())
    reverseDeps.set(f, new Set())
  }
  for (const f of DISCOVERED_FILES) {
    const txt = readFileSync(join(FIXTURES_DIR, f), 'utf8')
    texts.set(f, txt)
    for (const m of txt.matchAll(LOCAL_FIXTURE_IMPORT_RE)) {
      const target = m[1]
      if (!DISCOVERED_SET.has(target) || target === f) continue
      deps.get(f).add(target)
      reverseDeps.get(target).add(f)
    }
  }
  cachedImportGraph = { texts, deps, reverseDeps }
  return cachedImportGraph
}

/**
 * 为 `--only <keyword>` 预筛候选文件并求静态 `import` 双向闭包：
 * - 命中文件导入的兄弟文件纳入闭包；
 * - 被命中辅助文件反向扩展到导入它的全部注册文件，避免跨文件共享构造漏检。
 */
export function resolveOnlyCandidateFiles(keyword) {
  const needle = String(keyword ?? '').toLowerCase()
  if (!needle) return { files: [...DISCOVERED_FILES], totalFiles: DISCOVERED_FILES.length }
  const { texts, deps, reverseDeps } = getFixtureImportGraph()
  const visited = new Set()
  const queue = []
  for (const f of DISCOVERED_FILES) {
    if (f.toLowerCase().includes(needle) || (texts.get(f) ?? '').toLowerCase().includes(needle)) {
      visited.add(f)
      queue.push(f)
    }
  }
  while (queue.length > 0) {
    const cur = queue.pop()
    for (const next of [...(deps.get(cur) ?? []), ...(reverseDeps.get(cur) ?? [])]) {
      if (!visited.has(next)) {
        visited.add(next)
        queue.push(next)
      }
    }
  }
  return {
    files: DISCOVERED_FILES.filter((f) => visited.has(f)),
    totalFiles: DISCOVERED_FILES.length,
  }
}

function parseCliFlags(argv) {
  let prefer = ''
  let bailOn = ''
  let only = ''
  let domain = ''
  let shard = ''
  let worker = false
  let jobsArg
  let profile = false
  let noLazy = false
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
    if (arg === '--no-lazy') { noLazy = true; continue }
    if (arg === '--jobs' && i + 1 < argv.length) { jobsArg = Number(argv[++i]); continue }
    if (arg.startsWith('--jobs=')) { jobsArg = Number(arg.slice('--jobs='.length)); continue }
  }
  return { prefer, bailOn, only, domain, shard, worker, profile, noLazy, jobsArg }
}

/** 用例命中的判据：标题或函数体里出现关键字即算命中。 */
function caseMatches(fn, keyword) {
  return fn[0].includes(keyword) || fn[1].toString().includes(keyword)
}

/** 按 `--only` 筛选用例；零命中时报错返回 `null`，避免与全绿混淆。 */
function selectOnlyCases(cases, only) {
  if (!only) return cases
  const matched = cases.filter((fn) => caseMatches(fn, only))
  if (matched.length === 0) {
    process.stderr.write(`没有用例匹配 --only ${only}：关键字写错时会一条都不跑，而「没跑」看着和「全过」一样。\n`)
    return null
  }
  return matched
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

// 看门狗底限：一条用例在九路并行、CI 口径下跑完要多久。低风险用例大多几秒，
// 真正需要放宽的是少数跑完整套件矩阵的长用例——它们用第三段声明自己的成本，
// 看门狗按声明放宽；这里给的是没声明时的底限，要能容下一次完整 gate 的量级。
const WORKER_TASK_TIMEOUT_MS = 180000
const WORKER_MSG_PREFIX = '__PF_W__:'

function runDynamicWorkerPool(scriptPath, dispatchOrder, lanes, runnerTempRoot, caseNames = [], caseCosts = [], workerExtraArgs = []) {
  return new Promise((done) => {
    const workerBkRoot = join(runnerTempRoot, 'bk')
    const workerTmpRoot = join(runnerTempRoot, 'tmp')
    mkdirSync(workerBkRoot, { recursive: true })
    mkdirSync(workerTmpRoot, { recursive: true })
    let cursor = 0
    let passed = 0
    const failures = []
    const timings = []
    let activeWorkers = lanes
    const activeChildren = new Set()

    const cleanupWorkers = (sig) => {
      for (const ch of activeChildren) killProcessTree(ch, false)
      try { rmSync(runnerTempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ }
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
      const workerTempDir = join(workerTmpRoot, tag)
      mkdirSync(workerTempDir, { recursive: true })
      const child = spawn(process.execPath, [scriptPath, '--worker', ...workerExtraArgs], {
        env: {
          ...process.env,
          PF_NO_REAL_AUTH_PROBE: process.env.PF_NO_REAL_AUTH_PROBE || '1',
          PF_BACKUP_DIR: join(workerBkRoot, tag),
          PF_FIXTURE_WORKER: '1',
          PF_TRACE_FILE: traceFile,
          TMPDIR: workerTempDir,
          TEMP: workerTempDir,
          TMP: workerTempDir,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      if (child.pid) applyLowPriority(child.pid)
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
        // 声明了成本就按它放宽（留一倍余量应对并行抢占），没声明就用默认值。
        // 两处共用同一个数字：调度拿它排先后，看门狗拿它定时限。
        const declared = Number(caseCosts[idx]) > 0 ? Number(caseCosts[idx]) : 0
        const budget = Math.max(WORKER_TASK_TIMEOUT_MS, declared * 2)
        taskTimer = setTimeout(() => {
          const name = caseNames[idx] ?? 'unknown'
          timedOutMsg = `工作进程 ${tag} 在用例 #${idx}（${name}）执行超时 (>${budget}ms${readTraceSummary()})`
          killProcessTree(child, false)
          closeFallback = setTimeout(() => finishWorker(124), 3000)
          closeFallback.unref?.()
        }, budget)
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

async function loadDomainEntry(domain, noLazy = false) {
  const directFile = `fixtures-${domain}.mjs`
  if (!noLazy && DISCOVERED_SET.has(directFile)) {
    const direct = await loadDomainFile(directFile)
    if (direct) {
      const probeCases = []
      direct[1](probeCases)
      if (probeCases.length > 0) return { found: direct, domainCases: probeCases, registry: null }
    }
  }
  const fullRegistry = await loadDomainRegistry(DISCOVERED_FILES)
  const found = fullRegistry.find(([name]) => name === domain)
  if (!found) return { found: null, domainCases: [], registry: fullRegistry }
  const domainCases = []
  found[1](domainCases)
  return { found, domainCases, registry: fullRegistry }
}

async function main() {
  const { prefer, bailOn, only, domain, shard, worker, profile, noLazy, jobsArg } = parseCliFlags(process.argv.slice(2))

  if (worker) {
    applyLowPriority(process.pid)
    const allCases = []
    if (domain) {
      const { domainCases } = await loadDomainEntry(domain, noLazy)
      allCases.push(...domainCases)
    } else {
      const fullRegistry = await loadDomainRegistry(DISCOVERED_FILES)
      for (const [, registerFn] of fullRegistry) registerFn(allCases)
    }
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
    const { found, domainCases, registry } = await loadDomainEntry(domain, noLazy)
    if (!found) {
      const avail = (registry ?? await loadDomainRegistry(DISCOVERED_FILES)).map(([n]) => n).join(', ')
      process.stderr.write(`未知测试域：${domain}（可用：${avail}）\n`)
      return 2
    }
    const filtered = selectOnlyCases(domainCases, only)
    if (!filtered) return 1
    const hasExplicitJobs = Number.isFinite(jobsArg) && jobsArg >= 1
    const domainLanes = hasExplicitJobs
      ? Math.min(resolveWorkerConcurrency({ requestedJobs: jobsArg, cap: filtered.length }), filtered.length)
      : 1
    if (domainLanes > 1 && !only && !bailOn && process.env.PF_FIXTURE_WORKER !== '1') {
      const scriptPath = fileURLToPath(import.meta.url)
      const workerBkRoot = mkdtempSync(join(tmpdir(), 'pf-fix-pool-'))
      try {
        const dispatchOrder = buildDispatchOrder(domainCases)
        const { passed: totalPassed, failures: allFailures } = await runDynamicWorkerPool(
          scriptPath,
          dispatchOrder,
          domainLanes,
          workerBkRoot,
          domainCases.map(([name]) => name),
          domainCases.map(([, , costMs]) => (Number(costMs) > 0 ? Number(costMs) : 0)),
          ['--domain', domain, ...(noLazy ? ['--no-lazy'] : [])],
        )
        if (allFailures.length === 0) {
          process.stdout.write(`行为断言：${totalPassed} 项通过，0 项失败（--domain ${domain}, ${domainLanes} 隔离子进程动态并发）。\n`)
          return 0
        }
        for (const f of allFailures) process.stderr.write(`FAIL  ${f}\n`)
        process.stderr.write(`\n行为断言：${totalPassed} 通过 / ${allFailures.length} 失败（--domain ${domain}）。\n`)
        return 1
      } finally {
        try { rmSync(workerBkRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) } catch { /* ignore */ }
      }
    }
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
    const fullRegistry = await loadDomainRegistry(DISCOVERED_FILES)
    const allCases = []
    for (const [, registerFn] of fullRegistry) registerFn(allCases)
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

  // 全量跑且未传 --only / --bail-on 时，按 proc-budget 留出前台余量派生低优先级隔离子进程池
  const isMacLegacyNode = process.platform === 'darwin' && !supportsSafeDetachedSpawn()
  const hasExplicitJobs = Number.isFinite(jobsArg) && jobsArg >= 1
  const defaultCap = isMacLegacyNode ? 2 : 8
  const lanes = only || bailOn
    ? 1
    : resolveWorkerConcurrency({
        requestedJobs: hasExplicitJobs ? jobsArg : null,
        cap: hasExplicitJobs ? Infinity : defaultCap,
      })

  if (lanes > 1 && !only && !bailOn) {
    const fullRegistry = await loadDomainRegistry(DISCOVERED_FILES)
    const allCases = []
    for (const [, registerFn] of fullRegistry) registerFn(allCases)
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
        allCases.map(([, , costMs]) => (Number(costMs) > 0 ? Number(costMs) : 0)),
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
      try { rmSync(workerBkRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }) } catch { /* ignore */ }
    }
  }

  let selected
  if (only && !noLazy) {
    const pre = resolveOnlyCandidateFiles(only)
    const partialRegistry = pre.files.length > 0 ? await loadDomainRegistry(pre.files) : []
    const partialCases = []
    for (const [, registerFn] of partialRegistry) registerFn(partialCases)
    const partialMatched = partialCases.filter((fn) => caseMatches(fn, only))
    if (partialMatched.length > 0) {
      selected = partialMatched
    } else if (pre.files.length < DISCOVERED_FILES.length) {
      const fullRegistry = await loadDomainRegistry(DISCOVERED_FILES)
      const fullCases = []
      for (const [, registerFn] of fullRegistry) registerFn(fullCases)
      selected = selectOnlyCases(fullCases, only)
    } else {
      selected = selectOnlyCases(partialCases, only)
    }
  } else {
    const fullRegistry = await loadDomainRegistry(DISCOVERED_FILES)
    const cases = []
    for (const [, registerFn] of fullRegistry) registerFn(cases)
    selected = selectOnlyCases(cases, only)
  }
  if (!selected) return 1
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

if (isMainModule(import.meta.url, process.argv[1])) {
  main().then((code) => flushAndExit(code))
}
