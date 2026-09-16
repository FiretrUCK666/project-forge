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
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
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

/**
 * 判定「是不是本机私有路径」的形状。
 *
 * 两个必须同时覆盖的维度，漏一个就会静默失效：
 *   - **分隔符**：Windows 路径在源码里可能写成反斜杠也可能写成正斜杠（很多工具和
 *     配置文件一律用正斜杠）。只认反斜杠会让 `C:/Users/...` 完全不被发现；
 *   - **盘符**：`/Users/<名>` 这种截断形式要能匹配上，否则比对时缺少盘符段。
 *
 * 因此两个模式都用 `[\\/]` 接受两种分隔符，盘符部分可选。真正的性质判定交给
 * classifyHomePath()——形状匹配只是找出候选。
 */
const HOME_PATH_PATTERNS = [
  { re: /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+/g, volume: 'windows' },
  { re: /[\\/](?:home|Users)[\\/][^\\/\s"'`]+/g, volume: 'posix' },
]

/** 这些路径形状出现在测试与示例里是正常的，不该按「泄漏」处置。 */
const TEST_PATH_RE = /(^|[\\/])(tests?|specs?|__tests__|fixtures?|examples?|samples?|__mocks__|e2e)([\\/]|$)|\.(spec|test)\.[a-z]+$/i

/** 这些扩展名本身就是「给人看的文本」，里面的路径通常是示例。 */
const DOC_FILE_RE = /\.(md|markdown|rst|txt|adoc)$/i

/**
 * 把候选路径分成三档。
 *
 * 分档的意义在于**处置建议完全不同**：
 *   - 真泄漏 → 必须改（换台机器就会失准，或者已经把别人的目录结构发出去了）；
 *   - 测试数据 → **不要改**，改了测试就失去意义；报出来只会制造噪音；
 *   - 文档示例 → 多数是正常的跨平台写法，提示一下即可。
 *
 * 曾经这三档混为一谈：一个项目在测试里写了 `cwd: '/home/me/deepseek'` 作为假数据，
 * 勘察报「本机私有路径」并建议「改成相对路径或环境变量」——照着做就把测试改坏了。
 */
function classifyHomePath(rel, sample, realHomes) {
  const flat = (v) => v.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const normalized = flat(sample)

  // 比对本机真实主目录。
  //
  // 不能只做 startsWith：匹配到的片段常常缺少盘符（`/Users/x` 是从 `C:/Users/x` 里
  // 截出来的），直接比会判不出来——而那正是「真泄漏被判成 other、于是不提醒」的成因。
  // 所以同时比对「末尾两段」这种带边界的特征，它在两种截断形式下都成立。
  for (const home of realHomes) {
    const h = flat(home)
    if (h === '') continue
    if (normalized.startsWith(h)) return LEAK
    const tail = h.split('/').slice(-2).join('/')
    if (tail.split('/').length === 2 && (`/${normalized}/`).includes(`/${tail}/`)) return LEAK
    if (`/${normalized}/`.includes(`/${h}/`)) return LEAK
  }
  if (TEST_PATH_RE.test(rel)) return TEST_DATA
  if (DOC_FILE_RE.test(rel)) return DOC_EXAMPLE
  return OTHER
}

const LEAK = {
  kind: 'leak',
  advice: '这是本机真实主目录，换台机器就会失准，也可能已经暴露了你的目录结构——'
    + '改成相对路径或环境变量。',
}
const TEST_DATA = {
  kind: 'test-data',
  advice: '位于测试或示例目录，通常是有意写的假路径——**不要为了消除提示去改它**。'
    + '只有当它确实来自本机时才需要处理。',
}
const DOC_EXAMPLE = {
  kind: 'doc-example',
  advice: '位于文档中，通常是跨平台示例写法。确认一下是不是真实路径即可，一般无需改动。',
}
const OTHER = {
  kind: 'other',
  advice: '不像本机路径，可能是从别的机器带过来的。确认它是否应该写成相对路径。',
}

/** 本机可能的主目录写法：同时取环境变量与系统 API 的结果，去重后转成小写正斜杠。 */
function realHomeSpellings() {
  const out = new Set()
  const push = (v) => {
    if (typeof v !== 'string' || v.trim() === '') return
    out.add(v.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase())
  }
  try {
    push(homedir())
  } catch { /* 取不到就只靠环境变量 */ }
  push(process.env.HOME)
  push(process.env.USERPROFILE)
  return [...out]
}

const MAX_WALK_ENTRIES = 200000
const MAX_WALK_DEPTH = 24
const LARGE_FILE_BYTES = 20 * 1024 * 1024
const CONTENT_SCAN_MAX_BYTES = 2 * 1024 * 1024
const CONTENT_SCAN_MAX_FILES = 5000
/** 单个工作流文件只读的前 N 字符；超限置 truncated，值随输出携带。 */
const WORKFLOW_HEAD_LIMIT = 65536

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

/**
 * 一批路径里哪些被忽略规则覆盖。返回 Set（统一成 POSIX 分隔符）。
 *
 * **一次进程判定全部候选**（`check-ignore --stdin -z`）：逐个 spawn 的代价随候选数
 * 线性增长，那正是旧实现只敢探一层深的原因。`-z` 让路径按字节进出，含空格与中文的
 * 路径不会被引号化改写成另一个字符串。
 * 退出码 1 = 「一个都没忽略」，那是正常结果不是错误；取不到 git 也返回空集——
 * 调用方据此走「没有证据」的分支，不许当成「已忽略」。
 */
function gitIgnoredSet(cwd, relPaths) {
  const list = (relPaths ?? []).filter((p) => typeof p === 'string' && p !== '')
  if (list.length === 0) return new Set()
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'check-ignore', '-z', '--stdin'], {
    cwd, encoding: 'utf8', windowsHide: true,
    input: `${list.join('\0')}\0`, maxBuffer: 16 * 1024 * 1024,
  })
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1)) return new Set()
  return new Set(String(r.stdout ?? '').split('\0').filter(Boolean).map((p) => p.replace(/\\/g, '/')))
}

function readText(p) {
  try {
    // 去 BOM：带 BOM 的 JSON / YAML 在 Windows 上很常见，解析器会直接失败。
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

/**
 * 读 JSON：**结果形状只有两种**——对象或 `{ __corrupt: true }`。
 *
 * `JSON.parse` 合法的结果不止对象（`null`、数组、字符串、数字都是合法 JSON），
 * 而所有消费点都按对象用（`pkg.__corrupt`、`obs.minAppVersion`）。曾经有一个
 * package.json 内容为 `null` 就把整次勘察打断（`Cannot read properties of null`），
 * 于是「清单损坏」这种可预期的形态变成崩溃。这里一次归一，消费点就不必各写守卫。
 */
function readJson(p) {
  const t = readText(p)
  if (t === undefined) return undefined
  let parsed
  try {
    parsed = JSON.parse(t)
  } catch {
    return { __corrupt: true }
  }
  if (parsed !== null && typeof parsed === 'object') return parsed
  return { __corrupt: true }
}

/**
 * 本文件是不是被**直接执行**（而不是被 import）。
 *
 * 判据不能用字面路径比较：`process.argv[1]` 保留调用方写下的写法，而
 * `import.meta.url` 已被 Node 解析成真实路径。经 junction / 符号链接调用时两者
 * 永不相等，脚本于是**什么都不做并返回 0**——实测 preflight 走 junction 就是这样：
 * exit 0、零输出，CI 与人都会读成「自检通过」。所以这里按真实路径归一后比较。
 *
 * 判不出来（文件不存在等）时返回 false：被 import 才是常态，且 import 侧有守卫
 * 兜底（调用方必须自己保证「没跑就报错」，不能靠这里返回真来掩盖）。
 */
export function isMainModule(metaUrl, argv1) {
  if (typeof argv1 !== 'string' || argv1 === '') return false
  const target = fileURLToPath(metaUrl)
  try {
    if (resolve(argv1) === resolve(target)) return true
  } catch { /* 路径非法就走真实路径比较 */ }
  const real = (p) => {
    try { return realpathSync.native(p) } catch { return undefined }
  }
  const a = real(argv1)
  const b = real(target)
  return a !== undefined && b !== undefined && a === b
}

/**
 * 数 AGENTS.md 里的待填写标记（`<!-- pf:author: … -->`），并给出它所在的小节。
 *
 * **整篇扫描，不逐行**：标记可以写成多行（`<!-- pf:author:` 换行后 `-->`），
 * 逐行扫会漏掉它们——而那正是「脚本报 0 处、脚手架被删、TODO 还留在正文」的成因。
 * compose-agents 与 review 都用这一份，不再各写一份再对齐。
 */
export function authorMarkers(text) {
  const re = /<!--\s*pf:author\s*(?::[\s\S]*?)?-->/g
  const found = []
  let lastHeading = '(文件开头)'
  let cursor = 0
  for (const hit of String(text).matchAll(re)) {
    const before = String(text).slice(cursor, hit.index)
    for (const line of before.split('\n')) {
      const h = /^#{2,3}\s+(.+?)\s*$/.exec(line)
      if (h !== null) lastHeading = h[1]
    }
    cursor = hit.index + hit[0].length
    const note = /pf:author:\s*([\s\S]*?)\s*-->/.exec(hit[0])
    found.push({ section: lastHeading, note: note === null ? '' : note[1] })
  }
  return found
}

/**
 * 从远端地址里取 owner/name（GitHub）。取不到返回 undefined——**不编造**。
 *
 * 判据是「剥掉可能的 .git 后缀，再取路径的最后两段」，**不能按点切分**：仓库名允许
 * 含点（\`next.js\`、\`my.repo\`），用排除点的字符类会把名字截断，于是生成一条指向不存在
 * 仓库的对比链接（实测 \`acme/my.repo\` → \`acme/my\`）。域名比较大小写不敏感。
 * 这个判定只实现一处：draft-release-notes 与 release-notes 都引用它。
 */
export function parseGitHubRepo(url) {
  if (typeof url !== 'string') return undefined
  const m = /github\.com[/:](.+)$/i.exec(url.trim())
  if (m === null) return undefined
  const parts = m[1].replace(/\.git$/i, '').replace(/\/+$/, '').split('/').filter(Boolean)
  if (parts.length < 2) return undefined
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
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

/**
 * 判断两个路径是否指向同一个位置。
 *
 * 逐字符比较是不够的，在 Windows 上会大面积误判——同一个目录至少有四种写法会被当成
 * 不同路径：大小写不同（盘符或任意层级）、8.3 短名（`C:\Users\FIRETR~1\...`）、
 * 正反斜杠混用、以及经由 junction 或符号链接到达。这些形式在真实环境里到处都是
 * （环境变量 `%TEMP%` 就常常是短名形式），误判的后果不轻：目录明明就是仓库根，却被
 * 报成「在别人的仓库里」，于是整条流程按规则停下来并警告「不要提交、不要推送」。
 *
 * 因此按三层逐级放宽：字面 → realpath 归一化 → 大小写不敏感比较（仅在大小写不敏感
 * 的平台上）。任一层相等即认为相同。
 */
function samePath(a, b) {
  const flat = (p) => resolve(p).replace(/\\/g, '/').replace(/\/+$/, '')
  const fa = flat(a)
  const fb = flat(b)
  if (fa === fb) return true

  // realpath 同时解决短名、符号链接与 junction
  const real = (p) => {
    try {
      return flat(realpathSync.native(p))
    } catch {
      return undefined
    }
  }
  const ra = real(a)
  const rb = real(b)
  if (ra !== undefined && rb !== undefined && ra === rb) return true

  // 大小写：Windows 与 macOS 默认不敏感。用「同一路径的两种写法是否都解析到同一个
  // realpath」来判定平台的敏感性，而不是硬编码平台名。
  if (ra !== undefined && rb !== undefined) {
    const probe = real(ra.toUpperCase())
    if (probe !== undefined && probe === ra) {
      return ra.toLowerCase() === rb.toLowerCase()
    }
  }
  return false
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
    // 被排除在内容扫描之外的文件数，按原因分开数。
    // 这些数字是必须的：四类排除（超体积、扩展名黑名单、读不出来、非 UTF-8）
    // 过去都不出现在报告里，于是「0 命中」被读成「扫过了、很干净」——
    // 实测一个 2.1MiB 的 .txt（只超上限 100 字节，里面是真令牌）就这样静默漏掉。
    skippedLarge: 0,
    skippedByExtension: 0,
    // 产物目录候选（全树、任何深度），由 detectIgnores 一次批处理判定忽略与否。
    outputDirCandidates: [],
    // 深度超限被跳过的子树数量。
    //
    // 这个计数是必须的：递归有深度上限（防止符号链接环或病态嵌套把扫描拖死），但
    // **静默地不扫**是最坏的结果——报告里写着「递归、已排除依赖目录」，读起来像全扫过了。
    // 实测过：30 层处的 `.env` 既不计数也不扫描，`truncated` 还是 false。
    depthLimited: 0,
    depthLimitedPaths: [],
    // 生态兜底判定要用的证据：走查时顺手在**全树**里找源码与构建描述文件。
    // 只在顶层找是不够的——真实项目的代码几乎总在 src/、packages/、cmd/ 这类子目录下。
    sourceScan: {
      byExtension: new Map(),        // 生态 → 首个命中的源码文件
      byBuildFile: new Map(),        // 生态 → 首个命中的构建描述文件
      byNestedManifest: new Map(),   // 生态 → 子目录里的首个清单（monorepo 线索）
      nonDocSamples: [],             // 疑似「非文档」的文件（用于区分纯文档目录）
    },
  }
  // inCountingArea 为假时表示正走在「像产物、但可能藏源码」的目录里：
  // 这些文件要参与凭据扫描，但不计入体量（见 ARTIFACT_MAYBE_DIRS 的说明）。
  const stack = [{ dir: root, depth: 0, inCountingArea: true }]
  while (stack.length > 0) {
    const { dir, depth, inCountingArea } = stack.pop()
    if (depth > MAX_WALK_DEPTH) {
      result.depthLimited += 1
      if (result.depthLimitedPaths.length < 20) result.depthLimitedPaths.push(dir.slice(root.length + 1) || '.')
      continue
    }
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
          if (depth === 0 && !result.heavyDirs.includes(entry.name)) result.heavyDirs.push(entry.name)
          continue
        }
        if (entry.name === '.git') continue
        const isArtifactMaybe = ARTIFACT_MAYBE_DIRS.has(entry.name.toLowerCase())
        if (depth === 0 && isArtifactMaybe && !result.heavyDirs.includes(entry.name)) {
          result.heavyDirs.push(entry.name)
        }
        // 产物目录候选：**全树任何深度**都收，不猜「只下沉一层」。
        // 曾经只探到 depth=1（`packages/<名字恰为 dist>`），而标准 monorepo 布局是
        // `packages/<包名>/dist`——实测 200 个未忽略的产物目录只报出 1 个，
        // 也就是说它们会被下一次 `git add -A` 整个写进历史，而门禁一声不响。
        // 判据交给版本控制：候选全量收齐后，一次 `git check-ignore --stdin` 批处理。
        if (OUTPUT_DIR_HINTS.includes(entry.name.toLowerCase())) result.outputDirCandidates.push(rel)
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
      } else if (size > CONTENT_SCAN_MAX_BYTES) {
        // 「没扫到」也是事实：超单文件上限的文件数要报出来，
        // 否则「0 命中」会被读成「扫过了、很干净」。
        result.skippedLarge += 1
      } else if (size > 0 && CONTENT_SCAN_SKIP.test(rel)) {
        result.skippedByExtension += 1
      }
      collectSourceEvidence(result.sourceScan, entry.name, rel, depth)
    }
  }
  return result
}

function isSecretFile(name) {
  if (SECRET_FILE_ALLOWLIST.some((re) => re.test(name))) return false
  return SECRET_FILE_PATTERNS.some((re) => re.test(name))
}

/** 文档类扩展名：它们不算「这个项目里有代码」的证据。 */
const DOC_EXT_RE = /\.(md|markdown|rst|txt|adoc|asciidoc|org)$/i

/**
 * README 及其语言变体：`README.md`、`README.en.md`、`README_CN.md`、`README.zh-CN.md`
 * 这几种写法都常见。
 *
 * **这一个正则同时管「收集文件」与「识别语言变体」**，不要再写第二个。
 * 曾经有两个：收集用的那个只认点分隔（`(\.[a-z]{2})?`），语言识别用的那个认点与下划线。
 * 于是 `README_CN.md` 根本进不了列表——语言识别的正则再宽松也没用，那个文件压根没被看到。
 * 两处规则表达同一件事时，先失效的永远是更窄的那个，而且失效得无声无息。
 */
const README_RE = /^readme([._-][a-z]{2}(?:[._-][a-z]{2})?)?\.(md|markdown|rst|txt|adoc)$/i

/**
 * README 文件名判据（含语言变体）——**全仓只此一份**：preflight 的「顶层未登记条目」
 * 豁免也用它。曾经两处各写一份，而两份规则表达同一件事时，先失效的永远是更窄的那个。
 */
export const README_NAME_RE = README_RE

/** 本机私有路径（任一宿主平台习惯写法）的判据，供 preflight 引用，避免第二份手写正则。 */
export const HOME_PATH_RE = /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+|[\\/](?:home|Users)[\\/][^\\/\s"'`]+/

/** 从 README 文件名里取出语言标记；没有语言标记（默认语言）时返回 undefined。 */
function readmeLangOf(name) {
  const m = /^readme[._-]([a-z]{2}(?:[._-][a-z]{2})?)\./i.exec(name)
  return m === null ? undefined : m[1].toLowerCase()
}

/** 读一个 Markdown 文件的二级标题列表，用于「现有文档有哪些节」这种机械报告。 */
function markdownH2(filePath) {
  const text = readText(filePath)
  if (text === undefined) return []
  return text.split('\n')
    .filter((l) => /^##\s+\S/.test(l))
    .map((l) => l.trim())
}

/** 这个文件名是不是「默认语言」的 README（`README.md` 这类，没有语言后缀）。 */
function isDefaultReadme(name) {
  return /^readme\.(md|markdown|rst|txt|adoc)$/i.test(name)
}

/** 认了但不算「非文档内容」的杂项文件：每个项目都有，不构成形态证据。 */
const MISC_FILE_RE = /^(license|licence|copying|notice|authors|contributors|changelog|changes|history|todo|\.gitignore|\.gitattributes|\.gitmodules|\.editorconfig|\.npmignore|\.dockerignore)(\..*)?$/i

/**
 * 从单个文件名收集「这是什么项目」的形状证据。
 * 只在走查时调用一次，避免为了兜底判定再遍历一遍目录树。
 *
 * `depth`（相对目标目录的层级）由走查直接给出，**不要用路径里有没有斜杠来判断嵌套**：
 * 那个写法在 Windows 上会失效（分隔符是反斜杠），而失效的形式是静默的——monorepo 会被
 * 判成 unrecognized。
 */
function collectSourceEvidence(scan, name, rel, depth) {
  const lower = name.toLowerCase()
  const build = BUILD_FILE_KINDS.find(([f]) => f === lower)
  if (build !== undefined && !scan.byBuildFile.has(build[1])) {
    scan.byBuildFile.set(build[1], rel)
  }
  // 子目录里的清单：monorepo 的主要线索。根目录的清单由 detectEcosystem 直接处理，
  // 走不到这里也不需要走。
  const manifest = NESTED_MANIFEST_KINDS.find(([f]) => f === lower)
  if (manifest !== undefined && depth > 0 && !scan.byNestedManifest.has(manifest[1])) {
    scan.byNestedManifest.set(manifest[1], rel)
  }
  for (const [re, kind] of SOURCE_EXT_KINDS) {
    if (re.test(name)) {
      if (!scan.byExtension.has(kind)) scan.byExtension.set(kind, rel)
      return
    }
  }
  if (DOC_EXT_RE.test(name) || MISC_FILE_RE.test(lower)) return
  if (scan.nonDocSamples.length < 5) scan.nonDocSamples.push(rel)
}

/**
 * 把文件按 UTF-8 严格解码；非 UTF-8 时按 UTF-16 再试一次（带 BOM 或 NUL 密集）。
 *
 * 为什么必须做：本 skill 零依赖、只用内置模块，而 `readFileSync(p,'utf8')` 是**宽松**
 * 解码——非法字节被替换字符吞掉，不报错。Windows 上 `Out-File` / `Set-Content` 默认
 * 存 UTF-16LE，于是里面的凭据形状全是「字节 + NUL」交错，ASCII 形状的正则一个都匹配
 * 不上，而报告显示「无命中」。实测过：同一份内容存成 UTF-16LE 就漏，存成 UTF-8 就报。
 *
 * 返回 { text, encoding } 或 { error }（读不出来）。
 */
function decodeText(buffer) {
  const stripBom = (s) => s.replace(/^\uFEFF/, '')
  try {
    return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), encoding: 'utf-8' }
  } catch { /* 不是合法 UTF-8，继续试探 UTF-16 */ }
  const nul = buffer.reduce((n, x) => n + (x === 0 ? 1 : 0), 0)
  const looksUtf16 = nul / Math.max(1, buffer.length) > 0.15
    || (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)))
  if (looksUtf16) {
    for (const enc of ['utf-16le', 'utf-16be']) {
      try {
        return { text: stripBom(new TextDecoder(enc, { fatal: true }).decode(buffer)), encoding: enc }
      } catch { /* 换另一种端序 */ }
    }
  }
  // 既不是 UTF-8 也不是 UTF-16：按宽松解码尽力扫一遍，同时**如实记为未覆盖**。
  return { text: readTextFromBuffer(buffer), encoding: 'unknown' }
}

function readTextFromBuffer(buffer) {
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}

/** 对文本文件做内容级扫描：凭据形状 + 本机私有路径。 */
function scanContents(root, candidates, realHomes) {
  const secrets = []
  const homePaths = []
  const stats = { unreadable: 0, notUtf8: 0, utf16Decoded: 0 }
  for (const rel of candidates) {
    if (CONTENT_SCAN_SKIP.test(rel)) continue
    const full = join(root, rel)
    let buffer
    try {
      buffer = readFileSync(full)
    } catch {
      // 读不出来（权限、被独占、路径失效）**要计数**：它和「扫过没命中」不是一件事。
      stats.unreadable += 1
      continue
    }
    if (buffer.length > CONTENT_SCAN_MAX_BYTES) continue
    const decoded = decodeText(buffer)
    if (decoded.encoding === 'unknown') stats.notUtf8 += 1
    if (decoded.encoding === 'utf-16le' || decoded.encoding === 'utf-16be') stats.utf16Decoded += 1
    const text = decoded.text
    for (const { label, re } of SECRET_CONTENT_PATTERNS) {
      const m = re.exec(text)
      if (m === null) continue
      // 带行号：只报文件名不构成可执行的报告——使用者还得自己搜一遍。
      // 行号从匹配位置数换行符得到，不重跑一遍全文。
      const line = text.slice(0, m.index).split('\n').length
      secrets.push({ path: rel, kind: label, line })
      break
    }
    for (const { re } of HOME_PATH_PATTERNS) {
      const m = text.match(re)
      if (m === null || m.length === 0) continue
      // 同一个文件里同一形状只报一处，避免一个测试文件刷出几十行
      const sample = m[0]
      const verdict = classifyHomePath(rel, sample, realHomes)
      homePaths.push({ path: rel, sample, ...verdict })
      break
    }
  }
  return { secrets, homePaths, stats }
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

/**
 * 清单文件名 → 生态。用于**子目录**里的清单。
 *
 * 这一条专治 monorepo：根目录只有一个 README，真正的清单在 packages、apps 这些子目录
 * 下面。只看根目录会得出「既没有清单、源码扩展名也匹配不上」的结论，落到 unrecognized，
 * 然后触发一次本可避免的追问。子目录里出现清单，是这个项目属于该生态的强证据。
 */
const NESTED_MANIFEST_KINDS = [
  ['package.json', 'node'],
  ['pyproject.toml', 'python'], ['setup.py', 'python'], ['requirements.txt', 'python'],
  ['cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pom.xml', 'java'], ['build.gradle', 'java'], ['build.gradle.kts', 'java'],
  ['gemfile', 'ruby'],
  ['composer.json', 'php'],
  ['pubspec.yaml', 'dart'],
]

function detectEcosystem(root, root_, walked) {
  const evidence = []
  const kinds = []
  const pkg = readJson(join(root, root_.real('package.json') ?? 'package.json'))
  const cordisPatch = root_.first(['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml'])
  const skillFile = root_.first(['SKILL.md', 'skill.md'])
  const skillText = skillFile === undefined ? undefined : readText(join(root, skillFile))
  const skill = skillFrontmatter(skillText)

  if (pkg !== undefined) {
    if (pkg.__corrupt === true) {
      evidence.push(`${root_.real('package.json')}（清单损坏，JSON 解析失败）`)
      kinds.push('node')
    } else {
    evidence.push(root_.real('package.json'))
    kinds.push('node')
    if (pkg.dsh?.bundle !== undefined || cordisPatch !== undefined) {
      evidence.push(cordisPatch !== undefined ? cordisPatch : 'package.json 的 dsh.bundle 声明')
      kinds.push('dsh-plugin')
    }
    // VS Code 扩展：判据是 `engines.vscode`——只有扩展会声明它。
    // `contributes` 单独出现不足以判定（别的生态也可能用这个词）。
    if (pkg.engines?.vscode !== undefined) {
      evidence.push('package.json 的 engines.vscode')
      kinds.push('vscode-extension')
    }
    }
  } else if (cordisPatch !== undefined || skill !== undefined) {
    // 有插件配置或 skill 入口但没有 JS 清单：仍然可能是这两类形态，不能等到认出
    // package.json 才认。插件的「产物必须入库」判据依赖这个识别结果。
    if (cordisPatch !== undefined) { evidence.push(cordisPatch); kinds.push('dsh-plugin') }
    if (skill !== undefined) { evidence.push(`SKILL.md（name: ${skill.name}）`); kinds.push('skill') }
  }
  // Obsidian 插件：独立的 `manifest.json`，判据是 `minAppVersion`（只有它用这个字段）。
  // 注意与 VS Code 的区别——同样是插件，清单文件完全不同，这正是需要专章的理由。
  if (kinds.length === 0 || !kinds.includes('vscode-extension')) {
    const obsManifest = root_.real('manifest.json')
    if (obsManifest !== undefined) {
      const obs = readJson(join(root, obsManifest))
      if (obs !== undefined && obs.minAppVersion !== undefined) {
        evidence.push('manifest.json 的 minAppVersion')
        kinds.push('obsidian-plugin')
      }
    }
  }
  if (skill !== undefined && !kinds.includes('skill')) {
    evidence.push(`SKILL.md（name: ${skill.name}）`)
    kinds.push('skill')
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
  //
  // 兜底必须看**子目录**，不能只看顶层：真实项目里代码几乎总在 src/、packages/、
  // cmd/ 这类子目录下，顶层只有一个 README。只看顶层会把 `README.md + src/app.js`
  // 判成「纯文档目录」，而 docs-only 的发布列是「不做」——整条发布链路会被跳过。
  //
  // 但它**只在什么都没认出来时**才用：扩展名是很弱的证据，而一旦已经认出这是 skill、
  // 插件或某种清单型项目，再凭「目录里有个 .py 文件」追加一个生态，只会制造误判
  // （例如把技能自带的 scripts/ 当成一个 Node 项目）。
  if (kinds.length === 0) {
    const scan = walked?.sourceScan
    if (scan !== undefined) {
      // 子目录里的清单是最强的线索（monorepo），排在构建描述文件与扩展名之前。
      for (const [kind, sample] of scan.byNestedManifest) {
        evidence.push(`${sample}（子目录里的清单，根目录没有）`)
        kinds.push(kind)
      }
      for (const [kind, sample] of scan.byBuildFile) {
        evidence.push(`${sample}（构建描述文件，无清单）`)
        kinds.push(kind)
      }
      for (const [kind, sample] of scan.byExtension) {
        evidence.push(`${sample}（源码扩展名，无清单文件）`)
        kinds.push(kind)
      }
    }
  }

  // 仍然什么都没认出来，才按目录性质区分。
  const unique = [...new Set(kinds)]
  if (unique.length === 0) {
    const hasMarkdown = root_.first(['README.md', 'README.rst', 'README.txt']) !== undefined
    // 判据是「除文档外还有没有别的东西」。**只看源码与构建描述文件**，不要把
    // LICENSE、.gitignore 这类每个项目都有的文件算成「别的东西」——那会把正常的
    // 纯文档目录误报成 unrecognized，反过来触发一次无谓的追问。
    const nonDoc = walked?.sourceScan?.nonDocSamples ?? []
    if (hasMarkdown && nonDoc.length === 0) {
      unique.push('docs-only')
      evidence.push('仅见 Markdown 文档')
    } else if (nonDoc.length > 0) {
      unique.push('unrecognized')
      evidence.push(`未识别出项目形态（非文档文件示例：${nonDoc.slice(0, 3).join('、')}）`)
    } else unique.push('unknown')
  }
  return { kinds: unique, evidence, manifest: pkg, skill }
}

/**
 * 清单文件 → 它是不是「可发布的清单」（即声明了这个项目的身份与版本，能对外发）。
 *
 * 这份表存在的理由是一个真实缺陷：判断「这个项目能不能发布」时只认 `package.json`，
 * 于是**任何非 JS 项目一律被判成不可发布**，生成的契约里整块丢掉版本号语义、抬版本号
 * 判据、发版规则、角色判定——而 SKILL.md 的能力矩阵明写「python / rust / go：
 * 发布视声明而定」。读这张表就不会把「我没解析那种清单」误当成「它不能发布」。
 */
const PUBLISHABLE_MANIFESTS = [
  ['package.json', 'node'],
  ['pyproject.toml', 'python'], ['setup.py', 'python'], ['setup.cfg', 'python'],
  ['cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pom.xml', 'java'], ['build.gradle', 'java'], ['build.gradle.kts', 'java'],
  ['gemfile', 'ruby'], ['composer.json', 'php'],
  ['pubspec.yaml', 'dart'], ['mix.exs', 'elixir'], ['package.swift', 'swift'],
  // Obsidian 插件的 manifest.json：只认含 minAppVersion 的那一种，
  // 普通 PWA 的 manifest.json 在此同样被跳过（见下循环内的守卫）。
  ['manifest.json', 'obsidian'],
]

/**
 * 从清单文件推导「怎么构建/测试/校验」。取不到就留空，不编造。
 *
 * 返回值里既有扁平字段（`build`、`test` 一类，取「最可信的那个」），也有
 * `byEcosystem`（按生态分开）。两者都给是因为用途不同：
 *   - 只想跑一条命令时用扁平字段，方便；
 *   - 要把它**写进文档**时必须用 byEcosystem——多生态项目里扁平字段会让后算的生态
 *     覆盖先算的（实测 node + python 的项目里，项目自己的 `vitest run` 被
 *     `python -m pytest` 顶掉，而这条错误命令会被原样渲染进 AGENTS.md）。
 * 覆盖是静默的，所以调用方必须能看出「这个值属于哪个生态」。
 */
function deriveCommands(root, root_, eco) {
  const out = {}
  const byEcosystem = {}

  if (eco.manifest !== undefined && typeof eco.manifest.scripts === 'object') {
    const pkg = eco.manifest
    const node = {}
    // 先定包管理器：命令前缀由它决定。在 pnpm/yarn/bun 项目里写 npm run 是错的——
    // 轻则绕过了项目的约定，重则在 workspace 里直接失败。
    // 判据顺序：清单里的显式声明 > 锁文件 > 默认。
    let pm = 'npm'
    if (typeof pkg.packageManager === 'string' && pkg.packageManager.length > 0) {
      pm = pkg.packageManager.split('@')[0]
    } else if (root_.has('pnpm-lock.yaml') || root_.has('pnpm-workspace.yaml')) pm = 'pnpm'
    else if (root_.has('yarn.lock')) pm = 'yarn'
    else if (root_.has('bun.lockb') || root_.has('bun.lock')) pm = 'bun'
    node.packageManager = pm

    for (const [key, aliases] of [
      ['build', ['build']], ['test', ['test']],
      ['typecheck', ['typecheck', 'type-check', 'tsc']], ['lint', ['lint']],
      ['verify', ['verify', 'check', 'validate']], ['smoke', ['smoke']],
    ]) {
      const hit = aliases.find((a) => typeof pkg.scripts[a] === 'string')
      if (hit !== undefined) node[key] = `${pm} run ${hit}`
    }
    // 装依赖永远是包管理器自己的命令：`scripts.install` 是项目自定义的安装钩子，
    // 不是「怎么装依赖」。曾经把它列进上面的别名表，结果被这一行无条件覆盖——
    // 一条永远不生效的分支，且读代码的人会以为它生效。
    node.install = `${pm} install`
    byEcosystem.node = node
  }

  if (eco.kinds.includes('python')) {
    const python = {}
    const pyName = root_.real('pyproject.toml')
    const py = pyName === undefined ? '' : (readText(join(root, pyName)) ?? '')
    // **声明**优先：只有项目自己声明了测试框架，才给出对应的测试命令。
    //
    // 这里曾经只要「有 tests 目录」就给出 `python -m pytest`——那是**按生态惯例推断**，
    // 不是读项目声明。实测一个用标准库 unittest 的项目（装了 pytest 也跑不起来）
    // 拿到一条跑不通的「硬门禁」命令，而且它把 P7 的诚实分支遮住了：SKILL.md 说
    // 「推不出命令时要如实说明没有验证过」，但脚本总能推出一条假命令，那个分支永不触发。
    const declaresPytest = /\[tool\.pytest/.test(py) || root_.has('pytest.ini') || root_.has('tox.ini')
    const declaresUnittest = /\[tool\.unittest/.test(py)
      || (/unittest/.test(readText(join(root, 'setup.cfg')) ?? '') && root_.has('setup.cfg'))
    // **注明出处**：这条是按「有测试目录 + 无框架声明」推断的，不是项目声明的。
    // 写进文档时必须带着这个说明——否则它看起来和项目自己声明的命令一样可靠，
    // 而实测过：一个用标准库 unittest 的项目，曾经的推断会给出一条跑不通的 pytest
    // 命令，还被当成「硬门禁」写进契约。
    if (declaresPytest) python.test = 'python -m pytest'
    else if (declaresUnittest) python.test = 'python -m unittest discover -s tests -v'
    else if (root_.entry('tests')?.isDir === true && pyName !== undefined) {
      python.test = 'python -m unittest discover -s tests -v'
      python.testNote = '项目未声明测试框架；此命令按标准库 unittest 推断，请与项目实际用法核对'
    }
    if (/\[tool\.ruff/.test(py) || root_.has('ruff.toml') || root_.has('.ruff.toml')) {
      python.lint = 'python -m ruff check .'
    }
    if (root_.has('requirements.txt')) python.install = 'pip install -r requirements.txt'
    else if (pyName !== undefined) python.install = 'pip install -e .'
    // 构建命令只在声明了构建后端时给：无 [build-system] 即无权威构建入口，不编。
    if (/\[build-system\]/.test(py)) python.build = 'python -m build'
    if (Object.keys(python).length > 0) byEcosystem.python = python
  }

  // Rust 与 Go：命令只在**清单文件确实存在**时给出。
  //
  // 区别在这里：「有个 .rs 文件」只说明这个项目里有 Rust 代码，不说明它用 cargo 构建
  // （可能是别的构建系统，也可能只是嵌了一段）；而 `Cargo.toml` 是项目**自己声明**的
  // 「我是 cargo 项目」。前者是猜，后者是读。所以判据挂在清单文件上，不挂在生态判定上
  // ——生态可能是靠源码扩展名兜底认出来的。
  if (root_.has('cargo.toml')) {
    byEcosystem.rust = { build: 'cargo build', test: 'cargo test' }
  }
  if (root_.has('go.mod')) {
    byEcosystem.go = { build: 'go build ./...', test: 'go test ./...' }
  }

  // java/dotnet/ruby/php 等：已能识别生态，但本脚本暂不推导命令（需读构建配置确认）。
  // 明确标记“未实现”而非“项目无命令”，调用方据此区分两种空。
  for (const kind of eco.kinds) {
    if (['java', 'dotnet', 'ruby', 'php', 'cpp', 'dart', 'swift'].includes(kind) && byEcosystem[kind] === undefined) {
      byEcosystem[kind] = { note: '该生态的命令推导尚未实现，请读构建配置确认' }
    }
  }

  // 扁平视图：按「声明强度」排序取先到者。
  // 有清单的生态排在前面——它的命令是项目自己声明的，比按惯例推断的可信。
  const order = ['node', 'python', 'rust', 'go']
  const keys = [...order.filter((k) => k in byEcosystem),
    ...Object.keys(byEcosystem).filter((k) => !order.includes(k))]
  for (const kind of keys) {
    for (const [k, v] of Object.entries(byEcosystem[kind])) {
      if (!(k in out)) out[k] = v
    }
  }
  // 「多生态」只在**真的有多套命令**时才算。
  //
  // 判据是「有几个生态产出了命令」，不是「命中几个生态标签」：`dsh-plugin` 是 node 的
  // 一种**细化**（它就是一个 node 项目），`skill` 是描述，它们不会带来第二套命令。
  // 把它们算进去会误报——实测一个 pnpm 插件项目会收到「每类命令只保留了一个」的警告，
  // 而它其实只有一套命令；收到这种警告的 AI 会去找不存在的第二套命令。
  const commandKinds = Object.keys(byEcosystem)
  if (commandKinds.length > 1) {
    out.byEcosystem = byEcosystem
    out.multipleEcosystems = keys.filter((k) => k in byEcosystem)
  }
  return out
}

/**
 * 发布相关的既成事实：决定「产物入不入库」和「发布范围」。
 *
 * 其中 `publishableManifest` 是**这个项目可发布身份的唯一来源**。它存在的理由是一个
 * 真实缺陷：判断「能不能发布」时只认 JS 的 `package.json`，于是**任何非 JS 项目一律
 * 被判成不可发布**，生成的契约里整块丢掉版本号语义、抬版本号判据、发版规则、角色判定
 * ——而 SKILL.md 的能力矩阵明写「python / rust / go：发布视声明而定」。
 * 读这张表就不会把「我没解析那种清单」误当成「它不能发布」。
 *
 * `runtimeRequirements` 是**项目自己声明的运行环境下限**。它值得单独读出来，因为文档
 * 套装要求「环境要求那一节必须写具体版本号、不许编造」——而项目自己声明的那个数字就是
 * 唯一权威来源。读不到就是**没有声明**，此时宁可不写那一节，也不要编一个数字。
 */
function detectArtifacts(root, root_, eco) {
  const facts = {
    publishScope: undefined, hooks: [], hasNpmIgnore: false, distDirsPresent: [],
    runtimeRequirements: [], publishableManifest: undefined, declaredVersion: undefined,
  }

  // 项目声明的版本号。它是标签命名与「抬版本号」判据的唯一权威来源——
  // 读不到就是**没有声明**，此时不能编一个（那会造出一个没人维护、却看起来权威的数字）。
  // 各生态的字段名不同，所以只在清单里找那个字段，不解释语义。
  const readVersion = (fileName, re, label) => {
    if (facts.declaredVersion !== undefined) return
    const real = root_.real(fileName)
    if (real === undefined) return
    const m = re.exec(readText(join(root, real)) ?? '')
    if (m === null) return
    facts.declaredVersion = m[1]
    facts.declaredVersionIn = label
  }
  readVersion('package.json', /"version"\s*:\s*"([^"]+)"/, 'package.json 的 version')
  readVersion('pyproject.toml', /^\s*version\s*=\s*["']([^"']+)["']/m, 'pyproject.toml 的 version')
  readVersion('cargo.toml', /^\s*version\s*=\s*["']([^"']+)["']/m, 'Cargo.toml 的 version')
  readVersion('composer.json', /"version"\s*:\s*"([^"]+)"/, 'composer.json 的 version')
  // Obsidian：只读含 minAppVersion 的 manifest.json，不认 PWA 的同名文件。
  if (/minAppVersion/.test(readText(join(root, root_.real('manifest.json') ?? 'manifest.json')) ?? '')) {
    readVersion('manifest.json', /"version"\s*:\s*"([^"]+)"/, 'manifest.json 的 version')
  }
  // Go 没有版本号字段（靠标签），故不读——读不到就是「没有声明」，这是正确结果。

  // 可发布清单：按知名度顺序取第一个存在的。它不一定与「主生态」相同（一个 Python 项目
  // 也可能因为某个原因带 package.json），所以单独判定，不从 kinds 推。
  // manifest.json 同样守卫 minAppVersion，避免 PWA 被当成可发布插件。
  for (const [file, kind] of PUBLISHABLE_MANIFESTS) {
    const real = root_.real(file)
    if (real === undefined) continue
    if (file === 'manifest.json') {
      if (!/minAppVersion/.test(readText(join(root, real)) ?? '')) continue
    }
    facts.publishableManifest = { file: real, ecosystem: kind }
    break
  }

  const pkg = eco.manifest
  if (pkg !== undefined) {
    if (Array.isArray(pkg.files)) facts.publishScope = { kind: 'files-whitelist', entries: pkg.files }
    if (root_.has('.npmignore')) facts.hasNpmIgnore = true
    for (const hook of ['prepublishOnly', 'prepack', 'prepare', 'prepublish']) {
      if (typeof pkg.scripts?.[hook] === 'string') facts.hooks.push(hook)
    }
    if (pkg.private === true) facts.private = true
    if (typeof pkg.engines === 'object' && pkg.engines !== null) {
      for (const [runtime, range] of Object.entries(pkg.engines)) {
        facts.runtimeRequirements.push({
          declaredIn: 'package.json 的 engines', runtime, range: String(range),
        })
      }
    }
  }
  // 其他生态的下限声明：写法各不相同，所以只在清单里逐行找那个字段，把「运行时 + 约束」
  // 作为事实带出来，**不解释具体语法**（那属于各生态自己的事）。
  const readRange = (fileName, re, runtime, label) => {
    const real = root_.real(fileName)
    if (real === undefined) return
    const m = re.exec(readText(join(root, real)) ?? '')
    if (m === null) return
    facts.runtimeRequirements.push({ declaredIn: label, runtime, range: m[1] })
  }
  readRange('pyproject.toml', /^\s*requires-python\s*=\s*["']([^"']+)["']/m, 'python', 'pyproject.toml 的 requires-python')
  readRange('cargo.toml', /^\s*rust-version\s*=\s*["']([^"']+)["']/m, 'rust', 'Cargo.toml 的 rust-version')
  readRange('go.mod', /^go\s+(\S+)/m, 'go', 'go.mod 的 go 指令')
  readRange('manifest.json', /"minAppVersion"\s*:\s*"([^"]+)"/, 'obsidian', 'manifest.json 的 minAppVersion')
  // JS 的 engines 已在上面按对象读取，这里不再重复。

  for (const d of ['dist', 'lib', 'build', 'out']) {
    const e = root_.entry(d)
    if (e?.isDir === true) facts.distDirsPresent.push(e.name)
  }
  // Obsidian 发布三件套 presence：
  //   - manifest 恒有（能走到这里说明 manifest.json 已被守卫过 minAppVersion）；
  //   - mainJs/stylesCss 只看根目录有无：官方模板的忽略规则要求 main.js 不进版本库、
  //     只进发布附件，所以“根目录无 main.js”是正常态，不是缺陷——review 只在
  //     release 附件语境下问它，不在这里下结论；
  //   - mainJsIgnored 告诉上层“无 main.js 是有意的忽略还是真的没构建”；
  //   - hasVersionsJson 回退映射有无（旧宿主用户靠它）；
  //   - manifestId 合法性只做文本形状判断（小写字母与连字符、不含 obsidian、
  //     不以 plugin 结尾），供人复核，不做硬结论。
  if (root_.real('manifest.json') !== undefined) {
    const manifestText = readText(join(root, root_.real('manifest.json'))) ?? ''
    const manifestId = (/"id"\s*:\s*"([^"]+)"/.exec(manifestText) ?? [])[1]
    let mainJsIgnored = undefined
    try {
      const gi = readText(join(root, root_.real('.gitignore') ?? '.gitignore'))
      if (gi !== undefined) {
        mainJsIgnored = gi.split(/\r?\n/).some((l) => {
          const t = l.trim()
          return t !== '' && !t.startsWith('#') && /(^|\/)main\.js$/.test(t)
        })
      }
    } catch { /* 读不到就不判 */ }
    facts.obsidianArtifacts = {
      manifest: true,
      mainJs: root_.has('main.js'),
      stylesCss: root_.has('styles.css'),
      hasVersionsJson: root_.has('versions.json'),
      mainJsIgnored,
      manifestId,
      manifestIdShapeOk: manifestId === undefined ? undefined
        : /^[a-z-]+$/.test(manifestId)
        && !manifestId.includes('obsidian')
        && !manifestId.endsWith('plugin'),
    }
  }
  // Rust：publish=false 即声明不可发布（复用 private 机器）；license/description 有无进 facts。
  // 只做文本 presence 判断，不解释 Cargo 语义。
  // 另收 keywords/categories 数量（各至多 5 个，超了服务端拒绝）与 dependents 风险位：
  // edition 缺省 2015 可发布（不是必填），authors 已废弃不判。
  const cargoReal = root_.real('cargo.toml')
  if (cargoReal !== undefined) {
    const cargo = readText(join(root, cargoReal)) ?? ''
    if (/^\s*publish\s*=\s*false/m.test(cargo)) facts.private = true
    const countList = (key) => {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm').exec(cargo)
      if (m === null) return undefined
      return m[1].split(',').map((s) => s.trim()).filter(Boolean).length
    }
    facts.cargoMeta = {
      license: /^\s*license\s*=/m.test(cargo),
      description: /^\s*description\s*=/m.test(cargo),
      keywordsCount: countList('keywords'),
      categoriesCount: countList('categories'),
      hasEdition: /^\s*edition\s*=/m.test(cargo),
    }
  }
  // Go：module 路径、go 指令版本、retract 有无。只读文本，不下结论。
  const goReal = root_.real('go.mod')
  if (goReal !== undefined) {
    const goText = readText(join(root, goReal)) ?? ''
    facts.goModule = {
      module: (/^module\s+(\S+)/m.exec(goText) ?? [])[1],
      goDirective: (/^go\s+(\S+)/m.exec(goText) ?? [])[1],
      hasRetract: /^\s*retract\s+/m.test(goText),
    }
  }
  // Python：构建后端声明有无（构建命令只在有后端时给，见 deriveCommands）。
  // 另收发布硬门禁的三组 presence（只报有无，供 review 逐项点名）：
  //   readme/license 字段（长描述渲染炸是最常见的 400 拒绝）；
  //   requires-python（装到旧版的根因定位用）；
  //   dynamic version（版本号权威在后端，tag 对齐要按后端取值）。
  const pyReal = root_.real('pyproject.toml')
  if (pyReal !== undefined) {
    const pyText = readText(join(root, pyReal)) ?? ''
    facts.pythonBuild = { hasBuildSystem: /\[build-system\]/.test(pyText) }
    facts.pythonMeta = {
      hasReadme: /^\s*readme\s*=/m.test(pyText),
      hasLicense: /^\s*license(\s*=|\s*\[)/m.test(pyText),
      hasRequiresPython: /^\s*requires-python\s*=/m.test(pyText),
      hasDynamicVersion: /dynamic\s*=\s*\[[^\]]*["']version["']/.test(pyText),
    }
  }
  return facts
}

/**
 * DSH 插件的补充事实：Bundle 声明、客户端声明、入口与发现载体。
 *
 * 只在已判定为 `dsh-plugin` 时返回对象，其余返回 undefined。所有取值都从项目自身读，
 * 读不到就标缺失，不编造：
 *   - 包名 ← 清单 `name`；补丁路径 ← 清单 `dsh.bundle.patch`（对象里的单个字符串路径）；
 *   - 客户端声明 ← 清单 `dsh.client`；入口 ← 清单 `exports`；
 *   - 补丁文件 ← 根目录的 `cordis.patch.yml` 一类；发现载体 ← 补丁文本里是否出现包名。
 * 发现载体只是文本包含判断（YAML 不做完整解析），供人复核用，不做硬结论。
 */
function detectDsh(root, root_, eco) {
  if (!eco.kinds.includes('dsh-plugin')) return undefined
  const pkg = eco.manifest
  if (pkg === undefined || pkg.__corrupt === true) return undefined
  const patchFile = root_.first(['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml'])
  const dsh = typeof pkg.dsh === 'object' && pkg.dsh !== null ? pkg.dsh : {}
  const bundleDecl = dsh.bundle
  const bundlePatchPath = typeof bundleDecl === 'object' && bundleDecl !== null
    && typeof bundleDecl.patch === 'string' ? bundleDecl.patch : undefined
  const bundlePatchExists = bundlePatchPath === undefined ? undefined
    : exists(join(root, bundlePatchPath.replace(/^\.\//, '')))
  const clientDecl = dsh.client
  const hasClientDecl = clientDecl !== undefined
  // 未知字段现形：宿主未来加了新声明时，静默忽略等于装懂。这里只报名字，
  // 不解释语义——语义按六问现场查，不要猜。
  const knownDshKeys = new Set(['bundle', 'client', 'profile'])
  const unknownKeys = Object.keys(dsh).filter((k) => !knownDshKeys.has(k))
  const exportsMap = typeof pkg.exports === 'object' && pkg.exports !== null
    ? Object.keys(pkg.exports) : []
  const hasHostEntry = exportsMap.includes('.') || typeof pkg.main === 'string'
  const hasClientEntry = exportsMap.includes('./client')
  const warnings = []
  if (bundleDecl !== undefined && bundlePatchPath !== undefined && bundlePatchExists === false) {
    warnings.push(`清单声明了补丁路径 ${bundlePatchPath}，但该文件不存在`)
  }
  if (hasClientDecl && !hasClientEntry) {
    warnings.push('清单声明了 dsh.client，但 exports 里没有 ./client 入口')
  }
  if (!hasClientDecl && hasClientEntry) {
    warnings.push('exports 里有 ./client 入口，但清单没有 dsh.client 声明')
  }
  // 发现载体行：补丁文本里是否出现包名。只是文本包含，不解析 YAML。
  let carrier = undefined
  if (patchFile !== undefined && typeof pkg.name === 'string' && pkg.name.length > 0) {
    const text = readText(join(root, patchFile))
    if (text !== undefined) carrier = text.includes(pkg.name)
  }
  if (carrier === false) {
    warnings.push('补丁文本里没有出现包名，可能缺发现载体行（name 等于包名自身的那一行）')
  }
  // 锁定的宿主版本：dependencies/devDependencies/peerDependencies 里 `@deepseek-ai/*`
  // 的声明值（去重，原样保留范围符号，归一化由比对方做）。专章滞后判断用它。
  // 另把 cordis / schemastery 一并收录：模板时代宿主运行时不一定带 @deepseek-ai 前缀。
  const pinnedVersions = [...new Set(
    ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => {
      const deps = pkg[k]
      if (typeof deps !== 'object' || deps === null) return []
      return Object.entries(deps)
        .filter(([name, range]) => (name.startsWith('@deepseek-ai/') || name === 'cordis' || name === 'schemastery') && typeof range === 'string')
        .map(([, range]) => range)
    }),
  )]
  // 伴生入口：exports 是否含 ./invariant。语义件的有无决定要不要查正反测试。
  const hasInvariantEntry = exportsMap.includes('./invariant')
  // 发布范围：files 是否含构建产物与补丁。只做包含判断，不解释语义。
  const filesList = Array.isArray(pkg.files) ? pkg.files.map(String) : []
  const filesHasLib = filesList.some((f) => /(^|\/)lib(\/|$)/.test(f) || /^lib/.test(f))
  const filesHasPatch = patchFile !== undefined && filesList.some((f) => f.includes('cordis.patch'))
  // 构建产物是否被跟踪：git 视角的事实，与 files 是两套集合，缺一不可。
  let libTracked = undefined
  try {
    const r = spawnSync('git', ['ls-files', 'lib'], { cwd: root, encoding: 'utf8', windowsHide: true })
    if (r.error === undefined && r.status === 0) libTracked = (r.stdout ?? '').trim().length > 0
  } catch { /* 取不到就不判 */ }
  // 宿主运行时放对位置没有：cordis 一类应在 peer，不应被打进 dependencies。
  const hostRuntimeInDeps = ['dependencies'].some((k) => {
    const deps = pkg[k]
    if (typeof deps !== 'object' || deps === null) return false
    return Object.keys(deps).some((n) => n === 'cordis' || n === 'schemastery' || n.startsWith('@deepseek-ai/'))
  })
  // 工具链 presence：只报有无，不读版本号语义。
  const toolchain = {
    tsdown: root_.has('tsdown.config.ts') || root_.has('tsdown.config.js') || root_.has('tsdown.config.mjs'),
    vitest: root_.has('vitest.config.ts') || root_.has('vitest.config.js') || root_.has('vitest.config.mjs'),
    oxlint: root_.has('.oxlintrc.json'),
    pnpmWorkspace: root_.has('pnpm-workspace.yaml'),
    lockfile: root_.has('pnpm-lock.yaml'),
  }
  // 本地 workflow 与补丁目录：只报 presence，不展开内容。
  const localWorkflow = root_.entry('.agents')?.isDir === true
  const contractDoc = root_.has('docs/dsh-plugin-contracts.md')
  const patchesDir = root_.entry('patches')?.isDir === true
  return {
    packageName: typeof pkg.name === 'string' ? pkg.name : undefined,
    patchFile,
    bundlePatch: bundlePatchPath === undefined ? undefined
      : { path: bundlePatchPath, exists: bundlePatchExists },
    hasClientDecl,
    exportsKeys: exportsMap,
    hasHostEntry,
    hasClientEntry,
    hasInvariantEntry,
    filesHasLib,
    filesHasPatch,
    libTracked,
    hostRuntimeInDeps,
    toolchain,
    localWorkflow,
    contractDoc,
    patchesDir,
    discoveryCarrierLikely: carrier,
    pinnedVersions,
    unknownKeys,
    warnings,
  }
}

/**
 * 仓库本地 skills 盘点：通用协议，不止 DSH。
 *
 * 只收仓库内可提交的位置（`.agents/skills/*`、`.claude/skills/*`、包内 `skills/*`），
 * 不碰家目录与外部 checkout。每个 skill 只读目录名、`SKILL.md` 首部 `name` 与
 * `description` 首行、是否有 `scripts/` 与 `references/`，不展开正文。
 * 损坏的 SKILL.md 标 corrupt，不中断。
 */
function detectLocalSkills(root) {
  const out = []
  const bases = ['.agents/skills', '.claude/skills', 'skills']
  const readDir = (p) => {
    try { return readdirSync(p, { withFileTypes: true, encoding: 'utf8' }) } catch { return [] }
  }
  for (const base of bases) {
    const abs = join(root, base)
    for (const e of readDir(abs)) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue
      const skillPath = join(abs, e.name, 'SKILL.md')
      let nameOk = undefined
      let descriptionHead = undefined
      let corrupt = false
      try {
        const text = readFileSync(skillPath, 'utf8').replace(/^\uFEFF/, '')
        const m = /^name:[ \t]*(.+)$/m.exec(text.split('---')[1] ?? '')
        nameOk = m !== null && m[1].trim() === e.name
        const d = /^description:[ \t]*\|?([^\n]*)/m.exec(text)
        descriptionHead = d === null ? undefined : d[1].trim().slice(0, 120)
      } catch { corrupt = true }
      let hasScripts = false
      let hasReferences = false
      try {
        const sub = readDir(join(abs, e.name))
        hasScripts = sub.some((x) => x.name === 'scripts')
        hasReferences = sub.some((x) => x.name === 'references')
      } catch { /* 读不到就不判 */ }
      out.push({ path: `${base}/${e.name}`, nameOk, descriptionHead, hasScripts, hasReferences, corrupt })
    }
  }
  return out
}

function detectDocs(root, root_) {
  const docs = {}
  // 用同一个正则收集：语言后缀是可选的，分隔符点与下划线都认。
  const readmes = root_.filesIn('', README_RE)
  docs.readme = readmes

  // 双语 README：把它作为**一对**报出来，而不是只报两个文件名。
  //
  // 这个区分有实际后果：成对的 README 会漂移（一份改了另一份没改），而漂移只有在
  // 「知道它们是一对」的前提下才谈得上检查。同时它影响「随包发出的说明」的判据——
  // 两份都会展示在制品库页面上、都在包内，改哪一份都算用户可见变化。
  if (readmes.length > 1) {
    const variants = readmes
      .map((f) => ({ file: f, lang: readmeLangOf(f) }))
      .filter((x) => x.lang !== undefined)
    const defaultOne = readmes.find((f) => isDefaultReadme(f))
    if (variants.length > 0 && defaultOne !== undefined) {
      docs.readmePair = {
        default: defaultOne,
        variants: variants.map((v) => v.file),
        note: '这是一对双语 README。两份都会随包分发、都会展示在制品库页面上，'
          + '改任何一份都算用户可见变化；且**它们会漂移**——改一份时另一份必须一起看。',
      }
    } else if (variants.length > 1 && defaultOne === undefined) {
      // 双非默认（如只有 README.zh-CN 与 README.en）：同样会漂移，不能静默不成对。
      docs.readmePair = {
        default: variants[0].file,
        defaultMissing: true,
        variants: variants.map((v) => v.file),
        note: '两份带语言后缀的 README（缺默认语言版）。它们同样会漂移，改一份时另一份必须一起看。',
      }
    }
  }

  // 主 README 的现有节结构。
  //
  // 报告这个而不是「缺哪几节」，是因为 README 的结构**本来就没有标准**：命令行工具、
  // 库、数据项目的合理结构各不相同，模板只是建议。脚本给出事实（它有哪些节），
  // 由读的人对照模板判断——这比让脚本假装能判断「合格不合格」诚实。
  const primary = readmes.find((f) => isDefaultReadme(f)) ?? readmes[0]
  if (primary !== undefined) {
    docs.readmeSections = markdownH2(join(root, primary))
  }
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
        const files = readdirSync(join(gh, wfEntry.name), { encoding: 'utf8' })
          .filter((n) => /\.ya?ml$/i.test(n))
        docs.workflows = files
        // 自动化现状：只看形状（有没有发布 job、用没用 Secrets），不判对错——
        // 对错由 references/remote-github.md 第八节的核对表判定。
        // 只读每个文件前 WORKFLOW_HEAD_LIMIT，大工作流不至于拖慢勘察；超限时必须置 truncated，
        // 否则下游会把“没看到”当成“没有”。limit 值随输出携带，文档只写“实现定义的截断上限”。
        const auto = {
          files, hasReleaseJob: false, usesSecrets: false, usesOidc: false,
          usesNotesFile: false, usesGenerateNotes: false,
          // 发布链路的进一步形状（review 门禁的输入，只做文本 presence 判断）：
          //   releaseTriggerTags  各工作流 on.push.tags 里声明的标签模式原文（如 v*）；
          //   releaseJobConditionTagsV  条件里写死了 refs/tags/v（裸版本标签永远进不来）；
          //   usesReleaseToken  是否引用了约定的 RELEASE_TOKEN；
          //   hasContentsWrite  是否声明了 contents: write（建 Release 所需权限之一）；
          //   hasFetchDepthZero  检出是否含全历史（起草要读上一个标签）；
          //   hasNpmPublish / hasPypiPublish / hasCargoPublish  各生态的发布动作痕迹。
          releaseTriggerTags: [], releaseJobConditionTagsV: false,
          usesReleaseToken: false, hasContentsWrite: false, hasFetchDepthZero: false,
          hasNpmPublish: false, hasPypiPublish: false, hasCargoPublish: false,
          truncated: false, headLimit: WORKFLOW_HEAD_LIMIT,
        }
        for (const f of files) {
          const text = readText(join(gh, wfEntry.name, f))
          if (text === undefined) continue
          if (text.length > WORKFLOW_HEAD_LIMIT) auto.truncated = true
          const head = text.slice(0, WORKFLOW_HEAD_LIMIT)
          if (/gh\s+release\s+(create|upload)/.test(head) || /releases\s*:\s*write/.test(head)) {
            auto.hasReleaseJob = true
          }
          if (/secrets\./.test(head)) auto.usesSecrets = true
          if (/id-token\s*:\s*write/.test(head)) auto.usesOidc = true
          if (/--notes-file/.test(head)) auto.usesNotesFile = true
          if (/--generate-notes/.test(head)) auto.usesGenerateNotes = true
          if (/secrets\.RELEASE_TOKEN/.test(head)) auto.usesReleaseToken = true
          if (/contents\s*:\s*write/.test(head)) auto.hasContentsWrite = true
          if (/fetch-depth\s*:\s*0/.test(head)) auto.hasFetchDepthZero = true
          if (/npm\s+publish/.test(head)) auto.hasNpmPublish = true
          if (/pypa\/gh-action-pypi-publish|twine\s+upload/.test(head)) auto.hasPypiPublish = true
          if (/cargo\s+publish/.test(head)) auto.hasCargoPublish = true
          if (/refs\/tags\/v/.test(head)) auto.releaseJobConditionTagsV = true
          // 标签触发器只认 on.push.tags 的两种常见 YAML 写法（行内数组与短横列表），
          // 取原文不解释语义；workflow_dispatch 的 inputs.tag 是单数，不会误收。
          for (const m of head.matchAll(/tags\s*:\s*\[([^\]]*)\]/g)) {
            for (const item of m[1].split(',')) {
              const v = item.trim().replace(/^['"]|['"]$/g, '')
              if (v !== '' && !auto.releaseTriggerTags.includes(v)) auto.releaseTriggerTags.push(v)
            }
          }
          for (const m of head.matchAll(/tags\s*:\s*\n((?:[ \t]*-[ \t]*[^\n]+\n?)+)/g)) {
            for (const line of m[1].split('\n')) {
              const v = line.replace(/^\s*-\s*/, '').trim().replace(/^['"]|['"]$/g, '')
              if (v !== '' && !auto.releaseTriggerTags.includes(v)) auto.releaseTriggerTags.push(v)
            }
          }
        }
        docs.workflowAutomation = auto
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
  const isRepoRoot = toplevel !== undefined && samePath(toplevel, root)

  const info = {
    available: true,
    present: true,
    isRepoRoot,
    workTreeRoot: toplevel,
    version: run('git', ['--version'], root),
    branch: run('git', ['branch', '--show-current'], root),
    remote: run('git', ['remote', 'get-url', 'origin'], root),
    remotes: (run('git', ['remote'], root) ?? '').split('\n').filter(Boolean),
    // 远端全地址：只存名列表会在 fork 比对时无米之炊。这里补每个远端的 URL，
    // 取不到就标缺失，不编造。历史字段 `remotes` 保持原样以兼容旧消费。
    remoteUrls: (() => {
      const out = {}
      for (const name of (run('git', ['remote'], root) ?? '').split('\n').filter(Boolean)) {
        out[name] = run('git', ['remote', 'get-url', name], root)
      }
      return out
    })(),
    identity: {
      name: run('git', ['config', 'user.name'], root),
      email: run('git', ['config', 'user.email'], root),
      scope: run('git', ['config', '--local', 'user.name'], root) !== undefined ? 'repo' : 'inherit',
      globalName: run('git', ['config', '--global', 'user.name'], root),
      globalEmail: run('git', ['config', '--global', 'user.email'], root),
    },
    tags: (run('git', ['tag', '--list'], root) ?? '').split('\n').filter(Boolean),
    // 历史署名去重前 20：老项目换人换机器时一眼看出混杂，不再靠人工 git log。
    historyAuthors: (() => {
      const out = run('git', ['log', '--format=%an <%ae>', '--no-merges', '-n', '200'], root)
      if (out === undefined) return undefined
      return [...new Set(out.split('\n').filter(Boolean))].slice(0, 20)
    })(),
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

function detectIgnores(root, root_, outputDirCandidates) {
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

  // **已知的产物/依赖目录，是否已被忽略**。
  //
  // 这个交叉核对是必要的：勘察本来就能看到 `venv/` 存在（outputs 里报了它），也能读到
  // 忽略文件，却不把两者对一下——于是「虚拟环境目录就在那里、而忽略规则没覆盖它」
  // 这件**下一次提交就会把整个环境写进历史**的事，要人自己去发现。
  // 报「有未忽略的产物目录」比报「忽略文件 108 字节」有用得多。
  //
  // 用版本控制自己判断有没有被忽略，而不是解析忽略语法：语法有通配、否定、层级差异，
  // 自己解析必然有偏差，而这个问题上偏差的代价是「误以为已忽略」。
  // 无仓库时跳过：此时 check-ignore 全失败，会把所有目录误报为未忽略。
  //
  // **一次批处理，不逐个起子进程**：候选来自 walk() 的全树枚举（任何深度），
  // 用 `check-ignore --stdin -z` 一把判定。逐个 spawn 的代价随目录数线性增长，
  // 也正是旧实现只敢「下沉一层」的原因——于是标准 monorepo 的
  // `packages/<包名>/dist` 全被漏掉（实测 201 个未忽略目录只报 1 个）。
  const gitUsable = run('git', ['rev-parse', '--is-inside-work-tree'], root) === 'true'
  const probe = []
  if (gitUsable) {
    // 候选 = 全树候选（任何深度的产物目录名）∪ 顶层已知产物目录名。
    // 后一半是必须的：`venv/`、`node_modules/` 这类名字在 walk 里被当作依赖目录整体
    // 跳过了，不会进走查结果——而「虚拟环境就在那里、忽略规则却没覆盖它」正是最该
    // 报出来的那种情况。
    const topLevel = OUTPUT_DIR_HINTS
      .filter((d) => root_.entry(d)?.isDir === true)
      .map((d) => root_.real(d))
    const candidates = [...new Set([...(outputDirCandidates ?? []), ...topLevel])]
    const ignored = gitIgnoredSet(root, candidates)
    for (const dir of candidates) probe.push({ dir, ignored: ignored.has(dir) })
  }
  if (probe.length > 0) {
    out.presentOutputDirs = probe
    const notIgnored = probe.filter((x) => !x.ignored).map((x) => x.dir)
    if (notIgnored.length > 0) {
      out.unignoredOutputDirs = notIgnored
      out.unignoredNote = '这些目录已经存在，但忽略规则没有覆盖它们。下一次提交若带上它们，'
        + '会把整个目录写进历史（体积、平台差异、其中可能的本机配置）。'
        + '**这是与安全无关但很紧急的修复**——先把忽略规则补上。'
    }
  }

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
  // 先走查：它收集的形状证据（源码扩展名、构建描述文件）是生态兜底判定的输入，
  // 顺序不能颠倒。
  const walked = walk(root)
  const eco = detectEcosystem(root, root_, walked)
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

  const scanned = scanContents(root, candidates, realHomeSpellings())

  // 给风险项补上两个比特：「已经在版本库里了吗」「被忽略规则覆盖了吗」。
  // 两个比特决定处置方式，缺一个就只能一律报缺——而那正是门禁变噪音的原因：
  //   - 已跟踪：只能从索引移除并轮换；
  //   - 未跟踪且已忽略：不进版本库（.gitignore 里的 .env 就是这样），报事实但不拦；
  //   - 未跟踪且未忽略：下一次 `git add -A` 就会把它带进历史。
  // 三条风险（凭据内容、敏感文件名、本机私有路径）共用同一次批处理，判定只有一个实现。
  const trackedSet = new Set(runGitPaths(['ls-files', '-z'], root) ?? [])
  const markBits = (entry) => {
    const rel = entry.path.replace(/\\/g, '/')
    return { ...entry, tracked: trackedSet.has(rel) || trackedSet.has(entry.path), ignored: false }
  }
  let secrets = scanned.secrets.map(markBits)
  let largeFiles = walked.largeFiles.map(markBits)
  // 敏感文件名同样要标 tracked：分案第一步就问“在不在库里”，缺了这个比特，
  // 会把已在历史里的凭据当未跟踪排除，白忙且留泄露。
  let secretFiles = walked.secretFiles.map((p) => markBits({ path: p }))
  let homePathLeaks = scanned.homePaths.map(markBits)
  const bitPaths = [...secrets, ...secretFiles, ...homePathLeaks].map((x) => x.path)
  if (bitPaths.length > 0) {
    const ignoredSet = gitIgnoredSet(root, bitPaths)
    const fill = (list) => list.map((entry) => ({ ...entry, ignored: ignoredSet.has(entry.path.replace(/\\/g, '/')) }))
    secrets = fill(secrets)
    secretFiles = fill(secretFiles)
    homePathLeaks = fill(homePathLeaks)
  }

  // 标签与版本号对齐：自动化对不上的根源。复用 detectGit 已取到的标签列表，
  // 不另起 git 进程；非仓库根（标签属外层仓库）或取不到时保持 undefined，不判 false。
  // 只做事实比对，不下结论。
  const artifacts = detectArtifacts(root, root_, eco)
  if (artifacts.declaredVersion !== undefined && git.isRepoRoot !== false && Array.isArray(git.tags)) {
    artifacts.versionAligned = git.tags.some(
      (t) => t === artifacts.declaredVersion || t === `v${artifacts.declaredVersion}`)
    artifacts.versionAlignedTags = git.tags.slice(-5)
  }

  // 已跟踪但被忽略的文件也要单独报出来：忽略规则对它们无效，这是个独立的陷阱。
  // 忽略探查只跑一次，两处复用同一结果。
  const ignores = detectIgnores(root, root_, walked.outputDirCandidates)

  return {
    target: { path: root, name: basename(root) },
    git,
    ecosystem: { kinds: eco.kinds, evidence: eco.evidence, skillName: eco.skill?.name },
    commands: deriveCommands(root, root_, eco),
    artifacts,
    dsh: detectDsh(root, root_, eco),
    localSkills: detectLocalSkills(root),
    docs: detectDocs(root, root_),
    ignores,
    outputs: {
      heavyDirsPresent: walked.heavyDirs,
      knownOutputDirs: OUTPUT_DIR_HINTS.filter((d) => root_.entry(d)?.isDir === true),
    },
    risks: {
      secretFiles,
      secretContent: secrets,
      homePathLeaks,
      // 说明这次内容扫描覆盖了多深。上层据此判断「0 命中」到底是真干净、还是没扫到：
      // 截断时不能把「没报」当成「没有」。
      contentScan: {
        filesScanned: candidates.length,
        truncated: walked.contentScanTruncated === true,
        // 深度超限是另一种「没扫到」，与「文件数超限」分开报——两者的处置不同
        // （前者要确认那层深目录里是不是有东西，后者要重扫）。任何一种都不能读成
        // 「检查过了，很干净」。
        depthLimited: walked.depthLimited,
        depthLimitedPaths: (walked.depthLimitedPaths ?? []).slice(0, 20),
        // 其余四类「没扫到」也各有一个数：超单文件上限、按扩展名跳过、读不出来、
        // 非 UTF-8（按宽松解码尽力扫，但编码没嗅探到）。任何一类非零，
        // 「无命中」都不等于「干净」。
        skippedLarge: walked.skippedLarge ?? 0,
        skippedByExtension: walked.skippedByExtension ?? 0,
        unreadable: scanned.stats.unreadable,
        notUtf8: scanned.stats.notUtf8,
        utf16Decoded: scanned.stats.utf16Decoded,
        scope: '递归（依赖目录排除；类产物目录体量排除但凭据仍扫描；二进制与超大文件排除，UTF-16 已按 BOM 或 NUL 密度嗅探解码）',
      },
      largeFiles: largeFiles.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
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
      for (const [name, url] of Object.entries(s.git.remoteUrls ?? {})) {
        L.push(`  - ${name}：${url === undefined ? '地址读不到' : url}`)
      }
      L.push(`  - 上游跟踪：${s.git.upstream === undefined ? '未设置' : s.git.upstream}`)
    } else {
      L.push(`- 远端：${s.git.remote === undefined ? '无' : s.git.remote}`)
      if (s.git.upstream === undefined) L.push('- 上游跟踪：未设置')
    }
    L.push(`- 署名：${yn(s.git.identity.name)} <${yn(s.git.identity.email)}>（${s.git.identity.scope}）`)
    if (s.git.identity.globalEmail !== undefined) {
      L.push(`- 全局署名邮箱：${s.git.identity.globalEmail}（与仓库级不一致时以仓库级为准）`)
    }
    if (Array.isArray(s.git.historyAuthors) && s.git.historyAuthors.length > 1) {
      L.push(`- 历史署名 ${s.git.historyAuthors.length} 种：${s.git.historyAuthors.join('；')}`)
    }
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
  if (s.dsh !== undefined) {
    const d = s.dsh
    L.push(`- DSH 包名：${d.packageName ?? '未声明'}`)
    L.push(`- DSH 补丁文件：${d.patchFile ?? '缺'}`
      + (d.bundlePatch === undefined ? '' : `；清单声明 ${d.bundlePatch.path}（${d.bundlePatch.exists ? '存在' : '缺失'}）`))
    L.push(`- DSH 入口：host ${d.hasHostEntry ? '有' : '缺'}；client ${d.hasClientEntry ? '有' : '无'}`
      + `（dsh.client 声明${d.hasClientDecl ? '有' : '无'}）；invariant ${d.hasInvariantEntry ? '有' : '无'}`)
    if (d.filesHasLib !== undefined) L.push(`- DSH 发布范围：files ${d.filesHasLib ? '含' : '缺'} lib；${d.filesHasPatch ? '含' : '缺'}补丁`)
    if (d.libTracked !== undefined) L.push(`- DSH 构建产物跟踪：lib ${d.libTracked ? '已被跟踪' : '未被跟踪'}（与 files 是两套集合）`)
    if (d.hostRuntimeInDeps === true) L.push('- **DSH 依赖放错**：宿主运行时进了 dependencies，应为 peer')
    if (d.discoveryCarrierLikely === false) L.push('- **DSH 发现载体可能缺失**：补丁文本里没有出现包名')
    if (Array.isArray(d.unknownKeys) && d.unknownKeys.length > 0) {
      L.push(`- **DSH 清单有不认识的字段**：${d.unknownKeys.join('、')}`
        + '——可能是新版宿主加的东西，按六问现场核实，不要猜，也不要照旧流程装懂')
    }
    for (const w of d.warnings ?? []) L.push(`- DSH 注意：${w}`)
  }
  if (Array.isArray(s.localSkills) && s.localSkills.length > 0) {
    L.push(`- 本地 skills ${s.localSkills.length} 个：${s.localSkills.map((x) => x.path).join('、')}`)
    for (const x of s.localSkills) {
      if (x.corrupt === true) L.push(`  - ${x.path}：SKILL.md 损坏或缺失，先修再用`)
    }
  }
  L.push('')
  L.push('## 可执行命令')
  L.push('')
  const cmds = Object.entries(s.commands).filter(([k, v]) => typeof v === 'string'
    && !['packageManager', 'byEcosystem', 'multipleEcosystems'].includes(k) && !k.endsWith('Note'))
  if (cmds.length === 0) L.push('- 未推导出任何命令（正常结果：说明项目没声明这些命令，'
    + '不代表错误；此时 P7 的验证不成立，见 SKILL.md）')
  else for (const [k, v] of cmds) L.push(`- ${k}：\`${v}\``)
  if (s.commands?.multipleEcosystems !== undefined) {
    L.push('')
    L.push(`- **本项目命中多种生态**：${s.commands.multipleEcosystems.join('、')}。`
      + '上面每类命令只保留了一个（同名字段会互相覆盖）。实际执行前请按生态分别确认，'
      + '不要把某一个生态的命令当成全部。')
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
  const reqs = a.runtimeRequirements ?? []
  if (reqs.length === 0) {
    L.push('- 声明的运行环境下限：**未声明**'
      + '（写面向使用者的文档时，取不到就不要写那一节，也不要编一个数字）')
  } else {
    L.push('- 声明的运行环境下限（写环境要求那一节的唯一权威来源）：')
    for (const r of reqs) L.push(`  - ${r.runtime} ${r.range}（${r.declaredIn}）`)
  }
  if (a.declaredVersion !== undefined) {
    if (a.versionAligned === true) L.push(`- 标签与版本号：对齐（清单 ${a.declaredVersion}）`)
    else if (a.versionAligned === false) {
      L.push(`- **标签与版本号未对齐**：清单 ${a.declaredVersion}，已有标签 ${(a.versionAlignedTags ?? []).join('、') || '无'}`
        + '——不一致会让后续自动化对不上')
    }
  }
  if (a.obsidianArtifacts !== undefined) {
    const o = a.obsidianArtifacts
    // main.js 根目录缺席是正常态（官方模板要求它只进发布附件，不进版本库）：
    // “有”只说明构建过，“无”不说明断链——断链看的是发布附件，不是仓库根。
    // mainJsIgnored 区分“有意忽略”与“还没构建过”。
    const mainState = o.mainJs === true ? '有（构建产物在仓库根，发布前确认附件即可）'
      : o.mainJsIgnored === true ? '无（已被忽略规则排除，符合官方模板：只进发布附件）'
        : '无（且未被忽略：要么还没构建，要么忽略规则漏了 main.js）'
    L.push(`- Obsidian 发布：manifest.json 有；main.js ${mainState}；`
      + `styles.css ${o.stylesCss ? '有' : '无（可选，无样式时两处都可省略）'}；`
      + `versions.json ${o.hasVersionsJson ? '有' : '无（只在 minAppVersion 变化时才需要）'}`)
    if (o.manifestId !== undefined) {
      L.push(`- Obsidian 插件 id：${o.manifestId}`
        + (o.manifestIdShapeOk === true ? '（形状符合：小写连字符、无 obsidian、无 plugin 结尾）'
          : o.manifestIdShapeOk === false ? '（**形状可疑**：应为小写字母与连字符、不含 obsidian、不以 plugin 结尾，提交审核会被拒）'
            : ''))
    }
  }
  if (a.pythonMeta !== undefined) {
    const p = a.pythonMeta
    const lacks = []
    if (p.hasBuildSystem !== true && a.pythonBuild?.hasBuildSystem !== true) lacks.push('构建后端')
    if (p.hasReadme !== true) lacks.push('readme')
    if (p.hasLicense !== true) lacks.push('license')
    if (p.hasRequiresPython !== true) lacks.push('requires-python')
    const lacksText = lacks.length === 0 ? '构建后端/readme/license/requires-python 都有'
      : '缺 ' + lacks.join('、') + '（前两者缺了服务端大概率拒绝，末者缺了装到旧版难定位）'
    L.push('- Python 发布元数据：' + lacksText
      + (p.hasDynamicVersion === true ? '；版本号走 dynamic（tag 对齐按后端取值，不要照抄文件里的字面）' : ''))
  }
  if (a.cargoMeta !== undefined) {
    const c = a.cargoMeta
    const over = []
    if (typeof c.keywordsCount === 'number' && c.keywordsCount > 5) over.push(`keywords ${c.keywordsCount} 个（上限 5）`)
    if (typeof c.categoriesCount === 'number' && c.categoriesCount > 5) over.push(`categories ${c.categoriesCount} 个（上限 5）`)
    const overText = over.length > 0 ? '；**' + over.join('、') + '，超了服务端拒绝**' : ''
    L.push('- Rust 发布元数据：license ' + (c.license ? '有' : '**缺**') + '；description ' + (c.description ? '有' : '**缺**')
      + (c.hasEdition === true ? '；edition 有' : '；edition 未声明（缺省 2015 可发布，建议显式声明）')
      + overText)
  }
  L.push('')
  L.push('## 忽略规则')
  L.push('')
  const ig = s.ignores ?? {}
  L.push(`- 忽略文件：${ig.gitignore === undefined ? '**缺**（没有它，依赖与产物目录会被提交）'
    : `有（${ig.gitignore.lines} 条有效规则）`}`)
  L.push(`- 文本属性声明：${ig.gitattributes === undefined
    ? '缺（行尾不一致会让产物在不同机器上重建出不同字节）' : '有'}`)
  if (Array.isArray(ig.unignoredOutputDirs) && ig.unignoredOutputDirs.length > 0) {
    L.push(`- **存在但未被忽略的目录**：${ig.unignoredOutputDirs.join('、')}`)
    L.push(`  - ${ig.unignoredNote}`)
  }
  if (Array.isArray(ig.ignoredButTracked) && ig.ignoredButTracked.length > 0) {
    L.push(`- **已被跟踪又被忽略**：${ig.ignoredButTracked.length} 个`
      + '（忽略规则对已跟踪文件无效，它们仍在版本库里；要移除须先从索引删除）')
    for (const p of ig.ignoredButTracked.slice(0, 5)) L.push(`  - ${p}`)
  }
  L.push('')
  L.push('## 文档现状')
  L.push('')
  for (const [k, v] of Object.entries(s.docs)) {
    if (k === 'readmePair' || k === 'readmeSections' || k === 'workflowAutomation') continue
    if (v === undefined) L.push(`- ${k}：缺`)
    else if (Array.isArray(v)) L.push(`- ${k}：${v.length === 0 ? '缺' : v.join('、')}`)
    else if (typeof v === 'object' && v.file !== undefined) L.push(`- ${k}：${v.file}（${humanBytes(v.bytes)}）`)
    else L.push(`- ${k}：${JSON.stringify(v)}`)
  }
  const pair = s.docs?.readmePair
  if (pair !== undefined) {
    L.push(`- **双语 README**：默认 \`${pair.default}\`，另有 ${pair.variants.join('、')}`)
    L.push(`  - ${pair.note}`)
  }
  const sections = s.docs?.readmeSections
  if (Array.isArray(sections) && sections.length > 0) {
    // 只报「有哪些节」，不报「缺哪几节」：README 的结构本来就没有标准，
    // 命令行工具、库、数据项目的合理结构各不相同。给出事实，判断留给读的人。
    L.push(`- 主 README 的节（${sections.length} 个）：${sections.join('　')}`)
    L.push('  - 这是事实不是结论。对照 `templates/readme.md` 看该补什么——'
      + '但**不要为了对齐模板而重排作者的编排**，README 的结构没有标准。')
  }
  const auto = s.docs?.workflowAutomation
  if (auto !== undefined) {
    L.push(`- 自动化现状：工作流 ${auto.files.join('、') || '无'}；`
      + `发布 job：${auto.hasReleaseJob ? '有' : '无'}；Secrets 引用：${auto.usesSecrets ? '有' : '无'}；`
      + `OIDC 短时身份：${auto.usesOidc ? '有' : '无'}（npm 自动发布靠它，无则对照可信发布接线步骤）`)
    if (!auto.hasReleaseJob) L.push('  - 无发布 job 时对照 `templates/ci-release.yml` 看该不该补')
    else {
      // 发布 job 的三处形状只报“有无”，结论由 review 下：
      // RELEASE_TOKEN 引用、contents 写权限、全历史检出，三者缺一都值得问一句。
      const shapeLacks = []
      if (auto.usesReleaseToken !== true) shapeLacks.push('未引用约定的 RELEASE_TOKEN')
      if (auto.hasContentsWrite !== true) shapeLacks.push('未声明 contents: write')
      if (auto.hasFetchDepthZero !== true) shapeLacks.push('检出缺 fetch-depth: 0（起草读不到上一个标签）')
      if (shapeLacks.length > 0) L.push(`  - 发布 job 形状缺口：${shapeLacks.join('、')}`)
      if (Array.isArray(auto.releaseTriggerTags) && auto.releaseTriggerTags.length > 0) {
        L.push(`  - 标签触发器原文：${auto.releaseTriggerTags.join('、')}（Obsidian 项目须为裸版本形状，见专章第七节）`)
      }
      const ecoPublishes = []
      if (auto.hasNpmPublish === true) ecoPublishes.push('npm publish')
      if (auto.hasPypiPublish === true) ecoPublishes.push('pypi 上传')
      if (auto.hasCargoPublish === true) ecoPublishes.push('cargo publish')
      if (ecoPublishes.length > 0) L.push(`  - 生态发布动作痕迹：${ecoPublishes.join('、')}（按对应专章核对接线，不要只看 Release 建了没有）`)
    }
    if (auto.truncated === true) {
      L.push(`  - **有工作流只读了前 ${auto.headLimit ?? WORKFLOW_HEAD_LIMIT} 字符，未报不等于没有**：发布 job 藏在后面的大文件需手工确认`)
    }
  }
  L.push('')
  L.push('## 风险')
  L.push('')
  const r = s.risks
  if (r.secretFiles.length === 0) {
    L.push('- 敏感文件：无')
  } else {
    const names = r.secretFiles.slice(0, 5).map((h) => typeof h === 'string' ? h : h.path).join('、')
    L.push(`- 敏感文件：${r.secretFiles.length} 个（${names}）`)
    for (const hit of r.secretFiles.slice(0, 5)) {
      if (typeof hit === 'string') continue
      L.push(`  - ${hit.path}（${hit.tracked === true ? '**已在版本库里**' : '尚未跟踪'}）`)
    }
  }
  L.push(`- 内容里的凭据形状：${r.secretContent.length === 0 ? '无' : r.secretContent.length + ' 处'}`)
  if (r.secretContent.length > 0) {
    for (const hit of r.secretContent.slice(0, 10)) {
      // tracked 这一个比特决定处置：未跟踪的能从这次提交排除，已在历史里的只能轮换。
      L.push(`  - ${hit.path}:${hit.line ?? '?'}（${hit.kind}，`
        + `${hit.tracked === true ? '**已在版本库里**' : '尚未跟踪'}）`)
    }
    L.push('  - 处置分情况，见 references/version-control.md 的「密钥与敏感信息门控」：'
      + '不要因为一处历史凭据就停下全部工作。')
  }
  const leaks = r.homePathLeaks.filter((h) => h.kind === 'leak')
  const benign = r.homePathLeaks.filter((h) => h.kind !== 'leak')
  if (leaks.length > 0) {
    L.push(`- **本机私有路径 ${leaks.length} 处（需要处理）**：`)
    for (const h of leaks.slice(0, 5)) L.push(`  - ${h.path}（${h.sample}）—— ${h.advice}`)
  } else {
    L.push('- 本机私有路径：无')
  }
  if (benign.length > 0) {
    // 与真泄漏分开报：处置建议相反，混在一起会让人去改不该改的东西
    L.push(`- 形似路径但无需处理 ${benign.length} 处（已按性质分类，处置建议各不相同）：`)
    for (const h of benign.slice(0, 5)) {
      L.push(`  - ${h.path}（${h.sample}，${h.kind}）—— ${h.advice}`)
    }
  }
  L.push(`- 大文件（≥20MB）：${r.largeFiles.length === 0 ? '无' : r.largeFiles.map((f) => f.path).slice(0, 5).join('、')}`)
  L.push(`- 嵌套仓库：${r.nestedRepos.length === 0 ? '无' : r.nestedRepos.join('、')}`)
  const scan = r.contentScan
  if (scan !== undefined) {
    L.push(`- 内容扫描覆盖：${scan.filesScanned} 个文件（${scan.scope}）`
      + (scan.truncated ? ' **已达文件数上限被截断，未报不等于没有**' : ''))
    if (scan.depthLimited > 0) {
      L.push(`- **有 ${scan.depthLimited} 个子目录因嵌套过深未进入**`
        + `（超过 ${MAX_WALK_DEPTH} 层）——里面若放了凭据不会被发现。`
        + '确认那些目录不需要检查，或手工看一眼。')
    }
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
  // `-h` 也是帮助开关，必须先从位置参数里排除：只看 `--` 前缀的话，`-h` 会被当成
  // 目录名（实测报「目录不存在 …\-h」，而帮助分支永不成立）。
  const flags = args.filter((a) => a.startsWith('--') || a === '-h')
  const positional = args.filter((a) => !a.startsWith('--') && a !== '-h')
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

// 只有被直接执行时才跑 main；被 import 时只导出纯函数与 survey，不产生副作用。
// 判据见 isMainModule：按**真实路径**比较，经 junction / 符号链接调用也算直接执行
// （字面比较会静默空跑并返回 0，那是自检假绿）。
if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main(process.argv)

/**
 * 这个脚本**可能产出的全部 kind**。
 *
 * 文档里的生态清单以它为准：selftest 断言 `references/survey.md` 的清单与它集合相等，
 * 于是「代码加了新生态、文档没跟上」当场变红——而不是等人照着过期文档判断。
 * 新增生态时只改代码，文档由断言逼着同步。
 */
export function kindVocabulary() {
  return [...new Set([
    ...SOURCE_EXT_KINDS.map(([, kind]) => kind),
    ...BUILD_FILE_KINDS.map(([, kind]) => kind),
    ...NESTED_MANIFEST_KINDS.map(([, kind]) => kind),
    'node', 'python', 'rust', 'go', 'java', 'dotnet', 'ruby', 'php', 'swift', 'dart', 'elixir', 'clojure', 'perl', 'cpp',
    'dsh-plugin', 'skill', 'vscode-extension', 'obsidian-plugin',
    'docs-only', 'unrecognized', 'unknown',
  ])].sort()
}

export { survey, toMarkdown, humanBytes }
