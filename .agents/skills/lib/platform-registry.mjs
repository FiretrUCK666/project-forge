/**
 * platform-registry.mjs —— 双端共享的 HostingProvider 注册表、8 键能力契约与远端描述符解析。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 `kit/skills/lib/platform.mjs` 与
 * `scripts/lib/platform/` 共同单源复用，严守 `arch-rules` 单向依赖边界。
 */

import { parseBodyRelations } from './github-parse.mjs'
import {
  extractHostAndPath,
  lookupSshHost,
  normalizeGitHubRepo,
  parseRemoteUrlHost,
  parseSshConfigHostMap,
} from './platform-probe.mjs'

export const NONE_CAPABILITIES = Object.freeze({
  api: false,
  pr: false,
  issues: false,
  releases: false,
  labels: false,
  milestones: false,
  branchProtection: false,
  mention: false,
})

export const GENERIC_GIT_PROVIDER = Object.freeze({
  id: 'generic-git',
  label: 'Generic Git Remote',
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

export const GITHUB_PROVIDER = Object.freeze({
  id: 'github',
  label: 'GitHub',
  capabilities: Object.freeze({
    api: true,
    pr: true,
    issues: true,
    releases: true,
    labels: true,
    milestones: true,
    branchProtection: true,
    mention: true,
  }),
  matchRemote(remoteUrl, sshHostMap) {
    const ext = extractHostAndPath(remoteUrl)
    if (!ext) return false
    const effective = resolveEffectiveHost(ext.host, sshHostMap)
    return effective === 'github.com' || effective === 'www.github.com' || effective === 'ssh.github.com'
  },
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeGitHubRepo(remoteUrl, sshHostMap)
  },
  parseRelations(body) {
    return parseBodyRelations(body)
  },
  formatIssueRef(repo, number) {
    const n = Number(number)
    if (!Number.isInteger(n) || n <= 0) return ''
    return repo ? `${repo}#${n}` : `#${n}`
  },
})

/** 注册平台适配器（强校验必备方法契约，缺方法即 Fail-Closed 抛错）。 */
export function registerHostingProvider(provider) {
  const id = validateHostingProvider(provider)
  const normalized = Object.freeze({
    ...provider,
    id,
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

registerHostingProvider(GITHUB_PROVIDER)

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
    return { sshHostMap: optsOrMap, isUpstream: false }
  }
  if (optsOrMap && typeof optsOrMap === 'object') {
    const hasOptsKeys = 'sshHostMap' in optsOrMap || 'sshConfig' in optsOrMap || 'isUpstream' in optsOrMap
    if (hasOptsKeys) {
      const sshHostMap = optsOrMap.sshHostMap === false
        ? {}
        : (optsOrMap.sshHostMap ?? parseSshConfigHostMap(optsOrMap.sshConfig))
      return { sshHostMap, isUpstream: Boolean(optsOrMap.isUpstream) }
    }
    return { sshHostMap: optsOrMap, isUpstream: false }
  }
  return { sshHostMap: parseSshConfigHostMap(), isUpstream: false }
}

/** 解析单个远端地址或条目对象的平台归属（命中已注册适配器或安全退化为 generic-git）。 */
export function resolveRemoteDescriptor(remoteInput, optsOrMap) {
  const { sshHostMap, isUpstream: optUpstream } = parseDescriptorOptions(optsOrMap)

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
      isLocal: true,
      repoSlug: normalizeGenericRepo(probeUrl),
      capabilities: GENERIC_GIT_PROVIDER.capabilities,
      isUpstream,
    }
  }

  for (const provider of PROVIDER_REGISTRY.values()) {
    try {
      if (provider.matchRemote(probeUrl, sshHostMap)) {
        return {
          ...(name ? { name } : {}),
          url: probeUrl,
          fetchUrl,
          pushUrl,
          protocol,
          ...(rawHost ? { rawHost } : {}),
          ...(resolvedHost ? { resolvedHost } : {}),
          ...(sshAlias ? { sshAlias } : {}),
          providerId: provider.id,
          repoSlug: provider.normalizeRepo(probeUrl, sshHostMap),
          capabilities: provider.capabilities,
          isUpstream,
        }
      }
    } catch { /* ignore failing adapter */ }
  }

  const ext = extractHostAndPath(probeUrl)
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
    host: ext?.host ?? resolvedHost,
    repoSlug: fallbackSlug,
    capabilities: GENERIC_GIT_PROVIDER.capabilities,
    isUpstream,
  }
}
