#!/usr/bin/env node
/**
 * compose-agents.mjs —— 生成或刷新目标项目的 AGENTS.md。
 *
 * ## 它只碰一个文件
 *
 * `AGENTS.md`。**不建隐藏目录、不拷脚本、不记账本。** 分不清来历不该靠一份藏起来的
 * 账本，该靠**写在文件里的标记**——人和 AI 都看得见，可 grep、可争论、可手工删掉。
 *
 * ## 五种情况，五种动作
 *
 * | 文件现在是什么样 | 做什么 |
 * | --- | --- |
 * | 不存在 | 按模板渲染一份，用勘察到的事实填掉能填的部分 |
 * | 已有标记区间，区间里**还有** `fill` | 用模板新渲染的内容替换那一段（骨架没填完，事实变了要跟上） |
 * | 已有标记区间，区间里**没有** `fill` | **一个字节不动**。人填过，那就是权威 |
 * | 条件由假变真，模板多出一节 | 按模板顺序**插入**到正确位置（第一次生成时没远端、后来建了远端就属于这种） |
 * | 已存在但没有任何标记 | **不动**，只输出体检。`--upgrade` 才追加缺失的节 |
 *
 * 第五条是这里最重要的一条。一个人手写的契约可能比模板更贴合他的项目，
 * 而「自动生成」这个身份不足以让我们覆盖他的成果。
 *
 * ## 刷新为什么不是「覆盖」
 *
 * 「让受管区间永远等于模板」听起来更省心，代价是把人填进去的东西冲掉。判据很简单：
 * 一个区间里没有 `fill` 了，说明**有人读过并写过它**——那份内容比模板更值钱。
 *
 * 所以这里只做加法和填空，从不做减法。**「模板更新了而我这份没跟上」由交付体检报**
 * （它比对受管区间的骨架与当前事实），而不是由这里悄悄覆盖。
 *
 * ## 占位符
 *
 * 模板里填不出来的地方留着 `<!-- project-forge: fill <要填什么> -->`。它**必须被删掉**：
 * 一份带空占位的契约比没有契约更糟，它看起来像有。`review.mjs` 会把未填的占位报成缺口。
 *
 * 条件块（`if`/`endif`）与变量（`{{VAR}}`）**绝不写进产物**——它们在渲染那一刻就求值完了。
 * 产物里出现它们，说明求值漏了一层，`preflight` 会判红。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey, readTextSafe, samePath } from './survey.mjs'
import { markerRegions, parseMarkers, stripMarkers } from './lib/protocol.mjs'
import { renderTemplate, TemplateError } from './lib/template.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const TEMPLATE_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

const COMMAND_ORDER = ['install', 'build', 'typecheck', 'lint', 'test', 'verify']
const COMMAND_LABEL = {
  install: '安装依赖', build: '构建', typecheck: '类型检查', lint: '静态检查',
  test: '测试', verify: '综合验证',
}

// ── 从勘察事实到渲染输入 ────────────────────────────────────────────

/**
 * 七个条件，全部来自勘察事实。
 *
 * 每个条件都必须**可由事实算出**，而且是保守方向：算不准时算「没有」。多一节不适用
 * 的内容会让读者照着执行一件对他不存在的事；少一节只是缺，交付体检会报。
 */
export function buildConditions(facts) {
  const commands = facts.commands ?? {}
  const hasCommands = COMMAND_ORDER.some((k) => typeof commands[k] === 'string' && commands[k].trim())
  const kinds = facts.ecosystem?.kinds ?? []
  const tags = facts.git?.tags ?? []
  const conventions = facts.conventions ?? {}

  return {
    'has-commands': hasCommands,
    'no-commands': !hasCommands,
    'has-remote': Boolean(facts.git?.remote) && facts.git?.isRepoRoot !== false,
    'has-release': Boolean(
      facts.ecosystem?.publishable
      || facts.ecosystem?.registryFree
      || facts.docs?.releasing
      || facts.docs?.workflowFacts?.hasRelease
      || tags.length > 0
      || conventions.releaseNotesMode !== undefined,
    ),
    'is-monorepo': Boolean(facts.workspace?.declared),
    'is-plugin-or-skill': kinds.some((k) => k === 'skill' || k.endsWith('-plugin') || k.endsWith('-extension')),
    'has-bilingual-docs': Boolean(facts.docs?.readmePair),
  }
}

/**
 * 命令块。多生态并存时**按生态分段全部写入**。
 *
 * 这是最容易做错的一处：一个仓库同时有前端 `package.json` 和后端 `pyproject.toml` 时，
 * 只取一份命令的结果是「CI 只测前端」，而它看起来完全正常——测试绿着，后端一次都没跑过。
 */
function commandsBlock(facts) {
  const byEco = facts.commandsByEcosystem ?? {}
  const kinds = Object.keys(byEco).filter((k) => COMMAND_ORDER.some((key) => byEco[k]?.[key]))

  if (kinds.length > 1) {
    const blocks = []
    for (const kind of kinds) {
      const lines = [`# --- ${kind} ---`]
      for (const key of COMMAND_ORDER) {
        const value = byEco[kind]?.[key]
        if (typeof value === 'string' && value.trim()) lines.push(`${value}  # ${COMMAND_LABEL[key]}`)
      }
      blocks.push(lines.join('\n'))
    }
    return blocks.join('\n\n')
  }

  const source = kinds.length === 1 ? byEco[kinds[0]] : facts.commands ?? {}
  const lines = []
  for (const key of COMMAND_ORDER) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) lines.push(`${value}  # ${COMMAND_LABEL[key]}`)
  }
  return lines.join('\n')
}

/** 提交风格提示。只描述现状，不劝人改。 */
function commitStyleHint(facts) {
  const style = facts.conventions?.commitStyle
  const observed = {
    conventional: '本项目历史提交用的是「类型: 说明」的约定式格式',
    gitmoji: '本项目历史提交以 emoji 标记开头',
    plain: '本项目历史提交是平铺的一句说明',
  }[style]
  if (!observed) return '提交风格：沿用项目既有历史的写法，不混用多套格式，不用内部编号充当说明'
  return `${observed}——沿用它，不要混用第二套格式，不用内部编号充当说明`
}

/** 十一个变量的取值。 */
export function buildVars(facts) {
  const conventions = facts.conventions ?? {}
  const releaseNotesTarget = conventions.releaseNotesMode === 'changelog'
    ? 'CHANGELOG.md 的对应版本节'
    : 'docs/release-notes/<标签>.md'
  const readmes = facts.docs?.readmes ?? []
  const packages = facts.workspace?.packages ?? []

  return {
    PROJECT_NAME: facts.target?.name ?? '这个项目',
    COMMANDS: commandsBlock(facts),
    RUNTIME_REQUIREMENTS: (facts.artifacts?.runtimeRequirements ?? []).join('、') || '见清单文件声明',
    DEFAULT_BRANCH: conventions.defaultBranch || 'main',
    VERSION_SOURCE: facts.ecosystem?.manifests?.[0] ?? '清单文件',
    RELEASING_DOC: facts.docs?.releasing ?? 'RELEASING.md',
    RELEASE_NOTES_TARGET: releaseNotesTarget,
    WORK_DIR: `${conventions.workDir || 'docs/work'}/`,
    COMMIT_STYLE_HINT: commitStyleHint(facts),
    README_LIST: readmes.length > 0 ? readmes.map((r) => `\`${r}\``).join('、') : '`README.md`',
    WORKSPACE_PACKAGES: packages.length > 0 ? packages.map((p) => `\`${p}\``).join('、') : '各子包',
  }
}

/** 渲染模板：条件求值 → 变量替换。任何一处不成立都抛，绝不把洞留在产物里。 */
export function renderAgentsTemplate(facts, templateText) {
  return renderTemplate(templateText, buildConditions(facts), buildVars(facts), 'template.md')
}

// ── 区间刷新 ────────────────────────────────────────────────────────

function hasFill(bodyLines) {
  return bodyLines.some((line) => /project-forge:\s*fill\b/.test(line))
}

/**
 * 刷新受管区间：填空、插入新节，**从不删、从不覆盖人填过的内容**。
 *
 * 四种动作的先后不能反：先算清「模板里该有哪些」，再逐个决定「换、留、插」，
 * 最后一次性落到行数组上（从后往前，前面的下标才不会因为长度变化而失效）。
 */
export function refreshRegions(existing, rendered) {
  const current = markerRegions(existing, 'AGENTS.md')
  const fresh = markerRegions(rendered, 'AGENTS.md')
  if (current.broken.length > 0) {
    return { text: existing, changed: false, broken: current.broken, kept: [], inserted: [], filled: [] }
  }

  const lines = existing.split('\n')
  const renderedLines = rendered.split('\n')
  const freshById = new Map(fresh.regions.map((r) => [r.id, r]))
  const currentById = new Map(current.regions.map((r) => [r.id, r]))
  const renderedOrder = fresh.regions.map((r) => r.id)

  const ops = []
  const kept = []
  const filled = []

  for (const region of current.regions) {
    const source = freshById.get(region.id)
    if (!source) { kept.push(region.id); continue }
    const body = lines.slice(region.start + 1, region.end)
    if (!hasFill(body)) { kept.push(region.id); continue }
    filled.push(region.id)
    ops.push({
      at: region.start + 1,
      remove: region.end - region.start - 1,
      insert: renderedLines.slice(source.start + 1, source.end),
    })
  }

  // 只在模板里出现、当前文件里还没有的区间：按模板顺序插入。
  const inserted = []
  for (let i = 0; i < renderedOrder.length; i += 1) {
    const id = renderedOrder[i]
    if (currentById.has(id)) continue
    if (!freshById.has(id)) continue
    const source = freshById.get(id)
    const block = [
      renderedLines[source.start],
      ...renderedLines.slice(source.start + 1, source.end),
      renderedLines[source.end],
    ]

    // 找插入点：优先「模板里排在它后面、而文件里已经有」的第一个区间之前；
    // 找不到就退到「排在它前面、文件里已经有」的最后一个区间之后；都没有就追加到末尾。
    let position
    for (let j = i + 1; j < renderedOrder.length; j += 1) {
      const anchor = currentById.get(renderedOrder[j])
      if (anchor) { position = anchor.start; break }
    }
    if (position === undefined) {
      for (let j = i - 1; j >= 0; j -= 1) {
        const anchor = currentById.get(renderedOrder[j])
        if (anchor) { position = anchor.end + 1; break }
      }
    }
    if (position === undefined) position = lines.length

    ops.push({ at: position, remove: 0, insert: ['', ...block] })
    inserted.push(id)
  }

  if (ops.length === 0) {
    return {
      text: existing, changed: false, broken: [], kept, inserted: [], filled,
    }
  }

  ops.sort((a, b) => b.at - a.at)
  for (const op of ops) lines.splice(op.at, op.remove, ...op.insert)
  return {
    text: lines.join('\n'), changed: true, broken: [], kept, inserted, filled,
  }
}

/**
 * 从模板里挑出文件还没有的节（含它自己的标记），整段追加。
 *
 * 判断「有没有」不靠 id、也不靠标题逐字相等——**靠同义标题**。人手写契约时会把
 * 「构建与验证」写成「构建与测试」或「Commands」；用 `includes` 精确匹配会导致整节
 * 被重复追加一遍，而重复的那一节通常没人读，于是两份内容从此各自漂移。
 */
const SECTION_SYNONYMS = {
  项目定位: /^##\s+(?:项目)?(?:定位|简介|概述|Overview)/imu,
  架构与关键不变量: /^##\s+(?:项目)?(?:架构|结构|目录结构|关键不变量|Architecture)/imu,
  构建与验证: /^##\s+(?:环境与)?(?:构建|验证|命令|安装与运行|Build|Test|Commands)/imu,
  修改守则: /^##\s+(?:工程)?(?:修改守则|硬性规范|规范|约定|Rules|Guidelines|Conventions)/imu,
  版本与发布: /^##\s+(?:版本|发布|发版|Version|Release)/imu,
  日常协作与风险分流: /^##\s+(?:日常)?(?:协作|改动怎么落地|工作流|Workflow|Collaboration)/imu,
  高风险路径: /^##\s+高风险/imu,
  取舍: /^##\s+取舍/imu,
}

export function collectMissingSections(rendered, existing) {
  const renderedLines = rendered.split('\n')
  const { regions } = markerRegions(rendered, 'AGENTS.md')
  const out = []
  for (const region of regions) {
    const block = [
      renderedLines[region.start],
      ...renderedLines.slice(region.start + 1, region.end),
      renderedLines[region.end],
    ]
    const heading = block.find((line) => /^##\s+/.test(line))
    if (!heading) continue
    const pattern = SECTION_SYNONYMS[region.id] ?? new RegExp(`^##\\s+${escapeRe(heading.replace(/^##\s+/, '').trim())}`, 'imu')
    if (pattern.test(existing)) continue
    out.push(block.join('\n'))
  }
  return out
}

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ── 文件操作 ────────────────────────────────────────────────────────

/** 原子写：先写同目录临时文件再改名，中途被杀不会留下半截文件。 */
function writeAtomic(path, content) {
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, content, 'utf8')
  try {
    renameSync(tmp, path)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 清不掉就留着，下次运行会看到 */ }
    throw error
  }
}

/** 只读体检：告诉人这份文件现在什么状态。 */
function inspect(agentsPath, rendered) {
  const text = readTextSafe(agentsPath)
  if (text === undefined) {
    return { state: 'unreadable', fills: [], regions: [], broken: [], missingRegions: [] }
  }
  const markers = parseMarkers(text, 'AGENTS.md')
  const fills = markers.filter((m) => m.kind === 'fill')
  const regions = markerRegions(text, 'AGENTS.md')
  const present = new Set(regions.regions.map((r) => r.id))
  const wanted = markerRegions(rendered, 'AGENTS.md').regions.map((r) => r.id)
  const missingRegions = wanted.filter((id) => !present.has(id))
  return {
    state: fills.length > 0 ? 'has-fills' : 'ok',
    fills,
    regions: regions.regions,
    broken: regions.broken,
    missingRegions,
    text,
  }
}

function report(agentsPath, info, { verbose = false } = {}) {
  const name = 'AGENTS.md'
  if (info.state === 'unreadable') {
    process.stdout.write(`${name} 读不出来（不是 UTF-8 文本？）。这不是「没有」，是「有但读不懂」——先看清它是什么。\n`)
    return
  }
  if (info.broken && info.broken.length > 0) {
    process.stdout.write(`${name} 的标记没成对：${info.broken.join('、')}。半对标记意味着文件被手工改坏了，`
      + '不动它，先看清缺的是哪个 end。\n')
    return
  }
  if (info.regions.length === 0) {
    process.stdout.write(`${name} 里没有任何 <!-- project-forge: begin … --> 标记。\n`
      + '这通常意味着它**是手写的**。按规矩不动它——\n'
      + '手写的契约可能比模板更贴合这个项目。\n')
    const additions = collectMissingSections(renderedCache, info.text ?? '')
    if (additions.length > 0) {
      process.stdout.write(`\n模板里的这几节它还没有：共 ${additions.length} 段\n`
        + '要补的话加 `--upgrade`：只**追加**缺的节，每节带自己的标记，已有的字一个不动。\n')
    }
    return
  }
  process.stdout.write(`${name}：${info.regions.length} 段受管内容（${info.regions.map((r) => r.id).join('、')}）\n`)
  if (info.missingRegions.length > 0) {
    process.stdout.write(`还有 ${info.missingRegions.length} 节该有却没有：${info.missingRegions.join('、')}\n`
      + '（模板里的条件现在为真，所以这一节该在。跑一次不带参数就会补上，已有内容不动。）\n')
  }
  if (info.fills.length > 0) {
    process.stdout.write(`还有 ${info.fills.length} 处要人填：\n`)
    for (const fill of info.fills) {
      process.stdout.write(`  - 第 ${fill.line} 行：${fill.what}\n`)
    }
    if (verbose) {
      process.stdout.write('\n填完之后把那一整行标记删掉——留着它，看起来就像「这里已经填过了」。\n')
    }
  } else {
    process.stdout.write('没有未填的占位。\n')
  }
}

let renderedCache = ''

// ── 主流程 ──────────────────────────────────────────────────────────

async function main(argv) {
  let target = process.cwd()
  let mode = 'default'
  let verbose = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/compose-agents.mjs [目标目录] [选项]',
        '',
        '  （默认）      文件不存在就建一份；已存在就刷新还带占位的区间、补上新增的节',
        '  --status      只报现状，不写任何文件',
        '  --upgrade     向手写文件追加缺失的节，每节带自己的标记，已有内容不动',
        '  --check       门禁：标记成对、没有未填占位、该有的节都在时退出 0',
        '  --clean       剥掉本 skill 留下的全部标记，正文保留',
        '  --verbose     多说一点',
        '',
        '只碰 AGENTS.md 一个文件。',
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--status') mode = 'status'
    else if (arg === '--upgrade') mode = 'upgrade'
    else if (arg === '--check') mode = 'check'
    else if (arg === '--clean') mode = 'clean'
    else if (arg === '--verbose') verbose = true
    else if (!arg.startsWith('-')) target = arg
    else {
      process.stderr.write(`未知选项：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  const root = resolve(target)
  if (!existsSync(root)) {
    process.stderr.write(`目标目录不存在：${root}\n`)
    return 2
  }
  const agentsPath = join(root, 'AGENTS.md')
  const template = readFileSync(TEMPLATE_PATH, 'utf8').replace(/\r\n/g, '\n')

  if (!existsSync(agentsPath)) {
    if (mode === 'status' || mode === 'check') {
      process.stdout.write('AGENTS.md 还没有。\n')
      return mode === 'check' ? 1 : 0
    }
    if (mode === 'clean' || mode === 'upgrade') {
      process.stdout.write('没有 AGENTS.md，无从清理或追加。要生成就跑一次不带参数。\n')
      return 0
    }
    return await generate(root, agentsPath, template)
  }

  const existing = (readTextSafe(agentsPath) ?? '').replace(/\r\n/g, '\n')

  if (mode === 'clean') {
    const cleaned = stripMarkers(existing, 'AGENTS.md')
    if (cleaned === existing) {
      process.stdout.write('没有标记可剥，文件未改动。\n')
      return 0
    }
    writeAtomic(agentsPath, cleaned)
    process.stdout.write('已剥掉全部标记，正文保留。\n')
    return 0
  }

  // 渲染要勘察事实。`--clean` 之外的模式都需要它：连「该有哪些节」都由事实决定。
  let rendered
  try {
    const facts = await factsOf(root)
    rendered = renderAgentsTemplate(facts, template)
  } catch (error) {
    process.stderr.write(`模板渲染失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  renderedCache = rendered

  const info = inspect(agentsPath, rendered)

  if (mode === 'check') {
    if (info.state === 'unreadable') {
      process.stderr.write('AGENTS.md 读不出来（不是 UTF-8 文本？）\n')
      return 1
    }
    if (info.broken && info.broken.length > 0) {
      process.stderr.write(`AGENTS.md 的标记没成对：${info.broken.join('、')}\n`)
      return 1
    }
    if (info.regions.length === 0) {
      // 手写文件在 --check 下直接放行：判它「不合规」等于逼人去改手写的东西。
      process.stdout.write('AGENTS.md 是手写的（没有受管标记）——不判，放行。\n')
      return 0
    }
    let bad = false
    if (info.fills.length > 0) {
      process.stderr.write(`AGENTS.md 还有 ${info.fills.length} 处未填的占位\n`)
      for (const fill of info.fills) process.stderr.write(`  第 ${fill.line} 行：${fill.what}\n`)
      bad = true
    }
    if (info.missingRegions.length > 0) {
      process.stderr.write(`AGENTS.md 缺 ${info.missingRegions.length} 节（条件为真却没有）：${info.missingRegions.join('、')}\n`)
      bad = true
    }
    if (bad) return 1
    process.stdout.write('AGENTS.md：标记成对、没有未填占位、该有的节都在。\n')
    return 0
  }

  if (mode === 'upgrade') {
    if (info.regions.length > 0) {
      process.stdout.write('这份文件已经有受管标记，用默认模式刷新即可（--upgrade 只用于手写文件）。\n')
      return 0
    }
    const additions = collectMissingSections(rendered, existing)
    if (additions.length === 0) {
      process.stdout.write('模板里的节都已在文件中，无需追加。\n')
      return 0
    }
    writeAtomic(agentsPath, `${existing.trimEnd()}\n\n${additions.join('\n\n')}\n`)
    process.stdout.write(`已追加 ${additions.length} 节：只加不改，原有内容一个字节没动。\n`)
    process.stdout.write('接下来读代码填掉里面的「fill」标记，填完把标记行删掉。\n')
    return 0
  }

  // 默认：有受管标记就刷新（填空 + 插新节），没有就只报。
  if (mode === 'default' && info.regions.length > 0 && info.broken.length === 0) {
    const refreshed = refreshRegions(existing, rendered)
    if (refreshed.changed) {
      writeAtomic(agentsPath, refreshed.text)
      const bits = []
      if (refreshed.filled.length > 0) bits.push(`填了 ${refreshed.filled.length} 段（${refreshed.filled.join('、')}）`)
      if (refreshed.inserted.length > 0) bits.push(`插入 ${refreshed.inserted.length} 节（${refreshed.inserted.join('、')}）`)
      process.stdout.write(`已刷新受管区间：${bits.join('，')}。标记之外、以及填过的区间一个字节没动。\n`)
    } else {
      process.stdout.write('受管区间都已填过、也没有新增的节，文件未改动。\n')
    }
    report(agentsPath, inspect(agentsPath, rendered), { verbose })
    return 0
  }

  // 默认 / --status：只报，不写。
  report(agentsPath, info, { verbose })
  return 0
}

/**
 * 取勘察事实。
 *
 * `survey()` 是异步的（它并发跑几次 git 查询），所以主流程也必须是异步的。把它硬桥成
 * 同步是一个陷阱：`await` 落下的微任务不会在同步代码里得到执行，桥接会立刻抛
 * 「没返回」——而那个错看起来像是勘察坏了，实际是桥接本身不可能成立。
 */
async function factsOf(root) {
  return survey(root)
}

async function generate(root, agentsPath, template) {
  let content
  try {
    const facts = await factsOf(root)
    content = renderAgentsTemplate(facts, template)
  } catch (error) {
    process.stderr.write(`模板渲染失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  mkdirSync(dirname(agentsPath), { recursive: true })
  writeAtomic(agentsPath, content)
  const fills = parseMarkers(content, 'AGENTS.md').filter((m) => m.kind === 'fill')
  process.stdout.write('已生成 AGENTS.md（按勘察到的事实填了一部分）。\n')
  if (fills.length > 0) {
    process.stdout.write(`还有 ${fills.length} 处要你读完代码后填：\n`)
    for (const fill of fills) process.stdout.write(`  - 第 ${fill.line} 行：${fill.what}\n`)
    process.stdout.write('\n填完把那一整行标记删掉，然后跑 `node scripts/review.mjs .` 确认归零。\n')
  }
  return 0
}

export { TemplateError }

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code))
}
