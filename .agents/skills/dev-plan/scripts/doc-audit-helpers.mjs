/**
 * doc-audit-helpers.mjs —— 规划文档审计的 Frontmatter 行号定位、占位检查与路径提取纯函数。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 doc-audit.mjs 调用以控制单文件体积。
 */

const PLACEHOLDER_TEXT_RE = /(?:待补充|待填写|待核实|\bTBD\b|\bFIXME\b|<!--\s*(?:project-forge:\s*)?fill)/i
const ANGLE_PLACEHOLDER_RE = /<([^>\n]{1,60})>/g
const PATH_PREFIX_RE = /^(?:src|lib|kit|scripts|tests?|spec|app|apps|packages|pkg|cmd|internal|docs|templates|references|\.github)\//

/** 在已拆行的文档头部 Frontmatter 中查找指定键的 1-based 行号。 */
export function findFmKeyLine(lines, fmEndIdx, key) {
  if (fmEndIdx < 0) return 1
  const re = new RegExp(`^${key}\\s*:`)
  for (let idx = 1; idx < fmEndIdx; idx += 1) {
    if (re.test(lines[idx])) return idx + 1
  }
  return 1
}

/** 从 Frontmatter 的 `issue` 字段提取正整数编号（`null` 表示未绑定，`NaN` 表示格式非法）。 */
export function extractFrontmatterIssueInt(val) {
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

/** 收集单行文本或 Frontmatter 字符串字段中的未清理占位符错误。 */
export function collectPlaceholderErrors(rawText, strippedText, lineNo, errors) {
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

/** 从剥除注释后的正文中提取候选仓库相对路径。 */
export function extractLinePathCandidates(strippedLine) {
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

/** 判断同一行内的候选路径是否带有 `(new)` / `新建` 显式声明。 */
export function candHasNewAnnotation(strippedLine, rawCand) {
  const escCand = rawCand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const nearNewRe = new RegExp(
    `(?:新建|新增文件)\\s*[:：]?\\s*[\`"'“「]?[^\\s\`"'”」]*${escCand}(?![A-Za-z0-9_./-])`
    + `|(?<![A-Za-z0-9_./-])${escCand}[^\\n,;，；]{0,20}(?:\\(\\s*new\\s*\\)|（\\s*new\\s*）|\\[\\s*new\\s*\\]|新建|新增)`,
    'i',
  )
  return nearNewRe.test(strippedLine)
}
