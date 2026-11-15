#!/usr/bin/env node
/**
 * bench.mjs —— 核心命令与 1,000 文件 `.zip` 快照性能预算验证台（C1 / C2 实测门禁）。
 *
 * 覆盖：
 *   1. 300 文件仓库 `survey.mjs` 耗时（预算 <= 3,000 ms）；
 *   2. 本仓热态 `flow inspect`、`survey`、`review`、`preflight` 3 轮中位数预算；
 *   3. 1,000 文件跨平台 `.zip` 快照创建预算（<= 250 ms）。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createBackup } from '../backup.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SURVEY = join(ROOT, 'scripts', 'survey.mjs')
const FLOW = join(ROOT, 'kit', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
const REVIEW = join(ROOT, 'scripts', 'review.mjs')
const PREFLIGHT = join(ROOT, 'scripts', 'dev', 'preflight.mjs')

const SURVEY_300_BUDGET_MS = 3000
const FLOW_INSPECT_BUDGET_MS = 300
const SURVEY_SELF_BUDGET_MS = 250
const REVIEW_SELF_BUDGET_MS = 450
const PREFLIGHT_BUDGET_MS = 2500
const BACKUP_1000_BUDGET_MS = 250
const ROUNDS = 3

function buildFixture(files, prefix = 'pf-bench-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(dir, 'README.md'), '# bench\n\nA fixture for timing.\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"bench","version":"1.0.0","private":true}')
  mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
  for (let i = 0; i < files; i += 1) {
    const sub = join(dir, `src${i % 8}`)
    if (i < 8) mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, `f${i}.js`), `export const a${i} = ${i}\n`)
  }
  return dir
}

function initGit(dir) {
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init'], { cwd: dir, stdio: 'ignore' })
}

function measureMedian(label, fn, rounds = ROUNDS) {
  const warmup = fn()
  if (!warmup.ok) {
    process.stderr.write(`${label} 预热失败：${(warmup.stderr || '').trim().split('\n')[0]}\n`)
    return null
  }
  const samples = []
  for (let i = 0; i < rounds; i += 1) {
    const r = fn()
    if (!r.ok) {
      process.stderr.write(`${label} 第 ${i + 1} 趟失败：${(r.stderr || '').trim().split('\n')[0]}\n`)
      return null
    }
    samples.push(r.ms)
  }
  const sorted = [...samples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  process.stdout.write(`  ${label}：预热 ${Math.round(warmup.ms)} ms | 3 轮 [${samples.map((s) => Math.round(s)).join(', ')}] ms | 中位数 ${Math.round(median)} ms\n`)
  return median
}

function execTimed(scriptPath, args, cwd = ROOT) {
  const t0 = process.hrtime.bigint()
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, PF_NO_REAL_AUTH_PROBE: '1' },
  })
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  return { ms, ok: res.status === 0, stderr: res.stderr }
}

function main() {
  const dir300 = buildFixture(300, 'pf-bench300-')
  initGit(dir300)
  const dir1000 = buildFixture(1000, 'pf-bench1k-')
  const bk1000 = mkdtempSync(join(tmpdir(), 'pf-bench1k-bk-'))

  try {
    const checks = [
      { label: 'survey(300 files)', budget: SURVEY_300_BUDGET_MS, fn: () => execTimed(SURVEY, [dir300], dir300) },
      { label: 'flow inspect(self)', budget: FLOW_INSPECT_BUDGET_MS, fn: () => execTimed(FLOW, ['inspect', '--json'], ROOT) },
      { label: 'survey(self)', budget: SURVEY_SELF_BUDGET_MS, fn: () => execTimed(SURVEY, [ROOT], ROOT) },
      { label: 'review(self)', budget: REVIEW_SELF_BUDGET_MS, fn: () => execTimed(REVIEW, [ROOT, '--json'], ROOT) },
      { label: 'preflight(self)', budget: PREFLIGHT_BUDGET_MS, fn: () => execTimed(PREFLIGHT, [], ROOT) },
      {
        label: 'backup.zip(1000 files)',
        budget: BACKUP_1000_BUDGET_MS,
        fn: () => {
          const t0 = process.hrtime.bigint()
          const r = createBackup(dir1000, { label: 'bench', force: true, env: { PF_BACKUP_DIR: bk1000 } })
          const ms = Number(process.hrtime.bigint() - t0) / 1e6
          return { ms, ok: Boolean(r.created && r.format === 'zip'), stderr: '' }
        },
      },
    ]

    let failed = 0
    for (const c of checks) {
      const median = measureMedian(c.label, c.fn)
      if (median === null || median > c.budget) {
        process.stderr.write(`FAIL  ${c.label} 耗时超预算：实测中位数 ${median === null ? 'ERROR' : `${Math.round(median)} ms`} > 预算 ${c.budget} ms\n`)
        failed += 1
      }
    }

    if (failed > 0) return 1
    process.stdout.write(`\n耗时预算全部通过（${checks.length}/${checks.length} 项在预算内）。\n`)
    return 0
  } finally {
    rmSync(dir300, { recursive: true, force: true })
    rmSync(dir1000, { recursive: true, force: true })
    rmSync(bk1000, { recursive: true, force: true })
  }
}

process.exit(main())
