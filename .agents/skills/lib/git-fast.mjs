/**
 * git-fast.mjs —— 零子进程 Git 配置、Ref 解析与 porcelain=v2 增量解析原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 flow-inspect / git / ledger 共用。
 */

import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

import { prepareExecInvocation } from './exec.mjs'
import { LIKELY_DEFAULT_BRANCHES, posixPath, readTextSafe } from './git.mjs'

/** 快速向上探测是否存在祖先 `.git` 目录/文件（无环境覆盖且无 `.git` 时跳过 `git rev-parse` 子进程）。 */
export function hasDotGitInAncestors(startDir) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return true
  const absStart = resolve(String(startDir ?? '.'))
  if (existsSync(join(absStart, 'HEAD')) && existsSync(join(absStart, 'config'))) return true
  let cur = absStart
  while (true) {
    if (existsSync(join(cur, '.git'))) return true
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
}

/** 零子进程解析 Git index v2/v3 全部已跟踪路径集合（reftable/v4/sha256/异常返回 null）。 */
export function readGitIndexPathsFast(repoRoot) {
  const wtGitDir = resolveGitDirFast(repoRoot)
  if (!wtGitDir) return null
  const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
  const commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir
  if (existsSync(join(commonDir, 'reftable'))) return null
  const cfgTxt = readTextSafe(join(commonDir, 'config')) ?? ''
  if (/^\s*objectformat\s*=\s*sha256\b/im.test(cfgTxt)) return null
  const idxPath = join(wtGitDir, 'index')
  if (!existsSync(idxPath)) return new Set()
  let buf
  try { buf = readFileSync(idxPath) } catch { return null }
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'DIRC') return null
  const ver = buf.readUInt32BE(4)
  if (ver !== 2 && ver !== 3) return null
  const count = buf.readUInt32BE(8)
  const paths = new Set()
  let off = 12
  for (let i = 0; i < count; i += 1) {
    if (off + 62 >= buf.length) return null
    const flags = buf.readUInt16BE(off + 60)
    if ((flags & 0x3000) !== 0) return null
    let nameOff = off + 62
    if (ver >= 3 && (flags & 0x4000) !== 0) {
      if (nameOff + 2 >= buf.length) return null
      nameOff += 2
    }
    const nul = buf.indexOf(0, nameOff)
    if (nul < 0) return null
    paths.add(buf.toString('utf8', nameOff, nul))
    const len = nul - off + 1
    off += (len + 7) & ~7
  }
  if (off > buf.length - 20) return null
  while (off + 8 <= buf.length - 20) {
    const sig = buf.toString('ascii', off, off + 4)
    if (!/^[A-Za-z]{4}$/.test(sig) || sig === 'link' || sig === 'sdir') return null
    off += 8 + buf.readUInt32BE(off + 4)
  }
  return off === buf.length - 20 ? paths : null
}

/** 零子进程检查相对路径是否在 Git index v2/v3 中已跟踪（reftable/v4/异常返回 null 交由 CLI 回退）。 */
export function isPathInGitIndexFast(repoRoot, relPath) {
  const paths = readGitIndexPathsFast(repoRoot)
  if (!paths) return null
  const target = posixPath(relPath).replace(/^\.\//, '').replace(/^\/+/, '')
  return paths.has(target)
}

/**
 * 零子进程检查 Git index v2/v3 是否存在未解决冲突条目（stage > 0）。
 * 确认无冲突返回 `false`，存在冲突返回 `true`，无 index 或非 v2/v3/异常格式返回 `null`（交由 git CLI 回退）。
 */
export function hasUnmergedIndexFast(wtGitDir) {
  if (!wtGitDir) return null
  const idxPath = join(wtGitDir, 'index')
  if (!existsSync(idxPath)) return false
  let buf
  try { buf = readFileSync(idxPath) } catch { return null }
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'DIRC') return null
  const ver = buf.readUInt32BE(4)
  if (ver !== 2 && ver !== 3) return null
  const count = buf.readUInt32BE(8)
  let off = 12
  for (let i = 0; i < count; i += 1) {
    if (off + 62 >= buf.length) return null
    const flags = buf.readUInt16BE(off + 60)
    if ((flags & 0x3000) !== 0) return true
    let nameOff = off + 62
    if (ver >= 3 && (flags & 0x4000) !== 0) {
      if (nameOff + 2 >= buf.length) return null
      nameOff += 2
    }
    const nul = buf.indexOf(0, nameOff)
    if (nul < 0) return null
    const len = nul - off + 1
    off += (len + 7) & ~7
  }
  if (off > buf.length - 20) return null
  while (off + 8 <= buf.length - 20) {
    const sig = buf.toString('ascii', off, off + 4)
    if (!/^[A-Za-z]{4}$/.test(sig) || sig === 'link' || sig === 'sdir') return null
    off += 8 + buf.readUInt32BE(off + 4)
  }
  return off === buf.length - 20 ? false : null
}

/** 零子进程解析当前工作区 `.git` 目录（兼容普通仓与 linked worktree）。 */
export function resolveGitDirFast(repoRoot) {
  if (!repoRoot) return null
  const dotGit = join(repoRoot, '.git')
  if (!existsSync(dotGit)) return null
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (m) return resolve(repoRoot, m[1].trim())
    }
  } catch { /* ignore */ }
  return null
}

/** 解析 `git status --porcelain=v2 --branch -z` 输出。 */
export function parsePorcelainV2BranchZ(buf) {
  const tokens = Buffer.isBuffer(buf) ? buf.toString('utf8').split('\0') : String(buf ?? '').split('\0')
  let head = null
  let branch = null
  let dirty = 0
  const conflicts = []
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.startsWith('# branch.oid ')) {
      const val = tok.slice(13).trim()
      head = val && val !== '(initial)' ? val : null
    } else if (tok.startsWith('# branch.head ')) {
      const val = tok.slice(14).trim()
      branch = val || null
    } else if (!tok.startsWith('#')) {
      dirty += 1
      if (tok.startsWith('u ')) {
        const parts = tok.split(' ')
        const file = parts.slice(10).join(' ')
        if (file) conflicts.push(file)
      }
      if (tok.startsWith('2 ')) i += 1
    }
  }
  if (branch === '(detached)' && !head) branch = null
  return { head, branch, dirty, conflicts }
}

/** 从 `for-each-ref` 输出推算默认分支。 */
export function resolveDefaultBranchFromRefs(refsStdout, curBranch, initDefaultBranch) {
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
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (localHeads.has(cand) || originHeads.has(cand)) return cand
  }
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return initDefaultBranch || 'main'
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

export function readSystemGitConfigMapFast() {
  if (cachedSysConfigMap !== undefined) return cachedSysConfigMap
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
  const localCfg = readTextSafe(join(gitCommonDir, 'config'))
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

/** 零子进程读取 loose/packed refs 推导默认分支（reftable 仓返回 null）。 */
export function readRefsFast(gitCommonDir, curBranch, initDefaultBranch) {
  if (!gitCommonDir || existsSync(join(gitCommonDir, 'reftable'))) return null
  const origHeadPath = join(gitCommonDir, 'refs', 'remotes', 'origin', 'HEAD')
  const origHeadText = readTextSafe(origHeadPath)
  if (origHeadText) {
    const m = /^ref:\s*refs\/remotes\/origin\/(.+)$/im.exec(origHeadText.trim())
    if (m) return m[1].trim()
  }
  const localHeads = new Set()
  const originHeads = new Set()
  const scanLoose = (dirAbs, bucket) => {
    if (!existsSync(dirAbs)) return
    const stack = [{ abs: dirAbs, rel: '' }]
    while (stack.length > 0) {
      const cur = stack.pop()
      let entries = []
      try { entries = readdirSync(cur.abs, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const name = cur.rel ? `${cur.rel}/${e.name}` : e.name
        if (e.isDirectory()) stack.push({ abs: join(cur.abs, e.name), rel: name })
        else if (e.isFile() && name !== 'HEAD') bucket.add(name)
      }
    }
  }
  scanLoose(join(gitCommonDir, 'refs', 'heads'), localHeads)
  scanLoose(join(gitCommonDir, 'refs', 'remotes', 'origin'), originHeads)
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs'))
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const refName = line.slice(sp + 1).trim()
      if (refName.startsWith('refs/heads/')) localHeads.add(refName.slice(11))
      else if (refName.startsWith('refs/remotes/origin/')) {
        const n = refName.slice(20)
        if (n !== 'HEAD') originHeads.add(n)
      }
    }
  }
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (localHeads.has(cand) || originHeads.has(cand)) return cand
  }
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return initDefaultBranch || 'main'
}

/** 零子进程解析仓库默认分支（遇到 reftable 或缺失 .git 时返回 null 交由 CLI 回退）。 */
export function resolveDefaultBranchFast(repoRoot, gitCommonDir = null) {
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
  return readRefsFast(commonDir, curBranch, cfg?.initDefaultBranch)
}

/** 零子进程读取松散 Git 对象（自动解析 worktree commondir；仅 SHA-1 40 hex，packed/缺失返回 null）。 */
export function readGitObjectFast(gitDirOrCommonDir, sha) {
  if (!gitDirOrCommonDir || !sha || !/^[0-9a-f]{40}$/i.test(sha)) return null
  const cdTxt = readTextSafe(join(gitDirOrCommonDir, 'commondir'))
  const commonDir = cdTxt ? resolve(gitDirOrCommonDir, cdTxt.trim()) : gitDirOrCommonDir
  const low = sha.toLowerCase()
  const objPath = join(commonDir, 'objects', low.slice(0, 2), low.slice(2))
  if (!existsSync(objPath)) return null
  try {
    const raw = inflateSync(readFileSync(objPath))
    const nul = raw.indexOf(0)
    if (nul <= 0) return null
    const hdr = raw.subarray(0, nul).toString('ascii')
    const sp = hdr.indexOf(' ')
    if (sp <= 0) return null
    const type = hdr.slice(0, sp)
    const size = Number(hdr.slice(sp + 1))
    const bodyBuf = raw.subarray(nul + 1)
    if (!Number.isFinite(size) || bodyBuf.length !== size) return null
    return { type, bodyBuf }
  } catch {
    return null
  }
}

/** 零子进程读取松散 blob 文本内容（packed 或缺失返回 null）。 */
export function readGitBlobTextFast(gitCommonDir, sha) {
  const obj = readGitObjectFast(gitCommonDir, sha)
  if (!obj || obj.type !== 'blob') return null
  return obj.bodyBuf.toString('utf8').replace(/\r\n/g, '\n')
}

/** 零子进程检查仓库是否存在任意 tag（reftable 或异常返回 null 交由 CLI 回退）。 */
export function hasAnyTagFast(gitCommonDir) {
  if (!gitCommonDir || existsSync(join(gitCommonDir, 'reftable'))) return null
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs'))
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp > 0 && line.slice(sp + 1).trim().startsWith('refs/tags/')) return true
    }
  }
  const tagsRoot = join(gitCommonDir, 'refs', 'tags')
  if (!existsSync(tagsRoot)) return false
  const stack = [tagsRoot]
  while (stack.length > 0) {
    const cur = stack.pop()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { return null }
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(cur, e.name))
      else if (e.isFile()) return true
    }
  }
  return false
}

/** 零子进程读取 loose reflog 条目列表（最新在先，缺失或 reftable 返回 null）。 */
export function readReflogFast(gitCommonDir, fullRef) {
  if (!gitCommonDir || !fullRef || existsSync(join(gitCommonDir, 'reftable'))) return null
  const logPath = join(gitCommonDir, 'logs', ...String(fullRef).replace(/^\/+/, '').split('/'))
  const txt = readTextSafe(logPath)
  if (txt === undefined) return null
  const subjects = []
  for (const line of txt.split('\n')) {
    if (!line) continue
    const tab = line.indexOf('\t')
    if (tab >= 0) subjects.push(line.slice(tab + 1))
  }
  subjects.reverse()
  return subjects
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
    if (parents.length > 1) return null
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
  return complete ? { complete: true, entries } : null
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

/** 计算 `git diff --raw` 补丁主体从 `diff --git ` 起的 SHA-256 与字节长（与 `collectDiff` 字节一致）。 */
export function computePatchRawDigest(fullBuf) {
  const buf = Buffer.isBuffer(fullBuf) ? fullBuf : Buffer.alloc(0)
  const at = buf.subarray(0, 11).toString('ascii') === 'diff --git '
    ? 0
    : (() => {
        const nlIdx = buf.indexOf('\ndiff --git ')
        return nlIdx >= 0 ? nlIdx + 1 : -1
      })()
  const rawBuf = at >= 0 ? buf.subarray(at) : Buffer.alloc(0)
  return {
    sha256: createHash('sha256').update(rawBuf).digest('hex'),
    bytes: rawBuf.length,
  }
}

/**
 * 零子进程沿有限 DAG 祖先探测 `ancestorSha` 是否为 `descendantSha` 祖先；
 * 仅在严格确认命中或穷尽全部祖先到达根时返回 boolean，遇到 packed/超深/reftable 返回 `null` 交由 CLI 回退。
 */
export function isAncestorLinearFast(gitCommonDir, ancestorSha, descendantSha, maxDepth = 40) {
  if (!gitCommonDir || !ancestorSha || !descendantSha) return null
  if (!/^[0-9a-f]{40}$/i.test(ancestorSha) || !/^[0-9a-f]{40}$/i.test(descendantSha)) return null
  const ancLow = ancestorSha.toLowerCase()
  const descLow = descendantSha.toLowerCase()
  if (ancLow === descLow) return true
  if (existsSync(join(gitCommonDir, 'reftable')) || existsSync(join(gitCommonDir, 'shallow'))) return null

  const seen = new Set()
  const queue = [descLow]
  while (queue.length > 0) {
    const cur = queue.pop()
    if (seen.has(cur)) continue
    if (seen.size >= maxDepth) return null
    const obj = readGitObjectFast(gitCommonDir, cur)
    if (!obj || obj.type !== 'commit') return null
    seen.add(cur)
    const raw = obj.bodyBuf.toString('utf8')
    const sep = raw.indexOf('\n\n')
    const hdr = sep >= 0 ? raw.slice(0, sep) : raw
    for (const m of hdr.matchAll(/^parent ([0-9a-f]{40})$/gm)) {
      const p = m[1].toLowerCase()
      if (p === ancLow) return true
      if (!seen.has(p)) queue.push(p)
    }
  }
  return false
}

/** 零子进程收集不超过 `maxCommits` 个提交的完整可达祖先 SHA 集合（超限/packed/shallow 返回 null）。 */
export function collectAncestorsDagFast(gitCommonDir, tipSha, maxCommits = 60) {
  if (!gitCommonDir || !tipSha || !/^[0-9a-f]{40}$/i.test(tipSha)) return null
  if (existsSync(join(gitCommonDir, 'reftable')) || existsSync(join(gitCommonDir, 'shallow'))) return null
  const seen = new Set()
  const queue = [tipSha.toLowerCase()]
  while (queue.length > 0) {
    const cur = queue.pop()
    if (seen.has(cur)) continue
    if (seen.size >= maxCommits) return null
    const obj = readGitObjectFast(gitCommonDir, cur)
    if (!obj || obj.type !== 'commit') return null
    seen.add(cur)
    const raw = obj.bodyBuf.toString('utf8')
    const sep = raw.indexOf('\n\n')
    const hdr = sep >= 0 ? raw.slice(0, sep) : raw
    for (const m of hdr.matchAll(/^parent ([0-9a-f]{40})$/gm)) {
      const p = m[1].toLowerCase()
      if (!seen.has(p)) queue.push(p)
    }
  }
  return seen
}

/** 零子进程等价计算 `git rev-list --count baseSha..targetSha`（仅当两端祖先 DAG 均 <= maxCommits 且全松散时命中）。 */
export function countCommitsAheadDagFast(gitCommonDir, baseSha, targetSha, maxCommits = 60) {
  const targetAnc = collectAncestorsDagFast(gitCommonDir, targetSha, maxCommits)
  if (!targetAnc) return null
  const baseAnc = collectAncestorsDagFast(gitCommonDir, baseSha, maxCommits)
  if (!baseAnc) return null
  let count = 0
  for (const s of targetAnc) if (!baseAnc.has(s)) count += 1
  return count
}

/** 零子进程沿 first-parent 链读取前 `limit` 个提交 SHA（等同 `git rev-list --first-parent -n limit`）。 */
export function readFirstParentsFast(gitCommonDir, tipSha, limit = 200) {
  if (!gitCommonDir || !tipSha || !/^[0-9a-f]{40}$/i.test(tipSha)) return null
  if (existsSync(join(gitCommonDir, 'reftable')) || existsSync(join(gitCommonDir, 'shallow'))) return null
  const set = new Set()
  let cur = tipSha.toLowerCase()
  for (let i = 0; i < limit && cur; i += 1) {
    const obj = readGitObjectFast(gitCommonDir, cur)
    if (!obj || obj.type !== 'commit') return null
    set.add(cur)
    const raw = obj.bodyBuf.toString('utf8')
    const sep = raw.indexOf('\n\n')
    const hdr = sep >= 0 ? raw.slice(0, sep) : raw
    const pm = /^parent ([0-9a-f]{40})$/m.exec(hdr)
    cur = pm ? pm[1].toLowerCase() : null
  }
  return set
}
