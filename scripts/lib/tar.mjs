/**
 * tar.mjs —— 纯 JS POSIX USTAR / PAX tar 编解码与安全路径校验（供 backup.mjs 使用）。
 */

import { basename } from 'node:path'

import { COMMON_SKIP_DIRS } from './protocol.mjs'
import { posixPath } from './text.mjs'

const BLOCK_SIZE = 512

/** 按 UTF-8 字节长度安全截断字符串，绝不在多字节字符中间劈裂。 */
export function truncateUtf8Bytes(str, maxBytes) {
  const buf = Buffer.from(String(str ?? ''), 'utf8')
  if (buf.length <= maxBytes) return buf
  let end = Math.max(0, maxBytes)
  if (end < buf.length && (buf[end] & 0xC0) === 0x80) {
    while (end > 0 && (buf[end] & 0xC0) === 0x80) end -= 1
  }
  return buf.subarray(0, end)
}

export function assertSafeRelPath(rel) {
  const clean = posixPath(rel).replace(/^(?:\.\/)+/, '')
  if (!clean || clean.startsWith('/') || /^[A-Za-z]:/.test(clean) || clean.includes('\0')) {
    throw new Error(`快照条目路径不安全：${rel}`)
  }
  const parts = clean.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) {
    throw new Error(`快照条目包含越界路径段：${rel}`)
  }
  if (parts.slice(0, -1).some((p) => COMMON_SKIP_DIRS.has(p))) {
    throw new Error(`快照条目命中保留跳过目录：${rel}`)
  }
  return clean
}

function writeOctal(buf, offset, length, value) {
  const oct = Math.max(0, Math.floor(value)).toString(8)
  const maxDigits = length - 1
  if (oct.length > maxDigits) {
    throw new Error(`数值超出 USTAR 八进制字段上限：${value}`)
  }
  const padded = `${oct.padStart(maxDigits, '0')}\0`
  buf.write(padded, offset, length, 'ascii')
}

function splitUstarPath(relPath) {
  const full = Buffer.from(relPath, 'utf8')
  if (full.length <= 100) {
    return { nameBuf: full, prefixBuf: Buffer.alloc(0), needsPax: false }
  }
  let searchFrom = relPath.indexOf('/')
  while (searchFrom !== -1) {
    const candidatePrefix = relPath.slice(0, searchFrom)
    const candidateName = relPath.slice(searchFrom + 1)
    const prefixBuf = Buffer.from(candidatePrefix, 'utf8')
    const nameBuf = Buffer.from(candidateName, 'utf8')
    if (prefixBuf.length <= 155 && nameBuf.length > 0 && nameBuf.length <= 100) {
      return { nameBuf, prefixBuf, needsPax: false }
    }
    searchFrom = relPath.indexOf('/', searchFrom + 1)
  }
  return {
    nameBuf: truncateUtf8Bytes(relPath, 100),
    prefixBuf: Buffer.alloc(0),
    needsPax: true,
  }
}

function buildPaxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  let total = String(bodyBytes).length + bodyBytes
  while (String(total).length + bodyBytes !== total) {
    total = String(total).length + bodyBytes
  }
  return Buffer.from(`${total}${body}`, 'utf8')
}

function buildUstarHeader({ nameBuf, prefixBuf, mode, size, mtimeSec, typeflag }) {
  const hdr = Buffer.alloc(BLOCK_SIZE, 0)
  nameBuf.copy(hdr, 0, 0, Math.min(nameBuf.length, 100))
  writeOctal(hdr, 100, 8, mode & 0o7777)
  writeOctal(hdr, 108, 8, 0)
  writeOctal(hdr, 116, 8, 0)
  writeOctal(hdr, 124, 12, size)
  writeOctal(hdr, 136, 12, mtimeSec)
  hdr.fill(0x20, 148, 156)
  hdr.write(typeflag, 156, 1, 'ascii')
  hdr.write('ustar\0', 257, 6, 'ascii')
  hdr.write('00', 263, 2, 'ascii')
  writeOctal(hdr, 329, 8, 0)
  writeOctal(hdr, 337, 8, 0)
  if (prefixBuf.length > 0) {
    prefixBuf.copy(hdr, 345, 0, Math.min(prefixBuf.length, 155))
  }

  let checksum = 0
  for (let i = 0; i < BLOCK_SIZE; i++) checksum += hdr[i]
  const chkStr = `${checksum.toString(8).padStart(6, '0')}\0 `
  hdr.write(chkStr, 148, 8, 'ascii')
  return hdr
}

function padBlockChunk(buf) {
  const rem = buf.length % BLOCK_SIZE
  if (rem === 0) return buf
  return Buffer.concat([buf, Buffer.alloc(BLOCK_SIZE - rem, 0)])
}

/** 将文件数组编码为标准 POSIX USTAR tar Buffer（兼容 `--format tar.gz` 与恢复）。 */
export function packTar(entries) {
  const chunks = []
  for (const entry of entries) {
    const rel = assertSafeRelPath(entry.relPath)
    const data = typeof entry.readData === 'function'
      ? entry.readData()
      : (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? ''))
    const mode = typeof entry.mode === 'number' ? (entry.mode & 0o777) : 0o644
    const mtimeSec = typeof entry.mtimeMs === 'number' ? Math.floor(entry.mtimeMs / 1000) : Math.floor(Date.now() / 1000)

    const split = splitUstarPath(rel)
    if (split.needsPax) {
      const paxPayload = buildPaxRecord('path', rel)
      const paxName = truncateUtf8Bytes(`PaxHeaders/${basename(rel)}`, 95)
      chunks.push(buildUstarHeader({
        nameBuf: paxName,
        prefixBuf: Buffer.alloc(0),
        mode: 0o644,
        size: paxPayload.length,
        mtimeSec,
        typeflag: 'x',
      }))
      chunks.push(padBlockChunk(paxPayload))
    }

    chunks.push(buildUstarHeader({
      nameBuf: split.nameBuf,
      prefixBuf: split.prefixBuf,
      mode,
      size: data.length,
      mtimeSec,
      typeflag: '0',
    }))
    if (data.length > 0) {
      chunks.push(padBlockChunk(data))
    }
  }
  chunks.push(Buffer.alloc(BLOCK_SIZE * 2, 0))
  return Buffer.concat(chunks)
}

function readZeroTermAscii(buf, start, length) {
  const slice = buf.subarray(start, start + length)
  const nul = slice.indexOf(0)
  return slice.subarray(0, nul === -1 ? slice.length : nul).toString('utf8')
}

function verifyHeaderChecksum(hdr) {
  const expectedStr = readZeroTermAscii(hdr, 148, 8).trim()
  const expected = Number.parseInt(expectedStr, 8)
  if (!Number.isFinite(expected)) return false
  let actual = 0
  for (let i = 0; i < BLOCK_SIZE; i++) {
    actual += i >= 148 && i < 156 ? 0x20 : hdr[i]
  }
  return actual === expected
}

function isZeroBlock(buf) {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) return false
  }
  return true
}

function parsePaxRecords(buf) {
  const attrs = {}
  const text = buf.toString('utf8')
  let idx = 0
  while (idx < text.length) {
    const sp = text.indexOf(' ', idx)
    const nl = text.indexOf('\n', idx)
    if (sp === -1 || nl === -1) break
    const line = text.slice(sp + 1, nl)
    const eq = line.indexOf('=')
    if (eq > 0) {
      attrs[line.slice(0, eq)] = line.slice(eq + 1)
    }
    idx = nl + 1
  }
  return attrs
}

/** 解析标准 POSIX USTAR tar Buffer 为文件列表，校验校验和与路径安全性。 */
export function unpackTar(tarBuf) {
  if (!Buffer.isBuffer(tarBuf) || tarBuf.length % BLOCK_SIZE !== 0) {
    throw new Error('tar 归档格式无效（非 512 字节对齐）')
  }
  const files = []
  let offset = 0
  let nextPax = {}

  while (offset + BLOCK_SIZE <= tarBuf.length) {
    const hdr = tarBuf.subarray(offset, offset + BLOCK_SIZE)
    offset += BLOCK_SIZE
    if (isZeroBlock(hdr)) break
    if (!verifyHeaderChecksum(hdr)) {
      throw new Error('tar 归档校验和失败，快照文件可能已损坏')
    }

    const name = readZeroTermAscii(hdr, 0, 100)
    const prefix = readZeroTermAscii(hdr, 345, 155)
    const rawMode = Number.parseInt(readZeroTermAscii(hdr, 100, 8).trim(), 8)
    const size = Number.parseInt(readZeroTermAscii(hdr, 124, 12).trim(), 8) || 0
    const mtimeSec = Number.parseInt(readZeroTermAscii(hdr, 136, 12).trim(), 8) || 0
    const typeflag = String.fromCharCode(hdr[156])

    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE
    if (offset + paddedSize > tarBuf.length) {
      throw new Error('tar 归档提前截断')
    }
    const data = Buffer.from(tarBuf.subarray(offset, offset + size))
    offset += paddedSize

    if (typeflag === 'x') {
      nextPax = { ...nextPax, ...parsePaxRecords(data) }
      continue
    }
    if (typeflag === '5') {
      nextPax = {}
      continue
    }
    if (typeflag === '0' || typeflag === '\0') {
      const combined = nextPax.path || (prefix ? `${prefix}/${name}` : name)
      nextPax = {}
      files.push({
        relPath: assertSafeRelPath(combined),
        data,
        mode: Number.isFinite(rawMode) ? (rawMode & 0o777) : 0o644,
        mtimeMs: mtimeSec * 1000,
      })
    } else {
      nextPax = {}
    }
  }

  return files
}
