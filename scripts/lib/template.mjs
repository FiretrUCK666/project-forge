/**
 * template.mjs —— 把模板变成一份能给项目用的文件（O(N) 单遍栈式求值与占位符校验）。
 *
 * - 条件求值：`if <cond> … endif` 为真剥除标记保留正文，为假整块移除（支持嵌套）。
 * - 变量替换：把 `{{VAR}}` 替换为勘察取值；未登记或遗漏取值立即报错。
 */

import {
  TEMPLATE_CONDITIONS, TEMPLATE_VARS, conditionMarkers,
} from './protocol.mjs'

/** 渲染失败时抛这个。调用方负责把它变成一句人话和退出码。 */
export class TemplateError extends Error {}

/**
 * 单遍 O(N) 栈式条件求值，返回渲染后的文本。
 * 严格校验 `condMap` 与模板正文中的所有条件名及配对闭合关系。
 */
export function evaluateConditions(text, condMap = {}, file = 'template.md') {
  const unknown = Object.keys(condMap).filter((name) => !TEMPLATE_CONDITIONS.includes(name))
  if (unknown.length > 0) {
    throw new TemplateError(`条件表里有未登记的条件名：${unknown.join('、')}（见 lib/protocol.mjs 的 TEMPLATE_CONDITIONS）`)
  }

  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const marks = conditionMarkers(normalized, file)
  if (marks.length === 0) return normalized

  const declared = new Set(marks.filter((m) => m.kind === 'if').map((m) => m.cond))
  const badConds = [...declared].filter((c) => !TEMPLATE_CONDITIONS.includes(c))
  if (badConds.length > 0) {
    throw new TemplateError(`${file} 里用了未登记的条件名：${badConds.join('、')}`
      + '——它会被当成「条件为假」整块删掉，不报错也不留痕（见 lib/protocol.mjs 的 TEMPLATE_CONDITIONS）')
  }

  const lines = normalized.split('\n')
  const markByIndex = new Map()
  for (const m of marks) markByIndex.set(m.index, m)

  const out = []
  const stack = []
  let active = true

  for (let i = 0; i < lines.length; i += 1) {
    const mark = markByIndex.get(i)
    if (mark) {
      if (mark.kind === 'if') {
        const nextActive = active && condMap[mark.cond] === true
        stack.push({ cond: mark.cond, line: mark.line, prevActive: active })
        active = nextActive
      } else {
        const opened = stack.pop()
        if (!opened) {
          throw new TemplateError(`第 ${mark.line} 行有 endif 但没有对应的 if`)
        }
        active = opened.prevActive
      }
      continue
    }
    if (active) out.push(lines[i])
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]
    throw new TemplateError(`第 ${unclosed.line} 行的 if ${unclosed.cond} 没有对应的 endif`)
  }

  return out.join('\n')
}

/**
 * 替换全部 `{{VAR}}`；未登记变量、缺失取值或模板正文里形状不对的占位符立即报错。
 *
 * ## 只扫模板正文，不扫替换之后的结果
 *
 * 早先这里在替换**之后**再用 `/{{[^}]*}}/g` 扫全文找残留。它分不清「模板作者写的 `{{`」
 * 与「被替换进来的数据里的 `{{`」，于是一条来自 CI `run:` 块的命令就能把渲染打崩：
 *
 *     renderVars('cmd: {{COMMANDS}}', { COMMANDS: 'TAG="${{ github.ref_name }}"' })
 *     -> TemplateError: 渲染之后还剩这些占位符：{{ github.ref_name }}
 *
 * GitHub Actions 的表达式恰好也是 `${{ }}`。用 Actions 的项目，`compose-agents`
 * 一个子命令都跑不了（`--check` / `--status` / 默认模式全崩，退出码都是 2）。
 *
 * 判据要有主语：这段双大括号是模板作者的、还是项目数据的？模板作者的才归这里管。
 * 所以形状检查移到替换之前，只看**模板正文**；替换进去的值原样保留，一个字都不再解释。
 *
 * 顺带：`${{ ... }}` 是宿主的模板语法，不是本工具的占位符，即使出现在正文里也放过。
 */
export function renderVars(text, vars = {}) {
  const source = String(text ?? '')
  const used = [...new Set([...source.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))]
  const unknown = used.filter((name) => !TEMPLATE_VARS.includes(name))
  if (unknown.length > 0) {
    throw new TemplateError(`模板里有未登记的占位符：${unknown.map((n) => `{{${n}}}`).join('、')}（见 lib/protocol.mjs 的 TEMPLATE_VARS）`)
  }
  const missing = used.filter((name) => vars[name] === undefined)
  if (missing.length > 0) {
    throw new TemplateError(`这些占位符没有对应的取值：${missing.map((n) => `{{${n}}}`).join('、')}`)
  }

  const shapes = new Set()
  for (const m of source.matchAll(/\{\{[\s\S]*?\}\}/g)) {
    const raw = m[0]
    if (/^\{\{[A-Z0-9_]+\}\}$/.test(raw)) continue
    // 宿主的模板语法（`${{ ... }}`）不是本工具的占位符，不归这里管。
    if (source[m.index - 1] === '$') continue
    shapes.add(raw)
  }
  if (shapes.size > 0) {
    throw new TemplateError(`模板正文里有这些形状不对的占位符：${[...shapes].join('、')}`
      + '——占位符必须是全大写的已登记名字、且前后紧贴大括号（`{{NAME}}` 而不是 `{{ NAME }}`）；'
      + '写成别的形状既不会被替换，也不会有人发现')
  }

  let out = source
  for (const name of used) out = out.split(`{{${name}}}`).join(String(vars[name]))
  return out
}

/**
 * 完整渲染：先条件求值，再变量替换。
 */
export function renderTemplate(text, condMap, vars, file = 'template.md') {
  return renderVars(evaluateConditions(text, condMap, file), vars)
}

/** 渲染产物里不允许出现的标记。 */
export function residualConditionMarkers(text) {
  return conditionMarkers(text, 'AGENTS.md')
}
