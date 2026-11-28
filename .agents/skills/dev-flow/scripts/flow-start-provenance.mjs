/**
 * flow-start-provenance.mjs —— `flow start` 仓外规划溯源防绕过校验与角色隔离门禁。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 flow-inspect.mjs 以控制单文件 <= 800 行。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { isNonImplRoleActor, isValidActorName, resolveHostMode } from '../../lib/harness-context.mjs'
import { verifyPlanningProvenance } from '../../lib/ledger.mjs'

/**
 * 校验规划文档仓外 `planningProvenance` 完整性（防手工篡改 `owner:` / `previous_owners:`）
 * 及多代理模式下 `author !== implementer` 与角色合法性。
 *
 * 绝不以 Git commit `user.name` 拦截共享同一宿主的本地隔离实施子代理。
 */
export function validateStartProvenanceAndRole({
  mainRoot,
  docRoot = mainRoot,
  docRels = [],
  taskId = null,
  ledger = null,
  caseType = 3,
  explicitImplementer = null,
  opts = {},
  isGit = true,
} = {}) {
  const hostMode = resolveHostMode(opts)
  const humanApproved = Boolean(opts['human-approved'])
  const caseNum = Number(caseType ?? ledger?.caseType ?? 3)
  const implActor = isValidActorName(explicitImplementer) ? String(explicitImplementer).trim() : null

  if (implActor && caseNum >= 2 && hostMode !== 'single-session' && isNonImplRoleActor(implActor)) {
    return {
      ok: false,
      blocked: true,
      code: 'BLOCKED_MISSING_ACTOR',
      exitCode: EXIT.USAGE,
      actor: implActor,
      reason: `Case ${caseNum} 多代理模式下，实施者 --agent/--implementer 不能为调度协调者或审查角色（${implActor}），请传入真实实施代理名。`,
    }
  }

  const provRes = verifyPlanningProvenance({
    mainRoot,
    docRoot,
    docRels: (Array.isArray(docRels) ? docRels : []).filter(Boolean),
    taskId,
    ledger,
    implementerId: implActor,
    hostMode,
    humanApproved,
    isGit,
  })
  if (provRes.blocked) return provRes
  return { ok: true, blocked: false, exitCode: EXIT.OK, authors: provRes.authors ?? [] }
}
