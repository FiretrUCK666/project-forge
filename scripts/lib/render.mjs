/**
 * render.mjs —— 把勘察事实排成人能读的 Markdown。
 *
 * 与勘察逻辑分开的理由：勘察回答「是什么」，这里回答「怎么让人一眼看懂」。
 * 混在一起时，改一句措辞要去三千行里找，而那三千行里还有判定。
 *
 * 一条纪律：**这里不产生任何新结论**。它只把已经在那份事实里的东西换个形状排出来。
 * 一处排序、一句措辞都不改变判定，因此它坏掉时最坏结果是「报告难看」，不是「判错」。
 */

const MATURITY_TEXT = {
  empty: '空目录 —— 先让项目存在（选技术栈、写源码），再回来配工程设施',
  greenfield: '白纸或刚起步 —— 缺的东西多，但该做的一次配齐',
  partial: '演进中 —— 有基础、有缺口，补齐即可，不推倒重来',
  mature: '已成型 —— 该有的基本都有，按体检结果微调',
}

export function humanBytes(n) {
  if (!Number.isFinite(n)) return String(n)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function gitLine(git) {
  if (git.available === false) return '这台机器上找不到 git'
  if (git.present !== true) return '还不是版本库'
  if (git.isRepoRoot === false) return `在外层仓库里（根在 \`${git.workTreeRoot}\`），当前目录不是仓库根`
  const parts = [`分支 \`${git.branch ?? '未知'}\``]
  if (git.remote) {
    parts.push(`远端 \`${git.remote}\``)
    parts.push(`角色 \`${git.role}\``)
  } else {
    parts.push('没有远端')
  }
  if (git.commitsState === 'unreadable') parts.push('提交数读不出来')
  else if (git.commits !== undefined) parts.push(`${git.commits} 个提交`)
  if (git.dirty > 0) parts.push(`${git.dirty} 处未提交改动`)
  if (git.ahead > 0) parts.push(`领先上游 ${git.ahead} 个提交`)
  return parts.join('，')
}

function ecosystemLine(eco) {
  const kinds = eco.kinds.length > 0 ? eco.kinds.join('、') : '认不出来'
  const bits = [kinds]
  if (eco.packageManager) bits.push(`包管理器 ${eco.packageManager}`)
  if (eco.declaredVersion) bits.push(`版本 ${eco.declaredVersion}`)
  bits.push(eco.publishable ? '有可发布形态' : '不发布到制品库')
  if (eco.private) bits.push('清单声明了私有')
  return bits.join('；')
}

function docsLine(docs) {
  const mark = (ok) => (ok ? '有' : '**没有**')
  const items = [
    `README ${mark(Boolean(docs.readme))}${docs.readme ? `（${docs.readmes.join('、')}）` : ''}`,
    `AGENTS.md ${mark(Boolean(docs.agents))}`,
    `CONTRIBUTING ${mark(Boolean(docs.contributing))}`,
    `LICENSE ${mark(Boolean(docs.license))}`,
    `CI ${mark(docs.workflowFacts.hasCheck)}${docs.workflows.length ? `（${docs.workflows.join('、')}）` : ''}`,
    `发布自动化 ${mark(docs.workflowFacts.hasRelease)}`,
    `PR 模板 ${mark(docs.prTemplate)}`,
    `Issue 模板 ${mark(docs.issueTemplates)}`,
  ]
  // 「别的 AI 约定文件」是一类**必须被看见**的现状：两份约定并存时，改一份另一份不跟，
  // 而读的人只会看到其中一份。只报「有 / 没有」不够——得把名字列出来，否则没法逐条合流。
  if ((docs.otherAiConventions ?? []).length > 0) {
    items.push(`既有 AI 规则文件 **${docs.otherAiConventions.join('、')}**——先读一遍，把其中仍然成立的规则合进 \`AGENTS.md\`，别让两份各说各的`)
  }
  return items.join(' · ')
}

export function toMarkdown(facts) {
  const lines = []
  lines.push(`# 勘察报告：${facts.target.name}`)
  lines.push('')
  lines.push(`路径：\`${facts.target.path}\``)
  lines.push('')

  lines.push('## 一眼看完')
  lines.push('')
  lines.push(`- **成熟度**：\`${facts.maturity}\` —— ${MATURITY_TEXT[facts.maturity] ?? ''}`)
  lines.push(`- **项目类型**：${ecosystemLine(facts.ecosystem)}`)
  lines.push(`- **版本控制**：${gitLine(facts.git)}`)
  lines.push(`- **文档与自动化**：${docsLine(facts.docs)}`)
  lines.push(`- **规模**：${facts.scale.totalFiles} 个文件（代码 ${facts.scale.codeFiles}，文档 ${facts.scale.docFiles}）`)
  if (facts.workspace.declared) {
    lines.push(`- **多包仓库**：是${facts.workspace.packages.length ? `（${facts.workspace.packages.length} 个子包）` : ''}`)
  }
  // 运行环境要求来自清单声明，不是猜的：写 README 的那一节要用它，
  // 而「Node 18 或更高」这种写法正是 `templates/readme.md` 明令禁止的。
  const runtime = facts.artifacts?.runtimeRequirements ?? []
  if (runtime.length > 0) lines.push(`- **运行环境要求**（清单里写的）：${runtime.join('、')}`)
  lines.push('')

  const cmdEntries = Object.entries(facts.commands)
  lines.push('## 探测到的命令')
  lines.push('')
  const label = {
    install: '安装', build: '构建', typecheck: '类型检查', lint: '静态检查',
    test: '测试', verify: '综合验证',
  }
  if (cmdEntries.length === 0) {
    lines.push('一个都没探到。纯文档项目属正常；其他情况要读源码补充，**不要凭生态惯例编一个**。')
  } else {
    for (const [key, value] of cmdEntries) {
      lines.push(`- **${label[key] ?? key}**：\`${value}\``)
    }
  }

  // 多生态并存时**逐生态全量列出**。只给顶层那几张表，写文档与配 CI 的人会以为
  // 后端没有命令——而只测一半的 CI 看起来完全正常：测试绿着，另一半一次没跑过。
  const byEco = facts.commandsByEcosystem ?? {}
  const ecoKeys = Object.keys(byEco).filter((k) => Object.keys(byEco[k] ?? {}).length > 0)
  if (ecoKeys.length > 1) {
    lines.push('')
    lines.push('**按生态分开的命令**（每个都要出现在契约与 CI 里，别只取一份）：')
    for (const kind of ecoKeys) {
      const pairs = Object.entries(byEco[kind]).map(([k, v]) => `${label[k] ?? k} \`${v}\``)
      lines.push(`- **${kind}**：${pairs.join('；')}`)
    }
  }

  // 子目录里的生态（前后端分离那种布局）：根目录没有清单，命令藏在子目录里。
  const subdirs = facts.ecosystem?.subdirs ?? []
  if (subdirs.length > 0) {
    lines.push('')
    lines.push('**根目录没有清单，命令在子目录里**：' + subdirs.map((s) => `\`${s.dir}/\`（${s.kinds.join('、')}）`).join('、')
      + '——写契约与 CI 时要带上目录前缀，否则命令在仓库根跑不起来')
  }
  lines.push('')

  // 既有约定：默认分支、标签形状、提交风格、工作记录目录。
  // 这几项决定了契约里写什么，写错的表现是每条命令都指向不存在的东西。
  const conv = facts.conventions ?? {}
  const convBits = []
  if (conv.defaultBranch) convBits.push(`默认分支 \`${conv.defaultBranch}\``)
  if (conv.tagPrefix !== undefined) convBits.push(`标签${conv.tagPrefix === '' ? '**不带** `v` 前缀' : '带 `v` 前缀'}`)
  if (conv.commitStyle) convBits.push(`提交风格 \`${conv.commitStyle}\``)
  if (conv.workDir) convBits.push(`工作记录放 \`${conv.workDir}/\``)
  if ((conv.workflowTooling ?? []).length > 0) convBits.push(`已在用的发版/提交工具 ${conv.workflowTooling.join('、')}`)
  if (convBits.length > 0) {
    lines.push('## 项目已有的约定（写契约时照它，别按默认值写）')
    lines.push('')
    lines.push(`- ${convBits.join('；')}`)
    lines.push('')
  }

  // 仓库自带的 skills：它们是**项目的一部分**，不是痕迹，交棒时不要碰。
  const localSkills = facts.localSkills ?? []
  if (localSkills.length > 0) {
    lines.push('## 仓库自带的 skills（是内容，不是痕迹）')
    lines.push('')
    for (const s of localSkills) {
      lines.push(`- \`${s.path}\`${s.valid ? '' : ' —— **入口声明不合法**，宿主会静默丢掉它'}`)
    }
    lines.push('')
  }

  if (facts.gaps.length > 0) {
    lines.push('## 缺口')
    lines.push('')
    for (const gap of facts.gaps) lines.push(`- ${gap}`)
    lines.push('')
  } else {
    lines.push('## 缺口')
    lines.push('')
    lines.push('没有「不做就会出事」的缺口。')
    lines.push('')
  }

  if (facts.questions.length > 0) {
    lines.push('## 要问用户的事')
    lines.push('')
    for (const q of facts.questions) lines.push(`- ${q}`)
    lines.push('')
  }

  const risky = []
  const tracked = facts.risks.secretFiles.filter((f) => f.status === 'tracked')
  const exposed = facts.risks.secretFiles.filter((f) => f.status === 'exposed')
  const unverified = facts.risks.secretFiles.filter((f) => f.status === 'unverified-large')
  if (tracked.length > 0) risky.push(`已在版本库里的敏感文件：${tracked.map((f) => f.file).join('、')}`)
  if (exposed.length > 0) risky.push(`未忽略的敏感文件：${exposed.map((f) => f.file).join('、')}`)
  if (unverified.length > 0) {
    risky.push(`**没有核对过的**敏感文件（超过 256 KB，内容没扫）：${unverified.map((f) => f.file).join('、')}——`
      + '它的状态是未知，不是「干净」')
  }
  if (facts.risks.secretContent.length > 0) {
    risky.push(`凭据形状的文本：${facts.risks.secretContent.map((c) => `${c.file}:${c.line}（${c.kind}）`).join('、')}`)
  }
  if (facts.risks.largeFiles.length > 0) {
    risky.push(`大文件：${facts.risks.largeFiles.map((f) => `${f.file}（${humanBytes(f.sizeMB * 1024 * 1024)}）`).join('、')}`)
  }

  // 本机路径按它在哪分类，**只有 `leak` 才值得动手**。
  // 把测试夹具里的假路径报成泄露的结果，是修它的人先去改掉那一行——而那行正好有用。
  const leaks = facts.risks.homePathLeaks.filter((f) => f.category === 'leak' || f.category === undefined)
  const benign = facts.risks.homePathLeaks.filter((f) => f.category && f.category !== 'leak')
  if (leaks.length > 0) {
    risky.push(`硬编码的本机路径：${leaks.slice(0, 5).map((f) => `${f.file}:${f.line}`).join('、')}——换台机器就跑不通`)
  }
  if (benign.length > 0) {
    const byCat = benign.reduce((acc, f) => {
      acc[f.category] = (acc[f.category] ?? 0) + 1
      return acc
    }, {})
    const label = { 'test-data': '测试夹具', 'doc-example': '文档示例', generated: '工作记录与发版说明' }
    risky.push(`另有 ${benign.length} 处本机路径属于${Object.entries(byCat).map(([k, n]) => `${label[k] ?? k} ${n} 处`).join('、')}`
      + '——它们是数据不是缺陷，**不要改**')
  }

  lines.push('## 风险')
  lines.push('')
  if (risky.length === 0) lines.push('没扫到。')
  else for (const item of risky) lines.push(`- ${item}`)
  lines.push('')

  const coverage = facts.risks.scanCoverage
  lines.push('## 这次没查的')
  lines.push('')
  lines.push(`- **能不能推代码**：${facts.git.auth?.https === 'undetermined' ? '没探测（默认不联网、不问凭据助手）。需要时加 `--probe-auth`' : facts.git.auth?.https}`)
  lines.push('- **远端可达性**：没探测。它会等满一次网络超时，而勘察要能随便调用')
  lines.push('- **仓库设置**（分支保护、可见性、Actions 开关）：脚本读不到，在 GitHub 上看')
  if (coverage?.truncated) {
    lines.push(`- **内容扫描被截断了**：只走到第 ${coverage.depthReached} 层、前 20000 个文件。`
      + '上面的「没扫到」覆盖不到更深的地方——这一趟不能当完整证据用')
  }
  if (coverage?.skippedLargeFiles > 0) {
    lines.push(`- **${coverage.skippedLargeFiles} 个敏感命名的文件超过 256 KB，内容没扫**：它们的状态是未知，不是干净`)
  }
  if (coverage?.unreadableFiles > 0) {
    lines.push(`- **${coverage.unreadableFiles} 个文本文件读不出来**（编码或权限），它们没被扫过`)
  }
  lines.push('')

  appendNavigation(lines, facts)

  return lines.join('\n')
}

/**
 * 报告末尾的「下一步读哪一份」。**纯函数**：给一份事实，回一组条目。
 *
 * 这一段存在的理由只有一个：**AI 读完报告就直接动手**。它此刻的注意力全在这个函数的
 * 返回值上，而「去读 references/xxx.md」写在入口文件的第三屏，那时已经不在它的注意力里。
 * 把它放在**工具输出里**，并且按本次命中的事实精确到「哪一份、哪一节」，读它就成了
 * 下一步最省力的动作——省力的那一条才会被走。
 *
 * ## 为什么必须是纯函数、而且挂在 facts 上
 *
 * 两条输出路径（`--json` 给程序、`--markdown` 给人）各算一遍导航，迟早会分叉：
 * 实测过一次——JSON 那条路**压根没有导航字段**，于是照着 JSON 往下走的 AI
 * 一条必读清单都拿不到，而它以为自己已经看全了。算一次、两边共用，这种分叉就不存在。
 *
 * ## 触发条件是「这次要动手的事」，不是「这个项目长什么样」
 *
 * 每一条都对着一个**具体的、不读就会踩坑的动作**：没 README 就要写文档、没远端就要建仓库、
 * 有未填的 fill 就要先读完代码再填。项目里没有这件事时，多派一份文档只是在稀释注意力。
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

  // ── 版本控制：只要这次可能动 git，就必须先读 ──────────────────────
  //
  // 触发条件列全了，因为漏掉任何一条，对应的那个动作就会在没有判据的情况下发生：
  // 一条已入库的凭据、一处没忽略的产物目录、一个浅克隆，都不是「看起来没问题」的事。
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

  // ── 文档套装：缺文档、或有没填完的契约时 ──────────────────────────
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

  // ── 远端：要建仓库、要接 CI、或工作流有风险的形状时 ────────────────
  //
  // 只在**远端就在 GitHub 上**时推这一份。那份参考通篇是 `gh`、Actions、GitHub API，
  // 推给一个用别的托管平台、或者根本不用平台的仓库，读到的是完全不适用的判据——
  // 而它看起来像一条待办。
  const wf = docs.workflowFacts ?? {}
  const onGithub = typeof git.remote === 'string' && /github\.com/i.test(git.remote)
  const remoteTriggers = [
    (git.remotes ?? []).length === 0,
    !wf.hasCheck,
    wf.usesPullRequestTarget && wf.checkoutsPrHead,
    // 没有 PR 模板本身不是缺口（自用项目永远不收外部提案时，它是多余的一份文件）。
    // 但**有远端、又缺模板**时，提案会以一张没有栏目约束的空白页进来——
    // 这一条只在真的有远端时算数，下面那个 onGithub 已经保证了这一点。
    !docs.prTemplate,
  ]
  if (remoteTriggers.some(Boolean) && git.present === true && (onGithub || (git.remotes ?? []).length === 0)) {
    items.push('`references/remote-github.md`——'
      + '建仓库、首次推送、CI 与发布自动化的顺序与判据都在这里；'
      + '`pull_request_target` 那一条尤其要读：写错等于让陌生人拿你的密钥跑他的代码')
  }
  // 远端不在 GitHub 上时，说明一件**这件事说不清**的事实，而不是塞一份 GitHub 文档。
  if (git.present === true && (git.remotes ?? []).length > 0 && !onGithub) {
    items.push('**远端不在 GitHub 上**：`references/remote-github.md` 里的 `gh`、Actions 与 API '
      + '对这套托管平台不适用。CI 与发布自动化要按那个平台自己的机制配，'
      + '本文档里只有「什么该有」这一半还能参考')
  }

  // ── 协作协议：有远端、且这次要落地改动时 ──────────────────────────
  if ((git.remotes ?? []).length > 0 && git.present === true) {
    items.push('`references/collaboration.md`——判角色（维护者 / 贡献者 / 处理外来提案）、五档分流、'
      + '审查循环怎么才会停、谁审谁能合、合并后七步收尾。'
      + '凭常识判断「这次改动大不大」是最容易出错的一步')
  }

  // ── 清理痕迹：只在真的要清的时候 ──────────────────────────────────
  // （这一段由 `handoff.mjs` 自己带，勘察阶段不推——没说要清痕迹时读它是浪费时间。）

  // ── 生态专属 ──────────────────────────────────────────────────────
  //
  // **skill 与 plugin 要分开**：能力目录靠克隆分发、根本没有构建产物，把插件那一套
  // （产物入不入库、宿主侧标识）推给它，读到的是完全不适用的判据；而插件项目恰好相反。
  if (isSkill) {
    items.push('`references/skill-project.md`——能力目录的入口声明、分发方式与版本来源。'
      + '它不经过制品库，别把「没发布」读成「没做完」')
  }
  if (isPlugin) {
    items.push('`references/plugin-ecosystems.md` 里对应宿主那一节——'
      + '产物入不入库、宿主侧标识改不得、标签要不要带前缀，这三件每错一件都是用户装不上')
  }

  // 发布文档只在**真的有制品库形态**时推。「不需要制品库」恰恰是反例：
  // 能力目录靠克隆分发、Go 的「发布」就是打标签——推一份讲 registry 的文档，
  // 读到的是完全不适用的判据。打标签那件事在 `remote-github.md` 里。
  if (facts.ecosystem?.publishable) {
    items.push('`references/publish.md` + `references/publish-ecosystems.md` 里对应生态那一节——'
      + '预演命令、可信发布的三个逐字对齐项、坏版本怎么修正，都不在常识里')
  }

  if (!hasCommands) {
    items.push('**这个项目没有探到任何构建或测试命令**：读源码补齐，或者如实写「本项目无构建与测试步骤」。'
      + '不要按生态惯例编一条——编出来的会在 CI 里失败，而那条失败看起来像「代码坏了」')
  }

  return items
}

function appendNavigation(lines, facts) {
  const items = facts.navigation ?? computeNavigation(facts)
  if (items.length === 0) return
  lines.push('## 下一步必读（按本次勘察到的事实生成）')
  lines.push('')
  for (const item of items) lines.push(`- ${item}`)
  lines.push('')
  lines.push('理由：这些文件里写的是**反直觉的硬判据**，不是概念介绍。凭自身常识跳过它们，'
    + '结果不会报错，只会在几周后以「用户装不上」「历史改不掉」的形式出现。')
  lines.push('')
}
