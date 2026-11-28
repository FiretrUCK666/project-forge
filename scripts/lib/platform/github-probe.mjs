/**
 * github-probe.mjs —— 引擎侧 GitHub 双轨探测适配层（单源复用 `kit/skills/lib/platform-probe.mjs`）。
 *
 * 保持 `{ probed, hasRemote, https, ssh, ghBridge, ghCli, originProtocol, protocolMismatch,
 * remediationCmd, apiChannel, details }` 与 `TOKEN_VAULT` 内存令牌接口完全兼容。
 */

import {
  DEFAULT_PROBE_TIMEOUT_MS,
  TOKEN_VAULT,
  defaultCommandRunner,
  defaultHttpsRequest,
  detectRemoteProtocol,
  parseSshConfigDetails,
  probeGitHubEnvCore,
  probePlatformEnvCore,
  probeSshTransport,
} from '../../../kit/skills/lib/platform-probe.mjs'
import { parseSshConfigHostMap } from '../text.mjs'

export { probePlatformEnvCore, probeSshTransport }

/**
 * 并发双轨探测本机 GitHub 传输（Track A）与 API 四级降级通道（Track B）。
 * 引擎 `--probe-auth` 路径默认开启外部探测，同时严格遵守 `PF_NO_REAL_AUTH_PROBE=1`（无自定义 runner 时跳过真网调用）。
 */
export async function probeGitHubEnv({
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
  const effectiveRunner = runner ?? defaultCommandRunner

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
    runner: effectiveRunner,
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
