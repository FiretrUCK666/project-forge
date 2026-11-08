/**
 * render.mjs —— 勘察结果的 Markdown 呈现层。
 *
 * 它只管「怎么把已经算好的事实排成人能读的样子」，不碰文件系统、不跑 git、
 * 不认识任何生态——**输入是 survey() 的返回值，输出是一段文本**。
 *
 * 独立成模块，是因为它与勘察逻辑挤在一个文件里时是三百多行
 * 纯排版代码，占全文十分之一，而它和「怎么读出这些事实」没有任何共同点。
 * 混在一起时，改一个标题格式要在一份三千行的勘察引擎里翻半天。
 *
 * 纯函数，零副作用：同样的输入永远得到同样的输出。
 */

import { COMMAND_KEYS, isNoteKey } from './protocol.mjs'
import { HOST_ECOSYSTEMS } from '../ecosystems.mjs'

export function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function toMarkdown(s) {
  const L = []
  const yn = (v) => (v === undefined || v === null ? '—' : String(v))
  L.push(`# 勘察结果：${s.target.name}`)
  L.push('')
  L.push(`路径：\`${s.target.path}\``)
  L.push('')
  L.push('## 版本控制')
  L.push('')
  if (s.git.available !== true) L.push('- git 不可用')
  else if (s.git.present !== true) L.push('- 尚未初始化仓库')
  else {
    if (s.git.isRepoRoot === false) {
      L.push('- **本目录不是仓库根**，它处在另一个仓库的工作区内：')
      L.push(`  - 外层仓库根：\`${yn(s.git.workTreeRoot)}\``)
      L.push('  - 下面这些值**属于外层仓库**，不代表本目录的状态。建库前先与用户确认边界，')
      L.push('    在确认之前不要提交、也不要推送。')
    }
    // 提交数读不到时**说出来**，不要印一个 0 —— 0 的含义是「还没有任何提交」，
    // 与「问了但没问出来」是两件事，后者会让一个已有历史的仓库被带向首次提交。
    const commitsText = s.git.commitsState === 'unreadable'
      ? '**读不到**（不是「零个提交」）'
      : yn(s.git.commits)
    L.push(`- 分支：${yn(s.git.branch)}　提交数：${commitsText}　未提交：${yn(s.git.dirty)}`)
    if (s.git.ahead > 0 || s.git.behind > 0) {
      L.push(`- 相对上游：领先 ${s.git.ahead} 个提交、落后 ${s.git.behind} 个`
        + (s.git.behind > 0 ? '——推送前先取回远端' : ''))
    }
    if (Array.isArray(s.git.remotes) && s.git.remotes.length > 1) {
      L.push(`- 远端（${s.git.remotes.length} 个）：${s.git.remotes.join('、')}`)
      for (const [name, url] of Object.entries(s.git.remoteUrls ?? {})) {
        L.push(`  - ${name}：${url === undefined ? '地址读不到' : url}`)
      }
      L.push(`  - 上游跟踪：${s.git.upstream === undefined ? '未设置' : s.git.upstream}`)
    } else {
      L.push(`- 远端：${s.git.remote === undefined ? '无' : s.git.remote}`)
      if (s.git.upstream === undefined) L.push('- 上游跟踪：未设置')
    }
    // 角色决定「推送与发版能做到哪一步」：它和远端地址是两件事——地址说「连着哪」，角色
    // 说「你是谁」。判不了时明确写出来，而不是静默按维护者处理。
    if (s.git.role !== undefined) {
      const roleText = s.git.role === 'maintainer'
        ? '维护者（可推主干、打标签、发版）'
        : s.git.role === 'contributor-fork'
          ? '**贡献者（Fork）**：只推自己的分支、开改动请求，不推主干、不打标签、不发布'
          : '**判不了**——按贡献者处置（少做几步，而不是做错一步）'
      L.push(`- 角色：${roleText}`)
      if (s.git.roleReason !== undefined && s.git.roleReason !== '') L.push(`  - 依据：${s.git.roleReason}`)
      if (s.git.declaredRepo !== undefined) {
        L.push(`  - 项目声明的源仓库：${s.git.declaredRepo.url}（来自 ${s.git.declaredRepo.source}）`)
      }
    }
    L.push(`- 署名：${yn(s.git.identity.name)} <${yn(s.git.identity.email)}>（${s.git.identity.scope}）`)
    if (s.git.identity.globalEmail !== undefined) {
      L.push(`- 全局署名邮箱：${s.git.identity.globalEmail}（与仓库级不一致时以仓库级为准）`)
    }
    // 推送认证单独成行，**与「远端地址有没有」分开说**：有地址不等于能推上去，
    // 这两件事最常见的组合就是「能推但建不了新的」或反过来。
    const auth = s.git.auth
    if (auth !== undefined) {
      const label = auth.https === 'available' ? '**可用**（直接推，不要要求用户配置凭据）'
        : auth.https === 'no-credential' ? '**取不到凭据**（才需要提示用户配置）'
          : auth.https === 'n/a' ? '不适用'
            : '**未确认**（不等于没有凭据，不要据此让用户重新登录）'
      L.push(`- 推送认证（HTTPS）：${label}`)
      if (auth.helper !== undefined) {
        L.push(`  - 凭据助手：${auth.helper}（${auth.helperScope ?? '层级未知'}）`
          + '——注意它可能在 system 层，`~/.gitconfig` 不存在不代表没有配置')
      }
      if (auth.httpsReason !== undefined) L.push(`  - 依据：${auth.httpsReason}`)
      if (auth.network === 'unreachable') {
        L.push(`- 远端可达性：**不可达**（${auth.networkReason ?? '原因未识别'}）`
          + '——网络不通时不要去查凭据，那是两件事')
      } else if (auth.network === 'undetermined' && auth.networkReason !== undefined) {
        L.push(`- 远端可达性：未确认（${auth.networkReason}）`)
      }
    }
    if (Array.isArray(s.git.historyAuthors) && s.git.historyAuthors.length > 1) {
      L.push(`- 历史署名 ${s.git.historyAuthors.length} 种：${s.git.historyAuthors.join('；')}`)
    }
    if (Array.isArray(s.git.tags) && s.git.tags.length > 0) {
      // 列表头就是最近的（标签按创建时间倒序取的），所以取前几个。
      const shown = s.git.tags.slice(0, 5)
      L.push(`- 已有版本标签 ${s.git.tags.length} 个（由近及远）：${shown.join('、')}`
        + (s.git.tags.length > shown.length ? '（仅列最近 5 个）' : ''))
    } else if (s.git.present === true && s.git.tags === undefined) {
      L.push('- 已有版本标签：**读不到**（标签列表没取到，不是「一个都没有」）')
    }
  }
  L.push('')
  L.push('## 生态判定')
  L.push('')
  L.push(`- 判定结果：${s.ecosystem.kinds.join(' / ')}`)
  L.push(`- 依据：${s.ecosystem.evidence.join('、') || '无'}`)
  // 多包仓库要单独说：命令该在哪一层跑、产物在哪个子包里，都取决于这份事实。
  if (s.workspace?.declared === true) {
    L.push(`- 多包仓库：由 ${s.workspace.tools.join('、')} 声明，`
      + `展开出 ${s.workspace.packages.length} 个子包`
      + (s.workspace.packages.length > 0 ? `（${s.workspace.packages.slice(0, 6).join('、')}` : '')
      + (s.workspace.packages.length > 6 ? ' 等）' : (s.workspace.packages.length > 0 ? '）' : '')))
    if (s.workspace.note !== undefined) L.push(`  - ${s.workspace.note}`)
  }
  if (s.host !== undefined) {
    // 这些行由**描述符自己写**：行文里的名词（补丁层、浏览器半区、`dsh.client`）
    // 是宿主自己的说法，渲染层不该认识它们。加一个宿主就是给那个对象加一个
    // `describe(facts)`，这里一行不用改。
    const descriptor = HOST_ECOSYSTEMS.find((d) => d.id === s.host.id)
    if (typeof descriptor?.describe === 'function') L.push(...descriptor.describe(s.host))
    else L.push(`- 宿主生态：${s.host.id}（该生态还没有登记给人看的说明）`)
  }
  if (s.ecosystem.skillDropped !== undefined) {
    L.push(`- **本仓库的能力目录会被宿主丢弃**：${s.ecosystem.skillDropped}——症状是「目录在、技能不在」，先按专章核对宿主契约`)
  }
  if (Array.isArray(s.localSkills) && s.localSkills.length > 0) {
    L.push(`- 本地 skills ${s.localSkills.length} 个：${s.localSkills.map((x) => x.path).join('、')}`)
    for (const x of s.localSkills) {
      // 有具体成因就先报成因：「入口多了一层」比「入口缺失」更能指到要改的那一处。
      if (x.dropped !== undefined) L.push(`  - **${x.path}：${x.dropped}**`)
      else if (x.corrupt === true) L.push(`  - ${x.path}：SKILL.md 损坏或缺失，先修再用`)
      // 目录名与 frontmatter 的 name 不一致：宿主要求两者逐字相同，不一致时**整份会被丢弃**，
      // 而症状与「压根没装」一模一样。判定早就算出来了（`nameOk`），不渲染出来等于白算。
      else if (x.nameOk === false) {
        L.push(`  - **${x.path}：目录名与 frontmatter 的 name 不一致`
          + `${x.skillName === undefined ? '' : `（name: ${x.skillName}）`}`
          + '——宿主不校验目录名与 name 一致，但对齐两者属于通用约定，可避免人工定位混淆**')
      }
    }
  }
  L.push('')
  L.push('## 可执行命令')
  L.push('')
  // **正向清单**：只有 COMMAND_KEYS 里的键算命令。排除式的黑名单要求每加一个新键
  // 就补一次，漏掉的那个会被当命令渲染出来——`note`（「该生态的命令推导尚未实现」）
  // 就这样被渲染成一条可执行命令，而它的存在又让下面那条「没有命令」永远不出现：
  // P7 要求如实汇报「这个项目一行都没验证过」的那条信号，就这样被一条注释顶掉了。
  const cmds = Object.entries(s.commands).filter(([k, v]) => COMMAND_KEYS.includes(k) && typeof v === 'string')
  if (cmds.length === 0) L.push('- 未推导出任何命令（正常结果：说明项目没声明这些命令，'
    + '不代表错误；此时 P7 的验证不成立，见 SKILL.md）')
  else for (const [k, v] of cmds) L.push(`- ${k}：\`${v}\``)
  // 说明与命令分开列：它们解释「这条命令从哪来」，本身不是命令。`note` 是普通说明，
  // 不套反引号——套上会让一段话看起来像一个可执行的名字（`xxxNote` 那类键名才需要）。
  for (const [k, v] of Object.entries(s.commands)) {
    if (!isNoteKey(k) || typeof v !== 'string') continue
    L.push(k === 'note' ? `  - 说明：${v}` : `  - \`${k}\`：${v}`)
  }
  if (s.commands?.multipleEcosystems !== undefined) {
    L.push('')
    L.push(`- **本项目命中多种生态**：${s.commands.multipleEcosystems.join('、')}。`
      + '上面每类命令只保留了一个（同名字段会互相覆盖）。实际执行前请按生态分别确认，'
      + '不要把某一个生态的命令当成全部。')
  }
  L.push('')
  L.push('## 发布相关事实')
  L.push('')
  const a = s.artifacts ?? {}
  L.push(`- 发布范围声明：${a.publishScope === undefined ? '无'
    : `${a.publishScope.kind}（${a.publishScope.entries.length} 项）`}`)
  L.push(`- 发布前钩子：${a.hooks === undefined || a.hooks.length === 0 ? '无' : a.hooks.join('、')}`)
  L.push(`- 标记为不可发布：${a.private === true ? '是' : '否'}`)
  L.push(`- 产物目录存在：${a.distDirsPresent === undefined || a.distDirsPresent.length === 0
    ? '无' : a.distDirsPresent.join('、')}`)
  L.push(`- 忽略配置文件：${a.hasNpmIgnore === true ? '有' : '无'}`)
  if (Array.isArray(a.buildEntryFiles) && a.buildEntryFiles.length > 0) {
    L.push(`- 构建入口文件：${a.buildEntryFiles.join('、')}`
      + '（Makefile 的目标名已按实际内容推导进「可执行命令」；Dockerfile 只记存在，'
      + '它说的是打包方式，不是构建命令）')
  }
  const reqs = a.runtimeRequirements ?? []
  if (reqs.length === 0) {
    L.push('- 声明的运行环境下限：**未声明**'
      + '（写面向使用者的文档时，取不到就不要写那一节，也不要编一个数字）')
  } else {
    L.push('- 声明的运行环境下限（写环境要求那一节的唯一权威来源）：')
    for (const r of reqs) L.push(`  - ${r.runtime} ${r.range}（${r.declaredIn}）`)
  }
  if (a.declaredVersion !== undefined) {
    if (a.versionAligned === true) L.push(`- 标签与版本号：对齐（清单 ${a.declaredVersion}）`)
    else if (a.versionAligned === false) {
      L.push(`- **标签与版本号未对齐**：清单 ${a.declaredVersion}，已有标签 ${(a.versionAlignedTags ?? []).join('、') || '无'}`
        + '——不一致会让后续自动化对不上')
    }
  }
  if (a.obsidianArtifacts !== undefined) {
    const o = a.obsidianArtifacts
    // main.js 根目录缺席是正常态（官方模板要求它只进发布附件，不进版本库）：
    // “有”只说明构建过，“无”不说明断链——断链看的是发布附件，不是仓库根。
    // mainJsIgnored 区分“有意忽略”与“还没构建过”。
    const mainState = o.mainJs === true ? '有（构建产物在仓库根，发布前确认附件即可）'
      : o.mainJsIgnored === true ? '无（已被忽略规则排除，符合官方模板：只进发布附件）'
        : '无（且未被忽略：要么还没构建，要么忽略规则漏了 main.js）'
    L.push(`- Obsidian 发布：manifest.json 有；main.js ${mainState}；`
      + `styles.css ${o.stylesCss ? '有' : '无（可选，无样式时两处都可省略）'}；`
      + `versions.json ${o.hasVersionsJson ? '有' : '无（只在 minAppVersion 变化时才需要）'}`)
    if (o.manifestId !== undefined) {
      L.push(`- Obsidian 插件 id：${o.manifestId}`
        + (o.manifestIdShapeOk === true ? '（形状符合：小写连字符、无 obsidian、无 plugin 结尾）'
          : o.manifestIdShapeOk === false ? '（**形状可疑**：应为小写字母与连字符、不含 obsidian、不以 plugin 结尾，提交审核会被拒）'
            : ''))
    }
  }
  if (a.pythonMeta !== undefined) {
    const p = a.pythonMeta
    const lacks = []
    if (p.hasBuildSystem !== true && a.pythonBuild?.hasBuildSystem !== true) lacks.push('构建后端')
    if (p.hasReadme !== true) lacks.push('readme')
    if (p.hasLicense !== true) lacks.push('license')
    if (p.hasRequiresPython !== true) lacks.push('requires-python')
    const lacksText = lacks.length === 0 ? '构建后端/readme/license/requires-python 都有'
      : '缺 ' + lacks.join('、') + '（前两者缺了服务端大概率拒绝，末者缺了装到旧版难定位）'
    L.push('- Python 发布元数据：' + lacksText
      + (p.hasDynamicVersion === true ? '；版本号走 dynamic（tag 对齐按后端取值，不要照抄文件里的字面）' : ''))
  }
  if (a.cargoMeta !== undefined) {
    const c = a.cargoMeta
    const over = []
    if (typeof c.keywordsCount === 'number' && c.keywordsCount > 5) over.push(`keywords ${c.keywordsCount} 个（上限 5）`)
    if (typeof c.categoriesCount === 'number' && c.categoriesCount > 5) over.push(`categories ${c.categoriesCount} 个（上限 5）`)
    const overText = over.length > 0 ? '；**' + over.join('、') + '，超了服务端拒绝**' : ''
    L.push('- Rust 发布元数据：license ' + (c.license ? '有' : '**缺**') + '；description ' + (c.description ? '有' : '**缺**')
      + (c.hasEdition === true ? '；edition 有' : '；edition 未声明（缺省 2015 可发布，建议显式声明）')
      + overText)
  }
  L.push('')
  L.push('## 忽略规则')
  L.push('')
  const ig = s.ignores ?? {}
  L.push(`- 忽略文件：${ig.gitignore === undefined ? '**缺**（没有它，依赖与产物目录会被提交）'
    : `有（${ig.gitignore.lines} 条有效规则）`}`)
  L.push(`- 文本属性声明：${ig.gitattributes === undefined
    ? '缺（行尾不一致会让产物在不同机器上重建出不同字节）' : '有'}`)
  if (Array.isArray(ig.unignoredOutputDirs) && ig.unignoredOutputDirs.length > 0) {
    L.push(`- **存在但未被忽略的目录**：${ig.unignoredOutputDirs.join('、')}`)
    L.push(`  - ${ig.unignoredNote}`)
  }
  if (Array.isArray(ig.ignoredButTracked) && ig.ignoredButTracked.length > 0) {
    L.push(`- **已被跟踪又被忽略**：${ig.ignoredButTracked.length} 个`
      + '（忽略规则对已跟踪文件无效，它们仍在版本库里；要移除须先从索引删除）')
    for (const p of ig.ignoredButTracked.slice(0, 5)) L.push(`  - ${p}`)
  }
  L.push('')
  L.push('## 文档现状')
  L.push('')
  // 值有三类形状，各给一句人话；认不出的按 JSON 兜底。数组元素可能是字符串，
  // 也可能是 `{ file, bytes }` 这样的记录——直接 `join` 会把后者渲染成
  // `[object Object]`，那是报告里最糟的一种输出：它看起来像出了故障，却查不出哪一处。
  const describe = (x) => {
    if (typeof x === 'string') return x
    if (x === null || x === undefined) return String(x)
    if (typeof x === 'object') {
      if (typeof x.file === 'string') {
        return x.bytes === undefined ? x.file : `${x.file}（${humanBytes(x.bytes)}）`
      }
      if (typeof x.path === 'string') return x.path
      if (typeof x.name === 'string') return x.name
    }
    return JSON.stringify(x)
  }
  for (const [k, v] of Object.entries(s.docs)) {
    if (k === 'readmePair' || k === 'readmeSections' || k === 'workflowAutomation') continue
    if (v === undefined) L.push(`- ${k}：缺`)
    else if (Array.isArray(v)) L.push(`- ${k}：${v.length === 0 ? '缺' : v.map(describe).join('、')}`)
    else if (typeof v === 'object' && v.file !== undefined) L.push(`- ${k}：${describe(v)}`)
    else L.push(`- ${k}：${describe(v)}`)
  }
  const pair = s.docs?.readmePair
  if (pair !== undefined) {
    L.push(`- **双语 README**：默认 \`${pair.default}\`，另有 ${pair.variants.join('、')}`)
    L.push(`  - ${pair.note}`)
  }
  const sections = s.docs?.readmeSections
  if (Array.isArray(sections) && sections.length > 0) {
    // 只报「有哪些节」，不报「缺哪几节」：README 的结构本来就没有标准，
    // 命令行工具、库、数据项目的合理结构各不相同。给出事实，判断留给读的人。
    L.push(`- 主 README 的节（${sections.length} 个）：${sections.join('　')}`)
    L.push('  - 这是事实不是结论。对照 `templates/readme.md` 看该补什么——'
      + '但**不要为了对齐模板而重排作者的编排**，README 的结构没有标准。')
  }
  const auto = s.docs?.workflowAutomation
  if (auto !== undefined) {
    L.push(`- 自动化现状：工作流 ${auto.files.join('、') || '无'}；`
      + `发布 job：${auto.hasReleaseJob ? '有' : '无'}；Secrets 引用：${auto.usesSecrets ? '有' : '无'}；`
      + `OIDC 短时身份：${auto.usesOidc ? '有' : '无'}（npm 自动发布靠它，无则对照可信发布接线步骤）`)
    if (!auto.hasReleaseJob) L.push('  - 无发布 job 时对照 `templates/ci-release.yml` 看该不该补')
    else {
      // 发布 job 的三处形状只报“有无”，结论由 review 下：
      // RELEASE_TOKEN 引用、contents 写权限、全历史检出，三者缺一都值得问一句。
      const shapeLacks = []
      if (auto.usesReleaseToken !== true) shapeLacks.push('未引用约定的 RELEASE_TOKEN')
      if (auto.hasContentsWrite !== true) shapeLacks.push('未声明 contents: write')
      if (auto.hasFetchDepthZero !== true) shapeLacks.push('检出缺 fetch-depth: 0（起草读不到上一个标签）')
      if (shapeLacks.length > 0) L.push(`  - 发布 job 形状缺口：${shapeLacks.join('、')}`)
      if (Array.isArray(auto.releaseTriggerTags) && auto.releaseTriggerTags.length > 0) {
        L.push(`  - 标签触发器原文：${auto.releaseTriggerTags.join('、')}（Obsidian 项目须为裸版本形状，见专章第七节）`)
      }
      const ecoPublishes = []
      if (auto.hasNpmPublish === true) ecoPublishes.push('npm publish')
      if (auto.hasPypiPublish === true) ecoPublishes.push('pypi 上传')
      if (auto.hasCargoPublish === true) ecoPublishes.push('cargo publish')
      if (ecoPublishes.length > 0) L.push(`  - 生态发布动作痕迹：${ecoPublishes.join('、')}（按对应专章核对接线，不要只看 Release 建了没有）`)
    }
    if (auto.truncated === true) {
      L.push(`  - **有工作流只读了前 ${auto.headLimit} 字符，未报不等于没有**：发布 job 藏在后面的大文件需手工确认`)
    }
  }
  L.push('')
  L.push('## 风险')
  L.push('')
  const r = s.risks
  /** 三态渲染：读不到就说读不到，不能读成「不在库里」。 */
  const trackedText = (t) => t === true ? '**已在版本库里**'
    : t === false ? '尚未跟踪'
      : '**无法确认是否已入库**（受控文件清单没取到，请手工核对）'
  if (r.secretFiles.length === 0) {
    L.push('- 敏感文件：无')
  } else {
    const names = r.secretFiles.slice(0, 5).map((h) => h.path).join('、')
    L.push(`- 敏感文件：${r.secretFiles.length} 个（${names}）`)
    for (const hit of r.secretFiles.slice(0, 5)) {
      // 名字像但内容没确认的（扫不到）要单独标出来——「没扫到」不是「没问题」。
      const unconfirmed = hit.confirmed === undefined ? '，内容未能确认' : ''
      L.push(`  - ${hit.path}（${trackedText(hit.tracked)}；`
        + `${hit.ignored === true ? '已被忽略规则排除' : hit.ignored === false ? '未被忽略' : '忽略状态读不到'}`
        + `${unconfirmed}）`)
    }
  }
  L.push(`- 内容里的凭据形状：${r.secretContent.length === 0 ? '无' : r.secretContent.length + ' 处'}`)
  if (r.secretContent.length > 0) {
    for (const hit of r.secretContent.slice(0, 10)) {
      // tracked 这一个比特决定处置：未跟踪的能从这次提交排除，已在历史里的只能轮换。
      L.push(`  - ${hit.path}:${hit.line ?? '?'}（${hit.kind}，${trackedText(hit.tracked)}）`)
    }
    L.push('  - 处置分情况，见 references/version-control.md 的「密钥与敏感信息门控」：'
      + '不要因为一处历史凭据就停下全部工作。')
  }
  const leaks = r.homePathLeaks.filter((h) => h.kind === 'leak')
  const benign = r.homePathLeaks.filter((h) => h.kind !== 'leak')
  if (leaks.length > 0) {
    L.push(`- **本机私有路径 ${leaks.length} 处（需要处理）**：`)
    for (const h of leaks.slice(0, 5)) L.push(`  - ${h.path}（${h.sample}）—— ${h.advice}`)
  } else {
    L.push('- 本机私有路径：无')
  }
  if (benign.length > 0) {
    // 与真泄漏分开报：处置建议相反，混在一起会让人去改不该改的东西
    L.push(`- 形似路径但无需处理 ${benign.length} 处（已按性质分类，处置建议各不相同）：`)
    for (const h of benign.slice(0, 5)) {
      L.push(`  - ${h.path}（${h.sample}，${h.kind}）—— ${h.advice}`)
    }
  }
  L.push(`- 大文件（≥20MB）：${r.largeFiles.length === 0 ? '无' : r.largeFiles.map((f) => f.path).slice(0, 5).join('、')}`)
  L.push(`- 嵌套仓库：${r.nestedRepos.length === 0 ? '无' : r.nestedRepos.join('、')}`)
  const scan = r.contentScan
  if (scan !== undefined) {
    L.push(`- 内容扫描覆盖：${scan.filesScanned} 个文件（${scan.scope}）`
      + (scan.truncated ? ' **已达文件数上限被截断，未报不等于没有**' : ''))
    if (scan.depthLimited > 0) {
      L.push(`- **有 ${scan.depthLimited} 个子目录因嵌套过深未进入**`
        + `（超过 ${scan.maxDepth} 层）——里面若放了凭据不会被发现。`
        + '确认那些目录不需要检查，或手工看一眼。')
    }
    if ((scan.unreadableDirCount ?? 0) > 0) {
      L.push(`- **有 ${scan.unreadableDirCount} 个子目录读不出来（权限或锁定），整棵子树没进勘察**：`
        + `${(scan.unreadableDirs ?? []).slice(0, 5).join('、')}`
        + '——「没报」在这些目录里不等于「没有」。看一眼权限，或手工检查那几个目录。')
    }
  }
  L.push('')
  L.push('## 体量')
  L.push('')
  L.push(`- 文件数：${s.scale.files}　总计：${humanBytes(s.scale.bytes)}`)
  if (s.scale.truncated === true) {
    L.push('- **走查达到上限被截断**，上面的体量是下界而非准确值')
  }
  L.push(`- 依赖/产物目录：${s.outputs.heavyDirsPresent.join('、') || '无'}`)

  const plan = computeSurveyActionPlan(s)
  if (plan.length > 0) {
    L.push('')
    L.push('## 下一步行动导航')
    L.push('')
    L.push(...plan)
  }

  return L.join('\n')
}

/**
 * 计算勘察后的下一步行动导航（Action Plan）。
 *
 * **顺序是有意义的，不是排版**：先报「不修会让后面全部白做」的（未忽略的产物目录、暴露的
 * 凭据），再报「接上次的活」，最后才是常规的按需文档。三组混在一起平铺，读的人会从中间
 * 随手挑一条做，而第一条才是唯一紧急的那条。
 *
 * 每一组只在**有事实**时出现：没有工作记录就不提工作记录，没配远端就不提协作模板。空条目会
 * 稀释真正的警告——一份什么都提一句的报告等于什么都没提。
 */
export function computeSurveyActionPlan(s) {
  const lines = []
  const refs = []
  const alerts = []
  const actions = []
  const kinds = s.ecosystem?.kinds ?? []
  const git = s.git ?? {}
  const docs = s.docs ?? {}

  // ── 第一组：先修这个，否则后面的动作会把它一起带进版本库 ──────────────────
  const unignored = s.ignores?.unignoredOutputDirs ?? []
  if (unignored.length > 0) {
    const shown = unignored.slice(0, 5).join('、')
    alerts.push(`- **先补忽略规则**：${shown}${unignored.length > 5 ? ' 等' : ''} 已经存在，却没有`
      + '被忽略规则覆盖——下一次提交会把整个目录写进历史（体积、平台差异、其中可能的本机配置）。')
  }
  const leaked = (s.risks?.secretFiles ?? []).filter((f) => f.ignored === false && f.tracked !== true)
  if (leaked.length > 0) {
    const shown = leaked.slice(0, 5).map((f) => f.path).join('、')
    alerts.push(`- **先处置凭据**：${shown}${leaked.length > 5 ? ' 等' : ''} 是凭据形状，既没被忽略`
      + '也没入库——现在提交就会把它带上去。先加忽略规则或改成占位值。')
  }

  // ── 第二组：接上次的活。有工作记录就说明这件事还没做完 ────────────────────
  if (docs.workItems !== undefined) {
    const w = docs.workItems
    actions.push(`- **先读工作记录断点再动手**：\`${w.dir}/\` 有 ${w.count} 份工作记录`
      + `${w.readable === false ? '（目录读不到，先确认权限）' : ''}——上一个会话留下的接手点在那里，`
      + '别从零重来。')
  }

  // ── 第三组：角色。它决定这次能做哪几步，做错一步就收不回来 ────────────────
  if (git.role === 'contributor-fork') {
    const contributing = docs.contributing?.file
    const how = contributing === undefined
      ? '按 `references/collaboration.md` 第一节的贡献者路线'
      : `按项目自己的 \`${contributing}\``
    actions.push(`- **这是别人的仓库（Fork）**：不推主干、不打标签、不发版。${how}走：`
      + '与上游同步 → 从主干拉新分支 → 门禁全绿 → 推自己仓库的分支 → 向正本开改动请求。')
  } else if (git.role === 'undetermined' && typeof git.remote === 'string' && git.remote !== '') {
    actions.push('- **角色判不了**（项目没声明源仓库）：按贡献者处置——只推自己的分支。'
      + '确认自己就是维护者时，把源仓库写进项目清单再重跑勘察，这条就不出现了。')
  }

  // ── 第四组：契约与协作设施，按事实给命令 ─────────────────────────────────
  if (!docs.agents) {
    refs.push('- `references/docs-set.md`（编写 AGENTS.md 契约与文档套装）')
    actions.push('- 生成项目契约：`node scripts/compose-agents.mjs .`')
  } else if (typeof git.remote === 'string' && git.remote !== '') {
    // 建好远端之后契约要回刷一次：远端与协作那半部分在首次生成时必然还不存在。
    const sections = docs.agentsSections ?? []
    const hasCollab = sections.some((t) => /协作|工作记录|提案/.test(t))
    if (!hasCollab) {
      actions.push('- 契约里还没有协作那半部分（远端与「改动怎么落地」）：建好远端之后必须回跑一次 '
        + '`node scripts/compose-agents.mjs .`，那次回刷才把它们补进去。')
    }
  }
  if (typeof git.remote === 'string' && git.remote !== '' && docs.agents !== undefined) {
    if (docs.prTemplate !== true) {
      actions.push('- 落一份提案模板到 `.github/pull_request_template.md`（骨架见 '
        + '`templates/pull-request-template.md`），然后 `--record` 记账；单人不收贡献可跳过。')
    }
    if (docs.issueTemplates !== true) {
      actions.push('- 落问题模板到 `.github/ISSUE_TEMPLATE/`（缺陷与需求各一份，骨架见 `templates/`），'
        + '否则每份报告都要来回追问一轮；单人不收贡献可跳过。')
    }
    if (docs.workflowAutomation === undefined || (docs.workflowAutomation.files ?? []).length === 0) {
      actions.push('- 落检查自动化到 `.github/workflows/`（骨架见 `templates/ci-check.yml`），'
        + '否则「本机能过」不等于「换台机器也能过」。')
    }
  }

  if (s.git?.dirty > 0 || (s.git?.ahead ?? 0) > 0) {
    actions.push(`- 工作区有未提交或未推送变动（dirty: ${s.git?.dirty ?? 0}, ahead: ${s.git?.ahead ?? 0}），`
      + '收尾前先提交并推送；走分支时推的是分支，不是主干。')
  }

  // ── 按需加载的参考文档 ──────────────────────────────────────────────────
  if (git.present !== true) {
    refs.push('- `references/version-control.md`（配置 Git 版本管理）')
  } else if (!git.remote) {
    refs.push('- `references/remote-github.md`（配置 GitHub 远端仓库与协作设施）')
  }
  if (s.artifacts?.publishableManifest !== undefined || s.artifacts?.declaredVersion !== undefined) {
    if (kinds.includes('node')) refs.push('- `references/publish-npm.md`（npm 发布链路）')
    if (kinds.includes('python')) refs.push('- `references/publish-python.md`（PyPI 发布链路）')
    if (kinds.includes('rust')) refs.push('- `references/publish-rust.md`（crates.io 发布链路）')
    if (kinds.includes('go')) refs.push('- `references/publish-go.md`（Go 模块标签发布）')
  }
  if (git.role === 'contributor-fork' || git.role === 'undetermined') {
    refs.push('- `references/collaboration.md`（角色、分支路线与合并后收尾）')
  }
  if (s.host?.id === 'dsh' || kinds.includes('dsh-plugin')) {
    refs.push('- `references/plugins/dsh.md`（DSH 插件规范）')
  }
  const hasPlugin = kinds.some((k) => ['dsh-plugin', 'obsidian-plugin', 'vscode-extension'].includes(k))
  if (!hasPlugin) {
    refs.push('- *（本项目未命中插件生态，无需读取 `references/plugins/*`）*')
  }

  if (alerts.length > 0) {
    lines.push('### 【先修这个】')
    lines.push(...alerts)
    lines.push('')
  }
  lines.push('### 【按需加载的参考文档】')
  if (refs.length > 0) lines.push(...refs)
  else lines.push('- 当前无需额外加载专章文档')

  lines.push('')
  lines.push('### 【立即可执行的确定性动作】')
  if (actions.length > 0) lines.push(...actions)
  else lines.push('- 运行交付门禁检查：`node scripts/review.mjs .`')

  return lines
}
