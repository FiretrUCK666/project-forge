#!/usr/bin/env node
/**
 * doc-plan.mjs —— 五档需求分流、四层工程文档生成、规划自审净化、Critique 记账与 SPEC 批准。
 *
 * 子命令：
 *   triage         --summary <text> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]
 *   init           --kind prd|spec|todo|pair|all --slug <slug> --title <title> [--issue <N>] [--task <id>] [--spec <path>] [--force] [--json]
 *   link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <name>] [--owner <name>] [--status <s>] [--approve] [--json]
 *   audit          [--file <docPath> | .] [--json]
 *   critique-pass  --file <docPath> --reviewer <id> [--round 1|2] [--summary <text>] [--json]
 *   approve        --file <specPath> [--skip-critique-reason <text>] [--json]
 *   list           [--json]
 */

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  buildDocFilename, classifyDoorType, createDefaultLedger, DOC_FRONTMATTER_KEY_ORDER,
  ensureWorktreesIgnored, evaluateCoupledSync, gitRun, isMainModule,
  parseAgentsProfile, parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter,
  posixPath, printNextStep, readTaskLedger, readTextSafe, resolveRepoRoots,
  sanitizeTaskId, serializeDocFrontmatter, sha256Text, slugify, syncDocsLifecycle,
  updateDocFrontmatter, writeAtomic, writeTaskLedger,
} from '../../lib/shared.mjs'

function yymmdd(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

function isoDate(date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function scanActiveContracts(root) {
  const contracts = { tdd: existsSync(join(root, 'docs', 'TDD.md')), activeSpecs: [] }
  const specsDir = join(root, 'docs', 'specs')
  if (!existsSync(specsDir)) return contracts
  try {
    for (const name of readdirSync(specsDir).filter((n) => n.endsWith('.md')).sort()) {
      const text = readTextSafe(join(specsDir, name)) ?? ''
      const fm = parseDocFrontmatter(text)
      const status = String(fm.data?.status ?? 'unknown').toLowerCase()
      if (status === 'approved' || status === 'implementing' || status === 'implemented') {
        contracts.activeSpecs.push({ file: `docs/specs/${name}`, status })
      }
    }
  } catch { /* 忽略不可读目录 */ }
  return contracts
}

function computeCoupledSyncWarnings(repoRoot, paths) {
  if (!repoRoot || !Array.isArray(paths) || paths.length === 0) return []
  const agentsText = readTextSafe(join(repoRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  if (rules.length === 0) return []
  return evaluateCoupledSync(paths, rules, repoRoot)
}

/** 严格五档分流判定逻辑，同步输出 doorType、critiqueTier 与改哪看哪联动提醒。 */
export function triageTask({
  summary = '',
  files,
  touchesContract = false,
  conflictsTdd = false,
  docOnly = false,
  bugfix = false,
  paths = [],
  repoRoot,
} = {}) {
  const text = String(summary ?? '').trim()
  const fileCount = Number.isFinite(files) ? Number(files) : undefined
  const activeContracts = repoRoot ? scanActiveContracts(repoRoot) : { tdd: false, activeSpecs: [] }
  const profile = repoRoot ? parseAgentsProfile(repoRoot) : null
  const coupledSyncWarnings = computeCoupledSyncWarnings(repoRoot, paths)

  const conflictRe = /(?:conflicts?\s+(?:with\s+)?tdd|与\s*tdd\s*冲突|打破\s*tdd|推翻.*(?:架构|契约|spec)|违背.*(?:tdd|spec))/i
  const contractRe = /(?:跨模块|cross[- ]?module|external\s+contract|breaking\s+change|外部契约|接口变更|协议变更|schema\s*变更|架构重构|新增命令|新增子命令|api\s*契约|refactor\s+architecture)/i
  const bugRe = /\b(?:fix|bug|bugfix|hotfix|crash|regression)\b|修复|报错|异常|缺陷|故障|崩溃|修一下|复现/i
  const docRe = /\b(?:typo|docs?(?:-only)?|readme|comment|explain|question)\b|文档|错别字|注释|问答|翻译|拼写|解释/i
  const explicitFeatureRe = /\b(?:feat|feature|implement)\b|新功能|新增功能|开发/i

  const isConflict = conflictsTdd || conflictRe.test(text)
  const isContract = touchesContract || (fileCount !== undefined && fileCount >= 6) || contractRe.test(text)
  const looksDocOnly = docOnly || (
    docRe.test(text) && !bugRe.test(text) && !explicitFeatureRe.test(text)
    && (fileCount === undefined || fileCount <= 2)
  )
  const isBugfix = bugfix || (bugRe.test(text) && !explicitFeatureRe.test(text) && (fileCount === undefined || fileCount <= 3))

  const door = classifyDoorType({
    summary: text,
    touchesContract: Boolean(isContract || isConflict),
    highRisk: profile?.highRisk ?? [],
    gateWeakened: /弱化门禁|跳过测试|skip\s+test/i.test(text),
  })

  if (isConflict) {
    return {
      caseType: 5,
      tier: 3,
      blocked: true,
      action: 'BLOCK_UPDATE_TDD_FIRST',
      doorType: 'one-way',
      doorDetails: { ...door, doorType: 'one-way' },
      critiqueTier: 'independent-critique',
      reason: '该需求与 docs/TDD.md 或生效 SPEC 存在架构/契约冲突，必须先更新 TDD.md 并获人类确认后再拆解。',
      docsRequired: ['docs/TDD.md (先更新并确认)'],
      redGreenRequired: true,
      needsReview: true,
      specApprovalRequired: true,
      activeContracts,
      coupledSyncWarnings,
    }
  }

  if (isContract) {
    return {
      caseType: 4,
      tier: 2,
      blocked: false,
      action: 'SPEC_AND_TODO',
      doorType: door.doorType,
      doorDetails: door,
      critiqueTier: 'independent-critique',
      reason: '涉及跨模块协作或外部契约变更（L3），需先编写 SPEC 经内审 Critique 与批准后，再落地 Todo 与实现。',
      docsRequired: ['docs/specs/', 'docs/todo/'],
      optionalDocs: ['docs/prd/'],
      redGreenRequired: true,
      needsReview: true,
      specApprovalRequired: true,
      activeContracts,
      coupledSyncWarnings,
    }
  }

  if (looksDocOnly) {
    return {
      caseType: 1,
      tier: 1,
      blocked: false,
      action: 'NO_DOC_DIRECT',
      doorType: door.doorType,
      doorDetails: door,
      critiqueTier: 'none',
      reason: '属于文档完善或问答/错别字修正（Case 1），无需新增规划文档。',
      docsRequired: [],
      redGreenRequired: false,
      needsReview: false,
      specApprovalRequired: false,
      activeContracts,
      coupledSyncWarnings,
    }
  }

  if (isBugfix) {
    return {
      caseType: 2,
      tier: 1,
      blocked: false,
      action: 'NO_DOC_RED_GREEN',
      doorType: door.doorType,
      doorDetails: door,
      critiqueTier: 'none',
      reason: '属于明确局部缺陷修复（Case 2），不建规划文档，但强制先补失败复现测试再修复（Red-Green）。',
      docsRequired: [],
      redGreenRequired: true,
      needsReview: false,
      specApprovalRequired: false,
      activeContracts,
      coupledSyncWarnings,
    }
  }

  return {
    caseType: 3,
    tier: 2,
    blocked: false,
    action: 'TODO_ONLY',
    doorType: door.doorType,
    doorDetails: door,
    critiqueTier: 'self-audit',
    reason: '属于不改变外部契约的局部功能开发（L2），只需建立 docs/todo/ 冻结验收标准并通过 audit 自净化。',
    docsRequired: ['docs/todo/'],
    redGreenRequired: true,
    needsReview: true,
    specApprovalRequired: false,
    activeContracts,
    coupledSyncWarnings,
  }
}

function parseIssueArg(rawIssue) {
  if (rawIssue === undefined || rawIssue === null || rawIssue === '') return null
  const num = Number(String(rawIssue).replace(/^#/, '').trim())
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error(`--issue 必须为正整数（如 278），收到：${rawIssue}`)
  }
  return num
}

function renderSingleDocContent({
  kind,
  title,
  safeSlug,
  today,
  headSha,
  headBranch,
  taskId,
  issueNum,
  owner,
  quickCmd,
  relatedSpecRel,
}) {
  if (kind === 'prd') {
    const fm = serializeDocFrontmatter({
      kind: 'prd',
      title,
      status: 'draft',
      created: today,
      updated: today,
      issue: issueNum,
      pr: null,
      owner: owner ?? null,
      plan_critique: 'pending',
      related_spec: null,
      related_todo: null,
    }, DOC_FRONTMATTER_KEY_ORDER.prd)
    return [
      fm.trimEnd(),
      '',
      `# PRD: ${title}`,
      '',
      '## 背景与目标',
      '',
      '<!-- 一两段说清真实用户痛点与预期可观测收益 -->',
      '',
      '## 复用既有模块',
      '',
      '- <待核实填写：拟复用的现成模块文件路径与导出能力>',
      '',
      '## 本期不做',
      '',
      '- <明确排除的扩展设想，防止需求蔓延>',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：<two-way | one-way>',
      '- 回滚路径：<说明如何安全撤回，不可逆改动须写明降级方案>',
      '',
      '## 验收标准（动手之前冻结）',
      '',
      '- [ ] C1: <第一条可判定的产品结果>',
      '- [ ] C2: <第二条>',
      '',
    ].join('\n')
  }

  if (kind === 'spec') {
    const fm = serializeDocFrontmatter({
      kind: 'spec',
      title,
      status: 'draft',
      tier: 'L3',
      created: today,
      updated: today,
      issue: issueNum,
      pr: null,
      branch: headBranch,
      owner: owner ?? null,
      approved: false,
      implemented: false,
      plan_critique: 'pending',
      related_prd: null,
      related_todo: null,
      high_risk_paths: [],
    }, DOC_FRONTMATTER_KEY_ORDER.spec)
    return [
      fm.trimEnd(),
      '',
      `# SPEC: ${title}`,
      '',
      '## 目标与约束',
      '',
      '<!-- 明确本次变更的目标、边界以及不得破坏的既有不变量 -->',
      '',
      '## 复用既有模块',
      '',
      '- <待核实填写：复用项目中已有的工具/协议/脚本路径，不重复造轮子>',
      '',
      '## 本期不做',
      '',
      '- <明确本期保持不动或故意延后的范围>',
      '',
      '## 接口与数据契约',
      '',
      '<!-- 列出新增或变更的 CLI、导出函数、数据结构或文件格式 -->',
      '',
      '## 影响范围',
      '',
      '- 预计涉及文件：<真实文件路径，新建文件标 (new)>',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：<two-way | one-way>',
      '- 回滚路径：<说明回退命令或反向修补方式>',
      '',
      '## 验收标准（动手之前冻结）',
      '',
      '- [ ] C1: <第一条可判定的标准>',
      '- [ ] C2: <第二条>',
      '',
      '## 实现说明',
      '',
      '<!-- 在合并之前补齐真实实现摘要与验证结果 -->',
      '',
    ].join('\n')
  }

  const fm = serializeDocFrontmatter({
    kind: 'todo',
    title,
    status: 'active',
    created: today,
    updated: today,
    issue: issueNum,
    pr: null,
    branch: headBranch,
    owner: owner ?? null,
    approved: false,
    done_at: null,
    task_id: taskId ?? safeSlug,
    planned_at: headSha,
    related_prd: null,
    related_spec: relatedSpecRel ?? null,
  }, DOC_FRONTMATTER_KEY_ORDER.todo)
  return [
    fm.trimEnd(),
    '',
    `# Todo: ${title}`,
    '',
    '## 影响范围',
    '',
    '- 预计改动文件：<待核实真实路径，新建文件标 (new)>',
    `- 快测命令：\`${quickCmd}\``,
    '',
    '## 复用既有模块',
    '',
    '- <待核实填写：准备复用的现成函数、库或脚本>',
    '',
    '## 本期不做',
    '',
    '- <明确排除本次不顺手重构的无关事项>',
    '',
    '## 门型与回滚路径',
    '',
    '- 门型：two-way',
    '- 回滚路径：局部可逆改动，直接 git revert 或删除临时分支即可回退。',
    '',
    '## 验收标准（动手之前冻结）',
    '',
    '- [ ] C1: <第一条可判定的标准>',
    '- [ ] C2: <第二条>',
    '',
    '## 执行步骤',
    '',
    `1. 先补齐复现或验收测试 —— 验证：\`${quickCmd}\``,
    `2. 实现核心改动并补齐反面用例 —— 验证：\`${quickCmd}\``,
    '',
    '## 完成后的记录',
    '',
    '**在合并之前写完，随这次改动一起提交。**',
    '',
    '- 验证命令与结果：',
    '- 遇到的问题与回避方式：',
    '',
  ].join('\n')
}

async function initDoc({
  repoRoot,
  mainRoot,
  gitDir,
  isGit,
  type,
  kind,
  slug,
  title,
  taskId,
  issue,
  owner,
  branch,
  relatedSpec,
  force = false,
}) {
  const effectiveKind = kind ?? type
  if (!['prd', 'spec', 'todo', 'pair', 'all'].includes(effectiveKind)) {
    throw new Error(`--kind / --type 必须是 prd、spec、todo、pair 或 all，收到：${effectiveKind}`)
  }
  const safeSlug = slugify(slug)
  const issueNum = parseIssueArg(issue)
  const dateTag = yymmdd()
  const today = isoDate()
  const dirMap = { prd: 'docs/prd', spec: 'docs/specs', todo: 'docs/todo' }
  const kindsToCreate = effectiveKind === 'pair'
    ? ['spec', 'todo']
    : effectiveKind === 'all'
      ? ['prd', 'spec', 'todo']
      : [effectiveKind]

  const headRes = isGit ? await gitRun(repoRoot, ['rev-parse', 'HEAD']) : { ok: false, stdout: '' }
  const headSha = headRes.ok && headRes.stdout ? headRes.stdout.trim() : 'uncommitted'
  const brRes = !branch && isGit ? await gitRun(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']) : { ok: false, stdout: '' }
  const headBranch = branch ?? (brRes.ok && brRes.stdout && brRes.stdout.trim() !== 'HEAD' ? brRes.stdout.trim() : null)
  const profile = parseAgentsProfile(repoRoot)
  const quickCmd = profile.quickTest ?? '<填写项目快测命令>'

  const planned = []
  for (const k of kindsToCreate) {
    const fileName = buildDocFilename({ date: dateTag, issue: issueNum, slug: safeSlug, kind: k })
    const relFile = `${dirMap[k]}/${fileName}`
    const absFile = join(repoRoot, relFile)
    if (existsSync(absFile) && !force) {
      throw new Error(`目标文件已存在：${relFile}（如确需重建请加 --force）`)
    }
    planned.push({ kind: k, file: relFile, absFile })
  }

  for (const item of planned) {
    const relatedSpecRel = item.kind === 'todo' && relatedSpec
      ? posixPath(relative(dirname(item.absFile), resolve(repoRoot, relatedSpec)))
      : null
    const content = renderSingleDocContent({
      kind: item.kind,
      title,
      safeSlug,
      today,
      headSha,
      headBranch,
      taskId,
      issueNum,
      owner,
      quickCmd,
      relatedSpecRel,
    })
    mkdirSync(dirname(item.absFile), { recursive: true })
    writeAtomic(item.absFile, content)
  }

  if (planned.length > 1) {
    await syncDocsLifecycle(repoRoot, {
      slugOrPath: planned[0].file,
      issue: issueNum ?? undefined,
      branch: headBranch ?? undefined,
      owner: owner ?? undefined,
    })
  }

  let ledgerUpdated = false
  if (taskId) {
    if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
    const id = sanitizeTaskId(taskId)
    const ledger = readTaskLedger(mainRoot, id) ?? createDefaultLedger({
      taskId: id,
      slug: safeSlug,
      isolation: null,
      status: 'planned',
    })
    for (const item of planned) {
      if (item.kind === 'prd') ledger.prdFile = item.file
      else if (item.kind === 'spec') ledger.specFile = item.file
      else if (item.kind === 'todo') ledger.todoFile = item.file
    }
    if (issueNum && Array.isArray(ledger.linkedIssues) && !ledger.linkedIssues.includes(issueNum)) {
      ledger.linkedIssues = [...ledger.linkedIssues, issueNum]
    }
    writeTaskLedger(mainRoot, ledger)
    ledgerUpdated = true
  }

  const primary = planned[planned.length - 1]
  return {
    type: effectiveKind,
    kind: effectiveKind,
    file: primary.file,
    absFile: primary.absFile,
    files: planned.map((p) => p.file),
    created: planned.map((p) => ({ kind: p.kind, file: p.file })),
    issue: issueNum,
    plannedAt: headSha,
    ledgerUpdated,
  }
}

function stripCritiqueMeta(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/^-\s+Plan Critique:.*\n?/gmi, '')
    .replace(/^plan_critique:.*\n?/gmi, '')
    .replace(/^updated:.*\n?/gmi, '')
}

function detectDocType(relPath, text) {
  const fm = parseDocFrontmatter(text)
  const fn = parseDocFilename(relPath)
  const fmKind = fm.data?.kind
  if (fmKind === 'prd' || fmKind === 'spec' || fmKind === 'todo') return fmKind
  if (fn?.kind) return fn.kind
  const rel = posixPath(relPath).toLowerCase()
  if (rel.startsWith('docs/specs/') || /^#\s*SPEC:/mi.test(text)) return 'spec'
  if (rel.startsWith('docs/prd/') || /^#\s*PRD:/mi.test(text)) return 'prd'
  if (rel.startsWith('docs/todo/') || rel.startsWith('docs/archive/todo/') || /^#\s*Todo:/mi.test(text)) return 'todo'
  if (rel === 'docs/tdd.md' || /^#\s*.*TDD/mi.test(text)) return 'tdd'
  return 'generic'
}

function extractSections(text) {
  const sections = new Map()
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  let curTitle = '_top'
  let curLines = []
  let inFence = false

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*(?:```|~~~)/.test(line)) inFence = !inFence
    if (!inFence && /^##\s+(.+)$/.test(line)) {
      sections.set(curTitle, curLines.join('\n'))
      curTitle = line.replace(/^##\s+/, '').trim()
      curLines = []
    } else {
      curLines.push(line)
    }
  }
  sections.set(curTitle, curLines.join('\n'))
  return sections
}

function findSectionByKeywords(sections, keywords) {
  for (const [title, body] of sections.entries()) {
    if (keywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()))) {
      return { title, body }
    }
  }
  return null
}

const VAGUE_FLUFF_RE = /(?:提高质量|保证稳定|确保稳定|确保安全|优化体验|提升体验|完善功能|做好测试|提升性能|增强健壮性|代码整洁|按需处理|合理设计|正常工作|正常运行)/
const CONCRETE_ANCHOR_RE = /(?:`[^`]+`|\bexit\b|退出码|\bassert|expect|返回\s*\d|status\s*=|\.[a-z]{1,4}\b|\d+\s*(?:ms|s|条|项|个|KB|B|行))/i
const PLACEHOLDER_TEXT_RE = /(?:待补充|待填写|待核实|\bTBD\b|\bFIXME\b|<!--\s*(?:project-forge:\s*)?fill)/i
const ANGLE_PLACEHOLDER_RE = /<([^>\n]{1,50})>/g
const PATH_PREFIX_RE = /^(?:src|lib|kit|scripts|tests?|spec|app|apps|packages|pkg|cmd|internal|docs|templates|references|\.github)\//

const VALID_STATUS_BY_TYPE = Object.freeze({
  prd: new Set(['draft', 'active', 'in_review', 'done', 'dropped']),
  spec: new Set(['draft', 'approved', 'implementing', 'in_review', 'implemented', 'superseded']),
  todo: new Set(['draft', 'active', 'pending', 'in_review', 'done', 'archived', 'dropped']),
})

const CONVENTION_DOC_DIRS = new Set(['docs/prd', 'docs/specs', 'docs/todo', 'docs/archive', 'docs/archive/todo'])

function findFmKeyLine(lines, fmEndIdx, key) {
  if (fmEndIdx < 0) return 1
  const re = new RegExp(`^${key}\\s*:`)
  for (let idx = 1; idx < fmEndIdx; idx += 1) {
    if (re.test(lines[idx])) return idx + 1
  }
  return 1
}

function extractFrontmatterIssueInt(val) {
  if (val === undefined || val === null || val === '') return null
  if (typeof val === 'number') return Number.isInteger(val) && val > 0 ? val : NaN
  const s = String(val).trim()
  if (!s) return null
  if (/^#?\d+$/.test(s)) {
    const n = Number(s.replace(/^#/, ''))
    return n > 0 ? n : NaN
  }
  const urlMatch = /\/issues\/(\d+)(?:[/?#]|$)/.exec(s)
  return urlMatch ? Number(urlMatch[1]) : NaN
}

function collectPlaceholderErrors(text, lineNo, errors) {
  if (PLACEHOLDER_TEXT_RE.test(text)) {
    errors.push({
      code: 'UNRESOLVED_PLACEHOLDER',
      line: lineNo,
      message: `第 ${lineNo} 行包含未清理占位符文本`,
      fixHint: '请将「待补充/TBD/FIXME/fill」替换为真实结论、路径或可运行验证命令。',
    })
  }
  for (const am of text.matchAll(ANGLE_PLACEHOLDER_RE)) {
    const inner = am[1].trim()
    if (!inner || /@/.test(inner) || /^https?:\/\//i.test(inner)) continue
    const looksPlaceholder = /[\u4e00-\u9fa5]|\||^(?:todo|tbd|path|file|cmd|slug|title|id|N|target|module|name|reason|owner|status|branch|spec|prd|placeholder|example|two-way\s*\|\s*one-way)/i.test(inner)
      || /(?:^|[:：]\s*|-+\s+)<[^>]+>/.test(text)
    if (looksPlaceholder) {
      errors.push({
        code: 'UNRESOLVED_ANGLE_PLACEHOLDER',
        line: lineNo,
        message: `第 ${lineNo} 行存在模板尖括号占位 <${inner}>`,
        fixHint: `请将 <${inner}> 替换为真实具体内容。`,
      })
    }
  }
}

/**
 * 规划文档静态自净化审计：拦截 Frontmatter/互链/占位/套话/缺非目标/门型及未核实路径。
 */
export function auditDoc({ repoRoot, file }) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) {
    throw new Error(`找不到待审查文档：${file}`)
  }
  const rawText = readTextSafe(abs)
  if (rawText === undefined) throw new Error(`无法读取文本文件：${file}`)

  const relDoc = posixPath(relative(repoRoot, abs))
  const docType = detectDocType(relDoc, rawText)
  const errors = []
  const warnings = []
  const normRaw = rawText.replace(/\r\n/g, '\n')
  const lines = normRaw.split('\n')

  const fm = parseDocFrontmatter(normRaw)
  let fmEndIdx = -1
  if (normRaw.startsWith('---\n')) {
    for (let idx = 1; idx < lines.length; idx += 1) {
      if (lines[idx].trim() === '---') {
        fmEndIdx = idx
        break
      }
    }
  }

  if (docType === 'spec' || docType === 'todo' || docType === 'prd') {
    if (fm.malformedFrontmatter) {
      for (const se of fm.syntaxErrors) {
        errors.push({
          code: 'FRONTMATTER_INVALID',
          line: 1,
          message: se,
          fixHint: '请修复头部 YAML Frontmatter（`--- ... ---` 与 `key: value` 语法）。',
        })
      }
    } else if (fm.hasFrontmatter) {
      for (const [k, v] of Object.entries(fm.data)) {
        if (typeof v === 'string') {
          collectPlaceholderErrors(v, findFmKeyLine(lines, fmEndIdx, k), errors)
        }
      }
      if (!fm.data.kind) {
        errors.push({
          code: 'FRONTMATTER_INVALID',
          line: 1,
          message: 'YAML Frontmatter 缺少 `kind` 字段（prd | spec | todo）',
          fixHint: `请在头部 Frontmatter 补充 \`kind: ${docType}\`。`,
        })
      } else if (fm.data.kind !== docType) {
        errors.push({
          code: 'FRONTMATTER_INVALID',
          line: findFmKeyLine(lines, fmEndIdx, 'kind'),
          message: `Frontmatter \`kind: ${fm.data.kind}\` 与文档目录类型 \`${docType}\` 不一致`,
          fixHint: `请确认文件路径与 \`kind: ${docType}\` 对齐。`,
        })
      }

      const st = typeof fm.data.status === 'string' ? fm.data.status.toLowerCase() : ''
      if (!st) {
        errors.push({
          code: 'FRONTMATTER_INVALID',
          line: 1,
          message: 'YAML Frontmatter 缺少 `status` 字段',
          fixHint: `请补充合法 status（${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}）。`,
        })
      } else if (!VALID_STATUS_BY_TYPE[docType].has(st)) {
        errors.push({
          code: 'INVALID_STATUS',
          line: findFmKeyLine(lines, fmEndIdx, 'status'),
          message: `Frontmatter \`status: ${fm.data.status}\` 不在 ${docType} 允许枚举中`,
          fixHint: `请改用：${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}。`,
        })
      }

      const fmIssue = extractFrontmatterIssueInt(fm.data.issue)
      if (Number.isNaN(fmIssue)) {
        errors.push({
          code: 'FRONTMATTER_INVALID',
          line: findFmKeyLine(lines, fmEndIdx, 'issue'),
          message: `Frontmatter \`issue\` 值格式无效：${fm.data.issue}`,
          fixHint: '请填写正整数 Issue 编号（如 `278`）或 `null`。',
        })
      } else {
        const fn = parseDocFilename(relDoc)
        if (fn && ((fmIssue && fn.issue !== fmIssue) || (fn.issue && fmIssue !== fn.issue))) {
          errors.push({
            code: 'ISSUE_FILENAME_MISMATCH',
            line: findFmKeyLine(lines, fmEndIdx, 'issue'),
            message: `Frontmatter issue (${fmIssue ?? 'null'}) 与文件名 (${relDoc}) 的 -issue<N>- 不一致`,
            fixHint: '运行 `doc-plan.mjs link <file> --issue <N>` 对齐文件名与 Frontmatter。',
          })
        }
      }

      for (const rk of ['related_prd', 'related_spec', 'related_todo']) {
        const rv = fm.data[rk]
        if (typeof rv === 'string' && rv.trim() && !/^(?:无|none)$/i.test(rv.trim())) {
          const targetAbs = resolve(dirname(abs), rv.trim())
          if (!existsSync(targetAbs)) {
            errors.push({
              code: 'BROKEN_RELATED_LINK',
              line: findFmKeyLine(lines, fmEndIdx, rk),
              path: rv.trim(),
              message: `Frontmatter \`${rk}: ${rv.trim()}\` 指向不存在的目标文件`,
              fixHint: '请核实相对路径或运行 `doc-plan.mjs link` 重新同步互链。',
            })
          }
        }
      }
    } else if (fm.data.status) {
      warnings.push({
        code: 'LEGACY_HEADER_FORMAT',
        line: 1,
        message: '仍使用旧式列表头部元数据，建议通过 `doc-plan.mjs link` 升级为 YAML Frontmatter',
      })
      const st = String(fm.data.status).toLowerCase()
      if (!VALID_STATUS_BY_TYPE[docType].has(st)) {
        errors.push({
          code: 'INVALID_STATUS',
          line: 1,
          message: `Status "${fm.data.status}" 不在 ${docType} 允许枚举中`,
          fixHint: `请改用：${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}。`,
        })
      }
    } else {
      errors.push({
        code: 'FRONTMATTER_INVALID',
        line: 1,
        message: '缺少 YAML Frontmatter（`--- ... ---`）及 status 元数据',
        fixHint: '请补齐标准 YAML Frontmatter（`kind`, `title`, `status`, `created`, `updated`）。',
      })
    }
  }

  let inFence = false
  let curSection = '_top'
  const declaredNewDirs = new Set()
  const declaredNewFiles = new Set()
  const docsFolderExists = existsSync(join(repoRoot, 'docs'))
  const startBodyLine = fmEndIdx >= 0 ? fmEndIdx + 1 : 0

  for (let i = startBodyLine; i < lines.length; i += 1) {
    const lineNo = i + 1
    const rawLine = lines[i]
    if (/^\s*(?:```|~~~)/.test(rawLine)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue

    if (/^##\s+/.test(rawLine)) {
      curSection = rawLine.replace(/^##\s+/, '').trim()
    }
    const inPostMergeSection = /(?:完成后的记录|实现说明)/.test(curSection)
    const strippedLine = rawLine.replace(/<!--[\s\S]*?-->/g, '')

    // 1. 占位符检查
    collectPlaceholderErrors(strippedLine, lineNo, errors)

    // 2. 空泛套话验收检查
    const isCriterion = /^- \[[ xX]\]\s+C\d+\b/.test(rawLine)
    if (isCriterion && VAGUE_FLUFF_RE.test(strippedLine) && !CONCRETE_ANCHOR_RE.test(strippedLine)) {
      errors.push({
        code: 'VAGUE_CRITERION',
        line: lineNo,
        message: `第 ${lineNo} 行验收标准空泛无具体可验证锚点：${rawLine.trim()}`,
        fixHint: '「说人话」规范要求每条 C* 给出真实可执行命令、断言条件、文件路径或精确错误码/退出码。',
      })
    }

    // 3. 路径真实性核查（标注 (new)/新建 时校验父目录；未标注时核查真实存在）
    if (!inPostMergeSection && !rawLine.includes('...')) {
      const pathCands = new Set()

      for (const bm of strippedLine.matchAll(/`([^`\n]+)`/g)) {
        const tok = bm[1].trim()
          .replace(/\s*(?:\(\s*new\s*\)|（\s*new\s*）|\[\s*new\s*\]|新建|新增)\s*$/i, '')
          .trim()
        if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*{}/-]*$/.test(tok) && !tok.includes(' ')) {
          if (PATH_PREFIX_RE.test(tok) || /\.[a-z]{1,5}$/i.test(tok)) pathCands.add(tok)
        }
      }
      for (const pm of strippedLine.matchAll(/(?:^|[\s(（:：,])((?:src|lib|kit|scripts|tests?|spec|apps?|packages|docs|templates|references)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?)/g)) {
        pathCands.add(pm[1].trim())
      }

      for (const rawCand of pathCands) {
        if (/^(?:https?:|file:|mailto:|node:)/i.test(rawCand)) continue
        if (/[*?{}<>]/.test(rawCand)) continue
        if (rawCand.startsWith('docs/archive/') && /归档|archive/i.test(rawLine)) continue

        const cleanRel = rawCand.replace(/^\.\//, '').replace(/\/+$/, '')
        if (!cleanRel || cleanRel === relDoc) continue
        if (docsFolderExists && CONVENTION_DOC_DIRS.has(cleanRel)) continue
        const absCand = join(repoRoot, cleanRel)

        // 按候选路径邻近上下文判断是否标为新建（避免同一行中另写一个虚假旧路径也被当作新建放行）
        const escCand = rawCand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const nearNewRe = new RegExp(
          `(?:新建|新增文件)\\s*[:：]?\\s*[\`"'“「]?[^\\s\`"'”」]*${escCand}(?![A-Za-z0-9_./-])`
          + `|(?<![A-Za-z0-9_./-])${escCand}[^\\n,;，；]{0,16}(?:\\(\\s*new\\s*\\)|（\\s*new\\s*）|\\[\\s*new\\s*\\]|新建|新增)`,
          'i',
        )
        const candMarksNew = nearNewRe.test(strippedLine)

        if (candMarksNew) {
          const parentRel = posixPath(dirname(cleanRel))
          const parentExists = parentRel === '.' || existsSync(join(repoRoot, parentRel)) || declaredNewDirs.has(parentRel)
          if (parentExists) {
            if (rawCand.endsWith('/')) declaredNewDirs.add(cleanRel)
            declaredNewFiles.add(cleanRel)
          } else {
            errors.push({
              code: 'NEW_PATH_MISSING_PARENT',
              line: lineNo,
              path: cleanRel,
              message: `第 ${lineNo} 行标注新建路径 "${cleanRel}"，但其父目录 "${parentRel}" 不存在`,
              fixHint: `请核实父目录 ${parentRel} 真实存在（或先声明上级新建目录并补充真实基础路径）。`,
            })
          }
        } else if (!existsSync(absCand) && !declaredNewFiles.has(cleanRel)) {
          errors.push({
            code: 'HALLUCINATED_PATH',
            line: lineNo,
            path: cleanRel,
            message: `第 ${lineNo} 行引用了仓库中不存在的路径 "${cleanRel}"（疑似未核实编造路径）`,
            fixHint: '先通过 dev-explore 核对真实文件名；若确实为本任务拟新建文件，请在其后标注 (new) 并保证父目录存在。',
          })
        }
      }
    }
  }

  // 4. 关键节完整性校验（本期不做、门型与回滚、C1 标准）
  const bodyForSections = startBodyLine > 0 ? lines.slice(startBodyLine).join('\n') : normRaw
  const sections = extractSections(bodyForSections)
  if (docType === 'spec' || docType === 'todo' || docType === 'prd') {
    if (!/^- \[[ xX]\]\s+C1\b/m.test(normRaw)) {
      errors.push({
        code: 'MISSING_ACCEPTANCE_CRITERIA',
        line: 1,
        message: '缺少至少一条「- [ ] C1: ...」可判定验收标准',
        fixHint: '动手前必须冻结 C1..Cn 标准，每条须能被一条命令或断言证明。',
      })
    }

    const nonGoalSec = findSectionByKeywords(sections, ['本期不做', '明确不做', '非目标', 'Non-Goals'])
    if (!nonGoalSec || !nonGoalSec.body.replace(/<!--[\s\S]*?-->/g, '').trim()) {
      errors.push({
        code: 'MISSING_NON_GOALS',
        line: 1,
        message: '缺少「本期不做 / 非目标」节或内容为空',
        fixHint: '请写清本期明确不做的事项，防止范围蔓延。',
      })
    }

    const doorSec = findSectionByKeywords(sections, ['门型与回滚', '门型', '回滚路径'])
    const doorText = doorSec ? doorSec.body.replace(/<!--[\s\S]*?-->/g, '') : ''
    if (!doorSec || !/\b(?:two-way|one-way)\b/i.test(doorText)) {
      errors.push({
        code: 'MISSING_DOOR_OR_ROLLBACK',
        line: 1,
        message: '缺少「门型与回滚路径」节，或未明确标注 two-way / one-way',
        fixHint: '请标注「门型：two-way」或「门型：one-way」，并写明具体回滚操作。',
      })
    }
  }

  const legacyCritique = /^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(normRaw)?.[1]?.trim() ?? null
  const critiqueStatus = (typeof fm.data?.plan_critique === 'string' ? fm.data.plan_critique : null) ?? legacyCritique
  return {
    ok: errors.length === 0,
    file: relDoc,
    docType,
    critiqueStatus,
    errors,
    warnings,
  }
}

export function auditRepoDocs(repoRoot, scope = '.') {
  const scopeAbs = resolve(repoRoot, scope)
  const scopeRel = posixPath(relative(repoRoot, scopeAbs))
  const dirs = ['docs/prd', 'docs/specs', 'docs/todo']
  const targets = []
  for (const d of dirs) {
    const dirAbs = join(repoRoot, d)
    if (!existsSync(dirAbs)) continue
    for (const item of collectMarkdownFiles(dirAbs, repoRoot)) {
      if (!scopeRel || scopeRel === '.' || item.rel === scopeRel || item.rel.startsWith(`${scopeRel}/`)) {
        targets.push(item.rel)
      }
    }
  }
  const results = targets.map((file) => auditDoc({ repoRoot, file }))
  const failedCount = results.filter((r) => !r.ok).length
  return {
    ok: failedCount === 0,
    scope: scopeRel || '.',
    auditedCount: results.length,
    failedCount,
    results,
  }
}

function critiquePassDoc({ repoRoot, file, reviewer, round = 1, summary = '' }) {
  if (!reviewer || !String(reviewer).trim()) {
    throw new Error('critique-pass 必须指定 --reviewer <reviewerId>')
  }
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到文档：${file}`)

  const audit = auditDoc({ repoRoot, file })
  if (!audit.ok) {
    const err = new Error(`文档尚有 ${audit.errors.length} 处审计问题未自净化，禁止记录 critique-pass`)
    err.audit = audit
    throw err
  }

  const text = readTextSafe(abs)
  if (text === undefined) throw new Error(`无法读取文本文件：${file}`)
  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const docType = detectDocType(relDoc, text)
  const digest = sha256Text(stripCritiqueMeta(text)).slice(0, 12)
  const cleanSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()
  const stampValue = `passed (reviewer=${String(reviewer).trim()}, round=${round}, sha=${digest}${cleanSummary ? `, summary=${cleanSummary}` : ''})`

  if (fm.hasFrontmatter) {
    updateDocFrontmatter(abs, {
      plan_critique: stampValue,
      updated: isoDate(),
    }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  } else {
    const stampLine = `- Plan Critique: ${stampValue}`
    let updated
    if (/^(?:-\s+)?Plan Critique:.*$/mi.test(text)) {
      updated = text.replace(/^(?:-\s+)?Plan Critique:.*$/mi, stampLine)
    } else if (/^(?:-\s+)?Status:.*$/mi.test(text)) {
      updated = text.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${stampLine}`)
    } else {
      updated = text.replace(/^(#[^\n]*\n)/, `$1\n${stampLine}\n`)
    }
    writeAtomic(abs, updated)
  }

  return {
    file: relDoc,
    reviewer: String(reviewer).trim(),
    round: Number(round),
    sha: digest,
    summary: cleanSummary || null,
    status: 'passed',
  }
}

function approveSpec({ repoRoot, file, skipCritiqueReason }) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) {
    throw new Error(`找不到 SPEC/PRD 文件：${file}`)
  }
  const text = readTextSafe(abs)
  if (text === undefined) throw new Error(`无法读取文本文件：${file}`)

  const audit = auditDoc({ repoRoot, file })
  if (!audit.ok) {
    const err = new Error(`BLOCKED_AUDIT_FAILED: ${audit.file} 尚未通过 doc-plan.mjs audit（共 ${audit.errors.length} 项缺陷），请先自修后再 approve`)
    err.audit = audit
    throw err
  }

  const fm = parseDocFrontmatter(text)
  const legacyStatusMatch = /^((?:-\s+)?Status:\s*)(\S+)(\s*)$/mi.exec(text)
  const curStatusRaw = fm.hasFrontmatter ? fm.data?.status : (fm.data?.status ?? legacyStatusMatch?.[2])
  if (!curStatusRaw) {
    throw new Error(`${file} 缺少 status（YAML Frontmatter 或「- Status: draft」）字段，无法切换状态`)
  }
  const curStatus = String(curStatusRaw).toLowerCase()
  if (curStatus === 'superseded' || curStatus === 'implemented') {
    throw new Error(`${file} 当前状态为 ${curStatus}，不允许直接 approve`)
  }

  if (!/^- \[[ xX]\] C1\b/m.test(text)) {
    throw new Error(`${file} 至少需要包含一条「- [ ] C1: ...」可判定验收标准才可批准`)
  }

  const docType = detectDocType(audit.file, text)
  let workingText = text
  let critiqueSkipped = false
  let skippedCritiqueValue = null

  if (docType === 'spec' || docType === 'prd') {
    const critiqueVal = String(fm.data?.plan_critique ?? (/^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(workingText)?.[1] ?? '')).trim()
    const isPassed = /^passed\b/i.test(critiqueVal)
    if (!isPassed) {
      if (skipCritiqueReason && String(skipCritiqueReason).trim()) {
        skippedCritiqueValue = `skipped (reason=${String(skipCritiqueReason).trim()})`
        if (!fm.hasFrontmatter) {
          const skipLine = `- Plan Critique: ${skippedCritiqueValue}`
          if (/^(?:-\s+)?Plan Critique:.*$/mi.test(workingText)) {
            workingText = workingText.replace(/^(?:-\s+)?Plan Critique:.*$/mi, skipLine)
          } else {
            workingText = workingText.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${skipLine}`)
          }
        }
        critiqueSkipped = true
      } else {
        throw new Error(
          `BLOCKED_CRITIQUE_REQUIRED: ${audit.file} 为 ${docType.toUpperCase()} 文档，必须先经独立只读 Plan Critique 通过并运行 critique-pass`
          + '（使头部为 plan_critique: passed），或由维护者显式传入 --skip-critique-reason "<原因>" 豁免',
        )
      }
    } else {
      const shaMatch = /\bsha=([a-f0-9]{8,64})\b/i.exec(critiqueVal)
      if (shaMatch) {
        const currentSha = sha256Text(stripCritiqueMeta(workingText)).slice(0, shaMatch[1].length)
        if (currentSha !== shaMatch[1].toLowerCase() && !skipCritiqueReason) {
          throw new Error(
            `BLOCKED_CRITIQUE_STALE: ${audit.file} 在 critique-pass 之后正文已被修改（recorded=${shaMatch[1]} !== current=${currentSha}），`
            + '请重新复核并执行 critique-pass，或传入 --skip-critique-reason',
          )
        }
      }
    }
  }

  const hasPlaceholder = /^- \[[ xX]\] C\d+:\s*<[^>]+>/m.test(workingText)
  if (fm.hasFrontmatter) {
    const patch = { status: 'approved', updated: isoDate() }
    if (docType === 'spec' || docType === 'todo') patch.approved = true
    if (skippedCritiqueValue) patch.plan_critique = skippedCritiqueValue
    updateDocFrontmatter(abs, patch, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  } else {
    const updated = workingText.replace(
      /^((?:-\s+)?Status:\s*)\S+(\s*)$/mi,
      '$1approved$2',
    )
    writeAtomic(abs, updated)
  }

  return {
    file: posixPath(relative(repoRoot, abs)),
    previousStatus: curStatus,
    status: 'approved',
    critiqueSkipped,
    warning: hasPlaceholder ? '检测到仍有占位描述 <...>，动手实现前请替换成真实可判定条件' : null,
  }
}

function collectMarkdownFiles(dir, root) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full, root))
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ rel: posixPath(relative(root, full)), abs: full })
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function summarizeDoc(item) {
  const text = readTextSafe(item.abs) ?? ''
  const fm = parseDocFrontmatter(text)
  const title = /^#\s+(.+)$/m.exec(fm.body || text)?.[1]?.trim() ?? fm.data?.title ?? basename(item.rel)
  const status = fm.data?.status ?? null
  const created = fm.data?.created ?? null
  const plannedAt = fm.data?.planned_at ?? null
  const issue = fm.data?.issue ?? null
  const pr = fm.data?.pr ?? null
  const totalChecks = (text.match(/^- \[[ xX]\]/gm) ?? []).length
  const doneChecks = (text.match(/^- \[[xX]\]/gm) ?? []).length
  return { file: item.rel, title, status, created, plannedAt, issue, pr, totalChecks, doneChecks }
}

export function listDocs(repoRoot) {
  const tddPath = join(repoRoot, 'docs', 'TDD.md')
  const tdd = existsSync(tddPath)
    ? summarizeDoc({ rel: 'docs/TDD.md', abs: tddPath })
    : null
  const prds = collectMarkdownFiles(join(repoRoot, 'docs', 'prd'), repoRoot).map(summarizeDoc)
  const specs = collectMarkdownFiles(join(repoRoot, 'docs', 'specs'), repoRoot).map(summarizeDoc)
  const todos = collectMarkdownFiles(join(repoRoot, 'docs', 'todo'), repoRoot).map(summarizeDoc)
  const archived = collectMarkdownFiles(join(repoRoot, 'docs', 'archive'), repoRoot).map(summarizeDoc)
  return { tdd, prds, specs, todos, archived }
}

function parseCli(argv) {
  const sub = argv[0]
  const opts = { _: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a === '--touches-contract') opts.touchesContract = true
    else if (a === '--conflicts-tdd') opts.conflictsTdd = true
    else if (a === '--doc-only') opts.docOnly = true
    else if (a === '--bugfix') opts.bugfix = true
    else if (a === '--force') opts.force = true
    else if (a === '--approve') opts.approve = true
    else if (a === '--implemented') opts.implemented = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        opts[a.slice(2)] = argv[i + 1]
        i += 1
      }
    } else {
      opts._.push(a)
    }
  }
  return { sub, opts }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-plan/scripts/doc-plan.mjs <子命令> [选项]',
    '',
    '子命令：',
    '  triage         --summary <文本> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--json]',
    '  init           --kind <prd|spec|todo|pair|all> --slug <slug> --title <标题> [--issue <N>] [--task <id>] [--json]',
    '  link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <B>] [--owner <O>] [--status <S>] [--approve] [--json]',
    '  audit          [--file <docPath> | .] [--json]',
    '  critique-pass  --file <docPath> --reviewer <id> [--round 1|2] [--summary <文本>] [--json]',
    '  approve        --file <specPath> [--skip-critique-reason <文本>] [--json]',
    '  list           [--json]',
  ].join('\n') + '\n')
}

async function collectWorkingTreePaths(repoRoot) {
  const st = await gitRun(repoRoot, ['status', '--porcelain', '-u'])
  if (!st.ok || !st.stdout) return []
  return st.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(3).trim().split(' -> ').pop().trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }

  const { sub, opts } = parseCli(argv)
  if (opts.help) { printHelp(); return 0 }

  const targetDir = resolve(opts.dir ?? process.cwd())
  const roots = await resolveRepoRoots(targetDir)
  const repoRoot = roots.isGit ? roots.workTreeRoot : targetDir
  const mainRoot = roots.isGit ? roots.mainRoot : targetDir

  try {
    if (sub === 'triage') {
      const summary = opts.summary ?? opts._.join(' ')
      if (!summary) throw new Error('triage 需要传入 --summary "<需求描述>"')
      const filesNum = opts.files !== undefined ? Number(opts.files) : undefined
      const triagePaths = opts.paths !== undefined
        ? String(opts.paths).split(',').map((s) => s.trim()).filter(Boolean)
        : (roots.isGit ? await collectWorkingTreePaths(repoRoot) : [])
      const result = triageTask({
        summary,
        files: filesNum,
        touchesContract: Boolean(opts.touchesContract),
        conflictsTdd: Boolean(opts.conflictsTdd),
        docOnly: Boolean(opts.docOnly),
        bugfix: Boolean(opts.bugfix),
        paths: triagePaths,
        repoRoot,
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else {
        process.stdout.write(`分流结论：Case ${result.caseType} (${result.action})${result.blocked ? ' [BLOCKED]' : ''}\n`)
        process.stdout.write(`- 门型: ${result.doorType} | 规划内审档位: ${result.critiqueTier}\n`)
        process.stdout.write(`- 理由: ${result.reason}\n`)
        process.stdout.write(`- 必建文档: ${result.docsRequired.join(', ') || '无 (0 文档)'}\n`)
        process.stdout.write(`- Red-Green 回归测试: ${result.redGreenRequired ? '强制' : '不需要'} | 独立审查: ${result.needsReview ? '需要' : '低风险免除'}\n`)
        if (result.coupledSyncWarnings?.length > 0) {
          process.stdout.write(`- 联动同步提醒（改哪看哪）:\n`)
          for (const w of result.coupledSyncWarnings) {
            process.stdout.write(`  * 触及 ${w.touchedTriggers.join(', ')} -> 需检查同步 ${w.expectedCompanions.join(', ')}\n`)
          }
        }
        if (result.caseType === 5) {
          printNextStep([
            '已阻断直接拆解！请先更新 docs/TDD.md 解决冲突并经独立确认，然后再重新分流。',
          ])
        } else if (result.caseType === 4) {
          printNextStep([
            '1. 创建 SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind pair --slug <slug> --title "<标题>"',
            '2. 自检净化: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file <specPath>',
            '3. 派独立只读 Critique 通过后执行 critique-pass，再由人执行 approve',
          ])
        } else if (result.caseType === 3) {
          printNextStep([
            '1. 启动任务隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 3 --slug <slug>',
            '2. 生成 Todo 并跑 audit 自净化：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind todo --slug <slug> --title "<标题>" --task <id>',
          ])
        } else {
          printNextStep([
            `启动任务流转：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case ${result.caseType} --slug <slug>`,
          ])
        }
      }
      return 0
    }

    if (sub === 'init') {
      const initKind = opts.kind ?? opts.type
      if (!initKind || !opts.slug || !opts.title) {
        throw new Error('init 需要 --kind <prd|spec|todo|pair|all>、--slug <slug> 与 --title <title>')
      }
      const res = await initDoc({
        repoRoot,
        mainRoot,
        gitDir: roots.gitDir,
        isGit: roots.isGit,
        type: opts.type,
        kind: opts.kind,
        slug: opts.slug,
        title: opts.title,
        taskId: opts.task,
        issue: opts.issue,
        owner: opts.owner,
        branch: opts.branch,
        relatedSpec: opts.spec,
        force: Boolean(opts.force),
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else {
        process.stdout.write(`已生成 ${res.kind.toUpperCase()}：${res.files.join(', ')}（Planned at: ${res.plannedAt}）\n`)
        printNextStep([
          `写完真实内容、可复用模块与 C1..Cn 后运行内审自检：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${res.file}"`,
        ])
      }
      return 0
    }

    if (sub === 'link') {
      const target = opts._[0] ?? opts.file ?? opts.slug
      if (!target) {
        throw new Error('link 需要传入 <slug-or-path>（如 261114-my-feature 或 docs/specs/...）')
      }
      const issueVal = opts.issue !== undefined ? parseIssueArg(opts.issue) : undefined
      const prVal = opts.pr !== undefined ? Number(String(opts.pr).replace(/^#/, '').trim()) : undefined
      if (prVal !== undefined && (!Number.isInteger(prVal) || prVal <= 0)) {
        throw new Error(`--pr 必须为正整数，收到：${opts.pr}`)
      }
      const res = await syncDocsLifecycle(repoRoot, {
        slugOrPath: target,
        issue: issueVal,
        pr: prVal,
        branch: opts.branch,
        owner: opts.owner,
        status: opts.status,
        approved: opts.approve ? true : undefined,
        implemented: opts.implemented ? true : undefined,
        doneAt: opts['done-at'],
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else {
        process.stdout.write(`文档生命周期同步完成（issue=${res.issue ?? '无'}，重命名 ${res.renamed.length} 个，更新 ${res.updated.length} 个）\n`)
        for (const r of res.renamed) {
          process.stdout.write(`- 重命名 [${r.kind}]: ${r.from} -> ${r.to}\n`)
        }
        for (const u of res.updated) {
          process.stdout.write(`- 已同步 [${u.kind ?? 'doc'}]: ${u.file}（status=${u.data.status ?? '-'}）\n`)
        }
      }
      return 0
    }

    if (sub === 'audit') {
      const target = opts.file ?? opts._[0] ?? '.'
      const targetAbs = resolve(repoRoot, target)
      const isDirScope = target === '.' || (existsSync(targetAbs) && statSync(targetAbs).isDirectory())
      if (isDirScope) {
        const batch = auditRepoDocs(repoRoot, target)
        if (opts.json) {
          process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`)
        } else {
          process.stdout.write(`仓库工程文档审计（${batch.scope}，共 ${batch.auditedCount} 份）：${batch.ok ? '全部通过' : `${batch.failedCount} 份失败`}\n`)
          for (const r of batch.results) {
            process.stdout.write(`- ${r.file} (${r.docType}): ${r.ok ? '通过' : `失败 (${r.errors.length})`}\n`)
            for (const e of r.errors) {
              process.stdout.write(`  * [${e.code}] L${e.line}: ${e.message}\n    修法: ${e.fixHint}\n`)
            }
          }
        }
        return batch.ok ? 0 : 1
      }
      const res = auditDoc({ repoRoot, file: target })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else {
        process.stdout.write(`文档审计（${res.file}，type=${res.docType}）：${res.ok ? '通过' : `失败（${res.errors.length} 项错误）`}\n`)
        for (const e of res.errors) {
          process.stdout.write(`- [${e.code}] L${e.line}: ${e.message}\n  修法: ${e.fixHint}\n`)
        }
        if (res.ok) {
          printNextStep([
            res.docType === 'spec' || res.docType === 'prd'
              ? `自审已通过，派独立只读 Critique 并运行 critique-pass：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <id>`
              : '自审已通过，可进入代码实施并按每轮 {target} 快测节奏推进。',
          ])
        } else {
          printNextStep(['按上方修法逐条原位修改文档（禁止新建平行草案），改完重跑 audit。'])
        }
      }
      return res.ok ? 0 : 1
    }

    if (sub === 'critique-pass') {
      if (!opts.file || !opts.reviewer) {
        throw new Error('critique-pass 需要 --file <docPath> 与 --reviewer <reviewerId>')
      }
      const res = critiquePassDoc({
        repoRoot,
        file: opts.file,
        reviewer: opts.reviewer,
        round: opts.round ?? 1,
        summary: opts.summary ?? '',
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else {
        process.stdout.write(`Critique 通过记录已写入 ${res.file}（reviewer=${res.reviewer}, round=${res.round}, sha=${res.sha}）\n`)
        printNextStep([
          `提交人类确认批准：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${res.file}"`,
        ])
      }
      return 0
    }

    if (sub === 'approve') {
      if (!opts.file) throw new Error('approve 需要 --file <specPath>')
      const res = approveSpec({
        repoRoot,
        file: opts.file,
        skipCritiqueReason: opts['skip-critique-reason'],
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else {
        process.stdout.write(`文档已切换为 approved：${res.file}（原状态：${res.previousStatus}）\n`)
        if (res.warning) process.stdout.write(`提示：${res.warning}\n`)
        printNextStep([
          '可继续创建或关联 docs/todo/ 后进入 flow.mjs start / 编码实施阶段。',
        ])
      }
      return 0
    }

    if (sub === 'list') {
      const data = listDocs(repoRoot)
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      } else {
        process.stdout.write('# 工程文档全景（实时扫描）\n')
        process.stdout.write(`- docs/TDD.md: ${data.tdd ? `${data.tdd.title}` : '缺失'}\n`)
        const sections = [
          ['PRD (docs/prd/)', data.prds],
          ['SPEC (docs/specs/)', data.specs],
          ['Todo (docs/todo/)', data.todos],
          ['Archive (docs/archive/)', data.archived],
        ]
        for (const [label, items] of sections) {
          process.stdout.write(`\n## ${label} (${items.length})\n`)
          for (const it of items) {
            const checkInfo = it.totalChecks > 0 ? ` [${it.doneChecks}/${it.totalChecks}]` : ''
            const st = it.status ? ` status=${it.status}` : ''
            process.stdout.write(`- ${it.file}: ${it.title}${st}${checkInfo}\n`)
          }
        }
        printNextStep([
          '新建或分流任务请运行：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<任务描述>"',
        ])
      }
      return 0
    }

    throw new Error(`未知子命令：${sub}（支持 triage / init / link / audit / critique-pass / approve / list）`)
  } catch (err) {
    if (opts.json && err?.audit) {
      process.stdout.write(`${JSON.stringify({ ok: false, error: err.message, audit: err.audit }, null, 2)}\n`)
    }
    process.stderr.write(`doc-plan 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
