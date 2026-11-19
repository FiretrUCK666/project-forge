#!/usr/bin/env node
/**
 * govern-retro.mjs —— `govern-audit.mjs retro` 与直调 CLI：严格三层纠偏倒金字塔与 `--auto` 自动复盘引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），彻底废除默认写回 `AGENTS.md`：
 *   - Tier 1（架构重构优先）：结构耦合/状态分裂/竞态/超长紧文件复发 >=2 次经 escalation.mjs 建单去重；
 *   - Tier 2（确定性门禁次优先）：产出 arch-rules / edit-gate / CI / 目标仓既有原生校验配置建议；
 *   - Tier 3（显式兜底）：仅传 `--allow-tier3-fallback --reason "<why>"` 方允许写入带 `[TIER-3-FALLBACK]`
 *     与淘汰条件的极简词条，并在常规复盘中自动识别与清理过时 Tier 3 条款。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { buildDocFilename, docIsoDate, serializeDocFrontmatter, slugify } from '../../lib/docs.mjs'
import { buildEscalationIssuePayload, escalateToBackend } from '../../lib/escalation.mjs'
import { isMainModule, posixPath, readTextSafe, resolveRepoRoots, writeAtomic } from '../../lib/git.mjs'
import { listTaskLedgers, sanitizeTaskId } from '../../lib/ledger.mjs'
import { detectOptionalNativeCheckers } from '../../lib/profile-sniffer.mjs'
import {
  computeSignalFingerprint, inferDefectClass, inferPyramidTier,
  readSignalsJsonl, resolveGovernStateDir,
} from '../../lib/signals.mjs'
import { AGENTS_MAX_BYTES } from './govern-checks.mjs'
import { loadGovernState, recordGovernRetroCheckpoint, recordGovernSkip } from './govern-state.mjs'

const RETRO_START = '<!-- govern-retro: begin -->'
const RETRO_END = '<!-- govern-retro: end -->'
const TIER1_CLASSES = new Set(['state-split', 'race-condition', 'file-bloat'])
const TIER2_COVERED_CLASSES = new Set([
  'suppression-bypass', 'arch-boundary', 'mock-only-test', 'dead-code', 'file-bloat', 'stale-contract',
])

function collectLedgerStats(ledgers) {
  const disp = { fixed: 0, rebuttedWrong: 0, intentional: 0, deferred: 0, total: 0 }
  const stopLossTasks = []
  const queueConflictTasks = []
  const fileCounts = new Map()

  for (const ledger of ledgers) {
    const tid = ledger.taskId
    const rounds = Array.isArray(ledger.rounds) ? ledger.rounds : []
    if (ledger.lastReview?.stopLossTriggered || rounds.some((r) => r.stopLossTriggered)) {
      stopLossTasks.push(tid)
    }
    if (ledger.queueConflict) queueConflictTasks.push({ taskId: tid, code: ledger.queueConflict.code ?? 'CONFLICT' })
    for (const r of rounds) {
      for (const m of r.mustFix ?? []) {
        const f = posixPath(m?.file ?? '').trim()
        if (f) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
      }
      for (const d of r.dispositions ?? []) {
        const kind = String(d?.disposition ?? '').toLowerCase()
        if (kind === 'fixed') disp.fixed += 1
        else if (kind === 'rebutted-wrong') disp.rebuttedWrong += 1
        else if (kind === 'intentional') disp.intentional += 1
        else if (kind === 'deferred') disp.deferred += 1
      }
    }
  }
  disp.total = disp.fixed + disp.rebuttedWrong + disp.intentional + disp.deferred
  const falsePositiveCount = disp.rebuttedWrong + disp.intentional
  const falsePositiveRate = disp.total > 0 ? Number((falsePositiveCount / disp.total).toFixed(4)) : 0
  return {
    dispositionSummary: { ...disp, falsePositiveCount, falsePositiveRate },
    stopLossTasks,
    queueConflictTasks,
    ledgerFileCounts: fileCounts,
  }
}

function buildTier2Proposal(rf, nativeCheckers) {
  const nativeList = nativeCheckers?.configured ?? []
  const nativeHint = nativeList.length > 0
    ? `目标仓原生校验：${nativeList.map((n) => `${n.tool}(${n.configFile})`).join(' / ')}`
    : '目标仓未配置外部 linter，直接使用零依赖 edit-gate.mjs / Dev Profile arch-rules'

  if (rf.defectClass === 'arch-boundary') {
    return {
      pyramidTier: 'tier2-deterministic-gate',
      targetKind: 'gate',
      targetFile: 'AGENTS.md (Dev Profile arch-rules)',
      fingerprint: rf.fingerprint,
      defectClass: rf.defectClass,
      reason: `架构越界指纹 ${rf.fingerprint} (${rf.module}::${rf.pattern}) 复发 ${rf.count} 次`,
      patchPreview: `[tier2/arch-rules] 在 Dev Profile arch-rules 增加 ${rf.module} 单向禁引规则并由 edit-gate.mjs 强制拦截（${nativeHint}）`,
    }
  }
  if (rf.defectClass === 'suppression-bypass' || rf.defectClass === 'dead-code') {
    return {
      pyramidTier: 'tier2-deterministic-gate',
      targetKind: 'gate',
      targetFile: '.agents/skills/dev-edit/scripts/edit-gate.mjs',
      fingerprint: rf.fingerprint,
      defectClass: rf.defectClass,
      reason: `静态绕过/死代码指纹 ${rf.fingerprint} (${rf.module}::${rf.pattern}) 复发 ${rf.count} 次`,
      patchPreview: `[tier2/edit-gate] 强化 ${rf.module} 的 edit-gate 词法静态阻断（${nativeHint}）`,
    }
  }
  if (rf.defectClass === 'mock-only-test') {
    return {
      pyramidTier: 'tier2-deterministic-gate',
      targetKind: 'fixture',
      targetFile: rf.files[0] || rf.module,
      fingerprint: rf.fingerprint,
      defectClass: rf.defectClass,
      reason: `假测/反作弊指纹 ${rf.fingerprint} (${rf.module}::${rf.pattern}) 复发 ${rf.count} 次`,
      patchPreview: `[tier2/test-gate] 为 ${rf.module} 补齐真实行为断言并由 edit-gate.mjs 阻断纯 Mock 自证与零断言测试`,
    }
  }
  const isVerifyOrRework = /^(?:verify\.|flow\.rework)/.test(rf.pattern)
  return {
    pyramidTier: 'tier2-deterministic-gate',
    targetKind: isVerifyOrRework ? 'profile' : 'gate',
    targetFile: isVerifyOrRework ? 'Dev Profile / CI' : '.agents/skills/dev-edit/scripts/edit-gate.mjs',
    fingerprint: rf.fingerprint,
    defectClass: rf.defectClass,
    reason: `信号指纹 ${rf.fingerprint} (${rf.module}::${rf.pattern}) 复发 ${rf.count} 次`,
    patchPreview: isVerifyOrRework
      ? `[tier2/verify] 将 ${rf.module}::${rf.pattern} 纳入 quick-test / smoke-verify 与 CI 确定性门禁（${nativeHint}）`
      : `[tier2/gate] 将 ${rf.module} 的 ${rf.pattern} 下沉至确定性静态检查或 CI 校验（${nativeHint}）`,
  }
}

function buildTier1Escalation(rf, taskFilter) {
  const filesText = rf.files.length > 0 ? rf.files.join(', ') : rf.module
  const item = {
    source: 'govern',
    category: rf.defectClass,
    severity: rf.count >= 3 ? 'critical' : 'high',
    caseType: 4,
    crossModule: rf.files.length >= 2 || rf.defectClass === 'state-split' || rf.defectClass === 'arch-boundary',
    recurrenceCount: rf.count,
    forceIssue: true,
    taskId: taskFilter ?? undefined,
    title: `refactor(${rf.module}): Tier 1 架构解耦 [fp:${rf.fingerprint}] ${rf.defectClass}`,
    summary: `指纹 ${rf.fingerprint}（${rf.defectClass}）在 ${rf.module} 累计复发 ${rf.count} 次，须做结构解耦根治`,
    rootCause: `同类故障（defectClass=${rf.defectClass}, pattern=${rf.pattern}, fingerprint=${rf.fingerprint}）已在 ${filesText} 复发 ${rf.count} 次，依赖口头规则无法收敛，须拆分模块边界并确立单一真相源。`,
    criteria: [
      `解耦 ${filesText} 中导致 ${rf.defectClass}（fp:${rf.fingerprint}）的结构耦合或超长模块边界`,
      `补充正反双向自动化回归断言并确保 edit-gate 与全量门禁通过`,
    ],
    labels: ['tier1-refactor', 'governance', rf.defectClass],
    nextStep: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --touches-contract --summary "Tier1 refactor [${rf.fingerprint}] ${rf.module}"`,
  }
  const escalationPayload = buildEscalationIssuePayload(item)
  return {
    pyramidTier: 'tier1-architecture',
    fingerprint: rf.fingerprint,
    defectClass: rf.defectClass,
    module: rf.module,
    pattern: rf.pattern,
    count: rf.count,
    files: rf.files,
    targetKind: 'tier1-refactor',
    targetFile: rf.files[0] || rf.module,
    reason: `结构性缺陷指纹 ${rf.fingerprint} (${rf.defectClass}) 在 ${rf.module} 复发 ${rf.count} 次 -> 强制升格 Tier 1 重构单`,
    patchPreview: `[tier1/refactor] 拆解 ${filesText} 模块边界（fp:${rf.fingerprint}, count=${rf.count}）`,
    escalationItem: item,
    escalationPayload,
  }
}

/** 扫描 AGENTS.md 中已失效或已被 Tier 2 静态门禁覆盖的陈旧 `[TIER-3-FALLBACK]` 条款。 */
export function scanStaleTier3Fallbacks(agentsText, activeTier2Classes = new Set()) {
  const stale = []
  if (!agentsText) return stale
  const today = docIsoDate()
  const lines = String(agentsText).replace(/\r\n/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.includes('[TIER-3-FALLBACK]')) continue
    const expM = /expires[:=]\s*(\d{4}-\d{2}-\d{2})/i.exec(line)
    const clsM = /class[:=]\s*([a-z0-9-]+)/i.exec(line)
    const isExpired = Boolean(expM && expM[1] < today)
    const coveredByTier2 = Boolean(clsM && (TIER2_COVERED_CLASSES.has(clsM[1].toLowerCase()) || activeTier2Classes.has(clsM[1].toLowerCase())))
    if (isExpired || coveredByTier2) {
      stale.push({
        line: i + 1,
        text: line.trim(),
        reason: isExpired ? `已超过到期日 ${expM[1]}` : `已由 Tier 2 确定性静态门禁接管（${clsM[1]}）`,
      })
    }
  }
  return stale
}

function pruneStaleTier3FromAgents(agentsText, staleEntries) {
  if (!agentsText || !staleEntries.length) return { changed: false, nextText: agentsText }
  const staleLineSet = new Set(staleEntries.map((s) => s.text))
  const lines = String(agentsText).replace(/\r\n/g, '\n').split('\n')
  const filtered = lines.filter((l) => !staleLineSet.has(l.trim()))
  let nextText = filtered.join('\n')
  const blockRe = new RegExp(`\\n*${RETRO_START}[\\s\\S]*?${RETRO_END}\\n*`)
  const m = blockRe.exec(nextText)
  if (m && !/^\s*-\s+\[TIER-3-FALLBACK\]/m.test(m[0])) {
    nextText = nextText.replace(blockRe, '\n').trimEnd() + '\n'
  }
  return { changed: nextText !== agentsText, nextText }
}

export function buildRetroReport({
  workTreeRoot, mainRoot, gitDir, isGit, taskFilter = null, signals, allSignals = null, ledgers, opts = {},
}) {
  const repeatedMap = new Map()
  const fileHotspotCounts = new Map()
  const scopeFingerprints = new Set()

  for (const ev of signals) {
    const sev = String(ev?.severity ?? 'medium').toLowerCase()
    const pat = String(ev?.pattern ?? 'signal')
    if (sev === 'info' || /\.pass$/.test(pat)) continue
    const fp = ev.fingerprint || computeSignalFingerprint({ ruleId: ev.ruleId || pat, defectClass: ev.defectClass || 'general', moduleRoot: ev.module || 'repo' })
    scopeFingerprints.add(fp)
  }

  const corpus = Array.isArray(allSignals) && allSignals.length > 0 && taskFilter
    ? allSignals.filter((ev) => {
        const fp = ev.fingerprint || computeSignalFingerprint({ ruleId: ev.ruleId || ev.pattern, defectClass: ev.defectClass || 'general', moduleRoot: ev.module || 'repo' })
        return ev.taskId === taskFilter || scopeFingerprints.has(fp)
      })
    : signals

  for (const ev of corpus) {
    const pat = String(ev?.pattern ?? 'signal')
    const mod = String(ev?.module ?? 'repo')
    const sev = String(ev?.severity ?? 'medium').toLowerCase()
    const isPassSignal = sev === 'info' || /\.pass$/.test(pat)
    if (isPassSignal) continue

    const defectClass = ev.defectClass || inferDefectClass({ ruleId: ev.ruleId || pat, pattern: pat, category: ev.category, message: ev.message })
    const fp = ev.fingerprint || computeSignalFingerprint({ ruleId: ev.ruleId || pat, defectClass, moduleRoot: mod })
    if (!repeatedMap.has(fp)) {
      repeatedMap.set(fp, {
        fingerprint: fp,
        key: `${mod}::${pat}`,
        module: mod,
        pattern: pat,
        ruleId: ev.ruleId || pat,
        defectClass,
        pyramidTier: ev.pyramidTier || inferPyramidTier(defectClass),
        category: ev.category ?? 'hygiene',
        count: 0,
        files: new Set(),
        tasks: new Set(),
        messages: [],
      })
    }
    const item = repeatedMap.get(fp)
    item.count += 1
    if (ev.taskId) item.tasks.add(ev.taskId)
    if (ev.file) {
      const f = posixPath(ev.file)
      item.files.add(f)
      fileHotspotCounts.set(f, (fileHotspotCounts.get(f) ?? 0) + 1)
    }
    if (ev.message && item.messages.length < 3) item.messages.push(String(ev.message).slice(0, 120))
  }

  const lStats = collectLedgerStats(ledgers)
  for (const [f, cnt] of lStats.ledgerFileCounts.entries()) {
    fileHotspotCounts.set(f, (fileHotspotCounts.get(f) ?? 0) + cnt)
  }

  const repeatedFailures = [...repeatedMap.values()]
    .filter((x) => x.count >= 2)
    .sort((a, b) => (b.count - a.count) || a.fingerprint.localeCompare(b.fingerprint))
    .map((x) => ({ ...x, files: [...x.files].sort(), tasks: [...x.tasks].sort() }))

  const hotspots = [...fileHotspotCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([file, count]) => ({ file, count }))

  const nativeCheckers = detectOptionalNativeCheckers(workTreeRoot)
  const tier1Escalations = []
  const tier2Proposals = []
  const tier3Fallbacks = []
  const patches = []

  for (const rf of repeatedFailures) {
    const isTier1 = TIER1_CLASSES.has(rf.defectClass)
      || (rf.defectClass === 'arch-boundary' && rf.files.length >= 2)
      || rf.pyramidTier === 'tier1-architecture'
    if (isTier1) {
      const t1 = buildTier1Escalation(rf, taskFilter)
      tier1Escalations.push(t1)
      patches.push(t1)
    } else {
      const t2 = buildTier2Proposal(rf, nativeCheckers)
      tier2Proposals.push(t2)
      patches.push(t2)
    }
  }

  const ds = lStats.dispositionSummary
  if (ds.falsePositiveCount >= 2 || (ds.total >= 2 && ds.falsePositiveRate >= 0.4)) {
    const fpPatch = {
      pyramidTier: 'tier2-deterministic-gate',
      targetKind: 'gate',
      targetFile: '.agents/skills/dev-edit/scripts/edit-gate.mjs',
      reason: `审查误报处置占比偏高（rebutted-wrong=${ds.rebuttedWrong}, intentional=${ds.intentional}, rate=${(ds.falsePositiveRate * 100).toFixed(1)}%）`,
      patchPreview: `[tier2/review-fp] 将反复反驳模式沉淀为确定性静态规则白名单或夹具，禁止把主观挑刺写回 AGENTS.md`,
    }
    tier2Proposals.push(fpPatch)
    patches.push(fpPatch)
  }

  for (const hs of hotspots.slice(0, 3)) {
    const hsPatch = {
      pyramidTier: hs.count >= 3 ? 'tier1-architecture' : 'tier2-deterministic-gate',
      targetKind: 'fixture',
      targetFile: hs.file,
      reason: `热点文件 ${hs.file} 在信号/返工中出现 ${hs.count} 次`,
      patchPreview: `[retro/hotspot] 为 ${hs.file} 增补正反双向回归夹具并评估模块拆分`,
    }
    patches.push(hsPatch)
  }
  for (const tid of lStats.stopLossTasks) {
    if (!patches.some((p) => p.targetKind === 'fixture')) {
      patches.push({
        pyramidTier: 'tier1-architecture',
        targetKind: 'fixture',
        targetFile: 'docs/todo/',
        reason: `任务 ${tid} 触发独立审查停损熔断`,
        patchPreview: `[tier1/stop-loss] 任务 ${tid} 触发 3 轮停损，须拆解架构边界并补齐回归门禁用例`,
      })
    }
  }

  if (opts.allowTier3Fallback && String(opts.reason ?? '').trim()) {
    const expiryDate = new Date(Date.now() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const fp = computeSignalFingerprint({ ruleId: 'tier3-fallback', defectClass: 'general', moduleRoot: taskFilter || 'repo' })
    const entry = {
      pyramidTier: 'tier3-prompt-fallback',
      targetKind: 'tier3-fallback',
      targetFile: 'AGENTS.md',
      fingerprint: fp,
      expires: expiryDate,
      reason: String(opts.reason).trim(),
      patchPreview: `- [TIER-3-FALLBACK] (fp:${fp}, expires:${expiryDate}, retiredWhen:tier2-covered) ${String(opts.reason).trim()}`,
    }
    tier3Fallbacks.push(entry)
    patches.push(entry)
  }

  const agentsText = readTextSafe(join(workTreeRoot, 'AGENTS.md')) ?? ''
  const activeTier2Classes = new Set(tier2Proposals.map((p) => p.defectClass).filter(Boolean))
  const staleTier3Entries = scanStaleTier3Fallbacks(agentsText, activeTier2Classes)

  return {
    mode: 'retro',
    repoRoot: posixPath(workTreeRoot),
    mainRoot: posixPath(mainRoot),
    taskFilter,
    auto: Boolean(opts.auto),
    defaultAgentsWriteDisabled: true,
    signalCount: signals.length,
    ledgerCount: ledgers.length,
    repeatedFailures,
    dispositionSummary: ds,
    hotspots,
    stopLossTasks: lStats.stopLossTasks,
    queueConflictTasks: lStats.queueConflictTasks,
    nativeCheckers,
    tier1Escalations,
    tier2Proposals,
    tier3Fallbacks,
    staleTier3Entries,
    patches,
  }
}

function applyRetroPatches(workRoot, report, opts = {}) {
  const appliedFiles = []
  const agentsAbs = join(workRoot, 'AGENTS.md')

  // 1. 常规清理过时/已被 Tier 2 覆盖的 [TIER-3-FALLBACK] 条款
  if (existsSync(agentsAbs) && report.staleTier3Entries.length > 0) {
    const rawAgents = readTextSafe(agentsAbs) ?? ''
    const pruned = pruneStaleTier3FromAgents(rawAgents, report.staleTier3Entries)
    if (pruned.changed) {
      writeAtomic(agentsAbs, pruned.nextText)
      appliedFiles.push('AGENTS.md (pruned-stale-tier3)')
    }
  }

  // 2. 写入 Tier 1 / Tier 2 结构化治理 Todo 草案（绝不默认改写 AGENTS.md）
  const actionable = report.patches.filter((p) => p.pyramidTier !== 'tier3-prompt-fallback')
  if (actionable.length > 0) {
    const slug = slugify(report.taskFilter ? `retro-${report.taskFilter}` : 'retro-governance')
    const todoRel = `docs/todo/${buildDocFilename({ slug, kind: 'todo' })}`
    const todoAbs = join(workRoot, todoRel)
    const today = docIsoDate()
    const fm = serializeDocFrontmatter({
      kind: 'todo',
      title: `治理复盘倒金字塔升格单 (${report.taskFilter ?? 'repo'})`,
      status: 'active',
      created: today,
      updated: today,
      issue: null,
      pr: null,
      branch: null,
      owner: 'govern-retro',
      approved: false,
      done_at: null,
      task_id: report.taskFilter ?? slug,
      planned_at: 'HEAD',
      related_prd: null,
      related_spec: null,
    }, ['kind', 'title', 'status', 'created', 'updated', 'issue', 'pr', 'branch', 'owner', 'approved', 'done_at', 'task_id', 'planned_at', 'related_prd', 'related_spec'])

    const criteriaLines = actionable.map((p, idx) => `- [ ] C${idx + 1}: [${p.pyramidTier}][${p.targetKind}] ${p.reason} -> \`${p.targetFile}\``)
    const previewLines = actionable.map((p) => `  - ${p.patchPreview}`)
    const todoContent = [
      fm.trimEnd(), '',
      `# Todo: 治理复盘倒金字塔升格单 (${report.taskFilter ?? 'repo'})`, '',
      '## 本期不做', '',
      '- 严格遵循三层倒金字塔（Tier 1 架构重构 > Tier 2 确定性静态门禁），绝不向 AGENTS.md 追加自然语言规则补丁。', '',
      '## 门型与回滚路径', '',
      '- 门型：two-way；删除本草稿或 `git revert` 即可无损回退。', '',
      '## 验收标准', '', ...criteriaLines, '',
      '## 升格方案预览', '', ...previewLines, '',
      '## 断点与遗留决策', '',
      '- **当前状态**：`待确认落盘`',
      '- **待拍板事项**：确认 Tier 1 重构或 Tier 2 静态门禁落地路径', '',
      '## 完成后的记录', '',
      '**在合并之前写完，随这次改动一起提交。**', '',
      '- **实际验证命令与结果**：', '',
    ].join('\n')
    mkdirSync(dirname(todoAbs), { recursive: true })
    writeAtomic(todoAbs, todoContent)
    appliedFiles.push(todoRel)
  }

  // 3. 仅当显式传参 --allow-tier3-fallback --reason "<why>" 时方允许写入带 [TIER-3-FALLBACK] 的最小词条
  if (opts.allowTier3Fallback && report.tier3Fallbacks.length > 0 && existsSync(agentsAbs)) {
    const rawAgents = readTextSafe(agentsAbs) ?? ''
    const retroSection = [
      RETRO_START,
      '## 治理复盘显式兜底规则（[TIER-3-FALLBACK]，非受管区）',
      '',
      ...report.tier3Fallbacks.map((p) => p.patchPreview),
      RETRO_END,
    ].join('\n')
    const blockRe = new RegExp(`${RETRO_START}[\\s\\S]*?${RETRO_END}`)
    const nextAgents = blockRe.test(rawAgents)
      ? rawAgents.replace(blockRe, retroSection)
      : `${rawAgents.trimEnd()}\n\n${retroSection}\n`
    if (Buffer.byteLength(nextAgents, 'utf8') <= AGENTS_MAX_BYTES - 1024) {
      writeAtomic(agentsAbs, nextAgents)
      if (!appliedFiles.includes('AGENTS.md')) appliedFiles.push('AGENTS.md')
    }
  }
  return appliedFiles
}

export async function handleRetro(workRoot, mainRoot, gitDir, isGit, opts) {
  if (opts.skipGovern) {
    const skipRes = await recordGovernSkip({
      mainRoot, gitDir, isGit, taskId: opts.task ?? null, stage: 'retro', reason: opts.reason ?? '',
    })
    if (!skipRes.ok) {
      process.stderr.write(`Error: ${skipRes.error}\n`)
      return 2
    }
    const payload = { ok: true, mode: 'retro', skipped: true, recorded: true, ...skipRes }
    if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else process.stdout.write(`DEV-GOVERN RETRO SKIPPED (RECORDED): ${skipRes.record.reason}\n`)
    return 0
  }

  if (opts.allowTier3Fallback && !String(opts.reason ?? '').trim()) {
    process.stderr.write('Error: `--allow-tier3-fallback` requires explicit non-empty `--reason "<why>"`.\n')
    return 2
  }

  const stateDir = resolveGovernStateDir(mainRoot, gitDir, isGit)
  const { signalsPath, events } = readSignalsJsonl(stateDir)
  const rawTask = opts.task ? String(opts.task).trim() : null
  const cleanTask = rawTask ? sanitizeTaskId(rawTask) : null
  const signals = cleanTask
    ? events.filter((e) => e.taskId === cleanTask || e.taskId === rawTask)
    : events
  const allLedgers = listTaskLedgers(mainRoot, { includeTerminal: true })
  const ledgers = cleanTask
    ? allLedgers.filter((l) => l.taskId === cleanTask || l.taskId === rawTask)
    : allLedgers

  const report = buildRetroReport({
    workTreeRoot: workRoot, mainRoot, gitDir, isGit, taskFilter: cleanTask,
    signals, allSignals: events, ledgers, opts,
  })
  report.signalsPath = posixPath(signalsPath)
  report.appliedPatches = opts.applyPatches ? applyRetroPatches(workRoot, report, opts) : []

  // Tier 1 架构重构单自动去重升格（仅在允许写通道或 --apply-patches / --auto 时执行）
  const prevState = loadGovernState(mainRoot)
  const tier1Results = []
  const newTier1Map = {}
  const canEscalateTier1 = Boolean(opts.applyPatches || opts.auto || opts.escalate || opts._ghProbe || opts._ghClient)
  if (canEscalateTier1 && report.tier1Escalations.length > 0) {
    for (const t1 of report.tier1Escalations) {
      const existingRec = prevState.tier1Escalations?.[t1.fingerprint]
      const res = await escalateToBackend({
        repoRoot: workRoot,
        item: t1.escalationItem,
        force: true,
        deduplicate: true,
        _ghProbe: opts._ghProbe,
        _ghClient: opts._ghClient,
      }).catch((e) => ({ ok: false, error: e?.message }))
      if (res.ok) {
        newTier1Map[t1.fingerprint] = {
          number: res.number, title: res.title, deduplicated: Boolean(res.deduplicated || existingRec),
          updatedAt: new Date().toISOString(),
        }
      }
      tier1Results.push({ fingerprint: t1.fingerprint, ...res })
    }
  }
  report.tier1EscalationResults = tier1Results

  if (opts.auto || opts.applyPatches) {
    report.checkpoint = await recordGovernRetroCheckpoint(mainRoot, gitDir, isGit, {
      taskId: cleanTask,
      auto: Boolean(opts.auto),
      signalCount: report.signalCount,
      tier1Count: report.tier1Escalations.length,
      tier2Count: report.tier2Proposals.length,
      tier3Count: report.tier3Fallbacks.length,
      tier1Escalations: newTier1Map,
      tier3Fallbacks: report.tier3Fallbacks.map((t) => ({ fingerprint: t.fingerprint, expires: t.expires, text: t.patchPreview })),
    })
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const lines = [
      '=== DEV-GOVERN (RETRO · 3-TIER PYRAMID) ===',
      `Signals File   : ${report.signalsPath} (${report.signalCount} event(s))`,
      `Task Ledgers   : ${report.ledgerCount}${cleanTask ? ` (filter=${cleanTask})` : ''}`,
      `Repeat Fails   : ${report.repeatedFailures.length} (Tier1=${report.tier1Escalations.length}, Tier2=${report.tier2Proposals.length}, Tier3=${report.tier3Fallbacks.length})`,
      `False Positive : ${(report.dispositionSummary.falsePositiveRate * 100).toFixed(1)}% (${report.dispositionSummary.falsePositiveCount}/${report.dispositionSummary.total})`,
      `Stale Tier 3   : ${report.staleTier3Entries.length}`,
      `Suggested Patch: ${report.patches.length}`,
    ]
    for (const p of report.patches) {
      lines.push(`  - [${p.pyramidTier}][${p.targetKind}] ${p.targetFile}: ${p.reason}`, `      ${p.patchPreview}`)
    }
    if (report.appliedPatches.length > 0) lines.push(`Applied Files  : ${report.appliedPatches.join(', ')}`)
    process.stdout.write(`${lines.join('\n')}\n`)
    printNextStep([
      report.patches.length > 0 && !opts.applyPatches
        ? 'Review Tier 1/Tier 2 proposals above and pass `--apply-patches` to generate Todo draft (AGENTS.md is never modified by default).'
        : 'Continue verification with `node ".agents/skills/dev-govern/scripts/govern-audit.mjs" audit . --changed --quiet`.',
    ], { repoRoot: mainRoot })
  }
  return 0
}

export async function runRetroCli(argv = process.argv.slice(2)) {
  const { sub, opts } = parseStandardCli(argv, {
    subcommands: ['summary', 'retro'],
    allowPositionalWithoutSubcommand: true,
    booleanFlags: ['json', 'auto', 'apply-patches', 'allow-tier3-fallback', 'skip-govern', 'escalate', 'help'],
    valueFlags: ['dir', 'task', 'reason'],
  })
  if (opts.help) {
    process.stdout.write('用法：node govern-retro.mjs [summary|retro] [dir] [--task <id>] [--auto] [--apply-patches] [--allow-tier3-fallback --reason "<text>"] [--skip-govern --reason "<text>"] [--json]\n')
    return 0
  }
  const targetDir = resolve(String(opts.dir ?? opts._?.[0] ?? process.cwd()))
  const roots = await resolveRepoRoots(targetDir)
  return handleRetro(roots.workTreeRoot, roots.mainRoot, roots.gitDir, roots.isGit, {
    task: opts.task ?? null,
    auto: Boolean(opts.auto || !sub || sub === 'summary'),
    applyPatches: Boolean(opts['apply-patches']),
    allowTier3Fallback: Boolean(opts['allow-tier3-fallback']),
    skipGovern: Boolean(opts['skip-govern']),
    escalate: Boolean(opts.escalate),
    reason: opts.reason ?? '',
    json: Boolean(opts.json),
  })
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runRetroCli().then((code) => flushAndExit(code)).catch((err) => {
    process.stderr.write(`govern-retro error: ${err instanceof Error ? err.message : String(err)}\n`)
    return flushAndExit(2)
  })
}
