/**
 * write-probe-audit.mjs —— 全量扫描 kit/skills/ 写入口与裸 probeGitHubEnv 调用的共享静态门禁。
 *
 * 供 scripts/dev/preflight-suite.mjs 与 scripts/dev/fixtures-handoff-review.mjs 共同复用，
 * 先调用 stripCodeCommentsLines 剥除注释，再剥离字符串/模板/正则字面量并对 probeGitHubEnv(...)
 * 执行括号平衡提取，兼顾任意键序与多行对象参数。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { stripCodeCommentsLines } from '../../kit/skills/lib/static-gates-lexer.mjs'

export const WRITE_PROBE_SKIP_FILES = new Set([
  'kit/skills/lib/platform.mjs',
  'kit/skills/lib/platform-probe.mjs',
  'kit/skills/lib/github-client.mjs',
  'kit/skills/lib/task-backend.mjs',
  'kit/skills/lib/shared.mjs',
])

const MEMBER_WRITE_CALL_RE = /(?:\.|\?\.\s*)(createIssue|postComment|addLabels|removeLabel|createPr|mergePr|updatePrBase|claimTask|releaseTask|getCommitChecks|findOpenPrForBranch|listOpenPrsByBase)\s*\(/g
const BARE_WRITE_CALL_RE = /(?<![.\w$])(createIssue|removeLabel)\s*\(/g
const PROBE_FOR_WRITE_CALL_RE = /\bprobeForWrite\s*\(/g
const PROBE_ENV_CALL_RE = /\bprobeGitHubEnv\s*\(/g

function walkMjsFiles(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.worktrees') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMjsFiles(full, out)
    else if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

export function collectKitWriteProbeTargets(rootDir) {
  const kitSkillsDir = join(rootDir, 'kit', 'skills')
  const files = walkMjsFiles(kitSkillsDir)
  const targets = []
  for (const abs of files) {
    const rel = relative(rootDir, abs).split('\\').join('/')
    if (WRITE_PROBE_SKIP_FILES.has(rel)) continue
    targets.push({ file: rel, text: readFileSync(abs, 'utf8') })
  }
  return targets.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * 保留换行符与标点结构的前提下将字符串、模板字面量静态片段及正则字面量正文置为空格，
 * 避免引号内文本干扰括号深度匹配或误当作真实函数调用。
 */
function maskJsLiterals(codeText) {
  const s = String(codeText ?? '')
  const out = []
  const stack = [] // 'tmpl' entries track template expression `${ ... }` brace depth
  let i = 0
  let prevSig = ''

  const pushMaskedChar = (ch) => {
    out.push(ch === '\n' ? '\n' : ' ')
  }

  while (i < s.length) {
    const ch = s[i]
    const top = stack[stack.length - 1]

    if (top && top.kind === 'tmpl' && top.exprDepth === 0) {
      if (ch === '\\') {
        pushMaskedChar(ch)
        if (i + 1 < s.length) pushMaskedChar(s[i + 1])
        i += 2
        continue
      }
      if (ch === '$' && s[i + 1] === '{') {
        out.push('$', '{')
        top.exprDepth = 1
        prevSig = '{'
        i += 2
        continue
      }
      if (ch === '`') {
        out.push('`')
        stack.pop()
        prevSig = '`'
        i += 1
        continue
      }
      pushMaskedChar(ch)
      i += 1
      continue
    }

    if (ch === '\'' || ch === '"') {
      const q = ch
      out.push(q)
      i += 1
      while (i < s.length) {
        const c = s[i]
        if (c === '\\') {
          pushMaskedChar(c)
          if (i + 1 < s.length) pushMaskedChar(s[i + 1])
          i += 2
          continue
        }
        if (c === q) {
          out.push(q)
          i += 1
          break
        }
        pushMaskedChar(c)
        i += 1
      }
      prevSig = q
      continue
    }

    if (ch === '`') {
      out.push('`')
      stack.push({ kind: 'tmpl', exprDepth: 0 })
      prevSig = '`'
      i += 1
      continue
    }

    if (ch === '/') {
      const canRegex = !prevSig || '=(:,?[!&|;{}~^+-*'.includes(prevSig)
        || /\b(?:return|case|throw|typeof|await|yield)$/.test(s.slice(0, i).trimEnd())
      if (canRegex) {
        let j = i + 1
        let inClass = false
        let closed = false
        while (j < s.length) {
          const rc = s[j]
          if (rc === '\n') break
          if (rc === '\\') { j += 2; continue }
          if (rc === '[') inClass = true
          else if (rc === ']' && inClass) inClass = false
          else if (rc === '/' && !inClass) { closed = true; break }
          j += 1
        }
        if (closed) {
          out.push('/')
          for (let k = i + 1; k < j; k += 1) pushMaskedChar(s[k])
          out.push('/')
          i = j + 1
          while (i < s.length && /[A-Za-z]/.test(s[i])) {
            out.push(s[i])
            i += 1
          }
          prevSig = '/'
          continue
        }
      }
    }

    if (top && top.kind === 'tmpl' && top.exprDepth > 0) {
      if (ch === '{') top.exprDepth += 1
      else if (ch === '}') {
        top.exprDepth -= 1
        out.push('}')
        if (top.exprDepth === 0) prevSig = '}'
        else prevSig = '}'
        i += 1
        continue
      }
    }

    out.push(ch)
    if (!/\s/.test(ch)) prevSig = ch
    i += 1
  }

  return out.join('')
}

function lineAtIndex(text, idx) {
  return text.slice(0, idx).split('\n').length
}

function isFunctionDeclBefore(text, idx) {
  const before = text.slice(Math.max(0, idx - 64), idx)
  return /(?:\bfunction(?:\s*\*)?|\basync(?:\s+function)?)\s+$/.test(before)
}

function extractBalancedParenArgs(text, openParenIdx) {
  let depth = 0
  for (let i = openParenIdx; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '(') depth += 1
    else if (ch === ')') {
      depth -= 1
      if (depth === 0) return text.slice(openParenIdx + 1, i)
    }
  }
  return text.slice(openParenIdx + 1)
}

function inspectProbeNetworkArg(argsText) {
  const firstNonWs = argsText.search(/\S/)
  if (firstNonWs < 0 || argsText[firstNonWs] !== '{') {
    return { hasProbeNetwork: false, isLiteralFalse: false }
  }
  let braceDepth = 0
  let parenDepth = 0
  let bracketDepth = 0
  for (let i = firstNonWs; i < argsText.length; i += 1) {
    const ch = argsText[i]
    if (ch === '{') {
      braceDepth += 1
      continue
    }
    if (ch === '}') {
      braceDepth -= 1
      if (braceDepth === 0) break
      continue
    }
    if (ch === '(') { parenDepth += 1; continue }
    if (ch === ')') { if (parenDepth > 0) parenDepth -= 1; continue }
    if (ch === '[') { bracketDepth += 1; continue }
    if (ch === ']') { if (bracketDepth > 0) bracketDepth -= 1; continue }

    if (braceDepth === 1 && parenDepth === 0 && bracketDepth === 0) {
      const slice = argsText.slice(i)
      const propMatch = /^probeNetwork\s*:/.exec(slice)
      const prevCh = i > 0 ? argsText[i - 1] : ''
      if (propMatch && !/[A-Za-z0-9_$.]/.test(prevCh)) {
        const valStart = i + propMatch[0].length
        let bD = 1
        let pD = 0
        let kD = 0
        let valEnd = argsText.length
        for (let j = valStart; j < argsText.length; j += 1) {
          const c = argsText[j]
          if (c === '{') bD += 1
          else if (c === '}') { bD -= 1; if (bD === 0) { valEnd = j; break } }
          else if (c === '(') pD += 1
          else if (c === ')') { if (pD > 0) pD -= 1 }
          else if (c === '[') kD += 1
          else if (c === ']') { if (kD > 0) kD -= 1 }
          else if (c === ',' && bD === 1 && pD === 0 && kD === 0) { valEnd = j; break }
        }
        const valText = argsText.slice(valStart, valEnd).trim()
        const isLiteralFalse = /^(?:\(\s*)*false(?:\s*\))*$/.test(valText)
        return { hasProbeNetwork: true, isLiteralFalse }
      }
    }
  }
  return { hasProbeNetwork: false, isLiteralFalse: false }
}

export function scanKitWriteProbeViolations(entries = []) {
  const violations = []
  for (const entry of entries) {
    const file = String(entry?.file ?? entry?.path ?? '').split('\\').join('/')
    if (!file || WRITE_PROBE_SKIP_FILES.has(file)) continue
    const rawText = String(entry?.text ?? '')
    const codeLines = stripCodeCommentsLines(rawText, '.mjs')
    const masked = maskJsLiterals(codeLines.join('\n'))

    const writeHits = []
    for (const re of [MEMBER_WRITE_CALL_RE, BARE_WRITE_CALL_RE]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(masked)) !== null) {
        if (re === BARE_WRITE_CALL_RE && isFunctionDeclBefore(masked, m.index)) continue
        writeHits.push({ name: m[1], line: lineAtIndex(masked, m.index) })
      }
    }

    let hasProbeForWriteCall = false
    PROBE_FOR_WRITE_CALL_RE.lastIndex = 0
    let pm
    while ((pm = PROBE_FOR_WRITE_CALL_RE.exec(masked)) !== null) {
      if (!isFunctionDeclBefore(masked, pm.index)) {
        hasProbeForWriteCall = true
        break
      }
    }

    if (writeHits.length > 0 && !hasProbeForWriteCall) {
      writeHits.sort((a, b) => a.line - b.line)
      violations.push({
        file,
        line: writeHits[0].line,
        rule: 'missing-probe-for-write',
        message: `存在写入口调用 ${writeHits[0].name}(...) 但代码正文未调用 probeForWrite(...)`,
      })
    }

    PROBE_ENV_CALL_RE.lastIndex = 0
    let em
    while ((em = PROBE_ENV_CALL_RE.exec(masked)) !== null) {
      if (isFunctionDeclBefore(masked, em.index)) continue
      const line = lineAtIndex(masked, em.index)
      const openParenIdx = em.index + em[0].length - 1
      const argsText = extractBalancedParenArgs(masked, openParenIdx)
      const argCheck = inspectProbeNetworkArg(argsText)
      if (!argCheck.hasProbeNetwork) {
        violations.push({
          file,
          line,
          rule: 'bare-probe-github-env',
          message: '调用 probeGitHubEnv(...) 缺少显式 probeNetwork 属性（写路径须改用 probeForWrite，只读路径须显式传 probeNetwork）',
        })
      } else if (argCheck.isLiteralFalse) {
        violations.push({
          file,
          line,
          rule: 'probe-network-false',
          message: '调用 probeGitHubEnv(...) 禁止传入字面量 probeNetwork: false（写路径须改用 probeForWrite）',
        })
      }
    }
  }
  return violations
}
