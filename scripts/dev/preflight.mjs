#!/usr/bin/env node
/**
 * preflight.mjs —— 这个 skill 自己的结构自检主入口（协调契约、套件卫生、端到端冒烟与 --package 校验）。
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isRepoOnlyPath, templateVarsOf } from '../lib/protocol.mjs'
import { isMainModule } from '../lib/text.mjs'
import {
  acceptanceIdMissing, completionRecordBeforeMerge, finishCommandsOf,
  finishRequiredMissing, finishSectionRange, finishSiteRolesMissing,
  finishStepBodies, finishStepsState, matchHeadings, reviewBlockMissing,
  runContractChecks, validateDocTocAnchors,
} from './preflight-contracts.mjs'
import { runSuiteChecks } from './preflight-suite.mjs'
import { runE2eChecks } from './preflight-e2e.mjs'

export {
  acceptanceIdMissing,
  completionRecordBeforeMerge,
  finishCommandsOf,
  finishRequiredMissing,
  finishSectionRange,
  finishSiteRolesMissing,
  finishStepBodies,
  finishStepsState,
  matchHeadings,
  reviewBlockMissing,
  validateDocTocAnchors,
}

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

if (isMainModule(import.meta.url, process.argv[1]) && !String(process.env.PF_BACKUP_DIR ?? '').trim()) {
  const testBackupRoot = mkdtempSync(join(tmpdir(), 'pf-test-bk-'))
  process.env.PF_BACKUP_DIR = testBackupRoot
  process.on('exit', () => {
    try {
      rmSync(testBackupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* 留给系统清理 */ }
  })
}

const failures = []
const notes = []
const fail = (msg) => failures.push(msg)
const note = (msg) => notes.push(msg)

function rel(p) {
  return relative(ROOT, p).split('\\').join('/')
}

function isWorktreeCheckout(dir) {
  try {
    return statSync(join(dir, '.git')).isFile()
  } catch {
    return false
  }
}

function readText(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
}

function countLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

function walk(dir, pred) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, pred))
    else if (entry.isFile() && (pred === undefined || pred(full))) out.push(full)
  }
  return out
}

/**
 * 这个相对路径是不是「产品层」——拿到包的人真正需要的那几处。
 */
export function isProductLayerPath(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/')
  if (p === 'SKILL.md' || p === 'README.md' || p === 'LICENSE') return true
  if (/^README\.[a-z0-9_-]+\.md$/i.test(p)) return true
  if (/^assets\/readme\/[a-z0-9_-]+\.svg$/i.test(p)) return true
  return /^(?:references|templates|scripts|kit)\//.test(p)
}

function checkPackage(listPath) {
  if (!existsSync(listPath)) {
    process.stderr.write(`找不到条目清单：${listPath}\n`)
    return 2
  }
  const all = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  if (all.length === 0) {
    process.stderr.write('条目清单是空的——`git archive` 那一步失败时，空清单会被读成「没漏」，那是假绿。\n')
    return 1
  }
  const entries = all.filter((e) => !e.endsWith('/'))
  const dirs = all.length - entries.length

  const leaked = entries.filter((e) => isRepoOnlyPath(e))
  if (leaked.length > 0) {
    for (const e of leaked) process.stderr.write(`FAIL  ${e} 属于「不进包」的结构规则，却出现在用户包里\n`)
    process.stderr.write(`\n用户包核对未通过：${leaked.length} 个条目不该在包里。\n`)
    return 1
  }

  const unclaimed = entries.filter((e) => !isProductLayerPath(e))
  if (unclaimed.length > 0) {
    for (const e of unclaimed) process.stderr.write(`FAIL  ${e} 不在产品层（SKILL.md / references/ / templates/ / scripts/ / kit/ / assets/readme/*.svg），也没被排除——它凭什么在用户包里？\n`)
    process.stderr.write(`\n用户包核对未通过：${unclaimed.length} 个条目没有归属。要发就归进产品层，不发就写进 .gitattributes 的 export-ignore。\n`)
    return 1
  }

  let missingRequired = 0
  for (const r of ['SKILL.md', 'LICENSE', 'README.md']) {
    if (entries.includes(r)) continue
    process.stderr.write(`FAIL  用户包里没有 ${r}\n`)
    missingRequired += 1
  }
  if (missingRequired > 0) {
    process.stderr.write(`\n用户包核对未通过：缺 ${missingRequired} 个必需项。\n`)
    return 1
  }
  process.stdout.write(`用户包：${entries.length} 个文件（另有 ${dirs} 个目录项），没有越界，没有无归属条目，必需项齐全。\n`)
  return 0
}

async function main() {
  const argv = process.argv.slice(2)
  const pkgIndex = argv.indexOf('--package')
  if (pkgIndex >= 0) {
    const listPath = argv[pkgIndex + 1]
    if (!listPath) {
      process.stderr.write('用法：node scripts/dev/preflight.mjs --package <条目清单文件>\n')
      return 2
    }
    return checkPackage(listPath)
  }

  const ctx = {
    ROOT,
    rel,
    readText,
    countLines,
    walk,
    isWorktreeCheckout,
    templateVarsOf,
    isRepoOnlyPath,
    isProductLayerPath,
    fail,
    note,
  }

  await runContractChecks(ctx)
  await runSuiteChecks(ctx)
  runE2eChecks(ctx)

  for (const n of notes) process.stdout.write(`  ${n}\n`)
  if (failures.length === 0) {
    process.stdout.write(`\n自检通过：0 项失败（${notes.length} 项读数）。\n`)
    return 0
  }
  process.stderr.write('\n')
  for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
  process.stderr.write(`\n自检未通过：${failures.length} 项失败。\n`)
  return 1
}

if (isMainModule(import.meta.url, process.argv[1])) {
  Promise.resolve(main()).then((code) => process.exit(code))
}
