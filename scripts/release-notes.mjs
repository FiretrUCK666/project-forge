#!/usr/bin/env node
/**
 * release-notes.mjs —— 用 UTF-8 文件创建或更新发布说明
 *
 * 存在的理由只有一条，而且是硬性的：**含非 ASCII 字符的正文绝不经 shell 传递。**
 *
 * 把中文发布说明拼进命令行、或让 shell 去拼请求体，会静默损坏：不同 shell 的引用与
 * 编码规则不同，同一条命令在不同系统上行为不同。而这类损坏的**共性是接口仍返回成功**
 * ——只有打开页面才发现正文变成了 `?????` 或字面的转义序列。
 *
 * 所以这个脚本做三件事：
 *   1. 从文件按字节读正文（不经过任何 shell）；
 *   2. 按 UTF-8 原样发送；
 *   3. **写完回读比对**，不一致就报错退出。
 *
 * 第 3 条是关键：前两条都可能被别的东西破坏（代理、编码层、平台侧的规范化），
 * 而只有回读能证明真的写对了。
 *
 * 用法：
 *   GITHUB_TOKEN=<凭据> node scripts/release-notes.mjs <标签> <说明文件> [--repo owner/name]
 *
 *   凭据只从环境变量读，**绝不写进任何文件、绝不拼进命令行**。
 *   --repo 省略时，从当前目录的远端地址推导（远端地址的权威来源是版本控制配置）。
 *
 * 退出码：0 = 成功且回读一致；1 = 失败；2 = 用法或环境错误。
 */

import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { parseGitHubRepo } from './survey.mjs'

const API = 'https://api.github.com'

function usage() {
  return [
    '用法：GITHUB_TOKEN=<凭据> node scripts/release-notes.mjs <标签> <说明文件> [--repo owner/name]',
    '',
    '  用 UTF-8 文件创建或更新发布说明。脚本按字节发送正文，写完回读比对。',
    '',
    '  凭据只从 GITHUB_TOKEN 环境变量读，不写进任何文件、不拼进命令行。',
    '  --repo 省略时，从当前目录的远端地址（origin）推导 owner/name。',
    '',
  ].join('\n')
}

/**
 * 从当前目录的版本控制配置读远端地址，推导 owner/name。
 * 远端地址的权威来源是版本控制配置，不是清单文件——与 draft-release-notes 同一份
 * 判据（parseGitHubRepo 只此一处实现，带点的仓库名不会被截断）。
 * 读不到就返回 undefined：让调用方要求显式 --repo，不猜。
 */
function repoFromRemote(cwd) {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error !== undefined || r.status !== 0) return undefined
  return parseGitHubRepo((r.stdout ?? '').trim())
}

/** 去掉开头的 BOM：它藏在正文最前面，留着会让整篇内容从第一行起就对不上。 */
function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
}

/**
 * 行尾归一：本地编辑器与平台侧都可能规范化行尾，比对前统一成 LF。
 * 不归一的话，一次纯行尾差异就会被报成「正文在传输中被改写」——而它恰恰是本脚本
 * 要抓的那类故障，报错本身就不能有假警报，否则人就不信它了。
 */
function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 报出首个不同的位置与那一行的内容——只报字节数的话，拿到手无法定位。 */
function describeFirstDifference(local, remote) {
  const a = local.split('\n')
  const b = remote.split('\n')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  const clip = (s) => {
    if (s === undefined) return '（没有这一行）'
    if (s === '') return '（空行）'
    return s.length > 80 ? `${s.slice(0, 80)}…` : s
  }
  return `  第 ${i + 1} 行开始不同（写入 ${a.length} 行，读回 ${b.length} 行）：\n`
    + `    写入：${clip(a[i])}\n    读回：${clip(b[i])}\n`
}

function makeHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'project-forge-release-notes',
    'Content-Type': 'application/json; charset=utf-8',
  }
}

/** 查一个标签是否已有发布说明。404 表示还没有，这是正常情况不是错误。 */
async function findRelease(repo, tag, headers) {
  if (typeof fetch !== 'function') throw new Error('当前 Node 不提供全局 fetch，需要 Node 18 或更高才能运行本脚本。')
  const r = await fetch(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { headers })
  if (r.status === 404) return undefined
  if (!r.ok) throw new Error(`查询发布说明失败：HTTP ${r.status} ${r.statusText}`)
  return await r.json()
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    process.stdout.write(usage())
    return argv.length === 0 ? 2 : 0
  }

  const repoFlag = argv.indexOf('--repo')
  const repoValueAt = repoFlag >= 0 ? repoFlag + 1 : -1
  const repoArg = repoValueAt >= 0 ? argv[repoValueAt] : undefined
  if (repoFlag >= 0 && (repoArg === undefined || repoArg.startsWith('--'))) {
    process.stderr.write(`错误：--repo 后面要跟 owner/name。\n\n${usage()}`)
    return 2
  }
  const repo = repoArg ?? repoFromRemote(process.cwd())
  // 只剔除 --repo 后面那一个 token。--repo 省略时一个都不能剔——连第一个位置参数
  // 一起剔掉的话，「省略 --repo」这条用法会永远报参数不够，而那正是它的默认用法。
  const positional = argv.filter((a, i) => !a.startsWith('--') && i !== repoValueAt)
  const [tag, notesPath] = positional

  if (tag === undefined || notesPath === undefined) {
    process.stderr.write(`错误：需要标签与说明文件两个参数。\n\n${usage()}`)
    return 2
  }
  if (repo === undefined) {
    process.stderr.write(
      '错误：无法确定仓库。当前目录读不到 origin 远端地址时请用 --repo owner/name 指定。\n',
    )
    return 2
  }
  const token = process.env.GITHUB_TOKEN
  if (typeof token !== 'string' || token.trim() === '') {
    process.stderr.write(
      '错误：环境变量 GITHUB_TOKEN 为空。\n'
      + '  凭据只能从环境变量传入——不要把它写进文件或拼进命令行。\n',
    )
    return 2
  }
  if (!existsSync(notesPath)) {
    process.stderr.write(`错误：找不到说明文件 ${notesPath}。\n`)
    return 2
  }

  // 按字节读，不做任何编码转换——这是整个脚本的意义所在
  const notes = stripBom(readFileSync(notesPath, 'utf8'))
  if (notes.trim() === '') {
    process.stderr.write('错误：说明文件是空的。\n')
    return 2
  }

  const headers = makeHeaders(token)
  const body = JSON.stringify({ tag_name: tag, name: tag, body: notes, draft: false, prerelease: false })

  let release
  try {
    const existing = await findRelease(repo, tag, headers)
    if (existing === undefined) {
      const r = await fetch(`${API}/repos/${repo}/releases`, { method: 'POST', headers, body })
      if (!r.ok) {
        process.stderr.write(`创建失败：HTTP ${r.status} ${r.statusText}\n${await r.text()}\n`)
        return 1
      }
      release = await r.json()
      process.stdout.write(`已创建发布说明：${tag}\n`)
    } else {
      const r = await fetch(`${API}/repos/${repo}/releases/${existing.id}`, { method: 'PATCH', headers, body })
      if (!r.ok) {
        process.stderr.write(`更新失败：HTTP ${r.status} ${r.statusText}\n${await r.text()}\n`)
        return 1
      }
      release = await r.json()
      process.stdout.write(`已更新发布说明：${tag}\n`)
    }

    // 回读比对。前两步都可能被别的东西悄悄改写（编码层、代理、平台规范化），
    // 而这类损坏不会表现为失败——只有把写进去的东西读回来比一次才作数。
    const back = await fetch(`${API}/repos/${repo}/releases/${release.id}`, { headers })
    if (!back.ok) {
      process.stderr.write(`警告：已写入，但回读失败（HTTP ${back.status}），无法确认内容完整。\n`)
      return 1
    }
    const readBack = await back.json()
    const sent = normalizeEol(notes)
    const stored = normalizeEol(readBack.body ?? '')
    if (stored !== sent) {
      process.stderr.write(
        '错误：回读内容与写入的不一致——正文在传输中被改写了。\n'
        + describeFirstDifference(sent, stored)
        + '  请打开页面确认实际内容，不要假定它是对的。\n',
      )
      return 1
    }
    process.stdout.write(
      `回读一致：${Buffer.byteLength(sent, 'utf8')} 字节，与写入内容逐字相同。\n`
      + `${release.html_url}\n`,
    )
    return 0
  } catch (error) {
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}

process.exitCode = await main()
