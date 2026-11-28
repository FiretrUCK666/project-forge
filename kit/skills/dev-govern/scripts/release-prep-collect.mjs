/**
 * release-prep-collect.mjs -- Single-pass Git range, manifest/workspace version sources,
 * commit/diff collector, breaking signals, and implemented spec/todo outcome extractor.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync } from 'node:fs'
import { join, posix } from 'node:path'

import { gitRun, gitRunBuffer, posixPath, readTextSafe } from '../../lib/git.mjs'
import { hasAnyTagFast, readGitBlobTextFast, readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { discoverWorkspacePackages } from '../../lib/profile.mjs'
import { splitDiffByFile } from '../../lib/static-gates.mjs'

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
export const BREAKING_SUBJECT_RE = /^[a-z]+(?:\([^)]*\))?!:\s*/i

export async function readFileAtRev(repoRoot, rev, relPosix, gitDir = null, blobMap = null) {
  const blobSha = blobMap?.get(relPosix)
  if (blobSha && gitDir) {
    const fast = readGitBlobTextFast(gitDir, blobSha)
    if (fast !== null) return fast
  }
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

export async function resolveBaseAndRange(repoRoot, gitDir, opts) {
  const targetRev = String(opts.to || 'HEAD').trim() || 'HEAD'
  const effectiveGitDir = gitDir ?? resolveGitDirFast(repoRoot)
  const fastToSha = targetRev === 'HEAD' ? readHeadFast(resolveGitDirFast(repoRoot), effectiveGitDir)?.oid : null
  const canFastShallow = Boolean(effectiveGitDir && !existsSync(join(effectiveGitDir, 'reftable')))
  const [toCheck, shallowCmd] = await Promise.all([
    fastToSha ? Promise.resolve({ ok: true, stdout: fastToSha }) : gitRun(repoRoot, ['rev-parse', '--verify', `${targetRev}^{commit}`]),
    canFastShallow
      ? Promise.resolve({ ok: true, stdout: existsSync(join(effectiveGitDir, 'shallow')) ? 'true' : 'false' })
      : gitRun(repoRoot, ['rev-parse', '--is-shallow-repository']),
  ])
  if (!toCheck.ok || !toCheck.stdout.trim()) {
    return { error: `Invalid --to revision: "${targetRev}"`, code: 2 }
  }
  const toSha = toCheck.stdout.trim()
  const isShallow = (shallowCmd.ok && shallowCmd.stdout.trim() === 'true')
    || existsSync(join(effectiveGitDir ?? join(repoRoot, '.git'), 'shallow'))

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
  let fromTagSha = null
  if (hasAnyTagFast(effectiveGitDir) !== false) {
    const tagsAtTo = await gitRun(repoRoot, ['tag', '--points-at', toSha])
    const excludeArgs = []
    if (tagsAtTo.ok && tagsAtTo.stdout) {
      for (const t of tagsAtTo.stdout.split('\n').map((s) => s.trim()).filter(Boolean)) excludeArgs.push('--exclude', t)
    }
    const desc = await gitRun(repoRoot, ['describe', '--tags', '--abbrev=0', ...excludeArgs, toSha])
    if (desc.ok && desc.stdout.trim()) {
      const tag = desc.stdout.trim()
      const fastTagSha = resolveRefShaFast(effectiveGitDir, `refs/tags/${tag}`)
      const tagShaRes = fastTagSha ? { ok: true, stdout: fastTagSha } : await gitRun(repoRoot, ['rev-parse', '--verify', `${tag}^{commit}`])
      const candSha = tagShaRes.ok ? tagShaRes.stdout.trim() : ''
      if (candSha && candSha !== toSha) { fromTag = tag; fromTagSha = candSha }
    }
  }

  if (fromTag) {
    return {
      from: fromTag, fromSha: fromTagSha, fromMode: 'auto-tag', to: targetRev, toSha,
      rangeSpec: `${fromTag}..${targetRev}`, diffBaseSha: fromTagSha, isInitialRelease: false, isShallow,
    }
  }

  return {
    from: null, fromSha: null, fromMode: 'root', to: targetRev, toSha,
    rangeSpec: targetRev, diffBaseSha: EMPTY_TREE_SHA, isInitialRelease: true, isShallow,
  }
}

export async function detectTagPrefix(repoRoot, fromTag, gitDir = null) {
  if (fromTag && /^v\d/i.test(fromTag)) return 'v'
  if (fromTag && /^\d/.test(fromTag)) return ''
  if (hasAnyTagFast(gitDir) === false) return 'v'
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

async function detectPackageManifestVersions(repoRoot, rev, dirRel, manifests, treeSet = null, gitDir = null, blobMap = null) {
  const out = []
  const publicPaths = new Set()
  const prefix = dirRel ? `${dirRel}/` : ''
  const pkgInfo = { pkg: null }
  const readIfPresent = (relPath) => {
    if (treeSet && !treeSet.has(relPath)) return Promise.resolve(undefined)
    return readFileAtRev(repoRoot, rev, relPath, gitDir, blobMap)
  }

  const csManifests = manifests.filter((m) => /\.csproj$/i.test(m))
  const gradleFiles = ['build.gradle', 'build.gradle.kts'].filter((gf) => manifests.includes(gf))
  const [skillTxt, pkgTxt, pyTxt, cargoTxt, manTxt, pomTxt, gradleTxts, csTxts] = await Promise.all([
    !dirRel ? readIfPresent('SKILL.md') : Promise.resolve(undefined),
    readIfPresent(`${prefix}package.json`),
    readIfPresent(`${prefix}pyproject.toml`),
    readIfPresent(`${prefix}Cargo.toml`),
    readIfPresent(`${prefix}manifest.json`),
    manifests.includes('pom.xml') ? readIfPresent(`${prefix}pom.xml`) : Promise.resolve(undefined),
    Promise.all(gradleFiles.map(async (gf) => [gf, await readIfPresent(`${prefix}${gf}`)])),
    Promise.all(csManifests.map(async (mf) => [mf, await readIfPresent(`${prefix}${mf}`)])),
  ])

  const skillVer = parseSkillMdVersion(skillTxt)
  if (skillVer) out.push({ file: 'SKILL.md', field: 'metadata.version', version: skillVer, package: 'root', dirRel: '' })

  const pkg = parseJsonStr(pkgTxt)
  if (pkg) {
    pkgInfo.pkg = pkg
    for (const p of collectPackagePublicPaths(pkg, dirRel)) publicPaths.add(p)
    if (pkg.version) out.push({ file: `${prefix}package.json`, field: 'version', version: String(pkg.version), package: pkg.name || dirRel || 'root', dirRel })
  }

  const pyVer = parseTomlSectionVersion(pyTxt, ['project', 'tool.poetry'])
  if (pyVer) out.push({ file: `${prefix}pyproject.toml`, field: 'version', version: pyVer, package: dirRel || 'root', dirRel })

  const cargoVer = parseTomlSectionVersion(cargoTxt, ['package'])
  if (cargoVer) out.push({ file: `${prefix}Cargo.toml`, field: 'package.version', version: cargoVer, package: dirRel || 'root', dirRel })

  const man = parseJsonStr(manTxt)
  if (man?.version) out.push({ file: `${prefix}manifest.json`, field: 'version', version: String(man.version), package: man.name || dirRel || 'root', dirRel })

  const pomVer = parsePomVersion(pomTxt)
  if (pomVer) out.push({ file: `${prefix}pom.xml`, field: 'version', version: pomVer, package: dirRel || 'root', dirRel })

  for (const [gf, gTxt] of gradleTxts) {
    const gv = parseGradleVersion(gTxt)
    if (gv) out.push({ file: `${prefix}${gf}`, field: 'version', version: gv, package: dirRel || 'root', dirRel })
  }
  for (const [mf, csTxt] of csTxts) {
    const cv = csTxt ? /<Version>\s*([^<\s]+)\s*<\/Version>/i.exec(csTxt)?.[1]?.trim() : null
    if (cv) out.push({ file: `${prefix}${mf}`, field: 'Version', version: cv, package: dirRel || mf, dirRel })
  }

  return { sources: out, pkg: pkgInfo.pkg, publicPaths }
}

export async function detectVersionSources(repoRoot, rev, gitDir = null) {
  const discovery = discoverWorkspacePackages(repoRoot)
  const lsRes = await gitRunBuffer(repoRoot, ['ls-tree', '-r', '-z', rev])
  const treeSet = lsRes.ok ? new Set() : null
  const blobMap = lsRes.ok ? new Map() : null
  if (lsRes.ok) {
    for (const rec of lsRes.stdout.toString('utf8').split('\0')) {
      const tab = rec.indexOf('\t')
      if (tab <= 0) continue
      const file = posixPath(rec.slice(tab + 1))
      const sha = rec.slice(0, tab).trim().split(/\s+/).at(-1)
      if (file) { treeSet.add(file); if (sha) blobMap.set(file, sha) }
    }
  }
  const rootManifests = discovery.packages.find((p) => p.dirRel === '')?.manifests ?? ['package.json', 'pyproject.toml', 'Cargo.toml', 'manifest.json']
  const [rootRes, subResults] = await Promise.all([
    detectPackageManifestVersions(repoRoot, rev, '', rootManifests, treeSet, gitDir, blobMap),
    Promise.all(
      discovery.packages
        .filter((pkg) => Boolean(pkg.dirRel))
        .map((pkg) => detectPackageManifestVersions(repoRoot, rev, pkg.dirRel, pkg.manifests, treeSet, gitDir, blobMap)),
    ),
  ])
  const rootSources = rootRes.sources
  const allPublicPaths = new Set(rootRes.publicPaths)
  const workspacePackages = []
  for (const subRes of subResults) {
    for (const p of subRes.publicPaths) allPublicPaths.add(p)
    for (const s of subRes.sources) workspacePackages.push(s)
  }

  return {
    rootSources,
    workspacePackages,
    sources: rootSources.length > 0 ? rootSources : workspacePackages,
    pkg: rootRes.pkg,
    pkgPublicPaths: allPublicPaths,
    blobMap,
  }
}

export function detectNotesMode(repoRoot, targetTag) {
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

/** Single-pass parallel collection of range commit log and net changed files. */
export async function collectCommitsAndFiles(repoRoot, range) {
  const logArg = range.fromSha ? `${range.fromSha}..${range.toSha}` : range.toSha
  const [logRes, diffRes] = await Promise.all([
    gitRun(repoRoot, ['log', '--root', logArg, '--name-status', '--format=__COMMIT__%H\t%ct\t%an\t%s\t%b__END_HDR__'], { maxBuffer: 32 * 1024 * 1024 }),
    gitRun(repoRoot, ['diff', '--name-status', range.diffBaseSha, range.toSha], { maxBuffer: 32 * 1024 * 1024 }),
  ])
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

export async function extractBreakingSignals(repoRoot, range, netChangedFiles, commits, cleanSubjectFn) {
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
        before: null, after: cleanSubjectFn(c.subject),
        detail: `${c.shortHash}: ${cleanSubjectFn(c.subject)}`,
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

export async function collectSpecsAndArchivedTodos(repoRoot, range, netChangedFiles, gitDir = null, blobMap = null) {
  const specsPrefix = posix.join('docs', 'specs') + '/'
  const archiveSpecsPrefix = posix.join('docs', 'archive', 'specs') + '/'
  const archiveTodoPrefix = posix.join('docs', 'archive', 'todo') + '/'
  const implementedSpecs = []
  const archivedOutcomes = []

  for (const item of netChangedFiles) {
    if (item.status === 'D') continue
    if ((item.file.startsWith(specsPrefix) || item.file.startsWith(archiveSpecsPrefix)) && item.file.endsWith('.md')) {
      const curText = await readFileAtRev(repoRoot, range.toSha, item.file, gitDir, blobMap)
      if (!curText || !/^\s*(?:[-*]\s*)?(?:status|implemented)\s*:\s*(?:implemented|true)\b/im.test(curText)) continue
      let alreadyImplemented = false
      if (range.fromSha && item.status !== 'A') {
        const oldText = await readFileAtRev(repoRoot, range.fromSha, item.file)
        if (oldText && /^\s*(?:[-*]\s*)?(?:status|implemented)\s*:\s*(?:implemented|true)\b/im.test(oldText)) alreadyImplemented = true
      }
      if (!alreadyImplemented) {
        const meta = extractDocTitleAndSummary(curText, posix.basename(item.file, '.md'))
        implementedSpecs.push({ file: item.file, title: meta.title, summary: meta.summary })
      }
    } else if (item.file.startsWith(archiveTodoPrefix) && item.file.endsWith('.md')) {
      const curText = await readFileAtRev(repoRoot, range.toSha, item.file, gitDir, blobMap)
      if (!curText) continue
      const meta = extractDocTitleAndSummary(curText, posix.basename(item.file, '.md'))
      archivedOutcomes.push({ file: item.file, title: meta.title, summary: meta.summary })
    }
  }
  return { implementedSpecs, archivedOutcomes }
}
