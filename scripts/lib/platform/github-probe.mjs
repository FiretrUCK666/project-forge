/**
 * github-probe.mjs —— GitHub 双轨非交互只读环境探测（SSH / HTTPS 凭据助手 / gh CLI / Token 验活）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  isMacMetadataName,
  lookupSshHost,
  parseRemoteUrlHost,
  parseSshConfigHostMap,
} from '../text.mjs'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  TOKEN_VAULT,
  buildNonInteractiveEnv,
  buildOneClickPrUrl,
  defaultHttpsRequest,
  defaultRunCommand,
  detectRemoteProtocol,
  normalizeGitHubRepo,
} from './github-client.mjs'

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

async function probeSshKeyReadiness({ cwd, env, timeoutMs, runner }) {
  const agentRes = await runner('ssh-add', ['-l'], {
    cwd,
    env,
    timeoutMs: Math.min(timeoutMs || DEFAULT_PROBE_TIMEOUT_MS, 2000),
  })
  const combinedAgent = `${agentRes.stdout}\n${agentRes.stderr}`
  const agentUnavailable = agentRes.errorCode === 'ENOENT'
    || /could not open a connection|unable to contact|error connecting to agent/i.test(combinedAgent)
  const agentEmpty = /agent has no identities/i.test(combinedAgent)
  const agentLines = agentRes.code === 0 && !agentEmpty
    ? String(agentRes.stdout ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : []

  const homeBase = env?.HOME || env?.USERPROFILE || homedir()
  const sshDir = homeBase ? join(homeBase, '.ssh') : undefined
  const localKeyFiles = []
  if (sshDir && existsSync(sshDir)) {
    try {
      for (const name of readdirSync(sshDir)) {
        if (isMacMetadataName(name)) continue
        if (/^id_(?:ed25519|ecdsa|rsa|dsa|ecdsa_sk|ed25519_sk)(?:\.pub)?$/i.test(name)) {
          localKeyFiles.push(name)
        }
      }
    } catch { /* ignore */ }
  }

  return {
    agentRunning: !agentUnavailable,
    agentHasKeys: agentLines.length > 0,
    agentKeyCount: agentLines.length,
    localKeyFiles: localKeyFiles.sort(),
    keyReady: agentLines.length > 0 || localKeyFiles.length > 0,
  }
}

export async function probeSshTransport({ cwd, env, timeoutMs, runner, sshTargetHost = 'github.com' }) {
  const connectSec = Math.max(1, Math.ceil((timeoutMs || DEFAULT_PROBE_TIMEOUT_MS) / 1000))
  const baseArgs = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `ConnectTimeout=${connectSec}`,
    '-T',
  ]
  const targetHost = sshTargetHost || 'github.com'

  const [keyStatus, res22] = await Promise.all([
    probeSshKeyReadiness({ cwd, env, timeoutMs, runner }),
    runner('ssh', [...baseArgs, `git@${targetHost}`], { cwd, env, timeoutMs }),
  ])

  if (res22.errorCode === 'ENOENT') {
    return { state: 'unavailable', port: 22, host: targetHost, ...keyStatus, reason: '系统未安装 ssh 客户端' }
  }
  const combined22 = `${res22.stdout}\n${res22.stderr}`
  const parsed22 = parseSshAuthOutput(combined22)
  if (parsed22.ok) {
    return {
      state: 'available',
      port: 22,
      host: targetHost,
      login: parsed22.login,
      ...keyStatus,
      reason: `SSH 端口 22 已就绪（${parsed22.login}）`,
    }
  }
  if (parsed22.kind === 'host-key-unverified') {
    return {
      state: 'host-key-unverified',
      port: 22,
      host: targetHost,
      ...keyStatus,
      fingerprintCmd: `ssh -T git@${targetHost}`,
      reason: `~/.ssh/known_hosts 尚未收录 ${targetHost} 指纹（只读模式不自动写盘）；请人工核对指纹后确认连接`,
    }
  }
  if (parsed22.kind === 'no-key') {
    return {
      state: 'no-key',
      port: 22,
      host: targetHost,
      ...keyStatus,
      reason: 'SSH 公钥认证被拒绝（Permission denied）',
    }
  }

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
        ...keyStatus,
        reason: `SSH 端口 22 不通，已自动探通 ssh.github.com:443（${parsed443.login}）`,
      }
    }
    if (parsed443.kind === 'host-key-unverified') {
      return {
        state: 'host-key-unverified',
        port: 443,
        host: 'ssh.github.com:443',
        ...keyStatus,
        fingerprintCmd: 'ssh -T -p 443 git@ssh.github.com',
        reason: '~/.ssh/known_hosts 尚未收录 ssh.github.com 指纹（只读模式不自动写盘）',
      }
    }
    if (parsed443.kind === 'no-key') {
      return {
        state: 'no-key',
        port: 443,
        host: 'ssh.github.com:443',
        ...keyStatus,
        reason: 'SSH 443 端口可达但公钥认证被拒绝（Permission denied）',
      }
    }
    if (res22.timedOut || res443.timedOut || parsed22.kind === 'unreachable' || parsed443.kind === 'unreachable') {
      return {
        state: 'unreachable',
        port: 22,
        host: targetHost,
        ...keyStatus,
        reason: 'SSH 端口 22 与 443 均不可达或超时',
      }
    }
  }

  return {
    state: 'undetermined',
    port: 22,
    host: targetHost,
    ...keyStatus,
    reason: '未能确认 SSH 认证状态',
  }
}

async function probeHttpsCredential({ cwd, env, repo, timeoutMs, runner }) {
  const inputLines = ['protocol=https', 'host=github.com']
  if (repo) inputLines.push(`path=${repo}.git`)
  inputLines.push('', '')

  const hardTimeoutMs = Math.min(Number(timeoutMs) || DEFAULT_PROBE_TIMEOUT_MS, DEFAULT_PROBE_TIMEOUT_MS)
  const res = await runner('git', ['credential', 'fill'], {
    cwd,
    env,
    timeoutMs: hardTimeoutMs,
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
  sshTargetHost = 'github.com',
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
        remediationCmd: `git remote set-url origin git@${sshTargetHost || 'github.com'}:${originRepo}.git`,
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
 * 即使当前目录还没有配置远端（或尚未建库），仍只读探测本机 gh / SSH / 凭据以引导建仓与首推。
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
  sshHostMap,
} = {}) {
  const safeEnv = buildNonInteractiveEnv(env)
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
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

  const [ssh, httpsRaw, ghBridge, ghCli] = await Promise.all([
    probeSshTransport({ cwd, env: safeEnv, timeoutMs, runner, sshTargetHost }),
    probeHttpsCredential({ cwd, env: safeEnv, repo: originRepo || targetRepo, timeoutMs, runner }),
    probeGhBridge({ cwd, env: safeEnv, timeoutMs, runner }),
    probeGhCliAuth({ cwd, env: safeEnv, timeoutMs, runner }),
  ])

  const envToken = (typeof env?.GH_TOKEN === 'string' && env.GH_TOKEN.trim())
    || (typeof env?.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.trim())
    || undefined
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
        baseBranch: defaultBranch || 'main',
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
        : '未检测到可用的 gh CLI、有效 API 令牌或 SSH 凭据，且未确认宿主 MCP 能力',
    }
  }

  const result = {
    probed: true,
    hasRemote: Boolean(originUrl || upstreamUrl),
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
      hasRemote: Boolean(originUrl || upstreamUrl),
      originRepo,
      upstreamRepo,
      targetRepo,
      ...(sshTargetHost !== 'github.com' ? { sshAlias: sshTargetHost } : {}),
      tokenStatus,
      mcpAvailable: resolvedMcpAvailable,
      canPushSsh: sshWorks,
      canPushHttps: (httpsPublic.state === 'available' && httpsPublic.tokenValid !== false)
        || (ghCli.authenticated && ghBridge.configured),
    },
  }

  if (memoryToken && tokenVerified) {
    TOKEN_VAULT.set(result, memoryToken)
  }

  return result
}
