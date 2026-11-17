#!/usr/bin/env node
/**
 * doc-plan.mjs —— 五档需求分流、四层工程文档生成、规划自审净化、Critique、批准与归档取代。
 *
 * 子命令：
 *   triage         --summary <text> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]
 *   init           --kind prd|spec|todo|pair|all --slug <slug> --title <title> [--issue <N>] [--task <id>] [--spec <path>] [--force] [--json]
 *   link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <name>] [--owner <name>] [--status <s>] [--approve] [--json]
 *   audit          [--file <docPath> | .] [--json]
 *   critique-pass  --file <docPath> --reviewer <id> [--round 1|2] [--summary <text>] [--json]
 *   approve        --file <specPath> [--skip-critique-reason <text>] [--json]
 *   archive        [<slug-or-path>] [--task <id>] [--done-at YYYY-MM-DD] [--include-master-prd] [--json]
 *   supersede      <oldSpec> --by <newSpec> [--json]
 *   list           [--json]
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import {
  archiveCompletedDocsGroup, buildDocFilename, DOC_FRONTMATTER_KEY_ORDER,
  docDateTag, docIsoDate, parseDocFilename, parseDocFrontmatter,
  renderStandardDocTemplate, resolveRepoCustomDocTemplate, slugify, syncDocsLifecycle, updateDocFrontmatter,
} from '../../lib/docs.mjs'
import {
  ensureWorktreesIgnored, gitRun, gitStatusPorcelainZ, isMainModule,
  posixPath, readTextSafe, resolveRepoRoots, sha256Text, writeAtomic,
} from '../../lib/git.mjs'
import { criteriaFingerprint, extractCriteria } from '../../lib/criteria-lock.mjs'
import { buildCritiqueScope, CRITIQUE_FINDINGS_KEY, serializeFindings } from '../../lib/critique-rounds.mjs'
import { renderVerificationForReviewer, verifyDocClaims } from '../../lib/doc-verify.mjs'
import { probeWorkspaceDocShape } from '../../lib/doc-shape.mjs'
import { extractDocSnapshot } from '../../lib/doc-substantive.mjs'
import { collectTddFacts } from '../../lib/tdd-facts.mjs'
import { buildPreFilledTdd } from '../../lib/tdd-scaffold.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import {
  createDefaultLedger, readTaskLedger, resolveTaskContext, sanitizeTaskId, writeTaskLedger,
} from '../../lib/ledger.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { parseIssueNumbers, parsePrNumber } from '../../lib/platform.mjs'
import { auditDoc, auditRepoDocs, detectDocType, listDocs, stripCritiqueMeta, triageTask } from './doc-audit.mjs'

export { auditDoc, auditRepoDocs, listDocs, stripCritiqueMeta, triageTask }

function parseIssueArg(rawIssue) {
  if (rawIssue === undefined || rawIssue === null || rawIssue === '') return null
  const nums = parseIssueNumbers(rawIssue, { strict: true })
  if (nums.length !== 1) throw new Error(`--issue 需要 1 个正整数 Issue 编号或 URL，收到：${rawIssue}`)
  return nums[0]
}

async function initDoc({
  repoRoot, mainRoot, gitDir, isGit, type, kind, slug, title,
  taskId, issue, owner, branch, relatedSpec, relatedPrd, force = false, noPrune = false,
}) {
  const effectiveKind = kind ?? type
  if (!['prd', 'spec', 'todo', 'tdd', 'pair', 'all'].includes(effectiveKind)) {
    throw new Error(`--kind / --type 必须是 prd、spec、todo、tdd、pair 或 all，收到：${effectiveKind}`)
  }
  const safeSlug = slugify(slug)
  const issueNum = parseIssueArg(issue)
  const dateTag = docDateTag()
  const today = docIsoDate()

  // 若绑定 taskId 且已有隔离 worktree，直接落盘至实施工作树防止 doc-plan 与 flow start 撕裂
  let writeRoot = repoRoot
  let existingLedger = null
  if (taskId) {
    existingLedger = readTaskLedger(mainRoot, sanitizeTaskId(taskId))
    if (existingLedger?.worktreePath && existsSync(join(mainRoot, existingLedger.worktreePath))) {
      writeRoot = join(mainRoot, existingLedger.worktreePath)
    }
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
  const quickCmd = profile.quickTest ?? '<填写项目快测命令>'
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
    // TDD 是常青单文件，文件名固定为 docs/TDD.md——加日期前缀会让每份 TDD 变成新文件，
    // 而它本来就该被就地改写。
    const fileName = k === 'tdd' ? 'TDD.md' : buildDocFilename({ date: dateTag, issue: issueNum, slug: safeSlug, kind: k })
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
      // 从仓库事实预填：技术栈、模块表、命令这些读得出来的东西不该让人再抄一遍。
      // 只收集生成 TDD 需要的那几项事实：跑整套勘察既慢又跨层。
      const facts = await collectTddFacts(writeRoot)
      content = buildPreFilledTdd(facts, {
        projectName: title,
        today,
        topLevelDirs: facts?.tddShape?.topLevelDirs ?? [],
        allPaths: facts?.tddShape?.filePaths ?? [],
      })
    } else {
      content = renderStandardDocTemplate({
        kind: item.kind, repoRoot: writeRoot, title, safeSlug, today, headSha, headBranch,
        taskId, issueNum, owner, quickCmd, relatedPrdRel, relatedSpecRel,
        pruneUnfilled: false, noPrune: Boolean(noPrune), docShape,
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
  if (taskId) {
    if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
    const id = sanitizeTaskId(taskId)
    const ledger = existingLedger ?? createDefaultLedger({ taskId: id, slug: safeSlug, isolation: null, status: 'planned' })
    for (const item of planned) {
      if (item.kind === 'prd') ledger.prdFile = item.file
      else if (item.kind === 'spec') ledger.specFile = item.file
      else if (item.kind === 'todo') ledger.todoFile = item.file
    }
    if (issueNum && Array.isArray(ledger.linkedIssues) && !ledger.linkedIssues.includes(issueNum)) {
      ledger.linkedIssues = [...ledger.linkedIssues, issueNum]
    }
    writeTaskLedger(mainRoot, ledger)
    ledgerUpdated = true
  }

  const primary = planned[planned.length - 1]
  return {
    type: effectiveKind, kind: effectiveKind, writeRoot, file: primary.file, absFile: primary.absFile,
    files: planned.map((p) => p.file), created: planned.map((p) => ({ kind: p.kind, file: p.file })),
    issue: issueNum, plannedAt: headSha, ledgerUpdated, customTemplates,
  }
}

function normActorId(s) {
  return String(s ?? '').trim().replace(/^@/, '').toLowerCase()
}

/**
 * 从 `plan_critique` 戳里读上一轮的复核人。
 *
 * 戳的形状是 `passed (reviewer=<id>, round=<n>, sha=<hex>...)`。读不出来就返回 null——
 * 读不出来时不拦：老文档没有这个字段，拿「读不出来」当「同一个人」会把存量文档全堵死。
 */
function parseCritiqueReviewer(stamp) {
  const m = /reviewer=([^,)]+)/i.exec(String(stamp ?? ''))
  return m ? m[1].trim() : null
}

function critiquePassDoc({ repoRoot, file, reviewer, round = 1, summary = '', findings = [] }) {
  if (!reviewer || !String(reviewer).trim()) throw new Error('critique-pass 必须指定 --reviewer <reviewerId>')
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到文档：${file}`)

  const rawPre = readTextSafe(abs)
  if (rawPre === undefined) throw new Error(`无法读取文本文件：${file}`)
  const fmPre = parseDocFrontmatter(rawPre)
  if (fmPre.data?.owner && normActorId(fmPre.data.owner) && normActorId(fmPre.data.owner) === normActorId(reviewer)) {
    throw new Error(`SELF_CRITIQUE_REJECTED: critique-pass 独立复核人 (${reviewer}) 不得与文档负责人 (${fmPre.data.owner}) 相同`)
  }

  // Round 2 起必须换人。上一轮的复核人记在 frontmatter 里，读得到。
  const prevReviewer = parseCritiqueReviewer(fmPre.data?.plan_critique)
  if (Number(round) >= 2 && prevReviewer && normActorId(prevReviewer) === normActorId(reviewer)) {
    throw new Error(`BLOCKED_CRITIQUE_SAME_REVIEWER: Round ${round} 的复核人 (${reviewer}) 与上一轮相同。`
      + 'Round 2 起必须新建独立子代理复审——复用上一轮的上下文见过自己提出的意见，这一轮已经不算独立审了。')
  }

  const audit = auditDoc({ repoRoot, file })
  if (!audit.ok) {
    const err = new Error(`文档尚有 ${audit.errors.length} 处审计问题未自净化，禁止记录 critique-pass`)
    err.audit = audit
    throw err
  }

  const text = readTextSafe(abs)
  if (text === undefined) throw new Error(`无法读取文本文件：${file}`)
  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const docType = detectDocType(relDoc, text)
  const digest = sha256Text(stripCritiqueMeta(text)).slice(0, 12)
  const cleanSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()
  const stampValue = `passed (reviewer=${String(reviewer).trim()}, round=${round}, sha=${digest}${cleanSummary ? `, summary=${cleanSummary}` : ''})`

  // 把这一轮的意见记进 frontmatter：下一轮的范围就靠它，不靠谁的记忆。
  const prevFindings = fm.data?.[CRITIQUE_FINDINGS_KEY]
  const findingList = Array.isArray(findings) ? findings : []
  const newFindings = findingList.length > 0
    ? [String(prevFindings ?? '').trim(), serializeFindings(round, findingList)].filter(Boolean).join(' ;; ')
    : (prevFindings ?? null)

  if (fm.hasFrontmatter) {
    const snap = extractDocSnapshot(text)
    const patch = {
      plan_critique: stampValue,
      critique_anchors: JSON.stringify(snap),
      updated: docIsoDate(),
    }
    if (newFindings) patch[CRITIQUE_FINDINGS_KEY] = newFindings
    updateDocFrontmatter(abs, patch, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  } else {
    const stampLine = `- Plan Critique: ${stampValue}`
    let updated
    if (/^(?:-\s+)?Plan Critique:.*$/mi.test(text)) updated = text.replace(/^(?:-\s+)?Plan Critique:.*$/mi, stampLine)
    else if (/^(?:-\s+)?Status:.*$/mi.test(text)) updated = text.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${stampLine}`)
    else updated = text.replace(/^(#[^\n]*\n)/, `$1\n${stampLine}\n`)
    writeAtomic(abs, updated)
  }

  return { file: relDoc, reviewer: String(reviewer).trim(), round: Number(round), sha: digest, summary: cleanSummary || null, status: 'passed' }
}

function approveSpec({ repoRoot, file, skipCritiqueReason }) {
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
  if (!/^- \[[ xX]\] C1\b/m.test(text)) throw new Error(`${file} 至少需要包含一条「- [ ] C1: ...」可判定验收标准才可批准`)

  const docType = detectDocType(audit.file, text)
  let workingText = text
  let critiqueSkipped = false
  let skippedCritiqueValue = null

  if (docType === 'spec' || docType === 'prd') {
    const critiqueVal = String(fm.data?.plan_critique ?? (/^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(workingText)?.[1] ?? '')).trim()
    if (!/^passed\b/i.test(critiqueVal)) {
      if (skipCritiqueReason && String(skipCritiqueReason).trim()) {
        skippedCritiqueValue = `skipped (reason=${String(skipCritiqueReason).trim()})`
        if (!fm.hasFrontmatter) {
          const skipLine = `- Plan Critique: ${skippedCritiqueValue}`
          workingText = /^(?:-\s+)?Plan Critique:.*$/mi.test(workingText)
            ? workingText.replace(/^(?:-\s+)?Plan Critique:.*$/mi, skipLine)
            : workingText.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${skipLine}`)
        }
        critiqueSkipped = true
      } else {
        throw new Error(`BLOCKED_CRITIQUE_REQUIRED: ${audit.file} 为 ${docType.toUpperCase()} 文档，必须先通过独立 Critique 并运行 critique-pass，或传入 --skip-critique-reason "<原因>"`)
      }
    } else {
      const shaMatch = /\bsha=([a-f0-9]{8,64})\b/i.exec(critiqueVal)
      if (shaMatch) {
        const currentSha = sha256Text(stripCritiqueMeta(workingText)).slice(0, shaMatch[1].length)
        if (currentSha !== shaMatch[1].toLowerCase() && !skipCritiqueReason) {
          throw new Error(`BLOCKED_CRITIQUE_STALE: ${audit.file} 在 critique-pass 之后正文已被修改（recorded=${shaMatch[1]} !== current=${currentSha}），请重新复核并执行 critique-pass`)
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

  // 批准即冻结：把这一刻的验收标准指纹记下来。
  //
  // 「冻结」在此之前只是文档里的一句话。实现阶段回到 SPEC 里改一条标准，
  // 文件照样合法、audit 照样通过，而审查者只能凭记忆发现——人的记忆不是门禁。
  const criteria = extractCriteria(workingText)
  const fingerprint = criteria.length > 0 ? criteriaFingerprint(criteria) : null

  return {
    file: posixPath(relative(repoRoot, abs)), previousStatus: curStatus, status: nextStatus, critiqueSkipped,
    criteriaCount: criteria.length,
    criteriaFingerprint: fingerprint,
    warning: hasPlaceholder ? '检测到仍有占位描述 <...>，动手实现前请替换成真实可判定条件' : null,
  }
}

function supersedeSpec({ repoRoot, oldSpecPath, newSpecPath }) {
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

function clarifyDoc({ repoRoot, file, question = '', decision, by = 'user', criterion = '' }) {
  if (!file || !decision || !String(decision).trim()) {
    throw new Error('clarify 需要 --file <docPath> 与 --decision "<已确认结论>"')
  }
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到文档：${file}`)
  const raw = readTextSafe(abs)
  if (raw === undefined) throw new Error(`无法读取文本文件：${file}`)

  const norm = raw.replace(/\r\n/g, '\n')
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

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-plan/scripts/doc-plan.mjs <子命令> [选项]',
    '',
    '子命令：',
    '  triage         --summary <文本> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]',
    '  init           --kind <prd|spec|todo|pair|all> --slug <slug> --title <标题> [--issue <N>] [--task <id>] [--prd <path>] [--spec <path>] [--no-prune] [--json]',
    '  clarify        --file <docPath> --decision <结论> [--question <问题>] [--by <actor>] [--criterion <C条目>] [--json]',
    '  link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <B>] [--owner <O>] [--status <S>] [--approve] [--json]',
    '  audit          [--file <docPath> | .] [--json]',
    '  critique-pass  --file <docPath> --reviewer <id> [--round 1|2] [--summary <文本>] [--json]',
    '  approve        --file <specPath> [--skip-critique-reason <文本>] [--json]',
    '  archive        [<slug-or-path>] [--task <id>] [--done-at <YYYY-MM-DD>] [--include-master-prd] [--json]',
    '  supersede      <oldSpec> --by <newSpec> [--json]',
    '  list           [--json]',
  ].join('\n') + '\n')
}

const SUBCOMMANDS = ['triage', 'init', 'clarify', 'link', 'audit', 'critique-pass', 'approve', 'archive', 'supersede', 'list']

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }

  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      booleanFlags: ['touches-contract', 'conflicts-tdd', 'doc-only', 'bugfix', 'force', 'approve', 'implemented', 'include-master-prd', 'no-prune'],
      valueFlags: ['summary', 'files', 'paths', 'kind', 'type', 'slug', 'title', 'issue', 'task', 'spec', 'prd', 'file', 'pr', 'branch', 'owner', 'status', 'done-at', 'reviewer', 'round', 'skip-critique-reason', 'by', 'question', 'decision', 'criterion'],
      multiFlags: ['findings', 'finding'],
      aliases: { type: 'kind' },
      usageHint: 'doc-plan.mjs <triage|init|clarify|link|audit|critique-scope|critique-pass|approve|archive|supersede|list>',
    })
  } catch (err) {
    process.stderr.write(`doc-plan 错误：${err.message}\n`)
    return 2
  }
  const { sub, opts } = cli
  if (cli.help) { printHelp(); return 0 }

  const roots = await resolveRepoRoots(cli.targetDir)
  const repoRoot = roots.isGit ? roots.workTreeRoot : roots.cwd
  const mainRoot = roots.isGit ? roots.mainRoot : roots.cwd

  try {
    if (sub === 'triage') {
      const summary = opts.summary ?? opts._.join(' ')
      if (!summary) throw new Error('triage 需要传入 --summary "<需求描述>"')
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
      } else if (roots.isGit) {
        triagePaths = (await gitStatusPorcelainZ(repoRoot)).entries.map((e) => e.file)
      }
      const filesNum = isNumericFiles ? Number(rawFilesOpt) : (filesAsPaths.length > 0 ? filesAsPaths.length : undefined)
      const result = triageTask({
        summary, files: filesNum, touchesContract: Boolean(opts['touches-contract']),
        conflictsTdd: Boolean(opts['conflicts-tdd']), docOnly: Boolean(opts['doc-only']),
        bugfix: Boolean(opts.bugfix), paths: triagePaths, repoRoot,
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else {
        process.stdout.write(`分流结论：Case ${result.caseType} (${result.action})${result.blocked ? ' [BLOCKED]' : ''}\n`)
        process.stdout.write(`- 门型: ${result.doorType} | 规划内审档位: ${result.critiqueTier}\n- 理由: ${result.reason}\n`)
        process.stdout.write(`- 必建文档: ${result.docsRequired.join(', ') || '无 (0 文档)'}\n`)
        process.stdout.write(`- Red-Green 回归测试: ${result.redGreenRequired ? '强制' : '不需要'} | 独立审查: ${result.needsReview ? '需要' : '低风险免除'}\n`)
        for (const w of result.coupledSyncWarnings ?? []) {
          process.stdout.write(`  * 联动提醒: 触及 ${w.touchedTriggers.join(', ')} -> 检查同步 ${w.expectedCompanions.join(', ')}\n`)
        }
        const steps = result.caseType === 5
          ? ['已阻断直接拆解！请先更新 docs/TDD.md 解决冲突并经独立确认。']
          : result.caseType === 4
            ? [
                { skill: 'dev-plan', text: '1. 创建 SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind pair --slug <slug> --title "<标题>"' },
                '2. 自检净化并派独立只读 Critique -> critique-pass -> 人类 approve',
              ]
            : result.caseType === 3
              ? [
                  { skill: 'dev-flow', text: '1. 启动任务隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 3 --slug <slug>' },
                  { skill: 'dev-plan', text: '2. 生成 Todo 并跑 audit 自净化：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind todo --slug <slug> --title "<标题>" --task <id>' },
                ]
              : [{ skill: 'dev-flow', text: `启动任务流转：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case ${result.caseType} --slug <slug>` }]
        printNextStep(steps, { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'init') {
      if (!opts.kind || !opts.slug || !opts.title) throw new Error('init 需要 --kind <prd|spec|todo|pair|all>、--slug <slug> 与 --title <title>')
      const res = await initDoc({
        repoRoot, mainRoot, gitDir: roots.gitDir, isGit: roots.isGit,
        kind: opts.kind, slug: opts.slug, title: opts.title, taskId: opts.task,
        issue: opts.issue, owner: opts.owner, branch: opts.branch, relatedSpec: opts.spec,
        relatedPrd: opts.prd, force: Boolean(opts.force), noPrune: Boolean(opts['no-prune']),
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`已生成 ${res.kind.toUpperCase()}：${res.files.join(', ')}（Planned at: ${res.plannedAt}）\n`)
        printNextStep([{ skill: 'dev-plan', text: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${res.file}"` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'clarify') {
      if (!opts.file || !opts.decision) throw new Error('clarify 需要 --file <docPath> 与 --decision "<已确认结论>"')
      const res = clarifyDoc({
        repoRoot, file: opts.file, question: opts.question ?? '',
        decision: opts.decision, by: opts.by ?? 'user', criterion: opts.criterion ?? '',
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`已写入澄清记录到 ${res.file}：${res.entry}${res.addedCriterion ? `（新增 ${res.addedCriterion.id}）` : ''}\n`)
      return 0
    }

    if (sub === 'link') {
      const target = opts._[0] ?? opts.file ?? opts.slug
      if (!target) throw new Error('link 需要传入 <slug-or-path>（如 261115-my-feature 或 docs/specs/...）')
      const prVal = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : undefined
      const res = await syncDocsLifecycle(repoRoot, {
        slugOrPath: target, issue: opts.issue !== undefined ? parseIssueArg(opts.issue) : undefined, pr: prVal,
        branch: opts.branch, owner: opts.owner, status: opts.status,
        approved: opts.approve ? true : undefined, implemented: opts.implemented ? true : undefined, doneAt: opts['done-at'],
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`文档生命周期同步完成（issue=${res.issue ?? '无'}，重命名 ${res.renamed.length} 个，更新 ${res.updated.length} 个）\n`)
      return 0
    }

    if (sub === 'audit') {
      const target = opts.file ?? opts._[0] ?? '.'
      const targetAbs = resolve(repoRoot, target)
      const isDirScope = target === '.' || (existsSync(targetAbs) && statSync(targetAbs).isDirectory())
      if (isDirScope) {
        const batch = auditRepoDocs(repoRoot, target)
        if (cli.json) process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`)
        else {
          process.stdout.write(`仓库工程文档审计（${batch.scope}，共 ${batch.auditedCount} 份）：${batch.ok ? '全部通过' : `${batch.failedCount} 份失败`}\n`)
          for (const r of batch.results) {
            process.stdout.write(`- ${r.file} (${r.docType}): ${r.ok ? '通过' : `失败 (${r.errors.length})`}\n`)
            for (const e of r.errors) process.stdout.write(`  * [${e.code}] L${e.line}: ${e.message}\n    修法: ${e.fixHint}\n`)
          }
          for (const e of batch.coverageErrors ?? []) {
            process.stdout.write(`- ${e.file}：${e.message}\n`)
          }
        }
        return batch.ok ? 0 : 1
      }
      const res = auditDoc({ repoRoot, file: target })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`文档审计（${res.file}，type=${res.docType}）：${res.ok ? '通过' : `失败（${res.errors.length} 项错误）`}\n`)
        for (const e of res.errors) process.stdout.write(`- [${e.code}] L${e.line}: ${e.message}\n  修法: ${e.fixHint}\n`)
        if (res.ok) {
          const docText = readTextSafe(resolve(repoRoot, res.file)) ?? ''
          const fm = parseDocFrontmatter(docText)
          const fn = parseDocFilename(res.file)
          const slugVal = fn?.slug ?? 'task'
          const statusLow = String(fm.data?.status ?? '').toLowerCase()
          const fileRefs = [...new Set(docText.match(/`[^`\n]+\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+`/g) ?? [])]
          const isNonTrivialTodo = Boolean(fm.data?.related_spec) || fileRefs.length >= 3 || /^- \[[ xX]\] C3\b/m.test(docText)
          if (res.docType === 'prd' && !['active', 'done', 'dropped'].includes(statusLow)) {
            printNextStep([{ skill: 'dev-plan', text: `PRD 须经独立只读 Plan Critique 后执行：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
          } else if (res.docType === 'tdd') {
            printNextStep([{ skill: 'dev-plan', text: `TDD 架构基线须经独立架构 Critique 确认与 AGENTS.md 模块边界、arch-rules 对齐：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
          } else if (res.docType === 'todo' && !fm.data?.related_spec && !isNonTrivialTodo) {
            printNextStep([{ skill: 'dev-flow', text: `Todo 自审通过，移交 dev-flow 启动隔离实施：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case 3 --todo "${res.file}"` }], { repoRoot: mainRoot })
          } else if (res.docType === 'todo') {
            printNextStep([
              { skill: 'dev-plan', text: `非平凡 Todo（多文件/关联 SPEC）建议先独立 Plan Critique：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` },
              { skill: 'dev-flow', text: `Todo 启动隔离实施：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case 3 --todo "${res.file}"` },
            ], { repoRoot: mainRoot })
          } else if (res.docType === 'spec' && statusLow !== 'approved') {
            printNextStep([{ skill: 'dev-plan', text: `独立只读 Critique 通过后执行：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
          }
        }
      }
      return res.ok ? 0 : 1
    }

    if (sub === 'critique-scope') {
      // 这一轮该看什么：把上轮意见与正文指纹摆出来。
      //
      // 代码审查早有增量视野硬锁，规划审核此前没有：Round 2 要么重读全文（吃光上下文），
      // 要么只看改动（新问题一条看不到）。两头都不对，根子是没有东西告诉它这一轮的范围。
      if (!opts.file) throw new Error('critique-scope 需要 --file <docPath>')
      const scopeAbs = resolve(repoRoot, opts.file)
      if (!existsSync(scopeAbs)) throw new Error(`找不到文档：${opts.file}`)
      const scopeText = readTextSafe(scopeAbs) ?? ''
      const scopeFm = parseDocFrontmatter(scopeText)
      const curSha = sha256Text(stripCritiqueMeta(scopeText)).slice(0, 12)
      const prevSha = /\bsha=([a-f0-9]{8,64})\b/i.exec(String(scopeFm.data?.plan_critique ?? ''))?.[1] ?? null
      const scope = buildCritiqueScope({
        round: Number(opts.round ?? ((Number(/\bround=(\d+)\b/.exec(String(scopeFm.data?.plan_critique ?? ''))?.[1] ?? 0) + 1))),
        currentSha: curSha,
        previousSha: prevSha,
        findingsRaw: scopeFm.data?.[CRITIQUE_FINDINGS_KEY] ?? '',
        reviewer: opts.reviewer ?? '(未指定)',
      })
      // 审核慢的根因是分工错了：一百多条「文件在不在、名字有没有、命令跑不跑得通」
      // 是不需要判断的，却让审核人每次拿手工去核。这里先跑一遍，他只看剩下的判断题。
      const facts = await verifyDocClaims(repoRoot, scopeText)
      const factsText = renderVerificationForReviewer(facts)

      if (cli.json) {
        process.stdout.write(`${JSON.stringify({
          file: opts.file, currentSha: curSha, previousSha: prevSha, ...scope, facts, factsText,
        }, null, 2)}\n`)
      } else {
        // 先给已核事实，再给这一轮该看什么——顺序本身就是在说「这些不用你核了」。
        process.stdout.write(`${factsText}\n${scope.prompt}`)
      }
      return 0
    }

    if (sub === 'critique-pass') {
      if (!opts.file || !opts.reviewer) throw new Error('critique-pass 需要 --file <docPath> 与 --reviewer <reviewerId>')
      const findingArg = opts.findings ?? opts.finding ?? []
      const findingList = Array.isArray(findingArg) ? findingArg : [findingArg]
      const res = critiquePassDoc({ repoRoot, file: opts.file, reviewer: opts.reviewer, round: opts.round ?? 1, summary: opts.summary ?? '', findings: findingList })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`Critique 通过记录已写入 ${res.file}（reviewer=${res.reviewer}, round=${res.round}, sha=${res.sha}）\n`)
        printNextStep([{ skill: 'dev-plan', text: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${res.file}"` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'approve') {
      if (!opts.file) throw new Error('approve 需要 --file <specPath>')
      const res = approveSpec({ repoRoot, file: opts.file, skipCritiqueReason: opts['skip-critique-reason'] })
      const fm = parseDocFrontmatter(readTextSafe(resolve(repoRoot, res.file)) ?? '')

      // 有绑定任务就把冻结指纹写进账本：最终的「标准有没有被悄悄改过」
      // 要在 finalize / verify 那一刻对得上，所以指纹必须进账本，不能只留在文档里。
      const taskKey = opts.task ?? fm.data?.task_id
      if (taskKey && res.criteriaFingerprint) {
        const led = readTaskLedger(mainRoot, sanitizeTaskId(taskKey))
        if (led) {
          led.criteriaFingerprint = res.criteriaFingerprint
          led.criteriaFrozenFrom = res.file
          led.criteriaFrozenAt = docIsoDate()
          writeTaskLedger(mainRoot, led)
        }
      }
      const fn = parseDocFilename(res.file)
      const slugVal = fn?.slug ?? 'task'
      const issueNum = Number.isInteger(Number(fm.data?.issue)) && Number(fm.data.issue) > 0 ? Number(fm.data.issue) : (fn?.issue ?? null)
      const startHint = `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case ${fm.data?.kind === 'todo' ? 3 : 4}${issueNum ? ` --issue ${issueNum}` : ' [--issue <N> | --create-issue --title "<标题>"]'}`
      if (res.status === 'approved' || res.status === 'active') res.nextStep = startHint
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`文档已切换为 ${res.status}：${res.file}（原状态：${res.previousStatus}）\n`)
        if (res.warning) process.stdout.write(`提示：${res.warning}\n`)
        if (res.nextStep) printNextStep([{ skill: 'dev-flow', text: `规划已批准，移交 dev-flow 启动隔离工作区：${startHint}` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'archive') {
      let targetSlugOrPath = opts._[0] ?? opts.file ?? opts.slug
      let taskLedger = null
      if (!targetSlugOrPath && (opts.task || existsSync(join(mainRoot, '.worktrees', '.state', 'tasks')))) {
        const ctx = await resolveTaskContext(roots, opts, { requireExisting: Boolean(opts.task) })
        taskLedger = ctx.ledger
        targetSlugOrPath = taskLedger?.specFile ?? taskLedger?.todoFile ?? taskLedger?.prdFile ?? taskLedger?.slug
      }
      if (!targetSlugOrPath) throw new Error('archive 需要传入 <slug-or-path> 或 --task <id>')
      const archiveRoot = (taskLedger?.worktreePath && existsSync(join(mainRoot, taskLedger.worktreePath)))
        ? join(mainRoot, taskLedger.worktreePath)
        : repoRoot
      const res = await archiveCompletedDocsGroup(archiveRoot, {
        prdFile: taskLedger?.prdFile, specFile: taskLedger?.specFile, todoFile: taskLedger?.todoFile,
        slugOrPath: targetSlugOrPath, issue: taskLedger?.linkedIssues?.[0], pr: taskLedger?.prNumber,
        branch: taskLedger?.branch, owner: taskLedger?.implementerId, doneAt: opts['done-at'],
        includeMasterPrd: Boolean(opts['include-master-prd']),
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`成对归档完成（移动 ${res.moved.length} 份，更新互链 ${res.updated.length} 份）：${res.archived.join(', ')}\n`)
      return 0
    }

    if (sub === 'supersede') {
      const oldSpec = opts._[0] ?? opts.file
      const newSpec = opts.by
      const res = supersedeSpec({ repoRoot, oldSpecPath: oldSpec, newSpecPath: newSpec })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`已标记取代关系：${res.oldSpec} -> superseded（by ${res.newSpec}）\n`)
      return 0
    }

    if (sub === 'list') {
      const data = listDocs(repoRoot)
      if (cli.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      else {
        process.stdout.write('# 工程文档全景（实时扫描）\n')
        process.stdout.write(`- docs/TDD.md: ${data.tdd ? data.tdd.title : '缺失'}\n`)
        for (const [label, items] of [['PRD', data.prds], ['SPEC', data.specs], ['Todo', data.todos], ['Archive', data.archived]]) {
          process.stdout.write(`\n## ${label} (${items.length})\n`)
          for (const it of items) process.stdout.write(`- ${it.file}: ${it.title}${it.status ? ` status=${it.status}` : ''}\n`)
        }
      }
      return 0
    }

    throw new Error(`未知子命令：${sub}`)
  } catch (err) {
    if (cli.json && err?.audit) process.stdout.write(`${JSON.stringify({ ok: false, error: err.message, audit: err.audit }, null, 2)}\n`)
    process.stderr.write(`doc-plan 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`doc-plan 错误：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
