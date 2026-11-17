/**
 * critique-rounds.mjs —— 规划审核的「这一轮要复核什么」。
 *
 * ## 它治的病
 *
 * 代码审查有增量视野硬锁：Round 2 只准看新改的地方，不准重新挑旧刺。**规划审核没有。**
 *
 * 于是 Round 2 的复核人有两条路，两条都不对：
 *
 * - **重读全文**：一份 200 行的 PRD 读一遍就吃掉大量上下文，而这一轮真正要看的
 *   只是「上一轮我提的那 5 条改了没有」；
 * - **只看改动**：图省事，于是新引入的问题一条都看不到。
 *
 * 根子是同一件事：**没有人告诉它这一轮的范围**。
 *
 * ## 这里做什么
 *
 * 把「上一轮提了什么」记在文档 frontmatter 的 `critique_findings` 里，
 * Round 2 开工时由 `doc-plan critique-scope` 输出一份清单：
 *
 * - 上一轮每条意见的原文；
 * - 这一轮正文的哈希与上一轮的哈希，判断「有没有改」；
 * - 改过的那几条要逐条回看，**没改的更要回看**（说明当时没被接受，而它仍然成立）。
 *
 * 顺带解决另一件事：**「改完就再审」这个洞**。`BLOCKED_CRITIQUE_STALE` 只防「偷偷改」，
 * 防不住「改完立刻再审一次」。所以每轮记录都要留痕，`critique-scope` 会把历史摆出来。
 */

/** frontmatter 里存上轮意见的键。 */
export const CRITIQUE_FINDINGS_KEY = 'critique_findings'

/**
 * 把一轮的意见存成一行（避免 frontmatter 里出现多行数组）。
 *
 * 形状：`<round>|<severity>|<text>`，多条用 ` ;; ` 分隔。
 * 单行是刻意的：YAML 多行数组在手工编辑时极易写坏，而写坏的表现是「意见悄悄消失」。
 */
export function serializeFindings(round, findings = []) {
  const parts = []
  for (const f of findings) {
    const text = String(typeof f === 'string' ? f : f?.text ?? '').replace(/[\r\n]+/g, ' ').replace(/;;/g, '；').trim()
    if (!text) continue
    const severity = String(typeof f === 'string' ? 'must' : (f?.severity ?? 'must')).trim() || 'must'
    parts.push(`${round}|${severity}|${text}`)
  }
  return parts.join(' ;; ')
}

/** 把存下来的历史解析回结构化记录。读不出来就跳过——不因为一条坏数据把整轮堵死。 */
export function parseFindings(raw) {
  const out = []
  for (const part of String(raw ?? '').split(';;')) {
    const seg = part.trim()
    if (!seg) continue
    const m = /^(\d+)\|([a-z]+)\|(.+)$/i.exec(seg)
    if (!m) continue
    out.push({ round: Number(m[1]), severity: m[2].toLowerCase(), text: m[3].trim() })
  }
  return out
}

/**
 * 生成「这一轮要复核什么」的清单。
 *
 * @param {object} opts
 * @param {number} opts.round 即将进行的轮次
 * @param {string} opts.currentSha 当前正文哈希（去掉 critique meta 之后算的）
 * @param {string} opts.previousSha 上一轮记录时的正文哈希
 * @param {string} opts.findingsRaw frontmatter 里的历史意见
 * @param {string} opts.reviewer 这一轮的复核人
 * @returns {{ prompt: string, mustRecheck: Array, note: string }}
 */
export function buildCritiqueScope({ round, currentSha, previousSha, findingsRaw, reviewer }) {
  const history = parseFindings(findingsRaw)
  const rounds = [...new Set(history.map((h) => h.round))].sort((a, b) => a - b)
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const lastFindings = history.filter((h) => h.round === lastRound)

  const changed = Boolean(previousSha && currentSha && String(previousSha) !== String(currentSha))

  const lines = []
  lines.push(`# 规划审核范围（Round ${round}，复核人 ${reviewer}）`)
  lines.push('')
  lines.push('> 这份清单由 `doc-plan critique-scope` 生成。它不替你判断，只告诉你**这一轮该看什么**。')
  lines.push('> 代码审查那边早有增量视野硬锁；规划审核此前没有，于是 Round 2 要么重读全文（吃光上下文），')
  lines.push('> 要么只看改动（新问题一条看不到）。两头都不对。')
  lines.push('')

  if (lastFindings.length > 0) {
    lines.push(`## 上一轮（Round ${lastRound}）提了 ${lastFindings.length} 条`)
    lines.push('')
    for (const f of lastFindings) {
      const tag = f.severity === 'must' ? '必修' : '建议'
      lines.push(`- [${tag}] ${f.text}`)
    }
    lines.push('')
    lines.push(changed
      ? '**正文在上一轮之后改过。** 请逐条确认：改的那条是否真的解决了，改的过程中有没有引入新问题。'
      : '**正文在上一轮之后没有改动。** 那么上一轮的每条意见要么当时就被接受（现在应已在正文里），'
        + '要么当时被驳回——被驳回的更要回看：它现在仍然成立吗？')
    lines.push('')
  } else if (round >= 2) {
    lines.push('## 上一轮没有记录意见')
    lines.push('')
    lines.push('这不代表上一轮没问题——也可能是那一轮没把意见记下来。请按完整范围审一遍，')
    lines.push('并在本轮用 `critique-pass --findings` 把意见记进去，别让下一轮又从零开始。')
    lines.push('')
  } else {
    lines.push('## 第一轮')
    lines.push('')
    lines.push('按完整范围审。审出的每一条都用 `critique-pass --findings` 记下来——那是下一轮的范围依据。')
    lines.push('')
  }

  lines.push('## 正文指纹')
  lines.push('')
  lines.push(`- 当前：\`${currentSha ?? '(未计算)'}\``)
  lines.push(`- 上轮：\`${previousSha ?? '(无记录)'}\``)
  lines.push('')

  return {
    prompt: `${lines.join('\n').trimEnd()}\n`,
    mustRecheck: lastFindings.map((f) => f.text),
    changed,
    note: lastFindings.length > 0
      ? `上一轮 ${lastFindings.length} 条，正文${changed ? '已改' : '未改'}`
      : '无历史意见',
  }
}
