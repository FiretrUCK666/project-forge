/**
 * escalation.mjs —— C12 统一 Escalation 分级建单与 C22 工作类型前缀单源引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-govern、dev-review、dev-flow 与 dev-plan 共用。
 * 所有远端写路径统一经 `probeForWrite` 探测，兼顾 `github` / `local-only` / `generic-git` 三态后端，
 * 并在写入任何后端前统一经 `validateIssueBodyQuality` 拦截低质量工单。
 */

import { EXIT } from './exit-codes.mjs'
import { gitRun, posixPath, sha256Text } from './git.mjs'
import { validateIssueBodyQuality } from './issue-quality.mjs'
import { hydrateIssueBody } from './issue-template-hydrate.mjs'
import { readGitConfigFast, resolveGitDirFast } from './git-fast.mjs'
import { readTaskLedger, resolveLedgerRoot, updateTaskLedger } from './ledger.mjs'
import { detectGitModeMarkers, isVerifiedTier, parseRemoteUrls, probeForWrite, resolveRemoteTarget } from './platform.mjs'
import { createTaskBackend } from './task-backend.mjs'

const EXPLICIT_WORK_PREFIX_RE = /^(?:(?:docs|fix|feat|refactor|chore|test|ci|build|perf|style|revert)(?:\([^)]+\))?:\s+|\[[^\]]+\]\s*)/i
const PF_SIG_RE = /\bpf-sig:([0-9a-f]{12})\b/i
const STRUCTURED_ESCALATION_BODY_RE = /^##\s+(?:Evidence|Unknowns|NextSteps)\b/m

/** 规范化错误摘要片段：剥离易变行号/列号、临时 worktree 前缀、盘符绝对路径与 SHA/时间戳，生成稳定签名输入。 */
export function normalizeEscalationSignaturePart(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/(?:[A-Za-z]:\\|\/(?:tmp|var\/folders|private\/var\/folders)\/)[^\s"'`)]+/g, (p) => {
      const norm = p.replace(/\\/g, '/')
      const wtIdx = norm.lastIndexOf('/.worktrees/')
      if (wtIdx >= 0) return norm.slice(wtIdx + 1).replace(/^\.worktrees\/[^/]+\//, '')
      const anchor = /\/((?:src|kit|scripts|lib|packages|apps|test|tests)\/.+)$/i.exec(norm)
      if (anchor) return anchor[1]
      return '<tmp>'
    })
    .replace(/\.worktrees\/[^/\s]+\//g, '')
    .replace(/:\d+(?::\d+)?\b/g, '')
    .replace(/\bline\s+\d+\b/gi, 'line')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<sha>')
    .replace(/\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?/g, '<ts>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 计算稳定错误签名指纹（`pf-sig:<hash12>`），消除行号/路径差异导致的重复建单。 */
export function computeEscalationFingerprint(item = {}) {
  const explicit = typeof item?.fingerprint === 'string' ? PF_SIG_RE.exec(item.fingerprint.trim()) : null
  if (explicit) return `pf-sig:${explicit[1].toLowerCase()}`
  const files = Array.isArray(item?.files) ? item.files : (item?.files ? [item.files] : [])
  const primaryFile = files
    .map((f) => posixPath(String(f ?? '')).replace(/^\.worktrees\/[^/]+\//, '').replace(/^\.\//, '').trim())
    .filter(Boolean)
    .sort()[0] ?? ''
  const rawSummary = item?.signatureText ?? item?.summary ?? item?.title ?? item?.rootCause ?? ''
  const cleanTitle = String(rawSummary ?? '').replace(EXPLICIT_WORK_PREFIX_RE, '').trim()
  const key = {
    category: String(item?.category ?? item?.source ?? 'escalation').trim().toLowerCase(),
    code: String(item?.code ?? item?.pattern ?? '').trim().toUpperCase(),
    target: primaryFile,
    summary: normalizeEscalationSignaturePart(cleanTitle || rawSummary),
  }
  return `pf-sig:${sha256Text(JSON.stringify(key)).slice(0, 12)}`
}

export function extractEscalationFingerprint(bodyOrIssue) {
  const raw = typeof bodyOrIssue === 'string'
    ? bodyOrIssue
    : `${bodyOrIssue?.body ?? ''}\n${bodyOrIssue?.title ?? ''}`
  const m = PF_SIG_RE.exec(raw)
  return m ? `pf-sig:${m[1].toLowerCase()}` : null
}

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

function collectNormalizedItemFiles(item = {}) {
  const list = [
    ...(Array.isArray(item.files) ? item.files : (item.files ? [item.files] : [])),
    ...(Array.isArray(item.stopLossPacket?.hotspotFiles) ? item.stopLossPacket.hotspotFiles : []),
  ]
  return [...new Set(list.map((f) => posixPath(String(f ?? '')).trim()).filter(Boolean))]
}

function inferModuleDirs(files = []) {
  const dirs = new Set()
  for (const f of files) {
    const parts = posixPath(f).split('/').filter(Boolean)
    if (parts.length >= 2) dirs.add(parts.slice(0, Math.min(3, parts.length - 1)).join('/'))
    else if (parts.length === 1) dirs.add(parts[0])
  }
  return [...dirs]
}

function inferBoundaryImpact(cat, files = [], item = {}) {
  const touched = []
  const text = `${cat ?? ''} ${files.join(' ')} ${item.summary ?? ''} ${item.title ?? ''}`.toLowerCase()
  if (/security|auth|token|secret|perm|credential/.test(text)) touched.push('安全与凭据权限')
  if (/data|schema|sql|migration|ledger|state|cache/.test(text)) touched.push('持久化数据与状态账本')
  if (/api|cli|subcommand|contract|schema|protocol|backend/.test(text)) touched.push('对外接口与契约')
  if (/ci|workflow|release|hook|equip|gate/.test(text)) touched.push('CI 门禁与发布边界')
  return touched.length > 0 ? `触及 ${touched.join('、')}` : '仅限局部实现层，不破坏数据持久化、API 契约与权限安全边界'
}

function enrichStructuredEscalationBody(baseBody, { impactText, severityBasis, criteria, outOfScopeText }) {
  const parts = [baseBody.trimEnd()]
  if (!/^##\s+(?:影响面与严重度|影响范围|范围与依据|Scope|Impact)\b/im.test(baseBody)) {
    parts.push('', '## 影响面与严重度', '', [impactText, severityBasis ? `- 严重度依据：${severityBasis}` : null].filter(Boolean).join('\n'))
  }
  if (!/^##\s+(?:验收标准|Acceptance Criteria)\b/im.test(baseBody)) {
    parts.push('', '## 验收标准', '', criteria.join('\n'))
  }
  if (!/^##\s+(?:不在本次范围|Out of Scope|非目标)\b/im.test(baseBody)) {
    parts.push('', '## 不在本次范围', '', outOfScopeText)
  }
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 组装包含 Case、影响面与严重度、验收清单 C1..Cn、Out of Scope、根因与单一 `[NEXT STEP]` 的标准 Escalation Issue 载荷。
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
  const files = collectNormalizedItemFiles(item)
  const fileScopeText = files.length > 0
    ? files.slice(0, 8).map((f) => `\`${f}\``).join('、')
    : (item.category ? `\`${item.category}\` 模块` : (item.taskId ? `任务 \`${item.taskId}\` 对应切片` : '涉及模块'))
  const sevLabel = String(item.severity ?? (item.stopLoss || item.e2eBlocking ? 'high' : 'medium')).toLowerCase()
  const rawCriteria = Array.isArray(item.criteria) && item.criteria.length > 0
    ? item.criteria
    : [
        pocCommand
          ? `根治「${String(item.summary ?? title).trim()}」并使 \`${pocCommand}\` 通过（退出码 0）`
          : `根治 ${fileScopeText} 中「${String(item.summary ?? title).trim()}」并补齐正反双向回归测试`,
      ]
  const criteria = rawCriteria.map((c, idx) => {
    const text = String(c ?? '').trim()
    return /^- \[[ xX]\]\s+C\d+\b/.test(text) ? text : `- [ ] C${idx + 1}: ${text}`
  })
  const rootCause = String(item.rootCause ?? item.reason ?? '同一阻塞或跨边界问题已超出局部热修承受上限，须拆出独立契约/架构根治。').trim()
  const nextStep = String(item.nextStep ?? 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --touches-contract --summary "Escalation follow-up"').trim()
  const repoRoot = opts?.repoRoot ?? item.repoRoot ?? item.mainRoot ?? null
  const impactText = String(item.impact ?? '').trim()
    || `- 受影响范围：${fileScopeText}（${inferBoundaryImpact(item.category, files, item)}）`
  const severityBasis = String(item.severityBasis ?? '').trim()
    || `severity=${sevLabel}${item.stopLoss ? '（触发停损熔断）' : ''}${item.e2eBlocking ? '（阻断 E2E 实证）' : ''}`
  const explicitOutOfScope = typeof item.outOfScope === 'string' && item.outOfScope.trim()
    ? item.outOfScope.trim()
    : (typeof item.outOfScopeText === 'string' && item.outOfScopeText.trim() ? item.outOfScopeText.trim() : '')
  const outOfScopeText = explicitOutOfScope
    || `- 排除 ${fileScopeText} 与 \`${item.category ?? item.taskId ?? '本升级单'}\` 之外的无关模块重构与历史文档改写。`
  const expectedText = String(item.expected ?? '').trim()
    || (pocCommand
      ? `修复 ${fileScopeText} 根因后重放 \`${pocCommand}\` 返回退出码 0。`
      : `围绕 ${fileScopeText} 按根因收敛：${rootCause}`)

  const isBareRawBody = typeof item.body === 'string' && item.body.trim().length > 0
    && !STRUCTURED_ESCALATION_BODY_RE.test(item.body)
    && !item.impact && !item.outOfScopeText && !(Array.isArray(item.criteria) && item.criteria.length > 0)
  let rawHydrated = (typeof item.body === 'string' && item.body.trim())
    ? hydrateIssueBody(repoRoot, caseType === 2 ? 'bug' : 'feature', { rawBody: item.body }).trim()
    : hydrateIssueBody(repoRoot, caseType === 2 ? 'bug' : 'feature', {
      title: item.title ?? item.summary ?? '未命名升级问题',
      summary: item.summary ?? rootCause,
      findingsSummary: item.findingsSummary,
      baseline: item.baseline,
      limitations: item.limitations,
      impact: impactText,
      severityBasis,
      expected: expectedText,
      rootCause,
      caseType,
      source: item.source ?? 'escalation',
      tier: escalationTier,
      taskId: item.taskId,
      category: item.category,
      severity: sevLabel,
      files,
      reproEvidence,
      pocCommand,
      stopLossPacket: item.stopLossPacket,
      criteria,
      outOfScope: outOfScopeText,
      docRefs: item.docRefs,
      nextStep,
    }).trim()

  if (typeof item.body === 'string' && item.body.trim() && !isBareRawBody) {
    rawHydrated = enrichStructuredEscalationBody(rawHydrated, {
      impactText,
      severityBasis,
      criteria,
      outOfScopeText,
    })
  }

  const fingerprint = computeEscalationFingerprint(item)
  const body = rawHydrated.includes(fingerprint) ? rawHydrated : `${rawHydrated}\n\n<!-- ${fingerprint} -->`

  return {
    title,
    body,
    fingerprint,
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

/** 将 dev-govern 审计发现按类别聚合并输出自包含富证据 Escalation 载荷列表。 */
export function buildIssues(findings = [], opts = {}) {
  const actionable = (Array.isArray(findings) ? findings : []).filter((f) => f && f.severity !== 'info')
  const grouped = new Map()
  for (const f of actionable) {
    if (!grouped.has(f.category)) grouped.set(f.category, [])
    grouped.get(f.category).push(f)
  }
  const issues = []
  for (const [cat, items] of grouped.entries()) {
    const sevCounts = { critical: 0, high: 0, medium: 0, low: 0 }
    for (const x of items) {
      const s = String(x.severity ?? 'medium').toLowerCase()
      if (Object.prototype.hasOwnProperty.call(sevCounts, s)) sevCounts[s] += 1
    }
    const highest = sevCounts.critical > 0 ? 'critical'
      : sevCounts.high > 0 ? 'high'
        : sevCounts.medium > 0 ? 'medium' : 'low'
    const files = [...new Set(items.map((x) => posixPath(x.file ?? '')).filter(Boolean))]
    const modDirs = inferModuleDirs(files)
    const formatLoc = (it) => {
      const f = posixPath(it.file ?? '')
      if (!f) return 'repo-level'
      return it.line ? `${f}:${it.line}` : f
    }
    const singleFile = files.length <= 1
    const rawTitle = `[govern/${cat}] Resolve ${items.length} ${cat} finding(s) (max severity: ${highest})`
    const findingsSummary = [
      `Findings detected by \`govern-audit\` (${cat}, max severity: ${highest}):`,
      '',
      ...items.slice(0, 25).map((item, idx) => {
        const loc = formatLoc(item)
        const sev = String(item.severity ?? 'medium').toUpperCase()
        return `${idx + 1}. **[${sev}]** \`${item.id ?? cat}\` at \`${loc}\` — ${item.title}${item.action ? ` (Action: ${item.action})` : ''}`
      }),
      ...(items.length > 25 ? ['', `_...and ${items.length - 25} more items in category \`${cat}\`._`] : []),
    ].join('\n')
    const pocCmd = `node ".agents/skills/dev-govern/scripts/govern-audit.mjs" audit . --categories ${cat} --json`
    const affectedText = files.length > 0
      ? files.slice(0, 8).map((f) => `\`${f}\``).join('、')
      : `\`${cat}\` 作用域`
    const modText = modDirs.length > 0 ? modDirs.slice(0, 6).map((d) => `\`${d}/\``).join('、') : `\`${cat}\``
    const sevBasis = `最高严重度=${highest}（critical=${sevCounts.critical}, high=${sevCounts.high}, medium=${sevCounts.medium}, low=${sevCounts.low}，共 ${items.length} 条）`
    const reproList = items.slice(0, 5).map((it) => `${formatLoc(it)} [${it.id ?? cat}]`)
    const criteria = items.slice(0, 5).map((item, idx) =>
      `- [ ] C${idx + 1}: 修复 \`${formatLoc(item)}\` 的 \`${item.id ?? cat}\` 并确保 \`${pocCmd}\` 零该项告警`)
    const outOfScopeText = `- 排除 \`${cat}\` 之外的审计类别，以及未列入 ${affectedText} 的无关模块改造。`

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
      summary: `${items.length} ${cat} finding(s) in ${modText} detected by govern-audit`,
      findingsSummary,
      impact: `- 受波及模块：${modText}（涉及文件：${affectedText}）；${inferBoundaryImpact(cat, files)}`,
      severityBasis: sevBasis,
      baseline: `静态扫描 \`govern-audit\` 类别 \`${cat}\` 覆盖 ${files.length} 个文件，命中 ${items.length} 条告警（${sevBasis}）。`,
      limitations: '仅完成静态规则扫描，未包含运行时业务路径、并发压力与外部接口真实调用验证。',
      expected: `逐一收敛 ${affectedText} 中的 \`${cat}\` 问题并重跑 \`${pocCmd}\` 返回 0 条 \`critical/high\` 告警。`,
      reproEvidence: reproList.join('；'),
      pocCommand: pocCmd,
      criteria,
      outOfScopeText,
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
  const remoteTarget = resolveRemoteTarget(remoteUrls, { cwd: repoRoot })
  const targetRepo = remoteTarget.repoSlug ?? null
  const hasRemote = Boolean(remotes.ok && Object.keys(remoteUrls).length > 0)
  const markers = fastGitDir ? detectGitModeMarkers(fastGitDir, { hasRemote }) : { localMode: false }
  const isLocal = !hasRemote || markers.localMode || remoteTarget.providerId === 'none'
  const isGeneric = hasRemote && !markers.localMode && (remoteTarget.capabilities?.issues !== true || !targetRepo)

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
    ? { env: { providerId: remoteTarget.providerId, trackB: { tier: opts._ghClient.tier ?? 'gh-cli' } }, client: opts._ghClient }
    : await probeForWrite({ cwd: repoRoot, remoteUrls }))
  if (!isVerifiedTier(probe?.env?.trackB?.tier)) {
    return {
      ok: false,
      targetRepo,
      error: remoteTarget.providerId === 'github'
        ? '`gh` CLI / GitHub token is not available; sign in to GitHub first.'
        : `Platform API credentials for ${remoteTarget.providerId} are not available; configure token or CLI auth first.`,
    }
  }
  return {
    ok: true,
    targetRepo,
    backend: createTaskBackend({
      role: 'maintainer',
      providerId: remoteTarget.providerId,
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

async function recordEscalatedIssueIfTracked(repoRoot, item, issueNumber) {
  const num = Number(issueNumber)
  const baseRoot = item?.mainRoot ?? repoRoot
  if (!baseRoot || !item?.taskId || !Number.isInteger(num) || num <= 0) return
  const isE2e = Boolean(item.e2eBlocking || (Array.isArray(item.labels) && item.labels.includes('e2e-fail')))
  if (!isE2e) return
  try {
    const ledgerRoot = await resolveLedgerRoot(baseRoot)
    const cur = readTaskLedger(ledgerRoot, item.taskId)
    if (!cur) return
    await updateTaskLedger(ledgerRoot, item.taskId, (latest) => {
      const prev = Array.isArray(latest?.escalatedIssues) ? latest.escalatedIssues : []
      return {
        ...(latest ?? cur),
        escalatedIssues: [...new Set([...prev, num].map(Number).filter((n) => Number.isInteger(n) && n > 0))],
      }
    })
  } catch { /* ledger record best-effort */ }
}

/**
 * 统一 Escalation 建单出口：带未闭环标题去重、质量底线校验与远端写入门禁，适配三态后端。
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

  const quality = validateIssueBodyQuality(payload.body, {
    repoRoot,
    mainRoot: item.mainRoot ?? repoRoot,
    title: payload.title,
    docRefs: item.docRefs,
    spec: item.spec,
    todo: item.todo,
    prd: item.prd,
  })
  if (!quality.ok) {
    return {
      ok: false,
      blocked: true,
      code: quality.code,
      exitCode: quality.exitCode,
      tier: payload.escalationTier,
      title: payload.title,
      missing: quality.missing,
      reasons: quality.reasons,
      invalidDocRefs: quality.invalidDocRefs,
      error: `${quality.code}: ${quality.reasons.join('；')}`,
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
        const dup = openRes.issues.find((x) => {
          const sameTitle = String(x?.title ?? '').trim() === payload.title
          if (sameTitle) return true
          const bodySig = extractEscalationFingerprint(x)
          if (bodySig && bodySig === payload.fingerprint) return true
          const normFallback = computeEscalationFingerprint({
            category: item.category ?? item.source,
            code: item.code ?? item.pattern,
            files: item.files,
            summary: x?.title,
          })
          return normFallback === payload.fingerprint
        })
        if (dup) {
          if (item.appendProgressComment !== false && typeof activeBackend.postComment === 'function') {
            try {
              const progressBody = [
                `[进展去重] 命中同一错误签名 \`${payload.fingerprint}\`，跳过重复建单。`,
                item.summary ? `- 最新摘要：${String(item.summary).trim()}` : null,
              ].filter(Boolean).join('\n')
              await activeBackend.postComment({ repo: resolvedRepo, number: dup.number, body: progressBody, deduplicate: true })
            } catch { /* ignore progress comment fallback error */ }
          }
          await recordEscalatedIssueIfTracked(repoRoot, item, dup.number)
          return {
            ok: true,
            deduplicated: true,
            fingerprint: payload.fingerprint,
            matchedBy: String(dup?.title ?? '').trim() === payload.title ? 'title' : 'signature',
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
  await recordEscalatedIssueIfTracked(repoRoot, item, res.number)
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
  for (const iss of issues) {
    const payload = buildEscalationIssuePayload({ ...iss, forceIssue: true }, { repoRoot })
    const q = validateIssueBodyQuality(payload.body, {
      repoRoot,
      mainRoot: iss?.mainRoot ?? repoRoot,
      title: payload.title,
      docRefs: iss?.docRefs,
      spec: iss?.spec,
      todo: iss?.todo,
      prd: iss?.prd,
    })
    if (!q.ok) {
      return {
        applied: [],
        blocked: true,
        code: q.code,
        exitCode: q.exitCode,
        missing: q.missing,
        reasons: q.reasons,
        error: `${q.code}: ${q.reasons.join('；')}`,
      }
    }
  }
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
    if (!res.ok) {
      return {
        applied: created,
        ...(res.blocked ? { blocked: true } : {}),
        ...(res.code ? { code: res.code } : {}),
        ...(res.exitCode ? { exitCode: res.exitCode } : {}),
        ...(res.missing ? { missing: res.missing } : {}),
        ...(res.reasons ? { reasons: res.reasons } : {}),
        error: res.code === 'BLOCKED_ISSUE_QUALITY_INCOMPLETE'
          ? res.error
          : `Issue create failed: ${res.error ?? 'unknown error'}`,
      }
    }
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
