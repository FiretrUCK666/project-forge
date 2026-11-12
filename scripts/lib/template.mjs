/**
 * template.mjs —— 把模板变成一份能给项目用的文件。
 *
 * ## 它只做两件事
 *
 * 一、**条件求值**：`if <cond> … endif` 为真就剥掉两行标记、留下正文；为假就整块移除。
 * 二、**变量替换**：把 `{{VAR}}` 换成勘察出来的值。
 *
 * ## 为什么条件块必须在这一层消失
 *
 * `begin`/`end`/`fill` 三类标记是**要留在项目文件里**的：它们声明「这一段归谁维护」，
 * 将来刷新、体检、交棒都要靠它。条件块不同——它回答的是「这个项目该不该有这一节」，
 * 那个问题在渲染那一刻就有答案了，把问题本身留在文件里毫无意义。
 *
 * 更要紧的是：留在文件里会**改变标记协议的含义**。`handoff --verify` 把「还有标记」
 * 读成「不干净」，项目里就会出现一处永远擦不掉的痕迹；而 `--clean` 又把 `if`/`endif`
 * 当未知标记留着，两层语义越错越远。
 *
 * 所以规矩是硬的：**渲染产物里出现 `project-forge: if` 就是错**，`preflight` 会判红。
 *
 * ## 为什么未登记的变量要报错
 *
 * 一个没被替换的 `{{COMMANDS}}` 留在用户的 `AGENTS.md` 里，看起来像「这里本来就该有
 * 一段命令」。它不会被任何人发现，直到有人照着它去找命令。原样保留是最坏的失败方式：
 * 它不报错、不显眼、而且看起来像是有内容的。
 */

import {
  TEMPLATE_CONDITIONS, TEMPLATE_VARS, conditionMarkers,
} from './protocol.mjs'

/** 渲染失败时抛这个。调用方负责把它变成一句人话和退出码。 */
export class TemplateError extends Error {}

/**
 * 对模板做条件求值，返回渲染后的文本。
 *
 * `condMap` 里没写到的条件**按假处理**——这是保守方向：少出现一节，读者会发现「这里
 * 该有却没有」；多出现一节不适用的话，读者会照着去执行一件对他不存在的事。
 *
 * 嵌套是允许的：外层为假时整块连同内层一起消失，所以从内向外、多次扫描直到没有
 * `if` 为止。
 */
export function evaluateConditions(text, condMap = {}, file = 'template.md') {
  const unknown = Object.keys(condMap).filter((name) => !TEMPLATE_CONDITIONS.includes(name))
  if (unknown.length > 0) {
    throw new TemplateError(`条件表里有未登记的条件名：${unknown.join('、')}（见 lib/protocol.mjs 的 TEMPLATE_CONDITIONS）`)
  }

  let lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')

  // **模板正文里用到的条件名也要校验。**
  //
  // 早先只校验调用方传进来的那张表，于是 `if has-cmnds` 这种拼写错误会被当成「条件为假」
  // 整块删掉——不报错、退出码 0、产出一份少了整节却看不出任何异常的契约。而唯一的守卫
  // 在 `scripts/dev/preflight.mjs` 里，那目录不进用户包，所以拿到包的人撞上时没有救。
  //
  // 判据放在这里而不是放在门禁里：这是求值器的输入校验，它必须随这份代码走。
  const declared = new Set(conditionMarkers(lines.join('\n'), file).filter((m) => m.kind === 'if').map((m) => m.cond))
  const badConds = [...declared].filter((c) => !TEMPLATE_CONDITIONS.includes(c))
  if (badConds.length > 0) {
    throw new TemplateError(`${file} 里用了未登记的条件名：${badConds.join('、')}`
      + '——它会被当成「条件为假」整块删掉，不报错也不留痕（见 lib/protocol.mjs 的 TEMPLATE_CONDITIONS）')
  }

  for (;;) {
    const marks = conditionMarkers(lines.join('\n'), file)
    if (marks.length === 0) break

    // 从后往前找**最内层**的一对：遇到 `endif` 时往回找最近的未配对 `if`。
    const stack = []
    let pair
    for (const mark of marks) {
      if (mark.kind === 'if') stack.push(mark)
      else {
        const open = stack.pop()
        if (!open) throw new TemplateError(`第 ${mark.line} 行有 endif 但没有对应的 if`)
        pair = { open, close: mark }
        break
      }
    }
    if (!pair) {
      const open = stack[stack.length - 1]
      throw new TemplateError(`第 ${open.line} 行的 if ${open.cond} 没有对应的 endif`)
    }

    const keep = condMap[pair.open.cond] === true
    const body = lines.slice(pair.open.index + 1, pair.close.index)
    const replacement = keep ? body : []
    lines = [
      ...lines.slice(0, pair.open.index),
      ...replacement,
      ...lines.slice(pair.close.index + 1),
    ]
  }

  return lines.join('\n')
}

/**
 * 替换全部 `{{VAR}}`。
 *
 * 两处刻意：**未登记的变量名报错**（不许把洞留在文件里）；**登记了但没给值也报错**
 * （同上，只是错在另一头）。
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
  let out = source
  for (const name of used) out = out.split(`{{${name}}}`).join(String(vars[name]))

  // **任何形状的 `{{…}}` 都不许留在产物里。**
  //
  // 上面那条正则只认全大写的名字，所以 `{{release_doc}}`、`{{ PROJECT_NAME }}`、
  // `{{PROJECT-NAME}}` 一律匹配不上：它们既不会被替换，也不会被报出来，就那么原样躺在
  // 用户的 `AGENTS.md` 里。而那正是「渲染产物零残留」这条不变量要防的东西——
  // 一个 `{{COMMANDS}}` 看起来像「这里本来就该有东西」，没人会去处理它。
  //
  // 判据是「替换完还剩什么」，不是「名字登不登记」：`{{ PROJECT_NAME }}` 里面那个名字
  // 是登记过的，带空格之后却替换不到——按名字放行就正好漏掉这一种。
  //
  // 校验放在这里，不放在门禁里：门禁那套正则与这里同源，同样的盲区会一起瞎。
  const leftovers = [...new Set([...out.matchAll(/\{\{[^}]*\}\}/g)].map((m) => m[0]))]
  if (leftovers.length > 0) {
    throw new TemplateError(`渲染之后还剩这些占位符：${leftovers.join('、')}`
      + '——占位符必须是全大写的已登记名字、且前后紧贴大括号（`{{NAME}}` 而不是 `{{ NAME }}`）；'
      + '写成别的形状既不会被替换，也不会有人发现')
  }
  return out
}

/**
 * 完整渲染：先条件求值，再变量替换。
 *
 * 顺序不能反：变量替换发生在条件求值之后，才能保证「这一节被裁掉了，它里面的变量就
 * 不必有值」。反过来的话，一个不适用模块里的变量会要求调用方凭空造一个值出来。
 */
export function renderTemplate(text, condMap, vars, file = 'template.md') {
  return renderVars(evaluateConditions(text, condMap, file), vars)
}

/** 渲染产物里**不允许**出现的标记（出现了就是漏了一层求值）。 */
export function residualConditionMarkers(text) {
  return conditionMarkers(text, 'AGENTS.md')
}
