/**
 * platform.mjs —— 5 方言平台注册契约、SSH 别名解析、多远端目标解析与双端单源五态身份判定。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），底层网络与凭据探测复用 `./platform-probe.mjs`、
 * `./platform-http.mjs` 与 `./platform-providers.mjs`；未知主机优雅退化为 `generic-git`。
 */

import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { readJsonSafe, readTextSafe } from './git.mjs'
import {
  TEAM_PROBE_HINT, extractHostAndPath, githubRepoFull, githubRepoPath,
  normalizeGitHubRepo, parseRemoteUrlHost, parseSshConfigHostMap, probeGitHubEnvCore,
  probePlatformEnvCore, resolveProviderTokenEnv,
} from './platform-probe.mjs'
import {
  buildMultipartBody, isLanHost, platformHttpRequest, redactPlatformTokens,
  sanitizeFourByteChars, validateRequestUrl,
} from './platform-http.mjs'
import {
  buildDialectAuthHeaders, createProviderClient, filterOpenPrsByBranch, resolveGitLabMrHeadSha,
} from './platform-providers.mjs'
import { createGitHubClient, parseBodyRelations } from './github-client.mjs'
import {
  BUILTIN_PROVIDER_IDS, CAPABILITY_KEYS, GENERIC_GIT_PROVIDER, GITCODE_PROVIDER, GITEA_PROVIDER,
  GITEE_PROVIDER, GITHUB_PROVIDER, GITLAB_PROVIDER, NONE_CAPABILITIES, REQUIRED_PROVIDER_METHODS,
  getHostingProvider, listHostingProviders, normalizeMultiSegmentRepo, registerHostingProvider,
  resolveRemoteDescriptor, resolveRemoteTarget, validateHostingProvider,
} from './platform-registry.mjs'

export {
  BUILTIN_PROVIDER_IDS, CAPABILITY_KEYS, GENERIC_GIT_PROVIDER, GITCODE_PROVIDER, GITEA_PROVIDER,
  GITEE_PROVIDER, GITHUB_PROVIDER, GITLAB_PROVIDER, NONE_CAPABILITIES, REQUIRED_PROVIDER_METHODS,
  TEAM_PROBE_HINT, buildDialectAuthHeaders, buildMultipartBody, createProviderClient,
  filterOpenPrsByBranch, getHostingProvider, githubRepoFull, githubRepoPath, isLanHost,
  listHostingProviders, normalizeGitHubRepo, normalizeMultiSegmentRepo, parseSshConfigHostMap,
  platformHttpRequest, probePlatformEnvCore, redactPlatformTokens, registerHostingProvider,
  resolveGitLabMrHeadSha, resolveProviderTokenEnv, resolveRemoteDescriptor, resolveRemoteTarget,
  sanitizeFourByteChars, validateHostingProvider, validateRequestUrl,
}
export { lookupSshHost } from './platform-probe.mjs'
export {
  DEFAULT_PROBE_TIMEOUT_MS, buildOneClickPrUrl, detectRemoteProtocol,
  parseRemoteUrlHost, parseSshConfigDetails, probeSshKeyReadiness, probeSshTransport,
} from './platform-probe.mjs'
export {
  NON_API_CLIENT_TIERS, VERIFIED_API_TIERS, closeIssue, computeWriteBackFingerprint, createGitHubClient, createIssue,
  githubHttpsRequest, isVerifiedTier, listComments, listIssues, listOpenPrsByHead, parseBodyRelations,
  parseFlowInputs, parseIssueNumbers, parseMilestoneNumber, parsePfStateTags, parsePrNumber, removeLabel,
  resolveIdentityLayers, summarizeCommitChecks,
} from './github-client.mjs'

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
export function parseRemotesTopology(remoteOutput, sshHostMapOrOpts = parseSshConfigHostMap(), extraOpts = {}) {
  const isOptsObj = Boolean(
    sshHostMapOrOpts && typeof sshHostMapOrOpts === 'object' && !(sshHostMapOrOpts instanceof Map)
    && ('sshHostMap' in sshHostMapOrOpts || 'providerHint' in sshHostMapOrOpts || 'sshConfig' in sshHostMapOrOpts),
  )
  const descOpts = isOptsObj
    ? { ...sshHostMapOrOpts, ...(extraOpts?.providerHint ? { providerHint: extraOpts.providerHint } : {}) }
    : { sshHostMap: sshHostMapOrOpts, ...(extraOpts?.providerHint ? { providerHint: extraOpts.providerHint } : {}) }
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
    const desc = resolveRemoteDescriptor(effectiveUrl, descOpts)
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

/** 通过注册表适配器与通用远端规则归一声明仓库标识（不硬编码单一托管平台）。 */
export function normalizeDeclaredRepo(value, sshHostMap = parseSshConfigHostMap()) {
  const s = String(value ?? '').trim()
  if (!s || /^file:\/\//i.test(s)) return undefined
  for (const provider of listHostingProviders()) {
    try {
      if (provider.matchRemote(s, sshHostMap)) {
        const slug = provider.normalizeRepo(s, sshHostMap)
        if (slug) return slug
      }
    } catch { /* ignore failing adapter */ }
  }
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(s)
  if (bare && bare[1] !== '.' && bare[1] !== '..') {
    return `${bare[1]}/${bare[2]}`.toLowerCase()
  }
  const { host } = parseRemoteUrlHost(s)
  if (!host) return undefined
  const ext = extractHostAndPath(s)
  const rawPath = ext?.path ?? s.replace(/^[^/]+\//, '')
  const clean = String(rawPath ?? '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '').toLowerCase()
  return /^[^\s/]+(?:\/[^\s/]+)+$/.test(clean) ? clean : undefined
}

/** 从项目清单提取声明的源仓库（owner/name 或多段仓库标识）。 */
export function detectDeclaredRepo(repoRoot, sshHostMap = parseSshConfigHostMap()) {
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  if (pkg) {
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    const slug = normalizeDeclaredRepo(repo, sshHostMap)
    if (slug) return slug
  }
  const skillMd = readTextSafe(join(repoRoot, 'SKILL.md'))
  if (skillMd) {
    const m = /^[ \t]+source:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(skillMd)
    const slug = normalizeDeclaredRepo(m?.[1], sshHostMap)
    if (slug) return slug
  }
  const cargo = readTextSafe(join(repoRoot, 'Cargo.toml'))
  if (cargo) {
    const m = /^\s*repository\s*=\s*["']([^"']+)["']/m.exec(cargo)
    const slug = normalizeDeclaredRepo(m?.[1], sshHostMap)
    if (slug) return slug
  }
  const pyproject = readTextSafe(join(repoRoot, 'pyproject.toml'))
  if (pyproject) {
    const urls = /\[project\.urls\]([\s\S]*?)(?:\n\[|$)/.exec(pyproject)?.[1] ?? ''
    for (const key of ['Repository', 'Source', 'Homepage', 'Home']) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'mi').exec(urls)
      const slug = normalizeDeclaredRepo(m?.[1], sshHostMap)
      if (slug) return slug
    }
  }
  const gomod = readTextSafe(join(repoRoot, 'go.mod'))
  if (gomod) {
    const m = /^module\s+(\S+)/m.exec(gomod)
    const slug = normalizeDeclaredRepo(m?.[1], sshHostMap)
    if (slug) return slug
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

function resolveGitMarkerPaths(cwdOrGitDir, markerName) {
  if (!cwdOrGitDir) return []
  const candidates = []
  const direct = join(cwdOrGitDir, markerName)
  if (existsSync(direct)) candidates.push(direct)
  for (const dir of resolveGitDirs(cwdOrGitDir)) {
    const p = join(dir, markerName)
    if (existsSync(p) && !candidates.includes(p)) candidates.push(p)
  }
  return candidates
}

function resolveGitMarkerExists(cwdOrGitDir, markerName) {
  return resolveGitMarkerPaths(cwdOrGitDir, markerName).length > 0
}

function hasAnyRemoteInDirs(cwdOrGitDir) {
  const dirs = new Set([cwdOrGitDir, ...resolveGitDirs(cwdOrGitDir)].filter(Boolean))
  for (const d of dirs) {
    const cfg = readTextSafe(join(d, 'config'))
    if (cfg && /^\s*\[remote\s+"[^"]+"\]/m.test(cfg)) return true
  }
  return false
}

export function detectGitModeMarkers(cwdOrGitDir, opts = {}) {
  const localPaths = resolveGitMarkerPaths(cwdOrGitDir, 'pf-local-mode')
  const forkMode = resolveGitMarkerExists(cwdOrGitDir, 'pf-fork-mode')
  const standaloneMode = resolveGitMarkerExists(cwdOrGitDir, 'pf-standalone-mode')
  if (localPaths.length === 0) {
    return { localMode: false, staleNoRemote: false, localModeKind: null, staleLocalModePaths: [], forkMode, standaloneMode }
  }
  const hasRemote = typeof opts.hasRemote === 'boolean' ? opts.hasRemote : hasAnyRemoteInDirs(cwdOrGitDir)
  let effectiveLocal = false
  const stalePaths = []
  let localModeKind = null
  for (const p of localPaths) {
    const raw = (readTextSafe(p) ?? '').trim()
    let parsed = null
    if (raw.startsWith('{')) { try { parsed = JSON.parse(raw) } catch { parsed = null } }
    if (parsed && typeof parsed === 'object' && parsed.mode === 'no-remote') {
      if (hasRemote) stalePaths.push(p)
      else { effectiveLocal = true; localModeKind = 'no-remote' }
    } else {
      effectiveLocal = true
      localModeKind = 'readonly-override'
    }
  }
  return {
    localMode: effectiveLocal,
    staleNoRemote: !effectiveLocal && stalePaths.length > 0,
    localModeKind: effectiveLocal ? localModeKind : (stalePaths.length > 0 ? 'no-remote' : null),
    staleLocalModePaths: stalePaths,
    forkMode,
    standaloneMode,
  }
}

export function cleanStaleLocalModeMarker(cwdOrGitDir, opts = {}) {
  const markers = detectGitModeMarkers(cwdOrGitDir, opts)
  if (!markers.staleNoRemote || markers.staleLocalModePaths.length === 0) return { cleaned: false, removed: [] }
  const removed = []
  for (const p of markers.staleLocalModePaths) {
    try { unlinkSync(p); removed.push(p) } catch { /* ignore */ }
  }
  return { cleaned: removed.length > 0, removed }
}

export function hasLocalOnlyMarker(cwdOrGitDir, opts = {}) {
  return detectGitModeMarkers(cwdOrGitDir, opts).localMode
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
  cwd = null,
  repoRoot = null,
  remoteUrls = {},
  declaredRepo,
  gitIdentity = {},
  historyAuthors = [],
  commits = 0,
  externalPr,
  apiProbe,
  sshHostMap = parseSshConfigHostMap(),
  providerHint = null,
  apiBaseHint = null,
  env = process.env,
  agentsText = null,
} = {}) {
  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const effectiveCwd = cwd ?? repoRoot ?? (gitDir && /[\\/]\.git$/i.test(String(gitDir)) ? resolve(gitDir, '..') : null)
  const resolvedTarget = originRaw
    ? resolveRemoteTarget(remoteUrls, { declaredRepo, sshHostMap, providerHint, apiBaseHint, env, agentsText, cwd: effectiveCwd })
    : null
  if (externalPr) {
    const extProvider = resolvedTarget?.providerId && resolvedTarget.providerId !== 'none' ? resolvedTarget.providerId : 'github'
    return {
      role: 'inbound-external-pr',
      providerId: extProvider,
      ...(resolvedTarget?.capabilities ? { capabilities: resolvedTarget.capabilities } : {}),
      reason: `审阅外部传入 PR #${externalPr}`,
    }
  }
  const hasRemote = Boolean(originRaw)
  const markers = resolveGitModeMarkersCompat(gitDir, { hasRemote })
  if (markers.localMode) {
    return { role: 'local-only', providerId: 'none', reason: '已显式启用本地模式（.git/pf-local-mode）' }
  }
  if (!originRaw) {
    return { role: 'local-only', providerId: 'none', reason: '仓库没有配置任何远端' }
  }

  const descriptor = resolvedTarget ?? resolveRemoteDescriptor(originRaw, sshHostMap)
  const providerId = descriptor.providerId
  if (markers.forkMode) {
    return { role: 'contributor-fork', providerId, capabilities: descriptor.capabilities, reason: '已选择 Fork 协作模式（.git/pf-fork-mode）' }
  }
  if (markers.standaloneMode) {
    return { role: 'maintainer', providerId, capabilities: descriptor.capabilities, collaborationScope: 'owner', reason: '已选择独立项目模式（.git/pf-standalone-mode）' }
  }

  if (providerId !== 'github') {
    if (providerId !== 'generic-git' && providerId !== 'none') {
      if (remoteUrls.upstream && remoteUrls.upstream !== originRaw) {
        return { role: 'contributor-fork', providerId, capabilities: descriptor.capabilities, reason: `存在独立 upstream 与 origin（${providerId}）` }
      }
      if (hasWritePerm(apiProbe)) {
        return { role: 'maintainer', providerId, capabilities: descriptor.capabilities, collaborationScope: 'owner', reason: `${providerId} 远端具备写权限` }
      }
      if (hasReadOnlyPerm(apiProbe)) {
        return { role: 'clone-readonly', providerId, capabilities: descriptor.capabilities, reason: `${providerId} 远端当前凭据仅具只读权限` }
      }
      const hist = matchAuthorsHistory(historyAuthors, { userName: gitIdentity.name, userEmail: gitIdentity.email })
      if (commits > 0 && historyAuthors.length > 0 && !hist.anyMatch) {
        return { role: 'clone-readonly', providerId, capabilities: descriptor.capabilities, reason: `${providerId} 克隆仓历史作者与当前配置署名不匹配` }
      }
      return { role: 'maintainer', providerId, capabilities: descriptor.capabilities, collaborationScope: 'owner', reason: `${providerId} 远端已匹配且按维护者协作` }
    }
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

function resolveGitModeMarkersCompat(gitDir, opts = {}) {
  return gitDir ? detectGitModeMarkers(gitDir, opts) : { localMode: false, staleNoRemote: false, forkMode: false, standaloneMode: false }
}

/**
 * 要在平台上**写东西**之前用它探测。
 *
 * 与只读勘察只差一点：这里必须联网。「能不能写」不联网答不出来，
 * 而答不出来时若静默降级成本地记账，调用方会以为写成功了。
 *
 * 判断标准一句话：这次调用之后平台上的状态会不会变。会，就用这个。
 */
export async function probeForWrite(options = {}) {
  return probePlatformEnv({ ...options, probeNetwork: true })
}

/** 统一多方言惰性平台探测与客户端装配（GitHub 走完整双轨探针，其余 4 方言走统一协议适配器）。 */
export async function probePlatformEnv(options = {}) {
  const {
    cwd = process.cwd(), remoteUrls = {}, sshHostMap = parseSshConfigHostMap(),
    providerHint = null, apiBaseHint = null, env = process.env, agentsText = null,
    probeNetwork = false, verifyToken = false, offline, runner, httpRequest,
  } = options
  const target = resolveRemoteTarget(remoteUrls, { sshHostMap, providerHint, apiBaseHint, env, agentsText, cwd })
  if (target.providerId === 'none' || target.providerId === 'github' || target.providerId === 'generic-git') {
    return probeGitHubEnv({ ...options, sshHostMap })
  }
  const core = await probePlatformEnvCore({
    providerId: target.providerId, cwd, remoteUrls, host: target.host, apiBaseUrl: target.apiBaseUrl,
    repoSlug: target.repoSlug, probeNetwork, verifyToken, offline, runner, httpRequest, env,
  })
  return {
    env: {
      hasRemote: true, providerId: target.providerId, origin: target.repoSlug, host: target.host,
      apiBaseUrl: target.apiBaseUrl, isLan: target.isLan, protocol: core.parsedOrigin?.protocol ?? null,
      trackA: {
        ssh: core.sshWorks ? `available:${core.ssh.port}` : (core.ssh.state === 'unprobed' ? 'unprobed' : 'unavailable'),
        https: core.httpsPublic.hasToken || core.httpsPublic.state === 'available' ? 'available' : core.httpsPublic.state,
        remediationCmd: core.remediationCmd ?? null,
      },
      trackB: {
        tier: core.apiChannel.tier, ghCli: false,
        ...(core.effectiveLogin ? { login: core.effectiveLogin } : {}),
        hasToken: Boolean(core.memoryToken && core.tokenVerified),
      },
    },
    client: createProviderClient({
      providerId: target.providerId, apiBaseUrl: target.apiBaseUrl, repoSlug: target.repoSlug,
      token: core.tokenVerified ? core.memoryToken : null, remoteName: target.pushRemote || 'origin',
      repoRoot: cwd, login: core.effectiveLogin, ...(httpRequest ? { httpRequest } : {}), ...(runner ? { runner } : {}),
    }),
  }
}

/**
 * 惰性双轨平台环境探测并返回自包含客户端实例（默认 `probeNetwork = false` 不派生外网子进程）。
 */
export async function probeGitHubEnv({
  cwd = process.cwd(),
  remoteUrls = {},
  branch,
  defaultBranch = null,
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
        hasRemote: true, providerId: 'generic-git', origin: descriptor.repoSlug ?? originRaw,
        host: ext?.host ?? null, protocol: proto,
        trackA: { ssh: 'unprobed', https: 'unprobed', remediationCmd: null },
        trackB: { tier: 'generic-git', ghCli: false, hasToken: false },
      },
      client: createGitHubClient({ tier: 'offline', cwd }),
    }
  }

  const core = await probeGitHubEnvCore({
    cwd, remoteUrls, branch, defaultBranch, probeNetwork, verifyToken,
    mcpAvailable, offline, runner, httpRequest, env, sshHostMap,
  })

  const sshState = core.ssh.state === 'available' || core.ssh.state === 'port443-only'
    ? `available:${core.ssh.port}`
    : (core.ssh.state === 'unprobed' ? 'unprobed' : 'unavailable')
  const httpsState = core.httpsPublic.hasToken || core.httpsPublic.state === 'available'
    ? 'available'
    : (core.httpsPublic.state === 'unprobed' ? 'unprobed' : 'no-credential')

  const resultEnv = {
    hasRemote: true, providerId: 'github',
    origin: core.originRepo ? (githubRepoFull(originRaw, sshHostMap) ?? core.originRepo) : null,
    protocol: core.parsedOrigin?.protocol ?? null,
    trackA: {
      ssh: sshState, ...(core.ssh.login ? { sshLogin: core.ssh.login } : {}),
      https: httpsState, ...(core.httpsPublic.username ? { httpsUsername: core.httpsPublic.username } : {}),
      remediationCmd: core.remediationCmd ?? null,
    },
    trackB: {
      tier: core.apiChannel.tier, ghCli: Boolean(core.ghCli.authenticated),
      ...(core.effectiveLogin ? { login: core.effectiveLogin } : {}),
      hasToken: Boolean(core.memoryToken && core.tokenVerified),
    },
  }

  return {
    env: resultEnv,
    client: createGitHubClient({
      tier: core.apiChannel.tier, cwd,
      token: core.tokenVerified ? core.memoryToken : null, login: core.effectiveLogin,
    }),
  }
}
