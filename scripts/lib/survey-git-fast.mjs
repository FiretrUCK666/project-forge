/**
 * survey-git-fast.mjs —— 引擎侧 `.git` 快读适配层（单源复用 `kit/skills/lib/git-fast.mjs` 与 `git-index-fast.mjs`）。
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { detectCommitStyle } from '../../kit/skills/lib/git-core.mjs'
import {
  listRefsFast,
  readGitConfigFast,
  readGitIndexPathsFast,
  readSystemGitConfigMapAsync,
  resolveCommonGitDir,
  resolveGitDirFast,
} from '../../kit/skills/lib/git-fast.mjs'
import { readTextSafe } from './text.mjs'

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
  let isRepoRoot = true
  if (!existsSync(join(wtRoot, '.git'))) {
    isRepoRoot = false
    let cur = dirname(wtRoot)
    while (cur !== wtRoot) {
      if (existsSync(join(cur, '.git'))) {
        wtRoot = cur
        break
      }
      wtRoot = cur
      cur = dirname(cur)
    }
    if (!existsSync(join(wtRoot, '.git'))) return null
  }
  try {
    const workGitDir = resolveGitDirFast(wtRoot)
    if (!workGitDir || !existsSync(join(workGitDir, 'HEAD'))) return null
    const commonDir = resolveCommonGitDir(workGitDir, { treatAsGitDir: true }) ?? workGitDir
    const cfgText = readTextSafe(join(commonDir, 'config')) ?? ''
    if (/^\s*bare\s*=\s*true\b/im.test(cfgText)) return null
    const isSha256 = /^\s*objectformat\s*=\s*sha256\b/im.test(cfgText)
    const isShallow = existsSync(join(commonDir, 'shallow'))
    const fastCfg = readGitConfigFast(commonDir, { systemMap: false })
    const remoteText = fastCfg ? fastCfg.remoteText : null
    const useReftable = existsSync(join(commonDir, 'reftable'))
    const refs = useReftable ? null : listRefsFast(commonDir)
    return {
      isRepoRoot,
      workTreeRoot: wtRoot,
      workGitDir,
      commonDir,
      isShallow,
      isSha256,
      remoteText,
      originHeadBranch: refs?.originHeadBranch,
      fastTags: refs ? refs.tags : null,
      fastLocalBranches: refs ? refs.localBranches : null,
      fastRemoteOriginBranches: refs ? refs.remoteOriginBranches : null,
      useReftable,
    }
  } catch {
    return null
  }
}

/** 复用 `kit/skills/lib/git-index-fast.mjs` 读取 Git index v2/v3 路径数组。 */
export function readGitIndexFast(workGitDir, isSha256 = false) {
  const paths = readGitIndexPathsFast(workGitDir, { isGitDir: true, isSha256 })
  return paths ? [...paths] : null
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
