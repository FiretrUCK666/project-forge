/**
 * flow-issues.mjs —— `flow.mjs issue <create|list|view|comment|close|migrate>` 与 `--create-issue` 建单引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），远端写操作统一先经 `probeForWrite` 探测通道。
 */

import { printNextStep } from '../../lib/cli.mjs'
import { slugify } from '../../lib/docs.mjs'
import { closeLocalIssue, getLocalIssue, listLocalIssues } from '../../lib/local-issues.mjs'
import { parseIssueNumbers, probeForWrite, probeGitHubEnv, resolveContributorIdentity } from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext } from './flow-context.mjs'
import { EXIT_ACTION_REQUIRED, EXIT_POLICY_BLOCK, inspectWorkspace } from './flow-inspect.mjs'

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
    return { exitCode: EXIT_POLICY_BLOCK, blocked: true }
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
  const issueTitle = String(opts.title ?? opts.slug ?? prelimTaskId).trim()
  const issueBody = String(opts.body ?? [
    `## 任务追踪`,
    `- Slug: \`${slugify(opts.slug ?? issueTitle)}\``,
    `- Case: Case ${caseType}`,
    opts.task ? `- Task ID: \`${opts.task}\`` : null,
  ].filter(Boolean).join('\n')).trim()
  const issueLabels = parseCsvList(opts.labels)

  const createRes = await backend.createIssue({
    repo: targetRepo,
    title: issueTitle,
    body: issueBody,
    labels: issueLabels,
  })
  if (createRes.delegated) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_CREATE_ISSUE_DELEGATED', ...createRes }, null, 2)}\n`)
    else process.stdout.write(`无直连 GitHub 凭据，已生成创建 Issue 代理载荷：${JSON.stringify(createRes.jsonPayload)}\n`)
    return { exitCode: EXIT_ACTION_REQUIRED, delegated: true }
  }
  if (!createRes.ok || !createRes.number) {
    throw new Error(`创建工单失败：${createRes.error ?? '未返回有效 Issue 编号'}`)
  }
  return { exitCode: 0, createdIssue: createRes }
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
    const title = String(opts.title ?? pos[1] ?? '').trim()
    if (!title) throw new Error('issue create 需要传入 --title "<标题>"')
    const ghProbe = useRemoteGh
      ? (opts._ghProbe ?? (await probeForWrite({ cwd: roots.mainRoot, remoteUrls: state.remoteUrls ?? {} })))
      : null
    const backend = buildBackendForIssue({
      role, providerId, targetRepo, ghProbe, clientOverride: opts._ghClient, mainRoot: roots.mainRoot, gitDir: roots.gitDir,
    })
    const res = await backend.createIssue({
      repo: targetRepo,
      title,
      body: String(opts.body ?? '').trim(),
      labels: parseCsvList(opts.labels),
    })
    if (res.delegated) {
      if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_CREATE_ISSUE_DELEGATED', ...res }, null, 2)}\n`)
      else process.stdout.write(`已生成创建 Issue 代理载荷：${JSON.stringify(res.jsonPayload)}\n`)
      return { exitCode: EXIT_ACTION_REQUIRED }
    }
    if (!res.ok) throw new Error(`创建工单失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, role, issue: res }, null, 2)}\n`)
    else process.stdout.write(`已创建工单 #${res.number}（${res.url ?? role}）：${res.title}\n`)
    return { exitCode: 0 }
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
    return { exitCode: 0 }
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
    return { exitCode: 0 }
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
    const contrib = resolveContributorIdentity({
      explicitActor: opts.agent,
      ghLogin: ghProbe?.env?.trackB?.login,
      gitName: state.gitIdentity?.name,
    })
    const res = await backend.postComment({ repo: targetRepo, number: num, body, author: contrib.actor })
    if (!res.ok && !res.delegated) throw new Error(`发表工单评论失败：${res.error ?? 'unknown'}`)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, number: num, comment: res }, null, 2)}\n`)
    else process.stdout.write(`已向工单 #${num} 追加评论。\n`)
    return { exitCode: 0 }
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
    return { exitCode: 0 }
  }

  if (action === 'migrate') {
    if (role === 'local-only') {
      const msg = 'BLOCKED_MIGRATE_NO_REMOTE: 当前仍为 local-only 模式，请先绑定远端后再运行 issue migrate。'
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_MIGRATE_NO_REMOTE' }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (!useRemoteGh && !opts._ghClient) {
      const msg = `BLOCKED_MIGRATE_UNSUPPORTED_BACKEND: 当前远端（role=${role}, provider=${providerId}）不支持自动远端建单迁移，可本地继续追踪。`
      if (opts.json) process.stdout.write(`${JSON.stringify({ ok: false, blocked: true, code: 'BLOCKED_MIGRATE_UNSUPPORTED_BACKEND' }, null, 2)}\n`)
      process.stderr.write(`${msg}\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
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
      const created = await remoteBackend.createIssue({
        repo: remoteRepo,
        title: item.title,
        body: bodyWithMeta,
        labels: item.labels ?? [],
      })
      if (created.delegated) {
        if (opts.json) process.stdout.write(`${JSON.stringify({ blocked: true, code: 'ACTION_REQUIRED_MIGRATE_DELEGATED', localNumber: item.number, ...created }, null, 2)}\n`)
        return { exitCode: EXIT_ACTION_REQUIRED }
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
      migrated.push({ localNumber: item.number, remoteNumber: created.number, remoteUrl: created.url ?? null, title: item.title })
    }
    if (opts.json) process.stdout.write(`${JSON.stringify({ ok: true, targetRepo: remoteRepo, migrated, total: migrated.length }, null, 2)}\n`)
    else {
      process.stdout.write(`已完成本地工单迁移：共 ${migrated.length} 条。\n`)
      for (const m of migrated) process.stdout.write(`- 本地 #${m.localNumber} -> 远端 #${m.remoteNumber}${m.remoteUrl ? ` (${m.remoteUrl})` : ''}\n`)
      if (migrated.length > 0) printNextStep(['可用 `flow.mjs start --issue <远端编号>` 继续基于远端工单协作。'], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  throw new Error(`未知 issue 子动作：${action}（支持 create | list | view | comment | close | migrate）`)
}
