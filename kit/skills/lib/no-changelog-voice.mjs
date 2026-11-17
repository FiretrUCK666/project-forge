/**
 * no-changelog-voice.mjs —— 认「履历体注释」，让「只写现状」这条规矩可被机器检查。
 *
 * ## 治的病
 *
 * 代码和文档里到处是这种句子：
 *
 * > 早先这里是 `cleanLines.join(' && ')`：控制流被压平，互不相干的语句拼在一起。
 * > 以前是七节固定表单，现在改成可选章节。
 *
 * 写的时候觉得是在解释「为什么这么改」，但**下一个人读到的是一份过期的对照表**：
 * 他不知道「早先」是哪个版本，「现在」是不是还是现在。半年后没人敢删这些句子，
 * 因为分不清哪句是历史、哪句是当前约束。
 *
 * 真正该留下的信息只有一句：**现在为什么这么做**。哪次改动、谁改的，在提交记录里。
 *
 * ## 判据
 *
 * 只认**明确指向时间先后**的词。不是说这些词绝对不能出现——
 * `## 现状与痛点` 里的「现状」是文档内容不是履历，`// 不再是可选项` 可能是在描述行为。
 * 所以分两档：
 *
 * - **强信号**（默认报）：`早先`、`以前是`、`原来是`、`后来改`、`曾经`、`过去是`；
 * - **弱信号**（只在同一行同时出现旧值与新值的对照时才报）：`现在改成`、`改成这样`。
 *
 * 判据的目标不是「一条都不许有」，是**让新增的能被发现**。存量用基线文件冻结，
 * 只对新增的部分报错——这样它是一件能落地的规矩，而不是一个永远红的检查。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe } from './git.mjs'

/** 明确指向「以前怎么怎么样」的词。 */
const STRONG = [
  '早先', '以前是', '以前这里', '原来是', '原来这里', '后来改', '后来才', '曾经', '过去是',
  '老版本', '旧版本里', '之前这里是', '原本是',
]

/** 只有同时出现新旧对照才算履历的弱信号。 */
const WEAK = ['现在改成', '改成这样', '不再是', '已经不']

/** 同一行里出现这些，说明是在做新旧对照。 */
const CONTRAST = /(?:现在|改成|换成|改为|变成)/

/** 文档里本来就该出现这些词的场景：讲现状的章节标题、引用原文、规则条文本身。 */
const LEGIT_LINE = [
  /^#{1,6}\s*(?:现状|背景|动机|问题)/,
  /(?:引|摘自|原文|用户说的|Issue\s*#)/,
  // 规则条文本身要举例说明「什么算履历体」，此时的词是**被引用的对象**，不是履历。
  /(?:如|例如|比如|形如|诸如)[^\n]{0,20}(?:早先|以前是|原来|曾经|后来)/,
  /[`「『][^`」』]{0,30}(?:早先|以前是|原来是|曾经)[^`」』]{0,30}[`」』]/,
]

/**
 * 从一段文本里找出履历体句子。
 *
 * @param {string} text
 * @param {{file?: string}} [opts]
 * @returns {Array<{file: string, line: number, word: string, text: string}>}
 */
export function findChangelogVoice(text, opts = {}) {
  const out = []
  const lines = String(text ?? '').split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (LEGIT_LINE.some((re) => re.test(line))) continue
    const strong = STRONG.find((w) => line.includes(w))
    if (strong) {
      out.push({ file: opts.file ?? '', line: i + 1, word: strong, text: line.trim() })
      continue
    }
    const weak = WEAK.find((w) => line.includes(w))
    if (weak && CONTRAST.test(line)) {
      out.push({ file: opts.file ?? '', line: i + 1, word: weak, text: line.trim() })
    }
  }
  return out
}

/**
 * 与基线比对，只报**新增**的履历体句子。
 *
 * 基线是一个 `文件 -> 条数` 的表。用条数而不是行号：行号会随无关改动漂移，
 * 条数只在真的又写了一处时才变。
 *
 * @param {Array} found 本次扫到的
 * @param {Record<string, number>} baseline 基线
 * @returns {Array} 超出基线的部分
 */
export function findNewChangelogVoice(found, baseline = {}) {
  const used = new Map()
  const out = []
  for (const item of found) {
    const key = item.file
    const n = (used.get(key) ?? 0) + 1
    used.set(key, n)
    if (n > (baseline[key] ?? 0)) out.push(item)
  }
  return out
}

/**
 * 生成基线表。
 *
 * @param {Array} found
 * @returns {Record<string, number>}
 */
export function buildChangelogVoiceBaseline(found) {
  const counts = {}
  for (const item of found) counts[item.file] = (counts[item.file] ?? 0) + 1
  return counts
}

/** 读基线文件。读不到就当空基线。 */
export function readChangelogVoiceBaseline(root, rel = '.github/changelog-voice-baseline.json') {
  const abs = join(root, rel)
  if (!existsSync(abs)) return {}
  try {
    return JSON.parse(readTextSafe(abs) ?? '{}')
  } catch {
    return {}
  }
}
