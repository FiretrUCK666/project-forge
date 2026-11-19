/**
 * github-parse.mjs —— 托管平台 URL/引用纯解析、`pf-state` 指纹计算与 Commit Checks 汇总。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零非 GitHub 平台品牌词硬编码，
 * 以纯协议/路径规则兼容任意 HTTP(S) 托管站点与自建 Git 仓库。
 */

import { sha256Text } from './git.mjs'

/** 解析评论正文中的所有 `<!-- pf-state:{...} -->` 状态标签。 */
export function parsePfStateTags(body) {
  const tags = []
  for (const m of String(body ?? '').matchAll(/<!--\s*pf-state:(\{[\s\S]*?\})\s*-->/g)) {
    try {
      const parsed = JSON.parse(m[1])
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) tags.push(parsed)
    } catch { /* ignore malformed tag */ }
  }
  return tags
}

/** 剥离评论末尾的 `<!-- pf-state:{...} -->` 标签以便比较纯正文。 */
export function stripPfStateTags(body) {
  return String(body ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n*<!--\s*pf-state:\{[\s\S]*?\}\s*-->\s*/g, '')
    .trim()
}

function canonicalizeValue(val) {
  if (val === null || typeof val !== 'object') return val
  if (Array.isArray(val)) return val.map(canonicalizeValue)
  const out = {}
  for (const k of Object.keys(val).sort()) {
    if (k === 'writeBackFingerprint') continue
    if (val[k] !== undefined) out[k] = canonicalizeValue(val[k])
  }
  return out
}

/** 基于正文与 `pf-state` 载荷计算稳定的 sha256 回写去重指纹（`WriteBackFingerprint`）。 */
export function computeWriteBackFingerprint(body, statePayload = {}) {
  const cleanBody = stripPfStateTags(body)
  const canonState = canonicalizeValue(statePayload && typeof statePayload === 'object' ? statePayload : {})
  return sha256Text(JSON.stringify({ body: cleanBody, state: canonState }))
}

/** 解析 Issue / PR 正文中的依赖与引用关系（忽略代码块）。 */
export function parseBodyRelations(body) {
  const text = String(body ?? '')
  const out = { dependsOn: [], blocks: [], partOf: [], fixes: [], refs: [] }
  const cleanLines = []
  let inFence = false
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence) cleanLines.push(line)
  }
  const clean = cleanLines.join('\n')
  const extractNums = (re, bucket) => {
    for (const m of clean.matchAll(re)) {
      for (const numMatch of m[1].matchAll(/#(\d+)/g)) {
        const n = Number(numMatch[1])
        if (Number.isInteger(n) && !bucket.includes(n)) bucket.push(n)
      }
    }
  }
  extractNums(/\bdepends\s+on\s*:?\s*([^\n.;]+)/gi, out.dependsOn)
  extractNums(/\bblocks\s*:?\s*([^\n.;]+)/gi, out.blocks)
  extractNums(/\bpart\s+of\s*:?\s*([^\n.;]+)/gi, out.partOf)
  extractNums(/\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*:?\s*([^\n.;]+)/gi, out.fixes)
  extractNums(/\brefs?\s*:?\s*([^\n.;]+)/gi, out.refs)
  return out
}

const INTERNAL_AGENT_SLUG_RE = /^(?:local-agent|implementer|coordinator(?:-|$)|swarm(?:-|$)|worker(?:-|$)|subagent(?:-|$)|independent-review(?:er)?(?:-|$)|critic(?:-|$)|integrator(?:-|$)|agent-\d+|claude(?:-|$)|gemini(?:-|$)|gpt(?:-|$)|codex(?:-|$))/i

/** 判断标识是否为内部 AI 角色/调度代号而非真实仓库协作者账号。 */
export function isInternalAgentSlug(val) {
  const clean = String(val ?? '').replace(/<[^>]*>/g, '').trim().replace(/^@/, '')
  return clean ? INTERNAL_AGENT_SLUG_RE.test(clean) : true
}

/** 优先解析真实协作者署名（过滤内部子代理代号与冗余邮箱后缀），返回 `{ actor, display }`。 */
export function resolveContributorIdentity({ explicitActor, ghLogin, gitName, ledgerActor } = {}) {
  const clean = (v) => String(v ?? '').replace(/<[^>]*>/g, '').trim().replace(/^@/, '')
  const exp = clean(explicitActor)
  const picks = [
    exp && !isInternalAgentSlug(exp) ? exp : '',
    clean(ghLogin),
    clean(gitName),
    clean(ledgerActor),
  ].filter((x) => x && !isInternalAgentSlug(x))
  const actor = picks[0] || (!exp || isInternalAgentSlug(exp) ? 'maintainer' : exp)
  const display = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(actor) ? `@${actor}` : actor
  return { actor, display }
}

const PR_URL_PULL_RE = /^https?:\/\/[^/\s]+\/(.+?)\/(?:pull|pulls)\/(\d+)(?:[/?#]|$)/i
const PR_URL_MR_RE = /^https?:\/\/[^/\s]+\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#]|$)/i
const ISSUE_URL_RE = /^https?:\/\/[^/\s]+\/(.+?)\/issues\/(\d+)(?:[/?#]|$)/i
const MILESTONE_URL_RE = /^https?:\/\/[^/\s]+\/(.+?)\/milestone\/(\d+)(?:[/?#]|$)/i

function normalizeRepoPath(raw) {
  return String(raw ?? '').replace(/\/-$/, '').replace(/^\/+|\/+$/g, '')
}

/** 解析单个 PR/MR 引用（正整数、#M、pr#M、!M 或任意 HTTP(S) 托管站点 PR/MR URL）。 */
export function parsePrNumber(raw, { strict = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw > 0) return raw
    if (strict) throw new Error(`PR 编号必须为正整数，收到：${raw}`)
    return null
  }
  const s = String(raw).trim()
  if (!s) return null
  let m = PR_URL_PULL_RE.exec(s) || PR_URL_MR_RE.exec(s)
  if (m) return Number(m[2])
  m = /^(?:pr#|pr|#|!)(\d+)$/i.exec(s)
  if (m) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0) return n
  }
  if (/^\d+$/.test(s)) {
    const n = Number(s)
    if (Number.isInteger(n) && n > 0) return n
  }
  if (strict) throw new Error(`PR 引用格式无效（支持编号、#M、pr#M、!M 或 HTTP(S) PR/MR URL）：${raw}`)
  return null
}

/** 解析 Issue 引用或列表（正整数、#N、issue#N 或任意 HTTP(S) 托管站点 Issue URL，支持逗号/空格分隔）。 */
export function parseIssueNumbers(rawOrList, { strict = false } = {}) {
  const tokens = (Array.isArray(rawOrList) ? rawOrList : [rawOrList])
    .flatMap((v) => (v === undefined || v === null ? [] : String(v).split(/[\s,]+/)))
    .map((s) => s.trim())
    .filter(Boolean)
  const nums = []
  for (const tok of tokens) {
    let m = ISSUE_URL_RE.exec(tok)
    const rawNum = m ? m[2] : ((/^(?:issue)?#?(\d+)$/i.exec(tok))?.[1] ?? null)
    if (rawNum) {
      const n = Number(rawNum)
      if (Number.isInteger(n) && n > 0 && !nums.includes(n)) nums.push(n)
    } else if (strict) {
      throw new Error(`Issue 引用格式无效（支持正整数、#N、issue#N 或 HTTP(S) Issue URL）：${tok}`)
    }
  }
  return nums
}

/** 解析 Milestone 引用（正整数、`milestone#N`、`m#N` 或 HTTP(S) Milestone URL）。 */
export function parseMilestoneNumber(raw, { strict = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw > 0) return raw
    if (strict) throw new Error(`Milestone 编号必须为正整数，收到：${raw}`)
    return null
  }
  const s = String(raw).trim()
  if (!s) return null
  const um = MILESTONE_URL_RE.exec(s)
  if (um) return Number(um[2])
  const pm = /^(?:milestone#|m#)?(\d+)$/i.exec(s)
  if (pm) {
    const n = Number(pm[1])
    if (Number.isInteger(n) && n > 0) return n
  }
  if (strict) throw new Error(`Milestone 引用格式无效：${raw}`)
  return null
}

/** 解析混合输入列表（任意 HTTP(S) Issue/PR/MR/Milestone URL / #N / issue#N / pr#N / !M）。 */
export function parseFlowInputs(inputs = [], defaultRepo = null) {
  const issues = []
  const prs = []
  const milestones = []
  const unknown = []
  for (const raw of inputs) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    let m = MILESTONE_URL_RE.exec(s)
    if (m) { milestones.push({ repo: normalizeRepoPath(m[1]), number: Number(m[2]), raw: s }); continue }
    m = ISSUE_URL_RE.exec(s)
    if (m) { issues.push({ repo: normalizeRepoPath(m[1]), number: Number(m[2]), raw: s }); continue }
    m = PR_URL_PULL_RE.exec(s) || PR_URL_MR_RE.exec(s)
    if (m) { prs.push({ repo: normalizeRepoPath(m[1]), number: Number(m[2]), raw: s }); continue }
    m = /^(?:pr#|!)(\d+)$/i.exec(s)
    if (m) { prs.push({ repo: defaultRepo, number: Number(m[1]), raw: s }); continue }
    m = /^(?:issue)?#(\d+)$/i.exec(s)
    if (m) { issues.push({ repo: defaultRepo, number: Number(m[1]), raw: s }); continue }
    unknown.push(s)
  }
  return { issues, prs, milestones, unknown }
}

/** 解析并按同名/上下文去重汇总提交的 check-runs 与 commit statuses，查询异常且无明确失败时强降级为 unknown。 */
export function summarizeCommitChecks(checkRunsRaw, combinedStatusRaw, { warnings = [] } = {}) {
  const crList = Array.isArray(checkRunsRaw) ? checkRunsRaw : (Array.isArray(checkRunsRaw?.check_runs) ? checkRunsRaw.check_runs : [])
  const stList = Array.isArray(combinedStatusRaw) ? combinedStatusRaw : (Array.isArray(combinedStatusRaw?.statuses) ? combinedStatusRaw.statuses : [])

  const latestRuns = new Map()
  for (const cr of crList) {
    const name = String(cr?.name ?? '').trim()
    if (!name) continue
    const prev = latestRuns.get(name)
    if (!prev) { latestRuns.set(name, cr); continue }
    const idCur = Number(cr?.id) || 0
    const idPrev = Number(prev?.id) || 0
    if (idCur > idPrev || (idCur === idPrev && String(cr?.started_at ?? '') > String(prev?.started_at ?? ''))) {
      latestRuns.set(name, cr)
    }
  }

  const passed = []
  const pending = []
  const failed = []

  for (const cr of latestRuns.values()) {
    const name = String(cr?.name ?? '').trim()
    const status = String(cr?.status ?? '').toLowerCase()
    const conclusion = cr?.conclusion ? String(cr.conclusion).toLowerCase() : null
    const url = cr?.details_url ?? cr?.html_url ?? null
    if (status !== 'completed') {
      pending.push({ kind: 'check-run', name, state: status || 'queued', url })
    } else if (conclusion && ['success', 'neutral', 'skipped'].includes(conclusion)) {
      passed.push({ kind: 'check-run', name, state: conclusion, url })
    } else {
      failed.push({ kind: 'check-run', name, state: conclusion || 'failure', url })
    }
  }

  const seenCtx = new Set()
  for (const st of stList) {
    const ctx = String(st?.context ?? '').trim()
    if (!ctx || seenCtx.has(ctx)) continue
    seenCtx.add(ctx)
    const state = String(st?.state ?? '').toLowerCase()
    const url = st?.target_url ?? null
    if (state === 'pending') pending.push({ kind: 'status', name: ctx, state, url })
    else if (state === 'success') passed.push({ kind: 'status', name: ctx, state, url })
    else failed.push({ kind: 'status', name: ctx, state: state || 'failure', url })
  }

  const warningList = Array.isArray(warnings) ? warnings.filter(Boolean).map(String) : []
  const total = passed.length + pending.length + failed.length
  const bucket = failed.length > 0 ? 'fail'
    : warningList.length > 0 ? 'unknown'
      : pending.length > 0 ? 'pending'
        : passed.length > 0 ? 'pass' : 'none'
  return { ok: true, bucket, total, passed, pending, failed, warnings: warningList }
}

export const NON_RETRYABLE_STATUSES = new Set([400, 401, 403, 404, 405, 409, 413, 422])
export const RETRYABLE_NET_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'ESOCKETTIMEDOUT', 'ECONNABORTED',
])
export const MAX_RETRY_DELAY_MS = 60000

export function redactGhTokens(text) {
  return String(text ?? '').replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]')
}

export function parseRetryAfterMs(headers, capMs = MAX_RETRY_DELAY_MS) {
  if (!headers || typeof headers !== 'object') return null
  const raw = headers['retry-after'] ?? headers['Retry-After']
  if (raw === undefined || raw === null || raw === '') return null
  const num = Number(raw)
  if (Number.isFinite(num) && num >= 0) return Math.min(capMs, Math.round(num * 1000))
  const ts = Date.parse(String(raw))
  if (Number.isFinite(ts)) return Math.min(capMs, Math.max(0, ts - Date.now()))
  return null
}

export function extractCliHttpStatus(stderr) {
  const s = String(stderr ?? '')
  const m = /\bHTTP\s+(\d{3})\b/i.exec(s) ?? /\bstatus(?:\s+code)?\s*[:=]\s*(\d{3})\b/i.exec(s)
  if (m) return Number(m[1])
  if (/403 Forbidden|not authorized/i.test(s)) return 403
  if (/401 Unauthorized/i.test(s)) return 401
  if (/409\b|head branch was modified/i.test(s)) return 409
  if (/405\b|method not allowed/i.test(s)) return 405
  if (/429 Too Many Requests|rate limit/i.test(s)) return 429
  if (/502 Bad Gateway/i.test(s)) return 502
  if (/503 Service Unavailable/i.test(s)) return 503
  if (/504 Gateway/i.test(s)) return 504
  return 0
}

export function isRetryableHttpOutcome(resOrErr) {
  if (!resOrErr || resOrErr.ok) return false
  const status = Number(resOrErr.status ?? 0)
  if (status >= 300 && status < 400) return false
  if (NON_RETRYABLE_STATUSES.has(status) || (status >= 400 && status < 500 && status !== 408 && status !== 429)) return false
  if (status === 429 || status === 408 || (status >= 500 && status < 600)) return true
  const code = String(resOrErr.code ?? '')
  if (RETRYABLE_NET_CODES.has(code) || /^ERR_TLS_/i.test(code)) return true
  if (resOrErr.timedOut === true || resOrErr.name === 'TimeoutError' || resOrErr.name === 'AbortError') return true
  const msg = String(resOrErr.message ?? resOrErr.error ?? resOrErr.stderr ?? resOrErr.data?.message ?? '')
  return status === 0 && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ERR_TLS_|TLS|timed?\s*out|socket hang up|429 Too Many Requests|502|503|504/i.test(msg)
}

export function normalizeRepoMetaPayload(data = {}, viewerLogin = null) {
  const perms = data?.permissions
  return {
    ok: true,
    isFork: Boolean(data?.fork),
    parent: data?.parent?.full_name?.toLowerCase() ?? null,
    defaultBranch: data?.default_branch ?? 'main',
    viewerLogin,
    viewerPermission: perms?.admin ? 'ADMIN' : perms?.maintain ? 'MAINTAIN' : perms?.push ? 'WRITE' : (perms?.pull || !perms ? 'READ' : 'NONE'),
  }
}

export function normalizeMilestonePayload(d = {}) {
  return {
    number: d.number ?? null,
    title: d.title ?? '',
    state: String(d.state ?? 'open').toLowerCase(),
    description: d.description ?? '',
    dueOn: d.due_on ?? d.dueOn ?? null,
    url: d.html_url ?? d.url ?? null,
  }
}

export function normalizeIssuePayload(d = {}, isRest = false) {
  return {
    number: d.number,
    title: d.title,
    state: String(d.state ?? '').toUpperCase(),
    body: d.body ?? '',
    url: isRest ? (d.html_url ?? null) : (d.url ?? null),
    labels: (d.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
    milestone: d.milestone ? normalizeMilestonePayload(d.milestone) : null,
    relations: parseBodyRelations(d.body),
  }
}

export function normalizePrPayload(d = {}, isRest = false) {
  if (!isRest) {
    const headRepo = d.headRepositoryOwner?.login && d.headRepository?.name ? `${d.headRepositoryOwner.login}/${d.headRepository.name}` : null
    const mergeCommit = typeof d.mergeCommit === 'string' ? d.mergeCommit : (d.mergeCommit?.oid ?? null)
    return {
      ok: true, number: d.number, title: d.title, state: String(d.state ?? '').toUpperCase(), body: d.body ?? '',
      url: d.url, headBranch: d.headRefName, baseBranch: d.baseRefName,
      headRefOid: d.headRefOid ?? null, baseRefOid: d.baseRefOid ?? null, headRepo,
      merged: Boolean(d.mergedAt) || String(d.state ?? '').toUpperCase() === 'MERGED',
      mergeCommit,
      author: d.author?.login ?? null, relations: parseBodyRelations(d.body),
    }
  }
  return {
    ok: true, number: d.number, title: d.title, state: d.merged ? 'MERGED' : String(d.state ?? '').toUpperCase(),
    body: d.body ?? '', url: d.html_url, headBranch: d.head?.ref ?? null, baseBranch: d.base?.ref ?? null,
    headRefOid: d.head?.sha ?? null, baseRefOid: d.base?.sha ?? null,
    headRepo: d.head?.repo?.full_name ?? null, merged: Boolean(d.merged),
    mergeCommit: d.merge_commit_sha ?? d.mergeCommit?.oid ?? null,
    author: d.user?.login ?? null,
    relations: parseBodyRelations(d.body),
  }
}

export function normalizeCommentEntries(rawList) {
  return (Array.isArray(rawList) ? rawList : []).map((c) => {
    const body = String(c?.body ?? '')
    const pfStates = parsePfStateTags(body)
    return {
      id: c?.id ?? null, author: c?.user?.login ?? c?.author?.login ?? null, body,
      createdAt: c?.created_at ?? c?.createdAt ?? null, updatedAt: c?.updated_at ?? c?.updatedAt ?? null,
      url: c?.html_url ?? c?.url ?? null, pfState: pfStates.length > 0 ? pfStates[pfStates.length - 1] : null, pfStates,
    }
  })
}
