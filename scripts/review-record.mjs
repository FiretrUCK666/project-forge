#!/usr/bin/env node
/**
 * review-record.mjs —— 高风险路径的改动，必须有「审查记录」。
 *
 * ## 它治的是什么病
 *
 * 「必须独立审查」这条规则写在契约里，但它一直是**只靠自觉**的：改完、跑一遍门禁全绿、
 * 看着没问题，就合了。而「看着没问题」正是自审的产物——同一个上下文里再读一遍，读出的
 * 一定是「刚才那套没问题」。实测发生过一次：34 个文件、动到判定逻辑与模板的改动，
 * 执行者看到 CI 绿了就合并，事后追问「为什么没派审查」，因为规则里没写到这一层。
 *
 * 所以这里加一条**机器判据**：动到高风险路径的提案，正文里必须有审查记录。它把
 * 「我审过了」这句话从自述变成一条可核对的痕迹。
 *
 * ## 两层判据
 *
 *   1. **索引层**：提案正文里那一节，写清有哪几轮、每轮谁审的、结论是什么；
 *   2. **痕迹层**：每一轮的结论都要在**平台评论**里找得到对应的一条。
 *
 * 第二层是后补的，补的原因很具体：契约里一直写着「每轮结论写回提案评论」，而判据只看
 * 正文，于是评论一条不发也能全绿——实测跑了两轮审查、PR 上评论数是 0、门禁全绿。
 * 正文那一节是索引，评论才是痕迹；只有索引时，「谁审的、发现了什么」这份事后可核对的
 * 东西，退化成执行者自己写的一行字。
 *
 * ## 它能证明什么、不能证明什么
 *
 * 能证明：**这一栏填了**，且填的不是空模板。这条已经足够拦住「压根没派审查」——
 * 那正是要拦的。
 *
 * 不能证明：审查的人真的读了代码、真的发现了该发现的问题。**判据不能假装能判它判不了的
 * 东西**：那会让一条真检查被读成一条假保证。所以这里的措辞只说到「有记录」为止。
 *
 * ## 高风险路径从哪儿来
 *
 * **不写在这份代码里**，从**这个项目自己的** `AGENTS.md` 读：里面有一张
 * 「高风险路径」表（`AGENTS.md` 生成契约时留了那个位置）。
 * 理由与全仓其它判据一致——写死在代码里，换一个项目就判错；而「哪几处改了会让门禁
 * 少查一项」是这个项目自己的知识，不是工具的知识。
 *
 * 读不到那张表时**不静默放行**：报一行提示说「没有高风险路径声明，本次只做通用检查」，
 * 退出码仍然是 0（不能因为项目还没填表就把它卡死），但**说清楚这一趟什么也没拦**。
 * 静默放行是这套机制里最坏的一种失效：它看起来绿着，实际一个字都没查。
 *
 * ## 用法
 *
 *   node scripts/review-record.mjs --changed <改动文件清单> --body <提案正文文件> [--root <项目目录>]
 *
 * `--changed` 可以是一个文件（每行一个路径），也可以是 `-` 表示从 stdin 读。
 * `--root` 缺省**从脚本自己的位置推**（本脚本在 `<项目>/scripts/` 下，往上一层就是根），
 * 不是当前目录。判据：它按约定落在 `scripts/` 里，从那里退一层就是项目根，与 cwd 无关——
 * 用 cwd 的话，在项目子目录里跑一次就读不到契约，于是「这一趟没查」。
 * 退出码：0 = 通过（或本次改动不含高风险路径）；1 = 有高风险改动但审查记录是空的；
 * 2 = 用法错误。
 */

import { existsSync, readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 这个模块是被直接跑起来的，还是被 import 的？
 *
 * 判据按**真实路径**比较：经 junction / 符号链接调用也算直接执行。字面比较在那种情况下
 * 会静默空跑并返回 0——那是自检假绿。这段与 `lib/text.mjs` 的同名函数是同一个判据；
 * 这里复制一份而不是 import，是为了让本文件**零依赖**（目标项目里没有 `lib/`）。
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

/**
 * 从契约里读「高风险路径」表。
 *
 * 判据是**这个项目自己的**：哪几处改了会让门禁从此少查一项，因项目而异——
 * 一个 skill 仓库是判定逻辑与模板，一个服务端项目可能是数据库迁移与鉴权中间件。
 * 写死在这份代码里，换一个项目就判错；而判错的症状不是报错，是**该拦的没拦**。
 *
 * 表长这样（`AGENTS.md` 生成契约时留了那个位置）：
 *
 *   ## 高风险路径
 *
 *   | 路径 | 为什么 |
 *   | --- | --- |
 *   | `src/rules/` | 判据错了不会报错，只会从此少查一项 |
 *   | `migrations/` | 回滚不恢复原状 |
 *
 * 只认**行首第一格**里被反引号或裸写的路径；表头与分隔线自动跳过。
 * 读不到这一节就返回空数组——调用方据此说「没声明，这一趟什么也没拦」。
 */
export function readHighRiskPaths(agentsText) {
  const { paths } = readHighRiskTable(agentsText)
  return paths
}

/**
 * 读那张表，同时把「读出来什么、跳过了什么」一起给出来。
 *
 * 三种最常见的手写形状都要认：
 *   - 目录不带尾斜杠（`src/rules`）→ 补成前缀形式。人写目录时未必记得带斜杠，
 *     而漏一个斜杠的后果是这条判据对整棵树失效，症状完全不可见。
 *   - 格子里带说明（`src/rules/ 下的判定`）→ 取第一个 token。反引号包着的优先取里面的。
 *   - 一行写两个（`a/`、`b/`）→ 全都收。
 *
 * `skipped` 收的是「看起来像表行、但一个路径都没解析出来」的那些行。
 * 调用方要把它们报出来：**认不出来不等于没有**，静默跳过就是这一整个 bug 的形状。
 */
export function readHighRiskTable(agentsText) {
  const text = String(agentsText ?? '')
  const head = /^##+[ \t]*高风险路径[ \t]*$/m.exec(text)
  if (head === null) return { paths: [], skipped: [], found: false }
  const after = text.slice(head.index + head[0].length)
  const nextHead = /^##+[ \t]/m.exec(after)
  const block = nextHead === null ? after : after.slice(0, nextHead.index)
  const out = []
  const skipped = []
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(trimmed) && trimmed.includes('-')) continue
    const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim())
    const first = cells[0] ?? ''
    if (first === '' || /^路径$/.test(first)) continue

    const candidates = []
    // 反引号包着的路径优先——那是人明确标出来的「这一格是路径」。
    for (const m of first.matchAll(/`([^`]+)`/g)) candidates.push(m[1])
    if (candidates.length === 0) {
      // 没有反引号：取第一个以空白/逗号/顿号切开后像路径的 token。
      for (const tok of first.split(/[\s,，、]+/)) {
        if (tok === '' || tok.startsWith('<')) continue
        if (/^[/\w.@-]/.test(tok)) { candidates.push(tok); break }
      }
    }

    let took = 0
    for (const raw of candidates) {
      let v = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
      if (v === '' || v.startsWith('<')) continue
      // 没带斜杠、末段也没有扩展名 → 当目录，补成前缀形式。
      // 判据：末段里没有点，就是目录名（`src/rules` 是目录，`AGENTS.md` 是文件）。
      if (!v.endsWith('/') && !/\.[^/]+$/.test(v)) v = `${v}/`
      out.push(v)
      took += 1
    }
    if (took === 0) skipped.push(trimmed)
  }
  return { paths: [...new Set(out)], skipped, found: true }
}

/**
 * 把 `git diff --name-only` 的一条输出还原成真实的路径。
 *
 * 默认配置下 git 会对含非 ASCII 字符的路径做 C 风格转义并加双引号：
 * `"templates/\345\256\241..."`。直接拿它去比前缀，中文名的风险改动会被判成
 * 非高风险——门禁绿着放行，而使用者完全看不出为什么。这个仓库本身就是中文文档项目。
 *
 * 两种输入都要能吃：真被转义的就解回来，没转义的原样返回。
 * 不做「让调用方记得加 `-c core.quotepath=false`」那种约定：那是一条要人记住的规矩，
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
 * 这个路径算不算高风险。
 *
 * 判据是**前缀**，不是逐文件清单：清单要人记得改，而目录不会长出新的一处。
 * 结尾带 `/` 的按目录前缀比；否则按整段相等——这样 `scripts-dev/` 不会被
 * `scripts/` 误伤（用 `includes` 就会，实测过）。
 */
export function isHighRiskPath(rel, prefixes) {
  const p = unquoteGitPath(rel).replace(/\\/g, '/').replace(/^\.\//, '')
  if (p === '') return false
  const list = Array.isArray(prefixes) ? prefixes : []
  return list.some((pre) => (pre.endsWith('/') ? p.startsWith(pre) : p === pre))
}

/** 从一份改动清单里挑出高风险的那几条（去重、排序，报告里好读）。 */
export function highRiskChanged(paths, prefixes) {
  return [...new Set(paths.map((x) => unquoteGitPath(x)).filter(Boolean)
    .filter((p) => isHighRiskPath(p, prefixes)))].sort()
}

/** 去掉 HTML 注释后的正文：注释里写着「怎么填」，那是模板不是记录。 */
function stripComments(text) {
  let out = ''
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('<!--', i)
    if (start < 0) { out += text.slice(i); break }
    out += text.slice(i, start)
    const end = text.indexOf('-->', start + 4)
    if (end < 0) break
    i = end + 3
  }
  return out
}

/**
 * 提案正文里有没有**真的填过**的审查记录。
 *
 * 判据是**三样同时成立**：轮次、审查者、结论。
 *
 * 不是「有字就算填过」。实测三种「填了但没审」都能骗过只看有无的版本：
 *   |  |  |  |  |            空行
 *   | 1 |  |  |  |            只有轮次
 *   审查记录：无              一句口令
 *
 * 审查记录的作用是让漏审**事后可核对**，一句口令核对不了任何东西——它给了一条看起来
 * 像保证的假痕迹，比没有更坏。所以「本档不需要审查」这类自称**不算填过**：免审是机器
 * 按改动路径算出来的，不是人写的一句话。
 *
 * 最后一条结论必须是「通过」。前面写着「需要返工」而后来的轮次没补，说明还没修完；
 * 机器只认最后一条结论，因为那才是当前状态。
  */
export function reviewRecordState(body) {
  const text = String(body ?? '')
  const visible = stripComments(text)
  const head = /^##[ \t]*审查记录[ \t]*$/m.exec(visible)
  if (head === null) return { filled: false, section: false, rows: [], why: '正文里没有「## 审查记录」这一节' }
  const after = visible.slice(head.index + head[0].length)
  const nextHead = /^##[ \t]/m.exec(after)
  const body2 = nextHead === null ? after : after.slice(0, nextHead.index)
  const lines = body2.split(/\r?\n/).map((l) => l.trim())

  const isSeparator = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-')
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim())

  // 有效的一行长这样：| 1 | sub-audit-xyz | 通过 | 0 / 2 |
  //
  // **判据不是「有字」**。实测三种「填了但没审」都能骗过只看有无的版本：
  //   |  |  |  |  |            空行
  //   | 1 |  |  |  |            只有轮次
  //   审查记录：无              一句口令
  // 审查记录的作用是让漏审**事后可核对**，一句口令核对不了任何东西——它给了一条
  // 看起来像保证的假痕迹，比没有更坏。所以这里要求三样同时成立：
  //   - 轮次是数字或「第 N 轮」；
  //   - 审查者那一格非空（它是「另一个上下文」的标识，正是要留档的东西）；
  //   - 结论是「通过」或「需要返工」之一。
  const VERDICT = /^(通过|不通过|需要返工|需要修改|需返工)/
  // 轮次认三种写法：阿拉伯数字、阿拉伯数字带「第…轮」、中文数字带「第…轮」。
  // 认不认一种写法，不该决定一条记录算不算数——那属于误伤正当写法。
  const roundLike = (c) => /^(\d+|第\s*\d+\s*轮|第\s*[零一二三四五六七八九十]+\s*轮)$/.test(c)
  const roundNumber = (c) => {
    const ar = /(\d+)/.exec(c)
    if (ar !== null) return ar[1]
    const cn = /[零一二三四五六七八九十]+/.exec(c)
    return cn === null ? c : (cnNum(cn[0]) ?? c)
  }
  const rows = []
  for (const line of lines) {
    if (line === '' || isSeparator(line)) continue
    if (!line.startsWith('|')) continue
    const c = cells(line)
    if (c.length < 3) continue
    if (/^轮次$/.test(c[0]) || /^谁审/.test(c[1] ?? '')) continue
    if (!roundLike(c[0]) || c[1] === '' || !VERDICT.test(c[2])) continue
    rows.push({
      round: roundNumber(c[0]),
      who: c[1],
      verdict: VERDICT.exec(c[2])[1],
      note: c[3] ?? '',
    })
  }

  if (rows.length === 0) {
    return {
      filled: false,
      section: true,
      rows,
      why: '「审查记录」里没有一行是有效的审查记录（要轮次 + 审查者 + 结论三样齐全，'
        + '结论写「通过」或「需要返工」）——只写「无」「已审」这类口令不算',
    }
  }

  // **最后一轮必须是「通过」**。前面写着「需要返工」而后来的轮次没补，说明还没修完；
  // 机器只认最后一条结论，因为那才是当前状态。
  const last = rows[rows.length - 1]
  if (!/^通过$/.test(last.verdict)) {
    return {
      filled: false,
      section: true,
      rows,
      why: `最后一轮（第 ${last.round} 轮）的结论是「${last.verdict}」——`
        + '改完要重新派一个上下文再审一轮，并把那一轮的结论也写进表里',
    }
  }

  return { filled: true, section: true, rows, why: `${rows.length} 轮审查记录，最后一轮通过` }
}

/**
 * 评论里有没有**某一轮**的审查结论。
 *
 * 判据分三层，缺一不可：
 *   1. 评论里出现「第 N 轮」（或「round N」「#N 轮」这些写法）；
 *   2. 同一段里出现那个结论词（通过 / 需要返工 …）；
 *   3. 评论长度超过一个下限——「第 1 轮：通过」七个字不算审查结论，
 *      它连「发现了什么」都没有。下限取得很低（默认 80 字符），只拦「一句话交差」。
 *
 * 找到时返回那一段的前 80 个字符，报告里能看出是哪一条。
 */
/**
 * 结论词表：**长的在前**。
 *
 * 顺序不是排版，是判据。中文里「通过」是「不通过」「未通过」的真前缀，用子串搜就会
 * 让最坏的那个词命中最松的那个——实测：索引写「通过」、评论写「不通过」，门禁判通过。
 * 按长度降序匹配，「不通过」先吃掉那四个字，「通过」就没有位置可占了。
 */
/** 中文数字换算。只用到二十几轮——再往上没人会把轮次写成中文。 */
const CN_DIGITS = '零一二三四五六七八九十'
function cnNum(s) {
  if (s.length === 1) return String(CN_DIGITS.indexOf(s))
  if (s.startsWith('十')) return String(10 + CN_DIGITS.indexOf(s[1]))
  const [a, b] = s.split('十')
  const tens = CN_DIGITS.indexOf(a)
  return String(tens * 10 + (b === undefined || b === '' ? 0 : CN_DIGITS.indexOf(b)))
}
const VERDICT_TOKENS = [
  ['需要返工', '需要返工'],
  ['需要修改', '需要返工'],
  ['需返工', '需要返工'],
  ['不通过', '不通过'],
  ['未通过', '不通过'],
  ['通过', '通过'],
]

/**
 * 把一段文字里出现的结论词**全部**找出来，规范化成「通过 / 不通过 / 需要返工」。
 *
 * 用一条合并正则一次扫完：交替项按长度降序，所以同一个位置上长的优先。
 * 这样「不通过」只会产出「不通过」，不会顺带产出一个假的「通过」。
 */
export function verdictsIn(text) {
  const source = VERDICT_TOKENS.map(([word]) => word).join('|')
  const found = new Set()
  for (const m of String(text ?? '').matchAll(new RegExp(source, 'g'))) {
    const hit = VERDICT_TOKENS.find(([word]) => word === m[0])
    if (hit !== undefined) found.add(hit[1])
  }
  return found
}

export function findRoundInComments(round, verdict, comments) {
  const list = Array.isArray(comments) ? comments : []
  // 轮次的三种写法都要认：阿拉伯数字、第 N 轮、第「中文数字」轮。
  // 只认一种写法时，错误信息会把人引向「是不是没发评论」，而真原因是写法不认。
  const cnAlt = `[零一二三四五六七八九十]+`
  const roundRe = new RegExp(
    `(?:第\\s*(?:${round}|${cnAlt})\\s*轮|round\\s*${round}\\b|#${round}\\s*轮)`, 'i')
  for (const c of list) {
    const text = typeof c === 'string' ? c : String(c?.body ?? '')
    if (!roundRe.test(text)) continue
    // **按整词判定，不按子串**。见上面词表那段注释。
    if (!verdictsIn(text).has(verdict)) continue
    if (text.trim().length < 80) continue
    return text.trim().slice(0, 80).replace(/\s+/g, ' ')
  }
  return undefined
}

/**
 * 把「正文索引」与「平台评论」对起来。
 *
 * 这一层是这次返工的核心：契约里写着「每轮结论写回提案评论」，而判据一直只看正文，
 * 于是**评论一条不发也能全绿**。实测发生过——两轮审查跑完，PR 上评论数是 0。
 *
 * 返回 `{ ok, problems, matched }`。`comments` 为 undefined 表示调用方没提供评论
 * （本地跑就是这样）；此时**不判评论那一层**，并在报告里明说「只核了正文」——
 * 「没查」与「查过没问题」必须分得开。
 */
export function matchRoundsToComments(state, comments) {
  if (!Array.isArray(comments)) {
    return { ok: true, checked: false, problems: [], matched: [] }
  }
  const problems = []
  const matched = []
  for (const row of state.rows ?? []) {
    const hit = findRoundInComments(row.round, row.verdict, comments)
    if (hit === undefined) {
      problems.push(`第 ${row.round} 轮（${row.who}，${row.verdict}）在提案评论里找不到 —— `
        + '正文里那一行只是索引，结论要作为评论发出去。没有评论就没有可核对的痕迹，'
        + '而「我审过了」在事后无从核对')
    } else {
      matched.push({ round: row.round, sample: hit })
    }
  }
  return { ok: problems.length === 0, checked: true, problems, matched }
}

function usage() {
  return [
    '用法：node scripts/review-record.mjs --changed <清单文件|-> --body <提案正文> [选项]',
    '',
    '  改动落在**高风险路径**时，提案正文必须有「## 审查记录」且真的填过。',
    '  它拦的是「CI 绿了就合并、压根没派审查」那一种。',
    '',
    '  高风险路径不写死在代码里，从 `<项目>/AGENTS.md` 的「## 高风险路径」表读。',
    '  那张表由 `AGENTS.md` 生成契约时留了位置，每个项目自己填。',
    '',
    '  --changed         每行一个改动路径的文件；`-` 表示从 stdin 读（`git diff --name-only` 直接接）',
    '  --body            提案正文（Markdown 文件）',
    '  --root            项目目录；缺省从脚本位置推（本脚本在 <项目>/scripts/ 下，往上一层就是根）',
    '  --comments        平台上那些评论的正文（一个文件，每条之间用一行 ---COMMENT--- 分隔）。',
    '                    **必须给**：正文那一节只是索引，每一轮的结论都要能在评论里',
    '                    找到对应的一条。不给就是「没核对」，**按不通过处理**——「没查」与',
    '                    「查过没问题」必须分得开，所以没有「本地方便时可以不查」这一档。',
    '  --expect-changes  改动清单**空着就是错**。提案上必须给这个开关：一份提案不可能零改动，',
    '                    清单空只说明那次 diff 没算出来（浅克隆、基线分支名错、fetch 失败），',
    '                    而「没算出来」会被读成「没动高风险路径」——门禁绿着放行，什么都没拦。',
    '',
    '  退出码：0 = 通过；1 = 有高风险改动但审查记录是空的（或 --expect-changes 下清单为空）；',
    '          2 = 用法错误。',
  ].join('\n')
}

function main(argv) {
  let changedArg
  let bodyArg
  let rootArg
  let commentsArg
  let expectChanges = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--changed') { changedArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--body') { bodyArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--root') { rootArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--comments') { commentsArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--expect-changes') { expectChanges = true; continue }
    if (argv[i] === '--help' || argv[i] === '-h') { process.stdout.write(`${usage()}\n`); return 0 }
    process.stderr.write(`错误：不认识的参数「${argv[i]}」。\n\n${usage()}\n`)
    return 2
  }
  if (changedArg === undefined || bodyArg === undefined) {
    process.stderr.write(`错误：--changed 与 --body 都要给。\n\n${usage()}\n`)
    return 2
  }
  if (bodyArg !== '-' && !existsSync(bodyArg)) {
    process.stderr.write(`错误：提案正文不存在：${bodyArg}\n`)
    return 2
  }

  let raw
  if (changedArg === '-') {
    raw = readFileSync(0, 'utf8')
  } else if (existsSync(changedArg)) {
    raw = readFileSync(changedArg, 'utf8')
  } else {
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
  // **判据来自项目自己的契约**，不来自这份代码：哪几处改了会让门禁从此少查一项，
  // 因项目而异。写死在代码里，换一个项目就判错——而判错的症状不是报错，是该拦的没拦。
  const root = resolve(rootArg ?? join(dirname(fileURLToPath(import.meta.url)), '..'))
  const agentsPath = join(root, 'AGENTS.md')
  let prefixes = []
  let contractMissing = false
  let skippedRows = []
  if (existsSync(agentsPath)) {
    const table = readHighRiskTable(readFileSync(agentsPath, 'utf8'))
    prefixes = table.paths
    skippedRows = table.skipped
  } else {
    contractMissing = true
  }

  // **认不出来的行要报出来**：它们是「看起来像表、其实一个路径都没解析出来」的那些。
  // 静默跳过正是这个 bug 原本的形状——填表的人从任何一处都得不到提示，唯一的症状是
  // 门禁永久不触发，而那件事不会报错。
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
        : `项目契约里没有「## 高风险路径」表（或表是空的）：${agentsPath}`,
      '',
      '  这一趟**没有做任何审查记录检查**——没有「哪几处算高风险」这份声明，就无从判断。',
      '  补上那张表即可启用（骨架见 契约里「## 高风险路径」一节）：',
      '',
      '    ## 高风险路径',
      '',
      '    | 路径 | 为什么 |',
      '    | --- | --- |',
      '    | `<改判定/改检查逻辑的那几个目录>/` | 判据错了不会报错，只会从此少查一项 |',
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
  const state = reviewRecordState(body)
  if (!state.filled) {
    process.stderr.write([
      `审查记录缺失：这次改到了 ${high.length} 处高风险路径，提案正文里没有可用的审查记录。`,
      ...missingHelp(high, state),
    ].join('\n') + '\n')
    return 1
  }

  // ── 第二层：**每一条索引都要在平台评论里找得到对应的一轮** ──
  //
  // 这一层是这次返工的核心。契约里写着「每轮结论写回提案评论」，而判据一直只看正文，
  // 于是评论一条不发也能全绿——实测跑了两轮审查，PR 上评论数是 0，而门禁全绿。
  //
  // 正文那一节是**索引**，评论才是痕迹。只留索引，等于把「谁审的、发现了什么」这份
  // 事后可核对的东西，退化成执行者自己写的一行字；而一项独立审查的全部意义，
  // 恰恰在于它不是执行者自己给的。
  if (commentsArg === undefined) {
    process.stderr.write([
      '评论那一层未核对：没有给 --comments。',
      '',
      '  正文里的「审查记录」是**索引**，每一条都要在平台评论里找得到对应的一轮。',
      '  这次只核了索引本身，没有核「那些结论真的发出去过」——所以这条**不算通过**。',
      '',
      '  提案上要带 `--comments`：CI 会把评论拉下来拼成一份文件传进来（见工作流里那一步）。',
    ].join('\n') + '\n')
    return 1
  }
  if (!existsSync(commentsArg)) {
    process.stderr.write(`错误：评论文件不存在：${commentsArg}\n`)
    return 2
  }
  const comments = readFileSync(commentsArg, 'utf8')
    .split(/^---COMMENT---\s*$/m).map((s) => s.trim()).filter((s) => s !== '')

  const match = matchRoundsToComments(state, comments)
  if (!match.ok) {
    process.stderr.write([
      `审查记录与评论对不上：正文里索引了 ${(state.rows ?? []).length} 轮，评论里找不到这几轮 ——`,
      '',
      ...match.problems.map((p) => `  - ${p}`),
      '',
      '  每一轮的结论都要**作为评论发出去**（正文走 `--body-file`，规则见协作判据第九节）：',
      '  正文那一栏只是索引，评论才是可核对的痕迹。只在正文里写一行，等于执行者自己给自己',
      '  出证明。',
    ].join('\n') + '\n')
    return 1
  }

  process.stdout.write(`审查记录：有（${state.why}）。本次动到 ${high.length} 处高风险路径。\n`)
  process.stdout.write(`评论核对：${(state.rows ?? []).length} 轮的结论都在平台评论里找得到\n`)
  return 0
}

/** 审查记录缺失时要说的话：为什么、怎么办、以及两件最容易混的事。 */
function missingHelp(high, state) {
  return [
    '',
    '  高风险路径（出错不会当场失败，而是让门禁从此少查一项）：',
    ...high.slice(0, 12).map((p) => `    - ${p}`),
    ...(high.length > 12 ? [`    …等 ${high.length} 处`] : []),
    '',
    `  原因：${state.why}`,
    '',
    '  怎么办：派一个**新上下文**去审（子代理或新会话），只给材料清单、不给执行者思路；',
    '  把它给出的结论**写成评论发上去**，再把那一行填进「## 审查记录」当索引。',
    '',
    '  **CI 绿不等于审过**：门禁判的是「现有检查有没有过」，审查判的是「这次改动有没有让',
    '  检查本身变松」。这两件事完全正交，前者绿了不代表后者做过。',
    '',
    '  **一轮不够就再来一轮**：结论是「需要返工」时，改完要重新派一个新的上下文，',
    '  不要把上一轮的结论喂给它——带着别人的判断去读，读出来的是复核，不是审查。',
    '  每一轮的结论发一条评论，并在索引表里追加一行（累积，不覆盖）。',
  ]
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
