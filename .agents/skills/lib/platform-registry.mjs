/**
 * platform-registry.mjs —— 双端共享的 HostingProvider 注册表、10 键能力矩阵、5 方言元数据与远端描述符解析。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零私域企业域名/账号/令牌硬编码，
 * 供 `kit/skills/lib/platform.mjs` 与 `scripts/lib/platform/` 共同单源复用，严守 `arch-rules` 单向依赖边界。
 */

import { parseBodyRelations } from './github-parse.mjs'
import { isLanHost } from './platform-http.mjs'
import {
  extractHostAndPath,
  lookupSshHost,
  normalizeGitHubRepo,
  parseRemoteUrlHost,
  parseSshConfigHostMap,
} from './platform-probe.mjs'

export const CAPABILITY_KEYS = Object.freeze([
  'api',
  'pr',
  'issues',
  'releases',
  'labels',
  'milestones',
  'branchProtection',
  'mention',
  'uploadAttachment',
  'checks',
])

export const NONE_CAPABILITIES = Object.freeze({
  api: false,
  pr: false,
  issues: false,
  releases: false,
  labels: false,
  milestones: false,
  branchProtection: false,
  mention: false,
  uploadAttachment: false,
  checks: false,
})

export const BUILTIN_PROVIDER_IDS = Object.freeze([
  'github',
  'gitlab',
  'gitcode',
  'gitee',
  'gitea',
])

/** 托管平台变更提案（PR / MR）模板候选路径单源（按优先级查找）。 */
export const PR_TEMPLATE_PATHS = Object.freeze([
  '.github/pull_request_template.md',
  '.gitlab/merge_request_templates/Default.md',
])

export const GENERIC_GIT_PROVIDER = Object.freeze({
  id: 'generic-git',
  label: 'Generic Git Remote',
  mrRefPattern: null,
  defaultApiBase: null,
  capabilities: NONE_CAPABILITIES,
})

export const REQUIRED_PROVIDER_METHODS = Object.freeze([
  'matchRemote',
  'normalizeRepo',
  'parseRelations',
  'formatIssueRef',
])

const PROVIDER_REGISTRY = new Map()

function resolveEffectiveHost(host, sshHostMap) {
  const h = String(host ?? '').toLowerCase()
  if (!h) return ''
  const mapped = lookupSshHost(sshHostMap, h)
  return mapped ? String(mapped).toLowerCase() : h
}

function defaultFormatIssueRef(repo, number) {
  const n = Number(number)
  if (!Number.isInteger(n) || n <= 0) return ''
  return repo ? `${repo}#${n}` : `#${n}`
}

/** 归一支持多级群组（`group/sub/repo`）的仓库标识；`allowMultiLevel=false` 时限定两段 `owner/repo`。 */
export function normalizeMultiSegmentRepo(remoteUrl, sshHostMap, { allowMultiLevel = true } = {}) {
  if (typeof remoteUrl !== 'string') return undefined
  const trimmed = remoteUrl.trim()
  if (!trimmed || /^file:\/\//i.test(trimmed)) return undefined

  const ext = extractHostAndPath(trimmed)
  if (ext) {
    const clean = ext.path.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()
    const segs = clean.split('/').filter(Boolean)
    if (segs.length < 2) return undefined
    if (!allowMultiLevel && segs.length !== 2) return undefined
    if (segs.some((s) => s === '.' || s === '..' || /\s/.test(s))) return undefined
    return segs.join('/')
  }

  const bareClean = trimmed.replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '')
  const segs = bareClean.split('/').filter(Boolean)
  if (segs.length < 2) return undefined
  if (!allowMultiLevel && segs.length !== 2) return undefined
  if (segs.some((s) => s === '.' || s === '..' || !/^[A-Za-z0-9_.-]+$/.test(s))) return undefined
  return segs.join('/').toLowerCase()
}

export function validateHostingProvider(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('HostingProvider 必须是非空对象')
  }
  const id = String(provider.id ?? '').trim().toLowerCase()
  if (!id || id === 'generic-git') {
    throw new Error(`非法的 HostingProvider id：「${id}」`)
  }
  const missing = REQUIRED_PROVIDER_METHODS.filter((m) => typeof provider[m] !== 'function')
  if (missing.length > 0) {
    throw new Error(`HostingProvider「${id}」缺少必备方法契约：${missing.join(', ')}`)
  }
  return id
}

function createHostMatcher(hosts) {
  const allowed = new Set(hosts.map((h) => h.toLowerCase()))
  return (remoteUrl, sshHostMap) => {
    const ext = extractHostAndPath(remoteUrl)
    if (!ext) return false
    const effective = resolveEffectiveHost(ext.host, sshHostMap)
    return allowed.has(effective)
  }
}

export const GITHUB_PROVIDER = Object.freeze({
  id: 'github',
  label: 'GitHub',
  mrRefPattern: 'refs/pull/{n}/head',
  defaultApiBase: 'https://api.github.com',
  tokenEnvVars: Object.freeze(['GH_TOKEN', 'GITHUB_TOKEN', 'PF_PLATFORM_TOKEN']),
  capabilities: Object.freeze({
    api: true,
    pr: true,
    issues: true,
    releases: true,
    labels: true,
    milestones: true,
    branchProtection: true,
    mention: true,
    uploadAttachment: false,
    checks: true,
  }),
  matchRemote: createHostMatcher(['github.com', 'www.github.com', 'ssh.github.com']),
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeGitHubRepo(remoteUrl, sshHostMap)
  },
  parseRelations(body) {
    return parseBodyRelations(body)
  },
  formatIssueRef: defaultFormatIssueRef,
})

export const GITLAB_PROVIDER = Object.freeze({
  id: 'gitlab',
  label: 'GitLab',
  mrRefPattern: 'refs/merge-requests/{n}/head',
  defaultApiBase: 'https://gitlab.com/api/v4',
  tokenEnvVars: Object.freeze(['GITLAB_TOKEN', 'GL_TOKEN', 'PF_PLATFORM_TOKEN']),
  capabilities: Object.freeze({
    api: true,
    pr: true,
    issues: true,
    releases: true,
    labels: true,
    milestones: true,
    branchProtection: true,
    mention: true,
    uploadAttachment: true,
    checks: true,
  }),
  matchRemote: createHostMatcher(['gitlab.com', 'www.gitlab.com']),
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeMultiSegmentRepo(remoteUrl, sshHostMap, { allowMultiLevel: true })
  },
  parseRelations(body) {
    return parseBodyRelations(body)
  },
  formatIssueRef: defaultFormatIssueRef,
})

export const GITCODE_PROVIDER = Object.freeze({
  id: 'gitcode',
  label: 'GitCode',
  mrRefPattern: 'refs/merge-requests/{n}/head',
  defaultApiBase: 'https://gitcode.com/api/v4',
  tokenEnvVars: Object.freeze(['GITCODE_TOKEN', 'GITLAB_TOKEN', 'PF_PLATFORM_TOKEN']),
  capabilities: Object.freeze({
    api: true,
    pr: true,
    issues: true,
    releases: true,
    labels: true,
    milestones: true,
    branchProtection: true,
    mention: true,
    uploadAttachment: true,
    checks: true,
  }),
  matchRemote: createHostMatcher(['gitcode.com', 'www.gitcode.com', 'gitcode.net', 'www.gitcode.net']),
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeMultiSegmentRepo(remoteUrl, sshHostMap, { allowMultiLevel: true })
  },
  parseRelations(body) {
    return parseBodyRelations(body)
  },
  formatIssueRef: defaultFormatIssueRef,
})

export const GITEE_PROVIDER = Object.freeze({
  id: 'gitee',
  label: 'Gitee',
  mrRefPattern: 'refs/pull/{n}/head',
  defaultApiBase: 'https://gitee.com/api/v5',
  tokenEnvVars: Object.freeze(['GITEE_TOKEN', 'PF_PLATFORM_TOKEN']),
  capabilities: Object.freeze({
    api: true,
    pr: true,
    issues: true,
    releases: true,
    labels: true,
    milestones: true,
    branchProtection: true,
    mention: true,
    uploadAttachment: false,
    checks: false,
  }),
  matchRemote: createHostMatcher(['gitee.com', 'www.gitee.com']),
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeMultiSegmentRepo(remoteUrl, sshHostMap, { allowMultiLevel: false })
  },
  parseRelations(body) {
    return parseBodyRelations(body)
  },
  formatIssueRef: defaultFormatIssueRef,
})

export const GITEA_PROVIDER = Object.freeze({
  id: 'gitea',
  label: 'Gitea',
  mrRefPattern: 'refs/pull/{n}/head',
  defaultApiBase: 'https://codeberg.org/api/v1',
  tokenEnvVars: Object.freeze(['GITEA_TOKEN', 'FORGEJO_TOKEN', 'CODEBERG_TOKEN', 'PF_PLATFORM_TOKEN']),
  capabilities: Object.freeze({
    api: true,
    pr: true,
    issues: true,
    releases: true,
    labels: true,
    milestones: true,
    branchProtection: true,
    mention: true,
    uploadAttachment: false,
    checks: true,
  }),
  matchRemote: createHostMatcher(['codeberg.org', 'www.codeberg.org']),
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeMultiSegmentRepo(remoteUrl, sshHostMap, { allowMultiLevel: false })
  },
  parseRelations(body) {
    return parseBodyRelations(body)
  },
  formatIssueRef: defaultFormatIssueRef,
})

/** 注册平台适配器（强校验必备方法契约，缺方法即 Fail-Closed 抛错）。 */
export function registerHostingProvider(provider) {
  const id = validateHostingProvider(provider)
  const normalized = Object.freeze({
    ...provider,
    id,
    mrRefPattern: provider.mrRefPattern ?? null,
    defaultApiBase: provider.defaultApiBase ?? null,
    capabilities: Object.freeze({
      ...NONE_CAPABILITIES,
      ...(provider.capabilities && typeof provider.capabilities === 'object' ? provider.capabilities : {}),
    }),
  })
  PROVIDER_REGISTRY.set(id, normalized)
  return normalized
}

/** 按 id 读取已注册的 HostingProvider（自动 trim + 小写；`'generic-git'` 返回内置兜底）。 */
export function getHostingProvider(id) {
  if (!id) return undefined
  const key = String(id).trim().toLowerCase()
  if (!key) return undefined
  if (key === 'generic-git') return GENERIC_GIT_PROVIDER
  return PROVIDER_REGISTRY.get(key)
}

/** 列出当前注册表中的 HostingProvider；默认不含 `generic-git` 兜底。 */
export function listHostingProviders({ includeFallback = false } = {}) {
  const list = [...PROVIDER_REGISTRY.values()]
  if (includeFallback) list.push(GENERIC_GIT_PROVIDER)
  return list
}

for (const builtin of [GITHUB_PROVIDER, GITLAB_PROVIDER, GITCODE_PROVIDER, GITEE_PROVIDER, GITEA_PROVIDER]) {
  registerHostingProvider(builtin)
}

/** 将通用 Git 远端地址（含多级群组路径或本地 file:// 路径）归一为仓库标识。 */
export function normalizeGenericRepo(remoteUrl) {
  if (typeof remoteUrl !== 'string') return undefined
  const trimmed = remoteUrl.trim()
  if (!trimmed) return undefined

  if (/^file:\/\//i.test(trimmed)) {
    const clean = trimmed.replace(/^file:\/\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
    const parts = clean.split('/').filter(Boolean)
    return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : parts[0] || undefined
  }

  let s = trimmed.toLowerCase()
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(s)
  if (hadScheme) {
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^[^@/]*@/, '').replace(/^[^/]+\//, '')
  } else {
    s = s.replace(/^[^@/]*@/, '')
    if (/^[^/:]+:/.test(s)) s = s.replace(/^[^/:]+:/, '')
    else s = s.replace(/^[^/]*\.[^/]*\//, '')
  }
  s = s.replace(/\.git$/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return /^[^\s/]+(?:\/[^\s/]+)+$/.test(s) ? s : undefined
}

function parseDescriptorOptions(optsOrMap) {
  if (optsOrMap instanceof Map) {
    return { sshHostMap: optsOrMap, isUpstream: false, providerHint: null }
  }
  if (optsOrMap && typeof optsOrMap === 'object') {
    const hasOptsKeys = 'sshHostMap' in optsOrMap
      || 'sshConfig' in optsOrMap
      || 'isUpstream' in optsOrMap
      || 'providerHint' in optsOrMap
    if (hasOptsKeys) {
      const sshHostMap = optsOrMap.sshHostMap === false
        ? {}
        : (optsOrMap.sshHostMap ?? parseSshConfigHostMap(optsOrMap.sshConfig))
      return {
        sshHostMap,
        isUpstream: Boolean(optsOrMap.isUpstream),
        providerHint: optsOrMap.providerHint ? String(optsOrMap.providerHint).trim().toLowerCase() : null,
      }
    }
    return { sshHostMap: optsOrMap, isUpstream: false, providerHint: null }
  }
  return { sshHostMap: parseSshConfigHostMap(), isUpstream: false, providerHint: null }
}

/** 解析单个远端地址或条目对象的平台归属（命中已注册适配器、显式 providerHint 或安全退化为 generic-git）。 */
export function resolveRemoteDescriptor(remoteInput, optsOrMap) {
  const { sshHostMap, isUpstream: optUpstream, providerHint } = parseDescriptorOptions(optsOrMap)

  let name
  let fetchUrl = ''
  let pushUrl = ''
  if (typeof remoteInput === 'string') {
    fetchUrl = remoteInput.trim()
    pushUrl = fetchUrl
  } else if (remoteInput && typeof remoteInput === 'object') {
    name = typeof remoteInput.name === 'string' && remoteInput.name.trim() ? remoteInput.name.trim() : undefined
    fetchUrl = String(remoteInput.fetchUrl ?? remoteInput.url ?? remoteInput.pushUrl ?? '').trim()
    pushUrl = String(remoteInput.pushUrl ?? remoteInput.fetchUrl ?? remoteInput.url ?? '').trim()
  }

  const probeUrl = fetchUrl || pushUrl
  const isUpstream = Boolean(optUpstream || name === 'upstream')
  if (!probeUrl) {
    return {
      ...(name ? { name } : {}),
      url: '',
      fetchUrl: '',
      pushUrl: '',
      protocol: 'unknown',
      providerId: 'none',
      mrRefPattern: null,
      repoSlug: undefined,
      capabilities: NONE_CAPABILITIES,
      isUpstream,
    }
  }

  const { protocol, host: rawHost } = parseRemoteUrlHost(probeUrl)
  const mappedHost = protocol === 'ssh' && rawHost ? lookupSshHost(sshHostMap, rawHost) : undefined
  const resolvedHost = mappedHost ? mappedHost.toLowerCase() : rawHost
  const sshAlias = mappedHost && rawHost && mappedHost.toLowerCase() !== rawHost ? rawHost : undefined

  const isLocal = protocol === 'file'
    || (!rawHost && !/^[a-z][a-z0-9+.-]*:\/\//i.test(probeUrl) && !/^[^@/]+@[^:]+:/i.test(probeUrl))
  if (isLocal) {
    return {
      ...(name ? { name } : {}),
      url: probeUrl,
      fetchUrl,
      pushUrl,
      protocol: protocol === 'file' ? 'file' : 'local',
      providerId: 'generic-git',
      mrRefPattern: null,
      isLocal: true,
      repoSlug: normalizeGenericRepo(probeUrl),
      capabilities: GENERIC_GIT_PROVIDER.capabilities,
      isUpstream,
    }
  }

  const ext = extractHostAndPath(probeUrl)
  const matchedProvider = (() => {
    for (const provider of PROVIDER_REGISTRY.values()) {
      try {
        if (provider.matchRemote(probeUrl, sshHostMap)) return provider
      } catch { /* ignore failing adapter */ }
    }
    if (providerHint && providerHint !== 'generic-git' && providerHint !== 'none') {
      return PROVIDER_REGISTRY.get(providerHint) ?? null
    }
    return null
  })()

  if (matchedProvider) {
    const slug = matchedProvider.normalizeRepo(probeUrl, sshHostMap)
      ?? normalizeMultiSegmentRepo(probeUrl, sshHostMap, { allowMultiLevel: true })
      ?? normalizeGenericRepo(probeUrl)
    return {
      ...(name ? { name } : {}),
      url: probeUrl,
      fetchUrl,
      pushUrl,
      protocol,
      ...(rawHost ? { rawHost } : {}),
      ...(resolvedHost ? { resolvedHost } : {}),
      ...(sshAlias ? { sshAlias } : {}),
      host: resolvedHost ?? ext?.host,
      ...(ext?.port ? { port: ext.port } : {}),
      providerId: matchedProvider.id,
      mrRefPattern: matchedProvider.mrRefPattern ?? null,
      repoSlug: slug,
      capabilities: matchedProvider.capabilities,
      isUpstream,
    }
  }

  const fallbackSlug = normalizeGenericRepo(probeUrl) ?? ext?.path?.replace(/\.git$/i, '').replace(/\/+$/, '')
  return {
    ...(name ? { name } : {}),
    url: probeUrl,
    fetchUrl,
    pushUrl,
    protocol,
    ...(rawHost ? { rawHost } : {}),
    ...(resolvedHost ? { resolvedHost } : {}),
    ...(sshAlias ? { sshAlias } : {}),
    providerId: 'generic-git',
    mrRefPattern: null,
    host: ext?.host ?? resolvedHost,
    ...(ext?.port ? { port: ext.port } : {}),
    repoSlug: fallbackSlug,
    capabilities: GENERIC_GIT_PROVIDER.capabilities,
    isUpstream,
  }
}

function extractAgentsHint(agentsText, key) {
  if (typeof agentsText !== 'string' || !agentsText) return null
  const m = new RegExp(`^\\s*-?\\s*\`?${key}\`?\\s*[:：]\\s*\`?([^\\s\`\\r\\n#]+)\`?`, 'mi').exec(agentsText)
  return m?.[1]?.trim() || null
}

function computeDialectApiBase(providerId, { targetUrl, host, port, isLan, apiBaseHint }) {
  if (apiBaseHint) return String(apiBaseHint).trim().replace(/\/+$/, '')
  if (!providerId || providerId === 'none' || providerId === 'generic-git') return null
  const provider = getHostingProvider(providerId)
  const cleanHost = String(host ?? '').trim().toLowerCase()
  const hostWithPort = port ? `${cleanHost}:${port}` : cleanHost
  const scheme = isLan && /^http:\/\//i.test(String(targetUrl ?? '')) ? 'http' : 'https'
  if (providerId === 'github') {
    return !cleanHost || /^(?:www\.|ssh\.)?github\.com$/.test(cleanHost)
      ? 'https://api.github.com'
      : `${scheme}://${hostWithPort}/api/v3`
  }
  if (providerId === 'gitlab' || providerId === 'gitcode') {
    return cleanHost ? `${scheme}://${hostWithPort}/api/v4` : (provider?.defaultApiBase ?? null)
  }
  if (providerId === 'gitee') return cleanHost ? `${scheme}://${hostWithPort}/api/v5` : (provider?.defaultApiBase ?? null)
  if (providerId === 'gitea') return cleanHost ? `${scheme}://${hostWithPort}/api/v1` : (provider?.defaultApiBase ?? null)
  return provider?.defaultApiBase ?? null
}

/**
 * 统一解析远端目标上下文：完整保留 GitLab/GitCode 多级群组（`group/sub/repo`）、
 * 自建实例环境变量/配置提示、Fork 上游路由以及 LAN/本地/离线识别。
 */
export function resolveRemoteTarget(remoteUrls = {}, {
  role = null,
  declaredRepo = null,
  sshHostMap,
  providerHint = null,
  apiBaseHint = null,
  env = process.env,
  agentsText = null,
} = {}) {
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const effectiveProviderHint = providerHint
    ?? env?.PF_PLATFORM_PROVIDER
    ?? extractAgentsHint(agentsText, 'platform-provider')
    ?? null
  const effectiveApiBaseHint = apiBaseHint
    ?? env?.PF_PLATFORM_API_BASE
    ?? extractAgentsHint(agentsText, 'platform-api-base')
    ?? null

  let originUrl = null
  let upstreamUrl = null
  let pushRemote = 'origin'
  if (typeof remoteUrls === 'string') {
    originUrl = remoteUrls.trim() || null
  } else if (remoteUrls && typeof remoteUrls === 'object') {
    const entries = Object.entries(remoteUrls).filter(([, v]) => typeof v === 'string' && v.trim())
    originUrl = remoteUrls.origin?.trim() || entries[0]?.[1]?.trim() || null
    pushRemote = remoteUrls.origin?.trim() ? 'origin' : (entries[0]?.[0] || 'origin')
    upstreamUrl = remoteUrls.upstream?.trim() || null
  }

  if (!originUrl && !upstreamUrl) {
    return {
      providerId: 'none',
      apiBaseUrl: null,
      repoSlug: declaredRepo ? (normalizeMultiSegmentRepo(declaredRepo, effectiveHostMap) ?? null) : null,
      host: null,
      isLan: false,
      isLocal: true,
      pushRemote: null,
      mrRefPattern: null,
      capabilities: NONE_CAPABILITIES,
      originUrl: null,
      upstreamUrl: null,
      targetUrl: null,
    }
  }

  const descOpts = { sshHostMap: effectiveHostMap, providerHint: effectiveProviderHint }
  const originDesc = originUrl ? resolveRemoteDescriptor(originUrl, descOpts) : null
  const upstreamDesc = upstreamUrl ? resolveRemoteDescriptor(upstreamUrl, descOpts) : null
  const useUpstream = Boolean(upstreamDesc && (role === 'contributor-fork' || upstreamUrl !== originUrl))
  const targetDesc = useUpstream ? upstreamDesc : originDesc
  const targetUrl = useUpstream ? upstreamUrl : originUrl
  const host = targetDesc?.resolvedHost ?? targetDesc?.host ?? null
  const isLocal = Boolean(targetDesc?.isLocal)
  const isLan = Boolean(!isLocal && host && isLanHost(host))
  const providerId = isLocal ? 'generic-git' : (targetDesc?.providerId ?? 'generic-git')
  const provider = getHostingProvider(providerId)
  const capabilities = provider?.capabilities ?? NONE_CAPABILITIES
  const apiBaseUrl = isLocal
    ? null
    : computeDialectApiBase(providerId, { targetUrl, host, port: targetDesc?.port, isLan, apiBaseHint: effectiveApiBaseHint })

  return {
    providerId,
    apiBaseUrl,
    repoSlug: targetDesc?.repoSlug ?? (declaredRepo ? (normalizeMultiSegmentRepo(declaredRepo, effectiveHostMap) ?? null) : null),
    host,
    isLan,
    isLocal,
    pushRemote,
    mrRefPattern: provider?.mrRefPattern ?? null,
    capabilities,
    originUrl,
    upstreamUrl,
    targetUrl,
  }
}
