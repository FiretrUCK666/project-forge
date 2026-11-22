/**
 * registry.mjs —— 平台无关的 HostingProvider 注册表与多远端拓扑抽象。
 *
 * - 产品层仅注册 `github` 适配器；其余未知主机或自建 Git 服务器一律优雅降级为内置
 *   `generic-git` 基础能力，放行本地分支、三档隔离、门禁、独立审查与合流，不误阻断流程。
 * - 支持 `0` 远端（`local-only`）、单远端、Fork（`origin` + `upstream`）与多远端镜像推送拓扑，
 *   并通过 `~/.ssh/config` `Host -> HostName` 别名映射准确解析多账号 SSH 地址。
 */

import {
  lookupSshHost,
  parseRemoteUrlHost,
  parseSshConfigHostMap,
  repoPath,
} from '../text.mjs'
import { normalizeDeclaredRepo } from '../../../kit/skills/lib/platform.mjs'
import {
  GENERIC_GIT_PROVIDER as CORE_GENERIC_GIT_PROVIDER,
  NONE_CAPABILITIES,
  getHostingProvider as coreGetHostingProvider,
  listHostingProviders,
  normalizeGenericRepo,
  registerHostingProvider,
  resolveRemoteDescriptor,
} from '../../../kit/skills/lib/platform-registry.mjs'
import {
  GITHUB_PROVIDER,
  detectGitModeMarkers,
  probeGitHubEnv,
  resolveWorkspaceIdentity as resolveGitHubWorkspaceIdentity,
} from './github.mjs'

export {
  NONE_CAPABILITIES,
  listHostingProviders,
  registerHostingProvider,
  resolveRemoteDescriptor,
}

const DEFAULT_CAPABILITIES = NONE_CAPABILITIES

/** 内置兜底适配器：未匹配任何已注册托管平台时安全降级为通用 Git 全流程。 */
export const GENERIC_GIT_PROVIDER = Object.freeze({
  ...CORE_GENERIC_GIT_PROVIDER,
  capabilities: NONE_CAPABILITIES,
  matchRemote(remoteUrl) {
    return typeof remoteUrl === 'string' && remoteUrl.trim().length > 0
  },
  normalizeRepo(remoteUrl) {
    return repoPath(remoteUrl) ?? normalizeGenericRepo(remoteUrl)
  },
  async probeTransport() {
    return { state: 'generic-git', reason: '通用 Git 远端：跳过特定平台传输探测' }
  },
  async probeAuth({ probeAuth = false } = {}) {
    return {
      probed: Boolean(probeAuth),
      providerId: 'generic-git',
      https: { state: 'n/a', hasToken: false, reason: '通用 Git 远端' },
      ssh: { state: 'generic-git', reason: '通用 Git 远端' },
      apiChannel: {
        tier: 'offline',
        delegateToHostMcp: false,
        reason: '通用 Git 远端无平台 API 通道，支持纯 Git 推送与本地合流',
      },
    }
  },
  classifyIdentity({
    gitFacts = {},
    declaredRepo,
    localMode = false,
    forkMode = false,
    standaloneMode = false,
    topology,
  } = {}) {
    if (localMode === true) {
      return { role: 'local-only', providerId: 'none', capabilities: NONE_CAPABILITIES, reason: '存在 .git/pf-local-mode 标记：按纯本地项目处置' }
    }
    const primaryUrl = topology?.primary?.fetchUrl
      ?? gitFacts.remoteUrls?.origin
      ?? (gitFacts.remoteUrls && typeof gitFacts.remoteUrls === 'object' ? Object.values(gitFacts.remoteUrls).find(Boolean) : undefined)
      ?? gitFacts.remote
    if (gitFacts.present !== true || !primaryUrl) {
      return { role: 'local-only', providerId: 'none', capabilities: NONE_CAPABILITIES, reason: '还没有配置远端仓库：按纯本地工作区处置' }
    }
    if (forkMode === true) {
      return { role: 'contributor-fork', providerId: 'generic-git', capabilities: NONE_CAPABILITIES, reason: '存在 .git/pf-fork-mode 标记：按贡献者 Fork 协作处置' }
    }
    const upstreamUrl = topology?.upstream?.fetchUrl ?? gitFacts.remoteUrls?.upstream
    const primarySlug = normalizeGenericRepo(primaryUrl)
    const upstreamSlug = normalizeGenericRepo(upstreamUrl)
    if (upstreamUrl && ((primarySlug && upstreamSlug && primarySlug !== upstreamSlug) || (!primarySlug && upstreamUrl !== primaryUrl))) {
      return {
        role: 'contributor-fork',
        providerId: 'generic-git',
        capabilities: NONE_CAPABILITIES,
        reason: `存在独立 upstream（${upstreamUrl}）与 origin（${primaryUrl}），按贡献者 Fork 协作处置`,
      }
    }
    const declaredSlug = normalizeGenericRepo(declaredRepo)
    if (declaredSlug && primarySlug && declaredSlug.toLowerCase() !== primarySlug.toLowerCase()) {
      return {
        role: 'contributor-fork',
        providerId: 'generic-git',
        capabilities: NONE_CAPABILITIES,
        reason: `声明源仓库（${declaredSlug}）与 origin（${primarySlug}）不一致，按贡献者 Fork 协作处置`,
      }
    }
    if (standaloneMode === true) {
      return {
        role: 'maintainer',
        collaborationScope: 'owner',
        providerId: 'generic-git',
        capabilities: NONE_CAPABILITIES,
        reason: '存在 .git/pf-standalone-mode 标记：按独立个人项目维护者处置',
      }
    }
    return {
      role: 'maintainer',
      collaborationScope: 'owner',
      providerId: 'generic-git',
      capabilities: NONE_CAPABILITIES,
      reason: '未匹配特定平台适配器，已降级为通用 Git（generic-git）放行本地分支、审查与合并流程（跳过远端 REST API 自动化）',
    }
  },
  createClient() {
    return {
      providerId: 'generic-git',
      channel: 'none',
      capabilities: DEFAULT_CAPABILITIES,
    }
  },
})

/** 按 id 读取已注册的 HostingProvider（传入 `'generic-git'` 返回引擎内置兜底适配器）。 */
export function getHostingProvider(id) {
  const found = coreGetHostingProvider(id)
  if (!found) return undefined
  if (found.id === 'generic-git') return GENERIC_GIT_PROVIDER
  return found
}

function parseRawRemotesInput(remotesInput, remotePushUrls = {}) {
  if (!remotesInput) return []
  if (typeof remotesInput === 'string') {
    const byName = new Map()
    for (const rawLine of remotesInput.split(/\r?\n/)) {
      const m = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(rawLine.trim())
      if (!m) continue
      const [, name, url, kind] = m
      const cur = byName.get(name) ?? { name, fetchUrl: '', pushUrl: '' }
      if (kind === 'fetch' && !cur.fetchUrl) cur.fetchUrl = url
      if (kind === 'push' && !cur.pushUrl) cur.pushUrl = url
      byName.set(name, cur)
    }
    return [...byName.values()].map((item) => ({
      name: item.name,
      fetchUrl: item.fetchUrl || item.pushUrl,
      pushUrl: item.pushUrl || item.fetchUrl,
    }))
  }
  if (Array.isArray(remotesInput)) {
    return remotesInput
      .map((entry, idx) => {
        if (typeof entry === 'string') {
          const url = entry.trim()
          return url ? { name: idx === 0 ? 'origin' : `remote-${idx + 1}`, fetchUrl: url, pushUrl: url } : null
        }
        if (entry && typeof entry === 'object') {
          const fetchUrl = String(entry.fetchUrl ?? entry.url ?? entry.pushUrl ?? '').trim()
          const pushUrl = String(entry.pushUrl ?? entry.fetchUrl ?? entry.url ?? '').trim()
          if (!fetchUrl && !pushUrl) return null
          return {
            name: String(entry.name ?? (idx === 0 ? 'origin' : `remote-${idx + 1}`)),
            fetchUrl: fetchUrl || pushUrl,
            pushUrl: pushUrl || fetchUrl,
          }
        }
        return null
      })
      .filter(Boolean)
  }
  if (typeof remotesInput === 'object') {
    const out = []
    for (const [name, url] of Object.entries(remotesInput)) {
      if (typeof url !== 'string' || !url.trim()) continue
      const fetchUrl = url.trim()
      const pushOverride = typeof remotePushUrls?.[name] === 'string' && remotePushUrls[name].trim()
        ? remotePushUrls[name].trim()
        : fetchUrl
      out.push({ name, fetchUrl, pushUrl: pushOverride })
    }
    return out
  }
  return []
}

/**
 * 解析 0 / 单 / Fork / 多远端拓扑模型。
 * 支持 `git remote -v` 文本、`{ name: url }` 映射及条目数组，不再写死远端名为 `'origin'`。
 */
export function resolveRemotesTopology(remotesInput, opts = {}) {
  const sshHostMap = opts.sshHostMap === false
    ? {}
    : (opts.sshHostMap ?? parseSshConfigHostMap(opts.sshConfig))
  const entries = parseRawRemotesInput(remotesInput, opts.remotePushUrls)
  const remotes = entries.map((entry) => resolveRemoteDescriptor(entry, { sshHostMap }))

  const primary = remotes.find((r) => r.name === 'origin')
    ?? remotes.find((r) => !r.isUpstream)
    ?? remotes[0]
  const upstream = remotes.find((r) => r.name === 'upstream' || r.isUpstream)

  const isFork = Boolean(
    upstream
    && primary
    && upstream !== primary
    && (
      (upstream.repoSlug && primary.repoSlug && upstream.repoSlug.toLowerCase() !== primary.repoSlug.toLowerCase())
      || ((!upstream.repoSlug || !primary.repoSlug) && upstream.fetchUrl !== primary.fetchUrl)
    ),
  )

  const mode = remotes.length === 0
    ? 'none'
    : remotes.length === 1
      ? 'single'
      : (isFork ? 'fork' : 'multi')

  const providerIds = [...new Set(remotes.map((r) => r.providerId))]
  const primaryProviderId = primary?.providerId

  return {
    mode,
    remotes,
    primary,
    upstream,
    isFork,
    hasMultiRemotes: remotes.length > 1,
    providerIds,
    primaryProviderId,
    sshHostMap,
  }
}

/** 按注册表与多远端拓扑分发工作区身份判定（纯函数路径）。 */
export function classifyTopologyIdentity(opts = {}) {
  const gitFacts = opts.gitFacts ?? {}
  const sshHostMap = opts.sshHostMap === false
    ? {}
    : (opts.sshHostMap ?? gitFacts.topology?.sshHostMap ?? parseSshConfigHostMap())
  const topology = gitFacts.topology
    ?? resolveRemotesTopology(gitFacts.remoteUrls ?? gitFacts.remote, { sshHostMap })
  if (opts.localMode === true || topology.mode === 'none') {
    return {
      role: 'local-only',
      providerId: 'none',
      capabilities: NONE_CAPABILITIES,
      reason: opts.localMode === true ? '存在 .git/pf-local-mode 标记：按纯本地项目处置' : '还没有配置远端仓库：按纯本地工作区处置',
    }
  }
  const primaryProvider = getHostingProvider(topology.primaryProviderId)
  if (!primaryProvider) {
    return GENERIC_GIT_PROVIDER.classifyIdentity({ ...opts, sshHostMap, topology })
  }
  const result = primaryProvider.classifyIdentity({ ...opts, sshHostMap, topology })
  return {
    ...result,
    providerId: result.providerId ?? primaryProvider.id,
    capabilities: result.role === 'local-only' ? NONE_CAPABILITIES : primaryProvider.capabilities,
  }
}

/** 按注册表与多远端拓扑解析工作区身份（含 `.git/pf-*-mode` 与按需 API 探针）。 */
export async function resolveTopologyIdentity(opts = {}) {
  const {
    cwd,
    gitFacts = {},
    declaredRepo,
    probeApi,
    probeEnvResult,
    client,
    localIdentity,
    localMode,
    forkMode,
    standaloneMode,
    sshHostMap,
    fetchApi = false,
  } = opts
  const effectiveHostMap = sshHostMap === false
    ? {}
    : (sshHostMap ?? gitFacts.topology?.sshHostMap ?? parseSshConfigHostMap())
  const topology = gitFacts.topology
    ?? resolveRemotesTopology(gitFacts.remoteUrls ?? gitFacts.remote, { sshHostMap: effectiveHostMap })

  const markers = cwd ? detectGitModeMarkers(cwd) : { localMode: false, forkMode: false, standaloneMode: false }
  const effectiveLocalMode = typeof localMode === 'boolean' ? localMode : markers.localMode
  const effectiveForkMode = typeof forkMode === 'boolean' ? forkMode : markers.forkMode
  const effectiveStandaloneMode = typeof standaloneMode === 'boolean' ? standaloneMode : markers.standaloneMode

  if (effectiveLocalMode || topology.mode === 'none') {
    return {
      role: 'local-only',
      providerId: 'none',
      capabilities: NONE_CAPABILITIES,
      reason: effectiveLocalMode ? '存在 .git/pf-local-mode 标记：按纯本地项目处置' : '还没有配置远端仓库：按纯本地工作区处置',
    }
  }

  const provider = getHostingProvider(topology.primaryProviderId) ?? GENERIC_GIT_PROVIDER

  if (provider.id === 'github') {
    const res = await resolveGitHubWorkspaceIdentity({
      cwd,
      gitFacts,
      declaredRepo,
      probeApi,
      probeEnvResult,
      client,
      localIdentity,
      localMode: effectiveLocalMode,
      forkMode: effectiveForkMode,
      standaloneMode: effectiveStandaloneMode,
      sshHostMap: effectiveHostMap,
      fetchApi,
    })
    return {
      ...res,
      providerId: res.role === 'local-only' ? 'none' : (res.providerId ?? 'github'),
      capabilities: res.role === 'local-only' ? NONE_CAPABILITIES : provider.capabilities,
    }
  }

  return provider.classifyIdentity({
    gitFacts,
    declaredRepo,
    probeApi,
    localIdentity,
    localMode: effectiveLocalMode,
    forkMode: effectiveForkMode,
    standaloneMode: effectiveStandaloneMode,
    sshHostMap: effectiveHostMap,
    topology,
  })
}

/** 按注册表与多远端拓扑调度平台环境探测；无远端时仍可探测本机 GitHub 建仓凭据但工作区能力忠实报告 none。 */
export async function probeTopologyEnv(opts = {}) {
  const effectiveHostMap = opts.sshHostMap === false
    ? {}
    : (opts.sshHostMap ?? parseSshConfigHostMap())
  const topology = opts.topology ?? resolveRemotesTopology(opts.remoteUrls, { sshHostMap: effectiveHostMap })
  if (topology.mode === 'none') {
    const res = await probeGitHubEnv({ ...opts, sshHostMap: effectiveHostMap })
    return { ...res, providerId: 'none', capabilities: NONE_CAPABILITIES }
  }
  const provider = getHostingProvider(topology.primaryProviderId) ?? GENERIC_GIT_PROVIDER
  if (provider.id === 'github') {
    const res = await probeGitHubEnv({ ...opts, sshHostMap: effectiveHostMap })
    return { ...res, providerId: 'github', capabilities: provider.capabilities }
  }
  const res = await provider.probeAuth({ ...opts, probeAuth: true, topology })
  return { ...res, providerId: provider.id, capabilities: provider.capabilities }
}

// 产品层严格仅注册 GitHub 适配器
registerHostingProvider(GITHUB_PROVIDER)

export { normalizeDeclaredRepo, parseSshConfigHostMap }
