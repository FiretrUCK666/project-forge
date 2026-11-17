/**
 * triage-rules.mjs —— 五档需求分流的代码符号提取掩码、关注面判定与纯文档自检不变式。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 doc-audit.mjs 与测试夹具调用。
 */

import { posixPath } from '../../lib/git.mjs'

export const CONCERN_FACES = [
  { id: 'docs', re: /\bdocs?\b|readme|contributing|changelog|文档|说明|指南|文案|错别字|拼写|注释|翻译/i },
  { id: 'ci', re: /\bci\b|workflow|actions|流水线|发布|release|发版|持续集成|自动化|门禁/i },
  { id: 'contract', re: /契约|contract|agents|规范|标准|schema|接口|协议|许可|license/i },
  { id: 'structure', re: /目录|结构|重构|refactor|模块|边界|布局|组织/i },
  { id: 'code', re: /源码|代码|脚本|函数|判据|逻辑|算法|性能|勘察|校验|bug|缺陷|正则|regex|regexp|parser|__CODE_TOKEN__/i },
  { id: 'tooling', re: /工具|套件|skill|技能|脚手架|依赖|配置/i },
]

export const RUNTIME_BUG_RE = /\b(?:bug|bugfix|hotfix|crash|regression|exception|panic|fail(?:s|ed|ing|ure)?|error\s*\d*|false\s+positive)\b|\bbroken\b(?!\s+(?:phrasing|wording|grammar|sentence|english|prose|formatting|link|anchor|markdown|docs?)\b)|报错|异常|缺陷|故障|崩溃|复现|回归|误报|误判|剪光|漏掉|丢失|覆盖了|坏了|不生效/i
export const FIX_VERB_RE = /\bfix\b|修复|修一下|修正/i
export const DOC_CUE_RE = /\b(?:typo|spelling|phrasing|wording|docs?(?:-only)?|readme|contributing|comment|explain|question|changelog)\b|文档|错别字|注释|问答|翻译|拼写|解释/i
export const EXPLICIT_FEATURE_RE = /\b(?:feat|feature|implement|add\s+(?:support|command|subcommand|flag|option|param(?:eter)?|endpoint|api))\b|新功能|新增功能|开发新|(?:加一个|增加|添加|新增|支持)[^\n]{0,30}(?:参数|选项|标志|子命令|命令|flag|option|支持)/i

const CODE_PATH_IN_TEXT_RE = /(?<![A-Za-z0-9_./-])([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|mts|cts|ts|tsx|jsx|vue|svelte|go|py|rs|java|kt|kts|rb|php|cs|fs|c|cc|cpp|h|hpp|swift|dart|sh|bash|ps1|yml|yaml|json|toml|lock|ini|cfg|sql|proto|graphql|css|scss|html))(?![A-Za-z0-9_.-])/gi
const GITHUB_CFG_IN_TEXT_RE = /(?<![A-Za-z0-9_./-])(\.github\/[A-Za-z0-9_./*-]*)/gi
const CLI_FLAG_IN_TEXT_RE = /(^|[\s(（"'`])(--[a-z0-9][a-z0-9-]*)(?=$|[\s)）"'`,，。])/gi
const TOOL_PREFIX_RE = /(?<![A-Za-z0-9_-])((?:doc|review|govern|flow|repo|survey|worktree|triage|static|handoff|critique|tdd|symbol|command|profile|task|github|platform|agents|starter|equip|preflight|fixtures)-(?!only\b)[a-z0-9-]+(?:\s+(?:init|triage|audit|link|archive|start|verify|submit|merge|record|override|cleanup|rework|sync|batch|inspect|claim|release|pack|plan|reconcile|sample|retro|check|create|restore))?)(?![A-Za-z0-9_-])/gi
const CLI_SUBCOMMAND_RE = /(?<![A-Za-z0-9_-])((?:doc-plan|planx|flow|review-pack|govern-audit|repo-map|survey|equip|backup|compose-agents|handoff|sync-toc)\s+(?:init|triage|audit|link|archive|start|verify|submit|merge|record|override|cleanup|rework|sync|batch|inspect|claim|release|pack|plan|reconcile|sample|retro|check|create|restore)|[a-z][a-z0-9-]*\s+init)(?![A-Za-z0-9_-])/gi
const COMMENT_OUT_RE = /\bcomment\s+out\b|注释掉|把[^\n]{0,24}注释掉/gi
const LOGIC_SIGNAL_RE = /(?:正则|\bregex(?:p)?\b|\bparser\b|false\s+positive|误判|误报|剪光|裁剪|路径正则)/gi
const DOC_TARGET_FILE_RE = /\b(?:README(?:\.[A-Za-z0-9_-]+)?|CONTRIBUTING(?:\.[A-Za-z0-9_-]+)?|CHANGELOG(?:\.[A-Za-z0-9_-]+)?|LICENSE(?:-[A-Za-z0-9_-]+)?|SECURITY|CODE_OF_CONDUCT)(?:\.(?:md|txt|rst))?\b|[A-Za-z0-9_./-]+\.(?:md|markdown|txt|rst|adoc)\b/gi
const DOC_PROSE_TARGET_RE = /(?:文档|说明文档|使用指南|错别字|文案|注释|\b(?:changelog|readme|contributing)\b)/gi
const PURE_QA_RE = /(?:^|[\s，。？?])(?:explain(?:\s+(?:how|what|why|the))?|what\s+(?:is|are|does)|how\s+(?:does|do|to)|describe|summarize|clarify)\b|解释一下|解释|介绍一下|说明一下|什么是|怎么用|如何工作|有什么区别|为什么/i
const EDIT_VERB_RE = /\b(?:fix|update|modify|edit|change|refactor|implement|add|remove|delete|drop|strip|rename|replace|write|create|patch|disable|enable)\b|修复|修一下|修正|修改|改动|更改|更新|重构|实现|加一个|增加|添加|新增|删除|删掉|移除|去掉|补充|替换为/gi
const CI_IMPL_RE = /\.github\/|workflow|actions|流水线|持续集成|\bci\b(?:\s*(?:流水线|配置|脚本|检查|门禁|失败|报错))|(?:配置|配|修改|新增|修复|启用|调整|接入)\s*(?:ci|发布|发版|release|门禁|自动化)/i
const DOC_TOPIC_PHRASE_RE = /(?:发版|发布|ci|workflow|actions|门禁|自动化|发布流程)(?:说明|文档|指南|章节|示例|介绍)/gi

const PURE_DOC_EXT_RE = /\.(?:md|markdown|mdx|txt|rst|adoc)$/i
const PURE_DOC_NAME_RE = /(?:^|\/)(?:README|CONTRIBUTING|CHANGELOG|LICENSE|COPYING|NOTICE|AUTHORS|SECURITY|CODE_OF_CONDUCT)(?:\.[A-Za-z0-9_-]+)?$/i
const NON_DOC_AREA_RE = /^(?:\.[^/]+|templates|kit)\//i

/** 判断单个仓库相对路径是否属于纯文档资产（排除 .github/、代码、脚本与配置）。 */
export function isPureDocPath(filePath) {
  const norm = posixPath(String(filePath ?? '')).trim().replace(/^\.\//, '').replace(/^\/+/, '')
  if (!norm || NON_DOC_AREA_RE.test(norm)) return false
  if (norm === 'SKILL.md' || norm === 'AGENTS.md' || norm.endsWith('/SKILL.md') || norm.endsWith('/AGENTS.md')) {
    return false
  }
  if (PURE_DOC_EXT_RE.test(norm)) return true
  if (PURE_DOC_NAME_RE.test(norm) && !/\.(?:mjs|cjs|js|ts|tsx|jsx|yml|yaml|json|toml|sh|ps1)$/i.test(norm)) {
    return true
  }
  return false
}

function addUnique(bucket, val) {
  const clean = String(val ?? '').trim()
  if (clean && !bucket.includes(clean)) bucket.push(clean)
}

function maskMatches(input, re, bucket) {
  return input.replace(re, (match) => {
    addUnique(bucket, match)
    return ' __CODE_TOKEN__ '
  })
}

/** 先提取代码/工具/参数/缺陷信号并替换为占位符，再供文档与关注面匹配。 */
function maskCodeAndToolTokens(rawText) {
  let masked = rawText
  const codePathsInText = []
  const toolTokens = []
  const flagTokens = []
  const commentOutTokens = []

  masked = maskMatches(masked, GITHUB_CFG_IN_TEXT_RE, codePathsInText)
  masked = maskMatches(masked, CODE_PATH_IN_TEXT_RE, codePathsInText)
  masked = masked.replace(/`([^`\n]+)`/g, (whole, inner) => {
    const clean = inner.trim()
    if (!clean || clean === '__CODE_TOKEN__') return whole
    if (isPureDocPath(clean) || /^(?:README|CONTRIBUTING|CHANGELOG|LICENSE)$/i.test(clean)) return whole
    if (clean.startsWith('--')) addUnique(flagTokens, clean)
    else if (/[./\\()]|^[a-z0-9]+-[a-z0-9-]+$/i.test(clean) || /\s/.test(clean)) addUnique(toolTokens, clean)
    return ' __CODE_TOKEN__ '
  })
  masked = masked.replace(CLI_FLAG_IN_TEXT_RE, (whole, lead, flag) => {
    addUnique(flagTokens, flag)
    return `${lead} __CODE_TOKEN__ `
  })
  masked = maskMatches(masked, TOOL_PREFIX_RE, toolTokens)
  masked = maskMatches(masked, CLI_SUBCOMMAND_RE, toolTokens)
  masked = maskMatches(masked, COMMENT_OUT_RE, commentOutTokens)

  return { masked, codePathsInText, toolTokens, flagTokens, commentOutTokens }
}

/** 提取分流所需的掩码文本、代码符号、缺陷词、文档目标与路径白名单状态。 */
export function extractTriageSignals(text, paths = []) {
  const rawText = String(text ?? '')
  const cleanPaths = (Array.isArray(paths) ? paths : []).map((p) => posixPath(String(p ?? '')).trim()).filter(Boolean)
  const docPaths = cleanPaths.filter((p) => isPureDocPath(p))
  const nonDocPaths = cleanPaths.filter((p) => !isPureDocPath(p))
  const pathsVerifiedDocOnly = nonDocPaths.length === 0

  const { masked: maskedText, codePathsInText, toolTokens, flagTokens, commentOutTokens } = maskCodeAndToolTokens(rawText)

  const logicTokens = []
  for (const m of maskedText.matchAll(LOGIC_SIGNAL_RE)) addUnique(logicTokens, m[0])

  const runtimeBugSignals = []
  for (const m of maskedText.matchAll(new RegExp(RUNTIME_BUG_RE.source, 'gi'))) addUnique(runtimeBugSignals, m[0])

  const editVerbs = []
  for (const m of maskedText.matchAll(EDIT_VERB_RE)) addUnique(editVerbs, m[0])

  const matchedDocTargets = []
  for (const p of docPaths) addUnique(matchedDocTargets, p)
  for (const m of maskedText.matchAll(DOC_TARGET_FILE_RE)) addUnique(matchedDocTargets, m[0])
  if (codePathsInText.length === 0 && toolTokens.length === 0 && flagTokens.length === 0 && commentOutTokens.length === 0 && nonDocPaths.length === 0) {
    for (const m of maskedText.matchAll(DOC_PROSE_TARGET_RE)) addUnique(matchedDocTargets, m[0])
  }

  const hasCodeSignals = codePathsInText.length > 0
    || toolTokens.length > 0
    || flagTokens.length > 0
    || commentOutTokens.length > 0
    || logicTokens.length > 0
    || nonDocPaths.length > 0

  const hasDocTarget = matchedDocTargets.length > 0
  const hasCiAction = CI_IMPL_RE.test(maskedText) || nonDocPaths.some((p) => /(?:^|\/)\.github\//i.test(p))
  const textForFaces = (hasDocTarget && !hasCodeSignals && !hasCiAction)
    ? maskedText.replace(DOC_TOPIC_PHRASE_RE, ' __DOC_TOPIC__ ')
    : maskedText

  const pureQa = PURE_QA_RE.test(maskedText)
    && editVerbs.length === 0
    && runtimeBugSignals.length === 0
    && !hasCodeSignals

  return {
    rawText,
    maskedText,
    textForFaces,
    codePathsInText,
    toolTokens,
    flagTokens,
    commentOutTokens,
    logicTokens,
    runtimeBugSignals,
    editVerbs,
    matchedDocTargets,
    docPaths,
    nonDocPaths,
    pathsVerifiedDocOnly,
    hasCodeSignals,
    pureQa,
  }
}

/** 计算需求命中的关注面数组（输入已掩码文本并融合路径与故障信号）。 */
export function facesOf(text, preSignals = null) {
  const signals = preSignals ?? extractTriageSignals(text)
  const out = CONCERN_FACES.filter((face) => face.re.test(signals.textForFaces)).map((face) => face.id)
  if (signals.nonDocPaths.length > 0) {
    addUnique(out, 'code')
    if (signals.nonDocPaths.some((p) => /(?:^|\/)\.github\//i.test(p))) addUnique(out, 'ci')
  }
  if (signals.docPaths.length > 0 && signals.nonDocPaths.length === 0) addUnique(out, 'docs')
  if (signals.runtimeBugSignals.length > 0) addUnique(out, 'code')
  return out
}

/** 统一规范化 triageTask 传入的 files（数值或路径列表）与 paths。 */
export function normalizeTriageInputs(files, paths) {
  const rawPaths = Array.isArray(paths)
    ? [...paths]
    : (typeof paths === 'string' && paths.trim() ? paths.split(',').map((s) => s.trim()).filter(Boolean) : [])
  let fileCount
  if (Number.isFinite(files)) {
    fileCount = Number(files)
  } else if (typeof files === 'string' && /^\d+$/.test(files.trim())) {
    fileCount = Number(files.trim())
  } else if (typeof files === 'string' && files.trim()) {
    const splitFiles = files.split(',').map((s) => s.trim()).filter(Boolean)
    rawPaths.push(...splitFiles)
    fileCount = splitFiles.length
  } else if (Array.isArray(files)) {
    const cleanFiles = files.map((s) => String(s ?? '').trim()).filter(Boolean)
    rawPaths.push(...cleanFiles)
    fileCount = cleanFiles.length
  }
  const effectivePaths = [...new Set(rawPaths.map((p) => posixPath(String(p ?? '')).trim()).filter(Boolean))]
  return { fileCount, effectivePaths }
}

/**
 * Case 1 强制自检不变式：证明为什么属纯文档/纯问答，或收集代码/缺陷拦截信号并拒绝 Case 1。
 */
export function evaluatePureDocCheck({
  faces = [],
  signals,
  hasOnlyDocFaces = false,
  docOnly = false,
  hasRuntimeBug = false,
  hasExplicitFeature = false,
  touchesContract = false,
  conflictsTdd = false,
  isCrossCutting = false,
  isGovernance = false,
  fileCount,
} = {}) {
  const s = signals ?? extractTriageSignals('')
  const rejectedCodeSignals = []

  for (const p of s.codePathsInText ?? []) addUnique(rejectedCodeSignals, `codePath:${p}`)
  for (const t of s.toolTokens ?? []) addUnique(rejectedCodeSignals, `tool:${t}`)
  for (const f of s.flagTokens ?? []) addUnique(rejectedCodeSignals, `flag:${f}`)
  for (const c of s.commentOutTokens ?? []) addUnique(rejectedCodeSignals, `commentOut:${c}`)
  for (const l of s.logicTokens ?? []) addUnique(rejectedCodeSignals, `logic:${l}`)
  for (const b of s.runtimeBugSignals ?? []) addUnique(rejectedCodeSignals, `bug:${b}`)
  for (const p of s.nonDocPaths ?? []) addUnique(rejectedCodeSignals, `path:${p}`)

  if (hasRuntimeBug && (s.runtimeBugSignals?.length ?? 0) === 0) addUnique(rejectedCodeSignals, 'runtimeBug')
  if (hasExplicitFeature) addUnique(rejectedCodeSignals, 'explicitFeature')
  if (touchesContract) addUnique(rejectedCodeSignals, 'touchesContract')
  if (conflictsTdd) addUnique(rejectedCodeSignals, 'conflictsTdd')
  if (isCrossCutting) addUnique(rejectedCodeSignals, `crossCutting:${faces.length}`)
  if (isGovernance) addUnique(rejectedCodeSignals, 'governance')
  if (fileCount !== undefined && fileCount > 3) addUnique(rejectedCodeSignals, `fileCount:${fileCount}`)

  let kind = 'doc-edit'
  if (s.pureQa) kind = 'pure-qa'
  else if (docOnly) kind = 'explicit-doc-only'

  const hasValidBasis = Boolean(s.pureQa || docOnly || hasOnlyDocFaces)
  if (!hasValidBasis) {
    addUnique(rejectedCodeSignals, faces.length === 0 ? 'emptyFaces' : `mixedFaces:${faces.join(',')}`)
  }

  const pathsVerifiedDocOnly = Boolean(s.pathsVerifiedDocOnly)
  const passed = rejectedCodeSignals.length === 0 && pathsVerifiedDocOnly && hasValidBasis
  const matchedDocTargets = [...(s.matchedDocTargets ?? [])]

  let whyPureDocs = ''
  if (!passed) {
    whyPureDocs = `纯文档自检拦截：检测到非纯文档信号（${rejectedCodeSignals.join(', ') || '非纯文档路径'}），禁止放行 Case 1。`
  } else if (kind === 'pure-qa') {
    whyPureDocs = '属于纯粹概念解释或问答，未包含代码修改动词、运行时缺陷信号或待改代码路径。'
  } else if (kind === 'explicit-doc-only') {
    whyPureDocs = '调用方显式指定 docOnly，且经核验未包含代码符号、缺陷信号或非文档改动路径。'
  } else {
    const targetSummary = matchedDocTargets.length > 0 ? matchedDocTargets.join(', ') : '纯文档说明'
    whyPureDocs = `明确指向纯文档（${targetSummary}），且未检测到代码符号、缺陷信号或非文档改动路径。`
  }

  return {
    passed,
    kind,
    whyPureDocs,
    matchedDocTargets,
    rejectedCodeSignals,
    pathsVerifiedDocOnly,
  }
}
