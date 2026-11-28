/**
 * visual-brief-store.mjs —— 仓外 Living Visual Brief 存储、sidecar 规范化、原型暂存与过期清理。
 *
 * 从 `visual-brief.mjs` 抽离以严守单文件 <= 600 行预算，保持 `BRIEF_SCHEMA_VERSION = 1` 兼容。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseDocFilename } from './doc-frontmatter.mjs'
import { EXIT } from './exit-codes.mjs'
import { stripHomedirLeaks } from './git-core.mjs'
import { posixPath, readJsonSafe, readTextSafe, sha256Text, writeJsonAtomic } from './git.mjs'
import { resolveGitDirFast } from './git-fast.mjs'
import { listTaskLedgers } from './ledger.mjs'
import { indexPlanDocs } from './plan-index.mjs'
import { readSessionState } from './session-state.mjs'
import { toRelPath } from './visual-layout.mjs'
import { MAX_PROTOTYPE_SRCDOC_BYTES } from './visual-render-panels.mjs'

export const BRIEF_SCHEMA_VERSION = 1
export const MAX_PROTOTYPE_FILE_BYTES = MAX_PROTOTYPE_SRCDOC_BYTES
export const ALLOWED_PROTOTYPE_SCHEMES = Object.freeze(['http:', 'https:', 'file:'])
export const SAFE_BRIEF_KEY_RE = /^[a-z0-9\u4e00-\u9fa5._-]{1,80}$/

const IMAGE_EXT_RE = /\.(?:png|jpe?g|webp|gif|svg)$/i
const HTML_EXT_RE = /\.(?:html?|xhtml)$/i
const TERMINAL_TASK_STATUSES = new Set(['cleaned', 'aborted'])
const TERMINAL_DOC_STATUSES = new Set(['implemented', 'done', 'archived', 'superseded', 'dropped'])

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

export function resolveBriefsDir(mainRoot) {
  const root = resolve(String(mainRoot || process.cwd()))
  const gitCommonDir = resolveCommonGitDir(root)
  return gitCommonDir ? join(gitCommonDir, 'project-forge-flow', 'briefs') : join(root, '.worktrees', '.state', 'briefs')
}

export function sanitizeBriefKey(raw) {
  const s = String(raw ?? '').trim().normalize('NFC').toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5._-]+/g, '-').replace(/\.{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  return s || 'default'
}

export function isValidBriefKey(raw) {
  const s = String(raw ?? '').trim()
  return Boolean(s && SAFE_BRIEF_KEY_RE.test(s) && !s.includes('..'))
}

export function deriveMasterPrdBriefKey(prdRelOrPath) {
  const raw = posixPath(String(prdRelOrPath ?? '').trim())
  if (!raw) return null
  const fn = parseDocFilename(raw)
  if (fn?.slug) return sanitizeBriefKey(fn.slug)
  const stem = basename(raw, '.md').replace(/^\d{6,8}-(?:issue\d+-)?/i, '').replace(/-prd$/i, '')
  return sanitizeBriefKey(stem || basename(raw, '.md'))
}

export function resolveBriefPaths(mainRoot, briefKey) {
  const key = sanitizeBriefKey(briefKey)
  const dir = resolveBriefsDir(mainRoot)
  return { dir, briefKey: key, jsonPath: join(dir, `${key}.json`), htmlPath: join(dir, `${key}.html`), prototypesDir: join(dir, `${key}-prototypes`) }
}

export function formatClickableFileUri(absPath) {
  return pathToFileURL(resolve(String(absPath || ''))).href
}

export { stripHomedirLeaks }

export function uniqClean(arr, existing = [], maxLen = 1200) {
  const out = [...(Array.isArray(existing) ? existing : [])]
  const seen = new Set(out)
  const incoming = Array.isArray(arr) ? arr : (arr !== undefined && arr !== null ? [arr] : [])
  for (const item of incoming) {
    const s = String(item ?? '').trim().slice(0, maxLen)
    if (s && !seen.has(s)) { seen.add(s); out.push(s) }
  }
  return out
}

export function normalizePrototypeEntry(p, idx = 0) {
  if (!p || typeof p !== 'object') return null
  const id = sanitizeBriefKey(p.id || `proto-${idx + 1}`)
  const kindRaw = String(p.kind ?? 'url').trim().toLowerCase()
  const kind = ['html', 'image', 'url'].includes(kindRaw) ? kindRaw : 'url'
  const title = String(p.title ?? id).trim().slice(0, 120) || id
  const target = String(p.target ?? '').trim()
  if (!target) return null
  return {
    id, title, kind, target,
    ...(p.stagedFile ? { stagedFile: basename(String(p.stagedFile)) } : {}),
    ...(p.sourceSkill ? { sourceSkill: String(p.sourceSkill).trim().slice(0, 80) } : {}),
    ...(p.note ? { note: String(p.note).trim().slice(0, 300) } : {}),
    selected: Boolean(p.selected),
  }
}

export function normFeatureChangesMap(rawMap) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return {}
  const out = {}
  for (const [rawId, val] of Object.entries(rawMap)) {
    const id = String(rawId ?? '').trim()
    if (!id || !val || typeof val !== 'object') continue
    const state = ['added', 'modified', 'removed', 'impacted', 'context'].includes(val.state) ? val.state : 'modified'
    out[id] = {
      state,
      ...(val.note ? { note: String(val.note).trim().slice(0, 2400) } : {}),
      ...(Array.isArray(val.noteItems) && val.noteItems.length > 0 ? { noteItems: val.noteItems.map((x) => String(x ?? '').trim()).filter(Boolean).slice(0, 24) } : {}),
      ...(val.before ? { before: String(val.before).trim().slice(0, 400) } : {}),
      ...(val.after ? { after: String(val.after).trim().slice(0, 400) } : {}),
      ...(val.reason ? { reason: String(val.reason).trim().slice(0, 400) } : {}),
      ...(val.replacementId ? { replacementId: String(val.replacementId).trim().slice(0, 120) } : {}),
      ...(val.targetDomain ? { targetDomain: String(val.targetDomain).trim().slice(0, 120) } : {}),
    }
  }
  return out
}

export function normAddedFeaturesList(rawList) {
  const out = [], seen = new Set()
  for (const item of Array.isArray(rawList) ? rawList : []) {
    const id = String(item?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, domain: String(item.domain ?? 'planned').trim() || 'planned', title: String(item.title ?? id).trim().slice(0, 120), summary: String(item.summary ?? item.description ?? '').trim().slice(0, 300), dependsOn: uniqClean(item.dependsOn ?? []) })
  }
  return out
}

export function normRemovedFeaturesList(rawList) {
  const out = [], seen = new Set()
  for (const item of Array.isArray(rawList) ? rawList : []) {
    const id = String(item?.id ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, reason: String(item.reason ?? '').trim().slice(0, 300), ...(item.replacementId ? { replacementId: String(item.replacementId).trim().slice(0, 120) } : {}) })
  }
  return out
}

export function normalizeSidecar(raw = {}, fallbackKey = 'default') {
  const briefKey = sanitizeBriefKey(raw.briefKey || fallbackKey)
  const kindRaw = String(raw.kind ?? 'topic').trim().toLowerCase()
  const kind = ['topic', 'task', 'master-prd'].includes(kindRaw) ? kindRaw : 'topic'
  const prototypes = (Array.isArray(raw.prototypes) ? raw.prototypes : []).map((p, i) => normalizePrototypeEntry(p, i)).filter(Boolean)
  return {
    schemaVersion: BRIEF_SCHEMA_VERSION,
    briefKey,
    kind,
    ...(raw.parentBriefKey ? { parentBriefKey: sanitizeBriefKey(raw.parentBriefKey) } : {}),
    title: String(raw.title ?? briefKey).trim().slice(0, 200) || briefKey,
    ...(raw.topicId ? { topicId: String(raw.topicId).trim().slice(0, 120) } : {}),
    ...(raw.taskId ? { taskId: String(raw.taskId).trim().slice(0, 120) } : {}),
    ...(raw.masterPrdRel ? { masterPrdRel: posixPath(String(raw.masterPrdRel).trim()) } : {}),
    ...(raw.prDiffBase ? { prDiffBase: String(raw.prDiffBase).trim().slice(0, 120) } : {}),
    verdict: String(raw.verdict ?? '').trim().slice(0, 500),
    goals: uniqClean(raw.goals ?? []),
    nonGoals: uniqClean(raw.nonGoals ?? []),
    affectedDomains: uniqClean(raw.affectedDomains ?? []),
    affectedFeatures: uniqClean(raw.affectedFeatures ?? []),
    featureChanges: normFeatureChangesMap(raw.featureChanges),
    addedFeatures: normAddedFeaturesList(raw.addedFeatures),
    removedFeatures: normRemovedFeaturesList(raw.removedFeatures),
    affectedFlows: uniqClean(raw.affectedFlows ?? []),
    flowDeltas: uniqClean(raw.flowDeltas ?? []),
    decisions: uniqClean(raw.decisions ?? []),
    openQuestions: uniqClean(raw.openQuestions ?? []),
    prototypes,
    confirmedAt: raw.confirmedAt ? String(raw.confirmedAt) : null,
    confirmedFingerprint: raw.confirmedFingerprint ? String(raw.confirmedFingerprint) : null,
    updatedAt: raw.updatedAt ? String(raw.updatedAt) : null,
  }
}

export function readBriefSidecar(mainRoot, briefKey) {
  if (!mainRoot || !briefKey) return null
  const raw = readJsonSafe(resolveBriefPaths(mainRoot, briefKey).jsonPath, null)
  return raw && typeof raw === 'object' ? normalizeSidecar(raw, briefKey) : null
}

export function listBriefSidecars(mainRoot) {
  const dir = resolveBriefsDir(mainRoot)
  if (!existsSync(dir)) return []
  const out = []
  try {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue
      const key = ent.name.slice(0, -5)
      const raw = readJsonSafe(join(dir, ent.name), null)
      if (raw && typeof raw === 'object') out.push(normalizeSidecar(raw, key))
    }
  } catch { /* ignore unreadable briefs dir */ }
  return out.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
}

export function computeBriefFingerprint(sidecar) {
  const n = normalizeSidecar(sidecar, sidecar?.briefKey || 'default')
  return sha256Text(JSON.stringify({
    title: n.title, verdict: n.verdict, goals: n.goals, nonGoals: n.nonGoals,
    affectedDomains: n.affectedDomains, affectedFeatures: n.affectedFeatures,
    featureChanges: n.featureChanges, addedFeatures: n.addedFeatures, removedFeatures: n.removedFeatures,
    affectedFlows: n.affectedFlows, flowDeltas: n.flowDeltas,
    decisions: n.decisions, openQuestions: n.openQuestions,
    prototypes: n.prototypes.map((p) => ({
      id: p.id, title: p.title, kind: p.kind, target: p.target,
      stagedFile: p.stagedFile ?? null, sourceSkill: p.sourceSkill ?? null, note: p.note ?? null, selected: Boolean(p.selected),
    })),
  }))
}

export function resolveConfirmedState(sidecar, fingerprint = null) {
  if (!sidecar?.confirmedAt || !sidecar?.confirmedFingerprint) return 'draft'
  return sidecar.confirmedFingerprint === (fingerprint || computeBriefFingerprint(sidecar)) ? 'confirmed' : 'stale'
}

function parsePrototypeSpec(rawSpec, fallbackTitle = '') {
  const raw = String(rawSpec ?? '').trim()
  if (!raw) throw Object.assign(new Error('INVALID_PROTOTYPE: --prototype 不能为空'), { code: 'INVALID_PROTOTYPE', exitCode: EXIT.USAGE })
  const eqIdx = raw.indexOf('=')
  const hasTitle = eqIdx > 0 && !raw.slice(0, eqIdx).includes('://') && !raw.slice(0, eqIdx).includes('/') && !raw.slice(0, eqIdx).includes('\\')
  return { parsedTitle: hasTitle ? raw.slice(0, eqIdx).trim() : String(fallbackTitle || '').trim(), rawTarget: hasTitle ? raw.slice(eqIdx + 1).trim() : raw }
}

function stageLocalPrototypeFile({ mainRoot, briefKey, absPath, rawTarget, id, title, sourceSkill, note, existingCount }) {
  const st = statSync(absPath)
  if (!st.isFile()) throw Object.assign(new Error(`INVALID_PROTOTYPE: "${rawTarget}" 不是普通文件`), { code: 'INVALID_PROTOTYPE', exitCode: EXIT.USAGE })
  if (st.size > MAX_PROTOTYPE_FILE_BYTES) {
    throw Object.assign(
      new Error(`BLOCKED_PROTOTYPE_TOO_LARGE: 本地原型 "${basename(absPath)}" 体积 ${st.size} B 超过 ${MAX_PROTOTYPE_FILE_BYTES} B (512 KB) 上限。`),
      { code: 'BLOCKED_PROTOTYPE_TOO_LARGE', exitCode: EXIT.FACT },
    )
  }
  const ext = extname(absPath).toLowerCase()
  const kind = IMAGE_EXT_RE.test(ext) ? 'image' : (HTML_EXT_RE.test(ext) ? 'html' : 'html')
  const safeBase = `${id}${ext || (kind === 'image' ? '.png' : '.html')}`
  const { prototypesDir } = resolveBriefPaths(mainRoot, briefKey)
  mkdirSync(prototypesDir, { recursive: true })
  copyFileSync(absPath, join(prototypesDir, safeBase))
  return normalizePrototypeEntry({
    id, title: title || basename(absPath), kind,
    target: toRelPath(rawTarget) || basename(absPath),
    stagedFile: safeBase, sourceSkill, note, selected: false,
  }, existingCount)
}

/** 校验并暂存宿主中立 UI 原型附件（仅允许 http/https/file 白名单，本地单文件 <= 512 KB）。 */
export function stagePrototypeAttachment({ mainRoot, workRoot = mainRoot, briefKey, rawSpec, title = '', sourceSkill = '', note = '', existingCount = 0 }) {
  const { parsedTitle, rawTarget } = parsePrototypeSpec(rawSpec, title)
  if (!rawTarget) throw Object.assign(new Error('INVALID_PROTOTYPE: 原型目标路径或 URL 不能为空'), { code: 'INVALID_PROTOTYPE', exitCode: EXIT.USAGE })
  const compact = rawTarget.replace(/[\u0000-\u0020]+/g, '')
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]+):/.exec(compact)
  const id = sanitizeBriefKey(parsedTitle || basename(rawTarget).replace(/\.[^.]+$/, '') || `proto-${existingCount + 1}`)

  if (schemeMatch) {
    const scheme = `${schemeMatch[1].toLowerCase()}:`
    if (!ALLOWED_PROTOTYPE_SCHEMES.includes(scheme)) {
      throw Object.assign(
        new Error(`BLOCKED_UNSAFE_PROTOTYPE_URI: 原型协议 "${scheme}" 不在白名单（仅允许 http: / https: / file:），已拦截。`),
        { code: 'BLOCKED_UNSAFE_PROTOTYPE_URI', exitCode: EXIT.USAGE },
      )
    }
    if (scheme === 'http:' || scheme === 'https:') {
      return normalizePrototypeEntry({ id, title: parsedTitle || rawTarget.slice(0, 60), kind: 'url', target: rawTarget, sourceSkill, note, selected: false }, existingCount)
    }
    let fileLocalAbs = null
    try { fileLocalAbs = fileURLToPath(rawTarget) } catch { fileLocalAbs = null }
    if (!fileLocalAbs || !existsSync(fileLocalAbs)) {
      return normalizePrototypeEntry({ id, title: parsedTitle || basename(rawTarget) || id, kind: 'url', target: rawTarget, sourceSkill, note, selected: false }, existingCount)
    }
    return stageLocalPrototypeFile({ mainRoot, briefKey, absPath: fileLocalAbs, rawTarget, id, title: parsedTitle, sourceSkill, note, existingCount })
  }

  const candWork = resolve(workRoot || mainRoot, rawTarget)
  const candMain = resolve(mainRoot, rawTarget)
  const absPath = existsSync(candWork) ? candWork : (existsSync(candMain) ? candMain : null)
  if (!absPath) throw Object.assign(new Error(`PROTOTYPE_NOT_FOUND: 找不到本地原型文件 "${rawTarget}"`), { code: 'PROTOTYPE_NOT_FOUND', exitCode: EXIT.USAGE })
  return stageLocalPrototypeFile({ mainRoot, briefKey, absPath, rawTarget, id, title: parsedTitle, sourceSkill, note, existingCount })
}

export function buildRenderablePrototypes(mainRoot, briefKey, sidecarPrototypes = []) {
  const { prototypesDir } = resolveBriefPaths(mainRoot, briefKey)
  const out = []
  for (const p of sidecarPrototypes) {
    const caption = [p.sourceSkill ? `来源：${p.sourceSkill}` : '', p.note || ''].filter(Boolean).join(' · ')
    if (p.kind === 'html' && p.stagedFile) {
      const stagedAbs = join(prototypesDir, basename(p.stagedFile))
      if (existsSync(stagedAbs)) {
        const buf = readFileSync(stagedAbs)
        if (buf.byteLength <= MAX_PROTOTYPE_FILE_BYTES) {
          out.push({ id: p.id, title: p.title, selected: Boolean(p.selected), kind: 'iframe', srcdoc: buf.toString('utf8'), caption })
          continue
        }
      }
    }
    if (p.kind === 'image' && p.stagedFile) {
      out.push({ id: p.id, title: p.title, selected: Boolean(p.selected), kind: 'img', src: `./${briefKey}-prototypes/${encodeURIComponent(basename(p.stagedFile))}`, caption })
      continue
    }
    out.push({ id: p.id, title: p.title, selected: Boolean(p.selected), kind: 'url', url: p.target, caption })
  }
  return out
}

export function moveBriefFiles({ mainRoot, fromKey, targetKey }) {
  const dstPaths = resolveBriefPaths(mainRoot, targetKey)
  if (fromKey && fromKey !== targetKey) {
    const srcPaths = resolveBriefPaths(mainRoot, fromKey)
    if (existsSync(srcPaths.prototypesDir)) {
      mkdirSync(dstPaths.prototypesDir, { recursive: true })
      for (const ent of readdirSync(srcPaths.prototypesDir, { withFileTypes: true })) {
        if (ent.isFile()) copyFileSync(join(srcPaths.prototypesDir, ent.name), join(dstPaths.prototypesDir, ent.name))
      }
    }
    rmSync(srcPaths.jsonPath, { force: true })
    rmSync(srcPaths.htmlPath, { force: true })
    rmSync(srcPaths.prototypesDir, { recursive: true, force: true })
  }
  mkdirSync(dstPaths.dir, { recursive: true })
  return dstPaths
}

export function writeBriefSidecar(mainRoot, briefKey, sidecar) {
  const paths = resolveBriefPaths(mainRoot, briefKey)
  mkdirSync(paths.dir, { recursive: true })
  writeJsonAtomic(paths.jsonPath, sidecar)
  return paths
}

/** 清理已终态归档或过期的仓外 Brief（供 `flow cleanup` / `flow abort` 调用）。 */
export function pruneStaleBriefs(mainRoot, { maxAgeDays = 30, taskId = null } = {}) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const all = listBriefSidecars(effMain)
  if (all.length === 0) return { pruned: [], kept: 0 }
  const ledgers = listTaskLedgers(effMain, { includeTerminal: true, includePendingCleanup: true })
  const ledgerByTask = new Map(ledgers.map((l) => [l.taskId, l]))
  const allDocs = indexPlanDocs({ repoRoot: effMain, mainRoot: effMain, includeArchive: true, includeWorktrees: false, managedOnly: true })
  const session = readSessionState(effMain)
  const cutoffMs = Date.now() - Math.max(1, Number(maxAgeDays) || 30) * 24 * 3600 * 1000
  const explicitTaskKey = taskId ? sanitizeBriefKey(taskId) : null

  const pruned = []
  let kept = 0
  for (const sc of all) {
    let shouldPrune = false
    if (explicitTaskKey && sc.kind !== 'master-prd' && (sc.taskId === taskId || sc.briefKey === explicitTaskKey || sc.parentBriefKey === explicitTaskKey)) {
      shouldPrune = true
    } else if (sc.kind === 'task' && sc.taskId) {
      const led = ledgerByTask.get(sc.taskId)
      const updatedMs = sc.updatedAt ? Date.parse(sc.updatedAt) : NaN
      if (led && TERMINAL_TASK_STATUSES.has(String(led.status ?? '').toLowerCase())) shouldPrune = true
      else if (!led && Number.isFinite(updatedMs) && updatedMs < cutoffMs) shouldPrune = true
    } else if (sc.kind === 'master-prd' && sc.masterPrdRel) {
      const prdDoc = allDocs.find((d) => d.kind === 'prd' && deriveMasterPrdBriefKey(d.rel) === sc.briefKey)
      if (prdDoc && (prdDoc.archived || TERMINAL_DOC_STATUSES.has(prdDoc.status))) {
        const hasActiveChild = ledgers.some((l) =>
          l && !TERMINAL_TASK_STATUSES.has(String(l.status ?? '').toLowerCase())
          && l.prdFile && deriveMasterPrdBriefKey(l.prdFile) === sc.briefKey)
        if (!hasActiveChild) shouldPrune = true
      }
    } else if (sc.kind === 'topic') {
      const tEntry = sc.topicId ? session?.topics?.[sc.topicId] : null
      const updatedMs = sc.updatedAt ? Date.parse(sc.updatedAt) : NaN
      const consumedLed = tEntry?.consumedByTaskId ? ledgerByTask.get(tEntry.consumedByTaskId) : null
      const consumedByTarget = Boolean(taskId && tEntry?.consumedByTaskId === taskId)
      const consumedByTerminal = Boolean(consumedLed && TERMINAL_TASK_STATUSES.has(String(consumedLed.status ?? '').toLowerCase()))
      if (consumedByTarget || consumedByTerminal || tEntry?.consumedByTaskId || (Number.isFinite(updatedMs) && updatedMs < cutoffMs)) {
        shouldPrune = true
      }
    }

    if (shouldPrune) {
      const p = resolveBriefPaths(effMain, sc.briefKey)
      rmSync(p.jsonPath, { force: true })
      rmSync(p.htmlPath, { force: true })
      rmSync(p.prototypesDir, { recursive: true, force: true })
      pruned.push(sc.briefKey)
    } else {
      kept += 1
    }
  }
  return { pruned, kept }
}
