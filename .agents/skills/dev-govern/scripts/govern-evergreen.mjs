/**
 * govern-evergreen.mjs —— 基于 `kit/skills/lib/profile.mjs` 单源 `discoverEvergreenDocs`
 * 对仓库全部常青权威文档统一执行失效源码路径、履历体与多副本分裂（`docs.duplicate-authority`）检测。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 kit/skills/lib/）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { DEFAULT_WALK_SKIP_DIRS, isInsideDir, isMacOsJunkPath, posixPath } from '../../lib/git.mjs'
import { findChangelogVoice } from '../../lib/no-changelog-voice.mjs'
import { discoverEvergreenDocs, readDecisions } from '../../lib/profile.mjs'
import { CODE_EXT_RE } from '../../lib/static-gates.mjs'
import { addFinding, readTextStrictInfo } from './govern-checks.mjs'

const REPO_PATH_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|rs|go|java|kt|cs|json|ya?ml|toml|lock|txt|cfg|ini|md)$/i

function detectEvergreenVitePressRoots(repoRoot) {
  const roots = new Set()
  for (const cfgRel of [
    '.vitepress/config.mjs', '.vitepress/config.js', '.vitepress/config.ts', '.vitepress/config.mts',
    'docs/.vitepress/config.mjs', 'docs/.vitepress/config.js', 'docs/.vitepress/config.ts', 'docs/.vitepress/config.mts',
  ]) {
    const abs = join(repoRoot, cfgRel)
    if (!existsSync(abs)) continue
    const baseRoot = cfgRel.startsWith('docs/') ? 'docs' : ''
    const txt = readTextStrictInfo(abs)?.text ?? ''
    const srcM = /\bsrcDir\s*:\s*['"]([^'"]+)['"]/.exec(txt)
    if (srcM) {
      const clean = posixPath(srcM[1]).replace(/^\.\//, '').replace(/^\/+|\/+$/g, '')
      if (clean && clean !== '.') roots.add(baseRoot ? `${baseRoot}/${clean}` : clean)
    }
    roots.add(baseRoot || 'docs')
  }
  if (existsSync(join(repoRoot, 'docs'))) roots.add('docs')
  return [...roots]
}

function extractDocBacktickPaths(rawTok) {
  const tok = String(rawTok ?? '').trim()
  if (!tok || /^(?:https?:|mailto:|git@|ssh:|[A-Za-z]:|<)/.test(tok)) return []
  const words = /[\s;|&]/.test(tok) ? tok.split(/[\s,;()'"`]+/) : [tok]
  const out = []
  for (const word of words) {
    const clean = word.trim().replace(/^\.\//, '')
    if (!clean || !clean.includes('/') || clean.endsWith('/')) continue
    if (clean.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(clean)) continue
    if (/^(?:https?:|mailto:|git@|ssh:|[A-Za-z]:|<)/.test(clean)) continue
    if (clean.startsWith('/')) {
      // 仅对带扩展名的根路径/路由进一步在仓库或 VitePress srcDir 下校验；无扩展名的站内路由/URL路径跳过。
      if (!REPO_PATH_EXT_RE.test(clean)) continue
    }
    if (/[<>*?{}$]/.test(clean) || clean.includes('..')) continue
    if (!REPO_PATH_EXT_RE.test(clean)) continue
    out.push(clean)
  }
  return out
}

function evergreenCandidateExists(repoRoot, docRel, cand, vitePressRoots) {
  if (cand.startsWith('/')) {
    const route = cand.replace(/^\/+/, '')
    const alts = [route]
    if (/\.html$/i.test(route)) alts.push(route.replace(/\.html$/i, '.md'))
    for (const rootPrefix of ['', ...vitePressRoots]) {
      const pre = rootPrefix ? `${rootPrefix}/` : ''
      for (const a of alts) {
        if (existsSync(join(repoRoot, `${pre}${a}`))) return true
      }
    }
    return false
  }
  if (existsSync(join(repoRoot, cand))) return true
  const docAbs = join(repoRoot, docRel)
  let curDir = dirname(docAbs)
  while (isInsideDir(curDir, repoRoot)) {
    const candidateAbs = resolve(curDir, cand)
    if (isInsideDir(candidateAbs, repoRoot) && existsSync(candidateAbs)) return true
    const parent = dirname(curDir)
    if (parent === curDir) break
    curDir = parent
  }
  for (const vpRoot of vitePressRoots) {
    if (existsSync(join(repoRoot, vpRoot, cand))) return true
  }
  return false
}

/** 转发单一真相源 `discoverEvergreenDocs`，供 `govern-audit.mjs` 等消费。 */
export function discoverEvergreenAuthorityDocs(repoRoot, files = [], agentsText = '', authoritativeTddPath = null) {
  return discoverEvergreenDocs(repoRoot, { files, agentsText, authoritativeTddPath })
}

/** 统一检查全部常青权威文档与图谱的失效路径、履历体、未纳管活跃文档、断锚点/环/跳转链/分歧及多副本分裂（`docs.duplicate-authority`）。 */
export function checkEvergreenAuthorityDocs(repoRoot, files, agentsText, authoritativeTddPath, findings) {
  const discovered = discoverEvergreenDocs(repoRoot, { files, agentsText, authoritativeTddPath })
  const vitePressRoots = detectEvergreenVitePressRoots(repoRoot)
  const graph = discovered.docGraph
  const decisions = readDecisions(agentsText)
  const mdToScan = new Map()
  for (const doc of discovered.markdownDocs) mdToScan.set(doc.path, doc)
  for (const u of graph?.unaccountedDocs ?? []) {
    if (!mdToScan.has(u.path)) mdToScan.set(u.path, u)
  }

  for (const doc of mdToScan.values()) {
    const info = readTextStrictInfo(join(repoRoot, doc.path))
    if (!info?.text) continue
    if (doc.path !== authoritativeTddPath) {
      const checked = new Set()
      for (const m of info.text.matchAll(/`([^`\n]+)`/g)) {
        for (const cand of extractDocBacktickPaths(m[1])) {
          if (checked.has(cand)) continue
          checked.add(cand)
          if (!evergreenCandidateExists(repoRoot, doc.path, cand, vitePressRoots)) {
            addFinding(findings, {
              id: `docs.authority-stale-path.${doc.path}.${cand}`,
              category: 'docs',
              severity: 'medium',
              file: doc.path,
              title: `Stale source path referenced in evergreen authority doc ${doc.path}: ${cand}`,
              action: `Update or remove "${cand}" in ${doc.path} to keep single-source docs accurate.`,
            })
          }
        }
      }
    }
    const voiceHits = findChangelogVoice(info.text, { file: doc.path })
    if (voiceHits.length > 0) {
      const first = voiceHits[0]
      addFinding(findings, {
        id: `docs.authority-changelog-voice.${doc.path}`,
        category: 'docs',
        severity: 'low',
        file: doc.path,
        line: first.line,
        title: `Changelog/tombstone phrasing in evergreen doc ${doc.path}:${first.line} ("${first.word}")`,
        action: `Rewrite ${doc.path} to describe current behavior only; leave history in git commits.`,
      })
    }
  }

  for (const grp of discovered.duplicateGroups) {
    addFinding(findings, {
      id: `docs.duplicate-authority.${grp.stem}`,
      category: 'docs',
      severity: 'medium',
      file: grp.paths[0],
      title: `Duplicate unlinked evergreen authority docs for "${grp.stem}": ${grp.paths.join(', ')}`,
      action: `Converge ${grp.paths.join(' and ')} into a single canonical authority doc and point all entry docs to it.`,
    })
  }

  if (graph) {
    if (!decisions.has('allow-unaccounted-docs')) {
      for (const u of graph.unaccountedDocs ?? []) {
        addFinding(findings, {
          id: `docs.unaccounted-active-doc.${u.path}`,
          category: 'docs',
          severity: 'medium',
          file: u.path,
          title: `Unaccounted active doc outside doc graph: ${u.path}`,
          action: `Link ${u.path} from AGENTS.md / README.md, register in evergreen-docs / frontmatter, or mark non-governed.`,
        })
      }
    }
    for (const ba of (graph.brokenAnchors ?? []).slice(0, 20)) {
      addFinding(findings, {
        id: `docs.broken-anchor.${ba.file}:${ba.line}.${ba.fragment}`,
        category: 'docs',
        severity: 'medium',
        file: ba.file,
        line: ba.line,
        title: `Broken Markdown heading anchor in ${ba.file}:${ba.line} -> "${ba.target}"`,
        action: `Fix heading fragment "#${ba.fragment}" in ${ba.file} or update heading in ${ba.resolvedTarget}.`,
      })
    }
    for (const aw of (graph.anchorWarnings ?? []).slice(0, 20)) {
      addFinding(findings, {
        id: `docs.missing-anchor-heading.${aw.featureId}.${aw.path}`,
        category: 'docs',
        severity: 'low',
        file: aw.targetRel,
        title: `Feature-map docAnchor heading missing: "${aw.path}" (feature=${aw.featureId})`,
        action: `Add heading "#${aw.fragment}" in ${aw.targetRel} or update docAnchors in docs/feature-map.json.`,
      })
    }
    for (const cyc of graph.cycles ?? []) {
      addFinding(findings, {
        id: `docs.authority-cycle.${cyc.nodes.join('->')}`,
        category: 'docs',
        severity: 'medium',
        file: cyc.nodes[0],
        title: `Authority pointer cycle detected: ${cyc.nodes.join(' <-> ')}`,
        action: `Break circular pointer between ${cyc.nodes.join(', ')} into a single acyclic canonical target.`,
      })
    }
    for (const rc of graph.redirectChains ?? []) {
      addFinding(findings, {
        id: `docs.redirect-chain.${rc.from}`,
        category: 'docs',
        severity: 'low',
        file: rc.from,
        title: `Multi-hop doc redirect chain (${rc.hops} hops): ${rc.chain.join(' -> ')}`,
        action: `Point ${rc.from} directly to ${rc.to} to eliminate intermediate redirect hops.`,
      })
    }
    for (const orp of graph.orphans ?? []) {
      addFinding(findings, {
        id: `docs.orphan-authority.${orp.path}`,
        category: 'docs',
        severity: 'low',
        file: orp.path,
        title: `Orphan authority doc unreachable from entry docs: ${orp.path}`,
        action: `Link ${orp.path} from AGENTS.md or README.md so readers can discover it.`,
      })
    }
    for (const div of graph.entryDivergence ?? []) {
      addFinding(findings, {
        id: `docs.entry-divergence.${div.stem}`,
        category: 'docs',
        severity: 'medium',
        file: div.entries[0],
        title: `Entry docs diverge on "${div.stem}" targets: ${div.targets.join(' vs ')}`,
        action: `Align ${div.entries.join(' and ')} to point to the same canonical "${div.stem}" authority doc.`,
      })
    }
  }
  return discovered
}

const MODULE_MANIFEST_RE = /^(?:package\.json|pyproject\.toml|setup\.py|setup\.cfg|Cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|composer\.json|pubspec\.yaml|Package\.swift|mix\.exs|CMakeLists\.txt|.*\.(?:csproj|fsproj)|SKILL\.md)$/i

function dirHasCodeOrManifest(dirAbs, depth = 0) {
  if (depth > 8) return false
  let entries
  try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { return false }
  const subDirs = []
  for (const entry of entries) {
    if (entry.name.startsWith('.') || isMacOsJunkPath(entry.name)) continue
    if (entry.isFile()) {
      if (CODE_EXT_RE.test(entry.name) || MODULE_MANIFEST_RE.test(entry.name)) return true
    } else if (entry.isDirectory() && !DEFAULT_WALK_SKIP_DIRS.has(entry.name)) {
      subDirs.push(join(dirAbs, entry.name))
    }
  }
  for (const sub of subDirs) {
    if (dirHasCodeOrManifest(sub, depth + 1)) return true
  }
  return false
}

/** 扫描仓库代码模块目录，过滤无代码文件且无包清单的非代码目录（如示例 src/assembly、src/media、src/site）。 */
export function discoverCodeModules(repoRoot) {
  const modules = []
  const seen = new Set()
  const containerRoots = ['src', 'lib', 'scripts', 'packages', 'apps', 'services', 'app', 'cmd', 'internal', 'pkg', 'kit/skills']
  for (const cr of containerRoots) {
    const abs = join(repoRoot, cr)
    if (!existsSync(abs)) continue
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || isMacOsJunkPath(entry.name)) continue
      const p = `${cr}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'dev') continue
        if (cr === 'src' && /^(?:test|tests|__tests__|it)$/i.test(entry.name)) continue
        if (!dirHasCodeOrManifest(join(abs, entry.name))) continue
        if (!seen.has(p)) { seen.add(p); modules.push({ name: entry.name, path: p }) }
      } else if (entry.isFile() && CODE_EXT_RE.test(entry.name)) {
        if (!seen.has(p)) { seen.add(p); modules.push({ name: entry.name, path: p }) }
      }
    }
  }
  return modules
}

const IGNORED_LINK_DIR_RE = /^(?:\.\/)?(?:(?:dist|build|\.next|out|coverage|target)\/|\.(?:claude|cursor|codex|windsurf|gemini|vscode|idea|agents)\/)/i

/** 解析 Markdown 相对链接目标存在性（支持 VitePress 根路由及 `.github/*.md` 仓库根目录回退；排除无扩展名站内路由、构建产物与隐藏代理目录）。 */
export function markdownTargetExists(repoRoot, fromFileAbs, decoded, vitePressRoots = []) {
  const normDecoded = posixPath(String(decoded ?? '')).trim()
  if (!normDecoded) return true
  if (IGNORED_LINK_DIR_RE.test(normDecoded)) return true
  if (normDecoded.startsWith('/')) {
    const route = normDecoded.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!route) return true
    if (IGNORED_LINK_DIR_RE.test(route)) return true
    const candidates = [route, `${route}.md`, `${route}/index.md`]
    if (/\.html$/i.test(route)) {
      const stem = route.replace(/\.html$/i, '')
      candidates.push(`${stem}.md`, `${stem}/index.md`)
    }
    for (const vpRoot of ['', ...vitePressRoots]) {
      const prefix = vpRoot ? `${vpRoot}/` : ''
      for (const c of candidates) {
        if (c && existsSync(join(repoRoot, `${prefix}${c}`))) return true
      }
    }
    // 无扩展名应用内路由（如 /settings、/api/v1/users）不视为断链
    if (!/\.[A-Za-z0-9]{1,8}$/.test(route)) return true
    return false
  }
  const directAbs = resolve(dirname(fromFileAbs), decoded)
  if (existsSync(directAbs)) return true
  if (/\.html$/i.test(decoded)) {
    const mdAlt = resolve(dirname(fromFileAbs), decoded.replace(/\.html$/i, '.md'))
    if (existsSync(mdAlt)) return true
  }
  const fromRel = posixPath(relative(repoRoot, fromFileAbs))
  if (fromRel === '.github' || fromRel.startsWith('.github/')) {
    const repoFallback = resolve(repoRoot, decoded)
    if (isInsideDir(repoFallback, repoRoot) && existsSync(repoFallback)) return true
    if (/\.html$/i.test(decoded)) {
      const repoMdAlt = resolve(repoRoot, decoded.replace(/\.html$/i, '.md'))
      if (isInsideDir(repoMdAlt, repoRoot) && existsSync(repoMdAlt)) return true
    }
  }
  return false
}
