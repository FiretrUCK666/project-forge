/**
 * flow-context.mjs —— Issue 与 PR 远端上下文拉取、失败原因归一与幂等补齐。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 ../../lib/）。
 */

import { probeGitHubEnv } from '../../lib/platform.mjs'

const NON_API_CLIENT_TIERS = new Set(['none', 'offline', 'half-duplex'])

/** 将远端读取失败归一为可追踪的稳定错误码（`no-api-channel` / `not-found` / `forbidden` 等）。 */
export function normalizeContextFetchReason(res, error = null) {
  if (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/\b404\b|not found|could not resolve/i.test(msg)) return 'not-found'
    if (/\b40[13]\b|forbidden|unauthorized|permission|bad credentials/i.test(msg)) return 'forbidden'
    if (/no-api-channel|offline|not logged into/i.test(msg)) return 'no-api-channel'
    return msg
  }
  if (!res) return 'no-api-channel'
  if (res.delegated) {
    if (NON_API_CLIENT_TIERS.has(res.tier)) return 'no-api-channel'
    return `needs-manual-fetch:${res.action ?? 'fetch'}`
  }
  const status = Number(res.status)
  const errStr = String(res.error ?? res.reason ?? '').trim()
  if (status === 404 || /\b404\b|not found|could not resolve to (?:an issue|a pullrequest)/i.test(errStr)) {
    return 'not-found'
  }
  if (
    status === 401
    || status === 403
    || /\b40[13]\b|forbidden|unauthorized|bad credentials|requires authentication|http 403/i.test(errStr)
  ) {
    return 'forbidden'
  }
  if (/no-api-channel|offline|not logged into/i.test(errStr)) return 'no-api-channel'
  return errStr || 'fetch-failed'
}

function isUsableApiClient(client) {
  if (!client) return false
  if (client.tier && NON_API_CLIENT_TIERS.has(client.tier)) return false
  return true
}

/** 按当前工作区远端与选项解析可读 API 客户端；离线或无凭据时返回可用客户端或 null。 */
export async function resolveReadClient({ mainRoot, remoteUrls, providerId, targetRepo, opts = {} }) {
  if (opts._ghClient) return opts._ghClient
  if (opts._ghProbe) {
    const probeTier = opts._ghProbe.env?.trackB?.tier
    if (probeTier && NON_API_CLIENT_TIERS.has(probeTier)) return null
    return opts._ghProbe.client ?? null
  }
  if (!targetRepo || providerId !== 'github') return null
  try {
    const ghProbe = await probeGitHubEnv({
      cwd: mainRoot,
      remoteUrls,
      probeNetwork: true,
    })
    return ghProbe?.client ?? null
  } catch {
    return null
  }
}

/** 规范化并截断正文摘要，写入账本供无联网交接阅读。 */
export function summarizeContextBody(rawBody, maxLen = 1200) {
  const body = String(rawBody ?? '').replace(/\r\n/g, '\n').trim()
  return body.length > maxLen ? `${body.slice(0, maxLen)}…` : body
}

/** 批量拉取或补全关联 Issue 上下文；已成功拉取过的编号不重复请求。 */
export async function fetchIssueContextList({
  issueNumbers = [],
  existingContext = [],
  client = null,
  targetRepo = null,
} = {}) {
  const nums = [...new Set((issueNumbers ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  const existingMap = new Map()
  for (const item of Array.isArray(existingContext) ? existingContext : []) {
    if (item && Number.isInteger(Number(item.number))) {
      existingMap.set(Number(item.number), item)
    }
  }
  const canCall = Boolean(targetRepo && isUsableApiClient(client) && typeof client.getIssue === 'function')
  const out = []
  for (const num of nums) {
    const prev = existingMap.get(num)
    if (prev?.fetched) {
      out.push(prev)
      continue
    }
    if (!canCall) {
      out.push({ number: num, fetched: false, reason: 'no-api-channel', title: null, summary: null })
      continue
    }
    try {
      const res = await client.getIssue(targetRepo, num)
      if (!res?.ok) {
        out.push({
          number: num,
          fetched: false,
          reason: normalizeContextFetchReason(res),
          title: null,
          summary: null,
        })
        continue
      }
      out.push({
        number: num,
        fetched: true,
        title: res.title ?? null,
        url: res.url ?? null,
        state: res.state ?? null,
        summary: summarizeContextBody(res.body),
      })
    } catch (error) {
      out.push({
        number: num,
        fetched: false,
        reason: normalizeContextFetchReason(null, error),
        title: null,
        summary: null,
      })
    }
  }
  const unavail = out.filter((x) => !x.fetched).map((x) => x.number)
  return { issueContext: out, issueContextUnavailable: unavail }
}

/** 一次补齐或刷新单个任务账本所需的 Issue 与 PR 远端上下文（避免初建与幂等重入两处各写一套）。 */
export async function resolveAndHydrateTaskContexts({
  mainRoot,
  remoteUrls,
  providerId,
  targetRepo = null,
  issueNumbers = [],
  existingIssueContext = [],
  prNumber = null,
  existingPrContext = null,
  existingAck = null,
  opts = {},
}) {
  const hasIssues = Array.isArray(issueNumbers) && issueNumbers.length > 0
  const hasPr = Number.isInteger(Number(prNumber)) && Number(prNumber) > 0
  if (!hasIssues && !hasPr) {
    return {
      issueContext: [],
      issueContextUnavailable: [],
      issueContextAck: null,
      prContext: null,
      prContextUnavailable: null,
      prPatch: {},
    }
  }
  const client = await resolveReadClient({ mainRoot, remoteUrls: remoteUrls ?? {}, providerId, targetRepo, opts })
  const { issueContext, issueContextUnavailable } = hasIssues
    ? await fetchIssueContextList({ issueNumbers, existingContext: existingIssueContext, client, targetRepo })
    : { issueContext: [], issueContextUnavailable: [] }
  const { prContext, prContextUnavailable } = hasPr
    ? await fetchPrContextEntry({ prNumber, existingContext: existingPrContext, client, targetRepo })
    : { prContext: null, prContextUnavailable: null }
  const nextAck = issueContextUnavailable.length === 0 ? null : existingAck
  const prPatch = prContext?.fetched
    ? {
        prUrl: prContext.url ?? null,
        prState: prContext.state ?? null,
        prBaseSha: prContext.baseRefOid ?? null,
        prHeadSha: prContext.headRefOid ?? null,
      }
    : {}
  return { issueContext, issueContextUnavailable, issueContextAck: nextAck, prContext, prContextUnavailable, prPatch }
}

/** 拉取单个 PR 的元信息与基线/头部 commit SHA（`baseRefOid`/`headRefOid`）。 */
export async function fetchPrContextEntry({
  prNumber,
  existingContext = null,
  client = null,
  targetRepo = null,
} = {}) {
  const num = Number(prNumber)
  if (!Number.isInteger(num) || num <= 0) {
    return { prContext: null, prContextUnavailable: null }
  }
  if (
    existingContext?.fetched
    && Number(existingContext.number) === num
    && existingContext.baseRefOid
    && existingContext.headRefOid
  ) {
    return { prContext: existingContext, prContextUnavailable: null }
  }
  const canCall = Boolean(targetRepo && isUsableApiClient(client) && typeof client.getPr === 'function')
  if (!canCall) {
    const unavail = { number: num, fetched: false, reason: 'no-api-channel' }
    return {
      prContext: { ...unavail, title: null, summary: null, baseBranch: null, headBranch: null, baseRefOid: null, headRefOid: null },
      prContextUnavailable: unavail,
    }
  }
  try {
    const res = await client.getPr(targetRepo, num)
    if (!res?.ok) {
      const reason = normalizeContextFetchReason(res)
      const unavail = { number: num, fetched: false, reason }
      return {
        prContext: { ...unavail, title: null, summary: null, baseBranch: null, headBranch: null, baseRefOid: null, headRefOid: null },
        prContextUnavailable: unavail,
      }
    }
    return {
      prContext: {
        number: num,
        fetched: true,
        title: res.title ?? null,
        url: res.url ?? null,
        state: res.state ?? null,
        baseBranch: res.baseBranch ?? null,
        headBranch: res.headBranch ?? null,
        baseRefOid: res.baseRefOid ?? null,
        headRefOid: res.headRefOid ?? null,
        summary: summarizeContextBody(res.body),
      },
      prContextUnavailable: null,
    }
  } catch (error) {
    const reason = normalizeContextFetchReason(null, error)
    const unavail = { number: num, fetched: false, reason }
    return {
      prContext: { ...unavail, title: null, summary: null, baseBranch: null, headBranch: null, baseRefOid: null, headRefOid: null },
      prContextUnavailable: unavail,
    }
  }
}
