#!/usr/bin/env node
/**
 * iterate.mjs —— 第 8 技能 dev-iterate 核心引擎：
 * 双入口（自动盲区/热点 + --focus 自然语言定向勘察）、原生测试生成（过 edit-gate 反作弊门禁）、
 * 增量回挂 docs/feature-map.json testRefs、分片并发实跑与 escalation 缺陷升级闭环。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 kit/skills/lib/），绝不直接修改业务源码。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { cpus } from 'node:os'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'

import { flushAndExit, parseStandardCli } from '../../lib/cli.mjs'
import { locateDocuments } from '../../lib/doc-locator.mjs'
import { escalateToBackend } from '../../lib/escalation.mjs'
import {
  COMMON_SKIP_DIRS, execSafe, gitRun, isMacOsJunkPath, isMainModule,
  posixPath, readTextSafe, resolveRepoRoots, writeAtomic,
} from '../../lib/git.mjs'
import { resolveExecutable } from '../../lib/exec.mjs'
import { parseDevProfile } from '../../lib/profile.mjs'
import { appendGovernSignal, readSignalsJsonl, resolveGovernStateDir } from '../../lib/signals.mjs'
import { CODE_EXT_RE, TEST_FILE_RE } from '../../lib/static-gates.mjs'
import { extractSymbols } from '../../lib/symbol-index.mjs'
import {
  isPathInQuickTestScope, readFeatureMapSafe, renderNativeTestContent,
  resolveNativeTestDir, slugTestToken, updateFeatureMapTestRefs, validateGeneratedTestQuality,
} from '../../lib/test-inventory.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'
import { buildCyclePlan, formatCycleText, loadCycleState, saveCycleState } from './iterate-cycle.mjs'

export { validateGeneratedTestQuality }

const SUBCOMMANDS = ['plan', 'generate', 'run', 'cycle']
const VALID_TIERS = new Set(['integration', 'e2e', 'perf', 'regression'])
const SKIP_DIRS = new Set([...COMMON_SKIP_DIRS, '.git', '.worktrees', '.agents', 'docs'])

function printHelp() {
  process.stdout.write([
    '用法：node iterate.mjs [plan|generate|run] [targetDir] [options]',
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
    '  --concurrency <N>        并发 worker 数量（默认 min(4, CPU核数)）',
    '  --timeout-ms <ms>        单测执行超时毫秒（默认 30000）',
    '  --perf-budget-ms <ms>    性能预算阈值毫秒（超阈视为退化并升级）',
    '  --escalate               运行失败/越阈时经 escalation.mjs 建单转入正流修复',
    '  --no-signals             不写入 signals.jsonl（测试预演用）',
    '  --json                   输出结构化 JSON',
    '',
  ].join('\n'))
}

function walkSourceFiles(repoRoot, maxFiles = 1500) {
  const out = []
  const stack = ['']
  while (stack.length > 0 && out.length < maxFiles) {
    const relDir = stack.pop()
    const absDir = relDir ? join(repoRoot, relDir) : repoRoot
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (isMacOsJunkPath(entry.name)) continue
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
        stack.push(rel)
      } else if (entry.isFile()) {
        if (isToolOwnedPath(rel) || !CODE_EXT_RE.test(entry.name)) continue
        out.push({ rel: posixPath(rel), name: entry.name, full: join(absDir, entry.name) })
        if (out.length >= maxFiles) break
      }
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

async function collectRecentChangedFiles(repoRoot, isGit) {
  if (!isGit) return []
  const res = await gitRun(repoRoot, ['log', '-n', '10', '--name-only', '--pretty=format:'])
  if (!res.ok) return []
  const counts = new Map()
  for (const line of String(res.stdout ?? '').split('\n')) {
    const clean = posixPath(line.trim())
    if (!clean || !CODE_EXT_RE.test(clean) || TEST_FILE_RE.test(clean) || isToolOwnedPath(clean)) continue
    if (!existsSync(join(repoRoot, clean))) continue
    counts.set(clean, (counts.get(clean) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([file, touches]) => ({ file, touches }))
}

function extractFocusKeywords(focusText) {
  const raw = String(focusText ?? '').trim().toLowerCase()
  if (!raw) return []
  const asciiTokens = raw.match(/[a-z0-9_./-]{2,}/g) ?? []
  const cjkChunks = raw.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  return [...new Set([...asciiTokens, ...cjkChunks])].slice(0, 12)
}

/** 识别盲区与热点并构造补测候选计划（支持自动交叉比对与 `--focus` 自然语言定向）。 */
export async function buildIterationPlan(repoRoot, {
  focus = '',
  tier = 'integration',
  limit = 5,
  isGit = true,
  gitDir = null,
} = {}) {
  const cleanTier = VALID_TIERS.has(String(tier).toLowerCase()) ? String(tier).toLowerCase() : 'integration'
  const devProfile = parseDevProfile(repoRoot)
  const allCode = walkSourceFiles(repoRoot)
  const srcFiles = allCode.filter((f) => !TEST_FILE_RE.test(f.rel))
  const testFiles = allCode.filter((f) => TEST_FILE_RE.test(f.rel))
  const featureMap = readFeatureMapSafe(repoRoot)
  const stateDir = resolveGovernStateDir(repoRoot, gitDir, isGit)
  const { events: signals } = readSignalsJsonl(stateDir)
  const recentChanges = await collectRecentChangedFiles(repoRoot, isGit)
  const nativeTarget = resolveNativeTestDir(repoRoot, { tier: cleanTier, devProfile, files: allCode })

  const candidates = []
  const seenTargets = new Set()
  const addCandidate = (cand) => {
    const key = `${cand.featureId ?? ''}|${cand.targetModule ?? ''}|${cand.topic ?? ''}`
    if (seenTargets.has(key)) return
    seenTargets.add(key)
    candidates.push(cand)
  }

  let focusContext = null
  if (String(focus ?? '').trim()) {
    const keywords = extractFocusKeywords(focus)
    let docSlices = []
    try {
      const located = locateDocuments(repoRoot, { query: focus, limit: 5 })
      docSlices = (located?.slices ?? located?.matches ?? []).slice(0, 5).map((m) => ({
        file: m.relPath ?? m.file,
        heading: m.section ?? m.heading ?? null,
        lines: m.startLine && m.endLine ? `${m.startLine}-${m.endLine}` : null,
      }))
    } catch { /* graceful degrade */ }

    const scoredModules = []
    for (const sf of srcFiles) {
      const lowPath = sf.rel.toLowerCase()
      let score = 0
      for (const kw of keywords) {
        if (lowPath.includes(kw)) score += 3
      }
      const txt = readTextSafe(sf.full, 128 * 1024) ?? ''
      if (txt) {
        const lowTxt = txt.toLowerCase()
        for (const kw of keywords) {
          if (lowTxt.includes(kw)) score += 1
        }
      }
      if (score > 0) {
        const syms = extractSymbols(txt, sf.rel)
        scoredModules.push({
          rel: sf.rel,
          score,
          symbols: Array.isArray(syms?.symbols) ? syms.symbols.slice(0, 6).map((s) => s.name) : [],
        })
      }
    }
    scoredModules.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel))

    const matchedFeatures = featureMap.features.filter((feat) => {
      const blob = JSON.stringify(feat).toLowerCase()
      return keywords.some((kw) => blob.includes(kw))
    })
    focusContext = {
      query: String(focus).trim(),
      keywords,
      docSlices,
      matchedModules: scoredModules.slice(0, 8),
      matchedFeatures: matchedFeatures.map((f) => f.id ?? f.name).filter(Boolean),
    }

    for (const mod of scoredModules.slice(0, limit)) {
      const feat = matchedFeatures.find((f) => JSON.stringify(f).toLowerCase().includes(mod.rel.toLowerCase()))
        ?? matchedFeatures[0] ?? null
      addCandidate({
        priority: 100 + mod.score,
        source: 'focus',
        reason: `定向主题「${String(focus).trim()}」命中模块 ${mod.rel}`,
        topic: String(focus).trim(),
        featureId: feat?.id ?? feat?.name ?? null,
        targetModule: mod.rel,
        exportedSymbols: mod.symbols,
        tier: cleanTier,
      })
    }
    if (candidates.length === 0) {
      const fallbackMod = srcFiles[0]?.rel ?? null
      addCandidate({
        priority: 95,
        source: 'focus',
        reason: `定向主题「${String(focus).trim()}」生成行为回归覆盖`,
        topic: String(focus).trim(),
        featureId: matchedFeatures[0]?.id ?? matchedFeatures[0]?.name ?? null,
        targetModule: fallbackMod,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }
  } else {
    // 1. 功能地图盲区（无 testRefs、弱覆盖或 stale）
    for (const feat of featureMap.features) {
      const testRefs = Array.isArray(feat.testRefs) ? feat.testRefs.filter(Boolean) : []
      const entryFiles = [
        ...(Array.isArray(feat.entrypoints) ? feat.entrypoints : []),
        ...(Array.isArray(feat.modules) ? feat.modules : []),
        ...(Array.isArray(feat.entryFiles) ? feat.entryFiles : []),
        ...(Array.isArray(feat.files) ? feat.files : []),
        ...(feat.entry ? [feat.entry] : []),
      ].filter(Boolean)
      const isWeak = testRefs.length === 0 || feat.stale === true
      if (!isWeak) continue
      const primaryMod = entryFiles.find((p) => existsSync(join(repoRoot, p))) ?? entryFiles[0] ?? null
      addCandidate({
        priority: feat.stale ? 95 : 90,
        source: 'feature-map-gap',
        reason: feat.stale
          ? `feature-map 条目 ${feat.id ?? feat.name} 已标记 stale 且缺少回归护栏`
          : `feature-map 条目 ${feat.id ?? feat.name} 尚无 testRefs 覆盖`,
        topic: feat.name ?? feat.id ?? 'feature-gap',
        featureId: feat.id ?? feat.name ?? null,
        targetModule: primaryMod ? posixPath(primaryMod) : null,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }

    // 2. signals.jsonl 高频复发热点模块
    const hotspotByMod = new Map()
    for (const ev of signals) {
      const target = posixPath(ev.file || ev.targetArtifact || '')
      if (!target || isToolOwnedPath(target) || TEST_FILE_RE.test(target)) continue
      const cur = hotspotByMod.get(target) ?? { count: 0, classes: new Set() }
      cur.count += 1
      if (ev.defectClass) cur.classes.add(ev.defectClass)
      hotspotByMod.set(target, cur)
    }
    for (const [mod, info] of [...hotspotByMod.entries()].sort((a, b) => b[1].count - a[1].count)) {
      if (info.count < 2) continue
      addCandidate({
        priority: 80 + Math.min(15, info.count * 2),
        source: 'signal-hotspot',
        reason: `signals.jsonl 中 ${mod} 累计触发 ${info.count} 次告警（${[...info.classes].join(', ') || 'defect'}）`,
        topic: basename(mod).replace(/\.[^.]+$/, ''),
        featureId: null,
        targetModule: existsSync(join(repoRoot, mod)) ? mod : null,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }

    // 3. 近期高频变更源码模块
    for (const ch of recentChanges.slice(0, limit)) {
      const covered = testFiles.some((tf) => tf.rel.toLowerCase().includes(basename(ch.file).replace(/\.[^.]+$/, '').toLowerCase()))
      if (covered && candidates.length >= limit) continue
      addCandidate({
        priority: covered ? 50 + ch.touches : 70 + ch.touches,
        source: 'recent-change',
        reason: `近期提交高频改动 ${ch.file}（${ch.touches} 次）`,
        topic: basename(ch.file).replace(/\.[^.]+$/, ''),
        featureId: null,
        targetModule: ch.file,
        exportedSymbols: [],
        tier: cleanTier,
      })
    }

    // 4. 兜底：无 feature-map / signals / 历史变更时按核心源码补测
    if (candidates.length === 0 && srcFiles.length > 0) {
      for (const sf of srcFiles.slice(0, limit)) {
        addCandidate({
          priority: 40,
          source: 'source-inventory',
          reason: `源码模块 ${sf.rel} 缺少对应 ${cleanTier} 回归测试`,
          topic: basename(sf.rel).replace(/\.[^.]+$/, ''),
          featureId: null,
          targetModule: sf.rel,
          exportedSymbols: [],
          tier: cleanTier,
        })
      }
    }
  }

  candidates.sort((a, b) => b.priority - a.priority)
  const selected = candidates.slice(0, Math.max(1, Number(limit) || 5)).map((c) => {
    const stem = slugTestToken(c.featureId || c.topic || (c.targetModule ? basename(c.targetModule).replace(/\.[^.]+$/, '') : 'flow'))
    const fileName = nativeTarget.stack === 'python'
      ? `test_${stem.replace(/-/g, '_')}_${cleanTier}.py`
      : nativeTarget.stack === 'go'
        ? `${stem.replace(/-/g, '_')}_${cleanTier}_test.go`
        : nativeTarget.stack === 'rust'
          ? `${stem.replace(/-/g, '_')}_${cleanTier}.rs`
          : (nativeTarget.isTypeScript || nativeTarget.ext === '.ts'
              ? `${stem}.${cleanTier}.test.ts`
              : `${stem}.${cleanTier}.test.mjs`)
    const plannedTestFile = posixPath(`${nativeTarget.dirRel}/${fileName}`)
    return {
      ...c,
      plannedTestFile,
      avoidsQuickTest: !isPathInQuickTestScope(devProfile, plannedTestFile),
    }
  })

  return {
    ok: true,
    repoRoot: posixPath(repoRoot),
    tier: cleanTier,
    mode: focus ? 'focus' : 'auto',
    featureMapPresent: featureMap.present,
    featureMapValid: featureMap.valid,
    signalsAnalyzed: signals.length,
    recentChangedCount: recentChanges.length,
    nativeTarget,
    ...(focusContext ? { focusContext } : {}),
    candidates: selected,
  }
}

/** 生成并校验原生测试文件；`write=true` 时落盘并增量更新 `docs/feature-map.json` `testRefs`。 */
export async function generateIterationTests(repoRoot, {
  focus = '',
  tier = 'integration',
  limit = 3,
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

function resolveLocalNodeBin(repoRoot, binName) {
  const candidate = join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? `${binName}.cmd` : binName)
  return existsSync(candidate) ? candidate : null
}

async function runSingleTestTarget(repoRoot, relPath, { timeoutMs = 30000, perfBudgetMs = 0 } = {}) {
  const abs = join(repoRoot, relPath)
  const ext = relPath.split('.').pop()?.toLowerCase() ?? ''
  const t0 = performance.now()
  let cmd = process.execPath
  let args = ['--test', abs]
  if (ext === 'py') {
    cmd = process.platform === 'win32' ? 'python' : 'python3'
    args = ['-m', 'unittest', relPath]
  } else if (ext === 'go') {
    cmd = 'go'
    args = ['test', `./${posix.dirname(relPath)}`]
  } else if (ext === 'rs') {
    cmd = 'cargo'
    args = ['test', '--test', basename(relPath, '.rs')]
  } else if (['ts', 'tsx', 'mts', 'cts'].includes(ext)) {
    const content = readTextSafe(abs) ?? ''
    const localVitest = resolveLocalNodeBin(repoRoot, 'vitest')
    const localJest = resolveLocalNodeBin(repoRoot, 'jest')
    const localTsx = resolveLocalNodeBin(repoRoot, 'tsx')
    const [nodeMajor, nodeMinor] = process.versions.node.split('.').map((n) => Number(n) || 0)
    const supportsNativeTs = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 6)
    if (/from\s+['"]vitest['"]/.test(content) && localVitest) {
      cmd = localVitest
      args = ['run', relPath]
    } else if (localJest && !/from\s+['"]node:test['"]/.test(content)) {
      cmd = localJest
      args = [relPath]
    } else if (localTsx) {
      cmd = localTsx
      args = ['--test', abs]
    } else if ((existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb'))) && resolveExecutable('bun')) {
      cmd = 'bun'
      args = ['test', abs]
    } else if (nodeMajor === 22 && nodeMinor >= 6) {
      cmd = process.execPath
      args = ['--experimental-strip-types', '--test', abs]
    } else if (!supportsNativeTs) {
      const durationMs = Math.round(performance.now() - t0)
      return {
        file: posixPath(relPath),
        ok: false,
        exitCode: 1,
        durationMs,
        timedOut: false,
        perfExceeded: perfBudgetMs > 0 && durationMs > perfBudgetMs,
        failureKind: 'unsupported-ts-runtime',
        stdout: '',
        stderr: `Node ${process.versions.node} 不支持直接执行 .${ext} 测试文件且未找到本地 vitest/jest/tsx/bun 可执行文件：${relPath}`,
      }
    }
  }
  const res = await execSafe(cmd, args, { cwd: repoRoot, timeout: timeoutMs })
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
    stdout: String(res.stdout ?? '').slice(0, 600),
    stderr: String(res.stderr ?? '').slice(0, 600),
  }
}

/** 分片并发执行目标测试集；遇失败/超时/性能越阈不改业务源码，写 signals.jsonl 并按需经 escalation.mjs 建单。 */
export async function runIterationSuites(repoRoot, {
  targets = [],
  tier = 'integration',
  concurrency = Math.min(4, Math.max(1, cpus().length)),
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
  const devProfile = parseDevProfile(repoRoot)
  let resolvedTargets = [...new Set((targets ?? []).map((t) => posixPath(String(t ?? '').trim()).replace(/^\.\//, '')).filter(Boolean))]
  if (resolvedTargets.length === 0) {
    const nativeInfo = resolveNativeTestDir(repoRoot, { tier, devProfile })
    const dirAbs = join(repoRoot, nativeInfo.dirRel)
    if (existsSync(dirAbs) && statSync(dirAbs).isDirectory()) {
      for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
        if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
          resolvedTargets.push(posixPath(`${nativeInfo.dirRel}/${entry.name}`))
        }
      }
    }
  }
  resolvedTargets = resolvedTargets.filter((rel) => existsSync(join(repoRoot, rel))).sort()

  const lanes = Math.max(1, Math.min(Number(concurrency) || 2, Math.max(1, resolvedTargets.length)))
  const results = new Array(resolvedTargets.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < resolvedTargets.length) {
      const idx = cursor
      cursor += 1
      results[idx] = await runSingleTestTarget(repoRoot, resolvedTargets[idx], { timeoutMs, perfBudgetMs })
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => worker()))

  const failed = results.filter((r) => r && !r.ok)
  const signalResults = []
  const escalations = []

  for (const item of failed) {
    const defectClass = item.failureKind === 'timeout' ? 'race-condition' : 'missing-runtime-proof'
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
        severity: 'high',
        source: 'dev-iterate',
        message: `${item.file} failed (${item.failureKind}, exit=${item.exitCode}, ${item.durationMs}ms): ${(item.stderr || item.stdout || 'see test output').slice(0, 240)}`,
      })
      signalResults.push(sig)
    }
    if (escalate) {
      const esc = await escalateToBackend({
        backend: _backend,
        repoRoot,
        force: true,
        _ghProbe,
        _ghClient,
        item: {
          source: 'dev-iterate',
          caseType: 2,
          severity: 'high',
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
      booleanFlags: ['write', 'escalate', 'no-signals'],
      valueFlags: ['focus', 'tier', 'limit', 'targets', 'concurrency', 'timeout-ms', 'perf-budget-ms', 'goal', 'max-rounds', 'progress-history', 'pending-gates'],
      usageHint: 'iterate.mjs [plan|generate|run|cycle] [dir]',
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
    const prevCycle = loadCycleState(roots.mainRoot)
    const effectiveProgress = opts['progress-history'] ?? prevCycle?.progressHistory ?? []
    const plan = buildCyclePlan({
      goal: opts.goal || prevCycle?.goal || '',
      maxRounds: opts['max-rounds'] ?? prevCycle?.maxRounds,
      progressHistory: effectiveProgress,
      pendingGates: opts['pending-gates'],
    })
    saveCycleState(roots.mainRoot, {
      goal: plan.goal,
      maxRounds: plan.maxRounds,
      round: plan.nextRound ?? plan.roundsCompleted,
      progressHistory: plan.roundProgress,
      stopped: plan.stopped,
      stopReason: plan.stopReason ?? null,
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
    const out = await generateIterationTests(repoRoot, {
      focus: opts.focus ?? '',
      tier: opts.tier ?? 'integration',
      limit: opts.limit ? Number(opts.limit) : 3,
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
      escalate: Boolean(opts.escalate),
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
