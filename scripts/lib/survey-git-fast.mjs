/**
 * survey-git-fast.mjs —— `.git` 配置文件、index 二进制条目与松散引用快读辅助。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { detectCommitStyle } from '../../kit/skills/lib/git-core.mjs'
import { readSystemGitConfigMapAsync } from '../../kit/skills/lib/git-fast.mjs'
import { isMacMetadataName, readTextSafe } from './text.mjs'

export { detectCommitStyle }

export function parseConfigList(text) {
  const map = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const scope = parts[0].trim()
    if (!/^(system|global|local|worktree|command)$/.test(scope)) continue
    const body = parts.slice(2).join('\t')
    const eq = body.indexOf('=')
    if (eq < 0) continue
    map.set(body.slice(0, eq).toLowerCase(), { scope, value: body.slice(eq + 1) })
  }
  return map
}

export function parsePorcelainV2(text) {
  const out = { head: undefined, oid: undefined, upstream: undefined, ahead: 0, behind: 0, dirty: 0, ignored: [] }
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('# branch.head ')) out.head = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) out.oid = line.slice(13).trim()
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(17).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line)
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]) }
    } else if (line.startsWith('! ')) {
      out.ignored.push(line.slice(2).trim().replace(/\/$/, ''))
    } else if (line.trim() !== '') out.dirty += 1
  }
  return out
}

export function inspectDotGitFast(root) {
  if (process.env.GIT_DIR || process.env.GIT_WORK_TREE) return null
  let wtRoot = resolve(root)
  let dotGit = join(wtRoot, '.git')
  let isRepoRoot = true
  if (!existsSync(dotGit)) {
    isRepoRoot = false
    let cur = dirname(wtRoot)
    while (cur !== wtRoot) {
      if (existsSync(join(cur, '.git'))) {
        wtRoot = cur
        dotGit = join(cur, '.git')
        break
      }
      wtRoot = cur
      cur = dirname(cur)
    }
    if (!existsSync(dotGit)) return null
  }
  try {
    const st = statSync(dotGit)
    let workGitDir = dotGit
    let commonDir = dotGit
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/im.exec(readTextSafe(dotGit) ?? '')
      if (!m) return null
      workGitDir = resolve(wtRoot, m[1].trim())
      const commondirTxt = readTextSafe(join(workGitDir, 'commondir'))
      commonDir = commondirTxt ? resolve(workGitDir, commondirTxt.trim()) : workGitDir
    } else if (!st.isDirectory()) {
      return null
    }
    if (!existsSync(join(workGitDir, 'HEAD'))) return null
    const cfgText = readTextSafe(join(commonDir, 'config')) ?? ''
    if (/^\s*bare\s*=\s*true\b/im.test(cfgText)) return null
    const isSha256 = /^\s*objectformat\s*=\s*sha256\b/im.test(cfgText)
    const isShallow = existsSync(join(commonDir, 'shallow'))
    const hasRewrite = /^\s*\[url\b/im.test(cfgText) || /^\s*\[include(?:if)?\b/im.test(cfgText)
    let remoteText = null
    if (!hasRewrite) {
      const remotes = new Map()
      let curRemote = null
      for (const rawLine of cfgText.split('\n')) {
        const line = rawLine.replace(/(?:^|\s)[;#].*$/, '').trim()
        const sec = /^\[remote\s+"([^"]+)"\]$/i.exec(line)
        if (sec) {
          curRemote = sec[1]
          if (!remotes.has(curRemote)) remotes.set(curRemote, { u: [], p: [] })
          continue
        }
        if (line.startsWith('[')) { curRemote = null; continue }
        if (!curRemote) continue
        const eq = line.indexOf('=')
        if (eq <= 0) continue
        const k = line.slice(0, eq).trim().toLowerCase()
        const v = line.slice(eq + 1).trim()
        if (k === 'url' && v) remotes.get(curRemote).u.push(v)
        else if (k === 'pushurl' && v) remotes.get(curRemote).p.push(v)
      }
      const lines = []
      for (const [name, entry] of remotes.entries()) {
        const f = entry.u[0]
        const p = entry.p[0] ?? f
        if (f) lines.push(`${name}\t${f} (fetch)`)
        if (p) lines.push(`${name}\t${p} (push)`)
      }
      remoteText = lines.join('\n')
    }

    let originHeadBranch
    const origHead = readTextSafe(join(commonDir, 'refs', 'remotes', 'origin', 'HEAD'))
    if (origHead) {
      const m = /^ref:\s*refs\/remotes\/origin\/(.+)$/im.exec(origHead.trim())
      if (m) originHeadBranch = m[1].trim()
    }
    const packed = readTextSafe(join(commonDir, 'packed-refs')) ?? ''
    if (!originHeadBranch && packed) {
      const sym = /^ref:\s*refs\/remotes\/origin\/([^\s]+)\s+refs\/remotes\/origin\/HEAD$/m.exec(packed)
      if (sym) originHeadBranch = sym[1].trim()
    }
    const useReftable = existsSync(join(commonDir, 'reftable'))
    const walkLooseRefs = (dirAbs, excludeName = null) => {
      const set = new Set()
      if (!existsSync(dirAbs)) return set
      const stack = [{ abs: dirAbs, rel: '' }]
      while (stack.length > 0) {
        const cur = stack.pop()
        let entries = []
        try { entries = readdirSync(cur.abs, { withFileTypes: true }) } catch { continue }
        for (const e of entries) {
          if (isMacMetadataName(e.name)) continue
          const subRel = cur.rel ? `${cur.rel}/${e.name}` : e.name
          if (e.isDirectory()) stack.push({ abs: join(cur.abs, e.name), rel: subRel })
          else if (e.isFile() && subRel !== excludeName) set.add(subRel)
        }
      }
      return set
    }
    let fastTags = null
    let fastLocalBranches = null
    let fastRemoteOriginBranches = null
    if (!useReftable) {
      const tagSet = walkLooseRefs(join(commonDir, 'refs', 'tags'))
      const headSet = walkLooseRefs(join(commonDir, 'refs', 'heads'))
      const remoteOriginSet = walkLooseRefs(join(commonDir, 'refs', 'remotes', 'origin'), 'HEAD')
      if (packed) {
        for (const line of packed.split('\n')) {
          if (!line || line.startsWith('#') || line.startsWith('^')) continue
          const sp = line.indexOf(' ')
          if (sp <= 0) continue
          const refName = line.slice(sp + 1).trim()
          if (refName.startsWith('refs/tags/')) tagSet.add(refName.slice(10))
          else if (refName.startsWith('refs/heads/')) headSet.add(refName.slice(11))
          else if (refName.startsWith('refs/remotes/origin/') && refName !== 'refs/remotes/origin/HEAD') remoteOriginSet.add(refName.slice(20))
        }
      }
      fastTags = [...tagSet].sort()
      fastLocalBranches = [...headSet].sort()
      fastRemoteOriginBranches = [...remoteOriginSet].sort()
    }
    return {
      isRepoRoot, workTreeRoot: wtRoot, workGitDir, commonDir, isShallow, isSha256,
      remoteText, originHeadBranch, fastTags, fastLocalBranches, fastRemoteOriginBranches, useReftable,
    }
  } catch {
    return null
  }
}

/** 直接解析 Git index v2/v3 二进制条目列表，避免派生 `git ls-files -z`。 */
export function readGitIndexFast(workGitDir, isSha256 = false) {
  if (!workGitDir || isSha256) return null
  const idxPath = join(workGitDir, 'index')
  if (!existsSync(idxPath)) return null
  let buf
  try { buf = readFileSync(idxPath) } catch { return null }
  if (buf.length < 32 || buf.toString('ascii', 0, 4) !== 'DIRC') return null
  const ver = buf.readUInt32BE(4)
  if (ver !== 2 && ver !== 3) return null
  const count = buf.readUInt32BE(8)
  let off = 12
  const paths = []
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
    paths.push(buf.toString('utf8', nameOff, nul))
    const len = nul - off + 1
    off += (len + 7) & ~7
  }
  if (off > buf.length - 20) return null
  while (off + 8 <= buf.length - 20) {
    const sig = buf.toString('ascii', off, off + 4)
    if (!/^[A-Za-z]{4}$/.test(sig)) return null
    if (sig === 'link' || sig === 'sdir') return null
    const sz = buf.readUInt32BE(off + 4)
    off += 8 + sz
  }
  if (off !== buf.length - 20) return null
  return paths
}

export function mapProbeToAuth(probe) {
  const auth = {
    probed: true,
    hasRemote: probe.hasRemote ?? Boolean(probe.details?.hasRemote),
    https: probe.https?.state ?? 'undetermined',
    ssh: probe.ssh,
    ghBridge: probe.ghBridge,
    ...(probe.ghCli ? { ghCli: probe.ghCli } : {}),
    apiChannel: probe.apiChannel,
    protocolMismatch: probe.protocolMismatch ?? false,
    remediationCmd: probe.remediationCmd,
    details: probe.details,
    network: probe.apiChannel?.tier === 'offline' ? 'offline' : 'reachable',
    reason: probe.apiChannel?.reason || probe.https?.reason,
  }
  Object.defineProperty(auth, '_probeResult', {
    value: probe,
    enumerable: false,
    configurable: true,
  })
  return auth
}

export function parseTagsAndOriginHead(forEachRefOut) {
  const tags = []
  const localBranches = []
  const remoteOriginBranches = []
  let originHeadBranch
  for (const rawLine of String(forEachRefOut ?? '').split('\n')) {
    if (!rawLine) continue
    const [refName, symTarget = ''] = rawLine.split('\t')
    if (refName === 'refs/remotes/origin/HEAD') {
      const target = symTarget.trim()
      if (target) originHeadBranch = target.replace(/^origin\//, '')
    } else if (refName.startsWith('refs/tags/')) {
      tags.push(refName.slice(10))
    } else if (refName.startsWith('refs/heads/')) {
      localBranches.push(refName.slice(11))
    } else if (refName.startsWith('refs/remotes/origin/')) {
      remoteOriginBranches.push(refName.slice(20))
    }
  }
  return { tags, originHeadBranch, localBranches, remoteOriginBranches }
}

let cachedSystemGitConfig
let pendingSystemGitConfig
export async function getSystemGitConfigEntriesAsync() {
  if (cachedSystemGitConfig !== undefined) return cachedSystemGitConfig
  if (pendingSystemGitConfig) return pendingSystemGitConfig
  pendingSystemGitConfig = readSystemGitConfigMapAsync().then((sysMap) => {
    const entries = []
    for (const [key, value] of sysMap.entries()) {
      if (/^(?:user|credential|init)\./.test(key) || key === 'core.excludesfile' || key === 'core.hookspath') {
        entries.push({ key, scope: 'system', value })
      }
    }
    cachedSystemGitConfig = entries
    pendingSystemGitConfig = null
    return entries
  }).catch(() => {
    cachedSystemGitConfig = []
    pendingSystemGitConfig = null
    return cachedSystemGitConfig
  })
  return pendingSystemGitConfig
}

export function readUserScopeConfigFast(commonDir) {
  if (process.env.GIT_CONFIG_GLOBAL || process.env.GIT_CONFIG_SYSTEM || process.env.GIT_CONFIG_COUNT) return null
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const globalPath = existsSync(join(homedir(), '.gitconfig'))
    ? join(homedir(), '.gitconfig')
    : (existsSync(join(xdg, 'git', 'config')) ? join(xdg, 'git', 'config') : null)
  const localPath = join(commonDir, 'config')
  const sources = []
  if (globalPath) sources.push({ scope: 'global', text: readTextSafe(globalPath) ?? '' })
  if (existsSync(localPath)) sources.push({ scope: 'local', text: readTextSafe(localPath) ?? '' })
  for (const s of sources) {
    if (/^\s*\[include(?:if)?\b/im.test(s.text)) return null
  }
  const map = new Map()
  for (const { scope, text } of sources) {
    let curSection = ''
    for (const rawLine of text.split('\n')) {
      const line = rawLine.replace(/(?:^|\s)[;#].*$/, '').trim()
      if (!line) continue
      const sec = /^\[([a-z0-9-]+)(?:\s+"([^"]*)")?\]$/i.exec(line)
      if (sec) { curSection = sec[1].toLowerCase(); continue }
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      if (curSection === 'user' || curSection === 'credential' || curSection === 'init' || (curSection === 'core' && (k === 'excludesfile' || k === 'hookspath'))) {
        map.set(`${curSection}.${k}`, { scope, value: v })
      }
    }
  }
  return map
}

export function mergeScopeConfigFast(sysEntries, userMap) {
  const map = new Map()
  for (const sysEntry of sysEntries ?? []) {
    map.set(sysEntry.key, { scope: sysEntry.scope, value: sysEntry.value })
  }
  for (const [k, v] of userMap.entries()) map.set(k, v)
  return map
}

export function hasIgnoredTrackedImpossibleFast(root, commonDir, trackedPaths, configMap) {
  if (!Array.isArray(trackedPaths) || trackedPaths.length === 0) return true
  if (configMap?.get('core.excludesfile')?.value) return false
  if (trackedPaths.some((p) => p.includes('/') && p.endsWith('/.gitignore'))) return false
  const rules = []
  for (const file of [join(root, '.gitignore'), join(commonDir, 'info', 'exclude')]) {
    const txt = readTextSafe(file)
    if (!txt) continue
    for (const raw of txt.split('\n')) {
      const line = raw.trim()
      if (!line || line.startsWith('#') || line.startsWith('!')) continue
      if (line === '*.py[cod]') {
        if (trackedPaths.some((p) => /\.(?:pyc|pyo|pyd)$/.test(p))) return false
        continue
      }
      if (/[\\[\]?]/.test(line) || line.includes('**')) return false
      rules.push(line)
    }
  }
  if (rules.length === 0) return true
  for (const rule of rules) {
    const anchored = rule.startsWith('/')
    const clean = rule.replace(/^\/+/, '').replace(/\/+$/, '')
    if (!clean) continue
    if (clean.includes('*')) {
      const starM = /^\*\.([A-Za-z0-9_-]+)$/.exec(clean)
      if (starM) {
        const suffix = `.${starM[1]}`
        if (trackedPaths.some((p) => p.endsWith(suffix))) return false
        continue
      }
      if (!anchored && !clean.includes('/') && clean.startsWith('*') && clean.length > 1 && !/[*?[\]\\/]/.test(clean.slice(1))) {
        const suffix = clean.slice(1)
        if (trackedPaths.some((p) => p.split('/').some((seg) => seg.endsWith(suffix)))) return false
        continue
      }
      return false
    }
    if (anchored || clean.includes('/')) {
      if (trackedPaths.some((p) => p === clean || p.startsWith(`${clean}/`))) return false
    } else {
      if (trackedPaths.some((p) => p === clean || p.startsWith(`${clean}/`) || p.split('/').includes(clean))) return false
    }
  }
  return true
}
