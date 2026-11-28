#!/usr/bin/env node
/**
 * iterate.mjs —— 第 8 技能 dev-iterate 核心引擎：
 * 双入口（自动盲区/热点 + --focus 自然语言定向勘察）、原生测试生成（过 edit-gate 反作弊门禁）、
 * 增量回挂 docs/feature-map.json testRefs、分片并发实跑与 escalation 缺陷升级闭环。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 kit/skills/lib/），绝不直接修改业务源码。
 *
 * 子命令：
 *   plan | generate | run | cycle
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { subcommandNamesFor } from '../../lib/subcommand-meta.mjs'
import { escalateToBackend } from '../../lib/escalation.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { shouldAutoEscalateFailure } from '../../lib/gate-receipt.mjs'
import {
  execSafe, isMacOsJunkPath, isMainModule, posixPath, resolveDefaultBranch, resolveRepoRoots, writeAtomic,
} from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { parseDevProfile } from '../../lib/profile.mjs'
import { applyLowPriority, resolveWorkerConcurrency } from '../../lib/proc-budget.mjs'
import { scanNeutralCiSteps } from '../../lib/profile-sniffer.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { TEST_FILE_RE } from '../../lib/static-gates.mjs'
import {
  collectConfiguredTestEntries, expandVerificationCommands, renderNativeTestContent,
  resolveNativeTestDir, resolveTestRunner, updateFeatureMapTestRefs, validateGeneratedTestQuality,
} from '../../lib/suite-inventory.mjs'
import {
  STOP_REASONS, buildCyclePlan, formatCycleText, loadCycleState,
  mergeCycleGates, mergeCycleHistory, saveCycleState,
} from './iterate-cycle.mjs'
import { ITERATE_SKIP_DIRS, buildIterationPlan, walkSourceFiles } from './iterate-plan.mjs'

export { buildIterationPlan, validateGeneratedTestQuality }

const SUBCOMMANDS = subcommandNamesFor('iterate')

function printHelp() {
  process.stdout.write([
    '用法：node iterate.mjs [plan|generate|run|cycle] [targetDir] [options]',
    '',
    'Subcommands:',
    '  plan        交叉比对 feature-map / signals.jsonl / 近期变更（或 --focus 主题）输出补测候选计划',
    '  generate    按原生目录与栈惯例生成测试（默认预演；传 --write 过反作弊校验后落盘并回挂 testRefs）',
    '  run         分片并发实跑原生测试；失败/超时/性能越阈自动写信号并按需经 escalation 建单',
    '  cycle       有界只读优化循环：Observe -> PoC/Escalate -> Fix/Verify -> Reflect，内置三条硬停损',
    '',
    'Options:',
    '  --dir <path>             目标仓库目录',
    '  --goal <text>            cycle 的优化目标（一句话说清这一轮想把什么做得更好）',
    '  --max-rounds <N>         cycle 轮次上限（默认 3，硬上限 10）',
    '  --progress-history <json>  cycle 历史进度（JSON 数组，每项含 round/observed/passed/verified/advanced）',
    '  --pending-gates <json>   cycle 待拍板门禁（JSON 数组，one-way/高风险项会立刻停损）',
    '  --focus <topic>          按自然语言主题/业务流先做 doc-locate + 符号勘察再定向建测',
    '  --tier <tier>            测试层级：integration | e2e | perf | regression（默认 integration）',
    '  --limit <N>              最多生成/规划候选数（默认 5）',
    '  --write                  将通过反作弊校验的候选测试写入目标仓原生测试目录',
    '  --targets <a,b>          指定要并发运行的测试文件（逗号分隔）',
    '  --concurrency <N>        并发 worker 数量（默认留 2 核余量，上限 4）',
    '  --jobs <N>               --concurrency 的别名（显式覆盖并发度）',
    '  --timeout-ms <ms>        单测执行超时毫秒（默认 30000）',
    '  --perf-budget-ms <ms>    性能预算阈值毫秒（超阈视为退化并升级）',
    '  --escalate               运行失败/越阈时显式开启经 escalation.mjs 建单转入正流修复（run 探索期默认静默不建单）',
    '  --no-escalate            强制关闭运行失败或 cycle 停损的自动升级建单',
    '  --reset                  重置已持久化的 cycle 状态重新开始',
    '  --no-signals             不写入 signals.jsonl（测试预演用）',
    '  --json                   输出结构化 JSON',
    '',
  ].join('\n'))
}

/** 生成并校验原生测试文件；`write=true` 时落盘并增量更新 `docs/feature-map.json` `testRefs`。 */
export async function generateIterationTests(repoRoot, {
  focus = '',
  tier = 'integration',
  limit = 5,
  write = false,
  isGit = true,
  gitDir = null,
} = {}) {
  const plan = await buildIterationPlan(repoRoot, { focus, tier, limit, isGit, gitDir })
  const generated = []
  const rejected = []
  const writtenPaths = []
  const matchedFeatureIds = []
  const matchedModulePaths = []

  for (const cand of plan.candidates) {
    const content = renderNativeTestContent(repoRoot, cand, plan.nativeTarget.stack)
    const quality = validateGeneratedTestQuality(cand.plannedTestFile, content)
    if (!quality.ok) {
      rejected.push({ plannedTestFile: cand.plannedTestFile, violations: quality.violations })
      continue
    }
    const absDest = join(repoRoot, cand.plannedTestFile)
    const alreadyExists = existsSync(absDest)
    let didWrite = false
    if (write && !alreadyExists) {
      mkdirSync(dirname(absDest), { recursive: true })
      writeAtomic(absDest, content)
      didWrite = true
      writtenPaths.push(cand.plannedTestFile)
    }
    if (cand.featureId) matchedFeatureIds.push(cand.featureId)
    if (cand.targetModule) matchedModulePaths.push(cand.targetModule)
    generated.push({
      file: cand.plannedTestFile,
      source: cand.source,
      featureId: cand.featureId,
      targetModule: cand.targetModule,
      avoidsQuickTest: cand.avoidsQuickTest,
      alreadyExists,
      written: didWrite,
      qualityOk: true,
    })
  }

  let featureMapUpdate = { updated: false, reason: 'dry-run', matchedFeatures: [], addedRefs: [] }
  if (write && writtenPaths.length > 0) {
    featureMapUpdate = updateFeatureMapTestRefs(repoRoot, {
      featureIds: matchedFeatureIds,
      modulePaths: matchedModulePaths,
      testPaths: writtenPaths,
    })
  }

  return {
    ok: rejected.length === 0,
    write: Boolean(write),
    mode: plan.mode,
    tier: plan.tier,
    nativeTarget: plan.nativeTarget,
    generated,
    rejected,
    writtenPaths,
    featureMapUpdate,
  }
}

function walkTestDirRecursive(repoRoot, startRel, maxFiles = 500) {
  const startAbs = join(repoRoot, startRel)
  if (!existsSync(startAbs) || !statSync(startAbs).isDirectory()) return []
  const out = []
  const stack = [posixPath(startRel).replace(/\/+$/, '')]
  while (stack.length > 0 && out.length < maxFiles) {
    const relDir = stack.pop()
    let entries = []
    try { entries = readdirSync(join(repoRoot, relDir), { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (isMacOsJunkPath(ent.name)) continue
      const rel = `${relDir}/${ent.name}`
      if (ent.isDirectory()) {
        if (!ITERATE_SKIP_DIRS.has(ent.name) && !ent.name.startsWith('.')) stack.push(rel)
      } else if (ent.isFile() && TEST_FILE_RE.test(rel)) {
        out.push(posixPath(rel))
      }
    }
  }
  return out
}

async function runSingleTestTarget(repoRoot, relPath, { timeoutMs = 30000, perfBudgetMs = 0, devProfile = null } = {}) {
  const t0 = performance.now()
  const resolved = resolveTestRunner(repoRoot, relPath, { devProfile })
  if (!resolved.ok) {
    const durationMs = Math.round(performance.now() - t0)
    return {
      file: posixPath(relPath),
      ok: false,
      exitCode: 1,
      durationMs,
      timedOut: false,
      perfExceeded: perfBudgetMs > 0 && durationMs > perfBudgetMs,
      failureKind: resolved.failureKind,
      runner: resolved.runner,
      stdout: '',
      stderr: resolved.reason,
    }
  }
  const res = await execSafe(resolved.command, resolved.args, { cwd: repoRoot, timeout: timeoutMs })
  const durationMs = Math.round(performance.now() - t0)
  const perfExceeded = perfBudgetMs > 0 && durationMs > perfBudgetMs
  const timedOut = Boolean(res.timedOut)
  const ok = Boolean(res.ok && !timedOut && !perfExceeded)
  const failureKind = timedOut
    ? 'timeout'
    : (!res.ok ? 'test-failure' : (perfExceeded ? 'perf-regression' : null))
  return {
    file: posixPath(relPath),
    ok,
    exitCode: res.code ?? (ok ? 0 : 1),
    durationMs,
    timedOut,
    perfExceeded,
    failureKind,
    runner: resolved.runner,
    stdout: String(res.stdout ?? '').slice(0, 600),
    stderr: String(res.stderr ?? '').slice(0, 600),
  }
}

/** 分片并发执行目标测试集；遇失败/超时/性能越阈不改业务源码，写 signals.jsonl 并仅在显式开启 escalate 时经 escalation.mjs 建单。 */
export async function runIterationSuites(repoRoot, {
  targets = [],
  tier = 'integration',
  concurrency = null,
  timeoutMs = 30000,
  perfBudgetMs = 0,
  escalate = false,
  writeSignals = true,
  isGit = true,
  gitDir = null,
  _backend = null,
  _ghProbe = null,
  _ghClient = null,
} = {}) {
  applyLowPriority(process.pid)
  const devProfile = parseDevProfile(repoRoot)
  let resolvedTargets = [...new Set((targets ?? []).map((t) => posixPath(String(t ?? '').trim()).replace(/^\.\//, '')).filter(Boolean))]
  if (resolvedTargets.length === 0) {
    const allCode = walkSourceFiles(repoRoot)
    const nativeInfo = resolveNativeTestDir(repoRoot, { tier, devProfile, files: allCode })
    for (const rel of walkTestDirRecursive(repoRoot, nativeInfo.dirRel)) resolvedTargets.push(rel)
    if (resolvedTargets.length === 0) {
      for (const f of allCode) { if (TEST_FILE_RE.test(f.rel)) resolvedTargets.push(f.rel) }
    }
    const { steps: ciSteps } = scanNeutralCiSteps(repoRoot)
    const expanded = expandVerificationCommands(repoRoot, ciSteps, devProfile, null)
    const { configuredTestEntries } = collectConfiguredTestEntries(repoRoot, allCode, expanded)
    for (const entry of configuredTestEntries) {
      if (existsSync(join(repoRoot, entry))) resolvedTargets.push(posixPath(entry))
    }
    resolvedTargets = [...new Set(resolvedTargets)]
  }
  resolvedTargets = resolvedTargets.filter((rel) => existsSync(join(repoRoot, rel))).sort()

  const requestedJobs = concurrency !== null && concurrency !== undefined ? concurrency : null
  const budgeted = resolveWorkerConcurrency({ requestedJobs, cap: requestedJobs !== null ? Infinity : 4 })
  const lanes = Math.max(1, Math.min(budgeted, Math.max(1, resolvedTargets.length)))
  const results = new Array(resolvedTargets.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < resolvedTargets.length) {
      const idx = cursor
      cursor += 1
      results[idx] = await runSingleTestTarget(repoRoot, resolvedTargets[idx], { timeoutMs, perfBudgetMs, devProfile })
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => worker()))

  const failed = results.filter((r) => r && !r.ok)
  const signalResults = []
  const escalations = []

  for (const item of failed) {
    const defectClass = item.failureKind === 'timeout' ? 'race-condition' : 'missing-runtime-proof'
    const isMissingRunner = item.failureKind === 'missing-runner' || item.failureKind === 'unsupported-ts-runtime'
    if (writeSignals) {
      const sig = await appendGovernSignal({
        mainRoot: repoRoot,
        gitDir,
        isGit,
        category: 'tests',
        file: item.file,
        pattern: `iterate.${item.failureKind || 'fail'}`,
        ruleId: `dev-iterate.${item.failureKind || 'fail'}`,
        defectClass,
        severity: isMissingRunner ? 'medium' : 'high',
        source: 'dev-iterate',
        message: `${item.file} failed (${item.failureKind}, exit=${item.exitCode}, ${item.durationMs}ms): ${(item.stderr || item.stdout || 'see test output').slice(0, 240)}`,
      })
      signalResults.push(sig)
    }
    if (escalate) {
      const esc = await escalateToBackend({
        backend: _backend,
        repoRoot,
        _ghProbe,
        _ghClient,
        item: {
          source: 'dev-iterate',
          severity: isMissingRunner ? 'medium' : 'high',
          singleFile: true,
          e2eBlocking: tier === 'e2e' && !isMissingRunner,
          title: `dev-iterate detected ${item.failureKind} in ${item.file}`,
          summary: `${item.file} failed (${item.failureKind}, duration=${item.durationMs}ms, exit=${item.exitCode})`,
          rootCause: (item.stderr || item.stdout || `Test ${item.file} failed under dev-iterate (${item.failureKind}).`).slice(0, 400),
          files: [item.file],
          labels: ['dev-iterate', item.failureKind === 'perf-regression' ? 'perf' : 'bug'],
          nextStep: 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "Fix failure detected by dev-iterate"',
        },
      })
      escalations.push({ file: item.file, ...esc })
    }
  }

  return {
    ok: failed.length === 0,
    repoRoot: posixPath(repoRoot),
    concurrency: lanes,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    signalsWritten: signalResults.filter((s) => s?.ok).length,
    escalations,
  }
}

async function main(argv = process.argv.slice(2), runtimeOpts = {}) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return 0
  }
  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      allowPositionalWithoutSubcommand: true,
      positionalDir: 'auto',
      booleanFlags: ['write', 'escalate', 'no-escalate', 'no-signals', 'reset'],
      valueFlags: ['focus', 'tier', 'limit', 'targets', 'concurrency', 'jobs', 'timeout-ms', 'perf-budget-ms', 'goal', 'max-rounds', 'progress-history', 'pending-gates'],
      aliases: { jobs: 'concurrency' },
      usageHint: `iterate.mjs [${SUBCOMMANDS.join('|')}] [dir]`,
    })
  } catch (err) {
    process.stderr.write(`iterate 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  const sub = cli.sub || 'plan'
  const opts = cli.opts
  const roots = await resolveRepoRoots(cli.targetDir)
  const repoRoot = roots.workTreeRoot

  if (sub === 'cycle') {
    const incomingGoal = String(opts.goal ?? '').trim()
    const prevLoaded = opts.reset ? null : loadCycleState(roots.mainRoot)
    const prevCycle = (prevLoaded && (!incomingGoal || !prevLoaded.goal || incomingGoal === prevLoaded.goal))
      ? prevLoaded
      : null
    const mergedHist = mergeCycleHistory(prevCycle?.progressHistory ?? [], opts['progress-history'])
    const mergedGates = mergeCycleGates(prevCycle?.pendingGates ?? [], opts['pending-gates'])
    const plan = buildCyclePlan({
      goal: opts.goal || prevCycle?.goal || '',
      maxRounds: opts['max-rounds'] ?? prevCycle?.maxRounds,
      progressHistory: mergedHist.rawForPlan,
      pendingGates: mergedGates,
    })
    if (mergedHist.parseWarnings.length > 0) plan.warnings.unshift(...mergedHist.parseWarnings)
    let escalated = prevCycle?.escalated ?? null
    if (plan.stopped && !opts['no-escalate'] && !escalated) {
      escalated = await escalateToBackend({
        backend: runtimeOpts._backend,
        repoRoot,
        _ghProbe: runtimeOpts._ghProbe,
        _ghClient: runtimeOpts._ghClient,
        item: {
          source: 'dev-iterate-cycle',
          stopLoss: true,
          severity: 'high',
          doorType: plan.stopReason === STOP_REASONS.ONE_WAY ? 'one-way' : 'two-way',
          title: `dev-iterate cycle stop-loss (${plan.stopReason}): ${plan.goal || 'iteration loop'}`,
          summary: plan.stopDetail ?? `Stopped at round ${plan.roundsCompleted}`,
          rootCause: plan.stopDetail ?? `Cycle stopped by ${plan.stopReason}`,
          reproEvidence: `roundsCompleted=${plan.roundsCompleted}, stopReason=${plan.stopReason}`,
          pocCommand: 'node ".agents/skills/dev-iterate/scripts/iterate.mjs" plan --json',
          files: [],
          labels: ['dev-iterate', 'stop-loss'],
        },
      })
    }
    if (escalated) plan.escalated = escalated
    saveCycleState(roots.mainRoot, {
      goal: plan.goal,
      maxRounds: plan.maxRounds,
      round: plan.nextRound ?? plan.roundsCompleted,
      progressHistory: plan.history,
      pendingGates: plan.pendingGates,
      stopped: plan.stopped,
      stopReason: plan.stopReason ?? null,
      escalated,
    })
    if (opts.json) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
    else process.stdout.write(`${formatCycleText(plan)}\n`)
    return plan.stopped ? 4 : 0
  }

  if (sub === 'plan') {
    const out = await buildIterationPlan(repoRoot, {
      focus: opts.focus ?? '',
      tier: opts.tier ?? 'integration',
      limit: opts.limit ? Number(opts.limit) : 5,
      isGit: roots.isGit,
      gitDir: roots.gitDir,
    })
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else {
      process.stdout.write(`dev-iterate plan (${out.mode}, tier=${out.tier}, targetDir=${out.nativeTarget.dirRel}): ${out.candidates.length} candidate(s)\n`)
      for (const c of out.candidates) {
        process.stdout.write(`  - [${c.source}] ${c.plannedTestFile} <- ${c.targetModule ?? '(repo)'} (${c.reason})\n`)
      }
    }
    return 0
  }

  if (sub === 'generate') {
    if (opts.write && roots.isGit && !roots.isWorktree) {
      const head = readHeadFast(resolveGitDirFast(repoRoot), roots.gitDir)
      const defBranch = await resolveDefaultBranch(repoRoot)
      const onDefault = Boolean(head?.branch && (defBranch ? head.branch === defBranch : ['main', 'master'].includes(head.branch)))
      if (head && head.oid && onDefault) {
        const msg = `BLOCKED_MAIN_SLOT_VIOLATION: 拒绝在有提交的默认分支（${head.branch}）非隔离主工作区执行 generate --write；请先运行 flow.mjs start 进入 .worktrees/ 隔离工作位。`
        if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, status: 'BLOCKED_MAIN_SLOT_VIOLATION', code: 'BLOCKED_MAIN_SLOT_VIOLATION', exitCode: EXIT.FACT, branch: head.branch, error: msg }, null, 2)}\n`)
        else process.stderr.write(`${msg}\n`)
        return EXIT.FACT
      }
    }
    const out = await generateIterationTests(repoRoot, {
      focus: opts.focus ?? '',
      tier: opts.tier ?? 'integration',
      limit: opts.limit ? Number(opts.limit) : 5,
      write: Boolean(opts.write),
      isGit: roots.isGit,
      gitDir: roots.gitDir,
    })
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else {
      process.stdout.write(`dev-iterate generate (write=${out.write}): ${out.generated.length} valid, ${out.rejected.length} rejected\n`)
      for (const g of out.generated) process.stdout.write(`  - ${g.file} (${g.written ? 'written' : 'preview'})\n`)
    }
    return out.ok ? 0 : 1
  }

  if (sub === 'run') {
    const targets = opts.targets ? String(opts.targets).split(',').map((s) => s.trim()).filter(Boolean) : []
    const out = await runIterationSuites(repoRoot, {
      targets,
      tier: opts.tier ?? 'integration',
      concurrency: opts.concurrency ? Number(opts.concurrency) : undefined,
      timeoutMs: opts['timeout-ms'] ? Number(opts['timeout-ms']) : 30000,
      perfBudgetMs: opts['perf-budget-ms'] ? Number(opts['perf-budget-ms']) : 0,
      escalate: shouldAutoEscalateFailure({ stage: 'iterate', mode: 'run', ledger: runtimeOpts._ledger ?? null, opts }).escalate,
      writeSignals: !opts['no-signals'],
      isGit: roots.isGit,
      gitDir: roots.gitDir,
      _backend: runtimeOpts._backend,
      _ghProbe: runtimeOpts._ghProbe,
      _ghClient: runtimeOpts._ghClient,
    })
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else {
      process.stdout.write(`dev-iterate run: ${out.passed}/${out.total} passed (failed=${out.failed}, concurrency=${out.concurrency})\n`)
      for (const r of out.results) {
        process.stdout.write(`  - [${r.ok ? 'PASS' : 'FAIL'}] ${r.file} (${r.durationMs}ms${r.failureKind ? `, ${r.failureKind}` : ''})\n`)
      }
      printNextStep([
        out.ok
          ? { skill: 'dev-iterate', text: 'node ".agents/skills/dev-iterate/scripts/iterate.mjs" cycle --json' }
          : { skill: 'dev-flow', text: 'node ".agents/skills/dev-flow/scripts/flow.mjs" next' },
      ], { repoRoot: roots.mainRoot })
    }
    return out.ok ? 0 : 1
  }

  process.stderr.write(`未知子命令：${sub}\n`)
  return 2
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main()
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`iterate 失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
