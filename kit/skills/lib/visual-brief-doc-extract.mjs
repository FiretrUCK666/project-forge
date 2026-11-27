/**
 * visual-brief-doc-extract.mjs —— 从 PRD/SPEC 自动投影范围文件、模块改动说明、目标/非目标/决策与验收标准。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），保持 `visual-brief.mjs <= 650` 行。
 */

import { basename, dirname } from 'node:path'

import { extractCriteria } from './criteria-lock.mjs'
import { parseDocFilename } from './doc-frontmatter.mjs'
import { posixPath } from './git.mjs'
import { deriveMasterPrdBriefKey, sanitizeBriefKey, uniqClean } from './visual-brief-store.mjs'

const NEW_MARKER_RE = /\s*(?:\(new\)|（新增）)\s*$/i
const MD_BOLD_RE = /\*\*([^*]+)\*\*/g

function cleanMdInline(raw, maxLen = 220) {
  const s = String(raw ?? '')
    .replace(MD_BOLD_RE, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (s.length <= maxLen) return s
  return `${s.slice(0, Math.max(12, maxLen - 3)).trim()}...`
}

function normScopeEntry(raw) {
  const txt = String(raw ?? '').trim().replace(/^`|`$/g, '').trim()
  if (!txt) return null
  const isNew = NEW_MARKER_RE.test(txt)
  const rel = posixPath(txt.replace(NEW_MARKER_RE, '').trim()).replace(/^\.\//, '').replace(/^\/+/, '')
  if (!rel || /^(?:none|null|无)$/i.test(rel)) return null
  return { rel, isNew }
}

function parseScopeFilesFromFrontmatter(fmData) {
  const raw = fmData?.scope_files
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : String(raw).split(',')
  const out = []
  const seen = new Set()
  for (const item of list) {
    const parsed = normScopeEntry(item)
    if (!parsed || seen.has(parsed.rel)) continue
    seen.add(parsed.rel)
    out.push(parsed)
  }
  return out
}

function extractFileNotesFromTables(mdText) {
  const notes = new Map()
  let inFence = false
  for (const rawLine of String(mdText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (/^(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence || !line.startsWith('|')) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3) continue
    if (/^[-:\s]+$/.test(cells[0]) || /^(?:模块|文件|路径)/.test(cells[0])) continue
    const kindCell = cleanMdInline(cells[1], 32)
    if (!/(?:新增|修改|移除|删除|重构|升级|收口)/.test(kindCell)) continue
    const summaryCell = cleanMdInline(cells[2], 140)
    if (!summaryCell) continue
    const fileTokens = [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1])
    const candidates = fileTokens.length > 0 ? fileTokens : cells[0].split(/[、,，\s]+/)
    for (const cand of candidates) {
      const parsed = normScopeEntry(cand)
      if (!parsed || !parsed.rel.includes('.')) continue
      if (!notes.has(parsed.rel)) notes.set(parsed.rel, { kind: kindCell, what: summaryCell })
    }
  }
  return notes
}

function splitMarkdownSections(mdText) {
  const sections = []
  let curHeading = ''
  let curLines = []
  let inFence = false
  for (const rawLine of String(mdText ?? '').split(/\r?\n/)) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inFence = !inFence
      curLines.push(rawLine)
      continue
    }
    const h = !inFence && /^(#{2,4})\s+(.+)$/.exec(rawLine.trim())
    if (h) {
      if (curHeading || curLines.length > 0) sections.push({ heading: curHeading, lines: curLines })
      curHeading = h[2].trim()
      curLines = []
    } else {
      curLines.push(rawLine)
    }
  }
  if (curHeading || curLines.length > 0) sections.push({ heading: curHeading, lines: curLines })
  return sections
}

function extractBulletsFromLines(lines, limit = 6) {
  const out = []
  for (const rawLine of lines) {
    const m = /^\s*(?:[-*]|\d+\.)\s+(.+)$/.exec(rawLine)
    if (!m) continue
    const txt = cleanMdInline(m[1], 220)
    if (!txt || /^\[[ xX]\]\s*C\d+/i.test(txt) || /^(?:无|待确认[:：]?\s*无)$/i.test(txt)) continue
    out.push(txt)
    if (out.length >= limit) break
  }
  return out
}

function extractStructuredFieldsFromDoc(docText) {
  const goals = []
  const nonGoals = []
  const decisions = []
  let specSummaryLine = ''
  const sections = splitMarkdownSections(docText)

  for (const rawLine of String(docText ?? '').split(/\r?\n/)) {
    const oneLiner = /^\s*-\s*\*\*变更一句话\*\*\s*[:：]\s*(.+)$/.exec(rawLine)
    if (oneLiner && !specSummaryLine) specSummaryLine = cleanMdInline(oneLiner[1], 240)
    const whatToChange = /^\s*-\s*\*\*要改什么\*\*\s*[:：]\s*(.+)$/.exec(rawLine)
    if (whatToChange) goals.push(cleanMdInline(whatToChange[1], 220))
    const notChange = /^\s*-\s*\*\*(?:不改什么|本期不做)\*\*\s*[:：]\s*(.+)$/.exec(rawLine)
    if (notChange) nonGoals.push(cleanMdInline(notChange[1], 220))
    const confirmed = /^\s*-\s*已确认\s*[:：]\s*(.+)$/.exec(rawLine)
    if (confirmed) decisions.push(cleanMdInline(confirmed[1], 220))
    const door = /^\s*-\s*\*\*门型判定\*\*\s*[:：]\s*(.+)$/.exec(rawLine)
    if (door) decisions.push(`门型：${cleanMdInline(door[1], 180)}`)
  }

  for (const sec of sections) {
    const h = sec.heading
    if (/(?:产品目标|核心目标)/.test(h)) {
      goals.push(...extractBulletsFromLines(sec.lines, 5))
    } else if (/(?:明确不做|Non-Goals|不在本次范围|非目标)/i.test(h)) {
      nonGoals.push(...extractBulletsFromLines(sec.lines, 5))
    } else if (/备选方案与否决理由/.test(h)) {
      for (const rawLine of sec.lines) {
        const line = rawLine.trim()
        if (!line.startsWith('|')) continue
        const cells = line.split('|').slice(1, -1).map((c) => c.trim())
        if (cells.length >= 2 && /(?:\(已选\)|（已选）|已选)/.test(cells[0])) {
          decisions.push(`${cleanMdInline(cells[0], 110)}：${cleanMdInline(cells[1], 120)}`)
        }
      }
    }
  }

  if (goals.length === 0 && specSummaryLine) goals.push(specSummaryLine)
  return {
    goals: uniqClean(goals).slice(0, 6),
    nonGoals: uniqClean(nonGoals).slice(0, 6),
    decisions: uniqClean(decisions).slice(0, 8),
    specSummaryLine,
  }
}

function docMatchesTask(doc, norm) {
  const targetTask = norm.taskId ? sanitizeBriefKey(norm.taskId) : null
  const targetKey = sanitizeBriefKey(norm.briefKey)
  const docTask = doc.taskId ? sanitizeBriefKey(doc.taskId) : (doc.data?.task_id ? sanitizeBriefKey(doc.data.task_id) : null)
  const docSlug = parseDocFilename(doc.rel)?.slug ? sanitizeBriefKey(parseDocFilename(doc.rel).slug) : null
  if (targetTask && docTask && docTask === targetTask) return true
  if (targetTask && docSlug && docSlug === targetTask) return true
  if (docTask && docTask === targetKey) return true
  if (docSlug && docSlug === targetKey) return true
  return false
}

/**
 * 按简报类型精确筛选关联规划文档（优先 workRoot 去重）：
 * - `kind === 'task'`：仅命中该切片 SPEC（若无则 Todo），绝不混入 Master PRD 或兄弟切片；
 * - `kind === 'master-prd'`：聚合 Master PRD + 关联全部活跃子切片 SPEC；
 * - `kind === 'topic'`：仅按 taskId / briefKey 精确命中。
 */
export function selectRelevantPlanDocs({ allDocs = [], norm, masterRel = null, effWork = '' }) {
  const dedup = new Map()
  for (const d of allDocs) {
    if (!d || d.archived) continue
    const rel = posixPath(d.rel || '')
    if (!rel) continue
    const existing = dedup.get(rel)
    if (!existing || (effWork && d.root === effWork && existing.root !== effWork)) {
      dedup.set(rel, d)
    }
  }
  const activeDocs = [...dedup.values()]

  if (norm.kind === 'master-prd') {
    const masterNorm = masterRel ? posixPath(masterRel) : null
    const masterBase = masterNorm ? basename(masterNorm) : null
    return activeDocs.filter((d) =>
      (masterNorm && posixPath(d.rel) === masterNorm)
      || (d.kind === 'prd' && deriveMasterPrdBriefKey(d.rel) === norm.briefKey)
      || (masterBase && d.kind === 'spec' && typeof d.data?.related_prd === 'string' && d.data.related_prd.includes(masterBase)))
  }

  if (norm.kind === 'task') {
    const matched = activeDocs.filter((d) => d.kind !== 'prd' && docMatchesTask(d, norm))
    const specs = matched.filter((d) => d.kind === 'spec')
    return specs.length > 0 ? specs : matched
  }

  return activeDocs.filter((d) => docMatchesTask(d, norm))
}

function ownedPathsOfFeature(f) {
  return [...new Set([
    ...(Array.isArray(f?.entrypoints) ? f.entrypoints : []),
    ...(Array.isArray(f?.modules) ? f.modules : []),
    ...(Array.isArray(f?.files) ? f.files : []),
    ...(Array.isArray(f?.tests) ? f.tests : []),
    ...(Array.isArray(f?.testRefs) ? f.testRefs : []),
  ].map((p) => posixPath(String(p || '')).replace(/^\.\//, '')).filter(Boolean))]
}

/**
 * 将 `scope_files` 精准映射到 `featureMap.features[]`：
 * 1. 先精确匹配 `entrypoints`/`modules`/`tests`/`testRefs`；
 * 2. 未精确命中者（如 `(new)` 新增文件）按最长目录前缀 + 该目录拥有文件数择优归属单个最近模块。
 */
export function mapScopeFilesToFeatures(scopeEntries = [], featureMap = {}) {
  const features = Array.isArray(featureMap?.features) ? featureMap.features : []
  const byFeature = new Map()
  const addHit = (fid, entry) => {
    if (!byFeature.has(fid)) byFeature.set(fid, [])
    const arr = byFeature.get(fid)
    if (!arr.some((x) => x.rel === entry.rel)) arr.push(entry)
  }

  const featureMeta = features.map((f) => {
    const owned = ownedPathsOfFeature(f)
    const ownedSet = new Set(owned)
    const dirCounts = new Map()
    for (const p of owned) {
      const dir = posixPath(dirname(p))
      if (dir && dir !== '.') dirCounts.set(dir, (dirCounts.get(dir) || 0) + 1)
    }
    return { id: f.id, ownedSet, dirCounts }
  })

  for (const entry of scopeEntries) {
    const fp = entry.rel
    const exactHits = featureMeta.filter((fm) => fm.ownedSet.has(fp))
    if (exactHits.length > 0) {
      for (const hit of exactHits) addHit(hit.id, entry)
      continue
    }
    const fpDir = posixPath(dirname(fp))
    if (!fpDir || fpDir === '.') continue
    let best = null
    for (const fm of featureMeta) {
      for (const [dir, count] of fm.dirCounts.entries()) {
        let depth = 0
        if (fpDir === dir) depth = dir.split('/').length * 2
        else if (fpDir.startsWith(`${dir}/`)) depth = dir.split('/').length * 2 - 1
        else continue
        const score = depth * 1000 + Math.min(999, count)
        if (!best || score > best.score || (score === best.score && fm.id.localeCompare(best.id) < 0)) {
          best = { id: fm.id, score }
        }
      }
    }
    if (best) addHit(best.id, entry)
  }

  return byFeature
}

function criteriaOrderNum(id) {
  const m = /^C(\d+)$/i.exec(String(id || ''))
  return m ? Number(m[1]) : 9999
}

function synthesizeModuleChangeNote({ fid, entries, fileNotes, criteria }) {
  const rels = entries.map((e) => e.rel)
  const noteParts = []
  for (const e of entries) {
    const fn = fileNotes.get(e.rel)
    if (fn?.what) {
      const prefix = e.isNew || fn.kind === '新增' ? '[新增] ' : ''
      noteParts.push(`${prefix}${basename(e.rel)}: ${cleanMdInline(fn.what, 88)}`)
      if (noteParts.length >= 3) break
    }
  }

  const matchedCriteria = criteria.filter((c) => {
    const txt = String(c.text || '').toLowerCase()
    if (txt.includes(fid.toLowerCase())) return true
    return rels.some((r) => txt.includes(r.toLowerCase()) || txt.includes(basename(r).toLowerCase()))
  })

  let note = ''
  if (noteParts.length > 0) {
    note = noteParts.join('；')
  } else if (matchedCriteria.length > 0) {
    note = matchedCriteria.slice(0, 2).map((c) => `${c.id}: ${cleanMdInline(c.text, 92)}`).join('；')
  } else if (rels.length > 0) {
    const preview = rels.slice(0, 4).map((r) => basename(r)).join(', ')
    note = `涉及 ${rels.length} 个变更文件：${preview}${rels.length > 4 ? ` 等` : ''}`
  }

  return {
    note: note.slice(0, 380),
    scopeFiles: rels.slice(0, 12),
    criteriaRefs: matchedCriteria.map((c) => c.id).slice(0, 8),
  }
}

/**
 * 汇总匹配规划文档的自动投影结果：范围文件、模块映射、模块级改动说明、目标/非目标/决策与验收标准。
 */
export function extractPlanDocProjection({ relevantDocs = [], featureMap = {}, manualFeatureChanges = {} }) {
  const scopeEntries = []
  const seenScope = new Set()
  const fileNotes = new Map()
  const goals = []
  const nonGoals = []
  const decisions = []
  const criteriaById = new Map()
  let specSummaryLine = ''

  for (const d of relevantDocs) {
    for (const se of parseScopeFilesFromFrontmatter(d.data)) {
      if (!seenScope.has(se.rel)) {
        seenScope.add(se.rel)
        scopeEntries.push(se)
      }
    }
    for (const [rel, info] of extractFileNotesFromTables(d.text).entries()) {
      if (!fileNotes.has(rel)) fileNotes.set(rel, info)
    }
    const fields = extractStructuredFieldsFromDoc(d.text)
    goals.push(...fields.goals)
    nonGoals.push(...fields.nonGoals)
    decisions.push(...fields.decisions)
    if (!specSummaryLine && fields.specSummaryLine) specSummaryLine = fields.specSummaryLine

    for (const c of extractCriteria(d.text)) {
      if (!criteriaById.has(c.id)) {
        criteriaById.set(c.id, { id: c.id, text: cleanMdInline(c.text, 240), checked: Boolean(c.checked), source: d.rel })
      }
    }
  }

  const criteria = [...criteriaById.values()].sort((a, b) => criteriaOrderNum(a.id) - criteriaOrderNum(b.id))
  const mappedByFeature = mapScopeFilesToFeatures(scopeEntries, featureMap)
  const autoModifiedFeatureIds = [...mappedByFeature.keys()]

  const mergedFeatureChanges = {}
  for (const [fid, val] of Object.entries(manualFeatureChanges || {})) {
    mergedFeatureChanges[fid] = { ...val }
  }
  for (const [fid, entries] of mappedByFeature.entries()) {
    const synth = synthesizeModuleChangeNote({ fid, entries, fileNotes, criteria })
    const prev = mergedFeatureChanges[fid]
    if (prev) {
      mergedFeatureChanges[fid] = {
        ...prev,
        ...(prev.note || (prev.before && prev.after) ? {} : { note: synth.note }),
        scopeFiles: prev.scopeFiles?.length ? prev.scopeFiles : synth.scopeFiles,
        criteriaRefs: prev.criteriaRefs?.length ? prev.criteriaRefs : synth.criteriaRefs,
      }
    } else {
      mergedFeatureChanges[fid] = {
        state: 'modified',
        note: synth.note,
        scopeFiles: synth.scopeFiles,
        criteriaRefs: synth.criteriaRefs,
      }
    }
  }

  return {
    scopeFiles: scopeEntries.map((e) => e.rel),
    autoModifiedFeatureIds,
    mergedFeatureChanges,
    goals: uniqClean(goals).slice(0, 6),
    nonGoals: uniqClean(nonGoals).slice(0, 6),
    decisions: uniqClean(decisions).slice(0, 8),
    criteria,
    specSummaryLine,
  }
}
