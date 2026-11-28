/**
 * review-pr.mjs —— review-pack 的 PR 元数据实时拉取、分诊拒绝守卫与防绕过解析内核。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 ../../lib/）。
 */

import { writeTaskLedger } from '../../lib/ledger.mjs'
import { gitRun } from '../../lib/git.mjs'
import { readGitConfigFast } from '../../lib/git-fast.mjs'
import { NON_API_CLIENT_TIERS } from '../../lib/github-client.mjs'
import { hasIntakeBlockingSignal, readIntakeRecord } from '../../lib/intake-triage.mjs'
import { getLocalPr } from '../../lib/local-issues.mjs'
import {
  detectDeclaredRepo, parseRemoteUrls, probePlatformEnv, resolveRemoteTarget,
} from '../../lib/platform.mjs'

/** 判断任务账本是否属于外部 PR / 隔离 PR 审查位（禁止经 `--task` 绕过 PR 检查）。 */
export function isExternalPrTaskLedger(task) {
  if (!task || typeof task !== 'object') return false
  return task.role === 'inbound-external-pr' || task.isolation === 'review-pr' || Boolean(task.externalPr)
}

function resolvePrRemoteCtx(task, remoteUrls, declaredRepo, mainRoot = null) {
  return resolveRemoteTarget(remoteUrls ?? {}, { role: task?.role, declaredRepo, providerHint: task?.providerId, cwd: mainRoot })
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

/**
 * 源码审查包前置分诊守卫：检查本地 intake 记录、本地 PR 分诊状态、远端 PR 标签与 `pf-state` 分诊评论。
 * 命中 `reject` / `merge-duplicate` 或 `out-of-scope`/`wontfix`/`duplicate` 时阻断（`BLOCKED_INTAKE_REJECTED`），
 * 传 `--override-intake` 时放行并在返回对象中留审计记录。
 */
export function evaluatePrIntakeGuard({ mainRoot, gitDir = null, prNumber, prResolution = null, opts = {} } = {}) {
  const num = Number(String(prNumber ?? '').replace(/^#/, '').trim())
  if (!Number.isInteger(num) || num <= 0) {
    return { blocked: false, overridden: false, prNumber: null, decision: null, labels: [], sources: [] }
  }
  const record = readIntakeRecord(mainRoot, 'pr', num, { gitDir })
  const localPrRes = getLocalPr({ mainRoot, gitDir, number: num })
  const localPr = localPrRes?.ok ? localPrRes : null
  const remoteLabels = Array.isArray(prResolution?.labels) ? prResolution.labels : []
  const remoteComments = Array.isArray(prResolution?.comments) ? prResolution.comments : []

  const signal = hasIntakeBlockingSignal({
    record,
    localPr,
    labels: remoteLabels,
    comments: remoteComments,
  })

  if (!signal.blocked) {
    return {
      blocked: false,
      overridden: false,
      prNumber: num,
      decision: record?.decision ?? localPr?.triage?.decision ?? null,
      labels: remoteLabels.length > 0 ? remoteLabels : (localPr?.labels ?? []),
      sources: [],
    }
  }

  const override = Boolean(opts?.['override-intake'] || opts?.overrideIntake)
  const srcSummary = signal.sources.map((s) => s.kind).join(', ')
  if (override) {
    return {
      blocked: false,
      overridden: true,
      prNumber: num,
      decision: signal.decision,
      labels: signal.labels,
      reason: signal.reason || `PR #${num} 命中分诊拒绝信号（${srcSummary}）`,
      sources: signal.sources,
      auditNote: `显式通过 --override-intake 覆盖分诊拒绝（decision=${signal.decision ?? 'reject'}，来源：${srcSummary}）`,
    }
  }

  const labelPart = signal.labels.length > 0 ? `，标签：${signal.labels.join(', ')}` : ''
  const reasonPart = signal.reason ? `（${signal.reason}）` : ''
  return {
    blocked: true,
    overridden: false,
    code: 'BLOCKED_INTAKE_REJECTED',
    prNumber: num,
    decision: signal.decision ?? 'reject',
    labels: signal.labels,
    reason: signal.reason || `分诊判定为 ${signal.decision ?? 'reject'}`,
    sources: signal.sources,
    empiricalBypassed: true,
    message: `BLOCKED_INTAKE_REJECTED: PR #${num} 已被业务分诊拒绝（decision=${signal.decision ?? 'reject'}${labelPart}，来源：${srcSummary}）${reasonPart}，已拦截生成源码审查包；如确需强审请显式传 --override-intake。`,
  }
}

export function emitIntakeRejectedBlock({ opts, exitCode, guard }) {
  const overrideHint = `Re-run with --override-intake to explicitly override this intake rejection for PR #${guard.prNumber}.`
  const payload = {
    status: 'BLOCKED_INTAKE_REJECTED',
    code: 'BLOCKED_INTAKE_REJECTED',
    exitCode,
    pr: guard.prNumber,
    decision: guard.decision,
    labels: guard.labels,
    sources: guard.sources,
    reason: guard.reason,
    empiricalBypassed: true,
    overrideHint,
    error: guard.message,
  }
  if (opts?.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    const lines = [
      'BLOCKED_INTAKE_REJECTED',
      `PR       : #${guard.prNumber}`,
      `Decision : ${guard.decision}`,
      ...(guard.labels.length > 0 ? [`Labels   : ${guard.labels.join(', ')}`] : []),
      `Sources  : ${guard.sources.map((s) => s.kind).join(', ')}`,
      `Reason   : ${guard.reason}`,
      `Exit Code: ${exitCode}`,
      '',
      '[NEXT STEP]',
      `  - ${overrideHint}`,
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  process.stderr.write(`${guard.message}\n`)
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
  const remoteTarget = resolvePrRemoteCtx(task, remoteUrls, declaredRepo, mainRoot)
  const targetRepo = remoteTarget.repoSlug ?? declaredRepo ?? null

  let client = opts._ghClient ?? null
  let probeTier = opts._ghProbe?.env?.trackB?.tier ?? null
  if (!client && opts._ghProbe) {
    client = opts._ghProbe.client ?? null
  }
  if (!client && targetRepo && remoteTarget.capabilities?.api === true) {
    try {
      const probe = await probePlatformEnv({ cwd: mainRoot, remoteUrls, probeNetwork: true })
      client = probe?.client ?? null
      probeTier = probe?.env?.trackB?.tier ?? probeTier
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
      message: `BLOCKED_PR_UNRESOLVED: 拉不到 PR #${num} 的真实信息（无可用托管平台 API 通道或缺少仓库声明）。`
        + '不能假装审过或退回本地分支对比：请先配好平台凭据或令牌后再重跑。',
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

  const labels = Array.isArray(pr.labels)
    ? pr.labels.map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean)
    : []
  let comments = Array.isArray(pr.comments) ? pr.comments : []
  if (comments.length === 0 && typeof client.listComments === 'function') {
    try {
      const cRes = await client.listComments({ repo: targetRepo, number: num, isPr: true })
      if (cRes?.ok && Array.isArray(cRes.comments)) comments = cRes.comments
    } catch { /* ignore best-effort comment read */ }
  }

  if (task) {
    const nextPrContext = {
      number: num,
      fetched: true,
      title: pr.title ?? null,
      url: pr.url ?? null,
      state: pr.state ?? null,
      labels,
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
    mrRefPattern: remoteTarget.mrRefPattern ?? null,
    pushRemote: remoteTarget.pushRemote ?? 'origin',
    baseRefOid,
    headRefOid,
    baseBranch: pr.baseBranch ?? null,
    headBranch: pr.headBranch ?? null,
    url: pr.url ?? null,
    state: pr.state ?? null,
    labels,
    comments,
  }
}

/** 验证 PR 的 `baseRefOid` 与 `headRefOid` 在本地 Git 对象库可达；不可达时按需尝试拉取 PR head，不静默退回分支名。 */
export async function ensurePrShasLocallyResolvable({ reviewRoot, mainRoot, prResolution, opts = {} }) {
  const { prNumber, baseRefOid, headRefOid, mrRefPattern, pushRemote } = prResolution
  let hasHead = (await gitRun(reviewRoot, ['rev-parse', '--verify', `${headRefOid}^{commit}`])).ok
  if (!hasHead && process.env.PF_NO_REAL_AUTH_PROBE !== '1' && !opts._ghClient && !opts._ghProbe) {
    const refSpec = (mrRefPattern ?? 'refs/pull/{id}/head').replace(/\{id\}/g, String(prNumber)).replace(/^refs\//, '')
    await gitRun(mainRoot, ['fetch', pushRemote || 'origin', refSpec])
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
