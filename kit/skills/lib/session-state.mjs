/**
 * session-state.mjs —— 治理流水线 S1–S4 步骤账本、Per-Topic 聚合视图与分流防降档守卫。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/，零循环导入 `SCC = 0`）。
 * `session-state.json` 经 `withFileLockSync` 仅保留 `steps`（S1-S4）、`explored` 与 `triageByTask`；
 * 全部 pre-init 讨论主题已拆至 `session-topics.mjs` 按 `<safeSlug>-<sha8>.json` 独立加锁持久化，
 * 彻底移除全局单例 `activeTopic`/`triage` 与 5 主题静默淘汰，同时保留向后兼容聚合投影 `.topics`。
 */

import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import { EXIT } from './exit-codes.mjs'
import { posixPath, readJsonSafe, withFileLockSync, writeJsonAtomic } from './git.mjs'
import { resolveCommonGitDir } from './git-fast.mjs'
import {
  HANDOFF_PROJECTION_MAX_BYTES,
  PRE_INIT_MAX_BYTES,
  TOPIC_MAX_BYTES,
  applyDropTokens,
  applyResolveTokens,
  boundTopicSize,
  emptyTopicState,
  findTopicKey,
  formatTopicAsPreInit,
  hasTopicContent,
  matchTopicForContext,
  normalizeList,
  normalizeOpenItems,
  normalizeTopicEntry,
  normalizeTopicId,
  parseFactInputs,
  readAllPerTopicFiles,
  resolveTopicFilePath,
  resolveTopicsDir,
  safeTopicFilename,
  trimHandoffProjectionBlocks,
  writeTopicFileLocked,
} from './session-topics.mjs'

export const SESSION_SCHEMA_VERSION = 2

export {
  HANDOFF_PROJECTION_MAX_BYTES,
  PRE_INIT_MAX_BYTES,
  TOPIC_MAX_BYTES,
  boundTopicSize,
  matchTopicForContext,
  normalizeTopicId,
  resolveTopicFilePath,
  resolveTopicsDir,
  safeTopicFilename,
  trimHandoffProjectionBlocks,
}

export function resolveSessionStatePath(mainRoot) {
  const root = resolve(String(mainRoot || process.cwd()))
  const gitCommonDir = resolveCommonGitDir(root)
  if (gitCommonDir) return join(gitCommonDir, 'project-forge-flow', 'session-state.json')
  return join(root, '.worktrees', '.state', 'session-state.json')
}

function extractLegacyEmbeddedTopics(raw) {
  const topics = {}
  if (!raw || typeof raw !== 'object') return topics
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
    if (!topics[tid]) topics[tid] = normalizeTopicEntry(tid, raw.preInit)
  }
  if (raw.triage && typeof raw.triage === 'object' && !raw.triage.terminal && !raw.triage.consumedByTaskId) {
    const tid = normalizeTopicId(raw.triage.topic || raw.activeTopic || 'default')
    if (topics[tid] && !topics[tid].triage) topics[tid].triage = { ...raw.triage }
  }
  return topics
}

/** 将 v1 或 v2 原始对象无损归一化为 schemaVersion: 2 结构（向后兼容读 v1/旧单文件）。 */
export function normalizeSessionState(raw, perTopicMap = null) {
  const hasRaw = Boolean(raw && typeof raw === 'object')
  const hasPerTopics = Boolean(perTopicMap && typeof perTopicMap === 'object' && Object.keys(perTopicMap).length > 0)
  if (!hasRaw && !hasPerTopics) return null

  const legacyTopics = hasRaw ? extractLegacyEmbeddedTopics(raw) : {}
  const topics = { ...legacyTopics }
  if (hasPerTopics) {
    for (const [tid, entry] of Object.entries(perTopicMap)) {
      const key = normalizeTopicId(tid)
      topics[key] = normalizeTopicEntry(key, entry)
    }
  }

  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    steps: hasRaw && raw.steps && typeof raw.steps === 'object' ? { ...raw.steps } : {},
    triageByTask: hasRaw && raw.triageByTask && typeof raw.triageByTask === 'object' ? { ...raw.triageByTask } : {},
    topics,
    ...(hasRaw && raw.triage ? { _legacyTriage: raw.triage } : {}),
    ...(hasRaw && raw.explored ? { explored: raw.explored } : {}),
    updatedAt: hasRaw ? (raw.updatedAt ?? null) : null,
  }
}

function readRawStateFile(mainRoot) {
  const primary = resolveSessionStatePath(mainRoot)
  const hit = readJsonSafe(primary, null)
  if (hit && typeof hit === 'object') return { statePath: primary, raw: hit }
  const fallback = join(resolve(String(mainRoot || process.cwd())), '.worktrees', '.state', 'session-state.json')
  if (fallback !== primary) {
    const fb = readJsonSafe(fallback, null)
    if (fb && typeof fb === 'object') return { statePath: primary, raw: fb }
  }
  return { statePath: primary, raw: null }
}

function writeLockedSessionCore(mainRoot, mutator) {
  const statePath = resolveSessionStatePath(mainRoot)
  return withFileLockSync(`${statePath}.lock`, () => {
    const { raw } = readRawStateFile(mainRoot)
    const prev = {
      schemaVersion: SESSION_SCHEMA_VERSION,
      steps: raw?.steps && typeof raw.steps === 'object' ? { ...raw.steps } : {},
      triageByTask: raw?.triageByTask && typeof raw.triageByTask === 'object' ? { ...raw.triageByTask } : {},
      ...(raw?.explored ? { explored: raw.explored } : {}),
      updatedAt: raw?.updatedAt ?? null,
    }
    const next = mutator(prev, raw)
    if (next && typeof next === 'object') {
      writeJsonAtomic(statePath, next)
    }
    return next
  })
}

export function readSessionState(mainRoot) {
  const { raw } = readRawStateFile(mainRoot)
  const perTopics = readAllPerTopicFiles(mainRoot)
  const norm = normalizeSessionState(raw, perTopics)
  if (!norm) return null
  const { _legacyTriage, ...publicState } = norm
  if (_legacyTriage) {
    Object.defineProperty(publicState, '_legacyTriage', { value: _legacyTriage, enumerable: false, configurable: true })
  }
  return publicState
}

export function recordStepState(mainRoot, { step, ok = true, summary = '', meta = {} } = {}) {
  const stepKey = String(step ?? '').trim().toUpperCase()
  if (!stepKey) return null
  return writeLockedSessionCore(mainRoot, (prev) => {
    const now = new Date().toISOString()
    return {
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
  })
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

  const nextCore = writeLockedSessionCore(mainRoot, (prev) => ({
    ...prev,
    schemaVersion: SESSION_SCHEMA_VERSION,
    triageByTask: { ...(prev.triageByTask ?? {}), [mapKey]: entry },
    updatedAt: now,
  }))

  if (cleanTopic) {
    const legacyTopics = extractLegacyEmbeddedTopics(readRawStateFile(mainRoot).raw)
    const legacyKey = findTopicKey(legacyTopics, cleanTopic)
    writeTopicFileLocked(mainRoot, cleanTopic, (cur, tid) => {
      const base = cur ? { ...cur } : emptyTopicState(tid, topic)
      base.triage = entry
      base.updatedAt = now
      return base
    }, { legacySeed: legacyKey ? legacyTopics[legacyKey] : null })
  }
  return nextCore
}

/** 严格按 topic / taskId / slug 隔离标记 triage 消费，绝不误消费其他主题记录。 */
export function markTriageConsumed(mainRoot, { taskId = null, slug = null, topic = null, terminal = false } = {}) {
  try {
    const cleanTask = taskId ? String(taskId).trim() : null
    const cleanSlug = slug ? String(slug).trim() : null
    const cleanTopic = topic ? normalizeTopicId(topic) : null
    if (!cleanTask && !cleanSlug && !cleanTopic) return readSessionState(mainRoot)

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

    const nextCore = writeLockedSessionCore(mainRoot, (prev) => {
      const byTask = {}
      for (const [k, v] of Object.entries(prev.triageByTask ?? {})) byTask[k] = touch(v)
      return {
        ...prev,
        schemaVersion: SESSION_SCHEMA_VERSION,
        triageByTask: byTask,
        updatedAt: new Date().toISOString(),
      }
    })

    const perTopics = readAllPerTopicFiles(mainRoot)
    for (const [tid, tObj] of Object.entries(perTopics)) {
      if (!tObj?.triage) continue
      const matchTopic = cleanTopic
        ? tid.toLowerCase() === cleanTopic.toLowerCase()
        : matchesRec(tObj.triage)
      if (matchTopic) {
        writeTopicFileLocked(mainRoot, tid, (cur) => {
          const base = cur ?? tObj
          return {
            ...base,
            triage: { ...base.triage, consumedByTaskId: consumerLabel || base.triage.consumedByTaskId, ...(terminal ? { terminal: true } : {}) },
          }
        })
      }
    }
    return nextCore
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
  const legacyTri = sess.triage ?? sess._legacyTriage ?? null
  if (legacyTri && !legacyTri.terminal && candidates.length === 0) candidates.push(legacyTri)

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

/** 读取未消费的 `init` 前讨论缓冲（多活跃主题下省略 `--topic` 仅按当前上下文精确匹配，绝不跨会话误吸收）。 */
export function readPreInitState(mainRoot, { topic = null, taskId = null, slug = null, branch = null, worktreePath = null } = {}) {
  const sess = readSessionState(mainRoot)
  if (!sess) return null
  const topics = sess.topics ?? {}
  const res = matchTopicForContext(topics, { topic, taskId, slug, branch, worktreePath })
  if (!res.matched || res.matched.consumedByTaskId || !hasTopicContent(res.matched)) return null
  return formatTopicAsPreInit(res.matched)
}

/** 读取全部未消费活跃主题（供 `session-orient.mjs` 完整渲染，无截断、无 5 主题淘汰）。 */
export function readAllActiveTopics(mainRoot) {
  const sess = readSessionState(mainRoot)
  if (!sess) return []
  return Object.values(sess.topics ?? {})
    .filter((t) => t && !t.consumedByTaskId && hasTopicContent(t))
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .map(formatTopicAsPreInit)
    .filter(Boolean)
}

/** 向独立加锁的 `<safeSlug>-<sha8>.json` 写入事实/待拍板/不做项/锚点/决策/已证伪死路（`deadEnds[]`）。 */
export function appendPreInitNote(mainRoot, {
  topic = null,
  fact = null,
  facts = [],
  resolve: resolveArgs = [],
  drop = [],
  decision = null,
  decisions = [],
  deadEnd = null,
  deadEnds = [],
  exclude = null,
  exclusions = [],
  nonGoals = [],
  anchor = null,
  anchors = [],
  open = null,
  openQuestions = [],
  reset = false,
} = {}) {
  const allCurrent = readSessionState(mainRoot)?.topics ?? {}
  const existingKey = topic ? findTopicKey(allCurrent, topic) : null
  const topicId = existingKey ?? normalizeTopicId(topic || 'default')
  const legacySeed = allCurrent[topicId] ?? null

  const factPairs = parseFactInputs([...(Array.isArray(facts) ? facts : [facts]), ...(fact ? [fact] : [])])
  let resolvedCount = 0
  let boundedTopic = null

  writeTopicFileLocked(mainRoot, topicId, (cur, tid) => {
    const prevTopic = (!reset && cur && !cur.consumedByTaskId)
      ? normalizeTopicEntry(tid, cur)
      : emptyTopicState(tid, topic || cur?.topic || tid)

    const now = new Date().toISOString()
    if (topic && String(topic).trim()) prevTopic.topic = String(topic).trim().slice(0, 240)
    for (const [k, v] of factPairs) prevTopic.facts[k] = v
    prevTopic.decisions = normalizeList([...(Array.isArray(decisions) ? decisions : []), ...(decision ? [decision] : [])], prevTopic.decisions)
    prevTopic.deadEnds = normalizeList([...(Array.isArray(deadEnds) ? deadEnds : []), ...(deadEnd ? [deadEnd] : [])], prevTopic.deadEnds)
    prevTopic.nonGoals = normalizeList([...(Array.isArray(nonGoals) ? nonGoals : []), ...(Array.isArray(exclusions) ? exclusions : []), ...(exclude ? [exclude] : [])], prevTopic.nonGoals)
    prevTopic.anchors = normalizeList([...(Array.isArray(anchors) ? anchors : []), ...(anchor ? [anchor] : [])], prevTopic.anchors)
    const incomingOpen = [...(Array.isArray(openQuestions) ? openQuestions : []), ...(open ? [open] : [])]
    prevTopic.open = normalizeOpenItems(prevTopic.open, incomingOpen)
    resolvedCount = applyResolveTokens(prevTopic, resolveArgs, now)
    applyDropTokens(prevTopic, drop)
    prevTopic.updatedAt = now
    prevTopic.consumedByTaskId = null
    prevTopic.consumedAt = null

    boundedTopic = boundTopicSize(prevTopic, TOPIC_MAX_BYTES)
    return boundedTopic
  }, { legacySeed })

  const preInit = formatTopicAsPreInit(boundedTopic) ?? { ...emptyTopicState(topicId), ...boundedTopic }
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    topicId,
    resolvedCount,
    preInit,
    topicState: boundedTopic,
    byteSize: Buffer.byteLength(JSON.stringify(boundedTopic), 'utf8'),
  }
}

/** 仅在 `doc-locate` / `repo-map` 显式传入 `--topic <id>` 时向仓外独立主题文件写入已验真路径。 */
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
  const allCurrent = readSessionState(mainRoot)?.topics ?? {}
  const key = findTopicKey(allCurrent, cleanTopic) ?? normalizeTopicId(cleanTopic)
  const legacySeed = allCurrent[key] ?? null
  let saved = null
  writeTopicFileLocked(mainRoot, key, (cur, tid) => {
    const entry = cur ? normalizeTopicEntry(tid, cur) : emptyTopicState(tid, cleanTopic)
    if (entry.briefKey === cleanKey) {
      saved = entry
      return null
    }
    entry.briefKey = cleanKey
    entry.updatedAt = entry.updatedAt ?? new Date().toISOString()
    saved = entry
    return entry
  }, { legacySeed })
  return saved
}

/** 在 `initDoc` 吸收后仅清空并标记目标主题，绝不误消费其他并行主题。 */
export function consumePreInitNotes(mainRoot, { taskId = null, slug = null, topic = null, branch = null, worktreePath = null } = {}) {
  try {
    const sess = readSessionState(mainRoot)
    const topics = sess?.topics ?? {}
    const match = matchTopicForContext(topics, { topic, taskId, slug, branch, worktreePath })
    if (!match.matchedKey || !match.matched || match.matched.consumedByTaskId || !hasTopicContent(match.matched)) {
      return null
    }
    const targetKey = match.matchedKey
    const legacySeed = topics[targetKey]
    let snapshot = null
    writeTopicFileLocked(mainRoot, targetKey, (cur, tid) => {
      const targetTopic = cur ? normalizeTopicEntry(tid, cur) : normalizeTopicEntry(tid, legacySeed)
      if (!targetTopic || targetTopic.consumedByTaskId || !hasTopicContent(targetTopic)) return null
      snapshot = formatTopicAsPreInit(targetTopic)
      const now = new Date().toISOString()
      const consumer = taskId || slug || 'init'
      return {
        ...emptyTopicState(tid, targetTopic.topic),
        triage: targetTopic.triage ? { ...targetTopic.triage, consumedByTaskId: consumer } : null,
        updatedAt: now,
        consumedByTaskId: consumer,
        consumedAt: now,
      }
    }, { legacySeed })
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
  const legacyTri = sess.triage ?? sess._legacyTriage ?? null
  const pool = [...byTask, ...(legacyTri ? [legacyTri] : [])].filter((r) => r && !r.terminal && r.planMode)
  const exact = pool.find((r) => (cleanTopic && r.topic && normalizeTopicId(r.topic).toLowerCase() === cleanTopic)
    || (cleanTask && String(r.taskId ?? '').toLowerCase() === cleanTask)
    || (cleanSlug && String(r.slug ?? '').toLowerCase() === cleanSlug))
  if (exact?.planMode) return exact.planMode
  if (cleanTopic) return null
  const unconsumed = pool.filter((r) => !r.consumedByTaskId && !r.topic && !r.taskId && !r.slug).at(-1)
  return unconsumed?.planMode ?? (legacyTri && !legacyTri.consumedByTaskId && !legacyTri.topic ? legacyTri.planMode : null) ?? null
}
