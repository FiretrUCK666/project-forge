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
 * 还有一条与内容有关的前置检查：说明必须**是一份成品**。具体查什么由
 * `lintReleaseNotes` 给出，只查任何项目都成立的那几条（有标题、标题是这一版、有节、
 * 节里没空着、没有同名节、没留着骨架标记）——**不查「分了哪几节」**，那是项目自己的
 * 决定，写进检查就成了拿一家的规范去要求所有项目。
 *
 * 用法：
 *   GITHUB_TOKEN=<凭据> node scripts/release-notes.mjs <标签> <说明文件> [--repo owner/name]
 *   node scripts/release-notes.mjs <标签> <说明文件> --check
 *
 *   `--check` 只做结构检查，不联网、不需要凭据——本地预演用它，发版之前先过一遍。
 *
 *   凭据只从环境变量读，**绝不写进任何文件、绝不拼进命令行**。
 *   --repo 省略时，从当前目录的远端地址推导（远端地址的权威来源是版本控制配置）。
 *
 * 退出码：0 = 成功且回读一致（`--check` 时为检查通过）；1 = 失败；2 = 用法、环境或内容错误。
 */

import { readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

import { parseGitHubRepo } from './lib/text.mjs'
import { lintReleaseNotes, apiBase } from './lib/protocol.mjs'

// 接口基地址的判据住在 lib/protocol.mjs：update.mjs 用的是同一份（`apiTarget`）。
// 两处各写一遍就会漂成「查得到发布、发不出说明」，而两个脚本各自的测试都过。
const API = apiBase('https://github.com')

function usage() {
  return [
    '用法：GITHUB_TOKEN=<凭据> node scripts/release-notes.mjs <标签> <说明文件> [--repo owner/name]',
    '      node scripts/release-notes.mjs <标签> <说明文件> --check',
    '',
    '  用 UTF-8 文件创建或更新发布说明。脚本按字节发送正文，写完回读比对。',
    '  发送前先做结构检查：没标题、标题不是这一版、有空节、两节同名、还留着骨架标记，',
    '  任何一条都拒绝发送。',
    '',
    '  --check     只做结构检查，不联网、不需要凭据（本地预演用）。',
    '  凭据只从 GITHUB_TOKEN 环境变量读，不写进任何文件、不拼进命令行。',
    '  --repo 省略时，从当前目录的远端地址（origin）推导 owner/name。',
    '',
  ].join('\n')
}

/**
 * 从当前目录的版本控制配置读远端地址，推导 owner/name。
 * 远端地址的权威来源是版本控制配置，不是清单文件——与项目自己声明的仓库地址无关
 * （parseGitHubRepo 只此一处实现，带点的仓库名不会被截断）。
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
    // 钉住 API 版本：不写这个头时 GitHub 按它自己的默认版本解析（实测今天仍是
    // 2022-11-28），而默认值会随它推进而变——那时这个脚本的行为会跟着一起变，
    // 且没有本地改动、没有提交可查。查法与核对日期见 references/remote-github.md。
    'X-GitHub-Api-Version': '2026-03-10',
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
  // 只检查、不发送：本地预演要在拿到凭据之前就能跑，否则「先验一遍」这句建议等于
  // 只有配好密钥的人才用得上。
  const checkOnly = argv.includes('--check')
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
  // 一类看不见的损坏：说明里含 ASCII 控制字符。最常见的来源是**拿 shell 双引号写含
  // 反引号的 Markdown**——`a `b `f `n `v `e 会被转义成控制字节。发出去之后终端会吞掉
  // 它后面的字，而接口仍然返回成功。这里不自动清洗，因为**清洗会掩盖上游的写作方式
  // 问题**——正文该改，不是该洗。
  const ctrl = notes.match(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/)
  if (ctrl !== null) {
    const at = notes.indexOf(ctrl[0])
    const line = notes.slice(0, at).split('\n').length
    const hex = '0x' + ctrl[0].charCodeAt(0).toString(16).padStart(2, '0')
    process.stderr.write(
      `错误：这份说明第 ${line} 行含 ASCII 控制字符 ${hex}，发出去会让终端吞字。\n`
      + `  修法：改 ${notesPath} 里那一行，把控制字符去掉后重新发送。\n`
      + '  常见成因：拿 PowerShell 双引号传含反引号的 Markdown，反引号被当成了转义前缀。\n',
    )
    return 2
  }

  // 骨架不是成品：小标题在、内容一句没写，机器若只判「文件存在」，这份空壳就会被
  // 原样发到发布页上，而发布页的收件人是使用者。这条与其余几条结构判据放在一起判，
  // 见 lib/protocol.mjs 的 lintReleaseNotes——判据只实现一处。
  const structural = lintReleaseNotes(notes, tag)
  if (structural.length > 0) {
    process.stderr.write(
      `错误：这份说明还不能发（${structural.length} 处）：\n`
      + structural.map((p) => `  - ${p}\n`).join('')
      + `  修法：改 ${notesPath}。分几节由项目的发版规范决定，但上面这几条与项目无关——`
      + '它们不成立时，这份说明在任何项目里都算不上说明。\n',
    )
    return 2
  }
  if (checkOnly) {
    process.stdout.write(`检查通过：${tag} 的说明是一份成品，结构上没发现问题。\n`)
    return 0
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
