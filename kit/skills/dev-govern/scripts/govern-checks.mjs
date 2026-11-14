/**
 * govern-checks.mjs -- Security, deadcode, perf, hygiene, 4-state worktree
 * reconciliation (at mainRoot), and v2 manifest inspection for dev-govern.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

import {
  DEFAULT_WALK_SKIP_DIRS, canonicalPath, gitRun, inspectBranchMergeState,
  isMacOsJunkPath, parseWorktreeListPorcelain, posixPath, readJsonSafe,
  samePath, sha256Text,
} from '../../lib/git.mjs'
import {
  CODE_EXT_RE, EXCUSE_COMMENT_RE, EXCUSE_TEMP_RE, RUST_ALLOW_RE, TEST_FILE_RE,
  TOMBSTONE_COMMENT_RE, evaluateArchRules, extractLineCommentInfo,
} from '../../lib/static-gates.mjs'

export const AGENTS_WARN_BYTES = 24576
export const AGENTS_MAX_BYTES = 30720
export const GOD_FILE_WARN_LINES = 800
export const GOD_FILE_HIGH_LINES = 1500
const LARGE_FILE_BYTES = 1024 * 1024
const MAX_READ_BYTES = 512 * 1024

const OUTPUT_DIRS = ['node_modules', '.venv', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage', '.worktrees']
export const TEXT_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|kts|rb|php|cs|fs|c|cc|cpp|h|hpp|swift|dart|sh|bash|ps1|md|mdx|txt|rst|ya?ml|json|toml|ini|cfg|env)$/i
const BOM_EXEMPT_EXT_RE = /\.(?:cs|fs|vb|csproj|fsproj|vbproj|sln)$/i

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

export function readTextStrictInfo(filePath) {
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

export function addFinding(findings, item) {
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

export function walkFiles(root, scopeRel = '') {
  const start = scopeRel ? join(root, scopeRel) : root
  const files = []
  const queue = [start]
  while (queue.length > 0) {
    const dir = queue.pop()
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacOsJunkPath(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(root, full))
      if (isMacOsJunkPath(rel)) continue
      if (entry.isDirectory()) {
        if (DEFAULT_WALK_SKIP_DIRS.has(entry.name)) continue
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

function looksLikeCommentedCode(body) {
  const t = String(body ?? '').trim()
  if (!t || t.startsWith('@') || /^[-=*#]{3,}$/.test(t)) return false
  if (/[{};]\s*$/.test(t)) return true
  if (/^(?:const|let|var|function|async\s+function|class|if|else\s+if|for|while|switch|return|import|export|def|async\s+def|try|except|finally|fn|pub\s+fn|func)\b/.test(t)) return true
  if (/^[A-Za-z_][A-Za-z0-9_.]*\s*(?:=|:=|\([^)]*\)\s*(?:=>|\{|$))/.test(t)) return true
  if (/^\s*[})\]]+\s*[,;]?\s*$/.test(t)) return true
  return false
}

export function auditSecurity(files, trackedSet, findings) {
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
        } else if (
          (/\bexec(?:Sync)?\s*\(\s*`[^`]*\$\{/.test(line) && !/\/[gimsuy]*\.exec\s*\(/.test(line))
          || /\bnew\s+Function\s*\(/.test(line)
        ) {
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

export function auditDeadcode(files, findings) {
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
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
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
      const { commentText, nextInBlock, pureSingleLine } = extractLineCommentInfo(lines[i], inBlock, ext)
      inBlock = nextInBlock

      if (pureSingleLine && commentText) commentRun.push({ line: i + 1, body: commentText })
      else flushCommentRun()

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

export function auditPerf(repoRoot, files, findings) {
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

export async function inspectWorktrees(mainRoot, isGit, defaultBranch) {
  const stale = []
  const worktreeEntries = []
  const counts = { merged: 0, squash_or_rebase_merged: 0, no_own_commits: 0, unmerged: 0, prunable: 0, orphan_dir: 0 }
  if (!isGit) return { total: 0, counts, entries: worktreeEntries, stale }

  const listRes = await gitRun(mainRoot, ['worktree', 'list', '--porcelain'])
  const rawEntries = listRes.ok && listRes.stdout ? parseWorktreeListPorcelain(listRes.stdout) : []
  const mainCanon = canonicalPath(mainRoot)
  const registeredPaths = []
  let registeredInDotWorktrees = 0

  for (const e of rawEntries) {
    registeredPaths.push(e.path)
    if (samePath(e.path, mainCanon)) continue
    const rel = posixPath(relative(mainCanon, e.path))
    if (!rel.startsWith('.worktrees/')) continue
    registeredInDotWorktrees += 1

    if (e.prunable) {
      counts.prunable += 1
      const item = { path: rel, branch: e.branch, headSha: e.head, state: 'prunable', dirty: false, reason: `prunable (${e.prunable})` }
      worktreeEntries.push(item)
      stale.push(item)
      continue
    }

    const stRes = existsSync(e.path) ? await gitRun(e.path, ['status', '--porcelain']) : { ok: false, stdout: '' }
    const dirty = Boolean(stRes.ok && stRes.stdout.trim())
    const mergeInfo = await inspectBranchMergeState(mainRoot, {
      branch: e.branch,
      headSha: e.head,
      defaultBranch: defaultBranch || 'main',
    })
    const st = mergeInfo.state
    counts[st] = (counts[st] ?? 0) + 1
    const baseItem = {
      path: rel,
      branch: e.branch,
      headSha: e.head,
      state: st,
      dirty,
      ownCommits: mergeInfo.ownCommits,
      isShallow: mergeInfo.isShallow,
      reason: st === 'no_own_commits'
        ? `no_own_commits: no unique commits ahead of ${defaultBranch || 'main'} (dirty=${dirty}; ask human before cleaning)`
        : `${st}: ${mergeInfo.reason}`,
    }
    worktreeEntries.push(baseItem)
    if (st !== 'unmerged') stale.push(baseItem)
  }

  const wtContainer = join(mainRoot, '.worktrees')
  if (existsSync(wtContainer)) {
    try {
      for (const d of readdirSync(wtContainer, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name === '.state' || isMacOsJunkPath(d.name)) continue
        const abs = canonicalPath(join(wtContainer, d.name))
        if (!registeredPaths.some((rp) => samePath(rp, abs))) {
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

export function inspectManifest(repoRoot) {
  const skillsDir = join(repoRoot, '.agents', 'skills')
  const manifestPath = join(skillsDir, '.pf-manifest.json')
  if (!existsSync(skillsDir) && !existsSync(manifestPath)) {
    return { present: false, status: 'not-equipped', issues: [], customizedCount: 0 }
  }
  if (existsSync(skillsDir) && !existsSync(manifestPath)) {
    return {
      present: true,
      status: 'missing-manifest',
      issues: [{ file: '.agents/skills/.pf-manifest.json', kind: 'missing', detail: '.agents/skills/ exists without .pf-manifest.json' }],
      customizedCount: 0,
    }
  }

  const manifest = readJsonSafe(manifestPath)
  if (!manifest || typeof manifest !== 'object' || typeof manifest.files !== 'object' || manifest.files === null) {
    return {
      present: true,
      status: 'corrupt-manifest',
      issues: [{ file: '.agents/skills/.pf-manifest.json', kind: 'corrupt', detail: 'Invalid JSON or missing files map' }],
      customizedCount: 0,
    }
  }

  const customizedMap = manifest.customizedFiles && typeof manifest.customizedFiles === 'object' ? manifest.customizedFiles : {}
  const issues = []
  let checked = 0
  let customizedCount = 0

  for (const [relKey, meta] of Object.entries(manifest.files)) {
    checked += 1
    const norm = posixPath(relKey)
    if (Object.prototype.hasOwnProperty.call(customizedMap, norm)) {
      customizedCount += 1
      continue
    }
    const abs = norm.startsWith('.agents/skills/') ? join(repoRoot, norm) : join(skillsDir, norm)
    if (!existsSync(abs)) {
      issues.push({ file: norm, kind: 'missing-managed', detail: 'Managed skill file listed in manifest is missing on disk' })
      continue
    }
    if (meta && typeof meta.sha256 === 'string') {
      try {
        const buf = readFileSync(abs)
        const rawHash = sha256Text('') && buf.length >= 0 ? null : null
        void rawHash
        const textNormHash = !buf.subarray(0, 4096).includes(0)
          ? sha256Text(buf.toString('utf8').replace(/\r\n/g, '\n'))
          : null
        const matches = textNormHash === meta.sha256
        if (!matches) {
          const directBufHash = sha256Text(buf.toString('utf8'))
          if (directBufHash !== meta.sha256) {
            issues.push({ file: norm, kind: 'drifted', detail: 'File checksum differs from manifest baseline (local modification or drift)' })
          }
        }
      } catch {
        issues.push({ file: norm, kind: 'unreadable', detail: 'Unable to hash managed file' })
      }
    }
  }

  return {
    present: true,
    schemaVersion: manifest.schemaVersion ?? 1,
    tier: manifest.tier ?? 'full',
    status: issues.length === 0 ? 'ok' : 'drift-detected',
    checkedFiles: checked,
    customizedCount,
    issues,
  }
}

export async function auditHygiene(workRoot, mainRoot, isGit, files, defaultBranch, devProfile, findings) {
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
    if (info.hasBom && !BOM_EXEMPT_EXT_RE.test(f.name)) {
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
      const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
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
        const { commentText, nextInBlock } = extractLineCommentInfo(lines[i], inBlock, ext)
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

  const archRes = evaluateArchRules(workRoot, codeRelList, devProfile['arch-rules'])
  for (const v of archRes.violations) {
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

  const presentOutputs = OUTPUT_DIRS.filter((d) => existsSync(join(workRoot, d)))
  if (isGit && presentOutputs.length > 0) {
    const res = await gitRun(workRoot, ['check-ignore', '-z', '--stdin'], { input: presentOutputs.join('\0') })
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

  const wtReport = await inspectWorktrees(mainRoot, isGit, defaultBranch)
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

  const manifestReport = inspectManifest(workRoot)
  for (const iss of manifestReport.issues) {
    addFinding(findings, {
      id: `hygiene.manifest.${iss.kind}.${iss.file}`,
      category: 'hygiene',
      severity: iss.kind === 'corrupt' || iss.kind === 'missing-managed' ? 'high' : 'low',
      file: iss.file,
      title: `Skill manifest check [${iss.kind}]: ${iss.file}`,
      detail: iss.detail,
      action: iss.kind === 'drifted'
        ? 'Expected if customized locally (run `equip.mjs --adopt-custom` if intentional); otherwise re-sync skills.'
        : 'Re-run skill installation/equip to restore .pf-manifest.json consistency.',
    })
  }

  return { worktrees: wtReport, manifest: manifestReport, archViolations: archRes.violations }
}
