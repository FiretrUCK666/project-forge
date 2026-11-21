/**
 * flow-issues.mjs —— `flow.mjs issue <create|list|view|comment|close|migrate>` 与 `--create-issue` 建单引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），远端写操作统一先经 `probeForWrite` 探测通道。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { printNextStep } from '../../lib/cli.mjs'
import { slugify } from '../../lib/docs.mjs'
import { formatWorkTitle } from '../../lib/escalation.mjs'
import { resolveTaskContext, updateTaskLedger } from '../../lib/ledger.mjs'
import { closeLocalIssue, getLocalIssue, listLocalIssues } from '../../lib/local-issues.mjs'
import { parseIssueNumbers, parseMilestoneNumber, probeForWrite, probeGitHubEnv, resolveIdentityLayers } from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext } from './flow-context.mjs'
import { inspectWorkspace } from './flow-inspect.mjs'

async function resolveMilestoneId(backend, targetRepo, rawMilestone) {
  if (rawMilestone === null || rawMilestone === undefined || String(rawMilestone).trim() === '') return null
  const num = parseMilestoneNumber(rawMilestone?.number ?? rawMilestone)
  if (num) return num
  const wantTitle = String(rawMilestone?.title ?? rawMilestone).trim()
  if (!wantTitle || typeof backend?.listMilestones !== 'function') return wantTitle
  const listed = await Promise.resolve(backend.listMilestones({ repo: targetRepo, state: 'all' })).catch(() => null)
  const hit = listed?.milestones?.find((m) => String(m.title ?? '').trim().toLowerCase() === wantTitle.toLowerCase())
  return hit?.number ?? wantTitle
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

function parseCsvList(raw) {
  if (!raw) return []
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

function buildBackendForIssue({ role, providerId, targetRepo, ghProbe, clientOverride, mainRoot, gitDir }) {
  return createTaskBackend({
    role,
    providerId,
    targetRepo,
    client: clientOverride ?? ghProbe?.client,
    mainRoot,
    gitDir,
  })
}

/** `flow.mjs start --create-issue` 共享建单逻辑（同时打通 `maintainer` / `local-only` / `generic-git`）。 */
export async function createIssueForStart({
  roots, state, role, providerId, prelimTaskId, caseType, opts = {},
}) {
  if (!['maintainer', 'local-only', 'generic-git'].includes(role)) {
    process.stderr.write(`BLOCKED_CREATE_ISSUE_ROLE: --create-issue 仅支持 maintainer、local-only 或 generic-git 创建新工单（当前 role=${role}）。\n`)
    return { exitCode: EXIT.FACT, blocked: true }
  }
  const { targetRepo } = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo)
  const useRemoteGh = role === 'maintainer' && providerId === 'github'
  if (useRemoteGh && !targetRepo) {
    throw new Error('--create-issue 在 GitHub maintainer 模式下需要配置有效的 GitHub 远端仓库')
  }
  const ghProbe = useRemoteGh
    ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} })))
    : null
  const backend = buildBackendForIssue({
    role,
    providerId,
    targetRepo,
    ghProbe,
    clientOverride: opts._ghClient,
    mainRoot: roots.mainRoot,
    gitDir: roots.gitDir,
  })
  const rawTitle = String(opts.title ?? opts.slug ?? prelimTaskId).trim()
  const issueTitle = formatWorkTitle(rawTitle, caseType)
  const docRefs = [opts.spec, opts.todo, opts.prd].filter(Boolean).map((p) => `\`${p}\``).join('、')
  const issueBody = String(opts.body ?? [
    '## 背景与现象',
    '',
    `推进「${rawTitle}」任务（Case ${caseType}）。`,
    '',
    '## 范围与依据',
    '',
    `- 任务标识：\`${opts.task ?? slugify(opts.slug ?? rawTitle)}\``,
    docRefs ? `- 关联文档：${docRefs}` : null,
    opts.files ? `- 预计写域：${String(opts.files).split(/[\s,]+/).filter(Boolean).slice(0, 8).map((f) => `\`${f}\``).join('、')}` : null,
    '',
    '## 验收标准',
    '',
    `- [ ] C1: 完成「${rawTitle}」实现并通过对应正反双向测试与完整门禁`,
  ].filter((x) => x !== null).join('\n')).trim()
  const issueLabels = parseCsvList(opts.labels)
  const milestone = await resolveMilestoneId(
    backend,
    targetRepo,
    opts.milestone ?? state.inputs?.milestones?.[0]?.number ?? null,
  )

  const createRes = await backend.createIssue({
    repo: targetRepo,
    title: issueTitle,
    body: issueBody,
    labels: issueLabels,
    ...(milestone ? { milestone } : {}),
  })
  if (createRes.delegated) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_CREATE_ISSUE_DELEGATED', ...createRes }, null, 2)}\n`)
    else process.stdout.write(`无直连 GitHub 凭据，已生成创建 Issue 代理载荷：${JSON.stringify(createRes.jsonPayload)}\n`)
    return { exitCode: EXIT.HUMAN, delegated: true }
  }
  if (!createRes.ok || !createRes.number) {
    throw new Error(`创建工单失败：${createRes.error ?? '未返回有效 Issue 编号'}`)
  }
  return { exitCode: EXIT.OK, createdIssue: createRes }
}

/** 执行 `flow.mjs issue <create|list|view|comment|close|migrate>`。 */
export async function handleIssue(opts, roots) {
  if (!roots.isGit) throw new Error('当前目录还不是 Git 仓库，请先初始化版本库')
  const pos = Array.isArray(opts._) ? opts._ : []
  const action = String(opts.action ?? pos[0] ?? 'list').trim().toLowerCase()
  const state = await inspectWorkspace(roots.mainRoot, {
    roots, lightStart: true, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe,
  })
  const role = state.identity.role
  const providerId = state.identity.providerId ?? 'none'
  const { targetRepo } = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo)
  const useRemoteGh = role !== 'local-only' && role !== 'generic-git' && providerId === 'github' && Boolean(targetRepo)

  const resolveIssueNum = () => {
    const raw = opts.issue ?? opts.issues ?? pos[1]
    const nums = parseIssueNumbers(raw)
    if (nums.length === 0) throw new Error(`issue ${action} 需要传入 --issue <N> 或位置参数 <N>`)
    return nums[0]
  }

  if (action === 'create') {
    const rawTitle = String(opts.title ?? pos[1] ?? '').trim()
    if (!rawTitle) throw new Error('issue create 需要传入 --title "<标题>"')
    const title = opts.case !== undefined ? formatWorkTitle(rawTitle, Number(opts.case)) : rawTitle
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
      body: String(opts.body ?? '').trim(),
      labels: parseCsvList(opts.labels),
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
      ? (opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {}, probeNetwork: true })))
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
      ? (opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {}, probeNetwork: true })))
      : null
    const backend = buildBackendForIssue({
      role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    const res = await backend.getIssue({ repo: targetRepo, number: num })
    if (!res.ok) throw new Error(`读取工单 #${num} 失败：${res.error ?? 'not-found'}`)
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
    const body = String(opts.body ?? opts.comment ?? opts.note ?? pos[2] ?? '').trim()
    if (!body) throw new Error('issue comment 需要传入 --body "<内容>"')
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
    const ghProbe = useRemoteGh
      ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} })))
      : null
    const backend = buildBackendForIssue({
      role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    if (reason) {
      await backend.postComment({
        repo: targetRepo,
        number: num,
        body: `关闭工单：${reason}`,
        statePayload: { action: 'close', issue: num, reason },
      })
    }
    const res = await backend.closeIssue({ repo: targetRepo, number: num, reason })
    if (!res.ok && !res.delegated) throw new Error(`关闭工单 #${num} 失败：${res.error ?? 'unknown'}`)
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
      role: 'maintainer', providerId: 'github', targetRepo: remoteRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
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
  const pos = Array.isArray(opts._) ? opts._ : []
  const action = String(opts.action ?? pos[0] ?? 'list').trim().toLowerCase()
  const state = await inspectWorkspace(roots.mainRoot, {
    roots, lightStart: true, _ghClient: opts._ghClient, _ghProbe: opts._ghProbe,
  })
  const role = state.identity.role
  const providerId = state.identity.providerId ?? 'none'
  const { targetRepo } = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo)
  const useRemoteGh = role !== 'local-only' && role !== 'generic-git' && providerId === 'github' && Boolean(targetRepo)

  const ghProbe = useRemoteGh
    ? (action === 'list'
        ? (opts._ghProbe ?? (await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {}, probeNetwork: true })))
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
    const targetNums = [...issueNums]
    if (opts.pr !== undefined && Number(opts.pr) > 0) targetNums.push(Number(opts.pr))
    let taskCtx = null
    if (opts.task || targetNums.length === 0) {
      try { taskCtx = await resolveTaskContext(roots, opts) } catch { taskCtx = null }
      if (taskCtx && targetNums.length === 0) {
        for (const n of taskCtx.ledger.linkedIssues ?? []) if (!targetNums.includes(n)) targetNums.push(n)
        if (taskCtx.ledger.prNumber && !targetNums.includes(taskCtx.ledger.prNumber)) targetNums.push(taskCtx.ledger.prNumber)
      }
    }
    if (targetNums.length === 0) throw new Error('milestone assign 需要传入 --issue <N>、--pr <N> 或关联 --task <taskId>')
    const results = []
    for (const num of targetNums) {
      const r = await backend.assignMilestone({ repo: targetRepo, number: num, milestone: msId })
      if (r.delegated) {
        if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_MILESTONE_DELEGATED', ...r }, null, 2)}\n`)
        else process.stdout.write(`已生成指派里程碑代理载荷：${JSON.stringify(r.jsonPayload)}\n`)
        return { exitCode: EXIT.HUMAN }
      }
      if (!r.ok) throw new Error(`指派里程碑至 #${num} 失败：${r.error ?? 'unknown'}`)
      results.push(r)
    }
    if (taskCtx) {
      await updateTaskLedger(roots.mainRoot, taskCtx.taskId, (cur) => (cur ? { ...cur, milestone: msId } : cur))
    }
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, milestone: msId, results }, null, 2)}\n`)
    else {
      process.stdout.write(`已将 ${targetNums.map((n) => `#${n}`).join(', ')} 归入里程碑 ${msId}。\n`)
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
