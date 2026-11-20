/**
 * render.mjs —— 把勘察事实排成人能读的 Markdown。
 *
 * 与勘察逻辑分开的理由：勘察回答「是什么」，这里回答「怎么让人一眼看懂」。
 * 混在一起时，改一句措辞要去三千行里找，而那三千行里还有判定。
 *
 * 一条纪律：**这里不产生任何新结论**。它只把已经在那份事实里的东西换个形状排出来。
 * 一处排序、一句措辞都不改变判定，因此它坏掉时最坏结果是「报告难看」，不是「判错」。
 */

import { computeS3NextStep, hasDecision } from './survey-questions.mjs'
import { computeNavigation } from './navigation.mjs'

export { computeNavigation }

/**
 * 每个生态最多展开几条命令。
 *
 * 阈值给名字、不写裸数字：改它的时候知道自己在改「契约里展开多少条」。
 * 每类至少留一条是硬要求——只剩一句「见 CI」的节等于没有这一节。
 */
export const ECO_COMMANDS_SHOWN_PER_KIND = 3

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
    if (git.providerId === 'generic-git') parts.push('通用 Git（`generic-git`）')
    if (git.topology?.hasMultiRemotes) parts.push(`共 ${git.topology.remotes.length} 个远端`)
    const scope = git.collaborationScope ?? git.identity?.collaborationScope
    if (git.role === 'maintainer' && scope) {
      const scopeLabel = scope === 'team-collaborator' ? '团队协作者' : '所有者'
      parts.push(`角色 \`${git.role}\`（${scopeLabel}）`)
    } else {
      parts.push(`角色 \`${git.role}\``)
    }
  } else {
    parts.push('没有远端')
  }
  if (git.commitsState === 'unreadable') parts.push('提交数读不出来')
  else if (git.commits !== undefined) parts.push(`${git.commits} 个提交`)
  if (git.dirty > 0) parts.push(`${git.dirty} 处未提交改动`)
  if (git.ahead > 0) parts.push(`领先上游 ${git.ahead} 个提交`)
  const teamHint = git.teamProbeHint ?? git.identity?.teamProbeHint
  if (teamHint) parts.push(`协同提示：${teamHint}`)
  return parts.join('，')
}

function ecosystemLine(eco) {
  const kinds = eco.kinds.length > 0 ? eco.kinds.join('、') : '清单里没有已知生态标记（按 CI 与任务文件读命令）'
  const bits = [kinds]
  if (eco.packageManager) bits.push(`包管理器 ${eco.packageManager}`)
  if (eco.declaredVersion) bits.push(`版本 ${eco.declaredVersion}`)
  bits.push(eco.publishable ? '有可发布形态' : '不发布到制品库')
  if (eco.private) bits.push('清单声明了私有')
  return bits.join('；')
}

function docsLine(docs) {
  const mark = (ok) => (ok ? '有' : '**没有**')
  const checkNames = docs.workflowFacts?.checkWorkflows?.length
    ? docs.workflowFacts.checkWorkflows
    : (docs.workflows ?? [])
  const releaseNames = docs.workflowFacts?.releaseWorkflows ?? []
  const items = [
    `README ${mark(Boolean(docs.readme))}${docs.readme ? `（${docs.readmes.join('、')}）` : ''}`,
    `AGENTS.md ${mark(Boolean(docs.agents))}`,
    `CONTRIBUTING ${mark(Boolean(docs.contributing))}`,
    `LICENSE ${mark(Boolean(docs.license))}`,
    `CI 检查 ${mark(docs.workflowFacts.hasCheck)}${checkNames.length ? `（${checkNames.join('、')}）` : ''}`,
    `发布自动化 ${mark(docs.workflowFacts.hasRelease)}${releaseNames.length ? `（${releaseNames.join('、')}）` : ''}`,
    `PR 模板 ${mark(docs.prTemplate)}`,
    `Issue 模板 ${mark(docs.issueTemplates)}`,
  ]
  if ((docs.existingDesignDocs ?? []).length > 0) {
    items.push(`存量设计文档（${docs.existingDesignDocs.join('、')}）`)
  }
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
  if (facts.kit?.manifestExists) {
    const k = facts.kit
    const kitParts = [`schema v${k.schemaVersion ?? 1}`]
    if ((k.disabledSkills?.length ?? 0) > 0) kitParts.push(`已禁用技能：${k.disabledSkills.join('、')}`)
    if ((k.customizedFiles?.length ?? 0) > 0) kitParts.push(`已豁免定制 ${k.customizedFiles.length} 个`)
    lines.push(`- **工程套件清单**：${kitParts.join('；')}`)
  }
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
    // 生态清单认不出来时，命令是从 CI 与 Makefile 里读的。这两处读不到才是真的没有，
    // 那时候要说清「下一步该怎么办」，而不是让人自己猜。
    lines.push('一个都没探到。纯文档项目属正常。其他情况按这个顺序找：')
    lines.push('')
    lines.push('1. 打开 `.github/workflows/`，看 CI 里跑的是哪条命令——那是被真实执行过的，最可靠；')
    lines.push('2. 有 `Makefile` 或 `justfile` 的，看里面定义了哪几个 target；')
    lines.push('3. 两者都没有，就在 `AGENTS.md` 的 `Dev Profile` 里手写这条命令。')
    lines.push('')
    lines.push('**不要凭生态惯例编一个**。编出来的会在 CI 里失败，而那条失败看起来像「代码坏了」。')
  } else {
    for (const [key, value] of cmdEntries) {
      lines.push(`- **${label[key] ?? key}**：\`${value}\``)
    }
  }

  // 多生态并存时**逐生态列出，但不是全量抄一遍**。
  //
  // 全抄的后果实测过：一个能力目录类的仓，CI 里有十几条真实命令，全部装进契约之后
  // 「构建与验证」那一节直接逼近 30KB 上限，而其中大半是同一条命令的不同调用。
  // 契约的作用是告诉人「去哪看、跑哪条」，不是把 CI 文件复制一遍。
  //
  // 所以：每类只展示前 `ECO_COMMANDS_SHOWN_PER_KIND` 条，其余折叠成一句指向源文件的话。
  // 阅读成本降下来的同时，**每类至少留一条真实命令**——不能退化成一个纯指针。
  const byEco = facts.commandsByEcosystem ?? {}
  const ecoKeys = Object.keys(byEco).filter((k) => Object.keys(byEco[k] ?? {}).length > 0)
  if (ecoKeys.length > 1) {
    lines.push('')
    lines.push('**按生态分开的命令**（每个都要出现在契约与 CI 里，别只取一份）：')
    for (const kind of ecoKeys) {
      const pairs = Object.entries(byEco[kind])
      const shown = pairs.slice(0, ECO_COMMANDS_SHOWN_PER_KIND).map(([k, v]) => `${label[k] ?? k} \`${v}\``)
      lines.push(`- **${kind}**：${shown.join('；')}`)
      if (pairs.length > shown.length) {
        lines.push(`  - 另有 ${pairs.length - shown.length} 条同类命令未展开，完整清单见该生态的 CI 配置与任务运行器文件`)
      }
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
  const customSkills = facts.kit?.customSkills ?? []
  if (localSkills.length > 0 || customSkills.length > 0) {
    lines.push('## 仓库自带的 skills（是内容，不是痕迹）')
    lines.push('')
    for (const s of localSkills) {
      const desc = s.summary ? `（${s.summary}）` : ''
      lines.push(`- \`${s.path}\`${desc}${s.valid ? '' : ' —— **入口声明不合法**，宿主会静默丢掉它'}`)
    }
    if (customSkills.length > 0) {
      lines.push(`- **自有扩展技能（equip 与 handoff 原样保留）**：${customSkills.map((s) => `\`${s.path}\`${s.summary ? `（${s.summary}）` : ''}`).join('、')}`)
    }
    lines.push('')
  }

  if (facts.explorationStrategy) {
    lines.push('## 探索与接入策略')
    lines.push('')
    lines.push(`- **策略级别**：\`${facts.explorationStrategy.tier}\` —— ${facts.explorationStrategy.reason}`)
    for (const shard of facts.explorationStrategy.shards ?? []) {
      const targets = (shard.targets ?? []).length > 0
        ? `（目标：${shard.targets.map((t) => `\`${t}\``).join('、')}）`
        : ''
      lines.push(`  - 分片 \`${shard.id}\`（${shard.scope}）：${shard.focus}${targets}`)
    }
    lines.push('')
  }

  if (facts.symbolCoverage) {
    const cov = facts.symbolCoverage
    const total = cov.languageCount ?? 0
    const missing = cov.unsupportedCount ?? 0
    if (total > 0) {
      const tail = missing > 0
        ? '；缺规则的那些语言里抽不到符号，不等于它们没有符号——那几门语言的可复用模块这一轮只能靠文件名看'
        : ''
      lines.push(`## 符号抽取覆盖：本仓 ${total} 种语言，其中 ${missing} 种缺少符号规则${tail}`)
      if (missing > 0) {
        lines.push('')
        for (const item of (cov.languages ?? []).filter((l) => !l.supported)) {
          lines.push(`- \`${item.lang}\`：${item.files} 个文件，没有符号规则`)
        }
      }
      lines.push('')
    }
  }

  const re = facts.reentry
  if (re?.isReentry && (re.drifted || (re.unregisteredTopDirs?.length ?? 0) > 0)) {
    lines.push('## 跨月重入失步校准摘要（保留手写规则与自有技能，仅定向修复下列条目）')
    lines.push('')
    if (re.staleAgentPaths.length > 0) lines.push(`- **AGENTS.md 失效路径**：${re.staleAgentPaths.join('、')}`)
    if (re.staleAgentScripts.length > 0) lines.push(`- **AGENTS.md 失效脚本**：${re.staleAgentScripts.join('、')}`)
    if (re.staleTddPaths.length > 0) lines.push(`- **docs/TDD.md 失效路径**：${re.staleTddPaths.join('、')}`)
    if (re.unregisteredTopDirs.length > 0) lines.push(`- **未登记模块目录**：${re.unregisteredTopDirs.join('、')}`)
    if (facts.kit?.drifted || facts.kit?.versionMismatch) {
      lines.push('- **受管套件漂移**：运行 `node scripts/equip.mjs <目标>` 无损升级并保留自定义修改')
    }
    lines.push('')
  }

  const plan = facts.artifactPlan ?? []
  if (plan.length > 0) {
    lines.push('## 逐项处置计划（存量只融合不覆盖，缺项按事实补齐）')
    lines.push('')
    lines.push('| 产物 | 现状 | 处置动作 | 执行要点 |')
    lines.push('| --- | --- | --- | --- |')
    const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
    for (const item of plan) {
      lines.push(`| ${cell(item.artifact)} | ${cell(item.status)} | \`${cell(item.action)}\` | ${cell(item.detail)} |`)
    }
    lines.push('')
  }

  if (facts.gaps.length > 0) {
    lines.push('## 缺口')
    lines.push('')
    for (const gap of facts.gaps) lines.push(`- ${gap.text}`)
    lines.push('')
  } else {
    lines.push('## 缺口')
    lines.push('')
    lines.push('没有「不做就会出事」的缺口。')
    lines.push('')
  }

  if (facts.questions.length > 0) {
    const kinds = facts.needsHuman?.kinds?.length
      ? facts.needsHuman.kinds
      : [...new Set(facts.questions.map((q) => q.id).filter(Boolean))]
    lines.push('## 要问用户的事')
    lines.push('')
    lines.push(`<!-- NEEDS_HUMAN: count=${facts.questions.length} kinds=${kinds.join(',')} -->`)
    for (const q of facts.questions) lines.push(`- ${q.text}`)
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
  const teamHint = facts.git?.teamProbeHint ?? facts.git?.identity?.teamProbeHint
  const auth = facts.git?.auth ?? {}
  lines.push('## 这次没查的')
  lines.push('')
  lines.push(`- **能不能推代码**：${auth.https === 'undetermined' && !auth.probed ? '没探测（默认不联网、不问凭据助手）。需要时加 `--probe-auth`' : (auth.reason || auth.https || '未探测')}`)
  if (teamHint) {
    lines.push(`- **团队/组织协作者写权限**：${teamHint}`)
  }
  lines.push('- **远端可达性**：没探测。它会等满一次网络超时，而勘察要能随便调用')
  lines.push('- **仓库设置**（分支保护、可见性、检查流开关）：只读勘察默认不调写接口；可按托管界面或 `equip-ci.mjs --protect-branch` 核对开关 A')
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

  appendRemoteAndAuthWizard(lines, facts)
  appendNavigation(lines, facts)
  appendS3NextStep(lines, facts)

  return lines.join('\n')
}

function appendRemoteAndAuthWizard(lines, facts) {
  const git = facts.git ?? {}
  const auth = git.auth ?? {}
  const isGeneric = git.providerId === 'generic-git'
  const hasRemote = (git.remotes ?? []).length > 0 && !git.localMode && git.isRepoRoot !== false && git.isBare !== true
  const noRemote = (git.remotes ?? []).length === 0
    && !git.localMode
    && git.available !== false
    && git.isBare !== true
    && git.isRepoRoot !== false
    && (facts.maturity !== 'empty' || git.present === true)
  const hasAnyPushAuth = Boolean(
    auth.ghCli?.authenticated
    || auth.details?.canPushHttps
    || auth.details?.canPushSsh
    || auth.apiChannel?.tier === 'gh-cli'
    || auth.apiChannel?.tier === 'node-https-token'
    || auth.apiChannel?.tier === 'half-duplex',
  )
  const needsAuthWizard = Boolean(noRemote || (auth.probed && !hasAnyPushAuth))
  const needsHostKeyHint = auth.ssh?.state === 'host-key-unverified'
  const hasRemediation = Boolean(auth.remediationCmd)
  const needsBranchProtectionHint = Boolean(
    !hasDecision(facts, 'no-ci')
    && !hasDecision(facts, 'no-branch-protection')
    && !hasDecision(facts, 'branch-protection')
    && git.role !== 'contributor-fork'
    && (hasRemote || noRemote),
  )

  if (!noRemote && !needsAuthWizard && !needsHostKeyHint && !hasRemediation && !needsBranchProtectionHint) return

  lines.push('## 远端建仓与认证指引')
  lines.push('')
  if (noRemote) {
    lines.push('- **无远端三路决策（支持通用 Git SSH/HTTP(S) 与 GitHub）**：')
    lines.push('  1. **暂不配远端（纯本地）**：仓库无远端时已自动识别为 `local-only`，无需创建 `.git/pf-local-mode` 标记；若需固定显式决策，在 `AGENTS.md`「## 取舍」写 `remote-setup: local-only` 即可。')
    lines.push('  2. **绑定已有远端（SSH / HTTP(S)）**：')
    lines.push('     - SSH：`git remote add origin git@<host>:<owner>/<repo>.git`（先完成本机 SSH Key 与主机指纹核验）；')
    lines.push('     - HTTP(S)：`git remote add origin https://<host>/<owner>/<repo>.git`（**严禁把令牌或口令写进 URL / `.git/config`**）。')
    lines.push('  3. **新建远端仓库**：GitHub 可直接运行 `gh repo create <owner>/<name> --private --source=. --push`（默认 `private` 私有，或按需 `public` 并确认归属）；其他通用远端请先在托管页建好空仓库再按上面 SSH 或 HTTP(S) 命令绑定。')
  }
  if (hasRemediation) {
    lines.push(`- **协议错配自愈命令**：\`${auth.remediationCmd}\``)
  }
  if (needsHostKeyHint) {
    lines.push(`- **SSH 主机指纹尚未收录**：只读探测不改写 \`~/.ssh/known_hosts\`；请人工核对主机指纹后运行验证（例如 GitHub：\`${auth.ssh.fingerprintCmd || 'ssh -T git@github.com'}\`，通用主机：\`ssh -T <user>@<host>\`）。`)
  }
  if (needsAuthWizard) {
    lines.push(`- **SSH 与 HTTP(S) 凭据配置路线**（${isGeneric ? '通用托管平台按所用协议选一条' : '按所用协议与托管平台任选一条'}）：`)
    lines.push('  1. **`SSH Ed25519` 路线（通用 SSH 远端与 GitHub 均适用）**：`ssh-keygen -t ed25519 -C "<你的邮箱>"`（macOS 可执行 `ssh-add --apple-use-keychain ~/.ssh/id_ed25519` 并配置 `UseKeychain yes`）-> 将公钥 `~/.ssh/id_ed25519.pub` 写入托管账户 SSH Keys -> 核对主机指纹后运行 `ssh -T git@<host>` 校验 -> `git remote add origin git@<host>:<owner>/<repo>.git`。')
    lines.push('  2. **`HTTP(S) + PAT + 系统凭据管理器` 路线（通用 HTTP(S) 远端与 GitHub 均适用）**：创建最小权限访问令牌（GitHub 选 Fine-grained PAT，仅勾选 `Contents` / `Pull requests`），交由系统 `credential.helper` 保存（macOS Keychain / Windows GCM / Linux 凭据库），**严禁把明文令牌写进 `.git/config` 远端 URL**。')
    if (!isGeneric) {
      lines.push('  3. **`GitHub gh CLI` 路线（GitHub 远端可选）**：`gh auth login` -> `gh auth setup-git` -> `gh repo create <name> --private --source=. --push`。')
    }
  }
  if (needsBranchProtectionHint) {
    const branch = facts.conventions?.defaultBranch || git.originHeadBranch || git.initDefaultBranch || 'main'
    const targetPath = facts.target?.path || '.'
    const hooksFlag = facts.git?.hooks?.hasConflict || hasDecision(facts, 'no-git-hooks') ? '' : ' --with-hooks'
    if (git.capabilities?.branchProtection === true) {
      lines.push(`- **默认分支保护（开关 A，GitHub 可执行）**：运行 \`node scripts/equip-ci.mjs "${targetPath}" --protect-branch --branch ${branch}\`（仅禁直推/强推/删默认分支并要求 PR 与状态检查通过，**严禁设置 \`required_approving_review_count >= 1\`**；若遇 HTTP \`403\` 自动降级改用 \`node scripts/equip.mjs "${targetPath}"${hooksFlag || ' --with-hooks'}\`）。完成后在 \`AGENTS.md\`「## 取舍」写入 \`branch-protection\`（或 \`no-branch-protection\`）。`)
    } else {
      lines.push(`- **默认分支保护（开关 A，通用托管指引）**：当前远端不支持统一分支保护 API，请在托管仓库设置中为默认分支（\`${branch}\`）手动开启开关 A（禁直推/强推/删默认分支、要求变更提案与门禁检查通过，**不默认强制他人审批**），并建议运行 \`node scripts/equip.mjs "${targetPath}" --with-hooks\` 安装本地 \`.githooks/pre-push\` 防护；完成后在 \`AGENTS.md\`「## 取舍」写入 \`branch-protection\`（或 \`no-branch-protection\`）。`)
    }
  }
  lines.push('')
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

function appendS3NextStep(lines, facts) {
  const nextStep = facts.nextStep ?? computeS3NextStep(facts)
  if (!nextStep) return
  lines.push('## S3 推荐落盘入口')
  lines.push('')
  lines.push(`${nextStep.text}`)
  if (nextStep.reason) lines.push(`- 决策依据：${nextStep.reason}`)
  if (nextStep.protectBranchCommand) {
    lines.push(`- 分支保护命令：\`${nextStep.protectBranchCommand}\``)
  }
  lines.push('')
}
