/**
 * suite-runner.mjs —— 从 `suite-inventory.mjs` 拆出的多技术栈测试执行器解析与只读验证命令收集器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 `suite-inventory.mjs` 与 `dev-iterate` 复用。
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, extname, join, posix } from 'node:path'

import { resolveExecutable } from './exec.mjs'
import { deriveMergeGate } from './gate-truth.mjs'
import { posixPath, readJsonSafe } from './git.mjs'
import { CODE_EXT_RE } from './static-gates.mjs'

function readUtf8FileSafe(absPath) {
  if (!existsSync(absPath)) return null
  try {
    const buf = readFileSync(absPath)
    if (buf.subarray(0, 4096).includes(0)) return null
    return buf.toString('utf8').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

/** 探测 Node/TS 测试运行器（优先读取 package.json 声明与 Dev Profile，避免写死单一运行器）。 */
export function detectNodeTestRunner(repoRoot, pkg = null, devProfile = null) {
  const manifest = pkg ?? readJsonSafe(join(repoRoot, 'package.json'))
  const deps = { ...(manifest?.dependencies ?? {}), ...(manifest?.devDependencies ?? {}) }
  const scriptBlob = Object.values(manifest?.scripts ?? {}).map((v) => String(v ?? '')).join('\n')
  const profileBlob = [
    ...(devProfile?.['quick-test'] ?? []),
    ...(devProfile?.['full-test'] ?? []),
    ...(devProfile?.['merge-gate'] ?? []),
  ].join('\n')
  const combined = `${scriptBlob}\n${profileBlob}`
  if (deps.vitest || /\bvitest\b/i.test(combined)) return 'vitest'
  if (deps.jest || deps['ts-jest'] || /\bjest\b/i.test(combined)) return 'jest'
  if (deps.tap || /\bnode\s+--?tap\b|\btap\b/i.test(combined)) return 'tap'
  if (deps.mocha || /\bmocha\b/i.test(combined)) return 'mocha'
  if (deps.ava || /\bava\b/i.test(combined)) return 'ava'
  if (existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb')) || /\bbun\s+test\b/i.test(combined)) return 'bun'
  if (deps.tsx || /\btsx\b/i.test(combined)) return 'tsx'
  return 'node'
}

function resolveLocalBin(repoRoot, name, env = process.env) {
  const cands = process.platform === 'win32'
    ? [join(repoRoot, 'node_modules', '.bin', `${name}.cmd`), join(repoRoot, 'node_modules', '.bin', name)]
    : [join(repoRoot, 'node_modules', '.bin', name)]
  return cands.find((c) => existsSync(c)) ?? resolveExecutable(name, { cwd: repoRoot, env })
}

/** 统一解析多技术栈（Python/Java/Node-TS/Go/Rust）单个测试文件真实执行器；缺失则返回 `missing-runner`。 */
export function resolveTestRunner(repoRoot, targetRel, opts = {}) {
  const { devProfile = null, fileText = null, env = process.env, nodeVersion = process.versions.node } = opts
  const cleanRel = posixPath(String(targetRel ?? '')).replace(/^\.\//, '')
  const ext = extname(cleanRel).toLowerCase()
  const txt = fileText ?? readUtf8FileSafe(join(repoRoot, cleanRel)) ?? ''
  const ok = (runner, command, args) => ({ ok: true, runner, command, args, failureKind: null })
  const miss = (runner, reason, failureKind = 'missing-runner') => ({ ok: false, runner, command: null, args: [], failureKind, reason })
  if (/^\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts)$/.test(ext)) {
    const fw = /\bfrom\s+['"]vitest['"]|require\(['"]vitest['"]\)/.test(txt) ? 'vitest'
      : /@jest\/globals|\bfrom\s+['"]jest['"]/.test(txt) ? 'jest'
      : /\bfrom\s+['"]tap['"]|require\(['"]tap['"]\)/.test(txt) ? 'tap'
      : /\bfrom\s+['"]mocha['"]|require\(['"]mocha['"]\)/.test(txt) ? 'mocha'
      : /\bfrom\s+['"]ava['"]|require\(['"]ava['"]\)/.test(txt) ? 'ava'
      : (/\bnode:test\b/.test(txt) ? 'node' : detectNodeTestRunner(repoRoot, null, devProfile))
    const binArgs = { vitest: ['run', cleanRel], jest: [cleanRel], tap: [cleanRel], mocha: [cleanRel], ava: [cleanRel], bun: ['test', cleanRel] }
    if (binArgs[fw]) {
      const bin = fw === 'bun' ? resolveExecutable('bun', { cwd: repoRoot, env }) : resolveLocalBin(repoRoot, fw, env)
      return bin ? ok(fw, bin, binArgs[fw]) : miss(fw, `missing ${fw} test runner binary`)
    }
    if (/^\.(?:ts|tsx|mts|cts)$/.test(ext)) {
      const tsx = resolveLocalBin(repoRoot, 'tsx', env)
      if (tsx) return ok('tsx', tsx, ['--test', cleanRel])
      const bun = resolveExecutable('bun', { cwd: repoRoot, env })
      if (bun) return ok('bun', bun, ['test', cleanRel])
      const [maj, min] = String(nodeVersion).split('.').map((n) => Number.parseInt(n, 10) || 0)
      return (maj > 22 || (maj === 22 && min >= 6)) ? ok('node', process.execPath, ['--experimental-strip-types', '--test', cleanRel]) : miss('node', 'Node < 22.6 lacks TypeScript test execution without tsx/vitest/jest/bun', 'unsupported-ts-runtime')
    }
    return ok('node', process.execPath, ['--test', cleanRel])
  }
  if (ext === '.py') {
    const venvHit = ['.venv/Scripts/pytest.exe', '.venv/bin/pytest', 'venv/Scripts/pytest.exe', 'venv/bin/pytest'].find((r) => existsSync(join(repoRoot, r)))
    if (venvHit) return ok('pytest', join(repoRoot, venvHit), [cleanRel])
    const pyBin = resolveExecutable('pytest', { cwd: repoRoot, env })
    if (pyBin) return ok('pytest', pyBin, [cleanRel])
    const uv = (existsSync(join(repoRoot, 'pyproject.toml')) || existsSync(join(repoRoot, 'uv.lock'))) ? resolveExecutable('uv', { cwd: repoRoot, env }) : null
    if (uv) return ok('uv', uv, ['run', 'pytest', cleanRel])
    const poetry = existsSync(join(repoRoot, 'pyproject.toml')) ? resolveExecutable('poetry', { cwd: repoRoot, env }) : null
    if (poetry) return ok('poetry', poetry, ['run', 'pytest', cleanRel])
    const py = /\bunittest\b/.test(txt) ? (resolveExecutable('python3', { cwd: repoRoot, env }) ?? resolveExecutable('python', { cwd: repoRoot, env })) : null
    return py ? ok('unittest', py, ['-m', 'unittest', cleanRel]) : miss('pytest', 'missing Python test runner (.venv/pytest, pytest, uv, poetry, or unittest)')
  }
  if (ext === '.java') {
    const cls = basename(cleanRel, '.java')
    for (const [r, wrap, manifests, cli, args] of [
      ['mvn', process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw', ['pom.xml'], 'mvn', [`-Dtest=${cls}`, 'test']],
      ['gradle', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew', ['build.gradle', 'build.gradle.kts'], 'gradle', ['test', '--tests', cls]],
    ]) {
      if (existsSync(join(repoRoot, wrap))) return ok(r, join(repoRoot, wrap), args)
      const bin = manifests.some((m) => existsSync(join(repoRoot, m))) ? resolveExecutable(cli, { cwd: repoRoot, env }) : null
      if (bin) return ok(r, bin, args)
    }
    return miss('java', 'missing Maven (mvnw/mvn) or Gradle (gradlew/gradle) runner')
  }
  if (ext === '.go') { const b = resolveExecutable('go', { cwd: repoRoot, env }); const d = posix.dirname(cleanRel); return b ? ok('go', b, ['test', d === '.' ? '.' : `./${d}`]) : miss('go', 'missing go binary') }
  if (ext === '.rs') { const b = resolveExecutable('cargo', { cwd: repoRoot, env }); return b ? ok('cargo', b, ['test']) : miss('cargo', 'missing cargo binary') }
  return miss(ext || 'unknown', `unsupported test file extension for ${cleanRel}`)
}

const CMD_SKIP_RE = /^(?:echo|printf|mkdir|cd|export|set|if|then|else|elif|fi|for|do|done|exit|return|true|false|rm|cp|mv|cat|\{|\}|#|$)(?:\s|$)|^(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add|setup|update)\b|^(?:pip3?|uv|poetry)\s+(?:install|sync|add)\b|^(?:cargo\s+fetch|go\s+mod\s+(?:download|tidy)|bundle\s+install|composer\s+install|dotnet\s+restore)\b|\b(?:git\s+(?:push|commit|tag|checkout|reset|clean|rebase|merge)|npm\s+publish|gh\s+(?:release|pr\s+(?:create|merge|edit))|prettier\b[^\n]*--write|eslint\b[^\n]*--fix|ruff\b[^\n]*--fix|biome\b[^\n]*(?:--write|--apply)|gofmt\s+-w)\b|\|\s*(?:sh|bash|zsh)\b/i
const CMD_MUTATOR_SCRIPT_RE = /(?:^|[/_-])(?:compose|equip|sync|generate|gen|format|fmt|fix|migrate|update|install|setup|bootstrap|scaffold|build|release|publish|deploy)(?:[-_][a-z0-9_.-]*)?\.(?:m?js|cjs|ts|py|sh|ps1)\b/i
const CMD_READONLY_FLAG_RE = /(?:^|\s)(?:--check|--dry-run|--verify|--list|--status|--diff|check|audit|validate|test|lint|review|survey)(?:\s|$)/i
const CMD_META_AGGREGATE_RE = /(?:^|[\s/"'=])(?:merge[-_]?gate|ci[-_]?all|run[-_]?all[-_]?gates)(?:\.[a-z0-9]+)?(?:\s|$)/i
const CMD_SERIAL_HEAVY_RE = /\b(?:bench|benchmark|perf|profile|fixtures|e2e|harness|injections?|fuzz|stress|playwright|cypress|selenium|testcontainers|git\s+archive)\b|(?:^|\s)--(?:jobs|concurrency)\b/i
const CMD_REMOTE_OR_PLATFORM_RE = /\b(?:gh\s+(?:api|pr|release|workflow|run|secret)|git\s+(?:push|fetch|remote)|curl\s+https?:|wget\s+https?:|actions\/)\b|\$\{\{\s*(?:needs\.|matrix\.|secrets\.|github\.|strategy\.|env\.)/i

function normalizeVerificationCommand(rawCmd, tempDir = '') {
  let s = String(rawCmd ?? '').replace(/\r\n/g, '\n').trim()
  if (!s || /^(?:none|null|false)$/i.test(s) || /no test specified/i.test(s) || s.includes('{target}')) return null
  if (tempDir) s = s.replace(/\$\{\{\s*runner\.temp\s*\}\}/gi, posixPath(tempDir))
  if (/\$\{\{[^}]+?\}\}/.test(s) || CMD_REMOTE_OR_PLATFORM_RE.test(s)) return null
  s = s.replace(/\s*\|\|\s*\{\s*[\s\S]*?\}\s*$/, '').trim()
  const lines = s.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !/^set\s+-[euox]+/i.test(l))
  if (lines.length === 0 || lines.some((l) => /^(?:if|then|else|elif|fi|for|while|do|done|case|esac)\b/.test(l))) return null
  const joined = lines.join(' && ').replace(/\s+/g, ' ').trim()
  if (!joined || CMD_SKIP_RE.test(joined)) return null
  if (CMD_MUTATOR_SCRIPT_RE.test(joined) && !CMD_READONLY_FLAG_RE.test(joined)) return null
  return joined
}

function extractPrimaryScriptPath(repoRoot, cmd, codeRelSet) {
  let last = null
  for (const tok of String(cmd ?? '').split(/[\s"'`;|&()]+/)) {
    const clean = posixPath(tok).replace(/^\.\//, '')
    if (clean && !clean.startsWith('-') && CODE_EXT_RE.test(clean) && (codeRelSet.has(clean) || existsSync(join(repoRoot, clean)))) last = clean
  }
  return last
}

/** 收集仓库已配置的只读验证命令（完整保留参数、排除写盘/发布/元聚合门禁并标注串行与重型特性）。 */
export function collectConfiguredVerificationCommands(repoRoot, { ciSteps = [], devProfile = null, files = [], tempDir = '' } = {}) {
  const codeRelSet = new Set((files ?? []).filter((f) => CODE_EXT_RE.test(f.name ?? f.rel ?? '')).map((f) => posixPath(f.rel ?? f)))
  const derived = deriveMergeGate(repoRoot)
  const rejectedCi = new Set((derived.skippedFiles ?? []).filter((s) => /写作用域|触发形态不是/.test(String(s.reason ?? ''))).map((s) => posixPath(s.file)))
  const rawEntries = (derived.steps ?? []).length > 0
    ? derived.steps.map((s) => ({ cmd: s.cmd, source: 'ci', heavy: false }))
    : (ciSteps ?? []).filter((s) => !s?.file || !rejectedCi.has(posixPath(s.file))).map((s) => ({ cmd: s?.cmd, source: 'ci', heavy: false }))
  for (const key of ['quick-test', 'full-test', 'smoke-verify']) {
    for (const c of devProfile?.[key] ?? []) rawEntries.push({ cmd: c, source: `profile:${key}`, heavy: key === 'full-test' })
  }
  const byCmd = new Map()
  const aggregateFallback = []
  const pushEntry = (norm, source, heavy) => {
    const isHeavy = Boolean(heavy || CMD_SERIAL_HEAVY_RE.test(norm))
    if (byCmd.has(norm)) { if (isHeavy) { byCmd.get(norm).heavy = true; byCmd.get(norm).serial = true }; return }
    byCmd.set(norm, { cmd: norm, scriptPath: extractPrimaryScriptPath(repoRoot, norm, codeRelSet), source, heavy: isHeavy, serial: isHeavy })
  }
  for (const item of rawEntries) {
    const norm = normalizeVerificationCommand(item.cmd, tempDir)
    if (!norm) continue
    if (CMD_META_AGGREGATE_RE.test(norm)) { aggregateFallback.push({ norm, source: item.source }); continue }
    pushEntry(norm, item.source, item.heavy)
  }
  if (byCmd.size === 0) {
    for (const c of devProfile?.['merge-gate'] ?? []) {
      const norm = normalizeVerificationCommand(c, tempDir)
      if (norm) aggregateFallback.push({ norm, source: 'profile:merge-gate' })
    }
    for (const item of aggregateFallback) pushEntry(item.norm, item.source, true)
  }
  if (byCmd.size === 0) {
    const norm = normalizeVerificationCommand(readJsonSafe(join(repoRoot, 'package.json'))?.scripts?.test, tempDir)
    if (norm) pushEntry(norm, 'package.json:test', false)
  }
  return [...byCmd.values()]
}
