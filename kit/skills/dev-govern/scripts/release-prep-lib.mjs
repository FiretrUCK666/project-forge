/**
 * release-prep-lib.mjs -- Multi-version release-prep collector and noise filter.
 *
 * Self-contained helper for govern-audit.mjs `release-prep`: resolves arbitrary
 * tag/revision ranges, detects authoritative version sources and min-runtime
 * breaking signals, filters internal commit noise, extracts implemented specs and
 * archived task outcomes, and cross-checks unaccounted public entry files.
 *
 * Uses Node 18+ built-in `node:*` modules only.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_READ_BYTES = 512 * 1024

const TEST_OR_FIXTURE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|test_[^/]+\.py$/i
const CI_OR_INTERNAL_CONFIG_RE = /^(?:\.github\/|\.husky\/|\.vscode\/|\.idea\/|\.(?:eslint|prettier|stylelint|editorconfig|gitattributes|gitignore))/i
const INTERNAL_PREFIX_RE = /^(?:test|tests|chore|ci|build|style|refactor)(?:\([^)]*\))?:\s*/i
const BREAKING_SUBJECT_RE = /^[a-z]+(?:\([^)]*\))?!:\s*/i
const TYPO_OR_FORMAT_RE = /^(?:(?:docs|style|chore)(?:\([^)]*\))?:\s*)?(?:fix\s+typos?|typos?|formatting|format\s+code|lint(?:\s+fix)?|whitespace|prettier|eslint|错别字|错字|排版|格式(?:整理|微调)?)\b/i
const VAGUE_SUBJECT_RE = /^(?:update|updates|updated|wip|misc|cleanup|clean\s*up|tweak|tweaks|fixup|squash|sync|temp|tmp|minor|adjust|changes|patch|fix|fix\s+bug|minor\s+changes|update\s+(?:code|files?|docs?|readme|cli|index|config)|修改|改动|更新|调整|微调|清理|同步|提交|临时|修复)$/i

function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

function runGit(cwd, args) {
  try {
    const out = execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 20000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    })
    return { ok: true, status: 0, stdout: String(out).replace(/\r\n/g, '\n').trimEnd(), stderr: '' }
  } catch (err) {
    return {
      ok: false,
      status: typeof err?.status === 'number' ? err.status : 1,
      stdout: String(err?.stdout ?? '').replace(/\r\n/g, '\n').trimEnd(),
      stderr: String(err?.stderr ?? err?.message ?? '').replace(/\r\n/g, '\n').trim(),
    }
  }
}

function readTextSafe(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size > MAX_READ_BYTES) return undefined
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return undefined
    return buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  } catch {
    return undefined
  }
}

function readFileAtRev(repoRoot, rev, relPosix) {
  const show = runGit(repoRoot, ['show', `${rev}:${relPosix}`])
  if (show.ok) return show.stdout
  if (rev === 'HEAD') return readTextSafe(join(repoRoot, relPosix))
  return undefined
}

function parseJsonSafe(raw) {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function collectPackagePublicPaths(pkg) {
  const out = new Set()
  if (!pkg || typeof pkg !== 'object') return out
  const addPath = (val) => {
    if (typeof val !== 'string') return
    const norm = posix.normalize(posixPath(val)).replace(/^\.\//, '')
    if (norm && !norm.startsWith('..') && !norm.includes('*')) out.add(norm)
  }
  addPath(pkg.main)
  addPath(pkg.module)
  addPath(pkg.types)
  addPath(pkg.typings)
  addPath(pkg.browser)
  if (typeof pkg.bin === 'string') addPath(pkg.bin)
  else if (pkg.bin && typeof pkg.bin === 'object') {
    for (const v of Object.values(pkg.bin)) addPath(v)
  }
  const visitExports = (node) => {
    if (typeof node === 'string') addPath(node)
    else if (Array.isArray(node)) node.forEach(visitExports)
    else if (node && typeof node === 'object') {
      for (const v of Object.values(node)) visitExports(v)
    }
  }
  visitExports(pkg.exports)
  return out
}

function resolveBaseAndRange(repoRoot, opts) {
  const targetRev = String(opts.to || 'HEAD').trim() || 'HEAD'
  const toCheck = runGit(repoRoot, ['rev-parse', '--verify', `${targetRev}^{commit}`])
  if (!toCheck.ok || !toCheck.stdout.trim()) {
    return { error: `Invalid --to revision: "${targetRev}"`, code: 2 }
  }
  const toSha = toCheck.stdout.trim()

  if (opts.from) {
    const fromCheck = runGit(repoRoot, ['rev-parse', '--verify', `${opts.from}^{commit}`])
    if (!fromCheck.ok || !fromCheck.stdout.trim()) {
      return { error: `Invalid --from revision: "${opts.from}"`, code: 2 }
    }
    const fromSha = fromCheck.stdout.trim()
    return {
      from: opts.from,
      fromSha,
      fromMode: 'explicit',
      to: targetRev,
      toSha,
      rangeSpec: `${opts.from}..${targetRev}`,
      diffBaseSha: fromSha,
      isInitialRelease: false,
    }
  }

  let fromTag = null
  const tagsAtTo = runGit(repoRoot, ['tag', '--points-at', toSha])
  const excludeArgs = []
  if (tagsAtTo.ok && tagsAtTo.stdout) {
    for (const t of tagsAtTo.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      excludeArgs.push('--exclude', t)
    }
  }
  const desc = runGit(repoRoot, ['describe', '--tags', '--abbrev=0', ...excludeArgs, toSha])
  if (desc.ok && desc.stdout.trim()) {
    const tag = desc.stdout.trim()
    const tagShaRes = runGit(repoRoot, ['rev-parse', '--verify', `${tag}^{commit}`])
    if (tagShaRes.ok && tagShaRes.stdout.trim() && tagShaRes.stdout.trim() !== toSha) {
      fromTag = tag
    }
  }

  if (fromTag) {
    const fromSha = runGit(repoRoot, ['rev-parse', '--verify', `${fromTag}^{commit}`]).stdout.trim()
    return {
      from: fromTag,
      fromSha,
      fromMode: 'auto-tag',
      to: targetRev,
      toSha,
      rangeSpec: `${fromTag}..${targetRev}`,
      diffBaseSha: fromSha,
      isInitialRelease: false,
    }
  }

  return {
    from: null,
    fromSha: null,
    fromMode: 'root',
    to: targetRev,
    toSha,
    rangeSpec: targetRev,
    diffBaseSha: EMPTY_TREE_SHA,
    isInitialRelease: true,
  }
}

function detectTagPrefix(repoRoot, fromTag) {
  if (fromTag && /^v\d/i.test(fromTag)) return 'v'
  if (fromTag && /^\d/.test(fromTag)) return ''
  const tags = runGit(repoRoot, ['tag', '--list', '--sort=-creatordate'])
  if (tags.ok && tags.stdout) {
    for (const t of tags.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (/^v\d+\.\d+/i.test(t)) return 'v'
      if (/^\d+\.\d+/.test(t)) return ''
    }
  }
  return 'v'
}

function parseSkillMdVersion(text) {
  if (!text) return null
  const fm = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!fm) return null
  let inMeta = false
  for (const line of fm[1].split('\n')) {
    if (/^metadata:\s*$/.test(line)) { inMeta = true; continue }
    if (inMeta) {
      if (/^\S/.test(line)) { inMeta = false }
      else {
        const vm = /^\s+version:\s*["']?([^"'\s#]+)["']?\s*$/.exec(line)
        if (vm) return vm[1].trim()
      }
    }
    const topV = /^version:\s*["']?([^"'\s#]+)["']?\s*$/.exec(line)
    if (topV) return topV[1].trim()
  }
  return null
}

function parseTomlSectionVersion(text, sections) {
  if (!text) return null
  let cur = ''
  for (const line of text.split('\n')) {
    const clean = line.replace(/\s+#.*$/, '').trim()
    if (!clean) continue
    const sec = /^\[([^\]]+)\]$/.exec(clean)
    if (sec) { cur = sec[1].trim(); continue }
    if (sections.includes(cur)) {
      const m = /^version\s*=\s*["']([^"']+)["']/.exec(clean)
      if (m) return m[1].trim()
    }
  }
  return null
}

function detectVersionSources(repoRoot, rev) {
  const sources = []
  const skillText = readFileAtRev(repoRoot, rev, 'SKILL.md')
  const skillVer = parseSkillMdVersion(skillText)
  if (skillVer) sources.push({ file: 'SKILL.md', field: 'metadata.version', version: skillVer })

  const pkgText = readFileAtRev(repoRoot, rev, 'package.json')
  const pkg = parseJsonSafe(pkgText)
  if (pkg?.version) sources.push({ file: 'package.json', field: 'version', version: String(pkg.version) })

  const pyText = readFileAtRev(repoRoot, rev, 'pyproject.toml')
  const pyVer = parseTomlSectionVersion(pyText, ['project', 'tool.poetry'])
  if (pyVer) sources.push({ file: 'pyproject.toml', field: 'version', version: pyVer })

  const cargoText = readFileAtRev(repoRoot, rev, 'Cargo.toml')
  const cargoVer = parseTomlSectionVersion(cargoText, ['package'])
  if (cargoVer) sources.push({ file: 'Cargo.toml', field: 'package.version', version: cargoVer })

  const manText = readFileAtRev(repoRoot, rev, 'manifest.json')
  const man = parseJsonSafe(manText)
  if (man?.version) sources.push({ file: 'manifest.json', field: 'version', version: String(man.version) })

  return { sources, pkg }
}

function detectNotesMode(repoRoot, targetTag) {
  const notesDirSegments = ['docs', 'release-notes']
  const notesDirRel = notesDirSegments.join('/')
  const hasNotesDir = existsSync(join(repoRoot, ...notesDirSegments))
  const hasReleasing = existsSync(join(repoRoot, 'RELEASING.md'))
  const hasChangelog = existsSync(join(repoRoot, 'CHANGELOG.md'))
  const tagName = targetTag || '<tag>'

  if (hasNotesDir || hasReleasing) {
    const targetFile = `${notesDirRel}/${tagName}.md`
    const existingNotePresent = Boolean(targetTag && existsSync(join(repoRoot, ...notesDirSegments, `${targetTag}.md`)))
    return {
      mode: 'directory',
      targetFile,
      existingNotePresent,
      hasReleasingDoc: hasReleasing,
      hasChangelog,
    }
  }
  if (hasChangelog) {
    const chg = readTextSafe(join(repoRoot, 'CHANGELOG.md')) || ''
    const bare = tagName.replace(/^v/i, '')
    const existingNotePresent = Boolean(
      targetTag && new RegExp(`^##\\s+\\[?v?${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?`, 'mi').test(chg),
    )
    return {
      mode: 'changelog',
      targetFile: 'CHANGELOG.md',
      existingNotePresent,
      hasReleasingDoc: false,
      hasChangelog: true,
    }
  }
  return {
    mode: 'unconfigured',
    targetFile: `${notesDirRel}/${tagName}.md`,
    existingNotePresent: false,
    hasReleasingDoc: false,
    hasChangelog: false,
  }
}

function collectCommitsAndFiles(repoRoot, range) {
  const logArg = range.fromSha ? `${range.fromSha}..${range.toSha}` : range.toSha
  const logRes = runGit(repoRoot, [
    'log',
    '--root',
    logArg,
    '--name-status',
    '--format=__COMMIT__%H\t%ct\t%an\t%s\t%b__END_HDR__',
  ])
  const commits = []
  if (logRes.ok && logRes.stdout) {
    const blocks = logRes.stdout.split('__COMMIT__').filter(Boolean)
    for (const block of blocks) {
      const hdrEnd = block.indexOf('__END_HDR__')
      if (hdrEnd < 0) continue
      const hdr = block.slice(0, hdrEnd)
      const tail = block.slice(hdrEnd + 11)
      const parts = hdr.split('\t')
      const hash = (parts[0] || '').trim()
      const ts = Number(parts[1]) || 0
      const author = (parts[2] || '').trim()
      const subject = (parts[3] || '').trim()
      const body = parts.slice(4).join('\t').trim()
      const files = []
      for (const line of tail.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const cols = trimmed.split('\t')
        if (cols.length >= 2) {
          const file = posixPath(cols[cols.length - 1]).trim()
          if (file) files.push(file)
        }
      }
      commits.push({
        hash,
        shortHash: hash.slice(0, 7),
        ts,
        author,
        subject,
        body,
        files: [...new Set(files)],
      })
    }
  }

  const diffRes = runGit(repoRoot, ['diff', '--name-status', range.diffBaseSha, range.toSha])
  const netChangedFiles = []
  if (diffRes.ok && diffRes.stdout) {
    for (const line of diffRes.stdout.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const cols = trimmed.split('\t')
      const status = cols[0] || 'M'
      const file = posixPath(cols[cols.length - 1]).trim()
      if (file) netChangedFiles.push({ status, file })
    }
  }
  return { commits, netChangedFiles }
}

function classifyPublicSurface(relPosix, pkgPublicPaths) {
  const f = posixPath(relPosix)
  if (TEST_OR_FIXTURE_RE.test(f)) return null
  if (pkgPublicPaths.has(f)) return 'package-entrypoint'
  if (/^SKILL\.md$/i.test(f) || /^kit\/skills\/[^/]+\/SKILL\.md$/i.test(f)) return 'skill-entry'
  if (/^README(?:\.[A-Za-z-]+)?\.md$/i.test(f)) return 'readme'
  if (/^(?:RELEASING|CHANGELOG|CONTRIBUTING)\.md$/i.test(f)) return 'project-guide'
  if (/^(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|manifest\.json)$/i.test(f)) return 'manifest'
  if (/^(?:templates|kit)\//i.test(f)) return 'distributed-asset'
  if (/^(?:bin|cmd|cli)\//i.test(f)) return 'cli-entrypoint'
  if (/^(?:src\/)?(?:index|main|cli|app|server|mod|lib)\.[^/]+$/i.test(f)) return 'top-level-entry'
  if (/^src\/[^/]+\/__init__\.py$/i.test(f)) return 'python-package-entry'
  if (/^[^/]+\.(?:mjs|cjs|js|ts|py|go|rs)$/i.test(f)) return 'root-module'
  if (/^scripts\/[^/]+\.(?:mjs|js|ts|py|sh)$/i.test(f)) return 'top-level-script'
  return null
}

function isContractDocFile(relPosix) {
  const f = posixPath(relPosix)
  return /^(?:README(?:\.[A-Za-z-]+)?\.md|SKILL\.md|CHANGELOG\.md|docs\/specs\/.+\.md|docs\/TDD\.md)$/i.test(f)
}

function cleanCommitSubject(subject) {
  let s = String(subject ?? '').trim()
  s = s.replace(/^(?:feat|feature|fix|bugfix|perf|security|docs|enh|enhancement|refactor|chore|style|test|build|ci)(?:\([^)]*\))?!?:\s*/i, '')
  s = s.replace(/(?:^|\s)\[?(?:Wave|Sprint|Task)\s*[-#]?\s*[A-Za-z0-9-]+\]?(?:\s*[:：\-|]+)?/gi, ' ')
  s = s.replace(/(?:^|\s)\[?C\d{1,3}(?:[-–]\d{1,3})?\]?(?:\s*[:：\-]+|(?=\s))/g, ' ')
  s = s.replace(/^[\s:：\-/|]+/, '').replace(/\s{2,}/g, ' ').trim()
  return s || String(subject ?? '').trim()
}

function inferCommitCategory(subject, body) {
  const s = String(subject ?? '')
  if (BREAKING_SUBJECT_RE.test(s) || /\bBREAKING\s+CHANGE\b/i.test(body || '')) return 'breaking'
  const m = /^(feat|feature|fix|bugfix|perf|security|docs|revert|enh|enhancement)\b/i.exec(s)
  if (m) {
    const t = m[1].toLowerCase()
    if (t === 'feat' || t === 'feature' || t === 'enh' || t === 'enhancement') return 'feature'
    if (t === 'fix' || t === 'bugfix') return 'fix'
    return t
  }
  if (/^(?:add|support|implement|introduce|enable|allow|create|新增|支持|实现|引入)/i.test(s)) return 'feature'
  if (/^(?:fix|resolve|prevent|handle|patch|repair|修复|解决|避免|拦截)/i.test(s)) return 'fix'
  return 'change'
}

function isAmbiguousCommitSubject(subject) {
  const raw = String(subject ?? '').trim()
  if (!raw) return true
  if (INTERNAL_PREFIX_RE.test(raw) && !BREAKING_SUBJECT_RE.test(raw)) return true
  if (VAGUE_SUBJECT_RE.test(raw)) return true
  const cleaned = cleanCommitSubject(raw)
  if (!cleaned || VAGUE_SUBJECT_RE.test(cleaned)) return true
  if (/^(?:update|tweak|adjust|modify|change|cleanup|clean|refactor|patch|bump|sync|misc)\s+\S+$/i.test(cleaned)) return true
  const hasSemanticPrefix = /^(?:feat|feature|fix|bugfix|perf|security|docs)(?:\([^)]*\))?!?:/i.test(raw)
  if (hasSemanticPrefix && cleaned.length >= 6) return false
  if (/[\u4e00-\u9fff]/.test(cleaned)) return cleaned.length < 6
  const words = cleaned.split(/\s+/).filter(Boolean)
  return words.length <= 2 && cleaned.length <= 16
}

function isInternalNoiseCommit(commit, pkgPublicPaths) {
  const files = commit.files || []
  const s = commit.subject || ''
  if (BREAKING_SUBJECT_RE.test(s) || /\bBREAKING\s+CHANGE\b/i.test(commit.body || '')) {
    return { filtered: false }
  }
  if (/^(?:Merge\s+(?:branch|pull\s+request|remote-tracking)|Revert\b.*\[skip ci\])/i.test(s) && files.length === 0) {
    return { filtered: true, reason: 'merge-housekeeping' }
  }

  const allInternalFiles = files.length > 0 && files.every((f) => (
    f.startsWith('.worktrees/') || TEST_OR_FIXTURE_RE.test(f) || CI_OR_INTERNAL_CONFIG_RE.test(f)
  ))
  if (allInternalFiles) {
    return { filtered: true, reason: 'tests-ci-or-worktree-only' }
  }

  const touchesPublicOrContract = files.some((f) => (
    classifyPublicSurface(f, pkgPublicPaths) !== null || isContractDocFile(f)
  ))

  if (TYPO_OR_FORMAT_RE.test(s) && !/^(?:feat|fix)(?:\([^)]*\))?:/i.test(s)) {
    return { filtered: true, reason: 'typo-or-formatting' }
  }
  if (INTERNAL_PREFIX_RE.test(s) && !touchesPublicOrContract) {
    return { filtered: true, reason: 'internal-prefix-non-public' }
  }
  return { filtered: false }
}

function extractBreakingSignals(repoRoot, range, netChangedFiles, commits) {
  const signals = []
  const versionFiles = netChangedFiles
    .map((x) => x.file)
    .filter((f) => /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|manifest\.json|SKILL\.md|\.nvmrc|\.node-version|\.python-version|rust-toolchain(?:\.toml)?)$/i.test(f))

  if (versionFiles.length > 0) {
    const diffRes = runGit(repoRoot, ['diff', '-U0', range.diffBaseSha, range.toSha, '--', ...versionFiles])
    if (diffRes.ok && diffRes.stdout) {
      let curFile = ''
      const pendingByKey = new Map()
      const flushPending = () => {
        for (const entry of pendingByKey.values()) {
          if (entry.before !== entry.after && (entry.after || entry.before)) {
            signals.push({
              type: 'min-runtime-change',
              file: entry.file,
              field: entry.field,
              before: entry.before ?? null,
              after: entry.after ?? null,
              detail: entry.before && entry.after
                ? `${entry.file} ${entry.field}: ${entry.before} -> ${entry.after}`
                : `${entry.file} ${entry.field}: ${entry.after || entry.before}`,
            })
          }
        }
        pendingByKey.clear()
      }

      for (const line of diffRes.stdout.split('\n')) {
        if (line.startsWith('diff --git ')) {
          flushPending()
          const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line)
          curFile = m ? posixPath(m[2]) : ''
          continue
        }
        if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@')) continue
        const sign = line[0]
        if (sign !== '+' && sign !== '-') continue
        const body = line.slice(1).trim()
        if (!body || !curFile) continue

        let field = null
        let value = body
        const baseName = posix.basename(curFile)
        if (baseName === 'package.json') {
          const m = /^"(engines|node|npm|pnpm|yarn|bun)"\s*:\s*(.+?)\s*,?$/.exec(body)
          if (m) { field = m[1] === 'engines' ? 'engines' : `engines.${m[1]}`; value = m[2].replace(/^"|"$/g, '') }
        } else if (baseName === 'pyproject.toml') {
          const m = /^(requires-python)\s*=\s*["']([^"']+)["']/.exec(body)
          if (m) { field = m[1]; value = m[2] }
        } else if (baseName === 'Cargo.toml') {
          const m = /^(rust-version)\s*=\s*["']([^"']+)["']/.exec(body)
          if (m) { field = m[1]; value = m[2] }
        } else if (baseName === 'go.mod') {
          const m = /^(go)\s+(\d+\.\d+(?:\.\d+)?)/.exec(body)
          if (m) { field = 'go'; value = m[2] }
        } else if (baseName === 'manifest.json' || baseName === 'SKILL.md') {
          const m = /^"?(minAppVersion|minEngineVersion|minimumVersion)"?\s*:\s*["']?([^"',}\s]+)["']?/.exec(body)
          if (m) { field = m[1]; value = m[2] }
        } else if (/^\.(?:nvmrc|node-version|python-version)$/.test(baseName) || baseName.startsWith('rust-toolchain')) {
          field = baseName
          value = body
        }

        if (field) {
          const k = `${curFile}::${field}`
          const rec = pendingByKey.get(k) || { file: curFile, field, before: undefined, after: undefined }
          if (sign === '-') rec.before = value
          else rec.after = value
          pendingByKey.set(k, rec)
        }
      }
      flushPending()
    }
  }

  for (const c of commits) {
    if (BREAKING_SUBJECT_RE.test(c.subject) || /\bBREAKING\s+CHANGE\b/i.test(c.body || '')) {
      signals.push({
        type: 'breaking-commit',
        file: c.files[0] || '',
        field: 'commit',
        before: null,
        after: cleanCommitSubject(c.subject),
        detail: `${c.shortHash}: ${cleanCommitSubject(c.subject)}`,
      })
    }
  }
  return signals
}

function extractDocTitleAndSummary(text, fallback) {
  if (!text) return { title: fallback, summary: '' }
  const lines = text.split('\n')
  const titleLine = lines.find((l) => /^#\s+/.test(l))
  const title = titleLine ? titleLine.replace(/^#\s+/, '').trim() : fallback
  const pickMeaningful = (slice) => slice
    .filter((l) => {
      const t = l.trim()
      if (!t || /^#/.test(t) || /^<!--/.test(t) || /^\|/.test(t) || /^[-*_`]{3,}$/.test(t)) return false
      if (/^(?:[-*]\s*)?(?:Status|Task|Spec|Updated|Created|Author|Date|Owner|Target|Plan Critique|来源|仓库|分支|目标分支|关联规范)\s*[:：]/i.test(t)) return false
      return true
    })
    .map((l) => l.replace(/^\s*(?:[-*]\s+(?:\[[ xX]\]\s*)?|>\s*)/, '').trim())
    .filter((l) => l && !/^<[^>\n]+>$/.test(l))

  const outcomeIdx = lines.findIndex((l) => /^#{2,3}\s+(?:完成后的记录|实际结果|成果摘要|Summary|Outcome|Goal|目标|背景与目标)\b/i.test(l.trim()))
  let picked = []
  if (outcomeIdx >= 0) {
    const rest = lines.slice(outcomeIdx + 1)
    const nextHeading = rest.findIndex((l) => /^#{1,3}\s+/.test(l))
    picked = pickMeaningful(nextHeading >= 0 ? rest.slice(0, nextHeading) : rest)
  }
  if (picked.length === 0) picked = pickMeaningful(lines)
  return { title, summary: picked.slice(0, 2).join(' ').slice(0, 180) }
}

function collectSpecsAndArchivedTodos(repoRoot, range, netChangedFiles) {
  const specsPrefix = posix.join('docs', 'specs') + '/'
  const archiveTodoPrefix = posix.join('docs', 'archive', 'todo') + '/'
  const implementedSpecs = []
  const archivedOutcomes = []

  for (const item of netChangedFiles) {
    if (item.status === 'D') continue
    if (item.file.startsWith(specsPrefix) && item.file.endsWith('.md')) {
      const curText = readFileAtRev(repoRoot, range.toSha, item.file)
      if (!curText || !/^\s*(?:[-*]\s*)?Status\s*:\s*implemented\b/im.test(curText)) continue
      let alreadyImplemented = false
      if (range.fromSha) {
        const oldText = readFileAtRev(repoRoot, range.fromSha, item.file)
        if (oldText && /^\s*(?:[-*]\s*)?Status\s*:\s*implemented\b/im.test(oldText)) {
          alreadyImplemented = true
        }
      }
      if (!alreadyImplemented) {
        const meta = extractDocTitleAndSummary(curText, posix.basename(item.file, '.md'))
        implementedSpecs.push({ file: item.file, title: meta.title, summary: meta.summary })
      }
    } else if (item.file.startsWith(archiveTodoPrefix) && item.file.endsWith('.md')) {
      const curText = readFileAtRev(repoRoot, range.toSha, item.file)
      if (!curText) continue
      const meta = extractDocTitleAndSummary(curText, posix.basename(item.file, '.md'))
      archivedOutcomes.push({ file: item.file, title: meta.title, summary: meta.summary })
    }
  }

  return { implementedSpecs, archivedOutcomes }
}

function buildTextBrief(payload) {
  const lines = [
    '=== DEV-GOVERN (RELEASE-PREP) ===',
    `Repo Root      : ${payload.repoRoot}`,
    `Range          : ${payload.range.rangeSpec} (mode=${payload.range.fromMode}, from=${payload.range.from || 'root'}, to=${payload.range.to})`,
    `Current Version: ${payload.version.currentVersion || '(not declared)'} | Target: ${payload.version.targetTag || payload.version.normalized || '(unset; pass --version X.Y.Z)'}`,
    `Notes Mode     : ${payload.notesMode.mode} -> ${payload.notesMode.targetFile}${payload.notesMode.existingNotePresent ? ' (already exists)' : ''}`,
    `Stats          : commits=${payload.stats.totalCommits}, userFacing=${payload.stats.userFacingCount}, filteredInternal=${payload.stats.filteredInternalCount}, publicTouched=${payload.stats.publicSurfaceCount}, unaccountedPublic=${payload.stats.unaccountedPublicCount}, breaking=${payload.stats.breakingSignalsCount}`,
  ]

  if (payload.version.versionSources.length > 0) {
    lines.push('', '--- Version Sources ---')
    for (const s of payload.version.versionSources) {
      lines.push(`  - ${s.file} (${s.field}): ${s.version}`)
    }
    if (payload.version.mismatchWarning) lines.push(`  Warning: ${payload.version.mismatchWarning}`)
  }

  if (payload.breakingSignals.length > 0) {
    lines.push('', '--- Breaking & Runtime Floor Signals ---')
    for (const b of payload.breakingSignals) lines.push(`  - [${b.type}] ${b.detail}`)
  }

  lines.push('', '--- User-Facing Release Note Candidates (Noise-Filtered) ---')
  if (payload.userFacingCandidates.length === 0) {
    lines.push('  No explicit user-facing commit candidates extracted; inspect unaccountedPublicFiles or specs below.')
  } else {
    for (const c of payload.userFacingCandidates) {
      lines.push(`  - [${c.category.toUpperCase()}] ${c.summary} (${c.shortHash})`)
    }
  }

  if (payload.implementedSpecs.length > 0 || payload.archivedOutcomes.length > 0) {
    lines.push('', '--- Implemented Specs & Archived Task Outcomes ---')
    for (const sp of payload.implementedSpecs) lines.push(`  - [SPEC] ${sp.title} (${sp.file})${sp.summary ? `: ${sp.summary}` : ''}`)
    for (const td of payload.archivedOutcomes) lines.push(`  - [OUTCOME] ${td.title} (${td.file})${td.summary ? `: ${td.summary}` : ''}`)
  }

  if (payload.publicSurfaceTouched.length > 0 || payload.unaccountedPublicFiles.length > 0) {
    lines.push('', '--- Public Surface Cross-Check ---')
    lines.push(`  Touched (${payload.publicSurfaceTouched.length}): ${payload.publicSurfaceTouched.join(', ')}`)
    if (payload.unaccountedPublicFiles.length > 0) {
      lines.push(`  [AUDIT_ALERT] Unaccounted Public Files (${payload.unaccountedPublicFiles.length}) -- verify each for user-visible notes:`)
      for (const u of payload.unaccountedPublicFiles) {
        lines.push(`    - ${u.file} [${u.kind}]: ${u.reason} (${u.commits.map((c) => `${c.shortHash} "${c.subject}"`).join('; ')})`)
      }
    }
  }

  lines.push('', '[NEXT STEP]', ...payload.nextSteps.map((s) => `  ${s}`), '')
  return lines.join('\n')
}

export function handleReleasePrep(repoRoot, isGit, opts) {
  if (!isGit) {
    process.stderr.write('Error: `release-prep` requires a git repository.\n')
    return 1
  }
  const hasHead = runGit(repoRoot, ['rev-parse', '--verify', 'HEAD'])
  if (!hasHead.ok) {
    process.stderr.write('Error: repository has no commits yet.\n')
    return 1
  }

  const range = resolveBaseAndRange(repoRoot, opts)
  if (range.error) {
    process.stderr.write(`Error: ${range.error}\n`)
    return range.code || 2
  }

  let requestedVersion = null
  let normalizedVersion = null
  const tagPrefix = detectTagPrefix(repoRoot, range.from)
  let targetTag = null
  if (opts.version !== undefined) {
    requestedVersion = String(opts.version).trim()
    if (!requestedVersion || !/\d/.test(requestedVersion) || /\s/.test(requestedVersion)) {
      process.stderr.write(`Error: invalid --version "${opts.version}"\n`)
      return 2
    }
    normalizedVersion = requestedVersion.replace(/^v/i, '')
    targetTag = /^v/i.test(requestedVersion) ? `v${normalizedVersion}` : `${tagPrefix}${normalizedVersion}`
  }

  const { sources, pkg } = detectVersionSources(repoRoot, range.toSha)
  const currentVersion = sources[0]?.version ?? null
  const distinctVers = [...new Set(sources.map((s) => s.version.replace(/^v/i, '')))]
  let mismatchWarning = null
  if (distinctVers.length > 1) {
    mismatchWarning = `Multiple version sources disagree: ${sources.map((s) => `${s.file}=${s.version}`).join(', ')}`
  } else if (normalizedVersion && currentVersion && currentVersion.replace(/^v/i, '') === normalizedVersion) {
    mismatchWarning = null
  } else if (normalizedVersion && currentVersion) {
    mismatchWarning = `Sync authoritative manifest(s) from ${currentVersion} to ${normalizedVersion} in the release prep commit before tagging.`
  }

  const notesMode = detectNotesMode(repoRoot, targetTag)
  const { commits, netChangedFiles } = collectCommitsAndFiles(repoRoot, range)
  const pkgPublicPaths = collectPackagePublicPaths(pkg)

  const filteredCommits = []
  const userFacingCandidates = []
  const ambiguousCommits = []

  for (const c of commits) {
    const noise = isInternalNoiseCommit(c, pkgPublicPaths)
    if (noise.filtered) {
      filteredCommits.push({ hash: c.shortHash, reason: noise.reason, subject: c.subject })
      continue
    }
    const category = inferCommitCategory(c.subject, c.body)
    const ambiguous = isAmbiguousCommitSubject(c.subject)
    const entry = {
      hash: c.hash,
      shortHash: c.shortHash,
      category,
      summary: cleanCommitSubject(c.subject),
      rawSubject: c.subject,
      files: c.files,
      ambiguous,
    }
    if (ambiguous) {
      ambiguousCommits.push(entry)
    } else {
      userFacingCandidates.push(entry)
    }
  }

  const breakingSignals = extractBreakingSignals(repoRoot, range, netChangedFiles, commits)
  const { implementedSpecs, archivedOutcomes } = collectSpecsAndArchivedTodos(repoRoot, range, netChangedFiles)

  const publicSurfaceTouched = []
  const unaccountedPublicFiles = []
  const seenPublic = new Set()
  const describedTexts = [
    ...implementedSpecs.map((s) => `${s.title} ${s.summary}`),
    ...archivedOutcomes.map((a) => `${a.title} ${a.summary}`),
  ].join('\n')

  for (const item of netChangedFiles) {
    const kind = classifyPublicSurface(item.file, pkgPublicPaths)
    if (!kind || seenPublic.has(item.file)) continue
    seenPublic.add(item.file)
    publicSurfaceTouched.push(item.file)

    const touchingCommits = commits.filter((c) => c.files.includes(item.file))
    const hasClearUserCommit = touchingCommits.some((c) => (
      !isInternalNoiseCommit(c, pkgPublicPaths).filtered && !isAmbiguousCommitSubject(c.subject)
    ))
    const baseName = posix.basename(item.file)
    const mentionedInSpecOrTodo = describedTexts.includes(item.file) || (baseName.length > 4 && describedTexts.includes(baseName))
    const hasMinRuntimeDiff = breakingSignals.some((b) => b.file === item.file)

    if (!hasClearUserCommit && !mentionedInSpecOrTodo && !hasMinRuntimeDiff) {
      const reason = touchingCommits.length === 0
        ? 'Changed in net range diff without descriptive commit attribution'
        : touchingCommits.some((c) => isAmbiguousCommitSubject(c.subject))
          ? 'Touched only by ambiguous or non-standard commit subject(s)'
          : 'Touched only by internal-prefix commit(s) (chore/refactor/style/test/ci)'
      unaccountedPublicFiles.push({
        file: item.file,
        kind,
        reason,
        commits: touchingCommits.map((c) => ({ shortHash: c.shortHash, subject: c.subject })),
      })
    }
  }

  publicSurfaceTouched.sort()
  unaccountedPublicFiles.sort((a, b) => a.file.localeCompare(b.file))

  const nextSteps = [
    `Write user-facing release notes in ${notesMode.targetFile} focusing strictly on observable changes, upgrade actions, and resolved user issues (no internal commit IDs or refactor logs).`,
    'Feel free to adapt sections or use CHANGELOG.md; omit empty sections rather than keeping blank headings.',
    'Do NOT create git tags, edit published releases, or rewrite pushed history unless a human maintainer explicitly orders a release.',
  ]
  if (unaccountedPublicFiles.length > 0) {
    nextSteps.unshift(`Inspect ${unaccountedPublicFiles.length} unaccounted public file(s) listed above to confirm whether any user-visible change was missed.`)
  }

  const payload = {
    mode: 'release-prep',
    repoRoot: posixPath(repoRoot),
    range: {
      from: range.from,
      fromSha: range.fromSha,
      fromMode: range.fromMode,
      to: range.to,
      toSha: range.toSha,
      rangeSpec: range.rangeSpec,
      isInitialRelease: range.isInitialRelease,
    },
    version: {
      requested: requestedVersion,
      normalized: normalizedVersion,
      tagPrefix,
      targetTag,
      currentVersion,
      versionSources: sources,
      mismatchWarning,
    },
    notesMode,
    stats: {
      totalCommits: commits.length,
      filteredInternalCount: filteredCommits.length,
      userFacingCount: userFacingCandidates.length,
      ambiguousCommitsCount: ambiguousCommits.length,
      netChangedFilesCount: netChangedFiles.length,
      publicSurfaceCount: publicSurfaceTouched.length,
      unaccountedPublicCount: unaccountedPublicFiles.length,
      breakingSignalsCount: breakingSignals.length,
    },
    breakingSignals,
    userFacingCandidates,
    ambiguousCommits,
    implementedSpecs,
    archivedOutcomes,
    publicSurfaceTouched,
    unaccountedPublicFiles,
    filteredCommits,
    nextSteps,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`${buildTextBrief(payload)}\n`)
  }
  return 0
}
