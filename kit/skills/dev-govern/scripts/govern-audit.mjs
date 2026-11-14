#!/usr/bin/env node
/**
 * govern-audit.mjs -- Repository code audit, tech-debt planning, multi-round
 * governance loop tracking, GitHub issue payload generation, and harness reconcile.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules only.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, posix, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENTS_WARN_BYTES = 24576
const AGENTS_MAX_BYTES = 30720
const GOD_FILE_WARN_LINES = 800
const GOD_FILE_HIGH_LINES = 1500
const LARGE_FILE_BYTES = 1024 * 1024
const MAX_READ_BYTES = 512 * 1024

const ALL_CATEGORIES = ['security', 'deadcode', 'tests', 'docs', 'hygiene', 'perf']
const VALID_CATEGORIES = new Set(ALL_CATEGORIES)
const DEV_PROFILE_KEYS = ['quick-test', 'full-test', 'smoke-verify', 'merge-gate', 'arch-rules', 'high-risk', 'do-not-edit']

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', '.yarn', 'bower_components',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.tox', '.gradle', '.cache', '.next', '.nuxt', '.svelte-kit', '.turbo',
  'target', 'dist', 'build', 'out', 'coverage', '.idea', '.vs', '.worktrees',
])

const OUTPUT_DIRS = ['node_modules', '.venv', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage', '.worktrees']

const CODE_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|rb|php|cs|c|cc|cpp|h|hpp|sh|bash|ps1)$/i
const TEXT_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|rb|php|cs|c|cc|cpp|h|hpp|sh|bash|ps1|md|mdx|txt|rst|ya?ml|json|toml|ini|cfg|env)$/i
const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|test_[^/]+\.py$|(?:^|\/)(?:fixtures|preflight)\.[^/]+$/i

const SECRET_FILE_RE = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519|ecdsa))$|\.(?:pem|key|p12|pfx|keystore)$/i
const SAFE_ENV_RE = /^\.env\.(?:example|sample|template|defaults)$/i

const SECRET_PATTERNS = [
  { label: 'GitHub classic token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'PyPI token', re: /\bpypi-[A-Za-z0-9_-]{50,}\b/ },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'API key sk-*', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { label: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,}/ },
]

const BACKUP_FILE_RE = /\.(?:bak|orig|old|tmp)$|~$/i
const REPO_PATH_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|rs|go|java|json|ya?ml|toml|lock|txt|cfg|ini|md)$/i
const TOMBSTONE_COMMENT_RE = /\b(?:used to be|previously (?:was|were|called|used)|migrated from|replaced old|formerly\b|removed in favor of|deprecated since v?\d|changed from\b.{1,30}\bto\b)|(?:以前是|原先是|原本是|之前是|旧版是|后来改成|后来改为|历史兼容保留)/i
const EXCUSE_COMMENT_RE = /@(?:ts-ignore|ts-nocheck)|eslint-disable(?:-next-line|-line)?|\bnoqa\b|type:\s*ignore\b|pragma\s+warning\s+disable|\b(?:hack|workaround)\b/i
const EXCUSE_TEMP_RE = /\bTEMP\b/
const RUST_ALLOW_RE = /^\s*#\[\s*allow\(/
const TEST_SKIP_RE = /\b(?:it|test|describe|context|suite)\.(?:skip|only)\s*\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|@(?:pytest\.mark\.skip|pytest\.mark\.skipif|unittest\.skip)|#\[\s*ignore\b|\bt\.Skip(?:f|Now)?\s*\(/
const TEST_CASE_RE = /\b(?:it|test|describe|context|suite)\s*\(|\bdef\s+test_|#\[\s*test\s*\]|\bfunc\s+Test[A-Z]/
const ASSERTION_RE = /\b(?:assert(?:\.\w+)?|expect|should|t\.(?:Error|Errorf|Fatal|Fatalf)|assertRaises|pytest\.raises|assert_eq!|assert!|strictEqual|deepEqual)\b/

function isMainModule(metaUrl, argv1) {
  if (typeof argv1 !== 'string' || argv1 === '') return false
  const target = fileURLToPath(metaUrl)
  try {
    if (resolve(argv1) === resolve(target)) return true
  } catch { /* fall through */ }
  const real = (p) => {
    try { return realpathSync.native(p) } catch { return undefined }
  }
  const a = real(argv1)
  const b = real(target)
  return a !== undefined && b !== undefined && a === b
}

function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

function readTextStrictInfo(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return undefined
    if (st.size > MAX_READ_BYTES) return { tooLarge: true, size: st.size }
    const buf = readFileSync(filePath)
    const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
    if (buf.subarray(0, 4096).includes(0)) return { binary: true, size: st.size }
    return {
      text: buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n'),
      hasBom,
      size: st.size,
    }
  } catch {
    return undefined
  }
}

function readJsonSafe(filePath) {
  const info = readTextStrictInfo(filePath)
  if (!info?.text) return undefined
  try { return JSON.parse(info.text) } catch { return undefined }
}

function writeAtomic(filePath, content) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, content, 'utf8')
    renameSync(tmp, filePath)
  } finally {
    try { if (existsSync(tmp)) rmSync(tmp, { force: true }) } catch { /* ignore */ }
  }
}

function runCmd(cmd, args, opts = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd: opts.cwd,
      input: opts.input,
      encoding: 'utf8',
      timeout: opts.timeout ?? 20000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        ...opts.env,
      },
    })
    return { ok: true, status: 0, stdout: String(out).replace(/\r\n/g, '\n').trimEnd(), stderr: '' }
  } catch (err) {
    return {
      ok: false,
      status: typeof err?.status === 'number' ? err.status : 1,
      missing: err?.code === 'ENOENT',
      stdout: String(err?.stdout ?? '').replace(/\r\n/g, '\n').trimEnd(),
      stderr: String(err?.stderr ?? err?.message ?? '').replace(/\r\n/g, '\n').trim(),
    }
  }
}

function runGit(cwd, args, opts = {}) {
  return runCmd('git', ['-c', 'core.quotepath=false', ...args], { ...opts, cwd })
}

function resolveRepoRoot(targetDir) {
  const abs = resolve(targetDir)
  const top = runGit(abs, ['rev-parse', '--show-toplevel'])
  if (top.ok && top.stdout.trim()) {
    return { repoRoot: resolve(top.stdout.trim()), isGit: true }
  }
  return { repoRoot: abs, isGit: false }
}

function walkFiles(root, scopeRel = '') {
  const start = scopeRel ? join(root, scopeRel) : root
  const files = []
  const queue = [start]
  while (queue.length > 0) {
    const dir = queue.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(root, full))
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        if (!scopeRel && rel.startsWith('.agents/skills/')) continue
        queue.push(full)
      } else if (entry.isFile()) {
        let size = 0
        try { size = statSync(full).size } catch { /* ignore */ }
        files.push({ full, rel, name: entry.name, size })
      }
    }
  }
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return files
}

function isProfilePlaceholder(val) {
  const s = String(val ?? '').replace(/^`+|`+$/g, '').trim()
  if (!s || /^<!--/.test(s)) return true
  if (/^(?:none|n\/a|无|\(none\)|\(无\)|暂无)$/i.test(s)) return true
  if (/^<[^>\n]+>$/.test(s)) return true
  return false
}

function parseDevProfile(repoRoot) {
  const profile = {
    'quick-test': [],
    'full-test': [],
    'smoke-verify': [],
    'merge-gate': [],
    'arch-rules': [],
    'high-risk': [],
    'do-not-edit': [],
  }
  const info = readTextStrictInfo(join(repoRoot, 'AGENTS.md'))
  if (!info?.text) return profile
  for (const line of info.text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?`?(quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit)`?\s*:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1]
    const val = m[2].replace(/^`+|`+$/g, '').trim()
    if (isProfilePlaceholder(val)) continue
    if (key === 'arch-rules' && /^<[^>\n]+>\s*(?:->|→)\s*<[^>\n]+>$/.test(val)) continue
    if (key === 'high-risk' || key === 'do-not-edit' || key === 'arch-rules') {
      const items = val
        .split(/[,，]/)
        .map((s) => s.trim().replace(/^`+|`+$/g, ''))
        .filter((s) => !isProfilePlaceholder(s) && !(key === 'arch-rules' && /^<[^>\n]+>\s*(?:->|→)\s*<[^>\n]+>$/.test(s)))
      profile[key].push(...items)
    } else {
      profile[key].push(val)
    }
  }
  return profile
}

function addFinding(findings, item) {
  findings.push({
    id: item.id,
    category: item.category,
    severity: item.severity,
    file: item.file ?? '',
    line: item.line ?? undefined,
    title: item.title,
    detail: item.detail ?? '',
    action: item.action ?? '',
  })
}

function resolveGovernStateDir(repoRoot, isGit) {
  if (isGit) {
    const res = runGit(repoRoot, ['rev-parse', '--git-common-dir'])
    if (res.ok && res.stdout.trim()) {
      return join(resolve(repoRoot, res.stdout.trim()), 'project-forge-govern')
    }
    return join(repoRoot, '.git', 'project-forge-govern')
  }
  const hash = createHash('sha256').update(resolve(repoRoot)).digest('hex').slice(0, 12)
  return join(tmpdir(), 'project-forge-govern', hash)
}

function extractLineCommentInfo(line, inBlock = false) {
  const s = String(line ?? '')
  const commentParts = []
  let i = 0
  let block = inBlock
  let quote = ''
  let prevSig = ''
  let onlyComment = true

  if (block) {
    const end = s.indexOf('*/')
    if (end === -1) return { commentText: s.trim(), nextInBlock: true, pureSingleLine: false }
    commentParts.push(s.slice(0, end))
    block = false
    i = end + 2
    onlyComment = false
  }

  let pureSingleLine = false
  while (i < s.length) {
    const ch = s[i]
    const next = s[i + 1]
    if (quote) {
      onlyComment = false
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) quote = ''
      i += 1
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      onlyComment = false
      quote = ch
      prevSig = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      if (!prevSig && next === '/' && s[i + 2] !== '/') pureSingleLine = true
      commentParts.push(s.slice(i + 2))
      break
    }
    if (ch === '/' && next === '*') {
      onlyComment = false
      const end = s.indexOf('*/', i + 2)
      if (end === -1) {
        commentParts.push(s.slice(i + 2))
        block = true
        break
      }
      commentParts.push(s.slice(i + 2, end))
      i = end + 2
      continue
    }
    if (ch === '/') {
      const canRegex = !prevSig || '=(:,?[!&|;{}~^+-*'.includes(prevSig)
        || /\b(?:return|case|throw|typeof|await|yield)$/.test(s.slice(0, i).trimEnd())
      if (canRegex) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < s.length) {
          const rc = s[j]
          if (rc === '\\') { j += 2; continue }
          if (rc === '[') inClass = true
          else if (rc === ']' && inClass) inClass = false
          else if (rc === '/' && !inClass) { closed = true; break }
          j += 1
        }
        if (closed) {
          onlyComment = false
          prevSig = '/'
          i = j + 1
          continue
        }
      }
    }
    if (ch === '#') {
      const prevCh = i > 0 ? s[i - 1] : ''
      if ((i === 0 || /\s/.test(prevCh)) && next !== '!' && next !== '[') {
        if (!prevSig && onlyComment) pureSingleLine = true
        commentParts.push(s.slice(i + 1))
        break
      }
    }
    if (!/\s/.test(ch)) {
      prevSig = ch
      onlyComment = false
    }
    i += 1
  }

  return { commentText: commentParts.join(' ').trim(), nextInBlock: block, pureSingleLine }
}

function looksLikeCommentedCode(body) {
  const t = String(body ?? '').trim()
  if (!t || t.startsWith('@') || /^[-=*#]{3,}$/.test(t)) return false
  if (/[{};]\s*$/.test(t)) return true
  if (/^(?:const|let|var|function|async\s+function|class|if|else\s+if|for|while|switch|return|import|export|def|async\s+def|try|except|finally|fn|pub\s+fn|func)\b/.test(t)) return true
  if (/^[A-Za-z_][A-Za-z0-9_.]*\s*(?:=|:=|\([^)]*\)\s*(?:=>|\{|$))/.test(t)) return true
  if (/^\s*[})\]]+\s*[,;]?\s*$/.test(t)) return true
  return false
}

function globToRegExp(rawGlob) {
  const g = posixPath(rawGlob).trim().replace(/^`+|`+$/g, '').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!g) return null
  if (g.endsWith('/**') && !g.slice(0, -3).includes('*') && !g.slice(0, -3).includes('?')) {
    const base = g.slice(0, -3).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`^${base}(?:/.*)?$`)
  }
  const hasWild = /[*?]/.test(g)
  let expr = ''
  for (let i = 0; i < g.length; i += 1) {
    const ch = g[i]
    if (ch === '*') {
      if (g[i + 1] === '*') {
        if (g[i + 2] === '/') { expr += '(?:.+/)?'; i += 2 }
        else { expr += '.*'; i += 1 }
      } else {
        expr += '[^/]*'
      }
    } else if (ch === '?') {
      expr += '[^/]'
    } else {
      expr += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  if (!hasWild) expr = `${expr}(?:/.*)?`
  return new RegExp(`^${expr}$`)
}

function parseArchRules(ruleList) {
  const parsed = []
  for (const raw of ruleList ?? []) {
    const m = /^(.+?)\s*(?:->|→)\s*(.+)$/.exec(String(raw ?? '').trim())
    if (!m) continue
    const fromGlob = m[1].trim()
    const toGlob = m[2].trim()
    if (isProfilePlaceholder(fromGlob) || isProfilePlaceholder(toGlob)) continue
    const fromRe = globToRegExp(fromGlob)
    const toRe = globToRegExp(toGlob)
    if (fromRe && toRe) parsed.push({ raw: `${fromGlob} -> ${toGlob}`, fromGlob, toGlob, fromRe, toRe })
  }
  return parsed
}

function extractImportsFromCode(relFile, text) {
  const ext = posixPath(relFile).split('.').pop()?.toLowerCase() ?? ''
  const imports = []
  const lines = text.split('\n')

  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)) {
    let inBlock = false
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const trimmed = line.trim()
      if (inBlock) { if (trimmed.includes('*/')) inBlock = false; continue }
      if (trimmed.startsWith('/*') && !trimmed.includes('*/')) { inBlock = true; continue }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue
      for (const re of [
        /(?:^|\b)(?:import|export)\s+(?:[^'"\n]*?\bfrom\s+)?['"]([^'"\n]+)['"]/g,
        /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
        /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      ]) {
        for (const m of line.matchAll(re)) imports.push({ line: i + 1, specifier: m[1], kind: 'js' })
      }
    }
  } else if (ext === 'py') {
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const fm = /^from\s+(\.{0,3}[A-Za-z0-9_.]*)\s+import\b/.exec(trimmed)
      if (fm) { imports.push({ line: i + 1, specifier: fm[1], kind: 'py' }); continue }
      const im = /^import\s+([A-Za-z0-9_.]+(?:\s*,\s*[A-Za-z0-9_.]+)*)/.exec(trimmed)
      if (im) {
        for (const part of im[1].split(',')) {
          const mod = part.trim().split(/\s+/)[0]
          if (mod) imports.push({ line: i + 1, specifier: mod, kind: 'py' })
        }
      }
    }
  } else if (ext === 'go') {
    let inImportBlock = false
    for (let i = 0; i < lines.length; i += 1) {
      const trimmed = lines[i].trim()
      if (!trimmed || trimmed.startsWith('//')) continue
      if (/^import\s*\(/.test(trimmed)) { inImportBlock = true; continue }
      if (inImportBlock) {
        if (trimmed.startsWith(')')) { inImportBlock = false; continue }
        const gm = /"([^"]+)"/.exec(trimmed)
        if (gm) imports.push({ line: i + 1, specifier: gm[1], kind: 'go' })
        continue
      }
      const sm = /^import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+|_\s+|\.\s+)?"([^"]+)"/.exec(trimmed)
      if (sm) imports.push({ line: i + 1, specifier: sm[1], kind: 'go' })
    }
  }
  return imports
}

function resolveImportCandidates(fromFile, specifier, kind, repoRoot = null) {
  const fromDir = posix.dirname(posixPath(fromFile))
  const cands = new Set()
  const addWithExts = (base) => {
    const norm = posix.normalize(base).replace(/^\.\//, '')
    cands.add(norm)
    for (const ext of ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py']) cands.add(`${norm}${ext}`)
    for (const idx of ['index.mjs', 'index.js', 'index.ts', 'index.tsx', '__init__.py']) cands.add(posix.join(norm, idx))
  }
  const ancestorPrefixes = () => {
    const parts = fromDir === '.' ? [] : fromDir.split('/').filter(Boolean)
    const out = []
    for (let k = 1; k < parts.length; k += 1) out.push(parts.slice(0, k).join('/'))
    return out
  }
  const addAnchoredVariants = (sub, withExts = true) => {
    if (!repoRoot || !sub || sub.includes(':')) return
    const firstSeg = sub.split('/')[0]
    if (!firstSeg || firstSeg === '.' || firstSeg === '..') return
    for (const anc of ancestorPrefixes()) {
      const probeBase = join(repoRoot, anc, firstSeg)
      const existsInRepo = existsSync(probeBase)
        || ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.jsx', '.py'].some((ext) => existsSync(`${probeBase}${ext}`))
      if (existsInRepo) {
        const joined = posix.join(anc, sub)
        if (withExts) addWithExts(joined)
        else cands.add(joined)
      }
    }
  }
  if (kind === 'py') {
    const dotLead = /^(\.+)(.*)$/.exec(specifier)
    if (dotLead) {
      const ups = dotLead[1].length - 1
      let baseDir = fromDir === '.' ? '' : fromDir
      for (let u = 0; u < ups; u += 1) baseDir = posix.dirname(baseDir)
      const rest = dotLead[2].replace(/\./g, '/')
      addWithExts(baseDir && baseDir !== '.' ? (rest ? posix.join(baseDir, rest) : baseDir) : rest)
    } else {
      const specPath = specifier.replace(/\./g, '/')
      addWithExts(specPath)
      addAnchoredVariants(specPath, true)
    }
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    addWithExts(posix.join(fromDir === '.' ? '' : fromDir, specifier))
  } else if (specifier.startsWith('/')) {
    addWithExts(specifier.slice(1))
  } else {
    const clean = specifier.replace(/^(?:@\/|~\/)/, '')
    addWithExts(clean)
    addAnchoredVariants(clean, true)
    if (kind === 'go') {
      const parts = clean.split('/')
      for (let k = 1; k < parts.length; k += 1) {
        const sub = parts.slice(k).join('/')
        cands.add(sub)
        addAnchoredVariants(sub, false)
      }
    }
  }
  return [...cands]
}

function evaluateArchRules(repoRoot, fileRelList, rawRules) {
  const rules = parseArchRules(rawRules)
  if (rules.length === 0) return []
  const violations = []
  for (const rel of fileRelList) {
    const relPosix = posixPath(rel)
    const matching = rules.filter((r) => r.fromRe.test(relPosix))
    if (matching.length === 0) continue
    const info = readTextStrictInfo(join(repoRoot, relPosix))
    if (!info?.text) continue
    const lines = info.text.split('\n')
    for (const imp of extractImportsFromCode(relPosix, info.text)) {
      const cands = resolveImportCandidates(relPosix, imp.specifier, imp.kind, repoRoot)
      for (const rule of matching) {
        const hitTarget = cands.find((c) => rule.toRe.test(c))
        if (hitTarget) {
          violations.push({
            file: relPosix,
            line: imp.line,
            rule: rule.raw,
            specifier: imp.specifier,
            resolvedTarget: hitTarget,
            lineText: (lines[imp.line - 1] ?? '').trim().slice(0, 120),
            fixHint: `Root-cause fix: invert dependency via shared interface/port outside "${rule.toGlob}" instead of bypassing "${rule.raw}".`,
          })
        }
      }
    }
  }
  return violations
}

function auditSecurity(repoRoot, files, trackedSet, findings) {
  for (const f of files) {
    if (SECRET_FILE_RE.test(f.name) && !SAFE_ENV_RE.test(f.name)) {
      const tracked = trackedSet.has(f.rel)
      addFinding(findings, {
        id: `sec.secret-file.${f.rel}`,
        category: 'security',
        severity: tracked ? 'critical' : 'high',
        file: f.rel,
        title: `${tracked ? 'Tracked' : 'Present'} sensitive credential file: ${f.rel}`,
        detail: tracked ? 'File is tracked by git history.' : 'Sensitive file exists on disk; verify it is ignored.',
        action: tracked ? 'Rotate credential, remove from git tracking, and add pattern to .gitignore.' : 'Verify .gitignore covers this pattern.',
      })
    }

    if (!TEXT_EXT_RE.test(f.name) && !f.name.startsWith('.env')) continue
    if (SAFE_ENV_RE.test(f.name)) continue
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue

    const lines = info.text.split('\n')
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]
      for (const pat of SECRET_PATTERNS) {
        if (pat.re.test(line)) {
          addFinding(findings, {
            id: `sec.token.${f.rel}:${idx + 1}`,
            category: 'security',
            severity: trackedSet.has(f.rel) ? 'critical' : 'high',
            file: f.rel,
            line: idx + 1,
            title: `Possible ${pat.label} in ${f.rel}:${idx + 1}`,
            detail: 'Secret-like literal detected (value redacted).',
            action: 'Rotate secret and load via environment variables or credential manager.',
          })
          break
        }
      }
      if (CODE_EXT_RE.test(f.name) && !TEST_FILE_RE.test(f.rel)) {
        if (/\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]/.test(line)) {
          addFinding(findings, {
            id: `sec.tls-disabled.${f.rel}:${idx + 1}`,
            category: 'security',
            severity: 'high',
            file: f.rel,
            line: idx + 1,
            title: `TLS verification disabled in ${f.rel}:${idx + 1}`,
            action: 'Remove NODE_TLS_REJECT_UNAUTHORIZED=0 and configure proper CA trust.',
          })
        } else if (/\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/.test(line) || /\bnew\s+Function\s*\(/.test(line)) {
          addFinding(findings, {
            id: `sec.dynamic-exec.${f.rel}:${idx + 1}`,
            category: 'security',
            severity: 'medium',
            file: f.rel,
            line: idx + 1,
            title: `Dynamic shell/code execution in ${f.rel}:${idx + 1}`,
            detail: 'Interpolated shell command or dynamic Function constructor.',
            action: 'Use execFile/execFileSync with argument array instead of shell interpolation.',
          })
        }
      }
    }

    if (f.rel.startsWith('.github/workflows/') && /\.ya?ml$/i.test(f.name)) {
      if (/pull_request_target\b/.test(info.text) && /github\.event\.pull_request\.head/.test(info.text)) {
        addFinding(findings, {
          id: `sec.workflow-pr-target.${f.rel}`,
          category: 'security',
          severity: 'critical',
          file: f.rel,
          title: `Privileged pull_request_target checks out untrusted PR head in ${f.rel}`,
          action: 'Switch to pull_request or isolate untrusted code without write/secret permissions.',
        })
      }
    }
  }
}

function auditDeadcode(files, findings) {
  for (const f of files) {
    if (BACKUP_FILE_RE.test(f.name)) {
      addFinding(findings, {
        id: `dead.backup.${f.rel}`,
        category: 'deadcode',
        severity: 'low',
        file: f.rel,
        title: `Backup/temp artifact in workspace: ${f.rel}`,
        action: 'Review and remove obsolete backup file.',
      })
    }
    if (f.size === 0 && f.name !== '.gitkeep' && f.name !== '__init__.py') {
      addFinding(findings, {
        id: `dead.empty.${f.rel}`,
        category: 'deadcode',
        severity: 'low',
        file: f.rel,
        title: `Empty 0-byte file: ${f.rel}`,
        action: 'Populate or delete empty file.',
      })
    }
    if (!CODE_EXT_RE.test(f.name)) continue
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const lines = info.text.split('\n')
    let todoCount = 0
    let inBlock = false
    let commentRun = []

    const flushCommentRun = () => {
      if (commentRun.length >= 4) {
        const startLine = commentRun[0].line
        if (startLine > 12 || !commentRun.some((c) => /copyright|license|spdx/i.test(c.body))) {
          const codeLines = commentRun.filter((c) => looksLikeCommentedCode(c.body)).length
          if (codeLines >= 3) {
            addFinding(findings, {
              id: `deadcode.commented-block.${f.rel}:${startLine}`,
              category: 'deadcode',
              severity: 'medium',
              file: f.rel,
              line: startLine,
              title: `Commented-out dead code block (${commentRun.length} lines) at ${f.rel}:${startLine}`,
              detail: commentRun[0].body.slice(0, 100),
              action: 'Delete commented-out code (rely on git history instead of leaving dead blocks).',
            })
          }
        }
      }
      commentRun = []
    }

    for (let i = 0; i < lines.length; i += 1) {
      const { commentText, nextInBlock, pureSingleLine } = extractLineCommentInfo(lines[i], inBlock)
      inBlock = nextInBlock

      if (pureSingleLine && commentText) {
        commentRun.push({ line: i + 1, body: commentText })
      } else {
        flushCommentRun()
      }

      if (commentText && /\b(?:TODO|FIXME|HACK|XXX)\b/.test(commentText)) {
        todoCount += 1
        if (todoCount <= 3) {
          addFinding(findings, {
            id: `dead.marker.${f.rel}:${i + 1}`,
            category: 'deadcode',
            severity: 'info',
            file: f.rel,
            line: i + 1,
            title: `Deferred code marker at ${f.rel}:${i + 1}`,
            detail: lines[i].trim().slice(0, 100),
            action: 'Resolve or convert into a tracked task/issue.',
          })
        }
      }
    }
    flushCommentRun()
  }
}

function parseWorkflowCiSteps(repoRoot) {
  const wfDir = join(repoRoot, '.github', 'workflows')
  if (!existsSync(wfDir)) return []
  const steps = []
  let names = []
  try { names = readdirSync(wfDir).filter((n) => /\.ya?ml$/i.test(n)).sort() } catch { return [] }
  for (const name of names) {
    const info = readTextStrictInfo(join(wfDir, name))
    if (!info?.text) continue
    const lines = info.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(lines[i])
      if (!m) continue
      const baseIndent = m[1].length + (lines[i].includes('- run:') ? 2 : 0)
      const tail = m[2].trim()
      if (!tail || /^[|>][+-]?$/.test(tail)) {
        const blockLines = []
        let blockIndent = null
        for (let j = i + 1; j < lines.length; j += 1) {
          const raw = lines[j]
          if (!raw.trim()) { blockLines.push(''); continue }
          const curIndent = /^(\s*)/.exec(raw)[1].length
          if (blockIndent === null) {
            if (curIndent <= baseIndent) break
            blockIndent = curIndent
          } else if (curIndent < blockIndent) {
            break
          }
          blockLines.push(raw.slice(blockIndent))
          i = j
        }
        const cmd = blockLines.join('\n').trim()
        if (cmd) steps.push({ file: `.github/workflows/${name}`, cmd })
      } else {
        const clean = tail.replace(/\s+#.*$/, '').trim()
        if (clean) steps.push({ file: `.github/workflows/${name}`, cmd: clean })
      }
    }
  }
  return steps
}

function expandVerificationCommands(repoRoot, ciSteps, devProfile) {
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  const scripts = (pkg && typeof pkg.scripts === 'object' && pkg.scripts) ? pkg.scripts : {}
  const seeds = [
    ...ciSteps.map((s) => s.cmd),
    ...(devProfile['quick-test'] ?? []),
    ...(devProfile['full-test'] ?? []),
    ...(devProfile['smoke-verify'] ?? []),
    ...(devProfile['merge-gate'] ?? []),
  ]
  const expanded = []
  const visitedScripts = new Set()

  const visitCmd = (rawCmd, depth) => {
    for (const part of String(rawCmd ?? '').split(/\n|&&|\|\||;/)) {
      const clean = part.trim()
      if (!clean) continue
      const pkgSingle = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s+--.*)?$/.exec(clean)
      let expandedPureScript = false
      if (depth < 3) {
        const pkgRuns = [
          /\bnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/g,
          /\bpnpm\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/g,
          /\byarn\s+(?:run\s+)?([A-Za-z0-9:_-]+)\b/g,
          /\bbun\s+run\s+([A-Za-z0-9:_-]+)\b/g,
        ]
        for (const re of pkgRuns) {
          for (const m of clean.matchAll(re)) {
            const sName = m[1]
            if (sName && scripts[sName]) {
              if (pkgSingle && pkgSingle[1] === sName) expandedPureScript = true
              if (!visitedScripts.has(sName)) {
                visitedScripts.add(sName)
                visitCmd(scripts[sName], depth + 1)
              }
            }
          }
        }
      }
      if (!expandedPureScript) expanded.push(clean)
    }
  }

  for (const s of seeds) visitCmd(s, 0)
  return expanded
}

function cmdCoversTestFile(commands, testRel) {
  const rel = posixPath(testRel)
  const base = posix.basename(rel)
  const dir = posix.dirname(rel)
  const dirParts = dir === '.' ? [] : dir.split('/').filter(Boolean)
  const ancestorDirs = dirParts.map((_, idx) => dirParts.slice(0, idx + 1).join('/'))
  const ext = base.split('.').pop()?.toLowerCase() ?? ''
  const isJsLike = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)
  const isPy = ext === 'py'
  const isGo = ext === 'go'
  const isRust = ext === 'rs'

  for (const rawCmd of commands) {
    const cmd = posixPath(rawCmd)
    if (cmd.includes(rel)) return true
    if (new RegExp(`(?:^|[\\s/"'=])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s"'])`).test(cmd)) return true
    const cmdNoSubcmd = cmd.replace(/\b(?:npm|pnpm|yarn|bun|go|cargo|deno)\s+(?:run\s+)?test\b/g, '')
    for (const d of ancestorDirs) {
      if (new RegExp(`(?:^|[\\s"'=])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/?(?:$|[\\s*?"'&|;]))`).test(cmdNoSubcmd)) return true
    }

    if (isJsLike) {
      if (/\bnode\s+--test\b/.test(cmd) && !/\.(?:m?js|cjs|ts)\b/.test(cmd.replace(/.*?\bnode\s+--test\b/, ''))) return true
      if (/\b(?:vitest|jest|mocha|ava|tap)\b/.test(cmd) && !/\.(?:m?js|cjs|tsx?|jsx?)\b/.test(cmd)) return true
    }
    if (isPy && /\b(?:pytest|python3?\s+-m\s+(?:pytest|unittest))\b/.test(cmd) && !/\.py\b/.test(cmd)) return true
    if (isGo && /\bgo\s+test\b/.test(cmd) && (/\.\/\.\.\./.test(cmd) || cmd.includes(`./${dir}`))) return true
    if (isRust && /\bcargo\s+test\b/.test(cmd)) return true
  }
  return false
}

function auditTests(repoRoot, files, devProfile, findings) {
  const codeFiles = files.filter((f) => CODE_EXT_RE.test(f.name) && !TEST_FILE_RE.test(f.rel))
  const testFiles = files.filter((f) => CODE_EXT_RE.test(f.name) && TEST_FILE_RE.test(f.rel))

  if (codeFiles.length > 0 && testFiles.length === 0) {
    addFinding(findings, {
      id: 'tests.missing-suite',
      category: 'tests',
      severity: 'medium',
      title: `Found ${codeFiles.length} code file(s) but no test files in scope`,
      action: 'Add unit or smoke tests covering core behavior and failure cases.',
    })
  }

  const ciSteps = parseWorkflowCiSteps(repoRoot)
  const hasProfileRunners = (devProfile['quick-test']?.length ?? 0) > 0
    || (devProfile['full-test']?.length ?? 0) > 0
    || (devProfile['smoke-verify']?.length ?? 0) > 0
    || (devProfile['merge-gate']?.length ?? 0) > 0
  const hasRunnerConfig = ciSteps.length > 0 || hasProfileRunners
  const expandedCommands = hasRunnerConfig ? expandVerificationCommands(repoRoot, ciSteps, devProfile) : []

  for (const f of testFiles) {
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const lines = info.text.split('\n')
    let skipCount = 0
    let testDeclCount = 0

    for (let i = 0; i < lines.length; i += 1) {
      if (TEST_CASE_RE.test(lines[i])) testDeclCount += 1
      if (TEST_SKIP_RE.test(lines[i])) {
        skipCount += 1
        addFinding(findings, {
          id: `tests.skip.${f.rel}:${i + 1}`,
          category: 'tests',
          severity: 'medium',
          file: f.rel,
          line: i + 1,
          title: `Skipped or focused test marker in ${f.rel}:${i + 1}`,
          detail: lines[i].trim().slice(0, 100),
          action: 'Re-enable test or remove .only/.skip before merge.',
        })
      }
    }

    if (skipCount > 0 && testDeclCount <= skipCount) {
      addFinding(findings, {
        id: `tests.all-skipped.${f.rel}`,
        category: 'tests',
        severity: 'high',
        file: f.rel,
        title: `All tests skipped in ${f.rel} (${skipCount} skipped, 0 active)`,
        action: 'Restore assertions/tests or delete obsolete skipped suite instead of carrying green-looking dead tests.',
      })
    }

    const isExplicitTestFile = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|^test_[^/]+\.py$/i.test(f.name) || testDeclCount > 0
    if (isExplicitTestFile && !ASSERTION_RE.test(info.text)) {
      addFinding(findings, {
        id: `tests.zero-assertion.${f.rel}`,
        category: 'tests',
        severity: 'medium',
        file: f.rel,
        title: `Zero-assertion test file: ${f.rel}`,
        action: 'Add real behavioral assertions (expect/assert) so failures cannot silently pass.',
      })
    }

    if (hasRunnerConfig && isExplicitTestFile && !cmdCoversTestFile(expandedCommands, f.rel)) {
      addFinding(findings, {
        id: `tests.orphan-suite.${f.rel}`,
        category: 'tests',
        severity: 'medium',
        file: f.rel,
        title: `Orphan test suite not covered by CI (.github/workflows) or Dev Profile: ${f.rel}`,
        action: `Wire "${f.rel}" into CI workflow steps or AGENTS.md quick-test/full-test/merge-gate.`,
      })
    }
  }

  if (existsSync(join(repoRoot, 'AGENTS.md')) && devProfile['quick-test'].length === 0 && devProfile['full-test'].length === 0) {
    addFinding(findings, {
      id: 'tests.no-dev-profile',
      category: 'tests',
      severity: 'low',
      file: 'AGENTS.md',
      title: 'AGENTS.md has no quick-test: or full-test: Dev Profile commands',
      action: 'Populate quick-test: / full-test: keys in AGENTS.md so automated workflows can run verification.',
    })
  }

  return { ciRunSteps: ciSteps }
}

function checkAgentsPathsAndRefs(repoRoot, agentsText, devProfile, defaultBranch, findings) {
  const paths = new Set()
  const branches = new Set()

  const extractRepoPath = (token) => {
    const raw = String(token ?? '').trim().replace(/^['"]|['"]$/g, '')
    if (!raw || !raw.includes('/')) return undefined
    if (/^(?:https?:|mailto:|\/|[A-Za-z]:[\\/]|<.*>$)/.test(raw)) return undefined
    if (/[<>*?]/.test(raw) || raw.endsWith('/')) return undefined
    if (!REPO_PATH_EXT_RE.test(raw)) return undefined
    return raw
  }

  for (const m of agentsText.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim()
    for (const word of tok.split(/\s+/)) {
      const p = extractRepoPath(word)
      if (p) paths.add(p)
    }
    for (const bm of tok.matchAll(/\bgit\s+(?:switch|checkout)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)/g)) {
      branches.add(bm[1])
    }
  }

  for (const block of agentsText.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const clean = line.replace(/\s+#.*$/, '').trim()
      if (!clean || clean.startsWith('#')) continue
      for (const bm of clean.matchAll(/\bgit\s+(?:switch|checkout)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)/g)) {
        branches.add(bm[1])
      }
      for (const word of clean.split(/\s+/)) {
        const p = extractRepoPath(word)
        if (p) paths.add(p)
      }
    }
  }

  for (const p of [...paths].sort()) {
    if (!existsSync(join(repoRoot, p))) {
      addFinding(findings, {
        id: `docs.agents-stale-path.${p}`,
        category: 'docs',
        severity: 'high',
        file: 'AGENTS.md',
        title: `Stale path in AGENTS.md: ${p} does not exist`,
        action: `Update or remove "${p}" in AGENTS.md.`,
      })
    }
  }

  if (defaultBranch) {
    for (const b of [...branches].sort()) {
      if (b !== defaultBranch && b !== 'HEAD') {
        addFinding(findings, {
          id: `docs.agents-stale-branch.${b}`,
          category: 'docs',
          severity: 'medium',
          file: 'AGENTS.md',
          title: `AGENTS.md references branch "${b}" instead of default branch "${defaultBranch}"`,
          action: `Align branch references in AGENTS.md to "${defaultBranch}".`,
        })
      }
    }
  }

  for (const cmdKey of ['quick-test', 'full-test', 'smoke-verify', 'merge-gate']) {
    for (const cmd of devProfile[cmdKey]) {
      for (const word of cmd.split(/\s+/)) {
        const p = extractRepoPath(word)
        if (p && !existsSync(join(repoRoot, p))) {
          addFinding(findings, {
            id: `docs.devprofile-missing-script.${cmdKey}.${p}`,
            category: 'docs',
            severity: 'high',
            file: 'AGENTS.md',
            title: `Dev Profile "${cmdKey}" points to missing file "${p}"`,
            action: `Fix ${cmdKey}: command in AGENTS.md.`,
          })
        }
      }
    }
  }
}

function discoverCodeModules(repoRoot) {
  const modules = []
  const containerRoots = ['src', 'lib', 'scripts', 'packages', 'app', 'cmd', 'internal', 'pkg', 'kit/skills']
  for (const cr of containerRoots) {
    const abs = join(repoRoot, cr)
    if (!existsSync(abs)) continue
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (entry.name === 'dev' || SKIP_DIRS.has(entry.name)) continue
        modules.push({ name: entry.name, path: `${cr}/${entry.name}` })
      } else if (entry.isFile() && CODE_EXT_RE.test(entry.name)) {
        modules.push({ name: entry.name, path: `${cr}/${entry.name}` })
      }
    }
  }
  return modules
}

function decodeUriSafe(raw) {
  try { return decodeURIComponent(raw) } catch { return raw }
}

function checkMarkdownDeadLinks(repoRoot, files, findings) {
  for (const f of files) {
    if (!/\.mdx?$/i.test(f.name)) continue
    if (f.rel.startsWith('templates/')) continue
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const lines = info.text.split('\n')
    let fenceChar = ''
    let fenceLen = 0
    let perFileCount = 0

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const fm = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fm) {
        const ch = fm[1][0]
        const len = fm[1].length
        if (!fenceChar) { fenceChar = ch; fenceLen = len }
        else if (fenceChar === ch && len >= fenceLen) { fenceChar = ''; fenceLen = 0 }
        continue
      }
      if (fenceChar) continue

      const stripped = line.replace(/`+[^`\n]*`+/g, '')
      const candidates = []
      for (const m of stripped.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) {
        candidates.push(m[1])
      }
      const refM = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(stripped)
      if (refM) candidates.push(refM[1])

      for (const raw of candidates) {
        const noTitle = raw.trim().replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim()
        if (!noTitle || noTitle.startsWith('#')) continue
        if (/^(?:https?:|mailto:|tel:|data:|javascript:|file:)/i.test(noTitle)) continue
        if (/[<>\{\}*?]/.test(noTitle)) continue
        const clean = noTitle.split(/[?#]/)[0].trim()
        if (!clean) continue
        const decoded = decodeUriSafe(clean)
        const targetAbs = decoded.startsWith('/')
          ? join(repoRoot, decoded.slice(1))
          : resolve(dirname(f.full), decoded)
        if (!existsSync(targetAbs)) {
          perFileCount += 1
          if (perFileCount <= 15) {
            addFinding(findings, {
              id: `docs.dead-link.${f.rel}:${i + 1}.${clean}`,
              category: 'docs',
              severity: 'medium',
              file: f.rel,
              line: i + 1,
              title: `Broken relative Markdown link in ${f.rel}:${i + 1} -> "${clean}"`,
              action: `Fix or remove broken link "${clean}" in ${f.rel}.`,
            })
          }
        }
      }
    }
  }
}

function checkDocChurnStaleness(repoRoot, isGit, scopeRel, findings) {
  if (!isGit || !runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']).ok) return
  const logRes = runGit(repoRoot, ['log', '-n', '80', '--name-only', '--format=__COMMIT__%ct'])
  if (!logRes.ok || !logRes.stdout) return

  const commits = []
  let cur = null
  for (const line of logRes.stdout.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      if (cur) commits.push(cur)
      cur = { ts: Number(line.slice(10)) || 0, files: [] }
    } else if (cur && line.trim()) {
      const clean = posixPath(line.trim())
      if (!clean.startsWith('.worktrees/')) cur.files.push(clean)
    }
  }
  if (cur) commits.push(cur)
  if (commits.length < 8) return

  const hasTdd = existsSync(join(repoRoot, 'docs', 'TDD.md'))
  const targetDoc = hasTdd ? 'docs/TDD.md' : existsSync(join(repoRoot, 'README.md')) ? 'README.md' : ''
  if (!targetDoc) return

  const isDocUpdate = (rel, codeDir) => {
    if (rel === 'AGENTS.md' || rel === 'docs/TDD.md' || rel === 'README.md' || rel === 'README.en.md') return true
    if (codeDir && rel === `${codeDir}/AGENTS.md`) return true
    if (rel.startsWith('docs/') && rel.endsWith('.md') && !rel.startsWith('docs/todo/') && !rel.startsWith('docs/archive/')) return true
    return false
  }

  const codeDirKey = (rel) => {
    const parts = rel.split('/')
    if (parts.length <= 1) return ''
    return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]
  }

  const dirChurn = new Map()
  for (const c of commits) {
    const seenDirs = new Set()
    for (const rel of c.files) {
      if (!CODE_EXT_RE.test(rel) || TEST_FILE_RE.test(rel)) continue
      if (scopeRel && rel !== scopeRel && !rel.startsWith(`${scopeRel}/`)) continue
      const d = codeDirKey(rel)
      if (!d || seenDirs.has(d)) continue
      seenDirs.add(d)
      if (!dirChurn.has(d)) dirChurn.set(d, { total: 0, sinceDoc: 0, docTouched: false })
      dirChurn.get(d).total += 1
    }
  }

  for (const [dir, stats] of dirChurn.entries()) {
    for (const c of commits) {
      if (c.files.some((rel) => isDocUpdate(rel, dir))) {
        stats.docTouched = true
        break
      }
      if (c.files.some((rel) => CODE_EXT_RE.test(rel) && !TEST_FILE_RE.test(rel) && codeDirKey(rel) === dir)) {
        stats.sinceDoc += 1
      }
    }
    if (stats.sinceDoc >= 8) {
      addFinding(findings, {
        id: `docs.stale-vs-churn.${dir}`,
        category: 'docs',
        severity: 'medium',
        file: targetDoc,
        title: `Doc staleness vs git churn: "${dir}/" has ${stats.sinceDoc} commit(s) in last 80 without "${targetDoc}"/doc update`,
        action: `Review recent changes in "${dir}/" and sync "${targetDoc}" / AGENTS.md if architecture or interfaces changed.`,
      })
    }
  }
}

function auditDocs(repoRoot, isGit, files, devProfile, defaultBranch, scopeRel, findings) {
  const hasCode = files.some((f) => CODE_EXT_RE.test(f.name))
  if (!existsSync(join(repoRoot, 'README.md'))) {
    addFinding(findings, {
      id: 'docs.missing-readme',
      category: 'docs',
      severity: 'high',
      title: 'Missing README.md',
      action: 'Create README.md with project purpose, setup, and usage commands.',
    })
  }

  const agentsPath = join(repoRoot, 'AGENTS.md')
  const agentsInfo = readTextStrictInfo(agentsPath)
  if (!agentsInfo?.text) {
    addFinding(findings, {
      id: 'docs.missing-agents',
      category: 'docs',
      severity: hasCode ? 'medium' : 'low',
      title: 'Missing AGENTS.md contract',
      action: 'Create AGENTS.md with Dev Profile and repository invariants.',
    })
  } else {
    const bytes = Buffer.byteLength(agentsInfo.text, 'utf8')
    if (bytes > AGENTS_MAX_BYTES) {
      addFinding(findings, {
        id: 'docs.agents-over-30kb',
        category: 'docs',
        severity: 'critical',
        file: 'AGENTS.md',
        title: `AGENTS.md is ${bytes} bytes (> ${AGENTS_MAX_BYTES} byte hard cap)`,
        action: 'Prune redundant prose or move subdirectory-specific rules to <subdir>/AGENTS.md.',
      })
    } else if (bytes > AGENTS_WARN_BYTES) {
      addFinding(findings, {
        id: 'docs.agents-near-24kb',
        category: 'docs',
        severity: 'medium',
        file: 'AGENTS.md',
        title: `AGENTS.md is ${bytes} bytes (approaching ${AGENTS_MAX_BYTES} byte cap; warn >= ${AGENTS_WARN_BYTES})`,
        action: 'Keep AGENTS.md compact by trimming obsolete notes and linking to docs/TDD.md.',
      })
    }
    checkAgentsPathsAndRefs(repoRoot, agentsInfo.text, devProfile, defaultBranch, findings)
  }

  const tddPath = join(repoRoot, 'docs', 'TDD.md')
  const tddInfo = readTextStrictInfo(tddPath)
  if (hasCode && !tddInfo?.text) {
    addFinding(findings, {
      id: 'docs.missing-tdd',
      category: 'docs',
      severity: 'medium',
      file: 'docs/TDD.md',
      title: 'Missing docs/TDD.md technical architecture authority',
      action: 'Create docs/TDD.md documenting modules, data flows, and invariants.',
    })
  } else if (tddInfo?.text) {
    const allMods = discoverCodeModules(repoRoot)
    const mods = scopeRel
      ? allMods.filter((m) => m.path === scopeRel || m.path.startsWith(`${scopeRel}/`))
      : allMods
    const undocumented = mods.filter((m) => !tddInfo.text.includes(m.name) && !tddInfo.text.includes(m.path))
    if (undocumented.length > 0) {
      addFinding(findings, {
        id: 'docs.tdd-module-drift',
        category: 'docs',
        severity: 'medium',
        file: 'docs/TDD.md',
        title: `docs/TDD.md omits ${undocumented.length} module(s): ${undocumented.slice(0, 6).map((m) => m.path).join(', ')}`,
        action: 'Update docs/TDD.md module table to match current source layout.',
      })
    }
    for (const m of tddInfo.text.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim()
      if (!tok.includes('/') || /^(?:https?:|\/|[A-Za-z]:|<)/.test(tok) || /[<>*?]/.test(tok) || tok.endsWith('/')) continue
      if (!REPO_PATH_EXT_RE.test(tok)) continue
      if (!existsSync(join(repoRoot, tok))) {
        addFinding(findings, {
          id: `docs.tdd-stale-path.${tok}`,
          category: 'docs',
          severity: 'medium',
          file: 'docs/TDD.md',
          title: `Stale path referenced in docs/TDD.md: ${tok}`,
          action: `Update or remove "${tok}" in docs/TDD.md.`,
        })
      }
    }
  }

  checkMarkdownDeadLinks(repoRoot, files, findings)
  checkDocChurnStaleness(repoRoot, isGit, scopeRel, findings)

  const todoDir = join(repoRoot, 'docs', 'todo')
  if (existsSync(todoDir)) {
    try {
      for (const name of readdirSync(todoDir)) {
        if (!name.endsWith('.md')) continue
        const info = readTextStrictInfo(join(todoDir, name))
        if (!info?.text) continue
        const unchecked = (info.text.match(/^- \[ \]\s+.+$/gm) ?? []).length
        if (unchecked === 0) {
          addFinding(findings, {
            id: `docs.unarchived-completed-todo.${name}`,
            category: 'docs',
            severity: 'low',
            file: `docs/todo/${name}`,
            title: `Completed todo not yet archived: docs/todo/${name}`,
            action: `Move to docs/archive/todo/${name}.`,
          })
        }
      }
    } catch { /* ignore */ }
  }
}

function inspectWorktrees(repoRoot, isGit, defaultBranch) {
  const stale = []
  const worktreeEntries = []
  const counts = { merged: 0, squash_or_rebase_merged: 0, no_own_commits: 0, unmerged: 0, prunable: 0, orphan_dir: 0 }
  if (!isGit) return { total: 0, counts, entries: worktreeEntries, stale }

  const hasValidDefault = Boolean(defaultBranch && runGit(repoRoot, ['rev-parse', '--verify', defaultBranch]).ok)
  const firstParentSet = new Set()
  if (hasValidDefault) {
    const fp = runGit(repoRoot, ['rev-list', '--first-parent', '-n', '500', defaultBranch])
    if (fp.ok && fp.stdout) {
      for (const sha of fp.stdout.split('\n')) {
        if (sha.trim()) firstParentSet.add(sha.trim())
      }
    }
  }

  let defaultPatchIdSet = null
  const getDefaultPatchIdSet = () => {
    if (defaultPatchIdSet !== null) return defaultPatchIdSet
    defaultPatchIdSet = new Set()
    if (!hasValidDefault) return defaultPatchIdSet
    const logRes = runGit(repoRoot, ['log', '-n', '60', '--no-merges', '-p', defaultBranch], { timeout: 30000 })
    if (logRes.ok && logRes.stdout) {
      const pidRes = runGit(repoRoot, ['patch-id', '--stable'], { input: logRes.stdout })
      if (pidRes.ok && pidRes.stdout) {
        for (const line of pidRes.stdout.split('\n')) {
          const pid = line.trim().split(/\s+/)[0]
          if (pid) defaultPatchIdSet.add(pid)
        }
      }
    }
    return defaultPatchIdSet
  }

  const listRes = runGit(repoRoot, ['worktree', 'list', '--porcelain'])
  const registeredPaths = new Set()
  const rawEntries = []
  if (listRes.ok && listRes.stdout) {
    let cur = null
    for (const line of listRes.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) rawEntries.push(cur)
        cur = { path: resolve(line.slice(9).trim()), headSha: undefined, branch: undefined, prunable: undefined }
      } else if (cur && line.startsWith('HEAD ')) {
        cur.headSha = line.slice(5).trim()
      } else if (cur && line.startsWith('branch refs/heads/')) {
        cur.branch = line.slice('branch refs/heads/'.length).trim()
      } else if (cur && line.startsWith('prunable')) {
        cur.prunable = line.slice(8).trim() || 'missing directory'
      }
    }
    if (cur) rawEntries.push(cur)
  }

  const rootResolved = resolve(repoRoot)
  let registeredInDotWorktrees = 0
  for (const e of rawEntries) {
    registeredPaths.add(e.path)
    if (e.path === rootResolved) continue
    const rel = posixPath(relative(rootResolved, e.path))
    if (!rel.startsWith('.worktrees/')) continue
    registeredInDotWorktrees += 1

    if (e.prunable) {
      counts.prunable += 1
      const item = { path: rel, branch: e.branch, headSha: e.headSha, state: 'prunable', dirty: false, reason: `prunable (${e.prunable})` }
      worktreeEntries.push(item)
      stale.push(item)
      continue
    }

    const stRes = existsSync(e.path) ? runGit(e.path, ['status', '--porcelain']) : { ok: false, stdout: '' }
    const dirty = Boolean(stRes.ok && stRes.stdout.trim())
    const targetRef = e.branch || e.headSha
    if (!hasValidDefault || !targetRef) {
      counts.unmerged += 1
      worktreeEntries.push({ path: rel, branch: e.branch, headSha: e.headSha, state: 'unmerged', dirty, reason: 'default branch unknown' })
      continue
    }

    const ownRes = runGit(repoRoot, ['rev-list', '--count', `${defaultBranch}..${targetRef}`])
    const ownCommits = ownRes.ok ? (Number(ownRes.stdout.trim()) || 0) : 1
    const isAncestor = runGit(repoRoot, ['merge-base', '--is-ancestor', targetRef, defaultBranch]).ok

    if (isAncestor && ownCommits === 0) {
      const targetSha = e.headSha || runGit(repoRoot, ['rev-parse', targetRef]).stdout.trim()
      const onFirstParent = firstParentSet.has(targetSha)
      let hasCommitReflog = false
      if (e.branch) {
        const reflog = runGit(repoRoot, ['reflog', 'show', '--format=%gs', `refs/heads/${e.branch}`])
        if (reflog.ok && reflog.stdout) {
          hasCommitReflog = reflog.stdout.split('\n').some((l) => /^(?:commit(?:\s|\(|:)|cherry-pick)/.test(l.trim()))
        }
      }
      if (!onFirstParent || hasCommitReflog) {
        counts.merged += 1
        const item = {
          path: rel, branch: e.branch, headSha: e.headSha, state: 'merged', dirty,
          reason: `merged: branch "${e.branch || targetSha.slice(0, 8)}" already merged into ${defaultBranch}`,
        }
        worktreeEntries.push(item)
        stale.push(item)
      } else {
        counts.no_own_commits += 1
        const item = {
          path: rel, branch: e.branch, headSha: e.headSha, state: 'no_own_commits', dirty,
          reason: `no_own_commits: no unique commits ahead of ${defaultBranch} (dirty=${dirty}; ask human before cleaning)`,
        }
        worktreeEntries.push(item)
        stale.push(item)
      }
      continue
    }

    // Check rebase/cherry-pick via git cherry
    const cherryRes = runGit(repoRoot, ['cherry', defaultBranch, targetRef])
    const cherryLines = cherryRes.ok && cherryRes.stdout ? cherryRes.stdout.split('\n').map((l) => l.trim()).filter(Boolean) : []
    if (cherryLines.length > 0 && cherryLines.every((l) => l.startsWith('- '))) {
      counts.squash_or_rebase_merged += 1
      const item = {
        path: rel, branch: e.branch, headSha: e.headSha, state: 'squash_or_rebase_merged', dirty,
        reason: `squash_or_rebase_merged: all ${cherryLines.length} commit(s) already applied on ${defaultBranch} (git cherry)`,
      }
      worktreeEntries.push(item)
      stale.push(item)
      continue
    }

    // Check squash merge via combined branch diff patch-id
    let squashMatched = false
    const mbRes = runGit(repoRoot, ['merge-base', defaultBranch, targetRef])
    if (mbRes.ok && mbRes.stdout.trim()) {
      const mb = mbRes.stdout.trim()
      const diffRes = runGit(repoRoot, ['diff', mb, targetRef])
      if (diffRes.ok && diffRes.stdout) {
        const pidRes = runGit(repoRoot, ['patch-id', '--stable'], { input: diffRes.stdout })
        const branchPid = pidRes.ok ? pidRes.stdout.trim().split(/\s+/)[0] : ''
        if (branchPid && getDefaultPatchIdSet().has(branchPid)) squashMatched = true
      }
    }

    if (squashMatched) {
      counts.squash_or_rebase_merged += 1
      const item = {
        path: rel, branch: e.branch, headSha: e.headSha, state: 'squash_or_rebase_merged', dirty,
        reason: `squash_or_rebase_merged: combined diff patch-id matches commit on ${defaultBranch}`,
      }
      worktreeEntries.push(item)
      stale.push(item)
    } else {
      counts.unmerged += 1
      worktreeEntries.push({
        path: rel, branch: e.branch, headSha: e.headSha, state: 'unmerged', dirty, ownCommits,
        reason: `unmerged: ${ownCommits} unique commit(s) not on ${defaultBranch}`,
      })
    }
  }

  const wtContainer = join(repoRoot, '.worktrees')
  if (existsSync(wtContainer)) {
    try {
      for (const d of readdirSync(wtContainer, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '.state') continue
        const abs = resolve(wtContainer, d.name)
        if (!registeredPaths.has(abs)) {
          counts.orphan_dir += 1
          const item = { path: `.worktrees/${d.name}`, branch: undefined, state: 'orphan_dir', dirty: false, reason: 'unregistered orphan directory inside .worktrees/' }
          worktreeEntries.push(item)
          stale.push(item)
        }
      }
    } catch { /* ignore */ }
  }

  return { total: registeredInDotWorktrees, counts, entries: worktreeEntries, stale }
}

function inspectManifest(repoRoot) {
  const skillsDir = join(repoRoot, '.agents', 'skills')
  const manifestPath = join(skillsDir, '.pf-manifest.json')
  if (!existsSync(skillsDir) && !existsSync(manifestPath)) {
    return { present: false, status: 'not-equipped', issues: [] }
  }
  if (existsSync(skillsDir) && !existsSync(manifestPath)) {
    return {
      present: true,
      status: 'missing-manifest',
      issues: [{ file: '.agents/skills/.pf-manifest.json', kind: 'missing', detail: '.agents/skills/ exists without .pf-manifest.json' }],
    }
  }

  const manifest = readJsonSafe(manifestPath)
  if (!manifest || typeof manifest !== 'object' || typeof manifest.files !== 'object' || manifest.files === null) {
    return {
      present: true,
      status: 'corrupt-manifest',
      issues: [{ file: '.agents/skills/.pf-manifest.json', kind: 'corrupt', detail: 'Invalid JSON or missing files map' }],
    }
  }

  const issues = []
  let checked = 0
  for (const [relKey, meta] of Object.entries(manifest.files)) {
    checked += 1
    const norm = posixPath(relKey)
    const abs = norm.startsWith('.agents/skills/') ? join(repoRoot, norm) : join(skillsDir, norm)
    if (!existsSync(abs)) {
      issues.push({ file: norm, kind: 'missing-managed', detail: 'Managed skill file listed in manifest is missing on disk' })
      continue
    }
    if (meta && typeof meta.sha256 === 'string') {
      try {
        const actual = createHash('sha256').update(readFileSync(abs)).digest('hex')
        if (actual !== meta.sha256) {
          issues.push({ file: norm, kind: 'drifted', detail: 'File checksum differs from manifest baseline (local modification or drift)' })
        }
      } catch {
        issues.push({ file: norm, kind: 'unreadable', detail: 'Unable to hash managed file' })
      }
    }
  }

  return {
    present: true,
    status: issues.length === 0 ? 'ok' : 'drift-detected',
    checkedFiles: checked,
    issues,
  }
}

function auditHygiene(repoRoot, isGit, files, defaultBranch, devProfile, findings) {
  const home = homedir().replace(/\\/g, '/')
  const homeRe = home.length > 4 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined
  const codeRelList = []

  for (const f of files) {
    if (f.size > LARGE_FILE_BYTES) {
      addFinding(findings, {
        id: `hygiene.large-file.${f.rel}`,
        category: 'hygiene',
        severity: 'medium',
        file: f.rel,
        title: `Large file (${(f.size / (1024 * 1024)).toFixed(2)} MB): ${f.rel}`,
        action: 'Exclude build/binary artifact via .gitignore or move out of repo.',
      })
    }
    if (!TEXT_EXT_RE.test(f.name)) continue
    const info = readTextStrictInfo(f.full)
    if (!info || info.tooLarge || info.binary) continue
    if (info.hasBom) {
      addFinding(findings, {
        id: `hygiene.bom.${f.rel}`,
        category: 'hygiene',
        severity: 'low',
        file: f.rel,
        title: `UTF-8 BOM detected in ${f.rel}`,
        action: 'Re-save file as UTF-8 without BOM.',
      })
    }
    if (homeRe && homeRe.test(info.text)) {
      addFinding(findings, {
        id: `hygiene.home-path.${f.rel}`,
        category: 'hygiene',
        severity: 'high',
        file: f.rel,
        title: `Machine-specific home directory path leaked in ${f.rel}`,
        action: 'Replace hardcoded user path with relative path or environment lookup.',
      })
    }

    if (CODE_EXT_RE.test(f.name)) {
      codeRelList.push(f.rel)
      const lines = info.text.split('\n')
      if (!TEST_FILE_RE.test(f.rel) && !f.name.endsWith('.min.js') && lines.length > GOD_FILE_WARN_LINES) {
        const isHigh = lines.length > GOD_FILE_HIGH_LINES
        addFinding(findings, {
          id: `hygiene.god-file.${f.rel}`,
          category: 'hygiene',
          severity: isHigh ? 'high' : 'medium',
          file: f.rel,
          title: `Oversized source file (${lines.length} lines > ${isHigh ? GOD_FILE_HIGH_LINES : GOD_FILE_WARN_LINES}): ${f.rel}`,
          action: 'Split cohesive responsibilities into smaller focused modules rather than expanding a god file.',
        })
      }

      let inBlock = false
      let tombCount = 0
      let excuseCount = 0
      for (let i = 0; i < lines.length; i += 1) {
        const { commentText, nextInBlock } = extractLineCommentInfo(lines[i], inBlock)
        inBlock = nextInBlock
        if (commentText && TOMBSTONE_COMMENT_RE.test(commentText)) {
          tombCount += 1
          if (tombCount <= 5) {
            addFinding(findings, {
              id: `hygiene.tombstone-comment.${f.rel}:${i + 1}`,
              category: 'hygiene',
              severity: 'low',
              file: f.rel,
              line: i + 1,
              title: `Tombstone/chronicle history comment at ${f.rel}:${i + 1}`,
              detail: lines[i].trim().slice(0, 100),
              action: 'Describe current invariants only; remove historical change-log commentary.',
            })
          }
        }
        if ((commentText && (EXCUSE_COMMENT_RE.test(commentText) || EXCUSE_TEMP_RE.test(commentText))) || RUST_ALLOW_RE.test(lines[i])) {
          excuseCount += 1
          if (excuseCount <= 5) {
            addFinding(findings, {
              id: `hygiene.excuse-suppression.${f.rel}:${i + 1}`,
              category: 'hygiene',
              severity: 'medium',
              file: f.rel,
              line: i + 1,
              title: `Excuse/suppression pragma or workaround marker at ${f.rel}:${i + 1}`,
              detail: lines[i].trim().slice(0, 100),
              action: 'Fix root cause (types, lint, or contract boundary) instead of suppressing checks.',
            })
          }
        }
      }
    }
  }

  // Static arch-rules boundary check
  const archViolations = evaluateArchRules(repoRoot, codeRelList, devProfile['arch-rules'])
  for (const v of archViolations) {
    addFinding(findings, {
      id: `hygiene.arch-boundary.${v.file}:${v.line}`,
      category: 'hygiene',
      severity: 'high',
      file: v.file,
      line: v.line,
      title: `Architecture boundary violation (${v.rule}): ${v.file}:${v.line} imports "${v.specifier}"`,
      detail: v.lineText,
      action: v.fixHint,
    })
  }

  // Unignored output directories check in one batched git check-ignore call
  const presentOutputs = OUTPUT_DIRS.filter((d) => existsSync(join(repoRoot, d)))
  if (isGit && presentOutputs.length > 0) {
    const res = runGit(repoRoot, ['check-ignore', '-z', '--stdin'], { input: presentOutputs.join('\0') })
    const ignored = new Set((res.stdout || '').split('\0').filter(Boolean).map((s) => posixPath(s).replace(/\/$/, '')))
    for (const d of presentOutputs) {
      if (!ignored.has(d)) {
        addFinding(findings, {
          id: `hygiene.unignored-dir.${d}`,
          category: 'hygiene',
          severity: d === '.worktrees' ? 'high' : 'medium',
          file: d,
          title: `Output/workspace directory "${d}/" exists on disk and is NOT in .gitignore`,
          action: `Add "${d}/" to .gitignore.`,
        })
      }
    }
  }

  const wtReport = inspectWorktrees(repoRoot, isGit, defaultBranch)
  for (const s of wtReport.stale) {
    const isNoOwn = s.state === 'no_own_commits'
    addFinding(findings, {
      id: `hygiene.stale-worktree.${s.path}`,
      category: 'hygiene',
      severity: isNoOwn ? 'low' : 'medium',
      file: s.path,
      title: `Worktree candidate [${s.state}]: ${s.path} (${s.reason})`,
      action: isNoOwn
        ? 'Confirm with human first and check uncommitted files before removing (branch has no own commits and may hold WIP).'
        : 'Unmount any shared dependency junction first, confirm with user, then run `git worktree remove`.',
    })
  }

  const manifestReport = inspectManifest(repoRoot)
  for (const iss of manifestReport.issues) {
    addFinding(findings, {
      id: `hygiene.manifest.${iss.kind}.${iss.file}`,
      category: 'hygiene',
      severity: iss.kind === 'corrupt' || iss.kind === 'missing-managed' ? 'high' : 'low',
      file: iss.file,
      title: `Skill manifest check [${iss.kind}]: ${iss.file}`,
      detail: iss.detail,
      action: iss.kind === 'drifted'
        ? 'Expected if customized locally; otherwise re-sync skills.'
        : 'Re-run skill installation/equip to restore .pf-manifest.json consistency.',
    })
  }

  return { worktrees: wtReport, manifest: manifestReport, archViolations }
}

function auditPerf(repoRoot, files, findings) {
  const jsLocks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']
    .filter((f) => existsSync(join(repoRoot, f)))
  if (jsLocks.length > 1) {
    addFinding(findings, {
      id: 'perf.multiple-lockfiles',
      category: 'perf',
      severity: 'medium',
      title: `Multiple JS lockfiles coexist: ${jsLocks.join(', ')}`,
      action: 'Keep a single canonical package manager lockfile to avoid slow/divergent installs.',
    })
  }

  for (const f of files) {
    if (!CODE_EXT_RE.test(f.name) || TEST_FILE_RE.test(f.rel)) continue
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const lines = info.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (/\/.*\/[gimsuy]*\.test\(/.test(lines[i])) continue
      if (/\b(?:fetch|https\.request|http\.request)\s*\(/.test(lines[i])) {
        const windowText = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 8)).join('\n')
        if (!/timeout|AbortController|AbortSignal/i.test(windowText)) {
          addFinding(findings, {
            id: `perf.network-no-timeout.${f.rel}:${i + 1}`,
            category: 'perf',
            severity: 'low',
            file: f.rel,
            line: i + 1,
            title: `Network call without explicit timeout/AbortSignal in ${f.rel}:${i + 1}`,
            action: 'Pass explicit timeout or AbortSignal.timeout(...) to prevent hanging calls.',
          })
          break
        }
      }
    }
  }
}

function buildPlan(findings, repoRoot) {
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  const batch1 = sorted.filter((f) => f.severity === 'critical' || f.severity === 'high')
  const batch2 = sorted.filter((f) => f.severity === 'medium')
  const batch3 = sorted.filter((f) => f.severity === 'low' || f.severity === 'info')

  const batches = [
    { batch: 1, name: 'Critical & High (Security / Broken Contracts / Size Gates)', items: batch1 },
    { batch: 2, name: 'Medium (Docs Parity / Tests / Stale Worktrees / Hygiene)', items: batch2 },
    { batch: 3, name: 'Low & Info (Deadcode Markers / Perf Hints / Local Drift)', items: batch3 },
  ].filter((b) => b.items.length > 0)

  const today = new Date().toISOString().slice(2, 10).replace(/-/g, '')
  const todoRel = `docs/todo/${today}-govern-remediation.md`
  const todoLines = [
    '# Governance Remediation Plan',
    '',
    `Generated from \`${posixPath(repoRoot)}\``,
    '',
    '## Acceptance Criteria',
    '',
    ...sorted.slice(0, 10).map((f, idx) => `- [ ] C${idx + 1}: [${f.severity}] ${f.title}`),
    ...(sorted.length === 0 ? ['- [ ] C1: Verify repository remains clean with zero critical/high gaps'] : []),
    '',
    '## Completion Notes',
    '',
    '**在合并之前写完，随这次改动一起提交。**',
    '',
  ]

  return { batches, todoRel, todoDraft: todoLines.join('\n') }
}

function buildIssues(findings) {
  const actionable = findings.filter((f) => f.severity !== 'info')
  const grouped = new Map()
  for (const f of actionable) {
    if (!grouped.has(f.category)) grouped.set(f.category, [])
    grouped.get(f.category).push(f)
  }
  const issues = []
  for (const [cat, items] of grouped.entries()) {
    const highest = items.some((x) => x.severity === 'critical') ? 'critical'
      : items.some((x) => x.severity === 'high') ? 'high' : 'medium'
    const title = `[govern/${cat}] Resolve ${items.length} ${cat} finding(s) (max severity: ${highest})`
    const bodyLines = [
      `## Audit Category: \`${cat}\``,
      '',
      'Findings detected by `govern-audit`:',
      '',
      ...items.slice(0, 25).map((item, idx) =>
        `${idx + 1}. **[${item.severity.toUpperCase()}]** ${item.title}${item.action ? ` — Action: ${item.action}` : ''}`,
      ),
      ...(items.length > 25 ? ['', `_...and ${items.length - 25} more items in category \`${cat}\`._`] : []),
      '',
      '## Acceptance Criteria',
      '',
      ...items.slice(0, 5).map((item, idx) => `- [ ] C${idx + 1}: Resolve \`${item.id}\``),
      '',
    ]
    issues.push({
      category: cat,
      severity: highest,
      title,
      labels: ['governance', cat],
      body: bodyLines.join('\n'),
    })
  }
  return issues
}

function applyGitHubIssues(repoRoot, issues) {
  if (issues.length === 0) return { applied: [], error: undefined }
  const remotes = runGit(repoRoot, ['remote', '-v'])
  if (!remotes.ok || !/github\.com/i.test(remotes.stdout)) {
    return { applied: [], error: 'No GitHub remote found; cannot create GitHub issues.' }
  }
  const auth = runCmd('gh', ['auth', 'status'], { cwd: repoRoot })
  if (auth.missing || !auth.ok) {
    return { applied: [], error: auth.missing ? '`gh` CLI is not installed.' : '`gh auth status` failed; sign in to GitHub first.' }
  }
  const created = []
  for (let i = 0; i < issues.length; i += 1) {
    const iss = issues[i]
    const tmpFile = join(tmpdir(), `govern-issue-${process.pid}-${Date.now()}-${i}.md`)
    try {
      writeFileSync(tmpFile, iss.body, 'utf8')
      const res = runCmd('gh', ['issue', 'create', '--title', iss.title, '--body-file', tmpFile], { cwd: repoRoot })
      if (!res.ok) return { applied: created, error: `gh issue create failed: ${res.stderr}` }
      created.push({ title: iss.title, url: res.stdout.trim() })
    } finally {
      try { if (existsSync(tmpFile)) rmSync(tmpFile, { force: true }) } catch { /* ignore */ }
    }
  }
  return { applied: created, error: undefined }
}

function updateLoopState(repoRoot, findings, writeState) {
  const statePath = join(repoRoot, '.worktrees', '.state', 'govern-loop.json')
  const prev = readJsonSafe(statePath) ?? { rounds: [] }
  const nextRound = (Array.isArray(prev.rounds) ? prev.rounds.length : 0) + 1
  const counts = countBySeverity(findings)
  const snapshot = {
    round: nextRound,
    timestamp: new Date().toISOString(),
    totalFindings: findings.length,
    counts,
    topIds: findings.slice(0, 10).map((f) => f.id),
  }
  const state = {
    updatedAt: snapshot.timestamp,
    currentRound: nextRound,
    rounds: [...(Array.isArray(prev.rounds) ? prev.rounds : []), snapshot],
  }
  if (writeState) {
    writeAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`)
  }
  return { statePath: posixPath(statePath), state, snapshot }
}

function countBySeverity(findings) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0, info: 0 }
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1
  return counts
}

function inferModuleFromFile(fileRel) {
  const clean = posixPath(fileRel).replace(/^\.\//, '').trim()
  if (!clean) return 'repo'
  const parts = clean.split('/')
  if (parts.length <= 1) return 'root'
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]
}

function normalizePatternFromFindingId(id) {
  const parts = String(id ?? '').split('.')
  if (parts.length >= 2) return `${parts[0]}.${parts[1]}`
  return parts[0] || 'unknown'
}

function suggestClusterRootFix(pattern, moduleName) {
  if (/arch-boundary/.test(pattern)) {
    return `Define/enforce interface boundary outside forbidden target for ${moduleName} and register in AGENTS.md arch-rules:.`
  }
  if (/excuse-suppression/.test(pattern)) {
    return `Remove suppression comments in ${moduleName}; fix root types/lint checks and fail CI on new suppression pragmas.`
  }
  if (/tombstone-comment/.test(pattern)) {
    return `Strip chronicle comments in ${moduleName} and state current invariants cleanly in AGENTS.md / docs/TDD.md.`
  }
  if (/god-file/.test(pattern)) {
    return `Decompose oversized source file(s) in ${moduleName} into cohesive single-responsibility modules.`
  }
  if (/orphan-suite|zero-assertion|skip/.test(pattern)) {
    return `Wire missing/empty tests in ${moduleName} into CI workflows and Dev Profile merge-gate/quick-test.`
  }
  return `Promote recurring root cause (${pattern} in ${moduleName}) to static check, Dev Profile script, or smoke-verify command.`
}

function readSignalsJsonl(stateDir) {
  const signalsPath = join(stateDir, 'signals.jsonl')
  if (!existsSync(signalsPath)) return { signalsPath, events: [] }
  const text = readTextStrictInfo(signalsPath)?.text ?? ''
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch { /* ignore corrupt partial line */ }
  }
  return { signalsPath, events }
}

function buildClusterReport(signals, findings) {
  const map = new Map()
  const upsert = ({ module, pattern, category, sourceKind, file, line, message }) => {
    const mod = module || 'repo'
    const pat = pattern || 'general'
    const key = `${mod}::${pat}`
    if (!map.has(key)) {
      map.set(key, {
        key,
        module: mod,
        pattern: pat,
        category: category || 'hygiene',
        count: 0,
        signalCount: 0,
        auditCount: 0,
        sinkCandidate: false,
        recommendedTier: 'L1-observe',
        rootCauseFix: suggestClusterRootFix(pat, mod),
        examples: [],
      })
    }
    const entry = map.get(key)
    entry.count += 1
    if (sourceKind === 'signal') entry.signalCount += 1
    else entry.auditCount += 1
    entry.sinkCandidate = entry.count >= 2
    entry.recommendedTier = entry.count >= 3
      ? 'L3-static-gate-or-script'
      : entry.count >= 2
        ? 'L2-dev-profile-or-arch-rule'
        : 'L1-observe'
    if (entry.examples.length < 5) {
      entry.examples.push({
        source: sourceKind,
        file: file || '',
        line: line || undefined,
        message: String(message || '').slice(0, 140),
      })
    }
  }

  for (const ev of signals) {
    upsert({
      module: ev.module || inferModuleFromFile(ev.file),
      pattern: ev.pattern || 'manual-signal',
      category: ev.category || 'hygiene',
      sourceKind: 'signal',
      file: ev.file || '',
      line: ev.line,
      message: ev.message || ev.note || ev.pattern,
    })
  }
  for (const f of findings) {
    upsert({
      module: inferModuleFromFile(f.file),
      pattern: normalizePatternFromFindingId(f.id),
      category: f.category,
      sourceKind: 'audit',
      file: f.file,
      line: f.line,
      message: f.title,
    })
  }

  const clusters = [...map.values()].sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key))
  const sinkCandidates = clusters.filter((c) => c.sinkCandidate)
  return {
    totalEvents: signals.length + findings.length,
    signalEvents: signals.length,
    auditFindings: findings.length,
    totalClusters: clusters.length,
    sinkCandidateCount: sinkCandidates.length,
    clusters,
    sinkCandidates,
  }
}

function handleRecordSignal(repoRoot, isGit, opts) {
  const message = String(opts.message || opts.note || '').trim()
  const rawPattern = String(opts.pattern || '').trim()
  if (!rawPattern && !message) {
    process.stderr.write('Error: `record` requires --pattern <key> or --message <text>.\n')
    return 2
  }
  const fileRel = opts.file ? posixPath(opts.file) : ''
  const moduleName = String(opts.module || '').trim() || inferModuleFromFile(fileRel)
  const pattern = rawPattern || message.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'signal'
  const category = String(opts.category || 'hygiene').trim().toLowerCase()
  const severity = String(opts.severity || 'medium').trim().toLowerCase()
  const source = String(opts.source || 'manual').trim().toLowerCase()

  const stateDir = resolveGovernStateDir(repoRoot, isGit)
  mkdirSync(stateDir, { recursive: true })
  const signalsPath = join(stateDir, 'signals.jsonl')
  const event = {
    ts: new Date().toISOString(),
    category,
    module: moduleName,
    pattern,
    severity,
    source,
    file: fileRel,
    message: message || pattern,
  }
  appendFileSync(signalsPath, `${JSON.stringify(event)}\n`, 'utf8')

  const { events } = readSignalsJsonl(stateDir)
  const clusterReport = buildClusterReport(events, [])
  const matched = clusterReport.clusters.find((c) => c.key === `${moduleName}::${pattern}`)
  const repeatCount = matched?.count ?? 1
  const payload = {
    status: 'RECORDED',
    repoRoot: posixPath(repoRoot),
    signalsPath: posixPath(signalsPath),
    event,
    modulePatternCount: repeatCount,
    ruleSinkCandidate: repeatCount >= 2,
    recommendation: repeatCount >= 2
      ? `[RULE_SINK_CANDIDATE] Pattern "${pattern}" in "${moduleName}" occurred ${repeatCount} times; sink into static check or Dev Profile.`
      : 'Signal recorded in gardening buffer; run `cluster` to identify patterns reaching >= 2 repeats.',
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write([
      '=== DEV-GOVERN SIGNAL RECORDED ===',
      `Signals File : ${payload.signalsPath}`,
      `Key          : ${moduleName}::${pattern} (category=${category}, severity=${severity}, count=${repeatCount})`,
      `Sink Ready?  : ${payload.ruleSinkCandidate}`,
      `[NEXT STEP]  : ${payload.recommendation}`,
      '',
    ].join('\n'))
  }
  return 0
}

function handleSampleCommits(repoRoot, isGit, opts) {
  const limit = Number(opts.commits ?? 30)
  if (!Number.isInteger(limit) || limit < 1) {
    process.stderr.write('Error: --commits must be a positive integer.\n')
    return 2
  }
  const stateDir = resolveGovernStateDir(repoRoot, isGit)
  const { signalsPath, events } = readSignalsJsonl(stateDir)
  const signalClusters = buildClusterReport(events, [])

  let commits = []
  if (isGit && runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']).ok) {
    const logRes = runGit(repoRoot, ['log', '-n', String(limit), '--name-only', '--format=__COMMIT__%H\t%ct\t%s'])
    if (logRes.ok && logRes.stdout) {
      let cur = null
      for (const line of logRes.stdout.split('\n')) {
        if (line.startsWith('__COMMIT__')) {
          if (cur) commits.push(cur)
          const [hash, tsStr, ...rest] = line.slice(10).split('\t')
          cur = { hash, ts: Number(tsStr) || 0, subject: rest.join('\t').trim(), files: [] }
        } else if (cur && line.trim()) {
          const rel = posixPath(line.trim())
          if (!rel.startsWith('.worktrees/')) cur.files.push(rel)
        }
      }
      if (cur) commits.push(cur)
    }
  }

  const revertedCommits = []
  const fileTouches = new Map()
  for (const c of commits) {
    const isRevert = /^Revert\b|\brevert(?:ed|ing)?\s+(?:"|'|#|\bpr\b|\bcommit\b)|^回滚/i.test(c.subject)
    if (isRevert) {
      revertedCommits.push({ hash: c.hash.slice(0, 8), ts: c.ts, subject: c.subject })
    }
    for (const f of new Set(c.files)) {
      if (!fileTouches.has(f)) fileTouches.set(f, [])
      fileTouches.get(f).push({ hash: c.hash.slice(0, 8), ts: c.ts, subject: c.subject, isRevert })
    }
  }

  const WINDOW_48H = 48 * 3600
  const reworkHotspots = []
  for (const [file, list] of fileTouches.entries()) {
    const asc = [...list].sort((a, b) => a.ts - b.ts)
    let left = 0
    let maxIn48h = 0
    for (let right = 0; right < asc.length; right += 1) {
      while (asc[right].ts - asc[left].ts > WINDOW_48H) left += 1
      if (right - left + 1 > maxIn48h) maxIn48h = right - left + 1
    }
    const hasRevert = asc.some((x) => x.isRevert)
    if (maxIn48h >= 3 || (maxIn48h >= 2 && hasRevert)) {
      reworkHotspots.push({
        file,
        maxEditsIn48h: maxIn48h,
        totalTouches: asc.length,
        hasRevert,
        commitHashes: list.map((x) => x.hash).slice(0, 6),
        recentSubjects: list.map((x) => x.subject).slice(0, 4),
      })
    }
  }
  reworkHotspots.sort((a, b) => (b.maxEditsIn48h - a.maxEditsIn48h) || (b.totalTouches - a.totalTouches) || a.file.localeCompare(b.file))

  const totalCommits = commits.length
  const revertCount = revertedCommits.length
  const revertRate = totalCommits > 0 ? Number((revertCount / totalCommits).toFixed(4)) : 0
  const revertRatePct = `${(revertRate * 100).toFixed(1)}%`

  const recommendations = []
  if (revertCount > 0) {
    recommendations.push({
      priority: revertRate >= 0.1 || revertCount >= 2 ? 'high' : 'medium',
      reason: `${revertCount}/${totalCommits} recent commits (${revertRatePct}) are reverts`,
      action: 'Add missing regression tests or `smoke-verify:` command to AGENTS.md before resuming feature work.',
    })
  }
  for (const hs of reworkHotspots.slice(0, 5)) {
    recommendations.push({
      priority: hs.hasRevert || hs.maxEditsIn48h >= 4 ? 'high' : 'medium',
      reason: `Hotspot "${hs.file}" reworked ${hs.maxEditsIn48h}x within 48h`,
      action: hs.maxEditsIn48h >= 3
        ? `Apply 3-strike stop-loss on "${hs.file}": pause edits, add unit + smoke tests, and review module boundaries.`
        : `Add regression guard and test coverage for "${hs.file}".`,
    })
  }
  for (const sc of signalClusters.sinkCandidates.slice(0, 5)) {
    recommendations.push({
      priority: sc.count >= 3 ? 'high' : 'medium',
      reason: `Repeated governance signal "${sc.module}::${sc.pattern}" (${sc.count}x)`,
      action: sc.rootCauseFix,
    })
  }

  const nextSteps = recommendations.length > 0
    ? ['Sink top recommendations into static checks, `arch-rules`, or `smoke-verify` commands, then verify with `govern-audit.mjs cluster`.']
    : ['Recent history sample is healthy (low revert rate, no 48h churn hotspots).']

  const payload = {
    mode: 'sample',
    repoRoot: posixPath(repoRoot),
    sampleWindow: limit,
    totalCommits,
    revertCount,
    revertRate,
    revertRatePct,
    revertedCommits,
    reworkHotspots,
    signalsPath: posixPath(signalsPath),
    signalSinkCandidates: signalClusters.sinkCandidates,
    recommendations,
    nextSteps,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    const lines = [
      '=== DEV-GOVERN (SAMPLE) ===',
      `Repo Root     : ${payload.repoRoot}`,
      `Sample Window : last ${limit} commit(s) (observed=${totalCommits})`,
      `Revert Rate   : ${revertCount} / ${totalCommits} (${revertRatePct})`,
      `48h Hotspots  : ${reworkHotspots.length} file(s)`,
      `Signal Sinks  : ${signalClusters.sinkCandidates.length} repeated cluster(s)`,
    ]
    if (revertedCommits.length > 0) {
      lines.push('', '--- Reverted Commits ---')
      for (const rc of revertedCommits) lines.push(`  - ${rc.hash}: ${rc.subject}`)
    }
    if (reworkHotspots.length > 0) {
      lines.push('', '--- 48h Same-File Rework Hotspots ---')
      for (const hs of reworkHotspots) {
        lines.push(`  - ${hs.file}: maxIn48h=${hs.maxEditsIn48h}, total=${hs.totalTouches}, hasRevert=${hs.hasRevert} [${hs.commitHashes.join(', ')}]`)
      }
    }
    if (recommendations.length > 0) {
      lines.push('', '--- Rule-Sinking Recommendations ---')
      for (const rec of recommendations) {
        lines.push(`  - [${rec.priority.toUpperCase()}] ${rec.reason}`)
        lines.push(`      Action: ${rec.action}`)
      }
    }
    lines.push('', '[NEXT STEP]', ...nextSteps.map((s) => `  ${s}`), '')
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return 0
}

function formatTextReport(result) {
  const lines = []
  const counts = result.counts
  lines.push(`=== DEV-GOVERN (${result.mode.toUpperCase()}) ===`)
  lines.push(`Repo Root  : ${posixPath(result.repoRoot)}`)
  lines.push(`Scope      : ${result.scope || '(entire repository)'}`)
  lines.push(`Categories : ${result.categories.join(', ')}`)
  lines.push(`Summary    : ${result.findings.length} finding(s) [critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}, low=${counts.low}, info=${counts.info}]`)

  if (result.reconcileSummary) {
    const r = result.reconcileSummary
    const wc = r.worktrees.counts ?? {}
    lines.push('')
    lines.push('[RECONCILE]')
    lines.push(`  AGENTS.md Bytes : ${r.agentsBytes ?? 'missing'} / ${AGENTS_MAX_BYTES} (warn >= ${AGENTS_WARN_BYTES})`)
    lines.push(`  docs/TDD.md     : ${r.tddPresent ? 'present' : 'missing'}`)
    lines.push(`  Worktrees       : ${r.worktrees.total} registered [merged=${wc.merged ?? 0}, squash_or_rebase=${wc.squash_or_rebase_merged ?? 0}, no_own_commits=${wc.no_own_commits ?? 0}, unmerged=${wc.unmerged ?? 0}] | ${r.worktrees.stale.length} candidate(s)`)
    lines.push(`  Skill Manifest  : ${r.manifest.status}${r.manifest.checkedFiles !== undefined ? ` (${r.manifest.checkedFiles} managed files checked)` : ''}`)
  }

  lines.push('')
  lines.push('[GAP_SCAN]')
  lines.push(`  total=${result.findings.length} critical=${counts.critical} high=${counts.high} medium=${counts.medium} low=${counts.low} info=${counts.info}`)
  if (result.findings.length === 0) {
    lines.push('  No governance gaps found in selected scope/categories.')
  } else {
    for (const f of result.findings) {
      const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : ''
      lines.push(`  - [${f.severity.toUpperCase()}][${f.category}] ${f.id}: ${f.title}${loc}`)
      if (f.action) lines.push(`      Action: ${f.action}`)
    }
  }

  if (result.cluster) {
    lines.push('')
    lines.push('--- Governance Buffer Clusters (Module + Pattern, >=2 => Rule Sinking) ---')
    lines.push(`  Events=${result.cluster.totalEvents} (signals=${result.cluster.signalEvents}, audit=${result.cluster.auditFindings}) | Clusters=${result.cluster.totalClusters} | Sink Candidates=${result.cluster.sinkCandidateCount}`)
    for (const c of result.cluster.clusters.slice(0, 15)) {
      const tag = c.sinkCandidate ? `[RULE_SINK:${c.recommendedTier}]` : '[OBSERVE]'
      lines.push(`  - ${tag} ${c.key} x${c.count} (signals=${c.signalCount}, audit=${c.auditCount})`)
      if (c.sinkCandidate) lines.push(`      Action: ${c.rootCauseFix}`)
    }
  }

  if (result.plan) {
    lines.push('')
    lines.push('--- Remediation Plan ---')
    for (const b of result.plan.batches) {
      lines.push(`  Batch ${b.batch}: ${b.name} (${b.items.length} item(s))`)
      for (const item of b.items.slice(0, 8)) {
        lines.push(`    - [${item.severity}] ${item.title}`)
      }
      if (b.items.length > 8) lines.push(`    ... +${b.items.length - 8} more`)
    }
    lines.push(`  Optional Todo Draft Path: ${result.plan.todoRel}`)
  }

  if (result.issues) {
    lines.push('')
    lines.push('--- GitHub Issue Payloads (UTF-8 --body-file safe) ---')
    if (result.issues.length === 0) {
      lines.push('  No actionable findings to convert into issues.')
    } else {
      for (let i = 0; i < result.issues.length; i += 1) {
        const iss = result.issues[i]
        lines.push(`  Issue #${i + 1}: ${iss.title}`)
        lines.push(`    Labels: ${iss.labels.join(', ')}`)
        lines.push(`    Safe Command: write UTF-8 temp file, then run \`gh issue create --title "${iss.title.replace(/"/g, '\\"')}" --body-file <tmp.md>\``)
        lines.push('    Body:')
        for (const bl of iss.body.split('\n')) lines.push(`      ${bl}`)
      }
    }
  }

  if (result.loop) {
    lines.push('')
    lines.push('--- Multi-Round Convergence Loop ---')
    lines.push(`  Round ${result.loop.snapshot.round} | Tracker: ${result.loop.statePath}`)
    lines.push(`  Remaining: critical=${counts.critical}, high=${counts.high}, medium=${counts.medium}`)
  }

  lines.push('')
  lines.push('[NEXT STEP]')
  for (const s of result.nextSteps) lines.push(`  ${s}`)
  return lines.join('\n')
}

function printHelp() {
  process.stdout.write([
    '用法：node govern-audit.mjs [reconcile|audit|record|cluster|sample] [targetDir] [options]',
    '',
    'Modes & Subcommands:',
    '  --audit-only                 Read-only audit outputting findings + [GAP_SCAN] (default)',
    '  audit [--cluster]            Alias for --audit-only (optionally attach cluster grouping)',
    '  --plan-only                  Generate phased remediation batches + Todo draft preview',
    '  --execute                    Guided closed-loop execution plan + verification checklist',
    '  reconcile | --reconcile      Check AGENTS.md 24KB/30KB cap & refs, TDD drift, 4-state .worktrees/, .pf-manifest.json, hygiene',
    '  record                       Append governance signal into <gitCommonDir>/project-forge-govern/signals.jsonl',
    '  cluster                      Group signals & findings by module+pattern, flagging >= 2 repeat rule-sink candidates',
    '  sample [--commits 30]        Inspect git Revert rate, 48h same-file rework hotspots, and rule-sinking actions',
    '',
    'Options:',
    '  --dir <path>                 Repository directory (defaults to cwd or positional targetDir)',
    '  --scope <dir>                Restrict scan to subdirectory inside repository',
    '  --categories <list>          Comma-separated subset of: security,deadcode,tests,docs,hygiene,perf',
    '  --cluster                    Attach module+pattern deduplicated clusters to audit output',
    '  --signals-only               For `cluster`, read signals.jsonl only without running full live audit',
    '  --commits <N>                Commit window size for `sample` (default: 30)',
    '  --loop                       Include/track multi-round governance convergence state',
    '  --issues                     Generate UTF-8 GitHub Issue payloads (dry-run by default)',
    '  --apply-issues               Actually invoke `gh issue create --body-file` (requires --issues and gh auth)',
    '  --write-todo                 Write generated Todo draft to docs/todo/ (only with --plan-only)',
    '  --strict                     Exit 1 if critical/high findings exist',
    '  --json                       Emit machine-readable JSON',
    '',
    'Record Options:',
    '  --pattern <key> --message <text> [--module <dir>] [--file <path>] [--category <cat>] [--severity <sev>] [--source <src>]',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const opts = {
    subcommand: null,
    dir: process.cwd(),
    dirSet: false,
    reconcile: false,
    auditOnly: false,
    planOnly: false,
    execute: false,
    cluster: false,
    signalsOnly: false,
    commits: 30,
    scope: '',
    categories: null,
    loop: false,
    issues: false,
    applyIssues: false,
    writeTodo: false,
    strict: false,
    json: false,
    help: false,
    category: undefined,
    pattern: undefined,
    module: undefined,
    file: undefined,
    severity: undefined,
    source: undefined,
    message: undefined,
    note: undefined,
  }

  const nextVal = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${flag}`)
    return argv[i + 1]
  }

  let i = 0
  if (argv[0] && !argv[0].startsWith('-')) {
    if (['reconcile', 'audit', 'record', 'cluster', 'sample'].includes(argv[0])) {
      opts.subcommand = argv[0]
      if (argv[0] === 'reconcile') opts.reconcile = true
      if (argv[0] === 'audit') opts.auditOnly = true
      if (argv[0] === 'cluster') opts.cluster = true
      i = 1
    }
  }

  for (; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === 'reconcile' || a === '--reconcile') opts.reconcile = true
    else if (a === '--audit-only') opts.auditOnly = true
    else if (a === '--plan-only') opts.planOnly = true
    else if (a === '--execute') opts.execute = true
    else if (a === '--cluster') opts.cluster = true
    else if (a === '--signals-only') opts.signalsOnly = true
    else if (a === '--loop') opts.loop = true
    else if (a === '--issues') opts.issues = true
    else if (a === '--apply-issues') opts.applyIssues = true
    else if (a === '--write-todo') opts.writeTodo = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--json') opts.json = true
    else if (a === '--dir' || a === '--repo') { opts.dir = nextVal(i, a); opts.dirSet = true; i += 1 }
    else if (a === '--scope') { opts.scope = nextVal(i, a); i += 1 }
    else if (a === '--commits') { opts.commits = Number(nextVal(i, a)); i += 1 }
    else if (a === '--category') { opts.category = nextVal(i, a); i += 1 }
    else if (a === '--pattern' || a === '--rule') { opts.pattern = nextVal(i, a); i += 1 }
    else if (a === '--module') { opts.module = nextVal(i, a); i += 1 }
    else if (a === '--file') { opts.file = nextVal(i, a); i += 1 }
    else if (a === '--severity') { opts.severity = nextVal(i, a); i += 1 }
    else if (a === '--source') { opts.source = nextVal(i, a); i += 1 }
    else if (a === '--message' || a === '--title') { opts.message = nextVal(i, a); i += 1 }
    else if (a === '--note') { opts.note = nextVal(i, a); i += 1 }
    else if (a === '--categories') {
      const raw = nextVal(i, a)
      i += 1
      const list = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      for (const c of list) {
        if (!VALID_CATEGORIES.has(c)) throw new Error(`Unknown category "${c}". Valid: ${ALL_CATEGORIES.join(', ')}`)
      }
      opts.categories = list
    } else if (!a.startsWith('-') && !opts.dirSet) {
      opts.dir = a
      opts.dirSet = true
    } else {
      throw new Error(`Unknown option: ${a}`)
    }
  }
  return opts
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`)
    return 2
  }
  if (opts.help) {
    printHelp()
    return 0
  }

  const targetAbs = resolve(opts.dir)
  if (!existsSync(targetAbs)) {
    process.stderr.write(`Error: directory does not exist: ${targetAbs}\n`)
    return 1
  }

  const { repoRoot, isGit } = resolveRepoRoot(targetAbs)

  if (opts.subcommand === 'record') {
    return handleRecordSignal(repoRoot, isGit, opts)
  }
  if (opts.subcommand === 'sample') {
    return handleSampleCommits(repoRoot, isGit, opts)
  }

  let scopeRel = ''
  if (opts.scope) {
    const scopeAbs = resolve(repoRoot, opts.scope)
    const rel = posixPath(relative(repoRoot, scopeAbs))
    if (!existsSync(scopeAbs) || rel.startsWith('..')) {
      process.stderr.write(`Error: invalid --scope "${opts.scope}" inside ${repoRoot}\n`)
      return 1
    }
    scopeRel = rel
  }

  const categories = opts.reconcile
    ? (opts.categories ?? ['docs', 'hygiene', 'security'])
    : (opts.categories ?? ALL_CATEGORIES)

  const catSet = new Set(categories)
  const runLiveAudit = !(opts.subcommand === 'cluster' && opts.signalsOnly)
  const files = runLiveAudit ? walkFiles(repoRoot, scopeRel) : []
  const trackedSet = new Set()
  let defaultBranch
  if (isGit) {
    if (runLiveAudit) {
      const ls = runGit(repoRoot, ['ls-files', '-z'])
      if (ls.ok && ls.stdout) {
        for (const p of ls.stdout.split('\0')) {
          if (p) trackedSet.add(posixPath(p))
        }
      }
    }
    const sym = runGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (sym.ok && sym.stdout) {
      defaultBranch = sym.stdout.trim().replace(/^origin\//, '')
    } else {
      for (const cand of ['main', 'master', 'trunk']) {
        if (runGit(repoRoot, ['rev-parse', '--verify', cand]).ok) { defaultBranch = cand; break }
      }
    }
  }

  const devProfile = parseDevProfile(repoRoot)
  const findings = []
  let testsMeta = { ciRunSteps: [] }

  if (runLiveAudit) {
    if (catSet.has('security')) auditSecurity(repoRoot, files, trackedSet, findings)
    if (catSet.has('deadcode')) auditDeadcode(files, findings)
    if (catSet.has('tests')) testsMeta = auditTests(repoRoot, files, devProfile, findings)
    if (catSet.has('docs')) auditDocs(repoRoot, isGit, files, devProfile, defaultBranch, scopeRel, findings)
  }
  let hygieneMeta = { worktrees: { total: 0, counts: {}, entries: [], stale: [] }, manifest: { present: false, status: 'not-checked', issues: [] }, archViolations: [] }
  if (runLiveAudit && catSet.has('hygiene')) {
    hygieneMeta = auditHygiene(repoRoot, isGit, files, defaultBranch, devProfile, findings)
  }
  if (runLiveAudit && catSet.has('perf')) auditPerf(repoRoot, files, findings)

  let reconcileSummary
  if (opts.reconcile) {
    const agentsInfo = readTextStrictInfo(join(repoRoot, 'AGENTS.md'))
    reconcileSummary = {
      agentsBytes: agentsInfo?.text ? Buffer.byteLength(agentsInfo.text, 'utf8') : null,
      tddPresent: existsSync(join(repoRoot, 'docs', 'TDD.md')),
      worktrees: hygieneMeta.worktrees,
      manifest: hygieneMeta.manifest,
    }
  }

  const shouldCluster = opts.cluster || opts.subcommand === 'cluster'
  let cluster
  let signalsPath
  if (shouldCluster) {
    const stateDir = resolveGovernStateDir(repoRoot, isGit)
    const loaded = readSignalsJsonl(stateDir)
    signalsPath = posixPath(loaded.signalsPath)
    cluster = buildClusterReport(loaded.events, findings)
  }

  const mode = opts.subcommand === 'cluster'
    ? 'cluster'
    : opts.reconcile
      ? 'reconcile'
      : opts.execute
        ? 'execute'
        : opts.planOnly
          ? 'plan-only'
          : opts.issues
            ? 'issues'
            : 'audit-only'

  const plan = (opts.planOnly || opts.execute) ? buildPlan(findings, repoRoot) : undefined
  if (opts.planOnly && opts.writeTodo && plan) {
    writeAtomic(join(repoRoot, plan.todoRel), plan.todoDraft)
  }

  const issues = opts.issues ? buildIssues(findings) : undefined
  let applyResult
  if (opts.issues && opts.applyIssues && issues) {
    applyResult = applyGitHubIssues(repoRoot, issues)
    if (applyResult.error) {
      process.stderr.write(`Error: ${applyResult.error}\n`)
      return 1
    }
  }

  const loop = opts.loop ? updateLoopState(repoRoot, findings, opts.execute) : undefined
  const counts = countBySeverity(findings)

  const nextSteps = []
  if (mode === 'cluster') {
    nextSteps.push(cluster.sinkCandidateCount > 0
      ? `Promote ${cluster.sinkCandidateCount} repeated cluster(s) (>=2) into static rules, arch-rules, or Dev Profile commands.`
      : 'No pattern has reached >=2 repeats yet; keep recording governance signals via `record`.')
  } else if (mode === 'reconcile') {
    nextSteps.push('Review [RECONCILE] findings: keep AGENTS.md <= 30720 bytes, update docs/TDD.md drift, and ask user before cleaning stale worktrees.')
  } else if (opts.planOnly) {
    nextSteps.push('Review remediation batches above; run with `--execute` (or move to `dev-flow` with Todo/SPEC) to fix batch by batch.')
  } else if (opts.execute) {
    const cmds = [...devProfile['quick-test'], ...devProfile['full-test']]
    nextSteps.push('Fix Batch 1 items first, then run verification commands before `review-pack.mjs --local`:')
    for (const c of cmds) nextSteps.push(`  $ ${c}`)
  } else if (opts.issues) {
    nextSteps.push(opts.applyIssues ? 'GitHub issues created safely via UTF-8 --body-file.' : 'Review generated payloads; pass `--apply-issues` after confirming with user to create on GitHub.')
  } else {
    nextSteps.push('Run `--plan-only` to generate prioritized batches, `reconcile` for harness drift, or `audit --cluster` / `sample` for rule-sinking.')
  }

  const result = {
    mode,
    repoRoot: posixPath(repoRoot),
    scope: scopeRel,
    categories,
    counts,
    findings,
    ciRunSteps: testsMeta.ciRunSteps,
    cluster,
    signalsPath,
    reconcileSummary,
    plan,
    issues,
    applyResult,
    loop,
    nextSteps,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatTextReport(result)}\n`)
  }

  if (opts.strict && (counts.critical > 0 || counts.high > 0)) {
    return 1
  }
  return 0
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main())
}
