/**
 * github-client.mjs —— 四级降级 GitHub 客户端、HTTP 韧性退避重试、并发池与幂等保护。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），令牌仅留存在内存闭包中，绝不落盘。
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { execSafe } from './git.mjs'
import { assertWellFormedMarkdownBody } from './pr-template-hydrate.mjs'
import {
  DEFAULT_GITHUB_CONCURRENCY, addLabelsWithEnsureAndReadback, closePrViaRest,
  createLabelViaApi, mapWithConcurrency, normalizeLabelList,
} from './github-labels.mjs'
import {
  MAX_RETRY_DELAY_MS, computeWriteBackFingerprint, extractCliHttpStatus,
  isRetryableHttpOutcome, normalizeCommentEntries, normalizeIssuePayload, normalizeMilestonePayload,
  normalizePrPayload, normalizeRepoMetaPayload, parseBodyRelations, parseFlowInputs,
  parseIssueNumbers, parseMilestoneNumber, parsePfStateTags, parsePrNumber, parseRetryAfterMs,
  redactGhTokens, resolveIdentityLayers, stripPfStateTags, summarizeCommitChecks,
} from './github-parse.mjs'

export const NON_API_CLIENT_TIERS = Object.freeze(new Set(['none', 'offline', 'half-duplex', 'mcp-delegate']))

export {
  DEFAULT_GITHUB_CONCURRENCY, computeWriteBackFingerprint, mapWithConcurrency,
  parseBodyRelations, parseFlowInputs, parseIssueNumbers, parseMilestoneNumber,
  parsePfStateTags, parsePrNumber, resolveIdentityLayers, stripPfStateTags, summarizeCommitChecks,
}

let ghTmpCounter = 0

function defaultSleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

export function githubHttpsRequest(method, apiPath, token, bodyObj, { timeoutMs = 10000, redirect = 'manual' } = {}) {
  return new Promise((done) => {
    let settled = false
    const finish = (res) => { if (!settled) { settled = true; done(res) } }
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
    const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    const req = https.request({
      hostname: 'api.github.com', path: apiPath, method, headers, timeout: timeoutMs, redirect, ...(signal ? { signal } : {}),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const resHeaders = res.headers ?? {}
        if (status >= 300 && status < 400) {
          finish({ ok: false, status, headers: resHeaders, isRedirect: true, redirectLocation: resHeaders.location ?? null, data: { message: `Redirect rejected (HTTP ${status})` } })
          return
        }
        const raw = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
        finish({ ok: status >= 200 && status < 300, status, headers: resHeaders, data })
      })
    })
    req.on('timeout', () => {
      req.destroy()
      finish({ ok: false, status: 408, timedOut: true, headers: {}, data: { message: 'GitHub API timeout' } })
    })
    req.on('error', (err) => {
      const isAbort = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      finish({
        ok: false, status: isAbort ? 408 : 0, timedOut: isAbort, code: err?.code ?? null, headers: {},
        data: { message: redactGhTokens(err?.message ?? 'request-error') },
      })
    })
    if (payload) req.write(payload)
    req.end()
  })
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

function parseAddLabelsArgs(arg1, arg2, arg3, arg4, defaultRepo) {
  if (arg1 && typeof arg1 === 'object' && !Array.isArray(arg1)) {
    return { ...arg1, repo: arg1.repo ?? defaultRepo }
  }
  if (typeof arg1 === 'string' && arg1.includes('/') && (typeof arg2 === 'number' || /^\d+$/.test(String(arg2 ?? '')))) {
    return { ...(arg4 ?? {}), repo: arg1, number: Number(arg2), labels: Array.isArray(arg3) ? arg3 : [] }
  }
  return { ...(arg3 ?? {}), repo: arg3?.repo ?? defaultRepo, number: Number(arg1), labels: Array.isArray(arg2) ? arg2 : [] }
}

function parseClosePrArgs(arg1, arg2, arg3, defaultRepo) {
  if (arg1 && typeof arg1 === 'object') {
    return { ...arg1, repo: arg1.repo ?? defaultRepo, number: arg1.number ?? arg1.prNumber }
  }
  if (typeof arg1 === 'string' && arg1.includes('/') && (typeof arg2 === 'number' || /^\d+$/.test(String(arg2 ?? '')))) {
    return { ...(arg3 ?? {}), repo: arg1, number: Number(arg2) }
  }
  return { ...(arg2 ?? {}), repo: arg2?.repo ?? defaultRepo, number: Number(arg1) }
}

/** 构造四级降级 GitHub 客户端。 */
export function createGitHubClient({
  tier = 'mcp-delegate',
  cwd = process.cwd(),
  repo: defaultRepo = null,
  token = null,
  login = null,
  runner = execSafe,
  httpsRequest = githubHttpsRequest,
  maxRetries = 2,
  retryBaseDelayMs = 150,
  maxRetryDelayMs = MAX_RETRY_DELAY_MS,
  concurrency = DEFAULT_GITHUB_CONCURRENCY,
  sleep = defaultSleep,
} = {}) {
  let cachedLogin = login || null
  const seenFingerprints = new Set()

  const makeMcpDelegate = (action, params, statePayload = {}) => {
    const tag = `<!-- pf-state:${JSON.stringify(statePayload)} -->`
    const bodyWithTag = params.body ? `${params.body}\n\n${tag}` : undefined
    return {
      ok: false,
      delegated: true,
      tier: tier === 'offline' || tier === 'half-duplex' || tier === 'none' ? tier : 'mcp-delegate',
      action,
      jsonPayload: { action, ...params, ...(bodyWithTag !== undefined ? { body: bodyWithTag } : {}), stateTag: tag },
      stateTag: tag,
    }
  }

  const runWithRetry = async (fn, parseErrStatus) => {
    const retries = Math.max(0, Number(maxRetries ?? 2))
    const capMs = Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Number(maxRetryDelayMs ?? MAX_RETRY_DELAY_MS)))
    let lastOutcome = null
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let outcome
      try {
        outcome = await fn()
      } catch (err) {
        outcome = {
          ok: false, status: Number(err?.status ?? 0), code: err?.code ?? null, name: err?.name ?? null,
          timedOut: Boolean(err?.timedOut), headers: err?.headers ?? {},
          stderr: redactGhTokens(err?.message ?? ''), data: { message: redactGhTokens(err?.message ?? 'request-error') }, thrown: err,
        }
      }
      if (outcome && outcome.status >= 300 && outcome.status < 400) {
        return { ok: false, status: outcome.status, headers: outcome.headers ?? {}, isRedirect: true, data: { message: `Redirect rejected (HTTP ${outcome.status})` } }
      }
      if (!outcome?.ok && parseErrStatus && !outcome.status) outcome = { ...outcome, status: parseErrStatus(outcome) }
      lastOutcome = outcome
      if (outcome?.ok || attempt >= retries || !isRetryableHttpOutcome(outcome)) return outcome
      const retryAfterMs = parseRetryAfterMs(outcome.headers, capMs)
      const expMs = Math.min(capMs, Math.max(0, Number(retryBaseDelayMs ?? 150)) * (2 ** attempt))
      const waitMs = retryAfterMs !== null ? Math.min(capMs, retryAfterMs) : expMs
      if (waitMs > 0) await sleep(waitMs)
    }
    return lastOutcome
  }

  const callHttps = (method, apiPath, bodyObj, opts = {}) => runWithRetry(
    () => httpsRequest(method, apiPath, token, bodyObj, { redirect: 'manual', ...opts }),
  )
  const callGh = (args, execOpts = {}) => runWithRetry(
    () => runner('gh', args, { cwd, ...execOpts }),
    (res) => extractCliHttpStatus(res?.stderr),
  )
  const commentMatchesFp = (c, fp) => {
    if (!c) return false
    const states = Array.isArray(c.pfStates) && c.pfStates.length > 0 ? c.pfStates : parsePfStateTags(c.body)
    return states.some((s) => (s?.writeBackFingerprint ?? computeWriteBackFingerprint(c.body ?? '', s)) === fp)
  }

  return {
    tier,
    async getRepoMeta(repo) {
      if (!repo) return { ok: false, reason: 'missing-repo' }
      if (tier === 'gh-cli') {
        const [res, userRes] = await Promise.all([
          callGh(['api', `repos/${repo}`]),
          cachedLogin ? Promise.resolve(null) : callGh(['api', 'user', '--jq', '.login']),
        ])
        if (userRes?.ok && userRes.stdout?.trim()) cachedLogin = userRes.stdout.trim()
        if (!res.ok) return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message }
        try { return normalizeRepoMetaPayload(JSON.parse(res.stdout), cachedLogin) } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const [res, userRes] = await Promise.all([
          callHttps('GET', `/repos/${repo}`),
          !cachedLogin && token ? callHttps('GET', '/user') : Promise.resolve(null),
        ])
        if (userRes?.ok && userRes.data?.login) cachedLogin = userRes.data.login
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        return normalizeRepoMetaPayload(res.data ?? {}, cachedLogin)
      }
      return makeMcpDelegate('get_repo', { repo })
    },

    async getIssue(repo, number) {
      if (tier === 'gh-cli') {
        const res = await callGh(['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,state,body,url,labels,milestone'])
        if (!res.ok) return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message }
        try { return { ok: true, ...normalizeIssuePayload(JSON.parse(res.stdout), false) } } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('GET', `/repos/${repo}/issues/${number}`)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        return { ok: true, ...normalizeIssuePayload(res.data ?? {}, true) }
      }
      return makeMcpDelegate('get_issue', { repo, number })
    },

    async listIssues({ repo, state = 'open', perPage = 30 } = {}) {
      if (!repo) return { ok: false, issues: [], error: 'missing-repo' }
      if (tier === 'gh-cli') {
        const res = await callGh(['issue', 'list', '--repo', repo, '--state', state, '--limit', String(perPage), '--json', 'number,title,state,body,url,labels,milestone'])
        if (!res.ok) return { ok: false, issues: [], status: res.status || res.code, error: res.stderr ?? res.data?.message }
        try {
          const raw = JSON.parse(res.stdout)
          return { ok: true, issues: (Array.isArray(raw) ? raw : []).map((d) => normalizeIssuePayload(d, false)) }
        } catch { return { ok: false, issues: [], error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('GET', `/repos/${repo}/issues?state=${encodeURIComponent(state)}&per_page=${perPage}`)
        if (!res.ok) return { ok: false, issues: [], status: res.status, error: res.data?.message }
        return { ok: true, issues: (Array.isArray(res.data) ? res.data : []).filter((d) => !d.pull_request).map((d) => normalizeIssuePayload(d, true)) }
      }
      return { ...makeMcpDelegate('list_issues', { repo, state, perPage }), issues: [] }
    },

    async closeIssue({ repo, number } = {}) {
      const num = Number(number)
      if (!repo || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const cur = await this.getIssue(repo, num)
        if (cur.ok && String(cur.state ?? '').toUpperCase() === 'CLOSED') return { ok: true, number: num, state: 'CLOSED', alreadyClosed: true }
        if (tier === 'gh-cli') {
          const res = await callGh(['issue', 'close', String(num), '--repo', repo])
          if (!res.ok) {
            if (/already\s+closed/i.test(String(res.stderr ?? ''))) return { ok: true, number: num, state: 'CLOSED', alreadyClosed: true }
            return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message }
          }
          return { ok: true, number: num, state: 'CLOSED', alreadyClosed: false }
        }
        const res = await callHttps('PATCH', `/repos/${repo}/issues/${num}`, { state: 'closed' })
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message ?? 'close-issue-failed' }
        return { ok: true, number: res.data?.number ?? num, state: 'CLOSED', alreadyClosed: false }
      }
      return makeMcpDelegate('close_issue', { repo, number: num })
    },

    async updateIssueBody(arg1, maybeNumber, maybeBody) {
      const cfg = (arg1 && typeof arg1 === 'object')
        ? { repo: arg1.repo ?? defaultRepo, number: arg1.number ?? arg1.issue, body: arg1.body }
        : { repo: arg1 ?? defaultRepo, number: maybeNumber, body: maybeBody }
      const num = Number(cfg.number)
      if (!cfg.repo || !Number.isInteger(num) || num <= 0 || cfg.body === undefined || cfg.body === null) {
        return { ok: false, error: 'missing-repo-number-or-body' }
      }
      const normalizedBody = String(cfg.body).replace(/\r\n/g, '\n')
      assertWellFormedMarkdownBody(normalizedBody, 'Issue 正文')
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const res = tier === 'gh-cli'
          ? await withUtf8TempFile('pf-issue-patch', JSON.stringify({ body: normalizedBody }), (tmp) => (
              callGh(['api', `repos/${cfg.repo}/issues/${num}`, '-X', 'PATCH', '--input', tmp])
            ))
          : await callHttps('PATCH', `/repos/${cfg.repo}/issues/${num}`, { body: normalizedBody })
        if (!res.ok) return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message ?? 'update-issue-body-failed' }
        const parsed = tier === 'node-https-token' ? res.data : (() => { try { return JSON.parse(res.stdout) } catch { return null } })()
        return { ok: true, number: parsed?.number ?? num, body: parsed?.body ?? normalizedBody }
      }
      return makeMcpDelegate('update_issue', { repo: cfg.repo, number: num, body: normalizedBody })
    },

    async getPr(repo, number) {
      if (tier === 'gh-cli') {
        const res = await callGh(['pr', 'view', String(number), '--repo', repo, '--json', 'number,title,state,body,url,headRefName,baseRefName,headRefOid,baseRefOid,headRepository,headRepositoryOwner,mergedAt,mergeCommit,author,labels'])
        if (!res.ok) return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message }
        try {
          const raw = JSON.parse(res.stdout)
          return { ...normalizePrPayload(raw, false), labels: normalizeLabelList(raw?.labels) }
        } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('GET', `/repos/${repo}/pulls/${number}`)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const raw = res.data ?? {}
        return { ...normalizePrPayload(raw, true), labels: normalizeLabelList(raw.labels) }
      }
      return makeMcpDelegate('get_pr', { repo, number })
    },

    async batchFetchIssues(repo, numbers = [], { concurrency: limit = concurrency } = {}) {
      const nums = (Array.isArray(numbers) ? numbers : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
      return mapWithConcurrency(nums, limit, (num) => this.getIssue(repo, num))
    },

    async batchFetchPrs(repo, numbers = [], { concurrency: limit = concurrency } = {}) {
      const nums = (Array.isArray(numbers) ? numbers : []).map(Number).filter((n) => Number.isInteger(n) && n > 0)
      return mapWithConcurrency(nums, limit, (num) => this.getPr(repo, num))
    },

    async listOpenPrsByBase(repo, baseBranch) {
      if (!repo || !baseBranch) return { ok: true, prs: [], skipped: true }
      if (tier === 'gh-cli') {
        const res = await callGh(['pr', 'list', '--repo', repo, '--base', baseBranch, '--state', 'open', '--json', 'number,title,headRefName,url'])
        if (!res.ok) return { ok: false, prs: [], error: res.stderr ?? res.data?.message }
        try { return { ok: true, prs: JSON.parse(res.stdout) } } catch { return { ok: false, prs: [] } }
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('GET', `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(baseBranch)}`)
        if (!res.ok) return { ok: false, prs: [], error: res.data?.message }
        return { ok: true, prs: (res.data ?? []).map((p) => ({ number: p.number, title: p.title, headRefName: p.head?.ref, url: p.html_url })) }
      }
      return { ok: true, prs: [], skipped: true, reason: tier }
    },

    async findOpenPrForBranch(repo, headBranch, { headOwner, base } = {}) {
      if (!repo || !headBranch) return { ok: false, prs: [] }
      if (tier === 'gh-cli') {
        const headArg = headOwner && !headBranch.includes(':') ? `${headOwner}:${headBranch}` : headBranch
        const args = ['pr', 'list', '--repo', repo, '--head', headArg, '--state', 'open']
        if (base) args.push('--base', base)
        args.push('--json', 'number,title,headRefName,baseRefName,url,state')
        const res = await callGh(args)
        if (!res.ok) return { ok: false, prs: [] }
        try {
          const list = JSON.parse(res.stdout)
          return { ok: true, prs: base && Array.isArray(list) ? list.filter((p) => !p.baseRefName || p.baseRefName === base) : list }
        } catch { return { ok: false, prs: [] } }
      }
      if (tier === 'node-https-token') {
        const owner = headOwner || repo.split('/')[0]
        const headParam = headBranch.includes(':') ? headBranch : `${owner}:${headBranch}`
        const baseQ = base ? `&base=${encodeURIComponent(base)}` : ''
        const res = await callHttps('GET', `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(headParam)}${baseQ}`)
        if (!res.ok) return { ok: false, prs: [] }
        const prs = (res.data ?? []).map((p) => ({
          number: p.number, title: p.title, headRefName: p.head?.ref, baseRefName: p.base?.ref, url: p.html_url, state: String(p.state ?? 'open').toUpperCase(),
        }))
        return { ok: true, prs: base ? prs.filter((p) => !p.baseRefName || p.baseRefName === base) : prs }
      }
      return { ok: false, prs: [], reason: tier }
    },

    async listOpenPrsByHead(repo, headBranch, opts = {}) {
      return this.findOpenPrForBranch(repo, headBranch, opts)
    },

    async postComment({ repo, number, body, statePayload = {}, deduplicate = true, existingComments = null } = {}) {
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      assertWellFormedMarkdownBody(normalizedBody, '评论正文')
      const hasState = statePayload && typeof statePayload === 'object' && Object.keys(statePayload).length > 0
      const fp = hasState ? computeWriteBackFingerprint(normalizedBody, statePayload) : null
      const finalState = hasState ? { ...statePayload, writeBackFingerprint: statePayload.writeBackFingerprint ?? fp } : {}
      const tag = hasState ? `<!-- pf-state:${JSON.stringify(finalState)} -->` : ''
      const fullBody = hasState ? `${normalizedBody}\n\n${tag}` : normalizedBody

      if (deduplicate && fp && (tier === 'gh-cli' || tier === 'node-https-token')) {
        const cacheKey = `${repo ?? ''}#${number ?? ''}#${fp}`
        if (seenFingerprints.has(cacheKey)) return { ok: true, deduplicated: true, skipped: true, writeBackFingerprint: fp }
        const candidateList = Array.isArray(existingComments)
          ? { ok: true, comments: existingComments }
          : (repo && number !== undefined && number !== null ? await this.listComments({ repo, number }) : null)
        if (candidateList?.ok && Array.isArray(candidateList.comments)) {
          const hit = candidateList.comments.find((c) => commentMatchesFp(c, fp))
          if (hit) {
            seenFingerprints.add(cacheKey)
            return { ok: true, deduplicated: true, skipped: true, writeBackFingerprint: fp, id: hit.id ?? null, url: hit.url ?? null }
          }
        }
      }

      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-comment', fullBody, async (tmpFile) => {
          const res = await callGh(['api', `repos/${repo}/issues/${number}/comments`, '-X', 'POST', '-F', `body=@${tmpFile}`])
          if (!res.ok) return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message }
          if (fp) seenFingerprints.add(`${repo ?? ''}#${number ?? ''}#${fp}`)
          let created = null
          try { created = JSON.parse(res.stdout) } catch { /* ignore */ }
          const readback = String(created?.body ?? '').replace(/\r\n/g, '\n').trim()
          return { ok: true, id: created?.id ?? null, url: created?.html_url ?? null, verifiedReadback: readback === fullBody, ...(fp ? { writeBackFingerprint: fp } : {}) }
        })
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('POST', `/repos/${repo}/issues/${number}/comments`, { body: fullBody })
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        if (fp) seenFingerprints.add(`${repo ?? ''}#${number ?? ''}#${fp}`)
        const readback = String(res.data?.body ?? '').replace(/\r\n/g, '\n').trim()
        return { ok: true, id: res.data?.id ?? null, url: res.data?.html_url ?? null, verifiedReadback: readback === fullBody, ...(fp ? { writeBackFingerprint: fp } : {}) }
      }
      return makeMcpDelegate('post_comment', { repo, number, body: normalizedBody }, finalState)
    },

    async createLabel(repoOrOpts, maybeName, maybeOpts = {}) {
      const cfg = (repoOrOpts && typeof repoOrOpts === 'object')
        ? repoOrOpts
        : { ...maybeOpts, repo: repoOrOpts, name: maybeName }
      return createLabelViaApi({
        tier, repo: cfg.repo ?? defaultRepo, name: cfg.name, color: cfg.color, description: cfg.description,
        callHttps, callGh, withTempFile: withUtf8TempFile, makeMcpDelegate,
      })
    },

    async addLabels(arg1, arg2, arg3, arg4) {
      const cfg = parseAddLabelsArgs(arg1, arg2, arg3, arg4, defaultRepo)
      return addLabelsWithEnsureAndReadback({
        tier,
        repo: cfg.repo,
        number: cfg.number,
        labels: cfg.labels ?? [],
        isPr: Boolean(cfg.isPr),
        readTarget: (r, n, o) => (o?.isPr ? this.getPr(r, n) : this.getIssue(r, n)),
        listRepoLabels: ({ repo: r }) => this.listLabels({ repo: r }),
        callHttps,
        callGh,
        withTempFile: withUtf8TempFile,
        makeMcpDelegate,
        concurrency: cfg.concurrency ?? concurrency,
        labelStyles: cfg.labelStyles,
      })
    },

    async closePr(arg1, arg2, arg3) {
      const cfg = parseClosePrArgs(arg1, arg2, arg3, defaultRepo)
      return closePrViaRest({
        tier,
        repo: cfg.repo,
        number: cfg.number,
        comment: cfg.comment ?? '',
        labels: cfg.labels ?? [],
        dryRun: Boolean(cfg.dryRun),
        statePayload: cfg.statePayload ?? {},
        postCommentFn: (p) => this.postComment(p),
        addLabelsFn: (p) => this.addLabels(p),
        readPrFn: (r, n) => this.getPr(r, n),
        callHttps,
        callGh,
        withTempFile: withUtf8TempFile,
        makeMcpDelegate,
      })
    },

    async createPr({ targetRepo, head, base, title, body, draft = false } = {}) {
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      assertWellFormedMarkdownBody(normalizedBody, 'PR 正文')
      const [headOwner, headBranch] = String(head ?? '').includes(':') ? String(head).split(':') : [undefined, String(head ?? '')]
      const tryReuseConcurrent = async () => {
        if (!targetRepo || !headBranch) return null
        const existing = await this.findOpenPrForBranch(targetRepo, headBranch, { headOwner, base })
        if (existing?.ok && Array.isArray(existing.prs) && existing.prs.length > 0) {
          const hit = existing.prs[0]
          return { ok: true, number: hit.number ?? null, url: hit.url ?? null, reusedConcurrentPr: true }
        }
        return null
      }
      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-pr-body', normalizedBody, async (tmpFile) => {
          const args = ['pr', 'create', '--repo', targetRepo, '--head', head, '--base', base, '--title', title, '--body-file', tmpFile]
          if (draft) args.push('--draft')
          const res = await callGh(args)
          if (!res.ok) {
            if (res.status !== 401 && res.status !== 403) {
              const reused = await tryReuseConcurrent()
              if (reused) return reused
            }
            return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message }
          }
          const url = res.stdout.trim().split('\n').pop()
          const numMatch = /\/pull\/(\d+)$/.exec(url ?? '')
          return { ok: true, url, number: numMatch ? Number(numMatch[1]) : null }
        })
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('POST', `/repos/${targetRepo}/pulls`, { title, body: normalizedBody, head, base, draft })
        if (!res.ok) {
          if (res.status !== 401 && res.status !== 403) {
            const reused = await tryReuseConcurrent()
            if (reused) return reused
          }
          return { ok: false, status: res.status, error: res.data?.message }
        }
        return { ok: true, number: res.data?.number ?? null, url: res.data?.html_url ?? null }
      }
      const oneClickUrl = `https://github.com/${targetRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`
      if (tier === 'half-duplex') return { ok: false, halfDuplex: true, tier: 'half-duplex', oneClickPrUrl: oneClickUrl, title, body: normalizedBody }
      return {
        ...makeMcpDelegate('create_pr', { repo: targetRepo, head, base, title, body: normalizedBody, draft }, { action: 'create_pr', head, base }),
        oneClickPrUrl: oneClickUrl,
      }
    },

    async mergePr({ repo, number, method = 'merge', sha } = {}) {
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const res = tier === 'gh-cli'
          ? await callGh([
              'pr', 'merge', String(number), '--repo', repo,
              method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge',
              ...(sha ? ['--match-head-commit', sha] : []),
            ])
          : await callHttps('PUT', `/repos/${repo}/pulls/${number}/merge`, { merge_method: method, ...(sha ? { sha } : {}) })
        const readback = await this.getPr(repo, number)
        const mergeCommit = (typeof res?.data?.sha === 'string' && res.data.sha.trim())
          ? res.data.sha.trim()
          : (readback?.mergeCommit ?? null)
        if (!res.ok) {
          if (readback.ok && readback.merged === true) {
            return {
              ok: true, merged: true, alreadyMerged: true, state: 'MERGED',
              ...(mergeCommit ? { mergeCommit, sha: mergeCommit } : {}),
            }
          }
          const status = Number(res.status ?? 0)
          return { ok: false, status, headMismatch: status === 409, mergeBlocked: status === 405, error: res.data?.message ?? res.stderr ?? 'merge-failed' }
        }
        return {
          ok: readback.ok && readback.merged === true,
          merged: Boolean(readback.merged),
          state: readback.state ?? 'UNKNOWN',
          ...(mergeCommit ? { mergeCommit, sha: mergeCommit } : {}),
        }
      }
      return makeMcpDelegate('merge_pr', { repo, number, method, ...(sha ? { sha } : {}) })
    },

    async updatePrBase({ repo, number, base } = {}) {
      const cleanRepo = String(repo ?? '').trim()
      const cleanBase = String(base ?? '').trim()
      const num = Number(number)
      if (!cleanRepo || !cleanBase || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-number-or-base' }
      if (tier === 'gh-cli') {
        const res = await callGh(['pr', 'edit', String(num), '--repo', cleanRepo, '--base', cleanBase])
        return res.ok ? { ok: true, number: num, base: cleanBase } : { ok: false, error: res.stderr ?? res.data?.message }
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('PATCH', `/repos/${cleanRepo}/pulls/${num}`, { base: cleanBase })
        return res.ok ? { ok: true, number: res.data?.number ?? num, base: res.data?.base?.ref ?? cleanBase } : { ok: false, status: res.status, error: res.data?.message ?? 'update-pr-base-failed' }
      }
      return makeMcpDelegate('update_pr_base', { repo: cleanRepo, number: num, base: cleanBase })
    },

    async createIssue({ repo, title, body = '', labels = [], milestone = null } = {}) {
      const cleanTitle = String(title ?? '').trim()
      if (!repo || !cleanTitle) return { ok: false, error: 'missing-repo-or-title' }
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      assertWellFormedMarkdownBody(normalizedBody, 'Issue 正文')
      const cleanLabels = normalizeLabelList(labels)
      const msVal = milestone?.number ?? milestone?.title ?? milestone
      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-issue-body', normalizedBody, async (tmpFile) => {
          const args = ['issue', 'create', '--repo', repo, '--title', cleanTitle, '--body-file', tmpFile]
          for (const lbl of cleanLabels) args.push('--label', lbl)
          if (msVal !== null && msVal !== undefined && String(msVal).trim()) args.push('--milestone', String(msVal).trim())
          const res = await callGh(args)
          if (!res.ok) return { ok: false, status: res.status || res.code, error: res.stderr ?? res.data?.message }
          const url = res.stdout.trim().split('\n').pop()
          const numMatch = /\/issues\/(\d+)$/.exec(url ?? '')
          return { ok: true, url: url || null, number: numMatch ? Number(numMatch[1]) : null, title: cleanTitle, labels: cleanLabels }
        })
      }
      if (tier === 'node-https-token') {
        const payload = { title: cleanTitle, body: normalizedBody }
        if (cleanLabels.length > 0) payload.labels = cleanLabels
        const msNum = parseMilestoneNumber(msVal)
        if (msNum) payload.milestone = msNum
        const res = await callHttps('POST', `/repos/${repo}/issues`, payload)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message ?? 'create-issue-failed' }
        return {
          ok: true, number: res.data?.number ?? null, url: res.data?.html_url ?? null, title: res.data?.title ?? cleanTitle,
          labels: normalizeLabelList(res.data?.labels), milestone: res.data?.milestone ? normalizeMilestonePayload(res.data.milestone) : null,
        }
      }
      return makeMcpDelegate('create_issue', {
        repo, title: cleanTitle, body: normalizedBody,
        ...(cleanLabels.length > 0 ? { labels: cleanLabels } : {}), ...(msVal ? { milestone: msVal } : {}),
      }, { action: 'create_issue' })
    },

    async listComments(arg, maybeNumber) {
      const { repo, number, perPage = 100, maxPages = 5 } = (typeof arg === 'object' && arg !== null) ? arg : { repo: arg, number: maybeNumber }
      if (!repo || number === undefined || number === null) return { ok: false, comments: [], error: 'missing-repo-or-number' }
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const fetchPage = async (page) => {
          const res = tier === 'gh-cli'
            ? await callGh(['api', `repos/${repo}/issues/${number}/comments?per_page=${perPage}&page=${page}`])
            : await callHttps('GET', `/repos/${repo}/issues/${number}/comments?per_page=${perPage}&page=${page}`)
          if (!res.ok) return { ok: false, status: res.status, error: res.stderr ?? res.data?.message, batch: [] }
          let batch = res.data
          if (tier === 'gh-cli') {
            try { batch = JSON.parse(res.stdout) } catch { return { ok: false, error: 'invalid-json', batch: [] } }
          }
          return { ok: true, batch: Array.isArray(batch) ? batch : [] }
        }
        const first = await fetchPage(1)
        if (!first.ok) return { ok: false, status: first.status, comments: [], error: first.error }
        const collected = [...normalizeCommentEntries(first.batch)]
        if (first.batch.length >= perPage && maxPages > 1) {
          const pages = Array.from({ length: maxPages - 1 }, (_, i) => i + 2)
          const rest = await mapWithConcurrency(pages, concurrency, fetchPage)
          for (const pageRes of rest) {
            if (!pageRes?.ok || pageRes.batch.length === 0) break
            collected.push(...normalizeCommentEntries(pageRes.batch))
            if (pageRes.batch.length < perPage) break
          }
        }
        return { ok: true, comments: collected }
      }
      return { ...makeMcpDelegate('list_comments', { repo, number }), comments: [] }
    },

    async removeLabel({ repo, number, label } = {}) {
      const cleanLabel = String(label ?? '').trim()
      if (!repo || number === undefined || number === null || !cleanLabel) return { ok: true, skipped: true }
      if (tier === 'gh-cli') {
        const res = await callGh(['issue', 'edit', String(number), '--repo', repo, '--remove-label', cleanLabel])
        if (!res.ok) {
          const msg = res.stderr ?? res.data?.message ?? ''
          if (/403|forbidden|permission|not authorized/i.test(msg)) return { ok: false, skipped: true, reason: 'forbidden-403' }
          if (/404|not found|does not have/i.test(msg)) return { ok: true, skipped: true, reason: 'label-absent' }
          return { ok: false, skipped: true, reason: msg }
        }
        return { ok: true }
      }
      if (tier === 'node-https-token') {
        const res = await callHttps('DELETE', `/repos/${repo}/issues/${number}/labels/${encodeURIComponent(cleanLabel)}`)
        if (res.status === 404) return { ok: true, skipped: true, reason: 'label-absent' }
        if (res.status === 403) return { ok: false, skipped: true, reason: 'http-403' }
        return res.ok ? { ok: true } : { ok: false, skipped: true, reason: res.data?.message }
      }
      return makeMcpDelegate('remove_label', { repo, number, label: cleanLabel })
    },

    async getCommitChecks({ repo, ref } = {}) {
      const cleanRepo = String(repo ?? '').trim()
      const cleanRef = String(ref ?? '').trim()
      if (!cleanRepo || !cleanRef) return { ok: false, bucket: 'unknown', total: 0, passed: [], pending: [], failed: [], warnings: ['missing-repo-or-ref'], error: 'missing-repo-or-ref' }
      const encRef = encodeURIComponent(cleanRef)
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const [crRes, stRes] = tier === 'gh-cli'
          ? await Promise.all([callGh(['api', `repos/${cleanRepo}/commits/${encRef}/check-runs?per_page=100`]), callGh(['api', `repos/${cleanRepo}/commits/${encRef}/status`])])
          : await Promise.all([callHttps('GET', `/repos/${cleanRepo}/commits/${encRef}/check-runs?per_page=100`), callHttps('GET', `/repos/${cleanRepo}/commits/${encRef}/status`)])
        const warnings = []
        const parseEp = (res, label) => {
          if (!res?.ok) { warnings.push(`${label}-unavailable: ${res?.data?.message ?? res?.stderr ?? res?.status ?? 'error'}`); return { ok: false, data: null } }
          if (tier === 'node-https-token') return { ok: true, data: res.data }
          try { return { ok: true, data: res.stdout ? JSON.parse(res.stdout) : null } } catch { warnings.push(`invalid-${label}-json`); return { ok: false, data: null } }
        }
        const cr = parseEp(crRes, 'check-runs')
        const st = parseEp(stRes, 'status')
        const summary = summarizeCommitChecks(cr.data, st.data, { warnings })
        const ok = cr.ok || summary.failed.length > 0
        return { ...summary, ok, ...(!ok ? { status: crRes?.status ?? stRes?.status ?? 0, error: warnings.join('; ') } : {}) }
      }
      return { ...makeMcpDelegate('get_commit_checks', { repo: cleanRepo, ref: cleanRef }), skipped: true, reason: tier }
    },

    async listLabels({ repo } = {}) {
      if (!repo) return { ok: false, labels: [] }
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const res = tier === 'gh-cli'
          ? await callGh(['api', `repos/${repo}/labels?per_page=100`])
          : await callHttps('GET', `/repos/${repo}/labels?per_page=100`)
        if (!res.ok) return { ok: false, labels: [], status: res.status }
        const data = tier === 'node-https-token' ? res.data : (() => { try { return JSON.parse(res.stdout) } catch { return [] } })()
        return { ok: true, labels: normalizeLabelList(data) }
      }
      return { ...makeMcpDelegate('list_labels', { repo }), labels: [] }
    },

    async listMilestones({ repo, state = 'open' } = {}) {
      if (!repo) return { ok: false, milestones: [] }
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const res = tier === 'gh-cli'
          ? await callGh(['api', `repos/${repo}/milestones?state=${encodeURIComponent(state)}&per_page=100`])
          : await callHttps('GET', `/repos/${repo}/milestones?state=${encodeURIComponent(state)}&per_page=100`)
        if (!res.ok) return { ok: false, milestones: [], status: res.status, error: res.stderr ?? res.data?.message }
        const raw = tier === 'node-https-token' ? res.data : (() => { try { return JSON.parse(res.stdout) } catch { return [] } })()
        return { ok: true, milestones: (Array.isArray(raw) ? raw : []).map(normalizeMilestonePayload) }
      }
      return { ...makeMcpDelegate('list_milestones', { repo, state }), milestones: [] }
    },

    async createMilestone({ repo, title, description = '', dueOn = null } = {}) {
      const cleanTitle = String(title ?? '').trim()
      if (!repo || !cleanTitle) return { ok: false, error: 'missing-repo-or-title' }
      const body = { title: cleanTitle, ...(description ? { description: String(description) } : {}), ...(dueOn ? { due_on: String(dueOn) } : {}) }
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const res = tier === 'gh-cli'
          ? await withUtf8TempFile('pf-ms', JSON.stringify(body), (tmp) => callGh(['api', `repos/${repo}/milestones`, '-X', 'POST', '--input', tmp]))
          : await callHttps('POST', `/repos/${repo}/milestones`, body)
        if (!res.ok) return { ok: false, status: res.status, error: res.stderr ?? res.data?.message }
        const data = tier === 'node-https-token' ? res.data : (() => { try { return JSON.parse(res.stdout) } catch { return {} } })()
        return { ok: true, ...normalizeMilestonePayload(data) }
      }
      return makeMcpDelegate('create_milestone', { repo, ...body })
    },

    async closeMilestone({ repo, number } = {}) {
      const num = parseMilestoneNumber(number)
      if (!repo || !num) return { ok: false, error: 'missing-repo-or-number' }
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const res = tier === 'gh-cli'
          ? await withUtf8TempFile('pf-ms-close', JSON.stringify({ state: 'closed' }), (tmp) => callGh(['api', `repos/${repo}/milestones/${num}`, '-X', 'PATCH', '--input', tmp]))
          : await callHttps('PATCH', `/repos/${repo}/milestones/${num}`, { state: 'closed' })
        if (!res.ok) return { ok: false, status: res.status, error: res.stderr ?? res.data?.message }
        const data = tier === 'node-https-token' ? res.data : (() => { try { return JSON.parse(res.stdout) } catch { return {} } })()
        return { ok: true, ...normalizeMilestonePayload(data) }
      }
      return makeMcpDelegate('close_milestone', { repo, number: num })
    },

    async assignMilestone({ repo, number, milestone } = {}) {
      const num = Number(number)
      if (!repo || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
      let msNum = parseMilestoneNumber(milestone?.number ?? milestone)
      if (!msNum && milestone && String(milestone).trim()) {
        const listed = await this.listMilestones({ repo, state: 'all' })
        const hit = listed.milestones?.find((m) => m.title === String(milestone).trim())
        if (hit) msNum = hit.number
      }
      if (!msNum) return { ok: false, error: `milestone-not-found: ${milestone}` }
      if (tier === 'gh-cli' || tier === 'node-https-token') {
        const res = tier === 'gh-cli'
          ? await withUtf8TempFile('pf-ms-assign', JSON.stringify({ milestone: msNum }), (tmp) => callGh(['api', `repos/${repo}/issues/${num}`, '-X', 'PATCH', '--input', tmp]))
          : await callHttps('PATCH', `/repos/${repo}/issues/${num}`, { milestone: msNum })
        return res.ok ? { ok: true, number: num, milestone: msNum } : { ok: false, status: res.status, error: res.stderr ?? res.data?.message }
      }
      return makeMcpDelegate('assign_milestone', { repo, number: num, milestone: msNum })
    },
  }
}

export const createIssue = ({ repo, title, body = '', labels = [], client, ...opts } = {}) => (client ?? createGitHubClient(opts)).createIssue({ repo, title, body, labels })
export const listIssues = ({ repo, state = 'open', perPage = 30, client, ...opts } = {}) => (client ?? createGitHubClient(opts)).listIssues({ repo, state, perPage })
export const closeIssue = ({ repo, number, client, ...opts } = {}) => (client ?? createGitHubClient(opts)).closeIssue({ repo, number })
export const closePr = ({ repo, number, comment, labels, dryRun, statePayload, client, ...opts } = {}) => (client ?? createGitHubClient(opts)).closePr({ repo, number, comment, labels, dryRun, statePayload })
export const createLabel = ({ repo, name, color, description, client, ...opts } = {}) => (client ?? createGitHubClient(opts)).createLabel({ repo, name, color, description })
export const listComments = ({ repo, number, perPage = 100, client, ...opts } = {}) => (client ?? createGitHubClient(opts)).listComments({ repo, number, perPage })
export const removeLabel = ({ repo, number, label, client, ...opts } = {}) => (client ?? createGitHubClient(opts)).removeLabel({ repo, number, label })
export const listOpenPrsByHead = ({ repo, headBranch, headOwner, base, client, ...opts } = {}) => (client ?? createGitHubClient(opts)).findOpenPrForBranch(repo, headBranch, { headOwner, base })
