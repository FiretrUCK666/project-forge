#!/usr/bin/env node
/**
 * compose-agents.mjs —— 生成并维护项目的 AGENTS.md
 *
 * 存在两个理由，对应两种失败：
 *
 * 一、通用内核（行事总纲、本文件的定位与编辑规则、任务编排方法论）对任何项目都成立，
 *     应当逐字一致。靠手抄必然漂移——改了一处漏了另一处，几个月后各项目的「总纲」就
 *     各不相同了。所以内核收敛成单一来源 templates/agents-kernel.md，由本脚本注入。
 *
 * 二、首次生成时，项目特有的段落如果只给「填写要点」而不落成真实内容，交出去的
 *     就是一份空壳：使用者以为有了契约，实际里面全是「请说明本项目……」这类祈使句。
 *     所以本脚本读项目的**真实事实**填充能填的部分（项目名、构建命令、发布状态、
 *     有无远端），并对脚本判断不了的部分留下带标记的待填写项，**明确报出还剩几处**。
 *     宁可交出一份标着「还有 3 处待填写」的文件，也不要交出一份看起来完整、实际空洞的。
 *
 * 用法：
 *   node scripts/compose-agents.mjs [目录]              生成或刷新
 *   node scripts/compose-agents.mjs [目录] --check      只校验内核一致性，不写入
 *   node scripts/compose-agents.mjs [目录] --status     只报告待填写项，不写入
 *   node scripts/compose-agents.mjs [目录] --budget N   指定预算字节数（默认 65536）
 *
 * 模板标记（写在 templates/agents-project.md 里）：
 *   {{TOKEN}}                  由项目事实替换
 *   <!-- pf:if 条件 --> … <!-- pf:endif -->   按事实决定保留或丢弃，支持嵌套
 *   <!-- pf:author: 说明 -->    脚本填不了，留给作者；脚本会统计剩余数量
 *   <!-- pf:scaffold --> … <!-- pf:endscaffold -->  脚手架，待填写项归零后自动移除
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const KERNEL_PATH = join(SKILL_ROOT, 'templates', 'agents-kernel.md')
const SKELETON_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

const START = '<!-- project-forge:kernel:start -->'
const END = '<!-- project-forge:kernel:end -->'
/**
 * 「这份文件由本脚本生成」的标记。
 *
 * 它区分开两种**都带内核**的文件，而两者的验收标准不同：
 *   - **生成的文件**（从骨架生成）：节结构由模板决定，**缺节就是缺陷**，该报错；
 *   - **作者的文件**（手写后被 --upgrade 升级）：作者可能刻意换一种组织方式
 *     （本 skill 自己的 AGENTS.md 就是——它有「版本管理流程」而不是模板的「版本管理」），
 *     此时缺节只**提示**，不否决。
 *
 * 没有这个区分时只有两种错法：要么把作者的编排当成缺陷（误报，逼人改成模板的样子），
 * 要么对掏空的契约睁一眼闭一眼（漏报）。两者都发生过。
 */
const MANAGED = '<!-- project-forge:managed -->'
const DEFAULT_BUDGET = 65536

/**
 * 待填写标记。三种写法都要认：带说明、裸标记、以及多余空格。
 * 这里必须与 materialize 里的 MARK_RE **同样宽松**：曾经因为这里要求冒号、而 MARK_RE
 * 不要求，导致裸写的 `<!-- pf:author -->` 被保留在文件里却**不计入**待填写数——脚本
 * 报「0 处」并顺手移除了脚手架，而那个没填的 TODO 还留在正文里。
 */
const AUTHOR_RE = /<!--\s*pf:author\s*(?::[\s\S]*?)?-->/g

function readUtf8(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/**
 * 严格读取：只接受能**无损**读出的 UTF-8。
 *
 * 为什么要严格：这个文件每次会话都会被注入，而它可能在中文 Windows 上被记事本或
 * PowerShell 的 `Out-File` 存成 UTF-16、或因别的工具变成 GBK。宽松地读（Node 默认
 * 用替换字符吞掉无法解码的字节）会**丢掉原始字节**，然后脚本把这份已经失真的文本
 * 写回去——文件被改成 NUL 交错的乱码，而 `--check` 还报「内核一致」。
 * 那是唯一一种不可恢复的损坏，所以宁可不写，也不能写坏。
 *
 * 顺带嗅探 BOM：UTF-16/32 的 BOM 是明确信号，能给出比「解码失败」更具体的提示。
 */
function readUtf8Strict(p) {
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
      error: nul > 0
        ? `含 ${nul} 个 NUL 字节，看起来是 UTF-16（但缺 BOM）`
        : '不是合法的 UTF-8（可能是 GBK 等本地编码）',
    }
  }
  return { text: text.replace(/^\uFEFF/, '') }
}

/**
 * 判断文件处于什么状态。这是本脚本最关键的一次判断——三种状态的处理方式完全不同，
 * 而它们过去被压成了两种，于是**受损的受管文件被当成手写文件**：
 *
 *   - 手写：两个标记都没有 → 只体检，不动文件；
 *   - 受管：**恰好**一对标记 → 按节刷新；
 *   - 受损：标记数量不对（只有一个、或不止一对）→ **停下报错**。
 *
 * 受损那一格是必须存在的：删掉一行 `kernel:end` 就会让 `includes` 判定失败，
 * 于是脚本把它当成手写文件，`--upgrade` 把 14KB 内核**又插了一遍**——文件里出现两份
 * 内核，而 `--check` 只看第一对标记、`--status` 数不到缺节，两道门同时报绿。
 */
function documentState(text) {
  const starts = countOccurrences(text, START)
  const ends = countOccurrences(text, END)
  if (starts === 0 && ends === 0) return { kind: 'handwritten' }
  if (starts === 1 && ends === 1) {
    if (text.indexOf(END) < text.indexOf(START)) {
      return {
        kind: 'damaged',
        reason: '内核的结束标记出现在开始标记之前，顺序反了',
      }
    }
    return { kind: 'managed' }
  }
  const parts = []
  if (starts !== 1) parts.push(`开始标记 ${starts} 个（应为 1）`)
  if (ends !== 1) parts.push(`结束标记 ${ends} 个（应为 1）`)
  return {
    kind: 'damaged',
    reason: parts.join('，'),
    hint: starts > 1 || ends > 1
      ? '常见成因：复制粘贴了整段内核，或合并冲突留下了重复内容。'
      : '常见成因：编辑器吞掉了一行、合并冲突只留了一半。',
  }
}

/** 数一段文本里某个标记出现几次。 */
function countOccurrences(text, needle) {
  let n = 0
  let i = text.indexOf(needle)
  while (i >= 0) { n += 1; i = text.indexOf(needle, i + needle.length) }
  return n
}

// ── 项目事实 → 模板条件与取值 ───────────────────────────────────────────────

/**
 * 把勘察结果翻译成模板能用的条件与取值。
 *
 * 每个条件的判据都写在代码里而不是散在模板里：模板只声明「这段在什么条件下出现」，
 * 「什么时候满足这个条件」由这里统一决定。这样加一个新条件只需要改一处。
 */
function deriveFacts(target) {
  const s = survey(target)
  const manifestPath = s.ecosystem.kinds.includes('node') ? 'package.json' : undefined
  const commands = s.commands ?? {}
  // 「有没有可跑的命令」只看**真实命令字段**。
  // 要排除三类非命令的键，否则一个只有说明、没有命令的项目也会显示「有命令」：
  //   - `packageManager`：包管理器名，不是命令；
  //   - `byEcosystem` / `multipleEcosystems`：结构信息；
  //   - `*Note`：对某条命令的推断说明（例如「此命令按标准库推断」），本身不可执行。
  const NON_COMMAND_KEYS = new Set(['packageManager', 'byEcosystem', 'multipleEcosystems'])
  const hasCommands = Object.keys(commands)
    .some((k) => !NON_COMMAND_KEYS.has(k) && !k.endsWith('Note')
      && typeof commands[k] === 'string')

  // 可发布 = **有这个生态的可发布清单**且没被声明为私有。
  //
  // 这里踩过两次坑，都记下来免得再犯：
  //   一、曾经要求「声明了发布范围（files 白名单）」才算可发布——而绝大多数包并不写
  //       该字段（靠默认规则决定发什么），于是它们被判成不可发布；
  //   二、改成「有清单即可」之后又只认 `package.json`——于是**所有非 JS 项目**（Python
  //       的 pyproject.toml、Rust 的 Cargo.toml、Go 的 go.mod）一律被判成不可发布，
  //       整块丢掉版本号语义、抬版本号判据、发版规则、角色判定，而能力矩阵明写
  //       「python / rust / go：发布视声明而定」。
  // 判据现在来自勘察读出的 `publishableManifest`——它按各生态的清单文件名逐個确认，
  // 不依赖「主生态是不是 node」。
  const publishableManifest = s.artifacts?.publishableManifest
  const publishable = publishableManifest !== undefined && s.artifacts?.private !== true

  // 有依赖 = 清单里声明了任意一类依赖，或其他生态的依赖声明文件存在
  let hasDeps = false
  if (manifestPath !== undefined) {
    // 依赖字段名各生态不同，这里按「清单里出现 dependency 字样的键」判断，
    // 避免把某个生态的字段名写死。
    try {
      const pkg = JSON.parse(readUtf8(join(target, manifestPath)))
      hasDeps = Object.keys(pkg).some((k) => /dependenc/i.test(k) && (
        typeof pkg[k] === 'object' ? Object.keys(pkg[k]).length > 0 : false
      ))
    } catch { /* 读不到就按无依赖处理 */ }
  }
  if (!hasDeps) {
    hasDeps = ['requirements.txt', 'Pipfile', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Gemfile', 'composer.json']
      .some((f) => existsSync(join(target, f)))
  }

  const hasGit = s.git?.present === true
  // 非仓库根时远端/分支/提交数全属外层仓库（survey 已标 note），此处必须丢弃——
  // 否则会生成“本地+远端/角色判定/发版规则”，与 SKILL 能力矩阵 isRepoRoot 优先行矛盾，
  // 实测后果是往毫不相干的仓库推。判据与 survey.mjs 的 samePath 三层放宽同源。
  const isRepoRoot = s.git?.isRepoRoot !== false
  const hasRemote = typeof s.git?.remote === 'string' && s.git.remote.length > 0 && isRepoRoot

  // 「有没有版本号」决定发版规则怎么写：有版本号时标签名要对齐它，没有时命名自定。
  // 这两个分支必须都在——只写「标签名必须与版本号一致」会让没有版本号的项目无从下手，
  // 而没有版本号的项目并不少见（不发布制品的工具、纯文档项目、以及 skill 本身）。
  const hasVersion = typeof s.artifacts?.declaredVersion === 'string'
    && s.artifacts.declaredVersion.trim() !== ''

  // 「说明文档是不是多语言的」决定要不要把成对维护规则写进契约。
  //
  // 这一条是**机制缺口**补上的：references 里早就写了双语文档会漂移、要成对改，
  // 但模板里没有对应段落——于是生成出来的契约里没有这条规则，项目也就不会照它做。
  // 实测后果：一个双语文档的项目，英文版漏掉了一条更新命令，而它的契约里
  // 一个字都没提「中文改了英文也要改」。规则写在参考文件里只对「读过那份文件的人」
  // 有效；写进项目自己的契约，才对**以后每一次会话**有效。
  const hasBilingualReadme = s.docs?.readmePair !== undefined

  // 插件类条件：只按勘察事实求值，不猜具体取值。模板里的 DSH 段落靠它们显隐，
  // 非插件项目不受影响；读不到即按无处理。
  const isDshPlugin = s.ecosystem.kinds.includes('dsh-plugin')
  const hasDshClient = s.dsh?.hasClientEntry === true || s.dsh?.hasClientDecl === true
  const hasDshBundle = s.dsh?.bundlePatch !== undefined || s.dsh?.patchFile !== undefined
  // 上游跟踪：有远端才有意义；非仓库根时远端属外层仓库，已随 has-remote 置假。
  const hasUpstream = hasRemote && typeof s.git?.upstream === 'string' && s.git.upstream.length > 0

  // 条件名**显式成对声明**，不靠「自动加前缀取反」推导。
  // 推导出来的名字（例如把 has-git 取反成 no-has-git）看着能跑，实则一改规则就静默
  // 产出错名字；而模板里的未知条件会直接报错，等于把错误推迟到运行时。
  // 模板里用到哪个名字，这里就必须有哪个名字——这样「模板要什么」与「脚本给什么」
  // 是同一份清单，漏了立刻报错。
  const conditions = {
    'has-git': hasGit,
    'no-git': !hasGit,
    'has-remote': hasRemote,
    'no-remote': !hasRemote,
    'has-commands': hasCommands,
    'no-commands': !hasCommands,
    'has-version': hasVersion,
    'no-version': !hasVersion,
    'has-bilingual-readme': hasBilingualReadme,
    'no-bilingual-readme': !hasBilingualReadme,
    'has-deps': hasDeps,
    'no-deps': !hasDeps,
    'is-dsh-plugin': isDshPlugin,
    'has-dsh-client': hasDshClient,
    'has-dsh-bundle': hasDshBundle,
    'has-upstream': hasUpstream,
    'no-upstream': !hasUpstream,
    publishable,
    'no-publish': !publishable,
  }

  // 项目名优先取**项目自己声明的**名字（各生态清单里的 name），没有才退回目录名。
  // 目录名常常是临时起的（demo、new-project），而清单里的名字才是项目身份。
  // 判据挂在清单文件上，不挂在主生态上——非 JS 项目同样有正式名字。
  let projectName = s.target.name
  const nameReaders = [
    [manifestPath, (pkg) => pkg.name],
    ['pyproject.toml', (text) => /^name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]],
    ['Cargo.toml', (text) => /^\s*name\s*=\s*["']([^"']+)["']/m.exec(text)?.[1]],
    ['go.mod', (text) => /^module\s+(\S+)/m.exec(text)?.[1]?.split('/').pop()],
  ]
  for (const [file, pick] of nameReaders) {
    if (file === undefined || projectName !== s.target.name) continue
    try {
      const raw = readUtf8(join(target, file))
      const hit = file === manifestPath ? pick(JSON.parse(raw)) : pick(raw)
      if (typeof hit === 'string' && hit.trim().length > 0) {
        projectName = hit.trim().replace(/^@[^/]+\//, '') // 去掉作用域前缀，标题里更好读
      }
    } catch { /* 解析失败就试下一个，最终用目录名 */ }
  }

  const tokens = {
    PROJECT_NAME: projectName,
    COMMANDS: renderCommands(commands),
  }

  return { survey: s, conditions, tokens }
}

/**
 * 把推导出的命令渲染成可直接粘进文档的 shell 块。
 *
 * 多生态项目**按生态分组渲染**，不做扁平化：扁平视图里同名字段只会留下一个生态的值
 * （后算的覆盖先算的），写进文档就是把一条属于别的生态的命令当成这个项目的命令。
 * 这种错误很难被发现——命令看起来完全正常，只是跑的不是这个项目。
 */
function renderCommands(commands) {
  const labels = [
    ['install', '安装依赖'],
    ['build', '构建'],
    ['typecheck', '类型检查'],
    ['lint', '静态检查'],
    ['test', '测试'],
    ['verify', '自检'],
    ['smoke', '冒烟'],
  ]
  const renderOne = (cmds) => {
    const lines = []
    for (const [key, label] of labels) {
      const command = cmds[key]
      if (typeof command !== 'string') continue
      lines.push(`# ${label}`)
      lines.push(command)
      // 命令带「推断说明」时紧跟其后写明，别让读者以为它是项目自己声明的。
      const note = cmds[`${key}Note`]
      if (typeof note === 'string') lines.push(`# （${note}）`)
    }
    return lines
  }

  if (commands.byEcosystem === undefined) return renderOne(commands).join('\n')

  const parts = []
  for (const kind of commands.multipleEcosystems ?? Object.keys(commands.byEcosystem)) {
    const lines = renderOne(commands.byEcosystem[kind])
    if (lines.length === 0) continue
    parts.push(`# ${kind}`)
    parts.push(...lines)
  }
  return parts.join('\n')
}

// ── 模板求值 ────────────────────────────────────────────────────────────────

/**
 * 按条件求值模板，替换取值，并统计待填写项。
 *
 * 用栈处理条件块，因此支持嵌套。**未知条件直接报错**而不静默丢弃——静默丢弃会让一段
 * 内容凭空消失，而且没人会发现。
 */
function materialize(template, facts) {
  const TOKEN_RE = /\{\{([^{}]*)\}\}/g
  const MARK_RE = /<!--\s*pf:(if\s+[^\s>]+|endif|scaffold|endscaffold|author\s*(?::[\s\S]*?)?)\s*-->/g

  const out = []
  const stack = [] // { kind: 'if'|'scaffold', active: boolean }
  const unknownConditions = []
  const unknownTokens = new Set()
  let cursor = 0

  const active = () => stack.every((f) => f.active)

  const emit = (text) => {
    if (!active()) return
    out.push(text.replace(TOKEN_RE, (whole, name) => {
      // 只有「全大写字母数字下划线」才算合法取值名。其余形状（小写、驼峰、含空格、
      // 空名）一律当错误报出来：它们看着像占位符却不会被替换，会原样发到成品里，
      // 而那种字符串看起来只是普通文本，没人会去核对。
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) { unknownTokens.add(whole); return whole }
      if (!(name in facts.tokens)) { unknownTokens.add(whole); return whole }
      return facts.tokens[name]
    }))
  }

  let m
  MARK_RE.lastIndex = 0
  while ((m = MARK_RE.exec(template)) !== null) {
    emit(template.slice(cursor, m.index))
    cursor = m.index + m[0].length
    const body = m[1]

    if (body.startsWith('if ')) {
      const name = body.slice(3).trim()
      if (!(name in facts.conditions)) {
        unknownConditions.push(name)
        stack.push({ kind: 'if', active: false })
      } else {
        stack.push({ kind: 'if', active: facts.conditions[name] === true })
      }
      continue
    }
    if (body === 'endif') {
      if (stack.length === 0) throw new Error('模板里的 pf:endif 没有对应的 pf:if。')
      const frame = stack[stack.length - 1]
      if (frame.kind !== 'if') {
        throw new Error('pf:endif 与最近打开的 pf:scaffold 不匹配——'
          + '用 pf:endscaffold 收尾脚手架，写反了会让那段内容永远删不掉。')
      }
      stack.pop()
      continue
    }
    if (body === 'scaffold') {
      // 脚手架标记必须**保留在产出里**：它要靠 stripScaffold 在「待填写项归零」的那次
      // 运行中把整段移除。若在这里丢掉标记，产出里只剩一段没人认领的注释，永远删不掉。
      stack.push({ kind: 'scaffold', active: true })
      if (active()) out.push(m[0])
      continue
    }
    if (body === 'endscaffold') {
      if (stack.length === 0) throw new Error('模板里的 pf:endscaffold 没有对应的 pf:scaffold。')
      const frame = stack[stack.length - 1]
      if (frame.kind !== 'scaffold') throw new Error('pf:endscaffold 与最近打开的 pf:if 不匹配。')
      stack.pop()
      // 同上：标记本身要留下。注意 emit 用的是弹出后的栈状态，所以先弹再写。
      if (active()) out.push(m[0])
      continue
    }
    // pf:author：保留标记本身，它是要交出去的待办事项
    if (active()) out.push(m[0])
  }
  emit(template.slice(cursor))

  if (stack.length > 0) throw new Error('模板里有未闭合的 pf:if 或 pf:scaffold。')
  if (unknownConditions.length > 0) {
    throw new Error(`模板使用了未知条件：${[...new Set(unknownConditions)].join('、')}。`
      + '请在 compose-agents.mjs 的 deriveFacts() 里定义它，不要让它静默丢弃内容。')
  }
  if (unknownTokens.size > 0) {
    throw new Error(`模板里出现了无法替换的取值：${[...unknownTokens].join('、')}。`
      + '合法取值名只能是全大写字母、数字与下划线，且必须在 deriveFacts() 的 tokens 里'
      + '定义；否则它会原样留在成品里。')
  }

  // 条件段落被丢弃后会留下成串空行（一个条件块前后各有一行）。不清理的话，产出里
  // 到处是三四行空白，看起来像排版事故，读的人会以为内容丢了。
  return collapseBlankLines(out.join(''))
}

/** 统计待填写项，并给出它们各自所在的小节标题。 */
function findAuthors(text) {
  const found = []
  const lines = text.split('\n')
  let lastHeading = '(文件开头)'
  for (const line of lines) {
    const heading = /^#{2,3}\s+(.+?)\s*$/.exec(line)
    if (heading !== null) lastHeading = heading[1]
    for (const hit of line.matchAll(AUTHOR_RE)) {
      const note = /pf:author:\s*([\s\S]*?)\s*-->/.exec(hit[0])
      found.push({ section: lastHeading, note: note === null ? '' : note[1] })
    }
  }
  return found
}

/** 待填写项归零后，脚手架段落自动移除。 */
function stripScaffold(text, authorCount) {
  if (authorCount > 0) return text
  return text.replace(/<!--\s*pf:scaffold\s*-->[\s\S]*?<!--\s*pf:endscaffold\s*-->\n?/g, '')
}

/** 折叠被丢弃的条件段落留下的成串空行。生成与刷新两条路径都要走它。 */
function collapseBlankLines(text) {
  return text.replace(/\n{3,}/g, '\n\n')
}

/** 把文本按二级标题切成「前言 + 各节」，用于按节合并。 */
function splitSections(text) {
  const lines = text.split('\n')
  const head = []
  const sections = []
  let current = undefined
  for (const line of lines) {
    const isH2 = /^##\s+\S/.test(line)
    if (isH2) {
      if (current !== undefined) sections.push(current)
      current = { heading: line.trim(), lines: [line] }
      continue
    }
    if (current === undefined) head.push(line)
    else current.lines.push(line)
  }
  if (current !== undefined) sections.push(current)
  return { head: head.join('\n'), sections }
}

/**
 * 把内核区整段摘出来，换成一行占位。
 *
 * 必须这么做：**内核自己就含有二级标题**（行事总纲、本文件的定位与编辑规则、任务编排
 * 方法论）。若不摘除就按二级标题切分，内核里的每一节都会被当成普通节参与合并——它们
 * 在「新求值的结果」里不存在（那时内核是空的），于是每次刷新都被当作「用户自己加的节」
 * 追加一遍。文件于是每跑一次就膨胀一份内核。
 */
function extractKernel(text) {
  const startAt = text.indexOf(START)
  const endAt = text.indexOf(END)
  if (startAt < 0 || endAt < 0) return { body: text, hadKernel: false }
  const placeholder = '<!-- project-forge:kernel-placeholder -->'
  const body = text.slice(0, startAt + START.length) + '\n' + placeholder + '\n'
    + text.slice(endAt)
  return { body, hadKernel: true }
}

/**
 * 按当前事实重新求值模板，再与既有文件**按节合并**。
 *
 * 合并判据只有一条，而且判据来自**新求值的结果**：
 *   - 新结果里这一节带 `pf:author`（模板说「这里要人写」）→ 保留既有内容，人写的或
 *     已经填好的不能被冲掉；
 *   - 新结果里这一节不带 `pf:author`（纯生成内容）→ 采用新结果，让条件段落能随事实
 *     变化而增删。
 *
 * 反过来判断（看旧文件有没有 author 标记）是错的：纯生成的小节本来就没有 author 标记，
 * 会被误判成「人已填写」，于是**永远冻结**——「有远端才有」的那几段就再也补不进来。
 */
function refreshFromTemplate(target, existing, kernel) {
  const facts = deriveFacts(target)
  const rendered = materialize(readUtf8(SKELETON_PATH), facts)

  const oldBody = extractKernel(existing).body
  const freshBody = extractKernel(rendered).body
  const fresh = splitSections(freshBody)
  const old = splitSections(oldBody)

  const oldByHeading = new Map()
  for (const section of old.sections) {
    if (!oldByHeading.has(section.heading)) oldByHeading.set(section.heading, section)
  }
  const freshByHeading = new Map()
  for (const section of fresh.sections) {
    if (!freshByHeading.has(section.heading)) freshByHeading.set(section.heading, section)
  }

  const added = []
  const kept = []
  const missing = []
  const refreshed = []

  // 按**既有文件的顺序**遍历，不按模板顺序。
  //
  // 两个理由：一是重排一个已经写好的文档会让人以为内容被动过（实测本 skill 自己的
  // AGENTS.md 就因为顺序不同被整体重排）；二是模板的顺序是给人「第一次怎么写」用的，
  // 一旦文件已经存在，作者摆放它的方式就是权威。
  const merged = []
  for (const section of old.sections) {
    const freshSection = freshByHeading.get(section.heading)
    if (freshSection === undefined) {
      // 模板里已经没有这个标题：原样保留。可能是作者自己加的，也可能是作者刻意换了一种
      // 组织方式（本 skill 自己的「版本管理流程」就是如此）。脚本不删。
      kept.push(section.heading)
      merged.push(section)
      continue
    }
    const freshText = freshSection.lines.join('\n')
    if (findAuthors(freshText).length > 0) {
      // 模板说这一节要人来写：保留既有内容，别把人写的冲掉
      kept.push(section.heading)
      merged.push(section)
    } else {
      // 纯生成内容：用新求值的结果，让条件段落能随事实增删
      refreshed.push(section.heading)
      merged.push(freshSection)
    }
  }
  // 模板里有、文件里没有的节：**不自动添加**，只报告。
  //
  // 这条限制是必要的：本 skill 自己的 AGENTS.md 就是手写的，它与模板共享若干标题
  // （环境与上下文、构建与验证……）。若刷新时把模板的每个节都补进去，手写文档会被灌进
  // 一整套通用样板——实测会多出一个与手写版本节并列的「版本管理（必守）」，两份内容
  // 互相打架。而条件段落照样能随事实变化：它们绝大多数是**已有节内部的子节**（例如
  // 「发版规则」是版本管理节里的三级标题），在上一段里正常求值。
  const oldHeadings = new Set(old.sections.map((s) => s.heading))
  for (const section of fresh.sections) {
    if (!oldHeadings.has(section.heading)) missing.push(section.heading)
  }

  // 前言（标题与效力声明）也保留既有的：它常写着这个项目特有的完成标准，是作者写的，
  // 不该被模板里那句通用表述换掉。
  const head = old.head.trim().length > 0 ? old.head : fresh.head
  const parts = [head]
  for (const section of merged) parts.push(section.lines.join('\n'))

  let text = parts.join('\n')
  text = injectKernel(text, kernel)
  const authors = findAuthors(text)
  text = stripScaffold(text, authors.length)
  text = collapseBlankLines(text)

  const report = { added, kept, refreshed, missing, authors: authors.length }
  return { text, report }
}

function kernelBody() {
  if (!existsSync(KERNEL_PATH)) throw new Error(`找不到内核模板：${KERNEL_PATH}`)
  return readUtf8(KERNEL_PATH)
    .replaceAll(START, '').replaceAll(END, '')
    .replace(/^\n+/, '').replace(/\n+$/, '')
}

/** 用内核替换标记之间的内容。标记缺失即报错——绝不猜测该插到哪里。 */
function injectKernel(text, kernel) {
  const startAt = text.indexOf(START)
  const endAt = text.indexOf(END)
  if (startAt < 0 || endAt < 0) {
    throw new Error(
      `AGENTS.md 里找不到内核标记。请先放入这一对标记，再执行注入：\n  ${START}\n  ${END}`,
    )
  }
  if (endAt < startAt) throw new Error('内核标记顺序颠倒：end 出现在 start 之前。')
  const before = text.slice(0, startAt + START.length)
  const after = text.slice(endAt)
  const injected = `${before}\n${kernel}\n${after}`

  // 多余的第二个内核区要清掉。
  //
  // 这不是假想情况：把文件内容复制粘贴一遍就会产生两块。而 `indexOf` 只找**第一个**
  // 结束标记，于是第二块被原样留在 `after` 里——文件从此带着两份内核，每次注入都
  // 继续留着，越往后越没人说得清哪个是真的。既然本脚本拥有这段内容，重复的部分就
  // 由它清掉，而不是留着让读者困惑。
  const extraStart = injected.indexOf(START, injected.indexOf(START) + START.length)
  if (extraStart < 0) return injected
  const firstEnd = injected.indexOf(END) + END.length
  // 只保留第一份，删掉其后所有成对的内核区
  const head = injected.slice(0, firstEnd)
  let rest = injected.slice(firstEnd)
  rest = rest.replace(new RegExp(
    `${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n?`, 'g'), '')
  return collapseBlankLines(head + rest)
}

/** 把字符串转义成正则字面量。 */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 给一个**手写的、没有内核标记的** AGENTS.md 做增量升级。
 *
 * 这是「项目已经有了 AGENTS.md，但写得不好或漏了很多」这一常见场景的入口。它必须做到
 * 三件事，缺一件就不合格：
 *   1. **不报错退出**——原来的实现直接抛「找不到内核标记」，把最常见的场景变成了死路；
 *   2. **不破坏已有内容**——手写的段落一律保留，包括它自己那套标题体系；
 *   3. **只做加法，并把加了什么说清楚**——插入内核、补上缺失的节，然后逐条报告。
 *
 * 内核插在一级标题之后、第一个二级标题之前。这是唯一不需要猜测的位置：文件标题是
 * 每个 AGENTS.md 都有的，而内核属于「总纲」性质，放在正文之前符合它被阅读的顺序。
 */
function upgradeHandwritten(existing, kernel, target) {
  const fresh = splitSections(materialize(readUtf8(SKELETON_PATH), deriveFacts(target)))
  const old = splitSections(existing)

  // 1) 插入内核：一级标题之后、第一个二级标题之前。
  const lines = existing.split('\n')
  let insertAt = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s+\S/.test(lines[i])) { insertAt = i; break }
  }
  if (insertAt < 0) insertAt = lines.length // 通篇没有二级标题：追加到末尾
  const withKernel = [
    ...lines.slice(0, insertAt),
    START,
    kernel,
    END,
    '',
    ...lines.slice(insertAt),
  ].join('\n')

  // 2) 补上缺失的节：只补「语义上明显缺」的整节，且一律追加在末尾，不改动原有顺序。
  const oldHeadings = new Set(old.sections.map((s) => s.heading))
  const added = []
  const parts = [withKernel.replace(/\n+$/, '')]
  for (const section of fresh.sections) {
    if (oldHeadings.has(section.heading)) continue
    // 纯生成内容才补：需要人写的节补进去也是一堆占位符，不如让 AI 按上下文写
    const body = section.lines.join('\n')
    if (findAuthors(body).length > 0) continue
    parts.push(body)
    added.push(section.heading)
  }

  let text = collapseBlankLines(parts.join('\n\n'))
  if (!text.endsWith('\n')) text += '\n'
  return { text, added }
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_NOTE = `预算默认 ${DEFAULT_BUDGET} 字节`

function parseArgs(argv) {
  const positional = []
  let check = false
  let status = false
  let upgrade = false
  let budget = DEFAULT_BUDGET
  let help = false
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') { check = true; continue }
    if (arg === '--status') { status = true; continue }
    if (arg === '--upgrade') { upgrade = true; continue }
    if (arg === '--help' || arg === '-h') { help = true; continue }
    if (arg === '--budget') {
      const value = Number(argv[i + 1])
      if (!Number.isFinite(value) || value <= 0) throw new Error('--budget 需要一个正整数字节数。')
      budget = value
      i += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`)
    positional.push(arg)
  }
  return { check, status, upgrade, budget, help, positional }
}

/**
 * 报告缺口。两件事都要说，缺一件就会误导：
 *
 *   - **待填写项**（`pf:author`）：模板说要人写的节，还没写；
 *   - **缺失的节**：模板里有、文件里没有的节。
 *
 * 为什么两个都要：`--upgrade` 刻意**不补**需要人写的节（补进去只是占位符），于是
 * 一份刚升级完、一个项目节都没写的手写文件，`pf:author` 数**立刻就是 0**——如果只报
 * 「待填写 0 处」，使用者会以为写完了，而实际上项目定位、架构、不变量、构建验证、
 * 硬性规范、测试约定六节全缺。这正是 SKILL.md 自己警告过的「看起来完整、实际空洞」，
 * 而报告本身成了那个错觉的来源。
 */
function reportGaps(authors, missing, stream) {
  const complete = authors.length === 0 && missing.length === 0
  if (complete) {
    stream.write('\n内容完整：没有待填写项，也没有缺失的节。\n')
    return
  }
  if (authors.length > 0) {
    stream.write(`\n待填写 ${authors.length} 处（脚本填不了，要读代码后写）：\n`)
    const seen = new Set()
    for (const { section, note } of authors) {
      const line = note === '' ? section : `${section} —— ${note}`
      if (seen.has(line)) continue
      seen.add(line)
      stream.write(`  - ${line}\n`)
    }
  }
  if (missing.length > 0) {
    stream.write(`\n缺失 ${missing.length} 个节（模板里有、本文件没有）：\n`)
    for (const m of missing) {
      stream.write(`  - ${m.heading}${m.needsHuman ? '（需要读代码后自己写）' : '（可由脚本补）'}\n`)
    }
    stream.write('**这些节没写，文档就不算完成**——它们正是未来的会话真正需要的内容。\n')
  }
  stream.write('写完后重跑本脚本，确认「内容完整」。\n')
}

/** 算出相对模板还缺哪些节。`--status` 与普通运行共用同一份判据。 */
function missingSections(target, currentText) {
  const fresh = splitSections(materialize(readUtf8(SKELETON_PATH), deriveFacts(target)))
  const have = new Set(splitSections(currentText)
    .sections.map((s) => s.heading))
  return fresh.sections
    .filter((s) => !have.has(s.heading))
    .map((s) => ({ heading: s.heading, needsHuman: findAuthors(s.lines.join('\n')).length > 0 }))
}

/**
 * 手写 AGENTS.md 的体检报告。
 *
 * 这是「项目已经有 AGENTS.md，但写得不好或漏了很多」场景的默认动作：**不动文件**，
 * 只把事实摊开——它有什么、缺什么、和标准结构的差距在哪——然后给出明确的下一步。
 *
 * 为什么不直接升级：这份文件是别人写的，重排和补写都属于对他人成果的改动。默认沉默地
 * 改掉，比不动更糟。但也不能像以前那样报错退出——那等于告诉使用者「你这个场景不支持」。
 * 所以默认只报告，升级要显式要求。
 */
function reportHandwritten(agentsPath, existing, target, kernel, budget, status, check) {
  const facts = deriveFacts(target)
  const rendered = materialize(readUtf8(SKELETON_PATH), facts)
  const standard = splitSections(rendered)
  const current = splitSections(existing)

  const have = new Set(current.sections.map((s) => s.heading))
  const missing = standard.sections
    .filter((s) => !have.has(s.heading))
    .map((s) => ({ heading: s.heading, needsHuman: findAuthors(s.lines.join('\n')).length > 0 }))

  const bytes = Buffer.byteLength(existing, 'utf8')
  const out = []
  out.push(`${agentsPath}`)
  out.push(`  这是一份手写的 AGENTS.md（没有内核标记），共 ${bytes} 字节。`)
  out.push(`  本脚本**没有改动它**——手写文件的改动应当由你确认后再做。`)
  out.push('')
  out.push(`  它现有的节（${current.sections.length} 个）：`)
  for (const s of current.sections) out.push(`    - ${s.heading}`)
  if (missing.length > 0) {
    out.push('')
    out.push(`  与标准结构相比，缺少这些节（${missing.length} 个）：`)
    for (const m of missing) {
      out.push(`    - ${m.heading}${m.needsHuman ? '（需要读代码后自己写）' : '（可自动补）'}`)
    }
  }

  const emit = (stream) => { for (const line of out) stream.write(`${line}\n`) }

  if (check) {
    // 校验模式下没有内核就是不达标；但要把「怎么办」说清楚，而不是只报一句失败
    emit(process.stdout)
    process.stderr.write('\n校验失败：这份 AGENTS.md 还没有内核标记，无法与模板比对。\n'
      + `  要把它升级为标准结构（只会增加内容，不删不改已有段落）：\n`
      + `    node "<本领目录>/scripts/compose-agents.mjs" "${target}" --upgrade\n`)
    return 1
  }
  if (status) {
    emit(process.stdout)
    return 0
  }

  emit(process.stdout)
  process.stdout.write('\n下一步：\n'
    + '  - 想保留原样、只做体检 → 到此为止，本脚本不会动它。\n'
    + '  - 想升级为标准结构 → 加 --upgrade 再跑一次。它只做加法：\n'
    + '      插入内核段落、补上上面标着「可自动补」的节；\n'
    + '      已有的段落一个字节都不删、不改、不重排。\n')
  return 0
}

/**
 * 报告刷新时做了什么。三件事都值得说，因为它们都改变了文件内容，而使用者需要知道
 * 「为什么这次跑完文件变了」——尤其是「模板里有而文件里没有」的节，脚本刻意不补，
 * 让人自己决定。
 */
function reportRefresh(report, stream) {
  if (report === undefined) return
  if (report.upgradedFrom === 'handwritten') {
    stream.write('\n已按标准结构升级这份手写的 AGENTS.md（只做加法）：\n')
    stream.write('  - 插入了内核段落（行事总纲、本文件的定位与编辑规则、任务编排方法论）\n')
    if (report.added.length > 0) {
      stream.write(`  - 补上了 ${report.added.length} 个缺失的节：\n`)
      for (const a of report.added) stream.write(`      ${a}\n`)
    }
    stream.write('  - 原有段落全部保留（未删除、未改写、未重排）\n')
    return
  }
  if (report.refreshed !== undefined && report.refreshed.length > 0) {
    stream.write(`\n按当前项目事实重新求值的节（共 ${report.refreshed.length} 节）：\n`)
    for (const r of report.refreshed) stream.write(`  - ${r}\n`)
  }
  if (report.missing.length > 0) {
    stream.write(`\n模板里有、本文件没有的节（未自动添加，需要就手动补）：\n`)
    for (const m of report.missing) stream.write(`  - ${m}\n`)
  }
  if (report.kept.length > 0) {
    stream.write(`\n保留原样的节（共 ${report.kept.length} 节，人写的内容不动）\n`)
  }
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  const { check, status, upgrade, budget, help, positional } = parsed
  if (help) {
    process.stdout.write([
      '用法：node scripts/compose-agents.mjs [目录] [选项]',
      '',
      '  生成或刷新目标项目的 AGENTS.md。',
      '  - 文件不存在 → 按项目事实生成一份；',
      '  - 文件已存在且有内核标记 → 按节合并：人写的保留，纯生成的按当前事实重新求值；',
      '  - 文件已存在但**没有**内核标记（手写的）→ 默认只体检、不动它。',
      '',
      '  --upgrade  把一份手写的 AGENTS.md 升级为标准结构。**只做加法**：',
      '             插入内核段落、补上缺失的自动节；已有段落不删不改不重排。',
      '  --check    只校验内核一致性，不写入；不一致时退出码 1',
      '  --status   只报告现状，不写入',
      `  --budget N ${DEFAULT_BUDGET_NOTE}`,
      '',
    ].join('\n'))
    return 0
  }

  const target = resolve(positional[0] ?? process.cwd())
  const agentsPath = join(target, 'AGENTS.md')

  let kernel
  try {
    kernel = kernelBody()
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }

  const exists = existsSync(agentsPath)
  // AGENTS.md 是个**目录**时给一句人话，而不是抛内部的 EISDIR。
  if (exists && statSync(agentsPath).isDirectory()) {
    process.stderr.write(
      `错误：${agentsPath} 是一个目录，不是文件。\n`
      + '  本脚本要写的是文件。请先把这个同名目录移走或改名，再重跑。\n',
    )
    return 2
  }
  // 清理上次异常退出留下的临时文件（正常情况下改名后它就不存在了）
  for (const stale of [`${agentsPath}.tmp-${process.pid}`]) {
    if (existsSync(stale)) { try { unlinkSync(stale) } catch { /* 清不掉就算了 */ } }
  }
  if (check && !exists) {
    process.stderr.write(`校验失败：${agentsPath} 不存在。\n`)
    return 1
  }

  let composed
  let refreshReport
  let managedExisting
  try {
    if (exists) {
      // ① 编码守卫：读不出无损 UTF-8 就**不写**。
      // 宽松地读会把无法解码的字节替换掉，再写回去就是不可恢复的损坏。
      const read = readUtf8Strict(agentsPath)
      if (read.error !== undefined) {
        process.stderr.write(
          `错误：无法把 ${agentsPath} 当作 UTF-8 读取——${read.error}。\n`
          + '  **本脚本没有改动它。**\n'
          + '  这个文件每次会话都会被注入，而且要在版本库里长期保存，所以它必须是 UTF-8。\n'
          + '  请先用编辑器把它转存为 UTF-8（不要用「Unicode」「ANSI」这些本地编码选项），再重跑。\n',
        )
        return 2
      }
      const existing = read.text

      // ② 三态判定：手写 / 受管 / 受损。受损必须停下，不能当成手写。
      const state = documentState(existing)
      if (state.kind === 'damaged') {
        process.stderr.write(
          `错误：${agentsPath} 的内核标记受损——${state.reason}。\n`
          + `  ${state.hint ?? ''}\n`
          + '  **本脚本没有改动它。**\n'
          + '  请手工把标记修回恰好一对（下面这两行，各一个）：\n'
          + `    ${START}\n    ${END}\n`
          + '  修好后重跑；若确认想丢弃内核段落重新生成，删掉这两行后再跑，'
          + '它会被当作手写文件对待。\n',
        )
        return 2
      }

      if (state.kind === 'handwritten') {
        // 手写的 AGENTS.md：不带内核标记。
        //
        // 这是「项目已经有一个 AGENTS.md，但写得不好或漏了很多」的常见场景。此时**不能
        // 报错退出**（那会把最常见的场景变成死路），也不能擅自重写（那是覆盖用户的成果）。
        // 默认只做体检并给出下一步；用户明确要升级时才动手，且只做加法。
        if (!upgrade) return reportHandwritten(agentsPath, existing, target, kernel, budget, status, check)
        const upgraded = upgradeHandwritten(existing, kernel, target)
        composed = upgraded.text
        refreshReport = { upgradedFrom: 'handwritten', added: upgraded.added, kept: [], refreshed: [], missing: [] }
      } else {
        managedExisting = existing
        const refreshed = refreshFromTemplate(target, existing, kernel)
        composed = refreshed.text
        refreshReport = refreshed.report
      }
      if (!composed.endsWith('\n')) composed += '\n'
    } else {
      if (check) {
        process.stderr.write(`校验失败：${agentsPath} 不存在。\n`)
        return 1
      }
      if (!existsSync(SKELETON_PATH)) {
        process.stderr.write(`错误：找不到骨架 ${SKELETON_PATH}。\n`)
        return 2
      }
      const facts = deriveFacts(target)
      composed = materialize(readUtf8(SKELETON_PATH), facts)
      if (!composed.endsWith('\n')) composed += '\n'
      const authors = findAuthors(composed)
      composed = stripScaffold(composed, authors.length)
      if (!composed.endsWith('\n')) composed += '\n'
      composed = injectKernel(composed, kernel)
      // 记住「这是生成的文件」：它的节结构由模板决定，缺节即缺陷。
      composed = composed.replace('\n\n' + START, `\n\n${MANAGED}\n\n${START}`)
      if (!composed.endsWith('\n')) composed += '\n'
    }
  } catch (error) {
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  // 沿用原文件的行尾风格。
  //
  // 不这么做的话，一个 CRLF 的文件在「事实发生变化、需要重写」时会**整篇变成 LF**，
  // 而 git 会把每一行都记为改动——正是本文档自己「构建可复现」一节讲过的那个坑。
  // 只在原文件确实是 CRLF 时才转回去，不猜。
  if (exists && managedExisting !== undefined && /\r\n/.test(readFileSync(agentsPath, 'utf8'))
    && !/\r\n/.test(composed)) {
    composed = composed.replace(/\n/g, '\r\n')
  }

  const authors = findAuthors(composed)
  const bytes = Buffer.byteLength(composed, 'utf8')
  const ratio = ((bytes / budget) * 100).toFixed(1)
  const current = exists ? readUtf8(agentsPath) : undefined
  const same = current !== undefined && composed === current

  // `--check` 判什么，与它**自称**判什么必须一致。
  //
  // 它过去判的是「整个文件是否等于按当前事实重跑一遍的结果」，而文案写的是「内核与
  // 模板是否逐字一致」。两者差得很远，且两个方向都出错：
  //   误报通过——复制或删掉一个纯生成节不改整文件？不，那是差异；但**重复节**与
  //     **整节被删**在特定路径下同样能过，而缺节本该是失败；
  //   误报失败——在某个生成节里合法地加一行注释，会被指控成「内核不一致」，
  //     尽管内核区间逐字节相同。
  // 现在它判三件事，各自独立报错：内核区间逐字一致、标记恰好一对、没有缺失的节。
  if (check) {
    const problems = []
    const warnings = []
    if (managedExisting === undefined) {
      problems.push('这份 AGENTS.md 还是手写的，没有内核标记（用 --upgrade 升级）')
    } else {
      // 用**原文**取内核区间。注意不能用 extractKernel() 的结果——它会把内核整段换成
      // 一行占位符（那是给按节合并用的），拿它来比对等于拿 41 字节比 14315 字节。
      const raw = managedExisting
      const embedded = raw.slice(
        raw.indexOf(START) + START.length,
        raw.indexOf(END),
      ).replace(/^\n/, '').replace(/\n$/, '')
      const template = kernelBody()
      if (embedded !== template) {
        problems.push('内核区间与 templates/agents-kernel.md 不一致'
          + `（文件里 ${Buffer.byteLength(embedded, 'utf8')} 字节，模板 ${Buffer.byteLength(template, 'utf8')} 字节）`)
      }
    }
    const missingNow = missingSections(target, managedExisting ?? composed)
    // 缺节是否算失败，取决于这份文件是不是脚本生成的：
    //   - 生成的 → 节结构由模板决定，缺节就是缺陷；
    //   - 作者升级来的 → 缺节只提示（作者的编排是权威，不逼他改成模板的样子）。
    const isManaged = (managedExisting ?? composed).includes(MANAGED)
    if (missingNow.length > 0) {
      const detail = `缺失 ${missingNow.length} 个节：${missingNow.map((m) => m.heading).join('、')}`
      if (isManaged) problems.push(detail)
      else warnings.push(`${detail}（这份文件是作者编排的，缺节只作提示；`
        + '若确实该有这些内容，请补上）')
    }
    if (problems.length > 0) {
      process.stderr.write(`校验失败：${agentsPath}\n`)
      for (const p of problems) process.stderr.write(`  - ${p}\n`)
      process.stderr.write(`  修正：node scripts/compose-agents.mjs "${target}"\n`)
      return 1
    }
    for (const w of warnings) process.stdout.write(`提示：${w}\n`)
    process.stdout.write(`内核一致：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
    if (bytes > budget) {
      process.stderr.write(`警告：已超出预算 ${budget} 字节，注入时会被截断。\n`)
      return 1
    }
    return 0
  }

  if (status) {
    if (!existsSync(agentsPath)) {
      process.stderr.write(`状态：${agentsPath} 不存在（尚未生成）。\n`)
      return 1
    }
    const missing = missingSections(target, readUtf8(agentsPath))
    process.stdout.write(`${agentsPath}\n  ${bytes} 字节，占预算 ${ratio}%，`
      + `待填写 ${authors.length} 处，缺失 ${missing.length} 节\n`)
    reportGaps(authors, missing, process.stdout)
    if (bytes > budget) {
      process.stderr.write(`警告：已超出预算 ${budget} 字节，注入时会被截断。\n`)
      return 1
    }
    return 0
  }

  const missing = missingSections(target, composed)
  if (same) {
    process.stdout.write(`无需改动：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
    reportGaps(authors, missing, process.stdout)
    reportRefresh(refreshReport, process.stdout)
    return 0
  }

  // 写入：纳入错误处理，且**先写临时文件再改名**。
  //
  // 两件事都是必要的：
  //   - 写路径原先在 try 之外，权限不足、磁盘满、文件被独占都会抛出**裸的 Node 栈**，
  //     使用者看不到「哪个文件、为什么」；
  //   - 直接覆盖原文件时，写入中途失败会留下半截文件。改名在同一分区上是原子的，
  //     所以要么是旧内容、要么是新内容，不会出现第三种状态。
  try {
    mkdirSync(dirname(agentsPath), { recursive: true })
    const tmp = `${agentsPath}.tmp-${process.pid}`
    writeFileSync(tmp, composed, { encoding: 'utf8' })
    renameSync(tmp, agentsPath)
  } catch (error) {
    process.stderr.write(
      `错误：无法写入 ${agentsPath}——${error instanceof Error ? error.message : String(error)}\n`
      + '  文件未被改动（写入失败时原文件保持不变）。\n'
      + '  常见原因：文件被其他程序占用、目录只读、磁盘空间不足。\n',
    )
    return 2
  }
  process.stdout.write(
    `${exists ? '已刷新' : '已生成'}：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`,
  )
  reportGaps(authors, missing, process.stdout)
  reportRefresh(refreshReport, process.stdout)
  if (bytes > budget) {
    process.stderr.write(
      `警告：总字节数 ${bytes} 已超出预算 ${budget}。\n`
      + '  超出部分在注入会话上下文时会被截断。请把可下放到子目录的内容移到子目录\n'
      + '  AGENTS.md，或把细节移出本文件、改为指向项目内其他文档。\n',
    )
  }
  return 0
}

process.exitCode = main(process.argv)
