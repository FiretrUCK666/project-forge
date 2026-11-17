/**
 * doc-templates.mjs —— 统一工程文档模板生成器、联动同步解析与 Mermaid 标签宽度静态门禁。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 docs.mjs 汇总导出。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { posixPath, readTextSafe } from './git.mjs'
import { resolveDocRequirements } from './doc-requirements.mjs'
import { renderDocTemplate } from './doc-template-render.mjs'

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

const CUSTOM_TEMPLATE_REL_CANDIDATES = Object.freeze({
  prd: ['docs/templates/prd.md', 'docs/templates/prd-template.md', 'docs/.templates/prd.md', '.github/prd-template.md', '.github/prd_template.md'],
  spec: ['docs/templates/spec.md', 'docs/templates/spec-template.md', 'docs/.templates/spec.md', '.github/spec-template.md', '.github/spec_template.md'],
  todo: ['docs/templates/todo.md', 'docs/templates/todo-template.md', 'docs/.templates/todo.md', '.github/todo-template.md', '.github/todo_template.md'],
})

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

  if (kind === 'prd') {
    const fm = serializeFm({
      kind: 'prd', title, status: 'draft', created: today, updated: today,
      issue: issueNum, pr: null, owner: owner ?? null, plan_critique: 'pending',
      related_spec: relatedSpecRel ?? null, related_todo: relatedTodoRel ?? null,
    }, keyOrders.prd)
    const body = renderDocTemplate('prd', {
      dropSections: resolveDocRequirements(repoRoot, 'prd').omit,
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
          : '- <待核实填写：拟复用的现成模块文件路径与导出能力>',
        CRITERIA: effectiveCriteria
          ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`).join('\n')
          : '- [ ] C1: <第一条可判定的产品结果>\n- [ ] C2: <第二条>',
        DOOR: doorType ?? '<two-way | one-way>',
        ROLLBACK: rollbackPath ?? '<说明如何安全撤回，不可逆改动须写明降级方案>',
      },
    })
    return applyCustomTemplate([fm.trimEnd(), '', body.trimEnd(), ''].join('\n'))
  }

  if (kind === 'spec') {
    const fm = serializeFm({
      kind: 'spec', title, status: 'draft', tier: 'L3', created: today, updated: today,
      issue: issueNum, pr: null, branch: headBranch, owner: owner ?? null,
      approved: false, implemented: false, plan_critique: 'pending',
      related_prd: relatedPrdRel ?? null, related_todo: relatedTodoRel ?? null, high_risk_paths: [],
    }, keyOrders.spec)
    const reuseList = Array.isArray(reusableModules) && reusableModules.length > 0
      ? reusableModules.join('；')
      : '<先经 `dev-explore` 核实的可复用现有函数、协议或脚本入口；禁止另起炉灶>'
    const nonGoalText = Array.isArray(nonGoals) && nonGoals.length > 0
      ? nonGoals.join('；')
      : '<明确本期保持不动或故意延后的范围>'
    const body = renderDocTemplate('spec', {
      dropSections: resolveDocRequirements(repoRoot, 'spec').omit,
      vars: {
        TITLE: title,
        TODAY: today,
        ISSUE: issueNum ?? 'null',
        ISSUE_LABEL: issueNum ? `#${issueNum}` : '未关联',
        BRANCH: headBranch ?? 'null',
        OWNER: owner ?? '待认领',
        OWNER_LABEL: owner ?? '待认领',
        TIER: 'L3',
        MODULES: '- <真实文件路径，新建文件标 (new)> | 改造 / 新增 | <受影响的模块、协议或对外契约>',
        CONTRACT_CHANGES: '- <新增或调整的接口、参数、文件结构、退出码或状态流转>',
        SAFETY_BOUNDARIES: '- <失败时如何降级或阻断、权限校验、并发/状态持久化保护>',
        CRITERIA: effectiveCriteria
          ? effectiveCriteria.map((c, idx) => `- [ ] C${idx + 1}: ${c}`).join('\n')
          : '- [ ] C1: <第一条可判定的标准>\n- [ ] C2: <第二条>',
        DOOR: doorType ?? '<two-way | one-way>',
        ROLLBACK: rollbackPath ?? '<说明回退命令或反向修补方式>',
        HIGH_RISK: '<是否涉及核心契约、安全校验、迁移脚本等>',
        FAULT_INJECTION: '<待核实填写：复用项目中已有的工具/协议/脚本路径，不重复造轮子>',
      },
    })
    return applyCustomTemplate([fm.trimEnd(), '', body.trimEnd(), ''].join('\n'))
  }

  const fm = serializeFm({
    kind: 'todo', title, status: 'active', created: today, updated: today,
    issue: issueNum, pr: null, branch: headBranch, owner: owner ?? null,
    approved: false, done_at: null, task_id: taskId ?? safeSlug ?? 'task',
    planned_at: headSha, related_prd: relatedPrdRel ?? null, related_spec: relatedSpecRel ?? null,
  }, keyOrders.todo)
  const scopeText = Array.isArray(scopePaths) && scopePaths.length > 0
    ? scopePaths.map((p2) => `\`${p2}\``).join('、')
    : '\`<待核实真实路径，新建文件标 (new)>\`'
  const body = renderDocTemplate('todo', {
    dropSections: resolveDocRequirements(repoRoot, 'todo').omit,
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
        : '<待核实填写：准备复用的现成函数、库或脚本>',
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
  return applyCustomTemplate([fm.trimEnd(), '', body.trimEnd(), ''].join('\n'))
}

// ── 联动同步解析（AGENTS.md ## 改哪看哪）───────────────────────────────

const COUPLED_ROOT_FILENAMES = new Set([
  'AGENTS.md', 'SKILL.md', 'README.md', 'README.en.md',
  'CONTRIBUTING.md', 'RELEASING.md', 'CHANGELOG.md',
  'Makefile', 'justfile', '.gitattributes', '.gitignore',
])

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
    const existingCompanions = (rule.companions ?? []).filter((c) => {
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

// ── PR / Issue 协同评论统一结构化渲染（供 dev-review / dev-flow 共用） ─────

function cleanMdCell(s) {
  return String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function formatBlockerLoc(m) {
  if (!m?.file) return '全局/门禁项'
  return m.line ? `${m.file}:${m.line}${m.endLine && m.endLine > m.line ? `-${m.endLine}` : ''}` : m.file
}

function blockerMatchesCriterion(m, criterionId) {
  const cid = String(criterionId ?? '').toUpperCase()
  if (!cid) return false
  if (m?.criterion && String(m.criterion).toUpperCase() === cid) return true
  for (const cm of String(m?.summary ?? '').matchAll(/\b(C\d+)\b/gi)) {
    if (cm[1].toUpperCase() === cid) return true
  }
  return false
}

/** 渲染结构化 PR 全量审查单与 Issue 摘要单（支持逐条标准对照表、Must/Should/Pre-existing 分区与离线载荷）。 */
export function buildReviewComments({
  round, verdict, baseSha, headSha, sourceLine, criteria = [], criteriaStatusText,
  faultInjectionText, stopLoss = false, stopReasons = [], mustFixList = [],
  shouldFixList = [], preExistingList = [], rebuttedItems = [], resolvedItems = [],
  prNum = null, labelName = '', staleLabel = '', role = null, nextSteps = [], statePayload = {},
} = {}) {
  const shortBase = baseSha ? String(baseSha).slice(0, 7) : ''
  const shortHead = String(headSha ?? '').slice(0, 7) || 'HEAD'
  const baselineText = shortBase && shortBase !== shortHead ? `${shortBase}..${shortHead}` : shortHead
  const statusTagText = verdict === 'pass' ? 'PASS' : 'CHANGES_REQUESTED'
  const cnVerdict = verdict === 'pass' ? '审核通过' : '审核不通过（退回）'
  const stopLossText = stopLoss ? `已触发（${stopReasons.join('；')}）` : '未触发'
  const stateTag = Object.keys(statePayload).length > 0 ? `<!-- pf-state:${JSON.stringify(statePayload)} -->` : ''

  const prLines = [
    `### ${cnVerdict} · Round ${round}（${statusTagText} @ \`${baselineText}\`）`,
    '',
    `- **审查来源**：${sourceLine}`,
    `- **逐条标准状态**：${criteriaStatusText}`,
    `- **故障注入记录**：${faultInjectionText}`,
    `- **止损记录**：${stopLossText}`,
    `- **对比基线**：\`${baselineText}\``,
  ]

  if (Array.isArray(criteria) && criteria.length > 0) {
    prLines.push('', '#### 验收标准逐条核对', '', '| 标准 | 状态 | 核对内容与阻塞定位 |', '| --- | --- | --- |')
    for (const c of criteria) {
      const hits = verdict === 'changes' ? mustFixList.filter((m) => blockerMatchesCriterion(m, c.id)) : []
      const stLabel = hits.length > 0 ? 'FAIL' : 'PASS'
      const note = hits.length > 0
        ? hits.map((h) => `[${h.id}] \`${formatBlockerLoc(h)}\`: ${cleanMdCell(h.summary)}`).join('；')
        : `${cleanMdCell(c.text)}${c.checked ? '' : '（待确认勾选）'}`
      prLines.push(`| ${cleanMdCell(c.id)} | ${stLabel} | ${note} |`)
    }
  }

  if (mustFixList.length > 0) {
    prLines.push('', '#### Must Fix（阻塞合入）', '')
    mustFixList.forEach((m, idx) => {
      const crit = m.criterion ? ` · 标准: ${m.criterion}` : ''
      prLines.push(`${idx + 1}. **[${m.id}] \`${formatBlockerLoc(m)}\`**（fp: \`${m.fingerprint}\`${crit}）`)
      prLines.push(`   - **问题与实证**：${m.summary}`)
      if (m.rootCause) prLines.push(`   - **根因**：${m.rootCause}`)
      if (m.fixHint) prLines.push(`   - **建议修法**：${m.fixHint}`)
    })
  }
  if (resolvedItems.length > 0 || rebuttedItems.length > 0) {
    const parts = [
      resolvedItems.length > 0 ? `已解决：${resolvedItems.join(', ')}` : null,
      rebuttedItems.length > 0 ? `已接受反驳：${rebuttedItems.join(', ')}` : null,
    ].filter(Boolean)
    prLines.push('', `- **本轮消解**：${parts.join('；')}`)
  }
  if (shouldFixList.length > 0) {
    prLines.push('', '#### Should Fix（非阻塞建议）', '', ...shouldFixList.map((s, idx) => `${idx + 1}. ${s}`))
  }
  if (preExistingList.length > 0) {
    prLines.push('', '#### Pre-existing（存量观察）', '', ...preExistingList.map((p, idx) => `${idx + 1}. ${p}`))
  }

  const nextNote = stopLoss
    ? '已触发停损熔断，请人类维护者复核后运行 `review-pack.mjs override --human-approved --reason "..."`。'
    : (nextSteps.length > 0 ? nextSteps.join('；') : (verdict === 'pass'
      ? (role === 'contributor-fork' ? '等待上游维护者合并 PR。' : '由当前独立审查上下文执行 `flow.mjs merge` 收尾。')
      : `请在原分支逐项修复后执行 \`flow.mjs rework\` -> \`verify\` -> \`submit --rework\` 推进 Round ${round + 1}。`))
  prLines.push('', `> **下一步**：${nextNote}`)

  const labelNote = labelName ? `（标签：\`${labelName}\`${staleLabel ? `，移除 \`${staleLabel}\`` : ''}）` : ''
  const issueLines = [
    `### ${cnVerdict} · Round ${round} @ \`${shortHead}\`${prNum ? `（PR #${prNum}）` : ''}`,
    '',
    `- **审查来源**：${sourceLine}`,
    `- **逐条状态与标签**：${criteriaStatusText}${labelNote}`,
    `- **故障注入摘要**：${faultInjectionText}`,
    `- **止损摘要**：${stopLossText}`,
  ]
  if (mustFixList.length > 0) {
    issueLines.push('', `#### Must Fix 阻塞项（${mustFixList.length} 项）`, '')
    mustFixList.forEach((m, idx) => {
      const rc = m.rootCause ? ` — 根因：${m.rootCause}` : ''
      issueLines.push(`${idx + 1}. **[${m.id}] \`${formatBlockerLoc(m)}\`**（fp: \`${m.fingerprint}\`）：${m.summary}${rc}`)
    })
  }
  if (shouldFixList.length > 0 || preExistingList.length > 0) {
    if (prNum) {
      issueLines.push('', `- **附注**：Should Fix ${shouldFixList.length} 项、Pre-existing ${preExistingList.length} 项（详细对照与列表见 PR #${prNum}）。`)
    } else {
      if (shouldFixList.length > 0) issueLines.push('', '#### Should Fix', '', ...shouldFixList.map((s, idx) => `${idx + 1}. ${s}`))
      if (preExistingList.length > 0) issueLines.push('', '#### Pre-existing', '', ...preExistingList.map((p, idx) => `${idx + 1}. ${p}`))
    }
  }
  const issueNext = stopLoss
    ? '触发停损熔断，等待人类维护者裁决。'
    : (verdict === 'pass' ? `审查已通过${prNum ? `，等待 PR #${prNum} 合并收尾` : ''}。` : `请在原分支按上述编号修复并重新提审（Round ${round + 1}）。`)
  issueLines.push('', `> **下一步**：${issueNext}`)

  return { prCommentBody: prLines.join('\n'), issueCommentBody: issueLines.join('\n'), stateTag }
}

/** 渲染 `flow.mjs submit`（首次提审 / PR 创建同步 Issue / 返工更新）结构化多行评论。 */
export function buildSubmitComments({
  isRework = false, round = 1, shortHead = 'HEAD', actorDisplay, branch,
  verifiedCmd, prNumber = null, prUrl = null, linkedIssues = [], recentRebuts = '',
} = {}) {
  const issuesText = linkedIssues.map((n) => `#${n}`).join(', ')
  if (isRework && prNumber) {
    const prCommentBody = [
      `### 返工已提交（Round ${round} @ \`${shortHead}\`）`,
      '',
      `- **提交人**：${actorDisplay}`,
      `- **分支**：\`${branch}\`（HEAD \`${shortHead}\` · PR #${prNumber}）`,
      `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
      ...(recentRebuts ? [`- **反驳与说明**：${recentRebuts}`] : []),
      ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
      `- **下一步**：请新建独立审查上下文复核 Round ${round}（更新同一 PR）。`,
    ].join('\n')
    const issueCommentBodyFor = () => [
      `### 返工已提交（Round ${round} @ \`${shortHead}\`）`,
      '',
      `- **提交人**：${actorDisplay}`,
      `- **分支 / PR**：\`${branch}\` · PR #${prNumber}`,
      `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
      ...(recentRebuts ? [`- **反驳与说明**：${recentRebuts}`] : []),
      `- **下一步**：等待 Round ${round} 独立审查复核。`,
    ].join('\n')
    return { prCommentBody, issueCommentBodyFor }
  }
  const prCommentBody = [
    `### 提交待审（Round 1 @ \`${shortHead}\`）`,
    '',
    `- **提交人**：${actorDisplay}`,
    `- **分支**：\`${branch}\`（HEAD \`${shortHead}\` · PR #${prNumber}）`,
    `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
    ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
    '- **下一步**：请独立审查上下文执行双门核验与故障注入复核。',
  ].join('\n')
  const issueCommentBodyFor = (iss) => [
    `### 提交待审 · 已提 PR #${prNumber}（@ \`${shortHead}\`）`,
    '',
    `- **提交人**：${actorDisplay}`,
    `- **分支 / PR**：\`${branch}\` · #${prNumber}${prUrl ? ` (${prUrl})` : ''}`,
    `- **验证命令**：\`${verifiedCmd}\`（退出码 0）`,
    `- **关联**：Fixes #${iss}`,
    '- **下一步**：等待 Round 1 独立审查复核。',
  ].join('\n')
  return { prCommentBody, issueCommentBodyFor }
}

/** 渲染 `flow.mjs merge` 成功后的 PR 与关联 Issue 结构化收尾评论。 */
export function buildMergeComments({
  prNumber, branch, baseBranch, headSha = '', reviewerId, implementerDisplay, linkedIssues = [], humanApprovedReason = null,
} = {}) {
  const shortHead = headSha ? String(headSha).slice(0, 7) : ''
  const issuesText = linkedIssues.map((n) => `#${n}`).join(', ')
  const reviewLine = reviewerId
    ? `- **审查结论**：由独立审查（\`${reviewerId}\`）复核通过（fail: 无）`
    : `- **门禁结论**：lightweight 档门禁检查通过${humanApprovedReason ? `，人类确认放行（${humanApprovedReason}）` : ''}`
  const issueReviewLine = reviewerId
    ? `- **审查结论**：经独立审查（\`${reviewerId}\`）复核通过并合并（fail: 无）`
    : `- **门禁结论**：lightweight 档门禁检查通过并合并${humanApprovedReason ? `（人类确认：${humanApprovedReason}）` : ''}`
  const prCommentBody = [
    `### 已合并（PR #${prNumber} -> \`${baseBranch}\`）`,
    '',
    reviewLine,
    `- **来源分支 / 实施人**：\`${branch}\`${shortHead ? ` @ \`${shortHead}\`` : ''} · ${implementerDisplay}`,
    ...(issuesText ? [`- **关联 Issue**：${issuesText}`] : []),
    '- **下一步**：核对待清理 Worktree 与分支清单后由维护者确认执行 `flow.mjs cleanup --confirm`。',
  ].join('\n')
  const issueCommentBody = [
    `### 已合并 · PR #${prNumber}（\`${branch}\` -> \`${baseBranch}\`）`,
    '',
    issueReviewLine,
    `- **实施人**：${implementerDisplay}`,
    '- **下一步**：主干已更新，按收尾清单清理工作区。',
  ].join('\n')
  return { prCommentBody, issueCommentBody }
}
