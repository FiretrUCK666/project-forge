/**
 * doc-templates.mjs —— 统一工程文档模板生成器与 Mermaid 标签宽度静态门禁。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 docs.mjs 汇总导出。
 */

export const MERMAID_LIMITS = Object.freeze({
  rectMaxWidth: 16,
  subgraphMaxWidth: 16,
  diamondMaxWidth: 12,
  edgeMaxWidth: 12,
})

function isWideCharCode(cp) {
  return (cp >= 0x1100 && cp <= 0x115f)
    || (cp >= 0x2013 && cp <= 0x2027)
    || (cp >= 0x2e80 && cp <= 0x303f)
    || (cp >= 0x3040 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf)
    || (cp >= 0x4e00 && cp <= 0x9fff)
    || (cp >= 0xac00 && cp <= 0xd7af)
    || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe6f)
    || (cp >= 0xff01 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6)
    || cp > 0xffff
}

/** 计算单行字符显示宽度：全角/汉字计 2 单位，半角 ASCII 计 1 单位。 */
export function displayWidth(str) {
  let w = 0
  for (const ch of String(str ?? '')) {
    const cp = ch.codePointAt(0) ?? 0
    w += isWideCharCode(cp) ? 2 : 1
  }
  return w
}

const MERMAID_HTML_TAG_RE = /<\/?(?:br|p|div|span|b|i|strong|em|small|code|sub|sup|ul|ol|li|font|table|tr|td|th|hr)\b[^>]*>/i

/**
 * 校验 Markdown 内全部 `mermaid` 图表防截断规范：
 *   - 矩形节点与分组标题单行 <= 16 单位；
 *   - 菱形判断节点与边标签单行 <= 12 单位；
 *   - 禁止在节点/标签内使用 HTML 标签（如 `<br/>`）。
 */
export function checkMermaidLabelWidth(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const violations = []
  let inMermaid = false
  let blockIndex = 0
  let fenceLen = 0

  const inspectLabel = ({ label, kind, maxWidth, lineNo }) => {
    const raw = String(label ?? '').trim()
    if (!raw) return
    if (MERMAID_HTML_TAG_RE.test(raw)) {
      violations.push({
        blockIndex, line: lineNo, kind: 'html', label: raw, width: displayWidth(raw), maxWidth,
        message: `第 ${lineNo} 行 Mermaid ${kind} 标签含禁止的 HTML 标签：${raw}`,
        fixHint: '删除节点/边标签中的 <br/> 等 HTML 标签，改用不超过宽度上限的精简短名。',
      })
    }
    for (const subLine of raw.split(/\\n|\n/)) {
      const part = subLine.trim()
      if (!part) continue
      const w = displayWidth(part)
      if (w > maxWidth) {
        violations.push({
          blockIndex, line: lineNo, kind, label: part, width: w, maxWidth,
          message: `第 ${lineNo} 行 Mermaid ${kind}「${part}」显示宽度 ${w} 超过上限 ${maxWidth}（全角计2/半角计1）`,
          fixHint: `将标签精简至 ${maxWidth} 单位以内（矩形/分组 <=16，菱形/边 <=12），详细路径放进下方对照表。`,
        })
      }
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    const fenceOpen = /^(`{3,}|~{3,})\s*(.*)$/.exec(trimmed)
    if (!inMermaid) {
      if (fenceOpen && /^mermaid\b/i.test(fenceOpen[2].trim())) {
        inMermaid = true
        fenceLen = fenceOpen[1].length
        blockIndex += 1
      }
      continue
    }
    if (/^(`{3,}|~{3,})\s*$/.test(trimmed) && trimmed.length >= fenceLen) {
      inMermaid = false
      continue
    }
    if (!trimmed || trimmed.startsWith('%%') || /^(?:flowchart|graph|sequenceDiagram|stateDiagram|classDiagram|erDiagram|style|classDef|class|linkStyle|click|direction|end)\b/i.test(trimmed)) {
      continue
    }

    const lineNo = i + 1
    let working = line

    const sg = /^\s*subgraph\s+(?:[A-Za-z0-9_.-]+\s*\[\s*"([^"]*)"\s*\]|[A-Za-z0-9_.-]+\s*\[\s*([^\]]*)\s*\]|"?([^"\n]+?)"?)\s*$/.exec(working)
    if (sg) {
      inspectLabel({ label: sg[1] ?? sg[2] ?? sg[3], kind: 'subgraph', maxWidth: MERMAID_LIMITS.subgraphMaxWidth, lineNo })
      continue
    }

    working = working.replace(/\|"([^"]*)"\||\|([^|\n]+)\|/g, (_, q, u) => {
      inspectLabel({ label: q ?? u, kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
      return ' '
    })
    working = working.replace(/(?:--|==|-\.)\s+"([^"]*)"\s+(?:-->|==>|---|-\.->|\.->)/g, (_, q) => {
      inspectLabel({ label: q, kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
      return ' --> '
    })
    working = working.replace(/(?:--|==)\s+([^-\n>|=]+?)\s+(?:-->|==>)/g, (_, u) => {
      inspectLabel({ label: u, kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
      return ' --> '
    })

    working = working.replace(/(?<!\{)\{\s*"([^"]*)"\s*\}(?!\})|(?<!\{)\{\s*([^{}\n"]+)\s*\}(?!\})/g, (_, q, u) => {
      inspectLabel({ label: q ?? u, kind: 'diamond', maxWidth: MERMAID_LIMITS.diamondMaxWidth, lineNo })
      return ' '
    })

    for (const m of working.matchAll(/(?:\[\[|\[\(|\(\[|\{\{|\[|\()\s*"([^"]*)"\s*(?:\]\]|\)\]|\]\)|\}\}|\]|\))|(?:\[\[|\[)\s*([^\]\n"]+)\s*(?:\]\]|\])/g)) {
      const lbl = m[1] ?? m[2]
      if (lbl !== undefined) inspectLabel({ label: lbl, kind: 'node', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
    }
  }

  return { ok: violations.length === 0, checkedBlocks: blockIndex, violations }
}

/**
 * 统一工程文档模板生成器（YAML Frontmatter + 顶部可见元信息概览表 + SPEC 短名 Mermaid 图）。
 */
export function buildStandardDocContent({
  kind,
  title,
  safeSlug,
  today,
  headSha = 'uncommitted',
  headBranch = null,
  taskId,
  issueNum = null,
  owner = null,
  quickCmd = '<填写项目快测命令>',
  relatedPrdRel = null,
  relatedSpecRel = null,
  relatedTodoRel = null,
  criteria,
  scopePaths,
  reusableModules,
  nonGoals,
  doorType,
  rollbackPath,
  serializeFm,
  keyOrders,
}) {
  const effectiveCriteria = Array.isArray(criteria) && criteria.length > 0 ? criteria : null

  if (kind === 'prd') {
    const fm = serializeFm({
      kind: 'prd', title, status: 'draft', created: today, updated: today,
      issue: issueNum, pr: null, owner: owner ?? null, plan_critique: 'pending',
      related_spec: relatedSpecRel ?? null, related_todo: relatedTodoRel ?? null,
    }, keyOrders.prd)
    return [
      fm.trimEnd(), '', `# PRD: ${title}`, '',
      '## 文档信息', '',
      '| 项目 | 内容 |', '| --- | --- |',
      '| 当前状态 | `draft`（枚举：`draft \\| active \\| in_review \\| done \\| dropped`） |',
      `| 创建 / 更新 | \`${today}\` / \`${today}\` |`,
      `| 关联 Issue | ${issueNum ? `#${issueNum}` : '未关联'} |`,
      `| 负责人 | ${owner ?? '待认领'} |`, '',
      '## 背景与目标', '', '<!-- 一两段说清真实用户痛点与预期可观测收益 -->', '',
      '## 复用既有模块', '',
      ...(Array.isArray(reusableModules) && reusableModules.length > 0 ? reusableModules.map((m) => `- ${m}`) : ['- <待核实填写：拟复用的现成模块文件路径与导出能力>']), '',
      '## 本期不做', '',
      ...(Array.isArray(nonGoals) && nonGoals.length > 0 ? nonGoals.map((g) => `- ${g}`) : ['- <明确排除的扩展设想，防止需求蔓延>']), '',
      '## 门型与回滚路径', '',
      `- 门型：${doorType ?? '<two-way | one-way>'}`,
      `- 回滚路径：${rollbackPath ?? '<说明如何安全撤回，不可逆改动须写明降级方案>'}`, '',
      '## 验收标准（动手之前冻结）', '',
      ...(effectiveCriteria ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`) : ['- [ ] C1: <第一条可判定的产品结果>', '- [ ] C2: <第二条>']), '',
    ].join('\n')
  }

  if (kind === 'spec') {
    const fm = serializeFm({
      kind: 'spec', title, status: 'draft', tier: 'L3', created: today, updated: today,
      issue: issueNum, pr: null, branch: headBranch, owner: owner ?? null,
      approved: false, implemented: false, plan_critique: 'pending',
      related_prd: relatedPrdRel ?? null, related_todo: relatedTodoRel ?? null, high_risk_paths: [],
    }, keyOrders.spec)
    return [
      fm.trimEnd(), '', `# SPEC: ${title}`, '',
      '## 文档信息与变更概览', '',
      '| 项目 | 内容 |', '| --- | --- |',
      '| 当前状态 | `draft`（`draft \\| approved \\| implementing \\| in_review \\| implemented \\| superseded`） |',
      '| 规划级别 | `L3` |',
      `| 创建 / 更新 | \`${today}\` / \`${today}\` |`,
      `| 分支 / Issue | \`${headBranch ?? '待创建'}\` / ${issueNum ? `#${issueNum}` : '未关联'} |`, '',
      '## 系统变更全景', '',
      '```mermaid', 'flowchart LR', '  In["请求输入"] --> Core["核心改动"]', '  Core --> Gate["门禁验证"]', '```', '',
      '| 模块 / 文件 | 变更性质 | 核心职责 |', '| --- | --- | --- |',
      '| `<真实文件路径，新建文件标 (new)>` | 改造 / 新增 | <受影响的模块、协议或对外契约> |', '',
      '## 目标与约束', '',
      '- **要改什么**：<受影响的模块、协议或对外契约>',
      '- **不改什么**：<明确保持兼容或本次不触碰的模块>',
      '- **架构基线关系**：<对齐既有不变量与 `arch-rules`；若冲突，须先退回更新 `docs/TDD.md`>', '',
      '## 复用既有模块', '',
      ...(Array.isArray(reusableModules) && reusableModules.length > 0 ? reusableModules.map((m) => `- ${m}`) : ['- <待核实填写：复用项目中已有的工具/协议/脚本路径，不重复造轮子>']), '',
      '## 本期不做', '',
      ...(Array.isArray(nonGoals) && nonGoals.length > 0 ? nonGoals.map((g) => `- ${g}`) : ['- <明确本期保持不动或故意延后的范围>']), '',
      '## 接口与数据契约', '',
      '- <新增或调整的接口、参数、文件结构、退出码或状态流转>',
      '- <失败时如何降级或阻断、权限校验、并发/状态持久化保护>', '',
      '## 影响范围', '',
      ...(Array.isArray(scopePaths) && scopePaths.length > 0 ? scopePaths.map((p) => `- 预计涉及文件：\`${p}\``) : ['- 预计涉及文件：<真实文件路径，新建文件标 (new)>']), '',
      '## 门型与回滚路径', '',
      `- 门型：${doorType ?? '<two-way | one-way>'}`,
      `- 回滚路径：${rollbackPath ?? '<说明回退命令或反向修补方式>'}`, '',
      '## 验收标准（动手之前冻结）', '',
      ...(effectiveCriteria ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`) : ['- [ ] C1: <第一条可判定的标准>', '- [ ] C2: <第二条>']), '',
      '## 实现说明', '', '<!-- 在合并之前补齐真实实现摘要与验证结果 -->', '',
    ].join('\n')
  }

  const fm = serializeFm({
    kind: 'todo', title, status: 'active', created: today, updated: today,
    issue: issueNum, pr: null, branch: headBranch, owner: owner ?? null,
    approved: false, done_at: null, task_id: taskId ?? safeSlug ?? 'task',
    planned_at: headSha, related_prd: relatedPrdRel ?? null, related_spec: relatedSpecRel ?? null,
  }, keyOrders.todo)
  return [
    fm.trimEnd(), '', `# Todo: ${title}`, '',
    '## 文档信息与范围概览', '',
    '| 项目 | 内容 |', '| --- | --- |',
    '| 当前状态 | `active`（`draft \\| active \\| in_review \\| done \\| archived \\| dropped`） |',
    `| 建单 / 更新 | \`${today}\` / \`${today}\` |`,
    `| 分支 / 基线 | \`${headBranch ?? '待创建'}\` @ \`${String(headSha ?? 'uncommitted').slice(0, 7)}\` |`,
    `| 任务编号 | \`${taskId ?? safeSlug ?? 'task'}\` |`, '',
    '## 影响范围', '',
    ...(Array.isArray(scopePaths) && scopePaths.length > 0 ? scopePaths.map((p) => `- 预计改动文件：\`${p}\``) : ['- 预计改动文件：<待核实真实路径，新建文件标 (new)>']),
    `- 快测命令：\`${quickCmd}\``, '',
    '## 复用既有模块', '',
    ...(Array.isArray(reusableModules) && reusableModules.length > 0 ? reusableModules.map((m) => `- ${m}`) : ['- <待核实填写：准备复用的现成函数、库或脚本>']), '',
    '## 本期不做', '',
    ...(Array.isArray(nonGoals) && nonGoals.length > 0 ? nonGoals.map((g) => `- ${g}`) : ['- <明确排除本次不顺手重构的无关事项>']), '',
    '## 门型与回滚路径', '',
    `- 门型：${doorType ?? 'two-way'}`,
    `- 回滚路径：${rollbackPath ?? '局部可逆改动，直接 git revert 或删除临时分支即可回退。'}`, '',
    '## 验收标准（动手之前冻结）', '',
    ...(effectiveCriteria ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`) : ['- [ ] C1: <第一条可判定的标准>', '- [ ] C2: <第二条>']), '',
    '## 执行步骤', '',
    `1. 先补齐复现或验收测试 —— 验证：\`${quickCmd}\``,
    `2. 实现核心改动并补齐反面用例 —— 验证：\`${quickCmd}\``, '',
    '## 完成后的记录', '',
    '**在合并之前写完，随这次改动一起提交。**', '',
    '- 验证命令与结果：',
    '- 遇到的问题与回避方式：', '',
  ].join('\n')
}
