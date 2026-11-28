/**
 * platform-providers.mjs —— 5 方言（GitHub/GitLab/GitCode/Gitee/Gitea）REST 与 Multipart 协议适配器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），单源复用 `platform-http.mjs` 安全传输内核：
 * - 明确 5 方言鉴权头（Bearer / PRIVATE-TOKEN / token）；
 * - 429 Retry-After 退避上限复用 `requestWithRetry`；
 * - GitLab/GitCode 保留多级群组编码、支持 `POST /projects/:id/uploads` 二进制安全 multipart、
 *   `refs/merge-requests/<iid>/head` 真 SHA 校验（含离线/浅仓 `rest-fallback` 与 `shaSource` 标注）；
 * - GitCode 写请求自动启用四字节字符守卫；
 * - `findOpenPrForBranch` 强制执行客户端分支二次过滤，防范远端忽略查询参数。
 */

import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { execSafe } from './exec.mjs'
import {
  MAX_RETRY_DELAY_MS,
  computeWriteBackFingerprint,
  normalizeCommentEntries,
  normalizeIssuePayload,
  normalizeMilestonePayload,
  normalizePrPayload,
  normalizeRepoMetaPayload,
  parseBodyRelations,
  parsePfStateTags,
  summarizeCommitChecks,
} from './github-parse.mjs'
import {
  buildMultipartBody,
  platformHttpRequest,
  redactPlatformTokens,
  requestWithRetry,
  sanitizePayloadFourByteChars,
} from './platform-http.mjs'
import { NONE_CAPABILITIES, getHostingProvider } from './platform-registry.mjs'

const HEX_40_RE = /^([0-9a-f]{40})\s+/i

/** 按平台方言构造标准鉴权与协议请求头（令牌绝不拼入 URL 查询串）。 */
export function buildDialectAuthHeaders(providerId, token = null, { authType = 'pat' } = {}) {
  const pid = String(providerId ?? 'github').trim().toLowerCase()
  const cleanToken = typeof token === 'string' && token.trim() ? token.trim() : null
  if (pid === 'github') {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {}),
    }
  }
  if (pid === 'gitlab') {
    return {
      Accept: 'application/json',
      ...(cleanToken ? (authType === 'oauth' ? { Authorization: `Bearer ${cleanToken}` } : { 'PRIVATE-TOKEN': cleanToken }) : {}),
    }
  }
  if (pid === 'gitcode') {
    return { Accept: 'application/json', ...(cleanToken ? { 'PRIVATE-TOKEN': cleanToken } : {}) }
  }
  if (pid === 'gitea') {
    return { Accept: 'application/json', ...(cleanToken ? { Authorization: `token ${cleanToken}` } : {}) }
  }
  return { Accept: 'application/json', ...(cleanToken ? { Authorization: `Bearer ${cleanToken}` } : {}) }
}

/**
 * 校验 GitLab/GitCode MR 真实 HEAD SHA：
 * 优先执行 `git ls-remote <remoteName> refs/merge-requests/<iid>/head`，
 * 离线、无权或浅仓无该引用时安全回退 REST `mr.sha` 并明确标注 `shaSource`。
 */
export async function resolveGitLabMrHeadSha({
  remoteName = 'origin', repoRoot = null, iid, fallbackSha = null, runner = execSafe, timeoutMs = 5000,
} = {}) {
  const num = Number(iid)
  const fallback = typeof fallbackSha === 'string' && fallbackSha.trim() ? fallbackSha.trim() : null
  if (!repoRoot || !Number.isInteger(num) || num <= 0 || typeof runner !== 'function') {
    return { headRefOid: fallback, shaSource: 'rest-fallback' }
  }
  const ref = `refs/merge-requests/${num}/head`
  try {
    const res = await runner('git', ['ls-remote', remoteName || 'origin', ref], { cwd: repoRoot, timeout: timeoutMs })
    if (res && res.code === 0 && !res.missing && !res.timedOut) {
      const m = HEX_40_RE.exec(String(res.stdout ?? '').trim())
      if (m) return { headRefOid: m[1].toLowerCase(), shaSource: 'git-ls-remote' }
    }
  } catch { /* fall through to rest-fallback */ }
  return { headRefOid: fallback, shaSource: 'rest-fallback' }
}

/** 客户端分支二次过滤：拦截忽略 `source_branch`/`head`/`target_branch`/`base` 查询参数的平台接口。 */
export function filterOpenPrsByBranch(prs, { headBranch, base } = {}) {
  const list = Array.isArray(prs) ? prs : []
  const wantHead = String(headBranch ?? '').trim()
  const bareHead = wantHead.includes(':') ? wantHead.split(':').slice(1).join(':') : wantHead
  const wantBase = String(base ?? '').trim()
  return list.filter((item) => {
    if (!item || typeof item !== 'object') return false
    const itemHead = String(item.headBranch ?? item.headRefName ?? '').trim()
    const itemBase = String(item.baseBranch ?? item.baseRefName ?? '').trim()
    if (bareHead && itemHead !== bareHead && itemHead !== wantHead) return false
    if (wantBase && itemBase !== wantBase) return false
    return true
  })
}

const encodeProjectPath = (slug) => encodeURIComponent(String(slug ?? '').trim())

function normalizeGitLabState(state) {
  const s = String(state ?? '').toLowerCase()
  return s === 'opened' || s === 'open' ? 'OPEN' : (s === 'merged' ? 'MERGED' : (s === 'closed' ? 'CLOSED' : s.toUpperCase()))
}

const normLabels = (arr) => (Array.isArray(arr) ? arr : []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)

function normalizeGitLabMilestone(m) {
  return {
    number: m.id ?? m.iid ?? null,
    iid: m.iid ?? null,
    title: m.title ?? '',
    state: String(m.state ?? 'active').toLowerCase() === 'closed' ? 'closed' : 'open',
    description: m.description ?? '',
    dueOn: m.due_date ?? null,
    url: m.web_url ?? null,
  }
}

function normalizeGitLabIssue(d = {}) {
  const body = String(d.description ?? d.body ?? '')
  return {
    number: d.iid ?? d.number ?? null,
    title: d.title ?? '',
    state: normalizeGitLabState(d.state),
    body,
    url: d.web_url ?? d.html_url ?? null,
    labels: normLabels(d.labels),
    milestone: d.milestone ? normalizeGitLabMilestone(d.milestone) : null,
    relations: parseBodyRelations(body),
  }
}

function normalizeGitLabPr(d = {}, shaInfo = null) {
  const body = String(d.description ?? d.body ?? '')
  const state = normalizeGitLabState(d.state)
  const restSha = d.sha ?? d.diff_refs?.head_sha ?? null
  return {
    ok: true,
    number: d.iid ?? d.number ?? null,
    title: d.title ?? '',
    state,
    body,
    url: d.web_url ?? d.html_url ?? null,
    headBranch: d.source_branch ?? null,
    baseBranch: d.target_branch ?? null,
    headRefName: d.source_branch ?? null,
    baseRefName: d.target_branch ?? null,
    headRefOid: shaInfo ? shaInfo.headRefOid : restSha,
    shaSource: shaInfo ? shaInfo.shaSource : 'rest-fallback',
    baseRefOid: d.diff_refs?.base_sha ?? null,
    headRepo: d.source_project_id != null ? String(d.source_project_id) : null,
    merged: state === 'MERGED',
    mergeCommit: d.merge_commit_sha ?? d.squash_commit_sha ?? null,
    author: d.author?.username ?? d.author?.name ?? null,
    labels: normLabels(d.labels),
    relations: parseBodyRelations(body),
  }
}

function normalizeGitLabComments(rawList) {
  return (Array.isArray(rawList) ? rawList : [])
    .filter((c) => !c?.system)
    .map((c) => {
      const body = String(c?.body ?? '')
      const pfStates = parsePfStateTags(body)
      return {
        id: c?.id ?? null,
        author: c?.author?.username ?? c?.user?.login ?? null,
        body,
        createdAt: c?.created_at ?? null,
        updatedAt: c?.updated_at ?? null,
        url: c?.url ?? null,
        pfState: pfStates.length > 0 ? pfStates[pfStates.length - 1] : null,
        pfStates,
      }
    })
}

function normalizeGitLabRepoMeta(d = {}, viewerLogin = null) {
  const level = Math.max(
    Number(d?.permissions?.project_access?.access_level ?? 0),
    Number(d?.permissions?.group_access?.access_level ?? 0),
  )
  const viewerPermission = level >= 50 ? 'ADMIN' : level >= 40 ? 'MAINTAIN' : level >= 30 ? 'WRITE' : level >= 10 ? 'READ' : 'NONE'
  return {
    ok: true,
    isFork: Boolean(d?.forked_from_project),
    parent: d?.forked_from_project?.path_with_namespace?.toLowerCase() ?? null,
    defaultBranch: d?.default_branch ?? null,
    viewerLogin,
    viewerPermission,
  }
}

function mapGitLabStatuses(rawList) {
  return (Array.isArray(rawList) ? rawList : []).map((st) => {
    const raw = String(st?.status ?? '').toLowerCase()
    const state = raw === 'success' ? 'success'
      : (raw === 'pending' || raw === 'running' || raw === 'created' || raw === 'waiting_for_resource' ? 'pending' : 'failure')
    return { context: st?.name ?? st?.context ?? 'ci', state, target_url: st?.target_url ?? null }
  })
}

/** 构造统一 5 方言 REST / Multipart 协议客户端。 */
export function createProviderClient({
  providerId = 'github', apiBaseUrl = null, repoSlug = null, token = null, authType = 'pat',
  remoteName = 'origin', repoRoot = process.cwd(), cliFallback = null, httpRequest = platformHttpRequest,
  runner = execSafe, maxRetries = 2, retryBaseDelayMs = 150, maxRetryDelayMs = MAX_RETRY_DELAY_MS,
  sleep, allowInsecureLan = true, login = null,
} = {}) {
  const pid = String(providerId ?? 'github').trim().toLowerCase()
  const provider = getHostingProvider(pid)
  const capabilities = provider?.capabilities ?? NONE_CAPABILITIES
  const baseUrl = String(apiBaseUrl || provider?.defaultApiBase || '').replace(/\/+$/, '')
  const isGitLabLike = pid === 'gitlab' || pid === 'gitcode'
  const isGitCode = pid === 'gitcode'
  const isGitee = pid === 'gitee'
  const isGitea = pid === 'gitea'
  const seenFingerprints = new Set()
  let cachedLogin = login || null
  const tier = token ? 'provider-api' : (cliFallback?.tier ?? 'none')

  const slugOf = (repo) => String(repo ?? repoSlug ?? '').trim()
  const basePathOf = (slug) => (isGitLabLike ? `/projects/${encodeProjectPath(slug)}` : `/repos/${slug}`)
  const errOf = (res, fallback) => redactPlatformTokens(res?.data?.message ?? res?.data?.error ?? res?.error ?? fallback)

  const apiCall = (method, path, { body, rawBody, contentType, headers = {}, timeoutMs } = {}) => {
    if (!baseUrl) {
      return Promise.resolve({ ok: false, status: 0, error: `missing-api-base-url:${pid}`, data: { message: 'Missing apiBaseUrl' } })
    }
    const upper = String(method).toUpperCase()
    const isWrite = upper === 'POST' || upper === 'PUT' || upper === 'PATCH'
    const safeBody = isGitCode && isWrite && body !== undefined && body !== null ? sanitizePayloadFourByteChars(body) : body
    const fullUrl = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
    return requestWithRetry(
      () => httpRequest({
        method: upper,
        url: fullUrl,
        headers: { ...buildDialectAuthHeaders(pid, token, { authType }), ...headers },
        body: safeBody,
        rawBody,
        contentType,
        timeoutMs,
        allowInsecureLan,
        redirect: 'manual',
      }),
      { maxRetries, retryBaseDelayMs, maxRetryDelayMs, sleep },
    )
  }

  const commentMatchesFp = (c, fp) => {
    const states = Array.isArray(c?.pfStates) && c.pfStates.length > 0 ? c.pfStates : parsePfStateTags(c?.body)
    return states.some((s) => (s?.writeBackFingerprint ?? computeWriteBackFingerprint(c?.body ?? '', s)) === fp)
  }

  const fetchRepoMetaImpl = async (repo) => {
    const slug = slugOf(repo)
    if (!slug) return { ok: false, reason: 'missing-repo' }
    const [res, userRes] = await Promise.all([
      apiCall('GET', basePathOf(slug)),
      !cachedLogin && token ? apiCall('GET', '/user') : Promise.resolve(null),
    ])
    if (userRes?.ok) cachedLogin = userRes.data?.username ?? userRes.data?.login ?? cachedLogin
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'get-repo-failed') }
    return isGitLabLike ? normalizeGitLabRepoMeta(res.data ?? {}, cachedLogin) : normalizeRepoMetaPayload(res.data ?? {}, cachedLogin)
  }

  const fetchIssueImpl = async (repo, number) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
    const res = await apiCall('GET', `${basePathOf(slug)}/issues/${num}`)
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'get-issue-failed') }
    return { ok: true, ...(isGitLabLike ? normalizeGitLabIssue(res.data ?? {}) : normalizeIssuePayload(res.data ?? {}, true)) }
  }

  const listIssuesImpl = async ({ repo, state = 'open', perPage = 30 } = {}) => {
    const slug = slugOf(repo)
    if (!slug) return { ok: false, issues: [], error: 'missing-repo' }
    const qState = isGitLabLike && state === 'open' ? 'opened' : state
    const res = await apiCall('GET', `${basePathOf(slug)}/issues?state=${encodeURIComponent(qState)}&per_page=${perPage}`)
    if (!res.ok) return { ok: false, issues: [], status: res.status, error: errOf(res, 'list-issues-failed') }
    const raw = Array.isArray(res.data) ? res.data : []
    return {
      ok: true,
      issues: isGitLabLike ? raw.map(normalizeGitLabIssue) : raw.filter((d) => !d.pull_request).map((d) => normalizeIssuePayload(d, true)),
    }
  }

  const createIssueImpl = async ({ repo, title, body = '', labels = [], milestone = null } = {}) => {
    const slug = slugOf(repo)
    const cleanTitle = String(title ?? '').trim()
    if (!slug || !cleanTitle) return { ok: false, error: 'missing-repo-or-title' }
    const normBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
    const cleanLabels = Array.isArray(labels) ? labels.filter(Boolean).map(String) : []
    const msNum = Number(milestone)
    const payload = isGitLabLike
      ? { title: cleanTitle, description: normBody, ...(cleanLabels.length ? { labels: cleanLabels.join(',') } : {}), ...(Number.isInteger(msNum) && msNum > 0 ? { milestone_id: msNum } : {}) }
      : { title: cleanTitle, body: normBody, ...(cleanLabels.length ? { labels: isGitee ? cleanLabels.join(',') : cleanLabels } : {}), ...(Number.isInteger(msNum) && msNum > 0 ? { milestone: msNum } : {}) }
    const res = await apiCall('POST', `${basePathOf(slug)}/issues`, { body: payload })
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'create-issue-failed') }
    return { ok: true, ...(isGitLabLike ? normalizeGitLabIssue(res.data ?? {}) : normalizeIssuePayload(res.data ?? {}, true)) }
  }

  const updateIssueBodyImpl = async (arg1, maybeNumber, maybeBody) => {
    const cfg = (arg1 && typeof arg1 === 'object')
      ? { repo: slugOf(arg1.repo), number: arg1.number ?? arg1.issue, body: arg1.body }
      : { repo: slugOf(arg1), number: maybeNumber, body: maybeBody }
    const num = Number(cfg.number)
    if (!cfg.repo || !Number.isInteger(num) || num <= 0 || cfg.body == null) return { ok: false, error: 'missing-repo-number-or-body' }
    const normBody = String(cfg.body).replace(/\r\n/g, '\n')
    const res = isGitLabLike
      ? await apiCall('PUT', `${basePathOf(cfg.repo)}/issues/${num}`, { body: { description: normBody } })
      : await apiCall('PATCH', `${basePathOf(cfg.repo)}/issues/${num}`, { body: { body: normBody } })
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'update-issue-body-failed') }
    return { ok: true, number: res.data?.iid ?? res.data?.number ?? num, body: res.data?.description ?? res.data?.body ?? normBody }
  }

  const closeIssueImpl = async ({ repo, number } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
    const cur = await fetchIssueImpl(slug, num)
    if (cur.ok && cur.state === 'CLOSED') return { ok: true, number: num, state: 'CLOSED', alreadyClosed: true }
    const res = isGitLabLike
      ? await apiCall('PUT', `${basePathOf(slug)}/issues/${num}`, { body: { state_event: 'close' } })
      : await apiCall('PATCH', `${basePathOf(slug)}/issues/${num}`, { body: { state: 'closed' } })
    return res.ok ? { ok: true, number: num, state: 'CLOSED', alreadyClosed: false } : { ok: false, status: res.status, error: errOf(res, 'close-issue-failed') }
  }

  const fetchPrImpl = async (repo, number) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
    const path = isGitLabLike ? `${basePathOf(slug)}/merge_requests/${num}` : `${basePathOf(slug)}/pulls/${num}`
    const res = await apiCall('GET', path)
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'get-pr-failed') }
    if (isGitLabLike) {
      const restSha = res.data?.sha ?? res.data?.diff_refs?.head_sha ?? null
      const shaInfo = await resolveGitLabMrHeadSha({ remoteName, repoRoot, iid: num, fallbackSha: restSha, runner })
      return normalizeGitLabPr(res.data ?? {}, shaInfo)
    }
    return { ...normalizePrPayload(res.data ?? {}, true), shaSource: 'rest' }
  }

  const mapPrSummary = (item) => (isGitLabLike
    ? {
        number: item.iid ?? item.number, title: item.title, headBranch: item.source_branch,
        headRefName: item.source_branch, baseBranch: item.target_branch, baseRefName: item.target_branch,
        url: item.web_url, state: normalizeGitLabState(item.state),
      }
    : {
        number: item.number, title: item.title, headBranch: item.head?.ref ?? null,
        headRefName: item.head?.ref ?? null, baseBranch: item.base?.ref ?? null,
        baseRefName: item.base?.ref ?? null, url: item.html_url, state: String(item.state ?? 'open').toUpperCase(),
      })

  const findOpenPrImpl = async (repo, headBranch, { headOwner, base } = {}) => {
    const slug = slugOf(repo)
    if (!slug || !headBranch) return { ok: false, prs: [] }
    let path
    if (isGitLabLike) {
      const qs = new URLSearchParams({ state: 'opened', source_branch: headBranch })
      if (base) qs.set('target_branch', base)
      path = `${basePathOf(slug)}/merge_requests?${qs.toString()}`
    } else {
      const owner = headOwner || slug.split('/')[0]
      const headParam = headBranch.includes(':') ? headBranch : (isGitea ? headBranch : `${owner}:${headBranch}`)
      const qs = new URLSearchParams({ state: 'open' })
      if (!isGitea) qs.set('head', headParam)
      if (base) qs.set('base', base)
      path = `${basePathOf(slug)}/pulls?${qs.toString()}`
    }
    const res = await apiCall('GET', path)
    if (!res.ok) return { ok: false, prs: [], status: res.status, error: errOf(res, 'find-pr-failed') }
    const mapped = (Array.isArray(res.data) ? res.data : []).map(mapPrSummary)
    return { ok: true, prs: filterOpenPrsByBranch(mapped, { headBranch, base }) }
  }

  const listOpenPrsByBaseImpl = async (repo, baseBranch) => {
    const slug = slugOf(repo)
    if (!slug || !baseBranch) return { ok: true, prs: [], skipped: true }
    const path = isGitLabLike
      ? `${basePathOf(slug)}/merge_requests?state=opened&target_branch=${encodeURIComponent(baseBranch)}`
      : `${basePathOf(slug)}/pulls?state=open&base=${encodeURIComponent(baseBranch)}`
    const res = await apiCall('GET', path)
    if (!res.ok) return { ok: false, prs: [], error: errOf(res, 'list-prs-failed') }
    const mapped = (Array.isArray(res.data) ? res.data : []).map(mapPrSummary)
    return { ok: true, prs: filterOpenPrsByBranch(mapped, { base: baseBranch }) }
  }

  const createPrImpl = async ({ targetRepo, repo, head, base, title, body = '', draft = false } = {}) => {
    const slug = slugOf(targetRepo ?? repo)
    if (!slug || !head || !base) return { ok: false, error: 'missing-pr-params' }
    const normBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
    const res = isGitLabLike
      ? await apiCall('POST', `${basePathOf(slug)}/merge_requests`, {
          body: { source_branch: head, target_branch: base, title: draft ? `Draft: ${title}` : title, description: normBody },
        })
      : await apiCall('POST', `${basePathOf(slug)}/pulls`, { body: { title, body: normBody, head, base, ...(isGitee ? {} : { draft }) } })
    if (!res.ok) {
      if (res.status !== 401 && res.status !== 403) {
        const existing = await findOpenPrImpl(slug, head, { base })
        if (existing?.ok && existing.prs.length > 0) {
          return { ok: true, number: existing.prs[0].number, url: existing.prs[0].url, reusedConcurrentPr: true }
        }
      }
      return { ok: false, status: res.status, error: errOf(res, 'create-pr-failed') }
    }
    return { ok: true, number: res.data?.iid ?? res.data?.number ?? null, url: res.data?.web_url ?? res.data?.html_url ?? null }
  }

  const updatePrBaseImpl = async ({ repo, number, base } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !base || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-number-or-base' }
    const res = isGitLabLike
      ? await apiCall('PUT', `${basePathOf(slug)}/merge_requests/${num}`, { body: { target_branch: base } })
      : await apiCall('PATCH', `${basePathOf(slug)}/pulls/${num}`, { body: { base } })
    return res.ok ? { ok: true, number: num, base } : { ok: false, status: res.status, error: errOf(res, 'update-pr-base-failed') }
  }

  const mergePrImpl = async ({ repo, number, method = 'merge', sha } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
    const res = isGitLabLike
      ? await apiCall('PUT', `${basePathOf(slug)}/merge_requests/${num}/merge`, { body: { ...(sha ? { sha } : {}), squash: method === 'squash' } })
      : isGitea
        ? await apiCall('POST', `${basePathOf(slug)}/pulls/${num}/merge`, { body: { Do: method, ...(sha ? { head_commit_id: sha } : {}) } })
        : await apiCall('PUT', `${basePathOf(slug)}/pulls/${num}/merge`, { body: { merge_method: method, ...(sha ? { sha } : {}) } })
    const readback = await fetchPrImpl(slug, num)
    const mergeCommit = res?.data?.merge_commit_sha ?? res?.data?.sha ?? readback?.mergeCommit ?? null
    if (!res.ok) {
      if (readback?.ok && readback.merged === true) {
        return { ok: true, merged: true, alreadyMerged: true, state: 'MERGED', ...(mergeCommit ? { mergeCommit, sha: mergeCommit } : {}) }
      }
      return { ok: false, status: Number(res.status ?? 0), headMismatch: res.status === 409, mergeBlocked: res.status === 405, error: errOf(res, 'merge-failed') }
    }
    return { ok: readback.ok ? readback.merged === true : true, merged: readback.ok ? Boolean(readback.merged) : true, state: readback.state ?? 'MERGED', ...(mergeCommit ? { mergeCommit, sha: mergeCommit } : {}) }
  }

  const listCommentsImpl = async (arg, maybeNumber) => {
    const cfg = (typeof arg === 'object' && arg !== null) ? arg : { repo: arg, number: maybeNumber }
    const slug = slugOf(cfg.repo)
    const num = Number(cfg.number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, comments: [], error: 'missing-repo-or-number' }
    const path = isGitLabLike
      ? `${basePathOf(slug)}/${cfg.isPr ? 'merge_requests' : 'issues'}/${num}/notes?per_page=${cfg.perPage ?? 100}`
      : `${basePathOf(slug)}/issues/${num}/comments?per_page=${cfg.perPage ?? 100}`
    const res = await apiCall('GET', path)
    if (!res.ok) return { ok: false, comments: [], status: res.status, error: errOf(res, 'list-comments-failed') }
    return { ok: true, comments: isGitLabLike ? normalizeGitLabComments(res.data) : normalizeCommentEntries(res.data) }
  }

  const postCommentImpl = async ({ repo, number, body, isPr = false, statePayload = {}, deduplicate = true, existingComments = null } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
    const normBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
    const hasState = statePayload && typeof statePayload === 'object' && Object.keys(statePayload).length > 0
    const fp = hasState ? computeWriteBackFingerprint(normBody, statePayload) : null
    const finalState = hasState ? { ...statePayload, writeBackFingerprint: statePayload.writeBackFingerprint ?? fp } : {}
    const fullBody = hasState ? `${normBody}\n\n<!-- pf-state:${JSON.stringify(finalState)} -->` : normBody
    if (deduplicate && fp) {
      const cacheKey = `${pid}:${slug}:${isPr ? 'pr' : 'issue'}#${num}#${fp}`
      if (seenFingerprints.has(cacheKey)) return { ok: true, deduplicated: true, skipped: true, writeBackFingerprint: fp }
      const candidate = Array.isArray(existingComments) ? { ok: true, comments: existingComments } : await listCommentsImpl({ repo: slug, number: num, isPr })
      const hit = candidate?.ok ? candidate.comments.find((c) => commentMatchesFp(c, fp)) : null
      if (hit) {
        seenFingerprints.add(cacheKey)
        return { ok: true, deduplicated: true, skipped: true, writeBackFingerprint: fp, id: hit.id ?? null, url: hit.url ?? null }
      }
    }
    const path = isGitLabLike ? `${basePathOf(slug)}/${isPr ? 'merge_requests' : 'issues'}/${num}/notes` : `${basePathOf(slug)}/issues/${num}/comments`
    const res = await apiCall('POST', path, { body: { body: fullBody } })
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'post-comment-failed') }
    if (fp) seenFingerprints.add(`${pid}:${slug}:${isPr ? 'pr' : 'issue'}#${num}#${fp}`)
    return {
      ok: true,
      id: res.data?.id ?? null,
      url: res.data?.html_url ?? res.data?.url ?? null,
      verifiedReadback: String(res.data?.body ?? '').replace(/\r\n/g, '\n').trim() === fullBody,
      ...(fp ? { writeBackFingerprint: fp } : {}),
    }
  }

  const listLabelsImpl = async ({ repo } = {}) => {
    const slug = slugOf(repo)
    if (!slug) return { ok: false, labels: [] }
    const res = await apiCall('GET', `${basePathOf(slug)}/labels?per_page=100`)
    return res.ok ? { ok: true, labels: normLabels(res.data) } : { ok: false, labels: [], status: res.status }
  }

  const addLabelsImpl = async ({ repo, number, labels = [], isPr = false } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    const list = (Array.isArray(labels) ? labels : [labels]).map((l) => String(l ?? '').trim()).filter(Boolean)
    if (!slug || !Number.isInteger(num) || num <= 0 || list.length === 0) return { ok: true, skipped: true, labels: [] }
    const itemPath = isGitLabLike ? `${basePathOf(slug)}/${isPr ? 'merge_requests' : 'issues'}/${num}` : null
    let res = isGitLabLike
      ? await apiCall('PUT', itemPath, { body: { add_labels: list.join(',') } })
      : await apiCall('POST', `${basePathOf(slug)}/issues/${num}/labels`, { body: isGitee ? list : { labels: list } })
    if (isGitLabLike && !res.ok && res.status === 400) {
      const cur = await apiCall('GET', itemPath)
      if (cur.ok) {
        const merged = [...new Set([...normLabels(cur.data?.labels), ...list])]
        res = await apiCall('PUT', itemPath, { body: { labels: merged.join(',') } })
      }
    }
    return res.ok ? { ok: true, number: num, labels: normLabels(res.data?.labels ?? list), verifiedReadback: true } : { ok: false, status: res.status, error: errOf(res, 'add-labels-failed') }
  }

  const removeLabelImpl = async ({ repo, number, label, isPr = false } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    const clean = String(label ?? '').trim()
    if (!slug || !Number.isInteger(num) || num <= 0 || !clean) return { ok: true, skipped: true }
    const itemPath = isGitLabLike ? `${basePathOf(slug)}/${isPr ? 'merge_requests' : 'issues'}/${num}` : null
    let res = isGitLabLike
      ? await apiCall('PUT', itemPath, { body: { remove_labels: clean } })
      : await apiCall('DELETE', `${basePathOf(slug)}/issues/${num}/labels/${encodeURIComponent(clean)}`)
    if (isGitLabLike && !res.ok && res.status === 400) {
      const cur = await apiCall('GET', itemPath)
      if (cur.ok) {
        const cleanLow = clean.toLowerCase()
        const nextLabels = normLabels(cur.data?.labels).filter((l) => l.toLowerCase() !== cleanLow)
        res = await apiCall('PUT', itemPath, { body: { labels: nextLabels.join(',') } })
      }
    }
    if (res.status === 404) return { ok: true, skipped: true, reason: 'label-absent' }
    return res.ok ? { ok: true } : { ok: false, status: res.status, error: errOf(res, 'remove-label-failed') }
  }

  const closePrImpl = async ({ repo, number, comment = '', labels = [], dryRun = false, statePayload = {} } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
    if (dryRun) return { ok: true, dryRun: true, repo: slug, number: num, state: 'OPEN', planned: { comment: Boolean(comment), labels, close: true } }
    const commentResult = comment ? await postCommentImpl({ repo: slug, number: num, body: comment, isPr: true, statePayload }) : null
    const labelResult = labels.length > 0 ? await addLabelsImpl({ repo: slug, number: num, labels, isPr: true }) : null
    const res = isGitLabLike
      ? await apiCall('PUT', `${basePathOf(slug)}/merge_requests/${num}`, { body: { state_event: 'close' } })
      : await apiCall('PATCH', `${basePathOf(slug)}/pulls/${num}`, { body: { state: 'closed' } })
    const extra = { ...(commentResult ? { commentResult } : {}), ...(labelResult ? { labelResult } : {}) }
    return res.ok ? { ok: true, number: num, state: 'CLOSED', ...extra } : { ok: false, status: res.status, error: errOf(res, 'close-pr-failed'), ...extra }
  }

  const getCommitChecksImpl = async ({ repo, ref } = {}) => {
    const slug = slugOf(repo)
    const cleanRef = String(ref ?? '').trim()
    if (!capabilities.checks) {
      return { ok: true, bucket: 'none', total: 0, passed: [], pending: [], failed: [], warnings: [], skipped: true, reason: 'checks-unsupported' }
    }
    if (!slug || !cleanRef) {
      return { ok: false, bucket: 'unknown', total: 0, passed: [], pending: [], failed: [], warnings: ['missing-repo-or-ref'], error: 'missing-repo-or-ref' }
    }
    const encRef = encodeURIComponent(cleanRef)
    if (isGitLabLike || isGitea) {
      const path = isGitLabLike ? `${basePathOf(slug)}/repository/commits/${encRef}/statuses` : `${basePathOf(slug)}/commits/${encRef}/status`
      const res = await apiCall('GET', path)
      if (!res.ok) return { ok: false, bucket: 'unknown', total: 0, passed: [], pending: [], failed: [], warnings: [errOf(res, 'checks-failed')], status: res.status }
      return summarizeCommitChecks([], isGitLabLike ? mapGitLabStatuses(res.data) : (res.data?.statuses ?? []))
    }
    const [crRes, stRes] = await Promise.all([
      apiCall('GET', `${basePathOf(slug)}/commits/${encRef}/check-runs?per_page=100`),
      apiCall('GET', `${basePathOf(slug)}/commits/${encRef}/status`),
    ])
    const warnings = []
    if (!crRes.ok) warnings.push(`check-runs-unavailable: ${errOf(crRes, crRes.status)}`)
    if (!stRes.ok) warnings.push(`status-unavailable: ${errOf(stRes, stRes.status)}`)
    const summary = summarizeCommitChecks(crRes.ok ? crRes.data : null, stRes.ok ? stRes.data : null, { warnings })
    const ok = crRes.ok || summary.failed.length > 0
    return { ...summary, ok, ...(!ok ? { status: crRes.status || stRes.status || 0, error: warnings.join('; ') } : {}) }
  }

  const listMilestonesImpl = async ({ repo, state = 'open' } = {}) => {
    const slug = slugOf(repo)
    if (!slug) return { ok: false, milestones: [] }
    const qState = isGitLabLike && state === 'open' ? 'active' : state
    const res = await apiCall('GET', `${basePathOf(slug)}/milestones?state=${encodeURIComponent(qState)}&per_page=100`)
    if (!res.ok) return { ok: false, milestones: [], status: res.status, error: errOf(res, 'list-milestones-failed') }
    const raw = Array.isArray(res.data) ? res.data : []
    return { ok: true, milestones: raw.map(isGitLabLike ? normalizeGitLabMilestone : normalizeMilestonePayload) }
  }

  const createMilestoneImpl = async ({ repo, title, description = '', dueOn = null } = {}) => {
    const slug = slugOf(repo)
    const cleanTitle = String(title ?? '').trim()
    if (!slug || !cleanTitle) return { ok: false, error: 'missing-repo-or-title' }
    const dueKey = isGitLabLike ? 'due_date' : 'due_on'
    const payload = { title: cleanTitle, ...(description ? { description } : {}), ...(dueOn ? { [dueKey]: dueOn } : {}) }
    const res = await apiCall('POST', `${basePathOf(slug)}/milestones`, { body: payload })
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'create-milestone-failed') }
    return {
      ok: true,
      number: isGitLabLike ? (res.data?.id ?? res.data?.iid ?? res.data?.number ?? null) : (res.data?.number ?? res.data?.id ?? null),
      ...(isGitLabLike && res.data?.iid != null ? { iid: res.data.iid } : {}),
      title: res.data?.title ?? cleanTitle,
      url: res.data?.web_url ?? res.data?.html_url ?? null,
    }
  }

  const closeMilestoneImpl = async ({ repo, number } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    if (!slug || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
    const res = isGitLabLike
      ? await apiCall('PUT', `${basePathOf(slug)}/milestones/${num}`, { body: { state_event: 'close' } })
      : await apiCall('PATCH', `${basePathOf(slug)}/milestones/${num}`, { body: { state: 'closed' } })
    return res.ok ? { ok: true, number: num, state: 'closed' } : { ok: false, status: res.status, error: errOf(res, 'close-milestone-failed') }
  }

  const assignMilestoneImpl = async ({ repo, number, milestone, isPr = false } = {}) => {
    const slug = slugOf(repo)
    const num = Number(number)
    const msNum = Number(milestone?.number ?? milestone)
    if (!slug || !Number.isInteger(num) || num <= 0 || !Number.isInteger(msNum) || msNum <= 0) {
      return { ok: false, error: 'missing-repo-number-or-milestone' }
    }
    const res = isGitLabLike
      ? await apiCall('PUT', `${basePathOf(slug)}/${isPr ? 'merge_requests' : 'issues'}/${num}`, { body: { milestone_id: msNum } })
      : await apiCall('PATCH', `${basePathOf(slug)}/issues/${num}`, { body: { milestone: msNum } })
    return res.ok ? { ok: true, number: num, milestone: msNum } : { ok: false, status: res.status, error: errOf(res, 'assign-milestone-failed') }
  }

  const uploadAttachmentImpl = async ({ repo, filePath, filename, buffer, contentType = 'application/octet-stream' } = {}) => {
    if (!capabilities.uploadAttachment) {
      return { ok: false, unsupported: true, reason: 'upload-attachment-unsupported', providerId: pid }
    }
    const slug = slugOf(repo)
    if (!slug) return { ok: false, error: 'missing-repo' }
    let fileBuf
    if (buffer != null) fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    else if (filePath) {
      try { fileBuf = readFileSync(filePath) } catch (err) { return { ok: false, error: err?.message ?? 'read-file-failed' } }
    } else return { ok: false, error: 'missing-buffer-or-filepath' }

    const mp = buildMultipartBody({
      fieldName: 'file',
      filename: filename || (filePath ? basename(filePath) : 'attachment.bin'),
      contentType,
      buffer: fileBuf,
    })
    const res = await apiCall('POST', `${basePathOf(slug)}/uploads`, { rawBody: mp.body, contentType: mp.contentType })
    if (!res.ok) return { ok: false, status: res.status, error: errOf(res, 'upload-attachment-failed') }
    const d = res.data ?? {}
    return {
      ok: true,
      url: d.url ?? null,
      fullUrl: d.full_path ?? d.url ?? null,
      markdown: d.markdown ?? (d.url ? `![${d.alt ?? mp.filename}](${d.url})` : null),
      alt: d.alt ?? mp.filename,
      filename: mp.filename,
    }
  }

  return {
    providerId: pid,
    tier,
    apiBaseUrl: baseUrl,
    capabilities,
    getRepoMeta: fetchRepoMetaImpl,
    getIssue: fetchIssueImpl,
    listIssues: listIssuesImpl,
    createIssue: createIssueImpl,
    updateIssueBody: updateIssueBodyImpl,
    closeIssue: closeIssueImpl,
    getPr: fetchPrImpl,
    findOpenPrForBranch: findOpenPrImpl,
    listOpenPrsByHead: findOpenPrImpl,
    listOpenPrsByBase: listOpenPrsByBaseImpl,
    createPr: createPrImpl,
    updatePrBase: updatePrBaseImpl,
    mergePr: mergePrImpl,
    closePr: closePrImpl,
    listComments: listCommentsImpl,
    postComment: postCommentImpl,
    listLabels: listLabelsImpl,
    addLabels: addLabelsImpl,
    removeLabel: removeLabelImpl,
    getCommitChecks: getCommitChecksImpl,
    listMilestones: listMilestonesImpl,
    createMilestone: createMilestoneImpl,
    closeMilestone: closeMilestoneImpl,
    assignMilestone: assignMilestoneImpl,
    uploadAttachment: uploadAttachmentImpl,
    batchFetchIssues: (repo, numbers = []) => Promise.all((numbers ?? []).map((n) => fetchIssueImpl(repo, n))),
    batchFetchPrs: (repo, numbers = []) => Promise.all((numbers ?? []).map((n) => fetchPrImpl(repo, n))),
  }
}
