/**
 * GitHub 平台探测、双轴五态身份判定与 REST/GraphQL 双通道封装。
 *
 * 全程禁交互（`GIT_TERMINAL_PROMPT=0` / `GCM_INTERACTIVE=never` / `BatchMode=yes`），
 * 零第三方依赖，且严禁将任何凭据或令牌写入返回值、磁盘或标准输出。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { githubRepoPath } from '../text.mjs'

export const DEFAULT_PROBE_TIMEOUT_MS = 5000

/** 内存令牌保险箱：按探测结果对象弱引用保存令牌，严禁序列化或暴露到返回值。 */
const TOKEN_VAULT = new WeakMap()

/** 构造禁止一切交互提示的子进程环境变量。 */
export function buildNonInteractiveEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    SSH_ASKPASS_REQUIRE: 'never',
  }
}

/**
 * 归一 GitHub 仓库标识为 `owner/name`；同时兼容完整 URL 与裸 `owner/name`。
 * 认不出返回 `undefined`。
 */
export function normalizeGitHubRepo(value) {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (!s) return undefined
  const fromUrl = githubRepoPath(s)
  if (fromUrl) return fromUrl
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s)
  if (bare && bare[1] !== '.' && bare[1] !== '..') {
    return `${bare[1]}/${bare[2]}`
  }
  return undefined
}

/**
 * 识别单个 Git 远端地址使用的传输协议。
 * @returns {'ssh' | 'https' | 'unknown'}
 */
export function detectRemoteProtocol(url) {
  if (typeof url !== 'string' || !url.trim()) return 'unknown'
  const s = url.trim()
  if (/^https?:\/\//i.test(s)) return 'https'
  if (/^(?:ssh:\/\/|git@)/i.test(s)) return 'ssh'
  if (/^[^/:@\s]+@[^:\s]+:.+/.test(s)) return 'ssh'
  return 'unknown'
}

/**
 * 生成 1-click GitHub Pull Request 创建链接（half-duplex 降级输出）。
 */
export function buildOneClickPrUrl({
  targetRepo,
  baseBranch = 'main',
  headOwner,
  headBranch,
} = {}) {
  const repo = normalizeGitHubRepo(targetRepo)
  if (!repo) return undefined
  const base = encodeURIComponent(baseBranch || 'main')
  if (!headBranch || headBranch === baseBranch || headBranch === 'HEAD') {
    return `https://github.com/${repo}/compare?expand=1`
  }
  const repoOwner = repo.split('/')[0]
  const branchEnc = encodeURIComponent(headBranch)
  const headSpec = headOwner && headOwner.toLowerCase() !== repoOwner.toLowerCase()
    ? `${encodeURIComponent(headOwner)}:${branchEnc}`
    : branchEnc
  return `https://github.com/${repo}/compare/${base}...${headSpec}?expand=1`
}

/**
 * 检查目标仓库是否存在 `.git/pf-local-mode` 强制纯本地标记。
 * 兼容普通仓库与 worktree（`.git` 为指向 `gitdir:` 的文件）。
 */
export function hasLocalOnlyMarker(cwd) {
  if (!cwd) return false
  const dotGit = join(cwd, '.git')
  if (!existsSync(dotGit)) return false
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) {
      return existsSync(join(dotGit, 'pf-local-mode'))
    }
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (!m) return false
      const rawDir = m[1].trim()
      const gitDir = isAbsolute(rawDir) ? rawDir : resolve(cwd, rawDir)
      if (existsSync(join(gitDir, 'pf-local-mode'))) return true
      const commondirFile = join(gitDir, 'commondir')
      if (existsSync(commondirFile)) {
        const relCommon = readFileSync(commondirFile, 'utf8').trim()
        const commonDir = isAbsolute(relCommon) ? relCommon : resolve(gitDir, relCommon)
        if (existsSync(join(commonDir, 'pf-local-mode'))) return true
      }
    }
  } catch {
    return false
  }
  return false
}

function defaultRunCommand(cmd, args, { cwd, env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, input } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      resolvePromise(result)
    }

    let child
    try {
      child = spawn(cmd, args, {
        cwd: cwd || process.cwd(),
        env: buildNonInteractiveEnv(env),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      done({ code: null, stdout: '', stderr: err.message, timedOut: false, errorCode: err.code })
      return
    }

    const outChunks = []
    const errChunks = []
    child.stdout?.on('data', (c) => outChunks.push(c))
    child.stderr?.on('data', (c) => errChunks.push(c))

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      done({
        code: null,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8') || err.message,
        timedOut,
        errorCode: err.code,
      })
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      done({
        code: typeof code === 'number' ? code : null,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
        timedOut,
      })
    })

    if (typeof input === 'string') {
      try {
        child.stdin.write(input)
        child.stdin.end()
      } catch {
        try { child.stdin.end() } catch {}
      }
    } else {
      try { child.stdin.end() } catch {}
    }
  })
}

function defaultHttpsRequest({
  method = 'GET',
  url,
  headers = {},
  body,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const parsed = new URL(url)
    const req = https.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: {
        'User-Agent': 'project-forge',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let data
        try { data = text ? JSON.parse(text) : undefined } catch { data = undefined }
        resolvePromise({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text,
          data,
        })
      })
    })

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('GitHub API 请求超时'), { code: 'ETIMEDOUT' }))
    })
    req.on('error', (err) => rejectPromise(err))

    if (body !== undefined && body !== null) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      req.setHeader('Content-Type', 'application/json; charset=utf-8')
      req.setHeader('Content-Length', Buffer.byteLength(payload, 'utf8'))
      req.write(payload)
    }
    req.end()
  })
}

function parseSshAuthOutput(combined) {
  const m = /Hi\s+([^!\s]+)!\s+You(?:'ve| have)\s+successfully\s+authenticated/i.exec(combined)
  if (m) return { ok: true, login: m[1] }
  if (/permission denied\s*\(publickey\)/i.test(combined)) {
    return { ok: false, kind: 'no-key' }
  }
  if (/could not resolve hostname|connection timed out|operation timed out|connection refused|network is unreachable|no route to host|banner exchange/i.test(combined)) {
    return { ok: false, kind: 'unreachable' }
  }
  return { ok: false, kind: 'unknown' }
}

async function probeSshTransport({ cwd, env, timeoutMs, runner }) {
  const connectSec = Math.max(1, Math.ceil(timeoutMs / 1000))
  const baseArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', `ConnectTimeout=${connectSec}`,
    '-T',
  ]

  const res22 = await runner('ssh', [...baseArgs, 'git@github.com'], { cwd, env, timeoutMs })
  if (res22.errorCode === 'ENOENT') {
    return { state: 'unavailable', port: 22, host: 'github.com', reason: '系统未安装 ssh 客户端' }
  }
  const combined22 = `${res22.stdout}\n${res22.stderr}`
  const parsed22 = parseSshAuthOutput(combined22)
  if (parsed22.ok) {
    return {
      state: 'available',
      port: 22,
      host: 'github.com',
      login: parsed22.login,
      reason: `SSH 端口 22 已就绪（${parsed22.login}）`,
    }
  }
  if (parsed22.kind === 'no-key') {
    return {
      state: 'no-key',
      port: 22,
      host: 'github.com',
      reason: 'SSH 公钥认证被拒绝（Permission denied）',
    }
  }

  // 端口 22 超时或被阻断时自动回退测试 ssh.github.com:443
  if (res22.timedOut || parsed22.kind === 'unreachable' || res22.code !== 0) {
    const res443 = await runner(
      'ssh',
      [...baseArgs, '-p', '443', 'git@ssh.github.com'],
      { cwd, env, timeoutMs },
    )
    const combined443 = `${res443.stdout}\n${res443.stderr}`
    const parsed443 = parseSshAuthOutput(combined443)
    if (parsed443.ok) {
      return {
        state: 'port443-only',
        port: 443,
        host: 'ssh.github.com:443',
        login: parsed443.login,
        reason: `SSH 端口 22 不通，已自动探通 ssh.github.com:443（${parsed443.login}）`,
      }
    }
    if (parsed443.kind === 'no-key') {
      return {
        state: 'no-key',
        port: 443,
        host: 'ssh.github.com:443',
        reason: 'SSH 443 端口可达但公钥认证被拒绝（Permission denied）',
      }
    }
    if (res22.timedOut || res443.timedOut || parsed22.kind === 'unreachable' || parsed443.kind === 'unreachable') {
      return {
        state: 'unreachable',
        port: 22,
        host: 'github.com',
        reason: 'SSH 端口 22 与 443 均不可达或超时',
      }
    }
  }

  return {
    state: 'undetermined',
    port: 22,
    host: 'github.com',
    reason: '未能确认 SSH 认证状态',
  }
}

async function probeHttpsCredential({ cwd, env, repo, timeoutMs, runner }) {
  const inputLines = ['protocol=https', 'host=github.com']
  if (repo) inputLines.push(`path=${repo}.git`)
  inputLines.push('', '')

  const res = await runner('git', ['credential', 'fill'], {
    cwd,
    env,
    timeoutMs,
    input: inputLines.join('\n'),
  })

  if (res.errorCode === 'ENOENT') {
    return { state: 'undetermined', hasToken: false, token: undefined, reason: '系统未安装 git' }
  }
  if (res.timedOut) {
    return { state: 'undetermined', hasToken: false, token: undefined, reason: 'git credential fill 超时' }
  }
  if (res.code !== 0) {
    return { state: 'no-credential', hasToken: false, token: undefined, reason: 'git credential helper 未返回可用凭据' }
  }

  let username
  let password
  for (const rawLine of res.stdout.split(/\r?\n/)) {
    const eq = rawLine.indexOf('=')
    if (eq <= 0) continue
    const k = rawLine.slice(0, eq).trim()
    const v = rawLine.slice(eq + 1)
    if (k === 'username' && v) username = v.trim()
    if (k === 'password' && v) password = v.trim()
  }

  if (!password) {
    return { state: 'no-credential', hasToken: false, token: undefined, reason: 'git credential fill 未返回密码或令牌' }
  }

  const publicUsername = username && !/^(?:x-access-token|oauth2|token|git)$/i.test(username)
    ? username
    : undefined

  return {
    state: 'available',
    hasToken: true,
    username: publicUsername,
    token: password,
    reason: 'HTTPS 凭据助手已返回可用凭据',
  }
}

async function probeGhBridge({ cwd, env, timeoutMs, runner }) {
  const [hostRes, globalRes] = await Promise.all([
    runner('git', ['config', '--get-all', 'credential.https://github.com.helper'], { cwd, env, timeoutMs }),
    runner('git', ['config', '--get-all', 'credential.helper'], { cwd, env, timeoutMs }),
  ])
  const lines = `${hostRes.stdout}\n${globalRes.stdout}`
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
  const configured = lines.some((l) => /\bgh\b.*git-credential/i.test(l))
  return {
    configured,
    reason: configured ? '已配置 gh auth setup-git 桥接' : '未配置 gh auth setup-git 桥接',
  }
}

async function probeGhCliAuth({ cwd, env, timeoutMs, runner }) {
  const res = await runner('gh', ['auth', 'status', '--hostname', 'github.com'], {
    cwd,
    env,
    timeoutMs,
  })
  if (res.errorCode === 'ENOENT') {
    return { installed: false, authenticated: false, reason: '未安装 gh CLI' }
  }
  if (res.timedOut) {
    return { installed: true, authenticated: false, reason: 'gh auth status 超时' }
  }
  const combined = `${res.stdout}\n${res.stderr}`
  if (res.code !== 0) {
    return { installed: true, authenticated: false, reason: 'gh CLI 未登录 GitHub' }
  }
  const userMatch = /Logged in to [^\s]+ account ([^\s(]+)|Logged in to [^\s]+ as ([^\s(]+)/i.exec(combined)
  const login = userMatch ? (userMatch[1] || userMatch[2]) : undefined
  const scopeMatch = /Token scopes:\s*([^\r\n]+)/i.exec(combined)
  const scopes = scopeMatch
    ? scopeMatch[1].replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
    : undefined
  return {
    installed: true,
    authenticated: true,
    login,
    scopes,
    reason: login ? `gh CLI 已登录（${login}）` : 'gh CLI 已登录',
  }
}

function computeProtocolRemediation({
  originUrl,
  originRepo,
  ssh,
  httpsCred,
  ghCli,
  ghBridge,
}) {
  const originProto = detectRemoteProtocol(originUrl)
  const sshWorks = ssh.state === 'available' || ssh.state === 'port443-only'
  const httpsWorks = httpsCred.state === 'available' || (ghCli.authenticated && ghBridge.configured)

  if (!originRepo || originProto === 'unknown') {
    return { mismatch: false, remediationCmd: undefined }
  }

  if (originProto === 'https' && !httpsWorks) {
    if (ssh.state === 'available') {
      return {
        mismatch: true,
        remediationCmd: `git remote set-url origin git@github.com:${originRepo}.git`,
      }
    }
    if (ssh.state === 'port443-only') {
      return {
        mismatch: true,
        remediationCmd: `git remote set-url origin ssh://git@ssh.github.com:443/${originRepo}.git`,
      }
    }
    if (ghCli.authenticated && !ghBridge.configured) {
      return {
        mismatch: false,
        remediationCmd: 'gh auth setup-git',
      }
    }
  }

  if (originProto === 'ssh') {
    const uses443Url = /^ssh:\/\/git@ssh\.github\.com:443\//i.test(originUrl ?? '')
    if (ssh.state === 'port443-only' && !uses443Url) {
      return {
        mismatch: true,
        remediationCmd: `git remote set-url origin ssh://git@ssh.github.com:443/${originRepo}.git`,
      }
    }
    if (!sshWorks && httpsCred.state === 'available') {
      return {
        mismatch: true,
        remediationCmd: `git remote set-url origin https://github.com/${originRepo}.git`,
      }
    }
    if (!sshWorks && ghCli.authenticated) {
      return {
        mismatch: true,
        remediationCmd: ghBridge.configured
          ? `git remote set-url origin https://github.com/${originRepo}.git`
          : `gh auth setup-git && git remote set-url origin https://github.com/${originRepo}.git`,
      }
    }
  }

  return { mismatch: false, remediationCmd: undefined }
}

/**
 * 并发双轨探测本机 GitHub 传输（Track A）与 API 四级降级通道（Track B）。
 */
export async function probeGitHubEnv({
  cwd = process.cwd(),
  remoteUrls = {},
  branch,
  defaultBranch = 'main',
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  mcpAvailable,
  verifyToken = false,
  offline,
  runner = defaultRunCommand,
  httpRequest = defaultHttpsRequest,
  env = process.env,
} = {}) {
  const safeEnv = buildNonInteractiveEnv(env)
  const originUrl = typeof remoteUrls === 'string' ? remoteUrls : remoteUrls?.origin
  const upstreamUrl = typeof remoteUrls === 'object' ? remoteUrls?.upstream : undefined
  const originRepo = normalizeGitHubRepo(originUrl)
  const upstreamRepo = normalizeGitHubRepo(upstreamUrl)
  const targetRepo = upstreamRepo || originRepo

  if (!originUrl && !upstreamUrl) {
    return {
      https: { state: 'n/a', hasToken: false, reason: '没有远端' },
      ssh: { state: 'n/a', reason: '没有远端' },
      ghBridge: { configured: false, reason: '没有远端' },
      originProtocol: 'unknown',
      protocolMismatch: false,
      remediationCmd: undefined,
      apiChannel: {
        tier: 'offline',
        delegateToHostMcp: false,
        reason: '没有远端',
      },
      details: { originRepo: undefined, upstreamRepo: undefined },
    }
  }

  const [ssh, httpsRaw, ghBridge, ghCli] = await Promise.all([
    probeSshTransport({ cwd, env: safeEnv, timeoutMs, runner }),
    probeHttpsCredential({ cwd, env: safeEnv, repo: originRepo || targetRepo, timeoutMs, runner }),
    probeGhBridge({ cwd, env: safeEnv, timeoutMs, runner }),
    probeGhCliAuth({ cwd, env: safeEnv, timeoutMs, runner }),
  ])

  const envToken = (typeof env?.GH_TOKEN === 'string' && env.GH_TOKEN.trim())
    || (typeof env?.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.trim())
    || undefined
  const memoryToken = envToken || httpsRaw.token

  // 对外返回的 https 对象严格脱敏，只保留状态与非涉密公开用户名
  const httpsPublic = {
    state: httpsRaw.state,
    hasToken: httpsRaw.hasToken,
    ...(httpsRaw.username ? { username: httpsRaw.username } : {}),
    reason: httpsRaw.reason,
  }

  const { mismatch, remediationCmd } = computeProtocolRemediation({
    originUrl,
    originRepo,
    ssh,
    httpsCred: httpsPublic,
    ghCli,
    ghBridge,
  })

  const sshWorks = ssh.state === 'available' || ssh.state === 'port443-only'
  const headOwner = originRepo ? originRepo.split('/')[0] : undefined
  const oneClickPrUrl = sshWorks && targetRepo
    ? buildOneClickPrUrl({
        targetRepo,
        baseBranch: defaultBranch || 'main',
        headOwner,
        headBranch: branch,
      })
    : undefined

  let tokenLogin
  let tokenVerified = Boolean(memoryToken)
  let tokenNetworkOffline = false
  if (!ghCli.authenticated && memoryToken && verifyToken) {
    try {
      const resp = await httpRequest({
        method: 'GET',
        url: 'https://api.github.com/user',
        headers: { Authorization: `Bearer ${memoryToken}` },
        timeoutMs,
      })
      if (resp.status >= 200 && resp.status < 300 && resp.data?.login) {
        tokenLogin = resp.data.login
        tokenVerified = true
      } else if (resp.status === 401) {
        tokenVerified = false
      }
    } catch {
      tokenNetworkOffline = true
    }
  }

  let apiChannel
  if (ghCli.authenticated) {
    apiChannel = {
      tier: 'gh-cli',
      login: ghCli.login,
      ...(ghCli.scopes ? { scopes: ghCli.scopes } : {}),
      delegateToHostMcp: false,
      reason: ghCli.reason,
    }
  } else if (memoryToken && tokenVerified && !tokenNetworkOffline) {
    apiChannel = {
      tier: 'node-https-token',
      source: envToken ? 'env' : 'git-credential',
      ...(tokenLogin || httpsPublic.username ? { login: tokenLogin || httpsPublic.username } : {}),
      delegateToHostMcp: false,
      reason: envToken
        ? '已检测到环境变量令牌，使用原生 node:https 客户端调用 GitHub API'
        : '已在内存复用 git credential fill 凭据，使用原生 node:https 客户端调用 GitHub API',
    }
  } else if (offline === true || (ssh.state === 'unreachable' && !mcpAvailable)) {
    apiChannel = {
      tier: 'offline',
      delegateToHostMcp: false,
      reason: '离线或网络不可达，无法访问 GitHub API',
    }
  } else if (mcpAvailable === true) {
    apiChannel = {
      tier: 'mcp-delegate',
      delegateToHostMcp: true,
      ...(oneClickPrUrl ? { oneClickPrUrl } : {}),
      reason: '未配置 gh CLI 与 API 令牌，可委托宿主 GitHub MCP 执行平台操作',
    }
  } else if (sshWorks) {
    apiChannel = {
      tier: 'half-duplex',
      delegateToHostMcp: true,
      oneClickPrUrl,
      reason: '仅 SSH 推送可用且无本地 API 凭据：已生成 1-click PR 链接（若宿主支持 GitHub MCP 亦可代劳）',
    }
  } else {
    apiChannel = {
      tier: 'mcp-delegate',
      delegateToHostMcp: true,
      reason: '未配置本地 GitHub CLI 与 API 令牌，需要由宿主 MCP 代理执行或先完成授权',
    }
  }

  const result = {
    https: httpsPublic,
    ssh,
    ghBridge,
    ghCli: {
      installed: ghCli.installed,
      authenticated: ghCli.authenticated,
      ...(ghCli.login ? { login: ghCli.login } : {}),
      reason: ghCli.reason,
    },
    originProtocol: detectRemoteProtocol(originUrl),
    protocolMismatch: mismatch,
    remediationCmd,
    apiChannel,
    details: {
      originRepo,
      upstreamRepo,
      targetRepo,
      canPushSsh: sshWorks,
      canPushHttps: httpsPublic.state === 'available' || (ghCli.authenticated && ghBridge.configured),
    },
  }

  if (memoryToken && tokenVerified) {
    TOKEN_VAULT.set(result, memoryToken)
  }

  return result
}

function hasWritePerm(probeApi) {
  if (!probeApi || typeof probeApi !== 'object') return false
  if (probeApi.canPush === true || probeApi.pushable === true) return true
  const perm = String(probeApi.viewerPermission ?? '').toUpperCase()
  return perm === 'ADMIN' || perm === 'MAINTAIN' || perm === 'WRITE'
}

function hasReadOnlyPerm(probeApi) {
  if (!probeApi || typeof probeApi !== 'object') return false
  if (probeApi.canPush === false || probeApi.pushable === false) return true
  const perm = String(probeApi.viewerPermission ?? '').toUpperCase()
  return perm === 'READ' || perm === 'TRIAGE' || perm === 'NONE'
}

function extractNoreplyLogin(email) {
  if (typeof email !== 'string') return undefined
  const m = /^(?:\d+\+)?([^@\s]+)@users\.noreply\.github\.com$/i.exec(email.trim())
  return m ? m[1] : undefined
}

function parseAuthorEntry(entry) {
  if (!entry) return { name: '', email: '' }
  if (typeof entry === 'string') {
    const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(entry)
    if (m) return { name: m[1].trim(), email: m[2].trim() }
    const s = entry.trim()
    return s.includes('@') ? { name: '', email: s } : { name: s, email: '' }
  }
  if (typeof entry === 'object') {
    return {
      name: typeof entry.name === 'string' ? entry.name.trim() : '',
      email: typeof entry.email === 'string' ? entry.email.trim() : '',
    }
  }
  return { name: '', email: '' }
}

function matchAuthorsHistory(authors, { userName, userEmail }) {
  const emailLow = typeof userEmail === 'string' ? userEmail.trim().toLowerCase() : ''
  const nameLow = typeof userName === 'string' ? userName.trim().toLowerCase() : ''
  if (!Array.isArray(authors) || authors.length === 0) {
    return { hasHistory: false, anyMatch: false, allMatch: false, matchedCount: 0 }
  }
  let matchedCount = 0
  for (const a of authors) {
    const parsed = parseAuthorEntry(a)
    const ae = parsed.email.toLowerCase()
    const an = parsed.name.toLowerCase()
    const matched = (emailLow && ae && ae === emailLow)
      || (nameLow && an && an === nameLow)
    if (matched) matchedCount += 1
  }
  return {
    hasHistory: true,
    anyMatch: matchedCount > 0,
    allMatch: matchedCount === authors.length,
    matchedCount,
  }
}

/**
 * 纯函数：双轴五态工作区身份判定。
 * 便于单测注入 mocked `probeApi` / `localIdentity` 覆盖全部 5 种角色。
 *
 * 五态：`local-only` | `contributor-fork` | `clone-readonly` | `maintainer` | `undetermined`
 */
const TEAM_PROBE_HINT = '如你是仓库团队或组织协作者且尚未提交过代码，可追加 --probe-auth（或运行 flow.mjs inspect --probe-auth）探测 GitHub 写权限以确认 maintainer'

function classifyWorkspaceIdentityCore({
  gitFacts = {},
  declaredRepo,
  probeApi,
  localIdentity = {},
  localMode = false,
} = {}) {
  if (localMode === true) {
    return { role: 'local-only', reason: '存在 .git/pf-local-mode 标记：按纯本地项目处置' }
  }
  if (gitFacts.present !== true || !gitFacts.remote) {
    return { role: 'local-only', reason: '还没有配置远端仓库：按纯本地工作区处置' }
  }

  const origin = normalizeGitHubRepo(gitFacts.remoteUrls?.origin ?? gitFacts.remote)
  const upstream = normalizeGitHubRepo(gitFacts.remoteUrls?.upstream)
  const declared = normalizeGitHubRepo(declaredRepo)

  if (!origin) {
    return { role: 'undetermined', reason: '远端不是可识别的 GitHub 地址，无法核对归属' }
  }

  const originLow = origin.toLowerCase()
  const originOwnerLow = originLow.split('/')[0]
  const declaredLow = declared?.toLowerCase()
  const upstreamLow = upstream?.toLowerCase()

  const apiWrite = hasWritePerm(probeApi)
  const apiReadOnly = hasReadOnlyPerm(probeApi)
  const apiIsFork = probeApi?.isFork === true
  const apiParent = normalizeGitHubRepo(probeApi?.parent ?? probeApi?.parentRepo)

  const userName = localIdentity.userName ?? gitFacts.userName ?? gitFacts.identity?.name
  const userEmail = localIdentity.userEmail ?? gitFacts.userEmail ?? gitFacts.identity?.email
  const credLogin = probeApi?.login
    || probeApi?.viewerLogin
    || localIdentity.githubLogin
    || gitFacts.auth?.apiChannel?.login
    || gitFacts.auth?.ssh?.login
    || gitFacts.auth?.https?.username
    || extractNoreplyLogin(userEmail)
  const isOwnerByCred = Boolean(credLogin && credLogin.toLowerCase() === originOwnerLow)
  const gitUserMatchesOwner = Boolean(
    typeof userName === 'string'
    && userName.trim()
    && !/\s/.test(userName.trim())
    && userName.trim().toLowerCase() === originOwnerLow,
  )

  const authors = localIdentity.historyAuthors ?? gitFacts.historyAuthors ?? []
  const hist = matchAuthorsHistory(authors, { userName, userEmail })
  const rawCommitCount = gitFacts.commitCount ?? gitFacts.commits
  const hasHistory = (typeof rawCommitCount === 'number' && rawCommitCount > 0) || hist.hasHistory

  // 1. 显式 upstream 指向不同仓库 -> 贡献者 fork 或只读克隆他人 fork
  if (upstreamLow && upstreamLow !== originLow) {
    if (apiReadOnly) {
      return {
        role: 'clone-readonly',
        reason: `upstream 指向 ${upstream}，但对 origin（${origin}）只有只读权限`,
      }
    }
    return {
      role: 'contributor-fork',
      reason: `origin 指向 ${origin}，upstream 指向 ${upstream}`,
    }
  }

  // 2. API 明确判定当前 origin 是某个上游仓库的 fork
  if (apiIsFork) {
    if (apiReadOnly && !isOwnerByCred) {
      return {
        role: 'clone-readonly',
        reason: `origin（${origin}）是他人 fork 且当前账号没有写入权限`,
      }
    }
    if (!declaredLow || !apiParent || apiParent.toLowerCase() === declaredLow || declaredLow !== originLow) {
      return {
        role: 'contributor-fork',
        reason: apiParent
          ? `API 判定 ${origin} 是 ${apiParent} 的 fork`
          : `API 判定 ${origin} 是派生 fork`,
      }
    }
  }

  // 3. 项目声明源仓库与 origin 不同
  if (declaredLow && declaredLow !== originLow) {
    if (apiReadOnly && !isOwnerByCred) {
      return {
        role: 'clone-readonly',
        reason: `源仓库为 ${declared}，且对 origin（${origin}）没有写入权限`,
      }
    }
    return {
      role: 'contributor-fork',
      reason: `项目声明的源仓库是 ${declared}，而 origin 是 ${origin}`,
    }
  }

  // 4. 以下进入 origin === declared 或未声明源仓库场景：严格区分维护者与只读克隆
  if (apiReadOnly) {
    return {
      role: 'clone-readonly',
      reason: `探测到对仓库 ${origin} 仅具备只读权限或不可推送`,
    }
  }

  if (apiWrite) {
    const isTeamCollaborator = Boolean(credLogin && credLogin.toLowerCase() !== originOwnerLow)
    const collaborationScope = isTeamCollaborator ? 'team-collaborator' : 'owner'
    return {
      role: 'maintainer',
      collaborationScope,
      reason: isTeamCollaborator
        ? (declared
            ? `origin 与声明源仓库 ${origin} 一致，且当前账号 ${credLogin} 为同源组织/团队写入协作者`
            : `当前账号 ${credLogin} 对同源仓库 ${origin} 具备组织/团队协作者写入权限`)
        : (declared
            ? `origin 与声明源仓库 ${origin} 一致且具备写入权限`
            : `探测到对仓库 ${origin} 具备写入权限`),
    }
  }

  if (isOwnerByCred) {
    return {
      role: 'maintainer',
      collaborationScope: 'owner',
      reason: `本机认证账号 ${credLogin} 与仓库所属者 ${origin.split('/')[0]} 一致`,
    }
  }

  if (!declaredLow && gitUserMatchesOwner && (!hasHistory || hist.anyMatch)) {
    return {
      role: 'maintainer',
      collaborationScope: 'owner',
      reason: `未声明源仓库，但本机 git user（${userName}）指向自有仓库 ${origin}`,
    }
  }

  if (declaredLow && declaredLow === originLow) {
    if (hist.anyMatch) {
      const isTeamCollaborator = Boolean(credLogin && credLogin.toLowerCase() !== originOwnerLow)
      return {
        role: 'maintainer',
        collaborationScope: isTeamCollaborator ? 'team-collaborator' : 'owner',
        reason: isTeamCollaborator
          ? `origin 与声明源仓库 ${origin} 一致，且提交历史作者与团队协作者（${credLogin}）匹配`
          : `origin 与声明源仓库 ${origin} 一致，且提交历史作者与当前 Git 身份匹配`,
      }
    }
    if (hasHistory && authors.length > 0) {
      return {
        role: 'clone-readonly',
        reason: `origin 与 ${origin} 一致，但历史提交非本机作者且无写权限证明（按只读克隆处置）`,
      }
    }
    return {
      role: 'undetermined',
      reason: `origin 与 ${origin} 一致，但缺少写入权限与提交作者证据，保守按贡献者处置`,
    }
  }

  // 未写 repository 字段时的离线/无写入证明判定
  if (hasHistory && authors.length > 0 && !hist.anyMatch) {
    return {
      role: 'clone-readonly',
      reason: `未声明源仓库，历史提交非本机作者且无写权限，按只读克隆 ${origin} 处置`,
    }
  }

  if (hist.hasHistory && hist.allMatch) {
    const isTeamCollaborator = Boolean(credLogin && credLogin.toLowerCase() !== originOwnerLow)
    return {
      role: 'maintainer',
      collaborationScope: isTeamCollaborator ? 'team-collaborator' : 'owner',
      reason: `未声明源仓库，但全部采样提交均由本机 Git 身份完成`,
    }
  }

  return {
    role: 'undetermined',
    reason: '缺少源仓库声明或仓库写权限证据，无法确认是否为维护者',
  }
}

/**
 * 纯函数：双轴五态工作区身份判定。
 * 便于单测注入 mocked `probeApi` / `localIdentity` 覆盖全部 5 种角色。
 *
 * 五态：`local-only` | `contributor-fork` | `clone-readonly` | `maintainer` | `undetermined`
 */
export function classifyWorkspaceIdentity(opts = {}) {
  const res = classifyWorkspaceIdentityCore(opts)
  if (res.role !== 'clone-readonly' && res.role !== 'undetermined') return res
  const { gitFacts = {}, declaredRepo, probeApi, localMode = false } = opts
  if (localMode === true || gitFacts.present !== true || !gitFacts.remote) return res
  const originLow = normalizeGitHubRepo(gitFacts.remoteUrls?.origin ?? gitFacts.remote)?.toLowerCase()
  if (!originLow) return res
  const upstreamLow = normalizeGitHubRepo(gitFacts.remoteUrls?.upstream)?.toLowerCase()
  if (upstreamLow && upstreamLow !== originLow) return res
  if (probeApi?.isFork === true) return res
  const declaredLow = normalizeGitHubRepo(declaredRepo)?.toLowerCase()
  if (declaredLow && declaredLow !== originLow) return res
  const apiProbed = Boolean(probeApi && (hasWritePerm(probeApi) || hasReadOnlyPerm(probeApi) || probeApi.viewerPermission))
  if (apiProbed) return res
  return { ...res, teamProbeHint: TEAM_PROBE_HINT }
}

/**
 * 解析当前工作区身份（先读 `.git/pf-local-mode`，可选查询 API 权限，再做双轴五态分类）。
 */
export async function resolveWorkspaceIdentity({
  cwd,
  gitFacts = {},
  declaredRepo,
  probeApi,
  probeEnvResult,
  client,
  localIdentity,
  localMode,
  fetchApi = false,
} = {}) {
  const effectiveLocalMode = typeof localMode === 'boolean'
    ? localMode
    : hasLocalOnlyMarker(cwd)

  if (effectiveLocalMode || gitFacts.present !== true || !gitFacts.remote) {
    return classifyWorkspaceIdentity({
      gitFacts,
      declaredRepo,
      probeApi,
      localIdentity,
      localMode: effectiveLocalMode,
    })
  }

  let resolvedProbeApi = probeApi
  if (!resolvedProbeApi && fetchApi) {
    const originRepo = normalizeGitHubRepo(gitFacts.remoteUrls?.origin ?? gitFacts.remote)
    if (originRepo) {
      const ghClient = client || createGitHubClient({ cwd, probeResult: probeEnvResult })
      if (ghClient.channel !== 'none') {
        try {
          resolvedProbeApi = await ghClient.getRepoPermissions(originRepo)
        } catch {
          resolvedProbeApi = undefined
        }
      }
    }
  }

  const effectiveGitFacts = probeEnvResult && !gitFacts.auth
    ? { ...gitFacts, auth: probeEnvResult }
    : gitFacts

  return classifyWorkspaceIdentity({
    gitFacts: effectiveGitFacts,
    declaredRepo,
    probeApi: resolvedProbeApi,
    localIdentity,
    localMode: effectiveLocalMode,
  })
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
    else if (tier === 'mcp-delegate' || tier === 'half-duplex' || tier === 'offline') resolvedChannel = 'none'
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
