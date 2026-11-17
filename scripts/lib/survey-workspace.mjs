/**
 * survey-workspace.mjs —— 版本控制、工作区扫描、文档/工作流/设计体系与套件清单探测。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { prepareExecInvocation, resolveExecutable } from '../../kit/skills/lib/exec.mjs'
import { hasDotGitInAncestors, readHeadFast, readLooseCommitLogFast } from '../../kit/skills/lib/git-fast.mjs'
import { inspectSurveyStatusFast } from '../../kit/skills/lib/git-status-fast.mjs'

import {
  detectGitModeMarkers,
  probeGitHubEnv,
  probePlatformEnv,
  resolveRemotesTopology,
} from './platform/index.mjs'
import * as protocol from './protocol.mjs'
import {
  isMacMetadataName,
  parseSshConfigHostMap,
  readTextSafe,
  samePath,
} from './text.mjs'
import {
  CODE_EXT,
  DOC_EXT,
  OUTPUT_DIRS,
  SKIP_DIRS,
  TEXT_EXT,
  isJunkFile,
} from './survey-ecosystem.mjs'

const LIKELY_DEFAULT_BRANCHES = protocol.LIKELY_DEFAULT_BRANCHES ?? ['main', 'master', 'trunk', 'develop', 'default', 'development']
const parseMarkers = protocol.parseMarkers

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|keystore)$/i,
  /^id_(?:rsa|ed25519|ecdsa)$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
]
const SAFE_ENV_EXAMPLES = /^\.env\.(?:example|sample|template|defaults)$/i

const SECRET_CONTENT_PATTERNS = [
  { label: 'GitHub 令牌', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { label: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'npm 令牌', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'PyPI 令牌', re: /\bpypi-[A-Za-z0-9_-]{50,}\b/ },
  { label: 'API 密钥', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { label: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
]

export function runCmd(cmd, args, opts = {}) {
  return new Promise((done) => {
    const baseEnv = opts.env === undefined ? process.env : { ...process.env, ...opts.env }
    const inv = process.platform === 'win32'
      ? prepareExecInvocation(cmd, args, { cwd: opts.cwd, env: baseEnv })
      : { cmd, args, env: baseEnv, windowsVerbatimArguments: false }
    const child = execFile(inv.cmd, inv.args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout ?? 15000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: inv.env,
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }, (error, stdout, stderr) => {
      done({
        ok: error === null,
        status: error?.code ?? 0,
        missing: error?.code === 'ENOENT',
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      })
    })
    if (child.stdin) child.stdin.on('error', () => {})
    if (opts.input !== undefined && child.stdin) child.stdin.end(opts.input)
    else if (child.stdin) child.stdin.end()
  })
}

export function git(cwd, args, opts = {}) {
  return runCmd('git', ['-c', 'core.quotepath=false', '--no-optional-locks', ...args], { ...opts, cwd })
}

function parseConfigList(text) {
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

function parseOriginHead(res) {
  if (!res?.ok || !res.stdout) return undefined
  const m = /^origin\/(.+)$/.exec(res.stdout.trim())
  return m ? m[1] : res.stdout.trim() || undefined
}

function detectCommitStyle(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) return 'plain'
  const conventional = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s+\S/i
  const gitmoji = /^(?::[a-z_]+:|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])/u
  let conv = 0
  let emoji = 0
  for (const s of subjects) {
    if (conventional.test(s)) conv += 1
    else if (gitmoji.test(s)) emoji += 1
  }
  const half = subjects.length / 2
  if (conv > half) return 'conventional'
  if (emoji > half) return 'gitmoji'
  return 'plain'
}

function parsePorcelainV2(text) {
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

function inspectDotGitFast(root) {
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
function readGitIndexFast(workGitDir, isSha256 = false) {
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

function mapProbeToAuth(probe) {
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

function parseTagsAndOriginHead(forEachRefOut) {
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
function getSystemGitConfigEntriesAsync() {
  if (cachedSystemGitConfig !== undefined) return Promise.resolve(cachedSystemGitConfig)
  if (pendingSystemGitConfig) return pendingSystemGitConfig
  pendingSystemGitConfig = new Promise((resolveDone) => {
    const entries = []
    try {
      const inv = process.platform === 'win32'
        ? prepareExecInvocation('git', ['config', '--system', '--list'], {})
        : { cmd: 'git', args: ['config', '--system', '--list'], windowsVerbatimArguments: false }
      execFile(inv.cmd, inv.args, {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
        ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      }, (err, stdout) => {
        if (!err && stdout) {
          for (const rawLine of String(stdout).split('\n')) {
            const eq = rawLine.indexOf('=')
            if (eq <= 0) continue
            const key = rawLine.slice(0, eq).trim().toLowerCase()
            const value = rawLine.slice(eq + 1).trim()
            if (/^(?:user|credential|init)\./.test(key) || key === 'core.excludesfile') {
              entries.push({ key, scope: 'system', value })
            }
          }
        }
        cachedSystemGitConfig = entries
        pendingSystemGitConfig = null
        resolveDone(entries)
      })
    } catch {
      cachedSystemGitConfig = entries
      pendingSystemGitConfig = null
      resolveDone(entries)
    }
  })
  return pendingSystemGitConfig
}

function readUserScopeConfigFast(commonDir) {
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
      if (curSection === 'user' || curSection === 'credential' || curSection === 'init' || (curSection === 'core' && k === 'excludesfile')) {
        map.set(`${curSection}.${k}`, { scope, value: v })
      }
    }
  }
  return map
}

function mergeScopeConfigFast(sysEntries, userMap) {
  const map = new Map()
  for (const sysEntry of sysEntries ?? []) {
    map.set(sysEntry.key, { scope: sysEntry.scope, value: sysEntry.value })
  }
  for (const [k, v] of userMap.entries()) map.set(k, v)
  return map
}

function hasIgnoredTrackedImpossibleFast(root, commonDir, trackedPaths, configMap) {
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

export async function detectGit(root, opts = {}) {
  const { probeAuth = false, verifyToken = false, sshHostMap, mcpAvailable, offline, fastUnbornStatus = false } = opts
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())
  const dotFast = inspectDotGitFast(root)

  // 非根目录且无直属 .git 时先纯本地核查祖先是否存在 .git，避免非 Git 目录空跑 `git rev-parse`
  // 注意：不可将 --show-toplevel 与裸仓检测合并，否则裸仓会直接报错退出 128
  let top
  let isBare = false
  let isShallow = false
  let insideFlag = 'false'
  let workTreeRoot = root
  if (dotFast) {
    insideFlag = 'true'
    isShallow = dotFast.isShallow
    workTreeRoot = dotFast.workTreeRoot
  } else if (!hasDotGitInAncestors(root)) {
    if (!resolveExecutable('git')) {
      return { available: false, present: false, auth: { https: 'n/a', network: 'n/a' } }
    }
    let auth = { https: 'n/a', network: 'n/a' }
    if (probeAuth) {
      const probe = await probeGitHubEnv({
        cwd: root, remoteUrls: {}, verifyToken, mcpAvailable, offline, sshHostMap: effectiveHostMap,
      })
      auth = mapProbeToAuth(probe)
    }
    return { available: true, present: false, auth }
  } else {
    top = await git(root, ['rev-parse', '--is-inside-work-tree', '--is-bare-repository', '--is-shallow-repository', '--git-dir'])
    if (top.missing) {
      return { available: false, present: false, auth: { https: 'n/a', network: 'n/a' } }
    }
    if (!top.ok || !top.stdout) {
      let auth = { https: 'n/a', network: 'n/a' }
      if (probeAuth) {
        const probe = await probeGitHubEnv({
          cwd: root, remoteUrls: {}, verifyToken, mcpAvailable, offline, sshHostMap: effectiveHostMap,
        })
        auth = mapProbeToAuth(probe)
      }
      return { available: true, present: false, auth }
    }
    const topLines = top.stdout.split('\n').map((l) => l.trim())
    insideFlag = topLines[0] || 'false'
    isBare = topLines[1] === 'true'
    isShallow = topLines[2] === 'true'
    if (!isBare && insideFlag === 'true') {
      const toplevelRes = await git(root, ['rev-parse', '--show-toplevel'])
      workTreeRoot = toplevelRes.ok && toplevelRes.stdout ? toplevelRes.stdout : root
    }
  }
  if (isBare) {
    return {
      available: true, present: true, isBare: true, isShallow: false, isRepoRoot: true,
      workTreeRoot: root, barePath: root, branch: undefined, remote: undefined, remotes: [],
      remoteUrls: {}, identity: { name: undefined, email: undefined, scope: 'unset' },
      commits: undefined, commitsState: 'unreadable', trackedPaths: [], trackedFiles: 0,
      nestedRepos: [], auth: { https: 'n/a', network: 'n/a', reason: '裸仓库没有工作区' },
    }
  }

  const userScopeMap = dotFast ? readUserScopeConfigFast(dotFast.commonDir) : null
  const fastIndexAbsent = Boolean(dotFast && !dotFast.useReftable && !existsSync(join(dotFast.workGitDir, 'index')))
  const fastTrackedPaths = dotFast ? (fastIndexAbsent ? [] : readGitIndexFast(dotFast.workGitDir, dotFast.isSha256)) : null
  const fastHeadInfo = (() => {
    if (!dotFast || dotFast.useReftable) return null
    const ht = readTextSafe(join(dotFast.workGitDir, 'HEAD'))?.trim()
    if (!ht) return null
    if (!ht.startsWith('ref:')) return { unborn: false, branch: '(detached)' }
    const refRel = ht.slice(4).trim().replace(/^\/+/, '')
    const branch = refRel.startsWith('refs/heads/') ? refRel.slice(11) : refRel
    if (existsSync(join(dotFast.commonDir, ...refRel.split('/')))) return { unborn: false, branch }
    const packed = readTextSafe(join(dotFast.commonDir, 'packed-refs')) ?? ''
    const hasPacked = packed.split('\n').some((l) => l && !l.startsWith('#') && !l.startsWith('^') && l.slice(l.indexOf(' ') + 1).trim() === refRel)
    return { unborn: !hasPacked, branch }
  })()
  const fastHeadUnborn = Boolean(fastHeadInfo?.unborn)
  const fastHeadOid = (dotFast && !dotFast.useReftable && !fastHeadUnborn) ? readHeadFast(dotFast.workGitDir, dotFast.commonDir)?.oid : null
  const fastCommitLog = (fastHeadOid && !dotFast?.isShallow) ? readLooseCommitLogFast(workTreeRoot, dotFast.commonDir, fastHeadOid, 500) : null
  const skipUnbornStatus = Boolean(fastUnbornStatus && fastHeadUnborn && fastIndexAbsent)
  const fastSurveyStatus = (!skipUnbornStatus && dotFast && !dotFast.useReftable)
    ? inspectSurveyStatusFast(workTreeRoot)
    : null
  const sysEntriesPromise = userScopeMap ? getSystemGitConfigEntriesAsync() : null
  const lsIgnoredPromise = (dotFast && !dotFast.useReftable && userScopeMap)
    ? sysEntriesPromise.then((sysEntries) => (
      hasIgnoredTrackedImpossibleFast(workTreeRoot, dotFast.commonDir, fastTrackedPaths, mergeScopeConfigFast(sysEntries, userScopeMap))
        ? { ok: true, stdout: '' }
        : git(root, ['ls-files', '-i', '-c', '--exclude-standard', '-z'])
    ))
    : git(root, ['ls-files', '-i', '-c', '--exclude-standard', '-z'])
  const [sysEntries, cfg, st, remotes, refsRes, logRes, lsFiles, lsIgnoredRes] = await Promise.all([
    sysEntriesPromise ?? Promise.resolve(null),
    userScopeMap ? Promise.resolve(null) : git(root, ['config', '--list', '--show-scope', '--show-origin']),
    skipUnbornStatus
      ? Promise.resolve({ ok: true, stdout: `# branch.oid (initial)\n# branch.head ${fastHeadInfo.branch}\n` })
      : (fastSurveyStatus?.ok
          ? Promise.resolve({
              ok: true,
              stdout: [
                `# branch.oid ${fastSurveyStatus.headInfo.oid || '(initial)'}`,
                `# branch.head ${fastSurveyStatus.headInfo.detached ? '(detached)' : fastSurveyStatus.headInfo.branch}`,
                ...Array.from({ length: fastSurveyStatus.dirty }, (_, idx) => `? fast-dirty-${idx}`),
                ...fastSurveyStatus.ignored.map((p) => `! ${p}`),
              ].join('\n'),
            })
          : git(root, ['status', '--porcelain=v2', '--branch', '--ignored=matching', '--untracked-files=normal'])),
    dotFast && dotFast.remoteText !== null ? Promise.resolve({ ok: true, stdout: dotFast.remoteText }) : git(root, ['remote', '-v']),
    dotFast && !dotFast.useReftable && dotFast.fastTags !== null
      ? Promise.resolve(null)
      : git(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname)\t%(symref:short)', 'refs/tags', 'refs/heads', 'refs/remotes/origin']),
    fastHeadUnborn
      ? Promise.resolve({ ok: true, stdout: '' })
      : (fastCommitLog
          ? Promise.resolve({ ok: true, stdout: fastCommitLog.entries.map((e) => `${e.author}\x1f${e.parents}\x1f${e.subject}`).join('\n') })
          : git(root, ['log', '--format=%an <%ae>\x1f%P%x1f%s', '-n', '500'])),
    fastTrackedPaths !== null ? Promise.resolve(null) : git(root, ['ls-files', '-z']),
    lsIgnoredPromise,
  ])

  const isRepoRoot = dotFast ? dotFast.isRepoRoot : samePath(root, workTreeRoot)

  const config = userScopeMap ? mergeScopeConfigFast(sysEntries, userScopeMap) : parseConfigList(cfg?.ok ? cfg.stdout : '')
  const statusInfo = parsePorcelainV2(st.ok ? st.stdout : '')

  const topology = resolveRemotesTopology(remotes.stdout || '', { sshHostMap: effectiveHostMap })
  const remoteUrls = {}
  const remotePushUrls = {}
  for (const desc of topology.remotes) {
    if (desc.name && desc.fetchUrl) remoteUrls[desc.name] = desc.fetchUrl
    if (desc.name && desc.pushUrl) remotePushUrls[desc.name] = desc.pushUrl
  }
  const remoteNames = topology.remotes.map((r) => r.name).filter(Boolean)
  const remote = topology.primary?.fetchUrl
  const modeMarkers = detectGitModeMarkers(root)

  const parsedRefs = refsRes
    ? parseTagsAndOriginHead(refsRes.ok ? refsRes.stdout : '')
    : {
        tags: dotFast?.fastTags ?? [],
        originHeadBranch: dotFast?.originHeadBranch,
        localBranches: dotFast?.fastLocalBranches ?? [],
        remoteOriginBranches: dotFast?.fastRemoteOriginBranches ?? [],
      }
  const tags = parsedRefs.tags
  const originHeadBranch = parsedRefs.originHeadBranch
  const localBranches = parsedRefs.localBranches ?? []
  const remoteOriginBranches = parsedRefs.remoteOriginBranches ?? []
  const rawLogLines = logRes.ok && logRes.stdout ? logRes.stdout.split('\n').filter(Boolean) : []
  const historyAuthorsSet = new Set()
  const recentSubjects = []
  for (const line of rawLogLines) {
    const parts = line.split('\x1f')
    const author = parts[0] ?? ''
    const parents = (parts[1] ?? '').trim()
    const subj = parts[2] ?? ''
    if (!parents.includes(' ') && author) historyAuthorsSet.add(author)
    if (subj && recentSubjects.length < 20) recentSubjects.push(subj)
  }
  const historyAuthors = [...historyAuthorsSet]
  const commitStyle = detectCommitStyle(recentSubjects)
  const trackedPaths = fastTrackedPaths ?? (lsFiles?.ok && lsFiles.stdout ? lsFiles.stdout.split('\0').filter(Boolean) : [])
  const ignoredTracked = lsIgnoredRes.ok && lsIgnoredRes.stdout ? lsIgnoredRes.stdout.split('\0').filter(Boolean) : []

  const head = statusInfo.oid && statusInfo.oid !== '(initial)' ? statusInfo.oid : undefined
  let commits = 0
  let commitsState = 'ok'
  if (head !== undefined) {
    if (rawLogLines.length < 500) {
      commits = rawLogLines.length
    } else {
      const count = await git(root, ['rev-list', '--count', 'HEAD'])
      if (count.ok && /^\d+$/.test(count.stdout)) commits = Number(count.stdout)
      else commitsState = 'unreadable'
    }
  }

  const currentLikelyBranch = statusInfo.head && statusInfo.head !== '(detached)' && LIKELY_DEFAULT_BRANCHES.includes(statusInfo.head)
    ? statusInfo.head
    : undefined
  const existingLikelyBranch = LIKELY_DEFAULT_BRANCHES.find((b) => localBranches.includes(b) || remoteOriginBranches.includes(b))
  let auth = { https: 'undetermined', network: 'undetermined', reason: '默认不联网、不问凭据助手' }
  if (!remote && !probeAuth) {
    auth = { https: 'n/a', network: 'n/a', reason: '没有远端（需探测本机建仓凭据可加 --probe-auth）' }
  } else if (probeAuth) {
    const probe = await probePlatformEnv({
      cwd: root,
      remoteUrls,
      topology,
      branch: statusInfo.head,
      defaultBranch: originHeadBranch || currentLikelyBranch || existingLikelyBranch || 'main',
      verifyToken,
      mcpAvailable,
      offline,
      sshHostMap: effectiveHostMap,
    })
    auth = mapProbeToAuth(probe)
  }

  return {
    available: true,
    present: true,
    isRepoRoot,
    isBare: false,
    isShallow,
    workTreeRoot,
    insideWorkTree: insideFlag === 'true',
    branch: statusInfo.head,
    originHeadBranch: originHeadBranch ?? dotFast?.originHeadBranch,
    localBranches,
    remoteOriginBranches,
    commitStyle,
    upstream: statusInfo.upstream,
    ahead: statusInfo.ahead,
    behind: statusInfo.behind,
    dirty: statusInfo.dirty,
    remote,
    remotes: remoteNames,
    remoteUrls,
    remotePushUrls,
    remoteProtocol: topology.primary?.protocol,
    providerId: topology.primaryProviderId,
    topology: {
      mode: topology.mode,
      remotes: topology.remotes,
      primary: topology.primary,
      upstream: topology.upstream,
      isFork: topology.isFork,
      hasMultiRemotes: topology.hasMultiRemotes,
      providerIds: topology.providerIds,
      primaryProviderId: topology.primaryProviderId,
    },
    localMode: modeMarkers.localMode,
    forkMode: modeMarkers.forkMode,
    standaloneMode: modeMarkers.standaloneMode,
    reachableRoot: workTreeRoot,
    identity: {
      name: config.get('user.name')?.value,
      email: config.get('user.email')?.value,
      scope: config.get('user.name')?.scope ?? 'unset',
      credentialHelper: config.get('credential.helper')?.value,
      credentialHelperScope: config.get('credential.helper')?.scope,
    },
    tags,
    historyAuthors,
    commits,
    commitsState,
    trackedPaths: trackedPaths.length > 20000 ? trackedPaths.slice(0, 20000) : trackedPaths,
    trackedFiles: trackedPaths.length,
    head,
    initDefaultBranch: config.get('init.defaultbranch')?.value,
    auth,
    _sshHostMap: effectiveHostMap,
    _hasGit: true,
    _ignoredTracked: ignoredTracked,
    _statusIgnored: statusInfo.ignored,
  }
}

export function classifyHomePath(rel, line) {
  const path = String(rel ?? '').replace(/\\/g, '/')
  if (/(^|\/)(?:tests?|specs?|__tests__|fixtures?|examples?|__mocks__|testdata)(\/|$)/i.test(path)) return 'test-data'
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(path)) return 'test-data'
  if (/(^|\/)(?:docs\/work|docs\/tasks|work)(\/|$)/i.test(path)) return 'generated'
  if (/^changelog\.md$/i.test(path) || /(^|\/)release-notes\//i.test(path)) return 'generated'
  if (/\.(?:md|mdx|rst|txt)$/i.test(path)) {
    if (/[`'"]|<|>|\bexample\b|示例/i.test(line)) return 'doc-example'
    return 'leak'
  }
  return 'leak'
}

const SECRET_FAST_PRECHECK_RE = /(?:gh[pousr]_|github_pat_|npm_|pypi-|sk-(?:proj-)?|AKIA|-----BEGIN\s+(?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----)/

export function scanWorkspaceRaw(root) {
  const homeNorm = homedir().replace(/\\/g, '/')
  const homeLeaf = homeNorm.length > 4 ? basename(homeNorm).toLowerCase() : ''
  const homeRe = homeNorm.length > 4
    ? new RegExp(`(?<![\\w.\\-/:])${homeNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i')
    : undefined

  const files = []
  const dirs = []
  const nestedRepos = []
  let depthReached = 0
  let truncated = false

  const walk = (dir, depth) => {
    if (depth > 6 || files.length > 20000) { truncated = true; return }
    if (depth > depthReached) depthReached = depth
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isSymbolicLink() || isMacMetadataName(entry.name)) continue
      const full = join(dir, entry.name)
      const rel = relative(root, full).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (entry.name === '.git') {
          if (rel !== '.git') nestedRepos.push(rel)
          continue
        }
        if (entry.name === '.worktrees') continue
        dirs.push(rel)
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        if (entry.name === '.git') { nestedRepos.push(rel); continue }
        if (entry.name === '.gitmodules') nestedRepos.push(rel)
        let st
        try { st = statSync(full) } catch { continue }
        const rec = {
          rel,
          name: entry.name,
          full,
          size: st.size,
          text: null,
          textSecrets: null,
          textLeaks: null,
          unreadable: false,
        }
        if (TEXT_EXT.test(entry.name) && st.size <= 256 * 1024) {
          const text = readTextSafe(full)
          if (text === undefined) {
            rec.unreadable = true
          } else {
            rec.text = text
            const mightHaveSecret = SECRET_FAST_PRECHECK_RE.test(text)
            const mightHaveHome = Boolean(homeLeaf && text.toLowerCase().includes(homeLeaf))
            if (mightHaveSecret || mightHaveHome) {
              const lines = text.split('\n')
              for (let i = 0; i < lines.length; i += 1) {
                const line = lines[i]
                if (mightHaveSecret) {
                  for (const pat of SECRET_CONTENT_PATTERNS) {
                    if (pat.re.test(line)) {
                      if (!rec.textSecrets) rec.textSecrets = []
                      rec.textSecrets.push({ file: rel, line: i + 1, kind: pat.label })
                    }
                  }
                }
                if (mightHaveHome && homeRe.test(line.replace(/\\\\/g, '/').replace(/\\/g, '/'))) {
                  const category = classifyHomePath(rel, line)
                  if (category) {
                    if (!rec.textLeaks) rec.textLeaks = []
                    rec.textLeaks.push({ file: rel, line: i + 1, category })
                  }
                }
              }
            }
          }
        }
        files.push(rec)
      }
    }
  }
  walk(root, 0)
  const nestedUnique = [...new Set(nestedRepos.map((p) => p.replace(/\/?\.gitmodules$/, '').replace(/\/?\.git$/, '') || '.'))]
    .filter((p) => p !== '.')

  return { files, dirs, nestedUnique, depthReached, truncated }
}

export async function finalizeWalkWorkspace(root, raw, gitFacts) {
  const { files, dirs, nestedUnique, depthReached, truncated } = raw
  const canAskGit = gitFacts.present === true && gitFacts.isRepoRoot !== false
  const trackedSet = new Set(canAskGit ? gitFacts.trackedPaths : [])

  const ignoredSet = new Set(canAskGit ? (gitFacts._statusIgnored ?? []) : [])
  const ignoredTracked = canAskGit && Array.isArray(gitFacts._ignoredTracked)
    ? [...gitFacts._ignoredTracked]
    : []
  for (const p of ignoredTracked) ignoredSet.add(p)

  const hasIgnoredPrefix = (rel) => {
    if (ignoredSet.has(rel)) return true
    let slash = rel.indexOf('/')
    while (slash > 0) {
      if (ignoredSet.has(rel.slice(0, slash))) return true
      slash = rel.indexOf('/', slash + 1)
    }
    return false
  }

  if (canAskGit) {
    const checkList = []
    for (const d of dirs) {
      const leaf = d.split('/').pop()
      if (OUTPUT_DIRS.has(leaf) && !hasIgnoredPrefix(d)) checkList.push(d)
    }
    for (const f of files) {
      if (!trackedSet.has(f.rel) && !hasIgnoredPrefix(f.rel)) {
        const isSecret = SECRET_FILE_PATTERNS.some((re) => re.test(f.name)) && !SAFE_ENV_EXAMPLES.test(f.name)
        if (isSecret || OUTPUT_DIRS.has(f.rel.split('/')[0])) checkList.push(f.rel)
      }
    }
    if (checkList.length > 0) {
      const res = await git(root, ['check-ignore', '-z', '--stdin'], { input: `${checkList.join('\0')}\0` })
      if (res.ok || res.status === 1) {
        for (const item of res.stdout.split('\0')) {
          if (item) ignoredSet.add(item.replace(/\/$/, ''))
        }
      }
    }
    if (!Array.isArray(gitFacts._ignoredTracked)) {
      for (const p of trackedSet) if (ignoredSet.has(p)) ignoredTracked.push(p)
    }
  }

  let codeFiles = 0
  let codeLines = 0
  let docFiles = 0
  let effectiveFiles = 0
  let skippedLargeFiles = 0
  let unreadableFiles = 0
  const secretFiles = []
  const secretContent = []
  const homePathLeaks = []
  const largeFiles = []
  const unignoredOutputDirs = []

  for (const dir of dirs) {
    const leaf = dir.split('/').pop()
    if (OUTPUT_DIRS.has(leaf) && !hasIgnoredPrefix(dir)) unignoredOutputDirs.push(dir)
  }

  for (const file of files) {
    // 规模判据只读项目自己的东西。
    //
    // 工具装进项目里的技能源码不是这个项目的代码量：实测装套件前 codeFiles 是 40，
    // 装完变 86，于是 tier 从 single-pass 跳到 parallel-subagents——
    // **「先装套件还是先勘察」决定了这个项目该不该并行探索**。因果是倒的。
    const toolOwned = protocol.isToolOwnedPath(file.rel)
    if (!isJunkFile(file.rel) && !toolOwned) {
      effectiveFiles += 1
      if (CODE_EXT.test(file.name)) {
        codeFiles += 1
        // 行数只能从已经读进内存的文本里数，不为此多开一次 IO。
        if (typeof file.text === 'string') codeLines += protocol.countTextLines(file.text)
      } else if (DOC_EXT.test(file.name)) docFiles += 1
    }

    const tracked = trackedSet.has(file.rel)
    const ignored = hasIgnoredPrefix(file.rel)
    const fileSize = file.size

    if (fileSize >= 20 * 1024 * 1024 && !ignored) {
      largeFiles.push({ file: file.rel, sizeMB: Math.round(fileSize / (1024 * 1024)), tracked })
    }

    if (SECRET_FILE_PATTERNS.some((re) => re.test(file.name)) && !SAFE_ENV_EXAMPLES.test(file.name)) {
      const tooLarge = fileSize > 256 * 1024
      const status = !canAskGit ? 'undetermined'
        : tooLarge ? 'unverified-large'
          : tracked ? 'tracked' : (ignored ? 'ignored' : 'exposed')
      secretFiles.push({ file: file.rel, status, sizeKB: Math.round(fileSize / 1024) })
      if (tooLarge) skippedLargeFiles += 1
    }

    if (ignored || !TEXT_EXT.test(file.name) || fileSize > 256 * 1024) continue
    if (file.unreadable) { unreadableFiles += 1; continue }
    if (file.textSecrets) {
      for (const s of file.textSecrets) {
        secretContent.push({ ...s, status: tracked ? 'tracked' : 'exposed' })
      }
    }
    if (file.textLeaks) {
      homePathLeaks.push(...file.textLeaks)
    }
  }

  return {
    totalFiles: files.length,
    effectiveFiles,
    codeFiles,
    codeLines,
    docFiles,
    unignoredOutputDirs,
    ignoredButTracked: ignoredTracked,
    secretFiles,
    secretContent,
    homePathLeaks,
    largeFiles,
    scanCoverage: { truncated, depthReached, skippedLargeFiles, unreadableFiles },
    nestedRepos: nestedUnique,
  }
}

export async function walkWorkspace(root, gitFacts) {
  return finalizeWalkWorkspace(root, scanWorkspaceRaw(root), gitFacts)
}

const RELEASE_WORKFLOW_PATTERNS = [
  { tool: 'gh-release', re: /\bgh\s+release\b/i },
  { tool: 'npm-publish', re: /\b(?:npm|pnpm|bun)\s+publish\b|\byarn\s+npm\s+publish\b/i },
  { tool: 'pypi-publish', re: /\b(?:twine\s+upload|pypi-publish)\b|pypa\/gh-action-pypi-publish/i },
  { tool: 'cargo-publish', re: /\bcargo\s+publish\b/i },
  { tool: 'vsce-publish', re: /\b(?:vsce|ovsx)\s+publish\b/i },
  { tool: 'action-gh-release', re: /softprops\/action-gh-release|ncipollo\/release-action|actions\/create-release|actions\/upload-release-asset/i },
  { tool: 'goreleaser', re: /\bgoreleaser\b/i },
  { tool: 'release-please', re: /release-please-action|\brelease-please\b/i },
  { tool: 'changesets', re: /changesets\/action/i },
  { tool: 'semantic-release', re: /\bsemantic-release\b/i },
]

/**
 * 列出某个文档目录下**真实存在的文件**（相对仓库根的 posix 路径）。
 *
 * 只给「这个目录里有什么」，不做任何判断——判断在 `isReentryProject` 与
 * `hasRealContent` 里，那里才知道「空骨架」与「有正文」的区别。
 */
function listRelFiles(dirAbs, dirRel) {
  if (!existsSync(dirAbs)) return []
  let names = []
  try { names = readdirSync(dirAbs) } catch { return [] }
  return names
    .filter((name) => !isMacMetadataName(name))
    .sort()
    .map((name) => `${dirRel}/${name}`)
}

function detectExistingDesignDocs(root) {
  const found = new Set()
  const candidates = [
    'ARCHITECTURE.md', 'architecture.md', 'DESIGN.md', 'design.md',
    'docs/ARCHITECTURE.md', 'docs/architecture.md', 'docs/DESIGN.md', 'docs/design.md',
  ]
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) found.add(rel)
  }
  for (const dirRel of ['', 'docs']) {
    const dirAbs = dirRel ? join(root, dirRel) : root
    if (!existsSync(dirAbs)) continue
    let names = []
    try { names = readdirSync(dirAbs) } catch { continue }
    for (const name of names) {
      if (isMacMetadataName(name)) continue
      const fullRel = dirRel ? `${dirRel}/${name}` : name
      if (fullRel === 'docs/TDD.md') continue
      if (/(?:-|_)tdd\.md$|^tdd\.md$/i.test(name)) {
        found.add(fullRel)
      }
    }
  }
  for (const subRel of ['docs/design', 'docs/architecture', 'docs/adr']) {
    const subAbs = join(root, subRel)
    if (!existsSync(subAbs)) continue
    let entries = []
    try { entries = readdirSync(subAbs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isFile() || isMacMetadataName(entry.name) || entry.name === '.gitkeep') continue
      if (/\.(?:md|mdx|rst|txt)$/i.test(entry.name)) found.add(`${subRel}/${entry.name}`)
    }
  }
  return [...found].sort()
}

function detectOtherAiConventions(root) {
  const singles = [
    'CLAUDE.md', '.clinerules', '.cursorrules', '.windsurfrules', 'CONVENTIONS.md',
    '.github/copilot-instructions.md', 'GEMINI.md', 'COPILOT_INSTRUCTIONS.md',
  ].filter((rel) => existsSync(join(root, rel)))

  const dirs = ['.cursor/rules', '.roo/rules', '.github/instructions']
  const fromDirs = []
  for (const dir of dirs) {
    let names = []
    try { names = readdirSync(join(root, dir), { withFileTypes: true }) } catch { continue }
    for (const entry of names) {
      if (!entry.isFile() || isMacMetadataName(entry.name)) continue
      if (!/\.(?:md|mdc|txt|rules?)$/i.test(entry.name)) continue
      fromDirs.push(`${dir}/${entry.name}`)
    }
  }
  return [...singles, ...fromDirs]
}

function parseAgentMarkers(root, agents) {
  if (!agents) return { marks: 0, fills: [] }
  const text = readTextSafe(join(root, agents)) ?? ''
  const markers = parseMarkers(text, agents)
  return {
    marks: markers.length,
    fills: markers.filter((m) => m.kind === 'fill').map((m) => ({ line: m.line, what: m.what })),
  }
}

export function detectDocs(root) {
  let entries = []
  try { entries = readdirSync(root).filter((n) => !isMacMetadataName(n)) } catch {}
  const find = (name) => entries.find((e) => e.toLowerCase() === name.toLowerCase())

  const readmes = entries.filter((e) => /^readme(?:\.[a-z0-9_-]+)?\.md$/i.test(e))
  const agents = find('AGENTS.md')
  const contributing = find('CONTRIBUTING.md')
  const releasing = ['RELEASING.md', 'RELEASE.md', 'RELEASING.rst', 'docs/RELEASING.md', 'docs/releasing.md']
    .find((rel) => existsSync(join(root, rel)))
  const changelog = ['CHANGELOG.md', 'CHANGELOG.rst', 'CHANGES.md', 'HISTORY.md']
    .find((rel) => existsSync(join(root, rel)))
  const license = entries.find((e) => /^licen[cs]e(?:\..+|-.*)?$/i.test(e))
  const otherAiConventions = detectOtherAiConventions(root)

  const wfDir = join(root, '.github', 'workflows')
  const workflows = []
  const workflowFacts = {
    hasCheck: false,
    hasRelease: false,
    checkWorkflows: [],
    releaseWorkflows: [],
    releaseTools: [],
    usesPullRequestTarget: false,
    checkoutsPrHead: false,
    hasContentsWrite: false,
  }
  if (existsSync(wfDir)) {
    let names = []
    try { names = readdirSync(wfDir).filter((n) => !isMacMetadataName(n)) } catch {}
    for (const name of names) {
      if (!/\.ya?ml$/i.test(name)) continue
      workflows.push(name)
      const text = readTextSafe(join(wfDir, name)) ?? ''
      const activeText = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
      let matchedRelease = false
      for (const pat of RELEASE_WORKFLOW_PATTERNS) {
        if (pat.re.test(activeText)) {
          matchedRelease = true
          if (!workflowFacts.releaseTools.includes(pat.tool)) workflowFacts.releaseTools.push(pat.tool)
        }
      }
      if (matchedRelease) {
        workflowFacts.hasRelease = true
        workflowFacts.releaseWorkflows.push(name)
      }
      const hasCheckTrigger = !matchedRelease || /\bpull_request\b|\bbranches\s*:/.test(activeText)
      const hasCheckCmd = /\b(?:test|check|lint|preflight|verify|build|pytest|unittest|ctest)\b/i.test(activeText)
      if (hasCheckTrigger && hasCheckCmd) {
        workflowFacts.hasCheck = true
        workflowFacts.checkWorkflows.push(name)
      }
      if (/pull_request_target/.test(activeText)) workflowFacts.usesPullRequestTarget = true
      if (/github\.event\.pull_request\.(?:head\.(?:sha|ref)|number)/.test(activeText)) {
        workflowFacts.checkoutsPrHead = true
      }
      if (/permissions:[\s\S]{0,160}contents:\s*write/.test(activeText)) workflowFacts.hasContentsWrite = true
    }
  }

  const prTemplateFiles = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']
    .filter((rel) => existsSync(join(root, rel)))
  const issueDir = join(root, '.github', 'ISSUE_TEMPLATE')
  let issueTemplateFiles = []
  if (existsSync(issueDir)) {
    try {
      issueTemplateFiles = readdirSync(issueDir)
        .filter((f) => !isMacMetadataName(f) && /\.(?:md|ya?ml)$/i.test(f))
        .map((f) => `.github/ISSUE_TEMPLATE/${f}`)
    } catch {}
  }

  const tdd = existsSync(join(root, 'docs', 'TDD.md')) ? 'docs/TDD.md' : undefined
  const existingDesignDocs = detectExistingDesignDocs(root)
  const specsDir = existsSync(join(root, 'docs', 'specs'))
  const todoDir = existsSync(join(root, 'docs', 'todo'))
  const prdDir = existsSync(join(root, 'docs', 'prd'))
  // 「目录存在」与「目录里有真东西」是两件事：`equip` 会建空骨架，
  // 拿目录存在当「这个项目治理过」，等于让工具自己证明自己。
  const specsDirContent = listRelFiles(join(root, 'docs', 'specs'), 'docs/specs')
  const todoDirContent = listRelFiles(join(root, 'docs', 'todo'), 'docs/todo')
  let agentsBytes = 0
  if (agents) {
    try { agentsBytes = statSync(join(root, agents)).size } catch { agentsBytes = 0 }
  }

  return {
    readmes,
    readme: readmes[0],
    readmePair: readmes.length > 1,
    agents: agents ? { file: agents } : undefined,
    agentsBytes,
    agentsMarkers: parseAgentMarkers(root, agents),
    contributing,
    releasing,
    changelog,
    license,
    tdd,
    existingDesignDocs,
    specsDir,
    todoDir,
    prdDir,
    specsDirContent,
    todoDirContent,
    otherAiConventions,
    workflows,
    workflowFacts,
    prTemplate: prTemplateFiles.length > 0,
    prTemplateFile: prTemplateFiles[0],
    issueTemplates: issueTemplateFiles.length > 0,
    issueTemplateFiles,
  }
}

const WORK_DIR_CANDIDATES = ['docs/todo', 'docs/work', 'docs/tasks', 'todo', 'work']

function detectWorkflowTooling(root) {
  const found = []
  const singles = [
    'release-please-config.json', '.releaserc', '.releaserc.json', '.releaserc.yml',
    '.goreleaser.yml', '.goreleaser.yaml', 'goreleaser.yml', 'goreleaser.yaml',
    'commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs',
    'lefthook.yml', 'lefthook.yaml',
  ]
  for (const rel of singles) if (existsSync(join(root, rel))) found.push(rel)
  for (const dir of ['.changeset', '.husky']) {
    if (existsSync(join(root, dir))) found.push(`${dir}/`)
  }
  return found
}

export function detectConventions(root, { gitFacts, docs, ecosystem }) {
  const currentBranch = gitFacts.branch && gitFacts.branch !== '(detached)' ? gitFacts.branch : undefined
  const localSet = new Set(gitFacts.localBranches ?? [])
  const remoteOriginSet = new Set(gitFacts.remoteOriginBranches ?? [])
  const existingDefaultBranch = LIKELY_DEFAULT_BRANCHES.find((b) => localSet.has(b) || remoteOriginSet.has(b))
  const defaultBranch = gitFacts.originHeadBranch
    || (currentBranch && LIKELY_DEFAULT_BRANCHES.includes(currentBranch) ? currentBranch : undefined)
    || existingDefaultBranch
    || gitFacts.initDefaultBranch
    || 'main'

  const releaseNotesMode = docs.changelog ? 'changelog' : 'dir'
  const kinds = ecosystem.kinds ?? []
  const needsBareTag = kinds.some((k) => k === 'obsidian-plugin')
  const bareHistory = (gitFacts.tags ?? []).length > 0
    && (gitFacts.tags ?? []).every((t) => /^\d+\.\d+/.test(t))
  const tagPrefix = needsBareTag || bareHistory ? '' : 'v'
  const workDir = WORK_DIR_CANDIDATES.find((rel) => existsSync(join(root, rel))) ?? 'docs/todo'

  return {
    defaultBranch,
    releaseNotesMode,
    tagPrefix,
    commitStyle: gitFacts.commitStyle ?? 'plain',
    workDir,
    workflowTooling: detectWorkflowTooling(root),
  }
}
