/**
 * local-issues.mjs —— 无远端 / 通用托管兼容的原子本地工单存储引擎。
 *
 * 数据存于 `<effectiveGitDir>/project-forge-flow/issues/`（`index.json` + `items/{id}.json`），
 * 经 `resolveGitDirFast` + `commondir` 由主仓与全部 `.worktrees/*` 天然共享，工作区 `git status` 零污染。
 * 严格零第三方依赖（仅 Node 18+ 内置模块），并发安全依赖 `withFileLock` 与原子写入。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { readTextSafe, withFileLock, writeJsonAtomic } from './git.mjs'
import { resolveGitDirFast } from './git-fast.mjs'
import { computeWriteBackFingerprint, parseBodyRelations, parsePfStateTags } from './github-parse.mjs'

/** 解析跨主仓与全部 worktree 共享的 effectiveGitDir。 */
export function resolveEffectiveCommonGitDir(mainRoot, gitDir = null) {
  const candidate = gitDir || (mainRoot ? resolveGitDirFast(mainRoot) : null)
  if (candidate) {
    const cdTxt = readTextSafe(join(candidate, 'commondir'))
    return cdTxt ? resolve(candidate, cdTxt.trim()) : candidate
  }
  if (mainRoot && existsSync(join(mainRoot, '.git'))) {
    const dotGit = join(mainRoot, '.git')
    const cdTxt = readTextSafe(join(dotGit, 'commondir'))
    return cdTxt ? resolve(dotGit, cdTxt.trim()) : dotGit
  }
  return null
}

/** 解析本地工单存储根目录：`<effectiveGitDir>/project-forge-flow/issues`。 */
export function resolveLocalIssuesDir(mainRoot = process.cwd(), gitDir = null) {
  const commonGitDir = resolveEffectiveCommonGitDir(mainRoot, gitDir)
  if (commonGitDir) return join(commonGitDir, 'project-forge-flow', 'issues')
  return join(mainRoot || process.cwd(), '.worktrees', '.state', 'issues')
}

function issuePaths(mainRoot, gitDir, number) {
  const rootDir = resolveLocalIssuesDir(mainRoot, gitDir)
  return {
    rootDir,
    indexPath: join(rootDir, 'index.json'),
    milestonesPath: join(rootDir, 'milestones.json'),
    itemsDir: join(rootDir, 'items'),
    lockPath: join(rootDir, 'issues.lock'),
    itemPath: number !== undefined && number !== null ? join(rootDir, 'items', `${Number(number)}.json`) : null,
  }
}

function readStrictLocalJson(filePath, label) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return { exists: false, data: null }
    throw new Error(`LOCAL_ISSUE_READ_FAILED: 无法读取${label} (${filePath}): ${err instanceof Error ? err.message : String(err)}`)
  }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('JSON 顶层结构必须为对象')
    }
    return { exists: true, data: parsed }
  } catch (err) {
    throw new Error(`LOCAL_ISSUE_CORRUPTED: ${label}已损坏 (${filePath}): ${err instanceof Error ? err.message : String(err)}`)
  }
}

function readStrictLocalIssueItem(filePath, expectedNum, label) {
  const res = readStrictLocalJson(filePath, label)
  if (!res.exists) return null
  const item = res.data
  const validNum = expectedNum !== null && expectedNum !== undefined
    ? Number.isInteger(item.number) && item.number === expectedNum
    : Number.isInteger(item.number) && item.number > 0
  if (!validNum) {
    throw new Error(`LOCAL_ISSUE_CORRUPTED: ${label}数据结构非法 (${filePath})`)
  }
  return item
}

function readOrInitIndex(rootDir, indexPath, itemsDir) {
  const idxRes = readStrictLocalJson(indexPath, '本地工单索引 index.json')
  if (idxRes.exists) {
    const existing = idxRes.data
    if (!Number.isInteger(existing.nextId) || existing.nextId < 1 || !existing.items || typeof existing.items !== 'object' || Array.isArray(existing.items)) {
      throw new Error(`LOCAL_ISSUE_CORRUPTED: 本地工单索引 index.json 结构非法 (${indexPath})`)
    }
    return existing
  }
  const items = {}
  let maxId = 0
  if (existsSync(itemsDir)) {
    for (const f of readdirSync(itemsDir)) {
      if (!/^\d+\.json$/.test(f)) continue
      const item = readStrictLocalIssueItem(join(itemsDir, f), null, `本地工单 ${f}`)
      if (!item) continue
      maxId = Math.max(maxId, item.number)
      items[String(item.number)] = summarizeItem(item)
    }
  }
  return { version: 1, nextId: maxId + 1, items }
}

function summarizeItem(item) {
  return {
    number: item.number,
    title: item.title,
    state: item.state,
    labels: [...(item.labels ?? [])],
    assignees: [...(item.assignees ?? [])],
    milestone: item.milestone ?? null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    closedAt: item.closedAt ?? null,
    ...(item.migratedTo ? { migratedTo: item.migratedTo } : {}),
  }
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) return []
  return [...new Set(labels.map((l) => String(l ?? '').trim()).filter(Boolean))]
}

function commentMatchesFp(c, fp) {
  if (!c || !fp) return false
  const states = Array.isArray(c.pfStates) && c.pfStates.length > 0 ? c.pfStates : parsePfStateTags(c.body)
  return states.some((s) => (s?.writeBackFingerprint ?? computeWriteBackFingerprint(c.body ?? '', s)) === fp)
}

/** 创建一条原子持久化本地工单（编号自增）。 */
export async function createLocalIssue({
  mainRoot = process.cwd(),
  gitDir = null,
  title,
  body = '',
  labels = [],
  assignees = [],
  milestone = null,
} = {}) {
  const cleanTitle = String(title ?? '').trim()
  if (!cleanTitle) return { ok: false, error: 'missing-title' }
  const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
  const cleanLabels = normalizeLabels(labels)
  const cleanAssignees = normalizeLabels(assignees)
  const paths = issuePaths(mainRoot, gitDir)
  return withFileLock(paths.lockPath, () => {
    mkdirSync(paths.itemsDir, { recursive: true })
    const idx = readOrInitIndex(paths.rootDir, paths.indexPath, paths.itemsDir)
    const num = Number(idx.nextId) || 1
    const itemFile = join(paths.itemsDir, `${num}.json`)
    if (existsSync(itemFile)) {
      readStrictLocalJson(itemFile, `本地工单 #${num}`)
      throw new Error(`LOCAL_ISSUE_CORRUPTED: 本地工单 #${num} 文件已存在且 index.json 未同步 (${itemFile})`)
    }
    const now = new Date().toISOString()
    const item = {
      number: num,
      title: cleanTitle,
      body: normalizedBody,
      state: 'OPEN',
      labels: cleanLabels,
      comments: [],
      assignees: cleanAssignees,
      milestone: milestone ?? null,
      relations: parseBodyRelations(normalizedBody),
      url: `local-issue://${num}`,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      migratedTo: null,
    }
    idx.nextId = num + 1
    idx.items[String(num)] = summarizeItem(item)
    writeJsonAtomic(join(paths.itemsDir, `${num}.json`), item)
    writeJsonAtomic(paths.indexPath, idx)
    return { ok: true, local: true, ...item }
  })
}

/** 读取单条本地工单详情（含 comments 与 relations）。 */
export function getLocalIssue({ mainRoot = process.cwd(), gitDir = null, number } = {}) {
  const num = Number(number)
  if (!Number.isInteger(num) || num <= 0) return { ok: false, error: 'invalid-issue-number' }
  const paths = issuePaths(mainRoot, gitDir, num)
  const item = readStrictLocalIssueItem(paths.itemPath, num, `本地工单 #${num}`)
  if (!item) return { ok: false, status: 404, error: `local-issue-not-found: #${num}` }
  const comments = Array.isArray(item.comments) ? item.comments : []
  return {
    ok: true,
    local: true,
    ...item,
    comments,
    labels: Array.isArray(item.labels) ? item.labels : [],
    assignees: Array.isArray(item.assignees) ? item.assignees : [],
    relations: parseBodyRelations(item.body),
  }
}

/** 列举本地工单（默认 `state = 'open'`，支持 `'open' | 'closed' | 'all'`）。 */
export function listLocalIssues({ mainRoot = process.cwd(), gitDir = null, state = 'open' } = {}) {
  const paths = issuePaths(mainRoot, gitDir)
  if (existsSync(paths.indexPath)) readOrInitIndex(paths.rootDir, paths.indexPath, paths.itemsDir)
  if (!existsSync(paths.itemsDir)) return { ok: true, local: true, issues: [] }
  const want = String(state ?? 'open').toLowerCase()
  const issues = []
  for (const name of readdirSync(paths.itemsDir).sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))) {
    if (!/^\d+\.json$/.test(name)) continue
    const item = readStrictLocalIssueItem(join(paths.itemsDir, name), null, `本地工单 ${name}`)
    if (!item) continue
    const itemState = String(item.state ?? 'OPEN').toUpperCase()
    if (want === 'open' && itemState !== 'OPEN') continue
    if (want === 'closed' && itemState !== 'CLOSED') continue
    issues.push({
      ...item,
      state: itemState,
      labels: Array.isArray(item.labels) ? item.labels : [],
      assignees: Array.isArray(item.assignees) ? item.assignees : [],
      comments: Array.isArray(item.comments) ? item.comments : [],
      relations: parseBodyRelations(item.body),
    })
  }
  return { ok: true, local: true, issues }
}

async function mutateLocalIssue(mainRoot, gitDir, number, fn) {
  const num = Number(number)
  if (!Number.isInteger(num) || num <= 0) return { ok: false, error: 'invalid-issue-number' }
  const paths = issuePaths(mainRoot, gitDir, num)
  return withFileLock(paths.lockPath, () => {
    const item = readStrictLocalIssueItem(paths.itemPath, num, `本地工单 #${num}`)
    if (!item) return { ok: false, status: 404, error: `local-issue-not-found: #${num}` }
    const idx = readOrInitIndex(paths.rootDir, paths.indexPath, paths.itemsDir)
    const outcome = fn(item, idx, paths)
    if (outcome?.__abort) return outcome.result
    item.updatedAt = new Date().toISOString()
    idx.items[String(num)] = summarizeItem(item)
    mkdirSync(dirname(paths.itemPath), { recursive: true })
    writeJsonAtomic(paths.itemPath, item)
    writeJsonAtomic(paths.indexPath, idx)
    return outcome ?? { ok: true, local: true, ...item }
  })
}

/** 原子更新本地工单字段。 */
export async function updateLocalIssue({ mainRoot = process.cwd(), gitDir = null, number, patch = {} } = {}) {
  return mutateLocalIssue(mainRoot, gitDir, number, (item) => {
    if (patch.title !== undefined) item.title = String(patch.title).trim()
    if (patch.body !== undefined) {
      item.body = String(patch.body).replace(/\r\n/g, '\n').trim()
      item.relations = parseBodyRelations(item.body)
    }
    if (patch.labels !== undefined) item.labels = normalizeLabels(patch.labels)
    if (patch.assignees !== undefined) item.assignees = normalizeLabels(patch.assignees)
    if (patch.state !== undefined) item.state = String(patch.state).toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN'
    if (patch.closedAt !== undefined) item.closedAt = patch.closedAt
    if (patch.migratedTo !== undefined) item.migratedTo = patch.migratedTo
    if (patch.migratedUrl !== undefined) item.migratedUrl = patch.migratedUrl
    return { ok: true, local: true, ...item }
  })
}

/** 幂等关闭本地工单（已关闭则返回 `alreadyClosed: true`）。 */
export async function closeLocalIssue({
  mainRoot = process.cwd(),
  gitDir = null,
  number,
  reason = '',
  migratedTo = null,
  migratedUrl = null,
} = {}) {
  return mutateLocalIssue(mainRoot, gitDir, number, (item) => {
    const wasClosed = String(item.state ?? 'OPEN').toUpperCase() === 'CLOSED'
    if (migratedTo !== null && migratedTo !== undefined) item.migratedTo = migratedTo
    if (migratedUrl !== null && migratedUrl !== undefined) item.migratedUrl = migratedUrl
    if (reason) item.closeReason = String(reason)
    if (wasClosed) {
      return { ok: true, local: true, number: item.number, state: 'CLOSED', alreadyClosed: true, migratedTo: item.migratedTo ?? null }
    }
    item.state = 'CLOSED'
    item.closedAt = new Date().toISOString()
    return { ok: true, local: true, number: item.number, state: 'CLOSED', alreadyClosed: false, migratedTo: item.migratedTo ?? null }
  })
}

/** 向本地工单追加评论，内建 `pf-state` 标签与 `WriteBackFingerprint` sha256 去重。 */
export async function addLocalIssueComment({
  mainRoot = process.cwd(),
  gitDir = null,
  number,
  body,
  author = 'local',
  statePayload = {},
  deduplicate = true,
} = {}) {
  const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
  const hasState = statePayload && typeof statePayload === 'object' && Object.keys(statePayload).length > 0
  const fp = hasState ? computeWriteBackFingerprint(normalizedBody, statePayload) : null
  const finalState = hasState ? { ...statePayload, writeBackFingerprint: statePayload.writeBackFingerprint ?? fp } : null
  const tag = hasState ? `<!-- pf-state:${JSON.stringify(finalState)} -->` : ''
  const fullBody = hasState ? `${normalizedBody}\n\n${tag}` : normalizedBody

  return mutateLocalIssue(mainRoot, gitDir, number, (item) => {
    if (!Array.isArray(item.comments)) item.comments = []
    if (deduplicate && fp) {
      const dup = item.comments.find((c) => commentMatchesFp(c, fp))
      if (dup) {
        return {
          __abort: true,
          result: { ok: true, local: true, deduplicated: true, skipped: true, id: dup.id, url: dup.url, writeBackFingerprint: fp, verifiedReadback: true },
        }
      }
    }
    const nextCommentId = (item.comments.reduce((m, c) => Math.max(m, Number(c?.id) || 0), 0)) + 1
    const now = new Date().toISOString()
    const pfStates = parsePfStateTags(fullBody)
    const entry = {
      id: nextCommentId,
      author: author || 'local',
      body: fullBody,
      createdAt: now,
      updatedAt: now,
      url: `local-issue://${item.number}#comment-${nextCommentId}`,
      pfState: pfStates.length > 0 ? pfStates[pfStates.length - 1] : null,
      pfStates,
    }
    item.comments.push(entry)
    return {
      ok: true,
      local: true,
      id: entry.id,
      url: entry.url,
      verifiedReadback: true,
      ...(fp ? { writeBackFingerprint: fp } : {}),
    }
  })
}

/** 原子追加本地工单标签。 */
export async function addLocalIssueLabels({ mainRoot = process.cwd(), gitDir = null, number, labels = [] } = {}) {
  const toAdd = normalizeLabels(labels)
  if (toAdd.length === 0) return { ok: true, local: true, skipped: true }
  return mutateLocalIssue(mainRoot, gitDir, number, (item) => {
    item.labels = normalizeLabels([...(item.labels ?? []), ...toAdd])
    return { ok: true, local: true, number: item.number, labels: item.labels }
  })
}

/** 原子移除本地工单单个标签。 */
export async function removeLocalIssueLabel({ mainRoot = process.cwd(), gitDir = null, number, label } = {}) {
  const target = String(label ?? '').trim()
  if (!target) return { ok: true, local: true, skipped: true }
  return mutateLocalIssue(mainRoot, gitDir, number, (item) => {
    const before = Array.isArray(item.labels) ? item.labels : []
    if (!before.includes(target)) {
      return { ok: true, local: true, skipped: true, reason: 'label-absent', number: item.number, labels: before }
    }
    item.labels = before.filter((l) => l !== target)
    return { ok: true, local: true, number: item.number, labels: item.labels }
  })
}

/** 原子认领本地工单（他人已认领且无 `--takeover` 时阻断并返回 `BLOCKED_ISSUE_ALREADY_CLAIMED`）。 */
export async function claimLocalIssue({
  mainRoot = process.cwd(),
  gitDir = null,
  number,
  taskId = null,
  actor = null,
  actorDisplay = null,
  branch = null,
  takeover = false,
  reason = '',
  labels = ['in-progress'],
} = {}) {
  const cleanActor = String(actor ?? '').trim()
  return mutateLocalIssue(mainRoot, gitDir, number, (item) => {
    const assignees = Array.isArray(item.assignees) ? item.assignees : []
    const currentOwner = assignees[0] ?? null
    if (currentOwner && cleanActor && currentOwner !== cleanActor && !takeover) {
      return {
        __abort: true,
        result: {
          ok: false,
          blocked: true,
          code: 'BLOCKED_ISSUE_ALREADY_CLAIMED',
          exitCode: 3,
          number: item.number,
          claimedBy: currentOwner,
          message: `BLOCKED_ISSUE_ALREADY_CLAIMED: 本地工单 #${item.number} 已被 ${currentOwner} 认领；如需接管请显式传 --takeover --reason "..."。`,
        },
      }
    }
    if (takeover && !String(reason ?? '').trim()) {
      return {
        __abort: true,
        result: {
          ok: false,
          blocked: true,
          code: 'BLOCKED_TAKEOVER_REASON_REQUIRED',
          exitCode: 3,
          number: item.number,
          message: `BLOCKED_TAKEOVER_REASON_REQUIRED: 接管本地工单 #${item.number} 必须提供 --reason 说明接管原因。`,
        },
      }
    }
    if (cleanActor) item.assignees = [cleanActor]
    item.labels = normalizeLabels([...(item.labels ?? []), ...normalizeLabels(labels)])
    if (!Array.isArray(item.comments)) item.comments = []
    const action = takeover ? 'takeover' : 'claim'
    const disp = actorDisplay ?? cleanActor ?? 'local'
    const body = takeover
      ? `接管认领：由 ${disp} 接管任务 \`${taskId ?? 'manual'}\`（分支 \`${branch ?? 'none'}\`，原认领人：${currentOwner ?? '无/未知'}），原因：${reason}。`
      : `认领：由 ${disp} 在分支 \`${branch ?? 'none'}\` 开始处理（task: \`${taskId ?? 'manual'}\`）。`
    const statePayload = takeover
      ? { taskId, action: 'takeover', agent: cleanActor || disp, previousAgent: currentOwner, branch, reason }
      : { taskId, action: 'claim', agent: cleanActor || disp, branch }
    const fp = computeWriteBackFingerprint(body, statePayload)
    const enriched = { ...statePayload, writeBackFingerprint: fp }
    const fullBody = `${body}\n\n<!-- pf-state:${JSON.stringify(enriched)} -->`
    const nextCommentId = (item.comments.reduce((m, c) => Math.max(m, Number(c?.id) || 0), 0)) + 1
    const now = new Date().toISOString()
    const pfStates = parsePfStateTags(fullBody)
    const comment = {
      id: nextCommentId, author: cleanActor || 'local', body: fullBody, createdAt: now, updatedAt: now,
      url: `local-issue://${item.number}#comment-${nextCommentId}`, pfState: pfStates[pfStates.length - 1] ?? null, pfStates,
    }
    item.comments.push(comment)
    return {
      ok: true, local: true, issue: item.number, action, assignees: item.assignees,
      labels: item.labels, comment: { ok: true, id: comment.id, url: comment.url, verifiedReadback: true },
    }
  })
}

/** 原子释放本地工单认领（清 assignees 与 `in-progress` 标签并追加 release 备注）。 */
export async function releaseLocalIssue({
  mainRoot = process.cwd(),
  gitDir = null,
  number,
  taskId = null,
  actor = null,
  actorDisplay = null,
  branch = null,
  reason = '',
} = {}) {
  const cleanActor = String(actor ?? '').trim()
  return mutateLocalIssue(mainRoot, gitDir, number, (item) => {
    const prev = Array.isArray(item.assignees) ? item.assignees : []
    item.assignees = cleanActor ? prev.filter((a) => a !== cleanActor) : []
    item.labels = (Array.isArray(item.labels) ? item.labels : []).filter((l) => l !== 'in-progress')
    if (!Array.isArray(item.comments)) item.comments = []
    const disp = actorDisplay ?? cleanActor ?? 'local'
    const body = `释放认领：${disp} 放弃任务 \`${taskId ?? 'manual'}\`（分支 \`${branch ?? 'none'}\`）${reason ? `，原因：${reason}` : ''}。`
    const statePayload = { taskId, action: 'release', agent: cleanActor || disp, branch: branch ?? null, ...(reason ? { reason } : {}) }
    const fp = computeWriteBackFingerprint(body, statePayload)
    const fullBody = `${body}\n\n<!-- pf-state:${JSON.stringify({ ...statePayload, writeBackFingerprint: fp })} -->`
    const nextCommentId = (item.comments.reduce((m, c) => Math.max(m, Number(c?.id) || 0), 0)) + 1
    const now = new Date().toISOString()
    const pfStates = parsePfStateTags(fullBody)
    const comment = {
      id: nextCommentId, author: cleanActor || 'local', body: fullBody, createdAt: now, updatedAt: now,
      url: `local-issue://${item.number}#comment-${nextCommentId}`, pfState: pfStates[pfStates.length - 1] ?? null, pfStates,
    }
    item.comments.push(comment)
    return { ok: true, local: true, issue: item.number, assignees: item.assignees, labels: item.labels, comment: { ok: true, id: comment.id } }
  })
}

function readOrInitMilestones(milestonesPath) {
  const res = readStrictLocalJson(milestonesPath, '本地里程碑 milestones.json')
  if (res.exists) {
    const d = res.data
    if (!Number.isInteger(d.nextId) || d.nextId < 1 || !Array.isArray(d.items)) {
      throw new Error(`LOCAL_ISSUE_CORRUPTED: milestones.json 结构非法 (${milestonesPath})`)
    }
    return d
  }
  return { version: 1, nextId: 1, items: [] }
}

/** 本地原子创建里程碑（支持 local-only 与 generic-git 降级落盘）。 */
export async function createLocalMilestone({ mainRoot = process.cwd(), gitDir = null, title, description = '', dueOn = null } = {}) {
  const cleanTitle = String(title ?? '').trim()
  if (!cleanTitle) return { ok: false, error: 'missing-title' }
  const paths = issuePaths(mainRoot, gitDir)
  return withFileLock(paths.lockPath, () => {
    mkdirSync(paths.rootDir, { recursive: true })
    const store = readOrInitMilestones(paths.milestonesPath)
    const dup = store.items.find((m) => m.title.toLowerCase() === cleanTitle.toLowerCase() && m.state === 'open')
    if (dup) return { ok: true, local: true, existing: true, ...dup }
    const now = new Date().toISOString()
    const item = {
      number: store.nextId, title: cleanTitle, state: 'open', description: String(description ?? ''),
      dueOn: dueOn ?? null, url: `local-milestone://${store.nextId}`, createdAt: now, updatedAt: now, closedAt: null,
    }
    store.nextId += 1
    store.items.push(item)
    writeJsonAtomic(paths.milestonesPath, store)
    return { ok: true, local: true, ...item }
  })
}

/** 列出本地里程碑（open | closed | all）。 */
export function listLocalMilestones({ mainRoot = process.cwd(), gitDir = null, state = 'open' } = {}) {
  const paths = issuePaths(mainRoot, gitDir)
  const store = readOrInitMilestones(paths.milestonesPath)
  const stLow = String(state ?? 'open').toLowerCase()
  const milestones = store.items.filter((m) => stLow === 'all' || String(m.state).toLowerCase() === stLow)
  return { ok: true, local: true, milestones }
}

/** 原子关闭本地里程碑。 */
export async function closeLocalMilestone({ mainRoot = process.cwd(), gitDir = null, number } = {}) {
  const num = Number(number)
  if (!Number.isInteger(num) || num <= 0) return { ok: false, error: 'invalid-milestone-number' }
  const paths = issuePaths(mainRoot, gitDir)
  return withFileLock(paths.lockPath, () => {
    const store = readOrInitMilestones(paths.milestonesPath)
    const hit = store.items.find((m) => m.number === num)
    if (!hit) return { ok: false, error: `milestone #${num} not found` }
    hit.state = 'closed'
    hit.closedAt = new Date().toISOString()
    hit.updatedAt = hit.closedAt
    writeJsonAtomic(paths.milestonesPath, store)
    return { ok: true, local: true, ...hit }
  })
}

/** 原子为本地工单绑定里程碑（按编号或标题匹配）。 */
export async function assignLocalMilestone({ mainRoot = process.cwd(), gitDir = null, number, milestone } = {}) {
  const issueNum = Number(number)
  const paths = issuePaths(mainRoot, gitDir)
  const store = readOrInitMilestones(paths.milestonesPath)
  const rawMs = milestone?.number ?? milestone
  const msNum = Number(rawMs)
  const hitMs = Number.isInteger(msNum) && msNum > 0
    ? store.items.find((m) => m.number === msNum)
    : store.items.find((m) => m.title.toLowerCase() === String(rawMs ?? '').trim().toLowerCase())
  if (!hitMs) return { ok: false, error: `local milestone not found: ${milestone}` }
  if (!Number.isInteger(issueNum) || issueNum <= 0) return { ok: true, local: true, milestone: hitMs }
  const res = await mutateLocalIssue(mainRoot, gitDir, issueNum, (item) => {
    item.milestone = { number: hitMs.number, title: hitMs.title, state: hitMs.state }
    return { ok: true, local: true, number: issueNum, milestone: item.milestone }
  })
  return res
}
