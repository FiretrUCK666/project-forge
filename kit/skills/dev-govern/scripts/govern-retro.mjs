/**
 * govern-retro.mjs —— `govern-audit.mjs retro`：聚合运行期 `signals.jsonl` 与任务账本，
 * 生成 rule / gate / fixture / profile 建议补丁，并在 `--apply-patches` 时安全幂等落盘。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），严禁改写 `AGENTS.md` 受管区间。
 */

import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import { buildDocFilename, docIsoDate, serializeDocFrontmatter, slugify } from '../../lib/docs.mjs'
import { posixPath, readTextSafe, writeAtomic } from '../../lib/git.mjs'
import { listTaskLedgers, sanitizeTaskId } from '../../lib/ledger.mjs'
import { readSignalsJsonl, resolveGovernStateDir } from '../../lib/signals.mjs'
import { AGENTS_MAX_BYTES } from './govern-checks.mjs'

const RETRO_START = '<!-- govern-retro: begin -->'
const RETRO_END = '<!-- govern-retro: end -->'

function collectLedgerStats(ledgers) {
  const disp = { fixed: 0, rebuttedWrong: 0, intentional: 0, deferred: 0, total: 0 }
  const stopLossTasks = []
  const queueConflictTasks = []
  const fileCounts = new Map()

  for (const ledger of ledgers) {
    const tid = ledger.taskId
    const rounds = Array.isArray(ledger.rounds) ? ledger.rounds : []
    if (ledger.lastReview?.stopLossTriggered || rounds.some((r) => r.stopLossTriggered)) {
      stopLossTasks.push(tid)
    }
    if (ledger.queueConflict) queueConflictTasks.push({ taskId: tid, code: ledger.queueConflict.code ?? 'CONFLICT' })
    for (const r of rounds) {
      for (const m of r.mustFix ?? []) {
        const f = posixPath(m?.file ?? '').trim()
        if (f) fileCounts.set(f, (fileCounts.get(f) ?? 0) + 1)
      }
      for (const d of r.dispositions ?? []) {
        const kind = String(d?.disposition ?? '').toLowerCase()
        if (kind === 'fixed') disp.fixed += 1
        else if (kind === 'rebutted-wrong') disp.rebuttedWrong += 1
        else if (kind === 'intentional') disp.intentional += 1
        else if (kind === 'deferred') disp.deferred += 1
      }
    }
  }
  disp.total = disp.fixed + disp.rebuttedWrong + disp.intentional + disp.deferred
  const falsePositiveCount = disp.rebuttedWrong + disp.intentional
  const falsePositiveRate = disp.total > 0 ? Number((falsePositiveCount / disp.total).toFixed(4)) : 0
  return {
    dispositionSummary: { ...disp, falsePositiveCount, falsePositiveRate },
    stopLossTasks,
    queueConflictTasks,
    ledgerFileCounts: fileCounts,
  }
}

export function buildRetroReport({ workTreeRoot, mainRoot, gitDir, isGit, taskFilter = null, signals, ledgers }) {
  const repeatedMap = new Map()
  const fileHotspotCounts = new Map()

  for (const ev of signals) {
    const pat = String(ev?.pattern ?? 'signal')
    const mod = String(ev?.module ?? 'repo')
    const sev = String(ev?.severity ?? 'medium').toLowerCase()
    const isPassSignal = sev === 'info' || /\.pass$/.test(pat)
    if (!isPassSignal) {
      const key = `${mod}::${pat}`
      if (!repeatedMap.has(key)) {
        repeatedMap.set(key, { key, module: mod, pattern: pat, category: ev.category ?? 'hygiene', count: 0, files: new Set(), messages: [] })
      }
      const item = repeatedMap.get(key)
      item.count += 1
      if (ev.file) {
        const f = posixPath(ev.file)
        item.files.add(f)
        fileHotspotCounts.set(f, (fileHotspotCounts.get(f) ?? 0) + 1)
      }
      if (ev.message && item.messages.length < 3) item.messages.push(String(ev.message).slice(0, 120))
    }
  }

  const lStats = collectLedgerStats(ledgers)
  for (const [f, cnt] of lStats.ledgerFileCounts.entries()) {
    fileHotspotCounts.set(f, (fileHotspotCounts.get(f) ?? 0) + cnt)
  }

  const repeatedFailures = [...repeatedMap.values()]
    .filter((x) => x.count >= 2)
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key))
    .map((x) => ({ ...x, files: [...x.files].sort() }))

  const hotspots = [...fileHotspotCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([file, count]) => ({ file, count }))

  const patches = []
  for (const rf of repeatedFailures) {
    const isVerifyOrRework = /^(?:verify\.|flow\.rework)/.test(rf.pattern)
    patches.push({
      targetKind: isVerifyOrRework ? 'profile' : 'gate',
      targetFile: 'AGENTS.md',
      reason: `信号 ${rf.key} 重复出现 ${rf.count} 次`,
      patchPreview: isVerifyOrRework
        ? `- [retro/${rf.pattern}] 在迭代期提前运行 quick-test/smoke-verify 拦截 ${rf.key}（已复发 ${rf.count} 次）`
        : `- [retro/${rf.pattern}] 将 ${rf.module} 的 ${rf.pattern} 下沉至 AGENTS.md arch-rules 或静态检查`,
    })
  }

  const ds = lStats.dispositionSummary
  if (ds.falsePositiveCount >= 2 || (ds.total >= 2 && ds.falsePositiveRate >= 0.4)) {
    patches.push({
      targetKind: 'rule',
      targetFile: 'AGENTS.md',
      reason: `审查误报处置占比偏高（rebutted-wrong=${ds.rebuttedWrong}, intentional=${ds.intentional}, rate=${(ds.falsePositiveRate * 100).toFixed(1)}%）`,
      patchPreview: `- [retro/review-fp] 独立审查优先信任确定性静态门禁与实证结果，避免对已反驳/刻意设计模式重复挑刺（误报率 ${(ds.falsePositiveRate * 100).toFixed(1)}%）`,
    })
  }

  for (const hs of hotspots.slice(0, 3)) {
    patches.push({
      targetKind: 'fixture',
      targetFile: hs.file,
      reason: `热点文件 ${hs.file} 在信号/返工中出现 ${hs.count} 次`,
      patchPreview: `- [retro/hotspot] 为 ${hs.file} 增补正反双向回归夹具并检查模块边界`,
    })
  }
  for (const tid of lStats.stopLossTasks) {
    if (!patches.some((p) => p.targetKind === 'fixture')) {
      patches.push({
        targetKind: 'fixture',
        targetFile: 'docs/todo/',
        reason: `任务 ${tid} 触发独立审查停损熔断`,
        patchPreview: `- [retro/stop-loss] 任务 ${tid} 曾触发 3 轮停损，须补齐架构边界与回归门禁用例`,
      })
    }
  }

  return {
    mode: 'retro',
    repoRoot: posixPath(workTreeRoot),
    mainRoot: posixPath(mainRoot),
    taskFilter,
    signalCount: signals.length,
    ledgerCount: ledgers.length,
    repeatedFailures,
    dispositionSummary: ds,
    hotspots,
    stopLossTasks: lStats.stopLossTasks,
    queueConflictTasks: lStats.queueConflictTasks,
    patches,
  }
}

function applyRetroPatches(workRoot, report) {
  const appliedFiles = []
  if (!report.patches.length) return appliedFiles

  const slug = slugify(report.taskFilter ? `retro-${report.taskFilter}` : 'retro-governance')
  const todoRel = `docs/todo/${buildDocFilename({ slug, kind: 'todo' })}`
  const todoAbs = join(workRoot, todoRel)
  const today = docIsoDate()
  const fm = serializeDocFrontmatter({
    kind: 'todo',
    title: `治理复盘建议补丁 (${report.taskFilter ?? 'repo'})`,
    status: 'active',
    created: today,
    updated: today,
    issue: null,
    pr: null,
    branch: null,
    owner: 'govern-retro',
    approved: false,
    done_at: null,
    task_id: report.taskFilter ?? slug,
    planned_at: 'HEAD',
    related_prd: null,
    related_spec: null,
  }, ['kind', 'title', 'status', 'created', 'updated', 'issue', 'pr', 'branch', 'owner', 'approved', 'done_at', 'task_id', 'planned_at', 'related_prd', 'related_spec'])

  const criteriaLines = report.patches.map((p, idx) => `- [ ] C${idx + 1}: [${p.targetKind}] ${p.reason} -> \`${p.targetFile}\``)
  const previewLines = report.patches.map((p) => `  - ${p.patchPreview}`)
  const todoContent = [
    fm.trimEnd(), '',
    `# Todo: 治理复盘建议补丁 (${report.taskFilter ?? 'repo'})`, '',
    '## 本期不做', '',
    '- 本任务单仅沉淀复盘规则/门禁补丁，不直接改写无关业务代码。', '',
    '## 门型与回滚路径', '',
    '- 门型：two-way；删除本草稿或 `git revert` 即可无损回退。', '',
    '## 验收标准', '', ...criteriaLines, '',
    '## 建议补丁预览', '', ...previewLines, '',
    '## 断点与遗留决策', '',
    '- **当前状态**：`待确认落盘`',
    '- **待拍板事项**：确认是否将建议规则合入永久门禁/夹具', '',
    '## 完成后的记录', '',
    '**在合并之前写完，随这次改动一起提交。**', '',
    '- **实际验证命令与结果**：', '',
  ].join('\n')
  mkdirSync(dirname(todoAbs), { recursive: true })
  writeAtomic(todoAbs, todoContent)
  appliedFiles.push(todoRel)

  const agentsAbs = join(workRoot, 'AGENTS.md')
  const agentsRulePatches = report.patches.filter((p) => p.targetKind === 'rule' || p.targetKind === 'profile' || p.targetKind === 'gate')
  if (existsSync(agentsAbs) && agentsRulePatches.length > 0) {
    const rawAgents = readTextSafe(agentsAbs) ?? ''
    const retroSection = [
      RETRO_START,
      '## 治理复盘补充规则（非受管区）',
      '',
      ...agentsRulePatches.map((p) => p.patchPreview),
      RETRO_END,
    ].join('\n')
    const blockRe = new RegExp(`${RETRO_START}[\\s\\S]*?${RETRO_END}`)
    const nextAgents = blockRe.test(rawAgents)
      ? rawAgents.replace(blockRe, retroSection)
      : `${rawAgents.trimEnd()}\n\n${retroSection}\n`
    if (Buffer.byteLength(nextAgents, 'utf8') <= AGENTS_MAX_BYTES - 1024) {
      writeAtomic(agentsAbs, nextAgents)
      appliedFiles.push('AGENTS.md')
    }
  }
  return appliedFiles
}

export async function handleRetro(workRoot, mainRoot, gitDir, isGit, opts) {
  const stateDir = resolveGovernStateDir(mainRoot, gitDir, isGit)
  const { signalsPath, events } = readSignalsJsonl(stateDir)
  const rawTask = opts.task ? String(opts.task).trim() : null
  const cleanTask = rawTask ? sanitizeTaskId(rawTask) : null
  const signals = cleanTask
    ? events.filter((e) => e.taskId === cleanTask || e.taskId === rawTask)
    : events
  const allLedgers = listTaskLedgers(mainRoot, { includeTerminal: true })
  const ledgers = cleanTask
    ? allLedgers.filter((l) => l.taskId === cleanTask || l.taskId === rawTask)
    : allLedgers

  const report = buildRetroReport({
    workTreeRoot: workRoot, mainRoot, gitDir, isGit, taskFilter: cleanTask, signals, ledgers,
  })
  report.signalsPath = posixPath(signalsPath)
  report.appliedPatches = opts.applyPatches ? applyRetroPatches(workRoot, report) : []

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else {
    const lines = [
      '=== DEV-GOVERN (RETRO) ===',
      `Signals File   : ${report.signalsPath} (${report.signalCount} event(s))`,
      `Task Ledgers   : ${report.ledgerCount}${cleanTask ? ` (filter=${cleanTask})` : ''}`,
      `Repeat Fails   : ${report.repeatedFailures.length}`,
      `False Positive : ${(report.dispositionSummary.falsePositiveRate * 100).toFixed(1)}% (${report.dispositionSummary.falsePositiveCount}/${report.dispositionSummary.total})`,
      `Hotspots       : ${report.hotspots.length}`,
      `Suggested Patch: ${report.patches.length}`,
    ]
    for (const p of report.patches) {
      lines.push(`  - [${p.targetKind}] ${p.targetFile}: ${p.reason}`, `      ${p.patchPreview}`)
    }
    if (report.appliedPatches.length > 0) {
      lines.push(`Applied Files  : ${report.appliedPatches.join(', ')}`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    printNextStep([
      report.patches.length > 0 && !opts.applyPatches
        ? 'Review patches above and pass `--apply-patches` to write a draft Todo/non-managed note.'
        : 'Continue verification with `node ".agents/skills/dev-govern/scripts/govern-audit.mjs" audit .`.',
    ], { repoRoot: mainRoot })
  }
  return 0
}
