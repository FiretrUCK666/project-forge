/**
 * injections-data-flow-explore.mjs —— flow start 引导 claim/explore 与 flow submit 探索门禁故障注入复验表（I240–I244）。
 *
 * 导出 `INJECTIONS_FLOW_EXPLORE` 供 `injections-data.mjs` 自动发现加载。
 */

export const INJECTIONS_FLOW_EXPLORE = [
  {
    id: 'I240',
    what: 'flow start Tier 2 [NEXT STEP] 漏掉 claim 引导',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: "      : [\n          { skill: 'dev-flow', text: `1. 先执行 flow.mjs claim 认领任务：node \".agents/skills/dev-flow/scripts/flow.mjs\" claim --task ${taskId}` },\n          `2. 在 ${implRel} 中推进实施、验证与提审（提交评审时将自动同步创建 ${reviewRel} 审查工作树）。`,\n        ]",
    to: "      : [\n          `在 ${implRel} 中推进实施；提交评审时将自动同步创建 ${reviewRel} 审查工作树。`,\n        ]",
    expect: 'flow start [NEXT STEP] 在 Tier 2',
  },
  {
    id: 'I241',
    what: 'flow start Tier 1 [NEXT STEP] 退回仅提示 verify 而漏掉 claim',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: "        : [\n            { skill: 'dev-flow', text: `1. 执行 flow.mjs claim 认领任务：node \".agents/skills/dev-flow/scripts/flow.mjs\" claim --task ${taskId}` },\n            { skill: 'dev-flow', text: `2. 完成实施并提交后运行：node \".agents/skills/dev-flow/scripts/flow.mjs\" verify --task ${taskId}` },\n          ]",
    to: "        : [\n            { skill: 'dev-flow', text: `node \".agents/skills/dev-flow/scripts/flow.mjs\" verify --task ${taskId}` },\n          ]",
    expect: 'flow start [NEXT STEP] 在 Tier 2',
  },
  {
    id: 'I242',
    what: 'flow start Tier 2 跳过自动填充 explored 证据',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: "    status: isPlanning ? 'planning' : 'started',\n    planning: isPlanning,\n    explored: autoExplored,",
    to: "    status: isPlanning ? 'planning' : 'started',\n    planning: isPlanning,\n    explored: null,",
    expect: 'flow start [NEXT STEP] 在 Tier 2',
  },
  {
    id: 'I243',
    what: 'flow start Tier 1 跳过自动填充 explored 证据',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: "      status: isPlanning ? 'planning' : 'started',\n      planning: isPlanning,\n      explored: autoExplored,",
    to: "      status: isPlanning ? 'planning' : 'started',\n      planning: isPlanning,\n      explored: null,",
    expect: 'flow start [NEXT STEP] 在 Tier 2',
  },
  {
    id: 'I244',
    what: 'flow submit 跳过 planning 阶段阻断门禁',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle.mjs'],
    from: "  if (ledger.planning === true || ledger.status === 'planning') {",
    to: "  if (false && (ledger.planning === true || ledger.status === 'planning')) {",
    expect: 'flow submit 前置校验',
  },
]
