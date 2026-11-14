/**
 * platform.mjs —— 与主引擎对齐的平台注册契约、SSH 别名解析、多远端拓扑与五态身份判定。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），产品层注册表仅注册 GitHub 适配器，
 * 未匹配已知主机的远端退化为 `generic-git` 安全放行本地研发全流转。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import { execSafe, readJsonSafe, readTextSafe } from './git.mjs'
import {
  createGitHubClient, createIssue, githubHttpsRequest, isInternalAgentSlug,
  listComments, parseBodyRelations, parseFlowInputs, parseIssueNumbers,
  parsePfStateTags, parsePrNumber, removeLabel, resolveContributorIdentity,
} from './github-client.mjs'

export {
  createGitHubClient, createIssue, githubHttpsRequest, isInternalAgentSlug,
  listComments, parseBodyRelations, parseFlowInputs, parseIssueNumbers,
  parsePfStateTags, parsePrNumber, removeLabel, resolveContributorIdentity,
}

export const DEFAULT_PROBE_TIMEOUT_MS = 5000

export const GENERIC_GIT_PROVIDER = Object.freeze({
  id: 'generic-git',
  label: 'Generic Git Remote',
  capabilities: Object.freeze({ api: false, pr: false, issues: false, releases: false, labels: false }),
})

const PROVIDER_REGISTRY = new Map()

function stripProtocolAndAuth(rawUrl) {
  let s = String(rawUrl ?? '').trim()
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  s = s.replace(/^[^@/]*@/, '')
  return s
}

function extractHostAndPath(rawUrl) {
  const s = String(rawUrl ?? '').trim()
  if (!s) return null
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    try {
      const u = new URL(s)
      return { host: u.hostname.toLowerCase(), port: u.port || undefined, path: u.pathname.replace(/^\/+/, '') }
    } catch { /* fall through */ }
  }
  const scp = /^(?:[^@\s]+@)?([^:/\s]+):(.+)$/.exec(s)
  if (scp && !/^[A-Za-z]:\\/.test(s)) {
    return { host: scp[1].toLowerCase(), path: scp[2].replace(/^\/+/, '') }
  }
  return null
}

/** 只读解析 `~/.ssh/config` 中的 `Host -> HostName` 映射，识别 SSH 多账号别名。 */
export function parseSshConfigHostMap(sshConfigPath = join(homedir(), '.ssh', 'config')) {
  const map = new Map()
  const text = readTextSafe(sshConfigPath)
  if (!text) return map
  let currentHosts = []
  for (const rawLine of text.split('\n')) {
    const clean = rawLine.replace(/#.*$/, '').trim()
    if (!clean) continue
    const hm = /^Host\s+(.+)$/i.exec(clean)
    if (hm) {
      currentHosts = hm[1].trim().split(/\s+/).filter((h) => h && !/[*?]/.test(h)).map((h) => h.toLowerCase())
      continue
    }
    const nm = /^HostName\s+(\S+)$/i.exec(clean)
    if (nm && currentHosts.length > 0) {
      const target = nm[1].trim().toLowerCase()
      for (const alias of currentHosts) map.set(alias, target)
    }
  }
  return map
}

function resolveEffectiveHost(host, sshHostMap) {
  const h = String(host ?? '').toLowerCase()
  if (!h) return ''
  if (sshHostMap instanceof Map && sshHostMap.has(h)) return sshHostMap.get(h)
  if (sshHostMap && typeof sshHostMap === 'object' && sshHostMap[h]) return String(sshHostMap[h]).toLowerCase()
  return h
}

function normalizeGitHubRepoWithMap(value, sshHostMap) {
  const s = String(value ?? '').trim()
  if (!s) return undefined
  const extracted = extractHostAndPath(s)
  if (extracted) {
    const effective = resolveEffectiveHost(extracted.host, sshHostMap)
    if (effective !== 'github.com' && effective !== 'www.github.com' && effective !== 'ssh.github.com') {
      return undefined
    }
    const repoPart = extracted.path.replace(/\.git$/i, '').replace(/\/+$/, '')
    return /^[^/\s]+\/[^/\s]+$/.test(repoPart) ? repoPart : undefined
  }
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s)
  if (bare && bare[1] !== '.' && bare[1] !== '..') return `${bare[1]}/${bare[2]}`
  return undefined
}

const GITHUB_PROVIDER = Object.freeze({
  id: 'github',
  label: 'GitHub',
  capabilities: Object.freeze({ api: true, pr: true, issues: true, releases: true, labels: true }),
  matchRemote(remoteUrl, sshHostMap) {
    const ext = extractHostAndPath(remoteUrl)
    if (!ext) return false
    const effective = resolveEffectiveHost(ext.host, sshHostMap)
    return effective === 'github.com' || effective === 'www.github.com' || effective === 'ssh.github.com'
  },
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeGitHubRepoWithMap(remoteUrl, sshHostMap)
  },
})

/** 注册平台适配器。 */
export function registerHostingProvider(provider) {
  if (!provider || typeof provider.id !== 'string') throw new Error('HostingProvider 必须包含有效 id')
  PROVIDER_REGISTRY.set(provider.id, provider)
}

export function getHostingProvider(id) {
  return PROVIDER_REGISTRY.get(id) ?? (id === 'generic-git' ? GENERIC_GIT_PROVIDER : undefined)
}

export function listHostingProviders() {
  return [...PROVIDER_REGISTRY.values()]
}

registerHostingProvider(GITHUB_PROVIDER)

/** 解析单个远端地址的适配归属（命中已注册适配器或安全退化为 generic-git）。 */
export function resolveRemoteDescriptor(remoteUrl, sshHostMap = parseSshConfigHostMap()) {
  const raw = String(remoteUrl ?? '').trim()
  if (!raw) return { url: raw, providerId: 'none', repoSlug: undefined, capabilities: GENERIC_GIT_PROVIDER.capabilities }
  const isLocal = /^file:\/\//i.test(raw) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && !/^[^@/]+@[^:]+:/i.test(raw))
  if (isLocal) {
    return { url: raw, providerId: 'generic-git', isLocal: true, repoSlug: undefined, capabilities: GENERIC_GIT_PROVIDER.capabilities }
  }
  for (const provider of PROVIDER_REGISTRY.values()) {
    if (provider.matchRemote(raw, sshHostMap)) {
      return {
        url: raw,
        providerId: provider.id,
        repoSlug: provider.normalizeRepo(raw, sshHostMap),
        capabilities: provider.capabilities,
      }
    }
  }
  const ext = extractHostAndPath(raw)
  return {
    url: raw,
    providerId: 'generic-git',
    host: ext?.host,
    repoSlug: ext?.path?.replace(/\.git$/i, '').replace(/\/+$/, ''),
    capabilities: GENERIC_GIT_PROVIDER.capabilities,
  }
}

/** 兼容旧版远端 URL 映射视图（origin / upstream -> fetchUrl）。 */
export function parseRemoteUrls(remoteOutput) {
  const urls = {}
  for (const line of String(remoteOutput ?? '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    if (m) urls[m[1]] = m[2]
  }
  return urls
}

/** 解析多远端拓扑模型（remotes[]，同时保留 fetchUrl 与 pushUrl）。 */
export function parseRemotesTopology(remoteOutput, sshHostMap = parseSshConfigHostMap()) {
  const map = new Map()
  for (const line of String(remoteOutput ?? '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!m) continue
    const [, name, url, kind] = m
    if (!map.has(name)) map.set(name, { name, fetchUrl: undefined, pushUrl: undefined })
    const item = map.get(name)
    if (kind === 'fetch') item.fetchUrl = url
    else item.pushUrl = url
  }
  const remotes = []
  for (const item of map.values()) {
    const effectiveUrl = item.pushUrl || item.fetchUrl || ''
    const desc = resolveRemoteDescriptor(effectiveUrl, sshHostMap)
    remotes.push({
      name: item.name,
      fetchUrl: item.fetchUrl ?? item.pushUrl,
      pushUrl: item.pushUrl ?? item.fetchUrl,
      providerId: desc.providerId,
      repoSlug: desc.repoSlug,
      isUpstream: item.name === 'upstream',
      capabilities: desc.capabilities,
    })
  }
  const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null
  const upstream = remotes.find((r) => r.name === 'upstream') ?? null
  return {
    remotes,
    byName: Object.fromEntries(remotes.map((r) => [r.name, r])),
    origin,
    upstream,
    providerId: origin?.providerId ?? 'none',
  }
}

/** 将 GitHub 地址归一为保留原始大小写的 owner/name（支持 SSH Host 别名）。 */
export function githubRepoFull(value, sshHostMap = parseSshConfigHostMap()) {
  const s = String(value ?? '').trim()
  if (!s) return undefined
  const ext = extractHostAndPath(s)
  if (ext) {
    const effective = resolveEffectiveHost(ext.host, sshHostMap)
    if (effective !== 'github.com' && effective !== 'www.github.com' && effective !== 'ssh.github.com') {
      return undefined
    }
    const clean = ext.path.replace(/\.git$/i, '').replace(/\/+$/, '')
    return /^[^/\s]+\/[^/\s]+$/.test(clean) ? clean : undefined
  }
  const norm = stripProtocolAndAuth(s).replace(/^[^/:]+:/, '').replace(/^[^/]*\.[^/]*\//, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  return /github\.com[:/]/i.test(s) && /^[^/\s]+\/[^/\s]+$/.test(norm) ? norm : undefined
}

/** 将 GitHub 地址归一为小写 owner/name。 */
export function githubRepoPath(value, sshHostMap = parseSshConfigHostMap()) {
  const full = githubRepoFull(value, sshHostMap)
  return full ? full.toLowerCase() : undefined
}

/** 从项目清单提取声明的源仓库（owner/name）。 */
export function detectDeclaredRepo(repoRoot, sshHostMap = parseSshConfigHostMap()) {
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  if (pkg) {
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    const gh = githubRepoPath(repo, sshHostMap)
    if (gh) return gh
  }
  const skillMd = readTextSafe(join(repoRoot, 'SKILL.md'))
  if (skillMd) {
    const m = /^[ \t]+source:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(skillMd)
    const gh = githubRepoPath(m?.[1], sshHostMap)
    if (gh) return gh
  }
  const cargo = readTextSafe(join(repoRoot, 'Cargo.toml'))
  if (cargo) {
    const m = /^\s*repository\s*=\s*["']([^"']+)["']/m.exec(cargo)
    const gh = githubRepoPath(m?.[1], sshHostMap)
    if (gh) return gh
  }
  const pyproject = readTextSafe(join(repoRoot, 'pyproject.toml'))
  if (pyproject) {
    const urls = /\[project\.urls\]([\s\S]*?)(?:\n\[|$)/.exec(pyproject)?.[1] ?? ''
    for (const key of ['Repository', 'Source', 'Homepage', 'Home']) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'mi').exec(urls)
      const gh = githubRepoPath(m?.[1], sshHostMap)
      if (gh) return gh
    }
  }
  const gomod = readTextSafe(join(repoRoot, 'go.mod'))
  if (gomod) {
    const m = /^module\s+(\S+)/m.exec(gomod)
    const gh = githubRepoPath(m?.[1], sshHostMap)
    if (gh) return gh
  }
  return undefined
}

function resolveGitMarkerExists(cwdOrGitDir, markerName) {
  if (!cwdOrGitDir) return false
  if (existsSync(join(cwdOrGitDir, markerName))) return true
  const dotGit = join(cwdOrGitDir, '.git')
  if (!existsSync(dotGit)) return false
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return existsSync(join(dotGit, markerName))
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (!m) return false
      const gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(cwdOrGitDir, m[1].trim())
      if (existsSync(join(gitDir, markerName))) return true
      const commondirFile = join(gitDir, 'commondir')
      if (existsSync(commondirFile)) {
        const relCommon = readFileSync(commondirFile, 'utf8').trim()
        const commonDir = isAbsolute(relCommon) ? relCommon : resolve(gitDir, relCommon)
        if (existsSync(join(commonDir, markerName))) return true
      }
    }
  } catch { return false }
  return false
}

export function hasLocalOnlyMarker(cwdOrGitDir) {
  return resolveGitMarkerExists(cwdOrGitDir, 'pf-local-mode')
}

/**
 * 双轴五态工作区身份判定：
 * local-only | maintainer | contributor-fork | clone-readonly | inbound-external-pr | generic-git | undetermined
 */
export function resolveWorkspaceIdentity({
  gitDir,
  remoteUrls = {},
  declaredRepo,
  gitIdentity = {},
  historyAuthors = [],
  commits = 0,
  externalPr,
  apiProbe,
  sshHostMap = parseSshConfigHostMap(),
} = {}) {
  const TEAM_PROBE_HINT = '如你是仓库团队或组织协作者且尚未提交过代码，可追加 --probe-auth（或运行 flow.mjs inspect --probe-auth）探测 GitHub 写权限以确认 maintainer'

  if (externalPr) {
    return { role: 'inbound-external-pr', providerId: 'github', reason: `审阅外部传入 PR #${externalPr}` }
  }
  if (resolveGitMarkerExists(gitDir, 'pf-local-mode')) {
    return { role: 'local-only', providerId: 'none', reason: '已显式启用本地模式（.git/pf-local-mode）' }
  }

  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  if (!originRaw) {
    return { role: 'local-only', providerId: 'none', reason: '仓库没有配置任何远端' }
  }

  const descriptor = resolveRemoteDescriptor(originRaw, sshHostMap)
  const providerId = descriptor.providerId

  if (resolveGitMarkerExists(gitDir, 'pf-fork-mode')) {
    return { role: 'contributor-fork', providerId, reason: '已选择 Fork 协作模式（.git/pf-fork-mode）' }
  }
  if (resolveGitMarkerExists(gitDir, 'pf-standalone-mode')) {
    return { role: 'maintainer', providerId, collaborationScope: 'owner', reason: '已选择独立项目模式（.git/pf-standalone-mode）' }
  }

  const origin = githubRepoPath(originRaw, sshHostMap)
  const upstream = githubRepoPath(remoteUrls.upstream, sshHostMap)
  const originLow = origin?.toLowerCase()
  const upstreamLow = upstream?.toLowerCase()
  const declaredLow = declaredRepo?.toLowerCase()

  const localEmail = (gitIdentity.email ?? '').trim().toLowerCase()
  const localName = (gitIdentity.name ?? '').trim().toLowerCase()
  const authorMatched = historyAuthors.some((a) => {
    const lower = a.toLowerCase()
    return (localEmail && lower.includes(`<${localEmail}>`)) || (localName && lower.startsWith(`${localName} <`))
  })

  if (!origin) {
    if (descriptor.isLocal) {
      if (remoteUrls.upstream && remoteUrls.upstream !== originRaw) {
        return { role: 'contributor-fork', providerId: 'generic-git', reason: '本地测试远端存在独立的 upstream 与 origin' }
      }
      if (commits > 0 && historyAuthors.length > 0 && !authorMatched) {
        return { role: 'clone-readonly', providerId: 'generic-git', reason: '克隆仓历史作者与当前配置署名不匹配' }
      }
      return { role: 'maintainer', providerId: 'generic-git', collaborationScope: 'owner', reason: '本地测试远端且属主匹配' }
    }
    if (remoteUrls.upstream && remoteUrls.upstream !== originRaw) {
      return { role: 'contributor-fork', providerId: 'generic-git', reason: '非 GitHub 远端存在独立 upstream 与 origin' }
    }
    return {
      role: 'generic-git',
      providerId: 'generic-git',
      capabilities: GENERIC_GIT_PROVIDER.capabilities,
      reason: `远端属于通用 Git 托管（${descriptor.host ?? originRaw}），跳过平台 API 自动化并放行完整本地与推送流程`,
    }
  }

  const apiWrite = /^(ADMIN|MAINTAIN|WRITE)$/i.test(apiProbe?.viewerPermission ?? '') || apiProbe?.canPush === true
  const apiReadOnly = /^(READ|TRIAGE|NONE)$/i.test(apiProbe?.viewerPermission ?? '') || apiProbe?.canPush === false
  const apiProbed = Boolean(apiProbe && (apiWrite || apiReadOnly || apiProbe.viewerPermission))
  const canEmitTeamProbeHint = !apiProbed && !apiProbe?.isFork

  if (upstreamLow && upstreamLow !== originLow) {
    if (apiReadOnly) {
      return { role: 'clone-readonly', providerId, reason: `upstream 指向 ${upstream}，但对 origin（${origin}）只有只读权限` }
    }
    return { role: 'contributor-fork', providerId, reason: `origin (${origin}) 与 upstream (${upstream}) 不同` }
  }

  if (apiProbe?.isFork === true && (!declaredLow || !apiProbe.parent || apiProbe.parent.toLowerCase() === declaredLow || declaredLow !== originLow)) {
    if (apiReadOnly) {
      return { role: 'clone-readonly', providerId, reason: `origin（${origin}）是他人 Fork 且当前账号无写入权限` }
    }
    return { role: 'contributor-fork', providerId, reason: `API 探测表明 ${origin} 是 Fork 仓库` }
  }

  if (declaredLow && declaredLow !== originLow) {
    if (apiReadOnly) {
      return { role: 'clone-readonly', providerId, reason: `对声明的远端 ${origin} 无写权限（${apiProbe.viewerPermission ?? 'READ'}）` }
    }
    return { role: 'contributor-fork', providerId, reason: `项目声明源仓库为 ${declaredRepo}，当前 origin 为 ${origin}` }
  }

  const originOwnerLow = origin.split('/')[0].toLowerCase()
  const viewerLogin = apiProbe?.viewerLogin || apiProbe?.login
  if (apiReadOnly) {
    return { role: 'clone-readonly', providerId, reason: `对 ${origin} 仅具备只读权限（${apiProbe?.viewerPermission ?? 'READ'}）` }
  }
  if (apiWrite) {
    const isTeamCollaborator = Boolean(viewerLogin && String(viewerLogin).toLowerCase() !== originOwnerLow)
    const collaborationScope = isTeamCollaborator ? 'team-collaborator' : 'owner'
    const permLabel = apiProbe?.viewerPermission ?? 'WRITE'
    return {
      role: 'maintainer',
      providerId,
      collaborationScope,
      reason: isTeamCollaborator
        ? `当前账号 ${viewerLogin} 具备同源仓库 ${origin} 的组织/团队写权限（${permLabel}，团队协作者）`
        : `拥有 ${origin} 写权限（${permLabel}）`,
    }
  }

  if (viewerLogin && String(viewerLogin).toLowerCase() === originOwnerLow) {
    return { role: 'maintainer', providerId, collaborationScope: 'owner', reason: `当前登录账号 ${viewerLogin} 与仓库属主一致` }
  }

  if (commits > 0 && historyAuthors.length > 0 && !authorMatched) {
    return {
      role: 'clone-readonly',
      providerId,
      reason: `未检测到对 ${origin} 的写权限，且本机提交署名未出现在历史作者中（疑似只读克隆他人仓库）`,
      ...(canEmitTeamProbeHint ? { teamProbeHint: TEAM_PROBE_HINT } : {}),
    }
  }

  if (declaredLow && declaredLow === originLow) {
    if (authorMatched) {
      const isTeamCollaborator = Boolean(viewerLogin && String(viewerLogin).toLowerCase() !== originOwnerLow)
      return {
        role: 'maintainer',
        providerId,
        collaborationScope: isTeamCollaborator ? 'team-collaborator' : 'owner',
        reason: `origin 与项目声明源仓库 ${origin} 一致且本机提交归属吻合`,
      }
    }
    return {
      role: 'undetermined',
      providerId,
      reason: `origin 与项目声明源仓库 ${origin} 一致，但缺少写入权限与提交作者证据，保守按贡献者处置`,
      ...(canEmitTeamProbeHint ? { teamProbeHint: TEAM_PROBE_HINT } : {}),
    }
  }

  if (authorMatched) {
    const isTeamCollaborator = Boolean(viewerLogin && String(viewerLogin).toLowerCase() !== originOwnerLow)
    return {
      role: 'maintainer',
      providerId,
      collaborationScope: isTeamCollaborator ? 'team-collaborator' : 'owner',
      reason: '自有仓库且本机署名匹配历史提交作者',
    }
  }

  return {
    role: 'undetermined',
    providerId,
    reason: '缺乏源仓库声明与远端写权限证明，按保守贡献者处置',
    ...(canEmitTeamProbeHint ? { teamProbeHint: TEAM_PROBE_HINT } : {}),
  }
}

function parseGitHubUrlParts(remoteUrl, sshHostMap) {
  const full = githubRepoFull(remoteUrl, sshHostMap)
  if (!full) return null
  const s = String(remoteUrl ?? '').trim()
  const isSsh = /^git@|^ssh:\/\/|^[^/:@\s]+@[^:\s]+:/i.test(s)
  const ext = extractHostAndPath(s)
  return { full, lower: full.toLowerCase(), protocol: isSsh ? 'ssh' : 'https', rawHost: ext?.host ?? 'github.com' }
}

function hasLocalSshKeys() {
  const sshDir = join(homedir(), '.ssh')
  if (!existsSync(sshDir)) return false
  try {
    return readdirSync(sshDir).some((n) => /^id_(?:ed25519|ecdsa|rsa|dsa)(?:\.pub)?$/i.test(n))
  } catch { return false }
}

async function probeHttpsCredential(cwd, remoteUrl, sshHostMap) {
  const parts = parseGitHubUrlParts(remoteUrl, sshHostMap)
  const pathPart = parts ? `${parts.full}.git` : ''
  const lines = ['protocol=https', 'host=github.com']
  if (pathPart) lines.push(`path=${pathPart}`)
  const res = await execSafe('git', ['credential', 'fill'], {
    cwd,
    input: `${lines.join('\n')}\n\n`,
    timeout: DEFAULT_PROBE_TIMEOUT_MS,
  })
  if (!res.ok || res.timedOut || !res.stdout) return { available: false, token: null, username: null, timedOut: Boolean(res.timedOut) }
  let token = null
  let username = null
  for (const line of res.stdout.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim()
    const v = line.slice(eq + 1).trim()
    if (k === 'password' && v) token = v
    if (k === 'username' && v && !/^(?:x-access-token|oauth2|token|git)$/i.test(v)) username = v
  }
  return { available: Boolean(token), token, username, timedOut: false }
}

async function probeSshAuth(cwd, host = 'github.com') {
  const targetHost = host || 'github.com'
  const sshAgent = await execSafe('ssh-add', ['-l'], { cwd, timeout: 2000 })
  const agentReady = sshAgent.ok && !/no identities/i.test(sshAgent.stdout + sshAgent.stderr)
  if (!agentReady && !hasLocalSshKeys()) {
    return { available: false, port: null, login: null, reason: 'no-local-key' }
  }

  const r22 = await execSafe('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', '-o', 'StrictHostKeyChecking=yes',
    `git@${targetHost}`,
  ], { cwd, timeout: 3500 })
  const out22 = [r22.stderr, r22.stdout].filter(Boolean).join('\n')
  const m22 = /Hi\s+([^!\s]+)!\s+You(?:'ve| have)\s+successfully\s+authenticated/i.exec(out22)
  if (m22 || /successfully authenticated/i.test(out22)) {
    return { available: true, port: 22, login: m22?.[1] ?? null }
  }
  const r443 = await execSafe('ssh', [
    '-T', '-p', '443', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', '-o', 'StrictHostKeyChecking=yes',
    'git@ssh.github.com',
  ], { cwd, timeout: 3500 })
  const out443 = [r443.stderr, r443.stdout].filter(Boolean).join('\n')
  const m443 = /Hi\s+([^!\s]+)!\s+You(?:'ve| have)\s+successfully\s+authenticated/i.exec(out443)
  if (m443 || /successfully authenticated/i.test(out443)) {
    return { available: true, port: 443, login: m443?.[1] ?? null }
  }
  return { available: false, port: null, login: null }
}

/**
 * 并发探测双轨四级 GitHub 环境并返回自包含客户端实例；非 GitHub 远端安全退化为 generic-git。
 */
export async function probeGitHubEnv({
  cwd = process.cwd(),
  remoteUrls = {},
  probeNetwork = false,
  verifyToken = false,
  sshHostMap = parseSshConfigHostMap(),
} = {}) {
  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const parsedOrigin = originRaw ? parseGitHubUrlParts(originRaw, sshHostMap) : null
  const descriptor = originRaw ? resolveRemoteDescriptor(originRaw, sshHostMap) : { providerId: 'none' }

  if (!originRaw) {
    return {
      env: {
        hasRemote: false, providerId: 'none', protocol: null,
        trackA: { ssh: 'n/a', https: 'n/a', remediationCmd: null },
        trackB: { tier: 'offline', ghCli: false, hasToken: false },
      },
      client: createGitHubClient({ tier: 'offline', cwd }),
    }
  }

  if (descriptor.providerId !== 'github') {
    const ext = extractHostAndPath(originRaw)
    const proto = /^https?:/i.test(originRaw) ? 'https' : (/^(?:ssh:\/\/|[^@\s]+@)/i.test(originRaw) ? 'ssh' : 'local')
    return {
      env: {
        hasRemote: true,
        providerId: 'generic-git',
        origin: descriptor.repoSlug ?? originRaw,
        host: ext?.host ?? null,
        protocol: proto,
        trackA: { ssh: 'unprobed', https: 'unprobed', remediationCmd: null },
        trackB: { tier: 'generic-git', ghCli: false, hasToken: false },
      },
      client: createGitHubClient({ tier: 'offline', cwd }),
    }
  }

  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null
  const [ghStatus, credResult] = await Promise.all([
    execSafe('gh', ['auth', 'status', '--hostname', 'github.com'], { cwd, timeout: 3000 }),
    probeHttpsCredential(cwd, originRaw, sshHostMap),
  ])
  const sshResult = probeNetwork && (parsedOrigin?.protocol === 'ssh' || (!credResult.available && !envToken))
    ? await probeSshAuth(cwd, parsedOrigin?.rawHost ?? 'github.com')
    : { available: null, port: null, login: null }

  const ghOk = !ghStatus.missing && ghStatus.ok
  const ghOutText = [ghStatus.stdout ?? '', ghStatus.stderr ?? ''].join('\n')
  const ghLoginMatch = ghOk ? /Logged in to [^\s]+ (?:account|as)\s+([^\s(]+)/i.exec(ghOutText) : null
  const ghLogin = ghLoginMatch ? ghLoginMatch[1].trim() : null

  let token = envToken || credResult.token || null
  let tokenLogin = credResult.username || null
  let tokenValid = Boolean(token)
  if (!ghOk && token && (verifyToken || probeNetwork)) {
    const userCheck = await githubHttpsRequest('GET', '/user', token)
    if (userCheck.status === 401) {
      tokenValid = false
      token = null
    } else if (userCheck.ok && userCheck.data?.login) {
      tokenLogin = userCheck.data.login
      tokenValid = true
    }
  }

  const hasHttps = Boolean(tokenValid) || credResult.available
  let sshState = 'unprobed'
  if (sshResult.available === true) sshState = `available:${sshResult.port}`
  else if (sshResult.available === false) sshState = 'unavailable'

  let remediationCmd = null
  if (parsedOrigin?.protocol === 'https' && !hasHttps && sshResult.available === true) {
    remediationCmd = `git remote set-url origin git@github.com:${parsedOrigin.full}.git`
  } else if (parsedOrigin?.protocol === 'https' && !hasHttps && ghOk) {
    remediationCmd = 'gh auth setup-git'
  } else if (parsedOrigin?.protocol === 'ssh' && sshResult.available === false && hasHttps) {
    remediationCmd = `git remote set-url origin https://github.com/${parsedOrigin.full}.git`
  }

  let tier = 'mcp-delegate'
  if (ghOk) tier = 'gh-cli'
  else if (token && tokenValid) tier = 'node-https-token'
  else if (parsedOrigin?.protocol === 'ssh' && sshResult.available === true) tier = 'half-duplex'

  const effectiveLogin = ghLogin || tokenLogin || sshResult.login || null
  const env = {
    hasRemote: true,
    providerId: 'github',
    origin: parsedOrigin?.full ?? null,
    protocol: parsedOrigin?.protocol ?? null,
    trackA: {
      ssh: sshState,
      ...(sshResult.login ? { sshLogin: sshResult.login } : {}),
      https: hasHttps ? 'available' : 'no-credential',
      ...(credResult.username ? { httpsUsername: credResult.username } : {}),
      remediationCmd,
    },
    trackB: {
      tier,
      ghCli: ghOk,
      ...(effectiveLogin ? { login: effectiveLogin } : {}),
      hasToken: Boolean(token && tokenValid),
    },
  }

  return {
    env,
    client: createGitHubClient({ tier, cwd, token: tokenValid ? token : null, login: effectiveLogin }),
  }
}
