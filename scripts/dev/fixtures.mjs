#!/usr/bin/env node
/**
 * fixtures.mjs —— 行为断言调度入口：汇聚全部行为夹具子模块实跑断言并输出汇总。
 */

import { cpus } from 'node:os'

import { initTestBackupDir } from './fixtures-helpers.mjs'
import { registerCoreCases } from './fixtures-core.mjs'
import { registerSurveyCases } from './fixtures-survey.mjs'
import { registerContractCases } from './fixtures-contracts.mjs'
import { registerReviewCases } from './fixtures-review.mjs'
import { registerClaimsCases } from './fixtures-claims.mjs'
import { registerExploreCases } from './fixtures-explore.mjs'
import { registerDocsCases } from './fixtures-docs.mjs'
import { registerFlowCases } from './fixtures-flow.mjs'
import { registerGovernCases } from './fixtures-govern.mjs'
import { registerEquipCases } from './fixtures-equip.mjs'
import { registerPlatformCases } from './fixtures-platform.mjs'

initTestBackupDir()

const cases = []
registerSurveyCases(cases)
registerCoreCases(cases)
registerContractCases(cases)
registerReviewCases(cases)
registerClaimsCases(cases)
registerExploreCases(cases)
registerDocsCases(cases)
registerFlowCases(cases)
registerGovernCases(cases)
registerEquipCases(cases)
registerPlatformCases(cases)

function parseCliFlags(argv) {
  let prefer = ''
  let bailOn = ''
  let only = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prefer' && i + 1 < argv.length) { prefer = argv[++i]; continue }
    if (arg.startsWith('--prefer=')) { prefer = arg.slice('--prefer='.length); continue }
    if (arg === '--bail-on' && i + 1 < argv.length) { bailOn = argv[++i]; continue }
    if (arg.startsWith('--bail-on=')) { bailOn = arg.slice('--bail-on='.length); continue }
    if (arg === '--only' && i + 1 < argv.length) { only = argv[++i]; continue }
    if (arg.startsWith('--only=')) { only = arg.slice('--only='.length); continue }
  }
  return { prefer, bailOn, only }
}

/** 用例命中的判据：标题或函数体里出现关键字即算命中。 */
function caseMatches(fn, keyword) {
  return fn[0].includes(keyword) || fn[1].toString().includes(keyword)
}

const { prefer, bailOn, only } = parseCliFlags(process.argv.slice(2))

// `--only` 是**筛选**，`--prefer` 只是**排序**：前者少跑，后者全跑。
// 故障注入复验要的是「只跑能证伪这一条注入的用例」，用排序做不到这件事。
const selected = only ? cases.filter((fn) => caseMatches(fn, only)) : cases
if (only && selected.length === 0) {
  process.stderr.write(`没有用例匹配 --only ${only}：关键字写错时会一条都不跑，而「没跑」看着和「全过」一样。\n`)
  process.exit(1)
}
const orderedCases = prefer
  ? [
      ...selected.filter((fn) => caseMatches(fn, prefer)),
      ...selected.filter((fn) => !caseMatches(fn, prefer)),
    ]
  : selected

let passed = 0
const failures = []

// ── 并发执行 ─────────────────────────────────────────────────────────
//
// 用例之间**有共享资源**，所以不能无脑并发：
//
// - `PF_BACKUP_DIR` 是进程级的，`fixtures-equip` 会把自己的值塞进子进程 env，
//   同时别的用例在起 `backup.mjs`、`compose-agents.mjs` 子进程；
// - `fixtures-equip` 会先把 `.agents/skills/dev-flow/SKILL.md` 复制出来改成 CRLF
//   再改回去，目标是它自己的临时仓，但它读的是同一个模块级常量；
// - 一批用例会 spawn `git`，而 `git` 会去读同一个 `~/.gitconfig`、同一份 `~/.ssh`。
//
// 上面这些串行时互不影响，并发时就有概率互相踩到。所以默认**串行**，并发只在显式
// 要求时开启（`--jobs <n>`），并且是排查性能问题的手段，不是合入门禁的默认路径。
//
// 真正把门禁做快，靠的是 `verify-injections.mjs` 的按键定向与按条复制沙盒，不是把
// 互相踩的用例硬塞进同一个时刻。
function resolveLanes(argv) {
  const index = argv.indexOf('--jobs')
  const raw = index >= 0 ? Number(argv[index + 1]) : 1
  if (!Number.isFinite(raw) || raw < 1) return 1
  return Math.min(Math.floor(raw), Math.max(1, cpus().length))
}

const LANES = resolveLanes(process.argv.slice(2))

async function runCase([name, fn]) {
  try {
    const outcome = await fn()
    if (outcome === true) return { ok: true }
    return { ok: false, entry: `${name} —— ${outcome}` }
  } catch (error) {
    return { ok: false, entry: `${name} —— 抛异常：${error instanceof Error ? error.message : String(error)}` }
  }
}

const results = []
if (LANES === 1) {
  for (const entry of orderedCases) {
    const result = await runCase(entry)
    results.push(result)
    if (bailOn && !result.ok && `FAIL  ${result.entry}`.includes(bailOn)) break
  }
} else {
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(LANES, orderedCases.length) }, async () => {
    while (cursor < orderedCases.length) {
      const result = await runCase(orderedCases[cursor++])
      results.push(result)
    }
  }))
}

for (const result of results) {
  if (result.ok) passed += 1
  else failures.push(result.entry)
}

if (failures.length === 0) {
  const scope = only ? `（--only ${only}，共 ${passed} 项）` : ''
  process.stdout.write(`行为断言：${passed} 项通过，0 项失败${scope}。\n`)
  process.exit(0)
}
for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
process.stderr.write(`\n行为断言：${passed} 通过 / ${failures.length} 失败。\n`)
process.exit(1)
