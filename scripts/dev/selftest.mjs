#!/usr/bin/env node
/**
 * 行为自检入口：并行跑 cases-0..3，合并结果。
 *
 * 分片是为了用满机器：五十八组各自建 fixture、各跑几十次子进程，组与组之间没有共享
 * 可变状态。串行时它们排在一条时间线上只用到一个核，按行数均衡切成四片就同时用四个。
 *
 * 每一组的判据都还在原处，一条没减——改变的只是排队方式。
 *
 * 分片的正确性由**断言总数**守住：任一片没输出计数行，入口就以退出码 2 中止，而不是
 * 把它当 0 项通过。少了却显示全绿，比红了更危险。
 */

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { existsSync, readdirSync, rmSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 分片数。加一个 cases-N.mjs 就相应加一项，下面的自检会核对文件存在。 */
const SHARDS = ['cases-0.mjs', 'cases-1.mjs', 'cases-2.mjs', 'cases-3.mjs', 'cases-4.mjs']

/** 每个进程一个独立的 fixture 根：并行时绝不能共用目录。 */
const RUN_ROOT = join(tmpdir(), `project-forge-selftest-${process.pid}-${randomBytes(3).toString('hex')}`)

/** 从一片的输出里读出它观测到的 kind。 */
function parseKinds(out) {
  const m = /^OBSERVED_KINDS=(.*)$/m.exec(out)
  if (m === null) return []
  return m[1].split(',').map((s) => s.trim()).filter(Boolean)
}

/** 从一片的输出里读出计数行。格式由 harness 的 summarize 决定。 */
function parseCounts(text) {
  const m = /行为自检：?(\d+) 项通过，(\d+) 项失败/.exec(text)
  if (m === null) return undefined
  return { passed: Number(m[1]), failed: Number(m[2]) }
}

function runShard(name) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [join(HERE, name)], {
      env: { ...process.env, PF_FIXTURE_ROOT: join(RUN_ROOT, name.replace(/\.mjs$/, '')) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', (code) => resolvePromise({ name, code, out }))
  })
}

const missing = SHARDS.filter((n) => !existsSync(join(HERE, n)))
if (missing.length > 0) {
  process.stderr.write(`错误：缺少分片文件 ${missing.join('、')}。\n`)
  process.exit(2)
}

const started = Date.now()
const results = await Promise.all(SHARDS.map(runShard))
const elapsed = Date.now() - started

let passed = 0
let failed = 0
const allKinds = new Set()
const failures = []
const shardLines = []

for (const r of results) {
  const counts = parseCounts(r.out)
  if (counts === undefined) {
    // **读不到计数就是失败**，不是「0 项通过」。一片崩了却按 0 计，整套自检会
    // 显示「少了几项但全过」——那比红着更危险。
    process.stderr.write(`\n错误：分片 ${r.name} 没有输出计数行（退出码 ${r.code}）。\n`)
    process.stderr.write(`${r.out.split('\n').slice(-25).join('\n')}\n`)
    process.exit(2)
  }
  passed += counts.passed
  failed += counts.failed
  shardLines.push(`  ${r.name.padEnd(14)} ${String(counts.passed).padStart(4)} 通过  ${counts.failed} 失败`)

  // 收集分片观测到的 kind（去重后合并）
  for (const k of parseKinds(r.out)) allKinds.add(k)

  // 收集分片报出的失败项
  const failBlock = /失败项：\n([\s\S]*?)(?:\n\n|$)/.exec(r.out)
  if (failBlock !== null) {
    for (const line of failBlock[1].split('\n')) {
      if (line.trim().startsWith('- ')) failures.push(line.trim().slice(2))
    }
  }
}

// 清理本次的 fixture 根（各分片自己也清，这里是兜底）
try { if (existsSync(RUN_ROOT)) rmSync(RUN_ROOT, { recursive: true, force: true }) } catch { /* 清不掉不算错 */ }

// ── 值域判定（要看四片合并后的全集，所以只能在主入口做）──────────────────
//
// 这一条守的是「勘察吐出的 kind 必须都在 kindVocabulary() 里」。放在分片里做不到：
// 每片只看到自己那几组，观测太少时门槛够不着、门槛调低又恒真，两种都是假判定。
// 搬到主入口后判据反而更强——它看到的是全集。
try {
  const { kindVocabulary } = await import('../survey.mjs')
  const vocab = kindVocabulary()
  const outside = [...allKinds].filter((k) => !vocab.includes(k)).sort()

  const enough = allKinds.size >= 5
  passed += 1
  if (!enough) { failed += 1; failures.push(`值域前提：只观测到 ${allKinds.size} 个 kind（少于 5 个，判定没有意义）`) }
  if (outside.length > 0) {
    failed += 1
    failures.push(`词表外的 kind：${outside.join('、')} —— 勘察吐出了 kindVocabulary() 里没有的值`)
  }

  const neverSeen = vocab.filter((k) => !allKinds.has(k))
  if (neverSeen.length > 0) {
    process.stdout.write(`\n（值域里有 ${neverSeen.length} 个 kind 还没有 fixture 覆盖：${neverSeen.join('、')}）\n`)
  }
} catch (error) {
  // 词表本身读不到是硬错误：那说明 survey.mjs 的导出变了，判定无从谈起。
  failed += 1
  failures.push(`值域判定没能进行：${error.message}`)
}

process.stdout.write(`\n分片（每片一个进程，并行跑）：\n${shardLines.join('\n')}\n`)
process.stdout.write(`\n行为自检：${passed} 项通过，${failed} 项失败（并行 ${SHARDS.length} 片，${(elapsed / 1000).toFixed(1)} 秒）\n`)

if (failures.length > 0) {
  process.stdout.write('\n失败项：\n')
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
}

process.exitCode = failed === 0 ? 0 : 1