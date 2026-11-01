/**
 * text.mjs —— 文本形状判据：路径归一、版本号、标记键值、文件地图、表格首格。
 *
 * 这些函数的共同点是**只读字符串、只返回数据**，不知道调用方在做什么。
 * 它们原先住在 survey.mjs 里，于是任何只想判断一下「这是不是主模块」的脚本，
 * 都得把整个勘察引擎（含全盘走查与 git 子进程）加载进来。
 *
 * 本层零副作用、无本地依赖——它是最底层，谁都可以依赖它，它不依赖任何人。
 */

import { readFileSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 路径归一化成正斜杠——**进出集合都过这一层，别各写各的**。
 *
 * git 的输入输出一律用正斜杠，本地 `join` 用平台分隔符。两边写法不同就配不上，
 * 而症状恰好落在危险的那一侧：明明已被忽略的目录被报成「未被忽略」。归一化散在几个
 * 调用点各写一遍时漏掉一处，判定就只在某个平台上错。
 */
export function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/**
 * 读一个文本文件：**按内容嗅探编码**后解码。**全仓唯一的读法**。
 *
 * 两处各用一套解码器时，同一个文件会得到两个答案：宽松 UTF-8 把 UTF-16 的清单解成
 * 乱码并报「清单损坏」，而内容扫描却把它正确读出。两处都走 `decodeText` 才不会分裂。
 *
 * 返回 `{ text, encoding }`；读不出来返回 undefined。
 */
export function readTextFile(p) {
  let buffer
  try {
    buffer = readFileSync(p)
  } catch {
    return undefined
  }
  return decodeText(buffer)
}

/**
 * 本文件是不是被**直接执行**（而不是被 import）。
 *
 * 判据不能用字面路径比较：`process.argv[1]` 保留调用方写下的写法，而
 * `import.meta.url` 已被 Node 解析成真实路径。经 junction / 符号链接调用时两者
 * 永不相等，脚本于是**什么都不做并返回 0**——实测 preflight 走 junction 就是这样：
 * exit 0、零输出，CI 与人都会读成「自检通过」。所以这里按真实路径归一后比较。
 *
 * 判不出来（文件不存在等）时返回 false：被 import 才是常态，且 import 侧有守卫
 * 兜底（调用方必须自己保证「没跑就报错」，不能靠这里返回真来掩盖）。
 */
export function isMainModule(metaUrl, argv1) {
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
 * 已认领的标记键：含义与形状**只在这里定义一次**。
 *
 * 没认领的键不是错误（可扩展），但要按「未核对」提示出来——它不会被校验、也不参与
 * 比对。值一律要求**非空且单行**（标记解析按空白切分，值里带空白本身就写不成单行）。
 * `host=` 的语义是「上次核对时**本机实际运行**的那套宿主版本」——不是兼容下界，
 * 也不是某个目标项目锁定的版本；多值写法已否决（它表达不了「本机跑的是哪一版」）。
 *
 * 放在这里而不是自检脚本里：认领、归一化与比对是**随包分发的脚本也要用**的东西
 * （compose-agents 用它做宿主兼容性提示），而自检脚本不进用户包。共用一份的前提是
 * 那一份住在双方都拿得到的地方——依赖方向反过来，包里的脚本就会在运行时找不到模块。
 */
export const CLAIMED_MARKER_KEYS = {
  date: { note: '核对日期' },
  host: { reject: /[,\s]/, note: '上次核对时本机实际运行的那套宿主版本' },
}

/** 解析标记里的 key=value，返回 { keys, errors, notes }。纯函数，直接可证伪。 */
export function parseMarkerKeys(raw) {
  const errors = []
  const notes = []
  const keys = {}
  for (const part of String(raw ?? '').trim().split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      errors.push(`核对标记里的「${part}」不是 key=value 形状——每个键写成 key=value，值不许含空白（值必须非空且单行）。`)
      continue
    }
    const name = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      errors.push(`核对标记的键名「${name}」形状非法——用字母开头，其后是字母、数字、下划线或连字符。`)
      continue
    }
    if (value === '') {
      errors.push(`核对标记的「${name}=」值是空的——值必须非空且单行。`)
      continue
    }
    if (keys[name] !== undefined) {
      errors.push(`核对标记里「${name}」出现了多次——每个键只写一次。`)
      continue
    }
    const claimed = CLAIMED_MARKER_KEYS[name]
    if (claimed === undefined) {
      notes.push(`核对标记里的「${name}=」没有认领的含义——它不会被校验，也不能参与比对（未登记即未核对）。`)
    } else if (claimed.reject !== undefined && claimed.reject.test(value)) {
      errors.push(`核对标记的「${name}=${value}」格式非法——${name} 应是单个不含量空白与逗号的值。`)
    }
    keys[name] = value
  }
  return { keys, errors, notes }
}

/**
 * 版本串归一：**只吃写法差异，不做版本序、不折叠预发布**。
 * 顺序：trim → 去开头 `^ ~ > = <` 与空白 → 去开头 v/V（后面紧跟数字时）→ 小写。
 *
 * **只实现这一处**：compose-agents 与 preflight 共用同一份（两处各判一次同类问题，
 * 迟早给出两种答案）。`0.1.5-rc.1` 与 `0.1.5` 归一后**不同**——那是两次不同的发布，
 * 折叠掉等于隐瞒「章里核的是 rc、本机装的是正式版」这个事实。
 */
export function normVersion(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[\^~>=<\s]+/, '')
    .replace(/^[vV](?=\d)/, '')
    .toLowerCase()
}

/**
 * 入口声明的版本（frontmatter 里 `metadata.version`）。
 *
 * 存在的理由只有一个：**没有版本历史的用户包副本**靠它知道自己属于哪一版。有版本历史时
 * 标签才是权威，这个字段是它的副本，所以发版门禁要求两者同号
 * （见 `scripts/dev/preflight.mjs` 的 `checkReleaseTag`）。读不到就返回 undefined——
 * 不编一个，也不拿别的字段凑。
 */
export function skillVersion(text) {
  const block = frontmatterBlock(text)
  if (block === undefined) return undefined
  const m = /^[ \t]+version:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(block)
  return m === null ? undefined : m[1].trim()
}

/**
 * `metadata.source`：这个 skill 的来处。
 *
 * 与 `metadata.version` 同一类事实、同一个读者：**没有 `.git` 的副本**。它靠版本知道自己
 * 属于哪一版，靠来源知道该去哪儿找新版——两样都读不到时，那份副本就只能等人来手动覆盖。
 * 只在 frontmatter 里读，不做完整 YAML 解析，与 `skillVersion` 保持同一种形状。
 */
export function skillSource(text) {
  const block = frontmatterBlock(text)
  if (block === undefined) return undefined
  const m = /^[ \t]+source:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(block)
  return m === null ? undefined : m[1].trim()
}

/**
 * 把仓库地址归一成 `owner/name`。
 *
 * 同一个仓库有好几种写法（完整网址、带 `.git`、`git@host:owner/name` 这种 scp 写法、
 * 检出时可能内嵌凭据的地址），比对要认得出它们是同一个，否则判据会在换一种检出方式时
 * 开始误报。两个读者共用它：发版门禁比对「声明的来源」与「这次发布的仓库」，
 * 更新脚本用它把来源变成可下载的地址。
 *
 * **认不出来时返回 undefined，而两个 undefined 相等。** 这是它唯一危险的用法：
 * 拿它做等值比较却不管 undefined，就是「两个都认不出 → 判成一样 → 门禁放行」。
 * 调用方因此必须写 `a !== undefined && a === b`，或者用 `repoRelation()`。
 * 这一条在 scp 写法上真的发生过：`git@github.com:owner/repo` 剥不掉主机名，
 * 返回 undefined，于是 fork 比对静默通过。
 */
export function repoPath(value) {
  let s = String(value ?? '').trim().toLowerCase()
  if (s === '') return undefined
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')   // 协议头 https://
  s = s.replace(/^[^@/]*@/, '')                  // 内嵌凭据或用户名（git@、user:token@）
  // scp 写法 `host:owner/name`：主机名后面跟的是**冒号**，不是斜杠。
  // 只认斜杠时这一整类都归一不出结果，而那正是 git 最常见的克隆写法之一。
  s = s.replace(/^[^/:]+:/, '')
  s = s.replace(/^[^/]*\.[^/]*\//, '')           // 含点的主机名，例如 github.com/
  s = s.replace(/\.git$/, '').replace(/\/+$/, '')
  return /^[^/\s]+\/[^/\s]+$/.test(s) ? s : undefined
}

/**
 * 两个仓库地址的关系：`same` / `different` / `unknown`。
 *
 * **存在的理由就是那个 `unknown`**：把「认不出」压进 undefined 之后，`a !== b` 在两个
 * 都认不出时返回 false，于是门禁把「没法比」读成「比过且一致」——这正是最坏的一种失效，
 * 因为它看起来是绿的。这个函数让「没法比」必须被显式处理，处理方式是报未核对，不是放行。
 */
export function repoRelation(a, b) {
  const pa = repoPath(a)
  const pb = repoPath(b)
  if (pa === undefined || pb === undefined) return 'unknown'
  return pa === pb ? 'same' : 'different'
}

/**
 * 从 SKILL.md 的文件地图里读出两张表：随包分发的、只服务本仓库的。
 *
 * **判据来自文档结构本身，不是另一份清单**——两个小标题之间的表格行里出现的路径就是
 * 声明。这份结果有两个读者，而且它们必须看到同一份答案：
 *   - `preflight.mjs` 用它核对包边界（漏登记、放错位置、声明与实际矛盾）；
 *   - `update.mjs` 用它清掉副本里「包里本来不该有」的那些文件——当初下成了 GitHub 的
 *     `Source code` 时，`.github/`、`AGENTS.md` 一类会一直留在那里碍事。
 * 所以它住在随包分发的模块里，而不是仓库自用的自检脚本里：用户包里没有自检脚本，
 * 但用户包副本恰恰最需要那份排除表。
 */
export function readFileMap(skillText) {
  const buckets = { shipped: [], repoOnly: [] }
  let bucket
  for (const line of String(skillText ?? '').split('\n')) {
    if (/^###\s+用户包里有/.test(line)) { bucket = buckets.shipped; continue }
    if (/^###\s+仓库里另有/.test(line)) { bucket = buckets.repoOnly; continue }
    if (/^##\s/.test(line)) { bucket = undefined; continue }
    if (bucket === undefined) continue
    // 只看表格行的**第一格**：那一格才是文件清单，说明格里的反引号（提到的文档、
    // 命令开关、凭据名）不是声明，读进来会造出一堆假失败。
    const cell = tableRowFirstCell(line)
    if (cell === undefined) continue
    for (const m of cell.matchAll(/`([^`]+)`/g)) {
      const v = m[1].trim()
      if (v.includes('<')) {
        // 占位条目（形如 `references/plugins/<生态>.md`）取它所在的目录当前缀
        const dir = v.slice(0, v.lastIndexOf('/') + 1)
        if (dir !== '') bucket.push(dir)
        continue
      }
      if (/^[A-Za-z0-9._/-]+$/.test(v)) bucket.push(v)
    }
  }
  return buckets
}

/**
 * 表格行的**第一格**原文。不是表格行时返回 undefined。
 *
 * 「什么算表格行」只在这里定义一次：文件地图的解析与 README 文件表的对账都从它取，
 * 两处各写一套迟早会在某个边界形状上给出两种答案。
 */
export function tableRowFirstCell(line) {
  if (!/^\s*\|/.test(line)) return undefined
  const cells = line.split('|')
  return cells.length < 3 ? undefined : cells[1]
}

/** 一份 Markdown 里所有表格行第一格的原文。 */
export function tableFirstCells(text) {
  const out = []
  for (const line of String(text ?? '').split('\n')) {
    const cell = tableRowFirstCell(line)
    if (cell !== undefined) out.push(cell.trim())
  }
  return out
}
/**
 * 把文件按 UTF-8 严格解码；非 UTF-8 时按 UTF-16 再试一次（带 BOM 或 NUL 密集）。
 *
 * 为什么必须做：本 skill 零依赖、只用内置模块，而 `readFileSync(p,'utf8')` 是**宽松**
 * 解码——非法字节被替换字符吞掉，不报错。Windows 上 `Out-File` / `Set-Content` 默认
 * 存 UTF-16LE，于是里面的凭据形状全是「字节 + NUL」交错，ASCII 形状的正则一个都匹配
 * 不上，而报告显示「无命中」。实测过：同一份内容存成 UTF-16LE 就漏，存成 UTF-8 就报。
 *
 * 返回 { text, encoding } 或 { error }（读不出来）。
 */
export function decodeText(buffer) {
  const stripBom = (s) => s.replace(/^\uFEFF/, '')
  try {
    return { text: stripBom(new TextDecoder('utf-8', { fatal: true }).decode(buffer)), encoding: 'utf-8' }
  } catch { /* 不是合法 UTF-8，继续试探 UTF-16 */ }
  const nul = buffer.reduce((n, x) => n + (x === 0 ? 1 : 0), 0)
  const looksUtf16 = nul / Math.max(1, buffer.length) > 0.15
    || (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff)))
  if (looksUtf16) {
    for (const enc of ['utf-16le', 'utf-16be']) {
      try {
        return { text: stripBom(new TextDecoder(enc, { fatal: true }).decode(buffer)), encoding: enc }
      } catch { /* 换另一种端序 */ }
    }
  }
  // 既不是 UTF-8 也不是 UTF-16：按宽松解码尽力扫一遍，同时**如实记为未覆盖**。
  return { text: readTextFromBuffer(buffer), encoding: 'unknown' }
}

function readTextFromBuffer(buffer) {
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}

/**
 * frontmatter 区块（不含两端的 `---` 行）。不是 frontmatter 时返回 undefined。
 *
 * 只此一处切分：能力目录的识别、版本读取、宿主字段检查都从这里取块，各切各的迟早
 * 会在某个边界条件上给出两种答案（块标量里的 `---`、BOM、行尾）。
 */
export function frontmatterBlock(text) {
  if (text === undefined) return undefined
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines[0] !== '---') return undefined
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') return lines.slice(1, i).join('\n')
  }
  return undefined
}
