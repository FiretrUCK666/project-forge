/**
 * injections-data-w6c.mjs —— Wave 6 Slice 6C 故障注入复验样本集（I443–I451）。
 *
 * 覆盖 C13..C18 + 根治 A/B/C 核心门禁不变量：
 *   I443 (C13): validateCrossRepoTarget 跳过 `.agents/skills` 宿主仓与 CWD 错位校验
 *   I444 (C14): issue-template-hydrate 丢弃 0 匹配模板下的用户 rawBody
 *   I445 (C15): review-empirical 放开 low 纯文档静态检查阻断
 *   I446 (C16): normalizeConcurrentVerifyCommand 停止剥离 --maxWorkers
 *   I447 (根治 A): buildMultiTaskWavePlan 不再对空写域（files.length === 0）默认保守串行
 *   I448 (根治 B): evaluateMasterIssueCloseGuard 对 multi_spec:true 未完切片直接放行关单
 *   I449 (根治 C): validateNoAsciiControlChars 跳过 ASCII_C0_CONTROL_RE 控制字符校验
 *   I450 (C18): verifyPlanningProvenance 跳过 ownerHeaderHash 篡改比对
 *   I451 (C18): recordPlanningProvenance 允许未走 --owner-reason 的常规 link 覆盖洗白基线
 */

export const INJECTIONS_W6C = [
  {
    id: 'I443',
    what: 'C13 cli.mjs: validateCrossRepoTarget 绕过 .agents/skills 宿主仓与 CWD 一致性检查',
    file: 'kit/skills/lib/cli.mjs',
    alsoDropIn: ['.agents/skills/lib/cli.mjs'],
    from: '  if (!hasExplicitDir) {',
    to: '  if (false && !hasExplicitDir) {',
    expect: 'W6C C13：跨仓 CWD 错位 fail-closed 拦截、--dir 显式放行与 6/6 SUBCOMMAND_META 全量对拍',
  },
  {
    id: 'I444',
    what: 'C14 issue-template-hydrate: 0 匹配模板时不再追加保留用户 rawBody',
    file: 'kit/skills/lib/issue-template-hydrate.mjs',
    alsoDropIn: ['.agents/skills/lib/issue-template-hydrate.mjs'],
    from: '  if (rawExplicit && (matchedCount === 0 || !md.includes(rawExplicit))) {',
    to: '  if (false && rawExplicit && (matchedCount === 0 || !md.includes(rawExplicit))) {',
    expect: 'W6C C14：**Bold** 模板水合保留 --body 与 finalize 同步 SPEC 正文状态表',
  },
  {
    id: 'I445',
    what: 'C15 review-empirical: evaluateIncludeDiffGate 跳过 low 风险纯文档静态检查阻断',
    file: 'kit/skills/dev-review/scripts/review-empirical.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-empirical.mjs'],
    from: '  if (staticDocBlock) missingSteps.push(\'static-doc-check\')',
    to: '  if (false && staticDocBlock) missingSteps.push(\'static-doc-check\')',
    expect: 'W6C C15：low 纯文档免 runtime 实证/保留静态检查，与 escalation 错误签名去重',
  },
  {
    id: 'I446',
    what: 'C16 workflow-policy-next: normalizeConcurrentVerifyCommand 不再剥离 --maxWorkers/--workers/--bail',
    file: 'kit/skills/lib/workflow-policy-next.mjs',
    alsoDropIn: ['.agents/skills/lib/workflow-policy-next.mjs'],
    from: "    .replace(/(?:^|\\s)--(?:maxWorkers|max-workers|workers)(?:=\\S+|\\s+\\S+)(?=\\s|$)/gi, ' ')",
    to: "    .replace(/__NEVER_MATCH__/g, ' ')",
    expect: 'W6C C16 + 根治 A：并发 flags 等价、多语言单栈过滤与波次图真相源回填/保守串行',
  },
  {
    id: 'I447',
    what: '根治 A doc-slice-graph: buildMultiTaskWavePlan 对空写域不再默认 conservativeSerial=true',
    file: 'kit/skills/lib/doc-slice-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-slice-graph.mjs'],
    from: '    const conservativeSerial = Boolean(t.conservativeSerial || files.length === 0)',
    to: '    const conservativeSerial = Boolean(t.conservativeSerial)',
    expect: 'W6C C16 + 根治 A：并发 flags 等价、多语言单栈过滤与波次图真相源回填/保守串行',
  },
  {
    id: 'I448',
    what: '根治 B flow-merge-claim: evaluateMasterIssueCloseGuard 在有未完成兄弟切片时仍放行关单',
    file: 'kit/skills/dev-flow/scripts/flow-merge-claim.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-merge-claim.mjs'],
    from: '  if (remainingSiblings.length > 0) {',
    to: '  if (false && remainingSiblings.length > 0) {',
    expect: 'W6C C17 + 根治 B：worktree-deps pnpm/Vite 与账本回写、游离 edit-gate 与 1:N 总控 Issue 关单保护',
  },
  {
    id: 'I449',
    what: '根治 C cli.mjs: validateNoAsciiControlChars 跳过 ASCII C0 控制字符拦截',
    file: 'kit/skills/lib/cli.mjs',
    alsoDropIn: ['.agents/skills/lib/cli.mjs'],
    from: '  const hit = findAsciiControlChar(value)',
    to: '  const hit = null',
    expect: 'W6C C18 + 根治 C：planningProvenance 防篡改、git user.name 不误杀、证明边界与 C0 控制字符拦截',
  },
  {
    id: 'I450',
    what: 'C18 doc-approval: verifyPlanningProvenance 跳过仓外 ownerHeaderHash 防篡改比对',
    file: 'kit/skills/lib/doc-approval.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-approval.mjs'],
    from: '    if (rec?.ownerHeaderHash && rec.ownerHeaderHash !== workHash) {',
    to: '    if (false && rec?.ownerHeaderHash && rec.ownerHeaderHash !== workHash) {',
    expect: 'W6C C18 + 根治 C：planningProvenance 防篡改、git user.name 不误杀、证明边界与 C0 控制字符拦截',
  },
  {
    id: 'I451',
    what: 'C18 doc-approval: recordPlanningProvenanceCore 允许普通 link 覆盖已篡改基线',
    file: 'kit/skills/lib/doc-approval.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-approval.mjs'],
    from: '      if (existingEntry && !isLegitimateTransfer && existingEntry.ownerHeaderHash && existingEntry.ownerHeaderHash !== curHash) {',
    to: '      if (false && existingEntry && !isLegitimateTransfer && existingEntry.ownerHeaderHash && existingEntry.ownerHeaderHash !== curHash) {',
    expect: 'W6C C18 + 根治 C：planningProvenance 防篡改、git user.name 不误杀、证明边界与 C0 控制字符拦截',
  },
]
