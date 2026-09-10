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

/** 待填写标记。匹配 `<!-- pf:author: 说明 -->` 与 `<!-- pf:author -->` 两种写法。 */
const AUTHOR_RE = /<!--\s*pf:author(?::[\s\S]*?)?-->/g

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
  const hasCommands = Object.keys(commands).some((k) => k !== 'packageManager')

  // 可发布 = 声明了发布范围，且没有被标记为不可发布
  const publishable = s.artifacts?.publishScope !== undefined && s.artifacts?.private !== true

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

  const tokens = {
    PROJECT_NAME: s.target.name,
    COMMANDS: renderCommands(commands),
  }

  return { survey: s, conditions, tokens }
}

/** 把推导出的命令渲染成可直接粘进文档的 shell 块。取不到的命令不出现。 */
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
  const lines = []
  for (const [key, label] of labels) {
    const command = commands[key]
    if (typeof command !== 'string') continue
    lines.push(`# ${label}`)
    lines.push(command)
  }
  return lines.join('\n')
}

// ── 模板求值 ────────────────────────────────────────────────────────────────

/**
 * 按条件求值模板，替换取值，并统计待填写项。
 *
 * 用栈处理条件块，因此支持嵌套。**未知条件直接报错**而不静默丢弃——静默丢弃会让一段
 * 内容凭空消失，而且没人会发现。
 */
function materialize(template, facts) {
  const TOKEN_RE = /\{\{([A-Z_][A-Z0-9_]*)\}\}/g
  const MARK_RE = /<!--\s*pf:(if\s+[^\s>]+|endif|scaffold|endscaffold|author(?::[\s\S]*?)?)\s*-->/g

  const out = []
  const stack = [] // { kind: 'if'|'scaffold', active: boolean }
  const unknownConditions = []
  const missingTokens = new Set()
  let cursor = 0

  const active = () => stack.every((f) => f.active)

  const emit = (text) => {
    if (!active()) return
    out.push(text.replace(TOKEN_RE, (whole, name) => {
      if (!(name in facts.tokens)) { missingTokens.add(name); return whole }
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
  if (missingTokens.size > 0) {
    throw new Error(`模板使用了未知取值：${[...missingTokens].join('、')}。`
      + '请在 deriveFacts() 的 tokens 里提供它。')
  }

  // 条件段落被丢弃后会留下成串空行（一个条件块前后各有一行）。不清理的话，产出里
  // 到处是三四行空白，看起来像排版事故，读的人会以为内容丢了。折叠成至多一个空行。
  return out.join('').replace(/\n{3,}/g, '\n\n')
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
  try {
    if (exists) {
      // 已存在：只刷新内核，项目段落一个字节都不动。这是「永不覆盖」的落地。
      const existing = readUtf8(agentsPath)
      const authors = findAuthors(existing)
      composed = stripScaffold(injectKernel(existing, kernel), authors.length)
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
    return 0
  }

  mkdirSync(dirname(agentsPath), { recursive: true })
  writeFileSync(agentsPath, composed, { encoding: 'utf8' })
  process.stdout.write(
    `${exists ? '已刷新' : '已生成'}：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`,
  )
  reportAuthors(authors, process.stdout)
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
