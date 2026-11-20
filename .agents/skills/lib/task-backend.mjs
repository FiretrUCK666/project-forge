/**
 * task-backend.mjs —— 统一 17 接口 TaskBackend 抽象层（GitHubBackend / GenericRemoteBackend / LocalOnlyBackend）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），统一三态后端契约：
 *   claimTask, releaseTask, postComment, addLabels, removeLabel, createIssue, getIssue, listIssues,
 *   closeIssue, findOpenPrForBranch, createPr, updatePrBase, getPr, listComments, getCommitChecks, mergePr, closePr
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { buildClaimComments } from './doc-comments.mjs'
import { gitRun, gitStatusPorcelainZ, readTextSafe, withFileLock } from './git.mjs'
import { readHeadFast, resolveGitDirFast, resolveRefShaFast } from './git-fast.mjs'
import { createGitHubClient, parsePfStateTags } from './github-client.mjs'
import { sanitizeTaskId } from './ledger.mjs'
import {
  addLocalIssueComment,
  addLocalIssueLabels,
  assignLocalMilestone,
  claimLocalIssue,
  closeLocalIssue,
  closeLocalMilestone,
  closeLocalPr,
  createLocalIssue,
  createLocalMilestone,
  getLocalIssue,
  getLocalPr,
  listLocalIssues,
  listLocalMilestones,
  releaseLocalIssue,
  removeLocalIssueLabel,
  resolveEffectiveCommonGitDir,
} from './local-issues.mjs'
import { readDecisions } from './profile.mjs'

export const WORKFLOW_STATE_LABELS = Object.freeze({
  'in-progress': Object.freeze({ primary: 'in-progress', aliases: ['in-progress', 'status:in-progress', 'wip', 'doing'], removes: ['in-review', 'changes-requested', 'reviewed'] }),
  'in-review': Object.freeze({ primary: 'in-review', aliases: ['in-review', 'status:in-review', 'review', 'needs-review'], removes: ['in-progress', 'changes-requested'] }),
  'changes-requested': Object.freeze({ primary: 'changes-requested', aliases: ['changes-requested', 'status:changes-requested', 'rework'], removes: ['in-review', 'reviewed'] }),
  reviewed: Object.freeze({ primary: 'reviewed', aliases: ['reviewed', 'status:reviewed', 'approved', 'ready-to-merge'], removes: ['in-review', 'changes-requested', 'in-progress'] }),
})

function hasNoLabelsDecision(mainRoot) {
  if (!mainRoot) return false
  const txt = readTextSafe(join(mainRoot, 'AGENTS.md'))
  return txt ? readDecisions(txt).has('no-labels') : false
}

function resolveSemanticStateLabel(stateName, existingRepoLabels = []) {
  const entry = WORKFLOW_STATE_LABELS[stateName]
  if (!entry) return { primary: stateName, removes: [] }
  const lowMap = new Map((existingRepoLabels ?? []).map((l) => [String(l).toLowerCase(), String(l)]))
  const matched = entry.aliases.map((a) => lowMap.get(a.toLowerCase())).find(Boolean)
  const primary = matched ?? entry.primary
  const removes = [...new Set([...entry.removes, ...entry.removes.map((r) => WORKFLOW_STATE_LABELS[r]?.aliases ?? []).flat()])]
    .map((r) => lowMap.get(r.toLowerCase()) ?? r)
    .filter((r) => r.toLowerCase() !== primary.toLowerCase())
  return { primary, removes }
}

export const TASK_BACKEND_METHODS = Object.freeze([
  'claimTask',
  'releaseTask',
  'postComment',
  'addLabels',
  'removeLabel',
  'createIssue',
  'getIssue',
  'listIssues',
  'closeIssue',
  'findOpenPrForBranch',
  'createPr',
  'updatePrBase',
  'getPr',
  'listComments',
  'getCommitChecks',
  'mergePr',
  'closePr',
])

function resolveEffectiveGitDir(mainRoot, gitDir) {
  const common = resolveEffectiveCommonGitDir(mainRoot, gitDir)
  if (common) return common
  if (!mainRoot) return null
  const dotGit = join(mainRoot, '.git')
  return existsSync(dotGit) ? dotGit : null
}

function eventLogPath(mainRoot, gitDir, taskId = 'shared') {
  const effectiveGitDir = resolveEffectiveGitDir(mainRoot, gitDir)
  const baseDir = effectiveGitDir
    ? join(effectiveGitDir, 'project-forge-flow', 'events')
    : join(mainRoot || process.cwd(), '.worktrees', '.state', 'events')
  return join(baseDir, `${sanitizeTaskId(String(taskId || 'shared'))}.jsonl`)
}

async function appendBackendEvent(mainRoot, gitDir, taskId, event) {
  const file = eventLogPath(mainRoot, gitDir, taskId)
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`
  await withFileLock(`${file}.lock`, () => {
    mkdirSync(join(file, '..'), { recursive: true })
    appendFileSync(file, line, 'utf8')
  })
  return file
}

function readBackendEvents(mainRoot, gitDir, taskId) {
  if (!taskId) return []
  const raw = readTextSafe(eventLogPath(mainRoot, gitDir, taskId))
  if (!raw) return []
  const events = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try { events.push(JSON.parse(trimmed)) } catch { /* ignore malformed line */ }
  }
  return events
}

function normalizeFindArgs(repoOrOpts, headBranch, opts = {}) {
  if (repoOrOpts && typeof repoOrOpts === 'object') {
    return {
      repo: repoOrOpts.repo ?? repoOrOpts.targetRepo ?? null,
      headBranch: repoOrOpts.headBranch ?? repoOrOpts.head ?? null,
      headOwner: repoOrOpts.headOwner,
      base: repoOrOpts.base,
    }
  }
  return { repo: repoOrOpts ?? null, headBranch: headBranch ?? null, headOwner: opts.headOwner, base: opts.base }
}

function normalizeGetPrArgs(repoOrOpts, number) {
  if (typeof repoOrOpts === 'number') return { repo: null, number: repoOrOpts }
  if (typeof repoOrOpts === 'string' && number === undefined && /^\d+$/.test(repoOrOpts.trim())) {
    return { repo: null, number: Number(repoOrOpts.trim()) }
  }
  if (repoOrOpts && typeof repoOrOpts === 'object') {
    return { repo: repoOrOpts.repo ?? repoOrOpts.targetRepo ?? null, number: repoOrOpts.number ?? repoOrOpts.prNumber }
  }
  return { repo: repoOrOpts ?? null, number }
}

function normalizeClosePrArgs(arg, maybeOpts = {}) {
  const obj = (arg && typeof arg === 'object')
    ? arg
    : { ...(maybeOpts && typeof maybeOpts === 'object' ? maybeOpts : {}), number: arg }
  const prNumber = Number(obj.number ?? obj.prNumber)
  const labels = Array.isArray(obj.labels)
    ? [...new Set(obj.labels.map((l) => String(l ?? '').trim()).filter(Boolean))]
    : []
  return {
    repo: obj.repo ?? obj.targetRepo ?? null,
    prNumber,
    comment: String(obj.comment ?? '').trim(),
    labels,
    dryRun: Boolean(obj.dryRun),
    statePayload: obj.statePayload && typeof obj.statePayload === 'object' ? obj.statePayload : {},
    reason: String(obj.reason ?? '').trim(),
    decision: obj.decision ?? null,
    taskId: obj.taskId ?? null,
  }
}

function normalizeIssueArgs(arg, maybeNumber) {
  if (typeof arg === 'number') return { repo: null, number: arg }
  if (typeof arg === 'string' && maybeNumber === undefined && /^\d+$/.test(arg.trim())) {
    return { repo: null, number: Number(arg.trim()) }
  }
  if (arg && typeof arg === 'object') return { repo: arg.repo ?? arg.targetRepo ?? null, number: arg.number ?? arg.issue }
  return { repo: arg ?? null, number: maybeNumber }
}

function normalizeListCommentArgs(arg, maybeNumber) {
  if (typeof arg === 'number') return { number: arg }
  if (arg && typeof arg === 'object') return arg
  return { repo: arg, number: maybeNumber }
}

function buildLocalBackendMixins(kind, mainRoot, gitDir) {
  const issueListOf = (issue, issues) => (Array.isArray(issues) ? issues : (issue !== undefined && issue !== null ? [issue] : []))
  const modeLabel = kind === 'local-only' ? 'local-issues-store' : 'generic-remote-local-tracking'

  const localClaimTask = async ({
    taskId, issue, issues, prNumber, actor, actorDisplay, account = null, verifiedPlatformLogin = false, agent = null, branch,
    takeover = false, reason = '', previousActor = null, previousAccount = null, previousVerifiedPlatformLogin = false, previousAgent = null, labels = ['in-progress'],
  } = {}) => {
    const nums = issueListOf(issue, issues)
    const results = []
    for (const num of nums) {
      if (getLocalIssue({ mainRoot, gitDir, number: num }).ok) {
        const res = await claimLocalIssue({
          mainRoot, gitDir, number: num, taskId, actor, actorDisplay,
          account, verifiedPlatformLogin, agent,
          branch, takeover, reason, previousActor, previousAccount, previousVerifiedPlatformLogin, previousAgent, labels,
        })
        if (!res.ok) return res
        results.push(res)
      }
    }
    const eventPath = await appendBackendEvent(mainRoot, gitDir, taskId ?? 'shared', {
      backend: kind, action: takeover ? 'takeover' : 'claim', taskId, issues: nums,
      prNumber: prNumber ?? null, actor: agent ?? actor ?? account ?? null, account: account ?? null, agent: agent ?? actor ?? null,
      previousActor: previousActor ?? null, branch, ...(reason ? { reason } : {}),
    })
    return { ok: true, local: true, mode: modeLabel, results, eventPath }
  }

  const localReleaseTask = async ({ taskId, issue, issues, actor, actorDisplay, account = null, verifiedPlatformLogin = false, agent = null, branch, reason = '' } = {}) => {
    const nums = issueListOf(issue, issues)
    const results = []
    for (const num of nums) {
      if (getLocalIssue({ mainRoot, gitDir, number: num }).ok) {
        results.push(await releaseLocalIssue({
          mainRoot, gitDir, number: num, taskId, actor, actorDisplay, account, verifiedPlatformLogin, agent, branch, reason,
        }))
      }
    }
    const eventPath = await appendBackendEvent(mainRoot, gitDir, taskId ?? 'shared', {
      backend: kind, action: 'release', taskId, issues: nums, actor: agent ?? actor ?? account ?? null, account: account ?? null, agent: agent ?? actor ?? null, branch, ...(reason ? { reason } : {}),
    })
    return { ok: true, local: true, mode: modeLabel, results, eventPath }
  }

  const localPostComment = async ({ taskId, repo, number, body, author, statePayload = {}, deduplicate = true } = {}) => {
    const num = number !== undefined && number !== null ? Number(number) : null
    if (num && Number.isInteger(num) && num > 0 && getLocalIssue({ mainRoot, gitDir, number: num }).ok) {
      return addLocalIssueComment({ mainRoot, gitDir, number: num, body, author, statePayload, deduplicate })
    }
    const idKey = num ? `ref-${num}` : (taskId ?? statePayload?.taskId ?? 'shared')
    const eventPath = await appendBackendEvent(mainRoot, gitDir, idKey, {
      backend: kind, action: 'comment', repo: repo ?? null, number: num, body, statePayload,
    })
    return { ok: true, local: true, mode: modeLabel, id: null, verifiedReadback: true, eventPath }
  }

  const localAddLabels = async ({ taskId, repo, number, labels = [] } = {}) => {
    const num = number !== undefined && number !== null ? Number(number) : null
    if (num && Number.isInteger(num) && num > 0 && getLocalIssue({ mainRoot, gitDir, number: num }).ok) {
      return addLocalIssueLabels({ mainRoot, gitDir, number: num, labels })
    }
    await appendBackendEvent(mainRoot, gitDir, taskId ?? (num ? `ref-${num}` : 'shared'), {
      backend: kind, action: 'add-labels', repo: repo ?? null, number: num, labels,
    })
    return { ok: true, local: true, number: num, labels }
  }

  const localRemoveLabel = async ({ taskId, repo, number, label } = {}) => {
    const num = number !== undefined && number !== null ? Number(number) : null
    if (num && Number.isInteger(num) && num > 0 && getLocalIssue({ mainRoot, gitDir, number: num }).ok) {
      return removeLocalIssueLabel({ mainRoot, gitDir, number: num, label })
    }
    await appendBackendEvent(mainRoot, gitDir, taskId ?? (num ? `ref-${num}` : 'shared'), {
      backend: kind, action: 'remove-label', repo: repo ?? null, number: num, label,
    })
    return { ok: true, local: true, number: num }
  }

  const localCreateIssue = async ({ title, body = '', labels = [], assignees = [], milestone = null } = {}) => (
    createLocalIssue({ mainRoot, gitDir, title, body, labels, assignees, milestone })
  )
  const localGetIssue = async (arg, maybeNumber) => getLocalIssue({ mainRoot, gitDir, number: normalizeIssueArgs(arg, maybeNumber).number })
  const localListIssues = async ({ state = 'open' } = {}) => listLocalIssues({ mainRoot, gitDir, state })
  const localCloseIssue = async (arg, maybeNumber) => {
    const norm = (arg && typeof arg === 'object') ? arg : { number: maybeNumber ?? arg }
    return closeLocalIssue({
      mainRoot, gitDir, number: norm.number ?? norm.issue,
      reason: norm.reason ?? '', migratedTo: norm.migratedTo ?? null, migratedUrl: norm.migratedUrl ?? null,
    })
  }

  const localListComments = async (arg, maybeNumber) => {
    const norm = normalizeListCommentArgs(arg, maybeNumber)
    const num = norm.number !== undefined && norm.number !== null ? Number(norm.number) : null
    if (num && Number.isInteger(num) && num > 0) {
      const issue = getLocalIssue({ mainRoot, gitDir, number: num })
      if (issue.ok) return { ok: true, local: true, comments: issue.comments }
      const pr = getLocalPr({ mainRoot, gitDir, number: num })
      if (pr.ok) return { ok: true, local: true, comments: pr.comments }
    }
    const keys = [...new Set([num ? `ref-${num}` : null, norm.taskId, !num && !norm.taskId ? 'shared' : null].filter(Boolean))]
    const events = []
    for (const k of keys) {
      for (const e of readBackendEvents(mainRoot, gitDir, k)) {
        if (e.action === 'comment' && (!num || e.number === num)) events.push(e)
      }
    }
    const comments = events.map((e, idx) => ({
      id: idx + 1,
      body: e.body ?? '',
      pfState: e.statePayload ?? null,
      pfStates: e.statePayload && Object.keys(e.statePayload).length > 0 ? [e.statePayload] : parsePfStateTags(e.body ?? ''),
    }))
    return { ok: true, local: true, comments }
  }

  const localSyncStateLabel = async ({ taskId, repo, number, state } = {}) => {
    if (hasNoLabelsDecision(mainRoot)) return { ok: true, skipped: true, reason: 'no-labels' }
    const { primary, removes } = resolveSemanticStateLabel(state)
    const addRes = await localAddLabels({ taskId, repo, number, labels: [primary] })
    for (const r of removes) await localRemoveLabel({ taskId, repo, number, label: r })
    return { ok: true, local: true, label: primary, removes, addRes }
  }

  return {
    localClaimTask, localReleaseTask, localPostComment, localAddLabels, localRemoveLabel,
    localSyncStateLabel, localCreateIssue, localGetIssue, localListIssues, localCloseIssue, localListComments,
  }
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

export class GenericRemoteBackend {
  constructor({ targetRepo = null, pushRemote = 'origin', mainRoot = process.cwd(), gitDir = null } = {}) {
    this.kind = 'generic-git'
    this.targetRepo = targetRepo
    this.pushRemote = pushRemote
    this.mainRoot = mainRoot
    this.gitDir = gitDir
    this.capabilities = Object.freeze({ api: false, pr: false, issues: true, labels: true, milestones: false, checks: false, releases: false, mention: false })
    this._local = buildLocalBackendMixins(this.kind, mainRoot, gitDir)
  }

  claimTask(args) { return this._local.localClaimTask(args) }
  releaseTask(args) { return this._local.localReleaseTask(args) }
  postComment(args) { return this._local.localPostComment(args) }
  addLabels(args) { return this._local.localAddLabels(args) }
  removeLabel(args) { return this._local.localRemoveLabel(args) }
  syncStateLabel(args) { return this._local.localSyncStateLabel(args) }
  createIssue(args) { return this._local.localCreateIssue(args) }
  getIssue(arg, maybeNumber) { return this._local.localGetIssue(arg, maybeNumber) }
  listIssues(args) { return this._local.localListIssues(args) }
  closeIssue(arg, maybeNumber) { return this._local.localCloseIssue(arg, maybeNumber) }
  listComments(arg, maybeNumber) { return this._local.localListComments(arg, maybeNumber) }
  listMilestones({ state = 'open' } = {}) {
    return {
      ...listLocalMilestones({ mainRoot: this.mainRoot, gitDir: this.gitDir, state }),
      capabilities: this.capabilities,
      platformSetupChecklist: ['generic-git 远端未开放统一里程碑 API，请在托管平台 Web 控制台手动同步里程碑。'],
    }
  }
  async createMilestone(args = {}) {
    const res = await createLocalMilestone({ mainRoot: this.mainRoot, gitDir: this.gitDir, ...args })
    return {
      ...res,
      capabilities: this.capabilities,
      platformSetupChecklist: [`在托管平台创建同名里程碑「${res.title ?? args.title}」`, '将关联 Issue/MR 手动归入该里程碑'],
    }
  }
  async closeMilestone(args = {}) {
    const res = await closeLocalMilestone({ mainRoot: this.mainRoot, gitDir: this.gitDir, ...args })
    return { ...res, capabilities: this.capabilities, platformSetupChecklist: [`在托管平台 Web 控制台关闭里程碑 #${args.number}`] }
  }
  async assignMilestone(args = {}) {
    const res = await assignLocalMilestone({ mainRoot: this.mainRoot, gitDir: this.gitDir, ...args })
    return { ...res, capabilities: this.capabilities, platformSetupChecklist: [`在托管平台将 #${args.number} 关联至里程碑 ${args.milestone}`] }
  }
  async findOpenPrForBranch() { return { ok: true, prs: [], skipped: true, reason: 'generic-git' } }
  async createPr({ taskId, head, base, title } = {}) {
    const eventPath = await appendBackendEvent(this.mainRoot, this.gitDir, taskId ?? 'shared', { backend: this.kind, action: 'mr-intent', head, base, title })
    return { ok: true, mode: 'generic-git-push-only', number: null, status: 'submitted', eventPath }
  }
  async updatePrBase({ taskId, number, base } = {}) {
    const eventPath = await appendBackendEvent(this.mainRoot, this.gitDir, taskId ?? 'shared', { backend: this.kind, action: 'update-pr-base', number: number ?? null, base })
    return { ok: true, number: number ?? null, base, mode: 'generic-remote-event-log', eventPath }
  }
  async getPr() { return { ok: false, skipped: true, reason: 'generic-git' } }
  async getCommitChecks() { return { ok: true, bucket: 'none', total: 0, passed: [], pending: [], failed: [], skipped: true, reason: 'generic-git' } }

  async closePr(arg, maybeOpts = {}) {
    const cfg = normalizeClosePrArgs(arg, maybeOpts)
    if (!Number.isInteger(cfg.prNumber) || cfg.prNumber <= 0) return { ok: false, error: 'invalid-pr-number' }
    const delegatedPayload = {
      action: 'close-pr',
      targetType: 'pr',
      targetNumber: cfg.prNumber,
      repo: cfg.repo ?? this.targetRepo,
      comment: cfg.comment || null,
      labels: cfg.labels,
      state: 'closed',
      ...(cfg.reason ? { reason: cfg.reason } : {}),
      ...(Object.keys(cfg.statePayload).length > 0 ? { statePayload: cfg.statePayload } : {}),
      instructions: [
        cfg.comment ? `在托管平台 PR/MR #${cfg.prNumber} 下发布分诊说明评论` : null,
        cfg.labels.length > 0 ? `为 PR/MR #${cfg.prNumber} 贴上标签：${cfg.labels.join(', ')}` : null,
        `在托管平台 Web 控制台关闭 PR/MR #${cfg.prNumber}`,
      ].filter(Boolean),
    }
    let eventPath = null
    if (!cfg.dryRun) {
      eventPath = await appendBackendEvent(this.mainRoot, this.gitDir, cfg.taskId ?? `pr-${cfg.prNumber}`, {
        backend: this.kind, action: 'close-pr-delegated', number: cfg.prNumber, labels: cfg.labels, comment: cfg.comment || null,
      })
    }
    return {
      ok: true,
      delegated: true,
      dryRun: cfg.dryRun,
      number: cfg.prNumber,
      state: cfg.dryRun ? 'OPEN' : 'CLOSED',
      delegatedPayload,
      ...(eventPath ? { eventPath } : {}),
    }
  }

  async mergePr({ remoteMerged = false, humanApproved = false, ledger, branch, baseBranch } = {}) {
    if (!remoteMerged && !humanApproved) {
      return {
        ok: false, blocked: true, code: 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED', exitCode: 3,
        message: 'BLOCKED_GENERIC_REMOTE_MR_REQUIRED: generic-git 有远端仓必须先在远端托管平台完成 MR/PR 合并，确认后再带 --remote-merged（或 --human-approved）执行 merge。',
      }
    }
    return {
      ok: true, merged: true, remoteMerged: Boolean(remoteMerged), humanApproved: Boolean(humanApproved),
      state: 'MERGED', branch: branch ?? ledger?.branch ?? null, into: baseBranch ?? ledger?.baseBranch ?? 'main',
    }
  }
}

export class LocalOnlyBackend {
  constructor({ mainRoot = process.cwd(), gitDir = null, baseBranch = 'main' } = {}) {
    this.kind = 'local-only'
    this.mainRoot = mainRoot
    this.gitDir = gitDir
    this.baseBranch = baseBranch
    this.capabilities = Object.freeze({ api: false, pr: false, issues: true, labels: true, milestones: true, checks: false, releases: false, mention: false })
    this._local = buildLocalBackendMixins(this.kind, mainRoot, gitDir)
  }

  claimTask(args) { return this._local.localClaimTask(args) }
  releaseTask(args) { return this._local.localReleaseTask(args) }
  postComment(args) { return this._local.localPostComment(args) }
  addLabels(args) { return this._local.localAddLabels(args) }
  removeLabel(args) { return this._local.localRemoveLabel(args) }
  syncStateLabel(args) { return this._local.localSyncStateLabel(args) }
  createIssue(args) { return this._local.localCreateIssue(args) }
  getIssue(arg, maybeNumber) { return this._local.localGetIssue(arg, maybeNumber) }
  listIssues(args) { return this._local.localListIssues(args) }
  closeIssue(arg, maybeNumber) { return this._local.localCloseIssue(arg, maybeNumber) }
  listComments(arg, maybeNumber) { return this._local.localListComments(arg, maybeNumber) }
  listMilestones(args = {}) { return listLocalMilestones({ mainRoot: this.mainRoot, gitDir: this.gitDir, ...args }) }
  createMilestone(args = {}) { return createLocalMilestone({ mainRoot: this.mainRoot, gitDir: this.gitDir, ...args }) }
  closeMilestone(args = {}) { return closeLocalMilestone({ mainRoot: this.mainRoot, gitDir: this.gitDir, ...args }) }
  assignMilestone(args = {}) { return assignLocalMilestone({ mainRoot: this.mainRoot, gitDir: this.gitDir, ...args }) }
  async findOpenPrForBranch() { return { ok: true, prs: [], skipped: true, reason: 'local-only' } }

  async createPr({ taskId, head, base, title } = {}) {
    const eventPath = await appendBackendEvent(this.mainRoot, this.gitDir, taskId ?? 'shared', { backend: this.kind, action: 'local-ready', head, base, title })
    return { ok: true, localReady: true, status: 'local-ready', number: null, eventPath }
  }
  async updatePrBase({ taskId, number, base } = {}) {
    const eventPath = await appendBackendEvent(this.mainRoot, this.gitDir, taskId ?? 'shared', { backend: this.kind, action: 'update-base', number: number ?? null, base })
    return { ok: true, number: number ?? null, base, mode: 'local-only', eventPath }
  }

  async getPr(repoOrOpts, number) {
    const parsed = normalizeGetPrArgs(repoOrOpts, number)
    const num = Number(parsed.number)
    if (Number.isInteger(num) && num > 0) {
      const stored = getLocalPr({ mainRoot: this.mainRoot, gitDir: this.gitDir, number: num })
      if (stored.ok) return stored
    }
    return { ok: false, skipped: true, reason: 'local-only' }
  }

  async closePr(arg, maybeOpts = {}) {
    const cfg = normalizeClosePrArgs(arg, maybeOpts)
    if (!Number.isInteger(cfg.prNumber) || cfg.prNumber <= 0) return { ok: false, error: 'invalid-pr-number' }
    if (cfg.dryRun) {
      return {
        ok: true, local: true, dryRun: true, number: cfg.prNumber, state: 'OPEN',
        planned: { comment: Boolean(cfg.comment), labels: cfg.labels, close: true },
      }
    }
    const res = await closeLocalPr({
      mainRoot: this.mainRoot, gitDir: this.gitDir, number: cfg.prNumber,
      comment: cfg.comment, labels: cfg.labels, statePayload: cfg.statePayload,
      reason: cfg.reason, decision: cfg.decision,
    })
    if (res.ok) {
      await appendBackendEvent(this.mainRoot, this.gitDir, cfg.taskId ?? `pr-${cfg.prNumber}`, {
        backend: this.kind, action: 'close-pr', number: cfg.prNumber, labels: res.labels, decision: res.triage?.decision ?? null,
      })
    }
    return res
  }

  async getCommitChecks() { return { ok: true, bucket: 'none', total: 0, passed: [], pending: [], failed: [], skipped: true, reason: 'local-only' } }

  async mergePr({
    ledger, mainRoot: mrArg, baseBranch: bbArg, profile = null, evidence = null,
    policy = null, changedFiles = [], runVerify = true, trialMerger = null,
  } = {}) {
    const root = mrArg ?? this.mainRoot
    const targetBase = bbArg ?? ledger?.baseBranch ?? this.baseBranch ?? 'main'
    if (typeof trialMerger === 'function') {
      const res = await trialMerger({ mainRoot: root, ledger, baseBranch: targetBase, profile, evidence, policy, changedFiles, runVerify })
      if (res?.ok && ledger?.taskId) {
        await appendBackendEvent(this.mainRoot, this.gitDir, ledger.taskId, { backend: this.kind, action: 'merged', branch: ledger.branch ?? null, into: targetBase })
      }
      return res
    }
    if (!ledger?.branch) return { ok: true, localMerge: true, merged: true, into: targetBase }
    const mainSt = await gitStatusPorcelainZ(root)
    if (!mainSt.ok || mainSt.entries.length > 0) {
      return { ok: false, blocked: true, code: 'BLOCKED_DIRTY_MAIN', exitCode: 3, message: 'BLOCKED_DIRTY_MAIN: 主工作区存在未提交改动，无法并入基线分支，请清理后再 merge。' }
    }
    const fastGitDir = this.gitDir ?? resolveGitDirFast(root)
    const fastBrSha = resolveRefShaFast(fastGitDir, `refs/heads/${ledger.branch}`)
    const brRes = fastBrSha ? { ok: true, stdout: fastBrSha } : await gitRun(root, ['rev-parse', '--verify', `refs/heads/${ledger.branch}`])
    if (!brRes.ok) return { ok: false, blocked: true, code: 'BRANCH_NOT_FOUND', exitCode: 1, message: brRes.stderr }
    const branchSha = brRes.stdout.trim()
    const baseRef = `refs/heads/${targetBase}`
    const fastBaseSha = resolveRefShaFast(fastGitDir, baseRef)
    const baseRes = fastBaseSha ? { ok: true, stdout: fastBaseSha } : await gitRun(root, ['rev-parse', '--verify', '--quiet', baseRef])
    if (!baseRes.ok) {
      const up = await gitRun(root, ['update-ref', baseRef, branchSha])
      return { ok: up.ok, localMerge: up.ok, merged: up.ok, into: targetBase, mergedSha: branchSha }
    }
    const fastHeadBr = readHeadFast(fastGitDir)?.branch ?? null
    const curMainRes = fastHeadBr ? { ok: true, stdout: fastHeadBr } : await gitRun(root, ['symbolic-ref', '--short', 'HEAD'])
    const curMain = curMainRes.ok ? curMainRes.stdout.trim() : ''
    if (curMain === targetBase) {
      const ff = await gitRun(root, ['merge', '--ff-only', branchSha])
      if (ff.ok) return { ok: true, localMerge: true, merged: true, into: targetBase, mergedSha: branchSha }
    }
    return { ok: false, blocked: true, code: 'BLOCKED_TRIAL_MERGER_REQUIRED', exitCode: 3, message: '非快进本地合并必须经 runTrialMerge 在临时 --detach worktree 试合复测。' }
  }
}

/** 根据身份角色与托管协议构造统一的 17 方法 TaskBackend。 */
export function createTaskBackend({
  role = 'local-only', providerId = 'github', targetRepo = null, client = null,
  pushRemote = 'origin', mainRoot = process.cwd(), gitDir = null, baseBranch = 'main',
} = {}) {
  if (role === 'local-only' || providerId === 'none') return new LocalOnlyBackend({ mainRoot, gitDir, baseBranch })
  if (role === 'generic-git' || providerId === 'generic-git' || !targetRepo) {
    return new GenericRemoteBackend({ targetRepo, pushRemote, mainRoot, gitDir })
  }
  return new GitHubBackend({ targetRepo, client, pushRemote, mainRoot, gitDir })
}
