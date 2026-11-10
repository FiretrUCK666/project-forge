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
  if (tracked.length > 0) risky.push(`已在版本库里的敏感文件：${tracked.map((f) => f.file).join('、')}`)
  if (exposed.length > 0) risky.push(`未忽略的敏感文件：${exposed.map((f) => f.file).join('、')}`)
  if (facts.risks.secretContent.length > 0) {
    risky.push(`凭据形状的文本：${facts.risks.secretContent.map((c) => `${c.file}:${c.line}（${c.kind}）`).join('、')}`)
  }
  if (facts.risks.largeFiles.length > 0) {
    risky.push(`大文件：${facts.risks.largeFiles.map((f) => `${f.file}（${humanBytes(f.sizeMB * 1024 * 1024)}）`).join('、')}`)
  }
  if (facts.risks.homePathLeaks.length > 0) {
    risky.push(`硬编码的本机路径：${facts.risks.homePathLeaks.slice(0, 5).map((f) => `${f.file}:${f.line}`).join('、')}`)
  }
  lines.push('## 风险')
  lines.push('')
  if (risky.length === 0) lines.push('没扫到。')
  else for (const item of risky) lines.push(`- ${item}`)
  lines.push('')

  lines.push('## 这次没查的')
  lines.push('')
  lines.push(`- **能不能推代码**：${facts.git.auth?.https === 'undetermined' ? '没探测（默认不联网、不问凭据助手）。需要时加 `--probe-auth`' : facts.git.auth?.https}`)
  lines.push('- **远端可达性**：没探测。它会等满一次网络超时，而勘察要能随便调用')
  lines.push('- **仓库设置**（分支保护、可见性、Actions 开关）：脚本读不到，在 GitHub 上看')
  lines.push('')

  return lines.join('\n')
}
