/**
 * doc-renumber.mjs —— 章节编号按裁剪结果重排。
 *
 * ## 它治的病
 *
 * 模板里的章节写成 `## 一、要解决的问题`、`## 二、范围与非目标`……编号是**写死在模板正文里**的。
 * 一旦按项目形态裁掉几节，编号就变成 `一、二、八、九`——中间的空档会让人以为文档缺了东西，
 * 而它只是被裁掉了。
 *
 * 根因不是「编号写错了」，是**编号不该写死在模板里**：章节是可变集合，序号必须由集合算出来。
 *
 * ## 做法
 *
 * 渲染完、裁完，再按出现顺序重排中文序号。只动 `## <序号>、` 这一种形态，
 * 别的标题（`## 文档信息`、`## 系统变更全景`、`## 实现说明`）原样不动。
 *
 * ## 为什么不做成「模板里不写编号」
 *
 * 因为人读文档时编号是有用的（「第三点」比「用户身份与权限那节」好指）。
 * 所以保留编号，但让它成为**算出来的**，不是抄来的。
 */

/** 中文序号 1..99。够用到任何真实文档。 */
const CN_NUM = [
  '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '二十一', '二十二', '二十三', '二十四', '二十五', '二十六', '二十七', '二十八', '二十九', '三十',
  '三十一', '三十二', '三十三', '三十四', '三十五', '三十六', '三十七', '三十八', '三十九', '四十',
  '四十一', '四十二', '四十三', '四十四', '四十五', '四十六', '四十七', '四十八', '四十九', '五十',
]

/** 认出一个带中文序号的一级标题：`## 三、用户身份与权限`。 */
const NUMBERED_H2_RE = /^##\s+[一二三四五六七八九十百]+、\s*(.+)$/

/**
 * 按出现顺序重排 `## <序号>、<标题>` 的序号。
 *
 * 只重排连续的标题块；`## 文档信息` 这类不带序号的标题不参与计数，
 * 也不会打断计数——它们的顺序本来就不该影响章节号。
 *
 * @param {string} text
 * @returns {string}
 */
export function renumberHeadings(text) {
  let n = 0
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const m = NUMBERED_H2_RE.exec(line)
      if (!m) return line
      n += 1
      const label = CN_NUM[n - 1]
      // 超过表的范围就退回阿拉伯数字——比留一个错的序号好。
      const shown = label ?? String(n)
      return `## ${shown}、${m[1]}`
    })
    .join('\n')
}

/**
 * 检查一份文档里的编号是否连续。
 *
 * 判据是**相邻两个有序号的标题必须相差 1**，不是「第一个必须是一」。
 * 理由：真实文档常常只写其中几节（摘要、摘录、分册），从「五、」开始是合法的；
 * 真正的问题是中间跳号——`一、二、八` 会让读的人以为缺了三节。
 *
 * 给审计用：如果有人手改文档把编号改乱了，要能报出来，
 * 否则「序号连续」这件事就只是今天恰好成立。
 *
 * @param {string} text
 * @returns {Array<{line: number, found: string, expected: string}>}
 */
export function findNumberingGaps(text) {
  const out = []
  const lines = String(text ?? '').split('\n')
  let prev = null
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^##\s+([一二三四五六七八九十百]+)、/.exec(lines[i])
    if (!m) continue
    const n = CN_NUM.indexOf(m[1]) + 1
    if (n <= 0) continue
    if (prev !== null && n !== prev + 1) {
      const want = CN_NUM[prev] ?? String(prev + 1)
      out.push({ line: i + 1, found: m[1], expected: want })
    }
    prev = n
  }
  return out
}

/**
 * 把编号缺口转成审计能直接收的错误项。
 *
 * 放在这里而不是 `doc-audit.mjs`，是因为「怎么算连续」和「怎么报」是同一件事的两半——
 * 分两处写，改一处忘另一处，就会出现「报出来的期望值和判据不一致」。
 *
 * @param {string} text 文档正文
 * @returns {Array<{code: string, line: number, message: string, fixHint: string}>}
 */
export function numberingErrors(text) {
  return findNumberingGaps(text).map((gap) => ({
    code: 'NUMBERING_GAP',
    line: gap.line,
    message: `第 ${gap.line} 行的章节序号是「${gap.found}」，按出现顺序应为「${gap.expected}」`,
    fixHint: '删掉或插入章节后要重排序号；工具在生成时会自动重排，手改时请一并改。',
  }))
}
