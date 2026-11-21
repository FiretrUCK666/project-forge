/**
 * survey-scan.mjs —— 合并勘察阶段的重入失步检测、套件与自有技能单趟扫描，避免重复遍历文件系统。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/），供 scripts/survey.mjs 调用。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { scanNeutralCiSteps } from '../../kit/skills/lib/profile-sniffer.mjs'
import { claimsOf } from './claims.mjs'
import * as protocol from './protocol.mjs'
import {
  collectTopModuleDirs,
  detectKit,
  detectLocalSkills,
  detectStaleAgentScripts,
  detectTddStalePaths,
  isReentryProject,
} from './survey-reentry.mjs'
import {
  detectArtifacts,
  detectEcosystem,
  detectTaskEntriesDetailed,
  detectUniversalCommands,
  detectWorkspace,
} from './survey-ecosystem.mjs'
import { detectDocs, startWorkspaceWalkAsync } from './survey-workspace.mjs'
import { readTextSafe } from './text.mjs'

/**
 * 合并单趟本地磁盘勘察：一次遍历文件树并共享结果，在异步读盘并发推进期间先行解析生态与任务入口。
 */
export async function scanProjectStaticFacts(root) {
  const { relFiles, dirs, readPromise } = startWorkspaceWalkAsync(root)
  const rawWs = await readPromise
  const relSet = new Set(relFiles)
  const dirSet = new Set(dirs)
  const ecosystem = detectEcosystem(root, relFiles)
  const taskEntryMeta = detectTaskEntriesDetailed(root)
  const taskCommands = taskEntryMeta.commands
  const neutralCi = scanNeutralCiSteps(root)
  const workspace = detectWorkspace(root, relFiles)
  const artifacts = detectArtifacts(root, ecosystem, relFiles)
  const universal = detectUniversalCommands(root, { neutralCi, runners: taskEntryMeta.runners })

  const textByRel = new Map()
  const bufByRel = new Map()
  for (const f of rawWs.files) {
    if (typeof f.text === 'string') textByRel.set(f.rel, f.text)
    if (f.rawBuf) bufByRel.set(f.rel, f.rawBuf)
  }
  const docs = detectDocs(root, { files: relFiles, textByRel, neutralCi })
  const kit = detectKit(root, { rawFiles: { textByRel, bufByRel, relSet, dirs } })
  const localSkills = buildLocalSkillsFromKit(root, kit)

  const agentsText = docs?.agents ? (textByRel.get(docs.agents.file) ?? readTextSafe(join(root, docs.agents.file)) ?? '') : ''
  const tddText = docs?.tdd ? (textByRel.get(docs.tdd) ?? readTextSafe(join(root, docs.tdd)) ?? '') : ''

  return {
    rawWs,
    relFiles,
    relSet,
    dirSet,
    ecosystem,
    taskEntryMeta,
    taskCommands,
    docs,
    workspace,
    kit,
    localSkills,
    artifacts,
    universal,
    agentsText,
    tddText,
  }
}

function buildLocalSkillsFromKit(root, kit) {
  if (!kit) return detectLocalSkills(root)
  const out = []
  const seen = new Set()
  for (const s of kit.customSkills ?? []) {
    if (!s?.path || seen.has(s.path)) continue
    seen.add(s.path)
    out.push({
      path: s.path,
      name: s.name,
      ...(s.summary ? { summary: s.summary } : {}),
      valid: s.valid !== false,
    })
  }
  for (const m of kit.mirrorCopies ?? []) {
    if (!m?.path || seen.has(m.path)) continue
    seen.add(m.path)
    out.push({
      path: m.path,
      name: m.name,
      ...(m.summary ? { summary: m.summary } : {}),
      valid: m.valid !== false,
      isMirror: true,
      mirrorsOf: m.mirrorsOf,
    })
  }
  return out
}

/** 复用预读取的 AGENTS.md / docs/TDD.md 文本完成重入失步诊断，避免二次读盘。 */
export function detectReentry(root, {
  docs,
  kit,
  ecosystem,
  commandsByEcosystem,
  workspace,
  ws,
  taskEntryMeta,
  agentsText: preReadAgents,
  tddText: preReadTdd,
  relSet = null,
  dirSet = null,
  relFiles = null,
}) {
  const isReentry = isReentryProject(docs, kit, root)
  const agentsText = preReadAgents !== undefined
    ? preReadAgents
    : (docs?.agents ? (readTextSafe(join(root, docs.agents.file)) ?? '') : '')
  const tddText = preReadTdd !== undefined
    ? preReadTdd
    : (docs?.tdd ? (readTextSafe(join(root, docs.tdd)) ?? '') : '')

  let staleAgentPaths = []
  let staleAgentScripts = []
  let agentClaims
  if (agentsText) {
    agentClaims = claimsOf(agentsText)
    const optional = new Set(agentClaims.optionalPaths ?? [])
    const combinedRefs = [...new Set([
      ...(agentClaims.paths ?? []),
      ...(agentClaims.dirs ?? []).map((d) => d.replace(/\/+$/, '')),
    ])]
      .filter((p) => !protocol.isToolOwnedPath(p))
      .filter((p) => !optional.has(p))
      .sort()
    staleAgentPaths = combinedRefs.filter((p) => !(relSet?.has(p) || dirSet?.has(p) || existsSync(join(root, p))))
    staleAgentScripts = detectStaleAgentScripts({
      agentsText,
      agentClaims,
      ecosystem,
      commandsByEcosystem,
      taskEntryMeta,
    })
  }

  const staleTddPaths = detectTddStalePaths(root, docs?.tdd, tddText, relSet)

  let unregisteredTopDirs = []
  if (docs?.agents && (docs.agentsMarkers?.fills?.length ?? 0) === 0 && (ws?.codeFiles ?? 0) > 0) {
    const combinedDocText = `${agentsText}\n${tddText}`
    for (const candidate of collectTopModuleDirs(root, workspace, relFiles)) {
      const leaf = candidate.includes('/') ? candidate.split('/').pop() : candidate
      const leafPrefixRe = leaf
        ? new RegExp(`(?<![A-Za-z0-9_-])${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)
        : undefined
      const mentioned = combinedDocText.includes(candidate)
        || (leafPrefixRe ? leafPrefixRe.test(combinedDocText) : false)
      if (!mentioned) unregisteredTopDirs.push(candidate)
    }
  }

  const drifted = Boolean(
    staleAgentPaths.length
    || staleAgentScripts.length
    || staleTddPaths.length
    || kit?.drifted
    || kit?.versionMismatch,
  )

  return {
    isReentry,
    staleAgentPaths,
    staleAgentScripts,
    staleTddPaths,
    unregisteredTopDirs,
    preservedForeignPlanDocs: docs?.preservedForeignPlanDocs ?? [],
    drifted,
  }
}
