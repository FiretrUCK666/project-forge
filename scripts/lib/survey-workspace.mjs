/**
 * survey-workspace.mjs —— 版本控制、工作区扫描、文档/工作流/设计体系与套件清单探测。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'

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
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout ?? 15000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
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
  return runCmd('git', ['-c', 'core.quotepath=false', ...args], { ...opts, cwd })
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
  const out = { head: undefined, oid: undefined, upstream: undefined, ahead: 0, behind: 0, dirty: 0 }
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('# branch.head ')) out.head = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) out.oid = line.slice(13).trim()
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(17).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line)
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]) }
    } else if (line.trim() !== '') out.dirty += 1
  }
  return out
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

export async function detectGit(root, opts = {}) {
  const { probeAuth = false, verifyToken = false, sshHostMap, mcpAvailable, offline } = opts
  const effectiveHostMap = sshHostMap === false ? {} : (sshHostMap ?? parseSshConfigHostMap())

  const [top, cfg, st, remotes, tagsRes, logRes, lsFiles, checkIgnore, originHead, bare, shallow] = await Promise.all([
    git(root, ['rev-parse', '--is-inside-work-tree', '--show-toplevel']),
    git(root, ['config', '--list', '--show-scope', '--show-origin']),
    git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
    git(root, ['remote', '-v']),
    git(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)', 'refs/tags']),
    git(root, ['log', '--format=%an <%ae>', '--no-merges', '-n', '200']),
    git(root, ['ls-files', '-z']),
    git(root, ['check-ignore', '-z', '--stdin'], { input: '' }),
    git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    git(root, ['rev-parse', '--is-bare-repository']),
    git(root, ['rev-parse', '--is-shallow-repository']),
  ])

  if (top.missing) {
    return { available: false, present: false, auth: { https: 'n/a', network: 'n/a' } }
  }
  const isBare = bare.ok && bare.stdout === 'true'
  if (isBare) {
    return {
      available: true,
      present: true,
      isBare: true,
      isShallow: false,
      isRepoRoot: true,
      workTreeRoot: root,
      barePath: root,
      branch: undefined,
      remote: undefined,
      remotes: [],
      remoteUrls: {},
      identity: { name: undefined, email: undefined, scope: 'unset' },
      commits: undefined,
      commitsState: 'unreadable',
      trackedPaths: [],
      trackedFiles: 0,
      nestedRepos: [],
      auth: { https: 'n/a', network: 'n/a', reason: '裸仓库没有工作区' },
    }
  }
  if (!top.ok || !top.stdout) {
    let auth = { https: 'n/a', network: 'n/a' }
    if (probeAuth) {
      const probe = await probeGitHubEnv({
        cwd: root,
        remoteUrls: {},
        verifyToken,
        mcpAvailable,
        offline,
        sshHostMap: effectiveHostMap,
      })
      auth = mapProbeToAuth(probe)
    }
    return { available: true, present: false, auth }
  }

  const isShallow = shallow.ok && shallow.stdout === 'true'
  const [insideFlag, workTreeRoot] = top.stdout.split('\n')
  const isRepoRoot = samePath(root, workTreeRoot)

  const config = parseConfigList(cfg.ok ? cfg.stdout : '')
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

  const tags = tagsRes.ok && tagsRes.stdout ? tagsRes.stdout.split('\n').filter(Boolean) : []
  const historyAuthors = logRes.ok && logRes.stdout
    ? [...new Set(logRes.stdout.split('\n').filter(Boolean))]
    : []
  const recentSubjects = logRes.ok && logRes.stdout
    ? (await git(root, ['log', '--format=%s', '-n', '20'])).stdout.split('\n').filter(Boolean)
    : []
  const commitStyle = detectCommitStyle(recentSubjects)
  const trackedPaths = lsFiles.ok && lsFiles.stdout ? lsFiles.stdout.split('\0').filter(Boolean) : []

  const head = statusInfo.oid && statusInfo.oid !== '(initial)' ? statusInfo.oid : undefined
  let commits = 0
  let commitsState = 'ok'
  if (head !== undefined) {
    const count = await git(root, ['rev-list', '--count', 'HEAD'])
    if (count.ok && /^\d+$/.test(count.stdout)) commits = Number(count.stdout)
    else commitsState = 'unreadable'
  }

  let auth = { https: 'undetermined', network: 'undetermined', reason: '默认不联网、不问凭据助手' }
  if (!remote && !probeAuth) {
    auth = { https: 'n/a', network: 'n/a', reason: '没有远端（需探测本机建仓凭据可加 --probe-auth）' }
  } else if (probeAuth) {
    const probe = await probePlatformEnv({
      cwd: root,
      remoteUrls,
      topology,
      branch: statusInfo.head,
      defaultBranch: parseOriginHead(originHead) || 'main',
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
    originHeadBranch: parseOriginHead(originHead),
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
    _ignoreProbeOk: checkIgnore.ok || checkIgnore.status === 1,
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

export async function walkWorkspace(root, gitFacts) {
  const canAskGit = gitFacts.present === true && gitFacts.isRepoRoot !== false
  const trackedSet = new Set(canAskGit ? gitFacts.trackedPaths : [])

  const homeNorm = homedir().replace(/\\/g, '/')
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
        files.push({ rel, name: entry.name, full })
      }
    }
  }
  walk(root, 0)
  const nestedUnique = [...new Set(nestedRepos.map((p) => p.replace(/\/?\.gitmodules$/, '').replace(/\/?\.git$/, '') || '.'))]
    .filter((p) => p !== '.')

  const ignoredSet = new Set()
  const ignoredTracked = []
  if (canAskGit) {
    const candidates = [...dirs, ...files.map((f) => f.rel)]
    if (candidates.length > 0) {
      const res = await git(root, ['check-ignore', '-z', '--stdin'], { input: `${candidates.join('\0')}\0` })
      if (res.ok || res.status === 1) {
        for (const item of res.stdout.split('\0')) if (item) ignoredSet.add(item)
      }
    }
    for (const p of trackedSet) if (ignoredSet.has(p)) ignoredTracked.push(p)
  }

  let codeFiles = 0
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
    if (OUTPUT_DIRS.has(leaf) && !ignoredSet.has(dir)) unignoredOutputDirs.push(dir)
  }

  for (const file of files) {
    if (!isJunkFile(file.rel)) {
      effectiveFiles += 1
      if (CODE_EXT.test(file.name)) codeFiles += 1
      else if (DOC_EXT.test(file.name)) docFiles += 1
    }

    const tracked = trackedSet.has(file.rel)
    const ignored = ignoredSet.has(file.rel)

    let st
    try { st = statSync(file.full) } catch { continue }
    if (st.size >= 20 * 1024 * 1024 && !ignored) {
      largeFiles.push({ file: file.rel, sizeMB: Math.round(st.size / (1024 * 1024)), tracked })
    }

    if (SECRET_FILE_PATTERNS.some((re) => re.test(file.name)) && !SAFE_ENV_EXAMPLES.test(file.name)) {
      const tooLarge = st.size > 256 * 1024
      const status = !canAskGit ? 'undetermined'
        : tooLarge ? 'unverified-large'
          : tracked ? 'tracked' : (ignored ? 'ignored' : 'exposed')
      secretFiles.push({ file: file.rel, status, sizeKB: Math.round(st.size / 1024) })
      if (tooLarge) skippedLargeFiles += 1
    }

    if (ignored || !TEXT_EXT.test(file.name) || st.size > 256 * 1024) continue
    const text = readTextSafe(file.full)
    if (text === undefined) { unreadableFiles += 1; continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const pat of SECRET_CONTENT_PATTERNS) {
        if (pat.re.test(line)) {
          secretContent.push({ file: file.rel, line: i + 1, kind: pat.label, status: tracked ? 'tracked' : 'exposed' })
        }
      }
      if (homeRe && homeRe.test(line.replace(/\\\\/g, '/').replace(/\\/g, '/'))) {
        const category = classifyHomePath(file.rel, line)
        if (category) homePathLeaks.push({ file: file.rel, line: i + 1, category })
      }
    }
  }

  return {
    totalFiles: files.length,
    effectiveFiles,
    codeFiles,
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
  const defaultBranch = gitFacts.originHeadBranch
    || (currentBranch && LIKELY_DEFAULT_BRANCHES.includes(currentBranch) ? currentBranch : undefined)
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
