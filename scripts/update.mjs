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
 *   1. **比版本**：问一次「最新版是哪个标签」（一个请求，几十 KB 的元数据，不下整包），
 *      与本地版本比。不是更新版就结束——这是绝大多数时候。
 *   2. **看窗口**：距上次成功更新不足 24 小时就不换文件（检查照跑，所以新版一发布
 *      就看得见，只是等窗口过完才动手）。窗口的用处是**不让同一份副本一天换好几次**：
 *      换文件会改掉磁盘上的内容，频繁换对正在读它的会话不友好。
 *   3. **换**：下载新版整包 → 整份覆盖 → 说一句 → 记下时刻。
 *
 * **版本号只有标签一个来源，不在这里另记一份。** 问标签、或读包里 `SKILL.md` 的
 * `metadata.version`，两者都由发版门禁保证同号；这个脚本不生成、不维护任何版本清单
 * ——多一份要人记得同步的东西，迟早会不同步。
 *
 * 任何一步不成立（没网、取不到、包读不动）→ **什么都不做，一个字节不写**，下次再用
 * 重试。所以不存在「更新到一半」的状态：要么整份换好，要么跟没跑过一样。失败也不占
 * 那 24 小时的额度——占了就等于「一次断网，今天不再更新」。
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

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readFileMap, repoPath, skillSource, skillVersion } from './survey.mjs'
import { readZip, stripCommonPrefix } from './zip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

/** 更新成功后的静默期：这段时间里不再换文件，但照常比版本。 */
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
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
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, 'utf8').replace(/^\uFEFF/, ''))
    const t = Number(raw?.lastUpdateAt)
    return { lastUpdateAt: Number.isFinite(t) ? t : 0 }
  } catch {
    return { lastUpdateAt: 0 }
  }
}

function rememberUpdate() {
  try {
    writeFileSync(STATE_PATH, `${JSON.stringify({ lastUpdateAt: Date.now() })}\n`, 'utf8')
  } catch {
    // 写不进去只是失去窗口，不影响正确性：下次再查一遍就是了。
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
function download(url, { redirects = 5, accept = '*/*' } = {}) {
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
        resolvePromise(download(new URL(location, url).toString(), { redirects: redirects - 1, accept }))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        resolvePromise({ ok: false, status: statusCode ?? 0 })
        return
      }
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolvePromise({ ok: true, status: 200, body: Buffer.concat(chunks) }))
      res.on('error', () => resolvePromise({ ok: false, status: 0 }))
    })
    request.on('timeout', () => { request.destroy(); resolvePromise({ ok: false, status: 0 }) })
    request.on('error', () => resolvePromise({ ok: false, status: 0 }))
  })
}

/**
 * 问发布方「最新版是哪个标签」。
 *
 * 这是**每次使用都会走的那一步**，所以它必须便宜：一个请求、不下整包。版本号来自
 * 标签本身——项目里版本号只有一个来源就是标签，这里不去读任何「版本清单」文件，
 * 也就不会多出一份要人记得同步的东西。
 *
 * 三种结果必须分得开：「问到了」「那边没有最新发布」「没连上」。后两种走的路不一样。
 */
async function fetchLatestTag(source) {
  const repo = repoPath(source)
  if (repo === undefined) return { state: 'absent' }
  const res = await download(`${source}/releases/latest`, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }
  try {
    const tag = JSON.parse(res.body.toString('utf8'))?.tag_name
    const version = typeof tag === 'string' ? plainVersion(tag) : ''
    return version !== '' ? { state: 'ok', version } : { state: 'absent' }
  } catch {
    return { state: 'absent' }
  }
}

/** 下载一份包并解开，顺带读出它的版本。任何一个环节不成立都不返回半份内容。 */
async function fetchPackage(url) {
  const res = await download(url)
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

/** 最新版的包地址。附件名固定不带版本号，所以这个地址永远指向最新版。 */
function latestPackageUrl(source) {
  return `${source}/releases/latest/download/${ASSET}`
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

/** 人话的剩余时间：用来告诉用户「等多久会更新」，不写内部毫秒数。 */
function waitText(ms) {
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
 */
function applyPackage(entries) {
  const map = readFileMap(skillText() ?? '')
  const removed = []
  const now = new Set(entries.map((e) => e.name))
  for (const e of entries) {
    const p = join(SKILL_ROOT, e.name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, e.data)
  }
  // 旧包里已被删掉的文件：留着就是一份永远没人读的残留。
  for (const name of map.shipped.filter((x) => !x.endsWith('/'))) {
    if (now.has(name)) continue
    const p = join(SKILL_ROOT, name)
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
  // 空目录不再有用（新包里没有它），顺手收掉——只收空的，里面还有东西就留着。
  for (const entry of map.shipped) {
    if (!entry.endsWith('/')) continue
    const d = join(SKILL_ROOT, entry)
    try {
      if (existsSync(d) && statSync(d).isDirectory() && readdirSync(d).length === 0) remove(d)
    } catch {
      // 同上：空目录不影响使用。
    }
  }
  return removed
}

/** 来源地址得是个 http(s) 地址，才谈得上「去哪儿取新版」。 */
function originUrl(source) {
  const s = String(source ?? '').trim().replace(/\/+$/, '')
  return /^https?:\/\/[^\s/]+\/.+/i.test(s) ? s : undefined
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
    ? '副本里没有记着自己是从哪儿来的（SKILL.md 的 metadata.source）'
    : '本机读不到 git，也读不到这个副本的来源'
  report([
    `project-forge ${tag}：${missing}，无法自动核对新版（这不是「已是最新」）。`,
    '  更新方式见 README 的「更新」一节（下载新版覆盖）。',
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

  const source = originUrl(facts.source)
  if (source === undefined || facts.version === undefined) return reportUnverifiable(facts, { quiet })

  const { lastUpdateAt } = readState()
  const sinceUpdate = Date.now() - lastUpdateAt
  // **窗口与 --check 是两件事**：窗口说的是「换不换文件」，--check 说的是「报不报」。
  // 早先把 --check 并进这个判断里，结果是「刚更新过」那句话永远不会出现——参数把
  // 它要描述的那件事本身绕过去了，两件事合成一个变量就会这样。
  const inWindow = sinceUpdate < UPDATE_INTERVAL_MS

  // ── 一：比版本 ────────────────────────────────────────────────────────────
  const probe = await fetchLatestTag(source)
  if (probe.state === 'unreachable') {
    // 没连上不是「已是最新」，也不该在每次任务开头念一遍。这次就算了，下次再用会重试。
    report([`project-forge ${tag}：这次没能联网核对（不是「已是最新」）。`], { quiet })
    return 0
  }

  // 问不到标签（平台不是 GitHub、没有最新发布）时，退回「取整包读版本」。
  // 那条路要下整包，所以只在真需要更新时才走——而「需不需要」得先读出来才知道，
  // 于是这里退化成「下载一次，顺手就当更新用」，不做第二遍下载。
  let latest
  let remote
  if (probe.state === 'ok') {
    remote = probe.version
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
      `  ${waitText(left)}之后再自动换；这次继续用现在这份就够（想马上要新版，去发布页下载覆盖）。`,
    ], { quiet, always: true })
    return 0
  }
  if (checkOnly) {
    report([`project-forge ${tag}：有新版本 ${remote}（--check 只报告，没有更新）。`], { quiet })
    return 0
  }

  // ── 二：下载新版（上面没下过才下） ────────────────────────────────────────
  if (latest === undefined) latest = await fetchPackage(latestPackageUrl(source))
  if (!latest.ok) {
    report([`project-forge ${tag}：新版没取回来（${latest.why}），没有更新，这份还是原样。`],
      { quiet, always: true })
    return 1
  }

  // ── 三：整份覆盖 ──────────────────────────────────────────────────────────
  const removed = applyPackage(latest.entries)
  const after = localVersion()
  rememberUpdate()
  report([
    `project-forge 已更新到最新版 ${after ?? remote} —— 你之前用的是 ${tag}。`,
    '  这个 skill 的文件换了，我重新读一遍 SKILL.md 再继续。',
    removed.length > 0
      ? `  顺手清掉了 ${removed.length} 个包里不该有的文件（${removed.slice(0, 3).join('、')}${removed.length > 3 ? ' 等' : ''}）。`
      : undefined,
  ], { quiet, always: true })
  return 0
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code })
