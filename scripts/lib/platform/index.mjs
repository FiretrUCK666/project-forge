/**
 * 平台适配入口（当前唯一支持并锁定为 GitHub）。
 * 统一对外暴露环境探测、双轴五态工作区身份判定与平台客户端封装。
 */

export {
  DEFAULT_PROBE_TIMEOUT_MS,
  buildNonInteractiveEnv,
  buildOneClickPrUrl,
  classifyWorkspaceIdentity,
  createGitHubClient,
  createGitHubClient as createPlatformClient,
  detectRemoteProtocol,
  hasLocalOnlyMarker,
  normalizeGitHubRepo,
  probeGitHubEnv,
  probeGitHubEnv as probePlatformEnv,
  resolveWorkspaceIdentity,
} from './github.mjs'
