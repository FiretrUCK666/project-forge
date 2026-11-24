/**
 * task-backend.mjs —— 统一 17 接口 TaskBackend 抽象层与注册表分发（GitHubBackend / GenericRemoteBackend / LocalOnlyBackend）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），统一三态后端契约：
 *   claimTask, releaseTask, postComment, addLabels, removeLabel, createIssue, getIssue, listIssues,
 *   closeIssue, findOpenPrForBranch, createPr, updatePrBase, getPr, listComments, getCommitChecks, mergePr, closePr
 */

import { buildClaimComments } from './doc-comments.mjs'
import { createGitHubClient } from './github-client.mjs'
import { getHostingProvider } from './platform.mjs'
import {
  GenericRemoteBackend,
  LocalOnlyBackend,
  TASK_BACKEND_METHODS,
  WORKFLOW_STATE_LABELS,
  hasNoLabelsDecision,
  normalizeClosePrArgs,
  normalizeFindArgs,
  normalizeGetPrArgs,
  normalizeIssueArgs,
  normalizeListCommentArgs,
  resolveSemanticStateLabel,
} from './task-backend-local.mjs'

export {
  GenericRemoteBackend,
  LocalOnlyBackend,
  TASK_BACKEND_METHODS,
  WORKFLOW_STATE_LABELS,
}

export class GitHubBackend {
  constructor({ targetRepo = null, client = null, pushRemote = 'origin', mainRoot = process.cwd(), gitDir = null } = {}) {
    this.kind = 'github'
    this.targetRepo = targetRepo
    this.pushRemote = pushRemote
    this.mainRoot = mainRoot
    this.gitDir = gitDir
    this.client = client ?? createGitHubClient({ cwd: mainRoot })
    this.capabilities = Object.freeze({ api: true, pr: true, issues: true, labels: true, milestones: true, checks: true, releases: true, mention: true })
  }

  _call(method, args, fallback = { ok: false, skipped: true, reason: 'client-unsupported' }) {
    if (typeof this.client?.[method] !== 'function') return Promise.resolve(fallback)
    return Promise.resolve(this.client[method](...args))
  }

  async claimTask({
    taskId, issue, issues, prNumber, actor, actorDisplay, account = null, verifiedPlatformLogin = false, agent = null, branch,
    takeover = false, reason = '', previousActor = null, previousAccount = null, previousVerifiedPlatformLogin = false, previousAgent = null, labels = ['in-progress'],
  } = {}) {
    const issueList = Array.isArray(issues) ? issues : (issue !== undefined && issue !== null ? [issue] : [])
    const repo = this.targetRepo
    const results = []
    const rendered = buildClaimComments({
      action: takeover ? 'takeover' : 'claim',
      taskId,
      account,
      verifiedPlatformLogin,
      agent,
      actor,
      actorDisplay,
      branch,
      previousActor,
      previousAccount,
      previousVerifiedPlatformLogin,
      previousAgent,
      reason,
      issues: issueList,
      prNumber,
      capabilities: this.capabilities,
    })
    const effectiveAgent = agent ?? actor ?? null
    const baseState = {
      taskId,
      action: takeover ? 'takeover' : 'claim',
      ...(account ? { account, verifiedPlatformLogin: Boolean(verifiedPlatformLogin) } : {}),
      ...(effectiveAgent ? { agent: effectiveAgent } : {}),
      ...(takeover && (previousAgent || previousActor) ? { previousAgent: previousAgent ?? previousActor } : {}),
      branch,
      ...(takeover && reason ? { reason } : {}),
    }
    for (const num of issueList) {
      const comment = await this.postComment({
        repo, number: num,
        body: rendered.issueCommentBody,
        statePayload: baseState,
      })
      const label = await this.syncStateLabel({ repo, number: num, state: 'in-progress', fallbackLabels: labels })
      results.push({ issue: num, action: takeover ? 'takeover' : 'claim', comment, label })
    }
    let prResult = null
    if (takeover && prNumber) {
      prResult = await this.postComment({
        repo, number: prNumber,
        body: rendered.prCommentBody,
        statePayload: { ...baseState, prNumber },
      })
    }
    return { ok: true, results, prResult }
  }

  async releaseTask({ taskId, issue, issues, actor, actorDisplay, account = null, verifiedPlatformLogin = false, agent = null, branch, reason = '' } = {}) {
    const issueList = Array.isArray(issues) ? issues : (issue !== undefined && issue !== null ? [issue] : [])
    const repo = this.targetRepo
    const results = []
    const rendered = buildClaimComments({
      action: 'release',
      taskId,
      account,
      verifiedPlatformLogin,
      agent,
      actor,
      actorDisplay,
      branch,
      reason,
      issues: issueList,
      capabilities: this.capabilities,
    })
    const effectiveAgent = agent ?? actor ?? null
    for (const num of issueList) {
      const comment = await this.postComment({
        repo, number: num,
        body: rendered.issueCommentBody,
        statePayload: {
          taskId,
          action: 'release',
          ...(account ? { account, verifiedPlatformLogin: Boolean(verifiedPlatformLogin) } : {}),
          ...(effectiveAgent ? { agent: effectiveAgent } : {}),
          branch: branch ?? null,
          ...(reason ? { reason } : {}),
        },
      })
      const labelRemoved = await this.removeLabel({ repo, number: num, label: 'in-progress' })
      results.push({ issue: num, comment, labelRemoved })
    }
    return { ok: true, results }
  }

  postComment({ repo, number, body, statePayload = {}, deduplicate = true, existingComments = null } = {}) {
    return this._call('postComment', [{ repo: repo ?? this.targetRepo, number, body, statePayload, deduplicate, existingComments }])
  }

  addLabels({ repo, number, labels = [], isPr = false } = {}) {
    return this._call('addLabels', [{ repo: repo ?? this.targetRepo, number, labels, isPr }])
  }

  removeLabel({ repo, number, label } = {}) {
    return this._call('removeLabel', [{ repo: repo ?? this.targetRepo, number, label }])
  }

  async syncStateLabel({ repo, number, state, fallbackLabels = [] } = {}) {
    if (hasNoLabelsDecision(this.mainRoot)) return { ok: true, skipped: true, reason: 'no-labels' }
    const targetRepo = repo ?? this.targetRepo
    const repoLabels = typeof this.client?.listLabels === 'function'
      ? ((await Promise.resolve(this.client.listLabels({ repo: targetRepo })).catch(() => null))?.labels ?? [])
      : []
    const { primary, removes } = resolveSemanticStateLabel(state, repoLabels)
    const addRes = await this.addLabels({ repo: targetRepo, number, labels: primary ? [primary] : fallbackLabels })
    if (addRes?.reason && /403|forbidden/i.test(String(addRes.reason))) {
      return { ok: false, skipped: true, reason: addRes.reason, label: primary }
    }
    for (const stale of removes) {
      await Promise.resolve(this.removeLabel({ repo: targetRepo, number, label: stale })).catch(() => ({ ok: false, skipped: true }))
    }
    return { ok: Boolean(addRes?.ok || !addRes?.skipped), label: primary, removes, addRes }
  }

  createIssue({ repo, title, body = '', labels = [], milestone = null } = {}) {
    return this._call('createIssue', [{ repo: repo ?? this.targetRepo, title, body, labels, ...(milestone ? { milestone } : {}) }])
  }
  listMilestones({ repo, state = 'open' } = {}) {
    return this._call('listMilestones', [{ repo: repo ?? this.targetRepo, state }], { ok: false, milestones: [], skipped: true, reason: 'client-unsupported' })
  }
  createMilestone({ repo, title, description = '', dueOn = null } = {}) {
    return this._call('createMilestone', [{ repo: repo ?? this.targetRepo, title, description, dueOn }])
  }
  closeMilestone({ repo, number } = {}) {
    return this._call('closeMilestone', [{ repo: repo ?? this.targetRepo, number }])
  }
  assignMilestone({ repo, number, milestone } = {}) {
    return this._call('assignMilestone', [{ repo: repo ?? this.targetRepo, number, milestone }])
  }
  getIssue(arg, maybeNumber) {
    const norm = normalizeIssueArgs(arg, maybeNumber)
    return this._call('getIssue', [norm.repo ?? this.targetRepo, norm.number])
  }
  updateIssueBody({ repo, number, body } = {}) {
    return this._call('updateIssueBody', [{ repo: repo ?? this.targetRepo, number, body }])
  }
  listIssues({ repo, state = 'open', perPage = 30 } = {}) {
    return this._call('listIssues', [{ repo: repo ?? this.targetRepo, state, perPage }], { ok: false, issues: [], skipped: true, reason: 'client-unsupported' })
  }
  closeIssue(arg, maybeNumber) {
    const norm = normalizeIssueArgs(arg, maybeNumber)
    return this._call('closeIssue', [{ repo: norm.repo ?? this.targetRepo, number: norm.number }])
  }
  findOpenPrForBranch(repoOrOpts, headBranch, opts = {}) {
    const parsed = normalizeFindArgs(repoOrOpts, headBranch, opts)
    return this._call('findOpenPrForBranch', [parsed.repo ?? this.targetRepo, parsed.headBranch, { headOwner: parsed.headOwner, base: parsed.base }], { ok: false, prs: [], skipped: true, reason: 'client-unsupported' })
  }
  createPr({ targetRepo, repo, head, base, title, body, draft = false } = {}) {
    return this._call('createPr', [{ targetRepo: targetRepo ?? repo ?? this.targetRepo, head, base, title, body, draft }])
  }
  updatePrBase({ repo, number, base } = {}) {
    return this._call('updatePrBase', [{ repo: repo ?? this.targetRepo, number, base }])
  }
  getPr(repoOrOpts, number) {
    const parsed = normalizeGetPrArgs(repoOrOpts, number)
    return this._call('getPr', [parsed.repo ?? this.targetRepo, parsed.number])
  }
  listComments(arg, maybeNumber) {
    const norm = normalizeListCommentArgs(arg, maybeNumber)
    return this._call('listComments', [{ ...norm, repo: norm.repo ?? this.targetRepo }], { ok: false, comments: [], skipped: true, reason: 'client-unsupported' })
  }
  getCommitChecks({ repo, ref } = {}) {
    return this._call('getCommitChecks', [{ repo: repo ?? this.targetRepo, ref }], { ok: true, bucket: 'none', total: 0, passed: [], pending: [], failed: [], skipped: true })
  }
  mergePr({ repo, number, method = 'merge', sha } = {}) {
    return this._call('mergePr', [{ repo: repo ?? this.targetRepo, number, method, ...(sha ? { sha } : {}) }])
  }

  async closePr(arg, maybeOpts = {}) {
    const cfg = normalizeClosePrArgs(arg, maybeOpts)
    const targetRepo = cfg.repo ?? this.targetRepo
    if (!Number.isInteger(cfg.prNumber) || cfg.prNumber <= 0) return { ok: false, error: 'invalid-pr-number' }
    if (cfg.dryRun) {
      return {
        ok: true,
        dryRun: true,
        repo: targetRepo,
        number: cfg.prNumber,
        state: 'OPEN',
        planned: { comment: Boolean(cfg.comment), labels: cfg.labels, close: true },
      }
    }
    const commentResult = cfg.comment
      ? await this.postComment({ repo: targetRepo, number: cfg.prNumber, body: cfg.comment, statePayload: cfg.statePayload })
      : null
    const labelResult = cfg.labels.length > 0
      ? await this.addLabels({ repo: targetRepo, number: cfg.prNumber, labels: cfg.labels, isPr: true })
      : null
    const closeRes = await this._call('closePr', [{ repo: targetRepo, number: cfg.prNumber, dryRun: false }])
    return {
      ...closeRes,
      number: closeRes?.number ?? cfg.prNumber,
      ...(commentResult ? { commentResult } : {}),
      ...(labelResult ? { labelResult } : {}),
    }
  }
}

export { GitHubBackend as GitHubTaskBackend }

/** 根据身份角色与 HostingProvider 注册表分发构造统一的 17 方法 TaskBackend。 */
export function createTaskBackend({
  role = 'local-only', providerId = 'none', targetRepo = null, client = null,
  pushRemote = 'origin', mainRoot = process.cwd(), gitDir = null, baseBranch = null,
} = {}) {
  if (role === 'local-only' || providerId === 'none') {
    return new LocalOnlyBackend({ mainRoot, gitDir, baseBranch })
  }
  const provider = getHostingProvider(providerId)
  if (provider && typeof provider.createTaskBackend === 'function') {
    return provider.createTaskBackend({ role, providerId, targetRepo, client, pushRemote, mainRoot, gitDir, baseBranch })
  }
  if (role === 'generic-git' || !provider || provider.id !== 'github' || provider.capabilities?.api !== true || !targetRepo) {
    return new GenericRemoteBackend({ targetRepo, pushRemote, mainRoot, gitDir })
  }
  return new GitHubBackend({ targetRepo, client, pushRemote, mainRoot, gitDir })
}
