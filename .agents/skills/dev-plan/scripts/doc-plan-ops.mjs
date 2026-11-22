/**
 * doc-plan-ops.mjs —— `doc-plan.mjs` 文档澄清记录（clarify）与规范取代（supersede）辅助操作。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 doc-plan.mjs 以控制入口文件行数。
 */

import { EXIT } from '../../lib/exit-codes.mjs'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { criteriaFingerprint, extractCriteria } from '../../lib/criteria-lock.mjs'
import { evaluateCritiqueOverride, parseCritiqueRounds, readPlanCritiqueEntrySync } from '../../lib/critique-rounds.mjs'
import {
  DOC_FRONTMATTER_KEY_ORDER, docDateTag, docIsoDate, parseDocFrontmatter,
  renderStandardDocTemplate, resolveRepoCustomDocTemplate, slugify, syncDocsLifecycle, updateDocFrontmatter,
} from '../../lib/docs.mjs'
import { evaluateReleaseReason } from '../../lib/evidence-substance.mjs'
import { ensureWorktreesIgnored, gitRun, posixPath, readTextSafe, writeAtomic } from '../../lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { readTaskLedger, recordPlanningProvenance, sanitizeTaskId, updateTaskLedger } from '../../lib/ledger.mjs'
import { parseIssueNumbers } from '../../lib/platform.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
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
  let workingText = text
  let critiqueSkipped = false
  let skippedCritiqueValue = null

  if (docType === 'spec' || docType === 'prd') {
    const { entry: planCritiqueEntry } = readPlanCritiqueEntrySync({
      repoRoot, mainRoot, gitDir, taskId, fmData: fm.data, relDoc: audit.file,
    })
    const priorRounds = parseCritiqueRounds(fm.data, workingText, planCritiqueEntry)
    const critiqueState = evaluateCritiqueOverride(workingText, fm.data, planCritiqueEntry)
    const override = critiqueState.override
    const hasStopLoss = priorRounds.some((r) => Boolean(r.stopLossTriggered))
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
  const hasPlaceholder = /^- \[[ xX]\] C\d+:\s*<[^>]+>/m.test(workingText)
  if (fm.hasFrontmatter) {
    const patch = { status: nextStatus, updated: docIsoDate() }
    if (docType === 'spec' || docType === 'todo') patch.approved = true
    if (skippedCritiqueValue) patch.plan_critique = skippedCritiqueValue
    updateDocFrontmatter(abs, patch, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  } else {
    writeAtomic(abs, workingText.replace(/^((?:-\s+)?Status:\s*)\S+(\s*)$/mi, `$1${nextStatus}$2`))
  }

  const criteria = extractCriteria(workingText)
  const fingerprint = criteria.length > 0 ? criteriaFingerprint(criteria) : null
  return {
    file: posixPath(relative(repoRoot, abs)), previousStatus: curStatus, status: nextStatus, critiqueSkipped,
    criteriaCount: criteria.length,
    criteriaFingerprint: fingerprint,
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

/** 向规划文档追加已拍板澄清记录（可选同时新增 `C<N>` 验收条款）。 */
export function clarifyDoc({ repoRoot, file, question = '', decision, by = 'user', explicitBy = undefined, criterion = '' }) {
  if (!file || !decision || !String(decision).trim()) {
    throw new Error('clarify 需要 --file <docPath> 与 --decision "<已确认结论>"')
  }
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到文档：${file}`)
  const raw = readTextSafe(abs)
  if (raw === undefined) throw new Error(`无法读取文本文件：${file}`)

  const norm = raw.replace(/\r\n/g, '\n')
  const fmCheck = parseDocFrontmatter(norm)
  if (String(fmCheck.data?.plan_mode ?? '').trim().toLowerCase() === 'interactive') {
    const actor = String(explicitBy ?? '').trim().toLowerCase()
    if (actor !== 'user') {
      throw Object.assign(
        new Error('BLOCKED_INTERACTIVE_CLARIFY_USER_REQUIRED: plan_mode=interactive 的澄清确认必须显式传入 --by user，禁止代理自答。'),
        { code: 'BLOCKED_INTERACTIVE_CLARIFY_USER_REQUIRED', exitCode: EXIT.USAGE },
      )
    }
  }
  const today = docIsoDate()
  const byNote = by && String(by).trim() ? ` · ${String(by).trim()}` : ''
  const qText = question && String(question).trim() ? `${String(question).trim()} -> ` : ''
  const entry = `- 已确认（${today}${byNote}）：${qText}${String(decision).trim()}`

  const lines = norm.split('\n')
  const secIdx = lines.findIndex((l) => /^##\s+澄清与补充记录(?:\s|$)/.test(l))
  if (secIdx >= 0) {
    let endIdx = lines.length
    for (let i = secIdx + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i])) { endIdx = i; break }
    }
    const existingBody = lines.slice(secIdx + 1, endIdx)
      .filter((l) => !/^\s*-\s*（本轮无额外澄清补充/.test(l))
    while (existingBody.length > 0 && !existingBody[existingBody.length - 1].trim()) existingBody.pop()
    while (existingBody.length > 0 && !existingBody[0].trim()) existingBody.shift()
    const nextBody = existingBody.length > 0 ? ['', ...existingBody, entry, ''] : ['', entry, '']
    lines.splice(secIdx + 1, endIdx - secIdx - 1, ...nextBody)
  } else {
    const anchorIdx = lines.findIndex((l) => /^##\s+(?:实现说明|完成后的记录|待拍板问题)/.test(l))
    const insertBlock = ['## 澄清与补充记录', '', entry, '']
    if (anchorIdx >= 0) lines.splice(anchorIdx, 0, ...insertBlock)
    else {
      while (lines.length > 0 && !lines[lines.length - 1].trim()) lines.pop()
      lines.push('', ...insertBlock)
    }
  }
  let updatedText = lines.join('\n')
  if (!updatedText.endsWith('\n')) updatedText += '\n'

  let addedCriterion = null
  if (criterion && String(criterion).trim()) {
    let maxN = 0
    for (const cm of updatedText.matchAll(/^- \[[ xX]\] C(\d+)\b/gm)) {
      const n = Number(cm[1])
      if (n > maxN) maxN = n
    }
    const nextId = `C${maxN + 1}`
    const critLine = `- [ ] ${nextId}: ${String(criterion).trim()}`
    addedCriterion = { id: nextId, line: critLine }
    const cLines = updatedText.split('\n')
    let lastCritIdx = -1
    for (let i = 0; i < cLines.length; i += 1) {
      if (/^- \[[ xX]\] C\d+\b/.test(cLines[i])) lastCritIdx = i
    }
    if (lastCritIdx >= 0) cLines.splice(lastCritIdx + 1, 0, critLine)
    else cLines.push(critLine)
    updatedText = cLines.join('\n')
  }

  writeAtomic(abs, updatedText)
  const fm = parseDocFrontmatter(updatedText)
  if (fm.hasFrontmatter) {
    const docType = detectDocType(posixPath(relative(repoRoot, abs)), updatedText)
    updateDocFrontmatter(abs, { updated: today }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  }
  return { file: posixPath(relative(repoRoot, abs)), entry, addedCriterion, updated: today }
}

function parseInitIssueArg(rawIssue) {
  if (rawIssue === undefined || rawIssue === null || rawIssue === '') return null
  const nums = parseIssueNumbers(rawIssue, { strict: true })
  if (nums.length !== 1) throw new Error(`--issue 需要 1 个正整数 Issue 编号或 URL，收到：${rawIssue}`)
  return nums[0]
}

export async function initDoc({
  repoRoot, mainRoot, gitDir, isGit, type, kind, slug, title,
  taskId, issue, owner, branch, relatedSpec, relatedPrd, milestone, force = false, noPrune = false,
  planMode = null, worktree = false, multiSpec = false, caseType = null,
}) {
  const effectiveKind = kind ?? type
  if (!['prd', 'spec', 'todo', 'tdd', 'pair', 'all'].includes(effectiveKind)) {
    throw new Error(`--kind / --type 必须是 prd、spec、todo、tdd、pair 或 all，收到：${effectiveKind}`)
  }
  const safeSlug = slugify(slug)
  const issueNum = parseInitIssueArg(issue)
  const dateTag = docDateTag()
  const today = docIsoDate()

  let writeRoot = repoRoot
  let existingLedger = null
  const effTaskId = taskId ? sanitizeTaskId(taskId) : (worktree ? sanitizeTaskId(safeSlug) : null)
  if (effTaskId) {
    existingLedger = readTaskLedger(mainRoot, effTaskId)
    if (existingLedger?.worktreePath && existsSync(join(mainRoot, existingLedger.worktreePath))) {
      writeRoot = join(mainRoot, existingLedger.worktreePath)
    }
  }
  let planningBranch = branch ?? existingLedger?.branch ?? null
  let planningWorktreeRel = existingLedger?.worktreePath ?? null
  if (worktree) {
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
  const kindsToCreate = effectiveKind === 'pair' ? ['spec', 'todo'] : effectiveKind === 'all' ? ['prd', 'spec', 'todo'] : [effectiveKind]
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
        pruneUnfilled: false, noPrune: Boolean(noPrune), docShape, planMode,
        multiSpec: Boolean(multiSpec && item.kind === 'prd'),
        caseType: Number.isInteger(caseType) ? caseType : null,
      })
    }
    mkdirSync(dirname(item.absFile), { recursive: true })
    writeAtomic(item.absFile, content)
  }

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

  let ledgerUpdated = false
  if (milestone) {
    for (const item of planned) {
      if (item.kind !== 'tdd') updateDocFrontmatter(item.absFile, { milestone }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[item.kind] ?? [] })
    }
  }
  if (effTaskId && !(effectiveKind === 'prd' && multiSpec)) {
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
      if (worktree) {
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
        isolation: worktree ? 'worktree' : null,
        worktreePath: worktree ? planningWorktreeRel : null,
        branch: worktree ? planningBranch : null,
        planning: worktree,
        status: worktree ? 'planning' : 'planned',
      },
    })
    ledgerUpdated = true
  }

  const primary = planned[planned.length - 1]
  if (mainRoot) {
    recordPlanningProvenance(mainRoot, {
      docRoot: writeRoot,
      docRels: planned.filter((p) => p.kind !== 'tdd').map((p) => p.file),
      taskId: effTaskId && !(effectiveKind === 'prd' && multiSpec) ? effTaskId : null,
    })
  }
  return {
    type: effectiveKind, kind: effectiveKind, writeRoot, file: primary.file, absFile: primary.absFile,
    files: planned.map((p) => p.file), created: planned.map((p) => ({ kind: p.kind, file: p.file })),
    taskId: effTaskId, worktreePath: planningWorktreeRel, branch: planningBranch,
    issue: issueNum, milestone: milestone ?? null, plannedAt: headSha, ledgerUpdated, customTemplates,
  }
}
