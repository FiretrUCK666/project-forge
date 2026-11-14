/**
 * release-prep-lib.mjs -- Multi-version release-prep collector, shallow-clone guard,
 * workspace version aggregator, and noise filter for dev-govern `release-prep`.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { gitRun, posixPath, readTextSafe } from '../../lib/git.mjs'
import { discoverWorkspacePackages } from '../../lib/profile.mjs'
import { splitDiffByFile } from '../../lib/static-gates.mjs'

const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const TEST_OR_FIXTURE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|fixtures?)\/|\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|test_[^/]+\.py$|(?:Tests?|IT)\.(?:java|kt|cs)$/i
const CI_OR_INTERNAL_CONFIG_RE = /^(?:\.github\/|\.circleci\/|\.husky\/|\.vscode\/|\.idea\/|\.(?:eslint|prettier|stylelint|editorconfig|gitattributes|gitignore|travis\.yml|drone\.yml)|Jenkinsfile|azure-pipelines\.ya?ml)/i
const INTERNAL_PREFIX_RE = /^(?:test|tests|chore|ci|build|style|refactor)(?:\([^)]*\))?:\s*/i
const BREAKING_SUBJECT_RE = /^[a-z]+(?:\([^)]*\))?!:\s*/i
const TYPO_OR_FORMAT_RE = /^(?:(?:docs|style|chore)(?:\([^)]*\))?:\s*)?(?:fix\s+typos?|typos?|formatting|format\s+code|lint(?:\s+fix)?|whitespace|prettier|eslint|错别字|错字|排版|格式(?:整理|微调)?)\b/i
const VAGUE_SUBJECT_RE = /^(?:update|updates|updated|wip|misc|cleanup|clean\s*up|tweak|tweaks|fixup|squash|sync|temp|tmp|minor|adjust|changes|patch|fix|fix\s+bug|minor\s+changes|update\s+(?:code|files?|docs?|readme|cli|index|config)|修改|改动|更新|调整|微调|清理|同步|提交|临时|修复)$/i

async function readFileAtRev(repoRoot, rev, relPosix) {
  const show = await gitRun(repoRoot, ['show', `${rev}:${relPosix}`])
  if (show.ok) return show.stdout
  if (rev === 'HEAD') return readTextSafe(join(repoRoot, relPosix))
  return undefined
}

function parseJsonStr(raw) {
  if (!raw) return undefined
  try { return JSON.parse(raw) } catch { return undefined }
}

function collectPackagePublicPaths(pkg, dirRel = '') {
  const out = new Set()
  if (!pkg || typeof pkg !== 'object') return out
  const addPath = (val) => {
    if (typeof val !== 'string') return
    const norm = posix.normalize(posixPath(val)).replace(/^\.\//, '')
    if (norm && !norm.startsWith('..') && !norm.includes('*')) {
      out.add(dirRel ? `${dirRel}/${norm}` : norm)
    }
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

async function resolveBaseAndRange(repoRoot, gitDir, opts) {
  const targetRev = String(opts.to || 'HEAD').trim() || 'HEAD'
  const toCheck = await gitRun(repoRoot, ['rev-parse', '--verify', `${targetRev}^{commit}`])
  if (!toCheck.ok || !toCheck.stdout.trim()) {
    return { error: `Invalid --to revision: "${targetRev}"`, code: 2 }
  }
  const toSha = toCheck.stdout.trim()
  const shallowCmd = await gitRun(repoRoot, ['rev-parse', '--is-shallow-repository'])
  const isShallow = (shallowCmd.ok && shallowCmd.stdout.trim() === 'true')
    || existsSync(join(gitDir ?? join(repoRoot, '.git'), 'shallow'))

  if (opts.from) {
    const fromCheck = await gitRun(repoRoot, ['rev-parse', '--verify', `${opts.from}^{commit}`])
    if (!fromCheck.ok || !fromCheck.stdout.trim()) {
      return { error: `Invalid --from revision: "${opts.from}"`, code: 2 }
    }
    const fromSha = fromCheck.stdout.trim()
    return {
      from: opts.from, fromSha, fromMode: 'explicit', to: targetRev, toSha,
      rangeSpec: `${opts.from}..${targetRev}`, diffBaseSha: fromSha, isInitialRelease: false, isShallow,
    }
  }

  let fromTag = null
  const tagsAtTo = await gitRun(repoRoot, ['tag', '--points-at', toSha])
  const excludeArgs = []
  if (tagsAtTo.ok && tagsAtTo.stdout) {
    for (const t of tagsAtTo.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) excludeArgs.push('--exclude', t)
  }
  const desc = await gitRun(repoRoot, ['describe', '--tags', '--abbrev=0', ...excludeArgs, toSha])
  if (desc.ok && desc.stdout.trim()) {
    const tag = desc.stdout.trim()
    const tagShaRes = await gitRun(repoRoot, ['rev-parse', '--verify', `${tag}^{commit}`])
    if (tagShaRes.ok && tagShaRes.stdout.trim() && tagShaRes.stdout.trim() !== toSha) fromTag = tag
  }

  if (fromTag) {
    const fromSha = (await gitRun(repoRoot, ['rev-parse', '--verify', `${fromTag}^{commit}`])).stdout.trim()
    return {
      from: fromTag, fromSha, fromMode: 'auto-tag', to: targetRev, toSha,
      rangeSpec: `${fromTag}..${targetRev}`, diffBaseSha: fromSha, isInitialRelease: false, isShallow,
    }
  }

  return {
    from: null, fromSha: null, fromMode: 'root', to: targetRev, toSha,
    rangeSpec: targetRev, diffBaseSha: EMPTY_TREE_SHA, isInitialRelease: true, isShallow,
  }
}

async function detectTagPrefix(repoRoot, fromTag) {
  if (fromTag && /^v\d/i.test(fromTag)) return 'v'
  if (fromTag && /^\d/.test(fromTag)) return ''
  const tags = await gitRun(repoRoot, ['tag', '--list', '--sort=-creatordate'])
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
      if (/^\S/.test(line)) inMeta = false
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

function parsePomVersion(text) {
  if (!text) return null
  const stripped = text.replace(/<parent>[\s\S]*?<\/parent>/gi, '').replace(/<dependencies>[\s\S]*?<\/dependencies>/gi, '')
  return /<version>\s*([^<\s$][^<\s]*)\s*<\/version>/i.exec(stripped)?.[1]?.trim() ?? null
}

function parseGradleVersion(text) {
  if (!text) return null
  return /^\s*version\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]?.trim() ?? null
}

async function detectPackageManifestVersions(repoRoot, rev, dirRel, manifests) {
  const out = []
  const publicPaths = new Set()
  const prefix = dirRel ? `${dirRel}/` : ''
  const pkgInfo = { pkg: null }

  if (!dirRel) {
    const skillVer = parseSkillMdVersion(await readFileAtRev(repoRoot, rev, 'SKILL.md'))
    if (skillVer) out.push({ file: 'SKILL.md', field: 'metadata.version', version: skillVer, package: 'root', dirRel: '' })
  }

  const pkg = parseJsonStr(await readFileAtRev(repoRoot, rev, `${prefix}package.json`))
  if (pkg) {
    pkgInfo.pkg = pkg
    for (const p of collectPackagePublicPaths(pkg, dirRel)) publicPaths.add(p)
    if (pkg.version) out.push({ file: `${prefix}package.json`, field: 'version', version: String(pkg.version), package: pkg.name || dirRel || 'root', dirRel })
  }

  const pyVer = parseTomlSectionVersion(await readFileAtRev(repoRoot, rev, `${prefix}pyproject.toml`), ['project', 'tool.poetry'])
  if (pyVer) out.push({ file: `${prefix}pyproject.toml`, field: 'version', version: pyVer, package: dirRel || 'root', dirRel })

  const cargoVer = parseTomlSectionVersion(await readFileAtRev(repoRoot, rev, `${prefix}Cargo.toml`), ['package'])
  if (cargoVer) out.push({ file: `${prefix}Cargo.toml`, field: 'package.version', version: cargoVer, package: dirRel || 'root', dirRel })

  const man = parseJsonStr(await readFileAtRev(repoRoot, rev, `${prefix}manifest.json`))
  if (man?.version) out.push({ file: `${prefix}manifest.json`, field: 'version', version: String(man.version), package: man.name || dirRel || 'root', dirRel })

  if (manifests.includes('pom.xml')) {
    const pomVer = parsePomVersion(await readFileAtRev(repoRoot, rev, `${prefix}pom.xml`))
    if (pomVer) out.push({ file: `${prefix}pom.xml`, field: 'version', version: pomVer, package: dirRel || 'root', dirRel })
  }
  for (const gf of ['build.gradle', 'build.gradle.kts']) {
    if (manifests.includes(gf)) {
      const gv = parseGradleVersion(await readFileAtRev(repoRoot, rev, `${prefix}${gf}`))
      if (gv) out.push({ file: `${prefix}${gf}`, field: 'version', version: gv, package: dirRel || 'root', dirRel })
    }
  }
  for (const mf of manifests.filter((m) => /\.csproj$/i.test(m))) {
    const csTxt = await readFileAtRev(repoRoot, rev, `${prefix}${mf}`)
    const cv = csTxt ? /<Version>\s*([^<\s]+)\s*<\/Version>/i.exec(csTxt)?.[1]?.trim() : null
    if (cv) out.push({ file: `${prefix}${mf}`, field: 'Version', version: cv, package: dirRel || mf, dirRel })
  }

  return { sources: out, pkg: pkgInfo.pkg, publicPaths }
}

async function detectVersionSources(repoRoot, rev) {
  const discovery = discoverWorkspacePackages(repoRoot)
  const rootManifests = discovery.packages.find((p) => p.dirRel === '')?.manifests ?? ['package.json', 'pyproject.toml', 'Cargo.toml', 'manifest.json']
  const rootRes = await detectPackageManifestVersions(repoRoot, rev, '', rootManifests)
  const rootSources = rootRes.sources
  const allPublicPaths = new Set(rootRes.publicPaths)
  const workspacePackages = []

  for (const pkg of discovery.packages) {
    if (!pkg.dirRel) continue
    const subRes = await detectPackageManifestVersions(repoRoot, rev, pkg.dirRel, pkg.manifests)
    for (const p of subRes.publicPaths) allPublicPaths.add(p)
    for (const s of subRes.sources) workspacePackages.push(s)
  }

  return {
    rootSources,
    workspacePackages,
    sources: rootSources.length > 0 ? rootSources : workspacePackages,
    pkg: rootRes.pkg,
    pkgPublicPaths: allPublicPaths,
  }
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
    return { mode: 'directory', targetFile, existingNotePresent, hasReleasingDoc: hasReleasing, hasChangelog }
  }
  if (hasChangelog) {
    const chg = readTextSafe(join(repoRoot, 'CHANGELOG.md')) || ''
    const bare = tagName.replace(/^v/i, '')
    const existingNotePresent = Boolean(
      targetTag && new RegExp(`^##\\s+\\[?v?${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]?`, 'mi').test(chg),
    )
    return { mode: 'changelog', targetFile: 'CHANGELOG.md', existingNotePresent, hasReleasingDoc: false, hasChangelog: true }
  }
  return { mode: 'unconfigured', targetFile: `${notesDirRel}/${tagName}.md`, existingNotePresent: false, hasReleasingDoc: false, hasChangelog: false }
}

async function collectCommitsAndFiles(repoRoot, range) {
  const logArg = range.fromSha ? `${range.fromSha}..${range.toSha}` : range.toSha
  const logRes = await gitRun(repoRoot, [
    'log', '--root', logArg, '--name-status', '--format=__COMMIT__%H\t%ct\t%an\t%s\t%b__END_HDR__',
  ], { maxBuffer: 32 * 1024 * 1024 })
  const commits = []
  if (logRes.ok && logRes.stdout) {
    for (const block of logRes.stdout.split('__COMMIT__').filter(Boolean)) {
      const hdrEnd = block.indexOf('__END_HDR__')
      if (hdrEnd < 0) continue
      const hdr = block.slice(0, hdrEnd)
      const tail = block.slice(hdrEnd + 11)
      const parts = hdr.split('\t')
      const hash = (parts[0] || '').trim()
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
        hash, shortHash: hash.slice(0, 7), ts: Number(parts[1]) || 0,
        author: (parts[2] || '').trim(), subject: (parts[3] || '').trim(),
        body: parts.slice(4).join('\t').trim(), files: [...new Set(files)],
      })
    }
  }

  const diffRes = await gitRun(repoRoot, ['diff', '--name-status', range.diffBaseSha, range.toSha], { maxBuffer: 32 * 1024 * 1024 })
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
  if (/(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|manifest\.json|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(f) || /\.csproj$/i.test(f)) return 'manifest'
  if (/^(?:templates|kit)\//i.test(f)) return 'distributed-asset'
  if (/^(?:bin|cmd|cli)\//i.test(f)) return 'cli-entrypoint'
  if (/^(?:(?:packages|apps)\/[^/]+\/)?(?:src\/)?(?:index|main|cli|app|server|mod|lib)\.[^/]+$/i.test(f)) return 'top-level-entry'
  if (/^src\/[^/]+\/__init__\.py$/i.test(f)) return 'python-package-entry'
  if (/^[^/]+\.(?:mjs|cjs|js|ts|py|go|rs)$/i.test(f)) return 'root-module'
  if (/^scripts\/[^/]+\.(?:mjs|js|ts|py|sh)$/i.test(f)) return 'top-level-script'
  return null
}

function isContractDocFile(relPosix) {
  return /^(?:README(?:\.[A-Za-z-]+)?\.md|SKILL\.md|CHANGELOG\.md|docs\/specs\/.+\.md|docs\/TDD\.md)$/i.test(posixPath(relPosix))
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
  if (/^(?:feat|feature|fix|bugfix|perf|security|docs)(?:\([^)]*\))?!?:/i.test(raw) && cleaned.length >= 6) return false
  if (/[\u4e00-\u9fff]/.test(cleaned)) return cleaned.length < 6
  return cleaned.split(/\s+/).filter(Boolean).length <= 2 && cleaned.length <= 16
}

function isInternalNoiseCommit(commit, pkgPublicPaths) {
  const files = commit.files || []
  const s = commit.subject || ''
  if (BREAKING_SUBJECT_RE.test(s) || /\bBREAKING\s+CHANGE\b/i.test(commit.body || '')) return { filtered: false }
  if (/^(?:Merge\s+(?:branch|pull\s+request|remote-tracking)|Revert\b.*\[skip ci\])/i.test(s) && files.length === 0) {
    return { filtered: true, reason: 'merge-housekeeping' }
  }
  const allInternalFiles = files.length > 0 && files.every((f) => (
    f.startsWith('.worktrees/') || TEST_OR_FIXTURE_RE.test(f) || CI_OR_INTERNAL_CONFIG_RE.test(f)
  ))
  if (allInternalFiles) {
    return { filtered: true, reason: 'tests-ci-or-worktree-only' }
  }
  const touchesPublicOrContract = files.some((f) => classifyPublicSurface(f, pkgPublicPaths) !== null || isContractDocFile(f))
  if (TYPO_OR_FORMAT_RE.test(s) && !/^(?:feat|fix)(?:\([^)]*\))?:/i.test(s)) return { filtered: true, reason: 'typo-or-formatting' }
  if (INTERNAL_PREFIX_RE.test(s) && !touchesPublicOrContract) return { filtered: true, reason: 'internal-prefix-non-public' }
  return { filtered: false }
}

async function extractBreakingSignals(repoRoot, range, netChangedFiles, commits) {
  const signals = []
  const versionFiles = netChangedFiles
    .map((x) => x.file)
    .filter((f) => /(?:^|\/)(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|manifest\.json|SKILL\.md|pom\.xml|build\.gradle(?:\.kts)?|\.nvmrc|\.node-version|\.python-version|rust-toolchain(?:\.toml)?)$|\.csproj$/i.test(f))

  if (versionFiles.length > 0) {
    const diffRes = await gitRun(repoRoot, ['diff', '-U0', range.diffBaseSha, range.toSha, '--', ...versionFiles])
    if (diffRes.ok && diffRes.stdout) {
      const chunks = splitDiffByFile(diffRes.stdout)
      for (const [curFile, fileChunk] of chunks.entries()) {
        const pendingByKey = new Map()
        const baseName = posix.basename(curFile)
        for (const line of fileChunk.split('\n')) {
          if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('@@') || line.startsWith('diff --git ')) continue
          const sign = line[0]
          if (sign !== '+' && sign !== '-') continue
          const body = line.slice(1).trim()
          if (!body) continue

          let field = null
          let value = body
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
          } else if (baseName === 'pom.xml') {
            const m = /<(maven\.compiler\.(?:source|target|release)|java\.version)>([^<]+)<\//i.exec(body)
            if (m) { field = m[1]; value = m[2].trim() }
          } else if (/\.csproj$/i.test(baseName)) {
            const m = /<(TargetFramework|TargetFrameworks)>([^<]+)<\//i.exec(body)
            if (m) { field = m[1]; value = m[2].trim() }
          } else if (/^\.(?:nvmrc|node-version|python-version)$/.test(baseName) || baseName.startsWith('rust-toolchain')) {
            field = baseName
            value = body
          }

          if (field) {
            const rec = pendingByKey.get(field) || { file: curFile, field, before: undefined, after: undefined }
            if (sign === '-') rec.before = value
            else rec.after = value
            pendingByKey.set(field, rec)
          }
        }
        for (const entry of pendingByKey.values()) {
          if (entry.before !== entry.after && (entry.after || entry.before)) {
            signals.push({
              type: 'min-runtime-change', file: entry.file, field: entry.field,
              before: entry.before ?? null, after: entry.after ?? null,
              detail: entry.before && entry.after
                ? `${entry.file} ${entry.field}: ${entry.before} -> ${entry.after}`
                : `${entry.file} ${entry.field}: ${entry.after || entry.before}`,
            })
          }
        }
      }
    }
  }

  for (const c of commits) {
    if (BREAKING_SUBJECT_RE.test(c.subject) || /\bBREAKING\s+CHANGE\b/i.test(c.body || '')) {
      signals.push({
        type: 'breaking-commit', file: c.files[0] || '', field: 'commit',
        before: null, after: cleanCommitSubject(c.subject),
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
      if (!t || /^#/.test(t) || /^<!--/.test(t) || /^\|/.test(t) || /^[-*_`]{3,}$/.test(t) || t === '---') return false
      if (/^(?:[-*]\s*)?(?:kind|title|status|tier|created|updated|issue|pr|branch|owner|approved|implemented|plan_critique|related_\w+|Status|Task|Spec|Updated|Created|Author|Date|Owner|Target|Plan Critique|来源|仓库|分支|目标分支|关联规范)\s*[:：]/i.test(t)) return false
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

async function collectSpecsAndArchivedTodos(repoRoot, range, netChangedFiles) {
  const specsPrefix = posix.join('docs', 'specs') + '/'
  const archiveSpecsPrefix = posix.join('docs', 'archive', 'specs') + '/'
  const archiveTodoPrefix = posix.join('docs', 'archive', 'todo') + '/'
  const implementedSpecs = []
  const archivedOutcomes = []

  for (const item of netChangedFiles) {
    if (item.status === 'D') continue
    if ((item.file.startsWith(specsPrefix) || item.file.startsWith(archiveSpecsPrefix)) && item.file.endsWith('.md')) {
      const curText = await readFileAtRev(repoRoot, range.toSha, item.file)
      if (!curText || !/^\s*(?:[-*]\s*)?(?:status|implemented)\s*:\s*(?:implemented|true)\b/im.test(curText)) continue
      let alreadyImplemented = false
      if (range.fromSha) {
        const oldText = await readFileAtRev(repoRoot, range.fromSha, item.file)
        if (oldText && /^\s*(?:[-*]\s*)?(?:status|implemented)\s*:\s*(?:implemented|true)\b/im.test(oldText)) alreadyImplemented = true
      }
      if (!alreadyImplemented) {
        const meta = extractDocTitleAndSummary(curText, posix.basename(item.file, '.md'))
        implementedSpecs.push({ file: item.file, title: meta.title, summary: meta.summary })
      }
    } else if (item.file.startsWith(archiveTodoPrefix) && item.file.endsWith('.md')) {
      const curText = await readFileAtRev(repoRoot, range.toSha, item.file)
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
    `Range          : ${payload.range.rangeSpec} (mode=${payload.range.fromMode}, from=${payload.range.from || 'root'}, to=${payload.range.to}, shallow=${payload.range.isShallow})`,
    `Current Version: ${payload.version.currentVersion || '(not declared)'} | Target: ${payload.version.targetTag || payload.version.normalized || '(unset; pass --version X.Y.Z)'}`,
    `Notes Mode     : ${payload.notesMode.mode} -> ${payload.notesMode.targetFile}${payload.notesMode.existingNotePresent ? ' (already exists)' : ''}`,
    `Stats          : commits=${payload.stats.totalCommits}, userFacing=${payload.stats.userFacingCount}, filteredInternal=${payload.stats.filteredInternalCount}, publicTouched=${payload.stats.publicSurfaceCount}, unaccountedPublic=${payload.stats.unaccountedPublicCount}, breaking=${payload.stats.breakingSignalsCount}`,
  ]
  if (payload.shallowCloneWarning) lines.push(`WARNING        : ${payload.shallowCloneWarning}`)

  if (payload.version.versionSources.length > 0 || (payload.version.workspacePackages?.length ?? 0) > 0) {
    lines.push('', '--- Version Sources ---')
    for (const s of payload.version.versionSources) lines.push(`  - ${s.file} (${s.field}): ${s.version}`)
    for (const ws of payload.version.workspacePackages ?? []) {
      if (!payload.version.versionSources.some((r) => r.file === ws.file)) {
        lines.push(`  - [workspace:${ws.package}] ${ws.file} (${ws.field}): ${ws.version}`)
      }
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
    for (const c of payload.userFacingCandidates) lines.push(`  - [${c.category.toUpperCase()}] ${c.summary} (${c.shortHash})`)
  }

  if (payload.implementedSpecs.length > 0 || payload.archivedOutcomes.length > 0) {
    lines.push('', '--- Implemented Specs & Archived Task Outcomes ---')
    for (const sp of payload.implementedSpecs) lines.push(`  - [SPEC] ${sp.title} (${sp.file})${sp.summary ? `: ${sp.summary}` : ''}`)
    for (const td of payload.archivedOutcomes) lines.push(`  - [OUTCOME] ${td.title} (${td.file})${td.summary ? `: ${td.summary}` : ''}`)
  }

  if (payload.publicSurfaceTouched.length > 0 || payload.unaccountedPublicFiles.length > 0) {
    lines.push('', '--- Public Surface Cross-Check ---', `  Touched (${payload.publicSurfaceTouched.length}): ${payload.publicSurfaceTouched.join(', ')}`)
    if (payload.unaccountedPublicFiles.length > 0) {
      lines.push(`  [AUDIT_ALERT] Unaccounted Public Files (${payload.unaccountedPublicFiles.length}) -- verify each for user-visible notes:`)
      for (const u of payload.unaccountedPublicFiles) {
        lines.push(`    - ${u.file} [${u.kind}]: ${u.reason} (${u.commits.map((c) => `${c.shortHash} "${c.subject}"`).join('; ')})`)
      }
    }
  }
  return lines.join('\n')
}

export async function handleReleasePrep(repoRoot, mainRoot, gitDir, isGit, opts) {
  if (!isGit) {
    process.stderr.write('Error: `release-prep` requires a git repository.\n')
    return 1
  }
  if (!(await gitRun(repoRoot, ['rev-parse', '--verify', 'HEAD'])).ok) {
    process.stderr.write('Error: repository has no commits yet.\n')
    return 1
  }

  const range = await resolveBaseAndRange(repoRoot, gitDir, opts)
  if (range.error) {
    process.stderr.write(`Error: ${range.error}\n`)
    return range.code || 2
  }

  let requestedVersion = null
  let normalizedVersion = null
  const tagPrefix = await detectTagPrefix(repoRoot, range.from)
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

  const { rootSources, workspacePackages, sources, pkgPublicPaths } = await detectVersionSources(repoRoot, range.toSha)
  const currentVersion = sources[0]?.version ?? null
  const parityCheckSet = rootSources.length > 0 ? rootSources : sources
  const distinctVers = [...new Set(parityCheckSet.map((s) => s.version.replace(/^v/i, '')))]
  let mismatchWarning = null
  if (distinctVers.length > 1) {
    mismatchWarning = `Multiple version sources disagree: ${parityCheckSet.map((s) => `${s.file}=${s.version}`).join(', ')}`
  } else if (normalizedVersion && currentVersion && currentVersion.replace(/^v/i, '') === normalizedVersion) {
    mismatchWarning = null
  } else if (normalizedVersion && currentVersion) {
    mismatchWarning = `Sync authoritative manifest(s) from ${currentVersion} to ${normalizedVersion} in the release prep commit before tagging.`
  }

  const notesMode = detectNotesMode(repoRoot, targetTag)
  const { commits, netChangedFiles } = await collectCommitsAndFiles(repoRoot, range)
  const shallowCloneWarning = range.isShallow
    ? 'Shallow clone detected (.git/shallow); git describe/log history is truncated — run `git fetch --unshallow --tags` before relying on release range or unaccountedPublicFiles.'
    : null

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
      hash: c.hash, shortHash: c.shortHash, category,
      summary: cleanCommitSubject(c.subject), rawSubject: c.subject, files: c.files, ambiguous,
    }
    if (ambiguous) ambiguousCommits.push(entry)
    else userFacingCandidates.push(entry)
  }

  const breakingSignals = await extractBreakingSignals(repoRoot, range, netChangedFiles, commits)
  const { implementedSpecs, archivedOutcomes } = await collectSpecsAndArchivedTodos(repoRoot, range, netChangedFiles)

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
        file: item.file, kind, reason,
        commits: touchingCommits.map((c) => ({ shortHash: c.shortHash, subject: c.subject })),
      })
    }
  }

  publicSurfaceTouched.sort()
  unaccountedPublicFiles.sort((a, b) => a.file.localeCompare(b.file))

  const nextSteps = [
    `Write user-facing release notes in ${notesMode.targetFile} focusing strictly on observable changes, upgrade actions, and resolved user issues.`,
    'Feel free to adapt sections or use CHANGELOG.md; omit empty sections rather than keeping blank headings.',
    'Do NOT create git tags, edit published releases, or rewrite pushed history unless a human maintainer explicitly orders a release.',
  ]
  if (unaccountedPublicFiles.length > 0) {
    nextSteps.unshift(`Inspect ${unaccountedPublicFiles.length} unaccounted public file(s) listed above to confirm whether any user-visible change was missed.`)
  }
  if (shallowCloneWarning) nextSteps.unshift(shallowCloneWarning)

  const payload = {
    mode: 'release-prep',
    repoRoot: posixPath(repoRoot),
    range: {
      from: range.from, fromSha: range.fromSha, fromMode: range.fromMode,
      to: range.to, toSha: range.toSha, rangeSpec: range.rangeSpec,
      isInitialRelease: range.isInitialRelease, isShallow: range.isShallow,
    },
    ...(shallowCloneWarning ? { shallowCloneWarning } : {}),
    version: {
      requested: requestedVersion, normalized: normalizedVersion, tagPrefix, targetTag,
      currentVersion, versionSources: sources, workspacePackages, mismatchWarning,
    },
    notesMode,
    stats: {
      totalCommits: commits.length, filteredInternalCount: filteredCommits.length,
      userFacingCount: userFacingCandidates.length, ambiguousCommitsCount: ambiguousCommits.length,
      netChangedFilesCount: netChangedFiles.length, publicSurfaceCount: publicSurfaceTouched.length,
      unaccountedPublicCount: unaccountedPublicFiles.length, breakingSignalsCount: breakingSignals.length,
    },
    breakingSignals, userFacingCandidates, ambiguousCommits, implementedSpecs,
    archivedOutcomes, publicSurfaceTouched, unaccountedPublicFiles, filteredCommits, nextSteps,
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    process.stdout.write(`${buildTextBrief(payload)}\n`)
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }
  return 0
}
