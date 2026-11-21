/**
 * escalation.mjs —— C12 统一 Escalation 分级建单与 C22 工作类型前缀单源引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-govern、dev-review、dev-flow 与 dev-plan 共用。
 * 所有远端写路径统一经 `probeForWrite` 探测，兼顾 `github` / `local-only` / `generic-git` 三态后端。
 */

import { EXIT } from './exit-codes.mjs'
import { posixPath, gitRun } from './git.mjs'
import { hydrateIssueBody } from './issue-template-hydrate.mjs'
import { readGitConfigFast, resolveGitDirFast } from './git-fast.mjs'
import { detectGitModeMarkers, githubRepoFull, parseRemoteUrls, parseRemotesTopology, probeForWrite } from './platform.mjs'
import { createTaskBackend } from './task-backend.mjs'

const EXPLICIT_WORK_PREFIX_RE = /^(?:(?:docs|fix|feat|refactor|chore|test|ci|build|perf|style|revert)(?:\([^)]+\))?:\s+|\[[^\]]+\]\s*)/i

/** 根据 Case 档位返回默认工作类型前缀（Case 1 -> docs, Case 2 -> fix, Case >= 3 -> feat）。 */
export function workTypePrefix(caseType = 3) {
  const n = Number(caseType)
  if (n === 1) return 'docs'
  if (n === 2) return 'fix'
  return 'feat'
}

/** 为标题统一附加工作类型前缀，同时尊重用户或调用方已显式给出的合规前缀。 */
export function formatWorkTitle(title, caseType = 3) {
  const raw = String(title ?? '').trim()
  if (!raw) return `${workTypePrefix(caseType)}: untitled`
  if (EXPLICIT_WORK_PREFIX_RE.test(raw)) return raw
  return `${workTypePrefix(caseType)}: ${raw}`
}

/**
 * 统一分级判定：决定一项问题归入当前分支 `inline-todo` 还是升级建单 `escalated-issue`。
 */
export function classifyEscalationTier(item = {}) {
  if (!item || typeof item !== 'object') return 'inline-todo'
  if (item.tier === 'inline-todo' || item.tier === 'escalated-issue') return item.tier
  const fileCount = Array.isArray(item.files) ? item.files.filter(Boolean).length : 0
  const isMultiFile = item.singleFile === false || fileCount >= 2 || Boolean(item.crossModule)
  const isSingleFile = item.singleFile === true || (fileCount === 1 && !item.crossModule)
  const isOneWay = String(item.doorType ?? '').toLowerCase() === 'one-way'
  const caseType = Number(item.caseType)
  const isHighCase = Number.isInteger(caseType) && caseType >= 3
  const isRecurring = Number(item.recurrenceCount ?? item.recurrence ?? 0) >= 2
  if (
    item.stopLoss || item.forceIssue || item.outOfScope || item.deferred || item.needsHuman
    || item.highRisk || item.e2eBlocking || isMultiFile || isOneWay || isHighCase || isRecurring
  ) {
    return 'escalated-issue'
  }
  const sev = String(item.severity ?? '').toLowerCase()
  if (sev === 'critical' || sev === 'high') return 'escalated-issue'
  if (item.source === 'review-must-fix' || item.source === 'review') {
    return item.inScope === false ? 'escalated-issue' : 'inline-todo'
  }
  if (item.source === 'govern' || Array.isArray(item.findings)) {
    const count = Number(item.count ?? item.findings?.length ?? 1)
    if (sev === 'medium' && (count >= 2 || !isSingleFile)) return 'escalated-issue'
    return 'inline-todo'
  }
  if (sev === 'medium' && !isSingleFile && item.inScope !== true) return 'escalated-issue'
  return 'inline-todo'
}

function inferEscalationCase(item = {}) {
  const explicit = Number(item.caseType)
  if (Number.isInteger(explicit) && explicit >= 1 && explicit <= 5) return explicit
  if (item.stopLoss || item.crossModule) return 4
  const sev = String(item.severity ?? '').toLowerCase()
  if (sev === 'critical' || sev === 'high') return 3
  return 2
}

/** 复现证据字段的长度上限：超过它就不再是「最小复现」，而是把整段日志抄进建单正文。 */
export const REPRO_EVIDENCE_MAX_CHARS = 1200

/**
 * 归一化「最小复现」与「可重放 PoC 命令」两个可选证据字段。
 * 值只描述现象与命令本身，不限定任何具体工具：任何能独立重放并观察结果的入口都算。
 */
export function normalizeReproEvidence(item = {}) {
  const repro = item && typeof item === 'object' ? item.reproEvidence : null
  const cmd = item && typeof item === 'object' ? item.pocCommand : null
  const reproText = (Array.isArray(repro) ? repro : [repro])
    .map((x) => String(x ?? '').trim()).filter(Boolean).join('；')
  const pocText = (Array.isArray(cmd) ? cmd : [cmd])
    .map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' && ')
  return { reproEvidence: reproText || null, pocCommand: pocText || null }
}

/** 校验复现证据字段：单行命令、有界长度；不做工具白名单识别。 */
export function validateReproEvidenceFields(item = {}) {
  const { reproEvidence, pocCommand } = normalizeReproEvidence(item)
  const errors = []
  if (reproEvidence && reproEvidence.length > REPRO_EVIDENCE_MAX_CHARS) {
    errors.push(`reproEvidence 超过 ${REPRO_EVIDENCE_MAX_CHARS} 字符，请只留最小可复现的现象与退出码摘要`)
  }
  if (pocCommand && pocCommand.length > REPRO_EVIDENCE_MAX_CHARS) {
    errors.push(`pocCommand 超过 ${REPRO_EVIDENCE_MAX_CHARS} 字符，请只留一条可独立重放的命令`)
  }
  return { ok: errors.length === 0, errors, reproEvidence, pocCommand }
}

/** 把超限的复现证据字段截到上限内，并显式标注被截断，避免正文被整段日志灌满。 */
function clampReproField(text) {
  if (!text) return null
  if (text.length <= REPRO_EVIDENCE_MAX_CHARS) return text
  const keep = Math.max(0, REPRO_EVIDENCE_MAX_CHARS - 12)
  return `${text.slice(0, keep)}…（已截断）`
}

/**
 * 组装包含 Case、验收清单 C1..Cn、根因与单一 `[NEXT STEP]` 的标准 Escalation Issue 载荷。
 *
 * 复现证据字段在这里就按上限收敛：超限时截断并在正文里写明「已截断」，
 * 同时把原始校验错误挂在载荷上供调用方上报——静默接受会把整段日志抄进建单正文。
 */
export function buildEscalationIssuePayload(item = {}, opts = {}) {
  const caseType = inferEscalationCase(item)
  const escalationTier = classifyEscalationTier(item)
  const title = formatWorkTitle(item.title ?? item.summary ?? '未命名升级问题', caseType)
  const reproCheck = validateReproEvidenceFields(item)
  const reproEvidence = clampReproField(reproCheck.reproEvidence)
  const pocCommand = clampReproField(reproCheck.pocCommand)
  const labels = [...new Set((Array.isArray(item.labels) && item.labels.length > 0 ? item.labels : [item.stopLoss ? 'stop-loss' : 'escalation'])
    .map((l) => String(l ?? '').trim())
    .filter(Boolean))]
  const rawCriteria = Array.isArray(item.criteria) && item.criteria.length > 0
    ? item.criteria
    : (item.summary ? [`核实并根治「${String(item.summary).trim()}」且补齐双向测试`] : ['补齐根因修复与回归验证且全量门禁通过'])
  const criteria = rawCriteria.map((c, idx) => {
    const text = String(c ?? '').trim()
    return /^- \[[ xX]\]\s+C\d+\b/.test(text) ? text : `- [ ] C${idx + 1}: ${text}`
  })
  const rootCause = String(item.rootCause ?? item.reason ?? '同一阻塞或跨边界问题已超出局部热修承受上限，须拆出独立契约/架构根治。').trim()
  const nextStep = String(item.nextStep ?? 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --touches-contract --summary "Escalation follow-up"').trim()
  const repoRoot = opts?.repoRoot ?? item.repoRoot ?? item.mainRoot ?? null

  const body = (typeof item.body === 'string' && item.body.trim())
    ? hydrateIssueBody(repoRoot, caseType === 2 ? 'bug' : 'feature', { rawBody: item.body }).trim()
    : hydrateIssueBody(repoRoot, caseType === 2 ? 'bug' : 'feature', {
      title: item.title ?? item.summary ?? '未命名升级问题',
      summary: item.summary ?? rootCause,
      findingsSummary: item.findingsSummary,
      rootCause,
      caseType,
      source: item.source ?? 'escalation',
      tier: escalationTier,
      taskId: item.taskId,
      category: item.category,
      severity: item.severity,
      files: item.files,
      reproEvidence,
      pocCommand,
      stopLossPacket: item.stopLossPacket,
      criteria,
      nextStep,
    }).trim()

  return {
    title,
    body,
    labels,
    caseType,
    escalationTier,
    rootCause,
    criteria,
    nextStep,
    ...(reproEvidence ? { reproEvidence } : {}),
    ...(pocCommand ? { pocCommand } : {}),
    ...(reproCheck.ok ? {} : { reproTruncated: true, reproWarnings: reproCheck.errors }),
    ...(item.category ? { category: item.category } : {}),
    ...(item.severity ? { severity: item.severity } : {}),
    ...(item.milestone !== undefined && item.milestone !== null ? { milestone: item.milestone } : {}),
  }
}

/** 将 dev-govern 审计发现按类别聚合并输出统一 Escalation 载荷列表。 */
export function buildIssues(findings = [], opts = {}) {
  const actionable = (Array.isArray(findings) ? findings : []).filter((f) => f && f.severity !== 'info')
  const grouped = new Map()
  for (const f of actionable) {
    if (!grouped.has(f.category)) grouped.set(f.category, [])
    grouped.get(f.category).push(f)
  }
  const issues = []
  for (const [cat, items] of grouped.entries()) {
    const highest = items.some((x) => x.severity === 'critical') ? 'critical'
      : items.some((x) => x.severity === 'high') ? 'high' : 'medium'
    const files = [...new Set(items.map((x) => x.file).filter(Boolean))]
    const singleFile = files.length <= 1
    const rawTitle = `[govern/${cat}] Resolve ${items.length} ${cat} finding(s) (max severity: ${highest})`
    const findingsSummary = [
      `Findings detected by \`govern-audit\` (${cat}, max severity: ${highest}):`,
      '',
      ...items.slice(0, 25).map((item, idx) =>
        `${idx + 1}. **[${String(item.severity ?? 'medium').toUpperCase()}]** ${item.title}${item.action ? ` — Action: ${item.action}` : ''}`),
      ...(items.length > 25 ? ['', `_...and ${items.length - 25} more items in category \`${cat}\`._`] : []),
    ].join('\n')
    issues.push(buildEscalationIssuePayload({
      source: 'govern',
      category: cat,
      severity: highest,
      caseType: 3,
      findings: items,
      count: items.length,
      singleFile,
      files,
      title: rawTitle,
      summary: `${items.length} ${cat} finding(s) detected by govern-audit`,
      findingsSummary,
      criteria: items.slice(0, 5).map((item, idx) => `- [ ] C${idx + 1}: Resolve \`${item.id}\``),
      nextStep: 'node ".agents/skills/dev-govern/scripts/govern-audit.mjs" plan .',
      labels: ['governance', cat],
    }, opts))
  }
  return issues
}

/** 按仓库 Git 拓扑探测并构造对应三态 TaskBackend。 */
export async function resolveEscalationBackend(repoRoot, opts = {}) {
  const fastGitDir = resolveGitDirFast(repoRoot)
  const fastCfg = readGitConfigFast(fastGitDir)
  const remotes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(repoRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remotes.stdout)
  const topology = parseRemotesTopology(remotes.stdout)
  const originUrl = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const targetRepo = githubRepoFull(originUrl)
  const hasRemote = Boolean(remotes.ok && Object.keys(remoteUrls).length > 0)
  const markers = fastGitDir ? detectGitModeMarkers(fastGitDir, { hasRemote }) : { localMode: false }
  const isLocal = !hasRemote || markers.localMode || topology.providerId === 'none'
  const isGeneric = hasRemote && !markers.localMode && (topology.providerId === 'generic-git' || !targetRepo)

  if (isLocal || isGeneric) {
    return {
      ok: true,
      targetRepo,
      backend: createTaskBackend({
        role: isLocal ? 'local-only' : 'generic-git',
        providerId: isLocal ? 'none' : 'generic-git',
        targetRepo,
        mainRoot: repoRoot,
        gitDir: fastGitDir,
      }),
    }
  }
  const probe = opts._ghProbe ?? (opts._ghClient
    ? { env: { providerId: 'github', trackB: { tier: opts._ghClient.tier ?? 'gh-cli' } }, client: opts._ghClient }
    : await probeForWrite({ cwd: repoRoot, remoteUrls }))
  if (probe.env.trackB.tier !== 'gh-cli' && probe.env.trackB.tier !== 'node-https-token') {
    return {
      ok: false,
      targetRepo,
      error: '`gh` CLI / GitHub token is not available; sign in to GitHub first.',
    }
  }
  return {
    ok: true,
    targetRepo,
    backend: createTaskBackend({
      role: 'maintainer',
      providerId: 'github',
      targetRepo,
      client: probe.client,
      mainRoot: repoRoot,
      gitDir: fastGitDir,
    }),
  }
}

/** 校验 `--no-escalate` 豁免：启用时必须带非空 `--reason` 才能跳过自动建单。 */
export function evaluateNoEscalateExemption({ noEscalate = false, reason = '' } = {}) {
  if (!noEscalate) return { ok: true, skip: false, reason: null }
  const clean = String(reason ?? '').trim()
  if (!clean) {
    return {
      ok: false,
      skip: false,
      code: 'MISSING_NO_ESCALATE_REASON',
      exitCode: EXIT.USAGE,
      error: 'MISSING_NO_ESCALATE_REASON: --no-escalate 必须同时传入非空 --reason "<跳过自动建单原因>"',
    }
  }
  return { ok: true, skip: true, reason: clean }
}

/**
 * 统一 Escalation 建单出口：带未闭环标题去重与远端写入门禁，适配三态后端。
 */
export async function escalateToBackend({
  backend = null,
  targetRepo = null,
  repoRoot = null,
  item = {},
  force = false,
  deduplicate = true,
  noEscalate = false,
  reason = '',
  _ghProbe = null,
  _ghClient = null,
} = {}) {
  const exemption = evaluateNoEscalateExemption({ noEscalate, reason })
  if (!exemption.ok) return exemption
  if (exemption.skip) {
    return {
      ok: true,
      skipped: true,
      tier: 'exempted',
      action: 'no-escalate-exempted',
      reason: exemption.reason,
      title: String(item?.title ?? ''),
    }
  }
  const payload = buildEscalationIssuePayload(item, { repoRoot })
  if (!force && payload.escalationTier === 'inline-todo') {
    return {
      ok: true,
      skipped: true,
      tier: 'inline-todo',
      action: 'record-inline-todo',
      title: payload.title,
    }
  }

  let activeBackend = backend
  let resolvedRepo = targetRepo
  if (!activeBackend) {
    if (!repoRoot) return { ok: false, error: 'escalateToBackend 缺少 backend 或 repoRoot 参数' }
    const resolved = await resolveEscalationBackend(repoRoot, { _ghProbe, _ghClient })
    if (!resolved.ok) return { ok: false, error: resolved.error, tier: payload.escalationTier }
    activeBackend = resolved.backend
    resolvedRepo = resolvedRepo ?? resolved.targetRepo
  } else if (activeBackend.kind === 'github' && repoRoot && !_ghProbe && !_ghClient && !activeBackend.client) {
    await probeForWrite({ cwd: repoRoot, remoteUrls: {} })
  }

  if (deduplicate && typeof activeBackend.listIssues === 'function') {
    try {
      const openRes = await activeBackend.listIssues({ repo: resolvedRepo, state: 'open', perPage: 50 })
      if (openRes?.ok && Array.isArray(openRes.issues)) {
        const dup = openRes.issues.find((x) => String(x?.title ?? '').trim() === payload.title)
        if (dup) {
          return {
            ok: true,
            deduplicated: true,
            tier: payload.escalationTier,
            title: payload.title,
            number: dup.number,
            url: dup.url ?? null,
            ...(dup.local ? { local: true } : {}),
          }
        }
      }
    } catch { /* ignore list fallback errors */ }
  }

  const res = await activeBackend.createIssue({
    repo: resolvedRepo,
    title: payload.title,
    body: payload.body,
    labels: payload.labels,
    ...(payload.milestone !== undefined ? { milestone: payload.milestone } : {}),
  })
  if (!res?.ok) {
    return {
      ok: false,
      tier: payload.escalationTier,
      title: payload.title,
      delegated: Boolean(res?.delegated),
      ...(res?.jsonPayload ? { jsonPayload: res.jsonPayload } : {}),
      error: res?.error ?? 'Issue create failed',
    }
  }
  return {
    ok: true,
    tier: payload.escalationTier,
    title: payload.title,
    number: res.number,
    url: res.url ?? null,
    ...(res.local ? { local: true } : {}),
  }
}

/** 批量把治理想单写入当前识别的 TaskBackend（`github` / `local-only` / `generic-git`）。 */
export async function applyIssuesToBackend(repoRoot, issues, opts = {}) {
  if (!Array.isArray(issues) || issues.length === 0) return { applied: [], error: undefined }
  const resolved = await resolveEscalationBackend(repoRoot, opts)
  if (!resolved.ok) return { applied: [], error: resolved.error }

  const created = []
  for (const iss of issues) {
    const res = await escalateToBackend({
      backend: resolved.backend,
      targetRepo: resolved.targetRepo,
      repoRoot,
      item: { ...iss, forceIssue: true },
      force: true,
      deduplicate: opts.deduplicate ?? false,
    })
    if (!res.ok) return { applied: created, error: `Issue create failed: ${res.error ?? 'unknown error'}` }
    created.push({ title: res.title, url: res.url, number: res.number, ...(res.local ? { local: true } : {}) })
  }
  return { applied: created, error: undefined }
}

/**
 * 审查默认升级出口：在未显式 `--no-escalate --reason` 豁免时自动调用 `escalateToBackend` 建单；
 * `local-only` 自动写本地工单，远端故障降级 `delegated` 并附带告警而不掩盖错误。
 */
export async function autoEscalateBlockingFindings({
  repoRoot = null,
  backend = null,
  targetRepo = null,
  item = {},
  noEscalate = false,
  noEscalateReason = '',
  force = true,
  deduplicate = true,
  _ghProbe = null,
  _ghClient = null,
} = {}) {
  const res = await escalateToBackend({
    backend, targetRepo, repoRoot,
    item: { ...item, forceIssue: true },
    force, deduplicate,
    noEscalate, reason: noEscalateReason,
    _ghProbe, _ghClient,
  })
  if (!res.ok && res.code === 'MISSING_NO_ESCALATE_REASON') return res
  if (!res.ok) {
    return {
      ...res,
      degraded: Boolean(res.delegated),
      warning: res.delegated
        ? `WARN_ESCALATION_DELEGATED: 远端未就绪，已降级为 delegated 负载 (${res.error ?? 'offline'})`
        : `WARN_ESCALATION_FAILED: 自动建单失败 (${res.error ?? 'unknown error'})`,
    }
  }
  return res
}
