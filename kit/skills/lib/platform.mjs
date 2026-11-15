/**
 * platform.mjs —— 平台注册契约、SSH 别名解析、多远端拓扑与双端单源五态身份判定。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），底层网络与凭据探测复用 `./platform-probe.mjs`。
 * 产品层注册表仅注册 GitHub 适配器，未知主机优雅退化为 `generic-git` 安全放行本地研发流。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { readJsonSafe, readTextSafe } from './git.mjs'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  TEAM_PROBE_HINT,
  buildOneClickPrUrl,
  detectRemoteProtocol,
  extractHostAndPath,
  githubRepoFull,
  githubRepoPath,
  lookupSshHost,
  normalizeGitHubRepo,
  parseRemoteUrlHost,
  parseSshConfigDetails,
  parseSshConfigHostMap,
  probeGitHubEnvCore,
  probeSshKeyReadiness,
  probeSshTransport,
} from './platform-probe.mjs'
import {
  createGitHubClient, createIssue, githubHttpsRequest, isInternalAgentSlug,
  listComments, listOpenPrsByHead, parseBodyRelations, parseFlowInputs, parseIssueNumbers,
  parsePfStateTags, parsePrNumber, removeLabel, resolveContributorIdentity,
  summarizeCommitChecks,
} from './github-client.mjs'

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  TEAM_PROBE_HINT,
  buildOneClickPrUrl,
  createGitHubClient, createIssue, githubHttpsRequest, isInternalAgentSlug,
  detectRemoteProtocol,
  githubRepoFull,
  githubRepoPath,
  listComments, listOpenPrsByHead, parseBodyRelations, parseFlowInputs, parseIssueNumbers,
  parsePfStateTags, parsePrNumber, removeLabel, resolveContributorIdentity,
  lookupSshHost,
  normalizeGitHubRepo,
  parseRemoteUrlHost,
  parseSshConfigDetails,
  parseSshConfigHostMap,
  probeSshKeyReadiness,
  probeSshTransport,
  summarizeCommitChecks,
}

export const GENERIC_GIT_PROVIDER = Object.freeze({
  id: 'generic-git',
  label: 'Generic Git Remote',
  capabilities: Object.freeze({ api: false, pr: false, issues: false, releases: false, labels: false }),
})

const PROVIDER_REGISTRY = new Map()

function resolveEffectiveHost(host, sshHostMap) {
  const h = String(host ?? '').toLowerCase()
  if (!h) return ''
  const mapped = lookupSshHost(sshHostMap, h)
  return mapped ? String(mapped).toLowerCase() : h
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
    return normalizeGitHubRepo(remoteUrl, sshHostMap)
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

function resolveGitDirs(cwdOrGitDir) {
  if (!cwdOrGitDir) return []
  const dotGit = join(cwdOrGitDir, '.git')
  if (!existsSync(dotGit)) return [cwdOrGitDir]
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return [dotGit]
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (!m) return [cwdOrGitDir]
      const rawDir = m[1].trim()
      const gitDir = isAbsolute(rawDir) ? rawDir : resolve(cwdOrGitDir, rawDir)
      const dirs = [gitDir]
      const commondirFile = join(gitDir, 'commondir')
      if (existsSync(commondirFile)) {
        const relCommon = readFileSync(commondirFile, 'utf8').trim()
        const commonDir = isAbsolute(relCommon) ? relCommon : resolve(gitDir, relCommon)
        if (commonDir !== gitDir) dirs.push(commonDir)
      }
      return dirs
    }
  } catch { /* ignore */ }
  return [cwdOrGitDir]
}

function resolveGitMarkerExists(cwdOrGitDir, markerName) {
  if (!cwdOrGitDir) return false
  if (existsSync(join(cwdOrGitDir, markerName))) return true
  return resolveGitDirs(cwdOrGitDir).some((dir) => existsSync(join(dir, markerName)))
}

export function detectGitModeMarkers(cwdOrGitDir) {
  return {
    localMode: resolveGitMarkerExists(cwdOrGitDir, 'pf-local-mode'),
    forkMode: resolveGitMarkerExists(cwdOrGitDir, 'pf-fork-mode'),
    standaloneMode: resolveGitMarkerExists(cwdOrGitDir, 'pf-standalone-mode'),
  }
}

export function hasLocalOnlyMarker(cwdOrGitDir) {
  return resolveGitMarkerExists(cwdOrGitDir, 'pf-local-mode')
}

export function hasForkModeMarker(cwdOrGitDir) {
  return resolveGitMarkerExists(cwdOrGitDir, 'pf-fork-mode')
}

export function hasStandaloneModeMarker(cwdOrGitDir) {
  return resolveGitMarkerExists(cwdOrGitDir, 'pf-standalone-mode')
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
    if ((emailLow && ae && ae === emailLow) || (nameLow && an && an === nameLow)) matchedCount += 1
  }
  return {
    hasHistory: true,
    anyMatch: matchedCount > 0,
    allMatch: matchedCount === authors.length,
    matchedCount,
  }
}

function classifyGitHubIdentityCore({
  gitFacts = {},
  declaredRepo,
  probeApi,
  localIdentity = {},
  localMode = false,
  forkMode = false,
  standaloneMode = false,
  sshHostMap,
} = {}) {
  if (localMode === true) {
    return { role: 'local-only', providerId: 'none', reason: '存在 .git/pf-local-mode 标记：按纯本地项目处置' }
  }
  const primaryRemoteUrl = gitFacts.remoteUrls?.origin
    ?? (gitFacts.remoteUrls && typeof gitFacts.remoteUrls === 'object' ? Object.values(gitFacts.remoteUrls).find(Boolean) : undefined)
    ?? gitFacts.remote
  if (gitFacts.present === false || !primaryRemoteUrl) {
    return { role: 'local-only', providerId: 'none', reason: '还没有配置远端仓库：按纯本地工作区处置' }
  }
  if (forkMode === true) {
    return { role: 'contributor-fork', providerId: 'github', reason: '存在 .git/pf-fork-mode 标记：按贡献者 Fork 协作处置' }
  }
  if (standaloneMode === true) {
    return {
      role: 'maintainer',
      providerId: 'github',
      collaborationScope: 'owner',
      reason: '存在 .git/pf-standalone-mode 标记：按独立个人项目维护者处置',
    }
  }

  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const origin = normalizeGitHubRepo(primaryRemoteUrl, effectiveHostMap)
  const upstream = normalizeGitHubRepo(gitFacts.remoteUrls?.upstream, effectiveHostMap)
  const declared = normalizeGitHubRepo(declaredRepo, effectiveHostMap)

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
  const apiParent = normalizeGitHubRepo(probeApi?.parent ?? probeApi?.parentRepo, effectiveHostMap)

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

  if (upstreamLow && upstreamLow !== originLow) {
    if (apiReadOnly) {
      return { role: 'clone-readonly', providerId: 'github', reason: `upstream 指向 ${upstream}，但对 origin（${origin}）只有只读权限` }
    }
    return { role: 'contributor-fork', providerId: 'github', reason: `origin 指向 ${origin}，upstream 指向 ${upstream}` }
  }

  if (apiIsFork) {
    if (apiReadOnly && !isOwnerByCred) {
      return { role: 'clone-readonly', providerId: 'github', reason: `origin（${origin}）是他人 fork 且当前账号没有写入权限` }
    }
    if (!declaredLow || !apiParent || apiParent.toLowerCase() === declaredLow || declaredLow !== originLow) {
      return {
        role: 'contributor-fork',
        providerId: 'github',
        reason: apiParent ? `API 判定 ${origin} 是 ${apiParent} 的 fork` : `API 判定 ${origin} 是派生 fork`,
      }
    }
  }

  if (declaredLow && declaredLow !== originLow) {
    if (apiReadOnly && !isOwnerByCred) {
      return { role: 'clone-readonly', providerId: 'github', reason: `源仓库为 ${declared}，且对 origin（${origin}）没有写入权限` }
    }
    return { role: 'contributor-fork', providerId: 'github', reason: `项目声明的源仓库是 ${declared}，而 origin 是 ${origin}` }
  }

  if (apiReadOnly) {
    return { role: 'clone-readonly', providerId: 'github', reason: `探测到对仓库 ${origin} 仅具备只读权限或不可推送` }
  }

  if (apiWrite) {
    const isTeamCollaborator = Boolean(credLogin && credLogin.toLowerCase() !== originOwnerLow)
    const collaborationScope = isTeamCollaborator ? 'team-collaborator' : 'owner'
    return {
      role: 'maintainer',
      providerId: 'github',
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
      providerId: 'github',
      collaborationScope: 'owner',
      reason: `本机认证账号 ${credLogin} 与仓库所属者 ${origin.split('/')[0]} 一致`,
    }
  }

  if (!declaredLow && gitUserMatchesOwner && (!hasHistory || hist.anyMatch)) {
    return {
      role: 'maintainer',
      providerId: 'github',
      collaborationScope: 'owner',
      reason: `未声明源仓库，但本机 git user（${userName}）指向自有仓库 ${origin}`,
    }
  }

  if (declaredLow && declaredLow === originLow) {
    if (hist.anyMatch) {
      const isTeamCollaborator = Boolean(credLogin && credLogin.toLowerCase() !== originOwnerLow)
      return {
        role: 'maintainer',
        providerId: 'github',
        collaborationScope: isTeamCollaborator ? 'team-collaborator' : 'owner',
        reason: isTeamCollaborator
          ? `origin 与声明源仓库 ${origin} 一致，且提交历史作者与团队协作者（${credLogin}）匹配`
          : `origin 与声明源仓库 ${origin} 一致，且提交历史作者与当前 Git 身份匹配`,
      }
    }
    if (hasHistory && authors.length > 0) {
      return {
        role: 'clone-readonly',
        providerId: 'github',
        reason: `origin 与 ${origin} 一致，但历史提交非本机作者且无写权限证明（按只读克隆处置）`,
      }
    }
    return {
      role: 'undetermined',
      providerId: 'github',
      reason: `origin 与 ${origin} 一致，但缺少写入权限与提交作者证据，保守按贡献者处置`,
    }
  }

  if (hasHistory && authors.length > 0 && !hist.anyMatch) {
    return {
      role: 'clone-readonly',
      providerId: 'github',
      reason: `未声明源仓库，历史提交非本机作者且无写权限，按只读克隆 ${origin} 处置`,
    }
  }

  if (hist.hasHistory && hist.allMatch) {
    const isTeamCollaborator = Boolean(credLogin && credLogin.toLowerCase() !== originOwnerLow)
    return {
      role: 'maintainer',
      providerId: 'github',
      collaborationScope: isTeamCollaborator ? 'team-collaborator' : 'owner',
      reason: '未声明源仓库，但全部采样提交均由本机 Git 身份完成',
    }
  }

  return {
    role: 'undetermined',
    providerId: 'github',
    reason: '缺少源仓库声明或仓库写权限证据，无法确认是否为维护者',
  }
}

/** 双端单源 GitHub 五态分类纯函数（附加未探活 teamProbeHint 提示）。 */
export function classifyWorkspaceIdentity(opts = {}) {
  const res = classifyGitHubIdentityCore(opts)
  if (res.role !== 'clone-readonly' && res.role !== 'undetermined') return res
  const { gitFacts = {}, declaredRepo, probeApi, localMode = false, forkMode = false, standaloneMode = false, sshHostMap } = opts
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const primaryRemoteUrl = gitFacts.remoteUrls?.origin
    ?? (gitFacts.remoteUrls && typeof gitFacts.remoteUrls === 'object' ? Object.values(gitFacts.remoteUrls).find(Boolean) : undefined)
    ?? gitFacts.remote
  if (localMode === true || forkMode === true || standaloneMode === true || gitFacts.present === false || !primaryRemoteUrl) return res
  const originLow = normalizeGitHubRepo(primaryRemoteUrl, effectiveHostMap)?.toLowerCase()
  if (!originLow) return res
  const upstreamLow = normalizeGitHubRepo(gitFacts.remoteUrls?.upstream, effectiveHostMap)?.toLowerCase()
  if (upstreamLow && upstreamLow !== originLow) return res
  if (probeApi?.isFork === true) return res
  const declaredLow = normalizeGitHubRepo(declaredRepo, effectiveHostMap)?.toLowerCase()
  if (declaredLow && declaredLow !== originLow) return res
  const apiProbed = Boolean(probeApi && (hasWritePerm(probeApi) || hasReadOnlyPerm(probeApi) || probeApi.viewerPermission))
  if (apiProbed) return res
  return { ...res, teamProbeHint: TEAM_PROBE_HINT }
}

/**
 * 统一五态工作区身份判定（同时兼容套件侧参数与通用 git / 本地测试远端退化）。
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
  if (externalPr) {
    return { role: 'inbound-external-pr', providerId: 'github', reason: `审阅外部传入 PR #${externalPr}` }
  }
  const markers = resolveGitModeMarkersCompat(gitDir)
  if (markers.localMode) {
    return { role: 'local-only', providerId: 'none', reason: '已显式启用本地模式（.git/pf-local-mode）' }
  }

  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  if (!originRaw) {
    return { role: 'local-only', providerId: 'none', reason: '仓库没有配置任何远端' }
  }

  const descriptor = resolveRemoteDescriptor(originRaw, sshHostMap)
  const providerId = descriptor.providerId
  if (markers.forkMode) {
    return { role: 'contributor-fork', providerId, reason: '已选择 Fork 协作模式（.git/pf-fork-mode）' }
  }
  if (markers.standaloneMode) {
    return { role: 'maintainer', providerId, collaborationScope: 'owner', reason: '已选择独立项目模式（.git/pf-standalone-mode）' }
  }

  const origin = githubRepoPath(originRaw, sshHostMap)
  if (!origin) {
    if (descriptor.isLocal) {
      if (remoteUrls.upstream && remoteUrls.upstream !== originRaw) {
        return { role: 'contributor-fork', providerId: 'generic-git', reason: '本地测试远端存在独立的 upstream 与 origin' }
      }
      const hist = matchAuthorsHistory(historyAuthors, { userName: gitIdentity.name, userEmail: gitIdentity.email })
      if (commits > 0 && historyAuthors.length > 0 && !hist.anyMatch) {
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

  return classifyWorkspaceIdentity({
    gitFacts: { present: true, remoteUrls, commits, historyAuthors, identity: gitIdentity },
    declaredRepo,
    probeApi: apiProbe,
    localIdentity: { userName: gitIdentity.name, userEmail: gitIdentity.email, historyAuthors },
    sshHostMap,
  })
}

function resolveGitModeMarkersCompat(gitDir) {
  return gitDir ? detectGitModeMarkers(gitDir) : { localMode: false, forkMode: false, standaloneMode: false }
}

/**
 * 惰性双轨平台环境探测并返回自包含客户端实例（默认 `probeNetwork = false` 不派生外网子进程）。
 */
export async function probeGitHubEnv({
  cwd = process.cwd(),
  remoteUrls = {},
  branch,
  defaultBranch = 'main',
  probeNetwork = false,
  verifyToken = false,
  mcpAvailable,
  offline,
  runner,
  httpRequest,
  env = process.env,
  sshHostMap = parseSshConfigHostMap(),
} = {}) {
  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const descriptor = originRaw ? resolveRemoteDescriptor(originRaw, sshHostMap) : { providerId: 'none' }

  if (!originRaw) {
    return {
      env: {
        hasRemote: false,
        providerId: 'none',
        protocol: null,
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

  const core = await probeGitHubEnvCore({
    cwd,
    remoteUrls,
    branch,
    defaultBranch,
    probeNetwork,
    verifyToken,
    mcpAvailable,
    offline,
    runner,
    httpRequest,
    env,
    sshHostMap,
  })

  const sshState = core.ssh.state === 'available' || core.ssh.state === 'port443-only'
    ? `available:${core.ssh.port}`
    : (core.ssh.state === 'unprobed' ? 'unprobed' : 'unavailable')
  const httpsState = core.httpsPublic.hasToken || core.httpsPublic.state === 'available'
    ? 'available'
    : (core.httpsPublic.state === 'unprobed' ? 'unprobed' : 'no-credential')

  const resultEnv = {
    hasRemote: true,
    providerId: 'github',
    origin: core.originRepo ? (githubRepoFull(originRaw, sshHostMap) ?? core.originRepo) : null,
    protocol: core.parsedOrigin?.protocol ?? null,
    trackA: {
      ssh: sshState,
      ...(core.ssh.login ? { sshLogin: core.ssh.login } : {}),
      https: httpsState,
      ...(core.httpsPublic.username ? { httpsUsername: core.httpsPublic.username } : {}),
      remediationCmd: core.remediationCmd ?? null,
    },
    trackB: {
      tier: core.apiChannel.tier,
      ghCli: Boolean(core.ghCli.authenticated),
      ...(core.effectiveLogin ? { login: core.effectiveLogin } : {}),
      hasToken: Boolean(core.memoryToken && core.tokenVerified),
    },
  }

  return {
    env: resultEnv,
    client: createGitHubClient({
      tier: core.apiChannel.tier,
      cwd,
      token: core.tokenVerified ? core.memoryToken : null,
      login: core.effectiveLogin,
    }),
  }
}
