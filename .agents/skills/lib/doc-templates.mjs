/**
 * doc-templates.mjs —— 统一工程文档模板生成器、联动同步解析与 Mermaid 标签宽度静态门禁。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 docs.mjs 汇总导出。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { posixPath, readTextSafe } from './git.mjs'
import { CUSTOM_DECL_REL } from './doc-frontmatter.mjs'
import { resolveDocRequirements } from './doc-requirements.mjs'
import { formatDocShapeSkippedBlock, resolveDocShapePolicy } from './doc-shape.mjs'
import { renderDocTemplate } from './doc-template-render.mjs'
import { resolveDocPlanMode } from './pending-decisions.mjs'
import { resolveAuthoritativeTddPath } from './profile.mjs'

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

function stripOuterDoubleQuotes(s) {
  const t = String(s ?? '').trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).trim() : t
}

function detectMermaidDiagramType(trimmed) {
  if (/^(?:flowchart|graph)\b/i.test(trimmed)) return 'flowchart'
  if (/^sequenceDiagram\b/i.test(trimmed)) return 'sequence'
  if (/^stateDiagram(?:-v2)?\b/i.test(trimmed)) return 'state'
  if (/^erDiagram\b/i.test(trimmed)) return 'er'
  if (/^(?:classDiagram|pie|gantt|journey|gitGraph|mindmap|timeline|xychart-beta)\b/i.test(trimmed)) return 'other'
  return null
}

/**
 * 校验 Markdown 内全部 `mermaid` 图表防截断规范：
 *   - 矩形节点、分组标题、参与者与实体单行 <= 16 单位；
 *   - 菱形判断节点、边标签、时序消息与注释单行 <= 12 单位；
 *   - 禁止在节点/标签内使用 HTML 标签（如 `<br/>`）。
 */
export function checkMermaidLabelWidth(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const violations = []
  let inMermaid = false
  let blockIndex = 0
  let fenceLen = 0
  let diagramType = 'unknown'
  let inErEntityBlock = false

  const inspectLabel = ({ label, kind, maxWidth, lineNo }) => {
    const raw = stripOuterDoubleQuotes(label)
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
        diagramType = 'unknown'
        inErEntityBlock = false
      }
      continue
    }
    if (/^(`{3,}|~{3,})\s*$/.test(trimmed) && trimmed.length >= fenceLen) {
      inMermaid = false
      inErEntityBlock = false
      continue
    }
    if (!trimmed || trimmed.startsWith('%%')) continue

    if (diagramType === 'unknown') {
      const detected = detectMermaidDiagramType(trimmed)
      if (detected) {
        diagramType = detected
        continue
      }
      diagramType = 'flowchart'
    } else if (detectMermaidDiagramType(trimmed)) {
      continue
    }

    if (/^(?:style|classDef|class|linkStyle|click|direction|end|autonumber|activate|deactivate|destroy|create)\b/i.test(trimmed)) {
      continue
    }

    const lineNo = i + 1
    if (diagramType === 'other') continue

    if (diagramType === 'sequence') {
      const partAs = /^\s*(?:participant|actor)\s+(.+?)\s+as\s+(.+)$/i.exec(line)
      if (partAs) {
        inspectLabel({ label: partAs[2], kind: 'participant', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
        continue
      }
      const partBare = /^\s*(?:participant|actor)\s+(.+)$/i.exec(line)
      if (partBare) {
        inspectLabel({ label: partBare[1], kind: 'participant', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
        continue
      }
      const blk = /^\s*(?:loop|alt|else|opt|par|and|critical|option|break)\s+(.+)$/i.exec(line)
      if (blk) {
        inspectLabel({ label: blk[1], kind: 'subgraph', maxWidth: MERMAID_LIMITS.subgraphMaxWidth, lineNo })
        continue
      }
      const note = /^\s*Note\s+(?:left\s+of|right\s+of|over)\s+[^:\n]+:\s*(.+)$/i.exec(line)
      if (note) {
        inspectLabel({ label: note[1], kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
        continue
      }
      const msg = /^[^:\n]*?(?:<<?--?>>?|--?[x)]|->?|->>|-->>)\s*[+-]?[^:\n]*:\s*(.+)$/.exec(line)
      if (msg) {
        inspectLabel({ label: msg[1], kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
      }
      continue
    }

    if (diagramType === 'state') {
      const stAlias = /^\s*state\s+"([^"]*)"\s+as\s+[A-Za-z0-9_.-]+/i.exec(line)
      if (stAlias) {
        inspectLabel({ label: stAlias[1], kind: 'node', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
        continue
      }
      const stNote = /^\s*note\s+(?:left\s+of|right\s+of)\s+[^:\n]+:\s*(.+)$/i.exec(line)
      if (stNote) {
        inspectLabel({ label: stNote[1], kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
        continue
      }
      const stEdge = /^[^:\n]*?-->[^:\n]*:\s*(.+)$/.exec(line)
      if (stEdge) {
        inspectLabel({ label: stEdge[1], kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
        continue
      }
      if (!/-->/.test(trimmed)) {
        const stDesc = /^\s*[A-Za-z0-9_.*[\]-]+\s*:\s*(.+)$/.exec(line)
        if (stDesc) inspectLabel({ label: stDesc[1], kind: 'node', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
      }
      continue
    }

    if (diagramType === 'er') {
      if (inErEntityBlock) {
        if (/^\s*\}/.test(trimmed)) inErEntityBlock = false
        continue
      }
      const erBlock = /^\s*("[^"]*"|[A-Za-z0-9_.-]+)(?:\s*\[\s*"?([^"\]\n]+)"?\s*\])?\s*\{/.exec(line)
      if (erBlock) {
        inspectLabel({ label: erBlock[2] ?? erBlock[1], kind: 'node', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
        if (!/\}\s*$/.test(trimmed)) inErEntityBlock = true
        continue
      }
      const erRel = /^\s*("[^"]*"|[A-Za-z0-9_.-]+)(?:\s*\[\s*"?([^"\]\n]+)"?\s*\])?\s+[|o}{1]+(?:--|\.\.)[|o}{1]+\s+("[^"]*"|[A-Za-z0-9_.-]+)(?:\s*\[\s*"?([^"\]\n]+)"?\s*\])?(?:\s*:\s*(.+))?\s*$/.exec(line)
      if (erRel) {
        inspectLabel({ label: erRel[2] ?? erRel[1], kind: 'node', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
        inspectLabel({ label: erRel[4] ?? erRel[3], kind: 'node', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
        if (erRel[5]) inspectLabel({ label: erRel[5], kind: 'edge', maxWidth: MERMAID_LIMITS.edgeMaxWidth, lineNo })
        continue
      }
      const erAlias = /^\s*[A-Za-z0-9_.-]+\s*\[\s*"?([^"\]\n]+)"?\s*\]\s*$/.exec(line)
      if (erAlias) {
        inspectLabel({ label: erAlias[1], kind: 'node', maxWidth: MERMAID_LIMITS.rectMaxWidth, lineNo })
      }
      continue
    }

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

const CUSTOM_TEMPLATE_REL_CANDIDATES = CUSTOM_DECL_REL

function extractCustomDocSections(rawTemplate, standardContent, { title, safeSlug, taskId }) {
  const cleanRaw = String(rawTemplate ?? '').replace(/^---\n[\s\S]*?\n---\n*/m, '')
  const existingH2 = new Set(
    [...String(standardContent ?? '').matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim().toLowerCase()),
  )
  const parts = cleanRaw.split(/\n(?=##\s+)/)
  const extraSections = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed.startsWith('## ')) continue
    const heading = trimmed.split('\n')[0].replace(/^##\s+/, '').trim()
    if (!heading || existingH2.has(heading.toLowerCase())) continue
    const hydrated = trimmed
      .replace(/\{\{TITLE\}\}/g, String(title ?? ''))
      .replace(/\{\{SLUG\}\}/g, String(safeSlug ?? ''))
      .replace(/\{\{TASK_ID\}\}/g, String(taskId ?? safeSlug ?? 'task'))
      .replace(/<!--\s*project-forge:\s*fill[\s\S]*?-->/gi, '')
    extraSections.push(hydrated)
  }
  return extraSections
}

/**
 * 探测并识别仓库自带的项目自定义文档模板（docs/templates/*、docs/.templates/*、.github/*-template.md）。
 * 严禁读取工具母版目录或绑定宿主专有目录。
 */
/** 探测并识别仓库自带的项目自定义文档模板，把未收录于主模板的自定义章节附到渲染末尾。 */
export function appendCustomDocSections(rendered, { repoRoot, kind, title = '', safeSlug = '', taskId = '' } = {}) {
  const customTpl = resolveRepoCustomDocTemplate(repoRoot, kind)
  if (!customTpl) return rendered
  const extra = extractCustomDocSections(customTpl.text, rendered, { title, safeSlug, taskId })
  const marker = `<!-- project-custom-template: ${customTpl.rel} -->`
  return extra.length > 0
    ? `${String(rendered).trimEnd()}\n\n${marker}\n\n${extra.join('\n\n')}\n`
    : `${String(rendered).trimEnd()}\n\n${marker}\n`
}

export function resolveRepoCustomDocTemplate(repoRoot, kind) {
  if (!repoRoot || !CUSTOM_TEMPLATE_REL_CANDIDATES[kind]) return null
  for (const rel of CUSTOM_TEMPLATE_REL_CANDIDATES[kind]) {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) continue
    const text = readTextSafe(abs)
    if (text !== undefined && text.trim()) return { rel, text }
  }
  return null
}

/**
 * 统一工程文档模板生成器（YAML Frontmatter + 顶部可见元信息概览表 + SPEC 短名 Mermaid 图）。
 */
export function buildStandardDocContent({
  kind,
  repoRoot = null,
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
  pruneUnfilled = true,
  noPrune = false,
  docShape = null,
  planMode = null,
  multiSpec = false,
  caseType = null,
  serializeFm,
  keyOrders,
}) {
  const effectiveCriteria = Array.isArray(criteria) && criteria.length > 0 ? criteria : null
  const customTpl = resolveRepoCustomDocTemplate(repoRoot, kind)
  const applyCustomTemplate = (rendered) => {
    if (!customTpl) return rendered
    const extra = extractCustomDocSections(customTpl.text, rendered, { title, safeSlug, taskId })
    const marker = `<!-- project-custom-template: ${customTpl.rel} -->`
    return extra.length > 0
      ? `${rendered.trimEnd()}\n\n${marker}\n\n${extra.join('\n\n')}\n`
      : `${rendered.trimEnd()}\n\n${marker}\n`
  }

  const useShapePolicy = Boolean(repoRoot && (!pruneUnfilled || noPrune))
  const shapePolicy = useShapePolicy
    ? resolveDocShapePolicy(repoRoot, kind, { noPrune, docShape })
    : { dropSections: resolveDocRequirements(repoRoot, kind).omit, skipped: [] }
  const effectiveDrop = shapePolicy.dropSections
  const effectivePrune = Boolean(pruneUnfilled && !noPrune)
  const injectShapeNote = (rendered) => {
    const block = (useShapePolicy && !noPrune && !effectivePrune && shapePolicy.skipped.length > 0)
      ? formatDocShapeSkippedBlock(shapePolicy.skipped)
      : ''
    return block ? rendered.replace(/^(# [^\n]+\n)/m, `$1\n${block}\n`) : rendered
  }

  if (kind === 'prd') {
    const fm = serializeFm({
      kind: 'prd', title, status: 'draft', created: today, updated: today,
      issue: issueNum, pr: null, owner: owner ?? null, plan_mode: resolveDocPlanMode({ kind: 'prd', explicit: planMode }),
      ...(multiSpec ? { multi_spec: true } : {}),
      ...(Number.isInteger(caseType) ? { case_type: caseType } : {}),
      plan_critique: 'pending',
      related_spec: relatedSpecRel ?? null, related_todo: relatedTodoRel ?? null,
    }, keyOrders.prd)
    const body = renderDocTemplate('prd', {
      dropSections: effectiveDrop,
      pruneUnfilled: effectivePrune,
      vars: {
        TITLE: title,
        TODAY: today,
        ISSUE: issueNum ?? 'null',
        ISSUE_LABEL: issueNum ? `#${issueNum}` : '未关联',
        OWNER: owner ?? '待认领',
        OWNER_LABEL: owner ?? '待认领',
        NON_GOALS: Array.isArray(nonGoals) && nonGoals.length > 0
          ? nonGoals.map((g) => `- ${g}`).join('\n')
          : '- <明确排除的扩展设想，防止需求蔓延>',
        REUSABLE: Array.isArray(reusableModules) && reusableModules.length > 0
          ? reusableModules.map((m) => `- ${m}`).join('\n')
          : '- <需核实填写：拟复用的现成模块文件路径与导出能力>',
        CRITERIA: effectiveCriteria
          ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`).join('\n')
          : '- [ ] C1: <第一条可判定的产品结果>\n- [ ] C2: <第二条>',
        DOOR: doorType ?? '<two-way | one-way>',
        ROLLBACK: rollbackPath ?? '<说明如何安全撤回，不可逆改动须写明降级方案>',
      },
    })
    return applyCustomTemplate(injectShapeNote([fm.trimEnd(), '', body.trimEnd(), ''].join('\n')))
  }

  if (kind === 'spec') {
    const fm = serializeFm({
      kind: 'spec', title, status: 'draft', tier: 'L3', created: today, updated: today,
      issue: issueNum, pr: null, branch: headBranch, owner: owner ?? null,
      plan_mode: resolveDocPlanMode({ kind: 'spec', tier: 'L3', explicit: planMode }),
      approved: false, implemented: false, plan_critique: 'pending',
      related_prd: relatedPrdRel ?? null, related_todo: relatedTodoRel ?? null, high_risk_paths: [],
    }, keyOrders.spec)
    const reuseList = Array.isArray(reusableModules) && reusableModules.length > 0
      ? reusableModules.join('；')
      : '<先经 `dev-explore` 核实的可复用现有函数、协议或脚本入口；禁止另起炉灶>'
    const nonGoalText = Array.isArray(nonGoals) && nonGoals.length > 0
      ? nonGoals.join('；')
      : '<明确本期保持不动或故意延后的范围>'
    const authoritativeTdd = repoRoot ? resolveAuthoritativeTddPath(repoRoot) : null
    const tddRefText = authoritativeTdd
      ? `\`${authoritativeTdd}\``
      : '项目架构基线（当前仓库暂无独立 TDD 文件，新建时须标注 (new)）'
    const body = renderDocTemplate('spec', {
      dropSections: effectiveDrop,
      pruneUnfilled: effectivePrune,
      vars: {
        TITLE: title,
        TODAY: today,
        ISSUE: issueNum ?? 'null',
        ISSUE_LABEL: issueNum ? `#${issueNum}` : '未关联',
        BRANCH: headBranch ?? 'null',
        OWNER: owner ?? '待认领',
        OWNER_LABEL: owner ?? '待认领',
        TIER: 'L3',
        MODULES: '| `<真实文件路径，新建文件标 (new)>` | 改造 / 新增 | <受影响的模块、协议或对外契约> |',
        CONTRACT_CHANGES: '- <新增或调整的接口、参数、文件结构、退出码或状态流转>',
        SAFETY_BOUNDARIES: '- <失败时如何降级或阻断、权限校验、并发/状态持久化保护>',
        CRITERIA: effectiveCriteria
          ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`).join('\n')
          : '- [ ] C1: <第一条可判定的标准>\n- [ ] C2: <第二条>',
        NON_GOALS: nonGoalText,
        REUSABLE: reuseList,
        DOOR: doorType ?? '<two-way | one-way>',
        ROLLBACK: rollbackPath ?? '<说明回退命令或反向修补方式>',
        HIGH_RISK: '<是否涉及核心契约、安全校验、迁移脚本等>',
        FAULT_INJECTION: '<需核实填写：复用项目中已有的工具/协议/脚本路径，不重复造轮子>',
        TDD_REF: tddRefText,
      },
    })
    return applyCustomTemplate(injectShapeNote([fm.trimEnd(), '', body.trimEnd(), ''].join('\n')))
  }

  const fm = serializeFm({
    kind: 'todo', title, status: 'active', created: today, updated: today,
    issue: issueNum, pr: null, branch: headBranch, owner: owner ?? null,
    plan_mode: resolveDocPlanMode({ kind: 'todo', explicit: planMode }),
    approved: false, done_at: null, task_id: taskId ?? safeSlug ?? 'task',
    planned_at: headSha, related_prd: relatedPrdRel ?? null, related_spec: relatedSpecRel ?? null,
  }, keyOrders.todo)
  const scopeText = Array.isArray(scopePaths) && scopePaths.length > 0
    ? scopePaths.map((p2) => `\`${p2}\``).join('、')
    : '`<需核实真实路径，新建文件标 (new)>`'
  const body = renderDocTemplate('todo', {
    dropSections: effectiveDrop,
    pruneUnfilled: effectivePrune,
    vars: {
      TITLE: title,
      TODAY: today,
      ISSUE: issueNum ?? 'null',
      ISSUE_LABEL: issueNum ? `#${issueNum}` : '未关联',
      BRANCH: headBranch ?? 'null',
      OWNER: owner ?? '待认领',
      OWNER_LABEL: owner ?? '待认领',
      TASK_ID: taskId ?? safeSlug ?? 'task',
      HEAD_SHA: String(headSha ?? 'uncommitted'),
      HEAD_SHA_SHORT: String(headSha ?? 'uncommitted').slice(0, 7),
      SCOPE_PATHS: scopeText,
      REUSABLE: Array.isArray(reusableModules) && reusableModules.length > 0
        ? reusableModules.join('；')
        : '<需核实填写：准备复用的现成函数、库或脚本>',
      NON_GOALS: Array.isArray(nonGoals) && nonGoals.length > 0
        ? nonGoals.join('；')
        : '<明确排除本次不顺手重构的无关事项>',
      DOOR: doorType ?? 'two-way',
      ROLLBACK: rollbackPath ?? '局部可逆改动，直接 git revert 或删除临时分支即可回退。',
      QUICK_CMD: quickCmd,
      CRITERIA: effectiveCriteria
        ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`).join('\n')
        : '- [ ] C1: <第一条可判定的标准>\n- [ ] C2: <第二条>',
    },
  })
  return applyCustomTemplate(injectShapeNote([fm.trimEnd(), '', body.trimEnd(), ''].join('\n')))
}

// ── 联动同步解析（AGENTS.md ## 改哪看哪）───────────────────────────────

const COUPLED_ROOT_FILENAMES = new Set([
  'AGENTS.md', 'SKILL.md', 'README', 'README.md', 'README.en.md', 'README.zh-CN.md',
  'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md', 'SECURITY.md', 'SECURITY.zh-CN.md',
  'RELEASING.md', 'CHANGELOG.md',
  'Makefile', 'justfile', '.gitattributes', '.gitignore',
])

const PUBLIC_BILINGUAL_FAMILY_RE = /^(readme|contributing|security|releasing|changelog)(?:\.[A-Za-z0-9_-]+)?\.md$/i

export function listLocalizedPublicSiblings(repoRoot, relFile) {
  if (!repoRoot || !existsSync(repoRoot)) return []
  const m = PUBLIC_BILINGUAL_FAMILY_RE.exec(String(relFile ?? '').trim())
  if (!m) return []
  const prefix = m[1].toLowerCase()
  try {
    return readdirSync(repoRoot)
      .filter((name) => name !== relFile && new RegExp(`^${prefix}(?:\\.[A-Za-z0-9_-]+)?\\.md$`, 'i').test(name))
      .sort()
  } catch {
    return []
  }
}

function isPathLikeToken(rawToken) {
  const s = posixPath(String(rawToken ?? '').trim()).replace(/^\.\//, '')
  if (!s || /\s/.test(s) || /^https?:|^file:|^mailto:/i.test(s)) return false
  if (/[*?<>{};|$]/.test(s)) return false
  if (s.includes('/')) return true
  if (COUPLED_ROOT_FILENAMES.has(s)) return true
  return /^[A-Za-z0-9_.-]+\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(s)
}

function extractCoupledPathTokens(cellText) {
  const tokens = []
  const seen = new Set()
  for (const m of String(cellText ?? '').matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim()
    if (!isPathLikeToken(raw)) continue
    const norm = posixPath(raw).replace(/^\.\//, '')
    if (!seen.has(norm)) { seen.add(norm); tokens.push(norm) }
  }
  return tokens
}

function splitMarkdownTableRow(rawLine) {
  const trimmed = rawLine.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  const inner = trimmed.slice(1, -1)
  const cells = []
  let cur = ''
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch === '\\' && inner[i + 1] === '|') { cur += '|'; i += 1 }
    else if (ch === '|') { cells.push(cur.trim()); cur = '' }
    else cur += ch
  }
  cells.push(cur.trim())
  return cells
}

/** 从 AGENTS.md「## 改哪看哪」章节表格解析文件联动触发与伴随同步规则。 */
export function parseCoupledSyncRules(agentsText) {
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  let inSection = false
  let inFence = false
  const tableRows = []
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^##\s+改哪看哪(?:\s|$)/.test(line.trim())) { inSection = true; continue }
    if (inSection && (/^##\s+/.test(line.trim()) || /^<!--\s*project-forge:\s*end\b/.test(line.trim()))) break
    if (!inSection) continue
    const cells = splitMarkdownTableRow(line)
    if (cells && cells.length >= 2) tableRows.push({ rawRow: line.trim(), cells })
  }

  const rules = []
  for (let i = 0; i < tableRows.length; i += 1) {
    const { rawRow, cells } = tableRows[i]
    if (cells.every((c) => /^:?-+:?$/.test(c.trim()))) continue
    const nextRow = tableRows[i + 1]
    if (nextRow && nextRow.cells.every((c) => /^:?-+:?$/.test(c.trim()))) continue
    const triggers = extractCoupledPathTokens(cells[0])
    const companions = extractCoupledPathTokens(cells[1])
    if (triggers.length === 0 || companions.length === 0) continue
    rules.push({ triggers, companions, rawRow })
  }
  return rules
}

function matchesCoupledPath(filePath, ruleToken, repoRoot) {
  const normTok = posixPath(ruleToken).replace(/^\.\//, '')
  if (!normTok) return false
  if (normTok.endsWith('/')) return filePath.startsWith(normTok) || filePath === normTok.slice(0, -1)
  if (filePath === normTok) return true
  if (repoRoot) {
    try {
      const abs = join(repoRoot, normTok)
      if (existsSync(abs) && readdirSync(abs)) return filePath.startsWith(`${normTok}/`)
    } catch { /* not a dir */ }
  }
  return false
}

/** 对照「改哪看哪」规则校验变更文件清单，过滤目标仓不存在的可选伴随文件。 */
export function evaluateCoupledSync(changedFiles, rules, repoRoot) {
  const normalizedChanged = [...new Set(
    (Array.isArray(changedFiles) ? changedFiles : []).map((f) => posixPath(f).replace(/^\.\//, '').trim()).filter(Boolean),
  )]
  if (normalizedChanged.length === 0 || !Array.isArray(rules) || rules.length === 0) return []
  const warnings = []
  for (const rule of rules) {
    const touchedTriggers = (rule.triggers ?? []).filter((t) => normalizedChanged.some((f) => matchesCoupledPath(f, t, repoRoot)))
    if (touchedTriggers.length === 0) continue
    const triggerSet = new Set(rule.triggers ?? [])
    const expandedCompanions = []
    for (const c of rule.companions ?? []) {
      expandedCompanions.push(c)
      for (const sib of listLocalizedPublicSiblings(repoRoot, c)) {
        if (!triggerSet.has(sib) && !expandedCompanions.includes(sib)) expandedCompanions.push(sib)
      }
    }
    const existingCompanions = expandedCompanions.filter((c) => {
      if (!repoRoot) return true
      const clean = posixPath(c).replace(/^\.\//, '').replace(/\/+$/, '')
      return Boolean(clean) && existsSync(join(repoRoot, clean))
    })
    if (existingCompanions.length === 0) continue
    const companionSynced = existingCompanions.some((c) => normalizedChanged.some((f) => matchesCoupledPath(f, c, repoRoot)))
    if (!companionSynced) warnings.push({ triggers: rule.triggers, touchedTriggers, expectedCompanions: existingCompanions, rawRow: rule.rawRow })
  }
  return warnings
}

/** 构造归档文档的 Frontmatter 补丁；归档 1:N 总控 PRD 时仅更新日期与终态并完整保留原有元信息。 */
export function buildArchivedDocPatch({
  kind, fmData = {}, today, issue, pr, branch, owner,
  preserveMasterMeta = false, relatedTargets = {},
} = {}) {
  const patch = { updated: today }
  if (kind && !fmData.kind) patch.kind = kind
  if (preserveMasterMeta) {
    if (kind === 'prd') patch.status = 'done'
    return patch
  }
  if (issue !== undefined && issue !== null) patch.issue = Number(issue)
  if (pr !== undefined && pr !== null) patch.pr = Number(pr)
  if (branch) patch.branch = branch
  if (owner) patch.owner = owner
  if (kind === 'prd') patch.status = 'done'
  if (kind === 'spec') { patch.status = 'implemented'; patch.implemented = true }
  if (kind === 'todo') {
    const curSt = String(fmData?.status ?? '').toLowerCase()
    patch.status = curSt === 'archived' ? 'archived' : 'done'
    patch.done_at = fmData?.done_at ?? today
  }
  for (const [rk, relVal] of Object.entries(relatedTargets)) {
    if (relVal) patch[rk] = relVal
  }
  return patch
}

// ── PR / Issue 协同评论统一结构化渲染（已拆分至 doc-comments.mjs） ───────
export { buildIssueCloseComment, buildMergeComments, buildReviewComments, buildSubmitComments, formatAttribution } from './doc-comments.mjs'
