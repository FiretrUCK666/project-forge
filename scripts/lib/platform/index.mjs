/**
 * platform/index.mjs —— 引擎侧平台适配单一入口（全面复用 `kit/skills/lib/platform*.mjs`）。
 *
 * 单源重导出 5 方言（GitHub/GitLab/GitCode/Gitee/Gitea）+ `generic-git` 10 键能力矩阵与探针原语，
 * 仅保留引擎侧多远端拓扑解析、双轨探测返回视图、开关 A 分支保护载荷与精简 REST 客户端。
 */

import { unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildNonInteractiveEnv } from '../../../kit/skills/lib/exec.mjs'
import {
  NON_RETRYABLE_STATUSES,
  RETRYABLE_NET_CODES,
  extractCliHttpStatus,
  isRetryableHttpOutcome,
} from '../../../kit/skills/lib/github-parse.mjs'
import { redactPlatformTokens } from '../../../kit/skills/lib/platform-http.mjs'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  TOKEN_VAULT,
  buildOneClickPrUrl,
  defaultCommandRunner,
  defaultHttpsRequest,
  detectRemoteProtocol,
  normalizeGitHubRepo,
  parseSshConfigDetails,
  parseSshConfigHostMap,
  probeGitHubEnvCore,
  probePlatformEnvCore,
  probeSshTransport,
} from '../../../kit/skills/lib/platform-probe.mjs'
import {
  BUILTIN_PROVIDER_IDS,
  CAPABILITY_KEYS,
  GENERIC_GIT_PROVIDER,
  GITCODE_PROVIDER,
  GITEA_PROVIDER,
  GITEE_PROVIDER,
  GITHUB_PROVIDER,
  GITLAB_PROVIDER,
  NONE_CAPABILITIES,
  getHostingProvider,
  listHostingProviders,
  normalizeGenericRepo,
  registerHostingProvider,
  resolveRemoteDescriptor,
  resolveRemoteTarget,
} from '../../../kit/skills/lib/platform-registry.mjs'
import {
  classifyWorkspaceIdentity as kitClassifyWorkspaceIdentity,
  createProviderClient,
  detectGitModeMarkers,
  hasForkModeMarker,
  hasLocalOnlyMarker,
  hasStandaloneModeMarker,
  normalizeDeclaredRepo,
} from '../../../kit/skills/lib/platform.mjs'

export {
  BUILTIN_PROVIDER_IDS,
  CAPABILITY_KEYS,
  DEFAULT_PROBE_TIMEOUT_MS,
  GENERIC_GIT_PROVIDER,
  GITCODE_PROVIDER,
  GITEA_PROVIDER,
  GITEE_PROVIDER,
  GITHUB_PROVIDER,
  GITLAB_PROVIDER,
  NONE_CAPABILITIES,
  TOKEN_VAULT,
  buildNonInteractiveEnv,
  buildOneClickPrUrl,
  createProviderClient,
  defaultCommandRunner as defaultRunCommand,
  defaultHttpsRequest,
  detectGitModeMarkers,
  detectRemoteProtocol,
  getHostingProvider,
  hasForkModeMarker,
  hasLocalOnlyMarker,
  hasStandaloneModeMarker,
  listHostingProviders,
  normalizeDeclaredRepo,
  normalizeGitHubRepo,
  parseSshConfigHostMap,
  probePlatformEnvCore,
  probeSshTransport,
  redactPlatformTokens,
  registerHostingProvider,
  resolveRemoteDescriptor,
  resolveRemoteTarget,
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

/** 解析 0 / 单 / Fork / 多远端拓扑模型（兼容 `git remote -v` 文本、`{ name: url }` 映射与条目数组）。 */
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

  return {
    mode,
    remotes,
    primary,
    upstream,
    isFork,
    hasMultiRemotes: remotes.length > 1,
    providerIds: [...new Set(remotes.map((r) => r.providerId))],
    primaryProviderId: primary?.providerId,
    sshHostMap,
  }
}

/** 通用 Git 与非 GitHub 托管远端的保守身份判定（匿名 HTTPS 缺写证明归 undetermined）。 */
export function classifyGenericIdentity({
  gitFacts = {},
  declaredRepo,
  localMode = false,
  forkMode = false,
  standaloneMode = false,
  sshHostMap,
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
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const primaryDesc = topology?.primary ?? resolveRemoteDescriptor(primaryUrl, { sshHostMap: effectiveHostMap })
  if (primaryDesc?.isLocal === true || /^file:\/\//i.test(primaryUrl)) {
    return {
      role: 'maintainer',
      collaborationScope: 'owner',
      providerId: 'generic-git',
      capabilities: NONE_CAPABILITIES,
      reason: `本地路径或 file:// 通用远端（${primaryUrl}）：按维护者处置`,
    }
  }
  if (declaredSlug && primarySlug && declaredSlug.toLowerCase() === primarySlug.toLowerCase()) {
    return {
      role: 'maintainer',
      collaborationScope: 'owner',
      providerId: 'generic-git',
      capabilities: NONE_CAPABILITIES,
      reason: `声明源仓库（${declaredSlug}）与通用远端（${primarySlug}）匹配：按维护者处置`,
    }
  }
  const isHttp = /^https?:\/\//i.test(primaryUrl)
  const hasUrlCreds = /^https?:\/\/[^/@\s]+@/i.test(primaryUrl)
  const pushUrl = topology?.primary?.pushUrl ?? gitFacts.remotePushUrls?.origin
  const pushDesc = pushUrl && pushUrl !== primaryUrl
    ? resolveRemoteDescriptor(pushUrl, { sshHostMap: effectiveHostMap })
    : null
  const hasPushOverride = Boolean(
    pushDesc && (pushDesc.isLocal === true || pushDesc.protocol === 'ssh' || /^https?:\/\/[^/@\s]+@/i.test(pushUrl)),
  )
  const hasAuthCreds = Boolean(
    gitFacts.auth?.https?.hasToken === true
    || gitFacts.auth?.https?.username
    || gitFacts.auth?.https?.state === 'available',
  )
  if (isHttp && !hasUrlCreds && !hasPushOverride && !hasAuthCreds) {
    return {
      role: 'undetermined',
      providerId: 'generic-git',
      capabilities: NONE_CAPABILITIES,
      reason: `匿名 HTTP(S) 通用 Git 远端（${primaryUrl}）缺少写权限与正本归属证据，按 undetermined 保守处置（可配 .git/pf-standalone-mode 或在 AGENTS.md「取舍」写 role）`,
    }
  }
  return {
    role: 'maintainer',
    collaborationScope: 'owner',
    providerId: 'generic-git',
    capabilities: NONE_CAPABILITIES,
    reason: '未匹配特定平台适配器，已降级为通用 Git（generic-git）放行本地分支、审查与合并流程（跳过远端 REST API 自动化）',
  }
}

/** 按注册表与多远端拓扑分发工作区身份判定（纯函数，单源委托 `kit/skills/lib/platform.mjs`）。 */
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
  const primaryProvider = getHostingProvider(topology.primaryProviderId) ?? GENERIC_GIT_PROVIDER
  const result = primaryProvider.id === 'github'
    ? kitClassifyWorkspaceIdentity({ ...opts, sshHostMap })
    : classifyGenericIdentity({ ...opts, sshHostMap, topology })
  return {
    ...result,
    providerId: result.role === 'local-only' ? 'none' : (primaryProvider.id ?? result.providerId),
    capabilities: result.role === 'local-only' ? NONE_CAPABILITIES : primaryProvider.capabilities,
  }
}

/** 按注册表与多远端拓扑解析工作区身份（含 `.git/pf-*-mode` 与按需 GitHub API 权限查询）。 */
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
  let resolvedProbeApi = probeApi
  if (provider.id === 'github' && !resolvedProbeApi && fetchApi && !effectiveForkMode && !effectiveStandaloneMode) {
    const primaryRemoteUrl = topology.primary?.fetchUrl
      ?? gitFacts.remoteUrls?.origin
      ?? gitFacts.remote
    const originRepo = normalizeGitHubRepo(primaryRemoteUrl, effectiveHostMap)
    if (originRepo) {
      const ghClient = client || createEngineGitHubClient({ cwd, probeResult: probeEnvResult })
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

  return classifyTopologyIdentity({
    gitFacts: effectiveGitFacts,
    declaredRepo,
    probeApi: resolvedProbeApi,
    localIdentity,
    localMode: effectiveLocalMode,
    forkMode: effectiveForkMode,
    standaloneMode: effectiveStandaloneMode,
    sshHostMap: effectiveHostMap,
    topology,
  })
}

/** 引擎侧 GitHub 双轨探测适配（单源复用 `kit/skills/lib/platform-probe.mjs`）。 */
export async function probeEngineGitHubEnv({
  cwd = process.cwd(),
  remoteUrls = {},
  branch,
  defaultBranch = 'main',
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  mcpAvailable,
  verifyToken = false,
  offline,
  probeNetwork = true,
  runner,
  httpRequest = defaultHttpsRequest,
  env = process.env,
  sshHostMap,
} = {}) {
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const sshDetails = sshHostMap === undefined ? parseSshConfigDetails(undefined, env) : undefined
  const core = await probeGitHubEnvCore({
    cwd,
    remoteUrls,
    branch,
    defaultBranch,
    timeoutMs,
    probeNetwork,
    mcpAvailable,
    verifyToken,
    offline,
    runner: runner ?? defaultCommandRunner,
    httpRequest,
    env,
    sshHostMap: effectiveHostMap,
    sshDetails,
  })

  const result = {
    probed: true,
    hasRemote: Boolean(core.originUrl || core.upstreamUrl),
    https: core.httpsPublic,
    ssh: core.ssh,
    ghBridge: core.ghBridge,
    ghCli: {
      installed: core.ghCli.installed,
      authenticated: core.ghCli.authenticated,
      ...(core.ghCli.login ? { login: core.ghCli.login } : {}),
      reason: core.ghCli.reason,
    },
    originProtocol: detectRemoteProtocol(core.originUrl),
    protocolMismatch: core.mismatch,
    remediationCmd: core.remediationCmd,
    apiChannel: core.apiChannel,
    details: {
      hasRemote: Boolean(core.originUrl || core.upstreamUrl),
      originRepo: core.originRepo,
      upstreamRepo: core.upstreamRepo,
      targetRepo: core.targetRepo,
      ...(core.sshTargetHost !== 'github.com' ? { sshAlias: core.sshTargetHost } : {}),
      tokenStatus: core.tokenStatus,
      mcpAvailable: core.resolvedMcpAvailable,
      canPushSsh: core.sshWorks,
      canPushHttps: (core.httpsPublic.state === 'available' && core.httpsPublic.tokenValid !== false)
        || (core.ghCli.authenticated && core.ghBridge.configured),
    },
  }
  if (core.memoryToken && core.tokenVerified) {
    TOKEN_VAULT.set(result, core.memoryToken)
  }
  return result
}

/** 按注册表与多远端拓扑调度平台环境探测；无远端时工作区能力忠实报告 none。 */
export async function probeTopologyEnv(opts = {}) {
  const effectiveHostMap = opts.sshHostMap === false
    ? {}
    : (opts.sshHostMap ?? parseSshConfigHostMap())
  const topology = opts.topology ?? resolveRemotesTopology(opts.remoteUrls, { sshHostMap: effectiveHostMap })
  if (topology.mode === 'none') {
    const res = await probeEngineGitHubEnv({ ...opts, sshHostMap: effectiveHostMap })
    return { ...res, providerId: 'none', capabilities: NONE_CAPABILITIES }
  }
  const provider = getHostingProvider(topology.primaryProviderId) ?? GENERIC_GIT_PROVIDER
  if (provider.id === 'github') {
    const res = await probeEngineGitHubEnv({ ...opts, sshHostMap: effectiveHostMap })
    return { ...res, providerId: 'github', capabilities: provider.capabilities }
  }
  if (provider.id === 'generic-git') {
    return {
      probed: true,
      providerId: 'generic-git',
      capabilities: NONE_CAPABILITIES,
      https: { state: 'n/a', hasToken: false, reason: '通用 Git 远端' },
      ssh: { state: 'generic-git', reason: '通用 Git 远端' },
      apiChannel: {
        tier: 'offline',
        delegateToHostMcp: false,
        reason: '通用 Git 远端无平台 API 通道，支持纯 Git 推送与本地合流',
      },
    }
  }
  const core = await probePlatformEnvCore({
    ...opts,
    providerId: provider.id,
    apiBaseUrl: opts.apiBaseUrl ?? provider.defaultApiBase,
    repoSlug: opts.repoSlug ?? topology.primary?.repoSlug ?? null,
    host: opts.host ?? topology.primary?.resolvedHost ?? topology.primary?.host ?? null,
  })
  return {
    probed: true,
    providerId: provider.id,
    capabilities: provider.capabilities,
    https: core.httpsPublic,
    ssh: core.ssh,
    apiChannel: core.apiChannel,
  }
}

/**
 * 构造仅开启「开关 A」（禁直推/强推/删分支 + 要求 PR 与 Checks）的分支保护载荷。
 * 严格禁止设置 `required_approving_review_count >= 1`，避免单人仓与自动化合流死锁。
 */
export function buildSwitchABranchProtectionPayload({
  requiredChecks = [],
  strictStatusChecks = true,
  enforceAdmins = true,
  requiredApprovingReviewCount = 0,
} = {}) {
  const reviewCount = Number(requiredApprovingReviewCount ?? 0)
  if (!Number.isFinite(reviewCount) || reviewCount < 0 || reviewCount >= 1) {
    throw new Error('开关 A 分支保护禁止设置 required_approving_review_count >= 1（仅阻断直推/强推/删分支并接入 PR 与 Checks）')
  }
  const contexts = Array.isArray(requiredChecks)
    ? [...new Set(requiredChecks.map((item) => String(item ?? '').trim()).filter(Boolean))]
    : []
  return {
    required_status_checks: { strict: Boolean(strictStatusChecks), contexts },
    enforce_admins: Boolean(enforceAdmins),
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      required_approving_review_count: 0,
    },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: false,
    lock_branch: false,
    allow_fork_syncing: false,
  }
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
  return /403|forbidden|resource not accessible|must have (?:triage|write|admin) access|permission|upgrade to github pro/i.test(String(err.message ?? ''))
}

function defaultSleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

function withTempUtf8File(content, fn) {
  const file = join(tmpdir(), `pf-gh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`)
  writeFileSync(file, String(content ?? ''), 'utf8')
  return Promise.resolve().then(() => fn(file)).finally(() => {
    try { unlinkSync(file) } catch { /* ignore */ }
  })
}

/** 创建引擎侧精简 GitHub 双通道客户端（服务权限探测与开关 A 分支保护，单源复用 kit 传输/重试策略）。 */
export function createEngineGitHubClient({
  cwd = process.cwd(),
  probeResult,
  channel,
  env = process.env,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  maxRetries = 2,
  retryBaseDelayMs = 80,
  sleep = defaultSleep,
  runner = defaultCommandRunner,
  httpRequest = defaultHttpsRequest,
} = {}) {
  const safeEnv = buildNonInteractiveEnv(env)
  const vaultToken = probeResult && TOKEN_VAULT.has(probeResult) ? TOKEN_VAULT.get(probeResult) : undefined
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

  async function restOnce(method, path, { query, body, headers = {} } = {}) {
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
        for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
        if (inputFile) args.push('--input', inputFile)
        const res = await runner('gh', args, { cwd, env: safeEnv, timeoutMs: Math.max(timeoutMs, 10000) })
        if (res.code !== 0) {
          let parsed
          try { parsed = res.stdout ? JSON.parse(res.stdout) : undefined } catch { /* ignore */ }
          const rawStatus = Number(parsed?.status)
          const status = Number.isFinite(rawStatus) && rawStatus >= 100 && rawStatus <= 599
            ? rawStatus
            : extractCliHttpStatus(res.stderr)
          throw makeHttpError(status, res.stderr.trim() || parsed?.message || 'gh api 调用失败', parsed)
        }
        if (!res.stdout.trim()) return undefined
        try { return JSON.parse(res.stdout) } catch { return res.stdout }
      }
      return (body !== undefined && body !== null)
        ? withTempUtf8File(JSON.stringify(body), (file) => execWithInput(file))
        : execWithInput(undefined)
    }
    if (!token) throw makeHttpError(401, '未找到有效的 GitHub API 令牌')
    const resp = await httpRequest({
      method: method.toUpperCase(),
      url: urlObj.toString(),
      headers: { Authorization: `Bearer ${token}`, ...headers },
      body,
      timeoutMs: Math.max(timeoutMs, 10000),
      redirect: 'manual',
    })
    if (resp.status >= 300 && resp.status < 400) {
      throw makeHttpError(resp.status, `GitHub API 返回重定向 HTTP ${resp.status}（禁止自动跟随携带凭据）`, resp.data)
    }
    if (resp.status >= 400) {
      throw makeHttpError(resp.status, resp.data?.message || `GitHub API 返回 HTTP ${resp.status}`, resp.data)
    }
    return resp.data !== undefined ? resp.data : resp.text
  }

  async function rest(method, path, opts = {}) {
    const retries = Math.max(0, Number(maxRetries ?? 2))
    let lastError
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await restOnce(method, path, opts)
      } catch (err) {
        lastError = err
        const status = Number(err?.status ?? 0)
        const retryable = !NON_RETRYABLE_STATUSES.has(status)
          && (RETRYABLE_NET_CODES.has(String(err?.code ?? '')) || isRetryableHttpOutcome(err))
        if (attempt >= retries || !retryable) throw err
        const delayMs = Math.max(0, Number(retryBaseDelayMs ?? 80)) * (2 ** attempt)
        if (delayMs > 0) await sleep(delayMs)
      }
    }
    throw lastError
  }

  async function getRepoPermissions(repo) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const data = await rest('GET', `/repos/${norm}`)
    let login = probeResult?.apiChannel?.login
    if (!login) {
      try { login = (await rest('GET', '/user'))?.login } catch { /* ignore */ }
    }
    const perms = data?.permissions ?? {}
    const canPush = perms.push === true || perms.maintain === true || perms.admin === true
    const viewerPermission = perms.admin ? 'ADMIN' : (perms.maintain ? 'MAINTAIN' : (perms.push ? 'WRITE' : (perms.pull ? 'READ' : 'NONE')))
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

  async function getBranchProtection(repo, branch) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const branchName = String(branch ?? '').trim()
    if (!branchName) throw new Error('分支名不能为空')
    try {
      const protection = await rest('GET', `/repos/${norm}/branches/${encodeURIComponent(branchName)}/protection`)
      return { ok: true, protected: true, repo: norm, branch: branchName, protection }
    } catch (err) {
      if (err?.status === 404) {
        return { ok: true, protected: false, status: 404, repo: norm, branch: branchName, protection: null }
      }
      if (isPermissionError(err)) {
        return {
          ok: false,
          protected: null,
          fallbackToHooks: true,
          status: err?.status || 403,
          reason: err?.message || 'HTTP 403/权限不足，无法读取分支保护设置',
          repo: norm,
          branch: branchName,
        }
      }
      throw err
    }
  }

  async function applyBranchProtectionSwitchA(repo, branch, opts = {}) {
    const norm = normalizeGitHubRepo(repo)
    if (!norm) throw new Error(`无效的 GitHub 仓库名：${repo}`)
    const branchName = String(branch ?? '').trim()
    if (!branchName) throw new Error('分支名不能为空')
    const payload = buildSwitchABranchProtectionPayload(opts)
    try {
      const protection = await rest('PUT', `/repos/${norm}/branches/${encodeURIComponent(branchName)}/protection`, { body: payload })
      return { ok: true, repo: norm, branch: branchName, mode: 'switch-a', payload, protection }
    } catch (err) {
      if (isPermissionError(err)) {
        return {
          ok: false,
          fallbackToHooks: true,
          status: err?.status || 403,
          reason: err?.message || 'HTTP 403 或权限/计划受限，无法写入分支保护，请降级改用本地 .githooks/pre-push',
          repo: norm,
          branch: branchName,
          payload,
        }
      }
      throw err
    }
  }

  return {
    channel: resolvedChannel,
    rest,
    getRepoPermissions,
    getBranchProtection,
    applyBranchProtectionSwitchA,
  }
}

export {
  classifyTopologyIdentity as classifyWorkspaceIdentity,
  createEngineGitHubClient as createGitHubClient,
  createEngineGitHubClient as createPlatformClient,
  probeEngineGitHubEnv as probeGitHubEnv,
  probeTopologyEnv as probePlatformEnv,
  resolveTopologyIdentity as resolveWorkspaceIdentity,
}
