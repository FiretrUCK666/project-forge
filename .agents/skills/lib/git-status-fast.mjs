/**
 * git-status-fast.mjs —— 零子进程纯 Node 干净工作区密码级核验原语。
 *
 * 仅在完全确认 `index == HEAD tree`、工作区全部已跟踪文件内容 SHA-1（兼容 autocrlf）
 * 一致且零未忽略新文件时返回 `{ clean: true }`；遇到任何脏态、racy/特殊配置、
 * `.gitattributes`、复杂忽略、submodule、reftable 或大仓库一律返回 `null` 回退真实 `git status`。
 */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { canonicalPath, posixPath, readTextSafe } from './git.mjs'
import { readGitObjectFast, readHeadFast, readSystemGitConfigMapFast, resolveGitDirFast } from './git-fast.mjs'

function readCoreSettingsFast(commonDir, targetBranch) {
  if (process.env.GIT_CONFIG_GLOBAL || process.env.GIT_CONFIG_SYSTEM || process.env.GIT_CONFIG_COUNT) return null
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const globalPaths = [join(homedir(), '.gitconfig'), join(xdg, 'git', 'config')]
  let globalCfg = ''
  for (const gp of globalPaths) {
    const txt = readTextSafe(gp)
    if (txt) { globalCfg = txt; break }
  }
  const localCfg = readTextSafe(join(commonDir, 'config')) ?? ''
  if (/^\s*\[(?:include|includeif)\b/im.test(`${globalCfg}\n${localCfg}`)) return null

  const core = {}
  for (const [k, v] of readSystemGitConfigMapFast().entries()) {
    if (k.startsWith('core.')) core[k] = v
  }
  let hasUpstream = false
  const branchSecLower = targetBranch ? targetBranch.toLowerCase() : null

  for (const cfg of [globalCfg, localCfg]) {
    let curSec = ''
    let curSub = ''
    for (const raw of cfg.split('\n')) {
      const line = raw.replace(/(?:^|\s)[;#].*$/, '').trim()
      if (!line) continue
      const sec = /^\[([a-z0-9-]+)(?:\s+"(.*)")?\]$/i.exec(line)
      if (sec) { curSec = sec[1].toLowerCase(); curSub = sec[2] ?? ''; continue }
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      if (curSec === 'core') core[`core.${k}`] = v
      else if (curSec === 'branch' && branchSecLower && curSub.toLowerCase() === branchSecLower) {
        if (k === 'remote' || k === 'merge') hasUpstream = true
      }
    }
  }
  if (core['core.excludesfile'] || core['core.attributesfile']) return null
  const autocrlf = String(core['core.autocrlf'] ?? 'false').toLowerCase()
  if (autocrlf === 'input') return null
  return {
    autocrlf: autocrlf === 'true',
    filemode: String(core['core.filemode'] ?? (process.platform === 'win32' ? 'false' : 'true')).toLowerCase() !== 'false',
    hasUpstream,
  }
}

function parseIndexFullFast(idxPath) {
  let buf
  try { buf = readFileSync(idxPath) } catch { return null }
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'DIRC') return null
  const ver = buf.readUInt32BE(4)
  if (ver !== 2 && ver !== 3) return null
  const count = buf.readUInt32BE(8)
  if (count > 250) return null

  const entries = []
  let off = 12
  for (let i = 0; i < count; i += 1) {
    if (off + 62 >= buf.length) return null
    const ctimeS = buf.readUInt32BE(off)
    const mtimeS = buf.readUInt32BE(off + 8)
    const mode = buf.readUInt32BE(off + 24)
    const size = buf.readUInt32BE(off + 36)
    const shaHex = buf.subarray(off + 40, off + 60).toString('hex')
    const flags = buf.readUInt16BE(off + 60)
    if ((flags & 0xB000) !== 0) return null
    if (mode !== 0o100644 && mode !== 0o100755) return null
    let nameOff = off + 62
    if (ver >= 3 && (flags & 0x4000) !== 0) {
      if (nameOff + 2 >= buf.length) return null
      if ((buf.readUInt16BE(nameOff) & 0x6000) !== 0) return null
      nameOff += 2
    }
    const nul = buf.indexOf(0, nameOff)
    if (nul < 0) return null
    entries.push({ ctimeS, mtimeS, mode, size, shaHex, path: buf.toString('utf8', nameOff, nul) })
    const len = nul - off + 1
    off += (len + 7) & ~7
  }
  return entries
}

function collectHeadTreeMap(commonDir, treeSha, prefix = '', out = new Map()) {
  const obj = readGitObjectFast(commonDir, treeSha)
  if (!obj || obj.type !== 'tree') return null
  const buf = obj.bodyBuf
  let off = 0
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off)
    if (sp <= off) return null
    const mode = parseInt(buf.subarray(off, sp).toString('ascii'), 8)
    const nul = buf.indexOf(0, sp + 1)
    if (nul < 0 || nul + 21 > buf.length) return null
    const name = buf.subarray(sp + 1, nul).toString('utf8')
    const shaHex = buf.subarray(nul + 1, nul + 21).toString('hex')
    off = nul + 21
    const rel = prefix ? `${prefix}/${name}` : name
    if (mode === 0o40000) {
      if (!collectHeadTreeMap(commonDir, shaHex, rel, out)) return null
    } else {
      out.set(rel, { mode, shaHex })
      if (out.size > 250) return null
    }
  }
  return out
}

function sha1Blob(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex')
}

function stripCrLfBytes(buf) {
  const out = Buffer.allocUnsafe(buf.length)
  let j = 0
  for (let i = 0; i < buf.length; i += 1) {
    if (buf[i] === 13 && i + 1 < buf.length && buf[i + 1] === 10) continue
    out[j++] = buf[i]
  }
  return out.subarray(0, j)
}

function compileIgnoreRules(repoRoot, commonDir) {
  const rules = []
  for (const file of [join(repoRoot, '.gitignore'), join(commonDir, 'info', 'exclude')]) {
    const txt = readTextSafe(file)
    if (!txt) continue
    for (const rawLine of txt.split('\n')) {
      const line = rawLine.replace(/\r$/, '').trim()
      if (!line || line.startsWith('#')) continue
      if (/[!\\[\]?]/.test(line) || line.includes('**')) return null
      const dirOnly = line.endsWith('/')
      const anchored = line.startsWith('/') || line.slice(0, -1).includes('/')
      const clean = line.replace(/^\/+/, '').replace(/\/+$/, '')
      if (!clean) continue
      if (clean.includes('*')) {
        const starM = /^\*\.([A-Za-z0-9_.-]+)$/.exec(clean)
        if (!starM || anchored) return null
        rules.push({ kind: 'ext', suffix: `.${starM[1]}`, dirOnly })
      } else {
        rules.push({ kind: 'exact', clean, anchored, dirOnly })
      }
    }
  }
  return (rel, isDir) => {
    const leaf = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue
      if (r.kind === 'ext') {
        if (leaf.endsWith(r.suffix)) return true
      } else if (r.anchored) {
        if (rel === r.clean) return true
      } else if (leaf === r.clean) {
        return true
      }
    }
    return false
  }
}

/** 零子进程核验当前工作区是否完全干净；任何不满足严格前提或存在改动的情况返回 `null`。 */
export function isCleanWorktreeFast(repoRoot, { needIgnored = false } = {}) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return null
  const wtGitDir = resolveGitDirFast(repoRoot)
  if (!wtGitDir) return null
  const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
  const commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir

  if (existsSync(join(commonDir, 'reftable'))
    || existsSync(join(commonDir, 'shallow'))
    || existsSync(join(wtGitDir, 'index.lock'))
    || existsSync(join(wtGitDir, 'MERGE_HEAD'))
    || existsSync(join(wtGitDir, 'REBASE_HEAD'))
    || existsSync(join(wtGitDir, 'rebase-merge'))
    || existsSync(join(wtGitDir, 'rebase-apply'))
    || existsSync(join(wtGitDir, 'CHERRY_PICK_HEAD'))
    || existsSync(join(wtGitDir, 'REVERT_HEAD'))
    || existsSync(join(wtGitDir, 'BISECT_LOG'))
    || existsSync(join(repoRoot, '.gitmodules'))) {
    return null
  }
  const gaPath = join(repoRoot, '.gitattributes')
  if (existsSync(gaPath)) {
    const gaTxt = readTextSafe(gaPath)
    if (gaTxt === undefined || /(?:filter|working-tree-encoding|ident)\s*=|\beol=crlf\b/i.test(gaTxt)) return null
  }
  const infoAttrs = readTextSafe(join(commonDir, 'info', 'attributes'))
  if (infoAttrs && infoAttrs.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) return null

  const headInfo = readHeadFast(wtGitDir, commonDir)
  if (!headInfo || !headInfo.oid) return null
  const core = readCoreSettingsFast(commonDir, headInfo.detached ? null : headInfo.branch)
  if (!core) return null

  const cfgTxt = readTextSafe(join(commonDir, 'config')) ?? ''
  if (/^\s*objectformat\s*=\s*sha256\b/im.test(cfgTxt)) return null

  const idxPath = join(wtGitDir, 'index')
  const entries = parseIndexFullFast(idxPath)
  if (!entries) return null
  let idxMtimeS = Math.floor(Date.now() / 1000)
  try { idxMtimeS = Math.floor(lstatSync(idxPath).mtimeMs / 1000) } catch { return null }

  const headCommit = readGitObjectFast(commonDir, headInfo.oid)
  if (!headCommit || headCommit.type !== 'commit') return null
  const treeM = /^tree ([0-9a-f]{40})$/m.exec(headCommit.bodyBuf.toString('utf8'))
  if (!treeM) return null
  const headMap = collectHeadTreeMap(commonDir, treeM[1])
  if (!headMap || headMap.size !== entries.length) return null

  const indexSet = new Set()
  const trackedDirs = new Set()
  for (const e of entries) {
    if (e.path.includes('/') && e.path.endsWith('/.gitignore')) return null
    const he = headMap.get(e.path)
    if (!he || he.mode !== e.mode || he.shaHex !== e.shaHex) return null
    indexSet.add(e.path)
    let slash = e.path.indexOf('/')
    while (slash > 0) {
      trackedDirs.add(e.path.slice(0, slash))
      slash = e.path.indexOf('/', slash + 1)
    }

    const abs = join(repoRoot, e.path)
    let st
    try { st = lstatSync(abs) } catch { return null }
    if (!st.isFile() || st.isSymbolicLink() || st.size !== e.size) return null
    if (core.filemode) {
      const execMode = (st.mode & 0o111) ? 0o100755 : 0o100644
      if (execMode !== e.mode) return null
    }
    const diskMtimeS = Math.floor(st.mtimeMs / 1000)
    const diskCtimeS = Math.floor(st.ctimeMs / 1000)
    const safeCachedStat = diskMtimeS === e.mtimeS && diskCtimeS === e.ctimeS && e.mtimeS + 2 < idxMtimeS
    if (!safeCachedStat) {
      let fBuf
      try { fBuf = readFileSync(abs) } catch { return null }
      if (sha1Blob(fBuf) !== e.shaHex) {
        if (!core.autocrlf || fBuf.subarray(0, 8192).includes(0) || !fBuf.includes(13)) return null
        const blobObj = readGitObjectFast(commonDir, e.shaHex)
        if (!blobObj || blobObj.type !== 'blob' || blobObj.bodyBuf.includes(13)) return null
        if (sha1Blob(stripCrLfBytes(fBuf)) !== e.shaHex) return null
      }
    }
  }

  const isIgnored = compileIgnoreRules(repoRoot, commonDir)
  if (!isIgnored) return null

  const ignored = []
  let visited = 0
  const stack = [{ abs: repoRoot, rel: '' }]
  while (stack.length > 0) {
    const cur = stack.pop()
    let dirEntries
    try { dirEntries = readdirSync(cur.abs, { withFileTypes: true }) } catch { return null }
    for (const de of dirEntries) {
      if (de.name === '.git') {
        if (cur.rel !== '') return null
        continue
      }
      visited += 1
      if (visited > 250) return null
      const rel = posixPath(cur.rel ? `${cur.rel}/${de.name}` : de.name)
      if (de.isSymbolicLink()) {
        if (isIgnored(rel, true) && !indexSet.has(rel) && !trackedDirs.has(rel)) {
          if (needIgnored) ignored.push(rel)
          continue
        }
        return null
      }
      if (de.isDirectory()) {
        if (isIgnored(rel, true)) {
          if (trackedDirs.has(rel)) return null
          if (needIgnored) ignored.push(rel)
          continue
        }
        stack.push({ abs: join(cur.abs, de.name), rel })
      } else if (de.isFile()) {
        if (cur.rel && de.name === '.gitignore') return null
        if (indexSet.has(rel)) continue
        if (isIgnored(rel, false)) {
          if (needIgnored) ignored.push(rel)
          continue
        }
        return null
      }
    }
  }

  return {
    clean: true,
    headInfo,
    hasUpstream: core.hasUpstream,
    ignored: needIgnored ? ignored.sort() : [],
  }
}

/** 确认当前仓未配置 `core.excludesfile`（返回 true 表示可跳过全局忽略探针；存疑返回 false）。 */
export function hasNoGlobalExcludesFast(commonDir) {
  if (!commonDir) return false
  return readCoreSettingsFast(commonDir, null) !== null
}

/**
 * 零子进程估算 `survey` 所需状态（支持 unborn 与仅含未暂存/未跟踪改动的小仓）；
 * 遇 staged 变更、复杂规则、upstream 跟踪或异常时返回 `null` 回退真实 `git status --porcelain=v2`。
 */
export function inspectSurveyStatusFast(repoRoot) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return null
  const wtGitDir = resolveGitDirFast(repoRoot)
  if (!wtGitDir) return null
  const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
  const commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir

  if (existsSync(join(commonDir, 'reftable'))
    || existsSync(join(commonDir, 'shallow'))
    || existsSync(join(wtGitDir, 'index.lock'))
    || existsSync(join(wtGitDir, 'MERGE_HEAD'))
    || existsSync(join(wtGitDir, 'REBASE_HEAD'))
    || existsSync(join(wtGitDir, 'rebase-merge'))
    || existsSync(join(wtGitDir, 'rebase-apply'))
    || existsSync(join(wtGitDir, 'CHERRY_PICK_HEAD'))
    || existsSync(join(wtGitDir, 'REVERT_HEAD'))
    || existsSync(join(wtGitDir, 'BISECT_LOG'))
    || existsSync(join(repoRoot, '.gitmodules'))) {
    return null
  }
  const gaPath = join(repoRoot, '.gitattributes')
  if (existsSync(gaPath)) {
    const gaTxt = readTextSafe(gaPath)
    if (gaTxt === undefined || /(?:filter|working-tree-encoding|ident)\s*=|\beol=crlf\b/i.test(gaTxt)) return null
  }
  const infoAttrs = readTextSafe(join(commonDir, 'info', 'attributes'))
  if (infoAttrs && infoAttrs.split('\n').some((l) => l.trim() && !l.trim().startsWith('#'))) return null

  const headInfo = readHeadFast(wtGitDir, commonDir)
  if (!headInfo) return null
  const core = readCoreSettingsFast(commonDir, headInfo.detached ? null : headInfo.branch)
  if (!core || core.hasUpstream) return null
  const cfgTxt = readTextSafe(join(commonDir, 'config')) ?? ''
  if (/^\s*objectformat\s*=\s*sha256\b/im.test(cfgTxt)) return null

  const idxPath = join(wtGitDir, 'index')
  const indexSet = new Set()
  const trackedDirs = new Set()
  let dirty = 0

  if (!headInfo.oid) {
    if (existsSync(idxPath)) return null
  } else {
    const entries = parseIndexFullFast(idxPath)
    if (!entries) return null
    let idxMtimeS = Math.floor(Date.now() / 1000)
    try { idxMtimeS = Math.floor(lstatSync(idxPath).mtimeMs / 1000) } catch { return null }

    const headCommit = readGitObjectFast(commonDir, headInfo.oid)
    if (!headCommit || headCommit.type !== 'commit') return null
    const treeM = /^tree ([0-9a-f]{40})$/m.exec(headCommit.bodyBuf.toString('utf8'))
    if (!treeM) return null
    const headMap = collectHeadTreeMap(commonDir, treeM[1])
    if (!headMap || headMap.size !== entries.length) return null

    for (const e of entries) {
      if (e.path.includes('/') && e.path.endsWith('/.gitignore')) return null
      const he = headMap.get(e.path)
      if (!he || he.mode !== e.mode || he.shaHex !== e.shaHex) return null
      indexSet.add(e.path)
      let slash = e.path.indexOf('/')
      while (slash > 0) {
        trackedDirs.add(e.path.slice(0, slash))
        slash = e.path.indexOf('/', slash + 1)
      }
      const abs = join(repoRoot, e.path)
      let st
      try { st = lstatSync(abs) } catch { dirty += 1; continue }
      if (!st.isFile() || st.isSymbolicLink() || st.size !== e.size) { dirty += 1; continue }
      if (core.filemode && ((st.mode & 0o111) ? 0o100755 : 0o100644) !== e.mode) { dirty += 1; continue }
      const diskMtimeS = Math.floor(st.mtimeMs / 1000)
      const diskCtimeS = Math.floor(st.ctimeMs / 1000)
      const safeCachedStat = diskMtimeS === e.mtimeS && diskCtimeS === e.ctimeS && e.mtimeS + 2 < idxMtimeS
      if (!safeCachedStat) {
        let fBuf
        try { fBuf = readFileSync(abs) } catch { dirty += 1; continue }
        if (sha1Blob(fBuf) !== e.shaHex) {
          if (!core.autocrlf || fBuf.subarray(0, 8192).includes(0) || !fBuf.includes(13)) { dirty += 1; continue }
          const blobObj = readGitObjectFast(commonDir, e.shaHex)
          if (!blobObj || blobObj.type !== 'blob' || blobObj.bodyBuf.includes(13) || sha1Blob(stripCrLfBytes(fBuf)) !== e.shaHex) {
            dirty += 1
          }
        }
      }
    }
  }

  const isIgnored = compileIgnoreRules(repoRoot, commonDir)
  if (!isIgnored) return null
  const ignored = []
  let visited = 0

  const scanDir = (absDir, relDir) => {
    let dirEntries
    try { dirEntries = readdirSync(absDir, { withFileTypes: true }) } catch { return null }
    let localDirty = 0
    let hasTracked = false
    let hasIgnored = false
    for (const de of dirEntries) {
      if (de.name === '.git') {
        if (relDir !== '') return null
        continue
      }
      visited += 1
      if (visited > 250) return null
      const rel = posixPath(relDir ? `${relDir}/${de.name}` : de.name)
      if (de.isSymbolicLink()) {
        if (isIgnored(rel, true) && !indexSet.has(rel) && !trackedDirs.has(rel)) {
          ignored.push(rel)
          hasIgnored = true
          continue
        }
        return null
      }
      if (de.isDirectory()) {
        if (isIgnored(rel, true)) {
          if (trackedDirs.has(rel)) return null
          ignored.push(rel)
          hasIgnored = true
          continue
        }
        const sub = scanDir(join(absDir, de.name), rel)
        if (!sub) return null
        if (sub.hasTracked) hasTracked = true
        if (sub.hasIgnored) hasIgnored = true
        if (!sub.hasTracked && !sub.hasIgnored && sub.dirty > 0) localDirty += 1
        else localDirty += sub.dirty
      } else if (de.isFile()) {
        if (relDir && de.name === '.gitignore') return null
        if (indexSet.has(rel)) { hasTracked = true; continue }
        if (isIgnored(rel, false)) { ignored.push(rel); hasIgnored = true; continue }
        localDirty += 1
      }
    }
    return { dirty: localDirty, hasTracked, hasIgnored }
  }

  const rootWalk = scanDir(repoRoot, '')
  if (!rootWalk) return null
  dirty += rootWalk.dirty
  return { ok: true, headInfo, dirty, ignored: ignored.sort() }
}

/** 零子进程读取 `git worktree list --porcelain` 结构（遇 reftable/裸仓/失效或锁定 worktree 返回 null 回退 CLI）。 */
export function readWorktreeListFast(mainRoot, gitCommonDir = null) {
  const dotGit = join(mainRoot, '.git')
  let commonDir = gitCommonDir
  if (!commonDir && existsSync(dotGit)) {
    try {
      if (statSync(dotGit).isDirectory()) commonDir = dotGit
    } catch { return null }
  }
  if (!commonDir || basename(commonDir).toLowerCase() !== '.git' || existsSync(join(commonDir, 'reftable'))) return null
  const cfg = readTextSafe(join(commonDir, 'config')) ?? ''
  if (/^\s*bare\s*=\s*true\b/im.test(cfg)) return null

  const mainHead = readHeadFast(commonDir, commonDir)
  if (!mainHead) return null
  const items = [{
    path: canonicalPath(mainRoot),
    head: mainHead.oid ?? '0'.repeat(40),
    branch: mainHead.detached ? null : mainHead.branch,
    detached: mainHead.detached,
    bare: false,
    prunable: null,
  }]

  const wtRootDir = join(commonDir, 'worktrees')
  if (!existsSync(wtRootDir)) return items
  let dirs
  try { dirs = readdirSync(wtRootDir, { withFileTypes: true }).filter((d) => d.isDirectory()).sort((a, b) => a.name.localeCompare(b.name)) } catch { return null }
  for (const d of dirs) {
    const entryDir = join(wtRootDir, d.name)
    if (existsSync(join(entryDir, 'locked'))) return null
    const gitdirTxt = readTextSafe(join(entryDir, 'gitdir'))?.trim()
    if (!gitdirTxt) return null
    const targetDotGit = resolve(entryDir, gitdirTxt)
    const wtPathRaw = dirname(targetDotGit)
    if (!existsSync(wtPathRaw) || !existsSync(targetDotGit)) return null
    const wtHead = readHeadFast(entryDir, commonDir)
    if (!wtHead) return null
    items.push({
      path: canonicalPath(wtPathRaw),
      head: wtHead.oid ?? '0'.repeat(40),
      branch: wtHead.detached ? null : wtHead.branch,
      detached: wtHead.detached,
      bare: false,
      prunable: null,
    })
  }
  return items
}
