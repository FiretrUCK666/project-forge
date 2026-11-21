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
