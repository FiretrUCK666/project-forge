#!/usr/bin/env node
/**
 * zip.mjs —— 纯内置 `node:zlib` zip 读写器
 *
 * 格式只实现到够用的程度：
 *   - 认中央目录（EOCD `i+16` 偏移，不猜相邻地址）并做双向边界与 CRC32 校验；
 *   - 存储（0）与 deflate（8）两种压缩方式，统一标 UTF-8 文件名位（`0x0800`）；
 *   - ZIP64 明确拒绝：用户包与写前快照远不到 4 GB，遇到时直接报错，不读假数字。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const EOCD_MIN = 22
const EOCD_MAX_COMMENT = 0xffff
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_LOCATOR_SIG = 0x07064b50
const ZIP_UTF8_FLAG = 0x0800

/**
 * 一份 zip 解压后的默认总字节上限（20 MB，用于远程更新包防 zip 炸弹）。
 * backup 快照恢复会按本地仓场景显式传入更高合法上限。
 */
export const MAX_UNCOMPRESSED_TOTAL = 20 * 1024 * 1024

/** 单个条目的默认解压上限（20 MB）。 */
export const MAX_UNCOMPRESSED_ENTRY = 20 * 1024 * 1024

/**
 * CRC32 查表。zip 中央目录记着每个条目的校验和，解压时必须核对以防截断或篡改。
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[i] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** 从末尾往前找 EOCD：按规范读取 `i + 16` 的中央目录起始偏移 `cdOffset`。 */
function findEocd(buf) {
  const from = Math.max(0, buf.length - EOCD_MIN - EOCD_MAX_COMMENT)
  for (let i = buf.length - EOCD_MIN; i >= from; i -= 1) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue
    return {
      offset: i,
      count: buf.readUInt16LE(i + 10),
      size: buf.readUInt32LE(i + 12),
      cdOffset: buf.readUInt32LE(i + 16),
    }
  }
  return undefined
}

function toDosDateTime(mtimeMs) {
  const d = new Date(Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : Date.now())
  const year = Math.max(1980, Math.min(2107, d.getFullYear()))
  const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { dosTime: dosTime & 0xffff, dosDate: dosDate & 0xffff }
}

function fromDosDateTime(dosTime, dosDate) {
  const day = dosDate & 0x1f
  const month = ((dosDate >>> 5) & 0x0f) - 1
  const year = ((dosDate >>> 9) & 0x7f) + 1980
  if (day < 1 || month < 0 || month > 11) return undefined
  const sec = (dosTime & 0x1f) * 2
  const min = (dosTime >>> 5) & 0x3f
  const hour = (dosTime >>> 11) & 0x1f
  return new Date(year, month, day, hour, min, sec).getTime()
}

/**
 * 解开一份 zip，返回 `[{ name, data, mode?, mtimeMs? }]`（跳过目录条目）。
 * 坏包、校验失败或超上限一律抛错。
 */
export function readZip(buf, {
  maxTotalBytes = MAX_UNCOMPRESSED_TOTAL,
  maxEntryBytes = MAX_UNCOMPRESSED_ENTRY,
} = {}) {
  const eocd = findEocd(buf)
  if (eocd === undefined) throw new Error('找不到中央目录结尾记录 —— 这不是一个完整的 zip')

  const locatorAt = eocd.offset - 20
  if ((locatorAt >= 0 && buf.readUInt32LE(locatorAt) === ZIP64_LOCATOR_SIG)
    || eocd.count === 0xffff || eocd.size === 0xffffffff || eocd.cdOffset === 0xffffffff) {
    throw new Error('这个 zip 用了 ZIP64 —— 本脚本读不了，请手工解压覆盖')
  }

  if (eocd.cdOffset + eocd.size > eocd.offset) {
    throw new Error('中央目录偏移与尺寸越界 —— 这不是一个完整的 zip')
  }

  const entries = []
  let total = 0
  let p = eocd.cdOffset
  for (let n = 0; n < eocd.count; n += 1) {
    if (p + 46 > eocd.offset || buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error('中央目录条目损坏')
    const versionMadeBy = buf.readUInt16LE(p + 4)
    const method = buf.readUInt16LE(p + 10)
    const dosTime = buf.readUInt16LE(p + 12)
    const dosDate = buf.readUInt16LE(p + 14)
    const expectedCrc = buf.readUInt32LE(p + 16)
    const compressed = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const extAttrs = buf.readUInt32LE(p + 38)
    const localAt = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (name.endsWith('/')) continue
    if (localAt + 30 > eocd.cdOffset || buf.readUInt32LE(localAt) !== LOCAL_SIG) {
      throw new Error(`条目 ${name} 的本地头损坏`)
    }
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28)
    if (dataAt + compressed > eocd.cdOffset) {
      throw new Error(`条目 ${name} 数据区越界 —— 包可能已截断`)
    }
    const raw = buf.subarray(dataAt, dataAt + compressed)
    let data
    if (method === 0) {
      if (raw.length > maxEntryBytes) {
        throw new Error(`条目 ${name} 解压超过 ${maxEntryBytes} 字节上限`)
      }
      data = Buffer.from(raw)
    } else if (method === 8) {
      data = inflateRawSync(raw, { maxOutputLength: maxEntryBytes })
    } else {
      throw new Error(`条目 ${name} 用了不认识的压缩方式 ${method}`)
    }

    const actualCrc = crc32(data)
    if (actualCrc !== expectedCrc) {
      throw new Error(`条目 ${name} 的校验和不符（期望 ${expectedCrc.toString(16)}，实际 ${actualCrc.toString(16)}）`
        + '—— 包在传输中损坏或被改动过，不要拿它覆盖文件')
    }

    total += data.length
    if (total > maxTotalBytes) {
      throw new Error(`解压总量超过 ${maxTotalBytes} 字节上限 —— 这不像一个正常的用户包`)
    }
    const unixPerms = (versionMadeBy >>> 8) === 3 ? ((extAttrs >>> 16) & 0o777) : 0
    const mtimeMs = fromDosDateTime(dosTime, dosDate)
    entries.push({
      name,
      data,
      ...(unixPerms ? { mode: unixPerms } : {}),
      ...(mtimeMs !== undefined ? { mtimeMs } : {}),
    })
  }
  return entries
}

/**
 * 纯 JS 生成标准 ZIP（Stored=0 / Deflate=8、UTF-8 文件名标志 `0x0800`、Unix 模式与 CRC32）。
 * 支持每条目传入 `{ name | relPath, data | readData, mode?, mtimeMs? }` 并在写完当前条目后释放字节引用。
 */
export function writeZip(entries, { level = 6 } = {}) {
  const list = Array.isArray(entries) ? entries : []
  if (list.length >= 0xffff) {
    throw new Error(`zip 条目数 ${list.length} 超出标准 65535 上限（本工具不产出 ZIP64）`)
  }

  const localChunks = []
  const cdChunks = []
  let localOffset = 0

  for (const entry of list) {
    const rawName = String(entry.name ?? entry.relPath ?? '').replace(/\\/g, '/')
    if (!rawName || rawName.includes('\0')) throw new Error(`zip 条目文件名非法：${rawName}`)
    const nameBuf = Buffer.from(rawName, 'utf8')
    const data = typeof entry.readData === 'function'
      ? entry.readData()
      : (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? ''))

    const crc = crc32(data)
    let method = 0
    let payload = data
    if (level > 0 && data.length >= 32) {
      const deflated = deflateRawSync(data, { level })
      if (deflated.length < data.length) {
        method = 8
        payload = deflated
      }
    }

    const { dosTime, dosDate } = toDosDateTime(entry.mtimeMs)
    const mode = typeof entry.mode === 'number' ? (entry.mode & 0o777) : 0o644
    const extAttrs = (((0o100000 | mode) << 16) >>> 0)

    const lh = Buffer.allocUnsafe(30 + nameBuf.length)
    lh.writeUInt32LE(LOCAL_SIG, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(ZIP_UTF8_FLAG, 6)
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(dosTime, 10)
    lh.writeUInt16LE(dosDate, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(payload.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    nameBuf.copy(lh, 30)

    localChunks.push(lh, payload)

    const ch = Buffer.allocUnsafe(46 + nameBuf.length)
    ch.writeUInt32LE(CENTRAL_SIG, 0)
    ch.writeUInt16LE((3 << 8) | 20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(ZIP_UTF8_FLAG, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(dosTime, 12)
    ch.writeUInt16LE(dosDate, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(payload.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(extAttrs, 38)
    ch.writeUInt32LE(localOffset, 42)
    nameBuf.copy(ch, 46)

    cdChunks.push(ch)
    localOffset += lh.length + payload.length
  }

  let cdSize = 0
  for (const c of cdChunks) cdSize += c.length

  const eocd = Buffer.allocUnsafe(EOCD_MIN)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(list.length, 8)
  eocd.writeUInt16LE(list.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(localOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, ...cdChunks, eocd], localOffset + cdSize + EOCD_MIN)
}

/**
 * 把一份 zip 的条目去掉共同的第一段前缀目录（如 `project-forge-<版本>/`）。
 */
export function stripCommonPrefix(entries) {
  if (entries.length === 0) return entries
  const first = entries[0].name
  const cut = first.indexOf('/')
  if (cut < 0) return entries
  const prefix = first.slice(0, cut + 1)
  if (!entries.every((e) => e.name.startsWith(prefix))) return entries
  return entries.map((e) => ({ name: e.name.slice(prefix.length), data: e.data }))
}
