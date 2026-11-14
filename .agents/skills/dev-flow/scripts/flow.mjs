#!/usr/bin/env node
/**
 * flow.mjs —— Git 协同流转状态机总入口（零记忆自动推断 --task，统一 CLI 解析）。
 *
 * 子命令：
 *   inspect | start | claim | finalize | verify | submit | rework | merge | cleanup | status | abort
 */

import { basename } from 'node:path'

import { parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { isMainModule } from '../../lib/git.mjs'
import { resolveRepoRoots } from '../../lib/git.mjs'
import { detectGateWeakening } from '../../lib/static-gates.mjs'
import { analyzeIssueDependencies, handleClaim, handleStart, inspectWorkspace } from './flow-inspect.mjs'
import { handleFinalize, handleRework, handleSubmit, handleVerify } from './flow-lifecycle.mjs'
import { handleAbort, handleCleanup, handleMerge, handleRelease, handleStatus } from './flow-merge.mjs'

export { analyzeIssueDependencies, detectGateWeakening, inspectWorkspace }

const SUBCOMMANDS = ['inspect', 'start', 'claim', 'release', 'finalize', 'verify', 'submit', 'rework', 'merge', 'cleanup', 'status', 'abort']

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/flow.mjs <子命令> [选项]',
    '',
    '子命令（claim/release/finalize/verify/submit/rework/merge/cleanup/status/abort 支持自动推断 --task）：',
    '  inspect   [inputs...] [--probe-auth] [--external-pr <M>] [--json]',
    '  start     [--task <id>] [--slug <slug>] [--case <1..5>] [--issue <N>] [--create-issue --title "<标题>"] [--parallel] [--external-pr <M>] [--clone-choice <c>] [--json]',
    '  claim     [--task <id>] [--issue <N>] [--agent <id>] [--takeover --reason "<原因>"] [--json]',
    '  release   [--task <id>] [--issue <N>] [--agent <id>] [--reason "<原因>"] [--json]',
    '  finalize  [--task <id>] [--note <text>] [--strict-sync] [--json]',
    '  verify    [--task <id>] [--mode|--tier quick|smoke|full|gate] [--target <file>] [--cmd <custom>] [--visual-checked] [--json]',
    '  submit    [--task <id>] [--draft] [--rework] [--json]',
    '  rework    [--task <id>] [--rebut "<findingId>: <reason>"] [--json]',
    '  merge     [--task <id>] [--method merge|squash|rebase] [--human-approved] [--reason <text>] [--json]',
    '  cleanup   [--task <id>] [--confirm] [--keep-branch] [--force] [--json]',
    '  status    [--task <id>] [--json]',
    '  abort     [--task <id>] [--confirm] [--keep-branch] [--force] [--json]',
  ].join('\n') + '\n')
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }

  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      booleanFlags: [
        'probe-auth', 'parallel', 'draft', 'rework', 'confirm', 'force',
        'keep-branch', 'human-approved', 'visual-checked', 'strict-sync',
        'create-issue', 'takeover',
      ],
      valueFlags: [
        'task', 'slug', 'case', 'files', 'external-pr', 'pr', 'issue', 'issues',
        'branch', 'clone-choice', 'fork-url', 'pr-ref', 'implementer', 'todo', 'spec', 'prd',
        'agent', 'note', 'mode', 'tier', 'target', 'cmd', 'visual-evidence', 'title', 'body',
        'labels', 'method', 'reason',
      ],
      multiFlags: ['rebut'],
      usageHint: 'flow.mjs <inspect|start|claim|release|finalize|verify|submit|rework|merge|cleanup|status|abort>',
    })
  } catch (err) {
    process.stderr.write(`flow 错误：${err.message}\n`)
    return 2
  }
  const { sub, opts } = cli
  if (cli.help) { printHelp(); return 0 }

  const roots = await resolveRepoRoots(cli.targetDir)

  try {
    if (sub === 'inspect') {
      const data = await inspectWorkspace(cli.targetDir, {
        inputs: opts._,
        probeAuth: Boolean(opts['probe-auth']),
        externalPr: opts['external-pr'],
        issue: opts.issue,
        pr: opts.pr,
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      else {
        const scopeLabel = data.identity.collaborationScope === 'team-collaborator'
          ? ' | 协同范围: 团队协作者'
          : (data.identity.collaborationScope === 'owner' ? ' | 协同范围: 所有者' : '')
        process.stdout.write(`# 工作区探测：${basename(data.mainRoot)}\n`)
        process.stdout.write(`- 身份: ${data.identity.role}${scopeLabel} (${data.identity.reason})\n`)
        if (data.identity.teamProbeHint) process.stdout.write(`- 团队权限提示: ${data.identity.teamProbeHint}\n`)
        process.stdout.write(`- 分支: ${data.branch ?? 'detached'} @ ${(data.head ?? 'unborn').slice(0, 7)} | 默认基线: ${data.defaultBranch} | 脏文件: ${data.dirty}\n`)
        process.stdout.write(`- 平台通道: provider=${data.github.providerId ?? 'github'}, TrackB=${data.github.trackB.tier}, https=${data.github.trackA.https}, ssh=${data.github.trackA.ssh}\n`)
        if (data.github.trackA.remediationCmd) process.stdout.write(`- 协议修复建议: ${data.github.trackA.remediationCmd}\n`)
        if (data.inputs.reuseExistingPr) process.stdout.write(`- 复用已有 PR: #${data.inputs.reuseExistingPr.prNumber} (${data.inputs.reuseExistingPr.note})\n`)
        if (data.inputs.issues.length > 1) process.stdout.write(`- 多 Issue 拓扑排序: ${data.inputs.issueGraph.orderedIssues.map((n) => `#${n}`).join(' -> ')}\n`)
        printNextStep([
          data.identity.role === 'clone-readonly'
            ? (data.identity.teamProbeHint
              ? '若是组织/团队协作者，可先运行 flow.mjs inspect --probe-auth 验证写权限；若确认为只读克隆，再带 --clone-choice 运行 start'
              : '只读克隆仓，请先向用户确认 --clone-choice <fork|standalone|local> 再运行 flow.mjs start')
            : { skill: 'dev-plan', text: '1. 按任务规模运行 doc-plan.mjs triage；2. 执行 flow.mjs start --task <id>' },
        ], { repoRoot: data.mainRoot })
      }
      return 0
    }

    if (sub === 'start') return (await handleStart(opts, roots)).exitCode
    if (sub === 'claim') return (await handleClaim(opts, roots)).exitCode
    if (sub === 'release') return (await handleRelease(opts, roots)).exitCode
    if (sub === 'finalize') return (await handleFinalize(opts, roots)).exitCode
    if (sub === 'verify') return (await handleVerify(opts, roots)).exitCode
    if (sub === 'submit') return (await handleSubmit(opts, roots)).exitCode
    if (sub === 'rework') return (await handleRework(opts, roots)).exitCode
    if (sub === 'merge') return (await handleMerge(opts, roots)).exitCode
    if (sub === 'cleanup') return (await handleCleanup(opts, roots)).exitCode
    if (sub === 'status') return (await handleStatus(opts, roots)).exitCode
    if (sub === 'abort') return (await handleAbort(opts, roots)).exitCode

    throw new Error(`未知子命令：${sub}`)
  } catch (err) {
    process.stderr.write(`flow 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
