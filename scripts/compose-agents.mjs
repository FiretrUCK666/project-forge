#!/usr/bin/env node
/**
 * compose-agents.mjs —— 生成并维护项目的 AGENTS.md
 *
 * 存在两个理由，对应两种失败：
 *
 * 一、通用内核（行事总纲、本文件的定位与编辑规则）对任何项目都成立，
 *     应当逐字一致。靠手抄必然漂移——改了一处漏了另一处，几个月后各项目的「总纲」就
 *     各不相同了。所以内核收敛成单一来源 templates/agents-kernel.md，由本脚本注入。
 *
 * 二、首次生成时，项目特有的段落如果只给「填写要点」而不落成真实内容，交出去的
 *     就是一份空壳：使用者以为有了契约，实际里面全是「请说明本项目……」这类祈使句。
 *     所以本脚本读项目的**真实事实**填充能填的部分（项目名、构建命令、发布状态、
 *     有无远端），并对脚本判断不了的部分留下带标记的待填写项，**明确报出还剩几处**。
 *     宁可交出一份标着「还有 3 处待填写」的文件，也不要交出一份看起来完整、实际空洞的。
 *
 * 用法：
 *   node scripts/compose-agents.mjs [目录]              生成或刷新
 *   node scripts/compose-agents.mjs [目录] --check      只校验，不写入
 *   node scripts/compose-agents.mjs [目录] --status     只报告现状（待填写项与缺节），不写入
 *   node scripts/compose-agents.mjs [目录] --budget N   指定预算字节数（默认 65536）
 *
 * 缺节判据只对**结构由脚本决定**的文件成立（见 survey.mjs 里 MANAGED / UPGRADED 两个
 * 常量的注释）：
 * 生成的文件缺节是缺陷，升级过的文件缺节是待办，作者自己编排的文件不判缺节。
 *
 * 模板标记（写在 templates/agents-project.md 里）：
 *   {{TOKEN}}                  由项目事实替换
 *   <!-- pf:if 条件 --> … <!-- pf:endif -->   按事实决定保留或丢弃，支持嵌套
 *   <!-- pf:author: 说明 -->    脚本填不了，留给作者；脚本会统计剩余数量
 *   <!-- pf:scaffold --> … <!-- pf:endscaffold -->  脚手架，待填写项归零后自动移除
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey, authorMarkers, isNoteKey } from './survey.mjs'
import { KERNEL_START, KERNEL_END, MANAGED, UPGRADED, KEEP, INSTRUCTION_BUDGET, COMMAND_KEY_SET as PROTOCOL_COMMAND_KEYS } from './lib/protocol.mjs'
import { normVersion, parseMarkerKeys, isMainModule, readTextFile } from './lib/text.mjs'
import { fencedSpans, markerPositions, scanLines } from './lib/markdown.mjs'
import { readLedger, writeLedger, recordSegment, forgetSegment } from './lib/ledger.mjs'
// 临时文件的形状与清理判据住在 lib/fs-atomic.mjs：那一族判据（哪些是本工具的残留、
// 哪些是使用者自己的文件、属主进程还活着没有）只此一份，本文件从那里取。
import { clearStaleTemps, tempPathFor, reportTemps } from './lib/fs-atomic.mjs'
import { HOST_ECOSYSTEMS } from './ecosystems.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const KERNEL_PATH = join(SKILL_ROOT, 'templates', 'agents-kernel.md')
const SKELETON_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

const START = KERNEL_START
const END = KERNEL_END
// MANAGED 与 UPGRADED 的定义与理由在 survey.mjs 里，与 KERNEL_START 同源：这几枚标记
// 都有三个消费方（注入、自检、交付门禁），各写一份时对不上不会有任何东西出声。
const DEFAULT_BUDGET = INSTRUCTION_BUDGET

function readUtf8(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/**
 * 读目标项目里的一个文本文件：**按内容嗅探编码**，与勘察同一套解码。
 *
 * 为什么不用 `readUtf8`：那份是「按 UTF-8 读、读不出来就当空」，而清单存成 UTF-16 的
 * 项目会被解成乱码、JSON 解析失败，于是被报成「清单损坏」——而勘察那边的内容扫描
 * 用的是会嗅探编码的那一套，同一个文件两个答案。现在两边都走 survey.mjs 的
 * `readTextFile`。
 *
 * 返回 { text, encoding } 或 undefined（读不出来）。`encoding` 为 `unknown` 表示
 * 既不是 UTF-8 也不是 UTF-16（多半是本地编码）——那与「JSON 语法错误」是两种事。
 */
function readProjectText(p) {
  const decoded = readTextFile(p)
  if (decoded === undefined) return undefined
  return { text: decoded.text.replace(/\r\n/g, '\n'), encoding: decoded.encoding }
}

/**
 * 严格读取：只接受能**无损**读出的 UTF-8。
 *
 * 为什么要严格：这个文件每次会话都会被注入，而它可能在中文 Windows 上被记事本或
 * PowerShell 的 `Out-File` 存成 UTF-16、或因别的工具变成 GBK。宽松地读（Node 默认
 * 用替换字符吞掉无法解码的字节）会**丢掉原始字节**，然后脚本把这份已经失真的文本
 * 写回去——文件被改成 NUL 交错的乱码，而 `--check` 还报「内核一致」。
 * 那是唯一一种不可恢复的损坏，所以宁可不写，也不能写坏。
 *
 * 顺带嗅探 BOM：UTF-16/32 的 BOM 是明确信号，能给出比「解码失败」更具体的提示。
 */
function readUtf8Strict(p) {
  const buf = readFileSync(p)
  if (buf.length >= 4) {
    const [a, b, c, d] = [buf[0], buf[1], buf[2], buf[3]]
    if ((a === 0xff && b === 0xfe && c === 0 && d === 0) || (a === 0 && b === 0 && c === 0xfe && d === 0xff)) {
      return { error: 'UTF-32（带 BOM）' }
    }
  }
  if (buf.length >= 2) {
    const [a, b] = [buf[0], buf[1]]
    if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) return { error: 'UTF-16（带 BOM）' }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    const nul = buf.reduce((n, x) => n + (x === 0 ? 1 : 0), 0)
    return {
      error: nul > 0
        ? `含 ${nul} 个 NUL 字节，看起来是 UTF-16（但缺 BOM）`
        : '不是合法的 UTF-8（可能是 GBK 等本地编码）',
    }
  }
  // BOM 要**从原始字节**判：TextDecoder 按规范会自己吃掉 UTF-8 的 BOM，
  // 解出来的文本里已经没有它了——拿文本去判，结论永远是「没有 BOM」。
  const hadBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return { text: text.replace(/^\uFEFF/, ''), hadBom }
}

/**
 * 判断文件处于什么状态。这是本脚本最关键的一次判断——四种状态的处理方式完全不同，
 * 把它们并成「有标记 / 没标记」两种，**受损的受管文件就会被当成手写文件**：
 *
 *   - 手写：正文里两个标记都没有 → 只体检，不动文件；
 *   - 受管：正文里**恰好**一对标记 → 按节刷新（附带两个偏移量，供后面切片用）；
 *   - 围栏内：正文里一对都没有，但文件里出现过——标记被当普通文本摆在代码块里，
 *     而真正那对已经不在。这种文件既不能刷新也不该读成手写：停下报错；
 *   - 受损：标记数量不对（只有一个、顺序反了、或不止一对）→ **停下报错**。
 *
 * 后两格是必须存在的：删掉一行 `kernel:end` 就会让 `includes` 判定失败，
 * 于是脚本把它当成手写文件，`--upgrade` 把内核**又插了一遍**——文件里出现两份
 * 内核，而 `--check` 只看第一对标记、`--status` 数不到缺节，两道门同时报绿。
 *
 * 计数只数**围栏外**的出现：文档里在代码块中展示这对标记是正常用法（本脚本的报错
 * 信息就是这么写的），算进去会把一份好文件判成受损。围栏状态机在 sync-toc.mjs，
 * 那边与目录工具共用同一份。
 */
function documentState(text) {
  const spans = fencedSpans(text)
  const starts = markerPositions(text, START, spans)
  const ends = markerPositions(text, END, spans)
  if (starts.length === 0 && ends.length === 0) {
    if (text.includes(START) || text.includes(END)) {
      return {
        kind: 'damaged',
        reason: '这一对内核标记全部落在代码围栏里，正文中找不到',
        hint: '把它们移到正文（围栏之外），或删掉围栏里这一对后重跑。',
      }
    }
    return { kind: 'handwritten' }
  }
  if (starts.length === 1 && ends.length === 1) {
    if (ends[0] < starts[0]) {
      return {
        kind: 'damaged',
        reason: '内核的结束标记出现在开始标记之前，顺序反了',
        hint: '把这一对标记调回正确顺序（开始在前、结束在后），各一个。',
      }
    }
    return { kind: 'managed', startAt: starts[0], endAt: ends[0] }
  }
  const parts = []
  if (starts.length !== 1) parts.push(`开始标记 ${starts.length} 个（应为 1）`)
  if (ends.length !== 1) parts.push(`结束标记 ${ends.length} 个（应为 1）`)
  return {
    kind: 'damaged',
    reason: parts.join('，'),
    hint: starts.length > 1 || ends.length > 1
      ? '常见成因：复制粘贴了整段内核，或合并冲突留下了重复内容。'
      : '常见成因：编辑器吞掉了一行、合并冲突只留了一半。',
  }
}

// ── 项目事实 → 模板条件与取值 ───────────────────────────────────────────────

/**
 * 能写进文档的**命令键**。**正向清单**：`has-commands` 与 `renderCommands` 都以它为准。
 *
 * 为什么是白名单而不是「排除掉几个已知的非命令键」：勘察用三种键表达「不是命令」——
 * `packageManager`（包管理器名）、`byEcosystem` / `multipleEcosystems`（结构信息）、
 * `note` / `<键>Note`（对某条命令的说明，例如「此命令按标准库推断」）。黑名单要靠
 * 一个个补：漏一个就把它算成命令，于是模板走 has-commands 分支、而渲染结果是空串，
 * 产出一段空的代码块，并且把「本项目尚未声明命令」的待办整条丢掉。
 *
 * 同一个键名叫 `note`（小写），所以「以 Note 结尾」这种写法按大小写敏感是筛不掉的。
 * 正向清单的另一个好处：勘察将来新增命令键时，这里不补就**不会**被当成命令——
 * 缺的是一条命令说明（报「没有可跑的命令」并给出待办），而不是一段空壳。
 */
// 标签是展示层的事（中文措辞只在这里），**键的清单不是**——它定义在 lib/protocol.mjs，
// 与勘察侧共用同一份。各写一份时改了这边那边不报错，症状是命令段静默消失。
const COMMAND_LABELS = [
  ['install', '安装依赖'],
  ['build', '构建'],
  ['typecheck', '类型检查'],
  ['lint', '静态检查'],
  ['test', '测试'],
  ['verify', '自检'],
  ['smoke', '冒烟'],
]
const COMMAND_KEYS = PROTOCOL_COMMAND_KEYS

/**
 * 声明了依赖的文件（清单之外的那些）。判据是「存在即认为有依赖」。
 *
 * 大小写一律**小写**：各生态的惯例写法不统一（`Cargo.toml` / `Gemfile` 首字母大写），
 * 而文件系统在 Linux 上大小写敏感、在 Windows 上不敏感——写成首字母大写的后果是
 * 「在 Windows 上测过没事、换个系统就不认」。真正的读取按**磁盘上的原名**走，见
 * rootIndex。
 */
const DEPENDENCY_FILES = [
  'requirements.txt', 'pipfile', 'pyproject.toml', 'setup.py',
  'cargo.toml', 'go.mod', 'gemfile', 'composer.json',
  'pubspec.yaml', 'mix.exs',
]

/**
 * 根目录文件名索引：**按小写匹配**，返回磁盘上的原名。
 *
 * 一次 readdir 供本文件所有清单判据共用，既避免大小写不一致，也避免每个判据各扫一次
 * 目录。找不到时返回 undefined，调用方据此走「没有这一项」的分支。
 */
function rootIndex(target) {
  let entries = []
  let readError
  try {
    entries = readdirSync(target)
  } catch (error) {
    // **读不到目录与「目录是空的」必须分开。**
    //
    // 合成一句「什么都没有」的后果不是少一个字段，而是整条判定链一起落空：生态认不出、
    // 清单判据全部不命中、命令导不出来，最后生成一份写着「这个项目没有依赖、没有命令、
    // 不可发布」的契约。而使用者读那份契约看不出任何异常——它长得跟一个真的空项目一样。
    //
    // 读不到就明确记下来，由调用方决定是停下还是提示。
    readError = error instanceof Error ? error.message : String(error)
  }
  const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]))
  return {
    has: (name) => byLower.has(name.toLowerCase()),
    real: (name) => byLower.get(name.toLowerCase()),
    readError,
    complete: readError === undefined,
  }
}

/**
 * 把勘察结果翻译成模板能用的条件与取值。
 *
 * 每个条件的判据都写在代码里而不是散在模板里：模板只声明「这段在什么条件下出现」，
 * 「什么时候满足这个条件」由这里统一决定。这样加一个新条件只需要改一处。
 *
 * **勘察结果由调用方传进来**（`s`）。它是一次全盘走查加若干 git 子进程，一次运行里
 * 反复重跑纯属浪费——实测一次 `--status` 会跑三遍，把 1.1 秒拖成 3.2 秒。默认参数
 * 只为「只想要事实、不在乎成本」的一次性调用保留。
 */
/**
 * 这个项目命中的那个宿主生态的描述符；没命中返回 undefined。
 *
 * 判据取勘察结果里已经算好的生态种类，不重新判定一次——两处各判一次就会各错一次。
 */
function hostDescriptorFor(s) {
  const kinds = s?.ecosystem?.kinds ?? []
  return HOST_ECOSYSTEMS.find((e) => kinds.includes(e.id))
}

function deriveFacts(target, s = survey(target)) {
  const index = rootIndex(target)
  // 目录读不到时**不许继续生成**：这条链的每一个判据都建立在「读得到目录」之上，
  // 读不到却照常往下走，产出的是一份看起来正常的错误契约。明确报错，留给人处理。
  if (index.complete === false) {
    throw new Error(`读不了目标目录 ${target}：${index.readError}。`
      + '据此生成的契约会把每一条都判成「没有」，那比不做更糟——先确认目录权限再重跑。')
  }
  const manifestPath = s.ecosystem.kinds.includes('node') ? 'package.json' : undefined
  const commands = s.commands ?? {}
  // 「有没有可跑的命令」按**命令键**判，不按「有没有一个字符串键」判。
  // 多生态时逐个生态桶看——扁平视图是它们的并集，看它等价，但按桶看更贴近事实。
  const buckets = commands.byEcosystem === undefined
    ? [commands]
    : Object.values(commands.byEcosystem)
  const hasCommands = buckets.some((b) => [...COMMAND_KEYS].some((k) => typeof b[k] === 'string'))

  // 可发布 = **有这个生态的可发布清单**且没被声明为私有。
  //
  // 判据是勘察读出的 `publishableManifest`——它按各生态的清单文件名逐个确认，不依赖
  // 「主生态是不是 node」。两种看起来更省事的判法都是错的，各自会丢掉一整类项目：
  //   一、要求「声明了发布范围（files 白名单）」才算可发布——而绝大多数包并不写该字段
  //       （靠默认规则决定发什么），于是它们被判成不可发布；
  //   二、只认 `package.json`——于是**所有非 JS 项目**（Python 的 pyproject.toml、Rust 的
  //       Cargo.toml、Go 的 go.mod）一律被判成不可发布，整块丢掉版本号语义、抬版本号判据、
  //       发版规则、角色判定，而能力矩阵明写「python / rust / go：发布视声明而定」。
  const publishableManifest = s.artifacts?.publishableManifest
  const publishable = publishableManifest !== undefined && s.artifacts?.private !== true

  // 有依赖 = 清单里声明了任意一类依赖，或其他生态的依赖声明文件存在
  let hasDeps = false
  // 清单**存在但解析不了**：这不是「没有依赖」，而是「读不到」。两者混成一个 false，
  // 后果是生成件里「依赖版本同步」那一节整块消失、而报告照样说「已生成」——AI 按
  // P4「两个数字归零 = 内容完整」收尾，交出去的东西少一节且无人知道。
  let manifestBroken = false
  // 读不出来时**为什么**要分清：内容读出来了但 JSON 语法错（该改 JSON），与内容压根
  // 读不出来——不是合法 UTF-8/UTF-16（该转存编码）。合成一句话会让使用者去改一个
  // 没坏的文件。
  let manifestBrokenWhy = ''
  if (manifestPath !== undefined) {
    // 依赖字段名各生态不同，这里按「清单里出现 dependency 字样的键」判断，
    // 避免把某个生态的字段名写死。
    const raw = readProjectText(join(target, manifestPath))
    if (raw === undefined) {
      manifestBroken = index.has(manifestPath)
      manifestBrokenWhy = manifestBroken ? 'unreadable' : ''
    } else if (raw.encoding === 'unknown') {
      manifestBroken = index.has(manifestPath)
      manifestBrokenWhy = 'encoding'
    } else {
      try {
        const pkg = JSON.parse(raw.text)
        hasDeps = Object.keys(pkg).some((k) => /dependenc/i.test(k) && (
          typeof pkg[k] === 'object' ? Object.keys(pkg[k]).length > 0 : false
        ))
      } catch {
        // 读不到就**不能**按无依赖处理：说一句，并让交付门禁看得见（见调用处）。
        manifestBroken = index.has(manifestPath)
        manifestBrokenWhy = manifestBroken ? 'syntax' : ''
      }
    }
  }
  if (!hasDeps) {
    hasDeps = DEPENDENCY_FILES.some((f) => index.has(f))
  }

  const hasGit = s.git?.present === true
  // 非仓库根时远端/分支/提交数全属外层仓库（survey 已标 note），此处必须丢弃——
  // 否则会生成“本地+远端/角色判定/发版规则”，与 SKILL 能力矩阵 isRepoRoot 优先行矛盾，
  // 实测后果是往毫不相干的仓库推。判据与 survey.mjs 的 samePath 三层放宽同源。
  const isRepoRoot = s.git?.isRepoRoot !== false
  const hasRemote = typeof s.git?.remote === 'string' && s.git.remote.length > 0 && isRepoRoot

  // 「有没有版本号」决定发版规则怎么写：有版本号时标签名要对齐它，没有时命名自定。
  // 这两个分支必须都在——只写「标签名必须与版本号一致」会让没有版本号的项目无从下手，
  // 而没有版本号的项目并不少见（不发布制品的工具、纯文档项目、以及 skill 本身）。
  const hasVersion = typeof s.artifacts?.declaredVersion === 'string'
    && s.artifacts.declaredVersion.trim() !== ''

  // 「说明文档是不是多语言的」决定要不要把成对维护规则写进契约。
  //
  // 规则写在 `references/` 里只对「读过那份文件的人」有效，而契约是**以后每一次会话**
  // 都会读到的东西——成对维护这类要求必须落在那里，否则一个双语文档的项目改了中文、
  // 英文版就停在原处，而它的契约里一个字都没提要一起改。
  const hasBilingualReadme = s.docs?.readmePair !== undefined

  // 插件类条件：只按勘察事实求值，不猜具体取值。模板里的 DSH 段落靠它们显隐，
  // 非插件项目不受影响；读不到即按无处理。
  const isDshPlugin = s.ecosystem.kinds.includes('dsh-plugin')
  const isGo = s.ecosystem.kinds.includes('go')
  const isPlugin = s.ecosystem.kinds.some((k) => /plugin|extension/.test(k))
  const hasDshClient = s.dsh?.hasClientEntry === true || s.dsh?.hasClientDecl === true
  const hasDshBundle = s.dsh?.bundlePatch !== undefined || s.dsh?.patchFile !== undefined
  const hasDshToolchain = s.dsh?.toolchain !== undefined
    && (s.dsh.toolchain.tsdown === true || s.dsh.toolchain.vitest === true || s.dsh.toolchain.oxlint === true)
  const hasDshLocalWorkflow = s.dsh?.localWorkflow === true || s.dsh?.contractDoc === true
  // 「版本与可复现」这一节恒属于 DSH 插件：版本面（peer 版本、补丁层）是宿主契约的一部分，
  // 不是「有没有读到某个文件」决定的。
  //
  // 判据特意**不**挂在 `hasDshBundle || hasDshClient` 上：那两个字段为假有两种完全相反的
  // 含义——「没声明补丁层」和「声明了、但补丁文件不在」。后者恰恰是最需要这一节的破损插件；
  // 而按「文件在不在」来决定这一节适不适用，等于把「该报警」变成「静默省略」。判据的
  // 性质不对，方向也是错的：省掉一节短文换不回什么，弄丢一次报警赔得上。
  const hasDshVersion = isDshPlugin
  const hasLocalSkills = Array.isArray(s.localSkills) && s.localSkills.length > 0
  // 「宿主不会加载」是**单独一节**，不并进上面的盘点节：盘点节说「有什么」，这一节说
  // 「哪几条是坏的、为什么坏」。两件事的读者动作不同——盘点节要求只读不改，这一节要求
  // 先修好再继续，而它的症状（目录在、技能不在）与「压根没装」无法从目录列表上看出来。
  const hasDroppedSkills = Array.isArray(s.localSkills)
    && s.localSkills.some((x) => x.dropped !== undefined || x.corrupt === true)
    || s.ecosystem.skillDropped !== undefined

  // 条件名**显式成对声明**，不靠「自动加前缀取反」推导。
  // 推导出来的名字（例如把 has-git 取反成 no-has-git）看着能跑，实则一改规则就静默
  // 产出错名字；而模板里的未知条件会直接报错，等于把错误推迟到运行时。
  // 模板里用到哪个名字，这里就必须有哪个名字——这样「模板要什么」与「脚本给什么」
  // 是同一份清单，漏了立刻报错。
  const conditions = {
    'has-git': hasGit,
    'no-git': !hasGit,
    'has-remote': hasRemote,
    'no-remote': !hasRemote,
    'has-commands': hasCommands,
    'no-commands': !hasCommands,
    'has-version': hasVersion,
    'no-version': !hasVersion,
    'has-bilingual-readme': hasBilingualReadme,
    'no-bilingual-readme': !hasBilingualReadme,
    'has-deps': hasDeps,
    'no-deps': !hasDeps,
    'is-dsh-plugin': isDshPlugin,
    'is-go': isGo,
    'is-plugin': isPlugin,
    'no-plugin': !isPlugin,
    'has-dsh-client': hasDshClient,
    'has-dsh-bundle': hasDshBundle,
    'has-dsh-toolchain': hasDshToolchain,
    'no-dsh-toolchain': !hasDshToolchain,
    'has-dsh-version': hasDshVersion,
    'no-dsh-version': !hasDshVersion,
    'has-dsh-local-workflow': hasDshLocalWorkflow,
    'no-dsh-local-workflow': !hasDshLocalWorkflow,
    'has-local-skills': hasLocalSkills,
    'no-local-skills': !hasLocalSkills,
    'has-dropped-skills': hasDroppedSkills,
    'no-dropped-skills': !hasDroppedSkills,
    'has-publish': publishable,
    'no-publish': !publishable,
  }

  // 项目名优先取**项目自己声明的**名字（各生态清单里的 name），没有才退回目录名。
  // 目录名常常是临时起的（demo、new-project），而清单里的名字才是项目身份。
  // 判据挂在清单文件上，不挂在主生态上——非 JS 项目同样有正式名字。
  // 标题里只留包名那一段：npm 的作用域前缀与 Composer 的 vendor 前缀去掉后读起来一样
  // （npm 的那个由下面的通用替换去掉，Composer 的由它自己的读取器去掉），而带上前缀的
  // `vendor/pkg` 在一级标题里既不是包名也不是目录名。
  let projectName = s.target.name
  // 文件名一律**小写**，由 index 解析成磁盘上的原名再读——见 DEPENDENCY_FILES 上面的理由。
  // 读不到的生态不是「没有名字」，而是这个读取器不认识它的格式，那就退到目录名。
  const nameReaders = [
    [manifestPath, (pkg) => pkg.name],
    ['pyproject.toml', (text) => /^name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]],
    ['cargo.toml', (text) => /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]],
    ['go.mod', (text) => /^module\s+(\S+)/m.exec(text)?.[1]?.split('/').pop()],
    ['composer.json', (text) => /"name"\s*:\s*"([^"]+)"/.exec(text)?.[1]?.split('/').pop()],
    ['pubspec.yaml', (text) => /^name:\s*["']?([^"'\n#]+?)["']?\s*$/m.exec(text)?.[1]],
    ['mix.exs', (text) => /^\s*app:\s*:(\w+)/m.exec(text)?.[1]],
  ]
  for (const [file, pick] of nameReaders) {
    if (file === undefined || projectName !== s.target.name) continue
    const real = index.real(file)
    if (real === undefined) continue
    try {
      const decoded = readProjectText(join(target, real))
      if (decoded === undefined) continue
      const hit = file === manifestPath ? pick(JSON.parse(decoded.text)) : pick(decoded.text)
      if (typeof hit === 'string' && hit.trim().length > 0) {
        projectName = hit.trim().replace(/^@[^/]+\//, '') // 去掉作用域前缀，标题里更好读
      }
    } catch { /* 解析失败就试下一个，最终用目录名 */ }
  }

  const tokens = {
    PROJECT_NAME: projectName,
    COMMANDS: renderCommands(commands),
  }

  // 专属模板段落：段落正文住在生态描述符里，这里只把「命中那个生态」的那份取出来。
  // 没命中任何生态时是空对象，模板里的 pf:include 随之整段不出现。
  const hostDesc = hostDescriptorFor(s)
  // 空对象表示「这个项目不属于任何已登记生态」，模板里的 pf:include 应当整段不出现；
  // 而「命中了生态但那段没登记」才是缺陷，由 hostId 的有无来区分这两种情况。
  const includes = hostDesc?.includes ?? {}
  const hostId = hostDesc?.id
  return { survey: s, conditions, tokens, manifestBroken, manifestBrokenWhy, manifestPath, includes, hostId }
}

/**
 * 在锚点（内核开始标记）**之前**插入一行标记，用来找回「这份文件的结构由谁决定」。
 *
 * 为什么不能靠「前面正好有一个空行」那种字符串替换：那是骨架里的一处排版细节，改一次
 * 排版（少一个空行、把内核段挪到别处）替换就静默落空，标记没写进文件——而
 * documentStructure 会因此把一份生成的文件读成「作者编排」，`applicableMissingSections`
 * 随之返回**不适用**，整道缺节检查就此对这份文件永久关闭，且没有任何提示。
 * 那种状态下删掉一整个「硬性规范」节，`--check` 照样报「内核一致」。
 *
 * 所以这里**按偏移插入并断言结果**：宁可不写，也不产出一份门禁已关的文件。
 */
function attachMarker(text, marker, anchor) {
  const at = markerPositions(text, anchor)[0]
  if (at === undefined) {
    throw new Error(`注入内核之后找不到 ${anchor}，无法写入 ${marker}。`)
  }
  const next = `${text.slice(0, at)}${marker}\n\n${text.slice(at)}`
  if (!next.includes(marker)) {
    throw new Error(`没能把 ${marker} 写进文件——不写，以免产出一份结构标记缺失的文件。`)
  }
  return next
}

/**
 * 把推导出的命令渲染成可直接粘进文档的 shell 块。
 *
 * 多生态项目**按生态分组渲染**，不做扁平化：扁平视图里同名字段只会留下一个生态的值
 * （后算的覆盖先算的），写进文档就是把一条属于别的生态的命令当成这个项目的命令。
 * 这种错误很难被发现——命令看起来完全正常，只是跑的不是这个项目。
 *
 * 勘察用 `note` 表达「这个生态的命令推导还没做」（例如 Java / .NET / Ruby 这类），
 * 它必须**渲染成注释行**：丢掉它就只剩一个空的代码块，读者看到的是「本项目什么命令
 * 都没有」而不是「脚本还没算出来」。同理，`COMMAND_LABELS` 之外的新命令键也要落到
 * 文档里——静默丢弃一个真实存在的命令，比显示出来难看得多。
 */
function renderCommands(commands) {
  const STRUCTURAL_KEYS = new Set(['packageManager', 'byEcosystem', 'multipleEcosystems'])
  const renderOne = (cmds) => {
    const lines = []
    const used = new Set()
    for (const [key, label] of COMMAND_LABELS) {
      const command = cmds[key]
      if (typeof command !== 'string') continue
      used.add(key)
      lines.push(`# ${label}`)
      lines.push(command)
      // 命令带「推断说明」时紧跟其后写明，别让读者以为它是项目自己声明的。
      const noteKey = `${key}Note`
      const note = cmds[noteKey]
      if (typeof note === 'string') { used.add(noteKey); lines.push(`# （${note}）`) }
    }
    for (const [k, v] of Object.entries(cmds)) {
      if (used.has(k) || STRUCTURAL_KEYS.has(k) || typeof v !== 'string') continue
      if (isNoteKey(k)) { lines.push(`# ${v}`); continue }
      lines.push(`# ${k}`, v)
    }
    return lines
  }

  if (commands.byEcosystem === undefined) return renderOne(commands).join('\n')

  const parts = []
  for (const kind of commands.multipleEcosystems ?? Object.keys(commands.byEcosystem)) {
    const lines = renderOne(commands.byEcosystem[kind])
    if (lines.length === 0) continue
    parts.push(`# ${kind}`)
    parts.push(...lines)
  }
  return parts.join('\n')
}

// ── 模板求值 ────────────────────────────────────────────────────────────────

/**
 * 按条件求值模板，替换取值，并统计待填写项。
 *
 * 用栈处理条件块，因此支持嵌套。**未知条件直接报错**而不静默丢弃——静默丢弃会让一段
 * 内容凭空消失，而且没人会发现。
 */
function materialize(template, facts) {
  const TOKEN_RE = /\{\{([^{}]*)\}\}/g
  const MARK_RE = /<!--\s*pf:(if\s+[^\s>]+|endif|scaffold|endscaffold|include\s+[A-Za-z0-9_-]+|author\s*(?::[\s\S]*?)?)\s*-->/g

  const out = []
  const stack = [] // { kind: 'if'|'scaffold', active: boolean }
  const unknownConditions = []
  const unknownTokens = new Set()
  const unknownIncludes = new Set()
  let cursor = 0

  const active = () => stack.every((f) => f.active)

  const emit = (text) => {
    if (!active()) return
    out.push(text.replace(TOKEN_RE, (whole, name) => {
      // 只有「全大写字母数字下划线」才算合法取值名。其余形状（小写、驼峰、含空格、
      // 空名）一律当错误报出来：它们看着像占位符却不会被替换，会原样发到成品里，
      // 而那种字符串看起来只是普通文本，没人会去核对。
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) { unknownTokens.add(whole); return whole }
      if (!(name in facts.tokens)) { unknownTokens.add(whole); return whole }
      return facts.tokens[name]
    }))
  }

  let m
  MARK_RE.lastIndex = 0
  while ((m = MARK_RE.exec(template)) !== null) {
    emit(template.slice(cursor, m.index))
    cursor = m.index + m[0].length
    const body = m[1]

    if (body.startsWith('if ')) {
      const name = body.slice(3).trim()
      if (!(name in facts.conditions)) {
        unknownConditions.push(name)
        stack.push({ kind: 'if', active: false })
      } else {
        stack.push({ kind: 'if', active: facts.conditions[name] === true })
      }
      continue
    }
    if (body === 'endif') {
      if (stack.length === 0) throw new Error('模板里的 pf:endif 没有对应的 pf:if。')
      const frame = stack[stack.length - 1]
      if (frame.kind !== 'if') {
        throw new Error('pf:endif 与最近打开的 pf:scaffold 不匹配——'
          + '用 pf:endscaffold 收尾脚手架，写反了会让那段内容永远删不掉。')
      }
      stack.pop()
      continue
    }
    if (body === 'scaffold') {
      // 脚手架标记必须**保留在产出里**：它要靠 stripScaffold 在「待填写项归零」的那次
      // 运行中把整段移除。若在这里丢掉标记，产出里只剩一段没人认领的注释，永远删不掉。
      stack.push({ kind: 'scaffold', active: true })
      if (active()) out.push(m[0])
      continue
    }
    if (body === 'endscaffold') {
      if (stack.length === 0) throw new Error('模板里的 pf:endscaffold 没有对应的 pf:scaffold。')
      const frame = stack[stack.length - 1]
      if (frame.kind !== 'scaffold') throw new Error('pf:endscaffold 与最近打开的 pf:if 不匹配。')
      stack.pop()
      // 同上：标记本身要留下。注意 emit 用的是弹出后的栈状态，所以先弹再写。
      if (active()) out.push(m[0])
      continue
    }
    // pf:include：把某个生态的专属段落取进来。
    //
    // 段落正文住在描述符里（scripts/ecosystems.mjs），不写在通用模板里——
    // 那样每加一个宿主都要改模板，而改漏的症状是「该有的段落没出现」，没人报错。
    // 本指令只认「当前项目命中的那个生态」，没命中就整段不出现。
    if (body.startsWith('include ')) {
      const slot = body.slice(8).trim()
      if (active()) {
        const snippet = facts.includes?.[slot]
        // 取进来的段落**本身也是模板**：里面有 pf:if / pf:author。
        // 直接 push 原文，那些指令会以注释形式留在产出里，条件也就失效了——
        // 症状是「按事实取舍」变成「一股脑全出现」。所以递归过一次。
        if (typeof snippet === 'string' && snippet !== '') out.push(materialize(snippet, facts))
        // 只有「命中生态却没登记这段」才算缺陷；没命中生态时整段本就该不出现。
        else if (facts.hostId !== undefined) unknownIncludes.add(slot)
      }
      continue
    }
    if (active()) out.push(m[0])
  }
  emit(template.slice(cursor))

  if (stack.length > 0) throw new Error('模板里有未闭合的 pf:if 或 pf:scaffold。')
  // 未登记的 include 槽位必须报错：它意味着模板要一段没人提供的正文。
  // 静默跳过时产出照常生成、门禁全绿，只是**该有的段落不见了**——
  // 那是最难发现的一种缺失。
  if (unknownIncludes.size > 0) {
    throw new Error(`模板要求了未登记的专属段落：${[...unknownIncludes].join('、')}。`
      + '请在 scripts/ecosystems.mjs 对应生态的 includes 里补上它，或删掉模板里的这一行。')
  }
  if (unknownConditions.length > 0) {
    throw new Error(`模板使用了未知条件：${[...new Set(unknownConditions)].join('、')}。`
      + '请在 compose-agents.mjs 的 deriveFacts() 里定义它，不要让它静默丢弃内容。')
  }
  if (unknownTokens.size > 0) {
    throw new Error(`模板里出现了无法替换的取值：${[...unknownTokens].join('、')}。`
      + '合法取值名只能是全大写字母、数字与下划线，且必须在 deriveFacts() 的 tokens 里'
      + '定义；否则它会原样留在成品里。')
  }

  // 条件段落被丢弃后会留下成串空行（一个条件块前后各有一行）。不清理的话，产出里
  // 到处是三四行空白，看起来像排版事故，读的人会以为内容丢了。
  return collapseBlankLines(out.join(''))
}

/**
 * 统计待填写项（含所在小节）。**判定只有一处实现**：survey 的 authorMarkers。
 *
 * 为什么不能各写一份：标记可以写成两行（`<!-- pf:author:` 换行后 `-->`），逐行扫的
 * 实现一个都数不到，于是脚本报「内容完整」并顺手删掉脚手架，而那几处 TODO 还在正文里；
 * 同一份文件因此能得出两个结论。compose 与 review 都引用 survey 里那一份，分歧无从产生。
 */
const findAuthors = authorMarkers

/** 待填写项归零后，脚手架段落自动移除。 */
function stripScaffold(text, authorCount) {
  if (authorCount > 0) return text
  return text.replace(/<!--\s*pf:scaffold\s*-->[\s\S]*?<!--\s*pf:endscaffold\s*-->\n?/g, '')
}

/**
 * 折叠被丢弃的条件段落留下的成串空行。**只对脚本自己刚生成的内容用**。
 *
 * 它的作用域必须受限：条件段落被丢掉后会在原地留下成串空行，那要收拾；但同一条
 * 规则若套在**人写的段落**上，就是在替作者改排版——作者故意留的三行空行会被悄悄
 * 收成两行，而报告同时在打「保留原样的节（人写的内容不动）」。两句话互相打脸，
 * 比排版不整齐糟得多。调用点用 collapseJoined 表达这个区别。
 */
function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n')
}

/**
 * 拼「本次重新求值的部分」+「沿用的人写部分」，**只收拾前者**。
 *
 * `sep` 是块与块之间的分隔符，由调用点定：刷新路径里每节自带结尾的空行（那是原文里
 * 本来就有的一行），用单换行接；升级路径补进去的是整节、自身不带结尾空行，要用
 * 空行接。
 */
function collapseJoined(parts, sep = '\n') {
  return parts.map((p) => p.fresh ? collapseBlankLines(p.text) : p.text).join(sep)
}

/** 按主导行尾定行尾：CRLF 多于 LF 用 CRLF，否则 LF。混合时取多数那一侧。 */
function dominantEol(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

/** 把文本按二级标题切成「前言 + 各节」，用于按节合并。 */
function splitSections(text) {
  const lines = text.split('\n')
  const head = []
  const sections = []
  let current = undefined
  for (const line of lines) {
    const isH2 = /^##\s+\S/.test(line)
    if (isH2) {
      if (current !== undefined) sections.push(current)
      current = { heading: line.trim(), lines: [line] }
      continue
    }
    if (current === undefined) head.push(line)
    else current.lines.push(line)
  }
  if (current !== undefined) sections.push(current)
  return { head: head.join('\n'), sections }
}

/**
 * 把内核区整段摘出来，换成一行占位。
 *
 * 必须这么做：**内核自己就含有二级标题**（行事总纲、本文件的定位与编辑规则）。若不摘除就按二级标题切分，内核里的每一节都会被当成普通节参与合并——它们
 * 在「新求值的结果」里不存在（那时内核是空的），于是每次刷新都被当作「用户自己加的节」
 * 追加一遍。文件于是每跑一次就膨胀一份内核。
 *
 * 位置从 `documentState` 传来（**围栏外**那一对），不从 `indexOf` 找：文档里在代码块
 * 中展示这对标记是正常用法，`indexOf` 会找到展示用的那一份，把整段内核当代码块内容摘掉。
 */
function extractKernel(text, startAt, endAt) {
  if (startAt < 0 || endAt < 0) return { body: text, hadKernel: false }
  const placeholder = '<!-- project-forge:kernel-placeholder -->'
  const body = text.slice(0, startAt + START.length) + '\n' + placeholder + '\n'
    + text.slice(endAt)
  return { body, hadKernel: true }
}

/**
 * 现有节里多出来的行：模板重新求值后不再包含的那些行。
 *
 * 判据是**逐行比对**，不是「整节是否相同」：条件段落整块出现或整块消失时，整节比对
 * 会把整节都算成「多出来的」，而那些行只是上一轮求值的结果、这一轮该消失。
 * 逐行看，两种情况才分得开——分不开时报出来的就是一句噪声，而噪声报多了等于没报。
 *
 * 返回的是**行**，不是「是不是你自己写的」：脚本分不出使用者写的字与模板上一轮的
 * 产物。报告里说的是「这一节里现有的这些行不在新结果里」，那一句是真的。
 */
function extraLines(oldText, freshText) {
  const fresh = new Set(freshText.split('\n').map((l) => l.trim()).filter((l) => l !== ''))
  return oldText.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !fresh.has(l))
}

/**
 * 按当前事实重新求值模板，再与既有文件**按节合并**。
 *
 * 合并判据只有一条，而且判据来自**新求值的结果**：
 *   - 新结果里这一节带 `pf:author`（模板说「这里要人写」）→ 保留既有内容，人写的或
 *     已经填好的不能被冲掉；
 *   - 新结果里这一节不带 `pf:author`（纯生成内容）→ 采用新结果，让条件段落能随事实
 *     变化而增删。
 *
 * 反过来判断（看旧文件有没有 author 标记）是错的：纯生成的小节本来就没有 author 标记，
 * 会被误判成「人已填写」，于是**永远冻结**——「有远端才有」的那几段就再也补不进来。
 */
function refreshFromTemplate(target, existing, kernel, state, s = survey(target)) {
  const facts = deriveFacts(target, s)
  const rendered = materialize(readUtf8(SKELETON_PATH), facts)

  const oldBody = extractKernel(existing, state.startAt, state.endAt).body
  const freshState = documentState(rendered)
  const freshBody = extractKernel(rendered, freshState.startAt, freshState.endAt).body
  const fresh = splitSections(freshBody)
  const old = splitSections(oldBody)

  const oldByHeading = new Map()
  for (const section of old.sections) {
    if (!oldByHeading.has(section.heading)) oldByHeading.set(section.heading, section)
  }
  const freshByHeading = new Map()
  for (const section of fresh.sections) {
    if (!freshByHeading.has(section.heading)) freshByHeading.set(section.heading, section)
  }

  const kept = []
  const missing = []
  const refreshed = []

  // 按**既有文件的顺序**遍历，不按模板顺序。
  //
  // 两个理由：一是重排一个已经写好的文档会让人以为内容被动过（实测本 skill 自己的
  // AGENTS.md 就因为顺序不同被整体重排）；二是模板的顺序是给人「第一次怎么写」用的，
  // 一旦文件已经存在，作者摆放它的方式就是权威。
  const merged = []
  for (const section of old.sections) {
    const body = section.lines.join('\n')
    const freshSection = freshByHeading.get(section.heading)

    // 判据的**第一优先**是「这段字节是谁写的」，不是「标题在不在模板里」。
    //
    // `pf:keep` 由 `--upgrade` 打在它保留下来的每一节上，含义是「这些内容归使用者」。
    // 它优先于下面所有判据：即使模板里有同名节、即使模板那一节不带 pf:author，也不覆盖。
    //
    // 没有这一条时，用户手写的「版本管理（必守）」「构建与验证」这类**人人都会这么起名**
    // 的节，在升级后的强制刷新里会被整节替换——实测一句「发版由 release manager 手工
    // 执行」就是这样消失的，而且事后没有任何痕迹。
    if (body.includes(KEEP)) {
      kept.push(section.heading)
      merged.push({ text: body, fresh: false })
      continue
    }

    if (freshSection === undefined) {
      // 模板里已经没有这个标题：原样保留。可能是作者自己加的，也可能是作者刻意换了一种
      // 组织方式（本 skill 自己的「版本管理流程」就是如此）。脚本不删。
      kept.push(section.heading)
      merged.push({ text: body, fresh: false })
      continue
    }
    const freshText = freshSection.lines.join('\n')
    if (findAuthors(freshText).length > 0) {
      // 模板说这一节要人来写：保留既有内容，别把人写的冲掉
      kept.push(section.heading)
      merged.push({ text: body, fresh: false })
    } else {
      // 纯生成内容：用新求值的结果，让条件段落能随事实增删。
      //
      // **覆盖行为不变**（它就是设计要的：否则「有远端才有」的内容永远补不进来），
      // 变的是**告知**：这一节里现有的、模板重新求值后不再有的那些行，本次会被替换掉。
      // 不说的话，报告只说「按当前项目事实重新求值」，读的人以为只有条件段落在动，
      // 而他自己在这一节里补的说明已经没了。
      //
      // 报告里把那几行**原文打出来**，不只给个数：只给数量时，读的人无法判断被换掉的
      // 是不是要紧的东西，也就无从拦截。
      refreshed.push({ heading: section.heading, extra: extraLines(body, freshText) })
      merged.push({ text: freshText, fresh: true })
    }
  }
  // 模板里有、文件里没有的节：**不自动添加**，只报告。
  //
  // 这条限制是必要的：本 skill 自己的 AGENTS.md 就是手写的，它与模板共享若干标题
  // （环境与上下文、构建与验证……）。若刷新时把模板的每个节都补进去，手写文档会被灌进
  // 一整套通用样板——实测会多出一个与手写版本节并列的「版本管理（必守）」，两份内容
  // 互相打架。而条件段落照样能随事实变化：它们绝大多数是**已有节内部的子节**（例如
  // 「发版规则」是版本管理节里的三级标题），在上一段里正常求值。
  const oldHeadings = new Set(old.sections.map((s) => s.heading))
  for (const section of fresh.sections) {
    if (!oldHeadings.has(section.heading)) missing.push(section.heading)
  }

  // 前言（标题与效力声明）也保留既有的：它常写着这个项目特有的完成标准，是作者写的，
  // 不该被模板里那句通用表述换掉。
  const head = old.head.trim().length > 0 ? old.head : fresh.head
  const parts = [{ text: head, fresh: old.head.trim().length === 0 }, ...merged]

  let text = collapseJoined(parts)
  text = injectKernel(text, kernel)
  const authors = findAuthors(text)
  text = stripScaffold(text, authors.length)

  const report = { kept, refreshed, missing, authors: authors.length }
  // facts 一并带出去：报告要用它说清「清单读不出来」这类事（那与本次刷新无关，
  // 但契约里少了一节，使用者必须知道）。
  return { text, report, facts }
}

function kernelBody() {
  if (!existsSync(KERNEL_PATH)) throw new Error(`找不到内核模板：${KERNEL_PATH}`)
  return readUtf8(KERNEL_PATH)
    .replaceAll(START, '').replaceAll(END, '')
    .replace(/^\n+/, '').replace(/\n+$/, '')
}

/**
 * 用内核替换标记之间的内容。标记缺失即报错——绝不猜测该插到哪里。
 *
 * 位置**按围栏外那一对**取，不用 `indexOf`：文档里在代码块中展示这对标记是正常用法
 * （本脚本的报错信息就是这么写的），`indexOf` 会命中展示用的那一份，把整段内核注入
 * 到代码围栏内部。带两对以上的情况不在这里处理——`documentState` 已经先一步报错退出，
 * 所以本函数只需要处理「恰好一对」这一种。
 */
function injectKernel(text, kernel) {
  const spans = fencedSpans(text)
  const starts = markerPositions(text, START, spans)
  const ends = markerPositions(text, END, spans)
  if (starts.length !== 1 || ends.length !== 1) {
    throw new Error(
      `AGENTS.md 里找不到一对完整的内核标记（找到开始 ${starts.length} 个、结束 ${ends.length} 个）。`
      + `请先放入这一对标记，再执行注入：\n  ${START}\n  ${END}`,
    )
  }
  if (ends[0] < starts[0]) throw new Error('内核标记顺序颠倒：end 出现在 start 之前。')
  const before = text.slice(0, starts[0] + START.length)
  const after = text.slice(ends[0])
  return `${before}\n${kernel}\n${after}`
}

/**
 * 文件里现有的内核区间（两个标记之间的正文）：按 LF 归一化，并去掉紧贴标记的那一个换行。
 *
 * 返回 undefined 表示这份文件没有一对完整的内核标记。
 *
 * **判据只有这一处**：`--check` 报的「内核不一致」与写入路径的「会被覆盖」提醒必须
 * 同源——两处各判一次，改了一处就会出现「自检说一致、写入却覆盖」。
 */
function embeddedKernel(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  const state = documentState(normalized)
  if (state.kind !== 'managed') return undefined
  return normalized.slice(state.startAt + START.length, state.endAt)
    .replace(/^\n/, '').replace(/\n$/, '')
}

/**
 * 给一个**手写的、没有内核标记的** AGENTS.md 做增量升级。
 *
 * 这是「项目已经有了 AGENTS.md，但写得不好或漏了很多」这一常见场景的入口。它必须做到
 * 三件事，缺一件就不合格：
 *   1. **不报错退出**——缺内核标记是最常见的场景，直接抛错会把它变成死路；
 *   2. **不破坏已有内容**——手写的段落一律保留，包括它自己那套标题体系；
 *   3. **只做加法，并把加了什么说清楚**——插入内核、补上缺失的节，然后逐条报告。
 *
 * 内核插在一级标题之后、第一个二级标题之前。这是唯一不需要猜测的位置：文件标题是
 * 每个 AGENTS.md 都有的，而内核属于「总纲」性质，放在正文之前符合它被阅读的顺序。
 */
function upgradeHandwritten(existing, kernel, target, s = survey(target)) {
  const fresh = splitSections(materialize(readUtf8(SKELETON_PATH), deriveFacts(target, s)))
  const old = splitSections(existing)

  // 行尾先定下来：插入的内容按**原文件的主导行尾**排。
  // 不定的话，CRLF 的手写文件会被插进一段 LF 的内核与新增节，得到一个**混合行尾**的
  // 文件——那正是刷新路径花了力气要避免的状态（见 main 里的行尾归一化），两条路径
  // 不该产出两种行尾状态。为「只做加法」而把原有行尾也统一，不算改内容：文字一字
  // 未动，只是把本来就属于同一行的 `\r\n` 还原成它自己该有的样子。
  const eol = dominantEol(existing)
  const lines = existing.replace(/\r\n/g, '\n').split('\n')

  // 1) 插入内核：一级标题之后、第一个二级标题之前。
  //
  // 同时打上 UPGRADED 标记：升级只做加法，需要人写的节一个都没补，所以这份文件此后
  // 必然还缺若干节——那是**待办**，不是缺陷。标记记在文件里，判据才有依据（见该常量注释）。
  // 已经打上过的**不再打第二份**：用户手工删掉内核标记、留下这个标记来修文件是合理
  // 的做法，重复的标记会让「它升级过几次」变成读文件才能回答的问题。
  let insertAt = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i])) { insertAt = i; break }
  }
  if (insertAt < 0) insertAt = lines.length // 通篇没有二级标题：追加到末尾
  const inserted = []
  if (!lines.includes(UPGRADED)) inserted.push(UPGRADED, '')
  inserted.push(START, kernel, END, '')
  const withKernel = [
    ...lines.slice(0, insertAt),
    ...inserted,
    ...lines.slice(insertAt),
  ].join(eol)

  // 2) 补上缺失的节：只补「语义上明显缺」的整节，且一律追加在末尾，不改动原有顺序。
  const oldHeadings = new Set(old.sections.map((s) => s.heading))
  const added = []
  const parts = [{ text: withKernel.replace(/(?:\r?\n)+$/, ''), fresh: false }]
  for (const section of fresh.sections) {
    if (oldHeadings.has(section.heading)) continue
    // 纯生成内容才补：需要人写的节补进去也是一堆占位符，不如让 AI 按上下文写
    const body = section.lines.join('\n')
    if (findAuthors(body).length > 0) continue
    parts.push({ text: collapseBlankLines(body), fresh: true })
    added.push(section.heading)
  }

  let text = collapseJoined(parts, '\n\n')
  if (!text.endsWith(eol)) text += eol
  // 3) 给**升级前就存在的**那些节打上「内容归使用者」的标记。
  //
  // 只打原有的那几节，不打脚本刚补进来的——这一点是承重的：
  // 补进来的节是生成内容，建好远端之后它们**必须**能被强制回刷补上新段落。
  // 如果给它们也打上标记，`docs-set.md` 里标着「这不是可选项」的那次回刷会静默变成
  // 「无需改动」，用户拿到的契约里就永远没有发布那半部分。
  //
  // 而原有的节必须打：没有标记时，下一次刷新会按「节标题在模板里」把撞名的节整节替换，
  // 而节标题是人和模板都会用的公共词汇（「构建与验证」「版本管理」几乎人人这么起名）。
  //
  // 这一步不改动任何字节的正文，只在节标题下面插一行注释。
  text = markKeptSections(text, new Set(old.sections.map((s) => s.heading)))
  return { text, added }
}

/**
 * 给**指定标题的那些节**打上 `pf:keep`，跳过内核区（那段由内核模板独占）。
 *
 * `headings` 是这次要认领的节。传空集就一个都不打——调用方必须明确说出
 * 「这些节的内容归使用者」，而不是让函数替它猜。
 *
 * 幂等：已经有标记的节不重复打。围栏代码块里的 `## ...` 不算节——它是示例，
 * 在它前面插标记会破坏代码块。
 */
function markKeptSections(text, headings) {
  if (headings.size === 0) return text
  const normalized = text.replace(/\r\n/g, '\n')
  // 围栏状态**只从权威实现取**（survey.mjs 的 scanLines）。
  //
  // 这里曾手写过一个循环，它只比围栏符的首字符、不校验闭合行是否不短于起始行，
  // 于是「三个反引号开头、五行反引号结尾」这种写法在两处的判定不同。而围栏判错的后果
  // 很具体：把代码块里的 `## 示例` 当成真节，在它前面插一行 `pf:keep`，破坏代码块。
  const scanned = scanLines(normalized)
  const out = []
  let inKernel = false

  for (let i = 0; i < scanned.length; i += 1) {
    const info = scanned[i]
    const line = info.line
    if (line.includes(KERNEL_START)) inKernel = true

    out.push(line)
    if (info.inFence) {
      if (line.includes(KERNEL_END)) inKernel = false
      continue
    }
    if (inKernel) {
      if (line.includes(KERNEL_END)) inKernel = false
      continue
    }

    // 二级标题：只有被认领的那些才打，且下面一行已经是标记时不重复打。
    // `headings` 里的值是 `splitSections` 存的**整行**（含 `## ` 前缀），比较时用整行。
    if (/^##\s+\S/.test(line) && headings.has(line.trim())) {
      const next = scanned[i + 1]?.line ?? ''
      if (next.trim() !== KEEP) out.push('', KEEP)
    }
    if (line.includes(KERNEL_END)) inKernel = false
  }
  return out.join('\n')
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

/** 账本里内核区的片段 id。 */
const LEDGER_KERNEL = 'kernel'
/** 整份文件的片段 id：一个文件只有一个，因为整份内容就是这一段。 */
const LEDGER_WHOLE = 'whole'
/** 账本里受管节的片段 id 前缀，后面接节标题。 */
const LEDGER_SECTION_PREFIX = 'section:'

/**
 * 把刚写下去的 AGENTS.md 记进账本：内核区一段，每个受管节各一段。
 *
 * **为什么按节记而不是整份记**：整份文件里混着使用者的正文，整份哈希一旦变化就什么都
 * 不认了——而使用者在正文里改一个字是常态。按节记之后，「他改了他的节」不影响「我的节
 * 仍然归我」，撤除才能只撤我写的那部分。
 *
 * **只记受管节**：带 `pf:keep` 的节内容归使用者，不该记成我的；记了会在撤除时被当成
 * 痕迹删掉。这条边界正是「按字节归属」与「按节标题」的分界。
 */
/**
 * 把一份**由本 skill 落盘**的产物记进账本。
 *
 * 用途：README、CONTRIBUTING、CI 工作流、LICENSE 这类文件由 AI 照着模板写，
 * 不由本脚本生成。它们同样需要「这段字节是谁写的」的精确记录——否则交棒时
 * 只能靠形状猜，而「像」不等于「是」。
 *
 * 用法：`node scripts/compose-agents.mjs <项目> --record <相对路径>`
 * 在**写完那份文件之后**调用。它读当前内容、算哈希、记成 `whole` 落地。
 *
 * 为什么由调用方显式记，而不是脚本自己接管写盘：这些产物要按项目事实取舍、
 * 要人读代码后写，本脚本写不了。**记账与写盘分离**，但归属仍然是确定的。
 */
function recordWholeFile(target, rel) {
  const full = join(target, rel)
  if (!existsSync(full)) {
    process.stderr.write(`错误：${rel} 不存在，无法登记。先写文件再登记。\n`)
    return 1
  }
  const content = readFileSync(full, 'utf8')
  // 账本读不出来时按「没有账本」处理：落盘只做加法，不会破坏任何东西。
  // 「读不出来」与「没有」的区别只在验收侧有后果，那里另有处理。
  const { ledger } = readLedger(target)
  recordSegment(ledger, { file: rel.replace(/\\/g, '/'), id: LEDGER_WHOLE, landing: 'whole', content })
  writeLedger(target, ledger)
  process.stdout.write(`已登记：${rel}（整份文件，${Buffer.byteLength(content, 'utf8')} 字节）\n`)
  return 0
}

function recordLanded(target, agentsPath, text) {
  const { ledger } = readLedger(target)
  const file = 'AGENTS.md'

  // 内核区：一对锚点圈定的字节区间。缺任何一端就跳过——记一条提不出内容的记录没有意义。
  const si = text.indexOf(KERNEL_START)
  const ei = text.indexOf(KERNEL_END, si + KERNEL_START.length)
  if (si >= 0 && ei > si) {
    recordSegment(ledger, {
      file,
      id: LEDGER_KERNEL,
      landing: 'anchored',
      content: text.slice(si + KERNEL_START.length, ei),
    })
  }

  // 受管节：这一版求值出来的、归脚本决定的那些节。
  for (const section of splitSections(text).sections) {
    const body = section.lines.join('\n')
    // 归使用者所有的节不记：撤除时不该碰它。
    if (body.includes(KEEP)) {
      forgetSegment(ledger, file, `${LEDGER_SECTION_PREFIX}${section.heading}`)
      continue
    }
    recordSegment(ledger, {
      file,
      id: `${LEDGER_SECTION_PREFIX}${section.heading}`,
      landing: 'section',
      content: body,
    })
  }

  writeLedger(target, ledger)
}

const DEFAULT_BUDGET_NOTE = `预算默认 ${DEFAULT_BUDGET} 字节`

function parseArgs(argv) {
  const positional = []
  let check = false
  let status = false
  let upgrade = false
  let budget = DEFAULT_BUDGET
  let help = false
  /** 非空表示「只登记这份产物，不做别的」。 */
  let record
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--record') {
      const value = argv[i + 1]
      if (typeof value !== 'string' || value === '') throw new Error('--record 需要一个相对路径。')
      record = value
      i += 1
      continue
    }
    if (arg === '--check') { check = true; continue }
    if (arg === '--status') { status = true; continue }
    if (arg === '--upgrade') { upgrade = true; continue }
    if (arg === '--help' || arg === '-h') { help = true; continue }
    if (arg === '--budget') {
      const value = Number(argv[i + 1])
      if (!Number.isFinite(value) || value <= 0) throw new Error('--budget 需要一个正整数字节数。')
      budget = value
      i += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`)
    positional.push(arg)
  }
  return { check, status, upgrade, budget, help, record, positional }
}

/**
 * 报告缺口。三件事都要说，缺一件就会误导：
 *
 *   - **待填写项**（`pf:author`）：模板说要人写的节，还没写；
 *   - **缺失的节**：模板里有、文件里没有的节；
 *   - **判据是否适用**：不适用时（「作者编排」的文件）不报「0」，报「不适用」。
 *
 * 为什么两个数都要：`--upgrade` 刻意**不补**需要人写的节（补进去只是占位符），于是
 * 一份刚升级完、一个项目节都没写的手写文件，`pf:author` 数**立刻就是 0**——如果只报
 * 「待填写 0 处」，使用者会以为写完了，而实际上项目定位、架构、不变量、构建验证、
 * 硬性规范、测试约定六节全缺。这正是 SKILL.md 自己警告过的「看起来完整、实际空洞」，
 * 而报告本身成了那个错觉的来源。
 *
 * 为什么「不适用」不能印成 0：作者编排的文件（含本仓库自己那份）根本不参与缺节判据，
 * 那个 `[]` 是**没查**，不是**查过没有**。印成「缺失 0 节」就等于把「没比」说成
 * 「比过且一致」——而 `SKILL.md` 与 `docs-set.md` 都把本脚本的「内容完整」当成 P4
 * 唯一的完成信号。不适用时说「未验证」，并说明为什么，那才是真话。
 */
function reportGaps(authors, missing, stream) {
  const applicable = missing.applicable
  if (!applicable) {
    if (authors.length > 0) {
      stream.write(`\n待填写 ${authors.length} 处（脚本填不了，要读代码后写）：\n`)
      writeAuthorList(authors, stream)
    }
    stream.write('\n缺节判据**不适用**：这份文件由作者编排，节结构是作者的决定，'
      + '脚本既不会替他补这些节，也不按模板的标题清单判缺。\n')
    stream.write('因此「缺失 0 节」在这里是**没查**，不是「查过没有」——'
      + '本文件不构成「内容完整」的证据。\n')
    return
  }
  const complete = authors.length === 0 && missing.list.length === 0
  if (complete) {
    stream.write('\n内容完整：没有待填写项，也没有缺失的节。\n')
    return
  }
  if (authors.length > 0) {
    stream.write(`\n待填写 ${authors.length} 处（脚本填不了，要读代码后写）：\n`)
    writeAuthorList(authors, stream)
  }
  if (missing.list.length > 0) {
    stream.write(`\n缺失 ${missing.list.length} 个节（模板里有、本文件没有）：\n`)
    for (const m of missing.list) {
      stream.write(`  - ${m.heading}${m.needsHuman ? '（需要读代码后自己写）' : '（可由脚本补）'}\n`)
    }
    stream.write('**这些节没写，文档就不算完成**——它们正是未来的会话真正需要的内容。\n')
  }
  stream.write('写完后重跑本脚本，确认「内容完整」。\n')
}

function writeAuthorList(authors, stream) {
  const seen = new Set()
  for (const { section, note } of authors) {
    const line = note === '' ? section : `${section} —— ${note}`
    if (seen.has(line)) continue
    seen.add(line)
    stream.write(`  - ${line}\n`)
  }
}

/** 算出相对模板还缺哪些节。`--status` 与普通运行共用同一份判据。 */
function missingSections(target, currentText, s = survey(target)) {
  const fresh = splitSections(materialize(readUtf8(SKELETON_PATH), deriveFacts(target, s)))
  const have = new Set(splitSections(currentText)
    .sections.map((s) => s.heading))
  return fresh.sections
    .filter((s) => !have.has(s.heading))
    .map((s) => ({ heading: s.heading, needsHuman: findAuthors(s.lines.join('\n')).length > 0 }))
}

/**
 * 这份文件的节结构是谁定的：脚本生成 / 脚本升级 / 作者自己编排。判据写在文件里，不靠调用方传参。
 *
 * **按标记常量判，不另写一份字面量**：这两个标记有写入方（本脚本的 `attachMarker`）
 * 与读取方（这里），写入用导入的常量、读取用内联正则，字面量一改就会得到「写进去的是
 * 新标记、读出来认不出」的分裂——那份文件于是被判成「作者编排」，缺节检查从此对它
 * 永久关闭且没有任何提示。
 */
function documentStructure(text) {
  const lines = text.split('\n').map((l) => l.trim())
  if (lines.includes(MANAGED)) return 'generated'
  if (lines.includes(UPGRADED)) return 'upgraded'
  return 'authored'
}

/**
 * 缺节判据的适用范围：**结构的由来决定它算不算缺口**。
 *
 *   - `generated`：结构来自模板，缺一节就是被掏空 → 交给调用方当缺陷；
 *   - `upgraded`：结构已向模板对齐，但需要人写的节刻意没补 → 缺口是待办；
 *   - `authored`：编排是作者的决定（本 skill 自己的 AGENTS.md 就是），既不算缺陷也不算
 *     待办——**判据直接不适用**。否则「版本管理流程」对「版本管理」这种措辞差异会被
 *     永远报成缺节，而作者没有「补」的义务：脚本从来不会替他补这些节。
 *
 * 只按标题字面差集判缺，是这一格长期存在的毛病；同一个道理在 docs-set.md 的 README
 * 一节里已经写明白了——「缺」要按内容判，不能按标题名判。这里补上另一半：连适用与否
 * 都要先按文件的性质判。
 *
 * 返回值带 `applicable`：**不适用时 list 为空是「没查」，不是「查过没有」**，调用方
 * 必须把它与「查了、真的一个不缺」分开报。
 */
function applicableMissingSections(target, text, s = survey(target)) {
  if (documentStructure(text) === 'authored') return { applicable: false, list: [] }
  return { applicable: true, list: missingSections(target, text, s) }
}

/**
 * 「本项目声明的兼容范围 vs 专章核对时的宿主版本」——一条**兼容性**提示。
 *
 * 这不是 `host=` 的核对结果：`host=` 的含义是「上次核对时**本机实际运行**的那套
 * 宿主版本」，它只与本机实际宿主比对（那件事在 preflight 里做，带一致/不同/未核对
 * 三态）。这里说的是另一件事——本项目为宿主声明的兼容范围可能早于专章核对过的版本。
 * 两者是不同调用点、不同消息；共用的只有**归一化**（preflight 的 normVersion，
 * 全仓只此一份），不共用语义——同一个键挂两种语义，正是这条提示要避开的问题。
 *
 * 寄生在本来就要看的输出里：不另起命令、不拦流程、不记入缺口。标记读不到、项目非
 * 插件、项目无锁定版本时一律安静——没证据不断言，避免误报打扰非 DSH 项目。
 */
function dshCompatibilityNotice(s) {
  if (s === undefined || !s.ecosystem.kinds.includes('dsh-plugin')) return undefined
  const pinned = s.dsh?.pinnedVersions ?? []
  if (pinned.length === 0) return undefined
  let marker = ''
  try {
    marker = readUtf8(join(SKILL_ROOT, 'references', 'plugins', 'dsh.md'))
  } catch { return undefined }
  // 标记的解析与键形状**只有一处实现**（preflight 的 parseMarkerKeys）。两处各写一份
  // 就有两份判据：自己那条一旦依赖键的顺序（例如要求 host 排在 date 之前），顺序一换
  // 就静默失效——而失效的表现是「比对说一致」，最难发现的那种。
  const parsed = parseMarkerKeys(/dsh-verified:\s*([^>]*?)\s*-->/.exec(marker)?.[1] ?? '')
  const hostPin = parsed.keys.host
  if (hostPin === undefined) return undefined
  if (pinned.some((p) => normVersion(p) === normVersion(hostPin))) return undefined
  return `提示：本项目声明的 DSH 兼容范围 ${pinned.join('、')} 与专章核对时的宿主版本 ${hostPin} 不同——`
    + '那是核对当时的本机版本，不是本项目的承诺；给这个项目配兼容范围时留意它可能早于核对过的宿主。'
    + '按 references/plugins/dsh.md 事实来源节重核第一节至第九节。'
}

/**
 * 手写 AGENTS.md 的体检报告。
 *
 * 这是「项目已经有 AGENTS.md，但写得不好或漏了很多」场景的默认动作：**不动文件**，
 * 只把事实摊开——它有什么、缺什么、和标准结构的差距在哪——然后给出明确的下一步。
 *
 * 为什么不直接升级：这份文件是别人写的，重排和补写都属于对他人成果的改动。默认沉默地
 * 改掉，比不动更糟。但直接报错退出也不行——那等于告诉使用者「你这个场景不支持」。
 * 所以默认只报告，升级要显式要求。
 */
function reportHandwritten(agentsPath, existing, target, status, check, s = survey(target)) {
  const facts = deriveFacts(target, s)
  const rendered = materialize(readUtf8(SKELETON_PATH), facts)
  const standard = splitSections(rendered)
  const current = splitSections(existing)

  const have = new Set(current.sections.map((s) => s.heading))
  const missing = standard.sections
    .filter((s) => !have.has(s.heading))
    .map((s) => ({ heading: s.heading, needsHuman: findAuthors(s.lines.join('\n')).length > 0 }))

  const bytes = Buffer.byteLength(existing, 'utf8')
  const out = []
  out.push(`${agentsPath}`)
  out.push(`  这是一份手写的 AGENTS.md（没有内核标记），共 ${bytes} 字节。`)
  out.push(`  本脚本**没有改动它**——手写文件的改动应当由你确认后再做。`)
  out.push('')
  out.push(`  它现有的节（${current.sections.length} 个）：`)
  for (const s of current.sections) out.push(`    - ${s.heading}`)
  if (missing.length > 0) {
    out.push('')
    out.push(`  与标准结构相比，缺少这些节（${missing.length} 个）：`)
    for (const m of missing) {
      out.push(`    - ${m.heading}${m.needsHuman ? '（需要读代码后自己写）' : '（可自动补）'}`)
    }
  }

  const emit = (stream) => { for (const line of out) stream.write(`${line}\n`) }

  if (check) {
    // 校验模式下没有内核就是不达标；但要把「怎么办」说清楚，而不是只报一句失败
    emit(process.stdout)
    process.stderr.write('\n校验失败：这份 AGENTS.md 还没有内核标记，无法与模板比对。\n'
      + `  要把它升级为标准结构（只会增加内容，不删不改已有段落）：\n`
      + `    node "<本领目录>/scripts/compose-agents.mjs" "${target}" --upgrade\n`)
    return 1
  }
  if (status) {
    emit(process.stdout)
    return 0
  }

  emit(process.stdout)
  process.stdout.write('\n下一步：\n'
    + '  - 想保留原样、只做体检 → 到此为止，本脚本不会动它。\n'
    + '  - 想升级为标准结构 → 加 --upgrade 再跑一次。它只做加法：\n'
    + '      插入内核段落、补上上面标着「可自动补」的节；\n'
    + '      已有的段落一个字节都不删、不改、不重排。\n')
  return 0
}

/**
 * 报告刷新时做了什么。三件事都值得说，因为它们都改变了文件内容，而使用者需要知道
 * 「为什么这次跑完文件变了」——尤其是「模板里有而文件里没有」的节，脚本刻意不补，
 * 让人自己决定。
 */
/**
 * 「为什么这次跑完文件变了」——逐条说明这次重新求值、保留、补上了哪些节。
 *
 * **「模板里有、文件里没有的节」不在这里打印**：那份清单由 reportGaps 统一负责。
 * 两处各打一遍的后果不是冗余，而是**结论互相矛盾**——同一批节，reportGaps 说
 * 「这些节没写，文档就不算完成」，这里说「未自动添加，需要就手动补」，读者不知道该
 * 相信哪一句。同一件事只留一个出口。
 */
function reportRefresh(report, stream) {
  if (report === undefined) return
  if (report.upgradedFrom === 'handwritten') {
    stream.write('\n已按标准结构升级这份手写的 AGENTS.md（只做加法）：\n')
    stream.write('  - 插入了内核段落（行事总纲、本文件的定位与编辑规则）\n')
    if (report.added.length > 0) {
      stream.write(`  - 补上了 ${report.added.length} 个缺失的节：\n`)
      for (const a of report.added) stream.write(`      ${a}\n`)
    }
    stream.write('  - 原有段落全部保留（未删除、未改写、未重排）\n')
    return
  }
  if (report.refreshed !== undefined && report.refreshed.length > 0) {
    stream.write(`\n按当前项目事实重新求值的节（共 ${report.refreshed.length} 节）：\n`)
    for (const r of report.refreshed) {
      stream.write(`  - ${r.heading}\n`)
      if (r.extra.length > 0) {
        stream.write(`      注意：这一节现有的内容里有 ${r.extra.length} 行不在模板重新求值的结果里，`
          + '本次会被替换掉。原文如下，确认是不是你要留的：\n')
        for (const line of r.extra.slice(0, 12)) stream.write(`        | ${line}\n`)
        if (r.extra.length > 12) stream.write(`        | …另有 ${r.extra.length - 12} 行\n`)
        stream.write('      要保留自己写的内容，把它挪到模板没有的二级标题下——那些节脚本原样保留。\n')
        stream.write('      手写的整份文件可以先跑 --upgrade：它会给保留下来的每一节打上归使用者\n')
        stream.write('      所有的标记，此后刷新不再动那些节（标记是 pf:keep）。\n')
      }
    }
  }
  if (report.kept.length > 0) {
    stream.write(`\n保留原样的节（共 ${report.kept.length} 节，人写的内容不动）\n`)
  }
}

/**
 * 模板用到的每个 `pf:if` 条件，都必须在条件表里有定义。**只查这一个方向。**
 *
 * 漏了会怎样：条件名不在表里，`materialize` 会抛错，**本次运行以退出码 2 中止**，
 * 产出文件不会被写入。所以消息必须指向「在条件表里补上同名条目」——指向「那一节
 * 为什么不见了」会让人去查一个根本没发生的后果（文件压根没生成）。
 *
 * **为什么不查反向**（条件表里有、模板里没用到）：那是**正常**的，而且是有用的正常。
 * 条件可以先备好、模板段落之后才写——比如某个判据已经确定要做、但专章还没落地。
 * 把它当失败，会逼着人删掉有用的判据，或者反过来逼着人立刻写一段这个项目并不需要的
 * 段落。两种都是拿一条会叫喊的检查去换一次合法的工作顺序。
 *
 * 这与「不加抓不住问题、又会叫喊的检查，比不加更坏」是同一条推理：**只查确定会坏的那一半。**
 *
 * 检查条件是**表里有定义**，不是「这个项目下为真」——后者会让「判据此时为假」被误当成
 * 「定义缺失」，而那完全正常。
 */
function assertTemplateConditionsKnown(target, s = survey(target)) {
  if (!existsSync(SKELETON_PATH)) return // 骨架缺失由后面那条分支报，不在这里重复
  const used = new Set(
    [...readUtf8(SKELETON_PATH).matchAll(/<!--\s*pf:if\s+([A-Za-z0-9_-]+)\s*-->/g)]
      .map((m) => m[1]),
  )
  if (used.size === 0) return
  let conditions
  try {
    conditions = deriveFacts(target, s).conditions
  } catch {
    // 勘察本身读不出这个目录：那是后面处理这个目录时会报的事，不在这里抢着报，
    // 也不要把一次校验失败变成一次工具崩溃。
    return
  }
  const missing = [...used].filter((name) => !(name in conditions)).sort()
  if (missing.length > 0) {
    throw new Error(
      `templates/agents-project.md 用到了条件表里没有的条件：${missing.join('、')}。\n`
      + '  请在 compose-agents.mjs 的 deriveFacts() 条件表里补上同名条目。\n'
      + '  未定义的条件会让本次运行**以退出码 2 中止**，产出文件不会被写入——'
      + '不是静默丢弃那一段。补上条件名再跑一次即可。',
    )
  }
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  const { check, status, upgrade, budget, help, record, positional } = parsed
  if (help) {
    process.stdout.write([
      '用法：node scripts/compose-agents.mjs [目录] [选项]',
      '',
      '  生成或刷新目标项目的 AGENTS.md。',
      '  - 文件不存在 → 按项目事实生成一份；',
      '  - 文件已存在且有内核标记 → 按节合并：人写的保留，纯生成的按当前事实重新求值；',
      '  - 文件已存在但**没有**内核标记（手写的）→ 默认只体检、不动它。',
      '',
      '  --upgrade  把一份手写的 AGENTS.md 升级为标准结构。**只做加法**：',
      '             插入内核段落、补上缺失的自动节；已有段落不删不改不重排。',
      '  --check    只校验，不写入；以下任一项不满足即退出码 1：',
      '             内核区间与 templates/agents-kernel.md 逐字一致（按行尾归一化后比）、',
      '             内核标记恰好一对、脚本生成的文件不缺节（作者自己编排的文件不判缺节——',
      '             编排是权威，那一项只作提示）。超出字节预算同样返回 1。',
      '  --status   只报告现状，不写入',
      `  --budget N ${DEFAULT_BUDGET_NOTE}`,
      '  --record <相对路径>  把一份由本 skill 落盘的产物记进账本（写完再调）。',
      '                      用途：README / CONTRIBUTING / CI 工作流 / LICENSE 这类由 AI',
      '                      照着模板写的文件。不记的话交棒时只能靠形状猜，而「像」不等于「是」。',
      '',
      '  退出码：0 = 通过或无需改动；1 = --check 发现不一致（含超预算）；2 = 用法或文件错误。',
      '',
    ].join('\n'))
    return 0
  }

  const target = resolve(positional[0] ?? process.cwd())
  const agentsPath = join(target, 'AGENTS.md')

  // --record：只登记一份产物，不做别的。这是「AI 照着模板写了 README / CI /
  // LICENSE，但要让它进账本」的唯一入口——那些文件不由本脚本写，却是本 skill 的产出。
  if (record !== undefined) return recordWholeFile(target, record)

  // 模板与条件表的一致性：放在**任何早退分支之前**。
  //
  // materialize 自己也会拒绝未知条件（那道报错很好），但它只在**走到求值**时才触发。
  // 「文件不存在」（--check 直接报不存在退出）、「标记受损」（报受损退出）这些更早的
  // 分支都走不到它——模板坏没坏于是被另一个错误盖住，下一次也没人再问它，而 CI 跑的就是
  // --check。放在这里，那两条路径上模板也照样受检。
  //
  // 勘察只跑一次：它是一次全盘走查加若干 git 子进程，重跑一遍就是白等一秒多。
  // 这里算出来的结果往下透传，`--status` 因此从三遍降为一遍。
  let s
  try {
    s = survey(target)
  } catch (error) {
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  try {
    assertTemplateConditionsKnown(target, s)
  } catch (error) {
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  let kernel
  try {
    kernel = kernelBody()
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }

  const exists = existsSync(agentsPath)
  // AGENTS.md 是个**目录**时给一句人话，而不是抛内部的 EISDIR。
  if (exists && statSync(agentsPath).isDirectory()) {
    process.stderr.write(
      `错误：${agentsPath} 是一个目录，不是文件。\n`
      + '  本脚本要写的是文件。请先把这个同名目录移走或改名，再重跑。\n',
    )
    return 2
  }
  // 清理上次异常退出留下的临时文件（正常情况下改名后它就不存在了）。
  //
  // 判据与报告都在 sync-toc.mjs 那一处：只删「能证明是已经死掉的进程留下的」那些，
  // 同前缀但不是纯数字的（使用者自己的文件）与属主还活着的（另一个正在跑的进程手里
  // 的）一律留下并报出来——删掉前者是悄悄毁掉别人的东西，删掉后者会让那次运行的改名
  // 失败。
  reportTemps(agentsPath, clearStaleTemps(agentsPath))
  if (check && !exists) {
    process.stderr.write(`校验失败：${agentsPath} 不存在。\n`)
    return 1
  }

  let composed
  let refreshReport
  let managedExisting
  // 原文件带不带 BOM：BOM 不是内容，却属于「这个文件原本的样子」，写回去时要带上。
  let hadBom = false
  // 内核区与模板不一致 → 这次运行会用模板刷新它，而内核区里的内容会没。
  // 契约要求「注入前先提醒他会被覆盖」（SKILL.md 硬不变量 2）。
  let kernelWillBeOverwritten = false
  // 生成时留下的勘察结论：报告里要用它说清「这一节为什么没生成」（清单解析不了时）。
  let factsForReport
  try {
    if (exists) {
      // ① 编码守卫：读不出无损 UTF-8 就**不写**。
      // 宽松地读会把无法解码的字节替换掉，再写回去就是不可恢复的损坏。
      const read = readUtf8Strict(agentsPath)
      if (read.error !== undefined) {
        process.stderr.write(
          `错误：无法把 ${agentsPath} 当作 UTF-8 读取——${read.error}。\n`
          + '  **本脚本没有改动它。**\n'
          + '  这个文件每次会话都会被注入，而且要在版本库里长期保存，所以它必须是 UTF-8。\n'
          + '  请先用编辑器把它转存为 UTF-8（不要用「Unicode」「ANSI」这些本地编码选项），再重跑。\n',
        )
        return 2
      }
      const existing = read.text
      hadBom = read.hadBom === true

      // ② 四态判定：手写 / 受管 / 围栏内 / 受损。后两者必须停下，不能当成手写。
      const state = documentState(existing)
      if (state.kind === 'damaged') {
        process.stderr.write(
          `错误：${agentsPath} 的内核标记受损——${state.reason}。\n`
          + `  ${state.hint ?? ''}\n`
          + '  **本脚本没有改动它。**\n'
          + '  请手工把标记修回恰好一对（下面这两行，各一个）：\n'
          + `    ${START}\n    ${END}\n`
          + '  修好后重跑；若确认想丢弃内核段落重新生成，删掉这两行后再跑，'
          + '它会被当作手写文件对待。\n',
        )
        return 2
      }

      if (state.kind === 'handwritten') {
        // 手写的 AGENTS.md：不带内核标记。
        //
        // 这是「项目已经有一个 AGENTS.md，但写得不好或漏了很多」的常见场景。此时**不能
        // 报错退出**（那会把最常见的场景变成死路），也不能擅自重写（那是覆盖用户的成果）。
        // 默认只做体检并给出下一步；用户明确要升级时才动手，且只做加法。
        if (!upgrade) return reportHandwritten(agentsPath, existing, target, status, check, s)
        const upgraded = upgradeHandwritten(existing, kernel, target, s)
        composed = upgraded.text
        refreshReport = { upgradedFrom: 'handwritten', added: upgraded.added, kept: [], refreshed: [] }
      } else {
        managedExisting = existing
        const refreshed = refreshFromTemplate(target, existing, kernel, state, s)
        composed = refreshed.text
        refreshReport = refreshed.report
        factsForReport = refreshed.facts
        // 内核区会被模板刷新：判据与 `--check` 的「内核不一致」同源（embeddedKernel）。
        kernelWillBeOverwritten = embeddedKernel(existing) !== kernel
      }
      if (!composed.endsWith('\n')) composed += '\n'
    } else {
      if (check) {
        process.stderr.write(`校验失败：${agentsPath} 不存在。\n`)
        return 1
      }
      if (!existsSync(SKELETON_PATH)) {
        process.stderr.write(`错误：找不到骨架 ${SKELETON_PATH}。\n`)
        return 2
      }
      const facts = deriveFacts(target, s)
      factsForReport = facts
      composed = materialize(readUtf8(SKELETON_PATH), facts)
      if (!composed.endsWith('\n')) composed += '\n'
      const authors = findAuthors(composed)
      composed = stripScaffold(composed, authors.length)
      if (!composed.endsWith('\n')) composed += '\n'
      composed = injectKernel(composed, kernel)
      // 记住「这是生成的文件」：它的节结构由模板决定，缺节即缺陷。
      composed = attachMarker(composed, MANAGED, START)
      if (!composed.endsWith('\n')) composed += '\n'
    }
  } catch (error) {
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  // 沿用原文件的行尾风格，并且**整篇统一**。
  //
  // 不统一的后果是混合行尾：既有的人写节带着 CRLF，新注入的内核是 LF，于是产出物
  // 一半 CRLF 一半 LF——这种文件每次运行都说「已刷新」而字节其实没变，git 也把整篇
  // 记成改动。所以这里先整体归一化成 LF，再按原文件的主导行尾一次性铺回去。
  // 两条路径（刷新与升级）都走这里，产出行尾状态才不会两样。
  if (exists) {
    const eol = dominantEol(readFileSync(agentsPath, 'utf8'))
    const normalized = composed.replace(/\r\n/g, '\n')
    composed = eol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized
  }

  const authors = findAuthors(composed)
  // 原文件带 BOM 就把它带回去。BOM 不是正文，却属于「这个文件原本的样子」：悄悄去掉
  // 它与「标记之外一个字节都不动」的说法冲突，而 BOM 是 Windows 上不少编辑器的默认，
  // 去掉之后用户的编辑器下一次保存又加回来，于是版本库里反复出现「只多了个 BOM」的改动。
  const payload = hadBom ? '\uFEFF' + composed : composed
  const bytes = Buffer.byteLength(payload, 'utf8')
  const ratio = ((bytes / budget) * 100).toFixed(1)
  // 比较前两侧都归一化：current 已经由 readUtf8 归一成 LF，composed 可能是 CRLF。
  // 不归一就会出现「字节没变却每次都说改了」——那会让「无需改动」这个信号失效，
  // 而它是使用者判断文件是否已经稳定的唯一依据。
  const current = exists ? readUtf8(agentsPath) : undefined
  const same = current !== undefined && composed.replace(/\r\n/g, '\n') === current

  // `--check` 判什么，与它**自称**判什么必须一致。
  //
  // 「整个文件是否等于按当前事实重跑一遍的结果」是另一件事，拿它冒充「内核与模板是否
  // 逐字一致」会在两个方向上都出错：
  //   误报通过——**重复节**与**整节被删**在特定路径下同样能过，而缺节本该是失败；
  //   误报失败——在某个生成节里合法地加一行注释，会被指控成「内核不一致」，
  //     尽管内核区间逐字节相同。
  // 所以它判三件事，各自独立报错：内核区间逐字一致、标记恰好一对、没有缺失的节。
  if (check) {
    const problems = []
    const warnings = []
    if (managedExisting === undefined) {
      problems.push('这份 AGENTS.md 还是手写的，没有内核标记（用 --upgrade 升级）')
    } else {
      // 用**原文**取内核区间。注意不能用 extractKernel() 的结果——它会把内核整段换成
      // 一行占位符（那是给按节合并用的），拿它来比对等于拿 41 字节比 14315 字节。
      // 位置取围栏外那一对（documentState 已经算好），不能用 indexOf：文档里在代码块
      // 中展示这对标记是正常用法，indexOf 会命中展示用的那一份。
      //
      // 两侧**都按 LF 归一化后再比**：readUtf8Strict 不改行尾（它得保留原文），而
      // kernelBody 走 readUtf8 会把 CRLF 换成 LF。不归一的后果是 CRLF 的文件恒定报
      // 「内核不一致」，而写入路径**不会**改掉行尾（它沿用原文件的主导行尾），于是
      // 报错信息给的「修正」命令再跑一遍也还是红的——一个自己退不出来的失败。
      //
      // 取值与归一化只有一处实现（embeddedKernel），写入路径的「会被覆盖」提醒用它
      // 同一份判据：两处各判一次，改了一处就会出现「自检说一致、写入却覆盖」。
      const template = kernelBody()
      const embedded = embeddedKernel(managedExisting)
      if (embedded !== template) {
        problems.push('内核区间与 templates/agents-kernel.md 不一致'
          + `（文件里 ${Buffer.byteLength(embedded, 'utf8')} 字节，模板 ${Buffer.byteLength(template, 'utf8')} 字节）`
          + '。两侧都按 LF 归一化后比过，所以这不是行尾问题——是内核内容真的不同。')
      }
    }
    const missingNow = applicableMissingSections(target, managedExisting ?? composed, s)
    // 缺节是否算失败，取决于这份文件的节结构是谁定的：
    //   - generated → 结构由模板决定，缺节就是缺陷；
    //   - upgraded  → 结构已对齐模板，但需要人写的节还要作者补，缺节只提示；
    //   - authored  → 判据不适用（applicableMissingSections 已标明），既不算缺陷也不提示，
    //                 却在输出里要说清楚——否则「没查」会被读成「查过没有」。
    if (!missingNow.applicable) {
      warnings.push('缺节判据不适用：这份文件由作者编排，节结构是作者的决定，脚本不按模板'
        + '的标题清单判缺。这**不代表不缺节**——它代表这一项没有被检查过。')
    } else if (missingNow.list.length > 0) {
      const detail = `缺失 ${missingNow.list.length} 个节：${missingNow.list.map((m) => m.heading).join('、')}`
      if (documentStructure(managedExisting ?? composed) === 'generated') problems.push(detail)
      else warnings.push(`${detail}（这份文件是升级来的：作者的编排是权威，缺节只作提示；`
        + '若确实该有这些内容，请补上）')
    }
    if (problems.length > 0) {
      process.stderr.write(`校验失败：${agentsPath}\n`)
      for (const p of problems) process.stderr.write(`  - ${p}\n`)
      process.stderr.write(`  修正：node scripts/compose-agents.mjs "${target}"\n`)
      return 1
    }
    for (const w of warnings) process.stdout.write(`提示：${w}\n`)
    process.stdout.write(`内核一致：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
    if (bytes > budget) {
      process.stderr.write(`警告：已超出预算 ${budget} 字节，注入时会被截断。\n`)
      return 1
    }
    return 0
  }

  if (status) {
    if (!existsSync(agentsPath)) {
      process.stderr.write(`状态：${agentsPath} 不存在（尚未生成）。\n`)
      return 1
    }
    const missing = applicableMissingSections(target, readUtf8(agentsPath), s)
    process.stdout.write(`${agentsPath}\n  ${bytes} 字节，占预算 ${ratio}%，`
      + `待填写 ${authors.length} 处，`
      + (missing.applicable ? `缺失 ${missing.list.length} 节\n` : '缺节判据不适用（作者编排）\n'))
    reportGaps(authors, missing, process.stdout)
    const stale = dshCompatibilityNotice(s)
    if (stale !== undefined) process.stdout.write(`${stale}\n`)
    if (bytes > budget) {
      process.stderr.write(`警告：已超出预算 ${budget} 字节，注入时会被截断。\n`)
      return 1
    }
    return 0
  }

  const missing = applicableMissingSections(target, composed, s)
  if (same) {
    process.stdout.write(`无需改动：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
    reportGaps(authors, missing, process.stdout)
    reportRefresh(refreshReport, process.stdout)
    const staleSame = dshCompatibilityNotice(s)
    if (staleSame !== undefined) process.stdout.write(`${staleSame}\n`)
    return 0
  }

  // 写入：纳入错误处理，且**先写临时文件再改名**。
  //
  // 两件事都是必要的：
  //   - 写路径必须纳入错误处理，否则权限不足、磁盘满、文件被独占都会抛出**裸的 Node 栈**，
  //     使用者看不到「哪个文件、为什么」；
  //   - 直接覆盖原文件时，写入中途失败会留下半截文件。改名在同一分区上是原子的，
  //     所以要么是旧内容、要么是新内容，不会出现第三种状态。
  //
  // 提醒先于写入、也先于「已刷新」：**先看到提醒，才知道这次跑完文件变成什么样**。
  // 契约要求的是「提醒」不是「禁止」——内核区归模板独占，但使用者有权知道自己的
  // 内容会被覆盖，并在事后把要紧的话挪到标记之外。
  if (kernelWillBeOverwritten) {
    process.stdout.write(
      '提醒：这份 AGENTS.md 的内核区与 templates/agents-kernel.md 不一致——\n'
      + '  内核区归通用内核模板独占（单一真相源），本次运行会用模板刷新它。\n'
      + '  你在这两个标记之间写的内容会被覆盖。要保留它，请把它移到内核区之外（标记之外）。\n',
    )
  }
  if (hadBom) {
    process.stdout.write('（原文件带 UTF-8 BOM，已原样保留。）\n')
  }
  try {
    mkdirSync(dirname(agentsPath), { recursive: true })
    const tmp = tempPathFor(agentsPath)
    writeFileSync(tmp, payload, { encoding: 'utf8' })
    renameSync(tmp, agentsPath)
  } catch (error) {
    process.stderr.write(
      `错误：无法写入 ${agentsPath}——${error instanceof Error ? error.message : String(error)}\n`
      + '  文件未被改动（写入失败时原文件保持不变）。\n'
      + '  常见原因：文件被其他程序占用、目录只读、磁盘空间不足。\n',
    )
    return 2
  }
  process.stdout.write(
    `${exists ? '已刷新' : '已生成'}：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`,
  )
  // 落盘之后**立刻记账**：写下「这份文件的内核区、以及每个受管节，各自的字节哈希」。
  //
  // 账本是痕迹判定的唯一依据——有了它，「这段是不是我写的」就从推断变成比对：
  // 哈希对上就是我写的（可撤可刷），对不上就是使用者改过（停下问人），没有记录就不是
  // 我写的（一个字节都不动）。没有账本时，交棒只能靠形状猜，而形状必然两头都错。
  //
  // 记账失败**不中断**：文件已经写好了，账本只是下一次判定的依据；这里报一句，
  // 下一次会退化成「什么都不敢认」，那是安全的退化方向。
  try {
    recordLanded(target, agentsPath, payload)
  } catch (error) {
    process.stderr.write(`提示：账本没能更新（${error instanceof Error ? error.message : String(error)}\n`
      + '  文件已写入；下次判定会退化成「只做加法、不撤任何东西」。\n')
  }
  // 清单解析不了时，生成件里「依赖版本同步」那一节是**读不到**而不是「没有依赖」。
  // 不说这一句，报告就只显示「已生成 + 待填写 0 处」——一份少了一节的契约被读成完整的。
  //
  // **为什么读不出来要分三种说**：合成一句「JSON 语法错误」会把「文件不是 UTF-8/UTF-16」
  // 说成「JSON 写错了」，于是使用者去改一个语法完全正确的文件。修正动作完全不同：
  // 语法错要改 JSON，编码不对要转存编码。
  if (factsForReport?.manifestBroken === true) {
    const file = factsForReport.manifestPath ?? 'package.json'
    const why = factsForReport.manifestBrokenWhy
    const tail = '——「依赖版本同步」那一节因此没有生成。'
    if (why === 'encoding') {
      process.stdout.write(
        `提示：${file} 不是合法的 UTF-8/UTF-16（多半是存成了 UTF-16 或本地编码），`
        + `本次读不出它的内容，按「依赖未知」处理${tail}\n`
        + '  请先用编辑器把它转存为 UTF-8，再跑一次，它会补上。\n',
      )
    } else if (why === 'unreadable') {
      process.stdout.write(
        `提示：${file} 读不出来，本次按「依赖未知」处理${tail}\n`
        + '  文件恢复可读之后重跑一次，它会补上。\n',
      )
    } else {
      process.stdout.write(
        `提示：${file} 的 JSON 语法错误，本次按「依赖未知」处理${tail}\n`
        + '  修好清单后再跑一次，它会补上。\n',
      )
    }
  }
  reportGaps(authors, missing, process.stdout)
  reportRefresh(refreshReport, process.stdout)
  const staleNew = dshCompatibilityNotice(s)
  if (staleNew !== undefined) process.stdout.write(`${staleNew}\n`)
  if (bytes > budget) {
    process.stderr.write(
      `警告：总字节数 ${bytes} 已超出预算 ${budget}。\n`
      + '  超出部分在注入会话上下文时会被截断。请把可下放到子目录的内容移到子目录\n'
      + '  AGENTS.md，或把细节移出本文件、改为指向项目内其他文档。\n',
    )
  }
  return 0
}

// 与 survey / review / preflight 同一模式：直接执行才跑 main；被 import（自检要引用
// 本文件的纯函数）时不产生副作用。
//
// 少了这道守卫的代价很具体：import 这个模块会在**当前工作目录**里生成一份 AGENTS.md
// ——在调用者根本没要求的项目里写文件，而 import 的人只是想用它的某个函数。
// 判据按真实路径比较，经 junction 调用也算直接执行。
if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main(process.argv)