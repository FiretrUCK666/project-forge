#!/usr/bin/env node
/**
 * draft-release-notes.mjs —— 从提交记录起草中文发布说明
 *
 * 存在的理由：`gh release create --generate-notes` 是 GitHub 服务器按英文模板
 * 渲染的（What's Changed + Full Changelog 链接），它不认识中文，产出的说明
 * 没有一句人话。所以这里自己起草中文正文。
 *
 * **起草结果是素材，不是成品**：发布页面的读者是使用者，正文必须回答
 * 「这一版更新了什么、修复了什么」，用他看得懂的话——不能照搬内部编号、任务代号、
 * 分支名与提交哈希，也不该把对使用者无影响的重构写进去。提交信息本身面向使用者时，
 * 收集起来就够用；夹着代号或内部说法时，发版前由人改写一遍再发。
 * 这条与 references/remote-github.md 第六节的判据一致，实现与文档只有一份说法。
 *
 * 用法：
 *   node scripts/draft-release-notes.mjs <标签> [输出文件]
 *
 *   标签必须已存在（先打标签再起草）。输出文件省略时写到 `./<标签>-notes.md`。
 *   正文写进 UTF-8 文件（无 BOM），再由 gh 或 release-notes.mjs 按字节发送——
 *   中文绝不经 shell 传递的那条规则，在这里同样适用。
 *
 * 退出码：0 = 写好；1 = 失败；2 = 用法或仓库状态错误。
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { parseGitHubRepo } from './survey.mjs'

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (r.error !== undefined || r.status !== 0) return undefined
  return (r.stdout ?? '').trim()
}

function usage() {
  return '用法：node scripts/draft-release-notes.mjs <标签> [输出文件]\n'
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    process.stdout.write(usage())
    return argv.length === 0 ? 2 : 0
  }
  const [tag, outPath] = argv
  const cwd = process.cwd()

  if (git(['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], cwd) === undefined) {
    process.stderr.write(`错误：标签 ${tag} 不存在——先打标签再起草。\n`)
    return 2
  }
  // 上一个标签：没有则取全量（上限 100 条，发布说明不是提交编年史）。
  const prev = git(['describe', '--tags', '--abbrev=0', `${tag}^`], cwd)
  const range = prev === undefined ? tag : `${prev}..${tag}`
  const log = git(['log', '--format=%s', '--no-merges', '-n', '100', range], cwd)
  if (log === undefined) {
    process.stderr.write('错误：读取提交记录失败。\n')
    return 1
  }
  const subjects = log.split('\n').map((l) => l.trim()).filter((l) => l !== '')

  // 对比链接：能解析出 GitHub 地址才给，给不出就只写区间（不编地址）。
  // 仓库边界识别**只有一处实现**（survey 的 parseGitHubRepo）：过去的正则用
  // `[^/.]+` 取仓库名，把带点的名字截断（`acme/my.repo` → `acme/my`），于是起草出的
  // 对比链接指向一个不存在的仓库——而它看起来完全正常，只有点开才发现。
  let compare = `\`${range}\``
  const remote = git(['remote', 'get-url', 'origin'], cwd)
  const repo = remote === undefined ? undefined : parseGitHubRepo(remote)
  if (repo !== undefined) compare = `[${prev ?? '初始'}...${tag}](https://github.com/${repo}/compare/${range})`

  // 标题用疑问句的两问，而不是「本次更新」这类中性词：发布页面的读者是使用者，
  // 他要的答案是「更新了什么、修复了什么」。提交信息本身面向使用者时，逐条列出即成品；
  // 夹着内部编号或任务代号时，发版前由人把这些条目改写成使用者看得懂的说法再发
  // （判据见 references/remote-github.md 第六节——文档与实现只有一份说法）。
  const lines = [`## 这一版更新了什么、修复了什么`, '']
  if (subjects.length === 0) lines.push('（该区间无提交记录）')
  else for (const s of subjects) lines.push(`- ${s}`)
  // 取数上限必须明示：超 100 条时老的提交静默丢失，不写就是“看起来全了”。
  if (subjects.length >= 100) lines.push('', '（仅列最近 100 条，更早的见完整改动对比）')
  lines.push('', `**完整改动**：${compare}`, '')
  const target = outPath ?? `./${tag}-notes.md`
  try {
    writeFileSync(target, lines.join('\n'), { encoding: 'utf8' })
  } catch (error) {
    process.stderr.write(`错误：无法写入 ${target}——${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  process.stdout.write(`已起草：${target}（${subjects.length} 条提交）\n`)
  return 0
}

process.exitCode = main()
