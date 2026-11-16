import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { parseDocFrontmatter } from './docs.mjs'
import { readTextSafe } from './git.mjs'

/**
 * doc-requirements.mjs —— 「一份规划文档最少必须有什么」的唯一真相源。
 *
 * ## 它治的病
 *
 * 早先这件事分两处写死：
 * 1. `doc-templates.mjs` 里七节固定表单（文档信息 / 要解决的问题 / 范围与非目标 /
 *    复用既有模块 / 关键交互 / 验收标准 / 门型与回滚 / 待拍板）；
 * 2. `doc-audit.mjs` 里三条硬编码检查（验收标准、非目标、门型与回滚）。
 *
 * 两处都把「这个工具自己长什么样」当成了「所有项目都必须长什么样」。于是：
 *
 * - 一个数据管道项目，被要求写「关键交互与用户路径」；
 * - 一篇论文或一个硬件仓，被要求标「门型 two-way / one-way」——它没有门；
 * - 一个纯文档站，被要求写「复用既有模块」——它没有模块。
 *
 * 项目自己的模板**只能往后追加章节，不能减**（`extractCustomDocSections` 只挑标准
 * 内容里没有的二级标题追加）。想写得合身，只剩「改写工具代码」一条路。
 *
 * ## 判据：只有「与项目形态无关」的那几件才是必需的
 *
 * 任何事情，不论做成什么形状，都必须回答三件事：
 *
 * | 问题 | 对应 |
 * | --- | --- |
 * | 要做什么 | 目标或问题陈述 |
 * | 不做什么 | 非目标（防范围蔓延） |
 * | 怎么算做完 | 可判定的验收标准 `C1..Cn` |
 *
 * 这三件就是**通用主干**。其余章节（门型与回滚、复用模块、关键交互、待拍板……）都是
 * 「某类项目需要、某类项目不需要」，因此它们属于**可选章节**：默认由工具的模板提供，
 * 项目可以按自己的形态声明要哪些、不要哪些。
 *
 * ## 反向：可扩展不等于可以什么都不写
 *
 * 通用主干是**锁死的**，项目声明不能把它减掉。自定义模板只能：
 * - 从可选章节里挑（减不能减主干）；
 * - 追加自己的章节。
 *
 * 否则「我有一个自己的模板」就成了免检通道——那比写死七节更糟。
 */

/**
 * 无论项目是什么形态，都必须回答的三件事。
 *
 * 键是文档类型，值是章节 id 数组。**只减不增**：这里出现的，项目声明也去不掉。
 */
export const FORM_INDEPENDENT_CORE = Object.freeze({
  prd: Object.freeze(['goal', 'non-goals', 'acceptance']),
  spec: Object.freeze(['goal', 'non-goals', 'acceptance']),
  todo: Object.freeze(['goal', 'non-goals', 'acceptance']),
})

/**
 * 章节定义表：`id` 是稳定标识，`keywords` 用于在正文里认出它。
 *
 * 加一个新章节 = 加一行，判据与模板都不用改。这是「写原则，不写死」的落地：
 * 换项目、换形态，表不用重写。
 */
export const SECTION_DEFS = Object.freeze({
  goal: {
    id: 'goal',
    label: '要做什么',
    keywords: ['要解决的问题', '背景与边界', '目标', '要改什么', '任务范围', '需求描述'],
    core: true,
    fixHint: '用一段话说清这件事要解决什么、给谁解决；不写形容词，写可观察的结果。',
  },
  'non-goals': {
    id: 'non-goals',
    label: '不做什么',
    keywords: ['本期不做', '明确不做', '非目标', 'Non-Goals'],
    core: true,
    fixHint: '写清本期明确不做的事项，防止范围蔓延。',
  },
  acceptance: {
    id: 'acceptance',
    label: '怎么算做完',
    keywords: ['验收标准', '冻结的验收标准', 'Acceptance'],
    core: true,
    fixHint: '动手前冻结 C1..Cn，每条须能被一条命令或断言证明。',
  },
  door: {
    id: 'door',
    label: '门型与回滚路径',
    keywords: ['门型与回滚', '门型', '回滚路径'],
    core: false,
    needsPattern: /\b(?:two-way|one-way)\b/i,
    fixHint: '标注「门型：two-way」或「门型：one-way」，并写明具体回滚操作。',
  },
})

/**
 * 各文档类型默认要哪些可选章节。
 *
 * 这是**工具的默认值**，不是硬性规则：项目可以按自己的形态改写，
 * 但只要它没表态，就沿用通用的那一套。
 */
export const DEFAULT_OPTIONAL_SECTIONS = Object.freeze({
  prd: Object.freeze(['door']),
  spec: Object.freeze(['door']),
  todo: Object.freeze(['door']),
})

const CUSTOM_DECL_REL = Object.freeze({
  prd: ['docs/templates/prd.md', 'docs/templates/prd-template.md', '.github/prd-template.md'],
  spec: ['docs/templates/spec.md', 'docs/templates/spec-template.md', '.github/spec-template.md'],
  todo: ['docs/templates/todo.md', 'docs/templates/todo-template.md', '.github/todo-template.md'],
})

/**
 * 读项目自己声明的章节要求。
 *
 * 约定写在自定义模板的 frontmatter 里：
 *
 * ```yaml
 * ---
 * required_sections: [door]        # 额外要求（不能包含主干，它已经强制）
 * omit_sections: [door]            # 这类项目不需要的章节
 * ---
 * ```
 *
 * 读不出来就返回空声明——**不抛错也不阻塞**：一个写坏的声明不该让整个文档链停摆，
 * 它会退回默认那一套，而默认那一套是保守的（什么都要求）。
 */
function readProjectDeclaration(repoRoot, kind) {
  const candidates = CUSTOM_DECL_REL[kind] ?? []
  for (const rel of candidates) {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) continue
    const text = readTextSafe(abs)
    if (text === undefined) continue
    const fm = parseDocFrontmatter(text)
    const req = Array.isArray(fm.data?.required_sections) ? fm.data.required_sections : []
    const omit = Array.isArray(fm.data?.omit_sections) ? fm.data.omit_sections : []
    if (req.length === 0 && omit.length === 0) continue
    return { rel, required: req, omit }
  }
  return null
}

/**
 * 这份文档必须有哪几节。
 *
 * 返回值里每一项都带 `core: true|false`，调用方据此决定报错的措辞：
 * 主干缺失是「你少回答了根本问题」，可选缺失是「你自己的模板要求了它」。
 */
export function resolveDocRequirements(repoRoot, kind) {
  const coreIds = FORM_INDEPENDENT_CORE[kind] ?? []
  const decl = repoRoot ? readProjectDeclaration(repoRoot, kind) : null

  const optionalIds = decl
    ? [
        ...(DEFAULT_OPTIONAL_SECTIONS[kind] ?? []).filter((id) => !decl.omit.includes(id)),
        ...decl.required.filter((id) => !(DEFAULT_OPTIONAL_SECTIONS[kind] ?? []).includes(id)),
      ]
    : [...(DEFAULT_OPTIONAL_SECTIONS[kind] ?? [])]

  // 主干永远是主干：即使项目声明里把它列进 omit，也照样要求。
  const ids = [...new Set([...coreIds, ...optionalIds])]
  return {
    kind,
    source: decl ? `项目声明（${decl.rel}）` : '工具默认',
    sections: ids.map((id) => SECTION_DEFS[id]).filter(Boolean),
  }
}

/**
 * 逐节核对一份文档，返回缺失项。
 *
 * `sections` 来自 `auditDoc` 已经切好的 Map（标题 -> 正文）。这里只做判定，不做解析。
 */
export function findMissingSections(docRequirements, sections, { hasInlineAcceptance = false } = {}) {
  const missing = []
  for (const def of docRequirements.sections) {
    if (def.id === 'acceptance') {
      // 验收标准的判定交给调用方（它已经有一条正则），这里不重复实现。
      if (!hasInlineAcceptance) missing.push({ ...def, reason: 'no-acceptance-criteria' })
      continue
    }
    const hit = sections.get(def.id)
    const body = (hit?.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()
    if (!body) {
      missing.push({ ...def, reason: 'section-absent-or-empty' })
      continue
    }
    if (def.needsPattern && !def.needsPattern.test(body)) {
      missing.push({ ...def, reason: 'section-missing-required-value' })
    }
  }
  return missing
}

/** 把章节定义表的 keywords 拍平成「找小节」用的查找表。 */
export function sectionKeywordMap(docRequirements) {
  const map = new Map()
  for (const def of docRequirements.sections) map.set(def.id, def.keywords)
  return map
}

/**
 * 行内条目形态：`- **本期不做**：…`、`- **门型判定**：two-way`。
 *
 * 判据关心的是「这件事说没说」，不是「它用了标题还是条目」——短文档用条目不丢信息。
 * 命中时把**命中的那一段原文**当正文交下去：塞一个占位串会让「必须标注 two-way /
 * one-way」这类二次判据在这里失效——明明写了，却因为交下去的不是原文而被判没写。
 */
const INLINE_FORMS = Object.freeze({
  'non-goals': /-\s+\*\*(?:本期不做|非目标)\*\*\s*[:：]\s*\S/,
  door: /\*\*门型(?:判定|与回滚路径)?\*\*[^\n]*\b(?:two-way|one-way)\b/i,
  goal: /-\s+\*\*(?:要改什么|要做什么|目标)\*\*\s*[:：]\s*\S/,
})

/**
 * 把一份文档正文解析成「哪几节在、内容是什么」。
 *
 * 这一步放在这里而不是 `doc-audit.mjs` 里，是因为它和「必须有什么」是同一件事的两半：
 * 判据和找法分开写，改一处忘另一处，就会出现「明明写了却被判没写」。
 *
 * @param {string} text 已经剥掉 frontmatter 的正文
 * @param {object} docRequirements `resolveDocRequirements` 的返回值
 * @returns {Map<string, {body: string}>} 章节 id -> 找到的内容
 */
export function resolveSectionPresence(text, docRequirements) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const byTitle = new Map()
  let curTitle = null
  let curLines = []
  const flush = () => {
    if (curTitle !== null) byTitle.set(curTitle, curLines.join('\n'))
  }
  for (const line of body.split('\n')) {
    const m = /^##\s+(.+)$/.exec(line)
    if (m) {
      flush()
      curTitle = m[1].trim()
      curLines = []
      continue
    }
    if (curTitle !== null) curLines.push(line)
  }
  flush()

  const keywordMap = sectionKeywordMap(docRequirements)
  const found = new Map()
  for (const [title, sectionBody] of byTitle.entries()) {
    for (const [id, keywords] of keywordMap.entries()) {
      if (found.has(id)) continue
      if (keywords.some((k) => title.includes(k))) found.set(id, { body: sectionBody })
    }
  }

  for (const [id, re] of Object.entries(INLINE_FORMS)) {
    if (found.has(id)) continue
    const hit = re.exec(body)
    if (hit) found.set(id, { body: hit[0] })
  }
  return found
}
