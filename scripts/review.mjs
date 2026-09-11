#!/usr/bin/env node
/**
 * review.mjs —— 目标项目交付门禁（P4/P5 是否写完，机器说了算）
 *
 * 存在的理由：P4/P5 的完成标准里只有 AGENTS.md 有机器数（双数字归零），
 * README/双语/徽章/LICENSE/工作流全靠“汇报里写明”——没有机器门的东西，
 * AI 一忙就忘，忘了一点声音都没有。所以这里把“写完”变成可执行的检查：
 *
 *   node scripts/review.mjs <项目目录> [决策 flag...]
 *
 * 状态只有三种：
 *   [齐]   事实已满足；
 *   [缺]   事实缺失且无用户决策 → 退出码 1，必须补；
 *   [待问] 机器判不了，需要问用户 → 问完用对应的 --no-* flag 把答案记下来再跑，
 *           不允许“没问就当不要”。flag 本身就是用户答复的机器载体。
 *
 * 退出码：0 = 无[缺]（[待问]须已用 flag 消掉）；1 = 有[缺]或用法错误。
 * 只读（会跑 check-badges 联网验徽章，离线时如实报跳过）；不写任何文件。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const KERNEL_START = '<!-- project-forge:kernel:start -->'
const KERNEL_END = '<!-- project-forge:kernel:end -->'
const AUTHOR_RE = /<!--\s*pf:author\s*(?::[\s\S]*?)?-->/g

const FLAGS = new Set([
  '--no-bilingual', // 用户确认：单语即可，不要英文版
  '--no-contributing', // 用户确认：自用项目，不要贡献指南
  '--private-no-license', // 用户确认：保留所有权利，不落盘 LICENSE
  '--no-ci', // 用户确认：暂不要 CI
  '--no-auto-release', // 用户确认：暂不要自动发布
])

function readText(p) {
  try {
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

function parseArgs(argv) {
  const positional = []
  const flags = new Set()
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (a.startsWith('--')) {
      if (!FLAGS.has(a)) throw new Error(`无法识别的参数：${a}（可用：${[...FLAGS].join('、')}）`)
      flags.add(a)
      continue
    }
    positional.push(a)
  }
  return { target: positional[0] ?? process.cwd(), flags }
}

/** 跑徽章检查。返回 ok / bad / offline / nobadge 四态，不抛错。 */
function checkBadges(root, readmes) {
  if (readmes.length === 0) return { state: 'nobadge' }
  const r = spawnSync(process.execPath, [join(HERE, 'check-badges.mjs'),
    ...readmes.map((f) => join(root, f))], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (/没有徽章/.test(out)) return { state: 'nobadge' }
  if (/显示不出来/.test(out)) return { state: 'bad', detail: out }
  if (/没能检查|请求失败|注意：/.test(out)) return { state: 'offline' }
  return { state: 'ok' }
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(
      '用法：node scripts/review.mjs <项目目录> [--no-bilingual] [--no-contributing]\n'
      + '      [--private-no-license] [--no-ci] [--no-auto-release]\n\n'
      + '  无[缺]即退出码 0。[待问]必须问用户后用对应 flag 消掉，不许默跳。\n',
    )
    return 0
  }
  const { target, flags } = parsed
  const root = resolve(target)

  let s
  try {
    s = survey(root)
  } catch (error) {
    process.stderr.write(`勘察失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const missing = []
  const pending = []
  const ok = []
  const line = (st, text) => process.stdout.write(`  [${st}] ${text}\n`)
  process.stdout.write(`交付门禁：${s.target.name}（${s.target.path}）\n`)

  // 1. AGENTS.md：内核标记 + 待填写归零（缺节由 compose --status 判定，此处只看两数中的待填写）。
  const agentsPath = join(root, 'AGENTS.md')
  const agents = readText(agentsPath)
  if (agents === undefined) {
    missing.push('AGENTS.md 缺失')
  } else {
    const authors = (agents.match(AUTHOR_RE) ?? []).length
    const kernel = agents.includes(KERNEL_START) && agents.includes(KERNEL_END)
    if (!kernel) missing.push('AGENTS.md 缺少内核标记（跑 compose-agents 生成或升级）')
    else if (authors > 0) missing.push(`AGENTS.md 待填写 ${authors} 处（读代码填实，删标记）`)
    else ok.push('AGENTS.md 内核一致、待填写归零')
  }

  // 2. 提交署名：没有仓库时跳过（P3 建库时再定）；有仓库而署名缺失必须补——
  // 否则首个提交永久带着错误署名。占位值靠人眼（G7），机器只卡缺失。
  const git = s.git ?? {}
  if (git.present === true) {
    const id = git.identity ?? {}
    if (!id.name || !id.email) {
      missing.push('提交署名缺失（只写仓库级，见版本管理署名审计清单）')
    } else {
      ok.push(`提交署名有（${id.name}，${id.scope === 'repo' ? '仓库级' : '继承全局'}；占位值须人眼确认）`)
    }
  }

  // 3. README：必须有；双语要么成对，要么用户明确说单语。
  const readmes = s.docs?.readme ?? []
  if (readmes.length === 0) {
    missing.push('README 缺失')
  } else {
    ok.push(`README 有（${readmes.join('、')}）`)
    if (s.docs?.readmePair !== undefined) ok.push('双语 README 成对')
    else if (flags.has('--no-bilingual')) ok.push('单语（用户已确认不要英文版）')
    else pending.push('双语：只有一份 README，问用户要不要英文版（要→补，不要→加 --no-bilingual）')
  }

  // 4. 徽章：有就必须验（联网跑 check-badges，离线如实报）；没有徽章不强求。
  const badgeResult = checkBadges(root, readmes)
  if (badgeResult.state === 'bad') missing.push('徽章显示不出来（见上文输出，删掉或修好）')
  else if (badgeResult.state === 'offline') pending.push('徽章未能联网验证：在汇报里写明未验及原因')
  else ok.push(badgeResult.state === 'ok' ? '徽章全部可显示' : '无徽章（可选，不强求）')

  // 5. CONTRIBUTING / LICENSE：缺了必须问，不能默跳。
  if (s.docs?.contributing !== undefined) ok.push('CONTRIBUTING 有')
  else if (flags.has('--no-contributing')) ok.push('无 CONTRIBUTING（用户已确认自用）')
  else pending.push('CONTRIBUTING 缺失：问用户会不会给别人用（会→补，不会→加 --no-contributing）')
  if (s.docs?.license !== undefined) ok.push('LICENSE 有')
  else if (flags.has('--private-no-license')) ok.push('无 LICENSE（用户已选保留所有权利）')
  else pending.push('LICENSE 缺失：问用户选哪个许可证（保留权利→加 --private-no-license）')

  // 6. 工作流：CI 与自动发布要么落盘，要么用户明确说暂不要。
  const auto = s.docs?.workflowAutomation
  if (auto === undefined || auto.files.length === 0) {
    if (flags.has('--no-ci')) ok.push('无 CI（用户已确认暂不要）')
    else pending.push('CI 缺失：问用户要不要检查自动化与自动发布（不要→加 --no-ci，不要默跳）')
  } else {
    ok.push(`工作流有（${auto.files.join('、')}）`)
    if (s.artifacts?.publishableManifest !== undefined && s.artifacts?.private !== true) {
      if (auto.hasReleaseJob) ok.push('发布 job 有')
      else if (flags.has('--no-auto-release')) ok.push('无发布 job（用户已确认暂不要自动发布）')
      else pending.push('发布 job 缺失：可发布项目问用户要不要自动写 Release（不要→加 --no-auto-release）')
    }
  }

  for (const t of ok) line('齐', t)
  for (const t of pending) line('待问', t)
  for (const t of missing) line('缺', t)
  if (missing.length > 0) {
    process.stdout.write(`\n结论：${missing.length} 处缺失，补完重跑。待问事项问完用户后用 flag 消掉。\n`)
    return 1
  }
  if (pending.length > 0) {
    process.stdout.write('\n结论：无缺失，但有待问事项——问完用户、加 flag 重跑，全齐才算交付。\n')
    return 0
  }
  process.stdout.write('\n结论：全部齐备，可以交付。\n')
  return 0
}

process.exitCode = main(process.argv)
