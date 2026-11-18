/**
 * survey-workspace.mjs —— 版本控制、工作区扫描、文档/工作流/设计体系与套件清单探测。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'

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
import {
  detectCommitStyle,
  getSystemGitConfigEntriesAsync,
  hasIgnoredTrackedImpossibleFast,
  inspectDotGitFast,
  mapProbeToAuth,
  mergeScopeConfigFast,
  parseConfigList,
  parsePorcelainV2,
  parseTagsAndOriginHead,
  readGitIndexFast,
  readUserScopeConfigFast,
} from './survey-git-fast.mjs'

export { detectConventions, detectDocs } from './survey-docs.mjs'

const LIKELY_DEFAULT_BRANCHES = protocol.LIKELY_DEFAULT_BRANCHES ?? ['main', 'master', 'trunk', 'develop', 'default', 'development']

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
    hooksPath: config.get('core.hookspath')?.value,
    hooksPathScope: config.get('core.hookspath')?.scope,
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

export function scanWorkspaceRaw(root, opts = {}) {
  const homeNorm = homedir().replace(/\\/g, '/')
  const homeLeaf = homeNorm.length > 4 ? basename(homeNorm).toLowerCase() : ''
  const homeRe = homeNorm.length > 4
    ? new RegExp(`(?<![\\w.\\-/:])${homeNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i')
    : undefined

  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : 64
  const maxFiles = Number.isFinite(opts.maxFiles) ? opts.maxFiles : 20000
  const files = []
  const dirs = []
  const nestedRepos = []
  const seenRealDirs = new Set()
  let depthReached = 0
  let truncated = false

  const walk = (dir, depth) => {
    if (depth > maxDepth || files.length >= maxFiles) { truncated = true; return }
    let realDir = dir
    try { realDir = realpathSync(dir) } catch { return }
    if (seenRealDirs.has(realDir)) return
    seenRealDirs.add(realDir)
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

