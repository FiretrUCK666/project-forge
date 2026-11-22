/**
 * profile.mjs —— 唯一权威的 AGENTS.md Dev Profile 解析器、取舍读取与动态多生态包清单发现。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），替代全套件多份重复解析器。
 * 严格保留显式填写的 `none` 禁用态，绝不回退猜测命令或默认高风险路径覆盖用户声明。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, posix } from 'node:path'

import { COMMON_SKIP_DIRS, isMacOsJunkPath, posixPath, readTextSafe } from './git.mjs'
import {
  discoverWorkspacePackages,
  parseYamlWorkspaceGlobs,
  sniffLayeredCommands,
} from './profile-sniffer.mjs'

export { discoverWorkspacePackages, parseYamlWorkspaceGlobs, sniffLayeredCommands }

export const DEFAULT_HIGH_RISK_PATHS = Object.freeze(['.github/workflows/', 'AGENTS.md', '.gitattributes'])

export function defaultHighRiskPaths(repoRoot) {
  return repoRoot && existsSync(join(repoRoot, '.github'))
    ? [...DEFAULT_HIGH_RISK_PATHS]
    : ['AGENTS.md', '.gitattributes']
}

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

export function isAnglePlaceholder(val) {
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

export function parseArchRuleItem(rawRule) {
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

/**
 * 层级名到 Dev Profile 键的唯一映射：`gate` → `merge-gate`，其余同名。
 *
 * 如果把这套对应关系分散写在三个地方（分层证据校验、试合、verify 选命令），一处改了另两处
 * 不知道，于是「verify 跑的是 merge-gate、试合跑的是 full-test」这种偏差没有任何东西
 * 会报错。映射本身只有一份，取命令时再按「有没有显式 none」决定要不要用它。
 */
export const TIER_PROFILE_KEYS = Object.freeze({
  quick: 'quick-test',
  smoke: 'smoke-verify',
  full: 'full-test',
  gate: 'merge-gate',
})

/** 层级名 → Dev Profile 里的属性名（`merge-gate` → `mergeGate`）。 */
export function tierProfileProp(tier) {
  const key = TIER_PROFILE_KEYS[tier]
  if (!key) return null
  return key.replace(/-([a-z])/g, (_all, ch) => ch.toUpperCase())
}

/**
 * 按层级取配置好的命令；该层被显式设为 `none` 时返回 `undefined`。
 *
 * `fallback` 只用于 `gate`：没配合并门禁时退到全量测试，再退到快速测试。
 * 这条降级链只有一处，别的调用方不再各自拼。
 */
export function resolveTierCommand(profile, tier, { fallback = false } = {}) {
  if (!profile) return undefined
  const key = TIER_PROFILE_KEYS[tier]
  const prop = tierProfileProp(tier)
  if (!key || !prop) return undefined
  if (isProfileExplicitNone(profile, key)) return undefined
  const direct = profile[prop]
  if (direct || !fallback) return direct
  const chain = tier === 'gate' ? ['full', 'quick'] : tier === 'full' ? ['quick'] : []
  for (const next of chain) {
    const v = resolveTierCommand(profile, next)
    if (v) return v
  }
  return undefined
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
  const declaredKeys = new Set()
  const profile = {
    hasAgents: text !== undefined,
    hasDevProfile: false,
    declaredProfileKeys: [],
    quickTest: undefined,
    fullTest: undefined,
    smokeVerify: undefined,
    mergeGate: undefined,
    archRules: [],
    highRisk: [],
    doNotEdit: [],
    evergreenDocs: [],
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
          const activeRawKey = activeListKey === 'highRisk' ? 'high-risk' : activeListKey === 'doNotEdit' ? 'do-not-edit' : 'arch-rules'
          if (isExplicitNoneValue(item)) {
            explicitNone.add(activeRawKey)
            if (activeListKey !== 'evergreenDocs') declaredKeys.add(activeRawKey)
          } else if (item && !isAnglePlaceholder(item)) {
            if (activeListKey === 'archRules') {
              const parsed = parseArchRuleItem(item)
              if (parsed) {
                profile.archRules.push(parsed)
                declaredKeys.add('arch-rules')
              }
            } else {
              profile[activeListKey].push(item)
              if (activeListKey !== 'evergreenDocs') declaredKeys.add(activeRawKey)
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
      if (!kv) {
        const optEv = /^(?:[-*]\s+)?`?evergreen-docs`?\s*:\s*(.*)$/i.exec(trimmed)
        if (optEv) {
          const rawEv = stripInlineYamlComment(optEv[1])
          if (rawEv === '') activeListKey = 'evergreenDocs'
          else if (!isExplicitNoneValue(rawEv)) {
            for (const item of parseListValue(rawEv)) profile.evergreenDocs.push(item)
          }
        }
        continue
      }
      const key = kv[1].toLowerCase()
      const rawVal = stripInlineYamlComment(kv[2])

      if (key === 'quick-test' || key === 'full-test' || key === 'smoke-verify' || key === 'merge-gate') {
        const cleaned = stripWrapQuotes(rawVal)
        if (isExplicitNoneValue(cleaned)) {
          explicitNone.add(key)
          declaredKeys.add(key)
          if (key === 'quick-test') profile.quickTest = undefined
          else if (key === 'full-test') profile.fullTest = undefined
          else if (key === 'smoke-verify') profile.smokeVerify = undefined
          else profile.mergeGate = undefined
        } else if (!isAnglePlaceholder(cleaned)) {
          declaredKeys.add(key)
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
        declaredKeys.add(key)
      } else if (targetProp === 'archRules') {
        for (const item of parseListValue(rawVal)) {
          const parsed = parseArchRuleItem(item)
          if (parsed) {
            profile.archRules.push(parsed)
            declaredKeys.add(key)
          }
        }
      } else {
        for (const item of parseListValue(rawVal)) {
          profile[targetProp].push(item)
          declaredKeys.add(key)
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

  profile.declaredProfileKeys = [...declaredKeys]
  profile.hasDevProfile = ['quick-test', 'full-test', 'smoke-verify', 'merge-gate'].some((k) => declaredKeys.has(k))

  profile.highRisk = [...new Set(profile.highRisk)]
  profile.doNotEdit = [...new Set(profile.doNotEdit)]
  profile.evergreenDocs = [...new Set(profile.evergreenDocs)]
  const seenRules = new Set()
  profile.archRules = profile.archRules.filter((r) => {
    if (seenRules.has(r.raw)) return false
    seenRules.add(r.raw)
    return true
  })
  if (profile.highRisk.length === 0 && !explicitNone.has('high-risk')) {
    profile.highRisk = defaultHighRiskPaths(repoRoot)
  }

  const needFallback = (!profile.quickTest && !explicitNone.has('quick-test'))
    || (!profile.fullTest && !explicitNone.has('full-test'))
    || (!profile.mergeGate && !explicitNone.has('merge-gate'))
  const fallback = needFallback ? detectEcosystemCommands(repoRoot) : undefined
  if (!fallback) {
    const aLines = text ? text.split('\n') : []
    const evidence = []
    for (const [key, prop] of [['quick-test', 'quickTest'], ['full-test', 'fullTest'], ['smoke-verify', 'smokeVerify'], ['merge-gate', 'mergeGate']]) {
      if (profile[prop]) {
        const idx = aLines.findIndex((l) => new RegExp(`^\\s*(?:[-*]\\s+)?\`?${key}\`?\\s*:`, 'i').test(l))
        evidence.push({ layer: 'dev-profile', kind: key, file: 'AGENTS.md', line: idx >= 0 ? idx + 1 : 1, command: profile[prop] })
      }
    }
    profile.detectionEvidence = evidence
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
    'evergreen-docs': [...p.evergreenDocs],
    explicitNone: p.explicitNone,
    mergeAuthority: p.mergeAuthority,
  }
}

const TRANSIENT_OR_EXCLUDED_DOC_RE = /^(?:docs\/(?:prd|specs|todo|archive|release-notes)\/|templates\/|\.worktrees\/|\.agents\/|\.git\/|node_modules\/)/i
const NON_AUTHORITY_ROOT_MD_RE = /^(?:README(?:\.[a-z0-9_-]+)?|AGENTS|CONTRIBUTING(?:\.[a-z0-9_-]+)?|RELEASING(?:\.[a-z0-9_-]+)?|CHANGELOG(?:\.[a-z0-9_-]+)?|LICENSE(?:\.[a-z0-9_-]+)?|CODE_OF_CONDUCT|SECURITY_ADVISORY)\.mdx?$/i
const CLASSIC_EVERGREEN_RE = /^(?:(?:docs\/(?:(?:architecture|design)\/)?)?(?:tdd|architecture|design|runbook|security)|(?:docs\/)?[a-z0-9._-]+-tdd|docs\/(?:architecture|design)\/[^/]+)\.mdx?$/i

function isExcludedEvergreenPath(rel) {
  const clean = posixPath(String(rel ?? '')).replace(/^\.\//, '')
  if (!clean || clean.includes('..') || !/\.mdx?$/i.test(clean)) return true
  if (TRANSIENT_OR_EXCLUDED_DOC_RE.test(clean)) return true
  if (NON_AUTHORITY_ROOT_MD_RE.test(clean)) return true
  if (/(?:^|\/)CHANGELOG(?:\.[a-z0-9_-]+)?\.mdx?$/i.test(clean)) return true
  return false
}

function simpleGlobToRegex(globPattern) {
  const clean = posixPath(String(globPattern ?? '')).replace(/^\.\//, '').replace(/\/+$/, '')
  const esc = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const reStr = esc.replace(/\*\*\//g, '(?:.*/)?').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
  return new RegExp(`^${reStr}$`, 'i')
}

function walkActiveMarkdownFiles(repoRoot) {
  const out = []
  const skip = new Set([...COMMON_SKIP_DIRS, '.git', '.worktrees', '.agents', 'templates', 'node_modules'])
  const walk = (absDir, relPrefix, depth) => {
    if (depth > 6) return
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const e of entries) {
      if (isMacOsJunkPath(e.name) || skip.has(e.name)) continue
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (TRANSIENT_OR_EXCLUDED_DOC_RE.test(`${rel}/`)) continue
        walk(join(absDir, e.name), rel, depth + 1)
      } else if (e.isFile() && /\.mdx?$/i.test(e.name)) {
        out.push(posixPath(rel))
      }
    }
  }
  walk(repoRoot, '', 0)
  return out
}

function hasEvergreenFrontmatter(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n')
  if (!s.startsWith('---\n')) return false
  const end = s.indexOf('\n---', 4)
  if (end < 0) return false
  const fm = s.slice(4, end)
  return /^\s*(?:evergreen\s*:\s*true|lifecycle\s*:\s*['"]?evergreen['"]?|authority\s*:\s*true)\s*$/im.test(fm)
}

function extractCoupledSyncMdPaths(agentsText) {
  const out = []
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  let inSection = false
  for (const line of lines) {
    if (/^##\s+改哪看哪(?:\s|$|[（(:：])/.test(line.trim())) { inSection = true; continue }
    if (inSection && /^##\s+/.test(line.trim())) break
    if (!inSection || !line.trim().startsWith('|')) continue
    for (const m of line.matchAll(/`([^`\n]+\.mdx?)`/gi)) {
      const p = posixPath(m[1].trim()).replace(/^\.\//, '')
      if (p && !p.includes('*') && !p.includes('<')) out.push(p)
    }
  }
  return out
}

function extractEntryLinkedMdPaths(text) {
  const out = []
  const src = String(text ?? '')
  for (const m of src.matchAll(/\[[^\]]+\]\(([^)#\s]+\.mdx?)(?:#[^)]+)?\)/gi)) {
    const raw = m[1].trim()
    if (!/^(?:https?:|mailto:|\/)/i.test(raw)) out.push(posixPath(raw).replace(/^\.\//, ''))
  }
  for (const m of src.matchAll(/`([^`\n\s]+\.mdx?)`/gi)) {
    const raw = m[1].trim()
    if (!/^(?:https?:|mailto:|\/|<)/i.test(raw) && !/[<>*?{}]/.test(raw)) out.push(posixPath(raw).replace(/^\.\//, ''))
  }
  return out
}

function normalizeEvergreenStem(relPath) {
  const base = posix.basename(posixPath(relPath)).replace(/\.mdx?$/i, '').toLowerCase()
  return base.replace(/[-_]?tdd$/i, 'tdd')
}

/**
 * 三层通用常青权威文档单一发现器（自动排除 docs/{prd,specs,todo,archive,release-notes}/、templates/、CHANGELOG 等瞬态/归档路径）：
 *   Layer 1 (profile)     : AGENTS.md Dev Profile 可选 `evergreen-docs:`、「改哪看哪」活跃 `.md`、「## 取舍」`tdd-authority`；
 *   Layer 2 (frontmatter) : 任意非瞬态 `.md` 头部 YAML Frontmatter 声明 `evergreen: true` / `lifecycle: evergreen` / `authority: true`；
 *   Layer 3 (entry-link / convention) : AGENTS.md / README*.md 显式链接的活跃 `.md`、根与 `docs/` 经典常青基线与 `docs/feature-map.json`。
 */
export function discoverEvergreenDocs(repoRoot, options = {}) {
  const root = String(repoRoot ?? '')
  if (!root || !existsSync(root)) {
    return { docs: [], markdownDocs: [], featureMap: null, duplicateGroups: [] }
  }
  const agentsText = options.agentsText ?? (readTextSafe(join(root, 'AGENTS.md')) ?? '')
  const profile = options.profile ?? parseAgentsProfile(root)
  const decisionMap = readDecisionMap(agentsText)
  const allActiveMd = Array.isArray(options.files)
    ? options.files.map((f) => posixPath(f?.rel ?? f)).filter((p) => /\.mdx?$/i.test(p))
    : walkActiveMarkdownFiles(root)
  const allMdSet = new Set(allActiveMd)

  const byPath = new Map()
  const addMd = (rawRel, source) => {
    const clean = posixPath(String(rawRel ?? '')).replace(/^\.\//, '')
    if (isExcludedEvergreenPath(clean)) return
    const abs = join(root, clean)
    try {
      if (!existsSync(abs) || !statSync(abs).isFile()) return
    } catch { return }
    if (byPath.has(clean)) return
    const stem = normalizeEvergreenStem(clean)
    const family = ['tdd', 'architecture', 'design', 'runbook', 'security'].includes(stem) ? stem : stem
    byPath.set(clean, { path: clean, kind: 'evergreen-doc', source, family, stem })
  }

  // Layer 1: explicit contract (Dev Profile optional evergreen-docs:, 改哪看哪, tdd-authority)
  const tddAuth = options.authoritativeTddPath ?? resolveAuthoritativeTddPath(root)
  if (tddAuth && decisionMap.has('tdd-authority')) addMd(tddAuth, 'profile')
  for (const pattern of profile?.evergreenDocs ?? []) {
    const cleanPat = posixPath(String(pattern ?? '')).replace(/^\.\//, '')
    if (!cleanPat) continue
    if (/[*?]/.test(cleanPat)) {
      const re = simpleGlobToRegex(cleanPat)
      for (const rel of allActiveMd) if (re.test(rel)) addMd(rel, 'profile')
    } else {
      addMd(cleanPat, 'profile')
    }
  }
  for (const rel of extractCoupledSyncMdPaths(agentsText)) addMd(rel, 'profile')

  // Layer 2: frontmatter self-declaration
  for (const rel of allActiveMd) {
    if (byPath.has(rel) || isExcludedEvergreenPath(rel)) continue
    const txt = readTextSafe(join(root, rel))
    if (txt && hasEvergreenFrontmatter(txt)) addMd(rel, 'frontmatter')
  }

  // Layer 3: zero-config fallback (entry links in AGENTS.md / README*.md + classic baselines + feature-map.json)
  const entryTexts = [agentsText]
  try {
    for (const e of readdirSync(root, { withFileTypes: true })) {
      if (e.isFile() && /^README(?:\.[a-z0-9_-]+)?\.mdx?$/i.test(e.name)) {
        entryTexts.push(readTextSafe(join(root, e.name)) ?? '')
      }
    }
  } catch { /* ignore */ }
  for (const entryText of entryTexts) {
    for (const rel of extractEntryLinkedMdPaths(entryText)) {
      if (allMdSet.size === 0 || allMdSet.has(rel) || existsSync(join(root, rel))) addMd(rel, 'entry-link')
    }
  }
  if (tddAuth) addMd(tddAuth, 'convention')
  for (const rel of allActiveMd) {
    if (CLASSIC_EVERGREEN_RE.test(rel)) addMd(rel, 'convention')
  }

  const markdownDocs = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
  const fmRel = 'docs/feature-map.json'
  const featureMap = existsSync(join(root, fmRel))
    ? { path: fmRel, kind: 'feature-map', source: 'convention', family: 'feature-map', stem: 'feature-map' }
    : null
  const docs = featureMap ? [...markdownDocs, featureMap] : [...markdownDocs]

  // Duplicate groups: same stem across >=2 locations without explicit pointer or decision exemption
  const byStem = new Map()
  for (const d of markdownDocs) {
    if (!byStem.has(d.stem)) byStem.set(d.stem, [])
    byStem.get(d.stem).push(d.path)
  }
  const duplicateGroups = []
  const allowAllDup = decisionMap.has('allow-duplicate-docs')
  for (const [stem, paths] of byStem.entries()) {
    if (paths.length < 2 || allowAllDup || decisionMap.has(`keep-duplicate-${stem}`)) continue
    const texts = new Map(paths.map((p) => [p, readTextSafe(join(root, p)) ?? '']))
    const hasPointer = paths.some((p) => {
      const txt = texts.get(p) ?? ''
      return paths.some((other) => other !== p && txt.includes(other) && /(?:权威|主文档|唯一|跳转|见|canonical|authority|single\s+source|see\s+|moved\s+to|redirect)/i.test(txt))
    })
    if (!hasPointer) {
      duplicateGroups.push({ stem, family: stem, paths: [...paths].sort() })
    }
  }
  return { docs, markdownDocs, featureMap, duplicateGroups }
}
