#!/usr/bin/env node
/**
 * 证据集：把一次交付需要用到的外部材料落成文件，供打包挂到发布页。
 *
 * 这个脚本只做一件事：把当前这一版**要发出去的东西**列清楚、算清楚，写成文本。
 * 它不判断该不该发、不判断版本号——那两件是判断，在 `RELEASING.md` 里。
 *
 * 为什么值得单独一个脚本：发布页上的「这一版叫什么、包里有什么」如果每次靠人手工核对，
 * 迟早有一次对不上，而那种失败的发现方式是「用户装完发现问题」。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { skillVersion, skillSource } from '../lib/text.mjs'
import { isRepoOnlyPath } from '../lib/protocol.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

function walk(dir, pred, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, pred, out)
    else if (entry.isFile() && (pred === undefined || pred(full))) out.push(full)
  }
  return out
}

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write([
      '用法：node scripts/dev/evidence.mjs [--json]',
      '',
      '列出这一版要发出去的东西：版本号、来源、用户包条目与哈希。',
      '只读：不写任何文件，不改任何东西。',
    ].join('\n') + '\n')
    return 0
  }

  const skillText = readFileSync(join(ROOT, 'SKILL.md'), 'utf8')
  const version = skillVersion(skillText)
  const source = skillSource(skillText)

  // 用户包 = 产品层。自用层按结构规则排除，与 `.gitattributes` 同源。
  const all = walk(ROOT)
  const shipped = all
    .map((f) => relative(ROOT, f).split('\\').join('/'))
    .filter((rel) => !isRepoOnlyPath(rel))
    .sort()

  const out = {
    version,
    source,
    shippedCount: shipped.length,
    shipped,
    skillSha256: sha256(join(ROOT, 'SKILL.md')),
  }

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    return 0
  }

  process.stdout.write(`版本：${version ?? '（SKILL.md 里没有 metadata.version）'}\n`)
  process.stdout.write(`来源：${source ?? '（SKILL.md 里没有 metadata.source）'}\n`)
  process.stdout.write(`用户包：${shipped.length} 个文件\n`)
  process.stdout.write(`SKILL.md 哈希：${out.skillSha256}\n\n`)
  process.stdout.write('包内条目：\n')
  for (const rel of shipped) process.stdout.write(`  ${rel}\n`)
  return 0
}

process.exit(main(process.argv.slice(2)))
