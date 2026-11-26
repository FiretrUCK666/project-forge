/**
 * task-backend-local.mjs —— `LocalOnlyBackend` / `GenericRemoteBackend` 与 TaskBackend 共享原语。
 *
 * 从 task-backend.mjs 拆出以严守单文件 <= 800 行预算，严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXIT } from './exit-codes.mjs'
import { gitRun, gitStatusPorcelainZ, inspectBranchMergeState, readTextSafe, resolveDefaultBranch, withFileLock } from './git.mjs'
import { readHeadFast, resolveGitDirFast, resolveRefShaFast } from './git-fast.mjs'
import { parsePfStateTags } from './github-client.mjs'
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
  updateLocalIssue,
} from './local-issues.mjs'
import { hasDecisionKey, readDecisionMap, readDecisions, resolveDecisionValue } from './profile.mjs'

export const WORKFLOW_STATE_LABELS = Object.freeze({
  'in-progress': Object.freeze({ primary: 'in-progress', aliases: ['in-progress', 'status:in-progress', 'wip', 'doing'], removes: ['in-review', 'changes-requested', 'reviewed'] }),
  'in-review': Object.freeze({ primary: 'in-review', aliases: ['in-review', 'status:in-review', 'review', 'needs-review'], removes: ['in-progress', 'changes-requested'] }),
  'changes-requested': Object.freeze({ primary: 'changes-requested', aliases: ['changes-requested', 'status:changes-requested', 'rework'], removes: ['in-review', 'reviewed'] }),
  reviewed: Object.freeze({ primary: 'reviewed', aliases: ['reviewed', 'status:reviewed', 'approved', 'ready-to-merge'], removes: ['in-review', 'changes-requested', 'in-progress'] }),
})

export function hasNoLabelsDecision(mainRoot) {
  if (!mainRoot) return false
  const txt = readTextSafe(join(mainRoot, 'AGENTS.md'))
  return txt ? readDecisions(txt).has('no-labels') : false
}

export function resolveSemanticStateLabel(stateName, existingRepoLabels = []) {
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

export function normalizeFindArgs(repoOrOpts, headBranch, opts = {}) {
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

export function normalizeGetPrArgs(repoOrOpts, number) {
  if (typeof repoOrOpts === 'number') return { repo: null, number: repoOrOpts }
  if (typeof repoOrOpts === 'string' && number === undefined && /^\d+$/.test(repoOrOpts.trim())) {
    return { repo: null, number: Number(repoOrOpts.trim()) }
  }
  if (repoOrOpts && typeof repoOrOpts === 'object') {
    return { repo: repoOrOpts.repo ?? repoOrOpts.targetRepo ?? null, number: repoOrOpts.number ?? repoOrOpts.prNumber }
  }
  return { repo: repoOrOpts ?? null, number }
}

export function normalizeClosePrArgs(arg, maybeOpts = {}) {
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

export function normalizeIssueArgs(arg, maybeNumber) {
  if (typeof arg === 'number') return { repo: null, number: arg }
  if (typeof arg === 'string' && maybeNumber === undefined && /^\d+$/.test(arg.trim())) {
    return { repo: null, number: Number(arg.trim()) }
  }
  if (arg && typeof arg === 'object') return { repo: arg.repo ?? arg.targetRepo ?? null, number: arg.number ?? arg.issue }
  return { repo: arg ?? null, number: maybeNumber }
}

export function normalizeListCommentArgs(arg, maybeNumber) {
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
  const localUpdateIssueBody = async ({ taskId, repo, number, body } = {}) => {
    const num = number !== undefined && number !== null ? Number(number) : null
    if (num && Number.isInteger(num) && num > 0 && getLocalIssue({ mainRoot, gitDir, number: num }).ok) {
      return updateLocalIssue({ mainRoot, gitDir, number: num, patch: { body } })
    }
    const eventPath = await appendBackendEvent(mainRoot, gitDir, taskId ?? (num ? `ref-${num}` : 'shared'), {
      backend: kind, action: 'update-issue-body', repo: repo ?? null, number: num, body,
    })
    return { ok: true, local: true, mode: modeLabel, number: num, eventPath }
  }
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
    localSyncStateLabel, localCreateIssue, localGetIssue, localUpdateIssueBody, localListIssues, localCloseIssue, localListComments,
  }
}

function resolveLocalBareRemotePath(mainRoot, rawUrl) {
  const s = String(rawUrl ?? '').trim()
  if (!s) return null
  let localPath = null
  if (/^file:\/\//i.test(s)) {
    try { localPath = fileURLToPath(s) } catch { return null }
  } else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^[^/\\@]+@[^:]+:/i.test(s)) {
    localPath = resolve(mainRoot, s)
  }
  if (!localPath || !existsSync(localPath)) return null
  return localPath
}

/** 合后以快进（ff-only）方式安全同步主工作区与本地默认分支引用，避免清理清单误报 (unmerged)。 */
export async function syncLocalDefaultBranchAfterMerge({
  mainRoot,
  gitDir = null,
  remote = 'origin',
  baseBranch = null,
  fetch = true,
} = {}) {
  const base = baseBranch || await resolveDefaultBranch(mainRoot, { strict: true })
  if (!base) return { synced: false, reason: 'missing-default-branch' }
  const remoteName = remote || 'origin'
  if (fetch) {
    await gitRun(mainRoot, ['fetch', '--prune', '--quiet', remoteName, base])
  }
  const fastMainBr = readHeadFast(resolveGitDirFast(mainRoot), gitDir)?.branch ?? null
  const curMainBr = fastMainBr ? { ok: true, stdout: fastMainBr } : await gitRun(mainRoot, ['symbolic-ref', '--short', 'HEAD'])
  const curBranch = curMainBr.ok ? curMainBr.stdout.trim() : ''
  if (curBranch === base) {
    const st = await gitStatusPorcelainZ(mainRoot)
    if (st.ok && st.entries.length === 0) {
      const m = await gitRun(mainRoot, ['merge', '--ff-only', '--no-edit', `${remoteName}/${base}`])
      return { synced: m.ok, baseBranch: base, via: 'merge-ff-only', error: m.ok ? null : (m.stderr || m.stdout || '').trim() }
    }
    return { synced: false, baseBranch: base, reason: 'dirty-main' }
  }
  const f = await gitRun(mainRoot, ['fetch', remoteName, `${base}:${base}`])
  return { synced: f.ok, baseBranch: base, via: 'fetch-refspec', error: f.ok ? null : (f.stderr || f.stdout || '').trim() }
}

async function tryLocalBareFastForwardMerge({ mainRoot, remote, targetBranch, base, ledger, humanApproved }) {
  if (!targetBranch || !ledger?.reviewPassed) return null
  const agentsText = readTextSafe(join(mainRoot, 'AGENTS.md')) ?? ''
  const decisions = readDecisionMap(agentsText)
  const branchProtectionVal = resolveDecisionValue(decisions, agentsText, 'branch-protection')
  const allowsFastForward = hasDecisionKey(decisions, agentsText, 'no-branch-protection')
    || hasDecisionKey(decisions, agentsText, 'solo-fast-forward')
    || (typeof branchProtectionVal === 'string' && /^`?no-branch-protection`?(?:\s|$|[，。；,;（(])/i.test(branchProtectionVal.trim()))
  if (!allowsFastForward) return null

  const urlRes = await gitRun(mainRoot, ['remote', 'get-url', remote])
  const localBarePath = urlRes.ok ? resolveLocalBareRemotePath(mainRoot, urlRes.stdout) : null
  if (!localBarePath) return null
  const bareRes = await gitRun(localBarePath, ['rev-parse', '--is-bare-repository'])
  if (!bareRes.ok || bareRes.stdout.trim() !== 'true') return null

  const baseRefRes = await gitRun(mainRoot, ['rev-parse', '--verify', `refs/remotes/${remote}/${base}`])
  if (!baseRefRes.ok || !baseRefRes.stdout.trim()) return null
  const baseSha = baseRefRes.stdout.trim()

  const remoteBranchRes = await gitRun(mainRoot, ['rev-parse', '--verify', `refs/remotes/${remote}/${targetBranch}`])
  const localBranchRes = remoteBranchRes.ok ? remoteBranchRes : await gitRun(mainRoot, ['rev-parse', '--verify', `refs/heads/${targetBranch}`])
  if (!localBranchRes.ok || !localBranchRes.stdout.trim()) return null
  const targetSha = localBranchRes.stdout.trim()
  if (ledger.reviewPassedHead && ledger.reviewPassedHead !== targetSha) return null

  const ancRes = await gitRun(mainRoot, ['merge-base', '--is-ancestor', baseSha, targetSha])
  if (!ancRes.ok) return null

  const pushRes = await gitRun(mainRoot, ['push', remote, `${targetSha}:refs/heads/${base}`], { env: { PF_ALLOW_DIRECT_PUSH: '1' } })
  if (!pushRes.ok) return null
  await gitRun(mainRoot, ['fetch', '--prune', '--quiet', remote])

  await syncLocalDefaultBranchAfterMerge({ mainRoot, remote, baseBranch: base, fetch: false })

  return {
    ok: true, merged: true, fetched: true, localBareFastForward: true,
    mergeState: 'fast-forward', humanApproved: Boolean(humanApproved),
    state: 'MERGED', branch: targetBranch, into: base, mergedSha: targetSha,
  }
}

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
  updateIssueBody(args) { return this._local.localUpdateIssueBody(args) }
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

  /**
   * generic-git 收尾：先看远端事实，再决定能不能算合并。判定用既有的四态合流判定
   * （`inspectBranchMergeState`），别的三处也用它。判定前先取回远端——本地引用是上次
   * 取回时的快照，不取回就判会把「远端已合但我还没看到」误报成未合并。
   */
  async mergePr({ humanApproved = false, ledger, branch, baseBranch } = {}) {
    const targetBranch = branch ?? ledger?.branch ?? null
    const base = baseBranch ?? ledger?.baseBranch ?? await resolveDefaultBranch(this.mainRoot, { strict: true })
    if (!base) {
      return {
        ok: false, blocked: true, code: 'BLOCKED_MISSING_DEFAULT_BRANCH', exitCode: EXIT.FACT,
        fetched: false, humanApproved: false,
        message: 'BLOCKED_MISSING_DEFAULT_BRANCH: 无法解析仓库真实默认分支，无法核验远端合流状态。',
      }
    }
    const remote = this.pushRemote || 'origin'
    const fetchRes = await gitRun(this.mainRoot, ['fetch', '--prune', '--quiet', remote])
    const fetched = fetchRes.ok
    if (!fetched && !humanApproved) {
      return {
        ok: false, blocked: true, code: 'BLOCKED_MERGE_STATE_UNVERIFIED', exitCode: EXIT.FACT,
        fetched: false, humanApproved: false,
        message: `BLOCKED_MERGE_STATE_UNVERIFIED: 取回远端失败（${(fetchRes.stderr || '').trim().slice(0, 200)}），`
          + '无法核验分支是否已在远端合并。请先修复网络或凭据再重试；'
          + '确需人工拍板时带 --human-approved --reason "<为什么可以在核不到的情况下放行>"。',
      }
    }
    // 核不到远端 + 人类签字：唯一允许「带着不确定性放行」的通道。区别必须写进记录
    // （`verified: false` 加签字理由），事后有人问「这次凭什么合的」，答案在账本里。
    if (!fetched && humanApproved) {
      return {
        ok: true, merged: true, fetched: false, verified: false, humanApproved: true,
        state: 'MERGED', branch: targetBranch, into: base,
        reason: '远端取回失败，由人类签字放行；合并状态未经机器核验',
      }
    }
    // 核对远端引用，不是本地分支：本地那条可能还停在合并前，拿它判等于用旧快照回答新问题。
    const baseRef = fetched ? `${remote}/${base}` : base
    let targetRef = targetBranch ? (fetched ? `${remote}/${targetBranch}` : targetBranch) : undefined
    let targetHeadSha
    if (fetched && targetBranch) {
      const remoteTargetRes = await gitRun(this.mainRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${targetBranch}`])
      if (!remoteTargetRes.ok) {
        // 远端合并后可能已自动删除远程分支：回退用已提交 SHA 或本地跟踪提交对照远端主干核验四态
        targetRef = undefined
        targetHeadSha = ledger?.lastSubmittedHead || ledger?.verifiedHead || undefined
        if (!targetHeadSha) {
          const localRes = await gitRun(this.mainRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${targetBranch}`])
          if (localRes.ok && localRes.stdout.trim()) targetHeadSha = localRes.stdout.trim()
        }
      }
    }
    const state = await inspectBranchMergeState(this.mainRoot, {
      branch: targetRef,
      headSha: targetHeadSha,
      defaultBranch: baseRef,
      gitDir: this.gitDir,
    })
    const mergedStates = new Set(['merged', 'squash_or_rebase_merged', 'no_own_commits'])
    if (!mergedStates.has(state.state)) {
      const ffMerged = await tryLocalBareFastForwardMerge({
        mainRoot: this.mainRoot, remote, targetBranch, base, ledger, humanApproved,
      })
      if (ffMerged) return ffMerged
      return {
        ok: false, blocked: true, code: 'BLOCKED_REMOTE_NOT_MERGED', exitCode: EXIT.FACT,
        fetched, mergeState: state.state, ownCommits: state.ownCommits,
        message: `BLOCKED_REMOTE_NOT_MERGED: 远端核验显示分支 ${targetBranch} 上还有 ${state.ownCommits} 个提交没进 ${base}`
          + `（四态判定=${state.state}）。请先在远端托管完成合并，再重跑 merge。`,
      }
    }
    return {
      ok: true, merged: true, fetched, mergeState: state.state, humanApproved: Boolean(humanApproved),
      state: 'MERGED', branch: targetBranch, into: base,
    }
  }
}

export class LocalOnlyBackend {
  constructor({ mainRoot = process.cwd(), gitDir = null, baseBranch = null } = {}) {
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
  updateIssueBody(args) { return this._local.localUpdateIssueBody(args) }
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
    const targetBase = bbArg ?? ledger?.baseBranch ?? this.baseBranch ?? await resolveDefaultBranch(root, { strict: true })
    if (!targetBase) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_MISSING_DEFAULT_BRANCH',
        exitCode: EXIT.FACT,
        message: 'BLOCKED_MISSING_DEFAULT_BRANCH: 仓库缺少可用的默认基线分支（严禁擅自创建 main），请先确认或创建基线分支后再合并。',
      }
    }
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
      return { ok: false, blocked: true, code: 'BLOCKED_DIRTY_MAIN', exitCode: EXIT.FACT, message: 'BLOCKED_DIRTY_MAIN: 主工作区存在未提交改动，无法并入基线分支，请清理后再 merge。' }
    }
    const fastGitDir = this.gitDir ?? resolveGitDirFast(root)
    const fastBrSha = resolveRefShaFast(fastGitDir, `refs/heads/${ledger.branch}`)
    const brRes = fastBrSha ? { ok: true, stdout: fastBrSha } : await gitRun(root, ['rev-parse', '--verify', `refs/heads/${ledger.branch}`])
    if (!brRes.ok) return { ok: false, blocked: true, code: 'BRANCH_NOT_FOUND', exitCode: EXIT.ACTION, message: brRes.stderr }
    const branchSha = brRes.stdout.trim()
    const baseRef = `refs/heads/${targetBase}`
    const fastBaseSha = resolveRefShaFast(fastGitDir, baseRef)
    const baseRes = fastBaseSha ? { ok: true, stdout: fastBaseSha } : await gitRun(root, ['rev-parse', '--verify', '--quiet', baseRef])
    if (!baseRes.ok) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_MISSING_DEFAULT_BRANCH',
        exitCode: EXIT.FACT,
        message: `BLOCKED_MISSING_DEFAULT_BRANCH: 基线分支 ${targetBase} 不存在（禁止擅自 update-ref 造旁支），请先检查默认分支。`,
      }
    }
    const fastHeadBr = readHeadFast(fastGitDir)?.branch ?? null
    const curMainRes = fastHeadBr ? { ok: true, stdout: fastHeadBr } : await gitRun(root, ['symbolic-ref', '--short', 'HEAD'])
    const curMain = curMainRes.ok ? curMainRes.stdout.trim() : ''
    if (curMain === targetBase) {
      const ff = await gitRun(root, ['merge', '--ff-only', branchSha])
      if (ff.ok) return { ok: true, localMerge: true, merged: true, into: targetBase, mergedSha: branchSha }
    }
    return { ok: false, blocked: true, code: 'BLOCKED_TRIAL_MERGER_REQUIRED', exitCode: EXIT.FACT, message: '非快进本地合并必须经 runTrialMerge 在临时 --detach worktree 试合复测。' }
  }
}
