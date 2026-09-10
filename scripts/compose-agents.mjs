#!/usr/bin/env node
/**
 * compose-agents.mjs —— 把通用内核逐字注入 AGENTS.md
 *
 * 存在的理由：AGENTS.md 里有三段内容（行事总纲、本文件的定位与编辑规则、任务编排
 * 方法论）对任何项目都成立，应当逐字一致。靠手抄必然漂移——改了一处漏了另一处，
 * 几个月后各项目的"总纲"就各不相同了。这个脚本把那段内容收敛成单一来源：
 * templates/agents-kernel.md 是唯一权威，其余项目由脚本注入。
 *
 * 行为：
 *   - 只替换标记之间的内容，标记之外的一个字节都不动；
 *   - 幂等：反复执行结果相同；
 *   - 输出统一 LF、无 BOM（跨平台一致，避免行尾差异被带进版本库）；
 *   - 报告成品字节数与预算占比，超预算时给出警告。
 *
 * 用法：
 *   node scripts/compose-agents.mjs [目录]            注入并写回
 *   node scripts/compose-agents.mjs [目录] --check    只校验不写（不一致时退出码 1）
 *   node scripts/compose-agents.mjs [目录] --budget N 指定预算字节数（默认 65536）
 *
 * 标记约定（必须成对出现在 AGENTS.md 里）：
 *   <!-- project-forge:kernel:start -->
 *   <!-- project-forge:kernel:end -->
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const KERNEL_PATH = join(SKILL_ROOT, 'templates', 'agents-kernel.md')
const SKELETON_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

const START = '<!-- project-forge:kernel:start -->'
const END = '<!-- project-forge:kernel:end -->'
const DEFAULT_BUDGET = 65536

function readUtf8(p) {
  // 统一去掉 BOM，并统一成 LF
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

/** 取出内核正文：去掉首尾空行，去掉可能存在的标记行。 */
function kernelBody() {
  if (!existsSync(KERNEL_PATH)) throw new Error(`找不到内核模板：${KERNEL_PATH}`)
  let body = readUtf8(KERNEL_PATH)
  body = body.replaceAll(START, '').replaceAll(END, '')
  return body.replace(/^\n+/, '').replace(/\n+$/, '')
}

/** 用内核替换标记之间的内容。标记缺失即报错——绝不猜测该插到哪里。 */
function inject(text, kernel) {
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

/** 严格逐项解析，避免把 --budget 的取值误当成目标目录。 */
function parseArgs(argv) {
  const positional = []
  let check = false
  let budget = DEFAULT_BUDGET
  let help = false
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') { check = true; continue }
    if (arg === '--help' || arg === '-h') { help = true; continue }
    if (arg === '--budget') {
      const raw = argv[i + 1]
      const value = Number(raw)
      if (!Number.isFinite(value) || value <= 0) throw new Error('--budget 需要一个正整数字节数。')
      budget = value
      i += 1
      continue
    }
    if (arg.startsWith('--')) throw new Error(`无法识别的参数：${arg}`)
    positional.push(arg)
  }
  return { check, budget, help, positional }
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  const { check, budget, help, positional } = parsed
  if (help) {
    process.stdout.write([
      '用法：node scripts/compose-agents.mjs [目录] [--check] [--budget N]',
      '',
      '  把 templates/agents-kernel.md 的内核逐字注入目标目录的 AGENTS.md，',
      '  只替换内核标记之间的内容，标记之外不动。幂等。',
      '',
      '  --check       只校验，不写入；不一致时退出码 1',
      '  --budget N    预算字节数，默认 65536',
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

  let existing
  if (existsSync(agentsPath)) {
    existing = readUtf8(agentsPath)
  } else if (check) {
    process.stderr.write(`校验失败：${agentsPath} 不存在。\n`)
    return 1
  } else if (existsSync(SKELETON_PATH)) {
    // 首次生成：用骨架起步，调用方随后填写项目特有的部分
    existing = readUtf8(SKELETON_PATH)
  } else {
    process.stderr.write(`错误：${agentsPath} 不存在，且找不到骨架 ${SKELETON_PATH}。\n`)
    return 2
  }

  let composed
  try {
    composed = inject(existing, kernel)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  if (!composed.endsWith('\n')) composed += '\n'

  const bytes = Buffer.byteLength(composed, 'utf8')
  const ratio = ((bytes / budget) * 100).toFixed(1)
  const same = composed === existing

  if (check) {
    if (!same) {
      process.stderr.write(
        `校验失败：AGENTS.md 里的内核与 templates/agents-kernel.md 不一致。\n`
        + `  文件：${agentsPath}\n`
        + `  期望字节数：${bytes}　实际：${Buffer.byteLength(existing, 'utf8')}\n`
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

  if (same) {
    process.stdout.write(`无需改动：内核已是当前版本（${bytes} 字节，占预算 ${ratio}%）。\n`)
    return 0
  }

  mkdirSync(dirname(agentsPath), { recursive: true })
  writeFileSync(agentsPath, composed, { encoding: 'utf8' })
  process.stdout.write(`已注入内核：${agentsPath}（${bytes} 字节，占预算 ${ratio}%）\n`)
  if (bytes > budget) {
    process.stderr.write(
      `警告：总字节数 ${bytes} 已超出预算 ${budget}。\n`
      + '  超出部分在注入会话上下文时会被截断。请把可下放到子目录的内容移到子目录 AGENTS.md，\n'
      + '  或把细节移出本文件、改为指向项目内其他文档。\n',
    )
  }
  return 0
}

process.exitCode = main(process.argv)
