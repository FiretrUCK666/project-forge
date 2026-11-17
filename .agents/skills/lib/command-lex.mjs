
/** 段与段之间的分隔：`&&`、`||`、`;`、`|`、换行。`|` 要在 `||` 之后判，否则会切成两个空串。 */
const SEGMENT_OPERATORS = ['&&', '||', ';', '|', '\n']

/** 命令位置前面可以出现的「不算命令本身」的词：环境变量赋值、`sudo` 一类前缀。 */
const PREFIX_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const PREFIX_WORDS = new Set(['sudo', 'exec', 'command', 'time', '!', 'then', 'do', 'else'])

/**
 * 按 shell 运算符把一条命令切成若干段，**尊重引号**。
 *
 * 引号里的 `&&` 是字符串内容，不是控制流。不认引号的话，`echo "a && b"` 会被切成两段，
 * 第二段的命令位置变成 `b"`——那是一个不存在的命令，分类器只能瞎猜。
 *
 * @returns {string[]} 去掉首尾空白的段，空段被丢弃
 */
export function splitCommandSegments(command) {
  const text = String(command ?? '').replace(/\r\n/g, '\n')
  const out = []
  let buf = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      buf += ch
      if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === '\'') {
      quote = ch
      buf += ch
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      buf += ch + text[i + 1]
      i += 1
      continue
    }
    const op = SEGMENT_OPERATORS.find((one) => text.startsWith(one, i))
    if (op) {
      out.push(buf)
      buf = ''
      i += op.length - 1
      continue
    }
    buf += ch
  }
  out.push(buf)
  return out.map((one) => one.trim()).filter(Boolean)
}

/**
 * 取一段命令里「命令位置」的词：跳过环境变量赋值与前置修饰词，返回第一个非选项词。
 *
 * `FOO=1 sudo npm test --format=x` -> `npm`
 */
export function commandHeadOf(segment) {
  const words = String(segment ?? '').trim().split(/\s+/).filter(Boolean)
  for (const word of words) {
    if (PREFIX_ASSIGNMENT.test(word)) continue
    if (PREFIX_WORDS.has(word)) continue
    if (word.startsWith('-')) continue
    return word
  }
  return undefined
}

/**
 * 一段命令的「动词」：命令位置之后、下一个选项之前的第一个词。
 *
 * `git archive --format=zip` -> 命令位置是 `git`，动词是 `archive`。
 * 这两个位置才定义「这条命令在干什么」；`--format` 是它的参数，不是动作。
 *
 * 以 `.` 起头的词同样不是动词：那是对象的属性名（`.Restore`、`.Length`），
 * 出现在命令里只会是参数。把它当成动作，会让 `dotnet ... $build.Restore()` 这类
 * 调用被判成「安装依赖」。
 */
export function commandVerbOf(segment) {
  const words = String(segment ?? '').trim().split(/\s+/).filter(Boolean)
  let seenHead = false
  for (const word of words) {
    if (!seenHead) {
      if (PREFIX_ASSIGNMENT.test(word) || PREFIX_WORDS.has(word) || word.startsWith('-')) continue
      seenHead = true
      continue
    }
    if (word.startsWith('-') || word.startsWith('.')) return undefined
    return word
  }
  return undefined
}

/**
 * 把命令位置上的一「词」折成可比的脚本名。
 *
 * 带路径的词只保留最后一段：路径**中间**的分量说明它放在哪个目录，不说明这条命令
 * 在干什么。`node scripts/ci/test-helper/run.mjs` 里的 `test-helper` 只是一个目录名，
 * 整条命令与测试无关；把它算成测试命令，会让每个放着 `test-helper/` 的仓都被当成
 * 「已经有测试入口」，真跑起来什么都没有。
 *
 * 反过来，**最后一段必须保留**：一个仓唯一的测试入口常常就叫
 * `scripts/test-mac-pure.sh` 或 `./scripts/test-mac-pure.sh`——路径本身就在命令位置，
 * 把最后一段也剥掉，这类项目就永远探测不到测试命令。
 */
function commandNameOf(word) {
  const raw = String(word ?? '').trim()
  if (!raw) return raw
  const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return cut === -1 ? raw : raw.slice(cut + 1)
}

/**
 * 在一条命令的**命令位置**上找动作词，返回第一个命中的分类。
 *
 * `rules` 的形状：`[{ key, re }]`，`re` 只在命令名与动词上测，且测的是
 * `commandNameOf()` 折过之后的词（路径只留最后一段）。
 *
 * 拿一段真实的 CI 复现一下这条判据治的是什么：
 *
 *     splitCommandSegments('TAG=x && git archive --format=zip -o a.zip "$TAG"')
 *       -> ['TAG=x', 'git archive --format=zip -o a.zip "$TAG"']
 *     commandHeadOf('git archive --format=zip ...') -> 'git'
 *     commandVerbOf('git archive --format=zip ...') -> 'archive'
 *
 * `format` 在这里根本没被看过——它是 `--format` 的值，不是动作。
 */
export function classifyByCommandPosition(segment, rules) {
  const head = commandHeadOf(segment)
  const verb = commandVerbOf(segment)
  const positions = [head, verb].filter(Boolean).map(commandNameOf)
  if (positions.length === 0) return undefined
  for (const rule of rules ?? []) {
    if (positions.some((word) => rule.re.test(word))) return rule.key
  }
  return undefined
}

/**
 * 对整条命令（可能含多段）分类：逐段判，取第一个命中的分类。
 *
 * 为什么逐段而不是拼起来：`make build && make test` 里的 `test` 属于第二段，
 * 拼起来之后它就是「文本里出现过的词」，与它属于哪一段无关了。
 */
export function classifyCommandText(command, rules) {
  for (const segment of splitCommandSegments(command)) {
    const kind = classifyByCommandPosition(segment, rules)
    if (kind) return kind
  }
  return undefined
}

/** 单条命令展示上限。超过它的命令在报告里要截断并标出总长度。 */
export const COMMAND_DISPLAY_MAX_BYTES = 500

/**
 * 按 UTF-8 字节截断一条命令，给出总长度，供报告层使用。
 *
 * 截断必须**按字节**而不是按字符：一个汉字 3 字节、一个 emoji 4 字节，
 * 按字符砍会砍出远超上限的结果——`maxBytes - 20` 是按字节留的余量，
 * 却用在按字符切片上，于是「限 500 字节」实际输出了 504 字节。
 */
export function truncateCommandForDisplay(command, maxBytes = COMMAND_DISPLAY_MAX_BYTES) {
  const text = String(command ?? '')
  const total = Buffer.byteLength(text, 'utf8')
  if (total <= maxBytes) return { text, total, truncated: false }

  // 后缀「…（共 N 字节）」自己也要占位，先把它算出来再决定正文留多少。
  const suffix = `…（共 ${total} 字节）`
  const budget = Math.max(0, maxBytes - Buffer.byteLength(suffix, 'utf8'))

  let cut = ''
  let used = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > budget) break
    cut += ch
    used += size
  }
  return { text: `${cut}${suffix}`, total, truncated: true }
}
