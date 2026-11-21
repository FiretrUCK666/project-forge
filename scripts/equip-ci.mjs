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

import {
  buildSwitchABranchProtectionPayload,
  createGitHubClient,
  normalizeGitHubRepo,
} from './lib/platform/github-client.mjs'
import { probeGitHubEnv } from './lib/platform/github-probe.mjs'
import { survey } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(HERE, '..', 'templates')

const USAGE = `用法：
  node scripts/equip-ci.mjs <目录> --kind check|release [--dry-run] [--json]
  node scripts/equip-ci.mjs <目录> --protect-branch [--branch <分支>] [--required-check <名称>] [--dry-run] [--json]

  --kind check               生成 .github/workflows/check.yml
  --kind release             生成 .github/workflows/release.yml（仅 GitHub 远端）
  --protect-branch           为默认分支启用开关 A 分支保护（禁直推/强推/删分支、要求 PR 与 Checks，不强制审批）
  --branch <分支>            指定保护的目标分支（默认读取勘察默认分支或 main）
  --required-check <名称>    指定必过状态检查名（可重复；默认从既有 check.yml 自动提取）
  --dry-run                  只打印将要写入/请求的内容，不落盘或调用写 API
  --json                     机器可读输出`

function parseArgs(argv) {
  const args = { _: [], dryRun: false, json: false, protectBranch: false, requiredChecks: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--kind') args.kind = argv[++i]
    else if (a.startsWith('--kind=')) args.kind = a.slice('--kind='.length)
    else if (a === '--protect-branch') args.protectBranch = true
    else if (a === '--branch') args.branch = argv[++i]
    else if (a.startsWith('--branch=')) args.branch = a.slice('--branch='.length)
    else if (a === '--required-check') {
      const val = argv[++i]
      if (val) args.requiredChecks.push(...val.split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a.startsWith('--required-check=')) {
      const val = a.slice('--required-check='.length)
      if (val) args.requiredChecks.push(...val.split(',').map((s) => s.trim()).filter(Boolean))
    } else if (a === '--dry-run') args.dryRun = true
    else if (a === '--json') args.json = true
    else if (a === '--help' || a === '-h') args.help = true
    else args._.push(a)
  }
  return args
}

function extractCheckContextsFromWorkflow(ymlText) {
  const lines = String(ymlText ?? '').replace(/\r\n/g, '\n').split('\n')
  let inJobs = false
  let currentJob = null
  const jobs = []
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, '')
    if (!line.trim()) continue
    if (/^[A-Za-z0-9_-]+:\s*/.test(line)) {
      if (inJobs && currentJob) {
        jobs.push(currentJob)
        currentJob = null
      }
      inJobs = /^jobs:\s*$/.test(line.trim())
      continue
    }
    if (!inJobs) continue
    const jobMatch = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    if (jobMatch) {
      if (currentJob) jobs.push(currentJob)
      currentJob = { id: jobMatch[1], name: null }
      continue
    }
    if (currentJob) {
      const nameMatch = /^ {4}name:\s*['"]?([^'"\n]+?)['"]?\s*$/.exec(line)
      if (nameMatch && !nameMatch[1].includes('${{')) {
        currentJob.name = nameMatch[1].trim()
      }
    }
  }
  if (currentJob) jobs.push(currentJob)
  return [...new Set(jobs.map((j) => j.name || j.id).filter(Boolean))]
}

function resolveDefaultRequiredChecks(target, facts, explicitChecks) {
  if (Array.isArray(explicitChecks) && explicitChecks.length > 0) {
    return [...new Set(explicitChecks.map((s) => String(s ?? '').trim()).filter(Boolean))]
  }
  const wfFiles = facts.docs?.workflowFacts?.checkWorkflows ?? []
  const candidates = wfFiles.length > 0
    ? wfFiles.map((f) => (f.startsWith('.github/') ? f : `.github/workflows/${f}`))
    : ['.github/workflows/check.yml']
  const contexts = []
  for (const rel of candidates) {
    const abs = join(target, rel)
    if (!existsSync(abs)) continue
    try {
      contexts.push(...extractCheckContextsFromWorkflow(readFileSync(abs, 'utf8')))
    } catch { /* ignore */ }
  }
  return [...new Set(contexts)]
}

/**
 * 为目标仓库默认分支应用「开关 A」分支保护，或在不支持平台 / 403 权限受限时安全降级。
 */
export async function protectBranch(targetDir, {
  branch,
  requiredChecks,
  dryRun = false,
  client,
  probeResult,
  env = process.env,
  facts: providedFacts,
} = {}) {
  const target = resolve(targetDir)
  const facts = providedFacts ?? await survey(target, {})
  const caps = facts.git?.capabilities ?? null
  const providerId = caps?.providerId ?? facts.git?.providerId ?? null
  const bpPlan = (facts.artifactPlan ?? []).find((item) => item.id === 'branch-protection')
  const targetBranch = String(
    branch
    || facts.conventions?.defaultBranch
    || facts.git?.originHeadBranch
    || facts.git?.initDefaultBranch
    || 'main',
  ).trim() || 'main'

  if (bpPlan?.action === 'skip' || caps?.branchProtection !== true) {
    const message = bpPlan?.action === 'skip'
      ? `按 artifactPlan（${bpPlan.status}）跳过分支保护写入：${bpPlan.detail}`
      : `当前远端（providerId=${providerId ?? '无/未知'}）不支持通过统一 API 自动写入分支保护（branchProtection=false）。`
        + `请在托管界面为默认分支「${targetBranch}」手动启用开关 A（禁直推/强推/删分支、要求变更提案与检查通过，且不要强制他人审批），`
        + `并安装本地推送护栏：node scripts/equip.mjs ${target} --with-hooks`
    return {
      ok: true,
      status: 'SKIPPED_UNSUPPORTED',
      providerId,
      branch: targetBranch,
      fallbackToHooks: true,
      ...(bpPlan ? { artifactPlanAction: bpPlan.action } : {}),
      message,
    }
  }

  const remoteCandidate = facts.git?.remoteUrls?.origin || facts.git?.remote || facts.ecosystem?.declaredRepo
  const repo = normalizeGitHubRepo(remoteCandidate)
  if (!repo) {
    return {
      ok: true,
      status: 'SKIPPED_NO_REPO',
      providerId,
      branch: targetBranch,
      fallbackToHooks: true,
      message: '未解析到有效的 GitHub owner/repo，请先配置远端后再执行 --protect-branch 或改用 --with-hooks。',
    }
  }

  const resolvedChecks = resolveDefaultRequiredChecks(target, facts, requiredChecks)
  const payload = buildSwitchABranchProtectionPayload({ requiredChecks: resolvedChecks })

  if (dryRun) {
    return {
      ok: true,
      status: 'DRY_RUN',
      providerId,
      repo,
      branch: targetBranch,
      payload,
      message: `[dry-run] 将对 ${repo} 分支 ${targetBranch} 应用开关 A（required_approving_review_count=0，checks=${resolvedChecks.join(', ') || '无'}）`,
    }
  }

  const effectiveProbe = probeResult ?? (client
    ? undefined
    : await probeGitHubEnv({ cwd: target, remoteUrls: facts.git?.remoteUrls ?? {}, defaultBranch: targetBranch, env }))
  const ghClient = client ?? createGitHubClient({ cwd: target, env, probeResult: effectiveProbe })
  if (ghClient.channel === 'none') {
    return {
      ok: false,
      status: 'FALLBACK_TO_HOOKS',
      providerId,
      repo,
      branch: targetBranch,
      fallbackToHooks: true,
      reason: '当前无可用本地 GitHub API 凭据或通道（gh-cli / token）。',
      message: `无本地 API 凭据，无法远程配置 ${repo} 分支保护；请配置凭据后重试，或降级安装本地护栏：node scripts/equip.mjs ${target} --with-hooks`,
      payload,
    }
  }

  const res = await ghClient.applyBranchProtectionSwitchA(repo, targetBranch, {
    requiredChecks: resolvedChecks,
  })
  if (res.ok) {
    return {
      ok: true,
      status: 'PROTECTED',
      providerId,
      repo,
      branch: targetBranch,
      payload: res.payload,
      protection: res.protection,
      message: `已为 ${repo} 默认分支 ${targetBranch} 启用开关 A 分支保护（禁直推/强推/删分支、不强制他人审批）。`,
    }
  }

  return {
    ok: false,
    status: 'FALLBACK_TO_HOOKS',
    providerId,
    repo,
    branch: targetBranch,
    fallbackToHooks: true,
    reason: res.reason,
    payload: res.payload,
    message: `远端分支保护配置受限（${res.reason}），已优雅降级：请运行 node scripts/equip.mjs ${target} --with-hooks 安装本地 .githooks/pre-push 护栏。`,
  }
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

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help || args._.length === 0 || (!args.kind && !args.protectBranch)) {
    process.stdout.write(`${USAGE}\n`)
    return args.help ? 0 : 2
  }
  if (args.kind && args.protectBranch) {
    process.stderr.write('--kind 与 --protect-branch 请分两次调用\n')
    return 2
  }

  const target = resolve(args._[0])
  if (!existsSync(target)) {
    process.stderr.write(`目录不存在：${target}\n`)
    return 2
  }

  if (args.protectBranch) {
    const out = await protectBranch(target, {
      branch: args.branch,
      requiredChecks: args.requiredChecks,
      dryRun: args.dryRun,
    })
    if (args.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
    else process.stdout.write(`${out.message}\n`)
    return 0
  }

  if (!['check', 'release'].includes(args.kind)) {
    process.stderr.write(`--kind 只能是 check 或 release，收到：${args.kind}\n`)
    return 2
  }

  const facts = await survey(target, {})
  const caps = facts.git?.capabilities ?? null
  const providerId = caps?.providerId ?? facts.git?.providerId ?? null
  const planId = args.kind === 'check' ? 'ci-check' : 'ci-release'
  const planItem = (facts.artifactPlan ?? []).find((item) => item.id === planId)

  // 直接消费 survey.computeArtifactPlan 产出的 facts.artifactPlan 决定是否落盘 CI 模板
  if (planItem?.action === 'skip') {
    const msg = `按勘察产物计划（${planId}: ${planItem.status}）跳过生成：${planItem.detail}`
    if (args.json) {
      process.stdout.write(`${JSON.stringify({ status: 'SKIPPED_BY_ARTIFACT_PLAN', planId, action: planItem.action, providerId, message: msg }, null, 2)}\n`)
    } else {
      process.stdout.write(`${msg}\n`)
    }
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
