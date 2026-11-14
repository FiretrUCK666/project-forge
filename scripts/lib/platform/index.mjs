/**
 * 平台适配入口。
 * 产品层唯一注册并导出 GitHub 适配器，同时经注册表提供 `generic-git` 安全降级与多远端拓扑解析。
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
  GENERIC_GIT_PROVIDER,
  classifyTopologyIdentity as classifyWorkspaceIdentity,
  getHostingProvider,
  listHostingProviders,
  parseSshConfigHostMap,
  probeTopologyEnv as probePlatformEnv,
  registerHostingProvider,
  resolveRemoteDescriptor,
  resolveRemotesTopology,
  resolveTopologyIdentity as resolveWorkspaceIdentity,
} from './registry.mjs'
