/**
 * injections-data-trace-sync.mjs —— 远端规划全节点同步、后绑回补、非破坏摘要、同轮 HEAD 更新与结构化关单故障注入表（I410–I416）。
 *
 * 导出 `INJECTIONS_TRACE_SYNC` 供 `injections-data.mjs` 自动发现加载。
 */

export const INJECTIONS_TRACE_SYNC = [
  {
    id: 'I410',
    what: 'plan-sync mergeManagedPlanSummary 覆盖前部用户手写正文',
    file: 'kit/skills/lib/plan-sync.mjs',
    from: "    return [before, wrapped, after].filter(Boolean).join('\\n\\n')",
    to: '    return wrapped',
    expect: 'trace-sync-C1b',
  },
  {
    id: 'I411',
    what: 'plan-sync buildPlanSyncKey 去掉内容指纹导致不同 clarify 误去重',
    file: 'kit/skills/lib/plan-sync.mjs',
    from: '  if (CONTENT_KEYED_PHASES.has(phase)) {',
    to: '  if (false && CONTENT_KEYED_PHASES.has(phase)) {',
    expect: 'trace-sync-C1a',
  },
  {
    id: 'I412',
    what: 'doc-plan init 仅传入单文件 res.file 而非全部 res.files',
    file: 'kit/skills/dev-plan/scripts/doc-plan.mjs',
    from: "        phase: 'init', file: res.file, files: res.files, taskId: res.taskId ?? opts.task ?? null,",
    to: "        phase: 'init', file: res.file, taskId: res.taskId ?? opts.task ?? null,",
    expect: 'trace-sync-C1a',
  },
  {
    id: 'I413',
    what: 'doc-comments buildSubmitComments 忽略 isHeadUpdate 重复发送提交待审',
    file: 'kit/skills/lib/doc-comments.mjs',
    from: '  if (!isRework && isHeadUpdate) {',
    to: '  if (false && !isRework && isHeadUpdate) {',
    expect: 'trace-sync-C2/C3/C4',
  },
  {
    id: 'I414',
    what: 'flow-lifecycle submit 复用已有 PR 时未传 isHeadUpdate',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle.mjs',
    from: 'buildSubmitComments({ isRework, isHeadUpdate: !isRework && hasExistingPr, round: nextRound,',
    to: 'buildSubmitComments({ isRework, round: nextRound,',
    expect: 'trace-sync-C2/C3/C4',
  },
  {
    id: 'I415',
    what: 'doc-comments buildIssueCloseComment 丢失 pf-state 结构化锚点',
    file: 'kit/skills/lib/doc-comments.mjs',
    from: '  return { commentBody: `${bodyWithoutTag}\\n\\n${stateTag}`, bodyWithoutTag, stateTag, statePayload: payload }',
    to: '  return { commentBody: bodyWithoutTag, bodyWithoutTag, stateTag: \'\', statePayload: payload }',
    expect: 'trace-sync-C2/C3/C4',
  },
  {
    id: 'I416',
    what: 'flow-context syncTaskDocsSafe 跳过后绑 --issue 自动 plan-backfill',
    file: 'kit/skills/dev-flow/scripts/flow-context.mjs',
    from: '    if (targetSyncIssues.length > 0 && postFiles.length > 0 && !overrides.skipPlanBackfill) {',
    to: '    if (false && targetSyncIssues.length > 0 && postFiles.length > 0 && !overrides.skipPlanBackfill) {',
    expect: 'trace-sync-C1b',
  },
]
