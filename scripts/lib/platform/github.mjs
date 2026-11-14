/**
 * github.mjs —— GitHub 平台模式标志、双轴五态身份判定、HostingProvider 适配器及统一对外出口。
 *
 * 全程禁交互（`GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=echo` / `SSH_ASKPASS_REQUIRE=never` /
 * `GCM_INTERACTIVE=never` / `GH_PROMPT_DISABLED=1`），零第三方依赖。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { githubRepoPath, parseSshConfigHostMap } from '../text.mjs'
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  buildNonInteractiveEnv,
  buildOneClickPrUrl,
  createGitHubClient,
  defaultRunCommand,
  detectRemoteProtocol,
  normalizeGitHubRepo,
} from './github-client.mjs'
import { probeGitHubEnv, probeSshTransport } from './github-probe.mjs'

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  buildNonInteractiveEnv,
  buildOneClickPrUrl,
  createGitHubClient,
  detectRemoteProtocol,
  normalizeGitHubRepo,
  probeGitHubEnv,
}

/**
 * 解析当前目录对应的 `.git` 实际目录与公共目录（兼容普通仓库与 worktree）。
 */
function resolveGitDirs(cwd) {
  if (!cwd) return []
  const dotGit = join(cwd, '.git')
  if (!existsSync(dotGit)) return []
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return [dotGit]
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (!m) return []
      const rawDir = m[1].trim()
      const gitDir = isAbsolute(rawDir) ? rawDir : resolve(cwd, rawDir)
      const dirs = [gitDir]
      const commondirFile = join(gitDir, 'commondir')
      if (existsSync(commondirFile)) {
        const relCommon = readFileSync(commondirFile, 'utf8').trim()
        const commonDir = isAbsolute(relCommon) ? relCommon : resolve(gitDir, relCommon)
        if (commonDir !== gitDir) dirs.push(commonDir)
      }
      return dirs
    }
  } catch {
    return []
  }
  return []
}

function hasGitModeMarker(cwd, markerName) {
  return resolveGitDirs(cwd).some((dir) => existsSync(join(dir, markerName)))
}

/** 检查目标仓库是否存在 `.git/pf-local-mode` 强制纯本地标记。 */
export function hasLocalOnlyMarker(cwd) {
  return hasGitModeMarker(cwd, 'pf-local-mode')
}

/** 检查目标仓库是否存在 `.git/pf-fork-mode` 强制 Fork 协作标记。 */
export function hasForkModeMarker(cwd) {
  return hasGitModeMarker(cwd, 'pf-fork-mode')
}

/** 检查目标仓库是否存在 `.git/pf-standalone-mode` 强制独立项目维护者标记。 */
export function hasStandaloneModeMarker(cwd) {
  return hasGitModeMarker(cwd, 'pf-standalone-mode')
}

/** 读取 `.git/pf-{local,fork,standalone}-mode` 三类本地模式标志。 */
export function detectGitModeMarkers(cwd) {
  const dirs = resolveGitDirs(cwd)
  return {
    localMode: dirs.some((d) => existsSync(join(d, 'pf-local-mode'))),
    forkMode: dirs.some((d) => existsSync(join(d, 'pf-fork-mode'))),
    standaloneMode: dirs.some((d) => existsSync(join(d, 'pf-standalone-mode'))),
  }
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

const TEAM_PROBE_HINT = '如你是仓库团队或组织协作者且尚未提交过代码，可追加 --probe-auth（或运行 flow.mjs inspect --probe-auth）探测 GitHub 写权限以确认 maintainer'

function classifyWorkspaceIdentityCore({
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
    return { role: 'local-only', reason: '存在 .git/pf-local-mode 标记：按纯本地项目处置' }
  }
  const primaryRemoteUrl = gitFacts.remoteUrls?.origin
    ?? (gitFacts.remoteUrls && typeof gitFacts.remoteUrls === 'object' ? Object.values(gitFacts.remoteUrls).find(Boolean) : undefined)
    ?? gitFacts.remote
  if (gitFacts.present !== true || !primaryRemoteUrl) {
    return { role: 'local-only', reason: '还没有配置远端仓库：按纯本地工作区处置' }
  }
  if (forkMode === true) {
    return { role: 'contributor-fork', reason: '存在 .git/pf-fork-mode 标记：按贡献者 Fork 协作处置' }
  }
  if (standaloneMode === true) {
    return {
      role: 'maintainer',
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
 * 五态：`local-only` | `contributor-fork` | `clone-readonly` | `maintainer` | `undetermined`
 */
export function classifyWorkspaceIdentity(opts = {}) {
  const res = classifyWorkspaceIdentityCore(opts)
  if (res.role !== 'clone-readonly' && res.role !== 'undetermined') return res
  const { gitFacts = {}, declaredRepo, probeApi, localMode = false, forkMode = false, standaloneMode = false, sshHostMap } = opts
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const primaryRemoteUrl = gitFacts.remoteUrls?.origin
    ?? (gitFacts.remoteUrls && typeof gitFacts.remoteUrls === 'object' ? Object.values(gitFacts.remoteUrls).find(Boolean) : undefined)
    ?? gitFacts.remote
  if (localMode === true || forkMode === true || standaloneMode === true || gitFacts.present !== true || !primaryRemoteUrl) return res
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
 * 解析当前工作区身份（先读 `.git/pf-{local,fork,standalone}-mode`，可选查询 API 权限，再做双轴五态分类）。
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
  forkMode,
  standaloneMode,
  sshHostMap,
  fetchApi = false,
} = {}) {
  const markers = cwd ? detectGitModeMarkers(cwd) : { localMode: false, forkMode: false, standaloneMode: false }
  const effectiveLocalMode = typeof localMode === 'boolean' ? localMode : markers.localMode
  const effectiveForkMode = typeof forkMode === 'boolean' ? forkMode : markers.forkMode
  const effectiveStandaloneMode = typeof standaloneMode === 'boolean' ? standaloneMode : markers.standaloneMode
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const primaryRemoteUrl = gitFacts.remoteUrls?.origin
    ?? (gitFacts.remoteUrls && typeof gitFacts.remoteUrls === 'object' ? Object.values(gitFacts.remoteUrls).find(Boolean) : undefined)
    ?? gitFacts.remote

  if (effectiveLocalMode || gitFacts.present !== true || !primaryRemoteUrl) {
    return classifyWorkspaceIdentity({
      gitFacts,
      declaredRepo,
      probeApi,
      localIdentity,
      localMode: effectiveLocalMode,
      forkMode: effectiveForkMode,
      standaloneMode: effectiveStandaloneMode,
      sshHostMap: effectiveHostMap,
    })
  }

  let resolvedProbeApi = probeApi
  if (!resolvedProbeApi && fetchApi && !effectiveForkMode && !effectiveStandaloneMode) {
    const originRepo = normalizeGitHubRepo(primaryRemoteUrl, effectiveHostMap)
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
    forkMode: effectiveForkMode,
    standaloneMode: effectiveStandaloneMode,
    sshHostMap: effectiveHostMap,
  })
}

/** 标准 HostingProvider 接口实现：GitHub 适配器（产品层唯一注册的托管平台）。 */
export const GITHUB_PROVIDER = Object.freeze({
  id: 'github',
  label: 'GitHub',
  capabilities: Object.freeze({
    api: true,
    pr: true,
    issues: true,
    releases: true,
    labels: true,
  }),
  matchRemote(remoteUrl, sshHostMap) {
    return Boolean(githubRepoPath(remoteUrl, sshHostMap))
  },
  normalizeRepo(remoteUrl, sshHostMap) {
    return normalizeGitHubRepo(remoteUrl, sshHostMap)
  },
  async probeTransport(ctx = {}) {
    const safeEnv = buildNonInteractiveEnv(ctx.env ?? process.env)
    return probeSshTransport({
      cwd: ctx.cwd ?? process.cwd(),
      env: safeEnv,
      timeoutMs: ctx.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
      runner: ctx.runner ?? defaultRunCommand,
      sshTargetHost: ctx.sshTargetHost ?? 'github.com',
    })
  },
  probeAuth(ctx = {}) {
    return probeGitHubEnv(ctx)
  },
  classifyIdentity(facts = {}) {
    return classifyWorkspaceIdentity(facts)
  },
  createClient(authCtx = {}) {
    return createGitHubClient(authCtx)
  },
})
