import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { parseDocFrontmatter } from './docs.mjs'
import { isStubValue } from './doc-substantive.mjs'
import { readTextSafe } from './git.mjs'


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
 * 章节定义表。
 *
 * - `keywords`：标题里的弱证据；
 * - `evidence`：**正文里的强证据**——出现任意一条，就算答了这个问题；
 * - `core`：是否主干（主干不可被项目声明删掉）。
 *
 * 加一个新章节 = 加一行，判据与模板都不用改。
 */
export const SECTION_DEFS = Object.freeze({
  goal: {
    id: 'goal',
    label: '要做什么',
    keywords: [
      '要解决的问题', '背景与边界', '背景', '目标', '要改什么', '任务范围', '需求描述', '动机',
      '现状', 'Why', 'Problem', 'Motivation', 'Goal', 'Overview',
    ],
    // 强证据：说清「现在什么不行 / 要做成什么」的句子。这些在任何项目里都长这样。
    //
    // 覆盖面比看起来重要：中文有「需要强校验」「要补上」「得改」多种说法，
    // 英文有 "we need"、"cannot"、"the goal is"。少写一条，就有一类真实文档被判成没写。
    evidence: [
      /(?:现状|当前|目前|现有)[^\n]{0,40}(?:痛点|问题|缺失|不足|卡在|无法|不能|缺|退化|失败)/,
      /(?:需要|必须|得|要)[^\n]{0,8}(?:改|换|补|加|做|支持|解决|引入|新增|加强|提升|降低|系统化|规范)/,
      /(?:预期|期望)(?:收益|效果|结果|行为)/,
      /(?:current|currently|today)[^\n]{0,50}(?:cannot|can't|no longer|fails?|broken|missing|lacks?|drops?|degrades?)/i,
      /(?:we|it|this|they)\s+(?:need|needs|require|requires|must)\b/i,
      /(?:so that|in order to|the goal is|we want to)/i,
    ],
    core: true,
    fixHint: '用一段话说清这件事要解决什么、给谁解决；不写形容词，写可观察的结果。',
  },
  'non-goals': {
    id: 'non-goals',
    label: '不做什么',
    keywords: ['本期不做', '明确不做', '非目标', 'Non-Goals', '不在本次范围', '范围外', 'Out of scope', '不做'],
    // 强证据：任何形式的「不做 / 不在范围 / 排除」。
    evidence: [
      /(?:不|暂不|本次不|本期不|不在)(?:做|改|动|引入|涉及|考虑|包含|纳入)/,
      /(?:排除|范围外|非目标|不含)/,
      /(?:out\s+of\s+scope|won'?t\s+(?:do|touch|change|support)|not\s+in\s+scope|excluded|no\s+(?:GUI|API|support)\b)/i,
      /(?:non-?goals?|not\s+doing)\b/i,
    ],
    core: true,
    fixHint: '写清本期明确不做的事项，防止范围蔓延。',
  },
  acceptance: {
    id: 'acceptance',
    label: '怎么算做完',
    keywords: ['验收标准', '冻结的验收标准', 'Acceptance', '交付判据', '完成标准', 'Definition of Done', '验收'],
    // 强证据最强：有编号勾选项就是验收标准，标题叫什么都算。
    // 编号列表也算——真实的大型 PRD 常写成「1. 首个平台管理员只能初始化一次」，
    // 逐条编号就是验收条目的另一种写法，只认 `- [ ]` 会把它们全判成没写。
    evidence: [/^-\s*\[[ xX]\]\s*C\d+/m, /^\d+\.\s+\S/m],
    core: true,
    fixHint: '动手前冻结 C1..Cn，每条须能被一条命令或断言证明。',
  },
  door: {
    id: 'door',
    label: '门型与回滚路径',
    keywords: ['门型与回滚', '门型', '回滚路径', '回滚'],
    evidence: [
      /\b(?:two-way|one-way)\b/i,
      /(?:回滚|回退|revert|rollback)/i,
    ],
    core: false,
    fixHint: '标注「门型：two-way」或「门型：one-way」，并写明具体回滚操作。',
  },

  // ── 以下为可选章节 ──────────────────────────────────────────────
  // 默认不要求，登记在此是为了让项目能在 omit_sections 里点名删掉、在
  // required_sections 里点名要求。不登记就两样都做不到。
  reuse: {
    id: 'reuse',
    label: '复用既有模块',
    keywords: ['复用既有模块', '复用模块', '可复用', '已有能力'],
    evidence: [/(?:复用|沿用|基于)(?:已有|现有|既有|现成)/, /(?:reuse|reusing)\s+existing/i],
    core: false,
    fixHint: '写清复用哪个现成模块；没有就说明为什么不能复用。',
  },
  flow: {
    id: 'flow',
    label: '关键交互与用户路径',
    keywords: ['关键交互', '用户路径', '交互流程', '业务流程', '主流程'],
    evidence: [
      /(?:用户|调用方|操作者)[^\n]{0,20}(?:输入|点击|触发|执行)/,
      /^\d+\.\s+\S/m,
    ],
    core: false,
    fixHint: '从用户入口写到终态，含失败与缺配置时的可见反馈。',
  },
  pending: {
    id: 'pending',
    label: '待拍板问题',
    keywords: ['待拍板', '未决问题', '待确认', '待定'],
    evidence: [/(?:待拍板|待确认|未决|需要?人(?:拍板|决定|确认))/, /(?:open\s+question|TBD)/i],
    core: false,
    fixHint: '列出需要人拍板的取舍与各自代价；清空后才可进独立 Critique。',
  },
  design: {
    id: 'design',
    label: '设计方案与契约变更',
    keywords: ['设计方案', '契约变更', '接口变更', '方案'],
    evidence: [/(?:接口|协议|数据结构|退出码|状态)[^\n]{0,20}(?:变更|调整|新增|改为)/, /(?:breaking\s+change)/i],
    core: false,
    fixHint: '写清改了哪些接口、数据结构、退出码或状态流转。',
  },
  implementation: {
    id: 'implementation',
    label: '实现说明',
    keywords: ['实现说明', '落地摘要', '实际落地'],
    evidence: [/(?:实际(?:落地|采用|实现))/, /(?:implementation\s+notes)/i],
    core: false,
    fixHint: '合入前补齐实际落地内容与同步了哪些文件。',
  },
  steps: {
    id: 'steps',
    label: '执行步骤',
    keywords: ['执行步骤', '实施步骤', '步骤'],
    evidence: [/(?:第[一二三四五1-9]步|先[^\n]{0,10}再)/],
    core: false,
    fixHint: '按先后写清每一步做什么、怎么验。',
  },
  breakpoint: {
    id: 'breakpoint',
    label: '断点与遗留决策',
    keywords: ['断点与遗留', '断点', '遗留决策', '遗留'],
    evidence: [/(?:断点|接手人|下一步第一件事|遗留)/],
    core: false,
    fixHint: '写清当前停在哪、哪些要人拍板，接手人据此恢复。',
  },

  // ── 大型项目才用得到的章节 ────────────────────────────────────
  // 它们全都登记在这里，但**默认一个都不要求**。登记的意义是：项目可以点名要
  // 或点名不要，而不是被工具替它决定。这也正是「通用」的含义——
  // 能用得上的人拿得到，用不上的人删得掉。
  users: {
    id: 'users',
    label: '用户身份与权限',
    keywords: ['用户身份', '权限', '角色'],
    evidence: [/(?:角色|身份|权限)[^\n]{0,20}(?:能|可以|不能|禁止)/],
    core: false,
    fixHint: '列清谁能做什么、谁不能做什么，以及它们在代码里对应什么。',
  },
  rules: {
    id: 'rules',
    label: '状态与业务规则',
    keywords: ['状态与业务规则', '业务规则', '状态机', '状态'],
    evidence: [/(?:状态)[^\n]{0,20}(?:迁移|流转|变更)/, /\b(?:state\s+machine)\b/i],
    core: false,
    fixHint: '有状态机就列清对象、状态、允许的迁移与触发条件。',
  },
  nfr: {
    id: 'nfr',
    label: '非功能要求',
    keywords: ['非功能', '性能要求', '质量属性'],
    evidence: [/(?:性能|并发|响应时间|可用性|容量)[^\n]{0,30}(?:要求|上限|不低于|不超过)/],
    core: false,
    fixHint: '只写本项目真正会被验收的那几条，每条都要说清怎么验。',
  },
  rollout: {
    id: 'rollout',
    label: '上线、灰度与兼容策略',
    keywords: ['上线', '灰度', '兼容策略', '发布方案'],
    evidence: [/(?:灰度|开关|迁移|回填|兼容期)/],
    core: false,
    fixHint: '写清怎么上线、怎么退、老数据与老调用方怎么办。',
  },
  metrics: {
    id: 'metrics',
    label: '成功度量',
    keywords: ['成功度量', '度量', '指标', 'Metrics'],
    evidence: [/(?:基线|目标值)[^\n]{0,20}(?:达到|低于|高于)/, /(?:埋点|指标名)/],
    core: false,
    fixHint: '「做完了」和「做对了」是两件事；写清后者怎么量。',
  },
  dependencies: {
    id: 'dependencies',
    label: '依赖与前置条件',
    keywords: ['依赖与前置', '前置条件', '依赖'],
    evidence: [/(?:依赖|前置|等[^\n]{0,10}先|blocked\s+by)/i],
    core: false,
    fixHint: '写清要谁先做完、要谁点头；没有它会阻塞还是可绕过。',
  },
  risks: {
    id: 'risks',
    label: '风险与开放问题',
    keywords: ['风险', '开放问题', 'Risks'],
    evidence: [/(?:风险|可能出问题|兜底)/],
    core: false,
    fixHint: '与「待拍板」不同：这里要人知道可能会出什么事，不是要人做决定。',
  },
  alternatives: {
    id: 'alternatives',
    label: '备选方案与否决理由',
    keywords: ['备选方案', '否决理由', '方案对比'],
    evidence: [/(?:备选|另一个方案|还考虑过|没有选)/],
    core: false,
    fixHint: '写清还考虑过什么、为什么不选——这段能防止已否掉的方案被重新讨论。',
  },
  breakdown: {
    id: 'breakdown',
    label: '改动清单与影响面',
    keywords: ['改动清单', '影响面', '影响范围', '变更清单'],
    evidence: [/(?:新增|修改|删除)[^\n]{0,20}(?:文件|路径|模块)/, /(?:对外可见的变化|breaking)/i],
    core: false,
    fixHint: '一条一条列清要动什么；审查者按这张表核对 diff 有没有漏改。',
  },
  risk: {
    id: 'risk',
    label: '风险与应对',
    keywords: ['风险与应对', '风险'],
    evidence: [/(?:风险|触发条件|怎么退)/],
    core: false,
    fixHint: '只在确实有风险时保留；没有就整节删掉，不要留空表。',
  },
  rollback: {
    id: 'rollback',
    label: '回滚预案',
    keywords: ['回滚预案', '回滚'],
    evidence: [/(?:回滚|恢复快照|反向提交)[^\n]{0,20}(?:第一步|命令|操作)/],
    core: false,
    fixHint: '写清出问题时的第一条命令；「评估一下」不是预案。',
  },
  coordination: {
    id: 'coordination',
    label: '协作与依赖',
    keywords: ['协作与依赖', '协作', '对接'],
    evidence: [/(?:需要[^\n]{0,10}(?:配合|提供|确认)|找谁)/],
    core: false,
    fixHint: '写清需要谁配合、什么时候要、找谁。',
  },
  clarifications: {
    id: 'clarifications',
    label: '澄清与补充记录',
    keywords: ['澄清与补充记录', '澄清记录', '补充澄清'],
    evidence: [/已确认(?:（\d{4}-\d{2}-\d{2}|[:：])/],
    core: false,
    fixHint: '可通过 doc-plan.mjs clarify 追加已确认要求。',
  },
})

export const DEFAULT_OPTIONAL_SECTIONS = Object.freeze({
  prd: Object.freeze([]),
  spec: Object.freeze([]),
  todo: Object.freeze([]),
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
 * 读不出来就返回 null——**不抛错也不阻塞**：一个写坏的声明不该让整个文档链停摆。
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
 * 返回值里每项都带 `core: true|false`，调用方据此决定措辞：
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
  // 项目点名不要的章节。主干不许被列进来（上面已经把主干并回 ids，这里再兜一次）。
  const omitIds = new Set((decl?.omit ?? []).filter((id) => !coreIds.includes(id)))
  return {
    kind,
    source: decl ? `项目声明（${decl.rel}）` : '工具默认',
    sections: ids.map((id) => SECTION_DEFS[id]).filter(Boolean),
    omit: omitIds,
  }
}

/**
 * 逐节核对一份文档，返回缺失项。
 *
 * `sections` 是 `resolveSectionPresence` 交上来的 Map（章节 id -> 命中的内容）。
 */
export function findMissingSections(docRequirements, sections, { hasInlineAcceptance = false } = {}) {
  const missing = []
  for (const def of docRequirements.sections) {
    if (def.id === 'acceptance') {
      // 验收标准的判定交给调用方（它已经有一条正则），这里不重复实现。
      if (!hasInlineAcceptance && !sections.has('acceptance')) {
        missing.push({ ...def, reason: 'no-acceptance-criteria' })
      }
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
 * 命中时把**命中的那一段原文**当正文交下去：塞一个占位串会让二次判据失效。
 */
const INLINE_FORMS = Object.freeze({
  'non-goals': /-\s+\*\*(?:本期不做|非目标|不做)\*\*\s*[:：]\s*([^\n]+)/,
  door: /\*\*门型(?:判定|与回滚路径)?\*\*[^\n]*\b(?:two-way|one-way)\b/i,
  goal: /-\s+\*\*(?:要改什么|要做什么|目标)\*\*\s*[:：]\s*([^\n]+)/,
})

/**
 * 把一份文档正文解析成「哪几节在、内容是什么」。
 *
 * ## 认节的两条证据
 *
 * 1. **标题像**（弱）：`## 不做什么` / `## Non-Goals` 这类；
 * 2. **内容像**（强）：这一节里写的句子，是不是在回答那个问题。
 *
 * 只靠标题会漏掉大量真实写法——同一个「不做什么」，有人写 `## 不在本次范围`，
 * 有人写 `## Out of scope`，还有人写在目标那节的最后一句里。这些全都写了，
 * 却被判成「没写」。所以内容证据是主判据，标题只是加分项。
 *
 * @param {string} text 已经剥掉 frontmatter 的正文
 * @param {object} docRequirements `resolveDocRequirements` 的返回值
 * @returns {Map<string, {body: string, via: string}>} 章节 id -> 找到的内容
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

  const found = new Map()
  const ids = docRequirements.sections.map((s) => s.id)

  // 证据一：标题命中关键字（弱证据，但命中即认）
  for (const [title, sectionBody] of byTitle.entries()) {
    for (const id of ids) {
      const def = SECTION_DEFS[id]
      if (!def || found.has(id)) continue
      if (def.keywords.some((k) => title.includes(k))) found.set(id, { body: sectionBody, via: 'title' })
    }
  }

  // 证据二：内容命中证据模式（强证据）——按节扫，先剔除仅含占位桩的行内标签行再判定
  const stripStubInlineLines = (txt) => String(txt ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .split('\n')
    .filter((ln) => {
      const m = /^-\s+\*\*[^*\n]+\*\*\s*[:：](.*)$/.exec(ln.trim())
      return !(m && isStubValue(m[1]))
    })
    .join('\n')

  for (const [title, sectionBody] of byTitle.entries()) {
    const clean = stripStubInlineLines(sectionBody)
    for (const id of ids) {
      const def = SECTION_DEFS[id]
      if (!def?.evidence || found.has(id)) continue
      if (def.evidence.some((re) => re.test(clean))) {
        found.set(id, { body: sectionBody, via: `content:${title}` })
      }
    }
  }

  // 证据三：全文级的强证据——某些内容写在哪一节都算数
  const cleanBodyAll = stripStubInlineLines(body)
  for (const id of ids) {
    const def = SECTION_DEFS[id]
    if (!def?.evidence || found.has(id)) continue
    const hit = def.evidence.map((re) => re.exec(cleanBodyAll)).find(Boolean)
    if (hit) found.set(id, { body: hit[0], via: 'document' })
  }

  for (const [id, re] of Object.entries(INLINE_FORMS)) {
    if (found.has(id)) continue
    const hit = re.exec(body)
    if (!hit) continue
    if ((id === 'non-goals' || id === 'goal') && isStubValue(hit[1] ?? hit[0])) continue
    found.set(id, { body: hit[0], via: 'inline' })
  }
  return found
}

/**
 * 验收标准必须由**不干活的人**定。
 *
 * ## 它治的病
 *
 * 干活的与定标准的是同一个：他一定会写一份自己能轻松通过的验收标准，然后照着做，
 * 最后自己宣布通过。整套「动手前冻结标准」的意义，就在于这个冻结动作由另一方完成。
 *
 * ## 判据
 *
 * SPEC / Todo 的 frontmatter `owner`（写它的那个人）不得等于该任务账本里的
 * `implementerId`（干活的那个人）。两边都拿得到才判；任何一边缺失就不判——
 * **不判不等于放行**：缺 owner 的文档在 `approve` 时另有门禁，缺账本的任务
 * `flow next` 会退回「先规划或 start」。
 */
export function checkAuthorIsNotImplementer(repoRoot, specRel, implementerId) {
  if (!specRel || !implementerId) return []
  const abs = join(repoRoot, specRel)
  if (!existsSync(abs)) return []
  const fm = parseDocFrontmatter(readTextSafe(abs) ?? '')
  const owner = fm.data?.owner
  if (!owner) return []
  const norm = (s) => String(s ?? '').trim().replace(/^@/, '').toLowerCase()
  if (norm(owner) !== norm(implementerId)) return []
  return [{
    code: 'SELF_AUTHORED_ACCEPTANCE',
    file: specRel,
    owner: String(owner),
    implementerId: String(implementerId),
    message: `${specRel} 的作者（${owner}）就是这个任务的实施者（${implementerId}）`
      + '——干活的人给自己定验收标准，一定会写一份自己能轻松通过的，'
      + '「动手前冻结标准」这件事就失去了意义。请换一个不参与实施的人来写或复核这份规划。',
  }]
}
