#!/usr/bin/env node
/**
 * equip-ci.mjs —— 把 templates/ 里的 CI 骨架按勘察事实落盘。
 *
 * ## 为什么需要它
 *
 * 模板 `templates/ci-check.yml` 与 `templates/ci-release.yml` 一直在仓库里，
 * 而**没有任何脚本读过它们**。于是勘察报「该建 CI」，执行者却只能靠人想起来去复制一份——
 * 计划说了要做的事，可以永远停在计划状态，门禁还是绿的。
 *
 * ## 取值从哪来
 *
 * 不在这里写死任何版本号或命令：门禁命令读勘察出的真实命令，远端能力读平台注册表。
 * **这个脚本只做「把已有的真相搬进模板」，不产生新事实。**
 *
 * ## 非 GitHub 远端直接退出
 *
 * 发版工作流是 GitHub Release 专用。远端不是 GitHub 时它不可能工作，所以不做
 * 「生成一份跑不起来的文件」这种假动作，而是退出并说清原因。
 *
 * 用法：
 *   node scripts/equip-ci.mjs <目录> --kind check|release [--dry-run] [--json]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(HERE, '..', 'templates')

const USAGE = `用法：node scripts/equip-ci.mjs <目录> --kind check|release [--dry-run] [--json]

  --kind check      生成 .github/workflows/check.yml
  --kind release    生成 .github/workflows/release.yml（仅 GitHub 远端）
  --dry-run         只打印将要写入的内容，不落盘
  --json            机器可读输出`

function parseArgs(argv) {
  const args = { _: [], dryRun: false, json: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--kind') args.kind = argv[++i]
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') args.help = true
    else args._.push(a)
  }
  return args
}

/**
 * 把模板里的待办占位替换成勘察到的真实取值。
 *
 * 只替换能确定的那几行：门禁命令。定不下来的**原样保留模板里的待办标记**——
 * 留一个显眼的标记比填一个猜的值安全：猜的值会静默跑错，标记会被人看见。
 */
function hydrateCheckTemplate(template, facts) {
  const commands = facts.commands ?? {}
  const order = ['install', 'build', 'typecheck', 'lint', 'test', 'verify']
  const runLines = order.map((k) => commands[k]).filter((v) => typeof v === 'string' && v.trim())
  if (runLines.length === 0) return template

  // 「与本地跑的是同一条」是这条替换的全部意义：命令来自勘察，不是这里编的。
  return template.replace(
    / {10}<安装命令>\n {10}<构建命令>\n {10}<测试命令>/,
    runLines.map((c) => `          ${c}`).join('\n'),
  )
}

function hydrateReleaseTemplate(template, facts) {
  const conventions = facts.conventions ?? {}
  const manifest = facts.ecosystem?.manifests?.[0]
  let out = template
  if (manifest) out = out.replace(/<版本来源文件>/g, manifest)
  if (conventions.defaultBranch) out = out.replace(/<默认分支>/g, conventions.defaultBranch)
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0 || !args.kind) {
    process.stdout.write(`${USAGE}\n`)
    return args.help ? 0 : 2
  }

  const target = resolve(args._[0])
  if (!existsSync(target)) {
    process.stderr.write(`目录不存在：${target}\n`)
    return 2
  }
  if (!['check', 'release'].includes(args.kind)) {
    process.stderr.write(`--kind 只能是 check 或 release，收到：${args.kind}\n`)
    return 2
  }

  const facts = await survey(target, {})
  const caps = facts.git?.capabilities ?? null
  const providerId = caps?.providerId ?? facts.git?.providerId ?? null

  // 发版工作流是 GitHub Release 专用：远端不是 GitHub 时它不可能工作。
  // 不做「生成一份跑不起来的文件」这种假动作。
  if (args.kind === 'release' && providerId !== 'github') {
    const msg = `这个远端不是 GitHub（providerId=${providerId ?? '未知'}），GitHub Release 发版工作流在这里不可能工作。`
      + '请改走该托管自己的发布流程，不要照搬这份模板。'
    if (args.json) process.stdout.write(`${JSON.stringify({ status: 'SKIPPED_NON_GITHUB', providerId, message: msg }, null, 2)}\n`)
    else process.stdout.write(`${msg}\n`)
    return 0
  }

  const tplName = args.kind === 'check' ? 'ci-check.yml' : 'ci-release.yml'
  const tplPath = join(TEMPLATES, tplName)
  if (!existsSync(tplPath)) {
    process.stderr.write(`模板缺失：templates/${tplName}\n`)
    return 1
  }
  const template = readFileSync(tplPath, 'utf8')
  const rendered = args.kind === 'check'
    ? hydrateCheckTemplate(template, facts)
    : hydrateReleaseTemplate(template, facts)

  const destRel = args.kind === 'check' ? '.github/workflows/check.yml' : '.github/workflows/release.yml'
  const destAbs = join(target, destRel)

  // 已有就**不覆盖**：里面可能有这个项目自己的门禁，覆盖等于把别人的门拆了。
  if (existsSync(destAbs)) {
    const msg = `${destRel} 已存在，拒绝覆盖——里面可能有这个项目自己的门禁。请人工合并。`
    if (args.json) process.stdout.write(`${JSON.stringify({ status: 'EXISTS', dest: destRel, message: msg }, null, 2)}\n`)
    else process.stdout.write(`${msg}\n`)
    return 0
  }

  if (args.dryRun) {
    if (args.json) process.stdout.write(`${JSON.stringify({ status: 'DRY_RUN', dest: destRel, bytes: Buffer.byteLength(rendered) }, null, 2)}\n`)
    else process.stdout.write(`[dry-run] 将写入 ${destRel}（${Buffer.byteLength(rendered)} 字节）\n\n${rendered}\n`)
    return 0
  }

  mkdirSync(dirname(destAbs), { recursive: true })
  writeFileSync(destAbs, rendered)
  if (args.json) process.stdout.write(`${JSON.stringify({ status: 'WRITTEN', dest: destRel, bytes: Buffer.byteLength(rendered) }, null, 2)}\n`)
  else process.stdout.write(`已写入 ${destRel}（${Buffer.byteLength(rendered)} 字节）\n`)
  return 0
}

const isMain = () => process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain()) process.exitCode = await main()

export { hydrateCheckTemplate, hydrateReleaseTemplate, main }
