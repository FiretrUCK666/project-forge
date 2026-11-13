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
import { fileURLToPath } from 'node:url'

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

  for (const chunk of body.split(/\n  \{\n/).slice(1)) {
    const id = /\bid:\s*'([^']+)'/.exec(chunk)?.[1]
    if (id === undefined) continue
    out.push({
      id,
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
 * 返回 `{ ok, unclaimed, duplicated, dangling }`：
 * 三档都没选的是 `unclaimed`；选了不止一档的是 `duplicated`（两处都管，结论会变成两个）；
 * `review` 指向一个 `review.mjs` 里不存在的 id 的是 `dangling`（映射看着有，实际空指）。
 */
export function coverageOf(declarations, knownReviewIds = null) {
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
  return { ok, unclaimed, duplicated, dangling }
}

/** 读真实源码跑一遍。门禁与行为断言共用这一个入口。 */
export function checkGapCoverage(root = ROOT) {
  const source = readFileSync(join(root, 'scripts', 'survey.mjs'), 'utf8')
  const reviewSource = readFileSync(join(root, 'scripts', 'review.mjs'), 'utf8')
  return coverageOf(gapDeclarations(source), reviewIds(reviewSource))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { ok, unclaimed, duplicated, dangling } = checkGapCoverage()
  let bad = 0
  for (const one of duplicated) {
    process.stderr.write(`FAIL  ${one}——一条缺口只能落一档，写两档会让结论出现两个版本\n`)
    bad += 1
  }
  for (const one of dangling) {
    process.stderr.write(`FAIL  ${one}：体检那边没有这个 id——映射看着配好了，实际指向一条永远不会出现的结论\n`)
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
