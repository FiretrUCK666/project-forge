/**
 * visual-brief.mjs —— 仓外 Single-Truth 实时投影 Living Visual Brief 引擎与宿主中立 UI 原型挂载。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/）。
 * 存储于 `<gitCommonDir>/project-forge-flow/briefs/<briefKey>.{json,html}` 与 `<briefKey>-prototypes/`
 * （非 Git 目录回退 `<mainRoot>/.worktrees/.state/briefs/`），不污染工作区 `git status`。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { parseCritiqueRounds, readPlanCritiqueEntrySync } from './critique-rounds.mjs'
import { parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { buildSliceGraph, evaluateSliceGraph } from './doc-slice-graph.mjs'
import { EXIT } from './exit-codes.mjs'
import { FEATURE_MAP_REL, readFeatureMapStatus } from './feature-map.mjs'
import { computeFeatureMapFingerprint } from './feature-map-graph.mjs'
import { posixPath, readJsonSafe, readTextSafe, sha256Text, writeAtomic, writeJsonAtomic } from './git.mjs'
import { resolveGitDirFast } from './git-fast.mjs'
import { listTaskLedgers } from './ledger.mjs'
import { analyzePendingDecisions } from './pending-decisions.mjs'
import { indexPlanDocs, isPlanDocApproved } from './plan-index.mjs'
import { readSessionState, setTopicBriefKey } from './session-state.mjs'
import { buildVisualModel, toRelPath } from './visual-layout.mjs'
import { MAX_PROTOTYPE_SRCDOC_BYTES, renderVisualHtml } from './visual-render.mjs'

export const BRIEF_SCHEMA_VERSION = 1
export const MAX_PROTOTYPE_FILE_BYTES = MAX_PROTOTYPE_SRCDOC_BYTES
export const ALLOWED_PROTOTYPE_SCHEMES = Object.freeze(['http:', 'https:', 'file:'])

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

function stripHomedirLeaks(text) {
  const raw = String(homedir() || '').trim()
  let out = String(text ?? '')
  if (raw.length < 4) return out
  const markers = [...new Set([raw.replace(/\\/g, '/').replace(/\/+$/, ''), raw.replace(/\//g, '\\').replace(/\\+$/, '')])]
  for (const m of markers) if (m.length >= 4 && out.includes(m)) out = out.split(m).join('~')
  return out
}

function uniqClean(arr, existing = [], maxLen = 400) {
  const out = [...(Array.isArray(existing) ? existing : [])]
  const seen = new Set(out)
  const incoming = Array.isArray(arr) ? arr : (arr !== undefined && arr !== null ? [arr] : [])
  for (const item of incoming) {
    const s = String(item ?? '').trim().slice(0, maxLen)
    if (s && !seen.has(s)) { seen.add(s); out.push(s) }
  }
  return out
}

function normalizePrototypeEntry(p, idx = 0) {
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
    verdict: String(raw.verdict ?? '').trim().slice(0, 500),
    goals: uniqClean(raw.goals ?? []),
    nonGoals: uniqClean(raw.nonGoals ?? []),
    affectedDomains: uniqClean(raw.affectedDomains ?? []),
    affectedFeatures: uniqClean(raw.affectedFeatures ?? []),
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

function loadFeatureMapWithPrecedence(mainRoot, workRoot) {
  const effWork = workRoot ? resolve(workRoot) : null
  const effMain = resolve(mainRoot)
  if (effWork && existsSync(join(effWork, FEATURE_MAP_REL))) {
    const st = readFeatureMapStatus(effWork)
    if (st.exists && !st.corrupt && st.raw) return { raw: st.raw, source: 'workRoot', root: effWork }
  }
  if (existsSync(join(effMain, FEATURE_MAP_REL))) {
    const st = readFeatureMapStatus(effMain)
    if (st.exists && !st.corrupt && st.raw) return { raw: st.raw, source: 'mainRoot', root: effMain }
  }
  return { raw: { version: 2, domains: [], features: [], flows: [] }, source: 'none', root: effWork || effMain }
}

function buildRenderablePrototypes(mainRoot, briefKey, sidecarPrototypes = []) {
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

/** Single-Truth Live Projection：`workRoot` 优先读 `feature-map.json`，实时聚合 1:N PRD、切片、Worktree、账本、待拍板与 Critique。 */
export function projectVisualBriefViewModel({ mainRoot, workRoot = mainRoot, sidecar }) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const effWork = resolve(String(workRoot || effMain))
  const norm = normalizeSidecar(sidecar, sidecar?.briefKey || 'default')
  const { raw: featureMap, source: featureMapSource } = loadFeatureMapWithPrecedence(effMain, effWork)
  const featureMapSha256 = computeFeatureMapFingerprint(featureMap)

  const allDocs = indexPlanDocs({ repoRoot: effWork, mainRoot: effMain, includeArchive: true, includeWorktrees: true, managedOnly: true })
  const sliceGraph = buildSliceGraph(effWork)
  const sliceEval = evaluateSliceGraph(effWork, { graph: sliceGraph, closing: false })
  const ledgers = listTaskLedgers(effMain, { includeTerminal: true, includePendingCleanup: true })
  const session = readSessionState(effMain)

  const liveTopic = norm.topicId && session?.topics?.[norm.topicId] ? session.topics[norm.topicId] : null
  const mergedDecisions = uniqClean([...(liveTopic?.decisions ?? []), ...norm.decisions])
  const mergedNonGoals = uniqClean([...(liveTopic?.nonGoals ?? []), ...norm.nonGoals])
  const mergedOpen = uniqClean([
    ...((liveTopic?.open ?? []).filter((o) => o && o.status !== 'resolved').map((o) => o.text)),
    ...norm.openQuestions,
  ])
  const topicAnchors = uniqClean(liveTopic?.anchors ?? [])

  const matchingMasterPrd = allDocs.find((d) =>
    d.kind === 'prd' && (
      (norm.masterPrdRel && posixPath(d.rel) === posixPath(norm.masterPrdRel))
      || (norm.kind === 'master-prd' && deriveMasterPrdBriefKey(d.rel) === norm.briefKey)
      || (norm.parentBriefKey && deriveMasterPrdBriefKey(d.rel) === norm.parentBriefKey)
    )) ?? null

  const masterRel = matchingMasterPrd?.rel ?? norm.masterPrdRel ?? null
  const childSlices = masterRel
    ? sliceGraph.slices
        .filter((s) => s.kind === 'spec' && s.masterRel && posixPath(s.masterRel) === posixPath(masterRel))
        .map((s) => ({ key: s.key, rel: s.rel, status: s.status, done: s.done, dependsOn: s.dependsOn, scopeCount: s.scopeFiles.length }))
    : []

  const relevantDocs = allDocs.filter((d) => !d.archived && (
    (norm.taskId && d.taskId === norm.taskId)
    || (masterRel && posixPath(d.rel) === posixPath(masterRel))
    || (masterRel && d.kind === 'spec' && typeof d.data?.related_prd === 'string' && d.data.related_prd.includes(basename(masterRel)))
  ))

  const livePendingDecisions = []
  const liveCritiqueRounds = []
  for (const d of relevantDocs) {
    for (const u of analyzePendingDecisions(d.text).unresolved ?? []) {
      livePendingDecisions.push({ file: d.rel, line: u.line, text: u.text })
    }
    const { entry } = readPlanCritiqueEntrySync({
      repoRoot: d.root || effWork, mainRoot: effMain, taskId: d.taskId ?? norm.taskId ?? null, fmData: d.data, relDoc: d.rel,
    })
    const rounds = parseCritiqueRounds(d.data, d.text, entry)
    if (rounds.length > 0) {
      liveCritiqueRounds.push({ file: d.rel, rounds: rounds.length, lastVerdict: rounds[rounds.length - 1].verdict ?? 'unknown', approved: isPlanDocApproved(d) })
    }
  }

  const activeWorktrees = ledgers
    .filter((l) => l && !TERMINAL_TASK_STATUSES.has(String(l.status ?? '').toLowerCase()) && l.worktreePath)
    .map((l) => ({ taskId: l.taskId, status: l.status, branch: l.branch ?? null, worktreePath: l.worktreePath }))

  const briefFingerprint = computeBriefFingerprint(norm)
  const confirmedState = resolveConfirmedState(norm, briefFingerprint)
  const featureList = Array.isArray(featureMap?.features) ? featureMap.features : []
  const domainAffected = norm.affectedDomains.length > 0 ? featureList.filter((f) => norm.affectedDomains.includes(f?.domain)).map((f) => f.id) : []
  const modifiedFeatureIds = uniqClean([...norm.affectedFeatures, ...domainAffected])
  const verdictStatus = confirmedState === 'confirmed' ? '已确认' : (confirmedState === 'stale' ? '待重审' : '草稿')
  const verdictSummary = norm.verdict || (confirmedState === 'stale'
    ? '简报在确认后发生变更，请复核更新并重新确认。'
    : `${norm.title} — ${mergedDecisions.length} 项已拍板，${mergedOpen.length + livePendingDecisions.length} 项待确认，${childSlices.length} 个切片。`)

  const walkthrough = [
    ...norm.goals.map((detail) => ({ targetId: modifiedFeatureIds[0] || '', title: '目标', detail })),
    ...norm.flowDeltas.map((detail) => ({ targetId: modifiedFeatureIds[0] || '', title: '流程变化', detail })),
    ...mergedDecisions.map((detail) => ({ targetId: modifiedFeatureIds[0] || '', title: '已拍板决策', detail })),
    ...childSlices.map((sl) => ({ targetId: modifiedFeatureIds[0] || '', title: `切片：${sl.key}`, detail: `${sl.rel}（${sl.status}）` })),
    ...mergedOpen.map((detail) => ({ targetId: modifiedFeatureIds[0] || '', title: '待确认问题', detail })),
    ...livePendingDecisions.map((pd) => ({ targetId: modifiedFeatureIds[0] || '', title: `待拍板（${pd.file}）`, detail: pd.text })),
  ]

  const masterPrdInfo = matchingMasterPrd ? { rel: matchingMasterPrd.rel, status: matchingMasterPrd.status, approved: isPlanDocApproved(matchingMasterPrd) } : null
  const visualModel = buildVisualModel({
    featureMap,
    diffOverlay: { modified: modifiedFeatureIds, changedFiles: topicAnchors },
    mode: 'visual-brief',
    title: `${norm.title} — 实时规划简报`,
    briefSpec: {
      repoName: norm.title,
      title: `${norm.title} — 实时规划简报`,
      verdict: { status: verdictStatus, tone: confirmedState === 'confirmed' ? 'pass' : 'warn', summary: verdictSummary },
      scopeChips: [
        `简报:${norm.briefKey}`, `类型:${norm.kind}`, `状态:${verdictStatus}`, `拓扑:${featureMapSource}`,
        ...(norm.parentBriefKey ? [`父简报:${norm.parentBriefKey}`] : []),
        ...(childSlices.length > 0 ? [`切片:${childSlices.filter((s) => s.done).length}/${childSlices.length}`] : []),
        `原型:${norm.prototypes.length}`,
      ],
      metrics: [
        { label: '状态', value: verdictStatus },
        { label: '受影响模块', value: String(modifiedFeatureIds.length) },
        { label: '已拍板', value: String(mergedDecisions.length) },
        { label: '待确认', value: String(mergedOpen.length + livePendingDecisions.length) },
        { label: '切片进度', value: `${childSlices.filter((s) => s.done).length}/${childSlices.length}` },
        { label: '方案原型', value: String(norm.prototypes.length) },
      ],
      walkthrough: walkthrough.length > 0 ? walkthrough : undefined,
      prototypes: buildRenderablePrototypes(effMain, norm.briefKey, norm.prototypes),
      briefData: {
        kind: norm.kind,
        confirmedState,
        verdict: verdictSummary,
        goals: norm.goals,
        nonGoals: mergedNonGoals,
        flowDeltas: norm.flowDeltas,
        masterPrd: masterPrdInfo,
        childSlices,
        activeWorktrees,
        mergedDecisions,
        mergedOpen,
        pendingDecisions: livePendingDecisions,
        critiqueRounds: liveCritiqueRounds,
      },
    },
  })

  return {
    sidecar: norm, briefFingerprint, confirmedState, featureMapSource, featureMapSha256,
    liveProjection: {
      masterPrd: masterPrdInfo,
      childSlices, sliceGraphOk: sliceEval.ok, sliceGraphErrors: sliceEval.errors.length,
      activeWorktrees, pendingDecisions: livePendingDecisions, critiqueRounds: liveCritiqueRounds,
      mergedDecisions, mergedNonGoals, mergedOpen,
    },
    visualModel,
  }
}

export function renderVisualBrief({ mainRoot, workRoot = mainRoot, sidecar }) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const projected = projectVisualBriefViewModel({ mainRoot: effMain, workRoot, sidecar })
  const rendered = renderVisualHtml({ visualModel: projected.visualModel, featureMapSha256: projected.featureMapSha256, mode: 'visual-brief' })
  const cleanHtml = stripHomedirLeaks(rendered.html)
  const paths = resolveBriefPaths(effMain, projected.sidecar.briefKey)
  mkdirSync(paths.dir, { recursive: true })
  writeAtomic(paths.htmlPath, cleanHtml)
  return { ...projected, htmlPath: paths.htmlPath, htmlUri: formatClickableFileUri(paths.htmlPath), jsonPath: paths.jsonPath, bytes: Buffer.byteLength(cleanHtml, 'utf8') }
}

export function buildBriefSummaryObject(mainRoot, sidecar, extra = {}) {
  if (!sidecar) return null
  const paths = resolveBriefPaths(mainRoot, sidecar.briefKey)
  const fp = extra.briefFingerprint || computeBriefFingerprint(sidecar)
  const confirmedState = extra.confirmedState || resolveConfirmedState(sidecar, fp)
  const selected = (sidecar.prototypes ?? []).find((p) => p.selected) ?? null
  return {
    briefKey: sidecar.briefKey, kind: sidecar.kind,
    ...(sidecar.parentBriefKey ? { parentBriefKey: sidecar.parentBriefKey } : {}),
    title: sidecar.title, confirmedState, confirmedAt: sidecar.confirmedAt ?? null, briefFingerprint: fp,
    htmlPath: paths.htmlPath, htmlUri: formatClickableFileUri(paths.htmlPath), jsonPath: paths.jsonPath,
    prototypeCount: (sidecar.prototypes ?? []).length, selectedPrototypeId: selected?.id ?? null,
    updatedAt: sidecar.updatedAt ?? null,
    ...(extra.featureMapSource ? { featureMapSource: extra.featureMapSource } : {}),
  }
}

export function upsertVisualBrief(mainRoot, {
  workRoot = mainRoot, briefKey, kind, parentBriefKey, title, topicId, taskId, masterPrdRel,
  verdict, goals, nonGoals, affectedDomains, affectedFeatures, affectedFlows, flowDeltas,
  decisions, openQuestions, prototypesToAdd = [], selectPrototypeId = null, sourceSkill = '', prototypeNote = '', confirm = false,
} = {}) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const key = sanitizeBriefKey(briefKey || taskId || topicId || (masterPrdRel ? deriveMasterPrdBriefKey(masterPrdRel) : null) || 'default')
  const paths = resolveBriefPaths(effMain, key)
  const existing = readBriefSidecar(effMain, key)
  const now = new Date().toISOString()

  const next = normalizeSidecar({
    ...(existing ?? {}),
    briefKey: key,
    kind: kind || existing?.kind || (masterPrdRel && !taskId ? 'master-prd' : (taskId ? 'task' : 'topic')),
    ...(parentBriefKey !== undefined ? { parentBriefKey } : (existing?.parentBriefKey ? { parentBriefKey: existing.parentBriefKey } : {})),
    title: title || existing?.title || key,
    ...(topicId ? { topicId } : (existing?.topicId ? { topicId: existing.topicId } : {})),
    ...(taskId ? { taskId } : (existing?.taskId ? { taskId: existing.taskId } : {})),
    ...(masterPrdRel ? { masterPrdRel } : (existing?.masterPrdRel ? { masterPrdRel: existing.masterPrdRel } : {})),
    verdict: verdict !== undefined && verdict !== null && String(verdict).trim() !== '' ? String(verdict).trim() : (existing?.verdict ?? ''),
    goals: uniqClean(goals ?? [], existing?.goals ?? []),
    nonGoals: uniqClean(nonGoals ?? [], existing?.nonGoals ?? []),
    affectedDomains: uniqClean(affectedDomains ?? [], existing?.affectedDomains ?? []),
    affectedFeatures: uniqClean(affectedFeatures ?? [], existing?.affectedFeatures ?? []),
    affectedFlows: uniqClean(affectedFlows ?? [], existing?.affectedFlows ?? []),
    flowDeltas: uniqClean(flowDeltas ?? [], existing?.flowDeltas ?? []),
    decisions: uniqClean(decisions ?? [], existing?.decisions ?? []),
    openQuestions: uniqClean(openQuestions ?? [], existing?.openQuestions ?? []),
    prototypes: [...(existing?.prototypes ?? [])],
    confirmedAt: existing?.confirmedAt ?? null,
    confirmedFingerprint: existing?.confirmedFingerprint ?? null,
    updatedAt: now,
  }, key)

  for (const rawProto of Array.isArray(prototypesToAdd) ? prototypesToAdd : (prototypesToAdd ? [prototypesToAdd] : [])) {
    const staged = stagePrototypeAttachment({
      mainRoot: effMain, workRoot, briefKey: key, rawSpec: rawProto, sourceSkill, note: prototypeNote, existingCount: next.prototypes.length,
    })
    const idx = next.prototypes.findIndex((p) => p.id === staged.id)
    if (idx >= 0) next.prototypes[idx] = { ...staged, selected: next.prototypes[idx].selected }
    else next.prototypes.push(staged)
  }

  if (selectPrototypeId) {
    const want = sanitizeBriefKey(selectPrototypeId)
    const hit = next.prototypes.find((p) => p.id === want || p.id === selectPrototypeId || p.title.toLowerCase() === String(selectPrototypeId).trim().toLowerCase())
    if (!hit) {
      throw Object.assign(
        new Error(`PROTOTYPE_ID_NOT_FOUND: 未找到原型 "${selectPrototypeId}"（可用：${next.prototypes.map((p) => p.id).join(', ') || '无'}）`),
        { code: 'PROTOTYPE_ID_NOT_FOUND', exitCode: EXIT.USAGE },
      )
    }
    next.prototypes = next.prototypes.map((p) => ({ ...p, selected: p.id === hit.id }))
  }

  const fp = computeBriefFingerprint(next)
  if (confirm) { next.confirmedAt = now; next.confirmedFingerprint = fp }
  mkdirSync(paths.dir, { recursive: true })
  writeJsonAtomic(paths.jsonPath, next)
  if (next.topicId) { try { setTopicBriefKey(effMain, next.topicId, key) } catch { /* non-fatal */ } }

  const rendered = renderVisualBrief({ mainRoot: effMain, workRoot, sidecar: next })
  return {
    ok: true, briefKey: key, sidecar: next,
    summary: buildBriefSummaryObject(effMain, next, rendered),
    liveProjection: rendered.liveProjection, bytes: rendered.bytes,
    htmlPath: rendered.htmlPath, htmlUri: rendered.htmlUri, jsonPath: rendered.jsonPath,
  }
}

function persistAndMoveBrief({ mainRoot, workRoot, fromKey, targetKey, sidecar, moveFromSource }) {
  const dstPaths = resolveBriefPaths(mainRoot, targetKey)
  if (moveFromSource && fromKey && fromKey !== targetKey) {
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
  writeJsonAtomic(dstPaths.jsonPath, sidecar)
  const rendered = renderVisualBrief({ mainRoot, workRoot, sidecar })
  return {
    migrated: Boolean(moveFromSource && fromKey && fromKey !== targetKey),
    fromKey: moveFromSource ? fromKey : null,
    briefKey: targetKey,
    kind: sidecar.kind,
    parentBriefKey: sidecar.parentBriefKey ?? null,
    summary: buildBriefSummaryObject(mainRoot, sidecar, rendered),
  }
}

/** 1:N 与多 Worktree 归属迁移（standalone -> taskId；master-prd -> prd-slug；child slice 派生 parentBriefKey 且绝不覆写父 PRD Brief）。 */
export function migrateVisualBriefOnInit({
  mainRoot, workRoot = mainRoot, topicId = null, existingBriefKey = null, taskId = null, slug = null,
  kind = 'spec', multiSpec = false, prdRel = null, relatedPrdRel = null, title = '',
} = {}) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const sourceKey = existingBriefKey ? sanitizeBriefKey(existingBriefKey) : (topicId ? sanitizeBriefKey(topicId) : null)
  const sourceSidecar = sourceKey ? readBriefSidecar(effMain, sourceKey) : null
  const isMasterPrd = kind === 'prd' && Boolean(multiSpec) && Boolean(prdRel)
  const isChildSlice = !isMasterPrd && Boolean(relatedPrdRel)
  const now = new Date().toISOString()

  if (isMasterPrd) {
    const targetKey = deriveMasterPrdBriefKey(prdRel)
    if (!targetKey || (!sourceSidecar && !topicId)) return null
    const merged = normalizeSidecar({
      ...(sourceSidecar ?? {}), briefKey: targetKey, kind: 'master-prd',
      title: title || sourceSidecar?.title || targetKey,
      topicId: topicId ?? sourceSidecar?.topicId ?? null,
      masterPrdRel: posixPath(prdRel), updatedAt: now,
    }, targetKey)
    return persistAndMoveBrief({ mainRoot: effMain, workRoot, fromKey: sourceKey, targetKey, sidecar: merged, moveFromSource: Boolean(sourceSidecar) })
  }

  if (isChildSlice) {
    const parentBriefKey = deriveMasterPrdBriefKey(relatedPrdRel)
    let targetKey = sanitizeBriefKey(taskId || slug || 'slice')
    if (parentBriefKey && targetKey === parentBriefKey) targetKey = sanitizeBriefKey(`${targetKey}-slice`)
    const canMigrateTopic = Boolean(sourceSidecar && sourceSidecar.kind === 'topic' && sourceKey !== parentBriefKey && sourceKey !== targetKey)
    const base = canMigrateTopic ? sourceSidecar : readBriefSidecar(effMain, targetKey)
    const childSidecar = normalizeSidecar({
      ...(base ?? {}), briefKey: targetKey, kind: 'task',
      ...(parentBriefKey ? { parentBriefKey } : {}),
      title: title || base?.title || targetKey, taskId: taskId || slug || targetKey,
      masterPrdRel: posixPath(relatedPrdRel), updatedAt: now,
    }, targetKey)
    const res = persistAndMoveBrief({ mainRoot: effMain, workRoot, fromKey: sourceKey, targetKey, sidecar: childSidecar, moveFromSource: canMigrateTopic })
    if (parentBriefKey) {
      const parentSidecar = readBriefSidecar(effMain, parentBriefKey)
      if (parentSidecar) { try { renderVisualBrief({ mainRoot: effMain, workRoot, sidecar: parentSidecar }) } catch { /* non-fatal */ } }
    }
    return res
  }

  if (!sourceSidecar) return null
  const targetKey = sanitizeBriefKey(taskId || slug || sourceKey)
  const merged = normalizeSidecar({
    ...sourceSidecar, briefKey: targetKey, kind: 'task',
    title: title || sourceSidecar.title || targetKey, taskId: taskId || slug || targetKey, updatedAt: now,
  }, targetKey)
  return persistAndMoveBrief({ mainRoot: effMain, workRoot, fromKey: sourceKey, targetKey, sidecar: merged, moveFromSource: true })
}

/** 根据文档变更（clarify / approve）刷新关联 Brief；记录新决策时自然推进指纹触发 stale。 */
export function refreshVisualBriefForDoc({ mainRoot, workRoot = mainRoot, file = null, taskId = null, addedDecision = '' } = {}) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const effWork = resolve(String(workRoot || effMain))
  let targetKey = null
  let fmData = {}
  if (file) {
    const raw = readTextSafe(resolve(effWork, file)) ?? readTextSafe(resolve(effMain, file)) ?? ''
    fmData = parseDocFrontmatter(raw)?.data ?? {}
  }
  const candTask = taskId || fmData?.task_id || null
  if (candTask && readBriefSidecar(effMain, candTask)) targetKey = sanitizeBriefKey(candTask)
  else if (file && String(fmData?.kind ?? '').toLowerCase() === 'prd') {
    const prdKey = deriveMasterPrdBriefKey(file)
    if (prdKey && readBriefSidecar(effMain, prdKey)) targetKey = prdKey
  } else if (file) {
    const fn = parseDocFilename(file)
    if (fn?.slug && readBriefSidecar(effMain, fn.slug)) targetKey = sanitizeBriefKey(fn.slug)
  }
  if (!targetKey) return null
  if (addedDecision) return upsertVisualBrief(effMain, { workRoot: effWork, briefKey: targetKey, decisions: [addedDecision] })
  const sidecar = readBriefSidecar(effMain, targetKey)
  if (!sidecar) return null
  const rendered = renderVisualBrief({ mainRoot: effMain, workRoot: effWork, sidecar })
  return { ok: true, briefKey: targetKey, summary: buildBriefSummaryObject(effMain, sidecar, rendered) }
}

/** 仅在 `doc-locate --topic` / `repo-map --topic` 显式传入 `--topic` 时刷新仓外 Brief（零仓内写入）。 */
export function refreshVisualBriefForTopic({ mainRoot, workRoot = mainRoot, topicId, anchors = [] } = {}) {
  const cleanTopic = String(topicId ?? '').trim()
  if (!cleanTopic) return null
  const effMain = resolve(String(mainRoot || process.cwd()))
  const effWork = resolve(String(workRoot || effMain))
  const key = sanitizeBriefKey(cleanTopic)
  const existing = readBriefSidecar(effMain, key)
  const { raw: fm } = loadFeatureMapWithPrecedence(effMain, effWork)
  const anchorSet = new Set(uniqClean(anchors).map((a) => posixPath(a)))
  const hitFeatures = (Array.isArray(fm?.features) ? fm.features : [])
    .filter((f) => [...(f?.entrypoints ?? []), ...(f?.modules ?? []), ...(f?.tests ?? [])].some((p) => anchorSet.has(posixPath(p))))
    .map((f) => f.id)
  return upsertVisualBrief(effMain, {
    workRoot: effWork, briefKey: existing?.briefKey ?? key, kind: existing?.kind ?? 'topic',
    topicId: cleanTopic, title: existing?.title ?? cleanTopic, affectedFeatures: hitFeatures,
  })
}

export function getVisualBriefSummary(mainRoot, { briefKey = null, taskId = null, topicId = null, masterPrdRel = null } = {}) {
  if (!mainRoot) return null
  const effMain = resolve(String(mainRoot))
  const candidates = [briefKey, taskId, topicId, masterPrdRel ? deriveMasterPrdBriefKey(masterPrdRel) : null]
    .filter(Boolean).map((k) => sanitizeBriefKey(k))
  for (const cand of [...new Set(candidates)]) {
    const sidecar = readBriefSidecar(effMain, cand)
    if (sidecar) return buildBriefSummaryObject(effMain, sidecar)
  }
  if (!briefKey && !taskId && !topicId && !masterPrdRel) {
    const all = listBriefSidecars(effMain)
    if (all.length > 0) return buildBriefSummaryObject(effMain, all[0])
  }
  return null
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
    if (explicitTaskKey && sc.kind !== 'master-prd' && (sc.taskId === taskId || sc.briefKey === explicitTaskKey)) {
      shouldPrune = true
    } else if (sc.kind === 'task' && sc.taskId) {
      const led = ledgerByTask.get(sc.taskId)
      if (led && TERMINAL_TASK_STATUSES.has(String(led.status ?? '').toLowerCase())) shouldPrune = true
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
      if (tEntry?.consumedByTaskId || (Number.isFinite(updatedMs) && updatedMs < cutoffMs)) shouldPrune = true
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
