/**
 * static-evidence.mjs —— 3 层证据驱动的 10 类图表静态证据抽取与激活门控引擎。
 *
 * Tier 1（常驻）：`architecture`、`workflow`、`tree`
 * Tier 2（严阈按需，无证据零空 Tab）：`erd`、`class`（>=3 边）、`sequence`（>=3 跳）、
 * `lifecycle`（>=2 状态且 >=1 迁移）、`dataflow`（>=2 阶段且 >=1 依赖边）、`timeline`（tags+merges>=2）
 * Tier 3（仅真实实测遥测）：`waterfall`（显式传入合法 `telemetrySpans` 时激活，绝不伪造耗时）
 */

import { basename, join, resolve } from 'node:path'

import { readFeatureMapSafe } from './feature-map.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { MAX_ANALYZE_FILE_BYTES, analyzeRepoStatic, analyzeRepoStaticSync } from './static-analyzer.mjs'
import { stripCodeCommentsLines } from './static-gates-lexer.mjs'

export const DIAGRAM_TIERS = Object.freeze({
  tier1: Object.freeze(['architecture', 'workflow', 'tree']),
  tier2: Object.freeze(['erd', 'class', 'sequence', 'lifecycle', 'dataflow', 'timeline']),
  tier3: Object.freeze(['waterfall']),
})

export const ALL_DIAGRAM_IDS = Object.freeze([
  ...DIAGRAM_TIERS.tier1,
  ...DIAGRAM_TIERS.tier2,
  ...DIAGRAM_TIERS.tier3,
])

const DIAGRAM_TITLES = Object.freeze({
  architecture: '架构全景',
  workflow: '主流程',
  tree: '目录树',
  erd: '数据实体 (ERD)',
  class: '类型继承关系',
  sequence: '调用时序链',
  lifecycle: '状态生命周期',
  dataflow: '管道与工作流数据流',
  timeline: '演进时间线',
  waterfall: '实测耗时瀑布',
})

function stripSqlComments(text) {
  return String(text ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
}

function readCleanCode(repoRoot, rel) {
  const txt = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
  if (!txt) return null
  const ext = rel.includes('.') ? rel.split('.').pop().toLowerCase() : ''
  return { raw: txt, ext, codeLines: stripCodeCommentsLines(txt, ext) }
}

function buildArchitectureDiagram(analysis, featureMap) {
  const fmFeatures = Array.isArray(featureMap?.features) ? featureMap.features : []
  if (fmFeatures.length > 0) {
    const domains = Array.isArray(featureMap?.domains) ? featureMap.domains : []
    const nodes = fmFeatures.map((f) => ({
      id: f.id,
      label: f.name || f.id,
      domain: f.domain || 'default',
      moduleCount: (f.modules ?? []).length,
    }))
    const edges = []
    for (const f of fmFeatures) {
      for (const dep of Array.isArray(f.dependsOn) ? f.dependsOn : []) {
        edges.push({ from: f.id, to: dep })
      }
    }
    return { id: 'architecture', tier: 1, empty: false, source: 'feature-map', domains, nodes, edges }
  }
  const byGroup = new Map()
  for (const n of analysis.nodes) {
    const segs = n.id.split('/')
    const grp = segs.length > 1 ? segs.slice(0, Math.min(2, segs.length - 1)).join('/') : '.'
    if (!byGroup.has(grp)) byGroup.set(grp, [])
    byGroup.get(grp).push(n.id)
  }
  const domains = [...byGroup.keys()].sort().map((id) => ({ id, name: id, count: byGroup.get(id).length }))
  return {
    id: 'architecture',
    tier: 1,
    empty: analysis.nodes.length === 0,
    source: analysis.nodes.length > 0 ? 'static-imports' : 'empty',
    domains,
    nodes: analysis.nodes.map((n) => ({ id: n.id, label: basename(n.id), lang: n.lang, fanIn: n.fanIn, fanOut: n.fanOut, inCycle: n.inCycle })),
    edges: analysis.edges.map((e) => ({ from: e.from, to: e.to })),
  }
}

function buildWorkflowDiagram(analysis, featureMap) {
  const fmFlows = Array.isArray(featureMap?.flows) ? featureMap.flows : []
  if (fmFlows.length > 0) {
    const lanes = [...new Set(fmFlows.flatMap((fl) => fl.actors ?? []))]
    const steps = fmFlows.flatMap((fl) => (fl.steps ?? []).map((s, idx) => ({
      flowId: fl.id,
      index: idx,
      feature: s.feature,
      actor: s.actor || 'system',
      action: s.action || s.feature,
    })))
    return { id: 'workflow', tier: 1, empty: steps.length === 0, source: 'feature-map', lanes, flows: fmFlows, steps }
  }
  const entries = analysis.nodes.filter((n) => n.fanIn === 0 && n.fanOut > 0).slice(0, 12)
  return {
    id: 'workflow',
    tier: 1,
    empty: entries.length === 0,
    source: entries.length > 0 ? 'entry-chains' : 'empty',
    lanes: [...new Set(entries.map((e) => e.id.split('/')[0] || 'root'))],
    steps: entries.map((e, i) => ({ index: i, id: e.id, label: basename(e.id), fanOut: e.fanOut })),
  }
}

function isTestFixturePath(rel) {
  const p = posixPath(String(rel || ''))
  return /(?:^|\/)(?:__fixtures__|fixtures-[^/]+|[^/]*\.fixtures\.[^/]+)$/i.test(p)
    || /^scripts\/dev\/fixtures/i.test(p)
}

function buildTreeDiagram(repoRoot, analysis, featureMap) {
  const rootName = String(featureMap?.repoName || featureMap?.project || '').trim() || basename(resolve(repoRoot))
  const rootNode = { name: rootName, path: '', children: new Map(), fileCount: 0 }
  for (const rel of analysis.repoFiles) {
    const parts = posixPath(rel).split('/').filter(Boolean)
    let cur = rootNode
    cur.fileCount += 1
    let acc = ''
    for (let i = 0; i < parts.length; i += 1) {
      const seg = parts[i]
      acc = acc ? `${acc}/${seg}` : seg
      if (!cur.children.has(seg)) {
        cur.children.set(seg, { name: seg, path: acc, isFile: i === parts.length - 1, children: new Map(), fileCount: 0 })
      }
      cur = cur.children.get(seg)
      cur.fileCount += 1
    }
  }
  const serialize = (node, depth = 0) => ({
    name: node.name,
    path: node.path,
    isFile: Boolean(node.isFile),
    fileCount: node.fileCount,
    children: depth >= 6 ? [] : [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map((c) => serialize(c, depth + 1)),
  })
  return {
    id: 'tree',
    tier: 1,
    empty: analysis.repoFiles.length === 0,
    totalFiles: analysis.repoFiles.length,
    root: serialize(rootNode),
  }
}

function extractErdEvidence(repoRoot, repoFiles) {
  const entities = new Map()
  const relations = []
  const seenRel = new Set()
  const addEntity = (name, source, fields = []) => {
    const clean = String(name ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    if (!clean) return null
    if (!entities.has(clean)) entities.set(clean, { name: clean, source, fields: [] })
    const ent = entities.get(clean)
    for (const f of fields) {
      if (f && !ent.fields.includes(f)) ent.fields.push(f)
    }
    return ent
  }
  const addRelation = (from, to, label = 'references') => {
    const f = String(from ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    const t = String(to ?? '').trim().replace(/^["'`]|["'`]$/g, '')
    if (!f || !t || f === t) return
    const key = `${f}->${t}:${label}`
    if (seenRel.has(key)) return
    seenRel.add(key)
    relations.push({ from: f, to: t, label })
  }

  for (const rel of repoFiles) {
    const low = rel.toLowerCase()
    if (low.endsWith('.prisma')) {
      const raw = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
      if (!raw) continue
      const clean = stripCodeCommentsLines(raw, 'ts').join('\n')
      for (const m of clean.matchAll(/\bmodel\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\}/g)) {
        const modelName = m[1]
        const fields = []
        for (const rawLine of m[2].split('\n')) {
          const line = rawLine.trim()
          if (!line || line.startsWith('@@')) continue
          const fm = /^([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_?[\]]*)/.exec(line)
          if (!fm) continue
          fields.push(`${fm[1]}:${fm[2]}`)
          const targetType = fm[2].replace(/[?[\]]+$/g, '')
          if (/@relation\b/.test(line) && /^[A-Z]/.test(targetType)) {
            addRelation(modelName, targetType, fm[1])
          }
        }
        addEntity(modelName, rel, fields)
      }
      continue
    }

    if (low.endsWith('.sql')) {
      const raw = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
      if (!raw) continue
      const clean = stripSqlComments(raw)
      for (const m of clean.matchAll(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)\s*\(([\s\S]*?)\)\s*;/gi)) {
        const tbl = m[1].replace(/["`]/g, '')
        const body = m[2]
        const fields = []
        for (const seg of body.split(/,\s*\n|,\s*(?=[A-Za-z_"`])/)) {
          const line = seg.trim()
          if (!line) continue
          const fk = /\bFOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)/i.exec(line)
          if (fk) { addRelation(tbl, fk[2].replace(/["`]/g, ''), fk[1].trim()); continue }
          if (/^(?:PRIMARY\s+KEY|UNIQUE|CONSTRAINT|CHECK|INDEX|KEY)\b/i.test(line)) {
            const refM = /\bREFERENCES\s+(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)/i.exec(line)
            if (refM) addRelation(tbl, refM[1].replace(/["`]/g, ''), 'fk')
            continue
          }
          const col = /^["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s+([A-Za-z0-9_()]+)/.exec(line)
          if (col) {
            fields.push(`${col[1]}:${col[2]}`)
            const inlineRef = /\bREFERENCES\s+(?:[A-Za-z0-9_"`]+\.)?([A-Za-z0-9_"`]+)/i.exec(line)
            if (inlineRef) addRelation(tbl, inlineRef[1].replace(/["`]/g, ''), col[1])
          }
        }
        addEntity(tbl, rel, fields)
      }
      continue
    }

    if (/\.(?:ts|tsx|js|mjs|py|go|rs)$/i.test(low)) {
      const cleaned = readCleanCode(repoRoot, rel)
      if (!cleaned) continue
      const text = cleaned.codeLines.join('\n')
      if (/@Entity\s*\(/.test(text)) {
        for (const m of text.matchAll(/@Entity\s*\([^)]*\)\s*(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)\n\}/g)) {
          const cols = [...m[2].matchAll(/@(?:PrimaryGeneratedColumn|PrimaryColumn|Column)\s*\([^)]*\)\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((c) => c[1])
          addEntity(m[1], rel, cols)
          for (const rm of m[2].matchAll(/@(?:ManyToOne|OneToMany|OneToOne|ManyToMany)\s*\(\s*\(\)\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)/g)) {
            addRelation(m[1], rm[1], 'orm')
          }
        }
      }
      if (/\b(?:pgTable|mysqlTable|sqliteTable)\s*\(/.test(text)) {
        for (const m of text.matchAll(/\b(?:pgTable|mysqlTable|sqliteTable)\s*\(\s*['"]([A-Za-z0-9_]+)['"]\s*,\s*\{([\s\S]*?)\}\s*\)/g)) {
          const cols = [...m[2].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)].map((c) => c[1])
          addEntity(m[1], rel, cols)
          for (const rm of m[2].matchAll(/\.references\s*\(\s*\(\)\s*=>\s*([A-Za-z_][A-Za-z0-9_]*)\./g)) {
            addRelation(m[1], rm[1], 'fk')
          }
        }
      }
      if (low.endsWith('.py') && /__tablename__\s*=/.test(text)) {
        for (const m of text.matchAll(/class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*:([\s\S]*?)(?=\nclass\s|\n[^\s]|$)/g)) {
          if (!/__tablename__\s*=/.test(m[2])) continue
          const cols = [...m[2].matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:db\.)?(?:Column|mapped_column)\s*\(/gm)].map((c) => c[1])
          addEntity(m[1], rel, cols)
          for (const rm of m[2].matchAll(/ForeignKey\s*\(\s*['"]([A-Za-z0-9_]+)\./g)) addRelation(m[1], rm[1], 'fk')
        }
      }
      if (low.endsWith('.go') && /gorm:"/.test(text)) {
        for (const m of text.matchAll(/type\s+([A-Za-z_][A-Za-z0-9_]*)\s+struct\s*\{([\s\S]*?)\}/g)) {
          if (!/gorm:"/.test(m[2])) continue
          const cols = [...m[2].matchAll(/^\s*([A-Z][A-Za-z0-9_]*)\s+[^\n]*gorm:"/gm)].map((c) => c[1])
          addEntity(m[1], rel, cols)
        }
      }
      if (low.endsWith('.rs') && /\btable!\s*\{/.test(text)) {
        for (const m of text.matchAll(/\btable!\s*\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*\{([\s\S]*?)\}\s*\}/g)) {
          const cols = [...m[2].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*->/gm)].map((c) => c[1])
          addEntity(m[1], rel, cols)
        }
      }
    }
  }

  const list = [...entities.values()].sort((a, b) => a.name.localeCompare(b.name))
  const totalFields = list.reduce((sum, e) => sum + e.fields.length, 0)
  const active = list.length >= 1 && (totalFields > 0 || relations.length > 0)
  return {
    active,
    reason: active ? `发现 ${list.length} 个实体、${totalFields} 个字段与 ${relations.length} 条关系` : '未发现有效 Schema/SQL/ORM 实体定义',
    threshold: '>=1 entity with fields or relations',
    data: { id: 'erd', tier: 2, entities: list, relations },
  }
}

function extractClassEvidence(repoRoot, nodes) {
  const edges = []
  const seen = new Set()
  const addEdge = (from, to, kind, file) => {
    const f = String(from ?? '').trim()
    const t = String(to ?? '').trim()
    if (!f || !t || f === t || t === 'object' || t === 'Object') return
    const key = `${f}\0${t}\0${kind}`
    if (seen.has(key)) return
    seen.add(key)
    edges.push({ from: f, to: t, kind, file })
  }

  for (const n of nodes) {
    if (isTestFixturePath(n.id)) continue
    const cleaned = readCleanCode(repoRoot, n.id)
    if (!cleaned) continue
    const { ext, codeLines } = cleaned
    const text = codeLines.join('\n')

    if (['ts', 'tsx', 'js', 'mjs', 'cjs', 'jsx', 'mts', 'cts'].includes(ext)) {
      for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]*>)?\s+extends\s+([A-Za-z_$][A-Za-z0-9_$.]*)/g)) {
        addEdge(m[1], m[2].split('.').pop(), 'extends', n.id)
      }
      for (const m of text.matchAll(/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]*>)?(?:\s+extends\s+[A-Za-z_$][A-Za-z0-9_$.]*(?:<[^>]*>)?)?\s+implements\s+([A-Za-z0-9_$,\s.<>]+?)\s*\{/g)) {
        for (const iface of m[2].split(',')) {
          const clean = iface.replace(/<[^>]*>/g, '').trim().split('.').pop()
          if (clean) addEdge(m[1], clean, 'implements', n.id)
        }
      }
      for (const m of text.matchAll(/\binterface\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:<[^>]*>)?\s+extends\s+([A-Za-z0-9_$,\s.<>]+?)\s*\{/g)) {
        for (const base of m[2].split(',')) {
          const clean = base.replace(/<[^>]*>/g, '').trim().split('.').pop()
          if (clean) addEdge(m[1], clean, 'extends', n.id)
        }
      }
    } else if (ext === 'py') {
      for (const line of codeLines) {
        const m = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)\s*:/.exec(line)
        if (!m) continue
        for (const base of m[2].split(',')) {
          const clean = base.replace(/\[[^\]]*\]/g, '').trim().split('.').pop()
          if (clean && !/^(?:object|Enum|IntEnum|StrEnum|ABC|Protocol|TypedDict)$/.test(clean) && !clean.includes('=')) {
            addEdge(m[1], clean, 'extends', n.id)
          }
        }
      }
    } else if (ext === 'go') {
      for (const m of text.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s+(struct|interface)\s*\{([\s\S]*?)\}/g)) {
        for (const rawLine of m[3].split('\n')) {
          const line = rawLine.trim()
          if (!line || line.includes('(') || line.includes('`')) continue
          const emb = /^\*?([A-Za-z_][A-Za-z0-9_.]*)$/.exec(line)
          if (emb) addEdge(m[1], emb[1].split('.').pop(), 'embeds', n.id)
        }
      }
    } else if (ext === 'rs') {
      for (const line of codeLines) {
        const im = /^\s*impl(?:<[^>]*>)?\s+([A-Za-z_][A-Za-z0-9_:]*)(?:<[^>]*>)?\s+for\s+([A-Za-z_][A-Za-z0-9_:]*)/.exec(line)
        if (im) addEdge(im[2].split('::').pop(), im[1].split('::').pop(), 'implements', n.id)
        const tr = /^\s*(?:pub\s+)?trait\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?\s*:\s*([A-Za-z0-9_+\s:]+)/.exec(line)
        if (tr) {
          for (const base of tr[2].split('+')) {
            const clean = base.trim().split('::').pop()
            if (clean && !/^(?:Send|Sync|Sized|Clone|Copy|Debug)$/.test(clean)) addEdge(tr[1], clean, 'extends', n.id)
          }
        }
      }
    } else if (ext === 'java' || ext === 'kt' || ext === 'kts') {
      for (const m of text.matchAll(/\b(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?\s+extends\s+([A-Za-z_][A-Za-z0-9_.]*)/g)) {
        addEdge(m[1], m[2].split('.').pop(), 'extends', n.id)
      }
      for (const m of text.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)(?:<[^>]*>)?(?:\s+extends\s+[A-Za-z_][A-Za-z0-9_.]*)?\s+implements\s+([A-Za-z0-9_,\s.<>]+?)\s*\{/g)) {
        for (const iface of m[2].split(',')) {
          const clean = iface.replace(/<[^>]*>/g, '').trim().split('.').pop()
          if (clean) addEdge(m[1], clean, 'implements', n.id)
        }
      }
      if (ext === 'kt' || ext === 'kts') {
        for (const m of text.matchAll(/\b(?:class|interface)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*\([^)]*\))?\s*:\s*([A-Za-z0-9_,\s().<>]+?)\s*\{/g)) {
          for (const base of m[2].split(',')) {
            const clean = base.replace(/\([^)]*\)/g, '').replace(/<[^>]*>/g, '').trim().split('.').pop()
            if (clean) addEdge(m[1], clean, 'extends', n.id)
          }
        }
      }
    }
  }

  const classNames = [...new Set(edges.flatMap((e) => [e.from, e.to]))].sort()
  const active = edges.length >= 3
  return {
    active,
    reason: active ? `发现 ${edges.length} 条类型继承/接口实现边` : `仅发现 ${edges.length} 条类型边（低于阈值 >=3）`,
    threshold: '>=3 inheritance/interface edges',
    data: { id: 'class', tier: 2, classes: classNames, edges },
  }
}

function extractSequenceEvidence(analysis) {
  const adj = new Map()
  for (const e of analysis.edges) {
    if (!adj.has(e.from)) adj.set(e.from, [])
    adj.get(e.from).push(e.to)
  }
  for (const list of adj.values()) list.sort()

  const entryPriority = (id) => (/(?:route|router|controller|handler|cli|main|index|page|app)/i.test(id) ? 0 : 1)
  const starts = [...analysis.nodes]
    .filter((n) => (adj.get(n.id)?.length ?? 0) > 0)
    .sort((a, b) => (a.fanIn - b.fanIn) || (entryPriority(a.id) - entryPriority(b.id)) || a.id.localeCompare(b.id))
    .slice(0, 60)

  let bestChain = []
  const MAX_DEPTH = 8
  let visitBudget = 2000

  const dfs = (cur, path, visited) => {
    if (visitBudget <= 0) return
    visitBudget -= 1
    if (path.length > bestChain.length) bestChain = [...path]
    if (path.length >= MAX_DEPTH) return
    for (const nxt of adj.get(cur) ?? []) {
      if (visited.has(nxt)) continue
      visited.add(nxt)
      path.push(nxt)
      dfs(nxt, path, visited)
      path.pop()
      visited.delete(nxt)
    }
  }

  for (const s of starts) {
    if (visitBudget <= 0) break
    dfs(s.id, [s.id], new Set([s.id]))
  }

  const maxHops = Math.max(0, bestChain.length - 1)
  const steps = []
  for (let i = 0; i < bestChain.length - 1; i += 1) {
    steps.push({ hop: i + 1, from: bestChain[i], to: bestChain[i + 1] })
  }
  const active = maxHops >= 3
  return {
    active,
    reason: active ? `发现最长 ${maxHops} 跳跨参与者调用链` : `最长调用链仅 ${maxHops} 跳（低于阈值 >=3 跳）`,
    threshold: '>=3 cross-participant hops',
    data: { id: 'sequence', tier: 2, maxHops, participants: bestChain, steps },
  }
}

function extractLifecycleEvidence(repoRoot, nodes) {
  const states = new Set()
  const transitions = []
  const seenTrans = new Set()

  const addTransition = (from, to, file) => {
    const f = String(from ?? '').trim()
    const t = String(to ?? '').trim()
    if (!f || !t || f === t) return
    const key = `${f}->${t}`
    if (seenTrans.has(key)) return
    seenTrans.add(key)
    transitions.push({ from: f, to: t, file })
  }

  for (const n of nodes) {
    if (isTestFixturePath(n.id)) continue
    const cleaned = readCleanCode(repoRoot, n.id)
    if (!cleaned) continue
    const text = cleaned.codeLines.join('\n')
    const localStates = new Set()

    for (const m of text.matchAll(/\btype\s+[A-Za-z_][A-Za-z0-9_]*(?:Status|State|Phase|Stage)\s*=\s*([^\n;]+)/g)) {
      for (const sm of m[1].matchAll(/['"]([A-Za-z0-9_-]{2,32})['"]/g)) localStates.add(sm[1])
    }
    for (const m of text.matchAll(/\benum\s+[A-Za-z_][A-Za-z0-9_]*(?:Status|State|Phase|Stage)\s*\{([\s\S]*?)\}/g)) {
      for (const sm of m[1].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)/gm)) localStates.add(sm[1])
    }
    for (const m of text.matchAll(/\b(?:const|let|var)\s+[A-Z0-9_]*(?:STATES|STATUSES|PHASES)\s*=\s*(?:Object\.freeze\s*\()?\s*\[([^\]]+)\]/g)) {
      for (const sm of m[1].matchAll(/['"]([A-Za-z0-9_-]{2,32})['"]/g)) localStates.add(sm[1])
    }
    for (const m of text.matchAll(/class\s+[A-Za-z_][A-Za-z0-9_]*(?:Status|State)\s*\([^)]*Enum[^)]*\)\s*:([\s\S]*?)(?=\nclass\s|\ndef\s|$)/g)) {
      for (const sm of m[1].matchAll(/^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) localStates.add(sm[1])
    }

    if (localStates.size < 2) continue
    for (const s of localStates) states.add(s)

    for (const m of text.matchAll(/\b[A-Za-z0-9_]*(?:TRANSITIONS?|STATE_MAP|NEXT_STATES?)\s*=\s*(?:Object\.freeze\s*\()?\s*\{([\s\S]*?)\}/gi)) {
      for (const row of m[1].matchAll(/['"]?([A-Za-z0-9_-]+)['"]?\s*:\s*\[([^\]]*)\]/g)) {
        const from = row[1]
        if (!localStates.has(from)) continue
        for (const tm of row[2].matchAll(/['"]([A-Za-z0-9_-]+)['"]/g)) {
          if (localStates.has(tm[1])) addTransition(from, tm[1], n.id)
        }
      }
    }
    for (const m of text.matchAll(/\{\s*from\s*:\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*to\s*:\s*['"]([A-Za-z0-9_-]+)['"]/g)) {
      if (localStates.has(m[1]) && localStates.has(m[2])) addTransition(m[1], m[2], n.id)
    }
    for (const m of text.matchAll(/\btransition\s*\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([A-Za-z0-9_-]+)['"]/g)) {
      if (localStates.has(m[1]) && localStates.has(m[2])) addTransition(m[1], m[2], n.id)
    }
  }

  const stateList = [...states].sort()
  const active = stateList.length >= 2 && transitions.length >= 1
  return {
    active,
    reason: active ? `发现 ${stateList.length} 个状态与 ${transitions.length} 条状态迁移边` : `状态(${stateList.length})或迁移边(${transitions.length})未达激活阈值`,
    threshold: '>=2 states and >=1 transition',
    data: { id: 'lifecycle', tier: 2, states: stateList, transitions },
  }
}

function extractDataflowEvidence(repoRoot, repoFiles) {
  const stages = new Map()
  const edges = []
  const seenEdge = new Set()
  const addStage = (id, source, kind) => {
    const clean = String(id ?? '').trim()
    if (clean && !stages.has(clean)) stages.set(clean, { id: clean, source, kind })
  }
  const addEdge = (from, to, source) => {
    const f = String(from ?? '').trim()
    const t = String(to ?? '').trim()
    if (!f || !t || f === t) return
    const key = `${f}->${t}`
    if (seenEdge.has(key)) return
    seenEdge.add(key)
    edges.push({ from: f, to: t, source })
  }

  const wfFiles = repoFiles.filter((r) => /^\.github\/workflows\/[^/]+\.ya?ml$/i.test(r))
  for (const rel of wfFiles) {
    const txt = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
    if (!txt) continue
    const lines = txt.split('\n')
    let inJobs = false
    let jobsIndent = -1
    let curJob = null
    let jobIndent = -1
    let inNeedsList = false
    let needsIndent = -1

    for (const raw of lines) {
      const code = raw.replace(/\s+#.*$/, '')
      const trimmed = code.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const indent = code.length - code.trimStart().length

      if (!inJobs) {
        if (/^jobs\s*:\s*$/.test(trimmed)) { inJobs = true; jobsIndent = indent }
        continue
      }
      if (indent <= jobsIndent) { inJobs = false; curJob = null; inNeedsList = false; continue }

      if (jobIndent < 0 || indent === jobIndent) {
        const jm = /^([A-Za-z0-9_-]+)\s*:\s*$/.exec(trimmed)
        if (jm) {
          jobIndent = indent
          curJob = jm[1]
          inNeedsList = false
          addStage(`${rel}:${curJob}`, rel, 'ci-job')
          continue
        }
      }
      if (!curJob || indent <= jobIndent) continue
      if (inNeedsList && indent <= needsIndent) inNeedsList = false

      const needsInline = /^needs\s*:\s*(.+)$/.exec(trimmed)
      if (needsInline) {
        const val = needsInline[1].trim()
        const deps = val.startsWith('[') && val.endsWith(']')
          ? val.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)
          : [val.replace(/^['"]|['"]$/g, '')].filter(Boolean)
        for (const dep of deps) {
          addStage(`${rel}:${dep}`, rel, 'ci-job')
          addEdge(`${rel}:${dep}`, `${rel}:${curJob}`, rel)
        }
        continue
      }
      if (/^needs\s*:\s*$/.test(trimmed)) { inNeedsList = true; needsIndent = indent; continue }
      if (inNeedsList) {
        const item = /^-\s+([A-Za-z0-9_-]+)/.exec(trimmed)
        if (item) {
          addStage(`${rel}:${item[1]}`, rel, 'ci-job')
          addEdge(`${rel}:${item[1]}`, `${rel}:${curJob}`, rel)
        }
      }
    }
  }

  for (const rel of repoFiles.filter((r) => /(?:^|\/)Dockerfile(?:\.[A-Za-z0-9_-]+)?$/i.test(r))) {
    const txt = readTextSafe(join(repoRoot, rel), MAX_ANALYZE_FILE_BYTES)
    if (!txt) continue
    const dockerStages = []
    for (const m of txt.matchAll(/^\s*FROM\s+\S+\s+AS\s+([A-Za-z0-9_-]+)/gim)) {
      dockerStages.push(m[1])
      addStage(`${rel}:${m[1]}`, rel, 'docker-stage')
    }
    for (const m of txt.matchAll(/--from=([A-Za-z0-9_-]+)/g)) {
      if (dockerStages.includes(m[1]) && dockerStages.length >= 2) {
        addEdge(`${rel}:${m[1]}`, `${rel}:${dockerStages[dockerStages.length - 1]}`, rel)
      }
    }
  }

  const stageList = [...stages.values()]
  const active = stageList.length >= 2 && edges.length >= 1
  return {
    active,
    reason: active ? `发现 ${stageList.length} 个管道/CI 阶段与 ${edges.length} 条依赖边` : `仅发现 ${stageList.length} 个阶段与 ${edges.length} 条依赖边（低于阈值）`,
    threshold: '>=2 stages and >=1 dependency edge',
    data: { id: 'dataflow', tier: 2, stages: stageList, edges },
  }
}

function extractTimelineEvidence(analysis) {
  const events = [
    ...(analysis.tags ?? []).map((t) => ({ kind: 'tag', id: t.name, date: t.date, sha: t.sha, label: t.subject || t.name })),
    ...(analysis.merges ?? []).map((m) => ({ kind: 'merge', id: m.sha, date: m.date, sha: m.sha, label: m.subject || `merge ${m.sha}` })),
  ].sort((a, b) => String(a.date ?? '').localeCompare(String(b.date ?? '')) || a.id.localeCompare(b.id))

  const active = events.length >= 2
  return {
    active,
    reason: active ? `发现 ${events.length} 条标签与合并里程碑` : `仅发现 ${events.length} 条标签/合并记录（低于阈值 >=2）`,
    threshold: 'tags.length + merges.length >= 2',
    data: { id: 'timeline', tier: 2, events },
  }
}

function extractWaterfallEvidence(telemetrySpans) {
  if (!Array.isArray(telemetrySpans) || telemetrySpans.length === 0) {
    return {
      active: false,
      reason: '未提供真实实测 telemetrySpans（Tier 3 绝不伪造耗时）',
      threshold: 'non-empty validated telemetrySpans',
      data: null,
    }
  }
  const valid = []
  for (const sp of telemetrySpans) {
    if (!sp || typeof sp !== 'object') continue
    const id = String(sp.id ?? '').trim()
    const label = String(sp.label ?? '').trim()
    const startMs = Number(sp.startMs)
    const durationMs = Number(sp.durationMs)
    if (!id || !label || !Number.isFinite(startMs) || startMs < 0 || !Number.isFinite(durationMs) || durationMs < 0) {
      continue
    }
    valid.push({ id, label, startMs, durationMs, endMs: startMs + durationMs })
  }
  const active = valid.length > 0
  return {
    active,
    reason: active ? `载入 ${valid.length} 条实测遥测 span` : '传入 telemetrySpans 均未通过非负有限数值校验',
    threshold: 'non-empty validated telemetrySpans',
    data: active ? { id: 'waterfall', tier: 3, spans: valid, totalMs: Math.max(...valid.map((s) => s.endMs)) } : null,
  }
}

/**
 * 同步 3 层 10 类图表静态证据抽取主入口：返回 `{ activeTabs, skippedTabs, diagrams }`，确保零空 Tab。
 */
export function extractMultiDiagramEvidenceSync(repoRoot, {
  analysis = null,
  featureMap = null,
  telemetrySpans = null,
  cacheRoot = null,
  useCache = true,
} = {}) {
  const root = resolve(String(repoRoot || process.cwd()))
  const resolvedAnalysis = analysis ?? analyzeRepoStaticSync(root, { cacheRoot, useCache })
  const fmLoaded = featureMap ? { data: featureMap } : readFeatureMapSafe(root)
  const fmData = fmLoaded?.data ?? null

  const activeTabs = []
  const skippedTabs = []
  const diagrams = {}

  const tier1Diagrams = {
    architecture: buildArchitectureDiagram(resolvedAnalysis, fmData),
    workflow: buildWorkflowDiagram(resolvedAnalysis, fmData),
    tree: buildTreeDiagram(root, resolvedAnalysis, fmData),
  }
  for (const id of DIAGRAM_TIERS.tier1) {
    diagrams[id] = tier1Diagrams[id]
    activeTabs.push({ id, tier: 1, title: DIAGRAM_TITLES[id], reason: 'Tier 1 常驻视图' })
  }

  const tier2Results = {
    erd: extractErdEvidence(root, resolvedAnalysis.repoFiles),
    class: extractClassEvidence(root, resolvedAnalysis.nodes),
    sequence: extractSequenceEvidence(resolvedAnalysis),
    lifecycle: extractLifecycleEvidence(root, resolvedAnalysis.nodes),
    dataflow: extractDataflowEvidence(root, resolvedAnalysis.repoFiles),
    timeline: extractTimelineEvidence(resolvedAnalysis),
  }
  for (const id of DIAGRAM_TIERS.tier2) {
    const res = tier2Results[id]
    if (res.active) {
      diagrams[id] = res.data
      activeTabs.push({ id, tier: 2, title: DIAGRAM_TITLES[id], reason: res.reason })
    } else {
      skippedTabs.push({ id, tier: 2, title: DIAGRAM_TITLES[id], reason: res.reason, threshold: res.threshold })
    }
  }

  const wf = extractWaterfallEvidence(telemetrySpans)
  if (wf.active) {
    diagrams.waterfall = wf.data
    activeTabs.push({ id: 'waterfall', tier: 3, title: DIAGRAM_TITLES.waterfall, reason: wf.reason })
  } else {
    skippedTabs.push({ id: 'waterfall', tier: 3, title: DIAGRAM_TITLES.waterfall, reason: wf.reason, threshold: wf.threshold })
  }

  return { activeTabs, skippedTabs, diagrams }
}

/**
 * 3 层 10 类图表静态证据抽取主入口（异步）：返回 `{ activeTabs, skippedTabs, diagrams }`，确保零空 Tab。
 */
export async function extractMultiDiagramEvidence(repoRoot, {
  analysis = null,
  featureMap = null,
  telemetrySpans = null,
  cacheRoot = null,
  useCache = true,
} = {}) {
  const root = resolve(String(repoRoot || process.cwd()))
  const resolvedAnalysis = analysis ?? await analyzeRepoStatic(root, { cacheRoot, useCache })
  return extractMultiDiagramEvidenceSync(root, {
    analysis: resolvedAnalysis,
    featureMap,
    telemetrySpans,
    cacheRoot,
    useCache,
  })
}
