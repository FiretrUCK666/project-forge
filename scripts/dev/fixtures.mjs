#!/usr/bin/env node
/**
 * fixtures.mjs —— 行为断言调度入口：默认按测试域派生隔离子进程并发实跑，支持 `--domain` / `--only` / `--jobs`。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { initTestBackupDir } from './fixtures-helpers.mjs'
import { registerCoreCases } from './fixtures-core.mjs'
import { registerSurveyCases } from './fixtures-survey.mjs'
import { registerContractCases } from './fixtures-contracts.mjs'
import { registerReviewCases } from './fixtures-review.mjs'
import { registerClaimsCases } from './fixtures-claims.mjs'
import { registerExploreCases } from './fixtures-explore.mjs'
import { registerDocsCases } from './fixtures-docs.mjs'
import { registerFlowCases } from './fixtures-flow.mjs'
import { registerM2Cases } from './fixtures-m2.mjs'
import { registerM3Cases } from './fixtures-m3.mjs'
import { registerGovernCases } from './fixtures-govern.mjs'
import { registerEquipCases } from './fixtures-equip.mjs'
import { registerPlatformCases } from './fixtures-platform.mjs'

initTestBackupDir()

const DOMAIN_REGISTRY = [
  ['flow', registerFlowCases],
  ['m2', registerM2Cases],
  ['m3', registerM3Cases],
  ['govern', registerGovernCases],
  ['claims', registerClaimsCases],
  ['equip', registerEquipCases],
  ['docs', registerDocsCases],
  ['platform', registerPlatformCases],
  ['explore', registerExploreCases],
  ['contracts', registerContractCases],
  ['core', registerCoreCases],
  ['review', registerReviewCases],
  ['survey', registerSurveyCases],
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

async function runCase([name, fn]) {
  const t0 = performance.now()
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

const HEAVY_CASE_HINTS = [
  'Tier 2 review 槽同步',
  'M2 C3',
  'flow.mjs：smoke',
  'M3-C2',
  '全链路 URL',
  'M3-C1b',
  'govern-audit.mjs：fence-aware',
  'M2 C4+C5',
  'govern-audit.mjs release-prep',
  'M2 C1b',
  'flow.mjs + doc-plan.mjs',
  'M3-C1a',
  '远端 CI 合并硬门禁',
  'equip.mjs + survey.mjs',
  'M2 C2',
  'review-pack.mjs + govern-audit.mjs',
  '无远端探测',
  '测试分层控频',
  '8 层深',
  '统一 YAML',
  'survey.mjs + compose-agents.mjs',
  'M2 C1c',
  '耦合文件自同步',
  'M3-C5',
]

function buildDispatchOrder(allCases) {
  const rank = (name) => {
    const idx = HEAVY_CASE_HINTS.findIndex((h) => name.includes(h))
    return idx === -1 ? HEAVY_CASE_HINTS.length : idx
  }
  return allCases
    .map(([name], index) => ({ index, priority: rank(name) }))
    .sort((a, b) => (a.priority - b.priority) || (a.index - b.index))
    .map((x) => x.index)
}

function runDynamicWorkerPool(scriptPath, dispatchOrder, lanes, workerBkRoot) {
  return new Promise((done) => {
    let cursor = 0
    let passed = 0
    const failures = []
    const timings = []
    let activeWorkers = lanes

    const onWorkerFinished = () => {
      activeWorkers -= 1
      if (activeWorkers === 0) done({ passed, failures, timings })
    }

    for (let i = 0; i < lanes; i += 1) {
      const tag = `w-${i}`
      const child = spawn(process.execPath, [scriptPath, '--worker'], {
        env: {
          ...process.env,
          PF_NO_REAL_AUTH_PROBE: process.env.PF_NO_REAL_AUTH_PROBE || '1',
          PF_BACKUP_DIR: join(workerBkRoot, tag),
          PF_FIXTURE_WORKER: '1',
        },
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        windowsHide: true,
      })
      let errBuf = ''
      let currentIdx = null
      let finalized = false
      child.stderr?.on('data', (c) => { errBuf += c })

      const dispatchNext = () => {
        if (cursor < dispatchOrder.length) {
          currentIdx = dispatchOrder[cursor++]
          child.send({ type: 'run', index: currentIdx })
        } else {
          currentIdx = null
          child.send({ type: 'stop' })
        }
      }

      child.on('message', (msg) => {
        if (!msg) return
        if (msg.type === 'ready') {
          dispatchNext()
        } else if (msg.type === 'done') {
          currentIdx = null
          if (Number.isFinite(msg.ms)) timings.push({ index: msg.index, name: msg.name, ms: msg.ms, worker: tag })
          if (msg.ok) passed += 1
          else failures.push(msg.entry)
          dispatchNext()
        }
      })

      child.on('close', (code) => {
        if (finalized) return
        finalized = true
        if (currentIdx !== null) {
          failures.push(`工作进程 ${tag} 在用例 #${currentIdx} 异常退出 (${code})：${errBuf.trim()}`)
        }
        onWorkerFinished()
      })

      child.on('error', (error) => {
        if (finalized) return
        finalized = true
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
    process.on('message', async (msg) => {
      if (!msg || msg.type === 'stop') { process.exit(0); return }
      if (msg.type === 'run') {
        const entry = allCases[msg.index]
        const res = entry ? await runCase(entry) : { ok: false, entry: `缺失用例索引 ${msg.index}` }
        process.send?.({ type: 'done', index: msg.index, ...res })
      }
    })
    process.send?.({ type: 'ready' })
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

  // 全量跑且未传 --only / --bail-on 时，默认按动态工作窃取队列派生隔离子进程池（避免长尾倾斜与 Windows 进程风暴）
  const defaultJobs = only || bailOn ? 1 : Math.min(8, Math.max(2, cpus().length))
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

main().then((code) => process.exit(code))
