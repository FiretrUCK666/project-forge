/**
 * mutability.mjs —— 统一规划文档与任务运行态两态可变性评估（OPEN / LOCKED）。
 *
 * 严格零第三方依赖（仅纯函数，无任何第三种“半可变/队列”状态）。
 */

export const MUTABILITY = Object.freeze({
  OPEN: 'OPEN',
  LOCKED: 'LOCKED',
})

const TERMINAL_STATES = new Set([
  'merged',
  'aborted',
  'dropped',
  'archived',
  'done',
  'implemented',
  'superseded',
])

const LOCKED_RUNTIME_PHASES = new Set([
  'needs-review',
  'ready-to-merge',
  'awaiting-upstream-merge',
  'awaiting-remote-mr',
])

const OPEN_REWORK_STATUSES = new Set([
  'changes',
  'rework',
  'queue-conflict',
  'verify-failed',
])

const OPEN_SANDBOX_STATUSES = new Set([
  'sandbox-iterating',
  'sandbox-ready-to-promote',
  'sandbox-needs-spec',
])

function buildSafeExits({ isDoc = false, isTerminal = false, taskId = '<taskId>', file = '<docPath>' } = {}) {
  if (isTerminal) {
    return [
      {
        action: 'slice',
        command: `doc-plan init --kind spec --slug <new-slug> --title "<新规格>"`,
        description: '当前目标处于终态只读，请新建独立 SPEC 或后续切片继续推进',
      },
    ]
  }
  if (isDoc) {
    return [
      {
        action: 'drop-criterion',
        command: `doc-plan clarify --file "${file}" --drop-criterion C<N> --reason "<原因>" --by user`,
        description: '经用户授权删减/作废单条验收标准 C<N>（保留完整追踪记录）',
      },
      {
        action: 'slice',
        command: `doc-plan slice --prd <prdPath> --spec-slug <new-slug> --title "<新切片>"`,
        description: '冻结当前文档并按 1:N 切片拆出新 SPEC 承接新增需求',
      },
      {
        action: 'drop',
        command: `doc-plan archive --drop --reason "<原因>" "${file}"`,
        description: '将当前文档归档为 dropped 只读终态并重新开题',
      },
    ]
  }
  return [
    {
      action: 'reopen',
      command: `flow rework --task ${taskId} --reopen --reason "<原因>"`,
      description: '显式解锁当前冻结任务，原子撤销未消费 reviewToken 并回退到 OPEN',
    },
    {
      action: 'drop',
      command: `flow abort --task ${taskId} --reason "<原因>"`,
      description: '终止当前任务并将其关联活跃文档落入只读 dropped 终态',
    },
    {
      action: 'slice',
      command: `doc-plan slice --prd <prdPath> --spec-slug <new-slug> --title "<新切片>"`,
      description: '保持当前 PR/分支不变，新建独立 SPEC 承接后续增量',
    },
  ]
}

/**
 * 评估规划文档或任务运行态的唯一两态可变性（`OPEN` | `LOCKED`）。
 *
 * @param {object} [input]
 * @returns {{ state: 'open'|'locked', mutability: 'OPEN'|'LOCKED', terminal: boolean, mutable: boolean, reason: string, safeExits: Array<object> }}
 */
export function evaluateMutability({
  kind = null,
  status = null,
  approved = null,
  ledger = null,
  phase = null,
  doc = null,
  taskId = null,
  file = null,
} = {}) {
  const docKind = String(doc?.kind ?? kind ?? '').trim().toLowerCase() || null
  const docStatus = String(doc?.status ?? status ?? '').trim().toLowerCase() || null
  const docApproved = doc?.approved !== undefined ? doc.approved : approved
  const ledgerStatus = String(ledger?.status ?? '').trim().toLowerCase() || null
  const effPhase = String(phase ?? '').trim().toLowerCase() || null
  const tid = String(taskId ?? ledger?.taskId ?? '').trim() || '<taskId>'
  const docPath = String(file ?? doc?.file ?? doc?.rel ?? '').trim() || '<docPath>'
  const hasDocInput = Boolean(doc || docKind || docStatus !== null || docApproved !== null)
  const hasRuntimeInput = Boolean(ledger || effPhase)

  const terminalHit = [effPhase, ledgerStatus, docStatus].find((s) => s && TERMINAL_STATES.has(s))
  if (terminalHit) {
    return {
      state: 'locked',
      mutability: MUTABILITY.LOCKED,
      terminal: true,
      mutable: false,
      reason: `处于只读终态（${terminalHit}）`,
      safeExits: buildSafeExits({ isDoc: hasDocInput && !hasRuntimeInput, isTerminal: true, taskId: tid, file: docPath }),
    }
  }

  if (hasRuntimeInput) {
    if (OPEN_SANDBOX_STATUSES.has(effPhase) || OPEN_SANDBOX_STATUSES.has(ledgerStatus) || ledger?.sandboxMode === true) {
      return {
        state: 'open',
        mutability: MUTABILITY.OPEN,
        terminal: false,
        mutable: true,
        reason: `隔离沙箱处于可编辑态（${effPhase ?? ledgerStatus ?? 'sandbox-iterating'}）`,
        safeExits: [],
      }
    }
    if (effPhase && LOCKED_RUNTIME_PHASES.has(effPhase)) {
      return {
        state: 'locked',
        mutability: MUTABILITY.LOCKED,
        terminal: false,
        mutable: false,
        reason: `任务处于待审或待合并冻结态（${effPhase}）`,
        safeExits: buildSafeExits({ isDoc: false, isTerminal: false, taskId: tid, file: docPath }),
      }
    }
    if (ledger && !OPEN_REWORK_STATUSES.has(ledgerStatus)) {
      const runtimeLocked = Boolean(
        ledger.submitted
        || ledger.localReady
        || ledger.reviewPassed
        || LOCKED_RUNTIME_PHASES.has(ledgerStatus),
      )
      if (runtimeLocked) {
        return {
          state: 'locked',
          mutability: MUTABILITY.LOCKED,
          terminal: false,
          mutable: false,
          reason: `任务已提交或通过审查（status=${ledgerStatus ?? 'locked'}），需显式 --reopen 才可修改`,
          safeExits: buildSafeExits({ isDoc: false, isTerminal: false, taskId: tid, file: docPath }),
        }
      }
    }
    if (!hasDocInput) {
      return {
        state: 'open',
        mutability: MUTABILITY.OPEN,
        terminal: false,
        mutable: true,
        reason: `任务处于可编辑态（${effPhase ?? ledgerStatus ?? 'open'}）`,
        safeExits: [],
      }
    }
  }

  const docLocked = Boolean(
    docApproved === true
    || docStatus === 'approved'
    || docStatus === 'in_review'
    || (docKind === 'prd' && docStatus === 'active'),
  )
  if (docLocked) {
    return {
      state: 'locked',
      mutability: MUTABILITY.LOCKED,
      terminal: false,
      mutable: false,
      reason: `规划文档已批准或进入评审冻结（status=${docStatus ?? 'approved'}）`,
      safeExits: buildSafeExits({ isDoc: true, isTerminal: false, taskId: tid, file: docPath }),
    }
  }

  return {
    state: 'open',
    mutability: MUTABILITY.OPEN,
    terminal: false,
    mutable: true,
    reason: `处于可编辑态（${docStatus ?? effPhase ?? ledgerStatus ?? 'open'}）`,
    safeExits: [],
  }
}
