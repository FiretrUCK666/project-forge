#!/usr/bin/env node
/**
 * preflight.mjs —— skill 自检
 *
 * 这个 skill 教别人「先属性后提交、文档要一致、引用要完整」。它自己必须先做到，
 * 否则它讲的每一条都在自我否定。这个脚本就是那条要求的自动化形式：让 skill 自己
 * 不会腐坏。
 *
 * 它检查的是一组「坏了就一定会出问题」的性质，而不是风格偏好：
 *   - SKILL.md 能被宿主识别（frontmatter 合法、name 与目录名一致、name 形状正确）
 *   - description 不会被会话目录截断
 *   - SKILL.md 引用的每一个文件都真实存在（引用断链 = AI 按图索骥走到死路）
 *   - 每份 reference 都有标题与「何时读本文件」节（缺了 AI 不知道何时该读它）
 *   - 每份模板都具备脚本依赖的标记
 *   - 检查域 = 仓库的定义域：只查属于这个仓库的文本文件——被忽略的本机状态目录
 *     （编辑器缓存、依赖、多智能体协作状态……）一律不参与，脚本不需要认识它们
 *   - 全文无 emoji（项目硬性规范）
 *   - 无 BOM；行尾一致（可复现构建的前提）
 *   - 不含构建机私有路径（换台机器就要能跑）
 *   - AGENTS.md 里的内核与 templates/agents-kernel.md 逐字一致
 *   - 带外部易变事实的章节文件都有统一核对标记（缺标记、错 scope、坏日期即失败；
 *     超期只警告——时间流逝不是破损）
 *
 * 用法：
 *   node scripts/dev/preflight.mjs                              # 结构自检
 *   node scripts/dev/preflight.mjs --package <清单文件> [--at <版本>]  # 产出物与文件地图核对
 *   node scripts/dev/preflight.mjs --release <标签> [--repo <owner/name>]   # 标签与版本、来源
 *
 * 检查对象由脚本自身位置推导（根 = 本文件所在目录的上两级），不接受目录参数——
 * 换目录检查的做法会让「检查了谁」变成一个可传错的值。
 *
 * 退出码 0 = 全绿；1 = 有 FAIL；2 = 脚本自身用法错误。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule } from '../lib/text.mjs'
import { README_NAME_RE, HOME_PATH_RE } from '../survey.mjs'
import { KERNEL_START, KERNEL_END, MANAGED_MARK_RE as PROTOCOL_MANAGED_MARK_RE, lintReleaseNotes, stripHtmlComments , LANDED_SCRIPTS, REPO_ONLY_DIRS, REPO_ONLY_FILES } from '../lib/protocol.mjs'
import { skillVersion, skillSource, repoRelation, tableFirstCells, parseMarkerKeys, normVersion } from '../lib/text.mjs'
import { isRepoOnlyPath } from '../lib/protocol.mjs'
// 模板要素的判据只有一处实现：`review.mjs` 用它查目标项目，本仓库用它查自己。
// 两处各写一份「什么算合格的问题模板」，迟早会给出两个答案，而其中一个是假的。
import { issueTemplateGaps } from '../review.mjs'
import { scanLines } from '../lib/markdown.mjs'
// 高风险表的解析**只有一处实现**：脚本要读它判门禁，自检要读它验「那张表还能不能解析」。
// 两处各写一份，迟早会给出两个答案——而其中一个是「表看起来在、其实读不出来」。
import { readHighRiskTable } from '../review-record.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 本文件住在 scripts/dev/ 下：scripts/ 顶层放「用户与目标项目会用到」的脚本，
// scripts/dev/ 只服务本仓库（自检、行为自检），不进用户包。所以根目录要退两级。
const SKILL_ROOT = resolve(HERE, '..', '..')

/**
 * 会话技能目录对 description 的截断长度（宿主实现事实，超出即不可见）。
 *
 * 取值现场从宿主当前实现确认，不靠记忆。**长度按空白归一化之后算**——宿主的截断代码
 * 先把连续空白压成一个空格再比长度，所以下面那道检查也必须同一个算法，见使用处。
 */
const CATALOG_DESCRIPTION_MAX = 500
/**
 * 本项目自己那份 `AGENTS.md` 的字节上限（48 KB）。
 *
 * 比通用注入预算严：这一份每次会话都被注入，同时还要给人看。**上限只压项目节**——
 * 行事总纲与编辑规则由 `templates/agents-kernel.md` 独占，要改就改那份模板并重新注入，
 * 不受这个数字约束；装不下时压项目节，不要去动内核。
 *
 * 这个数字是**量出来的、不是拍的**：45 KB 时它长期只剩几百字节余量，而每次想补一条
 * 真实需要的约定就得先删掉另一条同样有用的——那不是「保持精炼」，那是逼人用删内容换
 * 空间。48 KB 留出约 2 KB 余量，够写一条新机制；真要再涨，先问「这条能不能并进
 * `references/`」，而不是继续抬这个数。
 */
const OWN_AGENTS_MAX_BYTES = 48 * 1024
/** 余量告警线：离上限不足这么多字节时提醒一次（而不是天天喊）。 */
const OWN_AGENTS_WARN_HEADROOM = 1024

/**
 * `SKILL.md` 的字节上限（30 KB）。
 *
 * 这份文件**每次调用都整份读进上下文**，它是这个 skill 里唯一一份「多一行就多占一份
 * 注意力预算」的文档。它靠指针工作：细节都在 `references/`，这里只留「去哪读、按什么
 * 顺序、哪条不能破」。所以它需要的不是「写得更紧凑」，而是**一条让它不再长的线**——
 * 没有线的时候，每加一条规则都显得只多两行，而两年后它就变成了另一份 reference。
 *
 * 这个数字是**量出来的、不是拍的**：按现在的结构（何时使用 / 硬不变量 / 取值从哪来 /
 * 能力矩阵 / 已有基础的项目 / 执行流程 / 硬门控 / 文件地图 / 边界 / 汇报纪律）写完是
 * 二十几 KB，30 KB 留出一点余量——够写一条新机制。要再涨，先问「这条能不能并进
 * `references/`」，而不是抬这个数。
 *
 * **别在这里写「还剩多少」**：余量每天都在变，写进注释就变成下一个会过期的快照。
 * 想知道余量，看 `SKILL_WARN_HEADROOM` 那条告警——它每次跑都量当前值。
 */
const SKILL_MAX_BYTES = 30 * 1024
/** 余量告警线：离上限不足这么多字节时提醒一次。 */
const SKILL_WARN_HEADROOM = 2 * 1024

// 内核标记与字节预算都从 survey.mjs 取：它们是「同一件事的同一个值」，本文件自己写一份
// 就多一个要人记得同步的地方，而标记对不上的后果是覆盖用户正文。

/**
 * 保鲜超期阈值（天）。超过这么多天没重核即警告。
 *
 * 只警告不失败：时间流逝不是破损，红了就是误报——那种检查很快会被无视，
 * 而被无视的检查等于不存在。阈值只在这里定义一处，文档里不写死数字
 * （写了就会漂移）；警告信息里会报出已过期天数与重核哪几节。
 */
export const FRESHNESS_STALE_DAYS = 180

/**
 * 行为自检至少要跑出这么多条通过，少于此数视为「断言被删掉了一大片」。
 *
 * 为什么要这个下限：通过判据原先只看「有摘要行 + 退出码 0」，于是把 selftest.mjs 换成
 * 一句 `行为自检：0 项通过，0 项失败` 的空壳也算通过——断言全没了，门禁还绿着。
 * 「跑过但什么都没验」必须与「跑过且验了」长得不一样。
 *
 * 这个数是**量出来的**（当前全量通过数），不是随手写的整数：随断言增加而上调是正常的，
 * 下调则应视为信号——那多半意味着刚删掉了一片判据。调低时请一并说明删了什么。
 */
export const BEHAVIOR_MIN_PASSED = 715

/**
 * 「含构建机私有路径」这一项要豁免的文件，每个都写明豁免理由。
 *
 * 两类都合法，但理由不同：
 *   - **定义模式的文件**：它们必须写出各种路径形状才能检测别人（survey、preflight 自己）；
 *   - **测试数据的文件**：selftest 故意在 fixture 里放 `/home/me` 这类假路径，用来验证
 *     「真泄漏要报、测试数据不要误导」这条判定。删掉它就等于删掉那组测试。
 *
 * 顺带说明为什么不用「自动识别测试目录」来豁免：那会让检查逻辑与 survey 的判定逻辑
 * 缠在一起，而这一项检查的意义恰恰是**独立**看一眼有没有真路径漏进产物。宁可维护一份
 * 带理由的短名单，也不要让它学会忽略。
 */
const HOME_PATH_EXEMPT = new Map([
  ['scripts/dev/preflight.mjs', '定义路径检测模式，必须写出各种路径形状'],
  ['scripts/survey.mjs', '定义路径检测模式，必须写出各种路径形状'],
])

/**
 * 行为自检的分片：**整类豁免，不逐个登记**。
 *
 * 这些文件的主要工作就是往 fixture 里写「看着像泄漏」的假路径，用来验证分档判定
 * 是否准确。按文件名逐个登记的话，每拆一个测试文件就得回来加一行——而漏加的表现
 * 是「别的测试断言副本全绿，却被这条误报带红」，症状出现在别处，根因在这里。
 *
 * 判据落在「这是不是自检的测试代码」这个类别上，所以用目录加文件族来认，
 * 不用枚举文件名。
 */
const isSelftestCase = (rel) => /^scripts\/dev\/cases(-\d+)?\.mjs$/.test(rel)

/**
 * 参与文本检查的文件。
 *
 * 按扩展名判断会漏掉一整类重要的文件：`.gitignore`、`.gitattributes`、`LICENSE`、
 * `Makefile` 这些**没有扩展名**或名字特殊的文件，恰恰是配置与许可证所在。
 * 所以除了扩展名，另外按已知的特殊文件名与「无扩展名但不大」的规则收进来。
 */
const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt', '.svg'])
const TEXT_SPECIAL_NAMES = new Set([
  '.gitignore', '.gitattributes', '.npmignore', '.editorconfig', '.env.example',
  'license', 'licence', 'makefile', 'dockerfile', 'procfile',
])
const MAX_TEXTLESS_BYTES = 256 * 1024

/** SKILL.md 之外允许存在的顶层条目。多出来的东西要有人解释它为什么在这。 */
const ALLOWED_TOP_LEVEL = new Set([
  'SKILL.md', 'AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'RELEASING.md', 'LICENSE',
  // `docs/` 放本仓库自己的发布说明：它是这个项目的版本历史，不进用户包
  // （`.gitattributes` 里整目录排除，包边界判据会双向核对这一点）。
  'references', 'templates', 'scripts', 'assets', 'docs',
  '.github', '.gitignore', '.gitattributes', '.git',
])

const failures = []
const warnings = []

function fail(message) { failures.push(message) }
function warn(message) { warnings.push(message) }

function rel(p) { return relative(SKILL_ROOT, p).split('\\').join('/') }

function readText(p) {
  return readFileSync(p, 'utf8')
}

/**
 * 这个仓库的文件全集（相对仓库根，POSIX 分隔符）。
 *
 * 判据是**仓库的定义域**，不是「工作目录里现在有什么」：受版本控制跟踪的文件，
 * 加上尚未被忽略的新文件——这正是「这个仓库包含什么」，由项目自己的版本控制给出。
 *
 * 为什么不维护「该跳过哪些目录」的黑名单：那种写法每来一个工具就要再加一条
 * （编辑器缓存、依赖、构建产物、多智能体协作状态……），而这份名单永远追不上环境
 * 的变化；它还会把「检查了谁」变成一个需要人记得维护的取值。按定义域判则一视同仁：
 * 只要这些目录被忽略（正常项目都会忽略），就自动落在定义之外，脚本不需要认识
 * 其中任何一个——通则即稳定。
 *
 * 为什么不用 git 之外的手段判断忽略规则：忽略语法有通配、否定、层级差异，自己解析
 * 必然有偏差，而这里的偏差代价是「该查的没查」或「不该查的被查」。项目自身的忽略
 * 规则才是权威来源（它同时覆盖仓库级、本机级与全局级）。
 *
 * git 不可用（没装、或这个目录还不是仓库）时退回纯文件系统扫描：此时没有权威的忽略
 * 规则，只能跳过两个一定不属于仓库的目录，并把降级如实报告出来。静默降级会让检查
 * 看起来覆盖了全部文件而实际没有——那比不查更坏。
 *
 * 导出给 selftest：判定要能被直接证伪，而不是只能靠跑整棵 skill 树观察（同 evalFreshnessMarker）。
 */
export function listRepoFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error === undefined && r.status === 0 && typeof r.stdout === 'string') {
    // -z：路径按字节给、不做引号转义，含空格或中文的路径才不会被改写成另一个字符串。
    return { files: r.stdout.split('\0').filter((p) => p !== ''), source: 'git' }
  }
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (entry.isFile()) files.push(relative(root, full).split(/[\\/]/).join('/'))
    }
  }
  walk(root)
  return { files, source: 'fs' }
}

/** 定义域只算一次；降级提示也只报一次（两个调用方共用同一份结果）。 */
let repoDomainCache
function repoDomain() {
  if (repoDomainCache === undefined) {
    repoDomainCache = listRepoFiles(SKILL_ROOT)
    if (repoDomainCache.source === 'fs') {
      warn('git 不可用：文本检查域退回文件系统扫描（只跳过 .git 与依赖目录）——'
        + '本机状态目录可能被一并计入，覆盖面与「仓库定义域」不同。这是降级，不是全查。')
    }
  }
  return repoDomainCache
}

/** 定义域里参与逐字检查的文本文件（绝对路径）。 */
function repoTextFiles() {
  const out = []
  for (const rel of repoDomain().files) {
    const full = join(SKILL_ROOT, rel)
    // 索引里有、工作区里没有（已暂存删除）的条目要跳过，否则读文件时直接抛错。
    if (!existsSync(full)) continue
    const lower = rel.split('/').pop().toLowerCase()
    const dot = lower.lastIndexOf('.')
    const ext = dot <= 0 ? '' : lower.slice(dot)
    if (TEXT_EXTENSIONS.has(ext) || TEXT_SPECIAL_NAMES.has(lower)) { out.push(full); continue }
    // 无扩展名的文件也纳入，但要排除明显的二进制大文件
    if (dot <= 0) {
      try {
        if (statSync(full).size <= MAX_TEXTLESS_BYTES) out.push(full)
      } catch { /* 读不到就跳过 */ }
    }
  }
  return out
}

// ── SKILL.md 能否被宿主识别 ─────────────────────────────────────────

function checkSkillFile() {
  const path = join(SKILL_ROOT, 'SKILL.md')
  if (!existsSync(path)) { fail('缺少 SKILL.md —— 宿主不会识别这个 skill。'); return undefined }
  const raw = readText(path)
  const text = raw.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') { fail('SKILL.md 第一行必须是 ---（YAML frontmatter 起始）。'); return undefined }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === '---') { end = i; break }
  if (end < 0) { fail('SKILL.md 的 frontmatter 没有结束标记 ---。'); return undefined }
  const block = lines.slice(1, end).join('\n')

  const nameMatch = /^name:[ \t]*(.+)$/m.exec(block)
  if (nameMatch === null) { fail('SKILL.md frontmatter 缺少 name。'); return undefined }
  const name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail(`SKILL.md 的 name「${name}」不符合宿主规则 ^[a-z0-9]+(?:-[a-z0-9]+)*$ —— 宿主会忽略整个 skill。`)
  }
  const dirName = basename(SKILL_ROOT)
  if (name !== dirName) {
    // 这条是**本 skill 自己的约定**，不是宿主要求：目录名只是定位，`name` 才是路由与
    // 覆盖的依据，两者不一致宿主照样加载得起来。仍然报错，是因为它自己的文档到处按
    // 目录路径指认自己（安装、克隆、报错信息都靠它），不一致时读的人得先查一遍装的
    // 到底是哪一个。判据来自真实需要，措辞就不能冒充宿主规则。
    fail(`SKILL.md 的 name「${name}」与目录名「${dirName}」不一致 —— 这是本 skill 的约定：`
      + '目录路径就是它对外的身份，不一致时读者要先查一遍装的是哪一个。')
  }
  if (!/^description:[ \t]*\|?/m.test(block)) {
    fail('SKILL.md frontmatter 缺少 description —— 宿主不识别没有描述的技能。')
  } else {
    // 取 description 的值（支持块标量），只用于长度估算
    const descLines = []
    let collecting = false
    for (const line of block.split('\n')) {
      if (/^description:/.test(line)) { collecting = true; descLines.push(line.replace(/^description:[ \t]*\|?[ \t]*/, '')); continue }
      if (collecting) {
        if (/^[A-Za-z-]+:/.test(line)) break
        descLines.push(line)
      }
    }
    const desc = descLines.join('\n').trim()
    // 长度必须按**空白归一化之后**算，与宿主目录里那段截断代码同一个算法。
    // 用原始长度判会算错：块标量里一次缩进换行就是一个字符，而宿主先把连续空白压成
    // 一个空格再比——按原始长度报出的「超限」在宿主那里根本没超，按原始长度放过的
    // 才真的会被截掉。后者是更难查的那种（自检全绿，目录里却少了半句）。
    const descNorm = desc.replace(/\s+/g, ' ').trim()
    if (descNorm.length === 0) fail('SKILL.md 的 description 为空。')
    else if (descNorm.length > CATALOG_DESCRIPTION_MAX) {
      fail(
        `description 归一化后长度 ${descNorm.length} 超过 ${CATALOG_DESCRIPTION_MAX} —— `
        + '超出部分在会话技能目录里会被截断，等于不存在。请把触发词前置、精简表述。',
      )
    }
  }
  // 驼峰旧键会让宿主直接拒绝加载
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (new RegExp(`^${legacy}:`, 'm').test(block)) {
      fail(`frontmatter 使用了已废弃的驼峰键 ${legacy}，宿主会拒绝加载；请改用连字符形式。`)
    }
  }
  return { text, name }
}

// ── 引用完整性 ──────────────────────────────────────────────────────

/**
 * 一份 Markdown 里引用的资源路径（去重）。
 *
 * 两种写法都要收：行内代码 `` `references/x.md` `` 与 Markdown 链接 `[说明](references/x.md)`。
 * 同一套目录下的两种形状必须一起查——只认一种，另一种就成了没人看守的门，而链接写法
 * 恰恰是 AI 最容易顺手写出来的形状。
 *
 * 只认这四个目录：本 skill 的资源就在这几类下（`assets/` 是 README 的图，图片链接断掉
 * 同样是「读者照着它找东西，找不到」）。占位示例请写成
 * `references/<文件名>.md`——尖括号不在字符类里，因此不会被当成真实路径去检查。
 * 这是刻意的：占位符不是引用，报它属于误报。链接形态额外容忍锚点与标题尾巴。
 */
export function referencedPaths(text) {
  const out = new Set()
  const src = String(text ?? '')
  for (const m of src.matchAll(/`((?:references|templates|scripts|assets)\/[A-Za-z0-9._/-]+)`/g)) out.add(m[1])
  for (const m of src.matchAll(
    /\]\(\s*((?:references|templates|scripts|assets)\/[A-Za-z0-9._/-]+)\s*(?:#[^)\s]*)?\s*(?:"[^"]*")?\)/g,
  )) out.add(m[1])
  return [...out]
}

/**
 * 扫描文档里的资源引用，逐个确认文件存在。
 *
 * 覆盖全部文档而不只是 SKILL.md：reference 之间互相引用是常态，只查入口等于只守住了
 * 一扇门。引用断链的代价很高——AI 按图索骥走到死路，然后开始猜。
 *
 * **`templates/` 不在这里判**：那些文件会落盘到别的项目，它们的引用该问的是「归属是谁」
 * 而不是「本包里有没有」——对着本仓库根判存在，对它们正好说反话。那份判据归
 * `checkDeliveredAttribution`。一个文件只归一个判据管：两套方向相反的判据并存，
 * 迟早给出两个答案，而其中必有一个是错的。
 *
 * **`docs/` 里只有 `release-notes/` 不判，不是整个 `docs/`**：发布说明是**历史快照**——它
 * 写的是「那一版的仓库长什么样」，提到某个后来被删掉的文件是**正确**的历史陈述，不是断链。
 * 但同一个 `docs/` 下还有**活文档**（工作记录、设计与决策记录）：它们描述的是现在，断链就是
 * 断链。一刀切豁免整个目录，等于让 `docs/` 变成引用检查的盲区——而那正是 AI 最常去读的
 * 地方之一。两种东西判据相反，判据就必须分开。
 */
function checkReferencesResolve() {
  const docs = repoTextFiles()
    .filter((f) => f.endsWith('.md'))
    .filter((f) => !rel(f).startsWith('templates/'))
    .filter((f) => !rel(f).startsWith('docs/release-notes/'))
  if (docs.length === 0) { fail('没有找到任何 Markdown 文件。'); return }
  let total = 0
  for (const full of docs) {
    const name = rel(full)
    const text = readText(full).replace(/^\uFEFF/, '')
    for (const target of referencedPaths(text).sort()) {
      total += 1
      if (!existsSync(join(SKILL_ROOT, target))) {
        fail(`${name} 引用了不存在的文件：${target} —— AI 会按图索骥走到死路。`)
      }
    }
  }
  if (total === 0) warn('全文没有引用任何 references / templates / scripts 路径。')
}

// ── references 的结构约定 ───────────────────────────────────────────

function checkReferences() {
  const dir = join(SKILL_ROOT, 'references')
  if (!existsSync(dir)) { fail('缺少 references 目录。'); return }
  const files = []
  const collect = (sub) => {
    let entries = []
    try {
      entries = readdirSync(join(dir, sub), { withFileTypes: true, encoding: 'utf8' })
    } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) { collect(sub === '' ? e.name : `${sub}/${e.name}`); continue }
      if (e.isFile() && e.name.endsWith('.md')) files.push(sub === '' ? e.name : `${sub}/${e.name}`)
    }
  }
  collect('')
  if (files.length === 0) { fail('references 目录里没有任何 Markdown 文件。'); return }
  for (const file of files) {
    const text = readText(join(dir, file)).replace(/^\uFEFF/, '')
    const lines = text.split(/\r?\n/)
    const first = lines.find((l) => l.trim() !== '')
    if (first === undefined || !first.startsWith('# ')) {
      fail(`references/${file} 的第一行必须是一级标题（# 标题）。`)
    }
    if (!/^## 何时读本文件[ \t]*$/m.test(text)) {
      fail(`references/${file} 缺少二级标题「## 何时读本文件」—— AI 无法判断何时该读它。`)
    }
    if (text.trim().length < 400) {
      warn(`references/${file} 内容过短（${text.trim().length} 字符），可能不足以支撑决策。`)
    }
  }
}

// ── templates 的标记与内核一致性 ────────────────────────────────────

function checkTemplates() {
  const dir = join(SKILL_ROOT, 'templates')
  if (!existsSync(dir)) { fail('缺少 templates 目录。'); return }
  for (const f of ['agents-kernel.md', 'agents-project.md', 'readme.md', 'contributing.md']) {
    if (!existsSync(join(dir, f))) fail(`缺少 templates/${f}。`)
  }
  // 许可证模板：docs-set 让使用者从这里取用而不是凭记忆写，缺了就等于没守住那条规则。
  //
  // 占位符按模板逐个声明，不用统一规则：Unlicense 是「放弃权利」，**全文没有版权行**
  // ——没有年份也没有持有人，这是它与其他许可证的实质区别。给它硬塞占位符反而是错的。
  const LICENSE_TEMPLATES = [
    { file: 'license-mit.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    { file: 'license-isc.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    { file: 'license-bsd-2-clause.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    { file: 'license-bsd-3-clause.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    // Unlicense 是**反向**断言：它的实质是放弃权利，所以既没有占位符、也没有版权行。
    // 只查「占位符存在」会漏掉这一类——有人好心地补一行 `Copyright (c)` 进去，
    // 文档里那句「全文没有版权行」就变成了假话，而检查什么都不会说。
    {
      file: 'license-unlicense.txt',
      tokens: [],
      absent: ['Copyright (c)', '{{'],
      note: '放弃权利，无版权行',
    },
  ]
  for (const { file, tokens, absent } of LICENSE_TEMPLATES) {
    const p = join(dir, file)
    if (!existsSync(p)) { fail(`缺少 templates/${file}（许可证模板，docs-set 引用它）。`); continue }
    const text = readText(p)
    for (const token of tokens) {
      if (!text.includes(token)) fail(`templates/${file} 缺少占位符 ${token}。`)
    }
    for (const marker of absent ?? []) {
      if (text.includes(marker)) {
        fail(`templates/${file} 出现了不该有的内容「${marker}」——它是放弃权利的标准文本，`
          + '没有版权行也没有占位符；补上它们会与 docs-set 的说明和许可证性质矛盾。')
      }
    }
    if (text.trim().length < 200) fail(`templates/${file} 内容异常短，可能不是完整许可证文本。`)
  }
  // docs-set 里列出的模板表必须与实际文件一致
  const docsSet = join(SKILL_ROOT, 'references', 'docs-set.md')
  if (existsSync(docsSet)) {
    const text = readText(docsSet)
    for (const m of text.matchAll(/`(templates\/license-[a-z0-9-]+\.txt)`/g)) {
      if (!existsSync(join(SKILL_ROOT, m[1]))) {
        fail(`references/docs-set.md 引用了不存在的许可证模板：${m[1]}。`)
      }
    }
  }
  const kernelPath = join(dir, 'agents-kernel.md')
  if (!existsSync(kernelPath)) return

  const kernel = readText(kernelPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  for (const marker of ['## 行事总纲', '## 本文件的定位与编辑规则']) {
    if (!kernel.includes(marker)) fail(`templates/agents-kernel.md 缺少必需章节：${marker}`)
  }
  // 内核不受 AGENTS.md 的字节上限约束：它归这份模板独占，改多少都行，改完重新注入即可。

  const skeletonPath = join(dir, 'agents-project.md')
  if (!existsSync(skeletonPath)) return
  const skeleton = readText(skeletonPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!skeleton.includes(KERNEL_START) || !skeleton.includes(KERNEL_END)) {
    fail('templates/agents-project.md 缺少内核标记，脚本无法注入。')
  }
  const si = skeleton.indexOf(KERNEL_START)
  const ei = skeleton.indexOf(KERNEL_END)
  if (si >= 0 && ei > si && skeleton.slice(si + KERNEL_START.length, ei).trim() !== '') {
    warn('templates/agents-project.md 的内核标记之间不是空的 —— 注入时会被覆盖，这是预期的，但请确认没有把项目特有内容放进去。')
  }
}

// ── 落盘族的引用归属 ────────────────────────────────────────────

/**
 * `templates/` 整棵树是「落盘族」：这里的文件会被复制或生成为**别的项目**的文件。
 *
 * 判据只问一件事：**这条引用是谁的文件**。
 *
 * 为什么不能用「本包里找得到吗」：`checkReferencesResolve` 对着本仓库根判存在，
 * 而那对落盘族正好说反话——`references/publish.md` 在本仓真实存在，落盘到目标项目
 * 却是一条死链。**越是自己家的东西，那个判据给的答案越像「没问题」。**
 *
 * 所以这里的定义域由目录结构给出（`templates/` 整棵树），不看「本包有没有」，
 * 只看归属：
 *
 *   - 落在本 skill 独占命名空间（`references/`、`templates/`、`assets/`）→ 红。
 *     目标项目不可能自然需要这些目录，出现即是把本 skill 的路径带了过去。
 *   - 指向本包真实存在的脚本 → 红。读者会照着跑，而目标项目没有那个文件。
 *     这条只在**本包真的有同名脚本**时成立：否则那是目标项目自己的脚本名，不能判。
 *   - 不带这些前缀的（`README.en.md`、`CONTRIBUTING.md`、`LICENSE`、`.github/*`）
 *     → **根本不判**。它们本来就是目标项目的文件。
 *
 * 定义域来自目录结构，所以新增 `templates/security.md` 这类文件**自动纳入**，
 * 不需要谁记得登记清单。
 *
 * 三类例外，各有理由：
 *   - `pf:` 与 `project-forge:kernel:` 是**受管围栏标记**，不是引用；
 *   - 围栏代码块里的示例不判（`.md` 才适用；`.yml` 里 `run:` 下的就是真执行，照判）；
 *   - 尖括号通配（`references/publish-<生态>.md`）按 `*` 展开后匹配——读者看到的
 *     就是一个路径，它对读者和对门禁应当一视同仁。
 */
function checkDeliveredAttribution() {
  const dir = join(SKILL_ROOT, 'templates')
  if (!existsSync(dir)) { fail('缺少 templates 目录。'); return }

  // 受管标记：它们是本 skill 自己的围栏，不是写给目标项目的引用。
  // 判据来自 lib/protocol.mjs：四枚具名标记从常量拼出来，外加 `pf:` 开放命名空间。
  // 在这里重抄一遍字面量，就是第二份真相——改一处另一边不出声。
  const MANAGED_MARK_RE = new RegExp(PROTOCOL_MANAGED_MARK_RE.source, 'g')

  // 本包独占命名空间。`scripts/` 另判：它是通用目录名，目标项目也常有。
  //
  // 路径主体的字符类用**排除式**而不是白名单：白名单会把中文挡在外面，而真实的
  // 遗留写法恰好是 `references/publish-<生态>.md` —— 占位符里就是中文。用白名单时
  // 它只会匹配到 `references/publish-<` 就截断，于是这条判据对最典型的那种写法失灵。
  const PATH_CHAR = '[^\\s`\'"()\\[\\]，。；：、！？]'
  const OWNED_RE = new RegExp(`(?:^|[^\\w/.-])((?:references|templates|assets)/${PATH_CHAR}+)`, 'g')
  const SCRIPT_RE = new RegExp(`(?:^|[^\\w/.-])(scripts/${PATH_CHAR}+\\.mjs)`, 'g')

  const expand = (spec) => (spec.includes('<') || spec.includes('>')
    ? spec.replace(/<[^<>]{1,40}>/g, '*')
    : spec)

  const fileExistsLoose = (spec) => {
    if (!spec.includes('*')) return existsSync(join(SKILL_ROOT, spec))
    const re = new RegExp(`^${spec.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`)
    const base = spec.split('/')[0]
    let entries = []
    try {
      entries = readdirSync(join(SKILL_ROOT, base), { withFileTypes: true, encoding: 'utf8' })
    } catch { return false }
    return entries.some((e) => re.test(`${base}/${e.name}`))
  }

  // 归属判据只看**命名空间**，不看文件在不在。
  //
  // `references/`、`templates/`、`assets/` 是本 skill 自己的布局，目标项目不会自然长出来；
  // 所以凡是这三个前缀开头的引用，都是把本 skill 的路径带了过去——**路径写错、文件不存在
  // 同样是错的**，而且那种更糟：它在两个项目里都找不到东西。要求「文件存在」才算归属，
  // 恰好会放过这一类。
  const isOwned = (spec) => /^(?:references|templates|assets)\//.test(spec)

  // `scripts/` 是通用目录名，目标项目也常有，所以这一条必须看本包**真的有**那个脚本：
  // 否则目标项目自己的 `scripts/build.mjs` 会被误判成我们的。
  //
  // **例外：要落到目标项目里去的那几个脚本**（`LANDED_SCRIPTS`）。它们的用法就是
  // 「拷进项目的 `scripts/` 之后在那儿跑」——模板里指它是对的，不指才是漏了。
  // 这条例外写成一张显式表，不靠「名字里带某个词」之类的启发式：那种判据在加第二个
  // 脚本时会静默失灵，而失灵的后果是把一条正确的引用判成死链。
  //
  // **例外本身也要对账**：表里写一个磁盘上不存在的脚本时，那条例外会把「死链该红」
  // 变成「归例外管，绿着放行」——失败方向是放过。所以下面单独核一次表项与磁盘。
  const isOurScript = (spec) => spec.startsWith('scripts/')
    && fileExistsLoose(expand(spec))
    && !LANDED_SCRIPTS.includes(expand(spec))

  // 围栏代码块：只对 Markdown 生效。行号要与原文对齐，所以按行追踪。
  const fencedLines = (text, isMarkdown) => {
    const out = new Set()
    if (!isMarkdown) return out
    let inside = false
    let fence = ''
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const m = /^\s*(`{3,}|~{3,})/.exec(lines[i])
      if (m !== null) {
        if (!inside) { inside = true; fence = m[1][0] } else if (m[1][0] === fence) { inside = false; fence = '' }
        out.add(i + 1)
        continue
      }
      if (inside) out.add(i + 1)
    }
    return out
  }

  const files = []
  const collect = (sub) => {
    let entries = []
    try {
      entries = readdirSync(join(dir, sub), { withFileTypes: true, encoding: 'utf8' })
    } catch { return }
    for (const e of entries) {
      const rel = sub === '' ? e.name : `${sub}/${e.name}`
      if (e.isDirectory()) collect(rel)
      else files.push(rel)
    }
  }
  collect('')

  let checked = 0
  for (const rel of files.sort()) {
    const full = join(dir, rel)
    const text = readText(full).replace(/^\uFEFF/, '')
    const isMarkdown = rel.endsWith('.md')
    const isYaml = rel.endsWith('.yml') || rel.endsWith('.yaml')
    const skip = fencedLines(text, isMarkdown)
    // 受管标记先抹成等长空白，保持行号不变
    const stripped = text.replace(MANAGED_MARK_RE, (m) => ' '.repeat(m.length))

    const lines = stripped.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (skip.has(i + 1)) continue
      const line = lines[i]
      for (const re of [OWNED_RE, SCRIPT_RE]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(line)) !== null) {
          const spec = m[1]
          checked += 1
          const owned = re === OWNED_RE ? isOwned(spec) : isOurScript(spec)
          if (!owned) continue
          // 两种情形分开说，因为修法不同：一种是把别人的路径带过去了（改成自足的判据），
          // 一种是连本包里都没有这个概念（那是写错了，先确认要指的是什么）。
          const exists = fileExistsLoose(expand(spec))
          const why = exists
            ? '那是本 skill 自己的路径，落盘到别的项目后读者会扑空（目标项目没有这个目录或文件）。'
            : '这个路径在本 skill 里也不存在——读者在两个项目里都找不到东西。'
          // YAML 里的非注释行是**真会执行**的指令，比文档里的一句话严重得多：
          // 文档里的死链读者会发现，流水线里的死命令是发版当天才红。
          const tail = isYaml && !/^\s*#/.test(line)
            ? '这一行在流水线里会**真的被执行**，不只是读不到。'
            : ''
          fail(`templates/${rel}:${i + 1} 引用了 ${spec} —— ${why}`
            + tail
            + '改法：讲规则就把判据写在这里，指工具就写成外部地址或显式占位。')
        }
      }
    }
  }
  // 零命中就是正常状态：落盘族里本来就不该出现本 skill 的路径。这条判据的红是
  // 「发现了」，不是「没发现」。
  //
  // 但有一种情形值得喊：模板里**确实写着** `references/` 这类前缀，而判据一处都没收进来。
  // 那说明正则或定义域失效了——判据在，却什么也没看见，而它不会以红的方式表现出来。
  // 「判据自己报告有没有命中」是不可靠的自证，所以这里直接拿前缀当探针。
  if (checked === 0) {
    const probe = /(?:references|templates|assets)\/|scripts\/[^\s`'"]+\.mjs/
    const suspects = files.filter((rel) => probe.test(readText(join(dir, rel)) ?? ''))
    if (suspects.length > 0) {
      fail(`templates/ 里 ${suspects.join('、')} 出现了路径前缀，而归属判据一处都没扫到 —— `
        + '判据在，却没看见东西；先修判据，不要当它已经生效。')
    }
  }
}

// ── AGENTS.md 的内核与模板一致 ──────────────────────────────────────

function checkAgentsKernel() {
  const agentsPath = join(SKILL_ROOT, 'AGENTS.md')
  if (!existsSync(agentsPath)) { warn('本 skill 还没有 AGENTS.md。'); return }
  const kernelPath = join(SKILL_ROOT, 'templates', 'agents-kernel.md')
  if (!existsSync(kernelPath)) return
  const agents = readText(agentsPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const kernel = readText(kernelPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    .replaceAll(KERNEL_START, '').replaceAll(KERNEL_END, '')
    .replace(/^\n+/, '').replace(/\n+$/, '')
  const si = agents.indexOf(KERNEL_START)
  const ei = agents.indexOf(KERNEL_END)
  if (si < 0 || ei < 0) { fail('AGENTS.md 缺少内核标记。'); return }
  const embedded = agents.slice(si + KERNEL_START.length, ei).replace(/^\n/, '').replace(/\n$/, '')
  if (embedded !== kernel) {
    fail('AGENTS.md 里的内核与 templates/agents-kernel.md 不一致。修正：node scripts/compose-agents.mjs .')
  }
  const bytes = Buffer.byteLength(agents, 'utf8')
  // 本项目自己那份的硬上限，比通用预算严：它每次会话都注入，同时还要给人看。
  // 超了压项目节——内核归 templates/agents-kernel.md 独占，不受这个数字约束。
  if (bytes > OWN_AGENTS_MAX_BYTES) {
    fail(`AGENTS.md 共 ${bytes} 字节，超过本项目自己的上限 ${OWN_AGENTS_MAX_BYTES}—— `
      + '要压就压项目节，不要去动行事总纲（内核由 templates/agents-kernel.md 独占，改它只需改模板并重新注入）。')
  } else if (bytes > OWN_AGENTS_MAX_BYTES - OWN_AGENTS_WARN_HEADROOM) {
    warn(`AGENTS.md 距本项目上限只剩 ${OWN_AGENTS_MAX_BYTES - bytes} 字节，项目节该收一收了。`)
  }
  // 本项目自己的上限（48 KB）严于通用注入预算，所以后者在这里判不到——
  // 留一条不可达的分支只会让下一个改常量的人以为它在生效。
}

/**
 * `SKILL.md` 的体量：它是唯一一份**每次调用都整份进上下文**的文档。
 *
 * 判据只压「总字节」，不压某一节——哪一节该压是判断，而判断归人：报告里报出字节数与
 * 余量，怎么压由写的人定。**超了就是失败**（不是提示）：这条线的全部意义就是「不许再长」，
 * 一条不会红的线等于没有。
 */
function checkSkillSize(skill) {
  if (skill === undefined || typeof skill.text !== 'string') return
  const bytes = Buffer.byteLength(skill.text, 'utf8')
  if (bytes > SKILL_MAX_BYTES) {
    fail(`SKILL.md 共 ${bytes} 字节，超过上限 ${SKILL_MAX_BYTES} —— 它是每次调用都整份读进`
      + '上下文的唯一一份文档，再长就开始稀释注意力。要加东西先问「这条能不能并进'
      + ' `references/`」；判据与论证一律搬走，入口只留指针。')
  } else if (bytes > SKILL_MAX_BYTES - SKILL_WARN_HEADROOM) {
    warn(`SKILL.md 距上限只剩 ${SKILL_MAX_BYTES - bytes} 字节——该往 references 搬一点了。`)
  }
}

// ── 全文硬性规范（emoji / BOM / 行尾 / 私有路径） ───────────────────

/**
 * Extended_Pictographic 覆盖绝大多数 emoji。箭头一类符号不在其内（U+2192），可正常使用。
 *
 * 「对勾」要看具体码位：U+2713（CHECK MARK）不在其内，U+2714（HEAVY CHECK MARK）**在**
 * 其内——两者几乎一样宽，被这条判红的却是后者。文档里要打勾用前者。
 */
const EMOJI = /\p{Extended_Pictographic}/u
/** 本机私有路径的判据与 survey 同源（survey 导出 HOME_PATH_RE，两份手写正则必然漂移）。 */

/**
 * ASCII 控制字符：**排除**制表、换行、回车这三个正常排版用的。
 *
 * 判据取「不可见且不代表排版」这个类，不是枚举某次事故里出现过的那几个字节——
 * 后者只能挡住已经发生过的事。
 */
const CTRL_CHAR_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/
const HOME_PATH = HOME_PATH_RE

function checkGlobalRules() {
  const files = repoTextFiles()
  if (files.length === 0) { fail('没有收集到任何文本文件。'); return }
  for (const full of files) {
    const name = rel(full)
    const raw = readText(full)
    if (raw.startsWith('\uFEFF')) fail(`${name} 含 BOM，会让产物在不同工具下出现差异。`)
    // **控制字符是不可见损坏**，靠眼睛永远发现不了。
    //
    // 它最常见的来源不是手误，而是工具链：把含反引号的 Markdown 经 PowerShell 双引号
    // 字符串传递时，`a `b `f `n `v `e 会被当成转义序列，于是 `author` 变成 0x07 + utor，
    // `bench.mjs` 变成 0x08 + ench.mjs。写成文件后**终端会吞掉它们**，看起来只是一两个
    // 字母丢了，而真正的原因藏在字节里。
    //
    // 这条判据不是为某一次事故立的碑：它守的是一个类——任何让不可见字节进入文本的路径。
    const CTRL_HIT = raw.match(CTRL_CHAR_RE)
    if (CTRL_HIT !== null) {
      const at = raw.indexOf(CTRL_HIT[0])
      const line = raw.slice(0, at).split('\n').length
      const hex = `0x${CTRL_HIT[0].charCodeAt(0).toString(16).padStart(2, '0')}`
      fail(`${name}:${line} 含 ASCII 控制字符 ${hex} —— 它不可见，但会吞掉终端里的字符。`
        + '常见成因是拿 PowerShell 双引号传含反引号的 Markdown（`a `b `f `n `v `e 会被转义）；'
        + '用编辑工具或 Node 脚本写文件，别经 shell 转述。')
    }
    if (EMOJI.test(raw)) {
      const hit = raw.match(EMOJI)
      fail(`${name} 含 emoji 字符（${JSON.stringify(hit?.[0])}）—— 项目硬性规范禁止。`)
    }
    if (/\r\n/.test(raw)) {
      warn(`${name} 含 CRLF 行尾。若在 Windows 上检出后出现，执行 git add --renormalize . 重新规范化。`)
    }
    if (!HOME_PATH_EXEMPT.has(name) && !isSelftestCase(name) && HOME_PATH.test(raw)) {
      fail(`${name} 含构建机私有路径 —— 换台机器就会失准。`
        + '（自检的分片会故意放假路径来验分档判定，那一类由 isSelftestCase 认；'
        + '其余文件若确实需要，加进 HOME_PATH_EXEMPT 并写明理由。）')
    }
  }
  // 顶层目录整洁：多出来的条目必须有明确归属。
  //
  // 判据同样取**仓库定义域**：本机状态目录（被忽略、不属于这个仓库）不该在这里被要求
  // 解释——它不是这个仓库的内容，工具下次还会生成它。只有属于仓库的条目才需要有人
  // 说明它为什么在这。
  let entries = []
  try { entries = readdirSync(SKILL_ROOT, { withFileTypes: true, encoding: 'utf8' }).map((e) => e.name) } catch { /* 忽略 */ }
  const domainFiles = repoDomain().files
  for (const entry of entries) {
    if (ALLOWED_TOP_LEVEL.has(entry)) continue
    if (README_NAME_RE.test(entry)) continue
    if (!domainFiles.some((p) => p === entry || p.startsWith(`${entry}/`))) continue
    warn(`顶层出现未登记的条目：${entry} —— 请确认它是否应该在这里。`)
  }
}

// ── 脚本自身可执行 ──────────────────────────────────────────────────

/**
 * 文本里出现的模块说明符（去重、保序）。
 *
 * 四种形状都收：静态导入的说明符、裸副作用导入、动态导入、CommonJS 的 require，
 * 单引号与双引号等价。只认其中一种会让其余全部溜过去——而它们装的是同一个东西：
 * 外部依赖。纯函数，直接可证伪。
 *
 * **整行的注释不参与扫描**。文档注释里常要举「动态导入长什么样」的例子，照抄字面量
 * 就会把自己变成一条假阳性；而整行注释（以两个斜杠、星号或注释起始符开头）不可能是
 * 代码，剔掉它不改变任何一条真实导入的判定。
 */
export function moduleSpecifiers(text) {
  const code = String(text ?? '')
    .split('\n').filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l)).join('\n')
  const out = []
  const push = (spec) => { if (spec !== '' && !out.includes(spec)) out.push(spec) }

  // 判据要同时防住两头，而这两头都真实发生过：
  //
  //   漏报：只认 `from 'x'` 一种写法，于是双引号、`require(…)`、动态 `import(…)`、
  //         纯副作用导入四种形状全漏（实测漏过四个）。
  //   误报：`from` 的前边界用 `\b`，于是 `const leaks = []` 里 `leaks` 结尾的
  //         `s` 与后面的 `from` 之间**恰好是词边界**，匹配上；中间那个 `\s*` 再跨过
  //         换行，把下一行的字符串当成模块名。报出来的名字是「, leaks.join(」这种
  //         明显不是模块的碎片，而它报的却是「你必须先装东西才能用这个 skill」。
  //
  // 两个边界因此都收紧：
  //   前边界：关键字前面必须是**行首或空白/标点**（不能紧贴标识符，`leaks` 里的 `s`
  //           与 `from` 之间恰好是词边界，用 `\b` 会匹配上）；
  //   后边界：关键字与引号之间**必须有空白或左括号**，且不许跨行。
  //   这一条还挡掉另一种真实写法：`'...别处只能 import', leaks.join(` —— 散文里提到
  //   `import` 这个词，后面紧跟的是引号收尾，不是模块名。关键字后没有任何空白 / 括号，
  //   就不可能是导入。
  const KW = '(?:^|[\\s;{(,])(?:from|import|require)'
  // 语句式：`from 'x'`、`import 'x'`、`import { a } from 'x'`、`import ('x')`
  for (const m of code.matchAll(
    new RegExp(`${KW}[ \\t]+(?:\\([ \\t]*)?(['"])([^'"\\n]+)\\1`, 'gm'),
  )) push(m[2])
  // 调用式：`require('x')`、`import('x')`（关键字与括号之间允许紧贴）
  for (const m of code.matchAll(
    new RegExp(`${KW}[ \\t]*\\([ \\t]*(['"])([^'"\\n]+)\\1`, 'gm'),
  )) push(m[2])
  return out
}

/**
 * 零依赖的含义是「不要求使用者先装东西」，因此允许两类：`node:` 前缀的内置模块，
 * 与相对路径（本 skill 自己的其他脚本，随仓库一起走）。其余裸模块名一律拒绝：
 * 那是要装的东西。
 */
export function externalModules(text) {
  return moduleSpecifiers(text).filter(
    (spec) => !spec.startsWith('node:') && !spec.startsWith('./') && !spec.startsWith('../'),
  )
}

/**
 * 这个文件看起来是不是一个**可执行入口**（而不是被 import 的模块）。
 *
 * 判据是**顶层锚定**的那一行 `if (isMainModule(`：入口的写法只有这一种形状——行首第 0 列，
 * 条件里第一件事就是它。而「文件里出现过这个词」不是判据：测试分片拿它做单元断言
 * （`check(isMainModule(...) === true, ...)`）、拿它拼进字符串当夹具，都会因为这个词
 * 出现过而被认成入口，于是纯模块白白多出一条提示。提示多了，人会学会忽略它——
 * 那时它真正要说的那一次也一起被忽略了。
 *
 * 导出来是为了让断言能**直接测判据本身**，而不必靠造一个带坏 shebang 的文件再读输出：
 * 判据改了、断言跟着改，两者不会各说各话。
 */
export function looksLikeEntry(text) {
  return /^if\s*\(\s*isMainModule\s*\(/m.test(text)
}

function checkScripts() {
  const dir = join(SKILL_ROOT, 'scripts')
  if (!existsSync(dir)) { fail('缺少 scripts 目录。'); return }
  // **扫磁盘，不扫清单**：这一组检查（shebang、体积、零依赖、语法）必须覆盖每一个真实存在的
  // 脚本文件——包括刚建好、还没人提及的那个，那正是最需要先过一遍语法与依赖的时刻。
  // 哪些进包由 `checkPackageBoundary` 按结构规则判；这里只管「每个文件本身健不健康」，
  // 两件事分开，各自都不会漏。
  const inspect = (p, rel) => {
    if (!existsSync(p)) { fail(`缺少 ${rel}。`); return }
    const text = readText(p)
    // shebang 只对**可执行入口**有意义。纯模块（只被 import、从不直接跑）加了它是噪音，
    // 不加它也不影响任何事——按「是不是入口」判，而不是按「在不在 scripts/ 下」判。
    if (!text.startsWith('#!/usr/bin/env node') && looksLikeEntry(text)) {
      warn(`${rel} 看起来是入口（有命令行处理），但没有 node shebang。`)
    }
    if (statSync(p).size < 200) fail(`${rel} 内容异常短。`)
    for (const spec of externalModules(text)) {
      fail(`${rel} 引入了外部模块「${spec}」—— 这个 skill 必须零依赖。`)
    }
    // 语法检查：只看能不能解析，不执行。没有这一条，一个语法错误的脚本要等到有人真的
    // 跑到它才会暴露——而 `update.mjs` 这类只在特定时机被调用的脚本，可能很久都没人跑。
    const parsed = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8', windowsHide: true })
    if (parsed.status !== 0) {
      fail(`${rel} 有语法错误（node --check）：${stderrExcerpt(parsed, 4)}`)
    }
  }
  const scan = (d, prefix) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true, encoding: 'utf8' })) {
      if (!e.isFile() || !e.name.endsWith('.mjs')) continue
      inspect(join(d, e.name), `${prefix}${e.name}`)
    }
  }
  scan(dir, 'scripts/')
  // `scripts/lib/` 是**随包分发的公共模块层**，包里每个脚本都 import 它——它必须和顶层脚本
  // 过同一套判据。漏掉这一层时，「零依赖」与「每个脚本能解析」两条对最大的那几份实现代码
  // 完全没有检查：`lib/` 里一个外部依赖加一处不闭合的括号，自检照样 0 失败。
  scan(join(dir, 'lib'), 'scripts/lib/')
  scan(join(dir, 'dev'), 'scripts/dev/')
  // `scripts/dev/lib/` 是自检的共享层（fixture 工厂、断言、计数器），同样是一层实现代码。
  // 漏掉它时同样的洞会在那里重开一次：往 `harness.mjs` 隔壁放一个引了外部模块、括号还不闭合
  // 的文件，全量自检 0 失败。**下面那张 `ALLOWED_SUBDIRS` 放行了哪个目录，这里就要扫哪个**——
  // 「放行」与「检查」分成两份清单，漏一处就是静默的。
  scan(join(dir, 'dev', 'lib'), 'scripts/dev/lib/')

  // 两个目录里都只允许 JavaScript。
  //
  // README 对外承诺「Python 完全不需要」，那条承诺必须由机制守住，否则某天有人为了
  // 图方便加一个 .py 辅助脚本，承诺就悄悄变成假话，而没有任何检查会提示。
  //
  // `lib/` 是随包分发的公共模块层：多个脚本共用同一份实现，按「放错位置」的判据它
  // 属于**用户包内**（包里的脚本要 import 它）。把它列在这里是让它成为结构的一部分，
  // 而不是每次新增模块都要改一遍白名单。
  // 允许存在的子目录，按**完整路径**列，不按名字列。
  //
  // 按名字列时，"lib" 在 scripts/ 放行、在 scripts/dev/ 也放行——两处语义不同却共用
  // 一条规则，等于没有规则。按路径列则每一条都说得出它为什么在那里。
  //
  // scripts/lib/      随包分发的公共模块，包里的脚本要 import 它，属于用户包内；
  // scripts/dev/      只服务本仓库的工具，整目录被 .gitattributes 排除在包外；
  // scripts/dev/lib/  自检的共享层（fixture 工厂、断言、计数器），同样只服务本仓库。
  const ALLOWED_SUBDIRS = new Set(['scripts/dev', 'scripts/lib', 'scripts/dev/lib'])
  const scanDir = (d, prefix) => {
    if (!existsSync(d)) return
    for (const entry of readdirSync(d, { withFileTypes: true, encoding: 'utf8' })) {
      if (entry.isDirectory()) {
        if (ALLOWED_SUBDIRS.has(`${prefix}${entry.name}`)) {
          // 允许的子目录本身也要过一遍：它里面的文件同样受「只能 .mjs」约束。
          scanDir(join(d, entry.name), `${prefix}${entry.name}/`)
          continue
        }
        fail(`${prefix} 下不应有子目录：${entry.name}。`)
        continue
      }
      if (!/\.mjs$/.test(entry.name)) {
        fail(`${prefix}${entry.name} 不是 .mjs —— 这个 skill 只允许 JavaScript 脚本`
          + '（README 承诺「Python 完全不需要」，别让那句变成假话）。')
      }
    }
  }
  scanDir(dir, 'scripts/')
  scanDir(join(dir, 'dev'), 'scripts/dev/')
  scanDir(join(dir, 'lib'), 'scripts/lib/')
}

// ── 脚本真的能跑起来 ────────────────────────────────────────────────

/**
 * 子进程失败时的诊断片段。
 *
 * 首行通常只是位置信息，真正的错误在更靠后的行——把整段 stderr 收进来，
 * 否则最需要的那句（SyntaxError、ReferenceError 之类）会被切掉。
 */
function stderrExcerpt(r, lines = 6) {
  return (r.stderr ?? '').trim().split('\n').filter((l) => l.trim() !== '')
    .slice(0, lines).join(' / ')
}

/**
 * 静态检查抓不到「import 写错、运行时抛错、参数解析有 bug」这类问题——少一个 import
 * 就能让脚本直接崩溃，而结构检查全绿。所以这里实际执行一遍。
 *
 * **退出码是硬证据，输出只是佐证**：`expect` 绝不参与判断非零退出是否可接受。
 * 倒过来的后果是：脚本先把报告打印完、收尾时再崩，stdout 里已有期望词，
 * 非零退出码就被读成通过——而那正是「跑过但没跑完」最容易藏身的形状。
 * `expect` 只回答另一个问题：退出码为 0 时，它到底干了活没有。
 *
 * 只跑只读或幂等的模式：--markdown 只读，--check/--status 不写文件。
 */
function checkScriptsRun() {
  const cases = [
    { file: 'survey.mjs', args: [SKILL_ROOT, '--markdown'], expect: /勘察结果/ },
    // compose-agents 的失败文案只写 stderr，所以这里只认它成功时 stdout 上的那行；
    // 失败由退出码判，不靠嗅探文案。
    { file: 'compose-agents.mjs', args: [SKILL_ROOT, '--check'], expect: /内核一致/ },
    { file: 'compose-agents.mjs', args: [SKILL_ROOT, '--status'], expect: /字节|手写/ },
  ]
  for (const { file, args, expect } of cases) {
    const p = join(SKILL_ROOT, 'scripts', file)
    // 脚本不存在就报缺，不能跳过：「没查」与「查过没问题」必须长得不一样。
    // 同一个文件里 checkBehavior 对缺 selftest.mjs 报的就是 fail——一处一种写法，
    // 迟早有一处把缺失读成通过。
    if (!existsSync(p)) { fail(`缺少 scripts/${file} —— 它登记在「用户包里」，缺了整个流程跑不起来。`); continue }
    const r = spawnSync(process.execPath, [p, ...args], { encoding: 'utf8', env: process.env })
    const label = `${file} ${args.slice(1).join(' ') || '(无参数)'}`
    if (r.error !== undefined) {
      fail(`scripts/${file} 无法执行：${r.error.message}`)
      continue
    }
    if (r.status !== 0) {
      fail(`scripts/${file} 以退出码 ${r.status} 结束（${label}）：${stderrExcerpt(r)}`)
      continue
    }
    if (!expect.test(r.stdout ?? '')) {
      fail(`scripts/${file} 退出码为 0，但没有输出预期内容（${label}）—— 可能被静默改坏。`)
    }
  }
}

/**
 * 跑行为自检。
 *
 * 静态检查抓不到「判定写错了」——survey 把 CMake 项目判成纯文档目录，引用与格式全都
 * 正常。而这类错误在这个 skill 上已经出现过三次（密钥门控失效、仓库边界误判、条件段落
 * 冻结），每次都是靠手工造 fixture 才发现的。所以把 fixture 固化成常驻检查：改动之后
 * 跑一遍，行为退化立刻可见。
 *
 * 「有没有跑到」是硬证据，「跑出来说什么」是佐证：摘要行取不到就是没跑到，
 * 哪怕退出码是 0——被换成空壳的自检正是这个形状，它一声不吭就把整套行为断言拿掉了。
 */
function checkBehavior({ skip = false, why = '' } = {}) {
  const p = join(SKILL_ROOT, 'scripts', 'dev', 'selftest.mjs')
  if (!existsSync(p)) { fail('缺少 scripts/dev/selftest.mjs（行为自检）。'); return }
  if (skip) {
    // 跳过是显式选择，要在报告里留下痕迹：**「没查」不能长得像「查过没有」**。
    const reason = why === '' ? '（调用方要求）' : `（${why}）`
    warn(`行为自检被跳过${reason}——这次只验了结构，行为判定没有被检查过。`)
    return
  }
  // 行为自检要造几百个 fixture 实跑，实测约一分钟（分片并行）。**先说要等多久**：终端上
  // 一个字，读的人会以为它卡死了（它没卡，只是这条命令本来就慢）。
  process.stdout.write('行为自检：正在造 fixture 实跑（分五片并行，约半分钟，中途没有输出）…\n')
  // **超时**：`spawnSync` 不给上限时，一个卡死的自检会把这整条门禁一起挂住——CI 上表现
  // 为「跑了四十分钟还在跑」，而它其实什么都没在测（某一处等 stdin、或某个子进程僵死）。
  // 有上限时它会变成一条明确的失败：说得清是超时，而不是让人对着一个不动的终端猜。
  //
  // 上限按实测留了很大余量：正常一趟 110–260 秒（并行分片，机器忙时更长），所以取十倍量级。
  const startedAt = Date.now()
  const TIMEOUT_MS = 30 * 60 * 1000
  const r = spawnSync(process.execPath, [p], {
    encoding: 'utf8', env: process.env, timeout: TIMEOUT_MS, killSignal: 'SIGKILL',
  })
  const elapsedMs = Date.now() - startedAt
  const out = r.stdout ?? ''
  if (r.error !== undefined) {
    const why = r.error.code === 'ETIMEDOUT'
      ? `行为自检超过 ${Math.round(TIMEOUT_MS / 60000)} 分钟没有结束，已终止`
      : `行为自检无法执行：${r.error.message}`
    fail(why)
    return
  }
  // 摘要是以「行为自检：」开头的那一行。不能用「最后一行」——环境不具备时后面还会跟
  // 一段「跳过」清单，取最后一行会取到清单里的最后一项。
  const line = out.split('\n').find((l) => l.startsWith('行为自检：'))
  if (line === undefined) {
    // 崩在中途（不是断言失败）时摘要与失败清单两处都取不到。只报「未通过」等于让人
    // 自己去猜，所以把子进程的 stderr 一并带出来。
    fail('行为自检没有输出摘要行——它可能崩在中途，或已不是本项目的自检'
      + `（退出码 ${r.status}）：${stderrExcerpt(r)}`)
    return
  }
  const summary = line.replace(/^行为自检：/, '')
  // **通过数也要看**：只看「有摘要行 + 退出码 0」时，一个打印「0 项通过，0 项失败」的空壳
  // 也算通过——断言从几百条掉到零，门禁绿着。判据要有下限，而这个下限必须是**量出来的**
  // 那个数：把已经通过的断言数写在这里当门槛，谁删掉一大片断言，谁就会被拦下。
  //
  // 取「当前通过数」作下限而不是随手写个整数：整数会随断言增加而过期，而过期的门槛只会
  // 让后来的人把它调低——那时它就不再拦任何东西了。
  const passedMatch = /(\d+)\s*项通过/.exec(summary)
  const passedCount = passedMatch === null ? undefined : Number(passedMatch[1])
  if (passedCount === undefined) {
    fail(`行为自检的摘要行读不出通过数（原文：${summary}）——摘要格式是本项目自检的契约，`
      + '读不出来就没法判断它到底跑了多少断言。')
    return
  }
  if (passedCount < BEHAVIOR_MIN_PASSED) {
    fail(`行为自检只跑了 ${passedCount} 项（下限 ${BEHAVIOR_MIN_PASSED}）——断言被删掉了一大片，`
      + '或者自检被换成了一个只会报「0 项通过」的空壳。少了多少条断言，就等于少了多少处判断。')
  }
  if (r.status !== 0) {
    const body = out.split('失败项：')[1] ?? ''
    const fails = body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
    const detail = fails.length > 0 ? `\n       ${fails.join('\n       ')}` : `\n       ${stderrExcerpt(r)}`
    fail(`行为自检未通过（${summary}）:${detail}`)
    return
  }
  process.stdout.write(`行为自检：${summary}\n`)
  // 耗时也报出来：**「变慢了」是唯一能在还绿着的时候就发现退化的信号**。这一条不判失败
  // （机器快慢不同、CI 与本地也不同），只让「这次比上次慢了一倍」这件事有一处落脚点。
  process.stdout.write(`行为自检耗时：${(elapsedMs / 1000).toFixed(1)} 秒\n`)
  // 有跳过时一并转述：跳过是环境不具备，不是缺陷，但它改变了这次检查的覆盖面，
  // 不说明就等于悄悄缩小了验证范围。
  const skipBlock = out.split('跳过（环境不具备，不是缺陷）：')[1]
  if (skipBlock !== undefined) {
    const items = skipBlock.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
    for (const s of items) process.stdout.write(`         ${s}\n`)
  }
}

// ── README 卡片里的数字断言必须两边同源、且与实现一致 ──────────────

/**
 * 卡片对外做出的断言，逐条列成表。**值与含义一起写在这里**，卡片里只留一个 key。
 *
 * 卡片是手写的 SVG，句子（说法、措辞）只能靠人跟着 README 走——那部分没有检查，也不该有：
 * 判断落在「这句话还准不准」上，字面特征抓不住。但**数字与硬断言**可以，而它们恰恰是
 * 最难靠眼睛发现的漂移：实现把 24 小时改成 6 小时，两份卡片和两份 README 会一起停在
 * 「24 小时」上，四份文件互相印证，谁也不出声——文档之间互相印证不构成证据。
 *
 * 所以每个值都配两样东西：中文与英文各要求的字面句，以及一条**从实现里量出来的**事实。
 * 哪一项自己核不了（例如实现改成别的量法），就把它删掉——留一个核不了的项，
 * 比没有这一项更坏：它会绿，而绿是会被相信的。
 */
const CARD_CLAIMS = {
  'update-interval': {
    meaning: '同一份副本重新换文件之间的最短间隔',
    zh: '24 小时',
    en: '24 hours',
    // 从实现里量：间隔常量换算成小时，应当与卡片上写的一样。
    fromCode: () => {
      const m = /const UPDATE_INTERVAL_MS\s*=\s*([^;\n]+)/.exec(readText(join(SKILL_ROOT, 'scripts', 'update.mjs')))
      const hours = m === null ? undefined : evalHours(m[1])
      return hours === undefined ? undefined : `${hours} 小时`
    },
  },
  'same-version-does-nothing': {
    meaning: '版本相同时不写任何文件',
    zh: '是同一版就结束',
    // 小写：这句话在英文文档里出现在句子中间，写死首字母大写会让「换了行、改了句首」
    // 变成假红——这一条要盯的是「还说不说这件事」，不是它在句子的哪个位置。
    en: 'same version',
  },
  'source-copy-readonly': {
    meaning: '有 .git 的副本（拿来改的那份）工具只读',
    zh: '工具对它只读',
    en: 'leaves it alone',
  },
}

/** 把 `24 * 60 * 60 * 1000` 这样的常量算式换算成小时。算不出来返回 undefined（不猜）。 */
function evalHours(expr) {
  const parts = String(expr).split('*').map((x) => x.trim())
  if (!parts.every((p) => /^\d+$/.test(p))) return undefined
  const product = parts.reduce((a, b) => a * Number(b), 1)
  return product % 3600000 === 0 ? product / 3600000 : undefined
}

/** 一份卡片里声明的断言（`pf:claims` 那一行里的 `key=value`）。 */
function cardClaims(text) {
  const m = /<!--\s*pf:claims\s+([^>]*?)-->/.exec(text)
  if (m === null) return undefined
  const out = {}
  for (const pair of m[1].trim().split(/\s+/)) {
    const [key, ...rest] = pair.split('=')
    out[key] = rest.join('=')
  }
  return out
}

/**
 * 一张 SVG 里**看得见的**文字：只取 `<text>` 元素里的内容。
 *
 * `<desc>` 与 `<title>` 是给读屏软件与搜索引擎看的，画面上并没有那行字——「写在文件里」
 * 不等于「印在卡上」。断言守的是「卡片上说了这句话」，判据就得落在画面上：整份文件全文
 * 匹配会让 `<desc>` 里的半句话把守卫哄绿，而读者在卡上永远看不到它。典型形态：英文卡片
 * 的断言只活在 `<desc>` 里，守卫是绿的，那句话在画面上不存在。
 */
function visibleSvgText(svgText) {
  const decode = (s) => s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
  const out = []
  for (const m of svgText.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)) {
    out.push(decode(m[1].replace(/<[^>]*>/g, '')))
  }
  return out.join(' ')
}

function checkCardClaims() {
  const dir = join(SKILL_ROOT, 'assets', 'readme')
  if (!existsSync(dir)) return
  const cards = readdirSync(dir).filter((f) => f.endsWith('.svg'))
  const readme = (lang) => {
    const p = join(SKILL_ROOT, lang === 'zh' ? 'README.md' : 'README.en.md')
    return existsSync(p) ? readText(p) : ''
  }
  const readmes = { zh: readme('zh'), en: readme('en') }
  let checked = 0

  for (const file of cards) {
    const claims = cardClaims(readText(join(dir, file)))
    if (claims === undefined) continue
    const lang = file.endsWith('.en.svg') ? 'en' : 'zh'
    if (lang === 'en') {
      fail(`assets/readme/${file} 声明了 pf:claims —— 断言只写中文版那一份（它是两份卡片的源头），`
        + '英文版跟着它走。两份都写等于两个源头，迟早对不上。')
      continue
    }
    const enFile = file.replace(/\.svg$/, '.en.svg')
    if (!existsSync(join(dir, enFile))) {
      fail(`assets/readme/${file} 有英文版吗：找不到 assets/readme/${enFile} —— 两份成对维护。`)
      continue
    }
    const enText = readText(join(dir, enFile))
    for (const [key, value] of Object.entries(claims)) {
      const spec = CARD_CLAIMS[key]
      if (spec === undefined) {
        fail(`assets/readme/${file} 的 pf:claims 里有不认得的断言「${key}」—— 文字说明不算断言。`
          + `认得的只有：${Object.keys(CARD_CLAIMS).join('、')}。要么用认得的那个，`
          + '要么在 preflight 的登记表里认领它并给出两语言的字面与核法。')
        continue
      }
      checked += 1
      const where = []
      // 用「压掉空白后包含」判，不要求逐字整句：卡片是排过版的，断行位置与 README 不同，
      // 要求整句相等会把「换了行」误报成「说法不一致」——那正是最容易让人开始怀疑一个
      // 其实正确的检查的方式。
      const has = (text, want) => text.replace(/\s+/g, '').toLowerCase().includes(want.replace(/\s+/g, '').toLowerCase())
      // **卡片只查看得见的文字**（`<text>` 元素里的内容）：`<desc>` 与 `<title>` 是给读屏
      // 软件看的，画面上并没有那行字。「写在文件里」不等于「印在卡上」——整份文件全文
      // 匹配会让 `<desc>` 里的半句话把守卫哄绿，而读者在卡上永远看不到它。
      if (!has(visibleSvgText(readText(join(dir, file))), spec.zh)) {
        where.push(`中文卡片的可见文字里没有出现「${spec.zh}」`)
      }
      if (!has(visibleSvgText(enText), spec.en)) {
        where.push(`英文卡片的可见文字里没有出现「${spec.en}」`)
      }
      if (!has(readmes.zh, spec.zh)) where.push(`README.md 里没有出现「${spec.zh}」`)
      if (!has(readmes.en, spec.en)) where.push(`README.en.md 里没有出现「${spec.en}」`)
      if (spec.fromCode !== undefined) {
        const want = spec.fromCode()
        if (want === undefined) {
          where.push(`核不了：实现里读不出「${spec.meaning}」这个量（核不了的项比没有更坏，要修 checkCardClaims）`)
        } else if (spec.zh !== want) {
          // 与**登记表里那条中文说法**比，而不是与卡片里那个 key 的取值比：取值是给日后
          // 想写别种写法的自己留的余地，而登记表里的中文才是「四份文件必须都说这句」。
          where.push(`实现里量出来是「${want}」，而登记表要求四份文件都写「${spec.zh}」`
            + `（卡片声明的是 ${key}=${value}）—— 两边说的不是同一件事`)
        }
      }
      if (where.length > 0) {
        fail(`断言「${spec.meaning}」对不上：${where.join('；')}。`
          + '改了实现或换了说法，就要把两份卡片与两份 README 一起改。')
      } else {
        process.stdout.write(`卡片断言：${key}（${spec.meaning}）四份文件说法一致\n`)
      }
    }
  }
  if (checked > 0 && failures.length === 0) {
    process.stdout.write(`卡片断言：${checked} 条，两边同源\n`)
  }
  // **一张卡片带断言，不等于别的卡片也该带**；但**一条都没有**要出声。
  //
  // 判据是「`pf:claims` 整行被删掉」这条路：删了之后 `claims === undefined` 一路 continue，
  // 末尾那句「N 条，两边同源」要 `checked > 0` 才打，于是三条断言可以整批静默消失——
  // 输出里一个字的差别都没有，门禁照样绿。这是「检查消失了却不报案」的典型形状。
  //
  // 阈值取 1 而不是「每张卡片都要有」：断言只能写在那几张真的做了硬承诺的卡片上，要求
  // 全员都写会把判据变成形式主义。但零条一定意味着有人把唯一那份删掉了。
  if (checked === 0) {
    fail('assets/readme/ 里一张卡片都没有 pf:claims 断言——卡片上的硬承诺（数字、'
      + '「什么都不做」这类）就没有任何检查盯着了。至少让做了硬承诺的那张卡片带上它，'
      + `格式见 CONTRIBUTING.md 的「README 卡片」一节；认得的键：${Object.keys(CARD_CLAIMS).join('、')}。`)
  }
}

// ── 文档里的「数量自称」必须与现实相符 ──────────────────────────────

/**
 * 中文数字 → 数值。
 *
 * 覆盖到九十九：`十三`、`二十`、`二十一` 都得算得出来。原先只列到 `十二`，超过的一律
 * 返回 undefined，而调用点是 `if (n === undefined) continue`——**静默跳过**。于是文档里
 * 写「十三个脚本」「二十个脚本」这种真错话，一个字的提示都不会有：判据在它最该出声的那
 * 一侧哑了。清单会随文件增加而变长，而数字上限写死在那一天，就是下一次漏报的日期。
 *
 * 认不出来时**报错，不跳过**：「这个数量我核对不了」本身就是需要作者看一眼的信息。
 */
function cnNumber(raw) {
  if (/^\d+$/.test(raw)) return Number(raw)
  const D = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
  if (raw === '十') return 10
  // 十几：`十三` = 13
  const teen = /^十([一二三四五六七八九])$/.exec(raw)
  if (teen !== null) return 10 + D[teen[1]]
  // 几十：`二十` = 20
  const tens = /^([二三四五六七八九])十$/.exec(raw)
  if (tens !== null) return D[tens[1]] * 10
  // 几十几：`二十一` = 21
  const both = /^([二三四五六七八九])十([一二三四五六七八九])$/.exec(raw)
  if (both !== null) return D[both[1]] * 10 + D[both[2]]
  // 个位
  if (raw.length === 1 && D[raw] !== undefined) return D[raw]
  return undefined
}

/**
 * 一个文件进不进用户包，**判据只有一条：它在不在包导出的结果里**。
 *
 * 这里用的是目录结构做**快速判据**（`scripts/dev/` 整目录被 `.gitattributes` 排除），
 * 只用来决定「该去查哪张表」；包的实际内容始终以 `git archive` 那次真导出为准，
 * `checkPackageBoundary` 与 `checkProducedPackage` 会双向核对。两处判的是同一件事，
 * 但一个给方向、一个给结论——方向错了，结论那一步会当场红。
 */


/**
 * 文档里自称的数量与磁盘对账。
 *
 * **只留两条真会被人数的**：硬不变量与硬门控。它们是这个项目特有的术语（「一条硬不变量」
 * 永远是数量断言，没有泛指的读法），而且这两个数直接决定读者会不会漏读一段。
 *
 * 脚本数量**不在这里数**：文件地图已改成「AI 会跑到的那几条」的示意块，不是逐文件清单，
 * 数它只会数出一个没有意义的数字。脚本有没有人跑，由下面那条**可达性判据**回答。
 */
function checkStatedCounts() {
  const actual = {
    硬不变量: countNumberedItems('SKILL.md', /^## 硬不变量/, /^\d+\.\s+\*\*/),
    硬门控: countMatches('SKILL.md', /^\|\s*G\d+\s*\|/gm),
  }

  // **脚本靠「被执行」而不是「被查找」到达**，所以这里的判据与 references 那条不同：
  // 一个脚本要么被文档提到（人可以照着敲），要么被另一个脚本引用（import 或子进程调用，
  // 机器会自己跑它）。两条都不占的那个脚本，才是真的没人指得到。
  //
  // 为什么不用「逐文件登记」：脚本是执行物，不是读物——读者不需要背下
  // `cases-3.mjs` 叫什么（它在 `selftest.mjs` 的分片表里，自动被调起）。
  // 真正的风险只有一个：**写完的脚本谁也不调用**，那它就是一坨没人跑的代码。
  //
  // `scripts/lib/` 不在这条里：它是被 import 的实现层，由 import 链自然证明；
  // 包自洽性判据会把「import 了却不在包里」当场抓出来。
  const scriptsDir = join(SKILL_ROOT, 'scripts')
  if (existsSync(scriptsDir)) {
    const onDisk = []
    const collect = (d, prefix) => {
      if (!existsSync(d)) return
      for (const e of readdirSync(d, { withFileTypes: true, encoding: 'utf8' })) {
        if (e.isDirectory()) { collect(join(d, e.name), `${prefix}${e.name}/`); continue }
        if (e.name.endsWith('.mjs')) onDisk.push(`${prefix}${e.name}`)
      }
    }
    collect(scriptsDir, 'scripts/')
    const docs = ['SKILL.md', 'README.md', 'README.en.md', 'AGENTS.md', 'CONTRIBUTING.md']
      .map((f) => {
        const p = join(SKILL_ROOT, f)
        return existsSync(p) ? readText(p) : ''
      })
    for (const sub of ['references', 'templates']) {
      const d0 = join(SKILL_ROOT, sub)
      if (!existsSync(d0)) continue
      const walk = (d) => {
        for (const e of readdirSync(d, { withFileTypes: true, encoding: 'utf8' })) {
          if (e.isDirectory()) { walk(join(d, e.name)); continue }
          if (e.name.endsWith('.md')) docs.push(readText(join(d, e.name)))
        }
      }
      walk(d0)
    }
    // 脚本之间的调用关系：把所有脚本正文拼起来，谁被别的脚本提到过就算被调用。
    const sources = new Map(onDisk.map((rel) => [rel, readText(join(SKILL_ROOT, rel))]))
    const referencedByCode = (rel) => {
      const base = rel.slice(rel.lastIndexOf('/') + 1)
      for (const [other, src] of sources) {
        if (other === rel) continue
        if (src.includes(base)) return true
      }
      return false
    }
    for (const rel of onDisk) {
      // **自检分片整片豁免，别的自用脚本照查。**
      //
      // 分片（`scripts/dev/cases-N.mjs`）由 `selftest.mjs` 的 `SHARDS` 表按名字调起，
      // 而在**副本**里 `selftest.mjs` 被换成只打摘要行的替身（否则 preflight 与 selftest
      // 会互相调用）——那时代码里找不到对它们的引用，是**结构的正常状态**，不是「没人用」。
      // 所以这里按名字认它们。
      //
      // 其余自用脚本一律参与：`scripts/dev/` 曾经整片跳过，后果是「写一个没人用的工具
      // 永远不会被发现」——而这正是这条判据存在的理由。
      if (isSelftestCase(rel)) continue
      const base = rel.slice(rel.lastIndexOf('/') + 1)
      const inDoc = docs.some((t) => t.includes(rel) || t.includes(base))
      if (!inDoc && !referencedByCode(rel)) {
        fail(`${rel} 既没有被任何文档提到，也没有被任何脚本调用 —— 写了却没人指得到，`
          + '等于没写。要么有人跑它，要么它不该存在。')
      }
    }
    for (const rel of ['scripts/survey.mjs', 'scripts/compose-agents.mjs',
      'scripts/dev/preflight.mjs', 'scripts/dev/selftest.mjs']) {
      if (!onDisk.includes(rel)) fail(`磁盘上缺少 ${rel}。`)
    }
  }
  // **可达性判据**：每一个 `references/` 与 `templates/` 下的文件，都必须被别的文档
  // 按名字提到过至少一次。
  //
  // 这比「有一张逐文件登记表」更强，也更省：登记表是**第二份真相**，它自己能漏；
  // 而「有没有人指向它」是文件之间的关系，改文件名、搬目录、删章节时都会当场暴露。
  // 判据落在一句话上——**写了却没人指得到，等于没写**。
  //
  // 候选文档取「会被读到的那几份」：入口、两份 README、本仓库契约，以及 references 与
  // templates 的全部内容（专章之间互相指是常态，也必须算数）。不取 `docs/`：
  // 那是历史与工作记录，不是读者查找文件的入口。
  {
    // `docs` 收的是「读者会去查找文件的那几份」：入口、两份 README、本仓库契约，
    // 外加 references 与 templates 的全部正文（专章之间互相指是常态，也必须算数）。
    // 每份带**自己的相对路径**，这样自指可以被排掉——见 `mentions`。
    const docs = ['SKILL.md', 'README.md', 'README.en.md', 'AGENTS.md']
      .map((f) => ({ at: f, text: readText(join(SKILL_ROOT, f)) }))
    for (const sub of ['references', 'templates']) {
      const dir = join(SKILL_ROOT, sub)
      if (!existsSync(dir)) continue
      const walk = (d, prefix) => {
        for (const e of readdirSync(d, { withFileTypes: true, encoding: 'utf8' })) {
          if (e.isDirectory()) { walk(join(d, e.name), `${prefix}${e.name}/`); continue }
          if (e.name.endsWith('.md')) {
            docs.push({ at: `${sub}/${prefix}${e.name}`, text: readText(join(d, e.name)) })
          }
        }
      }
      walk(dir, '')
    }
    const mentions = (rel) => {
      const base = rel.slice(rel.lastIndexOf('/') + 1)
      // 两种写法都算提到：完整相对路径（`references/x.md`）与裸文件名（`x.md`）。
      // 后一种是有意的：专章之间常常只写文件名，因为读者已经在那个目录的语境里。
      //
      // **但不算它自己那一份**：每个文件几乎都会在标题或正文里写一遍自己的名字，
      // 把自己算进去，这条判据就退化成「文件存在吗」——实测新建一个只写着
      // `# probe.md` 的模板，它照样放行，而「写了却没人指得到」正是要拦的那件事。
      return docs.some((d) => d.at !== rel && (d.text.includes(rel) || d.text.includes(base)))
    }
    for (const sub of ['references', 'templates']) {
      const dir = join(SKILL_ROOT, sub)
      if (!existsSync(dir)) continue
      const walk = (d, prefix) => {
        for (const e of readdirSync(d, { withFileTypes: true, encoding: 'utf8' })) {
          if (e.isDirectory()) { walk(join(d, e.name), `${prefix}${e.name}/`); continue }
          if (prefix === '' && sub === 'references' && !e.name.endsWith('.md')) continue
          const rel = `${sub}/${prefix}${e.name}`
          if (!mentions(rel)) {
            fail(`${rel} 没有任何文档提到它 —— 写了却没人指得到，等于没写。`
              + '要么有人在 SKILL.md / references / README 里指向它，要么它不该存在。')
          }
        }
      }
      walk(dir, '')
    }
  }
  // README 的「包里有什么」核**四类东西都在**，不核逐文件清单。
  //
  // 为什么不逐文件对账：那等于要求 README 维护一份要人记得改的清单，而它的读者是
  // 「刚拿到这个 skill 的人」——他要判断的是「包里大概有什么」，不是查某一个脚本在不在
  // （那件事他直接看目录更快）。逐文件清单漏一行的症状是「读者照着找，找不到」，但同一份
  // 清单**每加一个文件就要改一次**，成本永久高于收益。
  //
  // 判据落在那四类上：入口、判据、骨架、工具。任一类从 README 里消失，读者就再也
  // 不知道那个目录存在——那才是这条检查真正要防的事。
  //
  // **但「新文件可以永远不列」也是个洞**：README 说的「包里有什么」是读者对包的全部
  // 预期，而每加一个顶层文件它就可能少说一样（举例：根上多一份 `RELEASING.md` 那样的
  // 说明文件）。所以四类之外再补一条：**根目录下受版本控制的普通文件**，README 里得
  // 提到它的名字。判据只覆盖根目录——子目录里的文件由上面那四类代表，逐个数它们
  // 又会退回成逐文件清单。
  const rootFiles = (() => {
    const tracked = trackedFiles()
    if (tracked === undefined) return undefined
    return tracked.filter((f) => !f.includes('/'))
      .filter((f) => !isRepoOnlyPath(f))
      .filter((f) => !/^(LICENSE|\.gitignore|\.gitattributes)$/.test(f))
  })()
  for (const readme of ['README.md', 'README.en.md']) {
    const p = join(SKILL_ROOT, readme)
    if (!existsSync(p)) continue
    const text = readText(p)
    for (const re of [/`SKILL\.md`/, /references\//, /templates\//, /scripts\//]) {
      if (!re.test(text)) {
        fail(`${readme} 里找不到 ${re} —— 「包里有什么」那一段必须让人看得到这一类东西，`
          + '否则读者根本不知道那个目录存在。')
      }
    }
    if (rootFiles === undefined) {
      warn(`${readme} 的根目录文件未逐一核对（git 不可用）—— 报「未核对」，不放行。`)
      continue
    }
    const unnamed = rootFiles.filter((f) => f !== 'README.md' && f !== 'README.en.md'
      && !text.includes(f))
    for (const f of unnamed) {
      fail(`${readme} 没有提到根目录的 ${f} —— 它随包发出去，而读者从 README 里看不到。`
        + '要么在「包里有什么」那一段补一句，要么它不该在根上（挪进已有的目录）。')
    }
  }
  // 门禁命令表在 AGENTS.md 与 CONTRIBUTING 各写了一份，**两处必须说同一件事**：
  // 贡献者按 CONTRIBUTING 自查、CI 与维护者按 AGENTS.md 自查，少一个参数就是
  // 「照做的人拿到的命令不是真命令」（实测 sync-toc 漏了 README.en.md 那次）。
  {
    const commands = (file, headingRe, headingName) => {
      const p = join(SKILL_ROOT, file)
      // 文件不存在可以合法跳过；**标题找不到不行**：这份文件的开关就是一个标题字符串，
      // 把它改个名就能让整块检查静默消失（而命令表一个字没动），那正是它要防的漂移。
      if (!existsSync(p)) return { state: 'absent' }
      const text = readText(p).replace(/^\uFEFF/, '')
      // 围栏状态**只从权威实现取**（survey.mjs 的 scanLines）。
      //
      // 围栏判定手写一份就必然与别处不同：只认三个反引号、不认波浪线、不管闭合行长度。
      // 三处判的都是「门禁命令表里写了什么」，判错的后果是命令表对不上却报绿——只取那一份。
      const scanned = scanLines(text)
      const at = scanned.findIndex((l) => headingRe.test(l.line))
      if (at < 0) return { state: 'heading-missing', heading: headingName }
      // 只看标题之后的**第一个围栏代码块**：那一节里可能还有别的命令示例（例如
      // 「改了内核后要重新注入」那一小段），把它们算进「门禁命令表」是读错了范围。
      const out = new Set()
      let seenFence = false
      for (let i = at + 1; i < scanned.length; i += 1) {
        const info = scanned[i]
        if (!info.inFence && info.heading !== null && info.heading.level <= 2) break
        if (info.fenceEvent === 'open') {
          if (seenFence) break
          seenFence = true
          continue
        }
        if (!info.inFence) continue
        const line = info.line.trim()
        if (!line.startsWith('node ')) continue
        out.add(line.split(/\s+#/)[0].replace(/\s+/g, ' ').trim())
      }
      return { state: 'ok', commands: out }
    }
    const a = commands('AGENTS.md', /^## 构建与验证/, '## 构建与验证')
    const c = commands('CONTRIBUTING.md', /^## 提交前门禁/, '## 提交前门禁')
    for (const [file, r] of [['AGENTS.md', a], ['CONTRIBUTING.md', c]]) {
      if (r.state === 'heading-missing') {
        fail(`${file} 里没有「${r.heading}」这一节 —— 提交前门禁的命令表因此无从比对，`
          + '两处是否一致已无从判断。把该节标题改回来。')
      }
    }
    if (a.state === 'ok' && c.state === 'ok') {
      const onlyA = [...a.commands].filter((x) => !c.commands.has(x))
      const onlyC = [...c.commands].filter((x) => !a.commands.has(x))
      if (onlyA.length > 0 || onlyC.length > 0) {
        fail('提交前门禁的命令表在两处不一致：'
          + `${onlyA.length > 0 ? `只有 AGENTS.md 有 ${onlyA.join(' / ')}；` : ''}`
          + `${onlyC.length > 0 ? `只有 CONTRIBUTING.md 有 ${onlyC.join(' / ')}；` : ''}`
          + '两处必须是同一批命令（含参数）。')
      }
    }
  }
  // 常量一致性：约定名 RELEASE_TOKEN 必须在模板与文档同拼写。
  // 改一处忘另一处是本类最常见的 drift，注释写“同步”不如机器断言。
  //
  // 字节预算**不在这里比对**：它只有一处定义（`survey.mjs` 的导出），compose 与
  // preflight 都引用同一个值，所以「两处文本互比」这件事本身没有对象了。
  {
    // 约定名拼写：**扫定义域内全部文本文件**，只对出现过它的那些文件判一致性。
    // 维护文件白名单是这条检查最脆的地方：真正消费这个密钥的工作流漏在名单外时，
    // 把它改成另一种拼法自检一声不吭。判据落在「全仓拼写是否统一」上，
    // 新增文件不必记得登记。
    const spellings = releaseTokenSpellings(repoTextFiles().map((f) => {
      try { return readText(f) } catch { return '' }
    }))
    if (spellings.size > 1) {
      fail(`约定名拼写不一致：${[...spellings].join('、')} —— 必须统一为 RELEASE_TOKEN。`)
    }
  }
  const readmeText = existsSync(join(SKILL_ROOT, 'README.md'))
    ? readText(join(SKILL_ROOT, 'README.md')).replace(/^\uFEFF/, '') : ''
  for (const m of readmeText.matchAll(/`scripts\/((?:dev\/)?[a-z-]+\.mjs)`/g)) {
    if (!existsSync(join(SKILL_ROOT, 'scripts', m[1]))) {
      fail(`README.md 提到了不存在的脚本 scripts/${m[1]}。`)
    }
  }

  // 文档里出现的「<中文数字><量词>」与「<阿拉伯数字> 个<量词>」
  const WATCHED = [
    { word: '硬不变量', key: '硬不变量' },
    { word: '硬门控', key: '硬门控' },
  ]
  // 卡片也要核：卡片是 README 的摘要，它上面写的数量同样会变成没人知道的一句假话。
  // 卡片不是 Markdown，但判据（「文档里写着 N 条」）与文档是同一件事，所以走同一张表、
  // 同一个 actual——两处各写一份核对，迟早给出两种答案。
  const sources = [
    ...['SKILL.md', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md'].map((f) => ({ label: f, file: f })),
    ...(existsSync(join(SKILL_ROOT, 'assets', 'readme'))
      ? readdirSync(join(SKILL_ROOT, 'assets', 'readme'))
        .filter((f) => f.endsWith('.svg'))
        .sort()
        .map((f) => ({
          label: `assets/readme/${f}`,
          file: join('assets', 'readme', f),
          // 只查看得见的文字：`<desc>` 里写「九道门」不算卡片说了这句话。
          text: visibleSvgText(readText(join(SKILL_ROOT, 'assets', 'readme', f))),
        }))
      : []),
  ]
  for (const { label: doc, file, text: preset } of sources) {
    const p = join(SKILL_ROOT, file)
    if (!existsSync(p)) continue
    const text = preset ?? readText(p).replace(/^\uFEFF/, '')
    for (const { word, key } of WATCHED) {
      // 要求数字前不是「第」——「第一硬不变量」是序数（「第一个」），不是数量断言，
      // 误报它只会让人去改一句其实正确的话。
      const re = new RegExp(`(?<!第)([一二三四五六七八九十]+|\\d+)\\s*(?:道|条|个)?${word}`, 'g')
      for (const m of text.matchAll(re)) {
        const raw = m[1]
        const n = cnNumber(raw)
        if (n === undefined) {
          // 认不出来就**说一声**，不静默跳过：跳过等于「这条数量我核不了」被读成「核过了没问题」。
          fail(`${doc} 写着「${raw}${word}」，这个数字我核对不了 —— 换成阿拉伯数字，或去掉数量。`)
          continue
        }
        if (n !== actual[key]) {
          fail(`${doc} 写着「${raw}${word}」，实际是 ${actual[key]} —— 数量自称与代码不符。`
            + '要么改数字，要么去掉数字（数量是快照，会过期）。')
        }
      }
    }
  }
}

/** 数某个文件里匹配到的个数。 */
function countMatches(file, re) {
  const p = join(SKILL_ROOT, file)
  if (!existsSync(p)) return -1
  return (readText(p).replace(/^\uFEFF/, '').match(re) ?? []).length
}

/** 数「某个二级标题之下、某个模式的编号项」有几条。 */
function countNumberedItems(file, headingRe, itemRe) {
  const p = join(SKILL_ROOT, file)
  if (!existsSync(p)) return -1
  const lines = readText(p).replace(/^\uFEFF/, '').split('\n')
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start < 0) return -1
  let count = 0
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    if (itemRe.test(lines[i])) count += 1
  }
  return count
}

/**
 * 约定名的各种拼写（去重）。
 *
 * 判据是「全仓出现过的拼写是否只有一种」。扫全部文本文件而不是维护文件白名单：
 * 白名单最脆的地方就是**漏掉真正消费它的那个文件**，而新增文件不该要求人记得登记。
 *
 * **大小写敏感**：约定名是环境变量形状的全大写标识符，破坏它的方式是分隔符写错
 * （把下划线换成连字符或点）或干脆连写，不是首字母小写。不敏感地扫会把
 * `usesReleaseToken` 这类普通标识符算成一种拼写——那正是字面启发式自己制造的假阳性。
 * 注意这条检查扫的是**全文**（含文档正文），所以写文档时别把错误拼法照抄进来举例——
 * 那正是它要报的东西。纯函数，selftest 直接喂数据证伪。
 */
export function releaseTokenSpellings(texts) {
  const out = new Set()
  for (const text of texts ?? []) {
    for (const m of String(text ?? '').matchAll(/RELEASE[._-]?TOKEN/g)) out.add(m[0])
  }
  return out
}

// ── 插件专章必须都登记在索引里 ──────────────────────────────────────


/**
 * `references/plugins/` 下的每个专章，都必须出现在**某一张**索引表里。
 *
 * 这个结构有个隐蔽的失效方式：**专章写了，但没人知道它存在**——通用文件是入口
 * （G6 只强制读它），索引表是唯一的路标。漏登记的专章等于没写，而文件确实在那儿、
 * 检查也全绿。
 *
 * 索引不止一张：宿主既可能加载你的代码（插件），也可能加载你的指令（能力目录），
 * 同一套形态两边的入口文件不同，判据也不同，所以各有各的入口文件与索引。
 * 判据因此是「**至少登记在一张**」，不是「必须登记在某一张」——一个生态完全可以
 * 两边都出现（它既发布插件、又是能力目录宿主）。
 *
 * 反向也查：索引里列了、文件却不在（引用断链）。
 */
function checkPluginChapters() {
  const dir = join(SKILL_ROOT, 'references', 'plugins')
  const indexes = [
    { rel: 'references/plugin-project.md', required: true, label: '插件类' },
    { rel: 'references/skill-project.md', required: false, label: '能力目录' },
  ]
    .map((x) => ({ ...x, abs: join(SKILL_ROOT, ...x.rel.split('/')) }))
    .filter((x) => existsSync(x.abs))
    .map((x) => ({ ...x, text: readText(x.abs).replace(/^\uFEFF/, '') }))
  const present = indexes.find((x) => x.required)
  if (!existsSync(dir)) {
    if (present !== undefined) fail('references/plugin-project.md 存在，但没有 references/plugins/ 目录。')
    return
  }
  if (present === undefined) {
    fail('缺少 references/plugin-project.md —— 插件类项目的入口文件，专章靠它索引。')
    return
  }

  const files = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)

  for (const f of files) {
    const rel = `references/plugins/${f}`
    if (!indexes.some((x) => x.text.includes(rel))) {
      fail(`${rel} 没有登记在任何一张专章索引里（${indexes.map((x) => x.rel).join('、')}）——`
        + '专章写了却没人知道它存在，等于没写。')
    }
  }
  // 索引里指向不存在文件的引用，由 checkReferencesResolve 统一查；这里只补一条：
  // 索引表里出现的 plugins 路径必须真有对应文件
  for (const x of indexes) {
    for (const m of x.text.matchAll(/`(references\/plugins\/[a-z0-9-]+\.md)`/g)) {
      if (!existsSync(join(SKILL_ROOT, m[1]))) {
        fail(`${x.rel} 的索引引用了不存在的专章：${m[1]}。`)
      }
    }
  }
  if (files.length === 0) warn('references/plugins/ 下还没有任何专章。')
  // 「事实来源」节与核对标记的校验已收敛到 checkFreshness统一处理，
  // 这里不再另起一套——两处各判一遍，迟早漏一边。
}

// ── 外部事实保鲜（统一核对标记） ──────────────────────────────────

/**
 * 根因：外部事实（字段名、数量上限、UI 路径、版本下限）会过期，而文档把它当永久
 * 知识存，过期后没有任何声音。所以每份“带外部易变事实”的章节文件，都在
 * 「事实来源」节末尾带一个机器可读的核对标记；本检查校验它。
 *
 * 标记形状（向后兼容：现存标记本来就长这样，这里只是第一次把它写下来）：
 *   <!-- <scope>-verified: date=YYYY-MM-DD [key=value ...] -->
 * scope 必须与文件名对应，date 必须是真实日历日期；key=value 允许扩展
 * （如 dsh 的 host=，compose 靠它判断滞后），本检查只认 date。
 *
 * 分工（判据见 AGENTS.md「外部事实保鲜」节，此处只实现，不复述）：
 *   - 章节家族（references/plugins/*.md 与 references/publish-*.md）：
 *     节与标记双向缺一不可——缺节说明来源没交代，缺标记说明核对没落到纸面。
 *   - 其他 references 文件（机制稳定的，如 publish.md、survey.md）：
 *     不强制要求；但一旦带了标记，就按同一套规则校验（不能悬空、不能错位）。
 *   - 超期只警告不失败；格式/归属/位置错才失败。
 */

/** 按文件名推导标记作用域：dsh.md→dsh，publish-npm.md→npm。 */
function expectedFreshnessScope(rel) {
  const base = rel.split('/').pop().replace(/\.md$/, '')
  return base.replace(/^publish-/, '')
}

/**
 * 「事实来源」节的标题形状。
 *
 * 判的是**这一节在不在**，不是「标题这一串字长得对不对」。专章模板的骨架写成
 * `## 八、事实来源（必填）`——编号让它在文件里定位得到，括注提醒写的人这一节必填；
 * 若按字面匹配，照着模板新建的专章会被判成「没有来源节」，于是模板与检查器互相打架。
 * 所以容忍两类**装饰**：编号前缀（`八、`、`3.`）与尾部括注（`（必填）`）。
 *
 * 不容忍的是**改名**：`## 事实来源与更新` 之类不算这一节——那已经不是同一节了，
 * 而放行它等于让「有没有交代来源」这个问题失去判据。要放宽这条，先想清楚新的
 * 失效模式是什么，别为了少报一次失败把判据调成永真。
 */
const FRESHNESS_SECTION_RE =
  /^##[ \t]*(?:[0-9一二三四五六七八九十百]+[、.．)）][ \t]*)?事实来源(?:[ \t]*[（(][^）)\n]*[）)])?[ \t]*$/m

/**
 * 纯函数：判定一份文档里的保鲜标记。只管格式，不管“该不该有”
 * （“该不该有”由 checkFreshness 按文件家族定——混在一起，单测就写不清了）。
 *
 * 返回 { hasSection, count, scope, date, ageDays, errors[], warnings[] }。
 * 无标记时 errors/warnings 为空，调用方按家族规则决定要不要 fail。
 */
export function evalFreshnessMarker(rel, text, todayStr, tomorrowStr) {
  const result = {
    hasSection: false, count: 0,
    scope: undefined, date: undefined, ageDays: undefined,
    keys: {},
    errors: [], warnings: [],
  }
  const clean = text.replace(/^\uFEFF/, '')
  const sectionAt = clean.search(FRESHNESS_SECTION_RE)
  result.hasSection = sectionAt >= 0
  const found = [...clean.matchAll(/<!--\s*([A-Za-z0-9-]+)-verified:\s*([^>]*?)\s*-->/g)]
  result.count = found.length
  if (found.length === 0) return result
  if (found.length > 1) {
    result.errors.push(`有 ${found.length} 个核对标记，只能恰好一个 —— 删掉重复的，留日期最新的那一个。`)
    return result
  }
  const marker = found[0]
  if (!result.hasSection) {
    result.errors.push('核对标记没有对应的「事实来源」节 —— 标记必须住在该节末尾，不能悬空。')
    return result
  }
  if (marker.index < sectionAt) {
    result.errors.push('核对标记在「事实来源」节之前 —— 把它移到该节末尾（见兄弟文件的同名节）。')
    return result
  }
  const scope = marker[1]
  result.scope = scope
  const expected = expectedFreshnessScope(rel)
  if (scope !== expected) {
    result.errors.push(`核对标记的作用域是「${scope}」，按文件名应为「${expected}」—— 从别的文件复制时忘了改吧？`)
  }
  const dateMatch = /(?:^|\s)date=([0-9-]+)(?:\s|$)/.exec(` ${marker[2].trim()} `)
  if (dateMatch === null) {
    result.errors.push('核对标记里没有 date=YYYY-MM-DD —— 格式见 AGENTS.md「外部事实保鲜」节。')
    return result
  }
  const dateStr = dateMatch[1]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    || Number.isNaN(Date.parse(dateStr))
    || new Date(`${dateStr}T00:00:00Z`).toISOString().slice(0, 10) !== dateStr) {
    result.errors.push(`核对标记的日期「${dateStr}」不是真实日历日期 —— 按 YYYY-MM-DD 写真实日期。`)
    return result
  }
  result.date = dateStr
  if (dateStr > tomorrowStr) {
    // 允许一天宽限：写标记的人与跑检查的机器可能有时区差；超过一天就是笔误。
    result.errors.push(`核对标记的日期「${dateStr}」在未来 —— 把 date 改成重核的当天日期。`)
    return result
  }
  const ageDays = Math.floor(
    (Date.parse(`${todayStr}T00:00:00Z`) - Date.parse(`${dateStr}T00:00:00Z`)) / 86400000,
  )
  result.ageDays = ageDays
  if (ageDays > FRESHNESS_STALE_DAYS) {
    result.warnings.push(`上次核对是 ${dateStr}（${ageDays} 天前），超期了 —— 按「事实来源」节写明的范围重核官方文档，确认无误后把 date 改成当天。`)
  }
  // 其余键的形状校验：**机器无关的那一半进失败区**（零成本纯收益）；
  // 没认领的键只提示「未核对」，不失败——扩展键是允许的，但它的含义得有人认领。
  const parsed = parseMarkerKeys(marker[2])
  result.keys = parsed.keys
  for (const e of parsed.errors) result.errors.push(e)
  for (const note of parsed.notes) result.warnings.push(note)
  return result
}

/**
 * 取「事实来源」节的**正文**：标题行之后，到下一个同级或更高级标题（或文件尾）为止。
 *
 * 不能用 `text.slice(text.search(RE))`——那从标题本身切起，而标题里就含「来源」二字，
 * 判据于是恒真。按 markdown 语义取正文，判据才可能真的失败。
 */
export function freshnessSectionBody(text) {
  const lines = String(text).split('\n')
  const at = lines.findIndex((l) => FRESHNESS_SECTION_RE.test(l))
  if (at < 0) return ''
  const level = (/^#+/.exec(lines[at].trim())?.[0].length) ?? 2
  const body = []
  for (let i = at + 1; i < lines.length; i += 1) {
    const h = /^(#+)\s+/.exec(lines[i])
    if (h !== null && h[1].length <= level) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/**
 * 这一节的来源说明能不能照着做：读者得能拿着它**直接去查**。
 *
 * 判据是「有没有可定位物」，不是「有没有出现过相关词」。按词判会被中文里绕过去：
 * 「本节的内容以前是核过的，读者可以自行查阅相关文档的对应章节确认」既没有链接也没有
 * 具体对象，却同时含「文档」与「章节」——而那正是一句套话，不是查法。词频高到这个
 * 程度的词不能当判据，能当判据的是**对象**：地址、文件名、章节号、字段名。
 *
 * 至少命中一类即通过：措辞差异不该被当成缺陷，所以判据一律按「有」写。
 */
export function hasActionableSources(body) {
  const text = String(body ?? '').trim()
  if (text === '') return false
  // 可定位物之一：地址。
  const hasUrl = /https?:\/\/\S+/.test(text)
  // 之二：被行内代码或书名号/直角引号包住的具体对象（文件路径、文档名、字段名、标识符）。
  const hasNamed = /`[^`\n]{2,}`/.test(text) || /《[^》\n]{2,}》/.test(text) || /「[^」\n]{2,}」/.test(text)
  // 之三：查法句式——动作词后面紧跟一个可数的定位对象（「按第 N 节」「去 X 的 Y 一节」）。
  // 动词与对象必须在同一句内相邻出现，所以「按常规流程重核一次」这种不带对象的说法不算。
  const hasProcedure = /(?:去|按|照|见|依|据)[^。\n；;]{0,24}?(?:第[0-9一二三四五六七八九十]+[节章页]|的[^。\n；;]{0,12}?[一节章节页])/
    .test(text)
  return hasUrl || hasNamed || hasProcedure
}

/**
 * 标记里的 host= 与本机宿主的三态比对。**纯函数**（来源由调用方给），fixture 才喂得进
 * 数据。三态各有确定文本，于是断言可以只锁确定的那部分、不锁「本机装了什么」。
 *
 * sources: [{ source, value, reason }]，value 为 undefined 表示这条来源取不到。
 */
export function compareHostMarker(markerHost, sources) {
  const usable = (sources ?? []).filter((s) => typeof s?.value === 'string' && s.value.trim() !== '')
  if (usable.length === 0) {
    const why = (sources ?? []).map((s) => `${s.source}${s.reason ? `（${s.reason}）` : ''}`).join('；')
    return { state: 'undetermined', reason: `本机取不到宿主版本（未装、查询失败或没有可用的取值途径）${why ? `：${why}` : ''}`, values: [] }
  }
  const values = usable.map((s) => ({ source: s.source, value: normVersion(s.value) }))
  const distinct = [...new Set(values.map((v) => v.value))]
  if (distinct.length > 1) {
    return {
      state: 'undetermined',
      reason: `本机两条来源互相矛盾（无法确定本机跑的是哪一版）：${values.map((v) => `${v.source} ⇒ ${v.value}`).join('；')}`,
      values,
    }
  }
  const mine = distinct[0]
  const theirs = normVersion(markerHost)
  if (mine === theirs) return { state: 'match', reason: '', values }
  return { state: 'mismatch', reason: `标记里是 ${markerHost}，本机实际是 ${usable[0].value}`, values }
}

/** 探针超时：宿主 CLI 启动可能慢，但一次卡住不能挂住整次自检。超时 = 未核对。 */
const HOST_PROBE_TIMEOUT_MS = 20000

/**
 * 按 scope 登记的取值途径。**只有登记过的宿主参与比对**；没登记就是「未核对」。
 *
 * 通用代码里不出现任何宿主的名字、命令或路径——名字与参数都在这张表里；每条登记项
 * 给两个**独立来源**：宿主自己的版本查询入口 + 它自己的安装元数据。
 */
const HOST_PROBES = {
  dsh: {
    cli: { command: 'dsh', args: ['--version'] },
    metadata: { manager: 'npm', package: '@deepseek-ai/dsh' },
  },
}

/** 跑登记表里的命令。失败返回 undefined（不抛错，调用方按「取不到」处理）。 */
function runRegisteredCommand(command, args) {
  const first = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: HOST_PROBE_TIMEOUT_MS })
  if (first.error === undefined && first.status === 0) return first.stdout ?? ''
  if (process.platform !== 'win32') return undefined
  // Windows 上的两级退让：Node 不套 PATHEXT（裸名 ENOENT），也拒绝直接 spawn
  // `.cmd`/`.bat`（EINVAL，CVE-2024-27980 起的加固）。于是走 `cmd.exe /d /s /c`——
  // 命令行与参数**全部来自上面的登记表字面量**，不插入任何项目派生内容或用户输入。
  // `cmd.exe` 是平台胶水，对所有登记项一视同仁，所以它不进登记表。
  // 不用 `shell: true`：它在 Node 里已废弃（DEP0190，且参数只拼接不转义）——
  // 把弃用路径写进常驻检查，将来红的会是我们的自检，而不是使用者的代码。
  const line = [command, ...args].join(' ')
  const viaCmd = spawnSync('cmd.exe', ['/d', '/s', '/c', line], { encoding: 'utf8', windowsHide: true, timeout: HOST_PROBE_TIMEOUT_MS })
  if (viaCmd.error === undefined && viaCmd.status === 0) return viaCmd.stdout ?? ''
  return undefined
}

/** 从命令输出里取版本：只认**唯一**的版本形状 token，出现两个不同值就视为取不到。 */
function versionFromOutput(out) {
  const tokens = String(out ?? '').match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?/g) ?? []
  const distinct = [...new Set(tokens)]
  return distinct.length === 1 ? distinct[0] : undefined
}

/** 安装元数据来源：分发根**运行时查**，路径由「分发根 + 登记项里的包名」拼出，不写死。 */
function hostMetadataValue(entry) {
  const meta = entry?.metadata
  if (meta === undefined) return undefined
  const rootOut = runRegisteredCommand(meta.manager, ['root', '-g'])
  const root = String(rootOut ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean)[0]
  if (root === undefined || root === '') return undefined
  try {
    const pkg = JSON.parse(readFileSync(join(root, ...meta.package.split('/'), 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

const hostProbeCache = new Map()

/**
 * 取本机宿主版本。**惰性 + 每进程每 scope 只跑一次**（同 repoDomainCache 的做法）。
 * 返回 { scope, registered, sources }；sources 里每条都带取不到的原因。
 */
export function probeHost(scope) {
  if (hostProbeCache.has(scope)) return hostProbeCache.get(scope)
  const entry = HOST_PROBES[scope]
  let result
  if (entry === undefined) {
    result = { scope, registered: false, sources: [], reason: `没有登记「${scope}」的取值途径——未登记即未核对` }
  } else {
    const sources = []
    if (entry.cli !== undefined) {
      const out = runRegisteredCommand(entry.cli.command, entry.cli.args)
      const value = out === undefined ? undefined : versionFromOutput(out)
      sources.push({
        source: `${entry.cli.command} ${entry.cli.args.join(' ')}`,
        value,
        reason: out === undefined
          ? '命令取不到（未装或查询失败）'
          : (value === undefined ? `输出里没有唯一的版本形状（原文首行：${String(out).split('\n')[0].slice(0, 60)}）` : ''),
      })
    }
    if (entry.metadata !== undefined) {
      const value = hostMetadataValue(entry)
      sources.push({
        source: `${entry.metadata.package} 的安装元数据`,
        value,
        reason: value === undefined ? '分发根或包元数据读不到（没有对应的包管理器，或该包不在全局安装里）' : '',
      })
    }
    result = { scope, registered: true, sources }
  }
  hostProbeCache.set(scope, result)
  return result
}

/**
 * 「改 host= 必须与 date= 同批」——做成机制，不是注释提醒。
 *
 * 判据：找出最后一次改动 `host=` 的那个提交 A（`git log -S`），再看 A 与 A^ 两版里
 * `date=` 是否同时变化。A 里 host= 变了而 date= 没变，就是那次只改了版本号、日期还停在
 * 上一次核对日：比对会喊「一致」，而日期是假的——最难发现的一种假绿。
 *
 * 取不到 A（值尚未提交、文件未跟踪、浅克隆或无 git）→ 报「未核对」，不静默也不失败：
 * 换台机器或浅克隆不该因此变红。`runGit` 可注入，fixture 直接喂数据。
 */
export function hostDateBatchStatus(repoRoot, rel, hostValue, runGit) {
  const git = runGit ?? ((args) => {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
    return r.error === undefined && r.status === 0 ? (r.stdout ?? '') : undefined
  })
  const found = git(['-c', 'core.quotepath=false', 'log', '-1', '--format=%H', '-S', `host=${hostValue}`, '--', rel])
  const commit = String(found ?? '').trim().split('\n')[0].trim()
  if (commit === '') {
    return { state: 'unverified', reason: '版本控制里找不到改动 host= 的提交（值尚未提交、文件未跟踪，或没有可用的 git 历史）' }
  }
  const after = git(['show', `${commit}:${rel}`])
  const before = git(['show', `${commit}^:${rel}`])
  if (after === undefined || before === undefined) {
    return { state: 'unverified', reason: `读不到提交 ${commit.slice(0, 8)} 前后的内容（可能是根提交或浅克隆）` }
  }
  const dateOf = (text) => /(?:^|\s)date=([0-9-]+)/.exec(String(text))?.[1]
  if (dateOf(after) !== dateOf(before)) return { state: 'ok', reason: '' }
  return {
    state: 'stale',
    reason: `最后一次改 host= 的提交 ${commit.slice(0, 8)} 没有同时改 date=（两版里都是 ${dateOf(after) ?? '未声明'}）——只改了版本号的日期是不可信的`,
  }
}

/**
 * host= 与本机不同的提示正文。抽成纯函数是为了让「它渲染成什么样」可被直接断言。
 *
 * 提示是给人（和接手时的 AI）看的处置指引，所以它必须是**提示本身**：拼接一旦写坏，
 * 冒号后面接的会是源码片段，而那段源码里恰好又写着正确的做法——看的人分不清哪句才是
 * 给他看的，于是整条提示作废。
 */
export function hostMismatchMessage(rel, host, reason) {
  return `${rel} 的 host=${host} 与本机实际宿主不同（${reason}）——两种解释都成立：`
    + '专章滞后（宿主升级后没重核），或换台机器校验 / 宿主回滚 / 同机存在多份宿主。'
    + '**只提示不失败**：脚本判不了是不是真滞后。按该文件的「事实来源」节重核后，把 host= 与 date= **一起**改。'
}

function checkFreshness() {
  const todayStr = new Date().toISOString().slice(0, 10)
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const files = []
  try {
    for (const e of readdirSync(join(SKILL_ROOT, 'references'), { withFileTypes: true, encoding: 'utf8' })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(`references/${e.name}`)
    }
  } catch { /* 缺目录由对应的检查报，这里不重复 */ }
  try {
    const plugDir = join(SKILL_ROOT, 'references', 'plugins')
    for (const e of readdirSync(plugDir, { withFileTypes: true, encoding: 'utf8' })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(`references/plugins/${e.name}`)
    }
  } catch { /* 缺目录由对应的检查报，这里不重复 */ }
  for (const rel of files.sort()) {
    let text
    try {
      text = readText(join(SKILL_ROOT, rel))
    } catch { continue }
    // 判据是「这个文件承载了外部易变事实」，**不是文件名模式**：总纲 publish.md 与
    // remote-github.md 同样带着跨生态的易变取值（制品库行为、令牌有效期、界面路径），
    // 按文件名匹配会把它们漏在保鲜之外——而它们恰恰是最常被照抄的那两页。
    const isChapter = /^references\/plugins\/[a-z0-9-]+\.md$/.test(rel)
      || /^references\/publish-[a-z0-9-]+\.md$/.test(rel)
      || rel === 'references/publish.md'
      || rel === 'references/remote-github.md'
      // 协作那页同样承载外部易变事实：平台对 fork 提案的令牌限制、`pull_request_target`
      // 的语义与风险、分支保护与合并后删分支的行为——都是「会随平台更新变化」的东西，
      // 而它们写错一次就变成安全事故。按文件名点名的理由与上两行一致：这四份是总纲，
      // 不是某生态的专章，模式匹配不到。
      || rel === 'references/collaboration.md'
    const r = evalFreshnessMarker(rel, text, todayStr, tomorrowStr)
    if (isChapter && !r.hasSection) {
      fail(`${rel} 缺少「事实来源」节——带外部易变事实的章节必须写来源与核实方式（插件专章见 plugin-project.md 骨架的「事实来源（必填）」节，发布专章见兄弟文件的同名节）。`)
    }
    if (isChapter && r.count === 0) {
      fail(`${rel} 缺少统一核对标记——在「事实来源」节末尾附一个（格式与用法见 references/publish.md 的『专章的「事实来源」标记』一节）。`)
    }
    // 「事实来源」不能只是一句套话：它必须写出**能照着做的查法**（来源链接，或
    // 去哪个文档的哪一节怎么核），否则「上次看到的值」过期时读的人无处可查。
    //
    // 这条判据最容易变成**永真**：从标题本身切起的「正文」里就带着「来源」二字，
    // `/https?:\/\/|官方|文档|来源/` 恒命中，fail 就成了死代码（一份只有标题加标记的
    // 最简文档照样通过）。所以按 markdown 语义取节正文，并在 selftest 里用
    // 「只有标题的最简文档必须报错」证伪它。
    if (isChapter && r.hasSection) {
      if (!hasActionableSources(freshnessSectionBody(text))) {
        fail(`${rel} 的「事实来源」节没有写出可执行的查法——至少要有来源链接，或写明去哪个文档的哪一节怎么核；只有一句套话等于没有。`)
      }
    }
    for (const e of r.errors) fail(`${rel} ${e}`)
    for (const w of r.warnings) warn(`${rel} ${w}`)

    // host= 的三态比对：**只有带这个键的专章参与**，按 scope 查登记的取值途径。
    // 全部落在提示区、绝不失败：换台机器校验、宿主回滚、同机多份宿主都能造出
    // 「不同」，脚本判不了是不是真滞后——判不了罪就不能失败，而且进失败区就是
    // 「换台机器必红」，那是本项目明确要避免的检查。
    if (isChapter && r.keys?.host !== undefined) {
      const scope = expectedFreshnessScope(rel)
      const probe = probeHost(scope)
      if (probe.registered !== true) {
        warn(`${rel} 的 host=${r.keys.host} 未核对：${probe.reason}。**「没比」与「比过且一致」是两回事，不要读成通过。**`)
      } else {
        const cmp = compareHostMarker(r.keys.host, probe.sources)
        if (cmp.state === 'match') {
          // 一致 → 静默（不产生噪音，这一态是绝大多数情况）
        } else if (cmp.state === 'mismatch') {
          warn(hostMismatchMessage(rel, r.keys.host, cmp.reason))
        } else {
          warn(`${rel} 的 host= 未核对：${cmp.reason}。**「没比」与「比过且一致」是两回事，不要读成通过。**`)
        }
      }
      // 两键同批：只改 host= 而不改 date= 的假绿在这里现形（同样只提示不失败——
      // 历史提交改不了，判成失败等于留下一条永远消不掉的红色）。
      const batch = hostDateBatchStatus(SKILL_ROOT, rel, r.keys.host)
      if (batch.state === 'stale') warn(`${rel} 的 host= 与 date= 不是同批更新的：${batch.reason}`)
      else if (batch.state === 'unverified') warn(`${rel} 的 host= 与 date= 是否同批**未核对**：${batch.reason}`)
    }
  }
  process.stdout.write('保鲜标记：格式与归属一致\n')
}

// ── README 的目录与标题同步 ───────────────────────────────────────

/**
 * README 的目录是派生内容（由各节标题决定），因此必须与标题保持同步。
 *
 * 这条检查的价值在于「漂移会当场暴露」：加了一节忘了加目录项、改了标题忘了改锚点，
 * 而**锚点写错的表现是「点了没反应」**——不报错、不显眼，作者也不会去点自己的目录。
 * 所以不能靠记得，得靠检查。
 *
 * 只查本地能算的东西（目录 vs 标题），**不查徽章**：徽章要联网、依赖外部服务，
 * 放进检查会因为对方抖动而误报，那种检查很快就会被无视。
 */
function checkReadmeToc() {
  const targetDocs = [
    join(SKILL_ROOT, 'README.md'),
    join(SKILL_ROOT, 'README.en.md'),
    join(SKILL_ROOT, 'references', '*.md'),
    join(SKILL_ROOT, 'references', 'plugins', '*.md'),
  ]
  const script = join(SKILL_ROOT, 'scripts', 'sync-toc.mjs')
  if (!existsSync(script)) { fail('缺少 scripts/sync-toc.mjs（目录同步工具）。'); return }
  const r = spawnSync(process.execPath, [script, ...targetDocs, '--check'], { encoding: 'utf8', env: process.env })
  if (r.error !== undefined) { fail(`目录同步检查无法执行：${r.error.message}`); return }
  if (r.status !== 0) {
    const detail = (r.stdout ?? '').trim().split('\n').filter((l) => l.trim() !== '').join(' / ')
    fail(`文档目录与标题不同步：${detail}\n`
      + `      修正：node scripts/sync-toc.mjs README.md README.en.md "references/*.md" "references/plugins/*.md"`)
    return
  }
  process.stdout.write('文档目录：与标题一致（含 README 及全部参考专章）\n')
}

/**
 * 本仓库自己的协作模板：要素必须齐。
 *
 * 为什么单独查这一份：`review.mjs` 查的是**目标项目**的模板，而本仓库既是这套规矩的作者、又是
 * 它的第一个用户。作者自己不满足自己的要求时，模板里的每一栏都会慢慢变成「可选」——那正是
 * 「教别人的规则自己先用」这条要防的退化，而且它退化时不会有任何声音。
 */
function checkOwnTemplates() {
  const gh = join(SKILL_ROOT, '.github')
  const prPath = join(gh, 'pull_request_template.md')
  if (!existsSync(prPath)) {
    fail('缺少 .github/pull_request_template.md —— 本仓库自己的提案模板。')
    return
  }
  const prText = readText(prPath).replace(/^\uFEFF/, '')
  const prNeed = [
    [/怎么验证|验证的/, '怎么验证'],
    [/回滚/, '回滚点'],
    [/风险与影响范围/, '风险与影响范围'],
    [/没有弱化任何门禁/, '「没有弱化任何门禁」这条自查'],
    [/工作记录/, '工作记录状态与断点'],
  ]
  const prGap = prNeed.filter(([re]) => !re.test(prText)).map(([, label]) => label)
  if (prGap.length > 0) {
    fail(`.github/pull_request_template.md 缺 ${prGap.join('、')} —— `
      + '这几栏是提案模板的全部价值所在；补进模板，别只写在审查的人脑子里。')
  }

  const issueDir = join(gh, 'ISSUE_TEMPLATE')
  if (!existsSync(issueDir)) {
    fail('缺少 .github/ISSUE_TEMPLATE/ —— 外部报告只有在有模板时才会一次带全信息。')
    return
  }
  const issues = readdirSync(issueDir, { withFileTypes: true, encoding: 'utf8' })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
  if (issues.length === 0) {
    fail('`.github/ISSUE_TEMPLATE/` 里没有任何 `.md` 模板 —— 空目录不算有模板。')
    return
  }
  const issueNeed = [
    [/期望/, '期望发生什么'],
    [/实际/, '实际发生什么'],
    [/复现/, '怎么复现'],
    [/环境/, '在什么环境上'],
  ]
  for (const name of issues) {
    const text = readText(join(issueDir, name)).replace(/^\uFEFF/, '')
    const verdict = issueTemplateGaps(text)
    if (verdict === undefined) {
      fail(`.github/ISSUE_TEMPLATE/${name} 认不出是缺陷模板还是需求模板 —— `
        + 'frontmatter 的 `name` / `about` 要说清它收什么；认不出就不判，等于这一份没有门禁。')
      continue
    }
    if (verdict.lacking.length > 0) {
      fail(`.github/ISSUE_TEMPLATE/${name} 缺 ${verdict.lacking.join('、')} —— `
        + '要素缺一件，每份报告都要来回追问一轮。')
    }
  }
  // 两类都该有：缺陷与需求的必填信息不同，一份模板顶不了两份。
  const kinds = new Set(issues.map((n) => issueTemplateGaps(readText(join(issueDir, n)).replace(/^\uFEFF/, ''))?.kind))
  for (const [kind, label] of [['bug', '缺陷'], ['feature', '需求']]) {
    if (!kinds.has(kind)) {
      fail(`.github/ISSUE_TEMPLATE/ 里没有${label}模板 —— 两类问题的必填信息不同，`
        + '一份模板顶不了两份，缺的那类报告会带着另一类的骨架交上来。')
    }
  }
  if (prGap.length === 0 && kinds.has('bug') && kinds.has('feature')) {
    process.stdout.write(`协作模板：${issues.length} 份问题模板与提案模板的要素齐全\n`)
  }
}

/**
 * 本仓库的发布说明：**它教别人怎么写，自己就得先满足那套判据**。
 *
 * 判据只有一处实现（`lib/protocol.mjs` 的 `lintReleaseNotes`），发送端与这里共用同一份——
 * 两处各判一次，迟早一处改了一处没改，而那时的表现是「CI 发送时拒绝，本地校验说没问题」。
 *
 * 只查「任何项目都成立」的那几条：有且只有一个标题、标题里那个号与文件名一致、至少一节、
 * 没有空节、没有同名节、没留骨架标记。**不查分了哪几节**（那是每个项目自己的决定）。
 *
 * 标题与文件名的比对要带着**号**去比（`lintReleaseNotes` 只认标题里第一个像版本号的东西），
 * 所以「# v1.2.3 — 首次发布」这类写法照过——它不是错号。这一条正是发版链路依赖的事实：
 * 工作流按标签名取文件，文件里写的是另一个号，页面上的标题就对不上。
 */
function checkReleaseNotes() {
  const dir = join(SKILL_ROOT, 'docs', 'release-notes')
  if (!existsSync(dir)) return
  const files = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
  if (files.length === 0) {
    fail('docs/release-notes/ 是空的 —— 发过版的仓库至少有一份说明。')
    return
  }
  let bad = 0
  for (const name of files) {
    const tag = name.replace(/\.md$/, '')
    const problems = lintReleaseNotes(readText(join(dir, name)).replace(/^\uFEFF/, ''), tag)
    if (problems.length > 0) {
      bad += 1
      fail(`docs/release-notes/${name} 不像一份成品：${problems.join('；')}。`
        + '历史说明是快照、不按今天的规范改——但空壳、空节、同名节在任何一版里都不成立，'
        + '按报出的那一条修。')
    }
  }
  if (bad === 0) {
    process.stdout.write(`发布说明：${files.length} 份都通过结构检查（标题、分节、无空节）\n`)
  }
}

/**
 * 「必须独立审查」这条规则，**三个来源必须说同一件事**。
 *
 * 规则本身在 `references/collaboration.md` 第四、五节；本仓库契约在 `AGENTS.md` 的
 * 「协作」一节；提案模板要有一栏让人填审查记录。三处各写一份，改一处漏两处的后果是：
 * **规则还在，但照着做的人找不到它**——实测发生过一次，执行者看到 CI 绿就合并，因为
 * 两份文档都只说「高风险必须人合」，没有一条说「必须有人审」。
 *
 * 这里不判措辞，判的是**这三处有没有把同一件事都说到**。判据取关键词而不是原句：
 * 原句一改（换个说法）就误报，而那会让这条检查被当成噪音关掉。
 */
function checkReviewRuleSources() {
  const read = (rel) => {
    const p = join(SKILL_ROOT, rel)
    return existsSync(p) ? readText(p) : undefined
  }
  const missing = []
  const need = (rel, test, why) => {
    const text = read(rel)
    if (text === undefined) { missing.push(rel + ' 不存在'); return }
    if (!test(text)) missing.push(rel + '：' + why)
  }

  // 一、判据：要有「审不审」那一节，以及「正文是索引、评论是痕迹」那两层。
  //
  // 判**结构**而不是关键词。原先判的是 `/必须独立审查/` 这类词，而那个词在这份文件里
  // 到处都有——把整节删掉照样绿。一条「判据被删掉也看不出来」的检查，比没有更坏：
  // 它打印的是「四处都在」。
  need('references/collaboration.md',
    (x) => /^### 什么时候必须审/m.test(x) && /必须独立审查/.test(x),
    '缺「### 什么时候必须审」这一节（或节里没有「必须独立审查」）—— 审不审就没有判据了')
  need('references/collaboration.md',
    (x) => /索引（提案正文）/.test(x) && /痕迹（平台评论）/.test(x),
    '没有把「正文是索引、评论是痕迹」分成两层 —— 评论一条不发也能全绿')
  need('references/collaboration.md',
    (x) => /^## 五、能不能合/m.test(x) && /\|\s*必须审\s*\|/.test(x),
    '「## 五、能不能合」那张表没有「必须审」一列 —— 审不审与谁能合又混回一句了')

  // 二、本仓库契约：`## 高风险路径` 那一节要有表，而且要能解析出路径。
  need('AGENTS.md',
    (x) => {
      const table = readHighRiskTable(x)
      return table.found === true && table.paths.length > 0 && table.skipped.length === 0
    },
    '「## 高风险路径」一节缺失、表是空的、或有解析不出来的行 —— 那条门禁会静默失效')

  // **契约文件自己必须在表里**。删掉那一行，改契约本身就不再需要审查记录——而
  // 「改窄这张表」正是能一次废掉门禁、且自身不受审查的那条路。自指的洞只能靠显式
  // 列进来堵住，而「显式列进来」这件事本身要有检查看着。
  need('AGENTS.md',
    (x) => readHighRiskTable(x).paths.some((v) => v.replace(/\/$/, '') === 'AGENTS.md'),
    '「## 高风险路径」表里没有 AGENTS.md 自己 —— 这张表就是判据的输入，'
    + '删掉它、把它改窄都不再需要审查记录，等于一次就能把门禁废掉。'
    + '判据的输入文件必须在判据的保护范围内。')

  // 三、落盘模板：那一节还要**活过刷新**。
  //
  // 这一条是这次审查发现的最重的问题：没有 `pf:author` 时，重跑一次 `compose-agents`
  // 就把整节冲回占位模板，填好的表一个路径都不剩，而 preflight 与 compose --check 全绿。
  // 判据落在「这一节带着 author 标记」上——那正是「刷新时保留既有内容」的开关。
  need('templates/agents-project.md',
    (x) => {
      const head = /^## 高风险路径[ \t]*$/m.exec(x)
      if (head === null) return false
      const after = x.slice(head.index + head[0].length)
      const next = /^##[ \t]/m.exec(after)
      const block = next === null ? after : after.slice(0, next.index)
      return /pf:author/.test(block) && /\|\s*路径\s*\|/.test(block)
    },
    '「## 高风险路径」一节缺了、没有 pf:author 标记（重跑一次生成就把整节冲掉）、'
    + '或没有那张表 —— 目标项目会拿到一个空表，而门禁什么都不拦')

  // 四、两份提案模板都要有那一节，**而且表格在注释外面**。
  //
  // 表格写在 `<!-- -->` 里时，判据（先去注释再看）永远读到空节：目标项目按模板填也过不了，
  // 只能删掉说明自己重画一张。实测发生过。
  for (const rel of ['templates/pull-request-template.md', '.github/pull_request_template.md']) {
    need(rel,
      (x) => {
        const head = /^##[ \t]*审查记录[ \t]*$/m.exec(x)
        if (head === null) return false
        const after = x.slice(head.index + head[0].length)
        const next = /^##[ \t]/m.exec(after)
        const block = next === null ? after : after.slice(0, next.index)
        const visible = block.replace(/<!--[\s\S]*?-->/g, '')
        return /\|\s*轮次\s*\|/.test(visible) && /谁审的/.test(visible)
      },
      '缺「## 审查记录」这一节，或者表格写在了 HTML 注释里（判据会先去掉注释，'
      + '那样永远读到空节，照着模板填也过不了）')
  }

  if (missing.length > 0) {
    for (const m of missing) {
      fail(m + ' —— 「必须独立审查」这条规则要在四处同时成立，而且每一处都要**结构上**能判：'
        + '判据（references）、本仓库契约（AGENTS.md）、落盘模板（agents-project.md）、'
        + '两份提案模板。缺一处，规则就还在、但照着做的人找不到它。'
        + '模板那两处还要求「活过刷新」与「表格在注释外面」—— 那两条都实测出过事。')
    }
    return
  }
  process.stdout.write('审查规则：判据、契约、落盘模板、两份提案模板五处都在，结构上都能判\n')
}

/**
 * 工作记录里「执行者」这一格写得能不能找到人。
 *
 * 这一格的用处只有一个：**这件事该找谁问**。所以：
 *   - 代词（「本次会话」「我」「AI」）不行 —— 换个人打开，他不知道那是谁；
 *   - 写死的固定人名也不行 —— 同一个人换机器、换账号、fork 出去就变了，而记录留在
 *     版本库里，改动时没人会回来改这一格；
 *   - 能认出是一个人/一个账号（署名、邮箱、平台账号）才算。
 *
 * 返回 `{ verdict, value }`，verdict 取 absent（没这一格或空着）/ pronoun /
 * no-identity / ok。**absent 不在这里报** —— 那是表头缺字段那条判据的事，两件事别混。
 */
export function executorVerdict(text) {
  const m = /^\|\s*执行者\s*\|\s*(.*?)\s*\|\s*$/m.exec(String(text ?? ''))
  if (m === null) return { verdict: 'absent', value: '' }
  const value = m[1].replace(/<!--[\s\S]*?-->/g, '').trim()
  if (value === '') return { verdict: 'absent', value: '' }
  if (/^(本次会话|本会话|我|AI|ai|助手|assistant|待填|待定|TBD|无|—|-)$/.test(value)) {
    return { verdict: 'pronoun', value }
  }
  if (!/@/.test(value)) return { verdict: 'no-identity', value }
  return { verdict: 'ok', value }
}

/** 这一格不合格时要说的话（两处共用，避免措辞日后漂移）。 */
export const EXECUTOR_ADVICE = '这一格的用处是「这件事该找谁问」，代词在这件事上是零信息，'
  + '换个人打开就找不到人。写**现场取的身份**：提交署名（git config user.name 与 '
  + 'user.email）加平台账号；取不到就写「未署名」并说明原因，不要编一个。'
  + '别人 fork 之后填的是他自己的署名，这也是它必须现场取、不能写死的原因。'
/**
 * 本仓库的工作记录：**结构与命名是机器能判的那一半**。
 *
 * 状态、决策、断点写得对不对，机器判不了（也不该判——那是意图）；能判的是「这份记录有没有
 * 按自己写下的规范落盘」：文件名带建单日期、表头三行齐全且日期可解析、断点不是空的。
 * 这一条挡的是最常见的退化——记录还在，但停在上上轮，或者根本没按格式写。
 *
 * 判据来源是 `references/collaboration.md` 第二节与 `templates/work-item.md`；**两边谁改了，
 * 这里也要跟着改**，否则门禁会拿旧规范去判新写法。
 */
function checkWorkRecords() {
  const dir = join(SKILL_ROOT, 'docs', 'work')
  if (!existsSync(dir)) return
  const files = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort()
  let bad = 0
  for (const name of files) {
    const rel = `docs/work/${name}`
    const text = readText(join(dir, name)).replace(/^\uFEFF/, '')
    if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(name)) {
      bad += 1
      fail(`${rel} 文件名不是 \`YYYY-MM-DD-主题.md\` —— 日期在最前、写建单那天，`
        + '不带编号与状态。已经在用的老文件不强制改名；新建的照这条走。')
      continue
    }
    const fields = ['状态', '建单日期', '最近更新']
    const gap = fields.filter((f) => !new RegExp(`^\\|\\s*${f}\\s*\\|`, 'm').test(text))
    if (gap.length > 0) {
      bad += 1
      fail(`${rel} 表头缺 ${gap.join('、')} —— 这三行回答「现在什么状态、什么时候建的、`
        + '最近一次动手是什么时候」，缺了换会话就接不上。')
      continue
    }

    // **执行者要写得能让下一个人找到人。**
    //
    // 这一格的用处只有一个：「这件事该找谁问」。所以「本次会话」「我」「AI」这类代词
    // 等于空话——换个人打开这份记录，他不知道那是谁；而这个库会被 fork、会被别人接手。
    // 别人克隆之后填的应当是他自己的署名，不是原作者的——所以这一格必须是**现场取的**。
    //
    // 判据取形状而不是取值：要能看出是一个人/一个账号（邮箱、`@`、或平台账号名），
    // 不认具体是谁。写死某个人名就等于「换个人就失准」，与契约里那条「操作者取值
    // 一律现场取」是同一个道理。
    const who = executorVerdict(text)
    if (who.verdict !== 'absent' && who.verdict !== 'ok') {
      bad += 1
      fail(`${rel} 的「执行者」是「${who.value}」—— ` + EXECUTOR_ADVICE)
    }
    const dates = []
    for (const field of ['建单日期', '最近更新']) {
      const m = new RegExp(`^\\|\\s*${field}\\s*\\|\\s*(\\d{4}-\\d{2}-\\d{2})\\s*\\|`, 'm').exec(text)
      if (m === null) {
        bad += 1
        fail(`${rel} 的「${field}」不是 YYYY-MM-DD 形状 —— 日期要能排序、能算新旧。`)
        continue
      }
      dates.push(m[1])
    }
    const points = /^## 断点[ \t]*$/m.exec(text)
    // 截到**下一个二级标题**为止：只删标题那一行的话，后面「完成后的记录」之类的正文会
    // 被当成断点的内容，「断点清空」照样判过——而那正是要拦的样子。
    const rest = points === null ? [] : text.slice(points.index).replace(/^## 断点[^\n]*\n/, '').split('\n')
    const nextHeading = rest.findIndex((line) => /^## /.test(line))
    const body = (nextHeading < 0 ? rest : rest.slice(0, nextHeading)).join('\n')
    const visible = (() => {
      const state = { inComment: false }
      return body.split('\n').map((line) => stripHtmlComments(line, state)).join('\n').trim()
    })()
    if (points === null || visible === '') {
      bad += 1
      fail(`${rel} 的「断点」是空的 —— 卡在哪、下一步从哪接，写一句都行；`
        + '留空会让人以为这里没做完。')
    }
  }
  if (bad === 0) {
    process.stdout.write(`工作记录：${files.length} 份文件名与表头都合规、断点非空\n`)
  }
}

/**
 * 章节文件的体量软预算：**只提示，不失败**。 *
 * 为什么不失败：「不同不等于超标」。一份长文件可能每一段都是判据，删掉任何一段都会让
 * 某个没预料到的情况失去依据；而「读起来累」是相对的，没有一个能一刀切的数字。红的
 * 代价是它会被当成坏了——那比不检查更糟。
 *
 * 为什么还要提示：**它有长出来的趋势**。指标一旦没人看，文件就会一直涨，而涨到某个
 * 程度时，读它的人（AI）会在读到一半时丢掉上下文——那件事本身不会报错。提示量出来
 * 的是「这件事正在发生」，怎么处置留给看的人。
 */
//
// 阈值取「明显超过同伴」的位置，不取中位数：判据是**这条提示还值不值得读**。
// 门槛设在中位数附近时，一半以上的文件都会喊——而一份永远在喊的报告等于不存在。
const CHAPTER_LINE_BUDGET = 600
const CHAPTER_BYTE_BUDGET = 45000
function checkChapterSize() {
  const dir = join(SKILL_ROOT, 'references')
  if (!existsSync(dir)) return
  const walk = (sub) => {
    const here = join(dir, sub)
    for (const e of readdirSync(here, { withFileTypes: true, encoding: 'utf8' })) {
      const rel = sub === '' ? e.name : `${sub}/${e.name}`
      if (e.isDirectory()) { walk(rel); continue }
      if (!e.name.endsWith('.md')) continue
      const full = join(dir, rel)
      const text = readText(full)
      const lines = text.split('\n').length
      const bytes = Buffer.byteLength(text, 'utf8')
      if (lines <= CHAPTER_LINE_BUDGET && bytes <= CHAPTER_BYTE_BUDGET) continue
      warn(`references/${rel} 已到 ${lines} 行 / ${Math.round(bytes / 1024)} KB`
        + `（软预算 ${CHAPTER_LINE_BUDGET} 行 / ${Math.round(CHAPTER_BYTE_BUDGET / 1024)} KB）`
        + '——不是错误，只是该看一眼：能不能靠去重、拆节或指向兄弟文件压下来。'
        + '压不下来就留着，判据比篇幅重要。')
    }
  }
  walk('')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

// ── 用户包边界 ────────────────────────────────────────────────────

/**
 * 解析 `git archive` 输出的 tar 流，取出其中的条目名。
 *
 * 为什么直接解析，而不是调 `tar` 命令、或自己把 `.gitattributes` 的通配规则翻译一遍：
 * **包内容的权威来源就是 git 自己的导出结果**。自己实现一遍匹配规则等于维护第二份真相，
 * 两份不一致时从外面看不出来，而它判的恰恰是「哪些文件会被发出去」——实测就撞过一次：
 * `git check-attr` 对目录模式下的文件报「未设置」，而 `git archive` 确实把它排除了。
 * tar 的块结构是固定格式，解析它比复刻 git 的匹配语义可靠得多。
 *
 * pax 扩展头（长路径或含非 ASCII 时 git 会写）里的 `path=` 作用于紧随其后的那一条；
 * GNU 长名头 `L` 同理，一并认。
 */
export function tarEntries(buf) {
  const out = []
  let off = 0
  let pending
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    if (header.every((b) => b === 0)) break
    const field = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0[\s\S]*$/, '').trim()
    const sizeText = field(124, 136)
    const parsed = Number.parseInt(sizeText, 8)
    const bytes = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    const type = String.fromCharCode(header[156] === 0 ? 0x30 : header[156])
    const data = buf.subarray(off + 512, off + 512 + bytes)
    if (type === 'x') {
      const m = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(data.toString('utf8'))
      pending = m === null ? undefined : m[1]
    } else if (type === 'L') {
      pending = data.toString('utf8').replace(/\0[\s\S]*$/, '')
    } else if (type !== 'g') {
      const name = pending ?? field(0, 100)
      pending = undefined
      if (name !== '') out.push(name)
    }
    off += 512 + Math.ceil(bytes / 512) * 512
  }
  return out
}

/**
 * 当前索引会导出成什么（相对仓库根的文件路径）。取不到返回 undefined。
 *
 * 做法是**真跑一次导出**：`git write-tree` 把索引写成树对象，再对它 `git archive`——
 * 于是「哪些文件会被发出去」由 git 自己回答，`export-ignore` 的实际效果也在内。用索引
 * 而不是 HEAD，是为了让「新增了文件但还没提交」也能当场核对（那正是最容易漏排的时刻）；
 * 用索引而不是工作区，是因为产物最终来自被提交的内容。
 *
 * git 不可用、索引里有未合并条目等情况下返回 undefined：**「没比」与「比过且一致」
 * 必须可区分**，读不到就报未核对，不静默放行。
 */
/**
 * 某个版本里受版本控制的文件全集（相对仓库根）。取不到返回 undefined。
 *
 * 与 `trackedFiles()` 是同一个判据、两个对象：那个看工作区，这个看历史版本。
 * 产出物核对要的是后者——判据与对象必须同源，拿今天的清单去核那天的包，
 * 少一个文件永远核不出来。
 */
function trackedFilesAt(ref) {
  const r = spawnSync('git', ['ls-tree', '-r', '-z', '--name-only', ref], {
    cwd: SKILL_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error !== undefined || r.status !== 0 || typeof r.stdout !== 'string') return undefined
  const files = r.stdout.split('\0').filter((p) => p !== '')
  return files.length === 0 ? undefined : files
}

function packageMembers() {
  const run = (args, encoding) => spawnSync('git', args, {
    cwd: SKILL_ROOT, encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  const tree = run(['write-tree'], 'utf8')
  if (tree.error !== undefined || tree.status !== 0) return undefined
  const sha = (tree.stdout ?? '').trim()
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return undefined
  const archive = run(['archive', '--format=tar', sha], undefined)
  if (archive.error !== undefined || archive.status !== 0) return undefined
  const files = tarEntries(archive.stdout ?? Buffer.alloc(0)).filter((n) => !n.endsWith('/'))
  return files.length === 0 ? undefined : files
}


/**
 * 文件地图的两半分别住在两份文件里，**各按各的读者分**：
 *   - 「用户包里有」在 `SKILL.md`：它随包分发，用户副本里一定有，而那份表就是
 *     「用户拿到什么」的声明；
 *   - 「仓库里另有」在 `AGENTS.md`：它不进包，只在维护这个 skill 本身时才需要读。
 *
 * 把后者塞进 `SKILL.md` 的代价很具体：那是**用户读的**入口文件，一张「本仓库还有
 * 哪些自用脚本」的表对他没有任何用处，却要占掉他每次调用时的注意力。
 *
 * 两张表仍然是**同一张图的两半**：门禁把两处合起来读，双向核对照样成立。
 */

/**
 * 从某个版本读一个文件的内容（`git show <ref>:<路径>`）。读不到返回 undefined。
 *
 * 包核对必须**两边同源**：产出物取自某个版本，判据（文件地图）就必须取自同一个版本。
 * 拿当前工作区的地图去核对一个旧版本的产出物，会在发版那天恰好一致，之后每过一天
 * 偏离一点——「今天碰巧对」正是本项目要消灭的那种性质。
 */
function fileFromRef(ref, path) {
  const r = spawnSync('git', ['show', `${ref}:${path}`],
    { cwd: SKILL_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  if (r.error !== undefined || r.status !== 0) return undefined
  return (r.stdout ?? '').replace(/^\uFEFF/, '')
}

/**
 * 包自洽性：包里的脚本能不能互相找到，包里的文档有没有把读者指到包外。
 *
 * 包集合判据只回答「文件集合对不对」，不回答「这些东西放在一起能不能用」。实测撞过两次，
 * 两次的集合都是**完全正确**的：
 *   - `compose-agents.mjs` 导入了被排除出包的 `scripts/dev/preflight.mjs`——用户拿到的包里
 *     那个脚本一跑就报 ERR_MODULE_NOT_FOUND，而门禁全绿；
 *   - 面向使用者的文档里指向 `CONTRIBUTING.md` 的相对链接，在包里是死链。
 * 判据是**包内的相对引用必须落在包内**，与逐个人工登记无关：新增文件、搬动文件、改排除
 * 规则，都会在这里当场暴露。
 *
 * `templates/` 里的**相对链接**不参与这项检查：那些骨架是**将要落到别的项目里**的内容，
 * 其中的相对链接指向那个项目的文件，本来就不该在本包里解析得到。
 *
 * 但「指向目标项目」与「指向本包」是两回事，混成一条规则就会连后者一起放过：
 * `templates/ci-release.yml` 里那句 `node scripts/release-notes.mjs` 指向的是**本包**
 * 的脚本，落盘后一定悬空——它正是靠这条豁免躲过所有门禁的。归属判据归
 * `checkDeliveredAttribution`，这里只放行「指向目标项目」那一类。
 */
function checkPackageSelfConsistency(pkg, readContent) {
  const inPkg = new Set(pkg)
  const present = (target) => inPkg.has(target) || pkg.some((x) => x.startsWith(`${target}/`))
  const resolveRel = (from, spec) => {
    const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/') + 1) : ''
    const out = []
    for (const part of `${dir}${spec}`.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') out.pop()
      else out.push(part)
    }
    return out.join('/')
  }
  let checked = 0
  for (const f of pkg) {
    if (f.startsWith('templates/')) continue
    const text = readContent(f)
    if (text === undefined) {
      warn(`包自洽性未核对：读不到 ${f} 的内容（它可能只存在于被核对的产出物里）。`)
      continue
    }
    if (f.endsWith('.mjs')) {
      for (const spec of moduleSpecifiers(text)) {
        if (!spec.startsWith('./') && !spec.startsWith('../')) continue
        checked += 1
        const target = resolveRel(f, spec)
        if (!present(target)) {
          fail(`${f} 导入了 ${spec}，而 ${target} 不在用户包里 —— 包里的脚本会一跑就崩。`
            + '共用的实现要放在随包分发的模块里（scripts/ 顶层），不能放在 scripts/dev/。')
        }
      }
    } else if (f.endsWith('.md')) {
      // 只认 Markdown 链接与图片：行内代码里的路径是「提到」，不是可点的引用。
      for (const m of text.matchAll(/\]\(\s*([^)\s]+)\s*(?:"[^"]*")?\s*\)/g)) {
        const raw = m[1]
        if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#') || raw.startsWith('//')) continue
        const target = resolveRel(f, raw.split('#')[0])
        if (target === '') continue
        checked += 1
        if (!present(target)) {
          fail(`${f} 里的相对链接指向 ${target}，而它不在用户包里 —— 拿到包的人点了是死链。`
            + '指向仓库自用文件时请写仓库的完整网址。')
        }
      }
    }
  }
  return checked
}

/** 从工作区读文件内容；读不到返回 undefined。 */
function contentFromWorktree(f) {
  const full = join(SKILL_ROOT, f)
  return existsSync(full) ? readText(full) : undefined
}

/**
 * 两份结构规则必须说同一件事：`.gitattributes` 的 `export-ignore` 是它的**文本形态**，
 * `scripts/lib/protocol.mjs` 的 `REPO_ONLY_DIRS` / `REPO_ONLY_FILES` 是它的**代码形态**。
 *
 * 为什么要核：契约里写着「新增一处独立目录要两处一起改」，而这句话以前**没有任何检查
 * 兜底**——实测两个方向都 0 项失败（只改 REPO_ONLY 不改 .gitattributes；只改
 * `.gitattributes` 不改 REPO_ONLY）。`.gitattributes` 是四个高风险区之一，它的失准
 * 不会当场报错，只会让「这文件到底进不进包」这个问题从此有两个答案。
 *
 * 判据是**两边路径集合相等**，不比顺序、不比注释。`导出结果` 那一层另有判据
 * （`checkPackageBoundary` 真跑 git archive），这一条只管两份规则之间的自洽。
 * 为什么两者都要：真导出抓得住「规则写了但 git 没照做」，抓不住「两处规则本身不一致」
 * ——后者在导出结果里可能恰好一致，直到有人改了其中一份。
 */
function checkStructuralRulesAgree() {
  const p = join(SKILL_ROOT, '.gitattributes')
  if (!existsSync(p)) { fail('缺少 .gitattributes —— 用户包的边界规则没有文本形态。'); return }
  const text = readText(p)
  const attrDirs = new Set()
  const attrFiles = new Set()
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t === '' || t.startsWith('#')) continue
    // 形如 `/scripts/dev/     export-ignore` 或 `AGENTS.md export-ignore`
    const m = /^(\S+)\s+.*\bexport-ignore\b/.exec(t)
    if (m === null) continue
    const spec = m[1].replace(/^\//, '')
    if (spec.endsWith('/')) attrDirs.add(spec)
    else attrFiles.add(spec)
  }
  const codeDirs = new Set(REPO_ONLY_DIRS)
  const codeFiles = new Set(REPO_ONLY_FILES)

  const onlyAttr = (a, b, label) => [...a].filter((x) => !b.has(x))
    .map((x) => `.gitattributes 排除了 ${x}，而 REPO_ONLY_${label} 里没有它`)
  const onlyCode = (a, b, label) => [...b].filter((x) => !a.has(x))
    .map((x) => `REPO_ONLY_${label} 里有 ${x}，而 .gitattributes 没排除它`)

  const problems = [
    ...onlyAttr(attrDirs, codeDirs, 'DIRS'),
    ...onlyCode(attrDirs, codeDirs, 'DIRS'),
    ...onlyAttr(attrFiles, codeFiles, 'FILES'),
    ...onlyCode(attrFiles, codeFiles, 'FILES'),
  ]
  if (problems.length > 0) {
    for (const m of problems) {
      fail(`${m} —— 两份结构规则必须说同一件事：改一处就要改另一处，`
        + '否则「这个文件进不进包」会有两个答案，而错的那个不会当场报错。')
    }
    return
  }
  process.stdout.write(`结构规则：.gitattributes 与 REPO_ONLY_* 一致`
    + `（${codeDirs.size} 处目录、${codeFiles.size} 个文件）\n`)

  // **例外表本身要对账**：`LANDED_SCRIPTS` 里写一个磁盘上不存在的脚本时，
  // 那条例外会把「模板里指了一条死链」从「该红」变成「归例外管」，失败方向是放过。
  // 拼错一个文件名就足够，而症状是模板里那条引用永远绿着。
  for (const rel of LANDED_SCRIPTS) {
    if (!existsSync(join(SKILL_ROOT, rel))) {
      fail(`LANDED_SCRIPTS 里登记了 ${rel}，但磁盘上没有这个文件 —— `
        + '这条例外的意思是「模板里指它是对的」，表项错了，模板里那条死链就永远绿着。')
    }
  }
  // 反过来也要说清：登记为「要落地的」脚本，必须在落盘那一步真的被拷过去。
  // 只登记不拷，等于给读者留了一项家务，而忘掉它的症状是 CI 里的 MODULE_NOT_FOUND。
  const composeSrc = readText(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'))
  if (!/for \(const rel of LANDED_SCRIPTS\)/.test(composeSrc)) {
    fail('compose-agents.mjs 里没有「把 LANDED_SCRIPTS 拷到目标项目」那一步 —— '
      + '模板里写着「先把它拷过去」，但没有任何东西负责拷，忘了拷的症状是 CI 里一句崩溃栈。')
  }
}

/**
 * 用户包边界：**包里的东西由结构决定，不由任何一份清单决定。**
 *
 * 判据只有两条，都不需要人登记：
 *   1. **不该进包的东西确实没进**：`REPO_ONLY_DIRS` / `REPO_ONLY_FILES` 里那些路径，
 *      一条都不许出现在导出结果里。`.gitattributes` 漏写一条，这里当场红。
 *   2. **该在包里的东西确实在**：全部受版本控制的文件，要么出现在包里，要么命中上面那几条
 *      结构规则。多出来的那个文件**没有归属**——要么它该进包（那内容已经在包里了，
 *      这一条不会红），要么它该被排除（那就在 `.gitattributes` 里加一条结构规则）。
 *
 * 为什么不再拿一张「逐文件登记表」当判据：那张表本身就是要人记得改的东西，而它漏一行的
 * 症状是「文件在包里但没人知道」。结构规则不会漏——它描述的是**哪几处**不进包，
 * 那几处在一年里可能一次都不变。
 *
 * 包集合的来源是**真跑一次的导出结果**（见 `packageMembers`），不是把 `.gitattributes`
 * 的规则另算一遍——后者是近似，而近似在这里正好会放过最该抓的那种错。
 */
function checkPackageBoundary() {
  const pkg = packageMembers()
  if (pkg === undefined) {
    warn('用户包边界未核对（git 不可用，或索引里有未合并的条目）—— 报「未核对」，不放行。')
    return
  }
  const inPkg = new Set(pkg)
  // 一、不该进包的，一个都不许在。
  for (const f of pkg) {
    if (isRepoOnlyPath(f)) {
      fail(`实际导出里有 ${f}，而它属于「不进包」的那几处 —— `
        + '`.gitattributes` 里少了排除它的那条。')
    }
  }
  // 二、受版本控制的文件，要么在包里，要么命中结构规则。第三种状态是「没有归属」。
  const tracked = trackedFiles()
  if (tracked !== undefined) {
    for (const f of tracked) {
      if (inPkg.has(f) || isRepoOnlyPath(f)) continue
      fail(`${f} 受了版本控制，却既不在用户包里、也不属于任何「不进包」的结构规则 —— `
        + '它是没有归属的文件：要么让它进包（删掉 `.gitattributes` 里排除它的那条），'
        + '要么把它放进已有的那几处自用目录（`scripts/dev/` 一类），或新增一处并登记在 `REPO_ONLY_DIRS`。')
    }
  }
  // **包自洽性不看前面那些判据的结果**：它们是「文件集合对不对」，这条是「这些东西放在
  // 一起能不能用」。用全局 `failures` 当开关的话，前面红一下，这里就静默不跑了。
  const before = failures.length
  const links = checkPackageSelfConsistency(pkg, contentFromWorktree)
  if (failures.length === before) {
    process.stdout.write(`用户包边界：${pkg.length} 个文件，与结构规则一致；`
      + `包内 ${links} 处相对引用全部落在包内\n`)
  }
}

/**
 * 核对一份真跑出来的产出物：清单文件里一行一个条目（`git archive <版本> | tar -t` 的结果）。
 *
 * 与 `checkPackageBoundary` 的分工：那一条看的是「当前索引会导出成什么」，在本地随时能跑；
 * 这一条看的是**真的那份包**，由发布工作流在产出物生成后立刻调用。前者管日常，后者管事实。
 *
 * `atRef` 给出版本时，**文件内容也从那个版本读**——包自洽性要读的是那个版本文档里写的
 * 链接，不是今天工作区里写的。判据与对象必须同源，否则核的是「今天的规矩」与
 * 「那天的产出物」。
 */
function checkProducedPackage(listPath, atRef) {
  // **本步骤自己的失败计数**，不读全局 `failures`：读全局的话，前面任何一处红一下，
  // 这里就整段不跑——报告少查一项，而且不说。
  let bad = 0
  const complain = (message) => { fail(message); bad += 1 }

  if (!existsSync(listPath)) { complain(`找不到产出物清单 ${listPath}。`); return }
  const list = readText(listPath).split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '' && !s.endsWith('/'))
  if (list.length === 0) { complain(`${listPath} 里一个条目都没有 —— 产出物不可能空。`); return }

  // 一、不该进包的，一个都不许在。
  for (const f of list) {
    if (isRepoOnlyPath(f)) {
      complain(`产出物里有 ${f}，而它属于「不进包」的那几处 —— `
        + '`.gitattributes` 里少了排除它的那条。')
    }
  }

  // 二、**该在包里的，一个都不许少**。这一半原来被漏掉了，而它才是发版那天真正会出事的
  // 那一半：产出物少了一整块，上面那条「有没有多余的东西」照样全绿。
  //
  // 判据不靠人工清单：受版本控制的文件，要么在产出物里，要么命中「不进包」的结构规则。
  const tracked = atRef === undefined ? trackedFiles() : trackedFilesAt(atRef)
  if (tracked === undefined) {
    warn('产出物缺漏未核对（读不到受版本控制的文件全集）—— 报「未核对」，不放行。')
  } else {
    const inList = new Set(list)
    for (const f of tracked) {
      if (!inList.has(f) && !isRepoOnlyPath(f)) {
        complain(`${f} 该在产出物里，却没有出现 —— 这一版发出去的包是残缺的。`
          + '要么 `.gitattributes` 的排除写宽了，要么生成产出物那一步漏了它。')
      }
    }
  }

  if (bad === 0) {
    const readContent = atRef === undefined
      ? contentFromWorktree
      : (f) => fileFromRef(atRef, f)
    // `checkPackageSelfConsistency` 自己会 fail，但 `bad` 是**这一步开头**的快照，
    // 不会跟着涨。所以取一次失败数再比——不然链接断了照样打印「全部落在包内」，
    // 日志里成功行与失败行同时出现，看的人会以为链接检查过了。
    const beforeLinks = failures.length
    const links = checkPackageSelfConsistency(list, readContent)
    if (failures.length === beforeLinks) {
      process.stdout.write(`产出物核对：${list.length} 个条目，与受版本控制的文件全集一致；`
        + `包内 ${links} 处相对引用全部落在包内\n`)
    }
  }
}

/**
 * 受版本控制的文件（相对仓库根）。取不到返回 undefined。
 *
 * 与 `packageMembers` 用的是同一批 git 查询，只是这里要的是**全集**：判「有没有归属」
 * 必须两边都看，只看包里有什么永远发现不了「有个文件谁都不管」。
 */
function trackedFiles() {
  const r = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'],
    { cwd: SKILL_ROOT, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 })
  if (r.error !== undefined || r.status !== 0) return undefined
  return String(r.stdout ?? '').split('\0').filter(Boolean)
}

/**
 * 发版门禁：标签的名字、标签里那份 `SKILL.md` 声明的版本与来源。
 *
 * 由发布工作流调用（见 `.github/workflows/release.yml`），不在日常自检里跑——日常没有标签，
 * 这条判据没有输入。`metadata.version` 存在的唯一理由是让**没有版本历史的用户包副本**
 * 知道自己属于哪一版，所以它必须与标签同号，否则那个字段就是在说假话。`metadata.source`
 * 同理：那份副本靠它知道去哪儿找新版，指向别人的仓库是在说另一种假话。
 *
 * **两样都从标签里读，不从工作区读**：门禁判的是「要发出去的那份包」，而工作区可能已经
 * 往前走过了（补漏重跑时它一定往前走过了）。同理这里**不判**「标签是否指向当前检出的
 * 提交」——产出物取自标签那棵树，与检出了什么无关，而判它会把「用 `workflow_dispatch`
 * 补漏」这条文档指定的路径整条堵死（补漏时检出的是分支，不是标签）。
 */
function checkReleaseTag(tag, repoArg) {
  const run = (args) => spawnSync('git', args, { cwd: SKILL_ROOT, encoding: 'utf8', windowsHide: true })
  const tagged = run(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`])
  if (tagged.error !== undefined || tagged.status !== 0) { fail(`仓库里没有标签 ${tag}。`); return }
  const skillText = fileFromRef(tag, 'SKILL.md')
  if (skillText === undefined) { fail(`读不到标签 ${tag} 里的 SKILL.md —— 无法核对版本。`); return }
  const declared = skillVersion(skillText)
  if (declared === undefined) {
    fail(`标签 ${tag} 里的 SKILL.md 读不到 metadata.version —— 没有它，标签与副本对不上号。`)
    return
  }
  if (declared !== tag.replace(/^v/, '')) {
    fail(`标签 ${tag} 与它里面 SKILL.md 的 metadata.version「${declared}」不一致 —— 两者必须同号，`
      + '否则用户包副本会以为自己属于另一版。')
  }
  // 来源这一半：取不到可比对的取值时报「未核对」，不静默放行——「没比」与「比过且一致」
  // 必须分得开，否则一个 fork 会把用户包副本指去别人的仓库，而门禁一路绿。
  //
  // **这里是三值比较，不是 `!==`**。写成 `repoPath(a) !== repoPath(b)` 时，两个都认不出
  // 会得到 `undefined !== undefined` = false，即「判为一致」——而「两个都认不出」恰恰是
  // 最需要停下来的时候。`git@host:owner/name` 这种最常见的克隆写法容易漏掉，
  // 于是 fork 比对静默通过。`repoRelation` 让「没法比」必须被显式处理。
  const declaredSource = skillSource(skillText)
  const origin = run(['remote', 'get-url', 'origin'])
  const repo = repoArg ?? (origin.status === 0 ? (origin.stdout ?? '').trim() : undefined)
  if (repo === undefined || repo === '') {
    warn('发版门禁未核对来源：没给 --repo，也读不到 origin —— 标签里声明的 source 是不是'
      + '这次发布的仓库，这次判不了。')
  } else if (declaredSource === undefined) {
    fail(`标签 ${tag} 里的 SKILL.md 读不到 metadata.source —— 压缩包副本会不知道去哪儿找新版。`)
  } else {
    const relation = repoRelation(declaredSource, repo)
    if (relation === 'different') {
      fail(`标签 ${tag} 里声明的来源是 ${declaredSource}，而这次发布的是 ${repo} —— 两者不是同一个`
        + '仓库，用户包副本会跑去别人的仓库更新。改 SKILL.md 的 metadata.source 再发。')
    } else if (relation === 'unknown') {
      warn(`发版门禁未核对来源：声明的 ${declaredSource} 与这次的 ${repo} 里至少有一个`
        + '归一不出 owner/name，没法判断是不是同一个仓库。这是「没比」，不是「比过且一致」。')
    }
  }
  if (failures.length === 0) {
    process.stdout.write(`发版门禁：标签 ${tag} 与它里面的 metadata.version ${declared} 一致`
      + `；来源 ${declaredSource ?? '（未核对）'}\n`)
  }
}

/**
 * 用法错误：**先把话说出来，再退出**。
 *
 * `fail()` 只往 `failures` 里追加，真正打印它的是 `summarize()`；用法错误的路径不经过
 * 汇总，所以直接 `return 2` 等于「打错了，但一个字都不告诉你」——提示白写了，退出码
 * 又只有脚本自己看得懂。这里把已记下的失败原样打印到 stderr，再返回用法错误码。
 */
function usageError(message) {
  fail(message)
  process.stderr.write(`${failures.join('\n')}\n`)
  failures.length = 0
  return 2
}

function usage() {
  return [
    '用法：node scripts/dev/preflight.mjs [--package <清单文件> [--at <版本>] | --release <标签> [--repo <owner/name>]]',
    '',
    '  不带参数：结构自检（引用完整、内核一致、硬性规范、用户包边界、行为自检）。',
    '',
    '  --package <清单文件>  只做一件事：把产出物条目（一行一个，由',
    '                        `git archive <版本> | tar -t` 得到）与文件地图双向核对。',
    '                        由持续集成调用——它看的是真的那份包，不是推算出来的。',
    '  --at <版本>           --package 的搭档：文件地图与文件内容都从这个版本读。',
    '                        判据与对象必须同源，否则核对的是「今天的规矩」与',
    '                        「那天的产出物」，只在发版那天恰好一致。',
    '  --release <标签>      只做一件事：核对标签与它里面 SKILL.md 的 metadata.version 同号，',
    '                        并核对 metadata.source 是不是这次发布的那个仓库。',
    '                        由发布工作流调用（它传 --repo）；不给 --repo 时退回读 origin，',
    '                        两者都取不到就报「未核对」——「没比」不等于「比过且一致」。',
    '  --repo <owner/name>   --release 的搭档：这次发布的仓库。',
    '  --no-behavior         跳过行为自检（约半分钟的那一段），只验结构。',
    '                        报告里会明说「行为判定没有被检查过」——「没查」不装成「查过没有」。',
    '  --only=<标签>[,...]   只跳过三项昂贵且与被测项无关的步骤（脚本静态、脚本实跑、',
    '                        保鲜标记，合计约 3 秒），其余前置检查照跑。',
    '                        这是给测试自己的：每组断言只关心一两项，不该顺带跑全量。',
    '                        写出不认识的标签会直接报错——静默忽略会让测试以为验了，其实没跑。',
    '',
    '  两个模式各只做一件事，做完就退出：它们出现的地方，结构自检已经单独跑过。',
    '  检查对象由脚本自身位置推导（根 = 本文件所在目录的上两级），不接受目录参数。',
    '  退出码 0 = 全绿；1 = 有 FAIL；2 = 脚本自身用法错误。',
    '',
  ].join('\n')
}

function main(argv = []) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage()); return 0 }
  const value = (name) => {
    const i = argv.indexOf(name)
    if (i < 0) return undefined
    const v = argv[i + 1]
    return v === undefined || v.startsWith('--') ? '' : v
  }
  const producedList = value('--package')
  const releaseTag = value('--release')
  const atRef = value('--at')
  const repoArg = value('--repo')
  if (producedList === '' || releaseTag === '' || atRef === '' || repoArg === '') {
    return usageError(`参数缺值。\n${usage()}`)
  }
  const known = new Set(['--package', '--release', '--at', '--repo', '--no-behavior', '--timing', '--only',
    producedList, releaseTag, atRef, repoArg].filter((x) => x !== undefined))
  // `--only=xxx` 是带值形式，按前缀认；精确匹配会把它判成未知参数。
  const unknown = argv.filter((a) => !known.has(a) && !a.startsWith('--only='))
  if (unknown.length > 0) return usageError(`未知参数：${unknown.join(' ')}\n${usage()}`)

  // 两个模式各只做一件事，做完就汇总。它们由持续集成与发布工作流调用，而那里
  // 结构自检已经单独跑过一遍——重复跑一遍只是白花时间，还会让「这一条到底查了什么」
  // 变得说不清。
  //
  // **组合给了就说用法错，不许静默挑一个跑**：`--at` 单独给时被忽略，等于跑完一整趟
  // 结构自检然后以 0 退出——调用方以为核的是那个版本，实际核的是工作区；`--package`
  // 与 `--release` 同时给时先判前者、后者被丢掉，那条发布门禁就白跑了。这类「参数没生效
  // 却报绿」与「没比不等于比过」是同一种错。
  if (producedList !== undefined && releaseTag !== undefined) {
    return usageError(`--package 与 --release 是两件事，一次只能给一个。\n${usage()}`)
  }
  if (atRef !== undefined && producedList === undefined) {
    return usageError(`--at 只与 --package 搭配使用（它说的是「按哪个版本的文件地图核对」）。\n`
      + `只想跑结构自检就不要给 --at。\n${usage()}`)
  }
  if (repoArg !== undefined && releaseTag === undefined) {
    return usageError(`--repo 只与 --release 搭配使用。\n${usage()}`)
  }
  if (producedList !== undefined) { checkProducedPackage(producedList, atRef); return summarize() }
  if (releaseTag !== undefined) { checkReleaseTag(releaseTag, repoArg); return summarize() }

  // 结构检查秒级出结果，行为自检要几分钟——顺序固定成「先快后慢」。改一行注释时，
  // 结构问题会立刻报出来，而不用等那几分钟走完。要更快就加 `--no-behavior`：
  // 它只验结构，并在报告里明说「行为判定没有被检查过」。
  //
  // 每一步都记时间：这份自检有 15 步，而慢的那一步**不是靠眼看能猜出来的**
  // （实测 `脚本实跑` 一步就占掉大半）。分项计时只在 `--timing` 下打印。
  const t0 = Date.now()
  const timings = []
  // `--only=<标签|标签>`：只跑指定的那几步。
  //
  // 这是给**测试自己**用的：每组行为断言只需要它关心的那一两项检查，而完整结构自检
  // 有十六步、其中「脚本实跑」一步就占掉大半。让 [48b] 那组跑八次全量，等于把
  // 同一批无关检查重复八遍——实测它一组就占了全量耗时的四分之一。
  //
  // 没给 --only 时行为完全不变（跑全部）。给了却写出不认识的标签会**直接报错**：
  // 静默忽略会让测试以为自己验了某项，其实那一项根本没跑——那是最坏的假绿。
  // `--only` 的三档语义：
  //
  //   1. 点名的步骤  → 照跑；
  //   2. **昂贵且与被测项无关**的步骤 → 跳过。目前是这三步：
  //        「脚本静态」1.0 秒（解析全部脚本的 import）
  //        「脚本实跑」1.4 秒（每个脚本真跑一遍）
  //        「保鲜标记」0.7 秒（扫全部 references 的核对标记）
  //      合计约 3.1 秒，占全量的九成，而与「落盘族归属」「用户包边界」这类
  //      单项判据毫无关系。
  //   3. 其余**廉价的前置检查** → 照跑（合计不到 0.3 秒）。
  //
  // 第 3 档是必须的：那些步骤判定的是「这个副本本身是不是一个合法的 skill」
  // （目录名、引用的文件在不在、文件地图有没有）。跳过它们，测试就失去上下文——
  // 实测把目录名检查一并跳过时，[48b] 的八条断言全变成「输出里没有期望那句话」，
  // 而真正的原因在几步之前。
  const HEAVY_STEPS = new Set(['脚本静态', '脚本实跑', '保鲜标记'])

  const onlyIdx = argv.findIndex((a) => a.startsWith('--only='))
  const only = onlyIdx >= 0
    ? argv[onlyIdx].slice('--only='.length).split(',').map((s) => s.trim()).filter(Boolean)
    : undefined

  const step = (label, fn) => {
    if (only !== undefined && HEAVY_STEPS.has(label) && !only.includes(label)) return
    const a = Date.now()
    fn()
    timings.push({ label, ms: Date.now() - a })
  }
  let skill
  step('检查 SKILL.md', () => { skill = checkSkillFile() })
  step('SKILL.md 体量', () => checkSkillSize(skill))
  step('引用能否解析', checkReferencesResolve)
  step('reference 结构', checkReferences)
  step('templates', checkTemplates)
step('落盘族引用归属', checkDeliveredAttribution)
  step('内核一致', checkAgentsKernel)
  step('硬性规范', checkGlobalRules)
  step('脚本静态', checkScripts)
  step('脚本实跑', checkScriptsRun)
  step('数量自称', checkStatedCounts)
  step('卡片断言', checkCardClaims)
  step('结构规则一致', checkStructuralRulesAgree)
  step('用户包边界', checkPackageBoundary)
  step('插件专章登记', checkPluginChapters)
  step('本仓库协作模板', checkOwnTemplates)
  step('本仓库发布说明', checkReleaseNotes)
  step('审查规则三处一致', checkReviewRuleSources)
  step('本仓库工作记录', checkWorkRecords)
  step('保鲜标记', checkFreshness)
  step('README 目录', checkReadmeToc)
  step('章节体量', checkChapterSize)
  step('行为自检', () => checkBehavior({ skip: argv.includes('--no-behavior') }))
  // --only 写了不认识的标签必须报错。
  // 静默忽略比不实现更坏：测试会以为自己验了那一项，而它根本没跑。
  if (only !== undefined) {
    const ran = new Set(timings.map((t) => t.label))
    const missing = only.filter((l) => !ran.has(l) && l !== '行为自检')
    if (missing.length > 0) {
      fail(`--only 里有不认识的检查项：${missing.join('、')}。可用项见 --help。`)
    }
  }
  timings.push({ label: '（合计）', ms: Date.now() - t0 })
  if (argv.includes('--timing')) {
    process.stdout.write('\n分项耗时（毫秒）：\n')
    for (const t of timings) process.stdout.write(`  ${String(t.ms).padStart(7)}  ${t.label}\n`)
  }
  // SKILL.md 自己也要有「何时使用」——它要求每份 reference 都写「何时读本文件」，
  // 入口本身不能例外。
  if (skill !== undefined && !/^## 何时使用[ \t]*$/m.test(skill.text)) {
    fail('SKILL.md 缺少二级标题「## 何时使用」—— 入口必须说清什么情况下该用它。')
  }
  return summarize()
}

function summarize() {
  for (const w of warnings) process.stdout.write(`WARN  ${w}\n`)
  for (const f of failures) process.stdout.write(`FAIL  ${f}\n`)
  process.stdout.write(
    `\n自检完成：${failures.length} 项失败，${warnings.length} 项提示`
    + `（目录：${SKILL_ROOT}）\n`,
  )
  return failures.length === 0 ? 0 : 1
}

// 与 survey.mjs 同一模式：直接执行才跑 main，被 import（selftest 测保鲜判据时
// 会 import 本文件）时只取导出的纯函数，不产生副作用。
//
// 判据是**真实路径**比较（survey 的 isMainModule，只此一处实现）：字面比较在经
// junction 或符号链接调用时永不相等，脚本于是什么都不做并返回 0——实测「preflight
// 走 junction」就是 exit 0、零输出，CI 与人都会读成自检通过。
if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main(process.argv.slice(2))