/**
 * compose-agents-helpers.mjs —— `compose-agents.mjs` 的目标路径解析（大小写与软链保真）、manifest 基线同步与报告辅助。
 *
 * 从 `scripts/compose-agents.mjs` 拆出以控制单文件体量 <= 800 且保持零第三方依赖。
 */

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { isInsideDir } from '../../kit/skills/lib/git-core.mjs'
import { writeAtomic } from './fs-atomic.mjs'
import * as protocol from './protocol.mjs'
import { isMacMetadataName, readTextSafe } from './text.mjs'
import {
  collectMissingSections,
  missingRegionsOf,
  regionBodySha,
} from './agents-sections.mjs'

const { AGENTS_MAX_BYTES, LIKELY_DEFAULT_BRANCHES, markerRegions, parseMarkers } = protocol
const PF_MANIFEST_REL = protocol.PF_MANIFEST_REL ?? '.agents/skills/.pf-manifest.json'
const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * 大小写不敏感查找目标目录既有的 `AGENTS.md` / `agents.md` 及符号链接状态。
 * - 若不存在，默认目标为 `AGENTS.md`；
 * - 若为合法仓内软链，解析 `realpathSync` 作为写回目标以保留软链与原文件名大小写；
 * - 若为悬空或指向仓外路径的软链，标记 `dangling` / `outsideRepo` 阻断写入。
 */
export function resolveAgentsFileTarget(root) {
  let entries = []
  try {
    entries = readdirSync(root).filter((n) => !isMacMetadataName(n))
  } catch { entries = [] }

  const exact = entries.find((n) => n === 'AGENTS.md')
  const matched = exact ?? entries.find((n) => n.toLowerCase() === 'agents.md')
  if (!matched) {
    const fallback = join(root, 'AGENTS.md')
    return {
      exists: false,
      fileName: 'AGENTS.md',
      entryPath: fallback,
      writePath: fallback,
      isSymlink: false,
      dangling: false,
      outsideRepo: false,
    }
  }

  const entryPath = join(root, matched)
  let lst
  try { lst = lstatSync(entryPath) } catch { lst = null }
  if (!lst || !lst.isSymbolicLink()) {
    return {
      exists: true,
      fileName: matched,
      entryPath,
      writePath: entryPath,
      isSymlink: false,
      dangling: false,
      outsideRepo: false,
    }
  }

  let realTarget
  try {
    realTarget = realpathSync(entryPath)
  } catch {
    return {
      exists: true,
      fileName: matched,
      entryPath,
      writePath: null,
      isSymlink: true,
      dangling: true,
      outsideRepo: false,
      error: `${matched} 是悬空符号链接（目标不存在），拒绝覆盖写入`,
    }
  }

  let targetIsFile = false
  try { targetIsFile = statSync(realTarget).isFile() } catch { targetIsFile = false }
  if (!targetIsFile) {
    return {
      exists: true,
      fileName: matched,
      entryPath,
      writePath: null,
      isSymlink: true,
      dangling: true,
      outsideRepo: false,
      error: `${matched} 符号链接目标不是普通文件，拒绝覆盖写入`,
    }
  }

  if (!isInsideDir(realTarget, root)) {
    return {
      exists: true,
      fileName: matched,
      entryPath,
      writePath: null,
      isSymlink: true,
      dangling: false,
      outsideRepo: true,
      realTarget,
      error: `${matched} 符号链接指向仓库外路径（${realTarget}），拒绝越界覆盖写入`,
    }
  }

  return {
    exists: true,
    fileName: matched,
    entryPath,
    writePath: realTarget,
    isSymlink: true,
    dangling: false,
    outsideRepo: false,
    realTarget,
  }
}

export async function maybePreWriteBackup(root, existingText, noBackup) {
  if (noBackup || !String(existingText ?? '').trim()) return null
  const backupScript = join(HERE, '..', 'backup.mjs')
  if (!existsSync(backupScript)) return null
  const mod = await import(pathToFileURL(backupScript).href)
  if (typeof mod?.ensurePreWriteBackup !== 'function') return null
  return await mod.ensurePreWriteBackup(root, { label: 'compose-agents' })
}

export function formatOversizeBreakdown(sizeInfo) {
  const canBypass = sizeInfo.managedBytes <= AGENTS_MAX_BYTES && sizeInfo.customBytes > 0
  const bypassHint = canBypass
    ? '；若需完整保留既有自定义长文，可加 `--allow-custom-oversize` 放行'
    : ''
  return `total=${sizeInfo.bytes}B（受管区 managed=${sizeInfo.managedBytes}B + 自定义/正文 custom=${sizeInfo.customBytes}B，上限 ${AGENTS_MAX_BYTES}B / 30KB）；建议将长篇子模块规范外置到 <subdir>/AGENTS.md 或 docs/TDD.md${bypassHint}`
}

export function readManifestSafe(root) {
  const manifestPath = join(root, PF_MANIFEST_REL)
  if (!existsSync(manifestPath)) return null
  const raw = readTextSafe(manifestPath)
  if (raw === undefined) return { path: manifestPath, raw: '', data: {}, invalid: true }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path: manifestPath, raw, data: {}, invalid: true }
    }
    return { path: manifestPath, raw, data: parsed, invalid: false }
  } catch {
    return { path: manifestPath, raw, data: {}, invalid: true }
  }
}

export function writeManifestRegions(root, agentsText, protectedIds = [], removedIds = []) {
  const manifest = readManifestSafe(root)
  if (!manifest || manifest.invalid) return false
  const prevRegions = manifest.data.agentsRegions && typeof manifest.data.agentsRegions === 'object'
    ? manifest.data.agentsRegions
    : {}
  const protectedSet = new Set(protectedIds)
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  const { regions, broken } = markerRegions(agentsText, 'AGENTS.md')
  if (broken.length > 0) return false

  const nextRegions = {}
  const presentIds = new Set()
  for (const region of regions) {
    presentIds.add(region.id)
    if (protectedSet.has(region.id) && prevRegions[region.id]?.sha256) {
      nextRegions[region.id] = prevRegions[region.id]
    } else {
      const bodyLines = lines.slice(region.start + 1, region.end)
      nextRegions[region.id] = { sha256: regionBodySha(bodyLines) }
    }
  }

  const prevRemoved = Array.isArray(manifest.data.removedAgentsRegions) ? manifest.data.removedAgentsRegions : []
  const nextRemoved = [...new Set([...prevRemoved, ...removedIds])]
    .filter((id) => typeof id === 'string' && id && !presentIds.has(id))
    .sort()

  const nextData = {
    ...manifest.data,
    agentsRegions: nextRegions,
    ...(manifest.data.schemaVersion >= 2 || nextRemoved.length > 0 || Array.isArray(manifest.data.removedAgentsRegions)
      ? { removedAgentsRegions: nextRemoved }
      : {}),
  }
  const nextRaw = `${JSON.stringify(nextData, null, 2)}\n`
  if (nextRaw === manifest.raw.replace(/\r\n/g, '\n')) return false
  writeAtomic(manifest.path, nextRaw)
  return true
}

export function volatileValues(facts) {
  const detected = facts.conventions?.defaultBranch
  const values = [...LIKELY_DEFAULT_BRANCHES]
  if (typeof detected === 'string' && detected.length >= 2 && !values.includes(detected)) {
    values.push(detected)
  }
  return values
}

export function inspectAgentsFile(agentsPath, rendered, removedRegions = null, fileName = 'AGENTS.md') {
  const text = readTextSafe(agentsPath)
  if (text === undefined) {
    return {
      state: 'unreadable', fills: [], regions: [], broken: [], missingRegions: [], customized: [],
    }
  }
  const markers = parseMarkers(text, fileName)
  const fills = markers.filter((m) => m.kind === 'fill')
  const regions = markerRegions(text, fileName)
  const present = new Set(regions.regions.map((r) => r.id))
  const customized = regions.regions.filter((r) => r.customized).map((r) => r.id)
  return {
    state: fills.length > 0 ? 'has-fills' : 'ok',
    fills,
    regions: regions.regions,
    broken: regions.broken,
    customized,
    missingRegions: missingRegionsOf(present, rendered, text, removedRegions),
    text,
  }
}

export function reportAgentsStatus(fileName, info, renderedCache, { verbose = false } = {}) {
  const name = fileName || 'AGENTS.md'
  if (info.state === 'unreadable') {
    process.stdout.write(`${name} 读不出来（不是 UTF-8 文本？）。这不是「没有」，是「有但读不懂」——先看清它是什么。\n`)
    return
  }
  if (info.broken && info.broken.length > 0) {
    process.stdout.write(`${name} 的标记没成对：${info.broken.join('、')}。半对标记意味着文件被手工改坏了，不动它，先看清缺的是哪个 end。\n`)
    return
  }
  if (info.regions.length === 0) {
    process.stdout.write(`${name} 里没有任何 <!-- project-forge: begin … --> 标记。\n`
      + '这通常意味着它**是手写的**。按规矩不动它——手写的契约可能比模板更贴合这个项目。\n')
    const additions = collectMissingSections(renderedCache, info.text ?? '')
    if (additions.length > 0) {
      process.stdout.write(`\n模板里的这几节它还没有：共 ${additions.length} 段\n`
        + '要补的话加 `--upgrade`：只**追加**缺的节，每节带自己的标记，已有的字一个不动。\n')
    }
    return
  }
  process.stdout.write(`${name}：${info.regions.length} 段受管内容（${info.regions.map((r) => r.id).join('、')}）\n`)
  if (info.customized && info.customized.length > 0) {
    process.stdout.write(`${info.customized.length} 段已由你接管、脚本不再改动：${info.customized.join('、')}`
      + '（标记里带 `customized`；想交回去就删掉那个词）\n')
  }
  if (info.missingRegions.length > 0) {
    process.stdout.write(`还有 ${info.missingRegions.length} 节该有却没有：${info.missingRegions.join('、')}\n`
      + '（模板里的条件现在为真，所以这一节该在。跑一次不带参数就会补上，已有内容不动。）\n')
  }
  if (info.fills.length > 0) {
    process.stdout.write(`还有 ${info.fills.length} 处要人填：\n`)
    for (const fill of info.fills) {
      process.stdout.write(`  - 第 ${fill.line} 行：${fill.what}\n`)
    }
    if (verbose) {
      process.stdout.write('\n填完之后把那一整行标记删掉——留着它，看起来就像「这里已经填过了」。\n')
    }
  } else {
    process.stdout.write('没有未填的占位。\n')
  }
}
