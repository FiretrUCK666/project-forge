/**
 * command-lex.mjs —— 命令的词法切分与「动作词只认命令位置」。
 *
 * ## 它治的病
 *
 * 一个项目从零生成 `AGENTS.md` 时，工具会把自己从 CI 里抓来的命令装进「构建与验证」节。
 * 那些命令要分类（test / lint / build / install）。早先的分类是：
 *
 *     for (const kind of COMMAND_KINDS) if (kind.re.test(整段文本)) return kind.key
 *
 * 在一整段文本里搜第一个命中词，没有任何语法边界。于是实测三条全错：
 *
 * | 分类 | 真实内容 | 真正命中的词 |
 * | --- | --- | --- |
 * | `test` | `check.yml` 里整段 Bash | 文件名 `mac/test-mac-pure.sh` 里的 `test` |
 * | `lint` | `release.yml` 里打包那一段 | `git archive --format=zip` 里的 `format` |
 * | `install` | `check.yml` 里一整段 PowerShell | `.Restore` 属性名里的 `restore` |
 *
 * 还有一层在更上游：多行 `run:` 块被 `join(' && ')` 压成一行交给下游当「一条命令」。
 * 控制流被压平，本来互不相干的语句拼在一起，分类器要在大杂烩里猜。
 *
 * ## 判据：先切段，再看命令位置
 *
 * 一条命令的动作词只可能出现在**命令位置**——每段的第一个词（跳过环境变量赋值与前置
 * 修饰）。参数值（`--format=zip`）和属性名（`.Restore`）不是命令位置，那里出现的词
 * 不定义这条命令在干什么。
 *
 * 所以这里做两件事：`splitCommandSegments` 切段，`commandHeadOf` 取命令位置的词。
 * 分类只在前者给的每一段上，用后者给的词去比。
 */

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
    if (word.startsWith('-')) return undefined
    return word
  }
  return undefined
}

/**
 * 在一条命令的**命令位置**上找动作词，返回第一个命中的分类。
 *
 * `rules` 的形状：`[{ key, re }]`，`re` 只在命令名与动词上测。
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
  const positions = [head, verb].filter(Boolean)
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
