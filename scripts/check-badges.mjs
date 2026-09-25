#!/usr/bin/env node
/**
 * check-badges.mjs —— 检查 README 里的徽章是否真的能显示
 *
 * 徽章有一种很隐蔽的失效方式：**图片地址永远返回 200，图里却写着 `repo not found`**。
 * 页面上就是一个灰色的破标签，而作者通常不会去看自己 README 渲染成什么样。
 * 已知会踩的两类：
 *
 *   - 私有仓库上的 GitHub 系列徽章**全部**显示不出来（星标、许可、发布）；
 *   - 制品库的下载量徽章在新包刚发布时显示 `package not found or too new`。
 *
 * 这个脚本把「先访问一遍再写」从一句嘱咐变成一条可执行的检查：扫描 README 里的徽章
 * 图片地址，逐个取回来读它渲染出的文字，把显示不出来的挑出来。
 *
 * 用法：
 *   node scripts/check-badges.mjs <README 路径...>
 *
 * **三态，不是两态**：能判定「可显示」或「显示不出来」，还有一种「没能查完」。
 * 第三态是必须的：响应正文读取失败（坏 gzip、连接半途断开、代理改写）、网络不可达、
 * 运行时异常，都属于「没验证过」。把它并进「可显示」就是把没检查读成通过——调用方
 * （review.mjs）据此放行，属于最坏的一种假绿。
 *
 * 输出末尾固定一行机器可读结论，调用方**按它与退出码判定**，不去嗅探人话：
 *   check-badges: state=<ok|bad|unverified|nobadge> checked=N bad=M unverified=K
 *
 * 退出码：0 = 全部可显示（或没有徽章）；1 = 有确认显示不出来的；
 *         3 = 没查完（离线 / 正文读取失败 / 运行时异常）；2 = 用法错误。
 *
 * 需要网络。离线时明确报「没能检查」，不会假装通过。
 */

import { readFileSync, existsSync } from 'node:fs'

/** 从 Markdown 里抽出徽章图片地址。只认 shields 一类的徽章服务，避免把普通图片当徽章。 */
const BADGE_HOSTS = /img\.shields\.io|badgen\.net|badge\.fury\.io|codecov\.io|travis-ci|github\.com\/.*\.svg|api\.netlify\.com/i

/** 这些字样出现在徽章可见文字里，说明没取到数据；只判可见文字，不判整段 SVG（含样式与元数据，避免 errors: 0 误报）。 */
const FAILURE_WORDS = /not found|invalid|no such|unknown|unable|too new|no releases/i

/** 机器可读结论行的前缀：调用方认它，不认人话。 */
const STATE_PREFIX = 'check-badges: state='

function extractBadges(text) {
  const out = []
  // Markdown 图片语法 ![alt](url)，以及裸的 <img src="...">
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) out.push(m[1])
  for (const m of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) out.push(m[1])
  return [...new Set(out)].filter((u) => /^https?:\/\//.test(u) && BADGE_HOSTS.test(u))
}

/**
 * 读回徽章 SVG，返回它实际显示的文字，以及判定结果。
 *
 * verdict: 'ok'（能显示）/ 'bad'（确认显示不出来）/ 'unverified'（没查完）。
 * 请求本身发不出去、或正文读不出来，一律 unverified——那不是徽章的结论，
 * 是这次检查没做完的证据。
 */
async function inspect(url) {
  if (typeof fetch !== 'function') {
    return { verdict: 'unverified', reason: '当前 Node 不提供全局 fetch，需要 Node 18 或更高', shows: '' }
  }
  let res
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    return { verdict: 'unverified', reason: `请求失败：${error.message}`, shows: '' }
  }
  if (!res.ok) return { verdict: 'bad', reason: `HTTP ${res.status}`, shows: '' }
  let body
  try {
    // 这一步**必须在 try 里**：坏 gzip、连接半途断开、代理改写都会在这里抛
    // （坏 gzip 典型表现为 `TypeError: terminated`）。
    body = await res.text()
  } catch (error) {
    return { verdict: 'unverified', reason: `正文读取失败：${error.message}`, shows: '' }
  }
  if (/<svg/i.test(body) === false && /\.svg/i.test(url)) {
    return { verdict: 'bad', reason: '返回的不是 SVG', shows: '' }
  }
  // 把 SVG 里的可见文字抽出来：>文字<
  const words = [...body.matchAll(/>([^<>]{1,60})</g)]
    .map((m) => m[1].trim())
    .filter((w) => w !== '' && !/^[\s\d.]+$/.test(w))
  const shows = words.slice(-1)[0] ?? ''
  if (FAILURE_WORDS.test(shows)) {
    return { verdict: 'bad', reason: '徽章里显示的是失败字样', shows }
  }
  return { verdict: 'ok', reason: '', shows }
}

async function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (files.length === 0) {
    process.stderr.write('用法：node scripts/check-badges.mjs <README 路径...>\n')
    return 2
  }

  let bad = 0
  let checked = 0
  let unverified = 0
  let foundAny = 0

  for (const f of files) {
    if (!existsSync(f)) {
      // 读不到就是没检查过。静默跳过会让「一个都没查」被读成「都没问题」——
      // 路径打错、文件刚被改名，都走到这里，而结论行仍然是 ok。
      process.stdout.write(`  没能检查  ${f}：文件不存在（路径写错了？徽章检查的就是这些文件本身）\n`)
      unverified += 1
      continue
    }
    let text
    try {
      text = readFileSync(f, 'utf8').replace(/^\uFEFF/, '')
    } catch (error) {
      process.stdout.write(`  没能检查  ${f}：读不出来（${error.message}）\n`)
      unverified += 1
      continue
    }
    const badges = extractBadges(text)
    if (badges.length === 0) {
      process.stdout.write(`${f}：没有徽章（这没问题——徽章是可选装饰）\n`)
      continue
    }
    foundAny += 1
    process.stdout.write(`${f}：找到 ${badges.length} 个徽章\n`)
    for (const url of badges) {
      const r = await inspect(url)
      checked += 1
      if (r.verdict === 'ok') {
        process.stdout.write(`  可以  ${r.shows || '(无文字)'}\n         ${url}\n`)
      } else if (r.verdict === 'bad') {
        bad += 1
        process.stdout.write(`  显示不出来  ${r.reason}${r.shows === '' ? '' : `（图里写着「${r.shows}」）`}\n         ${url}\n`)
      } else {
        unverified += 1
        process.stdout.write(`  没能检查  ${r.reason}\n         ${url}\n`)
      }
    }
  }

  const state = bad > 0 ? 'bad' : (unverified > 0 ? 'unverified' : (foundAny === 0 ? 'nobadge' : 'ok'))
  process.stdout.write(`\n${STATE_PREFIX}${state} checked=${checked} bad=${bad} unverified=${unverified}\n`)
  if (unverified > 0) {
    process.stdout.write('注意：有的徽章或文件没能检查到，上面的结论不完整——**「没能检查」不等于「可以显示」**。\n')
  }
  if (bad > 0) {
    process.stdout.write(
      `\n${bad} 个徽章显示不出来（检查了 ${checked} 个）。`
      + '**请把它们从 README 里删掉**——一个灰色破标签比没有徽章更难看，'
      + '而且会让读者以为这个项目坏了。\n',
    )
    return 1
  }
  if (unverified > 0) return 3
  // 一个都没查到的场合不说「都能正常显示」：这句话会被读成检查通过，
  // 而实际情况是没有任何一个徽章被看过。
  if (checked === 0) {
    process.stdout.write('\n没有实际检查到任何徽章——**这不等于「都没问题」**，先确认上面每个文件都读到了。\n')
  } else {
    process.stdout.write(`\n全部 ${checked} 个徽章都能正常显示。\n`)
  }
  return 0
}

// 顶层兜底：任何没预料到的异常也必须给出**机器可读的**结论行，而不是只留一段栈。
// 调用方拿不到结论行时会判「没能检查」——所以这里主要是把原因写清楚。
try {
  process.exitCode = await main()
} catch (error) {
  process.stdout.write(`\n${STATE_PREFIX}unverified checked=0 bad=0 unverified=1\n`)
  process.stderr.write(`错误：检查中断——${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 3
}
