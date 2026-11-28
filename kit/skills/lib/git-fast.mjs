/**
 * git-fast.mjs —— 零子进程读取 `.git/index` / `.git/refs` / `.git/HEAD` / `.git/config` / `packed-refs` 的快速读库。
 *
 * 仅覆盖安全、只读、确定性快路径；遇到 reftable / SHA-256 / v4 index / include / 异常时返回 `null` 回退 `git` CLI。
 */

import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { prepareExecInvocation, resolveExecutable } from './exec.mjs'
import { LIKELY_DEFAULT_BRANCHES, isMacMetadataName, readTextSafe } from './git-core.mjs'
import {
  collectAncestorsDagFast,
  computePatchRawDigest,
  countCommitsAheadDagFast,
  hasAnyTagFast,
  isAncestorLinearFast,
  readFirstParentsFast,
  readGitBlobTextFast,
  readGitObjectFast,
  readReflogFast,
} from './git-fast-objects.mjs'
import {
  hasDotGitInAncestors,
  hasUnmergedIndexFast,
  isPathInGitIndexFast,
  parsePorcelainV2BranchZ,
  readGitIndexPathsFast,
  resolveCommonGitDir,
  resolveGitDirFast,
} from './git-index-fast.mjs'

export {
  collectAncestorsDagFast,
  computePatchRawDigest,
  countCommitsAheadDagFast,
  hasAnyTagFast,
  hasDotGitInAncestors,
  hasUnmergedIndexFast,
  isAncestorLinearFast,
  isPathInGitIndexFast,
  parsePorcelainV2BranchZ,
  readFirstParentsFast,
  readGitBlobTextFast,
  readGitIndexPathsFast,
  readGitObjectFast,
  readReflogFast,
  resolveCommonGitDir,
  resolveGitDirFast,
}

/** 从 `for-each-ref` 输出推算默认分支（strict=true 时无可用分支返回 null）。 */
export function resolveDefaultBranchFromRefs(refsStdout, curBranch, initDefaultBranch, { strict = true } = {}) {
  const localHeads = new Set()
  const originHeads = new Set()
  let originHeadTarget
  for (const rawLine of String(refsStdout ?? '').split('\n')) {
    if (!rawLine) continue
    const [refName, symTarget = ''] = rawLine.split('\t')
    if (refName === 'refs/remotes/origin/HEAD' && symTarget.trim()) {
      originHeadTarget = symTarget.trim().replace(/^origin\//, '')
    } else if (refName.startsWith('refs/heads/')) {
      localHeads.add(refName.slice(11))
    } else if (refName.startsWith('refs/remotes/origin/')) {
      const name = refName.slice(20)
      if (name !== 'HEAD') originHeads.add(name)
    }
  }
  if (originHeadTarget) return originHeadTarget
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (localHeads.has(cand) || originHeads.has(cand)) return cand
  }
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return strict ? null : (initDefaultBranch || 'main')
}

let cachedSysConfigMap
let pendingSysConfigPromise
function parseSysConfigLines(out) {
  const map = new Map()
  for (const line of String(out ?? '').split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const k = line.slice(0, eq).trim().toLowerCase()
    const v = line.slice(eq + 1).trim()
    if (k) map.set(k, v)
  }
  return map
}

function parseSystemGitConfigIniFast() {
  if (process.env.GIT_CONFIG_SYSTEM || process.env.GIT_CONFIG_NOSYSTEM || process.env.GIT_CONFIG_COUNT) return null
  const candidates = []
  if (process.platform === 'win32') {
    const gitExeRes = resolveExecutable('git')
    const gitExe = typeof gitExeRes === 'string' ? gitExeRes : (gitExeRes?.path ?? gitExeRes?.cmd ?? null)
    if (gitExe) {
      const rootDir = dirname(dirname(gitExe))
      candidates.push(
        join(rootDir, 'etc', 'gitconfig'),
        join(dirname(rootDir), 'etc', 'gitconfig'),
        join(rootDir, 'mingw64', 'etc', 'gitconfig'),
      )
    }
  } else {
    candidates.push('/etc/gitconfig')
  }
  for (const cfgPath of candidates) {
    if (!existsSync(cfgPath)) continue
    const txt = readTextSafe(cfgPath)
    if (txt === undefined || /^\s*\[(?:include|includeif)\b/im.test(txt)) return null
    const map = new Map()
    let curSec = ''
    let curSub = ''
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.replace(/(?:^|\s)[;#].*$/, '').trim()
      if (!line) continue
      const sec = /^\[([a-z0-9-]+)(?:\s+"(.*)")?\]$/i.exec(line)
      if (sec) { curSec = sec[1].toLowerCase(); curSub = sec[2] ?? ''; continue }
      const eq = line.indexOf('=')
      if (eq <= 0 || !curSec) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      const fullKey = curSub ? `${curSec}.${curSub.toLowerCase()}.${k}` : `${curSec}.${k}`
      map.set(fullKey, v)
    }
    return map
  }
  return null
}

export function readSystemGitConfigMapFast() {
  if (cachedSysConfigMap !== undefined) return cachedSysConfigMap
  const iniMap = parseSystemGitConfigIniFast()
  if (iniMap) {
    cachedSysConfigMap = iniMap
    return cachedSysConfigMap
  }
  try {
    const inv = process.platform === 'win32'
      ? prepareExecInvocation('git', ['config', '--system', '--list'], {})
      : { cmd: 'git', args: ['config', '--system', '--list'] }
    const out = execFileSync(inv.cmd, inv.args, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    })
    cachedSysConfigMap = parseSysConfigLines(out)
  } catch { cachedSysConfigMap = new Map() }
  return cachedSysConfigMap
}

export function readSystemGitConfigMapAsync() {
  if (cachedSysConfigMap !== undefined) return Promise.resolve(cachedSysConfigMap)
  const iniMap = parseSystemGitConfigIniFast()
  if (iniMap) {
    cachedSysConfigMap = iniMap
    return Promise.resolve(cachedSysConfigMap)
  }
  if (pendingSysConfigPromise) return pendingSysConfigPromise
  pendingSysConfigPromise = new Promise((done) => {
    try {
      const inv = process.platform === 'win32'
        ? prepareExecInvocation('git', ['config', '--system', '--list'], {})
        : { cmd: 'git', args: ['config', '--system', '--list'] }
      execFile(inv.cmd, inv.args, {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      }, (err, stdout) => {
        cachedSysConfigMap = (!err && stdout) ? parseSysConfigLines(stdout) : new Map()
        pendingSysConfigPromise = null
        done(cachedSysConfigMap)
      })
    } catch {
      cachedSysConfigMap = new Map()
      pendingSysConfigPromise = null
      done(cachedSysConfigMap)
    }
  })
  return pendingSysConfigPromise
}

/** 零子进程解析全局与本地 `.git/config`（遇 include 时返回 null 回退 git CLI）。 */
export function readGitConfigFast(gitCommonDir, opts = {}) {
  if (!gitCommonDir) return null
  if (process.env.GIT_CONFIG_GLOBAL || process.env.GIT_CONFIG_SYSTEM || process.env.GIT_CONFIG_COUNT) return null
  const commonRel = readTextSafe(join(gitCommonDir, 'commondir'))
  const effectiveCommonDir = commonRel ? resolve(gitCommonDir, commonRel.trim()) : gitCommonDir
  const localCfg = readTextSafe(join(effectiveCommonDir, 'config'))
  if (localCfg === undefined) return null
  const xdgHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const globalPaths = [join(homedir(), '.gitconfig'), join(xdgHome, 'git', 'config')]
  let globalCfg = ''
  for (const gp of globalPaths) {
    const txt = readTextSafe(gp)
    if (txt) { globalCfg = txt; break }
  }
  const combined = `${globalCfg}\n${localCfg}`
  if (/^\s*\[(?:include\b|includeif\b)/im.test(combined)) return null

  const skipSys = opts.systemMap === false
  const sysMap = skipSys ? new Map() : (opts.systemMap ?? readSystemGitConfigMapFast())
  const remoteLines = []
  let curSection = ''
  let curRemote = null
  let curUrlBase = null
  const remotes = new Map()
  const urlRulesMap = new Map()
  let userName = sysMap.get('user.name')
  let userEmail = sysMap.get('user.email')
  let initDefaultBranch = sysMap.get('init.defaultbranch')

  for (const rawCfg of [globalCfg, localCfg]) {
    curSection = ''
    curRemote = null
    curUrlBase = null
    for (const rawLine of rawCfg.split('\n')) {
      const line = rawLine.replace(/(?:^|\s)[;#].*$/, '').trim()
      if (!line) continue
      const sec = /^\[([a-z0-9-]+)(?:\s+"(.*)")?\]$/i.exec(line)
      if (sec) {
        curSection = sec[1].toLowerCase()
        curRemote = curSection === 'remote' ? (sec[2] ?? '') : null
        curUrlBase = curSection === 'url' ? (sec[2] ?? '') : null
        if (curSection === 'remote' && curRemote && !remotes.has(curRemote)) {
          remotes.set(curRemote, { urls: [], pushUrls: [] })
        }
        if (curSection === 'url' && curUrlBase && !urlRulesMap.has(curUrlBase)) {
          urlRulesMap.set(curUrlBase, { base: curUrlBase, insteadOf: [], pushInsteadOf: [] })
        }
        continue
      }
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      if (curSection === 'user') {
        if (k === 'name') userName = v
        else if (k === 'email') userEmail = v
      } else if (curSection === 'init' && k === 'defaultbranch') {
        initDefaultBranch = v
      } else if (curSection === 'remote' && curRemote) {
        const entry = remotes.get(curRemote)
        if (k === 'url' && v) entry.urls.push(v)
        else if (k === 'pushurl' && v) entry.pushUrls.push(v)
      } else if (curSection === 'url' && curUrlBase) {
        const rule = urlRulesMap.get(curUrlBase)
        if (k === 'insteadof' && v) rule.insteadOf.push(v)
        else if (k === 'pushinsteadof' && v) rule.pushInsteadOf.push(v)
      }
    }
  }

  const urlRules = [...urlRulesMap.values()]
  const rewriteUrl = (rawUrl, isPush) => {
    if (!rawUrl || urlRules.length === 0) return rawUrl
    let bestPrefix = ''
    let bestBase = null
    if (isPush) {
      for (const r of urlRules) {
        for (const p of r.pushInsteadOf) {
          if (rawUrl.startsWith(p) && p.length > bestPrefix.length) {
            bestPrefix = p
            bestBase = r.base
          }
        }
      }
      if (bestBase !== null) return `${bestBase}${rawUrl.slice(bestPrefix.length)}`
    }
    for (const r of urlRules) {
      for (const p of r.insteadOf) {
        if (rawUrl.startsWith(p) && p.length > bestPrefix.length) {
          bestPrefix = p
          bestBase = r.base
        }
      }
    }
    return bestBase !== null ? `${bestBase}${rawUrl.slice(bestPrefix.length)}` : rawUrl
  }

  for (const [name, entry] of remotes.entries()) {
    const rawFetch = entry.urls[0]
    const rawPush = entry.pushUrls[0]
    const fetchUrl = rawFetch ? rewriteUrl(rawFetch, false) : undefined
    const pushUrl = rawPush ? rewriteUrl(rawPush, false) : (rawFetch ? rewriteUrl(rawFetch, true) : undefined)
    if (fetchUrl) remoteLines.push(`${name}\t${fetchUrl} (fetch)`)
    if (pushUrl) remoteLines.push(`${name}\t${pushUrl} (push)`)
  }
  return {
    userName,
    userEmail,
    initDefaultBranch,
    remoteText: remoteLines.join('\n'),
    hasIdentity: Boolean(userName && userEmail),
    checkedAllScopes: !skipSys,
  }
}

/** 解析 loose/packed ref 的 commit SHA（reftable 或不存在返回 null）。 */
export function resolveRefShaFast(gitCommonDir, fullRef) {
  if (!gitCommonDir || !fullRef || existsSync(join(gitCommonDir, 'reftable'))) return null
  const cleanRef = String(fullRef).replace(/^\/+/, '')
  const looseAbs = join(gitCommonDir, ...cleanRef.split('/'))
  const looseTxt = readTextSafe(looseAbs)
  if (looseTxt) {
    const t = looseTxt.trim()
    if (/^[0-9a-f]{40,64}$/i.test(t)) return t
    if (t.startsWith('ref:')) return resolveRefShaFast(gitCommonDir, t.slice(4).trim())
  }
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs'))
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const sha = line.slice(0, sp).trim()
      const refName = line.slice(sp + 1).trim()
      if (refName === cleanRef && /^[0-9a-f]{40,64}$/i.test(sha)) return sha
    }
  }
  return null
}

/** 零子进程读取工作区 HEAD 与关联 branch / oid（自动解析 commondir；reftable 或异常返回 null）。 */
export function readHeadFast(wtGitDir, gitCommonDir = null) {
  if (!wtGitDir) return null
  let commonDir = gitCommonDir
  if (!commonDir || commonDir === wtGitDir) {
    const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
    commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir
  }
  if (existsSync(join(commonDir, 'reftable'))) return null
  const headTxt = readTextSafe(join(wtGitDir, 'HEAD'))
  if (!headTxt) return null
  const t = headTxt.trim()
  if (t.startsWith('ref:')) {
    const targetRef = t.slice(4).trim()
    const branch = targetRef.startsWith('refs/heads/') ? targetRef.slice(11) : targetRef
    const oid = resolveRefShaFast(commonDir, targetRef)
    return { detached: false, ref: targetRef, branch, oid }
  }
  if (/^[0-9a-f]{40,64}$/i.test(t)) {
    return { detached: true, ref: null, branch: null, oid: t }
  }
  return null
}

const rawDiffTextCache = new WeakMap()

export function cacheEntriesDiffText(entries, diffText) {
  if (Array.isArray(entries) && typeof diffText === 'string') {
    rawDiffTextCache.set(entries, diffText)
  }
  return entries
}

export function getCachedEntriesDiffText(entries) {
  return Array.isArray(entries) ? rawDiffTextCache.get(entries) : undefined
}

/** 解析 `git diff --raw --unified=3 --no-ext-diff --no-color` 混合输出为 `{ entries, diffText }`。 */
export function parseRawAndUnifiedDiff(bufOrText) {
  const full = Buffer.isBuffer(bufOrText)
    ? bufOrText.toString('utf8').replace(/\r\n/g, '\n')
    : String(bufOrText ?? '').replace(/\r\n/g, '\n')
  if (!full.trim()) return { entries: [], diffText: '' }
  const diffAt = full.startsWith('diff --git ') ? 0 : full.indexOf('\ndiff --git ')
  const rawPart = diffAt === -1 ? full : (diffAt === 0 ? '' : full.slice(0, diffAt))
  const diffText = diffAt === -1 ? '' : (diffAt === 0 ? full : full.slice(diffAt + 1))
  const entries = []
  for (const line of rawPart.split('\n')) {
    if (!line.startsWith(':')) continue
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const meta = line.slice(1, tab).trim().split(/\s+/)
    const status = meta[meta.length - 1] || 'M'
    const rest = line.slice(tab + 1)
    if (/^[RC]/.test(status)) {
      const parts = rest.split('\t')
      const oldFile = (parts[0] ?? '').replace(/\\/g, '/')
      const file = (parts[1] ?? '').replace(/\\/g, '/')
      if (file) entries.push({ status, file, oldFile })
    } else {
      const file = rest.replace(/\\/g, '/')
      if (file) entries.push({ status, file })
    }
  }
  cacheEntriesDiffText(entries, diffText)
  return { entries, diffText }
}

/** 零子进程扫描 loose 与 packed-refs 中的 tags、localBranches、remoteOriginBranches 与 origin/HEAD。 */
export function listRefsFast(gitCommonDir) {
  if (!gitCommonDir || existsSync(join(gitCommonDir, 'reftable'))) return null
  let originHeadBranch
  const origHeadText = readTextSafe(join(gitCommonDir, 'refs', 'remotes', 'origin', 'HEAD'))
  if (origHeadText) {
    const m = /^ref:\s*refs\/remotes\/origin\/(.+)$/im.exec(origHeadText.trim())
    if (m) originHeadBranch = m[1].trim()
  }
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs')) ?? ''
  if (!originHeadBranch && packed) {
    const sym = /^ref:\s*refs\/remotes\/origin\/([^\s]+)\s+refs\/remotes\/origin\/HEAD$/m.exec(packed)
    if (sym) originHeadBranch = sym[1].trim()
  }
  const scanLoose = (dirAbs, excludeName = null) => {
    const set = new Set()
    if (!existsSync(dirAbs)) return set
    const stack = [{ abs: dirAbs, rel: '' }]
    while (stack.length > 0) {
      const cur = stack.pop()
      let entries = []
      try { entries = readdirSync(cur.abs, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (isMacMetadataName(e.name)) continue
        const name = cur.rel ? `${cur.rel}/${e.name}` : e.name
        if (e.isDirectory()) stack.push({ abs: join(cur.abs, e.name), rel: name })
        else if (e.isFile() && name !== excludeName) set.add(name)
      }
    }
    return set
  }
  const tagSet = scanLoose(join(gitCommonDir, 'refs', 'tags'))
  const localHeads = scanLoose(join(gitCommonDir, 'refs', 'heads'))
  const originHeads = scanLoose(join(gitCommonDir, 'refs', 'remotes', 'origin'), 'HEAD')
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const refName = line.slice(sp + 1).trim()
      if (refName.startsWith('refs/tags/')) tagSet.add(refName.slice(10))
      else if (refName.startsWith('refs/heads/')) localHeads.add(refName.slice(11))
      else if (refName.startsWith('refs/remotes/origin/') && refName !== 'refs/remotes/origin/HEAD') {
        originHeads.add(refName.slice(20))
      }
    }
  }
  return {
    originHeadBranch,
    tags: [...tagSet].sort(),
    localBranches: [...localHeads].sort(),
    remoteOriginBranches: [...originHeads].sort(),
    localHeads,
    originHeads,
  }
}

/** 零子进程读取 loose/packed refs 推导默认分支（reftable 仓或 strict 模式下无可用引用时返回 null）。 */
export function readRefsFast(gitCommonDir, curBranch, initDefaultBranch, { strict = true } = {}) {
  const refs = listRefsFast(gitCommonDir)
  if (!refs) return null
  if (refs.originHeadBranch) return refs.originHeadBranch
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (refs.localHeads.has(cand) || refs.originHeads.has(cand)) return cand
  }
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return strict ? null : (initDefaultBranch || 'main')
}

/** 零子进程解析仓库默认分支（遇到 reftable 或缺失 .git 时返回 null 交由 CLI 回退）。 */
export function resolveDefaultBranchFast(repoRoot, gitCommonDir = null, { strict = true } = {}) {
  const wtGitDir = resolveGitDirFast(repoRoot)
  if (!wtGitDir) return null
  let commonDir = gitCommonDir
  if (!commonDir) {
    const commondirTxt = readTextSafe(join(wtGitDir, 'commondir'))
    commonDir = commondirTxt ? resolve(wtGitDir, commondirTxt.trim()) : wtGitDir
  }
  if (existsSync(join(commonDir, 'reftable'))) return null
  const headInfo = readHeadFast(wtGitDir, commonDir)
  if (!headInfo) return null
  const cfg = readGitConfigFast(commonDir)
  const curBranch = headInfo.detached ? 'HEAD' : headInfo.branch
  return readRefsFast(commonDir, curBranch, cfg?.initDefaultBranch, { strict })
}


/**
 * 零子进程遍历小于 `maxCommits` 的线性松散提交历史（仅当完整走到根提交且无合并/编码覆写/mailmap/replace 时命中，否则返回 null）。
 */
export function readLooseCommitLogFast(repoRoot, gitCommonDir, headOid, maxCommits = 20) {
  if (!gitCommonDir || !headOid || !/^[0-9a-f]{40}$/i.test(headOid)) return null
  if (existsSync(join(gitCommonDir, 'reftable'))
    || existsSync(join(gitCommonDir, 'shallow'))
    || existsSync(join(gitCommonDir, 'refs', 'replace'))
    || (repoRoot && existsSync(join(repoRoot, '.mailmap')))) {
    return null
  }
  const entries = []
  let cur = headOid
  let complete = false
  for (let i = 0; i < maxCommits; i += 1) {
    const obj = readGitObjectFast(gitCommonDir, cur)
    if (!obj || obj.type !== 'commit') return null
    const text = obj.bodyBuf.toString('utf8').replace(/\r\n/g, '\n')
    const sep = text.indexOf('\n\n')
    if (sep < 0) return null
    const hdr = text.slice(0, sep)
    if (/^(?:encoding|gpgsig)\s/m.test(hdr)) return null
    const parents = []
    for (const m of hdr.matchAll(/^parent ([0-9a-f]{40})$/gm)) parents.push(m[1])
    if (parents.length > 1) break
    const authM = /^author (.+? <[^>]*>) \d+ [+-]\d{4}$/m.exec(hdr)
    if (!authM) return null
    const body = text.slice(sep + 2)
    const nextBlank = body.indexOf('\n\n')
    const firstPara = (nextBlank >= 0 ? body.slice(0, nextBlank) : body).replace(/\n+$/, '')
    if (firstPara.includes('\n')) return null
    entries.push({ oid: cur, author: authM[1], parents: parents.join(' '), subject: firstPara })
    if (parents.length === 0) {
      complete = true
      break
    }
    cur = parents[0]
  }
  if (entries.length === 0) return null
  return { complete, entries }
}


const immutableDiffCache = new Map()
const immutableNsCache = new Map()
const rangeDiffCache = new Map()

export function getCachedNameStatus(cwd, diffArgs) {
  if (!Array.isArray(diffArgs) || diffArgs.length !== 1) return null
  const m = /^([0-9a-f]{40,64})\.\.([0-9a-f]{40,64}|HEAD)$/i.exec(String(diffArgs[0] ?? ''))
  if (!m) return null
  const wtGitDir = resolveGitDirFast(cwd)
  if (!wtGitDir) return null
  const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
  const commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir
  if (existsSync(join(commonDir, 'refs', 'replace'))) return null
  const headSha = m[2].toUpperCase() === 'HEAD' ? readHeadFast(wtGitDir, commonDir)?.oid : m[2]
  if (!headSha || !/^[0-9a-f]{40,64}$/i.test(headSha)) return null
  if (m[1] === headSha) return { hit: { ok: true, entries: [], stderr: '' }, key: null }
  const key = `${commonDir}\0${m[1]}\0${headSha}`
  const diffHit = immutableDiffCache.get(key)
  if (diffHit?.ok) return { hit: { ok: true, entries: diffHit.entries, stderr: '' }, key }
  const nsHit = immutableNsCache.get(key)
  if (nsHit?.ok) return { hit: nsHit, key }
  return { hit: null, key }
}

export function setCachedNameStatus(key, res) {
  if (!key || !res?.ok) return
  if (immutableNsCache.size >= 32) immutableNsCache.clear()
  immutableNsCache.set(key, res)
}

export function getCachedRangeDiffCommits(gitCommonDir, oldRange, newRange) {
  if (!gitCommonDir || !oldRange || !newRange) return null
  return rangeDiffCache.get(`${gitCommonDir}\0${oldRange}\0${newRange}`) ?? null
}

export function setCachedRangeDiffCommits(gitCommonDir, oldRange, newRange, commits) {
  if (!gitCommonDir || !oldRange || !newRange || !Array.isArray(commits)) return
  if (rangeDiffCache.size >= 16) rangeDiffCache.clear()
  rangeDiffCache.set(`${gitCommonDir}\0${oldRange}\0${newRange}`, commits)
}

export function getCachedCommitDiff(gitCommonDir, baseSha, headSha) {
  if (!gitCommonDir || !baseSha || !headSha) return null
  if (existsSync(join(gitCommonDir, 'refs', 'replace'))) return null
  return immutableDiffCache.get(`${gitCommonDir}\0${baseSha}\0${headSha}`) ?? null
}

export function setCachedCommitDiff(gitCommonDir, baseSha, headSha, res) {
  if (!gitCommonDir || !baseSha || !headSha || !res?.ok) return
  if (existsSync(join(gitCommonDir, 'refs', 'replace'))) return
  const key = `${gitCommonDir}\0${baseSha}\0${headSha}`
  if (immutableDiffCache.size >= 32) immutableDiffCache.clear()
  immutableDiffCache.set(key, res)
}

