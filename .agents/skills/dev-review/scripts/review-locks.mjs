/**
 * review-locks.mjs —— 六锁防无限审查硬拦截、增量视野 hunk 解析、Pass 门禁核验与处置统计。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）与 `kit/skills/lib/`。
 */

import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'

import { gitRun, gitRunBuffer, posixPath, readTextSafe } from '../../lib/git.mjs'
import {
  getCachedRangeDiffCommits, isAncestorLinearFast, parseRawAndUnifiedDiff,
  resolveGitDirFast, setCachedRangeDiffCommits,
} from '../../lib/git-fast.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { detectGateWeakening, evaluateArchRules, gitDiffRawEntriesAndText, splitDiffByFile } from '../../lib/static-gates.mjs'
import { readVerificationEvidence } from '../../lib/workflow-policy.mjs'
import { EXIT, hasCommits } from './review-diff.mjs'

export const VALID_DISPOSITIONS = new Set(['fixed', 'rebutted-wrong', 'intentional', 'deferred'])

const DETERMINISTIC_FAILURE_RE = /\b(?:arch-?rules|preflight|fixtures|merge-?gate|smoke-?verify|full-?test|quick-?test|BLOCKED_[A-Z0-9_]+|TypeError|SyntaxError|ReferenceError|AssertionError|EPERM|ENOENT|exit(?:\s*code)?\s*[=:]?\s*[1-9]|tests?\s+fail(?:ed|ing)?|CI\s+fail(?:ed|ing)?)\b|(?:单测失败|门禁失败|静态检查失败|退出码\s*[1-9]|架构禁引|死链接)/i
const FILE_LINE_RE = /(?:^|[\s`"'(\[])((?:[A-Za-z0-9_.\u4e00-\u9fa5-]+\/)*[A-Za-z0-9_.\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,10}):(\d+)(?:-(\d+))?(?::\d+)?(?=$|[\s`"',;.)\]：:])/
const BARE_FILE_RE = /(?:^|[\s`"'(\[])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.\u4e00-\u9fa5-]+\.[A-Za-z0-9]{1,10})(?=$|[\s`"',;.)\]：:])/

function normRel(p) {
  return posixPath(String(p ?? '')).trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

function normSummaryText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/^(?:c\d+\s*[:：-]\s*)/i, '')
    .replace(/:\d+(?:-\d+)?(?::\d+)?/g, '')
    .replace(/\bline\s+\d+\b/g, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, ' ')
    .trim()
}

export function computeFingerprint(criterion, file, summary) {
  const key = [
    criterion ? String(criterion).toUpperCase() : '',
    normRel(file).toLowerCase(),
    normSummaryText(summary),
  ].filter(Boolean).join('|')
  return createHash('sha1').update(key || 'empty').digest('hex').slice(0, 12)
}

function extractFileAndLines(text) {
  const raw = String(text ?? '')
  const m = FILE_LINE_RE.exec(raw)
  if (m && !/^https?:/i.test(m[1])) {
    const line = Number(m[2])
    const endLine = m[3] ? Math.max(line, Number(m[3])) : line
    return { file: normRel(m[1]), line: line > 0 ? line : null, endLine: endLine > 0 ? endLine : null }
  }
  const bm = BARE_FILE_RE.exec(raw)
  if (bm && !/^https?:/i.test(bm[1])) {
    return { file: normRel(bm[1]), line: null, endLine: null }
  }
  return { file: '', line: null, endLine: null }
}

export function normalizeMustFixObj(obj, idx) {
  const criterion = obj.criterion || (/^C\d+$/i.test(String(obj.id ?? '')) ? String(obj.id).toUpperCase() : undefined)
  const summary = String(obj.summary ?? obj.message ?? obj.text ?? obj.id ?? '').trim()
  const extracted = extractFileAndLines(summary)
  const file = normRel(obj.file ?? '') || extracted.file
  const rawLine = obj.line !== undefined && obj.line !== null ? Number(obj.line) : extracted.line
  const line = Number.isInteger(rawLine) && rawLine > 0 ? rawLine : null
  const rawEnd = obj.endLine !== undefined && obj.endLine !== null ? Number(obj.endLine) : extracted.endLine
  const endLine = line ? (Number.isInteger(rawEnd) && rawEnd >= line ? rawEnd : line) : null
  const fp = obj.fingerprint ? String(obj.fingerprint).trim() : computeFingerprint(criterion, file, summary)
  return {
    id: String(obj.id ?? criterion ?? `MF-${idx + 1}`),
    criterion,
    file,
    line,
    endLine,
    summary,
    fingerprint: fp,
    ...(obj.rootCause ? { rootCause: String(obj.rootCause).trim() } : {}),
    ...(obj.fixHint ? { fixHint: String(obj.fixHint).trim() } : {}),
    gateFailure: Boolean(obj.gateFailure),
    empiricalFailure: Boolean(obj.empiricalFailure),
    status: obj.status ?? 'open',
  }
}

export function parseMustFixItem(raw, idx) {
  if (typeof raw === 'string' && raw.trim().startsWith('{')) {
    try {
      return normalizeMustFixObj(JSON.parse(raw), idx)
    } catch { /* fall back to text */ }
  }
  const text = String(raw ?? '').trim()
  const cMatch = /^(C\d+)\s*[:：-]\s*(.+)$/i.exec(text)
  const criterion = cMatch ? cMatch[1].toUpperCase() : undefined
  const body = cMatch ? cMatch[2].trim() : text
  const { file, line, endLine } = extractFileAndLines(body)
  const fp = computeFingerprint(criterion, file, body)
  return {
    id: criterion ?? `MF-${idx + 1}`,
    criterion,
    file,
    line,
    endLine,
    summary: text,
    fingerprint: fp,
    gateFailure: false,
    empiricalFailure: false,
    status: 'open',
  }
}

/** 按完整 fingerprint 或 (file, normalizedSummary) 精准比对，绝不仅凭 C* 编号误判。 */
export function sameBlockerItem(a, b) {
  if (!a || !b) return false
  if (a.fingerprint && b.fingerprint && a.fingerprint === b.fingerprint) return true
  const fa = normRel(a.file).toLowerCase()
  const fb = normRel(b.file).toLowerCase()
  if (fa !== fb) return false
  const sa = normSummaryText(a.summary)
  const sb = normSummaryText(b.summary)
  return Boolean(sa && sb && sa === sb)
}

/** 解析 unified diff 的新侧 hunk 行区间（纯删除 count=0 锚定在 start，省略 count 按 1，±contextPadding 行）。 */
export function parseDiffHunkRanges(diffText, { contextPadding = 3 } = {}) {
  const chunks = splitDiffByFile(diffText)
  const map = new Map()
  for (const [rawFile, chunk] of chunks.entries()) {
    const file = normRel(rawFile)
    if (!file) continue
    const ranges = map.get(file) ?? []
    for (const line of String(chunk).split('\n')) {
      const m = /^@@\s+-\d+(?:,\d+)?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line)
      if (!m) continue
      const start = Number(m[1])
      const count = m[2] !== undefined ? Number(m[2]) : 1
      if (count === 0) {
        const anchor = Math.max(1, start)
        ranges.push({ start: Math.max(1, anchor - contextPadding), end: anchor + contextPadding })
      } else {
        ranges.push({
          start: Math.max(1, start - contextPadding),
          end: Math.max(1, start + count - 1 + contextPadding),
        })
      }
    }
    map.set(file, ranges)
  }
  return map
}

/** 解析 `git range-diff --no-color` 输出的新侧变更/新增提交 SHA（! 与 >）。 */
export function parseRangeDiffNewCommits(text) {
  const shas = []
  for (const rawLine of String(text ?? '').split('\n')) {
    const m = /^\s*(?:\d+|-)\s*:\s*[0-9a-f-]+\s+([!>=<])\s+(?:\d+|-)\s*:\s*([0-9a-f]+)\b/i.exec(rawLine)
    if (!m) continue
    const op = m[1]
    const sha = m[2]
    if ((op === '!' || op === '>') && sha && !/^-+$/.test(sha) && !shas.includes(sha)) {
      shas.push(sha)
    }
  }
  return shas
}

function collectFilesFromShowNameStatusZ(buf, fileRanges) {
  const tokens = Buffer.isBuffer(buf) ? buf.toString('utf8').split('\0') : String(buf ?? '').split('\0')
  for (let i = 0; i < tokens.length; i += 1) {
    const st = tokens[i]?.trim()
    if (!st) continue
    if (/^[RC]/.test(st)) {
      const f = normRel(tokens[i + 2] ?? '')
      i += 2
      if (f && !fileRanges.has(f)) fileRanges.set(f, [])
    } else if (/^[MADTU]/.test(st)) {
      const f = normRel(tokens[i + 1] ?? '')
      i += 1
      if (f && !fileRanges.has(f)) fileRanges.set(f, [])
    }
  }
}

const scopeRangeCache = new Map()

export async function collectIncrementalScope(targetRoot, { prevHead, headSha, baseSha, baseBranch, prevRoundBaseSha, currentBaseSha, roundBaseSha } = {}) {
  if (!targetRoot || !headSha || headSha === 'UNBORN') {
    return { available: false, range: null, fileRanges: new Map() }
  }
  const shaHexRe = /^[0-9a-f]{40,64}$/i
  if (prevHead && shaHexRe.test(prevHead) && shaHexRe.test(headSha)) {
    const cacheKey = `${targetRoot}\0${prevHead}\0${headSha}\0${baseSha ?? ''}`
    if (scopeRangeCache.has(cacheKey)) return scopeRangeCache.get(cacheKey)
  }
  const saveScopeCache = (result) => {
    if (result?.available && prevHead && shaHexRe.test(prevHead) && shaHexRe.test(headSha)) {
      const cacheKey = `${targetRoot}\0${prevHead}\0${headSha}\0${baseSha ?? ''}`
      if (scopeRangeCache.size >= 32) scopeRangeCache.clear()
      scopeRangeCache.set(cacheKey, result)
    }
    return result
  }
  let range = null
  if (prevHead && prevHead !== 'UNBORN') {
    const wtGitDir = resolveGitDirFast(targetRoot)
    const cdTxt = wtGitDir ? readTextSafe(join(wtGitDir, 'commondir')) : null
    const commonDir = wtGitDir ? (cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir) : null
    const fastAnc = commonDir ? isAncestorLinearFast(commonDir, prevHead, headSha) : null
    const ancOk = fastAnc !== null ? fastAnc : (await gitRun(targetRoot, ['--no-optional-locks', 'merge-base', '--is-ancestor', prevHead, headSha])).ok
    if (ancOk) range = `${prevHead}..${headSha}`
    else {
      const oldBase = prevRoundBaseSha ?? roundBaseSha?.prevBaseSha
      const newBase = currentBaseSha ?? roundBaseSha?.newBaseSha ?? baseSha
      if (oldBase && newBase) {
        if (oldBase === prevHead) {
          range = `${newBase}..${headSha}`
        } else {
          const oldR = `${oldBase}..${prevHead}`
          const newR = `${newBase}..${headSha}`
          const shaRangeOk = Boolean(commonDir && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/i.test(oldR) && /^[0-9a-f]{40}\.\.[0-9a-f]{40}$/i.test(newR))
          let commits = shaRangeOk ? getCachedRangeDiffCommits(commonDir, oldR, newR) : null
          if (!commits) {
            const rdRes = await gitRun(targetRoot, ['--no-optional-locks', 'range-diff', '--no-color', oldR, newR])
            if (rdRes.ok) {
              commits = parseRangeDiffNewCommits(rdRes.stdout)
              if (shaRangeOk) setCachedRangeDiffCommits(commonDir, oldR, newR, commits)
            }
          }
          if (commits) {
            const label = `range-diff (${commits.length} changed/new commit(s))`
            if (commits.length === 0) return saveScopeCache({ available: true, range: label, fileRanges: new Map() })
            if (commits.length === 1) {
              const oneRes = await gitRunBuffer(targetRoot, ['--no-optional-locks', 'show', '--format=tformat:', '--raw', '--unified=0', '--no-ext-diff', '--no-color', commits[0]], { maxBuffer: 32 * 1024 * 1024 })
              if (oneRes.ok) {
                const { entries: rawEntries, diffText } = parseRawAndUnifiedDiff(oneRes.stdout)
                const fileRanges = parseDiffHunkRanges(diffText, { contextPadding: 3 })
                for (const e of rawEntries) { const f = normRel(e.file); if (f && !fileRanges.has(f)) fileRanges.set(f, []) }
                return saveScopeCache({ available: true, range: label, fileRanges })
              }
            }
            const [showDiff, showNs] = await Promise.all([
              gitRunBuffer(targetRoot, ['--no-optional-locks', 'show', '--format=tformat:', '--unified=0', '--no-ext-diff', '--no-color', ...commits], { maxBuffer: 32 * 1024 * 1024 }),
              gitRunBuffer(targetRoot, ['--no-optional-locks', 'show', '--format=tformat:', '--name-status', '-z', ...commits]),
            ])
            if (showDiff.ok) {
              const fileRanges = parseDiffHunkRanges(showDiff.stdout.toString('utf8').replace(/\r\n/g, '\n'), { contextPadding: 3 })
              if (showNs.ok) collectFilesFromShowNameStatusZ(showNs.stdout, fileRanges)
              return saveScopeCache({ available: true, range: label, fileRanges })
            }
          }
        }
      }
    }
    if (!range && baseSha && (shaHexRe.test(baseSha) || (await gitRun(targetRoot, ['rev-parse', '--verify', baseSha])).ok)) range = `${baseSha}..${headSha}`
  } else if (baseSha) {
    const fastOk = shaHexRe.test(String(baseSha)) || (await gitRun(targetRoot, ['rev-parse', '--verify', baseSha])).ok
    if (fastOk) range = `${baseSha}..${headSha}`
  }

  if (!range && baseBranch) {
    const mb = await gitRun(targetRoot, ['--no-optional-locks', 'merge-base', baseBranch, headSha])
    if (mb.ok && mb.stdout.trim()) range = `${mb.stdout.trim()}..${headSha}`
  }
  if (!range) return { available: false, range: null, fileRanges: new Map() }

  const rawDiffRes = await gitRunBuffer(targetRoot, [
    '--no-optional-locks', 'diff', '--raw', '--unified=0', '--no-ext-diff', '--no-color', range,
  ], { maxBuffer: 32 * 1024 * 1024 })
  if (!rawDiffRes.ok) return { available: false, range, fileRanges: new Map() }

  const { entries: rawEntries, diffText } = parseRawAndUnifiedDiff(rawDiffRes.stdout)
  const fileRanges = parseDiffHunkRanges(diffText, { contextPadding: 3 })
  for (const e of rawEntries) {
    const f = normRel(e.file)
    if (f && !fileRanges.has(f)) fileRanges.set(f, [])
  }
  return saveScopeCache({ available: true, range, fileRanges })
}

/** 锁 A：历史轮次已触发停损且未经人类解锁时，硬阻断 Round 4+ pass/changes 绕过（退出码 4）。 */
export function checkHistoricalStopLoss(prevRounds, ledger, opts = {}) {
  const hasStopLoss = Array.isArray(prevRounds) && prevRounds.some((r) => Boolean(r.stopLossTriggered))
  if (!hasStopLoss || ledger?.humanApprovedStopLoss) return { blocked: false }
  if (opts['human-approved'] && String(opts.reason ?? '').trim()) {
    return { blocked: false, unlockedNow: true, reason: String(opts.reason).trim() }
  }
  return {
    blocked: true,
    code: 'STOP_LOSS_ESCALATE',
    exitCode: EXIT.STOP_LOSS,
    message: 'STOP_LOSS_ESCALATE: 历史轮次已触发停损且未获人类维护者解锁，禁止继续通过 record 绕过；请先运行 `review-pack.mjs override --human-approved --reason "..."`。',
  }
}

/** 锁 B：Round 2+ 硬拒相同 HEAD 原地复审（退出码 2）。 */
export function checkSameHeadRereview({ round, prevRound, headSha }) {
  if (round >= 2 && prevRound?.headSha && prevRound.headSha !== 'UNBORN' && headSha && headSha !== 'UNBORN' && prevRound.headSha === headSha) {
    return {
      blocked: true,
      code: 'BLOCKED_SAME_HEAD_REREVIEW',
      exitCode: EXIT.USAGE_OR_POLICY,
      message: `BLOCKED_SAME_HEAD_REREVIEW: Round ${round} 待审 HEAD (${headSha.slice(0, 7)}) 与 Round ${prevRound.round} 完全相同，实施者必须提交新修复后再复审。`,
    }
  }
  return { blocked: false }
}

function matchesRebutList(mf, rebuts = []) {
  for (const rb of rebuts) {
    if (!rb) continue
    const fid = typeof rb === 'string' ? rb : String(rb.findingId ?? '').trim()
    if (!fid) continue
    const low = fid.toLowerCase()
    if (low === String(mf.id ?? '').toLowerCase() || low === String(mf.fingerprint ?? '').toLowerCase()
      || (mf.criterion && low === mf.criterion.toLowerCase()) || (mf.file && low === mf.file.toLowerCase())) {
      return true
    }
  }
  return false
}

/** 锁 C：Round 2+ 增量视野硬锁，拦截指向未改旧文件/旧行或无据主观新挑刺（退出码 2）。 */
export async function checkIncrementalScopeLock({
  round, verdict, mustFixList, prevOpen, rebuts, targetRoot,
  prevHead, headSha, baseSha, baseBranch, prevRoundBaseSha, currentBaseSha, roundBaseSha, evidence, lastVerifyExitCode,
}) {
  if (round < 2 || verdict !== 'changes' || !Array.isArray(mustFixList) || mustFixList.length === 0) {
    return { blocked: false }
  }
  const scope = await collectIncrementalScope(targetRoot, { prevHead, headSha, baseSha, baseBranch, prevRoundBaseSha, currentBaseSha, roundBaseSha })
  const hasFailedEvidence = Boolean(
    (lastVerifyExitCode !== null && lastVerifyExitCode !== undefined && lastVerifyExitCode !== 0)
    || (evidence && evidence.headSha === headSha && evidence.exitCode !== 0),
  )

  const outOfScope = []
  for (const mf of mustFixList) {
    if ((prevOpen ?? []).some((pm) => sameBlockerItem(mf, pm)) || matchesRebutList(mf, rebuts)) {
      continue
    }
    if (mf.file) {
      if (!scope.available) continue
      const ranges = scope.fileRanges.get(mf.file)
      if (!ranges) {
        outOfScope.push({ item: mf, reason: `文件 ${mf.file} 不在增量 diff (${scope.range}) 改动范围内` })
        continue
      }
      if (mf.line !== null && ranges.length > 0) {
        const mfEnd = mf.endLine ?? mf.line
        const hit = ranges.some((r) => mf.line <= r.end && mfEnd >= r.start)
        if (!hit) {
          outOfScope.push({ item: mf, reason: `${mf.file}:${mf.line} 不在增量修改 hunk（±3 行）范围内` })
        }
      }
    } else if (!mf.gateFailure && !mf.empiricalFailure && !hasFailedEvidence && !DETERMINISTIC_FAILURE_RE.test(mf.summary)) {
      outOfScope.push({ item: mf, reason: 'Round 2+ 无文件路径且未关联确定性门禁/实证失败的新增主观挑刺不允许阻塞合入' })
    }
  }

  if (outOfScope.length > 0) {
    return {
      blocked: true,
      code: 'BLOCKED_OUT_OF_SCOPE_MUST_FIX',
      exitCode: EXIT.USAGE_OR_POLICY,
      range: scope.range,
      outOfScope,
      message: `BLOCKED_OUT_OF_SCOPE_MUST_FIX: Round ${round} 增量视野硬锁拒绝以下越界阻塞项（非阻塞建议请改用 --should-fix 或 --pre-existing）：${outOfScope.map((o) => `[${o.item.id}] ${o.reason}`).join('；')}`,
    }
  }
  return { blocked: false, range: scope.range }
}

/** Pass 门禁阻断核验（`findingsBlocker`），仅在失败实证或显式 `--enforce-gates` 时阻断虚假 pass。 */
export async function evaluatePassBlockers({
  mainRoot, targetRoot, gitDir, taskId, ledger, headSha, enforceGates = false, humanApproved = false,
}) {
  const blockers = []
  if (ledger?.lastVerifyExitCode !== null && ledger?.lastVerifyExitCode !== undefined && ledger.lastVerifyExitCode !== 0) {
    blockers.push(`任务账本 lastVerifyExitCode=${ledger.lastVerifyExitCode}（verify 未通过）`)
  }
  const evidence = gitDir && taskId ? readVerificationEvidence(gitDir, taskId) : null
  if (evidence && (!headSha || headSha === 'UNBORN' || evidence.headSha === headSha)) {
    const failedGate = Object.entries(evidence.gates ?? {}).find(([, g]) => g && g.headSha === evidence.headSha && g.exitCode !== 0)
    if (evidence.exitCode !== 0 || failedGate) {
      blockers.push(`evidence.json 记录存在失败门禁（${failedGate ? failedGate[0] : `exit=${evidence.exitCode}`}）`)
    }
  }

  if (enforceGates) {
    if (!ledger?.verifiedHead || (headSha && headSha !== 'UNBORN' && ledger.verifiedHead !== headSha)) {
      blockers.push(`--enforce-gates: verifiedHead (${String(ledger?.verifiedHead ?? 'null').slice(0, 7)}) 与当前 HEAD (${String(headSha ?? '').slice(0, 7)}) 不一致`)
    }
    const profile = parseAgentsProfile(mainRoot)
    if (targetRoot && (await hasCommits(targetRoot))) {
      const ref = ledger?.baseSha || ledger?.baseBranch
      const filesRes = ref ? await gitDiffRawEntriesAndText(targetRoot, `${ref}..HEAD`) : { ok: false, entries: [] }
      const changedFiles = filesRes.ok ? filesRes.entries.filter((e) => e.status !== 'D').map((e) => e.file) : []
      if (profile.archRules?.length && changedFiles.length > 0) {
        const arch = evaluateArchRules(targetRoot, changedFiles, profile.archRules)
        if (!arch.ok) blockers.push(`--enforce-gates: 存在 ${arch.violations.length} 处 arch-rules 禁引违规`)
      }
      if (!humanApproved && !ledger?.humanApprovedStopLoss) {
        const gw = await detectGateWeakening(targetRoot, ledger?.baseSha, ledger?.baseBranch, {
          headSha,
          nameStatusEntries: filesRes.ok ? filesRes.entries : undefined,
        })
        if (gw.length > 0) blockers.push(`--enforce-gates: 检测到未授权的门禁弱化改动（${gw.map((h) => h.file).join(', ')}）`)
      }
    }
  }

  return {
    blocked: blockers.length > 0,
    code: 'BLOCKED_PASS_WITH_OPEN_BLOCKERS',
    exitCode: EXIT.USAGE_OR_POLICY,
    blockers,
    message: blockers.length > 0 ? `BLOCKED_PASS_WITH_OPEN_BLOCKERS: 存在未收口阻塞门禁，禁止记录 pass：${blockers.join('；')}` : '',
  }
}

export function normalizeAdvisoryList(items = []) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(items) ? items : []) {
    const clean = String(raw ?? '').replace(/\s+/g, ' ').trim()
    if (!clean) continue
    const key = clean.toLowerCase()
    if (!seen.has(key)) { seen.add(key); out.push(clean) }
  }
  return out
}

export function parseDispositions(rawList = []) {
  const parsed = []
  for (const raw of Array.isArray(rawList) ? rawList : []) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    const idx = s.lastIndexOf(':')
    if (idx <= 0 || idx === s.length - 1) {
      return { ok: false, error: `INVALID_DISPOSITION: --disposition 格式应为 "<idOrFp>:<fixed|rebutted-wrong|intentional|deferred>"，收到：${s}` }
    }
    const idOrFp = s.slice(0, idx).trim()
    const outcome = s.slice(idx + 1).trim().toLowerCase()
    if (!idOrFp || !VALID_DISPOSITIONS.has(outcome)) {
      return { ok: false, error: `INVALID_DISPOSITION: 无效处置枚举 "${outcome}"（仅允许 ${[...VALID_DISPOSITIONS].join(' | ')}）` }
    }
    parsed.push({ idOrFp, outcome })
  }
  return { ok: true, items: parsed }
}

export function computeDispositionStats(rounds = []) {
  const dedup = new Map()
  for (const r of Array.isArray(rounds) ? rounds : []) {
    const rNum = Number(r.round) || 0
    for (const d of Array.isArray(r.dispositions) ? r.dispositions : []) {
      if (!d?.idOrFp || !VALID_DISPOSITIONS.has(d.outcome)) continue
      dedup.set(`${rNum}:${String(d.idOrFp).toLowerCase()}`, d.outcome)
    }
  }
  const counts = { fixed: 0, 'rebutted-wrong': 0, intentional: 0, deferred: 0 }
  for (const outcome of dedup.values()) counts[outcome] += 1
  const total = dedup.size
  const invalidCount = counts['rebutted-wrong'] + counts.intentional
  return {
    ...counts,
    total,
    falsePositiveRate: total > 0 ? Number((invalidCount / total).toFixed(4)) : 0,
  }
}
