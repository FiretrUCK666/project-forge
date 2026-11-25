/**
 * injections-data-conv-s3.mjs —— Slice 3 (`ergonomics-and-budget-debloat`) 故障注入复验表（I931–I936）。
 */

export const INJECTIONS_CONV_S3 = [
  {
    id: 'I931',
    what: '将 KIT_SKILL_MAX_BYTES 从 16KB 强压回 12KB（违反 C10 双线预算底线）',
    file: 'kit/skills/lib/tool-owned.mjs',
    from: 'export const KIT_SKILL_MAX_BYTES = 16 * 1024',
    to: 'export const KIT_SKILL_MAX_BYTES = 12 * 1024',
    expect: 'Conv-S3 C10 & C11',
  },
  {
    id: 'I932',
    what: 'preflight-suite evaluateKitSkillBudget 跳过超 16KB 硬上限拦截',
    file: 'scripts/dev/preflight-suite.mjs',
    from: '  if (bytes > maxBytes) {',
    to: '  if (false && bytes > maxBytes) {',
    expect: 'Conv-S3 C10 & C11',
  },
  {
    id: 'I933',
    what: 'cli.mjs parseStandardCli 忽略 flagPresets 导致 --single-session 静默预设失效',
    file: 'kit/skills/lib/cli.mjs',
    from: '    const preset = flagPresets[rawKey]',
    to: '    const preset = null && flagPresets[rawKey]',
    expect: 'Conv-S3 C9',
  },
  {
    id: 'I934',
    what: 'doc-plan triage 生成的 SPEC+Todo [NEXT STEP] 漏带 --agent <id>',
    file: 'kit/skills/dev-plan/scripts/doc-plan.mjs',
    from: "                : '创建 SPEC+Todo: node \".agents/skills/dev-plan/scripts/doc-plan.mjs\" init --kind pair --slug <slug> --title \"<标题>\" --agent <id>',",
    to: "                : '创建 SPEC+Todo: node \".agents/skills/dev-plan/scripts/doc-plan.mjs\" init --kind pair --slug <slug> --title \"<标题>\"',",
    expect: 'Conv-S3 C9',
  },
  {
    id: 'I935',
    what: 'flow start 复用已有工作树退回旧版 status --task 死胡同提示',
    file: 'kit/skills/dev-flow/scripts/flow-start-helpers.mjs',
    from: `export function buildStartReuseNextSteps(existing, taskId) {\n  if (existing.status === 'planning' || existing.planning === true) {\n    return [\n      { skill: 'dev-plan', text: \`1. 在 \${existing.worktreePath ?? '.'} 内编写/完善 SPEC 与 Todo 并完成 critique-pass 与 approve\` },\n      { skill: 'dev-flow', text: \`2. 过审后执行 node ".agents/skills/dev-flow/scripts/flow.mjs" start --task \${taskId} 转入实施阶段\` },\n    ]\n  }\n  if (existing.isolation === 'review-pr') {\n    return [{ skill: 'dev-review', text: \`node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr \${existing.prNumber ?? ''} --untrusted-scan\` }]\n  }\n  if (!existing.claimedAt) {\n    return [\n      { skill: 'dev-flow', text: \`1. 先执行 flow.mjs claim 认领任务：node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task \${taskId} --agent <id>\` },\n      { skill: 'dev-flow', text: \`2. 推进任务状态：node ".agents/skills/dev-flow/scripts/flow.mjs" next --task \${taskId}\` },\n    ]\n  }\n  return [{ skill: 'dev-flow', text: \`node ".agents/skills/dev-flow/scripts/flow.mjs" next --task \${taskId}\` }]\n}`,
    to: `export function buildStartReuseNextSteps(existing, taskId) {\n  return [{ skill: 'dev-flow', text: \`node ".agents/skills/dev-flow/scripts/flow.mjs" status --task \${taskId}\` }]\n}`,
    expect: 'Conv-S3 C9',
  },
  {
    id: 'I936',
    what: 'WARN_WORKING_IN_MAIN_CHECKOUT 退回「不改也行」的冲突文案',
    file: 'kit/skills/lib/workflow-policy-next.mjs',
    from: "        + '请在主仓合并前整理并清理或迁出这些未提交改动，以免被脏主仓门禁拦截或混入无关修改。',",
    to: "        + '不改也行，但「这次改动包含什么」会因此说不清。',",
    expect: 'Conv-S3 C11 & C12',
  },
]
