/**
 * visual-brief.mjs —— 仓外 Single-Truth 实时投影 Living Visual Brief 引擎。
 *
 * 存储、sidecar 规范化、原型暂存与过期清理已拆入 `visual-brief-store.mjs`，
 * 本文件专注实时投影、真实每步导览目标解析、`?from=` 父子简报互链与 3-dot PR diff 接入。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { parseCritiqueRounds, readPlanCritiqueEntrySync } from './critique-rounds.mjs'
import { parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { buildSliceGraph, evaluateSliceGraph } from './doc-slice-graph.mjs'
import { EXIT } from './exit-codes.mjs'
import { FEATURE_MAP_REL, readFeatureMapStatus } from './feature-map.mjs'
import { computeFeatureMapFingerprint } from './feature-map-graph.mjs'
import { posixPath, readTextSafe, writeAtomic } from './git.mjs'
import { listTaskLedgers } from './ledger.mjs'
import { analyzePendingDecisions } from './pending-decisions.mjs'
import { indexPlanDocs, isPlanDocApproved } from './plan-index.mjs'
import { readSessionState, setTopicBriefKey } from './session-state.mjs'
import { collectRepoVisualEvidenceSync } from './architecture-map.mjs'
import { extractPlanDocProjection, selectRelevantPlanDocs } from './visual-brief-doc-extract.mjs'
import {
  ALLOWED_PROTOTYPE_SCHEMES,
  BRIEF_SCHEMA_VERSION,
  buildRenderablePrototypes,
  computeBriefFingerprint,
  deriveMasterPrdBriefKey,
  formatClickableFileUri,
  isValidBriefKey,
  listBriefSidecars,
  MAX_PROTOTYPE_FILE_BYTES,
  moveBriefFiles,
  normAddedFeaturesList,
  normalizeSidecar,
  normFeatureChangesMap,
  normRemovedFeaturesList,
  pruneStaleBriefs,
  readBriefSidecar,
  resolveBriefPaths,
  resolveBriefsDir,
  resolveConfirmedState,
  SAFE_BRIEF_KEY_RE,
  sanitizeBriefKey,
  stagePrototypeAttachment,
  stripHomedirLeaks,
  uniqClean,
  writeBriefSidecar,
} from './visual-brief-store.mjs'
import { buildVisualModel } from './visual-layout.mjs'
import { renderVisualHtml } from './visual-render.mjs'

export {
  ALLOWED_PROTOTYPE_SCHEMES,
  BRIEF_SCHEMA_VERSION,
  computeBriefFingerprint,
  deriveMasterPrdBriefKey,
  formatClickableFileUri,
  isValidBriefKey,
  listBriefSidecars,
  MAX_PROTOTYPE_FILE_BYTES,
  normalizeSidecar,
  pruneStaleBriefs,
  readBriefSidecar,
  resolveBriefPaths,
  resolveBriefsDir,
  resolveConfirmedState,
  SAFE_BRIEF_KEY_RE,
  sanitizeBriefKey,
  stagePrototypeAttachment,
}

const TERMINAL_TASK_STATUSES = new Set(['cleaned', 'aborted'])

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

/** 为每一步导览按语义/ID/文件名匹配真实目标节点与所属视图，根治旧版全部硬绑 `modifiedFeatureIds[0]` 缺陷。 */
export function resolveWalkthroughTarget({ text = '', stepIdx = 0, candidateIds = [], featureList = [], preferredId = '' }) {
  if (preferredId && featureList.some((f) => f.id === preferredId)) return preferredId
  const haystack = String(text || '').toLowerCase()
  const rankedFeatures = [
    ...featureList.filter((f) => candidateIds.includes(f.id)),
    ...featureList.filter((f) => !candidateIds.includes(f.id)),
  ]
  for (const f of rankedFeatures) {
    const fid = String(f.id || '').toLowerCase()
    const title = String(f.title || f.name || '').toLowerCase()
    if (fid && haystack.includes(fid)) return f.id
    if (title && title.length >= 2 && haystack.includes(title)) return f.id
    const paths = [...(f.entrypoints || []), ...(f.modules || [])]
    if (paths.some((p) => p && haystack.includes(String(p).toLowerCase()))) return f.id
  }
  if (candidateIds.length > 0) return candidateIds[stepIdx % candidateIds.length]
  if (featureList.length > 0) return featureList[stepIdx % featureList.length].id
  return ''
}

function buildPerStepWalkthrough({ norm, mergedDecisions, mergedOpen, livePendingDecisions, childSlices, modifiedFeatureIds, featureList }) {
  const candidates = uniqClean([
    ...modifiedFeatureIds,
    ...(norm.addedFeatures || []).map((a) => a.id),
    ...(norm.removedFeatures || []).map((r) => r.id),
  ])
  const allFeat = [
    ...featureList,
    ...(norm.addedFeatures || []).map((a) => ({ id: a.id, title: a.title, domain: a.domain })),
  ]
  const rawSteps = [
    ...norm.goals.map((detail) => ({ title: '目标', detail, tab: 'architecture' })),
    ...norm.flowDeltas.map((detail) => ({ title: '流程变化', detail, tab: 'workflow' })),
    ...mergedDecisions.map((detail) => ({ title: '已拍板决策', detail, tab: 'architecture' })),
    ...childSlices.map((sl) => ({ title: `切片：${sl.key}`, detail: `${sl.rel}（${sl.status}）`, tab: 'architecture', preferredId: sl.key })),
    ...mergedOpen.map((detail) => ({ title: '待确认问题', detail, tab: 'brief' })),
    ...livePendingDecisions.map((pd) => ({ title: `待拍板（${pd.file}）`, detail: pd.text, tab: 'architecture' })),
  ]
  return rawSteps.map((step, idx) => ({
    targetId: resolveWalkthroughTarget({
      text: `${step.title} ${step.detail}`,
      stepIdx: idx,
      candidateIds: candidates,
      featureList: allFeat,
      preferredId: step.preferredId || '',
    }),
    tab: step.tab || 'architecture',
    title: step.title,
    detail: step.detail,
  }))
}

/** Single-Truth Live Projection：`workRoot` 优先读 `feature-map.json`，聚合 1:N PRD、切片、Worktree、账本、3-dot diff 与 Critique。 */
export function projectVisualBriefViewModel({ mainRoot, workRoot = mainRoot, sidecar, prDiff = null, analysis = null, evidence = null }) {
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
  const topicAnchors = uniqClean([...(liveTopic?.anchors ?? []), ...(prDiff?.materialFiles ?? [])])

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

  const relevantDocs = selectRelevantPlanDocs({ allDocs, norm, masterRel, effWork })
  const docProj = extractPlanDocProjection({
    relevantDocs,
    featureMap,
    manualFeatureChanges: norm.featureChanges,
  })

  const mergedGoals = uniqClean([...norm.goals, ...docProj.goals])
  const allMergedDecisions = uniqClean([...mergedDecisions, ...docProj.decisions])
  const allMergedNonGoals = uniqClean([...mergedNonGoals, ...docProj.nonGoals])
  const allTopicAnchors = uniqClean([...topicAnchors, ...docProj.scopeFiles])

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
      const last = rounds[rounds.length - 1]
      const roundNum = Math.max(rounds.length, Number(last.round) || 0)
      liveCritiqueRounds.push({
        file: d.rel,
        rounds: rounds.length,
        lastRound: roundNum,
        lastVerdict: last.verdict ?? 'unknown',
        approved: isPlanDocApproved(d),
      })
    }
  }

  const activeWorktrees = ledgers
    .filter((l) => l && !TERMINAL_TASK_STATUSES.has(String(l.status ?? '').toLowerCase()) && l.worktreePath)
    .map((l) => ({ taskId: l.taskId, status: l.status, branch: l.branch ?? null, worktreePath: l.worktreePath }))

  const briefFingerprint = computeBriefFingerprint(norm)
  const confirmedState = resolveConfirmedState(norm, briefFingerprint)
  const featureList = Array.isArray(featureMap?.features) ? featureMap.features : []
  const domainAffected = norm.affectedDomains.length > 0 ? featureList.filter((f) => norm.affectedDomains.includes(f?.domain)).map((f) => f.id) : []
  const modifiedFeatureIds = uniqClean([...norm.affectedFeatures, ...domainAffected, ...docProj.autoModifiedFeatureIds])
  const verdictStatus = confirmedState === 'confirmed' ? '已确认' : (confirmedState === 'stale' ? '待重审' : '草稿')

  const latestCritique = liveCritiqueRounds.length > 0
    ? liveCritiqueRounds.reduce((best, cur) => ((cur.lastRound || 0) >= (best.lastRound || 0) ? cur : best), liveCritiqueRounds[0])
    : null
  const critiqueStatusText = latestCritique
    ? (latestCritique.lastVerdict === 'passed'
        ? `内审 R${latestCritique.lastRound} 通过`
        : (latestCritique.lastVerdict === 'rejected' ? `内审 R${latestCritique.lastRound} 待返工` : `内审 R${latestCritique.lastRound}`))
    : '未内审'

  const verdictSummary = norm.verdict || (confirmedState === 'stale'
    ? '简报在确认后发生变更，请复核更新并重新确认。'
    : (norm.kind === 'master-prd'
        ? `${norm.title} — ${allMergedDecisions.length} 项已拍板，${mergedOpen.length + livePendingDecisions.length} 项待确认，${childSlices.length} 个切片。`
        : `${norm.title} — 验收项 ${docProj.criteria.length} 条 · 涉及 ${docProj.scopeFiles.length} 文件 · ${critiqueStatusText}。`))

  const walkthrough = buildPerStepWalkthrough({
    norm: { ...norm, goals: mergedGoals },
    mergedDecisions: allMergedDecisions,
    mergedOpen,
    livePendingDecisions,
    childSlices: norm.kind === 'master-prd' ? childSlices : [],
    modifiedFeatureIds,
    featureList,
  })

  // Pure relative parent/child brief links (zero absolute paths or homedir leaks)
  const parentBriefHref = norm.parentBriefKey && isValidBriefKey(norm.parentBriefKey)
    ? `./${norm.parentBriefKey}.html`
    : null
  const childBriefLinks = norm.kind === 'master-prd'
    ? childSlices.map((sl) => {
        const cKey = sanitizeBriefKey(sl.key)
        return {
          key: cKey,
          title: sl.key,
          status: sl.status,
          done: sl.done,
          href: `./${cKey}.html?from=${encodeURIComponent(norm.briefKey)}`,
        }
      })
    : []

  const masterPrdInfo = matchingMasterPrd ? { rel: matchingMasterPrd.rel, status: matchingMasterPrd.status, approved: isPlanDocApproved(matchingMasterPrd) } : null
  const evBundle = featureMapSource !== 'none'
    ? collectRepoVisualEvidenceSync({
        workRoot: effWork,
        cacheRoot: effMain,
        featureMap,
        analysis,
        evidence,
      })
    : { analysis, evidence }
  const resolvedAnalysis = evBundle.analysis
  const resolvedEvidence = evBundle.evidence

  const visualModel = buildVisualModel({
    featureMap,
    analysis: resolvedAnalysis,
    evidence: resolvedEvidence,
    diffOverlay: {
      modified: modifiedFeatureIds,
      impacted: prDiff?.impactedFeatures ?? [],
      changedFiles: allTopicAnchors,
      addedNodes: norm.addedFeatures,
      removed: norm.removedFeatures,
      featureChanges: docProj.mergedFeatureChanges,
    },
    mode: 'visual-brief',
    title: `${norm.title} — 实时规划简报`,
    briefSpec: {
      repoName: norm.title,
      title: `${norm.title} — 实时规划简报`,
      verdict: { status: verdictStatus, tone: confirmedState === 'confirmed' ? 'pass' : 'warn', summary: verdictSummary },
      scopeChips: [
        `简报:${norm.briefKey}`, `类型:${norm.kind}`, `状态:${verdictStatus}`, `拓扑:${featureMapSource}`,
        ...(norm.parentBriefKey ? [`父简报:${norm.parentBriefKey}`] : []),
        ...(norm.kind === 'master-prd' && childSlices.length > 0 ? [`切片:${childSlices.filter((s) => s.done).length}/${childSlices.length}`] : []),
        ...(norm.kind !== 'master-prd' && docProj.criteria.length > 0 ? [`验收项:${docProj.criteria.length}`] : []),
        ...(docProj.scopeFiles.length > 0 ? [`文件:${docProj.scopeFiles.length}`] : []),
        ...(norm.prototypes.length > 0 ? [`原型:${norm.prototypes.length}`] : []),
      ],
      metrics: [
        { label: '状态', value: verdictStatus },
        { label: '受影响模块', value: String(modifiedFeatureIds.length + norm.addedFeatures.length + norm.removedFeatures.length) },
        { label: '已拍板', value: String(allMergedDecisions.length) },
        { label: '待确认', value: String(mergedOpen.length + livePendingDecisions.length) },
        norm.kind === 'master-prd'
          ? { label: '切片进度', value: `${childSlices.filter((s) => s.done).length}/${childSlices.length}` }
          : { label: '验收清单', value: `${docProj.criteria.filter((c) => c.checked).length}/${docProj.criteria.length}` },
        { label: '方案原型', value: String(norm.prototypes.length) },
      ],
      walkthrough: walkthrough.length > 0 ? walkthrough : undefined,
      prototypes: buildRenderablePrototypes(effMain, norm.briefKey, norm.prototypes),
      briefData: {
        kind: norm.kind,
        confirmedState,
        verdict: verdictSummary,
        specSummaryLine: docProj.specSummaryLine || '',
        goals: mergedGoals,
        nonGoals: allMergedNonGoals,
        flowDeltas: norm.flowDeltas,
        masterPrd: masterPrdInfo,
        parentBriefHref,
        childBriefLinks,
        childSlices: norm.kind === 'master-prd' ? childSlices : [],
        activeWorktrees,
        mergedDecisions: allMergedDecisions,
        mergedOpen,
        pendingDecisions: livePendingDecisions,
        critiqueRounds: liveCritiqueRounds,
        critiqueStatusText: latestCritique ? critiqueStatusText : '',
        criteria: docProj.criteria,
        scopeFiles: docProj.scopeFiles,
        prDiff,
      },
    },
  })
  visualModel.analysis = resolvedAnalysis || null
  if (visualModel.briefData) {
    const groups = { added: [], modified: [], removed: [], impacted: [] }
    for (const n of visualModel.tree.nodes) {
      if (groups[n.diffState]) groups[n.diffState].push({ id: n.id, title: n.title, domain: n.domain, domainTitle: n.domainTitle, diffState: n.diffState, changeDetail: n.changeDetail, impactReasons: n.impactReasons || [], summary: n.description || '' })
    }
    visualModel.briefData.changeGroups = groups
  }

  return {
    sidecar: norm, briefFingerprint, confirmedState, featureMapSource, featureMapSha256,
    liveProjection: {
      masterPrd: masterPrdInfo,
      parentBriefHref,
      childBriefLinks,
      childSlices, sliceGraphOk: sliceEval.ok, sliceGraphErrors: sliceEval.errors.length,
      activeWorktrees, pendingDecisions: livePendingDecisions, critiqueRounds: liveCritiqueRounds,
      mergedDecisions: allMergedDecisions, mergedNonGoals: allMergedNonGoals, mergedOpen,
      criteria: docProj.criteria, scopeFiles: docProj.scopeFiles,
    },
    visualModel,
  }
}

export function renderVisualBrief({ mainRoot, workRoot = mainRoot, sidecar, prDiff = null, analysis = null, evidence = null }) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const projected = projectVisualBriefViewModel({ mainRoot: effMain, workRoot, sidecar, prDiff, analysis, evidence })
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
  workRoot = mainRoot, briefKey, kind, parentBriefKey, prDiffBase, prDiff = null, title, topicId, taskId, masterPrdRel,
  verdict, goals, nonGoals, affectedDomains, affectedFeatures, featureChanges, addedFeatures, removedFeatures,
  affectedFlows, flowDeltas,
  decisions, openQuestions, prototypesToAdd = [], selectPrototypeId = null, sourceSkill = '', prototypeNote = '', confirm = false,
} = {}) {
  const effMain = resolve(String(mainRoot || process.cwd()))
  const key = sanitizeBriefKey(briefKey || taskId || topicId || (masterPrdRel ? deriveMasterPrdBriefKey(masterPrdRel) : null) || 'default')
  const existing = readBriefSidecar(effMain, key)
  const now = new Date().toISOString()

  const mergedAdded = [...(existing?.addedFeatures ?? [])]
  for (const item of normAddedFeaturesList(addedFeatures)) {
    const idx = mergedAdded.findIndex((x) => x.id === item.id)
    if (idx >= 0) mergedAdded[idx] = item
    else mergedAdded.push(item)
  }
  const mergedRemoved = [...(existing?.removedFeatures ?? [])]
  for (const item of normRemovedFeaturesList(removedFeatures)) {
    const idx = mergedRemoved.findIndex((x) => x.id === item.id)
    if (idx >= 0) mergedRemoved[idx] = item
    else mergedRemoved.push(item)
  }

  const next = normalizeSidecar({
    ...(existing ?? {}),
    briefKey: key,
    kind: kind || existing?.kind || (masterPrdRel && !taskId ? 'master-prd' : (taskId ? 'task' : 'topic')),
    ...(parentBriefKey !== undefined ? { parentBriefKey } : (existing?.parentBriefKey ? { parentBriefKey: existing.parentBriefKey } : {})),
    ...(prDiffBase ? { prDiffBase } : (existing?.prDiffBase ? { prDiffBase: existing.prDiffBase } : {})),
    title: title || existing?.title || key,
    ...(topicId ? { topicId } : (existing?.topicId ? { topicId: existing.topicId } : {})),
    ...(taskId ? { taskId } : (existing?.taskId ? { taskId: existing.taskId } : {})),
    ...(masterPrdRel ? { masterPrdRel } : (existing?.masterPrdRel ? { masterPrdRel: existing.masterPrdRel } : {})),
    verdict: verdict !== undefined && verdict !== null && String(verdict).trim() !== '' ? String(verdict).trim() : (existing?.verdict ?? ''),
    goals: uniqClean(goals ?? [], existing?.goals ?? []),
    nonGoals: uniqClean(nonGoals ?? [], existing?.nonGoals ?? []),
    affectedDomains: uniqClean(affectedDomains ?? [], existing?.affectedDomains ?? []),
    affectedFeatures: uniqClean(affectedFeatures ?? [], existing?.affectedFeatures ?? []),
    featureChanges: { ...(existing?.featureChanges ?? {}), ...normFeatureChangesMap(featureChanges) },
    addedFeatures: mergedAdded,
    removedFeatures: mergedRemoved,
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
  writeBriefSidecar(effMain, key, next)
  if (next.topicId) { try { setTopicBriefKey(effMain, next.topicId, key) } catch { /* non-fatal */ } }

  const rendered = renderVisualBrief({ mainRoot: effMain, workRoot, sidecar: next, prDiff })
  return {
    ok: true, briefKey: key, sidecar: next,
    summary: buildBriefSummaryObject(effMain, next, rendered),
    liveProjection: rendered.liveProjection, bytes: rendered.bytes,
    htmlPath: rendered.htmlPath, htmlUri: rendered.htmlUri, jsonPath: rendered.jsonPath,
  }
}

function persistAndMoveBrief({ mainRoot, workRoot, fromKey, targetKey, sidecar, moveFromSource }) {
  if (moveFromSource) moveBriefFiles({ mainRoot, fromKey, targetKey })
  writeBriefSidecar(mainRoot, targetKey, sidecar)
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

/** 根据文档变更（clarify / critique-pass / critique-reject / approve）刷新关联 Brief；记录新决策时自然推进指纹触发 stale。 */
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
