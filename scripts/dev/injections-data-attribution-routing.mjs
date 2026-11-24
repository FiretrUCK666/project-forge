/**
 * injections-data-attribution-routing.mjs —— Issue #108 双层身份、评论标签、回退核对与路由去歧义故障注入复验表（I245–I249）。
 *
 * 导出 `INJECTIONS_ATTRIBUTION_ROUTING` 供 `injections-data.mjs` 自动发现加载。
 */

export const INJECTIONS_ATTRIBUTION_ROUTING = [
  {
    id: 'I245',
    what: 'resolveIdentityLayers 将 explicitAgent 写回 account 或把 gitName 误标为 verifiedPlatformLogin=true',
    file: 'kit/skills/lib/github-parse.mjs',
    alsoDropIn: ['.agents/skills/lib/github-parse.mjs'],
    from: '    if (cleanGit) {\n      account = cleanGit\n      isPlatformVerified = false',
    to: '    if (cleanGit) {\n      account = cleanGit\n      isPlatformVerified = true',
    expect: 'C1：双层正交身份',
  },
  {
    id: 'I246',
    what: 'formatAttribution 忽视 capabilities.mention 与 verifiedPlatformLogin 直接输出 @handle',
    file: 'kit/skills/lib/doc-comments.mjs',
    alsoDropIn: ['.agents/skills/lib/doc-comments.mjs'],
    from: '  const canMention = Boolean(verifiedPlatformLogin === true && (supportsMention === true || capabilities?.mention === true))',
    to: '  const canMention = true',
    expect: 'C1：双层正交身份',
  },
  {
    id: 'I247',
    what: 'parseAcceptanceCriteria 跳过 issueContext 与 prContext 复选框回退解析',
    file: 'kit/skills/dev-review/scripts/review-gates.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-gates.mjs'],
    from: '  if (criteria.length === 0) {',
    to: '  if (false && criteria.length === 0) {',
    expect: 'C2：中文生命周期标签统一',
  },
  {
    id: 'I248',
    what: 'buildReviewComments 丢弃 实证核验 输出或恢复英文 implementer= 混排',
    file: 'kit/skills/lib/review-comment-render.mjs',
    alsoDropIn: ['.agents/skills/lib/review-comment-render.mjs'],
    from: "    ...(cleanEmpirical ? [`- **实证核验**：${cleanEmpirical}`] : []),",
    to: "    ...(cleanImplementer ? [`- implementer=${cleanImplementer}`] : []),",
    expect: 'C2：中文生命周期标签统一',
  },
  {
    id: 'I249',
    what: 'dev-flow order 退回 15 抢在 dev-plan 之前造成做功能路由歧义',
    file: 'kit/skills/dev-flow/SKILL.md',
    alsoDropIn: ['.agents/skills/dev-flow/SKILL.md'],
    from: '  order: 30',
    to: '  order: 15',
    expect: 'C3：AGENTS 路由去歧义',
  },
]
