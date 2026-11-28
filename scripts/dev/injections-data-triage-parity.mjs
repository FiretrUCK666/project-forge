/**
 * injections-data-triage-parity.mjs —— Wave 3 (`triage-brief-contract-parity`) C9..C12 故障注入复验数据表（I991-I996）。
 */

export const INJECTIONS_TRIAGE_PARITY = [
  {
    id: 'I991',
    what: 'C9 doc-audit: 恢复 fileCount >= 6 钝化悬崖导致 7 文件可逆 UI 改动被误抬升 Case 4',
    file: 'kit/skills/dev-plan/scripts/doc-audit.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/doc-audit.mjs'],
    from: '  const isContract = touchesContract\n    || contractRe.test(text)',
    to: '  const isContract = touchesContract\n    || (!docOnly && fileCount !== undefined && fileCount >= 6)\n    || contractRe.test(text)',
    expect: '[Heterogeneous-C9]',
  },
  {
    id: 'I992',
    what: 'C9 triage-rules: 破坏 resolveRecommendedEntry 令可逆 Case 2/3 退回 plan-first 而非 sandbox',
    file: 'kit/skills/dev-plan/scripts/triage-rules.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/triage-rules.mjs'],
    from: "  return { recommendedEntry: 'sandbox', sandboxPocAllowed: true }",
    to: "  return { recommendedEntry: 'plan-first', sandboxPocAllowed: false }",
    expect: '[Heterogeneous-C9]',
  },
  {
    id: 'I993',
    what: 'C9 doc-audit: 破坏 Case 5 与 PRD 正交性令 Case 5 携带 prdNeed.required=true',
    file: 'kit/skills/dev-plan/scripts/doc-audit.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/doc-audit.mjs'],
    from: "      docsRequired: ['docs/TDD.md (先更新并确认)'], redGreenRequired: true, needsReview: true, specApprovalRequired: true,\n      prdRequired: false, prdReasons: [], prdAdvice: null, faces,",
    to: "      docsRequired: ['docs/TDD.md (先更新并确认)'], redGreenRequired: true, needsReview: true, specApprovalRequired: true,\n      prdRequired: prdNeed.required, prdReasons: prdNeed.reasons, prdAdvice: prdNeed.advice, faces,",
    expect: '[Heterogeneous-C9]',
  },
  {
    id: 'I994',
    what: 'C9 triage-rules: 破坏 shouldAutoTriggerBrief 令局部可逆单轮 Case 3 误触发 Brief 产生冗余开销',
    file: 'kit/skills/dev-plan/scripts/triage-rules.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/triage-rules.mjs'],
    from: "  if (c >= 4 || doorType === 'one-way' || Boolean(prdRequired) || Boolean(hasPrototype)) return true",
    to: "  if (c >= 3 || doorType === 'one-way' || Boolean(prdRequired) || Boolean(hasPrototype)) return true",
    expect: '[Heterogeneous-C9]',
  },
  {
    id: 'I995',
    what: 'C10 preflight: 删掉 templates/agents-project.md 的外环硬拒 inner: true 不变量导致契约漂移',
    file: 'templates/agents-project.md',
    from: '并由外环硬拒内环 `inner: true`；',
    to: '；',
    runner: 'preflight',
    expect: '双环契约同构',
  },
  {
    id: 'I996',
    what: 'C10 preflight: 从 subcommand-meta.mjs 移除 flow 的 promote 注册导致双环契约门禁漏报',
    file: 'kit/skills/lib/subcommand-meta.mjs',
    alsoDropIn: ['.agents/skills/lib/subcommand-meta.mjs'],
    from: "      entry('promote', true),\n",
    to: '',
    runner: 'preflight',
    expect: '双环契约同构',
  },
]
