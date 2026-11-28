/**
 * static-gates.mjs —— 统一静态门禁内核：词法注释剥离、arch-rules、门型评估、门禁弱化与卫生扫描。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-flow、dev-review、dev-govern 共用，
 * 彻底消除各技能脚本间多套判据分叉。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { CODE_EXT_RE, matchGlob } from './git-core.mjs'
import { gitRun, gitRunBuffer, posixPath, readTextSafe, unescapeGitPath } from './git.mjs'
import { extractImportsForArch, resolveGoModules } from './import-graph.mjs'
import { isUiVisualFileCandidate } from './empirical-artifacts.mjs'
import { CHANGELOG_VOICE_TOMBSTONE_RE } from './no-changelog-voice.mjs'
import {
  classifyDeclarativeDataFile, classifyOversizedFile, isGeneratedSourceHeader, isGitAttributesGenerated,
} from './static-gates-comment-hygiene.mjs'
import { hasBehavioralAssertion as _hasBehavioralAssertion } from './static-gates-assertions.mjs'

export { CODE_EXT_RE, matchGlob }
import {
  computePatchRawDigest, getCachedCommitDiff, getCachedEntriesDiffText, parseRawAndUnifiedDiff,
  readHeadFast, resolveGitDirFast, resolveRefShaFast, setCachedCommitDiff,
} from './git-fast.mjs'
import { DEFAULT_HIGH_RISK_PATHS, hasHumanMergeAuthority, parseArchRuleItem } from './profile.mjs'
import {
  buildLexedViews, checkProcessArtifactFilename, detectCommentedDeadCodeBlocks,
  extractLineCommentInfo, findProcessArtifactFilenameViolations, HARD_SLEEP_RULES,
  isRustLifetimeAt, looksLikeCommentedCode, maskLiteralsInCodeLine, MOCK_SETUP_RE,
  MOCK_SPY_ASSERT_RE, PROCESS_ARTIFACT_EXCLUDED_DIR_RE, PROCESS_ARTIFACT_FILENAME_RE,
  scanTestAntiCheat, stripCodeCommentsLines,
} from './static-gates-lexer.mjs'

export {
  buildLexedViews, checkProcessArtifactFilename, detectCommentedDeadCodeBlocks,
  extractLineCommentInfo, findProcessArtifactFilenameViolations, HARD_SLEEP_RULES,
  isRustLifetimeAt, looksLikeCommentedCode, maskLiteralsInCodeLine, MOCK_SETUP_RE,
  MOCK_SPY_ASSERT_RE, PROCESS_ARTIFACT_EXCLUDED_DIR_RE, PROCESS_ARTIFACT_FILENAME_RE,
  scanTestAntiCheat, stripCodeCommentsLines,
}

export const PACKAGE_LOCKFILES = Object.freeze([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum',
  'gradle.lockfile', 'packages.lock.json', 'Gemfile.lock', 'composer.lock', 'flake.lock', 'Package.resolved',
])

export const LOCKFILE_NAMES = new Set(PACKAGE_LOCKFILES.map((n) => n.toLowerCase()))

export const TEST_FILE_RE = /(?:^|\/)(?:test|tests|__tests__|spec|specs|e2e|src\/test|src\/it)\/|(?:\.(?:test|spec)\.[^/]+$)|_test\.[^/]+$|(?:^|\/)test_[^/]+\.py$|(?:Tests?|IT)\.(?:java|kt|cs|swift)$|_unittest\.(?:cc|cpp)$|\.Tests\//i
export const FIXTURE_FILE_RE = /(?:^|\/)(?:fixtures?|__fixtures__|testdata|__mocks__)\/|(?:\.(?:fixtures?|mocks?|testdata)\.[^/]+$)|(?:^|\/)fixtures(?:-[^/]+)?\.[^/]+$|(?:^|\/)injections-data(?:-[^/]+)?\.[^/]+$/i
export const UI_VISUAL_EXT_RE = new RegExp(
  `^(?!.*(?:${TEST_FILE_RE.source}|${FIXTURE_FILE_RE.source})).*\\.(?:tsx|jsx|vue|svelte|html|css|scss|svg)$`,
  'i',
)

export function isTestOrFixtureFile(rel) {
  const p = posixPath(rel)
  return TEST_FILE_RE.test(p) || FIXTURE_FILE_RE.test(p)
}

const RELEASE_NOTES_DIR_PREFIX = `${['docs', 'release-notes'].join('/')}/`

export function isReleaseNotesDocPath(rel) {
  const p = posixPath(rel)
  return p.startsWith(RELEASE_NOTES_DIR_PREFIX) && p.endsWith('.md')
}

export function isLegalArchiveMove(entry, deletedFiles = new Set(), ownArchived = new Set()) {
  const rel = posixPath(entry?.file ?? '')
  const st = String(entry?.status ?? '')
  if (isReleaseNotesDocPath(rel)) {
    return /^(?:AM?|\?\?)$/i.test(st)
  }
  if (!rel.startsWith('docs/archive/')) return false
  if (/^R/i.test(st)) return true
  if (/^(?:A|\?\?|M)/i.test(st)) {
    if (ownArchived.has(rel)) return true
    const origRel = rel.replace(/^docs\/archive\//, 'docs/')
    if (deletedFiles.has(origRel)) return true
  }
  return false
}

export function isUiVisualFile(fileRel, { repoRoot = null } = {}) {
  const p = posixPath(String(fileRel ?? '')).replace(/^\.\//, '')
  if (!p || isTestOrFixtureFile(p)) return false
  return isUiVisualFileCandidate(p, { repoRoot, uiExtMatch: UI_VISUAL_EXT_RE.test(p) })
}

export function isMetaTestHarness(fileRel, text = '') {
  const p = posixPath(String(fileRel ?? ''))
  if (FIXTURE_FILE_RE.test(p)) return true
  if (/(?:^|\/)(?:test-?harness|test-?generator|meta-?test)\.[^/]+$/i.test(p)) return true
  return /\bfunction\s+(?:tmpProject|createTempRepo|createTempProject)\s*\(/.test(String(text ?? ''))
    || /\bexport\s+function\s+register\w*Cases\s*\(/.test(String(text ?? ''))
}

export const GATE_WORKFLOW_FILE_RE = /(?:^|\/)(?:\.github\/(?:workflows|actions)\/[^/]+\.ya?ml|\.circleci\/config\.ya?ml|azure-pipelines\.ya?ml|Jenkinsfile)$/i
export const GATE_SHELL_OR_SCRIPT_RE = /(?:^|\/)(?:\.github\/(?:workflows|actions)\/[^/]+\.ya?ml|package\.json|Makefile|justfile|Taskfile\.ya?ml)$|\.(?:sh|bash|ps1)$/i
export const GATE_SKIP_RE = /(?:^|[^\w.])(?:(?:it|test|describe|context|suite)\.(?:skip|only)\s*\(|(?:xit|xdescribe|xtest|fit|fdescribe)\s*\(|@(?:pytest\.mark\.skip(?:if)?|unittest\.skip|Disabled|Ignore)\b|#\[\s*ignore\b|\bt\.Skip(?:f|Now)?\s*\(|\[(?:Fact|Theory)\s*\([^\)]*\bSkip\s*=)|\bDISABLED_[A-Za-z0-9_]+|\{\s*(?:skip|only)\s*:\s*true\b/
export const ASSERTION_RE = /\b(?:[Aa]ssert(?:\.\w+)?|[Ee]xpect|[Ss]hould|pytest\.raises|t\.(?:Error|Errorf|Fatal|Fatalf|Fail)|assert_(?:eq|ne|matches)?|[Aa]ssert(?:Equals?|NotEquals?|DeepEqual|NoError|Error|Contains|True|False|Throws|Null|NotNull|That)|strictEqual|deepStrictEqual|equal|notEqual|throws|rejects|match|XCTAssert\w*|EXPECT_[A-Z0-9_]+|ASSERT_[A-Z0-9_]+|REQUIRE|CHECK)\b\s*(?:\(|!|\.)|\b[Aa]ssert\s+/
const TAUT_ATOM = "(?:-?\\d+(?:\\.\\d+)?|'(?:[^'\\\\]|\\\\.)*'|\"(?:[^\"\\\\]|\\\\.)*\"|`(?:[^`\\\\]|\\\\.)*`|\\b(?:true|false|True|False|null|None|nil|undefined)\\b|[A-Za-z_$][A-Za-z0-9_$.]*)"
const TAUT_TRUTHY = "(?:true|True|[1-9]\\d*(?:\\.\\d+)?|0?\\.\\d*[1-9]\\d*|'(?:[^'\\\\]|\\\\.)+'|\"(?:[^\"\\\\]|\\\\.)+\"|`(?:[^`\\\\]|\\\\.)+`)"
export const TAUTOLOGY_ASSERT_RE = new RegExp([
  `\\bassert\\s+(?:True|true)\\b(?:\\s*(?:,|;|$))`,
  `\\bassert\\s*\\(\\s*${TAUT_TRUTHY}\\s*(?:,|\\))`,
  `\\bassert\\s*\\(?\\s*(${TAUT_ATOM})\\s*===?\\s*\\1\\s*\\)?\\s*(?:,|;|$)`,
  `\\bexpect\\s*\\(\\s*(${TAUT_ATOM})\\s*\\)\\s*\\.\\s*(?:toBe|toEqual|toStrictEqual|to\\.(?:be|equal|eql))\\s*\\(\\s*\\2\\s*(?:,|\\))`,
  `\\bexpect\\s*\\(\\s*${TAUT_TRUTHY}\\s*\\)\\s*\\.\\s*toBeTruthy\\s*\\(\\s*\\)`,
  `\\bassert\\.(?:ok|isTrue)\\s*\\(\\s*${TAUT_TRUTHY}\\s*(?:,|\\))`,
  `\\bassertTrue\\s*\\(\\s*${TAUT_TRUTHY}\\s*(?:,|\\))`,
  `\\bassert(?:Equal|Equals|StrictEqual|DeepEqual)\\s*\\(\\s*(?:[A-Za-z_$][A-Za-z0-9_$.]*\\s*,\\s*)?(${TAUT_ATOM})\\s*,\\s*\\3\\s*(?:,|\\))`,
  `\\bassert\\.(?:strictEqual|equal|deepStrictEqual|deepEqual)\\s*\\(\\s*(${TAUT_ATOM})\\s*,\\s*\\4\\s*(?:,|\\))`,
  `\\bassert_eq!\\s*\\(\\s*(${TAUT_ATOM})\\s*,\\s*\\5\\s*(?:,|\\))`,
].join('|'))
export const GATE_ASSERTION_RE = ASSERTION_RE
export function hasBehavioralAssertion(codeOnlyText, opts = {}) {
  return _hasBehavioralAssertion(codeOnlyText, { assertionRe: ASSERTION_RE, ...opts })
}
export const TEST_CASE_RE = /(?<![.\w$])(?:it|test|describe|context|suite)(?:\.(?:skip|only|todo))?\s*\(|(?<![.\w$])(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|\bdef\s+test_|#\[\s*test\s*\]|\bfunc\s+Test[A-Z]|@(?:Test|ParameterizedTest)\b|\[(?:Fact|Theory)\b/
export const TEST_SKIP_RE = GATE_SKIP_RE
export const GATE_CI_PERM_WRITE_RE = /\b(?:contents|id-token|packages|security-events|actions|pull-requests|checks|deployments|issues)\s*:\s*write\b/i
export const GATE_SHELL_BYPASS_RE = /(?:^|[\s;|&"'])\|\|\s*true(?:\s|$|["';&|])/

export const TOMBSTONE_COMMENT_RE = CHANGELOG_VOICE_TOMBSTONE_RE
export const TOMBSTONE_DATE_RE = /\b20\d{2}[-/]\d{1,2}[-/]\d{1,2}\s*(?:fixed|changed|updated|migrated|removed|replaced|修复|改为|改成|迁移|删除|替换)/i
export const EXCUSE_COMMENT_RE = /@(?:ts-ignore|ts-nocheck)|eslint-disable(?:-next-line|-line)?|\bnoqa\b|type:\s*ignore\b|pragma\s+warning\s+disable|\b(?:hack|workaround)\b/i
export const EXCUSE_TEMP_RE = /\bTEMP\b/
export const EXCUSE_HACK_RE = /\b(?:hack|workaround)\b|\bTEMP\b/i
export const ISSUE_REF_RE = /(?:issue\s*#\d+|#\d+\b|https?:\/\/[^\s)]+\/issues\/\d+)/i
export const RUST_ALLOW_RE = /^\s*#\[\s*allow\(/
export const JUSTIFICATION_ANCHOR_RE = /\b(?:pf-allow|justification|justified-by|issue\s*#\d+)\s*[:：]/i
export const NEAR_LIMIT_LINES = 730

/**
 * 统计文本行数：统一将 CRLF 转为 LF 并剥离末尾换行产生的空行，保证 799/800 行边界口径在全仓一致。
 */
export function countTextLines(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  if (normalized === '') return 0
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

export { extractImportsForArch, parseArchRuleItem, resolveGoModules }

/**
 * 依据 Dev Profile 中的 arch-rules（fromGlob -> toGlob）静态解析改动文件引用边界。
 */
export function evaluateArchRules(repoRoot, fileRelList = [], archRules = []) {
  const rules = (Array.isArray(archRules) ? archRules : []).map(parseArchRuleItem).filter(Boolean)
  if (rules.length === 0 || !Array.isArray(fileRelList) || fileRelList.length === 0) {
    return { ok: true, checkedFiles: 0, ruleCount: rules.length, violations: [] }
  }

  const goModules = resolveGoModules(repoRoot)
  const violations = []
  let checkedFiles = 0

  for (const rawFile of fileRelList) {
    const rel = posixPath(rawFile).replace(/^\.\//, '').replace(/^\/+/, '')
    if (!rel) continue
    const matchedRules = rules.filter((r) => matchGlob(rel, r.from))
    if (matchedRules.length === 0) continue

    const text = readTextSafe(join(repoRoot, rel))
    if (text === undefined) continue
    checkedFiles += 1
    const rawLines = text.split('\n')

    for (const imp of extractImportsForArch(rel, text, goModules)) {
      for (const rule of matchedRules) {
        const hit = imp.candidates.find((c) => matchGlob(c, rule.to))
        if (hit) {
          violations.push({
            file: rel,
            line: imp.line,
            rule: rule.raw,
            specifier: imp.specifier,
            target: hit,
            resolvedTarget: hit,
            lineText: (rawLines[imp.line - 1] ?? '').trim().slice(0, 120),
            message: `架构禁引违规 [${rule.raw}]：${rel}:${imp.line} 引用了 ${imp.specifier}（命中禁止目标 ${hit}）`,
            fixHint: `根因修法：勿让 ${rule.from} 直接依赖 ${rule.to}；请将公共契约/工具下沉至允许共享的基础层，或通过依赖注入反转依赖方向。`,
          })
        }
      }
    }
  }

  return { ok: violations.length === 0, checkedFiles, ruleCount: rules.length, violations }
}

/** 判定变更属于双向门（two-way，可逆）还是单向门（one-way，不可逆/触及边界与门禁）。 */
export function classifyDoorType({
  changedFiles = [],
  summary = '',
  touchesContract = false,
  highRisk = [],
  gateWeakened = false,
  doNotEdit = [],
  agentsText = '',
  task = null,
  diffBytes = 0,
  untrustedSurface = false,
} = {}) {
  const files = (Array.isArray(changedFiles) ? changedFiles : []).map((f) => posixPath(f).replace(/^\.\//, ''))
  const riskPatterns = [...new Set([...(Array.isArray(highRisk) ? highRisk : []), ...DEFAULT_HIGH_RISK_PATHS])]
  const signals = []

  if (gateWeakened) signals.push('检测到弱化/放宽测试或 CI 门禁检查（必须人工拍板）')
  if (highRisk === true) signals.push('已标记触碰高风险路径')
  const highRiskHits = files.filter((f) => riskPatterns.some((pat) => matchGlob(f, pat)))
  if (highRiskHits.length > 0) signals.push(`触碰高风险路径：${highRiskHits.slice(0, 5).join(', ')}`)
  if (touchesContract) signals.push('涉及跨模块或外部对外契约变更')
  if (task?.doorType === 'one-way') signals.push('任务元数据已声明 doorType=one-way')
  const humanAuth = hasHumanMergeAuthority(agentsText)
  if (humanAuth) {
    signals.push('AGENTS.md 声明了 merge-authority: human')
  }
  const doNotEditList = Array.isArray(doNotEdit) ? doNotEdit : []
  const protectedHits = files.filter((f) => doNotEditList.some((pat) => matchGlob(f, pat)))
  if (protectedHits.length > 0) signals.push(`触碰受保护 do-not-edit 路径：${protectedHits.slice(0, 5).join(', ')}`)

  const infraHits = files.filter((f) => /(?:^|\/)(?:migrations?|migrate)\/|\.sql$|^(?:SKILL\.md|LICENSE|package-lock\.json)$/i.test(f))
  if (infraHits.length > 0) signals.push(`触碰不可逆迁移或分发根契约：${infraHits.slice(0, 5).join(', ')}`)
  const summaryText = String(summary ?? '')
  if (/(?:breaking\s+change|外部契约|跨模块|数据迁移|schema\s*变更|数据库迁移|不可逆|权限模型|协议变更|弱化门禁|publish|release|改可见性)/i.test(summaryText)) {
    signals.push('任务语义涉及外部契约、权限、发布或不可逆数据迁移')
  }

  const isOneWay = signals.length > 0
  let blastRadius = 'low'
  if (gateWeakened || highRiskHits.length >= 2 || signals.length >= 2 || files.length >= 10 || diffBytes >= 40000) {
    blastRadius = 'high'
  } else if (isOneWay || highRiskHits.length === 1 || files.length >= 4) {
    blastRadius = 'medium'
  }
  const hasHumanAuth = Boolean(gateWeakened) || humanAuth || Boolean(untrustedSurface)
  const mergeAuthority = hasHumanAuth ? 'human-required' : ((isOneWay || highRiskHits.length > 0) ? 'reviewer-with-fault-injection' : 'reviewer-direct')

  return {
    doorType: isOneWay ? 'one-way' : 'two-way',
    requiresHumanApproval: Boolean(gateWeakened),
    signals,
    reasons: isOneWay ? signals : ['局部可逆改动（未触碰高风险路径、外部契约或门禁定义）'],
    reason: isOneWay ? signals.join('；') : '局部可逆改动（未触碰高风险路径、外部契约或门禁定义，可无损回滚）',
    blastRadius,
    mergeAuthority,
    rollbackPath: isOneWay
      ? '单向门回退：已合并远端须发反向提交或递增版本修复（禁止改写历史）；若含数据库/Schema 迁移须附带显式降级步骤；弱化门禁改动未获 --human-approved 前阻断合并。'
      : '双向门回退：未提交变更可直接重置工作区；已开分支未合并直接关闭 PR 并删除临时分支；已合入则一键 git revert。',
  }
}

/** 按文件切分 unified diff，安全解引用带空格或 C 引号路径。 */
export function splitDiffByFile(diffText) {
  const chunks = new Map()
  const lines = String(diffText ?? '').split('\n')
  let currentFile = null
  let buf = []
  const flush = () => {
    if (currentFile !== null) {
      const nextChunk = buf.join('\n')
      chunks.set(currentFile, chunks.has(currentFile) ? `${chunks.get(currentFile)}\n${nextChunk}` : nextChunk)
    }
  }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flush()
      const m = /^diff --git (?:"a\/([^"]+)"|a\/(.+?)) (?:"b\/([^"]+)"|b\/(.+))$/.exec(line)
      const rawB = m ? (m[3] !== undefined ? `"${m[3]}"` : m[4]) : null
      currentFile = rawB ? unescapeGitPath(rawB) : null
      buf = [line]
    } else if (currentFile !== null || buf.length > 0) {
      if (line.startsWith('+++ b/')) currentFile = unescapeGitPath(line.slice(6).trim())
      else if (line.startsWith('+++ "b/')) currentFile = unescapeGitPath(`"${line.slice(7).trim()}`)
      else if (line.startsWith('--- a/') && currentFile === null) currentFile = unescapeGitPath(line.slice(6).trim())
      buf.push(line)
    }
  }
  flush()
  return chunks
}

/** 提取单文件 diff 的增删行列表（支持可选 hunk 粒度拆分）。 */
export function summarizeHunkChanges(fileDiff) {
  const added = []
  const removed = []
  const hunks = []
  let curHunk = null
  for (const line of String(fileDiff ?? '').split('\n')) {
    if (line.startsWith('@@')) {
      if (curHunk) hunks.push(curHunk)
      curHunk = { header: line, added: [], removed: [] }
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      const body = line.slice(1)
      added.push(body)
      if (curHunk) curHunk.added.push(body)
    } else if (line.startsWith('-')) {
      const body = line.slice(1)
      removed.push(body)
      if (curHunk) curHunk.removed.push(body)
    }
  }
  if (curHunk) hunks.push(curHunk)
  return { added, removed, hunks }
}

const CI_VERIFY_CMD_RE = /\b(?:test|tests|spec|specs|lint|check|typecheck|tsc|eslint|flake8|mypy|ruff|clippy|vet|audit|verify|e2e|pytest|unittest|jest|vitest|mocha|ava|tap|cargo\s+(?:test|check|clippy)|go\s+(?:test|vet)|npm\s+(?:test|run\b)|pnpm\s+(?:test|lint|check|verify|run\b)|yarn\s+(?:test|lint|check|verify|run\b)|dotnet\s+test|mvn\b|mvnw\b|gradle\b|gradlew\b|ctest|meson\s+test|swift\s+test|dart\s+test|mix\s+test|bundle\s+exec\s+(?:rspec|rake)|make\s+(?:test|check|verify|lint)|just\s+(?:test|check|verify|lint)|task\s+(?:test|check|verify|lint)|node\s+(?:--test|\S+\.mjs))\b/i
const CI_VERIFY_STEP_NAME_RE = /\b(?:test|tests|check|checks|lint|verify|audit|gate|e2e|bench|preflight|门禁|自检|断言|体检|审计|测试|校验)\b/i
const CI_SHELL_BOILERPLATE_RE = /^(?:echo|printf|mkdir|cd|export|set|if|then|else|elif|fi|for|do|done|exit|return|true|false|rm|cp|mv|cat|\{|\}|#|$)/i

function splitNormalizeCiCommands(rawCmd) {
  const cleaned = String(rawCmd ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\|\|\s*\{[\s\S]*$/g, '')
  const out = []
  for (const part of cleaned.split(/\s*(?:&&|;)\s*/)) {
    const norm = part
      .trim()
      .replace(/\$\{\{\s*runner\.temp\s*\}\}[/\\]?/gi, '')
      .replace(/(?:\$RUNNER_TEMP|\$\{RUNNER_TEMP\}|\$TMPDIR|\$\{TMPDIR\})[/\\]?/g, '')
      .replace(/["']/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (norm && !CI_SHELL_BOILERPLATE_RE.test(norm)) out.push(norm)
  }
  return out
}

function extractCiCommands(rawLines) {
  const entries = []
  let runBlockIndent = -1
  let scriptArrayIndent = -1
  let curStepIndent = -1
  let curStepVerifyName = false

  const pushCmd = (raw, namedVerify) => {
    for (const norm of splitNormalizeCiCommands(raw)) {
      entries.push({ raw: String(raw).trim(), norm, namedVerify })
    }
  }

  for (const rawLine of rawLines) {
    const { codeText } = extractLineCommentInfo(rawLine, false, 'yml')
    const trimmed = codeText.trim()
    if (!trimmed) continue
    const indent = codeText.length - codeText.trimStart().length
    if (runBlockIndent >= 0 && indent <= runBlockIndent) runBlockIndent = -1
    if (scriptArrayIndent >= 0 && indent <= scriptArrayIndent) scriptArrayIndent = -1
    if (curStepIndent >= 0 && indent < curStepIndent) { curStepIndent = -1; curStepVerifyName = false }

    const nameM = /^-\s*name\s*:\s*(.+)$/i.exec(trimmed)
    if (nameM) {
      curStepIndent = indent
      curStepVerifyName = CI_VERIFY_STEP_NAME_RE.test(nameM[1])
      continue
    }
    if (/^(?:-\s*)?(?:run|script|command)\s*:\s*[|>][-+]?$/i.test(trimmed)) {
      runBlockIndent = indent
      continue
    }
    const inlineM = /^(?:-\s*)?(?:run|script|command)\s*:\s*(.+)$/i.exec(trimmed)
    if (inlineM) {
      pushCmd(inlineM[1], curStepVerifyName)
      continue
    }
    if (/^(?:-\s*)?script\s*:\s*$/i.test(trimmed)) {
      scriptArrayIndent = indent
      continue
    }
    if (scriptArrayIndent >= 0 && indent > scriptArrayIndent) {
      const itemM = /^-\s+(.+)$/.exec(trimmed)
      if (itemM) { pushCmd(itemM[1], curStepVerifyName); continue }
    }
    if (runBlockIndent >= 0 && indent > runBlockIndent) {
      pushCmd(trimmed, curStepVerifyName)
      continue
    }
    // Partial hunk inside an existing `run: |` block (header untouched in diff)
    if (!/^(?:-\s*)?[A-Za-z0-9_.-]+\s*:/.test(trimmed) && CI_VERIFY_CMD_RE.test(trimmed)) {
      pushCmd(trimmed, false)
    }
  }
  return entries
}

/** 统一单条目门禁弱化扫描（兼顾 deterministic 与测试断言减少检测）。 */
export function detectGateWeakeningInEntry({ file, status, added = [], removed = [], hunks = null }) {
  const hits = []
  const rel = posixPath(file)
  if (!rel || /\.mdx?$|\.txt$/i.test(rel)) return hits
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const isTest = TEST_FILE_RE.test(rel)
  const isWorkflow = GATE_WORKFLOW_FILE_RE.test(rel)
  const isScriptOrCi = GATE_SHELL_OR_SCRIPT_RE.test(rel)
  const isRegexLine = (l) => /^\s*(?:(?:export\s+)?(?:const|let|var)|if|else\s+if|return|\|\||&&|\?|:)\b.*\/[^/]+\//.test(l)

  if (status === 'D' && isTest) {
    hits.push({ type: 'deleted-test-file', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: `删除测试文件 ${rel}（直接削弱回归门禁）`, detail: `删除测试文件 ${rel}`, excerpt: [`- deleted ${rel}`] })
  }

  let inBlock = false
  let permIndent = -1
  let runBlockIndent = -1
  for (const line of added) {
    const { commentText, codeText, nextInBlock } = extractLineCommentInfo(line, inBlock, ext)
    inBlock = nextInBlock
    const trimmed = line.trim()

    if (isTest && codeText.trim() && GATE_SKIP_RE.test(codeText) && !isRegexLine(line)) {
      hits.push({ type: 'test-skip-or-only', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '新增测试 skip/only/ignore 跳过标记', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
    }
    if (isTest && codeText.trim() && TAUTOLOGY_ASSERT_RE.test(codeText) && !isRegexLine(line)) {
      hits.push({ type: 'tautology-assertion', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '新增恒真占位断言（tautology assertion）', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
    }

    if (isWorkflow) {
      const indent = line.length - line.trimStart().length
      if (runBlockIndent >= 0 && trimmed !== '' && !trimmed.startsWith('#') && indent <= runBlockIndent) runBlockIndent = -1
      const isRunHeader = /^(?:-\s*)?(?:run|script)\s*:\s*[|>][-+]?(?:\s+#.*)?$/i.test(trimmed)
      const isInlineRun = !isRunHeader && /^(?:-\s*)?(?:run|script)\s*:\s*\S/i.test(trimmed)
      if (isRunHeader) runBlockIndent = indent
      const inShellBody = (runBlockIndent >= 0 && indent > runBlockIndent) || isInlineRun
      if (!inShellBody) {
        if (permIndent >= 0 && trimmed !== '' && !trimmed.startsWith('#') && indent <= permIndent) permIndent = -1
        if (/^permissions\s*:/i.test(trimmed)) permIndent = indent
        if (!commentText || codeText.trim()) {
          if (/^\s*continue-on-error\s*:\s*true\b/i.test(codeText)) {
            hits.push({ type: 'ci-continue-on-error', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '工作流步骤设置 continue-on-error: true', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
          }
          if (/^\s*(?:-\s*)?if\s*:\s*(?:false\b|\$\{\{\s*false\s*\}\})/i.test(codeText)) {
            hits.push({ type: 'ci-disabled-step', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '工作流禁用检查步骤 (if: false)', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
          }
          if (/^\s*permissions\s*:\s*write-all\b|\bpull_request_target\b/i.test(codeText)
            || ((/^\s*permissions\s*:/i.test(codeText) || permIndent >= 0) && GATE_CI_PERM_WRITE_RE.test(codeText))) {
            hits.push({ type: 'ci-loosened-permissions', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '放宽 CI 工作流写权限或触发边界', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
          }
        }
      }
    }

    if (commentText && /(?:eslint-disable(?:-next-line)?|@ts-nocheck)\b/.test(commentText)) {
      hits.push({ type: 'error-suppression', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '新增静态检查屏蔽注释', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
    }

    const isEchoLine = /^\s*(?:echo|printf)\b/.test(trimmed)
    if (!isRegexLine(line) && !isEchoLine && codeText.trim()) {
      const hasBypassFlag = isScriptOrCi
        ? /--no-verify\b|--passWithNoTests\b/.test(codeText)
        : /\b(?:exec|spawn|run|gitRun)\w*\s*\([^)\n]*(?:--no-verify|--passWithNoTests)\b/.test(codeText)
      const hasOrTrue = (isScriptOrCi && GATE_SHELL_BYPASS_RE.test(codeText))
        || /\b(?:exec|spawn|execSync|execFileSync|run)\w*\s*\([^)\n]*\|\|\s*true\b/.test(codeText)
      if (hasBypassFlag || hasOrTrue) {
        hits.push({ type: 'shell-or-true', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: '新增校验旁路标记（--no-verify / || true）', detail: trimmed.slice(0, 120), excerpt: [`+ ${line}`] })
      }
    }
  }

  if (isWorkflow && removed.length > 0) {
    const removedVerify = extractCiCommands(removed).filter((c) => CI_VERIFY_CMD_RE.test(c.norm) || c.namedVerify)
    if (removedVerify.length > 0) {
      const addedCmdSet = new Set(extractCiCommands(added).map((c) => c.norm))
      const deletedSteps = removedVerify.filter((c) => !addedCmdSet.has(c.norm))
      if (deletedSteps.length > 0) {
        hits.push({ type: 'deleted-ci-step', category: 'gate-weakening', severity: 'deterministic', file: rel, reason: `删除 CI 验证步骤命令（${deletedSteps.slice(0, 2).map((d) => d.raw).join('; ')}）`, detail: deletedSteps[0].raw.slice(0, 120), excerpt: deletedSteps.slice(0, 4).map((d) => `- ${d.raw}`) })
      }
    }
  }

  if (isTest) {
    const hunkList = Array.isArray(hunks) && hunks.length > 0 ? hunks : [{ added, removed }]
    const hasAssertOrTest = (l) => {
      const info = extractLineCommentInfo(l, false, ext)
      return info.codeText.trim() && (hasBehavioralAssertion(info.codeText, { ext }) || TEST_CASE_RE.test(info.codeText))
    }
    const isEffectiveAddedAssert = (l) => {
      const info = extractLineCommentInfo(l, false, ext)
      const code = info.codeText.trim()
      if (!code || TAUTOLOGY_ASSERT_RE.test(code)) return false
      return hasBehavioralAssertion(code, { ext }) || TEST_CASE_RE.test(code)
    }
    for (const hk of hunkList) {
      const remAsserts = hk.removed.filter(hasAssertOrTest)
      const addAsserts = hk.added.filter(isEffectiveAddedAssert)
      if (remAsserts.length > addAsserts.length) {
        const netRemoved = remAsserts.length - addAsserts.length
        const removeRatio = remAsserts.length > 0 ? netRemoved / remAsserts.length : 0
        const severity = netRemoved >= 3 && removeRatio >= 0.5 ? 'deterministic' : 'advisory'
        hits.push({ type: 'deleted-assertion', category: 'gate-weakening', severity, file: rel, reason: `测试断言净减少（-${remAsserts.length} / +${addAsserts.length}）`, detail: `测试断言净减少（-${remAsserts.length} / +${addAsserts.length}）`, excerpt: remAsserts.slice(0, 4).map((l) => `- ${l}`) })
      }
    }
  }
  return hits
}

/** 单次调用同时获取 `nameStatus` 条目与 `--unified=3` diff 正文，并绑定 WeakMap 与不可变提交缓存。 */
export async function gitDiffRawEntriesAndText(cwd, range) {
  let effectiveRange = range
  let commonDir = null
  let cacheBase = null
  let cacheHead = null
  const rangeM = /^([0-9a-f]{40,64})\.\.([0-9a-f]{40,64}|HEAD)$/i.exec(String(range ?? ''))
  if (rangeM) {
    const wtGitDir = resolveGitDirFast(cwd)
    if (wtGitDir) {
      const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
      commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir
      const resolvedHead = rangeM[2].toUpperCase() === 'HEAD' ? readHeadFast(wtGitDir, commonDir)?.oid : rangeM[2]
      if (resolvedHead && /^[0-9a-f]{40,64}$/i.test(resolvedHead)) {
        cacheBase = rangeM[1]
        cacheHead = resolvedHead
        if (cacheBase === cacheHead) return { ok: true, entries: [], diffText: '', rawSha256: null, rawBytes: 0, stderr: '' }
        effectiveRange = `${cacheBase}..${cacheHead}`
        const hit = getCachedCommitDiff(commonDir, cacheBase, cacheHead)
        if (hit) return { ok: true, entries: hit.entries, diffText: hit.diffText, rawSha256: hit.rawSha256, rawBytes: hit.rawBytes, stderr: '' }
      }
    }
  }
  const res = await gitRunBuffer(cwd, ['--no-optional-locks', 'diff', '--raw', '--unified=3', '--no-ext-diff', '--no-color', effectiveRange])
  if (!res.ok) return { ok: false, entries: [], diffText: '', stderr: res.stderr }
  const { entries, diffText } = parseRawAndUnifiedDiff(res.stdout)
  const digest = computePatchRawDigest(res.stdout)
  const out = { ok: true, entries, diffText, rawSha256: digest.sha256, rawBytes: digest.bytes, stderr: '' }
  if (commonDir && cacheBase && cacheHead) setCachedCommitDiff(commonDir, cacheBase, cacheHead, out)
  return out
}

/** 扫描仓库 diff 中可能弱化验证门禁的改动，返回精确命中列表（支持复用 headSha 与 nameStatusEntries）。 */
export async function detectGateWeakening(implRoot, baseRef, baseBranch, opts = {}) {
  let ref = baseRef
  const wtGitDir = !opts.headSha || (!ref && baseBranch) ? resolveGitDirFast(implRoot) : null
  const fastHead = opts.headSha ? null : (wtGitDir ? readHeadFast(wtGitDir)?.oid : null)
  const headSha = opts.headSha ?? (fastHead || ((await gitRun(implRoot, ['rev-parse', 'HEAD'])).stdout?.trim() || null))

  if (!ref && baseBranch) {
    const cdTxt = wtGitDir ? readTextSafe(join(wtGitDir, 'commondir')) : null
    const commonDir = wtGitDir ? (cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir) : null
    const fastBrSha = commonDir ? resolveRefShaFast(commonDir, `refs/heads/${baseBranch}`) : null
    if (fastBrSha) {
      if (fastBrSha !== headSha) ref = baseBranch
    } else {
      const brRes = await gitRun(implRoot, ['rev-parse', '--verify', baseBranch])
      if (brRes.ok && brRes.stdout.trim() !== headSha) ref = baseBranch
    }
  }
  if (!ref) return []

  const hasPreNs = ref === baseRef && Array.isArray(opts.nameStatusEntries)
  if (hasPreNs && opts.nameStatusEntries.every((e) => !e?.file || /\.mdx?$|\.txt$/i.test(e.file))) {
    return []
  }

  let diffText = hasPreNs ? getCachedEntriesDiffText(opts.nameStatusEntries) : undefined
  let resolvedEntries = hasPreNs ? opts.nameStatusEntries : null
  if (diffText === undefined) {
    if (hasPreNs) {
      const diffRes = await gitRunBuffer(implRoot, ['--no-optional-locks', 'diff', '--unified=3', '--no-ext-diff', '--no-color', `${ref}..HEAD`])
      if (!diffRes.ok) return []
      diffText = diffRes.stdout.toString('utf8').replace(/\r\n/g, '\n')
    } else {
      const rawRes = await gitDiffRawEntriesAndText(implRoot, `${ref}..HEAD`)
      if (!rawRes.ok) return []
      diffText = rawRes.diffText
      resolvedEntries = rawRes.entries
    }
  }

  const chunks = splitDiffByFile(diffText)
  const statusMap = new Map()
  for (const e of resolvedEntries ?? []) {
    if (e?.file) statusMap.set(posixPath(e.file), e.status || 'M')
  }

  const files = [...new Set([...chunks.keys(), ...statusMap.keys()])].filter(Boolean)
  const findings = []
  for (const file of files) {
    const chunk = chunks.get(file) ?? ''
    const { added, removed, hunks } = summarizeHunkChanges(chunk)
    const status = statusMap.get(file) ?? 'M'
    findings.push(...detectGateWeakeningInEntry({ file, status, added, removed, hunks }))
  }
  return findings
}

/** 扫描源码增行中的履历注释、借口压制、注释死代码、自动生成头标豁免、纯声明式/类型契约降级与大文件/紧文件指标。 */
export function scanStructuralHygiene({ fileRel, lines = [], fullText = null, fullLineCount = 0, warnLines = 800, highLines = 1500, nearLimitLines = NEAR_LIMIT_LINES, skipFixtureCheck = false, gitAttributesText = '' }) {
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
  const views = buildLexedViews(rawJoined, ext)
  const tombstoneComments = []
  const excuseSuppressions = []
  if (!isFixture) {
    for (let i = 0; i < views.lines.length; i += 1) {
      const line = views.lines[i]
      const commentText = views.commentLines[i]
      if (!generatedExempt && commentText && (TOMBSTONE_COMMENT_RE.test(commentText) || TOMBSTONE_DATE_RE.test(commentText))) {
        tombstoneComments.push({ file: rel, line: i + 1, excerpt: line.trim().slice(0, 120) })
      }
      const hasJustify = JUSTIFICATION_ANCHOR_RE.test(commentText || line)
      const isHackLike = Boolean(commentText && EXCUSE_HACK_RE.test(commentText))
      const hasIssueRef = Boolean(commentText && ISSUE_REF_RE.test(commentText))
      if (!hasJustify && !(isHackLike && hasIssueRef) && ((commentText && (EXCUSE_COMMENT_RE.test(commentText) || EXCUSE_TEMP_RE.test(commentText))) || RUST_ALLOW_RE.test(views.codeNoLiteralLines[i]))) {
        excuseSuppressions.push({
          file: rel,
          line: i + 1,
          kind: isHackLike ? 'missing-issue-link' : 'suppression-bypass',
          excerpt: line.trim().slice(0, 120),
        })
      }
    }
  }
  const deadCodeBlocks = (isFixture || generatedExempt) ? [] : detectCommentedDeadCodeBlocks(views).map((b) => ({ file: rel, line: b.startLine, endLine: b.endLine, length: b.length, excerpt: b.excerpt }))
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
