#!/usr/bin/env node
/**
 * edit-gate.mjs —— 第 6 技能 `dev-edit` 全量改码入口边界核对与词法静态门禁引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`），覆盖：
 *   - `pre-edit`：禁改区（do-not-edit）拦截、高风险与 730-800 行紧文件预警、相邻复用符号提示；
 *   - `verify` / `standalone`：词法剥离注释与字面量后阻断压制注释、履历墓碑、注释死代码、
 *     arch-rules 越界导入、单测反作弊与 >800 行文件膨胀，并按需联动目标仓原生校验配置。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import { flushAndExit, parseStandardCli } from '../../lib/cli.mjs'
import { execSafe, resolveExecutable } from '../../lib/exec.mjs'
import {
  gitDiffNameStatusZ, gitRun, gitStatusPorcelainZ, isMacOsJunkPath, isMainModule,
  posixPath, readTextSafe, resolveDefaultBranch, resolveRepoRoots,
} from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { readTaskLedger, sanitizeTaskId, updateTaskLedger } from '../../lib/ledger.mjs'
import { parseDevProfile } from '../../lib/profile.mjs'
import {
  classifyTestFileTier, detectOptionalNativeCheckers, detectTestTierMetadata,
} from '../../lib/profile-sniffer.mjs'
import { appendGovernSignal, inferSignalModule } from '../../lib/signals.mjs'
import {
  ASSERTION_RE, CODE_EXT_RE, FIXTURE_FILE_RE, NEAR_LIMIT_LINES, TEST_CASE_RE, TEST_FILE_RE,
  evaluateArchRules, matchGlob, scanStructuralHygiene, scanTestAntiCheat,
} from '../../lib/static-gates.mjs'
import { extractSymbols } from '../../lib/symbol-index.mjs'

export const EXIT = Object.freeze({ OK: 0, USAGE: 2, BLOCKED: 3 })
const VALID_MODES = new Set(['verify', 'pre-edit', 'standalone'])

function printHelp() {
  process.stdout.write([
    '用法：node edit-gate.mjs [--mode verify|pre-edit|standalone] [--files a,b] [--changed] [--with-native] [--dir <path>] [--task <id>] [--skip-edit-gate --reason <why>] [--json]',
    '',
    'Options:',
    '  --mode <mode>       verify | pre-edit | standalone (default: standalone)',
    '  --files <a,b>       Comma-separated target files to check',
    '  --changed           Collect uncommitted and branch-changed files from git',
    '  --with-native       Optionally run declared native lint/typecheck commands if configured',
    '  --dir <path>        Repository root directory (default: cwd)',
    '  --task <id>         Optional task ID for audit signal / ledger attribution',
    '  --skip-edit-gate    Explicitly skip gate (requires --reason; blocked with --final)',
    '  --final             Final pre-merge verification (forbids --skip-edit-gate)',
    '  --reason <text>     Reason recorded when --skip-edit-gate is passed',
    '  --emit-signals      Append violation signals to <gitCommonDir>/project-forge-govern/signals.jsonl',
    '  --json              Emit machine-readable JSON output',
    '',
  ].join('\n'))
}

function normalizeRelFile(repoRoot, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const rel = isAbsolute(s) ? relative(repoRoot, s) : s
  return posixPath(rel).replace(/^\.\//, '').replace(/^\/+/, '')
}

async function collectChangedEntries(workRoot, isGit, defaultBranch) {
  const byFile = new Map()
  if (!isGit) return []

  const st = await gitStatusPorcelainZ(workRoot)
  if (st.ok) {
    for (const e of st.entries) {
      if (!e.file || isMacOsJunkPath(e.file)) continue
      const status = String(e.status ?? 'M').trim()
      if (status.includes('D') && !status.includes('R')) continue
      byFile.set(posixPath(e.file), { file: posixPath(e.file), status: status.includes('R') ? 'R' : status || 'M' })
    }
  }

  const fastGitDir = resolveGitDirFast(workRoot)
  const fastHead = readHeadFast(fastGitDir)
  const hasHead = fastHead ? Boolean(fastHead.oid) : (await gitRun(workRoot, ['rev-parse', '--verify', 'HEAD'])).ok
  if (!hasHead) return [...byFile.values()]

  const bases = [...new Set([defaultBranch, 'main', 'master'].filter(Boolean))]
  for (const baseRef of bases) {
    const fastSha = resolveRefShaFast(fastGitDir, `refs/heads/${baseRef}`) ?? resolveRefShaFast(fastGitDir, `refs/remotes/origin/${baseRef}`)
    const verify = fastSha ? { ok: true } : await gitRun(workRoot, ['rev-parse', '--verify', '--quiet', baseRef])
    if (!verify.ok) continue
    const mb = await gitRun(workRoot, ['--no-optional-locks', 'merge-base', baseRef, 'HEAD'])
    const headSha = fastHead?.oid ?? (await gitRun(workRoot, ['rev-parse', 'HEAD'])).stdout.trim()
    if (mb.ok && mb.stdout.trim() && mb.stdout.trim() !== headSha) {
      const diff = await gitDiffNameStatusZ(workRoot, [`${mb.stdout.trim()}..HEAD`])
      if (diff.ok) {
        for (const e of diff.entries) {
          if (!e.file || isMacOsJunkPath(e.file) || e.status === 'D') continue
          const rel = posixPath(e.file)
          if (!byFile.has(rel)) byFile.set(rel, { file: rel, status: String(e.status || 'M') })
        }
      }
      break
    }
  }
  return [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file))
}

function collectSiblingReuseHints(workRoot, targetFiles) {
  const hints = []
  const seenDirs = new Set()
  const targetSet = new Set(targetFiles)
  for (const rel of targetFiles) {
    const dirRel = posixPath(dirname(rel))
    const key = dirRel === '.' ? '' : dirRel
    if (seenDirs.has(key)) continue
    seenDirs.add(key)
    const absDir = key ? join(workRoot, key) : workRoot
    if (!existsSync(absDir)) continue
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }) } catch { continue }
    const siblings = []
    for (const ent of entries) {
      if (!ent.isFile() || !CODE_EXT_RE.test(ent.name)) continue
      const sibRel = key ? `${key}/${ent.name}` : ent.name
      if (targetSet.has(sibRel) || TEST_FILE_RE.test(sibRel) || FIXTURE_FILE_RE.test(sibRel)) continue
      const txt = readTextSafe(join(absDir, ent.name), 256 * 1024)
      if (!txt) continue
      const ext = ent.name.split('.').pop()?.toLowerCase() ?? ''
      const sym = extractSymbols(txt, ext)
      if (sym.supported && sym.symbols.length > 0) {
        siblings.push({ file: sibRel, symbols: sym.symbols.slice(0, 8) })
      }
      if (siblings.length >= 6) break
    }
    if (siblings.length > 0) hints.push({ dir: key || '.', siblings })
  }
  return hints
}

function isLegalArchiveMove(entry) {
  const rel = posixPath(entry?.file ?? '')
  return rel.startsWith('docs/archive/') && /^R/i.test(String(entry?.status ?? ''))
}

async function runOptionalNativeChecks(workRoot, nativeInfo) {
  const results = []
  if (!nativeInfo?.hasNativeConfig) {
    return { executed: false, skipped: 'no-native-config', results }
  }
  for (const item of nativeInfo.configured) {
    if (!item.declared || !item.command) {
      results.push({ id: item.id, tool: item.tool, status: 'skipped', reason: 'not-declared-in-scripts' })
      continue
    }
    const parts = item.command.split(/\s+/).filter(Boolean)
    const cmd = parts[0]
    const args = parts.slice(1)
    if (!resolveExecutable(cmd, { cwd: workRoot })) {
      results.push({ id: item.id, tool: item.tool, command: item.command, status: 'skipped', reason: 'binary-unavailable' })
      continue
    }
    const res = await execSafe(cmd, args, { cwd: workRoot, timeoutMs: 30000 })
    if (res.ok) {
      results.push({ id: item.id, tool: item.tool, command: item.command, status: 'passed' })
    } else if (/ENOENT|not recognized|not found/i.test(String(res.stderr ?? '') + String(res.error ?? ''))) {
      results.push({ id: item.id, tool: item.tool, command: item.command, status: 'skipped', reason: 'binary-unavailable' })
    } else {
      results.push({
        id: item.id,
        tool: item.tool,
        command: item.command,
        status: 'failed',
        exitCode: res.status ?? res.code ?? 1,
        output: String(res.stderr || res.stdout || '').trim().slice(0, 300),
      })
    }
  }
  return { executed: results.some((r) => r.status === 'passed' || r.status === 'failed'), results }
}

/**
 * 执行 `dev-edit` 改码门禁（可被 CLI 或 `flow-lifecycle-hooks.mjs` 直接调用）。
 */
export async function runEditGate(opts = {}) {
  const mode = String(opts.mode ?? 'standalone').trim().toLowerCase()
  if (!VALID_MODES.has(mode)) {
    return { ok: false, exitCode: EXIT.USAGE, error: `Invalid --mode "${mode}". Expected: verify | pre-edit | standalone` }
  }

  const targetDir = resolve(String(opts.dir ?? opts.targetDir ?? process.cwd()))
  if (!existsSync(targetDir)) {
    return { ok: false, exitCode: EXIT.USAGE, error: `Directory does not exist: ${targetDir}` }
  }

  const roots = await resolveRepoRoots(targetDir)
  const { isGit, mainRoot, workTreeRoot, gitDir } = roots
  const taskId = opts.task ? sanitizeTaskId(opts.task) : null

  if (opts.skipEditGate) {
    if (opts.final) {
      return { ok: false, mode, exitCode: EXIT.BLOCKED, code: 'BLOCKED_SKIP_EDIT_GATE_FORBIDDEN_ON_FINAL', error: '最终合并前 verify 禁止使用 --skip-edit-gate 绕过词法静态门禁。' }
    }
    const reason = String(opts.reason ?? '').trim()
    if (!reason) {
      return { ok: false, mode, exitCode: EXIT.USAGE, error: '--skip-edit-gate requires non-empty --reason "<text>" for auditability.' }
    }
    await appendGovernSignal({
      mainRoot, gitDir, isGit, category: 'hygiene', module: 'edit-gate', pattern: 'edit-gate.skipped',
      ruleId: 'edit.skip-gate', defectClass: 'suppression-bypass', severity: 'medium', source: 'edit-gate',
      message: `edit-gate skipped (mode=${mode}): ${reason}`, taskId, meta: { mode, reason },
    })
    if (taskId && readTaskLedger(mainRoot, taskId)) {
      await updateTaskLedger(mainRoot, taskId, (cur) => ({ ...cur, editGateSkipped: { at: new Date().toISOString(), mode, reason } }))
    }
    return {
      ok: true, mode, skipped: true, recorded: true, reason, taskId, exitCode: EXIT.OK, checkedFiles: [], blockers: [],
      warnings: [{ ruleId: 'edit.skip-gate', message: `已显式记账跳过 edit-gate：${reason}` }],
    }
  }

  const devProfile = parseDevProfile(workTreeRoot)
  const defaultBranch = isGit ? await resolveDefaultBranch(workTreeRoot) : null
  const doNotEditGlobs = devProfile['do-not-edit'] ?? []
  const highRiskGlobs = devProfile['high-risk'] ?? []
  const archRules = devProfile['arch-rules'] ?? []

  let entries = []
  if (Array.isArray(opts.files) && opts.files.length > 0) {
    entries = opts.files.map((f) => normalizeRelFile(workTreeRoot, f)).filter(Boolean).map((file) => ({ file, status: 'M' }))
  } else if (typeof opts.files === 'string' && opts.files.trim()) {
    entries = opts.files.split(',').map((f) => normalizeRelFile(workTreeRoot, f)).filter(Boolean).map((file) => ({ file, status: 'M' }))
  } else if (opts.changed || mode === 'verify') {
    entries = await collectChangedEntries(workTreeRoot, isGit, defaultBranch)
  }

  const dedupEntries = []
  const seenFiles = new Set()
  for (const e of entries) {
    if (!e.file || seenFiles.has(e.file)) continue
    seenFiles.add(e.file)
    dedupEntries.push(e)
  }

  const blockers = []
  const warnings = []
  const nearLimitFiles = []
  const highRiskHits = []
  const checkedFiles = dedupEntries.map((e) => e.file)

  for (const entry of dedupEntries) {
    const rel = entry.file
    if (!isLegalArchiveMove(entry) && doNotEditGlobs.some((pat) => matchGlob(rel, pat))) {
      blockers.push({ ruleId: 'edit.do-not-edit', defectClass: 'stale-contract', severity: 'high', file: rel, line: 1, message: `目标文件命中 AGENTS.md do-not-edit 禁改路径：${rel}`, fixHint: '停止修改受保护归档/生成目录；若属合法任务归档请走 flow.mjs finalize。' })
    }
    if (highRiskGlobs.some((pat) => matchGlob(rel, pat))) {
      highRiskHits.push(rel)
      warnings.push({ ruleId: 'edit.high-risk-path', severity: 'medium', file: rel, message: `目标文件落入 high-risk 高风险路径（合并前须独立审查与故障注入）：${rel}` })
    }
  }

  const nativeCheckers = detectOptionalNativeCheckers(workTreeRoot)

  if (mode === 'pre-edit') {
    for (const rel of checkedFiles) {
      const abs = join(workTreeRoot, rel)
      if (!existsSync(abs) || !CODE_EXT_RE.test(rel) || FIXTURE_FILE_RE.test(rel) || TEST_FILE_RE.test(rel)) continue
      const txt = readTextSafe(abs, 512 * 1024)
      if (!txt) continue
      const lineCount = txt.replace(/\r\n/g, '\n').split('\n').length
      if (lineCount > 800) {
        warnings.push({ ruleId: 'edit.existing-oversized', severity: 'medium', file: rel, lines: lineCount, message: `目标文件当前已有 ${lineCount} 行（> 800 行上限），请先拆分模块再继续扩展：${rel}` })
      } else if (lineCount >= NEAR_LIMIT_LINES) {
        nearLimitFiles.push({ file: rel, lines: lineCount, limit: 800 })
        warnings.push({ ruleId: 'edit.file-near-limit', severity: 'low', file: rel, lines: lineCount, message: `目标文件处于紧文件区（${lineCount}/800 行），新增逻辑建议抽离独立模块：${rel}` })
      }
    }
    const reuseHints = collectSiblingReuseHints(workTreeRoot, checkedFiles)
    const ok = blockers.length === 0
    return {
      ok, mode, exitCode: ok ? EXIT.OK : EXIT.BLOCKED, repoRoot: posixPath(workTreeRoot),
      checkedFiles, blockers, violations: blockers, warnings, nearLimitFiles, highRiskHits, reuseHints, nativeCheckers,
      summary: { checked: checkedFiles.length, blockers: blockers.length, warnings: warnings.length },
    }
  }

  const tierMeta = detectTestTierMetadata(workTreeRoot, checkedFiles)
  const codeRelList = []

  for (const entry of dedupEntries) {
    const rel = entry.file
    if (!CODE_EXT_RE.test(rel)) continue
    const abs = join(workTreeRoot, rel)
    if (!existsSync(abs)) continue
    const txt = readTextSafe(abs, 512 * 1024)
    if (txt === undefined) continue
    codeRelList.push(rel)

    const lines = txt.replace(/\r\n/g, '\n').split('\n')
    const hyg = scanStructuralHygiene({ fileRel: rel, lines, fullLineCount: lines.length, warnLines: 800, nearLimitLines: NEAR_LIMIT_LINES })

    for (const s of hyg.excuseSuppressions) {
      blockers.push({ ruleId: 'edit.suppression-bypass', defectClass: 'suppression-bypass', severity: 'high', file: rel, line: s.line, excerpt: s.excerpt, message: `检测到无正当锚点的压制/借口注释：${rel}:${s.line}`, fixHint: '直接修复根因类型或静态检查错误，禁止使用 @ts-ignore/eslint-disable/HACK/WORKAROUND/TEMP/noqa/#[allow( 压制。' })
    }
    for (const t of hyg.tombstoneComments) {
      blockers.push({ ruleId: 'edit.tombstone-comment', defectClass: 'stale-contract', severity: 'high', file: rel, line: t.line, excerpt: t.excerpt, message: `检测到履历墓碑注释：${rel}:${t.line}`, fixHint: '仅描述当前不变量与现状，历史改动交由 Git 提交记录保存。' })
    }
    for (const db of hyg.deadCodeBlocks) {
      blockers.push({ ruleId: 'edit.dead-code-block', defectClass: 'dead-code', severity: 'high', file: rel, line: db.line, endLine: db.endLine, excerpt: db.excerpt, message: `检测到连续注释死代码块（${db.length} 行）：${rel}:${db.line}-${db.endLine}`, fixHint: '直接删除废弃注释代码块，依靠版本历史追溯。' })
    }
    if (hyg.godFile) {
      blockers.push({ ruleId: 'edit.file-oversized', defectClass: 'file-bloat', severity: 'high', file: rel, line: lines.length, lines: lines.length, message: `源文件超出 800 行上限（当前 ${lines.length} 行）：${rel}`, fixHint: '按单一职责拆分为内聚子模块，保持每个源文件 <= 800 行。' })
    } else if (hyg.nearLimitFile) {
      nearLimitFiles.push(hyg.nearLimitFile)
      warnings.push({ ruleId: 'edit.file-near-limit', severity: 'low', file: rel, lines: lines.length, message: `紧文件预警（${lines.length}/800 行），建议提前规划模块拆分：${rel}` })
    }

    const isMetaHarness = /(?:^|\/)(?:fixtures|verify-injections|gap-coverage)\.[^/]+$/i.test(rel) || /\bfunction\s+tmpProject\s*\(/.test(txt)
    if (TEST_FILE_RE.test(rel) && !FIXTURE_FILE_RE.test(rel) && !isMetaHarness) {
      const { tier } = classifyTestFileTier(rel, txt, tierMeta)
      for (const hit of scanTestAntiCheat({ fileRel: rel, text: txt, assertionRe: ASSERTION_RE, testCaseRe: TEST_CASE_RE, isNonUnit: tier !== 'unit' })) {
        blockers.push(hit)
      }
    }
  }

  const archRes = evaluateArchRules(workTreeRoot, codeRelList, archRules)
  for (const v of archRes.violations) {
    blockers.push({ ruleId: 'edit.arch-boundary', defectClass: 'arch-boundary', severity: 'high', file: v.file, line: v.line, rule: v.rule, specifier: v.specifier, message: v.message, fixHint: v.fixHint })
  }

  let nativeRun = null
  if (opts.withNative) {
    nativeRun = await runOptionalNativeChecks(workTreeRoot, nativeCheckers)
    for (const r of nativeRun.results) {
      if (r.status === 'failed') {
        blockers.push({
          ruleId: `edit.native-${r.id}`,
          defectClass: 'general',
          severity: 'high',
          file: '',
          line: 1,
          message: `原生检查失败（${r.command}，exit=${r.exitCode}）：${r.output}`,
          fixHint: `运行 \`${r.command}\` 修复原生校验报错。`,
        })
      }
    }
  }

  if (opts.emitSignals && blockers.length > 0) {
    for (const b of blockers.slice(0, 20)) {
      await appendGovernSignal({
        mainRoot,
        gitDir,
        isGit,
        category: 'hygiene',
        module: inferSignalModule(b.file),
        pattern: b.ruleId,
        ruleId: b.ruleId,
        defectClass: b.defectClass,
        severity: b.severity || 'high',
        source: 'edit-gate',
        file: b.file || '',
        line: b.line,
        message: b.message,
        taskId,
      })
    }
  }

  const ok = blockers.length === 0
  return {
    ok,
    mode,
    exitCode: ok ? EXIT.OK : EXIT.BLOCKED,
    repoRoot: posixPath(workTreeRoot),
    checkedFiles,
    blockers,
    violations: blockers,
    warnings,
    nearLimitFiles,
    highRiskHits,
    nativeCheckers,
    ...(nativeRun ? { nativeRun } : {}),
    summary: { checked: checkedFiles.length, blockers: blockers.length, warnings: warnings.length },
  }
}

function formatText(res) {
  if (res.error) return `Error: ${res.error}`
  const lines = [
    `=== DEV-EDIT GATE (${String(res.mode ?? 'standalone').toUpperCase()}) ===`,
    `Status   : ${res.skipped ? 'SKIPPED (RECORDED)' : (res.ok ? 'PASS' : 'BLOCKED')}`,
    `Checked  : ${res.checkedFiles?.length ?? 0} file(s) | Blockers=${res.blockers?.length ?? 0} | Warnings=${res.warnings?.length ?? 0}`,
  ]
  if (res.blockers?.length > 0) {
    lines.push('', '--- Blockers ---')
    for (const b of res.blockers) {
      const loc = b.file ? `${b.file}${b.line ? `:${b.line}` : ''}` : 'repo'
      lines.push(`  - [${b.ruleId}] ${loc}: ${b.message}`)
      if (b.fixHint) lines.push(`      Fix: ${b.fixHint}`)
    }
  }
  if (res.warnings?.length > 0) {
    lines.push('', '--- Warnings ---')
    for (const w of res.warnings) lines.push(`  - [${w.ruleId}] ${w.file || 'repo'}: ${w.message}`)
  }
  if (res.reuseHints?.length > 0) {
    lines.push('', '--- Adjacent Reuse Hints ---')
    for (const h of res.reuseHints) {
      lines.push(`  - ${h.dir}: ${h.siblings.map((s) => `${s.file} (${s.symbols.slice(0, 4).join(', ')})`).join(' | ')}`)
    }
  }
  return lines.join('\n')
}

export async function runCli(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp()
    return EXIT.OK
  }
  let parsed
  try {
    parsed = parseStandardCli(argv, {
      allowPositionalWithoutSubcommand: true,
      positionalDir: 'auto',
      booleanFlags: ['changed', 'with-native', 'skip-edit-gate', 'final', 'emit-signals'],
      valueFlags: ['mode', 'files', 'task', 'reason'],
      usageHint: 'edit-gate.mjs [--mode verify|pre-edit|standalone] [--files a,b] [--changed] [--with-native] [--json]',
    })
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`)
    return EXIT.USAGE
  }
  const { opts, targetDir } = parsed
  const res = await runEditGate({
    mode: opts.mode ?? 'standalone',
    dir: targetDir,
    files: opts.files,
    changed: Boolean(opts.changed),
    withNative: Boolean(opts['with-native']),
    task: opts.task,
    skipEditGate: Boolean(opts['skip-edit-gate']),
    final: Boolean(opts.final),
    reason: opts.reason,
    emitSignals: Boolean(opts['emit-signals']),
  })
  if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
  else process.stdout.write(`${formatText(res)}\n`)
  if (!res.ok && res.error) process.stderr.write(`${res.error}\n`)
  return res.exitCode
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli()
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`edit-gate 错误：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
