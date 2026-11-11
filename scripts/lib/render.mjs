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
  lines.push('')

  const cmdEntries = Object.entries(facts.commands)
  lines.push('## 探测到的命令')
  lines.push('')
  if (cmdEntries.length === 0) {
    lines.push('一个都没探到。纯文档项目属正常；其他情况要读源码补充，**不要凭生态惯例编一个**。')
  } else {
    const label = {
      install: '安装', build: '构建', typecheck: '类型检查', lint: '静态检查',
      test: '测试', verify: '综合验证',
    }
    for (const [key, value] of cmdEntries) {
      lines.push(`- **${label[key] ?? key}**：\`${value}\``)
    }
  }
  lines.push('')

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
 * 报告末尾的「下一步读哪一份」。
 *
 * 这一段存在的理由只有一个：**AI 读完报告就直接动手**。它此刻的注意力全在这个函数的
 * 返回值上，而「去读 references/xxx.md」写在入口文件的第三屏，那时已经不在它的注意力里。
 * 把它放在**工具输出里**，并且按本次命中的事实精确到「哪一份、哪一节」，读它就成了
 * 下一步最省力的动作——省力的那一条才会被走。
 *
 * 内容是**由事实推出来的**，不是固定文案：没命中插件就不会有人说「去读插件契约」。
 */
function appendNavigation(lines, facts) {
  const items = []
  const kinds = facts.ecosystem?.kinds ?? []
  const hasCommands = Object.keys(facts.commands ?? {}).length > 0
  const isPluginOrSkill = kinds.some((k) => k === 'skill' || k.endsWith('-plugin') || k.endsWith('-extension'))

  if (facts.git?.present !== true || facts.git?.isRepoRoot === false
    || facts.ignores?.unignoredOutputDirs?.length > 0
    || (facts.risks?.secretFiles ?? []).some((f) => f.status === 'tracked' || f.status === 'exposed')) {
    items.push('`references/version-control.md` 全文——**未读之前不要执行 `git init` / `git add` / `git commit`**。'
      + '里面有几条靠常识推不出来的判据：`.gitattributes` 的行尾清单、worktree 的识别方式、'
      + '占位署名（`Administrator` 一类）未确认前严禁推送、已推送与未推送凭据的处置完全不同')
  }

  if (isPluginOrSkill) {
    items.push('`references/skill-project.md` + `references/plugin-ecosystems.md` 里对应宿主那一节——'
      + '产物入不入库、宿主侧标识改不得、标签要不要带前缀，这三件每错一件都是用户装不上')
  }

  if (facts.ecosystem?.publishable || facts.ecosystem?.registryFree) {
    items.push('`references/publish.md` + `references/publish-ecosystems.md` 里对应生态那一节——'
      + '预演命令、可信发布的三个逐字对齐项、坏版本怎么修正，都不在常识里')
  }

  if (!hasCommands) {
    items.push('**这个项目没有探到任何构建或测试命令**：读源码补齐，或者如实写「本项目无构建与测试步骤」。'
      + '不要按生态惯例编一条——编出来的会在 CI 里失败，而那条失败看起来像「代码坏了」')
  }

  if (items.length === 0) return
  lines.push('## 下一步必读（按本次勘察到的事实生成）')
  lines.push('')
  for (const item of items) lines.push(`- ${item}`)
  lines.push('')
  lines.push('理由：这些文件里写的是**反直觉的硬判据**，不是概念介绍。凭自身常识跳过它们，'
    + '结果不会报错，只会在几周后以「用户装不上」「历史改不掉」的形式出现。')
  lines.push('')
}
