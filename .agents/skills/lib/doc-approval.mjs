/**
 * doc-approval.mjs —— 「什么状态算已批准」与「谁在这份文档上有话语权」的唯一取值处。
 *
 * 两件事放在一起，因为它们判的是同一件事实的两面：一份文档「生效」由状态与批准标记
 * 共同表达，而「谁说了算」决定这个人能不能以复核人身份再出现。两处各写一份取值，
 * 迟早出现「状态说已回退、批准仍为真」以及「原负责人换个身份回来给自己放行」。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { withFileLockSync } from './exec.mjs'
import { EXIT } from './exit-codes.mjs'
import { posixPath, readJsonSafe, readTextSafe, sha256Text, writeJsonAtomic } from './git-core.mjs'
import { resolveGitDirFast } from './git-fast.mjs'

/** 历史负责人集合的字段名。自审判定按「历史 ∪ 当前」比对，不只看当前字段。 */
export const PREVIOUS_OWNERS_KEY = 'previous_owners'

/**
 * 各文档类型里「已批准」的档位。
 *
 * 不在这个集合里的档位一旦写进去，批准标记必须同批置假：否则「回退到草稿、批准仍为真」，
 * 而分诊豁免只看那个标记——回退之后文档继续享受「已核准内部规划」的豁免。
 */
export const APPROVING_STATUS = Object.freeze({
  prd: new Set(['active']),
  spec: new Set(['approved', 'implementing']),
  todo: new Set(['active']),
})

function normStatus(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** 给定的状态是不是该类型的「已批准」档位。 */
export function isApprovingStatus(kind, status) {
  const set = APPROVING_STATUS[kind]
  return Boolean(set) && set.has(normStatus(status))
}

/**
 * 给定的状态值是否属于任何一种文档的「已批准」档位（与具体类型无关）。
 *
 * 生命周期同步拿到的是裸状态值、还不知道要写进哪种文档，所以先按值拦一次：
 * 任何批准档位都不许由 `link` 写入，批准只有 `approve` 一个入口。
 */
export function isApprovingStatusValue(status) {
  const st = normStatus(status)
  return Object.values(APPROVING_STATUS).some((set) => set.has(st))
}

/** 归一化参与人标识（去前导 `@`、小写）。 */
export function normOwnerId(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase()
}

/**
 * 历史负责人集合 ∪ 当前负责人（去重保序）。
 *
 * 只看当前 `owner` 是不够的：负责人可以被一次性改写，改写之后原负责人以复核人身份
 * 执行评审仍会被放行——而他写的稿子还在那里。所以三处自审判定都按这份集合比对。
 */
export function collectOwnerHistory(fmData) {
  const out = []
  const seen = new Set()
  const push = (v) => {
    const s = String(v ?? '').trim()
    if (!s || s === 'null') return
    const key = normOwnerId(s)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(s)
  }
  push(fmData?.owner)
  const prev = fmData?.[PREVIOUS_OWNERS_KEY]
  if (Array.isArray(prev)) for (const p of prev) push(p)
  else if (typeof prev === 'string') for (const p of prev.split(',')) push(p)
  return out
}

/** 计算仅覆盖负责人与变更留痕字段的规范化 SHA256 哈希，用于仓外防绕过校验。 */
export function computeOwnerHeaderHash(fmData = {}) {
  const owner = normOwnerId(fmData?.owner)
  const rawPrev = fmData?.[PREVIOUS_OWNERS_KEY]
  const prevList = Array.isArray(rawPrev)
    ? rawPrev
    : (typeof rawPrev === 'string' ? rawPrev.split(',') : [])
  const previousOwners = [...new Set(prevList.map(normOwnerId).filter(Boolean))].sort()
  const ownerChangedReason = String(fmData?.owner_changed_reason ?? '').trim()
  return sha256Text(JSON.stringify({ owner, previousOwners, ownerChangedReason }))
}

/** 构造一条仓外 `planningProvenance` 溯源基线记录。 */
export function buildPlanningProvenanceEntry({
  docRel,
  fmData = {},
  taskId = null,
  existingEntry = null,
} = {}) {
  const curOwners = collectOwnerHistory(fmData)
  const existingPrev = Array.isArray(existingEntry?.previousOwners) ? existingEntry.previousOwners : []
  const planningOwner = existingEntry?.planningOwner ?? (String(fmData?.owner ?? '').trim() || curOwners[0] || null)
  const mergedSet = new Set()
  const previousOwners = []
  for (const cand of [existingEntry?.planningOwner, ...existingPrev, ...curOwners]) {
    const clean = String(cand ?? '').trim()
    const key = normOwnerId(clean)
    if (!clean || !key || mergedSet.has(key)) continue
    mergedSet.add(key)
    previousOwners.push(clean)
  }
  const docRelPaths = [...new Set([
    ...(Array.isArray(existingEntry?.docRelPaths) ? existingEntry.docRelPaths : []),
    docRel,
  ].filter(Boolean))].sort()
  return {
    planningOwner,
    previousOwners,
    docRelPaths,
    ownerHeaderHash: computeOwnerHeaderHash(fmData),
    ...(taskId ? { taskId } : (existingEntry?.taskId ? { taskId: existingEntry.taskId } : {})),
    recordedAt: existingEntry?.recordedAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

function resolveProvenanceStorePath(mainRoot) {
  const fastGitDir = resolveGitDirFast(mainRoot)
  if (fastGitDir) {
    const cdTxt = readTextSafe(join(fastGitDir, 'commondir'))
    const commonDir = cdTxt?.trim() ? resolve(fastGitDir, cdTxt.trim()) : fastGitDir
    return join(commonDir, 'project-forge-flow', 'planning-provenance.json')
  }
  const dotGit = join(mainRoot, '.git')
  try {
    if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
      return join(dotGit, 'project-forge-flow', 'planning-provenance.json')
    }
  } catch { /* fallback below */ }
  return join(mainRoot, '.worktrees', '.state', 'planning-provenance.json')
}

function resolveProvenanceLockDir(mainRoot) {
  const dotGit = join(mainRoot, '.git')
  try {
    if (existsSync(dotGit) && statSync(dotGit).isDirectory()) {
      return join(dotGit, 'project-forge-flow', 'locks')
    }
  } catch { /* fallback below */ }
  return join(mainRoot, '.worktrees', '.state', 'locks')
}

export function readPlanningProvenanceIndex(mainRoot) {
  const storePath = resolveProvenanceStorePath(mainRoot)
  const raw = readJsonSafe(storePath)
  return {
    storePath,
    version: 1,
    byDoc: (raw?.byDoc && typeof raw.byDoc === 'object' && !Array.isArray(raw.byDoc)) ? raw.byDoc : {},
    byTask: (raw?.byTask && typeof raw.byTask === 'object' && !Array.isArray(raw.byTask)) ? raw.byTask : {},
  }
}

function provenanceCandidateKeys(docRel) {
  const norm = posixPath(String(docRel ?? '')).replace(/^\.\//, '')
  if (!norm) return []
  const keys = [norm]
  const arch = /^docs\/archive\/(prd|specs|todo)\/([^/]+)$/.exec(norm)
  if (arch) keys.push(`docs/${arch[1]}/${arch[2]}`)
  return keys
}

export function recordPlanningProvenanceCore(mainRoot, {
  docRoot = mainRoot,
  docRels = [],
  taskId = null,
  fmByRel = null,
  isLegitimateTransfer = false,
  renameMap = null,
} = {}) {
  const lockPath = join(resolveProvenanceLockDir(mainRoot), 'provenance.lock')
  return withFileLockSync(lockPath, () => {
    const idx = readPlanningProvenanceIndex(mainRoot)
    const cleanTaskId = taskId ? String(taskId).trim() : null
    if (renameMap instanceof Map) {
      for (const [oldRel, newRel] of renameMap.entries()) {
        const oldNorm = posixPath(oldRel)
        const newNorm = posixPath(newRel)
        if (idx.byDoc[oldNorm] && !idx.byDoc[newNorm]) {
          idx.byDoc[newNorm] = {
            ...idx.byDoc[oldNorm],
            docRelPaths: [...new Set([...(idx.byDoc[oldNorm].docRelPaths ?? []), newNorm])].sort(),
          }
        }
      }
    }
    let changed = false
    let latestEntry = null
    for (const rawRel of docRels) {
      const docRel = posixPath(String(rawRel ?? '')).replace(/^\.\//, '')
      if (!docRel) continue
      const abs = join(docRoot, docRel)
      let fmData = fmByRel?.[docRel] ?? null
      if (!fmData && existsSync(abs)) {
        const parsed = parseDocFrontmatter(readTextSafe(abs) ?? '')
        if (parsed.hasFrontmatter) fmData = parsed.data
      }
      if (!fmData) continue
      const curHash = computeOwnerHeaderHash(fmData)
      const existingEntry = idx.byDoc[docRel] ?? null
      if (existingEntry && !isLegitimateTransfer && existingEntry.ownerHeaderHash && existingEntry.ownerHeaderHash !== curHash) {
        continue
      }
      const nextEntry = buildPlanningProvenanceEntry({
        docRel,
        fmData,
        taskId: cleanTaskId,
        existingEntry,
      })
      idx.byDoc[docRel] = nextEntry
      if (cleanTaskId) idx.byTask[cleanTaskId] = nextEntry
      latestEntry = nextEntry
      changed = true
    }
    if (changed) {
      writeJsonAtomic(idx.storePath, { version: 1, byDoc: idx.byDoc, byTask: idx.byTask })
    }
    return { storePath: idx.storePath, entry: latestEntry, changed }
  })
}

function readGitHeadFrontmatterSync(docRoot, normRel) {
  const res = spawnSync('git', ['show', `HEAD:${normRel}`], { cwd: docRoot, encoding: 'utf8', windowsHide: true })
  if (res.status !== 0 || !res.stdout) return null
  const parsed = parseDocFrontmatter(res.stdout)
  return parsed.hasFrontmatter ? parsed.data : null
}

/**
 * 三点防绕过溯源校验：对照工作区 Frontmatter、仓外 `.git/project-forge-flow/planning-provenance.json`
 * 与 `HEAD` 基线，拦截未经 `doc-plan link --owner-reason` 的 `owner:` 篡改及规划作者自建自改。
 */
export function verifyPlanningProvenance({
  mainRoot,
  docRoot = mainRoot,
  docRels = [],
  taskId = null,
  ledger = null,
  implementerId = null,
  hostMode = 'multi-agent',
  humanApproved = false,
  isGit = true,
} = {}) {
  const idx = readPlanningProvenanceIndex(mainRoot)
  const cleanTaskId = taskId ? String(taskId).trim() : null
  const allAuthors = []
  const seenAuthorKeys = new Set()
  const addAuthor = (raw) => {
    const s = String(raw ?? '').trim()
    const key = normOwnerId(s)
    if (!s || !key || seenAuthorKeys.has(key)) return
    seenAuthorKeys.add(key)
    allAuthors.push(s)
  }

  const implClean = String(implementerId ?? '').trim()
  const implInvalid = !implClean || /^(?:null|undefined|unknown|none|local-agent|<[^>]+>)$/i.test(implClean)
  const implKey = implInvalid ? '' : normOwnerId(implClean)
  const waivedSingleSession = hostMode === 'single-session' && Boolean(humanApproved)

  for (const rawRel of docRels) {
    const normRel = posixPath(String(rawRel ?? '')).replace(/^\.\//, '')
    if (!normRel) continue
    const abs = join(docRoot, normRel)
    if (!existsSync(abs)) continue
    const workParsed = parseDocFrontmatter(readTextSafe(abs) ?? '')
    if (!workParsed.hasFrontmatter) continue
    const workFm = workParsed.data
    const workHash = computeOwnerHeaderHash(workFm)

    let rec = null
    for (const key of provenanceCandidateKeys(normRel)) {
      if (idx.byDoc[key]) { rec = idx.byDoc[key]; break }
    }
    if (!rec && ledger?.planningProvenance?.docRelPaths?.some((p) => provenanceCandidateKeys(normRel).includes(p))) {
      rec = ledger.planningProvenance
    }
    if (!rec && cleanTaskId && idx.byTask[cleanTaskId]?.docRelPaths?.some((p) => provenanceCandidateKeys(normRel).includes(p))) {
      rec = idx.byTask[cleanTaskId]
    }

    const headFm = isGit ? readGitHeadFrontmatterSync(docRoot, normRel) : null
    if (rec?.ownerHeaderHash && rec.ownerHeaderHash !== workHash) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_PROVENANCE_TAMPERED',
        exitCode: EXIT.FACT,
        file: normRel,
        recordedOwners: rec.previousOwners ?? [rec.planningOwner].filter(Boolean),
        currentOwners: collectOwnerHistory(workFm),
        reason: `BLOCKED_PROVENANCE_TAMPERED: ${normRel} 的负责人/溯源字段被手动篡改（工作区哈希 ${workHash.slice(0, 12)} !== 仓外基线 ${rec.ownerHeaderHash.slice(0, 12)}），请回退后经 \`doc-plan.mjs link --owner <新负责人> --owner-reason "<原因>"\` 留痕变更。`,
      }
    }
    if (!rec && headFm && computeOwnerHeaderHash(headFm) !== workHash) {
      return {
        ok: false,
        blocked: true,
        code: 'BLOCKED_PROVENANCE_TAMPERED',
        exitCode: EXIT.FACT,
        file: normRel,
        recordedOwners: collectOwnerHistory(headFm),
        currentOwners: collectOwnerHistory(workFm),
        reason: `BLOCKED_PROVENANCE_TAMPERED: 存量文档 ${normRel} 在未走 \`doc-plan.mjs link --owner-reason\` 的情况下直接修改了 owner/previous_owners（相对 HEAD 已漂移），请经合规通道留痕后再继续。`,
      }
    }

    const fileAuthors = []
    const pushFileAuthor = (v) => {
      const s = String(v ?? '').trim()
      if (!s) return
      fileAuthors.push(s)
      addAuthor(s)
    }
    if (rec?.planningOwner) pushFileAuthor(rec.planningOwner)
    for (const p of rec?.previousOwners ?? []) pushFileAuthor(p)
    for (const p of collectOwnerHistory(headFm)) pushFileAuthor(p)
    for (const p of collectOwnerHistory(workFm)) pushFileAuthor(p)

    if (implKey && !waivedSingleSession) {
      const matched = fileAuthors.find((a) => !/^(?:null|undefined|unknown|none|local-agent|<[^>]+>)$/i.test(a) && normOwnerId(a) === implKey)
      if (matched) {
        return {
          ok: false,
          blocked: true,
          code: 'BLOCKED_AUTHOR_IS_IMPLEMENTER',
          exitCode: EXIT.FACT,
          author: String(matched).trim(),
          implementerId: implClean,
          file: normRel,
          reason: `${normRel} 的规划作者（${String(matched).trim()}）与实施者（${implClean}）为同一主体；多代理模式下禁止同一代理既写验收标准又实施。`,
        }
      }
    }
  }

  return { ok: true, blocked: false, exitCode: EXIT.OK, authors: allAuthors }
}
