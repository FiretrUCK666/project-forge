/**
 * injections-data-policy-axes.mjs —— Wave 1 (`single-source-policy-core`) C1..C4 故障注入复验数据表（I971-I976）。
 */

export const INJECTIONS_POLICY_AXES = [
  {
    id: 'I971',
    what: 'C1 workflow-policy: isLow 漏排 effectiveVisual 导致视觉文档误跌入 low 免审档',
    file: 'kit/skills/lib/workflow-policy.mjs',
    alsoDropIn: ['.agents/skills/lib/workflow-policy.mjs'],
    from: '  const isLow = !isHigh\n    && effectiveVisual.length === 0\n    && files.length > 0',
    to: '  const isLow = !isHigh\n    && files.length > 0',
    expect: '[Policy-C1]',
  },
  {
    id: 'I972',
    what: 'C2 workflow-policy: 外环 validateVerificationEvidence 放开 inner:true 内环实证偷渡',
    file: 'kit/skills/lib/workflow-policy.mjs',
    alsoDropIn: ['.agents/skills/lib/workflow-policy.mjs'],
    from: '  if (!allowInner && (evidence.inner === true || hasInnerGate)) {',
    to: '  if (false && !allowInner && (evidence.inner === true || hasInnerGate)) {',
    expect: '[Policy-C2]',
  },
  {
    id: 'I973',
    what: 'C1 review-empirical: faultRequired 退回旧逻辑强制普通 medium 运行时改动做故障注入',
    file: 'kit/skills/dev-review/scripts/review-empirical.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-empirical.mjs'],
    from: '  const faultRequired = !isEmptyDiff && !isLowRiskPureDoc && Boolean(policy.faultInjectionRequired) && (runtimeTouched || smokeRequired) && !policy.smokeExplicitNone',
    to: '  const faultRequired = !isEmptyDiff && !isLowRiskPureDoc && (runtimeTouched || smokeRequired)',
    expect: '[Policy-C1]',
  },
  {
    id: 'I974',
    what: 'C3 gate-receipt: 放行脏工作树（dirty=true）伪造有效回执键并落盘',
    file: 'kit/skills/lib/gate-receipt.mjs',
    alsoDropIn: ['.agents/skills/lib/gate-receipt.mjs'],
    from: "  if (!workTreeRoot || dirty === true || !headSha || headSha === 'UNBORN') {",
    to: "  if (!workTreeRoot || !headSha || headSha === 'UNBORN') {",
    expect: '[Policy-C3]',
  },
  {
    id: 'I975',
    what: 'C4 flow-lifecycle-helpers: 沙箱/quick verify 失败绕过 shouldAutoEscalateFailure 仍自动刷远端工单',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs'],
    from: "  const escPolicy = shouldAutoEscalateFailure({ stage: 'verify', mode, ledger, opts })\n  let escalation = null\n  if (!escPolicy.escalate) {",
    to: "  const escPolicy = shouldAutoEscalateFailure({ stage: 'verify', mode, ledger, opts })\n  let escalation = null\n  if (false && !escPolicy.escalate) {",
    expect: '[Policy-C4]',
  },
  {
    id: 'I976',
    what: 'C4 review-empirical-state: local 审查失败绕过 shouldAutoEscalateFailure 仍自动刷远端工单',
    file: 'kit/skills/dev-review/scripts/review-empirical-state.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-empirical-state.mjs'],
    from: "  const escPolicy = shouldAutoEscalateFailure({ stage: 'review', mode, ledger: task, opts })\n  let escalation = null\n  if (!escPolicy.escalate) {",
    to: "  const escPolicy = shouldAutoEscalateFailure({ stage: 'review', mode, ledger: task, opts })\n  let escalation = null\n  if (false && !escPolicy.escalate) {",
    expect: '[Policy-C4]',
  },
]
