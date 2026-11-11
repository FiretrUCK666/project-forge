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
 * 清掉遗留的临时文件。**传文件或目录都行**，返回 `{ removed, kept }`。
 *
 * 两种调用方各有所需，而它们的差别不是风格：
 *
 *   - 传**目录**（`sync-toc` 那种「扫一遍工作区」）：清这个目录下所有 `*.tmp-<pid>`；
 *   - 传**文件**（`update` 那种「我要写这个路径」）：只清 `basename.tmp-<pid>` 这一族，
 *     同一目录里别人的临时文件不归它管。
 *
 * 返回值分两组、不再只给一个数组：**「没动的那些」也是结论**。使用者有权知道
 * 「有两个临时文件是活的进程留下的」，而不是只看到「清掉了 0 个」。
 * 只返回数组时，调用方想拿到 `kept` 只能自己再扫一遍——那就会出现两份扫法。
 *
 * 三条保护，每条都对应一类误删：
 *   - 后缀不是纯数字的**不是我们的**（可能是使用者的 `notes.txt.tmp-backup`）；
 *   - 本次进程自己的不动（它可能正在用）；
 *   - 属主还活着的不动（别的实例可能在用）。
 *
 * `dryRun` 时只报不删——只读模式下删文件会让「只读」这个承诺变成假话。
 */
export function clearStaleTemps(targetPath, { dryRun = false } = {}) {
  const removed = []
  const kept = []
  let dir = targetPath
  let onlyBase = null
  try {
    if (!statSync(targetPath).isDirectory()) {
      dir = dirname(targetPath)
      onlyBase = basename(targetPath)
    }
  } catch {
    // 目标还不存在：按文件路径处理，扫它所在目录里同名前缀的残留。
    dir = dirname(targetPath)
    onlyBase = basename(targetPath)
  }

  let entries = []
  try { entries = readdirSync(dir) } catch { return { removed, kept } }
  for (const name of entries) {
    const m = /^(.+)\.tmp-(\d+)$/.exec(name)
    if (!m) continue
    // 只清「这个文件的」临时文件时，前缀必须逐字对上。
    if (onlyBase !== null && m[1] !== onlyBase) continue
    const pid = Number(m[2])
    if (pid === process.pid || processAlive(pid)) { kept.push(join(dir, name)); continue }
    const full = join(dir, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch { continue }
    removed.push(full)
    if (!dryRun) {
      try { unlinkSync(full) } catch { /* 删不掉就留着，下次还会看到 */ }
    }
  }
  return { removed, kept }
}

/** 把清理结果说出来。**默默清理等于让使用者以为文件本来就是那样。**
 *
 * 返回值是给人看的一句话（空串表示没什么可说）。调用方自己决定写到哪儿。
 * 两类都要说：清掉的，以及**看见了但没动的**——后者常被读成「没有残留」。
 */
export function reportTemps({ removed = [], kept = [] } = {}, { dryRun = false } = {}) {
  const bits = []
  if (removed.length > 0) {
    const verb = dryRun ? '发现了遗留的临时文件（未删）' : '清掉了遗留的临时文件'
    bits.push(`${verb}：${removed.map((p) => basename(p)).join('、')}`)
  }
  if (kept.length > 0) {
    bits.push(`另有 ${kept.length} 个临时文件属于仍在运行的进程，没动：${kept.map((p) => basename(p)).join('、')}`)
  }
  return bits.length === 0 ? '' : `${bits.join('\n')}\n`
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