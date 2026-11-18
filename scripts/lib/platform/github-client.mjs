/**
 * github-client.mjs —— GitHub 双通道客户端（`gh` CLI 与原生 `node:https`）及安全子进程封装。
 *
 * 全程禁交互，零第三方依赖，且令牌仅通过 `TOKEN_VAULT`（WeakMap）保存在内存中。
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildNonInteractiveEnv } from '../../../kit/skills/lib/exec.mjs'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  TOKEN_VAULT,
  buildOneClickPrUrl,
  defaultCommandRunner as defaultRunCommand,
  defaultHttpsRequest,
  detectRemoteProtocol,
  normalizeGitHubRepo,
} from '../../../kit/skills/lib/platform-probe.mjs'

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  TOKEN_VAULT,
  buildNonInteractiveEnv,
  buildOneClickPrUrl,
  defaultHttpsRequest,
  defaultRunCommand,
  detectRemoteProtocol,
  normalizeGitHubRepo,
}

function makeHttpError(status, message, data) {
  const err = new Error(message || `GitHub API 错误（HTTP ${status}）`)
  err.status = status
  if (data !== undefined) err.data = data
  return err
}

function isPermissionError(err) {
  if (!err) return false
  if (err.status === 403 || err.status === 401) return true
  const msg = String(err.message ?? '')
  return /403|forbidden|resource not accessible|must have (?:triage|write|admin) access|permission|upgrade to github pro/i.test(msg)
}

const NON_RETRYABLE_HTTP_STATUS = new Set([400, 401, 403, 404, 405, 409, 413, 422])
const RETRYABLE_NET_CODES = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ESOCKETTIMEDOUT',
  'ECONNABORTED',
])

function defaultSleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function isRetryableRestError(err) {
  if (!err) return false
  const status = Number(err.status ?? 0)
  if (status >= 300 && status < 400) return false
  if (status === 429 || (status >= 500 && status < 600)) return true
  if (NON_RETRYABLE_HTTP_STATUS.has(status) || (status >= 400 && status < 500)) return false
  const code = String(err.code ?? '')
  if (RETRYABLE_NET_CODES.has(code) || /^ERR_TLS_/i.test(code)) return true
  if (err.name === 'TimeoutError' || err.name === 'AbortError' || err.timedOut === true) return true
  const msg = String(err.message ?? '')
  return status === 0 && /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ERR_TLS_|TLS|timed?\s*out|socket hang up|429 Too Many Requests|502 Bad Gateway|503 Service Unavailable|504 Gateway/i.test(msg)
}

function extractGhHttpStatus(stderr, parsed) {
  const raw = Number(parsed?.status)
  if (Number.isFinite(raw) && raw >= 100 && raw <= 599) return raw
  const text = String(stderr ?? '')
  const m = text.match(/(?:HTTP|status(?:\s+code)?)\s*[:=]?\s*(\d{3})\b/i)
  if (m) {
    const code = Number(m[1])
    if (code >= 100 && code <= 599) return code
  }
  if (/403 Forbidden/i.test(text)) return 403
  if (/404 Not Found/i.test(text)) return 404
  if (/429 Too Many Requests/i.test(text)) return 429
  if (/502 Bad Gateway/i.test(text)) return 502
  if (/503 Service Unavailable/i.test(text)) return 503
  if (/504 Gateway/i.test(text)) return 504
  return 0
}

/**
 * 构造仅开启「开关 A」（禁直推/强推/删分支 + 要求 PR 与 Checks）的分支保护载荷。
 *
 * 严格禁止设置 `required_approving_review_count >= 1`，避免单人仓与自动化合流死锁。
 */
export function buildSwitchABranchProtectionPayload({
  requiredChecks = [],
  strictStatusChecks = true,
  enforceAdmins = true,
  requiredApprovingReviewCount = 0,
} = {}) {
  const reviewCount = Number(requiredApprovingReviewCount ?? 0)
  if (!Number.isFinite(reviewCount) || reviewCount < 0 || reviewCount >= 1) {
    throw new Error('开关 A 分支保护禁止设置 required_approving_review_count >= 1（仅阻断直推/强推/删分支并接入 PR 与 Checks）')
  }
  const contexts = Array.isArray(requiredChecks)
    ? [...new Set(requiredChecks.map((item) => String(item ?? '').trim()).filter(Boolean))]
    : []
  return {
    required_status_checks: {
      strict: Boolean(strictStatusChecks),
      contexts,
    },
    enforce_admins: Boolean(enforceAdmins),
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: false,
    lock_branch: false,
    allow_fork_syncing: false,
  }
}

function withTempUtf8File(content, fn) {
  const file = join(
    tmpdir(),
    `pf-gh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  )
  writeFileSync(file, String(content ?? ''), 'utf8')
  return Promise.resolve()
    .then(() => fn(file))
    .finally(() => {
      try { unlinkSync(file) } catch {}
    })
}

/**
 * 创建原生 GitHub REST/GraphQL 双通道客户端（`gh` CLI 与 `node:https`）。
 */
export function createGitHubClient({
  cwd = process.cwd(),
  probeResult,
  channel,
  env = process.env,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  maxRetries = 2,
  retryBaseDelayMs = 80,
  sleep = defaultSleep,
  runner = defaultRunCommand,
  httpRequest = defaultHttpsRequest,
} = {}) {
  const safeEnv = buildNonInteractiveEnv(env)
  const vaultToken = probeResult && TOKEN_VAULT.has(probeResult)
    ? TOKEN_VAULT.get(probeResult)
    : undefined
  const envToken = (typeof safeEnv?.GH_TOKEN === 'string' && safeEnv.GH_TOKEN.trim())
    || (typeof safeEnv?.GITHUB_TOKEN === 'string' && safeEnv.GITHUB_TOKEN.trim())
    || undefined
  const token = vaultToken || envToken

  let resolvedChannel = channel
  if (!resolvedChannel) {
    const tier = probeResult?.apiChannel?.tier
    if (tier === 'gh-cli') resolvedChannel = 'gh-cli'
    else if (tier === 'node-https-token' || token) resolvedChannel = 'node-https-token'
    else if (tier === 'mcp-delegate' || tier === 'half-duplex' || tier === 'offline' || tier === 'none') resolvedChannel = 'none'
    else resolvedChannel = token ? 'node-https-token' : 'gh-cli'
  }

  async function restOnce(method, path, { query, body, headers = {} } = {}) {
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    const urlObj = new URL(`https://api.github.com${cleanPath}`)
    if (query && typeof query === 'object') {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null) urlObj.searchParams.set(k, String(v))
      }
    }

    if (resolvedChannel === 'none') {
      throw makeHttpError(0, '当前无本地 GitHub API 通道（请使用宿主 MCP 代理或配置凭据）')
    }

    if (resolvedChannel === 'gh-cli') {
      const apiPath = `${urlObj.pathname}${urlObj.search}`
      const execWithInput = async (inputFile) => {
        const args = ['api', apiPath, '--method', method.toUpperCase()]
        for (const [k, v] of Object.entries(headers)) {
          args.push('-H', `${k}: ${v}`)
        }
        if (inputFile) args.push('--input', inputFile)
        const res = await runner('gh', args, { cwd, env: safeEnv, timeoutMs: Math.max(timeoutMs, 10000) })
        if (res.code !== 0) {
          let parsed
          try { parsed = res.stdout ? JSON.parse(res.stdout) : undefined } catch {}
          const status = extractGhHttpStatus(res.stderr, parsed)
          throw makeHttpError(status, res.stderr.trim() || parsed?.message || 'gh api 调用失败', parsed)
        }
        if (!res.stdout.trim()) return undefined
        try { return JSON.parse(res.stdout) } catch { return res.stdout }
      }
      if (body !== undefined && body !== null) {
        return withTempUtf8File(JSON.stringify(body), (file) => execWithInput(file))
      }
      return execWithInput(undefined)
    }

    if (!token) {
      throw makeHttpError(401, '未找到有效的 GitHub API 令牌')
    }
    const resp = await httpRequest({
      method: method.toUpperCase(),
      url: urlObj.toString(),
      headers: {
        Authorization: `Bearer ${token}`,
        ...headers,
      },
      body,
      timeoutMs: Math.max(timeoutMs, 10000),
      redirect: 'manual',
    })
    if (resp.status >= 300 && resp.status < 400) {
      throw makeHttpError(resp.status, `GitHub API 返回重定向 HTTP ${resp.status}（禁止自动跟随携带凭据）`, resp.data)
    }
    if (resp.status >= 400) {
      throw makeHttpError(resp.status, resp.data?.message || `GitHub API 返回 HTTP ${resp.status}`, resp.data)
    }
    return resp.data !== undefined ? resp.data : resp.text
  }

  async function rest(method, path, opts = {}) {
    const retries = Math.max(0, Number(maxRetries ?? 2))
    let lastError
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await restOnce(method, path, opts)
      } catch (err) {
        lastError = err
        if (attempt >= retries || !isRetryableRestError(err)) throw err
        const delayMs = Math.max(0, Number(retryBaseDelayMs ?? 80)) * (2 ** attempt)
        if (delayMs > 0) await sleep(delayMs)
      }
    }
    throw lastError
  }

  async function graphql(query, variables = {}) {
    const payload = { query, variables }
    if (resolvedChannel === 'none') {
      throw makeHttpError(0, '当前无本地 GitHub GraphQL 通道')
    }
    const data = await rest('POST', '/graphql', { body: payload })
    if (Array.isArray(data?.errors) && data.errors.length > 0) {
      const msg = data.errors.map((e) => e.message).join('; ')
      const isForbidden = data.errors.some((e) => e.type === 'FORBIDDEN' || /forbidden|permission/i.test(e.message ?? ''))
      throw makeHttpError(isForbidden ? 403 : 422, msg, data)
    }
    return data?.data
  }

  async function getAuthenticatedLogin() {
    if (probeResult?.apiChannel?.login) return probeResult.apiChannel.login
    try {
      const user = await rest('GET', '/user')
      return user?.login
    } catch {
      return undefined
    }
  }

  async function getRepoPermissions(repo) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const [owner, name] = norm.split('/')
    let viewerPermission
    let login = probeResult?.apiChannel?.login
    try {
      const gql = await graphql(
        `query($owner: String!, $name: String!) {
          viewer { login }
          repository(owner: $owner, name: $name) {
            viewerPermission
            isFork
            parent { nameWithOwner }
            defaultBranchRef { name }
            isPrivate
            owner { login }
          }
        }`,
        { owner, name },
      )
      const repoNode = gql?.repository
      if (repoNode) {
        viewerPermission = repoNode.viewerPermission
        login = gql?.viewer?.login || login
        const permUpper = String(viewerPermission ?? '').toUpperCase()
        const canPush = permUpper === 'ADMIN' || permUpper === 'MAINTAIN' || permUpper === 'WRITE'
        return {
          repo: norm,
          viewerPermission,
          canPush,
          isFork: repoNode.isFork === true,
          parent: repoNode.parent?.nameWithOwner,
          defaultBranch: repoNode.defaultBranchRef?.name,
          private: repoNode.isPrivate === true,
          owner: repoNode.owner?.login,
          login,
        }
      }
    } catch {
      // GraphQL 不可用或受限时回退 REST /repos/{owner}/{name}
    }

    const data = await rest('GET', `/repos/${norm}`)
    if (!login) login = await getAuthenticatedLogin()
    const perms = data?.permissions ?? {}
    const canPush = perms.push === true || perms.maintain === true || perms.admin === true
    viewerPermission = perms.admin ? 'ADMIN' : (perms.maintain ? 'MAINTAIN' : (perms.push ? 'WRITE' : (perms.pull ? 'READ' : 'NONE')))
    return {
      repo: norm,
      viewerPermission,
      canPush,
      isFork: data?.fork === true,
      parent: data?.parent?.full_name,
      defaultBranch: data?.default_branch,
      private: data?.private === true,
      owner: data?.owner?.login,
      login,
    }
  }

  async function getIssue(repo, number) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    return rest('GET', `/repos/${norm}/issues/${Number(number)}`)
  }

  async function getPullRequest(repo, number) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    return rest('GET', `/repos/${norm}/pulls/${Number(number)}`)
  }

  async function listOpenPullRequests(repo, { base, head, state = 'open', perPage = 30 } = {}) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    return rest('GET', `/repos/${norm}/pulls`, {
      query: { state, base, head, per_page: perPage },
    })
  }

  async function checkStackedPullRequests(repo, branch) {
    const prs = await listOpenPullRequests(repo, { base: branch, state: 'open' })
    const list = Array.isArray(prs) ? prs : []
    return {
      hasStacked: list.length > 0,
      count: list.length,
      prs: list.map((p) => ({
        number: p.number,
        title: p.title,
        url: p.html_url,
        head: p.head?.ref,
        base: p.base?.ref,
      })),
    }
  }

  async function checkBranch(repo, branch) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    try {
      const data = await rest('GET', `/repos/${norm}/branches/${encodeURIComponent(branch)}`)
      return {
        exists: true,
        name: data?.name ?? branch,
        protected: data?.protected === true,
        sha: data?.commit?.sha,
      }
    } catch (err) {
      if (err.status === 404) return { exists: false, name: branch }
      throw err
    }
  }

  async function checkFork(upstreamRepo, owner) {
    const norm = normalizeGitHubRepo(upstreamRepo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${upstreamRepo}`)
    const targetOwner = owner || (await getAuthenticatedLogin())
    const repoName = norm.split('/')[1]
    if (targetOwner) {
      try {
        const candidate = await rest('GET', `/repos/${targetOwner}/${repoName}`)
        if (candidate?.fork === true && candidate?.parent?.full_name?.toLowerCase() === norm.toLowerCase()) {
          return {
            exists: true,
            repo: candidate.full_name,
            cloneUrl: candidate.clone_url,
            sshUrl: candidate.ssh_url,
          }
        }
      } catch (err) {
        if (err.status !== 404) throw err
      }
    }
    return { exists: false }
  }

  async function ensureFork(upstreamRepo, { create = false } = {}) {
    const existing = await checkFork(upstreamRepo)
    if (existing.exists || !create) return existing
    const norm = normalizeGitHubRepo(upstreamRepo)
    const created = await rest('POST', `/repos/${norm}/forks`, { body: {} })
    return {
      exists: true,
      created: true,
      repo: created?.full_name,
      cloneUrl: created?.clone_url,
      sshUrl: created?.ssh_url,
    }
  }

  async function postComment(repo, number, body, { kind = 'issue' } = {}) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const num = Number(number)
    if (resolvedChannel === 'gh-cli') {
      return withTempUtf8File(String(body ?? ''), async (file) => {
        const subCmd = kind === 'pr' ? 'pr' : 'issue'
        const res = await runner(
          'gh',
          [subCmd, 'comment', String(num), '--repo', norm, '--body-file', file],
          { cwd, env: safeEnv, timeoutMs: Math.max(timeoutMs, 10000) },
        )
        if (res.code !== 0) {
          throw makeHttpError(
            /403|forbidden/i.test(res.stderr) ? 403 : 0,
            res.stderr.trim() || 'gh 评论发表失败',
          )
        }
        return { ok: true, channel: 'gh-cli', url: res.stdout.trim() || undefined }
      })
    }

    const created = await rest('POST', `/repos/${norm}/issues/${num}/comments`, {
      body: { body: String(body ?? '') },
    })
    return {
      ok: true,
      channel: resolvedChannel,
      id: created?.id,
      url: created?.html_url,
    }
  }

  async function addLabels(repo, number, labels) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const list = Array.isArray(labels) ? labels.filter(Boolean).map(String) : [String(labels)].filter(Boolean)
    if (list.length === 0) return { ok: true, labels: [] }
    try {
      const updated = await rest('POST', `/repos/${norm}/issues/${Number(number)}/labels`, {
        body: { labels: list },
      })
      return { ok: true, labels: Array.isArray(updated) ? updated.map((l) => l.name) : list }
    } catch (err) {
      if (isPermissionError(err)) {
        return { skipped: true, reason: 'no-permission' }
      }
      throw err
    }
  }

  async function getBranchProtection(repo, branch) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const branchName = String(branch ?? '').trim()
    if (!branchName) throw new Error('分支名不能为空')
    try {
      const protection = await rest(
        'GET',
        `/repos/${norm}/branches/${encodeURIComponent(branchName)}/protection`,
      )
      return { ok: true, protected: true, repo: norm, branch: branchName, protection }
    } catch (err) {
      if (err?.status === 404) {
        return { ok: true, protected: false, status: 404, repo: norm, branch: branchName, protection: null }
      }
      if (isPermissionError(err)) {
        return {
          ok: false,
          protected: null,
          fallbackToHooks: true,
          status: err?.status || 403,
          reason: err?.message || 'HTTP 403/权限不足，无法读取分支保护设置',
          repo: norm,
          branch: branchName,
        }
      }
      throw err
    }
  }

  async function applyBranchProtectionSwitchA(
    repo,
    branch,
    {
      requiredChecks = [],
      strictStatusChecks = true,
      enforceAdmins = true,
      requiredApprovingReviewCount = 0,
    } = {},
  ) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const branchName = String(branch ?? '').trim()
    if (!branchName) throw new Error('分支名不能为空')

    const payload = buildSwitchABranchProtectionPayload({
      requiredChecks,
      strictStatusChecks,
      enforceAdmins,
      requiredApprovingReviewCount,
    })
    if ((payload.required_pull_request_reviews?.required_approving_review_count ?? 0) >= 1) {
      throw new Error('开关 A 载荷校验失败：禁止设置 required_approving_review_count >= 1')
    }

    try {
      const protection = await rest(
        'PUT',
        `/repos/${norm}/branches/${encodeURIComponent(branchName)}/protection`,
        { body: payload },
      )
      return {
        ok: true,
        repo: norm,
        branch: branchName,
        mode: 'switch-a',
        payload,
        protection,
      }
    } catch (err) {
      if (isPermissionError(err)) {
        return {
          ok: false,
          fallbackToHooks: true,
          status: err?.status || 403,
          reason: err?.message || 'HTTP 403 或权限/计划受限，无法写入分支保护，请降级改用本地 .githooks/pre-push',
          repo: norm,
          branch: branchName,
          payload,
        }
      }
      throw err
    }
  }

  async function listMilestones(repo, { state = 'open', perPage = 100 } = {}) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    return rest('GET', `/repos/${norm}/milestones`, { query: { state, per_page: perPage } })
  }

  async function createMilestone(repo, { title, description = '', dueOn = null } = {}) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    return rest('POST', `/repos/${norm}/milestones`, {
      body: { title: String(title ?? '').trim(), ...(description ? { description } : {}), ...(dueOn ? { due_on: dueOn } : {}) },
    })
  }

  async function closeMilestone(repo, number) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    return rest('PATCH', `/repos/${norm}/milestones/${Number(number)}`, { body: { state: 'closed' } })
  }

  async function assignMilestone(repo, number, milestoneNumber) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    return rest('PATCH', `/repos/${norm}/issues/${Number(number)}`, { body: { milestone: Number(milestoneNumber) } })
  }

  return {
    channel: resolvedChannel,
    rest,
    graphql,
    getAuthenticatedLogin,
    getRepoPermissions,
    getIssue,
    getPullRequest,
    listOpenPullRequests,
    checkStackedPullRequests,
    checkBranch,
    checkFork,
    ensureFork,
    postComment,
    addLabels,
    listMilestones,
    createMilestone,
    closeMilestone,
    assignMilestone,
    getBranchProtection,
    applyBranchProtectionSwitchA,
  }
}
