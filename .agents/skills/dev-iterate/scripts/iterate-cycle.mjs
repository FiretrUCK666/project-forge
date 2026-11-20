/**
 * iterate-cycle.mjs —— dev-iterate 的有界优化循环编排器（`iterate.mjs cycle`）。
 *
 * 四阶段状态机：`Observe -> PoC/Escalate (autonomous) -> Fix/Verify -> Reflect`。
 * 它只做裁判与排程：不写业务源码、不提交、不跳过
 * `dev-plan -> dev-edit -> dev-review` 正流；一旦触发硬停损就退出来交给人或正流。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

/** 默认与硬上限轮次：无论调用方传什么，循环都不会超过硬上限。 */
export const DEFAULT_MAX_ROUNDS = 3
export const HARD_MAX_ROUNDS = 10

/** 四阶段推进顺序。 */
export const CYCLE_PHASES = Object.freeze(['observe', 'poc-escalate', 'fix-verify', 'reflect'])

/** 三条硬停损闸门。 */
export const STOP_REASONS = Object.freeze({
  ROUND_LIMIT: 'ROUND_LIMIT_REACHED',
  NO_PROGRESS: 'NO_PROGRESS_STALL',
  ONE_WAY: 'ONE_WAY_GATE_HIT',
})

/** 连续多少轮零进展即判停损。 */
export const STALL_ROUNDS = 2

const ONE_WAY_MARKER_RE = /(?:one[-_\s]?way|单向门|不可逆|高风险|high[-_\s]?risk|人工拍板|需人工)/i

/** 归一化轮次上限：非法值回落默认值，超出硬上限一律截到硬上限。 */
export function normalizeMaxRounds(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_ROUNDS
  return Math.min(Math.floor(n), HARD_MAX_ROUNDS)
}

function parseJsonish(raw, fallback) {
  if (Array.isArray(raw)) return raw
  const text = String(raw ?? '').trim()
  if (!text) return fallback
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object') return [parsed]
    return fallback
  } catch {
    return fallback
  }
}

/**
 * 归一化进度历史：每轮只保留可比的客观计数。
 * `progress` 是相对上一轮的净增量，用来判定「有没有真的往前走」。
 */
export function normalizeProgressHistory(raw) {
  const items = parseJsonish(raw, [])
  const rounds = []
  for (const [idx, item] of items.entries()) {
    if (item === null || item === undefined) continue
    const rec = typeof item === 'number' ? { advanced: item } : item
    if (!rec || typeof rec !== 'object') continue
    const observed = Number(rec.observed ?? rec.observations ?? 0)
    const passed = Number(rec.passed ?? rec.passCount ?? 0)
    const verified = Number(rec.verified ?? rec.verifiedCount ?? 0)
    const advanced = Number(rec.advanced ?? rec.progress ?? NaN)
    const safe = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
    rounds.push({
      round: Number(rec.round ?? idx + 1),
      observed: safe(observed),
      passed: safe(passed),
      verified: safe(verified),
      advanced: safe(advanced),
      ...(rec.summary ? { summary: String(rec.summary).trim().slice(0, 300) } : {}),
    })
  }
  return rounds.sort((a, b) => a.round - b.round)
}

/** 归一化待拍板门禁：支持字符串与对象两种形态，识别 one-way / 高风险标记。 */
export function normalizePendingGates(raw) {
  const items = parseJsonish(raw, [])
  const gates = []
  for (const item of items) {
    if (!item) continue
    const rec = typeof item === 'string' ? { summary: item } : item
    if (!rec || typeof rec !== 'object') continue
    const summary = String(rec.summary ?? rec.title ?? rec.reason ?? '').trim()
    if (!summary) continue
    const kindText = `${rec.kind ?? rec.type ?? rec.doorType ?? ''} ${summary}`
    gates.push({
      id: String(rec.id ?? `gate-${gates.length + 1}`).trim(),
      summary: summary.slice(0, 300),
      oneWay: Boolean(rec.oneWay || rec.oneWayGate || rec.highRisk) || ONE_WAY_MARKER_RE.test(kindText),
    })
  }
  return gates
}

/**
 * 计算每轮相对上一轮的净进展。
 * 观察数、通过数、实证数三者任一有净增长即算「有进展」；三者同时为零即零进展轮。
 */
export function computeRoundProgress(history = []) {
  let prevObserved = 0
  let prevPassed = 0
  let prevVerified = 0
  return (Array.isArray(history) ? history : []).map((rec) => {
    const deltaObserved = rec.observed - prevObserved
    const deltaPassed = rec.passed - prevPassed
    const deltaVerified = rec.verified - prevVerified
    const progress = rec.advanced > 0
      ? rec.advanced
      : Math.max(0, deltaObserved) + Math.max(0, deltaPassed) + Math.max(0, deltaVerified)
    prevObserved = Math.max(prevObserved, rec.observed)
    prevPassed = Math.max(prevPassed, rec.passed)
    prevVerified = Math.max(prevVerified, rec.verified)
    return {
      round: rec.round,
      progress,
      zeroProgress: progress === 0,
      ...(rec.summary ? { summary: rec.summary } : {}),
    }
  })
}

/** 尾部连续零进展轮数。 */
export function trailingZeroProgressRounds(roundProgress = []) {
  let n = 0
  for (let i = roundProgress.length - 1; i >= 0; i -= 1) {
    if (!roundProgress[i].zeroProgress) break
    n += 1
  }
  return n
}

/**
 * 判定硬停损。返回首个命中的闸门（顺序：轮次上限 -> 单向门 -> 零进展）。
 * 轮次上限优先，因为它是最确定、最容易解释的一条。
 */
export function detectStopLoss({ maxRounds = DEFAULT_MAX_ROUNDS, roundProgress = [], pendingGates = [], nextRound = 1 } = {}) {
  const rounds = Array.isArray(roundProgress) ? roundProgress : []
  if (nextRound > maxRounds) {
    return {
      stopped: true,
      stopReason: STOP_REASONS.ROUND_LIMIT,
      detail: `已完成 ${rounds.length} 轮，达到轮次上限 ${maxRounds}；请收敛结论或另开新循环，不要在同一个循环里无限自旋。`,
    }
  }
  const oneWay = (Array.isArray(pendingGates) ? pendingGates : []).filter((g) => g.oneWay)
  if (oneWay.length > 0) {
    return {
      stopped: true,
      stopReason: STOP_REASONS.ONE_WAY,
      detail: `存在待人工拍板的单向门/高风险边界：${oneWay.map((g) => g.summary).slice(0, 3).join('；')}；该判定不可由循环自行跨过。`,
      pendingGates: oneWay,
    }
  }
  const zeroStreak = trailingZeroProgressRounds(rounds)
  if (zeroStreak >= STALL_ROUNDS) {
    return {
      stopped: true,
      stopReason: STOP_REASONS.NO_PROGRESS,
      detail: `连续 ${zeroStreak} 轮观察/通过数零进展（阈值 ${STALL_ROUNDS}），继续跑只是重复消耗；请换切入角度或升级为正式问题单。`,
    }
  }
  return { stopped: false, stopReason: null, detail: null }
}

/** 依当前轮次给出该走的四阶段编排。 */
function buildRoundStages(round, stop) {
  const escalate = Boolean(stop.stopped && stop.stopReason !== STOP_REASONS.ROUND_LIMIT)
  return [
    {
      phase: CYCLE_PHASES[0],
      round,
      autonomous: true,
      action: '交叉比对 feature-map / signals.jsonl / 近期变更，列出本轮要压的盲区与热点',
      command: 'node .agents/skills/dev-iterate/scripts/iterate.mjs plan --json',
    },
    {
      phase: CYCLE_PHASES[1],
      round,
      autonomous: true,
      escalate,
      action: escalate
        ? '停损已触发：把当前缺陷按最小复现与可重放命令升级为正式问题单，交给正流处理'
        : '先写最小可执行复现压掉误报；确认真缺陷后按 escalation 结构化上报',
      command: 'node .agents/skills/dev-iterate/scripts/iterate.mjs run --escalate',
    },
    {
      phase: CYCLE_PHASES[2],
      round,
      autonomous: false,
      action: '缺陷走 dev-plan -> dev-edit -> dev-review 正流修复，并用同条复现命令复跑变绿',
      command: 'node .agents/skills/dev-flow/scripts/flow.mjs next',
    },
    {
      phase: CYCLE_PHASES[3],
      round,
      autonomous: true,
      action: '回看单点缺陷是否折射同模式共性：能下沉到静态门禁或共享边界原语的，就在这一层收口',
      command: 'node .agents/skills/dev-govern/scripts/govern-audit.mjs audit .',
    },
  ]
}

/**
 * 构造有界循环编排结果。纯函数，不读盘不写盘，绝不修改任何源码。
 */
export function buildCyclePlan({ goal = '', maxRounds = DEFAULT_MAX_ROUNDS, progressHistory = [], pendingGates = [] } = {}) {
  const goalText = String(goal ?? '').trim()
  const rounds = normalizeMaxRounds(maxRounds)
  const history = normalizeProgressHistory(progressHistory)
  const gates = normalizePendingGates(pendingGates)
  const roundProgress = computeRoundProgress(history)
  const nextRound = (history.at(-1)?.round ?? 0) + 1
  const stop = detectStopLoss({ maxRounds: rounds, roundProgress, pendingGates: gates, nextRound })
  const stages = stop.stopped && stop.stopReason === STOP_REASONS.ROUND_LIMIT
    ? []
    : buildRoundStages(nextRound, stop)

  return {
    goal: goalText,
    maxRounds: rounds,
    hardMaxRounds: HARD_MAX_ROUNDS,
    stalled: trailingZeroProgressRounds(roundProgress) >= STALL_ROUNDS,
    roundsCompleted: history.length,
    nextRound: stop.stopped ? null : nextRound,
    phase: stages[0]?.phase ?? null,
    phases: [...CYCLE_PHASES],
    stages,
    roundProgress,
    pendingGates: gates,
    stopped: stop.stopped,
    stopReason: stop.stopReason,
    stopDetail: stop.detail,
    readOnly: true,
    mutatesSource: false,
    policy: '本子命令只做只读编排与停损裁判：不改源码、不提交、不跳过 dev-plan -> dev-edit -> dev-review 正流。',
  }
}

/** 终端可读排版。 */
export function formatCycleText(plan) {
  const lines = [
    `dev-iterate cycle: goal="${plan.goal || '(未提供)'}" maxRounds=${plan.maxRounds} (hard<=${plan.hardMaxRounds})`,
    `Progress : rounds=${plan.roundsCompleted} next=${plan.nextRound ?? 'none'} stalled=${plan.stalled}`,
  ]
  if (plan.stopped) {
    lines.push(`STOPPED  : ${plan.stopReason}`)
    lines.push(`Reason   : ${plan.stopDetail}`)
  } else {
    for (const st of plan.stages) {
      lines.push(`  [${st.phase}]${st.autonomous ? ' (autonomous)' : ''} ${st.action}`)
      if (st.command) lines.push(`    $ ${st.command}`)
    }
  }
  lines.push(`Policy   : ${plan.policy}`)
  return lines.join('\n')
}
