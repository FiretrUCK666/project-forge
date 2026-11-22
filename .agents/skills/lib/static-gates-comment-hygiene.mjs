/**
 * static-gates-comment-hygiene.mjs —— 注释内反引号路径保鲜检查（严格复用词法去噪，零误报基线棘轮）。
 *
 * 复用 `static-gates-lexer.mjs` 提取注释视图，过滤代码块围栏、字符串字面量、URL、glob、正则与占位示例；
 * 支持仅校验新增/变更文件并对比 `HEAD` 基线棘轮（只拦本次新引入的失效路径，零存量误报）。
 */

import { existsSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'

import { isInsideDir, posixPath } from './git.mjs'
import { buildLexedViews } from './static-gates-lexer.mjs'

const BACKTICK_SPAN_RE = /`([^`\n]{2,140})`/g
const PATH_LINE_ANCHOR_RE = /(?::\d+(?:-\d+)?|#L\d+(?:-L\d+)?)$/
const CODE_OR_DOC_EXT_RE = /\.(?:m?[jt]sx?|cjs|py|rs|go|java|rb|php|cs|dart|swift|ex|exs|md|json|ya?ml|sh|sql|css|html)$/i
const KNOWN_DIR_PREFIX_RE = /^(?:\.agents|\.github|docs|kit|scripts|templates|references|src|lib|app|packages|tests?|spec)\//i
const PLACEHOLDER_PATH_RE = /^(?:path\/to|your[-_]|example|foo|bar|baz|tmp|var|etc|usr|opt)\b/i
const VIRTUAL_PREFIX_RE = /^(?:\.?git\/|\.worktrees\/|node_modules\/|dist\/|build\/|docs\/adr\/|node:)/i
const DOMAIN_LIKE_RE = /^[a-z0-9-]+\.(?:com|org|net|io|dev|edu|gov)\//i

function normalizeCommentPathToken(raw) {
  let token = String(raw ?? '').trim()
  if (!token || /[\s*?<>{}[\]()$@|=,;^\\]/.test(token)) return null
  if (token.includes('://') || token.startsWith('mailto:') || token.startsWith('/')) return null
  if (token.startsWith('--') || token.includes('..')) return null
  token = token.replace(PATH_LINE_ANCHOR_RE, '').replace(/^\.\//, '')
  if (!token || !token.includes('/')) return null
  if (VIRTUAL_PREFIX_RE.test(token) || PLACEHOLDER_PATH_RE.test(token) || DOMAIN_LIKE_RE.test(token)) return null
  if (token.endsWith('/')) {
    return KNOWN_DIR_PREFIX_RE.test(token) ? token.replace(/\/+$/, '') : null
  }
  if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(token)) return null
  if (!CODE_OR_DOC_EXT_RE.test(token) && !KNOWN_DIR_PREFIX_RE.test(token)) return null
  return token
}

/** 从源码注释中提取受检反引号仓库路径引用（已屏蔽围栏代码块与字符串字面量）。 */
export function extractCommentBacktickPaths(text, ext = '') {
  const views = buildLexedViews(String(text ?? ''), ext)
  const refs = []
  let inFence = false
  for (let i = 0; i < views.commentLines.length; i += 1) {
    const comment = views.commentLines[i]
    if (!comment) continue
    const trimmed = comment.replace(/^\s*\*?\s?/, '')
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    BACKTICK_SPAN_RE.lastIndex = 0
    let m
    while ((m = BACKTICK_SPAN_RE.exec(comment)) !== null) {
      const normalized = normalizeCommentPathToken(m[1])
      if (normalized) refs.push({ line: i + 1, path: normalized, raw: m[1] })
    }
  }
  return refs
}

function commentPathExists(repoRoot, fileRel, cleanPath) {
  const absRepoTarget = resolve(repoRoot, cleanPath)
  if (isInsideDir(absRepoTarget, repoRoot) && existsSync(absRepoTarget)) return true

  const fileDir = posix.dirname(posixPath(fileRel))
  if (fileDir && fileDir !== '.') {
    const absRelTarget = resolve(dirname(resolve(repoRoot, fileRel)), cleanPath)
    if (isInsideDir(absRelTarget, repoRoot) && existsSync(absRelTarget)) return true
  }

  if (cleanPath.startsWith('.agents/skills/')) {
    const kitEquiv = `kit/skills/${cleanPath.slice('.agents/skills/'.length)}`
    if (existsSync(resolve(repoRoot, kitEquiv))) return true
  }
  return false
}

/**
 * 扫描单个文件的注释反引号失效路径；传入 `headText` 时启用基线棘轮，
 * 仅上报本次新增的失效路径，确保对历史存量零误报。
 */
export function scanBrokenCommentPaths({ repoRoot, fileRel, text, headText = null }) {
  const rel = posixPath(fileRel)
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const currentRefs = extractCommentBacktickPaths(text, ext)
  if (currentRefs.length === 0) return []

  const headBroken = new Set()
  if (typeof headText === 'string' && headText.length > 0) {
    for (const ref of extractCommentBacktickPaths(headText, ext)) {
      if (!commentPathExists(repoRoot, rel, ref.path)) headBroken.add(ref.path)
    }
  }

  const broken = []
  const seenLinePath = new Set()
  for (const ref of currentRefs) {
    if (headBroken.has(ref.path)) continue
    if (commentPathExists(repoRoot, rel, ref.path)) continue
    const key = `${ref.line}:${ref.path}`
    if (seenLinePath.has(key)) continue
    seenLinePath.add(key)
    broken.push({ file: rel, line: ref.line, path: ref.path, raw: ref.raw })
  }
  return broken
}

const GENERATED_HEADER_RE = /(?:^|\s)@generated\b|\bauto-?generated\b|\bautomatically\s+generated\b|\bmachine[- ]generated\b|\bcode\s+generated\b[^\n]*\bdo\s+not\s+edit\b|\bdo\s+not\s+edit\b[^\n]*\bgenerated\b|\bDO NOT EDIT\b|^\s*do\s+not\s+edit(?:\s*[.!:-]|$)/i
const GENERATED_CASE_SENSITIVE_DO_NOT_EDIT = /\bDO NOT EDIT\b/

/**
 * 识别跨语言自动生成源码头标（必须位于前 20 行真实注释头部，严禁被字符串字面量或文件尾部注释伪装）。
 */
export function isGeneratedSourceHeader(text, ext = '') {
  const raw = String(text ?? '')
  if (!raw) return false
  const head20 = raw.replace(/\r\n/g, '\n').split('\n').slice(0, 20).join('\n')
  const views = buildLexedViews(head20, String(ext ?? '').toLowerCase())
  for (let i = 0; i < views.commentLines.length; i += 1) {
    const comment = String(views.commentLines[i] ?? '').trim()
    if (!comment) continue
    if (GENERATED_CASE_SENSITIVE_DO_NOT_EDIT.test(comment)) return true
    if (/\bdo\s+not\s+edit\b/i.test(comment) && !/^\s*do\s+not\s+edit(?:\s*[.!:-]|$)|\bgenerated\b/i.test(comment)) {
      continue
    }
    if (GENERATED_HEADER_RE.test(comment)) return true
  }
  return false
}

const CONTROL_FLOW_TOKEN_RE = /\b(?:if|else|for|while|do|switch|case|try|catch|finally|throw|return|yield|await|break|continue|goto|match|select|when|elif|except|raise|loop|defer|function|class|def|fn|func|lambda|proc|sub|impl)\b/g
const LITERAL_PLACEHOLDER_OR_VAL_RE = /['"`/]|-?\d+|(?:\b(?:true|false|null|nil|None|undefined)\b)|[{}\[\]]/

/**
 * 基于词法剥离后的纯代码结构识别纯声明式数据源码（如路由表、i18n 字典、规则表），
 * 防止把混杂业务逻辑或大段注释垫行数的神文件误放行。
 */
export function classifyDeclarativeDataFile({ fullText, ext = '', fullLineCount = 0, warnLines = 800 }) {
  if (!fullText || typeof fullText !== 'string' || fullLineCount <= warnLines) return null
  const extNorm = String(ext ?? '').toLowerCase()
  const views = buildLexedViews(fullText, extNorm)
  const codeNoLit = views.codeNoLiteralLines

  let nonEmptyCodeCount = 0
  let controlFlowCount = 0
  let depth = 0
  let nestedDataLines = 0
  let literalEntryLines = 0
  let topLevelDeclCount = 0

  for (let i = 0; i < codeNoLit.length; i += 1) {
    const line = String(codeNoLit[i] ?? '').trim()
    if (!line) continue
    nonEmptyCodeCount += 1

    const cfMatches = line.match(CONTROL_FLOW_TOKEN_RE)
    if (cfMatches) controlFlowCount += cfMatches.length
    if (extNorm !== 'php' && /=>/.test(line)) controlFlowCount += 1
    if (/\bnew\s+[A-Z]/.test(line)) controlFlowCount += 1

    const depthBefore = depth
    for (const ch of line) {
      if (ch === '{' || ch === '[') depth += 1
      else if ((ch === '}' || ch === ']') && depth > 0) depth -= 1
    }

    const isNested = depthBefore > 0 || depth > 0
    if (isNested) nestedDataLines += 1
    else if (/^(?:export\b|const\b|let\b|var\b|pub\b|static\b|[A-Za-z_][A-Za-z0-9_]*\s*=)/.test(line)) {
      topLevelDeclCount += 1
    }

    const isEntryLike = isNested
      ? (/^(?:['"`][^'"`]*['"`]|[A-Za-z0-9_$-]+)\s*[:=]/.test(line)
        || LITERAL_PLACEHOLDER_OR_VAL_RE.test(line))
      : (/^\s*(?:export\s+(?:default\s+)?)?(?:const|let|var|pub\s+static|static|final)\b.*[{\[]/.test(line)
        || /^[}\])]+[,;]?$/.test(line))
    if (isEntryLike) literalEntryLines += 1
  }

  // 反注释垫行绕过：真实代码行必须达到全文件相当比例且有足够规模
  if (nonEmptyCodeCount < Math.max(200, Math.floor(fullLineCount * 0.5))) return null
  // 混杂业务逻辑/控制流/箭头函数的文件绝不降级
  if (controlFlowCount > 0) return null

  const nestedRatio = nestedDataLines / nonEmptyCodeCount
  const literalRatio = Number((literalEntryLines / nonEmptyCodeCount).toFixed(3))
  // 必须大部分行位于数据字面量结构内（避免把 820 条顶层 `export const k0 = 0` 误判成表驱动文件）
  if (nestedRatio < 0.7 || literalRatio < 0.65 || topLevelDeclCount > Math.max(30, Math.floor(nonEmptyCodeCount * 0.1))) {
    return null
  }
  return { lines: fullLineCount, literalRatio, controlFlowCount }
}
