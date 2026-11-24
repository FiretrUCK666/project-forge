/**
 * injections-data-plan-wave.mjs —— 双态规划、规划退场门禁、切片图校验与波次交接包的故障注入复验表（I250–I259）。
 *
 * 每条注入把一处判据改坏，然后要求对应夹具变红——证明那条判据真的在起作用，
 * 而不是写完就没人跑过。导出 `INJECTIONS_PLAN_WAVE` 供 `injections-data.mjs` 自动发现加载。
 */

export const INJECTIONS_PLAN_WAVE = [
  {
    id: 'I250',
    what: '默认规划态推导不再认单向门，把所有不可逆规划都放成自治推进',
    file: 'kit/skills/lib/pending-decisions.mjs',
    alsoDropIn: ['.agents/skills/lib/pending-decisions.mjs'],
    from: "  if (door === 'one-way') return 'interactive'",
    to: '  if (false) return \'interactive\'',
    expect: 'plan_mode 双态',
  },
  {
    id: 'I251',
    what: 'plan_mode 非法枚举静态校验被短路，写错的取值照常过关',
    file: 'kit/skills/lib/pending-decisions.mjs',
    alsoDropIn: ['.agents/skills/lib/pending-decisions.mjs'],
    from: '    if (isValidPlanMode(raw)) return []',
    to: '    return []',
    expect: 'plan_mode 双态',
  },
  {
    id: 'I252',
    what: '规划退场门禁在未就绪时改成不阻断（配置抬头不对就被当成通过）',
    file: 'kit/skills/lib/plan-exit-gate.mjs',
    alsoDropIn: ['.agents/skills/lib/plan-exit-gate.mjs'],
    from: '  return {\n    ok: false,\n    blocked: true,\n    applicable: true,',
    to: '  return {\n    ok: true,\n    blocked: false,\n    applicable: true,',
    expect: '规划退场门禁：Case 3/4',
  },
  {
    id: 'I253',
    what: '规划退场门禁不再检查待拍板事项是否清零',
    file: 'kit/skills/lib/plan-exit-gate.mjs',
    alsoDropIn: ['.agents/skills/lib/plan-exit-gate.mjs'],
    from: '  if (pending.found && pending.unresolved.length > 0) {',
    to: '  if (false && pending.found && pending.unresolved.length > 0) {',
    expect: '规划退场门禁：Case 3/4',
  },
  {
    id: 'I254',
    what: '把 Case 3 也按 Case 4 的过审判据卡，L2 没有 approve 就被判死',
    file: 'kit/skills/lib/plan-exit-gate.mjs',
    alsoDropIn: ['.agents/skills/lib/plan-exit-gate.mjs'],
    from: 'const APPROVAL_REQUIRED = Object.freeze({ 3: false, 4: true })',
    to: 'const APPROVAL_REQUIRED = Object.freeze({ 3: true, 4: true })',
    expect: '规划退场门禁：Case 3/4',
  },
  {
    id: 'I255',
    what: 'flow start 不再在 planGate 阻断时返回，门禁算完就地丢掉',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: '  if (planGate.blocked) {',
    to: '  if (false && planGate.blocked) {',
    expect: '规划退场门禁接入 flow start',
  },
  {
    id: 'I256',
    what: '总控 PRD 漏认领检查改成永远认为全覆盖',
    file: 'kit/skills/lib/doc-slice-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-slice-graph.mjs'],
    from: '    const missing = ids.filter((id) => !claimed.has(id))',
    to: '    const missing = []',
    expect: '切片图四检',
  },
  {
    id: 'I257',
    what: '依赖判环只看悬空，环本身漏报',
    file: 'kit/skills/lib/doc-slice-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-slice-graph.mjs'],
    from: '  if (pending.size > 0) {',
    to: '  if (false && pending.size > 0) {',
    expect: '切片图四检',
  },
  {
    id: 'I258',
    what: '同波次写域碰撞检查退化成「少于两片就跳过」，三片以上照旧漏判',
    file: 'kit/skills/lib/doc-slice-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-slice-graph.mjs'],
    from: '  if (nodes.length < 2) return out',
    to: '  if (nodes.length >= 0) return out',
    expect: '切片图四检',
  },
  {
    id: 'I259',
    what: 'batch plan 不再因 --handoff 生成交接包，就绪波次只给拓扑',
    file: 'kit/skills/dev-flow/scripts/flow-batch.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-batch.mjs'],
    from: '  if (opts.handoff) {',
    to: '  if (false && opts.handoff) {',
    expect: 'flow batch plan --handoff',
  },
]
