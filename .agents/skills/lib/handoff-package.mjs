/**
 * handoff.mjs —— 给子代理的交接包：把「这件事要做什么」从文档里搬出来。
 *
 * ## 它治的病
 *
 * `flow next` 早先只给机器事实：分支、SHA、风险档、轮次。**没有一句「这件事要做什么」。**
 * 于是主 Agent 派子代理时只能自己现编 prompt：去 SPEC 里摘 C 编号、摘影响路径、
 * 摘验收命令、摘禁改清单。
 *
 * 这段摘要是纯手工的，而且每派一次就要重写一遍。写到第十次的时候，它的上下文已经
 * 被前面九次的代码、diff、报错撑满了——摘要质量必然下降。**这就是「主 Agent 越干越蠢」
 * 的真实机制：该由机器搬的东西，压在了它的上下文里。**
 *
 * ## 这里做什么
 *
 * 从账本与规划文档里机械地抽出四样，拼成一段可以直接粘给子代理的话：
 *
 * 1. 这个切片认领了哪几条验收标准（`C1..Cn` 的原文）；
 * 2. 影响路径与禁改清单（`docsRequired` 之外的不许动）；
 * 3. 验收命令（从 `AGENTS.md` 的 Dev Profile 读，不在这里编）；
 * 4. 边界：只准在隔离位改，别再往主工作区写。
 *
 * ## 不认识的东西怎么办
 *
 * **不编。** 抽不到的项写「没有登记」，而不是填一句看起来合理的废话——
 * 子代理照着一句编出来的话干活，比什么都不给它更危险。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe } from './git.mjs'
import { parseDocFrontmatter, parseDocFilename } from './docs.mjs'

/** 从一份规划文档里抽出 `- [ ] Cn: ...` 的原文条目。 */
function extractCriteria(text) {
  const out = []
  for (const line of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const m = /^- \[[ xX]\]\s+(C\d+)\s*[:：]\s*(.+)$/.exec(line.trim())
    if (m) out.push({ id: m[1], text: m[2].trim() })
  }
  return out
}

/** 从 `## 影响路径` 一类表述里抽出反引号包住的相对路径。 */
function extractPaths(text) {
  const body = String(text ?? '')
  const section = /^##[^\n]*(?:影响路径|影响范围|涉及文件|改动路径)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)?.[1]
  if (!section) return []
  const found = [...section.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1].trim())
    .filter((p) => /[/\\]/.test(p) && !/^(?:TODO|TBD)$/i.test(p))
  return [...new Set(found)]
}

/**
 * 从 `## 本期不做` / `## 非目标` 里抽出条目文本。
 *
 * 两种写法都要认：小节形态（`## 本期不做` 带几条列表）与行内条目形态
 * （`- **本期不做**：…`）。短文档常用后者——判据关心的是「说没说」，不是「用了哪种排版」。
 */
function extractNonGoals(text) {
  const body = String(text ?? '').replace(/\r\n/g, '\n')
  const out = []

  const section = /^##[^\n]*(?:本期不做|明确不做|非目标|Non-Goals)[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m.exec(body)?.[1]
  if (section) {
    for (const line of section.split('\n')) {
      const item = line.replace(/^\s*[-*]\s*/, '').trim()
      if (item && !item.startsWith('<!--') && !/^无$/.test(item)) out.push(item)
    }
  }

  const inline = /^-\s*\*\*(?:本期不做|明确不做|非目标)\*\*\s*[:：]\s*(.+)$/gm
  for (const m of body.matchAll(inline)) {
    const item = m[1].trim()
    if (item && !out.includes(item)) out.push(item)
  }

  return out
}

/**
 * 组装交接包。
 *
 * @param {object} opts
 * @param {string} opts.mainRoot 主仓根
 * @param {object} opts.ledger 任务账本
 * @param {object} opts.policy 工作流策略（含 requiredGates）
 * @param {string|null} opts.headSha 当前 HEAD
 * @returns {{ prompt: string, fields: object }}
 */
export function buildHandoff({ mainRoot, ledger, policy = null, headSha = null }) {
  const specRel = ledger?.specFile ?? null
  const todoRel = ledger?.todoFile ?? null
  const specText = specRel && existsSync(join(mainRoot, specRel)) ? (readTextSafe(join(mainRoot, specRel)) ?? '') : ''
  const todoText = todoRel && existsSync(join(mainRoot, todoRel)) ? (readTextSafe(join(mainRoot, todoRel)) ?? '') : ''

  // 验收标准以 SPEC 为准，没有 SPEC 时退到 Todo。两者都没有就明说没有。
  const criteria = specText ? extractCriteria(specText) : extractCriteria(todoText)
  const sourceDoc = specText ? specRel : (todoText ? todoRel : null)
  const paths = [...new Set([...extractPaths(specText), ...extractPaths(todoText)])]
  const nonGoals = [...new Set([...extractNonGoals(specText), ...extractNonGoals(todoText)])]

  // 验收命令从 AGENTS.md 的 Dev Profile 读，不在这里编。
  const agentsText = readTextSafe(join(mainRoot, 'AGENTS.md')) ?? ''
  const quick = /^\s*quick-test:\s*(.+)$/m.exec(agentsText)?.[1]?.trim() ?? null
  const full = /^\s*full-test:\s*(.+)$/m.exec(agentsText)?.[1]?.trim() ?? null
  const mergeGate = /^\s*merge-gate:\s*(.+)$/m.exec(agentsText)?.[1]?.trim() ?? null

  const lines = []
  lines.push(`# 交接包：${ledger?.taskId ?? '(未知任务)'}`)
  lines.push('')
  lines.push('> 这一段由 `flow next --handoff` 机械生成，可以直接粘给子代理。')
  lines.push('> 抽不到的项写「没有登记」——不编。照着一句编出来的话干活，比什么都不给更危险。')
  lines.push('')

  lines.push('## 你在做什么')
  lines.push('')
  if (criteria.length > 0) {
    lines.push(`这个切片认领了 ${criteria.length} 条验收标准（来源：\`${sourceDoc}\`）：`)
    lines.push('')
    for (const c of criteria) lines.push(`- [ ] **${c.id}**：${c.text}`)
  } else {
    lines.push('**没有登记验收标准。** 这不等于「随便做」——先把 SPEC 或 Todo 里的 `C1..Cn` 写出来再动手；')
    lines.push('动手前定不下来，说明这件事还没想清楚。')
  }
  lines.push('')

  lines.push('## 能改哪里')
  lines.push('')
  if (paths.length > 0) {
    lines.push('影响路径（来自规划文档）：')
    lines.push('')
    for (const p of paths) lines.push(`- \`${p}\``)
  } else {
    lines.push('**没有登记影响路径。** 动手前先自己定位，并在提交说明里写清实际改了哪些文件。')
  }
  lines.push('')
  lines.push('**只准在隔离位改。** 主工作区一律不碰——那会让「这次改动包含什么」变得说不清。')
  lines.push(`- 实施位：\`${ledger?.worktreePath ?? '(分支模式，无独立工作区)'}\``)
  lines.push(`- 分支：\`${ledger?.branch ?? '(未登记)'}\` → 基线 \`${ledger?.baseBranch ?? 'main'}\``)
  lines.push(`- 起始 HEAD：\`${headSha ?? ledger?.baseSha ?? '(未登记)'}\``)
  lines.push('')

  if (nonGoals.length > 0) {
    lines.push('## 不许顺手做什么')
    lines.push('')
    for (const g of nonGoals) lines.push(`- ${g}`)
    lines.push('')
  }

  lines.push('## 怎么算做完')
  lines.push('')
  if (quick || full) {
    if (quick) lines.push(`- 快测：\`${quick}\``)
    if (full) lines.push(`- 全测：\`${full}\``)
    if (mergeGate) lines.push(`- 合前：\`${mergeGate}\``)
    lines.push('')
    lines.push('**跑出来的才算做完。** 拿不出实际通过输出，不要说「已验证」。')
  } else {
    lines.push('**`AGENTS.md` 的 Dev Profile 里没有登记验收命令。** 先补齐再动手——没有验收命令的完成是自我声明。')
  }
  lines.push('')

  const gates = policy?.requiredGates ?? []
  if (gates.length > 0) {
    lines.push('## 这门改动的必过门')
    lines.push('')
    for (const g of gates) lines.push(`- \`${g}\``)
    lines.push('')
  }

  return {
    prompt: `${lines.join('\n').trimEnd()}\n`,
    fields: {
      taskId: ledger?.taskId ?? null,
      sourceDoc,
      criteriaCount: criteria.length,
      criteria,
      paths,
      nonGoals,
      commands: { quick, full, mergeGate },
      requiredGates: gates,
    },
  }
}
