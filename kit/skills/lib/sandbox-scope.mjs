/**
 * sandbox-scope.mjs —— 隔离沙箱状态常量、多代理写域归一化/防碰撞校验与内环快检判定。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/），从 ledger.mjs 与 flow-lifecycle.mjs 抽离以严守 800 行上限。
 */

import { EXIT } from './exit-codes.mjs'
import { posixPath, scopePatternPairOverlaps } from './git-core.mjs'
import { isNonImplRoleActor, isValidActorName } from './harness-context.mjs'

export const SANDBOX_STATUSES = Object.freeze([
  'sandbox-iterating',
  'sandbox-ready-to-promote',
  'sandbox-needs-spec',
])

const SANDBOX_STATUS_SET = new Set(SANDBOX_STATUSES)
const FULL_REPO_PATTERNS = new Set(['.', '*', '**', './**', '**/*'])

export function isSandboxStatus(status) {
  return SANDBOX_STATUS_SET.has(String(status ?? '').trim().toLowerCase())
}

function normActorKey(raw) {
  return String(raw ?? '').trim().replace(/^@/, '').toLowerCase()
}

/** 规范化写域路径/通配列表（兼容逗号/空白字符串与数组）。 */
export function normalizeWriteScope(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' && raw.trim() ? raw.split(/[\s,]+/) : [])
  const out = []
  const seen = new Set()
  for (const item of parts) {
    const clean = posixPath(String(item ?? '').trim())
      .replace(/^(?:\.\/)+/, '')
      .replace(/^\/+|\/+$/g, '')
    if (!clean) continue
    if (!seen.has(clean)) {
      seen.add(clean)
      out.push(clean)
    }
  }
  return out.sort()
}

function isFullRepoScope(scopeList) {
  if (!Array.isArray(scopeList) || scopeList.length === 0) return true
  return scopeList.some((p) => FULL_REPO_PATTERNS.has(p))
}

/** 判定两组写域是否存在目录前缀包含、通配交集或全仓写域碰撞（单源复用 `scopePatternPairOverlaps`）。 */
export function checkScopeListsOverlap(scopeA = [], scopeB = []) {
  const normA = normalizeWriteScope(scopeA)
  const normB = normalizeWriteScope(scopeB)
  if (isFullRepoScope(normA) || isFullRepoScope(normB)) {
    return {
      overlap: true,
      conflicts: [{ a: normA[0] ?? '**', b: normB[0] ?? '**', reason: 'full-repo-scope' }],
    }
  }
  const conflicts = []
  for (const a of normA) {
    for (const b of normB) {
      if (scopePatternPairOverlaps(a, b)) {
        conflicts.push({ a, b, reason: 'path-or-glob-overlap' })
      }
    }
  }
  return { overlap: conflicts.length > 0, conflicts }
}

export { checkScopeListsOverlap as scopesOverlap }

/** 校核新登记实施者与既有其他并行实施者的写域是否碰撞。 */
export function checkWriteScopeOverlap(existingImplementers = [], { actor, writeScope = [] } = {}) {
  const actorKey = normActorKey(actor)
  const incomingScope = normalizeWriteScope(writeScope)
  const list = Array.isArray(existingImplementers) ? existingImplementers : []
  const conflicts = []

  for (const entry of list) {
    if (!entry) continue
    const entryActor = typeof entry === 'string' ? entry : entry.actor
    const entryKey = normActorKey(entryActor)
    if (!entryKey || entryKey === actorKey) continue
    const entryScope = typeof entry === 'string' ? [] : normalizeWriteScope(entry.writeScope)
    const ov = checkScopeListsOverlap(entryScope, incomingScope)
    if (ov.overlap) {
      conflicts.push({
        existingActor: entryActor,
        existingScope: entryScope.length > 0 ? entryScope : ['**'],
        incomingActor: String(actor ?? '').trim(),
        incomingScope: incomingScope.length > 0 ? incomingScope : ['**'],
        pairs: ov.conflicts,
      })
    }
  }

  if (conflicts.length > 0) {
    const desc = conflicts
      .map((c) => `${c.incomingActor}[${c.incomingScope.join(',')}] <-> ${c.existingActor}[${c.existingScope.join(',')}]`)
      .join('；')
    return {
      ok: false,
      code: 'BLOCKED_SANDBOX_WRITE_SCOPE_OVERLAP',
      exitCode: EXIT.FACT,
      conflicts,
      reason: `沙箱并行实施者写域存在重叠（${desc}）；请指定互不重叠的 --write-scope 或由单一常驻实施者续写。`,
    }
  }
  return { ok: true, conflicts: [] }
}

/** 登记或续写沙箱实施者到 ledger.implementers[]，校验合法角色与写域不重叠。 */
export function registerImplementer(ledger, { actor, writeScope = [], phase = 'sandbox' } = {}) {
  if (!isValidActorName(actor)) {
    return {
      ok: false,
      code: 'BLOCKED_MISSING_ACTOR',
      exitCode: EXIT.USAGE,
      reason: '缺少有效的沙箱实施者标识（禁止为空、null 或占位词），请传入 --agent <实施代理名>。',
    }
  }
  const cleanActor = String(actor).trim()
  if (isNonImplRoleActor(cleanActor)) {
    return {
      ok: false,
      code: 'BLOCKED_MISSING_ACTOR',
      exitCode: EXIT.USAGE,
      reason: `沙箱实施者标识不能为协调者/审查者角色（${cleanActor}），请传入真实实施代理名。`,
    }
  }

  const incomingScope = normalizeWriteScope(writeScope)
  const current = Array.isArray(ledger?.implementers) ? [...ledger.implementers] : []
  const actorKey = normActorKey(cleanActor)
  const existingIdx = current.findIndex((e) => normActorKey(typeof e === 'string' ? e : e?.actor) === actorKey)

  let candidateScope = incomingScope
  if (existingIdx >= 0) {
    const prevRaw = current[existingIdx]
    const prevScope = typeof prevRaw === 'string' ? [] : normalizeWriteScope(prevRaw?.writeScope)
    if (prevScope.length === 0 || incomingScope.length === 0) {
      candidateScope = prevScope.length > 0 ? prevScope : incomingScope
    } else {
      candidateScope = normalizeWriteScope([...prevScope, ...incomingScope])
    }
  }

  const ovCheck = checkWriteScopeOverlap(current, { actor: cleanActor, writeScope: candidateScope })
  if (!ovCheck.ok) return ovCheck

  const now = new Date().toISOString()
  const entry = {
    actor: cleanActor,
    writeScope: candidateScope,
    phase: String(phase || 'sandbox'),
    registeredAt: existingIdx >= 0 && current[existingIdx]?.registeredAt ? current[existingIdx].registeredAt : now,
    updatedAt: now,
  }
  if (existingIdx >= 0) current[existingIdx] = entry
  else current.push(entry)

  if (ledger && typeof ledger === 'object') {
    ledger.implementers = current
  }
  return {
    ok: true,
    actor: cleanActor,
    writeScope: candidateScope,
    reused: existingIdx >= 0,
    implementers: current,
  }
}

/**
 * 判定当前调用是否属于沙箱/内环快检：
 * 仅在 verify 阶段且满足 sandboxMode === true 或 opts.inner === true 时返回 true；
 * finalize / submit / merge 永不为 true。
 */
export function isInnerVerifyMode(ledger, opts = {}) {
  const stage = opts?._stage ? String(opts._stage).trim().toLowerCase() : null
  if (stage && stage !== 'verify') return false
  return Boolean(ledger?.sandboxMode === true || opts?.inner === true)
}
