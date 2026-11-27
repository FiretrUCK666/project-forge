/**
 * navigation.mjs —— 勘察报告末尾的「下一步必读」纯函数计算。
 *
 * 从 scripts/lib/render.mjs 拆出以减少 scripts/survey.mjs JSON 模式的静态加载开销；
 * render.mjs 重导出 computeNavigation 保持外部接口兼容。
 */

export function computeNavigation(facts) {
  const items = []
  const kinds = facts.ecosystem?.kinds ?? []
  const hasCommands = Object.keys(facts.commands ?? {}).length > 0
  const git = facts.git ?? {}
  const docs = facts.docs ?? {}
  const risks = facts.risks ?? {}
  const ignores = facts.ignores ?? {}
  const secrets = risks.secretFiles ?? []
  const isPlugin = kinds.some((k) => k.endsWith('-plugin') || k.endsWith('-extension'))
  const isSkill = kinds.includes('skill')

  const gitTriggers = [
    git.present !== true,
    git.isRepoRoot === false,
    git.isBare === true,
    git.isShallow === true,
    (git.nestedRepos ?? []).length > 0,
    ignores.unignoredOutputDirs?.length > 0,
    (ignores.ignoredButTracked ?? []).length > 0,
    !ignores.hasGitattributes && (git.trackedFiles ?? 0) > 0,
    secrets.some((f) => f.status === 'tracked' || f.status === 'exposed'),
    (risks.secretContent ?? []).length > 0,
    (risks.largeFiles ?? []).length > 0,
    git.commitsState === 'unreadable',
  ]
  if (gitTriggers.some(Boolean)) {
    items.push('`references/version-control.md` 全文——**未读之前不要执行 `git init` / `git add` / `git commit`**。'
      + '里面有几条靠常识推不出来的判据：`.gitattributes` 的行尾清单、worktree 与裸仓库的识别方式、'
      + '占位署名（`Administrator` 一类）未确认前严禁推送、已推送与未推送凭据的处置完全不同')
  }

  const agentFills = docs.agentsMarkers?.fills ?? []
  const docsTriggers = [
    !docs.readme,
    !docs.agents,
    agentFills.length > 0,
    !docs.license,
    (docs.otherAiConventions ?? []).length > 0,
  ]
  if (docsTriggers.some(Boolean)) {
    const why = []
    if (!docs.readme) why.push('没有 README')
    if (!docs.agents) why.push('没有 AGENTS.md')
    if (agentFills.length > 0) why.push(`AGENTS.md 还有 ${agentFills.length} 处没填`)
    if (!docs.license) why.push('没有 LICENSE')
    if ((docs.otherAiConventions ?? []).length > 0) why.push(`另有 ${(docs.otherAiConventions).length} 份 AI 约定文件要合流`)
    items.push(`\`references/docs-set.md\`（${why.join('、')}）——`
      + '里面写的是「哪些文件必须有、哪些只有该出现时才出现」，以及各篇该写什么、不该写什么。'
      + '凭常识写出来的 README 会承诺兑现不了的东西，AI 契约会把机制写两遍')
  }

  const wf = docs.workflowFacts ?? {}
  const caps = git.capabilities ?? null
  const onGithub = git.providerId
    ? (git.providerId === 'github' || Boolean(git.topology?.providerIds?.includes('github')))
    : (typeof git.remote === 'string' && /github\.com/i.test(git.remote))
  const hasNativePlatformApi = Boolean(caps?.known === true && caps?.api === true)
  const remoteTriggers = [
    (git.remotes ?? []).length === 0,
    !wf.hasCheck,
    wf.usesPullRequestTarget && wf.checkoutsPrHead,
    !docs.prTemplate,
  ]
  if (remoteTriggers.some(Boolean) && git.present === true && (onGithub || (git.remotes ?? []).length === 0)) {
    items.push('`references/remote-github.md`——'
      + '建仓库、首次推送、CI 与发布自动化的顺序与判据都在这里；'
      + '`pull_request_target` 那一条尤其要读：写错等于让陌生人拿你的密钥跑他的代码')
  }
  if (git.present === true && (git.remotes ?? []).length > 0 && !onGithub) {
    items.push(hasNativePlatformApi
      ? `**远端不在 GitHub 上（${git.providerId}）**：当前远端不适用 GitHub Actions 流水线配置；已启用该平台原生 API 协议适配（Issue / PR-MR${caps?.uploadAttachment ? ' / 附件直传' : ''}），完整执行本地 Git、\`docs/\`、\`AGENTS.md\` 与 \`.agents/skills/\` 治理`
      : '**远端不在 GitHub 上**：当前远端属于通用 Git（`generic-git`），不适用平台流水线配置，仅执行本地 Git、`docs/`、`AGENTS.md` 与 `.agents/skills/` 治理')
  }

  if ((git.remotes ?? []).length > 0 && git.present === true) {
    items.push('`references/collaboration.md`——判角色（维护者 / 贡献者 / 处理外来提案）、五档分流、'
      + '审查循环怎么才会停、谁审谁能合、合并后七步收尾。'
      + '凭常识判断「这次改动大不大」是最容易出错的一步')
  }

  if (isSkill) {
    items.push('`references/skill-project.md`——能力目录的入口声明、分发方式与版本来源。'
      + '它不经过制品库，别把「没发布」读成「没做完」')
  }
  if (isPlugin) {
    items.push('`references/plugin-ecosystems.md` 里对应宿主那一节——'
      + '产物入不入库、宿主侧标识改不得、标签要不要带前缀，这三件每错一件都是用户装不上')
  }

  if (facts.ecosystem?.publishable) {
    items.push('`references/publish.md` + `references/publish-ecosystems.md` 里对应生态那一节——'
      + '预演命令、可信发布的三个逐字对齐项、坏版本怎么修正，都不在常识里')
  }

  if (!hasCommands) {
    items.push('**这个项目没有探到任何构建或测试命令**：读源码补齐，或者如实写「本项目无构建与测试步骤」。'
      + '不要按生态惯例编一条——编出来的会在 CI 里失败，而那条失败看起来像「代码坏了」')
  }

  const strategy = facts.explorationStrategy
  if (strategy?.tier === 'parallel-subagents' && (strategy.shards?.length ?? 0) > 0) {
    const shardList = strategy.shards
      .map((s) => `\`${s.id}\`（${s.focus}${(s.targets?.length ?? 0) > 0 ? `；目标：${s.targets.join('、')}` : ''}）`)
      .join('；')
    items.push(`**并行只读探索（${strategy.reason}）**：在定范围与落盘前先并行派 ${strategy.shards.length} 个互不重叠的只读子 Agent 摸底——${shardList}`)
  }

  const customSkills = facts.kit?.customSkills ?? []
  if (customSkills.length > 0) {
    items.push(`**保留并挂载自有扩展技能（${customSkills.length} 个）**：${customSkills.map((s) => `\`${s.path}\``).join('、')}——写入 \`AGENTS.md\` 路由表共存，\`equip\` 与 \`handoff\` 原样保留不覆写`)
  }

  const re = facts.reentry
  if (re?.isReentry && (re.drifted || (re.unregisteredTopDirs?.length ?? 0) > 0)) {
    const driftParts = []
    if (re.staleAgentPaths.length > 0) driftParts.push(`契约失效路径 ${re.staleAgentPaths.length} 处（${re.staleAgentPaths.slice(0, 3).join('、')}）`)
    if (re.staleAgentScripts.length > 0) driftParts.push(`契约失效脚本 ${re.staleAgentScripts.join('、')}`)
    if (re.staleTddPaths.length > 0) driftParts.push(`TDD 失效路径 ${re.staleTddPaths.slice(0, 3).join('、')}`)
    if (re.unregisteredTopDirs.length > 0) driftParts.push(`未登记模块目录 ${re.unregisteredTopDirs.slice(0, 4).join('、')}`)
    if (facts.kit?.drifted || facts.kit?.versionMismatch) driftParts.push('受管技能套件版本或文件漂移')
    items.push(`**跨月重入失步校准**：检测到 ${driftParts.join('、')}——保留手写规则与自有技能，按诊断定向刷新失效条目与新增模块，修改前先打仓外快照`)
  }

  return items
}
