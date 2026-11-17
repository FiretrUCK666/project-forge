/**
 * tdd-structure.mjs —— 核一份 TDD 该有的主干在不在。
 *
 * 「TDD 该有什么」曾经只由模板决定：模板里写几节就是几节，项目形态一变就无解。
 * 现在主干（背景、架构、流程、不变量）是通用要求，可选节由 `tdd-shape.mjs`
 * 按项目自己的文件清单判定——所以这里只核主干。
 *
 * 认节靠关键字，不逐字比对标题：真实项目会写成
 * `## 2. 系统架构全景（双平面、四层正交）`，编号与括号补充都是常事，
 * 逐字比对会把一份写得比模板更细的文档判成缺节。
 */

/** 主干章节：任何形态的项目都得回答。`kw` 命中任意一个即算有。 */
export const TDD_CORE_SECTIONS = Object.freeze([
  { kw: ['文档信息'], code: 'MISSING_TDD_DOC_INFO', what: '文档信息（版本、基线、运行环境）' },
  { kw: ['背景', '非目标'], code: 'MISSING_TDD_BACKGROUND', what: '背景、非目标与术语表' },
  { kw: ['架构全景', '系统架构', '架构设计'], code: 'MISSING_TDD_ARCH', what: '系统架构全景（模块与目录职责）' },
  { kw: ['核心流程', '状态流转', '流水线', '主链路', '生命周期'], code: 'MISSING_TDD_FLOW', what: '核心流程与状态流转' },
  { kw: ['不变量', '安全红线'], code: 'MISSING_TDD_INVARIANTS', what: '核心不变量与安全红线' },
])

/**
 * 核 TDD 主干与模块表。
 *
 * @param {string} rawText 文档全文
 * @returns {Array<{code: string, line: number, message: string, fixHint: string}>}
 */
export function checkTddStructure(rawText) {
  const out = []
  const text = String(rawText ?? '')
  const headings = [...text.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1])

  for (const sec of TDD_CORE_SECTIONS) {
    if (headings.some((h) => sec.kw.some((k) => h.includes(k)))) continue
    out.push({
      code: sec.code,
      line: 1,
      message: `缺少「${sec.what}」节——这几节与项目形态无关，任何项目都得回答`,
      fixHint: `补一节讲清「${sec.what}」；标题含「${sec.kw.join('」或「')}」即可被认出。`,
    })
  }

  // 有模块表却只剩表头，也等于没说清模块
  const modMatch = /^###\s+模块与目录职责\s*$/m.exec(text)
  if (modMatch) {
    const after = text.slice(modMatch.index)
    const body = after.split(/\n##\s/)[0]
    const rows = (body.match(/^\|\s*[^|\-][^|]*\|/gm) ?? []).length
    if (rows <= 1) {
      out.push({
        code: 'EMPTY_TDD_MODULES',
        line: 1,
        message: '「模块与目录职责」表只有表头没有内容',
        fixHint: '把真实模块与入口文件填进表里；项目刚起步时写「暂无模块，起步后补」。',
      })
    }
  }
  return out
}
