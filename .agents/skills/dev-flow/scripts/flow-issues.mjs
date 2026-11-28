/**
 * flow-issues.mjs —— `flow.mjs issue <create|list|view|comment|close|migrate>` 与 `--create-issue` 建单引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），远端写操作统一先经 `probeForWrite` 探测通道。
 */

import { resolve } from 'node:path'

import { EXIT } from '../../lib/exit-codes.mjs'
import { printNextStep, validateCrossRepoTarget } from '../../lib/cli.mjs'
import { buildIssueCloseComment, formatAttribution } from '../../lib/doc-comments.mjs'
import { formatWorkTitle } from '../../lib/escalation.mjs'
import { resolveTaskContext, sanitizeTaskId, updateTaskLedger } from '../../lib/ledger.mjs'
import { closeLocalIssue, getLocalIssue, listLocalIssues } from '../../lib/local-issues.mjs'
import { parseIssueNumbers, parseMilestoneNumber, probeForWrite, probePlatformEnv, resolveIdentityLayers } from '../../lib/platform.mjs'
import { buildTargetRepoContext } from './flow-context.mjs'
import { inspectWorkspace } from './flow-inspect.mjs'
import {
  buildAndValidateIssueBody,
  buildBackendForIssue,
  createIssueForStart,
  parseCsvList,
  resolveExplicitBodyText,
  resolveMilestoneId,
} from './flow-issue-core.mjs'

export { createIssueForStart }

async function assertNoCrossRepoIssueRef(roots, opts = {}) {
  const res = await validateCrossRepoTarget({
    cwd: roots.mainRoot,
    targetDir: roots.mainRoot,
    explicitDir: opts.dir ? resolve(String(opts.dir)) : roots.mainRoot,
    argv: [
      ...(Array.isArray(opts._) ? opts._ : []),
      opts.issue, opts.issues, opts.pr, opts['external-pr'], opts.milestone, opts.into,
    ].filter(Boolean).map(String),
    scriptPath: null,
    checkUrls: true,
  })
  if (!res.ok) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: res.code, reason: res.reason, urlRepo: res.urlRepo ?? null }, null, 2)}\n`)
    process.stderr.write(`${res.reason}\n`)
    return res
  }
  return null
}

async function resolveOrCreateRemoteMilestone(remoteBackend, remoteRepo, localMilestone) {
  if (!localMilestone) return null
  const rawTitle = typeof localMilestone === 'object' ? (localMilestone.title ?? '') : String(localMilestone)
  const cleanTitle = String(rawTitle).trim()
  if (cleanTitle && typeof remoteBackend?.listMilestones === 'function') {
    const listed = await Promise.resolve(remoteBackend.listMilestones({ repo: remoteRepo, state: 'all' })).catch(() => null)
    const hit = listed?.milestones?.find((m) => String(m.title ?? '').trim().toLowerCase() === cleanTitle.toLowerCase())
    if (hit?.number) return hit.number
    if (typeof remoteBackend.createMilestone === 'function') {
      const createdMs = await remoteBackend.createMilestone({
        repo: remoteRepo,
        title: cleanTitle,
        description: localMilestone?.description ?? '',
        dueOn: localMilestone?.dueOn ?? null,
      })
      if (createdMs?.ok && createdMs?.number) return createdMs.number
    }
  }
  return parseMilestoneNumber(localMilestone?.number ?? localMilestone) ?? (cleanTitle || null)
}

async function closeIssuesStructured({
  opts, roots, state, issueNums, reason = '', intoIssue = null, taskId = null, postWhenNoReason = false,
}) {
  const role = state.identity.role
  const providerId = state.identity.providerId ?? 'none'
  const targetCtx = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, null, { cwd: roots.mainRoot, providerHint: providerId })
  const { targetRepo } = targetCtx
  const useRemoteGh = role !== 'local-only' && role !== 'generic-git' && targetCtx.capabilities?.issues === true && Boolean(targetRepo)
  const ghProbe = useRemoteGh
    ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} })))
    : null
  const backend = buildBackendForIssue({
    role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
  })
  const idLayers = resolveIdentityLayers({
    ghLogin: ghProbe?.env?.trackB?.login,
    ghTier: ghProbe?.env?.trackB?.tier,
    gitName: state.gitIdentity?.name,
    explicitAgent: opts.agent,
  })
  const actorDisplay = formatAttribution({ ...idLayers, capabilities: backend.capabilities })
  const closed = []

  for (const num of issueNums) {
    let commentRes = null
    let rendered = null
    if (reason || postWhenNoReason) {
      rendered = buildIssueCloseComment({
        issueNumber: num, reason, intoIssue, taskId, actorDisplay,
        account: idLayers.account, verifiedPlatformLogin: idLayers.verifiedPlatformLogin,
        agent: idLayers.agent, capabilities: backend.capabilities,
      })
      commentRes = await backend.postComment({
        taskId: taskId ?? undefined,
        repo: targetRepo,
        number: num,
        body: rendered.bodyWithoutTag,
        statePayload: rendered.statePayload,
      })
    }
    const closeRes = await backend.closeIssue({
      repo: targetRepo,
      number: num,
      reason,
      ...(intoIssue ? { migratedTo: intoIssue } : {}),
    })
    if (closeRes?.delegated) {
      return { delegated: true, role, number: num, closeRes, commentRes, rendered }
    }
    if (!closeRes?.ok) throw new Error(`关闭工单 #${num} 失败：${closeRes?.error ?? 'unknown'}`)
    closed.push({
      number: num,
      close: closeRes,
      ...(commentRes ? { comment: commentRes } : {}),
      ...(rendered ? { statePayload: rendered.statePayload, commentBody: rendered.commentBody } : {}),
    })
  }
  return { delegated: false, role, closed }
}

/** 执行 `flow.mjs close --issue <N> [--into <targetIssue>] --reason "<原因>" [--task <id>] [--json]`。 */
export async function handleClose(opts, roots) {
  if (!roots.isGit) throw new Error('当前目录还不是 Git 仓库，请先初始化版本库')
  const crossErr = await assertNoCrossRepoIssueRef(roots, opts)
  if (crossErr) return { exitCode: crossErr.exitCode, blocked: true, code: crossErr.code }
  const issueNums = parseIssueNumbers([opts.issue, opts.issues, ...(Array.isArray(opts._) ? opts._ : [])])
  if (issueNums.length === 0) throw new Error('close 需要传入 --issue <N>')
  const reason = String(opts.reason ?? opts.note ?? '').trim()
  if (!reason) throw new Error('close 需要传入 --reason "<原因>"')

  let intoIssue = null
  if (opts.into !== undefined) {
    const intoNums = parseIssueNumbers(opts.into, { strict: true })
    if (intoNums.length !== 1) throw new Error(`--into 需要 1 个正整数目标 Issue 编号，收到：${opts.into}`)
    if (issueNums.includes(intoNums[0])) throw new Error(`--into 不能指向待关闭的同一个工单 #${intoNums[0]}`)
    intoIssue = intoNums[0]
  }
  const taskId = opts.task ? sanitizeTaskId(opts.task) : null
  const state = await inspectWorkspace(roots.mainRoot, {
    roots, lightStart: true, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe,
  })
  const out = await closeIssuesStructured({
    opts, roots, state, issueNums, reason, intoIssue, taskId, postWhenNoReason: true,
  })
  if (out.delegated) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_CLOSE_ISSUE_DELEGATED', ...out.closeRes }, null, 2)}\n`)
    else process.stdout.write(`无直连 GitHub 凭据，已生成关闭工单 #${out.number} 代理载荷：${JSON.stringify(out.closeRes.jsonPayload)}\n`)
    return { exitCode: EXIT.HUMAN }
  }
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, role: out.role, into: intoIssue, reason, taskId, closed: out.closed }, null, 2)}\n`)
  } else {
    for (const item of out.closed) {
      process.stdout.write(`工单 #${item.number} 已结构化关闭${intoIssue ? `（归并至 #${intoIssue}）` : ''}${item.close.alreadyClosed ? '（原本已关闭，幂等跳过）' : ''}。\n`)
    }
  }
  return { exitCode: EXIT.OK }
}

/** 执行 `flow.mjs issue <create|list|view|comment|close|migrate>`。 */
export async function handleIssue(opts, roots) {
  if (!roots.isGit) throw new Error('当前目录还不是 Git 仓库，请先初始化版本库')
  const crossErr = await assertNoCrossRepoIssueRef(roots, opts)
  if (crossErr) return { exitCode: crossErr.exitCode, blocked: true, code: crossErr.code }
  const pos = Array.isArray(opts._) ? opts._ : []
  const action = String(opts.action ?? pos[0] ?? 'list').trim().toLowerCase()
  const state = await inspectWorkspace(roots.mainRoot, {
    roots, lightStart: true, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe,
  })
  const role = state.identity.role
  const providerId = state.identity.providerId ?? 'none'
  const targetCtx = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, null, { cwd: roots.mainRoot, providerHint: providerId })
  const { targetRepo } = targetCtx
  const useRemoteGh = role !== 'local-only' && role !== 'generic-git' && targetCtx.capabilities?.issues === true && Boolean(targetRepo)

  const resolveIssueNum = () => {
    const raw = opts.issue ?? opts.issues ?? pos[1]
    const nums = parseIssueNumbers(raw)
    if (nums.length === 0) throw new Error(`issue ${action} 需要传入 --issue <N> 或位置参数 <N>`)
    return nums[0]
  }

  if (action === 'create') {
    if (opts.mode !== undefined) {
      const msg = 'issue create 采用单一平台中性质量契约，不支持 --mode 双轨参数'
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, error: msg }, null, 2)}\n`)
      process.stderr.write(`Error: ${msg}\n`)
      return { exitCode: EXIT.USAGE }
    }
    const rawTitle = String(opts.title ?? pos[1] ?? '').trim()
    if (!rawTitle) throw new Error('issue create 需要传入 --title "<标题>"')
    const title = opts.case !== undefined ? formatWorkTitle(rawTitle, Number(opts.case)) : rawTitle
    const createCase = opts.case !== undefined ? Number(opts.case) : undefined
    const createLabels = parseCsvList(opts.labels)
    const issueKind = createCase === 2 || createLabels.some((l) => /bug|fix|defect/i.test(l)) ? 'bug' : 'feature'
    const explicitBody = resolveExplicitBodyText(roots.mainRoot, opts)
    const built = buildAndValidateIssueBody({
      roots,
      title: rawTitle,
      issueKind,
      caseType: createCase,
      rawExplicitBody: explicitBody,
      opts,
    })
    if (!built.ok) {
      return { exitCode: built.exitCode, blocked: true, code: built.code }
    }
    const body = built.body
    const ghProbe = useRemoteGh
      ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} })))
      : null
    const backend = buildBackendForIssue({
      role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    const milestone = await resolveMilestoneId(backend, targetRepo, opts.milestone)
    const res = await backend.createIssue({
      repo: targetRepo,
      title,
      body,
      labels: createLabels,
      ...(milestone ? { milestone } : {}),
    })
    if (res.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_CREATE_ISSUE_DELEGATED', ...res }, null, 2)}\n`)
      else process.stdout.write(`已生成创建 Issue 代理载荷：${JSON.stringify(res.jsonPayload)}\n`)
      return { exitCode: EXIT.HUMAN }
    }
    if (!res.ok) throw new Error(`创建工单失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, issue: res }, null, 2)}\n`)
    else process.stdout.write(`已创建工单 #${res.number}（${res.url ?? role}）：${res.title}\n`)
    return { exitCode: EXIT.OK }
  }

  if (action === 'list') {
    const listState = String(opts.state ?? 'open').toLowerCase()
    const ghProbe = useRemoteGh
      ? (opts._ghProbe ?? (await probePlatformEnv({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {}, probeNetwork: true })))
      : null
    const backend = buildBackendForIssue({
      role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    const res = await backend.listIssues({ repo: targetRepo, state: listState })
    if (!res.ok && !res.delegated) throw new Error(`列举工单失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, state: listState, issues: res.issues ?? [] }, null, 2)}\n`)
    else {
      const list = res.issues ?? []
      if (list.length === 0) process.stdout.write(`当前无状态为 ${listState} 的工单。\n`)
      for (const it of list) {
        process.stdout.write(`#${it.number} [${it.state}] ${it.title}${it.labels?.length ? ` (${it.labels.join(', ')})` : ''}\n`)
      }
    }
    return { exitCode: EXIT.OK }
  }

  if (action === 'view') {
    const num = resolveIssueNum()
    const ghProbe = useRemoteGh
      ? (opts._ghProbe ?? (await probePlatformEnv({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {}, probeNetwork: true })))
      : null
    const backend = buildBackendForIssue({
      role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    const res = await backend.getIssue({ repo: targetRepo, number: num })
    if (!res.ok) {
      if (!useRemoteGh) {
        throw new Error(`本地 .git/issues 未找到工单 #${num}（跨机克隆不携带仓外 .git 状态，请直接查阅仓库内 docs/specs 或 docs/todo 文档）`)
      }
      throw new Error(`读取工单 #${num} 失败：${res.error ?? 'not-found'}`)
    }
    if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
    else {
      process.stdout.write(`#${res.number} [${res.state}] ${res.title}\n`)
      if (res.body) process.stdout.write(`${res.body}\n`)
      if (Array.isArray(res.comments) && res.comments.length > 0) {
        process.stdout.write(`--- 评论 (${res.comments.length}) ---\n`)
        for (const c of res.comments) process.stdout.write(`- [${c.author ?? 'user'}] ${c.body}\n`)
      }
    }
    return { exitCode: EXIT.OK }
  }

  if (action === 'comment') {
    const num = resolveIssueNum()
    const body = String(resolveExplicitBodyText(roots.mainRoot, opts, opts.comment ?? opts.note ?? pos[2]) ?? '').trim()
    if (!body) throw new Error('issue comment 需要传入 --body "<内容>" 或 --body-file <路径>')
    const ghProbe = useRemoteGh
      ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} })))
      : null
    const backend = buildBackendForIssue({
      role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    const idLayers = resolveIdentityLayers({
      ghLogin: ghProbe?.env?.trackB?.login,
      ghTier: ghProbe?.env?.trackB?.tier,
      gitName: state.gitIdentity?.name,
      explicitAgent: opts.agent,
    })
    const res = await backend.postComment({ repo: targetRepo, number: num, body, author: idLayers.agent || idLayers.account || undefined })
    if (!res.ok && !res.delegated) throw new Error(`发表工单评论失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, number: num, comment: res }, null, 2)}\n`)
    else process.stdout.write(`已向工单 #${num} 追加评论。\n`)
    return { exitCode: EXIT.OK }
  }

  if (action === 'close') {
    const num = resolveIssueNum()
    const reason = String(opts.reason ?? opts.body ?? opts.note ?? '').trim()
    const intoNum = opts.into !== undefined ? parseIssueNumbers(opts.into, { strict: true })[0] ?? null : null
    const taskId = opts.task ? sanitizeTaskId(opts.task) : null
    const out = await closeIssuesStructured({
      opts, roots, state, issueNums: [num], reason, intoIssue: intoNum, taskId, postWhenNoReason: false,
    })
    if (out.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_CLOSE_ISSUE_DELEGATED', ...out.closeRes }, null, 2)}\n`)
      else process.stdout.write(`无直连 GitHub 凭据，已生成关闭工单 #${num} 代理载荷：${JSON.stringify(out.closeRes.jsonPayload)}\n`)
      return { exitCode: EXIT.HUMAN }
    }
    const res = out.closed[0].close
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, number: num, close: res }, null, 2)}\n`)
    else process.stdout.write(`工单 #${num} 已关闭${res.alreadyClosed ? '（原本已关闭，幂等跳过）' : ''}。\n`)
    return { exitCode: EXIT.OK }
  }

  if (action === 'migrate') {
    if (role === 'local-only') {
      const msg = 'BLOCKED_MIGRATE_NO_REMOTE: 当前仍为 local-only 模式，请先绑定远端后再运行 issue migrate。'
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_MIGRATE_NO_REMOTE' }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT }
    }
    if (!useRemoteGh && !opts._ghClient) {
      const msg = `BLOCKED_MIGRATE_UNSUPPORTED_BACKEND: 当前远端（role=${role}, provider=${providerId}）不支持自动远端建单迁移，可本地继续追踪。`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_MIGRATE_UNSUPPORTED_BACKEND' }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT.FACT }
    }
    const ghProbe = opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} }))
    const remoteRepo = targetRepo ?? 'local/migrated'
    const remoteBackend = buildBackendForIssue({
      role: 'maintainer', providerId: targetCtx.providerId || providerId, targetRepo: remoteRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    const onlyNums = opts.issue || opts.issues ? parseIssueNumbers([opts.issue, opts.issues]) : null
    const openLocal = listLocalIssues({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, state: 'open' })
    const targets = (openLocal.issues ?? []).filter((it) => !onlyNums || onlyNums.includes(it.number))
    const migrated = []
    for (const item of targets) {
      const fullLocal = getLocalIssue({ mainRoot: roots.mainRoot, gitDir: roots.gitDir, number: item.number })
      const localComments = Array.isArray(fullLocal.comments) ? fullLocal.comments : (item.comments ?? [])
      const bodyWithMeta = [
        item.body || '',
        '',
        `> 迁移自本地工单 #${item.number}（createdAt: ${item.createdAt}）`,
      ].filter((x, idx) => idx > 0 || x).join('\n').trim()
      const remoteMilestone = await resolveOrCreateRemoteMilestone(remoteBackend, remoteRepo, item.milestone)
      const created = await remoteBackend.createIssue({
        repo: remoteRepo,
        title: item.title,
        body: bodyWithMeta,
        labels: item.labels ?? [],
        ...(remoteMilestone ? { milestone: remoteMilestone } : {}),
      })
      if (created.delegated) {
        if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_MIGRATE_DELEGATED', localNumber: item.number, ...created }, null, 2)}\n`)
        else {
          process.stderr.write(`ACTION_REQUIRED_MIGRATE_DELEGATED: 无直连 GitHub 凭据，本地工单 #${item.number} 迁移已生成宿主代理载荷。\n`)
          process.stdout.write(`${JSON.stringify(created.jsonPayload)}\n`)
          printNextStep(['请在宿主 MCP 完成远端建单，并在确认后执行 issue close 关闭原本地工单。'], { repoRoot: roots.mainRoot })
        }
        return { exitCode: EXIT.HUMAN }
      }
      if (!created.ok || !created.number) {
        throw new Error(`迁移本地工单 #${item.number} 至远端失败：${created.error ?? 'unknown'}`)
      }
      for (const c of localComments) {
        await remoteBackend.postComment({
          repo: remoteRepo,
          number: created.number,
          body: `[迁移自本地工单 #${item.number} 备注]\n\n${c.body ?? ''}`,
          deduplicate: false,
        })
      }
      await closeLocalIssue({
        mainRoot: roots.mainRoot,
        gitDir: roots.gitDir,
        number: item.number,
        reason: `migrated-to-remote-#${created.number}`,
        migratedTo: created.number,
        migratedUrl: created.url ?? null,
      })
      migrated.push({ localNumber: item.number, remoteNumber: created.number, remoteUrl: created.url ?? null, title: item.title, ...(remoteMilestone ? { milestone: remoteMilestone } : {}) })
    }
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, targetRepo: remoteRepo, migrated, total: migrated.length }, null, 2)}\n`)
    else {
      process.stdout.write(`已完成本地工单迁移：共 ${migrated.length} 条。\n`)
      for (const m of migrated) process.stdout.write(`- 本地 #${m.localNumber} -> 远端 #${m.remoteNumber}${m.remoteUrl ? ` (${m.remoteUrl})` : ''}\n`)
      if (migrated.length > 0) printNextStep(['可用 `flow.mjs start --issue <远端编号>` 继续基于远端工单协作。'], { repoRoot: roots.mainRoot })
    }
    return { exitCode: EXIT.OK }
  }

  throw new Error(`未知 issue 子动作：${action}（支持 create | list | view | comment | close | migrate）`)
}

/** 按需执行 `flow.mjs milestone <create|list|assign|close>`（支持 GitHub / generic-git / local-only）。 */
export async function handleMilestone(opts, roots) {
  if (!roots.isGit) throw new Error('当前目录还不是 Git 仓库，请先初始化版本库')
  const crossErr = await assertNoCrossRepoIssueRef(roots, opts)
  if (crossErr) return { exitCode: crossErr.exitCode, blocked: true, code: crossErr.code }
  const pos = Array.isArray(opts._) ? opts._ : []
  const action = String(opts.action ?? pos[0] ?? 'list').trim().toLowerCase()
  const state = await inspectWorkspace(roots.mainRoot, {
    roots, lightStart: true, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe,
  })
  const role = state.identity.role
  const providerId = state.identity.providerId ?? 'none'
  const targetCtx = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, null, { cwd: roots.mainRoot, providerHint: providerId })
  const { targetRepo } = targetCtx
  const useRemoteGh = role !== 'local-only' && role !== 'generic-git' && targetCtx.capabilities?.milestones === true && Boolean(targetRepo)

  const ghProbe = useRemoteGh
    ? (action === 'list'
        ? (opts._ghProbe ?? (await probePlatformEnv({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {}, probeNetwork: true })))
        : (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} }))))
    : null
  const backend = buildBackendForIssue({
    role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
  })

  if (action === 'list') {
    const res = await backend.listMilestones({ repo: targetRepo, state: String(opts.state ?? 'open').toLowerCase() })
    if (!res.ok && !res.delegated) throw new Error(`列举里程碑失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, capabilities: backend.capabilities, ...res }, null, 2)}\n`)
    else {
      const items = res.milestones ?? []
      process.stdout.write(`里程碑列表（共 ${items.length} 条，role=${role}）：\n`)
      for (const m of items) process.stdout.write(`- #${m.number} [${m.state}] ${m.title}${m.dueOn ? ` (due=${m.dueOn})` : ''}\n`)
      for (const step of res.platformSetupChecklist ?? []) process.stdout.write(`- [人工同步清单] ${step}\n`)
    }
    return { exitCode: EXIT.OK }
  }

  if (action === 'create') {
    const title = String(opts.title ?? pos[1] ?? '').trim()
    if (!title) throw new Error('milestone create 需要传入 --title "<标题>"')
    const res = await backend.createMilestone({
      repo: targetRepo,
      title,
      description: String(opts.description ?? opts.body ?? '').trim(),
      dueOn: opts.due ?? opts['due-on'] ?? null,
    })
    if (res.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_MILESTONE_DELEGATED', ...res }, null, 2)}\n`)
      else process.stdout.write(`已生成创建里程碑代理载荷：${JSON.stringify(res.jsonPayload)}\n`)
      return { exitCode: EXIT.HUMAN }
    }
    if (!res.ok) throw new Error(`创建里程碑失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, capabilities: backend.capabilities, milestone: res }, null, 2)}\n`)
    else {
      process.stdout.write(`已创建里程碑 #${res.number ?? '?'}：${res.title ?? title}\n`)
      for (const step of res.platformSetupChecklist ?? []) process.stdout.write(`- [人工同步清单] ${step}\n`)
    }
    return { exitCode: EXIT.OK }
  }

  if (action === 'assign') {
    const msRaw = opts.milestone ?? pos[1]
    if (!msRaw) throw new Error('milestone assign 需要传入 --milestone <编号|标题|URL>')
    const msId = await resolveMilestoneId(backend, targetRepo, msRaw)
    const issueNums = parseIssueNumbers([opts.issue, opts.issues])
    const targets = issueNums.map((n) => ({ number: n, isPr: false }))
    if (opts.pr !== undefined && Number(opts.pr) > 0) targets.push({ number: Number(opts.pr), isPr: true })
    let taskCtx = null
    if (opts.task || targets.length === 0) {
      try { taskCtx = await resolveTaskContext(roots, opts) } catch { taskCtx = null }
      if (taskCtx && targets.length === 0) {
        for (const n of taskCtx.ledger.linkedIssues ?? []) {
          if (!targets.some((t) => !t.isPr && t.number === n)) targets.push({ number: n, isPr: false })
        }
        if (taskCtx.ledger.prNumber && !targets.some((t) => t.isPr && t.number === taskCtx.ledger.prNumber)) {
          targets.push({ number: taskCtx.ledger.prNumber, isPr: true })
        }
      }
    }
    if (targets.length === 0) throw new Error('milestone assign 需要传入 --issue <N>、--pr <N> 或关联 --task <taskId>')
    const results = []
    for (const target of targets) {
      const r = await backend.assignMilestone({ repo: targetRepo, number: target.number, milestone: msId, ...(target.isPr ? { isPr: true } : {}) })
      if (r.delegated) {
        if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_MILESTONE_DELEGATED', ...r }, null, 2)}\n`)
        else process.stdout.write(`已生成指派里程碑代理载荷：${JSON.stringify(r.jsonPayload)}\n`)
        return { exitCode: EXIT.HUMAN }
      }
      if (!r.ok) throw new Error(`指派里程碑至 ${target.isPr ? 'PR/MR ' : ''}#${target.number} 失败：${r.error ?? 'unknown'}`)
      results.push(r)
    }
    if (taskCtx) {
      await updateTaskLedger(roots.mainRoot, taskCtx.taskId, (cur) => (cur ? { ...cur, milestone: msId } : cur))
    }
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, milestone: msId, results }, null, 2)}\n`)
    else {
      process.stdout.write(`已将 ${targets.map((t) => `${t.isPr ? 'PR #' : '#'}${t.number}`).join(', ')} 归入里程碑 ${msId}。\n`)
      for (const step of results[0]?.platformSetupChecklist ?? []) process.stdout.write(`- [人工同步清单] ${step}\n`)
    }
    return { exitCode: EXIT.OK }
  }

  if (action === 'close') {
    const msRaw = opts.milestone ?? pos[1]
    const msNum = parseMilestoneNumber(msRaw) ?? await resolveMilestoneId(backend, targetRepo, msRaw)
    if (!Number.isInteger(Number(msNum)) || Number(msNum) <= 0) throw new Error('milestone close 需要有效里程碑编号')
    const res = await backend.closeMilestone({ repo: targetRepo, number: Number(msNum) })
    if (res.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_MILESTONE_DELEGATED', ...res }, null, 2)}\n`)
      else process.stdout.write(`已生成关闭里程碑代理载荷：${JSON.stringify(res.jsonPayload)}\n`)
      return { exitCode: EXIT.HUMAN }
    }
    if (!res.ok) throw new Error(`关闭里程碑 #${msNum} 失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, milestone: res }, null, 2)}\n`)
    else {
      process.stdout.write(`已关闭里程碑 #${msNum}。\n`)
      for (const step of res.platformSetupChecklist ?? []) process.stdout.write(`- [人工同步清单] ${step}\n`)
    }
    return { exitCode: EXIT.OK }
  }

  throw new Error(`未知 milestone 子动作：${action}（支持 create | list | assign | close）`)
}
