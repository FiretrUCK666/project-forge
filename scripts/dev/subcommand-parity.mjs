#!/usr/bin/env node
/**
 * subcommand-parity.mjs —— 单源子命令元数据 SUBCOMMAND_META 与 6 套核心 CLI 的分阶段对拍门禁。
 *
 * 已接入 `subcommand-meta.mjs` 的入口（6B 四套 + 6C 接入后的 flow/review-pack）强制校验：
 *   1. 导入并调用 `subcommandNamesFor('<toolKey>')`；
 *   2. 文件头 `子命令：` 列表与单源集合一致；
 *   3. `printHelp()` 帮助声明与单源集合一致；
 *   4. `parseStandardCli` `usageHint` 与单源集合一致。
 * 尚未合入 6C 的 `flow.mjs` / `review-pack.mjs` 在未导入前先校验其源码 `SUBCOMMANDS` 数组与单源对齐。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule } from '../../kit/skills/lib/git-core.mjs'
import { SUBCOMMAND_META, subcommandNamesFor } from '../../kit/skills/lib/subcommand-meta.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')
const STRICT_6B_TOOLS = new Set(['doc-plan', 'govern-audit', 'verify-tools', 'iterate'])

function setDiff(expected, actual) {
  const expSet = new Set(expected)
  const actSet = new Set(actual)
  return {
    missing: expected.filter((x) => !actSet.has(x)),
    extra: actual.filter((x) => !expSet.has(x)),
  }
}

function matchBalancedBraces(text, openIdx) {
  let depth = 0
  let quote = null
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      if (ch === '\\') { i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') { quote = ch; continue }
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function extractHeaderSubcommands(text, expected) {
  const docM = /^[\s\S]*?\/\*\*([\s\S]*?)\*\//.exec(text)
  if (!docM) return { found: false, commands: [] }
  const block = docM[1]
  const secM = /子命令\s*[:：]([\s\S]*)$/.exec(block)
  if (!secM) return { found: false, commands: [] }
  const sec = secM[1]
  const known = new Set(expected)
  const commands = []
  for (const rawLine of sec.split('\n')) {
    const line = rawLine.replace(/^\s*\*\s?/, '').trim()
    if (!line) continue
    const pipeToks = line.includes('|') ? line.split('|').map((s) => s.trim()).filter(Boolean) : []
    if (pipeToks.length > 1 && pipeToks.every((tok) => /^[a-z][a-z0-9-]*$/.test(tok))) {
      commands.push(...pipeToks)
      continue
    }
    const m = /^([a-z][a-z0-9-]*)(?:\s|$)/.exec(line)
    if (m && (known.has(m[1]) || /^[a-z]+-[a-z-]+$/.test(m[1]))) commands.push(m[1])
  }
  return { found: true, commands: [...new Set(commands)] }
}

function extractPrintHelpSubcommands(text, expected) {
  const fnM = /\bfunction\s+printHelp\s*\(\s*\)\s*\{/.exec(text)
  if (!fnM) return { found: false, commands: [] }
  const open = fnM.index + fnM[0].length - 1
  const close = matchBalancedBraces(text, open)
  if (close < 0) return { found: false, commands: [] }
  const body = text.slice(open + 1, close)
  const commands = new Set()

  // 1. 用法行里的 [a|b|...] 或 <a|b|...>
  for (const line of body.split('\n')) {
    if (!/用法|usage/i.test(line)) continue
    for (const grp of line.matchAll(/[[<]([a-z0-9-]+(?:\|[a-z0-9-]+)+)[\]>]/gi)) {
      for (const item of grp[1].split('|')) commands.add(item.trim())
    }
  }

  // 2. 帮助清单行里列出的子命令
  const expSet = new Set(expected)
  for (const rawLine of body.split('\n')) {
    const clean = rawLine.trim().replace(/^['"`]\s*/, '').replace(/['"`]\s*,?\s*$/, '')
    const m = /^([a-z][a-z0-9-]*)(?:\s+(?:\||--|\[|<|$))/.exec(clean)
    if (m && expSet.has(m[1])) commands.add(m[1])
  }

  return { found: true, commands: [...commands] }
}

function extractUsageHintSubcommands(text, expected) {
  if (/\busageHint\s*:\s*`[^`]*\$\{SUBCOMMANDS\.join\(\s*['"]\|['"]\s*\)\}/.test(text)) {
    return { found: true, dynamic: true, commands: [...expected] }
  }
  const m = /\busageHint\s*:\s*(['"`])([^'"`]+)\1/.exec(text)
  if (!m) return { found: false, dynamic: false, commands: [] }
  const grp = /[[<]([a-z0-9-]+(?:\|[a-z0-9-]+)+)[\]>]/i.exec(m[2])
  if (!grp) return { found: true, dynamic: false, commands: [] }
  return { found: true, dynamic: false, commands: grp[1].split('|').map((s) => s.trim()).filter(Boolean) }
}

function extractStaticSubcommandsArray(text) {
  const m = /\bconst\s+SUBCOMMANDS\s*=\s*\[([^\]]+)\]/.exec(text)
  if (!m) return null
  return [...m[1].matchAll(/['"]([a-z0-9-]+)['"]/gi)].map((x) => x[1])
}

/** 校验 6 套核心 CLI 入口与 `SUBCOMMAND_META` 的分阶段对拍一致性。 */
export function evaluateSubcommandParity(ROOT = DEFAULT_ROOT) {
  const failures = []
  const notes = []

  for (const [toolKey, meta] of Object.entries(SUBCOMMAND_META)) {
    const abs = join(ROOT, meta.file)
    if (!existsSync(abs)) {
      failures.push(`${toolKey}：缺少入口文件 ${meta.file}`)
      continue
    }
    const text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    const expected = subcommandNamesFor(toolKey)
    const hasMetaImport = text.includes('subcommand-meta.mjs')
    const enforceFull = STRICT_6B_TOOLS.has(toolKey) || hasMetaImport

    if (!enforceFull) {
      const staticArr = extractStaticSubcommandsArray(text)
      if (!staticArr) {
        failures.push(`${toolKey}（${meta.file}）：未导入 subcommand-meta.mjs 且缺少静态 SUBCOMMANDS 数组`)
        continue
      }
      const { missing, extra } = setDiff(expected, staticArr)
      if (missing.length > 0 || extra.length > 0) {
        failures.push(`${toolKey}（${meta.file}）SUBCOMMANDS 与 SUBCOMMAND_META 不一致：missing=[${missing.join(',')}], extra=[${extra.join(',')}]`)
      } else {
        notes.push(`${toolKey}(staged:${expected.length})`)
      }
      continue
    }

    if (!hasMetaImport || !new RegExp(`subcommandNamesFor\\(\\s*['"]${toolKey}['"]\\s*\\)`).test(text)) {
      failures.push(`${toolKey}（${meta.file}）：必须导入并调用 subcommandNamesFor('${toolKey}')`)
    }

    const header = extractHeaderSubcommands(text, expected)
    if (!header.found) {
      failures.push(`${toolKey}（${meta.file}）：文件头缺少「子命令：」清单`)
    } else {
      const d = setDiff(expected, header.commands)
      if (d.missing.length > 0 || d.extra.length > 0) {
        failures.push(`${toolKey}（${meta.file}）文件头子命令与 SUBCOMMAND_META 不一致：missing=[${d.missing.join(',')}], extra=[${d.extra.join(',')}]`)
      }
    }

    const help = extractPrintHelpSubcommands(text, expected)
    if (!help.found) {
      failures.push(`${toolKey}（${meta.file}）：缺少 printHelp()`)
    } else {
      const d = setDiff(expected, help.commands)
      if (d.missing.length > 0 || d.extra.length > 0) {
        failures.push(`${toolKey}（${meta.file}）printHelp() 与 SUBCOMMAND_META 不一致：missing=[${d.missing.join(',')}], extra=[${d.extra.join(',')}]`)
      }
    }

    const hint = extractUsageHintSubcommands(text, expected)
    if (!hint.found) {
      failures.push(`${toolKey}（${meta.file}）：parseStandardCli 缺少 usageHint`)
    } else {
      const d = setDiff(expected, hint.commands)
      if (d.missing.length > 0 || d.extra.length > 0) {
        failures.push(`${toolKey}（${meta.file}）usageHint 与 SUBCOMMAND_META 不一致：missing=[${d.missing.join(',')}], extra=[${d.extra.join(',')}]`)
      }
    }

    if (failures.every((f) => !f.startsWith(`${toolKey}（`))) {
      notes.push(`${toolKey}(full:${expected.length})`)
    }
  }

  return { ok: failures.length === 0, failures, notes }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const res = evaluateSubcommandParity(DEFAULT_ROOT)
  for (const f of res.failures) process.stderr.write(`FAIL  ${f}\n`)
  if (res.ok) {
    process.stdout.write(`subcommand-parity: PASS (${res.notes.join(', ')})\n`)
    process.exit(0)
  }
  process.exit(1)
}
