/**
 * static-gates-comment-hygiene.mjs —— 注释内反引号路径保鲜检查（严格复用词法去噪，零误报基线棘轮）。
 *
 * 复用 `static-gates-lexer.mjs` 提取注释视图，过滤代码块围栏、字符串字面量、URL、glob、正则与占位示例；
 * 支持仅校验新增/变更文件并对比 `HEAD` 基线棘轮（只拦本次新引入的失效路径，零存量误报）。
 */

import { existsSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'

import { matchGlob } from './git-core.mjs'
import { isInsideDir, posixPath } from './git.mjs'
import { CHANGELOG_VOICE_TOMBSTONE_RE } from './no-changelog-voice.mjs'
import { buildLexedViews, detectCommentedDeadCodeBlocks } from './static-gates-lexer.mjs'
import { extractSymbols } from './symbol-index.mjs'

export const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|src\/test|src\/it)\/|(?:\.(?:test|spec)\.[^/]+$)|_test\.[^/]+$|(?:^|\/)test_[^/]+\.py$|(?:Tests?|IT)\.(?:java|kt|cs|swift)$|_unittest\.(?:cc|cpp)$|\.Tests\//i
export const FIXTURE_FILE_RE = /(?:^|\/)(?:fixtures?|__fixtures__|testdata|__mocks__)\/|(?:\.(?:fixtures?|mocks?|testdata)\.[^/]+$)|(?:^|\/)fixtures(?:-[^/]+)?\.[^/]+$|(?:^|\/)injections-data(?:-[^/]+)?\.[^/]+$/i

export function isTestOrFixtureFile(rel) {
  const p = posixPath(rel)
  return TEST_FILE_RE.test(p) || FIXTURE_FILE_RE.test(p)
}

export const TOMBSTONE_COMMENT_RE = CHANGELOG_VOICE_TOMBSTONE_RE
export const TOMBSTONE_DATE_RE = /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s*(?:fixed|changed|updated|migrated|removed|replaced|修复|改为|改成|迁移|删除|替换)/i
export const EXCUSE_COMMENT_RE = /@(?:ts-ignore|ts-nocheck)|eslint-disable(?:-next-line|-line)?|\bnoqa\b|type:\s*ignore\b|pragma\s+warning\s+disable|\b(?:hack|workaround)\b/i
export const EXCUSE_TEMP_RE = /\bTEMP\b/
export const EXCUSE_HACK_RE = /\b(?:hack|workaround)\b|\bTEMP\b/i
export const ISSUE_REF_RE = /(?:issue\s*#\d+|#\d+\b|https?:\/\/[^\s)]+\/issues\/\d+)/i
export const RUST_ALLOW_RE = /^\s*#\[\s*allow\(/
export const JUSTIFICATION_ANCHOR_RE = /\b(?:pf-allow|justification|justified-by|issue\s*#\d+)\s*[:：]/i
export const NEAR_LIMIT_LINES = 730

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

const GENERATED_HEADER_RE = /(?:^|\s)@generated\b|\bauto-?generated\b|\bautomatically\s+generated\b|\bmachine[- ]generated\b|\bcode\s+generated\s+by\b|\bgenerated\s+by\b|\bDO NOT EDIT\b|^\s*do\s+not\s+edit(?:\s*[.!:-]|$)|(?:protobuf|protocol\s+buffer|openapi|swagger|graphql|prisma)\b[^\n]*\bgenerated\b|\bgenerated\b[^\n]*\b(?:protobuf|protocol\s+buffer|openapi|swagger|graphql|prisma)\b/i
const GENERATED_CASE_SENSITIVE_DO_NOT_EDIT = /\bDO NOT EDIT\b/

function matchesGeneratedCommentText(comment) {
  if (!comment) return false
  if (GENERATED_CASE_SENSITIVE_DO_NOT_EDIT.test(comment)) return true
  if (/\bdo\s+not\s+edit\b/i.test(comment) && !/^\s*do\s+not\s+edit(?:\s*[.!:-]|$)|\bgenerated\b/i.test(comment)) {
    return false
  }
  return GENERATED_HEADER_RE.test(comment)
}

/**
 * 识别跨语言自动生成源码头标（必须位于前 25 行真实注释头部，严禁被字符串字面量或文件尾部注释伪装）。
 */
export function isGeneratedSourceHeader(text, ext = '') {
  const raw = String(text ?? '')
  if (!raw) return false
  const extNorm = String(ext ?? '').toLowerCase()
  const head25Lines = raw.replace(/\r\n/g, '\n').split('\n').slice(0, 25)
  const views = buildLexedViews(head25Lines.join('\n'), extNorm)
  for (let i = 0; i < views.commentLines.length; i += 1) {
    const comment = String(views.commentLines[i] ?? '').trim()
    if (matchesGeneratedCommentText(comment)) return true
  }
  if (extNorm === 'sql' || extNorm === 'lua' || extNorm === 'hs') {
    for (const line of head25Lines) {
      const m = /^\s*--(.*)$/.exec(line)
      if (m && matchesGeneratedCommentText(m[1].trim())) return true
    }
  }
  return false
}

/**
 * 解析 `.gitattributes` 中的 `linguist-generated` 声明（按 gitattributes 末条命中优先）。
 */
export function isGitAttributesGenerated(gitAttributesText, fileRel) {
  const raw = String(gitAttributesText ?? '')
  const rel = posixPath(fileRel).replace(/^\.\//, '').replace(/^\/+/, '')
  if (!raw || !rel) return false
  const base = posix.basename(rel)
  let matchedGenerated = false
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const tokens = trimmed.split(/\s+/)
    if (tokens.length < 2) continue
    const pat = posixPath(tokens[0]).replace(/^\.\//, '').replace(/^\/+/, '')
    if (!pat) continue
    let attrState = null
    for (const attr of tokens.slice(1)) {
      if (attr === 'linguist-generated' || attr === 'linguist-generated=true') attrState = true
      else if (attr === '-linguist-generated' || attr === 'linguist-generated=false') attrState = false
    }
    if (attrState === null) continue
    const hit = pat.includes('/')
      ? matchGlob(rel, pat)
      : (matchGlob(base, pat) || matchGlob(rel, `**/${pat}`))
    if (hit) matchedGenerated = attrState
  }
  return matchedGenerated
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

const DOC_OVERSIZED_EXT_RE = /^(?:md|mdx|rst|txt)$/i
const TYPE_DECL_FILE_RE = /\.(?:d\.[cm]?ts|pyi|proto|graphql|gql)$/i
const TYPE_CONTRACT_EXT_RE = /^(?:ts|mts|cts|tsx|rs|go|java|kt|kts|cs|swift|py)$/i
const SQL_DDL_RE = /\b(?:CREATE|ALTER|DROP|TRUNCATE|INSERT|COMMENT|GRANT|TABLE|INDEX|VIEW|SCHEMA|TYPE|CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY)\b/i
const TYPE_DEF_KEYWORD_RE = /\b(?:interface|type|enum|struct|record|protocol|typedef)\b/
const RUNTIME_ARROW_DECL_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+[^:=]+=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/

function classifyTypeContractOrDdl({ fileRel, fullText, extNorm, fullLineCount }) {
  if (TYPE_DECL_FILE_RE.test(fileRel)) return 'type-declaration-file'
  if (extNorm === 'sql') {
    return SQL_DDL_RE.test(fullText) ? 'sql-ddl-or-migration' : null
  }
  if (!fullText || !TYPE_CONTRACT_EXT_RE.test(extNorm)) return null
  const views = buildLexedViews(fullText, extNorm)
  let nonEmpty = 0
  for (const rawLine of views.codeNoLiteralLines) {
    const line = String(rawLine ?? '').trim()
    if (!line) continue
    nonEmpty += 1
    const lineNoPropKeys = line.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\??\s*:/g, ':')
    CONTROL_FLOW_TOKEN_RE.lastIndex = 0
    if (CONTROL_FLOW_TOKEN_RE.test(lineNoPropKeys)) { CONTROL_FLOW_TOKEN_RE.lastIndex = 0; return null }
    if (/=>\s*\{/.test(line) || RUNTIME_ARROW_DECL_RE.test(line) || /\bnew\s+[A-Z]/.test(line)) return null
  }
  if (nonEmpty < Math.min(20, Math.floor(fullLineCount * 0.25))) return null
  if (!TYPE_DEF_KEYWORD_RE.test(views.codeNoLiteralsText)) return null
  return 'pure-type-contract'
}

/**
 * 零配置自适应超限文件分类器：自动识别并降级 `doc`、`generated`（含 `.gitattributes` 与前 25 行头标）、
 * `declarative-data` 与 `type-contract-or-ddl`，无需人工白名单或锁定特定文档文件名。
 */
export function classifyOversizedFile({
  fileRel = '', fullText = '', ext = '', fullLineCount = 0, warnLines = 800, gitAttributesText = '',
} = {}) {
  const rel = posixPath(fileRel).replace(/^\.\//, '')
  const extNorm = String(ext || rel.split('.').pop() || '').toLowerCase()
  const lineCount = Number(fullLineCount) || 0
  if (lineCount <= warnLines) return null

  if (DOC_OVERSIZED_EXT_RE.test(extNorm)) {
    return { category: 'doc', downgrade: true, lines: lineCount, reason: 'documentation-file' }
  }
  if (isGitAttributesGenerated(gitAttributesText, rel)) {
    return { category: 'generated', downgrade: true, lines: lineCount, reason: 'gitattributes-linguist-generated' }
  }
  if (fullText && isGeneratedSourceHeader(fullText, extNorm)) {
    return { category: 'generated', downgrade: true, lines: lineCount, reason: 'generated-header' }
  }
  const decl = classifyDeclarativeDataFile({ fullText, ext: extNorm, fullLineCount: lineCount, warnLines })
  if (decl) {
    return { category: 'declarative-data', downgrade: true, ...decl, reason: 'declarative-data-table' }
  }
  const typeReason = classifyTypeContractOrDdl({ fileRel: rel, fullText, extNorm, fullLineCount: lineCount })
  if (typeReason) {
    return { category: 'type-contract-or-ddl', downgrade: true, lines: lineCount, reason: typeReason }
  }
  return { category: 'code', downgrade: false, lines: lineCount, reason: 'executable-code' }
}

const EXEMPT_NONE_RE = /^(?:none|null|n\/a|不适用|无|-)$/i

function extractOversizedPatternsFromAgents(agentsText) {
  if (typeof agentsText !== 'string' || !agentsText) return []
  const lines = agentsText.replace(/\r\n/g, '\n').split('\n')
  const patterns = []
  let inTradeoffs = false
  for (const line of lines) {
    if (/^##\s+取舍(?:\s|$|[（(:：])/.test(line.trim())) { inTradeoffs = true; continue }
    if (inTradeoffs && /^#{1,2}\s+/.test(line)) break
    if (!inTradeoffs) continue
    const m = /^\s*(?:[-*]\s*)?`?oversized-allow`?\s*[:：]\s*(.+)$/.exec(line)
    if (!m) continue
    const val = m[1].split(/[（(]/)[0].trim()
    for (const seg of val.split(/[,，\s]+/)) {
      const clean = seg.trim().replace(/^`+|`+$/g, '')
      if (clean && !EXEMPT_NONE_RE.test(clean)) patterns.push(clean)
    }
  }
  return patterns
}

function extractOversizedPatternsFromHooks(forgeHooksConfig) {
  if (!forgeHooksConfig || typeof forgeHooksConfig !== 'object') return []
  const raw = forgeHooksConfig['oversized-allow'] ?? forgeHooksConfig.oversizedAllow
  if (!raw) return []
  const out = []
  const pushPat = (p) => {
    const clean = String(p ?? '').trim().replace(/^`+|`+$/g, '')
    if (clean && !EXEMPT_NONE_RE.test(clean)) out.push(clean)
  }
  if (typeof raw === 'string') {
    for (const seg of raw.split(/[,，\s]+/)) pushPat(seg)
  } else if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') pushPat(item)
      else if (item && typeof item === 'object') pushPat(item.pattern ?? item.file ?? item.glob)
    }
  }
  return out
}

/**
 * 解析经审查确认的窄范围超限架构豁免（仅读取 AGENTS.md「## 取舍」或 forge-hooks 配置，绝不读取源码行内自豁免注释）。
 */
export function resolveOversizedExemption({ fileRel = '', agentsText = null, forgeHooksConfig = null } = {}) {
  const rel = posixPath(fileRel).replace(/^\.\//, '')
  if (!rel) return { exempt: false }
  for (const pat of extractOversizedPatternsFromAgents(agentsText)) {
    if (matchGlob(rel, pat)) return { exempt: true, source: 'agents-tradeoffs', pattern: pat }
  }
  for (const pat of extractOversizedPatternsFromHooks(forgeHooksConfig)) {
    if (matchGlob(rel, pat)) return { exempt: true, source: 'forge-hooks', pattern: pat }
  }
  return { exempt: false }
}

/**
 * 为超限或紧文件生成确定性的语义拆分与同目录复用指引。
 */
export function buildSplitReuseGuidance({ fileRel = '', fullText = '', ext = '', siblingReuse = [] } = {}) {
  const rel = posixPath(fileRel).replace(/^\.\//, '')
  const extNorm = String(ext || rel.split('.').pop() || 'mjs').toLowerCase()
  const dir = posix.dirname(rel)
  const base = posix.basename(rel, `.${extNorm}`)
  const suggestedPathPattern = dir === '.' ? `${base}-<responsibility>.${extNorm}` : `${dir}/${base}-<responsibility>.${extNorm}`
  const sym = fullText ? extractSymbols(fullText, extNorm) : { supported: false, symbols: [] }
  const extractableSymbols = sym.supported ? sym.symbols.slice(0, 6) : []
  const parts = [`按单一职责拆分为语义模块（如 ${suggestedPathPattern}，禁止 -partN/-misc/-extra/-overflow/-rest 机械拆分）`]
  if (extractableSymbols.length > 0) parts.push(`可抽离导出/顶层符号：${extractableSymbols.join(', ')}`)
  if (siblingReuse.length > 0) {
    parts.push(`优先复用同目录模块：${siblingReuse.slice(0, 3).map((s) => `${s.file}(${s.symbols.slice(0, 3).join(',')})`).join(' | ')}`)
  }
  parts.push('若确有不可拆架构依据并经独立审查确认，由维护者在 AGENTS.md「## 取舍」或 .agents/forge-hooks.json 登记 oversized-allow')
  return { file: rel, suggestedPathPattern, extractableSymbols, fixHint: `${parts.join('；')}。` }
}

const MECHANICAL_SPLIT_NAME_RE = /(?:^|\/)[^/]+(?:-part\d+|-(?:misc|extra|part[a-z]))\.[^/]+$/i

/** 提示新增垃圾桶/机械分段文件名（如 `-part2.mjs`、`-misc.ts`，非阻断 warning，排除 REST/overflow 领域词）。 */
export function checkMechanicalSplitName(fileRel) {
  const rel = posixPath(fileRel).replace(/^\.\//, '')
  if (!rel || !MECHANICAL_SPLIT_NAME_RE.test(rel)) return null
  return {
    ruleId: 'edit.mechanical-split-name',
    defectClass: 'file-bloat',
    severity: 'medium',
    file: rel,
    line: 1,
    message: `检测到疑似机械分段/垃圾桶文件名（建议按职责命名，而非按序号或 misc 拆分）：${rel}`,
    fixHint: '按真实职责边界命名拆分模块（如 `<domain>-parser.mjs`），避免 `-partN`/`-misc`/`-extra` 后缀。',
  }
}

const JS_TS_IMPORT_EXT_RE = /\.(?:m?[jt]sx?|c[jt]s)$/i
const REL_IMPORT_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"](\.[^'"]+)['"]|\b(?:import|require)\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
const TYPE_ONLY_STMT_RE = /^\s*(?:import|export)\s+type\s+/

function extractLocalRelativeTargets(relFile, text, knownFilesSet) {
  const ext = posixPath(relFile).toLowerCase().split('.').pop() ?? ''
  const codeLines = buildLexedViews(String(text ?? ''), ext).codeLines
  const stripped = codeLines.join('\n')
  const curDir = posix.dirname(posixPath(relFile))
  const targets = []
  REL_IMPORT_RE.lastIndex = 0
  let m
  while ((m = REL_IMPORT_RE.exec(stripped)) !== null) {
    const stmt = m[0]
    if (TYPE_ONLY_STMT_RE.test(stmt)) continue
    const spec = (m[1] ?? m[2] ?? '').trim()
    if (!spec || !spec.startsWith('.')) continue
    const line = stripped.slice(0, m.index ?? 0).split('\n').length
    const base = posix.normalize(curDir === '.' ? spec : `${curDir}/${spec}`)
    const cands = [
      base, `${base}.mjs`, `${base}.js`, `${base}.ts`, `${base}.tsx`, `${base}.jsx`,
      `${base}.mts`, `${base}.cts`, `${base}.cjs`,
      `${base}/index.mjs`, `${base}/index.js`, `${base}/index.ts`, `${base}/index.tsx`,
    ]
    const resolved = cands.find((c) => knownFilesSet.has(c))
    if (resolved && resolved !== relFile) targets.push({ target: resolved, line, specifier: spec })
  }
  return targets
}

/** 解析变更 JS/TS 文件间本地相对导入，阻断新引入的 2 节点双向循环依赖（`A -> B -> A`）。 */
export function detectNewCircularImports({ changedFilesMap, baseTextMap = new Map() } = {}) {
  if (!(changedFilesMap instanceof Map) || changedFilesMap.size < 2) return []
  const jsFiles = [...changedFilesMap.keys()].filter((f) => JS_TS_IMPORT_EXT_RE.test(f)).sort()
  if (jsFiles.length < 2) return []
  const knownSet = new Set(jsFiles)
  const curEdges = new Map()
  for (const f of jsFiles) {
    const list = extractLocalRelativeTargets(f, changedFilesMap.get(f), knownSet)
    const map = new Map()
    for (const item of list) if (!map.has(item.target)) map.set(item.target, item)
    curEdges.set(f, map)
  }

  const baseEdges = new Map()
  const getBaseTargets = (f) => {
    if (baseEdges.has(f)) return baseEdges.get(f)
    const bt = baseTextMap.get(f)
    const set = bt ? new Set(extractLocalRelativeTargets(f, bt, knownSet).map((x) => x.target)) : new Set()
    baseEdges.set(f, set)
    return set
  }

  const blockers = []
  for (let i = 0; i < jsFiles.length; i += 1) {
    const a = jsFiles[i]
    const aMap = curEdges.get(a)
    for (let j = i + 1; j < jsFiles.length; j += 1) {
      const b = jsFiles[j]
      const bMap = curEdges.get(b)
      const ab = aMap.get(b)
      const ba = bMap.get(a)
      if (!ab || !ba) continue
      if (getBaseTargets(a).has(b) && getBaseTargets(b).has(a)) continue
      blockers.push({
        ruleId: 'edit.circular-import',
        defectClass: 'arch-boundary',
        severity: 'high',
        file: a,
        line: ab.line,
        peerFile: b,
        peerLine: ba.line,
        message: `检测到新引入的双向循环导入：${a}:${ab.line} <-> ${b}:${ba.line}`,
        fixHint: `将 ${a} 与 ${b} 的共享契约/原语下沉到独立底层模块，保持单向依赖，禁止拆出循环互导模块。`,
      })
    }
  }
  return blockers
}

function countLineMetrics(text, ext) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  let blankLines = 0
  let nonEmptyLines = 0
  for (const line of lines) {
    if (line.trim() === '') blankLines += 1
    else nonEmptyLines += 1
  }
  const views = buildLexedViews(normalized, ext)
  let semicolonJoins = 0
  for (const codeLine of views.codeNoLiteralLines) {
    if (!codeLine.includes(';') || /\bfor\s*\(/.test(codeLine)) continue
    const segs = codeLine.split(';').filter((s) => s.trim().length > 0).length
    if (segs >= 2) semicolonJoins += segs - 1
  }
  return { blankLines, nonEmptyLines, semicolonJoins }
}

/** 拦截对原 >730 行文件通过批量删空行或分号拼行制造的虚假缩行作弊。 */
export function detectLineSquashCheat({
  fileRel = '', ext = '', baseText = null, currentText = '', baseLineCount = 0, currentLineCount = 0,
} = {}) {
  const rel = posixPath(fileRel).replace(/^\.\//, '')
  if (!baseText || typeof baseText !== 'string' || baseLineCount <= 730 || currentLineCount >= baseLineCount) return null
  const extNorm = String(ext || rel.split('.').pop() || '').toLowerCase()
  const baseM = countLineMetrics(baseText, extNorm)
  const curM = countLineMetrics(currentText, extNorm)
  const blankLineDrop = baseM.blankLines - curM.blankLines
  const nonEmptyDrop = baseM.nonEmptyLines - curM.nonEmptyLines
  const semicolonJump = curM.semicolonJoins - baseM.semicolonJoins
  const wipedBlanksWithoutRefactor = blankLineDrop >= 25 && nonEmptyDrop < Math.max(15, Math.floor(blankLineDrop * 0.5))
  const squashedBySemicolon = semicolonJump >= 10
  if (!wipedBlanksWithoutRefactor && !squashedBySemicolon) return null
  return {
    ruleId: 'edit.line-squash-cheat',
    defectClass: 'file-bloat',
    severity: 'high',
    file: rel,
    line: 1,
    baseLines: baseLineCount,
    lines: currentLineCount,
    blankLineDrop,
    nonEmptyDrop,
    semicolonJump,
    message: `检测到对紧/大文件的虚假压行缩减（${baseLineCount} -> ${currentLineCount} 行，空行减少 ${blankLineDrop}，非空行净减 ${nonEmptyDrop}，分号拼行增量 +${semicolonJump}）：${rel}`,
    fixHint: '禁止通过批量删除空行或分号并句压低行数；请将真实职责拆分为独立内聚模块。',
  }
}

function scanSegmentHygiene({ rel, ext, rawLines, lineNumbers, isFixture, generatedExempt }) {
  const tombstoneComments = []
  const excuseSuppressions = []
  const views = buildLexedViews(rawLines.join('\n'), ext)
  const mapLine = (idx) => (Array.isArray(lineNumbers) && typeof lineNumbers[idx] === 'number' ? lineNumbers[idx] : idx + 1)
  if (!isFixture) {
    for (let i = 0; i < views.lines.length; i += 1) {
      const line = views.lines[i]
      const commentText = views.commentLines[i]
      if (!generatedExempt && commentText && (TOMBSTONE_COMMENT_RE.test(commentText) || TOMBSTONE_DATE_RE.test(commentText))) {
        tombstoneComments.push({ file: rel, line: mapLine(i), excerpt: line.trim().slice(0, 120) })
      }
      const hasJustify = JUSTIFICATION_ANCHOR_RE.test(commentText || line)
      const isHackLike = Boolean(commentText && EXCUSE_HACK_RE.test(commentText))
      const hasIssueRef = Boolean(commentText && ISSUE_REF_RE.test(commentText))
      if (!hasJustify && !(isHackLike && hasIssueRef) && ((commentText && (EXCUSE_COMMENT_RE.test(commentText) || EXCUSE_TEMP_RE.test(commentText))) || RUST_ALLOW_RE.test(views.codeNoLiteralLines[i]))) {
        excuseSuppressions.push({
          file: rel,
          line: mapLine(i),
          kind: isHackLike ? 'missing-issue-link' : 'suppression-bypass',
          excerpt: line.trim().slice(0, 120),
        })
      }
    }
  }
  const deadCodeBlocks = (isFixture || generatedExempt)
    ? []
    : detectCommentedDeadCodeBlocks(views).map((b) => ({
        file: rel,
        line: mapLine(b.startLine - 1),
        endLine: mapLine(b.endLine - 1),
        length: b.length,
        excerpt: b.excerpt,
      }))
  return { tombstoneComments, excuseSuppressions, deadCodeBlocks }
}

/** 扫描源码增行或按 hunk 独立扫描履历注释、借口压制、注释死代码、自动生成头标豁免、纯声明式/类型契约降级与大文件/紧文件指标。 */
export function scanStructuralHygiene({
  fileRel, lines = [], hunks = null, fullText = null, fullLineCount = 0,
  warnLines = 800, highLines = 1500, nearLimitLines = NEAR_LIMIT_LINES,
  skipFixtureCheck = false, gitAttributesText = '',
}) {
  const rel = posixPath(fileRel)
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const isFixture = FIXTURE_FILE_RE.test(rel)
  const rawJoined = Array.isArray(lines) ? lines.join('\n') : String(lines ?? '')
  const effectiveFullText = typeof fullText === 'string' && fullText.length > 0
    ? fullText
    : (Array.isArray(lines) && lines.length >= fullLineCount && lines.length > 0 ? rawJoined : '')
  const generatedExempt = Boolean(
    !rel.startsWith('kit/skills/') && (
      (gitAttributesText && isGitAttributesGenerated(gitAttributesText, rel))
      || (effectiveFullText && isGeneratedSourceHeader(effectiveFullText, ext))
    ),
  )

  const tombstoneComments = []
  const excuseSuppressions = []
  const deadCodeBlocks = []
  if (Array.isArray(hunks) && hunks.length > 0) {
    for (const hk of hunks) {
      const addedLines = Array.isArray(hk?.addedLines) && hk.addedLines.length > 0
        ? hk.addedLines
        : (Array.isArray(hk?.added) ? hk.added.map((text, idx) => ({ line: (hk.startLine ?? 1) + idx, text })) : [])
      if (addedLines.length === 0) continue
      const seg = scanSegmentHygiene({
        rel, ext,
        rawLines: addedLines.map((x) => x.text),
        lineNumbers: addedLines.map((x) => x.line),
        isFixture, generatedExempt,
      })
      tombstoneComments.push(...seg.tombstoneComments)
      excuseSuppressions.push(...seg.excuseSuppressions)
      deadCodeBlocks.push(...seg.deadCodeBlocks)
    }
  } else {
    const rawArr = Array.isArray(lines) ? lines : String(lines ?? '').replace(/\r\n/g, '\n').split('\n')
    const seg = scanSegmentHygiene({ rel, ext, rawLines: rawArr, lineNumbers: null, isFixture, generatedExempt })
    tombstoneComments.push(...seg.tombstoneComments)
    excuseSuppressions.push(...seg.excuseSuppressions)
    deadCodeBlocks.push(...seg.deadCodeBlocks)
  }

  const isCheckableSrc = (skipFixtureCheck || !isTestOrFixtureFile(rel)) && !rel.endsWith('.min.js') && !generatedExempt
  const oversizedClass = (isCheckableSrc && fullLineCount > warnLines)
    ? classifyOversizedFile({ fileRel: rel, fullText: effectiveFullText, ext, fullLineCount, warnLines, gitAttributesText })
    : null
  const declMeta = oversizedClass?.category === 'declarative-data'
    ? oversizedClass
    : (isCheckableSrc && fullLineCount > warnLines && effectiveFullText
      ? classifyDeclarativeDataFile({ fullText: effectiveFullText, ext, fullLineCount, warnLines })
      : null)
  const declarativeDataFile = declMeta ? { file: rel, ...declMeta } : null
  const downgraded = Boolean(oversizedClass?.downgrade) || Boolean(declarativeDataFile)
  const godFile = (isCheckableSrc && !downgraded && fullLineCount > warnLines)
    ? { file: rel, lines: fullLineCount, severity: fullLineCount > highLines ? 'high' : 'warn' }
    : null
  const nearLimitFile = (isCheckableSrc && !downgraded && fullLineCount >= nearLimitLines && fullLineCount <= warnLines)
    ? { file: rel, lines: fullLineCount, limit: warnLines }
    : null
  return { generatedExempt, oversizedClass, declarativeDataFile, tombstoneComments, excuseSuppressions, deadCodeBlocks, godFile, nearLimitFile }
}

/** 统一单源静态卫生评估入口（供 dev-edit、dev-review、dev-govern 共用，严格单向无环）。 */
export function evaluateFileHygiene({
  fileRel, lines = [], hunks = null, fullText = null, fullLineCount = 0,
  warnLines = 800, highLines = 1500, nearLimitLines = NEAR_LIMIT_LINES,
  skipFixtureCheck = false, gitAttributesText = '', agentsText = null, forgeHooksConfig = null,
} = {}) {
  const hyg = scanStructuralHygiene({
    fileRel, lines, hunks, fullText, fullLineCount,
    warnLines, highLines, nearLimitLines, skipFixtureCheck, gitAttributesText,
  })
  const oversizedExempt = hyg.godFile
    ? resolveOversizedExemption({ fileRel, agentsText, forgeHooksConfig })
    : { exempt: false }
  return { ...hyg, oversizedExempt }
}
