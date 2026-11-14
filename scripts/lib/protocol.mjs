/**
 * protocol.mjs —— 标记语法与全仓共用常量的唯一实现。
 *
 * 这个文件只回答两件事：
 *   一、本 skill 在别人的文件里留下的标记长什么样、怎么读、怎么剥；
 *   二、哪些东西是「旧版留下的」——只为了如实报告，不为了解释。
 *
 * 为什么标记语法必须是单一实现：它同时被四个脚本读写（compose 写、review 判、
 * handoff 找、preflight 验）。四处各写一份正则，改一处就有一条路径静默失效，
 * 而失效的表现是「明明有标记却说干净」——那会把不可逆动作变成默认动作。
 */

import { scanLines } from './markdown.mjs'

/** 标记里的命名空间。所有标记都以它开头。**写入与读取都从这里取**，不各写一遍字面量。 */
export const NS = 'project-forge'

/**
 * 标记的三类用途。**只有这三类**，新增一类要同时改这里的解析、review 的判据、
 * handoff 的处置表与 `references/handoff.md`——那四处是同一个协议的四张脸。
 *
 * - `generated`：这份文件是从本 skill 的模板起步的。文件本身是项目自己的，标记只说明
 *   来历。剥掉标记即可，文件保留。
 * - `begin <id>` / `end <id>`：一段由本 skill 维护的内容。`id` 取 `file`（整份文件）
 *   或一个节名（如 `构建与验证`）。刷新时只动这一段。
 * - `fill <what>`：本 skill 填不出来的东西，必须由读代码的人补。
 *
 * 这是**唯一一份**类型清单：下面 `parseMarkers` 的正则从它拼出来，而不是另抄一遍。
 * 抄一遍的后果是「加了一类但解析不认」，而它不会有任何报错——那一类标记会被静默忽略。
 */
export const MARKER_KINDS = Object.freeze(['generated', 'begin', 'end', 'fill'])

/** 按 `MARKER_KINDS` 拼出的「标记正文开头」正则。加一类只需要改上面那个数组。 */
const MARKER_KIND_RE = new RegExp(`^(${MARKER_KINDS.join('|')})\\b\\s*([\\s\\S]*)$`)

/** 转义成正则字面量，供下面按 `NS` 拼出的两条解析正则使用。 */
const NS_RE = NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 旧版留下的标记。只用于报告，不解释、不生成。 */
export const LEGACY_MARKERS = Object.freeze([
  { re: /<!--\s*project-forge:kernel:(?:start|end)\s*-->/, what: '旧版内核注入标记' },
  { re: /<!--\s*project-forge:(?:managed|upgraded)\s*-->/, what: '旧版受管节标记' },
  { re: /<!--\s*pf:(?:todo|author|if|endif|include|endscaffold|scaffold|keep|needs-summary)\b/, what: '旧版条件与待填标记' },
])

/** 旧版在目标项目里留下的东西（路径 + 一句话说明）。 */
export const LEGACY_PATH_SPECS = Object.freeze([
  { path: '.project-forge', kind: 'dir', what: '旧版账本目录（本 skill 早期版本的归属记录）' },
  { path: 'scripts/review-record.mjs', kind: 'file', what: '旧版落到目标项目的审查记录脚本' },
])

/**
 * 一个文件用哪种注释语法承载标记。
 *
 * **判断依据是文件能不能安全容纳注释**，不是「我想不想标它」。许可证全文没有注释语法，
 * 所以它永远不带标记——也因此它永远不被当作痕迹：一个人手里的 LICENSE 是他自己的，
 * 删许可证是不可逆的破坏，不值得为了「清干净」去冒这个风险。
 */
export function markerSyntaxFor(file) {
  const name = String(file ?? '').toLowerCase()
  if (name.endsWith('.md') || name.endsWith('.mdx')) return 'html'
  if (name.endsWith('.yml') || name.endsWith('.yaml')) return 'hash'
  return null
}

/** 生成一行标记。`syntax` 由 `markerSyntaxFor` 给出；没有注释语法的文件返回 undefined。 */
export function emitMarker(file, body) {
  const syntax = markerSyntaxFor(file)
  const text = String(body ?? '').trim()
  if (syntax === 'html') return `<!-- ${NS}: ${text} -->`
  if (syntax === 'hash') return `# ${NS}: ${text}`
  return undefined
}

/** 从一行里取出标记正文；不是标记行返回 undefined。 */
export function markerBodyOf(line) {
  const html = new RegExp(`^\\s*<!--\\s*${NS_RE}:\\s*([\\s\\S]*?)\\s*-->\\s*$`).exec(line)
  if (html) return html[1].trim()
  const hash = new RegExp(`^\\s*#\\s*${NS_RE}:\\s*(.*?)\\s*$`).exec(line)
  if (hash) return hash[1].trim()
  return undefined
}

/**
 * 解析一份文本里的全部标记，返回按行号排列的记录。
 *
 * 每条形如 `{ body, kind, id, what, line, index }`：`line` 是从 1 开始的行号，`index`
 * 是从 0 开始的行下标。`kind` 为 `begin`/`end` 时 `id` 是节名，为 `fill` 时 `what` 是待填内容。
 *
 * **代码围栏里的东西不算标记。** 一份文档可能正当地引用标记的写法（`references/handoff.md`
 * 就要解释它长什么样），那些示例是**内容**，不是 markup。把它们当成真标记的后果很具体：
 * 一份写在代码块里的示例会让「交棒」永远判不干净，而用户看到的是「这里还有痕迹」，
 * 却找不到任何能删的东西。
 *
 * ## 围栏判定只有一份实现
 *
 * 走 `markdown.scanLines`，不在这里手写状态机。手写那一版有两个具体错法，都实测过：
 *
 *   - **不校验闭合长度**：` ```` ` 开的块会被 ` ``` ` 关掉，于是围栏分界与读者看到的不一样，
 *     后面的正文被当成代码、或者代码被当成正文；
 *   - **不看行尾字符**：` ```js ` 这种带语言标记的起始行会被当成「闭合」，一开一关只隔一行，
 *     后面整段正文于是落到围栏「之外」——示例里的标记被当成真标记。
 *
 * 两处各写一份，同一个文件、同一种损坏会得到两个答案，而错的那一个通常是静默的。
 */
export function parseMarkers(text, file) {
  if (markerSyntaxFor(file) === null) return []
  const out = []
  for (const info of scanLines(String(text ?? '').replace(/\r\n/g, '\n'))) {
    if (info.inFence) continue
    const body = markerBodyOf(info.line)
    if (body === undefined) continue
    const m = MARKER_KIND_RE.exec(body)
    if (!m) continue
    const kind = m[1]
    const rest = m[2].trim()
    out.push({
      body,
      kind,
      id: kind === 'begin' || kind === 'end' ? rest : undefined,
      what: kind === 'fill' ? rest : undefined,
      line: info.index + 1,
      index: info.index,
    })
  }
  return out
}

/** 这份文本里有没有标记。`file` 用来判断该用哪种语法。 */
export function hasMarkers(text, file) {
  return parseMarkers(text, file).length > 0
}

/**
 * 剥掉所有标记行，其余字节一个不动。
 *
 * 用于 `--clean`：围栏之外、又不是行内举例的标记行**全部**去掉——`generated`、`fill`、
 * `begin`、`end` 一视同仁。这么做是因为 `--clean` 的承诺是「把痕迹清干净」：
 * 留下孤零零的 begin/end 等于把「这里曾经被脚本管过」写进用户文件，
 * 而配对关系已经随命令一起消失了。**配对判断不在这一步**——那是 compose 的事，
 * 它比这里更清楚该留下哪一段正文。
 *
 * **围栏里的与行内反引号里的都不碰。** 这条不是洁癖：一份文档完全可能**正当地把标记
 * 写进示例**（`references/handoff.md` 就在讲它长什么样，README 里也会举一个填好的样子）。
 * 把那些一起剥掉，等于替使用者删掉了他自己的正文——而命令还报「已剥掉全部标记」。
 * 行内反引号那一档同理：`<!-- project-forge: begin X -->` 写在行内当例子，也是内容。
 */
export function stripMarkers(text, file) {
  if (markerSyntaxFor(file) === null) return text
  const source = String(text ?? '')
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const kept = scanLines(source.replace(/\r\n/g, '\n'))
    // 只删「围栏之外、又不是行内举例」的标记行。围栏本身与围栏里的内容原样留下——
    // 围栏是结构的骨架，删掉它等于把这门示例变成正文。
    .filter((info) => info.inFence || insideInlineCode(info.line)
      || markerBodyOf(info.line) === undefined)
    .map((info) => info.raw)
  return kept.join(eol)
}

/**
 * 这一行里，紧贴行首/行尾的标记是不是被反引号包着。
 *
 * 判据刻意放松：只要这一行**同时含有**反引号与标记，就当成「举例」而不剥。
 * 收紧一点（精确配对反引号区间、判断标记落在哪一对之间）当然做得到，但那需要一套
 * 行内代码解析器；而这里要防的是「把示例当标记删掉」，误判的代价只是**少删一行**
 * ——用户看到它还留着，手工删掉即可。反过来误删是**删掉正文**，不可逆。
 * 两个方向的代价不对称，所以选宽松的那一侧。
 */
function insideInlineCode(line) {
  if (!line.includes('`')) return false
  return new RegExp('`[^`]*<!--|<!--[^>]*-->`').test(line)
    || new RegExp('`[^`]*#\\s*' + NS_RE + ':').test(line)
}

/**
 * 找出文本里的 `begin <id>` / `end <id>` 配对区间，返回 `[{ id, start, end, customized }]`。
 *
 * `start`/`end` 都是标记行本身的下标，**区间内容不含这两行**。配不上对的区间不返回，
 * 而是在 `broken` 里报出——半对锚点意味着文件被手工改坏了，此时正确动作是报出来让人看，
 * 不是猜一个位置去覆盖。
 *
 * ## `customized`：这一段归人了
 *
 * 模板里的受管区间分两种：**由事实推出来的**（命令、分支名、协作流程）与**要人写的**
 * （项目定位、关键不变量）。前者一个字节都不该跟模板不同，后者一旦填过就不该再动。
 *
 * 但还有第三种情况，它本来无处安放：**人把项目自己的规矩融合进了事实推出的那一段**。
 * 例如这个项目用 changesets 发版、用 GitFlow 切分支——模板那套默认话术对它是错的，
 * 而改写之后本该保留。用「有没有 `fill`」判不出来（那一节没有 fill），于是：
 *
 *   - 改写它 → `--check` 报漂移；
 *   - 不跑刷新 → 模板以后加的规则永远进不来；
 *   - 跑一次刷新 → 改写被冲掉。
 *
 * `begin <id> customized` 把这一段的归属明确成「人接管了」：刷新不碰、漂移不比、
 * 报告里点名。它的语义只有这一条，不引入新的标记类别——`end` 只按 id 配，
 * 不看这个 flag。
 */
export function markerRegions(text, file) {
  const markers = parseMarkers(text, file)
  const regions = []
  const broken = []
  const open = new Map()
  for (const mark of markers) {
    if (mark.kind === 'begin') {
      const { id, customized } = parseBeginMark(mark.id)
      if (open.has(id)) broken.push(id)
      open.set(id, { index: mark.index, customized })
    } else if (mark.kind === 'end') {
      const { id } = parseBeginMark(mark.id)
      const opened = open.get(id)
      if (opened === undefined) { broken.push(id); continue }
      open.delete(id)
      regions.push({ id, start: opened.index, end: mark.index, customized: opened.customized })
    }
  }
  for (const id of open.keys()) broken.push(id)
  return { regions, broken }
}

/** `begin` 那一行正文的解析：`<id>` 后面可以跟一个 `customized`。**只有这一处**。 */
export function parseBeginMark(rest) {
  const text = String(rest ?? '').trim()
  const m = /^(.*?)\s+customized$/.exec(text)
  if (m === null) return { id: text, customized: false }
  return { id: m[1].trim(), customized: true }
}

/**
 * 读取预算。这几个数写在代码里而不是文档里，因为文档里的数字没人核。
 *
 * `SKILL_MAX_LINES` 是入口的上限：入口每多一行，每一次任务都要多付一次。
 * `FULL_READ_MAX_LINES` 是一次全量任务的必读量上限（入口 + 四篇主干参考）。
 *
 * 预算定的是**上限**，不是目标。抬上限的唯一正当理由是「新加的那几行改变了判定」；
 * 仅仅因为写得更啰嗦就越界时，改的是文档，不是这个数。
 */
export const SKILL_MAX_LINES = 200
export const SKILL_MAX_BYTES = 16 * 1024
export const REFS_MAX_LINES = 2400
export const FULL_READ_MAX_LINES = 1000

/** 一次全量任务必读的那几篇（相对 skill 根）。preflight 用它算预算。 */
export const FULL_READ_REFS = Object.freeze([
  'references/survey.md',
  'references/version-control.md',
  'references/docs-set.md',
  'references/remote-github.md',
])

/** 契约与工程套件预算上限（单一真相源）。 */
export const AGENTS_MAX_BYTES = 30720
export const AGENTS_WARN_BYTES = 24576
export const KIT_SKILL_MAX_LINES = 180
export const PF_MANIFEST_SCHEMA_VERSION = 2
export const EQUIP_TIERS = Object.freeze(['lightweight', 'full'])
export const LIGHTWEIGHT_KIT_SKILLS = Object.freeze([
  'dev-explore',
  'dev-plan',
  'dev-flow',
])
export const KIT_SKILLS = Object.freeze([
  'dev-explore',
  'dev-plan',
  'dev-flow',
  'dev-review',
  'dev-govern',
])

/** macOS Finder / 归档器常见元数据条目名，跨全链路扫描与打包校验统一过滤。 */
export const MACOS_METADATA_NAMES = Object.freeze([
  '.DS_Store',
  '__MACOSX',
  '.Spotlight-V100',
  '.Trashes',
  '.fseventsd',
  '.AppleDouble',
  '.TemporaryItems',
])

export function isMacOsMetadata(name) {
  const base = String(name ?? '')
  if (!base) return false
  if (base.startsWith('._')) return true
  return MACOS_METADATA_NAMES.includes(base)
}

export function isMacOsMetadataPath(rel) {
  return String(rel ?? '').replace(/\\/g, '/').split('/').some((seg) => isMacOsMetadata(seg))
}

/** 受管套件清单与工作区状态相对路径。 */
export const PF_MANIFEST_REL = '.agents/skills/.pf-manifest.json'
export const WORKTREES_STATE_REL = '.worktrees/.state'

/** 对外产物层严禁出现的非 GitHub 托管平台或旧式版本库字样。 */
export const FORBIDDEN_PLATFORM_RE = new RegExp(
  '\\b(?:' + [
    'Git' + 'Lab',
    'Git' + 'ee',
    'Bit' + 'bucket',
    'Code' + 'berg',
    'Sub' + 'version',
    'S' + 'VN',
  ].join('|') + ')\\b',
  'i',
)

// ── 模板语法：只活在 templates/ 里，绝不落进项目文件 ──────────────────
//
// 这一节与上面那四类标记**不是同一层东西**，分开定义是刻意的：
//
//   - `begin`/`end`/`fill`/`generated` 会**留在项目文件里**，所以 `parseMarkers` 认它们，
//     `review` 判它们、`handoff` 找它们、`--clean` 剥它们；
//   - `if`/`endif` 与 `{{VAR}}` 只在**渲染之前**存在。渲染完必须一个都不剩——
//     项目文件里出现 `project-forge: if` 就说明条件求值漏了一层，`preflight` 会判红。
//
// 两者共用同一个「标记正文」提取函数（`markerBodyOf`），所以语法永远只有一份。

/**
 * 模板里可用的条件名，全部来自勘察事实。
 *
 * 加一个条件的代价是：它在模板里能改变一份契约的结构，而在每个项目上都要被求值一次。
 * 所以条件只表达**结构差异**（有没有远端、发不发布、是不是插件、有没有自有技能），不表达措辞偏好。
 * `preflight` 核对模板里用的条件名都在这个表里——写错一个字母时，那一整块会被静默丢掉。
 *
 * 成对的条件（`has-commands` / `no-commands`、`has-remote` / `no-remote`）是刻意的：
 * 一个条件只管「有」的那一侧，另一侧要么靠 `if` 里写否定（模板层多一套语法），要么靠
 * **把两种情况各自的正文分开写**。选后者，因为两种情况的正文往往不只是措辞差别——
 * 「有远端」讲的是分支与 PR，「没有远端」讲的是只有本地提交时怎么兜底。
 */
export const TEMPLATE_CONDITIONS = Object.freeze([
  'has-commands',
  'no-commands',
  'has-remote',
  'no-remote',
  'has-release',
  'is-monorepo',
  'is-plugin-or-skill',
  'has-bilingual-docs',
  'has-custom-skills',
  'is-lightweight',
  'is-full',
])

/**
 * 模板里可用的变量名。**只有这一份清单说了算**。
 *
 * 未登记的占位符让渲染**直接失败**，而不是原样留在用户文件里：留在文件里的 `{{X}}`
 * 看起来像「这里本来就该有东西」，而它其实是一个没人填的洞。
 *
 * 不写「共几个」：数量写在注释里时，加一个变量就变成一句假话，而没有任何东西会因此报错。
 * 要知道数量，数这个数组——`preflight` 也会在渲染核对时把没登记的占位符点出来。
 */
export const TEMPLATE_VARS = Object.freeze([
  'PROJECT_NAME',
  'COMMANDS',
  'RUNTIME_REQUIREMENTS',
  'DEFAULT_BRANCH',
  'VERSION_SOURCE',
  'RELEASING_DOC',
  'RELEASE_NOTES_TARGET',
  'WORK_DIR',
  'COMMIT_STYLE_HINT',
  'README_LIST',
  'WORKSPACE_PACKAGES',
  'CONVENTIONS_HINT',
  'CUSTOM_SKILLS_BLOCK',
])

/**
 * 解析模板里的条件标记，返回按行号排列的 `{ kind, cond, line, index }`。
 *
 * `kind` 是 `if` 或 `endif`；`cond` 只有 `if` 有值。**配不上对不是这里的事**——
 * 求值器负责报「if 没有对应 endif」，这一层只做词法。
 */
export function conditionMarkers(text, file = 'template.md') {
  if (markerSyntaxFor(file) === null) return []
  const out = []
  for (const info of scanLines(String(text ?? '').replace(/\r\n/g, '\n'))) {
    if (info.inFence) continue
    const body = markerBodyOf(info.line)
    if (body === undefined) continue
    const m = /^(if|endif)\b\s*([\s\S]*)$/.exec(body)
    if (!m) continue
    out.push({ kind: m[1], cond: m[1] === 'if' ? m[2].trim() : undefined, line: info.index + 1, index: info.index })
  }
  return out
}

/** 这份文本里出现的全部占位变量名（去重、按出现顺序）。 */
export function templateVarsOf(text) {
  return [...new Set([...String(text ?? '').matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))]
}

/**
 * 常见的默认分支名。
 *
 * 两个用途，都在同一处定义：`survey` 拿它当**闸门**（只有当前分支落在这里面，才允许把
 * 「当前分支」当默认分支用），`compose` 拿它当**掩码**（比对受管区间时把这些名字抹掉，
 * 免得换台机器跑就报漂移）。
 *
 * 它是**一份与环境无关的固定集合**，不是「已知的默认分支清单」——分支叫 `release/x`
 * 的项目照样是合法项目，只是那个名字不能当默认分支用。
 */
export const LIKELY_DEFAULT_BRANCHES = Object.freeze(['main', 'master', 'trunk', 'develop', 'default', 'development'])

// ── 用户包边界 ──────────────────────────────────────────────────────
//
// 仓库里的文件分两类：**随包分发**的与**只服务本仓库**的。分野由结构与门禁共同保证，
// 不靠任何人工清单——清单要人记得改，漏一行就开始说假话。
//
// 判据落在**哪几处**上，而不是逐文件列表：那几处在一年里可能一次都不变。
// 新增自用文件只做一件事：放进已有的那几处（自用脚本进 `scripts/dev/`、工作记录进
// `docs/work/`、协作设施进 `.github/`）——那一整目录本来就不进包，不用改任何清单。

/** 不进包的目录（与 `.gitattributes` 的 `export-ignore` 对应；`kit/` 保留进用户包）。 */
export const REPO_ONLY_DIRS = Object.freeze([
  '.agents/',
  '.github/',
  'docs/',
  'scripts/dev/',
])

/** 不进包的所有目录前缀（与 `REPO_ONLY_DIRS` 同源）。 */
export const REPO_ONLY_PREFIXES = REPO_ONLY_DIRS

/** 不进包的顶层单文件。它们没有目录可以承载，只能逐条列。 */
export const REPO_ONLY_FILES = Object.freeze([
  'AGENTS.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
  '.gitattributes',
  '.gitignore',
])

/**
 * 这个相对路径属不属于「只服务本仓库」。
 *
 * ## 判据必须与 git 自己的语义一致
 *
 * `.gitattributes` 里写的是 `/docs/` 这样的**目录规则**：git 只排除那个目录**里面**的东西，
 * 不排除一个恰好叫 `docs` 的普通文件。这一点实测过：仓库里放一个名为 `docs` 的文本文件，
 * 它照样进用户包。
 *
 * 所以这里**只做前缀匹配**，不接受裸名。早先那种「`p === 'docs'` 也算命中」的写法会与 git
 * 分叉，而分叉的那一侧不是多报一条，是 `update.mjs` 会**删掉用户一个叫 docs 的文件**——
 * 依据是一条它根本不满足的规则。
 *
 * 大小写按字面比：git 在 Windows 上默认不区分，所以 `DOCS/x.md` 这个写法在这里判不出来。
 * 那个方向的错是**漏判**，由 `preflight` 的产品层白名单兜住——它会报「这个条目没有归属」
 * 让人来看，不会静默放行。
 */
export function isRepoOnlyPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  if (REPO_ONLY_FILES.includes(p)) return true
  return REPO_ONLY_PREFIXES.some((d) => p.startsWith(d))
}

/**
 * 从来源地址推出可下载的接口地址。认不出返回 undefined——**不猜**。
 *
 * 两条路：先试接口路（一次请求同时给出标签与附件位置，不碰网页主机），
 * 猜不出就返回 undefined，由调用方退回网页路。
 *
 * ## 返回值只给**能直接用的地址**
 *
 * `latest` 是拼好的完整地址，调用方原样拿去请求。这一点是刻意的：接口地址由三段
 * 常量与两个路径段组成，任何一段拼错都得到一个**看起来合法、实际 404** 的地址，
 * 而 404 在调用方那里的含义是「那边没有最新发布」——一个看起来像事实的错误结论。
 * 所以拼装只在这里做一次，调用方不碰 `owner` / `name` / `base` 这些零件。
 *
 * `repo` 是归一后的 `owner/name`，只用于**比对**（这个地址是不是同一个仓库），
 * 不用于拼地址。
 */
export function apiTarget(source) {
  if (typeof source !== 'string') return undefined
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(source.trim())
  if (!m) return undefined
  const repo = `${m[1]}/${m[2]}`
  return {
    kind: 'github',
    latest: `https://api.github.com/repos/${repo}/releases/latest`,
    repo,
  }
}
