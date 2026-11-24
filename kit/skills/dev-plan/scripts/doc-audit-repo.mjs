/**
 * doc-audit-repo.mjs —— 仓库文档枚举与全量目录审计辅助，供 doc-audit.mjs 调用。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { canonicalPath, posixPath, readTextSafe } from '../../lib/git.mjs'
import { isManagedPlanDoc } from '../../lib/docs.mjs'
import { listPlanDocsSummary } from '../../lib/plan-index.mjs'

/** 受管规划文档目录：审计只在这里找可审对象。 */
const AUDITED_PLAN_DIRS = ['docs/prd', 'docs/specs', 'docs/todo']

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

export function listDocs(repoRoot) {
  return listPlanDocsSummary(repoRoot)
}

export function runRepoDocsAudit(repoRoot, scope, { auditDoc, checkOrphanSlices, evaluateSliceGraph = null }) {
  // 两边都先归一化到真实路径，再算相对路径。
  //
  // 调用方给过来的 root 通常已按 `realpath` 归一（`resolveRepoRoots` 就是这么做的），
  // 而 scope 参数是用户原样敲的路径。只要这条路径经过符号链接或短文件名，
  // 两边就不在同一个坐标系里，`relative()` 算出 `../../xxx/docs` 这种仓外相对路径，
  // 一份文档都匹配不上，于是返回 `auditedCount: 0, ok: true`——**一份都没查，却报全部通过**。
  // 这种假绿比报错危险：它让人以为审过了。
  const rootAbs = canonicalPath(repoRoot)
  const scopeAbs = canonicalPath(resolve(repoRoot, scope))
  const scopeRel = posixPath(relative(rootAbs, scopeAbs))
  const targets = []
  const preservedForeignPlanDocs = []
  for (const d of AUDITED_PLAN_DIRS) {
    const dirAbs = join(rootAbs, d)
    if (!existsSync(dirAbs)) continue
    for (const item of collectMarkdownFiles(dirAbs, rootAbs)) {
      if (!scopeRel || scopeRel === '.' || item.rel === scopeRel || item.rel.startsWith(`${scopeRel}/`)) {
        const text = readTextSafe(item.abs) ?? ''
        if (isManagedPlanDoc(item.rel, text)) targets.push(item.rel)
        else preservedForeignPlanDocs.push(item.rel)
      }
    }
  }
  const results = targets.map((file) => auditDoc({ repoRoot: rootAbs, file }))
  // 切片图检查只在整仓范围跑：它判的是「切片之间」的关系，单文件审计时那些关系
  // 根本不在这份视野里，跑出来的结论只会是缺上下文导致的误报；总控覆盖单源依赖 evaluateSliceGraph。
  const sliceGraph = (typeof evaluateSliceGraph === 'function' && (!scopeRel || scopeRel === '.'))
    ? evaluateSliceGraph(rootAbs)
    : { ok: true, errors: [] }
  const coverageErrors = [
    ...checkOrphanSlices(repoRoot),
    ...(sliceGraph.errors ?? []),
  ]
  const allErrors = [...results.flatMap((r) => r.errors ?? []), ...coverageErrors]
  const failedCount = results.filter((r) => !r.ok).length + (coverageErrors.length > 0 ? 1 : 0)
  return {
    ok: allErrors.length === 0,
    scope: scopeRel || '.',
    auditedCount: results.length,
    preservedCount: preservedForeignPlanDocs.length,
    preservedForeignPlanDocs: preservedForeignPlanDocs.sort(),
    failedCount,
    results,
    coverageErrors,
    ...classifyAuditTarget(results.length, preservedForeignPlanDocs.length),
  }
}

/**
 * 审计范围里到底有没有可审的对象。
 *
 * 「一份都没查到」和「查了，全过」是两件事，折成一个 `ok: true` 就是这一片要治的病：
 * 弱模型读到「全部通过」会以为自己审过了。
 *
 * 三种情形各给一个结论，不合并：
 * - `none`：范围内一份文档都没有；
 * - `unmanaged`：有文档，但没有一份是受管规划文档（`docs/prd|specs|todo` 之外的手写文件）；
 * - `audited`：有受管文档，`ok` 才开始表示「审过且全过」。
 */
function classifyAuditTarget(auditedCount, preservedCount) {
  if (auditedCount > 0) return { applicable: true, auditOutcome: 'audited' }
  if (preservedCount > 0) return { applicable: false, auditOutcome: 'unmanaged' }
  return { applicable: false, auditOutcome: 'none' }
}

/** 「未适用」结论的人话说明，区分「没有文档」与「有文档但不是受管类型」。 */
export function describeAuditNotApplicable(outcome, { scope, preservedCount = 0 } = {}) {
  if (outcome === 'unmanaged') {
    return `范围内有 ${preservedCount} 份文档，但没有一份是受管规划文档（docs/prd、docs/specs、docs/todo）：未适用`
  }
  return `范围内没有任何受管规划文档（${scope ?? '.'}）：未适用`
}
