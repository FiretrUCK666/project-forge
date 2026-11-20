/**
 * doc-slice-graph.mjs —— 总控 PRD 到切片的四项机械检查：认领覆盖、元数据必填、依赖无环、同波次写域不撞。
 *
 * ## 治的病
 *
 * 一份总控 PRD 拆成 N 份切片 SPEC 之后，**只有「每份 SPEC 自己勾完」是有人检查的**。
 * 其余四件事全靠人记：
 *
 * 1. 总控里的 `C1..Cn` 有没有人认领——漏掉的那条不会报错，它只是静静地不存在了；
 * 2. 切片写没写 `scope_files` / `depends_on`——不写也能开工，只是没人知道它会动哪里；
 * 3. 依赖有没有环——有环时「谁先做」没有答案，而两个切片会各自开工然后互相等；
 * 4. 同一波次要并行的切片写域有没有重叠——重叠的后果是两个分支各自绿着，
 *    合到一起才发现动的是同一个文件。
 *
 * 这四件都是**机械可判**的，所以不该留给记性。本模块只回答这四问，不碰文档内容质量。
 *
 * ## 判据从哪来
 *
 * 事实一律现场读文档的 Frontmatter 与正文，不另立一套元数据：`multi_spec`、`criteria`
 * 区块、`scope_files`、`depends_on`、`task_id`、`related_prd` 都是文档里已有的字段。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import { parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { posixPath, readTextSafe } from './git.mjs'

/** 判定为「不参与当前规划」的文档状态。 */
const INERT_STATUS = new Set(['superseded', 'dropped', 'archived'])

/** 已完成的状态：依赖到它们等于依赖已满足。 */
const DONE_STATUS = new Set(['implemented', 'done', 'merged', 'cleaned'])

/** 确定性派生清单：由脚本按源码重新生成，不算「谁改了它」。 */
export const DERIVED_MANIFEST_PATHS = Object.freeze(['.agents/skills/.pf-manifest.json'])

/** 四项检查的稳定错误码。 */
export const SLICE_GRAPH_CODES = Object.freeze({
  uncovered: 'UNCOVERED_ACCEPTANCE_CRITERIA',
  missingMeta: 'SLICE_METADATA_MISSING',
  cycle: 'BLOCKED_SLICE_CYCLE',
  overlap: 'BLOCKED_SLICE_OVERLAP',
})

function readDocAt(repoRoot, abs) {
  const text = readTextSafe(abs)
  if (text === undefined) return null
  const fm = parseDocFrontmatter(text)
  return { abs, rel: posixPath(relative(repoRoot, abs)), text, data: fm.data ?? {} }
}

function listMarkdownSafe(dirAbs) {
  try {
    return readdirSync(dirAbs, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(dirAbs, e.name))
  } catch {
    return []
  }
}

function normalizeStatus(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** `related_prd` / `related_spec` 这类相对链接统一折算成仓内相对路径。 */
function resolveRelLink(fromAbs, raw, repoRoot) {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = raw.trim()
  if (/^(?:无|none|null)$/i.test(t)) return null
  return posixPath(relative(repoRoot, resolve(dirname(fromAbs), t)))
}

/** 数组字段归一化：字符串、单元素、逗号分隔都接受，解析不出来的丢弃。 */
function toStringArray(raw) {
  if (raw === undefined || raw === null) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean)
}

/**
 * 抽总控 PRD 的验收标准编号。
 *
 * 只认 `- [ ] C1: …` 这种条目形状，因为它是模板产出的固定形状。
 * 正文里聊到「C1」不算——按词匹配会误抓注释和引用。
 */
export function extractMasterCriteria(text) {
  return [...new Set([...String(text ?? '').matchAll(/^- \[[ xX]\]\s+(C\d+)\b/gm)].map((m) => m[1]))].sort()
}

/** 一份文档认领了哪些总控编号：正文里出现过即算认领，边界用 `\b` 防止 C1 命中 C10。 */
export function extractClaimedCriteria(text) {
  const ids = new Set()
  for (const m of String(text ?? '').matchAll(/\b(C\d+)\b/g)) ids.add(m[1])
  return [...ids].sort()
}

/**
 * 收集全部规划文档（活跃 + 已归档）。
 *
 * 归档要一起收：Wave 1 的切片已经合并归档，它仍然是「谁认领了 C1」「谁满足了这个依赖」
 * 的合法答案。只看活跃目录会把已完成的切片判成悬空。
 */
export function collectPlanDocs(repoRoot) {
  const dirs = [
    ['docs/prd', 'prd'],
    ['docs/specs', 'spec'],
    ['docs/todo', 'todo'],
    ['docs/archive/prd', 'prd'],
    ['docs/archive/specs', 'spec'],
    ['docs/archive/todo', 'todo'],
  ]
  const out = []
  for (const [dirRel, kind] of dirs) {
    const dirAbs = join(repoRoot, dirRel)
    if (!existsSync(dirAbs)) continue
    for (const abs of listMarkdownSafe(dirAbs)) {
      const doc = readDocAt(repoRoot, abs)
      if (!doc) continue
      doc.kind = kind
      doc.archived = dirRel.includes('/archive/')
      out.push(doc)
    }
  }
  return out
}

/** 切片的唯一标识：优先 Frontmatter `task_id`，否则 Issue 号，最后退文件名 slug。 */
export function sliceKeyOf(doc) {
  const raw = doc?.data?.task_id
  if (typeof raw === 'string' && raw.trim()) return raw.trim()
  const iss = Number(doc?.data?.issue)
  if (Number.isInteger(iss) && iss > 0) return `issue-${iss}`
  const fn = parseDocFilename(doc?.rel ?? '')
  return fn?.slug ?? (basename(String(doc?.rel ?? ''), '.md') || null)
}

/** 把 glob 与目录前缀统一成「它覆盖了哪些路径」的判定器。 */
export function compileScopePattern(pattern) {
  return makePathMatcher(pattern)
}

function makePathMatcher(pattern) {
  const raw = posixPath(String(pattern ?? '')).replace(/^\.\//, '').trim()
  if (!raw) return null
  if (raw.endsWith('/**')) {
    const base = raw.slice(0, -3)
    return { test: (p) => p === base || p.startsWith(`${base}/`), prefix: base, raw }
  }
  if (raw.endsWith('/*')) {
    const base = raw.slice(0, -2)
    return { test: (p) => dirname(p) === base || (p.startsWith(`${base}/`) && !p.slice(base.length + 1).includes('/')), prefix: base, raw }
  }
  if (!raw.includes('*')) {
    // 末尾带斜杠或本身就是个目录前缀：按前缀算。
    const trimmed = raw.replace(/\/+$/, '')
    return { test: (p) => p === trimmed, prefix: trimmed, raw }
  }
  // 其余带 `*` 的写法走通用正则；`**` 跨层，`*` 不跨层。
  const escaped = raw
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0002')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0002/g, '.*')
  const re = new RegExp(`^${escaped}$`)
  return { test: (p) => re.test(p), prefix: null, raw }
}

/**
 * 两个 scope 条目是否可能覆盖同一路径。
 *
 * 判据保守（宁报不放过）：目录前缀与 glob 一律按「可能重叠」算，除非一个有明确前缀、
 * 另一个的所有可能取值都不在它下面。**误报的代价是让人看一眼，漏报的代价是两个并行
 * 分支撞在一起后才被发现**——两者不对称，所以往保守一边倒。
 */
export function scopesOverlap(a, b) {
  if (!a || !b) return false
  if (a.raw === b.raw) return true
  const pa = a.prefix
  const pb = b.prefix
  // 一方是固定路径（无通配）：直接拿它去试另一方的匹配器，判得准又不用猜。
  if (pa && !pb) return b.test(pa) || [...rangeProbe(pa)].some((p) => b.test(p))
  if (!pa && pb) return a.test(pb) || [...rangeProbe(pb)].some((p) => a.test(p))
  if (pa && pb) {
    return pa === pb || pa.startsWith(`${pb}/`) || pb.startsWith(`${pa}/`)
  }
  // 双方都带通配：按字面前缀的包容关系判，这是能保住的**下界**。
  // 更细的形状（`a/*.mjs` 与 `a/deep/x.mjs` 这类单星号不跨层的差异）交给调用方
  // 用真实路径去试，不在前缀上做猜测——猜错了要么漏报、要么天天误报。
  return globPrefixPairOverlaps(a.raw, b.raw)
}

/** 前缀目录下的探针路径：`a` 与 `a/x`、`a/x/y` 足够覆盖常见 glob 形状。 */
function* rangeProbe(prefix) {
  yield prefix
  yield `${prefix}/x`
  yield `${prefix}/x/y.ext`
  yield `${prefix}/x.ext`
}

/** 两个 glob 都无固定前缀时的判定：字面前缀有包容关系即视为可能重叠。 */
function globPrefixPairOverlaps(rawA, rawB) {
  const litPrefix = (s) => s.split(/[*?]/)[0]
  const la = litPrefix(rawA).replace(/\/+$/, '')
  const lb = litPrefix(rawB).replace(/\/+$/, '')
  if (!la || !lb) return true
  return la === lb || la.startsWith(`${lb}/`) || lb.startsWith(`${la}/`)
}

/** 一组 scope 条目里，是否真正声明了东西。 */
function scopeMatchers(scopeFiles) {
  return scopeFiles.map(makePathMatcher).filter(Boolean)
}

/**
 * 构建切片图：一次读完，四项检查共用。
 *
 * 活跃切片 = 未被 `superseded` / `dropped` / `archived` 的 SPEC 与 Todo。
 * 「归属某份 `multi_spec` 总控」= 它的 `related_prd` 指向那份 PRD。
 */
export function buildSliceGraph(repoRoot) {
  const docs = collectPlanDocs(repoRoot)
  const prds = docs.filter((d) => d.kind === 'prd')
  // 只对**活跃**总控判归属：`docs/archive/prd/` 里的是已关账的历史，
  // 那时还没有 `scope_files` / `depends_on` 这套约定，拿今天的判据去判昨天的账，
  // 报出来的每一条都在说「这份历史文件不符合现在的规范」——那不是发现，是噪音。
  const masters = prds.filter((d) => !d.archived
    && d.data?.multi_spec === true
    && !INERT_STATUS.has(normalizeStatus(d.data?.status)))

  const slices = docs
    .filter((d) => d.kind === 'spec' || d.kind === 'todo')
    .filter((d) => !INERT_STATUS.has(normalizeStatus(d.data?.status)))
    .map((d) => ({
      rel: d.rel,
      kind: d.kind,
      archived: d.archived,
      key: sliceKeyOf(d),
      status: normalizeStatus(d.data?.status),
      done: DONE_STATUS.has(normalizeStatus(d.data?.status)),
      masterRel: resolveRelLink(d.abs, d.data?.related_prd, repoRoot),
      scopeFiles: toStringArray(d.data?.scope_files),
      dependsOn: toStringArray(d.data?.depends_on),
      relatedSpec: resolveRelLink(d.abs, d.data?.related_spec, repoRoot),
      data: d.data,
      text: d.text,
    }))

  return { docs, prds, masters, slices }
}

/** 检查一：总控 PRD 的每个 `C*` 都必须被某个子切片认领。 */
export function checkMasterCriteriaCoverage(repoRoot, graph = null) {
  const g = graph ?? buildSliceGraph(repoRoot)
  const out = []
  for (const master of g.masters) {
    const ids = extractMasterCriteria(master.text)
    if (ids.length === 0) continue
    const children = g.slices.filter((s) => s.kind === 'spec' && s.masterRel === master.rel)
    const claimed = new Set(children.flatMap((s) => extractClaimedCriteria(s.text)))
    const missing = ids.filter((id) => !claimed.has(id))
    if (missing.length > 0) {
      out.push({
        code: SLICE_GRAPH_CODES.uncovered,
        file: master.rel,
        missing,
        message: `${master.rel} 里有 ${missing.length} 条验收标准没有任何子切片 SPEC 认领：${missing.join('、')}`
          + '——它们不会进实现也不会进审查，最后以「好像做过」的样子消失',
      })
    }
  }
  return out
}

/**
 * 检查二：归属 `multi_spec` 总控的活跃切片必须声明 `scope_files` 与 `depends_on`。
 *
 * 只对「认领了总控 PRD 的切片」要求，不是全仓一刀切：单份 SPEC 自己就是完整单位，
 * 没有总控要拆，也就没有「谁写哪里」要对齐。全仓一刀切会把还没进入多切片体系的小仓判死。
 *
 * `depends_on` 可以为空数组（表示无前置），但必须**显式写出来**——没写和写了空是两件事：
 * 前者是没人想过依赖，后者是有人想过并确认没有。空数组是合法答案。
 */
export function checkSliceMetadata(graph = null) {
  const g = graph ?? { slices: [], masters: [] }
  const out = []
  for (const s of g.slices) {
    if (!s.masterRel) continue
    if (!g.masters.some((m) => m.rel === s.masterRel)) continue
    const missing = []
    if (s.scopeFiles.length === 0) missing.push('scope_files')
    if (!Object.prototype.hasOwnProperty.call(s.data ?? {}, 'depends_on')) missing.push('depends_on')
    if (missing.length === 0) continue
    out.push({
      code: SLICE_GRAPH_CODES.missingMeta,
      file: s.rel,
      missing,
      message: `${s.rel} 归属 1:N 总控 ${s.masterRel}，但没有声明 ${missing.join(' 与 ')}`
        + '——没有它，波次编排只能按文件名猜哪些切片能并行',
      fixHint: 'scope_files 写本次会动的路径（支持目录前缀与 glob），depends_on 写前置切片 task_id；'
        + '确实没有前置就显式写 depends_on: []，别留空。',
    })
  }
  return out
}

/**
 * 检查三：依赖图判环，并抓悬空依赖。
 *
 * 依赖是否「已满足」由**同一份数据**判：目标切片存在且状态表示完成（`implemented` / `done` 等）。
 * 已合并归档的切片（Wave 1 那类）走这条路径自然满足；真正指向一个从未存在过的
 * `task_id` 才算悬空。这条区分很要紧：按「在活跃目录里找不到就算悬空」判，
 * 每一次合并都会把下游切片判死。
 */
export function checkSliceGraphCycles(repoRoot, graph = null) {
  const g = graph ?? buildSliceGraph(repoRoot)
  const out = []
  const byKey = new Map()
  for (const s of g.slices) {
    if (!s.key) continue
    const prev = byKey.get(s.key)
    // 同 key 的 SPEC 与 Todo 是同一个切片：完成度取并集，只要有一个表示完成就算完成。
    byKey.set(s.key, prev ? { ...prev, done: prev.done || s.done, completed: prev.done || s.done } : { ...s, completed: s.done })
  }

  // 悬空依赖：指向一个谁也没声明过的 key。显式区分于「存在但已完成」。
  for (const [key, node] of byKey) {
    for (const dep of node.dependsOn) {
      const target = byKey.get(dep)
      if (target) continue
      out.push({
        code: SLICE_GRAPH_CODES.cycle,
        file: node.rel,
        dep,
        message: `${node.rel} 依赖 ${dep}，但仓内没有任何 SPEC 或 Todo 声明了 task_id: ${dep}`
          + '——它要么拼错了，要么是还没建的切片',
        fixHint: '核对 task_id 拼写；前置尚未规划就先把它建出来，或者承认这一条依赖不存在。',
        dangling: true,
      })
    }
  }

  // 判环：Kahn 拓扑排序，剩下还有入度的就在环里（或环的下游）。
  const pending = new Set(byKey.keys())
  const indegree = new Map([...byKey.keys()].map((k) => [k, 0]))
  const outEdges = new Map([...byKey.keys()].map((k) => [k, []]))
  for (const [key, node] of byKey) {
    for (const dep of node.dependsOn) {
      if (!byKey.has(dep) || dep === key) continue
      indegree.set(key, (indegree.get(key) ?? 0) + 1)
      outEdges.get(dep).push(key)
    }
  }
  // 自环单独抓：Kahn 会把它算成「有入度」，但报出来的理由说不清。
  for (const [key, node] of byKey) {
    if (node.dependsOn.includes(key)) {
      out.push({
        code: SLICE_GRAPH_CODES.cycle,
        file: node.rel,
        cycle: [key],
        message: `${node.rel} 的 task_id (${key}) 出现在自己的 depends_on 里`,
        fixHint: '切片不能依赖自己，去掉这条。',
      })
    }
  }
  const queue = [...pending].filter((k) => (indegree.get(k) ?? 0) === 0)
  while (queue.length > 0) {
    const cur = queue.shift()
    pending.delete(cur)
    for (const next of outEdges.get(cur) ?? []) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1)
      if ((indegree.get(next) ?? 0) === 0) queue.push(next)
    }
  }
  if (pending.size > 0) {
    const cycleKeys = [...pending].sort()
    out.push({
      code: SLICE_GRAPH_CODES.cycle,
      file: cycleKeys.map((k) => byKey.get(k).rel).join(', '),
      cycle: cycleKeys,
      message: `切片依赖存在环：${cycleKeys.join(' -> ')}——环上每一片都在等另一片先做完，谁也无法开工`,
      fixHint: '找出真正的先后关系拆开环；若两片确实互相需要，把它们合成一片，或先做其中一片的共同前置。',
    })
  }
  return out
}

/**
 * 检查四：同一波次要并行的切片，写域不许相交。
 *
 * 波次怎么算：与 `buildMultiTaskWavePlan` 同一个定义——第 N 波的成员，是「前置都已在
 * 前 N-1 波里排完」的那些切片。同一波次里排除掉串行保守标记的，剩下的会被一起派发，
 * 所以它们的 `scope_files` 必须两两零交叉。
 *
 * ## 只判「还会被派发」的切片
 *
 * 已完成与已归档的切片不进候选集，理由不是省事，而是它们**不会再次被并行派发**：
 * 一个 `implemented` 的切片已经合进主干，两个都做完的切片「写了同一批文件」是既成事实，
 * 不是待处理的冲突。把它们算进来，等于每次合并之后都拿历史账目去判今天的排期——
 * 而且必然红：已合并的切片越多，历史写域交叉越多。
 *
 * 这条过滤同时把「已完成的前置算已满足」也一并解决了：依赖目标不在候选集里，
 * 波次推导就按「已满足」处理，不会把它拉进同一波。
 */
export function checkWaveScopeOverlap(repoRoot, graph = null) {
  const g = graph ?? buildSliceGraph(repoRoot)
  const out = []
  // 只看 SPEC：Todo 与 SPEC 是同一片的两面，拿两边一起比对会自己撞自己。
  const nodes = g.slices
    .filter((s) => s.kind === 'spec' && s.key)
    .filter((s) => g.masters.length === 0 || g.masters.some((m) => m.rel === s.masterRel))
    .filter((s) => !s.done && !s.archived)
  if (nodes.length < 2) return out

  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const waveOf = new Map()
  let wave = 0
  let remaining = new Set(byKey.keys())
  while (remaining.size > 0) {
    // 本波次 = 依赖全都排在更早波次、或压根不在候选集里的那些。
    // 不在候选集 = 已完成 / 已归档 / 从未声明：前两种是已满足，后一种归检查三去报。
    const ready = [...remaining].filter((k) => (byKey.get(k).dependsOn ?? [])
      .every((d) => !byKey.has(d) || waveOf.has(d)))
    if (ready.length === 0) break
    for (const k of ready) {
      waveOf.set(k, wave)
      remaining.delete(k)
    }
    wave += 1
  }
  for (const k of remaining) waveOf.set(k, wave)

  const waveGroups = new Map()
  for (const [k, w] of waveOf) {
    if (!waveGroups.has(w)) waveGroups.set(w, [])
    waveGroups.get(w).push(k)
  }
  for (const [w, keys] of [...waveGroups].sort((a, b) => a[0] - b[0])) {
    if (keys.length < 2) continue
    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        const a = byKey.get(keys[i])
        const b = byKey.get(keys[j])
        const ma = scopeMatchers(a.scopeFiles)
        const mb = scopeMatchers(b.scopeFiles)
        const hits = []
        for (const x of ma) {
          for (const y of mb) {
            if (scopesOverlap(x, y)) hits.push([x.raw, y.raw])
          }
        }
        // 派生清单由脚本重新生成，谁「改了它」没有意义，不算碰撞。
        const effective = hits.filter(([x, y]) => !DERIVED_MANIFEST_PATHS.some((d) => x === d || y === d))
        if (effective.length === 0) continue
        out.push({
          code: SLICE_GRAPH_CODES.overlap,
          file: `${a.rel} vs ${b.rel}`,
          wave: w,
          overlaps: effective,
          message: `Wave ${w} 的 ${a.key} 与 ${b.key} 写域相交：`
            + effective.map(([x, y]) => `${x} <-> ${y}`).join('；'),
          fixHint: '并行切片必须零交叉。要么把它们排成先后波次（加 depends_on），要么把重叠的路径划给其中一片。',
        })
      }
    }
  }
  return out
}

/**
 * 四项检查一把跑完。
 *
 * 返回结构里 `errors` 与 `warnings` 分开：前三条是硬错（漏认领、缺元数据、有环），
 * 第四条同波次碰撞同样是硬错——两个并行分支撞在一起是真实事故，不是提醒。
 */
export function evaluateSliceGraph(repoRoot, { graph = null } = {}) {
  if (!repoRoot) return { ok: true, errors: [], warnings: [], checked: 0 }
  const g = graph ?? buildSliceGraph(repoRoot)
  const errors = [
    ...checkMasterCriteriaCoverage(repoRoot, g),
    ...checkSliceMetadata(g),
    ...checkSliceGraphCycles(repoRoot, g),
    ...checkWaveScopeOverlap(repoRoot, g),
  ]
  return { ok: errors.length === 0, errors, warnings: [], checked: g.slices.length, masters: g.masters.map((m) => m.rel) }
}
