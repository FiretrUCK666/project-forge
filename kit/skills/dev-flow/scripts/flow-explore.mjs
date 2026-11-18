/**
 * flow-explore.mjs —— 只读探索证据采集（写入账本 explored 字段，严禁篡改业务/源码跟踪文件）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs explore 调度。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { readTextSafe } from '../../lib/git.mjs'
import { createExploredEvidence, resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import { generateRepoMap } from '../../dev-explore/scripts/repo-map.mjs'

function detectExploreTier(workRoot, map) {
  const agentsText = readTextSafe(join(workRoot, 'AGENTS.md')) ?? ''
  const stratMatch = /策略级别[^\n`]*`([a-z-]+)`/i.exec(agentsText)
  if (stratMatch) return stratMatch[1]
  if ((map?.codeFileCount ?? 0) >= 25) return 'parallel-subagents'
  if ((map?.codeFileCount ?? 0) >= 6) return 'single-subagent'
  return 'direct-read'
}

export async function handleExplore(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const workRoot = existsSync(implRoot) ? implRoot : roots.mainRoot

  const map = await generateRepoMap(workRoot, { focus: opts.focus })
  const tier = opts.tier ? String(opts.tier).trim() : detectExploreTier(workRoot, map)
  const by = opts.by ?? opts.agent ?? ledger.implementerId ?? 'dev-flow'
  const explored = createExploredEvidence({
    at: new Date().toISOString(),
    tier,
    symbolCount: map.symbolCount ?? 0,
    by,
    source: 'repo-map',
  })

  ledger.explored = explored
  writeTaskLedger(roots.mainRoot, ledger)

  const out = {
    ok: true,
    taskId,
    explored,
    codeFileCount: map.codeFileCount ?? 0,
    symbolCount: map.symbolCount ?? 0,
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  } else {
    process.stdout.write(`探索证据已记入账本（task=${taskId}, tier=${explored.tier}, symbols=${explored.symbolCount}, at=${explored.at}）。\n`)
    printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${taskId}` }], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0, payload: out }
}
