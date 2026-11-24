/**
 * criteria-lock.mjs —— 验收标准的冻结与漂移检测。
 *
 * ## 它治的病
 *
 * `doc-plan approve` 之后，SPEC 进入 `approved` 状态，验收标准按约定「冻结」。
 * 但在此之前**没有任何东西真的把它冻住**：实现阶段回到那份 SPEC 里，
 * 把 C3 从「必须拒绝并退出码 1」改成「允许通过」，文件照样合法，`audit` 照样通过。
 *
 * 而这一切发生时，`review` 看到的是 diff——它当然能看出改了文件，但看不出
 * 「这一条是本该冻结的验收标准，而且被改松了」。
 *
 * 于是唯一的防线是审查者记得原文。人的记忆不是门禁。
 *
 * ## 做法
 *
 * 冻结时记下每条标准的**指纹**；之后每次比对三件事：
 *
 * 1. 少了哪几条（`removed`）——这是最危险的，等于把一条要求删掉；
 * 2. 哪几条的正文变了（`changed`）——可能是补充细节，也可能是偷偷放宽；
 * 3. 新增了哪几条（`added`）——收紧是好事，但也要看得见。
 *
 * 判定**只用「变没变」，不猜「变好还是变坏」**：判断改动性质需要语义理解，
 * 那是审查者的事。工具负责的是「让它不可能悄悄发生」。
 *
 * ## 边界
 *
 * 不比 markdown 全文，只比 `C*` 那几行——别的章节实现期间本来就该更新
 * （补实现说明、改影响范围），那些不该被拦。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe, sha256Text } from './git.mjs'

/** 认出一条验收标准：`- [ ] C3: 内容` 或 `- [x] C3: 内容`。 */
const CRITERIA_LINE_RE = /^\s*-\s*\[[ xX]\]\s*(C\d+)\s*[:：]\s*(.*)$/

/**
 * 抽出文档里所有验收标准。
 *
 * 代码块里的内容跳过：文档里贴一段示例不该被当成标准。
 *
 * @param {string} text
 * @returns {Array<{id: string, text: string, checked: boolean, line: number}>}
 */
export function extractCriteria(text) {
  const out = []
  let inFence = false
  const lines = String(text ?? '').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    const m = CRITERIA_LINE_RE.exec(line)
    if (!m) continue
    out.push({
      id: m[1].toUpperCase(),
      text: m[2].trim(),
      checked: /\[[xX]\]/.test(line),
      line: i + 1,
    })
  }
  return out
}

/**
 * 标准集合的指纹。
 *
 * 只算 `id + 正文`，**不算勾选状态**：勾选是实现进度，不是标准本身。
 * 把勾选算进去会让「做完一条」被判成「标准变了」，那种噪音会让人直接把门禁关掉。
 *
 * @param {Array<{id: string, text: string}>} criteria
 * @returns {string}
 */
export function criteriaFingerprint(criteria) {
  const normalized = [...(criteria ?? [])]
    .map((c) => `${c.id}\u0000${String(c.text ?? '').replace(/\s+/g, ' ').trim()}`)
    .sort()
    .join('\u0001')
  return sha256Text(normalized)
}

/**
 * 比对两次冻结的标准。
 *
 * @param {Array} before 冻结时
 * @param {Array} after 现在
 * @returns {{added: string[], removed: string[], changed: string[], same: boolean}}
 */
export function compareCriteria(before, after) {
  const beforeMap = new Map((before ?? []).map((c) => [c.id, String(c.text ?? '').replace(/\s+/g, ' ').trim()]))
  const afterMap = new Map((after ?? []).map((c) => [c.id, String(c.text ?? '').replace(/\s+/g, ' ').trim()]))

  const added = [...afterMap.keys()].filter((id) => !beforeMap.has(id)).sort()
  const removed = [...beforeMap.keys()].filter((id) => !afterMap.has(id)).sort()
  const changed = [...beforeMap.keys()]
    .filter((id) => afterMap.has(id) && afterMap.get(id) !== beforeMap.get(id))
    .sort()

  return { added, removed, changed, same: added.length === 0 && removed.length === 0 && changed.length === 0 }
}

/**
 * 给出「这份标准集合变了，差别在哪」的人话说明。
 *
 * 每条都点名到 `C` 编号——「有 2 处变化」这种话没法让人去核对。
 */
export function describeCriteriaDrift(drift) {
  const parts = []
  if (drift.removed.length > 0) parts.push(`删掉了 ${drift.removed.join('、')}`)
  if (drift.changed.length > 0) parts.push(`${drift.changed.join('、')} 的正文被改过`)
  if (drift.added.length > 0) parts.push(`新增了 ${drift.added.join('、')}`)
  return parts.join('；')
}

/**
 * 在收尾前核一次：批准时冻结的标准，现在还是不是同一套。
 *
 * 返回 `{blocked, message}` 而不是抛错——调用方要能决定怎么呈现，
 * 而这里只负责判。
 *
 * @param {object} ledger 任务账本
 * @param {string} implRoot 实施工作树根
 */
export function checkFrozenCriteria(ledger, implRoot) {
  const frozenFrom = ledger?.criteriaFrozenFrom
  if (!ledger?.criteriaFingerprint || !frozenFrom) return { blocked: false, message: '' }

  const abs = join(implRoot, frozenFrom)
  if (!existsSync(abs)) return { blocked: false, message: '' }

  const nowCriteria = extractCriteria(readTextSafe(abs) ?? '')
  if (criteriaFingerprint(nowCriteria) === ledger.criteriaFingerprint) {
    return { blocked: false, message: '' }
  }

  // 账本只存指纹不存原文，所以能确定「变了」，但说不出逐条差异——
  // 这时候老实说「去对照上一版提交」，比编一段细节可信。
  const detail = ledger.frozenCriteriaSnapshot
    ? describeCriteriaDrift(compareCriteria(extractCriteria(ledger.frozenCriteriaSnapshot), nowCriteria))
    : '账本里只存了指纹没存原文，请对照上一版提交核对'
  return {
    blocked: true,
    message: `BLOCKED_CRITERIA_DRIFT: ${frozenFrom} 的验收标准在批准之后被改过（${detail}）。\n`
      + '先把改动退回，或重新走 critique-pass 与 approve 让新标准被重新审过。\n',
  }
}
