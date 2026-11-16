/**
 * fixtures-git-fast.mjs —— 仅限行为断言夹具测试仓构造的纯 Node Git 物体/索引/提交加速原语。
 *
 * 严格遵循标准 Git SHA-1 松散对象、树、提交、Reflog 与 DIRC v2 索引二进制格式，
 * 遇非常规仓库前提（reftable / sha256 / 复杂 .gitattributes / 合并冲突态等）立即返回 `false`
 * 交由真实 `git` CLI 回退处理。
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

import { readTextSafe } from '../../kit/skills/lib/git.mjs'
import { readHeadFast, resolveGitDirFast } from '../../kit/skills/lib/git-fast.mjs'

export function gitattributesNeedsRealAdd(dir) {
  const gaPath = join(dir, '.gitattributes')
  if (!existsSync(gaPath)) return false
  const raw = readFileSync(gaPath, 'utf8')
  if (/(?:filter|working-tree-encoding|ident)\s*=/i.test(raw)) return true
  const crlfExts = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !/\beol=crlf\b/i.test(t)) continue
    const pat = t.split(/\s+/)[0]
    if (/^\*\.[a-z0-9_-]+$/i.test(pat)) crlfExts.push(pat.slice(1).toLowerCase())
    else return true
  }
  if (crlfExts.length === 0) return false
  const stack = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()
    for (const e of readdirSync(cur, { withFileTypes: true })) {
      if (e.name === '.git' || e.name === '.worktrees') continue
      const p = join(cur, e.name)
      if (e.isDirectory()) stack.push(p)
      else if (crlfExts.some((ext) => e.name.toLowerCase().endsWith(ext))) return true
    }
  }
  return false
}

function writeGitObj(objectsDir, type, body) {
  const full = Buffer.concat([Buffer.from(`${type} ${body.length}\0`, 'utf8'), body])
  const sha = createHash('sha1').update(full).digest('hex')
  const objDir = join(objectsDir, sha.slice(0, 2))
  mkdirSync(objDir, { recursive: true })
  const objPath = join(objDir, sha.slice(2))
  if (!existsSync(objPath)) writeFileSync(objPath, deflateSync(full))
  return { sha, rawSha: Buffer.from(sha, 'hex') }
}

function buildAndWriteTree(objectsDir, entriesMap) {
  const treeRoot = new Map()
  for (const [rel, meta] of entriesMap.entries()) {
    const parts = rel.split('/')
    let node = treeRoot
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (!node.has(parts[i])) node.set(parts[i], new Map())
      node = node.get(parts[i])
    }
    node.set(parts[parts.length - 1], meta)
  }

  const buildNode = (dirMap) => {
    const items = []
    for (const [name, val] of dirMap.entries()) {
      if (val instanceof Map) {
        items.push({ sortKey: `${name}/`, mode: '40000', name, rawSha: buildNode(val) })
      } else {
        const modeStr = val.mode === 0o100755 ? '100755' : '100644'
        items.push({ sortKey: name, mode: modeStr, name, rawSha: val.rawSha })
      }
    }
    items.sort((a, b) => Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')))
    const raw = Buffer.concat(items.map((it) => Buffer.concat([Buffer.from(`${it.mode} ${it.name}\0`, 'utf8'), it.rawSha])))
    return writeGitObj(objectsDir, 'tree', raw).rawSha
  }
  return buildNode(treeRoot).toString('hex')
}

function writeDircV2Index(idxPath, entriesMap) {
  const sortedRels = [...entriesMap.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  const idxHdr = Buffer.alloc(12)
  idxHdr.write('DIRC', 0, 4, 'ascii')
  idxHdr.writeUInt32BE(2, 4)
  idxHdr.writeUInt32BE(sortedRels.length, 8)
  const idxParts = [idxHdr]
  for (const rel of sortedRels) {
    const f = entriesMap.get(rel)
    const pathBuf = Buffer.from(rel, 'utf8')
    const eb = Buffer.alloc((62 + pathBuf.length + 1 + 7) & ~7)
    eb.writeUInt32BE(f.ctimeS >>> 0, 0)
    eb.writeUInt32BE(f.ctimeNs >>> 0, 4)
    eb.writeUInt32BE(f.mtimeS >>> 0, 8)
    eb.writeUInt32BE(f.mtimeNs >>> 0, 12)
    eb.writeUInt32BE((f.mode || 0o100644) >>> 0, 24)
    eb.writeUInt32BE(f.size >>> 0, 36)
    f.rawSha.copy(eb, 40)
    eb.writeUInt16BE(Math.min(pathBuf.length, 0xfff), 60)
    pathBuf.copy(eb, 62)
    idxParts.push(eb)
  }
  const idxBody = Buffer.concat(idxParts)
  writeFileSync(idxPath, Buffer.concat([idxBody, createHash('sha1').update(idxBody).digest()]))
}

function statToTimes(st) {
  return {
    ctimeS: Math.floor(st.ctimeMs / 1000),
    ctimeNs: Math.floor((st.ctimeMs % 1000) * 1e6),
    mtimeS: Math.floor(st.mtimeMs / 1000),
    mtimeNs: Math.floor((st.mtimeMs % 1000) * 1e6),
    size: st.size,
  }
}

export function tryFastNodeInitialCommit(dir, branchName, cName, cEmail, message) {
  const gitDir = join(dir, '.git')
  if (existsSync(join(gitDir, 'reftable')) || gitattributesNeedsRealAdd(dir)) return false
  const cfg = readFileSync(join(gitDir, 'config'), 'utf8')
  if (/^\s*objectformat\s*=\s*sha256\b/im.test(cfg)) return false

  const entriesMap = new Map()
  const stack = [{ abs: dir, rel: '' }]
  while (stack.length > 0) {
    const cur = stack.pop()
    for (const e of readdirSync(cur.abs, { withFileTypes: true })) {
      if (e.name === '.git') continue
      if (e.isSymbolicLink()) return false
      const full = join(cur.abs, e.name)
      const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push({ abs: full, rel })
      else if (e.isFile()) {
        const st = lstatSync(full)
        const buf = readFileSync(full)
        if (buf.includes(13)) return false
        const blob = writeGitObj(join(gitDir, 'objects'), 'blob', buf)
        entriesMap.set(rel, { mode: 0o100644, rawSha: blob.rawSha, ...statToTimes(st) })
      }
    }
  }
  if (entriesMap.size === 0) return false

  const rootTreeHex = buildAndWriteTree(join(gitDir, 'objects'), entriesMap)
  const ts = Math.floor(Date.now() / 1000)
  const commitBody = `tree ${rootTreeHex}\nauthor ${cName} <${cEmail}> ${ts} +0000\ncommitter ${cName} <${cEmail}> ${ts} +0000\n\n${message}\n`
  const commitSha = writeGitObj(join(gitDir, 'objects'), 'commit', Buffer.from(commitBody, 'utf8')).sha

  const headRef = branchName || (() => {
    const ht = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    return ht.startsWith('ref: refs/heads/') ? ht.slice(16).trim() : 'main'
  })()
  const refPath = join(gitDir, 'refs', 'heads', ...headRef.split('/'))
  mkdirSync(dirname(refPath), { recursive: true })
  writeFileSync(refPath, `${commitSha}\n`, 'utf8')

  const reflogLine = `${'0'.repeat(40)} ${commitSha} ${cName} <${cEmail}> ${ts} +0000\tcommit (initial): ${message}\n`
  mkdirSync(join(gitDir, 'logs', 'refs', 'heads', ...headRef.split('/').slice(0, -1)), { recursive: true })
  writeFileSync(join(gitDir, 'logs', 'HEAD'), reflogLine, 'utf8')
  writeFileSync(join(gitDir, 'logs', 'refs', 'heads', ...headRef.split('/')), reflogLine, 'utf8')
  writeDircV2Index(join(gitDir, 'index'), entriesMap)
  return true
}

function readIndexFullMap(idxPath) {
  if (!existsSync(idxPath)) return null
  let buf
  try { buf = readFileSync(idxPath) } catch { return null }
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'DIRC') return null
  const ver = buf.readUInt32BE(4)
  if (ver !== 2 && ver !== 3) return null
  const count = buf.readUInt32BE(8)
  const map = new Map()
  let off = 12
  for (let i = 0; i < count; i += 1) {
    if (off + 62 >= buf.length) return null
    const flags = buf.readUInt16BE(off + 60)
    if ((flags & 0xF000) !== 0) return null
    const mode = buf.readUInt32BE(off + 24)
    if (mode !== 0o100644 && mode !== 0o100755) return null
    const nul = buf.indexOf(0, off + 62)
    if (nul < 0) return null
    const rel = buf.toString('utf8', off + 62, nul)
    map.set(rel, {
      ctimeS: buf.readUInt32BE(off),
      ctimeNs: buf.readUInt32BE(off + 4),
      mtimeS: buf.readUInt32BE(off + 8),
      mtimeNs: buf.readUInt32BE(off + 12),
      mode,
      size: buf.readUInt32BE(off + 36),
      rawSha: Buffer.from(buf.subarray(off + 40, off + 60)),
    })
    off += ((nul - off + 1) + 7) & ~7
  }
  return map
}

function compileSimpleSkip(wtDir, commonDir) {
  const rules = []
  for (const file of [join(wtDir, '.gitignore'), join(commonDir, 'info', 'exclude')]) {
    const txt = readTextSafe(file)
    if (!txt) continue
    for (const raw of txt.split('\n')) {
      const line = raw.replace(/\r$/, '').trim()
      if (!line || line.startsWith('#')) continue
      if (/[!\\[\]?*]/.test(line)) return null
      const clean = line.replace(/^\/+/, '').replace(/\/+$/, '')
      if (!clean) continue
      rules.push({ clean, anchored: line.startsWith('/') || line.slice(0, -1).includes('/'), dirOnly: line.endsWith('/') })
    }
  }
  return (rel, isDir) => {
    const leaf = rel.includes('/') ? rel.slice(rel.lastIndexOf('/') + 1) : rel
    for (const r of rules) {
      if (r.dirOnly && !isDir) continue
      if (r.anchored ? rel === r.clean : leaf === r.clean) return true
    }
    return false
  }
}

function resolveCommitIdentity(commonDir, opts) {
  if (opts.name && opts.email) return { name: opts.name, email: opts.email }
  let name = opts.name
  let email = opts.email
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  for (const cfgPath of [join(homedir(), '.gitconfig'), join(xdg, 'git', 'config'), join(commonDir, 'config')]) {
    const txt = readTextSafe(cfgPath)
    if (!txt) continue
    let inUser = false
    for (const raw of txt.split('\n')) {
      const line = raw.replace(/(?:^|\s)[;#].*$/, '').trim()
      if (!line) continue
      if (line.startsWith('[')) { inUser = /^\[user\]$/i.test(line); continue }
      if (!inUser) continue
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      if (k === 'name' && !opts.name) name = v
      else if (k === 'email' && !opts.email) email = v
    }
  }
  return { name: name || 't', email: email || 't@t.t' }
}

/**
 * 在已有提交历史的测试仓/工作树上纯 Node 快速增量提交，等价于 `git add` + `git commit -qm`（支持 `-a` 与指定路径）。
 * 若命中不安全前提则立即返回 `false` 交由调用方回退 `gitSync`。
 */
export function tryFastNodeCommit(wtDir, message, opts = {}) {
  const wtGitDir = resolveGitDirFast(wtDir)
  if (!wtGitDir) return false
  const cdTxt = readTextSafe(join(wtGitDir, 'commondir'))
  const commonDir = cdTxt ? resolve(wtGitDir, cdTxt.trim()) : wtGitDir

  if (existsSync(join(commonDir, 'reftable'))
    || existsSync(join(commonDir, 'shallow'))
    || existsSync(join(wtGitDir, 'MERGE_HEAD'))
    || existsSync(join(wtGitDir, 'REBASE_HEAD'))
    || existsSync(join(wtGitDir, 'SQUASH_MSG'))
    || existsSync(join(wtGitDir, 'CHERRY_PICK_HEAD'))
    || existsSync(join(wtDir, '.gitmodules'))
    || gitattributesNeedsRealAdd(wtDir)) {
    return false
  }
  const cfgTxt = readTextSafe(join(commonDir, 'config')) ?? ''
  if (/^\s*objectformat\s*=\s*sha256\b/im.test(cfgTxt)) return false

  const headInfo = readHeadFast(wtGitDir, commonDir)
  if (!headInfo || !headInfo.oid) return false
  const entriesMap = readIndexFullMap(join(wtGitDir, 'index'))
  if (!entriesMap) return false

  const sha1BlobBuf = (b) => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest()
  const stripCrLf = (b) => {
    const out = Buffer.allocUnsafe(b.length)
    let j = 0
    for (let i = 0; i < b.length; i += 1) {
      if (b[i] === 13 && i + 1 < b.length && b[i + 1] === 10) continue
      out[j++] = b[i]
    }
    return out.subarray(0, j)
  }

  const objectsDir = join(commonDir, 'objects')
  const stageFile = (rel) => {
    const abs = join(wtDir, rel)
    if (!existsSync(abs)) { entriesMap.delete(rel); return true }
    let st
    try { st = lstatSync(abs) } catch { return false }
    if (!st.isFile() || st.isSymbolicLink()) return false
    const buf = readFileSync(abs)
    const prev = entriesMap.get(rel)
    if (buf.includes(13)) {
      if (prev && sha1BlobBuf(stripCrLf(buf)).equals(prev.rawSha)) return true
      return false
    }
    const rawSha = sha1BlobBuf(buf)
    if (prev && rawSha.equals(prev.rawSha)) {
      entriesMap.set(rel, { mode: prev.mode, rawSha: prev.rawSha, ...statToTimes(st) })
      return true
    }
    const blob = writeGitObj(objectsDir, 'blob', buf)
    entriesMap.set(rel, { mode: prev?.mode ?? 0o100644, rawSha: blob.rawSha, ...statToTimes(st) })
    return true
  }

  if (Array.isArray(opts.files) && opts.files.length > 0) {
    for (const f of opts.files) {
      if (!stageFile(String(f).replace(/\\/g, '/').replace(/^\.\//, ''))) return false
    }
  } else if (opts.updateOnly) {
    for (const rel of [...entriesMap.keys()]) {
      if (!stageFile(rel)) return false
    }
  } else {
    const isSkip = compileSimpleSkip(wtDir, commonDir)
    if (!isSkip) return false
    const diskSet = new Set()
    const stack = [{ abs: wtDir, rel: '' }]
    while (stack.length > 0) {
      const cur = stack.pop()
      for (const e of readdirSync(cur.abs, { withFileTypes: true })) {
        if (e.name === '.git') continue
        const rel = cur.rel ? `${cur.rel}/${e.name}` : e.name
        if (e.isSymbolicLink()) {
          if (isSkip(rel, true) && !entriesMap.has(rel)) continue
          return false
        }
        if (e.isDirectory()) {
          if (isSkip(rel, true)) continue
          stack.push({ abs: join(cur.abs, e.name), rel })
        } else if (e.isFile()) {
          if (cur.rel && e.name === '.gitignore') return false
          if (isSkip(rel, false) && !entriesMap.has(rel)) continue
          diskSet.add(rel)
          if (!stageFile(rel)) return false
        }
      }
    }
    for (const tracked of [...entriesMap.keys()]) {
      if (!diskSet.has(tracked)) entriesMap.delete(tracked)
    }
  }

  const rootTreeHex = buildAndWriteTree(objectsDir, entriesMap)
  const { name: cName, email: cEmail } = resolveCommitIdentity(commonDir, opts)
  const ts = Math.floor(Date.now() / 1000)
  const parentOid = headInfo.oid
  const commitBody = `tree ${rootTreeHex}\nparent ${parentOid}\nauthor ${cName} <${cEmail}> ${ts} +0000\ncommitter ${cName} <${cEmail}> ${ts} +0000\n\n${message}\n`
  const commitSha = writeGitObj(objectsDir, 'commit', Buffer.from(commitBody, 'utf8')).sha

  if (headInfo.detached) {
    writeFileSync(join(wtGitDir, 'HEAD'), `${commitSha}\n`, 'utf8')
  } else {
    const refPath = join(commonDir, ...headInfo.ref.split('/'))
    mkdirSync(dirname(refPath), { recursive: true })
    writeFileSync(refPath, `${commitSha}\n`, 'utf8')
    const branchLog = join(commonDir, 'logs', ...headInfo.ref.split('/'))
    mkdirSync(dirname(branchLog), { recursive: true })
    const rLine = `${parentOid} ${commitSha} ${cName} <${cEmail}> ${ts} +0000\tcommit: ${message}\n`
    appendFileSync(branchLog, rLine, 'utf8')
  }
  mkdirSync(join(wtGitDir, 'logs'), { recursive: true })
  appendFileSync(join(wtGitDir, 'logs', 'HEAD'), `${parentOid} ${commitSha} ${cName} <${cEmail}> ${ts} +0000\tcommit: ${message}\n`, 'utf8')
  writeDircV2Index(join(wtGitDir, 'index'), entriesMap)
  return true
}
