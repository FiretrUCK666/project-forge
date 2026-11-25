/**
 * doc-plan-brief.mjs —— `doc-plan.mjs` 抽离的 `note` / `triage` / `brief` 处理器。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与同层 lib/），位于 `kit/skills/dev-plan/scripts`
 * 对拍扫描作用域内以保持 `doc-plan.mjs < 790` 行并确保所有 `opts.*` 读取点完整可检。
 */

import { spawn } from 'node:child_process'

import { printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { formatContextBriefLines } from '../../lib/context-brief.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { gitStatusPorcelainZ } from '../../lib/git.mjs'
import { readTaskLedger, sanitizeTaskId } from '../../lib/ledger.mjs'
import { resolveDocPlanMode } from '../../lib/pending-decisions.mjs'
import { appendPreInitNote, normalizeTopicId, readSessionState, recordTriageDecision } from '../../lib/session-state.mjs'
import {
  getVisualBriefSummary,
  readBriefSidecar,
  sanitizeBriefKey,
  upsertVisualBrief,
} from '../../lib/visual-brief.mjs'
import { triageTask } from './doc-audit.mjs'

function openInBrowser(uri) {
  try {
    const plat = process.platform
    const cmd = plat === 'win32' ? 'cmd' : (plat === 'darwin' ? 'open' : 'xdg-open')
    const args = plat === 'win32' ? ['/c', 'start', '', uri] : [uri]
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { opened: true, uri }
  } catch (err) {
    return { opened: false, uri, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function handleNoteSubcommand({ opts, cli, repoRoot, mainRoot }) {
  const hasNote = Boolean(
    opts.topic || opts.decision || opts.reset
    || (opts.fact?.length ?? 0) > 0 || (opts.resolve?.length ?? 0) > 0 || (opts.drop?.length ?? 0) > 0
    || (opts.exclude?.length ?? 0) > 0 || (opts.anchor?.length ?? 0) > 0 || (opts.open?.length ?? 0) > 0,
  )
  if (!hasNote) throw new Error('note 至少需要传入 --topic / --fact / --resolve / --drop / --reset / --decision / --exclude / --anchor / --open 之一')

  const prevSess = readSessionState(mainRoot)
  const candTopicId = normalizeTopicId(opts.topic || prevSess?.activeTopic || 'default')
  const prevTopic = prevSess?.topics?.[candTopicId] ?? null
  const hadPriorTurn = Boolean(prevTopic && !prevTopic.consumedByTaskId && prevTopic.updatedAt)

  const noteRes = appendPreInitNote(mainRoot, {
    topic: opts.topic ?? null,
    facts: opts.fact ?? [],
    resolve: opts.resolve ?? [],
    drop: opts.drop ?? [],
    reset: Boolean(opts.reset),
    decision: opts.decision ?? null,
    exclusions: opts.exclude ?? [],
    anchors: opts.anchor ?? [],
    openQuestions: opts.open ?? [],
  })

  // 仅对 Case 3/4 或多轮讨论主题自动触发仓外 Living Visual Brief，Case 1/2 零开销
  const topicTriage = noteRes.topicState?.triage
  const exactTopicCase = (topicTriage && topicTriage.topic === noteRes.topicId) ? Number(topicTriage.caseType ?? 0) : 0
  const shouldTriggerBrief = Boolean(
    Number(topicTriage?.caseType ?? 0) >= 3
    || noteRes.topicState?.briefKey
    || (hadPriorTurn && exactTopicCase !== 1 && exactTopicCase !== 2),
  )
  let visualBrief = null
  if (shouldTriggerBrief) {
    try {
      const briefRes = upsertVisualBrief(mainRoot, {
        workRoot: repoRoot,
        briefKey: noteRes.topicState?.briefKey ?? noteRes.topicId,
        kind: 'topic',
        topicId: noteRes.topicId,
        title: noteRes.preInit?.topic ?? noteRes.topicId,
        nonGoals: noteRes.preInit?.nonGoals ?? [],
        decisions: noteRes.preInit?.decisions ?? [],
        openQuestions: noteRes.preInit?.openQuestions ?? [],
      })
      visualBrief = briefRes.summary
    } catch { /* non-fatal on non-writable root */ }
  }

  const out = visualBrief ? { ok: true, ...noteRes, visualBrief } : { ok: true, ...noteRes }
  if (cli.json) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  } else {
    process.stdout.write(`已写入 Working Brief（topic=${noteRes.topicId}, ${noteRes.byteSize} B）：facts=${Object.keys(noteRes.preInit.facts ?? {}).length}, decisions=${noteRes.preInit.decisions.length}, nonGoals=${noteRes.preInit.nonGoals.length}, anchors=${noteRes.preInit.anchors.length}, open=${(noteRes.preInit.unresolvedOpen ?? noteRes.preInit.openQuestions).length}\n`)
    if (visualBrief) process.stdout.write(`Living Visual Brief (${visualBrief.confirmedState}): ${visualBrief.htmlUri}\n`)
  }
  return 0
}

export async function handleTriageSubcommand({ opts, cli, roots, repoRoot, mainRoot, resolveCliPlanMode }) {
  const hasPreInitNote = Boolean(
    opts.topic || opts.decision || opts.reset
    || (opts.fact?.length ?? 0) > 0 || (opts.resolve?.length ?? 0) > 0 || (opts.drop?.length ?? 0) > 0
    || (opts.exclude?.length ?? 0) > 0 || (opts.anchor?.length ?? 0) > 0 || (opts.open?.length ?? 0) > 0,
  )
  const summary = opts.summary ?? opts._.join(' ')
  if (!summary && !hasPreInitNote) throw new Error('triage 需要传入 --summary "<需求描述>"')
  let noteRes = null
  if (hasPreInitNote) {
    noteRes = appendPreInitNote(mainRoot, {
      topic: opts.topic ?? (summary || null),
      facts: opts.fact ?? [],
      resolve: opts.resolve ?? [],
      drop: opts.drop ?? [],
      reset: Boolean(opts.reset),
      decision: opts.decision ?? null,
      exclusions: opts.exclude ?? [],
      anchors: opts.anchor ?? [],
      openQuestions: opts.open ?? [],
    })
    if (!summary) {
      if (cli.json) process.stdout.write(`${JSON.stringify({ ok: true, ...noteRes }, null, 2)}\n`)
      else process.stdout.write(`已写入 Working Brief（topic=${noteRes.topicId}, ${noteRes.byteSize} B）。\n`)
      return 0
    }
  }
  const rawFilesOpt = opts.files !== undefined ? String(opts.files).trim() : ''
  const isNumericFiles = rawFilesOpt !== '' && /^\d+$/.test(rawFilesOpt)
  const filesAsPaths = (rawFilesOpt !== '' && !isNumericFiles)
    ? rawFilesOpt.split(',').map((s) => s.trim()).filter(Boolean)
    : []
  let triagePaths = []
  if (opts.paths !== undefined) {
    triagePaths = String(opts.paths).split(',').map((s) => s.trim()).filter(Boolean)
    if (filesAsPaths.length > 0) triagePaths = [...new Set([...triagePaths, ...filesAsPaths])]
  } else if (filesAsPaths.length > 0) {
    triagePaths = filesAsPaths
  } else if (roots.isGit && !opts.topic) {
    triagePaths = (await gitStatusPorcelainZ(repoRoot)).entries.map((e) => e.file)
  }
  const filesNum = isNumericFiles ? Number(rawFilesOpt) : (filesAsPaths.length > 0 ? filesAsPaths.length : undefined)
  const explicitPlanMode = resolveCliPlanMode(opts['plan-mode'])
  const result = triageTask({
    summary,
    files: filesNum,
    touchesContract: Boolean(opts['touches-contract']),
    conflictsTdd: Boolean(opts['conflicts-tdd']),
    docOnly: Boolean(opts['doc-only']),
    bugfix: Boolean(opts.bugfix),
    paths: triagePaths,
    repoRoot,
  })
  result.planMode = resolveDocPlanMode({
    kind: result.docsRequired?.includes('docs/specs/') ? 'spec' : (result.docsRequired?.length ? 'todo' : null),
    caseType: result.caseType,
    doorType: result.doorType,
    explicit: explicitPlanMode,
  })
  try {
    recordTriageDecision(mainRoot, {
      caseType: result.caseType,
      summary,
      paths: triagePaths,
      doorType: result.doorType,
      planMode: result.planMode,
      topic: opts.topic ?? null,
    })
  } catch { /* non-fatal on non-writable root */ }

  // 仅对 Case 3/4 自动刷新仓外 Living Visual Brief；Case 1/2 保持零开销
  if (result.caseType === 3 || result.caseType === 4) {
    try {
      const briefTopic = opts.topic ? normalizeTopicId(opts.topic) : (noteRes?.topicId ?? null)
      const briefKey = briefTopic || sanitizeBriefKey(summary.slice(0, 48))
      const matchedFeatIds = (result.contextBrief?.featureMap?.matchedFeatures ?? []).map((f) => f.id).filter(Boolean)
      const briefRes = upsertVisualBrief(mainRoot, {
        workRoot: repoRoot,
        briefKey,
        kind: 'topic',
        topicId: briefTopic,
        title: summary.slice(0, 120),
        verdict: `Case ${result.caseType} (${result.doorType}, ${result.planMode})`,
        affectedFeatures: matchedFeatIds,
        nonGoals: noteRes?.preInit?.nonGoals ?? [],
        decisions: noteRes?.preInit?.decisions ?? [],
        openQuestions: noteRes?.preInit?.openQuestions ?? [],
      })
      result.visualBrief = briefRes.summary
    } catch { /* non-fatal on non-writable root */ }
  }

  const steps = result.caseType === 5
    ? ['已阻断直接拆解！请先更新 docs/TDD.md 解决冲突并经独立确认。']
    : result.caseType === 4
      ? [{
          skill: 'dev-plan',
          text: result.prdRequired
            ? '创建 PRD+SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind all --slug <slug> --title "<标题>" --agent <id>'
            : '创建 SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind pair --slug <slug> --title "<标题>" --agent <id>',
        }]
      : result.caseType === 3
        ? [{ skill: 'dev-flow', text: '启动任务隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 3 --slug <slug> --agent <id>' }]
        : [{ skill: 'dev-flow', text: `启动任务流转：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case ${result.caseType} --slug <slug> --agent <id>` }]

  if (cli.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps(result, steps, { repoRoot: mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(`分流结论：Case ${result.caseType} (${result.action})${result.blocked ? ' [BLOCKED]' : ''}\n`)
    process.stdout.write(`- 门型: ${result.doorType} | 规划内审档位: ${result.critiqueTier} | 规划态: ${result.planMode}\n- 理由: ${result.reason}\n`)
    process.stdout.write(`- 必建文档: ${result.docsRequired.join(', ') || '无 (0 文档)'}\n`)
    process.stdout.write(`- Red-Green 回归测试: ${result.redGreenRequired ? '强制' : '不需要'} | 独立审查: ${result.needsReview ? '需要' : '低风险免除'}\n`)
    for (const w of result.coupledSyncWarnings ?? []) {
      process.stdout.write(`  * 联动提醒: 触及 ${w.touchedTriggers.join(', ')} -> 检查同步 ${w.expectedCompanions.join(', ')}\n`)
    }
    if (result.visualBrief) {
      process.stdout.write(`- Living Visual Brief (${result.visualBrief.confirmedState}): ${result.visualBrief.htmlUri}\n`)
    }
    const briefLines = formatContextBriefLines(result.contextBrief)
    if (briefLines.length > 0) process.stdout.write(`${briefLines.join('\n')}\n`)
    printNextStep(steps, { repoRoot: mainRoot })
  }
  return 0
}

function parseBriefFeatureSpecs(rawAffected, rawAdded, rawRemoved) {
  const affectedFeatures = []
  const featureChanges = {}
  for (const raw of rawAffected) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    const eqIdx = s.indexOf('=')
    if (eqIdx === 0) {
      throw Object.assign(new Error(`INVALID_FEATURE_CHANGE: --affected-feature 缺少模块 ID："${s}"`), { code: 'INVALID_FEATURE_CHANGE', exitCode: EXIT.USAGE })
    }
    if (eqIdx < 0) {
      affectedFeatures.push(s)
      continue
    }
    const id = s.slice(0, eqIdx).trim()
    const body = s.slice(eqIdx + 1).trim()
    if (!id) throw Object.assign(new Error(`INVALID_FEATURE_CHANGE: --affected-feature 缺少模块 ID："${s}"`), { code: 'INVALID_FEATURE_CHANGE', exitCode: EXIT.USAGE })
    affectedFeatures.push(id)
    const arrowMatch = /^(.*?)\s*(?:->|=>|::)\s*(.*)$/.exec(body)
    if (arrowMatch && arrowMatch[1].trim() && arrowMatch[2].trim()) {
      featureChanges[id] = { state: 'modified', before: arrowMatch[1].trim(), after: arrowMatch[2].trim(), note: body }
    } else if (body) {
      featureChanges[id] = { state: 'modified', note: body }
    }
  }
  const addedFeatures = []
  for (const raw of rawAdded) {
    const parts = String(raw ?? '').split('|').map((x) => x.trim())
    if (parts.length < 4 || !parts[0] || !parts[1] || !parts[2]) {
      throw Object.assign(new Error(`INVALID_FEATURE_CHANGE: --add-feature 须为 "id|domain|title|summary[|dependsOnCsv]"，收到："${raw}"`), { code: 'INVALID_FEATURE_CHANGE', exitCode: EXIT.USAGE })
    }
    addedFeatures.push({
      id: parts[0], domain: parts[1], title: parts[2], summary: parts[3],
      dependsOn: parts[4] ? parts[4].split(',').map((x) => x.trim()).filter(Boolean) : [],
    })
  }
  const removedFeatures = []
  for (const raw of rawRemoved) {
    const parts = String(raw ?? '').split('|').map((x) => x.trim())
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw Object.assign(new Error(`INVALID_FEATURE_CHANGE: --remove-feature 须为 "id|reason[|replacementId]"，收到："${raw}"`), { code: 'INVALID_FEATURE_CHANGE', exitCode: EXIT.USAGE })
    }
    removedFeatures.push({ id: parts[0], reason: parts[1], ...(parts[2] ? { replacementId: parts[2] } : {}) })
  }
  return { affectedFeatures, featureChanges, addedFeatures, removedFeatures }
}

export async function handleBriefSubcommand({ opts, cli, repoRoot, mainRoot }) {
  const topicId = opts.topic ? normalizeTopicId(opts.topic) : null
  const taskId = opts.task ? sanitizeTaskId(opts.task) : null
  const ledger = taskId ? readTaskLedger(mainRoot, taskId) : null
  const effectiveWorkRoot = ledger?.worktreePath ? `${mainRoot}/${ledger.worktreePath}` : repoRoot

  const title = opts.title ?? null
  const verdict = opts.verdict ?? null
  const rawAffected = opts['affected-feature'] ?? []
  const rawAdded = opts['add-feature'] ?? []
  const rawRemoved = opts['remove-feature'] ?? []
  const { affectedFeatures, featureChanges, addedFeatures, removedFeatures } = parseBriefFeatureSpecs(rawAffected, rawAdded, rawRemoved)
  const flowDeltas = opts['flow-delta'] ?? []
  const prototypesToAdd = opts.prototype ?? []
  const selectPrototypeId = opts['select-prototype'] ?? null
  const sourceSkill = opts['source-skill'] ?? ''
  const confirm = Boolean(opts.confirm)
  const openBrowser = Boolean(opts['open-browser'])

  const hasMutation = Boolean(
    title || verdict || confirm || selectPrototypeId || sourceSkill
    || rawAffected.length > 0 || rawAdded.length > 0 || rawRemoved.length > 0
    || flowDeltas.length > 0 || prototypesToAdd.length > 0
    || opts.decision || (opts.exclude?.length ?? 0) > 0 || (opts.open?.length ?? 0) > 0,
  )

  const sess = readSessionState(mainRoot)
  const resolvedTopic = topicId || (!taskId ? (sess?.activeTopic ?? null) : null)
  const resolvedKey = sanitizeBriefKey(
    ledger?.briefKey
    || taskId
    || (resolvedTopic && sess?.topics?.[resolvedTopic]?.briefKey)
    || resolvedTopic
    || (opts._[0] ? String(opts._[0]) : null)
    || 'default',
  )

  const existing = readBriefSidecar(mainRoot, resolvedKey)
  if (!hasMutation && !existing && !topicId && !taskId && !opts._[0]) {
    const latest = getVisualBriefSummary(mainRoot, { workRoot: effectiveWorkRoot })
    if (!latest) {
      const emptyOut = { ok: true, exists: false, visualBrief: null, message: '当前尚无仓外 Living Visual Brief；请传入 --topic <id> 或 --task <id> 创建。' }
      if (cli.json) process.stdout.write(`${JSON.stringify(emptyOut, null, 2)}\n`)
      else process.stdout.write(`${emptyOut.message}\n`)
      return 0
    }
    const browserRes = openBrowser ? openInBrowser(latest.htmlUri) : null
    const out = { ok: true, exists: true, visualBrief: latest, ...(browserRes ? { browser: browserRes } : {}) }
    if (cli.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else process.stdout.write(`Living Visual Brief [${latest.briefKey}] (${latest.confirmedState}): ${latest.htmlUri}\n`)
    return 0
  }

  const res = upsertVisualBrief(mainRoot, {
    workRoot: effectiveWorkRoot,
    briefKey: resolvedKey,
    kind: existing?.kind ?? (taskId ? 'task' : 'topic'),
    topicId: resolvedTopic,
    taskId,
    title: title ?? existing?.title ?? resolvedKey,
    verdict: verdict ?? undefined,
    affectedFeatures,
    featureChanges,
    addedFeatures,
    removedFeatures,
    flowDeltas,
    decisions: opts.decision ? [opts.decision] : [],
    nonGoals: opts.exclude ?? [],
    openQuestions: opts.open ?? [],
    prototypesToAdd,
    selectPrototypeId,
    sourceSkill,
    confirm,
  })

  const browserRes = openBrowser ? openInBrowser(res.htmlUri) : null
  const payload = {
    ok: true,
    briefKey: res.briefKey,
    visualBrief: res.summary,
    sidecar: res.sidecar,
    liveProjection: res.liveProjection,
    bytes: res.bytes,
    ...(browserRes ? { browser: browserRes } : {}),
  }

  const nextSteps = res.summary.confirmedState !== 'confirmed'
    ? [{ skill: 'dev-plan', text: `确认简报快照：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" brief --${taskId ? `task ${taskId}` : `topic ${res.briefKey}`} --confirm` }]
    : [{ skill: 'dev-plan', text: '简报已确认，可继续执行 doc-plan.mjs init 或 next --handoff。' }]

  if (cli.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps(payload, nextSteps, { repoRoot: mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(`Living Visual Brief [${res.briefKey}] (${res.summary.confirmedState}, ${res.bytes} B)\n`)
    process.stdout.write(`- HTML: ${res.htmlUri}\n`)
    process.stdout.write(`- Prototypes: ${res.summary.prototypeCount}${res.summary.selectedPrototypeId ? ` (selected=${res.summary.selectedPrototypeId})` : ''}\n`)
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }
  return 0
}
