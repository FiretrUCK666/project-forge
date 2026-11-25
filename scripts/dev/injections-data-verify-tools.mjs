#!/usr/bin/env node
/**
 * injections-data-verify-tools.mjs —— 验证工具生命周期、feature-map 单源、免日期过时校验与先实证后 Diff 审查故障注入复验表（I197–I207）。
 *
 * 导出 `INJECTIONS_VERIFY_TOOLS` 供 `injections-data.mjs` 自动发现加载，
 * 也可直接运行 `node scripts/dev/injections-data-verify-tools.mjs` 在隔离临时副本中逐条实证。
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { isMainModule } from '../../kit/skills/lib/git.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const INJECTIONS_VERIFY_TOOLS = [
  {
    id: 'I197',
    what: 'C9 validateFeatureMap 放行受跟踪 feature-map 内的易变哈希与手工日期字段',
    file: 'kit/skills/lib/feature-map.mjs',
    alsoDropIn: ['.agents/skills/lib/feature-map.mjs'],
    from: '        for (const key of FORBIDDEN_TRACKED_KEYS) {\n          if (Object.prototype.hasOwnProperty.call(tool, key)) {',
    to: '        for (const key of FORBIDDEN_TRACKED_KEYS) {\n          if (false && Object.prototype.hasOwnProperty.call(tool, key)) {',
    expect: 'StageC C9',
  },
  {
    id: 'I198',
    what: 'C9 isSafeTaskScratchPath 放松仓外前缀校验导致主仓/父目录越界放行',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: '  if (samePath(cand, scratchRoot)) return false',
    to: '  if (samePath(cand, scratchRoot)) return true',
    expect: 'StageC C9',
  },
  {
    id: 'I199',
    what: 'C9 destroyTaskScratchDir 销毁非空 scratch 前跳过写入 verify.scratch-used 信号',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: '  if (recordSignal && (info.fileCount > 0 || Boolean(info.meta))) {',
    to: '  if (false && recordSignal && (info.fileCount > 0 || Boolean(info.meta))) {',
    expect: 'StageC C9',
  },
  {
    id: 'I200',
    what: 'C9 detectScratchSolidificationHints 放宽跨 >=2 PR 阈值导致 1 个任务误报固化提示',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: '    if (bucket.taskIds.size < minTasks) continue',
    to: '    if (false && bucket.taskIds.size < minTasks) continue',
    expect: 'StageC C9',
  },
  {
    id: 'I201',
    what: 'C10 evaluateToolStaleness 忽略 symbol-index 导出符号哈希漂移',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: '  const symbolDrift = currentFp.symbolHash !== baseline.symbolHash',
    to: '  const symbolDrift = false',
    expect: 'StageC C10',
  },
  {
    id: 'I202',
    what: 'C10 verify-tools run 放松高风险过期工具硬阻断',
    file: 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs',
    alsoDropIn: ['.agents/skills/dev-verify-tools/scripts/verify-tools.mjs'],
    from: "    if (staleness.status === 'stale' && tool.riskLevel === 'high' && !refreshBaseline && !liveE2eCmd && !staleOnly) {",
    to: "    if (false && staleness.status === 'stale' && tool.riskLevel === 'high' && !refreshBaseline && !liveE2eCmd && !staleOnly) {",
    expect: 'StageC C10',
  },
  {
    id: 'I203',
    what: 'C11 evaluateTextSubstance 放行无实质水话（ok/pass/lgtm/done/已验证）',
    file: 'kit/skills/lib/evidence-substance.mjs',
    alsoDropIn: ['.agents/skills/lib/evidence-substance.mjs'],
    from: '  if (!lowered || SHALLOW_EXACT_SET.has(lowered)) {',
    to: '  if (false && (!lowered || SHALLOW_EXACT_SET.has(lowered))) {',
    expect: 'StageC C11',
  },
  {
    id: 'I204',
    what: 'C11 review-empirical handleCheckEmpirical 跳过防敷衍 --e2e-evidence 硬拦截',
    file: 'kit/skills/dev-review/scripts/review-empirical.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-empirical.mjs'],
    from: '  const evInput = resolveAndValidateE2eEvidenceInput(opts)\n  if (!evInput.ok) {',
    to: '  const evInput = resolveAndValidateE2eEvidenceInput(opts)\n  if (false && !evInput.ok) {',
    expect: 'StageC C11',
  },
  {
    id: 'I205',
    what: 'C11 review-context buildModuleNeighbors 漏扫逆向调用邻域（incoming）',
    file: 'kit/skills/dev-review/scripts/review-context.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-context.mjs'],
    from: '    if (hit && !incomingMap.has(f.rel)) {',
    to: '    if (false && hit && !incomingMap.has(f.rel)) {',
    expect: 'StageC C11',
  },
  {
    id: 'I206',
    what: 'C12 verify-tools create 沉淀脚本时跳过 edit-gate 词法静态门禁拦截',
    file: 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs',
    alsoDropIn: ['.agents/skills/dev-verify-tools/scripts/verify-tools.mjs'],
    from: '    if (!editGateRes.ok) {\n      rollbackCopiedScript()',
    to: '    if (false && !editGateRes.ok) {\n      rollbackCopiedScript()',
    expect: 'StageC C12',
  },
  {
    id: 'I207',
    what: 'C9 guardExistingFeatureMapForWrite 对损坏 docs/feature-map.json 退化为静默覆盖而非 Fail-Closed',
    file: 'kit/skills/dev-verify-tools/scripts/verify-tools-audit.mjs',
    alsoDropIn: ['.agents/skills/dev-verify-tools/scripts/verify-tools-audit.mjs'],
    from: '  if (!st.corrupt) return { ok: true, status: st }',
    to: '  if (true || !st.corrupt) return { ok: true, status: st }',
    expect: 'StageC C9',
  },
  {
    id: 'I208',
    what: 'FMv2 C1 validateFeatureMapTopology 跳过 dependsOn 环路检测放行循环依赖',
    file: 'kit/skills/lib/feature-map-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/feature-map-graph.mjs'],
    from: '      if (st === 1) {\n        const idx = stack.indexOf(v)',
    to: '      if (false && st === 1) {\n        const idx = stack.indexOf(v)',
    expect: 'FMv2 C1',
    standaloneFixture: 'fixtures-feature-map-v2.mjs',
  },
  {
    id: 'I209',
    what: 'FMv2 C1 validateFeatureMapTopology 跳过 flows[] FORBIDDEN_TRACKED_KEYS 易变字段扫描',
    file: 'kit/skills/lib/feature-map-graph.mjs',
    alsoDropIn: ['.agents/skills/lib/feature-map-graph.mjs'],
    from: '        scanForbiddenKeysOnObject(fl, `flow "${flId || i}"`, errors)',
    to: '        if (false) scanForbiddenKeysOnObject(fl, `flow "${flId || i}"`, errors)',
    expect: 'FMv2 C1',
    standaloneFixture: 'fixtures-feature-map-v2.mjs',
  },
  {
    id: 'I222',
    what: 'FMv2 C4 checkFeatureMapSyncOnFinalize 绕过 BLOCKED_FEATURE_MAP_TOPOLOGY 拓扑门禁',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'],
    from: '  if (featureMapUpdated || addedCoreModules.length > 0 || removedCoreModules.length > 0) {\n    const topo = validateFeatureMapTopology(fm.data)',
    to: '  if (false && (featureMapUpdated || addedCoreModules.length > 0 || removedCoreModules.length > 0)) {\n    const topo = validateFeatureMapTopology(fm.data)',
    expect: 'FMv2 C4',
    standaloneFixture: 'fixtures-feature-map-v2.mjs',
  },
]

function copyRepoForSandbox(srcRoot, dstRoot) {
  for (const rel of ['kit', '.agents', 'scripts']) {
    cpSync(join(srcRoot, rel), join(dstRoot, rel), { recursive: true })
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const sandbox = mkdtempSync(join(tmpdir(), 'pf-vt-inj-'))
  let failed = 0
  try {
    copyRepoForSandbox(ROOT, sandbox)
    for (const inj of INJECTIONS_VERIFY_TOOLS) {
      const targets = [inj.file, ...(inj.alsoDropIn ?? [])]
      const backups = []
      let applied = true
      for (const rel of targets) {
        const abs = join(sandbox, rel)
        const orig = readFileSync(abs, 'utf8')
        if (!orig.includes(inj.from)) {
          process.stderr.write(`FAIL [${inj.id}]: target snippet not found in ${rel}\n`)
          applied = false
          break
        }
        backups.push({ abs, orig })
        writeFileSync(abs, orig.replace(inj.from, inj.to), 'utf8')
      }
      if (!applied) {
        failed += 1
        for (const b of backups) writeFileSync(b.abs, b.orig, 'utf8')
        continue
      }
      const targetFixture = inj.standaloneFixture || 'fixtures-verify-tools.mjs'
      const res = spawnSync(process.execPath, [join(sandbox, 'scripts', 'dev', targetFixture)], {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      })
      for (const b of backups) writeFileSync(b.abs, b.orig, 'utf8')
      const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
      if (res.status === 0 || !combined.includes(inj.expect)) {
        failed += 1
        process.stderr.write(`FAIL [${inj.id}] ${inj.what}: expected red with "${inj.expect}", got exit=${res.status}\n${combined.slice(0, 400)}\n`)
      } else {
        process.stdout.write(`CAUGHT [${inj.id}] ${inj.what}\n`)
      }
    }
    process.stdout.write(`\nverify-tools 故障注入汇总：${INJECTIONS_VERIFY_TOOLS.length - failed}/${INJECTIONS_VERIFY_TOOLS.length} 精准拦截，${failed} 失败。\n`)
    await flushAndExit(failed === 0 ? 0 : 1)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}
