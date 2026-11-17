/**
 * doc-template-render.mjs —— 把 `templates/docs-*.md` 渲染成一份可用的工程文档。
 *
 * ## 为什么要有这一层
 *
 * 模板曾经有两份：`templates/docs-prd.md`（给人看、被 `preflight` 校验 frontmatter）
 * 和写死在生成器里的那一份字符串数组。两份内容不一样，也不共享任何代码——
 * 所以改模板文件对真实生成的文档毫无影响，而人以为自己改了。
 *
 * 现在只有 `kit/skills/templates/docs-*.md` 一份。生成器读它、填占位、按需裁章节。
 * 改模板就是改产物，没有第二条路。
 *
 * ## 两种标记
 *
 * - `{{NAME}}` —— 取值占位。清单在 `DOC_TEMPLATE_VARS`；填不上就写「待补齐」，
 *   绝不静默留空（留空会生成一份看着完整、实则缺内容的文档）。
 * - `<!-- section: <id> [optional] --> ... <!-- /section -->` —— 章节边界。
 *   `optional` 的章节在项目声明不需要它时整节删掉；没有 `optional` 的是主干，永远保留。
 *   标记本身在渲染后清除，不落进产物。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readTextSafe } from './git.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 模板目录：与 `lib/` 同级，所以 `../templates/`。装到 `.agents/skills/` 后同样成立。 */
export const DOC_TEMPLATE_DIR = join(HERE, '..', 'templates')

/**
 * 各文档类型的取值占位清单。
 *
 * 这是**登记表**，不是白名单装饰：`preflight` 拿它对照模板文件，
 * 出现没登记的占位就报错——否则渲染时会静默输出一个字面的占位符文本。
 */
export const DOC_TEMPLATE_VARS = Object.freeze({
  prd: Object.freeze([
    'TITLE', 'TODAY', 'ISSUE', 'ISSUE_LABEL', 'OWNER', 'OWNER_LABEL',
    'NON_GOALS', 'REUSABLE', 'CRITERIA', 'DOOR', 'ROLLBACK',
  ]),
  spec: Object.freeze([
    'TITLE', 'TODAY', 'ISSUE', 'ISSUE_LABEL', 'BRANCH', 'OWNER', 'OWNER_LABEL', 'TIER',
    'MODULES', 'CONTRACT_CHANGES', 'SAFETY_BOUNDARIES', 'CRITERIA', 'NON_GOALS', 'REUSABLE',
    'DOOR', 'ROLLBACK', 'HIGH_RISK', 'FAULT_INJECTION',
  ]),
  todo: Object.freeze([
    'TITLE', 'TODAY', 'ISSUE', 'ISSUE_LABEL', 'BRANCH', 'OWNER', 'OWNER_LABEL',
    'TASK_ID', 'HEAD_SHA', 'HEAD_SHA_SHORT', 'SCOPE_PATHS', 'REUSABLE', 'NON_GOALS',
    'DOOR', 'ROLLBACK', 'QUICK_CMD', 'CRITERIA',
  ]),
})

const SECTION_RE = /<!--\s*section:\s*([a-z-]+)(\s+optional)?\s*-->([\s\S]*?)<!--\s*\/section\s*-->/g

/** 读一份模板。读不到返回 null，由调用方决定怎么办。 */
export function readDocTemplate(kind) {
  const abs = join(DOC_TEMPLATE_DIR, `docs-${kind}.md`)
  if (!existsSync(abs)) return null
  return readTextSafe(abs) ?? null
}

/** 模板里出现的所有占位名，用于 preflight 对照登记表。 */
export function templateVarNames(text) {
  return [...new Set([...String(text ?? '').matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))]
}

/** 模板里声明的章节及其是否可选。 */
export function templateSections(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(SECTION_RE)) {
    out.push({ id: m[1], optional: Boolean(m[2]) })
  }
  return out
}

/**
 * 按项目声明裁掉可选章节，并清掉章节标记。
 *
 * `dropSections` 是**要删掉**的章节 id 集合；为空时全部保留——保守默认：
 * 不知道项目形态就别删东西。反过来的「只保留白名单」写法会让新加的模板章节
 * 在没人留意时整节消失，那正是这份模板曾经掉过三节的原因。
 *
 * 另有一条：**填不上的可选章节也删掉**。一个「风险与应对」表里写着
 * `<可能出问题的事>` 的文档，比没有这一节更糟——它能通过人的扫读，却过不了
 * 自己的审计，最后在提交前被退回来。生成器不该产出会被自己门禁拒收的文档。
 * 主干章节不参与这条：主干填不上就留着让人看见，那正是它该起的作用。
 */
export function applySectionPolicy(text, dropSections) {
  const drop = dropSections ?? new Set()
  const sliced = String(text ?? '').replace(SECTION_RE, (whole, id, optional) => {
    if (!optional) return whole
    if (drop.has(id)) return ''
    // 标记还在，所以这一刻分得清主干与可选：只有可选节才看「填没填上」。
    const body = whole
      .replace(/<!--\s*section:[^>]*-->/, '')
      .replace(/<!--\s*\/section\s*-->/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
    return ANGLE_HINT_RE.test(body) ? '' : whole
  })
  return sliced
    .replace(/<!--\s*section:\s*[a-z-]+(\s+optional)?\s*-->\n?/g, '')
    .replace(/<!--\s*\/section\s*-->\n?/g, '')
    // 裁掉整节后可能留下连续空行，收成一段；这也是产物洁净度的一部分。
    .replace(/\n{3,}/g, '\n\n')
}

/** 模板尖括号里写着中文的，是给人看的填写提示，不是真实内容。 */
const ANGLE_HINT_RE = /<[\u4e00-\u9fa5][^<>\n]{1,120}>/

/**
 * 把「示范块」换成实际内容。
 *
 * 模板里要能看见 `C1` 编号长什么样（否则审查栏写的 `fail: C4` 永远对不上），
 * 但真实文档不能留着示范行。所以示范行放在一对标记之间，渲染时整块替换；
 * 没有取值时保留示范行——新文档本来就是待填的。
 */
const CRITERIA_BLOCK_RE = /<!--\s*criteria:start\s*-->([\s\S]*?)<!--\s*criteria:end\s*-->/

export function fillCriteriaBlock(text, criteriaText) {
  return String(text ?? '').replace(CRITERIA_BLOCK_RE, (_whole, fallback) => {
    const v = String(criteriaText ?? '').trim()
    return v ? v : fallback.trim()
  })
}

/** 填占位。填不上的写「待补齐」而不是空字符串。 */
export function fillTemplateVars(text, vars) {
  return String(text ?? '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (_whole, name) => {
    const v = vars[name]
    if (v === undefined || v === null) return '待补齐'
    const s = String(v)
    return s.trim() ? s : '待补齐'
  })
}

/**
 * 完整渲染：读模板 → 填占位 → 裁章节。
 *
 * 顺序不能反：先填占位再裁章节，否则被裁掉的章节里如果有占位，
 * 会白白多一次「取不到值」的告警。
 */
export function renderDocTemplate(kind, { vars = {}, dropSections = null } = {}) {
  const raw = readDocTemplate(kind)
  if (raw === null) return null
  // 模板顶部的 frontmatter 是给人看、给 preflight 校验的「这张表该有哪些字段」；
  // 真实文档的 frontmatter 由生成器按清单序列化（键序、类型都有讲究）。
  // 两者留在一起会拼出两份 frontmatter——所以渲染时剥掉模板自带的那份。
  const body = String(raw).replace(/^---\n[\s\S]*?\n---\n+/, '')
  const withCriteria = fillCriteriaBlock(body, vars.CRITERIA)
  // CRITERIA 已经由示范块承接，不再走普通占位替换（否则会把示范块外的残留也填上）。
  const { CRITERIA: _crit, ...restVars } = vars
  return fillTemplateVars(applySectionPolicy(withCriteria, dropSections), restVars)
}

