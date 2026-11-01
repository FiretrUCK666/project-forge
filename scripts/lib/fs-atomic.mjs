/**
 * fs-atomic.mjs —— 原子写入与临时文件的生命周期。
 *
 * 「先写临时文件、再改名」是全仓库所有落盘动作的共同前提：中途失败不能留下半截
 * 文件，否则下一个读它的人拿到的是一份看起来正常、实际残缺的内容。
 *
 * 临时文件需要属主，因为**并发是这个工具的常态**（AI 并行、CI 并发、编辑器插件与
 * AI 同时操作）。属主用进程号表达，清理时据此判断那个文件还有没有主人。
 *
 * 这一层**不认识任何业务概念**：它不知道 AGENTS.md、不知道 TOC，只处理「一个路径
 * 与它的临时文件」。任何往这里塞业务判断的改动都放错了地方。
 */

import { readdirSync, renameSync, unlinkSync, writeFileSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 本工具的临时文件名：**原名 + `.tmp-` + 进程号**。
 *
 * 形状写在两处就一定会漂，所以它只此一份。
 * 进程号是「属主」：清理时靠它判断这个临时文件还有没有主。
 */
export function tempPathFor(target, pid = process.pid) {
  return `${target}.tmp-${pid}`
}

/**
 * 这个进程号还活着吗？
 *
 * 判据用 `process.kill(pid, 0)`：ESRCH = 没有这个进程；其余（例如 EPERM）
 * 说明进程存在、只是问不动它——**问不动不等于不在**，所以那种情况按「还活着」处理。
 * 问不出来（不是合法进程号）一律按「不在」，但那类文件根本进不到这一步。
 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code !== 'ESRCH'
  }
}

/**
 * 清掉这个文件此前的临时文件。
 *
 * **只删能证明是「已经死掉的进程」留下的那些**，其余一律留下并报出来。两条判据都要：
 *
 *   - **形状**必须是 `<原名>.tmp-<纯数字>`。纯数字是进程号；同前缀但不是纯数字的
 *     （`README.md.tmp-backup` 这类）是**使用者自己的文件**，不是残留——删掉它就是
 *     悄悄毁掉别人的东西。而且它连残留报告都认不出来（那边用的是同一个形状判据），
 *     于是使用者永远不知道自己被删了。
 *   - **属主还活着吗**：活着说明它是**另一个正在跑的进程**手里的临时文件。删了它，
 *     那次运行的改名会失败（ENOENT），报一句「处理失败」收工——文件没坏，
 *     但那次白跑。
 *
 * 代价说清楚：进程号会被系统回收。**被回收的那个号**若正好落在一个活着的进程上，
 * 它的残留就清不掉（要等那个进程也退出）。留着比误删好——残留是一个文件，误删是丢数据。
 *
 * 返回 { removed, kept }：removed 是清掉的，kept 是留下的（带原因，交上层报出来）。
 */
export function clearStaleTemps(path) {
  const dir = dirname(path)
  const prefix = `${basename(path)}.tmp-`
  const removed = []
  const kept = []
  let entries
  try { entries = readdirSync(dir) } catch { return { removed, kept } }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const suffix = name.slice(prefix.length)
    if (!/^\d+$/.test(suffix)) {
      kept.push({ name, why: '不是本工具的临时文件（使用者自己的？）' })
      continue
    }
    const pid = Number(suffix)
    if (pid === process.pid) {
      kept.push({ name, why: '本次运行正在写它' })
      continue
    }
    if (processAlive(pid)) {
      kept.push({ name, why: '另一个正在运行的进程正在写它' })
      continue
    }
    try {
      unlinkSync(join(dir, name))
      removed.push(name)
    } catch { /* 清不掉就算了 */ }
  }
  return { removed, kept }
}

/**
 * 临时文件的清理结果要说出来：清了什么、什么没清以及为什么。
 *
 * 不说就是「静默」：没清掉的文件会一直躺在那儿，而看报告的人无从判断它是残留
 * 还是别人的东西——下一次运行还会再遇到它。
 *
 * 判据与报告是一件事的两半，各写一份报告格式，就会出现同一个残留在一个工具里
 * 报「已清理」、在另一个工具里报「没动」。
 */
export function reportTemps(file, temps) {
  if (temps.removed.length === 0 && temps.kept.length === 0) return
  const parts = []
  if (temps.removed.length > 0) parts.push(`清掉 ${temps.removed.length} 个上次遗留的临时文件`)
  if (temps.kept.length > 0) {
    parts.push(`没动 ${temps.kept.length} 个同前缀但不属于本次运行的文件：`
      + temps.kept.map((k) => `${k.name}（${k.why}）`).join('、'))
  }
  process.stdout.write(`${file}：${parts.join('；')}\n`)
}

/**
 * 先写临时文件再改名：中途失败不会留下半截文件。
 *
 * 失败时清掉自己的临时文件：它带着 `.tmp-` 后缀留在仓库里，会被结构自检当成无主文件。
 */
export function writeAtomic(path, content) {
  const tmp = tempPathFor(path)
  try {
    writeFileSync(tmp, content, { encoding: 'utf8' })
    renameSync(tmp, path)
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* 清不掉就算了 */ }
    throw error
  }
}
