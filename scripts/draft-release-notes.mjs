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
 * 分支名与提交哈希，也不该把对使用者无影响的重构写进去。
 *
 * 正文只有一个来源：**被标签指到的那次提交的正文**。发版那一步本来就要改版本号，
 * 总述写在那里是最短的路，不需要新文件、新开关。那次提交没有正文时，这里只列得出
 * 提交主题，并写下一行 `pf:needs-summary` 标记——`release-notes.mjs` 见到它就拒绝
 * 发送，所以半成品不会出现在使用者看到的页面上。
 *
 * 用法：
 *   node scripts/draft-release-notes.mjs <标签> [输出文件]
 *
 *   标签必须已存在（先打标签再起草）。输出文件省略时写到 `./<标签>-notes.md`。
 *   正文写进 UTF-8 文件（无 BOM），再由 release-notes.mjs 按字节发送——
 *   中文绝不经 shell 传递的那条规则，在这里同样适用。
 *
 * 退出码：0 = 写好；1 = 失败；2 = 用法或仓库状态错误。
 */

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { parseGitHubRepo, SUMMARY_MARKER } from './survey.mjs'

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
  // 取**完整提交信息**，不只取主题行。主题行一句话，按项目约定「一次实质变更一个
  // 提交，主题说最主要的那件、其余进正文」——只读主题，等于把正文里写给使用者的
  // 那一大半丢在门外，起草出来的页面只有一行标题。
  // 用 \x1e 分条、\x1f 分字段：提交正文本身可以有多行，任何基于换行的分隔都会被
  // 正文里的空行或缩进列表骗到。
  const raw = git(['log', '--no-merges', '-n', '100', `--format=%s\x1f%b\x1e`, range], cwd)
  if (raw === undefined) {
    process.stderr.write('错误：读取提交记录失败。\n')
    return 1
  }
  const commits = raw
    .split('\x1e')
    .map((rec) => rec.replace(/^[\r\n]+/, ''))
    .filter((rec) => rec.trim() !== '')
    .map((rec) => {
      const cut = rec.indexOf('\x1f')
      return { subject: rec.slice(0, cut).trim(), body: rec.slice(cut + 1).trim() }
    })

  // 对比链接：能解析出 GitHub 地址才给，给不出就只写区间（不编地址）。
  // 仓库边界识别**只有一处实现**（survey 的 parseGitHubRepo）：这里若另写一份取
  // 仓库名的正则，`[^/.]+` 会把带点的名字截断（`acme/my.repo` → `acme/my`），起草出的
  // 对比链接就指向一个不存在的仓库——而它看起来完全正常，只有点开才发现。
  let compare = `\`${range}\``
  const remote = git(['remote', 'get-url', 'origin'], cwd)
  const repo = remote === undefined ? undefined : parseGitHubRepo(remote)
  if (repo !== undefined) compare = `[${prev ?? '初始'}...${tag}](https://github.com/${repo}/compare/${range})`

  // 说明的唯一来源是**被标签指到的那次提交**（`git log` 按时间倒序，第一条就是它）。
  // 发版那一步本来就要改 SKILL.md 的版本号，把面向使用者的总述写在那次提交的正文里
  // 是最短的路：不需要新文件、新开关，也不需要谁记得在别处再写一遍。单条提交与多条
  // 提交因此是同一个规则，不再分两套。
  //
  // 没有总述时不许冒充成品：写一行**给维护者**的标记，`release-notes.mjs` 见到它就拒绝
  // 发送，所以它永远不会出现在使用者看到的页面上。让「只有一行标题」的稿子直接发布，
  // 比让这次发版失败坏得多。
  const lines = [`## 这一版更新了什么、修复了什么`, '']
  const head = commits[0]
  if (head === undefined) {
    lines.push('（该区间无提交记录）')
  } else if (head.body.trim() === '') {
    lines.push(`- ${head.subject}`)
    for (const c of commits.slice(1)) lines.push(`- ${c.subject}`)
    lines.push('', `<!-- ${SUMMARY_MARKER} 该区间有 ${commits.length} 条提交，而被标签指到的那次`
      + '提交没有正文。发版前请在那次提交的正文里补一段面向使用者的总述（说清更新了什么、'
      + '影响谁、要不要动手），重新起草后再发。只列提交主题的稿子不算成品。 -->')
  } else {
    lines.push(head.body)
  }
  // 取数上限必须明示：超 100 条时老的提交静默丢失，不写就是“看起来全了”。
  if (commits.length >= 100) lines.push('', '（仅列最近 100 条，更早的见完整改动对比）')
  lines.push('', `**完整改动**：${compare}`, '')
  const target = outPath ?? `./${tag}-notes.md`
  try {
    writeFileSync(target, lines.join('\n'), { encoding: 'utf8' })
  } catch (error) {
    process.stderr.write(`错误：无法写入 ${target}——${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
  process.stdout.write(`已起草：${target}（${commits.length} 条提交）\n`)
  return 0
}

process.exitCode = main()
