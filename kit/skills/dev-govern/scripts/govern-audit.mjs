#!/usr/bin/env node
/**
 * govern-audit.mjs -- Repository code audit, tech-debt planning, multi-round
 * governance loop tracking, GitHub issue payload generation, and harness reconcile.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules only.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const AGENTS_WARN_BYTES = 24576
const AGENTS_MAX_BYTES = 30720
const LARGE_FILE_BYTES = 1024 * 1024
const MAX_READ_BYTES = 512 * 1024

const ALL_CATEGORIES = ['security', 'deadcode', 'tests', 'docs', 'hygiene', 'perf']
const VALID_CATEGORIES = new Set(ALL_CATEGORIES)

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

function parseDevProfile(repoRoot) {
  const profile = {
    'quick-test': [],
    'full-test': [],
    'merge-gate': [],
    'high-risk': [],
    'do-not-edit': [],
  }
  const info = readTextStrictInfo(join(repoRoot, 'AGENTS.md'))
  if (!info?.text) return profile
  for (const line of info.text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?`?(quick-test|full-test|merge-gate|high-risk|do-not-edit)`?\s*:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1]
    const val = m[2].replace(/^`+|`+$/g, '').trim()
    if (!val || /^<!--/.test(val)) continue
    if (key === 'high-risk' || key === 'do-not-edit') {
      profile[key].push(...val.split(/[,，]/).map((s) => s.trim().replace(/^`+|`+$/g, '')).filter(Boolean))
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
    for (let i = 0; i < lines.length; i += 1) {
      if (/(?:^|\s)(?:\/\/|#|\/\*)\s*(?:TODO|FIXME|HACK|XXX)\b/.test(lines[i])) {
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
  }
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

  for (const f of testFiles) {
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const lines = info.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (/\b(?:it|test|describe)\.(?:skip|only)\s*\(|\b(?:xit|xtest|xdescribe)\s*\(|@pytest\.mark\.skip|#\[\s*ignore\b|\bt\.Skip\b/.test(lines[i])) {
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
    const p = extractRepoPath(tok)
    if (p) paths.add(p)
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

  for (const cmdKey of ['quick-test', 'full-test', 'merge-gate']) {
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

function auditDocs(repoRoot, files, devProfile, defaultBranch, scopeRel, findings) {
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
  if (!isGit) return { total: 0, stale }

  const mergedBranches = new Set()
  if (defaultBranch && runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']).ok) {
    const mergedRes = runGit(repoRoot, ['branch', '--merged', defaultBranch, '--format=%(refname:short)'])
    if (mergedRes.ok && mergedRes.stdout) {
      for (const b of mergedRes.stdout.split('\n')) {
        const clean = b.trim()
        if (clean && clean !== defaultBranch) mergedBranches.add(clean)
      }
    }
  }

  const listRes = runGit(repoRoot, ['worktree', 'list', '--porcelain'])
  const registeredPaths = new Set()
  const entries = []
  if (listRes.ok && listRes.stdout) {
    let cur = null
    for (const line of listRes.stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        if (cur) entries.push(cur)
        cur = { path: resolve(line.slice(9).trim()), branch: undefined, prunable: undefined }
      } else if (cur && line.startsWith('branch refs/heads/')) {
        cur.branch = line.slice('branch refs/heads/'.length).trim()
      } else if (cur && line.startsWith('prunable')) {
        cur.prunable = line.slice(8).trim() || 'missing directory'
      }
    }
    if (cur) entries.push(cur)
  }

  const rootResolved = resolve(repoRoot)
  let registeredInDotWorktrees = 0
  for (const e of entries) {
    registeredPaths.add(e.path)
    if (e.path === rootResolved) continue
    const rel = posixPath(relative(rootResolved, e.path))
    if (!rel.startsWith('.worktrees/')) continue
    registeredInDotWorktrees += 1
    if (e.prunable) {
      stale.push({ path: rel, branch: e.branch, reason: `prunable (${e.prunable})` })
    } else if (e.branch && mergedBranches.has(e.branch)) {
      stale.push({ path: rel, branch: e.branch, reason: `branch "${e.branch}" already merged into ${defaultBranch}` })
    }
  }

  const wtContainer = join(repoRoot, '.worktrees')
  if (existsSync(wtContainer)) {
    try {
      for (const d of readdirSync(wtContainer, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '.state') continue
        const abs = resolve(wtContainer, d.name)
        if (!registeredPaths.has(abs)) {
          stale.push({ path: `.worktrees/${d.name}`, branch: undefined, reason: 'unregistered orphan directory inside .worktrees/' })
        }
      }
    } catch { /* ignore */ }
  }

  return { total: registeredInDotWorktrees, stale }
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

function auditHygiene(repoRoot, isGit, files, defaultBranch, findings) {
  const home = homedir().replace(/\\/g, '/')
  const homeRe = home.length > 4 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined

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
    addFinding(findings, {
      id: `hygiene.stale-worktree.${s.path}`,
      category: 'hygiene',
      severity: 'medium',
      file: s.path,
      title: `Stale worktree candidate: ${s.path} (${s.reason})`,
      action: 'Unmount any shared dependency junction first, confirm with user, then run `git worktree remove`.',
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

  return { worktrees: wtReport, manifest: manifestReport }
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
    lines.push('')
    lines.push('[RECONCILE]')
    lines.push(`  AGENTS.md Bytes : ${r.agentsBytes ?? 'missing'} / ${AGENTS_MAX_BYTES} (warn >= ${AGENTS_WARN_BYTES})`)
    lines.push(`  docs/TDD.md     : ${r.tddPresent ? 'present' : 'missing'}`)
    lines.push(`  Worktrees       : ${r.worktrees.total} registered, ${r.worktrees.stale.length} stale candidate(s)`)
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
    '用法：node govern-audit.mjs [reconcile] [targetDir] [options]',
    '',
    'Modes:',
    '  --audit-only                 Read-only audit outputting findings + [GAP_SCAN] (default)',
    '  --plan-only                  Generate phased remediation batches + Todo draft preview',
    '  --execute                    Guided closed-loop execution plan + verification checklist',
    '  reconcile | --reconcile      Check AGENTS.md 24KB/30KB cap & refs, TDD drift, .worktrees/, .pf-manifest.json, hygiene',
    '',
    'Options:',
    '  --dir <path>                 Repository directory (defaults to cwd or positional targetDir)',
    '  --scope <dir>                Restrict scan to subdirectory inside repository',
    '  --categories <list>          Comma-separated subset of: security,deadcode,tests,docs,hygiene,perf',
    '  --loop                       Include/track multi-round governance convergence state',
    '  --issues                     Generate UTF-8 GitHub Issue payloads (dry-run by default)',
    '  --apply-issues               Actually invoke `gh issue create --body-file` (requires --issues and gh auth)',
    '  --write-todo                 Write generated Todo draft to docs/todo/ (only with --plan-only)',
    '  --strict                     Exit 1 if critical/high findings exist',
    '  --json                       Emit machine-readable JSON',
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const opts = {
    dir: process.cwd(),
    dirSet: false,
    reconcile: false,
    auditOnly: false,
    planOnly: false,
    execute: false,
    scope: '',
    categories: null,
    loop: false,
    issues: false,
    applyIssues: false,
    writeTodo: false,
    strict: false,
    json: false,
    help: false,
  }

  const nextVal = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${flag}`)
    return argv[i + 1]
  }

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === 'reconcile' || a === '--reconcile') opts.reconcile = true
    else if (a === '--audit-only') opts.auditOnly = true
    else if (a === '--plan-only') opts.planOnly = true
    else if (a === '--execute') opts.execute = true
    else if (a === '--loop') opts.loop = true
    else if (a === '--issues') opts.issues = true
    else if (a === '--apply-issues') opts.applyIssues = true
    else if (a === '--write-todo') opts.writeTodo = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--json') opts.json = true
    else if (a === '--dir' || a === '--repo') { opts.dir = nextVal(i, a); opts.dirSet = true; i += 1 }
    else if (a === '--scope') { opts.scope = nextVal(i, a); i += 1 }
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
  const files = walkFiles(repoRoot, scopeRel)
  const trackedSet = new Set()
  let defaultBranch
  if (isGit) {
    const ls = runGit(repoRoot, ['ls-files', '-z'])
    if (ls.ok && ls.stdout) {
      for (const p of ls.stdout.split('\0')) {
        if (p) trackedSet.add(posixPath(p))
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

  if (catSet.has('security')) auditSecurity(repoRoot, files, trackedSet, findings)
  if (catSet.has('deadcode')) auditDeadcode(files, findings)
  if (catSet.has('tests')) auditTests(repoRoot, files, devProfile, findings)
  if (catSet.has('docs')) auditDocs(repoRoot, files, devProfile, defaultBranch, scopeRel, findings)
  let hygieneMeta = { worktrees: { total: 0, stale: [] }, manifest: { present: false, status: 'not-checked', issues: [] } }
  if (catSet.has('hygiene')) hygieneMeta = auditHygiene(repoRoot, isGit, files, defaultBranch, findings)
  if (catSet.has('perf')) auditPerf(repoRoot, files, findings)

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

  const mode = opts.reconcile ? 'reconcile' : opts.execute ? 'execute' : opts.planOnly ? 'plan-only' : opts.issues ? 'issues' : 'audit-only'
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
  if (mode === 'reconcile') {
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
    nextSteps.push('Run `--plan-only` to generate prioritized batches or `reconcile` to inspect AGENTS.md/TDD/worktree/.pf-manifest drift.')
  }

  const result = {
    mode,
    repoRoot: posixPath(repoRoot),
    scope: scopeRel,
    categories,
    counts,
    findings,
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
