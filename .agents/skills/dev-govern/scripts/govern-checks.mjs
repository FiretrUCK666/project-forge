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
  DEFAULT_WALK_SKIP_DIRS, gitRun, isMacOsJunkPath, posixPath, readTextSafe,
} from '../../lib/git.mjs'
import { readBlobBatch } from '../../lib/git-fast-objects.mjs'
import { collectGateReceiptKey, hasReusableGateCheck } from '../../lib/gate-receipt.mjs'
import { loadForgeHooksConfig } from '../../lib/overlay.mjs'
import {
  CODE_EXT_RE, EXCUSE_COMMENT_RE, EXCUSE_HACK_RE, EXCUSE_TEMP_RE, ISSUE_REF_RE, JUSTIFICATION_ANCHOR_RE,
  RUST_ALLOW_RE, TEST_FILE_RE, TOMBSTONE_COMMENT_RE, checkProcessArtifactFilename, countTextLines, evaluateArchRules,
  extractLineCommentInfo, isTestOrFixtureFile, looksLikeCommentedCode, scanStructuralHygiene,
} from '../../lib/static-gates.mjs'
import { resolveOversizedExemption, scanBrokenCommentPaths } from '../../lib/static-gates-comment-hygiene.mjs'
import {
  ENV_FILE_RE, NPMRC_FILE_RE, SAFE_ENV_RE, SECRET_FILE_RE, TEST_FIXTURE_PATH_RE,
  isSensitiveSecretFile, matchSecretContentLine,
} from '../../lib/credential-scan.mjs'
import { AGENTS_MAX_BYTES, AGENTS_WARN_BYTES } from '../../lib/tool-owned.mjs'
import { auditUnignoredOutputDirs, inspectManifest, inspectWorktrees } from './govern-checks-hygiene.mjs'

export { AGENTS_MAX_BYTES, AGENTS_WARN_BYTES, inspectManifest, inspectWorktrees }
export const GOD_FILE_WARN_LINES = 800
export const GOD_FILE_HIGH_LINES = 1500
const LARGE_FILE_BYTES = 1024 * 1024
const MAX_READ_BYTES = 512 * 1024

export const TEXT_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|kts|rb|php|cs|fs|c|cc|cpp|h|hpp|swift|dart|sh|bash|ps1|md|mdx|txt|rst|ya?ml|json|toml|ini|cfg|env)$/i
const BOM_EXEMPT_EXT_RE = /\.(?:cs|fs|vb|csproj|fsproj|vbproj|sln)$/i

const BACKUP_FILE_RE = /\.(?:bak|orig|old|tmp)$|~$/i

/** 创建单遍审计文件与词法缓存，避免多轮重复读盘与行分割。 */
export function createFileContentCache() {
  const entries = new Map()
  return {
    getInfo(filePath) {
      const key = String(filePath)
      if (entries.has(key)) return entries.get(key)
      const val = readTextStrictInfoUncached(filePath)
      entries.set(key, val)
      return val
    },
    getLines(filePath) {
      const info = this.getInfo(filePath)
      if (!info?.text) return undefined
      if (!info._lines) info._lines = info.text.split('\n')
      return info._lines
    },
    getCommentLines(filePath, ext) {
      const info = this.getInfo(filePath)
      if (!info?.text) return undefined
      if (!info._commentsByExt) info._commentsByExt = new Map()
      if (info._commentsByExt.has(ext)) return info._commentsByExt.get(ext)
      const lines = this.getLines(filePath)
      const parsed = new Array(lines.length)
      let inBlock = false
      for (let i = 0; i < lines.length; i += 1) {
        const res = extractLineCommentInfo(lines[i], inBlock, ext)
        inBlock = res.nextInBlock
        parsed[i] = res
      }
      info._commentsByExt.set(ext, parsed)
      return parsed
    },
    clear() {
      entries.clear()
    },
  }
}

let activeReadCache = null

export function setActiveFileCache(cache) {
  activeReadCache = cache
}

function readTextStrictInfoUncached(filePath) {
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

export function readTextStrictInfo(filePath, cache = activeReadCache) {
  return cache ? cache.getInfo(filePath) : readTextStrictInfoUncached(filePath)
}

function getLinesCached(filePath, info) {
  if (activeReadCache) return activeReadCache.getLines(filePath)
  return info?.text ? info.text.split('\n') : undefined
}

function getCommentLinesCached(filePath, lines, ext) {
  if (activeReadCache) return activeReadCache.getCommentLines(filePath, ext)
  const parsed = new Array(lines.length)
  let inBlock = false
  for (let i = 0; i < lines.length; i += 1) {
    const res = extractLineCommentInfo(lines[i], inBlock, ext)
    inBlock = res.nextInBlock
    parsed[i] = res
  }
  return parsed
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

const GOVERN_EXTRA_SKIP_DIRS = new Set(['_build', 'htmlcov', '.nox'])

function readGitignoreDirExcludes(root) {
  const raw = readTextSafe(join(root, '.gitignore'))
  if (!raw) return { exactRels: new Set(), dirNames: new Set() }
  const exactRels = new Set()
  const dirNames = new Set()
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!') || /[*?[\]]/.test(trimmed)) continue
    if (!trimmed.endsWith('/')) continue
    const norm = posixPath(trimmed).replace(/^\/+/, '').replace(/\/+$/, '')
    if (!norm || norm === '.' || norm.includes('..')) continue
    if (norm.includes('/')) exactRels.add(norm)
    else dirNames.add(norm)
  }
  return { exactRels, dirNames }
}

export function walkFiles(root, scopeRel = '') {
  const start = scopeRel ? join(root, scopeRel) : root
  const gitignoreDirs = readGitignoreDirExcludes(root)
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
        if (DEFAULT_WALK_SKIP_DIRS.has(entry.name) || GOVERN_EXTRA_SKIP_DIRS.has(entry.name)) continue
        if (gitignoreDirs.dirNames.has(entry.name) || gitignoreDirs.exactRels.has(rel)) continue
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

export function auditSecurity(files, trackedSet, findings, opts = {}) {
  const secretsArePlaceholders = Boolean(opts?.secretsArePlaceholders)
  for (const f of files) {
    const isTestFixturePath = TEST_FIXTURE_PATH_RE.test(f.rel)
    if (SECRET_FILE_RE.test(f.name) && !SAFE_ENV_RE.test(f.name)) {
      const secretFileInfo = (NPMRC_FILE_RE.test(f.name) || ENV_FILE_RE.test(f.name)) ? readTextStrictInfo(f.full) : null
      if (!secretsArePlaceholders && isSensitiveSecretFile(f.name, secretFileInfo?.text, f.rel)) {
        const tracked = trackedSet.has(f.rel)
        addFinding(findings, {
          id: `sec.secret-file.${f.rel}`,
          category: 'security',
          severity: isTestFixturePath ? 'info' : (tracked ? 'critical' : 'high'),
          file: f.rel,
          title: isTestFixturePath
            ? `Test fixture credential-like file (downgraded): ${f.rel}`
            : `${tracked ? 'Tracked' : 'Present'} sensitive credential file: ${f.rel}`,
          detail: isTestFixturePath
            ? 'File matches SECRET_FILE_RE inside a test/fixture path.'
            : (tracked ? 'File is tracked by git history.' : 'Sensitive file exists on disk; verify it is ignored.'),
          action: isTestFixturePath
            ? 'Keep placeholder-only fixtures in testdata/fixtures or declare `secrets-are-placeholders` in AGENTS.md.'
            : (tracked ? 'Rotate credential, remove from git tracking, and add pattern to .gitignore.' : 'Verify .gitignore covers this pattern.'),
        })
      }
    }

    if (!TEXT_EXT_RE.test(f.name) && !f.name.startsWith('.env') && !NPMRC_FILE_RE.test(f.name)) continue
    if (SAFE_ENV_RE.test(f.name)) continue
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue

    const lines = getLinesCached(f.full, info) ?? []
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx]
      if (!secretsArePlaceholders) {
        for (const pat of matchSecretContentLine(line)) {
          addFinding(findings, {
            id: `sec.token.${f.rel}:${idx + 1}`,
            category: 'security',
            severity: isTestFixturePath ? 'info' : (trackedSet.has(f.rel) ? 'critical' : 'high'),
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

const ZERO_BYTE_EXEMPT_NAMES = new Set(['.gitkeep', '__init__.py', 'py.typed', '.nojekyll'])

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
    if (f.size === 0 && !ZERO_BYTE_EXEMPT_NAMES.has(f.name)) {
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
    const lines = getLinesCached(f.full, info) ?? []
    const parsedComments = getCommentLinesCached(f.full, lines, ext)
    let todoCount = 0
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
      const { commentText, pureSingleLine } = parsedComments[i]

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
    const lines = getLinesCached(f.full, info) ?? []
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

export async function auditHygiene(workRoot, mainRoot, isGit, files, defaultBranch, devProfile, findings, opts = {}) {
  const changedSet = opts?.changedFilesSet instanceof Set ? opts.changedFilesSet : null
  const rcptKey = (isGit && changedSet) ? await collectGateReceiptKey({ workTreeRoot: workRoot, profile: devProfile }) : { valid: false }
  const reusedHygiene = rcptKey.valid && Boolean(hasReusableGateCheck({ gitCommonDir: rcptKey.gitCommonDir, key: rcptKey, checkName: 'structuralHygiene' }))
  const reusedArch = rcptKey.valid && Boolean(hasReusableGateCheck({ gitCommonDir: rcptKey.gitCommonDir, key: rcptKey, checkName: 'archRules' }))
  const home = homedir().replace(/\\/g, '/')
  const homeRe = home.length > 4 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined
  const gitAttributesText = readTextSafe(join(workRoot, '.gitattributes'), 64 * 1024) ?? ''
  const agentsText = readTextSafe(join(workRoot, 'AGENTS.md'), 64 * 1024) ?? ''
  const forgeHooksConfig = loadForgeHooksConfig(mainRoot, workRoot)?.config ?? null
  const oversizedNonExemptFiles = []
  const pendingRatchetFiles = []
  const codeRelList = []
  const changedCodeRels = (isGit && changedSet)
    ? files.filter((f) => CODE_EXT_RE.test(f.name) && changedSet.has(f.rel) && !isTestOrFixtureFile(f.rel)).map((f) => f.rel)
    : []
  const headBlobMap = changedCodeRels.length > 0 ? await readBlobBatch(workRoot, 'HEAD', changedCodeRels) : new Map()

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
      if (reusedHygiene && changedSet?.has(f.rel)) {
        codeRelList.push(f.rel)
        continue
      }
      const procNameHit = checkProcessArtifactFilename(f.rel)
      if (procNameHit) {
        addFinding(findings, {
          id: `naming.process-artifact-filename.${f.rel}`,
          category: 'hygiene',
          severity: 'high',
          file: f.rel,
          title: procNameHit.message,
          action: procNameHit.fixHint,
        })
      }
      codeRelList.push(f.rel)
      const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
      const lines = getLinesCached(f.full, info) ?? []
      const parsedComments = getCommentLinesCached(f.full, lines, ext)
      if (!isTestOrFixtureFile(f.rel) && !f.name.endsWith('.min.js') && lines.length > GOD_FILE_WARN_LINES) {
        const lineCount = countTextLines(info.text)
        const structCheck = scanStructuralHygiene({
          fileRel: f.rel, lines, fullText: info.text, fullLineCount: lineCount,
          warnLines: GOD_FILE_WARN_LINES, highLines: GOD_FILE_HIGH_LINES, skipFixtureCheck: true, gitAttributesText,
        })
        if (structCheck.godFile) {
          const exempt = resolveOversizedExemption({ fileRel: f.rel, agentsText, forgeHooksConfig })
          if (!exempt.exempt && changedSet && changedSet.has(f.rel) && isGit) {
            pendingRatchetFiles.push({ rel: f.rel, lineCount })
          } else if (!exempt.exempt) {
            const isHigh = lineCount > GOD_FILE_HIGH_LINES
            oversizedNonExemptFiles.push({ rel: f.rel, lines: lineCount })
            addFinding(findings, {
              id: `hygiene.god-file.${f.rel}`,
              category: 'hygiene',
              severity: isHigh ? 'high' : 'medium',
              file: f.rel,
              title: `Oversized source file (${lineCount} lines > ${isHigh ? GOD_FILE_HIGH_LINES : GOD_FILE_WARN_LINES}): ${f.rel}`,
              action: 'Split cohesive responsibilities into smaller focused modules rather than expanding a god file.',
            })
          }
        }
      }

      let tombCount = 0
      let excuseCount = 0
      const skipFixtureHygiene = isTestOrFixtureFile(f.rel)
      for (let i = 0; i < lines.length; i += 1) {
        const { commentText } = parsedComments[i]
        if (!skipFixtureHygiene && commentText && TOMBSTONE_COMMENT_RE.test(commentText)) {
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
        const hasJustify = JUSTIFICATION_ANCHOR_RE.test(commentText || lines[i])
        const hasIssueRef = Boolean(commentText && EXCUSE_HACK_RE.test(commentText) && ISSUE_REF_RE.test(commentText))
        if (!hasJustify && !hasIssueRef && ((commentText && (EXCUSE_COMMENT_RE.test(commentText) || EXCUSE_TEMP_RE.test(commentText))) || RUST_ALLOW_RE.test(lines[i]))) {
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
              action: 'Fix root cause, or link an active #<issue> (via flow.mjs issue create / escalation.mjs) for temporary workarounds.',
            })
          }
        }
      }
      if (changedSet && changedSet.has(f.rel) && !isTestOrFixtureFile(f.rel)) {
        const headText = isGit ? (headBlobMap.get(f.rel) ?? null) : null
        for (const bp of scanBrokenCommentPaths({ repoRoot: workRoot, fileRel: f.rel, text: info.text, headText })) {
          addFinding(findings, {
            id: `hygiene.comment-broken-path.${f.rel}:${bp.line}`,
            category: 'hygiene',
            severity: 'medium',
            file: f.rel,
            line: bp.line,
            title: `Broken comment path \`${bp.path}\` at ${f.rel}:${bp.line}`,
            detail: bp.raw,
            action: 'Update or remove stale backticked path references in comments.',
          })
        }
      }
    }
  }

  if (isGit && pendingRatchetFiles.length > 0) {
    const cmpRef = defaultBranch && (await gitRun(workRoot, ['--no-optional-locks', 'rev-parse', '--verify', defaultBranch])).ok
      ? (await gitRun(workRoot, ['--no-optional-locks', 'merge-base', 'HEAD', defaultBranch])).stdout?.trim() || 'HEAD'
      : 'HEAD'
    const ratchetBlobMap = cmpRef === 'HEAD'
      ? headBlobMap
      : await readBlobBatch(workRoot, cmpRef, pendingRatchetFiles.map((x) => x.rel))
    for (const item of pendingRatchetFiles) {
      const baseText = ratchetBlobMap.get(item.rel) ?? null
      const baseLineCount = baseText ? countTextLines(baseText) : 0
      const ratchetPass = Boolean(baseText && baseLineCount > GOD_FILE_WARN_LINES && (item.lineCount - baseLineCount) <= 80)
      if (!ratchetPass) {
        const isHigh = item.lineCount > GOD_FILE_HIGH_LINES
        oversizedNonExemptFiles.push({ rel: item.rel, lines: item.lineCount })
        addFinding(findings, {
          id: `hygiene.god-file.${item.rel}`,
          category: 'hygiene',
          severity: isHigh ? 'high' : 'medium',
          file: item.rel,
          title: `Oversized source file (${item.lineCount} lines > ${isHigh ? GOD_FILE_HIGH_LINES : GOD_FILE_WARN_LINES}): ${item.rel}`,
          action: 'Split cohesive responsibilities into smaller focused modules rather than expanding a god file.',
        })
      }
    }
  }

  if (isGit && oversizedNonExemptFiles.length > 0) {
    const targetPaths = oversizedNonExemptFiles.map((x) => x.rel)
    const logRes = await gitRun(workRoot, ['log', '-n', '60', '--name-only', '--format=format:__COMMIT__', '--', ...targetPaths.slice(0, 40)])
    if (logRes.ok && logRes.stdout) {
      const touchesByFile = new Map(targetPaths.map((p) => [p, 0]))
      let seenInCommit = new Set()
      for (const rawLine of logRes.stdout.split('\n')) {
        const line = rawLine.trim()
        if (!line) continue
        if (line === '__COMMIT__') { seenInCommit = new Set(); continue }
        const clean = posixPath(line)
        if (touchesByFile.has(clean) && !seenInCommit.has(clean)) {
          seenInCommit.add(clean)
          touchesByFile.set(clean, touchesByFile.get(clean) + 1)
        }
      }
      for (const item of oversizedNonExemptFiles) {
        const touches = touchesByFile.get(item.rel) ?? 0
        if (touches >= 3) {
          addFinding(findings, {
            id: `hygiene.god-file-churn-escalation.${item.rel}`,
            category: 'hygiene',
            severity: 'high',
            file: item.rel,
            title: `High-churn oversized brownfield file (${item.lines} lines, touched ${touches}x in recent git log): ${item.rel}`,
            detail: `File exceeds ${GOD_FILE_WARN_LINES} lines and changed ${touches} times across recent commits without decomposition.`,
            action: `Tier 1 architecture cleanup: decompose ${item.rel} into cohesive responsibility modules before adding more changes.`,
          })
        }
      }
    }
  }

  const archTargets = reusedArch && changedSet ? codeRelList.filter((r) => !changedSet.has(r)) : codeRelList
  const archRes = archTargets.length > 0 ? evaluateArchRules(workRoot, archTargets, devProfile['arch-rules']) : { ok: true, violations: [] }
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

  await auditUnignoredOutputDirs(workRoot, mainRoot, isGit, findings, addFinding, opts.trackedSet ?? null)

  const wtReport = await inspectWorktrees(mainRoot, isGit, defaultBranch)
  for (const s of wtReport.stale) {
    const isNoOwn = s.state === 'no_own_commits'
    const isOrphan = s.state === 'orphan_dir'
    addFinding(findings, {
      id: `hygiene.stale-worktree.${s.path}`,
      category: 'hygiene',
      severity: isNoOwn ? 'low' : 'medium',
      file: s.path,
      title: `Worktree candidate [${s.state}]: ${s.path} (${s.reason})`,
      action: isOrphan
        ? 'Unregistered directory inside .worktrees/ (not a git worktree). Confirm contents with user, then delete the directory directly instead of `git worktree remove`.'
        : isNoOwn
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

  return {
    worktrees: wtReport,
    manifest: manifestReport,
    archViolations: archRes.violations,
    reusedGateReceipt: { structuralHygiene: reusedHygiene, archRules: reusedArch },
  }
}
