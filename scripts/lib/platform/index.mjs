/**
 * 平台适配入口。
 * 单源导出 5 方言（GitHub/GitLab/GitCode/Gitee/Gitea）+ `generic-git` 安全降级、10 键能力矩阵与多远端拓扑解析。
 */

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  GITHUB_PROVIDER,
  buildNonInteractiveEnv,
  buildOneClickPrUrl,
  createGitHubClient,
  createGitHubClient as createPlatformClient,
  detectGitModeMarkers,
  detectRemoteProtocol,
  hasForkModeMarker,
  hasLocalOnlyMarker,
  hasStandaloneModeMarker,
  normalizeGitHubRepo,
  probeGitHubEnv,
} from './github.mjs'

export {
  BUILTIN_PROVIDER_IDS,
  CAPABILITY_KEYS,
  GENERIC_GIT_PROVIDER,
  GITCODE_PROVIDER,
  GITEA_PROVIDER,
  GITEE_PROVIDER,
  GITLAB_PROVIDER,
  NONE_CAPABILITIES,
  classifyTopologyIdentity as classifyWorkspaceIdentity,
  getHostingProvider,
  listHostingProviders,
  normalizeDeclaredRepo,
  parseSshConfigHostMap,
  probeTopologyEnv as probePlatformEnv,
  registerHostingProvider,
  resolveRemoteDescriptor,
  resolveRemotesTopology,
  resolveTopologyIdentity as resolveWorkspaceIdentity,
} from './registry.mjs'

export {
  createProviderClient,
  resolveRemoteTarget,
} from '../../../kit/skills/lib/platform.mjs'
