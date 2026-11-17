/**
 * 把一个刚生成的工程文档「填成可交付状态」。
 *
 * 夹具关心的是**生命周期**（重命名、审计、归档、认领），不是「每个占位符长什么样」。
 * 早先各处夹具逐个写死自己那份 `replace('<...>', ...)` 清单，模板一改（换措辞、
 * 加一节、把某节改成占位）就集体失效——失效的还是「跟被测逻辑无关」的那部分。
 *
 * 这里统一处理：凡是模板尖括号占位、`待补齐` 兜底值、C 编号示范行，一律填成真实内容。
 * 需要保留占位去测「未填要拦」的夹具不走这个函数。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const ANGLE_RE = /<[^<>\n]{2,120}>/g

/** 每种文档的验收标准默认值。填进 `- [ ] C1: ...` 的位置。 */
const DEFAULT_CRITERIA = {
  spec: ['执行 node --test 全部通过', '异常输入返回明确错误码'],
  todo: ['执行 node --test 全部通过', '异常输入返回明确错误码'],
  prd: ['命令退出码为 0', '输出里含预期字段'],
}

/**
 * @param {string} absPath 文档绝对路径
 * @param {{criteria?: string[], filled?: string, extra?: Array<[RegExp|string, string]>}} opts
 */
export function hydrateGeneratedDoc(absPath, opts = {}) {
  const filled = opts.filled ?? '已核实'
  let txt = readFileSync(absPath, 'utf8')

  // 1) 门型必须落在合法枚举里，否则 audit 会报「写了但值不对」
  txt = txt.replace(/<two-way \| one-way>/g, 'two-way')

  // 2) 剩余尖括号占位统一填掉
  txt = txt.replace(ANGLE_RE, filled)

  // 3) 渲染器的兜底值
  txt = txt.replace(/待补齐/g, filled)

  // 4) 验收标准示范行
  const kind = /-spec\.md$/.test(absPath) ? 'spec' : (/-prd\.md$/.test(absPath) ? 'prd' : 'todo')
  const criteria = opts.criteria ?? DEFAULT_CRITERIA[kind] ?? DEFAULT_CRITERIA.todo
  txt = txt.replace(/^- \[ \] C(\d+): .*$/gm, (whole, n) => {
    const text = criteria[Number(n) - 1] ?? criteria[criteria.length - 1] ?? filled
    return `- [ ] C${n}: ${text}`
  })

  // 5) 实现说明节：留空会被 finalize 的自动摘要处理，但显式写清更接近真实
  txt = txt.replace(/^(- \*\*实际落地摘要\*\*)：\s*$/m, '$1：已按方案落地并验证')
  txt = txt.replace(/^(- \*\*关联同步文件\*\*)：\s*$/m, '$1：docs/TDD.md')
  txt = txt.replace(/^(- \*\*实际验证命令与结果\*\*)：\s*$/m, '$1：node --test 退出码 0')
  txt = txt.replace(/^(- \*\*文档同步检查\*\*)：\s*$/m, '$1：TDD 与 README 已核对')
  txt = txt.replace(/^(- \*\*遗留问题\*\*)：\s*$/m, '$1：无')

  for (const [from, to] of opts.extra ?? []) {
    txt = typeof from === 'string' ? txt.split(from).join(to) : txt.replace(from, to)
  }

  writeFileSync(absPath, txt)
  return txt
}
