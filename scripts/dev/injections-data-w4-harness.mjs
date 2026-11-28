/**
 * injections-data-w4-harness.mjs —— W4A Harness 硬门禁双向故障注入样本集（I398–I409）。
 *
 * 覆盖 C1–C4 新增核心原语与门禁：
 *   I398-I400 (C1): harness-context 调度身份禁冒充、主仓槽位边界、作者/实施者分离
 *   I401-I404 (C2): session-state 降档拦截、plan-exit-gate bound===0 阻断、doc-slice-graph 多切片自动识别、doc-substantive 核心节无技术锚点拦截
 *   I405-I408 (C3): DEFAULT_ENFORCE_GATES、cleanup previewHash 校验、isSafeBranchDelete、hasExecutableCodeMutation
 *   I409      (C4): verify-state per-slot 缓存回收
 */

export const INJECTIONS_W4_HARNESS = [
  {
    id: 'I398',
    what: 'C1 harness-context: resolveNonEmptyActor allowCoordinator=false 时放行 coordinator 代理名冒充实施/审查者',
    file: 'kit/skills/lib/harness-context.mjs',
    alsoDropIn: ['.agents/skills/lib/harness-context.mjs'],
    from: "    if (!allowCoordinator && isCoordinatorActor(actor)) {",
    to: "    if (false && !allowCoordinator && isCoordinatorActor(actor)) {",
    expect: '[C1] harness-context:',
  },
  {
    id: 'I399',
    what: 'C1 harness-context: enforceSlotBoundary 跳过 Case >= 2 脏主仓 BLOCKED_DIRTY_MAIN 硬拦截',
    file: 'kit/skills/lib/harness-context.mjs',
    alsoDropIn: ['.agents/skills/lib/harness-context.mjs'],
    from: "  if (caseNum >= 2 && hasCommits && isDirtyMain) {",
    to: "  if (false && caseNum >= 2 && hasCommits && isDirtyMain) {",
    expect: '[C1] harness-context:',
  },
  {
    id: 'I400',
    what: 'C1 harness-context: checkAuthorIsNotImplementer 绕过规划作者与实施者同体分离拦截',
    file: 'kit/skills/lib/harness-context.mjs',
    alsoDropIn: ['.agents/skills/lib/harness-context.mjs'],
    from: "  const matched = authors.find((a) => isValidActorName(a) && normOwnerId(a) === implNorm)",
    to: "  const matched = null && authors.find((a) => isValidActorName(a) && normOwnerId(a) === implNorm)",
    expect: '[C1] harness-context:',
  },
  {
    id: 'I401',
    what: 'C2 session-state: checkTriageDowngrade 放行无 --reason 的静默分流降档',
    file: 'kit/skills/lib/session-state.mjs',
    alsoDropIn: ['.agents/skills/lib/session-state.mjs'],
    from: "  if (nextNum < prevNum && !String(reason ?? '').trim()) {",
    to: "  if (false && nextNum < prevNum && !String(reason ?? '').trim()) {",
    expect: '[C2] session-state S1-S4',
  },
  {
    id: 'I402',
    what: 'C2 plan-exit-gate: Case >= 3 未绑定任何规划文档 (bound.length === 0) 时退化为只警告放行',
    file: 'kit/skills/lib/plan-exit-gate.mjs',
    alsoDropIn: ['.agents/skills/lib/plan-exit-gate.mjs'],
    from: "  if (bound.length === 0) {\n    if (allowBootstrap) {",
    to: "  if (false && bound.length === 0) {\n    if (allowBootstrap) {",
    expect: '[C2] plan-exit-gate bound.length===0',
  },
  {
    id: 'I403',
    what: 'C2 doc-slice-graph: buildSliceGraph 仅认 multi_spec: true 漏掉多切片 related_prd 自动识别',
    file: 'kit/skills/lib/doc-slice-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-slice-graph.mjs'],
    from: "    && (d.data?.multi_spec === true || (prdRefCounts.get(d.rel) ?? 0) >= 2))",
    to: "    && d.data?.multi_spec === true)",
    expect: '[C2] plan-exit-gate bound.length===0',
  },
  {
    id: 'I404',
    what: 'C2 doc-substantive: 核心节（goal/design/non-goals）在无套话关键词时跳过技术锚点强检',
    file: 'kit/skills/lib/doc-substantive.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-substantive.mjs'],
    from: "    if (!hasAngles && (id === 'goal' || id === 'design' || id === 'non-goals' || VAGUE_FLUFF_RE.test(cleaned))) {",
    to: "    if (!hasAngles && VAGUE_FLUFF_RE.test(cleaned)) {",
    expect: '[C2] --skip-critique-reason',
  },
  {
    id: 'I405',
    what: 'C3 gate-enforcement: DEFAULT_ENFORCE_GATES 默认开关退化为 false 放行未门禁通过的 pass 记录',
    file: 'kit/skills/lib/gate-enforcement.mjs',
    alsoDropIn: ['.agents/skills/lib/gate-enforcement.mjs'],
    from: "export const DEFAULT_ENFORCE_GATES = true",
    to: "export const DEFAULT_ENFORCE_GATES = false",
    expect: '[C3] evaluatePassBlockers 默认 enforceGates=true',
  },
  {
    id: 'I406',
    what: 'C3 gate-enforcement: verifyCleanupPreviewHash 放行指纹不匹配的删除确认',
    file: 'kit/skills/lib/gate-enforcement.mjs',
    alsoDropIn: ['.agents/skills/lib/gate-enforcement.mjs'],
    from: "  if (exp !== got) {\n    return {",
    to: "  if (false && exp !== got) {\n    return {",
    expect: '[C3] edit-gate 禁降级',
  },
  {
    id: 'I407',
    what: 'C3 gate-enforcement: isSafeBranchDelete 跳过未合并检测允许盲目删未合分支',
    file: 'kit/skills/lib/gate-enforcement.mjs',
    alsoDropIn: ['.agents/skills/lib/gate-enforcement.mjs'],
    from: "  return {\n    safe: false,\n    code: 'BLOCKED_UNMERGED_BRANCH_DELETE',",
    to: "  return {\n    safe: true,\n    code: 'BLOCKED_UNMERGED_BRANCH_DELETE',",
    expect: '[C3] edit-gate 禁降级',
  },
  {
    id: 'I408',
    what: 'C3 gate-enforcement: hasExecutableCodeMutation 对纯注释/空白 diff 误判为有效故障注入',
    file: 'kit/skills/lib/gate-enforcement.mjs',
    alsoDropIn: ['.agents/skills/lib/gate-enforcement.mjs'],
    from: "  return { hasMutation: changedCodeLines > 0, changedCodeLines }",
    to: "  return { hasMutation: true, changedCodeLines }",
    expect: '[C3] UI 改动强制',
  },
  {
    id: 'I409',
    what: 'C4 verify-state: reclaimVerifySlotCache 跳过删除槽位缓存 cur.slots[sk] 导致残留脏缓存',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: "  delete cur.slots[sk]\n  writeJsonAtomic(p, cur)",
    to: "  void sk\n  writeJsonAtomic(p, cur)",
    expect: '[C4] verify-state per-slot',
  },
]
