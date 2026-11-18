/**
 * doc-audit-repo.mjs —— 仓库文档枚举与全量目录审计辅助，供 doc-audit.mjs 调用。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import { posixPath, readTextSafe } from '../../lib/git.mjs'
import { parseDocFrontmatter } from '../../lib/docs.mjs'

export function collectMarkdownFiles(dir, root) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full, root))
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push({ rel: posixPath(relative(root, full)), abs: full })
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function summarizeDoc(item) {
  const text = readTextSafe(item.abs) ?? ''
  const fm = parseDocFrontmatter(text)
  const title = /^#\s+(.+)$/m.exec(fm.body || text)?.[1]?.trim() ?? fm.data?.title ?? basename(item.rel)
  return {
    file: item.rel,
    title,
    status: fm.data?.status ?? null,
    created: fm.data?.created ?? null,
    plannedAt: fm.data?.planned_at ?? null,
    issue: fm.data?.issue ?? null,
    pr: fm.data?.pr ?? null,
    totalChecks: (text.match(/^- \[[ xX]\]/gm) ?? []).length,
    doneChecks: (text.match(/^- \[[xX]\]/gm) ?? []).length,
  }
}

export function listDocs(repoRoot) {
  const tddPath = join(repoRoot, 'docs', 'TDD.md')
  return {
    tdd: existsSync(tddPath) ? summarizeDoc({ rel: 'docs/TDD.md', abs: tddPath }) : null,
    prds: collectMarkdownFiles(join(repoRoot, 'docs', 'prd'), repoRoot).map(summarizeDoc),
    specs: collectMarkdownFiles(join(repoRoot, 'docs', 'specs'), repoRoot).map(summarizeDoc),
    todos: collectMarkdownFiles(join(repoRoot, 'docs', 'todo'), repoRoot).map(summarizeDoc),
    archived: collectMarkdownFiles(join(repoRoot, 'docs', 'archive'), repoRoot).map(summarizeDoc),
  }
}

export function runRepoDocsAudit(repoRoot, scope, { auditDoc, checkMasterPrdCoverage, checkOrphanSlices }) {
  const scopeAbs = resolve(repoRoot, scope)
  const scopeRel = posixPath(relative(repoRoot, scopeAbs))
  const targets = []
  for (const d of ['docs/prd', 'docs/specs', 'docs/todo']) {
    const dirAbs = join(repoRoot, d)
    if (!existsSync(dirAbs)) continue
    for (const item of collectMarkdownFiles(dirAbs, repoRoot)) {
      if (!scopeRel || scopeRel === '.' || item.rel === scopeRel || item.rel.startsWith(`${scopeRel}/`)) targets.push(item.rel)
    }
  }
  const results = targets.map((file) => auditDoc({ repoRoot, file }))
  const coverageErrors = [...checkMasterPrdCoverage(repoRoot), ...checkOrphanSlices(repoRoot)]
  const allErrors = [...results.flatMap((r) => r.errors ?? []), ...coverageErrors]
  const failedCount = results.filter((r) => !r.ok).length + (coverageErrors.length > 0 ? 1 : 0)
  return {
    ok: allErrors.length === 0,
    scope: scopeRel || '.',
    auditedCount: results.length,
    failedCount,
    results,
    coverageErrors,
  }
}
