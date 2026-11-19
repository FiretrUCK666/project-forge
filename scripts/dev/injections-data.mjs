/**
 * injections-data.mjs —— 故障注入复验数据表（供 verify-injections.mjs 并行隔离注入）。
 * 按功能域通用自动发现并加载 `scripts/dev/injections-data-*.mjs`，新增功能域数据文件无需改动本索引。
 */

import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PRIORITY_FILES = [
  'injections-data-core.mjs',
  'injections-data-workflow.mjs',
  'injections-data-gates.mjs',
  'injections-data-adaptive.mjs',
]
const PRIORITY_INDEX = new Map(PRIORITY_FILES.map((name, i) => [name, i]))

const HERE = dirname(fileURLToPath(import.meta.url))
const dataFiles = readdirSync(HERE)
  .filter((n) => /^injections-data-[^/]+\.mjs$/.test(n))
  .sort((a, b) => {
    const pa = PRIORITY_INDEX.has(a) ? PRIORITY_INDEX.get(a) : Number.MAX_SAFE_INTEGER
    const pb = PRIORITY_INDEX.has(b) ? PRIORITY_INDEX.get(b) : Number.MAX_SAFE_INTEGER
    return pa !== pb ? pa - pb : a.localeCompare(b)
  })

const collected = []
for (const file of dataFiles) {
  const mod = await import(pathToFileURL(join(HERE, file)).href)
  for (const [key, val] of Object.entries(mod)) {
    if (Array.isArray(val) && (key.startsWith('INJECTIONS') || key === 'default')) {
      collected.push(...val)
    }
  }
}

/** 每条注入：改哪个文件、把什么换成什么、期望哪条断言变红。 */
export const INJECTIONS = collected
