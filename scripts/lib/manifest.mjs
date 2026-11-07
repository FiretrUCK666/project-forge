/**
 * manifest.mjs —— 目录大小写无关索引与清单分节提取。
 *
 * 统一下沉的目录索引与清单解析底层，供 survey、compose-agents、review 共用。
 */

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 目录索引：大小写无关匹配，支持顶层与子路径（如 .github/copilot-instructions.md）。
 */
export function listRoot(root) {
  const cache = new Map()
  let rootError

  function getDirTable(dir) {
    if (cache.has(dir)) return cache.get(dir)
    const table = new Map()
    try {
      const entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        table.set(entry.name.toLowerCase(), {
          name: entry.name,
          isFile: entry.isFile(),
          isDir: entry.isDirectory(),
        })
      }
    } catch (err) {
      if (dir === root) rootError = err instanceof Error ? err.message : String(err)
    }
    cache.set(dir, table)
    return table
  }

  const rootTable = getDirTable(root)

  function resolvePath(subPath) {
    if (typeof subPath !== 'string' || subPath === '') return undefined
    const parts = subPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length === 0) return undefined
    let currentDir = root
    const resolvedParts = []
    for (let i = 0; i < parts.length; i += 1) {
      const partLower = parts[i].toLowerCase()
      const table = getDirTable(currentDir)
      const entry = table.get(partLower)
      if (!entry) return undefined
      resolvedParts.push(entry.name)
      if (i < parts.length - 1) {
        if (!entry.isDir) return undefined
        currentDir = join(currentDir, entry.name)
      }
    }
    return resolvedParts.join('/')
  }

  function resolveEntry(subPath) {
    if (typeof subPath !== 'string' || subPath === '') return undefined
    const parts = subPath.replace(/\\/g, '/').split('/').filter(Boolean)
    if (parts.length === 0) return undefined
    let currentDir = root
    let lastEntry
    for (let i = 0; i < parts.length; i += 1) {
      const partLower = parts[i].toLowerCase()
      const table = getDirTable(currentDir)
      const entry = table.get(partLower)
      if (!entry) return undefined
      lastEntry = entry
      if (i < parts.length - 1) {
        if (!entry.isDir) return undefined
        currentDir = join(currentDir, entry.name)
      }
    }
    return lastEntry
  }

  return {
    has(name) {
      if (typeof name !== 'string') return false
      if (name.includes('/') || name.includes('\\')) {
        return resolvePath(name) !== undefined
      }
      return rootTable.has(name.toLowerCase())
    },
    real(name) {
      if (typeof name !== 'string') return undefined
      if (name.includes('/') || name.includes('\\')) {
        return resolvePath(name)
      }
      return rootTable.get(name.toLowerCase())?.name
    },
    entry(name) {
      if (typeof name !== 'string') return undefined
      if (name.includes('/') || name.includes('\\')) {
        return resolveEntry(name)
      }
      return rootTable.get(name.toLowerCase())
    },
    first(candidates) {
      for (const name of candidates) {
        const found = this.real(name)
        if (found !== undefined) return found
      }
      return undefined
    },
    filesIn(sub, re) {
      const dir = sub === '' ? root : join(root, sub)
      const table = getDirTable(dir)
      const out = []
      for (const entry of table.values()) {
        if (entry.isFile && (re === undefined || re.test(entry.name))) {
          out.push(sub === '' ? entry.name : `${sub}/${entry.name}`)
        }
      }
      return out
    },
    get readError() { return rootError },
    get complete() { return rootError === undefined },
  }
}

/**
 * 清单表里某一项的正文：TOML 先切出它声明的那张表，其余格式原样返回。
 */
export function manifestSection(text, table) {
  if (table === undefined) return text
  const lines = String(text ?? '').split('\n')
  const head = table.toLowerCase()
  const out = []
  let inside = false
  for (const line of lines) {
    const m = /^\s*\[+([^\]]+)\]/.exec(line)
    if (m !== null) {
      inside = `[${m[1].trim().toLowerCase()}]` === head
      continue
    }
    if (inside) out.push(line)
  }
  return out.join('\n')
}
