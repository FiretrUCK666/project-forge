/**
 * injections-data-conv-s2.mjs —— Slice 2 (`conversational-lifecycle-model`) 故障注入复验表（I921–I928）。
 */

export const INJECTIONS_CONV_S2 = [
  {
    id: 'I921',
    what: 'session-state boundTopicSize 退化为静默 FIFO 淘汰 facts 而非抛 BLOCKED_TOPIC_BUDGET_EXCEEDED',
    file: 'kit/skills/lib/session-state.mjs',
    from: "    err.code = 'BLOCKED_TOPIC_BUDGET_EXCEEDED'\n    err.exitCode = EXIT.FACT\n    throw err",
    to: '    const k0 = Object.keys(topicState.facts)[0]; if (k0) { delete topicState.facts[k0]; continue }\n    break',
    expect: 'Conv-S2 C5',
  },
  {
    id: 'I922',
    what: 'doc-plan-ops initDoc 绕过 open > 0 未拍板阻断门禁 BLOCKED_OPEN_QUESTIONS_UNRESOLVED',
    file: 'kit/skills/dev-plan/scripts/doc-plan-ops.mjs',
    from: '  if (unresolvedOpen.length > 0 && !allowOpenDraft) {',
    to: '  if (false && unresolvedOpen.length > 0 && !allowOpenDraft) {',
    expect: 'Conv-S2 C5',
  },
  {
    id: 'I923',
    what: 'doc-locate 未传 --topic 时仍偷偷写盘记录仓外锚点',
    file: 'kit/skills/dev-explore/scripts/doc-locate.mjs',
    from: '    if (cli.opts.topic) {\n      try {\n        const roots = await resolveRepoRoots(repoRoot)\n        const anchors = [...new Set([\n          ...(result.file ? [result.file] : []),\n          ...((result.slices ?? []).map((s) => s?.relPath ?? s?.file).filter(Boolean)),\n          ...((result.matches ?? []).map((m) => m?.relPath ?? m?.file).filter(Boolean)),\n        ].map((p) => posixPath(p)))]\n        if (anchors.length > 0) recordTopicAnchors(roots.mainRoot, { topic: cli.opts.topic, anchors })',
    to: "    if (cli.opts.topic || true) {\n      try {\n        const roots = await resolveRepoRoots(repoRoot)\n        const anchors = [...new Set([\n          ...(result.file ? [result.file] : []),\n          ...((result.slices ?? []).map((s) => s?.relPath ?? s?.file).filter(Boolean)),\n          ...((result.matches ?? []).map((m) => m?.relPath ?? m?.file).filter(Boolean)),\n        ].map((p) => posixPath(p)))]\n        if (anchors.length > 0) recordTopicAnchors(roots.mainRoot, { topic: cli.opts.topic || 'default', anchors })",
    expect: 'Conv-S2 C5',
  },
  {
    id: 'I924',
    what: 'clarifyDoc 对 LOCKED 已批准文档绕过 BLOCKED_DOC_FROZEN 冻结守卫',
    file: 'kit/skills/lib/doc-plan-clarify.mjs',
    from: '  if (!mut.mutable) {',
    to: '  if (false && !mut.mutable) {',
    expect: 'Conv-S2 C6',
  },
  {
    id: 'I925',
    what: 'doc-substantive checkDocRegression 跳过静默删减 C* 条目检测',
    file: 'kit/skills/lib/doc-substantive.mjs',
    from: '  if (baseCriteria > 0 && (curCriteria + newlyDroppedCount) < baseCriteria) {',
    to: '  if (false && baseCriteria > 0 && (curCriteria + newlyDroppedCount) < baseCriteria) {',
    expect: 'Conv-S2 C6',
  },
  {
    id: 'I926',
    what: 'flow rework 对 LOCKED 冻结任务放行直接返工而不阻断 BLOCKED_REWORK_REQUIRES_REOPEN',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs',
    from: '  if (!mut.mutable) {',
    to: '  if (false && !mut.mutable) {',
    expect: 'Conv-S2 C7 & C8',
  },
  {
    id: 'I927',
    what: 'flow rework --reopen 跳过原子撤销未消费 reviewTokens',
    file: 'kit/skills/lib/ledger.mjs',
    from: '  if (Array.isArray(ledger.reviewTokens)) {\n    ledger.reviewTokens = ledger.reviewTokens.map((tok) => {',
    to: '  if (false && Array.isArray(ledger.reviewTokens)) {\n    ledger.reviewTokens = ledger.reviewTokens.map((tok) => {',
    expect: 'Conv-S2 C7 & C8',
  },
  {
    id: 'I928',
    what: 'evaluateNextState ambiguous 不再过滤 LOCKED 任务导致冻结任务混入波次调度',
    file: 'kit/skills/lib/workflow-policy-next.mjs',
    from: '    const dispatchableActive = enrichedActive.filter((t) => inferCandidatePhaseAndMutability(t).mutable)',
    to: '    const dispatchableActive = enrichedActive',
    expect: 'Conv-S2 C7 & C8',
  },
]
