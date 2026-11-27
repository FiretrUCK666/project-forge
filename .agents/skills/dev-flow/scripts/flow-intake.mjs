#!/usr/bin/env node
/**
 * flow-intake.mjs —— `flow.mjs intake` 全局业务分诊入口（5 维规则引擎 + 默认预演 + `--apply` 闭环执行）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），写路径一律经 `probeForWrite` 探测通道后经 `TaskBackend` 执行。
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { flushAndExit, assertNoAsciiControlChars, parseStandardCli, printNextStep, withNextSteps } from '../../lib/cli.mjs'
import { isMainModule, resolveRepoRoots, sha256Text, withFileLock } from '../../lib/git.mjs'
import { stripPfStateTags } from '../../lib/github-client.mjs'
import {
  INTAKE_DECISIONS,
  computeIntakeContextBasis,
  evaluateIntakeTriage,
  isApprovedInternalPlan,
  readIntakeRecord,
  resolveIntakeDir,
  writeIntakeRecord,
} from '../../lib/intake-triage.mjs'
import { readTaskLedger, sanitizeTaskId } from '../../lib/ledger.mjs'
import { judgeCrossRepoReference } from '../../lib/github-parse.mjs'
import { getLocalIssue, getLocalPr, listLocalIssues } from '../../lib/local-issues.mjs'
import { getHostingProvider, parseFlowInputs, parsePrNumber, probeForWrite, resolveIdentityLayers } from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext, resolveReadClient } from './flow-context.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { inspectWorkspace } from './flow-inspect.mjs'

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
    const text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n').trim()
    return assertNoAsciiControlChars(text, '--rationale-file')
  }
  const text = String(opts.rationale ?? '').replace(/\r\n/g, '\n').trim()
  return assertNoAsciiControlChars(text, '--rationale')
}

/**
 * 解析分诊目标。
 *
 * 引用可以来自三处：`--pr` / `--issue` 显式开关、位置参数、账本里已绑定的条目。
 * 三条都走 `parseFlowInputs` 这一套解析——`inspect` 用的也是它，两条入口对同一输入
 * 必须给出同一结论，各写一套只会让同一个链接在两边落到不同的目标上。
 */
function resolveTargetSelection(mainRoot, opts = {}) {
  const hasPr = opts.pr !== undefined && opts.pr !== null && opts.pr !== ''
  const hasIssue = opts.issue !== undefined && opts.issue !== null && opts.issue !== ''
  const positional = (Array.isArray(opts._) ? opts._ : []).map((s) => String(s ?? '').trim()).filter(Boolean)
  if (hasPr && hasIssue) {
    throw new Error('--pr 与 --issue 不能同时指定，请一次分诊单个目标')
  }
  let ledger = null
  if (opts.task) {
    ledger = readTaskLedger(mainRoot, sanitizeTaskId(opts.task))
  }
  if (hasPr) {
    const prNum = parsePrNumber(opts.pr, { strict: true })
    return { targetType: 'pr', targetNumber: prNum, targetRepo: null, ledger }
  }
  if (hasIssue) {
    const parsed = parseFlowInputs([String(opts.issue)])
    if (parsed.unknown.length > 0) {
      throw new Error(`Issue 引用格式无效（支持正整数、#N、issue#N 或 HTTP(S) Issue URL）：${parsed.unknown.join(' ')}`)
    }
    if (parsed.issues.length !== 1) throw new Error(`--issue 需要单个有效编号，收到：${opts.issue}`)
    return { targetType: 'issue', targetNumber: parsed.issues[0].number, targetRepo: parsed.issues[0].repo, ledger }
  }
  if (positional.length > 0) {
    const parsed = parseFlowInputs(positional)
    const usable = [...parsed.issues, ...parsed.prs]
    if (usable.length === 0) {
      throw new Error(
        `位置参数里没有可用的分诊目标，未识别的输入：${parsed.unknown.join(' ') || '(无)'}`
        + '。正确写法：flow intake https://<host>/<owner>/<repo>/issues/<N>，或 --issue <N> / --pr <M>',
      )
    }
    if (usable.length > 1) throw new Error(`一次只能分诊单个目标，收到 ${usable.length} 个：${positional.join(' ')}`)
    const only = usable[0]
    const isPr = parsed.prs.length === 1
    return { targetType: isPr ? 'pr' : 'issue', targetNumber: only.number, targetRepo: isPr ? null : only.repo, ledger }
  }
  if (ledger?.prNumber) return { targetType: 'pr', targetNumber: Number(ledger.prNumber), targetRepo: null, ledger }
  if (ledger?.linkedIssues?.[0]) return { targetType: 'issue', targetNumber: Number(ledger.linkedIssues[0]), targetRepo: null, ledger }
  throw new Error('缺少分诊目标：请传 --pr <M> 或 --issue <N>（或已绑定 Issue/PR 的 --task <id>）')
}

/**
 * 把目标 Issue/PR 的元数据按**平台真相优先**聚起来。
 *
 * 分诊的结论是「这个提案该不该收」，判定依据必须是平台上真实写着的东西。此前调用方传的
 * `--title` / `--body` 排在最前面，于是同一份提案可以靠换个标题绕过非目标与重复判定——
 * 判定读的是他说的，不是记录里的。
 *
 * 所以顺序反过来：先读本地镜像，再读远端；两处都读不到某个字段，才退回调用方补充，
 * 并把「这一条来自补充、以及平台为什么读不到」一起记进 `supplemented`。补充不是禁止的，
 * 但它必须留源——离线仓、无凭据、接口报错都是真实场景，假装读到了才是问题。
 */
async function hydrateTargetMetadata({
  mainRoot,
  gitDir,
  targetType,
  targetNumber,
  opts,
  state,
  targetRepo,
  ledger,
  forceRemote = false,
}) {
  const platform = { title: '', body: '', branch: '', state: '', headSha: '', commentsDigest: '', labels: [], closedIssues: [] }
  const failures = []

  const localClosed = listLocalIssues({ mainRoot, gitDir, state: 'closed' })
  if (localClosed.ok && Array.isArray(localClosed.issues)) platform.closedIssues.push(...localClosed.issues)
  else failures.push('本地镜像里读不到已关闭条目清单')

  const local = targetType === 'issue'
    ? getLocalIssue({ mainRoot, gitDir, number: targetNumber })
    : getLocalPr({ mainRoot, gitDir, number: targetNumber })
  if (local.ok && !forceRemote) {
    platform.title = String(local.title ?? '').trim() || platform.title
    if (targetType === 'issue') platform.body = String(local.body ?? '').trim() || platform.body
    if (local.state) platform.state = String(local.state).trim()
    if (local.headSha) platform.headSha = String(local.headSha).trim()
    if (Array.isArray(local.labels) && local.labels.length > 0) platform.labels = [...local.labels]
    if (!platform.branch) platform.branch = String(local.headBranch ?? local.branch ?? '').trim()
  }

  const targetCtx = buildTargetRepoContext(state.identity?.role ?? 'local-only', state.remoteUrls ?? {}, state.declaredRepo)
  const shouldTryRemoteRead = Boolean(
    targetRepo
    && (targetCtx.capabilities?.api === true || opts._ghClient || opts._ghProbe)
    && (forceRemote || !platform.title || !platform.body),
  )
  if (shouldTryRemoteRead) {
    const readClient = await resolveReadClient({
      mainRoot,
      remoteUrls: state.remoteUrls ?? {},
      providerId: state.github?.providerId ?? state.identity?.providerId ?? 'none',
      targetRepo,
      opts,
    })
    if (readClient) {
      try {
        const fetched = targetType === 'pr' && typeof readClient.getPr === 'function'
          ? await readClient.getPr(targetRepo, targetNumber)
          : (targetType === 'issue' && typeof readClient.getIssue === 'function'
            ? await readClient.getIssue(targetRepo, targetNumber)
            : null)
        if (fetched?.ok) {
          platform.title = String(fetched.title ?? '').trim() || platform.title
          if (targetType === 'issue' || fetched.body) platform.body = String(fetched.body ?? '').trim() || platform.body
          if (fetched.state) platform.state = String(fetched.state).trim()
          if (fetched.headRefOid || fetched.headSha) platform.headSha = String(fetched.headRefOid ?? fetched.headSha).trim()
          if (!platform.branch && fetched.headBranch) platform.branch = fetched.headBranch
          if ((forceRemote || platform.labels.length === 0) && Array.isArray(fetched.labels)) platform.labels = [...fetched.labels]
        } else {
          failures.push(`远端读取 ${targetType === 'pr' ? 'PR' : 'Issue'} #${targetNumber} 未返回可用元数据`)
        }
        if (typeof readClient.listComments === 'function') {
          const cmRes = await readClient.listComments(targetRepo, targetNumber)
          if (cmRes?.ok && Array.isArray(cmRes.comments) && cmRes.comments.length > 0) {
            platform.commentsDigest = sha256Text(JSON.stringify(cmRes.comments.map((c) => ({
              id: c?.id ?? null,
              body: String(c?.body ?? '').replace(/\r\n/g, '\n').trim(),
            }))))
          }
        }
        if (typeof readClient.listIssues === 'function') {
          const remoteClosed = await readClient.listIssues({ repo: targetRepo, state: 'closed', perPage: 30 })
          if (remoteClosed?.ok && Array.isArray(remoteClosed.issues)) platform.closedIssues.push(...remoteClosed.issues)
        }
      } catch (err) {
        // 只读拉取失败不阻断离线规则评估，但失败本身要留痕：后面若有字段靠补充，理由就在这。
        failures.push(`远端只读拉取失败：${err instanceof Error ? err.message : String(err)}`)
      }
    } else {
      failures.push('没有可用的远端只读客户端')
    }
  }

  // 补充只补平台的空缺，不覆盖平台已有值。
  const supplemented = []
  const fill = (field, rawValue) => {
    const value = String(rawValue ?? '').trim()
    if (!value || platform[field]) return platform[field]
    supplemented.push({ field, reason: failures.join('；') || '平台侧未提供该字段' })
    platform[field] = value
    return value
  }
  const title = fill('title', opts.title)
  const body = fill('body', opts.body)
  const branch = fill('branch', opts.branch ?? ledger?.branch)
  let labels = platform.labels
  if (labels.length === 0 && parseCsvList(opts.labels).length > 0) {
    labels = parseCsvList(opts.labels)
    supplemented.push({ field: 'labels', reason: failures.join('；') || '平台侧未提供标签' })
  }

  const contextBasis = computeIntakeContextBasis({
    targetType,
    targetNumber,
    state: platform.state,
    title,
    body,
    labels,
    commentsDigest: platform.commentsDigest,
    headSha: platform.headSha,
  })

  return {
    title,
    body,
    branch: branch || null,
    state: platform.state,
    headSha: platform.headSha,
    commentsDigest: platform.commentsDigest,
    contextBasis,
    labels,
    files: parseCsvList(opts.files),
    closedIssues: platform.closedIssues,
    supplemented,
    platformFailures: failures,
  }
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
    ...(result.supplemented?.length ? [`- **补充来源**：${result.supplemented.map((s) => `${s.field}（${s.reason}）`).join('；')}——这些字段不在平台上，判定按调用方补充进行`] : []),
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
  const { targetType, targetNumber, targetRepo: referenceRepo, ledger } = resolveTargetSelection(mainRoot, opts)
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
  const targetCtx = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo)
  const { targetRepo, pushRemote } = targetCtx

  // 引用里带了别的仓就是跨仓引用：写操作会落到那张单上，不是本地这一条。
  // 三态由 `judgeCrossRepoReference` 判，本仓不可判定时只报出不阻断。
  const crossRepo = judgeCrossRepoReference({ repo: referenceRepo, targetRepo, raw: opts._?.join(' ') ?? '' })
  if (crossRepo.blocked) throw new Error(crossRepo.message)
  if (crossRepo.state === 'undecidable') process.stderr.write(`[提醒] ${crossRepo.message}\n`)

  const hydrated = await hydrateTargetMetadata({
    mainRoot, gitDir, targetType, targetNumber, opts, state, targetRepo, ledger,
  })

  const applyMode = Boolean(opts.apply) && !Boolean(opts['dry-run'])
  const useRemoteGh = targetCtx.capabilities?.api === true && role !== 'local-only' && role !== 'generic-git' && Boolean(targetRepo)
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
    explicitAgent: opts.agent ?? opts.actor,
  })

  const evaluation = evaluateIntakeTriage(mainRoot, {
    targetType,
    targetNumber,
    title: hydrated.title,
    body: hydrated.body,
    state: hydrated.state,
    headSha: hydrated.headSha,
    commentsDigest: hydrated.commentsDigest,
    contextBasis: hydrated.contextBasis,
    files: hydrated.files,
    branch: hydrated.branch,
    taskId: opts.task ?? ledger?.taskId ?? null,
    featureRef,
    decision: explicitDecision,
    rationale,
    duplicateOf,
    labels: hydrated.labels,
    closedIssues: hydrated.closedIssues,
    supplemented: hydrated.supplemented,
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
    const expectedBasis = String(opts['context-basis'] ?? opts.contextBasis ?? '').trim().toLowerCase()
    const applyLockPath = join(resolveIntakeDir(mainRoot, gitDir), 'intake-apply.lock')
    const staleBlocked = await withFileLock(applyLockPath, async () => {
      const recheck = await hydrateTargetMetadata({
        mainRoot, gitDir, targetType, targetNumber, opts, state, targetRepo, ledger,
        forceRemote: Boolean(useRemoteGh || opts._ghClient || opts._ghProbe),
      })
      const latestBasis = String(recheck.contextBasis ?? '').toLowerCase()
      const baseline = expectedBasis || String(hydrated.contextBasis ?? '').toLowerCase()
      if (baseline && latestBasis && baseline !== latestBasis) {
        return {
          ok: false,
          blocked: true,
          code: 'BLOCKED_STALE_INTAKE_CONTEXT',
          exitCode: EXIT.FACT,
          targetType,
          targetNumber,
          expectedContextBasis: baseline,
          actualContextBasis: latestBasis,
          reason: `BLOCKED_STALE_INTAKE_CONTEXT: 目标 ${targetType.toUpperCase()} #${targetNumber} 上下文指纹已漂移（expected=${baseline.slice(0, 12)}, actual=${latestBasis.slice(0, 12)}），已中止写回；请重新 dry-run 核对最新内容后再 --apply。`,
        }
      }

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
        contextBasis: latestBasis || evaluation.contextBasis,
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
        supplemented: evaluation.supplemented,
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
      return null
    })
    if (staleBlocked) {
      if (opts.json) process.stdout.write(`${JSON.stringify(staleBlocked, null, 2)}\n`)
      process.stderr.write(`${staleBlocked.reason}\n`)
      return { exitCode: EXIT.FACT, result: staleBlocked }
    }
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

  const nextSteps = applyMode
    ? (evaluation.shouldClose
        ? [`已完成 ${targetType.toUpperCase()} #${targetNumber} 分诊关闭与落盘；${evaluation.rollbackHint}`]
        : [`已完成 ${targetType.toUpperCase()} #${targetNumber} 分诊评论与打标（decision=${evaluation.decision}）。`])
    : [`核对上述分诊结论后，加 \`--apply\` 执行评论/打标${evaluation.shouldClose ? '/关闭' : ''}与持久化记录。`]

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(withNextSteps(result, nextSteps, { repoRoot: mainRoot }), null, 2)}\n`)
  } else {
    process.stdout.write(formatIntakeMarkdown(result))
    printNextStep(nextSteps, { repoRoot: mainRoot })
  }

  return { exitCode: delegated ? EXIT.HUMAN : 0, result }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/flow-intake.mjs [options] [url...]',
    '',
    'Options:',
    '  --pr <M>                  目标 PR 编号或 URL',
    '  --issue <N>               目标 Issue 编号或 URL',
    '  --task <id>               已绑定 Issue/PR 的任务 ID',
    '  --decision <d>            人工分诊裁决（accept | reject | merge-duplicate | needs-info | defer）',
    '  --rationale <text>        裁决理由说明',
    '  --rationale-file <path>   从 UTF-8 文件读取裁决理由',
    '  --duplicate-of <N>        重复指向的原 Issue/PR 编号',
    '  --feature-ref <id>        关联 Feature Map 条目',
    '  --context-basis <sha256>  写前复核上下文 SHA-256 指纹（防并发脏写）',
    '  --title <text>            离线补充标题',
    '  --body <text>             离线补充正文',
    '  --files <a,b>             补充涉及路径（逗号分隔）',
    '  --branch <name>           补充源分支名',
    '  --labels <a,b>            补充标签（逗号分隔）',
    '  --agent <id>              分诊代理标识',
    '  --apply                   执行写入评论/标签/关闭与持久化分诊记录',
    '  --dry-run                 仅预演不写入（默认）',
    '  --json                    输出结构化 JSON',
    '  --help                    显示帮助',
  ].join('\n') + '\n')
}

/** 供 `flow.mjs` 或独立调用方直接以 `(repoRoot, argv)` 形式运行 `flow intake`。 */
export async function runFlowIntake(repoRoot = process.cwd(), argv = []) {
  const cli = parseStandardCli(argv, {
    booleanFlags: ['apply', 'dry-run', 'help'],
    valueFlags: [
      'pr', 'issue', 'feature-ref', 'decision', 'rationale', 'rationale-file',
      'duplicate-of', 'context-basis', 'task', 'title', 'body', 'files', 'branch', 'labels', 'agent',
    ],
    aliases: { actor: 'agent' },
    usageHint: 'flow-intake.mjs (--pr <M> | --issue <N>) [--decision <d>] [--rationale "<text>"] [--rationale-file <path>] [--duplicate-of <#N>] [--feature-ref <id>] [--apply] [--dry-run] [--json]',
  })
  if (cli.help) {
    printHelp()
    return { exitCode: 0 }
  }
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
