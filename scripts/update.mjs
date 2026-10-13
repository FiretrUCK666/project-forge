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
 * 包副本也不是一律更新。判据同样不是「猜这个人想干嘛」，而是一件**当场算得出来的事实**：
 * 这个副本的内容，还是不是当初发出去的那一份？
 *
 *   - 逐字节一致 → 没有他的东西处在风险里，替换。
 *   - 有一处不一致 → 一个字节都不动，并把第一处不一致指出来。
 *     想改它的人、改了一半的人、下错包的人，在这条判据面前是同一件事：**有本地内容，就不动**。
 *   - 拿不到他那一版的包 → 不动，说明为什么（「没核对」不是「已是最新」）。
 *
 * 这条判据替掉了一个本来会长出来的东西：一份「这个副本属于哪种角色」的记录文件。
 * 记录会过期、会被复制、会与它描述的东西脱节；而「内容对不对」每次都是现算的，
 * 换台机器、换个人、把目录拷到别处，答案照样成立。**同一个问题第二次出现时，
 * 先问它能不能不靠记性回答**——能，就不该长出那份记录。
 *
 * 节流：默认 24 小时内只查一次（查一次要联网）。状态写在系统临时目录里，按副本路径
 * 分开——同一台机器上装了几份副本时，一份的检查不会替另一份做决定。
 *
 * 用法：
 *   node scripts/update.mjs [--quiet] [--check]
 *
 *   --quiet   只在「真的更新了」或「更新失败」时输出（skill 自己在任务开始时用这个）
 *   --check   只报告不更新，且不受节流限制（人主动问的时候用）
 *
 * 退出码：0 = 无事或已更新；1 = 尝试更新但失败；2 = 用法错误。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readFileMap, skillSource, skillVersion } from './survey.mjs'
import { readZip, stripCommonPrefix } from './zip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

/** 两次联网检查之间的最短间隔。查一次要一次网络往返，按每次任务都查就是白做。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 单次网络动作的上限。卡住的请求会把整个任务拖住，宁可报「这次没核对成」。 */
const NETWORK_TIMEOUT_MS = 60 * 1000
/** 附件名。固定不带版本号，`releases/latest/download/<这个名字>` 才永远指向最新版。 */
const ASSET = 'project-forge.zip'

/** 节流状态按副本路径分开：一份副本的检查结果不能替另一份做决定。 */
const STAMP_PATH = join(tmpdir(),
  `project-forge-update-${createHash('sha1').update(SKILL_ROOT).digest('hex').slice(0, 12)}.json`)

function usage() {
  return [
    '用法：node scripts/update.mjs [--quiet] [--check]',
    '',
    '  检查这个 skill 的副本有没有新版；能安全更新时更新它。',
    '',
    '  有 .git 的副本是源码副本：只读报告，一个字节都不写（更新请自己 git pull）。',
    '  没有 .git 的是包副本：先核对「内容还是不是发出去那一份」，一致才替换。',
    '',
    '  --quiet   只在「真的更新了」或「更新失败」时输出',
    '  --check   只报告不更新，且不受 24 小时节流限制',
    '',
  ].join('\n')
}

/**
 * 跑一条 git 命令。
 *
 * 三处细节都是为了「不让它把任务挂住或静默失败」：关掉终端凭据询问（没有交互终端时
 * git 会一直等），设超时（网络卡住时不会无限等），失败一律返回 ok=false 交给调用方
 * 分情况报告——**读不到与读到空必须可区分**。
 */
function git(args, { timeout = NETWORK_TIMEOUT_MS } = {}) {
  const r = spawnSync('git', args, {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (r.error !== undefined) return { ok: false, ran: false, out: '', err: '' }
  return {
    ok: r.status === 0,
    ran: true,
    out: (r.stdout ?? '').trim(),
    err: (r.stderr ?? '').trim(),
  }
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

/** 读取节流状态。读不到或坏了都当成「没查过」——多查一次无害，漏查才有害。 */
function lastCheckAt() {
  try {
    const raw = JSON.parse(readFileSync(STAMP_PATH, 'utf8'))
    const t = Number(raw?.checkedAt)
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

function rememberCheck() {
  try {
    writeFileSync(STAMP_PATH, `${JSON.stringify({ checkedAt: Date.now() })}\n`, 'utf8')
  } catch {
    // 写不进去只是失去节流，不影响正确性：下次再查一遍就是了。
  }
}

/**
 * 输出。
 *
 * quiet 模式（skill 在每次任务开始时用的那个）只放行两类：**真的更新了**与**更新失败**。
 * 其余情况（已是最新、源码副本、这次没联网）对使用者没有可动作的信息，而每次任务
 * 都念一遍的结果是让人学会忽略这一行——那时它真正要说的话也一起被忽略了。
 * 想看全部状态就加 `--check`。
 */
function report(lines, { quiet, always = false } = {}) {
  if (quiet && !always) return
  const text = lines.filter((l) => l !== undefined).join('\n')
  if (text !== '') process.stdout.write(`${text}\n`)
}

/** 取回一个地址的内容，跟着重定向走（发布页的附件地址会跳到对象存储）。 */
function download(url, { redirects = 5 } = {}) {
  return new Promise((resolvePromise) => {
    const secure = url.startsWith('https:')
    // 用哪个协议**跟着来源地址走**，不写死：来源就是这个副本当初从哪儿来的地方，
    // 它说什么协议就按什么协议取。这也让这套逻辑能在本机拿一个临时服务端实跑验证，
    // 不必为了测试在代码里开一个只有测试才走的后门。
    const request = (secure ? httpsGet : httpGet)(url, {
      headers: { 'user-agent': 'project-forge-update', accept: 'application/octet-stream' },
      timeout: NETWORK_TIMEOUT_MS,
    }, (res) => {
      const { statusCode, headers } = res
      const location = headers.location
      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400
        && location !== undefined && redirects > 0) {
        res.resume()
        resolvePromise(download(new URL(location, url).toString(), { redirects: redirects - 1 }))
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

/** 下载一份包并解开。任何一个环节不成立都返回 `{ ok: false, why }`，不返回半份内容。 */
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
  return { ok: true, entries, skillText: skill.data.toString('utf8') }
}

/** 一个版本的包可能用的两个附件名。名字固定成 `project-forge.zip` 之前是带版本号的。 */
function packageUrls(source, version) {
  const base = `${String(source).trim().replace(/\/+$/, '')}/releases/download/v${version}`
  return [`${base}/${ASSET}`, `${base}/project-forge-${version}.zip`]
}

/** 版本号比大小：按 `.` 分段比数字，比不出来就返回 undefined（不猜）。 */
function isNewer(candidate, current) {
  const parse = (v) => {
    const parts = String(v ?? '').split(/[.\-+]/).map((x) => (/^\d+$/.test(x) ? Number(x) : undefined))
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

/**
 * 把本地副本与「它那一版的包」逐文件比对，返回不一致的清单。
 *
 * 这就是「内容还是不是发出去那一份」的全部实现。两边都是清单，不读 git、不看时间戳：
 * 时间戳会因为解压、拷贝、换机器而变，而内容不会。
 */
function compareWithPackage(entries) {
  const problems = []
  for (const e of entries) {
    const p = join(SKILL_ROOT, e.name)
    if (!existsSync(p)) { problems.push(`${e.name}（少了）`); continue }
    if (!readFileSync(p).equals(e.data)) problems.push(`${e.name}（内容不同）`)
  }
  return problems
}

/** 这个副本里有哪些「仓库自用」的文件（按文件地图的排除表判，不另抄一份清单）。 */
function leftoverDevFiles() {
  const text = skillText()
  if (text === undefined) return []
  const map = readFileMap(text)
  return map.repoOnly.filter((entry) => existsSync(join(SKILL_ROOT, entry)))
}

/**
 * 把一份包的内容写进本领目录。
 *
 * `oldNames` 是旧包的文件清单：新包里已经没有的那些要删掉，否则一份被删掉的 reference
 * 会永远留在副本里，而引用它的文档早已不在了。
 */
function applyPackage(entries, oldNames) {
  const now = new Set(entries.map((e) => e.name))
  for (const e of entries) {
    const p = join(SKILL_ROOT, e.name)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, e.data)
  }
  for (const name of oldNames) {
    if (now.has(name)) continue
    const p = join(SKILL_ROOT, name)
    if (existsSync(p) && statSync(p).isFile()) rmSync(p)
  }
  // 空目录不再有用（新包里没有它），顺手收掉——只收空的，里面还有东西就留着。
  for (const entry of readFileMap(skillText() ?? '').shipped) {
    if (!entry.endsWith('/')) continue
    const d = join(SKILL_ROOT, entry)
    try {
      if (existsSync(d) && statSync(d).isDirectory() && readdirSync(d).length === 0) rmSync(d)
    } catch {
      // 收不掉就算了：空目录不影响使用，为它失败不值得。
    }
  }
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

/** 包副本：来源与版本读得到才有下文；读不到就报「未核对」，不假装查过。 */
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

  // 源码副本：只读报告，到此为止。这条在节流之前——它不联网，也就没有节流的理由。
  if (facts.hasGit) return reportSourceCopy(facts, { quiet })

  const source = originUrl(facts.source)
  if (source === undefined || facts.version === undefined) return reportUnverifiable(facts, { quiet })

  if (!checkOnly && Date.now() - lastCheckAt() < CHECK_INTERVAL_MS) return 0

  const latest = await fetchPackage(`${source}/releases/latest/download/${ASSET}`)
  if (!latest.ok) {
    // 「没比」与「比过且一致」必须可区分：取不回来时不能读成「已是最新」。
    // 仍然记下这次时间，否则离线时每次任务都会重试并重复报同一句话。
    if (!checkOnly) rememberCheck()
    report([`project-forge ${tag}：这次没能联网核对（不是「已是最新」）。`,
      `  原因：${latest.why}`], { quiet })
    return 0
  }
  if (!checkOnly) rememberCheck()

  const remoteVersion = skillVersion(latest.skillText)
  if (remoteVersion === undefined) {
    report([`project-forge ${tag}：取回的包里读不到版本号，无法判断有没有新版。`], { quiet })
    return 0
  }
  const newer = isNewer(remoteVersion, facts.version)
  if (newer === undefined) {
    report([`project-forge ${tag}：版本号形状认不出来（远端是 ${remoteVersion}），跳过（不猜）。`], { quiet })
    return 0
  }
  if (!newer) {
    report([`project-forge ${tag}：已是最新。`], { quiet })
    return 0
  }
  if (checkOnly) {
    report([`project-forge ${tag}：有新版本 ${remoteVersion}（--check 只报告，没有更新）。`], { quiet })
    return 0
  }

  // 更新之前先核对：这个副本的内容还是不是当初发出去的那一份？
  let localPkg
  for (const url of packageUrls(source, facts.version)) {
    const got = await fetchPackage(url)
    if (got.ok) { localPkg = got; break }
    if (got.why !== '没有这一版') { localPkg = got; break }
  }
  if (localPkg === undefined || !localPkg.ok) {
    const why = localPkg === undefined ? '没有这一版' : localPkg.why
    report([
      `project-forge ${tag}：核对不了这个副本有没有被改过（${why}），没有更新。`,
      `  这是「没核对」，不是「已是最新」。重新下载一次 ${ASSET} 覆盖，之后它就能自己更新了。`,
    ], { quiet, always: false })
    return 0
  }
  const differences = compareWithPackage(localPkg.entries)
  if (differences.length > 0) {
    report([
      `project-forge ${tag}：这个副本和发出去的那份不一样，没有更新（你的东西一个字节都没动）。`,
      `  第一处：${differences[0]}${differences.length > 1 ? `，另有 ${differences.length - 1} 处` : ''}`,
      '  想改它就用克隆装法（有 .git 的那种），这份不会再自动更新。',
    ], { quiet, always: false })
    return 0
  }

  // 逐字节一致，替换。
  applyPackage(latest.entries, localPkg.entries.map((e) => e.name))
  const after = localVersion()
  const leftovers = leftoverDevFiles()
  report([
    `project-forge 已更新：${tag} -> ${after ?? remoteVersion}。`,
    '  这个 skill 的文件变了，重新读取 SKILL.md 后再继续。',
    leftovers.length > 0
      ? `  另外：目录里还有源码专用的文件（${leftovers.join('、')}）——那是下成了 GitHub 的 Source code`
        + '留下的，删掉不影响使用。'
      : undefined,
  ], { quiet, always: true })
  return 0
}

main(process.argv.slice(2)).then((code) => { process.exitCode = code })
