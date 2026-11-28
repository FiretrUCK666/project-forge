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

export function renderVars(text, vars = {}) {
  const source = String(text ?? '')
  // 取占位名时要先剥掉宿主语法（`${{ ... }}`），否则 `${{GITHUB_SHA}}` 会被当成
  // 本工具的 `{{GITHUB_SHA}}`——它的名字恰好是全大写，正好落在「未登记」那一类，
  // 于是用了 Actions 表达式的项目一条命令都跑不了。豁免必须在**所有**检查之前，
  // 不能只加在形状检查那一处。
  const hostStripped = source.replace(/\$\{\{[\s\S]*?\}\}/g, '')
  const used = [...new Set([...hostStripped.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))]
  const unknown = used.filter((name) => !TEMPLATE_VARS.includes(name))
  if (unknown.length > 0) {
    throw new TemplateError(`模板里有未登记的占位符：${unknown.map((n) => `{{${n}}}`).join('、')}（见 lib/protocol.mjs 的 TEMPLATE_VARS）`)
  }
  const missing = used.filter((name) => vars[name] === undefined)
  if (missing.length > 0) {
    throw new TemplateError(`这些占位符没有对应的取值：${missing.map((n) => `{{${n}}}`).join('、')}`)
  }

  const shapes = new Set()
  for (const m of hostStripped.matchAll(/\{\{[\s\S]*?\}\}/g)) {
    const raw = m[0]
    if (/^\{\{[A-Z0-9_]+\}\}$/.test(raw)) continue
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
