/**
 * injections-data-issue-binding.mjs —— flow start 确定性 Issue 绑定与八类豁免门禁故障注入表（I806–I811）。
 */

export const INJECTIONS_ISSUE_BINDING = [
  {
    id: 'I806',
    what: 'flow-start-helpers.mjs: 绕过 Case 2 无合规正文也无豁免时的 BLOCKED_MISSING_ISSUE_BINDING 阻断',
    file: 'kit/skills/dev-flow/scripts/flow-start-helpers.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-start-helpers.mjs'],
    from: '  if (!wantCreateFlag && !hasExplicitBody && verifiedPlanDocs.length === 0) {',
    to: '  if (false && !wantCreateFlag && !hasExplicitBody && verifiedPlanDocs.length === 0) {',
    expect: 'C1/C4：BLOCKED_MISSING_ISSUE_BINDING 登记、CLI 互斥与 --no-issue 理由强度校验',
  },
  {
    id: 'I807',
    what: 'flow-start-helpers.mjs: 绕过规划文档/台账已有 issue 的先复用分支，导致重复建单',
    file: 'kit/skills/dev-flow/scripts/flow-start-helpers.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-start-helpers.mjs'],
    from: '  const merged = [...new Set([...argIssues, ...ledgerIssues, ...docIssues])]\n  if (merged.length > 0) {',
    to: '  const merged = [...new Set([...argIssues, ...ledgerIssues, ...docIssues])]\n  if (false && merged.length > 0) {',
    expect: 'C1/C4：先门禁后建单防孤儿单、先复用不重复、Case 3/4 自动建单回链与 --planning 晋升绑定',
  },
  {
    id: 'I808',
    what: 'flow-start-helpers.mjs: 跳过 --no-issue --reason 的 validateOverrideReason 强度校验',
    file: 'kit/skills/dev-flow/scripts/flow-start-helpers.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-start-helpers.mjs'],
    from: "  const chk = validateOverrideReason(opts.reason, { subject: '豁免建单理由', minChars: 4 })\n  if (!chk.ok) {",
    to: "  const chk = validateOverrideReason(opts.reason, { subject: '豁免建单理由', minChars: 4 })\n  if (false && !chk.ok) {",
    expect: 'C1/C4：BLOCKED_MISSING_ISSUE_BINDING 登记、CLI 互斥与 --no-issue 理由强度校验',
  },
  {
    id: 'I809',
    what: 'flow-start-helpers.mjs: 忽略 AGENTS.md「取舍」中的 no-auto-issue 声明',
    file: 'kit/skills/dev-flow/scripts/flow-start-helpers.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-start-helpers.mjs'],
    from: "  if (agentsText && readDecisions(agentsText).has('no-auto-issue')) {",
    to: "  if (false && agentsText && readDecisions(agentsText).has('no-auto-issue')) {",
    expect: 'C1/C4：八类豁免全覆盖、no-auto-issue 取舍、delegated exit 4 与浅正文透传 BLOCKED_ISSUE_QUALITY_INCOMPLETE',
  },
  {
    id: 'I810',
    what: 'flow-start-helpers.mjs: 绕过 contributor-fork 角色自动豁免',
    file: 'kit/skills/dev-flow/scripts/flow-start-helpers.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-start-helpers.mjs'],
    from: "  if (role === 'contributor-fork') {",
    to: "  if (false && role === 'contributor-fork') {",
    expect: 'C1/C4：八类豁免全覆盖、no-auto-issue 取舍、delegated exit 4 与浅正文透传 BLOCKED_ISSUE_QUALITY_INCOMPLETE',
  },
  {
    id: 'I811',
    what: 'flow-inspect.mjs: 绕过 checkStartMainCleanAndSlot 前置门禁，导致脏主仓仍触发自动建单产生孤儿单',
    file: 'kit/skills/dev-flow/scripts/flow-inspect.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-inspect.mjs'],
    from: '  const slotChk = await checkStartMainCleanAndSlot(roots.mainRoot, { caseType, commits: state.commits })\n  if (!slotChk.ok) {',
    to: '  const slotChk = await checkStartMainCleanAndSlot(roots.mainRoot, { caseType, commits: state.commits })\n  if (false && !slotChk.ok) {',
    expect: 'C1/C4：先门禁后建单防孤儿单、先复用不重复、Case 3/4 自动建单回链与 --planning 晋升绑定',
  },
]
