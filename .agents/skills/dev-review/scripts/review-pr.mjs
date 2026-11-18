/**
 * review-pr.mjs —— review-pack 的 PR 元数据实时拉取与防绕过解析内核。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 ../../lib/）。
 */

import { writeTaskLedger } from '../../lib/ledger.mjs'
import { gitRun } from '../../lib/git.mjs'
import { readGitConfigFast } from '../../lib/git-fast.mjs'
import {
  detectDeclaredRepo, githubRepoFull, parseRemoteUrls, probeGitHubEnv,
} from '../../lib/platform.mjs'

const NON_API_CLIENT_TIERS = new Set(['none', 'offline', 'half-duplex', 'mcp-delegate'])

/** 判断任务账本是否属于外部 PR / 隔离 PR 审查位（禁止经 `--task` 绕过 PR 检查）。 */
export function isExternalPrTaskLedger(task) {
  if (!task || typeof task !== 'object') return false
  return task.role === 'inbound-external-pr' || task.isolation === 'review-pr' || Boolean(task.externalPr)
}

function buildPrTargetRepo(task, remoteUrls, declaredRepo) {
  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const upstreamRaw = remoteUrls.upstream
  const originFull = githubRepoFull(originRaw)
  const upstreamFull = githubRepoFull(upstreamRaw)
  if (task?.role === 'contributor-fork') {
    return upstreamFull ?? declaredRepo ?? originFull
  }
  return originFull ?? declaredRepo ?? upstreamFull
}

export function emitPrUnresolvedBlock({ opts, exitCode, prArg, reason, message }) {
  if (opts?.json) {
    process.stdout.write(`${JSON.stringify({
      status: 'BLOCKED_PR_UNRESOLVED',
      code: 'BLOCKED_PR_UNRESOLVED',
      exitCode,
      pr: prArg ?? null,
      reason: reason ?? 'unresolved',
      error: message,
    }, null, 2)}\n`)
  } else {
    process.stdout.write(`${message}\n`)
  }
  process.stderr.write(`${message}\n`)
  return exitCode
}

/** 强制经 GitHub API 拉取 PR 的真实 `baseRefOid` 与 `headRefOid`；失败返回 `BLOCKED_PR_UNRESOLVED`。 */
export async function resolvePrForReviewPack({ mainRoot, roots, prNo, task, opts = {} }) {
  const num = Number(String(prNo ?? '').replace(/^#/, '').trim())
  if (!Number.isInteger(num) || num <= 0) {
    return {
      ok: false,
      code: 'BLOCKED_PR_UNRESOLVED',
      reason: 'missing-pr-number',
      message: 'BLOCKED_PR_UNRESOLVED: 缺少有效的 PR 编号，不能以本地分支或 HEAD 代替 PR 审查。',
    }
  }

  const fastCfg = roots.gitDir ? readGitConfigFast(roots.gitDir) : null
  const remoteRes = fastCfg ? { ok: true, stdout: fastCfg.remoteText } : await gitRun(mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(mainRoot)
  const targetRepo = buildPrTargetRepo(task, remoteUrls, declaredRepo)

  let client = opts._ghClient ?? null
  let probeTier = opts._ghProbe?.env?.trackB?.tier ?? null
  if (!client && opts._ghProbe) {
    client = opts._ghProbe.client ?? null
  }
  if (!client && targetRepo) {
    try {
      const ghProbe = await probeGitHubEnv({ cwd: mainRoot, remoteUrls, probeNetwork: true })
      client = ghProbe?.client ?? null
      probeTier = ghProbe?.env?.trackB?.tier ?? probeTier
    } catch {
      client = null
    }
  }

  const blockedTier = (probeTier && NON_API_CLIENT_TIERS.has(probeTier))
    || (client?.tier && NON_API_CLIENT_TIERS.has(client.tier))
  if (!targetRepo || !client || blockedTier || typeof client.getPr !== 'function') {
    return {
      ok: false,
      code: 'BLOCKED_PR_UNRESOLVED',
      prNumber: num,
      reason: 'no-api-channel',
      message: `BLOCKED_PR_UNRESOLVED: 拉不到 PR #${num} 的真实信息（无可用 GitHub API 通道或缺少仓库声明）。`
        + '不能假装审过或退回本地分支对比：请先配好 GitHub 凭据（gh auth login 或 GH_TOKEN）再重跑。',
    }
  }

  let pr
  try {
    pr = await client.getPr(targetRepo, num)
  } catch (err) {
    return {
      ok: false,
      code: 'BLOCKED_PR_UNRESOLVED',
      prNumber: num,
      reason: err instanceof Error ? err.message : String(err),
      message: `BLOCKED_PR_UNRESOLVED: 拉取 PR #${num} 失败（${err instanceof Error ? err.message : String(err)}），拒绝静默降级为本地分支对比。`,
    }
  }

  if (!pr?.ok || pr.delegated) {
    const why = pr?.delegated ? `needs-manual-fetch:${pr.action ?? 'get_pr'}` : (pr?.error || 'pr-not-found')
    return {
      ok: false,
      code: 'BLOCKED_PR_UNRESOLVED',
      prNumber: num,
      reason: why,
      message: `BLOCKED_PR_UNRESOLVED: 拉不到 PR #${num} 的真实信息（${why}）。拒绝用本地分支或 HEAD 静默代替 PR 审查。`,
    }
  }

  const baseRefOid = String(pr.baseRefOid ?? '').trim()
  const headRefOid = String(pr.headRefOid ?? '').trim()
  if (!baseRefOid || !headRefOid) {
    return {
      ok: false,
      code: 'BLOCKED_PR_UNRESOLVED',
      prNumber: num,
      reason: 'missing-pr-shas',
      message: `BLOCKED_PR_UNRESOLVED: PR #${num} 返回缺少 baseRefOid 或 headRefOid，无法确定精确提交范围（禁止用分支名代替）。`,
    }
  }

  if (task) {
    const nextPrContext = {
      number: num,
      fetched: true,
      title: pr.title ?? null,
      url: pr.url ?? null,
      state: pr.state ?? null,
      baseBranch: pr.baseBranch ?? null,
      headBranch: pr.headBranch ?? null,
      baseRefOid,
      headRefOid,
      summary: String(pr.body ?? '').replace(/\r\n/g, '\n').trim().slice(0, 1200),
    }
    const changed = task.prBaseSha !== baseRefOid
      || task.prHeadSha !== headRefOid
      || !task.prContext?.fetched
      || Boolean(task.prContextUnavailable)
    if (changed) {
      task.prBaseSha = baseRefOid
      task.prHeadSha = headRefOid
      if (pr.url) task.prUrl = pr.url
      if (pr.state) task.prState = pr.state
      task.prContext = nextPrContext
      task.prContextUnavailable = null
      writeTaskLedger(mainRoot, task)
    }
  }

  return {
    ok: true,
    prNumber: num,
    targetRepo,
    baseRefOid,
    headRefOid,
    baseBranch: pr.baseBranch ?? null,
    headBranch: pr.headBranch ?? null,
    url: pr.url ?? null,
    state: pr.state ?? null,
  }
}

/** 验证 PR 的 `baseRefOid` 与 `headRefOid` 在本地 Git 对象库可达；不可达时按需尝试拉取 PR head，不静默退回分支名。 */
export async function ensurePrShasLocallyResolvable({ reviewRoot, mainRoot, prResolution, opts = {} }) {
  const { prNumber, baseRefOid, headRefOid } = prResolution
  let hasHead = (await gitRun(reviewRoot, ['rev-parse', '--verify', `${headRefOid}^{commit}`])).ok
  if (!hasHead && process.env.PF_NO_REAL_AUTH_PROBE !== '1' && !opts._ghClient && !opts._ghProbe) {
    await gitRun(mainRoot, ['fetch', 'origin', `pull/${prNumber}/head`])
    hasHead = (await gitRun(reviewRoot, ['rev-parse', '--verify', `${headRefOid}^{commit}`])).ok
  }
  const hasBase = (await gitRun(reviewRoot, ['rev-parse', '--verify', `${baseRefOid}^{commit}`])).ok
  if (!hasHead || !hasBase) {
    const missing = [!hasBase ? `baseRefOid=${baseRefOid}` : null, !hasHead ? `headRefOid=${headRefOid}` : null].filter(Boolean).join(', ')
    return {
      ok: false,
      code: 'BLOCKED_PR_UNRESOLVED',
      reason: 'pr-commits-missing-locally',
      message: `BLOCKED_PR_UNRESOLVED: 本地 Git 仓库缺少 PR #${prNumber} 的提交对象（${missing}），请先 fetch PR 提交或通过 flow.mjs start --external-pr ${prNumber} 拉取。`,
    }
  }
  return { ok: true }
}
