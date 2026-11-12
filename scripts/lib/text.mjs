/**
 * text.mjs —— 文本形状判据：路径归一、编码嗅探、版本号、frontmatter、仓库地址。
 *
 * 这些函数的共同点是**只读字符串、只返回数据**，不知道调用方在做什么。
 * 所以它们住在最底层：谁都可以依赖它，它不依赖任何人，没有副作用。
 *
 * 每一条判据都只实现一次。同一个问题在两处各判一次，迟早给出两种答案，
 * 而那种分歧出现在「读文件」上时，症状通常是**静默损坏**。
 */

import { readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 读一个文本文件，**读不到就返回 undefined**（不是空串）。
 *
 * 这是全仓唯一的「安全读」。两条边界由它一处定义，别处只能依赖它：
 *
 *   - **超过上限的文件不读**：`256 KB` 是按「一个清单文件、一份文档」定的量级。
 *     超过它的多半是数据文件（`package-lock.json` 之外的东西、导出的表格），
 *     读进来只会占内存，而不读它也不影响任何判定——判定要的是结构，不是全文。
 *   - **含 NUL 字节的不读**：那是二进制。按 UTF-8 读出来是一串替换字符，
 *     后续所有正则都在那串垃圾上跑，报出来的结论会像真的。
 *
 * 行尾统一成 `\n`、去掉 BOM：调用方拿到的文本与它写回去时用的文本是同一份形状，
 * 否则「读了再写」会在 Windows 上悄悄改掉整个文件的行尾。
 */
export function readTextSafe(filePath, maxBytes = 256 * 1024) {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size > maxBytes) return undefined
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return undefined
    return buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  } catch {
    return undefined
  }
}

/** 读一个 JSON 文件。读不到或不是合法 JSON 都返回 undefined——**不抛**。 */
export function readJsonSafe(filePath) {
  const text = readTextSafe(filePath)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/**
 * 两个路径是不是同一个位置。
 *
 * 判据按**真实路径**归一：`process.argv[1]` 保留调用方写下的写法，而 `import.meta.url`
 * 已被 Node 解析成真实路径。经符号链接或 junction 调用时两者永不相等，于是脚本
 * **什么都不做并返回 0**——而调用方会把它读成「检查通过」。这个坑不报错，只让门禁变绿。
 */
export function samePath(a, b) {
  try {
    return realpathSync.native(resolve(a)) === realpathSync.native(resolve(b))
  } catch {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase()
  }
}

/** 路径归一化成正斜杠。进出集合都过这一层，别各写各的。 */
export function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/**
 * 把一个 Buffer 解成文本：先按严格 UTF-8，再按 UTF-16，最后宽松兜底。
 *
 * 为什么必须做：`readFileSync(p, 'utf8')` 是**宽松**解码——非法字节被替换字符吞掉，
 * 不报错。而 Windows 上 `Out-File` / `Set-Content` 默认存 UTF-16LE，于是里面的凭据形状
 * 全是「字节 + NUL」交错，ASCII 形状的正则一个都匹配不上，报告显示「无命中」。
 * 同一份内容存成 UTF-16LE 就漏、存成 UTF-8 就报——这种漏报比误报坏得多。
 *
 * 返回 `{ text, encoding }`；`encoding` 为 `unknown` 时说明只做到了尽力而为，
 * 调用方要据此判断「这条结论可不可信」。
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
  return { text: stripBom(buffer.toString('utf8')), encoding: 'unknown' }
}

/** 读一个文本文件。读不出来返回 undefined（不是空串）。 */
export function readTextFile(p) {
  let buffer
  try { buffer = readFileSync(p) } catch { return undefined }
  return decodeText(buffer)
}

/**
 * 按**严格 UTF-8** 读一份将要写回去的文本。
 *
 * 为什么不能用宽松解码：那是把 GBK / UTF-16 的字节逐个换成替换字符，然后整篇按 UTF-8
 * 写回去——**原文不可恢复**，而脚本还会报「已添加目录」、退出码 0。这是唯一一种不可恢复
 * 的损坏，所以宁可不写。
 *
 * 返回 `{ text, hadBom }` 或 `{ error }`。
 */
export function readUtf8Strict(p) {
  const buf = readFileSync(p)
  if (buf.length >= 4) {
    const [a, b, c, d] = [buf[0], buf[1], buf[2], buf[3]]
    if ((a === 0xff && b === 0xfe && c === 0 && d === 0) || (a === 0 && b === 0 && c === 0xfe && d === 0xff)) {
      return { error: 'UTF-32（带 BOM）' }
    }
  }
  if (buf.length >= 2) {
    const [a, b] = [buf[0], buf[1]]
    if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) return { error: 'UTF-16（带 BOM）' }
  }
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    const nul = buf.reduce((n, x) => n + (x === 0 ? 1 : 0), 0)
    return {
      error: nul > 0 ? `含 ${nul} 个 NUL 字节，看起来是 UTF-16（但缺 BOM）` : '不是合法的 UTF-8（可能是 GBK 等本地编码）',
    }
  }
  // BOM 要从**原始字节**判：TextDecoder 按规范会自己吃掉 UTF-8 的 BOM，
  // 解出来的文本里已经没有它了——拿文本去判，结论永远是「没有 BOM」。
  const hadBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  return { text: text.replace(/^\uFEFF/, ''), hadBom }
}

/**
 * 本文件是不是被**直接执行**（而不是被 import）。
 *
 * 判据不能用字面路径比较：`process.argv[1]` 保留调用方写下的写法，而 `import.meta.url`
 * 已被 Node 解析成真实路径。经符号链接或 junction 调用时两者永不相等，脚本于是
 * **什么都不做并返回 0**——而调用方会把它读成「检查通过」。所以按真实路径归一后比较。
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
 * frontmatter 区块（不含两端的 `---` 行）。不是 frontmatter 时返回 undefined。
 *
 * 只此一处切分：能力目录的识别、版本读取都从这里取块。各切各的迟早会在某个边界条件上
 * 给出两种答案（块标量里的 `---`、BOM、行尾）。
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

/**
 * 入口声明的版本（frontmatter 里 `metadata.version`）。
 *
 * 存在的理由只有一个：**没有版本历史的副本**靠它知道自己属于哪一版。有版本历史时
 * 标签才是权威，这个字段是它的副本，所以发版门禁要求两者同号。读不到就返回 undefined
 * ——不编一个，也不拿别的字段凑。
 */
export function skillVersion(text) {
  const block = frontmatterBlock(text)
  if (block === undefined) return undefined
  const m = /^[ \t]+version:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(block)
  return m === null ? undefined : m[1].trim()
}

/** `metadata.source`：这个 skill 的来处。与 `skillVersion` 同一类事实、同一个读者。 */
export function skillSource(text) {
  const block = frontmatterBlock(text)
  if (block === undefined) return undefined
  const m = /^[ \t]+source:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(block)
  return m === null ? undefined : m[1].trim()
}

/**
 * 把仓库地址归一成 `owner/name`。
 *
 * 同一个仓库有好几种写法（完整网址、带 `.git`、`git@host:owner/name` 的 scp 写法、
 * 检出时内嵌凭据的地址），比对要认得出它们是同一个，否则判据会在换一种检出方式时
 * 开始误报。
 *
 * **认不出来时返回 undefined，而两个 undefined 相等**——这是它唯一危险的用法：
 * 拿它做等值比较却不管 undefined，就是「两个都认不出 → 判成一样 → 放行」。
 * 调用方因此必须用 `repoRelation()`，它把「没法比」变成第三种结果。
 */
export function repoPath(value) {
  let s = String(value ?? '').trim().toLowerCase()
  if (s === '') return undefined
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')   // 协议头
  s = s.replace(/^[^@/]*@/, '')                  // 内嵌凭据或用户名
  // scp 写法 `host:owner/name`：主机名后面跟的是**冒号**，不是斜杠。
  // 只认斜杠时这一整类都归一不出结果，而那正是 git 最常见的克隆写法之一。
  s = s.replace(/^[^/:]+:/, '')
  s = s.replace(/^[^/]*\.[^/]*\//, '')           // 含点的主机名
  s = s.replace(/\.git$/, '').replace(/\/+$/, '')
  return /^[^/\s]+\/[^/\s]+$/.test(s) ? s : undefined
}

/**
 * 把一个**GitHub** 地址归一成 `owner/name`。不是 GitHub 的地址返回 undefined。
 *
 * 为什么要这一层，而不是直接用上面的 `repoPath`：`repoPath` 只管「这个地址里的
 * 仓库路径是什么」，它不认识主机。而几乎所有用到它的地方，判据都不是「路径一样吗」，
 * 是「**同一个 GitHub 仓库吗**」——角色判定（origin 是不是正本）、远端正不正、包边界。
 * 拿一个别处托管平台的地址喂进去也得到 `owner/name`，再拿去和 GitHub 的比，就得到
 * 「同一个仓库」这个假结论，而它会让一次本该走 fork 流程的改动被当成维护者直推。
 *
 * 归一化本身仍然只有 `repoPath` 一份，这里只加一道主机闸门。
 */
export function githubRepoPath(value) {
  const s = String(value ?? '').trim()
  if (!/github\.com[:/]/i.test(s)) return undefined
  return repoPath(s)
}

/**
 * 两个仓库地址的关系：`same` / `different` / `unknown`。
 *
 * **存在的理由就是那个 `unknown`**：把「认不出」压进 undefined 之后，`a !== b` 在两个都
 * 认不出时返回 false，于是门禁把「没法比」读成「比过且一致」——这是最坏的一种失效，
 * 因为它看起来是绿的。
 */
export function repoRelation(a, b) {
  const pa = repoPath(a)
  const pb = repoPath(b)
  if (pa === undefined || pb === undefined) return 'unknown'
  return pa === pb ? 'same' : 'different'
}

/**
 * 版本串归一：**只吃写法差异，不做版本序、不折叠预发布**。
 *
 * `0.1.5-rc.1` 与 `0.1.5` 归一后**不同**——那是两次不同的发布，折叠掉等于隐瞒
 * 「现在装的是 rc 还是正式版」这个事实。
 */
export function normVersion(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[\^~>=<\s]+/, '')
    .replace(/^[vV](?=\d)/, '')
    .toLowerCase()
}
