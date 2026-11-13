#!/usr/bin/env node
/**
 * gap-coverage.mjs —— 勘察报的每一条缺口，体检那边有人接吗。
 *
 * ## 它治的病
 *
 * 勘察（`survey.mjs`）与体检（`review.mjs`）是两套独立判断。勘察说「没有 `.gitattributes`」，
 * 体检可能一个字都不提，**没有任何东西会发现**。表现出来就是：AI 做完了勘察、照着报告配了
 * 一圈，交付体检说「可以交付」，而那个缺口从来没被处理过。
 *
 * 更常见的形状是加了一条新缺口、忘了在体检那边加对应判据。那时候没有报错，只有一条永远
 * 悬空的结论。
 *
 * ## 判据：三选一，必须选一个
 *
 * 每条缺口在体检那边只能落在下面三档之一：
 *
 *   - `review: '<id>'`        —— 体检里有同名的一条，会报「缺」或「齐」；
 *   - `decision: '<key>'`     —— 它是个「只有使用者能定」的问题，表态了就消掉；
 *   - `surveyOnly: '<理由>'`  —— 它只在勘察里出现，体检不管。**必须写理由**。
 *
 * 三样都没有 = 掉了一条。这条判据只要一行，覆盖全部缺口——以后加缺口忘了接线上，这里就红。
 *
 * ## 为什么是静态核对，不是运行时反查
 *
 * 运行时反查要求体检每次都重算勘察全量，而那本来就在做（`reviewProject` 第一行就是
 * `survey(targetDir)`）。但「有没有人接」这件事在**改代码那一刻**就该知道，等到运行时
 * 才发现，中间已经过去了几个月，而那时缺口可能已经被当成事实接受了。
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/**
 * 从 `survey.mjs` 的声明表里读出每条缺口与它的处置。
 *
 * **读源码而不是 import**：那些表不是导出值，而是模块内部的常量；为了这个检查把它们
 * 导出来，等于为了让检查能跑而改变被检查的东西。
 *
 * 这一层只做词法，不做语义——`id` / `review` / `decision` / `surveyOnly` 四个键各出现
 * 几次、配没配上对，由下面的 `coverageOf` 判。
 *
 * ## 切块不依赖缩进
 *
 * 早先按 `\n  {\n` 切（写死两空格缩进）。换一次格式化器、或者有人把那一节整体多缩两格，
 * 切出来就是空数组——**语义一个字都没变，17 条缺口全部静默消失**，而退出码仍是 0。
 * 那是一条被削成恒真的判据，比没有更坏。
 *
 * 现在按「每个 `id:` 之前的那一段」切：只要 `id:` 还在，缩进、空行、注释怎么排都不影响。
 * 万一一条都读不出来，`coverageOf` 会把它当成「和导出的 id 名单对不上」报红——见那里的
 * `expected` 比对。
 */
export function gapDeclarations(source) {
  const text = String(source ?? '').replace(/\r\n/g, '\n')
  const out = []

  // 只在 GAP_RULES 那一段里找，避免把 QUESTION_RULES 也算进来（它们底下的 `review: '...'`
  // 会互相干扰）。边界是下一个顶层 `const` 或 `export`。
  const start = text.indexOf('const GAP_RULES = [')
  if (start === -1) return out
  const tail = text.slice(start)
  const stop = tail.slice('const GAP_RULES = ['.length).search(/\n(?:const|export|function) /)
  const body = stop === -1 ? tail : tail.slice(0, stop + 'const GAP_RULES = ['.length)

  // 每个规则以一行 `id: '...'` 起头；整张表就是这些行之间的片段。
  const idLines = [...body.matchAll(/^\s*id:\s*'([^']+)'\s*,\s*$/gm)]
  if (idLines.length === 0) return out

  for (const [i, hit] of idLines.entries()) {
    const from = hit.index
    const to = i + 1 < idLines.length ? idLines[i + 1].index : body.length
    const chunk = body.slice(from, to)
    out.push({
      id: hit[1],
      review: /\breview:\s*'([^']+)'/.exec(chunk)?.[1],
      decision: /\bdecision:\s*'([^']+)'/.exec(chunk)?.[1],
      surveyOnly: /\bsurveyOnly:\s*'([^']+)'/.exec(chunk)?.[1],
      hasQuestion: /\bquestion:\s*['"(]/.test(chunk),
    })
  }
  return out
}

/**
 * 从 `review.mjs` 里读出它实际会报的那些 id。
 *
 * 只认 `finding('<档>', '<切面>', '<id>'` 这种三参数写法：它是这个文件里唯一的报点形状，
 * 而三个位置参数里第三个才是 id。写错一个字母的 id（`git.typo`）在这一步就会被发现——
 * 否则映射看起来配好了，实际指向一条永远不会出现的结论。
 */
export function reviewIds(source) {
  const ids = new Set()
  for (const m of String(source ?? '').matchAll(/finding\(\s*'[^']*'\s*,\s*'[^']*'\s*,\s*'([^']+)'/g)) ids.add(m[1])
  return ids
}

/**
 * 每一条缺口落在哪一档。
 *
 * 返回 `{ ok, unclaimed, duplicated, dangling, missing, unknown }`：
 * 三档都没选的是 `unclaimed`；选了不止一档的是 `duplicated`（两处都管，结论会变成两个）；
 * `review` 指向一个 `review.mjs` 里不存在的 id 的是 `dangling`（映射看着有，实际空指）。
 *
 * ## `expected` 是必填的，不是可选的
 *
 * 只判「读出来的那些都配好了」是不够的：读出来的可能是**零条**。词法切块一旦失灵
 * （换格式化器、整体多缩两格），`declarations` 就成了空数组，而空数组让所有检查都通过
 * ——「0 条各有处置，退出码 0」，看起来比 17 条还干净。
 *
 * 所以登记的 id 名单是**必填参数**：不给就抛错。这是刻意的——一个可选参数被摘掉时
 * 什么都没发生，而一个必填参数被摘掉时程序当场崩，崩溃比静默通过好。
 * 早先它是可选的，于是「把第三个参数改成 null」这个动作能把整条双向比对削掉而不留痕。
 */
export function coverageOf(declarations, knownReviewIds, expected) {
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error('coverageOf 需要登记的 id 名单（第三参）。不给名单就无法判断「一条都没读出来」'
      + '这种情况——那时的结论会是「0 条各有处置」，看起来比实际还干净')
  }
  const ok = []
  const unclaimed = []
  const duplicated = []
  const dangling = []
  for (const d of declarations) {
    const chosen = [d.review, d.decision, d.surveyOnly].filter(Boolean)
    if (chosen.length > 1) duplicated.push(`${d.id}（同时写了 ${chosen.length} 档）`)
    else if (chosen.length === 0) unclaimed.push(d.id)
    else ok.push(d.id)
    if (d.review && knownReviewIds && !knownReviewIds.has(d.review)) {
      dangling.push(`${d.id} → ${d.review}`)
    }
  }

  const got = new Set(declarations.map((d) => d.id))
  const want = new Set(expected)
  const missing = [...want].filter((id) => !got.has(id))
  const unknown = [...got].filter((id) => !want.has(id))

  return { ok, unclaimed, duplicated, dangling, missing, unknown }
}

/**
 * 这个检查自己有多少条载荷？**这是它的自检。**
 *
 * 上一轮暴露的是一个更深的形状：`coverageOf` 的双向比对确实能抓住「读出来 0 条」，
 * 但**它自己被摘掉时没有人看守**——把第三个参数改成 `null`，17 条照样读出来、全部配好、
 * 全绿通过，而守卫已经不在。判据的守卫本身没有守卫，这是判据退化的最后一条路。
 *
 * 所以再加一层：**能读出的条数必须等于登记名单的条数，且不为零**。这个计算不依赖
 * `coverageOf` 的任何参数——它直接数 `GAP_RULE_IDS` 与词法结果，两者都从源码来。
 * 于是「比对被摘掉」不再是一种能悄悄发生的事：摘掉它，这一层仍然报数。
 *
 * @returns {{ declared: number, parsed: number, ok: boolean, detail: string }}
 */
export function selfCheck(source, expected) {
  const declared = Array.isArray(expected) ? expected.length : -1
  const parsed = gapDeclarations(source).length
  if (declared <= 0) {
    return { declared, parsed, ok: false, detail: '登记的 id 名单是空的——名单没导出，或导出写错了' }
  }
  if (parsed !== declared) {
    return {
      declared,
      parsed,
      ok: false,
      detail: `登记 ${declared} 条，只从源码里读出 ${parsed} 条——`
        + '词法切块与声明的形状对不上，缺的那几条从此没人查',
    }
  }
  return { declared, parsed, ok: true, detail: `${declared} 条缺口全部读出，条数与登记名单一致` }
}

/** 读真实源码跑一遍。门禁与行为断言共用这一个入口。 */
export async function checkGapCoverage(root = ROOT) {
  const source = readFileSync(join(root, 'scripts', 'survey.mjs'), 'utf8')
  const reviewSource = readFileSync(join(root, 'scripts', 'review.mjs'), 'utf8')
  // 登记的 id 名单从模块里取，不从源码里再解析一遍：两份解析器会给出两个答案，
  // 而其中一个答案决定了这个检查本身是否在工作。
  //
  // Windows 上绝对路径不能直接 import，要先转成 file:// URL——否则报的是一条
  // 与这里的判断毫无关系的加载错误，而它看起来像「检查坏了」。
  const { GAP_RULE_IDS } = await import(pathToFileURL(join(root, 'scripts', 'survey.mjs')).href)
  const counts = selfCheck(source, GAP_RULE_IDS)
  return { ...coverageOf(gapDeclarations(source), reviewIds(reviewSource), GAP_RULE_IDS), counts }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // ## 崩了也要说人话
  //
  // 这个检查里有一条「必填参数不给就抛错」的判断（`coverageOf` 的第三参）。它抛出来时，
  // 如果没人接，看到的是几十行调用栈——而调用栈不叫「失败」，它叫「不知道算不算失败」。
  // `verify-injections.mjs` 是按 `FAIL` 开头的行判的，堆栈一行都不匹配，于是那次注入会
  // 被记成「判据被拆掉却没人报」——把一次正确的崩溃误读成一条失守的判据。
  //
  // 所以把异常收成一行 `FAIL`：崩溃是一种失败，而且是最该被看见的那种。
  let state
  try {
    state = await checkGapCoverage()
  } catch (error) {
    process.stderr.write(`FAIL  缺口覆盖：这条判据没跑成——${error instanceof Error ? error.message : String(error)}\n`)
    process.stderr.write('缺口覆盖未通过：1 处有问题。\n')
    process.exit(1)
  }
  const { ok, unclaimed, duplicated, dangling, missing, unknown, counts } = state
  let bad = 0
  // 先报条数：这一层不依赖下面任何一档，所以它在「全都被摘掉」时仍然说话。
  if (!counts.ok) {
    process.stderr.write(`FAIL  条数自检：${counts.detail}\n`)
    bad += 1
  }
  for (const one of duplicated) {
    process.stderr.write(`FAIL  ${one}——一条缺口只能落一档，写两档会让结论出现两个版本\n`)
    bad += 1
  }
  for (const one of dangling) {
    process.stderr.write(`FAIL  ${one}：体检那边没有这个 id——映射看着配好了，实际指向一条永远不会出现的结论\n`)
    bad += 1
  }
  for (const id of unknown) {
    process.stderr.write(`FAIL  ${id} 出现在源码里，却不在登记的 id 名单里——源码与导出名单对不上\n`)
    bad += 1
  }
  for (const id of missing) {
    process.stderr.write(`FAIL  ${id} 在登记的 id 名单里，却没能从源码里读出来——`
      + '词法切块失灵了，这一条从此没人查（这正是「0 条各有处置却退出 0」的来源）\n')
    bad += 1
  }
  for (const id of unclaimed) {
    process.stderr.write(`FAIL  ${id} 在体检那边没人接——勘察报了、没人管，而它不会自己消失\n`
      + "        三种处置选一个：review: '<体检 id>' / decision: '<表态键>' / surveyOnly: '<为什么只有勘察管>'\n")
    bad += 1
  }
  process.stdout.write(bad === 0
    ? `缺口覆盖：${ok.length} 条各有处置（体检 / 表态 / 仅勘察），映射都指向真实结论。\n`
    : `缺口覆盖未通过：${bad} 处有问题。\n`)
  process.exit(bad === 0 ? 0 : 1)
}
