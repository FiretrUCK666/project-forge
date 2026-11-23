/**
 * workflow-helpers.mjs —— PR 模板回填、多 Issue 拓扑、交棒下一步构造与多任务波次排期。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 workflow-policy.mjs 重导出。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

import { buildMultiTaskWavePlan, scanUnstartedReadySlices } from './doc-slice-graph.mjs'
import { gitRun, resolveDefaultBranch } from './git.mjs'
import { resolveRefShaFast } from './git-fast.mjs'
import { parseBodyRelations } from './platform.mjs'
import { buildVerificationEvidenceSection, hydratePrTemplateBody, resolveReadablePrTitle, resolveReadablePrTitleWithSource } from './pr-template-hydrate.mjs'

export { buildMultiTaskWavePlan, buildVerificationEvidenceSection, hydratePrTemplateBody, resolveReadablePrTitle, resolveReadablePrTitleWithSource, scanUnstartedReadySlices }

const DIAGNOSTIC_SECRET_PATTERNS = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bnpm_[A-Za-z0-9]{16,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g,
  /(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi,
  /(https?:\/\/)([^:@/\s]+):([^@/\s]+)@/gi,
]

/** 对运行失败输出进行脱敏（掩盖令牌凭据与本机绝对主目录路径），用于诊断与建单。 */
export function redactDiagnosticText(raw, maxLen = 600) {
  let text = String(raw ?? '')
  for (const pat of DIAGNOSTIC_SECRET_PATTERNS) {
    text = text.replace(pat, (...args) => {
      if (args.length >= 4 && /^https?:\/\//i.test(args[1])) return `${args[1]}<REDACTED>:<REDACTED>@`
      if (args.length >= 2 && /^authorization/i.test(args[1])) return `${args[1]}<REDACTED>`
      return '<REDACTED>'
    })
  }
  try {
    const home = homedir()
    if (home && home.length > 2) {
      const homePosix = posixPath(home)
      const homeEsc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const homePosixEsc = homePosix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      text = text.replace(new RegExp(homeEsc, 'gi'), '<HOME>').replace(new RegExp(homePosixEsc, 'gi'), '<HOME>')
    }
  } catch { /* ignore */ }
  text = text.replace(/[A-Za-z]:\\Users\\[^\\/\s]+/g, '<HOME>')
    .replace(/\/(?:Users|home)\/[A-Za-z0-9._-]+/g, '<HOME>')
    .trim()
  if (maxLen > 0 && text.length > maxLen) return `${text.slice(0, maxLen)}...`
  return text
}

/** A6 三态执行计分：区分 `executed`（确实执行）、`succeeded`（零退出）与 `errorOnly`（错路/空跑伪绿）。 */
export function scoreExecutionResult({ executed = false, exitCode = 1, errorOnly = false } = {}) {
  const didExec = Boolean(executed)
  const isErrorOnly = Boolean(errorOnly)
  const code = Number.isFinite(Number(exitCode)) ? Number(exitCode) : 1
  const succeeded = didExec && !isErrorOnly && code === 0
  return { executed: didExec, succeeded, errorOnly: isErrorOnly, ok: succeeded }
}

/** 构造结构化 E2E 运行与观察回执（`evidence.e2eObservation` / `receipt.e2eObservation`）。 */
export function buildE2eObservation({
  summary = '',
  headSha = null,
  source = 'verify',
  cmd = null,
  executed = true,
  succeeded = true,
  errorOnly = false,
} = {}) {
  const clean = String(summary ?? '').trim()
  if (!clean) return null
  const scored = scoreExecutionResult({ executed, exitCode: succeeded ? 0 : 1, errorOnly })
  return {
    summary: clean,
    headSha: headSha ?? null,
    source,
    cmd: cmd ?? null,
    executed: scored.executed,
    succeeded: scored.succeeded,
    errorOnly: scored.errorOnly,
    observedAt: new Date().toISOString(),
  }
}

/** 校验当前 `headSha` 是否具备有效的结构化 E2E 观察回执（拒绝 errorOnly / 未执行 / 跨 SHA 复用）。 */
export function hasValidE2eObservationOnHead(holder, headSha = null) {
  if (!holder || typeof holder !== 'object') return false
  const obs = holder.e2eObservation && typeof holder.e2eObservation === 'object' ? holder.e2eObservation : null
  if (!obs || !String(obs.summary ?? '').trim()) return false
  if (obs.executed === false || obs.succeeded === false || obs.errorOnly === true) return false
  if (headSha && headSha !== 'UNBORN' && obs.headSha && obs.headSha !== headSha) return false
  if (headSha && headSha !== 'UNBORN' && holder.headSha && holder.headSha !== headSha) return false
  return true
}

/** 构造脱敏后的 E2E 运行失败诊断包（`Evidence` / `Unknowns` / `NextSteps`）。 */
export function buildE2eDiagnosticPacket({
  cmd = '',
  exitCode = 1,
  stdout = '',
  stderr = '',
  headSha = null,
  taskId = null,
  mode = 'smoke',
  changedFiles = [],
  unknowns = [],
  nextSteps = [],
} = {}) {
  const outExcerpt = redactDiagnosticText(stdout, 360)
  const errExcerpt = redactDiagnosticText(stderr, 360)
  const cleanCmd = redactDiagnosticText(cmd, 200)
  const Evidence = [
    `task=${taskId ?? 'local'} | mode=${mode} | head=${String(headSha ?? 'unknown').slice(0, 8)} | exit=${exitCode}`,
    `cmd: ${cleanCmd || '(none)'}`,
    ...(errExcerpt ? [`stderr: ${errExcerpt}`] : []),
    ...(outExcerpt ? [`stdout: ${outExcerpt}`] : []),
    ...(changedFiles.length > 0 ? [`changed(${changedFiles.length}): ${changedFiles.slice(0, 6).join(', ')}`] : []),
  ]
  const Unknowns = unknowns.length > 0
    ? unknowns.map((u) => redactDiagnosticText(u, 220))
    : ['需定位究竟是运行时实现缺陷、测试夹具假设漂移还是环境前置缺失导致非零退出']
  const NextSteps = nextSteps.length > 0
    ? nextSteps.map((s) => redactDiagnosticText(s, 220))
    : [
        `在隔离工作树本地复现并修复根因：${cleanCmd || 'run smoke-verify'}`,
        `修复提交后重跑实证并附带真实观察记录：node ".agents/skills/dev-flow/scripts/flow.mjs" verify${taskId ? ` --task ${taskId}` : ''} --mode ${mode} --e2e-evidence "<修复后观察结论>"`,
      ]
  return { Evidence, Unknowns, NextSteps }
}

/** A6 合并前强校：`headSha === evidence.headSha === review.headSha` 且工作区无脏改动。 */
export function validatePreMergeShaAndWorktree({
  currentHead,
  evidence = null,
  ledger = null,
  lastRound = null,
  dirtyCount = 0,
  requiresReview = true,
  stopLossActive = false,
} = {}) {
  if (dirtyCount > 0 || evidence?.dirty === true) {
    return {
      ok: false,
      code: 'BLOCKED_DIRTY_WORKTREE',
      reason: `A6 合并前工作区非干净状态（dirty=${dirtyCount}, evidenceDirty=${Boolean(evidence?.dirty)}）。`,
    }
  }
  if (!currentHead || !evidence?.headSha || evidence.headSha !== currentHead || (ledger && ledger.verifiedHead && ledger.verifiedHead !== currentHead)) {
    return {
      ok: false,
      code: 'BLOCKED_PRE_MERGE_SHA_MISMATCH',
      reason: `A6 合并前 SHA 不一致：HEAD=${String(currentHead ?? 'null').slice(0, 8)} vs evidence.headSha=${String(evidence?.headSha ?? 'null').slice(0, 8)} / ledger.verifiedHead=${String(ledger?.verifiedHead ?? 'null').slice(0, 8)}。`,
    }
  }
  if (requiresReview && !stopLossActive) {
    const revHead = lastRound?.headSha ?? ledger?.lastReview?.headSha ?? ledger?.reviewPassedHead ?? null
    const allRevMatch = Boolean(revHead)
      && ledger?.reviewPassedHead === currentHead
      && (!ledger?.lastReview || ledger.lastReview.headSha === currentHead)
      && (!lastRound || lastRound.headSha === currentHead)
      && evidence.headSha === revHead
    if (!allRevMatch) {
      return {
        ok: false,
        code: 'BLOCKED_PRE_MERGE_SHA_MISMATCH',
        reason: `A6 合并前三方 SHA 不一致：HEAD=${currentHead.slice(0, 8)} / evidence=${evidence.headSha.slice(0, 8)} / review=${String(revHead ?? 'null').slice(0, 8)}。`,
      }
    }
  }
  return { ok: true, code: null }
}

/**
 * 以 `merge-base(baseBranch, HEAD)` 校准有效比较基线，避免手动 `git rebase origin/main` 后
 * 滞后的 `ledger.baseSha` 把已合入主干的文件误算进当前任务 diff 与 `runtimeFilesTouched`。
 */
export async function resolveEffectiveBaseSha(repoRoot, ledger, { gitCommonDir = null, pushRemote = 'origin' } = {}) {
  const storedBase = ledger?.baseSha ?? null
  if (!repoRoot || ledger?.isolation === 'in-place' || (ledger?.branch && ledger?.baseBranch && ledger.branch === ledger.baseBranch)) {
    return storedBase
  }
  const baseBranch = String(ledger?.baseBranch ?? '').trim() || await resolveDefaultBranch(repoRoot, { strict: true })
  if (!baseBranch) return storedBase
  const candidates = []
  const seen = new Set()
  const addCand = (ref) => {
    if (ref && !seen.has(ref)) { seen.add(ref); candidates.push(ref) }
  }
  addCand(`refs/remotes/${pushRemote}/${baseBranch}`)
  addCand(`refs/heads/${baseBranch}`)
  addCand(baseBranch)

  let bestSha = null
  for (const ref of candidates) {
    const refSha = gitCommonDir ? resolveRefShaFast(gitCommonDir, ref) : null
    const probeRef = refSha || ref
    const mb = await gitRun(repoRoot, ['--no-optional-locks', 'merge-base', probeRef, 'HEAD'])
    const mbSha = mb.ok ? mb.stdout.trim() : ''
    if (!mbSha || !/^[0-9a-f]{40,64}$/i.test(mbSha)) continue
    if (storedBase && mbSha !== storedBase) {
      const anc = await gitRun(repoRoot, ['--no-optional-locks', 'merge-base', '--is-ancestor', storedBase, mbSha])
      if (!anc.ok) continue
    }
    if (!bestSha) {
      bestSha = mbSha
    } else if (bestSha !== mbSha) {
      const newer = await gitRun(repoRoot, ['--no-optional-locks', 'merge-base', '--is-ancestor', bestSha, mbSha])
      if (newer.ok) bestSha = mbSha
    }
  }
  return bestSha || storedBase
}

/** 对多个 Issue 依正文提取出的 Depends on / Blocks 关系进行拓扑排序与策略建议。 */
export function analyzeIssueDependencies(issueItems = []) {
  const byNum = new Map()
  for (const it of issueItems) if (Number.isInteger(it?.number)) byNum.set(it.number, it)
  const nums = [...byNum.keys()]
  if (nums.length <= 1) {
    return { hasDependencies: false, orderedIssues: nums, edges: [], hasCycle: false, strategy: nums.length === 1 ? 'single-issue' : 'none' }
  }
  const adj = new Map(nums.map((n) => [n, new Set()]))
  const indeg = new Map(nums.map((n) => [n, 0]))
  const edges = []
  const addEdge = (from, to, kind) => {
    if (!byNum.has(from) || !byNum.has(to) || from === to || adj.get(from).has(to)) return
    adj.get(from).add(to)
    indeg.set(to, (indeg.get(to) ?? 0) + 1)
    edges.push({ from, to, kind })
  }
  for (const item of byNum.values()) {
    const rel = item.relations ?? parseBodyRelations(item.body ?? '')
    for (const dep of rel.dependsOn ?? []) addEdge(dep, item.number, 'depends-on')
    for (const blk of rel.blocks ?? []) addEdge(item.number, blk, 'blocks')
  }
  const queue = nums.filter((n) => indeg.get(n) === 0).sort((a, b) => a - b)
  const ordered = []
  while (queue.length > 0) {
    const cur = queue.shift()
    ordered.push(cur)
    for (const next of adj.get(cur)) {
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0) { queue.push(next); queue.sort((a, b) => a - b) }
    }
  }
  const hasCycle = ordered.length < nums.length
  if (hasCycle) for (const n of nums.sort((a, b) => a - b)) if (!ordered.includes(n)) ordered.push(n)
  const parents = new Set()
  for (const it of byNum.values()) for (const p of it.relations?.partOf ?? []) parents.add(p)
  return {
    hasDependencies: edges.length > 0, orderedIssues: ordered, edges, hasCycle,
    strategy: edges.length > 0 ? 'serial-order' : (parents.size === 1 ? 'same-branch-or-parallel' : 'parallel-or-combine'),
  }
}

/** 构造 `flow.mjs submit` 结束时的下一步唯一合法动作（未装配 dev-review 时不引导 review-pack.mjs）。 */
export function buildSubmitNextSteps({ taskId, role, policy, nextRound = 1, hasDevReview = true } = {}) {
  if (hasDevReview && policy?.independentReviewRequired !== false) {
    return [{
      skill: 'dev-review',
      text: `【须派发独立审查子代理/新会话，严禁在当前实现上下文自跑】node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}`,
    }]
  }
  if (role === 'contributor-fork') {
    return ['当前处于 awaiting-upstream-merge，请等待上游维护者合并；合并前严禁删除该 Fork 分支。']
  }

  const approveFlag = policy?.humanApprovalRequired ? ' --human-approved --reason "<确认原因>"' : ''
  return [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId}${approveFlag}` }]
}

/** 构造 `flow.mjs inspect` 结束时的下一步指引（未装配 dev-review 时阻断外部 PR 并提示补齐技能）。 */
export function buildInspectNextSteps({ role, teamProbeHint, extPrNum, reuseExistingPr, hasDevReview = true } = {}) {
  if (extPrNum) {
    if (!hasDevReview) {
      return ['当前项目未装配 dev-review 技能，外部 PR 不可信扫描与审查需先通过 project-forge 的 equip 补齐完整技能集。']
    }
    return [
      { skill: 'dev-flow', text: `1. 建立只读隔离审查位（不挂载依赖）：node ".agents/skills/dev-flow/scripts/flow.mjs" start --external-pr ${extPrNum}` },
      { skill: 'dev-review', text: `2. 先跑不可信供应链静态扫描：node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${extPrNum} --untrusted-scan` },
    ]
  }
  if (reuseExistingPr) {
    const steps = [
      { skill: 'dev-flow', text: `1. 接手/返工该已有 PR（复用原分支，禁止新开第二个 PR）：node ".agents/skills/dev-flow/scripts/flow.mjs" start --pr ${reuseExistingPr.prNumber}` },
    ]
    if (hasDevReview) {
      steps.push({ skill: 'dev-flow', text: `2. 若仅独立审查该 PR：node ".agents/skills/dev-flow/scripts/flow.mjs" start --external-pr ${reuseExistingPr.prNumber} 后运行 review-pack.mjs --pr ${reuseExistingPr.prNumber}` })
    }
    return steps
  }
  if (role === 'clone-readonly') {
    return [
      teamProbeHint
        ? '若是组织/团队协作者，可先运行 flow.mjs inspect --probe-auth 验证写权限；若确认为只读克隆，再带 --clone-choice 运行 start'
        : '只读克隆仓，请先向用户确认 --clone-choice <fork|standalone|local> 再运行 flow.mjs start',
    ]
  }
  return [{ skill: 'dev-plan', text: '1. 按任务规模运行 doc-plan.mjs triage；2. 执行 flow.mjs start --task <id>' }]
}
