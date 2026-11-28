/**
 * injections-data-r6c.mjs —— R6C 切片核心门禁与单源口径故障注入数据。
 */

export const INJECTIONS_R6C = [
  {
    id: 'I500',
    what: 'C11 review-gates.mjs 退回使用 split("\\n").length 误判 800 行文件为 801 行',
    file: 'kit/skills/dev-review/scripts/review-gates.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-gates.mjs'],
    from: '    const fullLineCount = fullText ? countTextLines(fullText) : 0',
    to: "    const fullLineCount = fullText ? fullText.split('\\n').length : 0",
    expect: '[C11]',
  },
  {
    id: 'I501',
    what: 'C11 edit-gate.mjs 忽略 reviewWorktreePath 与兄弟归档联动放行',
    file: 'kit/skills/dev-edit/scripts/edit-gate.mjs',
    alsoDropIn: ['.agents/skills/dev-edit/scripts/edit-gate.mjs'],
    from: '      taskLedger = allLedgers.find((l) => (wtRel && (l.worktreePath === wtRel || l.reviewWorktreePath === wtRel)) || (br && l.branch === br)) ?? null',
    to: '      taskLedger = allLedgers.find((l) => (wtRel && l.worktreePath === wtRel) || (br && l.branch === br)) ?? null',
    expect: '[C11]',
  },
  {
    id: 'I502',
    what: 'A2 iterate.mjs run 将静默默认错误改回默认自动建单',
    file: 'kit/skills/dev-iterate/scripts/iterate.mjs',
    alsoDropIn: ['.agents/skills/dev-iterate/scripts/iterate.mjs'],
    from: "      escalate: shouldAutoEscalateFailure({ stage: 'iterate', mode: 'run', ledger: runtimeOpts._ledger ?? null, opts }).escalate,",
    to: "      escalate: opts['no-escalate'] ? false : true,",
    expect: '[C10+A2]',
  },
  {
    id: 'I503',
    what: 'C12 review-ledger.mjs Round 3 停损解锁跳过非空 --reason 校验',
    file: 'kit/skills/dev-review/scripts/review-ledger.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-ledger.mjs'],
    from: '  if (slPre.stopLoss && humanApprovedNow && !baseLedger.humanApprovedStopLoss && !stopLossReason) {',
    to: '  if (false && slPre.stopLoss && humanApprovedNow && !baseLedger.humanApprovedStopLoss && !stopLossReason) {',
    expect: '[C12]',
  },
]
