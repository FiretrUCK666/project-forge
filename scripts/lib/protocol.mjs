/**
 * protocol.mjs —— 本 skill 与目标项目之间的协议常量：注入标记、占位符、预算。
 *
 * 为什么独立成一个模块：这些字面量被注入、自检、交付门禁、交棒四个脚本共用。
 * 埋在任何一个具体工具里，**想拿一个标记的脚本都得把整个引擎加载进来**——注入脚本
 * 只为两个常量，就要连带全盘走查与 git 子进程的那一整套代码。
 *
 * 这些常量有三个特征，正好是一条分界线：
 *   - 它们是**协议**，不是勘察结果：哪个项目都不改变它们的值；
 *   - 它们对不上时**不会有任何东西出声**（检查本身就是拿它去比的）；
 *   - 所以只能有一份来源，而这一份不该埋在某个具体工具里。
 *
 * 本模块零副作用；唯一的内部依赖是同样纯函数的 `markdown.mjs`（标题与围栏的扫描只此一份，
 * 发布说明的结构检查要用到它——再审一遍围栏状态机就是第二份判据）。
 */

import { scanLines } from './markdown.mjs'

/**
 * 内核标记：注入方靠它定位要替换的区间。
 *
 * 这条字面量三个脚本都要用（注入、自检、交付门禁），各写一份的后果比一般重复更重：
 * 它们对不上时，注入方找不到标记区，要么静默不注入、要么把整块当新内容对待——而后者
 * 会连用户写在标记之间的正文一起覆盖，且两边都不出声。它没有任何检查盯得住（检查本身
 * 就是拿它去比的），所以只能让它只有一个来源。
 */
export const KERNEL_START = '<!-- project-forge:kernel:start -->'
export const KERNEL_END = '<!-- project-forge:kernel:end -->'

/**
 * 「这份文件由本脚本生成」的标记。
 *
 * 它区分开三种**都带内核**的文件，而它们的验收标准不同：
 *   - **生成的文件**（从骨架生成）：节结构由模板决定，**缺节就是缺陷**，该报错；
 *   - **升级的文件**（手写后被 --upgrade 改造，见 UPGRADED）：结构已向模板对齐，
 *     但需要人写的节脚本刻意不补，所以缺节是**待办**，只提示不否决；
 *   - **作者编排的文件**（自己写的，只带内核标记）：作者可能刻意换一种组织方式
 *     （本 skill 自己的 AGENTS.md 就是）。此时**模板的标题清单不是判据**：脚本既不会
 *     替他补这些节，也不该拿字面差集去催他——那只会把「写了但措辞不同」报成「没写」，
 *     而一份永远在喊同一批假缺失的报告，等于不存在。
 *
 * 没有这个区分时只有两种错法：要么把作者的编排当成缺陷（误报，逼人改成模板的样子），
 * 要么对掏空的契约睁一眼闭一眼（漏报）——区分的两支各自挡住其中一种错法。
 */
export const MANAGED = '<!-- project-forge:managed -->'

/**
 * 「这份文件的结构已按模板升级过」的标记。
 *
 * `--upgrade` 只做加法：插入内核、补上可自动补的节，**需要人写的节一个都不补**。
 * 所以升级完的文件必然还缺若干节，那是**待办**而不是缺陷——判据必须能把它与
 * 「作者自己编排的文件」区分开，否则两者只能取同一个标准，而两个标准都会错：
 * 按缺陷判，升级后的文件永远红；按不判，P4 的「两个节数归零」就空转了。
 */
export const UPGRADED = '<!-- project-forge:upgraded -->'

/**
 * 「这一节的内容是使用者写的，刷新时一个字节都不要动」的标记。
 *
 * 判据必须是**这段字节是谁写的**，不能是「节标题在不在模板里」——节标题是人和模板
 * 都会用的公共词汇（「构建与验证」「版本管理」几乎人人这么起名），拿它当身份，就必然
 * 在撞名时把使用者的正文当成生成内容覆盖掉。
 *
 * 这个标记由 `--upgrade` 打在**它保留下来的**那些节上：升级只做加法，所以凡是升级时
 * 已经存在的节，内容都归使用者，此后刷新遇到它一律原样保留。
 */
export const KEEP = '<!-- pf:keep -->'

/**
 * 「这份发布说明还是骨架」的标记。
 *
 * 发布说明的正文只有一个来源：版本库里的那一个说明文件。而骨架——章节标题在、内容
 * 一句没写——同样是一个文件，机器若只判「文件存在」，它就会被原样发到发布页上。
 * 发布页的读者是使用者，一份只有小标题的空壳不是他能读懂的说明。
 *
 * 所以项目自己的发版规范把这段骨架连标记一起给出，写说明的人填完就删掉它；发送端
 * 见到它就**拒绝发送**，让发版 job 直接红。
 */
export const SUMMARY_MARKER = 'pf:needs-summary'

/**
 * 注入字节预算：超过它，`AGENTS.md` 就该压项目节了。
 *
 * 比通用的指令预算更严——它每次会话都注入，同时还要给人看。
 */
export const INSTRUCTION_BUDGET = 65536

/**
 * 用户包**不包含**什么：整目录的排除规则，与 `.gitattributes` 的 `export-ignore` 一一对应。
 *
 * 这份常量存在的理由很具体：**「包里有什么」不该由任何一份人写的清单回答。**
 * 权威答案永远是 `git archive` 的那次真导出——一张需要人记得改的文件表，迟早会漏，
 * 而漏的症状是「文件在包里但没人知道」或「文件该在却不在」，两种都不会自己出声。
 *
 * 所以这里只保留**结构**：哪几个目录整块不进包。它同时服务三个地方：
 *   - `preflight.mjs` 核对 `.gitattributes` 有没有把这几条都排除掉（两处必须一致）；
 *   - `update.mjs` 清掉副本里那些「这个包里本来不该有」的目录（下载成 `Source code`
 *     时它们会一直留着）；
 *   - 位置判据：只服务本仓库的脚本必须落在 `scripts/dev/` 下——**这条是目录规则，
 *     所以新增自用脚本不需要改任何清单**。
 *
 * **新增自用文件的正确做法是先问「能不能放进已有的那几处」**；确实要新增一处独立目录时，
 * 加在这里并同步 `.gitattributes`，`preflight.mjs` 会在两处不一致时当场红。
 *
 * 顶层单文件（`AGENTS.md`、`CONTRIBUTING.md`、`RELEASING.md`、两个点文件）不在这里：
 * 它们是**一个文件**，没有目录可以承载，排除规则只能写在 `.gitattributes` 里逐条列。
 * 它们也永远不会增长成需要人维护的清单——每加一个都是要反复讨论的决定，不是日常动作。
 */
export const REPO_ONLY_DIRS = Object.freeze([
  '.github/',
  'docs/',
  'scripts/dev/',
])

/** 顶层的不进包单文件（与 `.gitattributes` 的逐条规则对应）。 */
export const REPO_ONLY_FILES = Object.freeze([
  'AGENTS.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
  '.gitattributes',
  '.gitignore',
])

/**
 * **要落到目标项目里去的脚本**：随包分发，并且会被复制进项目的 `scripts/` 下。
 *
 * 与普通随包脚本的区别只有一条，但很要紧：模板里**可以**出现它们的路径。
 * 普通脚本（勘察、注入、自检）是 AI 在本 skill 目录里跑的，模板里一提
 * `scripts/survey.mjs`，目标项目的读者就会去自己项目里找——那里没有。
 * 而这一份是「拷过去之后就在那儿」的，所以指它是对的。
 *
 * 判据落在**这份代码自己在哪儿**上：写在表里 = 允许出现在模板的引用位置。
 * 判据实现在 `preflight.mjs` 的 `checkDeliveredAttribution`——反向那条（模板指了
 * 一个目标项目没有的脚本）才是它要拦的。
 *
 * 新增一份要落地的脚本时：加进这张表，并在模板里写清「先拷过去」。
 */
export const LANDED_SCRIPTS = Object.freeze([
  'scripts/review-record.mjs',
])

// ── 模板 与 本仓库实例 ─────────────────────────────────────────────
//
// 这一组治的是一种特定的病：**同一段内容写在两处，靠人记得同步**。
//
// 病的形状可测量：九对「落盘模板 与 本仓库实例」全都存在，但其中八对没有任何机器检查；
// 而同一份机制的文字在 `AGENTS.md`、`references/`、`templates/` 里各写了一遍。
// 结果是每改一次机制就多出一次不一致，而「下一轮审查指出上一轮的不一致」正好能让
// 任何循环永不收敛——每次修改都在给自己造新问题。
//
// **审查循环自己的机器契约不在这里**：它是 `scripts/review-record.mjs`，因为那份文件
// 要整个复制进目标项目、必须零依赖单文件。格式的东西只有一个来源，就是那个解析器本身。

/**
 * `templates/` 下的文件落在本仓库的哪一处。
 *
 * **完整性由目录驱动，不靠这张表**：`preflight.mjs` 要求 `templates/` 下每个文件
 * 要么在这里，要么在 `TEMPLATE_NO_INSTANCE` 里。新增模板不登记就红——所以它不可能漏。
 * 这张表只回答「落在哪」，不负责「有没有漏」。
 *
 * 这就是本项目已经验证过两次的做法：用户包边界由 `.gitattributes` + 真跑 `git archive`
 * 决定，自用脚本位置由 `scripts/dev/` 整目录规则决定。**清单会漏，结构规则不会。**
 */
export const TEMPLATE_INSTANCES = Object.freeze({
  'contributing.md': 'CONTRIBUTING.md',
  'readme.md': 'README.md',
  'release-spec.md': 'RELEASING.md',
  'agents-project.md': 'AGENTS.md',
  // 内核不是整份对拷：它被注入 `AGENTS.md` 的标记区之间。
  'agents-kernel.md': 'AGENTS.md',
  'work-item.md': 'docs/work/',
  'pull-request-template.md': '.github/pull_request_template.md',
  'issue-bug-report.md': '.github/ISSUE_TEMPLATE/bug_report.md',
  'issue-feature-request.md': '.github/ISSUE_TEMPLATE/feature_request.md',
  'ci-check.yml': '.github/workflows/check.yml',
  'ci-release.yml': '.github/workflows/release.yml',
})

/**
 * 不落在本仓库任何一处的模板：**许可证全文**。
 *
 * 它们是给目标项目取用的，本仓库自己的许可证是其中一个的具体实例（年份与持有人已填），
 * 逐字比对没有意义——占位符本来就要被替换掉。
 *
 * 这张表必须显式列出，不靠「没登记就算豁免」：那样新增一个模板忘了登记也会静默通过，
 * 而这正是要拦的。
 */
export const TEMPLATE_NO_INSTANCE = Object.freeze([
  'license-mit.txt',
  'license-isc.txt',
  'license-bsd-2-clause.txt',
  'license-bsd-3-clause.txt',
  'license-unlicense.txt',
])

/**
 * 判据注册表：`preflight.mjs` 里每个**导出的判据函数**，要么被行为自检调用，
 * 要么在这张表里写明为什么不能。
 *
 * ## 它治的是什么
 *
 * 这是这个项目反复踩到同一个坑之后才加的东西，坑的形状每次都一样：
 *
 *   > 一条判据被写出来、跑起来、看起来在工作，但它**被削成恒真也没有任何东西变红**。
 *
 * 于是它对「判据本身坏了」这件事毫无防御——而判据坏掉时不会报错，只会从此少查一项。
 * 四轮独立审查里有三轮找到的都是这同一个病在**不同位置**的新实例：先是契约比对，
 * 然后是新加的「理由不许转述正文」，再然后是「执行者那一格」只被 import 而从没被调用。
 *
 * ## 为什么不能靠自觉
 *
 * 「判据抽成导出纯函数」只解决了**可被调用**，不解决**有没有人调**。上一版把四条老判据
 * 抽出来了，同时新写的一条照样漏了——因为「写一条新判据」与「给它配断言」是两个动作，
 * 而只有前一个动作有推动力（它让门禁多拦一件事），后一个没有。
 *
 * 所以把两个动作合成一个：**新增判据就必须在注册表里出现**，而注册表要求你交出一句
 * 「谁来看着它」。答不上来的，就是没有断言；那会被 `preflight.mjs` 当场指出来。
 *
 * ## 三种登记
 *
 *   - 有断言：写 `checkedBy`，值是行为自检里那条断言的名字（用来在报错里指路）；
 *   - 判不了：写 `why`，说明为什么这条判据没法用断言表达（例如它读本机环境）；
 *   - 只是工具：写 `utility: true`，说明它不含判断、只是解析或读取，不是判据。
 *
 * 判据实现在 `preflight.mjs` 的 `judgeRegistryIssues`——它扫源码里 `export function`
 * 的名字，与这张表对账。**扫磁盘不扫清单**：新写一个导出判据却忘了登记，一定被抓到。
 */
export const JUDGE_REGISTRY = Object.freeze({
  listRepoFiles: { utility: true, why: '读目录，不含判断' },
  referencedPaths: { utility: true, why: '从正文里抽路径，不含判断' },
  moduleSpecifiers: { utility: true, why: '从源码里抽 import，不含判断' },
  externalModules: { utility: true, why: '从 import 里挑外部模块，不含判断' },
  looksLikeEntry: { checkedBy: '里有这个词但不判为入口（否则纯模块白白多一条提示）' },
  releaseTokenSpellings: { checkedBy: '全仓统一 → 只有一种拼写' },
  evalFreshnessMarker: { checkedBy: '好标记放行且读出 scope/date/age' },
  freshnessSectionBody: { checkedBy: '只有标题 + 标记的「事实来源」节不通过（判据不再永真）' },
  hasActionableSources: { checkedBy: '纯套话（无链接、无对象、无查法句式）→ 不通过' },
  compareHostMarker: { checkedBy: '一致 → match（调用方据此静默）' },
  probeHost: { why: '读本机宿主版本，依赖运行环境；断言只能验它的分支，不能验它读到什么' },
  hostDateBatchStatus: { checkedBy: 'host= 变了而 date= 没变 → stale（那条日期不可信）' },
  hostMismatchMessage: { checkedBy: '提示正文里不出现源码拼接痕迹' },
  contractSnippetIssues: { checkedBy: '契约：改过的落点会报' },
  templateIfReasons: { checkedBy: '条件块：抹掉会报' },
  reasonQuotesBodyPhrases: { checkedBy: '理由：转述会报' },
  templateRegistrationIssues: { checkedBy: '判据本体：模板登记会报' },
  executorVerdict: { checkedBy: '判据本体：执行者那一格' },
  judgeRegistryIssues: { checkedBy: '判据注册表：未登记会报' },
  caseInsensitiveFs: { why: '探测本机文件系统分不区分大小写。它的返回值就是判断本身——断言只能验它读到什么，而它读的是运行环境，写断言等于把某一台机器的答案当标准' },
  tarEntries: { utility: true, why: '解析 tar 字节流，不含判断' },
})

/**
 * 生态专属门禁的**唯一实现位置**。
 *
 * 判据是「这条检查里的名词是不是那个生态自己的」：发布范围含不含 `lib`、补丁文本里
 * 有没有包名、标签触发器该不该带 `v`——这些词只在描述符里合法。写进 `review.mjs` 的
 * 后果不是报错，是**加第二个生态时必须回头改主引擎**，而漏改的那一次不会出声：
 * 新生态的专属门禁一条都不跑，报告看起来还是全绿。
 *
 * 描述符在这里声明 `checks(s)`，返回 `{ missing, pending, ok }` 三个数组（缺项 / 待问 /
 * 合格说明）。review 只负责把它们并进总账——它不认识任何一个生态名。
 */
export function ecosystemChecks(descriptors, s) {
  const kinds = s?.ecosystem?.kinds ?? []
  const out = { missing: [], pending: [], ok: [] }
  for (const d of descriptors) {
    if (!kinds.includes(d.id)) continue
    if (typeof d.checks !== 'function') continue
    const r = d.checks(s) ?? {}
    out.missing.push(...(r.missing ?? []))
    out.pending.push(...(r.pending ?? []))
    out.ok.push(...(r.ok ?? []))
  }
  return out
}

/**
 * 这个路径进不进用户包？
 *
 * 判据只有一条：它落不落在 `REPO_ONLY_DIRS` 的目录里，或是 `REPO_ONLY_FILES` 之一。
 * 刻意**不提供**「把它登记进某张表」这条路——登记表一旦存在，就会有人往里加东西，
 * 而加漏的那一次没有任何检查盯得住。
 */
export function isRepoOnlyPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (p === '') return false
  if (REPO_ONLY_FILES.includes(p)) return true
  return REPO_ONLY_DIRS.some((d) => p === d.replace(/\/$/, '') || p.startsWith(d))
}

/**
 * 托管平台给程序用的那套接口地址，由网页地址推出来。
 *
 * 判据是**平台自己公布的地址规律**（网页是 `<主机>/<owner>/<仓库>`，接口是
 * `api.<主机>/repos/<owner>/<仓库>`），不是猜。认不出来（自建镜像、别的托管平台、
 * 形状不对的地址）就返回 `undefined`——**不猜**：给一个不会应答的地方硬拼出接口路径，
 * 换来的是一句看起来像事实的「那边没有最新发布」，而正确结论是「这里问不出来」。
 *
 * **两条链路共用这一份**：`update.mjs` 拿它问「最新发布是哪个」，`release-notes.mjs`
 * 拿它发说明。地址规律写在两处就会漂——一处改了 `api.` 前缀、另一处没改，症状是
 * 「查得到、发不出」，而两个脚本各自的测试都过。
 */
export function apiBase(source) {
  let url
  try {
    url = new URL(source)
  } catch {
    return undefined
  }
  if (url.hostname === 'github.com') return 'https://api.github.com'
  return undefined
}

/** 这个来源的 `owner/name` 与接口基地址；任一项认不出来就整个返回 `undefined`。 */
export function apiTarget(source) {
  const base = apiBase(source)
  if (base === undefined) return undefined
  let url
  try {
    url = new URL(source)
  } catch {
    return undefined
  }
  const segments = url.pathname.split('/').filter((s) => s !== '')
  if (segments.length !== 2) return undefined
  return { base, owner: segments[0], name: segments[1] }
}

/**
 * 这份说明还是骨架吗？判据只看那个标记，不看内容形状。
 *
 * 「还是骨架」与「写得短」是两件事：一篇两百字的说明和一份只有小标题的空壳，
 * 区别不在长度，在于**有没有人真正写过**。标记是那个分界的唯一机器载体——
 * 机器认不出「写得好不好」，但它认得出「这段还是模板本来的样子」。
 */
export function needsSummary(text) {
  return String(text ?? '').includes(SUMMARY_MARKER)
}

/**
 * 发布说明的结构检查：**只查任何项目的说明都必须成立的那几条**。
 *
 * 为什么不查「分了哪几节」：那是项目自己的决定（不同项目的读者关心的事不同，库的读者
 * 关心接口、插件的读者关心宿主兼容）。把节名或节数写进检查，等于把一家项目的规范按到
 * 所有项目头上，而下一个项目只会绕开它。
 *
 * 能查的是**与项目无关的那些**：有没有标题、标题是不是这一版、有没有节、节里有没有字、
 * 有没有两节同名、是不是还留着骨架。这几条一旦不成立，说明在任何项目里都算不上说明——
 * 它们是「空壳」与「成品」的分界，而发布页的读者是使用者。
 *
 * 返回问题清单（人话，逐条可修）；空数组表示没发现问题。**未覆盖之处是「没查」，不是
 * 「查过没问题」**——写得是否对读者有用，只有人和审查能判。
 */
export function lintReleaseNotes(text, tag) {
  const body = String(text ?? '')
  const problems = []
  if (body.trim() === '') return ['正文是空的']

  if (needsSummary(body)) {
    problems.push(`还留着骨架标记（${SUMMARY_MARKER}）：这一段还没写`)
  }

  // 结构判据一律跑在「去掉注释之后」的文本上：整份说明被 `<!-- -->` 包起来时，标题在注释里
  // ——机器若照样数到它，一份读者根本看不到的空壳会被判成合格。围栏里的内容不动：那里面的
  // `<!--` 是示例，不是注释。
  const state = { inComment: false }
  const lines = scanLines(body).map((info) => {
    if (info.inFence) return info
    const visible = stripHtmlComments(info.line, state)
    if (visible === info.line) return info
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(visible)
    return { ...info, line: visible, heading: h === null ? null : { level: h[1].length, title: h[2] } }
  })
  const marks = []
  lines.forEach((info, i) => {
    if (!info.inFence && info.heading !== null) marks.push({ info, i })
  })

  const h1 = marks.filter((m) => m.info.heading.level === 1)
  if (h1.length === 0) {
    problems.push('缺一级标题：第一行应当是这一版的标签名')
  } else if (h1.length > 1) {
    problems.push(`一级标题有 ${h1.length} 个：一份说明只有一个标题`)
  } else if (typeof tag === 'string' && tag.trim() !== '') {
    // 判据是「标题里那个号对不对」，不是「标题里只许有号」。所以从整行里取**第一个像版本号
    // 的东西**再比：`# v1.2.3`、`# v1.2.3 — 首个公开版`、`# v1.2.3：修好导出缺页`、
    // `# v1.2.3（首个公开版）` 都是同一个号。按空白切词会漏掉后两种——那正是「写得好好的
    // 说明被拦在门外」，而报错还会说「不是同一个号」，与事实不符。
    const got = h1[0].info.heading.title.trim()
    const strip = (s) => s.trim().replace(/^v/i, '')
    const numLike = (/v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.]+)?/i.exec(got) ?? [])[0] ?? ''
    const candidate = numLike === '' ? got.split(/\s+/)[0] : numLike
    if (strip(candidate) !== strip(tag)) {
      problems.push(`一级标题写的是「${got}」，与标签「${tag}」不是同一个号`)
    }
  }

  const h2 = marks.filter((m) => m.info.heading.level === 2)
  if (h2.length === 0) {
    problems.push('没有任何二级节：说明至少要有一节，写清这一版变了什么')
  }

  // 空节：标题之后到下一个「同级或更高级」标题之前，没有实际内容（`line` 已去掉注释，
  // 所以一句 `<!-- 待补 -->` 不算内容）。
  for (const { info, i } of h2) {
    const level = info.heading.level
    let hasContent = false
    for (let k = i + 1; k < lines.length; k += 1) {
      const next = lines[k]
      if (!next.inFence && next.heading !== null && next.heading.level <= level) break
      if (next.line.trim() !== '') { hasContent = true; break }
    }
    if (!hasContent) {
      problems.push(`「${info.heading.title}」这一节没有内容：没有内容就整节省略，不要留一个空标题`)
    }
  }

  const seen = new Set()
  for (const { info } of h2) {
    const title = info.heading.title.trim()
    if (seen.has(title)) problems.push(`「${title}」出现了两次：同一节只能有一次`)
    seen.add(title)
  }

  return problems
}

/**
 * 去掉一行里的 HTML 注释，返回「读者真的能看到」的那部分。
 *
 * 为什么需要：空节判据若只看「这一行非空」，一句 `<!-- 待补 -->` 就算有内容——而那正是
 * 要拦的空壳。注释可以跨行，所以状态要带出去（`state.inComment`）。
 */
export function stripHtmlComments(line, state) {
  let out = ''
  let i = 0
  while (i < line.length) {
    if (state.inComment) {
      const end = line.indexOf('-->', i)
      if (end < 0) return out
      i = end + 3
      state.inComment = false
    } else {
      const start = line.indexOf('<!--', i)
      if (start < 0) { out += line.slice(i); break }
      out += line.slice(i, start)
      i = start + 4
      state.inComment = true
    }
  }
  return out
}
/**
 * 「这一行是本 skill 的受管标记吗」的判据：**基于上面那些常量拼出来，不另抄字面量**。
 *
 * 用法是逐行匹配（`re.test(line)`），所以带 `g` 标志的版本另有 `lastIndex` 的坑——
 * 这里导出的是无状态版本，调用方每次 `test` 都从零开始。
 *
 * 除四枚具名标记外，还认 `pf:` 开头的开放命名空间：`pf:author`、`pf:if ...`、
 * `pf:scaffold` 这些是模板指令，数量会随模板演进增长，逐枚枚举必然漏。
 */
export const MANAGED_MARK_RE = new RegExp(
  `<!--\\s*(?:${[KERNEL_START, KERNEL_END, MANAGED, UPGRADED, KEEP]
    .map((m) => m.replace(/^<!--\s*/, '').replace(/\s*-->$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')}|pf:[^>]*?)\\s*-->`,
)
/**
 * 命令键：哪些键算「这个项目有可跑的命令」。
 *
 * **全仓唯一一份**。原先 survey 有一份数组、compose 有一份从标签表派生的 Set，
 * 两边各判一次：改了一处另一边不报错，症状是命令段静默消失或多出空壳。
 *
 * 顺序有意义：扁平视图按这个顺序取先到者，所以「声明的」排在「推断的」前面。
 */
export const COMMAND_KEYS = ['install', 'build', 'typecheck', 'lint', 'test', 'verify', 'smoke']

/** 同上的集合形态，供频繁查表用。 */
export const COMMAND_KEY_SET = new Set(COMMAND_KEYS)
/**
 * 描述「某条命令从哪来」的键（`note` / 以 `Note` 结尾）：不是命令本身。
 *
 * 导出给 compose-agents 用——同一份判据写在两处时，新增一种 `xxxNote` 只会在其中一处
 * 生效，而现象是「命令段整块消失」或「多出一条根本不是命令的项」，两边都不会报错。
 */
export function isNoteKey(key) {
  return key === 'note' || key.endsWith('Note')
}
