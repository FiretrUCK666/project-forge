/**
 * injections-data-r6b.mjs —— R6B（C5..C8）核心守卫故障注入表（I452–I455）。
 */

export const INJECTIONS_R6B = [
  {
    id: 'I452',
    what: 'C5 doc-plan-ops: 关闭 initDoc 按 slug/issue 防重门禁 BLOCKED_DUPLICATE_PLAN_DOC',
    file: 'kit/skills/dev-plan/scripts/doc-plan-ops.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/doc-plan-ops.mjs'],
    from: '  if (effectiveKind !== \'tdd\' && !force) {\n    const duplicates = findDuplicatePlanDocs(repoRoot, {',
    to: '  if (false && effectiveKind !== \'tdd\' && !force) {\n    const duplicates = findDuplicatePlanDocs(repoRoot, {',
    expect: 'R6B C5：唯一 plan-index 消除反向依赖、跨天异名拦截 BLOCKED_DUPLICATE_PLAN_DOC 及 session-orient 状态识别',
  },
  {
    id: 'I453',
    what: 'C6 doc-plan-ops: 破坏 approveSpec 原子联动激活配套 Todo 为 active',
    file: 'kit/skills/dev-plan/scripts/doc-plan-ops.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/doc-plan-ops.mjs'],
    from: '      if ([\'draft\', \'pending\'].includes(d.status)) {',
    to: '      if (false && [\'draft\', \'pending\'].includes(d.status)) {',
    expect: 'R6B C6 + A1：approveSpec 原子联动 Todo active、syncPlanDocBodyMeta 双向投影与 Case 3 自检直通',
  },
  {
    id: 'I454',
    what: 'C6 plan-index: 破坏 syncPlanDocBodyMeta 对正文当前状态表的同步更新',
    file: 'kit/skills/lib/plan-index.mjs',
    alsoDropIn: ['.agents/skills/lib/plan-index.mjs'],
    from: '    if (status && /^(?:当前状态|状态|Status)$/i.test(key)) {',
    to: '    if (false && status && /^(?:当前状态|状态|Status)$/i.test(key)) {',
    expect: 'R6B C6 + A1：approveSpec 原子联动 Todo active、syncPlanDocBodyMeta 双向投影与 Case 3 自检直通',
  },
  {
    id: 'I455',
    what: 'C8 doc-substantive: 破坏 DOC_REGRESSION_CRITERIA_DROPPED 验收条目缩水拦截',
    file: 'kit/skills/lib/doc-substantive.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-substantive.mjs'],
    from: '  if (baseCriteria > 0 && (curCriteria + newlyDroppedCount) < baseCriteria) {',
    to: '  if (false && baseCriteria > 0 && (curCriteria + newlyDroppedCount) < baseCriteria) {',
    expect: 'R6B C8：preInit 有界缓冲与自动吸收、triage 继承与 --kind all、audit 跳 critique-scope 及永恒客观底线',
  },
]
