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
 * ## 它能证明什么、不能证明什么
 *
 * 能证明：**这一栏填了**，且填的不是空模板。这条已经足够拦住「压根没派审查」——
 * 那正是要拦的。
 *
 * 不能证明：审查的人真的读了代码、真的发现了该发现的问题。**判据不能假装能判它判不了的
 * 东西**：那会让一条真检查被读成一条假保证。所以这里的措辞只说到「有记录」为止。
 *
 * ## 用法
 *
 *   node scripts/dev/review-record.mjs --changed <改动文件清单> --body <提案正文文件>
 *
 * `--changed` 可以是一个文件（每行一个路径），也可以是 `-` 表示从 stdin 读。
 * 退出码：0 = 通过（或本次改动不含高风险路径）；1 = 有高风险改动但审查记录是空的；
 * 2 = 用法错误。
 */

import { existsSync, readFileSync } from 'node:fs'

import { isMainModule } from '../lib/text.mjs'

/**
 * 高风险路径：**改在这里出错不会当场失败，而是让门禁从此少查一项**。
 *
 * 这张表是本仓库自己那四处的代码形态。它与 `AGENTS.md`「协作」一节、以及
 * `references/collaboration.md` 第五节说的是同一件事——三处必须一致，所以
 * `preflight.mjs` 会核对这三个来源（见 `checkReviewRuleSources`）。
 *
 * 判据是**目录前缀**，不是逐文件清单：清单要人记得改，而目录不会长出新的一处。
 */
export const HIGH_RISK_PREFIXES = Object.freeze([
  'scripts/',                 // 判定逻辑
  'templates/',               // 落盘骨架
  '.github/workflows/',       // 门禁本身
  '.gitattributes',           // 决定用户包里有什么
])

/** 这个路径算不算高风险。 */
export function isHighRiskPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (p === '') return false
  return HIGH_RISK_PREFIXES.some((pre) => (pre.endsWith('/') ? p.startsWith(pre) : p === pre))
}

/** 从一份改动清单里挑出高风险的那几条（去重、排序，报告里好读）。 */
export function highRiskChanged(paths) {
  return [...new Set(paths.map((x) => String(x).trim()).filter(Boolean).filter(isHighRiskPath))].sort()
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
 * 判据分三层，任一成立即算填过：
 *   1. 那一节里有一行表格数据（第一格不是空的、也不是表头或分隔线）；
 *   2. 明说「本档不需要审查」——低档改动本来就免审，留空与免审要能分开；
 *   3. 有非表格的自由文字（有人不按表格写，那也算写了）。
 *
 * 返回 { filled, section, why }：`section === false` 表示连那一节都没有。
 */
export function reviewRecordState(body) {
  const text = String(body ?? '')
  const visible = stripComments(text)
  const head = /^##[ \t]*审查记录[ \t]*$/m.exec(visible)
  if (head === null) return { filled: false, section: false, why: '正文里没有「## 审查记录」这一节' }
  const after = visible.slice(head.index + head[0].length)
  const nextHead = /^##[ \t]/m.exec(after)
  const body2 = nextHead === null ? after : after.slice(0, nextHead.index)
  const lines = body2.split(/\r?\n/).map((l) => l.trim())

  const isSeparator = (l) => /^\|[\s:|-]+\|$/.test(l) && l.includes('-')
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim())
  for (const line of lines) {
    if (line === '' || isSeparator(line)) continue
    if (line.startsWith('|')) {
      const c = cells(line)
      if (c.length === 0) continue
      if (/^轮次$/.test(c[0]) || /^谁审/.test(c[1] ?? '')) continue
      if (c.some((x) => x !== '')) return { filled: true, section: true, why: '有审查记录行' }
      continue
    }
    // 非表格的自由文字：明说免审，或者干脆是一段话。
    if (line !== '') return { filled: true, section: true, why: '有文字记录' }
  }
  return { filled: false, section: true, why: '「审查记录」这一节是空的（模板没填）' }
}

function usage() {
  return [
    '用法：node scripts/dev/review-record.mjs --changed <清单文件|-> --body <提案正文>',
    '',
    '  改动落在高风险路径（判定逻辑、模板、工作流、包排除规则）时，提案正文必须有',
    '  「## 审查记录」且真的填过。它拦的是「CI 绿了就合并、压根没派审查」那一种。',
    '',
    '  --changed  每行一个改动路径的文件；`-` 表示从 stdin 读（`git diff --name-only` 直接接）',
    '  --body     提案正文（Markdown 文件）',
    '',
    '  退出码：0 = 通过；1 = 有高风险改动但审查记录是空的；2 = 用法错误。',
  ].join('\n')
}

function main(argv) {
  let changedArg
  let bodyArg
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--changed') { changedArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--body') { bodyArg = argv[i + 1]; i += 1; continue }
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
  const high = highRiskChanged(raw.split(/\r?\n/))
  if (high.length === 0) {
    process.stdout.write('审查记录：本次改动不落在高风险路径，不需要审查记录。\n')
    return 0
  }

  const body = bodyArg === '-' ? readFileSync(0, 'utf8') : readFileSync(bodyArg, 'utf8')
  const state = reviewRecordState(body)
  if (state.filled) {
    process.stdout.write(`审查记录：有（${state.why}）。本次动到 ${high.length} 处高风险路径。\n`)
    return 0
  }

  process.stderr.write([
    `审查记录缺失：这次改到了 ${high.length} 处高风险路径，提案正文里没有可用的审查记录。`,
    '',
    '  高风险路径（出错不会当场失败，而是让门禁从此少查一项）：',
    ...high.slice(0, 12).map((p) => `    - ${p}`),
    ...(high.length > 12 ? [`    …等 ${high.length} 处`] : []),
    '',
    `  原因：${state.why}`,
    '',
    '  怎么办：派一个**新上下文**去审（子代理或新会话），只给材料清单、不给执行者思路，',
    '  然后把它给出的结论行与逐条发现填进「## 审查记录」一节。',
    '',
    '  **CI 绿不等于审过**：门禁判的是「现有检查有没有过」，审查判的是「这次改动有没有让',
    '  检查本身变松」。这两件事完全正交，前者绿了不代表后者做过。',
  ].join('\n') + '\n')
  return 1
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
