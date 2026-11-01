#!/usr/bin/env node
/**
 * bench.mjs —— 量出关键命令的耗时，用来判断「改这次有没有变慢」。
 *
 * 判据只有一条：**同一个命令，改前改后各跑一遍，数字要能比。**
 * 靠回忆「感觉快了」没有意义——本仓库的慢主要来自重复劳动（同一次调用里把
 * 全盘勘察跑好几遍），那种慢在单次手跑里看不出来，只有并排比才显形。
 *
 * 用法：
 *   node scripts/dev/bench.mjs            # 量本仓库自身
 *   node scripts/dev/bench.mjs <目录>      # 量指定目录
 *   node scripts/dev/bench.mjs --json     # 机器可读
 *
 * 只读：被测命令全部是只读或 --check 模式，本脚本不写任何文件。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..', '..')

/** 重复次数取中位数：单次测量受磁盘缓存影响，第一次最不可信。 */
const ROUNDS = 3

/**
 * 被测命令表。`argv` 里的 `<T>` 会被替换成目标目录。
 *
 * 每一项都要是**只读或 --check**：bench 会被反复跑，它自己不能改文件。
 */
const CASES = [
  { id: 'survey', title: '勘察（JSON）', argv: ['scripts/survey.mjs', '<T>'] },
  { id: 'survey-fast', title: '勘察（--fast）', argv: ['scripts/survey.mjs', '<T>', '--fast'], },
  { id: 'survey-md', title: '勘察（--markdown）', argv: ['scripts/survey.mjs', '<T>', '--markdown'] },
  { id: 'compose-check', title: '注入校验', argv: ['scripts/compose-agents.mjs', '<T>', '--check'] },
  { id: 'compose-status', title: '注入现状', argv: ['scripts/compose-agents.mjs', '<T>', '--status'] },
  { id: 'review', title: '交付门禁', argv: ['scripts/review.mjs', '<T>'] },
  { id: 'handoff-verify', title: '交棒复验', argv: ['scripts/handoff.mjs', '<T>', '--verify'] },
]

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

function timeOnce(argv, cwd) {
  const t0 = process.hrtime.bigint()
  const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', windowsHide: true })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { ms, status: r.status }
}

function main(argv) {
  const asJson = argv.includes('--json')
  const positional = argv.filter((a) => !a.startsWith('--'))
  const target = resolve(positional[0] ?? SKILL_ROOT)
  if (!existsSync(target)) {
    process.stderr.write(`目录不存在：${target}\n`)
    return 2
  }

  const rows = []
  for (const c of CASES) {
    const cmd = c.argv.map((a) => (a === '<T>' ? target : a))
    // 可选命令：不支持就跳过，不报错——bench 不该因为脚本还没这个开关而红。
    const probe = timeOnce(cmd, SKILL_ROOT)
    if (c.optional === true && probe.status !== 0) {
      rows.push({ id: c.id, title: c.title, skipped: true })
      continue
    }
    const samples = [probe.ms]
    for (let i = 1; i < ROUNDS; i += 1) samples.push(timeOnce(cmd, SKILL_ROOT).ms)
    rows.push({ id: c.id, title: c.title, ms: median(samples), status: probe.status })
  }

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ target, rounds: ROUNDS, rows }, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`基准：${target}\n取 ${ROUNDS} 次的中位数\n\n`)
  const width = Math.max(...rows.map((r) => r.title.length))
  for (const r of rows) {
    if (r.skipped === true) {
      process.stdout.write(`  ${r.title.padEnd(width)}  （不支持，跳过）\n`)
      continue
    }
    const flag = r.status === 0 ? '' : `  [退出码 ${r.status}]`
    process.stdout.write(`  ${r.title.padEnd(width)}  ${r.ms.toFixed(0).padStart(6)} ms${flag}\n`)
  }
  process.stdout.write(`\n合计 ${rows.filter((r) => r.skipped !== true).reduce((a, r) => a + r.ms, 0).toFixed(0)} ms\n`)
  return 0
}

process.exitCode = main(process.argv.slice(2))
