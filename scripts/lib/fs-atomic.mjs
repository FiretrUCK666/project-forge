/**
 * fs-atomic.mjs —— 临时文件与原子写的唯一实现。
 *
 * 只回答一件事：**写到一半被杀，磁盘上会留下什么。** 不留半截文件，也不留无人认领的
 * 临时文件——两者都会在很久以后才以「某个文件坏了」的形式出现，而那时没人记得是
 * 哪次运行造成的。
 *
 * 临时文件名带进程号，判据是「属主还活着吗」。活着的进程可能在用，死掉的那个不会。
 */

import { existsSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 临时文件名形状的唯一来源：`原名.tmp-<pid>`。 */
export function tempPathFor(path) {
  return `${path}.tmp-${process.pid}`
}

/** 这个进程还活着吗。`EPERM` 说明它存在但属于别人，按活着算。 */
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * 清掉同目录下遗留的临时文件。
 *
 * 三条保护，每条都对应一类误删：
 *   - 后缀不是纯数字的**不是我们的**（可能是使用者的 `notes.txt.tmp-backup`）；
 *   - 本次进程自己的不动（它可能正在用）；
 *   - 属主还活着的不动（别的实例可能在用）。
 *
 * `dryRun` 时只报不删——只读模式下删文件会让「只读」这个承诺变成假话。
 */
export function clearStaleTemps(dir, { dryRun = false } = {}) {
  const removed = []
  let entries = []
  try { entries = readdirSync(dir) } catch { return removed }
  for (const name of entries) {
    const m = /^(.+)\.tmp-(\d+)$/.exec(name)
    if (!m) continue
    const pid = Number(m[2])
    if (pid === process.pid) continue
    if (processAlive(pid)) continue
    const full = join(dir, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch { continue }
    removed.push(full)
    if (!dryRun) {
      try { unlinkSync(full) } catch { /* 删不掉就留着，下次还会看到 */ }
    }
  }
  return removed
}

/** 把清理结果说出来。**默默清理等于让使用者以为文件本来就是那样。**
 *
 * 返回值是给人看的一句话（空串表示没什么可说）。调用方自己决定写到哪儿。
 */
export function reportTemps(removed, { dryRun = false } = {}) {
  if (!Array.isArray(removed) || removed.length === 0) return ''
  const verb = dryRun ? '发现了遗留的临时文件（未删）' : '清掉了遗留的临时文件'
  return `${verb}：${removed.map((p) => basename(p)).join('、')}\n`
}

/**
 * 原子写：先写临时文件、再改名。
 *
 * 同目录改名在同一个文件系统上是原子的，所以读者要么看到旧内容、要么看到新内容，
 * 不会看到半截。失败时把临时文件删掉——留着它，下一次运行会把它当成「别人的残留」。
 */
export function writeAtomic(path, content) {
  const tmp = tempPathFor(path)
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 清不掉就留着 */ }
    throw error
  }
}

/** 这个路径上有没有东西（文件或目录）。 */
export function exists(p) {
  return existsSync(p)
}

/** 父目录（给 `mkdirSync` 用）。 */
export function parentOf(p) {
  return dirname(p)
}
