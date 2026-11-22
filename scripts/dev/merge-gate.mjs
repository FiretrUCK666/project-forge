#!/usr/bin/env node
/**
 * merge-gate.mjs —— 合入门禁编排器：按流水线结构派生清单，逐块经 shell 实跑，输出四档结论。
 *
 * ## 为什么必须有这个脚本
 *
 * 手写清单与流水线之间没有任何机械关系：流水线加了一步，清单不会变；清单少写一步，
 * 没人发现。两份「应该跑什么」，迟早对不上，而对不上的表现是「本地全绿、远端红」。
 *
 * 门禁值固定为「跑这个脚本」：运行时从流水线派生、逐块实跑。它不读手写清单，
 * 所以不存在两份真相。
 *
 * ## 为什么整块交给 shell
 *
 * 一条执行块算一步，**多行整块串行执行**。`check.yml` 中「用户包内容」执行块里是两条命令
 * （导出包清单 + 按清单核对），算一步就只能整块交给 shell 跑；如果这里自己
 * `execFile` 拆词，那个块就跑不成——派生清单看着对，实际少跑了一半。
 *
 * ## 四档结论，谁都不许折成通过
 *
 * `passed` / `failed` / `unverified` / `not-applicable`。这个脚本能产出前三种：
 * 全跑通是 `passed`；有一步非零是 `failed`；被 `--dry-run` 或 `--only` 筛掉了
 * 部分是 `unverified`。`not-applicable`（仓库没有可识别流水线）由 `deriveMergeGate`
 * 直接给出，同样不阻断。
 *
 * 用法：
 *   node scripts/dev/merge-gate.mjs             # 派生并逐块实跑
 *   node scripts/dev/merge-gate.mjs --dry-run   # 只派生，不跑（结论一定是 unverified）
 *   node scripts/dev/merge-gate.mjs --json
 */

import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit, parseStandardCli } from '../../kit/skills/lib/cli.mjs'
import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { deriveMergeGate, formatMergeGate, GATE_VERDICT } from '../../kit/skills/lib/gate-truth.mjs'
import { isMainModule } from '../../kit/skills/lib/git.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * 一条派生步骤的实跑结果。退出码非零即失败，不看输出里写了什么。
 *
 * `env` 由调用方给：流水线自己声明的环境条件（CI 标记、矩阵变量）要照原样带上，
 * 否则「远端绿、本地红」可能只是环境不同，而门禁会把它当成代码有问题。
 */
function isHeavyOrStatefulStep(cmd) {
  const s = String(cmd ?? '')
  return /(?:fixtures\.mjs|verify-injections\.mjs|e2e-zip-harness\.mjs|blind-run-harness\.mjs|bench\.mjs|git\s+archive\b|tar\s+-|>)/.test(s)
}

function runStepAsync(step, cwd, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now()
    const child = spawn(step.cmd, {
      cwd,
      shell: true,
      windowsHide: true,
      env: { ...process.env, ...extraEnv },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, 30 * 60 * 1000)
    child.stdout?.on('data', (c) => { stdout = `${stdout}${c}`.slice(-4000) })
    child.stderr?.on('data', (c) => { stderr = `${stderr}${c}`.slice(-4000) })
    const done = (status, error = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        ...step,
        status: status ?? 1,
        durationMs: Date.now() - started,
        stdoutTail: stdout.slice(-1200),
        stderrTail: stderr.slice(-1200),
        error,
      })
    }
    child.on('error', (err) => done(1, String(err?.message ?? err)))
    child.on('close', (code) => done(code ?? 1, null))
  })
}

async function runPoolBounded(tasks, concurrency = 4) {
  const results = new Array(tasks.length)
  let nextIdx = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIdx < tasks.length) {
      const idx = nextIdx++
      results[idx] = await tasks[idx]()
    }
  })
  await Promise.all(workers)
  return results
}

function runStep(step, cwd, extraEnv = {}) {
  const started = Date.now()
  const res = spawnSync(step.cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    windowsHide: true,
    env: { ...process.env, ...extraEnv },
  })
  return {
    ...step,
    status: res.status,
    durationMs: Date.now() - started,
    stdoutTail: String(res.stdout ?? '').slice(-1200),
    stderrTail: String(res.stderr ?? '').slice(-1200),
    error: res.error ? String(res.error.message ?? res.error) : null,
  }
}

function printHelp() {
  process.stdout.write([
    '用法：node scripts/dev/merge-gate.mjs [--dry-run] [--json]',
    '',
    '从流水线结构派生合入门禁清单，逐块经 shell 实跑，输出四档结论。',
    '  --dry-run   只派生不执行（结论为 unverified，不是通过）',
    '  --json      机读输出',
  ].join('\n') + '\n')
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printHelp(); return EXIT.OK }
  const cli = parseStandardCli(argv, { booleanFlags: ['dry-run'], valueFlags: ['dir'], positionalDir: 'first' })
  const repoRoot = cli.targetDir === process.cwd() ? ROOT : cli.targetDir

  const derived = deriveMergeGate(repoRoot)
  const lines = formatMergeGate(derived)

  if (derived.verdict === GATE_VERDICT.NOT_APPLICABLE) {
    if (cli.json) process.stdout.write(`${JSON.stringify({ ...derived, executed: [] }, null, 2)}\n`)
    else process.stdout.write(`${lines.join('\n')}\n`)
    return EXIT.OK
  }
  if (derived.blocking) {
    if (cli.json) process.stdout.write(`${JSON.stringify({ ...derived, executed: [] }, null, 2)}\n`)
    else {
      process.stdout.write(`${lines.join('\n')}\n`)
      process.stderr.write(`合入门禁结论为 ${derived.verdict}：派生阶段就断了，一步都没跑。\n`)
    }
    return EXIT.FACT
  }

  if (cli.flags['dry-run']) {
    const out = { ...derived, executed: [], dryRun: true }
    if (cli.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else process.stdout.write(`${lines.join('\n')}\n只派生未执行：结论停在 unverified，不是通过。\n`)
    return EXIT.OK
  }

  // 流水线文件自己声明的环境条件（`env:` 块里的 CI 标记与矩阵变量）按原样带上：
  // `bench` 一类脚本会按 CI 标记放大预算，本地不带上就会得到一张与远端不同的成绩单。
  //
  // 平台上下文变量要分开对待，一律抹成空串是错的：
  // - `runner.temp` 有本地等价物（系统临时目录），代入它，这一步在本地才跑得出同样的结果；
  // - `matrix.*` / `needs.*` 没有等价物，抹成空串，让步骤落到自己那条「平台没给值」的分支。
  const pipelineEnv = derived.evidenceEnv ?? { CI: 'true' }
  const localTemp = tmpdir().replace(/\\/g, '/')
  const substitutePlatformContext = (cmd) => String(cmd)
    .replace(/\$\{\{\s*runner\.temp\s*\}\}/g, localTemp)
    .replace(/\$\{\{[^}]+?\}\}/g, '')
  const preparedSteps = derived.steps.map((step, idx) => ({
    idx,
    step: { ...step, cmd: substitutePlatformContext(step.cmd) },
  }))
  const readonlyEntries = preparedSteps.filter((x) => !isHeavyOrStatefulStep(x.step.cmd))
  const heavyEntries = preparedSteps.filter((x) => isHeavyOrStatefulStep(x.step.cmd))
  const resultsByIdx = new Array(preparedSteps.length)

  if (readonlyEntries.length > 0) {
    const roResults = await runPoolBounded(
      readonlyEntries.map((entry) => () => runStepAsync(entry.step, repoRoot, pipelineEnv)),
      4,
    )
    for (let i = 0; i < readonlyEntries.length; i += 1) {
      resultsByIdx[readonlyEntries[i].idx] = roResults[i]
    }
  }
  const executed = []
  let roFailed = false
  for (let i = 0; i < preparedSteps.length; i += 1) {
    let res = resultsByIdx[i]
    if (!res) {
      if (roFailed) break
      res = runStep(preparedSteps[i].step, repoRoot, pipelineEnv)
      resultsByIdx[i] = res
    }
    executed.push(res)
    const ok = res.status === 0 ? 'ok' : 'FAIL'
    if (!cli.json) process.stdout.write(`[${ok}] ${res.file}:${res.startLine} ${res.cmd.split('\n')[0].slice(0, 90)}\n`)
    if (res.status !== 0) {
      roFailed = true
      if (heavyEntries.some((h) => h.idx === i)) break
    }
  }

  const firstFail = executed.find((e) => e.status !== 0)
  const allRan = executed.length === derived.steps.length
  const verdict = firstFail ? GATE_VERDICT.FAILED : (allRan ? GATE_VERDICT.PASSED : GATE_VERDICT.UNVERIFIED)
  const payload = {
    ...derived,
    verdict,
    executed,
    blocking: verdict === GATE_VERDICT.FAILED,
    reasons: [
      ...derived.reasons,
      firstFail ? `第 ${executed.indexOf(firstFail) + 1} 步失败（exit=${firstFail.status}）：${firstFail.cmd.split('\n')[0]}` : null,
      allRan ? `全部 ${executed.length} 步已实跑` : `只跑了 ${executed.length}/${derived.steps.length} 步`,
    ].filter(Boolean),
  }

  if (cli.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else {
    process.stdout.write(`\n合入门禁结论：${verdict}（${executed.length}/${derived.steps.length} 步）\n`)
    for (const r of payload.reasons) process.stdout.write(`  - ${r}\n`)
  }

  if (verdict === GATE_VERDICT.FAILED) {
    const e = firstFail
    if (e.stderrTail) process.stderr.write(`${e.stderrTail}\n`)
    return EXIT.FACT
  }
  return EXIT.OK
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`merge-gate 错误：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
