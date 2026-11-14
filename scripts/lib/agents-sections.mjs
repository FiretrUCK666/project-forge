/**
 * agents-sections.mjs —— AGENTS.md 受管区间刷新、漂移比对、同义标题识别与覆盖检查。
 *
 * 仅依赖 node:* 内置模块与同层 lib/。供 scripts/compose-agents.mjs 调用并重导出。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { scanLines } from './markdown.mjs'
import { PF_MANIFEST_REL, markerRegions, parseMarkers } from './protocol.mjs'
import { readJsonSafe } from './text.mjs'

export function sha256Of(text) {
  return createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n'), 'utf8').digest('hex')
}

export function regionBodySha(lines) {
  return sha256Of(lines.join('\n'))
}

export function fillLinesOf(text) {
  return new Set(
    parseMarkers(text, 'AGENTS.md').filter((m) => m.kind === 'fill').map((m) => m.index),
  )
}

/** 过滤 `意图路由` 区间中被禁用或当前档位未装配的内置技能行。 */
export function filterIntentRouting(rendered, excludedSkills) {
  const excluded = excludedSkills instanceof Set ? excludedSkills : new Set(excludedSkills ?? [])
  if (excluded.size === 0) return rendered
  const lines = String(rendered ?? '').replace(/\r\n/g, '\n').split('\n')
  const { regions } = markerRegions(lines.join('\n'), 'AGENTS.md')
  const intentRegion = regions.find((r) => r.id === '意图路由')
  if (!intentRegion) return rendered

  const out = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (i > intentRegion.start && i < intentRegion.end && /^\s*\|/.test(line)) {
      const m = /\.agents\/skills\/([a-z0-9-]+)\//i.exec(line)
      if (m && excluded.has(m[1])) continue
    }
    out.push(line)
  }
  return out.join('\n')
}

function maskVolatile(text, values) {
  let out = text
  for (const value of values) {
    if (typeof value !== 'string' || value.length < 2) continue
    out = out.split(value).join('\u0000VOLATILE\u0000')
  }
  return out
}

function normalizeBody(bodyLines, volatile = []) {
  return maskVolatile(
    bodyLines
      .map((line) => line.replace(/\s+$/, ''))
      .filter((line) => line.trim() !== '')
      .join('\n'),
    volatile,
  )
}

const HEADING_PREFIX = /^#{2,3}\s+(?:\d+[.)、]\s*)?(?:[一二三四五六七八九十]+[、.)]\s*)?/

const SECTION_KEYWORDS = {
  意图路由: { words: ['意图路由', '路由', 'Intent Routing', 'Routing'] },
  行事总纲: { words: ['行事总纲', '决策准则', '总纲', 'Operating Principles', 'Core Principles'] },
  项目定位: { words: ['定位', '简介', '概述', '说明', 'Overview', 'Introduction', 'About'] },
  'Dev Profile': { words: ['Dev Profile', 'Profile'] },
  上下文阅读护栏: { words: ['上下文阅读护栏', '阅读护栏', 'Context Reading', 'Reading Guardrails'] },
  架构与关键不变量: { words: ['架构', '结构', '关键不变量', 'Architecture', 'Structure', 'Layout', 'Invariants'] },
  构建与验证: {
    words: ['构建', '验证', '环境', '安装', '开发', '测试', '命令', '运行',
      'Setup', 'Install', 'Build', 'Test', 'Verif', 'Commands', 'Development', 'Environment'],
    exclude: ['审查', '流程', '审核', '评审', 'review'],
  },
  修改守则: {
    words: ['修改守则', '硬性规范', '编码规范', '开发规范', '约定', '红线',
      'Rules', 'Guidelines', 'Conventions', 'Standards', 'Coding', 'Style'],
  },
  版本与发布: { words: ['版本', '发布', '发版', 'Version', 'Release', 'Publish'] },
  日常协作与风险分流: {
    words: ['协作', '改动怎么落地', '工作流', '分支', '提交',
      'Workflow', 'Collaboration', 'Contributing', 'Pull Request', 'Branch', 'Commit'],
  },
  高风险路径: { words: ['高风险', '风险', 'Risk', 'Sensitive'] },
  改哪看哪: { words: ['改哪看哪', '联动', 'Coupled'] },
  取舍: { words: ['取舍', '决定', '选型', 'Decisions', 'Trade-off', 'Tradeoff'] },
}

function renderedTitleOf(id, rendered) {
  const lines = String(rendered ?? '').replace(/\r\n/g, '\n').split('\n')
  const region = markerRegions(rendered, 'AGENTS.md').regions.find((r) => r.id === id)
  if (region === undefined) return undefined
  const heading = lines.slice(region.start + 1, region.end).find((line) => /^##\s+/.test(line))
  return heading === undefined ? undefined : heading.replace(/^##\s+/, '').trim()
}

export function headingLines(text) {
  return scanLines(String(text ?? '').replace(/\r\n/g, '\n'))
    .filter((info) => !info.inFence && /^#{2,3}\s+/.test(info.line))
    .map((info) => info.line)
    .join('\n')
}

export function sectionAlreadyPresent(id, headingsText, rendered) {
  const rule = SECTION_KEYWORDS[id]
  if (rule !== undefined) {
    const titles = headingsText.split('\n').map((line) => line.replace(HEADING_PREFIX, '').trim())
    return titles.some((title) => {
      const lower = title.toLowerCase()
      if ((rule.exclude ?? []).some((w) => lower.includes(w.toLowerCase()))) return false
      return rule.words.some((w) => lower.includes(w.toLowerCase()))
    })
  }
  const normal = renderedTitleOf(id, rendered)
  if (normal === undefined) return false
  return headingsText.split('\n')
    .some((line) => line.replace(HEADING_PREFIX, '').trim() === normal)
}

export function missingRegionsOf(presentIds, rendered, existingText, removedRegions = null) {
  const wanted = markerRegions(rendered, 'AGENTS.md').regions.map((r) => r.id)
  const headings = headingLines(existingText)
  const removedSet = removedRegions instanceof Set ? removedRegions : new Set(removedRegions ?? [])
  return wanted.filter((id) => !presentIds.has(id) && !removedSet.has(id) && !sectionAlreadyPresent(id, headings, rendered))
}

/**
 * 刷新受管区间：填空、跟随基线更新、插入新节（跳过用户主动删除的区间），
 * 并对缺少 `agentsRegions` 基线的既有非空区段默认采取 `protect` 策略。
 */
export function refreshRegions(existing, rendered, volatile = [], baselineRegions = null, removedRegions = null) {
  const current = markerRegions(existing, 'AGENTS.md')
  const fresh = markerRegions(rendered, 'AGENTS.md')
  if (current.broken.length > 0) {
    return {
      text: existing, changed: false, broken: current.broken,
      kept: [], inserted: [], filled: [], synced: [], protectedRegions: [],
    }
  }

  const lines = existing.split('\n')
  const renderedLines = rendered.split('\n')
  const freshById = new Map(fresh.regions.map((r) => [r.id, r]))
  const currentById = new Map(current.regions.map((r) => [r.id, r]))
  const renderedOrder = fresh.regions.map((r) => r.id)
  const fillLines = fillLinesOf(existing)
  const removedSet = removedRegions instanceof Set ? removedRegions : new Set(removedRegions ?? [])

  const ops = []
  const kept = []
  const filled = []
  const synced = []
  const protectedRegions = []

  for (const region of current.regions) {
    if (region.customized) { kept.push(region.id); continue }
    const source = freshById.get(region.id)
    if (!source) { kept.push(region.id); continue }
    const renderedBody = renderedLines.slice(source.start + 1, source.end)
    const bodyLines = lines.slice(region.start + 1, region.end)
    const baselineSha = baselineRegions?.[region.id]?.sha256
    const diskSha = baselineSha ? regionBodySha(bodyLines) : undefined
    const hasNonEmptyBody = bodyLines.some((l) => l.trim() !== '')

    const renderedHasFill = parseMarkers(renderedBody.join('\n'), 'AGENTS.md').some((m) => m.kind === 'fill')
    let bodyHasFill = false
    for (let i = region.start + 1; i < region.end; i += 1) {
      if (fillLines.has(i)) { bodyHasFill = true; break }
    }

    if (renderedHasFill) {
      if (!bodyHasFill) { kept.push(region.id); continue }
      if (baselineSha && diskSha !== baselineSha) {
        protectedRegions.push(region.id)
        kept.push(region.id)
        continue
      }
      if (bodyLines.join('\n') === renderedBody.join('\n')) { kept.push(region.id); continue }
      filled.push(region.id)
    } else {
      if (normalizeBody(bodyLines, volatile) === normalizeBody(renderedBody, volatile)) {
        kept.push(region.id)
        continue
      }
      if (!bodyHasFill) {
        if (!baselineSha) {
          if (hasNonEmptyBody) {
            protectedRegions.push(region.id)
            kept.push(region.id)
            continue
          }
        } else if (diskSha !== baselineSha) {
          protectedRegions.push(region.id)
          kept.push(region.id)
          continue
        }
      }
      synced.push(region.id)
    }

    ops.push({
      at: region.start + 1,
      remove: region.end - region.start - 1,
      insert: renderedBody,
      seq: -1,
    })
  }

  const inserted = []
  const existingHeadings = headingLines(existing)
  const takenSections = new Set(
    renderedOrder.filter((id) => currentById.has(id) || removedSet.has(id) || sectionAlreadyPresent(id, existingHeadings, rendered)),
  )
  for (let i = 0; i < renderedOrder.length; i += 1) {
    const id = renderedOrder[i]
    if (takenSections.has(id) || !freshById.has(id)) continue
    const source = freshById.get(id)
    const block = [
      renderedLines[source.start],
      ...renderedLines.slice(source.start + 1, source.end),
      renderedLines[source.end],
    ]

    let position
    for (let j = i + 1; j < renderedOrder.length; j += 1) {
      const anchor = currentById.get(renderedOrder[j])
      if (anchor) { position = anchor.start; break }
    }
    if (position === undefined) {
      for (let j = i - 1; j >= 0; j -= 1) {
        const anchor = currentById.get(renderedOrder[j])
        if (anchor) { position = anchor.end + 1; break }
      }
    }
    if (position === undefined) position = lines.length

    ops.push({ at: position, remove: 0, insert: ['', ...block], seq: i })
    inserted.push(id)
  }

  if (ops.length === 0) {
    return {
      text: existing, changed: false, broken: [], kept, inserted: [], filled, synced, protectedRegions,
    }
  }

  ops.sort((a, b) => (b.at - a.at) || (b.seq - a.seq))
  for (const op of ops) lines.splice(op.at, op.remove, ...op.insert)
  const nextText = lines.join('\n')
  return {
    text: nextText, changed: nextText !== existing, broken: [], kept, inserted, filled, synced, protectedRegions,
  }
}

export function driftRegions(existing, rendered, volatile = []) {
  const current = markerRegions(existing, 'AGENTS.md')
  const fresh = markerRegions(rendered, 'AGENTS.md')
  if (current.broken.length > 0) return []

  const lines = existing.split('\n')
  const renderedLines = rendered.split('\n')
  const freshById = new Map(fresh.regions.map((r) => [r.id, r]))
  const drifted = []

  for (const region of current.regions) {
    if (region.customized) continue
    const source = freshById.get(region.id)
    if (!source) continue
    const renderedBody = renderedLines.slice(source.start + 1, source.end)
    if (parseMarkers(renderedBody.join('\n'), 'AGENTS.md').some((m) => m.kind === 'fill')) continue

    const a = normalizeBody(lines.slice(region.start + 1, region.end), volatile)
    const b = normalizeBody(renderedBody, volatile)
    if (a !== b) drifted.push(region.id)
  }
  return drifted
}

export function collectMissingSections(rendered, existing) {
  const renderedLines = rendered.split('\n')
  const { regions } = markerRegions(rendered, 'AGENTS.md')
  const headings = headingLines(existing)
  const out = []
  for (const region of regions) {
    const block = [
      renderedLines[region.start],
      ...renderedLines.slice(region.start + 1, region.end),
      renderedLines[region.end],
    ]
    const heading = block.find((line) => /^##\s+/.test(line))
    if (!heading) continue
    if (sectionAlreadyPresent(region.id, headings, rendered)) continue
    out.push(block.join('\n'))
  }
  return out
}

export function handWrittenCoverage(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const contentLines = body.split('\n').filter((line) => line.trim() !== '' && !/^#/.test(line))
  const chars = contentLines.join('').replace(/\s/g, '').length
  const has = (words) => words.some((w) => body.includes(w))
  const missing = []
  if (!has(['定位', '简介', '概述', '做什么', 'Overview', 'About', 'Introduction'])) missing.push('项目定位')
  if (!has(['构建', '安装', '运行', '测试', '命令', 'Setup', 'Install', 'Build', 'Test', 'Commands'])) missing.push('构建与验证')
  if (!has(['守则', '规范', '约定', '红线', '高风险', 'Rules', 'Guidelines', 'Conventions', 'Standards'])) missing.push('修改边界')
  return { chars, missing, ok: chars >= 80 && missing.length === 0 }
}

function normalizedFileSha(filePath) {
  const buf = readFileSync(filePath)
  const isText = !buf.subarray(0, 8192).includes(0)
  const payload = isText ? Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8') : buf
  return createHash('sha256').update(payload).digest('hex')
}

/** 兼容 v1/v2 manifest 检查 `.agents/skills/` 状态，豁免墓碑与已登记定制文件。 */
export function inspectKitManifestForReview(root, kit) {
  if (!kit?.manifestExists) return { state: 'absent' }
  const rawManifest = readJsonSafe(join(root, PF_MANIFEST_REL))
  const v2Valid = Boolean(rawManifest && typeof rawManifest === 'object'
    && (rawManifest.schemaVersion === 1 || rawManifest.schemaVersion === 2)
    && rawManifest.files && typeof rawManifest.files === 'object' && !Array.isArray(rawManifest.files))
  if (kit.corrupted && !v2Valid) return { state: 'corrupted' }

  const disabledSet = new Set(Array.isArray(rawManifest?.disabledSkills) ? rawManifest.disabledSkills : (kit.disabledSkills ?? []))
  const removedSet = new Set(Object.keys(rawManifest?.removedFiles ?? kit.removedFiles ?? {}))
  const customMap = rawManifest?.customizedFiles ?? kit.customizedFiles ?? {}

  const filesCount = kit.corrupted && v2Valid ? Object.keys(rawManifest.files).length : kit.filesCount
  let missingFiles = (kit.missingFiles ?? []).filter((f) => !removedSet.has(f) && !disabledSet.has(f.split('/')[0]))
  let modifiedFiles = (kit.modifiedFiles ?? []).filter((f) => {
    const entry = customMap[f]
    if (!entry?.baseSha256) return true
    try { return normalizedFileSha(join(root, '.agents', 'skills', f)) !== entry.baseSha256 } catch { return true }
  })
  if (kit.corrupted && v2Valid) {
    missingFiles = []
    modifiedFiles = []
    for (const [rel, val] of Object.entries(rawManifest.files)) {
      if (removedSet.has(rel) || disabledSet.has(rel.split('/')[0])) continue
      const abs = join(root, '.agents', 'skills', rel)
      if (!existsSync(abs)) { missingFiles.push(rel); continue }
      const expected = typeof val === 'string' ? val : val?.sha256
      const diskSha = normalizedFileSha(abs)
      if (expected && diskSha !== expected && customMap[rel]?.baseSha256 !== diskSha) modifiedFiles.push(rel)
    }
  }
  return {
    state: 'ok',
    filesCount,
    missingFiles,
    modifiedFiles,
    versionMismatch: Boolean(kit.versionMismatch),
    tier: rawManifest?.tier ?? kit.tier,
    forgeVersion: rawManifest?.forgeVersion ?? kit.forgeVersion,
    customCount: Object.keys(customMap).length,
  }
}

