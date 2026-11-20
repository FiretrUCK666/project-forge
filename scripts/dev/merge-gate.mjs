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
 * 一条执行块算一步，**多行整块串行执行**。`check.yml:90-92` 那个块里是两条命令
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

import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit, parseStandardCli } from '../../kit/skills/lib/cli.mjs'
import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { deriveMergeGate, formatMergeGate, GATE_VERDICT } from '../../kit/skills/lib/gate-truth.mjs'
import { isMainModule } from '../../kit/skills/lib/git.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 一条派生步骤的实跑结果。退出码非零即失败，不看输出里写了什么。 */
function runStep(step, cwd) {
  const started = Date.now()
  const res = spawnSync(step.cmd, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    windowsHide: true,
    env: { ...process.env, CI: '1' },
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

  const executed = []
  for (const step of derived.steps) {
    const res = runStep(step, repoRoot)
    executed.push(res)
    if (!cli.json) process.stdout.write(`[${res.status === 0 ? 'ok' : 'FAIL'}] ${step.file}:${step.startLine} ${step.cmd.split('\n')[0].slice(0, 90)}\n`)
    if (res.status !== 0) break
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
