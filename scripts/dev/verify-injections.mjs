#!/usr/bin/env node
/**
 * 故障注入复验：逐个把关键判据拆掉，确认对应的断言真的变红。
 *
 * 这不是测试的一部分，是**证明测试不是空的**。测试全绿有两种可能——代码对了，或者
 * 测试什么都没测；只有亲眼看到它红过，才排除后一种。
 *
 * 用法：node scripts/dev/verify-injections.mjs [--only I12] [--jobs 6]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { killProcessTree } from '../../kit/skills/lib/exec.mjs'
import { isMainModule } from '../lib/text.mjs'
import { INJECTIONS } from './injections-data.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const INJ_STEP_TIMEOUT_MS = 90000

/**
 * 复验必须在**独立副本**里做，而且每条注入各用一份。
 *
 * 所以：先把工作树复制一份当母版，每条注入从母版再复制一份自己的副本，各自并行。
 * 谁也不碰真正的工作区，谁也碰不到别人。
 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'pf-inj-'))
const STAGING = join(SANDBOX, 'base')

/** 复制时跳过的相对目录：`.git` 复验用不上，`node_modules` 与 `.worktrees` 是本地状态（基于相对路径校验以兼容在 worktree 内直接运行）。 */
const COPY_SKIP = /(?:^|[\\/])(?:\.git|node_modules|\.worktrees)(?:[\\/]|$)/

function cloneTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => src === from || !COPY_SKIP.test(relative(from, src)),
  })
  return to
}

function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch { /* 留给系统清理 */ }
}

/** 用 spawn + Promise 而不是 spawnSync：关闭 stdin、注入防外网探针并附带 90s 看门狗强杀树防止并发挂死。 */
function runNodeAsync(scriptPath, args, cwd, label = '') {
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
      env: { ...process.env, PF_NO_REAL_AUTH_PROBE: process.env.PF_NO_REAL_AUTH_PROBE || '1' },
    })
    let out = ''
    let err = ''
    let settled = false
    let timedOut = false
    let killFallback
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (killFallback) clearTimeout(killFallback)
      resolveDone({ out, err, timedOut, step: label })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child)
      killFallback = setTimeout(finish, 3000)
      killFallback.unref?.()
    }, INJ_STEP_TIMEOUT_MS)
    timer.unref?.()
    child.stdout?.on('data', (chunk) => { out += chunk })
    child.stderr?.on('data', (chunk) => { err += chunk })
    child.on('close', finish)
    child.on('error', (error) => { err += `\n${error.message}`; finish() })
  })
}

async function runFixturesIn(root, expect = '', injId = '') {
  const args = []
  if (expect) args.push('--only', expect)
  const { out, err, timedOut, step } = await runNodeAsync(
    join(root, 'scripts', 'dev', 'fixtures.mjs'),
    args,
    root,
    `${injId || 'inj'}:fixtures`,
  )
  const all = `${out}\n${err}`
  return {
    timedOut,
    timedOutStep: step,
    failed: all.split('\n').filter((l) => l.startsWith('FAIL')),
    summary: all.split('\n').filter((l) => /行为断言/.test(l)).join(' '),
  }
}

async function runPreflightIn(root, injId = '') {
  const { out, err, timedOut, step } = await runNodeAsync(
    join(root, 'scripts', 'dev', 'preflight.mjs'),
    [],
    root,
    `${injId || 'inj'}:preflight`,
  )
  return {
    timedOut,
    timedOutStep: step,
    failed: `${out}\n${err}`.split('\n').filter((l) => l.startsWith('FAIL')),
  }
}

/**
 * 两套门禁都问，但按代价排序。
 * 判据只有一条：拆掉一处之后，只要有任何一道门禁报出来，就算有人看着它。
 */
async function runBothIn(root, expect, injId = '') {
  if (!expect) {
    const pre = await runPreflightIn(root, injId)
    if (pre.timedOut) return pre
    const fix = await runFixturesIn(root, '', injId)
    if (fix.timedOut) return fix
    return { failed: [...pre.failed, ...fix.failed] }
  }
  const fix = await runFixturesIn(root, expect, injId)
  if (fix.timedOut) return fix
  if (fix.failed.some((line) => line.includes(expect))) return fix
  const pre = await runPreflightIn(root, injId)
  if (pre.timedOut) return pre
  if (pre.failed.some((line) => line.includes(expect))) return pre
  return { failed: [...pre.failed, ...fix.failed] }
}

/** 把一条注入施加到它自己的副本上，跑门禁，返回结论。副本用完即删。 */
async function runInjection(inj) {
  const root = cloneTree(STAGING, join(SANDBOX, `run-${inj.id}`))
  try {
    const targets = [[inj.file, inj.from, inj.to]]
    for (const other of inj.alsoDropIn ?? []) targets.push([other, inj.from, inj.to])
    for (const patch of inj.alsoPatches ?? []) targets.push([patch.file, patch.from, patch.to])

    for (const [rel, from, to] of targets) {
      const full = join(root, rel)
      const original = readFileSync(full, 'utf8')
      if (!original.includes(from)) {
        return { id: inj.id, what: inj.what, skipped: `${rel} 里找不到要替换的那一段` }
      }
      writeFileSync(full, original.replace(from, to), 'utf8')
    }

    const result = await runBothIn(root, inj.expect, inj.id)
    if (result.timedOut) {
      return { id: inj.id, what: inj.what, skipped: `执行超时 (>${INJ_STEP_TIMEOUT_MS}ms): ${result.timedOutStep}` }
    }
    const sample = result.failed.find((line) => line.includes(inj.expect))
    return { id: inj.id, what: inj.what, hit: Boolean(sample), sample }
  } finally {
    removeTree(root)
  }
}

/** 有限并发：每条注入要起几个 node 子进程，并发太高会把机器拖成彼此等 I/O。 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(lanes)
  return results
}

if (isMainModule(import.meta.url, process.argv[1])) {
  cloneTree(ROOT, STAGING)
  process.on('exit', () => removeTree(SANDBOX))

  const onlyIndex = process.argv.indexOf('--only')
  const argvOnly = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined
  const jobsIndex = process.argv.indexOf('--jobs')
  const requestedJobs = jobsIndex >= 0 ? Number(process.argv[jobsIndex + 1]) || 6 : 6
  const jobs = (process.platform === 'darwin' && process.env.CI)
    ? Math.min(requestedJobs, 2)
    : requestedJobs

  const selected = argvOnly ? INJECTIONS.filter((i) => i.id === argvOnly) : INJECTIONS
  if (argvOnly && selected.length === 0) {
    process.stderr.write(`没有注入匹配 --only ${argvOnly}：编号写错时会一条都不跑，而「没跑」看着和「全过」一样。\n`)
    await flushAndExit(1)
  }

  const results = await runWithConcurrency(selected, jobs, runInjection)

  let bad = 0
  for (const result of results) {
    if (result.skipped) {
      process.stdout.write(`${result.id} 跳过：${result.skipped}\n`)
      bad += 1
    } else if (result.hit) {
      process.stdout.write(`${result.id} 红了（正确）：${result.what}\n    ${result.sample.slice(0, 110)}\n`)
    } else {
      process.stdout.write(`${result.id} **没红**（判据被拆掉却没人报）：${result.what}\n`)
      bad += 1
    }
  }

  process.stdout.write(bad === 0
    ? `\n故障注入复验：${selected.length} 条判据都能被抓到。\n`
    : `\n故障注入复验未通过：${bad} 处有问题。\n`)
  await flushAndExit(bad === 0 ? 0 : 1)
}
