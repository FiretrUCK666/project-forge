/**
 * injections-data-flow-explore.mjs —— flow start 引导 claim/explore 与 flow submit 探索门禁故障注入复验表（I240–I244）。
 *
 * 导出 `INJECTIONS_FLOW_EXPLORE` 供 `injections-data.mjs` 自动发现加载。
 */

export const INJECTIONS_FLOW_EXPLORE = [
  {
    id: 'I240',
    what: 'flow start Tier 2 [NEXT STEP] 漏掉 explore 引导',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: "      { skill: 'dev-flow', text: `2. 再执行 flow.mjs explore 记录探索证据：node \".agents/skills/dev-flow/scripts/flow.mjs\" explore --task ${taskId}` },\n      `3. 完成 claim 与 explore 后，在 ${implRel} 中推进实施、验证与提审（提交评审时将自动同步创建 ${reviewRel} 审查工作树）。`,",
    to: "      `在 ${implRel} 中推进实施；提交评审时将自动同步创建 ${reviewRel} 审查工作树。`,",
    expect: 'flow start [NEXT STEP] 在 Tier 2',
  },
  {
    id: 'I241',
    what: 'flow start Tier 1 [NEXT STEP] 退回仅提示 verify 而漏掉 claim 与 explore',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: "        { skill: 'dev-flow', text: `1. 先执行 flow.mjs claim 认领任务：node \".agents/skills/dev-flow/scripts/flow.mjs\" claim --task ${taskId}` },\n        { skill: 'dev-flow', text: `2. 再执行 flow.mjs explore 记录探索证据：node \".agents/skills/dev-flow/scripts/flow.mjs\" explore --task ${taskId}` },\n        { skill: 'dev-flow', text: `3. 完成 claim 与 explore 后推进实施，提交后运行：node \".agents/skills/dev-flow/scripts/flow.mjs\" verify --task ${taskId}` },",
    to: "        { skill: 'dev-flow', text: `node \".agents/skills/dev-flow/scripts/flow.mjs\" verify --task ${taskId}` },",
    expect: 'flow start [NEXT STEP] 在 Tier 2',
  },
  {
    id: 'I242',
    what: 'flow submit 跳过 hasExploredEvidence 前置硬阻断',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle.mjs'],
    from: "  if (ledger.role !== 'inbound-external-pr' && !isCase1LowRiskDoc && !hasExploredEvidence(ledger)) {",
    to: "  if (false && ledger.role !== 'inbound-external-pr' && !isCase1LowRiskDoc && !hasExploredEvidence(ledger)) {",
    expect: 'flow submit 前置校验 hasExploredEvidence',
  },
  {
    id: 'I243',
    what: 'flow submit 放宽 Case 1 豁免口径不再校验 policy.riskTier === low，导致改源码绕过探索门禁',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle.mjs'],
    from: "  const isCase1LowRiskDoc = Number(ledger.caseType) === 1 && policy.riskTier === 'low'",
    to: '  const isCase1LowRiskDoc = Number(ledger.caseType) === 1',
    expect: 'flow submit 前置校验 hasExploredEvidence',
  },
  {
    id: 'I244',
    what: 'flow submit 删除 Case 1 低风险纯文档豁免导致合规 Case 1 纯文档提交被误拦',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle.mjs'],
    from: "  const isCase1LowRiskDoc = Number(ledger.caseType) === 1 && policy.riskTier === 'low'",
    to: '  const isCase1LowRiskDoc = false',
    expect: 'flow submit 前置校验 hasExploredEvidence',
  },
]
