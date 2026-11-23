/**
 * task-graph.mjs —— 外部协作图谱统一解析（单 Issue / 单外部 PR / Issue+PR 互链 / 阻塞依赖与堆叠父分支校验）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），绝不使用任何环境变量夹具后门，所有外部查询经函数参数注入。
 */

import { EXIT } from './exit-codes.mjs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { gitRun, inspectBranchMergeState, resolveDefaultBranch } from './git.mjs'
import { readTaskLedger } from './ledger.mjs'
import { parseBodyRelations, parseFlowInputs, parseIssueNumbers, parsePrNumber } from './platform.mjs'

const EMPTY_RELATIONS = Object.freeze({ dependsOn: [], blocks: [], partOf: [], fixes: [], refs: [] })

function toIssueStateMap(rawStates) {
  const map = new Map()
  if (!rawStates) return map
  const entries = rawStates instanceof Map ? rawStates.entries() : Object.entries(rawStates)
  for (const [k, v] of entries) {
    const num = Number(String(k).replace(/^#/, ''))
    if (!Number.isInteger(num) || num <= 0) continue
    if (typeof v === 'string') map.set(num, { number: num, state: v.toUpperCase() })
    else if (v && typeof v === 'object') {
      map.set(num, { ...v, number: num, state: String(v.state ?? 'OPEN').toUpperCase() })
    }
  }
  return map
}

function addUniqueNum(list, num) {
  const n = Number(num)
  if (Number.isInteger(n) && n > 0 && !list.includes(n)) list.push(n)
}

/**
 * 统一解析外部协作输入图谱：
 *   1. 单 Issue（解析 Depends on / Blocks 并核验未传入外部阻塞依赖）；
 *   2. 单外部/Fork PR（标注 untrustedScanRequired，阻断未扫/未批挂载与执行）；
 *   3. Issue + PR 互链合一（锁定 reuseExistingPr 并拦截重复开第二条 PR）。
 */
export async function resolveExternalCollaborationGraph({
  inputs = [],
  issueInput = null,
  prInput = null,
  externalPrInput = null,
  defaultRepo = null,
  originRepo = null,
  client = null,
  backend = null,
  fetchedIssues: preFetchedIssues = null,
  fetchedPrs: preFetchedPrs = null,
  knownIssueStates = null,
  knownPrs = null,
  ledger = null,
} = {}) {
  const parsed = parseFlowInputs(Array.isArray(inputs) ? inputs : [], defaultRepo)
  const addIssueItem = (repo, num, raw) => {
    const effRepo = repo ?? defaultRepo
    if (!Number.isInteger(num) || num <= 0) return
    if (!parsed.issues.some((x) => x.number === num && (x.repo ?? defaultRepo) === effRepo)) {
      parsed.issues.push({ repo: effRepo, number: num, raw: raw ?? `#${num}` })
    }
  }
  const addPrItem = (repo, num, raw) => {
    const effRepo = repo ?? defaultRepo
    if (!Number.isInteger(num) || num <= 0) return
    if (!parsed.prs.some((x) => x.number === num && (x.repo ?? defaultRepo) === effRepo)) {
      parsed.prs.push({ repo: effRepo, number: num, raw: raw ?? `pr#${num}` })
    }
  }

  if (issueInput !== null && issueInput !== undefined && String(issueInput).trim() !== '') {
    for (const it of parseFlowInputs(String(issueInput).split(/[\s,]+/), defaultRepo).issues) {
      addIssueItem(it.repo, it.number, it.raw)
    }
    for (const num of parseIssueNumbers(issueInput)) addIssueItem(defaultRepo, num, `#${num}`)
  }
  const prRawFlag = prInput ?? externalPrInput
  if (prRawFlag !== null && prRawFlag !== undefined && String(prRawFlag).trim() !== '') {
    const rawPr = parseFlowInputs([String(prRawFlag)], defaultRepo)
    if (rawPr.prs.length > 0) rawPr.prs.forEach((it) => addPrItem(it.repo, it.number, it.raw))
    else {
      const num = parsePrNumber(prRawFlag)
      if (num) addPrItem(defaultRepo, num, `pr#${num}`)
    }
  }

  const stateMap = toIssueStateMap(knownIssueStates)
  const apiClient = client ?? backend?.client ?? null
  const canQueryIssue = Boolean(apiClient && typeof apiClient.getIssue === 'function'
    && (!apiClient.tier || apiClient.tier === 'gh-cli' || apiClient.tier === 'node-https-token'))
  const canQueryPr = Boolean(
    (backend && typeof backend.getPr === 'function' && (!backend.kind || backend.kind === 'github')
      && (!apiClient?.tier || apiClient.tier === 'gh-cli' || apiClient.tier === 'node-https-token'))
    || (apiClient && typeof apiClient.getPr === 'function'
      && (!apiClient.tier || apiClient.tier === 'gh-cli' || apiClient.tier === 'node-https-token')),
  )

  const resolvedIssues = Array.isArray(preFetchedIssues)
    ? preFetchedIssues.map((it) => ({
        ...it,
        relations: it.relations ?? parseBodyRelations(it.body ?? ''),
      }))
    : await Promise.all(parsed.issues.map(async (it) => {
        if (stateMap.has(it.number) && stateMap.get(it.number).body !== undefined) {
          const k = stateMap.get(it.number)
          return { ...it, ...k, fetched: true, relations: k.relations ?? parseBodyRelations(k.body ?? '') }
        }
        const targetRepo = it.repo ?? defaultRepo
        if (targetRepo && canQueryIssue) {
          const res = await apiClient.getIssue(targetRepo, it.number)
          if (res?.ok) {
            return { ...it, ...res, fetched: true, relations: res.relations ?? parseBodyRelations(res.body ?? '') }
          }
        }
        return { ...it, fetched: false, relations: { ...EMPTY_RELATIONS } }
      }))

  const prMap = new Map()
  if (Array.isArray(knownPrs)) {
    for (const kp of knownPrs) {
      if (Number.isInteger(kp?.number)) prMap.set(kp.number, kp)
    }
  }

  const resolvedPrs = Array.isArray(preFetchedPrs)
    ? preFetchedPrs.map((pr) => ({
        ...pr,
        relations: pr.relations ?? parseBodyRelations(pr.body ?? ''),
      }))
    : await Promise.all(parsed.prs.map(async (pr) => {
        if (prMap.has(pr.number)) {
          const kp = prMap.get(pr.number)
          return { ...pr, ...kp, fetched: true, relations: kp.relations ?? parseBodyRelations(kp.body ?? '') }
        }
        const targetRepo = pr.repo ?? defaultRepo
        if (targetRepo && canQueryPr) {
          const res = backend?.getPr ? await backend.getPr(targetRepo, pr.number) : await apiClient.getPr(targetRepo, pr.number)
          if (res?.ok) {
            return { ...pr, ...res, fetched: true, relations: res.relations ?? parseBodyRelations(res.body ?? '') }
          }
        }
        return { ...pr, fetched: false, relations: { ...EMPTY_RELATIONS } }
      }))

  // 合并 PR 正文里 Fixes/Refs 引用的 Issue 编号
  const linkedIssueNumbers = []
  for (const iss of resolvedIssues) addUniqueNum(linkedIssueNumbers, iss.number)
  for (const pr of resolvedPrs) {
    const rel = pr.relations ?? parseBodyRelations(pr.body ?? '')
    for (const n of [...(rel.fixes ?? []), ...(rel.refs ?? [])]) addUniqueNum(linkedIssueNumbers, n)
  }

  let externalPr = externalPrInput !== null && externalPrInput !== undefined ? parsePrNumber(externalPrInput) : null
  if (!externalPr && resolvedPrs.length === 1 && resolvedPrs[0].fetched) {
    const p = resolvedPrs[0]
    const normOrigin = originRepo ? String(originRepo).toLowerCase() : null
    if (p.headRepo && normOrigin && String(p.headRepo).toLowerCase() !== normOrigin) {
      externalPr = p.number
    }
  }

  // 若只传入 Issue 且已知 PR（或 findOpenPrForBranch/knownPrs）与该 Issue 互链，合并上下文防重复建单
  let reuseExistingPr = null
  if (!externalPr && resolvedPrs.length > 0) {
    const pr = resolvedPrs[0]
    const hasCrossLink = resolvedIssues.length > 0
      || (pr.relations?.fixes ?? []).length > 0
      || (pr.relations?.refs ?? []).length > 0
      || pr.fetched
    if (hasCrossLink) {
      reuseExistingPr = {
        prNumber: pr.number,
        branch: pr.headBranch ?? null,
        baseBranch: pr.baseBranch ?? null,
        url: pr.url ?? pr.raw ?? null,
        linkedIssues: [...linkedIssueNumbers],
        note: '检测到已有 PR（与 Issue 关联），请直接复用该 PR 与原分支，禁止新开第二个 PR',
      }
    }
  } else if (!externalPr && resolvedPrs.length === 0 && prMap.size > 0 && linkedIssueNumbers.length > 0) {
    for (const kp of prMap.values()) {
      const rel = kp.relations ?? parseBodyRelations(kp.body ?? '')
      const hitsIssue = [...(rel.fixes ?? []), ...(rel.refs ?? [])].some((n) => linkedIssueNumbers.includes(n))
      if (hitsIssue && String(kp.state ?? 'OPEN').toUpperCase() === 'OPEN') {
        reuseExistingPr = {
          prNumber: kp.number,
          branch: kp.headBranch ?? null,
          baseBranch: kp.baseBranch ?? null,
          url: kp.url ?? null,
          linkedIssues: [...linkedIssueNumbers],
          note: '检测到与 Issue 关联的已有 OPEN PR，直接合并上下文并禁止新开第二个 PR',
        }
        break
      }
    }
  }

  // 解析未传入输入集的外部阻塞依赖（Depends on #K）
  const inputIssueSet = new Set(resolvedIssues.map((i) => i.number))
  const depNums = []
  for (const iss of resolvedIssues) {
    for (const dep of iss.relations?.dependsOn ?? []) {
      if (!inputIssueSet.has(dep) && !depNums.includes(dep)) depNums.push(dep)
    }
  }

  const unresolvedBlockers = []
  const unverifiedDependencies = []
  for (const depNum of depNums) {
    const known = stateMap.get(depNum)
    if (known) {
      if (known.state !== 'CLOSED') unresolvedBlockers.push({ number: depNum, state: known.state, title: known.title ?? null })
      continue
    }
    const targetRepo = resolvedIssues[0]?.repo ?? defaultRepo
    if (targetRepo && canQueryIssue) {
      const res = await apiClient.getIssue(targetRepo, depNum)
      if (res?.ok) {
        const st = String(res.state ?? 'OPEN').toUpperCase()
        if (st !== 'CLOSED') unresolvedBlockers.push({ number: depNum, state: st, title: res.title ?? null })
        continue
      }
    }
    unverifiedDependencies.push({ number: depNum, reason: 'offline-or-unverified' })
  }

  const isExternalPr = Boolean(externalPr)
  const kind = isExternalPr
    ? 'inbound-external-pr'
    : (reuseExistingPr ? 'linked-issue-pr' : (resolvedIssues.length > 1 ? 'multi-issue' : (resolvedIssues.length === 1 ? 'single-issue' : 'local')))

  return {
    kind,
    issues: resolvedIssues,
    prs: resolvedPrs,
    milestones: parsed.milestones,
    unknown: parsed.unknown,
    linkedIssues: linkedIssueNumbers,
    externalPr,
    reviewWorktreePath: externalPr ? `.worktrees/review-pr-${externalPr}` : null,
    untrustedScanRequired: isExternalPr,
    untrustedScanPassed: Boolean(ledger?.untrustedScanPassed),
    untrustedApproved: Boolean(ledger?.untrustedApproved || ledger?.humanApprovedExec),
    reuseExistingPr,
    duplicatePrBlocked: Boolean(reuseExistingPr),
    externalDependencies: depNums,
    unresolvedBlockers,
    unverifiedDependencies,
  }
}

/** 校验是否存在尚未 CLOSED 的外部前置依赖（Depends on #K）。 */
export function checkUnresolvedDependencies(graph, { force = false, strictDeps = false } = {}) {
  if (force || !graph) return { blocked: false }
  if (Array.isArray(graph.unresolvedBlockers) && graph.unresolvedBlockers.length > 0) {
    const summary = graph.unresolvedBlockers.map((b) => `#${b.number}(${b.state})`).join(', ')
    return {
      blocked: true,
      code: 'BLOCKED_UNRESOLVED_DEPENDENCY',
      exitCode: EXIT.FACT,
      blockers: graph.unresolvedBlockers,
      message: `BLOCKED_UNRESOLVED_DEPENDENCY: 存在未关闭的前置依赖 Issue（${summary}），请先解决依赖或确认后带 --force 继续。`,
    }
  }
  if (strictDeps && Array.isArray(graph.unverifiedDependencies) && graph.unverifiedDependencies.length > 0) {
    const summary = graph.unverifiedDependencies.map((d) => `#${d.number}`).join(', ')
    return {
      blocked: true,
      code: 'BLOCKED_UNRESOLVED_DEPENDENCY',
      exitCode: EXIT.FACT,
      unverified: graph.unverifiedDependencies,
      message: `BLOCKED_UNRESOLVED_DEPENDENCY: 严格依赖模式下无法离线核验前置 Issue 状态（${summary}）。`,
    }
  }
  return { blocked: false }
}

/** 外部/Fork PR 未装配 dev-review 或未过 `--untrusted-scan` 且经人类授权前，硬拦截挂载依赖与执行校验。 */
export function checkUntrustedPrGate(ledger, { humanApproved = false, hasDevReview = true } = {}) {
  if (!ledger || ledger.role !== 'inbound-external-pr') return { blocked: false }
  const pr = ledger.prNumber ?? '?'
  if (hasDevReview === false) {
    return {
      blocked: true,
      code: 'BLOCKED_REQUIRES_DEV_REVIEW',
      exitCode: EXIT.FACT,
      message: `BLOCKED_REQUIRES_DEV_REVIEW: 外部 PR #${pr} 的供应链不可信扫描需要 dev-review 技能，当前项目未装配该技能；请通过 project-forge 的 equip 补齐技能后重试。`,
    }
  }
  const scanOk = ledger.untrustedScanPassed === true
  const approved = Boolean(humanApproved || ledger.untrustedApproved === true || ledger.humanApprovedExec === true)
  if (!scanOk || !approved) {
    const stage = !scanOk ? '尚未通过 --untrusted-scan 供应链静态扫描' : '尚未获得人类安全授权（--human-approved-exec / untrustedApproved）'
    return {
      blocked: true,
      code: 'BLOCKED_UNTRUSTED_PR_UNSCANNED',
      exitCode: EXIT.FACT,
      message: `BLOCKED_UNTRUSTED_PR_UNSCANNED: 外部 PR #${pr} ${stage}，严禁挂载依赖或执行构建测试命令。`,
    }
  }
  return { blocked: false }
}

/** 拦截为已互链 PR 的 Issue 重复创建第二条 PR。 */
export function assertNoDuplicatePrForTask({ ledger, graph, branchOpenPrs = [] } = {}) {
  const existingPr = ledger?.prNumber ?? graph?.reuseExistingPr?.prNumber ?? branchOpenPrs?.[0]?.number ?? null
  if (existingPr && !ledger?.reworkMode) {
    return {
      blocked: true,
      code: 'BLOCKED_DUPLICATE_PR_FOR_LINKED_ISSUE',
      exitCode: EXIT.FACT,
      prNumber: Number(existingPr),
      message: `BLOCKED_DUPLICATE_PR_FOR_LINKED_ISSUE: 任务已存在关联 PR #${existingPr}，必须直接复用原分支与 PR，严禁重复创建第二条 PR。`,
    }
  }
  return { blocked: false }
}

/** 堆叠 PR 父分支/父 PR 未合并前，硬阻断子任务提前合入。 */
export async function checkStackedParentMerged(mainRoot, ledger, { backend = null, targetRepo = null, defaultBranch = null } = {}) {
  if (!ledger?.parentTaskId && !ledger?.parentBranch) return { blocked: false }
  const parentLedger = ledger.parentTaskId ? readTaskLedger(mainRoot, ledger.parentTaskId) : null
  if (parentLedger && (['merged', 'cleaned'].includes(parentLedger.status) || parentLedger.prState === 'MERGED')) {
    return { blocked: false, mergedVia: 'parent-ledger' }
  }
  const parentPrNum = ledger.parentPrNumber ?? parentLedger?.prNumber ?? null
  if (parentPrNum && backend && typeof backend.getPr === 'function' && targetRepo) {
    const pr = await backend.getPr(targetRepo, parentPrNum)
    if (pr?.ok && (pr.merged === true || String(pr.state ?? '').toUpperCase() === 'MERGED')) {
      return { blocked: false, mergedVia: 'parent-pr' }
    }
  }

  const parentBranch = ledger.parentBranch ?? parentLedger?.branch ?? null
  const stackTarget = ledger.stackTargetBase ?? parentLedger?.baseBranch ?? defaultBranch ?? await resolveDefaultBranch(mainRoot, { strict: true })
  if (parentBranch && stackTarget && existsSync(join(mainRoot, '.git'))) {
    const st = await inspectBranchMergeState(mainRoot, {
      branch: parentBranch,
      headSha: parentLedger?.finalizedHead ?? parentLedger?.verifiedHead ?? null,
      defaultBranch: stackTarget,
    })
    if (st.state === 'merged' || st.state === 'squash_or_rebase_merged') {
      return { blocked: false, mergedVia: `git-${st.state}` }
    }
  }

  return {
    blocked: true,
    code: 'BLOCKED_STACK_PARENT_UNMERGED',
    exitCode: EXIT.FACT,
    parentTaskId: ledger.parentTaskId ?? null,
    parentBranch,
    parentPrNumber: parentPrNum,
    message: `BLOCKED_STACK_PARENT_UNMERGED: 堆叠父任务/父分支（${ledger.parentTaskId ?? parentBranch}${parentPrNum ? ` / PR #${parentPrNum}` : ''}）尚未合并，禁止提前合入子分支；父分支合并后请先执行 flow.mjs sync --task ${ledger.taskId}。`,
  }
}
