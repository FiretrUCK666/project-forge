/**
 * doc-audit.mjs —— 五档需求分流、规划文档静态自净化审计与 Critique 元信息剥离。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 doc-plan.mjs 与外部测试引用。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { posixPath, readTextSafe } from '../../lib/git.mjs'
import { checkMermaidLabelWidth, evaluateCoupledSync, parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter } from '../../lib/docs.mjs'
import { FORM_INDEPENDENT_CORE, findMissingSections, resolveDocRequirements, resolveSectionPresence } from '../../lib/doc-requirements.mjs'
import { validateSkippedSections } from '../../lib/doc-shape.mjs'
import {
  checkCoreSubstantiveness, checkDocRegression, collectMasterPrdSpecTexts,
  extractDocSnapshot, resolveBaselineSnapshotSync, VAGUE_FLUFF_RE,
} from '../../lib/doc-substantive.mjs'
import { parseAgentsProfile, resolveAuthoritativeTddPath } from '../../lib/profile.mjs'
import { pendingDecisionErrors } from '../../lib/pending-decisions.mjs'
import { numberingErrors } from '../../lib/doc-renumber.mjs'
import { checkTddStructure } from '../../lib/tdd-structure.mjs'
import { classifyDoorType } from '../../lib/static-gates.mjs'
import {
  CONCERN_FACES, DOC_CUE_RE, EXPLICIT_FEATURE_RE, FIX_VERB_RE, RUNTIME_BUG_RE,
  evaluatePureDocCheck, extractTriageSignals, facesOf as resolveTriageFaces, normalizeTriageInputs,
} from './triage-rules.mjs'

export const VALID_STATUS_BY_TYPE = Object.freeze({
  prd: new Set(['draft', 'active', 'in_review', 'done', 'dropped']),
  spec: new Set(['draft', 'approved', 'implementing', 'in_review', 'implemented', 'superseded']),
  todo: new Set(['draft', 'active', 'pending', 'in_review', 'done', 'archived', 'dropped']),
})

const CONCRETE_ANCHOR_RE = /(?:`[^`]+`|\bexit\b|退出码|\bassert|expect|返回\s*\d|status\s*=|\.[a-z]{1,4}\b|\d+\s*(?:ms|s|条|项|个|KB|B|行))/i
const PLACEHOLDER_TEXT_RE = /(?:待补充|待填写|待核实|\bTBD\b|\bFIXME\b|<!--\s*(?:project-forge:\s*)?fill)/i
const ANGLE_PLACEHOLDER_RE = /<([^>\n]{1,60})>/g
const PATH_PREFIX_RE = /^(?:src|lib|kit|scripts|tests?|spec|app|apps|packages|pkg|cmd|internal|docs|templates|references|\.github)\//
const CONVENTION_DOC_DIRS = new Set(['docs/prd', 'docs/specs', 'docs/todo', 'docs/archive', 'docs/archive/prd', 'docs/archive/specs', 'docs/archive/todo'])

function scanActiveContracts(root) {
  const contracts = { tdd: Boolean(resolveAuthoritativeTddPath(root)), activeSpecs: [] }
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
  } catch { /* ignore */ }
  return contracts
}

function computeCoupledSyncWarnings(repoRoot, paths) {
  if (!repoRoot || !Array.isArray(paths) || paths.length === 0) return []
  const agentsText = readTextSafe(join(repoRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  return rules.length > 0 ? evaluateCoupledSync(paths, rules, repoRoot) : []
}

/** 这件事同时会碰到哪几个面。 */
function facesOf(text, preSignals = null) {
  return resolveTriageFaces(text, preSignals)
}

function assessPrdNeed({ text, faces, fileCount }) {
  const batchRe = /拆成|拆分为|分\s*(?:两|二|三|四|多)\s*批|分\s*(?:两|二|三|四|多)\s*期|一期.{0,6}二期|几个独立|逐步推进|分批落地|多切片|拆成多份/
  const reasons = []
  if (faces.length >= 4) reasons.push(`同时要碰 ${faces.length} 个面（${faces.join('、')}）`)
  if (batchRe.test(text)) reasons.push('需求本身说了要分批落地')
  if (Number.isFinite(fileCount) && fileCount >= 12) reasons.push(`声明要动 ${fileCount} 个文件`)

  return {
    required: reasons.length > 0,
    reasons,
    // 一份 SPEC 的验收清单大约装得下「一件事」；超过门上就要上层容器。
    // 这里给的是可覆盖的默认档，不是硬阈值——判据本身是上面三条。
    advice: reasons.length > 0
      ? '先写总控 PRD 冻结整份验收清单，再拆成多份 SPEC + Todo；每份 SPEC 认领其中几条 C。'
      : '先按一份 SPEC 做；一旦发现要拆成两份以上，就必须先补一份总控 PRD——'
        + '不然那几份 SPEC 加起来「算不算做完」没人说得清（audit 会报「无主切片」）。',
  }
}


/**
 * 治理类任务：把「一个项目整理成什么样」当目标，而不是改其中某一处。
 *
 * 它天然跨面（文档 + CI + 契约 + 目录都会动），所以它不该落进「只改文档」那一档。
 * 这个词表只用来**认出这类任务**，判档仍然走上面数面数的判据——认出来也只是因为它
 * 通常同时命中三面以上。
 */
const GOVERNANCE_RE = /治理|规范化|标准化|整理项目|项目规范|接管|接入套件|项目起步|初始化项目/i

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
  const { fileCount, effectivePaths } = normalizeTriageInputs(files, paths)

  const activeContracts = repoRoot ? scanActiveContracts(repoRoot) : { tdd: false, activeSpecs: [] }
  const profile = repoRoot ? parseAgentsProfile(repoRoot) : null
  const coupledSyncWarnings = computeCoupledSyncWarnings(repoRoot, effectivePaths)

  const conflictRe = /(?:conflicts?\s+(?:with\s+)?tdd|与\s*tdd\s*冲突|打破\s*tdd|推翻.*(?:架构|契约|spec)|违背.*(?:tdd|spec))/i
  const contractRe = /(?:跨模块|cross[- ]?module|external\s+contract|breaking\s+change|外部契约|接口变更|协议变更|schema\s*变更|架构重构|新增命令|新增子命令|api\s*契约|refactor\s+architecture)/i

  const signals = extractTriageSignals(text, effectivePaths)
  const faces = facesOf(text, signals)
  const isGovernance = GOVERNANCE_RE.test(text)
  const isCrossCutting = faces.length >= 3
  const prdNeed = assessPrdNeed({ text, faces, fileCount })

  const isConflict = conflictsTdd || conflictRe.test(text)
  const isContract = touchesContract
    || (!docOnly && fileCount !== undefined && fileCount >= 6)
    || contractRe.test(text)
    || isCrossCutting
    || isGovernance
    || prdNeed.required

  const hasRuntimeBug = bugfix || signals.runtimeBugSignals.length > 0 || RUNTIME_BUG_RE.test(signals.maskedText)
  const hasExplicitFeature = EXPLICIT_FEATURE_RE.test(signals.maskedText)
  const pureDocCue = (DOC_CUE_RE.test(signals.maskedText) || (signals.docPaths.length > 0 && signals.pathsVerifiedDocOnly))
    && !hasRuntimeBug && !hasExplicitFeature
  const hasOnlyDocFaces = faces.length > 0 && faces.every((f) => f === 'docs')
  const looksDocOnly = docOnly
    || signals.pureQa
    || (pureDocCue && !isCrossCutting && !isGovernance && hasOnlyDocFaces && (fileCount === undefined || fileCount <= 3))
  const isBugfix = bugfix || (!looksDocOnly && (hasRuntimeBug || FIX_VERB_RE.test(signals.maskedText)) && !hasExplicitFeature && !isCrossCutting && !isGovernance && (fileCount === undefined || fileCount <= 3))

  const door = classifyDoorType({
    changedFiles: effectivePaths,
    summary: text,
    touchesContract: Boolean(isContract || isConflict),
    highRisk: profile?.highRisk ?? [],
    gateWeakened: /弱化门禁|跳过测试|skip\s+test/i.test(text),
  })

  const buildCase2 = (pureDocCheck = null) => {
    const bugNeedsReview = door.doorType === 'one-way' || door.signals.length > 0
    return {
      caseType: 2, tier: 1, blocked: false, action: 'NO_DOC_RED_GREEN',
      doorType: door.doorType, doorDetails: door, critiqueTier: 'none',
      reason: bugNeedsReview
        ? '属于触及高风险/单向门边界的缺陷修复（Case 2），须 Red-Green 回归并接受独立审查。'
        : '属于明确局部缺陷修复（Case 2），不建规划文档，但强制先补失败复现测试再修复（Red-Green）。',
      docsRequired: [], redGreenRequired: true, needsReview: bugNeedsReview, specApprovalRequired: false,
      prdRequired: false, prdReasons: [], prdAdvice: null,
      faces, ...(pureDocCheck ? { pureDocCheck } : {}),
      activeContracts, coupledSyncWarnings,
    }
  }
  const buildCase3 = (pureDocCheck = null) => ({
    caseType: 3, tier: 2, blocked: false, action: 'TODO_ONLY',
    doorType: door.doorType, doorDetails: door, critiqueTier: 'self-audit',
    reason: '属于不改变外部契约的局部功能开发（L2），只需建立 docs/todo/ 冻结验收标准并通过 audit 自净化。',
    docsRequired: ['docs/todo/'], redGreenRequired: true, needsReview: true, specApprovalRequired: false,
    prdRequired: false, prdReasons: [], prdAdvice: prdNeed.advice,
    faces, ...(pureDocCheck ? { pureDocCheck } : {}),
    activeContracts, coupledSyncWarnings,
  })

  if (isConflict) {
    return {
      caseType: 5, tier: 3, blocked: true, action: 'BLOCK_UPDATE_TDD_FIRST',
      doorType: 'one-way', doorDetails: { ...door, doorType: 'one-way' }, critiqueTier: 'independent-critique',
      reason: '该需求与 docs/TDD.md 或生效 SPEC 存在架构/契约冲突，必须先更新 TDD.md 并获人类确认后再拆解。',
      docsRequired: ['docs/TDD.md (先更新并确认)'], redGreenRequired: true, needsReview: true, specApprovalRequired: true,
      prdRequired: false, prdReasons: [], prdAdvice: null, faces, activeContracts, coupledSyncWarnings,
    }
  }
  if (isContract) {
    return {
      caseType: 4, tier: 2, blocked: false, action: 'SPEC_AND_TODO',
      doorType: door.doorType, doorDetails: door, critiqueTier: 'independent-critique',
      reason: '涉及跨模块协作或外部契约变更（L3），需先编写 SPEC 经内审 Critique 与批准后，再落地 Todo 与实现。',
      docsRequired: prdNeed.required ? ['docs/prd/', 'docs/specs/', 'docs/todo/'] : ['docs/specs/', 'docs/todo/'],
      optionalDocs: prdNeed.required ? [] : ['docs/prd/'],
      prdRequired: prdNeed.required,
      prdReasons: prdNeed.reasons,
      prdAdvice: prdNeed.advice,
      redGreenRequired: true, needsReview: true, specApprovalRequired: true, faces, activeContracts, coupledSyncWarnings,
    }
  }
  if (looksDocOnly) {
    const pureDocCheck = evaluatePureDocCheck({
      faces,
      signals,
      hasOnlyDocFaces,
      docOnly,
      hasRuntimeBug,
      hasExplicitFeature,
      touchesContract,
      conflictsTdd,
      isCrossCutting,
      isGovernance,
      fileCount,
    })
    if (pureDocCheck.passed) {
      return {
        caseType: 1, tier: 1, blocked: false, action: 'NO_DOC_DIRECT',
        doorType: door.doorType, doorDetails: door, critiqueTier: 'none',
        reason: '属于文档完善或问答/错别字修正（Case 1），无需新增规划文档。',
        docsRequired: [], redGreenRequired: false, needsReview: door.doorType === 'one-way', specApprovalRequired: false,
        prdRequired: false, prdReasons: [], prdAdvice: null,
        faces, pureDocCheck, activeContracts, coupledSyncWarnings,
      }
    }
    const rejectToBugfix = bugfix || hasRuntimeBug || (FIX_VERB_RE.test(signals.maskedText) && !hasExplicitFeature && !isCrossCutting && !isGovernance)
    return rejectToBugfix ? buildCase2(pureDocCheck) : buildCase3(pureDocCheck)
  }
  const rejectedCheck = (pureDocCue || signals.nonDocPaths.length > 0)
    ? evaluatePureDocCheck({
        faces, signals, hasOnlyDocFaces, docOnly, hasRuntimeBug, hasExplicitFeature,
        touchesContract, conflictsTdd, isCrossCutting, isGovernance, fileCount,
      })
    : null
  if (isBugfix) return buildCase2(rejectedCheck)
  return buildCase3(rejectedCheck)
}

/** 剥离易变生命周期元字段（保留方案正文、稳定标题/层级与验收标准），确保 link --issue/--pr 后不误触发陈旧锁定。 */
export function stripCritiqueMeta(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  const fm = parseDocFrontmatter(norm)
  const stableMeta = {
    kind: fm.data?.kind ?? null,
    title: fm.data?.title ?? null,
    tier: fm.data?.tier ?? null,
    high_risk_paths: Array.isArray(fm.data?.high_risk_paths) ? fm.data.high_risk_paths : [],
  }
  const volatileLineRe = /^(?:-\s+)?(?:Plan Critique|Status|Issue|PR|Updated|Branch|Owner|Related\s+(?:SPEC|PRD|Todo)|plan_critique|critique_anchors|updated|issue|pr|status|related_prd|related_spec|related_todo|approved|implemented|done_at|branch|owner)\s*:/i
  const cleanBody = String(fm.body ?? norm)
    .split('\n')
    .filter((l) => !volatileLineRe.test(l.trim()))
    .join('\n')
    .replace(/(\bdocs\/(?:prd|specs|todo)\/\d{6})-issue\d+-/gi, '$1-')
    .trim()
  return `${JSON.stringify(stableMeta)}\n${cleanBody}`
}

export function detectDocType(relPath, text) {
  const fm = parseDocFrontmatter(text)
  const fn = parseDocFilename(relPath)
  const fmKind = fm.data?.kind
  if (fmKind === 'prd' || fmKind === 'spec' || fmKind === 'todo') return fmKind
  if (fn?.kind) return fn.kind
  const rel = posixPath(relPath).toLowerCase()
  if (rel.startsWith('docs/specs/') || rel.startsWith('docs/archive/specs/') || /^#\s*SPEC:/mi.test(text)) return 'spec'
  if (rel.startsWith('docs/prd/') || rel.startsWith('docs/archive/prd/') || /^#\s*PRD:/mi.test(text)) return 'prd'
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
  for (const line of lines) {
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
    if (keywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()))) return { title, body }
  }
  return null
}

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

function isGenericOrJsxAngle(rawText, matchIdx, rawMatch, inner) {
  if (!inner || /@/.test(inner) || /^https?:\/\//i.test(inner)) return true
  if (matchIdx > 0 && /[A-Za-z0-9_:]/.test(rawText[matchIdx - 1])) return true
  if (rawMatch.endsWith('/>')) return true
  if (/^[A-Z][A-Za-z0-9_.]*(?:,\s*[A-Z][A-Za-z0-9_.?]*)*$/.test(inner)) return true
  if (/^(?:string|number|boolean|void|unknown|any|never|null|undefined|u8|u16|u32|u64|usize|i32|i64|f64|bool|char|str)(?:\s*[|,]\s*[A-Za-z0-9_.\s|]+)*$/.test(inner)) return true
  return false
}

function collectPlaceholderErrors(rawText, strippedText, lineNo, errors) {
  if (PLACEHOLDER_TEXT_RE.test(rawText)) {
    errors.push({
      code: 'UNRESOLVED_PLACEHOLDER',
      line: lineNo,
      message: `第 ${lineNo} 行包含未清理占位符文本`,
      fixHint: '请将「待补充/TBD/FIXME/fill」替换为真实结论、路径或可运行验证命令。',
    })
  }
  for (const am of strippedText.matchAll(ANGLE_PLACEHOLDER_RE)) {
    const inner = am[1].trim()
    if (isGenericOrJsxAngle(strippedText, am.index ?? 0, am[0], inner)) continue
    const looksPlaceholder = /[\u4e00-\u9fa5]|\||^(?:todo|tbd|path|file|cmd|slug|title|id|N|target|module|name|reason|owner|status|branch|spec|prd|placeholder|example|two-way\s*\|\s*one-way)$/i.test(inner)
      || /(?:^|[:：]\s*|-+\s+)<[^>]+>/.test(strippedText)
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

function extractLinePathCandidates(strippedLine) {
  const cands = new Set()
  for (const bm of strippedLine.matchAll(/`([^`\n]+)`/g)) {
    const tok = bm[1].trim().replace(/\s*(?:\(\s*new\s*\)|（\s*new\s*）|\[\s*new\s*\]|新建|新增)\s*$/i, '').trim()
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.*{}/-]*$/.test(tok) && !tok.includes(' ')) {
      if (PATH_PREFIX_RE.test(tok) || /\.[a-z]{1,5}$/i.test(tok)) cands.add(tok)
    }
  }
  const withoutHttpRoutes = strippedLine.replace(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/?[A-Za-z0-9_./:-]+/gi, ' ')
  for (const pm of withoutHttpRoutes.matchAll(/(?:^|[\s(（:：,])((?:src|lib|kit|scripts|tests?|spec|apps?|packages|docs|templates|references)\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/?)/g)) {
    cands.add(pm[1].trim())
  }
  return [...cands]
}

function candHasNewAnnotation(strippedLine, rawCand) {
  const escCand = rawCand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nearNewRe = new RegExp(
    `(?:新建|新增文件)\\s*[:：]?\\s*[\`"'“「]?[^\\s\`"'”」]*${escCand}(?![A-Za-z0-9_./-])`
    + `|(?<![A-Za-z0-9_./-])${escCand}[^\\n,;，；]{0,20}(?:\\(\\s*new\\s*\\)|（\\s*new\\s*）|\\[\\s*new\\s*\\]|新建|新增)`,
    'i',
  )
  return nearNewRe.test(strippedLine)
}

/** 规划文档静态自净化审计：两遍收集 `(new)`、校验 Mermaid 宽度、Frontmatter 与占位。 */
export function auditDoc({ repoRoot, file, baselineText = null }) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到待审查文档：${file}`)
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
      if (lines[idx].trim() === '---') { fmEndIdx = idx; break }
    }
  }

  // TDD 的主干核对只对 TDD 自己生效——PRD/SPEC/Todo 不走这套章节要求。
  if (docType === 'tdd') errors.push(...checkTddStructure(rawText))

  if (docType === 'spec' || docType === 'todo' || docType === 'prd') {
    if (fm.malformedFrontmatter) {
      for (const se of fm.syntaxErrors) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: se, fixHint: '请修复头部 YAML Frontmatter（`--- ... ---` 与 `key: value` 语法）。' })
      }
    } else if (fm.hasFrontmatter) {
      for (const [k, v] of Object.entries(fm.data)) {
        if (k === 'critique_anchors') continue
        if (typeof v === 'string') collectPlaceholderErrors(v, v, findFmKeyLine(lines, fmEndIdx, k), errors)
      }
      if (!fm.data.kind) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: 'YAML Frontmatter 缺少 `kind` 字段（prd | spec | todo）', fixHint: `请在头部 Frontmatter 补充 \`kind: ${docType}\`。` })
      } else if (fm.data.kind !== docType) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: findFmKeyLine(lines, fmEndIdx, 'kind'), message: `Frontmatter \`kind: ${fm.data.kind}\` 与文档目录类型 \`${docType}\` 不一致`, fixHint: `请确认文件路径与 \`kind: ${docType}\` 对齐。` })
      }

      const st = typeof fm.data.status === 'string' ? fm.data.status.toLowerCase() : ''
      if (!st) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: 'YAML Frontmatter 缺少 `status` 字段', fixHint: `请补充合法 status（${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}）。` })
      } else if (!VALID_STATUS_BY_TYPE[docType].has(st)) {
        errors.push({ code: 'INVALID_STATUS', line: findFmKeyLine(lines, fmEndIdx, 'status'), message: `Frontmatter \`status: ${fm.data.status}\` 不在 ${docType} 允许枚举中`, fixHint: `请改用：${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}。` })
      }

      const fmIssue = extractFrontmatterIssueInt(fm.data.issue)
      if (Number.isNaN(fmIssue)) {
        errors.push({ code: 'FRONTMATTER_INVALID', line: findFmKeyLine(lines, fmEndIdx, 'issue'), message: `Frontmatter \`issue\` 值格式无效：${fm.data.issue}`, fixHint: '请填写正整数 Issue 编号（如 `278`）或 `null`。' })
      } else {
        const fn = parseDocFilename(relDoc)
        if (fn && ((fmIssue && fn.issue !== fmIssue) || (fn.issue && fmIssue !== fn.issue))) {
          errors.push({ code: 'ISSUE_FILENAME_MISMATCH', line: findFmKeyLine(lines, fmEndIdx, 'issue'), message: `Frontmatter issue (${fmIssue ?? 'null'}) 与文件名 (${relDoc}) 的 -issue<N>- 不一致`, fixHint: '运行 `doc-plan.mjs link <file> --issue <N>` 对齐文件名与 Frontmatter。' })
        }
      }

      for (const rk of ['related_prd', 'related_spec', 'related_todo']) {
        const rv = fm.data[rk]
        if (typeof rv === 'string' && rv.trim() && !/^(?:无|none)$/i.test(rv.trim())) {
          if (!existsSync(resolve(dirname(abs), rv.trim()))) {
            errors.push({ code: 'BROKEN_RELATED_LINK', line: findFmKeyLine(lines, fmEndIdx, rk), path: rv.trim(), message: `Frontmatter \`${rk}: ${rv.trim()}\` 指向不存在的目标文件`, fixHint: '请核实相对路径或运行 `doc-plan.mjs link` 重新同步互链。' })
          }
        }
      }
    } else if (fm.data.status) {
      warnings.push({ code: 'LEGACY_HEADER_FORMAT', line: 1, message: '仍使用旧式列表头部元数据，建议通过 `doc-plan.mjs link` 升级为 YAML Frontmatter' })
      const st = String(fm.data.status).toLowerCase()
      if (!VALID_STATUS_BY_TYPE[docType].has(st)) {
        errors.push({ code: 'INVALID_STATUS', line: 1, message: `Status "${fm.data.status}" 不在 ${docType} 允许枚举中`, fixHint: `请改用：${[...VALID_STATUS_BY_TYPE[docType]].join(' | ')}。` })
      }
    } else {
      errors.push({ code: 'FRONTMATTER_INVALID', line: 1, message: '缺少 YAML Frontmatter（`--- ... ---`）及 status 元数据', fixHint: '请补齐标准 YAML Frontmatter（`kind`, `title`, `status`, `created`, `updated`）。' })
    }
  }

  const startBodyLine = fmEndIdx >= 0 ? fmEndIdx + 1 : 0
  const bodyLines = []
  let inFence = false
  let curSection = '_top'
  for (let i = startBodyLine; i < lines.length; i += 1) {
    const rawLine = lines[i]
    if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^##+\s+/.test(rawLine)) curSection = rawLine.replace(/^##+\s+/, '').trim()
    // 这些位置提到不存在的路径是**对的**：讲「不做什么」会说「不动那条旧路径」，
    // 讲「实现说明 / 完成记录」会说「删掉了哪个文件」。在这些地方报幻觉路径是误报，
    // 而误报的代价是人开始忽略这条检查。
    //
    // 认位置不能只看中文标题：真实文档写 `## Out of scope`、`## 实现说明`、
    // `## What we removed` 的都有。所以标题启发 + 行内语义两条一起用。
    const removedPathCue = /(?:已删除|删掉|删除|移除|不再使用|旧路径|废弃|不存在|\b(?:deleted|removed|dropped|no longer)\b)/i
    bodyLines.push({
      lineNo: i + 1,
      rawLine,
      strippedLine: rawLine.replace(/<!--[\s\S]*?-->/g, ''),
      skipPathCheck: /(?:完成后的记录|实现说明|本期不做|明确不做|非目标|Non-Goals|范围外|不在本次|Out of scope|removed|cleanup)/i.test(curSection)
        || rawLine.includes('...')
        || removedPathCue.test(rawLine),
    })
  }

  const declaredNewDirs = new Set()
  const declaredNewFiles = new Set()
  const docsFolderExists = existsSync(join(repoRoot, 'docs'))

  // Pass 1: 收集占位、套话与全部 (new) 声明
  for (const item of bodyLines) {
    collectPlaceholderErrors(item.rawLine, item.strippedLine, item.lineNo, errors)
    const isCriterion = /^- \[[ xX]\]\s+C\d+\b/.test(item.rawLine)
    if (isCriterion && VAGUE_FLUFF_RE.test(item.strippedLine) && !CONCRETE_ANCHOR_RE.test(item.strippedLine)) {
      errors.push({
        code: 'VAGUE_CRITERION',
        line: item.lineNo,
        message: `第 ${item.lineNo} 行验收标准空泛无具体可验证锚点：${item.rawLine.trim()}`,
        fixHint: '「说人话」规范要求每条 C* 给出真实可执行命令、断言条件、文件路径或精确错误码/退出码。',
      })
    }
    if (item.skipPathCheck) continue
    for (const rawCand of extractLinePathCandidates(item.strippedLine)) {
      if (/^(?:https?:|file:|mailto:|node:)/i.test(rawCand) || /[*?{}<>]/.test(rawCand)) continue
      const cleanRel = rawCand.replace(/^\.\//, '').replace(/\/+$/, '')
      if (!cleanRel || cleanRel === relDoc || !candHasNewAnnotation(item.strippedLine, rawCand)) continue
      const parentRel = posixPath(dirname(cleanRel))
      const parentExists = parentRel === '.' || existsSync(join(repoRoot, parentRel)) || declaredNewDirs.has(parentRel)
      if (parentExists) {
        if (rawCand.endsWith('/')) declaredNewDirs.add(cleanRel)
        declaredNewFiles.add(cleanRel)
      } else {
        errors.push({
          code: 'NEW_PATH_MISSING_PARENT',
          line: item.lineNo,
          path: cleanRel,
          message: `第 ${item.lineNo} 行标注新建路径 "${cleanRel}"，但其父目录 "${parentRel}" 不存在`,
          fixHint: `请核实父目录 ${parentRel} 真实存在（或先声明上级新建目录并补充真实基础路径）。`,
        })
      }
    }
  }

  // Pass 2: 校验全部引用路径（已存在或已在本篇标为 (new)）
  for (const item of bodyLines) {
    if (item.skipPathCheck) continue
    for (const rawCand of extractLinePathCandidates(item.strippedLine)) {
      if (/^(?:https?:|file:|mailto:|node:)/i.test(rawCand) || /[*?{}<>]/.test(rawCand)) continue
      if (rawCand.startsWith('docs/archive/') && /归档|archive/i.test(item.rawLine)) continue
      const cleanRel = rawCand.replace(/^\.\//, '').replace(/\/+$/, '')
      if (!cleanRel || cleanRel === relDoc) continue
      if (docsFolderExists && CONVENTION_DOC_DIRS.has(cleanRel)) continue
      if (candHasNewAnnotation(item.strippedLine, rawCand)) continue
      if (!existsSync(join(repoRoot, cleanRel)) && !declaredNewFiles.has(cleanRel) && !declaredNewDirs.has(cleanRel)) {
        errors.push({
          code: 'HALLUCINATED_PATH',
          line: item.lineNo,
          path: cleanRel,
          message: `第 ${item.lineNo} 行引用了仓库中不存在的路径 "${cleanRel}"（疑似未核实编造路径）`,
          fixHint: '先通过 dev-explore 核对真实文件名；若确实为本任务拟新建文件，请在其后标注 (new) 并保证父目录存在。',
        })
      }
    }
  }

  // Mermaid 防截断显示宽度检查（C4）
  const mermaidCheck = checkMermaidLabelWidth(normRaw)
  for (const mv of mermaidCheck.violations) {
    errors.push({
      code: mv.kind === 'html' ? 'MERMAID_HTML_FORBIDDEN' : 'MERMAID_LABEL_TOO_WIDE',
      line: mv.line,
      message: mv.message,
      fixHint: mv.fixHint,
    })
  }

  const bodyForSections = startBodyLine > 0 ? lines.slice(startBodyLine).join('\n') : normRaw
  let skippedSections = []
  let delta = null
  if (docType === 'spec' || docType === 'todo' || docType === 'prd') {
    const docRequirements = resolveDocRequirements(repoRoot, docType)
    const hasAcceptance = /^- \[[ xX]\]\s+C1\b/m.test(normRaw)
    const sectionLookup = resolveSectionPresence(bodyForSections, docRequirements)

    const skipCheck = validateSkippedSections(bodyForSections, docRequirements, docType)
    skippedSections = skipCheck.skippedSections
    errors.push(...skipCheck.errors)

    // 章节编号必须连续：删了一节却没重排，读的人会以为文档缺了东西。
    errors.push(...numberingErrors(bodyForSections))

    // 待拍板没清空就往下走，等于让实现去猜答案。
    errors.push(...pendingDecisionErrors(normRaw))

    // 核心与设计节实质性检查（零字数下限）与跨轮防退化快照比对
    errors.push(...checkCoreSubstantiveness(bodyForSections, docType))
    const currentSnap = extractDocSnapshot(normRaw)
    const baseInfo = resolveBaselineSnapshotSync({ repoRoot, relDoc, fmData: fm.data, baselineText })
    const reg = checkDocRegression(baseInfo.snap, currentSnap, baseInfo.source)
    delta = reg.delta
    errors.push(...reg.errors)

    const missing = findMissingSections(docRequirements, sectionLookup, { hasInlineAcceptance: hasAcceptance })
    for (const miss of missing) {
      const code = miss.id === 'acceptance'
        ? 'MISSING_ACCEPTANCE_CRITERIA'
        : `MISSING_SECTION_${miss.id.toUpperCase().replace(/-/g, '_')}`
      const lead = miss.core
        ? `缺少「${miss.label}」节或内容为空——这一节与项目形态无关，任何项目都得回答`
        : `项目自己的模板要求了「${miss.label}」，但这份文档里没有`
      const valueGap = miss.reason === 'section-missing-required-value'
        ? `（内容在，但没有给出必须标注的值：${miss.needsPattern.source}）`
        : ''
      errors.push({ code, line: 1, message: `${lead}${valueGap}`, fixHint: miss.fixHint })
    }

    // 反向：自定义模板不能变成「什么都不用写」的免检通道。
    // 主干三节即使被项目声明 omit，也照样要求——这是上面 resolveDocRequirements 的保证，
    // 这里显式断言一次，防止哪天有人在那一层把 core 判据改松。
    const coreIds = FORM_INDEPENDENT_CORE[docType] ?? []
    const droppedCore = coreIds.filter((id) => !docRequirements.sections.some((sec) => sec.id === id))
    if (droppedCore.length > 0) {
      errors.push({
        code: 'CORE_SECTION_WAIVED',
        line: 1,
        message: `项目声明把主干章节去掉了：${droppedCore.join('、')}——主干是不可豁免的，`
          + '否则「我有一个自己的模板」就成了什么都不用写的免检通道。',
        fixHint: '把这几节从自定义模板的 omit_sections 里移除；要写得合身，减的是可选章节，不是主干。',
      })
    }
  }

  const legacyCritique = /^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(normRaw)?.[1]?.trim() ?? null
  const critiqueStatus = (typeof fm.data?.plan_critique === 'string' ? fm.data.plan_critique : null) ?? legacyCritique
  return { ok: errors.length === 0, file: relDoc, docType, critiqueStatus, skippedSections, delta, errors, warnings }
}

export function collectMarkdownFiles(dir, root) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full, root))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push({ rel: posixPath(relative(root, full)), abs: full })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/**
 * 总控 PRD 的每个 `C` 项，必须被某份生效 SPEC 认领。
 *
 * ## 它治的病
 *
 * 一份总控 PRD 冻结了 `C1..C27`，然后拆成四份 SPEC。**没有任何东西检查这四份加起来
 * 有没有把 27 条都认领到。** 漏掉的那几条不会报错：PRD 里它还在，SPEC 里没人提，
 * 于是它既不进实现也不进审查，最后以「这件事好像做过」的样子消失在记忆里。
 *
 * 实测形状：一份 PRD 第 19 条明确要求「会话结束清理 worktree」，拆成三份 SPEC 执行时
 * 没有任何一份认领它，而 PRD 的验收勾选表里第 19 条是 `[x]`——它什么时候被勾上的，
 * 没人说得清。
 *
 * ## 判据只认「点名」
 *
 * 一条 C 被认领的证据是：某份 SPEC 的正文里**出现了这个 C 编号**（`C7`、`C7、`、
 * `C7的`、`C7）` 等边界形状都算）。按语义判断「这份 SPEC 讲的是不是这条」不是这里
 * 能做的事；本判据只回答一个机械问题：**有没有人提过它**。
 *
 * 漏掉的不一定真漏（也可能写成了「见 PRD 第 7 条」），所以报出来的是**编号缺失**，
 * 处置是人去看一眼——这比静默通过好，因为静默通过连「看一眼」的机会都没有。
 */
export function checkMasterPrdCoverage(repoRoot, { prdRel = null } = {}) {
  const prdDir = join(repoRoot, 'docs', 'prd')
  const prdFiles = prdRel
    ? [prdRel]
    : (existsSync(prdDir) ? collectMarkdownFiles(prdDir, repoRoot).map((x) => x.rel) : [])
  if (prdFiles.length === 0) return []

  const out = []
  for (const rel of prdFiles) {
    const text = readTextSafe(join(repoRoot, rel)) ?? ''
    const ids = [...new Set([...text.matchAll(/^- \[[ xX]\]\s+(C\d+)\b/gm)].map((m) => m[1]))]
    if (ids.length === 0) continue
    const fm = parseDocFrontmatter(text)
    const specTexts = collectMasterPrdSpecTexts(repoRoot, rel, fm.data)
    const uncovered = ids.filter((id) => {
      const re = new RegExp(`\\b${id}(?![0-9])`)
      return !specTexts.some((spec) => re.test(spec))
    })
    if (uncovered.length > 0) {
      out.push({
        code: 'UNCOVERED_ACCEPTANCE_CRITERIA',
        file: rel,
        missing: uncovered,
        message: `${rel} 里有 ${uncovered.length} 条验收标准没有被任何生效 SPEC 认领：${uncovered.join('、')}`
          + '——它们不会进实现也不会进审查，最后以「好像做过」的样子消失',
      })
    }
  }
  return out
}

/**
 * 有几份生效 SPEC，却没有任何 PRD 认领它们 = 一组没人的切片。
 *
 * ## 它补的是预判的漏
 *
 * `triage` 在动手前预判「这份需求要不要总控 PRD」。但预判会落空：人可能先按 Case 4
 * 开了第一份 SPEC，做到一半发现要拆第二份、第三份——**拆的那一刻 PRD 就成了必需品，
 * 而没有人回头看这件事。**
 *
 * 没有 PRD 的多份切片，问题不在于「少一份文档」，而在于**「整体算不算做完」没有落点**：
 *
 * - 每份 SPEC 各自勾完自己的 C，都绿了；
 * - 但它们合起来是不是把这件事做完了，没有任何一份文档回答得了；
 * - 于是「做了一半就宣布完成」成了一种完全合法的状态。
 *
 * ## 判据
 *
 * 只认 **1:N 已成事实**：`docs/specs/` 里有两份以上生效 SPEC，它们各自 `related_prd`
 * 指向不同的（或空的）PRD。只要有一份 PRD 被两份以上 SPEC 共同指向，这一组就算有主。
 *
 * 反向条件写清楚：一份 SPEC 或零份 SPEC 时不报——**一份 SPEC 自己就是完整单位，
 * 不需要上层容器。**
 */
export function checkOrphanSlices(repoRoot) {
  const specDir = join(repoRoot, 'docs', 'specs')
  if (!existsSync(specDir)) return []
  const specs = collectMarkdownFiles(specDir, repoRoot)
  if (specs.length < 2) return []

  // 每份 SPEC 指向哪个 PRD（空 = 没指）。解析不出来的按「没指」算，宁可多报一次。
  const pointed = new Map()
  for (const item of specs) {
    const fm = parseDocFrontmatter(readTextSafe(item.abs) ?? '')
    const raw = fm.data?.related_prd
    const target = typeof raw === 'string' && raw.trim() && !/^(?:无|none)$/i.test(raw.trim())
      ? posixPath(relative(repoRoot, resolve(dirname(item.abs), raw.trim())))
      : null
    pointed.set(item.rel, target)
  }

  // 同一份 PRD 被两份以上 SPEC 指向 = 这一组有主，正常。
  const counts = new Map()
  for (const target of pointed.values()) {
    if (!target) continue
    counts.set(target, (counts.get(target) ?? 0) + 1)
  }
  if ([...counts.values()].some((n) => n >= 2)) return []

  return [{
    code: 'ORPHAN_SLICES_NO_MASTER_PRD',
    file: 'docs/specs/',
    specs: [...pointed.keys()],
    message: `docs/specs/ 里有 ${specs.length} 份生效 SPEC，但没有任何一份 PRD 被两份以上 SPEC 共同认领`
      + '——每份 SPEC 自己勾完都绿着，而「这一整件事算不算做完」没有落点，'
      + '于是「做了一半就宣布完成」是一种完全合法的状态。'
      + '要么补一份总控 PRD 让这些 SPEC 指向它，要么说明它们确实是彼此独立的多件事（各自单独走完）。',
  }]
}

export function auditRepoDocs(repoRoot, scope = '.') {
  const scopeAbs = resolve(repoRoot, scope)
  const scopeRel = posixPath(relative(repoRoot, scopeAbs))
  const targets = []
  for (const d of ['docs/prd', 'docs/specs', 'docs/todo']) {
    const dirAbs = join(repoRoot, d)
    if (!existsSync(dirAbs)) continue
    for (const item of collectMarkdownFiles(dirAbs, repoRoot)) {
      if (!scopeRel || scopeRel === '.' || item.rel === scopeRel || item.rel.startsWith(`${scopeRel}/`)) targets.push(item.rel)
    }
  }
  const results = targets.map((file) => auditDoc({ repoRoot, file }))
  const coverageErrors = [...checkMasterPrdCoverage(repoRoot), ...checkOrphanSlices(repoRoot)]
  const allErrors = [...results.flatMap((r) => r.errors ?? []), ...coverageErrors]
  const failedCount = results.filter((r) => !r.ok).length + (coverageErrors.length > 0 ? 1 : 0)
  return {
    ok: allErrors.length === 0,
    scope: scopeRel || '.',
    auditedCount: results.length,
    failedCount,
    results,
    coverageErrors,
  }
}

function summarizeDoc(item) {
  const text = readTextSafe(item.abs) ?? ''
  const fm = parseDocFrontmatter(text)
  const title = /^#\s+(.+)$/m.exec(fm.body || text)?.[1]?.trim() ?? fm.data?.title ?? basename(item.rel)
  return {
    file: item.rel,
    title,
    status: fm.data?.status ?? null,
    created: fm.data?.created ?? null,
    plannedAt: fm.data?.planned_at ?? null,
    issue: fm.data?.issue ?? null,
    pr: fm.data?.pr ?? null,
    totalChecks: (text.match(/^- \[[ xX]\]/gm) ?? []).length,
    doneChecks: (text.match(/^- \[[xX]\]/gm) ?? []).length,
  }
}

export function listDocs(repoRoot) {
  const tddPath = join(repoRoot, 'docs', 'TDD.md')
  return {
    tdd: existsSync(tddPath) ? summarizeDoc({ rel: 'docs/TDD.md', abs: tddPath }) : null,
    prds: collectMarkdownFiles(join(repoRoot, 'docs', 'prd'), repoRoot).map(summarizeDoc),
    specs: collectMarkdownFiles(join(repoRoot, 'docs', 'specs'), repoRoot).map(summarizeDoc),
    todos: collectMarkdownFiles(join(repoRoot, 'docs', 'todo'), repoRoot).map(summarizeDoc),
    archived: collectMarkdownFiles(join(repoRoot, 'docs', 'archive'), repoRoot).map(summarizeDoc),
  }
}
