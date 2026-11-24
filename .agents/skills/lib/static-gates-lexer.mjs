/**
 * static-gates-lexer.mjs —— 多语言词法注释与字面量剥离器、死代码块及单测反作弊扫描内核。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），支持：
 *   - JS/TS/Rust/C-family 行/块注释与正则字面量避让；
 *   - Rust `'a` / `'static` 生命周期与 C/C++ `#define` 预处理避让；
 *   - HTML `<!-- ... -->` 多行注释与 Python `"""` / `'''` 多行块；
 *   - 剥离字符串与正则字面量构建纯代码视图，消除规则源码自检误报。
 */

export const C_FAMILY_NO_HASH_COMMENT_EXTS = new Set([
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'java', 'kt', 'kts', 'rs', 'go',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'mts', 'cts', 'swift', 'dart', 'php',
])
export const C_PREPROC_RE = /^#\s*(?:define|include|if|ifdef|ifndef|else|elif|endif|pragma|undef|error|warning|line|region|endregion)\b/
const PY_TRIPLE_PREFIX_RE = /^(?:[rRuUfFbB]|[fFbB][rR]|[rR][fFbB])?("""|''')/

export function isRustLifetimeAt(s, idx, ext) {
  if (ext && ext !== 'rs') return false
  const rest = s.slice(idx)
  if (!/^'(?:_|[A-Za-z][A-Za-z0-9_]*)/.test(rest)) return false
  const m = /^'([A-Za-z_][A-Za-z0-9_]*)/.exec(rest)
  if (!m) return false
  const after = rest[m[0].length]
  return after !== '\''
}

function findPyTripleEnd(s, startIdx, delim) {
  let j = startIdx
  while (j < s.length) {
    if (s[j] === '\\') { j += 2; continue }
    if (s.slice(j, j + 3) === delim) return j
    j += 1
  }
  return -1
}

/**
 * 多语言词法注释提取器：
 * 返回 `{ commentText, codeText, nextInBlock, pureSingleLine }`。
 */
export function extractLineCommentInfo(line, inBlock = false, ext = '') {
  const s = String(line ?? '')
  const extLow = String(ext ?? '').toLowerCase().replace(/^\./, '')
  const allowHashComment = !C_FAMILY_NO_HASH_COMMENT_EXTS.has(extLow)
  const isPy = extLow === 'py'
  const commentParts = []
  let codeText = ''
  let segStart = 0
  let i = 0
  let block = inBlock
  let quote = ''
  let prevSig = ''
  let onlyComment = true
  let pureSingleLine = false

  if (block === 'py-dq' || block === 'py-sq') {
    const delim = block === 'py-dq' ? '"""' : '\'\'\''
    const end = findPyTripleEnd(s, 0, delim)
    if (end === -1) {
      return { commentText: '', codeText: '', nextInBlock: block, pureSingleLine: false }
    }
    block = false
    i = end + 3
    segStart = i
    prevSig = delim[0]
    onlyComment = false
  } else if (block) {
    const closeToken = block === 'html' ? '-->' : '*/'
    const end = s.indexOf(closeToken)
    if (end === -1) {
      return { commentText: s.trim(), codeText: '', nextInBlock: block, pureSingleLine: false }
    }
    commentParts.push(s.slice(0, end))
    block = false
    i = end + closeToken.length
    segStart = i
    onlyComment = false
  }

  while (i < s.length) {
    const ch = s[i]
    const next = s[i + 1]
    if (quote) {
      onlyComment = false
      if (ch === '\\') { i += 2; continue }
      if (ch === quote) quote = ''
      i += 1
      continue
    }

    if (isPy && (i === 0 || !/[A-Za-z0-9_]/.test(s[i - 1]))) {
      const pm = PY_TRIPLE_PREFIX_RE.exec(s.slice(i))
      if (pm) {
        const delim = pm[1]
        const prefixLen = pm[0].length - 3
        onlyComment = false
        codeText += s.slice(segStart, i)
        const closeIdx = findPyTripleEnd(s, i + prefixLen + 3, delim)
        if (closeIdx === -1) {
          block = delim === '"""' ? 'py-dq' : 'py-sq'
          segStart = s.length
          break
        }
        i = closeIdx + 3
        segStart = i
        prevSig = delim[0]
        continue
      }
    }

    if (ch === '\'') {
      if (isRustLifetimeAt(s, i, extLow)) {
        onlyComment = false
        prevSig = '\''
        i += 1
        continue
      }
      onlyComment = false
      quote = ch
      prevSig = ch
      i += 1
      continue
    }
    if (ch === '"' || ch === '`') {
      onlyComment = false
      quote = ch
      prevSig = ch
      i += 1
      continue
    }
    if (ch === '/' && next === '/') {
      codeText += s.slice(segStart, i)
      segStart = s.length
      if (!prevSig && s[i + 2] !== '/') pureSingleLine = true
      commentParts.push(s.slice(i + 2))
      break
    }
    if (ch === '/' && next === '*') {
      onlyComment = false
      codeText += s.slice(segStart, i)
      const end = s.indexOf('*/', i + 2)
      if (end === -1) {
        commentParts.push(s.slice(i + 2))
        block = true
        segStart = s.length
        break
      }
      commentParts.push(s.slice(i + 2, end))
      i = end + 2
      segStart = i
      continue
    }
    if (ch === '<' && s.slice(i, i + 4) === '<!--') {
      onlyComment = false
      codeText += s.slice(segStart, i)
      const end = s.indexOf('-->', i + 4)
      if (end === -1) {
        commentParts.push(s.slice(i + 4))
        block = 'html'
        segStart = s.length
        break
      }
      commentParts.push(s.slice(i + 4, end))
      i = end + 3
      segStart = i
      continue
    }
    if (ch === '/' && !isPy) {
      const canRegex = !prevSig || '=(:,?[!&|;{}~^+-*'.includes(prevSig)
        || /\b(?:return|case|throw|typeof|await|yield)$/.test(s.slice(0, i).trimEnd())
      if (canRegex) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < s.length) {
          const rc = s[j]
          if (rc === '\\') { j += 2; continue }
          if (rc === '[') inClass = true
          else if (rc === ']' && inClass) inClass = false
          else if (rc === '/' && !inClass) { closed = true; break }
          j += 1
        }
        if (closed) {
          onlyComment = false
          prevSig = '/'
          i = j + 1
          continue
        }
      }
    }
    if (ch === '#' && allowHashComment) {
      const prevCh = i > 0 ? s[i - 1] : ''
      const rest = s.slice(i)
      if ((isPy || i === 0 || /\s/.test(prevCh)) && next !== '!' && next !== '[' && !C_PREPROC_RE.test(rest)) {
        codeText += s.slice(segStart, i)
        segStart = s.length
        if (!prevSig && onlyComment) pureSingleLine = true
        commentParts.push(s.slice(i + 1))
        break
      }
    }
    if (!/\s/.test(ch)) {
      prevSig = ch
      onlyComment = false
    }
    i += 1
  }

  if (segStart < s.length) codeText += s.slice(segStart)
  return { commentText: commentParts.join(' ').trim(), codeText, nextInBlock: block, pureSingleLine }
}

/** 剥离源码行内全部注释，保留原始行号映射。 */
export function stripCodeCommentsLines(text, ext = '') {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inBlock = false
  for (const line of lines) {
    const info = extractLineCommentInfo(line, inBlock, ext)
    inBlock = info.nextInBlock
    out.push(info.codeText)
  }
  return out
}

/** 在已去注释的单行代码中屏蔽字符串字面量与正则字面量内容，保留结构标点与行长映射。 */
export function maskLiteralsInCodeLine(codeLine, ext = '') {
  const s = String(codeLine ?? '')
  const extLow = String(ext ?? '').toLowerCase().replace(/^\./, '')
  const isPy = extLow === 'py'
  const out = []
  let i = 0
  let prevSig = ''

  while (i < s.length) {
    const ch = s[i]
    if (ch === '\'' && isRustLifetimeAt(s, i, extLow)) {
      out.push(ch)
      prevSig = '\''
      i += 1
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const q = ch
      out.push(q)
      i += 1
      while (i < s.length) {
        const c = s[i]
        if (c === '\\') { out.push(' ', ' '); i += 2; continue }
        if (c === q) { out.push(q); i += 1; break }
        out.push(' ')
        i += 1
      }
      prevSig = q
      continue
    }
    if (ch === '/' && !isPy) {
      const canRegex = !prevSig || '=(:,?[!&|;{}~^+-*'.includes(prevSig)
        || /\b(?:return|case|throw|typeof|await|yield)$/.test(s.slice(0, i).trimEnd())
      if (canRegex) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < s.length) {
          const rc = s[j]
          if (rc === '\\') { j += 2; continue }
          if (rc === '[') inClass = true
          else if (rc === ']' && inClass) inClass = false
          else if (rc === '/' && !inClass) { closed = true; break }
          j += 1
        }
        if (closed) {
          out.push('/')
          for (let k = i + 1; k < j; k += 1) out.push(' ')
          out.push('/')
          i = j + 1
          while (i < s.length && /[A-Za-z]/.test(s[i])) { out.push(s[i]); i += 1 }
          prevSig = '/'
          continue
        }
      }
    }
    out.push(ch)
    if (!/\s/.test(ch)) prevSig = ch
    i += 1
  }
  return out.join('')
}

/** 一次词法扫描同时产出「纯代码视图」「去字面量代码视图」与「注释视图」。 */
export function buildLexedViews(text, ext = '') {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const codeLines = new Array(lines.length)
  const codeNoLiteralLines = new Array(lines.length)
  const commentLines = new Array(lines.length)
  const pureSingleLineFlags = new Array(lines.length)
  let inBlock = false

  for (let i = 0; i < lines.length; i += 1) {
    const info = extractLineCommentInfo(lines[i], inBlock, ext)
    inBlock = info.nextInBlock
    codeLines[i] = info.codeText
    codeNoLiteralLines[i] = maskLiteralsInCodeLine(info.codeText, ext)
    commentLines[i] = info.commentText
    pureSingleLineFlags[i] = info.pureSingleLine
  }
  return {
    lines,
    codeLines,
    codeNoLiteralLines,
    commentLines,
    pureSingleLineFlags,
    codeOnlyText: codeLines.join('\n'),
    codeNoLiteralsText: codeNoLiteralLines.join('\n'),
    commentOnlyText: commentLines.filter(Boolean).join('\n'),
  }
}

/** 判定单行注释正文是否疑似被注释掉的死代码。 */
export function looksLikeCommentedCode(body) {
  const t = String(body ?? '').trim()
  if (!t || t.startsWith('@') || /^[-=*#]{3,}$/.test(t)) return false
  if (/[{};]\s*$/.test(t)) return true
  if (/^(?:const|let|var|function|async\s+function|class|if|else\s+if|for|while|switch|return|import|export|def|async\s+def|try|except|finally|fn|pub\s+fn|func)\b/.test(t)) return true
  if (/^[A-Za-z_][A-Za-z0-9_.]*\s*(?:=|:=|\([^)]*\)\s*(?:=>|\{|$))/.test(t)) return true
  if (/^\s*[})\]]+\s*[,;]?\s*$/.test(t)) return true
  return false
}

/** 扫描词法视图中的连续注释死代码块（>=4 行纯单行注释且含 >=3 行代码特征）。 */
export function detectCommentedDeadCodeBlocks(views, { minRun = 4, minCodeLines = 3 } = {}) {
  const blocks = []
  let run = []
  const flush = () => {
    if (run.length >= minRun) {
      const startLine = run[0].line
      const isLicenseHeader = startLine <= 12 && run.some((c) => /copyright|license|spdx/i.test(c.body))
      if (!isLicenseHeader) {
        const codeCount = run.filter((c) => looksLikeCommentedCode(c.body)).length
        if (codeCount >= minCodeLines) {
          blocks.push({
            startLine,
            endLine: run[run.length - 1].line,
            length: run.length,
            excerpt: run[0].body.slice(0, 100),
          })
        }
      }
    }
    run = []
  }
  const len = views.commentLines.length
  for (let i = 0; i < len; i += 1) {
    const body = views.commentLines[i]
    if (views.pureSingleLineFlags[i] && body) run.push({ line: i + 1, body })
    else flush()
  }
  flush()
  return blocks
}

export const HARD_SLEEP_RULES = Object.freeze([
  /\bsetTimeout\s*\([^,\n]+,\s*(?:[1-9]\d{3,})\s*\)/,
  /\b(?:sleep|delay|waitForTimeout)\s*\(\s*(?:[1-9]\d{3,})\s*\)/,
  /\b(?:time|asyncio)\.sleep\s*\(\s*(?:[1-9]\d*(?:\.\d+)?)\s*\)/,
  /^\s*sleep\s+(?:[1-9]\d*(?:\.\d+)?)(?:\s|$)/,
  /\btime\.Sleep\s*\(\s*(?:[1-9]\d*\s*\*\s*time\.(?:Second|Minute)|(?:[1-9]\d{3,})\s*\*\s*time\.Millisecond)/,
  /\bthread::sleep\s*\(\s*Duration::(?:from_secs\s*\(\s*[1-9]|from_millis\s*\(\s*(?:[1-9]\d{3,}))/,
  /\bThread\.sleep\s*\(\s*(?:[1-9]\d{3,})\s*\)/,
])
export const MOCK_SETUP_RE = /\b(?:vi\.fn|vi\.spyOn|jest\.fn|jest\.spyOn|mock\.fn|sinon\.(?:stub|spy|mock)|unittest\.mock|MagicMock|patch\.object|mock\.patch|mockReturnValue|mockResolvedValue|when\([^\n]+\)\.thenReturn)\b|\bpatch\s*\(/g
export const MOCK_SPY_ASSERT_RE = /\bexpect\s*\((?:[^()\n]|\([^()\n]*\))+\)\s*(?:\.\s*not)?\s*\.\s*toHaveBeenCalled\w*\s*\((?:[^()\n]|\([^()\n]*\))*\)|[A-Za-z0-9_$.]+\s*\.\s*assert_(?:not_)?called(?:_once|_with|_once_with)?\s*\((?:[^()\n]|\([^()\n]*\))*\)|\bassert\s+[A-Za-z0-9_$.]+\s*\.\s*(?:called|calledOnce|calledTwice|calledThrice|call_count)\b[^\n]*|[A-Za-z0-9_$.]+\s*\.\s*(?:calledOnce|calledTwice|calledThrice|verify)\b(?:\s*\([^)\n]*\))?/

/**
 * 词法去噪后的单测反作弊检查（零断言、纯 Mock 自证、单测 >=1s 硬编码 sleep、非无头 UI 测试）。
 */
export function scanTestAntiCheat({
  fileRel, text, ext = '', assertionRe, testCaseRe, isNonUnit = false,
} = {}) {
  const findings = []
  const extNorm = ext || String(fileRel ?? '').split('.').pop()?.toLowerCase() || ''
  const views = buildLexedViews(text, extNorm)
  const codeOnlyText = views.codeOnlyText
  const codeNoLiterals = views.codeNoLiteralsText
  const testDeclCount = views.codeLines.filter((l) => testCaseRe.test(l)).length
  const baseName = String(fileRel ?? '').split('/').pop() ?? ''
  const isExplicitTest = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|^test_[^/]+\.py$|(?:Tests?|IT)\.(?:java|kt|cs|swift)$|_unittest\.(?:cc|cpp)$/i.test(baseName)
    || testDeclCount > 0

  if (isExplicitTest && !assertionRe.test(codeOnlyText)) {
    findings.push({
      ruleId: 'edit.test-zero-assertion',
      defectClass: 'mock-only-test',
      severity: 'high',
      file: fileRel,
      line: 1,
      message: `测试文件缺少真实断言（零断言用例）：${fileRel}`,
      fixHint: '补充针对真实输出或状态转换的 assert/expect 断言，避免空跑假绿。',
    })
  }

  if (isExplicitTest) {
    const mockCount = (codeNoLiterals.match(MOCK_SETUP_RE) ?? []).length
    const hasSpyAssert = MOCK_SPY_ASSERT_RE.test(codeOnlyText)
    const nonSpyCode = codeOnlyText.replace(new RegExp(MOCK_SPY_ASSERT_RE.source, 'g'), '')
    const hasRealAssertion = assertionRe.test(nonSpyCode)
    if (mockCount >= 5 && hasSpyAssert && !hasRealAssertion) {
      findings.push({
        ruleId: 'edit.test-mock-tautology',
        defectClass: 'mock-only-test',
        severity: 'high',
        file: fileRel,
        line: 1,
        message: `纯 Mock 自证测试（${mockCount} 处 mock 且仅有调用次数断言，0 真实行为断言）：${fileRel}`,
        fixHint: '直接验证被测模块真实返回值或副作用状态，而不是只验证 mock 是否被调用。',
      })
    }
  }

  if (!isNonUnit) {
    for (let i = 0; i < views.codeNoLiteralLines.length; i += 1) {
      if (HARD_SLEEP_RULES.some((re) => re.test(views.codeNoLiteralLines[i]))) {
        findings.push({
          ruleId: 'edit.test-hard-sleep',
          defectClass: 'race-condition',
          severity: 'high',
          file: fileRel,
          line: i + 1,
          message: `单元测试存在 >=1000ms 硬编码等待：${fileRel}:${i + 1}`,
          fixHint: '改用事件回调、条件轮询或假时钟，禁止硬编码长时 sleep/setTimeout。',
        })
        break
      }
    }
  }

  const hasHeadlessGuard = /\bprocess\.env\.(?:CI|HEADLESS|DISPLAY)|os\.environ|headless\s*:\s*(?:true|Boolean|process\.env)/i.test(codeNoLiterals)
  const hasTempHomeGuard = /\b(?:mkdtemp|tmpdir|tmp_path|tempdir|HOME\s*=|USERPROFILE\s*=)\b/i.test(codeNoLiterals)
  const explicitHeaded = (/\bheadless\s*:\s*false\b/i.test(codeNoLiterals) && !hasHeadlessGuard)
    || (/['"`]--headed['"`]/.test(codeOnlyText) && !hasHeadlessGuard)
    || (/\b(?:pyautogui|pynput|NSApplication\.shared|robot\.mouseClick|osascript)\b/i.test(codeNoLiterals) && !hasHeadlessGuard)
  const touchesRealHome = /(?:\b(?:os\.homedir\(\)|Path\.home\(\)|expanduser\(["']~)|["']~\/\.(?:config|local|ssh|aws|kube))/i.test(codeOnlyText)
    && !hasTempHomeGuard
  if (explicitHeaded || touchesRealHome) {
    findings.push({
      ruleId: 'edit.test-non-headless',
      defectClass: 'missing-runtime-proof',
      severity: 'high',
      file: fileRel,
      line: 1,
      message: explicitHeaded
        ? `测试未启用无头模式或缺少 CI/HEADLESS 守卫：${fileRel}`
        : `测试直接访问宿主用户主目录且缺少临时目录隔离：${fileRel}`,
      fixHint: '默认以 headless 模式运行并在临时目录中隔离测试状态。',
    })
  }

  return findings
}

export const PROCESS_ARTIFACT_EXCLUDED_DIR_RE = /^(?:docs\/(?:prd|specs|todo|archive|release-notes|adr)\/|\.git\/|\.worktrees\/|node_modules\/)/i
export const PROCESS_ARTIFACT_FILENAME_RE = /(?:^|[-_.])(?:issue\d+|pr\d+|mr\d+|ticket\d+|wave\d+|phase\d+|sprint\d+|slice\d+|batch\d+|stage[-_][a-z0-9]+|stage[0-9]+[a-z]?|stage[a-z][0-9]+|stage(?!d(?:$|[-_.])|s(?:$|[-_.]))[a-z])(?:$|[-_.])|[-_][bc]\d+[a-z]?(?:$|[-_.])/i

/** 通用 Tier 2 静态规则：拦截源码/脚本/测试中的过程编号或阶段命名文件名（排除规划/归档文档目录）。 */
export function checkProcessArtifactFilename(fileRel) {
  const norm = String(fileRel ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (!norm || PROCESS_ARTIFACT_EXCLUDED_DIR_RE.test(norm)) return null
  const base = norm.split('/').pop() ?? ''
  const stem = base.replace(/\.[^.]+$/, '')
  if (!stem) return null
  const m = PROCESS_ARTIFACT_FILENAME_RE.exec(stem)
  if (!m) return null
  const token = m[0].replace(/^[-_.]+|[-_.]+$/g, '')
  return {
    ruleId: 'naming.process-artifact-filename',
    defectClass: 'stale-contract',
    severity: 'high',
    file: norm,
    line: 1,
    token,
    message: `过程编号文件名违规（${norm}）：命中「${token}」——源码/脚本/测试须按功能域命名，禁止使用 issue/pr/mr/ticket/stage/wave/phase/sprint/slice/batch/-bN/-cN 等过程标识`,
    fixHint: '请按模块或功能域重命名文件（如 fixtures-edit-pyramid.mjs），过程编号仅保留在 docs/{prd,specs,todo,archive}/ 中。',
  }
}

export function findProcessArtifactFilenameViolations(fileRelList = []) {
  const out = []
  for (const rel of fileRelList ?? []) {
    const hit = checkProcessArtifactFilename(rel)
    if (hit) out.push(hit)
  }
  return out
}
