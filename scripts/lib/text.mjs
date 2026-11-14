/**
 * text.mjs —— 文本形状判据：路径归一、编码嗅探、版本号、frontmatter、仓库地址。
 *
 * 这些函数的共同点是**只读字符串、只返回数据**，不知道调用方在做什么。
 * 所以它们住在最底层：谁都可以依赖它，它不依赖任何人，没有副作用。
 *
 * 每一条判据都只实现一次。同一个问题在两处各判一次，迟早给出两种答案，
 * 而那种分歧出现在「读文件」上时，症状通常是**静默损坏**。
 */

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
 * 将路径归一为跨平台真实规范路径：
 * 从目标路径向上寻找最深已存在祖先目录调用 `realpathSync.native`（解析 macOS `/var` -> `/private/var`
 * 与 Windows Junction），再拼回尚未存在的尾部相对段并做 Unicode NFC 归一（消除 APFS NFD 差异）。
 */
export function canonicalPath(p) {
  if (p === undefined || p === null) return ''
  const raw = String(p)
  if (raw.trim() === '') return ''
  let cur = resolve(raw)
  const tail = []
  while (true) {
    try {
      const real = realpathSync.native(cur)
      const joined = tail.length > 0 ? join(real, ...tail.reverse()) : real
      return joined.normalize('NFC')
    } catch {
      const parent = dirname(cur)
      if (parent === cur) {
        return resolve(raw).normalize('NFC')
      }
      tail.push(basename(cur))
      cur = parent
    }
  }
}

/**
 * 两个路径是不是同一个位置。
 *
 * 判据按 `canonicalPath` 归一（支持不存在尾部路径、macOS `/var` vs `/private/var` 与 APFS NFD）；
 * 仅在 Windows（`win32`）按大小写不敏感比对，不在 Linux 上错误 `.toLowerCase()`。
 */
export function samePath(a, b) {
  if (a === undefined || a === null || b === undefined || b === null) return false
  if (String(a).trim() === '' || String(b).trim() === '') return false
  const ca = canonicalPath(a)
  const cb = canonicalPath(b)
  if (!ca || !cb) return false
  if (ca === cb) return true
  if (process.platform === 'win32') {
    return ca.toLowerCase() === cb.toLowerCase()
  }
  return false
}

/** 路径归一化成正斜杠。进出集合都过这一层，别各写各的。 */
export function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/** 判断单个路径段是否为 macOS Finder / AppleDouble 元数据文件或目录。 */
export function isMacMetadataName(name) {
  const base = String(name ?? '')
  return base === '.DS_Store'
    || base.startsWith('._')
    || base === '__MACOSX'
    || base === '.Spotlight-V100'
    || base === '.Trashes'
    || base === '.fseventsd'
}

/** 判断相对路径任意层级是否命中 macOS 元数据条目。 */
export function isMacMetadataPath(rel) {
  return posixPath(rel).split('/').some((seg) => seg && isMacMetadataName(seg))
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
 * 解析 OpenSSH 配置文件（默认 `~/.ssh/config`），提取 `Host` 别名到 `HostName` 的只读映射。
 * 忽略通配符模式（`*` / `?` / `!`）与 `Match` 块；同一别名按 OpenSSH 规则先出现者优先。
 */
export function parseSshConfigHostMap(input) {
  let text = ''
  if (typeof input === 'string') {
    const looksInline = input.includes('\n') || input.includes('\r')
      || /^\s*(?:Host|HostName|User|Port|IdentityFile)\b/im.test(input)
    if (looksInline) {
      text = input
    } else if (input.trim() && existsSync(input.trim())) {
      text = readTextSafe(input.trim()) ?? ''
    } else {
      text = input
    }
  } else if (input && typeof input === 'object') {
    if (typeof input.configText === 'string') text = input.configText
    else if (typeof input.text === 'string') text = input.text
    else {
      const cfgPath = input.configPath || input.path || join(homedir(), '.ssh', 'config')
      text = existsSync(cfgPath) ? (readTextSafe(cfgPath) ?? '') : ''
    }
  } else {
    const cfgPath = join(homedir(), '.ssh', 'config')
    text = existsSync(cfgPath) ? (readTextSafe(cfgPath) ?? '') : ''
  }

  const hostMap = {}
  let currentHosts = []
  for (const rawLine of String(text).replace(/\r\n/g, '\n').split('\n')) {
    const stripped = rawLine.replace(/(?:^|\s)#.*$/, '').trim()
    if (!stripped) continue
    const m = /^([A-Za-z0-9_-]+)\s*(?:=|\s)\s*(.+)$/.exec(stripped)
    if (!m) continue
    const key = m[1].toLowerCase()
    const val = m[2].trim()
    if (key === 'match') {
      currentHosts = []
      continue
    }
    if (key === 'host') {
      currentHosts = val
        .split(/\s+/)
        .map((h) => h.replace(/^['"]|['"]$/g, '').trim())
        .filter((h) => h && !/[*?![\]]/.test(h))
      continue
    }
    if (key === 'hostname' && currentHosts.length > 0) {
      const targetHost = val.replace(/^['"]|['"]$/g, '').trim()
      if (!targetHost) continue
      for (const alias of currentHosts) {
        if (!Object.prototype.hasOwnProperty.call(hostMap, alias)) {
          hostMap[alias] = targetHost
        }
      }
    }
  }
  return hostMap
}

/** 按大小写不敏感查找 SSH Host 别名映射到的目标主机名。 */
export function lookupSshHost(sshHostMap, host) {
  if (!sshHostMap || typeof sshHostMap !== 'object' || !host) return undefined
  if (Object.prototype.hasOwnProperty.call(sshHostMap, host)) return sshHostMap[host]
  const low = String(host).toLowerCase()
  for (const [k, v] of Object.entries(sshHostMap)) {
    if (String(k).toLowerCase() === low) return v
  }
  return undefined
}

/** 提取 Git 远端地址的主机名与协议（不依赖平台）。 */
export function parseRemoteUrlHost(value) {
  const s = String(value ?? '').trim()
  if (!s) return { protocol: 'unknown', host: undefined }
  if (/^file:\/\//i.test(s)) return { protocol: 'file', host: undefined }
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(?:[^/@]+@)?([^/:?#]+)(?::\d+)?(?:\/|$)/i.exec(s)
  if (schemeMatch) {
    const proto = schemeMatch[1].toLowerCase()
    const protocol = proto === 'ssh' ? 'ssh' : (proto === 'http' || proto === 'https' ? 'https' : proto)
    return { protocol, host: schemeMatch[2].toLowerCase() }
  }
  const scpMatch = /^(?:[^/:@\s]+@)?([^/:@\s]+):(.+)$/.exec(s)
  if (scpMatch && !/^[A-Za-z]:\\/.test(s) && !/^[A-Za-z]:\//.test(s)) {
    return { protocol: 'ssh', host: scpMatch[1].toLowerCase() }
  }
  const bareHostMatch = /^([^/\s]+\.[^/\s]+)\/(.+)$/.exec(s)
  if (bareHostMatch) {
    return { protocol: 'unknown', host: bareHostMatch[1].toLowerCase() }
  }
  return { protocol: 'unknown', host: undefined }
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
 * 调用方因此必须用 `repoRelation()`，它把「没法比」变成第三种结果。
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

const GITHUB_HOST_RE = /^(?:www\.|ssh\.)?github\.com$/i

/**
 * 把一个 **GitHub** 地址归一成 `owner/name`（支持 `~/.ssh/config` SSH 别名映射与 `ssh.github.com:443`）。
 * 不是 GitHub 的地址返回 undefined。
 */
export function githubRepoPath(value, sshHostMap) {
  const s = String(value ?? '').trim()
  if (!s) return undefined
  const { protocol, host } = parseRemoteUrlHost(s)
  if (!host) return undefined
  let effectiveHost = host
  if (protocol === 'ssh' && sshHostMap) {
    const mapped = lookupSshHost(sshHostMap, host)
    if (mapped) effectiveHost = mapped.toLowerCase()
  }
  if (!GITHUB_HOST_RE.test(effectiveHost)) return undefined
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
