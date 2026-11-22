/**
 * context-brief.mjs —— 常青文档目录（evergreenToc）、Top-N 按需切片（relatedSlices）与
 * feature-map 业务流/验证工具的唯一只读装配内核。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块及同目录 `kit/skills/lib/` 模块），
 * 严格只读 Fail-Soft 降级：缺文档、空目录或损坏的 `feature-map.json` 一律安全返回空结构，绝不抛错或虚构章节。
 */

import { existsSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { discoverContextDocs, locateTopSlicesForPaths } from './doc-locator.mjs'
import { matchFeatureMapForPaths, readFeatureMapStatus } from './feature-map.mjs'
import { canonicalPath, posixPath, readTextSafe } from './git.mjs'
import { indexMarkdownSections } from './markdown-scan.mjs'
import { discoverEvergreenDocs } from './profile.mjs'

function quoteCliArg(value) {
  return `"${String(value ?? '').replace(/"/g, '\\"')}"`
}

function buildDocLocateCmd(relPath, sectionTitle = null) {
  const base = `node .agents/skills/dev-explore/scripts/doc-locate.mjs --file ${quoteCliArg(relPath)}`
  if (!sectionTitle) return base
  const sec = sectionTitle.length > 44 ? sectionTitle.slice(0, 40).trimEnd() : sectionTitle
  return `${base} --section ${quoteCliArg(sec)}`
}

function normRelPath(raw) {
  return posixPath(String(raw ?? '').trim()).replace(/^\.\//, '')
}

function uniqStrings(arr) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(arr) ? arr : []) {
    const s = String(item ?? '').trim()
    if (s && !seen.has(s)) { seen.add(s); out.push(s) }
  }
  return out
}

/**
 * 从规划文档文本中抽取「影响路径」/ `scope_files` 声明的源码或配置相对路径。
 * 过滤通配符、带空格命令以及 `.agents/`/`node_modules/`/`dist/`/`build/` 产物目录。
 */
export function extractDocPaths(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  if (!body) return []
  const parts = []

  const section = /^##[^\n]*(?:影响路径|影响范围|涉及文件|改动路径)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)?.[1]
  if (section) parts.push(section)

  const inline = /^-\s*\*\*(?:影响路径|影响范围|涉及文件|改动路径)\*\*\s*[:：]\s*(.+)$/gm
  for (const m of body.matchAll(inline)) parts.push(m[1])

  const fm = parseDocFrontmatter(body)
  const found = []
  for (const s of Array.isArray(fm?.data?.scope_files) ? fm.data.scope_files : []) {
    const rel = normRelPath(s)
    if (rel && !/[*?{}]/.test(rel) && !/\s/.test(rel)) found.push(rel)
  }

  for (const part of parts) {
    for (const m of part.matchAll(/`([^`\n]+)`/g)) {
      const rel = normRelPath(m[1])
      if (!/[/\\]/.test(rel)) continue
      if (/^(?:TODO|TBD)$/i.test(rel)) continue
      if (/[*?{}]/.test(rel)) continue
      if (/\s/.test(rel)) continue
      if (/^(?:\.agents|node_modules|dist|build)\//.test(rel)) continue
      found.push(rel)
    }
  }
  return [...new Set(found)]
}

/** 从任务的 SPEC/Todo/PRD 文档提取影响路径与关键词种子（只读 Fail-Soft）。 */
export function extractDocBriefSeeds(docRoots, docRels = []) {
  const roots = (Array.isArray(docRoots) ? docRoots : [docRoots]).filter(Boolean)
  const paths = []
  const keywords = []
  for (const rel of uniqStrings(docRels)) {
    let text = ''
    for (const r of roots) {
      const abs = join(r, rel)
      if (existsSync(abs)) {
        text = readTextSafe(abs) ?? ''
        if (text) break
      }
    }
    if (!text) continue
    for (const p of extractDocPaths(text)) {
      if (!paths.includes(p)) paths.push(p)
    }
    const fm = parseDocFrontmatter(text)
    if (fm?.data?.title && typeof fm.data.title === 'string') {
      keywords.push(fm.data.title.trim())
    }
  }
  return { paths, keywords: uniqStrings(keywords) }
}

function emptyBrief(warning = null) {
  return {
    evergreenToc: [],
    otherEvergreenDocs: [],
    totalEvergreenDocs: 0,
    relatedSlices: [],
    featureMap: {
      exists: false,
      corrupt: false,
      warning,
      totalFeaturesCount: 0,
      matchedFeatures: [],
      businessFlows: [],
      verificationTools: [],
      testRefs: [],
      featureOverview: [],
    },
  }
}

function scoreEvergreenPriority(doc, normPaths, kwTokens) {
  const rel = doc.path
  const relLow = rel.toLowerCase()
  let score = 0

  if (normPaths.includes(rel)) score += 120
  if (relLow.endsWith('/agents.md')) {
    const pkgDir = rel.slice(0, -'AGENTS.md'.length)
    if (normPaths.some((p) => p.startsWith(pkgDir))) score += 110
    else score += 5
  }
  const dirPrefixes = new Set()
  for (const p of normPaths) {
    const segs = p.split('/')
    for (let i = 1; i < segs.length; i += 1) dirPrefixes.add(`${segs.slice(0, i).join('/')}/`)
    const stem = basename(p).replace(/\.[^.]+$/, '').toLowerCase()
    if (stem.length >= 3 && relLow.includes(stem)) score += 45
  }
  for (const pref of dirPrefixes) {
    if (rel.startsWith(pref)) { score += 50; break }
  }
  for (const kw of kwTokens) {
    if (kw.length >= 3 && relLow.includes(kw)) { score += 25; break }
  }

  if (doc.source === 'profile' || doc.source === 'frontmatter') score += 30
  else if (doc.source === 'entry-link') score += 20

  if (relLow === 'docs/tdd.md') score += 18
  else if (relLow === 'architecture.md' || relLow === 'docs/architecture.md') score += 14
  else if (relLow.endsWith('-tdd.md')) score += 12

  return score
}

/**
 * 构建统一只读上下文简报：合并全类常青文档目录（`evergreenToc` + `otherEvergreenDocs`）、
 * Top-N 切片（`relatedSlices`）与 `docs/feature-map.json` 业务流/验证工具（`featureMap`）。
 */
export function buildContextBrief(repoRoot, {
  paths = [],
  keywords = [],
  excludeFiles = [],
  limit = 3,
  budgetLines = 48,
  maxEvergreenDocs = 4,
  maxHeadings = 10,
  profile = null,
} = {}) {
  if (!repoRoot) return emptyBrief()
  let root
  try {
    root = canonicalPath(repoRoot)
    if (!existsSync(root) || !statSync(root).isDirectory()) return emptyBrief()
  } catch {
    return emptyBrief()
  }

  const normPaths = uniqStrings((paths ?? []).map(normRelPath))
  const normExcludes = new Set(uniqStrings((excludeFiles ?? []).map(normRelPath)))
  const cleanKeywords = uniqStrings(keywords)
  const kwTokens = cleanKeywords
    .flatMap((k) => k.toLowerCase().split(/[\s,，;；/]+/))
    .filter((t) => t.length >= 2)

  // 1. 合并全类常青发现（profile / frontmatter / entry-link / convention）+ 子包 */AGENTS.md
  const byPath = new Map()
  try {
    const ev = discoverEvergreenDocs(root, profile ? { profile } : {})
    for (const d of ev?.markdownDocs ?? []) {
      const p = normRelPath(d?.path)
      if (!p || normExcludes.has(p) || byPath.has(p)) continue
      byPath.set(p, { path: p, source: d.source ?? 'convention', family: d.family ?? '', stem: d.stem ?? '' })
    }
  } catch { /* Fail-Soft */ }

  try {
    const ctxDocs = discoverContextDocs(root)
    for (const sub of ctxDocs?.subAgents ?? []) {
      const p = normRelPath(sub?.file)
      if (!p || normExcludes.has(p) || byPath.has(p)) continue
      byPath.set(p, { path: p, source: 'sub-agents', family: 'agents', stem: 'agents' })
    }
  } catch { /* Fail-Soft */ }

  const sortedEvergreen = [...byPath.values()].sort((a, b) => {
    const diff = scoreEvergreenPriority(b, normPaths, kwTokens) - scoreEvergreenPriority(a, normPaths, kwTokens)
    return diff !== 0 ? diff : a.path.localeCompare(b.path)
  })

  const maxDocs = Math.max(0, Number(maxEvergreenDocs) || 0)
  const maxHeads = Math.max(0, Number(maxHeadings) || 0)
  const evergreenToc = []

  for (const doc of sortedEvergreen.slice(0, maxDocs)) {
    try {
      const abs = join(root, doc.path)
      const text = existsSync(abs) ? readTextSafe(abs, 512 * 1024) : undefined
      if (!text) continue
      const allH2 = indexMarkdownSections(text).filter((s) => s.level === 2)
      const headings = allH2.slice(0, maxHeads).map((s) => ({
        title: s.title,
        line: s.startLine,
        locateCommand: buildDocLocateCmd(doc.path, s.title),
      }))
      evergreenToc.push({
        path: doc.path,
        source: doc.source,
        headings,
        sectionCount: allH2.length,
        locateCommand: buildDocLocateCmd(doc.path, headings[0]?.title ?? null),
      })
    } catch { /* Fail-Soft */ }
  }

  const otherEvergreenDocs = sortedEvergreen.slice(maxDocs, maxDocs + 12).map((d) => d.path)
  const totalEvergreenDocs = sortedEvergreen.length

  // 2. 提取 Top-N 相关章节切片
  let relatedSlices = []
  try {
    const rawSlices = locateTopSlicesForPaths(root, {
      paths: normPaths,
      keywords: cleanKeywords,
      excludeFiles: [...normExcludes],
      priorityFiles: sortedEvergreen.map((d) => d.path),
      limit,
      budgetLines,
    })
    relatedSlices = (rawSlices ?? []).map((s) => ({
      absPath: s.absPath,
      relPath: s.relPath,
      kind: s.kind,
      section: s.section,
      startLine: s.startLine,
      endLine: s.endLine,
      score: s.score,
      summary: s.summary,
      locateCommand: s.locateCommand,
    }))
  } catch {
    relatedSlices = []
  }

  // 3. 查询 docs/feature-map.json（含无精确路径命中时的顶级 feature 域概览）
  let featureMap = emptyBrief().featureMap
  try {
    const fm = matchFeatureMapForPaths(root, normPaths, cleanKeywords)
    const status = fm.exists && !fm.corrupt ? readFeatureMapStatus(root) : null
    const allFeatures = status && !status.corrupt && Array.isArray(status.featureMap?.features)
      ? status.featureMap.features
      : []
    const matchedFeatures = (fm.matchedFeatures ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      matchedBy: f.matchedBy ?? [],
      matchedFiles: f.matchedFiles ?? [],
      businessFlows: f.businessFlows ?? [],
      testRefs: f.testRefs ?? [],
    }))
    const featureOverview = fm.exists && !fm.corrupt && matchedFeatures.length === 0 && allFeatures.length > 0
      ? allFeatures.slice(0, 8).map((f) => ({
          id: f.id,
          name: f.name,
          entrypoints: (f.entrypoints ?? []).slice(0, 3),
          businessFlows: (f.businessFlows ?? []).slice(0, 2),
        }))
      : []
    featureMap = {
      exists: Boolean(fm.exists),
      corrupt: Boolean(fm.corrupt),
      warning: fm.warning ?? null,
      totalFeaturesCount: allFeatures.length,
      matchedFeatures,
      businessFlows: fm.businessFlows ?? [],
      verificationTools: (fm.verificationTools ?? []).map((t) => ({
        id: t.id,
        featureId: t.featureId ?? null,
        featureName: t.featureName ?? null,
        kind: t.kind,
        command: t.command ?? null,
        scriptPath: t.scriptPath ?? null,
        riskLevel: t.riskLevel ?? 'medium',
      })),
      testRefs: fm.testRefs ?? [],
      featureOverview,
    }
  } catch {
    featureMap = emptyBrief().featureMap
  }

  return {
    evergreenToc,
    otherEvergreenDocs,
    totalEvergreenDocs,
    relatedSlices,
    featureMap,
  }
}

/** 将 contextBrief 格式化为有界紧凑的文本行数组（不灌全文，可直接打印到 stdout）。 */
export function formatContextBriefLines(brief, {
  title = '--- Context Brief (Evergreen Docs & Feature Map) ---',
  maxSlices = 3,
  maxFlows = 6,
  maxTools = 4,
  includeFeatureMap = true,
} = {}) {
  if (!brief || typeof brief !== 'object') return []
  const toc = Array.isArray(brief.evergreenToc) ? brief.evergreenToc : []
  const others = Array.isArray(brief.otherEvergreenDocs) ? brief.otherEvergreenDocs : []
  const slices = (Array.isArray(brief.relatedSlices) ? brief.relatedSlices : []).slice(0, Math.max(0, maxSlices))
  const fm = brief.featureMap ?? null
  const hasFm = Boolean(includeFeatureMap && fm && (fm.exists || fm.corrupt))

  if (toc.length === 0 && others.length === 0 && slices.length === 0 && !hasFm) return []

  const lines = [title]
  for (const doc of toc) {
    const hList = Array.isArray(doc.headings) ? doc.headings : []
    const hSummary = hList.length > 0
      ? hList.map((h) => `${h.title}(L${h.line})`).join(' | ')
      : '(no ## headings)'
    lines.push(`  Evergreen [${doc.source}] ${doc.path}: ${hSummary}`)
    lines.push(`    cmd: ${doc.locateCommand}`)
  }
  if (others.length > 0) {
    const total = Number(brief.totalEvergreenDocs) || (toc.length + others.length)
    lines.push(`  Other Evergreen (${total} total): ${others.join(', ')} (run: node .agents/skills/dev-explore/scripts/doc-locate.mjs --file <path>)`)
  }
  if (slices.length > 0) {
    lines.push(`  Related Slices (${slices.length}):`)
    for (const s of slices) {
      const sum = s.summary ? ` — ${s.summary.length > 80 ? `${s.summary.slice(0, 77)}...` : s.summary}` : ''
      lines.push(`    - ${s.relPath}:${s.startLine}-${s.endLine}${s.section ? ` (${s.section})` : ''}${sum}`)
      lines.push(`      cmd: ${s.locateCommand}`)
    }
  }
  if (hasFm) {
    if (fm.corrupt) {
      lines.push(`  Feature Map: CORRUPT (${fm.warning ?? 'invalid JSON'})`)
    } else {
      const flows = (fm.businessFlows ?? []).slice(0, Math.max(0, maxFlows))
      const tools = (fm.verificationTools ?? []).slice(0, Math.max(0, maxTools))
      if (flows.length > 0) {
        lines.push(`  Business Flows (${fm.businessFlows.length}):`)
        for (const bf of flows) lines.push(`    - ${bf}`)
      }
      if (tools.length > 0) {
        lines.push(`  Verification Tools (${fm.verificationTools.length}):`)
        for (const vt of tools) lines.push(`    - [${vt.id}] (${vt.riskLevel ?? 'medium'}) ${vt.command || vt.scriptPath || '(no cmd)'}`)
      }
      if ((fm.matchedFeatures?.length ?? 0) === 0 && (fm.featureOverview?.length ?? 0) > 0) {
        lines.push(`  Feature Map Overview (${fm.totalFeaturesCount ?? fm.featureOverview.length} features, no exact path match):`)
        for (const ov of fm.featureOverview.slice(0, 6)) {
          const eps = ov.entrypoints?.length ? ` [${ov.entrypoints.join(', ')}]` : ''
          lines.push(`    - ${ov.id} (${ov.name})${eps}`)
        }
      }
    }
  }
  return lines
}
