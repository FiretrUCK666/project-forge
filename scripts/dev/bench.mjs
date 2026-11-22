#!/usr/bin/env node
/**
 * bench.mjs —— 核心命令与 1,000 文件 `.zip` 快照性能预算验证台（C1 / C2 / C6 实测门禁）。
 *
 * 两种模式共用同一份单项表 `BENCH_CHECKS`，严禁按远端环境变量或外部倍率开关放大预算：
 *   - 默认模式（跨 OS / Node 矩阵通用）：先跑同轮真实子进程冷启 + 文件扫描校准负载得出 `unitMs`，
 *     每项阈值 = `min(hardCapMs, round(unitMs * unitMult))`；
 *   - `--strict-budget`（本机与严格门禁）：强制执行 `1x` 绝对毫秒上限 `strictBudget`。
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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

const ROUNDS = 3
const CALIBRATION_ROUNDS = 5

/**
 * 唯一性能预算常量表：每项显式声明 1x 绝对上限、相对校准单位的倍数（工作量之比）与硬件校准硬顶上限。
 * 不存在任何环境倍率分支。
 */
export const BENCH_CHECKS = [
  {
    label: 'survey(300 files)',
    strictBudget: 3000,
    // 300 文件临时仓库初始化扫描 + 1 次 git 状态检测，约合 35 倍单次探测工作量
    unitMult: 35,
    hardCapMs: 4500,
  },
  {
    label: 'flow inspect(self)',
    strictBudget: 300,
    // ESM 加载 + git 配置/状态/账本检查，约合 5 倍单次探测工作量
    unitMult: 5,
    hardCapMs: 700,
  },
  {
    label: 'survey(self)',
    strictBudget: 250,
    // 本仓完整只读勘察（生态 + 工具链 + git 状态/提交），约合 6 倍单次探测工作量
    unitMult: 6,
    hardCapMs: 750,
  },
  {
    label: 'review(self)',
    strictBudget: 450,
    // 本仓完整交付体检（含静态门禁与规则扫描），约合 7 倍单次探测工作量
    unitMult: 7,
    hardCapMs: 900,
  },
  {
    label: 'preflight(self)',
    strictBudget: 2500,
    // 全量自举与多路并发子进程语法/E2E 门禁，约合 55 倍单次探测工作量
    unitMult: 55,
    hardCapMs: 7000,
  },
  {
    label: 'backup.zip(1000 files)',
    strictBudget: 250,
    // 进程内 1,000 文件读取与 deflate 归档（约合 3.5 倍单次探测工作量）
    unitMult: 3.5,
    hardCapMs: 450,
  },
]

const CALIBRATION_CODE = [
  'import { readdirSync, readFileSync } from "node:fs"',
  'import { join } from "node:path"',
  'import { spawnSync } from "node:child_process"',
  'let lines = 0',
  'for (const dir of ["scripts/lib", "kit/skills/lib"]) {',
  '  for (const f of readdirSync(dir)) {',
  '    if (f.endsWith(".mjs")) lines += readFileSync(join(dir, f), "utf8").split("\\n").length',
  '  }',
  '}',
  'const c = spawnSync(process.execPath, ["--check", "scripts/survey.mjs"], { stdio: "pipe" })',
  'if (lines < 50 || c.status !== 0) process.exit(1)',
].join('; ')

/**
 * 纯预算推导函数：不读取任何环境变量，仅由 `strictBudget` 或同轮 `unitMs` 决定预算。
 * @param {{ strictBudget: number, unitMult: number, hardCapMs: number }} check
 * @param {{ unitMs: number, strictBudget?: boolean }} opts
 */
export function computeCheckBudget(check, { unitMs, strictBudget = false }) {
  if (strictBudget) return check.strictBudget
  return Math.min(check.hardCapMs, Math.max(1, Math.round(unitMs * check.unitMult)))
}

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

function measureCalibrationUnit() {
  return measureMedian('calibration(node+fs+check)', () => {
    const t0 = process.hrtime.bigint()
    const res = spawnSync(process.execPath, ['--input-type=module', '-e', CALIBRATION_CODE], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 30000,
    })
    const ms = Number(process.hrtime.bigint() - t0) / 1e6
    return { ms, ok: res.status === 0, stderr: res.stderr }
  }, CALIBRATION_ROUNDS)
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
  process.stdout.write(`  ${label}：预热 ${Math.round(warmup.ms)} ms | ${rounds} 轮 [${samples.map((s) => Math.round(s)).join(', ')}] ms | 中位数 ${Math.round(median)} ms\n`)
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
  const strictBudget = process.argv.includes('--strict-budget')
  const unitMs = measureCalibrationUnit()
  if (unitMs === null) {
    process.stderr.write('FAIL  同轮校准负载执行失败\n')
    return 1
  }

  const dir300 = buildFixture(300, 'pf-bench300-')
  initGit(dir300)
  const dir1000 = buildFixture(1000, 'pf-bench1k-')
  const bk1000 = mkdtempSync(join(tmpdir(), 'pf-bench1k-bk-'))

  try {
    const runners = {
      'survey(300 files)': () => execTimed(SURVEY, [dir300], dir300),
      'flow inspect(self)': () => execTimed(FLOW, ['inspect', '--json'], ROOT),
      'survey(self)': () => execTimed(SURVEY, [ROOT], ROOT),
      'review(self)': () => execTimed(REVIEW, [ROOT, '--json'], ROOT),
      'preflight(self)': () => execTimed(PREFLIGHT, [], ROOT),
      'backup.zip(1000 files)': () => {
        const t0 = process.hrtime.bigint()
        const r = createBackup(dir1000, { label: 'bench', force: true, env: { PF_BACKUP_DIR: bk1000 } })
        const ms = Number(process.hrtime.bigint() - t0) / 1e6
        return { ms, ok: Boolean(r.created && r.format === 'zip'), stderr: '' }
      },
    }

    let failed = 0
    for (const check of BENCH_CHECKS) {
      const effectiveBudget = computeCheckBudget(check, { unitMs, strictBudget })
      const median = measureMedian(check.label, runners[check.label])
      if (median === null) {
        process.stderr.write(`FAIL  ${check.label} 执行报错，无法判定预算 (${effectiveBudget} ms)\n`)
        failed += 1
        continue
      }
      const marginPct = Math.round(((effectiveBudget - median) / effectiveBudget) * 1000) / 10
      const budgetDesc = strictBudget
        ? `严格1x=${effectiveBudget} ms`
        : `校准阈值=${effectiveBudget} ms (unit=${Math.round(unitMs)}ms x ${check.unitMult}, cap=${check.hardCapMs}ms)`
      if (median > effectiveBudget) {
        process.stderr.write(`FAIL  ${check.label} 耗时超预算：实测中位数 ${Math.round(median)} ms > ${budgetDesc} | 余量 ${marginPct}%\n`)
        failed += 1
      } else {
        process.stdout.write(`  PASS  ${check.label}：中位数 ${Math.round(median)} ms <= ${budgetDesc} | 余量 +${marginPct}%\n`)
      }
    }

    if (failed > 0) return 1
    const modeLabel = strictBudget ? 'strict-1x' : `calibrated(unitMs=${Math.round(unitMs)}ms)`
    process.stdout.write(`\n耗时预算全部通过（${BENCH_CHECKS.length}/${BENCH_CHECKS.length} 项在预算内，mode=${modeLabel}）。\n`)
    return 0
  } finally {
    rmSync(dir300, { recursive: true, force: true })
    rmSync(dir1000, { recursive: true, force: true })
    rmSync(bk1000, { recursive: true, force: true })
  }
}

function isDirectCliRun() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1]))
  } catch {
    return false
  }
}

if (isDirectCliRun()) {
  process.exitCode = main()
}
