/**
 * profile.mjs —— 唯一权威的 AGENTS.md Dev Profile 解析器、取舍读取与动态多生态包清单发现。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），替代全套件多份重复解析器。
 * 严格保留显式填写的 `none` 禁用态，绝不回退猜测命令或默认高风险路径覆盖用户声明。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { isMacOsJunkPath, posixPath, readTextSafe } from './git.mjs'
import {
  discoverWorkspacePackages,
  parseYamlWorkspaceGlobs,
  sniffLayeredCommands,
} from './profile-sniffer.mjs'

export { discoverWorkspacePackages, parseYamlWorkspaceGlobs, sniffLayeredCommands }

export const DEV_PROFILE_KEYS = Object.freeze([
  'quick-test',
  'full-test',
  'smoke-verify',
  'merge-gate',
  'arch-rules',
  'high-risk',
  'do-not-edit',
])

const EXPLICIT_NONE_RE = /^(?:none|\(none\)|null|n\/a|无|\(无\)|暂无|-)$/i

function stripWrapQuotes(val) {
  const s = String(val ?? '').trim()
  if ((s.startsWith('`') && s.endsWith('`'))
    || (s.startsWith('"') && s.endsWith('"'))
    || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim()
  }
  return s
}

function stripInlineYamlComment(val) {
  const s = String(val ?? '')
  let quote = ''
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue }
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === '\'' || ch === '`') {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      return s.slice(0, i).trim()
    }
  }
  return s.trim()
}

function isAnglePlaceholder(val) {
  const s = stripWrapQuotes(val)
  return !s || /^<[^>\n]+>$/.test(s) || /^<!--/.test(s)
}

function isExplicitNoneValue(val) {
  const s = stripWrapQuotes(val)
  return EXPLICIT_NONE_RE.test(s)
}

function isPlaceholderVal(val) {
  return isAnglePlaceholder(val) || isExplicitNoneValue(val)
}

function parseListValue(raw) {
  const s = String(raw ?? '').trim()
  if (!s || /^\[?\s*\]?$/.test(s)) return []
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  return inner.split(/[,，]/)
    .map((x) => stripWrapQuotes(x))
    .filter((x) => x && !isPlaceholderVal(x))
}

function parseArchRuleItem(rawRule) {
  if (rawRule && typeof rawRule === 'object') {
    const rawFrom = rawRule.fromGlob ?? rawRule.from
    const rawTo = rawRule.toGlob ?? rawRule.to
    if (!rawFrom || !rawTo) return null
    const from = stripWrapQuotes(rawFrom)
    const to = stripWrapQuotes(rawTo)
    if (isPlaceholderVal(from) || isPlaceholderVal(to)) return null
    return { from, to, fromGlob: from, toGlob: to, raw: `${from} -> ${to}` }
  }
  const s = stripWrapQuotes(String(rawRule ?? ''))
  if (!s || isPlaceholderVal(s)) return null
  const m = /^(.+?)\s*(?:->|→)\s*(.+)$/.exec(s)
  if (!m) return null
  const from = stripWrapQuotes(m[1])
  const to = stripWrapQuotes(m[2])
  if (isPlaceholderVal(from) || isPlaceholderVal(to)) return null
  return { from, to, fromGlob: from, toGlob: to, raw: `${from} -> ${to}` }
}

/** 从 AGENTS.md 的「## 取舍」节读出已表态键值映射，返回 `Map<id, value>`。 */
export function readDecisionMap(agentsText) {
  const map = new Map()
  if (typeof agentsText !== 'string') return map
  const lines = agentsText.replace(/\r\n/g, '\n').split('\n')
  let inSection = false
  for (const line of lines) {
    if (/^##\s+取舍(?:\s|$|[（(:：])/.test(line.trim())) { inSection = true; continue }
    if (inSection && /^#{1,2}\s+/.test(line)) break
    if (!inSection) continue
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('<!--') || trimmed.startsWith('>') || trimmed.startsWith('```')) continue
    const m = /^\s*(?:[-*]\s*)?`?([a-z][a-z0-9._-]*)`?\s*[:：]\s*(.*)$/.exec(line)
    if (m) map.set(m[1], m[2].trim())
  }
  return map
}

/** 仅从 `AGENTS.md`「## 取舍」或「## Dev Profile」区间判断是否显式声明 `merge-authority: human`。 */
export function hasHumanMergeAuthority(agentsText) {
  if (typeof agentsText !== 'string' || !agentsText) return false
  const decVal = readDecisionMap(agentsText).get('merge-authority')
  if (decVal && /^`?human`?(?:\s|$|[，。；,;（(])/i.test(decVal.trim())) return true
  const scoped = extractDevProfileLines(agentsText).join('\n')
  return /^\s*(?:[-*]\s*)?`?merge-authority`?\s*[:：]\s*`?human`?\b/im.test(scoped)
}

/** 从 AGENTS.md 的「## 取舍」节读出已表态的决定，返回 `Set<id>`。 */
export function readDecisions(agentsText) {
  return new Set(readDecisionMap(agentsText).keys())
}

function hasDecisionKey(decisions, agentsText, key) {
  if (decisions instanceof Set) return decisions.has(key)
  if (decisions instanceof Map) return decisions.has(key)
  if (Array.isArray(decisions)) return decisions.includes(key)
  if (typeof decisions === 'string') return readDecisions(decisions).has(key)
  if (agentsText) return readDecisions(agentsText).has(key)
  return false
}

function resolveDecisionValue(decisions, agentsText, key) {
  if (decisions instanceof Map) return decisions.get(key) ?? null
  if (typeof decisions === 'string') return readDecisionMap(decisions).get(key) ?? null
  if (agentsText) return readDecisionMap(agentsText).get(key) ?? null
  return null
}

/**
 * 按项目实际优先识别权威架构文档路径：
 *   1. `AGENTS.md`「## 取舍」显式声明的 `tdd-authority`（且文件真实存在）；
 *   2. 声明 `no-tdd` 时返回 `null`（合法豁免）；
 *   3. 依次检查 `docs/TDD.md`、`*-TDD.md`、`ARCHITECTURE.md`、`docs/architecture.md`、
 *      `docs/design/README.md` 等既有架构文档。
 */
export function resolveAuthoritativeTddPath(repoRoot, decisions = null) {
  const agentsText = (decisions instanceof Map || typeof decisions === 'string')
    ? (typeof decisions === 'string' ? decisions : null)
    : readTextSafe(join(repoRoot, 'AGENTS.md'))

  if (hasDecisionKey(decisions, agentsText, 'tdd-authority')) {
    const rawVal = resolveDecisionValue(decisions, agentsText ?? readTextSafe(join(repoRoot, 'AGENTS.md')), 'tdd-authority')
    if (typeof rawVal === 'string' && rawVal.trim()) {
      const m = /`([^`\n]+\.mdx?)`/i.exec(rawVal)
        ?? /(?:^|\s)([A-Za-z0-9_./-]+\.mdx?)(?=\s|$|[，。；,;])/i.exec(rawVal)
      if (m) {
        const rel = posixPath(m[1].trim()).replace(/^\.\//, '')
        if (rel && !rel.includes('..') && existsSync(join(repoRoot, rel))) return rel
      }
    }
  }

  if (hasDecisionKey(decisions, agentsText, 'no-tdd')) return null

  const fixedCandidates = [
    'docs/TDD.md',
    'docs/tdd.md',
    'TDD.md',
    'tdd.md',
  ]
  for (const rel of fixedCandidates) {
    if (existsSync(join(repoRoot, rel))) return rel
  }

  for (const dirRel of ['', 'docs']) {
    const absDir = dirRel ? join(repoRoot, dirRel) : repoRoot
    if (!existsSync(absDir)) continue
    let names = []
    try { names = readdirSync(absDir).filter((n) => !isMacOsJunkPath(n)).sort() } catch { continue }
    for (const name of names) {
      if (/(?:-|_)tdd\.md$/i.test(name)) {
        return dirRel ? `${dirRel}/${name}` : name
      }
    }
  }

  const archCandidates = [
    'ARCHITECTURE.md',
    'architecture.md',
    'docs/ARCHITECTURE.md',
    'docs/architecture.md',
    'DESIGN.md',
    'design.md',
    'docs/DESIGN.md',
    'docs/design.md',
    'docs/architecture/README.md',
    'docs/design/README.md',
  ]
  for (const rel of archCandidates) {
    if (existsSync(join(repoRoot, rel))) return rel
  }

  for (const subRel of ['docs/architecture', 'docs/design']) {
    const subAbs = join(repoRoot, subRel)
    if (!existsSync(subAbs)) continue
    try {
      const md = readdirSync(subAbs, { withFileTypes: true })
        .filter((e) => e.isFile() && !isMacOsJunkPath(e.name) && /\.(?:md|mdx)$/i.test(e.name))
        .map((e) => e.name)
        .sort()
      if (md.length > 0) return `${subRel}/${md[0]}`
    } catch { /* ignore */ }
  }

  return null
}

function extractDevProfileLines(agentsText) {
  const norm = String(agentsText ?? '').replace(/\r\n/g, '\n')
  const beginMarker = /<!--\s*project-forge:\s*begin\s+Dev Profile\s*-->/.exec(norm)
  const endMarker = beginMarker
    ? /<!--\s*project-forge:\s*end\s+Dev Profile\s*-->/.exec(norm.slice(beginMarker.index + beginMarker[0].length))
    : null
  if (beginMarker && endMarker) {
    const slice = norm.slice(beginMarker.index + beginMarker[0].length, beginMarker.index + beginMarker[0].length + endMarker.index)
    return slice.split('\n')
  }

  const lines = norm.split('\n')
  const secIdx = lines.findIndex((l) => /^##\s+Dev Profile\b/i.test(l.trim()))
  if (secIdx >= 0) {
    const out = []
    for (let i = secIdx + 1; i < lines.length; i += 1) {
      if (/^##\s+/.test(lines[i].trim())) break
      out.push(lines[i])
    }
    return out
  }

  // 无显式 `## Dev Profile` 标题时（如精简测试夹具），优先仅提取 yaml 代码块，否则提取非围栏行
  const yamlBlocks = [...norm.matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi)]
  if (yamlBlocks.length > 0) {
    return yamlBlocks.flatMap((m) => m[1].split('\n'))
  }

  const fallbackLines = []
  let inFence = false
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence) fallbackLines.push(line)
  }
  return fallbackLines
}

/** 查询某 Dev Profile 键是否被用户显式设为 `none`。 */
export function isProfileExplicitNone(profile, key) {
  if (!profile?.explicitNone) return false
  if (profile.explicitNone instanceof Set) return profile.explicitNone.has(key)
  if (Array.isArray(profile.explicitNone)) return profile.explicitNone.includes(key)
  return false
}

/** 从全仓库清单三层嗅探测试与门禁命令，作为 Dev Profile 缺失时的安全兜底。 */
export function detectEcosystemCommands(repoRoot) {
  return sniffLayeredCommands(repoRoot)
}

/**
 * 唯一权威 AGENTS.md Dev Profile 解析器：
 *   - 限定解析 `## Dev Profile` 区间（无标题时回退 yaml 围栏）；
 *   - 支持单行/多行 YAML 列表、`[a, b]`、`## 高风险路径` 表格与 `## 取舍`；
 *   - 严格将显式 `none` 记入 `explicitNone` 集合，绝不回退覆盖。
 */
export function parseAgentsProfile(repoRoot) {
  const agentsPath = join(repoRoot, 'AGENTS.md')
  const text = readTextSafe(agentsPath)
  const explicitNone = new Set()
  const profile = {
    hasAgents: text !== undefined,
    quickTest: undefined,
    fullTest: undefined,
    smokeVerify: undefined,
    mergeGate: undefined,
    archRules: [],
    highRisk: [],
    doNotEdit: [],
    mergeAuthority: 'reviewer',
    explicitNone,
    decisions: new Set(),
  }

  if (text !== undefined) {
    profile.decisions = readDecisions(text)
    const scopedLines = extractDevProfileLines(text)
    let activeListKey = null

    for (let i = 0; i < scopedLines.length; i += 1) {
      const line = scopedLines[i]
      const trimmed = line.trim()
      if (/^(?:```|~~~)/.test(trimmed)) {
        activeListKey = null
        continue
      }

      if (activeListKey) {
        if (/^[-*]\s+/.test(trimmed) && /^\s+[-*]/.test(line)) {
          const item = stripWrapQuotes(stripInlineYamlComment(trimmed.replace(/^[-*]\s+/, '')))
          if (isExplicitNoneValue(item)) {
            explicitNone.add(activeListKey === 'highRisk' ? 'high-risk' : activeListKey === 'doNotEdit' ? 'do-not-edit' : 'arch-rules')
          } else if (item && !isAnglePlaceholder(item)) {
            if (activeListKey === 'archRules') {
              const parsed = parseArchRuleItem(item)
              if (parsed) profile.archRules.push(parsed)
            } else {
              profile[activeListKey].push(item)
            }
          }
          continue
        }
        if (trimmed !== '' && !trimmed.startsWith('#')) {
          activeListKey = null
        } else {
          continue
        }
      }

      const kv = /^(?:[-*]\s+)?`?(quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit)`?\s*:\s*(.*)$/i.exec(trimmed)
      if (!kv) continue
      const key = kv[1].toLowerCase()
      const rawVal = stripInlineYamlComment(kv[2])

      if (key === 'quick-test' || key === 'full-test' || key === 'smoke-verify' || key === 'merge-gate') {
        const cleaned = stripWrapQuotes(rawVal)
        if (isExplicitNoneValue(cleaned)) {
          explicitNone.add(key)
          if (key === 'quick-test') profile.quickTest = undefined
          else if (key === 'full-test') profile.fullTest = undefined
          else if (key === 'smoke-verify') profile.smokeVerify = undefined
          else profile.mergeGate = undefined
        } else if (!isAnglePlaceholder(cleaned)) {
          if (key === 'quick-test') profile.quickTest = cleaned
          else if (key === 'full-test') profile.fullTest = cleaned
          else if (key === 'smoke-verify') profile.smokeVerify = cleaned
          else profile.mergeGate = cleaned
        }
        continue
      }

      const targetProp = key === 'high-risk' ? 'highRisk' : key === 'do-not-edit' ? 'doNotEdit' : 'archRules'
      if (rawVal === '') {
        activeListKey = targetProp
      } else if (isExplicitNoneValue(rawVal)) {
        explicitNone.add(key)
      } else if (targetProp === 'archRules') {
        for (const item of parseListValue(rawVal)) {
          const parsed = parseArchRuleItem(item)
          if (parsed) profile.archRules.push(parsed)
        }
      } else {
        for (const item of parseListValue(rawVal)) {
          profile[targetProp].push(item)
        }
      }
    }

    if (profile.highRisk.length === 0 && !explicitNone.has('high-risk')) {
      const fullLines = text.split('\n')
      const hrStart = fullLines.findIndex((l) => /^##\s+高风险路径/.test(l))
      if (hrStart >= 0) {
        for (let i = hrStart + 1; i < fullLines.length; i += 1) {
          if (/^##\s+/.test(fullLines[i])) break
          const row = /^\|\s*`([^`]+)`\s*\|/.exec(fullLines[i].trim())
          if (row && !isPlaceholderVal(row[1])) profile.highRisk.push(row[1].trim())
        }
      }
    }

    if (hasHumanMergeAuthority(text)) {
      profile.mergeAuthority = 'human'
    }
  }

  profile.highRisk = [...new Set(profile.highRisk)]
  profile.doNotEdit = [...new Set(profile.doNotEdit)]
  const seenRules = new Set()
  profile.archRules = profile.archRules.filter((r) => {
    if (seenRules.has(r.raw)) return false
    seenRules.add(r.raw)
    return true
  })
  if (profile.highRisk.length === 0 && !explicitNone.has('high-risk')) {
    profile.highRisk = ['.github/workflows/', 'AGENTS.md']
  }

  const needFallback = (!profile.quickTest && !explicitNone.has('quick-test'))
    || (!profile.fullTest && !explicitNone.has('full-test'))
    || (!profile.mergeGate && !explicitNone.has('merge-gate'))
  const fallback = needFallback ? detectEcosystemCommands(repoRoot) : undefined
  if (!fallback) {
    profile.detectionEvidence = sniffLayeredCommands(repoRoot, { profile, fileRelList: [] }).detectionEvidence
    return profile
  }
  if (!profile.quickTest && !explicitNone.has('quick-test')) profile.quickTest = fallback.quickTest
  if (!profile.fullTest && !explicitNone.has('full-test')) {
    profile.fullTest = fallback.fullTest ?? (!explicitNone.has('quick-test') ? fallback.quickTest : undefined)
  }
  if (!profile.mergeGate && !explicitNone.has('merge-gate')) {
    profile.mergeGate = profile.fullTest ?? (!explicitNone.has('quick-test') ? profile.quickTest : undefined)
  }
  profile.detectedCommands = fallback
  profile.detectionEvidence = fallback.detectionEvidence
  return profile
}

/** 面向审查与审计脚本的键值对数组视图（与 parseAgentsProfile 单源同构）。 */
export function parseDevProfile(repoRoot) {
  const p = parseAgentsProfile(repoRoot)
  return {
    'quick-test': p.quickTest ? [p.quickTest] : [],
    'full-test': p.fullTest ? [p.fullTest] : [],
    'smoke-verify': p.smokeVerify ? [p.smokeVerify] : [],
    'merge-gate': p.mergeGate ? [p.mergeGate] : [],
    'arch-rules': p.archRules.map((r) => r.raw),
    'high-risk': [...p.highRisk],
    'do-not-edit': [...p.doNotEdit],
    explicitNone: p.explicitNone,
    mergeAuthority: p.mergeAuthority,
  }
}
