#!/usr/bin/env node
/**
 * review.mjs —— 目标项目交付门禁（P4/P5 是否写完，机器说了算）
 *
 * 存在的理由：P4/P5 的完成标准里只有 AGENTS.md 有机器数（双数字归零），
 * README/双语/徽章/LICENSE/工作流全靠“汇报里写明”——没有机器门的东西，
 * AI 一忙就忘，忘了一点声音都没有。所以这里把“写完”变成可执行的检查：
 *
 *   node scripts/review.mjs <项目目录> [决策 flag...]
 *
 * 状态只有三种：
 *   [齐]   事实已满足；
 *   [缺]   事实缺失且无用户决策 → 退出码 1，必须补；
 *   [待问] 机器判不了，需要问用户 → 问完用对应的 --no-* flag 把答案记下来再跑，
 *           不允许“没问就当不要”。flag 本身就是用户答复的机器载体。
 *
 * 退出码：0 = 无[缺]（默认模式有[待问]也退出 0，结论写明还有待问）；1 = 有[缺]；
 *          2 = 用法错误、勘察失败，或 --strict 拦下[待问]。
 * 只读（会跑 check-badges 联网验徽章；没查完时如实报「未核对」，绝不读成通过）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey, authorMarkers } from './survey.mjs'
import { KERNEL_START, KERNEL_END } from './lib/protocol.mjs'
import { isMainModule } from './lib/text.mjs'
import { markerPositions } from './lib/markdown.mjs'
import { readLedger, writeLedger, getSegment, contentHash, setDecision, forgetDecision, getDecisions, getSnapshot } from './lib/ledger.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 门禁的切面。**只校验本次任务涉及的那几面**，不因为项目别处没配而拦下。
 *
 * 存在的理由：只有「全量」一种口径时，「只让你补一个 LICENSE」的老项目
 * 会被缺 AGENTS.md、缺 README 一起拦死——而那不是本次任务的范围。判据是**这次要交付
 * 什么**，不是**这个项目是否完美**。
 *
 * 默认值（不给 --scope）仍是全量：现有 CI 与既有用法依赖它，改成默认裁剪会静默放走
 * 本来能拦住的问题。
 */
const SCOPES = [
  'git', // 提交署名、上游跟踪、忽略规则（版本管理那一面）
  'agents', // AGENTS.md 与内核
  'docs', // README、双语文档
  'contributing', // CONTRIBUTING
  'license', // LICENSE
  'ci', // 检查自动化
  'release', // 发布自动化与各生态发布门禁
  'badges', // README 徽章
  'secrets', // 凭据、本机路径、大文件、扫描可信度
  'ecosystem', // 生态特有门禁（插件/能力目录/发布清单）
  'collaboration', // 协作基础设施：模板、外部贡献的信任边界
]

const ALL_SCOPES = new Set(SCOPES)

const FLAGS = new Set([
  '--no-bilingual', // 用户确认：单语即可，不要英文版
  '--no-contributing', // 用户确认：自用项目，不要贡献指南
  '--private-no-license', // 用户确认：保留所有权利，不落盘 LICENSE
  '--no-ci', // 用户确认：暂不要 CI
  '--no-auto-release', // 用户确认：暂不要自动发布
  '--secrets-reviewed', // 用户确认：未跟踪未忽略的命中均为占位或测试数据（已入库那一档不在此列）
  '--strict', // 严格模式：待问事项同样拦住（exit 2），用于 CI；默认待问只提示不拦
  // 用户确认：项目里已有的 AI 约定文件保持原样，不因为「多份可能打架」就去改写它们。
  //
  // 为什么需要这个开关：协议说「无对应 flag 的待问只能改文件消掉」，而「多份约定文件」
  // 这条的处置只能是「去对齐那几份」或「确认现状可接受」。不给开关，前一条就变成了
  // 「必须去改使用者手写的约定文件」——那正是协议另一处明令禁止的事。
  '--conventions-reviewed',
  // 用户确认：AGENTS.md 是手写的、且他选择保留原样。
  //
  // 手写契约可能比生成的那份更贴合项目，但它没有内核标记，于是「缺内核」这条会永远
  // 挂着。协议说手写文件默认不动、要升级必须显式 `--upgrade`，两边一夹，交付门禁就成
  // 了一条走不通的路。这个开关的意思是「这份手写文件是有意保留的，不要再判它缺」。
  '--handwritten-agents',
  // 用户确认：发布链路会读说明文件，但这个项目不打算写发版规范（说明的位置与结构
  // 由他自己记着）。存在这个开关，是因为那条待问的另一条出路是「补一份文件」，
  // 而补文件是写别人的项目——不给他「确认现状可接受」的选项，就只剩逼他加一份文档。
  '--no-release-spec',
  // 用户确认：这个项目只有自己一个人改，不要提案模板与问题报告模板。
  // 判据挂在「有远端」上——没有远端就谈不上协作，那种项目不会被问到。
  '--no-collab-templates',
  // 用户确认：项目里已有的提案模板沿用原样，不补「回滚点」「怎么验证」两栏。
  //
  // 存在这个开关，是因为「缺两栏」的另一条出路是「补两栏」——而补两栏是改别人写好的
  // 模板。存量项目自带的模板有自己的栏目设计，硬补齐等于替作者决定审查流程。
  '--pr-template-kept',
  // 用户确认：本项目不发制品库，跳过制品库硬门禁。
  '--no-publish',
  // 自动同步：若契约快照漂移，自动调用 compose-agents.mjs 刷新。
  '--auto-sync',
])

/**
 * 这个文件是不是本 skill 落的（账本里有 `whole` 记录且内容哈希对得上）。
 *
 * 返回 true = 我们落的；false = 不是我们落的（作者自己写的，或他改过）；
 * undefined = 没有账本，判不了——**判不了不能当成「是我们的」**：那会让存量项目
 * 被要求补齐两栏，而它连账本都没有。
 */
function ledgerOwnsFile(root, rel, text) {
  const { ledger, state } = readLedger(root)
  if (state !== 'ok') return undefined
  const seg = getSegment(ledger, rel, 'whole')
  if (seg === undefined) return false
  return contentHash(text) === seg.mine
}

function readText(p) {
  try {
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

function parseArgs(argv) {
  const positional = []
  const flags = new Set()
  /** undefined = 没给 --scope，跑全量（现有 CI 与既有用法依赖这个默认）。 */
  let scope
  let remember
  let forget
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (a.startsWith('--scope=')) {
      const wanted = a.slice('--scope='.length).split(',').map((x) => x.trim()).filter(Boolean)
      if (wanted.length === 0) {
        throw new Error(`--scope= 后面要写切面名（逗号分隔）；可用的有：${[...ALL_SCOPES].join('、')}`)
      }
      const bad = wanted.filter((x) => !ALL_SCOPES.has(x))
      if (bad.length > 0) {
        throw new Error(`--scope 里有不认得的切面：${bad.join('、')}`
          + `（可用的有：${[...ALL_SCOPES].join('、')}）`)
      }
      scope = new Set(wanted)
      continue
    }
    if (a === '--remember' || a.startsWith('--remember=')) {
      const val = a.startsWith('--remember=') ? a.slice('--remember='.length) : argv[++i]
      if (!val) throw new Error('--remember 后面需要指定要固化的决策 flag（例如 --remember --no-bilingual）')
      remember = val.startsWith('--') ? val : `--${val}`
      continue
    }
    if (a === '--forget' || a.startsWith('--forget=')) {
      const val = a.startsWith('--forget=') ? a.slice('--forget='.length) : argv[++i]
      if (!val) throw new Error('--forget 后面需要指定要清除的决策 flag（例如 --forget --no-bilingual）')
      forget = val.startsWith('--') ? val : `--${val}`
      continue
    }
    if (a.startsWith('--')) {
      if (!FLAGS.has(a)) throw new Error(`无法识别的参数：${a}（可用：${[...FLAGS].join('、')}）`)
      flags.add(a)
      continue
    }
    positional.push(a)
  }
  return { target: positional[0] ?? process.cwd(), flags, scope, remember, forget }
}

/**
 * 徽章检查的结论行（check-badges.mjs 输出）与退出码的对应关系。
 *
 * 判定**只认这一行与退出码**，不去嗅探人话：子进程崩掉时（坏 gzip 在未包裹的
 * `res.text()` 上抛 `TypeError: terminated`）输出里一条结论字样都没有，而按文字
 * 嗅探分不清「没有结论」与「没问题」，猜错的方向就是把崩溃读成通过。拿不到结论行、
 * 或结论行与退出码不一致，一律判「没查完」。
 */
const BADGE_STATE_RE = /check-badges: state=(ok|bad|unverified|nobadge)\b/
const BADGE_EXPECT_EXIT = { ok: 0, nobadge: 0, bad: 1, unverified: 3 }

/**
 * 由子进程原始输出与退出码推出徽章结论。纯函数，供 selftest 直接喂数据证伪。
 * 返回 { state, why, bad }：`bad` 是「显示不出来」的那些徽章的逐条明细（结论为空）。
 *
 * `bad` 由**同一行输出**里解析出来：结论要能自证，不能只说「见上文」——跑在子进程里、
 * 日志被截断、只看结论行的时候，读的人手上并没有那段上文。
 */
/**
 * 问题模板缺哪些要素。
 *
 * **两种模板的要求不同，这不是细枝末节**：缺陷报告要「期望 / 实际 / 复现 / 环境」四件事；
 * 需求提案要的是「要解决什么问题 / 期望的行为」。拿缺陷那四件去要求需求模板，会让每一份
 * 需求模板永远显示「缺实际发生什么」——那条提示毫无意义，而一条永远为真的提示等于没有。
 *
 * 分类判据是模板自己的 frontmatter（`name` / `about`），那是作者写给人看的第一句话。
 * **读不出类别时不判**：猜错方向比不判更坏，它会诱导人去改一份本来合格的模板。
 */
export function issueTemplateGaps(text) {
  const head = String(text ?? '').slice(0, 800)
  const isBug = /缺陷|报错|崩溃|不工作|bug|defect|broken/i.test(head)
  const isFeature = /需求|功能|建议|改进|feature|enhancement|proposal/i.test(head)
  if (!isBug && !isFeature) return undefined
  const need = isBug
    ? [
      [/(期望|预期|应该发生|expect)/i, '期望发生什么'],
      [/(实际|报错|错误|崩溃|actual|error)/i, '实际发生什么'],
      [/(复现|重现|步骤|repro)/i, '怎么复现'],
      [/(环境|版本|系统|environment|version)/i, '在什么环境上'],
    ]
    : [
      [/(问题|动机|为什么|背景|problem|motivation|why)/i, '要解决什么问题'],
      [/(期望|结果|行为|用法|expect|result|behavio)/i, '期望的行为或结果'],
    ]
  return { kind: isBug ? 'bug' : 'feature', lacking: need.filter(([re]) => !re.test(text)).map(([, label]) => label) }
}

export function badgeVerdict(stdout, stderr, status) {
  const out = `${stdout ?? ''}\n${stderr ?? ''}`
  const m = BADGE_STATE_RE.exec(out)
  const bad = badBadges(out)
  if (m === null) return { state: 'unverified', why: `子进程没有给出结论行（退出码 ${status}）`, bad: [] }
  if (BADGE_EXPECT_EXIT[m[1]] !== status) {
    return { state: 'unverified', why: `结论行说 ${m[1]}，退出码却是 ${status}`, bad: [] }
  }
  if (m[1] === 'unverified') {
    // 状态自己就叫「未核对」，原因必须说出来——空字符串到了门禁那里会渲染成
    // 「徽章没能查完（）」，一个空括号既没告诉人发生了什么，也没说该怎么补。
    return {
      state: 'unverified',
      why: '网络不可达或请求超时，徽章没能核对（`node scripts/check-badges.mjs` 报的就是未核对）',
      bad,
    }
  }
  return { state: m[1], why: '', bad }
}

/**
 * 从 `check-badges.mjs` 的输出里取「显示不出来」那几行。
 *
 * 认的是它自己的两个记号：一行以「显示不出来」开头（后面跟原因），下一行是缩进的 URL。
 * 认不出来时给空数组——**不猜**：宁可只说「有徽章显示不出来」，也不编一条明细。
 */
function badBadges(out) {
  const lines = out.split('\n')
  const found = []
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\s*显示不出来\s*(.*)$/.exec(lines[i])
    if (m === null) continue
    const url = (lines[i + 1] ?? '').trim()
    const reason = m[1].trim()
    found.push(url === '' ? reason : `${reason}（${url}）`)
  }
  return found
}

/**
 * 凭据命中按处置分档。纯函数，供 selftest 直接喂数据证伪。
 *
 * 判据来自版本管理那套分案（version-control.md 的密钥门控、SKILL.md 的 G2）：
 *   tracked=true               → blocking（已在版本库里，只能移除并轮换）
 *   tracked=false, ignored=true→ safe（不进版本库；这是 .gitignore 里 .env 的正常形态）
 *   tracked=false, ignored≠true→ blocking（`git add -A` 会把它带进去）
 * 注意 `ignored` 为 undefined 时按「未忽略」处理——没证据就当没被忽略，
 * 免得勘察拿不到忽略比特时这里悄悄放行。
 */
export function tierSecrets(hits) {
  const list = Array.isArray(hits) ? hits : []
  const tracked = list.filter((h) => h.tracked === true)
  const safe = list.filter((h) => h.tracked !== true && h.ignored === true)
  const exposed = list.filter((h) => h.tracked !== true && h.ignored !== true)
  // 保守方向：读不到仍按最坏情况算进 blocking——凭据误信「未忽略」就等于把它提交进
  // 历史，而拦下来只是多看一眼。但**报告文案不能陈述一个没验证过的事实**：把读不到
  // 的那批与「读到确实没忽略」分开，前者要的处置是手工核对，后者才是加 flag。
  const unknown = exposed.filter((h) => h.tracked === undefined || h.ignored === undefined)
  const confirmed = exposed.filter((h) => h.tracked !== undefined && h.ignored !== undefined)
  return { tracked, safe, exposed, unknown, confirmed, blocking: [...tracked, ...exposed] }
}

/**
 * 三态比特的分档。`true` / `false` / `undefined`（读不到）的正确处置各不相同：
 * 读到的可以按事实判，读不到的必须让人**手工核对**。并进 `false` 会让人对一个没
 * 验证过的判断采取行动，方向还可能是反的。
 *
 * 只负责分开数。保守方向由调用点自己定——凭据那边偏严、私有路径那边偏松。
 */
function splitTri(list, bit) {
  const arr = Array.isArray(list) ? list : []
  return {
    yes: arr.filter((h) => bit(h) === true),
    no: arr.filter((h) => bit(h) === false),
    unknown: arr.filter((h) => bit(h) === undefined),
  }
}

/**
 * 契约里「作者自己写的那部分」——内核标记之外的正文。
 *
 * 注入的内核由 `templates/agents-kernel.md` 独占，它自带「远端」「发布」「版本」这些词。
 * 判「这份契约有没有写清远端与发版」时若按全文判，内核会替作者答上来，判据于是恒真。
 * 没有结束标记时（手写文件）返回全文——那时没有内核可依赖，全文就是作者的部分。
 *
 * **位置要按围栏之外的那一个算**：在文档里用代码块展示这对标记是正常写法，而两个
 * 朴素写法都错——`indexOf` 会命中展示用的那份，于是「内核之外」变成「内核正文」，
 * 内核里的「远端」「发布」把这条判据顶成恒真；`includes` 则会把「展示过标记」读成
 * 「有内核」。位置判定只有一处实现（`lib/markdown.mjs` 的 `markerPositions`），这里引用它。
 */
export function outsideKernel(text) {
  const s = String(text ?? '')
  const ends = markerPositions(s, KERNEL_END)
  if (ends.length === 0) return s
  const at = ends[ends.length - 1]
  return s.slice(at + KERNEL_END.length)
}

/** 这份契约有没有内核（只看围栏之外的那一对标记）。 */
function hasKernel(text) {
  const s = String(text ?? '')
  return markerPositions(s, KERNEL_START).length > 0 && markerPositions(s, KERNEL_END).length > 0
}

/**
 * 这个门禁**已经消费**的风险类别。新增一类风险时，这里与下面的处理必须一起加：
 * 只加 survey 的字段、不在门禁里落结论，新类别就会悄悄没人管（下一个维护者
 * 一定会忘）。所以判据不是「这里有没有写」，而是「survey 报的每个键都在这个集合里」，
 * 缺一个就报「未处理的风险类别」——由 unhandledRiskKeys 兜底。
 */
export const HANDLED_RISK_KEYS = new Set([
  'secretFiles', 'secretContent', 'contentScan', 'homePathLeaks', 'largeFiles', 'symlinks', 'nestedRepos',
])

/** 勘察报了、但门禁没有落结论的风险类别。纯函数，供 selftest 直接喂数据证伪。 */
export function unhandledRiskKeys(risks) {
  return Object.keys(risks ?? {}).filter((key) => !HANDLED_RISK_KEYS.has(key))
}

/**
 * 徽章检查子进程的上限：**到点就杀掉**，不让交付门禁挂死。
 *
 * 为什么必须有：徽章检查要联网，而网络有黑洞——服务器接受连接却永不回应时，
 * 子进程会一直等下去，门禁也跟着一直等下去。纯离线是快速失败，代理黑洞不是。
 * 门禁挂死比门禁报错坏得多：报错时人会去查，挂死时人只会等。
 *
 * 与子进程自己的预算比：check-badges.mjs 给单次请求 8 秒、整轮 25 秒，所以它自己
 * 会在 25 秒左右退出。这一层是**兜底**——子进程因为自身预算之外的原因卡住时
 * （DNS 解析挂在预算之外、子进程启动就卡住），门禁仍然要有终点。因此留足余量：
 * 比子进程的整轮预算大得多，余量用来容忍慢机器上的启动与收尾开销。
 */
const BADGE_CHECK_TIMEOUT_MS = 45000

/**
 * 子进程没给出结论时的结论。纯函数，供自检直接喂数据证伪。
 *
 * `status === null` 就是**被终止**（超时杀掉，或压根没起来）：结论行取不到，
 * 归入「未核对」——**不是失败，也不是假装通过**。这正是「没查完」该有的样子。
 */
export function badgeSubprocessVerdict(result, timeoutMs) {
  const r = result ?? {}
  if (r.status === null || r.status === undefined) {
    return {
      state: 'unverified',
      why: `徽章检查在 ${Math.round(timeoutMs / 1000)} 秒内没有结束，已终止`
        + '（多半是网络黑洞，不是徽章坏了）',
      bad: [],
    }
  }
  return badgeVerdict(r.stdout, r.stderr, r.status)
}

/** 跑徽章检查。返回 ok / bad / unverified / nobadge 四态，不抛错。 */
function checkBadges(root, readmes) {
  if (readmes.length === 0) return { state: 'nobadge' }
  const r = spawnSync(process.execPath, [join(HERE, 'check-badges.mjs'),
    ...readmes.map((f) => join(root, f))], { encoding: 'utf8', timeout: BADGE_CHECK_TIMEOUT_MS })
  return badgeSubprocessVerdict(r, BADGE_CHECK_TIMEOUT_MS)
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write([
      '用法：node scripts/review.mjs <项目目录> [--scope=<切面>[,...]] [选项]',
      '',
      '  --scope=a,b   只校验这几面，其余不查、不报缺。不给就是全量（默认）。',
      '                切面：git agents docs contributing license ci release badges secrets ecosystem collaboration',
      '                用在「只让你补一件东西」的场景：老项目缺 AGENTS.md，',
      '                但任务只是配 CI 时，--scope=ci 不该被前者拦下。',
      '',
      '  --no-bilingual         用户确认：单语即可',
      '  --no-contributing      用户确认：自用项目，不要贡献指南',
      '  --private-no-license   用户确认：保留所有权利，不落盘 LICENSE',
      '  --no-ci                用户确认：暂不要 CI',
      '  --no-auto-release      用户确认：暂不要自动发布',
      '  --no-publish           用户确认：暂不发制品库，跳过制品库硬门禁',
      '  --secrets-reviewed     用户确认：未跟踪未忽略的命中均为占位或测试数据',
      '  --conventions-reviewed 用户确认：多份 AI 约定文件保持原样，不去改写它们',
      '  --handwritten-agents   用户确认：AGENTS.md 是有意手写的，不注入内核',
      '  --no-release-spec      用户确认：发布链路读说明文件，但不打算写发版规范',
      '  --no-collab-templates  用户确认：这个项目只有自己改，不要提案与问题报告模板',
      '  --pr-template-kept     用户确认：项目里已有的提案模板沿用原样',
      '  --auto-sync            若检测到项目事实与 AGENTS.md 生成快照漂移，自动调用 compose-agents 刷新',
      '  --remember <flag>      将决策 flag 固化至 .project-forge/ledger.json 账本中持久生效',
      '  --forget <flag>        从账本中移除已固化的决策 flag',
      '  --strict               严格模式：待问事项同样拦住（exit 2），用于 CI',
      '',
      '  退出码：0 = 无[缺]（默认下[待问]也放行）；1 = 有[缺]；2 = 用法错误或 --strict 拦下[待问]。',
      '  已经进了版本库的凭据改文件不解决，任何 flag 都不消那一档——从索引移除并轮换。',
    ].join('\n') + '\n')
    return 0
  }
  const { target, flags, scope, remember, forget } = parsed
  const root = resolve(target)

  if (remember) {
    if (!FLAGS.has(remember)) {
      process.stderr.write(`错误：无法识别要固化的决策：${remember}（可用：${[...FLAGS].join('、')}）\n`)
      return 2
    }
    const { ledger } = readLedger(root)
    setDecision(ledger, remember, true)
    writeLedger(root, ledger)
    process.stdout.write(`已将决策记入账本：${remember}\n`)
    return 0
  }
  if (forget) {
    const { ledger } = readLedger(root)
    forgetDecision(ledger, forget)
    writeLedger(root, ledger)
    process.stdout.write(`已从账本清除决策：${forget}\n`)
    return 0
  }

  // 从账本读取持久化决策
  const { ledger } = readLedger(root)
  const savedDecisions = getDecisions(ledger)
  const loadedFromLedger = []
  for (const [k, v] of Object.entries(savedDecisions ?? {})) {
    if (v === true && FLAGS.has(k) && !flags.has(k)) {
      flags.add(k)
      loadedFromLedger.push(k)
    }
  }

  /**
   * 这一面要不要查。不给 `--scope` 时永远为真（全量门禁）。
   *
   * 判据是**这次要交付什么**，不是**这个项目是否完美**：用户说「帮我补个 LICENSE」，
   * 缺 README 不在范围内，不该把他拦在这道门外。
   */
  const wants = (face) => scope === undefined || scope.has(face)

  let s
  try {
    s = survey(root)
  } catch (error) {
    process.stderr.write(`勘察失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  // 多面共用的派生事实：提交署名、上游、忽略规则读 git；凭据、私有路径、
  // 大文件读 risks。声明在段外，避免被某个 scope 块关在里面而在别处变成
  // ReferenceError——那正是「按需裁剪」最容易引入的一类错。
  const git = s.git ?? {}
  const risks = s.risks ?? {}
  // README 列表归文档面定义，徽章面要拿它去验——两段共用一个事实，声明在段外。
  const readmes = s.docs?.readme ?? []
  // AGENTS.md 的正文归 agents 面读，发布面要拿它核对「内核之外有没有写清怎么推、怎么发版」。
  const agentsPath = join(root, 'AGENTS.md')
  const agents = readText(agentsPath)

  const missing = []
  const pending = []
  const ok = []
  const line = (st, text) => process.stdout.write(`  [${st}] ${text}\n`)
  // 这是别人的仓库：维护者那一侧的判据（发布自动化、发版规范）不适用——贡献者没有权限也
  // 没有责任去配它们。只对**明确证据**（声明仓库不同 / upstream 不同）生效，`undetermined`
  // 不走这条路：那会让一个其实自己是维护者的项目静默少查一整套。
  const forkMode = s.git?.role === 'contributor-fork'
  process.stdout.write(`交付门禁：${s.target.name}（${s.target.path}）\n`)

  if (loadedFromLedger.length > 0) {
    process.stdout.write(`  [齐] 已从账本自动加载决策：${loadedFromLedger.join('、')}\n`)
  }

  // 契约快照漂移检测
  const snapshot = getSnapshot(ledger)
  if (snapshot !== undefined) {
    const currentCommandsKey = Object.entries(s.commands ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}:${v}`)
      .join(';')
    const currentHasRemote = typeof s.git?.remote === 'string' && s.git.remote.length > 0
    const currentHasPublish = s.artifacts?.publishableManifest !== undefined

    const drifts = []
    if (snapshot.hasRemote !== undefined && snapshot.hasRemote !== currentHasRemote) {
      drifts.push(`远端状态变更（快照: ${snapshot.hasRemote ? '有' : '无'}, 当前: ${currentHasRemote ? '有' : '无'}）`)
    }
    if (snapshot.hasPublish !== undefined && snapshot.hasPublish !== currentHasPublish) {
      drifts.push(`发布属性变更（快照: ${snapshot.hasPublish ? '可发布' : '不可发布'}, 当前: ${currentHasPublish ? '可发布' : '不可发布'}）`)
    }
    if (snapshot.commandsKey !== undefined && snapshot.commandsKey !== currentCommandsKey) {
      drifts.push('验证/构建命令变更')
    }
    if (drifts.length > 0) {
      if (flags.has('--auto-sync')) {
        process.stdout.write(`  [齐] 检测到契约快照漂移（${drifts.join('、')}），已触发 --auto-sync 自动同步 AGENTS.md...\n`)
        const syncRes = spawnSync(process.execPath, [join(HERE, 'compose-agents.mjs'), root], { encoding: 'utf8' })
        if (syncRes.status === 0) {
          process.stdout.write('  [齐] AGENTS.md 契约自动同步完成\n')
        } else {
          missing.push(`AGENTS.md 契约自动同步失败：${syncRes.stderr || syncRes.stdout}`)
        }
      } else {
        pending.push(`项目现状与 AGENTS.md 生成快照漂移（${drifts.join('、')}）：建议执行 node scripts/compose-agents.mjs . 同步，或在 review 时传 --auto-sync`)
      }
    }
  }

  if (wants('agents')) { // scope: agents
  // 1. AGENTS.md：一致性真相源是 compose --check 的字节比对，本门只转述。
  // 自己另起一套“有标记即一致”必然漂移其一，故不自判，只调用。
  if (agents === undefined) {
    missing.push('AGENTS.md 缺失')
  } else {
    // 待填写的数法**只有一处实现**：survey 导出的 authorMarkers（整篇扫描）。
    // 若两处各写一份扫描（一个逐行、一个整篇），同一份文件在多行标记下会得到
    // 两个互相矛盾的结论——所以数法必须共用这一份。
    const authors = authorMarkers(agents).length
    const kernel = hasKernel(agents)
    if (!kernel) {
      // 手写契约可能比生成的那份更贴合项目。协议说这类文件默认不动、要升级必须显式
      // --upgrade，所以「缺内核」不能是一条无论如何都消不掉的缺——那会把交付门禁变成
      // 一条走不通的路，而走不通的门禁最后一定会被绕过。
      if (flags.has('--handwritten-agents')) ok.push('AGENTS.md 是手写的（已确认保留原样，不注入内核）')
      else pending.push('AGENTS.md 缺少内核标记：跑 compose-agents 生成或升级；'
        + '若这份是有意手写并保留的，加 --handwritten-agents')
    } else if (authors > 0) {
      missing.push(`AGENTS.md 待填写 ${authors} 处（读代码填实，删标记）`)
    } else {
      const cc = spawnSync(process.execPath, [join(HERE, 'compose-agents.mjs'), root, '--check'],
        { encoding: 'utf8' })
      const ccOut = `${cc.stdout ?? ''}\n${cc.stderr ?? ''}`
      if (cc.status !== 0) {
        const first = ccOut.split('\n').map((l) => l.trim()).filter(Boolean)
          .find((l) => /缺失|不一致/.test(l)) ?? '与模板不一致或有缺节'
        missing.push(`AGENTS.md 未通过 compose --check：${first}（跑 compose-agents 补齐重验）`)
      } else {
        ok.push('AGENTS.md 通过 compose --check（内核一致、待填写归零）')
      }
    }
  }

  } // scope: agents
  if (wants('git')) { // scope: git
  // 2. 提交署名：没有仓库时跳过（P3 建库时再定）；有仓库而署名缺失必须补——
  // 否则首个提交永久带着错误署名。占位值靠人眼（G7），机器只卡缺失。
  // 目录里没有仓库时，git 面**没有可验的对象**。不能说「齐备」——那是把
  // 「没查」说成「查过没问题」。报一项待问，让调用方知道这一面没被覆盖。
  if (git.present !== true && scope !== undefined && scope.has('git')) {
    pending.push('这个目录不是 git 仓库——版本管理这一面没有可验的对象（先 git init，或去掉 --scope=git）')
  }
  if (git.present === true) {
    const id = git.identity ?? {}
    if (!id.name || !id.email) {
      missing.push('提交署名缺失（只写仓库级，见版本管理署名审计清单）')
    } else {
      // 层级有四种取值：local / global / system / unset。只报「仓库级 / 继承全局」会让
      // system 层的来源看起来像「哪里都没设」——而全局工具的安装器恰恰常写在那里。
      const scopeLabel = id.scope === 'local' ? '仓库级'
        : id.scope === 'unset' || id.scope === undefined ? '来源未知'
          : `继承自 ${id.scope}`
      ok.push(`提交署名有（${id.name}，${scopeLabel}；占位值须人眼确认）`)
    }
    // **本地齐备不等于远端齐备。** P5 的顺序是「推送 → 回跑 compose 补远端节 → 落盘 CI」，
    // 后两步发生在推送之后；不补一次提交推送，远端就永远缺它们，而本地看上去一切正常。
    // 这两个事实勘察早就采到了（`dirty` / `ahead`），只是没人用——「产出了但没消费」
    // 与「没有这个能力」在报告上长得一模一样。
    //
    // 它们是**待问**不是缺：本地有未提交改动，可能是使用者正在写；而领先上游若干个提交，
    // 可能是有意攒着。机器判不了「该不该现在推」，但它必须说出来。
    if (typeof git.dirty === 'number' && git.dirty > 0) {
      pending.push(`工作区有 ${git.dirty} 处未提交的改动：它们不在远端，别人装上就缺这些`
        + '。确认是有意暂存时不必处理，否则先提交（P5 落盘 CI 与回跑契约之后尤其要记得再推一次）')
    }
    if (typeof git.ahead === 'number' && git.ahead > 0 && git.upstream !== undefined) {
      pending.push(`本地领先上游 ${git.ahead} 个提交，还没有推：远端仓库缺这些改动`
        + '（P7 说「已交付」之前先 push，并回读远端分支确认）')
    }
  }

  } // scope: git
  if (wants('git')) { // scope: git
  // 2b. 上游跟踪：有远端而未设跟踪时，首推需显式指定。只提示，不阻断。
  if (git.present === true && typeof git.remote === 'string' && git.remote.length > 0
    && git.upstream === undefined && git.isRepoRoot !== false) {
    pending.push('上游跟踪未设置：首推用显式分支并设跟踪（改文件消不掉，推一次即有）')
  }

  // 2b-1. 推送认证：**有远端地址不等于能推上去**，这是两条独立的事实。
  //
  // 判据直接读勘察产出的 `git.auth`，不在这里重新推断——两处各推一次，迟早给出两种答案。
  // 三档的落点各不相同，尤其是 `undetermined`：把「没问出来」报成「缺失」，正是那次
  // 「明明有凭据却说没有」的机器版本，会让用户去做一件完全没必要做的事。
  if (git.present === true && typeof git.remote === 'string' && git.remote.length > 0
    && git.isRepoRoot !== false) {
    const auth = git.auth ?? {}
    // 判据读**归一后的 `transport`**，不再读只覆盖 HTTPS 的 `https`：SSH 远端在
    // `https` 上恒为 `n/a`，于是用 SSH 的项目永远落进「未确认」那一档、永远挂着一条
    // 待问，且没有任何开关能消掉它——严谨退化成一条走不通的路。
    if (auth.transport === 'ok') {
      const how = auth.protocol === 'ssh'
        ? `SSH 密钥（${auth.sshReason ?? '本机已配'}）`
        : `凭据助手 ${auth.helper ?? '未声明'}，${auth.helperScope ?? '层级未知'}`
      ok.push(`推送认证可用（${how}）`)
    } else if (auth.transport === 'no-credential') {
      missing.push('推送认证取不到凭据：配好之后重跑（这是唯一需要用户动手的一档）'
        + (auth.transportReason !== undefined ? `：${auth.transportReason}` : ''))
    } else if (auth.transport !== 'n/a') {
      pending.push('推送认证未确认：不要据此断言「没有凭据」'
        + (auth.transportReason !== undefined ? `（${auth.transportReason}）` : '')
        + '。SSH 远端加 --probe-network 再跑一次能定论')
    }
    // 轨道 B 单独报：**能推代码不等于能调平台 API**。两者的凭据来源完全不同，
    // 混成一句会让「SSH 推得通、但没有任何令牌」的机器被读成「一切就绪」。
    //
    // 但**本机没有令牌不等于交付不完整**：发布跑在持续集成里时，用的是仓库 Secrets
    // 里那份令牌，与本机登录状态无关。把这种情况报成待问，会让每一个「发布交给 CI」
    // 的项目永远挂一条消不掉的待问——而那种配置恰恰是推荐配置。
    const ci = s.docs?.workflowAutomation ?? {}
    const releasesInCi = ci.hasReleaseJob === true && ci.usesSecrets === true
    if (auth.gh === 'authenticated' || (auth.gh === 'missing' && auth.envToken === true)) {
      ok.push(`平台 API 凭据有（${auth.gh === 'authenticated' ? 'gh 已登录' : '环境里有令牌'}）`)
    } else if (releasesInCi) {
      ok.push('平台 API 凭据不在本机：发布走持续集成，用的是仓库 Secrets 里那份'
        + '（本机不需要登录，这是推荐配置）')
    } else if (auth.gh === 'unauthenticated' && auth.envToken !== true) {
      pending.push('平台 API 凭据没有：建仓库、发 Release、读 issue 都要它'
        + '（gh auth login 一次，或配 GH_TOKEN；只推代码的话不必现在处理）')
    }
    // 网络不可达时单独说，因为此时凭据状态本来就不可知——两件事混在一起会导向错误的处置。
    if (auth.network === 'unreachable') {
      pending.push(`远端当前不可达（${auth.networkReason ?? '原因未识别'}）：`
        + '先解决网络，此时不要碰凭据——网络不通时凭据状态不可知')
    }
  }

  // 2b-2. 「P5 之后强制回跑 P4」这条规则需要一个机器落点：没有它，有远端却与发布无关的
  // 契约照样交付，用户拿到的 AGENTS.md 永远缺发布那半部分。判据是**事实 + 文本**
  // 两条都有：有远端（`git.remote` 非空）时，契约里必须提到远端与发布/标签——
  // 否则那次回跑没做。中英文都认，避免语言假设。
  //
  // 只看**内核标记之外**的正文。注入的内核自带「远端」「发布」这些词（「本文件的定位
  // 与编辑规则」那张表、还有「最小可用…不为未来需求提版本」里的「版本」），按全文判
  // 等于拿内核给自己作证：一份删到只剩内核的契约照样通过，这条检查对每一个由本
  // skill 生成的项目都是死代码，而它本该是这条规则唯一的机器落点。
  if (git.present === true && typeof git.remote === 'string' && git.remote.length > 0
    && git.isRepoRoot !== false && agents !== undefined) {
    const body = outsideKernel(agents)
    const hasRemoteText = /远端|remote|origin|推送|push/i.test(body)
    const hasReleaseText = /发布|release|标签|tag/i.test(body)
    if (!hasRemoteText || !hasReleaseText) {
      const lack = [!hasRemoteText ? '远端/推送' : null, !hasReleaseText ? '发布/标签' : null]
        .filter((x) => x !== null).join('与')
      missing.push(`AGENTS.md 的内核之外缺${lack}部分（有远端就必须写清怎么推、怎么发版：`
        + 'P5 之后要回跑 P4 的 compose-agents）')
    }
  }

  } // scope: git
  if (wants('release')) { // scope: release
  // 2c. 标签与版本号：只报事实比对，不下结论（形生态各异，见 publish.md）。
  if (s.artifacts?.declaredVersion !== undefined && s.artifacts?.versionAligned === false) {
    pending.push(`标签与版本号未对齐：清单 ${s.artifacts.declaredVersion}，标签 ${(s.artifacts.versionAlignedTags ?? []).join('、') || '无'}（自动化会对不上，先确认）`)
  }

  // 2c-1. 多个 AI 宿主的约定文件并存：报出来，并提醒先对齐。
  //
  // 这件事没有机器能判对错——两份约定说的是同一件事却给了不同答案时，谁赢取决于宿主
  // 实现，不取决于哪份更权威。而本 skill 生成的那份**看起来最正式、最长、还带内核**，
  // 于是矛盾会被永久留在项目里，谁也不知道该信哪个。所以至少要让使用者知道它存在。
  const conv = s.docs?.aiConventions
  if (Array.isArray(conv) && conv.length > 1) {
    if (flags.has('--conventions-reviewed')) {
      ok.push(`有 ${conv.length} 份 AI 约定文件（已确认保留原样：${conv.map((c) => c.file).join('、')}）`)
    } else {
      pending.push(`这个项目有 ${conv.length} 份 AI 约定文件（${conv.map((c) => c.file).join('、')}）：`
        + '落盘前先对齐它们说的是不是同一件事——否则新生成的那份看起来最权威，矛盾会被留下来'
        + '。确认现状可接受时加 --conventions-reviewed')
    }
  }

  } // scope: release
  if (wants('secrets')) { // scope: secrets
  // 2d. 密钥与扫描可信度。**按分案判，不一律报缺**（判据与 version-control.md 的
  // 密钥门控同源，SKILL.md 的 G2 也写「未跟踪排除、已历史轮换、占位继续」）：
  //   - 已跟踪（已经在版本库里）→ 缺：只能从索引移除并轮换凭据；
  //   - 未跟踪且**已被忽略** → 报「齐」：这是最常见的正常形态（.gitignore 里的 .env），
  //     一律报缺会把门禁变成噪音，操作者的对策就是条件反射式加 flag——安全信号被稀释；
  //   - 未跟踪且未被忽略 → 缺：`git add -A` 会把它带进历史。
  const secretHits = [...(risks.secretFiles ?? []), ...(risks.secretContent ?? [])]
  const secretTiers = tierSecrets(secretHits)
  // flag 的效力按**处置档**分开：`--secrets-reviewed` 的语义是「这一处是占位或测试数据」，
  // 而「已经进了版本库」不在这个语义里——那一档的处置是从索引移除并轮换，没有「确认一下
  // 就算了」这个选项。所以它只覆盖 `exposed`（未跟踪未忽略），`tracked` 永不被 flag 消。
  // 否则一个 flag 就能把「凭据已写进 git 历史」读成「全部齐备」，纪律挡不住机制缺失。
  if (secretTiers.confirmed.length > 0) {
    if (flags.has('--secrets-reviewed')) {
      ok.push(`未跟踪未忽略的凭据 ${secretTiers.confirmed.length} 处已确认为占位或测试数据（不进版本库）`)
    } else {
      missing.push(`凭据形状 ${secretTiers.confirmed.length} 处（未跟踪且未忽略，下次提交会带进历史；`
        + '确认为占位或测试数据时加 --secrets-reviewed，位置见勘察报告）')
    }
  }
  if (secretTiers.unknown.length > 0) {
    missing.push(`凭据形状 ${secretTiers.unknown.length} 处无法确认是否已入库或被忽略（受控文件清单没取到，`
      + '常见于仓库过大或版本控制不可用）：已按最坏情况拦下，但**先手工核对再处置**——'
      + '加 --secrets-reviewed 会消掉一个可能真的没问题的项，也可能放走一个真的会进历史的项')
  }
  if (secretTiers.tracked.length > 0) {
    missing.push(`凭据形状 ${secretTiers.tracked.length} 处已在版本库里（git 历史已含它，`
      + '改文件不解决问题）：从索引移除并轮换该凭据后重跑；这不是 flag 能消的一项')
  }
  if (secretTiers.safe.length > 0) {
    ok.push(`未跟踪且已被忽略的敏感文件 ${secretTiers.safe.length} 处（不进版本库就不拦；确认忽略规则真的覆盖它们）`)
  }
  // 扫描覆盖：**「没扫到」必须与「扫过没命中」可区分**。截断、超体积、扩展名黑名单、
  // 读失败、非 UTF-8——五类都进这一条，任何一类非零都要问一句，不能读成干净。
  const scan = risks.contentScan ?? {}
  const uncovered = []
  if (scan.truncated === true) uncovered.push('文件数达上限被截断')
  if (typeof scan.skippedLarge === 'number' && scan.skippedLarge > 0) uncovered.push(`${scan.skippedLarge} 个文件超过单文件上限未扫`)
  if (typeof scan.skippedByExtension === 'number' && scan.skippedByExtension > 0) uncovered.push(`${scan.skippedByExtension} 个文件按扩展名跳过`)
  if (typeof scan.unreadable === 'number' && scan.unreadable > 0) uncovered.push(`${scan.unreadable} 个文件读不出来（权限或占用）`)
  if (typeof scan.notUtf8 === 'number' && scan.notUtf8 > 0) uncovered.push(`${scan.notUtf8} 个文件不是 UTF-8（编码未嗅探）`)
  if (typeof scan.depthLimited === 'number' && scan.depthLimited > 0) uncovered.push(`${scan.depthLimited} 个子目录因嵌套过深未进入`)
  if (uncovered.length > 0) {
    pending.push(`内容扫描有未覆盖范围（${uncovered.join('；')}）——“无命中”不可信，写明覆盖范围或提高上限重扫`)
  }

  // 2d-2. 其余风险类别：**逐类落结论，不许沉默**。
  // 这里做成表驱动并带兜底：勘察将来新增一类风险而这里没处理，下面那条兜底会把它
  // 报成待问——「加了字段但没人消费」不会再悄悄发生。
  for (const key of unhandledRiskKeys(risks)) {
    pending.push(`勘察报了未处理的风险类别「${key}」：新类别必须在交付门禁里落一个结论（缺 / 待问），不能沉默`)
  }
  const allLeaks = (risks.homePathLeaks ?? []).filter((h) => h.kind === 'leak')
  // 已被忽略规则覆盖的本机路径不进版本库：与凭据同一分案，报事实但不拦。
  // 否则一个只在本机存在、且已忽略的状态文件（工具生成的那种）会让门禁永远叫喊。
  // 读不到忽略状态时归「待问」而不是「缺」：路径本身确实该改，但**是否已经暴露**
  // 是没验证过的，不该用「缺」这种断言语气。
  const leakBits = splitTri(allLeaks, (h) => h.ignored)
  if (leakBits.no.length > 0) {
    missing.push(`本机私有路径 ${leakBits.no.length} 处（换台机器就失准，也可能已经暴露了目录结构；改成相对路径或环境变量）`)
  }
  if (leakBits.yes.length > 0) {
    pending.push(`本机私有路径 ${leakBits.yes.length} 处已被忽略规则覆盖（不进版本库；确认忽略规则真的覆盖它们）`)
  }
  if (leakBits.unknown.length > 0) {
    pending.push(`本机私有路径 ${leakBits.unknown.length} 处无法确认是否已被忽略规则覆盖（请手工核对；改法同上）`)
  }
  const big = splitTri(risks.largeFiles, (f) => f.tracked)
  if (big.yes.length > 0) {
    missing.push(`已在版本库里的大文件 ${big.yes.length} 个（≥20MB，克隆与历史都会长期承担；先确认该不该入库）`)
  }
  if (big.no.length > 0) {
    pending.push(`未跟踪的大文件 ${big.no.length} 个（≥20MB；提交前先决定忽略还是入库）`)
  }
  if (big.unknown.length > 0) {
    pending.push(`大文件 ${big.unknown.length} 个无法确认是否已入库（受控文件清单没取到；请手工核对）`)
  }
  if (Array.isArray(risks.symlinks) && risks.symlinks.length > 0) {
    pending.push(`符号链接目录 ${risks.symlinks.length} 个未进入扫描（链接指向仓库外时不该扫；确认里面没有该查的东西）`)
  }
  if (Array.isArray(risks.nestedRepos) && risks.nestedRepos.length > 0) {
    pending.push(`嵌套仓库 ${risks.nestedRepos.length} 个（子目录里另有 .git；确认是有意为之，否则它不会被外层仓库跟踪）`)
  }

  } // scope: secrets
  if (wants('git')) { // scope: git
  // 2e. 忽略规则：未忽略的产物目录与“已跟踪又被忽略”是提交前必须消掉的两项。
  const ig = s.ignores ?? {}
  if (Array.isArray(ig.unignoredOutputDirs) && ig.unignoredOutputDirs.length > 0) {
    missing.push(`未忽略的产物目录：${ig.unignoredOutputDirs.join('、')}（下次提交会整个写进历史，先补忽略规则）`)
  }
  if (Array.isArray(ig.ignoredButTracked) && ig.ignoredButTracked.length > 0) {
    pending.push(`已被跟踪又被忽略 ${ig.ignoredButTracked.length} 个（忽略对它们无效，需从索引移除；确认后逐个处理）`)
  }
  if (ig.gitattributes === undefined && git.present === true) {
    pending.push('文本属性声明缺失：首次提交前补上，否则跨机器产物字节不可复现')
  }
  } // scope: git
  if (wants('docs')) { // scope: docs
  // 3. README：必须有；双语要么成对，要么用户明确说单语。
  if (readmes.length === 0) {
    missing.push('README 缺失')
  } else {
    ok.push(`README 有（${readmes.join('、')}）`)
    if (s.docs?.readmePair !== undefined) ok.push('双语 README 成对')
    else if (flags.has('--no-bilingual')) ok.push('单语（用户已确认不要英文版）')
    else pending.push('双语：只有一份 README，问用户要不要英文版（要→补，不要→加 --no-bilingual）')
  }

  } // scope: docs
  if (wants('badges')) { // scope: badges
  // 4. 徽章：有就必须验（联网跑 check-badges）；没有徽章不强求。
  // 「没查完」与「查过且可显示」是两回事——第三态走待问，绝不并进齐。
  //
  // 逐条明细**直接写进这一行**：只写「见上文输出」时，读的人手上未必有那份输出
  // （跑在子进程里、日志被截断、报告只看结论行），而他要的正是「哪一个徽章坏了」。
  const badgeResult = checkBadges(root, readmes)
  if (badgeResult.state === 'bad') {
    const which = badgeResult.bad?.length > 0 ? `：${badgeResult.bad.join('；')}` : ''
    missing.push(`徽章显示不出来${which}（删掉或修好）`)
  } else if (badgeResult.state === 'unverified') {
    pending.push(`徽章没能查完（${badgeResult.why}）：在汇报里写明未验及原因，不要读成通过`)
  } else ok.push(badgeResult.state === 'ok' ? '徽章全部可显示' : '无徽章（可选，不强求）')

  } // scope: badges
  if (wants('contributing')) { // scope: contributing
  // 5. CONTRIBUTING / LICENSE：缺了必须问，不能默跳；有了要看内容是否齐全。
  //
  // 内容判据**必须语言无关**：写 CONTRIBUTING 的人用哪种语言是他的自由，而门禁
  // 用中文关键词会让一份合格的英文贡献指南被判三处缺（实测过），于是「合格产物
  // 过不了门」——那比不判更坏。所以每条判据都同时认中英文，且大小写不敏感；
  // 只与项目约定有关的指向（例如 AGENTS.md）降为待问，不当成缺失。
  if (s.docs?.contributing !== undefined) {
    ok.push('CONTRIBUTING 有')
    const contributing = readText(join(root, s.docs.contributing.file)) ?? ''
    const coreChecks = [
      [/提问|问题|反馈|issue|question|feedback|support|discussion|help/i, '提问与反馈'],
      // 「怎么提交改动」有两条合法路线，硬要 fork 会把私有仓库判成缺：
      // 全员同仓、各拉分支是私有仓库的常态，那种情况下 fork 反而多余。
      // 判据因此是**二选一**，不是「必须出现 fork」。
      // 另外收「合并请求 / merge request」这两个叫法：它们只是同一件事的另一种说法，
      // 而门禁的目标项目的作者可能就这么写——**认不出措辞的代价是一份合格的指南被判缺**，
      // 那比多认一个词贵得多。
      [/fork|(分支[\s\S]{0,20}(提案|PR|pull request|合并请求))|(branch[\s\S]{0,30}(pull request|PR\b|merge request))/i,
        '改动怎么提交（fork 或同仓分支 + 提案）'],
      [/门禁|全绿|测试|构建|check|test|build|verify|ci\b|lint|gate/i, '提交前门禁'],
      [/许可|licen[cs]e/i, '许可'],
    ]
    for (const [re, label] of coreChecks) {
      if (!re.test(contributing)) {
        missing.push(`CONTRIBUTING 缺${label}（补对应节，见 docs-set 第五节通用骨架；中英文皆可）`)
      }
    }
    if (!/AGENTS\.md/.test(contributing)) {
      pending.push('CONTRIBUTING 未指向 AGENTS.md：项目契约在哪、改动前先读什么，写清楚更省事（不是缺失，按项目习惯定）')
    }
    const kinds = s.ecosystem?.kinds ?? []
    const isNode = kinds.includes('node')
    const isPlugin = kinds.some((k) => /plugin|extension/.test(k))
    const isDsh = kinds.includes('dsh-plugin')
    const isDocsOnly = kinds.includes('docs-only')
    if (isNode && !/(npm|pnpm|yarn|bun|安装依赖|安装|dependenc|install)/i.test(contributing)) {
      missing.push('CONTRIBUTING 缺包管理器或安装说明（node 项目：沿用它自己的包管理器）')
    }
    if (isPlugin) {
      if (!/(产物|一起提交|artifact|commit.*build|build.*artifact|dist)/i.test(contributing)) {
        missing.push('CONTRIBUTING 缺产物同提交（插件类：安装方不构建，产物缺了即加载失败）')
      }
      if (!/(主干|标签|发布|main|tag|release|publish)/i.test(contributing)) {
        missing.push('CONTRIBUTING 缺三类越权（不推主干、不打标签、不发布）')
      }
    }
    if (isDsh && !/(挂载|重启|刷新|分发)/.test(contributing)) {
      pending.push('CONTRIBUTING 可补本地挂载与生效规则（DSH 插件：两条路差别是最高频问题）')
    }
    if (isDocsOnly && /```sh[\s\S]*?(npm|pnpm|cargo|pytest|go test)/.test(contributing)) {
      pending.push('纯文档项目的 CONTRIBUTING 含构建命令：确认是否真的需要开发环境节')
    }
  }
  else if (flags.has('--no-contributing')) ok.push('无 CONTRIBUTING（用户已确认自用）')
  else pending.push('CONTRIBUTING 缺失：问用户会不会给别人用（会→补，不会→加 --no-contributing）')
  } // scope: contributing
  if (wants('license')) { // scope: license
    // 许可证文件族要多说一句：双许可（`LICENSE-MIT` + `LICENSE-APACHE`）是 Rust 等生态的
    // 标准布局，**没有**单个 `LICENSE`。只报「LICENSE 有」会让下一个读的人以为只有一份，
    // 进而去补一个与清单里的 `OR` 表达式打架的 `LICENSE`。
    if (s.docs?.license !== undefined) {
      const fam = s.docs.licenseFamily
      ok.push(fam !== undefined && fam.length > 1
        ? `LICENSE 有（许可证文件族 ${fam.length} 份：${fam.join('、')}——双许可常见，不要再补单个 LICENSE）`
        : 'LICENSE 有')
    } else if (flags.has('--private-no-license')) ok.push('无 LICENSE（用户已选保留所有权利）')
    else pending.push('LICENSE 缺失：问用户选哪个许可证（保留权利→加 --private-no-license）')
  } // scope: license
  if (wants('ci')) { // scope: ci
  // 6. 工作流：CI 与自动发布要么落盘，要么用户明确说暂不要。
  //
  // 判据放在这个切面里，不放在 `ecosystem` 里：`--scope` 是 P0 记下的局部诉求在 P7 的
  // 落地手段，用户说「帮我配个 CI」时 AI 会传 `--scope=ci`。判据若挂在 `ecosystem` 上，
  // 那个切面就变成「报了绿但什么都没查」——对使用者来说，这比没这个切面更坏。
  const auto = s.docs?.workflowAutomation
  // 「读不到」与「真的没有」必须分开判。
  //
  // 合成一句话的后果：`.github/workflows` 存在但读不了时，勘察的 auto 缺席，这里落进
  // 「CI 缺失」分支，于是让用户去确认「不要 CI」——而他明明已经有 CI。把「没读到」
  // 说成「没有」，是这门语言里最容易犯也最难发现的一种错。
  const wfUnreadable = s.docs?.workflowsUnreadable === true
  if (wfUnreadable) {
    pending.push('CI 状态读不出来：`.github/workflows` 存在但读不了。'
      + '**这不代表没有 CI**——先确认目录权限，再重跑，不要据这一条去新建工作流')
  } else if (auto === undefined || auto.files.length === 0) {
    if (flags.has('--no-ci')) ok.push('无 CI（用户已确认暂不要）')
    else pending.push('CI 缺失：问用户要不要检查自动化与自动发布（不要→加 --no-ci，不要默跳）')
  } else {
    ok.push(`工作流有（${auto.files.join('、')}）`)
    if (auto.truncated === true && auto.hasReleaseJob !== true) {
      pending.push(`工作流只读了前 ${auto.headLimit ?? '若干'} 字符：“无发布 job”不可信，大文件需手工确认后再定`)
    }
    if (s.artifacts?.publishableManifest !== undefined && s.artifacts?.private !== true) {
      if (auto.hasReleaseJob) {
        ok.push('发布 job 有')
        // 英文回退确认：纯 --generate-notes 出来是英文模板（首版更是白卷）。
        // 有 notes-file 模式即中文链；没有就必须问一句，不能默认英文可接受。
        if (!auto.usesNotesFile && auto.usesGenerateNotes) {
          pending.push('发布说明是英文模板模式：确认英文可接受，否则换 notes-file 中文链（见模板 TODO(2)）')
        }
        // 说明文件是版本库里的一份文件，工作流去某个固定路径取它——**那个路径总得有个
        // 权威出处**，否则它就是散落在工作流里的一个字符串：改工作流的人不知道它为什么
        // 是这个值，写说明的人不知道要放哪。发版规范就是那个出处。
        //
        // 判据挂在「发布 job 存在」上，不挂在「有没有 RELEASING.md」上：一个从没配过
        // 自动化的项目没有这个问题（说明还没人自动读），问它只会多一条无用的待问。
        if (s.docs?.releaseSpec === undefined) {
          if (flags.has('--no-release-spec')) ok.push('无发版规范（用户已确认说明的位置自己记）')
          else if (forkMode) ok.push('无发版规范（Fork 模式：发版是维护者那一侧的事，不判）')
          else {
            pending.push('发布 job 会去某个路径取说明文件，但项目没有发版规范（`RELEASING.md`）：'
              + '说明写在哪、分几节、按什么顺序发，现在只写在工作流里。'
              + '要补就跑模板落一份；确认现状可接受时加 --no-release-spec')
          }
        } else ok.push(`发版规范有（${s.docs.releaseSpec.file}）`)
      }
      else if (flags.has('--no-auto-release')) ok.push('无发布 job（用户已确认暂不要自动发布）')
      else if (forkMode) ok.push('无发布 job（Fork 模式：发布是维护者那一侧的事，不判）')
      else pending.push('发布 job 缺失：可发布项目问用户要不要自动写 Release（不要→加 --no-auto-release）')
    }
  }
  } // scope: ci
  if (wants('ecosystem')) { // scope: ecosystem
  const dshKinds = s.ecosystem?.kinds ?? []
  if (dshKinds.includes('dsh-plugin') && s.host !== undefined) {
    const d = s.host
    if (d.filesHasLib === false) missing.push('DSH 发布范围缺 lib（成品包路线要求 files 含构建产物，以 pack 清单为准）')
    if (d.filesHasPatch === false) missing.push('DSH 发布范围缺补丁（声明 bundle 时 files 应含补丁文件）')
    if (d.libTracked === true && d.filesHasLib !== true) {
      missing.push('DSH 产物跟踪与发布范围矛盾：lib 被跟踪但 files 未含，先定成品还是源码路线')
    }
    if (d.hostRuntimeInDeps === true) missing.push('DSH 依赖放错：宿主运行时进了 dependencies，应为 peer')
    if (d.discoveryCarrierLikely === false) {
      missing.push('DSH 发现载体可能缺失：补丁文本里没有出现包名（补 name 等于包名自身的一行）')
    }
    if ((d.hasClientEntry === true) !== (d.hasClientDecl === true)) {
      pending.push('DSH 三态不明：exports 与 dsh.client 声明打架，先对齐再定 host-only 还是双面')
    }
  }
  // 非 DSH 插件：无专属门禁，按通用协议六问核对产物与标识（无专章时现场查宿主文档）。
  // Obsidian 项目在上面已有附件与触发器两条待问，这里不再重复通用提示。
  if (dshKinds.some((k) => /plugin|extension/.test(k)) && !dshKinds.includes('dsh-plugin')
    && !dshKinds.includes('obsidian-plugin')) {
    pending.push('非 DSH 插件：按通用协议核对产物同提交、两标识与挂载分发两条路（见 plugin-project.md）')
  }
  // Obsidian 发布链：四件事各有各的判据，不要压成一句“缺 main.js 即断链”——
  //   官方模板要求 main.js 只进发布附件、不进库，所以「仓库根无 main.js」不是缺失。正确分工：
  //   缺 = 仓库侧事实缺（manifest id 形状非法——提交审核会被拒）；
  //   待问 = 附件侧只能人去看发布页（附件齐不齐、tag 与版本三方一致、触发器是不是裸版本）。
  if (dshKinds.includes('obsidian-plugin') && s.artifacts?.obsidianArtifacts !== undefined) {
    const o = s.artifacts.obsidianArtifacts
    if (o.manifestIdShapeOk === false) {
      missing.push(`Obsidian 插件 id 形状非法：${o.manifestId ?? '（读不到）'}（应为小写字母与连字符、不含 obsidian、不以 plugin 结尾，提交审核会被拒）`)
    } else if (o.manifestId !== undefined) {
      ok.push(`Obsidian 插件 id 形状符合（${o.manifestId}）`)
    }
    if (o.mainJs !== true && o.mainJsIgnored !== true) {
      pending.push('Obsidian main.js 不在仓库根且未被忽略：要么还没构建，要么忽略规则漏了 main.js（官方模板要求它只进发布附件；确认构建与忽略规则后消掉）')
    } else {
      ok.push(o.mainJs === true ? 'Obsidian main.js 在仓库根（构建过；发布前确认附件即可）' : 'Obsidian main.js 被忽略（符合官方模板：只进发布附件）')
    }
    if (o.hasVersionsJson !== true) {
      pending.push('Obsidian 缺 versions.json：只在 minAppVersion 变化时才需要；加文件可消（加上它），确认旧宿主无需回退时在汇报里记一笔')
    }
    // 附件侧只能人去发布页看，机器只负责把“看什么”列全，不替人下结论。
    // 无标签、无发布 job 时无 release 可看，不问；一旦开始发版，每版都要看。
    const hasAnyTag = Array.isArray(s.git?.tags) && s.git.tags.length > 0
    const hasRelJob = s.docs?.workflowAutomation?.hasReleaseJob === true
    if (hasAnyTag || hasRelJob) {
      pending.push('Obsidian 发布附件待核：去该版本 Release 页确认 main.js + manifest.json (+styles.css 如有) 都在附件列表，且 tag 与两处 manifest.json 版本三方一致')
    }
    // 触发器形状：裸版本（1.2.3）才对；v* 只对 npm 一类成立。
    // releaseTriggerTags 取的是各工作流 on.push.tags 原文；releaseJobConditionTagsV
    // 说明条件里写死了 refs/tags/v（裸标签永远进不来）。两者任一命中 v 即问。
    const trig = s.docs?.workflowAutomation?.releaseTriggerTags ?? []
    const condV = s.docs?.workflowAutomation?.releaseJobConditionTagsV === true
    const trigHasV = trig.some((t) => /(^|[^0-9])v\*?/i.test(t) || /^v/i.test(t))
    if (trigHasV || condV) {
      pending.push(`Obsidian 标签触发器是 v 形状（触发器原文：${trig.join('、') || '未读到'}${condV ? '；条件写死了 refs/tags/v' : ''}）：宿主要求裸版本 tag（如 1.2.3），v* 推上去认不出——按专章第七节改触发器`)
    }
  }

  } // scope: ecosystem
  if (wants('ecosystem')) { // scope: ecosystem
  // 6c. 本地 skills：只盘点，不强求；已有被改坏才拦。
  //
  // 「装上了却像不存在」是这一类最常见也最难查的故障：宿主要么整个目录不加载，要么
  // 根本走不到那里，而两边都**不告诉模型**——症状与「压根没装」完全一样。所以凡能指出
  // 具体成因的，一律进缺项（它有确定的修法），不降级成待问。
  if (Array.isArray(s.localSkills) && s.localSkills.length > 0) {
    ok.push(`本地 skills 有（${s.localSkills.map((x) => x.path).join('、')}）`)
    for (const x of s.localSkills) {
      if (x.dropped !== undefined) missing.push(`本地 skill 宿主不会加载：${x.path} ${x.dropped}`)
      else if (x.corrupt === true) missing.push(`本地 skill 损坏：${x.path} 缺入口文件或首部非法`)
      else if (x.descriptionHead === undefined || x.descriptionHead.length < 10) {
        pending.push(`本地 skill 描述过短：${x.path}（触发语不明，改完再验）`)
      } else if (x.nameOk === false) {
        // 目录名与 name 不一致，**宿主并不校验**——目录名只是定位，name 才是路由与覆盖
        // 的依据。所以它是通用约定（改了更不容易走丢），不是缺陷；报成缺会让一批本来
        // 完全能跑的目录被判为未交付。降成待问：确认后再改，或确认后按通用约定改名。
        pending.push(`本地 skill 名实不符：${x.path} 目录名与 name 不一致（宿主不校验这一项，是通用约定；确认后再改名或确认保留）`)
      }
    }
  }
  // 仓库自身就是能力目录时，同一条判据适用于根入口，不只适用于仓库内的 skills。
  if (s.ecosystem?.skillDropped !== undefined) {
    missing.push(`本仓库的能力目录宿主不会加载：${s.ecosystem.skillDropped}`)
  }
  // CI 与发布 job 的判据在 `scope: ci` 里（见上方）。这里不再重复判一遍——
  // 同一判据实现两处，迟早会一处改了一处没改，而「两处都报」比「一处报」更难读。

  } // scope: ecosystem
  if (wants('release')) { // scope: release
  // 6d. 生态发布门禁：只判本生态清单事实，不拼他生态命令。
  const ecoKinds = s.ecosystem?.kinds ?? []
  const skipRegistryChecks = s.artifacts?.private === true || flags.has('--no-publish') || forkMode
  if (!skipRegistryChecks) {
    if (ecoKinds.includes('python') && s.artifacts?.pythonBuild !== undefined) {
      if (s.artifacts.pythonBuild.hasBuildSystem !== true) {
        pending.push('Python 缺构建后端声明：无 [build-system] 即无权威构建入口，补上再定发布预演')
      }
      const pm = s.artifacts.pythonMeta
      if (pm !== undefined) {
        if (pm.hasReadme !== true) missing.push('Python 缺 readme 声明（长描述渲染失败是服务端最常见的拒绝原因，先补再发）')
        if (pm.hasLicense !== true) missing.push('Python 缺 license 声明（新后端要求 SPDX 字符串 + license-files，旧写法会报“应为 dict”）')
        if (pm.hasRequiresPython !== true) {
          pending.push('Python 缺 requires-python：不挡发布，但用户装到旧版时难定位；确认支持下限后补上')
        }
        if (pm.hasDynamicVersion === true) {
          pending.push('Python 版本号走 dynamic：tag 对齐按后端取值（如 tag 或源码），不要照抄文件里的字面版本号')
        }
      }
    }
    if (ecoKinds.includes('go') && s.artifacts?.goModule !== undefined
      && s.artifacts.goModule.goDirective === undefined) {
      pending.push('Go 缺 go 指令：最低版本不明，补上再定兼容承诺')
    }
    // Rust：license/description 缺了服务端拒绝（报缺）；keywords/categories 超 5 个
    // 同样拒绝（报缺——勘察已数好个数）；edition 未声明只待问（缺省 2015 可发布）。
    if (ecoKinds.includes('rust') && s.artifacts?.cargoMeta !== undefined) {
      if (s.artifacts.cargoMeta.license !== true) missing.push('Rust 缺 license 声明（发布必填其一：license 或 license-file）')
      if (s.artifacts.cargoMeta.description !== true) missing.push('Rust 缺 description 声明（发布必填）')
      const cm = s.artifacts.cargoMeta
      if (typeof cm.keywordsCount === 'number' && cm.keywordsCount > 5) {
        missing.push(`Rust keywords ${cm.keywordsCount} 个（上限 5 个，超了服务端拒绝）`)
      }
      if (typeof cm.categoriesCount === 'number' && cm.categoriesCount > 5) {
        missing.push(`Rust categories ${cm.categoriesCount} 个（上限 5 个，超了服务端拒绝）`)
      }
      if (cm.hasEdition !== true) {
        pending.push('Rust 未声明 edition（缺省 2015 可发布，建议显式声明当前版本）')
      }
    }
  } else if (flags.has('--no-publish')) {
    ok.push('已确认不发布到制品库（--no-publish），已跳过制品库硬门禁')
  }
  // 发布自动化接线：有发布动作痕迹的生态，按对应专章逐项核对“登记了没有”。
  // 机器只认“动作痕迹 + OIDC 有无”两个比特，不猜登记内容对不对——对不对只能人去
  // 制品库设置页逐字对，错了只在发布那一刻爆错。三种都是待问（问完消不掉，只能改文件）。
  const auto2 = s.docs?.workflowAutomation
  if (auto2 !== undefined && s.artifacts?.private !== true) {
    if (auto2.hasNpmPublish === true && auto2.usesOidc !== true) {
      pending.push('npm 有发布动作但无 OIDC 声明：可信发布要 id-token: write + 制品库侧登记（组织/仓库/工作流文件名逐字一致）；用长期令牌则规划迁移（见 publish-npm 接线步骤）')
    }
    if (auto2.hasPypiPublish === true && auto2.usesOidc !== true) {
      pending.push('PyPI 有发布动作但无 OIDC 声明：可信发布要 pending publisher（包名/仓库/工作流文件名/environment）+ 发布 job 的 id-token: write，且构建与发布分 job；用 API Token 则确认已放机密存储（见 publish-python 认证一节）')
    }
    if (auto2.hasCargoPublish === true && auto2.usesOidc !== true) {
      pending.push('crates.io 有发布动作但无 OIDC 声明：可信发布要用官方认证 action 换短期令牌 + job 的 id-token: write，且先手动发布过一次（见 publish-rust 认证一节）；用 API Token 则确认已放机密存储')
    }
    // Release job 的形状三件套：引用约定名、写权限、全历史检出。缺一即待问。
    if (auto2.hasReleaseJob === true) {
      if (auto2.usesReleaseToken !== true && auto2.usesBuiltinToken !== true) {
        pending.push('发布 job 没接上任何凭据：要么用平台内置令牌（那个 job 要声明 contents: write），'
          + '要么引用约定的 RELEASE_TOKEN。两者都没有时建 Release 会认证失败，而日志只报一句「认证」')
      }
      if (auto2.hasContentsWrite !== true) {
        pending.push('发布 job 未声明 contents: write：建 Release 需要写权限（npm OIDC 的 id-token 与它是两回事，不要以为写了一个另一个顺带有了）')
      }
      if (auto2.hasFetchDepthZero !== true) {
        pending.push('发布 job 检出缺 fetch-depth: 0：起草脚本要读上一个标签，无全历史首版取全量与区间都算不对')
      }
    }
  }

  } // scope: release
  if (wants('collaboration')) { // scope: collaboration
  // 7. 协作基础设施：有远端才会有别人来改动。**判据挂在「有远端」上**，不挂在
  //    「有没有文件」上：一个还没有远端的项目被问「你怎么不收贡献」，只会多一条无用待问。
  //
  //    这一节同时把两份**早就采到、却没人读**的勘察事实接上判据（issueTemplates、
  //    prTemplate）。「产出了但没消费」与「没有这个能力」在报告上长得一模一样——
  //    而前者更坏：它看起来像在管，实际一句话都没说过。
  const hasRemote = typeof s.git?.remote === 'string' && s.git.remote.length > 0
    && s.git?.isRepoRoot !== false
  if (!hasRemote) {
    ok.push('无远端：不判协作模板（自己一个人的项目谈不上收贡献）')
  } else {
    const auto3 = s.docs?.workflowAutomation ?? {}
    // 模板目录读不到时，存在性判据整块不跑：`undefined` 的含义是「没查到」，不是「没有」。
    // 把权限问题读成缺失，就会让用户去建一个他其实已经有的东西。
    const tplUnreadable = Array.isArray(s.docs?.templateDirsUnreadable)
      && s.docs.templateDirsUnreadable.length > 0
    if (tplUnreadable) {
      pending.push(`读不到模板目录（${s.docs.templateDirsUnreadable.join('、')}）：**这不代表没有模板**，`
        + '先确认目录权限再重跑，不要据这一条去新建')
    }
    // 两种模板，判据不同：
    //   问题报告模板——让别人一次把必要信息给全，缺了就是每份报告都要追问一轮；
    //   改动提案模板——让审查者不必从改动内容反推意图，缺了就是每次审查都靠猜。
    if (s.docs?.prTemplate === true) ok.push('提案模板有')
    else if (tplUnreadable) { /* 上面已报，不重复 */ }
    else if (flags.has('--no-collab-templates')) ok.push('无提案模板（用户已确认单人不收贡献）')
    else pending.push('提案模板缺失：有远端就会有别人提改动，缺模板等于每次审查都要从改动内容反推意图'
      + '（落一份模板；确认单人不收贡献时加 --no-collab-templates）')

    if (s.docs?.issueTemplates === true) ok.push('问题报告模板有')
    else if (tplUnreadable) { /* 同上 */ }
    else if (flags.has('--no-collab-templates')) ok.push('无问题报告模板（用户已确认）')
    else pending.push('问题报告模板缺失：缺了每份缺陷报告都要来回追问「环境是什么、怎么复现」'
      + '（落一份模板；确认单人不收贡献时加 --no-collab-templates）')

    // 模板**存在但缺要素**才是「缺」：存在性已判过，这里判内容。
    // 只判两个能机器判的要素——验证证据与回滚点。其余（风险、影响范围）机器判不了，
    // 交给审查的人，不在门禁里假装能判。
    //
    // **存量模板不强求**：这两栏是本 skill 落的模板带着的要素，一个自己写模板的存量项目
    // 没有理由被要求补上。判据因此是「这份模板是不是我们落的」——账本里有 `whole` 记录
    // 且哈希对得上，才算我们落的；没有记录就是作者编排的，降为待问。
    // 硬逼存量项目补两栏的后果是可预见的：要么加 `--no-collab-templates` 把整块判据关掉
    // （连"模板缺失"一起关），要么随便补两行应付过去——两种都比待问糟。
    if (s.docs?.prTemplate === true && s.docs?.prTemplateFile !== undefined) {
      const tpl = readText(join(root, s.docs.prTemplateFile)) ?? ''
      const ours = ledgerOwnsFile(root, s.docs.prTemplateFile, tpl)
      // 中英两套词都要认：写的人用哪种语言是他的自由，只认中文会让一份合格的英文模板被判缺。
      const checks = [
        [/(验证|测试|怎么验|check|test|verif|evidenc)/i,
          '提案模板没有「怎么验证」一栏：审查与合并的人看的就是这里，缺了等于让他们替你重跑一遍'],
        [/(回滚|撤销|rollback|revert)/i,
          '提案模板没有「回滚点」一栏：出问题时要能立刻说清退回哪个已知可用的状态，'
            + '「出事了再说」不算'],
      ]
      // 开关一旦表过态，整块判据就不再逐栏跑了：两栏各报一次「已确认沿用」只会
      // 让同一件事在报告里出现两遍，读的人会以为有两份模板。
      if (flags.has('--pr-template-kept')) {
        ok.push(`${s.docs.prTemplateFile}：用户已确认沿用原样`)
      } else {
        for (const [re, why] of checks) {
          if (re.test(tpl)) continue
          if (ours !== true) {
            // 判不了也要按「不是我们落的」处理：账本缺失时把存量模板当成自己的，
            // 就会去要求作者补两栏，而那些项目的账本本来就不存在。
            pending.push(`${why}——这份模板没有账本记录，判为**作者自己写的**，补不补由你定 `
              + '（决定沿用原样时加 --pr-template-kept，就不会再问）')
          } else {
            missing.push(why)
          }
        }
      }
    }

    // 外部贡献的安全边界：`pull_request_target` 能拿到密钥，它**又**去检出提案那边的
    // 代码时，等于把密钥交给任意陌生人跑他的代码。判的是**配对**，不是单个关键词——
    // 只用了这个触发器来打标签、评论是合法用法，按关键词判会误报，误报多了没人看。
    //
    // 这一条**不给 flag 出路**：它不是一个「确认接受」的选择，是一个必须修的错误。
    if (auto3.usesPullRequestTarget === true && auto3.checkoutsPrHead === true) {
      missing.push('工作流同时用了 pull_request_target 并检出提案那边的代码：这等于让任意陌生人'
        + '拿你的密钥跑他的代码。改成「无特权工作流跑检查 + 有特权工作流只消费产物」，'
        + '或把这个触发器换成 pull_request（见 references/collaboration.md 第六节）')
    } else if (auto3.usesPullRequestTarget === true) {
      ok.push('用了 pull_request_target 但没检出提案代码（合法用法）')
    }
  }

  // 下面两条**不挂在「有没有远端」上**：它们判的是**文件内容**，与远端无关。
  // 挂上去的后果很具体——一个本地项目落了模板，模板缺要素仍然该被看见；没有远端只是
  // 「不会有人从外面提改动」，不是「模板可以随便写」。
  {
    // 问题模板的内容判据：要素缺一件，每份报告就要多一轮追问。
    // 判据只对**我方落盘的 `.md` 模板**生效——问题表单（`.yml`）的字段形状不同，按标题判会
    // 误报；存量项目自己写的模板也不强求，理由与提案模板那条完全一致。
    const issueFiles = Array.isArray(s.docs?.issueTemplateFiles) ? s.docs.issueTemplateFiles : []
    for (const file of issueFiles) {
      if (!/\.md$/i.test(file)) continue
      const text = readText(join(root, file)) ?? ''
      const verdict = issueTemplateGaps(text)
      // 读不出是缺陷还是需求时不判：猜错方向会诱导人去改一份本来合格的模板。
      if (verdict === undefined || verdict.lacking.length === 0) continue
      const detail = `${file} 缺这几栏：${verdict.lacking.join('、')}`
      if (ledgerOwnsFile(root, file, text) === true) {
        missing.push(`${detail}——缺一件，每份报告都要来回追问一轮`)
      } else {
        pending.push(`${detail}——这份模板没有账本记录，判为**作者自己写的**，补不补由你定`)
      }
    }

    // 契约要把「怎么参与」指给读者：有贡献指南或协作模板，而契约一个字都没提，新会话就只能
    // 在两套说法之间猜。**手写契约不判**——那是作者自己的编排，用 --handwritten-agents 表过
    // 态的就不再问（同一个开关，不新增一个只服务这一条的 flag）。
    if (s.docs?.agents !== undefined && flags.has('--handwritten-agents') !== true) {
      const agentsText = readText(join(root, s.docs.agents.file)) ?? ''
      if (s.docs.contributing !== undefined && !/CONTRIBUTING/i.test(agentsText)) {
        pending.push('AGENTS.md 没有指向 CONTRIBUTING：读者从契约找不到「怎么参与」，只能去翻目录；'
          + '写一句指针即可（手写契约确认保留原样时加 --handwritten-agents）')
      }
      const hasTpl = s.docs.prTemplate === true || s.docs.issueTemplates === true
      if (hasTpl && !/(pull_request_template|ISSUE_TEMPLATE|提案模板|问题模板|改动请求模板)/i.test(agentsText)) {
        pending.push('AGENTS.md 没有指向协作模板（`.github/` 下的问题与提案模板）：契约说改动的流程，'
          + '模板决定这次改动要带什么，两半分开写就一定会有一半被忘掉')
      }
    }
  }
  } // scope: collaboration
  for (const t of ok) line('齐', t)
  for (const t of pending) line('待问', t)
  for (const t of missing) line('缺', t)
  if (missing.length > 0) {
    process.stdout.write(`\n结论：${missing.length} 处缺失，补完重跑。待问事项问完用户后用 flag 消掉。\n`)
    renderNextActionNavigation(missing, pending, git)
    return 1
  }
  if (pending.length > 0) {
    if (flags.has('--strict')) {
      process.stdout.write(`\n结论：--strict 下 ${pending.length} 处待问同样拦住，问完消掉重跑。\n`)
      renderNextActionNavigation(missing, pending, git)
      return 2
    }
    process.stdout.write('\n结论：无缺失，但有待问事项——问完用户、加 flag 重跑，全齐才算交付。\n')
    renderNextActionNavigation(missing, pending, git)
    return 0
  }
  process.stdout.write('\n结论：全部齐备，可以交付。\n')
  renderNextActionNavigation(missing, pending, git)
  return 0
}

function renderNextActionNavigation(missing, pending, git) {
  process.stdout.write('\n下一步行动导航：\n')

  const decisionPending = pending.filter((p) => !p.includes('未提交') && !p.includes('未推') && !p.includes('领先上游'))
  if (decisionPending.length > 0) {
    process.stdout.write('【待确认的决策（可用 --remember 固化至账本）】\n')
    for (const p of decisionPending) {
      let flagHint = ''
      if (p.includes('单语') || p.includes('双语')) flagHint = '--no-bilingual'
      else if (p.includes('贡献指南')) flagHint = '--no-contributing'
      else if (p.includes('LICENSE')) flagHint = '--private-no-license'
      else if (p.includes('检查自动化缺失') || p.includes('无工作流') || p.includes('暂不要 CI')) flagHint = '--no-ci'
      else if (p.includes('自动发布')) flagHint = '--no-auto-release'
      else if (p.includes('制品库') || p.includes('发布门禁')) flagHint = '--no-publish'
      else if (p.includes('约定文件')) flagHint = '--conventions-reviewed'
      else if (p.includes('手写')) flagHint = '--handwritten-agents'
      else if (p.includes('发版规范') || p.includes('RELEASING.md')) flagHint = '--no-release-spec'
      else if (p.includes('协作模板') || p.includes('问题报告模板缺失')) flagHint = '--no-collab-templates'
      else if (p.includes('提案模板')) flagHint = '--pr-template-kept'
      else if (p.includes('占位或测试数据') || p.includes('凭据')) flagHint = '--secrets-reviewed'
      
      process.stdout.write(`  - ${p}${flagHint ? `\n    → 固化命令：\`node scripts/review.mjs . --remember ${flagHint}\`` : ''}\n`)
    }
  }

  const neededRefs = []
  if (missing.some((m) => m.includes('LICENSE')) || pending.some((p) => p.includes('LICENSE'))) {
    neededRefs.push('references/docs-set.md（第四节：许可协议选择与落盘）')
  }
  if (missing.some((m) => m.includes('CONTRIBUTING')) || pending.some((p) => p.includes('CONTRIBUTING'))) {
    neededRefs.push('references/docs-set.md（第五节：贡献指南）')
  }
  if (missing.some((m) => m.includes('工作流') || m.includes('CI')) || decisionPending.some((p) => p.includes('CI'))) {
    neededRefs.push('references/remote-github.md（持续集成与 GitHub Actions 配线）')
  }
  if (missing.some((m) => m.includes('AGENTS.md') || m.includes('内核'))) {
    neededRefs.push('references/collaboration.md 与 templates/agents-kernel.md')
  }
  if (neededRefs.length > 0) {
    process.stdout.write('【建议按需阅读的参考文档】\n')
    for (const ref of neededRefs) process.stdout.write(`  - ${ref}\n`)
  }

  const immediate = []
  if ((git?.dirty ?? 0) > 0 || (git?.ahead ?? 0) > 0) {
    immediate.push(`工作区有未提交或未推送变动（dirty: ${git?.dirty ?? 0}, ahead: ${git?.ahead ?? 0}），请执行：git commit && git push`)
  }
  if (missing.length > 0) {
    immediate.push('根据上述 [缺] 项修复文件或补充必要配置后重新运行 review.mjs')
  }
  if (immediate.length > 0) {
    process.stdout.write('【立即可执行的动作】\n')
    for (const act of immediate) process.stdout.write(`  - ${act}\n`)
  }
}

// 与 survey / preflight 同一模式：直接执行才跑 main；被 import（selftest 单测本文件的
// 纯函数）时不产生副作用。判据按真实路径比较，经 junction 调用也算直接执行。
if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main(process.argv)