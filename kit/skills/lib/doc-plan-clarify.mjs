/**
 * doc-plan-clarify.mjs —— Working Brief pre-init 注入与 `doc-plan clarify`（含冻结守卫与 `--drop-criterion`）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/）。
 */

import { existsSync } from 'node:fs'
import { relative, resolve } from 'node:path'

import { EXIT } from './exit-codes.mjs'
import {
  DOC_FRONTMATTER_KEY_ORDER, docIsoDate, parseDocFilename,
  parseDocFrontmatter, updateDocFrontmatter,
} from './docs.mjs'
import { posixPath, readTextSafe, writeAtomic } from './git.mjs'
import { evaluateMutability } from './mutability.mjs'
import { DECIDED_RE, RISK_NON_DECISION_HEADING_RE } from './pending-decisions.mjs'

const CLARIFY_PENDING_HEADING_RE = /^#{2,4}\s*(?:[一二三四五六七八九十百]+[、.]\s*)?([^\n]*)$/
const CLARIFY_PENDING_WORDS_RE = /(?:待拍板|未决问题|待确认|待决定|开放问题|待定事项|仍待.*?拍板|open\s+questions?|pending\s+decisions?)/i
const CLARIFY_EMPTY_ITEM_RE = /^(?:\s*(?:[-*]\s*)?(?:待确认|待拍板|未决)\s*[:：]\s*)?(?:无|没有|暂无|无待拍板(?:事项|问题)?|无待定(?:事项|问题)?|无未决(?:事项|问题)?|none|n\/a)(?:$|[。.,，；;：:\s])/i
const CLARIFY_INLINE_UNRESOLVED_RE = /(?:仍待定|（待拍板[^）]*）|\(待拍板[^)]*\)|（待定[^）]*）|\(待定[^)]*\)|待拍板\s*[:：]\s*(?!(?:无|没有|暂无)(?=$|[\s，,。.；;）)])|none\b)|待确认\s*[:：]\s*(?!(?:无|没有|暂无)(?=$|[\s，,。.；;）)])|none\b)|\bTBD\b)/i

function normPendingMatchText(s) {
  return String(s ?? '')
    .replace(/^(?:[-*]|\d+[.、)])\s+/, '')
    .replace(/^(?:待确认|待拍板|未决|待决定|Q\d+)\s*[:：]\s*/i, '')
    .replace(/(?:（|\()待(?:拍板|定)[^）)]*(?:）|\))/g, '')
    .replace(/\bTBD\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function scrubUnresolvedMarkers(line) {
  return String(line ?? '')
    .replace(/(?:待确认|待拍板|未决|待决定)\s*[:：]\s*/gi, '已确认：')
    .replace(/(?:（|\()待(?:拍板|定)[^）)]*(?:）|\))/g, '')
    .replace(/仍待定/g, '已定')
    .replace(/\bTBD\b/gi, '已定')
}

function appendClarifyEntries(lines, entries = []) {
  const clean = entries.filter(Boolean)
  if (clean.length === 0) return
  const secIdx = lines.findIndex((l) => /^##\s+澄清与补充记录(?:\s|$)/.test(l))
  if (secIdx >= 0) {
    let endIdx = lines.length
    for (let i = secIdx + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) { endIdx = i; break }
    }
    const existingBody = lines.slice(secIdx + 1, endIdx)
      .filter((l) => !/^\s*-\s*（本轮无额外澄清补充/.test(l))
    while (existingBody.length > 0 && !existingBody[existingBody.length - 1].trim()) existingBody.pop()
    while (existingBody.length > 0 && !existingBody[0].trim()) existingBody.shift()
    const nextBody = existingBody.length > 0 ? ['', ...existingBody, ...clean, ''] : ['', ...clean, '']
    lines.splice(secIdx + 1, endIdx - secIdx - 1, ...nextBody)
    return
  }
  const anchorIdx = lines.findIndex((l) => /^##\s+(?:实现说明|完成后的记录|待拍板问题)/.test(l))
  const insertBlock = ['## 澄清与补充记录', '', ...clean, '']
  if (anchorIdx >= 0) lines.splice(anchorIdx, 0, ...insertBlock)
  else {
    while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
    lines.push('', ...insertBlock)
  }
}

export function resolvePendingSectionItems(lines, { question, decision, today, byNote }) {
  const cleanDecision = String(decision ?? '').trim()
  const qNorm = normPendingMatchText(question)
  const blocks = []
  const covered = new Set()

  for (let i = 0; i < lines.length; i += 1) {
    const h = CLARIFY_PENDING_HEADING_RE.exec(lines[i])
    if (!h || !CLARIFY_PENDING_WORDS_RE.test(h[1])) continue
    if (RISK_NON_DECISION_HEADING_RE.test(h[1]) && !/(?:待拍板|待确认|待决定|未决问题|pending\s+decisions?)/i.test(h[1])) continue
    const startLevel = (lines[i].match(/^#+/) ?? ['##'])[0].length
    let endIdx = lines.length
    for (let j = i + 1; j < lines.length; j += 1) {
      const m = /^(#+)\s/.exec(lines[j])
      if (m && m[1].length <= startLevel) { endIdx = j; break }
    }
    for (let k = i; k < endIdx; k += 1) covered.add(k)
    const body = lines.slice(i + 1, endIdx)
    const hasList = body.some((l) => /^(?:[-*]|\d+[.、)])\s+/.test(l))
    let cur = null
    for (let off = 0; off < body.length; off += 1) {
      const l = body[off]
      const absIdx = i + 1 + off
      if (/^\s*(?:>|<!--)/.test(l)) continue
      if (/^(?:[-*]|\d+[.、)])\s+/.test(l)) {
        if (cur) blocks.push(cur)
        cur = { start: absIdx, end: absIdx + 1, head: l.replace(/^(?:[-*]|\d+[.、)])\s+/, ''), text: l }
        continue
      }
      if (cur) { cur.end = absIdx + 1; cur.text += `\n${l}` }
      else if (!hasList && l.trim()) {
        cur = { start: absIdx, end: absIdx + 1, head: l.trim(), text: l }
      }
    }
    if (cur) blocks.push(cur)
  }

  const unresolvedBlocks = blocks.filter((b) => {
    const cleanHead = b.head.replace(/^[-*]\s*/, '')
    if (CLARIFY_EMPTY_ITEM_RE.test(cleanHead) && !CLARIFY_INLINE_UNRESOLVED_RE.test(b.text)) return false
    if (DECIDED_RE.test(b.text) && !CLARIFY_INLINE_UNRESOLVED_RE.test(b.text)) return false
    return true
  })

  const matchesQ = (candText) => {
    if (!qNorm) return false
    const cNorm = normPendingMatchText(candText)
    if (!cNorm) return false
    if (cNorm === qNorm || cNorm.includes(qNorm) || (cNorm.length >= 3 && qNorm.includes(cNorm))) return true
    const qTokens = qNorm.split(/[\s、，,。；;：:（）()[\]/]+/).filter((t) => t.length >= 2)
    return qTokens.length > 0 && qTokens.filter((t) => cNorm.includes(t)).length >= Math.ceil(qTokens.length * 0.6)
  }

  const matchedBlocks = qNorm
    ? unresolvedBlocks.filter((b) => matchesQ(b.head) || matchesQ(b.text))
    : (unresolvedBlocks.length === 1 ? [unresolvedBlocks[0]] : [])

  let resolvedCount = 0
  for (const b of matchedBlocks) {
    for (let k = b.start; k < b.end; k += 1) lines[k] = scrubUnresolvedMarkers(lines[k])
    const first = lines[b.start]
    const prefixM = /^(\s*(?:[-*]|\d+[.、)])\s+)/.exec(first)
    const rest = prefixM ? first.slice(prefixM[1].length) : first.trimStart()
    const cleanRest = rest.replace(/^已确认\s*[:：]\s*/i, '').trim()
    const hasDecision = cleanDecision && cleanRest.includes(cleanDecision)
    const suffix = hasDecision ? `（${today}${byNote}）` : `（已定：${cleanDecision}，${today}${byNote}）`
    lines[b.start] = `${prefixM ? prefixM[1] : ''}已确认：${cleanRest}${suffix}`
    resolvedCount += 1
  }

  if (resolvedCount === 0) {
    const inlineIdx = []
    let inFence = false
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*(?:```|~~~)/.test(lines[i])) { inFence = !inFence; continue }
      if (inFence || covered.has(i)) continue
      const trimmed = lines[i].trim()
      if (!trimmed || /^\s*(?:>|<!--)/.test(trimmed) || /^---+$/.test(trimmed)) continue
      if (DECIDED_RE.test(trimmed) && !CLARIFY_INLINE_UNRESOLVED_RE.test(trimmed)) continue
      if (CLARIFY_INLINE_UNRESOLVED_RE.test(trimmed)) inlineIdx.push(i)
    }
    const targets = qNorm ? inlineIdx.filter((idx) => matchesQ(lines[idx])) : (inlineIdx.length === 1 ? inlineIdx : [])
    for (const idx of targets) {
      const scrubbed = scrubUnresolvedMarkers(lines[idx])
      lines[idx] = DECIDED_RE.test(scrubbed)
        ? `${scrubbed.trimEnd()}（已定：${cleanDecision}）`
        : `${scrubbed.trimEnd()}（已确认：${cleanDecision}）`
      resolvedCount += 1
    }
  }
  return resolvedCount
}

/** 将 v2 Working Brief 注入新建规划文档（`includeOpen=false` 时仅在主文档写待拍板，避免多文档重复阻塞）。 */
export function applyPreInitToDocContent(content, preInit, kind, today, { includeOpen = true } = {}) {
  if (!preInit || kind === 'tdd') return content
  let text = String(content ?? '').replace(/\r\n/g, '\n')

  const factEntries = Object.entries(preInit.facts ?? {}).map(([k, v]) => `- 已定事实（${today} · pre-init）：${k} = ${v}`)
  const decisionEntries = Array.isArray(preInit.decisions)
    ? preInit.decisions.map((d) => `- 已确认（${today} · pre-init）：${d}`)
    : []
  const clarifyEntries = [...factEntries, ...decisionEntries]
  if (clarifyEntries.length > 0) {
    const lines = text.split('\n')
    appendClarifyEntries(lines, clarifyEntries)
    text = lines.join('\n')
  }

  const nonGoals = Array.isArray(preInit.nonGoals) && preInit.nonGoals.length > 0
    ? preInit.nonGoals
    : (Array.isArray(preInit.exclusions) ? preInit.exclusions : [])
  if (nonGoals.length > 0) {
    const joined = nonGoals.join('；')
    if (/^- \*\*(?:本期不做|明确不做|非目标)\*\*\s*[:：]/m.test(text)) {
      text = text.replace(/^(- \*\*(?:本期不做|明确不做|非目标)\*\*\s*[:：]\s*)(.*)$/m, (_, p, cur) => {
        const cleanCur = cur.trim()
        const isPlaceholder = !cleanCur || /^(?:<[^>]+>|<!--[\s\S]*?-->|无|none)$/i.test(cleanCur)
        return `${p}${isPlaceholder ? joined : `${cleanCur}；${joined}`}`
      })
    } else if (/^###\s*明确不做（Non-Goals）/m.test(text)) {
      text = text.replace(/(^###\s*明确不做（Non-Goals）[^\n]*\n+)([\s\S]*?)(?=^#{2,3}\s|<!-- \/section|$)/m, (_, hdr, body) => {
        const cleanBody = body.replace(/^-\s*<[^>]+>\s*\n?/gm, '').trim()
        const bullets = nonGoals.map((e) => `- ${e}`).join('\n')
        return `${hdr}${cleanBody ? `${cleanBody}\n${bullets}` : bullets}\n\n`
      })
    }
  }

  if (Array.isArray(preInit.anchors) && preInit.anchors.length > 0) {
    const formatted = preInit.anchors.map((a) => (a.includes('`') ? a : `\`${a}\``)).join('、')
    if (/^- \*\*(?:影响路径|要改什么)\*\*\s*[:：]/m.test(text)) {
      text = text.replace(/^(- \*\*(?:影响路径|要改什么)\*\*\s*[:：]\s*)(.*)$/m, (_, p, cur) => {
        const cleanCur = cur.trim()
        const isPlaceholder = !cleanCur || /^(?:<[^>]+>|<!--[\s\S]*?-->|待补齐)$/i.test(cleanCur)
        return `${p}${isPlaceholder ? formatted : `${cleanCur}、${formatted}`}`
      })
    } else if (/^###\s*本次要做（In Scope）/m.test(text)) {
      text = text.replace(/(^###\s*本次要做（In Scope）[^\n]*\n+)([\s\S]*?)(?=^#{2,3}\s|<!-- \/section|$)/m, (_, hdr, body) => {
        const cleanBody = body.trim()
        return `${hdr}${cleanBody ? `${cleanBody}\n` : ''}- 讨论锚点：${formatted}\n\n`
      })
    }
  }

  const unresolved = Array.isArray(preInit.unresolvedOpen)
    ? preInit.unresolvedOpen.map((o) => o.text)
    : (Array.isArray(preInit.openQuestions) ? preInit.openQuestions : [])
  if (includeOpen && unresolved.length > 0) {
    const qLines = unresolved.map((q) => `- 待确认：${q}`).join('\n')
    if (/^##\s+(?:[一二三四五六七八九十\d]+[、.]\s*)?待拍板问题/m.test(text)) {
      text = text.replace(/(^##\s+(?:[一二三四五六七八九十\d]+[、.]\s*)?待拍板问题[^\n]*\n+)([\s\S]*?)(?=^##\s|<!-- \/section|$)/m, (_, hdr, body) => {
        const cleaned = body.replace(/^\s*-\s*待确认\s*[:：]\s*无\s*\n?/gm, '').trimEnd()
        return `${hdr}${cleaned ? `${cleaned}\n` : ''}${qLines}\n\n`
      })
    } else if (/^-\s*\*\*待拍板事项\*\*\s*[:：]/m.test(text)) {
      text = text.replace(/^-\s*\*\*待拍板事项\*\*\s*[:：]\s*无\s*$/m, `- **待拍板事项**：\n${qLines}`)
    } else if (/^##\s+澄清与补充记录/m.test(text)) {
      text = text.replace(/^##\s+澄清与补充记录/m, `## 待拍板问题\n\n${qLines}\n\n## 澄清与补充记录`)
    }
  }

  return text.endsWith('\n') ? text : `${text}\n`
}

function detectKindFromPath(relFile, fmData) {
  const explicit = String(fmData?.kind ?? '').trim().toLowerCase()
  if (['prd', 'spec', 'todo', 'tdd'].includes(explicit)) return explicit
  const byName = parseDocFilename(relFile)?.kind
  if (byName) return byName
  if (/(?:^|\/)prd\//.test(relFile)) return 'prd'
  if (/(?:^|\/)todo\//.test(relFile)) return 'todo'
  return 'spec'
}

/** 向规划文档追加已拍板澄清记录，接入 `OPEN/LOCKED` 冻结守卫并支持 `--drop-criterion` 安全裁剪。 */
export function clarifyDoc({
  repoRoot, file, question = '', decision = '', by = 'user', explicitBy = undefined,
  criterion = '', dropCriterion = '', reason = '',
}) {
  if (!file) throw new Error('clarify 需要 --file <docPath>')
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到文档：${file}`)
  const raw = readTextSafe(abs)
  if (raw === undefined) throw new Error(`无法读取文本文件：${file}`)

  const norm = raw.replace(/\r\n/g, '\n')
  const relFile = posixPath(relative(repoRoot, abs))
  const fmCheck = parseDocFrontmatter(norm)
  const docKind = detectKindFromPath(relFile, fmCheck.data)
  const mut = evaluateMutability({
    kind: docKind,
    status: fmCheck.data?.status ?? null,
    approved: fmCheck.data?.approved ?? null,
    file: relFile,
  })
  const today = docIsoDate()

  if (dropCriterion && String(dropCriterion).trim()) {
    const actor = String(explicitBy ?? '').trim().toLowerCase()
    if (actor !== 'user') {
      throw Object.assign(
        new Error('BLOCKED_INTERACTIVE_CLARIFY_USER_REQUIRED: --drop-criterion 必须由人类显式授权并传入 --by user。'),
        { code: 'BLOCKED_INTERACTIVE_CLARIFY_USER_REQUIRED', exitCode: EXIT.USAGE },
      )
    }
    if (!reason || !String(reason).trim()) {
      throw Object.assign(
        new Error('MISSING_DROP_REASON: --drop-criterion 必须附带 --reason "<删减原因>"。'),
        { code: 'MISSING_DROP_REASON', exitCode: EXIT.USAGE },
      )
    }
    if (mut.terminal) {
      throw Object.assign(
        new Error(`BLOCKED_DOC_FROZEN: ${relFile} ${mut.reason}，终态文档禁止再裁剪条款。`),
        { code: 'BLOCKED_DOC_FROZEN', exitCode: EXIT.FACT, details: { safeExits: mut.safeExits } },
      )
    }
    const targetCid = String(dropCriterion).trim().toUpperCase()
    if (!/^C\d+$/.test(targetCid)) {
      throw Object.assign(new Error(`--drop-criterion 需要 C<N> 编号，收到：${dropCriterion}`), { exitCode: EXIT.USAGE })
    }
    const lines = norm.split('\n')
    const critRegex = new RegExp(`^- \\[[ xX]\\]\\s+${targetCid}\\b`)
    const critIdx = lines.findIndex((l) => critRegex.test(l))
    if (critIdx < 0) {
      throw Object.assign(new Error(`在 ${relFile} 中未找到验收条款 ${targetCid}`), { exitCode: EXIT.USAGE })
    }
    const removedLine = lines[critIdx]
    lines.splice(critIdx, 1)
    const entry = `- 已作废条款（${today} · ${String(by).trim() || 'user'}）：${targetCid} — ${String(reason).trim()}`
    appendClarifyEntries(lines, [entry])
    let updatedText = lines.join('\n')
    if (!updatedText.endsWith('\n')) updatedText += '\n'
    writeAtomic(abs, updatedText)
    if (fmCheck.hasFrontmatter) {
      const prevDropped = Array.isArray(fmCheck.data?.dropped_criteria) ? fmCheck.data.dropped_criteria.map((x) => String(x).toUpperCase()) : []
      const nextDropped = prevDropped.includes(targetCid) ? prevDropped : [...prevDropped, targetCid]
      updateDocFrontmatter(abs, { updated: today, dropped_criteria: nextDropped }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fmCheck.data.kind ?? docKind] ?? [] })
    }
    return {
      file: relFile,
      entry,
      droppedCriterion: { id: targetCid, removedLine, reason: String(reason).trim() },
      addedCriterion: null,
      resolvedPendingCount: 0,
      updated: today,
    }
  }

  if (!decision || !String(decision).trim()) {
    throw new Error('clarify 需要 --file <docPath> 与 --decision "<已确认结论>"')
  }
  if (!mut.mutable) {
    const exitLines = mut.safeExits.map((e, i) => `  ${i + 1}. [${e.action}] ${e.command} —— ${e.description}`).join('\n')
    throw Object.assign(
      new Error(`BLOCKED_DOC_FROZEN: ${relFile} ${mut.reason}，禁止直接 clarify 修改。\n安全出口：\n${exitLines}`),
      { code: 'BLOCKED_DOC_FROZEN', exitCode: EXIT.FACT, details: { mutability: mut.mutability, safeExits: mut.safeExits } },
    )
  }
  if (String(fmCheck.data?.plan_mode ?? '').trim().toLowerCase() === 'interactive') {
    const actor = String(explicitBy ?? '').trim().toLowerCase()
    if (actor !== 'user') {
      throw Object.assign(
        new Error('BLOCKED_INTERACTIVE_CLARIFY_USER_REQUIRED: plan_mode=interactive 的澄清确认必须显式传入 --by user，禁止代理自答。'),
        { code: 'BLOCKED_INTERACTIVE_CLARIFY_USER_REQUIRED', exitCode: EXIT.USAGE },
      )
    }
  }

  const byNote = by && String(by).trim() ? ` · ${String(by).trim()}` : ''
  const qText = question && String(question).trim() ? `${String(question).trim()} -> ` : ''
  const entry = `- 已确认（${today}${byNote}）：${qText}${String(decision).trim()}`
  const lines = norm.split('\n')
  const resolvedPendingCount = resolvePendingSectionItems(lines, { question, decision, today, byNote })
  appendClarifyEntries(lines, [entry])
  let updatedText = lines.join('\n')
  if (!updatedText.endsWith('\n')) updatedText += '\n'

  let addedCriterion = null
  if (criterion && String(criterion).trim()) {
    let maxN = 0
    for (const cm of updatedText.matchAll(/^- \[[ xX]\] C(\d+)\b/gm)) {
      const n = Number(cm[1])
      if (n > maxN) maxN = n
    }
    const nextId = `C${maxN + 1}`
    const critLine = `- [ ] ${nextId}: ${String(criterion).trim()}`
    addedCriterion = { id: nextId, line: critLine }
    const cLines = updatedText.split('\n')
    let lastCritIdx = -1
    for (let i = 0; i < cLines.length; i += 1) {
      if (/^- \[[ xX]\] C\d+\b/.test(cLines[i])) lastCritIdx = i
    }
    if (lastCritIdx >= 0) cLines.splice(lastCritIdx + 1, 0, critLine)
    else cLines.push(critLine)
    updatedText = cLines.join('\n')
  }

  writeAtomic(abs, updatedText)
  const fm = parseDocFrontmatter(updatedText)
  if (fm.hasFrontmatter) {
    updateDocFrontmatter(abs, { updated: today }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docKind] ?? [] })
  }
  return { file: relFile, entry, addedCriterion, droppedCriterion: null, resolvedPendingCount, updated: today }
}
