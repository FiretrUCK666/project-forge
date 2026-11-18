
import { FORM_INDEPENDENT_CORE, readProjectDeclaration, resolveDocRequirements } from './doc-requirements.mjs'

/** 主干章节。`kw` 是标题弱证据，`evidence` 是内容强证据。 */
export const TDD_CORE_SECTIONS = Object.freeze([
  {
    id: 'doc-info',
    kw: ['文档信息', '文档说明', 'doc info', 'metadata'],
    evidence: [
      /(?:文档版本|版本号|最近更新|编制日期|更新日期)/,
      /(?:基线|适用范围|关联工程契约)/,
    ],
    code: 'MISSING_TDD_DOC_INFO',
    what: '文档信息（版本、基线、运行环境）',
  },
  {
    id: 'background',
    kw: ['背景', '非目标', '范围', '定位', '研究问题', 'overview', 'scope'],
    evidence: [
      /(?:核心定位|解决的核心问题|研究问题|服务对象)/,
      /(?:非目标|明确不做|不承担|不在本文范围)/,
      /(?:架构目标|关键取舍)/,
    ],
    code: 'MISSING_TDD_BACKGROUND',
    what: '背景、非目标与术语表',
  },
  {
    id: 'arch',
    kw: ['架构全景', '系统架构', '架构设计', '架构', 'architecture', '模块', '组件'],
    evidence: [
      /(?:模块|目录|组件)[^\n]{0,20}(?:职责|边界|依赖)/,
      /(?:arch-rules|分层禁引|依赖方向)/,
      /(?:入口文件|entrypoint|Feature\s*Map)/i,
    ],
    code: 'MISSING_TDD_ARCH',
    what: '系统架构全景（模块与目录职责）',
  },
  {
    id: 'flow',
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
    id: 'invariants',
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

const TDD_BUILD_CORE = Object.freeze({
  id: 'build',
  kw: ['构建', '测试', '发布链路', '验证', '门禁', 'build', 'verify', 'verification', 'experiment'],
  evidence: [
    /(?:quick-test|full-test|smoke-verify|merge-gate|构建|单测|测试|验证|复现)[^\n]{0,30}(?:命令|脚本|步骤|判定|流程)/i,
    /(?:npm\s+test|pytest|cargo\s+test|go\s+test|node\s+scripts)/i,
  ],
  code: 'MISSING_TDD_BUILD',
  what: '构建与验证链路',
})

/**
 * 核 TDD 主干与模块表。
 *
 * 未配置项目自定义 TDD 声明时，延续五段完整主干要求；配置了 `docs/templates/tdd.md`
 * 声明（`omit_sections` / `required_sections`）后，允许裁剪可选章节，但不可豁免
 * `FORM_INDEPENDENT_CORE.tdd` 三项最小核心（定位与非目标、架构/边界、构建与验证）。
 *
 * @param {string} rawText 文档全文
 * @param {{repoRoot?: string|null, docRequirements?: object|null}} opts
 * @returns {Array<{code: string, line: number, message: string, fixHint: string}>}
 */
export function checkTddStructure(rawText, { repoRoot = null, docRequirements = null } = {}) {
  const out = []
  const text = String(rawText ?? '')
  const stripped = text.replace(/<!--[\s\S]*?-->/g, '')
  const headings = [...stripped.matchAll(/^#{1,3}\s+(.+)$/gm)].map((m) => m[1])

  const customDecl = repoRoot ? readProjectDeclaration(repoRoot, 'tdd') : null
  const effReq = docRequirements ?? (customDecl ? resolveDocRequirements(repoRoot, 'tdd') : null)
  const immutableIds = new Set(FORM_INDEPENDENT_CORE.tdd)

  let sectionsToCheck = TDD_CORE_SECTIONS
  if (customDecl && effReq) {
    const reqIds = new Set(effReq.sections.map((s) => s.id))
    sectionsToCheck = [...TDD_CORE_SECTIONS, TDD_BUILD_CORE].filter(
      (sec) => immutableIds.has(sec.id) || (!effReq.omit?.has(sec.id) && reqIds.has(sec.id)),
    )
  }

  for (const sec of sectionsToCheck) {
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
