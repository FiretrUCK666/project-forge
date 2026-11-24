/**
 * evidence-substance.mjs —— 「这段文本算不算实证」的唯一判据。
 *
 * ## 它治的是什么
 *
 * 同一个问题在三处各答了一遍：`verify --e2e-evidence` 收不收、审查回执的观察摘要
 * 收不收、放行理由（`--human-approved --reason`）收不收。三处各写一份词表，
 * 迟早分叉——查 A 处通过、B 处拒绝的现象一旦出现，人就只学会「换一句话」。
 *
 * 所以判据只在这里定义一次，三处都调它。判据只有一条：**说不说得出可核对的事实**。
 * 占位符、水话（ok/lgtm/done）、纯标点、过短的敷衍串一律不过；写清了命令、路径、
 * 输出、退出码、所见的界面状态才算数。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

/** 无信息的水话：整段等于它们（或去掉标点后等于）就不是实证。 */
export const SHALLOW_EXACT_SET = new Set([
  'ok', 'okay', 'k', 'pass', 'passed', 'passing', 'lgtm', 'done', 'good', 'fine',
  'yes', 'y', 'true', 'checked', 'verified', 'tested', 'works', 'worked', 'working',
  'green', 'clean', 'ready', 'approved', 'confirm', 'confirmed', 'success', 'succeeded',
  'all good', 'all pass', 'all passed', 'looks good', 'looks good to me',
  'tests pass', 'tests passed', 'test pass', 'test passed', 'it works',
  'no issues', 'no issue', 'no problem', 'no errors', 'ship it', 'smoke ok',
  'tbd', 'todo', 'n/a', 'na', 'none', 'null', 'nil', 'skip', 'skipped',
  '已验证', '通过', '已通过', '测试通过', '没问题', '无问题', '正常', '运行正常',
  '可以', '好的', '完成', '已完成', '已测试', '已检查', '已确认', '验证通过',
  '实测通过', '一切正常', '全部通过', '过了', '行', 'ok了', '通过了', '验证ok',
])

/** 占位符形态：整段就是一个尖括号 / 花括号 / 方括号或纯符号。 */
const PLACEHOLDER_RE = /^(?:<[^>]{1,40}>|\{[^}]{1,40}\}|\[[^\]]{1,40}\]|[.…\-_=*!?？\s]+)$/

/** 具体锚点：命令、路径、等式、数字、退出码、状态码这一类可核对的东西。 */
const EVIDENCE_CONCRETE_ANCHOR_RE = /(?:[=:/\\.]|\d|exit|stdout|stderr|status|http|cli|smoke|e2e|json|html|svg|ok_|_ok|pass_|_pass)/i

/** 去掉首尾引号、括号与标点，压平空白。 */
function normalizeText(raw) {
  return String(raw ?? '')
    .trim()
    .replace(/^[\s"'`“”‘’()（）[\]【】]+|[\s"'`“”‘’()（）[\]【】.!！?？。，,;；]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 判断一段文本有没有实质内容。
 *
 * @param {string} raw 待判文本
 * @param {{minChars?: number, subject?: string}} opts `subject` 只用于把提示写成人看得懂的话
 * @returns {{ok: boolean, code: string|null, reason: string|null, cleaned: string}}
 */
export function evaluateTextSubstance(raw, { minChars = 6, subject = '实证说明' } = {}) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) {
    return { ok: false, code: 'BLOCKED_SHALLOW_EVIDENCE', reason: `${subject}不能为空，请写清执行入口与观察到的真实输出/状态。`, cleaned: '' }
  }
  if (PLACEHOLDER_RE.test(trimmed)) {
    return { ok: false, code: 'BLOCKED_SHALLOW_EVIDENCE', reason: `${subject}「${trimmed}」是占位符，请填写实际执行入口与真实输出/状态。`, cleaned: '' }
  }
  const stripped = normalizeText(trimmed)
  const lowered = stripped.toLowerCase()
  if (!lowered || SHALLOW_EXACT_SET.has(lowered)) {
    return {
      ok: false,
      code: 'BLOCKED_SHALLOW_EVIDENCE',
      reason: `${subject}「${trimmed}」只是无实质的水话，请写清跑过的命令或看到的状态（如 "npm test -- --run exit=0"）。`,
      cleaned: '',
    }
  }
  const compact = stripped.replace(/\s+/g, '')
  if (compact.length < minChars) {
    return { ok: false, code: 'BLOCKED_SHALLOW_EVIDENCE', reason: `${subject}「${trimmed}」过短且缺少可核对细节。`, cleaned: '' }
  }
  const tokens = stripped.split(/[\s,，;；|]+/).filter(Boolean)
  const meaningful = tokens.filter((t) => !SHALLOW_EXACT_SET.has(t.toLowerCase().replace(/[.!！?？]+$/, '')))
  const hasAnchor = EVIDENCE_CONCRETE_ANCHOR_RE.test(stripped)
  if (meaningful.length === 0 || (!hasAnchor && compact.length < 8 && meaningful.length < 2)) {
    return {
      ok: false,
      code: 'BLOCKED_SHALLOW_EVIDENCE',
      reason: `${subject}「${trimmed}」缺少具体执行入口或观察结果，请写明运行对象及真实输出/退出码/状态。`,
      cleaned: '',
    }
  }
  return { ok: true, code: null, reason: null, cleaned: trimmed }
}

/**
 * 放行理由的判据：比实证观察更严一档。
 *
 * 理由要回答的不是「跑过没有」，而是「为什么可以破例」。所以它的下限比观察更高：
 * 至少要说够一段话（默认 12 字，去掉空白后），且不能是纯占位或水话。
 *
 * **这里刻意不列「必须出现哪些词」的白名单**：白名单只会逼出下一个措辞——
 * 人把「门禁」换成「检查」就能过，而真正的问题（他有没有说清为什么）一点没变。
 * 判据要的是「说了一段有内容的话」，不是「说对了暗号」。
 */
export function evaluateReleaseReason(raw, { subject = '放行理由', minChars = 12 } = {}) {
  const base = evaluateTextSubstance(raw, { minChars, subject })
  // 底层返回的是「实证太薄」那一档的错误码，而这里判的是「放行理由太薄」。
  // 两个码属于不同的处置面：实证太薄要去补跑一遍，理由太薄要去补写一段说明。
  // 原样透传会让调用方照着错误码去改错地方，所以统一换成放行侧的码。
  if (!base.ok) return { ...base, code: 'BLOCKED_SHALLOW_OVERRIDE_REASON' }
  const stripped = base.cleaned
  // 去掉空白后数一遍实际字数：`a b c d e f g` 这种空格凑出来的串不算说了一段话。
  const compact = stripped.replace(/\s+/g, '')
  if (compact.length < minChars) {
    return {
      ok: false,
      code: 'BLOCKED_SHALLOW_OVERRIDE_REASON',
      reason: `${subject}「${stripped}」太短，没说清这次为什么可以破例。`,
      cleaned: stripped,
    }
  }
  const tokens = stripped.split(/[\s,，;；、。|]+/).filter((t) => t.replace(/[^\p{L}\p{N}]/gu, '').length >= 2)
  if (tokens.length < 2) {
    return {
      ok: false,
      code: 'BLOCKED_SHALLOW_OVERRIDE_REASON',
      reason: `${subject}「${stripped}」只有一句话头，没说清这次为什么可以破例。`,
      cleaned: stripped,
    }
  }
  return { ok: true, code: null, reason: null, cleaned: stripped }
}

/**
 * 校验豁免/覆写原因（如 `--no-issue --reason`）：
 * 缺失返回 `MISSING_OVERRIDE_REASON`，水话或占位返回 `BLOCKED_SHALLOW_OVERRIDE_REASON`。
 */
export function validateOverrideReason(raw, { subject = '豁免理由', minChars = 4 } = {}) {
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) {
    return {
      ok: false,
      code: 'MISSING_OVERRIDE_REASON',
      reason: `${subject}不能为空，请通过 --reason "<具体原因>" 说明依据。`,
      cleaned: '',
    }
  }
  const base = evaluateTextSubstance(trimmed, { minChars, subject })
  if (!base.ok) {
    return {
      ok: false,
      code: 'BLOCKED_SHALLOW_OVERRIDE_REASON',
      reason: base.reason,
      cleaned: '',
    }
  }
  return { ok: true, code: null, reason: null, cleaned: base.cleaned }
}

/** 把一段理由排成账本里的一行，附上「谁在什么时候因为什么放的行」。 */
export function formatReleaseRecord({ kind, reason, by = null, at = null, bypassed = [] }) {
  const stamp = at ?? new Date().toISOString()
  const items = (bypassed ?? []).filter(Boolean)
  return {
    kind,
    reason: String(reason ?? '').trim(),
    by: by ? String(by).trim() : null,
    at: stamp,
    bypassed: items,
    rendered: `${kind}（${stamp}${by ? `，${by}` : ''}）：${String(reason ?? '').trim()}`
      + (items.length > 0 ? `；被绕过：${items.join('、')}` : ''),
  }
}
