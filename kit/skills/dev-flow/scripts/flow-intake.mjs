#!/usr/bin/env node
/**
 * flow-intake.mjs —— `flow.mjs intake` 全局业务分诊入口（5 维规则引擎 + 默认预演 + `--apply` 闭环执行）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），写路径一律经 `probeForWrite` 探测通道后经 `TaskBackend` 执行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { isMainModule, resolveRepoRoots } from '../../lib/git.mjs'
import { stripPfStateTags } from '../../lib/github-client.mjs'
import {
  INTAKE_DECISIONS,
  evaluateIntakeTriage,
  isApprovedInternalPlan,
  readIntakeRecord,
  writeIntakeRecord,
} from '../../lib/intake-triage.mjs'
import { readTaskLedger, sanitizeTaskId } from '../../lib/ledger.mjs'
import { getLocalIssue, getLocalPr, listLocalIssues } from '../../lib/local-issues.mjs'
import { getHostingProvider, parseIssueNumbers, parsePrNumber, probeForWrite, resolveIdentityLayers } from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext, resolveReadClient } from './flow-context.mjs'
import { EXIT_ACTION_REQUIRED, inspectWorkspace } from './flow-inspect.mjs'

export { evaluateIntakeTriage, isApprovedInternalPlan, readIntakeRecord, writeIntakeRecord }

function parseCsvList(raw) {
  if (!raw) return []
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

function readRationaleText(mainRoot, opts = {}) {
  const fileArg = opts['rationale-file'] ?? opts.rationaleFile
  if (fileArg) {
    const abs = isAbsolute(String(fileArg)) ? String(fileArg) : resolve(mainRoot, String(fileArg))
    if (!existsSync(abs)) throw new Error(`--rationale-file 指定的文件不存在：${abs}`)
    return readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').trim()
  }
  return String(opts.rationale ?? '').replace(/\r\n/g, '\n').trim()
}

function resolveTargetSelection(mainRoot, opts = {}) {
  const hasPr = opts.pr !== undefined && opts.pr !== null && opts.pr !== ''
  const hasIssue = opts.issue !== undefined && opts.issue !== null && opts.issue !== ''
  if (hasPr && hasIssue) {
    throw new Error('--pr 与 --issue 不能同时指定，请一次分诊单个目标')
  }
  let ledger = null
  if (opts.task) {
    ledger = readTaskLedger(mainRoot, sanitizeTaskId(opts.task))
  }
  if (hasPr) {
    const prNum = parsePrNumber(opts.pr, { strict: true })
    return { targetType: 'pr', targetNumber: prNum, ledger }
  }
  if (hasIssue) {
    const nums = parseIssueNumbers(opts.issue, { strict: true })
    if (nums.length !== 1) throw new Error(`--issue 需要单个有效编号，收到：${opts.issue}`)
    return { targetType: 'issue', targetNumber: nums[0], ledger }
  }
  if (ledger?.prNumber) return { targetType: 'pr', targetNumber: Number(ledger.prNumber), ledger }
  if (ledger?.linkedIssues?.[0]) return { targetType: 'issue', targetNumber: Number(ledger.linkedIssues[0]), ledger }
  throw new Error('缺少分诊目标：请传 --pr <M> 或 --issue <N>（或已绑定 Issue/PR 的 --task <id>）')
}

async function hydrateTargetMetadata({
  mainRoot,
  gitDir,
  targetType,
  targetNumber,
  opts,
  state,
  targetRepo,
  ledger,
}) {
  let title = String(opts.title ?? '').trim()
  let body = String(opts.body ?? '').trim()
  let branch = String(opts.branch ?? ledger?.branch ?? '').trim() || null
  let labels = parseCsvList(opts.labels)
  const files = parseCsvList(opts.files)
  let closedIssues = []

  const localClosed = listLocalIssues({ mainRoot, gitDir, state: 'closed' })
  if (localClosed.ok && Array.isArray(localClosed.issues)) {
    closedIssues = [...localClosed.issues]
  }

  if (targetType === 'issue' && (!title || !body)) {
    const localIss = getLocalIssue({ mainRoot, gitDir, number: targetNumber })
    if (localIss.ok) {
      if (!title) title = String(localIss.title ?? '').trim()
      if (!body) body = String(localIss.body ?? '').trim()
      if (labels.length === 0 && Array.isArray(localIss.labels)) labels = [...localIss.labels]
    }
  } else if (targetType === 'pr' && (!title || !body)) {
    const localPr = getLocalPr({ mainRoot, gitDir, number: targetNumber })
    if (localPr.ok) {
      if (!title) title = String(localPr.title ?? '').trim()
      if (labels.length === 0 && Array.isArray(localPr.labels)) labels = [...localPr.labels]
    }
  }

  const shouldTryRemoteRead = Boolean(
    targetRepo
    && (state.github?.providerId === 'github' || opts._ghClient || opts._ghProbe)
    && (!title || !body),
  )
  if (shouldTryRemoteRead) {
    const readClient = await resolveReadClient({
      mainRoot,
      remoteUrls: state.remoteUrls ?? {},
      providerId: state.github?.providerId ?? 'github',
      targetRepo,
      opts,
    })
    if (readClient) {
      try {
        if (targetType === 'pr' && typeof readClient.getPr === 'function') {
          const prRes = await readClient.getPr(targetRepo, targetNumber)
          if (prRes?.ok) {
            if (!title) title = String(prRes.title ?? '').trim()
            if (!body) body = String(prRes.body ?? '').trim()
            if (!branch && prRes.headBranch) branch = prRes.headBranch
            if (labels.length === 0 && Array.isArray(prRes.labels)) labels = [...prRes.labels]
          }
        } else if (targetType === 'issue' && typeof readClient.getIssue === 'function') {
          const issRes = await readClient.getIssue(targetRepo, targetNumber)
          if (issRes?.ok) {
            if (!title) title = String(issRes.title ?? '').trim()
            if (!body) body = String(issRes.body ?? '').trim()
            if (labels.length === 0 && Array.isArray(issRes.labels)) labels = [...issRes.labels]
          }
        }
        if (typeof readClient.listIssues === 'function') {
          const remoteClosed = await readClient.listIssues({ repo: targetRepo, state: 'closed', perPage: 30 })
          if (remoteClosed?.ok && Array.isArray(remoteClosed.issues)) {
            closedIssues.push(...remoteClosed.issues)
          }
        }
      } catch {
        // 只读拉取失败时不阻断离线规则评估
      }
    }
  }

  return { title, body, branch, labels, files, closedIssues }
}

function formatIntakeMarkdown(result) {
  const kind = result.targetType === 'pr' ? 'PR' : 'Issue'
  const lines = [
    `# 业务分诊结果（${kind} #${result.targetNumber}）`,
    '',
    `- **判定结论**：\`${result.decision}\`（来源：\`${result.decisionSource}\`，静态规则判定：\`${result.ruleDecision}\`）`,
    `- **执行模式**：${result.applied ? '已落地执行（--apply）' : '仅预演（dry-run，未执行写操作）'}`,
    `- **内部规划豁免**：${result.exempt ? `是（${result.matchedDoc}）` : '否'}`,
    `- **拟贴/已贴标签**：${result.labels.length > 0 ? result.labels.join(', ') : '无'}`,
    `- **自动关闭**：${result.shouldClose ? (result.applied ? '已执行' : '将关闭（--apply 时生效）') : '否'}`,
    ...(result.duplicateOf ? [`- **重复指向**：#${result.duplicateOf}`] : []),
    ...(result.featureRef ? [`- **特性锚点**：${result.featureRef}`] : []),
    ...(result.tddRefs?.length ? [`- **契约依据**：${result.tddRefs.join(', ')}`] : []),
    ...(result.recordPath ? [`- **本地分诊记录**：${result.recordPath}`] : []),
    ...(result.rollbackHint ? [`- **撤销恢复路径**：${result.rollbackHint}`] : []),
    '',
    '## 五维规则评估摘要',
    '',
    '| 维度 | 状态 | 依据 |',
    '| --- | --- | --- |',
    ...result.dimensions.map((d) => `| ${d.name} | ${d.status} | ${d.detail} |`),
    '',
    '## 评论正文预览',
    '',
    result.commentBody,
  ]
  return `${lines.join('\n')}\n`
}

/** `flow.mjs intake` 核心处理器（兼容 `flow.mjs` 子命令路由与独立 CLI 调用）。 */
export async function handleIntake(opts = {}, rootsArg = null) {
  const roots = rootsArg ?? (await resolveRepoRoots(opts.dir ?? process.cwd()))
  const { mainRoot, gitDir } = roots
  const { targetType, targetNumber, ledger } = resolveTargetSelection(mainRoot, opts)
  const rationale = readRationaleText(mainRoot, opts)
  const duplicateOf = opts['duplicate-of'] ?? opts.duplicateOf ?? null
  const featureRef = opts['feature-ref'] ?? opts.featureRef ?? null
  const explicitDecision = opts.decision ? String(opts.decision).trim().toLowerCase() : null
  if (explicitDecision && !INTAKE_DECISIONS.includes(explicitDecision)) {
    throw new Error(`--decision 参数非法：「${opts.decision}」（支持：${INTAKE_DECISIONS.join(' | ')}）`)
  }

  const state = await inspectWorkspace(mainRoot, { roots, probeAuth: false })
  const role = state.identity?.role ?? 'local-only'
  const providerId = state.github?.providerId ?? 'none'
  const { targetRepo, pushRemote } = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo)

  const hydrated = await hydrateTargetMetadata({
    mainRoot, gitDir, targetType, targetNumber, opts, state, targetRepo, ledger,
  })

  const applyMode = Boolean(opts.apply) && !Boolean(opts['dry-run'])
  const useRemoteGh = providerId === 'github' && role !== 'local-only' && role !== 'generic-git' && Boolean(targetRepo)
  const ghProbe = applyMode && useRemoteGh
    ? (opts._ghProbe ?? (await probeForWrite({ cwd: mainRoot, remoteUrls: state.remoteUrls ?? {} })))
    : (opts._ghProbe ?? null)
  const backend = applyMode
    ? (opts._backend ?? createTaskBackend({
        role,
        providerId,
        targetRepo,
        client: opts._ghClient ?? ghProbe?.client,
        pushRemote,
        mainRoot,
        gitDir,
      }))
    : (opts._backend ?? null)
  const effectiveCaps = backend?.capabilities
    ?? (role !== 'local-only' && role !== 'generic-git' ? getHostingProvider(providerId)?.capabilities : null)
    ?? { mention: false }
  const actorLayers = resolveIdentityLayers({
    ghLogin: ghProbe?.env?.trackB?.login ?? state.github?.trackB?.login,
    ghTier: ghProbe?.env?.trackB?.tier ?? state.github?.trackB?.tier,
    gitName: state.gitIdentity?.name,
    explicitAgent: opts.actor ?? opts.agent,
  })

  const evaluation = evaluateIntakeTriage(mainRoot, {
    targetType,
    targetNumber,
    title: hydrated.title,
    body: hydrated.body,
    files: hydrated.files,
    branch: hydrated.branch,
    taskId: opts.task ?? ledger?.taskId ?? null,
    featureRef,
    decision: explicitDecision,
    rationale,
    duplicateOf,
    labels: hydrated.labels,
    closedIssues: hydrated.closedIssues,
    gitDir,
    account: actorLayers.account,
    verifiedPlatformLogin: actorLayers.verifiedPlatformLogin,
    agent: actorLayers.agent,
    supportsMention: Boolean(effectiveCaps?.mention === true),
    capabilities: effectiveCaps,
    applied: applyMode,
  })

  let actions = null
  let recordPath = null
  let delegated = false

  if (applyMode) {

    const cleanComment = stripPfStateTags(evaluation.commentBody)
    actions = { backend: backend.kind, comment: null, labels: null, close: null }

    if (targetType === 'pr' && evaluation.shouldClose) {
      const closeRes = await backend.closePr(targetNumber, {
        repo: targetRepo,
        comment: cleanComment,
        labels: evaluation.labels,
        statePayload: evaluation.statePayload,
        reason: evaluation.reason,
        decision: evaluation.decision,
        taskId: opts.task ?? ledger?.taskId ?? null,
        dryRun: false,
      })
      actions.close = closeRes
      actions.comment = closeRes?.commentResult ?? null
      actions.labels = closeRes?.labelResult ?? null
      if (closeRes?.delegated) delegated = true
    } else if (targetType === 'issue' && evaluation.shouldClose) {
      actions.comment = await backend.postComment({
        repo: targetRepo,
        number: targetNumber,
        body: cleanComment,
        statePayload: evaluation.statePayload,
      })
      if (evaluation.labels.length > 0) {
        actions.labels = await backend.addLabels({
          repo: targetRepo,
          number: targetNumber,
          labels: evaluation.labels,
        })
      }
      actions.close = await backend.closeIssue({
        repo: targetRepo,
        number: targetNumber,
        reason: evaluation.reason,
      })
      if (actions.comment?.delegated || actions.close?.delegated) delegated = true
    } else {
      actions.comment = await backend.postComment({
        repo: targetRepo,
        number: targetNumber,
        body: cleanComment,
        statePayload: evaluation.statePayload,
      })
      if (evaluation.labels.length > 0) {
        actions.labels = await backend.addLabels({
          repo: targetRepo,
          number: targetNumber,
          labels: evaluation.labels,
          isPr: targetType === 'pr',
        })
      }
      if (actions.comment?.delegated) delegated = true
    }

    const saved = await writeIntakeRecord(mainRoot, {
      targetType,
      targetNumber,
      title: evaluation.title,
      decision: evaluation.decision,
      ruleDecision: evaluation.ruleDecision,
      decisionSource: evaluation.decisionSource,
      exempt: evaluation.exempt,
      matchedDoc: evaluation.matchedDoc,
      labels: evaluation.labels,
      shouldClose: evaluation.shouldClose,
      closed: evaluation.shouldClose && Boolean(actions.close?.ok),
      reason: evaluation.reason,
      rationale: evaluation.rationale,
      duplicateOf: evaluation.duplicateOf,
      featureRef: evaluation.featureRef,
      tddRefs: evaluation.tddRefs,
      duplicates: evaluation.duplicates,
      dimensions: evaluation.dimensions,
      rollbackHint: evaluation.rollbackHint,
      account: actorLayers.account,
      verifiedPlatformLogin: actorLayers.verifiedPlatformLogin,
      agent: actorLayers.agent,
      actor: actorLayers.agent || actorLayers.account || null,
      applied: true,
      delegated,
      backend: backend.kind,
    }, { gitDir })
    recordPath = saved.path ?? null
  }

  const result = {
    ...evaluation,
    applied: applyMode,
    dryRun: !applyMode,
    delegated,
    role,
    providerId,
    targetRepo: targetRepo ?? null,
    ...(actions ? { actions } : {}),
    ...(recordPath ? { recordPath } : {}),
  }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  } else {
    process.stdout.write(formatIntakeMarkdown(result))
    const nextSteps = applyMode
      ? (evaluation.shouldClose
          ? [`已完成 ${targetType.toUpperCase()} #${targetNumber} 分诊关闭与落盘；${evaluation.rollbackHint}`]
          : [`已完成 ${targetType.toUpperCase()} #${targetNumber} 分诊评论与打标（decision=${evaluation.decision}）。`])
      : [`核对上述分诊结论后，加 \`--apply\` 执行评论/打标${evaluation.shouldClose ? '/关闭' : ''}与持久化记录。`]
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }

  return { exitCode: delegated ? EXIT_ACTION_REQUIRED : 0, result }
}

/** 供 `flow.mjs` 或独立调用方直接以 `(repoRoot, argv)` 形式运行 `flow intake`。 */
export async function runFlowIntake(repoRoot = process.cwd(), argv = []) {
  const cli = parseStandardCli(argv, {
    booleanFlags: ['apply', 'dry-run'],
    valueFlags: [
      'pr', 'issue', 'feature-ref', 'decision', 'rationale', 'rationale-file',
      'duplicate-of', 'task', 'title', 'body', 'files', 'branch', 'labels', 'actor', 'agent',
    ],
    usageHint: 'flow-intake.mjs (--pr <M> | --issue <N>) [--decision <d>] [--rationale "<text>"] [--rationale-file <path>] [--duplicate-of <#N>] [--feature-ref <id>] [--apply] [--dry-run] [--json]',
  })
  const startDir = cli.opts.dir ? resolve(String(cli.opts.dir)) : resolve(String(repoRoot || process.cwd()))
  const roots = await resolveRepoRoots(startDir)
  return handleIntake({ ...cli.opts, json: cli.json }, roots)
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runFlowIntake(process.cwd(), process.argv.slice(2))
    .then(({ exitCode }) => flushAndExit(exitCode))
    .catch((err) => {
      process.stderr.write(`flow-intake 错误：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(2)
    })
}
