/**
 * flow-issue-core.mjs —— 工单正文组装校验、后端构造与 `start --create-issue` 建单核心。
 *
 * 独立于 `flow-inspect.mjs`，供 `flow-issues.mjs` 与 `flow-start-helpers.mjs` 单向复用，
 * 避免 `flow-inspect -> flow-start-helpers -> flow-issues -> flow-inspect` 循环依赖。
 */

import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { EXIT } from '../../lib/exit-codes.mjs'
import { assertNoAsciiControlChars } from '../../lib/cli.mjs'
import { slugify } from '../../lib/docs.mjs'
import { formatWorkTitle } from '../../lib/escalation.mjs'
import { extractPlanDocContext, validateIssueBodyQuality } from '../../lib/issue-quality.mjs'
import { hydrateIssueBody } from '../../lib/issue-template-hydrate.mjs'
import { parseMilestoneNumber, probeForWrite } from '../../lib/platform.mjs'
import { createTaskBackend } from '../../lib/task-backend.mjs'
import { buildTargetRepoContext } from './flow-context.mjs'

export function resolveExplicitBodyText(mainRoot, opts = {}, fallback = undefined) {
  const fileArg = opts['body-file'] ?? opts.bodyFile
  if (fileArg !== undefined && fileArg !== null && String(fileArg).trim() !== '') {
    const abs = isAbsolute(String(fileArg)) ? String(fileArg) : resolve(mainRoot, String(fileArg))
    if (!existsSync(abs)) throw new Error(`--body-file 指定的文件不存在：${abs}`)
    const raw = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    return assertNoAsciiControlChars(raw, '--body-file')
  }
  const raw = opts.body ?? fallback
  if (raw !== undefined && raw !== null) {
    assertNoAsciiControlChars(String(raw), '--body')
  }
  return raw
}

export async function resolveMilestoneId(backend, targetRepo, rawMilestone) {
  if (rawMilestone === null || rawMilestone === undefined || String(rawMilestone).trim() === '') return null
  const num = parseMilestoneNumber(rawMilestone?.number ?? rawMilestone)
  if (num) return num
  const wantTitle = String(rawMilestone?.title ?? rawMilestone).trim()
  if (!wantTitle || typeof backend?.listMilestones !== 'function') return wantTitle
  const listed = await Promise.resolve(backend.listMilestones({ repo: targetRepo, state: 'all' })).catch(() => null)
  const hit = listed?.milestones?.find((m) => String(m.title ?? '').trim().toLowerCase() === wantTitle.toLowerCase())
  return hit?.number ?? wantTitle
}

export function parseCsvList(raw) {
  if (!raw) return []
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean)
}

export function buildBackendForIssue({ role, providerId, targetRepo, ghProbe, clientOverride, mainRoot, gitDir }) {
  return createTaskBackend({
    role,
    providerId,
    targetRepo,
    client: clientOverride ?? ghProbe?.client,
    mainRoot,
    gitDir,
  })
}

export function buildAndValidateIssueBody({
  roots,
  title,
  issueKind,
  caseType = undefined,
  taskId = undefined,
  rawExplicitBody = undefined,
  opts = {},
}) {
  const workRoot = opts.workTreeRoot ?? roots.workTreeRoot ?? roots.mainRoot
  const planDocPaths = [opts.spec, opts.todo, opts.prd].filter(Boolean)
  const planCtx = planDocPaths.length > 0
    ? extractPlanDocContext(workRoot, planDocPaths, { mainRoot: roots.mainRoot })
    : null

  let fields
  if (!rawExplicitBody && planCtx && planCtx.verifiedDocRefs.length > 0) {
    const optFilesList = opts.files
      ? String(opts.files).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)
      : []
    const scopeFilesList = optFilesList.length > 0 ? optFilesList : planCtx.files
    const scopeFiles = scopeFilesList.length > 0 ? scopeFilesList : undefined
    const affectedText = (scopeFilesList.length > 0 ? scopeFilesList : planCtx.verifiedDocRefs)
      .slice(0, 8)
      .map((f) => `\`${f}\``)
      .join('、')
    fields = {
      title,
      caseType,
      taskId,
      summary: planCtx.summary || `依据设计文档推进「${title}」。`,
      impact: `影响路径：${affectedText}；severity=${Number(caseType) === 4 ? 'high' : 'medium'}；范围与边界以关联设计文档为准。`,
      files: scopeFiles,
      docRefs: planCtx.verifiedDocRefs,
      criteria: planCtx.criteria.length > 0 ? planCtx.criteria : undefined,
      outOfScope: planCtx.outOfScope || '未列入关联设计文档范围与本单验收标准的无关改动。',
    }
  } else {
    fields = {
      rawBody: rawExplicitBody,
      title,
      caseType,
      taskId,
      files: opts.files,
      summary: rawExplicitBody ? undefined : opts.summary,
      docRefs: planCtx?.verifiedDocRefs?.length ? planCtx.verifiedDocRefs : undefined,
    }
  }

  const body = hydrateIssueBody(roots.mainRoot, issueKind, fields).trim()
  const quality = validateIssueBodyQuality(body, {
    repoRoot: workRoot,
    mainRoot: roots.mainRoot,
    title,
    kind: issueKind,
    spec: opts.spec,
    todo: opts.todo,
    prd: opts.prd,
    docRefs: planCtx?.verifiedDocRefs ?? [],
  })
  if (!quality.ok) {
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        blocked: true,
        code: quality.code,
        exitCode: quality.exitCode,
        missing: quality.missing,
        reasons: quality.reasons,
        invalidDocRefs: quality.invalidDocRefs,
      }, null, 2)}\n`)
    }
    process.stderr.write(`${quality.code}: ${quality.reasons.join('；')}\n`)
    return { ok: false, exitCode: quality.exitCode, blocked: true, code: quality.code, quality }
  }
  return { ok: true, body, quality }
}

/** `flow.mjs start --create-issue` 共享建单逻辑（同时打通 `maintainer` / `local-only` / `generic-git`）。 */
export async function createIssueForStart({
  roots, state, role, providerId, prelimTaskId, caseType, opts = {},
}) {
  if (!['maintainer', 'local-only', 'generic-git'].includes(role)) {
    process.stderr.write(`BLOCKED_CREATE_ISSUE_ROLE: --create-issue 仅支持 maintainer、local-only 或 generic-git 创建新工单（当前 role=${role}）。\n`)
    return { exitCode: EXIT.FACT, blocked: true }
  }
  const targetCtx = buildTargetRepoContext(role, state.remoteUrls ?? {}, state.declaredRepo, null, { cwd: roots.mainRoot, providerHint: providerId })
  const { targetRepo } = targetCtx
  const useRemoteGh = role === 'maintainer' && targetCtx.capabilities?.issues === true
  if (useRemoteGh && !targetRepo) {
    throw new Error(`--create-issue 在 ${providerId} maintainer 模式下需要配置有效的远端仓库`)
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
  const workRoot = opts.workTreeRoot ?? roots.workTreeRoot ?? roots.mainRoot
  const planDocPaths = [opts.spec, opts.todo, opts.prd].filter(Boolean)
  const planCtx = planDocPaths.length > 0
    ? extractPlanDocContext(workRoot, planDocPaths, { mainRoot: roots.mainRoot })
    : null
  const rawTitle = String(opts.title ?? (planCtx?.title || null) ?? opts.slug ?? prelimTaskId).trim()
  const issueTitle = formatWorkTitle(rawTitle, caseType)
  const rawExplicitBody = resolveExplicitBodyText(workRoot, opts)
  const built = buildAndValidateIssueBody({
    roots,
    title: rawTitle,
    issueKind: caseType === 2 ? 'bug' : 'feature',
    caseType,
    taskId: opts.task ?? slugify(opts.slug ?? rawTitle),
    rawExplicitBody,
    opts,
  })
  if (!built.ok) {
    return { exitCode: built.exitCode, blocked: true, code: built.code }
  }
  const issueBody = built.body
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
