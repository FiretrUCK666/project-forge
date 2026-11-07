/**
 * markdown.mjs —— Markdown 的结构判据：围栏扫描、标题、表格首格。
 *
 * 这些判据的共同点是**要判断「这一段是不是在代码块里」**。围栏状态机只写这一份，
 * 因为判错的后果不对称：把代码块里的标记当成正文标记，会去改写用户的示例；
 * 反过来把正文当成代码，会让一处该修的地方静默不修。两处各写一遍，就会出现同一个
 * 文件、同一种损坏，两处给出不同答案。
 *
 * 本层零副作用：只读入字符串、返回结构，不碰磁盘、不认识任何业务概念。
 */

/**
 * 逐行扫描，同时给出**偏移量**、围栏状态与标题。**所有结构判据都从这里取**。
 *
 * 围栏按 CommonMark 的常见形态：起始围栏可带语言标记，闭合围栏须同类字符且不短于
 * 起始长度（` ``` ` 与 ` ~~~~ ` 不互相闭合）。
 *
 * 带上偏移量是刻意的：改写文件时按偏移**切原字符串**，而不是把行拆开再按统一行尾
 * 拼回去。后者会把标记之外那些行尾不一的行悄悄改掉——文字一个字没动，字节动了，
 * 而「标记之外一个字节都不动」正是本工具对外承诺的那句话。
 * `start` 是本行首字符的位置，`end` 是本行行尾符之后的位置（末行没有行尾符时即文末）。
 */
export function scanLines(text) {
  const out = []
  let fence = null // { marker: '`' | '~', len: n }
  let offset = 0
  for (const raw of text.split('\n')) {
    const start = offset
    offset = Math.min(start + raw.length + 1, text.length)
    const line = raw.replace(/\r$/, '')
    const info = {
      line,
      raw,
      start,
      end: offset,
      inFence: fence !== null,
      fenceEvent: null,
      heading: null,
    }
    const m = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (m !== null && (fence === null || m[1][0] === fence.marker)) {
      if (fence === null) { fence = { marker: m[1][0], len: m[1].length }; info.fenceEvent = 'open' }
      else if (m[1].length >= fence.len && m[2].trim() === '') { fence = null; info.fenceEvent = 'close' }
      info.inFence = true
      out.push(info)
      continue
    }
    if (!info.inFence) {
      const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line)
      if (h !== null) info.heading = { level: h[1].length, title: h[2] }
    }
    out.push(info)
  }
  return out
}

/**
 * 围栏覆盖的区间（`[起点, 终点)` 列表）。**围栏扫描的唯一出口**。
 *
 * 未闭合的围栏一直算到文末：那种文件的后半截在 Markdown 意义上就是代码，
 * 按「还在围栏里」处理才不会把代码里的标记当成正文的。
 */
export function fencedSpans(text) {
  const spans = []
  let openAt = -1
  for (const info of scanLines(text)) {
    if (info.fenceEvent === 'open') openAt = info.start
    else if (info.fenceEvent === 'close' && openAt >= 0) { spans.push([openAt, info.end]); openAt = -1 }
  }
  if (openAt >= 0) spans.push([openAt, text.length])
  return spans
}

/**
 * 某个标记在**围栏之外且独占一行**的出现位置（升序）。
 *
 * 排除围栏内与行内反引号内部的出现：正文在行内举例展示标记（如 `- `<!-- toc:start -->`...`）
 * 或在代码块里展示是正常用法；要求标记独占一行（行首到标记前、标记后到行尾只有空白），
 * 避免将行内代码或正文中的举例误判为结构标记。
 */
export function markerPositions(text, marker, spans = fencedSpans(text)) {
  const out = []
  for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + marker.length)) {
    if (spans.some(([a, b]) => i >= a && i < b)) continue
    const lineStart = text.lastIndexOf('\n', i - 1) + 1
    const before = text.slice(lineStart, i)
    if (!/^[ \t]*$/.test(before)) continue
    let lineEnd = text.indexOf('\n', i + marker.length)
    if (lineEnd < 0) lineEnd = text.length
    const after = text.slice(i + marker.length, lineEnd)
    if (!/^[ \t]*\r?$/.test(after)) continue
    out.push(i)
  }
  return out
}

/**
 * 按二级标题把一份 Markdown 切成「前言 + 若干节」。**全仓唯一实现**。
 *
 * 按节合并的地方有三处（注入、刷新、交棒勘察），它们必须对「哪里是下一节」给出
 * **同一个答案**：一处认为某段属于上一节、另一处认为它自成一节时，账本记的归属与
 * 实际落盘的位置就错开了，而错开的表现是「撤除时删掉了不该删的内容」。
 *
 * 两条硬规矩，都来自真实损坏：
 *
 *   1. **围栏里的 `##` 不是标题**。文档里展示一段 Markdown 示例（`## 用法` 之类）
 *      是极常见的写法；按行首匹配去切，会把围栏拆成两半，代码块前半截留在上一节、
 *      后半截被当成下一节的正文。切分必须走 `scanLines`，与全仓其余结构判据同源。
 *   2. **`heading` 就是整行去掉首尾空白**，不做任何美化。账本用它当键，键一变，
 *      历史记录就全对不上了——那是静默的失效，台账看上去仍然「有一堆记录」。
 *
 * 返回的 `lines` 含标题行本身，行尾符保留原样；`head` 是第一行标题之前的内容。
 */
export function splitSections(text) {
  const lines = scanLines(text)
  // 只认**围栏之外**的二级标题。
  const heads = lines
    .map((info, i) => ({ info, i }))
    .filter((x) => !x.info.inFence && x.info.heading !== null && x.info.heading.level === 2)
  if (heads.length === 0) return { head: text, sections: [] }
  // 前言与各节都按**行**拼回去，不带额外的行尾符：调用方会把它与别的片段一起 join，
  // 多出来或少了的那一个换行会变成成串空行，而那正是「每次都说改了、其实只差一个换行」
  // 的来源。
  const head = lines.slice(0, heads[0].i).map((l) => l.raw).join('\n')
  const sections = heads.map(({ info }, k) => {
    const endLine = k + 1 < heads.length ? heads[k + 1].i : lines.length
    // `lines` 与 `text` 给的是同一段内容的两种形态：按行改的调用方用前者，
    // 需要逐字比较字节的调用方用后者。二者都含标题行本身。
    const body = lines.slice(heads[k].i, endLine).map((l) => l.raw)
    const end = k + 1 < heads.length ? heads[k + 1].info.start : text.length
    return { heading: info.line.trim(), lines: body, text: body.join('\n'), start: info.start, end }
  })
  return { head, sections }
}