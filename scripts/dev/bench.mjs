#!/usr/bin/env node
/**
 * bench.mjs —— 勘察的耗时预算。
 *
 * 为什么值得一个单独的脚本：勘察会被**反复调用**（每次任务开头一次，可能一小时内好几次）。
 * 它一旦退化成「随文件数线性增长」，用起来就从「随手可跑」变成「等一下」，而那种退化
 * 不会报错，只会让人不再用它。
 *
 * 基准 fixture 造 300 个文件——大约是真实项目的中位数规模。判据是**秒级以内**，
 * 而不是与上一次比快慢：绝对阈值能抓住「一次改动把批量查询改成逐文件查询」这类结构性退化，
 * 相对比较抓不住（它只会说「更慢了 5 倍」，而 5 倍可能还是可接受的）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SURVEY = resolve(HERE, '..', 'survey.mjs')
const BUDGET_MS = 3000
const ROUNDS = 3

function buildFixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-bench-'))
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'README.md'), '# bench\n\nA fixture for timing the survey.\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"bench","version":"1.0.0","private":true}')
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  for (let i = 0; i < files; i += 1) {
    const sub = join(dir, `src${i % 4}`)
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, `f${i}.js`), `export const a${i} = ${i}\n`)
  }
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init'], { cwd: dir, stdio: 'ignore' })
  return dir
}

function timeOnce(dir) {
  const started = process.hrtime.bigint()
  const res = spawnSync(process.execPath, [SURVEY, dir], { encoding: 'utf8', timeout: 120000 })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return { ms, ok: res.status === 0, stderr: res.stderr }
}

function main() {
  const dir = buildFixture(300)
  try {
    // 第一趟可能撞上冷缓存，只报不判。
    const warm = timeOnce(dir)
    process.stdout.write(`  预热：${Math.round(warm.ms)} ms\n`)
    if (!warm.ok) {
      process.stderr.write(`勘察跑不通：${(warm.stderr || '').trim().split('\n')[0]}\n`)
      return 1
    }

    const samples = []
    for (let i = 0; i < ROUNDS; i += 1) {
      const run = timeOnce(dir)
      samples.push(run.ms)
      process.stdout.write(`  第 ${i + 1} 趟：${Math.round(run.ms)} ms\n`)
      if (!run.ok) {
        process.stderr.write(`勘察跑不通：${(run.stderr || '').trim().split('\n')[0]}\n`)
        return 1
      }
    }

    // 取中位数：单次测速容易被一台正在干别的机器带偏，取中位数比取最大值公平，
    // 又比取最小值更能暴露「偶尔退化」。
    const sorted = [...samples].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    if (median > BUDGET_MS) {
      process.stderr.write(`\n耗时超预算：300 个文件的仓库，勘察中位数 ${Math.round(median)} ms，预算 ${BUDGET_MS} ms。\n`)
      process.stderr.write('这条通常意味着版本控制查询被拆成了逐文件调用——检查 `check-ignore` 是不是按文件跑的。\n')
      return 1
    }
    process.stdout.write(`\n耗时预算通过：中位数 ${Math.round(median)} ms（预算 ${BUDGET_MS} ms，300 个文件）。\n`)
    return 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

process.exit(main())
