/**
 * static-gates-lexer.mjs —— 多语言词法注释与块字面量剥离器（供 static-gates 与 shared 复用）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），支持：
 *   - JS/TS/Rust/C-family 行/块注释与正则字面量避让；
 *   - Rust `'a` / `'static` 生命周期与 C/C++ `#define` 预处理避让；
 *   - HTML `<!-- ... -->` 多行注释；
 *   - Python `"""` / `'''` 多行块（`inBlock = 'py-dq' | 'py-sq'`，含 `r`/`f`/`b`/`u` 前缀与闭合后同行 `#` 注释）。
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
  // `'a'` is a char literal; `'a` or `'static` without closing `'` is a Rust lifetime
  return after !== '\''
}

function findPyTripleEnd(s, startIdx, delim) {
  let j = startIdx
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2
      continue
    }
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
