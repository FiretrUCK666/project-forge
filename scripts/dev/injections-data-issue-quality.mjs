/**
 * injections-data-issue-quality.mjs —— 单一平台中性 Issue 质量契约与 verify-tools --stale 自检后置排序故障注入表（I801–I805）。
 */

export const INJECTIONS_ISSUE_QUALITY = [
  {
    id: 'I801',
    what: 'issue-quality.mjs: 绕过 validateIssueBodyQuality 中 2 段空壳与 5 项结构底线拦截',
    file: 'kit/skills/lib/issue-quality.mjs',
    alsoDropIn: ['.agents/skills/lib/issue-quality.mjs'],
    from: '  const ok = missing.length === 0 && invalidDocRefs.length === 0',
    to: '  const ok = invalidDocRefs.length === 0',
    expect: 'C1：validateIssueBodyQuality 拦截 2 段空壳',
  },
  {
    id: 'I802',
    what: 'issue-quality.mjs: 绕过 plan-index.mjs / 磁盘核验（将不存在的 docs/specs/fake-spec.md 视为真实文档）',
    file: 'kit/skills/lib/issue-quality.mjs',
    alsoDropIn: ['.agents/skills/lib/issue-quality.mjs'],
    from: '    const found = resolveDocOnDisk(repoRoot, mainRoot, ref)\n    if (found) verifiedDocRefs.push(ref)\n    else invalidDocRefs.push(ref)',
    to: '    const found = resolveDocOnDisk(repoRoot, mainRoot, ref)\n    if (found || ref) verifiedDocRefs.push(ref)\n    else invalidDocRefs.push(ref)',
    expect: 'C1/C3：validateIssueBodyQuality 与 flow issue create 绑定真实 SPEC/Todo',
  },
  {
    id: 'I803',
    what: 'issue-template-hydrate.mjs: 恢复空洞套话默认填充（按根因收敛方案实施）',
    file: 'kit/skills/lib/issue-template-hydrate.mjs',
    alsoDropIn: ['.agents/skills/lib/issue-template-hydrate.mjs'],
    from: "    alternatives: normalizeEscapedNewlines(fields.alternatives || fields.rootCause || '').trim(),",
    to: "    alternatives: normalizeEscapedNewlines(fields.alternatives || fields.rootCause || '').trim() || '- 按根因收敛方案实施，避免临时绕过。',",
    expect: 'C1：validateIssueBodyQuality 拦截 2 段空壳',
  },
  {
    id: 'I804',
    what: 'escalation.mjs / flow-issues.mjs: 绕过 escalateToBackend 与托管入口的 validateIssueBodyQuality 拦截',
    file: 'kit/skills/lib/escalation.mjs',
    alsoDropIn: ['.agents/skills/lib/escalation.mjs'],
    from: '  if (!quality.ok) {\n    return {\n      ok: false,\n      blocked: true,\n      code: quality.code,',
    to: '  if (false && !quality.ok) {\n    return {\n      ok: false,\n      blocked: true,\n      code: quality.code,',
    alsoPatches: [
      {
        file: 'kit/skills/dev-flow/scripts/flow-issue-core.mjs',
        from: '  if (!quality.ok) {\n    if (opts.json) {',
        to: '  if (false && !quality.ok) {\n    if (opts.json) {',
      },
      {
        file: '.agents/skills/dev-flow/scripts/flow-issue-core.mjs',
        from: '  if (!quality.ok) {\n    if (opts.json) {',
        to: '  if (false && !quality.ok) {\n    if (opts.json) {',
      },
    ],
    expect: 'C2/C3：escalation 富证据建单',
  },
  {
    id: 'I805',
    what: 'verify-tools.mjs: 取消 handleRun --stale 中自检工具后置排序',
    file: 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs',
    alsoDropIn: ['.agents/skills/dev-verify-tools/scripts/verify-tools.mjs'],
    from: '  if (staleOnly && candidateEntries.length > 1) {\n    candidateEntries.sort((a, b) => {\n      const aSelf = isSelfAuditTool(a.tool, taskId) ? 1 : 0\n      const bSelf = isSelfAuditTool(b.tool, taskId) ? 1 : 0\n      return aSelf - bSelf\n    })\n  }',
    to: '  if (false && staleOnly && candidateEntries.length > 1) {\n    candidateEntries.sort(() => 0)\n  }',
    expect: 'C3/C5：verify-tools run --stale 将自检工具排在最后刷新并一次性通过',
  },
]
