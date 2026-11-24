
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renumberHeadings } from './doc-renumber.mjs'
import { rewriteToc } from './doc-toc.mjs'
import { readTextSafe } from './git.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 模板目录：与 `lib/` 同级，所以 `../templates/`。装到 `.agents/skills/` 后同样成立。 */
const DOC_TEMPLATE_DIR = join(HERE, '..', 'templates')

/**
 * 各文档类型的取值占位清单。
 *
 * 这是**登记表**，不是白名单装饰：`preflight` 拿它对照模板文件，
 * 出现没登记的占位就报错——否则渲染时会静默输出一个字面的占位符文本。
 */
export const DOC_TEMPLATE_VARS = Object.freeze({
  tdd: Object.freeze([
    'PROJECT_NAME', 'DOC_VERSION', 'TODAY', 'BASIS', 'RUNTIME', 'PLATFORM', 'MANIFESTS',
    'STRUCTURE', 'DATA_CELL', 'DATA_HINT', 'FRONTEND_CELL', 'PLATFORM_NOTE', 'MODULE_ROWS',
    'QUICK_CMD', 'POSITIONING', 'NON_GOALS_LINES', 'BUSINESS_FLOWS_BLOCK', 'PRE_FORGE_BASELINE_BLOCK',
  ]),
  prd: Object.freeze([
    'TITLE', 'TODAY', 'ISSUE', 'ISSUE_LABEL', 'OWNER', 'OWNER_LABEL',
    'NON_GOALS', 'REUSABLE', 'CRITERIA', 'DOOR', 'ROLLBACK',
  ]),
  spec: Object.freeze([
    'TITLE', 'TODAY', 'ISSUE', 'ISSUE_LABEL', 'BRANCH', 'OWNER', 'OWNER_LABEL', 'TIER',
    'MODULES', 'CONTRACT_CHANGES', 'SAFETY_BOUNDARIES', 'CRITERIA', 'NON_GOALS', 'REUSABLE',
    'DOOR', 'ROLLBACK', 'HIGH_RISK', 'FAULT_INJECTION', 'TDD_REF',
  ]),
  todo: Object.freeze([
    'TITLE', 'STATUS', 'TODAY', 'ISSUE', 'ISSUE_LABEL', 'BRANCH', 'OWNER', 'OWNER_LABEL',
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

/** 模板里声明的章节及其是否可选。 */
export function templateSections(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(SECTION_RE)) {
    out.push({ id: m[1], optional: Boolean(m[2]) })
  }
  return out
}

function applySectionPolicy(text, dropSections, { pruneUnfilled = true } = {}) {
  const drop = dropSections ?? new Set()
  const sliced = String(text ?? '').replace(SECTION_RE, (whole, id, optional) => {
    if (!optional) return whole
    if (drop.has(id)) return ''
    // `pruneUnfilled: false` 表示「填不上也留着」。TDD 走这条路：
    // 数据模型、接口、部署这几节生成器写不出来，但它们该不该存在由项目形态决定，
    // 不由「生成器能不能填」决定。剪掉它们等于让架构文档什么都没说。
    if (!pruneUnfilled) return whole
    // 标记还在，所以这一刻分得清主干与可选：只有可选节才看「填没填上」。
    const body = whole
      .replace(/<!--\s*section:[^>]*-->/, '')
      .replace(/<!--\s*\/section\s*-->/, '')
      .replace(/<!--[\s\S]*?-->/g, '')
    // 两种「没填上」：模板自带的尖括号提示，以及渲染器的兜底值。
    // 后者也要算——`{{REUSABLE}}` 没有取值时会被填成「待补齐」，那一节同样是空壳。
    return ANGLE_HINT_RE.test(body) || UNFILLED_MARKER_RE.test(body) ? '' : whole
  })
  return sliced
    .replace(/<!--\s*section:\s*[a-z-]+(\s+optional)?\s*-->\n?/g, '')
    .replace(/<!--\s*\/section\s*-->\n?/g, '')
    // 裁掉整节后可能留下连续空行，收成一段；这也是产物洁净度的一部分。
    .replace(/\n{3,}/g, '\n\n')
}

/** 模板尖括号里写着中文的，是给人看的填写提示，不是真实内容。 */
const ANGLE_HINT_RE = /<[\u4e00-\u9fa5][^<>\n]{1,120}>/

/** 渲染器的兜底值。出现它，说明这个占位没有真实取值。 */
const UNFILLED_MARKER_RE = /^待补齐$/m

/**
 * 把「示范块」换成实际内容。
 *
 * 模板里要能看见 `C1` 编号长什么样（否则审查栏写的 `fail: C4` 永远对不上），
 * 但真实文档不能留着示范行。所以示范行放在一对标记之间，渲染时整块替换；
 * 没有取值时保留示范行——新文档本来就是待填的。
 */
const CRITERIA_BLOCK_RE = /<!--\s*criteria:start\s*-->([\s\S]*?)<!--\s*criteria:end\s*-->/

function fillCriteriaBlock(text, criteriaText) {
  return String(text ?? '').replace(CRITERIA_BLOCK_RE, (_whole, fallback) => {
    const v = String(criteriaText ?? '').trim()
    return v ? v : fallback.trim()
  })
}

/** 填占位。填不上的写「待补齐」而不是空字符串。 */
function fillTemplateVars(text, vars) {
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
export function renderDocTemplate(kind, { vars = {}, dropSections = null, pruneUnfilled = true } = {}) {
  const raw = readDocTemplate(kind)
  if (raw === null) return null
  // 模板顶部的 frontmatter 是给人看、给 preflight 校验的「这张表该有哪些字段」；
  // 真实文档的 frontmatter 由生成器按清单序列化（键序、类型都有讲究）。
  // 两者留在一起会拼出两份 frontmatter——所以渲染时剥掉模板自带的那份。
  const body = String(raw).replace(/^---\n[\s\S]*?\n---\n+/, '')
  const withCriteria = fillCriteriaBlock(body, vars.CRITERIA)
  // CRITERIA 已经由示范块承接，不再走普通占位替换（否则会把示范块外的残留也填上）。
  const { CRITERIA: _crit, ...restVars } = vars

  // 顺序不能反：**先填占位，再裁章节**。
  //
  // 因为「这一节填上了没有」要看填完的结果——在占位还是 `{{REUSABLE}}` 的时候看，
  // 什么也看不出来，于是所有可选节一律被当成「填上了」而保留下来，
  // 生成的文档里塞满 `<待核实填写：...>`，过不了自己的审计。
  const filled = fillTemplateVars(withCriteria, restVars)
  const pruned = applySectionPolicy(filled, dropSections, { pruneUnfilled })
  // 编号与目录都要按裁剪后的集合重算：
  // 模板里写死的节号在裁掉几节之后成了空档；
  // 手写的固定目录链接在保留更多节之后成了漏项。两者都是「集合变了、派生值没跟着变」。
  return rewriteToc(renumberHeadings(pruned))
}

