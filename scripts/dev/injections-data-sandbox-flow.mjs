/**
 * injections-data-sandbox-flow.mjs —— Wave 2 (`sandbox-dual-loop-flow`) C5..C8 故障注入复验数据表（I981-I986）。
 */

export const INJECTIONS_SANDBOX_FLOW = [
  {
    id: 'I981',
    what: 'C5 flow-sandbox: 绕过 BLOCKED_SANDBOX_PROMOTE_REQUIRED 允许未晋升沙箱直接 finalize/submit',
    file: 'kit/skills/dev-flow/scripts/flow-sandbox.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-sandbox.mjs'],
    from: "export function guardSandboxPreSubmitOrFinalize(ledger, opts = {}, stage = 'submit') {\n  if (ledger?.sandboxMode !== true) return { ok: true }",
    to: "export function guardSandboxPreSubmitOrFinalize(ledger, opts = {}, stage = 'submit') {\n  if (true || ledger?.sandboxMode !== true) return { ok: true }",
    expect: '[Sandbox-C5]',
  },
  {
    id: 'I982',
    what: 'C6 sandbox-scope: 放行重叠 writeScope 导致并行沙箱子代理写域冲突不被拦截',
    file: 'kit/skills/lib/sandbox-scope.mjs',
    alsoDropIn: ['.agents/skills/lib/sandbox-scope.mjs'],
    from: '  if (conflicts.length > 0) {\n    const desc = conflicts',
    to: '  if (false && conflicts.length > 0) {\n    const desc = conflicts',
    expect: '[Sandbox-C6]',
  },
  {
    id: 'I983',
    what: 'C6 ledger: collectImplementerHistory 漏聚合 implementers[] 导致并行子代理绕过自审与防自合',
    file: 'kit/skills/lib/ledger.mjs',
    alsoDropIn: ['.agents/skills/lib/ledger.mjs'],
    from: "  for (const imp of Array.isArray(ledger?.implementers) ? ledger.implementers : []) push(typeof imp === 'string' ? imp : imp?.actor)",
    to: '  // injected: skip implementers[] aggregation',
    expect: '[Sandbox-C6]',
  },
  {
    id: 'I984',
    what: 'C8 flow-lifecycle-hooks: 错误放宽外环 checkLifecyclePreconditions 的 claimedAt 拦截',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'],
    from: '  if (!innerVerify && caseNum >= 2 && Boolean(ledger.baseSha) && !ledger.claimedAt) {',
    to: '  if (false && !innerVerify && caseNum >= 2 && Boolean(ledger.baseSha) && !ledger.claimedAt) {',
    expect: '[Sandbox-C8]',
  },
  {
    id: 'I985',
    what: 'C7 flow-sandbox: promote 对 one-way/跨多域契约变更误放行 Case 3 原地晋升',
    file: 'kit/skills/dev-flow/scripts/flow-sandbox.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-sandbox.mjs'],
    from: "  const needsSpec = ((policy.oneWayBoundaryHits?.length ?? 0) > 0 || (coreDomains.length >= 3 && touchesContract) || Number(opts.case) === 4) && !approvedSpecRel",
    to: '  const needsSpec = false',
    expect: '[Sandbox-C7]',
  },
  {
    id: 'I986',
    what: 'C8 flow-lifecycle-finalize: finalize 重新传入 changedFiles 污染常青 docs/architecture-map.html',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle-finalize.mjs'],
    from: '      if (fmChanged) {\n        const archRes = await renderArchitectureMapAsync(implRoot)\n        if (archRes.ok && !archRes.optedOut && !archRes.skipped) pathsToStage.push(ARCHITECTURE_MAP_REL)\n      }',
    to: '      if (fmChanged) {\n        const archRes = await renderArchitectureMapAsync(implRoot, { changedFiles: changed })\n        if (archRes.ok && !archRes.optedOut && !archRes.skipped) pathsToStage.push(ARCHITECTURE_MAP_REL)\n      }',
    expect: '[Sandbox-C8]',
  },
]
