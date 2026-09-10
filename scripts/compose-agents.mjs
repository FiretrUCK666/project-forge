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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const KERNEL_PATH = join(SKILL_ROOT, 'templates', 'agents-kernel.md')
const SKELETON_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

const START = '<!-- project-forge:kernel:start -->'
const END = '<!-- project-forge:kernel:end -->'
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
  // 「有没有可跑的命令」只看真实命令字段：byEcosystem / multipleEcosystems 是结构信息，
  // 不是命令本身，把它们算进来会让一个空项目也显示「有命令」。
  const hasCommands = Object.keys(commands)
    .some((k) => k !== 'packageManager' && k !== 'byEcosystem' && k !== 'multipleEcosystems')

  // 可发布 = **有可分发的清单**且没被声明为私有。
  //
  // 这里曾经要求「声明了发布范围（files 白名单）」才算可发布，那是错的：绝大多数普通
  // 包并不写 files 字段（靠默认规则决定发什么），于是它们被判成「不可发布」，文档里
  // 连版本与发布这一节都没有。判据应当是「这个项目有没有可分发的形态」，而清单文件的
  // 存在正是这件事的声明；`private: true` 才是明确的「不要发布」。
  const hasManifest = manifestPath !== undefined
  const publishable = hasManifest && s.artifacts?.private !== true

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
  const hasRemote = typeof s.git?.remote === 'string' && s.git.remote.length > 0

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
    'has-deps': hasDeps,
    'no-deps': !hasDeps,
    publishable,
    'no-publish': !publishable,
  }

  // 项目名优先取**项目自己声明的**名字（清单里的 name），没有才退回目录名。
  // 目录名常常是临时起的（demo、new-project），而清单里的名字才是项目身份。
  let projectName = s.target.name
  if (manifestPath !== undefined) {
    try {
      const pkg = JSON.parse(readUtf8(join(target, manifestPath)))
      if (typeof pkg.name === 'string' && pkg.name.trim().length > 0) {
        projectName = pkg.name.replace(/^@[^/]+\//, '') // 去掉作用域前缀，标题里更好读
      }
    } catch { /* 解析失败就用目录名 */ }
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
  return `${before}\n${kernel}\n${after}`
}

// ── 命令行 ──────────────────────────────────────────────────────────────────

const DEFAULT_BUDGET_NOTE = `预算默认 ${DEFAULT_BUDGET} 字节`

function parseArgs(argv) {
  const positional = []
  let check = false
  let status = false
  let budget = DEFAULT_BUDGET
  let help = false
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') { check = true; continue }
    if (arg === '--status') { status = true; continue }
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
  return { check, status, budget, help, positional }
}

function reportAuthors(authors, stream) {
  if (authors.length === 0) return
  stream.write(`\n待填写 ${authors.length} 处（脚本无法从项目事实推出，需要读代码后补上）：\n`)
  const seen = new Set()
  for (const { section, note } of authors) {
    const line = note === '' ? section : `${section} —— ${note}`
    if (seen.has(line)) continue
    seen.add(line)
    stream.write(`  - ${line}\n`)
  }
  stream.write('填完后请删掉对应的 pf:author 标记，并重新运行本脚本确认归零。\n')
}

/**
 * 报告刷新时做了什么。三件事都值得说，因为它们都改变了文件内容，而使用者需要知道
 * 「为什么这次跑完文件变了」——尤其是「模板里有而文件里没有」的节，脚本刻意不补，
 * 让人自己决定。
 */
function reportRefresh(report, stream) {
  if (report === undefined) return
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
  const { check, status, budget, help, positional } = parsed
  if (help) {
    process.stdout.write([
      '用法：node scripts/compose-agents.mjs [目录] [--check|--status] [--budget N]',
      '',
      '  生成或刷新目标项目的 AGENTS.md。',
      '  - 通用内核由 templates/agents-kernel.md 逐字注入，标记之外不动；',
      '  - 首次生成时按项目事实保留/丢弃条件段落、填充取值；',
      '  - 脚本填不了的部分留下 pf:author 标记并报出数量。',
      '',
      '  --check    只校验内核一致性，不写入；不一致时退出码 1',
      '  --status   只报告待填写项与字节数，不写入',
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
  if (check && !exists) {
    process.stderr.write(`校验失败：${agentsPath} 不存在。\n`)
    return 1
  }

  let composed
  let refreshReport
  try {
    if (exists) {
      // 已存在：重新求值条件段落，并按节合并保住在这些段落里写下的真实内容。
      //
      // 这里曾经是「只刷新内核，项目段落一个字节都不动」。那个做法有个致命后果：条件
      // 段落只在首次生成时求值一次，此后**永久冻结**。而本 skill 的顺序是 P3（版本管理）
      // → P4（文档）→ P5（远端）——生成文档时远端**必然**还不存在。于是「有远端才有」
      // 的那几段（发版规则、角色判定、标签与版本号一致）对所有新项目**永远缺席**，
      // 而且再跑脚本只会说「无需改动」。
      //
      // 正确做法是把条件段落当作**派生内容**而非用户内容：每次按当前事实重新求值，
      // 合并时以「这一节是否已被人工填写」为准——已填的保留，未填的用新求值的结果。
      const existing = readUtf8(agentsPath)
      const refreshed = refreshFromTemplate(target, existing, kernel)
      composed = refreshed.text
      refreshReport = refreshed.report
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
      if (!composed.endsWith('\n')) composed += '\n'
    }
  } catch (error) {
    process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const authors = findAuthors(composed)
  const bytes = Buffer.byteLength(composed, 'utf8')
  const ratio = ((bytes / budget) * 100).toFixed(1)
  const current = exists ? readUtf8(agentsPath) : undefined
  const same = current !== undefined && composed === current

  if (check) {
    if (!same) {
      process.stderr.write(
        '校验失败：AGENTS.md 里的内核与 templates/agents-kernel.md 不一致。\n'
        + `  文件：${agentsPath}\n`
        + `  修正：node scripts/compose-agents.mjs "${target}"\n`,
      )
      return 1
    }
    process.stdout.write(`内核一致：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
    if (bytes > budget) {
      process.stderr.write(`警告：已超出预算 ${budget} 字节，注入时会被截断。\n`)
      return 1
    }
    return 0
  }

  if (status) {
    process.stdout.write(`${agentsPath}\n  ${bytes} 字节，占预算 ${ratio}%，`
      + `待填写 ${authors.length} 处\n`)
    reportAuthors(authors, process.stdout)
    if (bytes > budget) {
      process.stderr.write(`警告：已超出预算 ${budget} 字节，注入时会被截断。\n`)
      return 1
    }
    return 0
  }

  if (same) {
    process.stdout.write(`无需改动：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
    reportAuthors(authors, process.stdout)
    reportRefresh(refreshReport, process.stdout)
    return 0
  }

  mkdirSync(dirname(agentsPath), { recursive: true })
  writeFileSync(agentsPath, composed, { encoding: 'utf8' })
  process.stdout.write(
    `${exists ? '已刷新' : '已生成'}：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`,
  )
  reportAuthors(authors, process.stdout)
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
