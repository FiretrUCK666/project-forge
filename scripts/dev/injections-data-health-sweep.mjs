/**
 * injections-data-health-sweep.mjs —— 全仓体检四项根因与热点门禁故障注入样本集（I951–I956）。
 */

export const INJECTIONS_HEALTH_SWEEP = [
  {
    id: 'I951',
    what: 'evaluateMasterIssueCloseGuard 在总控缺 issue 时不排除子切片 SPEC 工单',
    file: 'kit/skills/dev-flow/scripts/flow-merge-claim.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-merge-claim.mjs'],
    from: '    if (isSliceSpecIssue || isSliceTaskOwnIssue) return false',
    to: '    if (false && (isSliceSpecIssue || isSliceTaskOwnIssue)) return false',
    expect: '[HS-1]',
  },
  {
    id: 'I952',
    what: 'evaluateToolStaleness 在工作树无本槽位快照时跳过回退 main 基线',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: "  const mainFallback = (effSlot && effSlot !== 'main') ? cache.slots?.main?.[tool.id] : null",
    to: '  const mainFallback = null',
    expect: '[HS-2]',
  },
  {
    id: 'I953',
    what: 'review-context 把 unbaselined 工具重新混入 healthyTools',
    file: 'kit/skills/dev-review/scripts/review-context.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-context.mjs'],
    from: "  const healthyTools = toolChecks.filter((t) => t.staleness.status === 'fresh' || (t.staleness.status === 'stale' && t.tool.riskLevel === 'low'))",
    to: "  const healthyTools = toolChecks.filter((t) => t.staleness.status === 'fresh' || t.staleness.status === 'unbaselined' || (t.staleness.status === 'stale' && t.tool.riskLevel === 'low'))",
    expect: '[HS-2]',
  },
  {
    id: 'I954',
    what: 'syncVerifyCacheOnMerge 跳过 mainRoot 指纹一致性核验直接强行晋升',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: '      if (!matches) {',
    to: '      if (false && !matches) {',
    expect: '[HS-2]',
  },
  {
    id: 'I955',
    what: 'checkSliceGraphCycles 跳过自环 depends_on 拦截',
    file: 'kit/skills/lib/doc-slice-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-slice-graph.mjs'],
    from: '    if (node.dependsOn.includes(key)) {',
    to: '    if (false && node.dependsOn.includes(key)) {',
    expect: '[HS-3]',
  },
  {
    id: 'I956',
    what: 'evaluateThreeRoundStopLoss 跳过连续两轮重复阻塞停损判定',
    file: 'kit/skills/lib/critique-rounds.mjs',
    alsoDropIn: ['.agents/skills/lib/critique-rounds.mjs'],
    from: '  const repeatedTrigger = relRound >= 2 && repeatedItems.length > 0',
    to: '  const repeatedTrigger = false && relRound >= 2 && repeatedItems.length > 0',
    expect: '[HS-3]',
  },
  {
    id: 'I957',
    what: 'readVerifyCache 退回默认 512KB 上限导致多槽位 cache.json 超限被静默清零',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: '  const raw = readJsonSafe(p, 16 * 1024 * 1024)',
    to: '  const raw = readJsonSafe(p)',
    expect: '[HS-2]',
  },
]
