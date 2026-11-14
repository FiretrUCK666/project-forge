#!/usr/bin/env node
/**
 * update.mjs —— 让这个 skill 的副本保持最新
 *
 * 副本分两种角色，判据是**结构**，不是记性、也不是猜意图：
 *
 *   - 目录里有 `.git` → **源码副本**。git 就是它的更新方式，所以这个脚本对它**只读**：
 *     查得到上游差多少就报一句，绝不写一个字节。自己改着改着、文件突然被换掉，
 *     比「没更新」坏得多；而 git 本身是后悔药，交给它比交给这里安全。
 *
 *   - 没有 `.git` → **包副本**（从发布页下载的那份）。它靠这里自更新。
 *
 * 包副本的更新是**整份覆盖**：有新版就换，不问、不比、不看本地有没有改动。
 * 使用者要的就是「用的时候是最新版」；替他判断「他改的算不算数」只会带来两种错：
 * 把该更新的拦下，或者把该保留的覆盖掉。所以不做那个判断。
 * 唯一的例外是上面那条 `.git`——那是**开发**，不是使用。
 *
 * 每次使用发生的事，三步：
 *
 *   0. **看节流**：距上次真的核对上远端版本不足一小时，就到此为止、不联网。这一步
 *      不改变任何判据，只是不再把同一个结论重复取一遍——它挂在每个任务的开头，
 *      而「已是最新」这个答案一小时内不会变。
 *   1. **比版本**：问一次「最新版是哪个标签」（一个请求、几十 KB 的元数据，不下整包），
 *      与本地版本比。不是更新版就结束——这是绝大多数时候，所以这一步必须便宜。
 *
 *      **问谁有两条路，按顺序试**（见 `routesFor`）：
 *
 *        - **接口路**：GitHub 给程序用的接口（`api.github.com`）。一次请求同时给出标签与
 *          「那一版的附件在哪儿取」，**整条链路不碰网页主机**——而网页主机恰是最容易时通
 *          时不通的那一环，它的接口主机往往另有一套、稳得多；
 *        - **网页路**：网页地址（`github.com/<owner>/<repo>/releases/latest`）。来源认不出
 *          是 GitHub 时（自行搭建的镜像、从别处转发的副本）只有这条路，它同时是接口路的退路。
 *
 *      两条都问不到才算「没能核对」。**认不出来就不猜**：给一个非 GitHub 的地址硬拼一个
 *      接口地址，换来的是一句看起来像事实的「那边没有最新发布」。
 *   2. **看窗口**：距上次成功更新不足 24 小时就不换文件（检查照跑，所以新版一发布
 *      就看得见，只是等窗口过完才动手）。窗口的用处是**不让同一份副本一天换好几次**：
 *      换文件会改掉磁盘上的内容，频繁换对正在读它的会话不友好。
 *   3. **换**：下载新版整包 → 整份覆盖 → 说一句 → 记下时刻。下载同样按优先顺序试：
 *      接口路给的附件地址在前，网页地址在后。
 *
 * **版本号只有标签一个来源，不在这里另记一份。** 问标签、或读包里 `SKILL.md` 的
 * `metadata.version`，两者都由发版门禁保证同号；这个脚本不生成、不维护任何版本清单
 * ——多一份要人记得同步的东西，迟早会不同步。
 *
 * 任何一步不成立（没网、取不到、包读不动）→ **什么都不做，一个字节不写**，下次再用
 * 重试。所以不存在「更新到一半」的状态：要么整份换好，要么跟没跑过一样。失败也不占
 * 那 24 小时的额度——占了就等于「一次断网，今天不再更新」。
 *
 * **核对不上时不再一路沉默**：隔了好一阵（含从没成功过）都问不到远端版本，就在
 * `--quiet` 下也说一句——使用者有权知道「这份停在某一版、是核对不了，不是最新」，
 * 而不是把静默读成「一切正常」。偶尔抖一次不算（下次再用就自己好了），说过之后也隔
 * 同样久才会再说，所以它不会变成每次任务都念一遍的噪音。
 *
 * 状态按副本路径分开，写在系统临时目录里，**不写在 skill 目录里**：那份目录只该
 * 有包里的东西，多出一个状态文件是污染。读不到或坏了都当成「没更新过」——多更新一次
 * 无害，卡着不更新才有害。
 *
 * 用法：
 *   node scripts/update.mjs [--quiet] [--check]
 *
 *   --quiet   只在「真的更新了」时输出（skill 自己在任务开始时用这个）
 *   --check   只报告不更新，不受节流与窗口限制（人主动问的时候用）
 *
 * 环境变量：`PF_UPDATE_SOURCE` 改来源（副本没记来源时生效）；`PF_NO_UPDATE` 设非空值
 * 可整个关掉自动检查（--check 不受影响）。
 *
 * 退出码：0 = 无事或已更新；1 = 尝试更新但失败；2 = 用法错误。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { skillSource, skillVersion, isMainModule } from './lib/text.mjs'
import {
  PF_MANIFEST_REL, REPO_ONLY_FILES, REPO_ONLY_PREFIXES, isRepoOnlyPath, apiTarget,
} from './lib/protocol.mjs'
import { equip } from './equip.mjs'
import { readZip, stripCommonPrefix } from './zip.mjs'
// 临时文件的**形状与归属判据**只有一份，住在 lib/fs-atomic.mjs：compose-agents.mjs 从那里取，
// 本文件也取。两处各写一份就会漂——而漂出来的后果是「一个脚本清得掉残留、另一个把
// 使用者自己的文件也删了」。
import { clearStaleTemps, tempPathFor, writeAtomic } from './lib/fs-atomic.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

/**
 * 这份代码自己的来处。
 *
 * 副本里记的来源（`SKILL.md` 的 `metadata.source`）才是首选——fork 出去自己发版的人写自己的
 * 地址，就该更新他自己的。但**只靠那个字段是脆的**：宿主不认这个扩展字段、谁手删了一行、
 * 或者有人把整份拷进另一个目录，副本就再也说不出自己在哪儿，更新于是静默失效。而这段代码
 * 本身随包走，它写着的地址永远是「这套代码的产出者」，所以拿它兜底：两条都读不到才认输。
 */
const UPSTREAM = 'https://github.com/FiretrUCK666/project-forge'

/** 更新成功后的静默期：这段时间里不再换文件，但照常比版本。 */
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
/**
 * 隔这么久都问不到远端版本，就该让使用者知道一次；也是两次提醒之间的最短间隔。
 *
 * 两个用途共用一个值是有意的：判据是「已经很久没能核对上了」，而既然要说，一天说一次
 * 就够了——更密就变成噪音，更疏则「一直落后」这件事会被藏起来。
 */
const STALE_CHECK_MS = 24 * 60 * 60 * 1000
/**
 * 两次「问远端要版本号」之间至少隔这么久。
 *
 * 与上面那个窗口是两件事：窗口管**换不换文件**，这一条管**联不联网**。只有窗口时，
 * 于是「已是最新」这个结论每次任务都重新联网取一遍——它每天最多只有一个小时是新的，
 * 其余时间都是重复劳动。离线环境下这笔钱更贵：每条路要等到连接失败或超时，实测
 * 每次任务白等 2 秒左右，而这段时间挂在任务开头。
 *
 * 取一小时的理由：新版本发出来到被用上，最多晚一小时，而使用者对「装上之后要过一个
 * 小时才自动更新」没有感知（他不需要为此做任何事）；换来的是联网次数下降两个数量级。
 */
const CHECK_INTERVAL_MS = 60 * 60 * 1000
/** 单次网络动作的上限。它挂在每个任务的开头，卡住就等于把任务卡住。 */
const NETWORK_TIMEOUT_MS = 10 * 1000

/**
 * 单次下载的字节上限。
 *
 * 防的是「收不完」：异常镜像返回无穷流、截断后重传叠成超出预期的体积、
 * 或者干脆给一个恶意大包。用户包真实大小在一两 MB 量级，20 MB 留足了余量。
 */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
/** 附件名。固定不带版本号，`releases/latest/download/<这个名字>` 才永远指向最新版。 */
const ASSET = 'project-forge.zip'

/** 状态按副本路径分开：一份副本的更新不该替另一份做决定。 */
const STATE_PATH = join(tmpdir(),
  `project-forge-update-${createHash('sha1').update(SKILL_ROOT).digest('hex').slice(0, 12)}.json`)

function usage() {
  return [
    '用法：node scripts/update.mjs [--quiet] [--check] [--equip <目录>]',
    '',
    '  检查这个 skill 的副本有没有新版；有就整份换成新版。',
    '',
    '  有 .git 的副本是源码副本：只读报告，一个字节都不写（更新请自己 git pull）。',
    '  没有 .git 的是包副本：比版本、下载新版、整份覆盖，并可顺带无损刷新目标项目的 `.agents/skills/`。',
    '',
    '  --quiet          只在「真的更新了」时输出',
    '  --check          只报告不更新，也不受节流与 24 小时窗口限制',
    '  --equip <目录>   更新完顺带刷新指定项目里的 `.agents/skills/`（按 `.pf-manifest.json` 三态无损升级）',
    '',
    '  来源：优先用副本自己记的那个（SKILL.md 的 metadata.source）；读不到时用兜底地址，',
    '  可用环境变量 PF_UPDATE_SOURCE 改（转发的副本、内网发布用）——它只在副本没记来源时生效。',
    '  设 PF_NO_UPDATE 为非空值可以整个关掉自动检查（--check 不受影响）。',
    '',
  ].join('\n')
}

function skillText() {
  const p = join(SKILL_ROOT, 'SKILL.md')
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}

function localVersion() {
  const text = skillText()
  return text === undefined ? undefined : skillVersion(text)
}

function localSource() {
  const text = skillText()
  return text === undefined ? undefined : skillSource(text)
}

/** 这个副本的事实。每一条读不到就是「这项事实不存在」——按它分情况，不猜。 */
function readFacts() {
  return {
    // 只看 `.git` **存在**，不看它是文件还是目录：检出到子目录、worktree、submodule
    // 三种情况下它是文件，而三种都仍然是「有版本历史」。
    hasGit: existsSync(join(SKILL_ROOT, '.git')),
    version: localVersion(),
    source: localSource(),
  }
}

/**
 * 读更新状态。读不到或坏了都当成「没更新过」——多更新一次无害，卡着不更新才有害。
 *
 * 读之前先去掉可能存在的 BOM：这个文件写在一个谁都能碰的临时目录里，而「带 BOM 的
 * UTF-8」在 Windows 上是许多工具写文件的默认行为。带 BOM 的文本 `JSON.parse` 会直接
 * 抛错，于是窗口静默失效——现象是「明明记得它刚更新过，它却又要更新」，最难查的那类。
 * 容错放在**读**这一侧：写的那一侧无论怎么写，读回来都得对。
 */
function readState() {
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, ''))
    return {
      lastUpdateAt: num(raw?.lastUpdateAt),
      lastOkAt: num(raw?.lastOkAt),
      lastNoticeAt: num(raw?.lastNoticeAt),
    }
  } catch {
    return { lastUpdateAt: 0, lastOkAt: 0, lastNoticeAt: 0 }
  }
}

/**
 * 记下这次发生的事。
 *
 * **读—改—写**，不是整份覆盖：三个时刻各管各的（换文件的窗口、上次真的核对到了远端
 * 版本、上次为此提醒过使用者），谁都不该把别人抹掉。
 */
function rememberState(patch) {
  try {
    writeFileSync(STATE_PATH, `${JSON.stringify({ ...readState(), ...patch })}\n`, 'utf8')
  } catch {
    // 写不进去只是失去窗口与提醒节奏，不影响正确性：下次再查一遍就是了。
  }
}

/**
 * 输出。
 *
 * quiet 模式（skill 在每次任务开始时用的那个）只放行两类：**真的更新了**与**更新失败**。
 * 其余情况（已是最新、源码副本、这次没连上、刚更新过）对使用者没有可动作的信息，而每次
 * 任务都念一遍的结果是让人学会忽略这一行——那时它真正要说的话也一起被忽略了。
 * 想看全部状态用 `--check`。
 */
function report(lines, { quiet, always = false } = {}) {
  if (quiet && !always) return
  const text = lines.filter((l) => l !== undefined).join('\n')
  if (text !== '') process.stdout.write(`${text}\n`)
}

/**
 * 取回一个地址的原始字节，跟着重定向走（发布页的附件地址会跳到对象存储）。
 *
 * 用哪个协议**跟着来源地址走**，不写死：来源就是这个副本当初从哪儿来的地方，
 * 它说什么协议就按什么协议取。这也让这套逻辑能在本机拿一个临时服务端实跑验证，
 * 不必为了测试在代码里开一个只有测试才走的后门。
 */
function download(url, { redirects = 5, accept = '*/*', final } = {}) {
  return new Promise((resolvePromise) => {
    const secure = url.startsWith('https:')
    const request = (secure ? httpsGet : httpGet)(url, {
      headers: { 'user-agent': 'project-forge-update', accept },
      timeout: NETWORK_TIMEOUT_MS,
    }, (res) => {
      const { statusCode, headers } = res
      const location = headers.location
      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400
        && location !== undefined && redirects > 0) {
        res.resume()
        let next
        try {
          next = new URL(location, url).toString()
        } catch {
          // 重定向目标不是合法地址：这条路走不通，如实说「没走通」。
          // **不能抛出去**——抛出去就是整个进程带着一整段栈死掉，而调用方
          // 还有别的路可走（换一条探针路、或者退回取整包读版本）。
          resolvePromise({ ok: false, status: 0, final })
          return
        }
        resolvePromise(download(next, { redirects: redirects - 1, accept, final: next }))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        resolvePromise({ ok: false, status: statusCode ?? 0, final })
        return
      }
      // **下载也要有上限**：托管的响应是外面给什么就收什么，异常镜像、截断重传、
      // 恶意大包都能让内存被吃干净。20 MB 对用户包足够——真实包解开也就一两 MB。
      // 超限时**主动 destroy**，不是收完再判：收完再判等于没防住。
      const declared = Number(headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        res.resume()
        resolvePromise({ ok: false, status: 0, final, tooLarge: true })
        return
      }
      const chunks = []
      let received = 0
      let aborted = false
      res.on('data', (c) => {
        if (aborted) return
        received += c.length
        if (received > MAX_DOWNLOAD_BYTES) {
          aborted = true
          chunks.length = 0
          res.destroy()
          resolvePromise({ ok: false, status: 0, final, tooLarge: true })
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        if (!aborted) resolvePromise({ ok: true, status: 200, final, body: Buffer.concat(chunks) })
      })
      res.on('error', () => { if (!aborted) resolvePromise({ ok: false, status: 0, final }) })
    })
    request.on('timeout', () => { request.destroy(); resolvePromise({ ok: false, status: 0, final }) })
    request.on('error', () => resolvePromise({ ok: false, status: 0 }))
  })
}

/**
 * GitHub 给程序用的那套接口地址（`api.github.com`）。
 *
 * 判据（地址规律、认不出就不猜）住在 `lib/protocol.mjs` 的 `apiTarget` 里，
 * 而**拼装也只在那里做一次**：这里只把 `latest` 原样取走。
 *
 * 早先这里是自己拿 `target.owner` / `target.name` 拼的，而 `apiTarget` 根本不返回
 * 那两个字段——拼出来的是 `.../repos/undefined/undefined/releases/latest`。症状很隐蔽：
 * 接口返回 404，被读成「那边没有最新发布」，于是每次都掉进兜底、下整包。
 */
function apiEndpoint(source) {
  return apiTarget(source)?.latest
}

/**
 * 问发布方这件事，按优先顺序排好的路。
 *
 * 两条路的差别不只是地址。**接口路一次请求同时给出标签与附件的取用地址**，于是整条
 * 更新链路只碰「接口主机 + 资产主机」；网页路拿不到附件地址，下载只能回到网页主机上
 * 那个固定地址。所以多这一条路的意义不止「多试一次」，而是**换掉整条链路里最不稳的
 * 那一段**——网页主机恰恰是时通时不通得最厉害的一环。
 *
 * 来源认不出是 GitHub 时只排得出网页路。那不是退步，是如实：它不提供那套接口，就没有接口路。
 */
function routesFor(source) {
  const routes = []
  const api = apiEndpoint(source)
  if (api !== undefined) routes.push({ kind: 'api', endpoint: api })
  routes.push({ kind: 'web', endpoint: `${source}/releases/latest` })
  return routes
}

/**
 * 最新版的包地址。附件名固定不带版本号，所以这个地址永远指向最新版。
 *
 * 网页路用它，以及「问不到标签、退回取整包读版本」那一支用它。
 */
function latestPackageUrl(source) {
  return `${source}/releases/latest/download/${ASSET}`
}

/** 网页路能给的下载地址只有一个：那个固定指向最新版的地址。 */
function webPackageUrls(source) {
  return [{ url: latestPackageUrl(source), accept: '*/*' }]
}

/**
 * 接口路：一次请求同时拿到「最新版是哪个标签」与「那一版的附件在哪儿取」。
 *
 * 附件地址用**接口给的那一条**，不按名字自己拼：发布方可以把附件取成任何名字，接口
 * 给的是这一版实际挂着的那一个。取它时要声明「要原始字节」，平台才会把你交给资产主机。
 *
 * 三种结果必须分得开：「问到了」「那边确实没有最新发布」「这条路这次没走通」。中间
 * 那种是结论，后一种该换条路再问——**限流与超时都归进「没走通」**：它们说的是
 * 「这次问不成」，不是「那边没有」。
 */
async function probeApi(endpoint, source) {
  const res = await download(endpoint, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }
  let payload
  try {
    payload = JSON.parse(res.body.toString('utf8'))
  } catch {
    // 说是接口却不是 JSON：这条路这次不能用，交给下一条。
    return { state: 'unreachable' }
  }
  const version = plainVersion(payload?.tag_name)
  // 「说好是接口，回的却不是那个形状」属于**这条路没走通**，不是「那边没有最新发布」：
  // 前者该换条路再问（网页路多半问得出来），后者才是结论。认错这两个，代价是一次
  // 本可以成功的更新被静默跳过。
  if (version === '') return { state: 'unreachable' }
  const asset = Array.isArray(payload.assets)
    ? payload.assets.find((a) => a?.name === ASSET) : undefined
  const packageUrls = []
  if (typeof asset?.url === 'string' && /^https?:/.test(asset.url)) {
    packageUrls.push({ url: asset.url, accept: 'application/octet-stream' })
  }
  // 接口没给出附件地址（附件被改名、或那一版没挂附件）时，退到网页那个固定地址：
  // 它与接口说的是同一版，只是取法不同。
  packageUrls.push(...webPackageUrls(source))
  return { state: 'ok', version, packageUrls }
}

/**
 * 网页路：问发布方「最新版是哪个标签」。
 *
 * 接口路认不出来时这是唯一的一条，所以它必须便宜：一个请求、不下整包。版本号来自标签
 * 本身——项目里版本号只有一个来源就是标签，这里不去读任何「版本清单」文件，也就不会
 * 多出一份要人记得同步的东西。
 */
async function probeWeb(endpoint, source) {
  // **不要求来源是 `owner/name` 那种形状**：它只是一个 http(s) 地址，探针也只需要地址。
  // 判据不能用 `repoPath`：转发的副本给的 `http://host:port` 会被它挡在门外，
  // 而挡的方式是「那边没有最新发布」——一个看起来像事实的错误结论。
  const res = await download(endpoint, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }

  // 一：**看它最后落在哪个地址**。GitHub 的 `releases/latest` 会跳到那一版的页面，
  // 地址末尾就是标签（`…/releases/tag/v0.16.1`）。这一条路**一个字节正文都不用读**，
  // 既省流量，也不依赖接口主机。
  const fromUrl = /\/releases\/tag\/([^/?#]+)/.exec(res.final ?? '')
  if (fromUrl !== null) {
    // 解码可能失败：地址里的标签段带残缺的百分号转义（`%E0%A4%A` 这类）时，
    // decodeURIComponent 抛 URIError。**这里不能崩**——崩了就是整个进程带着栈死掉，
    // 而这条路本来还有退路：解不出标签就按「从地址里读不到版本号」处理，
    // 接着走下面两条已有的分支（正文是 JSON 就从正文读，还不是就当「那边没有最新
    // 发布」，让调用方去取整包、从包里读版本）。**不新增一条平行的失败路径。**
    const version = decodeTagSegment(fromUrl[1])
    if (version !== '') return { state: 'ok', version, packageUrls: webPackageUrls(source) }
  }

  // 二：正文是 JSON（接口形状、或自建服务端按接口形状回应）。
  const text = res.body.toString('utf8')
  if (/^\s*[[{]/.test(text)) {
    try {
      const tag = JSON.parse(text)?.tag_name
      const version = typeof tag === 'string' ? plainVersion(tag) : ''
      if (version !== '') return { state: 'ok', version, packageUrls: webPackageUrls(source) }
    } catch { /* 不是合法 JSON：落到下面当「那边没有」处理 */ }
  }

  // 三：跳到了别处、正文也不是 JSON（例如自建服务端只回一个静态页）。
  // **这里不能再拿正文去猜版本号**：正文里出现的版本串可以是任何东西（页脚、变更记录、
  // 友情链接），猜错的方向是把使用者降级到一版更旧的代码。宁可说「那边没有最新发布」，
  // 让调用方去下那一份包、从包里读。
  return { state: 'absent' }
}

/**
 * 下载一份包并解开，顺带读出它的版本。任何一个环节不成立都不返回半份内容。
 *
 * `accept` 由调用方给：接口给出的附件地址要声明「要原始字节」，平台才会把字节交出来；
 * 网页那个固定地址不必声明。
 */
async function fetchPackage(url, accept = '*/*') {
  const res = await download(url, { accept })
  if (!res.ok) return { ok: false, why: res.status === 404 ? '没有这一版' : '没能取回', status: res.status }
  let entries
  try {
    entries = stripCommonPrefix(readZip(res.body))
  } catch (error) {
    return { ok: false, why: `取回的不是一份能读的包（${error.message}）`, status: 200 }
  }
  const skill = entries.find((e) => e.name === 'SKILL.md')
  if (skill === undefined) return { ok: false, why: '包里没有 SKILL.md', status: 200 }
  return { ok: true, entries, version: skillVersion(skill.data.toString('utf8')) }
}

/**
 * 版本号的规范写法：去掉标签前缀与预发布后缀之外的一切。
 *
 * 标签是 `v0.16.0` 而清单里是 `0.16.0`，两处说的必须是同一个版本。这个脚本要
 * **比**它、也要**报**它——报的时候带上 `v`，使用者看到的就是一个和 README、
 * 清单都对不上的字符串。所以归一化只做一次，比较与显示共用同一个值。
 */
function plainVersion(value) {
  return String(value ?? '').trim().replace(/^v(?=\d)/i, '')
}

/**
 * 地址里的标签段：能解码就解码，解码不了就当「读不到」。
 *
 * 残缺的百分号转义（`%E0%A4%A` 这类）会让 decodeURIComponent 抛 URIError。
 * 抛出去就是整个进程带着一整段栈死掉，而这里要的只是「这个地址里读不出版本号」
 * 这一条事实——读不到不是灾难，是「换条路读」。
 */
function decodeTagSegment(segment) {
  try {
    return plainVersion(decodeURIComponent(segment))
  } catch {
    return ''
  }
}

/** 版本号比大小：按 `.` 分段比数字，比不出来就返回 undefined（不猜）。 */
function isNewer(candidate, current) {
  // 比较遵循 SemVer 的优先级规则，**预发布后缀不能被丢掉**：
  //
  //   1.2.0-alpha.1  <  1.2.0
  //
  // 丢掉后缀会把这两者判成同一版，于是「从预发布升到正式版」被静默跳过——
  // 而使用者看到的正是「明明发了新版，它却说我是最新的」。这比多提示一次更新坏得多。
  //
  // 形状认不出来时仍返回 undefined（不抛错）：整条更新路径要能安全退化。
  const parse = (v) => {
    const s = plainVersion(v)
    // 主号部分：构建元数据（+ 之后）不参与比较，预发布（第一个 - 之后）单独处理。
    const noBuild = s.split('+')[0]
    const dash = noBuild.indexOf('-')
    const core = (dash >= 0 ? noBuild.slice(0, dash) : noBuild).split('.')
      .map((x) => (/^\d+$/.test(x) ? Number(x) : undefined))
    if (core.length === 0 || core.some((x) => x === undefined)) return undefined
    const pre = dash >= 0 ? noBuild.slice(dash + 1).split('.') : []
    return { core, pre }
  }

  const a = parse(candidate)
  const b = parse(current)
  if (a === undefined || b === undefined) return undefined

  // 先比主号
  for (let i = 0; i < Math.max(a.core.length, b.core.length); i += 1) {
    const x = a.core[i] ?? 0
    const y = b.core[i] ?? 0
    if (x !== y) return x > y
  }

  // 主号相同，再比预发布：**有预发布 < 无预发布**（正式版高于同号的预发布版）
  if (a.pre.length === 0 && b.pre.length === 0) return false
  if (a.pre.length === 0) return true          // a 是正式版，b 是预发布 => a 新
  if (b.pre.length === 0) return false         // a 是预发布，b 是正式版 => a 旧

  // 两边都是预发布：逐段按 SemVer 比（数字段按数值，其余按字典序；数字段低于字母段）
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return false          // a 段数少 => a 更小
    if (y === undefined) return true
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d > 0
    } else if (xn !== yn) {
      return yn                                 // 数字段低于字母段
    } else if (x !== y) {
      return x > y
    }
  }
  return false
}

/** 一段时长的人话：用来告诉使用者「还要等多久」或「已经多久了」，不写内部毫秒数。 */
function durationText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.ceil(minutes / 60)
  return hours < 24 ? `${hours} 小时` : `${Math.ceil(hours / 24)} 天`
}

/**
 * 收掉「因为里面东西被删光而空掉」的目录，一路往上，到本领目录为止。
 *
 * 排除表里记的是**文件**（`scripts/dev/preflight.mjs`），不是目录名——把两个文件删掉
 * 之后那个目录就空了，而空目录会被当成「这个 skill 还有这么一块」。判据不猜目录叫什么，
 * 只问「它现在是不是空的」，所以文件地图怎么改都不用跟着改。
 *
 * 只收空的：里面还有别的东西就停手，那是使用者的东西。
 */
function pruneEmptyDirs(dir) {
  let current = dir
  // 边界判据用 `insideSkill`，**不写裸 `startsWith`**：`…/project-forge-secret` 以
  // `…/project-forge` 开头，字符串前缀会把它当成「在之内」，于是向上收空目录时能走出
  // 技能目录、删掉邻居。这正是 `insideSkill` 的注释里点名的那个陷阱——同一份判据不能
  // 在这里再手写一遍走样的版本。
  while (current !== SKILL_ROOT && insideSkill(current)) {
    try {
      if (!existsSync(current) || !statSync(current).isDirectory()) break
      if (readdirSync(current).length > 0) break
      rmSync(current, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      break
    }
    const up = dirname(current)
    if (up === current) break
    current = up
  }
}

/**
 * 这个路径落不落在本领目录之内。
 *
 * **下载来的东西不能决定写到哪儿。** 包里的条目名与文件地图里的清单都来自网络上的那一份，
 * 它们**不能**被直接拼成本机路径：`../victim/` 这样的名字会让删除与写入跑到 skill 目录
 * 之外，把旁边的东西删掉或覆盖——那是这个工具能做的最坏的事，而且报告会把它说成「顺手
 * 清掉了包里不该有的文件」。判据是**解析之后**的路径边界，不是字符串前缀（`startsWith`
 * 在 `…/project-forge-secret` 这类同前缀目录上会误判为「在之内」）。
 *
 * **符号链接要按它指到的实际位置判，不能按它自己的位置判**：目录里任何一项换成链接之后，
 * `…/project-forge/templates/readme.md` 这个名字仍然「在之内」，而真正的落点在目录之外。
 * 不解析链接，整套边界判据在链接面前就是一句话的事。目标还不存在（要新建文件）时，
 * 从最近的已存在祖先解析，再拼回剩下的相对段。
 */
function resolveReal(p) {
  let head = p
  const rest = []
  for (;;) {
    try {
      return join(realpathSync(head), ...rest.reverse())
    } catch {
      const up = dirname(head)
      // 走到根还解析不了：交回调用方的边界判据去拒绝，不在这里兜。
      if (up === head) return p
      rest.push(basename(head))
      head = up
    }
  }
}

function insideSkill(target) {
  const root = resolve(SKILL_ROOT)
  const full = resolve(target)
  if (full === root) return true
  const inByName = full.startsWith(root.endsWith(sep) ? root : root + sep)
  if (!inByName) return false
  // 名字在之内，还要看真实落点在不在之内。
  const realRoot = resolveReal(root)
  const realFull = resolveReal(full)
  if (realFull === realRoot) return true
  return realFull.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
}

/**
 * 把一份包的内容写进本领目录，并清掉包里不该有的东西。
 *
 * 覆盖是**整份**的：先全部写进去，再按结构规则收尾。后一半是为了「当初下成了
 * GitHub 的 `Source code`」那种情况——那些副本里多出 `.github/`、`AGENTS.md` 一类
 * 只在仓库里存在的文件，留着会一直碍事（宿主可能把它们当成这个 skill 的项目契约读进去）。
 *
 * **清理的判据是结构规则，不是一份人写的清单**（`lib/protocol.mjs` 的 `REPO_ONLY_DIRS`
 * 与 `REPO_ONLY_FILES`）：哪几处目录、哪几个顶层文件不进包，是一年可能都不变一次的决定，
 * 而不是「每加一个文件就要记得改一行」的流水账。清单会漏，结构规则不会。
 *
 * 顺带说明**什么不动**：使用者放在同一个目录里的其它文件（笔记、自己的临时文件）留着。
 * 覆盖的是「这个 skill 的文件」，不是把整个目录清空——顺手删掉别人的东西，比不更新坏。
 * 这里靠 `now`（包里真有的条目）与 keep 规则判，判不出来的一律留着并报出来。
 *
 * 顺序是「先写、后删」：写失败时目录还是原来那一份，不会剩下一半新一半旧。
 * **每个文件各自是原子的**（先写同目录的临时文件再改名），所以写到一半被杀留下的是
 * 「旧文件 + 新文件」的混合，而不是半截文件——半截的 SKILL.md 就是不可用的 skill，
 * 而包副本没有 .git，没有回退手段。整份一起原子（先解到临时目录再整体替换）代价与
 * 风险都更大，这里选择这一步，并在下面把没做完的部分照实报出来。
 */
function applyPackage(entries) {
  const removed = []
  const skipped = []
  const keptTemps = []
  const now = new Set(entries.map((e) => e.name))
  for (const e of entries) {
    const p = join(SKILL_ROOT, e.name)
    // 越界条目一律不写、报出来：正常包里不会有这种名字，出现即说明这一份不是它自称的东西。
    if (!insideSkill(p)) { skipped.push(e.name); continue }
    // 临时文件与目标同目录：改名在同分区上是原子的，跨分区就不是。
    // 它也必须落在本领目录之内——落在外面就说明这个条目指到了不该指的地方。
    if (!insideSkill(tempPathFor(p))) { skipped.push(e.name); continue }
    mkdirSync(dirname(p), { recursive: true })
    // 清掉这个文件此前的临时文件（上次被杀进程留下的）：判据与 lib/fs-atomic.mjs 共用一份，
    // 两处各写一份就会漂——而漂出来的后果是「一个脚本清得掉、另一个清不掉」。
    for (const k of clearStaleTemps(p).kept) keptTemps.push(basename(k))
    writeAtomic(p, e.data)
  }
  // 「删掉了」必须**删完再认**：不加这一句，删失败也会被算进清单，报告于是说了一件
  // 没发生的事——而使用者下次看到那些文件还在，只会以为这个工具在瞎报。
  const remove = (p) => {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    return !existsSync(p)
  }
  /**
   * 一个候选路径该不该清掉。三条判据，缺一不可：
   *   1. **它属于「不进包」的结构规则**（`isRepoOnlyPath`）——这是唯一的授权来源；
   *   2. **新包里没有它**（`now`）——新版真的带了它，那是刚写下去的，不是残留；
   *   3. **它落在本领目录之内**（`insideSkill`）。
   *
   * 第 3 条必须是第一句：`name` 有一部分来自下载回来的那份包，不是本地可信数据，
   * 而这一支走的是 `rmSync(recursive: true)`——一个伪造的发布包就能删掉使用者磁盘上
   * 任意目录，报告还会把它写成「顺手清掉了包里不该有的文件」。
   *
   * 授权来源从「旧副本自己那张表」换成了**结构规则**：规则是随代码走的常量，
   * 它不来自网络上的任何一份文档，所以伪造包改不动它；而它覆盖的情况一样全——
   * 下成 `Source code` 的副本里那些 `.github/`、`AGENTS.md`、`scripts/dev/`，
   * 一条规则都不差地命中。
   */
  // 第 2 条（`!now.has(name)`）在这两条路上一律成立，它挡不住误删：
  // zip 解压阶段就丢掉了目录条目（`zip.mjs` 的 `name.endsWith('/') → continue`），
  // 那五个顶层文件又都被 `export-ignore` 排除在包外——所以「新包里没有它」永远为真。
  //
  // 因此**能不能删，最终由「这份副本是不是只由包内容组成」决定**：包副本（没有 `.git`）
  // 里出现 `docs/`、`scripts/dev/`，只可能来自「下成了 Source code」那一种情况，
  // 删掉正是要收拾的残渣。而源码副本有 `.git`，那几处是**仓库自己的东西**，
  // 删掉等于把开发者的工作记录与自用脚本一起清空。
  //
  // 这一层不能省：`applyPackage` 只在包副本上被调用，但它是个独立的函数，
  // 判据写在调用点之外的任何地方，都会在下一次有人复用它时失效。
  const isPackageCopy = !existsSync(join(SKILL_ROOT, '.git'))
  // 三条判据缺一不可，第 0 条是「这不是源码副本」——没有它，一次误调用就会把开发者的
  // `docs/` 与 `scripts/dev/` 整棵删掉，而那两处正是这个仓库最贵的东西。
  const shouldRemove = (name) => isPackageCopy
    && isRepoOnlyPath(name) && !now.has(name) && insideSkill(join(SKILL_ROOT, name))
  // 磁盘上现有的、属于「不进包」结构规则的条目：目录整棵收，单文件逐个收。
  // 只走这一处，候选集来自**磁盘**而不是任何一张表——少一个来源就少一处会漂的地方。
  for (const dir of REPO_ONLY_PREFIXES) {
    const p = join(SKILL_ROOT, dir)
    if (!shouldRemove(dir)) continue
    if (existsSync(p)) {
      if (remove(p)) {
        removed.push(dir)
        pruneEmptyDirs(dirname(p))
      }
    }
  }
  for (const file of REPO_ONLY_FILES) {
    const p = join(SKILL_ROOT, file)
    if (!shouldRemove(file)) continue
    if (existsSync(p) && statSync(p).isFile()) {
      if (remove(p)) {
        removed.push(file)
        pruneEmptyDirs(dirname(p))
      }
    }
  }
  // 旧版本分发过、新包里已经没有的文件：**只报，不删**。
  //
  // 这一类不属于任何结构规则——它是「以前该有、现在没有」的遗留（典型：某个模块从
  // `scripts/` 搬进了 `scripts/lib/`）。留着它的代价是副本里多一个没人 import 的死文件。
  //
  // **但删它的代价更大**：包里的 SKILL.md 只说得出「我现在有什么」，说不出「我以前分发过
  // 什么」。而使用者自己的笔记完全可能就放在同一个目录里（`references/我的笔记.md` 是
  // 很自然的选择）。判据分不开这两种，就只能选那个不会造成损失的：
  // **列出来，让使用者自己决定删不删。**
  //
  // 判定范围是包里那三个由这个 skill 拥有的目录（`scripts/`、`references/`、`templates/`）；
  // 根目录一带不看——使用者放东西最主要的地方就是那里。
  const staleFiles = []
  for (const dir of ['scripts/', 'references/', 'templates/', 'kit/']) {
    const full = join(SKILL_ROOT, dir)
    if (!existsSync(full)) continue
    const owned = [...now].filter((n) => n.startsWith(dir))
    for (const e of readdirSync(full, { withFileTypes: true, encoding: 'utf8' })) {
      const rel = `${dir}${e.name}`
      if (isRepoOnlyPath(rel)) continue
      const hitOwned = owned.some((n) => n === rel || n.startsWith(`${rel}/`))
      if (!hitOwned) staleFiles.push(rel)
    }
  }
  // 空目录不再有用（新包里没有它），顺手收掉——只收空的，里面还有东西就留着。
  // 候选来自包里的条目：这是「新版本不再需要它」这一类残留，与上面那支的授权来源不同，
  // 但它只删空目录，删不掉任何有内容的东西。
  for (const entry of now) {
    if (!entry.endsWith('/')) continue
    const d = join(SKILL_ROOT, entry)
    if (!insideSkill(d)) { skipped.push(entry); continue }
    try {
      if (existsSync(d) && statSync(d).isDirectory() && readdirSync(d).length === 0) remove(d)
    } catch {
      // 同上：空目录不影响使用。
    }
  }
  return { removed, skipped, keptTemps: [...new Set(keptTemps)], staleFiles, mapRead: true }
}

/**
 * 装完之后验一次：**这份副本现在还能不能用**。
 *
 * 验的不是「写文件有没有报错」（那只能说明没崩），而是三件会真的让它不可用的事：
 *
 *   1. `SKILL.md` 还在，而且 frontmatter 读得出 `name` —— 读不出这个名字，宿主根本不会
 *      加载它，整个 skill 等于没装；
 *   2. 包里带的脚本，落盘之后**真的都在** —— 少了 `survey.mjs` 这类共用模块，
 *      别的脚本一跑就是 ERR_MODULE_NOT_FOUND；
 *   3. 版本号读得回来，而且与这次要装的版本一致 —— 这一条防的是「装的是旧包却报成功」，
 *      它与前面那条同源校验是同一条判据的两端。
 *
 * **这一步失败不抛异常**：文件已经写下去了，抛错只会让调用方拿不到「写到什么程度」。
 * 正确做法是把结论交回去，由报告说清「副本可能已不可用」，并**不要**烧掉 24 小时窗口。
 *
 * 存在的理由：这条路径的特殊风险是它没有退路——包副本是 `git archive` 解出来的，
 * **没有 .git**，写坏了没有 `git checkout` 可退。而「版本号对得上」并不证明内容完好：
 * 一个 SKILL.md 被截断、`scripts/` 少了几个文件的包，版本号照样对得上。
 */
function verifyInstalled(entries, after, remote) {
  const root = SKILL_ROOT

  const skillFile = join(root, 'SKILL.md')
  if (!existsSync(skillFile)) {
    return { ok: false, why: '装完之后 SKILL.md 不见了', hint: '这份副本已经不能用了。' }
  }
  const text = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : ''
  const name = /^name:[ \t]*(.+)$/m.exec(text)?.[1]?.trim()
  if (name === undefined || name === '') {
    return {
      ok: false,
      why: 'SKILL.md 的 frontmatter 里读不到 name（文件可能被截断）',
      hint: '宿主不会加载没有 name 的技能。',
    }
  }

  const expectScripts = (entries ?? [])
    .map((e) => String(e.name).replace(/\\/g, '/'))
    .filter((n) => /^scripts\/(?:lib\/(?:[^/]+\/)*)?[^/]+\.mjs$/.test(n))
  const missing = expectScripts.filter((rel) => !existsSync(join(root, rel)))
  if (missing.length > 0) {
    return {
      ok: false,
      why: `包里带了的 ${missing.length} 个脚本没有落盘（${missing.slice(0, 3).join('、')}）`,
      hint: '缺共用模块时，别的脚本一跑就会报找不到模块。',
    }
  }

  if (after === undefined) {
    return { ok: false, why: '装完之后读不到版本号', hint: `这次要装的是 ${remote}。` }
  }
  if (remote !== undefined && after !== remote) {
    return {
      ok: false,
      why: `装完的版本是 ${after}，而要装的是 ${remote}`,
      hint: '装进去的可能不是那一版。',
    }
  }

  return { ok: true }
}


/**
 * 兜底来源可以被一个环境变量覆盖。
 *
 * 为什么要它：转发的副本、内网发布、以及**自动化测试**都需要「把来源指到别处」而不改包里的
 * 任何文件。它只在**副本自己没记来源**时才起作用——`metadata.source` 是权威的，写了就用
 * 它（fork 出去自己发版的人正是靠这一条更新他自己的）。
 *
 * 名字叫 `PF_UPDATE_SOURCE`（`PF` = project-forge）：一个进程级、不与任何宿主绑定的名字。
 */
function fallbackSource() {
  const fromEnv = originUrl(process.env.PF_UPDATE_SOURCE)
  return fromEnv ?? originUrl(UPSTREAM)
}

/** 来源地址得是个 http(s) 地址，才谈得上「去哪儿取新版」。 */
function originUrl(source) {
  const s = String(source ?? '').trim()
  if (s === '') return undefined
  let url
  try {
    url = new URL(s)
  } catch {
    return undefined
  }
  // 只校协议与主机：**根路径也是合法来源**。靠「主机后面必须还有一段路径」的正则
  // 路径」，于是 `http://127.0.0.1:8080`、`http://mirror.internal:9000` 这类转发地址
  // 被静默拒绝——改了环境变量的人以为指到了内网，实际还在打硬编码的那个仓库。
  if (!/^https?:$/.test(url.protocol) || url.host === '') return undefined
  // 查询串与锚点会被拼进 `releases/latest` 的路径里，拼出一个不存在的地址；直接不接受。
  if (url.search !== '' || url.hash !== '') return undefined
  return (url.origin + url.pathname).replace(/\/+$/, '')
}

/** 源码副本：只读报告，一个字节都不写。 */
function reportSourceCopy(facts, { quiet }) {
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version
  if (!facts.hasGit) return 0
  report([
    `project-forge ${tag}：这是源码副本（目录里有 .git），不自动更新。`,
    '  它是拿来改的，工具不碰它；要更新就自己 git pull。',
  ], { quiet })
  return 0
}

/** 包副本但读不到来源：说清为什么，不假装查过。 */
function reportUnverifiable(facts, { quiet }) {
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version
  const missing = facts.source === undefined
    ? '这份副本没有记着自己是从哪儿来的（SKILL.md 的 metadata.source 没有或不成地址）'
    : '这份副本读不到自己属于哪一版（SKILL.md 的 metadata.version）'
  report([
    `project-forge ${tag}：${missing}，无法自动核对新版（这不是「已是最新」）。`,
    '  要更新就自己下载新版覆盖；写上一行 metadata.source（仓库地址）就能恢复自动核对。',
  ], { quiet })
  return 0
}

/**
 * 更新完 toolset 后，若目标工作区配备了 `.agents/skills/.pf-manifest.json`，
 * 顺带调用 equip 做三态无损刷新；失败不覆盖更新结论。
 */
function refreshEquippedWorkspace(targetDir, { explicit = false, quiet = false } = {}) {
  if (!targetDir) return { skipped: true, reason: 'no-target' }
  const root = resolve(targetDir)
  const kitDir = join(SKILL_ROOT, 'kit', 'skills')
  if (!existsSync(kitDir)) return { skipped: true, reason: 'no-kit-source' }
  if (!explicit) {
    if (root === SKILL_ROOT) return { skipped: true, reason: 'self-root' }
    if (!existsSync(join(root, PF_MANIFEST_REL))) return { skipped: true, reason: 'no-manifest' }
  }
  try {
    const res = equip(root, { kitDir })
    const summary = []
    if (res.added.length > 0) summary.push(`新增 ${res.added.length}`)
    if (res.upgraded.length > 0) summary.push(`升级 ${res.upgraded.length}`)
    if (res.retired.length > 0) summary.push(`退役清理 ${res.retired.length}`)
    if (res.conflicts.length > 0) summary.push(`保留魔改 ${res.conflicts.length}`)
    if (res.orphanedModified.length > 0) summary.push(`保留退役魔改 ${res.orphanedModified.length}`)
    if (summary.length > 0 || explicit) {
      report([
        `  已顺带检查/刷新 ${root} 的 .agents/skills/：${summary.length > 0 ? summary.join('、') : '已是最新（幂等跳过）'}。`,
      ], { quiet, always: summary.length > 0 })
    }
    return { skipped: false, result: res }
  } catch (err) {
    report([
      `  顺带刷新 .agents/skills/ 未成功（${err instanceof Error ? err.message : String(err)}），请稍后手动运行 equip.mjs。`,
    ], { quiet, always: true })
    return { skipped: true, reason: 'error' }
  }
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage()); return 0 }
  let checkOnly = false
  let quietFlag = false
  let equipTarget
  const unknown = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--quiet') quietFlag = true
    else if (arg === '--check') checkOnly = true
    else if (arg === '--equip') {
      const next = argv[++i]
      if (!next) { unknown.push('--equip'); break }
      equipTarget = next
    } else if (arg.startsWith('--equip=')) {
      const val = arg.slice('--equip='.length)
      if (!val) { unknown.push(arg); break }
      equipTarget = val
    } else {
      unknown.push(arg)
    }
  }

  if (unknown.length > 0) {
    process.stderr.write(`错误：未知参数 ${unknown.join(' ')}\n\n${usage()}`)
    return 2
  }
  // --check 是人主动问的，它要看到全部状态；与 --quiet 同时给时以 --check 为准。
  const quiet = quietFlag && !checkOnly

  // 宿主或流水线可以整个关掉自动更新：`PF_NO_UPDATE` 有值就不联网、不写盘、不出声。
  //
  // 为什么要这个开关：这个脚本挂在**每个任务的开头**，而有几类环境根本不该让它说话——
  // 宿主禁止 skill 自改（沙箱只读、审计要求）、离线构建机、以及「这次别动我的安装目录」。
  // 原先这些环境只能靠「断开网络」或「有 .git」凑出来，两条都不是使用者能直接表达的意图。
  // 与 `PF_UPDATE_SOURCE` 同一族：一个进程级、不与任何宿主绑定的名字。
  //
  // **`--check` 不受它管**：那个参数是人主动敲的，他要的就是一句真话；一声不响地退出
  // 会让人以为这个开关坏了。自动那条路才需要安静。
  if (!checkOnly && (process.env.PF_NO_UPDATE ?? '') !== '') return 0

  const facts = readFacts()
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version

  // 源码副本：只读报告，到此为止。这条不联网，也就没有窗口的理由。
  if (facts.hasGit) {
    const code = reportSourceCopy(facts, { quiet })
    if (equipTarget && !checkOnly) refreshEquippedWorkspace(equipTarget, { explicit: true, quiet })
    return code
  }

  // 来源**先看副本自己记的那个**：fork 出去自己发版的人写了自己的地址，就该更新他自己的；
  // 读不到或不成地址时退回兜底地址（`PF_UPDATE_SOURCE`，没设就是这段代码自己写着的那个）。
  //
  // 兜底那一支要的是**地址本身**，不是 `repoPath` 归一出来的 `owner/name`——后者是拿来
  // 比对的形状，不含协议与主机，喂给下载函数会拼出一个非法 URL（现象是更新静默失效）。
  const source = originUrl(facts.source) ?? fallbackSource()
  if (source === undefined || facts.version === undefined) return reportUnverifiable(facts, { quiet })

  const state = readState()
  const sinceUpdate = Date.now() - state.lastUpdateAt
  // **窗口与 --check 是两件事**：窗口说的是「换不换文件」，--check 说的是「报不报」。
  // 合成一个变量就会出事：--check 是「把结论说出来」这个参数，而它会把窗口那件事本身
  // 绕过去——「刚更新过，还要等多久」这句话永远轮不到输出，而那正是人在问的东西。
  const inWindow = sinceUpdate < UPDATE_INTERVAL_MS

  // 节流：距上次**真的问到了远端版本**不足一小时，就不再联网。
  //
  // 判据只能是 `lastOkAt`（那次真的核对上了），不能用 `lastUpdateAt`（那次换了文件）：
  // 后者在一小时内可能一直是 0，而版本早就核对过；用它判会退化成「每次都联」。
  //
  // **只管 `--quiet` 那条路**——那是 skill 在每次任务开头自动跑的模式，也是省下这笔钱
  // 唯一有意义的地方。人自己敲的命令（不带参数，或带 `--check`）是来问问题的：他要知道
  // 「有没有新版、还要等多久、这次为什么没换成」，而这些答案必须当场算出来。把它也节流，
  // 省下的是使用者最有理由期待答案的那一次。
  //
  // 节流时不刷新 `lastOkAt`：那个字段的含义是「上一次真的核对上了」，刷新它等于把
  // 「多久没核对过」这件事抹平，下面那条「已经很久没能核对上了」的提醒就永远不会出现。
  if (quiet && state.lastOkAt !== 0 && Date.now() - state.lastOkAt < CHECK_INTERVAL_MS) {
    return 0
  }

  // ── 一：比版本 ────────────────────────────────────────────────────────────
  // 两条路按顺序试。**只有「这条路这次没走通」才换下一条**——但「那边没有最新发布」
  // 也要继续试：两条路问的是同一个问题，接口路 404 可能只是这个地址不对（来源被转发过、
  // 或仓库换了名字），而网页路往往问得出来。早先的写法是「404 也算有结论、直接跳出」，
  // 结果是一次接口地址拼错就让整条更新链路退化成「每次都下整包」。
  let found = { state: 'unreachable' }
  let absent = false
  for (const route of routesFor(source)) {
    const probe = route.kind === 'api'
      ? await probeApi(route.endpoint, source)
      : await probeWeb(route.endpoint, source)
    if (probe.state === 'ok') { found = probe; break }
    if (probe.state === 'absent') absent = true
  }
  // 两条路都没问到标签、但至少有一条明确说过「那边没有最新发布」：这才是结论。
  // 反过来，两条都只是连不上，那属于「这次没能核对」，与「没有发布」是两件事。
  if (found.state !== 'ok' && absent) found = { state: 'absent' }

  if (found.state === 'unreachable') {
    // 没连上不是「已是最新」。**偶尔一次不吭声**——下次再用就自己好了；但隔久了还没能
    // 核对上就要说一句：使用者会把一路静默读成「一切正常」，而真相是这份停在了某一版。
    // 说过之后同样隔那么久才会再说，所以它不会变成每次任务都念一遍的噪音。
    const neverChecked = state.lastOkAt === 0
    const staleFor = neverChecked ? 0 : Date.now() - state.lastOkAt
    const spokeRecently = Date.now() - state.lastNoticeAt < STALE_CHECK_MS
    if (!spokeRecently && (neverChecked || staleFor >= STALE_CHECK_MS)) {
      // --check 是人主动问的，它每次都要说真话，所以它不参与「说话的节奏」。
      if (!checkOnly) rememberState({ lastNoticeAt: Date.now() })
      report([
        neverChecked
          ? `project-forge ${tag}：一直没能连上发布方核对新版，这份停在 ${tag}（不是「已是最新」）。`
          : `project-forge ${tag}：已经 ${durationText(staleFor)}没能核对新版了，这份停在 ${tag}（不是「已是最新」）。`,
        '  核对不上不影响它干活，只是会一直停在这个版本；换一个能连上发布方的网络就能恢复。',
      ], { quiet, always: true })
      return 0
    }
    report([`project-forge ${tag}：这次没能联网核对（不是「已是最新」）。`], { quiet })
    return 0
  }

  // 核对上了：记下时刻。它决定上面那句提醒该不该出现。
  rememberState({ lastOkAt: Date.now() })

  // 问不到标签（平台没有最新发布）时，退回「取整包读版本」。
  // 那条路要下整包，所以只在真需要更新时才走——而「需不需要」得先读出来才知道，
  // 于是这里退化成「下载一次，顺手就当更新用」，不做第二遍下载。
  let latest
  let remote
  if (found.state === 'ok') {
    remote = found.version
  } else {
    latest = await fetchPackage(latestPackageUrl(source))
    if (!latest.ok) {
      report([`project-forge ${tag}：这次没能联网核对（不是「已是最新」）。`], { quiet })
      return 0
    }
    remote = latest.version
  }

  if (remote === undefined) {
    report([`project-forge ${tag}：最新版读不到版本号，无法判断有没有新版。`], { quiet })
    return 0
  }
  const newer = isNewer(remote, facts.version)
  if (newer === undefined) {
    report([`project-forge ${tag}：版本号形状认不出来（远端是 ${remote}），跳过（不猜）。`], { quiet })
    return 0
  }
  if (!newer) {
    report([`project-forge ${tag}：已是最新。`], { quiet })
    return 0
  }
  // 窗口内不换文件，但**照常比版本、照样说清**：下次自动换要等多久，以及现在这份
  // 还能不能继续用。沉默地「什么都不做」会让使用者以为更新坏了，而愿意自己动手的人
  // 也需要知道「不用等，去下载新版覆盖」这条出路。
  if (inWindow) {
    const left = UPDATE_INTERVAL_MS - sinceUpdate
    report([
      `project-forge ${tag}：有新版本 ${remote}。这份副本刚更新过，`,
      `  ${durationText(left)}之后再自动换；这次继续用现在这份就够（想马上要新版，去发布页下载覆盖）。`,
    ], { quiet, always: true })
    return 0
  }
  if (checkOnly) {
    report([`project-forge ${tag}：有新版本 ${remote}（--check 只报告，没有更新）。`], { quiet })
    return 0
  }

  // ── 二：下载新版（上面没下过才下） ────────────────────────────────────────
  // 候选地址按优先顺序试：接口路给的那条在前（它走资产主机，**不碰网页主机**），网页
  // 那条在后。一条取不到就换下一条——两处说的是同一版，只是取法不同。
  if (latest === undefined) {
    for (const candidate of found.packageUrls ?? webPackageUrls(source)) {
      latest = await fetchPackage(candidate.url, candidate.accept)
      if (latest.ok) break
    }
  }
  if (!latest.ok) {
    report([`project-forge ${tag}：新版没取回来（${latest.why}），没有更新，这份还是原样。`],
      { quiet, always: true })
    return 1
  }

  // ── 同源校验：**装进来的那一份必须就是刚才说要装的那一版** ─────────────────
  //
  // 比的是标签、装的是附件，而这两样来自平台上两个不同的地方：附件可以被人换、被旧的
  // 缓存顶着、fork 沿用了同一个附件名。不核对时，真发生那种事的结果有两种，都很坏：
  // 装进来的其实是旧版（**静默降级**，而报告说「已更新到最新版」），或者装进来的版本
  // 与本地同号（白写一遍文件、还占掉 24 小时窗口）。所以：不一致就一个字节都不写，
  // 把两个版本都报出来。
  //
  // 只在问到了标签时才比（退回取整包那条路上，版本就是从包里读的，没有第二个来源可比）。
  if (found.state === 'ok' && latest.version !== remote) {
    report([
      `project-forge ${tag}：最新发布是 ${remote}，但那个安装包里的却是 ${latest.version ?? '读不到版本'}`
        + ' —— 两处对不上，这次**没有更新**，你这份还是原样。',
      '  多半是附件被换过、或缓存顶着旧包。去发布页确认那一版的附件，或手工下载覆盖。',
    ], { quiet, always: true })
    return 1
  }

  // ── 三：整份覆盖 ──────────────────────────────────────────────────────────
  //
  // 覆盖之后**必须验收**，不能只信「写文件没抛异常」。
  //
  // 这条路径的特殊风险是它没有退路：包副本是 `git archive` 解出来的，**没有 .git**，
  // 写坏了没有 `git checkout` 可退。而「版本号对得上」并不能证明内容完好——一个
  // SKILL.md 被截断、`scripts/` 少了几个文件的包，版本号照样对得上。旧写法在这里
  // 直接把 `localVersion()` 读回来就宣布成功，读不到时甚至用远端版本号顶上。
  const { removed, skipped, keptTemps, staleFiles } = applyPackage(latest.entries)
  const after = localVersion()
  const health = verifyInstalled(latest.entries, after, remote)

  // **验收不通过就不烧掉 24 小时窗口**：否则修好之后再跑，还要白等一天。
  // 窗口的语义是「多久之内不要重复联网问」，而一次失败的安装根本没有「成功过」可言。
  if (health.ok) rememberState({ lastUpdateAt: Date.now() })

  const versionText = after === undefined
    ? `project-forge 的文件已换成 ${remote} 那一份，但版本号读不出来`
    : `project-forge 已更新到最新版 ${after} —— 你之前用的是 ${tag}。`
  report([
    health.ok ? versionText : `project-forge 更新了文件，但**验收没过**：${health.why}`,
    health.ok
      ? '  这个 skill 的文件换了，我重新读一遍 SKILL.md 再继续。'
      : `  你这份副本可能已经不可用。${health.hint ?? ''}`,
    health.ok ? undefined : '  重新跑一次更新可以再试；仍然不行就手工下载后覆盖整个目录。',
    removed.length > 0
      ? `  清掉了 ${removed.length} 处只属于仓库的东西（${removed.slice(0, 3).join('、')}${removed.length > 3 ? ' 等' : ''}）`
        + '——那些是「下成 Source code」时多出来的，用户包里本来没有它们。'
        + '如果你在那些地方放过自己的东西，现在去回收站或 git 历史里找。'
      : undefined,
    skipped.length > 0
      ? `  有 ${skipped.length} 个条目指向本领目录之外，已跳过（${skipped.slice(0, 3).join('、')}）`
        + ' —— 正常的包里不会有这种名字，这一份值得核对一下来源。'
      : undefined,
    keptTemps.length > 0
      ? `  有 ${keptTemps.length} 个同前缀但不属于本次运行的临时文件，没动（${keptTemps.slice(0, 3).join('、')}${keptTemps.length > 3 ? ' 等' : ''}）。`
      : undefined,
    staleFiles.length > 0
      ? `  这几个文件在新版包里没有，可能是旧版遗留、也可能是你自己放的：`
        + `${staleFiles.slice(0, 5).join('、')}${staleFiles.length > 5 ? ' 等' : ''}。`
        + ' 我没有删——分清它是哪一种要靠你判断。'
      : undefined,
  ], { quiet, always: true })
  if (health.ok) {
    refreshEquippedWorkspace(equipTarget || process.cwd(), { explicit: Boolean(equipTarget), quiet })
  }
  return 0
}

// 分成两块顺手带出一个可测性：文件被 import 时只交出判据，与它被当成脚本跑时一样的东西。
// 自检就靠这个核对「兜底地址」「静默期」「提醒节奏」没有另抄一份值，并直接验排路的规则。
export { UPSTREAM, UPDATE_INTERVAL_MS, STALE_CHECK_MS, apiEndpoint, routesFor, refreshEquippedWorkspace }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      // 顶层兜底：**任何没预料到的异常也要变成一句人话 + 一个退出码**。
      // 少了这一段，未处理的 promise rejection 会让进程带着一整段栈死掉，
      // 而在这条链路上「崩了」与「更新完了」在调用方眼里没有区别——
      // 退出码 1 至少还能被读成「这次没成」。
      process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
