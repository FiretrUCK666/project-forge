#!/usr/bin/env node
/**
 * flow.mjs —— Git 协同流转状态机总入口（零记忆自动推断 --task，按子命令按需加载减少启动耗时）。
 *
 * 子命令：
 *   inspect | next | start | claim | release | finalize | verify | submit | rework | sync | merge | cleanup | status | abort | batch
 */

import { basename } from 'node:path'

import { flushAndExit, hasSkillSupport, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { isMainModule, resolveRepoRoots } from '../../lib/git.mjs'
import { parsePrNumber } from '../../lib/platform.mjs'
import { detectGateWeakening } from '../../lib/static-gates.mjs'
import { buildInspectNextSteps } from '../../lib/workflow-policy.mjs'
import { analyzeIssueDependencies, inspectWorkspace } from './flow-inspect.mjs'

export { main as runCli, analyzeIssueDependencies, detectGateWeakening, inspectWorkspace }

const SUBCOMMANDS = ['inspect', 'next', 'start', 'claim', 'release', 'finalize', 'verify', 'submit', 'rework', 'sync', 'merge', 'cleanup', 'status', 'abort', 'batch']

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/flow.mjs <子命令> [选项]',
    '',
    '子命令（next/claim/release/finalize/verify/submit/rework/sync/merge/cleanup/status/abort 支持自动推断 --task）：',
    '  inspect   [inputs...] [--probe-auth] [--external-pr <M>] [--json]',
    '  next      [--task <id>] [--probe-auth] [--json]',
    '  start     [--task <id>] [--base <branch>] [--slug <slug>] [--case <1..5>] [--issue <N>] [--create-issue --title "<标题>"] [--after <parent>] [--files <a,b>] [--parallel] [--external-pr <M>] [--clone-choice <c>] [--strict-deps] [--force] [--json]',
    '  claim     [--task <id>] [--issue <N>] [--agent <id>] [--takeover --reason "<原因>"] [--json]',
    '  release   [--task <id>] [--issue <N>] [--agent <id>] [--reason "<原因>"] [--json]',
    '  finalize  [--task <id>] [--note <text>] [--strict-sync] [--include-master-prd] [--json]',
    '  verify    [--task <id>] [--mode|--tier quick|smoke|full|gate] [--timeout <ms>] [--target <file>] [--cmd <custom>] [--visual-checked] [--human-approved] [--json]',
    '  submit    [--task <id>] [--draft] [--rework] [--new-pr] [--reset-review-slot] [--json]',
    '  rework    [--task <id>] [--rebut "<findingId>: <reason>"] [--json]',
    '  sync      [--task <id>] [--onto <branch>] [--probe-auth] [--json]',
    '  merge     [--task <id>] [--method merge|squash|rebase] [--remote-merged] [--human-approved] [--reason <text>] [--json]',
    '  cleanup   [--task <id>] [--confirm] [--only-review-worktree|--keep-worktree] [--keep-local-branch] [--keep-remote-branch] [--keep-branch] [--force] [--allow-outbound <路径>] [--json]',
    '  status    [--task <id>] [--json]',
    '  abort     [--task <id>] [--confirm] [--keep-branch] [--force] [--allow-outbound <路径>] [--json]',
    '  batch     <plan|check-disjoint|merge-queue|resume-session> [--tasks <a,b>] [--enqueue <id>] [--enqueue-only] [--trial-local] [--task <id>] [--json]',
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
        'keep-branch', 'keep-worktree', 'only-review-worktree', 'keep-local-branch', 'keep-remote-branch',
        'human-approved', 'human-approved-exec', 'visual-checked', 'strict-sync', 'include-master-prd',
        'create-issue', 'takeover', 'reset-review-slot', 'remote-merged',
        'strict-deps', 'enqueue-only', 'new-pr', 'trial-local', 'handoff',
      ],
      valueFlags: [
        'task', 'slug', 'case', 'files', 'external-pr', 'pr', 'issue', 'issues', 'base',
        'branch', 'clone-choice', 'fork-url', 'pr-ref', 'implementer', 'todo', 'spec', 'prd',
        'agent', 'note', 'mode', 'tier', 'timeout', 'target', 'cmd', 'visual-evidence', 'title', 'body',
        'labels', 'method', 'reason', 'after', 'onto', 'tasks', 'enqueue', 'action', 'slot',
      ],
      multiFlags: ['rebut', 'allow-outbound'],
      usageHint: 'flow.mjs <inspect|next|start|claim|release|finalize|verify|submit|rework|sync|merge|cleanup|status|abort|batch>',
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
        roots,
        inputs: opts._,
        probeAuth: Boolean(opts['probe-auth']),
        externalPr: opts['external-pr'],
        issue: opts.issue ?? opts.issues,
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
        const extPrNum = data.identity.role === 'inbound-external-pr'
          ? (data.inputs.prs[0]?.number ?? parsePrNumber(opts['external-pr']))
          : null
        const hasDevReview = hasSkillSupport(data.mainRoot, 'dev-review')
        const nextSteps = buildInspectNextSteps({
          role: data.identity.role,
          teamProbeHint: data.identity.teamProbeHint,
          extPrNum,
          reuseExistingPr: data.inputs.reuseExistingPr,
          hasDevReview,
        })
        printNextStep(nextSteps, { repoRoot: data.mainRoot })
      }
      return 0
    }

    if (sub === 'next') {
      const { handleNext } = await import('./flow-next.mjs')
      return (await handleNext(opts, roots)).exitCode
    }
    if (sub === 'start') {
      const { handleStart } = await import('./flow-inspect.mjs')
      return (await handleStart(opts, roots)).exitCode
    }
    if (sub === 'claim' || sub === 'release' || sub === 'merge' || sub === 'cleanup' || sub === 'status' || sub === 'abort') {
      const { handleClaim, handleRelease, handleMerge, handleCleanup, handleStatus, handleAbort } = await import('./flow-merge.mjs')
      if (sub === 'claim') return (await handleClaim(opts, roots)).exitCode
      if (sub === 'release') return (await handleRelease(opts, roots)).exitCode
      if (sub === 'merge') return (await handleMerge(opts, roots)).exitCode
      if (sub === 'cleanup') return (await handleCleanup(opts, roots)).exitCode
      if (sub === 'status') return (await handleStatus(opts, roots)).exitCode
      return (await handleAbort(opts, roots)).exitCode
    }
    if (sub === 'sync') {
      const { handleSync } = await import('./flow-sync.mjs')
      return (await handleSync(opts, roots)).exitCode
    }
    if (sub === 'batch') {
      const { handleBatch } = await import('./flow-batch.mjs')
      return (await handleBatch(opts, roots)).exitCode
    }
    if (sub === 'finalize' || sub === 'verify' || sub === 'submit' || sub === 'rework') {
      const { handleFinalize, handleVerify, handleSubmit, handleRework } = await import('./flow-lifecycle.mjs')
      if (sub === 'finalize') return (await handleFinalize(opts, roots)).exitCode
      if (sub === 'verify') return (await handleVerify(opts, roots)).exitCode
      if (sub === 'submit') return (await handleSubmit(opts, roots)).exitCode
      return (await handleRework(opts, roots)).exitCode
    }

    throw new Error(`未知子命令：${sub}`)
  } catch (err) {
    process.stderr.write(`flow 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`flow 错误：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
