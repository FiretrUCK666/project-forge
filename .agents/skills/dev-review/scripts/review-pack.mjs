#!/usr/bin/env node
/**
 * review-pack.mjs -- Context-isolated review pack builder, untrusted PR scanner,
 * doc-code parity checker, and 6-lock convergence ledger recorder.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules only.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1,
  USAGE_OR_POLICY: 2,
  UNTRUSTED_HAZARD: 3,
  STOP_LOSS: 4,
})

const DEV_PROFILE_KEYS = ['quick-test', 'full-test', 'merge-gate', 'high-risk', 'do-not-edit']

const LOCKFILE_NAMES = new Set([
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'cargo.lock',
  'go.sum',
  'gemfile.lock',
  'composer.lock',
  'flake.lock',
])

const LIFECYCLE_HOOK_RE = /"(?:preinstall|install|postinstall|preuninstall|uninstall|postuninstall|prepublish|prepublishOnly|preprepare|prepare|postprepare|prepack|postpack)"\s*:/

const BUILD_SCRIPT_RE = /(?:^|\/)(?:Makefile|GNUmakefile|makefile|justfile|Taskfile\.ya?ml|build\.rs|setup\.py)$|\.(?:mk)$|(?:^|\/)(?:preinstall|install|postinstall|bootstrap)\.(?:sh|bash|ps1|bat|cmd|py|mjs|js|cjs)$|(?:^|\/)(?:scripts?|tools?|build)\/[^/]*(?:build|install|setup|bootstrap|hook)[^/]*\.(?:sh|bash|ps1|bat|cmd|py|mjs|js|cjs)$/i

const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|test_[^/]+\.py$/i

const TEST_SKIP_RE = /\b(?:it|test|describe|context|suite)\.(?:skip|only)\s*\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|@(?:pytest\.mark\.skip|pytest\.mark\.skipif|unittest\.skip)|#\[\s*ignore\b|\bt\.Skip(?:f|Now)?\s*\(/

const GATE_WEAKEN_RE = /\|\|\s*true\b|continue-on-error:\s*true\b|--no-verify\b|--passWithNoTests\b|\beslint-disable(?:-next-line)?\b|@ts-nocheck\b/

const ASSERTION_RE = /\b(?:assert(?:\.\w+)?|expect|should|t\.(?:Error|Errorf|Fatal|Fatalf)|assertRaises|pytest\.raises|assert_eq!|assert!)\b|\b(?:it|test)\s*\(|\bdef\s+test_|#\[\s*test\s*\]|\bfunc\s+Test[A-Z]/

const CODE_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|py|rs|go|java|kt|rb|php|cs|c|cpp|h|hpp|sh|bash|ps1)$/i
const EXPORT_API_RE = /^\s*(?:export\s+(?:default\s+|async\s+)?(?:function|const|let|var|class|type|interface|enum|\{)|module\.exports\b|exports\.[A-Za-z0-9_]+\s*=|pub\s+(?:fn|struct|enum|trait|mod|type)\s+|func\s+[A-Z]|def\s+[a-zA-Z][a-zA-Z0-9_]*\s*\()/
const CLI_FLAG_RE = /(?:--[a-z][a-z0-9-]{1,}\b|\bprocess\.argv\b|\bargparse\b|\bcommander\b|\byargs\b|\bclap\b|\bflag\.)/

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

function readTextSafe(filePath, maxBytes = 512 * 1024) {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size > maxBytes) return undefined
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return undefined
    return buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  } catch {
    return undefined
  }
}

function readJsonSafe(filePath) {
  const txt = readTextSafe(filePath)
  if (txt === undefined) return undefined
  try { return JSON.parse(txt) } catch { return undefined }
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

function runGit(cwd, args, opts = {}) {
  const fullArgs = ['-c', 'core.quotepath=false', ...args]
  try {
    const out = execFileSync('git', fullArgs, {
      cwd,
      encoding: opts.buffer ? 'buffer' : 'utf8',
      timeout: opts.timeout ?? 20000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    })
    return {
      ok: true,
      status: 0,
      stdout: opts.buffer ? out : String(out).replace(/\r\n/g, '\n').trimEnd(),
      stderr: '',
    }
  } catch (err) {
    return {
      ok: false,
      status: typeof err?.status === 'number' ? err.status : 1,
      stdout: opts.buffer ? (err?.stdout ?? Buffer.alloc(0)) : String(err?.stdout ?? '').replace(/\r\n/g, '\n').trimEnd(),
      stderr: String(err?.stderr ?? err?.message ?? '').replace(/\r\n/g, '\n').trim(),
    }
  }
}

function findRepoRoots(startDir) {
  const target = resolve(startDir)
  const top = runGit(target, ['rev-parse', '--show-toplevel'])
  if (!top.ok || !top.stdout) return undefined
  const worktreeRoot = resolve(top.stdout.trim())
  const common = runGit(worktreeRoot, ['rev-parse', '--git-common-dir'])
  let mainRoot = worktreeRoot
  if (common.ok && common.stdout) {
    const commonAbs = resolve(worktreeRoot, common.stdout.trim())
    const parent = dirname(commonAbs)
    if (existsSync(parent)) mainRoot = parent
  }
  return { worktreeRoot, mainRoot }
}

function parseDevProfile(repoRoot) {
  const profile = {
    'quick-test': [],
    'full-test': [],
    'merge-gate': [],
    'high-risk': [],
    'do-not-edit': [],
  }
  const text = readTextSafe(join(repoRoot, 'AGENTS.md'))
  if (!text) return profile
  for (const line of text.split('\n')) {
    const m = /^\s*(?:[-*]\s*)?`?(quick-test|full-test|merge-gate|high-risk|do-not-edit)`?\s*:\s*(.+?)\s*$/.exec(line)
    if (!m) continue
    const key = m[1]
    const val = m[2].replace(/^`+|`+$/g, '').trim()
    if (!val || /^<!--/.test(val)) continue
    if (key === 'high-risk' || key === 'do-not-edit') {
      const items = val.split(/[,，]/).map((s) => s.trim().replace(/^`+|`+$/g, '')).filter(Boolean)
      profile[key].push(...items)
    } else {
      profile[key].push(val)
    }
  }
  return profile
}

function hasCommits(repoRoot) {
  return runGit(repoRoot, ['rev-parse', '--verify', 'HEAD']).ok
}

function resolveDefaultBaseRef(repoRoot) {
  const sym = runGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  if (sym.ok && sym.stdout.trim()) {
    const ref = sym.stdout.trim()
    if (runGit(repoRoot, ['rev-parse', '--verify', ref]).ok) return ref
  }
  for (const cand of ['main', 'master', 'origin/main', 'origin/master', 'trunk']) {
    if (runGit(repoRoot, ['rev-parse', '--verify', cand]).ok) return cand
  }
  return undefined
}

function computeDiffRange(repoRoot, baseRef, headRef) {
  const mb = runGit(repoRoot, ['merge-base', baseRef, headRef])
  if (mb.ok && mb.stdout.trim()) return `${mb.stdout.trim()}..${headRef}`
  return `${baseRef}..${headRef}`
}

function collectDiff(repoRoot, spec) {
  const argsBase = ['diff', '--no-ext-diff', '--no-color']
  let diffArgs
  let nameStatusArgs
  if (spec.mode === 'local') {
    if (hasCommits(repoRoot)) {
      diffArgs = [...argsBase, 'HEAD']
      nameStatusArgs = ['diff', '--name-status', 'HEAD']
    } else {
      diffArgs = [...argsBase, '--cached']
      nameStatusArgs = ['diff', '--name-status', '--cached']
    }
  } else if (spec.mode === 'staged') {
    diffArgs = [...argsBase, '--cached']
    nameStatusArgs = ['diff', '--name-status', '--cached']
  } else {
    diffArgs = [...argsBase, spec.range]
    nameStatusArgs = ['diff', '--name-status', spec.range]
  }

  const rawBufRes = runGit(repoRoot, diffArgs, { buffer: true })
  const rawBuf = Buffer.isBuffer(rawBufRes.stdout) ? rawBufRes.stdout : Buffer.from('')
  const sha256 = createHash('sha256').update(rawBuf).digest('hex')
  const bytes = rawBuf.length
  const text = rawBuf.toString('utf8').replace(/\r\n/g, '\n')

  const ns = runGit(repoRoot, nameStatusArgs)
  const files = []
  if (ns.ok && ns.stdout) {
    for (const line of ns.stdout.split('\n')) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      const status = parts[0].trim()
      const file = posixPath(parts[parts.length - 1].trim())
      files.push({ status, file, oldFile: parts.length > 2 ? posixPath(parts[1].trim()) : undefined })
    }
  }

  const untracked = []
  if (spec.mode === 'local') {
    const st = runGit(repoRoot, ['ls-files', '--others', '--exclude-standard'])
    if (st.ok && st.stdout) {
      for (const f of st.stdout.split('\n')) {
        if (f.trim()) untracked.push(posixPath(f.trim()))
      }
    }
  }

  return { sha256, bytes, text, files, untracked }
}

function splitDiffByFile(diffText) {
  const chunks = new Map()
  const lines = String(diffText ?? '').split('\n')
  let currentFile = null
  let buf = []
  const flush = () => {
    if (currentFile !== null) chunks.set(currentFile, buf.join('\n'))
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush()
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
      currentFile = m ? posixPath(m[2]) : null
      buf = [line]
    } else if (currentFile !== null) {
      if (line.startsWith('+++ b/')) currentFile = posixPath(line.slice(6).trim())
      else if (line.startsWith('--- a/') && currentFile === null) currentFile = posixPath(line.slice(6).trim())
      buf.push(line)
    }
  }
  flush()
  return chunks
}

function summarizeHunkChanges(fileDiff) {
  const added = []
  const removed = []
  for (const line of String(fileDiff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) added.push(line.slice(1))
    else if (line.startsWith('-')) removed.push(line.slice(1))
  }
  return { added, removed }
}

/**
 * Static supply-chain and gate-weakening scanner for untrusted diffs.
 * Scans changed file paths + added/removed hunk lines BEFORE running any code.
 */
function scanUntrustedDiff(diff, repoRoot) {
  const hazards = []
  const chunks = splitDiffByFile(diff.text)
  const allFiles = [...diff.files, ...diff.untracked.map((file) => ({ status: '?', file }))]

  for (const entry of allFiles) {
    const f = entry.file
    const base = f.split('/').pop()?.toLowerCase() ?? ''
    const fileDiff = chunks.get(f) ?? ''
    let { added, removed } = summarizeHunkChanges(fileDiff)
    if (entry.status === '?' && added.length === 0 && repoRoot) {
      const raw = readTextSafe(join(repoRoot, f))
      if (raw) added = raw.split('\n')
    }
    const excerpt = [...added.slice(0, 4).map((l) => `+ ${l}`), ...removed.slice(0, 2).map((l) => `- ${l}`)]

    if (f.startsWith('.github/workflows/') || f.startsWith('.github/actions/')) {
      hazards.push({
        category: 'workflow',
        file: f,
        reason: 'Modifies CI/workflow automation (privileged execution surface)',
        excerpt,
      })
      continue
    }

    if (f.startsWith('.husky/') || f.startsWith('.githooks/') || f.startsWith('.git/hooks/')) {
      hazards.push({
        category: 'git-hook',
        file: f,
        reason: 'Modifies local git hooks that run automatically on git commands',
        excerpt,
      })
      continue
    }

    if (f.startsWith('.agents/skills/')) {
      hazards.push({
        category: 'agent-skills',
        file: f,
        reason: 'Modifies local agent skills / executable skill scripts',
        excerpt,
      })
      continue
    }

    if (f === '.gitattributes') {
      hazards.push({
        category: 'gitattributes',
        file: f,
        reason: 'Modifies .gitattributes (package boundaries / filter / diff attributes)',
        excerpt,
      })
      continue
    }

    if (LOCKFILE_NAMES.has(base)) {
      hazards.push({
        category: 'lockfile',
        file: f,
        reason: 'Modifies dependency lockfile (check for registry/tarball/git URL tampering)',
        excerpt,
      })
      continue
    }

    if (base === 'package.json') {
      const hookLines = added.filter((l) => LIFECYCLE_HOOK_RE.test(l))
      if (hookLines.length > 0) {
        hazards.push({
          category: 'lifecycle-hook',
          file: f,
          reason: 'Adds or modifies npm lifecycle hook script (preinstall/install/postinstall/prepare)',
          excerpt: hookLines.slice(0, 5).map((l) => `+ ${l}`),
        })
      }
    } else if (BUILD_SCRIPT_RE.test(f)) {
      hazards.push({
        category: 'build-script',
        file: f,
        reason: 'Modifies Makefile or build/install script',
        excerpt,
      })
    }

    // Gate-weakening heuristics on code/test/config files
    const skipHits = added.filter((l) => TEST_SKIP_RE.test(l))
    if (skipHits.length > 0) {
      hazards.push({
        category: 'gate-weakening',
        file: f,
        reason: 'Adds test skip/only/ignore marker',
        excerpt: skipHits.slice(0, 4).map((l) => `+ ${l}`),
      })
    }

    const weakenHits = added.filter((l) => GATE_WEAKEN_RE.test(l))
    if (weakenHits.length > 0) {
      hazards.push({
        category: 'gate-weakening',
        file: f,
        reason: 'Adds gate-bypass or error-suppression directive',
        excerpt: weakenHits.slice(0, 4).map((l) => `+ ${l}`),
      })
    }

    if (TEST_FILE_RE.test(f)) {
      const removedAssertions = removed.filter((l) => ASSERTION_RE.test(l))
      const addedAssertions = added.filter((l) => ASSERTION_RE.test(l))
      if (removedAssertions.length > 0 && addedAssertions.length < removedAssertions.length) {
        hazards.push({
          category: 'gate-weakening',
          file: f,
          reason: `Removes ${removedAssertions.length} assertion/test line(s) with only ${addedAssertions.length} replacement(s)`,
          excerpt: removedAssertions.slice(0, 4).map((l) => `- ${l}`),
        })
      }
    }
  }

  return hazards
}

/**
 * Checks whether code surface changes (exported API, CLI flags, module structure,
 * runtime requirements, or high-risk files) lack corresponding doc updates,
 * and checks open [ ] checkboxes or unarchived docs/todo/ files.
 */
function checkDocCodeParity(repoRoot, mainRoot, diff, devProfile, task) {
  const changedFiles = new Set(diff.files.map((f) => f.file))
  for (const u of diff.untracked) changedFiles.add(u)
  const chunks = splitDiffByFile(diff.text)

  const docCandidates = ['docs/TDD.md', 'README.md', 'README.en.md', 'AGENTS.md']
  const existingDocs = docCandidates.filter((d) => existsSync(join(repoRoot, d)))
  const docsTouched = [...changedFiles].filter((f) =>
    f === 'docs/TDD.md' || /^README(?:\.[^/]+)?\.md$/i.test(f) || f === 'AGENTS.md' || f.endsWith('/AGENTS.md'),
  )

  const triggers = []
  const inspectParityFile = (f, status, lines) => {
    if (f.startsWith('docs/') || f.endsWith('.md')) return
    if (status.startsWith('A') || status.startsWith('D') || status.startsWith('R') || status === '?') {
      if (CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f)) {
        triggers.push({ type: 'module-structure', file: f, detail: `File ${status} changes module layout` })
      }
    }
    if (CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f)) {
      if (lines.some((l) => EXPORT_API_RE.test(l))) {
        triggers.push({ type: 'exported-api', file: f, detail: 'Exported API signature touched' })
      }
      if (lines.some((l) => CLI_FLAG_RE.test(l))) {
        triggers.push({ type: 'cli-options', file: f, detail: 'CLI option/argument handling touched' })
      }
    }
    const base = f.split('/').pop()
    if (['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', '.nvmrc', '.python-version'].includes(base)) {
      if (lines.some((l) => /engines|requires-python|rust-version|^go\s+/i.test(l)) || base === '.nvmrc' || base === '.python-version') {
        triggers.push({ type: 'runtime-req', file: f, detail: 'Environment/runtime requirements touched' })
      }
    }
    for (const hr of devProfile['high-risk']) {
      const norm = hr.replace(/^\.\//, '')
      if (norm && (f === norm || (norm.endsWith('/') && f.startsWith(norm)) || f.startsWith(`${norm}/`))) {
        triggers.push({ type: 'high-risk-path', file: f, detail: `Matches high-risk rule "${hr}"` })
      }
    }
  }

  for (const entry of diff.files) {
    const fileDiff = chunks.get(entry.file) ?? ''
    const { added, removed } = summarizeHunkChanges(fileDiff)
    inspectParityFile(entry.file, entry.status, [...added, ...removed])
  }
  for (const u of diff.untracked) {
    const raw = readTextSafe(join(repoRoot, u))
    inspectParityFile(u, '?', raw ? raw.split('\n') : [])
  }

  const todoIssues = []
  const todoDir = join(repoRoot, 'docs', 'todo')
  const checkTodoFile = (relPath) => {
    let normRel = posixPath(relPath)
    let abs = join(repoRoot, normRel)
    if (!existsSync(abs) && normRel.startsWith('docs/todo/')) {
      const archivedRel = `docs/archive/todo/${normRel.slice('docs/todo/'.length)}`
      const archivedAbs = join(repoRoot, archivedRel)
      if (existsSync(archivedAbs)) {
        normRel = archivedRel
        abs = archivedAbs
      }
    }
    const txt = readTextSafe(abs)
    if (!txt) return
    const unchecked = (txt.match(/^- \[ \]\s+.+$/gm) ?? []).length
    const isArchived = normRel.startsWith('docs/archive/todo/')
    if (unchecked > 0 || !isArchived) {
      todoIssues.push({
        file: normRel,
        unchecked,
        unarchived: !isArchived,
      })
    }
  }

  if (task?.todoFile) checkTodoFile(task.todoFile)
  for (const f of changedFiles) {
    if (f.startsWith('docs/todo/') && f.endsWith('.md')) {
      if (!todoIssues.some((t) => t.file === f)) checkTodoFile(f)
    }
  }
  if (task && existsSync(todoDir)) {
    try {
      for (const name of readdirSync(todoDir)) {
        if (!name.endsWith('.md')) continue
        const rel = `docs/todo/${name}`
        if (!todoIssues.some((t) => t.file === rel) && (!task.slug || name.includes(task.slug))) {
          checkTodoFile(rel)
        }
      }
    } catch { /* ignore */ }
  }

  const parityMissingDocs = triggers.length > 0 && existingDocs.length > 0 && docsTouched.length === 0
  return {
    triggers,
    existingDocs,
    docsTouched,
    parityMissingDocs,
    todoIssues,
  }
}

function parseAcceptanceCriteria(repoRoot, mainRoot, task) {
  const criteria = []
  const seen = new Set()
  const readFrom = (relPath) => {
    if (!relPath) return
    const p1 = join(repoRoot, relPath)
    const p2 = join(mainRoot, relPath)
    const txt = readTextSafe(p1) ?? readTextSafe(p2)
    if (!txt) return
    for (const line of txt.split('\n')) {
      const m = /^- \[([ xX])\]\s+(C\d+)\s*:\s*(.+)$/.exec(line.trim())
      if (!m) continue
      const id = m[2]
      if (seen.has(id)) continue
      seen.add(id)
      criteria.push({ id, checked: m[1].toLowerCase() === 'x', text: m[3].trim(), source: posixPath(relPath) })
    }
  }
  readFrom(task?.specFile)
  readFrom(task?.todoFile)
  return criteria
}

function taskFilePath(mainRoot, taskId) {
  return join(mainRoot, '.worktrees', '.state', 'tasks', `${taskId}.json`)
}

function findTaskByPr(mainRoot, prNumber) {
  const dir = join(mainRoot, '.worktrees', '.state', 'tasks')
  if (!existsSync(dir)) return undefined
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const data = readJsonSafe(join(dir, name))
    if (data && String(data.prNumber) === String(prNumber)) return data
  }
  return undefined
}

function parseMustFixItem(raw, idx) {
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(raw)
      return normalizeMustFixObj(obj, idx)
    } catch { /* fall back to text */ }
  }
  const text = String(raw ?? '').trim()
  const cMatch = /^(C\d+)\s*[:：-]\s*(.+)$/i.exec(text)
  const criterion = cMatch ? cMatch[1].toUpperCase() : undefined
  const body = cMatch ? cMatch[2].trim() : text
  const fp = computeFingerprint(criterion, '', body)
  return {
    id: criterion ?? `MF-${idx + 1}`,
    criterion,
    file: '',
    summary: text,
    fingerprint: fp,
    status: 'open',
  }
}

function normalizeMustFixObj(obj, idx) {
  const criterion = obj.criterion || (/^C\d+$/i.test(String(obj.id ?? '')) ? String(obj.id).toUpperCase() : undefined)
  const file = posixPath(obj.file ?? '')
  const summary = String(obj.summary ?? obj.message ?? obj.text ?? obj.id ?? '').trim()
  const fp = obj.fingerprint ? String(obj.fingerprint).trim() : computeFingerprint(criterion, file, summary)
  return {
    id: String(obj.id ?? criterion ?? `MF-${idx + 1}`),
    criterion,
    file,
    summary,
    fingerprint: fp,
    status: obj.status ?? 'open',
  }
}

function computeFingerprint(criterion, file, summary) {
  const normSummary = String(summary ?? '')
    .toLowerCase()
    .replace(/:\d+(?::\d+)?/g, '')
    .replace(/\bline\s+\d+\b/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
  const key = [criterion ? criterion.toUpperCase() : '', posixPath(file).toLowerCase(), normSummary]
    .filter(Boolean)
    .join('|')
  return createHash('sha1').update(key || 'empty').digest('hex').slice(0, 12)
}

function resolveReviewWorktree(mainRoot, worktreeRoot, opts, task) {
  if (opts.worktree) return resolve(opts.worktree)
  if (task?.reviewWorktreePath) {
    const cand = resolve(mainRoot, task.reviewWorktreePath)
    if (existsSync(cand)) return cand
  }
  if (opts.task) {
    const cand = join(mainRoot, '.worktrees', `review-${opts.task}`)
    if (existsSync(cand)) return cand
  }
  if (opts.pr) {
    const cand = join(mainRoot, '.worktrees', `review-pr-${opts.pr}`)
    if (existsSync(cand)) return cand
  }
  if (task?.worktreePath) {
    const cand = resolve(mainRoot, task.worktreePath)
    if (existsSync(cand)) return cand
  }
  return worktreeRoot
}

function highRiskHits(diff, devProfile) {
  const hits = []
  const rules = devProfile['high-risk']
  for (const entry of diff.files) {
    for (const rule of rules) {
      const clean = posixPath(rule).replace(/^\.\//, '')
      if (!clean) continue
      if (entry.file === clean || (clean.endsWith('/') && entry.file.startsWith(clean)) || entry.file.startsWith(`${clean}/`)) {
        hits.push({ file: entry.file, rule })
      }
    }
  }
  return hits
}

function formatPackText(pack) {
  const lines = []
  lines.push(`=== DEV-REVIEW PACK (${pack.mode.toUpperCase()}) ===`)
  lines.push(`Worktree : ${pack.worktreeRoot}`)
  lines.push(`Round    : ${pack.round}${pack.roundLockNote ? ` (${pack.roundLockNote})` : ''}`)
  lines.push(`Scope    : ${pack.diffScope}`)
  lines.push(`Head SHA : ${pack.headSha}`)
  lines.push(`Diff Hash: sha256:${pack.diff.sha256} (${pack.diff.bytes} bytes, ${pack.diff.files.length} changed, ${pack.diff.untracked.length} untracked)`)
  if (pack.task) {
    lines.push(`Task     : ${pack.task.taskId} | role=${pack.task.role ?? 'unknown'} | finalized=${Boolean(pack.task.finalized)} | verifiedHead=${pack.task.verifiedHead ?? 'none'}`)
    if (pack.headMismatchWarning) lines.push(`WARNING  : ${pack.headMismatchWarning}`)
  }

  if (pack.criteria.length > 0) {
    lines.push('')
    lines.push('--- Frozen Acceptance Criteria ---')
    for (const c of pack.criteria) {
      lines.push(`  [${c.checked ? 'x' : ' '}] ${c.id}: ${c.text} (${c.source})`)
    }
  }

  if (pack.priorOpenMustFix.length > 0 || pack.rebuts.length > 0) {
    lines.push('')
    lines.push('--- Prior Round Open Must-Fix & Rebuts ---')
    for (const mf of pack.priorOpenMustFix) {
      lines.push(`  - [${mf.id}] (fp:${mf.fingerprint}) ${mf.summary}`)
    }
    for (const rb of pack.rebuts) {
      lines.push(`  * Rebut: ${typeof rb === 'string' ? rb : JSON.stringify(rb)}`)
    }
  }

  lines.push('')
  lines.push('--- Changed Files ---')
  if (pack.diff.files.length === 0 && pack.diff.untracked.length === 0) {
    lines.push('  (no changes in scope)')
  } else {
    for (const f of pack.diff.files) lines.push(`  ${f.status}\t${f.file}`)
    for (const u of pack.diff.untracked) lines.push(`  ?\t${u}`)
  }

  lines.push('')
  lines.push('--- Doc-Code Parity Gate ---')
  if (pack.parity.triggers.length === 0 && pack.parity.todoIssues.length === 0) {
    lines.push('  OK: No unaddressed API/CLI/module doc parity drift or open Todo detected.')
  } else {
    if (pack.parity.parityMissingDocs) {
      lines.push(`  ${pack.isFlowMode ? '[MUST_FIX_CANDIDATE]' : '[PARITY_WARN]'} Code surface changed without updating docs (${pack.parity.existingDocs.join(', ')}):`)
    } else if (pack.parity.triggers.length > 0) {
      lines.push('  Parity triggers (docs also touched in diff — verify accuracy):')
    }
    for (const t of pack.parity.triggers.slice(0, 12)) {
      lines.push(`    - [${t.type}] ${t.file}: ${t.detail}`)
    }
    for (const td of pack.parity.todoIssues) {
      lines.push(`    - ${pack.isFlowMode ? '[MUST_FIX_CANDIDATE]' : '[TODO_WARN]'} ${td.file}: unchecked=${td.unchecked}, unarchived=${td.unarchived}`)
    }
  }

  lines.push('')
  lines.push('--- Empirical Test & Fault Injection Checklist ---')
  const cmds = [
    ...pack.devProfile['quick-test'],
    ...pack.devProfile['full-test'],
    ...pack.devProfile['merge-gate'],
  ]
  if (cmds.length > 0) {
    lines.push('  Run project verification commands (do not guess pass/fail):')
    for (const cmd of cmds) lines.push(`    $ ${cmd}`)
  } else {
    lines.push('  No Dev Profile test commands in AGENTS.md; run repository test suite manually.')
  }
  if (pack.highRiskHits.length > 0) {
    lines.push('  HIGH-RISK PATHS TOUCHED (mandatory fault injection in detached review worktree):')
    for (const h of pack.highRiskHits) lines.push(`    - ${h.file} (rule: ${h.rule})`)
  }
  lines.push('  Fault Injection Protocol (NO speculative nitpicks allowed):')
  lines.push('    1. Temporarily break 1 core branch/guard in the review worktree and run test -> MUST FAIL.')
  lines.push('    2. Restore cleanly (`git checkout -- .`) and re-run test -> MUST PASS.')
  lines.push('    3. Classify findings strictly: Must Fix / Should Fix / Pre-existing (list all R1 locations at once).')

  if (pack.untrustedWarnings.length > 0) {
    lines.push('')
    lines.push('--- [APPROVED_EXEC_WITH_WARNINGS] ---')
    lines.push('  Human execution approval active. Use `--ignore-scripts` for dependency install.')
    for (const h of pack.untrustedWarnings) {
      lines.push(`  - [${h.category}] ${h.file}: ${h.reason}`)
    }
  }

  if (pack.diffText) {
    const diffLines = pack.diffText.split('\n')
    const maxLines = 240
    lines.push('')
    lines.push('--- Diff Patch (Context-Isolated) ---')
    lines.push(...diffLines.slice(0, maxLines))
    if (diffLines.length > maxLines) {
      lines.push(`... (truncated ${diffLines.length - maxLines} more lines; run git diff ${pack.diffScope} to inspect full patch)`)
    }
  }

  lines.push('')
  lines.push('[NEXT STEP]')
  for (const step of pack.nextSteps) lines.push(`  ${step}`)
  return lines.join('\n')
}

function handleRecord(args, roots) {
  const { worktreeRoot, mainRoot } = roots
  const taskId = args.task
  if (!taskId) {
    process.stderr.write('Error: record requires --task <id>\n')
    return EXIT.USAGE_OR_POLICY
  }
  const round = Number(args.round)
  if (!Number.isInteger(round) || round < 1) {
    process.stderr.write('Error: record requires integer --round <1|2|3...>\n')
    return EXIT.USAGE_OR_POLICY
  }
  const verdict = String(args.verdict ?? '').toLowerCase()
  if (verdict !== 'pass' && verdict !== 'changes') {
    process.stderr.write('Error: record requires --verdict pass|changes\n')
    return EXIT.USAGE_OR_POLICY
  }
  const reviewerId = String(args.reviewerId ?? '').trim()
  if (!reviewerId) {
    process.stderr.write('Error: record requires non-empty --reviewer-id <id>\n')
    return EXIT.USAGE_OR_POLICY
  }

  const tPath = taskFilePath(mainRoot, taskId)
  const existing = readJsonSafe(tPath) ?? {
    taskId,
    rounds: [],
    implementerId: args.implementerId ?? undefined,
  }
  const implementerId = String(args.implementerId ?? existing.implementerId ?? '').trim()

  if (implementerId && reviewerId === implementerId) {
    const msg = `SELF_REVIEW_REJECTED: reviewerId (${reviewerId}) equals implementerId (${implementerId}). Independent review requires a distinct reviewer.`
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ status: 'SELF_REVIEW_REJECTED', error: msg, taskId, round, reviewerId, implementerId }, null, 2)}\n`)
    } else {
      process.stdout.write(`${msg}\n`)
    }
    process.stderr.write(`${msg}\n`)
    return EXIT.USAGE_OR_POLICY
  }

  const mustFixList = []
  for (let i = 0; i < args.mustFix.length; i += 1) {
    const raw = args.mustFix[i]
    if (typeof raw === 'string' && raw.trim().startsWith('[')) {
      try {
        const arr = JSON.parse(raw)
        if (Array.isArray(arr)) {
          arr.forEach((item, j) => mustFixList.push(normalizeMustFixObj(item, mustFixList.length + j)))
          continue
        }
      } catch { /* fallback */ }
    }
    mustFixList.push(parseMustFixItem(raw, i))
  }

  if (verdict === 'pass' && mustFixList.length > 0) {
    process.stderr.write('Error: cannot record --verdict pass when --must-fix items are present.\n')
    return EXIT.USAGE_OR_POLICY
  }

  const shouldFixList = args.shouldFix.map((s) => String(s).trim()).filter(Boolean)
  const rebutAccepted = new Set(args.rebutAccepted.map((s) => String(s).trim().toLowerCase()).filter(Boolean))

  const prevRounds = Array.isArray(existing.rounds) ? [...existing.rounds] : []
  const prevRound = prevRounds.find((r) => r.round === round - 1) ?? prevRounds[prevRounds.length - 1]
  const prevOpen = prevRound
    ? (prevRound.mustFix ?? []).filter((m) => m.status !== 'rebutted' && m.status !== 'resolved')
    : []

  // Mark rebutted items if reviewer explicitly accepted rebuts
  const remainingFromPrev = []
  for (const pm of prevOpen) {
    const matchesRebut = rebutAccepted.has(String(pm.id).toLowerCase())
      || rebutAccepted.has(String(pm.fingerprint).toLowerCase())
      || (pm.criterion && rebutAccepted.has(pm.criterion.toLowerCase()))
    if (!matchesRebut) remainingFromPrev.push(pm)
  }

  // Detect repeated fingerprint across consecutive rounds
  const prevFps = new Set(remainingFromPrev.map((m) => m.fingerprint))
  const prevCriteria = new Set(remainingFromPrev.map((m) => m.criterion).filter(Boolean))
  const repeatedItems = mustFixList.filter((m) =>
    prevFps.has(m.fingerprint) || (m.criterion && prevCriteria.has(m.criterion)),
  )

  const headRes = runGit(worktreeRoot, ['rev-parse', 'HEAD'])
  const headSha = args.head || (headRes.ok ? headRes.stdout.trim() : 'unknown')

  const openCount = mustFixList.length
  const maxRoundsExceeded = round >= 3 && (verdict === 'changes' || openCount > 0)
  const repeatedTrigger = round >= 2 && repeatedItems.length > 0
  const stopLoss = maxRoundsExceeded || repeatedTrigger

  const stopReasons = []
  if (maxRoundsExceeded) stopReasons.push(`round ${round} >= 3 with unresolved verdict/blockers`)
  if (repeatedTrigger) stopReasons.push(`repeated blocker fingerprint across consecutive rounds: ${repeatedItems.map((i) => `${i.id}(${i.fingerprint})`).join(', ')}`)

  const roundEntry = {
    round,
    headSha,
    reviewerId,
    verdict,
    blockers: mustFixList.map((m) => m.summary),
    mustFix: mustFixList,
    shouldFix: shouldFixList,
    rebuts: prevRound?.rebuts ?? [],
    rebutAccepted: [...rebutAccepted],
    faultInjection: args.faultInjection ?? '',
    stopLossTriggered: stopLoss,
    stopLossReasons: stopReasons,
    recordedAt: new Date().toISOString(),
  }

  const filteredRounds = prevRounds.filter((r) => r.round !== round)
  filteredRounds.push(roundEntry)
  filteredRounds.sort((a, b) => a.round - b.round)

  const updated = {
    ...existing,
    taskId,
    implementerId: implementerId || existing.implementerId,
    reviewerId,
    rounds: filteredRounds,
    lastReview: {
      round,
      verdict,
      headSha,
      reviewerId,
      stopLossTriggered: stopLoss,
      stopLossReasons: stopReasons,
    },
  }
  if (verdict === 'pass' && !stopLoss) {
    updated.reviewPassed = true
    updated.reviewPassedHead = headSha
  } else {
    updated.reviewPassed = false
  }

  writeAtomic(tPath, `${JSON.stringify(updated, null, 2)}\n`)

  if (stopLoss) {
    const payload = {
      status: 'STOP_LOSS_ESCALATE',
      exitCode: EXIT.STOP_LOSS,
      taskId,
      round,
      reasons: stopReasons,
      unresolvedMustFix: mustFixList,
      ledgerPath: posixPath(tPath),
      nextStep: 'Halt automated review-rework loop. Escalate to human maintainer with remaining blockers and root-cause analysis.',
    }
    if (args.json) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    } else {
      const out = [
        'STOP_LOSS_ESCALATE',
        `Task     : ${taskId}`,
        `Round    : ${round}`,
        `Exit Code: ${EXIT.STOP_LOSS} (escalate to human maintainer)`,
        `Reasons  : ${stopReasons.join('; ')}`,
        'Remaining Must-Fix:',
        ...(mustFixList.length > 0 ? mustFixList.map((m) => `  - [${m.id}] (fp:${m.fingerprint}) ${m.summary}`) : ['  - (verdict=changes at round >= 3)']),
        '',
        '[NEXT STEP]',
        '  Stop the automated review loop and hand this report + ledger to the human maintainer to decide scope/direction.',
      ].join('\n')
      process.stdout.write(`${out}\n`)
    }
    process.stderr.write(`STOP_LOSS_ESCALATE: ${stopReasons.join('; ')} (exit ${EXIT.STOP_LOSS})\n`)
    return EXIT.STOP_LOSS
  }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({
      status: verdict === 'pass' ? 'REVIEW_PASSED' : 'CHANGES_REQUESTED',
      taskId,
      round,
      headSha,
      reviewerId,
      mustFixCount: mustFixList.length,
      ledgerPath: posixPath(tPath),
    }, null, 2)}\n`)
  } else {
    const lines = [
      verdict === 'pass' ? 'REVIEW_PASSED' : 'CHANGES_REQUESTED',
      `Task     : ${taskId} | Round ${round} | HEAD ${headSha}`,
      `Reviewer : ${reviewerId}`,
      `Ledger   : ${posixPath(tPath)}`,
      ...(mustFixList.length > 0 ? ['Open Must-Fix:', ...mustFixList.map((m) => `  - [${m.id}] (fp:${m.fingerprint}) ${m.summary}`)] : []),
      '',
      '[NEXT STEP]',
      verdict === 'pass'
        ? '  Proceed to merge step via dev-flow (`merge --task ' + taskId + '`), respecting repo merge authority rules.'
        : '  Implementer: fix Must-Fix items on the SAME branch (`rework --task ' + taskId + '`), re-run `verify`, update PR, then invoke Round ' + (round + 1) + '.',
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return EXIT.OK
}

function printHelp() {
  process.stdout.write([
    '用法：node review-pack.mjs [mode/options]',
    '',
    'Modes:',
    '  --local                       Review working tree + staged uncommitted changes',
    '  --staged                      Review staged changes only',
    '  --base <ref>                  Review HEAD against <ref> (base...HEAD)',
    '  --task <id> [--round <1|2|3>] Build flow review pack from .worktrees/.state/tasks/<id>.json',
    '  --pr <M>                      Build external/internal PR review pack (auto-runs untrusted scan)',
    '  record                        Record round verdict & trigger 6-lock stop-loss if needed',
    '',
    'Options:',
    '  --worktree <path>             Explicit review worktree path',
    '  --dir <path>                  Repository directory (defaults to cwd)',
    '  --head <ref>                  Override head ref (default HEAD)',
    '  --untrusted-scan              Run static supply-chain & gate-weakening scan before execution',
    '  --human-approved-exec         Allow continuing past untrusted hazard gate (recommends --ignore-scripts)',
    '  --json                        Emit machine-readable JSON',
    '',
    'Record Options:',
    '  --task <id> --round <N> --verdict pass|changes --reviewer-id <id>',
    '  [--implementer-id <id>] [--must-fix <textOrJson>...] [--should-fix <text>...]',
    '  [--rebut-accepted <idOrFp>...] [--fault-injection <text>] [--head <sha>]',
    '',
    `Exit Codes: 0=ok, 1=error, 2=usage/self-review, ${EXIT.UNTRUSTED_HAZARD}=BLOCKED_UNTRUSTED_HAZARD, ${EXIT.STOP_LOSS}=STOP_LOSS_ESCALATE`,
    '',
  ].join('\n'))
}

function parseArgs(argv) {
  const opts = {
    subcommand: null,
    dir: process.cwd(),
    worktree: undefined,
    local: false,
    staged: false,
    base: undefined,
    head: undefined,
    task: undefined,
    pr: undefined,
    round: undefined,
    untrustedScan: false,
    humanApprovedExec: false,
    json: false,
    verdict: undefined,
    reviewerId: undefined,
    implementerId: undefined,
    mustFix: [],
    shouldFix: [],
    rebutAccepted: [],
    faultInjection: undefined,
    help: false,
  }

  let i = 0
  if (argv[0] && !argv[0].startsWith('-')) {
    if (argv[0] === 'record' || argv[0] === 'pack') {
      opts.subcommand = argv[0]
      i = 1
    }
  }

  const nextVal = (flag) => {
    if (i + 1 >= argv.length) throw new Error(`Missing value for ${flag}`)
    i += 1
    return argv[i]
  }

  for (; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--dir' || a === '--repo') opts.dir = nextVal(a)
    else if (a === '--worktree') opts.worktree = nextVal(a)
    else if (a === '--local') opts.local = true
    else if (a === '--staged') opts.staged = true
    else if (a === '--base') opts.base = nextVal(a)
    else if (a === '--head') opts.head = nextVal(a)
    else if (a === '--task') opts.task = nextVal(a)
    else if (a === '--pr') opts.pr = nextVal(a)
    else if (a === '--round') opts.round = nextVal(a)
    else if (a === '--untrusted-scan') opts.untrustedScan = true
    else if (a === '--human-approved-exec') opts.humanApprovedExec = true
    else if (a === '--json') opts.json = true
    else if (a === '--verdict') opts.verdict = nextVal(a)
    else if (a === '--reviewer-id') opts.reviewerId = nextVal(a)
    else if (a === '--implementer-id') opts.implementerId = nextVal(a)
    else if (a === '--must-fix') opts.mustFix.push(nextVal(a))
    else if (a === '--should-fix') opts.shouldFix.push(nextVal(a))
    else if (a === '--rebut-accepted') opts.rebutAccepted.push(nextVal(a))
    else if (a === '--fault-injection') opts.faultInjection = nextVal(a)
    else throw new Error(`Unknown option: ${a}`)
  }
  return opts
}

function main() {
  let opts
  try {
    opts = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`)
    return EXIT.USAGE_OR_POLICY
  }

  if (opts.help) {
    printHelp()
    return EXIT.OK
  }

  const startDir = opts.worktree ? resolve(opts.worktree) : resolve(opts.dir)
  const roots = findRepoRoots(startDir)
  if (!roots) {
    process.stderr.write(`Error: not inside a git repository: ${startDir}\n`)
    return EXIT.ERROR
  }

  if (opts.subcommand === 'record') {
    return handleRecord(opts, roots)
  }

  const { mainRoot } = roots
  let task = opts.task ? readJsonSafe(taskFilePath(mainRoot, opts.task)) : undefined
  if (opts.task && !task) {
    process.stderr.write(`Error: task ledger not found at ${posixPath(taskFilePath(mainRoot, opts.task))}\n`)
    return EXIT.ERROR
  }
  if (!task && opts.pr) {
    task = findTaskByPr(mainRoot, opts.pr)
  }

  const reviewRoot = resolveReviewWorktree(mainRoot, roots.worktreeRoot, opts, task)
  const isFlowMode = Boolean(opts.task || opts.pr)
  const mode = opts.staged ? 'staged' : opts.local ? 'local' : opts.task ? 'task' : opts.pr ? 'pr' : opts.base ? 'base' : 'local'

  // Determine round & diff range
  let round = opts.round ? Number(opts.round) : 1
  if (!opts.round && task?.rounds?.length) {
    round = Math.min(3, Math.max(...task.rounds.map((r) => Number(r.round) || 1)) + 1)
  }
  if (!Number.isInteger(round) || round < 1) round = 1

  const headRef = opts.head ?? 'HEAD'
  const headRes = hasCommits(reviewRoot) ? runGit(reviewRoot, ['rev-parse', headRef]) : { ok: false, stdout: 'UNBORN' }
  const headSha = headRes.ok ? headRes.stdout.trim() : 'UNBORN'

  let diffSpec
  let diffScope
  let roundLockNote = ''
  let priorOpenMustFix = []
  let rebuts = []

  if (mode === 'local' || mode === 'staged') {
    diffSpec = { mode }
    diffScope = mode === 'staged' ? 'staged index' : 'working tree + staged index'
  } else {
    let baseRef = opts.base ?? task?.baseSha ?? task?.baseBranch ?? resolveDefaultBaseRef(reviewRoot)
    if (!baseRef && hasCommits(reviewRoot)) {
      if (runGit(reviewRoot, ['rev-parse', '--verify', `${headRef}~1`]).ok) baseRef = `${headRef}~1`
    }

    if (mode === 'task' && round >= 2 && Array.isArray(task?.rounds)) {
      const targetPrevRound = round === 2 ? 1 : 2
      const prev = task.rounds.find((r) => r.round === targetPrevRound) ?? task.rounds[task.rounds.length - 1]
      priorOpenMustFix = prev ? (prev.mustFix ?? []).filter((m) => m.status !== 'rebutted' && m.status !== 'resolved') : []
      rebuts = [...(Array.isArray(task.rebuts) ? task.rebuts : []), ...(Array.isArray(prev?.rebuts) ? prev.rebuts : [])]
      const prevHead = prev?.headSha
      if (prevHead && runGit(reviewRoot, ['rev-parse', '--verify', prevHead]).ok) {
        diffSpec = { mode: 'range', range: `${prevHead}..${headRef}` }
        diffScope = `${prevHead.slice(0, 8)}..${headSha.slice(0, 8)} (Round ${round} incremental)`
        roundLockNote = round === 2
          ? 'R1 unchanged hunks LOCKED; review open Must-Fix + R1_HEAD..HEAD + rebuts only'
          : 'R2_HEAD..HEAD binary Pass/Fail verification only; no new findings'
      } else if (baseRef) {
        diffSpec = { mode: 'range', range: computeDiffRange(reviewRoot, baseRef, headRef) }
        diffScope = `${baseRef}...${headRef}`
        roundLockNote = `Round ${round} (prior head unavailable; fell back to base diff)`
      }
    }

    if (!diffSpec) {
      if (!baseRef) {
        process.stderr.write('Error: cannot resolve base ref; pass --base <ref>.\n')
        return EXIT.ERROR
      }
      diffSpec = { mode: 'range', range: computeDiffRange(reviewRoot, baseRef, headRef) }
      diffScope = `${baseRef}...${headRef}`
      if (mode === 'task') roundLockNote = 'Round 1 full diff'
    }
  }

  const diff = collectDiff(reviewRoot, diffSpec)
  const devProfile = parseDevProfile(reviewRoot)
  const effectiveProfile = Object.values(devProfile).some((v) => v.length > 0) ? devProfile : parseDevProfile(mainRoot)

  // Untrusted PR / static supply-chain hazard scan
  const shouldScanUntrusted = opts.untrustedScan || opts.pr !== undefined || task?.role === 'inbound-external-pr'
  let untrustedWarnings = []
  if (shouldScanUntrusted) {
    const hazards = scanUntrustedDiff(diff, reviewRoot)
    if (hazards.length > 0 && !opts.humanApprovedExec) {
      const payload = {
        status: 'BLOCKED_UNTRUSTED_HAZARD',
        exitCode: EXIT.UNTRUSTED_HAZARD,
        diffScope,
        headSha,
        hazards,
        nextStep: 'Do NOT mount dependencies or run tests. Show these hazards to a human maintainer; only re-run with --human-approved-exec (and use --ignore-scripts) after explicit approval.',
      }
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      } else {
        const lines = [
          'BLOCKED_UNTRUSTED_HAZARD',
          `Scope    : ${diffScope} (HEAD ${headSha})`,
          `Exit Code: ${EXIT.UNTRUSTED_HAZARD}`,
          'High-risk / supply-chain or gate-weakening changes detected before execution:',
          ...hazards.flatMap((h) => [
            `  - [${h.category}] ${h.file}: ${h.reason}`,
            ...h.excerpt.map((e) => `      ${e}`),
          ]),
          '',
          '[NEXT STEP]',
          '  1. Read-only inspect the flagged diff above; DO NOT mount deps or execute tests/scripts.',
          '  2. Ask a human maintainer for explicit sign-off.',
          '  3. Only if approved, re-run with `--human-approved-exec` and isolate installs using `--ignore-scripts`.',
        ]
        process.stdout.write(`${lines.join('\n')}\n`)
      }
      process.stderr.write(`BLOCKED_UNTRUSTED_HAZARD: ${hazards.length} high-risk change(s) detected (exit ${EXIT.UNTRUSTED_HAZARD})\n`)
      return EXIT.UNTRUSTED_HAZARD
    }
    untrustedWarnings = hazards
  }

  const parity = checkDocCodeParity(reviewRoot, mainRoot, diff, effectiveProfile, task)
  const criteria = parseAcceptanceCriteria(reviewRoot, mainRoot, task)
  const hrHits = highRiskHits(diff, effectiveProfile)

  let headMismatchWarning = ''
  if (task) {
    if (task.verifiedHead && headSha !== 'UNBORN' && task.verifiedHead !== headSha) {
      headMismatchWarning = `verifiedHead (${task.verifiedHead.slice(0, 8)}) != review HEAD (${headSha.slice(0, 8)}); re-verify required!`
    }
    if (mode === 'task' && round >= 2 && task.rounds?.length) {
      const prev = task.rounds[task.rounds.length - 1]
      if (prev?.headSha && prev.headSha === headSha) {
        headMismatchWarning = `HEAD (${headSha.slice(0, 8)}) has not advanced since Round ${prev.round}; reject re-review until implementer adds a fix commit.`
      }
    }
  }

  const nextSteps = []
  if (opts.untrustedScan && untrustedWarnings.length === 0) {
    nextSteps.push('Untrusted static scan clean (UNTRUSTED_SCAN_PASS). Safe to proceed with isolated review worktree checks.')
  }
  if (mode === 'local' || mode === 'staged' || mode === 'base') {
    nextSteps.push('Fix any [PARITY_WARN] / test issues locally before creating a commit or opening a PR.')
  } else if (opts.task) {
    nextSteps.push(`Review independently against criteria C1..Cn, run tests + fault injection, then record verdict:`)
    nextSteps.push(`  node .agents/skills/dev-review/scripts/review-pack.mjs record --task ${opts.task} --round ${round} --verdict pass|changes --reviewer-id <reviewer-id>`)
  } else if (opts.pr) {
    nextSteps.push('Complete independent review using the diff hash, parity check, and empirical tests above before posting PR review.')
  }

  const pack = {
    status: opts.untrustedScan && untrustedWarnings.length === 0 ? 'UNTRUSTED_SCAN_PASS' : 'PACK_READY',
    mode,
    isFlowMode,
    worktreeRoot: posixPath(reviewRoot),
    mainRoot: posixPath(mainRoot),
    round,
    roundLockNote,
    diffScope,
    headSha,
    diffText: diff.text,
    diff: { sha256: diff.sha256, bytes: diff.bytes, files: diff.files, untracked: diff.untracked },
    task: task ?? null,
    criteria,
    priorOpenMustFix,
    rebuts,
    parity,
    devProfile: effectiveProfile,
    highRiskHits: hrHits,
    untrustedWarnings,
    headMismatchWarning,
    nextSteps,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(pack, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatPackText(pack)}\n`)
  }
  return EXIT.OK
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main())
}
