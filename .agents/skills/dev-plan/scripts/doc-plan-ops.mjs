/**
 * doc-plan-ops.mjs —— `doc-plan.mjs` 文档澄清记录（clarify）与规范取代（supersede）辅助操作。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 doc-plan.mjs 以控制入口文件行数。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { criteriaFingerprint, extractCriteria } from '../../lib/criteria-lock.mjs'
import { evaluateCritiqueOverride, parseCritiqueRounds, persistPlanCritiqueEntrySync, readPlanCritiqueEntrySync } from '../../lib/critique-rounds.mjs'
import {
  DOC_FRONTMATTER_KEY_ORDER, docDateTag, docIsoDate, isApprovingStatus, parseDocFrontmatter,
  renderStandardDocTemplate, resolveRepoCustomDocTemplate, serializeDocFrontmatter,
  slugify, syncDocsLifecycle, syncPlanDocBodyMeta, updateDocFrontmatter,
} from '../../lib/docs.mjs'
import { applyPreInitToDocContent, clarifyDoc } from '../../lib/doc-plan-clarify.mjs'
import { resolveApprovalBasis } from '../../lib/plan-exit-gate.mjs'
import { evaluateReleaseReason } from '../../lib/evidence-substance.mjs'
import { canonicalPath, ensureWorktreesIgnored, gitRun, isDefaultBranch, posixPath, readTextSafe, writeAtomic } from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { readTaskLedger, recordPlanningProvenance, sanitizeTaskId, updateTaskLedger } from '../../lib/ledger.mjs'
import { parseIssueNumbers } from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { buildDuplicatePlanDocError, findDuplicatePlanDocs, indexPlanDocs } from '../../lib/plan-index.mjs'
import { consumePreInitNotes, readPreInitState, resolveInheritedTriagePlanMode } from '../../lib/session-state.mjs'
import { migrateVisualBriefOnInit, refreshVisualBriefForDoc, sanitizeBriefKey, upsertVisualBrief } from '../../lib/visual-brief.mjs'
import { probeWorkspaceDocShape } from '../../lib/doc-shape.mjs'
import { collectTddFacts } from '../../lib/tdd-facts.mjs'
import { buildPreFilledTdd } from '../../lib/tdd-scaffold.mjs'
import { auditDoc, detectDocType } from './doc-audit.mjs'

/** 校验 Critique/Audit/停损条件后批准 SPEC/PRD/Todo 并冻结 C1..Cn 验收指纹。 */
export function approveSpec({
  repoRoot, mainRoot = repoRoot, gitDir = null, file, skipCritiqueReason, taskId = null,
  hostMode = 'multi-agent', humanApproved = false,
}) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到 SPEC/PRD 文件：${file}`)
  const text = readTextSafe(abs)
  if (text === undefined) throw new Error(`无法读取文本文件：${file}`)

  const audit = auditDoc({ repoRoot, file })
  if (!audit.ok) {
    const err = new Error(`BLOCKED_AUDIT_FAILED: ${audit.file} 尚未通过 doc-plan.mjs audit（共 ${audit.errors.length} 项缺陷），请先自修后再 approve`)
    err.audit = audit
    throw err
  }

  const fm = parseDocFrontmatter(text)
  const legacyStatusMatch = /^((?:-\s+)?Status:\s*)(\S+)(\s*)$/mi.exec(text)
  const curStatusRaw = fm.hasFrontmatter ? fm.data?.status : (fm.data?.status ?? legacyStatusMatch?.[2])
  if (!curStatusRaw) throw new Error(`${file} 缺少 status 字段，无法切换状态`)
  const curStatus = String(curStatusRaw).toLowerCase()
  if (curStatus === 'superseded' || curStatus === 'implemented') {
    throw new Error(`${file} 当前状态为 ${curStatus}，不允许直接 approve`)
  }
  if (!/^- \[[ xX]\]\s+C\d+\b/m.test(text)) throw new Error(`${file} 至少需要包含一条「- [ ] C<N>: ...」可判定验收标准才可批准`)

  const docType = detectDocType(audit.file, text)
  if (docType === 'spec' && typeof fm.data?.related_prd === 'string' && fm.data.related_prd.trim() && !/^(?:null|none|无)$/i.test(fm.data.related_prd.trim())) {
    const prdCandAbs = resolve(dirname(abs), fm.data.related_prd.trim())
    const prdFallbackAbs = resolve(repoRoot, fm.data.related_prd.trim())
    const prdAbs = existsSync(prdCandAbs) ? prdCandAbs : (existsSync(prdFallbackAbs) ? prdFallbackAbs : null)
    if (prdAbs) {
      const prdText = readTextSafe(prdAbs) ?? ''
      const prdFm = parseDocFrontmatter(prdText)
      const prdStatus = String(prdFm.data?.status ?? 'draft').trim().toLowerCase()
      if (!['superseded', 'dropped'].includes(prdStatus)) {
        const prdRel = posixPath(relative(repoRoot, prdAbs))
        const { entry: prdEntry } = readPlanCritiqueEntrySync({
          repoRoot, mainRoot, gitDir, taskId: prdFm.data?.task_id ?? taskId, fmData: prdFm.data, relDoc: prdRel,
        })
        const prdBasis = resolveApprovalBasis({ rel: prdRel, kind: 'prd', docType: 'prd', text: prdText, data: prdFm.data, ledgerEntry: prdEntry })
        const prdApproved = isApprovingStatus('prd', prdStatus) || prdStatus === 'done'
        if (!prdApproved || !prdBasis.hasBasis) {
          throw Object.assign(
            new Error(`BLOCKED_MASTER_PRD_CRITIQUE_UNREADY: ${audit.file} 关联的总控 PRD (${prdRel}) 尚未完成 Critique 并批准（status=${prdStatus}, basis=${prdBasis.basis}），请先完成总控 PRD 审批后再 approve 子 SPEC。`),
            { code: 'BLOCKED_MASTER_PRD_CRITIQUE_UNREADY', exitCode: EXIT.FACT },
          )
        }
      }
    }
  }
  let workingText = text
  let critiqueSkipped = false
  let skippedCritiqueValue = null
  let skipApprovalEntry = null
  let existingCritiqueEntry = null

  if (docType === 'spec' || docType === 'prd') {
    const { entry: planCritiqueEntry } = readPlanCritiqueEntrySync({
      repoRoot, mainRoot, gitDir, taskId, fmData: fm.data, relDoc: audit.file,
    })
    existingCritiqueEntry = planCritiqueEntry
    const priorRounds = parseCritiqueRounds(fm.data, workingText, planCritiqueEntry)
    const critiqueState = evaluateCritiqueOverride(workingText, fm.data, planCritiqueEntry)
    const override = critiqueState.override
    const roundsAtContinue = Array.isArray(planCritiqueEntry?.continued?.roundsAtContinue)
      ? planCritiqueEntry.continued.roundsAtContinue.map(Number).filter(Number.isFinite)
      : []
    const continueMaxRound = roundsAtContinue.length > 0
      ? Math.max(...roundsAtContinue)
      : (Number(planCritiqueEntry?.continued?.roundBaseline) || 0)
    const hasPostContinuePass = Boolean(
      planCritiqueEntry?.continued
      && priorRounds.some((r) => String(r?.verdict ?? '').toLowerCase() === 'passed' && Number(r?.round) > continueMaxRound),
    )
    const hasStopLoss = priorRounds.some((r) => Boolean(r.stopLossTriggered)) && !hasPostContinuePass
    if (hasStopLoss && !override?.approved) {
      throw Object.assign(new Error(`STOP_LOSS_ESCALATE: ${audit.file} 已触发规划 Critique 停损且尚未解锁；请先运行 doc-plan.mjs critique-override --file "${audit.file}" --human-approved --reason "..."`), { code: 'STOP_LOSS_ESCALATE', exitCode: EXIT.HUMAN })
    }
    if (critiqueState.approved) {
      if (critiqueState.stale) {
        throw Object.assign(new Error(`BLOCKED_CRITIQUE_STALE: ${audit.file} 在人类 critique-override 后正文已被修改（override=${critiqueState.sha} !== current=${critiqueState.currentSha}），请重新复核或重签 override`), { code: 'BLOCKED_CRITIQUE_STALE', exitCode: EXIT.FACT })
      }
    } else {
      const currentSha = critiqueState.currentSha
      const critiqueVal = String(fm.data?.plan_critique ?? (/^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(workingText)?.[1] ?? '')).trim()
      if (!/^passed\b/i.test(critiqueVal)) {
        if (skipCritiqueReason && String(skipCritiqueReason).trim()) {
          if (!(hostMode === 'single-session' && humanApproved)) {
            throw Object.assign(
              new Error(`BLOCKED_CRITIQUE_REQUIRED: ${audit.file} 在 ${hostMode} 模式下禁止用 --skip-critique-reason 跳过规划内审；仅 --host-mode single-session --human-approved 才允许跳过。`),
              { code: 'BLOCKED_CRITIQUE_REQUIRED', exitCode: EXIT.FACT },
            )
          }
          // 跳过规划内审是本切片里最直接的一条后门：只校验非空，传一个占位词就能产出
          // 「已批准 + 跳过评审」。所以它和别的放行点用同一个判据，不再单独放宽。
          const reasonCheck = evaluateReleaseReason(skipCritiqueReason, { subject: '跳过规划内审的理由' })
          if (!reasonCheck.ok) {
            throw Object.assign(
              new Error(`BLOCKED_SHALLOW_OVERRIDE_REASON: ${reasonCheck.reason} 跳过规划内审必须写清：这次为什么不用它、漏掉它可能放过什么。`),
              { code: 'BLOCKED_SHALLOW_OVERRIDE_REASON', exitCode: EXIT.USAGE },
            )
          }
          skippedCritiqueValue = `skipped (reason=${reasonCheck.cleaned})`
          skipApprovalEntry = {
            approved: true,
            hostMode,
            humanApproved: true,
            reason: reasonCheck.cleaned,
            sha: currentSha,
            at: new Date().toISOString(),
          }
          if (!fm.hasFrontmatter) {
            const skipLine = `- Plan Critique: ${skippedCritiqueValue}`
            workingText = /^(?:-\s+)?Plan Critique:.*$/mi.test(workingText)
              ? workingText.replace(/^(?:-\s+)?Plan Critique:.*$/mi, skipLine)
              : workingText.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${skipLine}`)
          }
          critiqueSkipped = true
        } else {
          throw Object.assign(new Error(`BLOCKED_CRITIQUE_REQUIRED: ${audit.file} 为 ${docType.toUpperCase()} 文档，必须先通过独立 Critique 并运行 critique-pass，或传入 --skip-critique-reason "<原因>"`), { code: 'BLOCKED_CRITIQUE_REQUIRED', exitCode: EXIT.FACT })
        }
      } else {
        const shaMatch = /\bsha=([a-f0-9]{8,64})\b/i.exec(critiqueVal)
        if (shaMatch && currentSha.slice(0, shaMatch[1].length) !== shaMatch[1].toLowerCase() && !skipCritiqueReason) {
          throw Object.assign(new Error(`BLOCKED_CRITIQUE_STALE: ${audit.file} 在 critique-pass 之后正文已被修改（recorded=${shaMatch[1]} !== current=${currentSha.slice(0, shaMatch[1].length)}），请重新复核并执行 critique-pass`), { code: 'BLOCKED_CRITIQUE_STALE', exitCode: EXIT.FACT })
        }
      }
    }
  }

  const nextStatus = docType === 'todo'
    ? (['draft', 'pending'].includes(curStatus) ? 'active' : curStatus)
    : (docType === 'prd' ? 'active' : 'approved')
  const today = docIsoDate()
  const hasPlaceholder = /^- \[[ xX]\] C\d+:\s*<[^>]+>/m.test(workingText)
  if (fm.hasFrontmatter) {
    const patch = { status: nextStatus, updated: today }
    if (docType === 'spec' || docType === 'todo') patch.approved = true
    if (skippedCritiqueValue) patch.plan_critique = skippedCritiqueValue
    updateDocFrontmatter(abs, patch, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
    const afterFm = readTextSafe(abs) ?? workingText
    const parsedAfter = parseDocFrontmatter(afterFm)
    const syncedBody = syncPlanDocBodyMeta(parsedAfter.body.replace(/^\n+/, ''), parsedAfter.data, {
      status: nextStatus,
      today,
      critiquePassed: Boolean(parsedAfter.data?.approved === true || /^passed/i.test(String(parsedAfter.data?.plan_critique ?? ''))),
    })
    const keyOrder = [...(DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? []), ...parsedAfter.keyOrder, ...Object.keys(parsedAfter.data)]
    writeAtomic(abs, `${serializeDocFrontmatter(parsedAfter.data, keyOrder)}\n${syncedBody.endsWith('\n') ? syncedBody : `${syncedBody}\n`}`)
  } else {
    const updatedLegacy = workingText.replace(/^((?:-\s+)?Status:\s*)\S+(\s*)$/mi, `$1${nextStatus}$2`)
    writeAtomic(abs, syncPlanDocBodyMeta(updatedLegacy, { status: nextStatus, updated: today }, { status: nextStatus, today }))
  }

  const activatedTodos = []
  if (docType === 'spec') {
    const allDocs = indexPlanDocs(repoRoot, { includeArchive: false, includeWorktrees: false, managedOnly: true })
    const relSpec = posixPath(relative(repoRoot, abs))
    const specTaskId = fm.data?.task_id ? String(fm.data.task_id).trim() : null
    const specIssue = Number(fm.data?.issue) > 0 ? Number(fm.data.issue) : null
    const linkedTodoAbs = typeof fm.data?.related_todo === 'string' && !/^(?:null|none|无)$/i.test(fm.data.related_todo.trim())
      ? resolve(dirname(abs), fm.data.related_todo.trim())
      : null

    for (const d of allDocs) {
      if (d.kind !== 'todo' || d.inert) continue
      const todoRelSpec = typeof d.data?.related_spec === 'string' && !/^(?:null|none|无)$/i.test(d.data.related_spec.trim())
        ? posixPath(relative(repoRoot, resolve(dirname(d.abs), d.data.related_spec.trim())))
        : null
      const matched = todoRelSpec === relSpec
        || (linkedTodoAbs && canonicalPath(d.abs) === canonicalPath(linkedTodoAbs))
        || (specTaskId && d.taskId === specTaskId)
        || (specIssue && d.issue === specIssue)
      if (!matched) continue
      if (['draft', 'pending'].includes(d.status)) {
        updateDocFrontmatter(d.abs, { status: 'active', updated: today }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER.todo })
        const rawTodo = readTextSafe(d.abs) ?? ''
        const todoFm = parseDocFrontmatter(rawTodo)
        const syncedTodoBody = syncPlanDocBodyMeta(todoFm.body.replace(/^\n+/, ''), todoFm.data, { status: 'active', today })
        const todoKeyOrder = [...DOC_FRONTMATTER_KEY_ORDER.todo, ...todoFm.keyOrder, ...Object.keys(todoFm.data)]
        writeAtomic(d.abs, `${serializeDocFrontmatter(todoFm.data, todoKeyOrder)}\n${syncedTodoBody.endsWith('\n') ? syncedTodoBody : `${syncedTodoBody}\n`}`)
        activatedTodos.push(d.rel)
      }
    }
  }
  if (skipApprovalEntry) {
    persistPlanCritiqueEntrySync({
      repoRoot,
      mainRoot,
      gitDir,
      taskId: taskId ?? fm.data?.task_id ?? null,
      fmData: fm.data,
      relDoc: audit.file,
      entry: {
        ...(existingCritiqueEntry ?? {}),
        skipApproved: skipApprovalEntry,
        updatedAt: skipApprovalEntry.at,
      },
    })
  }

  const criteria = extractCriteria(workingText)
  const fingerprint = criteria.length > 0 ? criteriaFingerprint(criteria) : null
  const approvedRel = posixPath(relative(repoRoot, abs))
  let visualBrief = null
  try {
    visualBrief = refreshVisualBriefForDoc({ mainRoot, workRoot: repoRoot, file: approvedRel, taskId: taskId ?? fm.data?.task_id ?? null })?.summary ?? null
  } catch { /* non-fatal */ }
  return {
    file: approvedRel, previousStatus: curStatus, status: nextStatus, critiqueSkipped,
    activatedTodos,
    criteriaCount: criteria.length,
    criteriaFingerprint: fingerprint,
    ...(visualBrief ? { visualBrief } : {}),
    warning: hasPlaceholder ? '检测到仍有占位描述 <...>，动手实现前请替换成真实可判定条件' : null,
  }
}

/** 标记旧 SPEC 被新 SPEC 取代，并在双向 Frontmatter 建立互相指向。 */
export function supersedeSpec({ repoRoot, oldSpecPath, newSpecPath }) {
  if (!oldSpecPath || !newSpecPath) throw new Error('supersede 需要 <oldSpec> 与 --by <newSpec>')
  const oldAbs = resolve(repoRoot, oldSpecPath)
  const newAbs = resolve(repoRoot, newSpecPath)
  if (!existsSync(oldAbs)) throw new Error(`找不到被取代 SPEC：${oldSpecPath}`)
  if (!existsSync(newAbs)) throw new Error(`找不到新 SPEC：${newSpecPath}`)
  const today = docIsoDate()
  const relOldToNew = posixPath(relative(dirname(oldAbs), newAbs))
  const relNewToOld = posixPath(relative(dirname(newAbs), oldAbs))
  updateDocFrontmatter(oldAbs, { status: 'superseded', updated: today, superseded_by: relOldToNew }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER.spec })
  updateDocFrontmatter(newAbs, { updated: today, supersedes: relNewToOld }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER.spec })
  return { oldSpec: posixPath(relative(repoRoot, oldAbs)), newSpec: posixPath(relative(repoRoot, newAbs)), status: 'superseded', supersededBy: relOldToNew }
}

export { applyPreInitToDocContent, clarifyDoc }

function parseInitIssueArg(rawIssue) {
  if (rawIssue === undefined || rawIssue === null || rawIssue === '') return null
  const nums = parseIssueNumbers(rawIssue, { strict: true })
  if (nums.length !== 1) throw new Error(`--issue 需要 1 个正整数 Issue 编号或 URL，收到：${rawIssue}`)
  return nums[0]
}

export async function initDoc({
  repoRoot, mainRoot, gitDir, isGit, type, kind, slug, specSlug = null, title,
  taskId, issue, owner, branch, relatedSpec, relatedPrd, milestone, force = false, noPrune = false,
  planMode = null, worktree = false, inPlace = false, multiSpec = false, caseType = null,
  topic = null, allowOpenDraft = false, scopePaths = [], criteria = [], dependsOn = [],
}) {
  const effectiveKind = kind ?? type
  if (!['prd', 'spec', 'todo', 'tdd', 'pair', 'all'].includes(effectiveKind)) {
    throw new Error(`--kind / --type 必须是 prd、spec、todo、tdd、pair 或 all，收到：${effectiveKind}`)
  }
  const safeSlug = slugify(specSlug || slug)
  const issueNum = parseInitIssueArg(issue)
  const dateTag = docDateTag()
  const today = docIsoDate()
  const kindsToCreate = effectiveKind === 'pair' ? ['spec', 'todo'] : effectiveKind === 'all' ? ['prd', 'spec', 'todo'] : [effectiveKind]

  const pendingPreInit = effectiveKind !== 'tdd' ? readPreInitState(mainRoot, { topic: topic ?? null }) : null
  const unresolvedOpen = pendingPreInit?.unresolvedOpen
    ?? (pendingPreInit?.openQuestions ?? []).map((text, idx) => ({ id: `Q${idx + 1}`, text, status: 'open' }))
  if (unresolvedOpen.length > 0 && !allowOpenDraft) {
    throw Object.assign(
      new Error(`BLOCKED_OPEN_QUESTIONS_UNRESOLVED: 主题 "${pendingPreInit.topicId}" 仍有 ${unresolvedOpen.length} 条未决待拍板问题（${unresolvedOpen.map((o) => `${o.id}: ${o.text}`).join('；')}）。请先通过 doc-plan note --topic "${pendingPreInit.topicId}" --resolve <id> 解决，或显式传入 --allow-open-draft 继续生成草稿。`),
      { code: 'BLOCKED_OPEN_QUESTIONS_UNRESOLVED', exitCode: EXIT.FACT, details: { topicId: pendingPreInit.topicId, open: unresolvedOpen } },
    )
  }

  if (effectiveKind !== 'tdd' && !force) {
    const duplicates = findDuplicatePlanDocs(repoRoot, {
      mainRoot,
      slug: safeSlug,
      issue: issueNum,
      kinds: kindsToCreate,
      includeWorktrees: true,
    })
    if (duplicates.length > 0) {
      throw buildDuplicatePlanDocError(duplicates, { slug: safeSlug, issue: issueNum })
    }
  }

  let writeRoot = repoRoot
  let existingLedger = null
  let effTaskId = taskId ? sanitizeTaskId(taskId) : (worktree ? sanitizeTaskId(safeSlug) : null)
  if (effTaskId) {
    existingLedger = readTaskLedger(mainRoot, effTaskId)
    if (existingLedger?.worktreePath && existsSync(join(mainRoot, existingLedger.worktreePath))) {
      writeRoot = join(mainRoot, existingLedger.worktreePath)
    }
  }
  let effWorktree = Boolean(worktree)
  if (!effWorktree && !inPlace && !(effectiveKind === 'prd' && multiSpec) && isGit && effectiveKind !== 'tdd' && canonicalPath(writeRoot) === canonicalPath(mainRoot)) {
    const curHead = readHeadFast(resolveGitDirFast(mainRoot), gitDir)
    let curBranch = curHead?.branch ?? null
    if (!curBranch) {
      const sym = await gitRun(mainRoot, ['symbolic-ref', '--short', 'HEAD'])
      if (sym.ok && sym.stdout.trim()) curBranch = sym.stdout.trim()
    }
    if (curBranch && await isDefaultBranch(mainRoot, curBranch)) {
      const cnt = await gitRun(mainRoot, ['rev-list', '--count', '-n', '1', 'HEAD'])
      if (cnt.ok && Number(cnt.stdout.trim()) > 0) {
        effWorktree = true
        if (!effTaskId) effTaskId = sanitizeTaskId(safeSlug)
      }
    }
  }

  let planningBranch = branch ?? existingLedger?.branch ?? null
  let planningWorktreeRel = existingLedger?.worktreePath ?? null
  if (effWorktree) {
    if (!isGit) throw new Error('--worktree 仅支持 Git 仓库')
    await ensureWorktreesIgnored(mainRoot, gitDir)
    planningWorktreeRel = planningWorktreeRel || `.worktrees/impl-${effTaskId}`
    planningBranch = planningBranch || `feat/${effTaskId}`
    const wtAbs = join(mainRoot, planningWorktreeRel)
    if (!existsSync(wtAbs)) {
      const hasBr = await gitRun(mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${planningBranch}`])
      const addArgs = hasBr.ok
        ? ['worktree', 'add', wtAbs, planningBranch]
        : ['worktree', 'add', '-b', planningBranch, wtAbs, 'HEAD']
      const wtRes = await gitRun(mainRoot, addArgs)
      if (!wtRes.ok) throw new Error(`创建规划隔离 worktree 失败：${wtRes.stderr}`)
    }
    writeRoot = wtAbs
  }

  const dirMap = { prd: 'docs/prd', spec: 'docs/specs', todo: 'docs/todo', tdd: 'docs' }
  const fastHead = isGit ? readHeadFast(resolveGitDirFast(writeRoot), gitDir) : null
  const headRes = fastHead?.oid
    ? { ok: true, stdout: fastHead.oid }
    : (isGit ? await gitRun(writeRoot, ['rev-parse', 'HEAD']) : { ok: false, stdout: '' })
  const headSha = headRes.ok && headRes.stdout ? headRes.stdout.trim() : 'uncommitted'
  let headBranch = branch ?? (fastHead?.branch ?? null)
  if (!headBranch && isGit && !fastHead) {
    const sym = await gitRun(writeRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (sym.ok && sym.stdout.trim()) headBranch = sym.stdout.trim()
    else {
      const brRes = await gitRun(writeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (brRes.ok && brRes.stdout && brRes.stdout.trim() !== 'HEAD') headBranch = brRes.stdout.trim()
    }
  }
  const profile = parseAgentsProfile(writeRoot)
  const quickCmd = profile.quickTest && profile.quickTest !== 'none'
    ? profile.quickTest
    : '无自动快测命令（按手动步骤实证替代）'
  const needsShape = kindsToCreate.some((k) => k !== 'tdd')
  const docShape = needsShape && !noPrune ? await probeWorkspaceDocShape(writeRoot) : null

  let inheritedPrdAbs = relatedPrd ? resolve(writeRoot, relatedPrd) : null
  if (!inheritedPrdAbs && relatedSpec) {
    const parentSpecAbs = resolve(writeRoot, relatedSpec)
    const parentRaw = readTextSafe(parentSpecAbs)
    const parentFm = parentRaw ? parseDocFrontmatter(parentRaw) : null
    const rawRelPrd = parentFm?.data?.related_prd
    if (typeof rawRelPrd === 'string' && rawRelPrd.trim() && !/^(?:无|none|null)$/i.test(rawRelPrd.trim())) {
      const candAbs = resolve(dirname(parentSpecAbs), rawRelPrd.trim())
      if (existsSync(candAbs)) inheritedPrdAbs = candAbs
    }
  }

  const planned = []
  for (const k of kindsToCreate) {
    const fileName = k === 'tdd' ? 'TDD.md' : `${dateTag}-${issueNum ? `issue${issueNum}-` : ''}${safeSlug}-${k}.md`
    const relFile = `${dirMap[k]}/${fileName}`
    const absFile = join(writeRoot, relFile)
    if (existsSync(absFile) && !force) throw new Error(`目标文件已存在：${relFile}（如确需重建请加 --force）`)
    planned.push({ kind: k, file: relFile, absFile })
  }

  planMode = planMode ?? resolveInheritedTriagePlanMode(mainRoot, { taskId: effTaskId, slug: safeSlug, topic: topic ?? null })

  const openOwnerKind = planned.find((p) => p.kind === 'spec')?.kind ?? planned[0]?.kind ?? null
  const customTemplates = []
  for (const item of planned) {
    const relatedSpecRel = item.kind === 'todo' && relatedSpec
      ? posixPath(relative(dirname(item.absFile), resolve(writeRoot, relatedSpec)))
      : null
    const relatedPrdRel = item.kind !== 'prd' && inheritedPrdAbs
      ? posixPath(relative(dirname(item.absFile), inheritedPrdAbs))
      : null
    const customTpl = resolveRepoCustomDocTemplate(writeRoot, item.kind)
    if (customTpl) customTemplates.push({ kind: item.kind, template: customTpl.rel })
    let content
    if (item.kind === 'tdd') {
      const facts = await collectTddFacts(writeRoot)
      content = buildPreFilledTdd(facts, {
        repoRoot: writeRoot,
        noPrune: Boolean(noPrune),
        projectName: title,
        today,
        topLevelDirs: facts?.tddShape?.topLevelDirs ?? [],
        allPaths: facts?.tddShape?.filePaths ?? [],
      })
    } else {
      content = renderStandardDocTemplate({
        kind: item.kind, repoRoot: writeRoot, title, safeSlug, today, headSha, headBranch,
        taskId, issueNum, owner, quickCmd, relatedPrdRel, relatedSpecRel,
        scopePaths, criteria, dependsOn,
        pruneUnfilled: false, noPrune: Boolean(noPrune), docShape, planMode,
        multiSpec: Boolean(multiSpec && item.kind === 'prd'),
        caseType: Number.isInteger(caseType)
          ? caseType
          : (item.kind === 'todo' && (effectiveKind === 'pair' || effectiveKind === 'all' || Boolean(relatedSpec)) ? 4 : null),
      })
      if (pendingPreInit) {
        content = applyPreInitToDocContent(content, pendingPreInit, item.kind, today, { includeOpen: item.kind === openOwnerKind })
      }
    }
    mkdirSync(dirname(item.absFile), { recursive: true })
    writeAtomic(item.absFile, content)
  }

  const absorbedPreInit = pendingPreInit
    ? consumePreInitNotes(mainRoot, { taskId: effTaskId ?? safeSlug, slug: safeSlug, topic: topic ?? pendingPreInit?.topicId ?? null })
    : null

  if (planned.length > 1 || relatedSpec || relatedPrd) {
    const syncRes = await syncDocsLifecycle(writeRoot, {
      slugOrPath: planned[0].file,
      issue: issueNum ?? undefined,
      branch: planned.length > 1 ? (headBranch ?? undefined) : (branch ?? undefined),
      owner: owner ?? undefined,
    })
    for (const r of syncRes.renamed ?? []) {
      const hit = planned.find((p) => p.file === r.from)
      if (hit) {
        hit.file = r.to
        hit.absFile = join(writeRoot, r.to)
      }
    }
  }

  let briefMigration = null
  let tddVisualBrief = null
  if (effectiveKind !== 'tdd' && mainRoot) {
    try {
      const prdItem = planned.find((p) => p.kind === 'prd')
      const resolvedRelPrd = inheritedPrdAbs ? posixPath(relative(writeRoot, inheritedPrdAbs)) : (relatedPrd ? posixPath(relatedPrd) : null)
      briefMigration = migrateVisualBriefOnInit({
        mainRoot,
        workRoot: writeRoot,
        topicId: topic ?? pendingPreInit?.topicId ?? absorbedPreInit?.topicId ?? null,
        existingBriefKey: absorbedPreInit?.briefKey ?? pendingPreInit?.briefKey ?? null,
        taskId: effTaskId,
        slug: safeSlug,
        kind: effectiveKind,
        multiSpec: Boolean(multiSpec && effectiveKind === 'prd'),
        prdRel: prdItem?.file ?? null,
        relatedPrdRel: resolvedRelPrd,
        title,
      })
    } catch { /* non-fatal */ }
  } else if (effectiveKind === 'tdd' && mainRoot) {
    try {
      const tddFile = planned[0]?.file ?? 'docs/TDD.md'
      const refreshed = refreshVisualBriefForDoc({ mainRoot, workRoot: writeRoot, file: tddFile, taskId: effTaskId })
      if (refreshed?.summary) {
        tddVisualBrief = refreshed.summary
      } else {
        const tddTopic = topic ?? (effTaskId || safeSlug || 'tdd')
        tddVisualBrief = upsertVisualBrief(mainRoot, {
          workRoot: writeRoot,
          briefKey: sanitizeBriefKey(tddTopic),
          kind: 'topic',
          topicId: tddTopic,
          title: title || 'Architecture TDD',
          verdict: `TDD refreshed (${tddFile})`,
        }).summary
      }
    } catch { /* non-fatal */ }
  }

  let ledgerUpdated = false
  if (milestone) {
    for (const item of planned) {
      if (item.kind !== 'tdd') updateDocFrontmatter(item.absFile, { milestone }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[item.kind] ?? [] })
    }
  }
  if (effTaskId && (effWorktree || !(effectiveKind === 'prd' && multiSpec))) {
    if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
    await updateTaskLedger(mainRoot, effTaskId, (cur) => {
      const next = { ...cur }
      for (const item of planned) {
        if (item.kind === 'prd') next.prdFile = item.file
        else if (item.kind === 'spec') next.specFile = item.file
        else if (item.kind === 'todo') next.todoFile = item.file
      }
      if (issueNum && Array.isArray(next.linkedIssues) && !next.linkedIssues.includes(issueNum)) {
        next.linkedIssues = [...next.linkedIssues, issueNum]
      }
      if (milestone) next.milestone = milestone
      if (briefMigration?.briefKey) next.briefKey = briefMigration.briefKey
      if (effWorktree) {
        next.isolation = 'worktree'
        next.worktreePath = planningWorktreeRel
        next.branch = planningBranch
        if (!cur.status || cur.status === 'planned' || cur.status === 'planning') {
          next.status = 'planning'
          next.planning = true
        }
      }
      return next
    }, {
      createIfMissing: true,
      defaults: {
        taskId: effTaskId, slug: safeSlug,
        ...(briefMigration?.briefKey ? { briefKey: briefMigration.briefKey } : {}),
        isolation: effWorktree ? 'worktree' : null,
        worktreePath: effWorktree ? planningWorktreeRel : null,
        branch: effWorktree ? planningBranch : null,
        planning: effWorktree,
        status: effWorktree ? 'planning' : 'planned',
      },
    })
    ledgerUpdated = true
  }

  const primary = planned[planned.length - 1]
  if (mainRoot) {
    recordPlanningProvenance(mainRoot, {
      docRoot: writeRoot,
      docRels: planned.filter((p) => p.kind !== 'tdd').map((p) => p.file),
      taskId: effTaskId && (effWorktree || !(effectiveKind === 'prd' && multiSpec)) ? effTaskId : null,
    })
  }
  return {
    type: effectiveKind, kind: effectiveKind, writeRoot, file: primary.file, absFile: primary.absFile,
    files: planned.map((p) => p.file), created: planned.map((p) => ({ kind: p.kind, file: p.file })),
    taskId: effTaskId, worktreePath: planningWorktreeRel, branch: planningBranch,
    issue: issueNum, milestone: milestone ?? null, plannedAt: headSha, ledgerUpdated, customTemplates,
    planMode: planMode ?? null,
    absorbedPreInit,
    ...(briefMigration ? { briefMigration, visualBrief: briefMigration.summary } : {}),
    ...(!briefMigration && tddVisualBrief ? { visualBrief: tddVisualBrief } : {}),
  }
}

/** 按 1:N 切片从已有总控 PRD 拆出独立 SPEC（可选连带 Todo）。 */
export async function sliceSpec(opts = {}) {
  const { repoRoot, relatedPrd, specSlug, slug, title } = opts
  const effectiveSlug = specSlug || slug
  if (!relatedPrd || !effectiveSlug || !title) {
    throw new Error('slice 需要 --prd <prdPath>、--spec-slug <slug> 与 --title "<标题>"')
  }
  const prdAbs = resolve(repoRoot, relatedPrd)
  if (!existsSync(prdAbs)) throw new Error(`找不到父 PRD：${relatedPrd}`)
  const effKind = opts.kind === 'pair' ? 'pair' : 'spec'
  return initDoc({
    ...opts,
    kind: effKind,
    slug: effectiveSlug,
    specSlug: effectiveSlug,
    relatedPrd,
  })
}
