/**
 * render.mjs —— 勘察结果的 Markdown 呈现层。
 *
 * 它只管「怎么把已经算好的事实排成人能读的样子」，不碰文件系统、不跑 git、
 * 不认识任何生态——**输入是 survey() 的返回值，输出是一段文本**。
 *
 * 从 survey.mjs 搬出来，是因为它原先与勘察逻辑挤在一个文件里：那是三百多行
 * 纯排版代码，占全文十分之一，而它和「怎么读出这些事实」没有任何共同点。
 * 混在一起时，改一个标题格式要在一份三千行的勘察引擎里翻半天。
 *
 * 纯函数，零副作用：同样的输入永远得到同样的输出。
 */

import { COMMAND_KEYS, isNoteKey } from './protocol.mjs'

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
  if (s.dsh !== undefined) {
    const d = s.dsh
    L.push(`- DSH 包名：${d.packageName ?? '未声明'}`)
    L.push(`- DSH 补丁文件：${d.patchFile ?? '缺'}`
      + (d.bundlePatch === undefined ? '' : `；清单声明 ${d.bundlePatch.path}（${d.bundlePatch.exists ? '存在' : '缺失'}）`))
    L.push(`- DSH 入口：host ${d.hasHostEntry ? '有' : '缺'}；client ${d.hasClientEntry ? '有' : '无'}`
      + `（dsh.client 声明${d.hasClientDecl ? '有' : '无'}）`)
    L.push(`- DSH 声明式元数据：manifestVersion ${d.hasManifestVersion ? '有' : '无'}`
      + `；engines.dsh ${d.enginesDsh ?? '未声明'}；包根图标 ${d.hasIcon ? '有' : '无'}`
      + '（都是声明，宿主当前是否强制执行另查专章）')
    if (d.filesHasLib !== undefined) L.push(`- DSH 发布范围：files ${d.filesHasLib ? '含' : '缺'} lib；${d.filesHasPatch ? '含' : '缺'}补丁`)
    if (d.libTracked !== undefined) L.push(`- DSH 构建产物跟踪：lib ${d.libTracked ? '已被跟踪' : '未被跟踪'}（与 files 是两套集合）`)
    if (d.hostRuntimeInDeps === true) L.push('- **DSH 依赖放错**：宿主运行时进了 dependencies，应为 peer')
    if (d.discoveryCarrierLikely === false) L.push('- **DSH 发现载体可能缺失**：补丁文本里没有出现包名')
    if (Array.isArray(d.unknownKeys) && d.unknownKeys.length > 0) {
      L.push(`- **DSH 清单有不认识的字段**：${d.unknownKeys.join('、')}`
        + '——可能是新版宿主加的东西，按六问现场核实，不要猜，也不要照旧流程装懂')
    }
    for (const w of d.warnings ?? []) L.push(`- DSH 注意：${w}`)
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
          + '——宿主按目录发现、按 name 校验，两者须逐字相同，否则整份被丢弃**')
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
  for (const [k, v] of Object.entries(s.docs)) {
    if (k === 'readmePair' || k === 'readmeSections' || k === 'workflowAutomation') continue
    if (v === undefined) L.push(`- ${k}：缺`)
    else if (Array.isArray(v)) L.push(`- ${k}：${v.length === 0 ? '缺' : v.join('、')}`)
    else if (typeof v === 'object' && v.file !== undefined) L.push(`- ${k}：${v.file}（${humanBytes(v.bytes)}）`)
    else L.push(`- ${k}：${JSON.stringify(v)}`)
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
  const ibt = s.ignores?.ignoredButTracked
  if (Array.isArray(ibt) && ibt.length > 0) {
    L.push(`- **已被跟踪又被忽略**：${ibt.length} 个（忽略规则对已跟踪文件无效，`
      + `这些文件仍在版本库里；要移除须先从索引删除）`)
    for (const p of ibt.slice(0, 5)) L.push(`  - ${p}`)
  }
  L.push('')
  L.push('## 体量')
  L.push('')
  L.push(`- 文件数：${s.scale.files}　总计：${humanBytes(s.scale.bytes)}`)
  if (s.scale.truncated === true) {
    L.push('- **走查达到上限被截断**，上面的体量是下界而非准确值')
  }
  L.push(`- 依赖/产物目录：${s.outputs.heavyDirsPresent.join('、') || '无'}`)
  return L.join('\n')
}
