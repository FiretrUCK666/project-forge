
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { buildContextBrief, extractDocPaths } from './context-brief.mjs'
import { extractCriteria } from './criteria-lock.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { parseDocFrontmatter } from './docs.mjs'
import { nextReviewRound } from './ledger.mjs'
import { parseAgentsProfile } from './profile.mjs'
import { getVisualBriefSummary } from './visual-brief.mjs'

/**
 * 抽出「设计方案 / 契约变更」整节正文与实际匹配的二级标题名，供动态 `--section` 指针命令使用。
 */
function extractDesignSectionWithHeading(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const matches = [...body.matchAll(/^##\s*([^\n]*(?:设计方案|方案与契约|设计说明|技术方案|技术设计|接口契约)[^\n]*)\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/gm)]
  if (matches.length === 0) return { text: '', heading: null }
  const firstHeading = String(matches[0][1] ?? '').trim()
  const content = matches
    .map((m) => m[2].replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim())
    .filter(Boolean)
    .join('\n\n')
  return { text: content, heading: firstHeading || null }
}

/**
 * 抽取非目标。
 *
 * 严格匹配独立非目标小节（避免吞掉「目标与非目标」混合节里的目标条目），
 * 并兼容行内条目形态（`- **本期不做**：…` / `- **非目标**：…`）。
 */
function extractNonGoals(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const out = []

  const section = /^#{2,3}\s+(?:[一二三四五六七八九十\d]+[、.]\s*)?(?:本期不做|明确不做|非目标|Non-Goals|明确边界与非目标)[^\n]*\n([\s\S]*?)(?=^#{2,3}\s|$(?![\s\S]))/mi.exec(body)?.[1]
  if (section) {
    for (const line of section.split('\n')) {
      const item = line.replace(/^\s*[-*]\s*/, '').trim()
      if (item && !item.startsWith('<!--') && !/^无$/.test(item)) out.push(item)
    }
  }

  const inline = /^-\s*\*\*(?:本期不做|明确不做|非目标|Non-Goals)\*\*\s*[:：]\s*(.+)$/gim
  for (const m of body.matchAll(inline)) {
    const item = m[1].trim()
    if (item && !out.includes(item)) out.push(item)
  }

  return out
}

const RECEIPT_LINES = Object.freeze([
  'conclusion: <pass | fail | blocked>',
  'head_sha: <7~40 位提交哈希>',
  'key_evidence: <核心验证命令与通过摘要>',
  'remaining_risks: <无 | 遗留风险与影响范围>',
  'next_action: <建议下一步动作>',
])

/**
 * 组装交接包。
 *
 * @param {object} opts
 * @param {string} opts.mainRoot 主仓根
 * @param {object} opts.ledger 任务账本
 * @param {object} opts.policy 工作流策略（含 requiredGates）
 * @param {string|null} opts.headSha 当前 HEAD
 * @returns {{ prompt: string, fields: object }}
 */
/**
 * 各角色的边界。键与 `workflow-policy.mjs` 的 `ownerRole` 一致。
 *
 * 这里只写**不随流程改动而失效**的东西：谁负责哪一段、谁不许做什么、交回来要给什么。
 * 具体步骤、命令、门禁一律不抄——那些由状态机与 Dev Profile 现算。
 */
const ROLE_BOUNDARY = Object.freeze({
  explore: Object.freeze({
    label: '只读探索者',
    scope: '只负责按需测绘仓库架构、模块边界、符号入口与相关文档切片。',
    mustNot: Object.freeze([
      '在探索阶段修改源码、配置或规划文档',
      '用主观猜想替代 `repo-map.mjs` / `doc-locate.mjs` 实际定位结果',
      '全量通读无关归档或大体积锁文件浪费上下文',
    ]),
    report: '**交回来要说清**：核心入口与可复用模块列表、依赖边界、`symbolCount` 与拟改造文件影响面。',
  }),
  plan: Object.freeze({
    label: '规划设计者',
    scope: '只负责收敛需求、冻结 C1..Cn 可验证验收标准与编写 PRD/SPEC/Todo，不参与实现。',
    mustNot: Object.freeze([
      '在多代理模式下自己兼任同一任务的实施者',
      '保留未清空的待拍板问题或 `<待填>` 占位桩去强行过审',
      '在验收标准里写没有可执行命令或断言的空泛套话',
    ]),
    report: '**交回来要说清**：生成的 PRD/SPEC/Todo 路径、冻结的 `C1..Cn`、门型与回滚路径，以及待 Critique 清单。',
  }),
  critique: Object.freeze({
    label: '规划内审者',
    scope: '只负责站在独立只读视角挑规划缺陷（`critique-scope` + 事实核对），不替规划者改文档。',
    mustNot: Object.freeze([
      '与规划作者为同一主体，或 Round 2+ 复用历史复核人上下文',
      '直接修改待审 SPEC/PRD/Todo 正文',
      '在文档仍有 `AUDIT_FAILED` 或未清待拍板项时给出 `critique-pass`',
    ]),
    report: '**交回来要说清**：逐条核实结果（`pass` / `reject`）、未闭环隐患列表，以及是否触发三轮停损。',
  }),
  implementer: Object.freeze({
    label: '实现者',
    scope: '只负责把认领的验收标准落进代码，并在隔离实施位里跑绿门禁。',
    mustNot: Object.freeze([
      '自己宣布通过——完成的标准是实证记录，不是你的判断',
      '自己合并，或替自己做独立审查',
      '在主工作区直接改（那会让「这次改动包含什么」说不清）',
      '为了让门禁变绿而改判据；判据有问题就如实说',
    ]),
    report: '**交回来要说清**：每条验收标准做了没、门禁的实测输出、提交 SHA、哪几条判据你判断实现不了以及为什么。',
  }),
  reviewer: Object.freeze({
    label: '审查者',
    scope: '只负责对着冻结的验收标准独立判断，不替实现者修代码。',
    mustNot: Object.freeze([
      '复用上一轮的上下文（Round 2 起必须新建独立子代理）',
      '把「读起来不顺」当成「不对」——只对判据负责',
      '在实现位里改文件；发现问题写进意见，交回实现者',
      '因为拿不到证据就默认通过',
    ]),
    report: '**交回来要说清**：每条判据的结论（通过 / 不通过 + 理由）、你实际跑过的验证、以及必须改和可以改分开列。',
  }),
  coordinator: Object.freeze({
    label: '协调者',
    scope: '只负责调度与验收，不代实现者提交、不代审查者下结论。',
    mustNot: Object.freeze([
      '自己改业务代码（协调者改代码，就没人能独立判断了）',
      '替被派出去的角色补跑它漏掉的流程',
      '把多个任务混进同一个实施位',
    ]),
    report: '**汇报要说清**：哪些任务在哪个阶段、卡在哪一步、下一步派给谁。',
  }),
  human: Object.freeze({
    label: '需要人拍板',
    scope: '这一步不是 AI 能自己决定的——要么弱化了门禁，要么触发了停损，要么需要外部凭据。',
    mustNot: Object.freeze([
      '自己替人做这个决定',
      '绕过这一步继续往下走',
      '把「没人反对」当成「有人同意」',
    ]),
    report: '**交回来要说清**：卡在哪个决定上、有哪几个选项、各自的代价是什么、建议选哪个以及为什么。',
  }),
  default: Object.freeze({
    label: '执行者',
    scope: '只做这一轮被交代的那一段，其余交给状态机驱动。',
    mustNot: Object.freeze([
      '越过当前阶段去做后面的步骤',
      '在没拿到实证的情况下声称做完',
    ]),
    report: '**交回来要说清**：做了什么、实测输出、还剩什么。',
  }),
})

/** 这仓有没有远端。没有远端时 `submit` 只记账本，交接包里要说清。 */
function factsHasRemote(mainRoot) {
  try {
    const cfg = readTextSafe(`${mainRoot}/.git/config`) ?? ''
    return /\[remote\s+"origin"\]/.test(cfg)
  } catch { return false }
}

export function buildHandoff({ mainRoot = null, ledger = null, role: explicitRole = null, policy = null, headSha = null, ownerRole = null, profile = null, current = null } = {}) {
  // 归档之后 specFile/todoFile 会指向 docs/archive/，而审核阶段正是归档之后。
  // 只读 specFile 会让审核交接包变成「没有登记验收标准」——判据在，只是搬了家。
  //
  // 两个根都要看：主仓里有已归档的文档，而这条任务的归档在**实施位**里，
  // 还没合并回主仓。只查一个根，两种情形各漏一半。
  const docRoots = mainRoot ? [mainRoot, ledger?.worktreePath ? join(mainRoot, ledger.worktreePath) : null].filter(Boolean) : []
  const pickDoc = (...candidates) => {
    for (const rel of candidates) {
      if (!rel) continue
      if (docRoots.some((root) => existsSync(join(root, rel)))) return rel
    }
    return null
  }
  const prdRel = pickDoc(ledger?.prdFile, ledger?.archivedPrdFile, ledger?.privatePrdFile)
  const specRel = pickDoc(ledger?.specFile, ledger?.archivedSpecFile, ledger?.privateSpecFile)
  const todoRel = pickDoc(ledger?.todoFile, ledger?.archivedTodoFile, ledger?.privateTodoFile)
  const readFromDocRoots = (rel) => {
    if (!rel) return ''
    for (const root of docRoots) {
      const abs = join(root, rel)
      if (existsSync(abs)) return readTextSafe(abs) ?? ''
    }
    return ''
  }
  const prdText = readFromDocRoots(prdRel)
  const specText = readFromDocRoots(specRel)
  const todoText = readFromDocRoots(todoRel)

  // 验收标准以 SPEC 为准，没有 SPEC 时退到 Todo 或 PRD。都没有就明说没有。
  const specFm = specText ? parseDocFrontmatter(specText) : null
  const todoFm = todoText ? parseDocFrontmatter(todoText) : null
  const prdFm = prdText ? parseDocFrontmatter(prdText) : null
  const fmScopeFiles = [
    ...(Array.isArray(specFm?.data?.scope_files) ? specFm.data.scope_files : []),
    ...(Array.isArray(todoFm?.data?.scope_files) ? todoFm.data.scope_files : []),
    ...(Array.isArray(prdFm?.data?.scope_files) ? prdFm.data.scope_files : []),
  ].map((s) => String(s ?? '').trim()).filter(Boolean)
  const extractChecklistWithFallback = (txt) => {
    const strict = extractCriteria(txt)
    if (strict.length > 0) return strict
    const out = []
    let inFence = false
    let nextAuto = 1
    for (const rawLine of String(txt ?? '').replace(/\r\n/g, '\n').split('\n')) {
      if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
      if (inFence) continue
      const m = /^- \[([ xX])\]\s+(.+)$/.exec(rawLine.trim())
      if (!m) continue
      out.push({ id: `C${nextAuto}`, text: m[2].trim(), checked: m[1].toLowerCase() === 'x' })
      nextAuto += 1
    }
    return out
  }
  let criteria = []
  let sourceDoc = null
  for (const [txt, rel] of [[specText, specRel], [todoText, todoRel], [prdText, prdRel]]) {
    if (!txt) continue
    const list = extractCriteria(txt)
    if (list.length > 0) { criteria = list; sourceDoc = rel; break }
  }
  if (criteria.length === 0 && ledger?.planBootstrap === true) {
    const cands = []
    for (const f of Array.isArray(ledger?.files) ? ledger.files : []) {
      const nf = posixPath(f).replace(/^\.\//, '')
      if (/^docs\/(?:specs|todo|prd)\/.*\.md$/.test(nf)) cands.push(nf)
    }
    for (const dirRel of ['docs/specs', 'docs/todo', 'docs/prd']) {
      for (const root of docRoots) {
        const dirAbs = join(root, dirRel)
        if (!existsSync(dirAbs)) continue
        try {
          for (const name of readdirSync(dirAbs).sort()) {
            if (name.endsWith('.md')) cands.push(`${dirRel}/${name}`)
          }
        } catch { /* ignore */ }
      }
    }
    const ordered = [
      ...cands.filter((p) => p.startsWith('docs/specs/')),
      ...cands.filter((p) => p.startsWith('docs/todo/')),
      ...cands.filter((p) => p.startsWith('docs/prd/')),
    ]
    for (const cand of [...new Set(ordered)]) {
      const txt = readFromDocRoots(cand)
      const list = extractCriteria(txt)
      if (list.length > 0) { criteria = list; sourceDoc = cand; break }
    }
  }
  if (criteria.length === 0) {
    for (const iss of Array.isArray(ledger?.issueContext) ? ledger.issueContext : []) {
      const list = extractChecklistWithFallback(iss?.body || iss?.summary || '')
      if (list.length > 0) {
        criteria = list
        sourceDoc = iss?.number ? `issue#${iss.number}` : 'issueContext'
        break
      }
    }
  }
  if (criteria.length === 0 && ledger?.prContext && typeof ledger.prContext === 'object') {
    const list = extractChecklistWithFallback(ledger.prContext.body || ledger.prContext.summary || '')
    if (list.length > 0) {
      const prNum = ledger.prNumber ?? ledger.prContext.number ?? null
      criteria = list
      sourceDoc = prNum ? `pr#${prNum}` : 'prContext'
    }
  }
  if (!sourceDoc) sourceDoc = specText ? specRel : (todoText ? todoRel : (prdText ? prdRel : null))
  const paths = [...new Set([...fmScopeFiles, ...extractDocPaths(specText), ...extractDocPaths(todoText), ...extractDocPaths(prdText)])]
  // 去重要按「说了同一件事」判，不是按字符串相等：
  // SPEC 写「不引入第三方解析器（零依赖是不变量）；不做 LSP 级语义分析」，
  // Todo 写「第三方解析器、LSP 级语义分析」——字面不同，内容重复。
  const rawGoals = [...extractNonGoals(specText), ...extractNonGoals(todoText), ...extractNonGoals(prdText)]
  const seenFragments = new Set()
  const nonGoals = []
  for (const g of rawGoals) {
    // 一条非目标里常有多个分句（「不引入第三方解析器；不做 LSP 级语义分析」）。
    // 拆成片段比「整条包含」准得多：Todo 那边写的正是拆开后的短语。
    const fragments = g
      .split(/[；;。、]|\s+and\s+/)
      // 去掉「不引入 / 不做 / 不」这类动作前缀：两边说的往往是同一件事，
      // 只是一边带动词、另一边是名词短语。
      .map((s) => s.replace(/^(?:不引入|不新增|不做|不改|不|勿|别)/, "").replace(/[（）()\s、，,。.]/g, ""))
      .filter((s) => s.length >= 3)
    const fresh = fragments.filter((f) => ![...seenFragments].some((k) => k.includes(f) || f.includes(k)))
    if (fresh.length === 0) continue
    for (const f of fresh) seenFragments.add(f)
    nonGoals.push(g)
  }

  // 结合变更路径与验收关键词经单源 context-brief 抽取常青目录、Top-3 文档切片与 feature-map 上下文。
  const wtCandidate = mainRoot && ledger?.worktreePath ? join(mainRoot, ledger.worktreePath) : null
  const locateRoot = wtCandidate && existsSync(wtCandidate) ? wtCandidate : mainRoot
  const keywords = [
    ledger?.taskId,
    parseDocFrontmatter(specText || todoText || prdText)?.data?.title,
    ...criteria.slice(0, 6).map((c) => c.text),
  ].filter(Boolean)
  const role = String(explicitRole ?? ownerRole ?? ledger?.ownerRole ?? ledger?.role ?? 'implementer')
  const contextBrief = buildContextBrief(locateRoot, {
    paths,
    keywords,
    excludeFiles: [specRel, todoRel, prdRel, 'AGENTS.md'].filter(Boolean),
    limit: 3,
    budgetLines: 48,
    role,
  })
  const isExploreOrCritic = role === 'explore' || role === 'critic' || role === 'critique'
  const isArchRole = isExploreOrCritic || role === 'plan'
  const evergreenToc = contextBrief.evergreenToc
  const otherEvergreenDocs = contextBrief.otherEvergreenDocs
  const totalEvergreenDocs = contextBrief.totalEvergreenDocs
  const relatedSlices = contextBrief.relatedSlices
  const featureMapContext = {
    exists: contextBrief.featureMap.exists,
    corrupt: contextBrief.featureMap.corrupt,
    warning: contextBrief.featureMap.warning,
    matchedFeatures: contextBrief.featureMap.matchedFeatures.map((f) => ({ id: f.id, name: f.name, matchedBy: f.matchedBy })),
    businessFlows: contextBrief.featureMap.businessFlows,
    verificationTools: contextBrief.featureMap.verificationTools.map((t) => ({ id: t.id, kind: t.kind, command: t.command, riskLevel: t.riskLevel })),
    testRefs: contextBrief.featureMap.testRefs,
    domainSummary: contextBrief.featureMap.domainSummary ?? [],
    upstream: contextBrief.featureMap.upstream ?? [],
    downstream: contextBrief.featureMap.downstream ?? [],
    matchedFlows: contextBrief.featureMap.matchedFlows ?? [],
  }

  // 验收命令从 AGENTS.md 的 Dev Profile 读，不在这里编。
  const devProfile = mainRoot ? parseAgentsProfile(mainRoot) : null
  const quick = devProfile?.quickTest ?? null
  const smoke = devProfile?.smokeVerify ?? null
  const full = devProfile?.fullTest ?? null
  const mergeGate = devProfile?.mergeGate ?? null

  const lines = []
  lines.push(`# 交接包：${ledger?.taskId ?? '(未知任务)'}`)
  lines.push('')
  lines.push('> 这一段由 `flow next --handoff` 机械生成，可以直接粘给子代理。')
  lines.push('> 抽不到的项写「没有登记」——不编。照着一句编出来的话干活，比什么都不给更危险。')
  lines.push('')

  // 现在这一步：直接搬 flow next 算出来的结果，不在这里重新推。
  //
  // 之前只写「下一步从 flow next 查」，等于让人自己去问。可 flow next 刚刚
  // 算过一遍——phase / nextAction / command 都在手上，丢掉它们没有任何道理。
  // 这是**现算的派生值**，不是手抄的流程清单：状态机改了它自动跟上。
  if (current?.phase) {
    lines.push('## 现在这一步')
    lines.push('')
    lines.push(`阶段：\`${current.phase}\`${current.ownerRole ? `　由 \`${current.ownerRole}\` 负责` : ''}`)
    if (current.nextAction) {
      lines.push('')
      lines.push(current.nextAction)
    }
    if (current.command) {
      lines.push('')
      lines.push('```')
      lines.push(current.command)
      lines.push('```')
    }
    if (current.recordCommand) {
      lines.push('')
      lines.push('完成检查后记录审查结论：')
      lines.push('```')
      lines.push(current.recordCommand)
      lines.push('```')
    }
    if ((current.blockingReasons ?? []).length > 0) {
      lines.push('')
      lines.push(`挡住它的原因：\`${current.blockingReasons.join('、')}\``)
    }
    lines.push('')
    lines.push(`**做完这一步，再跑一次 \`flow next --task ${ledger?.taskId ?? '<任务号>'}\` 拿下一步。**`)
    lines.push('不要自己推断走到哪了——阶段是账本算出来的，不是猜出来的。')
    lines.push('')
  }

  lines.push('## 你在做什么')
  lines.push('')
  if (criteria.length > 0) {
    lines.push(`这个切片认领了 ${criteria.length} 条验收标准（来源：\`${sourceDoc}\`）：`)
    lines.push('')
    for (const c of criteria) lines.push(`- [ ] **${c.id}**：${c.text}`)
  } else {
    lines.push('**没有登记验收标准。** 这不等于「随便做」——先把 SPEC 或 Todo 里的 `C1..Cn` 写出来再动手；')
    lines.push('动手前定不下来，说明这件事还没想清楚。')
  }
  lines.push('')

  const issueCtxItems = Array.isArray(ledger?.issueContext) ? ledger.issueContext.filter((x) => x?.fetched) : []
  const prCtx = ledger?.prContext && ledger.prContext.fetched ? ledger.prContext : null
  if (issueCtxItems.length > 0 || prCtx) {
    lines.push('## 关联工单与 PR 上下文')
    lines.push('')
    for (const iss of issueCtxItems) {
      lines.push(`- **Issue #${iss.number}**${iss.state ? ` (${iss.state})` : ''}：${iss.title ?? '(无标题)'}`)
      const sum = String(iss.summary ?? iss.body ?? '').trim().split('\n').slice(0, 6).join(' / ').slice(0, 260)
      if (sum) lines.push(`  - 摘要：${sum}`)
    }
    if (prCtx) {
      lines.push(`- **PR #${prCtx.number ?? ledger?.prNumber ?? '?'}**${prCtx.state ? ` (${prCtx.state})` : ''}：${prCtx.title ?? '(无标题)'}`)
      const sum = String(prCtx.summary ?? prCtx.body ?? '').trim().split('\n').slice(0, 6).join(' / ').slice(0, 260)
      if (sum) lines.push(`  - 摘要：${sum}`)
    }
    lines.push('')
  }

  lines.push('## 能改哪里')
  lines.push('')
  if (paths.length > 0) {
    lines.push('影响路径（来自规划文档）：')
    lines.push('')
    for (const p of paths) lines.push(`- \`${p}\``)
  } else {
    lines.push('**没有登记影响路径。** 动手前先自己定位，并在提交说明里写清实际改了哪些文件。')
  }
  lines.push('')
  lines.push('**只准在隔离位改。** 主工作区一律不碰——那会让「这次改动包含什么」变得说不清。')
  lines.push(`- 实施位：\`${ledger?.worktreePath ?? '(分支模式，无独立工作区)'}\``)
  lines.push(`- 分支：\`${ledger?.branch ?? '(未登记)'}\` → 基线 \`${ledger?.baseBranch ?? 'main'}\``)
  lines.push(`- 起始 HEAD：\`${headSha ?? ledger?.baseSha ?? '(未登记)'}\``)
  lines.push('')

  const { text: design, heading: designHeading } = extractDesignSectionWithHeading(specText)
  const visibleDesign = isExploreOrCritic ? '' : design
  const isLongDesign = Boolean(visibleDesign && (visibleDesign.split('\n').length > 24 || visibleDesign.length > 1500))
  const designPointer = (visibleDesign && specRel && designHeading)
    ? `node .agents/skills/dev-explore/scripts/doc-locate.mjs --file "${specRel}" --section "${designHeading}"`
    : null
  if (visibleDesign) {
    lines.push('## 怎么做（来自 SPEC 的设计方案）')
    lines.push('')
    if (isLongDesign && designPointer) {
      lines.push(`设计方案较长（${visibleDesign.split('\n').length} 行），按需执行指针命令定位阅读：`)
      lines.push('')
      lines.push(`- \`${designPointer}\``)
    } else {
      lines.push(visibleDesign)
    }
    lines.push('')
  }

  if (evergreenToc.length > 0 || otherEvergreenDocs.length > 0) {
    lines.push('## 常青文档章节目录（Evergreen TOC）')
    lines.push('')
    for (const doc of evergreenToc) {
      const hStr = doc.headings.length > 0 ? doc.headings.map((h) => `${h.title}(L${h.line})`).join(' | ') : '(无二级标题)'
      lines.push(`- \`${doc.path}\` [${doc.source}]: ${hStr}`)
      lines.push(`  - 定位命令：\`${doc.locateCommand}\``)
    }
    if (otherEvergreenDocs.length > 0) {
      lines.push(`- 其余常青文档（共 ${totalEvergreenDocs} 份）：${otherEvergreenDocs.map((p) => `\`${p}\``).join('、')}（运行 \`node .agents/skills/dev-explore/scripts/doc-locate.mjs --file <path>\`）`)
    }
    lines.push('')
  }

  if (relatedSlices.length > 0) {
    lines.push('## 相关规范与架构切片（Top-3 按需定位）')
    lines.push('')
    lines.push('仅注入与当前影响路径最相关的 3 处锚点（不塞整篇文档）；需细读某节正文时运行对应命令：')
    lines.push('')
    for (const s of relatedSlices) {
      const label = s.section ? `（${s.section}）` : ''
      lines.push(`- \`${s.relPath}:${s.startLine}-${s.endLine}\`${label}${s.summary ? ` — ${s.summary}` : ''}`)
      lines.push(`  - 绝对路径：\`${s.absPath}\``)
      lines.push(`  - 复读命令：\`${s.locateCommand}\``)
    }
    lines.push('')
  }

  const hasTopoSection = featureMapContext.domainSummary.length > 0
    || featureMapContext.upstream.length > 0
    || featureMapContext.downstream.length > 0
    || featureMapContext.matchedFlows.length > 0
  if (featureMapContext.businessFlows.length > 0 || featureMapContext.verificationTools.length > 0 || hasTopoSection) {
    lines.push('## 受波及业务流与验证工具（来自 docs/feature-map.json）')
    lines.push('')
    if (isArchRole && featureMapContext.domainSummary.length > 0) {
      lines.push(`- 域总览：${featureMapContext.domainSummary.slice(0, 6).map((d) => `${d.id}(${d.featureCount})`).join('、')}`)
    }
    if (featureMapContext.downstream.length > 0) {
      lines.push(`- 下游波及（1-hop）：${featureMapContext.downstream.slice(0, 6).map((n) => `\`${n.id}\`(${n.entrypoint ?? n.domain ?? '-'})`).join('、')}`)
    }
    if (featureMapContext.upstream.length > 0) {
      lines.push(`- 上游依赖（1-hop）：${featureMapContext.upstream.slice(0, 6).map((n) => `\`${n.id}\`(${n.entrypoint ?? n.domain ?? '-'})`).join('、')}`)
    }
    if (featureMapContext.matchedFlows.length > 0) {
      for (const mf of featureMapContext.matchedFlows.slice(0, 6)) lines.push(`- 跨模块流：${mf.summary}`)
    }
    if (featureMapContext.businessFlows.length > 0) {
      for (const bf of featureMapContext.businessFlows.slice(0, 6)) lines.push(`- 业务流：${bf}`)
    }
    if (featureMapContext.verificationTools.length > 0) {
      for (const vt of featureMapContext.verificationTools.slice(0, 5)) {
        lines.push(`- 验证工具 \`${vt.id}\`（${vt.riskLevel ?? 'medium'}）：\`${vt.command}\``)
      }
    }
    lines.push('')
  }

  if (nonGoals.length > 0) {
    lines.push('## 不许顺手做什么')
    lines.push('')
    for (const g of nonGoals) lines.push(`- ${g}`)
    lines.push('')
  }

  lines.push('## 怎么算做完')
  lines.push('')
  if (quick || smoke || full || mergeGate) {
    if (quick) lines.push(`- 快测：\`${quick}\``)
    if (smoke) lines.push(`- 冒烟：\`${smoke}\``)
    if (full) lines.push(`- 全测：\`${full}\``)
    if (mergeGate) lines.push(`- 合前：\`${mergeGate}\``)
    lines.push('')
    lines.push('**跑出来的才算做完。** 拿不出实际通过输出，不要说「已验证」。')
  } else {
    lines.push('**`AGENTS.md` 的 Dev Profile 里没有登记验收命令。** 先补齐再动手——没有验收命令的完成是自我声明。')
  }
  lines.push('')

  // 角色边界，不是流程清单。
  //
  // 流程（认领 → 实施 → 归档 → 实证 → 提审 → 审查 → 合并）由 `workflow-policy.mjs`
  // 的状态机驱动，`flow next` 永远输出当前这一步该干什么。这里再抄一份就会漂移：
  // 状态机加了一步，这份清单不会跟着加，两边开始各说各话。
  //
  // 抄不走的只有一件事：**这个角色该做与不该做的边界**。它不随流程改动而失效。
  const taskId = ledger?.taskId ?? null
  // `ownerRole` 由状态机算出，`ledger.role` 是平台身份——不是一回事。
  const boundary = ROLE_BOUNDARY[role] ?? ROLE_BOUNDARY.default

  lines.push('## 你的角色与边界')
  lines.push('')
  lines.push(`**${boundary.label}**。${boundary.scope}`)
  lines.push('')
  for (const n of boundary.mustNot) lines.push(`- 不要${n}`)
  lines.push('')
  lines.push('## 证明边界与角色隔离前提')
  lines.push('')
  lines.push('- **CLI 可机械实证边界**：仓外 `.git/project-forge-flow/planning-provenance.json`（`ownerHeaderHash` 防未经 `doc-plan link --owner-reason` 篡改 `owner:`）、`implRoot !== mainRoot` 隔离 worktree 边界，以及声明角色（`planningOwner ∪ previous_owners` / `implementerId` / `reviewerId`）互斥。')
  lines.push('- **协调器调度前提**：不同角色代理实际运行在彼此隔离的独立上下文会话中，该隔离前提由宿主协调器调度保证，CLI 子进程不伪造 OS 进程级多会话证明。')
  lines.push('')
  lines.push('**下一步永远从这里查，不要凭记忆推断**：')
  lines.push('')
  lines.push(`\`node .agents/skills/dev-flow/scripts/flow.mjs next --task ${taskId ?? '<任务号>'}\`  `)
  lines.push('它读账本、输出当前阶段该做什么。状态在账本里，不在你的上下文里——')
  lines.push('被打断、被重派，换一个会话读同一份账本就接得上。')
  lines.push('')
  lines.push(boundary.report)
  lines.push('')
  const rounds = Array.isArray(ledger?.rounds) ? ledger.rounds : []
  const last = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const mustFix = Array.isArray(last?.mustFix) ? last.mustFix : []
  const shouldFix = Array.isArray(last?.shouldFix) ? last.shouldFix : []
  const blockers = Array.isArray(last?.blockers) ? last.blockers : []
  const legacyFindings = Array.isArray(last?.findings) ? last.findings : []
  const formatItem = (f) => {
    if (typeof f === 'string') return f
    const body = f?.summary ?? f?.text ?? f?.message ?? f?.title ?? ''
    if (body) return f?.id ? `[${f.id}] ${body}` : String(body)
    return f ? JSON.stringify(f) : ''
  }
  const reworkItems = [
    ...mustFix.map((f) => ({ severity: 'must', text: formatItem(f) })),
    ...blockers.map((f) => ({ severity: 'blocker', text: formatItem(f) })),
    ...shouldFix.map((f) => ({ severity: 'should', text: formatItem(f) })),
    ...legacyFindings.map((f) => ({ severity: f?.severity === 'must' ? 'must' : 'should', text: formatItem(f) })),
  ].filter((it) => it.text)
  const reworkFeedback = last ? {
    round: last.round ?? null,
    verdict: last.verdict ?? null,
    summary: last.summary ?? null,
    mustFix,
    shouldFix,
    blockers,
    totalCount: reworkItems.length,
  } : null

  if (ledger?.explored?.symbolCount != null || Array.isArray(ledger?.explored?.topModules)) {
    lines.push('## 已自动探明仓库基线')
    lines.push('')
    if (ledger.explored.symbolCount != null) lines.push(`- 索引符号数：${ledger.explored.symbolCount}`)
    if (Array.isArray(ledger.explored.topModules) && ledger.explored.topModules.length > 0) {
      lines.push(`- 核心模块：${ledger.explored.topModules.slice(0, 8).join('、')}`)
    }
    lines.push('')
  }

  if (role === 'implementer' && last && (reworkItems.length > 0 || last.verdict === 'fail' || last.verdict === 'changes_requested')) {
    lines.push('## 上一轮返工意见（按此逐项修复后再交审）')
    lines.push('')
    lines.push(`上一轮（Round ${last.round ?? '?'}）结论：\`${last.verdict ?? '未记录'}\`${last.summary ? ` — ${last.summary}` : ''}`)
    if (reworkItems.length > 0) {
      lines.push('')
      for (const item of reworkItems.slice(0, 20)) {
        const tag = item.severity === 'must' ? '必修' : (item.severity === 'blocker' ? '阻断' : '建议')
        lines.push(`- [${tag}] ${item.text}`)
      }
      if (reworkItems.length > 20) lines.push(`- （另有 ${reworkItems.length - 20} 条，见账本）`)
    }
    lines.push('')
  }

  // 审核侧要的两样：这一轮该看什么、上一轮提了什么。
  // 实现侧不需要它们（那是审查者的事），所以按角色给，不给所有人。
  if (role === 'explore') {
    lines.push('## 只读探索范围', '')
    lines.push('1. 按需定位架构文档与模块边界：`doc-locate.mjs` / `repo-map.mjs`。')
    lines.push('2. 记录真实探索证据：`flow.mjs explore --task ' + (taskId || '<id>') + '`。', '')
  } else if (role === 'plan') {
    lines.push('## 规划冻结要求', '')
    lines.push('1. 确认 `owner` 明确且与实施者分离，清零所有待拍板问题。')
    lines.push('2. 冻结可证伪的 `C1..Cn` 验收标准并附上真实技术锚点。', '')
  } else if (role === 'critique') {
    lines.push('## 独立规划内审顺序', '')
    lines.push('1. 运行 `doc-plan.mjs critique-scope --file <docPath> --reviewer <id>` 核实增量与声明。')
    lines.push('2. 仅依据实证与文档实质性记录 `critique-pass` 或 `critique-reject`。', '')
  }

  if (role === 'reviewer' || role === 'human') {
    const nextRound = nextReviewRound(ledger)

    lines.push('## 这一轮该看什么')
    lines.push('')
    lines.push(`Round ${nextRound}。` + (nextRound >= 2
      ? '**必须新建独立子代理**——复用上一轮的上下文见过自己提的意见，那一轮已经不算独立审。'
      : ''))
    lines.push('')
    if (last) {
      lines.push(`上一轮（Round ${last.round ?? '?'}）的结论：\`${last.verdict ?? '未记录'}\``)
      if (last.headSha && headSha && last.headSha === headSha) {
        lines.push('')
        lines.push('**当前 HEAD 与上一轮审查时相同**——什么都没改。同样的输入不会得出不同的结论，')
        lines.push('先让实现者按上一轮意见改，改完再复审。')
      }
      if (reworkItems.length > 0) {
        lines.push('')
        lines.push(`上一轮提了 ${reworkItems.length} 条（mustFix=${mustFix.length} / blockers=${blockers.length} / shouldFix=${shouldFix.length}）：`)
        for (const item of reworkItems.slice(0, 20)) {
          const tag = item.severity === 'must' ? '必修' : (item.severity === 'blocker' ? '阻断' : '建议')
          lines.push(`- [${tag}] ${item.text}`)
        }
        if (reworkItems.length > 20) lines.push(`- （另有 ${reworkItems.length - 20} 条，见账本）`)
      }
    } else {
      lines.push('第一轮，按完整范围审。')
      lines.push('')
      lines.push('审出的每一条都要记下来——那是下一轮的范围依据。不记，下一轮又从零开始。')
    }
    lines.push('')
    lines.push('**只对着这些判据判断**：上面的验收标准是冻结的。判据本身有问题就提出来，')
    lines.push('但不要因为「读起来不顺」判不通过。')
    lines.push('')
    lines.push('## 先跑，再判')
    lines.push('')
    lines.push('不要靠读 diff 下结论——静态读代码看不出「这条判据到底能不能被证伪」，')
    lines.push('而判据能不能被证伪，正是这一轮唯一要回答的问题。')
    lines.push('')
    lines.push('按这个顺序做，每一步都要留输出：')
    lines.push('')
    const rpPrefix = 'node .agents/skills/dev-review/scripts/review-pack.mjs'
    const rpTarget = taskId ? `--task ${taskId} --round ${nextRound}` : '--task <任务号>'
    lines.push('1. **机械包建基线**：`' + `${rpPrefix} ${rpTarget}` + '`（仅输出 `hunkIndex` 与门禁摘要，不打印补丁正文）。')
    lines.push('2. **复跑判据（实证）**：在审查工作位跑能证伪每条 C* 的命令：`' + `${rpPrefix} check-empirical ${rpTarget} [--cmd "<命令>"]` + '`。跑不通，这条判据有问题。')
    lines.push('3. **故障注入（变红）**：挑一处核心判定改坏后运行 `' + `${rpPrefix} check-fault --phase fail ${rpTarget} --cmd "<命令>"` + '`（未改工作区报 `BLOCKED_FAULT_NO_MUTATION`，仍退出 0 报 `BLOCKED_FAULT_NOT_CAUGHT`）。')
    lines.push('4. **还原复绿**：`git checkout -- .` 之后运行 `' + `${rpPrefix} check-fault --phase restore ${rpTarget} --cmd "<命令>"` + '` 校验工作区回到基线指纹并重新通过（脏残留报 `BLOCKED_DIRTY_FAULT_RESIDUE`）。')
    lines.push('5. **按需读 diff**：上述实证闭环通过后再运行 `' + `${rpPrefix} ${rpTarget} --include-diff` + '` 取全文（未过闭环退出码 3 返回 `BLOCKED_EMPIRICAL_FIRST`）。')
    lines.push('')
    lines.push('记结论时 \`--evidence\` 必填，写你实际跑的命令与输出摘要。没有佐证的通过，与没通过是一回事。')
    lines.push('')
  }

  lines.push('## 回执格式与篇幅纪律（上限 15 行，详报外置）')
  lines.push('')
  lines.push('- 回复给协调者总行数严格 **<= 15 行**；长日志、完整 diff 与全量测试明细须写入任务账本 / PR / 临时日志文件，禁止直接刷屏粘贴。')
  lines.push('- 固定 5 行回执骨架：')
  lines.push('```text')
  for (const rl of RECEIPT_LINES) lines.push(rl)
  lines.push('```')
  lines.push('')

  const gates = policy?.requiredGates ?? []
  if (gates.length > 0) {
    // 层级名 → Dev Profile 里的真实命令。印一个 `gate` 出来等于什么都没说。
    const TIER_TO_PROFILE = {
      gate: ['mergeGate', 'merge-gate'],
      full: ['fullTest', 'full-test'],
      smoke: ['smokeVerify', 'smoke-verify'],
      quick: ['quickTest', 'quick-test'],
    }
    lines.push('## 这门改动的必过门')
    lines.push('')
    for (const g of gates) {
      const hit = TIER_TO_PROFILE[g]
      const cmd = hit ? profile?.[hit[0]] : null
      if (cmd && String(cmd).trim() && String(cmd).trim() !== 'none') {
        lines.push(`- \`${g}\` 档：\`${String(cmd).trim()}\``)
      } else {
        lines.push(`- \`${g}\` 档（Dev Profile 里没有对应命令，按上面的「怎么算做完」跑）`)
      }
    }
    lines.push('')
  }

  const visualBrief = mainRoot
    ? getVisualBriefSummary(mainRoot, { briefKey: ledger?.briefKey ?? null, taskId: ledger?.taskId ?? null, masterPrdRel: prdRel })
    : null
  const receiptTemplate = RECEIPT_LINES.join('\n')
  if (visualBrief) {
    lines.push('## Living Visual Brief 快照')
    lines.push('')
    lines.push(`- \`${visualBrief.briefKey}\` (${visualBrief.confirmedState}, prototypes=${visualBrief.prototypeCount}${visualBrief.selectedPrototypeId ? `, selected=${visualBrief.selectedPrototypeId}` : ''}) -> ${visualBrief.htmlUri}`)
    lines.push('')
  }
  const fields = {
    taskId: ledger?.taskId ?? null,
    sourceDoc,
    criteriaCount: criteria.length,
    criteria,
    paths,
    scopeFiles: fmScopeFiles,
    nonGoals,
    design: visibleDesign,
    ...(designPointer ? { designPointer } : {}),
    contextBrief,
    visualBrief,
    explored: ledger?.explored ?? null,
    reworkFeedback,
    receiptTemplate,
    commands: { quick, smoke, full, mergeGate },
    requiredGates: gates,
  }
  Object.defineProperties(fields, {
    relatedSlices: { value: relatedSlices, enumerable: false, configurable: true },
    evergreenToc: { value: evergreenToc, enumerable: false, configurable: true },
    otherEvergreenDocs: { value: otherEvergreenDocs, enumerable: false, configurable: true },
    totalEvergreenDocs: { value: totalEvergreenDocs, enumerable: false, configurable: true },
    featureMapContext: { value: featureMapContext, enumerable: false, configurable: true },
  })
  return {
    role,
    prompt: `${lines.join('\n').trimEnd()}\n`,
    fields,
  }
}
