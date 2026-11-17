/**
 * doc-frontmatter.mjs —— 工程文档 YAML Frontmatter 零依赖解析、序列化与原子更新。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 docs.mjs 汇总重导出。
 */

import { readTextSafe, writeAtomic } from './git.mjs'

function splitInlineArrayItems(inner) {
  const items = []
  let cur = ''
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        cur += ch + inner[i + 1]
        i += 1
        continue
      }
      if (ch === quote) {
        if (quote === '\'' && inner[i + 1] === '\'') {
          cur += '\'\''
          i += 1
          continue
        }
        quote = null
      }
      cur += ch
    } else if (ch === '"' || ch === '\'') {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      if (cur.trim()) items.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) items.push(cur.trim())
  return items
}

function parseYamlScalar(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (s.startsWith('\'') && s.endsWith('\'') && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, '\'')
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitInlineArrayItems(inner).map((item) => parseYamlScalar(item))
  }
  return s
}

function formatYamlScalar(val) {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'boolean' || typeof val === 'number') return String(val)
  if (Array.isArray(val)) {
    return `[${val.map((item) => formatYamlScalar(item)).join(', ')}]`
  }
  const s = String(val)
  const needsQuote = s === ''
    || /^\s|\s$/.test(s)
    || /^(?:true|false|null|~)$/i.test(s)
    || /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)
    || /[\n\r"':#\[\]{},&*!|>@`]/.test(s)
    || s.startsWith('- ')
  if (!needsQuote) return s
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

/** 零依赖解析文档头部 YAML Frontmatter，兼容旧式列表元数据。 */
export function parseDocFrontmatter(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  if (norm.startsWith('---\n') || norm === '---') {
    const fmMatch = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(norm)
      ?? /^---\n---(?:\n([\s\S]*))?$/.exec(norm)
    if (!fmMatch) {
      return {
        hasFrontmatter: false, malformedFrontmatter: true, data: {}, keyOrder: [],
        body: norm, legacy: false, syntaxErrors: ['Frontmatter 缺少闭合的 `---` 分隔行'],
      }
    }
    const fmRaw = fmMatch.length === 3 ? fmMatch[1] : ''
    const body = fmMatch.length === 3 ? (fmMatch[2] ?? '') : (fmMatch[1] ?? '')
    const data = {}
    const keyOrder = []
    const syntaxErrors = []
    const fmLines = fmRaw ? fmRaw.split('\n') : []
    for (let i = 0; i < fmLines.length; i += 1) {
      const rawLine = fmLines[i]
      if (!rawLine.trim() || /^\s*#/.test(rawLine)) continue
      const kv = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(rawLine)
      if (!kv) {
        syntaxErrors.push(`Frontmatter 第 ${i + 2} 行格式无效：${rawLine}`)
        continue
      }
      const key = kv[1]
      const tail = kv[2].trim()
      if (!keyOrder.includes(key)) keyOrder.push(key)
      if (!tail) {
        const blockItems = []
        let j = i + 1
        while (j < fmLines.length && /^\s+-\s+(.*)$/.test(fmLines[j])) {
          blockItems.push(parseYamlScalar(/^\s+-\s+(.*)$/.exec(fmLines[j])[1]))
          j += 1
        }
        if (blockItems.length > 0) {
          data[key] = blockItems
          i = j - 1
        } else {
          data[key] = null
        }
      } else {
        data[key] = parseYamlScalar(tail)
      }
    }
    return {
      hasFrontmatter: true,
      malformedFrontmatter: syntaxErrors.length > 0,
      data, keyOrder, body, legacy: false, syntaxErrors,
    }
  }

  const headerChunk = norm.split(/\n##\s+/)[0]
  const data = {}
  const keyOrder = []
  const pushField = (k, v) => {
    if (v === undefined) return
    if (!keyOrder.includes(k)) keyOrder.push(k)
    data[k] = v
  }
  const titleMatch = /^#\s+(.+)$/m.exec(headerChunk)
  if (titleMatch) pushField('title', titleMatch[1].replace(/^(?:PRD|SPEC|Todo)\s*[:：]\s*/i, '').trim())
  const statusMatch = /^(?:>\s*\*\*状态\*\*\s*[:：]|-\s*\*\*状态\*\*\s*[:：]|(?:-\s+)?Status\s*:)\s*`?([A-Za-z0-9_-]+)`?/mi.exec(headerChunk)
  if (statusMatch) pushField('status', statusMatch[1].toLowerCase())
  const critiqueMatch = /^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(headerChunk)
  if (critiqueMatch) pushField('plan_critique', critiqueMatch[1].trim())
  const createdMatch = /^(?:-\s+)?(?:Created|Date):\s*([0-9-]+)/mi.exec(headerChunk)
  if (createdMatch) pushField('created', createdMatch[1].trim())
  const plannedMatch = /^(?:-\s+)?(?:\*\*)?Planned at(?:\*\*)?[:：]\s*`?([^`\n]+)`?/mi.exec(headerChunk)
  if (plannedMatch) pushField('planned_at', plannedMatch[1].trim())
  const ownerMatch = /^(?:-\s+)?(?:\*\*)?(?:Owner|提出方)(?:\*\*)?[:：]\s*(.+)$/mi.exec(headerChunk)
  if (ownerMatch) pushField('owner', ownerMatch[1].trim())
  const relSpecMatch = /^(?:-\s+)?Related SPEC:\s*(.+)$/mi.exec(headerChunk)
  if (relSpecMatch && !/^(?:无|none)$/i.test(relSpecMatch[1].trim())) pushField('related_spec', relSpecMatch[1].trim())
  const relPrdMatch = /^(?:-\s+)?Related PRD:\s*(.+)$/mi.exec(headerChunk)
  if (relPrdMatch && !/^(?:无|none)$/i.test(relPrdMatch[1].trim())) pushField('related_prd', relPrdMatch[1].trim())

  return {
    hasFrontmatter: false, malformedFrontmatter: false,
    data, keyOrder, body: norm, legacy: true, syntaxErrors: [],
  }
}

/** 将结构化 Frontmatter 键按顺序序列化为干净 YAML `--- ... ---` 块。 */
export function serializeDocFrontmatter(data, keyOrder = []) {
  const ordered = []
  const seen = new Set()
  for (const k of keyOrder) {
    if (!seen.has(k) && Object.prototype.hasOwnProperty.call(data, k) && data[k] !== undefined) {
      seen.add(k)
      ordered.push(k)
    }
  }
  for (const k of Object.keys(data ?? {})) {
    if (!seen.has(k) && data[k] !== undefined) {
      seen.add(k)
      ordered.push(k)
    }
  }
  const lines = ['---']
  for (const k of ordered) lines.push(`${k}: ${formatYamlScalar(data[k])}`)
  lines.push('---')
  return `${lines.join('\n')}\n`
}

/** 原位更新或补齐文档 YAML Frontmatter 字段并原子写回。 */
export function updateDocFrontmatter(filePath, patch = {}, { defaultKeyOrder = [] } = {}) {
  const raw = readTextSafe(filePath)
  if (raw === undefined) throw new Error(`无法读取文档文件：${filePath}`)
  const parsed = parseDocFrontmatter(raw)
  const merged = { ...parsed.data }
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v !== undefined) merged[k] = v
  }
  const keyOrder = [...defaultKeyOrder, ...parsed.keyOrder, ...Object.keys(merged)]
  const cleanBody = parsed.body.replace(/^\n+/, '')
  const nextText = `${serializeDocFrontmatter(merged, keyOrder)}\n${cleanBody.endsWith('\n') ? cleanBody : `${cleanBody}\n`}`
  writeAtomic(filePath, nextText)
  return { file: filePath, data: merged }
}
