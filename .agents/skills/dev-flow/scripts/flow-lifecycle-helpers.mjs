/**
 * flow-lifecycle-helpers.mjs —— finalize/rework 辅助函数与返工命令实现，供 flow-lifecycle.mjs 复用。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { evaluateCoupledSync, parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter } from '../../lib/docs.mjs'
import { gitRun, readTextSafe } from '../../lib/git.mjs'
import { resolveRefShaFast } from '../../lib/git-fast.mjs'
import { resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { appendGovernSignal } from '../../lib/signals.mjs'
import { matchGlob } from '../../lib/static-gates.mjs'
import { getChangedFiles } from './flow-inspect.mjs'

export function computeFlowCoupledSync(implRoot, mainRoot, changedFiles) {
  const agentsRoot = existsSync(join(implRoot, 'AGENTS.md')) ? implRoot : mainRoot
  const agentsText = readTextSafe(join(agentsRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  return rules.length > 0 ? evaluateCoupledSync(changedFiles, rules, agentsRoot) : []
}

export async function collectFinalizeChangedFiles(implRoot, ledger, statusEntries, gitCommonDir = null, headSha = null, preDiffEntries = undefined) {
  const baseDiffEntries = Array.isArray(preDiffEntries)
    ? preDiffEntries
    : (ledger.baseSha && headSha && headSha === ledger.baseSha ? [] : undefined)
  const merged = new Set(await getChangedFiles(implRoot, ledger.baseSha, { statusEntries, diffEntries: baseDiffEntries }))
  for (const baseRef of [...new Set([ledger.baseBranch, 'main', 'master'].filter(Boolean))]) {
    const fastRefSha = gitCommonDir ? resolveRefShaFast(gitCommonDir, `refs/heads/${baseRef}`) : null
    if (fastRefSha && ledger.baseSha && fastRefSha === ledger.baseSha) break
    const mb = await gitRun(implRoot, ['--no-optional-locks', 'merge-base', baseRef, 'HEAD'])
    const mbSha = mb.ok ? mb.stdout?.trim() : ''
    if (mbSha) {
      if (mbSha !== ledger.baseSha) {
        for (const f of await getChangedFiles(implRoot, mbSha, { statusEntries })) merged.add(f)
      }
      break
    }
  }
  return [...merged].sort()
}

export function findUncheckedLines(text) {
  const out = []
  let inFence = false
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence && /^- \[ \]/.test(line) && !/(?:<!--\s*waive:|\[waive:|豁免|跳过原因)/i.test(line)) out.push(line.trim())
  }
  return out
}

export function findStrictDocBySlug(root, dirRel, ledger) {
  const abs = join(root, dirRel)
  if (!existsSync(abs)) return null
  try {
    for (const n of readdirSync(abs).filter((x) => x.endsWith('.md')).sort()) {
      const fn = parseDocFilename(n)
      if (fn && fn.slug === ledger.slug) return `${dirRel}/${n}`
      const fm = parseDocFrontmatter(readTextSafe(join(abs, n)) ?? '')
      if (fm.data?.task_id === ledger.taskId) return `${dirRel}/${n}`
    }
  } catch { /* ignore */ }
  return null
}

export async function emitFlowSignal(roots, payload) {
  await appendGovernSignal({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, isGit: roots.isGit, ...payload })
}

export async function handleRework(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const profile = parseAgentsProfile(implRoot)
  const changed = await getChangedFiles(implRoot, ledger.baseSha)

  // 豁免由 finalize 成对自动归档移入 docs/archive/ 的关联文档，避免与 do-not-edit: docs/archive/ 自相冲突
  const ownArchived = new Set([ledger.archivedTodoFile, ledger.archivedSpecFile, ledger.archivedPrdFile].filter(Boolean))
  const forbiddenTouched = changed.filter((f) => !ownArchived.has(f) && profile.doNotEdit.some((pat) => matchGlob(f, pat)))
  const rebutsInput = Array.isArray(opts.rebut) ? opts.rebut : (opts.rebut ? [opts.rebut] : [])
  const addedRebuts = []

  for (const raw of rebutsInput) {
    const idx = raw.indexOf(':')
    const findingId = idx > 0 ? raw.slice(0, idx).trim() : 'general'
    const reason = idx > 0 ? raw.slice(idx + 1).trim() : raw.trim()
    const item = { findingId, reason, recordedAt: new Date().toISOString() }
    addedRebuts.push(item)
    ledger.rebuts = [...(ledger.rebuts ?? []), item]
    if ((ledger.rounds ?? []).length > 0) {
      const last = ledger.rounds[ledger.rounds.length - 1]
      last.rebuts = [...(last.rebuts ?? []), item]
    }
  }

  ledger.status = 'rework'
  writeTaskLedger(roots.mainRoot, ledger)
  await emitFlowSignal(roots, { category: 'hygiene', module: 'workflow', pattern: 'flow.rework', severity: 'medium', source: 'flow-rework', file: changed[0] ?? '', taskId, message: `rework entered (rebuts=${addedRebuts.length}, forbidden=${forbiddenTouched.length})`, meta: { forbiddenTouched, rebutCount: addedRebuts.length } })
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, branch: ledger.branch, prNumber: ledger.prNumber, forbiddenTouched, addedRebuts }, null, 2)}\n`)
  else {
    process.stdout.write(`进入返工模式（task=${taskId}，原分支=${ledger.branch}，原 PR=${ledger.prNumber ?? '待创建'}）：\n`)
    if (forbiddenTouched.length > 0) process.stdout.write(`- 警告：以下变更命中 do-not-edit 列表：${forbiddenTouched.join(', ')}\n`)
    if (addedRebuts.length > 0) process.stdout.write(`- 已记录 ${addedRebuts.length} 条有据反驳。\n`)
    printNextStep([{ skill: 'dev-flow', text: `1. node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }, { skill: 'dev-flow', text: `2. node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId} --rework` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}
