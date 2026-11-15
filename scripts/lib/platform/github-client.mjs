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
  return /403|forbidden|resource not accessible|must have (?:triage|write|admin) access|permission/i.test(msg)
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

  async function rest(method, path, { query, body, headers = {} } = {}) {
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
          const status = parsed?.status ? Number(parsed.status) : (/HTTP 403|403 Forbidden/i.test(res.stderr) ? 403 : (/HTTP 404|404 Not Found/i.test(res.stderr) ? 404 : 0))
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
    })
    if (resp.status >= 400) {
      throw makeHttpError(resp.status, resp.data?.message || `GitHub API 返回 HTTP ${resp.status}`, resp.data)
    }
    return resp.data !== undefined ? resp.data : resp.text
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
  }
}
