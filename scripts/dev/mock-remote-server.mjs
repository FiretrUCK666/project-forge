/**
 * mock-remote-server.mjs —— 零外网本地 Node HTTP GitHub API 模拟服务端。
 *
 * 严格仅存于 `scripts/dev/`（不入用户包），进程内瞬时启动，支持：
 *   - 真实 `merge_commit_sha` / `mergeCommit` 返回；
 *   - `contributor-fork` 标签 403 只读降级模拟（`simulateLabel403`）；
 *   - 自动建标 + 写后回读（`GET/POST /labels`、`POST /issues/:n/labels`）；
 *   - `closePr`（`PATCH /pulls/:n` `state=closed`）、双协作者认领冲突与 `--takeover`。
 */

import { createServer } from 'node:http'

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' })
  res.end(JSON.stringify(data))
}

function readJsonBody(req) {
  return new Promise((done) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      try { done(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { done({}) }
    })
  })
}

/** 启动零外网本地模拟远端服务端，返回 HTTP 控制句柄与 `createHttpsRequest` 适配器。 */
export function startMockRemoteServer() {
  const state = {
    nextIssue: 1,
    nextPr: 1,
    nextMilestone: 1,
    viewerLogin: 'alice',
    simulateLabel403: false,
    repoLabels: new Map([['in-progress', { name: 'in-progress', color: '0e8a16' }]]),
    issues: new Map(),
    prs: new Map(),
    milestones: new Map(),
    comments: new Map(),
    labels: new Map(),
    apiCalls: [],
  }

  const server = createServer(async (req, res) => {
    const urlObj = new URL(req.url, 'http://127.0.0.1')
    const p = urlObj.pathname
    const body = req.method === 'GET' ? {} : await readJsonBody(req)

    if (p === '/__mock/state' && req.method === 'GET') {
      return json(res, 200, {
        viewerLogin: state.viewerLogin,
        simulateLabel403: state.simulateLabel403,
        repoLabels: [...state.repoLabels.keys()],
        issues: [...state.issues.values()],
        prs: [...state.prs.values()],
        milestones: [...state.milestones.values()],
        comments: Object.fromEntries([...state.comments.entries()]),
        labels: Object.fromEntries([...state.labels.entries()].map(([k, v]) => [k, [...v]])),
        apiCalls: state.apiCalls,
      })
    }
    if (p === '/__mock/config' && req.method === 'POST') {
      if (typeof body.viewerLogin === 'string' && body.viewerLogin.trim()) state.viewerLogin = body.viewerLogin.trim()
      if (body.simulateLabel403 !== undefined) state.simulateLabel403 = Boolean(body.simulateLabel403)
      return json(res, 200, { ok: true, viewerLogin: state.viewerLogin, simulateLabel403: state.simulateLabel403 })
    }

    state.apiCalls.push(`${req.method} ${p}`)
    const actorLogin = String(req.headers['x-mock-actor'] || state.viewerLogin)

    if (p === '/user' && req.method === 'GET') return json(res, 200, { login: actorLogin })
    if (/^\/repos\/[^/]+\/[^/]+$/.test(p) && req.method === 'GET') {
      return json(res, 200, { full_name: p.slice(7), private: false, default_branch: 'main', permissions: { push: true, maintain: true, admin: true } })
    }

    if (/^\/repos\/[^/]+\/[^/]+\/labels$/.test(p)) {
      if (req.method === 'GET') return json(res, 200, [...state.repoLabels.values()])
      if (req.method === 'POST') {
        if (state.simulateLabel403) return json(res, 403, { message: 'Resource not accessible by integration (403)' })
        const lbl = { name: body.name, color: body.color || 'ededed', description: body.description || '' }
        state.repoLabels.set(lbl.name, lbl)
        return json(res, 201, lbl)
      }
    }

    if (/\/milestones$/.test(p)) {
      if (req.method === 'GET') return json(res, 200, [...state.milestones.values()])
      if (req.method === 'POST') {
        const number = state.nextMilestone++
        const ms = { number, title: body.title, description: body.description ?? '', state: 'open' }
        state.milestones.set(number, ms)
        return json(res, 201, ms)
      }
    }

    if (/\/issues$/.test(p)) {
      if (req.method === 'GET') return json(res, 200, [...state.issues.values()])
      if (req.method === 'POST') {
        const number = state.nextIssue++
        const lblSet = new Set(body.labels ?? [])
        for (const l of lblSet) if (!state.repoLabels.has(l)) state.repoLabels.set(l, { name: l, color: 'ededed' })
        const item = {
          number, title: body.title, body: body.body ?? '', state: 'OPEN',
          labels: [...lblSet].map((name) => ({ name })),
          milestone: body.milestone ? (state.milestones.get(Number(body.milestone)) ?? { number: Number(body.milestone) || 1 }) : null,
          url: `https://github.com/acme/mock/issues/${number}`,
          html_url: `https://github.com/acme/mock/issues/${number}`,
        }
        state.issues.set(number, item)
        state.comments.set(number, [])
        state.labels.set(number, lblSet)
        return json(res, 201, item)
      }
    }

    const issMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/.exec(p)
    if (issMatch) {
      const n = Number(issMatch[1])
      const it = state.issues.get(n) || state.prs.get(n)
      if (!it) return json(res, 404, { message: 'Not Found' })
      if (req.method === 'GET') {
        const lbls = [...(state.labels.get(n) ?? [])].map((name) => ({ name }))
        return json(res, 200, { ...it, labels: lbls })
      }
      if (req.method === 'PATCH') {
        if (body.state) it.state = String(body.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
        if (body.body !== undefined) it.body = String(body.body)
        if (body.milestone !== undefined) it.milestone = state.milestones.get(Number(body.milestone)) ?? { number: Number(body.milestone) }
        return json(res, 200, it)
      }
    }

    const cmtMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/.exec(p)
    if (cmtMatch) {
      const n = Number(cmtMatch[1])
      const list = state.comments.get(n) ?? []
      if (req.method === 'GET') return json(res, 200, list)
      if (req.method === 'POST') {
        const entry = {
          id: list.length + 1,
          body: body.body ?? '',
          html_url: `https://github.com/acme/mock/issues/${n}#c${list.length + 1}`,
          user: { login: actorLogin },
          created_at: new Date().toISOString(),
        }
        list.push(entry)
        state.comments.set(n, list)
        return json(res, 201, entry)
      }
    }

    const lblMatch = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels$/.exec(p)
    if (lblMatch) {
      const n = Number(lblMatch[1])
      const set = state.labels.get(n) ?? new Set()
      if (req.method === 'GET') return json(res, 200, [...set].map((name) => ({ name })))
      if (req.method === 'POST') {
        if (state.simulateLabel403) return json(res, 403, { message: 'Forbidden: cannot edit labels on upstream repo (403)' })
        for (const l of body.labels ?? []) {
          set.add(l)
          if (!state.repoLabels.has(l)) state.repoLabels.set(l, { name: l, color: 'ededed' })
        }
        state.labels.set(n, set)
        return json(res, 200, [...set].map((name) => ({ name })))
      }
    }

    const lblDel = /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/labels\/([^/]+)$/.exec(p)
    if (lblDel && req.method === 'DELETE') {
      if (state.simulateLabel403) return json(res, 403, { message: 'Forbidden (403)' })
      const set = state.labels.get(Number(lblDel[1]))
      set?.delete(decodeURIComponent(lblDel[2]))
      return json(res, 200, [...(set ?? [])].map((name) => ({ name })))
    }

    if (/\/pulls$/.test(p)) {
      if (req.method === 'GET') {
        const stFilter = urlObj.searchParams.get('state') ?? 'open'
        const list = [...state.prs.values()].filter((pr) => stFilter === 'all' || pr.state.toLowerCase() === stFilter)
        return json(res, 200, list)
      }
      if (req.method === 'POST') {
        const number = 100 + state.nextPr++
        const pr = {
          number, title: body.title, body: body.body ?? '', state: 'OPEN',
          merged: false, mergedAt: null, merge_commit_sha: null,
          headRefName: body.head, baseRefName: body.base,
          head: { ref: body.head, sha: 'a'.repeat(40) }, base: { ref: body.base },
          url: `https://github.com/acme/mock/pull/${number}`,
          html_url: `https://github.com/acme/mock/pull/${number}`,
          author: { login: actorLogin }, user: { login: actorLogin },
        }
        state.prs.set(number, pr)
        state.comments.set(number, [])
        state.labels.set(number, new Set())
        return json(res, 201, pr)
      }
    }

    const prMatch = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(p)
    if (prMatch) {
      const n = Number(prMatch[1])
      const pr = state.prs.get(n)
      if (!pr) return json(res, 404, { message: 'Not Found' })
      if (req.method === 'GET') {
        const lbls = [...(state.labels.get(n) ?? [])].map((name) => ({ name }))
        return json(res, 200, { ...pr, labels: lbls, mergeCommit: pr.merge_commit_sha ? { oid: pr.merge_commit_sha } : null })
      }
      if (req.method === 'PATCH') {
        if (body.state) pr.state = String(body.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
        if (body.base) pr.baseRefName = body.base
        return json(res, 200, pr)
      }
    }

    const prMerge = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/merge$/.exec(p)
    if (prMerge && req.method === 'PUT') {
      const n = Number(prMerge[1])
      const pr = state.prs.get(n)
      if (!pr) return json(res, 404, { message: 'Not Found' })
      const mergeSha = `deadbeef${String(n).padStart(32, '0')}`
      pr.merged = true
      pr.state = 'MERGED'
      pr.mergedAt = new Date().toISOString()
      pr.merge_commit_sha = mergeSha
      return json(res, 200, { merged: true, sha: mergeSha })
    }

    if (/\/check-runs$/.test(p)) return json(res, 200, { total_count: 1, check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }] })
    if (/\/status$/.test(p)) return json(res, 200, { state: 'success', statuses: [] })
    return json(res, 200, {})
  })

  return new Promise((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.unref()
      const addr = server.address()
      const baseUrl = `http://127.0.0.1:${addr.port}`
      done({
        baseUrl,
        async getState() {
          const r = await fetch(`${baseUrl}/__mock/state`, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(5000) })
          return await r.json()
        },
        async configure(patch) {
          const r = await fetch(`${baseUrl}/__mock/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Connection: 'close' },
            body: JSON.stringify(patch),
            signal: AbortSignal.timeout(5000),
          })
          return await r.json()
        },
        createHttpsRequest(actorHeader = null) {
          return async (method, apiPath, _token, bodyObj) => {
            const headers = { 'Content-Type': 'application/json', Connection: 'close' }
            if (actorHeader) headers['X-Mock-Actor'] = actorHeader
            const r = await fetch(`${baseUrl}${apiPath}`, {
              method,
              headers,
              signal: AbortSignal.timeout(5000),
              ...(bodyObj !== undefined ? { body: JSON.stringify(bodyObj) } : {}),
            })
            const raw = await r.text()
            let data = null
            try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
            return { ok: r.ok, status: r.status, headers: {}, data }
          }
        },
        close() {
          try { server.close() } catch { /* ignore */ }
        },
      })
    })
  })
}
