/**
 * survey-workspace-secrets.mjs —— 凭据正文/本机路径泄漏扫描、`.gitignore` 负向放行解析与输出目录未跟踪核查。
 *
 * 从 `survey-workspace.mjs` 拆出以控制单文件行数 < 550，仅依赖 node:* 与同层/共享原语。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { matchSecretContentLine } from '../../kit/skills/lib/credential-scan.mjs'
import { matchGlob, posixPath } from '../../kit/skills/lib/git-core.mjs'
import { isMacMetadataName, readTextSafe } from './text.mjs'
import { isJunkFile } from './survey-ecosystem.mjs'

export function classifyHomePath(rel, line) {
  const path = String(rel ?? '').replace(/\\/g, '/')
  if (/(^|\/)(?:tests?|specs?|__tests__|fixtures?|examples?|__mocks__|testdata)(\/|$)/i.test(path)) return 'test-data'
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(path)) return 'test-data'
  if (/(^|\/)(?:docs\/work|docs\/tasks|work)(\/|$)/i.test(path)) return 'generated'
  if (/^changelog\.md$/i.test(path) || /(^|\/)release-notes\//i.test(path)) return 'generated'
  if (/\.(?:md|mdx|rst|txt)$/i.test(path)) {
    if (/[`'"]|<|>|\bexample\b|示例/i.test(line)) return 'doc-example'
    return 'leak'
  }
  return 'leak'
}

export function scanBufferSecretsAndLeaks(rec, text, homeFastRe, homeRe, mightHaveSecret, mightHaveHome) {
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (mightHaveSecret) {
      for (const pat of matchSecretContentLine(line)) {
        if (!rec.textSecrets) rec.textSecrets = []
        rec.textSecrets.push({ file: rec.rel, line: i + 1, kind: pat.zhLabel ?? pat.label })
      }
    }
    if (mightHaveHome && homeRe.test(line.replace(/\\\\/g, '/').replace(/\\/g, '/'))) {
      const category = classifyHomePath(rec.rel, line)
      if (category) {
        if (!rec.textLeaks) rec.textLeaks = []
        rec.textLeaks.push({ file: rec.rel, line: i + 1, category })
      }
    }
  }
}

/** 收集仓库根目录（及目标文件已知祖先）`.gitignore` 中的 `!` 负向放行规则。 */
export function parseGitignoreNegations(root, relFiles = []) {
  const ignoreFiles = new Set(['.gitignore'])
  for (const rel of relFiles) {
    const p = posixPath(rel)
    if (p === '.gitignore' || p.endsWith('/.gitignore')) ignoreFiles.add(p)
  }
  const rules = []
  for (const igRel of ignoreFiles) {
    const abs = join(root, igRel)
    if (!existsSync(abs)) continue
    const text = readTextSafe(abs)
    if (!text) continue
    const baseDir = igRel.includes('/') ? igRel.slice(0, igRel.lastIndexOf('/')) : ''
    for (const raw of text.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || !line.startsWith('!')) continue
      const pat = posixPath(line.slice(1).trim()).replace(/^\/+/, '').replace(/\/+$/, '')
      if (pat) rules.push({ baseDir, pattern: pat })
    }
  }
  return rules
}

/** 判断相对路径是否被 `.gitignore` `!` 负向规则显式放行。 */
export function isExplicitlyUnignoredPath(relPath, negations) {
  if (!Array.isArray(negations) || negations.length === 0) return false
  const norm = posixPath(relPath).replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!norm) return false
  for (const { baseDir, pattern } of negations) {
    let sub = norm
    if (baseDir) {
      if (norm !== baseDir && !norm.startsWith(`${baseDir}/`)) continue
      sub = norm === baseDir ? '' : norm.slice(baseDir.length + 1)
    }
    if (!sub) continue
    if (matchGlob(sub, pattern)) return true
    if (pattern.endsWith('/**') && matchGlob(sub, pattern.slice(0, -3))) return true
    if (!pattern.includes('/') && !/[*?]/.test(pattern)) {
      if (sub === pattern || sub.startsWith(`${pattern}/`) || sub.split('/').includes(pattern)) return true
    }
  }
  return false
}

export function collectUntrackedCandidatesInDir(root, dirRel, trackedSet, hasIgnoredPrefix, negations = [], limit = 64) {
  const candidates = []
  const stack = [{ abs: join(root, dirRel), rel: dirRel }]
  while (stack.length > 0 && candidates.length < limit) {
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur.abs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacMetadataName(entry.name) || entry.name === '.git') continue
      const nextRel = `${cur.rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (!isExplicitlyUnignoredPath(nextRel, negations)) {
          stack.push({ abs: join(cur.abs, entry.name), rel: nextRel })
        }
      } else if (entry.isFile() && !isJunkFile(nextRel)) {
        if (trackedSet.has(nextRel) || hasIgnoredPrefix(nextRel) || isExplicitlyUnignoredPath(nextRel, negations)) continue
        candidates.push(nextRel)
        if (candidates.length >= limit) break
      }
    }
  }
  return candidates
}
