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

/** 标记里的命名空间。所有标记都以它开头。 */
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
 */
export const MARKER_KINDS = Object.freeze(['generated', 'begin', 'end', 'fill'])

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
  const html = /^\s*<!--\s*project-forge:\s*([\s\S]*?)\s*-->\s*$/.exec(line)
  if (html) return html[1].trim()
  const hash = /^\s*#\s*project-forge:\s*(.*?)\s*$/.exec(line)
  if (hash) return hash[1].trim()
  return undefined
}

/**
 * 解析一份文本里的全部标记，返回按行号排列的记录。
 *
 * 每条形如 `{ body, kind, id, what, line }`：`line` 是从 1 开始的行号，`index` 是从 0
 * 开始的行下标。`kind` 为 `begin`/`end` 时 `id` 是节名，为 `fill` 时 `what` 是待填内容。
 */
export function parseMarkers(text, file) {
  if (markerSyntaxFor(file) === null) return []
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const body = markerBodyOf(lines[i])
    if (body === undefined) continue
    const m = /^(generated|begin|end|fill)\b\s*([\s\S]*)$/.exec(body)
    if (!m) continue
    const kind = m[1]
    const rest = m[2].trim()
    out.push({
      body,
      kind,
      id: kind === 'begin' || kind === 'end' ? rest : undefined,
      what: kind === 'fill' ? rest : undefined,
      line: i + 1,
      index: i,
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
 * 用于 `--clean`：把 `generated` 标记与 `fill` 占位符去掉，文件和正文都保留。
 * **不处理 begin/end 的配对**——那是 compose 的事，它比这里更清楚该留下哪一段。
 */
export function stripMarkers(text, file) {
  if (markerSyntaxFor(file) === null) return text
  const eol = String(text ?? '').includes('\r\n') ? '\r\n' : '\n'
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const kept = lines.filter((line) => markerBodyOf(line) === undefined)
  return kept.join(eol)
}

/**
 * 找出文本里的 `begin <id>` / `end <id>` 配对区间，返回 `[{ id, start, end }]`。
 *
 * `start`/`end` 都是标记行本身的下标，**区间内容不含这两行**。配不上对的区间不返回，
 * 而是在 `broken` 里报出——半对锚点意味着文件被手工改坏了，此时正确动作是报出来让人看，
 * 不是猜一个位置去覆盖。
 */
export function markerRegions(text, file) {
  const markers = parseMarkers(text, file)
  const regions = []
  const broken = []
  const open = new Map()
  for (const mark of markers) {
    if (mark.kind === 'begin') {
      if (open.has(mark.id)) broken.push(mark.id)
      open.set(mark.id, mark.index)
    } else if (mark.kind === 'end') {
      const start = open.get(mark.id)
      if (start === undefined) { broken.push(mark.id); continue }
      open.delete(mark.id)
      regions.push({ id: mark.id, start, end: mark.index })
    }
  }
  for (const id of open.keys()) broken.push(id)
  return { regions, broken }
}

/**
 * 读取预算。这几个数写在代码里而不是文档里，因为文档里的数字没人核。
 *
 * `SKILL_MAX_LINES` 是入口的上限：入口每多一行，每一次任务都要多付一次。
 * `FULL_READ_MAX_LINES` 是一次全量任务的必读量上限（入口 + 四篇主干参考）。
 */
export const SKILL_MAX_LINES = 160
export const SKILL_MAX_BYTES = 12 * 1024
export const REFS_MAX_LINES = 1300
export const FULL_READ_MAX_LINES = 850

/** 一次全量任务必读的那几篇（相对 skill 根）。preflight 用它算预算。 */
export const FULL_READ_REFS = Object.freeze([
  'references/survey.md',
  'references/version-control.md',
  'references/docs-set.md',
  'references/remote-github.md',
])

// ── 用户包边界 ──────────────────────────────────────────────────────
//
// 仓库里的文件分两类：**随包分发**的与**只服务本仓库**的。分野由结构与门禁共同保证，
// 不靠任何人工清单——清单要人记得改，漏一行就开始说假话。
//
// 判据落在**哪几处**上，而不是逐文件列表：那几处在一年里可能一次都不变。
// 新增自用文件只做一件事：放进已有的那几处（自用脚本进 `scripts/dev/`、工作记录进
// `docs/work/`、协作设施进 `.github/`）——那一整目录本来就不进包，不用改任何清单。

/** 不进包的目录（与 `.gitattributes` 的 `export-ignore` 对应）。 */
export const REPO_ONLY_DIRS = Object.freeze([
  '.github/',
  'docs/',
  'scripts/dev/',
])

/** 不进包的顶层单文件。它们没有目录可以承载，只能逐条列。 */
export const REPO_ONLY_FILES = Object.freeze([
  'AGENTS.md',
  'CONTRIBUTING.md',
  'RELEASING.md',
  '.gitattributes',
  '.gitignore',
])

/** 这个相对路径属不属于「只服务本仓库」。 */
export function isRepoOnlyPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  if (REPO_ONLY_FILES.includes(p)) return true
  return REPO_ONLY_DIRS.some((d) => p === d.replace(/\/$/, '') || p.startsWith(d))
}

/**
 * 从来源地址推出可下载的接口地址。认不出返回 undefined——**不猜**。
 *
 * 两条路：先试接口路（一次请求同时给出标签与附件位置，不碰网页主机），
 * 猜不出就返回 undefined，由调用方退回网页路。
 */
export function apiTarget(source) {
  if (typeof source !== 'string') return undefined
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?\/?$/i.exec(source.trim())
  if (!m) return undefined
  return {
    kind: 'github',
    base: 'https://api.github.com',
    latest: `https://api.github.com/repos/${m[1]}/${m[2]}/releases/latest`,
    repo: `${m[1]}/${m[2]}`,
  }
}
