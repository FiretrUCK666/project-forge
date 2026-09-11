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
 * 退出码：0 = 全部可显示（或没找到徽章）；1 = 有显示不出来的。
 * 需要网络。离线时会明确报告「没能检查」，不会假装通过。
 */

import { readFileSync, existsSync } from 'node:fs'

/** 从 Markdown 里抽出徽章图片地址。只认 shields 一类的徽章服务，避免把普通图片当徽章。 */
const BADGE_HOSTS = /img\.shields\.io|badgen\.net|badge\.fury\.io|codecov\.io|travis-ci|github\.com\/.*\.svg|api\.netlify\.com/i

/** 这些字样出现在徽章可见文字里，说明没取到数据；只判可见文字，不判整段 SVG（含样式与元数据，避免 errors: 0 误报）。 */
const FAILURE_WORDS = /not found|invalid|no such|unknown|unable|too new|no releases/i

function extractBadges(text) {
  const out = []
  // Markdown 图片语法 ![alt](url)，以及裸的 <img src="...">
  for (const m of text.matchAll(/!\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)) out.push(m[1])
  for (const m of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) out.push(m[1])
  return [...new Set(out)].filter((u) => /^https?:\/\//.test(u) && BADGE_HOSTS.test(u))
}

/** 读回徽章 SVG，返回它实际显示的文字，以及是否像是失败态。 */
async function inspect(url) {
  if (typeof fetch !== 'function') {
    return { ok: false, reason: '当前 Node 不提供全局 fetch，需要 Node 18 或更高', shows: '' }
  }
  let res
  try {
    res = await fetch(url, { redirect: 'follow' })
  } catch (error) {
    return { ok: false, reason: `请求失败：${error.message}`, shows: '' }
  }
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}`, shows: '' }
  const body = await res.text()
  if (/<svg/i.test(body) === false && /\.svg/i.test(url)) {
    return { ok: false, reason: '返回的不是 SVG', shows: '' }
  }
  // 把 SVG 里的可见文字抽出来：>文字<
  const words = [...body.matchAll(/>([^<>]{1,60})</g)]
    .map((m) => m[1].trim())
    .filter((w) => w !== '' && !/^[\s\d.]+$/.test(w))
  const shows = words.slice(-1)[0] ?? ''
  if (FAILURE_WORDS.test(shows)) {
    return { ok: false, reason: '徽章里显示的是失败字样', shows }
  }
  return { ok: true, reason: '', shows }
}

async function main() {
  const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (files.length === 0) {
    process.stderr.write('用法：node scripts/check-badges.mjs <README 路径...>\n')
    return 2
  }

  let bad = 0
  let checked = 0
  let offline = false

  for (const f of files) {
    if (!existsSync(f)) {
      process.stderr.write(`跳过（不存在）：${f}\n`)
      continue
    }
    const text = readFileSync(f, 'utf8').replace(/^\uFEFF/, '')
    const badges = extractBadges(text)
    if (badges.length === 0) {
      process.stdout.write(`${f}：没有徽章（这没问题——徽章是可选装饰）\n`)
      continue
    }
    process.stdout.write(`${f}：找到 ${badges.length} 个徽章\n`)
    for (const url of badges) {
      const r = await inspect(url)
      checked += 1
      if (/请求失败/.test(r.reason)) offline = true
      if (r.ok) {
        process.stdout.write(`  可以  ${r.shows || '(无文字)'}\n         ${url}\n`)
      } else {
        bad += 1
        process.stdout.write(`  显示不出来  ${r.reason}${r.shows === '' ? '' : `（图里写着「${r.shows}」）`}\n         ${url}\n`)
      }
    }
  }

  if (offline) {
    process.stdout.write('\n注意：有徽章因网络原因没能检查到，上面的结论不完整。\n')
  }
  if (bad > 0) {
    process.stdout.write(
      `\n${bad} 个徽章显示不出来（检查了 ${checked} 个）。`
      + '**请把它们从 README 里删掉**——一个灰色破标签比没有徽章更难看，'
      + '而且会让读者以为这个项目坏了。\n',
    )
    return 1
  }
  process.stdout.write(`\n全部 ${checked} 个徽章都能正常显示。\n`)
  return 0
}

process.exitCode = await main()
