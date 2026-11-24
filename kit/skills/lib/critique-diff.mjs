/**
 * critique-diff.mjs —— 规划 Critique 严重度分级、轮次防跳锁、R2+ 正文快照行级 diff 与条目级闭环纯计算。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 critique-rounds.mjs 以控制单文件 <= 800 行。
 */

import { stripCritiqueMeta } from './docs.mjs'
import { EXIT } from './exit-codes.mjs'

const SEVERITY_PREFIX_RE = /^\s*(?:\[(blocker|major|minor|should-fix|nit)\]|(blocker|major|minor|should-fix|nit)\s*[:：])\s*(.+)$/i
const CHINESE_NUM_MAP = Object.freeze({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 })
const LINE_BUFFER = 3

/** 归一化意见文本用于条目比对与去重。 */
export function normCritItemText(item) {
  return String(typeof item === 'string' ? item : (item?.text ?? item?.summary ?? item?.id ?? ''))
    .replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 从意见文本中解析严重度标签（支持 `[blocker]` / `[major]` / `[minor]` 等前缀）。 */
export function parseFindingSeverity(rawText, defaultSeverity = 'major') {
  const raw = String(rawText ?? '').trim()
  const m = SEVERITY_PREFIX_RE.exec(raw)
  if (!m) {
    return { severity: defaultSeverity, explicit: false, text: raw, raw }
  }
  const tag = (m[1] || m[2] || '').toLowerCase()
  const normSev = (tag === 'minor' || tag === 'should-fix' || tag === 'nit') ? 'minor' : tag
  return { severity: normSev, explicit: true, text: m[3].trim(), raw }
}

/** 判定是否属于阻断级严重度（`blocker` / `major`）。 */
export function isBlockingSeverity(severity) {
  return severity === 'blocker' || severity === 'major'
}

/** 批量分级意见条目，区分阻断项与非阻断 minor/should-fix 项。 */
export function classifyCritiqueFindings(rawItems = [], { defaultSeverity = 'major' } = {}) {
  const parsed = []
  for (const item of Array.isArray(rawItems) ? rawItems : [rawItems]) {
    const s = String(item ?? '').trim()
    if (!s) continue
    parsed.push(parseFindingSeverity(s, defaultSeverity))
  }
  const blocking = parsed.filter((p) => isBlockingSeverity(p.severity))
  const minor = parsed.filter((p) => !isBlockingSeverity(p.severity))
  return {
    parsed,
    blocking,
    minor,
    onlyMinor: parsed.length > 0 && blocking.length === 0,
  }
}

/** 防跳轮校验：显式 `--round` 必须为正整数且不得超过 `maxRound + 1`。 */
export function validateRoundContinuity(priorRounds = [], requestedRound = null) {
  const maxRound = (Array.isArray(priorRounds) ? priorRounds : [])
    .reduce((m, r) => Math.max(m, Number(r?.round) || 0), 0)
  if (requestedRound === null || requestedRound === undefined || requestedRound === '') {
    return { blocked: false, maxRound, effectiveRound: maxRound + 1 }
  }
  const num = Number(requestedRound)
  if (!Number.isInteger(num) || num < 1 || num > maxRound + 1) {
    return {
      blocked: true,
      code: 'BLOCKED_CRITIQUE_ROUND_GAP',
      exitCode: EXIT.FACT,
      maxRound,
      requestedRound,
      message: `BLOCKED_CRITIQUE_ROUND_GAP: 当前最大已完成轮次为 Round ${maxRound}，传入 --round ${requestedRound} 非法或存在跳轮（允许下一轮次 <= ${maxRound + 1}）。`,
    }
  }
  return { blocked: false, maxRound, effectiveRound: num }
}

/** 提取去除易变元信息后的规范正文行数组，用作 R2+ 快照对比基准。 */
export function buildCritiqueTextSnapshot(rawText) {
  return stripCritiqueMeta(String(rawText ?? '')).replace(/\r\n/g, '\n').split('\n')
}

function parseHeadingAliases(title) {
  const clean = String(title ?? '').trim()
  const aliases = new Set()
  if (!clean) return aliases
  aliases.add(clean.toLowerCase())
  const stripped = clean.replace(/^(?:[一二三四五六七八九十]+|\d+)[、.\s]+/, '').trim()
  if (stripped && stripped.length >= 2) aliases.add(stripped.toLowerCase())
  for (const part of stripped.split(/[、，,/|（(）)\s]+/)) {
    const tok = part.trim().toLowerCase()
    if (tok.length >= 2 && !/^(?:和|与|及|的|了|中|等)$/.test(tok)) aliases.add(tok)
  }
  const chM = /^([一二三四五六七八九十]+)[、.]/.exec(clean)
  if (chM) {
    const chNum = CHINESE_NUM_MAP[chM[1]]
    aliases.add(`第${chM[1]}章`)
    aliases.add(`第${chM[1]}节`)
    if (chNum) {
      aliases.add(`第${chNum}章`)
      aliases.add(`第${chNum}节`)
    }
  }
  const arM = /^(\d+)[、.]/.exec(clean)
  if (arM) {
    aliases.add(`第${arM[1]}章`)
    aliases.add(`第${arM[1]}节`)
  }
  return aliases
}

function buildSectionSpans(currLines) {
  const sections = []
  let cur = { title: '_top', startLine: 1, endLine: currLines.length, aliases: new Set(), lines: [] }
  let inFence = false
  for (let i = 0; i < currLines.length; i += 1) {
    const line = currLines[i]
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && /^#{2,3}\s+(.+)$/.test(line)) {
      cur.endLine = i
      if (cur.lines.length > 0 || cur.title !== '_top') sections.push(cur)
      const title = line.replace(/^#{2,3}\s+/, '').trim()
      cur = { title, startLine: i + 1, endLine: currLines.length, aliases: parseHeadingAliases(title), lines: [line] }
      continue
    }
    cur.lines.push(line)
  }
  cur.endLine = currLines.length
  if (cur.lines.length > 0 || cur.title !== '_top') sections.push(cur)
  return sections
}

function computeChangedCurrLineIndices(prevLines, currLines) {
  const n = prevLines.length
  const m = currLines.length
  if (n * m <= 2500000) {
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i -= 1) {
      const pi = prevLines[i]
      const row = dp[i]
      const nextRow = dp[i + 1]
      for (let j = m - 1; j >= 0; j -= 1) {
        row[j] = pi === currLines[j] ? nextRow[j + 1] + 1 : Math.max(nextRow[j], row[j + 1])
      }
    }
    const matchedCurr = new Set()
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (prevLines[i] === currLines[j]) {
        matchedCurr.add(j + 1)
        i += 1
        j += 1
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i += 1
      } else {
        j += 1
      }
    }
    const changed = []
    for (let k = 1; k <= m; k += 1) {
      if (!matchedCurr.has(k)) changed.push(k)
    }
    if (changed.length === 0 && n !== m) {
      // 仅发生删行时，标记邻接变化锚点行以便定位改动章节
      let prefix = 0
      while (prefix < n && prefix < m && prevLines[prefix] === currLines[prefix]) prefix += 1
      changed.push(Math.min(m, Math.max(1, prefix + 1)))
    }
    return changed
  }

  const prevCounts = new Map()
  for (const l of prevLines) prevCounts.set(l, (prevCounts.get(l) ?? 0) + 1)
  const changed = []
  for (let j = 0; j < m; j += 1) {
    const line = currLines[j]
    const c = prevCounts.get(line) ?? 0
    if (c > 0) prevCounts.set(line, c - 1)
    else changed.push(j + 1)
  }
  return changed
}

function mergeRanges(ranges) {
  if (ranges.length === 0) return []
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const out = [sorted[0]]
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1]
    if (sorted[i][0] <= last[1] + 1) last[1] = Math.max(last[1], sorted[i][1])
    else out.push(sorted[i])
  }
  return out
}

/** 计算两轮正文快照之间的变更行区间（±3 行缓冲）与变更/未变更章节集合。 */
export function computeSnapshotDiff(prevLines = [], currLines = []) {
  const prev = Array.isArray(prevLines) ? prevLines : []
  const curr = Array.isArray(currLines) ? currLines : []
  const rawChanged = computeChangedCurrLineIndices(prev, curr)
  const changedLineRanges = mergeRanges(
    rawChanged.map((ln) => [Math.max(1, ln - LINE_BUFFER), Math.min(Math.max(1, curr.length), ln + LINE_BUFFER)]),
  )
  const rawSet = new Set(rawChanged)
  const sections = buildSectionSpans(curr)
  const changedSections = []
  const untouchedSections = []
  const touchedLineSet = new Set(rawChanged)
  for (const sec of sections) {
    if (sec.title === '_top') continue
    let touched = false
    for (let ln = sec.startLine; ln <= sec.endLine; ln += 1) {
      if (rawSet.has(ln)) { touched = true; break }
    }
    if (touched) {
      changedSections.push(sec)
      for (const [s, e] of changedLineRanges) {
        for (let ln = Math.max(sec.startLine, s); ln <= Math.min(sec.endLine, e); ln += 1) {
          touchedLineSet.add(ln)
        }
      }
    } else {
      untouchedSections.push(sec)
    }
  }
  const changedLinesText = [...touchedLineSet].sort((a, b) => a - b).map((ln) => curr[ln - 1] ?? '').join('\n')
  return { rawChanged, changedLineRanges, changedSections, untouchedSections, changedLinesText, sections }
}

function extractCAnchors(text) {
  return [...new Set([...String(text ?? '').matchAll(/\bC\d+\b/gi)].map((m) => m[0].toUpperCase()))]
}

function extractFindingIds(text) {
  return [...new Set([...String(text ?? '').matchAll(/\bF\d+\b/gi)].map((m) => m[0].toUpperCase()))]
}

function extractLineMentions(text) {
  const nums = []
  for (const m of String(text ?? '').matchAll(/(?:\bL(\d+)\b|第\s*(\d+)\s*行|\bline\s+(\d+)\b)/gi)) {
    const n = Number(m[1] || m[2] || m[3])
    if (Number.isInteger(n) && n > 0) nums.push(n)
  }
  return nums
}

/** 按 `--resolved` 与 `--rebut-accepted` 关闭历史未决阻塞条目。 */
export function applyFindingClosures(existing = [], { resolved = [], rebutAccepted = [], round = 1 } = {}) {
  const list = Array.isArray(existing) ? existing.map((item) => ({ ...item })) : []
  const closeQueries = [
    ...(Array.isArray(resolved) ? resolved : [resolved]).map((q) => ({ q: String(q ?? '').trim(), status: 'resolved' })),
    ...(Array.isArray(rebutAccepted) ? rebutAccepted : [rebutAccepted]).map((q) => ({ q: String(q ?? '').trim(), status: 'rebutted' })),
  ].filter((x) => x.q)

  const closedIds = []
  for (const { q, status } of closeQueries) {
    const normQ = normCritItemText(q)
    const idQ = /^F\d+$/i.test(q) ? q.toUpperCase() : null
    for (const item of list) {
      if (item.status !== 'open') continue
      const hit = (idQ && String(item.id).toUpperCase() === idQ)
        || (normQ && item.normText === normQ)
        || (normQ && normQ.length >= 4 && item.normText.includes(normQ))
      if (hit) {
        item.status = status
        item.closedInRound = round
        closedIds.push(item.id)
      }
    }
  }
  return { list, closedIds }
}

/** 为本轮意见分配稳定单调 ID（`F1..Fn`）并合并进结构化台账。 */
export function assignStructuredFindings(existing = [], classifiedItems = [], round = 1, { defaultStatus = 'open' } = {}) {
  const list = Array.isArray(existing) ? existing.map((item) => ({ ...item })) : []
  let maxIdx = list.reduce((m, it) => {
    const num = Number(/^F(\d+)$/i.exec(String(it?.id ?? ''))?.[1] ?? 0)
    return Math.max(m, num)
  }, 0)
  const added = []
  for (const item of classifiedItems) {
    maxIdx += 1
    const rec = {
      id: `F${maxIdx}`,
      round,
      severity: item.severity,
      text: item.text,
      normText: normCritItemText(item.text),
      anchors: extractCAnchors(item.text),
      status: isBlockingSeverity(item.severity) ? defaultStatus : 'should-fix',
    }
    list.push(rec)
    added.push(rec)
  }
  return { list, added }
}

function matchesOpenBlocker(findingText, openPriorBlockers) {
  const fNorm = normCritItemText(findingText)
  const fIds = extractFindingIds(findingText)
  const fAnchors = extractCAnchors(findingText)
  for (const open of openPriorBlockers) {
    if (fIds.includes(String(open.id).toUpperCase())) return true
    if (fNorm && open.normText && (fNorm === open.normText || (fNorm.length >= 6 && open.normText.includes(fNorm)) || (open.normText.length >= 6 && fNorm.includes(open.normText)))) {
      return true
    }
    if (fAnchors.length > 0 && Array.isArray(open.anchors) && fAnchors.some((a) => open.anchors.includes(a))) {
      return true
    }
  }
  return false
}

function sectionAliasesMatch(findingLow, section) {
  for (const alias of section.aliases) {
    if (alias.length >= 2 && findingLow.includes(alias)) return true
  }
  return false
}

function matchesContinuedReason(findingText, continuedReason) {
  const cleanReason = String(continuedReason ?? '').trim()
  if (!cleanReason) return false
  const fNorm = normCritItemText(findingText)
  const rNorm = normCritItemText(cleanReason)
  if (fNorm && rNorm && (fNorm === rNorm || (rNorm.length >= 4 && fNorm.includes(rNorm)) || (fNorm.length >= 4 && rNorm.includes(fNorm)))) {
    return true
  }
  const fAnchors = extractCAnchors(findingText)
  const rAnchors = extractCAnchors(cleanReason)
  if (fAnchors.length > 0 && fAnchors.some((a) => rAnchors.includes(a))) return true
  const fLow = String(findingText ?? '').toLowerCase()
  const rCodeTokens = [...cleanReason.matchAll(/`([^`\n]{2,})`/g)].map((m) => m[1].trim().toLowerCase())
  if (rCodeTokens.some((tok) => fLow.includes(tok))) return true
  const rTokens = [...new Set(
    cleanReason.toLowerCase()
      .split(/[\s、，,。；;：:（）()[\]【】/\\|"'`]+/)
      .map((t) => t.trim())
      .filter((t) => t.length >= 2 && !/^(?:补充|修改|完善|增加|调整|重新|继续|复核|说明|以及|或者|进行|关于|需要)$/.test(t)),
  )]
  return rTokens.some((tok) => fLow.includes(tok))
}

/**
 * R2+ 增量收敛区间锁：新阻塞项必须命中未闭环前轮阻塞项、落入变更行/变更章节内、命中 `critique-continue` 指示范围或对应确定性 auditDoc 失败；
 * 指向未动旧行/旧章节的新增主观挑刺一律报 `BLOCKED_OUT_OF_SCOPE_CRITIQUE`（exit 3）。
 */
export function evaluateRound2CritiqueScope({
  effectiveRound,
  prevLines,
  currLines,
  blockingItems = [],
  openPriorBlockers = [],
  usedSummaryFallback = false,
  auditFailure = false,
  continuedReason = '',
  file = '',
  reviewer = '',
} = {}) {
  if (effectiveRound < 2 || !Array.isArray(prevLines) || prevLines.length === 0) {
    return { blocked: false, diff: null, outOfScope: [] }
  }
  const diff = computeSnapshotDiff(prevLines, currLines)
  if (auditFailure) return { blocked: false, diff, outOfScope: [] }

  const changedLow = diff.changedLinesText.toLowerCase()
  const changedAnchors = new Set(extractCAnchors(diff.changedLinesText))
  const untouchedLinesText = diff.untouchedSections.map((s) => s.lines.join('\n')).join('\n')
  const untouchedAnchors = new Set(extractCAnchors(untouchedLinesText))
  const outOfScope = []

  for (const item of blockingItems) {
    const txt = item.text || item.raw || ''
    const low = txt.toLowerCase()

    if (matchesOpenBlocker(txt, openPriorBlockers)) continue
    if (continuedReason && matchesContinuedReason(txt, continuedReason)) continue

    const lineHits = extractLineMentions(txt)
    if (lineHits.some((ln) => diff.changedLineRanges.some(([s, e]) => ln >= s && ln <= e))) continue

    const fAnchors = extractCAnchors(txt)
    if (fAnchors.some((a) => changedAnchors.has(a))) continue

    if (diff.changedSections.some((sec) => sectionAliasesMatch(low, sec))) continue

    const codeTokens = [...txt.matchAll(/`([^`\n]{2,})`/g)].map((m) => m[1].trim().toLowerCase())
    if (codeTokens.some((tok) => changedLow.includes(tok))) continue

    const targetsUntouchedSec = diff.untouchedSections.some((sec) => sectionAliasesMatch(low, sec))
    const targetsUntouchedLine = lineHits.length > 0 && lineHits.every((ln) => !diff.changedLineRanges.some(([s, e]) => ln >= s && ln <= e))
    const targetsUntouchedAnchor = fAnchors.length > 0 && fAnchors.some((a) => untouchedAnchors.has(a) && !changedAnchors.has(a))

    if (targetsUntouchedSec || targetsUntouchedLine || targetsUntouchedAnchor) {
      outOfScope.push(txt)
      continue
    }
    if (openPriorBlockers.length === 0 || !usedSummaryFallback) {
      outOfScope.push(txt)
    }
  }

  if (outOfScope.length > 0) {
    return {
      blocked: true,
      code: 'BLOCKED_OUT_OF_SCOPE_CRITIQUE',
      exitCode: EXIT.FACT,
      diff,
      outOfScope,
      message: `BLOCKED_OUT_OF_SCOPE_CRITIQUE: Round ${effectiveRound} 新增阻塞项指向未改动旧行/旧章节且未关联未闭环阻塞项（${outOfScope.slice(0, 2).join('；')}）。`
        + `非阻塞改进建议请改用：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${file}" --reviewer "${reviewer}" --round ${effectiveRound} --should-fix "${outOfScope[0]}"`,
    }
  }
  return { blocked: false, diff, outOfScope: [] }
}

/** 解析 `plan_critique` 单行印记（兼容旧格式）。 */
export function parseCritiqueStamp(stamp) {
  const raw = String(stamp ?? '').trim()
  if (!raw) return null
  const statusMatch = /^([a-z]+)/i.exec(raw)
  const reviewer = /reviewer=([^,)]+)/i.exec(raw)?.[1]?.trim() ?? null
  const roundRaw = /round=(\d+)/i.exec(raw)?.[1]
  const sha = /\bsha=([a-f0-9]{8,64})\b/i.exec(raw)?.[1]?.toLowerCase() ?? null
  const summary = /summary=([^)]*)/i.exec(raw)?.[1]?.trim() ?? null
  return {
    status: statusMatch ? statusMatch[1].toLowerCase() : null,
    reviewer,
    round: roundRaw ? Number(roundRaw) : null,
    sha,
    summary,
  }
}

/** 安全解析账本或 Frontmatter 中的 `critique_override` 人类解锁记录。 */
export function parseCritiqueOverride(fmData, ledgerEntry = null, key = 'critique_override') {
  if (ledgerEntry?.override && typeof ledgerEntry.override === 'object' && !Array.isArray(ledgerEntry.override)) {
    return ledgerEntry.override
  }
  const raw = fmData?.[key]
  if (!raw) return null
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw.trim())
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch { return null }
  }
  return null
}

/** 把一轮的意见存成一行（`;;` 分隔）。 */
export function serializeFindings(round, findings = []) {
  const parts = []
  for (const f of findings) {
    const text = String(typeof f === 'string' ? f : f?.text ?? '').replace(/[\r\n]+/g, ' ').replace(/;;/g, '；').trim()
    if (!text) continue
    const severity = String(typeof f === 'string' ? 'must' : (f?.severity ?? 'must')).trim() || 'must'
    parts.push(`${round}|${severity}|${text}`)
  }
  return parts.join(' ;; ')
}

/** 把存下来的历史解析回结构化记录（同时兼容管道串、`Round N:` 串及 `ledgerEntry.findings` 数组）。 */
export function parseFindings(raw) {
  if (Array.isArray(raw)) {
    const out = []
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue
      const r = Number(entry.round) || 1
      if (Array.isArray(entry.items)) {
        const sev = String(entry.verdict ?? '').toLowerCase() === 'passed' ? 'should' : 'must'
        for (const item of entry.items) {
          const text = String(item ?? '').trim()
          if (text) out.push({ round: r, severity: sev, text })
        }
      } else if (entry.text) {
        out.push({ round: r, severity: String(entry.severity ?? 'must').toLowerCase(), text: String(entry.text).trim() })
      }
    }
    return out
  }
  const out = []
  for (const part of String(raw ?? '').split(';;')) {
    const seg = part.trim()
    if (!seg) continue
    const pipeMatch = /^(\d+)\|([a-z]+)\|(.+)$/i.exec(seg)
    if (pipeMatch) {
      out.push({ round: Number(pipeMatch[1]), severity: pipeMatch[2].toLowerCase(), text: pipeMatch[3].trim() })
      continue
    }
    const roundMatch = /^Round\s+(\d+)\s*:\s*(.+)$/i.exec(seg)
    if (roundMatch) {
      for (const item of roundMatch[2].split(/;\s*/).map((s) => s.trim()).filter(Boolean)) {
        out.push({ round: Number(roundMatch[1]), severity: 'must', text: item })
      }
    }
  }
  return out
}

