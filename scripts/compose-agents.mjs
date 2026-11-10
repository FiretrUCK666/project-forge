#!/usr/bin/env node
/**
 * compose-agents.mjs —— 生成或刷新目标项目的 AGENTS.md。
 *
 * ## 它只碰一个文件
 *
 * `AGENTS.md`。**不建隐藏目录、不拷脚本、不记账本。** 早先版本会往目标项目里塞一份
 * 一千行的审查脚本和一个 `.project-forge/` 账本，理由是「不这么做，将来就分不清哪段
 * 是我写的」。那个理由是对的，但解法错了：分不清来历不该靠一份藏起来的账本，
 * 该靠**写在文件里的标记**——人和 AI 都看得见，可 grep、可争论、可手工删掉。
 *
 * ## 三种情况，三种动作
 *
 * | 文件现在是什么样 | 做什么 |
 * | --- | --- |
 * | 不存在 | 按模板建一份，用勘察到的事实填掉能填的部分 |
 * | 已有标记区间 | **只刷新标记之间**，标记之外一个字节都不动 |
 * | 已存在但没有任何标记 | **不动**，只输出体检报告。`--upgrade` 才追加缺失的节 |
 *
 * 第三条是这里最重要的一条。一个人手写的契约可能比模板更贴合他的项目，
 * 而「自动生成」这个身份不足以让我们覆盖他的成果。
 *
 * ## 占位符
 *
 * 模板里填不出来的地方留着 `<!-- project-forge: fill <要填什么> -->`。它**必须被删掉**：
 * 一份带空占位的契约比没有契约更糟，它看起来像有。`review.mjs` 会把未填的占位报成缺口。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey, readTextSafe, samePath } from './survey.mjs'
import { markerRegions, parseMarkers, stripMarkers } from './lib/protocol.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const TEMPLATE_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

/** 从勘察事实里能填的部分。填不出来的留着 `fill` 标记，交给读代码的人。 */
function fillTemplate(template, facts) {
  const commands = facts.commands
  const commandLines = []
  const label = {
    install: '安装依赖', build: '构建', typecheck: '类型检查', lint: '静态检查',
    test: '测试', verify: '综合验证',
  }
  for (const key of ['install', 'build', 'typecheck', 'lint', 'test', 'verify']) {
    if (typeof commands[key] === 'string' && commands[key].trim()) {
      commandLines.push(`${commands[key]}  # ${label[key]}`)
    }
  }

  // 有命令就把命令块换进「构建与验证」区间；没命令留着模板里那句提示。
  let out = template.replaceAll('{{PROJECT_NAME}}', facts.target.name)
  if (commandLines.length > 0) {
    out = out.replace(
      /(```sh\n)(?:<!-- project-forge: fill 构建与验证命令 -->\n)?[^\n]*\n(```)/,
      `$1${commandLines.join('\n')}\n$2`,
    )
  }
  out = out.replace(
    /^# 这个项目还没有可跑的命令[^\n]*$/m,
    commandLines.length > 0 ? '' : '# 这个项目还没有可跑的命令；纯文档项目直接写「没有构建步骤」',
  )
  return out.replace(/\n{3,}/g, '\n\n')
}

/**
 * 一次刷新：把每个标记区间内的内容换成模板里对应的那一段。
 *
 * **已经填过的区间不动。** 「受管区间」管的是模板结构，不是内容：一份填好的契约
 * 再跑一次不该被清空。判据很简单——区间里没有 `fill` 标记就是填完了。
 */
function refreshRegions(existing, template) {
  const file = 'AGENTS.md'
  const current = markerRegions(existing, file)
  const fresh = markerRegions(template, file)
  if (current.broken.length > 0) {
    return { text: existing, regionCount: current.regions.length, changed: false, broken: current.broken }
  }
  const freshById = new Map(fresh.regions.map((r) => [r.id, r]))
  const templateLines = template.split('\n')
  const lines = existing.split('\n')
  const replacements = []
  const kept = []

  for (const region of current.regions) {
    const source = freshById.get(region.id)
    if (!source) { kept.push(region.id); continue }
    const body = lines.slice(region.start + 1, region.end)
    if (!body.some((line) => /project-forge:\s*fill\b/.test(line))) {
      kept.push(region.id)
      continue
    }
    replacements.push({ start: region.start + 1, end: region.end, body: templateLines.slice(source.start + 1, source.end) })
  }

  if (replacements.length === 0) {
    return { text: existing, regionCount: current.regions.length, changed: false, broken: [], kept }
  }

  // 从后往前替换，这样前面的下标不会因为长度变化而失效。
  replacements.sort((a, b) => b.start - a.start)
  for (const r of replacements) {
    lines.splice(r.start, r.end - r.start, ...r.body)
  }
  return { text: lines.join('\n'), regionCount: current.regions.length, changed: true, broken: [], kept }
}

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
function inspect(agentsPath, template) {
  const text = readTextSafe(agentsPath)
  if (text === undefined) {
    return { state: 'unreadable', fills: [], regions: [], missingSections: [] }
  }
  const markers = parseMarkers(text, 'AGENTS.md')
  const fills = markers.filter((m) => m.kind === 'fill')
  const regions = markerRegions(text, 'AGENTS.md')
  const templateSections = (template.match(/^##\s+.+$/gm) ?? []).map((s) => s.trim())
  const missingSections = templateSections.filter((heading) => !text.includes(heading))
  return { state: fills.length > 0 ? 'has-fills' : 'ok', fills, regions: regions.regions, broken: regions.broken, missingSections }
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
    process.stdout.write(`${name} 里没有任何 ${'<!-- project-forge: begin … -->'} 标记。\n`
      + '这通常意味着它**是手写的，或者来自更早的版本**。按规矩不动它——\n'
      + '手写的契约可能比模板更贴合这个项目。\n')
    if (info.missingSections.length > 0) {
      process.stdout.write(`\n它缺这几节：${info.missingSections.join('、')}\n`
        + '要补的话加 `--upgrade`：只**追加**缺的节，每节带自己的标记，已有的字一个不动。\n')
    }
    return
  }
  process.stdout.write(`${name}：${info.regions.length} 段受管内容（${info.regions.map((r) => r.id).join('、')}）\n`)
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

function main(argv) {
  let target = process.cwd()
  let mode = 'default'
  let verbose = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/compose-agents.mjs [目标目录] [选项]',
        '',
        '  （默认）      文件不存在就建一份；已存在就报现状，手写的文件不动',
        '  --status      只报现状（与默认对已存在文件的行为相同）',
        '  --upgrade     向已有文件追加缺失的节，每节带自己的标记，已有内容不动',
        '  --check       门禁：没有未填占位、标记成对时退出 0',
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
    return generate(root, agentsPath, template)
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

  const info = inspect(agentsPath, template)

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
    if (info.fills.length > 0) {
      process.stderr.write(`AGENTS.md 还有 ${info.fills.length} 处未填的占位\n`)
      for (const fill of info.fills) process.stderr.write(`  第 ${fill.line} 行：${fill.what}\n`)
      return 1
    }
    process.stdout.write('AGENTS.md：标记成对、没有未填占位。\n')
    return 0
  }

  if (mode === 'upgrade') {
    if (info.regions.length > 0) {
      process.stdout.write('这份文件已经有受管标记，用默认模式刷新即可（--upgrade 只用于手写文件）。\n')
      return 0
    }
    const additions = collectMissingSections(template, existing)
    if (additions.length === 0) {
      process.stdout.write('模板里的节都已在文件中，无需追加。\n')
      return 0
    }
    writeAtomic(agentsPath, `${existing.trimEnd()}\n\n${additions.join('\n\n')}\n`)
    process.stdout.write(`已追加 ${additions.length} 节：只加不改，原有内容一个字节没动。\n`)
    process.stdout.write('接下来读代码填掉里面的「fill」标记，填完把标记行删掉。\n')
    return 0
  }

  // 默认：有受管标记就刷新（只动标记之间、只动还带占位的），没有就只报。
  if (mode === 'default' && info.regions.length > 0 && !info.broken?.length) {
    const refreshed = refreshRegions(existing, template)
    if (refreshed.changed) {
      writeAtomic(agentsPath, refreshed.text)
      process.stdout.write('已刷新还带占位的受管区间（标记之外一个字节没动）。\n')
    } else {
      process.stdout.write('受管区间都已填过，文件未改动。\n')
    }
    report(agentsPath, inspect(agentsPath, template), { verbose })
    return 0
  }

  // 默认 / --status：只报，不写。
  report(agentsPath, info, { verbose })
  return 0
}

async function generate(root, agentsPath, template) {
  const facts = await survey(root)
  const content = fillTemplate(template, facts)
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

/** 从模板里挑出文件还没有的节（含它自己的标记），整段追加。 */
function collectMissingSections(template, existing) {
  const templateLines = template.split('\n')
  const { regions } = markerRegions(template, 'AGENTS.md')
  const out = []
  for (const region of regions) {
    const opening = templateLines[region.start]
    // 用节标题判断「有没有」比用 id 稳：id 可以改，标题是人看的锚。
    const body = templateLines.slice(region.start + 1, region.end)
    const heading = body.find((line) => /^##\s+/.test(line))
    if (!heading) continue
    if (existing.includes(heading.trim())) continue
    out.push([opening, ...body, templateLines[region.end]].join('\n'))
  }
  return out
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code))
}
