/**
 * iterate-cycle.mjs —— dev-iterate 的有界优化循环编排器（`iterate.mjs cycle`）。
 *
 * 四阶段状态机：`Observe -> PoC/Escalate (autonomous) -> Fix/Verify -> Reflect`。
 * 它只做裁判与排程：不写业务源码、不提交、不跳过
 * `dev-plan -> dev-edit -> dev-review` 正流；一旦触发硬停损就退出来交给人或正流。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { readJsonSafe, readTextSafe, writeJsonAtomic } from '../../lib/git.mjs'
import { resolveGitDirFast } from '../../lib/git-fast.mjs'

function resolveCycleStatePath(repoRoot) {
  const root = resolve(String(repoRoot || process.cwd()))
  const gd = resolveGitDirFast(root)
  if (gd && existsSync(gd)) {
    const cdFile = join(gd, 'commondir')
    const common = existsSync(cdFile) ? (readTextSafe(cdFile) ?? '').trim() : ''
    const gitCommonDir = common ? (isAbsolute(common) ? resolve(common) : resolve(gd, common)) : gd
    return join(gitCommonDir, 'project-forge-flow', 'iterate-cycle.json')
  }
  return join(root, '.worktrees', '.state', 'iterate-cycle.json')
}

export function loadCycleState(repoRoot) {
  return readJsonSafe(resolveCycleStatePath(repoRoot), null)
}

export function saveCycleState(repoRoot, state) {
  const path = resolveCycleStatePath(repoRoot)
  const payload = { schemaVersion: 1, updatedAt: new Date().toISOString(), ...(state && typeof state === 'object' ? state : {}) }
  writeJsonAtomic(path, payload)
  return payload
}

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

/**
 * 归一化轮次上限，并把「被改过的值」如实交出来。
 *
 * 非法值回落默认、超出硬上限截断，这两件事都改变调用方给的值。悄悄改掉它，
 * 调用方会以为自己设定的就是生效的那个——轮次规划随之失真，而失真没有任何痕迹。
 * 所以返回 `{ rounds, warnings }`，由调用方决定怎么显示。
 */
export function normalizeMaxRoundsDetail(raw) {
  const n = Number(raw)
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return { rounds: DEFAULT_MAX_ROUNDS, warnings: [] }
  }
  if (!Number.isFinite(n) || n <= 0) {
    return {
      rounds: DEFAULT_MAX_ROUNDS,
      warnings: [`--max-rounds 收到非法值「${String(raw)}」，已回落默认 ${DEFAULT_MAX_ROUNDS} 轮`],
    }
  }
  const wanted = Math.floor(n)
  if (wanted > HARD_MAX_ROUNDS) {
    return {
      rounds: HARD_MAX_ROUNDS,
      warnings: [`--max-rounds ${wanted} 超过硬上限，已截断为 ${HARD_MAX_ROUNDS} 轮（实际上限 ${HARD_MAX_ROUNDS}）`],
    }
  }
  return { rounds: wanted, warnings: [] }
}

/** 归一化轮次上限：只取值，供不关心告警的调用方使用。 */
export function normalizeMaxRounds(raw) {
  return normalizeMaxRoundsDetail(raw).rounds
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
 * 解析进度历史，解析失败时把失败交出来而不是返回空进度。
 *
 * 返回空进度看起来与「这是第一轮，还没有历史」一模一样，而两者后果相反：
 * 前者会让「连续零进展」停损永远数不到，后者是正常的起点。
 */
export function parseProgressHistoryDetail(raw) {
  if (Array.isArray(raw)) return { rounds: normalizeProgressHistory(raw), warnings: [] }
  const text = String(raw ?? '').trim()
  if (!text) return { rounds: [], warnings: [] }
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) return { rounds: normalizeProgressHistory(parsed), warnings: [] }
    if (parsed && typeof parsed === 'object') return { rounds: normalizeProgressHistory([parsed]), warnings: [] }
    return {
      rounds: [],
      warnings: [`--progress-history 解析出的不是数组或对象（${typeof parsed}），进度历史按空处理；零进展停损因此从本轮开始计`],
    }
  } catch (err) {
    return {
      rounds: [],
      warnings: [`--progress-history 不是合法 JSON（${err instanceof Error ? err.message : String(err)}），进度历史按空处理；零进展停损因此从本轮开始计`],
    }
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

/**
 * 归一化待拍板门禁：支持字符串与对象两种形态，识别 one-way / 高风险标记。
 *
 * 缺摘要的项**报出来但仍按原语义推进**：把它丢了，等于那道单向门凭空消失，
 * 停损也就少了一条能触发它的路径。报出而不改变结论，是既能看见、又不误伤的做法。
 */
export function normalizePendingGatesDetail(raw) {
  const items = parseJsonish(raw, [])
  const gates = []
  const warnings = []
  for (const [idx, item] of items.entries()) {
    if (!item) continue
    const rec = typeof item === 'string' ? { summary: item } : item
    if (!rec || typeof rec !== 'object') {
      warnings.push(`--pending-gates 第 ${idx + 1} 项不是字符串或对象，已跳过`)
      continue
    }
    const summary = String(rec.summary ?? rec.title ?? rec.reason ?? '').trim()
    const kindText = `${rec.kind ?? rec.type ?? rec.doorType ?? ''} ${summary}`
    const oneWay = Boolean(rec.oneWay || rec.oneWayGate || rec.highRisk) || ONE_WAY_MARKER_RE.test(kindText)
    if (!summary) {
      // 缺摘要的门禁项照样进列表：它的 oneWay 标记仍然有效，丢了就等于少一道门。
      warnings.push(`--pending-gates 第 ${idx + 1} 项没有摘要（summary/title/reason 都为空），已按「未命名门禁」保留${oneWay ? '，其单向门标记仍生效' : ''}`)
      gates.push({ id: String(rec.id ?? `gate-${gates.length + 1}`).trim(), summary: '(未命名门禁)', oneWay })
      continue
    }
    gates.push({ id: String(rec.id ?? `gate-${gates.length + 1}`).trim(), summary: summary.slice(0, 300), oneWay })
  }
  return { gates, warnings }
}

/** 归一化待拍板门禁：只取值，供不关心告警的调用方使用。 */
export function normalizePendingGates(raw) {
  return normalizePendingGatesDetail(raw).gates
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
 * 合并历史进度：保留既有多轮记录，并把本轮新增条目（未显式编号或单轮追加时）接续编号。
 */
export function mergeCycleHistory(prevRaw = [], incomingRaw = undefined) {
  const prev = normalizeProgressHistory(prevRaw)
  if (incomingRaw === undefined || incomingRaw === null || String(incomingRaw).trim() === '') {
    return { rawForPlan: prev, parseWarnings: [] }
  }
  const detail = parseProgressHistoryDetail(incomingRaw)
  const incomingItems = parseJsonish(incomingRaw, [])
  if (detail.warnings.length > 0) {
    return { rawForPlan: prev, parseWarnings: detail.warnings }
  }
  if (prev.length === 0) return { rawForPlan: detail.rounds, parseWarnings: [] }
  const maxPrevRound = prev.at(-1)?.round ?? prev.length
  const hasExplicitFullList = incomingItems.length > prev.length && incomingItems.every((it) => it && typeof it === 'object' && Number.isFinite(Number(it.round)))
  if (hasExplicitFullList) return { rawForPlan: detail.rounds, parseWarnings: [] }
  const appended = [...prev]
  for (const item of incomingItems) {
    if (item === null || item === undefined) continue
    const rec = typeof item === 'number' ? { advanced: item } : item
    if (!rec || typeof rec !== 'object') continue
    const explicitRound = Number(rec.round)
    const round = Number.isFinite(explicitRound) && explicitRound > appended.at(-1).round
      ? explicitRound
      : (appended.at(-1)?.round ?? maxPrevRound) + 1
    appended.push(...normalizeProgressHistory([{ ...rec, round }]))
  }
  return { rawForPlan: appended, parseWarnings: [] }
}

/** 合并已持久化与新增待拍板门禁，按 id/summary 去重并保留单向门标记。 */
export function mergeCycleGates(prevRaw = [], incomingRaw = undefined) {
  const prev = normalizePendingGates(prevRaw)
  if (incomingRaw === undefined || incomingRaw === null || String(incomingRaw).trim() === '') return prev
  const next = normalizePendingGates(incomingRaw)
  const byKey = new Map()
  for (const g of [...prev, ...next]) {
    const key = `${g.id}|${g.summary}`
    const existing = byKey.get(key)
    byKey.set(key, existing ? { ...existing, oneWay: existing.oneWay || g.oneWay } : g)
  }
  return [...byKey.values()]
}

/**
 * 构造有界循环编排结果。纯函数，不读盘不写盘，绝不修改任何源码。
 */
export function buildCyclePlan({ goal = '', maxRounds = DEFAULT_MAX_ROUNDS, progressHistory = [], pendingGates = [] } = {}) {
  const goalText = String(goal ?? '').trim()
  const roundsDetail = normalizeMaxRoundsDetail(maxRounds)
  const historyDetail = parseProgressHistoryDetail(progressHistory)
  const gatesDetail = normalizePendingGatesDetail(pendingGates)
  const rounds = roundsDetail.rounds
  const history = historyDetail.rounds
  const gates = gatesDetail.gates
  // 三个输入通道的丢弃、解析失败与截断都进报告：不静默。
  // 报出不改变原有语义——该停的照样停，该走的照样走。
  const warnings = [...roundsDetail.warnings, ...historyDetail.warnings, ...gatesDetail.warnings]
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
    history,
    roundProgress,
    pendingGates: gates,
    warnings,
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
  // 输入通道被丢弃、解析失败或截断，都写在这里。不静默。
  for (const w of plan.warnings ?? []) lines.push(`Warning  : ${w}`)
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
