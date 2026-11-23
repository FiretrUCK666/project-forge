/**
 * injections-data-r6a.mjs —— R6A 默认分支、提交风格、任务活性分类、A3 自合拦截与 CAS 租约故障注入数据。
 */

export const INJECTIONS_R6A_STATE = [
  {
    id: 'I601',
    what: '破坏 git.mjs resolveDefaultBranch strict 模式缺失默认分支返回 main 假默认值',
    file: 'kit/skills/lib/git.mjs',
    alsoDropIn: ['.agents/skills/lib/git.mjs'],
    from: '  if (strict) return null',
    to: "  if (strict) return 'main'",
    expect: 'R6A-C1: master-only',
  },
  {
    id: 'I602',
    what: '破坏 git-core.mjs detectCommitStyle 少于 5 条有效提交也反转识别为 conventional',
    file: 'kit/skills/lib/git-core.mjs',
    alsoDropIn: ['.agents/skills/lib/git-core.mjs'],
    from: "  if (effective.length < MIN_COMMIT_STYLE_SAMPLES) return 'plain'",
    to: "  if (false && effective.length < MIN_COMMIT_STYLE_SAMPLES) return 'plain'",
    expect: 'R6A-C1: master-only',
  },
  {
    id: 'I603',
    what: '破坏 ledger.mjs classifyTaskLiveness 将已合入任务误判为 active',
    file: 'kit/skills/lib/ledger.mjs',
    alsoDropIn: ['.agents/skills/lib/ledger.mjs'],
    from: "  if (status === 'merged') return 'terminal-pending-cleanup'",
    to: "  if (status === 'merged') return 'active'",
    expect: 'R6A-C2: classifyTaskLiveness',
  },
  {
    id: 'I604',
    what: '绕过 flow-merge.mjs A3 实施者自合并 BLOCKED_SELF_MERGE 拦截',
    file: 'kit/skills/dev-flow/scripts/flow-merge.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-merge.mjs'],
    from: '  if (callerActor && !allowSingleSessionSelf && (requiresReview || (hasDevReview && Number(ledger.caseType ?? 3) >= 2)) && implementerSet.has(callerActor)) {',
    to: '  if (false && callerActor && !allowSingleSessionSelf && implementerSet.has(callerActor)) {',
    expect: 'R6A-C3: generic-git',
  },
  {
    id: 'I605',
    what: '关闭 flow-merge-claim.mjs --takeover 缺失 --agent 的硬阻断回退旧作者',
    file: 'kit/skills/dev-flow/scripts/flow-merge-claim.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-merge-claim.mjs'],
    from: '  if (isTakeover && !isValidActorName(opts.agent)) {',
    to: '  if (false && isTakeover && !isValidActorName(opts.agent)) {',
    expect: 'R6A-C4: plan-exit-gate',
  },
  {
    id: 'I606',
    what: '破坏 workflow-policy-next.mjs Case 3 独立 Todo 恢复硬编码 --case 4',
    file: 'kit/skills/lib/workflow-policy-next.mjs',
    alsoDropIn: ['.agents/skills/lib/workflow-policy-next.mjs'],
    from: '              ? `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${firstReady} --case ${caseTypeOfSlice(firstSlice)}`',
    to: '              ? `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${firstReady} --case 4`',
    expect: 'R6A-C4: plan-exit-gate',
  },
  {
    id: 'I607',
    what: '关闭 flow-merge-claim.mjs acquireGitClaimLease refs/pf/claims/ 并发互斥检查',
    file: 'kit/skills/dev-flow/scripts/flow-merge-claim.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-merge-claim.mjs'],
    from: "  if (existing && !takeover && (!prevActor || !nextActor || prevActor !== nextActor)) return { ok: false, blocked: true, code: 'BLOCKED_ISSUE_ALREADY_CLAIMED', lease: existing }",
    to: '  if (false && existing && !takeover) return { ok: false }',
    expect: 'R6A-C4: plan-exit-gate',
  },
]
