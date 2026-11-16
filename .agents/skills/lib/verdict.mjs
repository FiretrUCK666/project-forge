/**
 * verdict.mjs —— 三态结论：算出来了、算出来是坏的、根本算不出来。
 *
 * ## 它治的病
 *
 * 一条判据抛异常时，最省事的写法是 `catch` 里返回一个「什么都没有」的结果
 * （空数组、`false`、`null`）。那个形状与「查过了，没问题」**长得一模一样**，
 * 于是上层把「算不出来」读成「都通过了」，报出来的是一句盖章。
 *
 * 实测就是这么坏掉的：`compose-agents --check` 退出码 2（模板渲染崩了）的同一时刻，
 * `review` 报的是「AGENTS.md 已就绪，结构也完整」。错误被存进 `health.error`，
 * 全仓没有任何一处读过它。
 *
 * ## 为什么是三态，不是「加一个布尔」
 *
 * 布尔只有「好」和「坏」。而这一层的第三种情况——**算不出来**——既不是好也不是坏：
 * 它是「这条判据这次没有发言」。把它折叠进任何一边都是错的：
 * 折叠进「坏」会让模板偶发失败挡住整次交付；折叠进「好」就是上面那场事故。
 *
 * 所以结论只有三种状态，且**只有一种叫 ok**。`catch` 分支永远拿不到 ok，
 * 这条约束由门禁的静态断言看守（见开发侧契约检查）。
 */

/** 结论的全部状态。加一种就要同时改这里的构造器与静态断言。 */
export const VERDICT_STATES = Object.freeze(['ok', 'failed', 'unavailable'])

function normalizeFindings(findings) {
  if (findings === undefined || findings === null) return []
  return Array.isArray(findings) ? findings.filter(Boolean) : [findings]
}

/** 算出来了，而且没问题。 */
export function okVerdict(findings = []) {
  return { state: 'ok', findings: normalizeFindings(findings), error: null }
}

/**
 * 算出来了，有问题。
 *
 * `findings` 里至少得有一条：一条「失败了但说不出失败在哪」的结论，读的人
 * 除了焦虑什么都拿不到，而它看起来和「有一条具体问题」一样。
 */
export function failedVerdict(findings) {
  const list = normalizeFindings(findings)
  if (list.length === 0) {
    throw new Error('failedVerdict 需要至少一条具体问题：说不出失败在哪的「失败」不是结论')
  }
  return { state: 'failed', findings: list, error: null }
}

/**
 * 算不出来。
 *
 * **这是 `catch` 分支唯一合法的返回值。** `reason` 必填且不允许空串：
 * 「这一面算不出来」必须带上原因，否则上层只能把它当成一句无信息量的抱怨，
 * 而它其实是「这次没有发言」——那两件事对读者的处置完全不同。
 */
export function unavailableVerdict(reason) {
  const text = String(reason ?? '').trim()
  if (!text) {
    throw new Error('unavailableVerdict 需要一条原因：不写原因的「算不出来」无法被处置')
  }
  return { state: 'unavailable', findings: [], error: text }
}

/** 把任意异常收成 `unavailable`。`context` 会拼进原因，说明是哪一面崩的。 */
export function verdictFromError(error, context = '') {
  const detail = error instanceof Error ? error.message : String(error)
  const prefix = String(context ?? '').trim()
  return unavailableVerdict(prefix ? `${prefix}：${detail}` : detail)
}

/** 这条结论算出来了、而且没问题吗。`unavailable` 一律不是 ok。 */
export function isOk(verdict) {
  return Boolean(verdict) && verdict.state === 'ok'
}

/** 这条结论需要人看着处置吗（失败，或根本没算出来）。 */
export function needsAttention(verdict) {
  return Boolean(verdict) && verdict.state !== 'ok'
}

/**
 * 把多条结论并成一条：任何一条不是 ok，合并结果就不是 ok。
 *
 * 优先级取「最需要处置」的那一档：`failed` 压过 `unavailable`
 * （能指出的问题比算不出来的问题更好处置）。
 */
export function mergeVerdicts(verdicts) {
  const list = (verdicts ?? []).filter(Boolean)
  const failed = list.filter((v) => v.state === 'failed')
  const unknown = list.filter((v) => v.state === 'unavailable')
  if (failed.length > 0) {
    return failedVerdict([
      ...failed.flatMap((v) => v.findings ?? []),
      ...unknown.map((v) => ({ note: `这一面算不出来：${v.error}` })),
    ])
  }
  if (unknown.length > 0) {
    return unavailableVerdict(unknown.map((v) => v.error).join('；'))
  }
  return okVerdict(list.flatMap((v) => v.findings ?? []))
}

/**
 * 给报告层用的一句话。`ok` 后面跟原因的那半句由调用方写在自己那行文案里，
 * 这里只负责把「算不出来」翻译成人能处置的说法。
 */
export function verdictLabel(verdict) {
  if (!verdict) return '没有结论'
  if (verdict.state === 'ok') return '通过'
  if (verdict.state === 'failed') return `不通过（${verdict.findings.length} 条问题）`
  return `算不出来（${verdict.error}）`
}
