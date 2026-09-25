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
 * 缺节判据只对**结构由脚本决定**的文件成立（见 MANAGED / UPGRADED 两个常量的注释）：
 * 生成的文件缺节是缺陷，升级过的文件缺节是待办，作者自己编排的文件不判缺节。
 *
 * 模板标记（写在 templates/agents-project.md 里）：
 *   {{TOKEN}}                  由项目事实替换
 *   <!-- pf:if 条件 --> … <!-- pf:endif -->   按事实决定保留或丢弃，支持嵌套
 *   <!-- pf:author: 说明 -->    脚本填不了，留给作者；脚本会统计剩余数量
 *   <!-- pf:scaffold --> … <!-- pf:endscaffold -->  脚手架，待填写项归零后自动移除
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey, authorMarkers } from './survey.mjs'
import { normVersion, parseMarkerKeys } from './preflight.mjs'
// 围栏扫描只有一份实现，放在 sync-toc.mjs 并导出来：它要判的是同一件事
// （这对标记是不是真在正文里），两边各写一份状态机就会给出不同答案。
import { fencedSpans, markerPositions } from './sync-toc.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const KERNEL_PATH = join(SKILL_ROOT, 'templates', 'agents-kernel.md')
const SKELETON_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

const START = '<!-- project-forge:kernel:start -->'
const END = '<!-- project-forge:kernel:end -->'
/**
 * 「这份文件由本脚本生成」的标记。
 *
 * 它区分开三种**都带内核**的文件，而它们的验收标准不同：
 *   - **生成的文件**（从骨架生成）：节结构由模板决定，**缺节就是缺陷**，该报错；
 *   - **升级的文件**（手写后被 --upgrade 改造，见 UPGRADED）：结构已向模板对齐，
 *     但需要人写的节脚本刻意不补，所以缺节是**待办**，只提示不否决；
 *   - **作者编排的文件**（自己写的，只带内核标记）：作者可能刻意换一种组织方式
 *     （本 skill 自己的 AGENTS.md 就是——它有「版本管理流程」而不是模板的「版本管理」，
 *     而「文档同步」的规则由内核段承担）。此时**模板的标题清单不是判据**：脚本既不会
 *     替他补这些节，也不该拿字面差集去催他——那只会把「写了但措辞不同」报成「没写」，
 *     而一份永远在喊同一批假缺失的报告，等于不存在。
 *
 * 没有这个区分时只有两种错法：要么把作者的编排当成缺陷（误报，逼人改成模板的样子），
 * 要么对掏空的契约睁一眼闭一眼（漏报）——区分的两支各自挡住其中一种错法。
 */
const MANAGED = '<!-- project-forge:managed -->'

/**
 * 「这份文件的结构已按模板升级过」的标记。
 *
 * `--upgrade` 只做加法：插入内核、补上可自动补的节，**需要人写的节一个都不补**。
 * 所以升级完的文件必然还缺若干节，那是**待办**而不是缺陷——判据必须能把它与
 * 「作者自己编排的文件」区分开，否则两者只能取同一个标准，而两个标准都会错：
 * 按缺陷判，升级后的文件永远红；按不判，P4 的「两个节数归零」就空转了。
 */
const UPGRADED = '<!-- project-forge:upgraded -->'
const DEFAULT_BUDGET = 65536

function readUtf8(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
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
  return { text: text.replace(/^\uFEFF/, '') }
}

/**
 * 判断文件处于什么状态。这是本脚本最关键的一次判断——四种状态的处理方式完全不同，
 * 而它们过去被压成了两种，于是**受损的受管文件被当成手写文件**：
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
const COMMAND_LABELS = [
  ['install', '安装依赖'],
  ['build', '构建'],
  ['typecheck', '类型检查'],
  ['lint', '静态检查'],
  ['test', '测试'],
  ['verify', '自检'],
  ['smoke', '冒烟'],
]
const COMMAND_KEYS = new Set(COMMAND_LABELS.map(([key]) => key))
/** 描述「某条命令从哪来 / 有没有」的键：不是命令本身。 */
function isNoteKey(key) {
  return key === 'note' || key.endsWith('Note')
}

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
  try { entries = readdirSync(target) } catch { /* 目录不可读就当什么都没有 */ }
  const byLower = new Map(entries.map((e) => [e.toLowerCase(), e]))
  return {
    has: (name) => byLower.has(name.toLowerCase()),
    real: (name) => byLower.get(name.toLowerCase()),
  }
}

/**
 * 把勘察结果翻译成模板能用的条件与取值。
 *
 * 每个条件的判据都写在代码里而不是散在模板里：模板只声明「这段在什么条件下出现」，
 * 「什么时候满足这个条件」由这里统一决定。这样加一个新条件只需要改一处。
 */
function deriveFacts(target) {
  const s = survey(target)
  const index = rootIndex(target)
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
  // 这里踩过两次坑，都记下来免得再犯：
  //   一、曾经要求「声明了发布范围（files 白名单）」才算可发布——而绝大多数包并不写
  //       该字段（靠默认规则决定发什么），于是它们被判成不可发布；
  //   二、改成「有清单即可」之后又只认 `package.json`——于是**所有非 JS 项目**（Python
  //       的 pyproject.toml、Rust 的 Cargo.toml、Go 的 go.mod）一律被判成不可发布，
  //       整块丢掉版本号语义、抬版本号判据、发版规则、角色判定，而能力矩阵明写
  //       「python / rust / go：发布视声明而定」。
  // 判据现在来自勘察读出的 `publishableManifest`——它按各生态的清单文件名逐個确认，
  // 不依赖「主生态是不是 node」。
  const publishableManifest = s.artifacts?.publishableManifest
  const publishable = publishableManifest !== undefined && s.artifacts?.private !== true

  // 有依赖 = 清单里声明了任意一类依赖，或其他生态的依赖声明文件存在
  let hasDeps = false
  if (manifestPath !== undefined) {
    // 依赖字段名各生态不同，这里按「清单里出现 dependency 字样的键」判断，
    // 避免把某个生态的字段名写死。
    try {
      const pkg = JSON.parse(readUtf8(join(target, manifestPath)))
      hasDeps = Object.keys(pkg).some((k) => /dependenc/i.test(k) && (
        typeof pkg[k] === 'object' ? Object.keys(pkg[k]).length > 0 : false
      ))
    } catch { /* 读不到就按无依赖处理 */ }
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
  // 这一条是**机制缺口**补上的：references 里早就写了双语文档会漂移、要成对改，
  // 但模板里没有对应段落——于是生成出来的契约里没有这条规则，项目也就不会照它做。
  // 实测后果：一个双语文档的项目，英文版漏掉了一条更新命令，而它的契约里
  // 一个字都没提「中文改了英文也要改」。规则写在参考文件里只对「读过那份文件的人」
  // 有效；写进项目自己的契约，才对**以后每一次会话**有效。
  const hasBilingualReadme = s.docs?.readmePair !== undefined

  // 插件类条件：只按勘察事实求值，不猜具体取值。模板里的 DSH 段落靠它们显隐，
  // 非插件项目不受影响；读不到即按无处理。
  const isDshPlugin = s.ecosystem.kinds.includes('dsh-plugin')
  const isGo = s.ecosystem.kinds.includes('go')
  const isPlugin = s.ecosystem.kinds.some((k) => /plugin|extension/.test(k))
  const hasDshClient = s.dsh?.hasClientEntry === true || s.dsh?.hasClientDecl === true
  const hasDshBundle = s.dsh?.bundlePatch !== undefined || s.dsh?.patchFile !== undefined
  const hasDshInvariant = s.dsh?.hasInvariantEntry === true
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
    'has-dsh-invariant': hasDshInvariant,
    'no-dsh-invariant': !hasDshInvariant,
    'has-dsh-toolchain': hasDshToolchain,
    'no-dsh-toolchain': !hasDshToolchain,
    'has-dsh-version': hasDshVersion,
    'no-dsh-version': !hasDshVersion,
    'has-dsh-local-workflow': hasDshLocalWorkflow,
    'no-dsh-local-workflow': !hasDshLocalWorkflow,
    'has-local-skills': hasLocalSkills,
    'no-local-skills': !hasLocalSkills,
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
      const raw = readUtf8(join(target, real))
      const hit = file === manifestPath ? pick(JSON.parse(raw)) : pick(raw)
      if (typeof hit === 'string' && hit.trim().length > 0) {
        projectName = hit.trim().replace(/^@[^/]+\//, '') // 去掉作用域前缀，标题里更好读
      }
    } catch { /* 解析失败就试下一个，最终用目录名 */ }
  }

  const tokens = {
    PROJECT_NAME: projectName,
    COMMANDS: renderCommands(commands),
  }

  return { survey: s, conditions, tokens }
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
 * 清掉这个文件此前的临时文件（**任何**进程号留下的）。见 sync-toc.mjs 里的同名函数：
 * 只清自己那个 pid 的等于没清，而顶层多出来的条目会被结构自检当成无主文件。
 */
function clearStaleTemps(path) {
  const dir = dirname(path)
  const prefix = `${basename(path)}.tmp-`
  let entries
  try { entries = readdirSync(dir) } catch { return }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    try { unlinkSync(join(dir, name)) } catch { /* 清不掉就算了 */ }
  }
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
  const MARK_RE = /<!--\s*pf:(if\s+[^\s>]+|endif|scaffold|endscaffold|author\s*(?::[\s\S]*?)?)\s*-->/g

  const out = []
  const stack = [] // { kind: 'if'|'scaffold', active: boolean }
  const unknownConditions = []
  const unknownTokens = new Set()
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
    // pf:author：保留标记本身，它是要交出去的待办事项
    if (active()) out.push(m[0])
  }
  emit(template.slice(cursor))

  if (stack.length > 0) throw new Error('模板里有未闭合的 pf:if 或 pf:scaffold。')
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
 * 这里曾经自己走一遍、而且**逐行**扫：标记写成两行（`<!-- pf:author:` 换行后 `-->`）
 * 就一个都数不到，于是脚本报「内容完整」并顺手删掉脚手架，而那几处 TODO 还在正文里；
 * review 用整篇扫描数出 7 处——同一份文件两个结论。两处各写一份再对齐，迟早不一致；
 * 现在 compose 与 review 都引用 survey 里的那一份。
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
function refreshFromTemplate(target, existing, kernel, state) {
  const facts = deriveFacts(target)
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
    const freshSection = freshByHeading.get(section.heading)
    if (freshSection === undefined) {
      // 模板里已经没有这个标题：原样保留。可能是作者自己加的，也可能是作者刻意换了一种
      // 组织方式（本 skill 自己的「版本管理流程」就是如此）。脚本不删。
      kept.push(section.heading)
      merged.push({ text: section.lines.join('\n'), fresh: false })
      continue
    }
    const freshText = freshSection.lines.join('\n')
    if (findAuthors(freshText).length > 0) {
      // 模板说这一节要人来写：保留既有内容，别把人写的冲掉
      kept.push(section.heading)
      merged.push({ text: section.lines.join('\n'), fresh: false })
    } else {
      // 纯生成内容：用新求值的结果，让条件段落能随事实增删
      refreshed.push(section.heading)
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
  return { text, report }
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
 * 给一个**手写的、没有内核标记的** AGENTS.md 做增量升级。
 *
 * 这是「项目已经有了 AGENTS.md，但写得不好或漏了很多」这一常见场景的入口。它必须做到
 * 三件事，缺一件就不合格：
 *   1. **不报错退出**——原来的实现直接抛「找不到内核标记」，把最常见的场景变成了死路；
 *   2. **不破坏已有内容**——手写的段落一律保留，包括它自己那套标题体系；
 *   3. **只做加法，并把加了什么说清楚**——插入内核、补上缺失的节，然后逐条报告。
 *
 * 内核插在一级标题之后、第一个二级标题之前。这是唯一不需要猜测的位置：文件标题是
 * 每个 AGENTS.md 都有的，而内核属于「总纲」性质，放在正文之前符合它被阅读的顺序。
 */
function upgradeHandwritten(existing, kernel, target) {
  const fresh = splitSections(materialize(readUtf8(SKELETON_PATH), deriveFacts(target)))
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
  return { text, added }
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_NOTE = `预算默认 ${DEFAULT_BUDGET} 字节`

function parseArgs(argv) {
  const positional = []
  let check = false
  let status = false
  let upgrade = false
  let budget = DEFAULT_BUDGET
  let help = false
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
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
  return { check, status, upgrade, budget, help, positional }
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
function missingSections(target, currentText) {
  const fresh = splitSections(materialize(readUtf8(SKELETON_PATH), deriveFacts(target)))
  const have = new Set(splitSections(currentText)
    .sections.map((s) => s.heading))
  return fresh.sections
    .filter((s) => !have.has(s.heading))
    .map((s) => ({ heading: s.heading, needsHuman: findAuthors(s.lines.join('\n')).length > 0 }))
}

/** 这份文件的节结构是谁定的：脚本生成 / 脚本升级 / 作者自己编排。判据写在文件里，不靠调用方传参。 */
function documentStructure(text) {
  if (/^<!-- project-forge:managed -->\s*$/m.test(text)) return 'generated'
  if (/^<!-- project-forge:upgraded -->\s*$/m.test(text)) return 'upgraded'
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
 * 只按标题字面差集判缺，本身就是这一格的老毛病；同一个道理在 docs-set.md 的 README
 * 一节里已经写明白了——「缺」要按内容判，不能按标题名判。这里补上另一半：连适用与否
 * 都要先按文件的性质判。
 *
 * 返回值带 `applicable`：**不适用时 list 为空是「没查」，不是「查过没有」**，调用方
 * 必须把它与「查了、真的一个不缺」分开报。
 */
function applicableMissingSections(target, text) {
  if (documentStructure(text) === 'authored') return { applicable: false, list: [] }
  return { applicable: true, list: missingSections(target, text) }
}

/**
 * 「本项目声明的兼容范围 vs 专章核对时的宿主版本」——一条**兼容性**提示。
 *
 * 这不是 `host=` 的核对结果：`host=` 的含义是「上次核对时**本机实际运行**的那套
 * 宿主版本」，它只与本机实际宿主比对（那件事在 preflight 里做，带一致/不同/未核对
 * 三态）。这里说的是另一件事——本项目为宿主声明的兼容范围可能早于专章核对过的版本。
 * 两者是不同调用点、不同消息；共用的只有**归一化**（preflight 的 normVersion，
 * 全仓只此一份），不共用语义——同一键两种语义正是这条提示过去的问题。
 *
 * 寄生在本来就要看的输出里：不另起命令、不拦流程、不记入缺口。标记读不到、项目非
 * 插件、项目无锁定版本时一律安静——没证据不断言，避免误报打扰非 DSH 项目。
 */
function dshCompatibilityNotice(target) {
  let s
  try {
    s = survey(target)
  } catch { return undefined }
  if (!s.ecosystem.kinds.includes('dsh-plugin')) return undefined
  const pinned = s.dsh?.pinnedVersions ?? []
  if (pinned.length === 0) return undefined
  let marker = ''
  try {
    marker = readUtf8(join(SKILL_ROOT, 'references', 'plugins', 'dsh.md'))
  } catch { return undefined }
  // 标记的解析与键形状**只有一处实现**（preflight 的 parseMarkerKeys）。自己写正则
  // 的代价实测过：那条正则要求 host 在 date 之前，两键顺序一换就静默失效。
  const parsed = parseMarkerKeys(/dsh-verified:\s*([^>]*?)\s*-->/.exec(marker)?.[1] ?? '')
  const hostPin = parsed.keys.host
  if (hostPin === undefined) return undefined
  if (pinned.some((p) => normVersion(p) === normVersion(hostPin))) return undefined
  return `提示：本项目声明的 DSH 兼容范围 ${pinned.join('、')} 与专章核对时的宿主版本 ${hostPin} 不同——`
    + '那是核对当时的本机版本，不是本项目的承诺；给这个项目配兼容范围时留意它可能早于核对过的宿主。'
    + '按 references/plugins/dsh.md 事实来源节重核第一节至第七节。'
}

/**
 * 手写 AGENTS.md 的体检报告。
 *
 * 这是「项目已经有 AGENTS.md，但写得不好或漏了很多」场景的默认动作：**不动文件**，
 * 只把事实摊开——它有什么、缺什么、和标准结构的差距在哪——然后给出明确的下一步。
 *
 * 为什么不直接升级：这份文件是别人写的，重排和补写都属于对他人成果的改动。默认沉默地
 * 改掉，比不动更糟。但也不能像以前那样报错退出——那等于告诉使用者「你这个场景不支持」。
 * 所以默认只报告，升级要显式要求。
 */
function reportHandwritten(agentsPath, existing, target, status, check) {
  const facts = deriveFacts(target)
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
    for (const r of report.refreshed) stream.write(`  - ${r}\n`)
  }
  if (report.kept.length > 0) {
    stream.write(`\n保留原样的节（共 ${report.kept.length} 节，人写的内容不动）\n`)
  }
}

/**
 * 模板用到的每个 `pf:if` 条件，都必须在条件表里有定义。**只查这一个方向。**
 *
 * 漏了会怎样：条件名不在表里，`materialize` 会把那一段**整段丢弃**——而丢弃是静默的，
 * 生成出来的契约里那一节凭空消失，没有任何提示说它本该在。名字拼错一个字母
 * （`has-remote` 写成 `has-remotes`）就是这个结果。
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
function assertTemplateConditionsKnown(target) {
  if (!existsSync(SKELETON_PATH)) return // 骨架缺失由后面那条分支报，不在这里重复
  const used = new Set(
    [...readUtf8(SKELETON_PATH).matchAll(/<!--\s*pf:if\s+([A-Za-z0-9_-]+)\s*-->/g)]
      .map((m) => m[1]),
  )
  if (used.size === 0) return
  let conditions
  try {
    conditions = deriveFacts(target).conditions
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
      + '  未定义的条件会让那一段内容被**整段丢弃**，而丢弃是静默的——生成出来的契约里'
      + '那一节会凭空消失，没有任何提示说它本该在。',
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
  const { check, status, upgrade, budget, help, positional } = parsed
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
      '',
      '  退出码：0 = 通过或无需改动；1 = --check 发现不一致（含超预算）；2 = 用法或文件错误。',
      '',
    ].join('\n'))
    return 0
  }

  const target = resolve(positional[0] ?? process.cwd())
  const agentsPath = join(target, 'AGENTS.md')

  // 模板与条件表的一致性：放在**任何早退分支之前**。
  //
  // materialize 自己也会拒绝未知条件（那道报错很好），但它只在**走到求值**时才触发。
  // 「文件不存在」（--check 直接报不存在退出）、「标记受损」（报受损退出）这些更早的
  // 分支都走不到它——模板坏没坏于是被另一个错误盖住，下一次也没人再问它，而 CI 跑的就是
  // --check。放在这里，那两条路径上模板也照样受检。
  try {
    assertTemplateConditionsKnown(target)
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
  // 按「同目录、同前缀」清**任何**进程号留下的：只清自己那个 pid 的等于没清——被杀的
  // 进程留下的是它的 pid，下次换了 pid 就再也清不掉，而顶层多出来的条目会被结构自检
  // 当成无主文件。sync-toc.mjs 对它自己的临时文件做同一件事。
  clearStaleTemps(agentsPath)
  if (check && !exists) {
    process.stderr.write(`校验失败：${agentsPath} 不存在。\n`)
    return 1
  }

  let composed
  let refreshReport
  let managedExisting
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
        if (!upgrade) return reportHandwritten(agentsPath, existing, target, status, check)
        const upgraded = upgradeHandwritten(existing, kernel, target)
        composed = upgraded.text
        refreshReport = { upgradedFrom: 'handwritten', added: upgraded.added, kept: [], refreshed: [] }
      } else {
        managedExisting = existing
        const refreshed = refreshFromTemplate(target, existing, kernel, state)
        composed = refreshed.text
        refreshReport = refreshed.report
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
      const facts = deriveFacts(target)
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
  const bytes = Buffer.byteLength(composed, 'utf8')
  const ratio = ((bytes / budget) * 100).toFixed(1)
  // 比较前两侧都归一化：current 已经由 readUtf8 归一成 LF，composed 可能是 CRLF。
  // 不归一就会出现「字节没变却每次都说改了」——那会让「无需改动」这个信号失效，
  // 而它是使用者判断文件是否已经稳定的唯一依据。
  const current = exists ? readUtf8(agentsPath) : undefined
  const same = current !== undefined && composed.replace(/\r\n/g, '\n') === current

  // `--check` 判什么，与它**自称**判什么必须一致。
  //
  // 它过去判的是「整个文件是否等于按当前事实重跑一遍的结果」，而文案写的是「内核与
  // 模板是否逐字一致」。两者差得很远，且两个方向都出错：
  //   误报通过——复制或删掉一个纯生成节不改整文件？不，那是差异；但**重复节**与
  //     **整节被删**在特定路径下同样能过，而缺节本该是失败；
  //   误报失败——在某个生成节里合法地加一行注释，会被指控成「内核不一致」，
  //     尽管内核区间逐字节相同。
  // 现在它判三件事，各自独立报错：内核区间逐字一致、标记恰好一对、没有缺失的节。
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
      // 归一化换了字节，偏移量也跟着变，所以位置在**归一化之后**重新取。
      const raw = managedExisting.replace(/\r\n/g, '\n')
      const template = kernelBody()
      const rawState = documentState(raw)
      const embedded = raw.slice(rawState.startAt + START.length, rawState.endAt)
        .replace(/^\n/, '').replace(/\n$/, '')
      if (embedded !== template) {
        problems.push('内核区间与 templates/agents-kernel.md 不一致'
          + `（文件里 ${Buffer.byteLength(embedded, 'utf8')} 字节，模板 ${Buffer.byteLength(template, 'utf8')} 字节）`
          + '。两侧都按 LF 归一化后比过，所以这不是行尾问题——是内核内容真的不同。')
      }
    }
    const missingNow = applicableMissingSections(target, managedExisting ?? composed)
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
    const missing = applicableMissingSections(target, readUtf8(agentsPath))
    process.stdout.write(`${agentsPath}\n  ${bytes} 字节，占预算 ${ratio}%，`
      + `待填写 ${authors.length} 处，`
      + (missing.applicable ? `缺失 ${missing.list.length} 节\n` : '缺节判据不适用（作者编排）\n'))
    reportGaps(authors, missing, process.stdout)
    const stale = dshCompatibilityNotice(target)
    if (stale !== undefined) process.stdout.write(`${stale}\n`)
    if (bytes > budget) {
      process.stderr.write(`警告：已超出预算 ${budget} 字节，注入时会被截断。\n`)
      return 1
    }
    return 0
  }

  const missing = applicableMissingSections(target, composed)
  if (same) {
    process.stdout.write(`无需改动：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
    reportGaps(authors, missing, process.stdout)
    reportRefresh(refreshReport, process.stdout)
    const staleSame = dshCompatibilityNotice(target)
    if (staleSame !== undefined) process.stdout.write(`${staleSame}\n`)
    return 0
  }

  // 写入：纳入错误处理，且**先写临时文件再改名**。
  //
  // 两件事都是必要的：
  //   - 写路径原先在 try 之外，权限不足、磁盘满、文件被独占都会抛出**裸的 Node 栈**，
  //     使用者看不到「哪个文件、为什么」；
  //   - 直接覆盖原文件时，写入中途失败会留下半截文件。改名在同一分区上是原子的，
  //     所以要么是旧内容、要么是新内容，不会出现第三种状态。
  try {
    mkdirSync(dirname(agentsPath), { recursive: true })
    const tmp = `${agentsPath}.tmp-${process.pid}`
    writeFileSync(tmp, composed, { encoding: 'utf8' })
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
  reportGaps(authors, missing, process.stdout)
  reportRefresh(refreshReport, process.stdout)
  const staleNew = dshCompatibilityNotice(target)
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

process.exitCode = main(process.argv)
