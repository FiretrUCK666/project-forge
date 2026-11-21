/**
 * doc-substantive.mjs —— 核心章节实质性校验（零字数门槛）、技术锚点提取与跨轮防退化快照比对。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { prepareExecInvocation } from './exec.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { hasDotGitInAncestors, readHeadFast, resolveGitDirFast } from './git-fast.mjs'
import { analyzePendingDecisions } from './pending-decisions.mjs'

export const VAGUE_FLUFF_RE = /(?:提高质量|提升质量|保证稳定|确保稳定|保持稳定|确保安全|优化体验|提升体验|增强体验|改善体验|完善功能|优化功能|增强功能|做好测试|提升性能|改善性能|优化性能|增强健壮性|提升健壮性|代码整洁|按需处理|合理设计|合理规划|全面优化|整体提升|正常工作|正常运行|improve\s+(?:experience|quality|performance)|enhance\s+(?:experience|stability|quality)|ensure\s+stability|optimize\s+feature)/i

const PLACEHOLDER_TEXT_RE = /(?:待补齐|待补充|待填写|待核实|\bTBD\b|\bFIXME\b|<!--\s*(?:project-forge:\s*)?fill)/i
const ANGLE_PLACEHOLDER_RE = /<[^>\n]{1,120}>/g
const ANGLE_PLACEHOLDER_SINGLE_RE = /<[^>\n]{1,120}>/
const EXACT_STUB_RE = /^(?:待补齐|待补充|待填写|待核实|待定|待确认|暂无|暂缺|无|没有|略|同上|tbd|tba|todo|fixme|none|n\/a|na|-+|—+|_+)$/i
const DECIDED_RE = /(?:已定|已拍板|决定|结论|采纳建议|按建议执行|已确认)\s*[:：]/i

const SECTION_SPECS = Object.freeze([
  { id: 'non-goals', label: '不做什么', keywords: ['本期不做', '明确不做', '非目标', 'Non-Goals', '不在本次范围', '范围外', 'Out of scope', '不做'] },
  { id: 'goal', label: '要做什么', keywords: ['要解决的问题', '背景与边界', '背景', '目标', '要改什么', '任务范围', '需求描述', '动机', '现状', 'Why', 'Problem', 'Motivation', 'Goal', 'Overview'] },
  { id: 'design', label: '设计方案与契约变更', keywords: ['设计方案', '契约变更', '接口变更', '方案与契约'] },
  { id: 'alternatives', label: '备选方案与否决理由', keywords: ['备选方案', '否决理由', '方案对比'] },
  { id: 'reuse', label: '复用既有模块', keywords: ['复用既有模块', '复用模块', '可复用', '已有能力'] },
])

const INLINE_CHECK_LABELS = Object.freeze([
  { id: 'goal', label: '要改什么 / 目标', re: /^-\s+\*\*(?:要改什么|要做什么|目标|影响路径|改动路径|修改文件)\*\*\s*[:：]\s*(.*)$/ },
  { id: 'non-goals', label: '本期不做', re: /^-\s+\*\*(?:本期不做|非目标|不做|不改什么|不动什么)\*\*\s*[:：]\s*(.*)$/ },
  { id: 'reuse', label: '复用既有模块', re: /^-\s+\*\*(?:复用既有模块|复用模块)\*\*\s*[:：]\s*(.*)$/ },
])

/** 判断剥离空白、注释与列表标记后的值是否属于无实质内容占位桩。 */
export function isStubValue(rawText) {
  const stripped = String(rawText ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(ANGLE_PLACEHOLDER_RE, '')
    .replace(/^\s*[-*]\s+/, '')
    .replace(/^\s*\d+[.、)]\s+/, '')
    .replace(/^\s*\*\*[^*\n]+\*\*\s*[:：]\s*/, '')
    .replace(/[。.;；,，:：\s]+$/g, '')
    .replace(/^[。.;；,，:：\s]+/g, '')
    .trim()
  if (!stripped) return true
  if (EXACT_STUB_RE.test(stripped)) return true
  if (PLACEHOLDER_TEXT_RE.test(stripped) && stripped.length <= 24) return true
  return false
}

function normalizeSectionText(raw) {
  return String(raw ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n')
    .trim()
}

function isEmptyTableShell(sectionText) {
  const nonEmpty = String(sectionText ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (nonEmpty.length === 0) return true
  const nonTable = nonEmpty.filter((l) => !l.startsWith('|'))
  if (nonTable.length > 0) return false
  const dataRows = nonEmpty.filter((l) => !/^\|(?:\s*:?-+:?\s*\|)+$/.test(l))
  return dataRows.length <= 1
}

function hasExplicitStubOnlyContent(sectionText) {
  const lines = String(sectionText ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('>') && !/^\|(?:\s*:?-+:?\s*\|)+$/.test(l) && !/^#{3,6}\s+/.test(l))
  if (lines.length === 0) return true
  const withoutAngles = lines.filter((l) => !ANGLE_PLACEHOLDER_SINGLE_RE.test(l) || PLACEHOLDER_TEXT_RE.test(l))
  if (withoutAngles.length === 0) return false
  return withoutAngles.every((l) => isStubValue(l))
}

/** 抽取文档或章节中的可验证技术锚点（零字数门槛，兼容中英文路径、命令、参数、数值与具体排除对象）。 */
export function extractTechAnchors(text) {
  const src = String(text ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^#{1,6}\s+[^\n]*$/gm, '')
  const anchors = new Set()

  for (const m of src.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim()
    if (!tok || /^<[^>\n]+>$/.test(tok) || PLACEHOLDER_TEXT_RE.test(tok)) continue
    anchors.add(`\`${tok}\``)
  }

  const noAngles = src.replace(ANGLE_PLACEHOLDER_RE, ' ')
  for (const m of noAngles.matchAll(/(?:^|[\s(（:：,`'"])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|cjs|js|ts|tsx|jsx|go|py|rs|java|kt|cs|rb|php|swift|dart|md|json|ya?ml|toml|sql|prisma|sh|ps1|html|css|scss))(?=$|[\s)）:：,;，。`'"、])/g)) {
    anchors.add(m[1])
  }
  for (const m of noAngles.matchAll(/\b([A-Z][A-Z0-9_]{2,}|[a-z]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g)) {
    anchors.add(m[1])
  }
  for (const m of noAngles.matchAll(/(?:^|\s)(--[a-z][a-z0-9-]*)\b/gi)) {
    anchors.add(m[1].toLowerCase())
  }
  for (const m of noAngles.matchAll(/(?:<=|>=|==|!=|<|>)\s*\d+(?:\.\d+)?(?:\s*[A-Za-z%]+)?|\b\d+(?:\.\d+)?\s*(?:ms|s|m|h|uA|mA|V|W|Hz|KB|MB|GB|B|px|%|条|项|个|行|轮|次|文件)\b/gi)) {
    anchors.add(m[0].replace(/\s+/g, ''))
  }
  for (const m of noAngles.matchAll(/\bC\d+\b/g)) {
    anchors.add(m[0].toUpperCase())
  }
  for (const m of noAngles.matchAll(/(?:退出码|exit(?:\s+code)?)\s*[:：=]?\s*\d+/gi)) {
    anchors.add(m[0].replace(/\s+/g, ' ').trim())
  }

  let hasConcreteExclusion = false
  for (const m of noAngles.matchAll(/(?:不动|不改|不修改|不引入|不新增|不做|不碰|不依赖|排除|不涉及|不含|won'?t\s+(?:do|touch|change|modify|support)|no\s+(?:GUI|API|network|external|third-party))\s*[:：]?\s*([^\n，,；;。]+)/gi)) {
    const target = m[1].trim()
    if (!target || isStubValue(target) || (VAGUE_FLUFF_RE.test(target) && anchors.size === 0)) continue
    hasConcreteExclusion = true
    anchors.add(`!${target.slice(0, 48)}`)
  }

  return { anchors: [...anchors].sort(), count: anchors.size, hasConcreteExclusion }
}

function splitNamedSections(bodyText) {
  const lines = String(bodyText ?? '').replace(/\r\n/g, '\n').split('\n')
  const blocks = []
  let cur = null
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && /^##\s+(.+)$/.test(line)) {
      if (cur) blocks.push(cur)
      cur = { title: line.replace(/^##\s+/, '').trim(), line: i + 1, lines: [] }
      continue
    }
    if (cur) cur.lines.push({ lineNo: i + 1, text: line })
  }
  if (cur) blocks.push(cur)
  return blocks
}

function matchSectionId(title) {
  const low = String(title ?? '').toLowerCase()
  for (const spec of SECTION_SPECS) {
    if (spec.keywords.some((kw) => low.includes(kw.toLowerCase()))) return spec.id
  }
  return null
}

const SUB_NON_GOALS_RE = /^###\s*(?:明确不做|本期不做|非目标|Non-Goals|不在本次范围|范围外|Out\s+of\s+scope)/i
const SUB_GOAL_RE = /^###\s*(?:本次要做|In\s+Scope|要改什么|要做什么|目标|本次范围)/i

function splitSubSectionsWithLineNos(blk) {
  const subs = []
  const preLines = []
  let cur = null
  let inFence = false
  for (const ln of blk.lines) {
    if (/^\s*(?:```|~~~)/.test(ln.text)) inFence = !inFence
    if (!inFence && /^###\s+/.test(ln.text)) {
      if (cur) subs.push(cur)
      cur = { title: ln.text.replace(/^###\s+/, '').trim(), rawHeading: ln.text, lineNo: ln.lineNo, lines: [] }
      continue
    }
    if (cur) cur.lines.push(ln.text)
    else preLines.push(ln.text)
  }
  if (cur) subs.push(cur)
  return { preLines, subs }
}

function resolveInspectableUnits(blk) {
  const id = matchSectionId(blk.title)
  if (!id) return []
  const rawSec = blk.lines.map((l) => l.text).join('\n')
  if (id === 'non-goals' || id === 'goal') {
    const { preLines, subs } = splitSubSectionsWithLineNos(blk)
    const hasScopedSubs = subs.some((s) => SUB_NON_GOALS_RE.test(s.rawHeading) || SUB_GOAL_RE.test(s.rawHeading))
    if (hasScopedSubs) {
      const units = []
      const preClean = normalizeSectionText(preLines.join('\n'))
      if (preClean) units.push({ id, label: blk.title, lineNo: blk.line, rawText: preLines.join('\n'), key: `${blk.line}:pre:${id}` })
      for (const sub of subs) {
        const subId = SUB_NON_GOALS_RE.test(sub.rawHeading)
          ? 'non-goals'
          : (SUB_GOAL_RE.test(sub.rawHeading) ? 'goal' : (id === 'non-goals' ? 'goal' : id))
        units.push({ id: subId, label: sub.title, lineNo: sub.lineNo, rawText: sub.lines.join('\n'), key: `${sub.lineNo}:sub:${subId}` })
      }
      return units
    }
  }
  return [{ id, label: blk.title, lineNo: blk.line, rawText: rawSec, key: `${blk.line}:${id}` }]
}

/** 校验核心与设计章节实质性（拦截占位桩与纯套话，绝不设字数下限）。 */
export function checkCoreSubstantiveness(bodyText, docType) {
  if (!['prd', 'spec', 'todo'].includes(docType)) return []
  const errors = []
  const blocks = splitNamedSections(bodyText)
  const seenKeys = new Set()

  const inspectChunk = ({ id, label, lineNo, rawText, key }) => {
    if (seenKeys.has(key)) return
    seenKeys.add(key)
    const cleaned = normalizeSectionText(rawText)
    if (!cleaned || isEmptyTableShell(cleaned)) {
      errors.push({
        code: 'DOC_STUB_PLACEHOLDER',
        line: lineNo,
        section: id,
        message: `第 ${lineNo} 行「${label}」为空壳或空表，缺少实质内容`,
        fixHint: `请为「${label}」补充真实技术边界、模块路径或可验证结论。`,
      })
      return
    }
    const rawNoHtml = cleaned.replace(/<!--[\s\S]*?-->/g, '')
    const hasAngles = ANGLE_PLACEHOLDER_SINGLE_RE.test(rawNoHtml)
    if (hasExplicitStubOnlyContent(cleaned)) {
      errors.push({
        code: 'DOC_STUB_PLACEHOLDER',
        line: lineNo,
        section: id,
        message: `第 ${lineNo} 行「${label}」仅含占位词（如待补齐/暂无/暂缺/无），不允许过审`,
        fixHint: `请将「${label}」替换为具体模块路径、命令、约束条件或明确排除对象。`,
      })
      return
    }
    if (!hasAngles && VAGUE_FLUFF_RE.test(cleaned)) {
      const { count } = extractTechAnchors(cleaned)
      if (count === 0) {
        errors.push({
          code: 'DOC_VAGUE_CORE_SECTION',
          line: lineNo,
          section: id,
          message: `第 ${lineNo} 行「${label}」为空泛套话且缺乏真实技术锚点或明确排除对象`,
          fixHint: `请补充至少一处具体文件路径、命令、符号、参数、数值判据或明确排除对象（如不动某模块）。`,
        })
      }
    }
  }

  for (const blk of blocks) {
    const id = matchSectionId(blk.title)
    if (!id) continue

    // 若同一章节内打包了 `- **本期不做**：...` 等子条目，先逐条核对子条目防躲避
    let inFence = false
    for (const ln of blk.lines) {
      if (/^\s*(?:```|~~~)/.test(ln.text)) { inFence = !inFence; continue }
      if (inFence) continue
      for (const itemSpec of INLINE_CHECK_LABELS) {
        const m = itemSpec.re.exec(ln.text.trim())
        if (!m) continue
        const tail = m[1].trim()
        const tailClean = tail.replace(/<!--[\s\S]*?-->/g, '').trim()
        if (ANGLE_PLACEHOLDER_SINGLE_RE.test(tailClean) && !PLACEHOLDER_TEXT_RE.test(tailClean)) continue
        if (isStubValue(tailClean)) {
          errors.push({
            code: 'DOC_STUB_PLACEHOLDER',
            line: ln.lineNo,
            section: itemSpec.id,
            message: `第 ${ln.lineNo} 行「${itemSpec.label}」为占位桩（${tailClean || '空'}），不允许通过`,
            fixHint: `请填写具体的「${itemSpec.label}」（如不动 \`path/to/file\` 或真实复用模块）。`,
          })
        } else if (VAGUE_FLUFF_RE.test(tailClean) && extractTechAnchors(tailClean).count === 0) {
          errors.push({
            code: 'DOC_VAGUE_CORE_SECTION',
            line: ln.lineNo,
            section: itemSpec.id,
            message: `第 ${ln.lineNo} 行「${itemSpec.label}」为空泛套话且无技术锚点或具体排除对象`,
            fixHint: `请为「${itemSpec.label}」补充具体路径、符号或明确排除范围。`,
          })
        }
      }
    }

    for (const unit of resolveInspectableUnits(blk)) {
      inspectChunk(unit)
    }
  }

  return errors
}

function isSubstantiveText(rawText) {
  const cleaned = normalizeSectionText(rawText)
  if (!cleaned || isEmptyTableShell(cleaned) || hasExplicitStubOnlyContent(cleaned)) return false
  const hasAngles = ANGLE_PLACEHOLDER_SINGLE_RE.test(cleaned)
  if (hasAngles) return false
  if (VAGUE_FLUFF_RE.test(cleaned) && extractTechAnchors(cleaned).count === 0) return false
  return true
}

/** 抽取规划文档的结构化实质性与锚点快照，供跨轮防退化对比与 critique_anchors 落盘。 */
export function extractDocSnapshot(rawText) {
  const norm = String(rawText ?? '').replace(/\r\n/g, '\n')
  const body = norm.replace(/^---\n[\s\S]*?\n---\n*/, '')
  const blocks = splitNamedSections(body)
  const sections = {}
  const allAnchors = new Set()
  const coreSections = new Set()

  for (const blk of blocks) {
    for (const unit of resolveInspectableUnits(blk)) {
      const { id, rawText: rawUnit } = unit
      const substantive = isSubstantiveText(rawUnit)
      const { anchors } = extractTechAnchors(rawUnit)
      if (!sections[id]) {
        sections[id] = { present: Boolean(normalizeSectionText(rawUnit)), substantive, anchors: new Set(anchors) }
      } else {
        sections[id].present = sections[id].present || Boolean(normalizeSectionText(rawUnit))
        sections[id].substantive = sections[id].substantive || substantive
        for (const a of anchors) sections[id].anchors.add(a)
      }
      if (substantive) coreSections.add(id)
      for (const a of anchors) allAnchors.add(a)
    }
  }

  // 合并验收条目 C* 编号与其中技术锚点，拦截静默删除 C* 条目的退化
  let criteriaCount = 0
  let inFence = false
  for (const line of body.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^\s*-\s*\[[ xX]\]\s*C\d+\b/.test(line)) {
      criteriaCount += 1
      for (const a of extractTechAnchors(line).anchors) allAnchors.add(a)
    }
  }

  const pending = analyzePendingDecisions(norm)
  let decidedCount = 0
  for (const blk of blocks) {
    if (!/(?:待拍板|未决问题|待确认事项|开放问题|待定事项|open\s+questions?)/i.test(blk.title)) continue
    for (const ln of blk.lines) {
      if (DECIDED_RE.test(ln.text)) decidedCount += 1
    }
  }

  const serializedSections = {}
  for (const [k, v] of Object.entries(sections)) {
    serializedSections[k] = { present: v.present, substantive: v.substantive, anchors: [...v.anchors].sort() }
  }

  return {
    sections: serializedSections,
    anchors: [...allAnchors].sort(),
    coreSections: [...coreSections].sort(),
    pendingResolved: decidedCount,
    pendingUnresolved: pending.unresolved.length,
    criteriaCount,
  }
}

/** 安全反序列化 frontmatter 中的 critique_anchors 单行快照。 */
export function parseCritiqueAnchors(rawVal) {
  if (!rawVal) return null
  try {
    const obj = typeof rawVal === 'string' ? JSON.parse(rawVal) : rawVal
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.anchors)) return null
    return {
      sections: obj.sections && typeof obj.sections === 'object' ? obj.sections : {},
      anchors: [...obj.anchors],
      coreSections: Array.isArray(obj.coreSections) ? obj.coreSections : [],
      pendingResolved: Number(obj.pendingResolved ?? 0) || 0,
      pendingUnresolved: Number(obj.pendingUnresolved ?? 0) || 0,
      criteriaCount: Number(obj.criteriaCount ?? 0) || 0,
    }
  } catch {
    return null
  }
}

/** 对比基线与当前快照，输出跨轮防退化阻断项（DOC_REGRESSION_*）与结构化 delta。 */
export function checkDocRegression(baselineSnap, currentSnap, baselineSource = null) {
  const curAnchors = currentSnap?.anchors ?? []
  if (!baselineSnap) {
    return {
      errors: [],
      delta: {
        hasBaseline: false,
        baselineSource: null,
        anchorsBefore: 0,
        anchorsAfter: curAnchors.length,
        anchorsAdded: [],
        anchorsRemoved: [],
        pendingResolved: currentSnap?.pendingResolved ?? 0,
        coreSectionsLost: [],
      },
    }
  }

  const baseAnchors = baselineSnap.anchors ?? []
  const baseSet = new Set(baseAnchors)
  const curSet = new Set(curAnchors)
  const anchorsAdded = curAnchors.filter((a) => !baseSet.has(a))
  const anchorsRemoved = baseAnchors.filter((a) => !curSet.has(a))

  const coreSectionsLost = []
  const errors = []

  for (const [id, baseSec] of Object.entries(baselineSnap.sections ?? {})) {
    if (!baseSec?.substantive) continue
    const curSec = currentSnap.sections?.[id]
    if (!curSec || !curSec.present) {
      coreSectionsLost.push(id)
      errors.push({
        code: 'DOC_REGRESSION_CORE_EMPTIED',
        line: 1,
        section: id,
        message: `跨轮退化：基线中已充实的「${id}」章节在当前版本被清空或删除`,
        fixHint: '恢复该核心/设计章节的实质性技术内容，禁止借修订名义删空已确认方案。',
      })
      continue
    }
    if (!curSec.substantive) {
      coreSectionsLost.push(id)
      errors.push({
        code: 'DOC_REGRESSION_CORE_DEGRADED',
        line: 1,
        section: id,
        message: `跨轮退化：基线中已充实的「${id}」章节被改回占位桩或纯套话`,
        fixHint: '保留具体技术方案、模块路径或约束锚点，不得退化为空洞描述。',
      })
      continue
    }
  }

  const resolvedByCount = Math.max(0, (currentSnap.pendingResolved ?? 0) - (baselineSnap.pendingResolved ?? 0))
  const resolvedByClear = Math.max(0, (baselineSnap.pendingUnresolved ?? 0) - (currentSnap.pendingUnresolved ?? 0))

  return {
    errors,
    delta: {
      hasBaseline: true,
      baselineSource,
      anchorsBefore: baseAnchors.length,
      anchorsAfter: curAnchors.length,
      anchorsAdded,
      anchorsRemoved,
      pendingResolved: Math.max(resolvedByCount, resolvedByClear),
      coreSectionsLost,
    },
  }
}

/** 仅在存在 Git 历史与 HEAD 提交时同步读取 `HEAD:<relPath>` 文档，未提交或无提交仓安全返回 null。 */
export function readGitHeadFileSync(repoRoot, relPath) {
  if (!repoRoot || !relPath || !hasDotGitInAncestors(repoRoot)) return null
  const gitDir = resolveGitDirFast(repoRoot)
  if (gitDir) {
    const headInfo = readHeadFast(gitDir)
    if (existsSync(join(gitDir, 'HEAD')) && !headInfo?.oid) return null
  }
  try {
    const inv = prepareExecInvocation('git', ['show', `HEAD:${posixPath(relPath)}`], { cwd: repoRoot })
    return execFileSync(inv.cmd, inv.args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: inv.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 4000,
    })
  } catch {
    return null
  }
}

/** 按优先级解析跨轮基线快照：`baselineText` -> `frontmatter.critique_anchors` -> `HEAD:<relDoc>`。 */
export function resolveBaselineSnapshotSync({ repoRoot, relDoc, fmData = null, baselineText = null }) {
  if (typeof baselineText === 'string' && baselineText.trim()) {
    return { snap: extractDocSnapshot(baselineText), source: 'baseline-text' }
  }
  const critiqueAnchors = parseCritiqueAnchors(fmData?.critique_anchors)
  if (critiqueAnchors) {
    return { snap: critiqueAnchors, source: 'critique-anchors' }
  }
  const headText = readGitHeadFileSync(repoRoot, relDoc)
  if (typeof headText === 'string' && headText.trim()) {
    return { snap: extractDocSnapshot(headText), source: 'git-head' }
  }
  return { snap: null, source: null }
}

function listMdRecursive(dirAbs, rootAbs) {
  const out = []
  if (!existsSync(dirAbs)) return out
  for (const entry of readdirSync(dirAbs, { withFileTypes: true })) {
    const full = join(dirAbs, entry.name)
    if (entry.isDirectory()) out.push(...listMdRecursive(full, rootAbs))
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ rel: posixPath(relative(rootAbs, full)), abs: full })
    }
  }
  return out
}

function resolveRelDocTarget(repoRoot, fromAbs, rawTarget) {
  if (!rawTarget || typeof rawTarget !== 'string') return null
  const s = rawTarget.trim()
  if (!s || /^(?:无|none|null)$/i.test(s)) return null
  return posixPath(relative(repoRoot, resolve(dirname(fromAbs), s)))
}

/** 收集与总控 PRD 绑定的全部生效 SPEC 与已归档实施 SPEC 正文（剔除 superseded/dropped 与无关旧归档）。 */
export function collectMasterPrdSpecTexts(repoRoot, prdRel, prdData = null) {
  const normPrdRel = posixPath(prdRel)
  const prdAbs = join(repoRoot, normPrdRel)
  const prdLinkedSpec = resolveRelDocTarget(repoRoot, prdAbs, prdData?.related_spec)
  const ignoredStatuses = new Set(['superseded', 'dropped'])
  const texts = []

  for (const item of listMdRecursive(join(repoRoot, 'docs', 'specs'), repoRoot)) {
    const text = readTextSafe(item.abs) ?? ''
    const fm = parseDocFrontmatter(text)
    const status = String(fm.data?.status ?? '').toLowerCase()
    if (ignoredStatuses.has(status)) continue
    const specPrd = resolveRelDocTarget(repoRoot, item.abs, fm.data?.related_prd)
    if (!specPrd || specPrd === normPrdRel || (prdLinkedSpec && prdLinkedSpec === item.rel)) {
      texts.push(text)
    }
  }

  for (const item of listMdRecursive(join(repoRoot, 'docs', 'archive', 'specs'), repoRoot)) {
    const text = readTextSafe(item.abs) ?? ''
    const fm = parseDocFrontmatter(text)
    const status = String(fm.data?.status ?? '').toLowerCase()
    if (ignoredStatuses.has(status)) continue
    const specPrd = resolveRelDocTarget(repoRoot, item.abs, fm.data?.related_prd)
    if (specPrd === normPrdRel || (prdLinkedSpec && prdLinkedSpec === item.rel)) {
      texts.push(text)
    }
  }

  return texts
}

/**
 * C19: 1:N 总控 PRD 四态确定性闭环评估。
 *
 * 返回状态：`hold-manual-or-active` | `hold-staged` | `ready-auto-close` | `blocked-unclosed` | `already-archived` | `not-found`。
 */
export function evaluateMasterPrdClosureState(repoRoot, prdRel, {
  currentSpecRel = null,
  currentTodoRel = null,
  includeMasterPrd = false,
} = {}) {
  const empty = {
    applies: false, state: 'not-found', prdRel: prdRel ?? null, isMasterPrd: false,
    archivePrd: false, shouldHold: false, blocked: false,
    otherActiveSlices: [], uncoveredCriteria: [], uncheckedCriteria: [],
  }
  if (!prdRel) return empty
  const normPrdRel = posixPath(prdRel).replace(/^\.\//, '')
  const prdAbs = join(repoRoot, normPrdRel)
  if (normPrdRel.startsWith('docs/archive/prd/') && existsSync(prdAbs)) {
    return {
      ...empty,
      applies: true, state: 'already-archived', prdRel: normPrdRel,
      archivedPrdRel: normPrdRel, isMasterPrd: true, alreadyArchived: true,
    }
  }
  if (!existsSync(prdAbs)) {
    const archivedCandidate = `docs/archive/prd/${basename(normPrdRel)}`
    if (existsSync(join(repoRoot, archivedCandidate))) {
      return {
        ...empty,
        applies: true, state: 'already-archived', prdRel: normPrdRel,
        archivedPrdRel: archivedCandidate, isMasterPrd: true, alreadyArchived: true,
      }
    }
    return { ...empty, prdRel: normPrdRel }
  }

  const normCurSpec = currentSpecRel ? posixPath(currentSpecRel).replace(/^\.\//, '') : null
  const normCurTodo = currentTodoRel ? posixPath(currentTodoRel).replace(/^\.\//, '') : null
  const prdRaw = readTextSafe(prdAbs) ?? ''
  const fm = parseDocFrontmatter(prdRaw)
  const archivePolicy = String(fm.data?.archive_policy ?? '').trim().toLowerCase()
  const prdLinkedSpec = resolveRelDocTarget(repoRoot, prdAbs, fm.data?.related_spec)

  const otherActiveSlices = []
  for (const item of listMdRecursive(join(repoRoot, 'docs', 'specs'), repoRoot)) {
    if (normCurSpec && item.rel === normCurSpec) continue
    const sFm = parseDocFrontmatter(readTextSafe(item.abs) ?? '')
    const status = String(sFm.data?.status ?? '').toLowerCase()
    if (status === 'superseded' || status === 'dropped') continue
    const linkedPrd = resolveRelDocTarget(repoRoot, item.abs, sFm.data?.related_prd)
    if (linkedPrd === normPrdRel || (prdLinkedSpec && prdLinkedSpec === item.rel)) {
      otherActiveSlices.push(item.rel)
    }
  }
  for (const item of listMdRecursive(join(repoRoot, 'docs', 'todo'), repoRoot)) {
    if (normCurTodo && item.rel === normCurTodo) continue
    const tFm = parseDocFrontmatter(readTextSafe(item.abs) ?? '')
    const status = String(tFm.data?.status ?? '').toLowerCase()
    if (status === 'done' || status === 'archived' || status === 'dropped') continue
    const linkedSpec = resolveRelDocTarget(repoRoot, item.abs, tFm.data?.related_spec)
    if (normCurSpec && linkedSpec === normCurSpec) continue
    const linkedPrd = resolveRelDocTarget(repoRoot, item.abs, tFm.data?.related_prd)
    if (linkedPrd === normPrdRel) otherActiveSlices.push(item.rel)
  }

  let archivedSiblings = 0
  for (const item of listMdRecursive(join(repoRoot, 'docs', 'archive', 'specs'), repoRoot)) {
    if (normCurSpec && item.rel === normCurSpec) continue
    const sFm = parseDocFrontmatter(readTextSafe(item.abs) ?? '')
    const linkedPrd = resolveRelDocTarget(repoRoot, item.abs, sFm.data?.related_prd)
    if (linkedPrd === normPrdRel || (prdLinkedSpec && prdLinkedSpec === item.rel)) archivedSiblings += 1
  }

  const prdCriteria = []
  let inFence = false
  for (const line of prdRaw.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = /^- \[([ xX])\]\s+(C\d+)\b([^\n]*)/.exec(line)
    if (m) prdCriteria.push({ id: m[2], checked: m[1].toLowerCase() === 'x', text: line.trim() })
  }
  const prdIds = [...new Set(prdCriteria.map((c) => c.id))]
  const uncheckedCriteria = prdCriteria.filter((c) => !c.checked).map((c) => c.text)
  const specTexts = collectMasterPrdSpecTexts(repoRoot, normPrdRel, fm.data)
  const uncoveredCriteria = prdIds.filter((id) => {
    const re = new RegExp(`\\b${id}(?![0-9])`)
    return !specTexts.some((txt) => re.test(txt))
  })
  const isMasterPrd = fm.data?.multi_spec === true
    || archivePolicy === 'manual'
    || otherActiveSlices.length > 0
    || archivedSiblings > 0
    || ((fm.data?.related_spec === null || fm.data?.related_spec === undefined) && prdIds.length > 0)

  const base = {
    applies: true,
    prdRel: normPrdRel,
    isMasterPrd,
    archivePolicy: archivePolicy || null,
    otherActiveSlices,
    uncoveredCriteria,
    uncheckedCriteria,
  }
  if (!includeMasterPrd && (archivePolicy === 'manual' || otherActiveSlices.length > 0)) {
    return { ...base, state: 'hold-manual-or-active', archivePrd: false, shouldHold: true, blocked: false }
  }
  if (!includeMasterPrd && uncoveredCriteria.length > 0) {
    return { ...base, state: 'hold-staged', archivePrd: false, shouldHold: true, blocked: false }
  }
  if (uncheckedCriteria.length > 0) {
    return {
      ...base,
      state: 'blocked-unclosed',
      code: 'BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED',
      archivePrd: false,
      shouldHold: false,
      blocked: true,
    }
  }
  return { ...base, state: 'ready-auto-close', archivePrd: true, shouldHold: false, blocked: false }
}
