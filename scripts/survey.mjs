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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 走目录时完全不进入的目录：它们装的是依赖、缓存或工具产物，**不可能是项目自己的源码**，
 * 因此既不参与体量统计，也不需要做凭据扫描。
 * 判据是「这个目录里的东西一定是外部获取或自动生成的」——拿不准的目录不要放这里。
 * 注意：这里不放 .git（版本控制元数据是另一回事），它由 walk() 单独跳过。
 */
const SKIP_DIRS = new Set([
  'node_modules', '.pnpm-store', '.yarn', 'bower_components',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.gradle', '.idea', '.vscode', '.cache', '.parcel-cache', '.turbo',
  '.docusaurus', '_site', '.tox', '.coverage', '.next', '.nuxt', '.svelte-kit',
])

/**
 * 名字像产物、但**也可能藏着源码或配置**的目录。
 *
 * 这类目录不能一概跳过：`bin/` 在 C++、Java 项目里是编译输出，在脚本项目里却常是源码
 * 目录，里面放个 `.env` 再正常不过；`vendor/` 在 PHP、Go 里是依赖，但里面也常常有被
 * 复制进来的凭据文件。曾经把它们当作「产物目录」整体跳过，结果是 `bin/.env` 里的
 * 访问密钥零命中——而报告仍显示「无命中」。
 *
 * 因此对它们采取折中：**统计体量时排除，做凭据扫描时进入**。体量统计错一点无关紧要，
 * 漏掉一个真凭据则是另一回事。
 */
const ARTIFACT_MAYBE_DIRS = new Set([
  'dist', 'build', 'out', 'bin', 'obj', 'target', 'vendor', 'release', 'debug',
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

/**
 * 这些同名文件是模板而非真凭据，不报为风险。
 *
 * 后缀是逐个列举的模板标记，**不按扩展名整类放行**：曾经在这里放行过 `*.md`，于是
 * 叫 `credentials.md` 或 `secrets.md` 的文件永远不会被报出来——而那恰恰是最该看一眼
 * 的文件名。宁可多报一个模板让人扫一眼，也不要漏报一个真凭据。
 */
const SECRET_FILE_ALLOWLIST = [
  /\.(example|sample|template|dist|tmpl|tpl)$/i,
  /^example[.-]/i,
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
const CONTENT_SCAN_MAX_FILES = 5000

// ── 工具函数 ────────────────────────────────────────────────────────────────

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error || r.status !== 0) return undefined
  return (r.stdout ?? '').trim()
}

/**
 * 与 run 相同，但关掉 git 对非 ASCII 路径的引号转义。
 *
 * git 默认把含非 ASCII 的路径输出成 `"\344\270\255..."` 这种带引号的八进制转义形式。
 * 那种形式的路径在我们这边既匹配不上文件、也读不出内容，于是这些文件会**静默地**从
 * 结果里消失——中文目录里的文件因此永远不被检查。
 * `-c core.quotepath=false` 让它按原样输出；`-z` 则进一步用 NUL 分隔，彻底避开转义与
 * 空格带来的解析歧义。
 */
function runGitPaths(args, cwd) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error || r.status !== 0) return undefined
  const out = r.stdout ?? ''
  // 使用 -z 时按 NUL 切分；否则按换行。两者都过滤空项。
  return out.includes('\0') ? out.split('\0').filter(Boolean) : out.split('\n').filter(Boolean)
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
    // 走查时顺手收集文本候选。内容级扫描必须用它，不能另找来源：
    // 这个 skill 的主场景是「给一个还没有版本库的项目配版本管理」，此时没有任何
    // 已跟踪文件可查；若扫描依赖版本控制，就会在最该拦住密钥的那一刻静默退化成
    // 只扫顶层，而报告仍显示「0 命中」，看起来像扫过了。
    textCandidates: [],
    contentScanTruncated: false,
  }
  // inCountingArea 为假时表示正走在「像产物、但可能藏源码」的目录里：
  // 这些文件要参与凭据扫描，但不计入体量（见 ARTIFACT_MAYBE_DIRS 的说明）。
  const stack = [{ dir: root, depth: 0, inCountingArea: true }]
  while (stack.length > 0) {
    const { dir, depth, inCountingArea } = stack.pop()
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
        if (SKIP_DIRS.has(entry.name.toLowerCase())) {
          if (!result.heavyDirs.includes(entry.name)) result.heavyDirs.push(entry.name)
          continue
        }
        if (entry.name === '.git') continue
        const isArtifactMaybe = ARTIFACT_MAYBE_DIRS.has(entry.name.toLowerCase())
        if (isArtifactMaybe && !result.heavyDirs.includes(entry.name)) {
          result.heavyDirs.push(entry.name)
        }
        // 嵌套仓库：子目录里另有一个 .git
        if (exists(join(full, '.git'))) result.nestedRepos.push(rel)
        stack.push({
          dir: full,
          depth: depth + 1,
          inCountingArea: inCountingArea && !isArtifactMaybe,
        })
        continue
      }
      if (!entry.isFile()) continue
      const size = sizeOf(full) ?? 0
      if (inCountingArea) {
        result.files += 1
        result.bytes += size
        if (size >= LARGE_FILE_BYTES) result.largeFiles.push({ path: rel, bytes: size })
      }
      if (isSecretFile(entry.name)) result.secretFiles.push(rel)
      if (size > 0 && size <= CONTENT_SCAN_MAX_BYTES && !CONTENT_SCAN_SKIP.test(rel)) {
        if (result.textCandidates.length < CONTENT_SCAN_MAX_FILES) result.textCandidates.push(rel)
        else result.contentScanTruncated = true
      }
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

/**
 * 源码扩展名 → 生态。用途是**兜底判断**：当项目没有任何已知清单文件、但明显是代码
 * 项目时，不能因为「没认出清单」就把它当成纯文档目录——那会让整条发布链路被跳过，
 * 而 DSH 插件形态还会漏掉「产物必须入库」这条关键判据。
 */
const SOURCE_EXT_KINDS = [
  [/\.(c|cc|cpp|cxx|h|hpp|hh|cxx)$/i, 'cpp'],
  [/\.cmake$/i, 'cpp'],
  [/\.(cs|fs|vb)$/i, 'dotnet'],
  [/\.(java|kt|kts|scala|groovy)$/i, 'java'],
  [/\.(rb|rake)$/i, 'ruby'],
  [/\.php$/i, 'php'],
  [/\.(rs)$/i, 'rust'],
  [/\.go$/i, 'go'],
  [/\.py$/i, 'python'],
  [/\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte)$/i, 'node'],
  [/\.(sh|bash|zsh|ps1)$/i, 'shell'],
  [/\.(swift)$/i, 'swift'],
  [/\.(lua)$/i, 'lua'],
  [/\.(r|rmd)$/i, 'r'],
  [/\.(jl)$/i, 'julia'],
  [/\.(dart)$/i, 'dart'],
  [/\.(ex|exs)$/i, 'elixir'],
  [/\.(erl|hrl)$/i, 'erlang'],
  [/\.(hs)$/i, 'haskell'],
  [/\.(pl|pm)$/i, 'perl'],
]

/** 构建描述文件 → 生态。它们本身不是清单，但足以说明「这是代码项目，不是文档目录」。 */
const BUILD_FILE_KINDS = [
  ['cmakelists.txt', 'cpp'], ['makefile', 'cpp'], ['meson.build', 'cpp'],
  ['configure.ac', 'cpp'], ['sconstruct', 'cpp'],
  ['dockerfile', 'shell'],
]

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
  } else if (cordisPatch !== undefined || skill !== undefined) {
    // 有插件配置或 skill 入口但没有 JS 清单：仍然可能是这两类形态，不能等到认出
    // package.json 才认。DSH 插件的「产物必须入库」判据依赖这个识别结果。
    if (cordisPatch !== undefined) { evidence.push(cordisPatch); kinds.push('dsh-plugin') }
    if (skill !== undefined) { evidence.push(`SKILL.md（name: ${skill.name}）`); kinds.push('dsh-skill') }
  }
  if (skill !== undefined && !kinds.includes('dsh-skill')) {
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
    ['pubspec.yaml', 'dart'], ['mix.exs', 'elixir'], ['project.clj', 'clojure'],
    ['package.swift', 'swift'], ['cpanfile', 'perl'],
  ]) {
    const real = root_.real(file)
    if (real !== undefined) { evidence.push(real); kinds.push(kind) }
  }
  for (const name of root_.filesIn('', /\.(csproj|fsproj|vbproj|sln)$/i)) {
    evidence.push(name); kinds.push('dotnet'); break
  }
  // 没有清单时，用源码与构建描述文件兜底：**它们证明这是代码项目**，
  // 从而避免被误判成纯文档目录。
  if (kinds.length === 0 || (kinds.length === 1 && kinds[0] === 'dsh-skill')) {
    const byBuild = root_.first(BUILD_FILE_KINDS.map(([f]) => f))
    if (byBuild !== undefined) {
      const kind = BUILD_FILE_KINDS.find(([f]) => f === byBuild.toLowerCase())?.[1]
      if (kind !== undefined) { evidence.push(`${byBuild}（构建描述文件，无清单）`); kinds.push(kind) }
    }
    const byExt = new Map()
    for (const name of root_.filesIn('', /\.[A-Za-z0-9]+$/)) {
      for (const [re, kind] of SOURCE_EXT_KINDS) {
        if (re.test(name)) {
          if (!byExt.has(kind)) byExt.set(kind, name)
          break
        }
      }
    }
    for (const [kind, sample] of byExt) {
      if (!kinds.includes(kind)) { evidence.push(`${sample}（源码扩展名，无清单文件）`); kinds.push(kind) }
    }
  }

  // 仍然什么都没认出来，才按目录性质区分。
  const unique = [...new Set(kinds)]
  if (unique.length === 0) {
    const hasMarkdown = root_.first(['README.md', 'README.rst', 'README.txt']) !== undefined
    // 判据是「除文档外还有没有别的东西」。只看「有没有文件」会把 Markdown 自己也算进去，
    // 于是纯文档目录永远判不出 docs-only。
    const nonDocFiles = root_.filesIn('', /./).filter((n) => !/\.(md|markdown|rst|txt|adoc)$/i.test(n))
    if (hasMarkdown && nonDocFiles.length === 0) {
      unique.push('docs-only')
      evidence.push('仅见 Markdown 文档')
    } else if (nonDocFiles.length > 0) {
      // 有文档也有别的东西，但没认出任何形态：不猜，交给上层问用户。
      unique.push('unrecognized')
      evidence.push(`未识别出项目形态（非文档文件示例：${nonDocFiles.slice(0, 3).join('、')}）`)
    } else unique.push('unknown')
  }
  return { kinds: unique, evidence, manifest: pkg, skill }
}

/** 从清单文件推导「怎么构建/测试/校验」。取不到就留空，不编造。 */
function deriveCommands(root, root_, eco) {
  const out = {}
  const pkg = eco.manifest
  if (pkg?.scripts !== undefined && typeof pkg.scripts === 'object') {
    // 先定包管理器：命令前缀由它决定。在 pnpm/yarn/bun 项目里写 npm run 是错的——
    // 轻则绕过了项目的约定，重则在 workspace 里直接失败。
    // 判据顺序：清单里的显式声明 > 锁文件 > 默认。
    let pm = 'npm'
    if (typeof pkg.packageManager === 'string' && pkg.packageManager.length > 0) {
      pm = pkg.packageManager.split('@')[0]
    } else if (root_.has('pnpm-lock.yaml') || root_.has('pnpm-workspace.yaml')) pm = 'pnpm'
    else if (root_.has('yarn.lock')) pm = 'yarn'
    else if (root_.has('bun.lockb') || root_.has('bun.lock')) pm = 'bun'
    out.packageManager = pm

    const run = (script) => (pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`)
    for (const [key, aliases] of [
      ['install', ['install']], ['build', ['build']], ['test', ['test']],
      ['typecheck', ['typecheck', 'type-check', 'tsc']], ['lint', ['lint']],
      ['verify', ['verify', 'check', 'validate']], ['smoke', ['smoke']],
    ]) {
      const hit = aliases.find((a) => typeof pkg.scripts[a] === 'string')
      if (hit !== undefined) out[key] = run(hit)
    }
    // 依赖安装命令用同一个包管理器，不用 npm 兜底
    out.install = `${pm} install`
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
  // Rust 与 Go：命令只在**清单文件确实存在**时给出。
  //
  // 区别在这里：「有个 .rs 文件」只说明这个项目里有 Rust 代码，不说明它用 cargo 构建
  // （可能是别的构建系统，也可能只是嵌了一段）；而 `Cargo.toml` 是项目**自己声明**的
  // 「我是 cargo 项目」。前者是猜，后者是读。所以判据挂在清单文件上，不挂在生态判定上
  // ——生态可能是靠源码扩展名兜底认出来的。
  if (root_.has('cargo.toml')) {
    out.build = 'cargo build'
    out.test = 'cargo test'
  }
  if (root_.has('go.mod')) {
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
  // 匹配 README.md / README.en.md / readme.rst 等：语言后缀是可选的，别写死成单个点分。
  const readmes = root_.filesIn('', /^readme(\.[a-z]{2}(-[a-z]{2})?)?\.(md|markdown|rst|txt|adoc)$/i)
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

  // 关键区分：**这个目录本身是仓库根，还是只是处在别人的仓库里**。
  //
  // 目标目录若是某个外层仓库的子目录（放错位置，或想给一个子项目单独建库），下面那些
  // 查询会如实返回**外层仓库**的远端、分支与提交数。照单全收就会得出「已有远端，只补
  // 缺即可」的结论，然后把改动提交进、甚至推送到一个完全不相干的仓库——这是本 skill
  // 能造成的破坏里最严重的一种。
  const toplevel = run('git', ['rev-parse', '--show-toplevel'], root)
  const norm = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const isRepoRoot = toplevel !== undefined && norm(toplevel) === norm(root)

  const info = {
    available: true,
    present: true,
    isRepoRoot,
    workTreeRoot: toplevel,
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
  const tracked = runGitPaths(['ls-files', '-z'], root)
  info.trackedFiles = tracked === undefined ? undefined : tracked.length
  const upstream = run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root)
  info.upstream = upstream
  info.head = run('git', ['rev-parse', 'HEAD'], root)
  // 初始化新仓库前需要知道默认分支会叫什么。平台默认分支名不一致（有的 main、有的
  // master），而这件事由本地配置决定——提前读出来，免得建出来的分支名与用户预期不符。
  info.initDefaultBranch = run('git', ['config', '--get', 'init.defaultBranch'], root)
    ?? '(未配置，取决于 git 版本与平台默认)'

  // 不是仓库根时，上面这些值都属于外层仓库，对判定没有意义。明确标注，并给出正确的
  // 下一步——而不是让上层自己察觉「远端怎么有点眼生」。
  if (!isRepoRoot) {
    info.note = '该目录处在另一个仓库的工作区内，不是仓库根。上面的远端、分支与提交数'
      + '都属于那个外层仓库，不代表本目录的状态。给本目录建库前必须先与用户确认边界'
      + '（是并入外层仓库，还是在本目录单独建库）；在确认之前不要提交、也不要推送。'
  }
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
  // 必须关掉路径转义：含中文或空格的路径在默认输出里会被引号化，那种字符串既不是
  // 真实路径、也对不上任何文件，报出来等于没报。
  const ignoredButTracked = runGitPaths(['ls-files', '-i', '-c', '--exclude-standard', '-z'], root)
  if (ignoredButTracked !== undefined && ignoredButTracked.length > 0) {
    out.ignoredButTracked = ignoredButTracked
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

  // 内容级扫描的候选来自**递归走查**，不来自版本控制。
  //
  // 这里曾经用 `git ls-files` 取候选，未初始化仓库时退化到只扫顶层——而「给一个还没有
  // 版本库的项目配版本管理」正是本 skill 的主场景。后果是 src/ 里的 API key 一个都扫
  // 不到，报告仍显示「0 命中」，G2 据此放行提交。密钥门控的失效方式是最坏的一种：
  // 它看起来像在工作。
  //
  // 不作为的那些目录（依赖、构建产物）已在 walk() 里排除，所以递归的代价是有界的；
  // 超出上限时用 contentScanTruncated 如实标记，让上层知道扫描被截断了。
  const candidates = [...walked.textCandidates]
  const pushIf = (rel) => {
    if (root_.has(rel)) {
      const real = root_.real(rel)
      if (!candidates.includes(real)) candidates.push(real)
    }
  }
  for (const f of ['.env', '.env.local', '.npmrc', '.pypirc', '.netrc', 'docker-compose.yml',
    'docker-compose.yaml', '.git-credentials', 'config.json', 'settings.json']) pushIf(f)

  const scanned = scanContents(root, candidates)

  // 已跟踪但被忽略的文件也要单独报出来：忽略规则对它们无效，这是个独立的陷阱。
  const ignoredButTracked = detectIgnores(root, root_).ignoredButTracked

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
      // 说明这次内容扫描覆盖了多深。上层据此判断「0 命中」到底是真干净、还是没扫到：
      // 截断时不能把「没报」当成「没有」。
      contentScan: {
        filesScanned: candidates.length,
        truncated: walked.contentScanTruncated === true,
        scope: '递归（已排除依赖与构建产物目录、二进制与超大文件）',
      },
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
    if (s.git.isRepoRoot === false) {
      L.push('- **本目录不是仓库根**，它处在另一个仓库的工作区内：')
      L.push(`  - 外层仓库根：\`${yn(s.git.workTreeRoot)}\``)
      L.push('  - 下面这些值**属于外层仓库**，不代表本目录的状态。建库前先与用户确认边界，')
      L.push('    在确认之前不要提交、也不要推送。')
    }
    L.push(`- 分支：${yn(s.git.branch)}　提交数：${yn(s.git.commits)}　未提交：${yn(s.git.dirty)}`)
    if (Array.isArray(s.git.remotes) && s.git.remotes.length > 1) {
      L.push(`- 远端（${s.git.remotes.length} 个）：${s.git.remotes.join('、')}`)
      L.push(`  - 默认 origin：${s.git.remote === undefined ? '未设置' : s.git.remote}`)
      L.push(`  - 上游跟踪：${s.git.upstream === undefined ? '未设置' : s.git.upstream}`)
    } else {
      L.push(`- 远端：${s.git.remote === undefined ? '无' : s.git.remote}`)
      if (s.git.upstream === undefined) L.push('- 上游跟踪：未设置')
    }
    L.push(`- 署名：${yn(s.git.identity.name)} <${yn(s.git.identity.email)}>（${s.git.identity.scope}）`)
    if (Array.isArray(s.git.tags) && s.git.tags.length > 0) {
      const shown = s.git.tags.slice(-5)
      L.push(`- 已有版本标签 ${s.git.tags.length} 个：${shown.join('、')}`
        + (s.git.tags.length > shown.length ? '（仅列最近 5 个）' : ''))
    }
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
  if (cmds.length === 0) L.push('- 未推导出任何命令（正常结果：说明项目没声明这些命令，'
    + '不代表错误；此时 P7 的验证不成立，见 SKILL.md）')
  else for (const [k, v] of cmds) L.push(`- ${k}：\`${v}\``)
  if (s.ecosystem.kinds.filter((k) => k !== 'dsh-skill' && k !== 'docs-only').length > 1) {
    L.push('')
    L.push('- **注意：本项目命中多种生态**，上面每类命令只保留了一个（同名字段会互相覆盖）。'
      + '实际执行前请按生态分别确认，不要把某一个生态的命令当成全部。')
  }
  L.push('')
  L.push('## 发布相关事实')
  L.push('')
  const a = s.artifacts ?? {}
  L.push(`- 发布范围声明：${a.publishScope === undefined ? '无'
    : `${a.publishScope.kind}（${a.publishScope.entries.length} 项）`}`)
  L.push(`- 发布前钩子：${a.hooks === undefined || a.hooks.length === 0 ? '无' : a.hooks.join('、')}`)
  L.push(`- 标记为不可发布：${a.private === true ? '是' : '否'}`)
  L.push(`- 产物目录存在：${a.distDirsPresent === undefined || a.distDirsPresent.length === 0
    ? '无' : a.distDirsPresent.join('、')}`)
  L.push(`- 忽略配置文件：${a.hasNpmIgnore === true ? '有' : '无'}`)
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
  if (r.secretContent.length > 0) {
    for (const hit of r.secretContent.slice(0, 10)) L.push(`  - ${hit.path}（${hit.kind}）`)
  }
  L.push(`- 本机私有路径：${r.homePathLeaks.length === 0 ? '无' : r.homePathLeaks.length + ' 处'}`)
  L.push(`- 大文件（≥20MB）：${r.largeFiles.length === 0 ? '无' : r.largeFiles.map((f) => f.path).slice(0, 5).join('、')}`)
  L.push(`- 嵌套仓库：${r.nestedRepos.length === 0 ? '无' : r.nestedRepos.join('、')}`)
  const scan = r.contentScan
  if (scan !== undefined) {
    L.push(`- 内容扫描覆盖：${scan.filesScanned} 个文件（${scan.scope}）`
      + (scan.truncated ? ' **已达上限被截断，未报不等于没有**' : ''))
  }
  const ibt = s.ignores?.ignoredButTracked
  if (Array.isArray(ibt) && ibt.length > 0) {
    L.push(`- **已被跟踪又被忽略**：${ibt.length} 个（忽略规则对已跟踪文件无效，`
      + `这些文件仍在版本库里；要移除须先从索引删除）`)
    for (const p of ibt.slice(0, 5)) L.push(`  - ${p}`)
  }
  L.push('')
  L.push('## 体量')
  L.push('')
  L.push(`- 文件数：${s.scale.files}　总计：${humanBytes(s.scale.bytes)}`)
  if (s.scale.truncated === true) {
    L.push('- **走查达到上限被截断**，上面的体量是下界而非准确值')
  }
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

// 只有被直接执行时才跑 main；被 import 时只导出 survey，不产生副作用。
// 判据是入口脚本的路径，不依赖任何环境变量或平台特性。
const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) process.exitCode = main(process.argv)

export { survey, toMarkdown, humanBytes }
