import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
/**
 * injections-data-empirical-cycle.mjs —— 工具无关结构化实证、UI 裸开关拦截、PoC 先行建单
 * 与有界优化循环停损的故障注入复验表（I260-I269）。
 *
 * 导出 `INJECTIONS_EMPIRICAL_CYCLE` 供 `injections-data.mjs` 自动发现加载。
 */

export const INJECTIONS_EMPIRICAL_CYCLE = [
  {
    id: 'I260',
    what: 'C1 normalizeArtifactRecords 放行 0 字节空附件（空文件也能当实证）',
    file: 'kit/skills/lib/empirical-artifacts.mjs',
    alsoDropIn: ['.agents/skills/lib/empirical-artifacts.mjs'],
    from: '  if (st.size <= 0) {',
    to: '  if (false && st.size <= 0) {',
    expect: 'C1：实证附件必须真实存在',
  },
  {
    id: 'I261',
    what: 'C1 resolveArtifactRecord 把目录当作合法附件提交',
    file: 'kit/skills/lib/empirical-artifacts.mjs',
    alsoDropIn: ['.agents/skills/lib/empirical-artifacts.mjs'],
    from: '  if (st.isDirectory()) {',
    to: '  if (false && st.isDirectory()) {',
    expect: 'C1：实证附件必须真实存在',
  },
  {
    id: 'I262',
    what: 'C2 触及界面资源时裸 --visual-checked 直接放行，无附件与观察也当已核验',
    file: 'kit/skills/lib/empirical-artifacts.mjs',
    alsoDropIn: ['.agents/skills/lib/empirical-artifacts.mjs'],
    from: "  if (!required || visual.satisfiedBy) {",
    to: "  if (true || !required || visual.satisfiedBy) {",
    expect: 'C2：触及 UI_VISUAL_EXT_RE 时裸 --visual-checked 被阻断',
  },
  {
    id: 'I263',
    what: 'C2 观察实质判据失效，敷衍占位水话（lgtm/已验证）重新被当成视觉观察放行',
    file: 'kit/skills/lib/empirical-artifacts.mjs',
    alsoDropIn: ['.agents/skills/lib/empirical-artifacts.mjs'],
    from: "  const check = evaluateTextSubstance(text, { subject: '观察摘要' })\n  if (!check.ok) return { ok: false, code: check.code, reason: check.reason }",
    to: "  const check = evaluateTextSubstance(text, { subject: '观察摘要' })\n  if (false && !check.ok) return { ok: false, code: check.code, reason: check.reason }",
    expect: 'C2：观察文本实质判据拒绝占位水话',
  },
  {
    id: 'I264',
    what: 'C2 提交阶段跳过已落账实证的界面核验判据（声明了却没有证据也放行）',
    file: 'kit/skills/lib/workflow-policy.mjs',
    alsoDropIn: ['.agents/skills/lib/workflow-policy.mjs'],
    from: '  if (!vis.ok) return { ok: false, code: vis.code, exitCode: EXIT.FACT, uiFiles: vis.uiFiles, reason: vis.reason }',
    to: '  if (false && !vis.ok) return { ok: false, code: vis.code, exitCode: EXIT.FACT, uiFiles: vis.uiFiles, reason: vis.reason }',
    expect: 'C2：submit 阶段核对已落账实证',
  },
  {
    id: 'I265',
    what: 'C1 verify 前置预检不再校验附件，坏附件直接进 evidence.json',
    file: 'kit/skills/lib/empirical-artifacts.mjs',
    alsoDropIn: ['.agents/skills/lib/empirical-artifacts.mjs'],
    from: '  if (!gate.ok) return gate',
    to: '  if (false && !gate.ok) return gate',
    expect: 'C1：verify 前置预检拒绝坏附件',
  },
  {
    id: 'I266',
    what: 'C3 escalation 建单丢弃可选 reproEvidence 与 pocCommand 字段',
    file: 'kit/skills/lib/escalation.mjs',
    alsoDropIn: ['.agents/skills/lib/escalation.mjs'],
    from: '  const { reproEvidence, pocCommand } = normalizeReproEvidence(item)',
    to: '  const reproEvidence = null; const pocCommand = null',
    expect: 'C3：escalation 建单接收可选 reproEvidence',
  },
  {
    id: 'I267',
    what: 'C4 cycle 轮次上限失效，超出 maxRounds 仍继续排下一轮',
    file: 'kit/skills/dev-iterate/scripts/iterate-cycle.mjs',
    alsoDropIn: ['.agents/skills/dev-iterate/scripts/iterate-cycle.mjs'],
    from: '  if (nextRound > maxRounds) {',
    to: '  if (false && nextRound > maxRounds) {',
    expect: 'C4：三条硬停损',
  },
  {
    id: 'I268',
    what: 'C4 cycle 连续零进展不再停损（NO_PROGRESS_STALL 失效）',
    file: 'kit/skills/dev-iterate/scripts/iterate-cycle.mjs',
    alsoDropIn: ['.agents/skills/dev-iterate/scripts/iterate-cycle.mjs'],
    from: '  if (zeroStreak >= STALL_ROUNDS) {',
    to: '  if (false && zeroStreak >= STALL_ROUNDS) {',
    expect: 'C4：三条硬停损',
  },
  {
    id: 'I269',
    what: 'C4 cycle 单向门待拍板项不再停损，循环自行跨过人工决策点',
    file: 'kit/skills/dev-iterate/scripts/iterate-cycle.mjs',
    alsoDropIn: ['.agents/skills/dev-iterate/scripts/iterate-cycle.mjs'],
    from: '  if (oneWay.length > 0) {',
    to: '  if (false && oneWay.length > 0) {',
    expect: 'C4：三条硬停损',
  },
]
