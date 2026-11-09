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
    //
    // **但反引号是成对写的，一格里的分隔符在反引号外面**：`\`a/\`,\`b/\`` 的反引号内容
    // 各是一段，中间那个逗号在反引号之外，所以这里拿到的是两段，正确。
    // 而 `\`a/,b/\`` 是**一整对反引号包着两个路径**——那种写法要按分隔符再拆一次，
    // 否则整格会被当成一个不存在的路径，两处都静默失效。
    for (const m of first.matchAll(/`([^`]+)`/g)) {
      const inner = m[1].trim()
      // **整格是占位就整格跳过，不拆。**
      //
      // 骨架里的占位带空格：`<改判定 / 改检查逻辑的那几个目录>/`。按空格拆开会得到
      // 「<改判定」与「/」两段，后者被收成一条真路径——实测解析出
      // `["改检查逻辑的那几个目录>", "模板目录>", "scripts"]`，
      // 于是「还没填表」的新项目看起来有 5 条判据，而在保护一堆不存在的路径，
      // 且 `partialFill` 永远算不出来。
      if (inner.startsWith('<') || inner.endsWith('>')) {
        candidates.push(inner)
        continue
      }
      for (const part of inner.split(/[\s,，、]+/)) {
        if (part !== '') candidates.push(part)
      }
    }
    if (candidates.length === 0) {
      // 没有反引号：取第一个以空白/逗号/顿号切开后像路径的 token。
      for (const tok of first.split(/[\s,，、]+/)) {
        if (tok === '' || tok.startsWith('<')) continue
        if (/^[/\w.@-]/.test(tok)) { candidates.push(tok); break }
      }
    }

    // 「为什么」那一格：非空、不是占位符。理由空白的一行等于只有路径没有依据。
    const why = (cells[1] ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()
    if (why === '' || why.startsWith('<')) whyFilled = false

    // **占位符不算「认不出来」，算「还没填」。**
    //
    // 骨架落盘时表里是两行 `<替换成这个项目的第一处>`。它们走 skipped 那条路会让
    // **任何改动**都退出码 1（包括只改 README），而脚本注释与 CI 模板都写着
    // 「空表会明说这一趟没查然后放行」——文档与实现相反。
    // 分成两种情况：
    //   一、整张表都没填（全是占位或空行）→ 走「还没填」，退出码 0，明说没查；
    //   二、填了但有几行认不出来 → 退出码 1，报出那几行。
    // **逐个候选判占位，不判整行。**
    //
    // 判整行会漏两种实测过的写法：
    //   一、混写：`| `scripts/` 与 `<另一处>/` |` —— 有一个真路径就不算占位，
    //       占位被静默吞掉，state 报 filled；
    //   二、英文占位：`| TBD | 待定 |`、`| TODO | 以后再填 |` —— 被当成真实判据，
    //       整张表看起来配好了，而一条都不保护。
    const PLACEHOLDER_WORD = /^(?:tbd|todo|fixme|xxx+|待定|待填|以后再填|稍后补|占位|这里填|未定)$/i
    const isPlaceholderCell = (c) => {
      const v = c.trim()
      return v.startsWith('<') || v.endsWith('>') || PLACEHOLDER_WORD.test(v)
    }
    const placeholdersInRow = candidates.filter(isPlaceholderCell).length
    if (placeholdersInRow > 0) placeholders += placeholdersInRow

    let took = 0
    for (const raw of candidates) {
      let v = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim()
      if (v === '' || v.startsWith('<') || v.endsWith('>') || /^(?:tbd|todo|fixme|xxx+|待定|待填|以后再填|稍后补|占位|这里填|未定)$/i.test(v)) continue
      const spec = normalizeEntry(v)
      if (spec === undefined) continue
      out.push(spec.path)
      took += 1
    }
    if (took === 0 && placeholdersInRow === 0) skipped.push(trimmed)
  }
  // **「有没有填」分三态**：
  //   notFilled   —— 有表但一条真路径都没有（整张表是占位或空）
  //   partialFill —— 有真路径、也有占位行（填了一半）
  //   filled      —— 全是真路径
  const state = out.length === 0 ? 'notFilled' : (placeholders > 0 ? 'partialFill' : 'filled')
  return { paths: [...new Set(out)], skipped, found: true, whyFilled, state, placeholders }
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
/**
 * 把表里那一格归一成**两种规范形态之一**：目录以 `/` 结尾，文件不以 `/` 结尾。
 *
 * **归一化只能有一处。** 实测过的病：把 `| AGENTS.md |` 改成 `| AGENTS.md/ |`——
 * 一个字符——preflight 自己做了 `replace(/\/$/, '')` 于是通过，而这里按前缀比
 * `'AGENTS.md'.startsWith('AGENTS.md/')` 为假，那份文件就不再算高风险。
 * 一个字符让「改契约本身」免审，而另一处判据看不见。两处归一化迟早给出两个答案。
 *
 * **尾斜杠不决定这一格是文件还是目录**——它是书写习惯。可光看名字也分不出来：
 * `.github` 是目录、`.gitattributes` 是文件，而它们的名字都以点开头，长得一模一样。
 * 靠「有没有扩展名」猜，实测把 `.gitattributes` 判成了目录，那一行从此静默失效。
 *
 * 所以归一只做**能确定的那一半**：去掉多余的尾斜杠、`./`、反斜杠，
 * **然后保留「原样写过尾斜杠」这个事实**。判前缀时两种都认——见 `isHighRiskPath`。
 * 猜不出来就不猜：判据宁可认两种写法，也不能把一种合法写法判死。
 *
 * 返回 `{ path, dir }`：`path` 是去掉尾斜杠的规范形式，`dir` 是「原样带过尾斜杠」。
 * 调用方只需拼出两种可能的匹配形式，不需要知道它是文件还是目录。
 */
export function normalizeEntry(raw) {
  let v = String(raw ?? '').replace(/\\/g, '/').trim()
  v = v.replace(/^\.\//, '')
  if (v === '' || v.startsWith('<') || v.startsWith('/') || /^[A-Za-z]:/.test(v)) return undefined
  const seg = v.split('/').filter((s) => s !== '').pop() ?? ''
  if (seg === '' || seg === '.' || seg === '..') return undefined
  return { path: v.replace(/\/+$/, ''), dir: v.endsWith('/') }
}

/**
 * 一个改动路径算不算落在高风险表里。
 *
 * 表项在解析时已归一（见 `normalizeEntry`），这里**只做匹配，不再归一**——两处各归一化
 * 一次迟早给出两个答案，那是实测过的病。
 *
 * 匹配认两种：整段相等（文件），或以 `path/` 开头（目录）。**两种都认**，因为
 * 「这一格是文件还是目录」在名字上看不出来（`.github` 与 `.gitattributes` 长得一样）。
 * 多认一种写法的代价是可能多要求一次审查；少认一种的代价是**静默失效**——
 * 前者可接受，后者正是这一整类问题的根。
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

/**
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
 * 评论里有没有**某一轮**的审查结论。
 *
 * 判据只有两条，缺一不可：
 *   一、**这条评论提到了这一轮**——按解析出来的轮次号判（见 `roundMarks`），
 *       写「第二轮」就只认领第二轮，不是「任何带数字的轮次」；
 *   二、**这一轮的结论与期望的一致**——按结论位判（见 `roundVerdict`），
 *       不是「文中出现过这个词」。
 *
 * **不判「写得好不好」。** 试过七种判法（字数、关键词、去表态词后的剩余量、顿号列举、
 * 句子数、排空词、扩展名白名单），每种都误伤真结论或放过纯附和。最后只留「非空」。
 * 边界见 项目的协作规范 的判据表：这条判据证明「有一轮审查发生过」，
 * 不证明「审得认真」。
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
/**
 * 评论里那段机器读的字段块。
 *
 * 形状（围栏语言必须写 `pf-review`，一行一个 `key: value`）：
 *
 * ```
 * ```pf-review
 * round: 1
 * verdict: 通过
 * blocking: 0
 * suggestions: 2
 * ```
 * ```
 *
 * **为什么是字段，不是散文。** 九轮审查的严重问题 100% 落在「判断中文结论词」那 247 行里，
 * 而那块只做一件事：判断「通过」到底是哪个意思。中文里「否定的通过」写法列不完——
 * 不通过 / 未通过 / 没有通过 / 不能通过 / 通不过 / 通过不了 / 不算通过 / 未正式通过 /
 * 未能顺利通过 / 尚未通过……每漏一种，方向都是**放行**。
 *
 * 那不是在修判据，是在追措辞。**判据的输入形状才是根**：让机器读字段，它就不必理解中文。
 * 正文照旧随便写，人读人的，机器读机器的。
 *
 * 字段缺哪个都算不合格：宁可报「格式不对、按模板写」，也不要猜。
 */

/**
 * 剥掉 HTML 注释，**未闭合的那个也剥**。
 *
 * 与 `stripComments` 的区别只在最后一种情况：遇到没有 `-->` 收尾的 `<!--` 时，
 * 它后面整段都算注释——把块写在那里面不该被当成结论。
 *
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
    // **没有收尾就到此为止**：后面全在注释里。
    if (end < 0) break
    i = end + 3
  }
  return out
}

/** 中文数字换算，只服务索引表格里的轮次格（「第一轮」）。 */
const CN_DIGITS = '零一二三四五六七八九十'

/**
 * 中文数字 → 阿拉伯数字。只到「二十几」——再往上没人把轮次写成中文。
 * 返回 undefined 表示这不是一个能认的中文数字。
 */
function cnNum(s) {
  const t = String(s ?? '')
  if (t === '') return undefined
  const ten = t.indexOf('十')
  if (ten < 0) {
    const i = CN_DIGITS.indexOf(t)
    return i < 0 ? undefined : String(i)
  }
  const high = t.slice(0, ten)
  const low = t.slice(ten + 1)
  const a = high === '' ? 1 : CN_DIGITS.indexOf(high)
  const b = low === '' ? 0 : CN_DIGITS.indexOf(low)
  if (a < 0 || b < 0) return undefined
  return String(a * 10 + b)
}

/** 围栏语言。用 `pf-review` 而不是纯 ```，是为了和普通代码块区分开。 */
const FIELD_FENCE = 'pf-review'

/** 允许的结论词。**只有这两档**——第三档会带来「多严算严」这种没人能判的问题。 */
const VERDICTS = ['通过', '需要返工']

/**
 * 从一段文字里抠出所有字段块。
 *
 * 返回 `[{ round, verdict, blocking, suggestions, at, raw }]`，按出现顺序。
 * 字段不合法（缺 key、结论词不在表里、round 不是正整数）**整个块作废**并计入 `broken`——
 * 半对的块比没有更坏：它看起来像一条记录。
 */
export function reviewBlocks(text) {
  const s = String(text ?? '')
  const out = []
  const broken = []
  // **围栏只在行首（允许前导空格）才算。**
  // 被 `>` 引用的是引用别人的东西，不是本评论的结论；把它当块解析会让整条提案判红。
  const re = new RegExp('(?:^|\\n)[ \\t]*```' + FIELD_FENCE + '[ \\t]*\\r?\\n([\\s\\S]*?)```', 'g')
  for (const m of s.matchAll(re)) {
    const fields = new Map()
    for (const line of m[1].split(/\r?\n/)) {
      const t = line.trim()
      if (t === '') continue
      const kv = /^([A-Za-z][A-Za-z0-9_-]*)\s*[:：]\s*(.*)$/.exec(t)
      if (kv === null) { broken.push({ raw: m[0], why: `这一行不是「键: 值」：${t}` }); continue }
      fields.set(kv[1].toLowerCase(), kv[2].trim())
    }
    const round = fields.get('round')
    const verdict = fields.get('verdict')
    if (round === undefined || !/^\d+$/.test(round)) {
      broken.push({ raw: m[0], why: 'round 缺失或不是数字（要从 1 起）' })
      continue
    }
    if (verdict === undefined || !VERDICTS.includes(verdict)) {
      broken.push({ raw: m[0], why: `verdict 只能是 ${VERDICTS.join(' / ')}，读到的是「${verdict ?? ''}」` })
      continue
    }
    const num = (k) => {
      const v = fields.get(k)
      return v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined
    }
    out.push({
      round: String(Number(round)),
      verdict,
      blocking: num('blocking'),
      suggestions: num('suggestions'),
      at: fields.get('at'),
      raw: m[0],
    })
  }
  return { blocks: out, broken }
}

/**
 * 正文「## 审查记录」那一节的索引行。
 *
 * 形状：`| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |`，结论格**只认那两个字**。
 *
 * 这里不需要猜语义——索引是**表格**，一格就是一个值。散文里那些歧义
 * （「待 CI 通过」「通过率 80%」）在表格里不存在，因为它们不会出现在「结论」那一格。
 */
export function reviewRecordState(body) {
  const text = String(body ?? '')
  const visible = stripComments(text)
  const head = /^##[ \t]*审查记录[ \t]*$/m.exec(visible)
  if (head === null) return { filled: false, section: false, rows: [], skipped: [], why: '正文里没有「## 审查记录」这一节' }
  const after = visible.slice(head.index + head[0].length)
  const nextHead = /^##[ \t]/m.exec(after)
  const body2 = nextHead === null ? after : after.slice(0, nextHead.index)

  const isSeparator = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-')
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim())
  const roundLike = (c) => /^(\d+|第\s*\d+\s*轮|第\s*[零一二三四五六七八九十]+\s*轮)$/.test(c)
  const roundNumber = (c) => {
    const ar = /(\d+)/.exec(c)
    if (ar !== null) return ar[1]
    const cn = /[零一二三四五六七八九十]+/.exec(c)
    return cn === null ? c : (cnNum(cn[0]) ?? c)
  }

  const rows = []
  const skipped = []
  for (const line of body2.split(/\r?\n/).map((l) => l.trim())) {
    if (line === '' || isSeparator(line)) continue
    if (!line.startsWith('|')) continue
    const c = cells(line)
    // **少一格也要报，不能静默丢。**
    //
    // 实测：`| 2 | sub-b 需要返工 |`（少一格）被 `c.length < 3` 静默跳过，
    // 直接 continue ——与已修的「认不出就丢」是同一个形状。
    // 只要第一格像轮次，就把它当成「想做一条记录但写坏了」，报出来。
    if (c.length < 3) {
      if (roundLike(c[0])) skipped.push({ line, why: '这一行少于三格（要轮次 / 谁审的 / 结论）' })
      continue
    }
    if (/^轮次$/.test(c[0]) || /^谁审/.test(c[1] ?? '')) continue

    // **结论格只认那两个字。** 表格一格就是一个值，不需要从散文里猜。
    const verdict = VERDICTS.find((v) => c[2] === v)

    // **认不出来的行要报出来，不能静默丢。**
    //
    // 实测：`| 2 | sub-b | 需要返工（见评论） | 3 / 1 |` 那一行认不出结论格，
    // 被 `continue` 丢掉，剩下的第 1 轮「通过」当上了最后一轮 → 门禁放行。
    // **越认真地写备注越容易触发。**
    //
    // 高风险表那张判据对同样的情况是要报错退出 1 的，注释还写着「认不出来不等于没有，
    // 静默跳过正是这个 bug 的形状」——同样的形状，这里不能是静默的。
    if (!roundLike(c[0])) { skipped.push({ line, why: `第一格「${c[0]}」不是轮次（写数字或「第 N 轮」）` }); continue }
    if (c[1] === '') { skipped.push({ line, why: '第二格（谁审的）是空的' }); continue }
    if (verdict === undefined) {
      skipped.push({
        line,
        why: '结论格「' + (c[2] ?? '') + '」认不出——只写「' + VERDICTS.join('」或「') + '」，要写备注就放进第四格',
      })
      continue
    }
    rows.push({ round: roundNumber(c[0]), who: c[1], verdict, note: c[3] ?? '' })
  }

  // 有认不出来的行 → 直接判红。它们是「看起来像一条记录、机器读不到」的那些。
  if (skipped.length > 0) {
    return {
      filled: false,
      section: true,
      rows,
      skipped,
      why: '「审查记录」里有 ' + skipped.length + ' 行认不出来：' + skipped.map((s) => s.why).join('；'),
    }
  }

  if (rows.length === 0) {
    return {
      filled: false,
      section: true,
      rows,
      skipped,
      why: '「审查记录」里没有一行是有效的（要轮次 + 审查者 + 结论三样齐全，'
        + '结论格只写「' + VERDICTS.join('」或「') + '」）——只写「无」「已审」这类口令不算',
    }
  }

  // 最后一轮必须是「通过」。**按轮次号取**，不按表格行序——行序不代表时间顺序。
  const last = [...rows].sort((x, y) => Number(x.round) - Number(y.round)).pop()
  if (last.verdict !== '通过') {
    return {
      filled: false,
      section: true,
      rows,
      skipped,
      why: `最后一轮（第 ${last.round} 轮）的结论是「${last.verdict}」——`
        + '改完要重新派一个上下文再审一轮，并把那一轮的结论也写进表里',
    }
  }
  return { filled: true, section: true, rows, skipped, why: `${rows.length} 轮审查记录，最后一轮通过` }
}

/**
 * 平台评论里有没有**这一轮**的字段块，结论对不对得上。
 *
 * 判据只有两条：
 *   一、找到 `round: N` 且 N 等于目标轮次的块；
 *   二、那个块的 `verdict` 等于期望的结论。
 *
 * **不读散文。** 评论正文怎么写都行——「需要返工，其余检查通过」这句话里
 * 机器看到的只有字段块，所以它不会把「通过」认错。
 */
export function findRoundInComments(round, verdict, comments) {
  const list = Array.isArray(comments) ? comments : []
  const key = String(Number(round))

  // **把所有评论里关于这一轮的说法先汇总，再看一致不一致。**
  //
  // 原先按评论逐条找、命中第一条就 return，于是「先发通过、再发订正」时，
  // 作废的那条继续生效（实测 EXIT=0）。**判据只看局部（一条评论），不看整体。**
  //
  // 汇总之后：「发新评论订正」真的成立——但也要求把旧的那条删掉，
  // 否则两条并存、结论相反，机器无法判断哪个作废。这条与「一条评论内不许有两个结论」
  // 是同一条规则，只是从「一条评论」放宽到「全部评论」。
  const found = []
  for (const c of list) {
    const text = typeof c === 'string' ? c : String(c?.body ?? '')
    // **注释里的块不算**：注释是给人看的示例，不是结论。
    // **成对的注释要剥，未闭合的 `<!--` 之后一律不算。**
    // 实测：`<!-- 下面是模板` + 合法块、不写 `-->` → 原先仍命中（放行方向）。
    const visible = stripCommentsLoose(text)
    const { blocks } = reviewBlocks(visible)
    for (const b of blocks) {
      if (b.round !== key) continue
      found.push({ verdict: b.verdict, sample: text.trim().slice(0, 80).replace(/\s+/g, ' ') })
    }
  }
  if (found.length === 0) return undefined

  // 关于这一轮只能有一个结论。两个都写在评论里时，机器无法判断哪句作废——
  // 「取更严」会误伤复述（「上一轮需要返工的三条已修完」），
  // 「取最后一个」会误伤订正（先写错、后写对）。唯一不猜的读法是：**不一致就不算**。
  //
  // 所以「要改口」的唯一办法是**删掉（或编辑）旧的那条评论**——光发一条新的不够，
  // 两条并存时机器判不了哪个作废，一律不算。这是有代价的取舍：它要求人做一次删除，
  // 换来的是「不会把作废的结论当成有效结论」。
  const distinct = [...new Set(found.map((f) => f.verdict))]
  if (distinct.length > 1) return undefined
  if (distinct[0] !== verdict) return undefined
  return found[0].sample
}

/**
 * 这条评论的**格式**对不对——不是「写得好不好」，是「机器能不能读」。
 *
 * 返回 `{ ok, blocks, broken }`。`broken` 非空时，调用方要把原因报出来：
 * 半对的块比没有更坏，它看起来像一条记录，而机器读不到。
 */
export function reviewFormatIssue(text) {
  const { blocks, broken } = reviewBlocks(text)
  if (broken.length > 0) return { ok: false, blocks, broken, why: broken[0].why }
  if (blocks.length === 0) {
    return { ok: false, blocks, broken, why: '没有 ```pf-review 字段块' }
  }
  return { ok: true, blocks, broken }
}

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
        + '正文里那一行只是索引，结论要以 ```pf-review 字段块的形式作为评论发出去。'
        + '没有那个块就没有可核对的痕迹，而「我审过了」在事后无从核对。'
        + '格式见 references/collaboration.md 的「审查结论怎么写」一节')
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

  // **stdin 只能读一次。**
  //
  // `--changed -` 与 `--body -` 同时给时，先读的那个吃光，后读的拿到空字符串——
  // 症状是「提案正文是空的」，于是判「没有审查记录」，而真原因是读取顺序。
  // 当场报错，说清怎么改，好过让它跑出一个看起来像真结论的错。
  if (changedArg === '-' && bodyArg === '-') {
    process.stderr.write([
      '错误：--changed - 与 --body - 不能同时用——stdin 只能读一次。',
      '',
      '  两个都想从管道喂时，先把其中一个落到文件：',
      '    git diff --name-only > changed.txt',
      '    node scripts/review-record.mjs --changed changed.txt --body - < pr-body.md',
    ].join('\n') + '\n')
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
  let tableState = 'noTable'
  if (existsSync(agentsPath)) {
    const table = readHighRiskTable(readFileSync(agentsPath, 'utf8'))
    prefixes = table.paths
    skippedRows = table.skipped
    tableState = table.state
  } else {
    contractMissing = true
  }

  // **「填了一半」要报出来。**
  //
  // 实测：表里一行真路径 + 一行 `<替换成第二处>` → paths 只有一条、skipped 为空，
  // 占位行凭空消失。于是「填了一半」看起来像「填完了」，而剩下那半从此不受保护。
  // 这不是「还没填」（那要走下面「明说没查」那条），是**填了但有缺口**。
  if (tableState === 'partialFill') {
    process.stderr.write([
      `高风险路径表填了一半：有 ${prefixes.length} 条真路径，还有占位行没换掉。`,
      '',
      '  占位行不算「认不出来」，也不算「没有」——它是**还没填完**。',
      '  填了一半的表只会保护填过的那几处，剩下的从此不需要审查记录，而门禁看起来是绿的。',
      '  把剩下的占位换成这个项目真实的路径；确实不需要那一类时，把整行删掉。',
    ].join('\n') + '\n')
    return 1
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
        : (tableState === 'notFilled'
          ? `项目契约里有「## 高风险路径」这一节，但表还是骨架占位、没有一条真路径：${agentsPath}`
          : `项目契约里没有「## 高风险路径」表：${agentsPath}`),
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

  // **先看格式**：有字段块但读不出来时，报「格式不对」，不要折叠成「找不到」。
  //
  // 实测：`verdict: 通过。`（带中文句号）这种坏块，原先得到的是
  // 「第 1 轮在提案评论里找不到」——而真原因是格式。报错要能直接照着改。
  {
    const seen = []
    for (const c of comments) {
      const issue = reviewFormatIssue(c)
      if (!issue.ok && issue.broken !== undefined && issue.broken.length > 0) seen.push(issue.why)
    }
    if (seen.length > 0) {
      process.stderr.write([
        '审查记录里那几条评论的字段块格式不对：',
        ...seen.slice(0, 4).map((w) => '  - ' + w),
        '',
        '  格式：',
        '    \`\`\`pf-review',
        '    round: 1',
        '    verdict: 通过',
        '    \`\`\`',
        '',
        '  verdict 只能是「通过」或「需要返工」，不要加句号、括号或别的字。',
      ].join('\n') + '\n')
      return 1
    }
  }

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
    '  把它给出的结论**按下面的格式写成一条评论发上去**，再把那一行填进「## 审查记录」当索引：',
    '',
    '    ```pf-review',
    '    round: 1',
    '    verdict: 通过',
    '    blocking: 0',
    '    suggestions: 2',
    '    ```',
    '',
    '  **为什么是字段块**：机器只读这几行，正文随便写。中文里「否定的通过」写法列不完',
    '  （不通过 / 通不过 / 通过不了 / 未正式通过 …），让机器读散文，每漏一种就放行一次。',
    '  人读正文、机器读字段，两边互不干扰。',
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
