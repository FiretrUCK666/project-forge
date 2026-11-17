/**
 * doc-facts.mjs —— 把文档里的**可机械核实的断言**抽出来并当场验掉。
 *
 * ## 治的病：审核为什么慢
 *
 * 一份 SPEC 里有一百多处 `像代码一样` 的断言：
 *
 * - 这个文件存在吗（`kit/skills/lib/tdd-parity.mjs`）
 * - 这个函数在吗、返回哪些键（`checkTddSyncParity` → `missingModulesInTdd`）
 * - 这条命令跑得通吗（`node <测试入口> --only "…"`）
 * - 这个常量是什么值（`COMMAND_DISPLAY_MAX_BYTES = 500`）
 * - 这个 id 会出现在输出里吗（`docs.tdd-shell`）
 *
 * 这些**没有一个需要人判断**。但审核人每次都拿手工去核，一条一条跑命令——
 * 一轮十几分钟全花在这上面，而真正需要判断的（「这条判据能不能证伪」）只占很小一部分。
 *
 * ## 做法
 *
 * 抽出四类断言，逐条自动核：
 *
 * | 类别 | 怎么核 |
 * | --- | --- |
 * | 文件路径 | 存在？ |
 * | 导出名 | `import()` 之后 `Object.keys` 里有吗？ |
 * | 命令 | 真跑一遍，看退出码与输出里有没有它声称的东西 |
 * | 常量 | 用 `import()` 取值，与文档写的一致吗？ |
 *
 * 核不出来的（纯人判断的句子）**不猜**，如实列为「需要人看」。
 * 结果是：审核人拿到的是「这一百条我已经核过了，全对／这三条不对」，
 * 于是他的时间只花在剩下那一小部分真正需要判断的地方。
 *
 * ## 边界
 *
 * 这不是「自动审核」。它只回答事实问题，不回答「这条判据够不够硬」。
 * 后者仍然只有人能判——但那是**少量**的判断，不是把整份文档重读一遍。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 反引号里的东西。 */
const TICK_RE = /`([^`\n]+)`/g

/** 看起来像仓库相对路径：有斜杠、有扩展名、不带空格。 */
const PATH_RE = /^(?<![\w./-])((?:[\w.-]+\/)+[\w.-]+\.(?:mjs|js|cjs|ts|md|json|ya?ml|toml))/

/** 看起来像一条可执行命令。 */
const CMD_RE = /^(?:node|npm|npx|pnpm|yarn|git|python|pytest|cargo|go|make)\s+/

/**
 * 抽一份文档里的可核实断言。
 *
 * @param {string} text 文档全文
 * @returns {{ paths: string[], commands: string[], identifiers: string[], constants: Array<{name: string, value: string}> }}
 */
export function collectDocClaims(text) {
  const paths = new Set()
  const commands = new Set()
  const identifiers = new Set()
  const constants = []

  for (const m of String(text ?? '').matchAll(TICK_RE)) {
    const raw = m[1].trim()
    if (!raw) continue

    // `NAME = 500` 这种常量声明
    const constMatch = /^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+)$/.exec(raw)
    if (constMatch) { constants.push({ name: constMatch[1], value: constMatch[2].trim() }); continue }

    if (CMD_RE.test(raw)) { commands.add(raw); continue }

    if (PATH_RE.test(raw) && !/\s/.test(raw)) {
      const rel = raw.replace(/^\.\//, '')
      // 正文里紧跟 `(new)` 的是「这次要新建」——它现在不存在是对的，别报假红灯。
      const at = m.index + m[0].length
      if (/\(\s*new\s*\)/i.test(String(text ?? "").slice(at, at + 8))) continue
      paths.add(rel)
      continue
    }

    // 标识符：驼峰或下划线，长度够、不是普通英文词
    if (/^[A-Za-z_][A-Za-z0-9_]{3,}$/.test(raw) && /[A-Z_]/.test(raw)) identifiers.add(raw)
  }

  return {
    paths: [...paths],
    commands: [...commands],
    identifiers: [...identifiers],
    constants,
  }
}

/**
 * 核一遍「这个路径存在吗」。
 *
 * 文档里写路径时有几类合法写法，不能一刀切：
 * - `xxx.mjs`(new) —— 这次要新建的；
 * - 目录（以 `/` 结尾）；
 * - 带通配的（`kit/**`）—— 不是具体文件。
 *
 * @param {string} root
 * @param {string} rel
 * @returns {{ ok: boolean, why?: string }}
 */
export function checkPathClaim(root, rel) {
  if (!rel) return { ok: true }
  if (/[*?{}]/.test(rel)) return { ok: true, why: '通配，不是具体文件' }
  if (rel.endsWith('/')) {
    return existsSync(join(root, rel.replace(/\/+$/, ''))) ? { ok: true } : { ok: false, why: '目录不存在' }
  }
  if (existsSync(join(root, rel))) return { ok: true }
  return { ok: false, why: '文件不存在' }
}

/**
 * 把核不出来的部分挑出来——它们是审核人真正要花时间的地方。
 *
 * @param {string} text
 * @returns {{ sections: string[], pendingLines: string[] }}
 */
export function splitJudgeable(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const pending = []
  for (const line of lines) {
    // 只看判据与设计里那些「需要判断」的句子：带「必须 / 不得 / 才 / 否则」的
    if (/(?:必须|不得|禁止|只准|才|否则|等于|算作)/.test(line) && line.trim().length > 20) {
      pending.push(line.trim())
    }
  }
  return { pendingLines: pending }
}
