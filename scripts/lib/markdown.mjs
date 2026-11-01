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
 * 某个标记在**围栏之外**的出现位置（升序）。
 *
 * 排除围栏内的出现不是洁癖：文档里在代码块里展示这对标记是正常的用法（本脚本的
 * 报错信息就是这么写的），把它算进去会得到「文件里有两对标记」这种错误答案，
 * 进而把一份好文件判成受损。
 */
export function markerPositions(text, marker, spans = fencedSpans(text)) {
  const out = []
  for (let i = text.indexOf(marker); i >= 0; i = text.indexOf(marker, i + marker.length)) {
    if (!spans.some(([a, b]) => i >= a && i < b)) out.push(i)
  }
  return out
}