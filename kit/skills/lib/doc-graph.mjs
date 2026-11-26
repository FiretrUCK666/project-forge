/**
 * doc-graph.mjs —— 全仓活跃文档五分法核账与纯结构文档图谱校验叶子内核。
 *
 * 严格零第三方依赖且严守叶子隔离边界：仅导入 `node:fs`、`node:path`、
 * `./git.mjs`、`./markdown-scan.mjs` 与 `./doc-frontmatter.mjs`（绝不导入 `profile.mjs`）。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { COMMON_SKIP_DIRS, isInsideDir, isMacOsJunkPath, posixPath, readTextSafe } from './git.mjs'
import { extractHeadingSlugs, findFrontmatterEndLine, scanLines, slugifyHeading } from './markdown-scan.mjs'

export const TRANSIENT_OR_EXCLUDED_DOC_RE = /^(?:docs\/(?:prd|specs|todo|archive|release-notes)\/|templates\/|\.worktrees\/|\.agents\/|\.git\/|node_modules\/)/i
const ENTRY_DOC_RE = /^(?:(?:.+\/)?AGENTS\.md|README(?:\.[a-z0-9_-]+)?\.mdx?)$/i
const NON_GOVERNED_STANDARD_RE = /^(?:CONTRIBUTING(?:\.[a-z0-9_-]+)?|RELEASING(?:\.[a-z0-9_-]+)?|LICENSE(?:\.[a-z0-9_-]+)?|CODE_OF_CONDUCT|SECURITY_ADVISORY)\.mdx?$/i
const CHANGELOG_DOC_RE = /(?:^|\/)CHANGELOG(?:\.[a-z0-9_-]+)?\.mdx?$/i
const TRANSLATED_DOCS_DIR_RE = /^docs\/(?:(?:zh|en|ja|ko|fr|de|es|pt|ru|it|nl|pl|tr|vi|th|ar|hi|uk|cs|sv|da|fi|he|el|ro|hu|bg|ca|ms|bn|fa)(?:[-_][A-Za-z0-9]{2,4})?|[a-z]{2}[-_][A-Za-z]{2,4})\//i
const TEMPLATE_OR_KIT_DOC_RE = /^(?:\.github\/(?:ISSUE_TEMPLATE\/|PULL_REQUEST_TEMPLATE\/|pull_request_template\.mdx?$|issue_template\.mdx?$)|kit\/skills\/(?:templates\/|[^/]+\/SKILL\.md$))/i
const TEST_DOC_DIR_RE = /(?:^|\/)(?:test|tests|__tests__|fixtures)\//i
const MD_EXT_RE = /\.(?:md|mdx)$/i
const SPEC_ARTIFACT_EXT_RE = /\.(?:md|mdx|ya?ml|json|proto|prisma|graphql|gql|sql|toml)$/i
const MAX_GRAPH_FILE_BYTES = 512 * 1024

function normRel(raw) {
  return posixPath(String(raw ?? '').trim()).replace(/^\.\//, '')
}

function decodeUriSafe(raw) {
  try { return decodeURIComponent(raw) } catch { return raw }
}

function simpleGlobToRegex(globPattern) {
  const clean = normRel(globPattern).replace(/\/+$/, '')
  const esc = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const reStr = esc.replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${reStr}$`, 'i')
}

function normalizeAuthorityStem(relPath) {
  const base = posix.basename(normRel(relPath)).replace(/\.[a-z0-9_-]+$/i, '').toLowerCase()
  return base.replace(/[-_]?tdd$/i, 'tdd')
}

function stripWrapQuotes(val) {
  const s = String(val ?? '').trim()
  if ((s.startsWith('`') && s.endsWith('`')) || (s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
    return s.slice(1, -1).trim()
  }
  return s
}

function parseLocalDecisionMap(agentsText) {
  const map = new Map()
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  let inSection = false
  for (const line of lines) {
    if (/^##\s+取舍(?:\s|$|[（(:：])/.test(line.trim())) { inSection = true; continue }
    if (inSection && /^#{1,2}\s+/.test(line)) break
    if (!inSection) continue
    const t = line.trim()
    if (!t || t.startsWith('<!--') || t.startsWith('>') || t.startsWith('```')) continue
    const m = /^\s*(?:[-*]\s*)?`?([a-z][a-z0-9._-]*)`?\s*[:：]\s*(.*)$/.exec(line)
    if (m) map.set(m[1], m[2].trim())
  }
  return map
}

function parseAgentsProfileDocLists(agentsText) {
  const evergreenDocs = []
  const nonGovernedDocs = []
  const coupledPaths = []
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  let activeKey = null
  let inCoupled = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^##\s+改哪看哪(?:\s|$|[（(:：])/.test(trimmed)) { inCoupled = true; continue }
    if (inCoupled && /^##\s+/.test(trimmed)) inCoupled = false
    if (inCoupled && trimmed.startsWith('|')) {
      for (const m of trimmed.matchAll(/`([^`\n]+\.[a-z0-9_-]+)`/gi)) {
        const p = normRel(m[1])
        if (p && !p.includes('*') && !p.includes('<') && !/\s/.test(p)) coupledPaths.push(p)
      }
    }
    if (/^(?:```|~~~)/.test(trimmed)) { activeKey = null; continue }
    if (activeKey) {
      if (/^[-*]\s+/.test(trimmed) && /^\s+[-*]/.test(line)) {
        const item = stripWrapQuotes(trimmed.replace(/^[-*]\s+/, '').replace(/\s+#.*$/, ''))
        if (item && !/^(?:none|\(none\)|null|n\/a|无|\(无\)|暂无|-|<[^>\n]+>)$/i.test(item)) {
          (activeKey === 'evergreen' ? evergreenDocs : nonGovernedDocs).push(item)
        }
        continue
      }
      if (trimmed !== '' && !trimmed.startsWith('#')) activeKey = null
      else continue
    }
    const kv = /^(?:[-*]\s+)?`?(evergreen-docs|non-governed-docs)`?\s*:\s*(.*)$/i.exec(trimmed)
    if (!kv) continue
    const key = kv[1].toLowerCase() === 'evergreen-docs' ? 'evergreen' : 'nonGoverned'
    const rawVal = kv[2].replace(/(?:^|\s)#.*$/, '').trim()
    if (!rawVal) activeKey = key
    else if (!/^(?:none|\(none\)|null|n\/a|无|\(无\)|暂无|-)$/i.test(stripWrapQuotes(rawVal))) {
      const inner = rawVal.startsWith('[') && rawVal.endsWith(']') ? rawVal.slice(1, -1) : rawVal
      for (const part of inner.split(/[,，]/)) {
        const item = stripWrapQuotes(part)
        if (item && !/^(?:none|null|<[^>\n]+>)$/i.test(item)) (key === 'evergreen' ? evergreenDocs : nonGovernedDocs).push(item)
      }
    }
  }
  return { evergreenDocs, nonGovernedDocs, coupledPaths }
}

function walkRepoActiveFiles(repoRoot, transientRe) {
  const out = []
  const skip = new Set([...COMMON_SKIP_DIRS, '.git', '.worktrees', '.agents', 'templates', 'node_modules'])
  const walk = (absDir, relPrefix, depth) => {
    if (depth > 6) return
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const e of entries) {
      if (isMacOsJunkPath(e.name) || skip.has(e.name)) continue
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (transientRe.test(`${rel}/`)) continue
        walk(join(absDir, e.name), rel, depth + 1)
      } else if (e.isFile()) {
        out.push(normRel(rel))
      }
    }
  }
  walk(repoRoot, '', 0)
  return out
}

function detectVitePressRoots(repoRoot) {
  const roots = new Set()
  for (const cfgRel of [
    '.vitepress/config.mjs', '.vitepress/config.js', '.vitepress/config.ts', '.vitepress/config.mts',
    'docs/.vitepress/config.mjs', 'docs/.vitepress/config.js', 'docs/.vitepress/config.ts', 'docs/.vitepress/config.mts',
  ]) {
    const abs = join(repoRoot, cfgRel)
    if (!existsSync(abs)) continue
    const baseRoot = cfgRel.startsWith('docs/') ? 'docs' : ''
    const txt = readTextSafe(abs) ?? ''
    const srcM = /\bsrcDir\s*:\s*['"]([^'"]+)['"]/.exec(txt)
    if (srcM) {
      const clean = normRel(srcM[1]).replace(/^\/+|\/+$/g, '')
      if (clean && clean !== '.') roots.add(baseRoot ? `${baseRoot}/${clean}` : clean)
    }
    roots.add(baseRoot || 'docs')
  }
  if (existsSync(join(repoRoot, 'docs'))) roots.add('docs')
  return [...roots]
}

function createCandidateResolver(repoRoot, fileSet = new Set()) {
  const existsCache = new Map()
  const dirFilesCache = new Map()

  const checkRel = (rawRel) => {
    const clean = normRel(rawRel)
    if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) return null
    if (fileSet.has(clean)) return clean
    if (existsCache.has(clean)) return existsCache.get(clean) ? clean : null
    const slashIdx = clean.lastIndexOf('/')
    const dir = slashIdx >= 0 ? clean.slice(0, slashIdx) : '.'
    const base = slashIdx >= 0 ? clean.slice(slashIdx + 1) : clean
    if (!dirFilesCache.has(dir)) {
      const absDir = dir === '.' ? repoRoot : join(repoRoot, dir)
      let files = null
      if (isInsideDir(absDir, repoRoot)) {
        try {
          const entries = readdirSync(absDir, { withFileTypes: true })
          files = new Set()
          for (const e of entries) {
            if (e.isFile()) files.add(e.name)
            else if (e.isSymbolicLink()) {
              try { if (statSync(join(absDir, e.name)).isFile()) files.add(e.name) } catch { /* ignore broken symlink */ }
            }
          }
        } catch { files = null }
      }
      dirFilesCache.set(dir, files)
    }
    const set = dirFilesCache.get(dir)
    const found = Boolean(set && set.has(base))
    existsCache.set(clean, found)
    return found ? clean : null
  }

  return { checkRel }
}

function resolveFileCandidate(repoRoot, fromRel, rawTarget, vitePressRoots = [], resolver = null) {
  const decoded = decodeUriSafe(String(rawTarget ?? '').trim())
  if (!decoded) return { exists: false, resolvedRel: '' }
  const checkRel = resolver?.checkRel ?? ((relCand) => {
    const clean = normRel(relCand)
    if (!clean || clean === '.' || clean === '..' || clean.startsWith('../')) return null
    const absCand = resolve(repoRoot, clean)
    if (!isInsideDir(absCand, repoRoot)) return null
    try {
      if (existsSync(absCand) && statSync(absCand).isFile()) {
        return normRel(posix.relative(posixPath(repoRoot), posixPath(absCand)))
      }
    } catch { return null }
    return null
  })
  if (decoded.startsWith('/')) {
    const route = decoded.replace(/^\/+/, '').replace(/\/+$/, '')
    const cands = [route, `${route}.md`, `${route}/index.md`]
    if (/\.html$/i.test(route)) {
      const stem = route.replace(/\.html$/i, '')
      cands.push(`${stem}.md`, `${stem}/index.md`)
    }
    for (const vpRoot of ['', ...vitePressRoots]) {
      const pre = vpRoot ? `${vpRoot}/` : ''
      for (const c of cands) {
        if (!c) continue
        const hit = checkRel(`${pre}${c}`)
        if (hit) return { exists: true, resolvedRel: hit }
      }
    }
    return { exists: false, resolvedRel: route }
  }
  const fromDir = posix.dirname(normRel(fromRel))
  const joinFromDir = (relTarget) => normRel(posix.normalize(fromDir === '.' ? normRel(relTarget) : posix.join(fromDir, normRel(relTarget))))
  const directCand = joinFromDir(decoded)
  const direct = checkRel(directCand)
  if (direct) return { exists: true, resolvedRel: direct }
  if (/\.html$/i.test(decoded)) {
    const mdAlt = checkRel(joinFromDir(decoded.replace(/\.html$/i, '.md')))
    if (mdAlt) return { exists: true, resolvedRel: mdAlt }
  }
  if (fromRel === '.github' || fromRel.startsWith('.github/')) {
    const fb = checkRel(decoded)
    if (fb) return { exists: true, resolvedRel: fb }
  }
  return { exists: false, resolvedRel: directCand.startsWith('..') ? decoded : directCand }
}

/** 校验 `docAnchors` 条目（`path` 与可选 `#heading`），返回文件与锚点命中详情。 */
export function resolveDocAnchor(repoRoot, rawAnchor, slugCache = new Map()) {
  const raw = String(rawAnchor ?? '').trim()
  const hashIdx = raw.indexOf('#')
  const targetRel = normRel(hashIdx >= 0 ? raw.slice(0, hashIdx) : raw)
  const fragment = hashIdx >= 0 ? decodeUriSafe(raw.slice(hashIdx + 1)).trim() : ''
  if (!targetRel || targetRel.endsWith('/')) {
    return { exists: Boolean(targetRel), headingFound: true, targetRel, fragment }
  }
  const abs = resolve(repoRoot, targetRel)
  if (!isInsideDir(abs, repoRoot) || !existsSync(abs)) {
    return { exists: false, headingFound: false, targetRel, fragment }
  }
  if (!fragment || !MD_EXT_RE.test(targetRel)) {
    return { exists: true, headingFound: true, targetRel, fragment }
  }
  let slugs = slugCache.get(targetRel)
  if (!slugs) {
    const text = readTextSafe(abs, MAX_GRAPH_FILE_BYTES) ?? ''
    slugs = extractHeadingSlugs(text)
    slugCache.set(targetRel, slugs)
  }
  const fragLow = fragment.toLowerCase()
  const headingFound = slugs.has(fragLow)
    || slugs.has(slugifyHeading(fragment))
    || slugs.has(fragLow.replace(/-{2,}/g, '-'))
  return { exists: true, headingFound, targetRel, fragment }
}

function classifyFrontmatterMeta(text) {
  const fm = parseDocFrontmatter(text)
  const data = fm?.hasFrontmatter ? (fm.data ?? {}) : {}
  const lifecycle = typeof data.lifecycle === 'string' ? data.lifecycle.trim().toLowerCase() : ''
  const isOptOut = data.evergreen === false
    || data.governed === false
    || data.authority === false
    || lifecycle === 'transient'
    || lifecycle === 'non-governed'
    || /<!--\s*project-forge:\s*non-governed\s*-->/i.test(String(text ?? ''))
  const isOptIn = !isOptOut && (
    data.evergreen === true
    || lifecycle === 'evergreen'
    || data.authority === true
  )
  const pointers = []
  for (const k of ['canonical', 'redirect', 'redirect_to', 'moved_to', 'superseded_by', 'authority_doc']) {
    const v = typeof data[k] === 'string' ? normRel(data[k]) : ''
    if (v && !/^(?:null|none|无)$/i.test(v)) pointers.push(v)
  }
  return { isOptOut, isOptIn, pointers }
}

function extractMarkdownLinksAndRefs(repoRoot, fromRel, text, vitePressRoots, resolver = null) {
  const lines = scanLines(text)
  const fmEnd = findFrontmatterEndLine(lines)
  const mdLinks = []
  const backtickRefs = []
  let meaningfulLines = 0
  for (let i = fmEnd + 1; i < lines.length; i += 1) {
    const info = lines[i]
    if (info.inFence) continue
    const t = info.line.trim()
    if (t && info.heading === null && !t.startsWith('<!--')) meaningfulLines += 1
    const stripped = info.line.replace(/`+[^`\n]*`+/g, '')
    const cands = []
    for (const m of stripped.matchAll(/(?<!!)\[[^\]]*\]\(([^)\n]+)\)/g)) cands.push(m[1])
    const refM = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(stripped)
    if (refM) cands.push(refM[1])
    for (const raw of cands) {
      const noTitle = raw.trim().replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim()
      if (!noTitle || /^(?:https?:|mailto:|tel:|data:|javascript:|file:)/i.test(noTitle) || /[<>\{\}*?]/.test(noTitle)) continue
      const hashIdx = noTitle.indexOf('#')
      const pathPart = (hashIdx >= 0 ? noTitle.slice(0, hashIdx) : noTitle).split('?')[0].trim()
      const frag = hashIdx >= 0 ? decodeUriSafe(noTitle.slice(hashIdx + 1)).trim() : ''
      if (!pathPart) {
        if (frag) mdLinks.push({ from: fromRel, to: fromRel, exists: true, fragment: frag, line: i + 1, raw: noTitle })
        continue
      }
      const res = resolveFileCandidate(repoRoot, fromRel, pathPart, vitePressRoots, resolver)
      mdLinks.push({ from: fromRel, to: res.resolvedRel, exists: res.exists, fragment: frag, line: i + 1, raw: noTitle })
    }
    for (const m of info.line.matchAll(/`([^`\n\s]+\.[a-z0-9_-]+)`/gi)) {
      const tok = m[1].trim()
      if (/^(?:https?:|mailto:|\/|<)/.test(tok) || /[<>*?{}]/.test(tok)) continue
      const res = resolveFileCandidate(repoRoot, fromRel, tok, vitePressRoots, resolver)
      if (res.exists) backtickRefs.push({ from: fromRel, to: res.resolvedRel, line: i + 1, raw: tok })
    }
  }
  return { mdLinks, backtickRefs, isThinStub: meaningfulLines > 0 && meaningfulLines <= 6 }
}

function findSccs(nodes, adj) {
  let index = 0
  const indices = new Map()
  const lowlink = new Map()
  const stack = []
  const onStack = new Set()
  const sccs = []
  const visit = (v) => {
    indices.set(v, index); lowlink.set(v, index); index += 1
    stack.push(v); onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) { visit(w); lowlink.set(v, Math.min(lowlink.get(v), lowlink.get(w))) }
      else if (onStack.has(w)) lowlink.set(v, Math.min(lowlink.get(v), indices.get(w)))
    }
    if (lowlink.get(v) === indices.get(v)) {
      const comp = []
      while (true) {
        const w = stack.pop(); onStack.delete(w); comp.push(w)
        if (w === v) break
      }
      if (comp.length >= 2) sccs.push(comp.sort())
    }
  }
  for (const n of [...nodes].sort()) if (!indices.has(n)) visit(n)
  return sccs
}

/**
 * 执行全仓活跃文档五分法分区（entry / registeredAuthority / transientOrArchived / explicitNonGoverned / unaccounted）。
 */
export function accountActiveDocs(repoRoot, options = {}) {
  const root = String(repoRoot ?? '')
  const transientRe = options.transientDocRe ?? TRANSIENT_OR_EXCLUDED_DOC_RE
  if (!root || !existsSync(root)) {
    return {
      entry: [], registeredAuthority: [], transientOrArchived: [], explicitNonGoverned: [], unaccounted: [],
      fileSet: new Set(), textCache: new Map(), agentsText: '', decisionMap: new Map(),
      nonGovernedPatterns: [], transientRe,
    }
  }
  const agentsText = options.agentsText ?? (readTextSafe(join(root, 'AGENTS.md')) ?? '')
  const decisionMap = options.decisionMap ?? parseLocalDecisionMap(agentsText)
  const localLists = parseAgentsProfileDocLists(agentsText)
  const rawFiles = (Array.isArray(options.files) && options.files.length > 0)
    ? options.files.map((f) => normRel(f?.rel ?? f)).filter(Boolean)
    : walkRepoActiveFiles(root, transientRe)
  const fileSet = new Set(rawFiles)
  const textCache = new Map()
  const readCached = (rel) => {
    if (textCache.has(rel)) return textCache.get(rel)
    const abs = join(root, rel)
    const txt = (isInsideDir(abs, root) && existsSync(abs)) ? (readTextSafe(abs, MAX_GRAPH_FILE_BYTES) ?? '') : ''
    textCache.set(rel, txt)
    return txt
  }
  const isTransient = (rel) => transientRe.test(rel)
    || CHANGELOG_DOC_RE.test(rel)
    || TRANSLATED_DOCS_DIR_RE.test(rel)
    || TEMPLATE_OR_KIT_DOC_RE.test(rel)
    || TEST_DOC_DIR_RE.test(rel)

  const nonGovPatterns = [
    ...localLists.nonGovernedDocs,
    ...(decisionMap.has('non-governed-docs') ? decisionMap.get('non-governed-docs').split(/[,，\s]+/).filter(Boolean) : []),
  ].map((p) => normRel(p)).filter(Boolean)
  const nonGovRegexes = nonGovPatterns.filter((p) => /[*?]/.test(p)).map(simpleGlobToRegex)
  const nonGovExact = new Set(nonGovPatterns.filter((p) => !/[*?]/.test(p)))

  const entry = []
  const entrySet = new Set()
  const transientSet = new Set()
  const explicitNonGovSet = new Set()
  const fmMetaByRel = new Map()

  for (const rel of [...fileSet].sort()) {
    if (isTransient(rel)) { transientSet.add(rel); continue }
    if (ENTRY_DOC_RE.test(rel)) { entrySet.add(rel); entry.push({ path: rel, kind: 'entry', isMarkdown: true }); continue }
    if (MD_EXT_RE.test(rel)) {
      const meta = classifyFrontmatterMeta(readCached(rel))
      fmMetaByRel.set(rel, meta)
      if (meta.isOptOut || nonGovExact.has(rel) || nonGovRegexes.some((re) => re.test(rel))) {
        explicitNonGovSet.add(rel)
        continue
      }
    } else if (nonGovExact.has(rel) || nonGovRegexes.some((re) => re.test(rel))) {
      explicitNonGovSet.add(rel)
      continue
    }
    if (NON_GOVERNED_STANDARD_RE.test(rel)) explicitNonGovSet.add(rel)
  }

  const registeredMap = new Map()
  const registerAuth = (rawRel, source) => {
    const clean = normRel(rawRel)
    if (!clean || clean.includes('..') || entrySet.has(clean) || isTransient(clean)) return
    if (!fileSet.has(clean)) {
      const abs = resolve(root, clean)
      if (!isInsideDir(abs, root)) return
      try { if (!existsSync(abs) || !statSync(abs).isFile()) return } catch { return }
      fileSet.add(clean)
    }
    if (explicitNonGovSet.has(clean)) {
      if (source !== 'profile') return
      explicitNonGovSet.delete(clean)
    }
    if (registeredMap.has(clean)) return
    const isMd = MD_EXT_RE.test(clean)
    const stem = normalizeAuthorityStem(clean)
    const kind = clean === 'docs/feature-map.json' ? 'feature-map' : (isMd ? 'evergreen-doc' : 'authority-artifact')
    registeredMap.set(clean, { path: clean, kind, source, family: stem, stem, isMarkdown: isMd })
  }

  // Layer 1: explicit profile declarations
  const evergreenPatterns = [...new Set([...(options.profile?.evergreenDocs ?? []), ...localLists.evergreenDocs])]
  for (const pat of evergreenPatterns) {
    const cleanPat = normRel(pat)
    if (!cleanPat) continue
    if (/[*?]/.test(cleanPat)) {
      const re = simpleGlobToRegex(cleanPat)
      for (const rel of fileSet) if (re.test(rel)) registerAuth(rel, 'profile')
    } else {
      registerAuth(cleanPat, 'profile')
    }
  }
  for (const rel of localLists.coupledPaths) registerAuth(rel, 'profile')
  if (options.authoritativeTddPath) {
    registerAuth(options.authoritativeTddPath, decisionMap.has('tdd-authority') ? 'profile' : 'convention')
  }
  if (decisionMap.has('tdd-authority')) {
    const rawTdd = decisionMap.get('tdd-authority') ?? ''
    const tm = /`([^`\n]+\.[a-z0-9_-]+)`/i.exec(rawTdd) ?? /(?:^|\s)([A-Za-z0-9_./-]+\.[a-z0-9_-]+)/i.exec(rawTdd)
    if (tm) registerAuth(tm[1], 'profile')
  }

  // Layer 2: frontmatter self-declaration
  for (const [rel, meta] of fmMetaByRel.entries()) {
    if (meta.isOptIn) registerAuth(rel, 'frontmatter')
  }

  // Layer 3: entry links & transitive structural graph links
  const vitePressRoots = detectVitePressRoots(root)
  const resolver = createCandidateResolver(root, fileSet)
  const parsedCache = new Map()
  const parseEdgesFor = (rel) => {
    if (parsedCache.has(rel)) return parsedCache.get(rel)
    const txt = readCached(rel)
    const res = extractMarkdownLinksAndRefs(root, rel, txt, vitePressRoots, resolver)
    parsedCache.set(rel, res)
    return res
  }

  const queue = [...entrySet]
  for (const r of registeredMap.keys()) if (MD_EXT_RE.test(r)) queue.push(r)
  const visitedBfs = new Set(queue)
  const reachableFromEntry = new Set()
  const entryQueue = [...entrySet]
  const visitedEntry = new Set(entrySet)

  const enqueueGraphTargets = (fromRel, isFromEntry) => {
    const parsed = parseEdgesFor(fromRel)
    const targets = [
      ...parsed.mdLinks.filter((l) => l.exists && l.to !== fromRel).map((l) => l.to),
      ...parsed.backtickRefs
        .filter((b) => MD_EXT_RE.test(b.to) || (isFromEntry && SPEC_ARTIFACT_EXT_RE.test(b.to)) || fromRel === 'AGENTS.md')
        .map((b) => b.to),
    ]
    return targets
  }

  while (entryQueue.length > 0) {
    const cur = entryQueue.shift()
    const fromEntry = entrySet.has(cur)
    for (const tgt of enqueueGraphTargets(cur, fromEntry)) {
      if (!isTransient(tgt) && !explicitNonGovSet.has(tgt)) {
        if (!entrySet.has(tgt)) {
          registerAuth(tgt, fromEntry ? 'entry-link' : 'graph-link')
          reachableFromEntry.add(tgt)
        }
        if (!visitedEntry.has(tgt) && MD_EXT_RE.test(tgt)) {
          visitedEntry.add(tgt)
          entryQueue.push(tgt)
        }
      }
    }
  }

  while (queue.length > 0) {
    const cur = queue.shift()
    if (!MD_EXT_RE.test(cur)) continue
    for (const tgt of enqueueGraphTargets(cur, entrySet.has(cur))) {
      if (!isTransient(tgt) && !explicitNonGovSet.has(tgt) && !entrySet.has(tgt)) {
        registerAuth(tgt, entrySet.has(cur) ? 'entry-link' : 'graph-link')
        if (!visitedBfs.has(tgt) && MD_EXT_RE.test(tgt)) {
          visitedBfs.add(tgt)
          queue.push(tgt)
        }
      }
    }
  }

  const registeredAuthority = [...registeredMap.values()].sort((a, b) => a.path.localeCompare(b.path))
  const transientOrArchived = [...transientSet].sort().map((path) => ({ path, kind: 'transient' }))
  const explicitNonGoverned = [...explicitNonGovSet].sort().map((path) => ({ path, kind: 'non-governed' }))
  const unaccounted = [...fileSet]
    .filter((rel) => MD_EXT_RE.test(rel) && !entrySet.has(rel) && !transientSet.has(rel) && !explicitNonGovSet.has(rel) && !registeredMap.has(rel))
    .sort()
    .map((path) => ({ path, kind: 'unaccounted-doc', stem: normalizeAuthorityStem(path) }))

  return {
    entry,
    registeredAuthority,
    transientOrArchived,
    explicitNonGoverned,
    unaccounted,
    fileSet,
    textCache,
    readCached,
    parsedCache,
    parseEdgesFor,
    fmMetaByRel,
    agentsText,
    decisionMap,
    entrySet,
    reachableFromEntry,
    vitePressRoots,
    resolver,
  }
}

/**
 * 基于活跃文档五分法构建文档图谱并执行 4 项纯结构图谱校验：
 * brokenLinks/brokenAnchors（含独立 anchorWarnings）、cycles、redirectChains、entryDivergenceAndOrphans。
 */
export function buildDocGraph(repoRoot, options = {}) {
  const root = String(repoRoot ?? '')
  const acc = accountActiveDocs(root, options)
  const fmRel = 'docs/feature-map.json'
  const featureMap = (root && existsSync(join(root, fmRel)))
    ? { path: fmRel, kind: 'feature-map', source: 'convention', family: 'feature-map', stem: 'feature-map', isMarkdown: false }
    : null
  if (!root || !existsSync(root)) {
    return {
      accounted: { entry: [], registeredAuthority: [], transientOrArchived: [], explicitNonGoverned: [], unaccounted: [] },
      docs: [], markdownDocs: [], nonMarkdownDocs: [], featureMap: null, unaccountedDocs: [],
      duplicateGroups: [], brokenLinks: [], brokenAnchors: [], anchorWarnings: [],
      cycles: [], redirectChains: [], entryDivergence: [], orphans: [], edges: [],
    }
  }

  const slugCache = new Map()
  const getSlugs = (rel) => {
    if (slugCache.has(rel)) return slugCache.get(rel)
    const slugs = extractHeadingSlugs(acc.readCached(rel))
    slugCache.set(rel, slugs)
    return slugs
  }

  const activeMdNodes = [
    ...acc.entry.map((d) => d.path),
    ...acc.registeredAuthority.filter((d) => d.isMarkdown).map((d) => d.path),
    ...acc.unaccounted.map((d) => d.path),
  ]
  const brokenLinks = []
  const brokenAnchors = []
  const allEdges = []
  const pointerAdj = new Map()
  const pointerEdgesRaw = []
  const docOutgoingMap = new Map()
  const nonEntryMdSet = new Set([
    ...acc.registeredAuthority.filter((d) => d.isMarkdown).map((d) => d.path),
    ...acc.unaccounted.map((d) => d.path),
  ])

  const addPointerEdge = (from, to) => {
    if (!from || !to || from === to || acc.entrySet.has(from) || acc.entrySet.has(to)) return
    if (!nonEntryMdSet.has(from) || !nonEntryMdSet.has(to)) return
    if (!pointerAdj.has(from)) pointerAdj.set(from, new Set())
    pointerAdj.get(from).add(to)
    pointerEdgesRaw.push([from, to])
  }

  for (const rel of activeMdNodes) {
    const parsed = acc.parseEdgesFor(rel)
    const outSet = new Set()
    const relStem = normalizeAuthorityStem(rel)
    const fmMeta = acc.fmMetaByRel.get(rel) ?? classifyFrontmatterMeta(acc.readCached(rel))
    for (const ptr of fmMeta.pointers) {
      const res = resolveFileCandidate(root, rel, ptr, acc.vitePressRoots, acc.resolver)
      if (res.exists) {
        outSet.add(res.resolvedRel)
        addPointerEdge(rel, res.resolvedRel)
      }
    }
    for (const lk of parsed.mdLinks) {
      allEdges.push({ from: lk.from, to: lk.to, fragment: lk.fragment, line: lk.line, kind: 'markdown-link' })
      if (!lk.exists) {
        brokenLinks.push({ file: lk.from, line: lk.line, target: lk.raw, resolvedTarget: lk.to })
        continue
      }
      outSet.add(lk.to)
      if (parsed.isThinStub || normalizeAuthorityStem(lk.to) === relStem) addPointerEdge(lk.from, lk.to)
      if (lk.fragment && MD_EXT_RE.test(lk.to)) {
        const slugs = getSlugs(lk.to)
        const fragLow = lk.fragment.toLowerCase()
        if (!slugs.has(fragLow) && !slugs.has(slugifyHeading(lk.fragment)) && !slugs.has(fragLow.replace(/-{2,}/g, '-'))) {
          brokenAnchors.push({ file: lk.from, line: lk.line, target: lk.raw, resolvedTarget: lk.to, fragment: lk.fragment })
        }
      }
    }
    for (const br of parsed.backtickRefs) {
      allEdges.push({ from: br.from, to: br.to, fragment: '', line: br.line, kind: 'backtick-ref' })
      outSet.add(br.to)
      if (parsed.isThinStub || normalizeAuthorityStem(br.to) === relStem) addPointerEdge(br.from, br.to)
    }
    docOutgoingMap.set(rel, outSet)
  }

  // Anchor warnings from docs/feature-map.json docAnchors (separate from brokenLinks/zombies)
  const anchorWarnings = []
  if (featureMap) {
    try {
      const fmRaw = JSON.parse(acc.readCached(fmRel) || '{}')
      const collections = [
        ...(Array.isArray(fmRaw.features) ? fmRaw.features.map((f) => ({ id: f?.id ?? 'feature', docAnchors: f?.docAnchors })) : []),
        ...(Array.isArray(fmRaw.domains) ? fmRaw.domains.map((d) => ({ id: `domain:${d?.id ?? ''}`, docAnchors: d?.docAnchors })) : []),
        ...(Array.isArray(fmRaw.flows) ? fmRaw.flows.map((fl) => ({ id: `flow:${fl?.id ?? ''}`, docAnchors: fl?.docAnchors })) : []),
      ]
      for (const item of collections) {
        for (const anchor of Array.isArray(item.docAnchors) ? item.docAnchors : []) {
          const res = resolveDocAnchor(root, anchor, slugCache)
          if (res.exists && res.fragment && !res.headingFound) {
            anchorWarnings.push({ kind: 'missing-doc-anchor-heading', featureId: item.id, path: anchor, targetRel: res.targetRel, fragment: res.fragment })
          }
        }
      }
    } catch { /* Fail-Soft on corrupt feature-map */ }
  }

  // 2. Cycles (Tarjan SCC on authority pointer graph, ignoring entry bilingual pairs)
  const sccs = findSccs(nonEntryMdSet, pointerAdj)
  const cycleNodeSet = new Set(sccs.flat())
  const cycles = sccs.map((nodes) => ({ kind: 'authority-pointer-cycle', nodes }))

  // 3. Redirect chains (hop > 1)
  const redirectChains = []
  for (const start of [...pointerAdj.keys()].sort()) {
    if (cycleNodeSet.has(start)) continue
    const path = [start]
    let cur = start
    const seen = new Set([start])
    while (pointerAdj.has(cur)) {
      const nexts = [...pointerAdj.get(cur)].filter((n) => !seen.has(n) && !cycleNodeSet.has(n)).sort()
      if (nexts.length !== 1) break
      const nxt = nexts[0]
      path.push(nxt); seen.add(nxt); cur = nxt
      if (path.length > 12) break
    }
    if (path.length >= 3) {
      redirectChains.push({ from: path[0], to: path[path.length - 1], hops: path.length - 1, chain: path })
    }
  }

  // 4. Entry divergence, orphans & duplicateGroups (acyclic pointer edge check)
  const orphans = acc.entry.length > 0
    ? acc.registeredAuthority
        .filter((d) => d.kind !== 'feature-map' && d.source !== 'profile' && !acc.reachableFromEntry.has(d.path))
        .map((d) => ({ path: d.path, source: d.source }))
    : []

  const byStem = new Map()
  for (const d of [...acc.registeredAuthority.filter((x) => x.isMarkdown), ...acc.unaccounted]) {
    if (TRANSLATED_DOCS_DIR_RE.test(d.path)) continue
    if (!byStem.has(d.stem)) byStem.set(d.stem, [])
    byStem.get(d.stem).push(d.path)
  }
  const duplicateGroups = []
  const allowAllDup = acc.decisionMap.has('allow-duplicate-docs')
  for (const [stem, paths] of byStem.entries()) {
    const uniqPaths = [...new Set(paths)].sort()
    if (uniqPaths.length < 2 || allowAllDup || acc.decisionMap.has(`keep-duplicate-${stem}`)) continue
    const hasAcyclicPointer = uniqPaths.some((p) => {
      const outs = docOutgoingMap.get(p)
      if (!outs) return false
      return uniqPaths.some((other) => other !== p && outs.has(other) && !(cycleNodeSet.has(p) && cycleNodeSet.has(other)))
    })
    if (!hasAcyclicPointer) duplicateGroups.push({ stem, family: stem, paths: uniqPaths })
  }

  const entryDivergence = []
  const readmeEntries = acc.entry.filter((e) => /^README(?:\.[a-z0-9_-]+)?\.mdx?$/i.test(e.path))
  if (readmeEntries.length >= 2) {
    const targetsByStem = new Map()
    for (const ent of readmeEntries) {
      for (const tgt of docOutgoingMap.get(ent.path) ?? []) {
        if (acc.entrySet.has(tgt)) continue
        const stem = normalizeAuthorityStem(tgt)
        if (!targetsByStem.has(stem)) targetsByStem.set(stem, new Map())
        targetsByStem.get(stem).set(ent.path, tgt)
      }
    }
    for (const [stem, perEntry] of targetsByStem.entries()) {
      const uniqueTargets = [...new Set(perEntry.values())].sort()
      if (uniqueTargets.length >= 2) {
        entryDivergence.push({ stem, entries: [...perEntry.keys()].sort(), targets: uniqueTargets })
      }
    }
  }

  const markdownDocs = acc.registeredAuthority.filter((d) => d.isMarkdown)
  const nonMarkdownDocs = acc.registeredAuthority.filter((d) => !d.isMarkdown)
  const docs = featureMap && !acc.registeredAuthority.some((d) => d.path === fmRel)
    ? [...acc.registeredAuthority, featureMap]
    : [...acc.registeredAuthority]

  return {
    accounted: {
      entry: acc.entry,
      registeredAuthority: acc.registeredAuthority,
      transientOrArchived: acc.transientOrArchived,
      explicitNonGoverned: acc.explicitNonGoverned,
      unaccounted: acc.unaccounted,
    },
    docs,
    markdownDocs,
    nonMarkdownDocs,
    featureMap,
    unaccountedDocs: acc.unaccounted,
    duplicateGroups,
    brokenLinks,
    brokenAnchors,
    anchorWarnings,
    cycles,
    redirectChains,
    entryDivergence,
    orphans,
    edges: allEdges,
  }
}
