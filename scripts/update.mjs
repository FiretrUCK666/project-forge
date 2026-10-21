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
 *   1. **比版本**：问一次「最新版是哪个标签」（一个请求、几十 KB 的元数据，不下整包），
 *      与本地版本比。不是更新版就结束——这是绝大多数时候，所以这一步必须便宜。
 *
 *      **问谁有两条路，按顺序试**（见 `routesFor`）：
 *
 *        - **接口路**：托管平台给程序用的接口。一次请求同时给出标签与「那一版的附件在
 *          哪儿取」，**整条链路不碰网页主机**——而网页主机恰是最容易时通时不通的那一环，
 *          它的接口主机往往另有一套、稳得多；
 *        - **网页路**：网页地址。平台认不出来时（自建镜像、别的托管平台）只有这条路，
 *          它同时是接口路的退路。
 *
 *      两条都问不到才算「没能核对」。**认不出平台就不猜**：给自建镜像硬拼一个接口地址，
 *      换来的是一句看起来像事实的「那边没有最新发布」。
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
 *   --check   只报告不更新，不受窗口限制（人主动问的时候用）
 *
 * 退出码：0 = 无事或已更新；1 = 尝试更新但失败；2 = 用法错误。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readFileMap, skillSource, skillVersion, isMainModule } from './survey.mjs'
import { readZip, stripCommonPrefix } from './zip.mjs'
// 临时文件的**形状与归属判据**只有一份，住在 sync-toc.mjs：compose-agents.mjs 从那里取，
// 本文件也取。两处各写一份就会漂——而漂出来的后果是「一个脚本清得掉残留、另一个把
// 使用者自己的文件也删了」。
import { clearStaleTemps, tempPathFor } from './sync-toc.mjs'

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
/** 单次网络动作的上限。它挂在每个任务的开头，卡住就等于把任务卡住。 */
const NETWORK_TIMEOUT_MS = 10 * 1000
/** 附件名。固定不带版本号，`releases/latest/download/<这个名字>` 才永远指向最新版。 */
const ASSET = 'project-forge.zip'

/** 状态按副本路径分开：一份副本的更新不该替另一份做决定。 */
const STATE_PATH = join(tmpdir(),
  `project-forge-update-${createHash('sha1').update(SKILL_ROOT).digest('hex').slice(0, 12)}.json`)

function usage() {
  return [
    '用法：node scripts/update.mjs [--quiet] [--check]',
    '',
    '  检查这个 skill 的副本有没有新版；有就整份换成新版。',
    '',
    '  有 .git 的副本是源码副本：只读报告，一个字节都不写（更新请自己 git pull）。',
    '  没有 .git 的是包副本：比版本、下载新版、整份覆盖。',
    '',
    '  --quiet   只在「真的更新了」时输出',
    '  --check   只报告不更新，也不受 24 小时窗口限制',
    '',
    '  来源：优先用副本自己记的那个（SKILL.md 的 metadata.source）；读不到时用兜底地址，',
    '  可用环境变量 PF_UPDATE_SOURCE 改（自建镜像、内网发布用）——它只在副本没记来源时生效。',
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
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolvePromise({ ok: true, status: 200, final, body: Buffer.concat(chunks) }))
      res.on('error', () => resolvePromise({ ok: false, status: 0, final }))
    })
    request.on('timeout', () => { request.destroy(); resolvePromise({ ok: false, status: 0, final }) })
    request.on('error', () => resolvePromise({ ok: false, status: 0 }))
  })
}

/**
 * 托管平台给程序用的那套接口，地址由网页地址推出来。
 *
 * 判据是**平台自己公布的地址规律**（网页是 `<主机>/<owner>/<仓库>`，接口是
 * `api.<主机>/repos/<owner>/<仓库>`），不是猜。认不出来（自建镜像、别的托管平台、
 * 形状不对的地址）就返回 `undefined`——**不猜**：给一个不会应答的地方硬拼出接口路径，
 * 换来的是一句看起来像事实的「那边没有最新发布」，而正确结论是「这里问不出来」。
 */
function apiEndpoint(source) {
  let url
  try {
    url = new URL(source)
  } catch {
    return undefined
  }
  if (url.hostname !== 'github.com') return undefined
  const segments = url.pathname.split('/').filter((s) => s !== '')
  if (segments.length !== 2) return undefined
  return `https://api.github.com/repos/${segments[0]}/${segments[1]}/releases/latest`
}

/**
 * 问发布方这件事，按优先顺序排好的路。
 *
 * 两条路的差别不只是地址。**接口路一次请求同时给出标签与附件的取用地址**，于是整条
 * 更新链路只碰「接口主机 + 资产主机」；网页路拿不到附件地址，下载只能回到网页主机上
 * 那个固定地址。所以多这一条路的意义不止「多试一次」，而是**换掉整条链路里最不稳的
 * 那一段**——网页主机恰恰是时通时不通得最厉害的一环。
 *
 * 来源是自建镜像时只排得出网页路。那不是退步，是如实：镜像不提供接口，就没有接口路。
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
  // 早年这里拿 `repoPath` 当门槛，于是自建镜像给的 `http://host:port` 被挡在门外，
  // 而挡的方式是「那边没有最新发布」——一个看起来像事实的错误结论。
  const res = await download(endpoint, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }

  // 一：**看它最后落在哪个地址**。托管平台的 `releases/latest` 会跳到那一版的页面，
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
  // 预发布后缀（`0.16.0-beta.1`）按主号比：使用者要的是「比我这版新」，
  // 而形状认不出来时这里会返回 undefined，整条更新路径就静默跳过了——那才是坏结果。
  const parse = (v) => {
    const parts = plainVersion(v).split(/[-+]/)[0].split('.')
      .map((x) => (/^\d+$/.test(x) ? Number(x) : undefined))
    return parts.length > 0 && parts.every((x) => x !== undefined) ? parts : undefined
  }
  const a = parse(candidate)
  const b = parse(current)
  if (a === undefined || b === undefined) return undefined
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
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
  while (current !== SKILL_ROOT && current.startsWith(SKILL_ROOT)) {
    try {
      if (!existsSync(current) || !statSync(current).isDirectory()) break
      if (readdirSync(current).length > 0) break
      rmSync(current, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      break
    }
    current = dirname(current)
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
 */
function insideSkill(target) {
  const full = resolve(target)
  if (full === SKILL_ROOT) return true
  return full.startsWith(SKILL_ROOT.endsWith(sep) ? SKILL_ROOT : SKILL_ROOT + sep)
}

/**
 * 把一份包的内容写进本领目录，并清掉包里不该有的东西。
 *
 * 覆盖是**整份**的：先全部写进去，再删掉旧包里已经不存在、以及「仓库自用」那些文件。
 * 后一半是为了「当初下成了 GitHub 的 Source code」那种情况——那些副本里多出
 * `.github/`、`AGENTS.md` 一类只在仓库里存在的文件，留着会一直碍事（宿主可能把它们
 * 当成这个 skill 的项目契约读进去）。判据取自文件地图的排除表，不另抄一份清单。
 *
 * 顺带说明**什么不动**：使用者放在同一个目录里的其它文件（笔记、自己的临时文件）留着。
 * 覆盖的是「这个 skill 的文件」，不是把整个目录清空——顺手删掉别人的东西，比不更新坏。
 *
 * 顺序是「先写、后删」：写失败时目录还是原来那一份，不会剩下一半新一半旧。
 * **每个文件各自是原子的**（先写同目录的临时文件再改名），所以写到一半被杀留下的是
 * 「旧文件 + 新文件」的混合，而不是半截文件——半截的 SKILL.md 就是不可用的 skill，
 * 而包副本没有 .git，没有回退手段。整份一起原子（先解到临时目录再整体替换）代价与
 * 风险都更大，这里选择这一步，并在下面把没做完的部分照实报出来。
 */
function applyPackage(entries) {
  // 判据取自**装进来这一份**的地图，而不是磁盘上旧那一份：
  //   - 它才是「更新之后应该有什么」的定义，而清理问的正是那个问题；
  //   - 旧副本的地图读不出来时（被改过、被截断、版本太老），按旧地图清理会**静默做半件事**
  //     ——包照换、文件照写、报告照说「已更新」，而该清的一个都没清。那时包内这份地图
  //     仍然在，于是这种情况从根上不发生。
  const packSkill = entries.find((e) => e.name === 'SKILL.md')?.data.toString('utf8')
    ?? skillText() ?? ''
  const map = readFileMap(packSkill)
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
    // 清掉这个文件此前的临时文件（上次被杀进程留下的）：判据与 sync-toc.mjs 共用一份，
    // 两处各写一份就会漂——而漂出来的后果是「一个脚本清得掉、另一个清不掉」。
    for (const k of clearStaleTemps(p).kept) keptTemps.push(k.name)
    writeAtomic(p, e.data)
  }
  // 旧包里已被删掉的文件：留着就是一份永远没人读的残留。
  for (const name of map.shipped.filter((x) => !x.endsWith('/'))) {
    if (now.has(name)) continue
    const p = join(SKILL_ROOT, name)
    if (!insideSkill(p)) { skipped.push(name); continue }
    if (existsSync(p) && statSync(p).isFile()) { rmSync(p); removed.push(name) }
  }
  // 仓库自用文件：包里本来就不该有。
  //
  // 「删掉了」必须**删完再认**：不加这一句，删失败也会被算进清单，报告于是说了一件
  // 没发生的事——而使用者下次看到那些文件还在，只会以为这个工具在瞎报。
  const remove = (p) => {
    rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    return !existsSync(p)
  }
  for (const name of map.repoOnly) {
    const p = join(SKILL_ROOT, name)
    try {
      const kind = name.endsWith('/') ? 'dir' : 'file'
      const hit = kind === 'dir' ? statSync(p, { throwIfNoEntry: false })?.isDirectory()
        : statSync(p, { throwIfNoEntry: false })?.isFile()
      if (hit === true && remove(p)) {
        removed.push(name)
        pruneEmptyDirs(dirname(p))
      }
    } catch {
      // 删不掉就**不报**：它不影响使用，为它让整次更新失败不值得，但也不能谎报。
    }
  }
  // 表里带 `../` 这种名字的：不删不写，报出来。它只会出现在「这一份不是它自称的东西」时。
  for (const name of map.repoOnly) {
    if (!insideSkill(join(SKILL_ROOT, name))) skipped.push(name)
  }
  // 空目录不再有用（新包里没有它），顺手收掉——只收空的，里面还有东西就留着。
  for (const entry of map.shipped) {
    if (!entry.endsWith('/')) continue
    const d = join(SKILL_ROOT, entry)
    if (!insideSkill(d)) { skipped.push(entry); continue }
    try {
      if (existsSync(d) && statSync(d).isDirectory() && readdirSync(d).length === 0) remove(d)
    } catch {
      // 同上：空目录不影响使用。
    }
  }
  // 两张表都空 = 地图没读出来（文件地图的小标题被改过、或包里的 SKILL.md 不是这个格式）。
  // 这时清理**什么都没做**，而「什么都没做」与「确实没东西要清」必须分得开：前者要说出来，
  // 否则使用者的副本里会一直留着 `.github/`、`AGENTS.md`，而报告说这次更新一切正常。
  return {
    removed,
    skipped,
    keptTemps: [...new Set(keptTemps)],
    mapRead: map.shipped.length > 0 || map.repoOnly.length > 0,
  }
}

/**
 * 写一个文件：先写同目录的临时文件，再改名。
 *
 * **为什么**：改名的原子性让「写到一半被杀」不再留下半截文件。包副本没有 .git，
 * 半截的 SKILL.md 就是不可用的 skill，而且没有回退手段（源码副本有 git，那是另一条路，
 * 不走这里）。
 *
 * 失败时清掉自己的临时文件：它带着 `.tmp-` 后缀留在本领目录里，会被结构自检当成无主文件。
 */
function writeAtomic(path, data) {
  const tmp = tempPathFor(path)
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
    throw error
  }
}
/**
 * 兜底来源可以被一个环境变量覆盖。
 *
 * 为什么要它：自建镜像、内网发布、以及**自动化测试**都需要「把来源指到别处」而不改包里的
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
  // 只校协议与主机：**根路径也是合法来源**。以前靠一条正则要求「主机后面必须还有一段
  // 路径」，于是 `http://127.0.0.1:8080`、`http://mirror.internal:9000` 这类自建镜像
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

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage()); return 0 }
  const unknown = argv.filter((a) => a !== '--quiet' && a !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`错误：未知参数 ${unknown.join(' ')}\n\n${usage()}`)
    return 2
  }
  const checkOnly = argv.includes('--check')
  // --check 是人主动问的，它要看到全部状态；与 --quiet 同时给时以 --check 为准。
  const quiet = argv.includes('--quiet') && !checkOnly

  const facts = readFacts()
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version

  // 源码副本：只读报告，到此为止。这条不联网，也就没有窗口的理由。
  if (facts.hasGit) return reportSourceCopy(facts, { quiet })

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

  // ── 一：比版本 ────────────────────────────────────────────────────────────
  // 两条路按顺序试。**只有「这条路这次没走通」才换下一条**：「那边没有最新发布」是
  // 结论，换个地方再问一遍问不出不同的答案，白白多等一个超时。
  let found = { state: 'unreachable' }
  for (const route of routesFor(source)) {
    found = route.kind === 'api'
      ? await probeApi(route.endpoint, source)
      : await probeWeb(route.endpoint, source)
    if (found.state !== 'unreachable') break
  }

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
  const { removed, skipped, keptTemps, mapRead } = applyPackage(latest.entries)
  const after = localVersion()
  rememberState({ lastUpdateAt: Date.now() })
  report([
    `project-forge 已更新到最新版 ${after ?? remote} —— 你之前用的是 ${tag}。`,
    '  这个 skill 的文件换了，我重新读一遍 SKILL.md 再继续。',
    removed.length > 0
      ? `  顺手清掉了 ${removed.length} 个包里不该有的文件（${removed.slice(0, 3).join('、')}${removed.length > 3 ? ' 等' : ''}）。`
      : undefined,
    skipped.length > 0
      ? `  有 ${skipped.length} 个条目指向本领目录之外，已跳过（${skipped.slice(0, 3).join('、')}）`
        + ' —— 正常的包里不会有这种名字，这一份值得核对一下来源。'
      : undefined,
    keptTemps.length > 0
      ? `  有 ${keptTemps.length} 个同前缀但不属于本次运行的临时文件，没动（${keptTemps.slice(0, 3).join('、')}${keptTemps.length > 3 ? ' 等' : ''}）。`
      : undefined,
    mapRead ? undefined
      : '  这份包里的文件地图读不出来，所以没有清理「包里不该有」的残留文件'
        + '（`.github/`、`AGENTS.md` 一类会一直留着；下次更新若恢复正常，会自动清掉）。',
  ], { quiet, always: true })
  return 0
}

// 分成两块顺手带出一个可测性：文件被 import 时只交出判据，与它被当成脚本跑时一样的东西。
// 自检就靠这个核对「兜底地址」「静默期」「提醒节奏」没有另抄一份值，并直接验排路的规则。
export { UPSTREAM, UPDATE_INTERVAL_MS, STALE_CHECK_MS, apiEndpoint, routesFor }

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
