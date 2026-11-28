/**
 * doc-toc.mjs —— 目录按实际章节生成。
 *
 * ## 它治的病
 *
 * TDD 模板里「目录」是**手写的固定链接**。而章节是可裁剪的：裁掉几节目录不会跟着变，
 * 保留更多可选节目录也不会跟着变。结果是一份「目录与正文节数对不上」或者
 * 「目录里链到一节已经被裁掉的标题」——**目录是死链**，而且是看不出来的那种死链
 * （点不动没人报错，只有读的人自己发现）。
 *
 * 根因和章节序号一样：**目录是章节集合的函数，不该单独写一份**。
 *
 * ## 做法
 *
 * 按渲染后的**真实 `## ` 标题**生成。锚点用 GitHub 的规则（去标点、空格转连字符、转小写）。
 * 生成时跳过目录自己。
 *
 * ## 兼容既有目录
 *
 * 模板里的目录会被整块替换，不管原来写了什么；没有目录的模板不受影响。
 */

/** 认出一个二级标题。 */
const H2_RE = /^##\s+(.+)$/

/** 目录块：从 `## 目录` 到下一个 `## `。 */
const TOC_BLOCK_RE = /(^##\s+目录\s*\n)([\s\S]*?)(?=\n##\s)/m

/**
 * GitHub 风格的锚点。
 *
 * 规则按 GitHub 实际做法：去掉标点与符号，空格转连字符，转小写。
 * 中文原样保留（GitHub 就是这么处理的）。
 *
 * @param {string} heading
 * @returns {string}
 */
export function githubAnchor(heading) {
  return String(heading ?? '')
    .trim()
    // 去掉编号前缀「一、」这类——GitHub 会保留，但保留之后锚点难读，
    // 而且编号本身会随裁剪变化。这里与 renumber 配合：先编号再生成锚点，
    // 生成的锚点就不含编号。
    .replace(/^[一二三四五六七八九十百]+、\s*/, '')
    .replace(/[`*_[\]()（）【】「」《》""''·.,:;!?/\\|+<>=~^$%@#&]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
}

/**
 * 按正文里真实的二级标题重写目录。
 *
 * @param {string} text
 * @returns {string}
 */
export function rewriteToc(text) {
  const src = String(text ?? '')
  const lines = src.split('\n')

  const headings = []
  for (const line of lines) {
    const m = H2_RE.exec(line)
    if (!m) continue
    const title = m[1].trim()
    if (title === '目录') continue
    headings.push(title)
  }
  if (headings.length === 0) return src

  const entries = headings.map((h) => `- [${h}](#${githubAnchor(h)})`).join('\n')

  if (TOC_BLOCK_RE.test(src)) {
    return src.replace(TOC_BLOCK_RE, (_w, head) => `${head}${entries}\n`)
  }
  return src
}
