/**
 * pending-decisions.mjs —— 认「待拍板事项到底清没清」。
 *
 * ## 治的病
 *
 * `dev-plan/SKILL.md` 写着一条硬门槛：
 *
 * > 文档中「待拍板事项 / 未决问题」全部消解且路径/命令核实后，才可进入 `audit` 与独立 Critique。
 *
 * **这条门槛在代码里不存在。** 实测：一份写着两条「待确认：…」的 PRD，
 * `audit` 通过、`critique-pass` 通过、`approve` 也通过，状态直接变成 `active`。
 *
 * 后果不是「文档薄」，而是**没想清楚的事被当成想清楚了**：PRD 里的问号没人回答，
 * 拆出来的 SPEC 只能自己猜答案，实现子代理再猜一遍——最后做出来的东西
 * 和一开始想做的不是同一件，而每一步都「通过了」。
 *
 * ## 判据
 *
 * 一条待拍板事项算**已消解**，当且仅当它自己那一段里出现了明确的结论标记：
 *
 * - `已定：…` / `决定：…` / `结论：…` / `采纳建议` / `按建议执行`
 * - 或者整节写「无」/「待确认：无」（没有遗留问题）
 *
 * 只有「建议：…」不算——建议是**提给谁看的**，不是谁拍的板。
 * 这条区分是全部意义所在：把「我建议」当成「已决定」，
 * 就是这套流程最容易糊弄过去的地方。
 */

/**
 * 规划双态枚举。
 *
 * - `interactive`：逐题问到零待拍板。适合会产生**不可逆或跨契约**决定的规划——问错了，
 *   改的是别人已经依赖的东西，代价由后面的人承担。
 * - `autonomous`：按仓内既有最佳模式默认推进，只在单向门、Case 5 冲突或真业务歧义时停。
 *   适合局部、可逆的改动——每件小事都先开一轮问答，人会直接绕过整套流程。
 *
 * 两种都是合规流，判据只有一条：**这份规划的错，撤得回来吗**。
 */
export const PLAN_MODES = Object.freeze(['interactive', 'autonomous'])

/** Frontmatter 字段名。取值与 `--plan-mode` 共用同一份枚举。 */
export const PLAN_MODE_FIELD = 'plan_mode'

/** 是否合法枚举（大小写与首尾空白不敏感，回写时统一小写）。 */
export function isValidPlanMode(value) {
  return PLAN_MODES.includes(normalizePlanMode(value))
}

/** 归一化：非字符串一律返回空串，避免把 `null` 当成合法值。 */
export function normalizePlanMode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * 推导默认规划态。
 *
 * 按「这份规划错了撤不撤得回来」判：单向门、跨模块或改外部契约的 `L3`、
 * 以及作为整个产品容器的总控 PRD，共同点是**决定一旦落地就要别人跟着改**，
 * 所以默认逐题落实到零。剩下那些局部可逆的改动走自治推进，不必每件小事都先开一轮问答。
 *
 * 判据全部来自文档已声明的事实（门型、档位、`tier`、文档类型），不看事情「大不大」——
 * 大小是形容词，量不出来，也无法在代码里复核。
 */
export function deriveDefaultPlanMode({ kind = null, tier = null, caseType = null, doorType = null } = {}) {
  const door = typeof doorType === 'string' ? doorType.trim().toLowerCase() : ''
  const tierNorm = typeof tier === 'string' ? tier.trim().toUpperCase() : ''
  const num = Number(caseType)
  if (door === 'one-way') return 'interactive'
  if (Number.isInteger(num) && num >= 4) return 'interactive'
  if (tierNorm === 'L3' || tierNorm === 'L4') return 'interactive'
  if (kind === 'prd') return 'interactive'
  return 'autonomous'
}

/**
 * 规划态取值：合法枚举优先，否则按文档类型与档位推导默认值。
 *
 * 非法值在生成阶段就归一为默认值，而不是原样写进 Frontmatter——写进去只会让
 * 后续 `audit` 报一条本可以在源头避免的错误。`doc-plan.mjs` 回显与文档生成都走这一处，
 * 保证「写进文档的」与「报给用户的」永远是同一个值。
 */
export function resolveDocPlanMode({ kind = null, tier = null, caseType = null, doorType = null, explicit = null } = {}) {
  const norm = normalizePlanMode(explicit)
  if (isValidPlanMode(norm)) return norm
  return deriveDefaultPlanMode({ kind, tier, caseType, doorType })
}

/**
 * Frontmatter 里的 `plan_mode` 枚举校验。
 *
 * 放在这里而不是塞进 `auditDoc`，理由与 `pendingDecisionErrors` 相同：这是一条
 * **声明是否成立**的判据，与结构判据分开更好查；而 `doc-plan.mjs` 与 `audit` 都要用同一份枚举。
 *
 * @param {string} rawText 文档全文
 * @returns {Array<{code: string, line: number, message: string, fixHint: string}>}
 */
export function planModeErrors(rawText) {
  const lines = String(rawText ?? '').replace(/\r\n/g, '\n').split('\n')
  if (!rawText || lines[0].trim() !== '---') return []
  const re = new RegExp(`^${PLAN_MODE_FIELD}:\\s*(.*)$`)
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') break
    const m = re.exec(lines[i])
    if (!m) continue
    const raw = m[1].trim().replace(/^["']|["']$/g, '')
    if (isValidPlanMode(raw)) return []
    return [{
      code: 'INVALID_PLAN_MODE',
      line: i + 1,
      message: `${PLAN_MODE_FIELD}: ${raw || '(空)'} 不在允许枚举中`,
      fixHint: `请改用 ${PLAN_MODES.join(' | ')}：不可逆或跨契约的规划用 interactive 逐题问到零待拍板，`
        + '局部可逆的改动用 autonomous 默认推进。',
    }]
  }
  return []
}

/** 整节为空 / 明确写「无」的几种写法。 */
const EMPTY_SECTION_RE = /^(?:\s*(?:[-*]\s*)?(?:待确认|待拍板|未决)[:：]\s*)?(?:无|没有|none|n\/a)\s*[。.]?\s*$/i

/** 一条已被拍板的事项必须带这些标记之一。 */
const DECIDED_RE = /(?:已定|已拍板|决定|结论|采纳建议|按建议执行|已确认)\s*[:：]/i
export { DECIDED_RE }

/** 章节标题里认「这是待拍板那一节」。 */
const PENDING_HEADING_RE = /^#{2,4}\s*(?:[一二三四五六七八九十百]+[、.]\s*)?([^\n]*)$/

const PENDING_WORDS = /(?:待拍板|未决问题|待确认事项|开放问题|待定事项|open\s+questions?)/i

/** 遇到下一个同级或更高级标题就结束。 */
function sectionBody(lines, startIdx) {
  const startLevel = (lines[startIdx].match(/^#+/) ?? ['##'])[0].length
  let end = lines.length
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const m = /^(#+)\s/.exec(lines[i])
    if (m && m[1].length <= startLevel) { end = i; break }
  }
  return { body: lines.slice(startIdx + 1, end), endIdx: end }
}

/**
 * 从文档里抽出待拍板事项，并判断哪些还没消解。
 *
 * @param {string} text 文档全文
 * @returns {{ found: boolean, total: number, unresolved: Array<{line: number, text: string}> }}
 */
export function analyzePendingDecisions(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  let found = false
  let total = 0
  const unresolved = []

  for (let i = 0; i < lines.length; i += 1) {
    const h = PENDING_HEADING_RE.exec(lines[i])
    if (!h) continue
    if (!PENDING_WORDS.test(h[1])) continue
    found = true

    const { body } = sectionBody(lines, i)
    const content = body.filter((l) => l.trim() && !/^\s*<!--/.test(l))
    const meaningful = content.filter((l) => !/^\s*>/.test(l))
    if (meaningful.length === 0) continue
    if (meaningful.length === 1 && EMPTY_SECTION_RE.test(meaningful[0].replace(/^[-*]\s*/, ''))) {
      continue
    }

    // 逐条判：一个条目从它自己那行起，到下一个同级条目为止。
    const items = splitItems(body)
    total += items.length
    for (const item of items) {
      if (DECIDED_RE.test(item.block)) continue
      unresolved.push({ line: item.line, text: item.head })
    }
  }

  return { found, total, unresolved }
}

/**
 * 把整节切成条目。顶级列表项（`- ` / `1. `）各算一条，缩进续行与子项归到上一条。
 *
 * @param {string[]} body
 * @returns {Array<{line: number, head: string, block: string}>}
 */
function splitItems(body) {
  const out = []
  let cur = null
  // 有列表项时，节首那段说明文字（「以下八项是产品级取舍」）不是一件事项；
  // 没有列表项、整节是散文时，每段才算一条。
  const hasList = body.some((l) => /^(?:[-*]|\d+[.、)])\s+/.test(l))
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i]
    if (/^\s*>/.test(line)) continue
    const isTop = /^(?:[-*]|\d+[.、)])\s+/.test(line)
    if (isTop) {
      if (cur) out.push(cur)
      cur = { line: i + 1, head: line.replace(/^(?:[-*]|\d+[.、)])\s+/, '').slice(0, 120), block: line }
      continue
    }
    if (cur) cur.block += `\n${line}`
    else if (!hasList && line.trim()) {
      cur = { line: i + 1, head: line.trim().slice(0, 120), block: line }
    }
  }
  if (cur) out.push(cur)
  return out
}

/**
 * 待拍板事项：文档自己写好了一堆问题，然后一路通过 audit / critique / approve。
 *
 * `dev-plan/SKILL.md` 写着「全部消解后才可进入 audit 与独立 Critique」，
 * 而这条门槛此前只存在于文档里。放在这里而不是塞进 auditDoc，
 * 是因为它是一条**语义**判据（这条被拍板了吗），与结构判据分开更好查。
 *
 * @param {string} rawText 文档全文
 * @returns {Array<{code: string, line: number, message: string, fixHint: string}>}
 */
export function pendingDecisionErrors(rawText) {
  const { found, total, unresolved } = analyzePendingDecisions(rawText)
  if (!found || unresolved.length === 0) return []
  return [{
    code: 'BLOCKED_PENDING_DECISIONS',
    line: unresolved[0].line,
    message: `还有 ${unresolved.length}/${total} 条待拍板事项没有结论：${unresolved.slice(0, 3).map((u) => u.text).join('；')}`,
    fixHint: '每条要么写「已定：…」给出结论，要么删掉它。只写「建议：…」不算拍板——'
      + '建议是提给谁看的，不是谁拍的板。',
  }]
}
