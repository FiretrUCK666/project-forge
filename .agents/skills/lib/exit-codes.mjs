/**
 * exit-codes.mjs —— 退出码四档语义与「阻断码 -> 档位」的唯一登记处。
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
 * 新增阻断码必须在这里登记档位——没登记的码拿不到档位，`blockedExitOf` 会返回 `null`。
 * 登记表与实际返回不一致这件事由本仓门禁按源码扫描核对，不靠人工维护第二份清单。
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
 * 档 1（有事要处理但可继续）：文件找不到、分支不在、清单需要同步——这一次没做成，
 * 但下一步很清楚，不需要谁先做决定。
 *
 * 档 2（用法问题）：命令本身写错了——参数值非法、身份没给、批准入口用错。
 * 这类情况改命令就能过，所以绝不能与「事还没做」混在一档。
 *
 * 档 3（前提事实不成立）：命令没错，是「该做的事还没做出来」——令牌没签、稿子没改、
 * 上一轮没换人、远端还没合、证据还太薄。
 *
 * 档 4（只有人能拍）：停损升级、弱化门禁放行、高风险签字。它们不是「你还有件事没做」，
 * 而是「这轮判断已经转不出来，得有人定」。
 */
const ACTION_CODES = Object.freeze([
  'BLOCKED_FEATURE_MAP_SYNC',
  'BLOCKED_TDD_SYNC',
  'BRANCH_NOT_FOUND',
  'FILE_NOT_FOUND',
  'FILE_UNREADABLE',
  'PLAN_CRITIQUE_PERSIST_FAILED',
])

const USAGE_CODES = Object.freeze([
  'BLOCKED_APPROVAL_HAS_SINGLE_ENTRY',
  'BLOCKED_ASCII_CONTROL_CHAR',
  'BLOCKED_CONFLICTING_ISSUE_FLAGS',
  'BLOCKED_INTERACTIVE_CLARIFY_USER_REQUIRED',
  'BLOCKED_MISSING_ACTOR',
  'BLOCKED_SHALLOW_OVERRIDE_REASON',
  'INVALID_OWNER',
  'MISSING_CONTINUE_REASON',
  'MISSING_HUMAN_APPROVAL',
  'MISSING_NO_ESCALATE_REASON',
  'MISSING_OVERRIDE_REASON',
  'MISSING_REVIEWER',
  'OWNER_CHANGE_REASON_REQUIRED',
])

const FACT_CODES = Object.freeze([
  'BLOCKED_AUTHOR_IS_IMPLEMENTER',
  'BLOCKED_CLEANUP_PREVIEW_MISMATCH',
  'BLOCKED_CRITIQUE_REQUIRED',
  'BLOCKED_CRITIQUE_ROUND_GAP',
  'BLOCKED_CRITIQUE_STALE',
  'BLOCKED_CRITIQUE_SAME_REVIEWER',
  'BLOCKED_CRITIQUE_SAME_SHA',
  'BLOCKED_CROSS_REPO_CWD_MISMATCH',
  'BLOCKED_DIRTY_FAULT_RESIDUE',
  'BLOCKED_DIRTY_MAIN',
  'BLOCKED_DIRTY_WORKTREE',
  'BLOCKED_DUPLICATE_PLAN_DOC',
  'BLOCKED_DUPLICATE_PR_FOR_LINKED_ISSUE',
  'BLOCKED_E2E_OBSERVATION_REQUIRED',
  'BLOCKED_EDIT_GATE_FAILED',
  'BLOCKED_EMPIRICAL_CMD_REQUIRED',
  'BLOCKED_EMPIRICAL_FAILED',
  'BLOCKED_EMPIRICAL_FIRST',
  'BLOCKED_FAULT_INJECTION_NOOP',
  'BLOCKED_FAULT_NOT_CAUGHT',
  'BLOCKED_FAULT_NO_MUTATION',
  'BLOCKED_FORGE_HOOK_FAILED',
  'BLOCKED_FORK_CANNOT_MERGE',
  'BLOCKED_GENERIC_REMOTE_MR_REQUIRED',
  'BLOCKED_GOVERN_HOOK_FAILED',
  'BLOCKED_HUMAN_MERGE_AUTHORITY',
  'BLOCKED_INSUFFICIENT_VERIFICATION_TIER',
  'BLOCKED_ISSUE_ALREADY_CLAIMED',
  'BLOCKED_ISSUE_QUALITY_INCOMPLETE',
  'BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED',
  'BLOCKED_MAIN_SLOT_VIOLATION',
  'BLOCKED_MALFORMED_MARKDOWN_BODY',
  'BLOCKED_MASTER_PRD_CRITIQUE_UNREADY',
  'BLOCKED_MERGE_STATE_UNVERIFIED',
  'BLOCKED_MISSING_DEFAULT_BRANCH',
  'BLOCKED_MISSING_ISSUE_BINDING',
  'BLOCKED_MISSING_TOOL_SCRIPT',
  'BLOCKED_NON_BLOCKING_REJECT',
  'BLOCKED_NOT_CLAIMED',
  'BLOCKED_NOT_VERIFIED',
  'BLOCKED_OUT_OF_SCOPE_CRITIQUE',
  'BLOCKED_OUT_OF_SCOPE_MUST_FIX',
  'BLOCKED_OVERLAPPING_SLICE_FILES',
  'BLOCKED_PASS_WITH_OPEN_BLOCKERS',
  'BLOCKED_PLAN_NOT_READY',
  'BLOCKED_PROVENANCE_TAMPERED',
  'BLOCKED_REMOTE_NOT_MERGED',
  'BLOCKED_REQUIRES_DEV_REVIEW',
  'BLOCKED_REQUIRES_INDEPENDENT_REVIEW',
  'BLOCKED_REVIEW_NOT_PASSED',
  'BLOCKED_REVIEW_TOKEN_BINDING',
  'BLOCKED_ROLE_CANNOT_MERGE',
  'BLOCKED_SAME_HEAD_REREVIEW',
  'BLOCKED_SCRATCH_SOURCE_MISSING',
  'BLOCKED_SCRATCH_SOURCE_OUTSIDE_SANDBOX',
  'BLOCKED_SELF_MERGE',
  'BLOCKED_SHALLOW_E2E_EVIDENCE',
  'BLOCKED_SKIP_EDIT_GATE_FORBIDDEN_ON_FINAL',
  'BLOCKED_SLOT_STALE_VERIFY',
  'BLOCKED_STACK_PARENT_UNMERGED',
  'BLOCKED_STALE_VERIFICATION',
  'BLOCKED_STATIC_DOC_CHECK_FAILED',
  'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH',
  'BLOCKED_SYNC_REBASE_CONFLICT',
  'BLOCKED_TAKEOVER_REASON_REQUIRED',
  'BLOCKED_TRIAL_MERGER_REQUIRED',
  'BLOCKED_TRIAL_MERGE_CONFLICT',
  'BLOCKED_TRIAL_MERGE_VERIFY_FAILED',
  'BLOCKED_TRIAGE_DOWNGRADE',
  'BLOCKED_UI_ARTIFACT_REQUIRED',
  'BLOCKED_UNCLAIMED_TASK',
  'BLOCKED_UNEXPLORED_TASK',
  'BLOCKED_UNMERGED_BRANCH_DELETE',
  'BLOCKED_UNRESOLVED_DEPENDENCY',
  'BLOCKED_UNSAFE_FORGE_HOOK',
  'BLOCKED_UNTRUSTED_HAZARD',
  'BLOCKED_UNTRUSTED_PR_UNSCANNED',
  'BLOCKED_VISUAL_EVIDENCE_REQUIRED',
  'SELF_CRITIQUE_REJECTED',
])

const HUMAN_CODES = Object.freeze([
  'BLOCKED_GATE_WEAKENING',
  'BLOCKED_HIGH_RISK_HUMAN_APPROVAL',
  'BLOCKED_STOP_LOSS_ESCALATE',
  'BLOCKED_STOP_LOSS_REASON_REQUIRED',
  'STOP_LOSS_ESCALATE',
])

export const BLOCK_CODE_TIERS = Object.freeze({
  ...Object.fromEntries(ACTION_CODES.map((c) => [c, EXIT.ACTION])),
  ...Object.fromEntries(USAGE_CODES.map((c) => [c, EXIT.USAGE])),
  ...Object.fromEntries(FACT_CODES.map((c) => [c, EXIT.FACT])),
  ...Object.fromEntries(HUMAN_CODES.map((c) => [c, EXIT.HUMAN])),
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
