/**
 * e2e-scenarios-stageb.mjs —— 解压 `git archive --format=zip` 黑盒环境下自建本地 HTTP/SSH 模拟远端交错跑通 Scenarios H、I、J。
 */

import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function startMockGitHubHttpServer(sandbox) {
  const srvJs = join(sandbox, 'mock-gh-server.mjs')
  writeFileSync(srvJs, `#!/usr/bin/env node
import { createServer } from 'node:http'

const state = {
  nextIssue: 1,
  nextPr: 1,
  nextMilestone: 1,
  issues: new Map(),
  prs: new Map(),
  milestones: new Map(),
  comments: new Map(),
  labels: new Map(),
  simulateMerge504: false,
  apiCalls: [],
}
const json = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', Connection: 'close' })
  res.end(JSON.stringify(data))
}
const readJsonBody = (req) => new Promise((resolveDone) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    try { resolveDone(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) } catch { resolveDone({}) }
  })
})
const server = createServer(async (req, res) => {
  const urlObj = new URL(req.url, 'http://127.0.0.1')
  const p = urlObj.pathname
  const body = req.method === 'GET' ? {} : await readJsonBody(req)
  if (p === '/__mock/state' && req.method === 'GET') {
    return json(res, 200, {
      issues: [...state.issues.values()],
      prs: [...state.prs.values()],
      milestones: [...state.milestones.values()],
      apiCalls: state.apiCalls,
      simulateMerge504: state.simulateMerge504,
    })
  }
  if (p === '/__mock/config' && req.method === 'POST') {
    if (body.simulateMerge504 !== undefined) state.simulateMerge504 = Boolean(body.simulateMerge504)
    return json(res, 200, { ok: true, simulateMerge504: state.simulateMerge504 })
  }
  state.apiCalls.push(req.method + ' ' + p)

  if (p === '/user' && req.method === 'GET') return json(res, 200, { login: 'alice' })
  if (/^\\/repos\\/[^/]+\\/[^/]+$/.test(p) && req.method === 'GET') return json(res, 200, { full_name: p.slice(7), private: false })

  if (/\\/milestones$/.test(p)) {
    if (req.method === 'GET') return json(res, 200, [...state.milestones.values()])
    if (req.method === 'POST') {
      const number = state.nextMilestone++
      const ms = { number, title: body.title, description: body.description ?? '', state: 'open' }
      state.milestones.set(number, ms)
      return json(res, 201, ms)
    }
  }
  if (/\\/issues$/.test(p)) {
    if (req.method === 'GET') return json(res, 200, [...state.issues.values()])
    if (req.method === 'POST') {
      const number = state.nextIssue++
      const msObj = body.milestone ? ([...state.milestones.values()].find((m) => m.title === body.milestone || m.number === Number(body.milestone)) ?? { number: Number(body.milestone) || 1, title: String(body.milestone) }) : null
      const item = {
        number,
        title: body.title,
        body: body.body ?? '',
        state: 'OPEN',
        labels: (body.labels ?? []).map((name) => ({ name })),
        milestone: msObj,
        url: 'https://github.com/acme/mock/issues/' + number,
        html_url: 'https://github.com/acme/mock/issues/' + number,
      }
      state.issues.set(number, item)
      state.comments.set(number, [])
      state.labels.set(number, new Set(body.labels ?? []))
      return json(res, 201, item)
    }
  }
  const issMatch = /^\\/repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)$/.exec(p)
  if (issMatch) {
    const n = Number(issMatch[1])
    const it = state.issues.get(n)
    if (!it) return json(res, 404, { message: 'Not Found' })
    if (req.method === 'GET') {
      const lbls = [...(state.labels.get(n) ?? [])].map((name) => ({ name }))
      return json(res, 200, { ...it, labels: lbls })
    }
    if (req.method === 'PATCH') {
      if (body.state) it.state = String(body.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
      if (body.milestone !== undefined) {
        it.milestone = state.milestones.get(Number(body.milestone)) ?? { number: Number(body.milestone) }
      }
      return json(res, 200, it)
    }
  }
  const cmtMatch = /^\\/repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/comments$/.exec(p)
  if (cmtMatch) {
    const n = Number(cmtMatch[1])
    const list = state.comments.get(n) ?? []
    if (req.method === 'GET') return json(res, 200, list)
    if (req.method === 'POST') {
      const entry = { id: list.length + 1, body: body.body ?? '', html_url: 'https://github.com/acme/mock/issues/' + n + '#c' + (list.length + 1), user: { login: 'alice' } }
      list.push(entry)
      state.comments.set(n, list)
      return json(res, 201, entry)
    }
  }
  const lblMatch = /^\\/repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/labels$/.exec(p)
  if (lblMatch) {
    const n = Number(lblMatch[1])
    const set = state.labels.get(n) ?? new Set()
    if (req.method === 'GET') return json(res, 200, [...set].map((name) => ({ name })))
    if (req.method === 'POST') {
      for (const l of body.labels ?? []) set.add(l)
      state.labels.set(n, set)
      return json(res, 200, [...set].map((name) => ({ name })))
    }
  }
  const lblDel = /^\\/repos\\/[^/]+\\/[^/]+\\/issues\\/(\\d+)\\/labels\\/([^/]+)$/.exec(p)
  if (lblDel && req.method === 'DELETE') {
    const set = state.labels.get(Number(lblDel[1]))
    set?.delete(decodeURIComponent(lblDel[2]))
    return json(res, 200, [...(set ?? [])].map((name) => ({ name })))
  }
  if (/\\/pulls$/.test(p)) {
    if (req.method === 'GET') {
      const stFilter = urlObj.searchParams.get('state') ?? 'open'
      const list = [...state.prs.values()].filter((pr) => stFilter === 'all' || pr.state.toLowerCase() === stFilter)
      return json(res, 200, list)
    }
    if (req.method === 'POST') {
      const number = state.nextPr++
      const pr = {
        number,
        title: body.title,
        body: body.body ?? '',
        state: 'OPEN',
        merged: false,
        mergedAt: null,
        headRefName: body.head,
        baseRefName: body.base,
        head: { ref: body.head, sha: '0'.repeat(40) },
        base: { ref: body.base },
        url: 'https://github.com/acme/mock/pull/' + number,
        html_url: 'https://github.com/acme/mock/pull/' + number,
        author: { login: 'alice' },
      }
      state.prs.set(number, pr)
      state.comments.set(number, state.comments.get(number) ?? [])
      state.labels.set(number, state.labels.get(number) ?? new Set())
      return json(res, 201, pr)
    }
  }
  const prMatch = /^\\/repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)$/.exec(p)
  if (prMatch) {
    const n = Number(prMatch[1])
    const pr = state.prs.get(n)
    if (!pr) return json(res, 404, { message: 'Not Found' })
    if (req.method === 'GET') return json(res, 200, pr)
    if (req.method === 'PATCH') {
      if (body.base) pr.baseRefName = body.base
      return json(res, 200, pr)
    }
  }
  const prMerge = /^\\/repos\\/[^/]+\\/[^/]+\\/pulls\\/(\\d+)\\/merge$/.exec(p)
  if (prMerge && req.method === 'PUT') {
    const n = Number(prMerge[1])
    const pr = state.prs.get(n)
    if (!pr) return json(res, 404, { message: 'Not Found' })
    pr.merged = true
    pr.state = 'MERGED'
    pr.mergedAt = new Date().toISOString()
    if (state.simulateMerge504) return json(res, 504, { message: 'Gateway Timeout' })
    return json(res, 200, { merged: true, sha: '1'.repeat(40) })
  }
  if (/\\/check-runs$/.test(p)) return json(res, 200, { total_count: 1, check_runs: [{ id: 1, name: 'ci', status: 'completed', conclusion: 'success' }] })
  if (/\\/status$/.test(p)) return json(res, 200, { state: 'success', statuses: [] })
  return json(res, 200, {})
})
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('READY:' + server.address().port + '\\n')
})
`, 'utf8')

  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [srvJs], { cwd: sandbox, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let outBuf = ''
    let errBuf = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error(`Mock GH server startup timeout: ${errBuf}`)) }
    }, 10000)
    child.stdout.on('data', (chunk) => {
      outBuf += String(chunk)
      const m = /READY:(\d+)/.exec(outBuf)
      if (m && !settled) {
        settled = true
        clearTimeout(timer)
        const baseUrl = `http://127.0.0.1:${m[1]}`
        done({
          baseUrl,
          async getState() {
            try {
              const r = await fetch(`${baseUrl}/__mock/state`, { headers: { Connection: 'close' } })
              return await r.json()
            } catch (e) {
              throw new Error(`Mock GH getState failed: ${e.message} | errBuf=${errBuf} | exit=${child.exitCode}`)
            }
          },
          async set504(v) {
            try {
              await fetch(`${baseUrl}/__mock/config`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Connection: 'close' },
                body: JSON.stringify({ simulateMerge504: Boolean(v) }),
              })
            } catch (e) {
              throw new Error(`Mock GH set504 failed: ${e.message} | errBuf=${errBuf} | exit=${child.exitCode}`)
            }
          },
          close() {
            try { child.kill() } catch { /* ignore */ }
          },
        })
      }
    })
    child.stderr.on('data', (chunk) => { errBuf += String(chunk) })
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`Mock GH server exited(${code}): ${errBuf}`)) }
    })
  })
}

function buildMockGhEnv(sandbox, baseUrl) {
  const binDir = join(sandbox, 'mock-bin')
  const isoHome = join(sandbox, 'mock-home')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(isoHome, { recursive: true })
  const ghJs = join(binDir, 'gh-http-cli.mjs')
  writeFileSync(ghJs, `#!/usr/bin/env node
import { readFileSync } from 'node:fs'
const base = process.env.PF_MOCK_GH_URL
const args = process.argv.slice(2)
const argVal = (flag) => {
  const idx = args.indexOf(flag)
  return idx >= 0 ? args[idx + 1] : undefined
}
const readFieldFile = () => {
  const bf = argVal('--body-file')
  if (bf) return readFileSync(bf, 'utf8')
  const inf = argVal('--input')
  if (inf) return readFileSync(inf, 'utf8')
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-F' && args[i + 1]?.startsWith('body=@')) return readFileSync(args[i + 1].slice(6), 'utf8')
  }
  return undefined
}
const repo = argVal('--repo') || 'acme/mock'
async function call(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const txt = await r.text()
  if (!r.ok) { process.stderr.write(txt || ('HTTP ' + r.status)); process.exit(1) }
  return txt ? JSON.parse(txt) : {}
}
if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('Logged in to github.com account alice'); process.exit(0) }
if (args[0] === 'api') {
  const ep = args[1].startsWith('/') ? args[1] : '/' + args[1]
  if (ep === '/user') { const d = await call('GET', '/user'); process.stdout.write(args.includes('--jq') ? d.login : JSON.stringify(d)); process.exit(0) }
  const method = (argVal('-X') || (args.includes('--input') || args.includes('-F') ? 'POST' : 'GET')).toUpperCase()
  const raw = readFieldFile()
  let payload
  if (raw !== undefined) {
    try { payload = JSON.parse(raw) } catch { payload = { body: raw } }
  }
  const d = await call(method, ep, payload)
  process.stdout.write(JSON.stringify(d))
  process.exit(0)
}
if (args[0] === 'issue') {
  if (args[1] === 'create') {
    const labels = []
    for (let i = 0; i < args.length; i++) if (args[i] === '--label') labels.push(args[i + 1])
    const ms = argVal('--milestone')
    const d = await call('POST', '/repos/' + repo + '/issues', { title: argVal('--title'), body: readFieldFile() || argVal('--body') || '', labels, ...(ms ? { milestone: ms } : {}) })
    process.stdout.write(d.url + '\\n'); process.exit(0)
  }
  if (args[1] === 'view') { process.stdout.write(JSON.stringify(await call('GET', '/repos/' + repo + '/issues/' + args[2]))); process.exit(0) }
  if (args[1] === 'list') { process.stdout.write(JSON.stringify(await call('GET', '/repos/' + repo + '/issues'))); process.exit(0) }
  if (args[1] === 'close') { await call('PATCH', '/repos/' + repo + '/issues/' + args[2], { state: 'CLOSED' }); process.exit(0) }
  if (args[1] === 'edit') {
    const add = [], rem = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--add-label') add.push(args[i + 1])
      if (args[i] === '--remove-label') rem.push(args[i + 1])
    }
    if (add.length) await call('POST', '/repos/' + repo + '/issues/' + args[2] + '/labels', { labels: add })
    for (const l of rem) await call('DELETE', '/repos/' + repo + '/issues/' + args[2] + '/labels/' + encodeURIComponent(l))
    process.exit(0)
  }
}
if (args[0] === 'pr') {
  if (args[1] === 'create') {
    const d = await call('POST', '/repos/' + repo + '/pulls', { title: argVal('--title'), body: readFieldFile() || '', head: argVal('--head'), base: argVal('--base') || 'main' })
    process.stdout.write(d.url + '\\n'); process.exit(0)
  }
  if (args[1] === 'view') { process.stdout.write(JSON.stringify(await call('GET', '/repos/' + repo + '/pulls/' + args[2]))); process.exit(0) }
  if (args[1] === 'list') { process.stdout.write(JSON.stringify(await call('GET', '/repos/' + repo + '/pulls?state=' + (argVal('--state') || 'open')))); process.exit(0) }
  if (args[1] === 'edit') {
    const add = [], rem = []
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--add-label') add.push(args[i + 1])
      if (args[i] === '--remove-label') rem.push(args[i + 1])
    }
    if (add.length) await call('POST', '/repos/' + repo + '/issues/' + args[2] + '/labels', { labels: add })
    for (const l of rem) await call('DELETE', '/repos/' + repo + '/issues/' + args[2] + '/labels/' + encodeURIComponent(l))
    const base = argVal('--base')
    if (base) await call('PATCH', '/repos/' + repo + '/pulls/' + args[2], { base })
    process.exit(0)
  }
  if (args[1] === 'merge') { await call('PUT', '/repos/' + repo + '/pulls/' + args[2] + '/merge', {}); process.exit(0) }
}
process.exit(1)
`, 'utf8')
  if (process.platform === 'win32') {
    writeFileSync(join(binDir, 'gh.cmd'), `@echo off\r\n"${process.execPath}" "${ghJs}" %*\r\n`, 'utf8')
  } else {
    const p = join(binDir, 'gh')
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${ghJs}" "$@"\n`, 'utf8')
    chmodSync(p, 0o755)
  }
  const sep = process.platform === 'win32' ? ';' : ':'
  return {
    PF_BACKUP_DIR: join(sandbox, 'backups'),
    PF_MOCK_GH_URL: baseUrl,
    PF_NO_REAL_AUTH_PROBE: '0',
    PATH: `${binDir}${sep}${process.env.PATH ?? process.env.Path ?? ''}`,
    HOME: isoHome,
    USERPROFILE: isoHome,
    XDG_CONFIG_HOME: isoHome,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '',
    SSH_AUTH_SOCK: '',
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
  }
}

async function runScenarioH(pkgRoot, sandbox, baseEnv, mockEnv, mockSrv, helpers) {
  const { assertOk, initGitRepo, recordWithToken, runGit, runNodeScript, writeFiles } = helpers
  const repoH = join(sandbox, 'repo-h')
  initGitRepo(repoH, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# scenario-h\n\nLocal-only then remote migration.\n',
    'package.json': '{"name":"scenario-h","version":"1.0.0","scripts":{"test":"node test/smoke.mjs"}}\n',
    'src/app.mjs': 'export const val = () => 1\n',
    'test/smoke.mjs': "import { val } from '../src/app.mjs'\nif (val() < 1) process.exit(2)\nconsole.log('H_SMOKE_OK')\n",
  })
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoH, '--no-backup'], repoH, baseEnv), 'Scenario H equip')
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'compose-agents.mjs'), [repoH, '--no-backup'], repoH, baseEnv), 'Scenario H compose-agents')
  writeFiles(repoH, {
    'AGENTS.md': readFileSync(join(repoH, 'AGENTS.md'), 'utf8')
      .replace('<运行时端到端冒烟验证命令，或 none>', 'node test/smoke.mjs')
      .replace('<高风险路径前缀或文件，逗号分隔>', 'none')
      .replace('<跨层禁引规则如 src/lib/** -> src/ui/**，逗号分隔或 none>', 'none'),
  })
  runGit(repoH, ['add', '-A'])
  runGit(repoH, ['commit', '-qm', 'chore: forge init'])

  const flowH = join(repoH, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  const revH = join(repoH, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')
  assertOk(runNodeScript(flowH, ['issue', 'create', '--title', '本地起步需求', '--json'], repoH, baseEnv), 'Scenario H local issue')
  if (runGit(repoH, ['status', '--porcelain']).stdout.trim()) throw new Error('Scenario H local issue dirtied git status')

  assertOk(runNodeScript(flowH, ['start', '--task', 'h1', '--case', '2', '--issue', '1', '--implementer', 'alice'], repoH, baseEnv), 'Scenario H h1 start')
  assertOk(runNodeScript(flowH, ['explore', '--task', 'h1'], repoH, baseEnv), 'Scenario H h1 explore')
  const wtH1 = join(repoH, '.worktrees', 'impl-h1')
  writeFiles(wtH1, { 'src/app.mjs': 'export const val = () => 2\n' })
  runGit(wtH1, ['add', '-A'])
  runGit(wtH1, ['commit', '-qm', 'fix: h1 v2'])
  assertOk(runNodeScript(flowH, ['verify', '--task', 'h1', '--mode', 'gate', '--e2e-evidence', 'H_SMOKE_OK val=2'], wtH1, baseEnv), 'Scenario H h1 verify')
  assertOk(runNodeScript(flowH, ['submit', '--task', 'h1', '--agent', 'alice'], wtH1, baseEnv), 'Scenario H h1 submit')
  assertOk(await recordWithToken(flowH, revH, 'h1', repoH, baseEnv, ['--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-h1']), 'Scenario H h1 pass')
  assertOk(runNodeScript(flowH, ['merge', '--task', 'h1'], repoH, baseEnv), 'Scenario H h1 merge')
  assertOk(runNodeScript(flowH, ['cleanup', '--task', 'h1', '--confirm'], repoH, baseEnv), 'Scenario H h1 cleanup')

  assertOk(runNodeScript(flowH, ['issue', 'create', '--title', '待迁移本地单', '--milestone', 'v9-H', '--json'], repoH, baseEnv), 'Scenario H local issue #2')

  // 添加 bare 远端 + HTTP mock GitHub -> create milestone -> migrate -> prefix/labels/milestone -> mergePr 504 alreadyMerged recovery
  const bareH = join(sandbox, 'bare-h.git')
  mkdirSync(bareH, { recursive: true })
  runGit(bareH, ['init', '--bare', '--initial-branch=main'])
  runGit(repoH, ['remote', 'add', 'origin', 'https://github.com/acme/h-repo.git'])
  runGit(repoH, ['config', `url.${bareH.replace(/\\/g, '/')}.pushInsteadOf`, 'https://github.com/acme/h-repo.git'])
  runGit(repoH, ['push', '-u', 'origin', 'main'])

  const msRes = runNodeScript(flowH, ['milestone', 'create', '--title', 'v9-H', '--json'], repoH, mockEnv)
  assertOk(msRes, 'Scenario H milestone create')
  const migRes = runNodeScript(flowH, ['issue', 'migrate', '--json'], repoH, mockEnv)
  assertOk(migRes, 'Scenario H issue migrate')
  const migJson = JSON.parse(migRes.stdout)
  if (!migJson.migrated?.some((m) => m.remoteNumber)) throw new Error(`Scenario H migrate missing remoteNumber: ${migRes.stdout}`)
  const remoteIssNum = migJson.migrated.find((m) => m.remoteNumber).remoteNumber

  const planH = join(repoH, '.agents', 'skills', 'dev-plan', 'scripts', 'doc-plan.mjs')
  assertOk(runNodeScript(planH, ['init', '--kind', 'todo', '--slug', 'h2-remote', '--title', 'H2 Remote', '--issue', String(remoteIssNum), '--owner', 'planner-h2'], repoH, baseEnv), 'Scenario H h2 init todo')
  runGit(repoH, ['add', '-A'])
  runGit(repoH, ['commit', '-qm', 'docs: add h2 todo'])

  assertOk(runNodeScript(flowH, ['start', '--task', 'h2', '--case', '3', '--slug', 'h2-remote', '--issue', String(remoteIssNum), '--implementer', 'alice'], repoH, mockEnv), 'Scenario H h2 start')
  assertOk(runNodeScript(flowH, ['claim', '--task', 'h2', '--agent', 'alice'], repoH, mockEnv), 'Scenario H h2 claim')
  assertOk(runNodeScript(flowH, ['explore', '--task', 'h2'], repoH, mockEnv), 'Scenario H h2 explore')
  const wtH2 = join(repoH, '.worktrees', 'impl-h2')
  writeFiles(wtH2, { 'src/app.mjs': 'export const val = () => 3\n' })
  runGit(wtH2, ['add', '-A'])
  runGit(wtH2, ['commit', '-qm', 'feat: h2 v3'])
  const todoRel = JSON.parse(readFileSync(join(repoH, '.worktrees', '.state', 'tasks', 'h2.json'), 'utf8')).todoFile
  if (todoRel && existsSync(join(wtH2, todoRel))) {
    writeFiles(wtH2, { [todoRel]: readFileSync(join(wtH2, todoRel), 'utf8').replace(/- \[ \]/g, '- [x]') })
    runGit(wtH2, ['add', '-A'])
    runGit(wtH2, ['commit', '-qm', 'docs: check h2 todo'])
    assertOk(runNodeScript(flowH, ['finalize', '--task', 'h2', '--no-tdd'], wtH2, mockEnv), 'Scenario H h2 finalize')
    runGit(wtH2, ['add', '-A'])
    runGit(wtH2, ['commit', '-qm', 'docs: archive h2'])
  }
  assertOk(runNodeScript(flowH, ['verify', '--task', 'h2', '--mode', 'gate', '--e2e-evidence', 'H_SMOKE_OK val=3'], wtH2, mockEnv), 'Scenario H h2 verify')
  assertOk(runNodeScript(flowH, ['submit', '--task', 'h2', '--agent', 'alice'], wtH2, mockEnv), 'Scenario H h2 submit')
  const stAfterSubmit = await mockSrv.getState()
  const createdPr = stAfterSubmit.prs.at(-1)
  if (!createdPr || !createdPr.title.startsWith('feat: ')) throw new Error(`Scenario H PR missing feat: prefix: ${JSON.stringify(createdPr)}`)
  assertOk(await recordWithToken(flowH, revH, 'h2', repoH, mockEnv, ['--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-h2']), 'Scenario H h2 pass')

  await mockSrv.set504(true)
  assertOk(runNodeScript(flowH, ['merge', '--task', 'h2'], repoH, mockEnv), 'Scenario H h2 merge 504->alreadyMerged recovery')
  await mockSrv.set504(false)
  const stAfterMerge = await mockSrv.getState()
  const closedIss = stAfterMerge.issues.find((x) => x.number === remoteIssNum)
  if (closedIss?.state !== 'CLOSED') throw new Error(`Scenario H merge failed to close remote issue: ${JSON.stringify(stAfterMerge.issues)}`)
}

async function runScenarioI(pkgRoot, sandbox, env, helpers) {
  const { assertBlocked, assertOk, initGitRepo, issueTokenFor, recordWithToken, runGit, runNodeScript, writeFiles } = helpers
  const repoI = join(sandbox, 'repo-i')
  initGitRepo(repoI, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# scenario-i\n',
    'AGENTS.md': '# i\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: node test/smoke.mjs\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
    'src/a.mjs': 'export const a = 1\n',
    'src/b.mjs': 'export const b = 1\n',
    'test/smoke.mjs': "console.log('I_SMOKE_OK')\n",
    'docs/prd/261118-master-i-prd.md': '---\nkind: prd\ntitle: "Master I"\nstatus: active\ncreated: 2026-11-18\nupdated: 2026-11-18\nowner: planner-i\nrelated_spec: null\nrelated_todo: null\n---\n\n# Master I\n\n## 五、验收标准\n- [ ] C1: `src/a.mjs` done\n- [ ] C2: `src/b.mjs` done\n',
    'docs/specs/261118-issue1-s1-spec.md': '---\nkind: spec\ntitle: "S1"\nstatus: draft\ntier: L3\ncreated: 2026-11-18\nupdated: 2026-11-18\nissue: 1\nowner: planner-i\napproved: false\nimplemented: false\nplan_critique: pending\nrelated_prd: ../prd/261118-master-i-prd.md\nrelated_todo: ../todo/261118-issue1-s1-todo.md\n---\n\n# SPEC: S1\n\n## 要解决的问题\n- a\n\n## 本期不做\n- b\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [ ] C1: `src/a.mjs` ok\n',
    'docs/todo/261118-issue1-s1-todo.md': '---\nkind: todo\ntitle: "S1"\nstatus: active\ncreated: 2026-11-18\nupdated: 2026-11-18\nissue: 1\nowner: planner-i\napproved: true\ntask_id: s1\nrelated_prd: ../prd/261118-master-i-prd.md\nrelated_spec: ../specs/261118-issue1-s1-spec.md\n---\n\n# Todo: S1\n\n## 验收标准\n- [ ] C1: `src/a.mjs` ok\n\n## 完成后的记录\n**在合并之前写完，随这次改动一起提交。**\n',
    'docs/specs/261118-issue2-s2-spec.md': '---\nkind: spec\ntitle: "S2"\nstatus: approved\ntier: L3\ncreated: 2026-11-18\nupdated: 2026-11-18\nissue: 2\nowner: planner-i\napproved: true\nimplemented: false\nplan_critique: passed\nrelated_prd: ../prd/261118-master-i-prd.md\nrelated_todo: ../todo/261118-issue2-s2-todo.md\n---\n\n# SPEC: S2\n\n## 要解决的问题\n- b\n\n## 本期不做\n- x\n\n## 门型与回滚路径\n- two-way\n\n## 验收标准\n- [x] C2: `src/b.mjs` ok\n\n## 实现说明\n- done\n',
    'docs/todo/261118-issue2-s2-todo.md': '---\nkind: todo\ntitle: "S2"\nstatus: active\ncreated: 2026-11-18\nupdated: 2026-11-18\nissue: 2\nowner: planner-i\napproved: true\ntask_id: s2\nrelated_prd: ../prd/261118-master-i-prd.md\nrelated_spec: ../specs/261118-issue2-s2-spec.md\n---\n\n# Todo: S2\n\n## 验收标准\n- [x] C2: `src/b.mjs` ok\n\n## 完成后的记录\n**在合并之前写完，随这次改动一起提交。**\n',
  })
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoI, '--no-backup'], repoI, env), 'Scenario I equip')
  runGit(repoI, ['add', '-A'])
  runGit(repoI, ['commit', '-qm', 'init repoI'])

  const planI = join(repoI, '.agents', 'skills', 'dev-plan', 'scripts', 'doc-plan.mjs')
  const flowI = join(repoI, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  const revI = join(repoI, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')

  // Critique 双侧锁 + 3 轮硬停损 + override
  assertOk(runNodeScript(planI, ['critique-reject', '--file', 'docs/specs/261118-issue1-s1-spec.md', '--reviewer', 'crit-1', '--findings', 'C1: need clearer boundary'], repoI, env), 'Scenario I critique R1')
  assertBlocked(runNodeScript(planI, ['critique-reject', '--file', 'docs/specs/261118-issue1-s1-spec.md', '--reviewer', 'crit-1', '--findings', 'same'], repoI, env), 'BLOCKED_CRITIQUE_SAME_REVIEWER', 'Scenario I critique same reviewer')
  writeFiles(repoI, { 'docs/specs/261118-issue1-s1-spec.md': `${readFileSync(join(repoI, 'docs/specs/261118-issue1-s1-spec.md'), 'utf8')}\n- rev2\n` })
  assertOk(runNodeScript(planI, ['critique-reject', '--file', 'docs/specs/261118-issue1-s1-spec.md', '--reviewer', 'crit-2', '--findings', 'C1: need boundary 2'], repoI, env), 'Scenario I critique R2')
  writeFiles(repoI, { 'docs/specs/261118-issue1-s1-spec.md': `${readFileSync(join(repoI, 'docs/specs/261118-issue1-s1-spec.md'), 'utf8')}\n- rev3\n` })
  const critStop = runNodeScript(planI, ['critique-reject', '--file', 'docs/specs/261118-issue1-s1-spec.md', '--reviewer', 'crit-3', '--findings', 'C1: stop loss'], repoI, env)
  if (critStop.status !== 4) throw new Error(`Scenario I critique stop-loss expected 4 got ${critStop.status}: ${critStop.stderr}`)
  assertOk(runNodeScript(planI, ['critique-override', '--file', 'docs/specs/261118-issue1-s1-spec.md', '--human-approved', '--reason', 'approved after stop-loss'], repoI, env), 'Scenario I critique override')
  assertOk(runNodeScript(planI, ['approve', '--file', 'docs/specs/261118-issue1-s1-spec.md'], repoI, env), 'Scenario I approve s1')
  runGit(repoI, ['add', '-A'])
  runGit(repoI, ['commit', '-qm', 'docs: approve s1'])

  // low 风险纯文档可选 record 免令牌直合
  assertOk(runNodeScript(flowI, ['start', '--task', 'ilow', '--case', '1', '--slug', 'ilow', '--implementer', 'alice'], repoI, env), 'Scenario I ilow start')
  assertOk(runNodeScript(flowI, ['explore', '--task', 'ilow'], repoI, env), 'Scenario I ilow explore')
  const wtLow = join(repoI, '.worktrees', 'impl-ilow')
  writeFiles(wtLow, { 'README.md': '# scenario-i\n\nUpdated doc.\n' })
  runGit(wtLow, ['add', '-A'])
  runGit(wtLow, ['commit', '-qm', 'docs: update readme'])
  assertOk(runNodeScript(flowI, ['verify', '--task', 'ilow'], wtLow, env), 'Scenario I ilow verify')
  assertOk(runNodeScript(flowI, ['submit', '--task', 'ilow', '--agent', 'alice'], wtLow, env), 'Scenario I ilow submit')
  assertOk(runNodeScript(revI, ['record', '--task', 'ilow', '--verdict', 'pass', '--reviewer-id', 'rev-low', '--evidence', 'doc static ok'], repoI, env), 'Scenario I low optional record')
  assertOk(runNodeScript(flowI, ['merge', '--task', 'ilow'], repoI, env), 'Scenario I ilow merge')
  assertOk(runNodeScript(flowI, ['cleanup', '--task', 'ilow', '--confirm'], repoI, env), 'Scenario I ilow cleanup')

  // Review artifact_baseline + 3 轮停损 + S1 merge
  assertOk(runNodeScript(flowI, ['start', '--task', 's1', '--case', '4', '--spec', 'docs/specs/261118-issue1-s1-spec.md', '--todo', 'docs/todo/261118-issue1-s1-todo.md', '--implementer', 'alice'], repoI, env), 'Scenario I s1 start')
  assertOk(runNodeScript(flowI, ['explore', '--task', 's1'], repoI, env), 'Scenario I s1 explore')
  const wtS1 = join(repoI, '.worktrees', 'impl-s1')
  writeFiles(wtS1, {
    'src/a.mjs': 'export const a = 2\n',
    'docs/specs/261118-issue1-s1-spec.md': readFileSync(join(wtS1, 'docs/specs/261118-issue1-s1-spec.md'), 'utf8').replace('- [ ] C1:', '- [x] C1:'),
    'docs/todo/261118-issue1-s1-todo.md': readFileSync(join(wtS1, 'docs/todo/261118-issue1-s1-todo.md'), 'utf8').replace('- [ ] C1:', '- [x] C1:'),
  })
  runGit(wtS1, ['add', '-A'])
  runGit(wtS1, ['commit', '-qm', 'feat: s1 v1'])
  assertOk(runNodeScript(flowI, ['finalize', '--task', 's1', '--no-tdd'], wtS1, env), 'Scenario I s1 finalize')
  runGit(wtS1, ['add', '-A'])
  runGit(wtS1, ['commit', '-qm', 'docs: finalize s1'])
  assertOk(runNodeScript(flowI, ['verify', '--task', 's1', '--mode', 'gate', '--e2e-evidence', 'I_SMOKE_OK s1'], wtS1, env), 'Scenario I s1 verify')
  assertOk(runNodeScript(flowI, ['submit', '--task', 's1', '--agent', 'alice'], wtS1, env), 'Scenario I s1 submit')
  assertOk(await recordWithToken(flowI, revI, 's1', repoI, env, ['--round', '1', '--verdict', 'changes', '--reviewer-id', 'rev-1', '--must-fix', 'C1: src/a.mjs:1 fix1']), 'Scenario I s1 R1 changes')

  // 无代码变动时 Round 2 拦截 BLOCKED_NO_REWORK_CHANGES
  assertOk(runNodeScript(flowI, ['rework', '--task', 's1'], wtS1, env), 'Scenario I s1 r2 rework')
  writeFiles(wtS1, { 'src/a.mjs': 'export const a = 3\n' })
  runGit(wtS1, ['add', '-A'])
  runGit(wtS1, ['commit', '-qm', 'fix: s1 r2'])
  assertOk(runNodeScript(flowI, ['finalize', '--task', 's1', '--no-tdd'], wtS1, env), 'Scenario I s1 r2 finalize')
  assertOk(runNodeScript(flowI, ['verify', '--task', 's1', '--mode', 'gate', '--e2e-evidence', 'I_SMOKE_OK r2'], wtS1, env), 'Scenario I s1 r2 verify')
  assertOk(runNodeScript(flowI, ['submit', '--task', 's1', '--agent', 'alice', '--rework'], wtS1, env), 'Scenario I s1 r2 submit')
  const tR2 = await issueTokenFor(repoI, 's1', 2)
  assertBlocked(runNodeScript(revI, ['record', '--task', 's1', '--round', '2', '--verdict', 'changes', '--reviewer-id', 'rev-1', '--review-token', tR2, '--evidence', 'ok', '--must-fix', 'C1: src/a.mjs:1 same'], repoI, env), 'BLOCKED_SAME_REVIEWER_REREVIEW', 'Scenario I same reviewer R2')
  assertOk(runNodeScript(revI, ['record', '--task', 's1', '--round', '2', '--verdict', 'changes', '--reviewer-id', 'rev-2', '--review-token', tR2, '--evidence', 'ok', '--must-fix', 'C2: src/a.mjs:1 fix2'], repoI, env), 'Scenario I s1 R2 changes')

  assertOk(runNodeScript(flowI, ['rework', '--task', 's1'], wtS1, env), 'Scenario I s1 r3 rework')
  writeFiles(wtS1, { 'src/a.mjs': 'export const a = 4\n' })
  runGit(wtS1, ['add', '-A'])
  runGit(wtS1, ['commit', '-qm', 'fix: s1 r3'])
  assertOk(runNodeScript(flowI, ['finalize', '--task', 's1', '--no-tdd'], wtS1, env), 'Scenario I s1 r3 finalize')
  assertOk(runNodeScript(flowI, ['verify', '--task', 's1', '--mode', 'gate', '--e2e-evidence', 'I_SMOKE_OK r3'], wtS1, env), 'Scenario I s1 r3 verify')
  assertOk(runNodeScript(flowI, ['submit', '--task', 's1', '--agent', 'alice', '--rework'], wtS1, env), 'Scenario I s1 r3 submit')
  const tR3 = await issueTokenFor(repoI, 's1', 3)
  const stopR3 = runNodeScript(revI, ['record', '--task', 's1', '--round', '3', '--verdict', 'changes', '--reviewer-id', 'rev-3', '--review-token', tR3, '--evidence', 'ok', '--must-fix', 'C3: src/a.mjs:1 fix3'], repoI, env)
  if (stopR3.status !== 4) throw new Error(`Scenario I R3 stop-loss expected 4 got ${stopR3.status}`)
  assertOk(runNodeScript(revI, ['override', '--task', 's1', '--human-approved', '--reason', 'human resolved stop-loss'], repoI, env), 'Scenario I s1 override')
  assertOk(runNodeScript(flowI, ['merge', '--task', 's1', '--human-approved', '--reason', 'approved override'], repoI, env), 'Scenario I s1 merge')
  assertOk(runNodeScript(flowI, ['cleanup', '--task', 's1', '--confirm'], repoI, env), 'Scenario I s1 cleanup')

  // 最后一片 s2 免 --include-master-prd 自动归档总控 PRD
  assertOk(runNodeScript(flowI, ['start', '--task', 's2', '--case', '4', '--spec', 'docs/specs/261118-issue2-s2-spec.md', '--todo', 'docs/todo/261118-issue2-s2-todo.md', '--implementer', 'alice'], repoI, env), 'Scenario I s2 start')
  assertOk(runNodeScript(flowI, ['explore', '--task', 's2'], repoI, env), 'Scenario I s2 explore')
  const wtS2 = join(repoI, '.worktrees', 'impl-s2')
  writeFiles(wtS2, {
    'src/b.mjs': 'export const b = 2\n',
    'docs/prd/261118-master-i-prd.md': readFileSync(join(wtS2, 'docs/prd/261118-master-i-prd.md'), 'utf8').replace(/- \[ \]/g, '- [x]'),
  })
  runGit(wtS2, ['add', '-A'])
  runGit(wtS2, ['commit', '-qm', 'feat: s2 close master prd'])
  assertOk(runNodeScript(flowI, ['finalize', '--task', 's2', '--no-tdd', '--strict-sync'], wtS2, env), 'Scenario I s2 auto-close master PRD without flag')
  if (existsSync(join(wtS2, 'docs/prd/261118-master-i-prd.md')) || !existsSync(join(wtS2, 'docs/archive/prd/261118-master-i-prd.md'))) {
    throw new Error('Scenario I last slice did not auto-archive master PRD without --include-master-prd')
  }
}

async function runScenarioJ(pkgRoot, sandbox, env, helpers) {
  const { assertOk, initGitRepo, recordWithToken, runGit, runNodeScript, writeFiles } = helpers
  const pkgRootJ = join(sandbox, 'pkg-j-upgraded')
  cpSync(pkgRoot, pkgRootJ, { recursive: true })
  writeFiles(pkgRootJ, {
    'kit/skills/dev-demo/SKILL.md': '---\nname: dev-demo\ndescription: Dynamic 6th skill smoke test.\nmetadata:\n  tier: full\n  order: 60\n  intent: 演练第6技能\n---\n\n# dev-demo\n',
  })

  const bareJ = join(sandbox, 'bare-j.git')
  mkdirSync(bareJ, { recursive: true })
  runGit(bareJ, ['init', '--bare', '--initial-branch=main'])

  const repoJ = join(sandbox, 'repo-j')
  initGitRepo(repoJ, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# polyglot-j\n',
    'package.json': '{"name":"polyglot-j","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'pyproject.toml': '[project]\nname = "polyglot-py"\nversion = "0.1.0"\n[project.scripts]\nworker = "app:main"\n',
    'cmd/api/main.go': 'package main\nfunc main() {}\n',
    'cmd/AGENTS.md': '# Subdir Contract\n',
    'e2e/package.json': '{"name":"j-e2e","scripts":{"test":"echo e2e"}}\n',
    'docs/specs/external-rfc.md': '# External RFC\n\nPreserve me untouched.\n',
    'skills/team-release/SKILL.md': '---\nname: team-release\ndescription: Custom release skill.\n---\n# team-release\n',
    'scripts/custom.mjs': 'export const custom = 1\n',
    'src/app.mjs': 'export const ok = false\n',
    'test/smoke.mjs': "import { ok } from '../src/app.mjs'\nif (!ok) { console.error('err token=ghp_1234567890abcdef1234567890abcdef12'); process.exit(2) }\nconsole.log('J_SMOKE_OK')\n",
  })
  runGit(repoJ, ['remote', 'add', 'origin', bareJ])
  runGit(repoJ, ['push', '-u', 'origin', 'main'])

  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoJ, '--no-backup'], repoJ, env), 'Scenario J equip base')
  assertOk(runNodeScript(join(pkgRootJ, 'scripts', 'equip.mjs'), [repoJ, '--with-hooks', '--no-backup'], repoJ, env), 'Scenario J equip upgraded + hooks')
  assertOk(runNodeScript(join(pkgRootJ, 'scripts', 'compose-agents.mjs'), [repoJ, '--no-backup'], repoJ, env), 'Scenario J compose-agents')

  if (!existsSync(join(repoJ, '.agents/skills/dev-demo/SKILL.md'))) throw new Error('Scenario J missing dynamic 6th skill dev-demo')
  if (!readFileSync(join(repoJ, 'docs/specs/external-rfc.md'), 'utf8').includes('Preserve me untouched')) throw new Error('Scenario J altered foreign doc')
  const agJ = readFileSync(join(repoJ, 'AGENTS.md'), 'utf8')
  if (!agJ.includes('team-release') || !agJ.includes('cmd/AGENTS.md')) throw new Error('Scenario J lost custom skill or subdir AGENTS.md')

  writeFiles(repoJ, {
    'AGENTS.md': agJ
      .replace('<运行时端到端冒烟验证命令，或 none>', 'node test/smoke.mjs')
      .replace('<高风险路径前缀或文件，逗号分隔>', 'none')
      .replace('<跨层禁引规则如 src/lib/** -> src/ui/**，逗号分隔或 none>', 'none'),
  })
  runGit(repoJ, ['add', '-A'])
  runGit(repoJ, ['commit', '-qm', 'chore: init j'])

  // .githooks/pre-push 拦直推 main、放行删远端分支
  runGit(repoJ, ['checkout', '-qb', 'feat/hook-del'])
  runGit(repoJ, ['push', '-u', 'origin', 'feat/hook-del'])
  runGit(repoJ, ['checkout', '-q', 'main'])
  const pushMainFail = runNodeScript(join(repoJ, '.githooks/pre-push'), ['origin', bareJ], repoJ, env)
  // 用真实 git push 验预推拦截与删分支放行
  try {
    runGit(repoJ, ['commit', '--allow-empty', '-qm', 'direct push blocked'])
    let directBlocked = false
    try { runGit(repoJ, ['push', 'origin', 'main']) } catch { directBlocked = true }
    if (!directBlocked) throw new Error('Scenario J pre-push failed to block direct push to main')
    runGit(repoJ, ['reset', '--hard', 'HEAD~1'])
    runGit(repoJ, ['push', 'origin', '--delete', 'feat/hook-del'])
  } finally { void pushMainFail }

  // 真实非零 E2E 失败 -> 脱敏诊断包 + 建单 -> 修复后复绿并解锁 --include-diff -> generic-git --remote-merged merge
  const flowJ = join(repoJ, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  const revJ = join(repoJ, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')
  assertOk(runNodeScript(flowJ, ['start', '--task', 'j1', '--case', '2', '--slug', 'j1', '--implementer', 'alice'], repoJ, env), 'Scenario J start')
  assertOk(runNodeScript(flowJ, ['explore', '--task', 'j1'], repoJ, env), 'Scenario J explore')
  const wtJ = join(repoJ, '.worktrees', 'impl-j1')
  writeFiles(wtJ, { 'src/app.mjs': 'export const ok = false\nexport const extra = 1\n' })
  runGit(wtJ, ['add', '-A'])
  runGit(wtJ, ['commit', '-qm', 'wip: broken smoke'])
  const failVerify = runNodeScript(flowJ, ['verify', '--task', 'j1', '--mode', 'smoke', '--json'], wtJ, env)
  if (failVerify.status === 0) throw new Error('Scenario J broken smoke unexpectedly passed')
  const failObj = JSON.parse(failVerify.stdout)
  if (!failObj.diagnostic?.Evidence?.length || !failObj.escalatedIssue?.ok || JSON.stringify(failObj.diagnostic).includes('ghp_1234')) {
    throw new Error(`Scenario J failed diagnostic/redaction/escalation: ${failVerify.stdout}`)
  }

  writeFiles(wtJ, { 'src/app.mjs': 'export const ok = true\nexport const extra = 2\n' })
  runGit(wtJ, ['add', '-A'])
  runGit(wtJ, ['commit', '-qm', 'fix: j smoke green'])
  assertOk(runNodeScript(flowJ, ['verify', '--task', 'j1', '--mode', 'gate', '--e2e-evidence', 'J_SMOKE_OK exit=0'], wtJ, env), 'Scenario J verify fixed')
  assertOk(runNodeScript(flowJ, ['submit', '--task', 'j1', '--agent', 'alice'], wtJ, env), 'Scenario J submit')
  assertOk(await recordWithToken(flowJ, revJ, 'j1', repoJ, env, ['--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-j']), 'Scenario J pass')
  assertOk(runNodeScript(flowJ, ['merge', '--task', 'j1', '--remote-merged'], repoJ, env), 'Scenario J generic-git merge')
}

export async function runStageBScenarios(pkgRoot, sandbox, env, helpers) {
  const mockSrv = await startMockGitHubHttpServer(sandbox)
  const mockEnv = buildMockGhEnv(sandbox, mockSrv.baseUrl)
  try {
    await runScenarioH(pkgRoot, sandbox, env, mockEnv, mockSrv, helpers)
    await runScenarioI(pkgRoot, sandbox, env, helpers)
    await runScenarioJ(pkgRoot, sandbox, env, helpers)
  } finally {
    mockSrv.close()
  }
}
