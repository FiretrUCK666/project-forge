/**
 * tdd-structure.mjs —— 核一份 TDD 该有的主干在不在。
 *
 * ## 判据：认内容，不认标题
 *
 * 「TDD 该有什么」曾经只由模板决定：模板里写几节就是几节，项目形态一变就无解。
 * 现在主干是通用要求，可选节由 `tdd-shape.mjs` 按项目自己的文件清单判定。
 *
 * 更要紧的是**怎么认**。真实项目的 TDD 标题千奇百怪：
 *
 * - `## 2. 系统架构全景（双平面、四层正交）`——带编号和括号补充；
 * - `## Architecture`——英文；
 * - `## 部署架构` 里顺手写了模块边界——内容答了，标题没对上。
 *
 * 逐字比对标题会把一份写得比模板更细的文档判成缺节。所以这里和
 * `doc-requirements.mjs` 用同一套办法：**标题是弱证据，内容是强证据**。
 *
 * ## 主干为什么是这五件
 *
 * 一份技术设计文档，不论项目形态如何，接手人要知道的都是：
 *
 * 1. 这份文档说什么、以哪个版本为准（**文档信息**）；
 * 2. 这东西是干什么的、明确不干什么（**背景与非目标**）；
 * 3. 代码是怎么分的（**架构与模块**）；
 * 4. 一次请求/一次跑批是怎么走的（**主流程**）；
 * 5. 哪里破了会出事故（**不变量与红线**）。
 *
 * 少了任何一条，接手人只能去读代码猜——那正是 TDD 要省掉的事。
 */

/** 主干章节。`kw` 是标题弱证据，`evidence` 是内容强证据。 */
export const TDD_CORE_SECTIONS = Object.freeze([
  {
    kw: ['文档信息', '文档说明', 'doc info', 'metadata'],
    evidence: [
      /(?:文档版本|版本号|最近更新|编制日期|更新日期)/,
      /(?:基线|适用范围|关联工程契约)/,
    ],
    code: 'MISSING_TDD_DOC_INFO',
    what: '文档信息（版本、基线、运行环境）',
  },
  {
    kw: ['背景', '非目标', '范围', '定位', 'overview', 'scope'],
    evidence: [
      /(?:核心定位|解决的核心问题|服务对象)/,
      /(?:非目标|明确不做|不承担)/,
      /(?:架构目标|关键取舍)/,
    ],
    code: 'MISSING_TDD_BACKGROUND',
    what: '背景、非目标与术语表',
  },
  {
    kw: ['架构全景', '系统架构', '架构设计', '架构', 'architecture', '模块'],
    evidence: [
      /(?:模块|目录)[^\n]{0,20}(?:职责|边界|依赖)/,
      /(?:arch-rules|分层禁引|依赖方向)/,
      /(?:入口文件|entrypoint|Feature\s*Map)/i,
    ],
    code: 'MISSING_TDD_ARCH',
    what: '系统架构全景（模块与目录职责）',
  },
  {
    kw: ['核心流程', '状态流转', '流水线', '主链路', '生命周期', '流程', 'flow'],
    evidence: [
      /(?:主链路|正常主链路|数据流|调用链)/,
      /(?:状态(?:迁移|流转)|状态机)/,
      /(?:失败|回退|降级)[^\n]{0,20}(?:语义|行为|策略)/,
    ],
    code: 'MISSING_TDD_FLOW',
    what: '核心流程与状态流转',
  },
  {
    kw: ['不变量', '安全红线', '红线', 'invariant'],
    evidence: [
      /(?:不变量|invariant)/i,
      /(?:安全红线|破坏即事故|零容忍)/,
      /(?:单一真相源|原子写入|幂等)/,
    ],
    code: 'MISSING_TDD_INVARIANTS',
    what: '核心不变量与安全红线',
  },
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
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '')
  const headings = [...stripped.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1])

  for (const sec of TDD_CORE_SECTIONS) {
    const byTitle = headings.some((h) => sec.kw.some((k) => h.toLowerCase().includes(k.toLowerCase())))
    // 标题没命中时看内容：写得细的文档常把内容摊在别的标题下。
    const byContent = !byTitle && sec.evidence.some((re) => re.test(stripped))
    if (byTitle || byContent) continue
    out.push({
      code: sec.code,
      line: 1,
      message: `缺少「${sec.what}」节——这几节与项目形态无关，任何项目都得回答`,
      fixHint: `补一节讲清「${sec.what}」；标题含「${sec.kw.join('」或「')}」，`
        + '或者正文里写清了这件事（工具按内容认，不只看标题）。',
    })
  }

  // 有模块表却只剩表头，也等于没说清模块
  const modMatch = /^#{2,4}\s+(?:模块与目录职责|模块职责|模块划分|目录职责|模块与目录)\s*$/m.exec(stripped)
  if (modMatch) {
    const after = stripped.slice(modMatch.index)
    const body = after.split(/\n#{1,2}\s/)[0]
    // 表格数据行：以竖线开头、且不是分隔行（`| --- |`）也不算表头
    const rows = (body.match(/^\|(?!\s*-)[^|]*\|/gm) ?? []).length
    // 表头 + 分隔行 = 2 行；没有第三行就是空表
    if (rows <= 2) {
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
