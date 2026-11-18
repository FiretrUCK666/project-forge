/**
 * injections-data-stageb.mjs —— Stage B B4b/C19 故障注入复验数据表（I173）。
 */

export const INJECTIONS_STAGEB = [
  {
    id: 'I173',
    what: 'evaluateMasterPrdClosureState 最后一片未勾选总控 PRD 时漏拦截 BLOCKED_LAST_SLICE_MASTER_PRD_UNCLOSED',
    file: 'kit/skills/lib/doc-substantive.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-substantive.mjs'],
    from: "  if (uncheckedCriteria.length > 0) {\n    return {\n      ...base,\n      state: 'blocked-unclosed',",
    to: "  if (false && uncheckedCriteria.length > 0) {\n    return {\n      ...base,\n      state: 'blocked-unclosed',",
    expect: 'C19：总控 PRD 四态闭环（手动/活跃、未覆盖保持 active、最后一片全勾自动归档及并行重跑幂等、未闭环拦截）',
  },
]
