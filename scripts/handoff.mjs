#!/usr/bin/env node
/**
 * handoff.mjs —— 交棒前的痕迹勘察（只读）
 *
 * 解决什么问题：这个 skill 跑完一个项目之后，目标项目里会留下它的痕迹——标识符、
 * 没填完的模板占位符、注入中断留下的临时文件、几乎逐字照抄自本 skill 模板的文件、
 * 以及指向本 skill 自己文件树的悬空指针。这些东西此前没有任何机制找得出来，于是
 * 「交棒」与「撤销」只能靠人记，而记忆在项目一多就会漏。漏掉的那一份留在对方的
 * 项目里，对方接手后看着像自己写的。
 *
 * 这个脚本只做一件事：**找出并分类**。它绝不写任何文件，也绝不替人决定拆不拆——
 * 拆除是不可逆动作，判据在 references/handoff.md，由人拍板。
 *
 * **它只说「哪里有、是什么」，不说「怎么办」。** 处置是判断，它归协议那张表管：脚本与
 * 协议各写一份，同一件事就有两份，协议改了一句而脚本还在给旧答案，两边都没有检查
 * 盯得住。所以每条命中带一个机器可读的 `kind`，处置由协议按 `kind` 查表得出；
 * 报告里每组都写明「处置去哪张表查」。
 *
 * 什么时候不该用它：
 *   - 想让它「把痕迹清掉」：它只读，报告完了还得有人动手；
 *   - 目标项目**本身就是关于本 skill 的项目**（给这个 skill 写文档、fork 它做二次开发）：
 *     那时 AGENTS.md 里出现 project-forge 标记是**内容**而不是痕迹，报告里的每一处
 *     命中都需要人重新判读；
 *   - 拿「相似度」当判决：相似不等于痕迹，所以相似那一组不参与干净判定。
 *
 * 用法：
 *   node scripts/handoff.mjs <项目目录> [--scan|--verify] [--json]
 *     --scan     勘察并输出痕迹清单（默认）。它是一份报告，退出码恒为 0。
 *     --verify   判定「已经没有任何 project-forge 的痕迹」：干净退出 0，不干净退出 1。
 *     --json     输出机器可读结果。
 *   目录省略时取当前目录。参数错误打印用法，退出 2。
 *
 * 依赖：只用 Node 内置模块。无第三方依赖，跨平台。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// 标记字面量只有一个来源：survey.mjs 里的那几枚常量。与 KERNEL_START 同一条理由——
// 这些字面量都有三个消费方（注入、自检、交付门禁），各写一份时对不上不会有任何东西出声。
import {
  KERNEL_START, KERNEL_END, MANAGED, UPGRADED, SUMMARY_MARKER,
  SKIP_DIRS, MAX_WALK_DEPTH, MAX_WALK_ENTRIES, CONTENT_SCAN_MAX_BYTES,
  frontmatterBlock, isMainModule, scanLines, fencedSpans,
} from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const TEMPLATES_DIR = join(SKILL_ROOT, 'templates')
const SKILL_ENTRY = join(SKILL_ROOT, 'SKILL.md')

/** 单文件超过这个字节数就不读：痕迹标记与占位符不会出现在几十兆的产物里，而读完很贵。 */
const MAX_FILE_BYTES = CONTENT_SCAN_MAX_BYTES
/** 前多少字节里出现 NUL 就判为二进制。 */
const BINARY_HEAD_BYTES = 8192

const USAGE = [
  '用法：node scripts/handoff.mjs <项目目录> [--scan|--verify] [--json]',
  '',
  '  --scan     勘察并输出痕迹清单（默认）。它是一份报告，退出码恒为 0。',
  '  --verify   判定项目里是否已经没有任何 project-forge 的痕迹：干净退出 0，不干净退出 1。',
  '  --json     输出机器可读结果（groups / clean / findings / blocking / scanned）。',
  '',
  '  只读：本脚本不写任何文件。拆不拆、怎么拆由人决定，判据见 references/handoff.md。',
].join('\n')

// ── A 组：带本 skill 标识符的命中 ───────────────────────────────────────────

/**
 * 每条规则的四个部分：**判据（正则）、机器可读的种类、命中时给人看的字面量、这是什么**。
 *
 * **没有「怎么处理」**：处置是判断，它归 `references/handoff.md` 那张表管。脚本与协议
 * 各写一份，同一件事就有两份——协议改了一句，脚本还在给旧答案，而两份都没有检查
 * 盯得住（检查本身就是拿其中一份去比另一份的）。所以脚本只说「哪里有、是什么」，
 * `kind` 是机器可读的种类标识，处置由协议按 `kind` 查表得出。
 *
 * 「这是什么」必须逐条写出来，不能只报一个命中位置：交棒的人读到「AGENTS.md:18 有个
 * 标记」时不知道那是什么，而不同标记要问的问题**根本不同**。
 *
 * 判据一律用**带注释外壳的完整标记**（`<!-- … -->`）或明确的标识符，不写半截形状：
 * 半截形状（只写 `pf:if`）会把正文里提到它的说明文字也算成命中。
 */
const MARKER_RULES = [
  {
    kind: 'kernel-start',
    re: new RegExp(escapeRe(KERNEL_START), 'g'),
    literal: KERNEL_START,
    what: '通用内核区的起始边界标记（与 project-forge:kernel:end 成对出现）',
  },
  {
    kind: 'kernel-end',
    re: new RegExp(escapeRe(KERNEL_END), 'g'),
    literal: KERNEL_END,
    what: '通用内核区的收尾边界标记（与 project-forge:kernel:start 成对出现）',
  },
  {
    kind: 'managed',
    re: new RegExp(escapeRe(MANAGED), 'g'),
    literal: MANAGED,
    what: '这份 AGENTS.md 的节结构由脚本决定',
  },
  {
    kind: 'upgraded',
    re: new RegExp(escapeRe(UPGRADED), 'g'),
    literal: UPGRADED,
    what: '这份 AGENTS.md 的结构已按模板升级过（它缺的那些节是待办，不是缺陷）',
  },
  {
    kind: 'inject-control',
    // 四种控制标记的字面量**各报各的**：它们要问的问题不一样（脚手架块整块处理，
    // 条件标记要逐段核对事实），报成一个四选一的串，读者就得自己回去猜命中的是哪个。
    re: /<!--\s*pf:(endscaffold|scaffold|endif|if)\b[^>]*-->/g,
    literalFrom: 1,
    literalPrefix: 'pf:',
    what: (name) => (name.endsWith('scaffold')
      ? '注入过程的脚手架标记（待填写项归零后自动移除），正常注入后不会残留'
      : '注入过程的条件标记（段落按项目事实取舍），正常注入后不会残留'),
  },
  {
    kind: 'needs-summary',
    re: new RegExp(escapeRe(SUMMARY_MARKER), 'g'),
    literal: SUMMARY_MARKER,
    what: '发布说明草稿的「还没写完」标记，正常不出现在目标项目里',
    suspect: true,
  },
  {
    kind: 'claims',
    re: /<!--\s*pf:claims\b[^>]*-->/g,
    literal: 'pf:claims',
    what: '本 skill 自己的断言登记（只应存在于本 skill 的卡片与 AGENTS.md 里）',
    suspect: true,
  },
  {
    kind: 'freshness-marker',
    re: /<!--\s*[A-Za-z0-9-]+-verified\b[^>]*-->/g,
    literal: '<scope>-verified',
    what: '本 skill references 里的外部事实保鲜标记，不写进目标项目',
    suspect: true,
  },
]

/**
 * 「交付还没做完」的占位标记，**单独成组**。
 *
 * 它与别的标识符不是一类东西：别的标识符是「skill 装进来的」，而它是「还没写完」。
 * 混在同一组里，读者看见同组的三类都是「删掉」，就会顺手把它一起删掉——删掉标记而
 * 不补内容，交出去的是一份**干净但空**的契约，而机器判它干净。
 */
const UNFINISHED_RULE = {
  kind: 'author-placeholder',
  // 标记可以写成多行（`<!-- pf:author:` 换行后 `-->`），所以这里不能用「不含换行」的
  // 字符类——那正是逐行扫会漏掉它们的原因（compose-agents 与 review 都因此漏过）。
  re: /<!--\s*pf:author\b[\s\S]*?-->/g,
  literal: 'pf:author',
  what: '待填写的占位：这一节还没写完，交付没完成（标记留着就是待办，删掉标记不等于填了内容）',
}

/**
 * **不算痕迹**的标记，刻意不写成规则。
 *
 * `<!-- toc:start -->` / `<!-- toc:end -->` 是 sync-toc.mjs 的**通用**目录标记，不专属
 * 本 skill——别的工具也在用同样的形状，把它算成痕迹会让人去删掉一个正在被别的工具
 * 维护的区块。所以这里没有它，也不会有它。
 *
 * 上面三条**要报**的（pf:needs-summary、pf:claims、<scope>-verified）性质不同：它们正常
 * 只存在于本 skill 自己的文件里，出现在目标项目属于异常——异常要报出来，但机器判不准它
 * 是不是「人故意引用的」，所以标为「疑似」交给人确认。
 */

// ── B 组：未替换的模板占位符 ───────────────────────────────────────────────

/**
 * `{{TOKEN}}` 形态的占位符。
 *
 * 「中间是标识符」是判据的一部分：`{{` 与 `}}` 之间必须是标识符（字母或下划线开头），
 * 否则示例里的 `{{...}}`、`{{路径}}` 这类写法会全被算成未填完。
 */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * **本 skill 自己造的** `{{TOKEN}}` 取值名。
 *
 * 这一层是必需的，理由是一个实测出来的误伤：`{{ title }}`、`{{ page_title }}`、
 * `{{ cardTitle }}` 这些是 Vue / Jinja / Handlebars / Go template 的**正常语法**，
 * 与「模板没填完」形状完全一样。只看形状时，一个正常的 Vue 项目跑 `--verify` 会
 * 退出 1 并被告知「填掉或删掉」——照着做就是删掉使用者模板里的变量名。
 *
 * 判据因此从「形状像不像」换成「**这个名字是不是我们的**」：只有本 skill 的模板真的
 * 用过的取值名，才算未填完的占位符。名单由模板里实际出现的 `{{...}}` 反推，不手写，
 * 所以模板新增取值时这里自动跟上，不会漂。
 */
const SKILL_TOKENS = (() => {
  const out = new Set()
  const walk = (sub) => {
    let entries = []
    try { entries = readdirSync(join(TEMPLATES_DIR, sub), { withFileTypes: true, encoding: 'utf8' }) } catch { return }
    for (const e of entries) {
      const rel = sub === '' ? e.name : `${sub}/${e.name}`
      if (e.isDirectory()) { walk(rel); continue }
      let text = ''
      try { text = readFileSync(join(TEMPLATES_DIR, rel), 'utf8') } catch { continue }
      for (const m of text.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) out.add(m[1])
    }
  }
  walk('')
  return out
})()

/**
 * 尖括号占位符：`<安装命令>`、`<清单声明的版本>`、`<owner>/<repo>` 这类。
 *
 * **必须限定形状**，不能裸判 `<`——HTML 标签、JSX、泛型 `Array<T>`、比较运算都在用它。
 * 判据取「尖括号里是中文，或是一个明显的人话短语（含空格/以命令结尾的名词）」，并且
 * 要求它出现在会被替换的位置上。
 *
 * 这一条补的是一个真实漏判：CI 模板用 `<安装命令>` 标未替换的位置，而旧判据只认
 * `{{TOKEN}}`。于是把模板注释块删掉之后，`--verify` 报「已经是干净状态」，而工作流
 * 里还是空壳——跑起来必红。
 */
const ANGLE_PLACEHOLDER_RE = /<([\u4e00-\u9fa5][^<>\n]{0,58}|[A-Za-z][A-Za-z0-9 _-]{2,58}(?:命令|版本|步骤|路径|名称|地址|名字))>/g

// ── C 组：注入残留 ─────────────────────────────────────────────────────────

/**
 * 原子写入留下的临时文件。
 *
 * 形状是「原名 + `.tmp-` + 进程号」：脚本先写临时文件再改名，中途被杀就留下它。
 *
 * **只有本 skill 的脚本写过的那些文件留下的才算确定痕迹**。本 skill 往目标项目里
 * 写的文件是两个脚本各管一头：`AGENTS.md`（注入脚本）与 `README.md` /
 * `README.en.md`（目录同步脚本）。这几个名字是**本 skill 自己的产物约定**，不是目标
 * 项目的取值——将来哪个脚本开始写第三个文件，这里要跟着加。
 *
 * 别的工具也会留 `build.tmp-4242` 这种同名形状的临时文件——那不是本 skill 留下的，
 * 不该由本 skill 的报告说「删掉」，所以它们归「疑似」，且不计入干净判定（见协议里
 * 「不在清单里的东西不要顺手删」那一条）。
 */
const OWN_TMP_RE = /^(?:AGENTS\.md|README(?:\.en)?\.md)\.tmp-\d+$/
const ANY_TMP_RE = /\.tmp-\d+$/

/**
 * 发布说明草稿。
 *
 * 起草脚本的默认输出是「标签名 + `-notes.md`」，在目标项目目录里跑就会掉一个在那儿。
 * **文件名形态会撞上用户自己的文件**（`release-notes.md` 是极常见的项目文件），
 * 所以只按「标签段像版本号」认：版本号里带数字，而 `release` 这类词不带。
 *
 * 标为「疑似」且**不计入干净判定**：它可能是用户自己写给自己看的草稿，删不删由人决定；
 * 而它挡着验收的话，用户唯一的出路就是造个假文件骗过检查。
 */
const NOTES_DRAFT_RE = /^(.+)-notes\.md$/i

// ── D 组：与本 skill 模板高度相似的文件 ────────────────────────────────────

/**
 * 模板按扩展名分派到三种比对方式。
 *
 * **只读扩展名，不写死模板名单**：模板是 `templates/` 目录里的实际文件，某个模板被改名
 * 或新增，这里自动跟着变；写死一份名单的脚本会与磁盘漂移，而漂移的表现是「少报了一类
 * 模板衍生文件」——那正是这个脚本要抓的东西。
 */
const TEMPLATE_KINDS = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.txt': 'text',
}

/**
 * 各类的报告门槛：相似到这个程度才报出来。
 *
 * 门槛按类不同，因为**「像」的难度不同**：
 *   - markdown：模板的章节名大多也是常规 README 的章节名（安装、使用、许可……），
 *     门槛低了会把每个正常 README 都报一遍——一份永远在喊的报告等于不存在，所以要
 *     近乎全中才算模板衍生。
 *   - yaml：顶层键（`on:`、`jobs:`）人人都有，光比它们没有判别力；判别力来自 step 名，
 *     而拷贝之后作者常改 step 名，所以门槛比 markdown 松一档。
 *   - text（许可证一类）：逐字比较，接近逐字即算高度相似。
 */
const SIMILARITY_MIN = { markdown: 0.9, yaml: 0.75, text: 0.9 }

// ── F 组：指向本 skill 的悬空指针 ───────────────────────────────────────────

/**
 * 本 skill 自己的文件树里，**目标项目可能引用到**的那几处。
 *
 * 「可能引用到」是判据：目标项目里出现 `references/xxx.md`、`templates/xxx.yml`、
 * `scripts/xxx.mjs` 这样的路径时，只有当它**指向本 skill 真实存在的文件**时，它才是
 * 「指向本 skill 的指针」；否则那是目标项目自己的路径，不归这里管。
 *
 * 目录范围：`references/` 与 `templates/` 整棵树（专章在 `references/plugins/` 下），
 * `scripts/` 只取顶层——`scripts/dev/` 是本仓库自用的，不进用户包，注入文本不会指向它。
 * 清单**现场从磁盘读**，不写死：写死的名单会与磁盘漂移，而漂移的表现是「少报了一类
 * 指针」——那正是这个组要抓的东西。
 */
const SKILL_TREE_DIRS = ['references', 'templates']
const SKILL_TREE_SCRIPTS = 'scripts'

/**
 * 路径形状的引用：`references/<名>`、`templates/<名>`、`scripts/<名>`。
 *
 * 名的部分**允许子目录**（`references/plugins/dsh.md`）——层数不写死，目录树实际有
 * 几层就支持几层，判据交给后面那次 glob 匹配。写成「只能一层」的话，专章那一层
 * 的指针永远查不出来，而它恰恰是最该查出来的那类（插件类项目）。
 *
 * 名里可以带尖括号：`references/publish-<生态>.md` 是注入文本里的真实写法，尖括号里是
 * 变量而不是文件名。它按通配处理（`<...>` 展开成 `*`），于是它能匹配上
 * `references/publish-npm.md` 这一批专章——而写死成某个文件名就再也认不出新的专章。
 *
 * 名里**不收中文**（尖括号里的除外）：路径的其余部分要么是文件名，要么是标点收尾，
 * 把中文吃进来会把「见 references/publish.md 一节」里的「一节」也当成路径的一部分。
 */
const REFERENCE_RE = /\b(references|templates|scripts)\/([A-Za-z0-9_.\-/]*(?:<[^<>\n]{1,60}>[A-Za-z0-9_.\-/]*)*)/g

/**
 * 文档类扩展名：**给人读的散文**，不是机器照着跑的东西。
 *
 * 这条分界决定悬空指针的处置分支：出现在文档里的引用，读者读到的是一句话；出现在
 * 机器会照着跑的配置里的引用，是一条会真的被执行的调用——后者把脚本删了就悄悄坏掉。
 */
const DOC_EXT_RE = /\.(md|markdown|rst|txt|adoc|org)$/i

// ── 通用工具 ───────────────────────────────────────────────────────────────

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 相对项目根的路径，统一用正斜杠：它是给人核对与给别的脚本消费的，不是给文件系统用的。 */
function relPath(root, full) {
  return relative(root, full).split(sep).join('/')
}

/**
 * 读一个可扫描的文本文件；不可扫描时返回 undefined。
 *
 * 跳过三种文件：**二进制**（前 8KB 里有 NUL）、**太大**（超过单文件上限）、**读不出来**。
 * 判不出来与「里面没有东西」必须分开——前者是「没扫到」，后者是「扫过了、很干净」，
 * 混成一样时，报告里的「零命中」会被读成「扫过了」，而那正是最不能发生的误读。
 * 所以每一次跳过都记进 counters，由报告说出去。
 */
function readScannable(full, counters) {
  let size
  try {
    const st = statSync(full)
    if (!st.isFile()) return undefined
    size = st.size
  } catch {
    counters.unreadable += 1
    return undefined
  }
  if (size > MAX_FILE_BYTES) {
    counters.skippedLarge += 1
    return undefined
  }
  let buf
  try {
    buf = readFileSync(full)
  } catch {
    counters.unreadable += 1
    return undefined
  }
  const head = buf.subarray(0, Math.min(buf.length, BINARY_HEAD_BYTES))
  if (head.includes(0)) {
    counters.skippedBinary += 1
    return undefined
  }
  return buf.toString('utf8')
}

/** 每行起始位置，用来把字符偏移换算成行号。 */
function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') starts.push(i + 1)
  }
  return starts
}

/** 字符偏移 -> 行号（1 起）。二分查找，命中多时也不至于把时间全花在数换行上。 */
function lineOf(starts, index) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= index) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// ── 遍历 ───────────────────────────────────────────────────────────────────

/**
 * 走一遍项目目录，取出要扫的文本文件。
 *
 * 三条范围判据，各有各的理由：
 *   - **跳过 `.git/`**：版本控制元数据里存的是本 skill 注入过的历史版本，全是命中，
 *     报出来只是噪音；而且它不是「目标项目现在的内容」。
 *   - **跳过依赖与缓存目录**（node_modules 之类）：规则直接取自 survey.mjs 的那张表，
 *     不另立一份——各写一份名单，迟早出现一个脚本没跳、于是把几百兆依赖读进来。
 *   - **不应用项目的 `.gitignore`**：痕迹恰恰**常在被忽略的文件里**（注入中断留下的
 *     `*.tmp-*`、本地起草的发布草稿）。按忽略规则扫，恰好把最该找的那一类漏掉。
 *
 * 深度与条目数有硬上限：递归遍历在超大仓库上能跑成天，而上限超了之后「扫过了」这句话
 * 就不成立了——所以宁可少扫，也要把「没扫全」说出来（见 scanned 计数）。
 */
function collectFiles(root, onlyFile) {
  const files = []
  const dirs = []
  const scanned = {
    files: 0,
    dirs: 0,
    truncated: false,
    depthLimited: 0,
    unreadable: 0,
    skippedLarge: 0,
    skippedBinary: 0,
    partial: false,
  }
  // 目标给的是**文件**时只扫那一个：扫它的父目录等于扫了另一个项目。
  if (onlyFile !== undefined) {
    files.push({ rel: basename(onlyFile), full: onlyFile, name: basename(onlyFile) })
    scanned.files = 1
    scanned.partial = true
    return { files, dirs, scanned }
  }
  const stack = [{ dir: root, depth: 0 }]
  let seen = 0
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()
    if (depth > MAX_WALK_DEPTH) {
      scanned.depthLimited += 1
      continue
    }
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      // 读不出来的目录要**计数**：跳过它等于整棵子树没进勘察，而「没扫到」与
      // 「里面没有东西」在报告里长得一样——「零命中」会被读成「扫过了、很干净」。
      scanned.unreadable += 1
      continue
    }
    // 按码位排：同一份输入在不同文件系统上给出不同顺序的报告，是这个工具最不该有的性质。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (seen > MAX_WALK_ENTRIES) {
        scanned.truncated = true
        return { files, dirs, scanned }
      }
      seen += 1
      const full = join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        dirs.push({ rel: relPath(root, full), name: entry.name })
        stack.push({ dir: full, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      files.push({ rel: relPath(root, full), full, name: entry.name })
    }
  }
  scanned.files = files.length
  scanned.dirs = dirs.length
  return { files, dirs, scanned }
}

// ── 模板侧 ─────────────────────────────────────────────────────────────────

/**
 * 把 HTML 注释挖空（保留行数与列位），这样注释里的标题不会被当成章节。
 *
 * 模板里有一整段「填写指引」注释，README 模板的那段里就写着 `## 目录` 与整份目录
 * 清单——那是给人看的说明，不是文档的节。按字面数标题会把说明算进去，于是相似度的
 * 分母里混进了几条根本不可能出现在目标文件里的标题。
 */
function blankHtmlComments(text) {
  const out = []
  let inComment = false
  for (const raw of text.split('\n')) {
    let result = ''
    let i = 0
    while (i < raw.length) {
      if (inComment) {
        const end = raw.indexOf('-->', i)
        if (end === -1) {
          result += ' '.repeat(raw.length - i)
          break
        }
        result += ' '.repeat(end + 3 - i)
        i = end + 3
        inComment = false
        continue
      }
      const start = raw.indexOf('<!--', i)
      if (start === -1) {
        result += raw.slice(i)
        break
      }
      result += raw.slice(i, start)
      result += '    '
      i = start + 4
      inComment = true
    }
    out.push(result)
  }
  return out.join('\n')
}

/**
 * Markdown 的「标题行」：**二级及以下的 ATX 标题**。
 *
 * 不取一级标题：一级标题是文档自己的名字，模板里常常是占位符（README 模板的一级标题
 * 就是「项目名」），它相同几乎不说明这份文档是从模板衍生的；章节结构才说明。
 *
 * 围栏内的标题不算——文档里在代码块里展示 `## 用法` 是正常写法；HTML 注释里的也不算
 * （那是给人看的说明，不是节）。
 */
function markdownTitles(text) {
  const out = []
  for (const info of scanLines(blankHtmlComments(text))) {
    if (info.inFence || info.heading === null) continue
    if (info.heading.level < 2) continue
    out.push(info.heading.title.trim())
  }
  return out
}

/**
 * YAML 的「标题行」：**顶层键行 + `name:` 字段**。
 *
 * 只取顶层键是不够的：`on:`、`jobs:` 每个 GitHub Actions 工作流都有，比它们等于没比，
 * 每个工作流都会「像」模板。`name:` 字段（工作流名与每个 step 的名字）才是 YAML 里与
 * 标题同形的东西，它带上之后，一个手写工作流与模板的相似度会掉到门槛以下。
 */
function yamlTitles(text) {
  const out = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (/^\s*#/.test(line)) continue
    const stripped = line.replace(/\s+#.*$/, '').trim()
    if (stripped === '') continue
    if (/^-\s+name\s*:/.test(stripped) || /^[A-Za-z_][A-Za-z0-9_.-]*\s*:/.test(stripped)) {
      out.push(stripped)
    }
  }
  return out
}

/** 模板的一行在目标文件里出现即算命中；`{{...}}` 当通配符（许可证模板的年份与署名）。 */
function lineMatcher(line) {
  if (!line.includes('{{')) return { exact: line, re: undefined }
  const parts = line.split(/(\{\{[^{}]*\}\})/g)
  const source = parts
    .map((p) => (/^\{\{[^{}]*\}\}$/.test(p) ? '.*' : escapeRe(p)))
    .join('')
  return { exact: undefined, re: new RegExp(`^${source}$`) }
}

// ── 通配与存在性 ───────────────────────────────────────────────────────────

/**
 * glob 转正则：**只支持 `*`**，且 `*` 不跨 `/`。
 *
 * 只有 `*` 一种就够：尖括号通配展开出来的正是它（`references/publish-<生态>.md` →
 * `references/publish-*.md`），而 `**` 那种「跨目录」语义会让「一个路径匹配到一堆目录」
 * 这类假象多到没法复核。
 */
function globRe(pattern) {
  const escaped = String(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '[^/]*')}$`)
}

/** 这个相对路径（可能带 `*`）在 base 下有没有对应的文件。 */
function existsUnder(base, rel) {
  const segments = rel.split('/')
  let current = [base]
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]
    const last = i === segments.length - 1
    const re = segment.includes('*') ? globRe(segment) : undefined
    const next = []
    for (const dir of current) {
      let entries = []
      try {
        entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
      } catch {
        continue
      }
      for (const entry of entries) {
        const hit = re === undefined ? entry.name === segment : re.test(entry.name)
        if (!hit) continue
        if (last) return true
        if (entry.isDirectory()) next.push(join(dir, entry.name))
      }
    }
    current = next
    if (current.length === 0) return false
  }
  return false
}

/**
 * 尖括号通配展开：`<生态>` → `*`。
 *
 * 注入文本里写的是「变量占位」，不是真实文件名；把它当通配符展开，才能既认出
 * `references/publish-<生态>.md` 这一类写法，又在新增专章时自动跟上（不写死名单）。
 */
function expandBrackets(token) {
  return token.replace(/<[^<>]{1,60}>/g, '*')
}

// ── 本 skill 侧 ────────────────────────────────────────────────────────────

/**
 * 本 skill 的名字（从入口文件的 frontmatter 取，读不到时退回目录名）。
 *
 * **不写死**：目录名是本 skill 的名字，不是某个项目的取值。
 */
function skillName() {
  try {
    const block = frontmatterBlock(readFileSync(SKILL_ENTRY, 'utf8'))
    if (block !== undefined) {
      const m = /^name:\s*(.+)$/m.exec(block)
      const name = m?.[1]?.trim().replace(/^["']|["']$/g, '')
      if (name !== undefined && name !== '') return name
    }
  } catch {
    /* 读不到就用目录名 */
  }
  return basename(SKILL_ROOT)
}

/** 本 skill 的状态目录名。 */
function stateDirName() {
  return `.${skillName()}`
}

/**
 * 本 skill 的文件树（相对路径 -> 绝对路径），**现场从磁盘读**。
 *
 * 与模板清单同一个理由：写死的名单会与磁盘漂移，而漂移的表现是「少认了一类指针」。
 */
function loadSkillTree() {
  const out = new Map()
  const walk = (dir, prefix) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      const rel = `${prefix}${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`)
      else if (entry.isFile()) out.set(rel, join(dir, entry.name))
    }
  }
  for (const dir of SKILL_TREE_DIRS) walk(join(SKILL_ROOT, dir), `${dir}/`)
  // scripts/ 只取顶层：scripts/dev/ 是本仓库自用的，不进用户包。
  const scriptsDir = join(SKILL_ROOT, SKILL_TREE_SCRIPTS)
  let entries = []
  try {
    entries = readdirSync(scriptsDir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (entry.isFile()) out.set(`${SKILL_TREE_SCRIPTS}/${entry.name}`, join(scriptsDir, entry.name))
  }
  return out
}

/**
 * 这个文件承载什么：一句话。
 *
 * Markdown 取首个一级标题（专章的标题就是它承载的那件事），脚本取顶部注释里
 * `文件名 —— 用途` 的用途那半句。报告里要能让人知道「项目里缺的是哪一段判据」，
 * 只报一个路径名是不够的。
 */
function fileSummary(absPath) {
  let text
  try {
    text = readFileSync(absPath, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
  const heading = /^#\s+(.+)$/m.exec(text)
  if (heading !== null) return heading[1].trim()
  const comment = /^\/\*\*\s*\n\s*\*\s*(.+)$/m.exec(text)
  if (comment !== null) {
    const line = comment[1].trim()
    const dash = line.indexOf('——')
    return dash === -1 ? line : line.slice(dash + 2).trim()
  }
  return ''
}

/** 读 templates/ 里的模板，按扩展名分派比对方式。 */
function loadTemplates() {
  let entries = []
  try {
    entries = readdirSync(TEMPLATES_DIR, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const kind = TEMPLATE_KINDS[extname(entry.name).toLowerCase()]
    if (kind === undefined) continue
    let text
    try {
      text = readFileSync(join(TEMPLATES_DIR, entry.name), 'utf8').replace(/^\uFEFF/, '')
    } catch {
      continue
    }
    const template = { name: entry.name, kind }
    if (kind === 'markdown') template.titles = markdownTitles(text)
    else if (kind === 'yaml') template.titles = yamlTitles(text)
    else {
      template.lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    }
    if (kind !== 'text' && template.titles.length === 0) continue
    if (kind === 'text' && template.lines.length === 0) continue
    out.push(template)
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return out
}

// ── 注释里的 skill 名字 ────────────────────────────────────────────────────

/**
 * 注释块的位置与文本。
 *
 * 两种形状：`<!-- … -->`（HTML 注释，Markdown 与 YAML 里都有）与整行的 `#` 注释
 * （YAML / TOML / shell / Python 那种形状）。模板顶部那块「按 TODO 逐项替换后删掉本
 * 注释块」的说明就是后者。
 *
 * **`#` 那一种只对非文档文件生效**：在 Markdown 里 `#` 开头的是标题（`# 项目名`），
 * 把它当注释会把每个文档的标题都算成注释——而文档标题里出现本 skill 的名字，多半是
 * 这个项目**就叫这个名字**，不是它留了痕迹。
 */
function commentSpans(text, includeLineComments) {
  const out = []
  for (const m of text.matchAll(/<!--[\s\S]*?-->/g)) out.push({ index: m.index, body: m[0] })
  if (!includeLineComments) return out
  let offset = 0
  for (const raw of text.split('\n')) {
    if (/^\s*#/.test(raw)) out.push({ index: offset, body: raw })
    offset += raw.length + 1
  }
  return out
}

/**
 * 注释里出现本 skill 的名字 —— 模板注释块的残留。
 *
 * **只认注释里的**：正文里提到本 skill 的名字不是痕迹（「本项目用 project-forge 配的」
 * 是合法陈述，而且协议的总判据本来就是人做的那一步）。注释里提到它是另一回事：模板
 * 顶部那块说明落盘到目标项目后该删掉，而机器原来看不见它。
 *
 * 已知的标记字面量先剔掉：`<!-- project-forge:kernel:start -->` 已经是 A 组的命中，
 * 再报一次「名字出现在注释里」就是把同一件事数两遍。
 */
function commentNameHits(text, name, includeLineComments) {
  const hits = []
  const known = [KERNEL_START, KERNEL_END, MANAGED, UPGRADED]
  for (const span of commentSpans(text, includeLineComments)) {
    let body = span.body
    for (const literal of known) body = body.split(literal).join('')
    if (!body.includes(name)) continue
    hits.push({ index: span.index, line: text.slice(0, span.index).split('\n').length })
  }
  return hits
}

// ── 相似度 ─────────────────────────────────────────────────────────────────

/**
 * 一个模板与一份目标文件的相似度。
 *
 * 返回 undefined 表示「这一对不适用」或「低到不值得报」。
 *
 * 三类的算法各不相同，各有各的理由（写在这里是为了让人能复核，而不是信任一个数字）：
 *   - **markdown**：模板的章节标题里，有多大比例出现在目标文件里。分母是模板的标题数。
 *   - **yaml**：顶层键行与 `name:` 行同上。
 *   - **text**：模板的非空行里，有多大比例能在目标文件里逐字找到（`{{...}}` 当通配符）。
 *     「逐字」是这里最严的一档：许可证正文一旦对上就是同一份法律文本，不靠相似度。
 */
function similarity(template, text, derived) {
  if (template.kind === 'markdown' || template.kind === 'yaml') {
    // 目标文件这一侧的标题集合**每个文件只算一次**：一份文件要跟好几个模板比，
    // 每次重算等于把同一份工作做 N 遍。
    if (derived[template.kind] === undefined) {
      derived[template.kind] = new Set(template.kind === 'markdown'
        ? markdownTitles(text)
        : yamlTitles(text))
    }
    const have = derived[template.kind]
    const matched = template.titles.filter((t) => have.has(t))
    const missing = template.titles.filter((t) => !have.has(t))
    const ratio = matched.length / template.titles.length
    if (ratio < SIMILARITY_MIN[template.kind]) return undefined
    return {
      similarity: ratio,
      unit: template.kind === 'markdown' ? '章节标题' : '顶层键与 name 行',
      matchedCount: matched.length,
      matched,
      missing,
      total: template.titles.length,
    }
  }
  // text：先只用「逐字行」估上界，估不到门槛就直接放弃——绝大多数文件在这里就被刷掉，
  // 不会走到逐行通配匹配那一步。
  if (derived.text === undefined) {
    const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    derived.text = { lines, set: new Set(lines) }
  }
  const { lines: targetLines, set: targetSet } = derived.text
  const exact = template.lines.filter((l) => !l.includes('{{'))
  const wild = template.lines.filter((l) => l.includes('{{'))
  let matched = 0
  for (const line of exact) {
    if (targetSet.has(line)) matched += 1
  }
  if ((matched + wild.length) / template.lines.length < SIMILARITY_MIN.text) return undefined
  for (const line of wild) {
    const m = lineMatcher(line)
    if (targetLines.some((t) => m.re.test(t))) matched += 1
  }
  const ratio = matched / template.lines.length
  if (ratio < SIMILARITY_MIN.text) return undefined
  return {
    similarity: ratio,
    unit: '逐字行',
    matchedCount: matched,
    matched: [],
    missing: [],
    total: template.lines.length,
  }
}

/** 这个文件对哪些模板适用：扩展名决定文档与 CI；逐字那一类对任何文件都试。 */
function applicableTemplates(templates, name) {
  const ext = extname(name).toLowerCase()
  return templates.filter((t) => t.kind === 'text'
    || (t.kind === 'markdown' && (ext === '.md' || ext === '.markdown'))
    || (t.kind === 'yaml' && (ext === '.yml' || ext === '.yaml')))
}

// ── 输出分组 ───────────────────────────────────────────────────────────────

/**
 * 每一组：标题、**处置去哪张表查**、以及这一组承载的是什么。
 *
 * 「处置去哪查」写在这里而不是写在每条命中里：处置是判断，它归协议管（见文件头）。
 * 写清节名与表名，读者才不用回头猜「这一条该怎么办」。
 */
const GROUPS = [
  {
    key: 'markers',
    title: '[A] 带本 skill 标识符的命中',
    pointer: '处置见 references/handoff.md 第四节「痕迹清单」的表，与第七节第三步的拆解顺序',
  },
  {
    key: 'unfinished',
    title: '[A2] 交付还没做完的占位（pf:author）',
    pointer: '这一组是「没做完」，不是「forge 的痕迹」——删掉标记不等于填了内容；'
      + '处置见 references/handoff.md 第七节第三步第 0 步（补齐交付）',
  },
  {
    key: 'placeholders',
    title: '[B] 未替换的模板占位符',
    pointer: '处置见 references/handoff.md 第四节「痕迹清单」与第七节第三步第 6 步',
  },
  {
    key: 'residue',
    title: '[C] 注入残留',
    pointer: '处置见 references/handoff.md 第四节「痕迹清单」与第七节第三步第 6 步',
  },
  {
    key: 'templateSimilar',
    title: '[D] 与本 skill 模板高度相似的文件（只作参考，交棒时不动任何文件；撤销时由人决定）',
    pointer: '这一组不是痕迹，见 references/handoff.md 第四节「一条不许搞反的：与模板相似的文件不是痕迹」',
  },
  {
    key: 'stateDir',
    title: '[E] 本 skill 的状态目录',
    pointer: '处置见 references/handoff.md 第四节「痕迹清单」',
  },
  {
    key: 'dangling',
    title: '[F] 指向本 skill 的悬空指针',
    pointer: '处置见 references/handoff.md 第六节「拆之前：先给规则找新家」那张表：'
      + 'kind=dangling-rule 查「指向本 skill 文件的指针」那一行，'
      + 'kind=dangling-script-in-automation 查「对某个发布脚本的调用」那一行，'
      + 'kind=dangling-name-collision 是同名不同物，机器判不出，由人判读',
  },
]

// ── 勘察 ───────────────────────────────────────────────────────────────────

function scan(root, onlyFile) {
  const { files, dirs, scanned } = collectFiles(root, onlyFile)
  const templates = loadTemplates()
  const skillTree = loadSkillTree()
  const name = skillName()
  const stateName = `.${name}`

  const markers = []
  const unfinished = []
  const placeholders = []
  const residue = []
  const stateDir = []
  const templateSimilar = []
  const dangling = []

  // ── E 组：状态目录 ──
  for (const dir of dirs) {
    if (dir.name !== stateName) continue
    stateDir.push({
      path: `${dir.rel}/`,
      line: null,
      match: dir.name,
      kind: 'state-dir',
      what: '本 skill 的状态目录',
      blocks: true,
    })
  }

  for (const file of files) {
    // ── C 组：按文件名认的残留 ──
    // 先判是不是本 skill 自己的写法：只有它才是确定痕迹，别的工具留下的同名形状
    // 归「疑似」，不计入干净判定（协议：不在清单里的东西不要顺手删）。
    const isOwnTmp = OWN_TMP_RE.test(file.name)
    const isAnyTmp = !isOwnTmp && ANY_TMP_RE.test(file.name)
    const notes = NOTES_DRAFT_RE.exec(file.name)
    const isNotesDraft = notes !== null && /\d/.test(notes[1])
    if (isOwnTmp) {
      residue.push({
        path: file.rel,
        line: null,
        match: file.name,
        kind: 'tmp-file',
        what: '原子写入留下的临时文件（本 skill 的写入方式：AGENTS.md 或 README 的 '
          + '.tmp-<进程号>）',
        blocks: true,
      })
    } else if (isAnyTmp) {
      residue.push({
        path: file.rel,
        line: null,
        match: file.name,
        kind: 'tmp-file-suspect',
        what: '临时文件，但不是本 skill 的写入方式（那只是 AGENTS.md 或 README 的 '
          + '.tmp-<进程号>）——可能是别的工具留下的，请确认后再处理',
        blocks: false,
        suspect: true,
      })
    }
    if (isNotesDraft) {
      residue.push({
        path: file.rel,
        line: null,
        match: file.name,
        kind: 'notes-draft',
        what: '发布说明草稿（起草脚本的默认输出是「标签名 + -notes.md」）——'
          + '也可能是用户自己写给自己看的草稿，删不删由人决定',
        blocks: false,
        suspect: true,
      })
    }

    const text = readScannable(file.full, scanned)
    if (text === undefined) continue
    const starts = lineStarts(text)

    // 围栏里的出现不算：文档在代码块里展示这对标记是正常写法（本项目的 references 就是
    // 这么写的），把它算进去会把一份好文件判成有痕迹。围栏判据取自 sync-toc.mjs 的
    // 那份实现，不另立一套状态机。
    //
    // 占位符**不**做同样的处理：模板里的 `{{COMMANDS}}` 本来就写在代码块里，而它留在
    // 目标项目里正是要报的那一类。
    const spans = fencedSpans(text)
    const inFence = (index) => spans.some(([a, b]) => index >= a && index < b)
    // 文档 = 给人读的散文；其余是机器会照着跑的配置或脚本。这一条决定悬空指针的
    // 处置分支（引用出现在哪种文件里）与「名字在注释里」那一条的注释形状。
    const isDocument = DOC_EXT_RE.test(file.name)

    // ── A 组：标识符 ──
    for (const rule of MARKER_RULES) {
      // 发布说明草稿里的 needs-summary 标记**不单独报**：文件名已经认出它是草稿了，
      // 再报一次就是把同一个文件数两遍，而两处的说法还不一样。
      if (isNotesDraft && rule.kind === 'needs-summary') continue
      rule.re.lastIndex = 0
      for (const hit of text.matchAll(rule.re)) {
        if (inFence(hit.index)) continue
        const name2 = rule.literalFrom === undefined ? null : hit[rule.literalFrom]
        const literal = name2 === null
          ? rule.literal
          : `${rule.literalPrefix ?? ''}${name2}`
        const what = typeof rule.what === 'function' ? rule.what(name2) : rule.what
        markers.push({
          path: file.rel,
          line: lineOf(starts, hit.index),
          literal,
          kind: rule.kind,
          what,
          blocks: true,
          ...(rule.suspect === true ? { suspect: true } : {}),
        })
      }
    }

    // 注释里出现本 skill 的名字：模板注释块的残留。
    for (const hit of commentNameHits(text, name, !isDocument)) {
      if (inFence(hit.index)) continue
      markers.push({
        path: file.rel,
        line: hit.line,
        literal: name,
        kind: 'skill-name-in-comment',
        what: '本 skill 的名字出现在注释里（模板顶部那块「按 TODO 逐项替换后删掉本注释块」'
          + '的说明落盘后留下的）',
        blocks: true,
      })
    }

    // ── A2 组：交付还没做完的占位 ──
    UNFINISHED_RULE.re.lastIndex = 0
    for (const hit of text.matchAll(UNFINISHED_RULE.re)) {
      if (inFence(hit.index)) continue
      unfinished.push({
        path: file.rel,
        line: lineOf(starts, hit.index),
        literal: UNFINISHED_RULE.literal,
        kind: UNFINISHED_RULE.kind,
        what: UNFINISHED_RULE.what,
        blocks: true,
      })
    }

    // ── B 组：未替换的占位符 ──
    //
    // 判据是「这个名字是不是本 skill 的」，不是「形状像不像占位符」。
    // 只看形状会把 Vue / Jinja / Handlebars 的正常变量判成没填完，而照那个建议去做
    // 就是删掉使用者模板里的变量名。
    PLACEHOLDER_RE.lastIndex = 0
    for (const hit of text.matchAll(PLACEHOLDER_RE)) {
      const token = hit[1]
      if (!SKILL_TOKENS.has(token)) continue
      placeholders.push({
        path: file.rel,
        line: lineOf(starts, hit.index),
        match: hit[0],
        kind: 'placeholder',
        what: `模板没填完的占位符（${token} 是本 skill 模板里的取值名）`,
        blocks: true,
      })
    }
    for (const hit of text.matchAll(ANGLE_PLACEHOLDER_RE)) {
      if (inFence(hit.index)) continue
      placeholders.push({
        path: file.rel,
        line: lineOf(starts, hit.index),
        match: hit[0],
        kind: 'placeholder',
        what: '模板没填完的占位符（尖括号里还是人话，没有换成实际值）',
        blocks: true,
      })
    }

    // ── D 组：与模板高度相似 ──
    let best
    const derived = {}
    for (const template of applicableTemplates(templates, file.name)) {
      const sim = similarity(template, text, derived)
      if (sim === undefined) continue
      if (best === undefined || sim.similarity > best.sim.similarity) {
        best = { template, sim }
      }
    }
    if (best !== undefined) {
      templateSimilar.push({
        path: file.rel,
        line: null,
        match: best.template.name,
        kind: 'template-similar',
        what: `与本 skill 的模板 ${best.template.name} 高度相似（${Math.round(best.sim.similarity * 100)}%，命中 ${best.sim.matchedCount}/${best.sim.total} 个${best.sim.unit}）`,
        blocks: false,
        similarity: best.sim.similarity,
        basis: {
          unit: best.sim.unit,
          matched: best.sim.matched,
          missing: best.sim.missing,
          total: best.sim.total,
        },
      })
    }

    // ── F 组：指向本 skill 的悬空指针 ──
    // 引用出现在**围栏之外**才算：文档里在代码块里举这个路径是举例说明，不是引用。
    const fileDir = dirname(file.full)
    REFERENCE_RE.lastIndex = 0
    for (const hit of text.matchAll(REFERENCE_RE)) {
      if (inFence(hit.index)) continue
      const prefix = hit[1]
      const token = hit[2].replace(/\.+$/, '')
      if (token === '') continue
      const probe = `${prefix}/${expandBrackets(token)}`
      // 指向的是不是本 skill 真实存在的文件？不是的话，那是目标项目自己的路径，
      // 不归这里管（目标项目有自己的 references/ 目录是常事）。
      const targets = [...skillTree.keys()].filter((p) => globRe(probe).test(p)).sort()
      if (targets.length === 0) continue
      // 目标项目里这个路径在不在？**查两处**：相对项目根、相对引用它的那个文件所在
      // 目录。两处都没有才算悬空——目标项目可能在自己子目录里有同名文件。
      if (existsUnder(root, probe) || existsUnder(fileDir, probe)) continue
      // 一处引用可能指向一批文件（`references/publish-<生态>.md` 这种通配写法）。
      // 指向多个时只报「几个文件」而不摘其中之一的标题——摘一个会让读者以为那处指针
      // 只欠一份文档，而它其实欠了一整族。
      const named = targets.length === 1
        ? `${targets[0]}（${fileSummary(skillTree.get(targets[0]))}）`
        : `${targets.length} 个文件（${targets.join('、')}）`
      // **分两类**：指向判据文档的，是「规则没搬过来」；指向脚本的，要看引用出现在
      // 哪里——出现在机器会照着跑的配置里，那条调用会真的被执行，脚本没了就是坏了；
      // 出现在文档里，那多半是**同名不同物**（另一个项目自己的同名脚本），机器分不出，
      // 交给人判读，且不计入干净判定。
      const isScript = prefix === 'scripts'
      let kind
      let what
      let blocks
      if (!isScript) {
        kind = 'dangling-rule'
        what = `指向本 skill 的 ${named}——目标项目里没有承接这段判据，读者按它去读会走到空处`
        blocks = true
      } else if (!isDocument) {
        kind = 'dangling-script-in-automation'
        what = `指向本 skill 的 ${named}——目标项目里没有这个脚本，而引用它的是机器会照着跑的东西`
        blocks = true
      } else {
        kind = 'dangling-name-collision'
        what = `本 skill 也有一个同名文件 ${named}，但目标项目里没有它——`
          + '这可能是项目自己的同名脚本（同名不同物），机器分不出来，由人判读'
        blocks = false
      }
      dangling.push({
        path: file.rel,
        line: lineOf(starts, hit.index),
        match: `${prefix}/${token}`,
        kind,
        what,
        blocks,
        ...(blocks === false ? { suspect: true } : {}),
        targets,
      })
    }
  }

  // 报告按「路径 + 行号」排：同一份文件里的多处命中挨着读，人才看得出它们是不是一段；
  // 顺序也必须是确定的——同一份项目两次跑出两份顺序不同的报告，等于给不出可复核的结论。
  const byLocation = (a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    const la = a.line ?? 0
    const lb = b.line ?? 0
    if (la !== lb) return la - lb
    return 0
  }
  for (const list of [markers, unfinished, placeholders, residue, templateSimilar, stateDir, dangling]) {
    list.sort(byLocation)
  }

  const groups = {
    markers,
    unfinished,
    placeholders,
    residue,
    templateSimilar,
    stateDir,
    dangling,
  }
  const all = [...markers, ...unfinished, ...placeholders, ...residue,
    ...templateSimilar, ...stateDir, ...dangling]
  const findings = all.length
  // 干净与否看**挡着验收的那些**（blocks 为真的）：相似那一组不挡，疑似且不挡的那些
  // 也不挡——它们是「机器判不准、请人判读」，把它们算成不干净，用户唯一的出路就是
  // 造个假文件骗过检查。
  const blocking = all.filter((f) => f.blocks === true).length
  const clean = blocking === 0
  return { project: root, groups, clean, findings, blocking, scanned }
}

// ── 输出 ───────────────────────────────────────────────────────────────────

function formatFinding(finding) {
  const loc = finding.line === null || finding.line === undefined
    ? finding.path
    : `${finding.path}:${finding.line}`
  const mark = finding.suspect === true ? '（疑似）' : ''
  const literal = finding.literal ?? finding.match
  const tail = finding.blocks === true ? '' : '  [不计入干净判定]'
  return `  ${loc}  ${literal}${mark}  ${finding.what}${tail}`
}

/**
 * 「没扫到」的部分要说出来。
 *
 * 每一类没扫到的东西都单独报：跳过的二进制文件、超大的文件、读不出来的目录、被上限
 * 截断的遍历、目标给成了文件。**不报它们，「零命中」就会被读成「扫过了、很干净」**
 * ——而「没扫到」与「里面没有东西」是两件事，混成一样时，结论就成了一句没人能核对的
 * 假话。
 */
function scanGaps(scanned) {
  const parts = []
  if (scanned.partial) parts.push('目标是文件，只扫了那一个')
  if (scanned.truncated) parts.push('遍历被条目上限截断')
  if (scanned.depthLimited > 0) parts.push(`${scanned.depthLimited} 处目录超过深度上限`)
  if (scanned.unreadable > 0) parts.push(`${scanned.unreadable} 处读不出来`)
  if (scanned.skippedLarge > 0) parts.push(`${scanned.skippedLarge} 个文件超过 ${MAX_FILE_BYTES} 字节未读`)
  if (scanned.skippedBinary > 0) parts.push(`${scanned.skippedBinary} 个二进制文件未读`)
  if (parts.length === 0) return undefined
  return `注意：${parts.join('；')}——结论只覆盖已扫到的部分（已扫 ${scanned.files} 个文件）。`
}

function renderText(report, mode) {
  const out = []
  out.push(`痕迹勘察：${report.project}`)
  out.push(mode === 'verify'
    ? '模式：verify（干净退出 0，不干净退出 1）'
    : '模式：scan（报告模式，退出码恒为 0）')
  const gap = scanGaps(report.scanned)
  if (gap !== undefined) out.push(gap)
  out.push('本报告只说「哪里有、是什么」；怎么办在协议里（references/handoff.md），每组下面写了去哪张表查。')
  out.push('「交付还没做完」有两种形态：标记形态在 [A2] 组里；**缺节那种机器判不了**——'
    + '用 compose-agents.mjs <项目目录> --status（只报告，不写入）确认。')
  out.push('')
  if (report.findings === 0) {
    // 「已经干净」只在**确实扫到了全部**时才准说：没扫到全的时候说「已经干净」，
    // 就是把「没扫到」说成「扫过了、很干净」——那正是这个工具最不该有的误读。
    out.push(gap !== undefined
      ? '结论：没有发现痕迹（本次没扫到全部，见上面的提示）。'
      : '结论：已经是干净状态（没有发现任何 project-forge 的痕迹）。')
    return `${out.join('\n')}\n`
  }
  for (const group of GROUPS) {
    const items = report.groups[group.key]
    out.push(group.title)
    out.push(`  ${group.pointer}`)
    if (items.length === 0) {
      out.push('  （无）')
      continue
    }
    for (const item of items) out.push(formatFinding(item))
  }
  const suspects = allFindings(report).filter((f) => f.suspect === true).length
  const nonBlocking = allFindings(report).filter((f) => f.blocks === false).length
  const tails = []
  if (suspects > 0) tails.push(`其中 ${suspects} 处标为疑似，请人工确认`)
  if (nonBlocking > 0) tails.push(`另有 ${nonBlocking} 处不计入干净判定（标着「不计入干净判定」）`)
  if (gap !== undefined) tails.push('本次没扫到全部，见上面的提示')
  const tail = tails.length > 0 ? `（${tails.join('；')}）` : ''
  const verdict = report.clean ? '已经是干净状态' : `还有 ${report.blocking} 处待处理`
  out.push('')
  if (report.clean) {
    out.push(gap !== undefined
      ? '结论：没有发现痕迹（本次没扫到全部，见上面的提示）。'
      : `结论：${verdict}（没有发现任何 project-forge 的痕迹）。`)
    if (report.groups.templateSimilar.length > 0) {
      out.push('[D] 组列出的模板衍生物交棒时一律不动，见 references/handoff.md 第四节。')
    }
  } else {
    out.push(`结论：${mode === 'verify' ? '不干净——' : ''}${verdict}${tail}。`)
  }
  return `${out.join('\n')}\n`
}

function allFindings(report) {
  return Object.values(report.groups).flat()
}

// ── 命令行 ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const positional = []
  let scanAsked = false
  let verifyAsked = false
  let json = false
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (a === '--scan') { scanAsked = true; continue }
    if (a === '--verify') { verifyAsked = true; continue }
    if (a === '--json') { json = true; continue }
    if (a.startsWith('-')) throw new Error(`无法识别的参数：${a}`)
    positional.push(a)
  }
  if (scanAsked && verifyAsked) throw new Error('--scan 与 --verify 互斥，只能给一个')
  if (positional.length > 1) throw new Error(`只能给一个项目目录，收到 ${positional.length} 个`)
  return {
    target: positional[0] ?? process.cwd(),
    mode: verifyAsked ? 'verify' : 'scan',
    json,
  }
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const target = resolve(parsed.target)
  if (!existsSync(target)) {
    process.stderr.write(`错误：路径不存在：${target}\n`)
    return 2
  }
  // 目标给成**文件**时只扫那一个文件（父目录是另一个项目，扫它等于答错了题）。
  let root = target
  let onlyFile
  try {
    if (statSync(target).isFile()) {
      root = dirname(target)
      onlyFile = target
    }
  } catch {
    process.stderr.write(`错误：读不了目标：${target}\n`)
    return 2
  }
  let report
  try {
    report = scan(root, onlyFile)
  } catch (error) {
    process.stderr.write(`勘察失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify({
      project: report.project,
      mode: parsed.mode,
      groups: report.groups,
      clean: report.clean,
      findings: report.findings,
      // blocking 是「挡着干净判定的那几处」：findings 含相似与疑似那些不挡的，
      // 两个数分开给，消费方才不用自己重算一遍「哪些算数」。
      blocking: report.blocking,
      // scanned 把「没扫到」的那几类也带出去：只给「零命中」而不给这个，消费方会把
      // 没扫到读成扫过了。
      scanned: report.scanned,
    }, null, 2)}\n`)
  } else {
    process.stdout.write(renderText(report, parsed.mode))
  }
  // scan 是报告，退出码恒为 0；verify 才是判决。
  if (parsed.mode === 'verify') return report.clean ? 0 : 1
  return 0
}

// 与 survey / preflight 同一模式：直接执行才跑 main；被 import（自检调用纯函数）时
// 不产生副作用。判据按真实路径比较，经 junction 调用也算直接执行。
if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main(process.argv)
