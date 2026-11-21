/**
 * text.mjs —— 文本形状判据：路径归一、编码嗅探、版本号、frontmatter、仓库地址。
 *
 * 这些函数的共同点是**只读字符串、只返回数据**，不知道调用方在做什么。
 * 所以它们住在最底层：谁都可以依赖它，它不依赖任何人，没有副作用。
 *
 * 每一条判据都只实现一次。同一个问题在两处各判一次，迟早给出两种答案，
 * 而那种分歧出现在「读文件」上时，症状通常是**静默损坏**。
 */

import { readFileSync } from 'node:fs'

import {
  canonicalPath,
  isMacMetadataName,
  isMacOsJunkPath,
  isMainModule,
  posixPath,
  readJsonSafe,
  readTextSafe,
  samePath,
} from '../../kit/skills/lib/git-core.mjs'
import {
  githubRepoPath,
  lookupSshHost,
  parseRemoteUrlHost,
  parseSshConfigHostMap,
} from '../../kit/skills/lib/platform-probe.mjs'

export {
  canonicalPath,
  githubRepoPath,
  isMacMetadataName,
  isMacOsJunkPath,
  isMainModule,
  lookupSshHost,
  parseRemoteUrlHost,
  parseSshConfigHostMap,
  posixPath,
  readJsonSafe,
  readTextSafe,
  samePath,
}
export const isMacMetadataPath = isMacOsJunkPath

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
 * 同一个仓库有好几种写法（完整网址、带端口 `ssh://git@host:port/owner/name`、带 `.git`、
 * `git@host:owner/name` 的 scp 写法、检出时内嵌凭据的地址），比对要认得出它们是同一个，
 * 否则判据会在换一种检出方式时开始误报。
 *
 * **认不出来时返回 undefined，而两个 undefined 相等**——这是它唯一危险的用法：
 * 拿它做等值比较却不管 undefined，就是「两个都认不出 → 判成一样 → 放行」。
 * 调用方在比较前必须显式排除 undefined。
 */
export function repoPath(value) {
  let s = String(value ?? '').trim().toLowerCase()
  if (s === '') return undefined
  const hadScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(s)
  if (hadScheme) {
    if (/^file:\/\//.test(s)) return undefined
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    s = s.replace(/^[^@/]*@/, '')
    s = s.replace(/^[^/]+\//, '')
  } else {
    s = s.replace(/^[^@/]*@/, '')
    if (/^[^/:]+:/.test(s)) {
      s = s.replace(/^[^/:]+:/, '')
    } else {
      s = s.replace(/^[^/]*\.[^/]*\//, '')
    }
  }
  s = s.replace(/\.git$/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  return /^[^/\s]+\/[^/\s]+$/.test(s) ? s : undefined
}

export { flushAndExit } from '../../kit/skills/lib/cli.mjs'
