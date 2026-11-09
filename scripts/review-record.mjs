#!/usr/bin/env node
/**
 * review-record.mjs —— 高风险路径的改动，必须有可核对的审查记录。
 *
 * ## 它治的是什么病
 *
 * 「必须独立审查」这条规则写在契约里，但它长期只是**自觉**：改完、跑一遍门禁全绿、
 * 看着没问题，就合了。而「看着没问题」正是自审的产物——同一个上下文里再读一遍，
 * 读出的必然是「刚才那套没问题」。
 *
 * 所以这里给出一条**机器判据**，它回答三个问题：
 *
 *   1. 这次改动动没动这个项目的高风险路径？（不需要时直接放行）
 *   2. 验收标准开工前冻结过吗？在哪儿？
 *   3. 每一轮审查说的是「哪几条标准没过」，最后一条标准过了没有？
 *
 * ## 为什么结论是算出来的，不是审查者写的
 *
 * 早期版本让审查者写一句结论，机器去读那句话里「通过」是肯定还是否定。这条路走不通：
 * 中文里否定的写法列不完（不通过 / 通不过 / 通过不了 / 尚未通过 …），每漏一种，
 * 方向都是**放行**。写过词表、否定前缀、段落边界、时间回指，每修一轮下一轮又找出一种。
 *
 * 那不是判据写得不够仔细，是**让机器读散文这个决定本身**。
 *
 * 现在的输入形状是字段：审查者只回答「哪几条标准没过」。结论由 `deriveOutcome` 算，
 * 「通过」这个词根本不进机器的输入。
 *
 * ## 它能证明什么、不能证明什么
 *
 * 能证明：有一轮审查发生过、它引用的标准是冻结过的那些、最后的结论与记录一致。
 * 不能证明：审查的人真的读了代码。**判据不能假装能判它判不了的东西**——那会让一条真
 * 检查被读成一条假保证。
 *
 * 一处例外值得说明：判「通过」时必须交 `inject:`（故障注入记录）。它同样不能证明
 * 那件事真的做过，但它把「通过」的成本从「写一句话」抬到「跑一遍并描述结果」。
 * 这是这个文件里唯一一处**用成本代替证明**的设计，写清楚比含糊过去有用。
 *
 * ## 高风险路径从哪儿来
 *
 * **不写在这份代码里**，从这个项目自己的 `AGENTS.md` 读（里面有一张「## 高风险路径」表）。
 * 哪几处改了会让门禁从此少查一项，因项目而异；写死在工具里换个项目就判错，而判错的
 * 症状不是报错，是**该拦的没拦**。
 *
 * 读不到那张表时**不静默放行**：报一行说明「这一趟没做检查」，退出码仍是 0——
 * 不能因为项目还没填表就卡死构建，但必须说清这一趟什么也没拦。
 *
 * ## 用法
 *
 *   node scripts/review-record.mjs --changed <改动清单|-> --body <提案正文文件|->
 *        --comments <评论文件> [--root <项目目录>] [--expect-changes]
 *
 * 退出码：0 = 通过（或本次改动不含高风险路径）；1 = 审查记录不成立；2 = 用法错误。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 这个模块是被直接跑起来的，还是被 import 的？
 *
 * 判据按**真实路径**比较：经 junction / 符号链接调用也算直接执行。字面比较在那种情况下
 * 会静默空跑并返回 0——那是自检假绿。这里复制一份而不是 import `lib/text.mjs`，
 * 是为了让本文件**零依赖、单文件**（它要整个复制进目标项目，那里没有 `lib/`）。
 */
function isMainModule(metaUrl, argv1) {
  if (typeof argv1 !== 'string' || argv1 === '') return false
  const target = fileURLToPath(metaUrl)
  try {
    if (resolve(argv1) === resolve(target)) return true
  } catch { /* 路径非法就走真实路径比较 */ }
  const real = (p) => {
    try { return realpathSync.native(p) } catch { return undefined }
  }
  const a = real(argv1)
  const b = real(target)
  return a !== undefined && b !== undefined && a === b
}

// ── 机器契约（格式的唯一来源） ─────────────────────────────────────
//
// 这一段**就是**格式的定义：解析、生成、示例全在同一个文件里。
// 它是零依赖单文件、要整个复制进目标项目，所以格式不能放别处——放别处就是两个来源。
//
// 治的病：早先版本让审查者写一句结论，机器去读那句话里「通过」是肯定还是否定。
// 中文里否定的写法列不完（不通过 / 通不过 / 通过不了 / 尚未通过 …），每漏一种，
// 方向都是**放行**。写过词表、否定前缀、段落边界、时间回指，每修一轮下一轮又找出一种。
//
// 那不是判据写得不够仔细，是**让机器读散文这个决定本身**。
//
// 现在的输入是字段：审查者只回答「哪几条标准没过」，结论由 `deriveOutcome` 算。
// 「通过」这个词根本不进机器的输入，所以整类问题不存在。

/** 冻结验收标准用的围栏语言。 */
export const DONE_FENCE = 'pf-done'

/** 审查结论用的围栏语言。 */
export const REVIEW_FENCE = 'pf-review'

/**
 * 审查块的字段。顺序就是示例里的顺序。
 *
 * - `round`    第几轮，正整数。同一轮只能有一个 `fail` 集合。
 * - `fail`     哪些冻结标准没过（逗号分隔的 id）。空 = 全过。
 * - `inject`   故障注入记录。**判通过时必填**——它逼审核者真的跑一遍。
 * - `escalate` 这条标准本身有问题，停自动返工交人。
 *
 * **没有 `verdict`，这是刻意的**：结论是算出来的，不是声明的。
 */
export const REVIEW_FIELDS = Object.freeze(['round', 'fail', 'inject', 'escalate'])

/** 参数默认值。项目可以在契约的「## 协作参数」表里覆盖。 */
export const DEFAULT_PARAMS = Object.freeze({ rework_cap: 2, waiver_label: 'pf:human-approved' })

/**
 * 生成「冻结验收标准」的示例。
 *
 * **文档里那几行必须是这段输出。** `preflight.mjs` 会拿它去每一处逐字比对——
 * 改字段时不同步就红，而报出的原因是「示例与实现不符」，一条精确判据，
 * 不是关键词匹配（后者修几轮都还能绕过去）。
 */
export function canonicalDoneSnippet() {
  return [
    '```' + DONE_FENCE,
    'C1: 第一条可判定的验收标准（一条命令或一条断言能证明它）',
    'C2: 第二条',
    '```',
  ].join('\n')
}

/**
 * 生成「审查结论」的示例。`round` 可改，用于演示返工后的第二轮。
 *
 * **只输出必填字段，且每一行照抄都合法**——可选字段（`escalate`）不进示例。
 * 理由很具体：示例里留一行 `escalate: （没有就删掉）`，照抄的人就填了值，
 * 而 `escalate` 有值的含义是「停自动返工、交人」。让人踩坑的示例比没有示例更坏。
 */
export function canonicalReviewSnippet(round = 1) {
  const r = Number.isFinite(Number(round)) ? String(Math.max(1, Number(round))) : '1'
  return [
    '```' + REVIEW_FENCE,
    `round: ${r}`,
    'fail: C2',
    'inject: 删掉某处兜底分支 → 3 个用例变红 → 还原全绿',
    '```',
  ].join('\n')
}

/** 生成「全部标准都过了」的示例：`fail` 留空，`inject` 仍然要给。 */
export function canonicalReviewPassSnippet(round = 1) {
  const r = Number.isFinite(Number(round)) ? String(Math.max(1, Number(round))) : '1'
  return [
    '```' + REVIEW_FENCE,
    `round: ${r}`,
    'fail:',
    'inject: 删掉某处兜底分支 → 3 个用例变红 → 还原全绿',
    '```',
  ].join('\n')
}

/**
 * 机器契约必须**逐字出现**的落点。
 *
 * 分母是「谁会照着它写」，不是「谁提到了它」：判据给人读、两份模板给人抄、
 * `templates/agents-project.md` 给目标项目的 AI 读——四处都必须拿到同一份字面，
 * 否则照着抄的人会写出一份机器读不到的东西。
 */
export const CONTRACT_SITES = Object.freeze([
  'references/collaboration.md',
  'templates/pull-request-template.md',
  '.github/pull_request_template.md',
  'templates/agents-project.md',
])

// ── 契约：高风险路径与参数 ─────────────────────────────────────────

/**
 * 把 `git diff --name-only` 的一条输出还原成真实路径。
 *
 * 默认配置下 git 会对含非 ASCII 字符的路径做 C 风格转义并加双引号：
 * `"templates/\345\256\241..."`。直接拿它去比前缀，中文名的风险改动会被判成
 * 非高风险——门禁绿着放行，而使用者完全看不出为什么。这个仓库本身就是中文文档项目。
 *
 * 两种输入都要能吃：真被转义的就解回来，没转义的原样返回。
 * 不做「让调用方记得加 `core.quotepath=false`」那种约定：那是一条要人记住的规矩，
 * 而漏记的症状正是静默放行。
 */
export function unquoteGitPath(raw) {
  const s = String(raw ?? '').trim()
  if (!(s.startsWith('"') && s.endsWith('"')) || s.length < 2) return s
  const inner = s.slice(1, -1)
  const bytes = []
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i]
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
    const next = inner[i + 1]
    if (next === undefined) break
    const octal = /^[0-7]{3}/.exec(inner.slice(i + 1))
    if (octal !== null) { bytes.push(parseInt(octal[0], 8)); i += 3; continue }
    const map = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
    if (map[next] !== undefined) { bytes.push(map[next]); i += 1; continue }
    bytes.push(...Buffer.from(next, 'utf8'))
    i += 1
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * 把表里那一格归一成**两种规范形态之一**：目录以 `/` 结尾，文件不以 `/` 结尾。
 *
 * **归一化只能有一处。** 实测过的病：把 `| AGENTS.md |` 改成 `| AGENTS.md/ |`——
 * 一个字符——别处做了 `replace(/\/$/, '')` 于是通过，而按前缀比
 * `'AGENTS.md'.startsWith('AGENTS.md/')` 为假，那份文件就不再算高风险。
 * 两处归一化迟早给出两个答案。
 *
 * **尾斜杠不决定这一格是文件还是目录**——它是书写习惯。可光看名字也分不出来：
 * `.github` 是目录、`.gitattributes` 是文件，名字都以点开头，长得一模一样。
 *
 * 所以归一只做**能确定的那一半**：去掉多余的尾斜杠、`./`、反斜杠，**保留「写过尾斜杠」
 * 这个事实**。判前缀时两种都认——见 `isHighRiskPath`。
 *
 * 返回 `{ path, dir }`：`path` 是去掉尾斜杠的规范形式，`dir` 是「原样带过尾斜杠」。
 */
export function normalizeEntry(raw) {
  let v = String(raw ?? '').replace(/\\/g, '/').trim()
  v = v.replace(/^\.\//, '')
  if (v === '' || v.startsWith('<') || v.startsWith('/') || /^[A-Za-z]:/.test(v)) return undefined
  const seg = v.split('/').filter((s) => s !== '').pop() ?? ''
  if (seg === '' || seg === '.' || seg === '..') return undefined
  return { path: v.replace(/\/+$/, ''), dir: v.endsWith('/') }
}

/** 占位词。表里出现它们，含义是「还没填」，不是「认不出来」。 */
const PLACEHOLDER_WORD = /^(?:tbd|todo|fixme|xxx+|待定|待填|以后再填|稍后补|占位|这里填|未定|—|-|无)$/i

const looksPlaceholder = (c) => {
  const v = String(c ?? '').trim()
  return v === '' || v.startsWith('<') || v.endsWith('>') || PLACEHOLDER_WORD.test(v)
}

/**
 * 读契约里那张「## 高风险路径」表，同时把「读出来什么、跳过了什么」一起给出来。
 *
 * 三种最常见的手写形状都要认：
 *   - 目录不带尾斜杠（`src/rules`）→ 补成前缀形式。漏一个斜杠会让这条判据对整棵树失效，
 *     症状完全不可见。
 *   - 格子里带说明（`` `src/rules/` 下的判定 ``）→ 取反引号里的，或第一个像路径的 token。
 *   - 一行写两个（`` `a/`、`b/` ``）→ 全都收。
 *
 * `skipped` 收的是「看起来像表行、但一个路径都没解析出来」的那些行。调用方要把它们
 * 报出来：**认不出来不等于没有**，静默跳过正是「表填了但门禁永不触发」那个 bug 的形状。
 */
export function readHighRiskTable(agentsText) {
  const text = String(agentsText ?? '')
  const head = /^##+[ \t]*高风险路径[ \t]*$/m.exec(text)
  if (head === null) return { paths: [], skipped: [], found: false, whyFilled: true, state: 'noTable', placeholders: 0 }
  const after = text.slice(head.index + head[0].length)
  const nextHead = /^##+[ \t]/m.exec(after)
  const block = nextHead === null ? after : after.slice(0, nextHead.index)
  const out = []
  const skipped = []
  let whyFilled = true
  let placeholders = 0
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(trimmed) && trimmed.includes('-')) continue
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim())
    const first = cells[0] ?? ''
    if (first === '' || /^路径$/.test(first)) continue

    const candidates = []
    // 反引号包着的路径优先——那是人明确标出来的「这一格是路径」。
    // **但一整对反引号里可以放两个路径**（`` `a/,b/` ``），那种要按分隔符再拆一次，
    // 否则整格会被当成一个不存在的路径，两处都静默失效。
    for (const m of first.matchAll(/`([^`]+)`/g)) {
      const inner = m[1].trim()
      // **整格是占位就整格跳过，不拆。**骨架里的占位带空格
      // （`<改判定 / 改检查逻辑的那几个目录>/`），按空格拆会得到「改检查逻辑的那几个目录>」
      // 这样一条真路径，于是「还没填表」的新项目看起来在保护一堆不存在的路径。
      if (inner.startsWith('<') || inner.endsWith('>')) { candidates.push(inner); continue }
      for (const part of inner.split(/[\s,，、]+/)) if (part !== '') candidates.push(part)
    }
    if (candidates.length === 0) {
      for (const tok of first.split(/[\s,，、]+/)) {
        if (tok === '' || tok.startsWith('<')) continue
        if (/^[/\w.@-]/.test(tok)) { candidates.push(tok); break }
      }
    }

    // 「为什么」那一格：非空、不是占位符。理由空白的一行等于只有路径没有依据。
    const why = (cells[1] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()
    if (why === '' || why.startsWith('<')) whyFilled = false

    // **逐个候选判占位，不判整行。**判整行会漏两种实测过的写法：
    // 混写（`| `scripts/` 与 `<另一处>/` |`，占位被静默吞掉）、英文占位（`| TBD | 待定 |`）。
    const placeholdersInRow = candidates.filter(looksPlaceholder).length
    if (placeholdersInRow > 0) placeholders += placeholdersInRow

    let took = 0
    for (const raw of candidates) {
      if (looksPlaceholder(raw)) continue
      const spec = normalizeEntry(raw)
      if (spec === undefined) continue
      out.push(spec.path)
      took += 1
    }
    if (took === 0 && placeholdersInRow === 0) skipped.push(trimmed)
  }
  // 三态：notFilled（有表但一条真路径都没有）/ partialFill（有真路径也有占位）/ filled。
  const state = out.length === 0 ? 'notFilled' : (placeholders > 0 ? 'partialFill' : 'filled')
  return { paths: [...new Set(out)], skipped, found: true, whyFilled, state, placeholders }
}

/** 只要路径时的便捷入口。 */
export function readHighRiskPaths(agentsText) {
  return readHighRiskTable(agentsText).paths
}

/**
 * 一个改动路径算不算落在高风险表里。
 *
 * 匹配认两种：整段相等（文件），或以 `path/` 开头（目录）。**两种都认**，因为
 * 「这一格是文件还是目录」在名字上看不出来。多认一种写法的代价是可能多要求一次审查；
 * 少认一种的代价是**静默失效**——前者可接受，后者正是这一整类问题的根。
 */
export function isHighRiskPath(rel, prefixes) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  for (const pre of prefixes ?? []) {
    const base = String(pre).replace(/\/+$/, '')
    if (base === '') continue
    if (p === base || p.startsWith(`${base}/`)) return true
  }
  return false
}

/** 从一份改动清单里挑出高风险的那几条（去重、排序，报告里好读）。 */
export function highRiskChanged(paths, prefixes) {
  return [...new Set(paths.map((x) => unquoteGitPath(x)).filter(Boolean)
    .filter((p) => isHighRiskPath(p, prefixes)))].sort()
}

/**
 * 读契约里的「## 协作参数」表。
 *
 * 判据与高风险路径表同源：**这些是项目的决定，不是工具的决定**。返工上限、豁免标签名
 * 写死在代码里，换一个项目就判错，而判错的症状是「该停的没停」或「不该停的停了」。
 *
 * 读不到就用默认值——这一条与高风险路径不同：缺那张表意味着**没配门禁**（要说出来），
 * 缺这张表只意味着用默认值，不影响判定成立。
 */
export function readProtocolParams(agentsText, defaults) {
  const fallback = { ...(defaults ?? {}) }
  const text = String(agentsText ?? '')
  const head = /^##+[ \t]*协作参数[ \t]*$/m.exec(text)
  if (head === null) return fallback
  const after = text.slice(head.index + head[0].length)
  const nextHead = /^##+[ \t]/m.exec(after)
  const block = nextHead === null ? after : after.slice(0, nextHead.index)
  const out = { ...fallback }
  for (const line of block.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(t) && t.includes('-')) continue
    const cells = t.split('|').slice(1, -1).map((c) => c.trim())
    const key = (cells[0] ?? '').replace(/`/g, '').replace(/<!--[\s\S]*?-->/g, '').trim()
    const raw = (cells[1] ?? '').replace(/`/g, '').replace(/<!--[\s\S]*?-->/g, '').trim()
    if (key === '' || raw === '' || /^参数$/.test(key) || looksPlaceholder(raw)) continue
    if (key === 'rework_cap') {
      const n = Number(raw)
      if (Number.isInteger(n) && n >= 0) out.rework_cap = n
    } else if (key === 'waiver_label') {
      out.waiver_label = raw
    }
  }
  return out
}

// ── 剥注释 ─────────────────────────────────────────────────────────

/** 去掉成对的 HTML 注释后的正文：注释里写着「怎么填」，那是模板不是记录。 */
function stripComments(text) {
  let out = ''
  let i = 0
  const s = String(text ?? '')
  while (i < s.length) {
    const start = s.indexOf('<!--', i)
    if (start < 0) { out += s.slice(i); break }
    out += s.slice(i, start)
    const end = s.indexOf('-->', start + 4)
    if (end < 0) break
    i = end + 3
  }
  return out
}

/**
 * 剥掉 HTML 注释，**未闭合的那个也剥**。
 *
 * 与 `stripComments` 的区别只在最后一种情况：遇到没有 `-->` 收尾的 `<!--` 时，
 * 它后面整段都算注释——把块写在那里面不该被当成结论。
 * 实测：`<!-- 下面是模板` + 一个合法块、不写 `-->`，原先仍命中（方向是放行）。
 */
function stripCommentsLoose(text) {
  const s = String(text ?? '')
  let out = ''
  let i = 0
  while (i < s.length) {
    const start = s.indexOf('<!--', i)
    if (start < 0) { out += s.slice(i); break }
    out += s.slice(i, start)
    const end = s.indexOf('-->', start + 4)
    if (end < 0) break
    i = end + 3
  }
  return out
}

// ── 字段块解析 ─────────────────────────────────────────────────────

const FENCES = Object.freeze({ done: DONE_FENCE, review: REVIEW_FENCE })

/**
 * 从一段文字里抠出所有指定围栏的字段块。
 *
 * 返回 `{ blocks, broken }`。字段不合法（缺 key、值不合法）**整个块作废**并计入 `broken`——
 * 半对的块比没有更坏：它看起来像一条记录。
 *
 * **围栏只在行首（允许前导空格）才算。** 被 `>` 引用的是引用别人的东西，不是本评论的
 * 结论；把它当块解析会让整条提案判红。
 */
export function fieldBlocks(text, fence) {
  const s = String(text ?? '')
  const out = []
  const broken = []
  const re = new RegExp('(?:^|\\n)[ \\t]*```' + fence + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g')
  for (const m of s.matchAll(re)) {
    const fields = new Map()
    let lineOk = true
    for (const line of m[1].split(/\r?\n/)) {
      const t = line.trim()
      if (t === '') continue
      // `fail:` 允许空值（含义是「全过」），所以值的部分可以什么都没有。
      const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*[:：][ \t]*(.*)$/.exec(t)
      if (kv === null) {
        broken.push({ raw: m[0], why: `这一行不是「键: 值」：${t}` })
        lineOk = false
        continue
      }
      const k = kv[1].toLowerCase()
      if (fields.has(k)) {
        broken.push({ raw: m[0], why: `字段 ${k} 出现了两次` })
        lineOk = false
        continue
      }
      fields.set(k, kv[2].trim())
    }
    if (lineOk) out.push({ raw: m[0], fields })
  }
  return { blocks: out, broken }
}

/**
 * 读工作记录里冻结的验收标准。
 *
 * 返回 `{ ids: Map<id, 描述>, broken, found }`。`found` 为假表示没有这个块（＝动手前
 * 没冻结标准）；`broken` 非空表示有块但读不出来。
 *
 * **id 大小写不敏感**用于查找，但原样保留给人看——手写 `c1` 与 `C1` 是同一个。
 */
export function readDoneBlock(text) {
  const visible = stripCommentsLoose(text)
  const { blocks, broken } = fieldBlocks(visible, FENCES.done)
  const ids = new Map()
  const bad = [...broken]
  for (const b of blocks) {
    let any = 0
    for (const [k, v] of b.fields) {
      // `C1: 描述` —— 键是 id，值是那条标准。id 必须像 id，不能是 `round` 那种字段名。
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(k)) {
        bad.push({ raw: b.raw, why: `标准 id「${k}」不像 id（字母开头的短标识）` })
        continue
      }
      if (v === '') {
        bad.push({ raw: b.raw, why: `标准 ${k} 没有写内容` })
        continue
      }
      ids.set(k.toUpperCase(), { id: k, text: v })
      any += 1
    }
    if (any === 0) bad.push({ raw: b.raw, why: '这个块里一条标准都没有' })
  }
  return { ids, broken: bad, found: blocks.length > 0 }
}

/** 把 `fail:` 那一行拆成 id 数组。空值返回空数组。 */
function splitIds(raw) {
  return String(raw ?? '')
    .split(/[,，、\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== '')
}

/**
 * 读所有评论里的审查块，按轮次聚合并校验格式。
 *
 * 返回 `{ rounds: [{round, fail[], inject, escalate, sample}], broken[] }`。
 *
 * **同一轮只允许一个说法。** 两个不同的 `fail` 集合并存时，机器无法判断哪个作废——
 * 「取更严」会误伤复述，「取最后一个」会误伤订正。唯一不猜的读法是：**不一致就报错**，
 * 要求把旧的那条评论删掉或编辑掉。这与「一条评论内不许有两个结论」是同一条规则。
 */
export function readReviews(comments) {
  const list = Array.isArray(comments) ? comments : []
  const byRound = new Map()
  const broken = []
  for (const c of list) {
    const text = typeof c === 'string' ? c : String(c?.body ?? '')
    const visible = stripCommentsLoose(text)
    const { blocks, broken: b } = fieldBlocks(visible, FENCES.review)
    for (const item of b) broken.push({ ...item, sample: text.trim().slice(0, 120).replace(/\s+/g, ' ') })
    for (const blk of blocks) {
      const sample = text.trim().slice(0, 120).replace(/\s+/g, ' ')
      const rawRound = blk.fields.get('round')
      if (rawRound === undefined || !/^\d+$/.test(rawRound)) {
        broken.push({ raw: blk.raw, why: 'round 缺失或不是数字（要从 1 起）', sample })
        continue
      }
      const round = String(Number(rawRound))
      const failRaw = blk.fields.get('fail')
      const inject = (blk.fields.get('inject') ?? '').trim()
      const escalate = (blk.fields.get('escalate') ?? '').trim()
      const item = { round, fail: splitIds(failRaw), inject, escalate, sample }
      const prev = byRound.get(round)
      if (prev === undefined) { byRound.set(round, item); continue }
      const same = prev.fail.slice().sort().join(',') === item.fail.slice().sort().join(',')
      if (!same) {
        broken.push({
          raw: blk.raw,
          why: `第 ${round} 轮出现了两个不同的 fail 集合（${prev.sample} / ${sample}）——`
            + '同一轮只能有一个结论；要改口就删掉或编辑旧的那条评论',
          sample,
        })
      }
    }
  }
  const rounds = [...byRound.values()].sort((a, b2) => Number(a.round) - Number(b2.round))
  return { rounds, broken }
}

/**
 * 结论的**唯一**派生处。
 *
 * 输入冻结清单、所有审查轮次、参数与豁免状态；输出 `{ pass, why, stopLoss, latest }`。
 * 审查者不写结论，所以这里没有「读结论」这一步——它算。
 *
 * 判据顺序有讲究：先判「能不能判」（格式、未知 id、缺故障注入），再判结论，最后判止损。
 * 顺序反了会出现「止损被误报成格式错」这类混淆。
 *
 * @param {object} p
 * @param {Map<string,{id:string,text:string}>} p.done  冻结的验收标准
 * @param {Array} p.rounds                              所有轮次（按 round 升序）
 * @param {number} p.reworkCap                          返工上限
 * @param {boolean} p.waived                            是否带了豁免标签
 */
export function deriveOutcome({ done, rounds, reworkCap, waived }) {
  const ids = done instanceof Map ? done : new Map()
  const list = Array.isArray(rounds) ? rounds : []
  if (list.length === 0) {
    return { pass: false, why: '没有任何一轮审查记录 —— 高风险路径的改动必须有一轮独立审查', stopLoss: null, latest: null }
  }

  // 一、格式：引用的 id 必须真的存在。**审查不能发明标准。**
  // 要加标准就回工作记录里去加——那是一个需要说明的动作，不是顺手一提。
  const unknown = []
  for (const r of list) {
    for (const id of r.fail) {
      if (!ids.has(String(id).toUpperCase())) unknown.push({ round: r.round, id })
    }
  }
  if (unknown.length > 0) {
    const names = unknown.map((u) => `第 ${u.round} 轮的「${u.id}」`).join('、')
    return {
      pass: false,
      why: `审查引用了冻结清单里没有的标准：${names} —— `
        + '审查不能发明标准。要加标准，先回工作记录的「验收标准」一节把它冻结进去，'
        + '那是一个需要说明的动作',
      stopLoss: null,
      latest: list[list.length - 1],
    }
  }

  const latest = list[list.length - 1]

  // 二、交人：审查者说「这条标准本身有问题」时，自动循环到此为止。
  if (latest.escalate !== '') {
    return { pass: false, why: `第 ${latest.round} 轮要求交人裁决：${latest.escalate}`, stopLoss: null, latest }
  }

  // 三、「通过」要交故障注入记录。
  //
  // 它证明不了那件事真的做过，但它把「通过」的成本从写一句话抬到跑一遍并描述结果。
  // 这是全文唯一一处用成本代替证明的地方——写清楚比含糊过去有用。
  if (latest.fail.length === 0 && latest.inject === '') {
    return {
      pass: false,
      why: `第 ${latest.round} 轮说全部标准都过了，但没有交故障注入记录 —— `
        + '判「通过」时要写 inject: 注入了什么、哪几个用例变红、还原后是否全绿。'
        + '纯文档改动确实没有可注入的代码时，也要写一句理由，空着不行',
      stopLoss: null,
      latest,
    }
  }

  // 四、止损之一：同一条标准连续两轮没过。
  //
  // 它是**局部**的——只掐住卡住的那一条，不会把整体顺利、只有一处磨的提案整体叫停。
  // 而它抓的正是「再找一个新问题永远找得到」那个病：修了两轮还不过，是方向错了的硬信号。
  //
  // **豁免只免止损，不免「还有标准没过」。**理由是两者的性质不同：止损说的是
  // 「这样下去不会收敛」，人可以说「我知道，继续」；而「C2 没过」是一个事实，
  // 认了风险也不改变它还没过。把豁免放开到结论上，等于给「豁免=可以不合」开后门。
  if (!waived) {
    const repeat = []
    for (let i = 1; i < list.length; i += 1) {
      const prev = new Set(list[i - 1].fail.map((x) => String(x).toUpperCase()))
      for (const id of list[i].fail) {
        if (prev.has(String(id).toUpperCase())) repeat.push({ id, from: list[i - 1].round, to: list[i].round })
      }
    }
    if (repeat.length > 0) {
      const desc = repeat.map((r) => `「${r.id}」在第 ${r.from} 与第 ${r.to} 轮都没过`).join('、')
      return {
        pass: false,
        why: `${desc} —— 同一条标准连续两轮没过，说明方向错了，不是「再修一轮就好」。`
          + '停下把卡点写进工作记录的断点，升级给能拍板的人；'
          + '确有理由继续时由维护者加豁免标签',
        stopLoss: 'repeat',
        latest,
      }
    }
  }

  // 五、止损之二：自动返工到顶。同样可被豁免——它说的是「轮次太多」，
  // 而不是「某条标准没过」，前者是可以由人承担的判断。
  if (!waived && Number.isFinite(reworkCap) && list.length > reworkCap) {
    return {
      pass: false,
      why: `已经审了 ${list.length} 轮，超过自动返工上限 ${reworkCap} 轮 —— `
        + '循环到此为止，交人裁决。确有理由继续时由维护者加豁免标签',
      stopLoss: 'cap',
      latest,
    }
  }
  // 豁免过之后记一笔：报告要说清「这是被豁免过的」，否则事后看记录会以为门禁松了。
  const waiverNote = waived ? '（止损已由维护者豁免）' : ''

  // 六、结论。
  if (latest.fail.length > 0) {
    return {
      pass: false,
      why: `第 ${latest.round} 轮还有 ${latest.fail.length} 条标准没过：${latest.fail.join('、')}`
        + ' —— 这一条豁免不了：「豁免」认的是风险，不是「某条标准没过」这个事实',
      stopLoss: null,
      latest,
    }
  }
  return {
    pass: true,
    why: `第 ${latest.round} 轮全部标准通过，并交了故障注入记录${waiverNote}`,
    stopLoss: null,
    latest,
  }
}

// ── 提案正文里的那几行 ─────────────────────────────────────────────

/**
 * 读提案正文里的工作记录指针：`工作记录: docs/work/2026-11-09-xxx.md`。
 *
 * **为什么不做目录猜测**（去 `docs/work` / `docs/tasks` / `todo` 里找）：那是把某个项目的
 * 目录约定写进工具，换一个项目就判错。指针写在提案上，项目怎么组织都行。
 *
 * 返回 `{ path, raw }`；没有就 `path: undefined`。
 */
export function readWorkRecordPointer(body) {
  const visible = stripComments(String(body ?? ''))
  for (const line of visible.split(/\r?\n/)) {
    const t = line.replace(/^[\s>*+-]+/, '').trim()
    const m = /^工作记录\s*[:：]\s*(.+)$/.exec(t)
    if (m === null) continue
    const raw = m[1].trim()
    const p = (raw.match(/`([^`]+)`/) ?? [])[1] ?? raw
    return { path: p.trim(), raw }
  }
  return { path: undefined, raw: '' }
}

/**
 * 读提案正文的「## 实现依据」一栏，判它是不是一句空话。
 *
 * **判不了质量，但能判「压根没写」**。占位词那几种是最常见的糊弄法，而它们
 * 共同的特征是「读者读完不知道改动凭什么成立」。
 */
export function readBasis(body) {
  const visible = stripComments(String(body ?? ''))
  const head = /^##+[ \t]*实现依据[ \t]*$/m.exec(visible)
  if (head === null) return { ok: false, why: '提案正文里没有「## 实现依据」这一栏' }
  const after = visible.slice(head.index + head[0].length)
  const next = /^##+[ \t]/m.exec(after)
  const block = (next === null ? after : after.slice(0, next.index)).trim()
  if (block === '') return { ok: false, why: '「## 实现依据」是空的' }
  const flat = block.replace(/\s+/g, '')
  const hollow = [/^按issue实现$/, /^按需求实现$/, /^见issue$/, /^见需求$/, /^tbd$/i, /^todo$/i, /^无$/, /^同上$/, /^略$/]
  if (hollow.some((re) => re.test(flat))) {
    return { ok: false, why: `「## 实现依据」只写了「${block}」—— 这类说明读者读完不知道改动凭什么成立` }
  }
  return { ok: true, text: block }
}

/**
 * 提案关联了哪个问题？`Fixes #12` / `Closes #12` / `Resolves #12`。
 *
 * **这是两条轨道的分辨依据**：有单轨道要多做三件事（分流结论、验收标准来自 issue、
 * 打回时两边都留言），日常轨道不受牵连。判据是平台原生事实，不需要谁声明自己走哪条。
 */
export function readClosingIssue(body) {
  const visible = stripComments(String(body ?? ''))
  const m = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s*:?\s*#(\d+)\b/i.exec(visible)
  return m === null ? undefined : m[1]
}

// ── 命令行 ─────────────────────────────────────────────────────────

function usage() {
  return [
    '用法：node scripts/review-record.mjs --changed <清单文件|-> --body <提案正文|->',
    '         --comments <评论文件> [--root <项目目录>] [--expect-changes]',
    '',
    '  改动落在**高风险路径**时，这份提案必须满足三件事：',
    '    1. 工作记录里冻结了验收标准（pf-done 块），且指针写在提案正文里；',
    '    2. 至少有一轮独立审查（评论里的 pf-review 块），引用的是冻结清单里的标准；',
    '    3. 最后一轮全部标准通过，并且交了故障注入记录。',
    '',
    '  高风险路径不写死在代码里，从 `<项目>/AGENTS.md` 的「## 高风险路径」表读。',
    '  返工上限与豁免标签从同一份文件的「## 协作参数」表读。',
    '',
    '  --changed         每行一个改动路径的文件；`-` 表示从 stdin 读',
    '  --body            提案正文（Markdown 文件，或 `-`）',
    '  --comments        **必须给**：平台上那些评论的正文（每条之间用一行 ---COMMENT--- 分隔）。',
    '                    不给就是「没核对」，**按不通过处理**——「没查」与「查过没问题」',
    '                    必须分得开，所以没有「本地方便时可以不查」这一档。',
    '  --root            项目目录；缺省从脚本位置推（本脚本在 <项目>/scripts/ 下，往上一层就是根）',
    '  --expect-changes  改动清单**空着就是错**。提案上必须给这个开关：一份提案不可能零改动，',
    '                    清单空只说明那次 diff 没算出来（浅克隆、基线分支名错、fetch 失败），',
    '                    而「没算出来」会被读成「没动高风险路径」——门禁绿着放行，什么都没拦。',
    '  --waived          平台侧已经带了豁免标签。它**只豁免止损**，不豁免「还有标准没过」。',
    '',
    '  退出码：0 = 通过（或本次改动不含高风险路径）；1 = 审查记录不成立；2 = 用法错误。',
  ].join('\n')
}

/** 从脚本位置推项目根：本脚本在 `<项目>/scripts/` 下，往上一层就是根。 */
function defaultRoot() {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), '..'))
}

/**
 * 把「模板与实例」「契约逐字一致」这类判据做成导出，供 `preflight.mjs` 复用。
 *
 * 判据只实现一处：两处各判一次，迟早给出两个答案，而那时的表现是「自检说一致、
 * 交付却红」。
 */
export function checkTemplateCoverage(templateDir) {
  let files = []
  try {
    files = readdirSync(templateDir).filter((f) => statSync(join(templateDir, f)).isFile())
  } catch {
    return { ok: false, why: `读不到模板目录：${templateDir}` }
  }
  return { ok: true, files }
}

function main(argv) {
  let changedArg
  let bodyArg
  let rootArg
  let commentsArg
  let expectChanges = false
  let waived = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--changed') { changedArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--body') { bodyArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--root') { rootArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--comments') { commentsArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--expect-changes') { expectChanges = true; continue }
    if (argv[i] === '--waived') { waived = true; continue }
    if (argv[i] === '--help' || argv[i] === '-h') { process.stdout.write(`${usage()}\n`); return 0 }
    process.stderr.write(`错误：不认识的参数「${argv[i]}」。\n\n${usage()}\n`)
    return 2
  }
  if (changedArg === undefined || bodyArg === undefined) {
    process.stderr.write(`错误：--changed 与 --body 都要给。\n\n${usage()}\n`)
    return 2
  }

  // **stdin 只能读一次。**`--changed -` 与 `--body -` 同时给时，先读的吃光，
  // 后读的拿到空字符串——症状是「提案正文是空的」，于是判「没有实现依据」，
  // 而真原因是读取顺序。当场报错，好过让它跑出一个看起来像真结论的错。
  if (changedArg === '-' && bodyArg === '-') {
    process.stderr.write([
      '错误：--changed - 与 --body - 不能同时用——stdin 只能读一次。',
      '',
      '  两个都想从管道喂时，先把其中一个落到文件：',
      '    git diff --name-only > changed.txt',
      '    node scripts/review-record.mjs --changed changed.txt --body - --comments comments.txt < pr-body.md',
    ].join('\n') + '\n')
    return 2
  }

  let raw
  if (changedArg === '-') raw = readFileSync(0, 'utf8')
  else if (existsSync(changedArg)) raw = readFileSync(changedArg, 'utf8')
  else {
    process.stderr.write(`错误：改动清单不存在：${changedArg}\n`)
    return 2
  }
  const all = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)
  if (expectChanges && all.length === 0) {
    process.stderr.write([
      '改动清单是空的：这份提案不可能零改动，所以是**清单没算出来**，不是「没动高风险路径」。',
      '',
      '  常见原因：浅克隆里没有合并基点（检出要 fetch-depth: 0）、基线分支名写错、fetch 失败。',
      '  这一步不能跳过——空清单会被读成「通过」，而它本该拦下的东西一件都没拦。',
      '',
      '  处置：修好取基线的命令再重跑；不要用「清空清单」的办法让它变绿。',
    ].join('\n') + '\n')
    return 1
  }

  // **判据来自项目自己的契约**，不来自这份代码。
  const root = resolve(rootArg ?? defaultRoot())
  const agentsPath = join(root, 'AGENTS.md')
  let prefixes = []
  let contractMissing = false
  let skippedRows = []
  let tableState = 'noTable'
  let agentsText = ''
  let params = readProtocolParams('', { rework_cap: 2, waiver_label: 'pf:human-approved' })
  if (existsSync(agentsPath)) {
    agentsText = readFileSync(agentsPath, 'utf8')
    const table = readHighRiskTable(agentsText)
    prefixes = table.paths
    skippedRows = table.skipped
    tableState = table.state
    params = readProtocolParams(agentsText, params)
  } else {
    contractMissing = true
  }

  // 「填了一半」要报出来：占位行不算「认不出来」，也不算「没有」，它是**还没填完**。
  if (tableState === 'partialFill') {
    process.stderr.write([
      `高风险路径表填了一半：有 ${prefixes.length} 条真路径，还有占位行没换掉。`,
      '',
      '  填了一半的表只会保护填过的那几处，剩下的从此不需要审查记录，而门禁看起来是绿的。',
      '  把剩下的占位换成这个项目真实的路径；确实不需要那一类时，把整行删掉。',
    ].join('\n') + '\n')
    return 1
  }

  // **认不出来的行要报出来**：静默跳过正是「表填了但门禁永不触发」那个 bug 的形状。
  if (skippedRows.length > 0) {
    process.stderr.write([
      `高风险路径表里有 ${skippedRows.length} 行没解析出路径：`,
      ...skippedRows.slice(0, 6).map((r) => `  ${r}`),
      '',
      '  这几行会被当成「没有声明」。路径要能看出来是路径：目录写 `src/rules/`（或 `src/rules`，',
      '  会补成前缀形式），单个文件写 `AGENTS.md`；格子里可以带说明，但路径本身要能被认出来。',
    ].join('\n') + '\n')
    return 1
  }

  if (prefixes.length === 0) {
    // **不静默放行**：说清这一趟什么也没拦。绿着但一个字都没查，是这套机制里最坏的失效。
    process.stderr.write([
      contractMissing
        ? `没有读到项目契约：${agentsPath} 不存在`
        : (tableState === 'notFilled'
          ? `项目契约里有「## 高风险路径」这一节，但表还是骨架占位、没有一条真路径：${agentsPath}`
          : `项目契约里没有「## 高风险路径」表：${agentsPath}`),
      '',
      '  这一趟**没有做任何审查记录检查**——没有「哪几处算高风险」这份声明，就无从判断。',
      '  补上那张表即可启用（骨架见契约里「## 高风险路径」一节）。',
      '',
      '  **退出码仍是 0**：项目可能还没走到填表那一步，为此卡死构建代价太大。',
      '  但「没查」与「查过没问题」必须分得开——所以这句话必须说出来。',
    ].join('\n') + '\n')
    return 0
  }

  const high = highRiskChanged(all, prefixes)
  if (high.length === 0) {
    process.stdout.write(`审查记录：本次改动不落在高风险路径（判据 ${prefixes.length} 条，来自 AGENTS.md），不需要审查记录。\n`)
    return 0
  }

  const body = bodyArg === '-' ? readFileSync(0, 'utf8') : readFileSync(bodyArg, 'utf8')
  const issue = readClosingIssue(body)
  // 有单轨道：验收标准在 issue 正文里，那是别人写的、开工前就存在的。
  // 但**这份脚本读不到 issue**（零依赖、不联网），所以有单轨道时仍然要求工作记录指针：
  // 契约里写着「有单轨道也要建工作记录」。少一层间接，比多一条联网路径稳。
  const ptr = readWorkRecordPointer(body)

  const basis = readBasis(body)

  // ── 一、实现依据 ──
  //
  // 日常轨道只在改了高风险路径时才要求它——这条脚本已经走到这里，说明改到了。
  if (!basis.ok) {
    process.stderr.write([
      `实现依据不成立：这次改到了 ${high.length} 处高风险路径。`,
      '',
      `  原因：${basis.why}`,
      '',
      '  怎么填：写清开工前的分流结论与它引用的产物（设计文档 / 计划 / 待办），',
      '  或者「无需设计文档」的理由。**「按 issue 实现」这类占位说明不认**——',
      '  读者读完要能知道这个改动凭什么成立。',
    ].join('\n') + '\n')
    return 1
  }

  // ── 二、冻结的验收标准 ──
  if (ptr.path === undefined) {
    process.stderr.write([
      '缺少工作记录指针：提案正文里要有 `工作记录: <路径>` 一行。',
      '',
      '  验收标准要在**动手之前**冻结在工作记录里（`pf-done` 块）——',
      '  没有冻结的标准，审查就只能审「还能不能再找出一个问题」，而那个问题永远找得到。',
      '',
      '  写法：工作记录的「## 目标与验收」一节里放一个块，一条标准一行。',
      '  **指针不做目录猜测**：项目把工作记录放哪是项目自己的事，写在提案上最准。',
    ].join('\n') + '\n')
    return 1
  }
  const recPath = resolve(root, ptr.path)
  if (!existsSync(recPath)) {
    process.stderr.write([
      `工作记录不存在：${ptr.path}`,
      '',
      '  指针写了但文件没有。要么路径写错，要么那份记录还没建——',
      '  两种情况都要先修好，否则冻结的标准无从核对。',
    ].join('\n') + '\n')
    return 1
  }
  // **指针必须指向本次改动里的文件**：否则它可以指向一份很久以前冻结的标准，
  // 而那与这次改的东西没有关系——一个看起来有、实际对不上的判据。
  const relRec = ptr.path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!all.map((x) => unquoteGitPath(x)).includes(relRec)) {
    process.stderr.write([
      `工作记录指针指向的文件不在本次改动里：${relRec}`,
      '',
      '  冻结的验收标准必须是**这次改动**的标准。指针指向一个没改过的文件，',
      '  等于拿旧标准给新改动背书——它会通过，而它证明不了任何事。',
      '',
      '  改一份工作记录、把这次的标准冻结进去，或者把指针指对。',
    ].join('\n') + '\n')
    return 1
  }
  const done = readDoneBlock(readFileSync(recPath, 'utf8'))
  if (done.broken.length > 0) {
    process.stderr.write([
      '验收标准的块读不出来：',
      ...done.broken.slice(0, 4).map((b) => `  - ${b.why}`),
      '',
      '  格式：一条标准一行，`id: 说明`；id 是字母开头的短标识。',
      '',
      ...indent(canonicalDoneSnippet()),
    ].join('\n') + '\n')
    return 1
  }
  if (!done.found || done.ids.size === 0) {
    process.stderr.write([
      `工作记录里没有冻结的验收标准：${relRec}`,
      '',
      '  一个 `pf-done` 块，一条标准一行。判据是「一条命令或一条断言能证明它」：',
      '  「导出不再缺页」可以验，「体验更好」没法验。',
      '',
      ...indent(canonicalDoneSnippet()),
    ].join('\n') + '\n')
    return 1
  }

  // ── 三、审查记录 ──
  if (commentsArg === undefined) {
    process.stderr.write([
      '评论那一层未核对：没有给 --comments。',
      '',
      '  这次只核了实现依据与冻结标准，没有核「审查真的发生过」——所以这条**不算通过**。',
      '  提案上要带 `--comments`：CI 会把评论拉下来拼成一份文件传进来。',
    ].join('\n') + '\n')
    return 1
  }
  if (!existsSync(commentsArg)) {
    process.stderr.write(`错误：评论文件不存在：${commentsArg}\n`)
    return 2
  }
  const comments = readFileSync(commentsArg, 'utf8')
    .split(/^---COMMENT---\s*$/m).map((s) => s.trim()).filter((s) => s !== '')

  const reviews = readReviews(comments)
  if (reviews.broken.length > 0) {
    process.stderr.write([
      '审查记录的字段块有问题：',
      ...reviews.broken.slice(0, 4).map((b) => `  - ${b.why}`),
      '',
      '  格式（照抄这段就是合法的）：',
      ...indent(canonicalReviewSnippet(1)),
      '',
      '  **结论不用写**：机器从 `fail` 与 `escalate` 算出来。',
      '  早先版本让审查者写一句结论、机器去读中文里「通过」是肯定还是否定，那条路走不通——',
      '  否定的写法列不完，每漏一种方向都是放行。',
    ].join('\n') + '\n')
    return 1
  }

  const outcome = deriveOutcome({ done: done.ids, rounds: reviews.rounds, reworkCap: params.rework_cap, waived })
  if (!outcome.pass) {
    const stopLoss = outcome.stopLoss !== null
    process.stderr.write([
      `审查记录不成立：这次改到了 ${high.length} 处高风险路径。`,
      '',
      '  高风险路径（出错不会当场失败，而是让门禁从此少查一项）：',
      ...high.slice(0, 12).map((p) => `    - ${p}`),
      ...(high.length > 12 ? [`    …等 ${high.length} 处`] : []),
      '',
      `  原因：${outcome.why}`,
      '',
      ...(stopLoss
        ? [
            `  这是**止损**，不是「再修一轮就好」。豁免标签是 \`${params.waiver_label}\`，`,
            '  由维护者加——它表示「我认了这个风险」，不表示「可以不合」。',
            '',
          ]
        : []),
      '  怎么走：派一个**新上下文**去审（子代理或新会话），只给材料清单、不给执行者思路；',
      '  让它只回答「哪几条冻结标准没过」，并在通过时交故障注入记录。',
      '',
      '  **CI 绿不等于审过**：门禁判的是「现有检查有没有过」，审查判的是「这次改动有没有让',
      '  检查本身变松」。这两件事完全正交。',
    ].join('\n') + '\n')
    return 1
  }

  const waivedNote = waived && outcome.stopLoss === null ? '' : ''
  process.stdout.write(`审查记录：成立（${outcome.why}）。本次动到 ${high.length} 处高风险路径。\n`)
  process.stdout.write(`冻结的标准 ${done.ids.size} 条；审查 ${reviews.rounds.length} 轮${waived ? '（带豁免）' : ''}。\n`)
  void issue
  void waivedNote
  return 0
}

/**
 * 把示例块缩进成列表项里的样子，供报错信息直接贴给用户。
 *
 * 由 `canonical*Snippet()` 生成，不手写——手写的示例会与实现漂移，而漂移的示例
 * 正是「照着抄却过不了」的来源。
 */
function indent(snippet) {
  return snippet.split('\n').map((l) => '    ' + l)
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
