/**
 * injections-data-flow-defects.mjs —— 流程状态机与隔离边界收口的故障注入复验数据表（I310–I349）。
 *
 * 每条注入只做一件事：把本片刚建立的判据改回它治的那个病，然后期望对应断言变红。
 * 注入不通过就说明那条断言只是「看起来在测」，实际挡不住任何东西。
 */

export const INJECTIONS_FLOW_DEFECTS = [
  {
    id: 'I310',
    what: 'C1 引用丢仓库：跨仓链接被当成同号本地单',
    file: 'kit/skills/lib/github-parse.mjs',
    alsoDropIn: ['.agents/skills/lib/github-parse.mjs'],
    from: "    if (m) { issues.push({ repo: normalizeRepoPath(m[1]), number: Number(m[2]), raw: s }); continue }",
    to: "    if (m) { issues.push({ repo: null, number: Number(m[2]), raw: s }); continue }",
    expect: 'C1 引用保留目标仓',
  },
  {
    id: 'I311',
    what: 'C1 跨仓判定恒等：任何引用都当成指向本仓',
    file: 'kit/skills/lib/github-parse.mjs',
    alsoDropIn: ['.agents/skills/lib/github-parse.mjs'],
    from: "  if (refRepo.toLowerCase() === here.toLowerCase()) {",
    to: "  if (true) {",
    expect: 'C1 跨仓引用三态',
  },
  {
    id: 'I312',
    what: 'C2 同一性退回只看文本指纹：换措辞即判不同',
    file: 'kit/skills/dev-review/scripts/review-locks.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-locks.mjs'],
    from: "  const ra = lineRange(a)\n  const rb = lineRange(b)\n  if (ra && rb) return ra.start <= rb.end && ra.end >= rb.start",
    to: "  const ra = null\n  const rb = null\n  if (ra && rb) return ra.start <= rb.end && ra.end >= rb.start",
    expect: 'C2 同一阻塞项按定位点判',
  },
  {
    id: 'I313',
    what: 'C2 轮次收口退回批量置已解决：未提及等于已解决',
    file: 'kit/skills/dev-review/scripts/review-ledger.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-ledger.mjs'],
    from: "    } else {\n      unmentionedFromPrev.push(pm.id)\n    }",
    to: "    } else {\n      pm.status = 'resolved'\n      pm.resolvedInRound = round\n      resolvedItems.push(pm.id)\n    }",
    expect: 'C2 轮次收口三态',
  },
  {
    id: 'I314',
    what: 'C11 审计零目标折成通过：一份都没查却说全部通过',
    file: 'kit/skills/dev-plan/scripts/doc-audit-repo.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/doc-audit-repo.mjs'],
    from: "  if (auditedCount > 0) return { applicable: true, auditOutcome: 'audited' }",
    to: "  if (auditedCount >= 0) return { applicable: true, auditOutcome: 'audited' }",
    expect: 'C11 审计零目标',
  },
  {
    id: 'I315',
    what: 'C6 去掉起步的首次提交：只 init 不提交',
    file: 'scripts/lib/equip-bootstrap.mjs',
    from: '    if (gitInitialized) firstCommit = createFirstCommit(root, created, names)',
    to: '    // 注入：起步不落首次提交',
    expect: 'C6 起步落首次提交',
  },
  {
    id: 'I316',
    what: 'C13 把回告写失败改回静默吞掉：不看返回值',
    file: 'kit/skills/dev-flow/scripts/flow-merge.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-merge.mjs'],
    from: "  if (result && result.ok === true) return { ok: true }",
    to: "  if (result) return { ok: true }",
    expect: 'C13 回告写失败判为未发出',
  },
]
