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

// ── 从 lib/ 转出 ────────────────────────────────────────────────────────────
//
// 通用文本判据与围栏扫描住在 lib/，本文件只导入自己实际用到的部分。
// 它们是本文件的下游，本文件不转出它们——需要的人直接从 lib/ 取，
// 否则任何想判断「这是不是主模块」的脚本又得把整个勘察引擎加载进来。
import { posixPath, readTextFile, isMainModule, decodeText, frontmatterBlock } from './lib/text.mjs'
export { parseGitHubRepo } from './lib/text.mjs'
// 协议常量（注入标记、占位符、预算）住在 lib/protocol.mjs：它们被四个脚本共用，
// 而任何想拿一个标记的脚本都不该因此加载整个勘察引擎。
export {
  KERNEL_START, KERNEL_END, MANAGED, UPGRADED, KEEP, SUMMARY_MARKER, INSTRUCTION_BUDGET,
} from './lib/protocol.mjs'
import { KERNEL_START, KERNEL_END, MANAGED, UPGRADED, KEEP, SUMMARY_MARKER, INSTRUCTION_BUDGET, COMMAND_KEYS } from './lib/protocol.mjs'
import { scanLines } from './lib/markdown.mjs'
import { HOST_ECOSYSTEMS, detectHost, deriveHostFacts } from './ecosystems.mjs'


/**
 * 走目录时的目录规则。**一份表，两种投影**——之前分成「走查跳过哪些」与「哪些应当被
 * 忽略」两张清单，各自维护过一次，漂移出来的后果是两头都不落：`walk()` 整目录跳过的
 * 名字进不了走查结果，而顶层补漏只按第二张清单筛，于是它既没被走查统计，也从没进过
 * 「存在但未被忽略」的检查。
 *
 * 每条两个字段，都必须写明：
 *   - `walk`：`external` = 装的是依赖、缓存或工具产物，**不可能是项目自己的源码**，
 *     走查整体跳过（体量与凭据都不参与）；`artifact` = 名字像产物，但**也可能藏着源码
 *     或配置**——`bin/` 在 C++、Java 项目里是编译输出，在脚本项目里却常是源码目录，
 *     `vendor/` 里也常有被复制进来的凭据文件。整体跳过会让 `bin/.env` 里的密钥零命中
 *     而报告仍显示「无命中」，所以它们**统计体量时排除、凭据扫描照常进入**。
 *   - `ignored`：这个目录「存在却没被忽略」时值不值得报一句。判据是「提交它几乎总是
 *     意外的」——`bin/`、`release/` 这类名字在脚本项目里就是源码，提交它常常是有意的，
 *     报出来是噪音；编辑器本地状态同理。
 *
 * 判据是「这个名字出现时，里面装的大概率不是项目自己的源码」——拿不准的不要放这里。
 * `.git` 不在此表：版本控制元数据是另一回事，由 walk() 单独跳过。
 */
const DIR_RULES = [
  { name: 'node_modules', walk: 'external', ignored: true },
  { name: '.pnpm-store', walk: 'external', ignored: true },
  { name: '.yarn', walk: 'external', ignored: true },
  { name: 'bower_components', walk: 'external', ignored: true },
  { name: '.venv', walk: 'external', ignored: true },
  { name: 'venv', walk: 'external', ignored: true },
  { name: '__pycache__', walk: 'external', ignored: true },
  { name: '.mypy_cache', walk: 'external', ignored: true },
  { name: '.pytest_cache', walk: 'external', ignored: true },
  { name: '.ruff_cache', walk: 'external', ignored: true },
  { name: '.tox', walk: 'external', ignored: true },
  { name: '.gradle', walk: 'external', ignored: true },
  { name: '.cache', walk: 'external', ignored: true },
  { name: '.parcel-cache', walk: 'external', ignored: true },
  { name: '.turbo', walk: 'external', ignored: true },
  { name: '.docusaurus', walk: 'external', ignored: true },
  { name: '.svelte-kit', walk: 'external', ignored: true },
  { name: '_site', walk: 'external', ignored: true },
  { name: '.next', walk: 'external', ignored: true },
  { name: '.nuxt', walk: 'external', ignored: true },
  { name: 'dist', walk: 'artifact', ignored: true },
  { name: 'build', walk: 'artifact', ignored: true },
  { name: 'out', walk: 'artifact', ignored: true },
  { name: 'target', walk: 'artifact', ignored: true },
  { name: 'coverage', walk: 'artifact', ignored: true },
  { name: 'vendor', walk: 'artifact', ignored: true },
  { name: 'bin', walk: 'artifact', ignored: false },
  { name: 'obj', walk: 'artifact', ignored: false },
  { name: 'release', walk: 'artifact', ignored: false },
  { name: 'debug', walk: 'artifact', ignored: false },
  { name: '.idea', walk: 'artifact', ignored: false },
  { name: '.vscode', walk: 'artifact', ignored: false },
]

/**
 * 走查整体跳过的目录名。
 *
 * **导出来给别的脚本复用**：哪些目录「装的是依赖与缓存，不可能装本项目的痕迹」是一条
 * 通则，各脚本各立一份名单，迟早出现一个脚本没跳、于是把几百兆依赖目录读进来——
 * 而两边的名单谁也没错，只是漂了。唯一的例外是 `.git`：版本控制元数据由 walk() 单独
 * 跳过，不在这张表里。
 */
export const SKIP_DIRS = new Set(DIR_RULES.filter((d) => d.walk === 'external').map((d) => d.name))
/** 体量统计排除、但凭据扫描要进入的目录名。 */
const ARTIFACT_MAYBE_DIRS = new Set(DIR_RULES.filter((d) => d.walk === 'artifact').map((d) => d.name))
/** 「存在却没被忽略」时值得报一句的目录名。全树任何深度都收候选，判定交给版本控制。 */
const OUTPUT_DIR_HINTS = DIR_RULES.filter((d) => d.ignored).map((d) => d.name)

/**
 * 敏感文件按**名字形状**命中，分两档。
 *
 * `always` —— 名字本身就是凭据：`.env*` 装的是环境变量、私钥后缀装的是密钥，
 * 不看内容也该看一眼。
 * `confirm` —— 名字像，但同一个名字下绝大多数是正常配置：`.npmrc` 里通常只有一行
 * `registry=`（几乎每个 JS 项目都有），`credentials` / `secrets` 也常是模板或空壳。
 * 这一档要**内容里出现凭据形状**才报，复用 SECRET_CONTENT_PATTERNS。
 *
 * 两档都要：漏报一个真凭据是安全事故，而让 `.npmrc` 天天误报则会让使用者学会忽略
 * 「敏感文件」这一整行——那才是真正的漏报。取值落在内容层，不落在文件名层。
 */
const SECRET_FILE_PATTERNS = [
  { re: /^\.env(\..+)?$/i, tier: 'always' },        // .env / .env.local
  { re: /\.(pem|key|p12|pfx|jks|keystore)$/i, tier: 'always' },
  { re: /^id_(rsa|dsa|ecdsa|ed25519)$/i, tier: 'always' },
  { re: /^(credentials|secrets?)\b/i, tier: 'confirm' },
  { re: /\.(npmrc|netrc|pypirc|git-credentials)$/i, tier: 'confirm' },
  { re: /\.(token|secret|credential)s?\./i, tier: 'confirm' },
  { re: /^service-account.*\.(json|ya?ml)$/i, tier: 'confirm' },
]

/** 这些同名文件是模板而非真凭据，不报为风险。 */
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
 * 三档必须分开：测试里写的 `cwd: '/home/me/deepseek'` 是**假数据**，把它报成真泄漏
 * 并建议「改成相对路径或环境变量」，照着做就把测试改坏了。
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

/**
 * 遍历的硬上限：条目数与深度。
 *
 * **导出来给别的脚本复用**：这两个数是「别在超大仓库上跑成天」的兜底，各脚本各定一个，
 * 就会出现一个脚本的上限松到能读几小时、而另一个早就放弃了。唯一的理由不同就该调这里，
 * 而不是各写各的。
 */
export const MAX_WALK_ENTRIES = 200000
export const MAX_WALK_DEPTH = 24
const LARGE_FILE_BYTES = 20 * 1024 * 1024
/** 单文件内容扫描的字节上限：超限的文件算「没扫到」，并把路径报出来。 */
export const CONTENT_SCAN_MAX_BYTES = 2 * 1024 * 1024
const CONTENT_SCAN_MAX_FILES = 5000
/** 单个工作流文件只读的前 N 字符；超限置 truncated，值随输出携带。 */
const WORKFLOW_HEAD_LIMIT = 65536

// ── 工具函数 ────────────────────────────────────────────────────────────────

/** 版本控制的批量输出可能很大（受控文件清单、标签列表）。留足余量。 */
const GIT_MAX_BUFFER = 16 * 1024 * 1024


function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER })
  if (r.error || r.status !== 0) return undefined
  return (r.stdout ?? '').trim()
}

/**
 * 一次问 git 一件事的通用入口：**多数取值都不止需要一个字段**。
 *
 * 与 `run` 的区别只有一条：它把「命令失败」与「输出为空」分开传出来。
 * 版本控制状态要分三态（有 / 没有 / 没问出来），而 `run` 把失败折叠成
 * `undefined`、把空输出折叠成 `''`，两者在下游没法区分。这里统一成对象。
 *
 * 不抛异常、不重试：调用方要的是「问到了什么」，不是「命令成功了吗」。
 */
function runCapture(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER })
  const failed = r.error !== undefined || r.status !== 0
  return {
    ok: !failed,
    status: r.status ?? -1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
  }
}

/**
 * 与 run 相同，但关掉 git 对非 ASCII 路径的引号转义。
 *
 * git 默认把含非 ASCII 的路径输出成 `"\344\270\255..."` 这种带引号的八进制转义形式。
 * 那种形式的路径在我们这边既匹配不上文件、也读不出内容，于是这些文件会**静默地**从
 * 结果里消失——中文目录里的文件因此永远不被检查。
 * `-c core.quotepath=false` 让它按原样输出；`-z` 则进一步用 NUL 分隔，彻底避开转义与
 * 空格带来的解析歧义。
 *
 * 返回值已归一化成正斜杠。**取不到时返回 undefined**，调用方必须把它与「结果是空的」
 * 区分开：前者是「没问出来」，后者是「问出来是没有」。
 */
function runGitPaths(args, cwd) {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args],
    { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: GIT_MAX_BUFFER })
  if (r.error || r.status !== 0) return undefined
  const out = r.stdout ?? ''
  // 使用 -z 时按 NUL 切分；否则按换行。两者都过滤空项。
  const parts = out.includes('\0') ? out.split('\0') : out.split('\n')
  return parts.filter(Boolean).map(posixPath)
}

/**
 * 一批路径里哪些被忽略规则覆盖。返回 Set（正斜杠分隔）。
 *
 * **一次进程判定全部候选**（`check-ignore --stdin -z`）：逐个 spawn 的代价随候选数
 * 线性增长。`-z` 让路径按字节进出，含空格与中文的路径不会被引号化改写成另一个字符串。
 * 退出码 1 = 「一个都没忽略」，那是正常结果，返回空集。
 *
 * **取不到时返回 undefined**（不是工作区、命令不存在、输出超上限）。调用方据此走
 * 「无法确认」的分支：把取不到当成「没被忽略」会凭空造出一条假的紧急警报。
 */
function gitIgnoredSet(cwd, relPaths) {
  const list = (relPaths ?? []).map(posixPath).filter((p) => p !== '')
  if (list.length === 0) return new Set()
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'check-ignore', '-z', '--stdin'], {
    cwd, encoding: 'utf8', windowsHide: true,
    input: `${list.join('\0')}\0`, maxBuffer: GIT_MAX_BUFFER,
  })
  if (r.error !== undefined || (r.status !== 0 && r.status !== 1)) return undefined
  return new Set(String(r.stdout ?? '').split('\0').filter(Boolean).map(posixPath))
}


function readText(p) {
  const r = readTextFile(p)
  return r === undefined ? undefined : r.text
}

/**
 * 读 JSON：**结果形状只有两种**——对象或 `{ __corrupt: true }`。
 *
 * `JSON.parse` 合法的结果不止对象（`null`、数组、字符串、数字都是合法 JSON），而所有
 * 消费点都按对象用（`pkg.__corrupt`、`obs.minAppVersion`）。一个内容为 `null` 的
 * package.json 会把整次勘察打断，于是「清单损坏」这种**可预期**的形态变成崩溃。
 * 这里一次归一，消费点就不必各写守卫。
 *
 * **`__reason` 区分三种读不出来**：内容读出来了但不是合法 JSON（`syntax`）、内容压根
 * 没读出来——不是合法 UTF-8/UTF-16（`encoding`）、内容是合法 JSON 但不是对象（`shape`）。
 * 修正动作完全不同：前两种一个要改 JSON、一个要转存编码，而把它们混成一句话，
 * 使用者就会去改一个没坏的文件（或去转存一个只是 JSON 写错了的文件）。
 */
function readJson(p) {
  const r = readTextFile(p)
  if (r === undefined) return undefined
  if (r.encoding === 'unknown') return { __corrupt: true, __reason: 'encoding' }
  let parsed
  try {
    parsed = JSON.parse(r.text)
  } catch {
    return { __corrupt: true, __reason: 'syntax' }
  }
  if (parsed !== null && typeof parsed === 'object') return parsed
  return { __corrupt: true, __reason: 'shape' }
}


/**
 * 数 AGENTS.md 里的待填写标记（`<!-- pf:author: … -->`），并给出它所在的小节。
 *
 * **整篇扫描，不逐行**：标记可以写成多行（`<!-- pf:author:` 换行后 `-->`），
 * 逐行扫会漏掉它们——而那正是「脚本报 0 处、脚手架被删、TODO 还留在正文」的成因。
 * compose-agents 与 review 都引用这一份：三处各写一份的实现，同一份多行标记会得出
 * 三个数，而调用方只信自己那份。
 */
export function authorMarkers(text) {
  const s = String(text)
  // 一个标记也必须有闭合的 `-->`。正文里压根没有它时，一个标记都不可能有——
  // 先花一次线性扫描把它挡掉，否则下面那个正则会在每个候选位置上向前一直找
  // 到文末，耗时按文件长度的**平方**增长（实测 300KB 就要 130 多毫秒，
  // 而单文件上限是 2MB）。这条挡掉的是病态输入，判定结果与不挡时**完全一样**。
  if (!s.includes('-->')) return []
  const re = /<!--\s*pf:author\s*(?::[\s\S]*?)?-->/g
  const found = []
  let lastHeading = '(文件开头)'
  let cursor = 0
  for (const hit of s.matchAll(re)) {
    const before = s.slice(cursor, hit.index)
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

/**
 * 能力目录的可见性键与它接受的等价真值写法。
 *
 * 宿主侧的契约（键名用连字符、驼峰写法会让整个目录被丢弃、取值是布尔或等价真值、
 * 拼错同样丢弃而不静默放行某一个接口）写在 `references/skill-project.md`；
 * 这里只实现「怎么从文本里读出它」，形状照抄那份契约，不在代码里另立一套规则。
 */
const SKILL_INVOCATION_KEYS = [
  // [frontmatter 键, 结果字段, 取真值时的字段值]
  ['disable-model-invocation', 'modelInvocable', false],
  ['user-invocable', 'userInvocable', true],
]
/** 宿主明确拒绝的驼峰旧键：出现即整个目录被丢弃，语义上等于「不存在」。 */
const SKILL_LEGACY_INVOCATION_KEYS = ['disableModelInvocation', 'modelInvocable', 'userInvocable']
const SKILL_BOOL_TRUE = /^(?:true|yes|on|1)$/i
const SKILL_BOOL_FALSE = /^(?:false|no|off|0)$/i

/**
 * 读 frontmatter 里的可见性键，省略的键默认放行。
 *
 * 三种结果：正常值、键名非法（驼峰）、取值非法。第三种与第二种都必须报出来——
 * 宿主对它们的反应是「整个目录不存在」，症状与「压根没装」完全一样。
 */
function skillInvocation(block) {
  for (const key of SKILL_LEGACY_INVOCATION_KEYS) {
    if (new RegExp(`^${key}:`, 'm').test(block)) {
      return { dropped: `调用键「${key}」是驼峰写法，宿主会丢弃整个能力目录` }
    }
  }
  const invocation = { modelInvocable: true, userInvocable: true }
  for (const [key, field, whenTrue] of SKILL_INVOCATION_KEYS) {
    const matched = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(block)
    if (matched === null) continue
    const raw = matched[1].trim().replace(/^["']|["']$/g, '')
    if (SKILL_BOOL_TRUE.test(raw)) invocation[field] = whenTrue
    else if (SKILL_BOOL_FALSE.test(raw)) invocation[field] = !whenTrue
    else return { dropped: `调用键「${key}」的取值「${raw}」不是布尔值，宿主会丢弃整个能力目录` }
  }
  return { invocation, dropped: undefined }
}














/**
 * 解析 frontmatter 里的 name/description（只为识别 skill 项目，不做完整 YAML 解析）。
 *
 * 返回 undefined = 「这不是能力目录」；`dropped` 非空 = 「是，但宿主会把它整个丢掉」。
 * 这两种状态必须能分开报告：后者的症状是「目录在、技能不在」，混进「没有」里就
 * 再也查不出来，而它恰恰是这一类最常见、也最容易被误诊的故障。
 */
function skillFrontmatter(text) {
  const block = frontmatterBlock(text)
  if (block === undefined) return undefined
  const name = /^name:\s*(.+)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, '')
  const hasDescription = /^description:\s*/m.test(block)
  if (name === undefined || !hasDescription) return undefined
  const invocation = skillInvocation(block)
  return {
    name,
    invocation: invocation.invocation,
    dropped: invocation.dropped,
  }
}

/** 能力目录的入口文件名（大小写两种写法都在用）。生态判定与本地盘点共用这一份。 */
const SKILL_ENTRY_NAMES = ['SKILL.md', 'skill.md']

/**
 * 本地 skills 在仓库内的可提交位置。
 *
 * 这些位置是**格式约定**的一部分，被多家宿主各取其一，不是某一家独占的目录布局。
 * 新增一处的判据是「确实有宿主会从这里发现」，不是「这个路径看着合理」——多收一处
 * 就会报出宿主根本不会加载的目录，而盘点一旦开始报假的东西，就没人再读它了。
 * 顺序即报告里的优先级：同一个能力目录出现在多处时，先出现的排在前面。
 */
const LOCAL_SKILL_BASES = ['.dsh/skills', '.agents/skills', '.claude/skills', 'skills']


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
    // 这些数字是必须的：每一类「没扫到」都不报出来时，「0 命中」会被读成
    // 「扫过了、很干净」——一个只超上限 100 字节、里面是真令牌的 2.1MiB 文本
    // 就这样静默漏掉。
    skippedLarge: 0,
    // 超单文件上限的**路径**也要留着：敏感文件的两级判定用它区分「扫过没命中」与
    // 「根本没扫」。只记数量的话，一个超限的 credentials.json 只能靠猜。
    skippedLargePaths: new Set(),
    skippedByExtension: 0,
    // 产物目录候选（全树、任何深度），由 detectIgnores 一次批处理判定忽略与否。
    outputDirCandidates: [],
    // 深度超限被跳过的子树数量。
    //
    // 这个计数是必须的：递归有深度上限（防止符号链接环或病态嵌套把扫描拖死），但
    // **静默地不扫**是最坏的结果——报告里写着「递归、已排除依赖目录」，读起来像全扫过了。
    depthLimited: 0,
    depthLimitedPaths: [],
    // 读不出来的目录（整棵子树没进勘察）。与 sourceScan 无关，所以挂在顶层。
    unreadableDirs: [],
    // 生态兜底判定要用的证据：走查时顺手在**全树**里找源码与构建描述文件。
    // 只在顶层找是不够的——真实项目的代码几乎总在 src/、packages/、cmd/ 这类子目录下。
    sourceScan: {
      byExtension: new Map(),        // 生态 → 首个命中的源码文件
      byBuildFile: new Map(),        // 生态 → 首个命中的构建描述文件（强信号）
      byBuildEntry: new Map(),       // 构建入口文件 → 路径（弱信号，不定生态）
      byNestedManifest: new Map(),   // 生态 → 子目录里的首个清单（monorepo 线索）
      nonDocSamples: [],             // 疑似「非文档」的文件（用于区分纯文档目录）
      unrecognizedManifests: [],     // 根目录里「像清单但清单表里没有」的文件（新生态的线索）
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
      // 读不出来的目录**必须计数**：跳过一个目录等于整棵子树没进勘察，而「跳过了」
      // 与「里面没有东西」在报告里长得一样。文件读失败会计数，目录读失败同样要——
      // 同一类问题两种待遇，先失效的永远是没计数的那一个。
      result.unreadableDirs.push(dir.slice(root.length + 1) || '.')
      continue
    }
    // 按码位排：遍历顺序会传到 `kinds` 的先后（各平台的 `readdirSync` 次序不同），
    // 同一份输入在不同文件系统上给出不同顺序的报告是这个工具最不该有的性质。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (result.totalFilesSeen > MAX_WALK_ENTRIES) {
        result.truncated = true
        // 走查提前退出 = 整棵树没走完 = 内容扫描只覆盖了走过的那部分。
        // 不置这个标志，「内容里的凭据形状：无」会被读成「扫过了、很干净」——
        // 而它其实只是没扫到。那是这个标志存在的全部理由。
        result.contentScanTruncated = true
        return result
      }
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
        // 产物目录候选：**全树任何深度**都收，不猜「只下沉一层」。标准 monorepo 布局是
        // `packages/<包名>/dist`，只探到 depth=1 会漏掉它——漏掉的那些会被下一次
        // `git add -A` 整个写进历史，而门禁一声不响。
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
      // 记下「文件名命中哪一档」。`confirm` 那一档要等内容扫描完才能定案，所以这里
      // 只记账，不下结论——结论在 survey() 里把内容结果合进来时才算。
      const tier = secretFileTier(entry.name)
      if (tier !== undefined) result.secretFiles.push({ path: rel, tier })
      if (size > 0 && size <= CONTENT_SCAN_MAX_BYTES && !CONTENT_SCAN_SKIP.test(rel)) {
        if (result.textCandidates.length < CONTENT_SCAN_MAX_FILES) result.textCandidates.push(rel)
        else result.contentScanTruncated = true
      } else if (size > CONTENT_SCAN_MAX_BYTES) {
        // 「没扫到」也是事实：超单文件上限的文件数要报出来，
        // 否则「0 命中」会被读成「扫过了、很干净」。
        result.skippedLarge += 1
        result.skippedLargePaths.add(rel)
      } else if (size > 0 && CONTENT_SCAN_SKIP.test(rel)) {
        result.skippedByExtension += 1
      }
      collectSourceEvidence(result.sourceScan, entry.name, rel, depth)
    }
  }
  return result
}

/**
 * 这个文件名命中哪一档敏感形状：模板一律放行；命中则返回 `always` 或 `confirm`，
 * 都不命中返回 undefined。
 *
 * 消费方拿到的必须是一句明确的判定，不能是「匹配上了」——`confirm` 那一档还要看内容，
 * 而内容是走查之后才读到的。
 */
function secretFileTier(name) {
  if (SECRET_FILE_ALLOWLIST.some((re) => re.test(name))) return undefined
  for (const { re, tier } of SECRET_FILE_PATTERNS) {
    if (re.test(name)) return tier
  }
  return undefined
}

/** 文档类扩展名：它们不算「这个项目里有代码」的证据。 */
const DOC_EXT_RE = /\.(md|markdown|rst|txt|adoc|asciidoc|org)$/i

/**
 * README 及其语言变体：`README.md`、`README.en.md`、`README_CN.md`、`README.zh-CN.md`
 * 这几种写法都常见。**扩展名可以没有**：老项目、随发布附件分发的项目里
 * 光秃秃一个 `README` 是常见写法，不认它就会去补一份 `README.md`，与已有的那份并排成
 * 两份真相。
 *
 * **这一个正则同时管「收集文件」与「识别语言变体」**，不要再写第二个：两份规则表达
 * 同一件事时，先失效的永远是更窄的那个，而且失效得无声无息——收集用的那一份只认点
 * 分隔时，`README_CN.md` 连列表都进不去，语言识别写得再宽松也没用。
 */
const README_RE = /^readme(?:[._-][a-z]{2}(?:[._-][a-z]{2})?)?(?:\.(?:md|markdown|rst|txt|adoc))?$/i

/**
 * README 文件名判据（含语言变体）——**全仓只此一份**：preflight 的「顶层未登记条目」
 * 豁免也用它。同一条规则写两遍，漂移的那一处没人会在改动时想起。
 */
export const README_NAME_RE = README_RE

/** 本机私有路径（任一宿主平台习惯写法）的判据，供 preflight 引用，避免第二份手写正则。 */
export const HOME_PATH_RE = /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+|[\\/](?:home|Users)[\\/][^\\/\s"'`]+/

/** 从 README 文件名里取出语言标记；没有语言标记（默认语言）时返回 undefined。 */
function readmeLangOf(name) {
  const m = /^readme[._-]([a-z]{2}(?:[._-][a-z]{2})?)\./i.exec(name)
  return m === null ? undefined : m[1].toLowerCase()
}









/**
 * 读一个 Markdown 文件的二级标题列表，用于「现有文档有哪些节」这种机械报告。
 *
 * **跳过围栏代码块**：README 的示例里出现 `## 用法` 是正常写法，而按行首匹配会把它算成
 * 一个真实存在的节——报告于是多出一节，读的人照着它判断「README 已经写过这一节」。
 * 围栏判据只有一处实现（lib/markdown.mjs 的 `scanLines`），这里直接用它。
 */
function markdownH2(filePath) {
  const text = readText(filePath)
  if (text === undefined) return []
  const out = []
  for (const info of scanLines(text)) {
    if (info.inFence || info.heading === null) continue
    if (info.heading.level !== 2) continue
    out.push(info.line.trim())
  }
  return out
}

/**
 * 这个文件名是不是「默认语言」的 README（`README.md` 这类，没有语言后缀）。
 *
 * 判据写成「是 README 且没有语言标记」，而不是再抄一份文件名正则——扩展名清单只留在
 * `README_RE` 一处，改那一处就够。
 */
function isDefaultReadme(name) {
  return README_RE.test(name) && readmeLangOf(name) === undefined
}

/** 认了但不算「非文档内容」的杂项文件：每个项目都有，不构成形态证据。 */
const MISC_FILE_RE = /^(license|licence|copying|notice|authors|contributors|changelog|changes|history|todo|\.gitignore|\.gitattributes|\.gitmodules|\.editorconfig|\.npmignore|\.dockerignore)(\..*)?$/i

/**
 * 纯配置文件：文档项目里配一个 CI 工作流、一个格式化配置再正常不过，它们**不说明
 * 这个项目里有代码**。把它们算进「非文档内容」，一个纯文档目录会因此被判成
 * unrecognized，白白多问用户一次「这是什么项目」。
 *
 * 只收「不可能是项目自己的产物」的类型；`data.json` 这类拿不准的不收——宁可多问一次，
 * 也不能把一个认不出的代码项目说成纯文档目录。
 */
const CONFIG_FILE_RE = /\.(ya?ml|toml|ini|cfg|conf|properties|editorconfig)$|^\.(prettierrc|eslintrc|babelrc|browserslistrc|nvmrc|tool-versions|gitattributes|gitignore|dockerignore|npmignore|env)$/i

/**
 * 「会自己声明项目身份的清单」这一类扩展名：`json / toml / yaml / mod / csproj` 这些
 * 文件名几乎总在说「我是什么」。收得广一点是刻意的——**看不出来的东西留给读的人看**，
 * 而漏掉一个真正的清单会让整个项目少认一块（那份 `metadata.source` 也补不回来）。
 */
const MANIFEST_SHAPED_RE = /\.(json|toml|ya?ml|mod|gradle|csproj|fsproj|vbproj)$/i
/**
 * 排除项：工具配置不声明「这个项目是什么」，它们只是每个项目都有的设置。
 * 排的是**具体已知的文件名**，不是「凡是配置文件」——后者会把 `hedgehog.toml`
 * 这类没见过的清单一起排掉，而那正是这一项要抓的东西。
 */
const CONFIGISH_NAME_RE = /^(pnpm-workspace|turbo|nx|lerna|tsconfig|jsconfig|deno|biome|eslint|prettier|stylelint|babel|browserslist|jest|vitest|playwright|cypress|rollup|vite|webpack|esbuild|tsup|swc|next|nuxt|svelte|astro|tailwind|postcss|uni|bunfig|renovate|dependabot|settings|launch|tasks|extensions|keybindings|typings|global)\b|^\./i

/**
 * 这个文件名像不像一份**认不出来的项目清单**。
 *
 * 为什么要判：**没认出来的清单是重要事实**。漏掉它，新生态项目就会看起来和普通 JS
 * 项目一模一样（`src/extension.ts` 这样的扩展名会兜底判成 node），而报告里还会顺口
 * 说「无清单文件」——那句是假的，根目录明明有。于是 AI 永远收不到「这里有我不认识的
 * 东西」这个提示，也就不会去走「无专章的插件类怎么判」那条协议。判不出来就照实说
 * 「这里有个我不认识的清单」，这比默认它不存在诚实。
 */
export function looksLikeManifest(name) {
  const lower = String(name ?? '').toLowerCase()
  if (CONFIGISH_NAME_RE.test(lower)) return false
  return MANIFEST_SHAPED_RE.test(lower)
}

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
  // 强信号：这类构建描述文件指着某种语言，记下即定生态。认它之后不再往下走——
  // 它已经说明「这是代码项目」，不该同时被当成一条泛泛的「非文档内容」。
  const build = BUILD_FILE_KINDS.find(([f]) => f === lower)
  if (build !== undefined) {
    if (!scan.byBuildFile.has(build[1])) scan.byBuildFile.set(build[1], rel)
    return
  }
  // 弱信号：只说明「这里有个构建入口」，不说明是什么语言（理由见 BUILD_ENTRY_FILES）。
  // 记成事实供人复核，同样不构成「这个目录里有代码」的证据。
  if (BUILD_ENTRY_FILES.includes(lower)) {
    if (!scan.byBuildEntry.has(lower)) scan.byBuildEntry.set(lower, rel)
    return
  }
  // 子目录里的清单：monorepo 的主要线索。根目录的清单由 detectEcosystem 直接处理，
  // 走不到这里也不需要走。**根目录同样要在这里挡掉**——挡的是后面那条「认不出来的
  // 清单」：`package.json` / `Cargo.toml` 这些是**认识的**清单，把它们也报成
  // 「清单表里没有这一种」是一句错话，而错话比不报告坏得多。
  const manifest = MANIFEST_KINDS.find((m) => m.file === lower)
  if (manifest !== undefined) {
    if (depth > 0 && !scan.byNestedManifest.has(manifest.ecosystem)) {
      scan.byNestedManifest.set(manifest.ecosystem, rel)
    }
    return
  }
  for (const [re, kind] of SOURCE_EXT_KINDS) {
    if (re.test(name)) {
      if (!scan.byExtension.has(kind)) scan.byExtension.set(kind, rel)
      return
    }
  }
  if (DOC_EXT_RE.test(name) || MISC_FILE_RE.test(lower) || README_RE.test(name)) return
  // 不认识的清单（**只有根目录的才算**）：报出来，并让调用方知道「没认出来的清单在这儿」。
  // 子目录里不算——`packages/*/` 下每一层都可能有一份，报出来只会是噪音。
  if (looksLikeManifest(name)) {
    if (depth === 0 && !scan.unrecognizedManifests.includes(rel)) scan.unrecognizedManifests.push(rel)
    return
  }
  if (CONFIG_FILE_RE.test(name)) return
  if (scan.nonDocSamples.length < 5) scan.nonDocSamples.push(rel)
}


/**
 * 对文本文件做内容级扫描：凭据形状 + 本机私有路径。
 *
 * `shaped` 是「内容里出现过凭据形状的文件集合」，供敏感文件的第二级判定使用——只报出
 * 了形状和行号的 `secrets` 不足以回答「某个 `.npmrc` 到底算不算凭据」。
 */
function scanContents(root, candidates, realHomes) {
  const secrets = []
  const homePaths = []
  const shaped = new Set()
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
      shaped.add(rel)
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
  return { secrets, homePaths, shaped, stats }
}

/**
 * 列一次顶层目录，之后所有文件名判定都查这张表。
 *
 * 不逐个 existsSync 试探的理由：大小写不敏感的文件系统（Windows、macOS 默认）上，
 * 试探 README.md 与 readme.md 会双双命中同一个文件，于是报出并不存在的「重复」。
 * 以真实目录项为准，就没有这个问题，顺便也更快。
 *
 * **顺序一律按码位排**：`readdirSync` 的次序由文件系统决定（同 NTFS、APFS、ext4 三者
 * 各不相同），而这张表的插入顺序会一路传到 `kinds` 与报告里的先后——同一份输入在不同
 * 平台上给出不同顺序的报告，正是这个工具最不该有的性质。`localeCompare` 不用：它随
 * 系统语言变，等于把顺序换了一个主人。大小写敏感的系统上「只差大小写」的两个文件会
 * 折叠成一条，那是这个表的设计（见上），保留先出现的那条并记下来即可，不必另作处理。
 */
function listRoot(root) {
  const table = new Map()
  try {
    const entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
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

/**
 * 这个目录里有没有**属于该生态的**清单。
 *
 * 清单在不在还不够：表里带 `marker` 的那一项（Obsidian 的 `manifest.json`）要求清单正文
 * 里出现那个字段，否则不算——普通 PWA 也有同名文件。这个判据被生态判定、可发布清单、
 * 版本号、发布元数据共用：各判一次就已经漂移过一次，把 PWA 当成插件并告知它 id 形状
 * 不合规。
 */
function hasManifestOf(root, root_, ecosystem) {
  return MANIFEST_KINDS.some((m) => {
    if (m.ecosystem !== ecosystem) return false
    const real = root_.real(m.file)
    if (real === undefined) return false
    if (m.marker === undefined) return true
    return m.marker.test(readText(join(root, real)) ?? '')
  })
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

/**
 * 构建描述文件 → 生态。**只收确实指着某种语言的那些**：它们本身就是那种语言的构建入口，
 * 认出来是读到了声明，不是猜。
 */
const BUILD_FILE_KINDS = [
  ['cmakelists.txt', 'cpp'],
  ['meson.build', 'cpp'], ['configure.ac', 'cpp'],
  // SCons 的构建脚本本身是 Python（官方用户指南：「SConstruct Files Are Python
  // Scripts」），所以它指的是 Python，而不是「被它构建的那种语言」。
  ['sconstruct', 'python'],
]

/**
 * 构建入口文件，但**不据此定生态**。
 *
 * 判据是「这个文件只说明有人在这里构建，不说明是什么语言」。`Makefile` 在文档站里
 * 极其常见（`make html`、`make serve`），`Dockerfile` 是打包方式而不是语言。
 * 把它们映射到某个生态，代价是**不对称的**：能力矩阵里纯文档目录的发布列是「不做」，
 * 而任一代码生态是「视声明而定」——一个带 Makefile 的文档站因此被推去配发布链路，
 * 而它根本没有可分发制品。反过来，真实的 C/C++ 项目去掉这条路也认得出来：源码扩展名
 * 判据会把它兜住（`.c` / `.cpp` / `.h` 都在表里）。所以降级是安全的。
 *
 * 它们也不构成「这个目录里有代码」的证据——理由同上，一个文档站同样有 Makefile。
 * 只记成 `artifacts.buildEntryFiles` 这个事实，供读的人知道「该去读它自己确认」。
 */
const BUILD_ENTRY_FILES = ['makefile', 'dockerfile']

/**
 * 清单文件表——**全仓唯一一份**。生态判定、monorepo 识别、可发布清单、声明版本号、
 * 运行环境下限、逐生态发布元数据都从这张表派生。
 *
 * 各写一份时的漂移是**静默**的：少一行的后果是「读不到」，不是「报错」。所以一个生态
 * 要在这里补齐下列全部字段，新增生态的成本才是「加一行」而不是「改五处」：
 *
 *   - `file`   文件名（小写，比对时统一小写；文档一律用磁盘上的真实名）；
 *   - `ecosystem` 这份清单说明项目属于哪个生态；
 *   - `kind`    判定结果里用的名字。默认与 `ecosystem` 相同；两者不同的只有一种情况——
 *     某个生态同时是「插件类」的一种，判定结果要带 `-plugin` 后缀而生态名不带；
 *   - `publishable` 这份清单是否声明了「我是可对外分发的这个包」（发布链路的入口）。
 *   - `version` 声明版本号的字段。没写 = **不读**，不是「这个生态没有版本号」；
 *   - `requires` 声明运行环境下限的字段与对应运行时。没写 = 不读；
 *   - `marker` 该清单必须出现的内容特征。普通 PWA 也有 `manifest.json`，所以那一项要
 *     额外要求正文里出现插件才用的字段。
 *
 * **`version` 与 `requires` 里带 `table` 的，是 TOML 清单**：字段名只在那一张表下才算
 * 声明（切法见 `manifestSection`）。同一份 TOML 里 `version` 会出现在依赖表下，那是依赖
 * 的版本号，读成项目自己的就是一个假结论。JSON 清单没有表，不写这一列。
 *
 * 表里**每一项都是子目录线索**：根目录只有一个 README、真正的清单在 `packages/`
 * 下面很常见，只看根目录会落到 unrecognized。根目录的那一份由生态判定直接读，
 * 不必也不该走这条路径，所以「出现在子目录」这一层由走查的层级判断，不在表里再开
 * 一列——开一列就得有人逐行决定，而这里的答案对每一行都一样。
 *
 * JSON 清单里结构化的字段（`package.json` 的 `engines`）不走这里的正则：那是解析对象，
 * 不是文本搜索，写成同一张表反而会让人以为两者等价。
 */
const MANIFEST_KINDS = [
  { file: 'package.json', ecosystem: 'node', publishable: true,
    version: { re: /"version"\s*:\s*"([^"]+)"/, field: 'version' } },
  { file: 'pyproject.toml', ecosystem: 'python', publishable: true,
    version: { re: /^\s*version\s*=\s*["']([^"']+)["']/m, field: 'version', table: '[project]' },
    requires: { re: /^\s*requires-python\s*=\s*["']([^"']+)["']/m, field: 'requires-python', runtime: 'python', table: '[project]' } },
  { file: 'setup.py', ecosystem: 'python', publishable: true },
  { file: 'setup.cfg', ecosystem: 'python', publishable: true },
  { file: 'requirements.txt', ecosystem: 'python' },
  { file: 'pipfile', ecosystem: 'python' },
  { file: 'cargo.toml', ecosystem: 'rust', publishable: true,
    version: { re: /^\s*version\s*=\s*["']([^"']+)["']/m, field: 'version', table: '[package]' },
    requires: { re: /^\s*rust-version\s*=\s*["']([^"']+)["']/m, field: 'rust-version', runtime: 'rust', table: '[package]' } },
  { file: 'go.mod', ecosystem: 'go', publishable: true,
    // Go 的版本不在清单里（靠标签声明），所以只读 `go` 指令给出的语言下限。
    requires: { re: /^go\s+(\S+)/m, field: 'go 指令', runtime: 'go' } },
  { file: 'pom.xml', ecosystem: 'java', publishable: true },
  { file: 'build.gradle', ecosystem: 'java', publishable: true },
  { file: 'build.gradle.kts', ecosystem: 'java', publishable: true },
  { file: 'gemfile', ecosystem: 'ruby', publishable: true },
  { file: 'composer.json', ecosystem: 'php', publishable: true,
    version: { re: /"version"\s*:\s*"([^"]+)"/, field: 'version' } },
  { file: 'pubspec.yaml', ecosystem: 'dart', publishable: true },
  { file: 'mix.exs', ecosystem: 'elixir', publishable: true },
  { file: 'project.clj', ecosystem: 'clojure' },
  { file: 'package.swift', ecosystem: 'swift', publishable: true },
  { file: 'cpanfile', ecosystem: 'perl' },
  { file: 'manifest.json', ecosystem: 'obsidian', kind: 'obsidian-plugin', publishable: true,
    version: { re: /"version"\s*:\s*"([^"]+)"/, field: 'version' },
    requires: { re: /"minAppVersion"\s*:\s*"([^"]+)"/, field: 'minAppVersion', runtime: 'obsidian' },
    // 同名文件是 PWA 的，不算插件——判据是下面那个字段，不是文件在不在。
    marker: /minAppVersion/ },
]

/**
 * 清单表里某一项的正文：TOML 先切出它声明的那张表，其余格式原样返回。
 *
 * 为什么必须切表：TOML 清单里 `version = "..."` 出现在好几张表下，而 `[dependencies]` 里
 * 那些是**依赖的**版本号。用一条行首锚点的正则扫全文，会把依赖的版本读成项目自己的版本，
 * 于是报告里出现一个项目从没声明过的版本，发布判据据此报「标签与版本号未对齐」——
 * 现象是一条看起来很有据的假结论。实测两种写法都会中：Cargo 的
 * `version.workspace = true` 配 `[dependencies.anyhow] version = "1.0.0"`、
 * 以及 pyproject 的 `dynamic = ["version"]` 配 `[tool.poetry.group.dev.dependencies]`。
 *
 * 切法就是文本级的：从表头行到下一个表头行。不解析 TOML——这里要的是「这段文字里有没有
 * 那个字段」，而表头本身是逐字可认的。取不到那张表时返回空串：**读不到就是没声明**，
 * 不该退回全文再扫一遍（那正是上面那个错误结论的来源）。
 */
function manifestSection(text, table) {
  if (table === undefined) return text
  const lines = String(text ?? '').split('\n')
  const head = table.toLowerCase()
  const out = []
  let inside = false
  for (const line of lines) {
    const m = /^\s*\[+([^\]]+)\]/.exec(line)
    if (m !== null) {
      inside = `[${m[1].trim().toLowerCase()}]` === head
      continue
    }
    if (inside) out.push(line)
  }
  return out.join('\n')
}

/** 判定结果里用的名字：表里没单独声明 `kind` 时就是生态名。 */
function manifestKind(m) {
  return m.kind ?? m.ecosystem
}

/**
 * 清单读不出来时的说明。**两种原因要分开说**：内容读出来了但不是合法 JSON，
 * 与内容压根没读出来（不是合法 UTF-8/UTF-16）。
 *
 * 合成一句话的代价是具体的：说成「JSON 语法错误」，使用者就去改 JSON——而一个
 * UTF-16 的 package.json 语法完全正确，改 JSON 改不动它，得转存编码。
 */
function corruptReasonText(reason) {
  if (reason === 'encoding') return '清单读不出来：不是合法的 UTF-8/UTF-16（多半是本地编码），请先转存为 UTF-8'
  if (reason === 'shape') return '清单损坏：内容不是 JSON 对象'
  return '清单损坏，JSON 语法错误'
}

function detectEcosystem(root, root_, walked) {
  const evidence = []
  const kinds = []
  const pkg = readJson(join(root, root_.real('package.json') ?? 'package.json'))
  const cordisPatch = root_.first(['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml'])
  const skillFile = root_.first(SKILL_ENTRY_NAMES)
  const skillText = skillFile === undefined ? undefined : readText(join(root, skillFile))
  const skill = skillFrontmatter(skillText)

  if (pkg !== undefined) {
    if (pkg.__corrupt === true) {
      evidence.push(`${root_.real('package.json')}（${corruptReasonText(pkg.__reason)}）`)
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
  // 清单表：先判 `package.json`（它还要看清单内部的字段），其余按表扫。
  // 表里带 `marker` 的那一项（Obsidian 的 manifest.json）要求清单正文里出现那个字段，
  // 否则不算命中——普通 PWA 也有同名文件。
  for (const m of MANIFEST_KINDS) {
    if (m.ecosystem === 'node') continue
    const real = root_.real(m.file)
    if (real === undefined) continue
    if (m.marker !== undefined && !m.marker.test(readText(join(root, real)) ?? '')) continue
    evidence.push(real)
    kinds.push(manifestKind(m))
  }
  // skill 入口与 JS 清单互不依赖：两个都在时上面已经各推过一次，这里补齐「有清单
  // 但没有 skill 分支」的那一种。
  if (skill !== undefined && !kinds.includes('skill')) {
    evidence.push(`SKILL.md（name: ${skill.name}）`)
    kinds.push('skill')
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
  // **子目录里的清单与其它两类不是一回事，所以分开**：
  //   - 清单是**强证据**（与根目录那份同一个量级：它本来就声明了「这里有一个这种生态的
  //     项目」），monorepo 里根目录有 package.json、`backend/` 下还有 pyproject.toml 是
  //     常态。**这道判断不能被「根目录什么都没认出来」这个前提挡住**：挡住它，「一个仓库
  //     里有多种生态时逐项分别处理」那句话在真正的 monorepo 上就不成立，子目录那一半
  //     会整体消失。
  //   - 构建描述文件与源码扩展名是**弱证据**：一旦已经认出这是 skill、插件或某种清单型
  //     项目，再凭「目录里有个 .py 文件」追加一个生态只会制造误判（例如把技能自带的
  //     scripts/ 当成一个 Node 项目）。所以这两类仍然只在什么都没认出来时才用。
  const scan = walked?.sourceScan
  if (scan !== undefined) {
    for (const [kind, sample] of scan.byNestedManifest) {
      if (kinds.includes(kind)) continue
      evidence.push(`${sample}（子目录里的清单，根目录没有）`)
      kinds.push(kind)
    }
    if (kinds.length === 0) {
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

  // 根目录里「像清单但清单表不认识」的那些文件：**无论如何都报出来**。
  //
  // 它是这一份报告里唯一能指向「这是个新生态」的事实。不报的后果是：一个带
  // `hedgehog.toml` 的新生态项目会被当成普通 JS 项目（`src/extension.ts` 让扩展名兜底
  // 判成 node），AI 再也收不到「这里有我不认识的东西」，也就不会去走「无专章的插件类
  // 怎么判」那条协议。同理，别处也不能顺口说「无清单文件」：只要根目录有清单形状的
  // 文件，那句话就是假的。
  const unknownManifests = scan?.unrecognizedManifests ?? []
  if (unknownManifests.length > 0) {
    evidence.push(`根目录有清单形状的文件但清单表里没有这一种：${unknownManifests.slice(0, 3).join('、')}`
      + '（新生态的线索；在把它归成已知生态之前，先确认这是什么项目）')
  }

  // 仍然什么都没认出来，才按目录性质区分。
  const unique = [...new Set(kinds)]
  if (unique.length === 0) {
    // 「有没有 README」用 README_RE 判，与 detectDocs 同一个来源。另写一份最窄的名字
    // 清单会判出两个答案：只有 `README_CN.md` 的文档目录被判成 unknown，而同一份
    // 报告的 docs.readme 又正确列出了它。
    const readmes = root_.filesIn('', README_RE)
    // 判据是「除文档外还有没有别的东西」。**只看源码与构建描述文件**，不要把
    // LICENSE、.gitignore、CI 配置这类每个项目都有的文件算成「别的东西」——那会把
    // 正常的纯文档目录误报成 unrecognized，反过来触发一次无谓的追问。
    const nonDoc = scan?.nonDocSamples ?? []
    if (unknownManifests.length > 0) unique.push('unrecognized')
    else if (readmes.length > 0 && nonDoc.length === 0) {
      unique.push('docs-only')
      // 措辞按**事实**给：这一格只说明「除文档之外没别的东西」。文档是 Markdown 还是
      // 光秃秃一份纯文本 README，判据没有看内容，就不下那个结论。
      evidence.push('仅见文档类文件')
    } else if (nonDoc.length > 0) {
      unique.push('unrecognized')
      evidence.push(`未识别出项目形态（非文档文件示例：${nonDoc.slice(0, 3).join('、')}）`)
    } else unique.push('unknown')
  }
  return { kinds: unique, evidence, manifest: pkg, skill }
}

/**
 * 清单表里标了 `publishable` 的那些：声明了「我是可对外分发的这个包」，也就是
 * 发布链路的入口。
 *
 * 判据不能只认 `package.json`——那会让**任何非 JS 项目一律被判成不可发布**，生成的
 * 契约里整块丢掉版本号语义、抬版本号判据、发版规则、角色判定，而能力矩阵明写
 * 「python / rust / go：发布视声明而定」。读这张表就不会把「我没解析那种清单」误当成
 * 「它不能发布」。带 `marker` 的那一项还要求清单正文里出现那个字段。
 */
const PUBLISHABLE_MANIFESTS = MANIFEST_KINDS.filter((m) => m.publishable)

/** 一条命令的键。正向清单——用「是哪些」而不是「不是哪些」，新增键不会被误当成命令。 */
// 命令键是跨脚本协议：定义在 lib/protocol.mjs，本文件只引入。

/**
 * 能搬进扁平视图的键。`packageManager` 在列：它是命令的前缀（`pnpm install` 而不是
 * `npm install`），单独看不是命令，但调用方需要知道项目指定了哪个。
 */
const FLAT_KEYS = new Set([...COMMAND_KEYS, 'packageManager'])

/**
 * 描述「某条命令从哪来」的键（`note` / 以 `Note` 结尾）：不是命令本身。
 *
 * 导出给 compose-agents 用——同一份判据写在两处时，新增一种 `xxxNote` 只会在其中一处
 * 生效，而现象是「命令段整块消失」或「多出一条根本不是命令的项」，两边都不会报错。
 */
export function isNoteKey(key) {
  return key === 'note' || key.endsWith('Note')
}

/**
 * 从清单文件推导「怎么构建/测试/校验」。取不到就留空，不编造。
 *
 * 返回值里既有扁平字段（`build`、`test` 一类，取「最可信的那个」），也有
 * `byEcosystem`（按生态分开）。两者都给是因为用途不同：
 *   - 只想跑一条命令时用扁平字段，方便；
 *   - 要把它**写进文档**时必须用 byEcosystem——多生态项目里扁平字段会让后算的生态
 *     覆盖先算的：node + python 的项目里，项目自己的 `vitest run` 会被
 *     `python -m pytest` 顶掉，而这条错误命令会被原样渲染进 AGENTS.md。
 *     覆盖是静默的，所以调用方必须能看出「这个值属于哪个生态」。
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

    // 清单里声明了 scripts，但一条常规脚本名都没命中（`forge`、`smelt`、`release:prod` 这类
    // 自定义名字很常见）。此时**必须说清「为什么推不出来」并给出原始脚本名**：
    // 只说「未推导出任何命令」，读的人会以为这个项目没有可跑的命令，而项目其实声明了一堆
    // ——P7 那道验证门就这样落空了。名字一并带出来，AI 才能自己挑出该跑哪条。
    const declared = Object.keys(pkg.scripts).filter((k) => typeof pkg.scripts[k] === 'string')
    const matched = ['build', 'test', 'typecheck', 'lint', 'verify', 'smoke'].some((k) => k in node)

    // 装依赖的命令（`scripts.install` 是项目自定义的安装钩子，不是「怎么装依赖」，
    // 所以它不进上面那张别名表）。**只在真的推出一条验证命令时，才把它带上**：
    // `install` 单独出现会灌满扁平视图，「未推导出任何命令」这条诚实信号（P7 汇报
    // 「这个项目一行都没验证过」的依据）就再也不出现了，而装依赖撑不起验证门。
    if (matched) node.install = `${pm} install`
    else {
      node.note = declared.length > 0
        ? '清单里声明了这些脚本，但没有一条是常规名字（build / test / lint 一类），'
          + `所以没有推导出命令：${declared.slice(0, 8).join('、')}${declared.length > 8 ? ' 等' : ''}`
          + '——请读清单确认哪一条是本项目的构建或验证命令'
        : '清单里的 scripts 是空的，没有可推导的命令'
    }
    byEcosystem.node = node
  } else if (eco.kinds.includes('node')) {
    // 有 node 生态但没有 scripts 字段：只说一句，**不给 `install`**——理由同上。
    byEcosystem.node = { note: '清单里没有 scripts 字段，命令要读项目自己的说明' }
  }

  if (eco.kinds.includes('python')) {
    const python = {}
    const pyName = root_.real('pyproject.toml')
    const py = pyName === undefined ? '' : (readText(join(root, pyName)) ?? '')
    // **声明**优先：只有项目自己声明了测试框架，才给出对应的测试命令。
    //
    // **只给项目自己声明过的测试框架**。按生态惯例推断出来的命令（看到 `tests/`
    // 就给 pytest）会同时造成两件事：给出一个这个项目根本跑不通的「硬门禁」，以及
    // 让 P7 的「没有门禁命令」分支永不触发——脚本总能推出一条假命令，那条诚实信号
    // 就没有机会出现。
    const declaresPytest = /\[tool\.pytest/.test(py) || root_.has('pytest.ini') || root_.has('tox.ini')
    const declaresUnittest = /\[tool\.unittest/.test(py)
      || (/unittest/.test(readText(join(root, 'setup.cfg')) ?? '') && root_.has('setup.cfg'))
    // 推断出来的命令一律带出处说明：否则它看起来和项目声明的命令一样可靠。
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

  // java/dotnet/ruby/php 等：生态认得出来，但**本段不按生态惯例编命令**——
  // 它们的构建命令写在各自的入口文件里（gradle / maven / .NET / CMake），
  // 由下面那段按任务入口推导负责。这里只在**确实没推出命令**时才说一声，
  // 否则会与下面那段打架：同一个项目既「已推导出 gradle build」又「尚未实现」。
  // 本节跑在任务入口推导之前，所以这里只记下待补的生态，最后再统一判定。

  // ── 通用任务入口 ──
  //
  // 上面那些分支按**生态**推导；这一段按**任务入口**推导，两者正交：一个 Python 项目
  // 可以用 Makefile 组织测试，一个 C++ 项目可能只有 CMakeLists。只看生态会漏掉
  // 整类项目——它们的构建命令写在入口文件里，而不在生态惯例里。
  //
  // 判据一律是「这个文件真的存在」，并且**只从文件内容里读，不按惯例编**：
  // 读不到就说读不到，不给一条跑不通的假命令。
  const runner = taskRunnerCommands(root, root_)
  if (runner !== undefined) {
    byEcosystem.runner = runner
  }

  // 统一判定「哪些生态认得出来、却一条命令都没推出来」。
  // 判据落在**整个项目有没有命令**上，而不是某个生态桶：CMake 项目的命令出自
  // 任务入口那一段，生态桶里本来就是空的，那时再说「尚未实现」就是假话。
  const anyCommand = Object.values(byEcosystem).some((bucket) => [...COMMAND_KEYS]
    .some((k) => typeof bucket[k] === 'string'))
  if (!anyCommand) {
    for (const kind of eco.kinds) {
      if (['java', 'dotnet', 'ruby', 'php', 'cpp', 'dart', 'swift'].includes(kind) && byEcosystem[kind] === undefined) {
        byEcosystem[kind] = { note: '该生态的命令推导尚未实现，请读构建配置确认' }
      }
    }
  }

  // 扁平视图：按「声明强度」排序取先到者。
  // 有清单的生态排在前面——它的命令是项目自己声明的，比按惯例推断的可信。
  //
  // **只搬命令键与说明键**。搬全部键会让 `{ note: '该生态的命令推导尚未实现' }` 变成
  // 扁平视图里的一条 `note`，而消费方按「有没有字符串键」判断「本项目有没有命令」——
  // 那种项目于是永远拿不到「未推导出任何命令」这个信号（它正是 P7 要求如实汇报
  // 「没有验证过」的依据）。
  const order = ['node', 'python', 'rust', 'go']
  const keys = [...order.filter((k) => k in byEcosystem),
    ...Object.keys(byEcosystem).filter((k) => !order.includes(k))]
  for (const kind of keys) {
    for (const [k, v] of Object.entries(byEcosystem[kind])) {
      if (FLAT_KEYS.has(k) || isNoteKey(k)) {
        if (!(k in out)) out[k] = v
      }
    }
  }
  // 「多生态」只在**真的有多套命令**时才算。
  //
  // 判据是「有几个生态产出了命令」，不是「命中几个生态标签」：`dsh-plugin` 是 node 的
  // 一种**细化**（它就是一个 node 项目），`skill` 是描述，它们不会带来第二套命令。
  // 把它们算进去，一个只有一套命令的插件项目会收到「每类命令只保留了一个」的警告，
  // 收到这种警告的 AI 会去找并不存在的第二套命令。
  const commandKinds = Object.keys(byEcosystem)
  if (commandKinds.length > 1) {
    out.byEcosystem = byEcosystem
    out.multipleEcosystems = keys.filter((k) => k in byEcosystem)
  }
  return out
}

/**
 * workspace 拓扑：这个仓库是不是多包仓库，包在哪里。
 *
 * 判据一律来自**项目自己的声明**（`pnpm-workspace.yaml`、`package.json#workspaces`、
 * `Cargo.toml` 的 `[workspace]`、`go.work` 的 `use`），不从目录形状猜——`packages/`
 * 里恰好有三个目录不代表它是 monorepo，而**没有声明就不是**。
 *
 * 为什么要这个事实：根目录没有清单时，命令推导会空手而归，而真正的构建命令在子包里；
 * 产物检测只看根目录，会漏掉 `packages/core/dist`。上层据此把「该在哪一层跑」写进契约。
 */
function detectWorkspace(root, root_) {
  const out = { declared: false, tools: [], patterns: [], packages: [], note: undefined }

  const readRoot = (name) => {
    const real = root_.real(name)
    if (real === undefined) return undefined
    try {
      return readFileSync(join(root, real), 'utf8')
    } catch {
      return undefined
    }
  }

  /** 把 `packages/*` 这类通配展开成真实子目录名（只展开一级，不递归）。 */
  const expand = (pattern) => {
    const clean = pattern.replace(/\/+$/, '').replace(/^\.\//, '')
    // 非通配：可能是嵌套路径（crates/a），而 root_ 只认顶层条目，所以直接问文件系统。
    if (!clean.includes('*')) {
      try {
        return statSync(join(root, clean)).isDirectory() ? [clean] : []
      } catch {
        return []
      }
    }
    const idx = clean.indexOf('*')
    const head = clean.slice(0, idx).replace(/\/+$/, '')
    const tail = clean.slice(idx + 1).replace(/^\/+/, '')
    const e = root_.entry(head)
    if (e === undefined || !e.isDir) return []
    let names
    try {
      names = readdirSync(join(root, root_.real(head) ?? head), { withFileTypes: true, encoding: 'utf8' })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
        .map((d) => d.name)
    } catch {
      return []
    }
    const out2 = []
    for (const n of names) {
      const rel = `${head}/${n}`
      if (tail === '') out2.push(rel)
      else if (root_.entry(`${rel}/${tail}`)?.isDir === true) out2.push(`${rel}/${tail}`)
    }
    return out2
  }

  const addPatterns = (tool, patterns) => {
    if (!out.tools.includes(tool)) out.tools.push(tool)
    for (const p of patterns) {
      if (!out.patterns.includes(p)) out.patterns.push(p)
      for (const pkg of expand(p)) {
        if (!out.packages.includes(pkg)) out.packages.push(pkg)
      }
    }
  }

  // pnpm-workspace.yaml：`packages:` 下的 `- 'xxx'` 列表。
  const pnpm = readRoot('pnpm-workspace.yaml')
  if (pnpm !== undefined) {
    const patterns = []
    let inPackages = false
    for (const line of pnpm.split(/\r?\n/)) {
      if (/^packages\s*:/.test(line)) { inPackages = true; continue }
      if (inPackages) {
        if (/^\S/.test(line) && !/^\s*-/.test(line)) { inPackages = false; continue }
        const m = /^\s*-\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/.exec(line)
        if (m !== null) patterns.push(m[1].trim())
      }
    }
    addPatterns('pnpm', patterns)
  }

  // package.json#workspaces：数组，或 `{ packages: [...] }`。
  const pkgText = readRoot('package.json')
  if (pkgText !== undefined) {
    try {
      const pkg = JSON.parse(pkgText)
      const ws = pkg?.workspaces
      const patterns = Array.isArray(ws) ? ws.filter((x) => typeof x === 'string')
        : (Array.isArray(ws?.packages) ? ws.packages.filter((x) => typeof x === 'string') : [])
      if (patterns.length > 0) addPatterns('npm', patterns)
    } catch { /* JSON 坏了由别处报，这里不重复 */ }
  }

  // Cargo.toml 的 [workspace] members。
  const cargo = readRoot('cargo.toml')
  if (cargo !== undefined) {
    const head = /\[workspace\]/.exec(cargo)
    if (head !== null) {
      const after = cargo.slice(head.index + head[0].length)
      const stop = after.search(/^\[/)
      const body = stop < 0 ? after : after.slice(0, stop)
      const patterns = []
      // members = ["a", "b"] 或跨行的 members = [\n  "a",\n]
      const arr = /members\s*=\s*\[([\s\S]*?)\]/.exec(body)
      if (arr !== null) {
        for (const m of arr[1].matchAll(/["']([^"']+)["']/g)) patterns.push(m[1])
      }
      addPatterns('cargo', patterns)
    }
  }

  // go.work 的 use 指令。
  const gowork = readRoot('go.work')
  if (gowork !== undefined) {
    const dirs = []
    for (const line of gowork.split(/\r?\n/)) {
      const m = /^\s*use\s+(?:\(\s*)?([^\s()]+)?/.exec(line)
      if (m !== null && m[1] !== undefined) dirs.push(m[1].replace(/^\.\//, '').replace(/\/+$/, ''))
    }
    // use ( ... ) 块：逐行读块内的路径
    const block = /use\s*\(([\s\S]*?)\)/.exec(gowork)
    if (block !== null) {
      for (const line of block[1].split(/\r?\n/)) {
        const t = line.trim().replace(/^\.\//, '').replace(/\/+$/, '')
        if (t !== '' && !t.startsWith('//')) dirs.push(t)
      }
    }
    addPatterns('go', dirs)
  }

  out.declared = out.tools.length > 0
  if (!out.declared) {
    out.note = undefined
    return out
  }
  if (out.packages.length === 0) {
    out.note = '声明了 workspace，但没有展开出任何真实子目录——'
      + '通配可能没匹配上，或包目录还没建。请打开声明文件确认。'
  }
  return out
}

/**
 * 从**任务入口文件**推导命令。与按生态推导正交，两者都要跑。
 *
 * 为什么单独一段：一个 Python 项目可以用 Makefile 组织测试，一个 C++ 项目可能只有
 * CMakeLists.txt，一个 polyglot 仓库常常只靠 justfile 串起来。只看生态会漏掉整类
 * 项目——它们的构建命令写在入口文件里，不在生态惯例里。
 *
 * 两条纪律：
 *   - **只读文件里真实存在的目标**。Makefile 里没有 test 目标就报没有，不按惯例编一个
 *     make test——那会造出一条跑不通的「硬门禁」，而 P7 的「没有验证过」这个诚实信号
 *     再也出现不了。
 *   - **读不懂就说读不懂**。JSON 解析不了、文件读不出来时给一条 note 说明原因，
 *     而不是静默返回空——空的意思是「这个项目没有入口」，那是另一回事。
 */
function taskRunnerCommands(root, root_) {
  const build = {}
  const byTool = {}
  let sawAny = false

  const readIf = (name) => {
    const real = root_.real(name)
    if (real === undefined) return undefined
    try {
      return readFileSync(join(root, real), 'utf8')
    } catch {
      return undefined
    }
  }

  /** 从一组目标名里挑出常规命令键；一条都没有时给 note 并带上真实目标名。 */
  const pickTargets = (names, make, label, file) => {
    const got = {}
    for (const [key, aliases] of [
      ['build', ['build', 'all']], ['test', ['test', 'check']],
      ['lint', ['lint']], ['verify', ['verify']], ['install', ['install']],
    ]) {
      const hit = aliases.find((a) => names.has(a))
      if (hit !== undefined) got[key] = make(hit)
    }
    if (Object.keys(got).length > 0) return got
    const shown = [...names].filter((t) => !t.startsWith('.')).slice(0, 8)
    return {
      note: `有 ${file}，但没有 build / test 一类目标：`
        + `已定义的是 ${shown.length > 0 ? shown.join('、') : '（空）'}——请读它确认该跑哪一条`,
    }
  }

  /** Makefile：从目标名推导。 */
  const makefile = root_.first(['Makefile', 'makefile', 'GNUmakefile'])
  if (makefile !== undefined) {
    const text = readIf(makefile)
    if (text === undefined) {
      byTool.make = { note: `有 ${makefile} 但读不出来，命令要打开它确认` }
    } else {
      const targets = new Set()
      for (const line of text.split(/\r?\n/)) {
        if (/^\s/.test(line)) continue
        const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line)
        if (m !== null) targets.add(m[1])
      }
      byTool.make = pickTargets(targets, (t) => `make ${t}`, 'make', makefile)
      if (byTool.make.note === undefined) sawAny = true
    }
  }

  /** justfile：recipe 名在行首，可带参数与依赖。 */
  const justfile = root_.first(['justfile', 'Justfile', '.justfile'])
  if (justfile !== undefined) {
    const text = readIf(justfile)
    if (text === undefined) {
      byTool.just = { note: `有 ${justfile} 但读不出来，命令要打开它确认` }
    } else {
      const recipes = new Set()
      for (const line of text.split(/\r?\n/)) {
        if (/^\s/.test(line) || line.startsWith('#')) continue
        const m = /^@?([A-Za-z0-9_-]+)(?:\s+[^:]*)?\s*:/.exec(line)
        if (m !== null) recipes.add(m[1])
      }
      byTool.just = pickTargets(recipes, (t) => `just ${t}`, 'just', justfile)
      if (byTool.just.note === undefined) sawAny = true
    }
  }

  /** Taskfile：只认 tasks: 之下、比 tasks 行多缩进一级的键。 */
  const taskfile = root_.first(['Taskfile.yml', 'Taskfile.yaml', 'taskfile.yml', 'taskfile.yaml'])
  if (taskfile !== undefined) {
    const text = readIf(taskfile)
    if (text === undefined) {
      byTool.task = { note: `有 ${taskfile} 但读不出来，命令要打开它确认` }
    } else {
      const tasks = new Set()
      let inTasks = false
      let taskIndent = -1
      for (const line of text.split(/\r?\n/)) {
        if (/^\s*(?:#|$)/.test(line)) continue
        const indent = line.length - line.trimStart().length
        if (/^\s*tasks\s*:/.test(line)) { inTasks = true; taskIndent = -1; continue }
        if (!inTasks) continue
        if (indent === 0) { inTasks = false; continue }
        if (taskIndent < 0) taskIndent = indent
        if (indent !== taskIndent) continue
        const m = /^\s+([A-Za-z0-9_:.-]+)\s*:/.exec(line)
        if (m !== null) tasks.add(m[1])
      }
      byTool.task = pickTargets(tasks, (t) => `task ${t}`, 'task', taskfile)
      if (byTool.task.note === undefined) sawAny = true
    }
  }

  /** deno.json：tasks 是 JSON 对象；jsonc 去注释与尾逗号后再解析。 */
  const denoName = root_.first(['deno.json', 'deno.jsonc'])
  if (denoName !== undefined) {
    const text = readIf(denoName)
    if (text === undefined) {
      byTool.deno = { note: `有 ${denoName} 但读不出来，命令要打开它确认` }
    } else {
      let tasks
      let parsed = true
      try {
        const stripped = text.replace(/^\s*\/\/.*$/gm, '').replace(/,([\s}\]])/g, '$1')
        tasks = JSON.parse(stripped)?.tasks
      } catch {
        parsed = false
      }
      if (!parsed) {
        byTool.deno = { note: `${denoName} 解析不了（不是合法 JSON），命令要打开它确认` }
      } else if (tasks !== undefined && typeof tasks === 'object' && tasks !== null) {
        const names = new Set(Object.keys(tasks).filter((k) => typeof tasks[k] === 'string'))
        byTool.deno = pickTargets(names, (t) => `deno task ${t}`, 'deno', denoName)
        if (byTool.deno.note === undefined) sawAny = true
      } else {
        byTool.deno = { note: `${denoName} 里没有 tasks 字段` }
      }
    }
  }

  /** Gradle：有包装器就用包装器，没有就用 PATH 里的 gradle。 */
  const gradlew = root_.first(['gradlew', 'gradlew.bat'])
  const gradleBuild = root_.first(['build.gradle', 'build.gradle.kts'])
  if (gradlew !== undefined || gradleBuild !== undefined) {
    const prefix = gradlew === undefined ? 'gradle' : (gradlew.endsWith('.bat') ? '.\\gradlew.bat' : './gradlew')
    byTool.gradle = { build: `${prefix} build`, test: `${prefix} test` }
    sawAny = true
  }

  /** Maven：同上。 */
  const mvnw = root_.first(['mvnw', 'mvnw.cmd'])
  const pom = root_.first(['pom.xml'])
  if (mvnw !== undefined || pom !== undefined) {
    const prefix = mvnw === undefined ? 'mvn' : (mvnw.endsWith('.cmd') ? '.\\mvnw.cmd' : './mvnw')
    byTool.maven = { build: `${prefix} -B package`, test: `${prefix} -B test` }
    sawAny = true
  }

  /** .NET：解决方案或单个项目文件，dotnet test 对两者都成立。 */
  const dotnetProj = root_.filesIn('', /\.(sln|csproj|fsproj|vbproj)$/i)
  if (dotnetProj.length > 0) {
    byTool.dotnet = { build: 'dotnet build', test: 'dotnet test' }
    sawAny = true
  }

  /** CMake：配置与构建两步；测试只在开了 CTest 惯例时给。 */
  const cmakeLists = root_.first(['CMakeLists.txt'])
  if (cmakeLists !== undefined) {
    const text = readIf(cmakeLists) ?? ''
    const got = { install: 'cmake -S . -B build', build: 'cmake --build build' }
    if (/enable_testing\s*\(|include\s*\(\s*CTest/i.test(text)) got.test = 'ctest --test-dir build'
    byTool.cmake = got
    sawAny = true
  }

  /** Go workspace：命令要覆盖全部模块，而不是只覆盖根目录那一个。 */
  if (root_.has('go.work')) {
    byTool.goWorkspace = { build: 'go build ./...', test: 'go test ./...' }
    sawAny = true
  }

  if (!sawAny && Object.keys(byTool).length === 0) return undefined

  // 各工具的命令并进一张扁平表：真冲突时先到者为准，byTool 让人看得到每条出自哪个文件。
  for (const got of Object.values(byTool)) {
    for (const [k, v] of Object.entries(got)) {
      if (k !== 'note' && typeof v === 'string' && !(k in build)) build[k] = v
    }
  }
  if (Object.keys(build).length > 0) {
    build.byTool = byTool
  } else {
    build.note = `有任务入口文件（${Object.keys(byTool).join('、')}），但没有推导出命令——请读它们确认`
  }
  return build
}

/**
 * 发布相关的既成事实：决定「产物入不入库」和「发布范围」。
 *
 * 其中 `publishableManifest` 是**这个项目可发布身份的唯一来源**。判据不能只认 JS 的
 * `package.json`——那会让**任何非 JS 项目一律被判成不可发布**，生成的契约里整块丢掉
 * 版本号语义、抬版本号判据、发版规则、角色判定
 * ——而 SKILL.md 的能力矩阵明写「python / rust / go：发布视声明而定」。
 * 读这张表就不会把「我没解析那种清单」误当成「它不能发布」。
 *
 * `runtimeRequirements` 是**项目自己声明的运行环境下限**。它值得单独读出来，因为文档
 * 套装要求「环境要求那一节必须写具体版本号、不许编造」——而项目自己声明的那个数字就是
 * 唯一权威来源。读不到就是**没有声明**，此时宁可不写那一节，也不要编一个数字。
 */
function detectArtifacts(root, root_, eco, walked) {
  const facts = {
    publishScope: undefined, hooks: [], hasNpmIgnore: false, distDirsPresent: [],
    runtimeRequirements: [], publishableManifest: undefined, declaredVersion: undefined,
  }

  // 声明版本号与运行下限：都从清单表派生。标签命名与「抬版本号」判据的唯一权威来源
  // 是项目自己声明的那个数字——读不到就是**没有声明**，此时不能编一个（那会造出一个
  // 没人维护、却看起来权威的数字）。标签一律用磁盘上的真实文件名，不写死大小写。
  for (const m of MANIFEST_KINDS) {
    if (m.version === undefined && m.requires === undefined) continue
    const real = root_.real(m.file)
    if (real === undefined) continue
    const raw = readText(join(root, real)) ?? ''
    if (m.marker !== undefined && !m.marker.test(raw)) continue
    // 每个字段各切一次它声明的那张表（JSON 清单没有表，原样返回）。
    if (m.version !== undefined && facts.declaredVersion === undefined) {
      const hit = m.version.re.exec(manifestSection(raw, m.version.table))
      if (hit !== null) {
        facts.declaredVersion = hit[1]
        facts.declaredVersionIn = `${real} 的 ${m.version.field}`
      }
    }
    if (m.requires !== undefined) {
      const hit = m.requires.re.exec(manifestSection(raw, m.requires.table))
      if (hit !== null) {
        facts.runtimeRequirements.push({
          declaredIn: `${real} 的 ${m.requires.field}`, runtime: m.requires.runtime, range: hit[1],
        })
      }
    }
  }
  // Go 的版本不在清单里（靠标签声明），所以表里只给它 `go` 指令那一项。

  // 可发布清单：按知名度顺序取第一个存在的。它不一定与「主生态」相同（一个 Python 项目
  // 也可能因为某个原因带 package.json），所以单独判定，不从 kinds 推。
  for (const m of PUBLISHABLE_MANIFESTS) {
    const real = root_.real(m.file)
    if (real === undefined) continue
    if (m.marker !== undefined && !m.marker.test(readText(join(root, real)) ?? '')) continue
    facts.publishableManifest = { file: real, ecosystem: m.ecosystem }
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
          declaredIn: `${root_.real('package.json') ?? 'package.json'} 的 engines`,
          runtime, range: String(range),
        })
      }
    }
  }
  // JS 的 engines 走对象解析，不在清单表的文本正则里——其余生态的下限一律由上表的
  // `requires` 给出，只带出「运行时 + 约束」，**不解释具体语法**（那属于各生态自己的事）。

  for (const d of ['dist', 'lib', 'build', 'out']) {
    const e = root_.entry(d)
    if (e?.isDir === true) facts.distDirsPresent.push(e.name)
  }
  // 构建入口文件的存在本身就是线索：命令可能由下面 taskRunnerCommands 推导出来，
  // 也可能推不出来（Dockerfile 只说明打包方式）。推不出来时说清「有这么个文件」。
  // （Makefile 的 target、Dockerfile 的阶段各生态各不同），只报出「有这么个文件」。
  const buildEntryFiles = [...(walked?.sourceScan?.byBuildEntry ?? new Map()).keys()]
  if (buildEntryFiles.length > 0) facts.buildEntryFiles = buildEntryFiles
  for (const m of ECOSYSTEM_ARTIFACT_FACTS) {
    if (hasManifestOf(root, root_, m.ecosystem)) m.read(root, root_, facts)
  }
  return facts
}

/**
 * 逐生态的发布元数据：**清单在不在由清单表判，具体读什么由这里给**。
 *
 * 写成注册表而不是一串 if，是为了让「新增一个生态」的成本等于「加一行」——清单表加一行
 * 之外，这里再加一个读法，不必再回头往 detectArtifacts 的函数体里插一段。
 *
 * 每一项只做**文本 presence 判断**，不解释该生态的语义（字段含义、必填性、上限都是
 * 各生态自己的事，判据在对应专章里）。
 */
const ECOSYSTEM_ARTIFACT_FACTS = [
  {
    ecosystem: 'obsidian',
    read(root, root_, facts) {
      // 发布三件套 presence：
      //   - manifest 恒有（能走到这里说明 manifest.json 已被 `minAppVersion` 判据认过，
      //     所以不会把 PWA 的同名文件当成插件）；
      //   - mainJs/stylesCss 只看根目录有无：官方模板的忽略规则要求 main.js 不进版本库、
      //     只进发布附件，所以「根目录无 main.js」是正常态，不是缺陷；
      //   - mainJsIgnored 告诉上层「无 main.js 是有意的忽略还是真的没构建」；
      //   - hasVersionsJson 是旧宿主用户靠的回退映射；
      //   - manifestId 只做形状判断（小写字母与连字符、不含 obsidian、不以 plugin 结尾），
      //     供人复核，不做硬结论。
      const manifestText = readText(join(root, root_.real('manifest.json') ?? 'manifest.json')) ?? ''
      const manifestId = (/"id"\s*:\s*"([^"]+)"/.exec(manifestText) ?? [])[1]
      const gi = readText(join(root, root_.real('.gitignore') ?? '.gitignore'))
      const mainJsIgnored = gi === undefined ? undefined : gi.split(/\r?\n/).some((l) => {
        const t = l.trim()
        return t !== '' && !t.startsWith('#') && /(^|\/)main\.js$/.test(t)
      })
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
    },
  },
  {
    ecosystem: 'rust',
    read(root, root_, facts) {
      // publish=false 即声明不可发布（复用 private 机器）。另收 keywords/categories
      // 数量（各至多 5 个，超了服务端拒绝）与 edition 风险位（缺省 2015 可发布，
      // 不是必填）；authors 已废弃不判。
      const cargo = readText(join(root, root_.real('cargo.toml') ?? 'Cargo.toml')) ?? ''
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
    },
  },
  {
    ecosystem: 'go',
    read(root, root_, facts) {
      // module 路径、go 指令版本、retract 有无。只读文本，不下结论。
      const goText = readText(join(root, root_.real('go.mod') ?? 'go.mod')) ?? ''
      facts.goModule = {
        module: (/^module\s+(\S+)/m.exec(goText) ?? [])[1],
        goDirective: (/^go\s+(\S+)/m.exec(goText) ?? [])[1],
        hasRetract: /^\s*retract\s+/m.test(goText),
      }
    },
  },
  {
    ecosystem: 'python',
    read(root, root_, facts) {
      // 构建后端声明有无（构建命令只在有后端时给，见 deriveCommands）。另收发布硬门禁
      // 的几组 presence（只报有无，供门禁逐项点名）：readme/license 字段（长描述渲染
      // 炸是最常见的拒绝理由）、requires-python（装到旧版的根因定位）、dynamic version
      // （版本号权威在后端，标签对齐要按后端取值而不是照抄文件里的字面）。
      const pyText = readText(join(root, root_.real('pyproject.toml') ?? 'pyproject.toml')) ?? ''
      facts.pythonBuild = { hasBuildSystem: /\[build-system\]/.test(pyText) }
      facts.pythonMeta = {
        hasReadme: /^\s*readme\s*=/m.test(pyText),
        hasLicense: /^\s*license(\s*=|\s*\[)/m.test(pyText),
        hasRequiresPython: /^\s*requires-python\s*=/m.test(pyText),
        hasDynamicVersion: /dynamic\s*=\s*\[[^\]]*["']version["']/.test(pyText),
      }
    },
  },
]

/**
 * 宿主生态的补充勘察：**由 `scripts/ecosystems.mjs` 的描述符驱动**。
 *
 * 本函数不认识任何一个具体生态——它只准备通用上下文（读清单、找文件），
 * 然后把活交给描述符。加一个新宿主只要往那张表里加一个对象，这里一行都不用改。
 *
 * 返回 undefined 表示「这个项目不属于任何已登记的宿主生态」。
 */
function detectHostEcosystem(root, root_, eco) {
  const ctx = {
    exists: (rel) => root_.has(rel),
    readText: (rel) => {
      const real = root_.real(rel)
      return real === undefined ? undefined : readText(join(root, real))
    },
    manifest: (name) => {
      // 只有主清单已被本文件解析过时才复用；否则现读——但**不吞掉损坏**：
      // 损坏的清单由生态判定那一支单独报，这里返回 undefined 即可。
      if (name === 'package.json' && eco.manifest !== undefined) {
        return eco.manifest.__corrupt === true ? undefined : eco.manifest
      }
      return undefined
    },
  }
  const d = detectHost(HOST_ECOSYSTEMS, ctx)
  if (d === undefined) return undefined
  const facts = deriveHostFacts(d, ctx)
  if (facts === undefined) return undefined
  // 工具链与本地约定：**清单名由描述符声明**，本函数只按「有没有」逐个问文件系统。
  // 不在这里写死某个生态的配置文件名——那正是「主引擎不认识具体生态」的含义。
  facts.toolchain = {}
  for (const [key, names] of Object.entries(d.toolchain ?? {})) {
    facts.toolchain[key] = names.some((n) => root_.has(n))
  }
  for (const [key, dir] of Object.entries(d.localDirs ?? {})) {
    facts[key] = root_.entry(dir)?.isDir === true
  }
  if (typeof d.contractDoc === 'function') facts.contractDoc = root_.has(d.contractDoc(d.id))
  return facts
}



/**
 * 仓库本地 skills 盘点：通用协议，不止 DSH。
 *
 * 只收仓库内可提交的位置（见 `LOCAL_SKILL_BASES`），不碰家目录与外部 checkout。
 * **发现深度只有一层**——这套格式本身就是这么被发现的，更深的嵌套入口宿主根本不会
 * 加载，收进来只会报出一堆装不上的目录。每个 skill 只读目录名、`SKILL.md`
 * 的 frontmatter、是否有 `scripts/` 与 `references/`，不展开正文。损坏的入口标
 * corrupt，被宿主丢弃的标 dropped，两者都不是「没有」——中断一律不发生。
 *
 * 入口文件名与 frontmatter 解析都走 `SKILL_ENTRY_NAMES` 与 `skillFrontmatter`——与生态
 * 判定同一个来源。**同一种能力目录用两套解析器判定**，窄的那套会先失效：只认大写
 * `SKILL.md` 时，小写写法的目录在生态判定里认得、在盘点里报 corrupt，同一个目录两个
 * 答案。
 */
function detectLocalSkills(root) {
  const out = []
  const readDir = (p) => {
    try { return readdirSync(p, { withFileTypes: true, encoding: 'utf8' }) } catch { return [] }
  }
  const describe = (path, name, dir, entryName, text) => {
    const fm = skillFrontmatter(text)
    const descriptionHead = text === undefined
      ? undefined : (/^description:[ \t]*\|?([^\n]*)/m.exec(text) ?? [])[1]?.trim().slice(0, 120)
    const sub = readDir(dir)
    return {
      path,
      nameOk: fm === undefined ? undefined : fm.name === name,
      // 名字本身也带上：只报「不一致」而不报两边的名字，读的人还得自己去翻一遍文件。
      skillName: fm?.name,
      descriptionHead,
      hasScripts: sub.some((x) => x.name === 'scripts'),
      hasReferences: sub.some((x) => x.name === 'references'),
      corrupt: entryName === undefined || text === undefined,
      dropped: fm?.dropped,
      invocation: fm?.invocation,
    }
  }
  for (const base of LOCAL_SKILL_BASES) {
    const abs = join(root, base)
    for (const e of readDir(abs)) {
      if (e.name.startsWith('.')) continue
      // 两种形状：目录 bundle（`<名字>/SKILL.md`）与平铺的 `<名字>.md`。
      if (e.isDirectory()) {
        const dir = join(abs, e.name)
        const entryName = SKILL_ENTRY_NAMES.find((n) => existsSync(join(dir, n)))
        const rec = describe(`${base}/${e.name}`, e.name, dir, entryName,
          entryName === undefined ? undefined : readText(join(dir, entryName)))
        // 入口不在这一层、但更深一层有：发现深度只有一层，宿主根本走不到那里。
        // 这是「目录在、技能不在」的另一种成因，报出来才不会让人一直找别的原因。
        if (entryName === undefined) {
          const buried = readDir(dir)
            .filter((x) => x.isDirectory())
            .find((x) => SKILL_ENTRY_NAMES.some((n) => existsSync(join(dir, x.name, n))))
          if (buried !== undefined) {
            rec.dropped = `入口在 ${buried.name}/ 里，比发现深度多一层，宿主不会发现它`
          }
        }
        out.push(rec)
      } else if (e.isFile() && e.name.endsWith('.md')) {
        const file = join(abs, e.name)
        const name = e.name.slice(0, -'.md'.length)
        out.push(describe(`${base}/${e.name}`, name, abs, e.name, readText(file)))
      }
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
    ['contributing', ['CONTRIBUTING.md', 'CONTRIBUTING.rst']],
    ['license', ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING']],
    ['changelog', ['CHANGELOG.md', 'CHANGES.md', 'HISTORY.md']],
    ['codeOfConduct', ['CODE_OF_CONDUCT.md']],
  ]) {
    const hit = root_.first(candidates)
    docs[key] = hit === undefined ? undefined : { file: hit, bytes: sizeOf(join(root, hit)) }
  }

  // 许可证：**按声明判，不按文件名清单**。
  //
  // 一张固定的文件名清单一定会漏，而漏的后果是会诱导再写一份：Rust 生态的标准双许可
  // 布局是两个 `LICENSE-MIT` / `LICENSE-APACHE` 加清单里的 `license = "MIT OR Apache-2.0"`，
  // 根本**没有**单个 `LICENSE` 文件。按清单判成「缺」之后，AI 会去补一个 `LICENSE`，
  // 与清单里的双许可声明打架——而许可证一旦发布就收不回来。
  //
  // 判据与 `version-control.md` 那条通则一致：来源是**声明本身**，不是某个固定文件名。
  // 所以这里认的是「`LICENSE*` 这一族文件」，并把它们的名字全报出来。
  const licenseFamily = (() => {
    let entries = []
    try { entries = readdirSync(root, { encoding: 'utf8' }) } catch { return [] }
    return entries.filter((n) => /^(?:LICEN[CS]E|COPYING|UNLICENSE)(?:[._-].*)?$/i.test(n)).sort()
  })()
  if (licenseFamily.length > 0) {
    const primary = docs.license?.file ?? licenseFamily[0]
    docs.license = { file: primary, bytes: sizeOf(join(root, primary)) }
    // 一份以上是「许可证文件族」：双许可、或分语言/分发行版的常见布局。
    // 报出来，上层才不会把「没有 LICENSE 但有 LICENSE-MIT」判成缺。
    if (licenseFamily.length > 1) docs.licenseFamily = licenseFamily
  }

  // 别的 AI 宿主的约定文件：**只当事实报出来，不参与落盘决策**。
  //
  // 它们与 `AGENTS.md` 是并列的约定来源，一个项目里同时存在多份、甚至互相矛盾是常见的
  // （一份说用 pnpm、另一份说用 yarn）。不报出来的后果不是「少一个文件」，而是新生成的
  // 那份**看起来最权威**，于是矛盾被永久留在项目里，谁也不知道该信哪个。
  const HOST_CONVENTION_FILES = [
    'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.windsurfrules',
    'COPILOT_INSTRUCTIONS.md', '.github/copilot-instructions.md',
  ]
  const conventions = []
  for (const rel of HOST_CONVENTION_FILES) {
    const name = root_.real(rel)
    if (name === undefined) continue
    conventions.push({ file: name, bytes: sizeOf(join(root, name)) })
  }
  if (conventions.length > 0) {
    docs.aiConventions = conventions
    docs.agents = { file: conventions[0].file, bytes: conventions[0].bytes }
  }
  const ghEntry = root_.entry('.github')
  if (ghEntry?.isDir === true) {
    const gh = join(root, ghEntry.name)
    let entries = []
    let ghReadable = true
    try {
      for (const e of readdirSync(gh, { withFileTypes: true, encoding: 'utf8' })) entries.push(e.name)
    } catch {
      // 读不到 `.github` 与「`.github` 里什么都没有」必须分开：合成一句话之后，
      // 下游会把「读不到」当成「没有 Issue 模板、没有 CI」，进而建议用户去建一份
      // 他其实已经有的东西。
      ghReadable = false
      docs.githubUnreadable = true
    }
    docs.githubDir = entries
    docs.issueTemplates = ghReadable ? entries.some((n) => /^ISSUE_TEMPLATE/i.test(n)) : undefined
    docs.prTemplate = ghReadable ? entries.some((n) => /^pull_request_template/i.test(n)) : undefined
    const wfEntry = listRoot(gh).entry('workflows')
    if (wfEntry?.isDir === true) {
      let wfReadable = true
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
      } catch {
        // 读不到工作流目录 ≠「这个项目没有 CI」。合成一句话之后，下游会建议用户去建
        // 一份他其实已经有的东西；更糟的是 review 会说「CI 缺失，问用户要不要」。
        wfReadable = false
        docs.workflowsUnreadable = true
      }
      if (!wfReadable) docs.workflows = undefined
    }
  }
  return docs
}

function detectGit(root, options = {}) {
  const version = run('git', ['--version'], root)
  if (version === undefined) return { available: false }

  // **一次取回一批事实**，而不是每个字段各起一个子进程。
  //
  // 实测（Windows，单次 git 约 32 ms）：改动前这个函数要起 19 个子进程，
  // 占一次勘察总耗时的 56%；CPU 剖面里子进程占了 96%，JS 自己的逻辑只有 4%。
  // 也就是说那些时间**一点覆盖率都没买到**——问的是同一批信息，只是分成了很多次问。
  //
  // 这里的合并全部是**同一份数据的另一种取法**，不减少任何一项信息：
  //   - `status --porcelain=v2 --branch` 同时给出分支、上游跟踪、领先/落后、脏文件数
  //     （原先 branch / status / rev-parse @{u} 三次）；
  //   - `config --list --show-scope --show-origin` 一次给出全部配置及其层级
  //     （原先 user.name / user.email / --local / --global×2 / init.defaultBranch 六次）；
  //   - `for-each-ref` 给标签（原一次）；
  //   - `rev-parse` 一次给出「在不在工作区」与「工作区根在哪」（原先两次，且两处各问一次）。
  const insideR = runCapture(['rev-parse', '--is-inside-work-tree', '--show-toplevel'], root)
  const lines0 = insideR.ok ? insideR.stdout.split('\n').map((s) => s.trim()) : []
  const present = lines0[0] === 'true'
  if (!present) return { available: true, present: false, version }
  const toplevel = lines0[1]

  // 关键区分：**这个目录本身是仓库根，还是只是处在别人的仓库里**。
  //
  // 目标目录若是某个外层仓库的子目录（放错位置，或想给一个子项目单独建库），下面那些
  // 查询会如实返回**外层仓库**的远端、分支与提交数。照单全收就会得出「已有远端，只补
  // 缺即可」的结论，然后把改动提交进、甚至推送到一个完全不相干的仓库——这是本 skill
  // 能造成的破坏里最严重的一种。
  const isRepoRoot = toplevel !== undefined && toplevel !== '' && samePath(toplevel, root)

  // ── 配置：一次取全，按层级解析 ─────────────────────────────────────────────
  //
  // 层级必须是**三层**（system / global / local）。之前的心智模型只有
  // 「仓库级 / 继承」两层，于是「~/.gitconfig 不存在」被读成「没有任何配置」——
  // 而全局工具的安装器常把配置写在 system 层（实测：Git Credential Manager 就写在那里，
  // 凭据助手 `manager` 只在 system 层可见）。那个两层的模型是错误结论的来源。
  const cfgR = runCapture(['config', '--list', '--show-scope', '--show-origin'], root)
  const cfg = { byScope: { system: {}, global: {}, local: {} } }
  if (cfgR.ok) {
    for (const raw of cfgR.stdout.split('\n')) {
      const line = raw.trim()
      if (line === '') continue
      // 形如 `local\tfile:.git/config\tuser.name=值`；值里可能有 `=`，只切前两个制表符。
      const parts = line.split('\t')
      if (parts.length < 3) continue
      const scope = parts[0]
      const body = parts.slice(2).join('\t')
      const eq = body.indexOf('=')
      if (eq < 0) continue
      const key = body.slice(0, eq).trim()
      const value = body.slice(eq + 1)
      if (cfg.byScope[scope] !== undefined) cfg.byScope[scope][key] = value
    }
  }
  const cfgGet = (key) => {
    // local 优先于 global，global 优先于 system —— 与 git 自己的取值顺序一致。
    for (const scope of ['local', 'global', 'system']) {
      const v = cfg.byScope[scope]?.[key]
      if (v !== undefined) return v
    }
    return undefined
  }
  const cfgScope = (key) => {
    for (const scope of ['local', 'global', 'system']) {
      if (cfg.byScope[scope]?.[key] !== undefined) return scope
    }
    return undefined
  }

  // ── 分支与工作区状态：一次取全 ─────────────────────────────────────────────
  const stR = runCapture(['status', '--porcelain=v2', '--branch'], root)
  const branchInfo = { branch: undefined, upstream: undefined, ahead: 0, behind: 0 }
  let dirty
  if (stR.ok) {
    const rows = stR.stdout.split('\n').filter((l) => l !== '')
    dirty = rows.filter((l) => !l.startsWith('#')).length
    for (const l of rows) {
      if (!l.startsWith('#')) continue
      const m = /^# branch\.(head|upstream|ab)\s+(.*)$/.exec(l)
      if (m === null) continue
      if (m[1] === 'head') branchInfo.branch = m[2].trim()
      else if (m[1] === 'upstream') branchInfo.upstream = m[2].trim()
      else {
        const ab = /\+(\d+)\s+-(\d+)/.exec(m[2])
        if (ab !== null) { branchInfo.ahead = Number(ab[1]); branchInfo.behind = Number(ab[2]) }
      }
    }
  }

  const remotes = (run('git', ['remote'], root) ?? '').split('\n').filter(Boolean)

  // ── 标签：一次取全（按创建时间倒序）────────────────────────────────────────
  //
  // 按**创建时间倒序**，不是 git 默认的 ref 名字典序。字典序会把 `v0.10.0` 排在
  // `v0.9.0` 前面，取「最后几个」拿到的是最旧的那批——而这个列表正是用来判断
  // 「当前版本有没有打标签」和「拿哪几个标签去对齐」的。
  const tagsR = runCapture(['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)', 'refs/tags'], root)
  const tags = tagsR.ok ? tagsR.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : undefined

  const info = {
    available: true,
    present: true,
    isRepoRoot,
    workTreeRoot: toplevel,
    version,
    branch: branchInfo.branch ?? (run('git', ['branch', '--show-current'], root) ?? undefined),
    remote: run('git', ['remote', 'get-url', 'origin'], root),
    remotes,
    // 远端全地址：只存名列表会在 fork 比对时无米之炊。取不到就标缺失，不编造。
    remoteUrls: (() => {
      const out = {}
      for (const name of remotes) out[name] = run('git', ['remote', 'get-url', name], root)
      return out
    })(),
    identity: {
      name: cfgGet('user.name'),
      email: cfgGet('user.email'),
      // 四档，不是两档：配置可以来自 system / global / local 任一层。
      // 只分「仓库级 / 继承」会让「没有 ~/.gitconfig」看起来等于「没有任何配置」，
      // 而全局工具的安装器常把配置写在 system 层。
      scope: cfgScope('user.name') ?? 'unset',
      globalName: cfg.byScope.global['user.name'],
      globalEmail: cfg.byScope.global['user.email'],
      // 凭据助手所在的层级与取值：实测本机落在 system 层，两层模型看不见它。
      credentialHelper: cfg.byScope.system['credential.helper'] ?? cfg.byScope.global['credential.helper'],
      credentialHelperScope: cfgScope('credential.helper'),
    },
    tags,
    // 历史署名去重前 20：换过人或换过机器时一眼看出混杂，不再靠人工 git log。
    historyAuthors: (() => {
      const out = run('git', ['log', '--format=%an <%ae>', '--no-merges', '-n', '200'], root)
      if (out === undefined) return undefined
      return [...new Set(out.split('\n').filter(Boolean))].slice(0, 20)
    })(),
  }
  info.dirty = dirty
  info.ahead = branchInfo.ahead
  info.behind = branchInfo.behind

  // **读不到与 0 是两件事**。`rev-list` 在没有提交、游离 HEAD、仓库损坏时都会失败；
  // 折叠成 0 会让上游把「一个已有历史的仓库」当成全新仓库，走向「首次提交」那条分支。
  // 同函数的 `dirty` 一直保留着 undefined，这里跟上它。
  const count = run('git', ['rev-list', '--count', 'HEAD'], root)
  info.commits = count === undefined ? undefined : Number(count)
  info.commitsState = count === undefined ? 'unreadable' : 'ok'

  // 受控文件清单只取一次：这里要数量，下面判断凭据是否已入库要集合。
  // 同一条命令跑两遍是纯浪费——它在 Windows 上约 30 毫秒，而清单可能很长。
  info.trackedPaths = runGitPaths(['ls-files', '-z'], root)
  info.trackedFiles = info.trackedPaths === undefined ? undefined : info.trackedPaths.length
  info.upstream = branchInfo.upstream
  info.head = run('git', ['rev-parse', 'HEAD'], root)
  // 初始化新仓库前需要知道默认分支会叫什么。平台默认分支名不一致（有的 main、有的
  // master），而这件事由本地配置决定——提前读出来，免得建出来的分支名与用户预期不符。
  info.initDefaultBranch = cfgGet('init.defaultBranch')
    ?? '(未配置，取决于 git 版本与平台默认)'

  // 不是仓库根时，上面这些值都属于外层仓库，对判定没有意义。明确标注，并给出正确的
  // 下一步——而不是让上层自己察觉「远端怎么有点眼生」。
  if (!isRepoRoot) {
    info.note = '该目录处在另一个仓库的工作区内，不是仓库根。上面的远端、分支与提交数'
      + '都属于那个外层仓库，不代表本目录的状态。给本目录建库前必须先与用户确认边界'
      + '（是并入外层仓库，还是在本目录单独建库）；在确认之前不要提交、也不要推送。'
  }
  info.auth = detectAuth(info, root, options)
  return info
}

/**
 * 推送认证的现状：**「能不能推代码」是一条独立的事实，不是从工具装没装推出来的。**
 *
 * 这条判据解决的是一个真实误判：`~/.gitconfig` 不存在、`gh` 没装，被读成了「本机没有
 * 凭据」，于是让用户去做一件完全没必要做的事——而实际上凭据助手在 system 层，
 * 推送一直是通的。
 *
 * **判据用 git 自己的协议，不翻译一遍**：`git credential fill` 问的是「这条远端能不能
 * 拿到凭据」，退出码就是答案。这与本仓库已经用了两次的做法同源（用导出清单判包内容、
 * 用忽略检查判忽略），不是新机制。
 *
 * 三条红线：
 *   - 只判「有没有」，**绝不读取密码的值**，长度也不外传；
 *   - 必须屏蔽交互与超时，否则无人值守时会挂死等人输入；
 *   - 判不出来就是 `undetermined`，**不许读成 `no-credential`**。
 */
function detectAuth(info, root, options = {}) {
  const out = {
    // 凭据助手所在的层级与取值：两层模型（仓库级/继承）看不见 system 层，而那正是常见落点。
    helper: info.identity.credentialHelper,
    helperScope: info.identity.credentialHelperScope,
    https: 'undetermined',
    httpsReason: undefined,
    network: 'undetermined',
    networkReason: undefined,
  }

  const remote = info.remote
  if (typeof remote !== 'string' || remote === '') {
    out.https = 'n/a'
    out.httpsReason = '没有远端地址，谈不上推送认证'
    out.network = 'n/a'
    return out
  }
  // SSH 远端不走凭据助手这条路：它的认证是密钥 + agent，`credential fill` 对它无意义。
  if (!/^https?:\/\//i.test(remote)) {
    out.https = 'undetermined'
    out.httpsReason = '远端不是 HTTPS 形式（SSH 一类），推送认证由密钥与 agent 决定，'
      + '这条协议判不出来——不要据此断言「没有凭据」'
    return out
  }

  // ── HTTPS：问凭据助手要一次，只看退出码 ────────────────────────────────────
  //
  // 屏蔽交互是硬要求：没有凭据时 `credential fill` 会提示输入密码，无人值守时挂死。
  // `GCM_INTERACTIVE=never` 关掉凭据管理器自己的弹窗与 provider 探测。
  let host = ''
  try { host = new URL(remote).host } catch { host = '' }
  if (host === '') {
    out.httpsReason = '远端地址解析不出主机名'
  } else {
    // **必须在目标项目里问**，不能取当前工作目录。
    //
    // `credential fill` 会读 local 层配置，而 local 层是**仓库自己的**配置：在别的目录里
    // 问，拿到的是那个仓库的凭据助手，不是这个项目的。刚建立的三层配置模型里 local 层
    // 的全部意义就在于此，跑错目录等于把它废掉。
    const r = spawnSync('git', ['credential', 'fill'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
      input: `protocol=https\nhost=${host}\n\n`,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        GIT_ASKPASS: '',
        SSH_ASKPASS: '',
      },
    })
    if (r.error !== undefined) {
      out.httpsReason = `凭据助手没跑起来：${r.error.code ?? r.error.message}`
    } else if (r.status === 0) {
      // 成功即「拿得到凭据」。**不解析值**：这里只需要知道「有没有」。
      out.https = 'available'
      out.httpsReason = `凭据助手（${out.helper ?? '未声明'}）为 ${host} 返回了凭据`
    } else {
      // 非零退出说明这次没拿到，但「没拿到」不等于「机器上没有凭据」：
      // 也许助手本身不可用、也许超时。原因写进 reason，状态留给上层判。
      out.https = 'no-credential'
      const tail = String(r.stderr ?? '').split('\n').filter(Boolean).slice(-2).join('；')
      out.httpsReason = tail === '' ? `凭据助手以退出码 ${r.status} 结束` : tail
    }
  }

  // ── 网络可达性：**默认不探测** ──────────────────────────────────────────
  //
  // 默认跑 `git ls-remote` 时，网络受限的机器上一次要等二十来秒（连接超时），
  // 而勘察本身不到一秒——它把一件「偶尔想知道」的事变成每次调用都要付的代价。
  //
  // 现在默认给 `undetermined` 并说明「没有探测」，需要时用 `--probe-network` 显式开。
  // 判据取「不阻塞主流程」，而不是「顺手也测一下」：勘察要被反复调用，任何一次网络
  // 往返都不该混进来。
  if (options.probeNetwork === true) {
    const netR = spawnSync('git', ['ls-remote', '--heads', remote], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    })
    if (netR.error !== undefined) {
      out.networkReason = `探测没跑起来：${netR.error.code ?? netR.error.message}`
    } else if (netR.status === 0) {
      out.network = 'reachable'
    } else {
      out.network = 'unreachable'
      const err = String(netR.stderr ?? '')
      const signals = [
        [/Could not resolve host/i, 'DNS 解析失败'],
        [/Failed to connect to/i, '连接不上（防火墙/代理/端口）'],
        [/Repository not found|not found/i, '远端不存在，或凭据对私有仓库不可见'],
        [/Authentication failed|Bad credentials|Invalid username or token/i, '认证被拒'],
        [/terminal prompts disabled|could not read Username/i, '非交互环境取不到凭据'],
        [/timed out|Timeout/i, '超时'],
      ]
      const hit = signals.find(([re]) => re.test(err))
      out.networkReason = hit !== undefined ? hit[1] : '未识别的失败（见 stderr）'
    }
  } else {
    out.networkReason = '没有探测（默认不联网；需要时加 --probe-network）'
  }

  return out
}

function detectIgnores(root, root_, outputDirCandidates, gitFact) {
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
  // 不在工作区时跳过：此时 check-ignore 全失败，会把所有目录误报为未忽略。
  //
  // **一次批处理，不逐个起子进程**：候选来自 walk() 的全树枚举（任何深度），
  // 用 `check-ignore --stdin -z` 一把判定。逐个 spawn 的代价随目录数线性增长，
  // 而只探一层的后果是标准 monorepo 的 `packages/<包名>/dist` 全被漏掉。
  // 复用已经问过的 git 事实：工作区在不在，detectGit 早就答过了。
  // 再跑一次 rev-parse 是纯浪费，而且两处各答一次就可能各错一次。
  const gitUsable = gitFact !== undefined ? gitFact.present === true : run('git', ['rev-parse', '--is-inside-work-tree'], root) === 'true'
  const probe = []
  if (gitUsable) {
    // 候选 = 全树候选（任何深度的产物目录名）∪ 顶层已知产物目录名。
    // 后一半是必须的：`venv/`、`node_modules/` 这类名字在走查里被当作依赖目录整体
    // 跳过了，不会进走查结果——而「虚拟环境就在那里、忽略规则却没覆盖它」正是最该
    // 报出来的那种情况。两半都取自同一张目录规则表，不会各自漂移。
    const topLevel = OUTPUT_DIR_HINTS
      .filter((d) => root_.entry(d)?.isDir === true)
      .map((d) => root_.real(d))
    const candidates = [...new Set([...(outputDirCandidates ?? []), ...topLevel])]
    const ignored = gitIgnoredSet(root, candidates)
    // 查的 key 与存进集合的写法必须一致：walk 产出的相对路径在 Windows 上是反斜杠，
    // 而 check-ignore 的输出已归一化成正斜杠。不归一就永远配不上，症状是「顶层目录
    // 判得对、嵌套目录全被判成未忽略」。
    for (const dir of candidates) {
      probe.push({ dir, ignored: ignored === undefined ? undefined : ignored.has(posixPath(dir)) })
    }
    if (ignored === undefined) {
      out.ignoreProbeUnavailable = '版本控制没能回答「哪些目录被忽略」——本节判定不完整，'
        + '请手工核对，不要把读不到当成已覆盖'
    }
  }
  if (probe.length > 0) {
    out.presentOutputDirs = probe
    const notIgnored = probe.filter((x) => x.ignored === false).map((x) => x.dir)
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

function survey(target, options = {}) {
  const root = resolve(target)
  if (!exists(root)) throw new Error(`目录不存在：${root}`)
  const st = statSync(root)
  if (!st.isDirectory()) throw new Error(`不是目录：${root}`)

  const root_ = listRoot(root)
  // 先走查：它收集的形状证据（源码扩展名、构建描述文件）是生态兜底判定的输入，
  // 顺序不能颠倒。
  const walked = walk(root)
  const eco = detectEcosystem(root, root_, walked)
  const git = detectGit(root, options)

  // 内容级扫描的候选来自**递归走查**，不来自版本控制。
  //
  // 「给一个还没有版本库的项目配版本管理」正是本 skill 的主场景，那时没有任何已跟踪
  // 文件可查——候选若取自版本控制，扫描会静默退化成只扫顶层，于是 src/ 里的 API key
  // 一个都扫不到，报告仍显示「0 命中」，G2 据此放行提交。密钥门控最坏的失效方式就是
  // 这个：它看起来像在工作。
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

  // 敏感文件名分两档定案：`always` 名字即足够；`confirm` 要内容里也出现凭据形状。
  //
  // 「没扫到」与「扫过没命中」必须区分：扫不到（超上限、二进制、读不出）的 confirm 文件
  // 仍然要报出来并标成未确认，否则一个 2MB 的 `credentials.json` 会因为超单文件上限而
  // 变成一条**看不见的**风险——那正是密钥门控最坏的失效方式。
  const notScanned = new Set(walked.skippedLargePaths ?? [])
  const secretFiles = walked.secretFiles
    .filter((h) => h.tier === 'always' || scanned.shaped.has(h.path) || notScanned.has(h.path))
    .map((h) => ({
      ...h,
      confirmed: h.tier === 'always' ? true : scanned.shaped.has(h.path) ? true : undefined,
    }))

  // 给风险项补上两个比特：「已经在版本库里了吗」「被忽略规则覆盖了吗」。
  // 两个比特决定处置方式，缺一个就只能一律报缺——而那正是门禁变噪音的原因：
  //   - 已跟踪：只能从索引移除并轮换；
  //   - 未跟踪且已忽略：不进版本库（.gitignore 里的 .env 就是这样），报事实但不拦；
  //   - 未跟踪且未忽略：下一次 `git add -A` 就会把它带进历史。
  // 三条风险（凭据内容、敏感文件名、本机私有路径）共用同一次批处理，判定只有一个实现。
  //
  // 两个比特都是**三态**（真 / 假 / 取不到）。「取不到」时留 undefined 而不是 false：
  // 目录不在工作区里，「没有被跟踪」是确定的（false）；在工作区里但清单读不全
  // （输出超上限、命令失败），那是**没问出来**，与「问出来是没有」不是一回事。把它
  // 读成 false 会让已在历史里的凭据被当成可以从这次提交里排除，处置方向正好反了。
  const inWorkTree = git.available === true && git.present === true
  // 复用 detectGit 已经取过的清单：同一条命令不重复跑。
  const trackedList = git.trackedPaths
  const trackedSet = trackedList === undefined && inWorkTree ? undefined : new Set(trackedList ?? [])
  const markBits = (entry) => ({
    ...entry,
    tracked: trackedSet === undefined
      ? undefined
      : trackedSet.has(posixPath(entry.path)) || trackedSet.has(entry.path),
    ignored: false,
  })
  let secrets = scanned.secrets.map(markBits)
  let largeFiles = walked.largeFiles.map(markBits)
  let tagged = secretFiles.map(markBits)
  let homePathLeaks = scanned.homePaths.map(markBits)
  const bitPaths = [...secrets, ...tagged, ...homePathLeaks].map((x) => x.path)
  const ignoredSet = bitPaths.length > 0 ? gitIgnoredSet(root, bitPaths) : new Set()
  // 不在工作区里就没有「被忽略」这回事，取值确定是 false；工作区里读不到才是未知。
  const fill = (list) => list.map((entry) => ({
    ...entry,
    ignored: ignoredSet === undefined ? (inWorkTree ? undefined : false) : ignoredSet.has(posixPath(entry.path)),
  }))
  secrets = fill(secrets)
  tagged = fill(tagged)
  homePathLeaks = fill(homePathLeaks)

  // 标签与版本号对齐：自动化对不上的根源。复用 detectGit 已取到的标签列表，
  // 不另起 git 进程；非仓库根（标签属外层仓库）或取不到时保持 undefined，不判 false。
  // 只做事实比对，不下结论。
  const artifacts = detectArtifacts(root, root_, eco, walked)
  if (artifacts.declaredVersion !== undefined && git.isRepoRoot !== false && Array.isArray(git.tags)) {
    artifacts.versionAligned = git.tags.some(
      (t) => t === artifacts.declaredVersion || t === `v${artifacts.declaredVersion}`)
    artifacts.versionAlignedTags = git.tags.slice(0, 5)
  }

  // 已跟踪但被忽略的文件也要单独报出来：忽略规则对它们无效，这是个独立的陷阱。
  // 忽略探查只跑一次，两处复用同一结果。
  const ignores = detectIgnores(root, root_, walked.outputDirCandidates, git)

  // workspace 拓扑：多包仓库的事实，供上层决定「命令该在哪一层跑」、
  // 「产物在哪个子包里」。读不到就是没有声明，不按目录形状猜。
  const workspace = detectWorkspace(root, root_)

  return {
    target: { path: root, name: basename(root) },
    git,
    ecosystem: { kinds: eco.kinds, evidence: eco.evidence, skillName: eco.skill?.name, skillDropped: eco.skill?.dropped },
    commands: deriveCommands(root, root_, eco),
    workspace,
    artifacts,
    // 宿主生态的补充事实：由描述符驱动，主引擎不认识任何具体生态名。
    // 保留 dsh 这个键是向后兼容——消费方改名是另一件事，不在这次改动里。
    dsh: detectHostEcosystem(root, root_, eco),
    localSkills: detectLocalSkills(root),
    docs: detectDocs(root, root_),
    ignores,
    outputs: {
      heavyDirsPresent: walked.heavyDirs,
      knownOutputDirs: OUTPUT_DIR_HINTS.filter((d) => root_.entry(d)?.isDir === true),
    },
    risks: {
      secretFiles: tagged,
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
        // 读不出来的**目录**：整棵子树都没进勘察。与 `unreadable`（文件）分开列，
        // 因为处置不同——一个是「这个文件没扫」，一个是「这块地方整个没看」。
        unreadableDirs: (walked.unreadableDirs ?? []).slice(0, 20),
        unreadableDirCount: (walked.unreadableDirs ?? []).length,
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
      // 口径要与 contentScan.scope 对齐：体量统计排除的是「整目录跳过的依赖/缓存」
      // 加上「名字像产物但可能藏着源码」的那类（它们仍参与凭据扫描）。
      note: '体量统计不含依赖目录、版本控制目录，以及名字像产物但可能藏着源码的目录'
        + '（后者仍参与凭据扫描）',
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
    // 提交数读不到时**说出来**，不要印一个 0 —— 0 的含义是「还没有任何提交」，
    // 与「问了但没问出来」是两件事，后者会让一个已有历史的仓库被带向首次提交。
    const commitsText = s.git.commitsState === 'unreadable'
      ? '**读不到**（不是「零个提交」）'
      : yn(s.git.commits)
    L.push(`- 分支：${yn(s.git.branch)}　提交数：${commitsText}　未提交：${yn(s.git.dirty)}`)
    if (s.git.ahead > 0 || s.git.behind > 0) {
      L.push(`- 相对上游：领先 ${s.git.ahead} 个提交、落后 ${s.git.behind} 个`
        + (s.git.behind > 0 ? '——推送前先取回远端' : ''))
    }
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
    // 推送认证单独成行，**与「远端地址有没有」分开说**：有地址不等于能推上去，
    // 这两件事最常见的组合就是「能推但建不了新的」或反过来。
    const auth = s.git.auth
    if (auth !== undefined) {
      const label = auth.https === 'available' ? '**可用**（直接推，不要要求用户配置凭据）'
        : auth.https === 'no-credential' ? '**取不到凭据**（才需要提示用户配置）'
          : auth.https === 'n/a' ? '不适用'
            : '**未确认**（不等于没有凭据，不要据此让用户重新登录）'
      L.push(`- 推送认证（HTTPS）：${label}`)
      if (auth.helper !== undefined) {
        L.push(`  - 凭据助手：${auth.helper}（${auth.helperScope ?? '层级未知'}）`
          + '——注意它可能在 system 层，`~/.gitconfig` 不存在不代表没有配置')
      }
      if (auth.httpsReason !== undefined) L.push(`  - 依据：${auth.httpsReason}`)
      if (auth.network === 'unreachable') {
        L.push(`- 远端可达性：**不可达**（${auth.networkReason ?? '原因未识别'}）`
          + '——网络不通时不要去查凭据，那是两件事')
      } else if (auth.network === 'undetermined' && auth.networkReason !== undefined) {
        L.push(`- 远端可达性：未确认（${auth.networkReason}）`)
      }
    }
    if (Array.isArray(s.git.historyAuthors) && s.git.historyAuthors.length > 1) {
      L.push(`- 历史署名 ${s.git.historyAuthors.length} 种：${s.git.historyAuthors.join('；')}`)
    }
    if (Array.isArray(s.git.tags) && s.git.tags.length > 0) {
      // 列表头就是最近的（标签按创建时间倒序取的），所以取前几个。
      const shown = s.git.tags.slice(0, 5)
      L.push(`- 已有版本标签 ${s.git.tags.length} 个（由近及远）：${shown.join('、')}`
        + (s.git.tags.length > shown.length ? '（仅列最近 5 个）' : ''))
    } else if (s.git.present === true && s.git.tags === undefined) {
      L.push('- 已有版本标签：**读不到**（标签列表没取到，不是「一个都没有」）')
    }
  }
  L.push('')
  L.push('## 生态判定')
  L.push('')
  L.push(`- 判定结果：${s.ecosystem.kinds.join(' / ')}`)
  L.push(`- 依据：${s.ecosystem.evidence.join('、') || '无'}`)
  // 多包仓库要单独说：命令该在哪一层跑、产物在哪个子包里，都取决于这份事实。
  if (s.workspace?.declared === true) {
    L.push(`- 多包仓库：由 ${s.workspace.tools.join('、')} 声明，`
      + `展开出 ${s.workspace.packages.length} 个子包`
      + (s.workspace.packages.length > 0 ? `（${s.workspace.packages.slice(0, 6).join('、')}` : '')
      + (s.workspace.packages.length > 6 ? ' 等）' : (s.workspace.packages.length > 0 ? '）' : '')))
    if (s.workspace.note !== undefined) L.push(`  - ${s.workspace.note}`)
  }
  if (s.dsh !== undefined) {
    const d = s.dsh
    L.push(`- DSH 包名：${d.packageName ?? '未声明'}`)
    L.push(`- DSH 补丁文件：${d.patchFile ?? '缺'}`
      + (d.bundlePatch === undefined ? '' : `；清单声明 ${d.bundlePatch.path}（${d.bundlePatch.exists ? '存在' : '缺失'}）`))
    L.push(`- DSH 入口：host ${d.hasHostEntry ? '有' : '缺'}；client ${d.hasClientEntry ? '有' : '无'}`
      + `（dsh.client 声明${d.hasClientDecl ? '有' : '无'}）`)
    L.push(`- DSH 声明式元数据：manifestVersion ${d.hasManifestVersion ? '有' : '无'}`
      + `；engines.dsh ${d.enginesDsh ?? '未声明'}；包根图标 ${d.hasIcon ? '有' : '无'}`
      + '（都是声明，宿主当前是否强制执行另查专章）')
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
  if (s.ecosystem.skillDropped !== undefined) {
    L.push(`- **本仓库的能力目录会被宿主丢弃**：${s.ecosystem.skillDropped}——症状是「目录在、技能不在」，先按专章核对宿主契约`)
  }
  if (Array.isArray(s.localSkills) && s.localSkills.length > 0) {
    L.push(`- 本地 skills ${s.localSkills.length} 个：${s.localSkills.map((x) => x.path).join('、')}`)
    for (const x of s.localSkills) {
      // 有具体成因就先报成因：「入口多了一层」比「入口缺失」更能指到要改的那一处。
      if (x.dropped !== undefined) L.push(`  - **${x.path}：${x.dropped}**`)
      else if (x.corrupt === true) L.push(`  - ${x.path}：SKILL.md 损坏或缺失，先修再用`)
      // 目录名与 frontmatter 的 name 不一致：宿主要求两者逐字相同，不一致时**整份会被丢弃**，
      // 而症状与「压根没装」一模一样。判定早就算出来了（`nameOk`），不渲染出来等于白算。
      else if (x.nameOk === false) {
        L.push(`  - **${x.path}：目录名与 frontmatter 的 name 不一致`
          + `${x.skillName === undefined ? '' : `（name: ${x.skillName}）`}`
          + '——宿主按目录发现、按 name 校验，两者须逐字相同，否则整份被丢弃**')
      }
    }
  }
  L.push('')
  L.push('## 可执行命令')
  L.push('')
  // **正向清单**：只有 COMMAND_KEYS 里的键算命令。排除式的黑名单要求每加一个新键
  // 就补一次，漏掉的那个会被当命令渲染出来——`note`（「该生态的命令推导尚未实现」）
  // 就这样被渲染成一条可执行命令，而它的存在又让下面那条「没有命令」永远不出现：
  // P7 要求如实汇报「这个项目一行都没验证过」的那条信号，就这样被一条注释顶掉了。
  const cmds = Object.entries(s.commands).filter(([k, v]) => COMMAND_KEYS.includes(k) && typeof v === 'string')
  if (cmds.length === 0) L.push('- 未推导出任何命令（正常结果：说明项目没声明这些命令，'
    + '不代表错误；此时 P7 的验证不成立，见 SKILL.md）')
  else for (const [k, v] of cmds) L.push(`- ${k}：\`${v}\``)
  // 说明与命令分开列：它们解释「这条命令从哪来」，本身不是命令。`note` 是普通说明，
  // 不套反引号——套上会让一段话看起来像一个可执行的名字（`xxxNote` 那类键名才需要）。
  for (const [k, v] of Object.entries(s.commands)) {
    if (!isNoteKey(k) || typeof v !== 'string') continue
    L.push(k === 'note' ? `  - 说明：${v}` : `  - \`${k}\`：${v}`)
  }
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
  if (Array.isArray(a.buildEntryFiles) && a.buildEntryFiles.length > 0) {
    L.push(`- 构建入口文件：${a.buildEntryFiles.join('、')}`
      + '（Makefile 的目标名已按实际内容推导进「可执行命令」；Dockerfile 只记存在，'
      + '它说的是打包方式，不是构建命令）')
  }
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
  /** 三态渲染：读不到就说读不到，不能读成「不在库里」。 */
  const trackedText = (t) => t === true ? '**已在版本库里**'
    : t === false ? '尚未跟踪'
      : '**无法确认是否已入库**（受控文件清单没取到，请手工核对）'
  if (r.secretFiles.length === 0) {
    L.push('- 敏感文件：无')
  } else {
    const names = r.secretFiles.slice(0, 5).map((h) => h.path).join('、')
    L.push(`- 敏感文件：${r.secretFiles.length} 个（${names}）`)
    for (const hit of r.secretFiles.slice(0, 5)) {
      // 名字像但内容没确认的（扫不到）要单独标出来——「没扫到」不是「没问题」。
      const unconfirmed = hit.confirmed === undefined ? '，内容未能确认' : ''
      L.push(`  - ${hit.path}（${trackedText(hit.tracked)}；`
        + `${hit.ignored === true ? '已被忽略规则排除' : hit.ignored === false ? '未被忽略' : '忽略状态读不到'}`
        + `${unconfirmed}）`)
    }
  }
  L.push(`- 内容里的凭据形状：${r.secretContent.length === 0 ? '无' : r.secretContent.length + ' 处'}`)
  if (r.secretContent.length > 0) {
    for (const hit of r.secretContent.slice(0, 10)) {
      // tracked 这一个比特决定处置：未跟踪的能从这次提交排除，已在历史里的只能轮换。
      L.push(`  - ${hit.path}:${hit.line ?? '?'}（${hit.kind}，${trackedText(hit.tracked)}）`)
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
    if ((scan.unreadableDirCount ?? 0) > 0) {
      L.push(`- **有 ${scan.unreadableDirCount} 个子目录读不出来（权限或锁定），整棵子树没进勘察**：`
        + `${(scan.unreadableDirs ?? []).slice(0, 5).join('、')}`
        + '——「没报」在这些目录里不等于「没有」。看一眼权限，或手工检查那几个目录。')
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
  // 网络探测默认关闭：网络受限时一次 `ls-remote` 要等十几秒，而勘察本身不到一秒。
  // 需要时显式开，不把「偶尔想知道」的事塞进每一次调用。
  const probeNetwork = flags.includes('--probe-network')
  if (flags.includes('--help') || flags.includes('-h')) {
    process.stdout.write([
      '用法：node scripts/survey.mjs [目录] [--json|--markdown] [--probe-network]',
      '',
      '  --json            输出 JSON（默认）',
      '  --markdown        输出给人看的摘要',
      '  --probe-network   额外探测远端可达性（会联网，网络不通时可等十几秒）',
      '',
      '只读勘察：不写任何文件。',
      '',
    ].join('\n'))
    return 0
  }
  let result
  try {
    result = survey(target, { probeNetwork })
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
 *
 * 三张表（源码扩展名、构建描述文件、清单表）都是**自动**并进来的：给其中任意一张加一个
 * 生态，值域自动跟着长，不需要在这里再抄一遍。这里只列「不由文件名识别」的那几个 kind
 * ——.NET 靠工程文件、插件类靠清单内部的字段、三个无形态是判定结果而非生态。
 */
export function kindVocabulary() {
  return [...new Set([
    ...SOURCE_EXT_KINDS.map(([, kind]) => kind),
    ...BUILD_FILE_KINDS.map(([, kind]) => kind),
    ...MANIFEST_KINDS.map(manifestKind),
    'dotnet',
    'dsh-plugin', 'skill', 'vscode-extension', 'obsidian-plugin',
    'docs-only', 'unrecognized', 'unknown',
  ])].sort()
}

export { survey, toMarkdown, humanBytes }