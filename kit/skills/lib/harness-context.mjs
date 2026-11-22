/**
 * harness-context.mjs —— 宿主模式判定、非空执行者解析、槽位隔离硬检查与作者/实施者角色分离原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/），不绑定任何具体 AI 宿主名或私有路径。
 */

import { EXIT } from './exit-codes.mjs'
import { normOwnerId } from './doc-approval.mjs'
import { canonicalPath } from './git.mjs'

const PLACEHOLDER_ACTOR_RE = /^(?:null|undefined|unknown|none|tbd|todo|n\/a|placeholder|<[^>]+>|待定|待填|未指定)$/i
const COORDINATOR_ACTOR_RE = /(?:^|[-_.])(?:coordinator|orchestrator|dispatcher)(?:$|[-_.])/i

/**
 * 解析当前执行宿主模式：`multi-agent`（默认）或 `single-session`。
 * 仅读取标准 CLI 选项与通用环境变量 `PF_HOST_MODE`，不识别或绑定特定 AI 宿主名称。
 */
export function resolveHostMode(opts = {}, env = process.env) {
  if (opts['single-session'] === true) return 'single-session'
  const rawCli = String(opts['host-mode'] ?? opts.hostMode ?? '').trim().toLowerCase()
  if (rawCli === 'single-session' || rawCli === 'single') return 'single-session'
  if (rawCli === 'multi-agent' || rawCli === 'multi') return 'multi-agent'
  const rawEnv = String(env?.PF_HOST_MODE ?? '').trim().toLowerCase()
  if (rawEnv === 'single-session' || rawEnv === 'single') return 'single-session'
  return 'multi-agent'
}

export function isValidActorName(raw) {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return false
  const s = String(raw).trim()
  if (!s) return false
  return !PLACEHOLDER_ACTOR_RE.test(s)
}

export function isCoordinatorActor(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return false
  return COORDINATOR_ACTOR_RE.test(s)
}

/**
 * 校验并提取非空合法执行者标识（拒绝空值、`null`、`undefined` 或占位符）。
 */
export function resolveNonEmptyActor(candidates = [], {
  role = 'actor',
  hostMode = 'multi-agent',
  humanApproved = false,
  allowSingleSessionWaive = false,
  allowCoordinator = true,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [candidates]
  for (const cand of list) {
    if (!isValidActorName(cand)) continue
    const actor = String(cand).trim()
    if (!allowCoordinator && isCoordinatorActor(actor)) {
      return {
        ok: false,
        code: 'BLOCKED_MISSING_ACTOR',
        exitCode: EXIT.USAGE,
        reason: `${role} 标识不能为调度协调者（${actor}），请传入真实执行代理名。`,
      }
    }
    return { ok: true, actor }
  }
  if (allowSingleSessionWaive && hostMode === 'single-session' && humanApproved) {
    return { ok: true, actor: 'human', waived: true }
  }
  return {
    ok: false,
    code: 'BLOCKED_MISSING_ACTOR',
    exitCode: EXIT.USAGE,
    reason: `缺少有效的 ${role} 执行者标识（禁止为空、null 或占位词），请显式传入非空身份标识。`,
  }
}

/**
 * 校验文档 Frontmatter `owner` 值：禁止 `owner: null`、空串或占位词。
 */
export function validateDocOwnerValue(rawOwner, { allowMissing = false } = {}) {
  if ((rawOwner === undefined || rawOwner === null || rawOwner === '') && allowMissing) {
    return { ok: true, owner: null }
  }
  if (!isValidActorName(rawOwner)) {
    return {
      ok: false,
      code: 'INVALID_OWNER',
      exitCode: EXIT.USAGE,
      reason: `文档负责人 owner 不得为空、null 或占位词（收到：${String(rawOwner)}），请通过 --owner <负责人> 指定明确作者。`,
    }
  }
  return { ok: true, owner: String(rawOwner).trim() }
}

/**
 * 槽位边界硬门禁：
 *   - Case 1 允许主仓原地微调；
 *   - Case >= 2 在 commits > 0 仓内禁止主仓原地实施（BLOCKED_MAIN_SLOT_VIOLATION），
 *     且主仓存在脏改动时禁止新开 Case >= 2 实施槽位（BLOCKED_DIRTY_MAIN）。
 */
export function enforceSlotBoundary({
  mainRoot,
  implRoot,
  caseType = 3,
  isDirtyMain = false,
  commits = 1,
} = {}) {
  const caseNum = Number(caseType ?? 3)
  const hasCommits = Number(commits ?? 1) > 0
  const isSameMain = Boolean(mainRoot && implRoot && canonicalPath(mainRoot) === canonicalPath(implRoot))

  if (caseNum >= 2 && hasCommits && isDirtyMain) {
    return {
      ok: false,
      code: 'BLOCKED_DIRTY_MAIN',
      exitCode: EXIT.FACT,
      reason: '主仓工作区存在未提交脏改动，Case >= 2 禁止在脏主仓上开启或合并隔离槽位；请先清理或提交主仓改动。',
    }
  }
  if (caseNum === 1) {
    return { ok: true, inPlace: isSameMain }
  }
  if (hasCommits && isSameMain) {
    return {
      ok: false,
      code: 'BLOCKED_MAIN_SLOT_VIOLATION',
      exitCode: EXIT.FACT,
      reason: `Case ${caseNum}（commits > 0）禁止直接在主仓原地实施（implRoot === mainRoot），必须使用隔离 .worktrees/impl-<taskId>/。`,
    }
  }
  return { ok: true, inPlace: false }
}

/**
 * 校验规划作者与实际实施者分离（`author !== implementer`）。
 * 仅在 `single-session` 且经人类显式确认（`--human-approved`）时允许单人自建自改。
 */
export function checkAuthorIsNotImplementer(authorOrList, implementer, {
  hostMode = 'multi-agent',
  humanApproved = false,
  file = null,
} = {}) {
  if (hostMode === 'single-session' && humanApproved) {
    return { ok: true, waived: true }
  }
  if (!isValidActorName(implementer)) return { ok: true }
  const authors = Array.isArray(authorOrList) ? authorOrList : [authorOrList]
  const implNorm = normOwnerId(implementer)
  const matched = authors.find((a) => isValidActorName(a) && normOwnerId(a) === implNorm)
  if (!matched) return { ok: true }
  return {
    ok: false,
    code: 'BLOCKED_AUTHOR_IS_IMPLEMENTER',
    exitCode: EXIT.FACT,
    author: String(matched).trim(),
    implementerId: String(implementer).trim(),
    ...(file ? { file } : {}),
    reason: `${file ? `${file} 的` : ''}规划作者（${String(matched).trim()}）与实施者（${String(implementer).trim()}）为同一主体；多代理模式下禁止同一代理既写验收标准又实施。`,
  }
}
