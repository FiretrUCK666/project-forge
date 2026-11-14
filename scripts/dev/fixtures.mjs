#!/usr/bin/env node
/**
 * fixtures.mjs —— 行为断言调度入口：汇聚全部行为夹具子模块实跑断言并输出汇总。
 */

import { initTestBackupDir } from './fixtures-helpers.mjs'
import { registerCoreCases } from './fixtures-core.mjs'
import { registerContractCases } from './fixtures-contracts.mjs'
import { registerReviewCases } from './fixtures-review.mjs'
import { registerClaimsCases } from './fixtures-claims.mjs'
import { registerV5WaveCases } from './fixtures-v5-waves.mjs'
import { registerV5LateCases } from './fixtures-v5-late.mjs'
import { registerV5SyncCases } from './fixtures-v5-sync.mjs'
import { registerV6PlatformCases } from './fixtures-v6-platform.mjs'
import { registerV6KitCases } from './fixtures-v6-kit.mjs'

initTestBackupDir()

const cases = []
registerCoreCases(cases)
registerContractCases(cases)
registerReviewCases(cases)
registerClaimsCases(cases)
registerV5WaveCases(cases)
registerV5LateCases(cases)
registerV5SyncCases(cases)
registerV6PlatformCases(cases)
registerV6KitCases(cases)

function parseCliFlags(argv) {
  let prefer = ''
  let bailOn = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prefer' && i + 1 < argv.length) { prefer = argv[++i]; continue }
    if (arg.startsWith('--prefer=')) { prefer = arg.slice('--prefer='.length); continue }
    if (arg === '--bail-on' && i + 1 < argv.length) { bailOn = argv[++i]; continue }
    if (arg.startsWith('--bail-on=')) { bailOn = arg.slice('--bail-on='.length); continue }
  }
  return { prefer, bailOn }
}

const { prefer, bailOn } = parseCliFlags(process.argv.slice(2))
const orderedCases = prefer
  ? [
      ...cases.filter(([name, fn]) => name.includes(prefer) || fn.toString().includes(prefer)),
      ...cases.filter(([name, fn]) => !name.includes(prefer) && !fn.toString().includes(prefer)),
    ]
  : cases

let passed = 0
const failures = []

for (const [name, fn] of orderedCases) {
  let entry = ''
  try {
    const outcome = await fn()
    if (outcome === true) { passed += 1; continue }
    entry = `${name} —— ${outcome}`
  } catch (error) {
    entry = `${name} —— 抛异常：${error instanceof Error ? error.message : String(error)}`
  }
  failures.push(entry)
  if (bailOn && `FAIL  ${entry}`.includes(bailOn)) break
}

if (failures.length === 0) {
  process.stdout.write(`行为断言：${passed} 项通过，0 项失败。\n`)
  process.exit(0)
}
for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
process.stderr.write(`\n行为断言：${passed} 通过 / ${failures.length} 失败。\n`)
process.exit(1)
