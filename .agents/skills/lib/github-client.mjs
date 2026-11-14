/**
 * github-client.mjs —— 四级降级 GitHub 客户端与 Issue/PR 引用解析。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），令牌仅留存在内存闭包中，绝不落盘。
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execSafe } from './git.mjs'

let ghTmpCounter = 0

export function githubHttpsRequest(method, apiPath, token, bodyObj, { timeoutMs = 10000 } = {}) {
  return new Promise((done) => {
    let settled = false
    const finish = (res) => {
      if (settled) return
      settled = true
      done(res)
    }
    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8')
    const headers = {
      'User-Agent': 'dev-flow-kit',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      headers['Content-Length'] = String(payload.length)
    }
    const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined

    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers,
      timeout: timeoutMs,
      ...(signal ? { signal } : {}),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
        finish({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode ?? 0, data })
      })
    })
    req.on('timeout', () => {
      req.destroy()
      finish({ ok: false, status: 408, data: { message: 'GitHub API timeout' } })
    })
    req.on('error', (err) => {
      const isAbort = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      const safeMsg = String(err?.message ?? 'request-error').replace(/(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]')
      finish({ ok: false, status: isAbort ? 408 : 0, data: { message: safeMsg } })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

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

async function withUtf8TempFile(prefix, content, fn) {
  ghTmpCounter += 1
  const tmpFile = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${ghTmpCounter}.md`)
  writeFileSync(tmpFile, String(content ?? ''), 'utf8')
  try {
    return await fn(tmpFile)
  } finally {
    try { unlinkSync(tmpFile) } catch { /* ignore */ }
  }
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

/** 解析单个 PR 引用（正整数、#M、pr#M 或 GitHub Pull Request URL）。 */
export function parsePrNumber(raw, { strict = false } = {}) {
  if (raw === undefined || raw === null || raw === '') return null
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw > 0) return raw
    if (strict) throw new Error(`PR 编号必须为正整数，收到：${raw}`)
    return null
  }
  const s = String(raw).trim()
  if (!s) return null
  let m = /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#]|$)/i.exec(s)
  if (m) return Number(m[1])
  m = /^(?:pr)?#?(\d+)$/i.exec(s)
  if (m) {
    const n = Number(m[1])
    if (Number.isInteger(n) && n > 0) return n
  }
  if (strict) throw new Error(`PR 引用格式无效（支持编号、#M、pr#M 或 GitHub PR URL）：${raw}`)
  return null
}

/** 解析 Issue 引用或列表（正整数、#N、issue#N 或 GitHub Issue URL，支持逗号/空格分隔）。 */
export function parseIssueNumbers(rawOrList, { strict = false } = {}) {
  const tokens = (Array.isArray(rawOrList) ? rawOrList : [rawOrList])
    .flatMap((v) => (v === undefined || v === null ? [] : String(v).split(/[\s,]+/)))
    .map((s) => s.trim())
    .filter(Boolean)
  const nums = []
  for (const tok of tokens) {
    let m = /^https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/(\d+)(?:[/?#]|$)/i.exec(tok)
    if (!m) m = /^(?:issue)?#?(\d+)$/i.exec(tok)
    if (m) {
      const n = Number(m[1])
      if (Number.isInteger(n) && n > 0 && !nums.includes(n)) nums.push(n)
    } else if (strict) {
      throw new Error(`Issue 引用格式无效（支持正整数、#N、issue#N 或 GitHub Issue URL）：${tok}`)
    }
  }
  return nums
}

/** 解析混合输入列表（Issue URL / PR URL / #N / issue#N / pr#N）。 */
export function parseFlowInputs(inputs = [], defaultRepo = null) {
  const issues = []
  const prs = []
  const unknown = []
  for (const raw of inputs) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    let m = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i.exec(s)
    if (m) { issues.push({ repo: m[1], number: Number(m[2]), raw: s }); continue }
    m = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i.exec(s)
    if (m) { prs.push({ repo: m[1], number: Number(m[2]), raw: s }); continue }
    m = /^pr#(\d+)$/i.exec(s)
    if (m) { prs.push({ repo: defaultRepo, number: Number(m[1]), raw: s }); continue }
    m = /^(?:issue)?#(\d+)$/i.exec(s)
    if (m) { issues.push({ repo: defaultRepo, number: Number(m[1]), raw: s }); continue }
    unknown.push(s)
  }
  return { issues, prs, unknown }
}

/** 构造四级降级 GitHub 客户端。 */
export function createGitHubClient({
  tier = 'mcp-delegate',
  cwd = process.cwd(),
  token = null,
  login = null,
  runner = execSafe,
  httpsRequest = githubHttpsRequest,
} = {}) {
  let cachedLogin = login || null
  const makeMcpDelegate = (action, params, statePayload = {}) => {
    const tag = `<!-- pf-state:${JSON.stringify(statePayload)} -->`
    const bodyWithTag = params.body ? `${params.body}\n\n${tag}` : undefined
    return {
      ok: false,
      delegated: true,
      tier: tier === 'offline' || tier === 'half-duplex' ? tier : 'mcp-delegate',
      action,
      jsonPayload: { action, ...params, ...(bodyWithTag !== undefined ? { body: bodyWithTag } : {}), stateTag: tag },
      stateTag: tag,
    }
  }

  return {
    tier,
    async getRepoMeta(repo) {
      if (!repo) return { ok: false, reason: 'missing-repo' }
      if (tier === 'gh-cli') {
        const [res, userRes] = await Promise.all([
          runner('gh', ['api', `repos/${repo}`], { cwd }),
          cachedLogin ? Promise.resolve(null) : runner('gh', ['api', 'user', '--jq', '.login'], { cwd }),
        ])
        if (userRes?.ok && userRes.stdout?.trim()) cachedLogin = userRes.stdout.trim()
        if (!res.ok) return { ok: false, status: res.code, error: res.stderr }
        try {
          const data = JSON.parse(res.stdout)
          const perms = data.permissions
          return {
            ok: true, isFork: Boolean(data.fork), parent: data.parent?.full_name?.toLowerCase() ?? null,
            defaultBranch: data.default_branch ?? 'main', viewerLogin: cachedLogin,
            viewerPermission: perms?.admin ? 'ADMIN' : perms?.maintain ? 'MAINTAIN' : perms?.push ? 'WRITE' : (perms?.pull || !perms ? 'READ' : 'NONE'),
          }
        } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const [res, userRes] = await Promise.all([
          httpsRequest('GET', `/repos/${repo}`, token),
          !cachedLogin && token ? httpsRequest('GET', '/user', token) : Promise.resolve(null),
        ])
        if (userRes?.ok && userRes.data?.login) cachedLogin = userRes.data.login
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const data = res.data ?? {}
        const perms = data.permissions
        return {
          ok: true, isFork: Boolean(data.fork), parent: data.parent?.full_name?.toLowerCase() ?? null,
          defaultBranch: data.default_branch ?? 'main', viewerLogin: cachedLogin,
          viewerPermission: perms?.admin ? 'ADMIN' : perms?.maintain ? 'MAINTAIN' : perms?.push ? 'WRITE' : (perms?.pull || !perms ? 'READ' : 'NONE'),
        }
      }
      return makeMcpDelegate('get_repo', { repo })
    },

    async getIssue(repo, number) {
      if (tier === 'gh-cli') {
        const res = await runner('gh', ['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,state,body,url,labels'], { cwd })
        if (!res.ok) return { ok: false, error: res.stderr }
        try {
          const d = JSON.parse(res.stdout)
          return { ok: true, ...d, labels: (d.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)), relations: parseBodyRelations(d.body) }
        } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('GET', `/repos/${repo}/issues/${number}`, token)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const d = res.data
        return {
          ok: true, number: d.number, title: d.title, state: String(d.state ?? '').toUpperCase(),
          body: d.body ?? '', url: d.html_url, labels: (d.labels ?? []).map((l) => l.name), relations: parseBodyRelations(d.body),
        }
      }
      return makeMcpDelegate('get_issue', { repo, number })
    },

    async getPr(repo, number) {
      if (tier === 'gh-cli') {
        const res = await runner('gh', ['pr', 'view', String(number), '--repo', repo, '--json', 'number,title,state,body,url,headRefName,baseRefName,headRepository,headRepositoryOwner,mergedAt,author'], { cwd })
        if (!res.ok) return { ok: false, error: res.stderr }
        try {
          const d = JSON.parse(res.stdout)
          const headRepo = d.headRepositoryOwner?.login && d.headRepository?.name ? `${d.headRepositoryOwner.login}/${d.headRepository.name}` : null
          return {
            ok: true, number: d.number, title: d.title, state: String(d.state ?? '').toUpperCase(), body: d.body ?? '',
            url: d.url, headBranch: d.headRefName, baseBranch: d.baseRefName, headRepo,
            merged: Boolean(d.mergedAt) || String(d.state ?? '').toUpperCase() === 'MERGED',
            author: d.author?.login ?? null, relations: parseBodyRelations(d.body),
          }
        } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('GET', `/repos/${repo}/pulls/${number}`, token)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const d = res.data
        return {
          ok: true, number: d.number, title: d.title, state: d.merged ? 'MERGED' : String(d.state ?? '').toUpperCase(),
          body: d.body ?? '', url: d.html_url, headBranch: d.head?.ref ?? null, baseBranch: d.base?.ref ?? null,
          headRepo: d.head?.repo?.full_name ?? null, merged: Boolean(d.merged), author: d.user?.login ?? null,
          relations: parseBodyRelations(d.body),
        }
      }
      return makeMcpDelegate('get_pr', { repo, number })
    },

    async listOpenPrsByBase(repo, baseBranch) {
      if (!repo || !baseBranch) return { ok: true, prs: [], skipped: true }
      if (tier === 'gh-cli') {
        const res = await runner('gh', ['pr', 'list', '--repo', repo, '--base', baseBranch, '--state', 'open', '--json', 'number,title,headRefName,url'], { cwd })
        if (!res.ok) return { ok: false, prs: [], error: res.stderr }
        try { return { ok: true, prs: JSON.parse(res.stdout) } } catch { return { ok: false, prs: [] } }
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('GET', `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}`, token)
        if (!res.ok) return { ok: false, prs: [], error: res.data?.message }
        return { ok: true, prs: (res.data ?? []).map((p) => ({ number: p.number, title: p.title, headRefName: p.head?.ref, url: p.html_url })) }
      }
      return { ok: true, prs: [], skipped: true, reason: tier }
    },

    async findOpenPrForBranch(repo, headBranch, { headOwner } = {}) {
      if (!repo || !headBranch) return { ok: false, prs: [] }
      if (tier === 'gh-cli') {
        const headArg = headOwner ? `${headOwner}:${headBranch}` : headBranch
        const res = await runner('gh', ['pr', 'list', '--repo', repo, '--head', headArg, '--state', 'open', '--json', 'number,title,headRefName,baseRefName,url,state'], { cwd })
        if (!res.ok) return { ok: false, prs: [] }
        try { return { ok: true, prs: JSON.parse(res.stdout) } } catch { return { ok: false, prs: [] } }
      }
      if (tier === 'node-https-token') {
        const owner = headOwner || repo.split('/')[0]
        const headParam = headBranch.includes(':') ? headBranch : `${owner}:${headBranch}`
        const res = await httpsRequest('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(headParam)}`, token)
        if (!res.ok) return { ok: false, prs: [] }
        return { ok: true, prs: (res.data ?? []).map((p) => ({ number: p.number, title: p.title, headRefName: p.head?.ref, baseRefName: p.base?.ref, url: p.html_url })) }
      }
      return { ok: false, prs: [], reason: tier }
    },

    async postComment({ repo, number, body, statePayload = {} }) {
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      const tag = `<!-- pf-state:${JSON.stringify(statePayload)} -->`
      const fullBody = Object.keys(statePayload).length > 0 ? `${normalizedBody}\n\n${tag}` : normalizedBody
      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-comment', fullBody, async (tmpFile) => {
          const res = await runner('gh', ['api', `repos/${repo}/issues/${number}/comments`, '-X', 'POST', '-F', `body=@${tmpFile}`], { cwd })
          if (!res.ok) return { ok: false, error: res.stderr }
          let created = null
          try { created = JSON.parse(res.stdout) } catch { /* ignore */ }
          const readback = String(created?.body ?? '').replace(/\r\n/g, '\n').trim()
          return { ok: true, id: created?.id ?? null, url: created?.html_url ?? null, verifiedReadback: readback === fullBody }
        })
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('POST', `/repos/${repo}/issues/${number}/comments`, token, { body: fullBody })
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const readback = String(res.data?.body ?? '').replace(/\r\n/g, '\n').trim()
        return { ok: true, id: res.data?.id ?? null, url: res.data?.html_url ?? null, verifiedReadback: readback === fullBody }
      }
      return makeMcpDelegate('post_comment', { repo, number, body: normalizedBody }, statePayload)
    },

    async addLabels({ repo, number, labels = [] }) {
      if (labels.length === 0) return { ok: true, skipped: true }
      if (tier === 'gh-cli') {
        const args = ['issue', 'edit', String(number), '--repo', repo]
        for (const l of labels) args.push('--add-label', l)
        const res = await runner('gh', args, { cwd })
        if (!res.ok) {
          return /403|forbidden|permission|not authorized/i.test(res.stderr)
            ? { ok: false, skipped: true, reason: 'forbidden-403' }
            : { ok: false, skipped: true, reason: res.stderr }
        }
        return { ok: true }
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('POST', `/repos/${repo}/issues/${number}/labels`, token, { labels })
        if (res.status === 403 || res.status === 404) return { ok: false, skipped: true, reason: `http-${res.status}` }
        if (!res.ok) return { ok: false, skipped: true, reason: res.data?.message }
        return { ok: true }
      }
      return makeMcpDelegate('add_labels', { repo, number, labels })
    },

    async createPr({ targetRepo, head, base, title, body, draft = false }) {
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-pr-body', normalizedBody, async (tmpFile) => {
          const args = ['pr', 'create', '--repo', targetRepo, '--head', head, '--base', base, '--title', title, '--body-file', tmpFile]
          if (draft) args.push('--draft')
          const res = await runner('gh', args, { cwd })
          if (!res.ok) return { ok: false, error: res.stderr }
          const url = res.stdout.trim().split('\n').pop()
          const numMatch = /\/pull\/(\d+)$/.exec(url ?? '')
          return { ok: true, url, number: numMatch ? Number(numMatch[1]) : null }
        })
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('POST', `/repos/${targetRepo}/pulls`, token, { title, body: normalizedBody, head, base, draft })
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        return { ok: true, number: res.data?.number ?? null, url: res.data?.html_url ?? null }
      }
      const oneClickUrl = `https://github.com/${targetRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`
      if (tier === 'half-duplex') return { ok: false, halfDuplex: true, tier: 'half-duplex', oneClickPrUrl: oneClickUrl, title, body: normalizedBody }
      return {
        ...makeMcpDelegate('create_pr', { repo: targetRepo, head, base, title, body: normalizedBody, draft }, { action: 'create_pr', head, base }),
        oneClickPrUrl: oneClickUrl,
      }
    },

    async mergePr({ repo, number, method = 'merge' }) {
      if (tier === 'gh-cli') {
        const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge'
        const res = await runner('gh', ['pr', 'merge', String(number), '--repo', repo, flag], { cwd })
        if (!res.ok) return { ok: false, error: res.stderr }
        const readback = await this.getPr(repo, number)
        return { ok: readback.ok && readback.merged === true, merged: Boolean(readback.merged), state: readback.state ?? 'UNKNOWN' }
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('PUT', `/repos/${repo}/pulls/${number}/merge`, token, { merge_method: method })
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const readback = await this.getPr(repo, number)
        return { ok: readback.ok && readback.merged === true, merged: Boolean(readback.merged), state: readback.state ?? 'UNKNOWN' }
      }
      return makeMcpDelegate('merge_pr', { repo, number, method })
    },

    async createIssue({ repo, title, body = '', labels = [] } = {}) {
      const cleanTitle = String(title ?? '').trim()
      if (!repo || !cleanTitle) return { ok: false, error: 'missing-repo-or-title' }
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      const cleanLabels = Array.isArray(labels)
        ? labels.map((l) => String(l ?? '').trim()).filter(Boolean)
        : []

      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-issue-body', normalizedBody, async (tmpFile) => {
          const args = ['issue', 'create', '--repo', repo, '--title', cleanTitle, '--body-file', tmpFile]
          for (const lbl of cleanLabels) args.push('--label', lbl)
          const res = await runner('gh', args, { cwd })
          if (!res.ok) return { ok: false, error: res.stderr }
          const url = res.stdout.trim().split('\n').pop()
          const numMatch = /\/issues\/(\d+)$/.exec(url ?? '')
          return {
            ok: true,
            url: url || null,
            number: numMatch ? Number(numMatch[1]) : null,
            title: cleanTitle,
            labels: cleanLabels,
          }
        })
      }
      if (tier === 'node-https-token') {
        const payload = { title: cleanTitle, body: normalizedBody }
        if (cleanLabels.length > 0) payload.labels = cleanLabels
        const res = await httpsRequest('POST', `/repos/${repo}/issues`, token, payload)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message ?? 'create-issue-failed' }
        return {
          ok: true,
          number: res.data?.number ?? null,
          url: res.data?.html_url ?? null,
          title: res.data?.title ?? cleanTitle,
          labels: (res.data?.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean),
        }
      }
      return makeMcpDelegate('create_issue', {
        repo,
        title: cleanTitle,
        body: normalizedBody,
        ...(cleanLabels.length > 0 ? { labels: cleanLabels } : {}),
      }, { action: 'create_issue' })
    },

    async listComments(arg, maybeNumber) {
      const { repo, number, perPage = 100 } = (typeof arg === 'object' && arg !== null)
        ? arg
        : { repo: arg, number: maybeNumber }
      if (!repo || number === undefined || number === null) {
        return { ok: false, comments: [], error: 'missing-repo-or-number' }
      }
      const normalizeList = (rawList) => (Array.isArray(rawList) ? rawList : []).map((c) => {
        const body = String(c?.body ?? '')
        const pfStates = parsePfStateTags(body)
        return {
          id: c?.id ?? null,
          author: c?.user?.login ?? c?.author?.login ?? null,
          body,
          createdAt: c?.created_at ?? c?.createdAt ?? null,
          updatedAt: c?.updated_at ?? c?.updatedAt ?? null,
          url: c?.html_url ?? c?.url ?? null,
          pfState: pfStates.length > 0 ? pfStates[pfStates.length - 1] : null,
          pfStates,
        }
      })

      if (tier === 'gh-cli') {
        const collected = []
        for (let page = 1; page <= 5; page += 1) {
          const res = await runner('gh', ['api', `repos/${repo}/issues/${number}/comments?per_page=${perPage}&page=${page}`], { cwd })
          if (!res.ok) {
            if (page === 1) return { ok: false, comments: [], error: res.stderr }
            break
          }
          let batch
          try { batch = JSON.parse(res.stdout) } catch {
            if (page === 1) return { ok: false, comments: [], error: 'invalid-json' }
            break
          }
          if (!Array.isArray(batch)) break
          collected.push(...normalizeList(batch))
          if (batch.length < perPage) break
        }
        return { ok: true, comments: collected }
      }
      if (tier === 'node-https-token') {
        const collected = []
        for (let page = 1; page <= 5; page += 1) {
          const res = await httpsRequest('GET', `/repos/${repo}/issues/${number}/comments?per_page=${perPage}&page=${page}`, token)
          if (!res.ok) {
            if (page === 1) return { ok: false, status: res.status, comments: [], error: res.data?.message }
            break
          }
          const batch = Array.isArray(res.data) ? res.data : []
          collected.push(...normalizeList(batch))
          if (batch.length < perPage) break
        }
        return { ok: true, comments: collected }
      }
      return { ...makeMcpDelegate('list_comments', { repo, number }), comments: [] }
    },

    async removeLabel({ repo, number, label } = {}) {
      const cleanLabel = String(label ?? '').trim()
      if (!repo || number === undefined || number === null || !cleanLabel) return { ok: true, skipped: true }
      if (tier === 'gh-cli') {
        const res = await runner('gh', ['issue', 'edit', String(number), '--repo', repo, '--remove-label', cleanLabel], { cwd })
        if (!res.ok) {
          if (/403|forbidden|permission|not authorized/i.test(res.stderr)) {
            return { ok: false, skipped: true, reason: 'forbidden-403' }
          }
          if (/404|not found|does not have/i.test(res.stderr)) {
            return { ok: true, skipped: true, reason: 'label-absent' }
          }
          return { ok: false, skipped: true, reason: res.stderr }
        }
        return { ok: true }
      }
      if (tier === 'node-https-token') {
        const res = await httpsRequest('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(cleanLabel)}`, token)
        if (res.status === 404) return { ok: true, skipped: true, reason: 'label-absent' }
        if (res.status === 403) return { ok: false, skipped: true, reason: 'http-403' }
        if (!res.ok) return { ok: false, skipped: true, reason: res.data?.message }
        return { ok: true }
      }
      return makeMcpDelegate('remove_label', { repo, number, label: cleanLabel })
    },
  }
}

export async function createIssue({ repo, title, body = '', labels = [], client, ...clientOpts } = {}) {
  const c = client ?? createGitHubClient(clientOpts)
  return c.createIssue({ repo, title, body, labels })
}

export async function listComments({ repo, number, perPage = 100, client, ...clientOpts } = {}) {
  const c = client ?? createGitHubClient(clientOpts)
  return c.listComments({ repo, number, perPage })
}

export async function removeLabel({ repo, number, label, client, ...clientOpts } = {}) {
  const c = client ?? createGitHubClient(clientOpts)
  return c.removeLabel({ repo, number, label })
}
