#!/usr/bin/env node
/**
 * survey.mjs —— 只读勘察
 *
 * 把一个项目目录的现状读成一份结构化事实，供上层判定「该做哪些事」。
 * 它只读，不写任何文件；它的输出是判定能力的唯一依据，不做任何推测性补全：
 * 读不到的字段一律留空，不编造。
 *
 * 用法：
 *   node scripts/survey.mjs [目录] [--json|--markdown]
 *   --json      输出 JSON（默认，供机器消费）
 *   --markdown  输出给人看的摘要
 *
 * 依赖：只用 Node 内置模块。无第三方依赖，跨平台。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'

/**
 * 走目录时跳过的重型目录：它们只影响体量统计与忽略规则，不影响能力判定。
 * 注意：这里不放 .git —— 版本控制元数据是另一回事，混进来会让人误以为它是产物目录。
 * .git 由 walk() 单独跳过。
 */
const HEAVY_DIRS = new Set([
  'node_modules', '.pnpm-store', '.yarn', 'bower_components',
  '.venv', 'venv', 'env', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  'target', 'dist', 'build', 'out', 'bin', 'obj', '.next', '.nuxt', '.svelte-kit',
  'vendor', 'coverage', '.coverage', '.tox', '.gradle', '.idea', '.vscode',
  '.cache', '.parcel-cache', '.turbo', '.docusaurus', '_site',
])

/** 判定「不该进版本库」时用到的目录名（是否真的被忽略由 git 判定，这里只做提示）。 */
const OUTPUT_DIR_HINTS = [
  'node_modules', '.venv', 'venv', '__pycache__', 'target', 'dist', 'build',
  'out', '.next', '.nuxt', 'vendor', 'coverage', '.gradle', '.cache', '.turbo',
]

/** 敏感文件的判定：按文件名/后缀的形状命中，不依赖具体项目。 */
const SECRET_FILE_PATTERNS = [
  /^\.env(\..+)?$/i,                       // .env / .env.local（.env.example 单独放行）
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/i,
  /^(credentials|secrets?|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/i,
  /\.(token|secret|credential)s?$/i,
  /^service-account.*\.json$/i,
]

/** 这些同名文件是模板而非真凭据，不报为风险。 */
const SECRET_FILE_ALLOWLIST = [
  /\.example$/i, /\.sample$/i, /\.template$/i, /\.dist$/i, /\.md$/i,
]

/** 内容里的凭据形状。宁可少报形状，也不要制造噪音让人忽略真警报。 */
const SECRET_CONTENT_PATTERNS = [
  { label: 'GitHub 令牌', re: /gh[pousr]_[A-Za-z0-9]{20,}/ },
  { label: 'npm 令牌', re: /npm_[A-Za-z0-9]{30,}/ },
  { label: 'AWS 访问键', re: /AKIA[0-9A-Z]{16}/ },
  { label: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'Slack 令牌', re: /xox[abpsr]-[A-Za-z0-9-]{10,}/ },
  { label: 'Google API 键', re: /AIza[0-9A-Za-z_-]{35}/ },
]

/** 扫描内容时要跳过的文件（体积大或必然误报）。 */
const CONTENT_SCAN_SKIP = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|7z|rar|woff2?|ttf|otf|eot|mp[34]|mov|avi|so|dll|dylib|exe|bin|wasm|lock)$/i

/** 判定「是不是本机私有路径」的形状：只认明显的绝对路径写法，避免误伤文档示例。 */
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\\s"'`]+/g,
  /\/(?:home|Users)\/[A-Za-z0-9._-]+/g,
]

const MAX_WALK_ENTRIES = 200000
const MAX_WALK_DEPTH = 24
const LARGE_FILE_BYTES = 20 * 1024 * 1024
const CONTENT_SCAN_MAX_BYTES = 2 * 1024 * 1024

// ── 工具函数 ────────────────────────────────────────────────────────────────

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error || r.status !== 0) return undefined
  return (r.stdout ?? '').trim()
}

function readText(p) {
  try {
    // 去 BOM：带 BOM 的 JSON / YAML 在 Windows 上很常见，解析器会直接失败。
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

function readJson(p) {
  const t = readText(p)
  if (t === undefined) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

function exists(p) {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

function sizeOf(p) {
  try {
    return statSync(p).size
  } catch {
    return undefined
  }
}

/** 解析 frontmatter 里的 name/description（只为识别 skill 项目，不做完整 YAML 解析）。 */
function skillFrontmatter(text) {
  if (text === undefined) return undefined
  const normalized = text.replace(/^\uFEFF/, '')
  const lines = normalized.split(/\r?\n/)
  if (lines[0] !== '---') return undefined
  let end = -1
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') { end = i; break }
  }
  if (end < 0) return undefined
  const block = lines.slice(1, end).join('\n')
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, '')
  const hasDescription = /^description:\s*/m.test(block)
  if (name === undefined || !hasDescription) return undefined
  return { name, ok: /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) }
}

// ── 目录走查（体量、风险） ──────────────────────────────────────────────────

function walk(root) {
  const result = {
    files: 0,
    bytes: 0,
    truncated: false,
    heavyDirs: [],
    largeFiles: [],
    secretFiles: [],
    symlinks: [],
    nestedRepos: [],
    totalFilesSeen: 0,
  }
  const stack = [{ dir: root, depth: 0 }]
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    if (depth > MAX_WALK_DEPTH) continue
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (result.totalFilesSeen > MAX_WALK_ENTRIES) { result.truncated = true; return result }
      result.totalFilesSeen += 1
      const full = join(dir, entry.name)
      const rel = full.slice(root.length + 1)
      if (entry.isSymbolicLink()) {
        result.symlinks.push(rel)
        continue
      }
      if (entry.isDirectory()) {
        if (HEAVY_DIRS.has(entry.name)) {
          if (!result.heavyDirs.includes(entry.name)) result.heavyDirs.push(entry.name)
          continue
        }
        if (entry.name === '.git') continue
        // 嵌套仓库：子目录里另有一个 .git
        if (exists(join(full, '.git'))) result.nestedRepos.push(rel)
        stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      const size = sizeOf(full) ?? 0
      result.files += 1
      result.bytes += size
      if (size >= LARGE_FILE_BYTES) result.largeFiles.push({ path: rel, bytes: size })
      if (isSecretFile(entry.name)) result.secretFiles.push(rel)
    }
  }
  return result
}

function isSecretFile(name) {
  if (SECRET_FILE_ALLOWLIST.some((re) => re.test(name))) return false
  return SECRET_FILE_PATTERNS.some((re) => re.test(name))
}

/** 对文本文件做内容级扫描：凭据形状 + 本机私有路径。 */
function scanContents(root, candidates) {
  const secrets = []
  const homePaths = []
  for (const rel of candidates) {
    if (CONTENT_SCAN_SKIP.test(rel)) continue
    const full = join(root, rel)
    const size = sizeOf(full)
    if (size === undefined || size > CONTENT_SCAN_MAX_BYTES) continue
    const text = readText(full)
    if (text === undefined) continue
    for (const { label, re } of SECRET_CONTENT_PATTERNS) {
      if (re.test(text)) { secrets.push({ path: rel, kind: label }); break }
    }
    for (const re of HOME_PATH_PATTERNS) {
      const m = text.match(re)
      if (m !== null && m.length > 0) { homePaths.push({ path: rel, sample: m[0] }); break }
    }
  }
  return { secrets, homePaths }
}

/**
 * 列一次顶层目录，之后所有文件名判定都查这张表。
 *
 * 不逐个 existsSync 试探的理由：大小写不敏感的文件系统（Windows、macOS 默认）上，
 * 试探 README.md 与 readme.md 会双双命中同一个文件，于是报出并不存在的「重复」。
 * 以真实目录项为准，就没有这个问题，顺便也更快。
 */
function listRoot(root) {
  const table = new Map()
  try {
    for (const entry of readdirSync(root, { withFileTypes: true, encoding: 'utf8' })) {
      if (entry.isSymbolicLink()) continue
      table.set(entry.name.toLowerCase(), {
        name: entry.name,
        isFile: entry.isFile(),
        isDir: entry.isDirectory(),
      })
    }
  } catch { /* 读不到就当空目录 */ }
  return {
    has(name) { return table.has(name.toLowerCase()) },
    /** 返回目录里的真实文件名（保留原始大小写），不存在则 undefined。 */
    real(name) { return table.get(name.toLowerCase())?.name },
    entry(name) { return table.get(name.toLowerCase()) },
    /** 在候选名里找第一个存在的，返回真实文件名。 */
    first(candidates) {
      for (const c of candidates) {
        const hit = table.get(c.toLowerCase())
        if (hit !== undefined) return hit.name
      }
      return undefined
    },
    filesIn(prefix, re) {
      const out = []
      const lower = prefix.toLowerCase()
      for (const [key, e] of table) {
        if (!key.startsWith(lower) || !e.isFile) continue
        if (re.test(e.name)) out.push(e.name)
      }
      return out
    },
  }
}

// ── 生态判定 ────────────────────────────────────────────────────────────────

function detectEcosystem(root, root_) {
  const evidence = []
  const kinds = []
  const pkg = readJson(join(root, root_.real('package.json') ?? 'package.json'))
  const cordisPatch = root_.first(['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml'])
  const skillFile = root_.first(['SKILL.md', 'skill.md'])
  const skillText = skillFile === undefined ? undefined : readText(join(root, skillFile))
  const skill = skillFrontmatter(skillText)

  if (pkg !== undefined) {
    evidence.push(root_.real('package.json'))
    kinds.push('node')
    if (pkg.dsh?.bundle !== undefined || cordisPatch !== undefined) {
      evidence.push(cordisPatch !== undefined ? cordisPatch : 'package.json 的 dsh.bundle 声明')
      kinds.push('dsh-plugin')
    }
  }
  if (skill !== undefined) {
    evidence.push(`SKILL.md（name: ${skill.name}）`)
    kinds.push('dsh-skill')
  }
  for (const [file, kind] of [
    ['pyproject.toml', 'python'], ['setup.py', 'python'], ['setup.cfg', 'python'],
    ['requirements.txt', 'python'], ['pipfile', 'python'],
    ['cargo.toml', 'rust'],
    ['go.mod', 'go'],
    ['pom.xml', 'java'], ['build.gradle', 'java'], ['build.gradle.kts', 'java'],
    ['gemfile', 'ruby'], ['composer.json', 'php'],
  ]) {
    const real = root_.real(file)
    if (real !== undefined) { evidence.push(real); kinds.push(kind) }
  }
  for (const name of root_.filesIn('', /\.(csproj|fsproj|vbproj|sln)$/i)) {
    evidence.push(name); kinds.push('dotnet'); break
  }

  const unique = [...new Set(kinds)]
  if (unique.length === 0) {
    const hasMarkdown = root_.first(['README.md', 'README.rst', 'README.txt']) !== undefined
      || skillFile !== undefined
    unique.push(hasMarkdown ? 'docs-only' : 'unknown')
    if (hasMarkdown) evidence.push('仅见 Markdown 文档')
  }
  return { kinds: unique, evidence, manifest: pkg, skill }
}

/** 从清单文件推导「怎么构建/测试/校验」。取不到就留空，不编造。 */
function deriveCommands(root, root_, eco) {
  const out = {}
  const pkg = eco.manifest
  if (pkg?.scripts !== undefined && typeof pkg.scripts === 'object') {
    for (const [key, aliases] of [
      ['install', ['install']], ['build', ['build']], ['test', ['test']],
      ['typecheck', ['typecheck', 'type-check', 'tsc']], ['lint', ['lint']],
      ['verify', ['verify', 'check', 'validate']], ['smoke', ['smoke']],
    ]) {
      const hit = aliases.find((a) => typeof pkg.scripts[a] === 'string')
      if (hit !== undefined) out[key] = `npm run ${hit}`
    }
    if (pkg.packageManager !== undefined) out.packageManager = String(pkg.packageManager)
    else if (root_.has('pnpm-lock.yaml')) out.packageManager = 'pnpm'
    else if (root_.has('yarn.lock')) out.packageManager = 'yarn'
    else if (root_.has('bun.lockb') || root_.has('bun.lock')) out.packageManager = 'bun'
    else out.packageManager = 'npm'
  }
  if (eco.kinds.includes('python')) {
    const pyName = root_.real('pyproject.toml')
    const py = pyName === undefined ? '' : (readText(join(root, pyName)) ?? '')
    const hasPytest = root_.entry('tests')?.isDir === true
      || root_.has('pytest.ini') || /\[tool\.pytest/.test(py)
    if (hasPytest) out.test = 'python -m pytest'
    if (/\[tool\.ruff/.test(py) || root_.has('ruff.toml') || root_.has('.ruff.toml')) {
      out.lint = 'python -m ruff check .'
    }
    if (root_.has('requirements.txt')) out.install = 'pip install -r requirements.txt'
  }
  if (eco.kinds.includes('rust')) {
    out.build = 'cargo build'
    out.test = 'cargo test'
    out.lint = 'cargo clippy'
  }
  if (eco.kinds.includes('go')) {
    out.build = 'go build ./...'
    out.test = 'go test ./...'
  }
  return out
}

/** 发布相关的既成事实：决定「产物入不入库」和「发布范围」。 */
function detectArtifacts(root, root_, eco) {
  const facts = { publishScope: undefined, hooks: [], hasNpmIgnore: false, distDirsPresent: [] }
  const pkg = eco.manifest
  if (pkg !== undefined) {
    if (Array.isArray(pkg.files)) facts.publishScope = { kind: 'files-whitelist', entries: pkg.files }
    if (root_.has('.npmignore')) facts.hasNpmIgnore = true
    for (const hook of ['prepublishOnly', 'prepack', 'prepare', 'prepublish']) {
      if (typeof pkg.scripts?.[hook] === 'string') facts.hooks.push(hook)
    }
    if (pkg.private === true) facts.private = true
  }
  for (const d of ['dist', 'lib', 'build', 'out']) {
    const e = root_.entry(d)
    if (e?.isDir === true) facts.distDirsPresent.push(e.name)
  }
  return facts
}

function detectDocs(root, root_) {
  const docs = {}
  const readmes = root_.filesIn('', /^readme\.[a-z]+$/i)
  docs.readme = readmes
  for (const [key, candidates] of [
    ['agents', ['AGENTS.md', 'CLAUDE.md']],
    ['contributing', ['CONTRIBUTING.md', 'CONTRIBUTING.rst']],
    ['license', ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']],
    ['changelog', ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']],
    ['codeOfConduct', ['CODE_OF_CONDUCT.md']],
  ]) {
    const hit = root_.first(candidates)
    docs[key] = hit === undefined ? undefined : { file: hit, bytes: sizeOf(join(root, hit)) }
  }
  const ghEntry = root_.entry('.github')
  if (ghEntry?.isDir === true) {
    const gh = join(root, ghEntry.name)
    let entries = []
    try {
      for (const e of readdirSync(gh, { withFileTypes: true, encoding: 'utf8' })) entries.push(e.name)
    } catch { /* 忽略 */ }
    docs.githubDir = entries
    docs.issueTemplates = entries.some((n) => /^ISSUE_TEMPLATE/i.test(n))
    docs.prTemplate = entries.some((n) => /^pull_request_template/i.test(n))
    const wfEntry = loadSubdir(gh).entry('workflows')
    if (wfEntry?.isDir === true) {
      try {
        docs.workflows = readdirSync(join(gh, wfEntry.name), { encoding: 'utf8' })
          .filter((n) => /\.ya?ml$/.test(n))
      } catch { /* 忽略 */ }
    }
  }
  return docs
}

/** 对任意目录做与 listRoot 相同的列表视图。 */
function loadSubdir(dir) {
  return listRoot(dir)
}

function detectGit(root) {
  const version = run('git', ['--version'], root)
  if (version === undefined) return { available: false }
  const inside = run('git', ['rev-parse', '--is-inside-work-tree'], root)
  const present = inside === 'true'
  if (!present) return { available: true, present: false, version }
  const info = {
    available: true,
    present: true,
    version: run('git', ['--version'], root),
    branch: run('git', ['branch', '--show-current'], root),
    remote: run('git', ['remote', 'get-url', 'origin'], root),
    remotes: (run('git', ['remote'], root) ?? '').split('\n').filter(Boolean),
    identity: {
      name: run('git', ['config', 'user.name'], root),
      email: run('git', ['config', 'user.email'], root),
      scope: run('git', ['config', '--local', 'user.name'], root) !== undefined ? 'repo' : 'inherit',
      globalName: run('git', ['config', '--global', 'user.name'], root),
    },
    tags: (run('git', ['tag', '--list'], root) ?? '').split('\n').filter(Boolean),
  }
  const status = run('git', ['status', '--porcelain'], root)
  info.dirty = status === undefined ? undefined : status.split('\n').filter(Boolean).length
  const count = run('git', ['rev-list', '--count', 'HEAD'], root)
  info.commits = count === undefined ? 0 : Number(count)
  const tracked = run('git', ['ls-files'], root)
  info.trackedFiles = tracked === undefined ? undefined : tracked.split('\n').filter(Boolean).length
  const upstream = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)
  info.upstream = upstream
  info.head = run('git', ['rev-parse', 'HEAD'], root)
  return info
}

function detectIgnores(root, root_) {
  const out = {}
  const giName = root_.real('.gitignore')
  if (giName !== undefined) {
    const gi = join(root, giName)
    const text = readText(gi) ?? ''
    out.gitignore = {
      bytes: sizeOf(gi),
      lines: text.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.startsWith('#')).length,
    }
  }
  const gaName = root_.real('.gitattributes')
  if (gaName !== undefined) out.gitattributes = { bytes: sizeOf(join(root, gaName)) }

  // 重要：忽略规则对「已被跟踪」的文件无效——这里直接查出来。
  const ignoredButTracked = run('git', ['ls-files', '-i', '-c', '--exclude-standard'], root)
  if (ignoredButTracked !== undefined && ignoredButTracked !== '') {
    out.ignoredButTracked = ignoredButTracked.split('\n').filter(Boolean)
  }
  return out
}

// ── 组装 ────────────────────────────────────────────────────────────────────

function survey(target) {
  const root = resolve(target)
  if (!exists(root)) throw new Error(`目录不存在：${root}`)
  const st = statSync(root)
  if (!st.isDirectory()) throw new Error(`不是目录：${root}`)

  const root_ = listRoot(root)
  const eco = detectEcosystem(root, root_)
  const walked = walk(root)
  const git = detectGit(root)

  // 内容级扫描的候选 = 「一次 git add -A 会纳入的东西」。
  // 必须同时包含未被跟踪的文件：密钥门控的意义正在于首次提交之前，那时什么都还没被
  // 跟踪。只看已跟踪的文件，恰好会漏掉最该拦下的那一种。
  const candidates = []
  const pushIf = (rel) => { if (root_.has(rel)) candidates.push(root_.real(rel)) }
  for (const f of ['.env', '.env.local', '.npmrc', '.pypirc', '.netrc', 'docker-compose.yml',
    'docker-compose.yaml', '.git-credentials', 'config.json', 'settings.json']) pushIf(f)

  const tracked = run('git', ['ls-files'], root)
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard'], root)
  if (tracked !== undefined || untracked !== undefined) {
    for (const list of [tracked, untracked]) {
      if (list === undefined) continue
      for (const rel of list.split('\n').filter(Boolean)) {
        if (candidates.length > 4000) break
        candidates.push(rel)
      }
    }
  } else {
    // 没有 git 时退回顶层文件扫描
    try {
      for (const e of readdirSync(root, { withFileTypes: true, encoding: 'utf8' })) {
        if (e.isFile()) candidates.push(e.name)
      }
    } catch { /* 忽略 */ }
  }

  const scanned = scanContents(root, [...new Set(candidates)])

  return {
    target: { path: root, name: basename(root) },
    git,
    ecosystem: { kinds: eco.kinds, evidence: eco.evidence, skillName: eco.skill?.name },
    commands: deriveCommands(root, root_, eco),
    artifacts: detectArtifacts(root, root_, eco),
    docs: detectDocs(root, root_),
    ignores: detectIgnores(root, root_),
    outputs: {
      heavyDirsPresent: walked.heavyDirs,
      knownOutputDirs: OUTPUT_DIR_HINTS.filter((d) => root_.entry(d)?.isDir === true),
    },
    risks: {
      secretFiles: walked.secretFiles,
      secretContent: scanned.secrets,
      homePathLeaks: scanned.homePaths,
      largeFiles: walked.largeFiles.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
      symlinks: walked.symlinks.slice(0, 50),
      nestedRepos: walked.nestedRepos,
    },
    scale: {
      files: walked.files,
      bytes: walked.bytes,
      truncated: walked.truncated,
      note: '体量统计不含依赖目录与 .git',
    },
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

function humanBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function toMarkdown(s) {
  const L = []
  const yn = (v) => (v === undefined || v === null ? '—' : String(v))
  L.push(`# 勘察结果：${s.target.name}`)
  L.push('')
  L.push(`路径：\`${s.target.path}\``)
  L.push('')
  L.push('## 版本控制')
  L.push('')
  if (s.git.available !== true) L.push('- git 不可用')
  else if (s.git.present !== true) L.push('- 尚未初始化仓库')
  else {
    L.push(`- 分支：${yn(s.git.branch)}　提交数：${yn(s.git.commits)}　未提交：${yn(s.git.dirty)}`)
    L.push(`- 远端：${s.git.remote === undefined ? '无' : s.git.remote}`)
    L.push(`- 署名：${yn(s.git.identity.name)} <${yn(s.git.identity.email)}>（${s.git.identity.scope}）`)
    if (s.git.upstream === undefined) L.push('- 上游跟踪：未设置')
  }
  L.push('')
  L.push('## 生态判定')
  L.push('')
  L.push(`- 判定结果：${s.ecosystem.kinds.join(' / ')}`)
  L.push(`- 依据：${s.ecosystem.evidence.join('、') || '无'}`)
  L.push('')
  L.push('## 可执行命令')
  L.push('')
  const cmds = Object.entries(s.commands)
  if (cmds.length === 0) L.push('- 未推导出任何命令')
  else for (const [k, v] of cmds) L.push(`- ${k}：\`${v}\``)
  L.push('')
  L.push('## 文档现状')
  L.push('')
  for (const [k, v] of Object.entries(s.docs)) {
    if (v === undefined) L.push(`- ${k}：缺`)
    else if (Array.isArray(v)) L.push(`- ${k}：${v.length === 0 ? '缺' : v.join('、')}`)
    else if (typeof v === 'object' && v.file !== undefined) L.push(`- ${k}：${v.file}（${humanBytes(v.bytes)}）`)
    else L.push(`- ${k}：${JSON.stringify(v)}`)
  }
  L.push('')
  L.push('## 风险')
  L.push('')
  const r = s.risks
  L.push(`- 敏感文件：${r.secretFiles.length === 0 ? '无' : r.secretFiles.length + ' 个（' + r.secretFiles.slice(0, 5).join('、') + '）'}`)
  L.push(`- 内容里的凭据形状：${r.secretContent.length === 0 ? '无' : r.secretContent.length + ' 处'}`)
  L.push(`- 本机私有路径：${r.homePathLeaks.length === 0 ? '无' : r.homePathLeaks.length + ' 处'}`)
  L.push(`- 大文件（≥20MB）：${r.largeFiles.length === 0 ? '无' : r.largeFiles.map((f) => f.path).slice(0, 5).join('、')}`)
  L.push(`- 嵌套仓库：${r.nestedRepos.length === 0 ? '无' : r.nestedRepos.join('、')}`)
  L.push('')
  L.push('## 体量')
  L.push('')
  L.push(`- 文件数：${s.scale.files}　总计：${humanBytes(s.scale.bytes)}`)
  L.push(`- 依赖/产物目录：${s.outputs.heavyDirsPresent.join('、') || '无'}`)
  return L.join('\n')
}

// ── 入口 ────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2)
  const flags = args.filter((a) => a.startsWith('--'))
  const positional = args.filter((a) => !a.startsWith('--'))
  const target = positional[0] ?? process.cwd()
  const asMarkdown = flags.includes('--markdown')
  if (flags.includes('--help') || flags.includes('-h')) {
    process.stdout.write([
      '用法：node scripts/survey.mjs [目录] [--json|--markdown]',
      '',
      '  --json       输出 JSON（默认）',
      '  --markdown   输出给人看的摘要',
      '',
      '只读勘察：不写任何文件。',
      '',
    ].join('\n'))
    return 0
  }
  let result
  try {
    result = survey(target)
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    process.stderr.write(`勘察失败：${detail}\n`)
    return 1
  }
  process.stdout.write(asMarkdown ? `${toMarkdown(result)}\n` : `${JSON.stringify(result, null, 2)}\n`)
  return 0
}

process.exitCode = main(process.argv)
