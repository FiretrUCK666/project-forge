/**
 * skill-discovery.mjs —— 零第三方依赖的单源内置/自有技能扫描与 YAML metadata 解析器。
 *
 * 严格零外部依赖（仅 Node 18+ 内置模块与同层 git.mjs），供 kit/skills/lib/cli.mjs 与
 * scripts/lib/protocol.mjs 共同复用，严守 arch-rules 单向隔离边界。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { COMMON_SKIP_DIRS, isMacOsJunkPath, posixPath, readTextSafe } from './git.mjs'

export const DEFAULT_KIT_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_CONTAINERS = new Set([...COMMON_SKIP_DIRS, '.git', '.worktrees', '.github', '.agents'])
const KEY_VAL_RE = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/

function splitInlineArray(inner) {
  const items = []
  let cur = ''
  let quote = null
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < inner.length) {
        cur += ch + inner[i + 1]
        i += 1
        continue
      }
      if (ch === quote) {
        if (quote === '\'' && inner[i + 1] === '\'') {
          cur += '\'\''
          i += 1
          continue
        }
        quote = null
      }
      cur += ch
    } else if (ch === '"' || ch === '\'') {
      quote = ch
      cur += ch
    } else if (ch === ',') {
      if (cur.trim()) items.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) items.push(cur.trim())
  return items
}

function parseYamlScalar(raw) {
  const s = String(raw ?? '').trim()
  if (!s || s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    return s.slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (s.startsWith('\'') && s.endsWith('\'') && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, '\'')
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim()
    if (!inner) return []
    return splitInlineArray(inner).map((item) => parseYamlScalar(item))
  }
  return s
}

function indentOf(line) {
  let n = 0
  while (n < line.length && line[n] === ' ') n += 1
  return n
}

function nextMeaningfulIndex(lines, startIdx) {
  let i = startIdx
  while (i < lines.length) {
    const t = lines[i].trim()
    if (t && !t.startsWith('#')) return i
    i += 1
  }
  return lines.length
}

function readBlockScalar(lines, startIdx, parentIndent, indicator) {
  const folded = indicator.startsWith('>')
  const collected = []
  let minIndent = Infinity
  let i = startIdx
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) {
      collected.push('')
      i += 1
      continue
    }
    const ind = indentOf(line)
    if (ind <= parentIndent) break
    if (ind < minIndent) minIndent = ind
    collected.push(line)
    i += 1
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  const base = Number.isFinite(minIndent) ? minIndent : parentIndent + 2
  const stripped = collected.map((l) => (l === '' ? '' : l.slice(base)))
  if (!folded) return { value: stripped.join('\n').trim(), nextIdx: i }
  const out = []
  for (const l of stripped) {
    if (!l) {
      if (out.length > 0 && out[out.length - 1] !== '\n') out.push('\n')
    } else {
      out.push(l)
    }
  }
  return { value: out.join(' ').replace(/\s*\n\s*/g, '\n').trim(), nextIdx: i }
}

function parseYamlSequence(lines, startIdx, seqIndent, syntaxErrors) {
  const items = []
  let i = startIdx
  while (i < lines.length) {
    i = nextMeaningfulIndex(lines, i)
    if (i >= lines.length) break
    const line = lines[i]
    const ind = indentOf(line)
    if (ind < seqIndent) break
    if (ind > seqIndent) {
      syntaxErrors.push(`YAML 序列缩进异常（第 ${i + 2} 行）：${line}`)
      i += 1
      continue
    }
    const trimmed = line.slice(seqIndent)
    if (!trimmed.startsWith('- ') && trimmed !== '-') break
    const afterDash = trimmed === '-' ? '' : trimmed.slice(2).trim()
    if (!afterDash) {
      const nextIdx = nextMeaningfulIndex(lines, i + 1)
      if (nextIdx < lines.length && indentOf(lines[nextIdx]) > seqIndent) {
        const sub = parseYamlMapping(lines, nextIdx, seqIndent + 1, syntaxErrors)
        items.push(sub.value)
        i = sub.nextIdx
      } else {
        items.push(null)
        i += 1
      }
      continue
    }
    const inlineKv = KEY_VAL_RE.exec(afterDash)
    if (inlineKv) {
      const entry = {}
      const key = inlineKv[1]
      const tail = inlineKv[2].trim()
      if (/^[|>][+-]?$/.test(tail)) {
        const blk = readBlockScalar(lines, i + 1, seqIndent, tail)
        entry[key] = blk.value
        i = blk.nextIdx
      } else if (!tail) {
        const nextIdx = nextMeaningfulIndex(lines, i + 1)
        if (nextIdx < lines.length && indentOf(lines[nextIdx]) > seqIndent + 2) {
          const sub = parseYamlMapping(lines, nextIdx, seqIndent + 3, syntaxErrors)
          entry[key] = sub.value
          i = sub.nextIdx
        } else {
          entry[key] = null
          i += 1
        }
      } else {
        entry[key] = parseYamlScalar(tail)
        i += 1
      }
      const contIdx = nextMeaningfulIndex(lines, i)
      if (contIdx < lines.length && indentOf(lines[contIdx]) > seqIndent) {
        const rest = parseYamlMapping(lines, contIdx, seqIndent + 1, syntaxErrors)
        Object.assign(entry, rest.value)
        i = rest.nextIdx
      }
      items.push(entry)
      continue
    }
    items.push(parseYamlScalar(afterDash))
    i += 1
  }
  return { value: items, nextIdx: i }
}

function parseYamlMapping(lines, startIdx, minIndent, syntaxErrors) {
  const firstIdx = nextMeaningfulIndex(lines, startIdx)
  if (firstIdx >= lines.length) return { value: {}, nextIdx: firstIdx }
  const mapIndent = indentOf(lines[firstIdx])
  if (mapIndent < minIndent) return { value: {}, nextIdx: firstIdx }

  const obj = {}
  let i = firstIdx
  while (i < lines.length) {
    i = nextMeaningfulIndex(lines, i)
    if (i >= lines.length) break
    const line = lines[i]
    const ind = indentOf(line)
    if (ind < mapIndent) break
    if (ind > mapIndent) {
      syntaxErrors.push(`YAML 映射缩进异常（第 ${i + 2} 行）：${line}`)
      i += 1
      continue
    }
    if (/^\s*-\s+/.test(line)) break
    const kv = KEY_VAL_RE.exec(line.slice(mapIndent))
    if (!kv) {
      syntaxErrors.push(`Frontmatter 第 ${i + 2} 行格式无效：${line}`)
      i += 1
      continue
    }
    const key = kv[1]
    const tail = kv[2].trim()
    if (/^[|>][+-]?$/.test(tail)) {
      const blk = readBlockScalar(lines, i + 1, mapIndent, tail)
      obj[key] = blk.value
      i = blk.nextIdx
      continue
    }
    if (!tail) {
      const nextIdx = nextMeaningfulIndex(lines, i + 1)
      if (nextIdx < lines.length && indentOf(lines[nextIdx]) > mapIndent) {
        const nextLine = lines[nextIdx].trimStart()
        if (nextLine.startsWith('- ') || nextLine === '-') {
          const seq = parseYamlSequence(lines, nextIdx, indentOf(lines[nextIdx]), syntaxErrors)
          obj[key] = seq.value
          i = seq.nextIdx
        } else if (KEY_VAL_RE.test(nextLine)) {
          const sub = parseYamlMapping(lines, nextIdx, mapIndent + 1, syntaxErrors)
          obj[key] = sub.value
          i = sub.nextIdx
        } else {
          const blk = readBlockScalar(lines, i + 1, mapIndent, '>')
          obj[key] = blk.value
          i = blk.nextIdx
        }
      } else {
        obj[key] = null
        i += 1
      }
      continue
    }
    obj[key] = parseYamlScalar(tail)
    i += 1
  }
  return { value: obj, nextIdx: i }
}

/** 零依赖解析 SKILL.md YAML Frontmatter（含多行 description 与嵌套 metadata）。 */
export function parseSkillFrontmatter(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  if (!norm.startsWith('---\n') && norm !== '---') {
    return {
      hasFrontmatter: false, malformed: false, valid: false,
      syntaxErrors: ['缺少 YAML Frontmatter（首行 ---）'], data: {}, body: norm,
    }
  }
  const fmMatch = /^---\n([\s\S]*?)\n---(?:\n([\s\S]*))?$/.exec(norm)
    ?? /^---\n---(?:\n([\s\S]*))?$/.exec(norm)
  if (!fmMatch) {
    return {
      hasFrontmatter: false, malformed: true, valid: false,
      syntaxErrors: ['Frontmatter 缺少闭合 --- 分隔行'], data: {}, body: norm,
    }
  }
  const fmRaw = fmMatch.length === 3 ? fmMatch[1] : ''
  const body = fmMatch.length === 3 ? (fmMatch[2] ?? '') : (fmMatch[1] ?? '')
  const lines = fmRaw ? fmRaw.split('\n') : []
  const syntaxErrors = []
  if (lines.some((l) => /^\t+/.test(l))) syntaxErrors.push('YAML Frontmatter 不支持 Tab 缩进')
  const { value: data } = parseYamlMapping(lines, 0, 0, syntaxErrors)
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const description = typeof data.description === 'string' ? data.description.replace(/\s+/g, ' ').trim() : ''
  const malformed = syntaxErrors.length > 0
  return {
    hasFrontmatter: true,
    malformed,
    valid: !malformed && Boolean(name && description),
    syntaxErrors,
    data,
    name,
    description,
    body,
  }
}

export function summarizeSkillDescription(desc) {
  if (!desc) return undefined
  const collapsed = String(desc).replace(/\s+/g, ' ').trim()
  if (!collapsed) return undefined
  const sentence = collapsed.split(/[。！？!?]|(?<=\.)\s+/)[0].trim() || collapsed
  if (sentence.length <= 80) return sentence
  return `${sentence.slice(0, 77).trimEnd()}...`
}

function normalizeExtraRoutes(rawRoutes) {
  if (!Array.isArray(rawRoutes)) return []
  return rawRoutes
    .filter((r) => r && typeof r === 'object')
    .map((r) => ({
      order: Number.isFinite(Number(r.order)) ? Number(r.order) : 100,
      tier: r.tier === 'both' || r.tier === 'lightweight' || r.tier === 'full' ? r.tier : 'both',
      intent: String(r.intent ?? r.intent_remote ?? '').trim(),
      ...(r.intent_local || r.intentLocal ? { intentLocal: String(r.intent_local ?? r.intentLocal).trim() } : {}),
      script: String(r.script ?? '').trim(),
    }))
    .filter((r) => r.intent && r.script)
}

/** 扫描 `kit/skills/` 并解析内置技能元数据，返回按 `order` 升序排列的列表与诊断信息。 */
export function discoverKitSkillsDetailed(kitSkillsRoot = DEFAULT_KIT_SKILLS_DIR) {
  const root = resolve(kitSkillsRoot)
  const skills = []
  const diagnostics = []
  if (!existsSync(root)) return { skills, diagnostics }

  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'lib' && e.name !== 'templates' && !isMacOsJunkPath(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch (err) {
    diagnostics.push({ dir: root, message: `无法读取技能目录：${err instanceof Error ? err.message : String(err)}` })
    return { skills, diagnostics }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillDir = join(root, entry.name)
    const entryName = existsSync(join(skillDir, 'SKILL.md'))
      ? 'SKILL.md'
      : (existsSync(join(skillDir, 'skill.md')) ? 'skill.md' : null)
    if (!entryName) continue

    const relSkill = `${entry.name}/${entryName}`
    const raw = readTextSafe(join(skillDir, entryName))
    if (raw === undefined) {
      diagnostics.push({ dir: entry.name, dirName: entry.name, file: relSkill, message: `无法读取 ${relSkill}` })
      continue
    }
    const fm = parseSkillFrontmatter(raw)
    if (!fm.valid) {
      const reason = fm.syntaxErrors.length > 0
        ? fm.syntaxErrors.join('；')
        : '缺少必填 YAML frontmatter 字段 name 或 description'
      diagnostics.push({ dir: entry.name, dirName: entry.name, file: relSkill, message: `${relSkill} 格式无效：${reason}` })
      continue
    }

    const meta = fm.data.metadata && typeof fm.data.metadata === 'object' && !Array.isArray(fm.data.metadata)
      ? fm.data.metadata
      : {}
    const rawTier = meta.tier
    const tierStr = rawTier === undefined || rawTier === null ? '' : String(rawTier).trim()
    if (tierStr && tierStr !== 'both' && tierStr !== 'lightweight' && tierStr !== 'full') {
      diagnostics.push({
        dir: entry.name, dirName: entry.name, file: relSkill,
        message: `${relSkill} metadata.tier 无效「${tierStr}」（仅允许 both / lightweight / full）`,
      })
      continue
    }
    const tier = tierStr || 'both'

    const hasOrder = meta.order !== undefined && meta.order !== null && String(meta.order).trim() !== ''
    const orderNum = hasOrder ? Number(meta.order) : 500
    if (!Number.isFinite(orderNum)) {
      diagnostics.push({
        dir: entry.name, dirName: entry.name, file: relSkill,
        message: `${relSkill} metadata.order 必须为有限数字：${meta.order}`,
      })
      continue
    }
    const order = orderNum
    const summary = summarizeSkillDescription(fm.description) ?? ''
    const intent = String(meta.intent ?? (summary || fm.description || fm.name)).trim()
    const intentLocal = meta.intent_local ? String(meta.intent_local).trim() : undefined
    const script = String(meta.script ?? '').trim()
    const fallback = String(meta.fallback ?? `按原生 git 与项目流程手动执行（未装配 ${fm.name} 技能）`).trim()

    skills.push({
      dirName: entry.name,
      name: fm.name,
      description: fm.description,
      summary,
      tier,
      intent,
      ...(intentLocal ? { intentLocal } : {}),
      script,
      order,
      fallback,
      extraRoutes: normalizeExtraRoutes(meta.extra_routes),
      path: `.agents/skills/${entry.name}/SKILL.md`,
    })
  }

  skills.sort((a, b) => (a.order - b.order) || a.dirName.localeCompare(b.dirName))
  return { skills, diagnostics }
}

/** 扫描 `kit/skills/` 并按 `order` 升序返回标准化内置技能描述符列表。 */
export function discoverKitSkills(kitSkillsRoot = DEFAULT_KIT_SKILLS_DIR) {
  return discoverKitSkillsDetailed(kitSkillsRoot).skills
}

function collectManifestManagedDirs(manifest) {
  const managed = new Set()
  if (!manifest || typeof manifest !== 'object' || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files)) {
    return { hasValidFiles: false, managed }
  }
  for (const key of Object.keys(manifest.files)) {
    const clean = posixPath(key).replace(/^\.agents\/skills\//, '').replace(/^\/+/, '')
    const top = clean.split('/')[0]
    if (top && top !== 'lib') managed.add(top)
  }
  return { hasValidFiles: true, managed }
}

function listCustomContainers(repoRoot) {
  const containers = []
  const agentsSkills = join(repoRoot, '.agents', 'skills')
  if (existsSync(agentsSkills)) {
    try {
      if (statSync(agentsSkills).isDirectory()) containers.push('.agents/skills')
    } catch { /* ignore */ }
  }

  let topEntries = []
  try {
    topEntries = readdirSync(repoRoot, { withFileTypes: true })
      .filter((e) => !isMacOsJunkPath(e.name))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return containers
  }

  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    if (!entry.name.startsWith('.') || SKIP_CONTAINERS.has(entry.name)) continue
    const sub = join(repoRoot, entry.name, 'skills')
    if (existsSync(sub)) {
      try {
        if (statSync(sub).isDirectory()) containers.push(`${entry.name}/skills`)
      } catch { /* ignore */ }
    }
  }

  const plainSkills = join(repoRoot, 'skills')
  if (existsSync(plainSkills)) {
    try {
      if (statSync(plainSkills).isDirectory()) containers.push('skills')
    } catch { /* ignore */ }
  }
  return [...new Set(containers)]
}

/**
 * 只读扫描 `.agents/skills/*`、点前缀隐藏容器（`.* /skills/*`）与非隐藏 `skills/*` 下的项目自有技能。
 * 跳过 `.agents/skills/` 内由 `managedSet` / `manifest` 托管的内置技能，绝不向任何隐藏目录执行写入。
 */
export function discoverCustomSkills(repoRoot, managedSet = new Set(), manifest = null) {
  const root = resolve(repoRoot)
  if (!existsSync(root)) return []

  const managed = managedSet instanceof Set ? managedSet : new Set(managedSet ?? [])
  const { hasValidFiles, managed: manifestManaged } = collectManifestManagedDirs(manifest)
  const containers = listCustomContainers(root)
  const found = []

  for (const container of containers) {
    const absContainer = join(root, container)
    let entries = []
    try {
      entries = readdirSync(absContainer, { withFileTypes: true })
        .filter((e) => !isMacOsJunkPath(e.name) && !e.name.startsWith('.'))
        .sort((a, b) => a.name.localeCompare(b.name))
    } catch { continue }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (container === '.agents/skills' && entry.name === 'lib') continue
      if (container === '.agents/skills') {
        const isManaged = hasValidFiles ? manifestManaged.has(entry.name) : managed.has(entry.name)
        if (isManaged) continue
      }

      const skillDir = join(absContainer, entry.name)
      const entryName = existsSync(join(skillDir, 'SKILL.md'))
        ? 'SKILL.md'
        : (existsSync(join(skillDir, 'skill.md')) ? 'skill.md' : null)
      if (!entryName) continue

      const raw = readTextSafe(join(skillDir, entryName))
      if (raw === undefined) continue
      const fm = parseSkillFrontmatter(raw)
      if (!fm.valid) continue

      const summary = summarizeSkillDescription(fm.description)
      found.push({
        name: fm.name,
        description: fm.description,
        ...(summary ? { summary } : {}),
        path: `${container}/${entry.name}`,
        container,
        dirName: entry.name,
        valid: true,
      })
    }
  }

  return found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}
