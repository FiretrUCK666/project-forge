/**
 * github.mjs —— GitHub 平台模式标志、单源五态身份判定与 HostingProvider 适配器。
 *
 * 身份分类纯核心与底层探测统一复用 `kit/skills/lib/platform.mjs` 与 `platform-probe.mjs`。
 */

import {
  classifyWorkspaceIdentity as kitClassifyWorkspaceIdentity,
  detectGitModeMarkers,
  hasForkModeMarker,
  hasLocalOnlyMarker,
  hasStandaloneModeMarker,
} from '../../../kit/skills/lib/platform.mjs'
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
  detectGitModeMarkers,
  detectRemoteProtocol,
  hasForkModeMarker,
  hasLocalOnlyMarker,
  hasStandaloneModeMarker,
  normalizeGitHubRepo,
  probeGitHubEnv,
}

/**
 * 纯函数：双轴五态工作区身份判定（单源委托 `kit/skills/lib/platform.mjs`）。
 * 五态：`local-only` | `contributor-fork` | `clone-readonly` | `maintainer` | `undetermined`
 */
export function classifyWorkspaceIdentity(opts = {}) {
  const sshHostMap = opts.sshHostMap === false ? {} : (opts.sshHostMap ?? parseSshConfigHostMap())
  return kitClassifyWorkspaceIdentity({ ...opts, sshHostMap })
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
    milestones: true,
    branchProtection: true,
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
