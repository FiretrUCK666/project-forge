#!/usr/bin/env node
/**
 * 故障注入复验：逐个把关键判据拆掉，确认对应的断言真的变红。
 *
 * 这不是测试的一部分，是**证明测试不是空的**。测试全绿有两种可能——代码对了，或者
 * 测试什么都没测；只有亲眼看到它红过，才排除后一种。
 *
 * 用法：node scripts/dev/verify-injections.mjs [--only I12] [--jobs 6]
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { killProcessTree, supportsSafeDetachedSpawn } from '../../kit/skills/lib/exec.mjs'
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
    const useDetached = supportsSafeDetachedSpawn()
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: useDetached,
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
      killProcessTree(child, useDetached)
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
  if (expect) args.push('--only', expect, '--bail-on', expect)
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
async function runBothIn(root, injOrExpect, injId = '') {
  const inj = typeof injOrExpect === 'object' && injOrExpect !== null
    ? injOrExpect
    : { expect: injOrExpect, id: injId }
  const expect = inj.expect
  const id = inj.id || injId
  if (!expect) {
    const pre = await runPreflightIn(root, id)
    if (pre.timedOut) return pre
    const fix = await runFixturesIn(root, '', id)
    if (fix.timedOut) return fix
    return { failed: [...pre.failed, ...fix.failed] }
  }
  if (inj.runner === 'preflight') {
    const pre = await runPreflightIn(root, id)
    if (pre.timedOut || pre.failed.some((line) => line.includes(expect))) return pre
    const fix = await runFixturesIn(root, expect, id)
    if (fix.timedOut) return fix
    return { failed: [...pre.failed, ...fix.failed] }
  }
  const fix = await runFixturesIn(root, expect, id)
  if (fix.timedOut) return fix
  if (fix.failed.some((line) => line.includes(expect))) return fix
  const pre = await runPreflightIn(root, id)
  if (pre.timedOut) return pre
  if (pre.failed.some((line) => line.includes(expect))) return pre
  return { failed: [...pre.failed, ...fix.failed] }
}

/**
 * 在复用的 worker 干净基线副本上精确修改目标文件并运行对应门禁，结束后仅还原被修改文件，
 * 避免每条注入都整树重拷上百遍。
 */
async function runInjectionInSlot(inj, root) {
  const modifiedRels = []
  try {
    const targets = [[inj.file, inj.from, inj.to]]
    for (const other of inj.alsoDropIn ?? []) targets.push([other, inj.from, inj.to])
    for (const patch of inj.alsoPatches ?? []) targets.push([patch.file, patch.from, patch.to])

    for (const [rel, from, to] of targets) {
      const full = join(root, rel)
      const original = readFileSync(full, 'utf8')
      // 锚点按 LF 写，工作区可能是 CRLF：本地检出若没按 `.gitattributes` 规范化，
      // 注入就会「找不到那一段」而整条跳过——跳过在汇总里只记一处问题，
      // 看起来像配置疏漏，实际是这条判据根本没被验过。这里统一到 LF 再比。
      const lfOriginal = original.replace(/\r\n/g, '\n')
      const lfFrom = String(from).replace(/\r\n/g, '\n')
      if (!lfOriginal.includes(lfFrom)) {
        return { id: inj.id, what: inj.what, skipped: `${rel} 里找不到要替换的那一段` }
      }
      if (!modifiedRels.includes(rel)) modifiedRels.push(rel)
      const replaced = lfOriginal.replace(lfFrom, String(to).replace(/\r\n/g, '\n'))
      writeFileSync(full, original.includes('\r\n') ? replaced.replace(/\n/g, '\r\n') : replaced, 'utf8')
    }

    let result = await runBothIn(root, inj)
    if (result.timedOut) {
      // 仅对偶发进程超时重跑一次以抗 CI 调度抖动；判据未捕获（hit=false）绝不重试
      result = await runBothIn(root, inj)
    }
    if (result.timedOut) {
      return { id: inj.id, what: inj.what, skipped: `执行超时 (>${INJ_STEP_TIMEOUT_MS}ms): ${result.timedOutStep}` }
    }
    const sample = result.failed.find((line) => line.includes(inj.expect))
    return { id: inj.id, what: inj.what, hit: Boolean(sample), sample }
  } finally {
    for (const rel of modifiedRels) {
      const src = join(STAGING, rel)
      const dst = join(root, rel)
      if (existsSync(src)) {
        mkdirSync(dirname(dst), { recursive: true })
        copyFileSync(src, dst)
      }
    }
  }
}

/** 有限并发槽位池：仅预建 `lanes` 份隔离副本，槽位内按脏文件差异刷新与精准还原。 */
async function runWithSlotPool(items, limit) {
  const results = new Array(items.length)
  const laneCount = Math.min(limit, items.length)
  let cursor = 0
  const lanes = Array.from({ length: laneCount }, async (_, laneIdx) => {
    const slotRoot = cloneTree(STAGING, join(SANDBOX, `slot-${laneIdx}`))
    try {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await runInjectionInSlot(items[index], slotRoot)
      }
    } finally {
      removeTree(slotRoot)
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

  // 数组里出现空洞时（比如某处多打了一个逗号 `},,`），后面的 `inj.id` 会崩在
  // `Cannot read properties of undefined`——那条报错指向不了真正的问题。
  // 空洞就是登记表坏了，直接在这里说清楚。
  const holes = []
  for (let i = 0; i < INJECTIONS.length; i += 1) if (!(i in INJECTIONS)) holes.push(i)
  if (holes.length > 0) {
    process.stderr.write(`注入表有 ${holes.length} 处空洞（位置 ${holes.join(', ')}）——多半是某处多了一个逗号。\n`)
    await flushAndExit(1)
  }

  const selected = argvOnly ? INJECTIONS.filter((i) => i.id === argvOnly) : INJECTIONS
  if (argvOnly && selected.length === 0) {
    process.stderr.write(`没有注入匹配 --only ${argvOnly}：编号写错时会一条都不跑，而「没跑」看着和「全过」一样。\n`)
    await flushAndExit(1)
  }

  const results = await runWithSlotPool(selected, jobs)

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
