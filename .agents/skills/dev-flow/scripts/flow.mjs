#!/usr/bin/env node
/**
 * flow.mjs —— Git 协同流转状态机总入口（零记忆自动推断 --task，按子命令按需加载减少启动耗时）。
 *
 * 子命令：
 *   inspect | next | start | claim | release | finalize | verify | submit | rework | sync | merge | cleanup | status | abort | batch
 */

import { basename } from 'node:path'

import { flushAndExit, hasSkillSupport, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { isMainModule, resolveRepoRoots } from '../../lib/git.mjs'
import { parsePrNumber } from '../../lib/platform.mjs'
import { detectGateWeakening } from '../../lib/static-gates.mjs'
import { buildInspectNextSteps } from '../../lib/workflow-policy.mjs'
import { analyzeIssueDependencies, inspectWorkspace } from './flow-inspect.mjs'

export { main as runCli, analyzeIssueDependencies, detectGateWeakening, inspectWorkspace }

const SUBCOMMANDS = ['inspect', 'next', 'explore', 'intake', 'start', 'issue', 'close', 'milestone', 'claim', 'release', 'finalize', 'verify', 'submit', 'rework', 'sync', 'merge', 'cleanup', 'status', 'abort', 'batch']

/**
 * 由脚本确定性生成、不接受调用方整段替换的参数归属。
 *
 * 病根不在「传了个参数」，而在**同一个字段有两个生产者**：脚本按账本与模板生成一份，
 * 调用方又能塞一份进来，于是最终写进平台的到底是哪一份说不清——它显示的是「他说的」，
 * 不是「记录里的」。所以这里按子命令收窄注册，传了就按用法错误拒绝。
 */
const GENERATED_BODY_SUBCOMMANDS = new Set(['submit', 'rework'])
/** 只允许建单与评论写正文的子命令（那里的正文是内容本身）。 */
const CONTENT_BODY_SUBCOMMANDS = new Set(['issue', 'milestone', 'intake', 'next', 'claim', 'release'])

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-flow/scripts/flow.mjs <子命令> [选项]',
    '',
    '子命令（next/explore/claim/release/finalize/verify/submit/rework/sync/merge/cleanup/status/abort 支持自动推断 --task）：',
    '  inspect   [inputs...] [--probe-auth] [--external-pr <M>] [--json]',
    '  next      [--task <id>] [--ack-no-issue-context --reason "<原因>"] [--probe-auth] [--handoff] [--json]',
    '  explore   [--task <id>] [--focus <subdir>] [--tier <tier>] [--by <actor>] [--json]',
    '  intake    [--pr <M> | --issue <N>] [--decision <accept|reject|merge-duplicate|needs-info|defer>] [--rationale "<说明>" | --rationale-file <路径>] [--duplicate-of <N>] [--feature-ref <path>] [--apply | --dry-run] [--json]',
    '  start     [--task <id>] [--base <branch>] [--slug <slug>] [--case <1..5>] [--issue <N>] [--create-issue --title "<标题>"] [--after <parent>] [--files <a,b>] [--parallel] [--planning] [--external-pr <M>] [--clone-choice <c>] [--strict-deps] [--allow-plan-bootstrap] [--force] [--json]',
    '  issue     <create|list|view|comment|close|migrate> [--issue <N>] [--title "<标题>"] [--body "<内容>"] [--labels a,b] [--milestone <N|标题>] [--state open|closed|all] [--reason "<原因>"] [--json]',
    '  close     --issue <N> [--into <targetIssue>] --reason "<原因>" [--task <id>] [--json]',
    '  milestone <create|list|assign|close> [--milestone <N|标题|URL>] [--title "<标题>"] [--description "<描述>"] [--due <ISO>] [--issue <N>] [--pr <N>] [--task <id>] [--state open|closed|all] [--json]',
    '  claim     [--task <id>] [--issue <N>] [--agent <id>] [--takeover --reason "<原因>"] [--json]',
    '  release   [--task <id>] [--issue <N>] [--agent <id>] [--reason "<原因>"] [--json]',
    '  finalize  [--task <id>] [--note <text>] [--strict-sync] [--no-tdd] [--include-master-prd] [--skip-govern] [--json]',
    '  verify    [--task <id>] [--mode|--tier quick|smoke|full|gate] [--timeout <ms>] [--target <file>] [--cmd <custom>] [--e2e-evidence <text>] [--artifact <path>] [--visual-checked] [--visual-blocked-reason <text>] [--human-approved] [--skip-edit-gate] [--skip-govern] [--json]',
    '  submit    [--task <id>] [--agent <id>] [--host-mode <multi-agent|single-session>] [--single-session] [--human-approved] [--draft] [--new-pr] [--reset-review-slot] [--json]',
    '  rework    [--task <id>] [--rebut "<findingId>: <reason>"] [--json]',
    '  sync      [--task <id>] [--onto <branch>] [--probe-auth] [--json]',
    '  merge     [--task <id>] [--reviewer-id <id>] [--method merge|squash|rebase] [--human-approved] [--reason <text>] [--skip-govern] [--json]',
    '  cleanup   [--task <id>] [--preview-hash <hash>] [--confirm] [--only-review-worktree|--keep-worktree] [--keep-local-branch] [--keep-remote-branch] [--keep-branch] [--force] [--allow-outbound <路径>] [--skip-govern] [--json]',
    '  status    [--task <id>] [--all] [--json]',
    '  abort     [--task <id>] [--confirm] [--keep-branch] [--force] [--allow-outbound <路径>] [--json]',
    '  batch     <plan|check-disjoint|merge-queue|resume-session> [--tasks <a,b>] [--enqueue <id>] [--enqueue-only] [--trial-local] [--handoff] [--task <id>] [--json]',
  ].join('\n') + '\n')
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }

  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      booleanFlags: [
        'probe-auth', 'parallel', 'draft', 'confirm', 'force',
        'keep-branch', 'keep-worktree', 'only-review-worktree', 'keep-local-branch', 'keep-remote-branch',
        'human-approved', 'human-approved-exec', 'visual-checked', 'strict-sync', 'include-master-prd',
        'create-issue', 'takeover', 'reset-review-slot',
        'strict-deps', 'enqueue-only', 'new-pr', 'trial-local', 'handoff', 'no-tdd',
        'ack-no-issue-context', 'apply', 'dry-run', 'skip-edit-gate', 'skip-govern', 'strict-lifecycle', 'run-govern-hook',
        'allow-plan-bootstrap', 'planning', 'all', 'single-session',
      ],
      valueFlags: [
        'task', 'slug', 'case', 'files', 'external-pr', 'pr', 'issue', 'issues', 'base',
        'branch', 'clone-choice', 'fork-url', 'pr-ref', 'implementer', 'todo', 'spec', 'prd',
        'agent', 'actor', 'note', 'mode', 'tier', 'timeout', 'target', 'cmd', 'e2e-evidence', 'visual-evidence', 'title', 'body', 'comment', 'state',
        'labels', 'method', 'reason', 'into', 'after', 'onto', 'tasks', 'enqueue', 'action', 'focus', 'by',
        'milestone', 'due', 'due-on', 'description',
        'feature-ref', 'decision', 'rationale', 'rationale-file', 'duplicate-of',
        'visual-blocked-reason', 'host-mode', 'reviewer-id', 'preview-hash',
      ],
      multiFlags: ['rebut', 'allow-outbound', 'artifact'],
      usageHint: 'flow.mjs <inspect|next|explore|intake|start|issue|close|milestone|claim|release|finalize|verify|submit|rework|sync|merge|cleanup|status|abort|batch>',
    })
  } catch (err) {
    process.stderr.write(`flow 错误：${err.message}\n`)
    return 2
  }
  const { sub, opts } = cli
  if (cli.help) { printHelp(); return 0 }

  // 按子命令收窄：提审与返工分支的正文由脚本生成，不接受调用方传入。
  if (GENERATED_BODY_SUBCOMMANDS.has(sub) && (opts.body !== undefined || opts.comment !== undefined || opts.note !== undefined)) {
    process.stderr.write('BLOCKED_GENERATED_BODY_HAS_SINGLE_PRODUCER: submit/rework 的提案正文由账本、模板与实证记录确定性生成，'
      + '不接受 --body / --comment / --note。想改正文里的事实，就去改账本与实证记录本身；'
      + '想改标题，用 --title。\n')
    return EXIT.USAGE
  }
  if (!CONTENT_BODY_SUBCOMMANDS.has(sub) && !GENERATED_BODY_SUBCOMMANDS.has(sub) && opts.body !== undefined) {
    process.stderr.write(`BLOCKED_BODY_PARAM_ON_${String(sub ?? 'unknown').toUpperCase()}: 子命令 ${sub} 不写正文，不接受 --body。\n`)
    return EXIT.USAGE
  }

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
        process.stdout.write(`- 平台通道: provider=${data.github.providerId ?? data.identity?.providerId ?? 'none'}, TrackB=${data.github.trackB.tier}, https=${data.github.trackA.https}, ssh=${data.github.trackA.ssh}\n`)
        if (data.github.trackA.remediationCmd) process.stdout.write(`- 协议修复建议: ${data.github.trackA.remediationCmd}\n`)
        if (data.inputs.reuseExistingPr) process.stdout.write(`- 复用已有 PR: #${data.inputs.reuseExistingPr.prNumber} (${data.inputs.reuseExistingPr.note})\n`)
        if (data.inputs.issues.length > 1) process.stdout.write(`- 多 Issue 拓扑排序: ${data.inputs.issueGraph.orderedIssues.map((n) => `#${n}`).join(' -> ')}\n`)
        if ((data.inputs.milestones?.length ?? 0) > 0) process.stdout.write(`- 识别里程碑: ${data.inputs.milestones.map((m) => `#${m.number}`).join(', ')}\n`)
        for (const dw of data.driftWarnings ?? []) process.stdout.write(`- [提醒] ${dw.message}\n`)
        // 认不出来的输入不许静默丢弃：JSON 里有 `inputs.unknown`，正文这边也得说，
        // 否则不看 JSON 的人会以为「传了就用上了」。
        const unknownInputs = data.inputs?.unknown ?? []
        if (unknownInputs.length > 0) {
          process.stdout.write(`- 以下输入没被使用（认不出来）：${unknownInputs.join('、')}\n`)
          process.stdout.write('- 正确写法：https://<host>/<owner>/<repo>/issues/<N>（或 /pull/<M>）、#N、issue#N、pr#M\n')
        }
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
    if (sub === 'explore') {
      const { handleExplore } = await import('./flow-explore.mjs')
      return (await handleExplore(opts, roots)).exitCode
    }
    if (sub === 'intake') {
      const { handleIntake } = await import('./flow-intake.mjs')
      return (await handleIntake(opts, roots)).exitCode
    }
    if (sub === 'start') {
      const { handleStart } = await import('./flow-inspect.mjs')
      return (await handleStart(opts, roots)).exitCode
    }
    if (sub === 'issue') {
      const { handleIssue } = await import('./flow-issues.mjs')
      return (await handleIssue(opts, roots)).exitCode
    }
    if (sub === 'close') {
      const { handleClose } = await import('./flow-issues.mjs')
      return (await handleClose(opts, roots)).exitCode
    }
    if (sub === 'milestone') {
      const { handleMilestone } = await import('./flow-issues.mjs')
      return (await handleMilestone(opts, roots)).exitCode
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
