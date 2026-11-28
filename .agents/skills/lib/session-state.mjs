/**
 * session-state.mjs —— 治理流水线 S1–S4 步骤账本、v2 多主题 Working Brief 与分流防降档守卫。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/）。
 * 在 Git 仓库内优先存于 `<gitCommonDir>/project-forge-flow/session-state.json`（不污染工作区 `git status`），
 * 非 Git 目录回退 `<mainRoot>/.worktrees/.state/session-state.json`。
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { EXIT } from './exit-codes.mjs'
import { posixPath, readJsonSafe, readTextSafe, writeJsonAtomic } from './git.mjs'
import { resolveGitDirFast } from './git-fast.mjs'

export const SESSION_SCHEMA_VERSION = 2
export const MAX_ACTIVE_TOPICS = 5
export const TOPIC_MAX_BYTES = 6144
export const PRE_INIT_MAX_BYTES = 8192

function resolveCommonGitDir(mainRoot) {
  const gd = resolveGitDirFast(mainRoot)
  if (!gd || !existsSync(gd)) return null
  const cdFile = join(gd, 'commondir')
  if (existsSync(cdFile)) {
    const raw = (readTextSafe(cdFile) ?? '').trim()
    if (raw) return isAbsolute(raw) ? resolve(raw) : resolve(gd, raw)
  }
  return gd
}

export function resolveSessionStatePath(mainRoot) {
  const root = resolve(String(mainRoot || process.cwd()))
  const gitCommonDir = resolveCommonGitDir(root)
  if (gitCommonDir) return join(gitCommonDir, 'project-forge-flow', 'session-state.json')
  return join(root, '.worktrees', '.state', 'session-state.json')
}

export function normalizeTopicId(raw) {
  const s = String(raw ?? '').trim().slice(0, 120)
  return s || 'default'
}

function emptyTopicState(topicId = 'default', topicLabel = null) {
  return {
    topicId: normalizeTopicId(topicId),
    topic: topicLabel ? String(topicLabel).trim().slice(0, 240) : normalizeTopicId(topicId),
    facts: {},
    open: [],
    nonGoals: [],
    decisions: [],
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

function normalizeList(raw, existing = []) {
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

function syncTopicDerivedLists(t) {
  const nonGoals = normalizeList([...(t.nonGoals ?? []), ...(t.exclusions ?? [])])
  t.nonGoals = nonGoals
  t.exclusions = [...nonGoals]
  const unresolvedTexts = (Array.isArray(t.open) ? t.open : [])
    .filter((o) => o && o.status !== 'resolved')
    .map((o) => o.text)
    .filter(Boolean)
  t.openQuestions = unresolvedTexts
  return t
}

function normalizeOpenItems(rawOpen = [], rawOpenQuestions = []) {
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
    items.push({ id: `Q${maxId}`, text, status: 'open', at: new Date().toISOString() })
  }
  return items
}

function normalizeTopicEntry(topicId, raw = {}) {
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

function hasTopicContent(t) {
  if (!t || typeof t !== 'object') return false
  return Boolean(
    Object.keys(t.facts ?? {}).length > 0
    || (t.open ?? []).some((o) => o && o.status !== 'resolved')
    || (t.nonGoals?.length ?? 0) > 0
    || (t.decisions?.length ?? 0) > 0
    || (t.exclusions?.length ?? 0) > 0
    || (t.anchors?.length ?? 0) > 0
    || (t.openQuestions?.length ?? 0) > 0,
  )
}

/** 将 v1 或 v2 原始对象无损归一化为 schemaVersion: 2 结构（向后兼容读 v1）。 */
export function normalizeSessionState(raw) {
  if (!raw || typeof raw !== 'object') return null
  const topics = {}
  if (raw.topics && typeof raw.topics === 'object' && !Array.isArray(raw.topics)) {
    for (const [tid, entry] of Object.entries(raw.topics)) {
      if (entry && typeof entry === 'object') {
        const key = normalizeTopicId(tid)
        topics[key] = normalizeTopicEntry(key, entry)
      }
    }
  }
  if (raw.preInit && typeof raw.preInit === 'object' && hasTopicContent(raw.preInit) && !raw.preInit.consumedByTaskId) {
    const tid = normalizeTopicId(raw.preInit.topic || raw.activeTopic || 'default')
    if (!topics[tid]) {
      topics[tid] = normalizeTopicEntry(tid, raw.preInit)
    }
  }
  if (raw.triage && typeof raw.triage === 'object' && !raw.triage.terminal && !raw.triage.consumedByTaskId) {
    const tid = normalizeTopicId(raw.triage.topic || raw.activeTopic || 'default')
    if (topics[tid] && !topics[tid].triage) {
      topics[tid].triage = { ...raw.triage }
    }
  }
  const activeTopic = raw.activeTopic && topics[normalizeTopicId(raw.activeTopic)]
    ? normalizeTopicId(raw.activeTopic)
    : (Object.keys(topics)[0] ?? null)
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    steps: raw.steps && typeof raw.steps === 'object' ? { ...raw.steps } : {},
    triage: raw.triage ?? null,
    triageByTask: raw.triageByTask && typeof raw.triageByTask === 'object' ? { ...raw.triageByTask } : {},
    topics,
    activeTopic,
    ...(raw.preInit ? { preInit: raw.preInit } : {}),
    ...(raw.explored ? { explored: raw.explored } : {}),
    updatedAt: raw.updatedAt ?? null,
  }
}

function readNormalizedState(mainRoot) {
  const statePath = resolveSessionStatePath(mainRoot)
  const raw = readJsonSafe(statePath, null)
  return {
    statePath,
    state: normalizeSessionState(raw) ?? {
      schemaVersion: SESSION_SCHEMA_VERSION,
      steps: {},
      triage: null,
      triageByTask: {},
      topics: {},
      activeTopic: null,
      updatedAt: null,
    },
  }
}

export function readSessionState(mainRoot) {
  const primary = resolveSessionStatePath(mainRoot)
  const hit = readJsonSafe(primary, null)
  if (hit && typeof hit === 'object') return normalizeSessionState(hit)
  const fallback = join(resolve(String(mainRoot || process.cwd())), '.worktrees', '.state', 'session-state.json')
  if (fallback !== primary) {
    const fb = readJsonSafe(fallback, null)
    if (fb && typeof fb === 'object') return normalizeSessionState(fb)
  }
  return null
}

function projectLegacyPreInit(topicState) {
  if (!topicState) return undefined
  return {
    topic: topicState.topic ?? topicState.topicId ?? null,
    decisions: [...(topicState.decisions ?? [])],
    exclusions: [...(topicState.nonGoals ?? [])],
    anchors: [...(topicState.anchors ?? [])],
    openQuestions: [...(topicState.openQuestions ?? [])],
    updatedAt: topicState.updatedAt ?? null,
    consumedByTaskId: topicState.consumedByTaskId ?? null,
    consumedAt: topicState.consumedAt ?? null,
  }
}

function enforceActiveTopicCap(topics, keepTopicId = null) {
  const entries = Object.entries(topics)
  const isActive = (t) => !t.consumedByTaskId && (hasTopicContent(t) || (t.triage && !t.triage.terminal))
  const activeEntries = entries.filter(([, t]) => isActive(t))
  if (activeEntries.length <= MAX_ACTIVE_TOPICS) return topics

  // 先清理已消费或空主题腾位置，仍超出时淘汰最久未更新的活跃主题（保留当前操作主题）。
  const next = { ...topics }
  for (const [k, t] of entries) {
    if (k === keepTopicId) continue
    if (!isActive(t)) delete next[k]
  }
  const stillActive = Object.entries(next)
    .filter(([k, t]) => k !== keepTopicId && isActive(t))
    .sort((a, b) => String(a[1].updatedAt ?? '').localeCompare(String(b[1].updatedAt ?? '')))
  let over = Object.values(next).filter(isActive).length - MAX_ACTIVE_TOPICS
  for (const [k] of stillActive) {
    if (over <= 0) break
    delete next[k]
    over -= 1
  }
  return next
}

function boundTopicSize(topicState, maxBytes = TOPIC_MAX_BYTES) {
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

export function recordStepState(mainRoot, { step, ok = true, summary = '', meta = {} } = {}) {
  const stepKey = String(step ?? '').trim().toUpperCase()
  if (!stepKey) return null
  const { statePath, state: prev } = readNormalizedState(mainRoot)
  const now = new Date().toISOString()
  const next = {
    ...prev,
    schemaVersion: SESSION_SCHEMA_VERSION,
    steps: {
      ...(prev.steps ?? {}),
      [stepKey]: {
        ok: Boolean(ok),
        summary: String(summary ?? '').trim(),
        at: now,
        ...(meta && typeof meta === 'object' ? meta : {}),
      },
    },
    updatedAt: now,
  }
  writeJsonAtomic(statePath, next)
  return next
}

export function recordStepStateSafe(mainRoot, payload) {
  try {
    return recordStepState(mainRoot, payload)
  } catch {
    return null
  }
}

export function computeTriageFingerprint({ summary = '', paths = [] } = {}) {
  const normSummary = String(summary ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
  const normPaths = [...new Set((Array.isArray(paths) ? paths : []).map((p) => posixPath(p).trim()).filter(Boolean))].sort()
  return createHash('sha256').update(`${normSummary}\n${normPaths.join('\n')}`, 'utf8').digest('hex').slice(0, 16)
}

export function recordTriageDecision(mainRoot, {
  caseType, summary = '', paths = [], doorType = null, planMode = null, recommendedEntry = null, taskId = null, slug = null, topic = null,
} = {}) {
  const { statePath, state: prev } = readNormalizedState(mainRoot)
  const fingerprint = computeTriageFingerprint({ summary, paths })
  const cleanTopic = topic && String(topic).trim() ? normalizeTopicId(topic) : null
  const now = new Date().toISOString()
  const entry = {
    caseType: Number(caseType),
    fingerprint,
    taskId: taskId ? String(taskId).trim() : null,
    slug: slug ? String(slug).trim() : null,
    topic: cleanTopic,
    summary: String(summary ?? '').trim().slice(0, 240),
    doorType: doorType ?? null,
    planMode: planMode ?? null,
    recommendedEntry: recommendedEntry ?? null,
    consumedByTaskId: null,
    terminal: false,
    at: now,
  }
  const mapKey = entry.taskId || entry.slug || (cleanTopic ? `topic:${cleanTopic}` : `fp:${fingerprint}`)
  let topics = { ...(prev.topics ?? {}) }
  if (cleanTopic) {
    const curTopic = topics[cleanTopic] ? { ...topics[cleanTopic] } : emptyTopicState(cleanTopic, topic)
    curTopic.triage = entry
    curTopic.updatedAt = now
    topics[cleanTopic] = curTopic
    topics = enforceActiveTopicCap(topics, cleanTopic)
  }
  const next = {
    ...prev,
    schemaVersion: SESSION_SCHEMA_VERSION,
    triage: entry,
    triageByTask: { ...(prev.triageByTask ?? {}), [mapKey]: entry },
    topics,
    activeTopic: cleanTopic ?? prev.activeTopic ?? null,
    updatedAt: now,
  }
  writeJsonAtomic(statePath, next)
  return next
}

/** 严格按 topic / taskId / slug 隔离标记 triage 消费，绝不误消费其他主题记录。 */
export function markTriageConsumed(mainRoot, { taskId = null, slug = null, topic = null, terminal = false } = {}) {
  try {
    const { statePath, state: prev } = readNormalizedState(mainRoot)
    const cleanTask = taskId ? String(taskId).trim() : null
    const cleanSlug = slug ? String(slug).trim() : null
    const cleanTopic = topic ? normalizeTopicId(topic) : null
    if (!cleanTask && !cleanSlug && !cleanTopic) return prev

    const matchesRec = (rec) => {
      if (!rec || typeof rec !== 'object') return false
      const rTask = rec.taskId ? String(rec.taskId).trim().toLowerCase() : ''
      const rSlug = rec.slug ? String(rec.slug).trim().toLowerCase() : ''
      const rTopic = rec.topic ? normalizeTopicId(rec.topic).toLowerCase() : ''
      const rConsumed = rec.consumedByTaskId ? String(rec.consumedByTaskId).trim().toLowerCase() : ''
      if (cleanTopic) {
        return rTopic === cleanTopic.toLowerCase()
          || (cleanTask && (rTask === cleanTask.toLowerCase() || rConsumed === cleanTask.toLowerCase()))
      }
      if (rTopic) {
        return (cleanTask && (rTask === cleanTask.toLowerCase() || rConsumed === cleanTask.toLowerCase()))
          || (cleanSlug && (rSlug === cleanSlug.toLowerCase() || rConsumed === cleanSlug.toLowerCase()))
      }
      const sameId = (cleanTask && (rTask === cleanTask.toLowerCase() || rConsumed === cleanTask.toLowerCase()))
        || (cleanSlug && (rSlug === cleanSlug.toLowerCase() || rConsumed === cleanSlug.toLowerCase()))
      return Boolean(sameId || (!rec.consumedByTaskId && !rTask && !rSlug && !rTopic))
    }

    const consumerLabel = cleanTask || cleanSlug || cleanTopic
    const touch = (rec) => (matchesRec(rec)
      ? { ...rec, consumedByTaskId: consumerLabel || rec.consumedByTaskId, ...(terminal ? { terminal: true } : {}) }
      : rec)

    const byTask = {}
    for (const [k, v] of Object.entries(prev.triageByTask ?? {})) byTask[k] = touch(v)

    const topics = { ...(prev.topics ?? {}) }
    for (const [tid, tObj] of Object.entries(topics)) {
      if (!tObj?.triage) continue
      const matchTopic = cleanTopic
        ? tid.toLowerCase() === cleanTopic.toLowerCase()
        : matchesRec(tObj.triage)
      if (matchTopic) {
        topics[tid] = {
          ...tObj,
          triage: { ...tObj.triage, consumedByTaskId: consumerLabel || tObj.triage.consumedByTaskId, ...(terminal ? { terminal: true } : {}) },
        }
      }
    }

    const next = {
      ...prev,
      schemaVersion: SESSION_SCHEMA_VERSION,
      triage: prev.triage ? touch(prev.triage) : null,
      triageByTask: byTask,
      topics,
      updatedAt: new Date().toISOString(),
    }
    writeJsonAtomic(statePath, next)
    return next
  } catch {
    return null
  }
}

export function checkTriageDowngrade({ previousCase, nextCase, reason = '' } = {}) {
  const prevNum = Number(previousCase)
  const nextNum = Number(nextCase)
  if (!Number.isInteger(prevNum) || !Number.isInteger(nextNum)) return { ok: true }
  if (nextNum < prevNum && !String(reason ?? '').trim()) {
    return {
      ok: false,
      code: 'BLOCKED_TRIAGE_DOWNGRADE',
      exitCode: EXIT.FACT,
      reason: `禁止静默将分流档位从 Case ${prevNum} 降档为 Case ${nextNum}；如确需降档请显式附 --reason "<降档依据>"。`,
    }
  }
  return { ok: true }
}

export function findBlockingTriageDowngrade(sess, { taskId = null, slug = null, topic = null, summary = '', paths = [], nextCase, reason = '' } = {}) {
  if (!sess) return { ok: true }
  const byTask = sess.triageByTask && typeof sess.triageByTask === 'object' ? sess.triageByTask : {}
  const cleanTask = taskId ? String(taskId).trim().toLowerCase() : ''
  const cleanSlug = slug ? String(slug).trim().toLowerCase() : ''
  const cleanTopic = topic ? normalizeTopicId(topic).toLowerCase() : ''
  const fp = summary ? computeTriageFingerprint({ summary, paths }) : null

  const candidates = []
  for (const rec of Object.values(byTask)) {
    if (rec && typeof rec === 'object' && !rec.terminal) candidates.push(rec)
  }
  if (sess.triage && !sess.triage.terminal && candidates.length === 0) candidates.push(sess.triage)

  for (const rec of candidates) {
    const recTask = rec.taskId ? String(rec.taskId).trim().toLowerCase() : ''
    const recSlug = rec.slug ? String(rec.slug).trim().toLowerCase() : ''
    const recTopic = rec.topic ? normalizeTopicId(rec.topic).toLowerCase() : ''
    const recConsumed = rec.consumedByTaskId ? String(rec.consumedByTaskId).trim().toLowerCase() : ''
    if (cleanTopic && recTopic && cleanTopic !== recTopic) continue
    const idMatched = (cleanTopic && recTopic === cleanTopic)
      || (cleanTask && (recTask === cleanTask || recConsumed === cleanTask))
      || (cleanSlug && (recSlug === cleanSlug || recConsumed === cleanSlug))
      || (cleanTask && recSlug && cleanTask === recSlug)
    const fpMatched = Boolean(fp && rec.fingerprint && fp === rec.fingerprint)
    const callerHasIdentity = Boolean(cleanTask || cleanSlug || cleanTopic)
    const fpDistinct = Boolean(fp && rec.fingerprint && fp !== rec.fingerprint)
    const unconsumedFresh = !recConsumed && !recTask && !recSlug && !recTopic && !callerHasIdentity && !fpDistinct
    if (!idMatched && !fpMatched && !unconsumedFresh) continue
    const chk = checkTriageDowngrade({ previousCase: rec.caseType, nextCase, reason })
    if (!chk.ok) return chk
  }
  return { ok: true }
}

function findTopicKey(topics, rawTopic) {
  if (!rawTopic || !topics || typeof topics !== 'object') return null
  const want = normalizeTopicId(rawTopic)
  if (topics[want]) return want
  const low = want.toLowerCase()
  for (const [k, v] of Object.entries(topics)) {
    if (k.toLowerCase() === low || String(v?.topic ?? '').trim().toLowerCase() === low) return k
  }
  return null
}

function formatTopicAsPreInit(t) {
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

/** 读取未消费的 `init` 前讨论缓冲（支持 `--topic` 严格隔离）；为空或已消费则返回 null。 */
export function readPreInitState(mainRoot, { topic = null } = {}) {
  const sess = readSessionState(mainRoot)
  if (!sess) return null
  const topics = sess.topics ?? {}
  if (topic) {
    const key = findTopicKey(topics, topic)
    if (!key) return null
    const hit = topics[key]
    if (!hit || hit.consumedByTaskId || !hasTopicContent(hit)) return null
    return formatTopicAsPreInit(hit)
  }
  const activeKey = sess.activeTopic && topics[sess.activeTopic] ? sess.activeTopic : null
  const candidates = [
    ...(activeKey ? [topics[activeKey]] : []),
    ...Object.values(topics).sort((a, b) => String(b?.updatedAt ?? '').localeCompare(String(a?.updatedAt ?? ''))),
  ]
  for (const cand of candidates) {
    if (cand && !cand.consumedByTaskId && hasTopicContent(cand)) {
      return formatTopicAsPreInit(cand)
    }
  }
  const raw = sess.preInit
  if (raw && typeof raw === 'object' && !raw.consumedByTaskId && hasTopicContent(raw)) {
    return formatTopicAsPreInit(normalizeTopicEntry(raw.topic || 'default', raw))
  }
  return null
}

/** 读取全部未消费活跃主题（供 `session-orient.mjs` 完整渲染，无截断）。 */
export function readAllActiveTopics(mainRoot) {
  const sess = readSessionState(mainRoot)
  if (!sess) return []
  return Object.values(sess.topics ?? {})
    .filter((t) => t && !t.consumedByTaskId && hasTopicContent(t))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .map(formatTopicAsPreInit)
    .filter(Boolean)
}

function parseFactInputs(factInputs = []) {
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

function applyDropTokens(topicState, dropTokens = []) {
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
  }
}

function applyResolveTokens(topicState, resolveTokens = [], now) {
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

/** 向 `session-state.json` v2 的 `topics[topicId]` 写入事实/待拍板/不做项/锚点/决策。 */
export function appendPreInitNote(mainRoot, {
  topic = null,
  fact = null,
  facts = [],
  resolve: resolveArgs = [],
  drop = [],
  decision = null,
  decisions = [],
  exclude = null,
  exclusions = [],
  nonGoals = [],
  anchor = null,
  anchors = [],
  open = null,
  openQuestions = [],
  reset = false,
} = {}) {
  const { statePath, state: prev } = readNormalizedState(mainRoot)
  const existingKey = topic ? findTopicKey(prev.topics, topic) : null
  const topicId = existingKey ?? normalizeTopicId(topic || prev.activeTopic || 'default')
  const prevTopic = (!reset && prev.topics?.[topicId] && !prev.topics[topicId].consumedByTaskId)
    ? normalizeTopicEntry(topicId, prev.topics[topicId])
    : emptyTopicState(topicId, topic || prev.topics?.[topicId]?.topic || topicId)

  const now = new Date().toISOString()
  if (topic && String(topic).trim()) prevTopic.topic = String(topic).trim().slice(0, 240)
  for (const [k, v] of parseFactInputs([...(Array.isArray(facts) ? facts : [facts]), ...(fact ? [fact] : [])])) {
    prevTopic.facts[k] = v
  }
  prevTopic.decisions = normalizeList([...(Array.isArray(decisions) ? decisions : []), ...(decision ? [decision] : [])], prevTopic.decisions)
  prevTopic.nonGoals = normalizeList([...(Array.isArray(nonGoals) ? nonGoals : []), ...(Array.isArray(exclusions) ? exclusions : []), ...(exclude ? [exclude] : [])], prevTopic.nonGoals)
  prevTopic.anchors = normalizeList([...(Array.isArray(anchors) ? anchors : []), ...(anchor ? [anchor] : [])], prevTopic.anchors)
  const incomingOpen = [...(Array.isArray(openQuestions) ? openQuestions : []), ...(open ? [open] : [])]
  prevTopic.open = normalizeOpenItems(prevTopic.open, incomingOpen)
  const resolvedCount = applyResolveTokens(prevTopic, resolveArgs, now)
  applyDropTokens(prevTopic, drop)
  prevTopic.updatedAt = now
  prevTopic.consumedByTaskId = null
  prevTopic.consumedAt = null

  const boundedTopic = boundTopicSize(prevTopic, TOPIC_MAX_BYTES)
  const nextTopics = enforceActiveTopicCap({ ...(prev.topics ?? {}), [topicId]: boundedTopic }, topicId)
  const preInit = formatTopicAsPreInit(boundedTopic) ?? { ...emptyTopicState(topicId), ...boundedTopic }
  const next = {
    ...prev,
    schemaVersion: SESSION_SCHEMA_VERSION,
    topics: nextTopics,
    activeTopic: topicId,
    preInit: projectLegacyPreInit(boundedTopic),
    updatedAt: now,
  }
  writeJsonAtomic(statePath, next)
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    topicId,
    resolvedCount,
    preInit,
    topicState: boundedTopic,
    byteSize: Buffer.byteLength(JSON.stringify(boundedTopic), 'utf8'),
  }
}

/** 仅在 `doc-locate` / `repo-map` 显式传入 `--topic <id>` 时向仓外 `topics[topicId].anchors` 写入已验真路径。 */
export function recordTopicAnchors(mainRoot, { topic, anchors = [] } = {}) {
  const cleanTopic = String(topic ?? '').trim()
  if (!cleanTopic) return null
  const cleanAnchors = [...new Set((Array.isArray(anchors) ? anchors : [anchors]).map((a) => posixPath(String(a ?? '').trim())).filter(Boolean))]
  if (cleanAnchors.length === 0) return null
  return appendPreInitNote(mainRoot, { topic: cleanTopic, anchors: cleanAnchors })
}

export function setTopicBriefKey(mainRoot, topic, briefKey) {
  const cleanTopic = String(topic ?? '').trim()
  const cleanKey = String(briefKey ?? '').trim().slice(0, 80)
  if (!cleanTopic || !cleanKey) return null
  const { statePath, state: prev } = readNormalizedState(mainRoot)
  const key = findTopicKey(prev.topics, cleanTopic) ?? normalizeTopicId(cleanTopic)
  const cur = prev.topics?.[key] ? normalizeTopicEntry(key, prev.topics[key]) : emptyTopicState(key, cleanTopic)
  if (cur.briefKey === cleanKey) return cur
  cur.briefKey = cleanKey
  writeJsonAtomic(statePath, { ...prev, schemaVersion: SESSION_SCHEMA_VERSION, topics: { ...(prev.topics ?? {}), [key]: cur }, updatedAt: new Date().toISOString() })
  return cur
}

/** 在 `initDoc` 吸收后仅清空并标记目标主题，绝不误消费其他并行主题。 */
export function consumePreInitNotes(mainRoot, { taskId = null, slug = null, topic = null } = {}) {
  try {
    const { statePath, state: prev } = readNormalizedState(mainRoot)
    const topics = { ...(prev.topics ?? {}) }
    let targetKey = topic ? findTopicKey(topics, topic) : null
    if (!targetKey && !topic) {
      const activeKey = prev.activeTopic && topics[prev.activeTopic] ? prev.activeTopic : null
      if (activeKey && !topics[activeKey].consumedByTaskId && hasTopicContent(topics[activeKey])) {
        targetKey = activeKey
      } else {
        const hit = Object.entries(topics)
          .filter(([, t]) => t && !t.consumedByTaskId && hasTopicContent(t))
          .sort((a, b) => String(b[1].updatedAt ?? '').localeCompare(String(a[1].updatedAt ?? '')))[0]
        if (hit) targetKey = hit[0]
      }
    }
    const targetTopic = targetKey ? topics[targetKey] : null
    if (!targetTopic || targetTopic.consumedByTaskId || !hasTopicContent(targetTopic)) return null
    const snapshot = formatTopicAsPreInit(targetTopic)
    const now = new Date().toISOString()
    const consumer = taskId || slug || 'init'
    topics[targetKey] = {
      ...emptyTopicState(targetKey, targetTopic.topic),
      triage: targetTopic.triage ? { ...targetTopic.triage, consumedByTaskId: consumer } : null,
      updatedAt: now,
      consumedByTaskId: consumer,
      consumedAt: now,
    }
    const nextActive = prev.activeTopic === targetKey
      ? (Object.entries(topics).find(([, t]) => t && !t.consumedByTaskId && hasTopicContent(t))?.[0] ?? null)
      : prev.activeTopic
    writeJsonAtomic(statePath, {
      ...prev,
      schemaVersion: SESSION_SCHEMA_VERSION,
      topics,
      activeTopic: nextActive,
      preInit: nextActive ? projectLegacyPreInit(topics[nextActive]) : projectLegacyPreInit(topics[targetKey]),
      updatedAt: now,
    })
    return snapshot
  } catch {
    return null
  }
}

/** 按 topic / taskId / slug 严格隔离继承未终结 `triage.planMode`。 */
export function resolveInheritedTriagePlanMode(mainRoot, { taskId = null, slug = null, topic = null } = {}) {
  const sess = readSessionState(mainRoot)
  if (!sess) return null
  const cleanTask = taskId ? String(taskId).trim().toLowerCase() : ''
  const cleanSlug = slug ? String(slug).trim().toLowerCase() : ''
  const cleanTopic = topic ? normalizeTopicId(topic).toLowerCase() : ''

  if (cleanTopic) {
    const key = findTopicKey(sess.topics ?? {}, topic)
    const topicTri = key ? sess.topics[key]?.triage : null
    if (topicTri && !topicTri.terminal && !topicTri.consumedByTaskId && topicTri.planMode) {
      return topicTri.planMode
    }
  }

  const byTask = sess.triageByTask && typeof sess.triageByTask === 'object' ? Object.values(sess.triageByTask) : []
  const pool = [...byTask, ...(sess.triage ? [sess.triage] : [])].filter((r) => r && !r.terminal && r.planMode)
  const exact = pool.find((r) => (cleanTopic && r.topic && normalizeTopicId(r.topic).toLowerCase() === cleanTopic)
    || (cleanTask && String(r.taskId ?? '').toLowerCase() === cleanTask)
    || (cleanSlug && String(r.slug ?? '').toLowerCase() === cleanSlug))
  if (exact?.planMode) return exact.planMode
  if (cleanTopic) return null
  const unconsumed = pool.filter((r) => !r.consumedByTaskId && !r.topic && !r.taskId && !r.slug).at(-1)
  return unconsumed?.planMode ?? (sess.triage && !sess.triage.consumedByTaskId && !sess.triage.topic ? sess.triage.planMode : null) ?? null
}
