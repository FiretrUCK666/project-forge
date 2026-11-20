/**
 * exit-codes.mjs —— 退出码四档语义与「阻断码 → 档位」的唯一登记处。
 *
 * ## 它治的是什么
 *
 * 同一个退出码 `2` 在不同脚本里表达了四件互不相干的事：传错了参数、前提还没做出来、
 * 策略不允许、要去问人。人（和读输出的模型）看到 `2` 只能靠上下文猜；猜错的代价不是
 * 重试一次，而是**去做一件本来根本不用做的事**。
 *
 * 最典型的症状：一条「令牌还没签发」的判定返回 `2`，调用方读成「参数写错了」，
 * 于是换个参数再来一次——真正该做的是先把令牌签出来。
 *
 * 所以档位只在这里定义，所有产出退出码的地方引用它，不再各写各的字面量。
 *
 * ## 四档语义
 *
 * - `0` 通过；
 * - `1` 有事要处理但可以继续；
 * - `2` **用法问题**：命令写错了，改命令就能过；
 * - `3` **前提事实不成立**：命令没写错，是那件事还没做出来；
 * - `4` **只能由人类拍板**。
 *
 * `2` 与 `3` 的分界是这张表里最要紧的一条线：把「事还没做」判成「命令写错了」，
 * 人就会去改命令；把「命令写错了」判成「事还没做」，人就会去做一件不需要做的事。
 *
 * ## 通则而非清单
 *
 * 判据是「凡前提事实不成立一律归中间档」，`BLOCK_CODE_TIERS` 是它的落地结果。
 * 新增阻断码必须在这里登记档位——没登记的码拿不到档位，`blockedExitOf` 会返回 `null`
 * 让调用方自己看见「这个码还没定档」，而不是悄悄落进某个默认值。
 */

/** 四档语义常量。任何产出退出码的位置引用这里，不再写字面量。 */
export const EXIT = Object.freeze({
  OK: 0,
  ACTION: 1,
  USAGE: 2,
  FACT: 3,
  HUMAN: 4,
})

/**
 * 交棒清理的四态退出码。
 *
 * 它和上面四档**不是同一根轴**：那根轴说「这次为什么没过」，这根轴说「源分支上还有
 * 没有东西」。两套词汇并列声明在一个文件里，是为了让读的人一眼看见「这两个数字不通用」；
 * 混用会出现「把没扫全读成有痕迹」这种后果不可逆的误判。
 */
export const VERIFY_EXIT = Object.freeze({
  clean: 0,
  dirty: 1,
  truncated: 3,
  notApplicable: 4,
})

/**
 * 阻断码到档位的登记表。
 *
 * 用法类：命令本身写错了（缺参数、值非法、身份没给），改命令即可。
 * 事实类：命令没错，是「该做的事还没做出来」——令牌没签、稿子没改、上一轮没换人。
 */
const USAGE_CODES = Object.freeze([
  'BLOCKED_ACK_MISSING_REASON',
  'BLOCKED_ACK_REQUIRES_TASK',
  'BLOCKED_MISSING_IMPLEMENTER',
  'BLOCKED_MISSING_REVIEW_EVIDENCE',
  'INVALID_DISPOSITION',
  'MISSING_REVIEWER',
  'MISSING_HUMAN_APPROVAL',
  'MISSING_OVERRIDE_REASON',
])

const FACT_CODES = Object.freeze([
  'BLOCKED_REVIEW_TOKEN',
  'UNKNOWN_REVIEW_TOKEN',
  'REVIEW_TOKEN_ROUND_MISMATCH',
  'REVIEW_TOKEN_ALREADY_CONSUMED',
  'BLOCKED_SAME_HEAD_REREVIEW',
  'BLOCKED_SAME_REVIEWER_REREVIEW',
  'BLOCKED_CRITIQUE_SAME_REVIEWER',
  'BLOCKED_CRITIQUE_SAME_SHA',
  'BLOCKED_NO_REWORK_CHANGES',
  'BLOCKED_OUT_OF_SCOPE_MUST_FIX',
  'BLOCKED_PASS_WITH_OPEN_BLOCKERS',
  'SELF_CRITIQUE_REJECTED',
  'SELF_REVIEW_REJECTED',
  'BLOCKED_CRITIQUE_REQUIRED',
  'BLOCKED_CRITIQUE_STALE',
  'CRITIQUE_REJECTED',
  'STOP_LOSS_ESCALATE',
])

export const BLOCK_CODE_TIERS = Object.freeze({
  ...Object.fromEntries(USAGE_CODES.map((c) => [c, EXIT.USAGE])),
  ...Object.fromEntries(FACT_CODES.map((c) => [c, EXIT.FACT])),
})

/** 已登记的阻断码清单，供机械检查核对「新增阻断码有没有登记档位」。 */
export const REGISTERED_BLOCK_CODES = Object.freeze(Object.keys(BLOCK_CODE_TIERS).sort())

/**
 * 查一个阻断码的档位。
 *
 * 未登记的码返回 `null` 而不是某个默认档：让它显形，调用方才有机会看见
 * 「这个码还没定档」。悄悄给个默认值，等于把「没登记」这件事永远藏起来。
 */
export function blockedExitOf(code) {
  const key = String(code ?? '').trim()
  if (!key) return null
  return Object.prototype.hasOwnProperty.call(BLOCK_CODE_TIERS, key) ? BLOCK_CODE_TIERS[key] : null
}

/** 已登记的阻断码走登记档位；未登记时按「前提事实不成立」处置并标记出来。 */
export function exitCodeForBlocked(code) {
  const tier = blockedExitOf(code)
  return tier === null ? EXIT.FACT : tier
}

/** 人类裁决一律最高档：它不是「哪里写错了」，是「这件事只有人拍得下来」。 */
export function exitCodeForHuman(code = 'HUMAN_DECISION_REQUIRED') {
  return { code, exitCode: EXIT.HUMAN }
}
