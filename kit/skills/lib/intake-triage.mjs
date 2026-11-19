/**
 * intake-triage.mjs —— 全局 5 维业务分诊规则引擎、内部已批规划豁免与本地分诊记录持久化。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零远端写副作用；
 * 写路径编排由 `dev-flow/scripts/flow-intake.mjs` 统一经 `probeForWrite` 驱动。
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { buildIntakeDecisionComments } from './doc-comments.mjs'
import { parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { posixPath, readJsonSafe, readTextSafe, withFileLock, writeJsonAtomic } from './git.mjs'
import { parseBodyRelations, parsePfStateTags } from './github-parse.mjs'
import { listTaskLedgers, sanitizeTaskId } from './ledger.mjs'
import { listLocalIssues, resolveEffectiveCommonGitDir } from './local-issues.mjs'
import { parseDevProfile } from './profile.mjs'

export const INTAKE_DECISIONS = Object.freeze(['accept', 'reject', 'merge-duplicate', 'needs-info', 'defer'])
export const INTAKE_BLOCKING_DECISIONS = Object.freeze(['reject', 'merge-duplicate'])
export const INTAKE_REJECT_LABELS = Object.freeze(['out-of-scope', 'wontfix', 'duplicate'])
export const INTAKE_DECISION_TO_LABELS = Object.freeze({
  accept: Object.freeze([]),
  reject: Object.freeze(['wontfix', 'out-of-scope']),
  'merge-duplicate': Object.freeze(['duplicate']),
  'needs-info': Object.freeze(['needs-info']),
  defer: Object.freeze(['deferred']),
})

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'when', 'have', 'will', 'should',
  'feat', 'fix', 'docs', 'chore', 'refactor', 'test', 'add', 'update', 'support', 'issue', 'pull',
  '新增', '支持', '优化', '修复', '更新', '调整', '增加', '实现', '功能', '问题',
])

const GENERIC_VAGUE_TITLES = new Set([
  'bug', 'fix', 'help', 'issue', 'update', 'test', 'wip', 'todo', 'feature', 'question', 'misc',
  '问题', '优化', '修复', '改一下', '帮忙', '看看', '测试', '建议', '需求',
])

/** 解析本地分诊持久化目录：`<effectiveGitDir>/project-forge-flow/intake`。 */
export function resolveIntakeDir(repoRoot = process.cwd(), gitDir = null) {
  const common = resolveEffectiveCommonGitDir(repoRoot, gitDir)
  if (common) return join(common, 'project-forge-flow', 'intake')
  return join(repoRoot || process.cwd(), '.worktrees', '.state', 'intake')
}

function intakeRecordPath(repoRoot, targetType, targetNumber, gitDir = null) {
  const kind = String(targetType ?? 'issue').toLowerCase() === 'pr' ? 'pr' : 'issue'
  const num = Number(targetNumber)
  const key = Number.isInteger(num) && num > 0
    ? `${kind}-${num}`
    : `${kind}-${sanitizeTaskId(String(targetNumber || 'ad-hoc'))}`
  const dir = resolveIntakeDir(repoRoot, gitDir)
  return { dir, filePath: join(dir, `${key}.json`), lockPath: join(dir, 'intake.lock') }
}

/** 读取目标 Issue/PR 的持久化分诊记录；不存在时返回 null。 */
export function readIntakeRecord(repoRoot, targetType, targetNumber, { gitDir = null } = {}) {
  if (!repoRoot || targetNumber === undefined || targetNumber === null || targetNumber === '') return null
  const { filePath } = intakeRecordPath(repoRoot, targetType, targetNumber, gitDir)
  const data = readJsonSafe(filePath)
  return data && typeof data === 'object' ? data : null
}

/** 原子持久化分诊记录至 `<effectiveGitDir>/project-forge-flow/intake/`。 */
export async function writeIntakeRecord(repoRoot, record, { gitDir = null } = {}) {
  if (!repoRoot || !record || typeof record !== 'object') {
    return { ok: false, error: 'missing-repo-or-record' }
  }
  const targetType = String(record.targetType ?? 'issue').toLowerCase() === 'pr' ? 'pr' : 'issue'
  const targetNumber = record.targetNumber ?? record.number ?? record.id ?? 'ad-hoc'
  const { dir, filePath, lockPath } = intakeRecordPath(repoRoot, targetType, targetNumber, gitDir)
  const now = new Date().toISOString()
  const payload = {
    version: 1,
    ...record,
    targetType,
    targetNumber: Number.isInteger(Number(targetNumber)) && Number(targetNumber) > 0 ? Number(targetNumber) : targetNumber,
    updatedAt: now,
    recordedAt: record.recordedAt ?? now,
  }
  await withFileLock(lockPath, () => {
    mkdirSync(dir, { recursive: true })
    writeJsonAtomic(filePath, payload)
  })
  return { ok: true, path: posixPath(filePath), record: payload }
}

/** 检查分诊记录 / 本地 PR / 远端标签 / 评论 `pf-state` 是否命中拒绝阻断信号。 */
export function hasIntakeBlockingSignal({ record = null, localPr = null, labels = [], comments = [] } = {}) {
  const sources = []
  let decision = null
  const matchedLabels = []
  let reason = ''

  if (record && INTAKE_BLOCKING_DECISIONS.includes(String(record.decision ?? '').toLowerCase())) {
    decision = String(record.decision).toLowerCase()
    reason = String(record.reason ?? record.summary ?? '').trim()
    sources.push({ kind: 'local-intake-record', decision, recordedAt: record.updatedAt ?? record.recordedAt ?? null })
  }

  if (localPr?.triage && INTAKE_BLOCKING_DECISIONS.includes(String(localPr.triage.decision ?? '').toLowerCase())) {
    const d = String(localPr.triage.decision).toLowerCase()
    decision = decision ?? d
    reason = reason || String(localPr.triage.reason ?? '').trim()
    sources.push({ kind: 'local-pr-triage', decision: d })
  }

  const allLabels = [
    ...(Array.isArray(labels) ? labels : []),
    ...(Array.isArray(localPr?.labels) ? localPr.labels : []),
    ...(Array.isArray(record?.labels) ? record.labels : []),
  ].map((l) => String(typeof l === 'string' ? l : l?.name ?? '').trim()).filter(Boolean)

  for (const lbl of allLabels) {
    const low = lbl.toLowerCase()
    if (INTAKE_REJECT_LABELS.includes(low) && !matchedLabels.includes(low)) {
      matchedLabels.push(low)
    }
  }
  if (matchedLabels.length > 0) {
    decision = decision ?? (matchedLabels.includes('duplicate') && !matchedLabels.includes('out-of-scope') && !matchedLabels.includes('wontfix') ? 'merge-duplicate' : 'reject')
    sources.push({ kind: 'pr-labels', labels: matchedLabels })
  }

  const commentList = Array.isArray(comments) ? comments : []
  for (let i = commentList.length - 1; i >= 0; i -= 1) {
    const c = commentList[i]
    const states = Array.isArray(c?.pfStates) && c.pfStates.length > 0 ? c.pfStates : parsePfStateTags(c?.body ?? '')
    for (let j = states.length - 1; j >= 0; j -= 1) {
      const st = states[j]
      if (st?.kind === 'intake' && INTAKE_BLOCKING_DECISIONS.includes(String(st.decision ?? '').toLowerCase())) {
        const d = String(st.decision).toLowerCase()
        decision = decision ?? d
        sources.push({ kind: 'pf-state-comment', decision: d, commentId: c?.id ?? null })
        break
      }
    }
    if (sources.some((s) => s.kind === 'pf-state-comment')) break
  }

  return {
    blocked: sources.length > 0,
    decision,
    labels: matchedLabels,
    reason,
    sources,
  }
}

function isApprovedFrontmatter(fmData) {
  if (!fmData || typeof fmData !== 'object') return false
  return fmData.approved === true || String(fmData.approved ?? '').trim().toLowerCase() === 'true'
}

/** 检查目标 Issue/PR/分支/任务是否命中本仓已通过 `dev-plan` 审批流核准（`approved: true`）的自研规划文档。 */
export function isApprovedInternalPlan(repoRoot, input = {}) {
  if (!repoRoot) return { exempt: false, reason: null, matchedDoc: null, matchedTaskId: null }
  const targetType = String(input.targetType ?? 'issue').toLowerCase() === 'pr' ? 'pr' : 'issue'
  const num = Number(input.targetNumber ?? input.number)
  const validNum = Number.isInteger(num) && num > 0 ? num : null
  const branch = String(input.branch ?? '').trim()
  const taskId = String(input.taskId ?? '').trim()
  const rels = parseBodyRelations(input.body ?? '')
  const linkedIssueSet = new Set([
    ...(targetType === 'issue' && validNum ? [validNum] : []),
    ...rels.fixes,
    ...rels.refs,
    ...rels.partOf,
  ])

  const ledgers = listTaskLedgers(repoRoot, { includeTerminal: true })
  const matchedLedger = ledgers.find((l) => (
    (taskId && l.taskId === taskId)
    || (branch && l.branch && l.branch === branch)
    || (targetType === 'pr' && validNum && Number(l.prNumber) === validNum)
    || (targetType === 'issue' && validNum && Array.isArray(l.linkedIssues) && l.linkedIssues.includes(validNum))
  )) ?? null
  if (matchedLedger?.linkedIssues) {
    for (const iss of matchedLedger.linkedIssues) linkedIssueSet.add(Number(iss))
  }

  const candidateDocs = []
  for (const dirRel of ['docs/specs', 'docs/todo']) {
    const abs = join(repoRoot, dirRel)
    if (!existsSync(abs)) continue
    let entries = []
    try { entries = readdirSync(abs).filter((n) => n.endsWith('.md')).sort() } catch { entries = [] }
    for (const name of entries) {
      candidateDocs.push(`${dirRel}/${name}`)
    }
  }

  for (const rel of candidateDocs) {
    const raw = readTextSafe(join(repoRoot, rel))
    if (!raw) continue
    const fm = parseDocFrontmatter(raw)
    if (!isApprovedFrontmatter(fm.data)) continue
    const fn = parseDocFilename(rel)
    const docIssue = Number(fm.data?.issue ?? fn?.issue)
    const docPr = Number(fm.data?.pr)
    const docBranch = String(fm.data?.branch ?? '').trim()
    const docTaskId = String(fm.data?.task_id ?? '').trim()

    const byPr = targetType === 'pr' && validNum && Number.isInteger(docPr) && docPr === validNum
    const byIssue = Number.isInteger(docIssue) && docIssue > 0 && linkedIssueSet.has(docIssue)
    const byBranch = Boolean(branch && docBranch && docBranch === branch)
    const byTask = Boolean((taskId && docTaskId && docTaskId === taskId) || (matchedLedger && (matchedLedger.specFile === rel || matchedLedger.todoFile === rel)))

    if (byPr || byIssue || byBranch || byTask) {
      const via = byPr ? `PR #${validNum}` : byIssue ? `Issue #${docIssue}` : byBranch ? `分支 ${branch}` : `任务 ${matchedLedger?.taskId ?? docTaskId}`
      return {
        exempt: true,
        reason: `命中已核准内部规划文档 ${rel}（approved: true，匹配依据：${via}），自动豁免重复业务分诊阻断。`,
        matchedDoc: rel,
        matchedTaskId: matchedLedger?.taskId ?? (docTaskId || null),
      }
    }
  }

  return { exempt: false, reason: null, matchedDoc: null, matchedTaskId: null }
}

function tokenizeForSimilarity(text) {
  const cleaned = String(text ?? '').toLowerCase().replace(/[`*_#[\]()>.,:;!?/\\|"'~-]+/g, ' ').trim()
  const tokens = new Set()
  for (const m of cleaned.matchAll(/[a-z0-9]{2,}/g)) {
    if (!STOP_WORDS.has(m[0])) tokens.add(m[0])
  }
  for (const m of cleaned.matchAll(/[\u4e00-\u9fa5]{2,}/g)) {
    const seg = m[0]
    if (seg.length <= 4 && !STOP_WORDS.has(seg)) tokens.add(seg)
    for (let i = 0; i < seg.length - 1; i += 1) {
      const bi = seg.slice(i, i + 2)
      if (!STOP_WORDS.has(bi)) tokens.add(bi)
    }
  }
  return tokens
}

function similarityScore(textA, textB) {
  const normA = String(textA ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  const normB = String(textB ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
  if (!normA || !normB) return 0
  if (normA === normB) return 1
  if (normA.length >= 6 && normB.length >= 6 && (normA.includes(normB) || normB.includes(normA))) {
    return Math.max(0.72, Math.min(normA.length, normB.length) / Math.max(normA.length, normB.length))
  }
  const setA = tokenizeForSimilarity(normA)
  const setB = tokenizeForSimilarity(normB)
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const t of setA) if (setB.has(t)) inter += 1
  if (inter === 0) return 0
  const jaccard = inter / (setA.size + setB.size - inter)
  const overlap = inter / Math.min(setA.size, setB.size)
  return Math.max(jaccard, overlap * 0.8)
}

function extractMarkdownSection(text, headingRe) {
  if (!text) return ''
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let capturing = false
  let level = 0
  const out = []
  for (const line of lines) {
    const hm = /^(#{1,6})\s+(.+)$/.exec(line)
    if (hm) {
      const curLevel = hm[1].length
      if (capturing && curLevel <= level) break
      if (!capturing && headingRe.test(hm[2])) {
        capturing = true
        level = curLevel
        out.push(line)
        continue
      }
    }
    if (capturing) out.push(line)
  }
  return out.join('\n').trim()
}

function evaluateNonGoalsAndRedlines(repoRoot, combinedText, featureRef) {
  const tddText = readTextSafe(join(repoRoot, 'docs', 'TDD.md')) ?? ''
  const skillText = readTextSafe(join(repoRoot, 'SKILL.md')) ?? ''
  const agentsText = readTextSafe(join(repoRoot, 'AGENTS.md')) ?? ''
  const repoDocs = `${tddText}\n${skillText}\n${agentsText}`
  const tddRefs = []
  const hits = []

  if (featureRef) {
    const escaped = String(featureRef).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(escaped, 'i')
    if (tddText && re.test(tddText)) tddRefs.push(`docs/TDD.md#${featureRef}`)
    if (skillText && re.test(skillText)) tddRefs.push(`SKILL.md#${featureRef}`)
  }

  const nonGoalsBlock = extractMarkdownSection(tddText, /非目标|Non-Goals?|不做/i)
  const redlineBlock = `${extractMarkdownSection(agentsText, /红线|关键不变量/i)}\n${extractMarkdownSection(tddText, /关键不变量|核心不变量|技术基线/i)}`

  const hasZeroDepRule = /零第三方依赖|zero\s+(?:third-party\s+)?dependenc/i.test(repoDocs)
  if (hasZeroDepRule && /\b(?:lodash|axios|express|chalk|commander|yargs|zod|moment|dayjs|rxjs|underscore|webpack|esbuild|npm\s+install\s+\S+|yarn\s+add\s+\S+|pnpm\s+add\s+\S+)\b|引入(?:第三方|外部)(?:依赖|包|库)|添加\s*npm\s*依赖/i.test(combinedText)) {
    hits.push('违反「零第三方依赖」红线（提案要求引入外部依赖包）')
    tddRefs.push('docs/TDD.md#技术基线与运行约束')
  }

  const hasNoHostRule = /不绑定(?:特定|具体)\s*AI\s*宿主|宿主.*边界/i.test(repoDocs)
  if (hasNoHostRule && /(?:硬编码|绑定)(?:特定|具体|私有)\s*(?:AI\s*)?(?:宿主|IDE|客户端)|(?:host|vendor|ide)-specific\s+(?:env|path|config|binding)|私有环境变量|私有宿主路径/i.test(combinedText)) {
    hits.push('违反「不绑定特定 AI 宿主」红线（提案包含特定宿主私有名称/路径/环境变量）')
    tddRefs.push('docs/TDD.md#明确非目标')
  }

  const hasNoEmojiRule = /禁\s*emoji|禁止.*emoji/i.test(repoDocs)
  const proposesEmoji = /(?:添加|加上|加入|输出|引入|使用|add|enable|support)\s*emoji|表情图标|[\u{1F300}-\u{1FAFF}]/u.test(combinedText)
  if (hasNoEmojiRule && proposesEmoji) {
    hits.push('违反「禁 emoji」项目红线')
    tddRefs.push('AGENTS.md#项目特有红线')
  }

  const hasNoBizGenRule = /不生成业务|不执行服务器运维部署|云资源开通/i.test(`${nonGoalsBlock}\n${agentsText}\n${skillText}`)
  if (hasNoBizGenRule && /(?:生成|脚手架|scaffold|generate)\s*(?:React|Vue|Next\.?js|Angular|Django|Spring|Express|业务(?:应用|代码|CRUD))|(?:terraform|kubernetes|k8s|helm|aws\s+cdk|云服务器|一键部署|运维部署|云资源开通)/i.test(combinedText)) {
    hits.push('命中「明确非目标（Non-Goals）」：本项目只做工程治理，不生成业务应用代码或执行服务器运维/云资源部署')
    tddRefs.push('docs/TDD.md#明确非目标')
  }

  if (hits.length === 0 && nonGoalsBlock) {
    const bullets = nonGoalsBlock.split('\n').filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
    const lowCombined = combinedText.toLowerCase()
    for (const bullet of bullets) {
      if (/^定位\s*[:：]/.test(bullet)) continue
      const cleanBullet = bullet
        .replace(/^(?:非目标|不做|Non-Goals?)\s*[:：]\s*/i, '')
        .replace(/^(?:绝?不(?:生成|执行|绑定|提供|支持|开发|包含|替|为)|do\s+not\s+(?:build|generate|support|include))\s*/i, '')
        .replace(/[。.;；]+$/, '')
        .trim()
      const clauses = cleanBullet.split(/[、；;]|(?:\s+or\s+)|或/).map((s) => s.trim()).filter((s) => s.length >= 5)
      const matchedClause = clauses.find((cl) => lowCombined.includes(cl.toLowerCase()) || similarityScore(combinedText, cl) >= 0.58)
      if (matchedClause || (cleanBullet.length >= 6 && similarityScore(combinedText, cleanBullet) >= 0.58)) {
        hits.push(`与文档明确非目标条目高度重叠：「${bullet.slice(0, 60)}」`)
        tddRefs.push('docs/TDD.md#明确非目标')
        break
      }
    }
  }

  const uniqRefs = [...new Set(tddRefs)]
  return {
    dimension: {
      id: 'non-goals-redlines',
      name: '非目标与红线对照',
      status: hits.length > 0 ? 'fail' : 'ok',
      detail: hits.length > 0 ? hits.join('；') : (nonGoalsBlock || redlineBlock ? '未命中明确 Non-Goal 或项目红线' : '未发现冲突的 Non-Goal 声明'),
    },
    tddRefs: uniqRefs,
    hits,
  }
}

function evaluateDuplicateCheck(repoRoot, { title, body, gitDir, closedIssues = [], duplicateOf = null }) {
  const candidates = []
  for (const kind of ['prd', 'specs', 'todo']) {
    const dirRel = `docs/archive/${kind}`
    const abs = join(repoRoot, dirRel)
    if (!existsSync(abs)) continue
    let files = []
    try { files = readdirSync(abs).filter((f) => f.endsWith('.md')).sort() } catch { files = [] }
    for (const f of files) {
      const rel = `${dirRel}/${f}`
      const raw = readTextSafe(join(abs, f)) ?? ''
      const fm = parseDocFrontmatter(raw)
      const h1 = /^#\s+(.+)$/m.exec(raw)?.[1]?.trim() ?? ''
      const docTitle = String(fm.data?.title ?? h1 ?? f.replace(/\.md$/, '')).trim()
      const firstPara = raw.replace(/^---[\s\S]*?---\s*/, '').split(/\n\s*\n/).slice(0, 2).join(' ').slice(0, 300)
      candidates.push({ ref: rel, path: rel, title: docTitle, summary: firstPara, status: String(fm.data?.status ?? 'archived') })
    }
  }

  const localClosed = listLocalIssues({ mainRoot: repoRoot, gitDir, state: 'closed' })
  if (localClosed.ok) {
    for (const iss of localClosed.issues) {
      candidates.push({
        ref: `#${iss.number}`,
        path: `local-issue://${iss.number}`,
        title: String(iss.title ?? ''),
        summary: String(iss.body ?? '').slice(0, 300),
        status: 'closed',
      })
    }
  }

  for (const iss of Array.isArray(closedIssues) ? closedIssues : []) {
    if (!iss) continue
    candidates.push({
      ref: iss.number ? `#${iss.number}` : String(iss.ref ?? iss.title ?? 'closed'),
      path: iss.url ?? null,
      title: String(iss.title ?? ''),
      summary: String(iss.body ?? iss.summary ?? '').slice(0, 300),
      status: String(iss.state ?? 'closed').toLowerCase(),
    })
  }

  const queryTitle = String(title ?? '').trim()
  const queryAll = `${queryTitle}\n${String(body ?? '').slice(0, 500)}`.trim()
  const matches = []
  for (const c of candidates) {
    const titleScore = similarityScore(queryTitle, c.title)
    const fullScore = similarityScore(queryAll, `${c.title}\n${c.summary}`)
    const score = Number(Math.max(titleScore, fullScore * 0.92).toFixed(2))
    if (score >= 0.35) {
      matches.push({ ref: c.ref, path: c.path, title: c.title, status: c.status, score })
    }
  }
  matches.sort((a, b) => b.score - a.score)

  const normDupOf = duplicateOf ? String(duplicateOf).replace(/^#/, '').trim() : null
  if (normDupOf) {
    const refStr = /^\d+$/.test(normDupOf) ? `#${normDupOf}` : normDupOf
    if (!matches.some((m) => m.ref === refStr)) {
      matches.unshift({ ref: refStr, path: null, title: `指定重复目标 ${refStr}`, status: 'explicit', score: 1 })
    }
  }

  const highHits = matches.filter((m) => m.score >= 0.55).slice(0, 5)
  const warnHits = matches.filter((m) => m.score >= 0.35 && m.score < 0.55).slice(0, 3)
  const status = highHits.length > 0 ? 'fail' : (warnHits.length > 0 ? 'warn' : 'ok')
  const detail = highHits.length > 0
    ? `命中高相似历史条目：${highHits.map((m) => `${m.ref} (${Math.round(m.score * 100)}%)`).join('、')}`
    : warnHits.length > 0
      ? `存在中度相关历史条目（未达自动重复阈值）：${warnHits.map((m) => `${m.ref} (${Math.round(m.score * 100)}%)`).join('、')}`
      : `已检索 ${candidates.length} 条归档与已关闭记录，未发现高相似重复提案`

  return {
    dimension: { id: 'duplicate-check', name: '历史提案查重', status, detail },
    duplicates: highHits.length > 0 ? highHits : warnHits,
    isDuplicate: highHits.length > 0,
  }
}

function collectReferencedFiles(files = [], body = '') {
  const out = new Set()
  for (const f of Array.isArray(files) ? files : []) {
    const clean = posixPath(String(f ?? '').trim()).replace(/^\.\//, '')
    if (clean) out.add(clean)
  }
  for (const m of String(body ?? '').matchAll(/`([A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,8})`/g)) {
    const p = posixPath(m[1]).replace(/^\.\//, '')
    if (p && !p.startsWith('http')) out.add(p)
  }
  return [...out]
}

function evaluateConflictSurface(repoRoot, { files = [], body = '', taskId = null, branch = null, targetNumber = null }) {
  const profile = parseDevProfile(repoRoot)
  const highRiskRules = Array.isArray(profile.highRisk) ? profile.highRisk : []
  const touchedFiles = collectReferencedFiles(files, body)
  const highRiskHits = []
  for (const f of touchedFiles) {
    for (const rule of highRiskRules) {
      const cleanRule = posixPath(String(rule ?? '').trim()).replace(/\/+$/, '')
      if (!cleanRule) continue
      if (f === cleanRule || f.startsWith(`${cleanRule}/`)) {
        highRiskHits.push({ file: f, rule: cleanRule })
        break
      }
    }
  }

  const activeLedgers = listTaskLedgers(repoRoot, { includeTerminal: false })
  const activeConflicts = []
  for (const l of activeLedgers) {
    if (taskId && l.taskId === taskId) continue
    if (branch && l.branch === branch) continue
    if (targetNumber && (Number(l.prNumber) === Number(targetNumber) || (l.linkedIssues ?? []).includes(Number(targetNumber)))) continue
    const locked = Array.isArray(l.writeScope) ? l.writeScope : (Array.isArray(l.files) ? l.files : [])
    const overlap = touchedFiles.filter((f) => locked.some((lf) => f === lf || f.startsWith(`${lf.replace(/\/+$/, '')}/`)))
    if (overlap.length > 0) {
      activeConflicts.push({ taskId: l.taskId, branch: l.branch ?? null, overlap })
    }
  }

  const status = (highRiskHits.length >= 3 || activeConflicts.length > 0) ? 'warn' : 'ok'
  const parts = []
  if (highRiskHits.length > 0) parts.push(`触及 ${highRiskHits.length} 处高风险路径（${highRiskHits.slice(0, 4).map((h) => h.file).join(', ')}）`)
  if (activeConflicts.length > 0) parts.push(`与活跃任务写域重叠：${activeConflicts.map((c) => `${c.taskId}(${c.overlap.join(',')})`).join('；')}`)
  const detail = parts.length > 0 ? parts.join('；') : (touchedFiles.length > 0 ? `涉及 ${touchedFiles.length} 个文件，未命中并行冲突区` : '未声明具体变更文件')

  return {
    dimension: { id: 'conflict-surface', name: '冲突面评估', status, detail },
    touchedFiles,
    highRiskHits,
    activeConflicts,
  }
}

function evaluateDependencyContract(combinedText) {
  const hits = []
  const refs = []
  if (/(?:删除|移除|删掉|drop|remove)\s*(?:AGENTS\.md\s*(?:协作|规则|防呆)|\.pf-manifest\.json|pf-manifest|write-probe-audit)/i.test(combinedText)) {
    hits.push('提案试图移除受管契约或核心账本/门禁协议')
    refs.push('docs/TDD.md#明确非目标')
  }
  if (/(?:降级|下移|downgrade)\s*Node(?:\.js)?\s*(?:14|16|版本下限)|(?:强推|force[\s-]?push)\s*(?:main|master|已推送历史)|绕过(?:门禁|独立审查|preflight)/i.test(combinedText)) {
    hits.push('提案破坏版本下限只上移不动、禁强推或门禁不可绕过契约')
    refs.push('AGENTS.md#版本管理与回滚底线')
  }
  return {
    dimension: {
      id: 'dependency-contract',
      name: '依赖与契约兼容性',
      status: hits.length > 0 ? 'fail' : 'ok',
      detail: hits.length > 0 ? hits.join('；') : '未发现破坏既定 CLI / Manifest / 协作契约的信号',
    },
    tddRefs: refs,
    hits,
  }
}

function evaluateComplexityValue({ title = '', body = '', touchedFiles = [], highRiskHits = [], exempt = false }) {
  const cleanTitle = String(title ?? '').trim()
  const cleanBody = String(body ?? '').trim()
  const titleLow = cleanTitle.toLowerCase()
  const combined = `${cleanTitle}\n${cleanBody}`

  const isVagueTitle = cleanTitle.length < 6 || GENERIC_VAGUE_TITLES.has(titleLow)
  const isSparseBody = cleanBody.length < 25
  if (touchedFiles.length === 0 && isSparseBody && (isVagueTitle || cleanBody.length === 0)) {
    return {
      dimension: {
        id: 'complexity-value',
        name: '复杂度与价值比评估',
        status: 'needs-info',
        detail: '标题/描述信息严重不足且无变更文件范围，缺少问题背景、复现路径或明确验收目标',
      },
      outcome: 'needs-info',
    }
  }

  const isSpeculativeDefer = /(?:rewrite\s+(?:in|with)\s+(?:rust|go|python|java)|重写整个(?:项目|架构|仓库)|nice\s+to\s+have|future\s+roadmap|someday|低优先级排期|暂缓排期)/i.test(combined)
    || (touchedFiles.length >= 25 && highRiskHits.length >= 4 && !exempt)
  if (isSpeculativeDefer) {
    return {
      dimension: {
        id: 'complexity-value',
        name: '复杂度与价值比评估',
        status: 'defer',
        detail: '改动跨度大或属于远期规划/低紧迫度事项，建议先拆小范围或排入后续里程碑',
      },
      outcome: 'defer',
    }
  }

  return {
    dimension: {
      id: 'complexity-value',
      name: '复杂度与价值比评估',
      status: 'ok',
      detail: '信息完整度与复杂度/收益比在可接收范围内',
    },
    outcome: 'ok',
  }
}

function buildRollbackHint({ targetType, targetNumber, decision, labels }) {
  const kind = targetType === 'pr' ? 'PR' : 'Issue'
  const ref = targetNumber != null ? `${kind} #${targetNumber}` : kind
  if (decision === 'reject' || decision === 'merge-duplicate') {
    const lblText = labels.length > 0 ? `并移除标签 ${labels.map((l) => `\`${l}\``).join('/')}` : ''
    const overrideText = targetType === 'pr'
      ? `；若维护者确认需强制进入源码审查，可运行 \`review-pack.mjs --pr ${targetNumber ?? '<M>'} --override-intake\``
      : ''
    return `如需撤回关闭：重新打开 ${ref}${lblText}${overrideText}。`
  }
  if (decision === 'needs-info') {
    return `贡献者补充复现/范围信息后移除 \`needs-info\` 标签并重跑 \`flow.mjs intake\` 即可进入常规流程。`
  }
  if (decision === 'defer') {
    return `排期就绪后移除 \`deferred\` 标签并经 \`dev-plan\` 立项继续推进。`
  }
  return ''
}

function buildDefaultReason(decision, dimensions, exemption) {
  if (exemption?.exempt && decision === 'accept') return exemption.reason
  if (decision === 'reject') {
    const failed = dimensions.filter((d) => d.status === 'fail' && d.id !== 'duplicate-check').map((d) => d.detail)
    return failed.join('；') || '不符合项目边界与工程契约，判定拒绝关闭。'
  }
  if (decision === 'merge-duplicate') {
    const dup = dimensions.find((d) => d.id === 'duplicate-check')
    return dup?.detail || '与已有历史提案或已关闭工单重复。'
  }
  if (decision === 'needs-info') {
    const cv = dimensions.find((d) => d.id === 'complexity-value')
    return cv?.detail || '缺少必要上下文与验收边界，请补充后再评估。'
  }
  if (decision === 'defer') {
    const cv = dimensions.find((d) => d.id === 'complexity-value')
    return cv?.detail || '当前复杂度与排期收益比不适合立即合入，建议暂缓排期。'
  }
  return '五维业务边界、查重与契约核对通过，可进入常规规划/审查流程。'
}

/**
 * 纯函数评估单个 Issue/PR 的 5 维业务分诊结果（支持豁免、显式 `--decision` 与自然人话 `--rationale`）。
 */
export function evaluateIntakeTriage(repoRoot, input = {}) {
  const targetType = String(input.targetType ?? 'issue').toLowerCase() === 'pr' ? 'pr' : 'issue'
  const rawNum = input.targetNumber ?? input.number ?? null
  const numVal = rawNum !== null && rawNum !== undefined && rawNum !== '' ? Number(rawNum) : null
  const targetNumber = Number.isInteger(numVal) && numVal > 0 ? numVal : null
  const title = String(input.title ?? '').trim()
  const body = String(input.body ?? '').trim()
  const featureRef = input.featureRef ? String(input.featureRef).trim() : null
  const duplicateOf = input.duplicateOf ? String(input.duplicateOf).replace(/^#/, '').trim() : null
  const rationale = String(input.rationale ?? input.humanExplanation ?? '').trim()
  const explicitDecisionRaw = input.decision ? String(input.decision).trim().toLowerCase() : null
  if (explicitDecisionRaw && !INTAKE_DECISIONS.includes(explicitDecisionRaw)) {
    throw new Error(`无效的分诊判定 --decision="${input.decision}"（仅支持 ${INTAKE_DECISIONS.join(' | ')}）`)
  }

  const exemption = input.skipExempt ? { exempt: false, reason: null, matchedDoc: null, matchedTaskId: null } : isApprovedInternalPlan(repoRoot, { ...input, targetType, targetNumber })
  const combinedText = `${title}\n${body}`

  const dim1 = evaluateNonGoalsAndRedlines(repoRoot, combinedText, featureRef)
  const dim2 = evaluateDuplicateCheck(repoRoot, { title, body, gitDir: input.gitDir, closedIssues: input.closedIssues, duplicateOf })
  const dim3 = evaluateConflictSurface(repoRoot, { files: input.files, body, taskId: input.taskId, branch: input.branch, targetNumber })
  const dim4 = evaluateDependencyContract(combinedText)
  const dim5 = evaluateComplexityValue({ title, body, touchedFiles: dim3.touchedFiles, highRiskHits: dim3.highRiskHits, exempt: exemption.exempt })

  const dimensions = [dim1.dimension, dim2.dimension, dim3.dimension, dim4.dimension, dim5.dimension]
  const tddRefs = [...new Set([...dim1.tddRefs, ...dim4.tddRefs])]

  let ruleDecision = 'accept'
  if (dim1.dimension.status === 'fail' || dim4.dimension.status === 'fail') ruleDecision = 'reject'
  else if (dim2.isDuplicate) ruleDecision = 'merge-duplicate'
  else if (dim5.outcome === 'needs-info') ruleDecision = 'needs-info'
  else if (dim5.outcome === 'defer') ruleDecision = 'defer'

  const decision = explicitDecisionRaw ?? (exemption.exempt ? 'accept' : ruleDecision)
  const decisionSource = explicitDecisionRaw ? 'explicit' : (exemption.exempt ? 'internal-plan-exempt' : 'rule-engine')
  const labels = [...(INTAKE_DECISION_TO_LABELS[decision] ?? [])]
  const shouldClose = decision === 'reject' || decision === 'merge-duplicate'
  const reason = buildDefaultReason(decision, dimensions, exemption)
  const rollbackHint = buildRollbackHint({ targetType, targetNumber, decision, labels })
  const actor = String(input.actor ?? 'dev-flow').trim() || 'dev-flow'

  const rendered = buildIntakeDecisionComments({
    targetType,
    targetNumber,
    decision,
    reason,
    summary: reason,
    rationale,
    humanExplanation: rationale || reason,
    duplicateOf,
    dimensions,
    labels,
    featureRef,
    tddRefs,
    duplicates: dim2.duplicates,
    rollbackHint,
    applied: Boolean(input.applied),
    closed: Boolean(input.applied && shouldClose),
    actor,
  })

  return {
    ok: true,
    targetType,
    targetNumber,
    title,
    decision,
    ruleDecision,
    decisionSource,
    exempt: exemption.exempt,
    exemptReason: exemption.reason,
    matchedDoc: exemption.matchedDoc,
    matchedTaskId: exemption.matchedTaskId,
    shouldClose,
    labels,
    reason,
    rationale: rationale || null,
    duplicateOf: duplicateOf || null,
    featureRef,
    tddRefs,
    duplicates: dim2.duplicates,
    touchedFiles: dim3.touchedFiles,
    highRiskHits: dim3.highRiskHits,
    activeConflicts: dim3.activeConflicts,
    dimensions,
    rollbackHint,
    commentBody: rendered.commentBody,
    stateTag: rendered.stateTag,
    statePayload: rendered.statePayload,
    delegatedPayload: rendered.delegatedPayload,
    summaryLine: rendered.summaryLine,
  }
}
