/**
 * session-topics.mjs —— Per-Topic 独立原子加锁讨论缓冲（含 `deadEnds[]` 死路记忆）与交接裁剪原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/，零循环导入 `SCC = 0`）。
 * 每个主题按安全文件名 `<safeSlug>-<sha8>.json` 持久化于 `<gitCommonDir>/project-forge-flow/topics/`
 * （非 Git 仓回退 `<mainRoot>/.worktrees/.state/topics/`），读写全程经 `withFileLockSync` 原子加锁。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { EXIT } from './exit-codes.mjs'
import { canonicalPath, posixPath, readJsonSafe, withFileLockSync, writeJsonAtomic } from './git.mjs'
import { resolveCommonGitDir } from './git-fast.mjs'

export const TOPIC_MAX_BYTES = 6144
export const PRE_INIT_MAX_BYTES = 8192
export const HANDOFF_PROJECTION_MAX_BYTES = 3072

const WIN_RESERVED_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

export function resolveTopicsDir(mainRoot) {
  const root = resolve(String(mainRoot || process.cwd()))
  const gitCommonDir = resolveCommonGitDir(root)
  if (gitCommonDir) return join(gitCommonDir, 'project-forge-flow', 'topics')
  return join(root, '.worktrees', '.state', 'topics')
}

export function normalizeTopicId(raw) {
  const s = String(raw ?? '').trim().slice(0, 120)
  return s || 'default'
}

/**
 * 将任意主题名（含中文、大小写变体、路径穿越符号、Windows 保留设备名）映射为安全唯一文件名 `<safeSlug>-<sha8>.json`。
 * 原 `topicId` 完整保存在 JSON 内容内，避免大小写碰撞与非法路径字符。
 */
export function safeTopicFilename(topicId) {
  const norm = normalizeTopicId(topicId)
  const sha8 = createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 8)
  let slug = norm
    .normalize('NFC')
    .toLowerCase()
    .replace(/[/\\:*?"<>|\x00-\x1f]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 48)
  if (!slug || WIN_RESERVED_DEVICE_RE.test(slug)) slug = 'topic'
  return `${slug}-${sha8}.json`
}

export function resolveTopicFilePath(mainRoot, topicId) {
  return join(resolveTopicsDir(mainRoot), safeTopicFilename(topicId))
}

export function emptyTopicState(topicId = 'default', topicLabel = null) {
  return {
    topicId: normalizeTopicId(topicId),
    topic: topicLabel ? String(topicLabel).trim().slice(0, 240) : normalizeTopicId(topicId),
    facts: {},
    open: [],
    nonGoals: [],
    decisions: [],
    deadEnds: [],
    exclusions: [],
    anchors: [],
    openQuestions: [],
    triage: null,
    briefKey: null,
    updatedAt: null,
    consumedByTaskId: null,
    consumedAt: null,
  }
}

export function normalizeList(raw, existing = []) {
  const out = [...(Array.isArray(existing) ? existing : [])]
  const seen = new Set(out)
  const incoming = Array.isArray(raw) ? raw : (raw !== undefined && raw !== null ? [raw] : [])
  for (const item of incoming) {
    const s = String(item ?? '').trim().slice(0, 600)
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out
}

export function syncTopicDerivedLists(t) {
  const nonGoals = normalizeList([...(t.nonGoals ?? []), ...(t.exclusions ?? [])])
  t.nonGoals = nonGoals
  t.exclusions = [...nonGoals]
  t.deadEnds = normalizeList(t.deadEnds ?? [])
  const unresolvedTexts = (Array.isArray(t.open) ? t.open : [])
    .filter((o) => o && o.status !== 'resolved')
    .map((o) => o.text)
    .filter(Boolean)
  t.openQuestions = unresolvedTexts
  return t
}

export function normalizeOpenItems(rawOpen = [], rawOpenQuestions = []) {
  const items = []
  const seenText = new Set()
  let maxId = 0
  for (const item of Array.isArray(rawOpen) ? rawOpen : []) {
    if (!item || typeof item !== 'object') continue
    const text = String(item.text ?? '').trim().slice(0, 600)
    if (!text || seenText.has(text)) continue
    seenText.add(text)
    const id = String(item.id ?? '').trim() || `Q${maxId + 1}`
    const numM = /^Q(\d+)$/i.exec(id)
    if (numM) maxId = Math.max(maxId, Number(numM[1]))
    else maxId += 1
    items.push({
      id,
      text,
      status: item.status === 'resolved' ? 'resolved' : 'open',
      ...(item.resolvedAt ? { resolvedAt: item.resolvedAt } : {}),
      ...(item.at ? { at: item.at } : {}),
    })
  }
  for (const q of Array.isArray(rawOpenQuestions) ? rawOpenQuestions : []) {
    const text = String(q ?? '').trim().slice(0, 600)
    if (!text || seenText.has(text)) continue
    seenText.add(text)
    maxId += 1
    items.push({ id: `Q${maxId}`, text, status: 'open' })
  }
  return items
}

export function normalizeTopicEntry(topicId, raw = {}) {
  const base = emptyTopicState(topicId, raw.topic ?? topicId)
  const facts = {}
  if (raw.facts && typeof raw.facts === 'object' && !Array.isArray(raw.facts)) {
    for (const [k, v] of Object.entries(raw.facts)) {
      const ck = String(k ?? '').trim()
      if (ck) facts[ck] = String(v ?? '').trim()
    }
  }
  const open = normalizeOpenItems(raw.open, raw.openQuestions)
  const out = {
    ...base,
    topicId: normalizeTopicId(raw.topicId || topicId),
    topic: raw.topic ? String(raw.topic).trim().slice(0, 240) : normalizeTopicId(topicId),
    facts,
    open,
    nonGoals: normalizeList(raw.nonGoals ?? raw.exclusions ?? []),
    decisions: normalizeList(raw.decisions ?? []),
    deadEnds: normalizeList(raw.deadEnds ?? []),
    exclusions: normalizeList(raw.exclusions ?? raw.nonGoals ?? []),
    anchors: normalizeList(raw.anchors ?? []),
    openQuestions: [],
    triage: raw.triage && typeof raw.triage === 'object' ? { ...raw.triage } : null,
    briefKey: raw.briefKey ? String(raw.briefKey).trim().slice(0, 80) : null,
    updatedAt: raw.updatedAt ?? null,
    consumedByTaskId: raw.consumedByTaskId ?? null,
    consumedAt: raw.consumedAt ?? null,
  }
  return syncTopicDerivedLists(out)
}

export function hasTopicContent(t) {
  if (!t || typeof t !== 'object') return false
  return Boolean(
    Object.keys(t.facts ?? {}).length > 0
    || (t.open ?? []).some((o) => o && o.status !== 'resolved')
    || (t.nonGoals?.length ?? 0) > 0
    || (t.decisions?.length ?? 0) > 0
    || (t.deadEnds?.length ?? 0) > 0
    || (t.exclusions?.length ?? 0) > 0
    || (t.anchors?.length ?? 0) > 0
    || (t.openQuestions?.length ?? 0) > 0,
  )
}

export function formatTopicAsPreInit(t) {
  if (!t || typeof t !== 'object') return null
  if (!hasTopicContent(t) && !t.triage) return null
  syncTopicDerivedLists(t)
  return {
    topicId: t.topicId,
    topic: t.topic ?? t.topicId,
    facts: { ...(t.facts ?? {}) },
    open: (t.open ?? []).map((o) => ({ ...o })),
    unresolvedOpen: (t.open ?? []).filter((o) => o && o.status !== 'resolved').map((o) => ({ ...o })),
    nonGoals: [...(t.nonGoals ?? [])],
    decisions: [...(t.decisions ?? [])],
    deadEnds: [...(t.deadEnds ?? [])],
    exclusions: [...(t.nonGoals ?? [])],
    anchors: [...(t.anchors ?? [])],
    openQuestions: [...(t.openQuestions ?? [])],
    triage: t.triage ? { ...t.triage } : null,
    briefKey: t.briefKey ?? null,
    updatedAt: t.updatedAt ?? null,
    consumedByTaskId: t.consumedByTaskId ?? null,
    consumedAt: t.consumedAt ?? null,
  }
}

export function boundTopicSize(topicState, maxBytes = TOPIC_MAX_BYTES) {
  syncTopicDerivedLists(topicState)
  const sizeOf = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8')
  while (sizeOf(topicState) > maxBytes) {
    if (topicState.anchors.length > 0) {
      topicState.anchors.shift()
      continue
    }
    const resolvedIdx = topicState.open.findIndex((o) => o && o.status === 'resolved')
    if (resolvedIdx >= 0) {
      topicState.open.splice(resolvedIdx, 1)
      continue
    }
    if (Object.keys(topicState.facts).length === 0 && topicState.decisions.length > 0) {
      topicState.decisions.shift()
      continue
    }
    const err = new Error(
      `BLOCKED_TOPIC_BUDGET_EXCEEDED: 主题 "${topicState.topicId}" 记忆体积（${sizeOf(topicState)} B）超过 ${maxBytes} B 上限且不可再裁剪可重建字段；`
      + `严禁静默丢弃 facts，请先用 doc-plan note --topic "${topicState.topicId}" --drop <key> 或 --reset 手动清理。`,
    )
    err.code = 'BLOCKED_TOPIC_BUDGET_EXCEEDED'
    err.exitCode = EXIT.FACT
    throw err
  }
  return topicState
}

export function parseFactInputs(factInputs = []) {
  const list = Array.isArray(factInputs) ? factInputs : (factInputs ? [factInputs] : [])
  const pairs = []
  for (const item of list) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      for (const [k, v] of Object.entries(item)) {
        const cleanKey = String(k ?? '').trim()
        if (!cleanKey) {
          throw Object.assign(new Error('INVALID_FACT_FORMAT: --fact 键名不能为空'), { code: 'INVALID_FACT_FORMAT', exitCode: EXIT.USAGE })
        }
        pairs.push([cleanKey, String(v ?? '').trim()])
      }
      continue
    }
    const raw = String(item ?? '').trim()
    const eqIdx = raw.indexOf('=')
    if (eqIdx <= 0) {
      throw Object.assign(new Error(`INVALID_FACT_FORMAT: --fact 需要 "key=value" 键值对，收到：${raw}`), { code: 'INVALID_FACT_FORMAT', exitCode: EXIT.USAGE })
    }
    pairs.push([raw.slice(0, eqIdx).trim(), raw.slice(eqIdx + 1).trim()])
  }
  return pairs
}

export function applyDropTokens(topicState, dropTokens = []) {
  const tokens = (Array.isArray(dropTokens) ? dropTokens : [dropTokens]).map((s) => String(s ?? '').trim()).filter(Boolean)
  for (const tok of tokens) {
    const low = tok.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(topicState.facts, tok)) {
      delete topicState.facts[tok]
      continue
    }
    const factKey = Object.keys(topicState.facts).find((k) => k.toLowerCase() === low)
    if (factKey) {
      delete topicState.facts[factKey]
      continue
    }
    topicState.open = topicState.open.filter((o) => o.id.toLowerCase() !== low && !o.text.toLowerCase().includes(low))
    topicState.nonGoals = topicState.nonGoals.filter((n) => n.toLowerCase() !== low && !n.toLowerCase().includes(low))
    topicState.exclusions = [...topicState.nonGoals]
    topicState.anchors = topicState.anchors.filter((a) => a.toLowerCase() !== low)
    topicState.decisions = topicState.decisions.filter((d) => d.toLowerCase() !== low && !d.toLowerCase().includes(low))
    topicState.deadEnds = (topicState.deadEnds ?? []).filter((d) => d.toLowerCase() !== low && !d.toLowerCase().includes(low))
  }
}

export function applyResolveTokens(topicState, resolveTokens = [], now) {
  const tokens = (Array.isArray(resolveTokens) ? resolveTokens : [resolveTokens]).map((s) => String(s ?? '').trim()).filter(Boolean)
  let resolvedCount = 0
  for (const tok of tokens) {
    const low = tok.toLowerCase()
    for (const item of topicState.open) {
      if (item.status === 'resolved') continue
      if (item.id.toLowerCase() === low || item.text.toLowerCase() === low || item.text.toLowerCase().includes(low)) {
        item.status = 'resolved'
        item.resolvedAt = now
        resolvedCount += 1
      }
    }
  }
  return resolvedCount
}

export function findTopicKey(topics, rawTopic) {
  if (!rawTopic || !topics || typeof topics !== 'object') return null
  const want = normalizeTopicId(rawTopic)
  if (topics[want]) return want
  const low = want.toLowerCase()
  for (const [k, v] of Object.entries(topics)) {
    if (k.toLowerCase() === low || String(v?.topic ?? '').trim().toLowerCase() === low) return k
  }
  return null
}

/** 读取目录下全部 Per-Topic JSON 文件（损坏文件安全跳过，永不抛异常）。 */
export function readAllPerTopicFiles(mainRoot) {
  const out = {}
  const dirs = [...new Set([
    resolveTopicsDir(mainRoot),
    join(resolve(String(mainRoot || process.cwd())), '.worktrees', '.state', 'topics'),
  ])]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    let entries = []
    try { entries = readdirSync(dir) } catch { continue }
    for (const name of entries.sort()) {
      if (!name.endsWith('.json')) continue
      const raw = readJsonSafe(join(dir, name), null)
      if (!raw || typeof raw !== 'object') continue
      const tid = normalizeTopicId(raw.topicId || raw.topic || name.replace(/\.json$/, ''))
      const norm = normalizeTopicEntry(tid, raw)
      if (!out[tid] || String(norm.updatedAt ?? '') >= String(out[tid].updatedAt ?? '')) {
        out[tid] = norm
      }
    }
  }
  return out
}

/** 原子加锁读写单个 Per-Topic JSON 文件（零跨主题写锁竞争）。 */
export function writeTopicFileLocked(mainRoot, topicId, mutator, { legacySeed = null } = {}) {
  const normId = normalizeTopicId(topicId)
  const filePath = resolveTopicFilePath(mainRoot, normId)
  return withFileLockSync(`${filePath}.lock`, () => {
    const existingRaw = readJsonSafe(filePath, null) ?? legacySeed
    const current = existingRaw && typeof existingRaw === 'object'
      ? normalizeTopicEntry(normId, existingRaw)
      : null
    const next = mutator(current, normId)
    if (next && typeof next === 'object') {
      writeJsonAtomic(filePath, next)
    }
    return { filePath, topic: next }
  })
}

function extractContextTopicHints({ taskId = null, slug = null, branch = null, worktreePath = null } = {}) {
  const hints = []
  const add = (v) => {
    const s = String(v ?? '').trim().toLowerCase()
    if (s && !hints.includes(s)) hints.push(s)
  }
  if (taskId) add(taskId)
  if (slug) add(slug)
  if (branch) {
    const b = String(branch).trim()
    add(b)
    const tail = b.split('/').pop()
    if (tail && tail !== b) add(tail)
  }
  if (worktreePath) {
    const norm = posixPath(canonicalPath(worktreePath))
    const m = /\/\.worktrees\/(?:impl|sandbox|review)-([^/]+)$/i.exec(norm)
    if (m?.[1]) add(m[1])
  }
  return hints
}

/**
 * 在省略 `--topic` 时按当前 `worktree`/`branch`/`slug`/`taskId` 精确匹配主题；
 * 多活跃主题且未精确命中时返回 `{ matched: null, ambiguous: true, availableTopics }`，绝不猜测跨会话吸收。
 */
export function matchTopicForContext(topics = {}, {
  topic = null, taskId = null, slug = null, branch = null, worktreePath = null, includeTriageOnly = false,
} = {}) {
  const map = topics && typeof topics === 'object' ? topics : {}
  if (topic) {
    const key = findTopicKey(map, topic)
    const hit = key ? map[key] : null
    return { matched: hit, matchedKey: key, ambiguous: false, availableTopics: Object.keys(map) }
  }
  const activeEntries = Object.entries(map)
    .filter(([, t]) => t && !t.consumedByTaskId && (hasTopicContent(t) || (includeTriageOnly && t.triage && !t.triage.terminal)))
    .sort((a, b) => String(b[1]?.updatedAt ?? '').localeCompare(String(a[1]?.updatedAt ?? '')))

  if (activeEntries.length === 0) {
    return { matched: null, matchedKey: null, ambiguous: false, availableTopics: [] }
  }
  const hints = extractContextTopicHints({ taskId, slug, branch, worktreePath })
  for (const h of hints) {
    const exact = activeEntries.find(([k, t]) =>
      k.toLowerCase() === h
      || String(t.topic ?? '').trim().toLowerCase() === h
      || String(t.triage?.taskId ?? '').trim().toLowerCase() === h
      || String(t.triage?.slug ?? '').trim().toLowerCase() === h,
    )
    if (exact) {
      return {
        matched: exact[1],
        matchedKey: exact[0],
        ambiguous: false,
        availableTopics: activeEntries.map(([k]) => k),
      }
    }
  }
  if (activeEntries.length === 1) {
    return {
      matched: activeEntries[0][1],
      matchedKey: activeEntries[0][0],
      ambiguous: false,
      availableTopics: [activeEntries[0][0]],
    }
  }
  return {
    matched: null,
    matchedKey: null,
    ambiguous: true,
    availableTopics: activeEntries.map(([k]) => k),
  }
}

/**
 * 对交接包附着的 `skillLine` + `decisions[]`/`deadEnds[]` + `concurrencyRadar` 执行 `<= maxBytes`（默认 `3072 B`）
 * 字节预算动态裁剪：严格按「角色 skillPath + Day-1 指令 > decisions/deadEnds > concurrencyRadar」优先级收缩。
 */
export function trimHandoffProjectionBlocks({
  skillLines = [],
  decisions = [],
  deadEnds = [],
  radarLines = [],
  maxBytes = HANDOFF_PROJECTION_MAX_BYTES,
} = {}) {
  const cleanSkill = (Array.isArray(skillLines) ? skillLines : []).map((s) => String(s ?? '')).filter(Boolean)
  const decs = (Array.isArray(decisions) ? decisions : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  const ends = (Array.isArray(deadEnds) ? deadEnds : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  const rads = (Array.isArray(radarLines) ? radarLines : []).map((s) => String(s ?? '')).filter(Boolean)

  const assemble = (dList, eList, rList) => {
    const out = [...cleanSkill]
    if (dList.length > 0 || eList.length > 0) {
      out.push('### 活跃主题决策与已证伪死路')
      for (const d of dList) out.push(`- 决策：${d}`)
      for (const e of eList) out.push(`- 死路（勿重踩）：${e}`)
    }
    if (rList.length > 0) {
      out.push('### 兄弟会话并发雷达')
      for (const r of rList) out.push(r)
    }
    return out
  }

  let dCur = [...decs]
  let eCur = [...ends]
  let rCur = [...rads]
  let truncated = false
  let lines = assemble(dCur, eCur, rCur)
  const byteLen = (arr) => Buffer.byteLength(arr.join('\n'), 'utf8')

  while (byteLen(lines) > maxBytes) {
    truncated = true
    if (rCur.length > 0) {
      rCur.pop()
    } else if (dCur.length > 0 && dCur.length >= eCur.length) {
      dCur.pop()
    } else if (eCur.length > 0) {
      eCur.pop()
    } else if (cleanSkill.length > 1) {
      cleanSkill.pop()
    } else {
      break
    }
    lines = assemble(dCur, eCur, rCur)
  }

  let text = lines.join('\n')
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    truncated = true
    const buf = Buffer.from(text, 'utf8').subarray(0, Math.max(0, maxBytes))
    text = buf.toString('utf8').replace(/\uFFFD+$/, '')
    lines = text.split('\n')
  }

  return {
    lines,
    text,
    bytes: Buffer.byteLength(lines.join('\n'), 'utf8'),
    truncated,
  }
}
