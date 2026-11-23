/**
 * platform-probe.mjs —— 双端共享的平台底层只读探针核心（SSH / HTTPS / gh CLI / 令牌验活）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）与 `kit/skills/lib/exec.mjs`。
 * 遵循惰性默认原则：`probeNetwork === false` 或 `PF_NO_REAL_AUTH_PROBE === '1'` 且无自定义 runner 时，
 * 绝不派生 `gh auth status`、`git credential fill`、`ssh` 或联网 `/user` 探测。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import https from 'node:https'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { buildNonInteractiveEnv, execSafe } from './exec.mjs'
import { readTextSafe } from './git-core.mjs'

export const DEFAULT_PROBE_TIMEOUT_MS = 5000
export const SSH_PROBE_TIMEOUT_MS = 2500
export const TEAM_PROBE_HINT = '如你是仓库团队或组织协作者且尚未提交过代码，可追加 --probe-auth（或运行 flow.mjs inspect --probe-auth）探测 GitHub 写权限以确认 maintainer'

/** 内存令牌保险箱：按探测结果对象弱引用保存令牌，严禁序列化或暴露到返回值。 */
export const TOKEN_VAULT = new WeakMap()

const GITHUB_HOST_RE = /^(?:www\.|ssh\.)?github\.com$/i
const SSH_KEY_FILE_RE = /^id_(?:ed25519|ecdsa|rsa|dsa|ecdsa_sk|ed25519_sk)(?:\.pub)?$/i

function resolveTildePath(p, env = process.env) {
  const s = String(p ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (!s) return undefined
  const homeBase = env?.HOME || env?.USERPROFILE || homedir()
  if (s === '~') return homeBase
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homeBase, s.slice(2))
  return isAbsolute(s) ? s : resolve(homeBase, s)
}

/**
 * 只读解析 `~/.ssh/config`，同时提取 `Host -> HostName` 映射与每个别名的 `IdentityFile` 列表。
 * 忽略通配符（`*` / `?` / `!`）与 `Match` 块；同一别名按 OpenSSH 规则先出现者优先。
 */
export function parseSshConfigDetails(input, env = process.env) {
  let text = ''
  const defaultCfgPath = join(env?.HOME || env?.USERPROFILE || homedir(), '.ssh', 'config')
  if (typeof input === 'string') {
    const looksInline = input.includes('\n') || input.includes('\r')
      || /^\s*(?:Host|HostName|User|Port|IdentityFile)\b/im.test(input)
    if (looksInline) {
      text = input
    } else if (input.trim() && existsSync(input.trim())) {
      text = readTextSafe(input.trim(), 256 * 1024) ?? ''
    } else {
      text = input
    }
  } else if (input && typeof input === 'object') {
    if (typeof input.configText === 'string') text = input.configText
    else if (typeof input.text === 'string') text = input.text
    else {
      const cfgPath = input.configPath || input.path || defaultCfgPath
      text = existsSync(cfgPath) ? (readTextSafe(cfgPath, 256 * 1024) ?? '') : ''
    }
  } else {
    text = existsSync(defaultCfgPath) ? (readTextSafe(defaultCfgPath, 256 * 1024) ?? '') : ''
  }

  const hostMap = new Map()
  const identityFiles = new Map()
  let currentHosts = []

  for (const rawLine of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const stripped = rawLine.replace(/(?:^|\s)#.*$/, '').trim()
    if (!stripped) continue
    const m = /^([A-Za-z0-9_-]+)\s*(?:=|\s)\s*(.+)$/.exec(stripped)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'match') {
      currentHosts = []
      continue
    }
    if (key === 'host') {
      currentHosts = val
        .split(/\s+/)
        .map((h) => h.replace(/^['"]|['"]$/g, '').trim())
        .filter((h) => h && !/[*?![\]]/.test(h))
      continue
    }
    if (key === 'hostname' && currentHosts.length > 0) {
      const targetHost = val.replace(/^['"]|['"]$/g, '').trim()
      if (!targetHost) continue
      for (const alias of currentHosts) {
        if (!hostMap.has(alias)) hostMap.set(alias, targetHost)
      }
      continue
    }
    if (key === 'identityfile' && currentHosts.length > 0) {
      const resolvedId = resolveTildePath(val, env)
      if (!resolvedId) continue
      for (const alias of currentHosts) {
        const keyLow = alias.toLowerCase()
        const list = identityFiles.get(keyLow) ?? []
        if (!list.includes(resolvedId)) {
          list.push(resolvedId)
          identityFiles.set(keyLow, list)
        }
      }
    }
  }

  return { hostMap, identityFiles }
}

/** 解析 `~/.ssh/config` Host -> HostName Map。 */
export function parseSshConfigHostMap(input, env = process.env) {
  return parseSshConfigDetails(input, env).hostMap
}

/** 大小写不敏感查找 SSH 别名映射目标主机（同时兼容 `Map` 与普通对象）。 */
export function lookupSshHost(sshHostMap, host) {
  if (!sshHostMap || typeof sshHostMap !== 'object' || !host) return undefined
  const low = String(host).toLowerCase()
  if (sshHostMap instanceof Map) {
    if (sshHostMap.has(host)) return sshHostMap.get(host)
    for (const [k, v] of sshHostMap.entries()) {
      if (String(k).toLowerCase() === low) return v
    }
    return undefined
  }
  if (Object.prototype.hasOwnProperty.call(sshHostMap, host)) return sshHostMap[host]
  for (const [k, v] of Object.entries(sshHostMap)) {
    if (String(k).toLowerCase() === low) return v
  }
  return undefined
}

/** 从远端地址解析传输协议与原始主机。 */
export function parseRemoteUrlHost(value) {
  const s = String(value ?? '').trim()
  if (!s) return { protocol: 'unknown', host: undefined }
  if (/^file:\/\//i.test(s)) return { protocol: 'file', host: undefined }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]+@)?([^/:?#]+)(?::\d+)?(?:\/|$)/i.exec(s)
  if (schemeMatch) {
    const proto = schemeMatch[1].toLowerCase()
    const protocol = proto === 'ssh' ? 'ssh' : (proto === 'http' || proto === 'https' ? 'https' : proto)
    return { protocol, host: schemeMatch[2].toLowerCase() }
  }
  const scpMatch = /^(?:[^/:@\s]+@)?([^/:@\s]+):(.+)$/.exec(s)
  if (scpMatch && !/^[A-Za-z]:\\/.test(s) && !/^[A-Za-z]:\//.test(s)) {
    return { protocol: 'ssh', host: scpMatch[1].toLowerCase() }
  }
  const bareHostMatch = /^([^/\s]+\.[^/\s]+)\/(.+)$/.exec(s)
  if (bareHostMatch) {
    return { protocol: 'unknown', host: bareHostMatch[1].toLowerCase() }
  }
  return { protocol: 'unknown', host: undefined }
}

/** 识别 Git 远端地址传输协议。 */
export function detectRemoteProtocol(url) {
  if (typeof url !== 'string' || !url.trim()) return 'unknown'
  const s = url.trim()
  if (/^https?:\/\//i.test(s)) return 'https'
  if (/^(?:ssh:\/\/|git@)/i.test(s)) return 'ssh'
  if (/^[^/:@\s]+@[^:\s]+:.+/.test(s)) return 'ssh'
  return 'unknown'
}

export function extractHostAndPath(rawUrl) {
  const s = String(rawUrl ?? '').trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      return { host: u.hostname.toLowerCase(), port: u.port || undefined, path: u.pathname.replace(/^\/+/, '') }
    } catch { /* fall through */ }
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(s)
  if (scp && !/^[A-Za-z]:[\\/]/.test(s)) {
    return { host: scp[1].toLowerCase(), path: scp[2].replace(/^\/+/, '') }
  }
  return null
}

/** 提取保留大小写的 GitHub `owner/name`。 */
export function githubRepoFull(value, sshHostMap) {
  const s = String(value ?? '').trim()
  if (!s) return undefined
  const { protocol, host } = parseRemoteUrlHost(s)
  if (host) {
    let effective = host
    if (protocol === 'ssh' && sshHostMap) {
      const mapped = lookupSshHost(sshHostMap, host)
      if (mapped) effective = String(mapped).toLowerCase()
    }
    if (!GITHUB_HOST_RE.test(effective)) return undefined
  } else {
    const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s)
    if (bare && bare[1] !== '.' && bare[1] !== '..') return `${bare[1]}/${bare[2]}`
    return undefined
  }
  const ext = extractHostAndPath(s)
  if (ext) {
    const clean = ext.path.replace(/\.git$/i, '').replace(/\/+$/, '')
    return /^[^/\s]+\/[^/\s]+$/.test(clean) ? clean : undefined
  }
  return undefined
}

/** 归一 GitHub `owner/name` 为小写。 */
export function githubRepoPath(value, sshHostMap) {
  const full = githubRepoFull(value, sshHostMap)
  return full ? full.toLowerCase() : undefined
}

/** 归一 GitHub 仓库标识（兼容完整 URL、SSH 别名及裸 `owner/name`）。 */
export function normalizeGitHubRepo(value, sshHostMap) {
  if (typeof value !== 'string') return undefined
  const s = value.trim()
  if (!s) return undefined
  const fromUrl = githubRepoPath(s, sshHostMap)
  if (fromUrl) return fromUrl
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s)
  if (bare && bare[1] !== '.' && bare[1] !== '..') {
    return `${bare[1]}/${bare[2]}`
  }
  return undefined
}

/** 生成 1-click GitHub Pull Request 创建链接（half-duplex 降级输出）。 */
export function buildOneClickPrUrl({ targetRepo, baseBranch = null, headOwner, headBranch } = {}) {
  const repo = normalizeGitHubRepo(targetRepo)
  if (!repo) return undefined
  if (!headBranch || headBranch === baseBranch || headBranch === 'HEAD') {
    return `https://github.com/${repo}/compare?expand=1`
  }
  const repoOwner = repo.split('/')[0]
  const branchEnc = encodeURIComponent(headBranch)
  const headSpec = headOwner && headOwner.toLowerCase() !== repoOwner.toLowerCase()
    ? `${encodeURIComponent(headOwner)}:${branchEnc}`
    : branchEnc
  if (!baseBranch) {
    return `https://github.com/${repo}/compare/${headSpec}?expand=1`
  }
  const base = encodeURIComponent(baseBranch)
  return `https://github.com/${repo}/compare/${base}...${headSpec}?expand=1`
}

/** 复用 `execSafe` 的跨平台无弹窗 runner，返回统一的 `{ code, stdout, stderr, timedOut, errorCode }`。 */
export async function defaultCommandRunner(cmd, args, { cwd, env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, input } = {}) {
  const res = await execSafe(cmd, args, { cwd, env, timeout: timeoutMs, input })
  return {
    code: res.missing || res.timedOut ? null : res.code,
    stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut,
    ...(res.missing ? { errorCode: 'ENOENT' } : {}),
  }
}

export function defaultHttpsRequest({ method = 'GET', url, headers = {}, body, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false
    const parsed = new URL(url)
    const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined
    const req = https.request({
      protocol: parsed.protocol, hostname: parsed.hostname, port: parsed.port || 443,
      path: `${parsed.pathname}${parsed.search}`, method, timeout: timeoutMs, ...(signal ? { signal } : {}),
      headers: { 'User-Agent': 'project-forge', Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...headers },
    }, (res) => {
      const chunks = []
      res.on('data', (d) => chunks.push(d))
      res.on('end', () => {
        if (settled) return
        settled = true
        const text = Buffer.concat(chunks).toString('utf8')
        let data
        try { data = text ? JSON.parse(text) : undefined } catch { data = undefined }
        resolvePromise({ status: res.statusCode ?? 0, headers: res.headers, text, data })
      })
    })
    req.on('timeout', () => { req.destroy(Object.assign(new Error('GitHub API 请求超时'), { code: 'ETIMEDOUT' })) })
    req.on('error', (err) => { if (!settled) { settled = true; rejectPromise(err) } })
    if (body !== undefined && body !== null) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body)
      req.setHeader('Content-Type', 'application/json; charset=utf-8')
      req.setHeader('Content-Length', Buffer.byteLength(payload, 'utf8'))
      req.write(payload)
    }
    req.end()
  })
}

function scanLocalSshKeyFiles({ env, identityFiles = [] } = {}) {
  const homeBase = env?.HOME || env?.USERPROFILE || homedir()
  const sshDir = homeBase ? join(homeBase, '.ssh') : undefined
  const localKeyFiles = []
  if (sshDir && existsSync(sshDir)) {
    try {
      for (const name of readdirSync(sshDir)) {
        if (SSH_KEY_FILE_RE.test(name)) localKeyFiles.push(name)
      }
    } catch { /* ignore */ }
  }
  const configuredKeys = []
  for (const rawId of identityFiles) {
    const resolved = resolveTildePath(rawId, env)
    if (resolved && existsSync(resolved)) configuredKeys.push(resolved)
  }
  return {
    localKeyFiles: localKeyFiles.sort(),
    configuredKeys,
    hasAnyFile: localKeyFiles.length > 0 || configuredKeys.length > 0,
  }
}

export async function probeSshKeyReadiness({
  cwd,
  env,
  timeoutMs = SSH_PROBE_TIMEOUT_MS,
  runner = defaultCommandRunner,
  identityFiles = [],
} = {}) {
  const files = scanLocalSshKeyFiles({ env, identityFiles })
  const agentRes = await runner('ssh-add', ['-l'], {
    cwd,
    env,
    timeoutMs: Math.min(timeoutMs || 1500, 1500),
  })
  const combinedAgent = `${agentRes.stdout}\n${agentRes.stderr}`
  const agentUnavailable = agentRes.errorCode === 'ENOENT'
    || /could not open a connection|unable to contact|error connecting to agent/i.test(combinedAgent)
  const agentEmpty = /agent has no identities/i.test(combinedAgent)
  const agentLines = agentRes.code === 0 && !agentEmpty
    ? String(agentRes.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : []

  return {
    agentRunning: !agentUnavailable,
    agentHasKeys: agentLines.length > 0,
    agentKeyCount: agentLines.length,
    localKeyFiles: files.localKeyFiles,
    configuredIdentityFiles: files.configuredKeys,
    keyReady: agentLines.length > 0 || files.hasAnyFile,
  }
}

function parseSshAuthOutput(combined) {
  const m = /Hi\s+([^!\s]+)!\s+You(?:'ve| have)\s+successfully\s+authenticated/i.exec(combined)
  if (m) return { ok: true, login: m[1] }
  if (/host key verification failed|are you sure you want to continue connecting/i.test(combined)) {
    return { ok: false, kind: 'host-key-unverified' }
  }
  if (/permission denied\s*\(publickey\)/i.test(combined)) {
    return { ok: false, kind: 'no-key' }
  }
  if (/could not resolve hostname|connection timed out|operation timed out|connection refused|network is unreachable|no route to host|banner exchange/i.test(combined)) {
    return { ok: false, kind: 'unreachable' }
  }
  return { ok: false, kind: 'unknown' }
}

function evaluateSshAttempt(res, { port, host, isFallback, keyStatus }) {
  if (!isFallback && res.errorCode === 'ENOENT') {
    return { state: 'unavailable', available: false, port: 22, host, ...keyStatus, reason: '系统未安装 ssh 客户端' }
  }
  const parsed = parseSshAuthOutput(`${res.stdout}\n${res.stderr}`)
  if (parsed.ok) {
    return {
      state: isFallback ? 'port443-only' : 'available',
      available: true,
      port,
      host,
      login: parsed.login,
      ...keyStatus,
      reason: isFallback ? `SSH 端口 22 不通，已自动探通 ${host}（${parsed.login}）` : `SSH 端口 22 已就绪（${parsed.login}）`,
    }
  }
  if (parsed.kind === 'host-key-unverified') {
    return {
      state: 'host-key-unverified',
      available: false,
      port,
      host,
      ...keyStatus,
      fingerprintCmd: isFallback ? 'ssh -T -p 443 git@ssh.github.com' : `ssh -T git@${host}`,
      reason: `~/.ssh/known_hosts 尚未收录 ${isFallback ? 'ssh.github.com' : host} 指纹（只读模式不自动写盘）` + (isFallback ? '' : '；请人工核对指纹后确认连接'),
    }
  }
  if (parsed.kind === 'no-key') {
    return {
      state: 'no-key',
      available: false,
      port,
      host,
      ...keyStatus,
      reason: isFallback ? 'SSH 443 端口可达但公钥认证被拒绝（Permission denied）' : 'SSH 公钥认证被拒绝（Permission denied）',
    }
  }
  return { parsed }
}

/** 只读探测 SSH 传输通道（强制 `StrictHostKeyChecking=yes`；无本机密钥/agent 且非自定义 runner 时跳过外网连接）。 */
export async function probeSshTransport({
  cwd, env, timeoutMs = SSH_PROBE_TIMEOUT_MS, runner = defaultCommandRunner,
  sshTargetHost = 'github.com', identityFiles = [],
} = {}) {
  const effectiveTimeout = Math.min(Number(timeoutMs) || SSH_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS)
  const connectSec = Math.max(1, Math.min(3, Math.ceil(effectiveTimeout / 1000)))
  const targetHost = sshTargetHost || 'github.com'
  const isCustomRunner = runner !== defaultCommandRunner

  const keyStatus = await probeSshKeyReadiness({ cwd, env, timeoutMs: effectiveTimeout, runner, identityFiles })
  if (!isCustomRunner && !keyStatus.keyReady) {
    return {
      state: 'no-key', available: false, port: 22, host: targetHost, ...keyStatus,
      reason: '未检测到本地 SSH 密钥、IdentityFile 或 ssh-agent 身份（跳过联网握手）',
    }
  }

  const baseArgs = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `ConnectTimeout=${connectSec}`, '-T']
  const res22 = await runner('ssh', [...baseArgs, `git@${targetHost}`], { cwd, env, timeoutMs: effectiveTimeout })
  const ev22 = evaluateSshAttempt(res22, { port: 22, host: targetHost, isFallback: false, keyStatus })
  if (!ev22.parsed) return ev22

  if (res22.timedOut || ev22.parsed.kind === 'unreachable' || res22.code !== 0) {
    const res443 = await runner('ssh', [...baseArgs, '-p', '443', 'git@ssh.github.com'], { cwd, env, timeoutMs: effectiveTimeout })
    const ev443 = evaluateSshAttempt(res443, { port: 443, host: 'ssh.github.com:443', isFallback: true, keyStatus })
    if (!ev443.parsed) return ev443
    if (res22.timedOut || res443.timedOut || ev22.parsed.kind === 'unreachable' || ev443.parsed.kind === 'unreachable') {
      return { state: 'unreachable', available: false, port: 22, host: targetHost, ...keyStatus, reason: 'SSH 端口 22 与 443 均不可达或超时' }
    }
  }

  return { state: 'undetermined', available: false, port: 22, host: targetHost, ...keyStatus, reason: '未能确认 SSH 认证状态' }
}

async function probeHttpsCredential({ cwd, env, repo, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, runner = defaultCommandRunner }) {
  const inputLines = ['protocol=https', 'host=github.com']
  if (repo) inputLines.push(`path=${repo}.git`)
  inputLines.push('', '')

  const hardTimeoutMs = Math.min(Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS)
  const credEnv = { ...(env ?? {}), GIT_ASKPASS: '', SSH_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' }
  const res = await runner('git', ['credential', 'fill'], { cwd, env: credEnv, timeoutMs: hardTimeoutMs, input: inputLines.join('\n') })

  if (res.errorCode === 'ENOENT') return { state: 'undetermined', hasToken: false, token: undefined, reason: '系统未安装 git' }
  if (res.timedOut) return { state: 'undetermined', hasToken: false, token: undefined, reason: 'git credential fill 超时' }
  if (res.code !== 0) return { state: 'no-credential', hasToken: false, token: undefined, reason: 'git credential helper 未返回可用凭据' }

  let username
  let password
  for (const rawLine of String(res.stdout ?? '').split(/\r?\n/)) {
    const eq = rawLine.indexOf('=')
    if (eq <= 0) continue
    const k = rawLine.slice(0, eq).trim()
    const v = rawLine.slice(eq + 1)
    if (k === 'username' && v) username = v.trim()
    if (k === 'password' && v) password = v.trim()
  }
  if (!password) return { state: 'no-credential', hasToken: false, token: undefined, reason: 'git credential fill 未返回密码或令牌' }

  const publicUsername = username && !/^(?:x-access-token|oauth2|token|git)$/i.test(username) ? username : undefined
  return { state: 'available', hasToken: true, username: publicUsername, token: password, reason: 'HTTPS 凭据助手已返回可用凭据' }
}

async function probeGhBridge({ cwd, env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, runner = defaultCommandRunner }) {
  const [hostRes, globalRes] = await Promise.all([
    runner('git', ['config', '--get-all', 'credential.https://github.com.helper'], { cwd, env, timeoutMs }),
    runner('git', ['config', '--get-all', 'credential.helper'], { cwd, env, timeoutMs }),
  ])
  const lines = `${hostRes.stdout}\n${globalRes.stdout}`.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  const configured = lines.some((l) => /\bgh\b.*git-credential/i.test(l))
  return { configured, reason: configured ? '已配置 gh auth setup-git 桥接' : '未配置 gh auth setup-git 桥接' }
}

async function probeGhCliAuth({ cwd, env, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS, runner = defaultCommandRunner }) {
  const res = await runner('gh', ['auth', 'status', '--hostname', 'github.com'], { cwd, env, timeoutMs })
  if (res.errorCode === 'ENOENT') return { installed: false, authenticated: false, reason: '未安装 gh CLI' }
  if (res.timedOut) return { installed: true, authenticated: false, reason: 'gh auth status 超时' }
  const combined = `${res.stdout}\n${res.stderr}`
  if (res.code !== 0) return { installed: true, authenticated: false, reason: 'gh CLI 未登录 GitHub' }
  const userMatch = /Logged in to [^\s]+ account ([^\s(]+)|Logged in to [^\s]+ as ([^\s(]+)/i.exec(combined)
  const login = userMatch ? (userMatch[1] || userMatch[2]) : undefined
  const scopeMatch = /Token scopes:\s*([^\r\n]+)/i.exec(combined)
  const scopes = scopeMatch ? scopeMatch[1].replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean) : undefined
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
  sshTargetHost = 'github.com',
}) {
  const originProto = detectRemoteProtocol(originUrl)
  const sshWorks = ssh.state === 'available' || ssh.state === 'port443-only'
  const httpsWorks = httpsCred.state === 'available' || (ghCli.authenticated && ghBridge.configured)

  if (!originRepo || originProto === 'unknown') return { mismatch: false, remediationCmd: undefined }

  if (originProto === 'https' && !httpsWorks) {
    if (ssh.state === 'available') {
      return { mismatch: true, remediationCmd: `git remote set-url origin git@${sshTargetHost || 'github.com'}:${originRepo}.git` }
    }
    if (ssh.state === 'port443-only') {
      return { mismatch: true, remediationCmd: `git remote set-url origin ssh://git@ssh.github.com:443/${originRepo}.git` }
    }
    if (ghCli.authenticated && !ghBridge.configured) {
      return { mismatch: false, remediationCmd: 'gh auth setup-git' }
    }
  }

  if (originProto === 'ssh') {
    const uses443Url = /^ssh:\/\/git@ssh\.github\.com:443\//i.test(originUrl ?? '')
    if (ssh.state === 'port443-only' && !uses443Url) {
      return { mismatch: true, remediationCmd: `git remote set-url origin ssh://git@ssh.github.com:443/${originRepo}.git` }
    }
    if (!sshWorks && httpsCred.state === 'available') {
      return { mismatch: true, remediationCmd: `git remote set-url origin https://github.com/${originRepo}.git` }
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
 * 惰性双轨平台环境探测核心：仅在显式 `probeNetwork === true`（或测试注入自定义 runner）
 * 且非 `PF_NO_REAL_AUTH_PROBE=1` 时探测外部凭据/SSH；无证据时不虚报 `mcp-delegate`。
 */
export async function probeGitHubEnvCore({
  cwd = process.cwd(),
  remoteUrls = {},
  branch,
  defaultBranch = null,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probeNetwork = false,
  mcpAvailable,
  verifyToken = false,
  offline,
  runner,
  httpRequest = defaultHttpsRequest,
  env = process.env,
  sshHostMap,
  sshDetails,
} = {}) {
  const safeEnv = buildNonInteractiveEnv(env)
  const detailsParsed = sshDetails ?? (sshHostMap === undefined ? parseSshConfigDetails(undefined, safeEnv) : undefined)
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? detailsParsed?.hostMap ?? {})
  const originUrl = typeof remoteUrls === 'string'
    ? remoteUrls
    : (remoteUrls?.origin ?? Object.values(remoteUrls ?? {}).find((v) => typeof v === 'string' && v.trim()))
  const upstreamUrl = typeof remoteUrls === 'object' ? remoteUrls?.upstream : undefined
  const originRepo = normalizeGitHubRepo(originUrl, effectiveHostMap)
  const upstreamRepo = normalizeGitHubRepo(upstreamUrl, effectiveHostMap)
  const targetRepo = upstreamRepo || originRepo

  const parsedOriginHost = originUrl ? parseRemoteUrlHost(originUrl) : { protocol: 'unknown', host: undefined }
  const mappedOriginHost = parsedOriginHost.protocol === 'ssh' && parsedOriginHost.host
    ? lookupSshHost(effectiveHostMap, parsedOriginHost.host)
    : undefined
  const sshTargetHost = (parsedOriginHost.protocol === 'ssh' && mappedOriginHost && /^(?:www\.|ssh\.)?github\.com$/i.test(mappedOriginHost))
    ? parsedOriginHost.host
    : 'github.com'
  const hostIdentityFiles = detailsParsed?.identityFiles?.get(String(sshTargetHost).toLowerCase()) ?? []

  const hasCustomRunner = typeof runner === 'function' && runner !== defaultCommandRunner
  const effectiveRunner = runner ?? defaultCommandRunner
  const disableRealProbe = safeEnv?.PF_NO_REAL_AUTH_PROBE === '1' && !hasCustomRunner
  const shouldProbeExternal = offline !== true && !disableRealProbe && (probeNetwork === true || hasCustomRunner)

  const envToken = (typeof env?.GH_TOKEN === 'string' && env.GH_TOKEN.trim())
    || (typeof env?.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.trim())
    || undefined

  let ssh
  let httpsRaw
  let ghBridge
  let ghCli

  if (!shouldProbeExternal) {
    const localKeys = scanLocalSshKeyFiles({ env: safeEnv, identityFiles: hostIdentityFiles })
    ssh = {
      state: 'unprobed', available: null, port: null, host: sshTargetHost, login: null,
      localKeyFiles: localKeys.localKeyFiles, configuredIdentityFiles: localKeys.configuredKeys,
      keyReady: localKeys.hasAnyFile, reason: offline === true ? '离线模式跳过 SSH 探测' : '惰性模式跳过 SSH 网络探测',
    }
    httpsRaw = {
      state: envToken ? 'available' : 'unprobed', hasToken: Boolean(envToken), token: undefined,
      reason: offline === true ? '离线模式跳过 HTTPS 凭据探测' : '惰性模式跳过 git credential fill',
    }
    ghBridge = { configured: false, reason: '惰性模式未探测 gh 凭据桥接' }
    ghCli = { installed: undefined, authenticated: false, reason: '惰性模式未调用 gh auth status' }
  } else {
    const wantSsh = parsedOriginHost.protocol === 'ssh' || !envToken || !originUrl
    const sshPromise = wantSsh
      ? probeSshTransport({
          cwd, env: safeEnv, timeoutMs: Math.min(Number(timeoutMs) || SSH_PROBE_TIMEOUT_MS, SSH_PROBE_TIMEOUT_MS),
          runner: effectiveRunner, sshTargetHost, identityFiles: hostIdentityFiles,
        })
      : Promise.resolve({ state: 'unprobed', available: null, port: null, host: sshTargetHost, login: null, reason: 'HTTPS 远端已具备环境令牌，跳过 SSH 握手' })
    ;[ssh, httpsRaw, ghBridge, ghCli] = await Promise.all([
      sshPromise,
      probeHttpsCredential({ cwd, env: safeEnv, repo: originRepo || targetRepo, timeoutMs, runner: effectiveRunner }),
      probeGhBridge({ cwd, env: safeEnv, timeoutMs, runner: effectiveRunner }),
      probeGhCliAuth({ cwd, env: safeEnv, timeoutMs, runner: effectiveRunner }),
    ])
  }

  const memoryToken = envToken || httpsRaw.token
  const httpsPublic = {
    state: httpsRaw.state,
    hasToken: httpsRaw.hasToken,
    ...(httpsRaw.username ? { username: httpsRaw.username } : {}),
    reason: httpsRaw.reason,
  }

  let tokenLogin
  let tokenVerified = Boolean(memoryToken)
  let tokenNetworkOffline = false
  let tokenStatus = memoryToken ? 'unverified' : 'absent'
  if (shouldProbeExternal && !ghCli.authenticated && memoryToken && verifyToken === true) {
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
        tokenStatus = 'valid'
      } else if (resp.status === 401 || resp.status === 403 || resp.status >= 400 || !resp.data?.login) {
        tokenVerified = false
        tokenStatus = resp.status === 403 ? 'forbidden' : 'invalid'
        httpsPublic.tokenValid = false
        if (!envToken && httpsRaw.hasToken) {
          httpsPublic.state = 'invalid-credential'
          httpsPublic.hasToken = false
          httpsPublic.reason = `HTTPS 凭据助手返回的令牌已失效或无权访问（HTTP ${resp.status}）`
        }
      }
    } catch {
      tokenNetworkOffline = true
      tokenVerified = false
      tokenStatus = 'network-error'
    }
  }

  const { mismatch, remediationCmd } = computeProtocolRemediation({
    originUrl,
    originRepo,
    ssh,
    httpsCred: httpsPublic,
    ghCli,
    ghBridge,
    sshTargetHost,
  })

  const sshWorks = ssh.state === 'available' || ssh.state === 'port443-only'
  const headOwner = originRepo ? originRepo.split('/')[0] : undefined
  const oneClickPrUrl = sshWorks && targetRepo
    ? buildOneClickPrUrl({
        targetRepo,
        baseBranch: defaultBranch || null,
        headOwner,
        headBranch: branch,
      })
    : undefined

  // 仅当显式确认宿主具备 GitHub MCP 能力时才允许给出 mcp-delegate
  const resolvedMcpAvailable = typeof mcpAvailable === 'boolean'
    ? mcpAvailable
    : (safeEnv?.PF_MCP_GITHUB === '1' || safeEnv?.MCP_GITHUB_AVAILABLE === '1')

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
  } else if (offline === true || tokenNetworkOffline || (ssh.state === 'unreachable' && !resolvedMcpAvailable)) {
    apiChannel = {
      tier: 'offline',
      delegateToHostMcp: false,
      reason: tokenStatus === 'invalid' || tokenStatus === 'forbidden'
        ? '本地令牌已失效且当前网络不可达，无法访问 GitHub API'
        : '离线或网络不可达，无法访问 GitHub API',
    }
  } else if (resolvedMcpAvailable === true) {
    apiChannel = {
      tier: 'mcp-delegate',
      delegateToHostMcp: true,
      ...(oneClickPrUrl ? { oneClickPrUrl } : {}),
      reason: '未配置 gh CLI 与有效 API 令牌，可委托已确认的宿主 GitHub MCP 执行平台操作',
    }
  } else if (sshWorks) {
    apiChannel = {
      tier: 'half-duplex',
      delegateToHostMcp: false,
      ...(oneClickPrUrl ? { oneClickPrUrl } : {}),
      reason: '仅 SSH 推送可用且无本地 API 凭据' + (oneClickPrUrl ? '：已生成 1-click PR 链接' : ''),
    }
  } else {
    apiChannel = {
      tier: 'none',
      delegateToHostMcp: false,
      reason: tokenStatus === 'invalid' || tokenStatus === 'forbidden'
        ? '检测到的 API 令牌已失效或权限不足，且未登录 gh CLI / SSH，请按指引完成认证'
        : (shouldProbeExternal
            ? '未检测到可用的 gh CLI、有效 API 令牌或 SSH 凭据，且未确认宿主 MCP 能力'
            : '惰性模式下仅校验环境变量与本地密钥；未确认宿主 MCP 能力（加 --probe-auth 可显式探测本机凭据）'),
    }
  }

  return {
    originUrl,
    upstreamUrl,
    originRepo,
    upstreamRepo,
    targetRepo,
    sshTargetHost,
    parsedOrigin: parsedOriginHost,
    httpsPublic,
    ssh,
    sshWorks,
    ghBridge,
    ghCli,
    mismatch,
    remediationCmd,
    apiChannel,
    resolvedMcpAvailable,
    tokenStatus,
    memoryToken,
    tokenVerified,
    effectiveLogin: apiChannel.login || ghCli.login || tokenLogin || ssh.login || null,
  }
}
