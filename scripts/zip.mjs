#!/usr/bin/env node
/**
 * zip.mjs —— 读 zip 包
 *
 * 为什么需要它：用户包是一份 zip，而「这个副本有没有被改过」只能靠**逐个文件比对**同一版本
 * 的包来回答。要回答它就得先把 zip 解开。这件事用系统自带的解压工具也能做，但那要求使用者
 * 机器上正好有那个工具、而且它的命令行在各平台长得不一样——一个本该在任何地方都能跑的
 * 自更新，不该建立在这个前提上。内置模块够用，就自己读。
 *
 * 只读，不写：这个 skill 从来不产出 zip（发布工作流用的是 git archive），所以没有写的那一半。
 *
 * 格式只实现到够用的程度：
 *   - 认中央目录（末尾的 EOCD），不流式扫本地头——中央目录是权威的那一份；
 *   - 存储（0）与 deflate（8）两种压缩方式，`git archive` 只会产出这两种；
 *   - ZIP64 明确拒绝：本 skill 的用户包远不到 4 GB，遇到它说明这不是我们要读的东西，
 *     报出来比猜一个更安全。
 */

import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const EOCD_MIN = 22
const EOCD_MAX_COMMENT = 0xffff
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_LOCATOR_SIG = 0x07064b50

/** 从末尾往前找 EOCD：注释最长 65535，所以最多回看这么多。 */
function findEocd(buf) {
  const from = Math.max(0, buf.length - EOCD_MIN - EOCD_MAX_COMMENT)
  for (let i = buf.length - EOCD_MIN; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue
    return { offset: i, count: buf.readUInt16LE(i + 10), size: buf.readUInt32LE(i + 12) }
  }
  return undefined
}

/**
 * 解开一份 zip，返回 `[{ name, data }]`（目录条目跳过，名字保持原样）。
 *
 * 坏包一律抛错，不返回半份内容：拿到半份内容去覆盖文件，比直接失败坏得多。
 */
export function readZip(buf) {
  const eocd = findEocd(buf)
  if (eocd === undefined) throw new Error('找不到中央目录结尾记录 —— 这不是一个完整的 zip')

  // ZIP64：记录本体在别处，中央目录的字段都是占位值，照普通格式读会读出一堆假数字。
  // 定位记录紧贴在 EOCD 之前，所以只看那一个位置就够。
  const locatorAt = eocd.offset - 20
  if (locatorAt >= 0 && buf.readUInt32LE(locatorAt) === ZIP64_LOCATOR_SIG) {
    throw new Error('这个 zip 用了 ZIP64 —— 本脚本读不了，请手工解压覆盖')
  }

  const entries = []
  let p = eocd.offset - eocd.size
  for (let n = 0; n < eocd.count; n += 1) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('中央目录条目损坏')
    const method = buf.readUInt16LE(p + 10)
    const compressed = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localAt = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue                       // 目录条目：路径由文件自己带出来
    if (buf.readUInt32LE(localAt) !== LOCAL_SIG) throw new Error(`条目 ${name} 的本地头损坏`)
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    const raw = buf.subarray(dataAt, dataAt + compressed)
    if (method === 0) entries.push({ name, data: Buffer.from(raw) })
    else if (method === 8) entries.push({ name, data: inflateRawSync(raw) })
    else throw new Error(`条目 ${name} 用了不认识的压缩方式 ${method}`)
  }
  return entries
}

/**
 * 把一份 zip 的条目去掉共同的前缀目录。
 *
 * 用户包是用 `--prefix=project-forge-<版本>/` 打的，解压出来是一个目录；而副本自己就在
 * 那个目录里，所以比对时要看的是**前缀之后**的路径。前缀由第一个条目推出来，不写死——
 * 版本号会变。
 */
export function stripCommonPrefix(entries) {
  if (entries.length === 0) return entries
  const first = entries[0].name
  const cut = first.lastIndexOf('/')
  if (cut < 0) return entries
  const prefix = first.slice(0, cut + 1)
  if (!entries.every((e) => e.name.startsWith(prefix))) return entries
  return entries.map((e) => ({ name: e.name.slice(prefix.length), data: e.data }))
}
