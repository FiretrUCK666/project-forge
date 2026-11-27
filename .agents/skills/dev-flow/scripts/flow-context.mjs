/**
 * flow-context.mjs —— Issue/PR 上下文拉取、规划文档严格匹配/迁移与运行态远端漂移检测。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 ../../lib/）。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseDocFilename, parseDocFrontmatter, syncDocsLifecycle } from '../../lib/docs.mjs'
import { gitDiffNameStatusZ, gitRun, gitRunBuffer, gitStatusPorcelainZ, posixPath, readTextSafe } from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast, resolveRefShaFast } from '../../lib/git-fast.mjs'
import { listTaskLedgers, readTaskLedger, sanitizeTaskId } from '../../lib/ledger.mjs'
import { NON_API_CLIENT_TIERS } from '../../lib/github-client.mjs'
import { getLocalIssue, listLocalIssues } from '../../lib/local-issues.mjs'
import { syncPlanPhaseToBackend } from '../../lib/plan-sync.mjs'
import { probePlatformEnv, resolveRemoteDescriptor, resolveRemoteTarget } from '../../lib/platform.mjs'

/** 将远端读取失败归一为可追踪的稳定错误码（`no-api-channel` / `not-found` / `forbidden` 等）。 */
export function normalizeContextFetchReason(res, error = null) {
  if (error) {
    const msg = error instanceof Error ? error.message : String(error)
    if (/\b404\b|not found|could not resolve/i.test(msg)) return 'not-found'
    if (/\b40[13]\b|forbidden|unauthorized|permission|bad credentials/i.test(msg)) return 'forbidden'
    if (/no-api-channel|offline|not logged into/i.test(msg)) return 'no-api-channel'
    return msg
  }
  if (!res) return 'no-api-channel'
  if (res.delegated) {
    if (NON_API_CLIENT_TIERS.has(res.tier)) return 'no-api-channel'
    return `needs-manual-fetch:${res.action ?? 'fetch'}`
  }
  const status = Number(res.status)
  const errStr = String(res.error ?? res.reason ?? '').trim()
  if (status === 404 || /\b404\b|not found|could not resolve to (?:an issue|a pullrequest)/i.test(errStr)) {
    return 'not-found'
  }
  if (
    status === 401
    || status === 403
    || /\b40[13]\b|forbidden|unauthorized|bad credentials|requires authentication|http 403/i.test(errStr)
  ) {
    return 'forbidden'
  }
  if (/no-api-channel|offline|not logged into/i.test(errStr)) return 'no-api-channel'
  return errStr || 'fetch-failed'
}

function isUsableApiClient(client) {
  if (!client) return false
  if (client.tier && NON_API_CLIENT_TIERS.has(client.tier)) return false
  return true
}

/** 按当前工作区远端与选项解析可读 API 客户端；离线或无凭据时返回可用客户端或 null。 */
export async function resolveReadClient({ mainRoot, remoteUrls, providerId, targetRepo, opts = {} }) {
  if (opts._ghClient) return opts._ghClient
  if (opts._ghProbe) {
    const probeTier = opts._ghProbe.env?.trackB?.tier
    if (probeTier && NON_API_CLIENT_TIERS.has(probeTier)) return null
    return opts._ghProbe.client ?? null
  }
  const target = resolveRemoteTarget(remoteUrls ?? {}, { providerHint: providerId })
  const effectiveRepo = targetRepo || target.repoSlug
  if (!effectiveRepo || target.capabilities?.api !== true) return null
  try {
    const probe = await probePlatformEnv({
      cwd: mainRoot,
      remoteUrls,
      providerHint: providerId,
      probeNetwork: true,
    })
    return probe?.client ?? null
  } catch {
    return null
  }
}

/** 规范化并截断正文摘要，写入账本供无联网交接阅读；超长截断时完整保留 `- [ ] C*` 验收条款行。 */
export function summarizeContextBody(rawBody, maxLen = 1200) {
  const body = String(rawBody ?? '').replace(/\r\n/g, '\n').trim()
  if (body.length <= maxLen) return body
  let head = body.slice(0, maxLen)
  const cutMidLine = body[maxLen] !== '\n'
  if (cutMidLine) {
    const lastNl = head.lastIndexOf('\n')
    const nextNl = body.indexOf('\n', lastNl + 1)
    const fullLineAtCut = body.slice(lastNl + 1, nextNl >= 0 ? nextNl : body.length)
    if (/^\s*[-*]\s+\[[ xX]\]/i.test(fullLineAtCut) && lastNl > 0) {
      head = head.slice(0, lastNl)
    }
  }
  const headLineSet = new Set(head.split('\n').map((l) => l.trim()))
  const preserved = []
  let inFence = false
  for (const rawLine of body.split('\n')) {
    if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
    if (inFence) continue
    const trimmed = rawLine.trim()
    if (/^[-*]\s+\[[ xX]\]\s+(?:\*\*)?C\d+(?:\*\*)?(?:\s*[:：]|\s|$)/i.test(trimmed) && !headLineSet.has(trimmed)) {
      preserved.push(trimmed)
    }
  }
  return preserved.length > 0 ? `${head}…\n\n${preserved.join('\n')}` : `${head}…`
}

/** 批量拉取或补全关联 Issue 上下文；无远端/通用仓优先读取本地持久化工单，已拉取过不重复请求。 */
export async function fetchIssueContextList({
  mainRoot = null,
  gitDir = null,
  providerId = 'none',
  role = null,
  issueNumbers = [],
  existingContext = [],
  client = null,
  targetRepo = null,
} = {}) {
  const nums = [...new Set((issueNumbers ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))]
  const existingMap = new Map()
  for (const item of Array.isArray(existingContext) ? existingContext : []) {
    if (item && Number.isInteger(Number(item.number))) {
      existingMap.set(Number(item.number), item)
    }
  }
  const canCall = Boolean(targetRepo && isUsableApiClient(client) && typeof client.getIssue === 'function')
  const allowLocalFallback = Boolean(mainRoot && (role === 'local-only' || providerId === 'none' || providerId === 'generic-git' || !targetRepo))
  const out = []
  for (const num of nums) {
    const prev = existingMap.get(num)
    if (prev?.fetched) {
      out.push(prev)
      continue
    }
    if (!canCall) {
      if (allowLocalFallback) {
        const localRes = getLocalIssue({ mainRoot, gitDir, number: num })
        if (localRes.ok) {
          out.push({
            number: num, fetched: true, title: localRes.title ?? null,
            url: localRes.url ?? `local-issue://${num}`, state: localRes.state ?? 'OPEN',
            summary: summarizeContextBody(localRes.body),
          })
          continue
        }
        out.push({ number: num, fetched: false, localOnly: true, reason: 'local-issue-missing-cross-machine', title: null, summary: null })
        continue
      }
      out.push({ number: num, fetched: false, reason: 'no-api-channel', title: null, summary: null })
      continue
    }
    try {
      const res = await client.getIssue(targetRepo, num)
      if (!res?.ok) {
        out.push({ number: num, fetched: false, reason: normalizeContextFetchReason(res), title: null, summary: null })
        continue
      }
      out.push({
        number: num, fetched: true, title: res.title ?? null, url: res.url ?? null,
        state: res.state ?? null, summary: summarizeContextBody(res.body),
      })
    } catch (error) {
      out.push({ number: num, fetched: false, reason: normalizeContextFetchReason(null, error), title: null, summary: null })
    }
  }
  const unavail = out.filter((x) => !x.fetched && !x.localOnly).map((x) => x.number)
  return { issueContext: out, issueContextUnavailable: unavail }
}

/** 一次补齐或刷新单个任务账本所需的 Issue 与 PR 远端上下文（避免初建与幂等重入两处各写一套）。 */
export async function resolveAndHydrateTaskContexts({
  mainRoot,
  gitDir = null,
  remoteUrls,
  providerId,
  role = null,
  targetRepo = null,
  issueNumbers = [],
  existingIssueContext = [],
  prNumber = null,
  existingPrContext = null,
  existingAck = null,
  opts = {},
}) {
  const hasIssues = Array.isArray(issueNumbers) && issueNumbers.length > 0
  const hasPr = Number.isInteger(Number(prNumber)) && Number(prNumber) > 0
  if (!hasIssues && !hasPr) {
    return {
      issueContext: [], issueContextUnavailable: [], issueContextAck: null,
      prContext: null, prContextUnavailable: null, prPatch: {},
    }
  }
  const client = await resolveReadClient({ mainRoot, remoteUrls: remoteUrls ?? {}, providerId, targetRepo, opts })
  const { issueContext, issueContextUnavailable } = hasIssues
    ? await fetchIssueContextList({ mainRoot, gitDir, providerId, role, issueNumbers, existingContext: existingIssueContext, client, targetRepo })
    : { issueContext: [], issueContextUnavailable: [] }
  const { prContext, prContextUnavailable } = hasPr
    ? await fetchPrContextEntry({ prNumber, existingContext: existingPrContext, client, targetRepo })
    : { prContext: null, prContextUnavailable: null }
  const nextAck = issueContextUnavailable.length === 0 ? null : existingAck
  const prPatch = prContext?.fetched
    ? { prUrl: prContext.url ?? null, prState: prContext.state ?? null, prBaseSha: prContext.baseRefOid ?? null, prHeadSha: prContext.headRefOid ?? null }
    : {}
  return { issueContext, issueContextUnavailable, issueContextAck: nextAck, prContext, prContextUnavailable, prPatch }
}

/** 拉取单个 PR 的元信息与基线/头部 commit SHA（`baseRefOid`/`headRefOid`）。 */
export async function fetchPrContextEntry({
  prNumber,
  existingContext = null,
  client = null,
  targetRepo = null,
} = {}) {
  const num = Number(prNumber)
  if (!Number.isInteger(num) || num <= 0) return { prContext: null, prContextUnavailable: null }
  if (existingContext?.fetched && Number(existingContext.number) === num && existingContext.baseRefOid && existingContext.headRefOid) {
    return { prContext: existingContext, prContextUnavailable: null }
  }
  const canCall = Boolean(targetRepo && isUsableApiClient(client) && typeof client.getPr === 'function')
  if (!canCall) {
    const unavail = { number: num, fetched: false, reason: 'no-api-channel' }
    return {
      prContext: { ...unavail, title: null, summary: null, baseBranch: null, headBranch: null, baseRefOid: null, headRefOid: null },
      prContextUnavailable: unavail,
    }
  }
  try {
    const res = await client.getPr(targetRepo, num)
    if (!res?.ok) {
      const unavail = { number: num, fetched: false, reason: normalizeContextFetchReason(res) }
      return {
        prContext: { ...unavail, title: null, summary: null, baseBranch: null, headBranch: null, baseRefOid: null, headRefOid: null },
        prContextUnavailable: unavail,
      }
    }
    return {
      prContext: {
        number: num, fetched: true, title: res.title ?? null, url: res.url ?? null, state: res.state ?? null,
        baseBranch: res.baseBranch ?? null, headBranch: res.headBranch ?? null,
        baseRefOid: res.baseRefOid ?? null, headRefOid: res.headRefOid ?? null, summary: summarizeContextBody(res.body),
      },
      prContextUnavailable: null,
    }
  } catch (error) {
    const unavail = { number: num, fetched: false, reason: normalizeContextFetchReason(null, error) }
    return {
      prContext: { ...unavail, title: null, summary: null, baseBranch: null, headBranch: null, baseRefOid: null, headRefOid: null },
      prContextUnavailable: unavail,
    }
  }
}

function collectIssueMatchSet(taskId, issueNumbers = []) {
  const set = new Set((issueNumbers ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))
  const m = /^issue-(\d+)$/.exec(String(taskId ?? ''))
  if (m) set.add(Number(m[1]))
  return set
}

/** 严格按文件名 slug、frontmatter `task_id` 与 frontmatter `issue` 兜底匹配预建规划文档。 */
export function findMatchingDocStrict(root, dirRel, slug, taskId, issueNumbers = []) {
  const abs = join(root, dirRel)
  if (!existsSync(abs)) return null
  const issueSet = collectIssueMatchSet(taskId, issueNumbers)
  try {
    for (const n of readdirSync(abs).filter((x) => x.endsWith('.md')).sort()) {
      const fn = parseDocFilename(n)
      if (fn && fn.slug === slug) return `${dirRel}/${n}`
      const fm = parseDocFrontmatter(readTextSafe(join(abs, n)) ?? '')
      if (taskId && fm.data?.task_id === taskId) return `${dirRel}/${n}`
      const fmIssue = Number(fm.data?.issue)
      if (Number.isInteger(fmIssue) && fmIssue > 0 && issueSet.has(fmIssue)) return `${dirRel}/${n}`
    }
  } catch { /* ignore */ }
  return null
}

/** 判断仓库是否已存在任何 Markdown 规划文档。 */
export function hasAnyPlanMarkdownFiles(root) {
  for (const dirRel of ['docs/prd', 'docs/specs', 'docs/todo']) {
    const abs = join(root, dirRel)
    if (!existsSync(abs)) continue
    try {
      if (readdirSync(abs).some((n) => n.endsWith('.md'))) return true
    } catch { /* ignore */ }
  }
  return false
}

/** 将主仓中尚未提交的关联规划文档同步迁入新创建的 Tier 2 实施 worktree，防止断链。 */
export async function migrateUncommittedPlanDocs(mainRoot, implAbs, ledger, mainDirty = undefined) {
  if (mainDirty === 0) return []
  if (!ledger.prdFile && !ledger.specFile && !ledger.todoFile && !hasAnyPlanMarkdownFiles(mainRoot)) return []
  const st = await gitStatusPorcelainZ(mainRoot)
  if (!st.ok) return []
  const dirtyMap = new Map(st.entries.map((e) => [e.file, e.xy]))
  const migrated = []
  const issueSet = collectIssueMatchSet(ledger.taskId, ledger.linkedIssues ?? [])

  const candidates = new Set([ledger.prdFile, ledger.specFile, ledger.todoFile].filter(Boolean))
  for (const [rel] of dirtyMap.entries()) {
    if (!/^docs\/(?:prd|specs|todo)\/[^/]+\.md$/.test(rel)) continue
    const fn = parseDocFilename(rel)
    if (fn && fn.slug === ledger.slug) candidates.add(rel)
    else {
      const fm = parseDocFrontmatter(readTextSafe(join(mainRoot, rel)) ?? '')
      const fmIssue = Number(fm.data?.issue)
      if (fm.data?.task_id === ledger.taskId || (Number.isInteger(fmIssue) && issueSet.has(fmIssue))) {
        candidates.add(rel)
      }
    }
  }

  for (const rel of candidates) {
    const srcAbs = join(mainRoot, rel)
    const dstAbs = join(implAbs, rel)
    if (!existsSync(srcAbs)) continue
    const xy = dirtyMap.get(rel)
    if (!xy && existsSync(dstAbs)) continue
    mkdirSync(dirname(dstAbs), { recursive: true })
    copyFileSync(srcAbs, dstAbs)
    migrated.push(rel)
    if (xy === '??') {
      try { unlinkSync(srcAbs) } catch { /* ignore */ }
    }
  }
  return migrated
}

/** 检测由无远端切回远端后的运行态配置漂移与未迁移本地工单，输出非阻塞提醒。 */
export function detectRemoteDriftWarnings({ mainRoot, gitDir = null, role = 'local-only', providerId = 'none' } = {}) {
  if (!mainRoot || role === 'local-only') return []
  const warnings = []
  const agentsText = readTextSafe(join(mainRoot, 'AGENTS.md')) ?? ''
  if (agentsText && /这个项目还没有远端|任务留痕与合并前文档同步|提交至本地分支|提交至本地特性分支/.test(agentsText)) {
    warnings.push({
      code: 'WARN_REMOTE_DRIFT_AGENTS',
      message: '远端漂移提醒：仓库已脱离纯本地模式，但 AGENTS.md 仍处于无远端模板状态；请重新运行 S1–S4（survey / compose-agents）刷新工程契约。',
    })
  }
  if (providerId === 'github' && !existsSync(join(mainRoot, '.github'))) {
    warnings.push({
      code: 'WARN_REMOTE_DRIFT_GITHUB_DIR',
      message: '远端漂移提醒：当前 GitHub 仓库缺少 .github/ 协作模板或 CI 配置；建议重跑 S1–S4（equip-ci）补齐。',
    })
  }
  const openLocal = listLocalIssues({ mainRoot, gitDir, state: 'open' })
  if (openLocal.ok && openLocal.issues.length > 0) {
    const nums = openLocal.issues.map((i) => `#${i.number}`).join(', ')
    warnings.push({
      code: 'WARN_UNMIGRATED_LOCAL_ISSUES',
      count: openLocal.issues.length,
      issues: openLocal.issues.map((i) => i.number),
      message: `远端漂移提醒：存在 ${openLocal.issues.length} 个未闭环本地工单（${nums}）；可运行 \`node ".agents/skills/dev-flow/scripts/flow.mjs" issue migrate\` 一键迁回远端。`,
    })
  }
  return warnings
}

/** 使用 `-z` 安全收集相对于 baseRef 的全部变更文件（含无 baseSha 首提交 `ls-tree HEAD` 与未提交变动，支持复用已知 statusEntries 与 diffEntries）。 */
export async function getChangedFiles(cwd, baseRef, opts = {}) {
  const fastAtBase = !Array.isArray(opts.diffEntries) && baseRef
    && readHeadFast(resolveGitDirFast(cwd))?.oid === baseRef
  const [diff, tree, st] = await Promise.all([
    Array.isArray(opts.diffEntries)
      ? Promise.resolve({ ok: true, entries: opts.diffEntries })
      : (fastAtBase
          ? Promise.resolve({ ok: true, entries: [] })
          : (baseRef ? gitDiffNameStatusZ(cwd, [`${baseRef}..HEAD`]) : Promise.resolve(null))),
    baseRef ? Promise.resolve(null) : gitRunBuffer(cwd, ['ls-tree', '-r', '--name-only', '-z', 'HEAD']),
    Array.isArray(opts.statusEntries) ? Promise.resolve({ ok: true, entries: opts.statusEntries }) : gitStatusPorcelainZ(cwd),
  ])
  const set = new Set()
  if (diff?.ok) for (const e of diff.entries) if (e.file) set.add(e.file)
  if (tree?.ok) for (const f of tree.stdout.toString('utf8').split('\0')) if (f) set.add(posixPath(f))
  if (st.ok) for (const e of st.entries) if (e.file) set.add(e.file)
  return [...set].sort()
}

export function resolvePreferredRemoteName(remotesTopology = [], preferredProviderId = 'github') {
  return remotesTopology?.find((r) => r.providerId === preferredProviderId)?.name
    ?? remotesTopology?.[0]?.name
    ?? 'origin'
}

export function buildTargetRepoContext(role, remoteUrls = {}, declaredRepo, topology = null, extra = {}) {
  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const upstreamRaw = remoteUrls.upstream
  const target = resolveRemoteTarget(remoteUrls, { role, declaredRepo, ...extra })
  const originDesc = originRaw ? resolveRemoteDescriptor(originRaw) : null
  const upstreamDesc = upstreamRaw ? resolveRemoteDescriptor(upstreamRaw) : null
  const originFull = originDesc?.repoSlug ?? null
  const upstreamFull = upstreamDesc?.repoSlug ?? null
  const originLower = originFull ? originFull.toLowerCase() : null
  const upstreamLower = upstreamFull ? upstreamFull.toLowerCase() : null
  const targetRepo = target.repoSlug ?? (role === 'contributor-fork' ? (upstreamFull ?? declaredRepo ?? originFull) : originFull)
  const pushRemote = topology?.origin?.name ?? target.pushRemote ?? (remoteUrls.origin ? 'origin' : Object.keys(remoteUrls)[0] ?? 'origin')
  return {
    originFull, originLower, upstreamFull, upstreamLower, targetRepo, pushRemote,
    providerId: target.providerId,
    apiBaseUrl: target.apiBaseUrl,
    mrRefPattern: target.mrRefPattern,
    capabilities: target.capabilities,
    isLan: Boolean(target.isLan),
    isLocal: Boolean(target.isLocal),
  }
}

function collectPreBindDocIssues(workRoot, docPaths) {
  const existingIssues = new Set()
  let hasAnyDoc = false
  for (const rel of docPaths) {
    if (!rel) continue
    const abs = join(workRoot, rel)
    if (!existsSync(abs)) continue
    hasAnyDoc = true
    const fnIss = Number(parseDocFilename(rel)?.issue)
    if (Number.isInteger(fnIss) && fnIss > 0) existingIssues.add(fnIss)
    const raw = readTextSafe(abs)
    const fmIss = Number(raw ? parseDocFrontmatter(raw)?.data?.issue : NaN)
    if (Number.isInteger(fmIss) && fmIss > 0) existingIssues.add(fmIss)
  }
  return { hasAnyDoc, existingIssues }
}

export async function resolveStartBaseAndStack(roots, state, opts, { effectiveExternalPr = null } = {}) {
  let baseBranch = state.defaultBranch ?? (state.commits === 0 && state.branch && state.branch !== '(detached)' ? state.branch : null)
  let baseSha = state.head
  const explicitBase = String(opts.base ?? '').trim()
  if (explicitBase) {
    let ok = false
    for (const cand of [`refs/heads/${explicitBase}`, `refs/remotes/origin/${explicitBase}`, explicitBase]) {
      const sha = resolveRefShaFast(roots.gitDir, cand)
      if (sha) { baseBranch = explicitBase; baseSha = sha; ok = true; break }
      const r = await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', cand])
      if (r.ok && r.stdout.trim()) { baseBranch = explicitBase; baseSha = r.stdout.trim(); ok = true; break }
    }
    if (!ok) throw new Error(`--base 指定的分支不存在：${explicitBase}`)
  } else if (!baseBranch && state.commits > 0 && !opts.after && !effectiveExternalPr) {
    return { blocked: true, code: 'BLOCKED_MISSING_DEFAULT_BRANCH', reason: '找不到可用默认分支，请先检出默认分支或显式传入 --base。' }
  } else if (state.commits > 0 && !(state.branch === baseBranch && state.head)) {
    for (const candRef of [`refs/heads/${baseBranch}`, `refs/remotes/origin/${baseBranch}`]) {
      const fastSha = resolveRefShaFast(roots.gitDir, candRef)
      if (fastSha) { baseSha = fastSha; break }
      const r = await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', candRef])
      if (r.ok && r.stdout.trim()) { baseSha = r.stdout.trim(); break }
    }
  }
  let stackFields = {}
  if (opts.after) {
    const rawAfter = String(opts.after).trim()
    let parentLedger = null
    try { parentLedger = readTaskLedger(roots.mainRoot, sanitizeTaskId(rawAfter)) } catch { /* branch name fallback */ }
    if (!parentLedger) parentLedger = listTaskLedgers(roots.mainRoot, { includeTerminal: false }).find((t) => t.branch === rawAfter) ?? null
    const parentBranch = parentLedger?.branch ?? rawAfter
    let parentSha = resolveRefShaFast(roots.gitDir, `refs/heads/${parentBranch}`)
    if (!parentSha) {
      for (const cand of [`refs/heads/${parentBranch}`, parentBranch]) {
        const r = await gitRun(roots.mainRoot, ['rev-parse', '--verify', '--quiet', cand])
        if (r.ok && r.stdout.trim()) { parentSha = r.stdout.trim(); break }
      }
    }
    if (!parentSha && parentLedger?.worktreePath && existsSync(join(roots.mainRoot, parentLedger.worktreePath))) {
      const r = await gitRun(join(roots.mainRoot, parentLedger.worktreePath), ['rev-parse', 'HEAD'])
      if (r.ok && r.stdout.trim()) parentSha = r.stdout.trim()
    }
    if (!parentSha) throw new Error(`找不到 --after 指定的父任务或父分支：${rawAfter}`)
    baseBranch = parentBranch
    baseSha = parentSha
    stackFields = {
      parentTaskId: parentLedger?.taskId ?? null,
      parentBranch,
      parentPrNumber: parentLedger?.prNumber ?? null,
      stackTargetBase: parentLedger?.stackTargetBase ?? (state.defaultBranch ?? null),
    }
  }
  return { blocked: false, baseBranch, baseSha, stackFields }
}

export async function syncTaskDocsSafe(workRoot, ledger, overrides = {}) {
  const seed = ledger.specFile ?? ledger.todoFile ?? ledger.prdFile ?? ledger.slug
  if (!seed) return null
  try {
    const preDocs = [ledger.prdFile, ledger.specFile, ledger.todoFile].filter(Boolean)
    const { hasAnyDoc, existingIssues } = collectPreBindDocIssues(workRoot, preDocs)
    const newlySet = new Set((overrides.newlyBoundIssues ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0))
    const postHocIssues = hasAnyDoc
      ? (ledger.linkedIssues ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && (!existingIssues.has(n) || newlySet.has(n)))
      : []

    const res = await syncDocsLifecycle(workRoot, {
      slugOrPath: seed,
      issue: ledger.linkedIssues?.[0],
      pr: ledger.prNumber ?? undefined,
      branch: ledger.branch,
      ...overrides,
    })
    if (res.byKind?.prd) ledger.prdFile = res.byKind.prd
    if (res.byKind?.spec) ledger.specFile = res.byKind.spec
    if (res.byKind?.todo) ledger.todoFile = res.byKind.todo

    const renamedPaths = (res.renamed ?? res.moved ?? [])
      .filter((m) => m?.from && m?.to && m.from !== m.to)
      .map((m) => ({ from: posixPath(m.from), to: posixPath(m.to) }))
    const postFiles = [ledger.prdFile, ledger.specFile, ledger.todoFile].filter(Boolean)
    const targetSyncIssues = renamedPaths.length > 0
      ? [...new Set([...postHocIssues, ...(ledger.linkedIssues ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0)])]
      : postHocIssues
    if (targetSyncIssues.length > 0 && postFiles.length > 0 && !overrides.skipPlanBackfill) {
      const syncRes = await syncPlanPhaseToBackend({
        repoRoot: workRoot,
        mainRoot: overrides.mainRoot ?? workRoot,
        gitDir: overrides.gitDir ?? null,
        phase: 'plan-backfill',
        file: ledger.specFile ?? ledger.todoFile ?? ledger.prdFile,
        files: postFiles,
        renamedPaths,
        taskId: ledger.taskId ?? null,
        issueNumbers: targetSyncIssues,
        role: ledger.role,
        providerId: ledger.providerId,
        reason: `后绑定 Issue ${targetSyncIssues.map((n) => `#${n}`).join(', ')}，回补既有规划状态摘要`,
        ...(overrides._ghClient ? { _ghClient: overrides._ghClient } : {}),
        ...(overrides._ghProbe ? { _ghProbe: overrides._ghProbe } : {}),
      }).catch(() => null)
      if (syncRes?.syncKey && (syncRes.synced || syncRes.notApplicable)) {
        ledger.planSyncKeys = [...new Set([...(ledger.planSyncKeys ?? []), syncRes.syncKey])]
      }
      if (Array.isArray(syncRes?.syncFailures) && syncRes.syncFailures.length > 0) {
        ledger.syncFailures = [...(ledger.syncFailures ?? []), ...syncRes.syncFailures]
      }
      res.planSync = syncRes
    }
    return res
  } catch {
    return null
  }
}
