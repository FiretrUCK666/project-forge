
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe } from './git.mjs'
import { locateTopSlicesForPaths } from './doc-locator.mjs'
import { parseDocFrontmatter, parseDocFilename } from './docs.mjs'
import { matchFeatureMapForPaths } from './feature-map.mjs'
import { nextReviewRound } from './ledger.mjs'
import { discoverEvergreenDocs } from './profile.mjs'

/** 从一份规划文档里抽出 `- [ ] Cn: ...` 的原文条目。 */
function extractCriteria(text) {
  const out = []
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = /^- \[[ xX]\]\s+(C\d+)\s*[:：]\s*(.+)$/.exec(line.trim())
    if (m) out.push({ id: m[1], text: m[2].trim() })
  }
  return out
}

/**
 * 从「影响路径」一类表述里抽出反引号包住的相对路径。
 *
 * 两种写法都要认：小节形态（`## 影响路径` 带一列）与行内条目形态
 * （`- **影响路径**：a、b、c`）。短文档常用后者——判据关心的是「说没说」，
 * 不是「用了哪种排版」。只认小节会让一整类文档的影响路径静默变成空。
 *
 * 抽出来的还得是**能改的东西**：`kit/**` 是通配、`node scripts/equip.mjs .` 是命令、
 * `.agents/skills/` 是产物目录——把它们列进「能改哪里」只会让子代理以为可以乱动。
 */
function extractPaths(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const parts = []

  const section = /^##[^\n]*(?:影响路径|影响范围|涉及文件|改动路径)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)?.[1]
  if (section) parts.push(section)

  const inline = /^-\s*\*\*(?:影响路径|影响范围|涉及文件|改动路径)\*\*\s*[:：]\s*(.+)$/gm
  for (const m of body.matchAll(inline)) parts.push(m[1])

  const found = []
  for (const part of parts) {
    for (const m of part.matchAll(/`([^`\n]+)`/g)) {
      const rel = m[1].trim()
      if (!/[/\\]/.test(rel)) continue
      if (/^(?:TODO|TBD)$/i.test(rel)) continue
      if (/[*?{}]/.test(rel)) continue                      // 通配不是可改的具体文件
      if (/\s/.test(rel)) continue                          // 带空格的几乎都是命令
      if (/^(?:\.agents|node_modules|dist|build)\//.test(rel)) continue  // 产物目录，改源码才对
      found.push(rel)
    }
  }
  return [...new Set(found)]
}

/**
 * 抽出「设计方案 / 契约变更」整节正文。
 *
 * ## 为什么这一节必须进交接包
 *
 * 交接包此前只给三样：验收标准（做什么）、影响路径（能改哪）、非目标（别顺手做什么）。
 * 看起来齐了，其实缺的是**怎么做**——而那一节恰恰写着「改哪个函数、签名怎么变、
 * 数据从哪来、失败怎么降级」。缺了它，实现子代理只能自己重新推导一遍，
 * 推错了就是「每条判据都过、实现却不对」。
 *
 * 这也解释了为什么 SPEC 会越来越厚：写的时候知道不写清就没人知道怎么做。
 */
function extractDesignSection(text) {
  const body = String(text ?? "").replace(/\r\n/g, "\n")
  const m = /^##[^\n]*(?:设计方案|方案与契约|设计说明|技术方案)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)
  if (!m) return ""
  // 去掉 section 标记与 HTML 注释，交接包里不需要它们
  return m[1]
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/**
 * 从 `## 本期不做` / `## 非目标` 里抽出条目文本。
 *
 * 两种写法都要认：小节形态（`## 本期不做` 带几条列表）与行内条目形态
 * （`- **本期不做**：…`）。短文档常用后者——判据关心的是「说没说」，不是「用了哪种排版」。
 */
function extractNonGoals(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const out = []

  const section = /^##[^\n]*(?:本期不做|明确不做|非目标|Non-Goals)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)?.[1]
  if (section) {
    for (const line of section.split('\n')) {
      const item = line.replace(/^\s*[-*]\s*/, '').trim()
      if (item && !item.startsWith('<!--') && !/^无$/.test(item)) out.push(item)
    }
  }

  const inline = /^-\s*\*\*(?:本期不做|明确不做|非目标)\*\*\s*[:：]\s*(.+)$/gm
  for (const m of body.matchAll(inline)) {
    const item = m[1].trim()
    if (item && !out.includes(item)) out.push(item)
  }

  return out
}

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

export function buildHandoff({ mainRoot, ledger, policy = null, headSha = null, ownerRole = null, profile = null, current = null }) {
  // 归档之后 specFile/todoFile 会指向 docs/archive/，而审核阶段正是归档之后。
  // 只读 specFile 会让审核交接包变成「没有登记验收标准」——判据在，只是搬了家。
  //
  // 两个根都要看：主仓里有已归档的文档，而这条任务的归档在**实施位**里，
  // 还没合并回主仓。只查一个根，两种情形各漏一半。
  const docRoots = [mainRoot, ledger?.worktreePath ? join(mainRoot, ledger.worktreePath) : null].filter(Boolean)
  const pickDoc = (live, archived) => {
    for (const rel of [live, archived]) {
      if (!rel) continue
      if (docRoots.some((root) => existsSync(join(root, rel)))) return rel
    }
    return null
  }
  const specRel = pickDoc(ledger?.specFile, ledger?.archivedSpecFile)
  const todoRel = pickDoc(ledger?.todoFile, ledger?.archivedTodoFile)
  const readFromDocRoots = (rel) => {
    if (!rel) return ''
    for (const root of docRoots) {
      const abs = join(root, rel)
      if (existsSync(abs)) return readTextSafe(abs) ?? ''
    }
    return ''
  }
  const specText = readFromDocRoots(specRel)
  const todoText = readFromDocRoots(todoRel)

  // 验收标准以 SPEC 为准，没有 SPEC 时退到 Todo。两者都没有就明说没有。
  const criteria = specText ? extractCriteria(specText) : extractCriteria(todoText)
  const sourceDoc = specText ? specRel : (todoText ? todoRel : null)
  const paths = [...new Set([...extractPaths(specText), ...extractPaths(todoText)])]
  // 去重要按「说了同一件事」判，不是按字符串相等：
  // SPEC 写「不引入第三方解析器（零依赖是不变量）；不做 LSP 级语义分析」，
  // Todo 写「第三方解析器、LSP 级语义分析」——字面不同，内容重复。
  const rawGoals = [...extractNonGoals(specText), ...extractNonGoals(todoText)]
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

  // 结合变更路径与验收关键词抽取相关度 Top-3 文档切片，替代全文塞入。
  const wtCandidate = ledger?.worktreePath ? join(mainRoot, ledger.worktreePath) : null
  const locateRoot = wtCandidate && existsSync(wtCandidate) ? wtCandidate : mainRoot
  const keywords = [
    ledger?.taskId,
    parseDocFrontmatter(specText || todoText)?.data?.title,
    ...criteria.slice(0, 6).map((c) => c.text),
  ].filter(Boolean)
  let relatedSlices = []
  try {
    const ev = discoverEvergreenDocs(locateRoot)
    const priorityFiles = (ev?.markdownDocs ?? []).map((d) => d.path)
    relatedSlices = locateTopSlicesForPaths(locateRoot, {
      paths,
      keywords,
      excludeFiles: [specRel, todoRel].filter(Boolean),
      priorityFiles,
      limit: 3,
      budgetLines: 48,
    }).map((s) => ({
      absPath: s.absPath,
      relPath: s.relPath,
      kind: s.kind,
      section: s.section,
      startLine: s.startLine,
      endLine: s.endLine,
      score: s.score,
      summary: s.summary,
      locateCommand: s.locateCommand,
    }))
  } catch {
    relatedSlices = []
  }

  let featureMapContext = { exists: false, corrupt: false, warning: null, matchedFeatures: [], businessFlows: [], verificationTools: [], testRefs: [] }
  try {
    const fm = matchFeatureMapForPaths(locateRoot, paths, keywords)
    featureMapContext = {
      exists: Boolean(fm.exists),
      corrupt: Boolean(fm.corrupt),
      warning: fm.warning ?? null,
      matchedFeatures: (fm.matchedFeatures ?? []).map((f) => ({ id: f.id, name: f.name, matchedBy: f.matchedBy })),
      businessFlows: fm.businessFlows ?? [],
      verificationTools: (fm.verificationTools ?? []).map((t) => ({ id: t.id, kind: t.kind, command: t.command, riskLevel: t.riskLevel })),
      testRefs: fm.testRefs ?? [],
    }
  } catch {
    // Fail-Soft on read-only handoff context assembly
  }

  // 验收命令从 AGENTS.md 的 Dev Profile 读，不在这里编。
  const agentsText = readTextSafe(join(mainRoot, 'AGENTS.md')) ?? ''
  const quick = /^\s*quick-test:\s*(.+)$/m.exec(agentsText)?.[1]?.trim() ?? null
  const full = /^\s*full-test:\s*(.+)$/m.exec(agentsText)?.[1]?.trim() ?? null
  const mergeGate = /^\s*merge-gate:\s*(.+)$/m.exec(agentsText)?.[1]?.trim() ?? null

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

  const design = extractDesignSection(specText)
  if (design) {
    lines.push("## 怎么做（来自 SPEC 的设计方案）")
    lines.push("")
    lines.push(design)
    lines.push("")
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

  if (featureMapContext.businessFlows.length > 0 || featureMapContext.verificationTools.length > 0) {
    lines.push('## 受波及业务流与验证工具（来自 docs/feature-map.json）')
    lines.push('')
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
  if (quick || full) {
    if (quick) lines.push(`- 快测：\`${quick}\``)
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
  const role = String(ownerRole ?? ledger?.ownerRole ?? ledger?.role ?? '')
  const boundary = ROLE_BOUNDARY[role] ?? ROLE_BOUNDARY.default

  lines.push('## 你的角色与边界')
  lines.push('')
  lines.push(`**${boundary.label}**。${boundary.scope}`)
  lines.push('')
  for (const n of boundary.mustNot) lines.push(`- 不要${n}`)
  lines.push('')
  lines.push('**下一步永远从这里查，不要凭记忆推断**：')
  lines.push('')
  lines.push(`\`node .agents/skills/dev-flow/scripts/flow.mjs next --task ${taskId ?? '<任务号>'}\`  `)
  lines.push('它读账本、输出当前阶段该做什么。状态在账本里，不在你的上下文里——')
  lines.push('被打断、被重派，换一个会话读同一份账本就接得上。')
  lines.push('')
  lines.push(boundary.report)
  lines.push('')
  // 审核侧要的两样：这一轮该看什么、上一轮提了什么。
  // 实现侧不需要它们（那是审查者的事），所以按角色给，不给所有人。
  if (role === 'reviewer' || role === 'human') {
    const rounds = Array.isArray(ledger?.rounds) ? ledger.rounds : []
    const last = rounds.length > 0 ? rounds[rounds.length - 1] : null
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
      const findings = Array.isArray(last.findings) ? last.findings : []
      if (findings.length > 0) {
        lines.push('')
        lines.push(`上一轮提了 ${findings.length} 条：`)
        for (const f of findings.slice(0, 20)) {
          lines.push(`- [${f.severity === 'must' ? '必修' : '建议'}] ${f.text ?? f}`)
        }
        if (findings.length > 20) lines.push(`- （另有 ${findings.length - 20} 条，见账本）`)
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

  return {
    prompt: `${lines.join('\n').trimEnd()}\n`,
    fields: {
      taskId: ledger?.taskId ?? null,
      sourceDoc,
      criteriaCount: criteria.length,
      criteria,
      paths,
      nonGoals,
      design,
      relatedSlices,
      featureMapContext,
      commands: { quick, full, mergeGate },
      requiredGates: gates,
    },
  }
}
