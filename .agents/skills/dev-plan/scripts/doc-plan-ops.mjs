/**
 * doc-plan-ops.mjs —— `doc-plan.mjs` 文档澄清记录（clarify）与规范取代（supersede）辅助操作。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），拆分自 doc-plan.mjs 以控制入口文件行数。
 */

import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

import { criteriaFingerprint, extractCriteria } from '../../lib/criteria-lock.mjs'
import { parseCritiqueOverride, parseCritiqueRounds } from '../../lib/critique-rounds.mjs'
import { DOC_FRONTMATTER_KEY_ORDER, docIsoDate, parseDocFrontmatter, stripCritiqueMeta, updateDocFrontmatter } from '../../lib/docs.mjs'
import { posixPath, readTextSafe, sha256Text, writeAtomic } from '../../lib/git.mjs'
import { auditDoc, detectDocType } from './doc-audit.mjs'

/** 校验 Critique/Audit/停损条件后批准 SPEC/PRD/Todo 并冻结 C1..Cn 验收指纹。 */
export function approveSpec({ repoRoot, file, skipCritiqueReason }) {
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
    const priorRounds = parseCritiqueRounds(fm.data, workingText)
    const override = parseCritiqueOverride(fm.data)
    const hasStopLoss = priorRounds.some((r) => Boolean(r.stopLossTriggered))
    const currentSha = sha256Text(stripCritiqueMeta(workingText)).slice(0, 12)
    if (hasStopLoss && !override?.approved) {
      throw Object.assign(new Error(`STOP_LOSS_ESCALATE: ${audit.file} 已触发规划 Critique 停损且尚未解锁；请先运行 doc-plan.mjs critique-override --file "${audit.file}" --human-approved --reason "..."`), { code: 'STOP_LOSS_ESCALATE', exitCode: 4 })
    }
    if (override?.approved) {
      if (override.sha && currentSha !== override.sha) {
        throw Object.assign(new Error(`BLOCKED_CRITIQUE_STALE: ${audit.file} 在人类 critique-override 后正文已被修改（override=${override.sha} !== current=${currentSha}），请重新复核或重签 override`), { code: 'BLOCKED_CRITIQUE_STALE', exitCode: 2 })
      }
    } else {
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
          throw Object.assign(new Error(`BLOCKED_CRITIQUE_REQUIRED: ${audit.file} 为 ${docType.toUpperCase()} 文档，必须先通过独立 Critique 并运行 critique-pass，或传入 --skip-critique-reason "<原因>"`), { code: 'BLOCKED_CRITIQUE_REQUIRED', exitCode: 2 })
        }
      } else {
        const shaMatch = /\bsha=([a-f0-9]{8,64})\b/i.exec(critiqueVal)
        if (shaMatch && currentSha.slice(0, shaMatch[1].length) !== shaMatch[1].toLowerCase() && !skipCritiqueReason) {
          throw Object.assign(new Error(`BLOCKED_CRITIQUE_STALE: ${audit.file} 在 critique-pass 之后正文已被修改（recorded=${shaMatch[1]} !== current=${currentSha.slice(0, shaMatch[1].length)}），请重新复核并执行 critique-pass`), { code: 'BLOCKED_CRITIQUE_STALE', exitCode: 2 })
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
export function clarifyDoc({ repoRoot, file, question = '', decision, by = 'user', criterion = '' }) {
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
