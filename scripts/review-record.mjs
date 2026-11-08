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
 * ## 高风险路径从哪儿来
 *
 * **不写在这份代码里**，从**这个项目自己的** `AGENTS.md` 读：里面有一张
 * 「高风险路径」表（`templates/agents-project.md` 生成契约时留了那个位置）。
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
 * `--root` 缺省是当前目录：契约与高风险路径表都从那里读。
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
 * 表长这样（`templates/agents-project.md` 生成契约时留了那个位置）：
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
  const text = String(agentsText ?? '')
  const head = /^##+[ \t]*高风险路径[ \t]*$/m.exec(text)
  if (head === null) return []
  const after = text.slice(head.index + head[0].length)
  const nextHead = /^##+[ \t]/m.exec(after)
  const block = nextHead === null ? after : after.slice(0, nextHead.index)
  const out = []
  for (const line of block.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(trimmed) && trimmed.includes('-')) continue
    const first = trimmed.split('|')[1]?.trim() ?? ''
    if (first === '' || /^路径$/.test(first)) continue
    // 反引号包着就用里面的；没有反引号就整格当路径（requirements = 不强求写法）。
    const m = /^\`([^\`]+)\`$/.exec(first)
    const p = (m === null ? first : m[1]).replace(/\\/g, '/').replace(/^\.\//, '').trim()
    if (p !== '' && !p.startsWith('<')) out.push(p)
  }
  return [...new Set(out)]
}

/**
 * 这个路径算不算高风险。
 *
 * 判据是**前缀**，不是逐文件清单：清单要人记得改，而目录不会长出新的一处。
 * 结尾带 `/` 的按目录前缀比；否则按整段相等——这样 `scripts-dev/` 不会被
 * `scripts/` 误伤（用 `includes` 就会，实测过）。
 */
export function isHighRiskPath(rel, prefixes) {
  const p = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (p === '') return false
  const list = Array.isArray(prefixes) ? prefixes : []
  return list.some((pre) => (pre.endsWith('/') ? p.startsWith(pre) : p === pre))
}

/** 从一份改动清单里挑出高风险的那几条（去重、排序，报告里好读）。 */
export function highRiskChanged(paths, prefixes) {
  return [...new Set(paths.map((x) => String(x).trim()).filter(Boolean)
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
    '用法：node scripts/review-record.mjs --changed <清单文件|-> --body <提案正文> [选项]',
    '',
    '  改动落在**高风险路径**时，提案正文必须有「## 审查记录」且真的填过。',
    '  它拦的是「CI 绿了就合并、压根没派审查」那一种。',
    '',
    '  高风险路径不写死在代码里，从 `<项目>/AGENTS.md` 的「## 高风险路径」表读。',
    '  那张表由 `templates/agents-project.md` 生成契约时留了位置，每个项目自己填。',
    '',
    '  --changed         每行一个改动路径的文件；`-` 表示从 stdin 读（`git diff --name-only` 直接接）',
    '  --body            提案正文（Markdown 文件）',
    '  --root            项目目录；缺省从脚本位置推（本脚本在 <项目>/scripts/ 下，往上一层就是根）',
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
  let expectChanges = false
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--changed') { changedArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--body') { bodyArg = argv[i + 1]; i += 1; continue }
    if (argv[i] === '--root') { rootArg = argv[i + 1]; i += 1; continue }
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
  if (existsSync(agentsPath)) {
    prefixes = readHighRiskPaths(readFileSync(agentsPath, 'utf8'))
  } else {
    contractMissing = true
  }
  if (prefixes.length === 0) {
    // **不静默放行**：说清这一趟什么也没拦。绿着但一个字都没查，是这套机制里最坏的失效。
    process.stderr.write([
      contractMissing
        ? `没有读到项目契约：${agentsPath} 不存在`
        : `项目契约里没有「## 高风险路径」表（或表是空的）：${agentsPath}`,
      '',
      '  这一趟**没有做任何审查记录检查**——没有「哪几处算高风险」这份声明，就无从判断。',
      '  补上那张表即可启用（骨架见 `templates/agents-project.md` 的「改动怎么落地」一节）：',
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
    '',
    '  **一轮不够就再来一轮**：审查结论是「需要返工」时，改完要**重新派一个新的上下文**，',
    '  不要把上一轮的结论喂给它——带着别人的判断去读，读出来的是复核，不是审查。',
    '  每一轮的结论与发现都补进「## 审查记录」，那一栏是累积的，不是覆盖的。',
  ].join('\n') + '\n')
  return 1
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exitCode = main(process.argv.slice(2))
}
