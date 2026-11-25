#!/usr/bin/env node
/**
 * doc-plan.mjs —— 五档需求分流、四层工程文档生成、规划自审净化、Critique、批准与归档取代。
 *
 * 子命令：
 *   next           [--file <docPath>] [--task <id>] [--plan-only] [--handoff] [--json]
 *   note           [--topic <id>] [--fact <k=v>...] [--resolve <q>...] [--drop <k>...] [--reset] [--decision <text>] [--exclude <t>...] [--anchor <p>...] [--open <q>...] [--json]
 *   triage         --summary <text> [--topic <id>] [--fact <k=v>...] [--resolve <q>...] [--drop <k>...] [--reset] [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]
 *   init           --kind prd|spec|todo|pair|all --slug <slug> --title <title> [--topic <id>] [--allow-open-draft] [--spec-slug <slug>] [--scope <p>...] [--criteria <c>...] [--depends-on <s...>] [--issue <N>] [--task <id>] [--spec <path>] [--force] [--json]
 *   slice          --prd <prdPath> --spec-slug <slug> --title <title> [--scope <p>...] [--criteria <c>...] [--depends-on <s...>] [--issue <N>] [--task <id>] [--topic <id>] [--allow-open-draft] [--worktree | --in-place] [--json]
 *   clarify        --file <docPath> [--decision <结论> | --drop-criterion <C条目> --reason <原因>] [--question <问题>] [--by <actor>] [--criterion <C条目>] [--json]
 *   link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <name>] [--owner <name> --owner-reason "<原因>"] [--status <s>] [--json]
 *   audit          [--file <docPath> | .] [--json]
 *   critique-scope    --file <docPath> [--reviewer <id>] [--round <n>] [--json]
 *   critique-pass     --file <docPath> --reviewer <id> [--round N] [--summary <text>] [--should-fix <t>...] [--resolved <id>...] [--rebut-accepted <id>...] [--json]
 *   critique-reject   --file <docPath> --reviewer <id> [--round N] [--summary <text>] [--findings <t>...] [--resolved <id>...] [--rebut-accepted <id>...] [--json]
 *   critique-continue --file <docPath> --reason <改进方向> [--by <actor>] [--task <id>] [--json]
 *   critique-override --file <docPath> --human-approved --reason <text> [--by <actor>] [--json]
 *   approve           --file <specPath> [--skip-critique-reason <text>] [--json]
 *   archive        [<slug-or-path>] [--task <id>] [--done-at YYYY-MM-DD] [--include-master-prd] [--drop --reason <原因>] [--json]
 *   supersede      <oldSpec> --by <newSpec> [--json]
 *   list           [--json]
 */

import { existsSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { buildContextBrief, extractDocPaths, formatContextBriefLines } from '../../lib/context-brief.mjs'
import { buildPlanHandoff, evaluatePlanNextState } from '../../lib/plan-next.mjs'
import { subcommandNamesFor } from '../../lib/subcommand-meta.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { resolveHostMode, resolveNonEmptyActor, validateDocOwnerValue } from '../../lib/harness-context.mjs'
import { appendPreInitNote, recordTriageDecision } from '../../lib/session-state.mjs'
import {
  archiveCompletedDocsGroup, DOC_FRONTMATTER_KEY_ORDER,
  docIsoDate, isApprovingStatusValue, parseDocFilename, parseDocFrontmatter,
  syncDocsLifecycle, updateDocFrontmatter,
} from '../../lib/docs.mjs'
import {
  gitStatusPorcelainZ, isMainModule,
  canonicalPath, posixPath, readTextSafe, resolveRepoRoots, sha256Text,
} from '../../lib/git.mjs'
import {
  buildCritiqueScope, collectExcludedReviewers, CRITIQUE_FINDINGS_KEY,
  critiqueContinueDoc, critiqueOverrideDoc, critiquePassDoc, critiqueRejectDoc,
  parseCritiqueRounds, readPlanCritiqueEntrySync,
} from '../../lib/critique-rounds.mjs'
import { resolveDocIssueNumber, syncPlanPhaseToBackend } from '../../lib/plan-sync.mjs'
import { renderVerificationForReviewer, verifyDocClaims } from '../../lib/doc-verify.mjs'
import {
  readTaskLedger, resolveTaskContext, sanitizeTaskId, updateTaskLedger,
} from '../../lib/ledger.mjs'
import { parseIssueNumbers, parsePrNumber } from '../../lib/platform.mjs'
import { auditDoc, auditRepoDocs, listDocs, stripCritiqueMeta, triageTask } from './doc-audit.mjs'
import { describeAuditNotApplicable } from './doc-audit-repo.mjs'
import { approveSpec, clarifyDoc, initDoc, sliceSpec, supersedeSpec } from './doc-plan-ops.mjs'
import {
  isValidPlanMode, normalizePlanMode, PLAN_MODES, resolveDocPlanMode,
} from '../../lib/pending-decisions.mjs'

export { auditDoc, auditRepoDocs, listDocs, stripCritiqueMeta, triageTask }

function isStandaloneWorkRoot(targetAbs, outerRoot) {
  if (!existsSync(targetAbs)) return false
  const target = canonicalPath(targetAbs)
  const outer = canonicalPath(outerRoot)
  if (target === outer) return false
  if (existsSync(join(target, '.git'))) return true
  return !target.startsWith(outer + sep) && !outer.startsWith(target + sep)
}

function parseIssueArg(rawIssue) {
  if (rawIssue === undefined || rawIssue === null || rawIssue === '') return null
  const nums = parseIssueNumbers(rawIssue, { strict: true })
  if (nums.length !== 1) throw new Error(`--issue 需要 1 个正整数 Issue 编号或 URL，收到：${rawIssue}`)
  return nums[0]
}

function resolveDocTaskId(repoRoot, file, explicitTask = null) {
  if (explicitTask && String(explicitTask).trim()) return String(explicitTask).trim()
  if (!file) return null
  const raw = readTextSafe(resolve(repoRoot, file))
  if (!raw) return null
  const tid = parseDocFrontmatter(raw)?.data?.task_id
  return tid && String(tid).trim() ? String(tid).trim() : null
}

function safeSyncPlan(payload) {
  return syncPlanPhaseToBackend(payload).catch((err) => ({
    ok: false, synced: false, status: 'SYNC_ERROR', error: err?.message ?? String(err),
  }))
}

/**
 * 校验 `--plan-mode`：显式给了就必须是合法枚举，没给则返回 null 交给下游按门型/档位推导。
 *
 * 非法值直接抛结构化错误而不是静默降级——静默降级会让人以为自己选了 interactive，
 * 实际跑的是 autonomous，逐题澄清那一步就这样悄悄消失了。
 */
function resolveCliPlanMode(raw) {
  if (raw === undefined || raw === null || raw === '') return null
  const norm = normalizePlanMode(raw)
  if (isValidPlanMode(norm)) return norm
  const err = new Error(`--plan-mode 仅支持 ${PLAN_MODES.join(' | ')}，收到：${raw}`)
  err.code = 'INVALID_PLAN_MODE'
  err.details = {
    allowed: [...PLAN_MODES],
    fixHint: '不可逆或跨契约的规划用 interactive（逐题确认到零待拍板），局部可逆的改动用 autonomous（默认推进，仅单向门 / Case 5 / 真业务歧义才停）。',
  }
  throw err
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-plan/scripts/doc-plan.mjs <子命令> [选项]',
    '',
    '子命令：',
    '  next               [--file <docPath>] [--task <id>] [--plan-only] [--handoff] [--json]',
    '  note               [--topic <主题>] [--fact <k=v>...] [--resolve <问题>...] [--drop <键或问题>...] [--reset] [--decision <结论>] [--exclude <不做项>...] [--anchor <锚点>...] [--open <问题>...] [--json]',
    '  triage             --summary <文本> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--plan-mode interactive | autonomous] [--topic <主题>] [--fact <k=v>...] [--resolve <问题>...] [--drop <键或问题>...] [--reset] [--decision <结论>] [--exclude <不做项>...] [--anchor <锚点>...] [--open <问题>...] [--json]',
    '  init               --kind <prd|spec|todo|pair|all> --slug <slug> --title <标题> [--topic <主题>] [--allow-open-draft] [--spec-slug <slug>] [--scope <路径>...] [--criteria <条款>...] [--depends-on <切片>...] [--issue <N>] [--task <id>] [--owner <name>] [--case <1..5>] [--multi-spec] [--agent <id>] [--host-mode <m>] [--single-session] [--human-approved] [--milestone <m>] [--prd <path>] [--spec <path>] [--plan-mode interactive | autonomous] [--worktree | --in-place] [--no-prune] [--json]',
    '  slice              --prd <prdPath> --spec-slug <slug> --title <标题> [--kind <spec|pair>] [--scope <路径>...] [--criteria <条款>...] [--depends-on <切片>...] [--issue <N>] [--task <id>] [--owner <name>] [--agent <id>] [--topic <主题>] [--allow-open-draft] [--worktree | --in-place] [--json]',
    '  clarify            --file <docPath> [--decision <结论> | --drop-criterion <C条目> --reason <原因>] [--question <问题>] [--by <actor>] [--criterion <C条目>] [--json]',
    '  link               <slug-or-path> [--issue <N>] [--pr <M>] [--branch <B>] [--owner <O> --owner-reason "<变更原因>"] [--status <S>] [--milestone <m>] [--json]',
    '  audit              [--file <docPath> | .] [--json]',
    '  critique-scope     --file <docPath> [--reviewer <id>] [--round <n>] [--run-commands] [--json]',
    '  critique-pass      --file <docPath> --reviewer <id> [--round <N>] [--summary <文本>] [--findings <t>...] [--should-fix <t>...] [--resolved <id>...] [--rebut-accepted <id>...] [--json]',
    '  critique-reject    --file <docPath> --reviewer <id> [--round <N>] [--summary <文本>] [--findings <t>...] [--resolved <id>...] [--rebut-accepted <id>...] [--json]',
    '  critique-continue  --file <docPath> --reason <改进方向> [--by <actor>] [--task <id>] [--json]',
    '  critique-override  --file <docPath> --human-approved --reason <原因> [--by <actor>] [--json]',
    '  approve            --file <specPath> [--skip-critique-reason <文本>] [--host-mode <m>] [--single-session] [--human-approved] [--json]',
    '  archive            [<slug-or-path>] [--task <id>] [--done-at <YYYY-MM-DD>] [--include-master-prd] [--drop --reason <原因>] [--json]',
    '  supersede          <oldSpec> --by <newSpec> [--json]',
    '  list               [--json]',
  ].join('\n') + '\n')
}

const SUBCOMMANDS = subcommandNamesFor('doc-plan')

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }

  let cli
  try {
    const normalizedArgv = argv[0] === 'archive'
      ? argv.map((a) => (a === '--drop' ? '--drop=true' : a))
      : argv
    cli = parseStandardCli(normalizedArgv, {
      subcommands: SUBCOMMANDS,
      booleanFlags: ['touches-contract', 'conflicts-tdd', 'doc-only', 'bugfix', 'force', 'approve', 'implemented', 'include-master-prd', 'no-prune', 'human-approved', 'worktree', 'in-place', 'multi-spec', 'single-session', 'handoff', 'plan-only', 'run-commands', 'reset', 'allow-open-draft'],
      valueFlags: ['summary', 'files', 'paths', 'kind', 'type', 'slug', 'spec-slug', 'title', 'issue', 'task', 'spec', 'prd', 'file', 'pr', 'branch', 'owner', 'owner-reason', 'status', 'done-at', 'reviewer', 'round', 'skip-critique-reason', 'by', 'question', 'decision', 'criterion', 'drop-criterion', 'reason', 'milestone', 'plan-mode', 'host-mode', 'case', 'agent', 'topic'],
      multiFlags: ['findings', 'finding', 'should-fix', 'resolved', 'rebut-accepted', 'exclude', 'anchor', 'open', 'fact', 'resolve', 'drop', 'scope', 'criteria', 'depends-on'],
      aliases: { type: 'kind' },
      usageHint: `doc-plan.mjs <${SUBCOMMANDS.join('|')}>`,
    })
  } catch (err) {
    process.stderr.write(`doc-plan 错误：${err.message}\n`)
    return 2
  }
  const { sub, opts } = cli
  if (cli.help) { printHelp(); return 0 }

  const roots = await resolveRepoRoots(cli.targetDir)
  const repoRoot = roots.isGit ? roots.workTreeRoot : roots.cwd
  const mainRoot = roots.isGit ? roots.mainRoot : roots.cwd

  try {
    if (sub === 'next') {
      const state = await evaluatePlanNextState({
        repoRoot,
        mainRoot,
        gitDir: roots.gitDir,
        isGit: roots.isGit,
        taskId: opts.task ?? null,
        file: opts.file ?? opts._[0] ?? null,
        planOnly: Boolean(opts['plan-only']),
        auditDocFn: auditDoc,
      })
      const payload = opts.handoff
        ? (() => {
            const h = buildPlanHandoff({ state, deliveryMode: state.deliveryMode })
            return { ...state, handoff: h.fields, handoffPrompt: h.prompt }
          })()
        : state
      if (cli.json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
      } else {
        process.stdout.write(`# doc-plan next (${payload.phase} | owner=${payload.ownerRole})\n`)
        if (payload.doc?.file) process.stdout.write(`- 文档: ${payload.doc.file} | worktree=${payload.interruptedWorktree?.worktreePath ?? 'in-place'}\n`)
        process.stdout.write(`- 下一步: ${payload.nextAction}\n`)
        if (payload.handoffPrompt) process.stdout.write(`\n${payload.handoffPrompt}`)
        printNextStep([{ skill: 'dev-plan', text: payload.command }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'note') {
      const hasNote = Boolean(
        opts.topic || opts.decision || opts.reset
        || (opts.fact?.length ?? 0) > 0 || (opts.resolve?.length ?? 0) > 0 || (opts.drop?.length ?? 0) > 0
        || (opts.exclude?.length ?? 0) > 0 || (opts.anchor?.length ?? 0) > 0 || (opts.open?.length ?? 0) > 0,
      )
      if (!hasNote) throw new Error('note 至少需要传入 --topic / --fact / --resolve / --drop / --reset / --decision / --exclude / --anchor / --open 之一')
      const noteRes = appendPreInitNote(mainRoot, {
        topic: opts.topic ?? null, facts: opts.fact ?? [], resolve: opts.resolve ?? [], drop: opts.drop ?? [], reset: Boolean(opts.reset),
        decision: opts.decision ?? null, exclusions: opts.exclude ?? [], anchors: opts.anchor ?? [], openQuestions: opts.open ?? [],
      })
      if (cli.json) process.stdout.write(`${JSON.stringify({ ok: true, ...noteRes }, null, 2)}\n`)
      else process.stdout.write(`已写入 Working Brief（topic=${noteRes.topicId}, ${noteRes.byteSize} B）：facts=${Object.keys(noteRes.preInit.facts ?? {}).length}, decisions=${noteRes.preInit.decisions.length}, nonGoals=${noteRes.preInit.nonGoals.length}, anchors=${noteRes.preInit.anchors.length}, open=${(noteRes.preInit.unresolvedOpen ?? noteRes.preInit.openQuestions).length}\n`)
      return 0
    }

    if (sub === 'triage') {
      const hasPreInitNote = Boolean(
        opts.topic || opts.decision || opts.reset
        || (opts.fact?.length ?? 0) > 0 || (opts.resolve?.length ?? 0) > 0 || (opts.drop?.length ?? 0) > 0
        || (opts.exclude?.length ?? 0) > 0 || (opts.anchor?.length ?? 0) > 0 || (opts.open?.length ?? 0) > 0,
      )
      const summary = opts.summary ?? opts._.join(' ')
      if (!summary && !hasPreInitNote) throw new Error('triage 需要传入 --summary "<需求描述>"')
      if (hasPreInitNote) {
        const noteRes = appendPreInitNote(mainRoot, {
          topic: opts.topic ?? (summary || null), facts: opts.fact ?? [], resolve: opts.resolve ?? [], drop: opts.drop ?? [], reset: Boolean(opts.reset),
          decision: opts.decision ?? null, exclusions: opts.exclude ?? [], anchors: opts.anchor ?? [], openQuestions: opts.open ?? [],
        })
        if (!summary) {
          if (cli.json) process.stdout.write(`${JSON.stringify({ ok: true, ...noteRes }, null, 2)}\n`)
          else process.stdout.write(`已写入 Working Brief（topic=${noteRes.topicId}, ${noteRes.byteSize} B）。\n`)
          return 0
        }
      }
      const rawFilesOpt = opts.files !== undefined ? String(opts.files).trim() : ''
      const isNumericFiles = rawFilesOpt !== '' && /^\d+$/.test(rawFilesOpt)
      const filesAsPaths = (rawFilesOpt !== '' && !isNumericFiles)
        ? rawFilesOpt.split(',').map((s) => s.trim()).filter(Boolean)
        : []
      let triagePaths = []
      if (opts.paths !== undefined) {
        triagePaths = String(opts.paths).split(',').map((s) => s.trim()).filter(Boolean)
        if (filesAsPaths.length > 0) triagePaths = [...new Set([...triagePaths, ...filesAsPaths])]
      } else if (filesAsPaths.length > 0) {
        triagePaths = filesAsPaths
      } else if (roots.isGit && !opts.topic) {
        triagePaths = (await gitStatusPorcelainZ(repoRoot)).entries.map((e) => e.file)
      }
      const filesNum = isNumericFiles ? Number(rawFilesOpt) : (filesAsPaths.length > 0 ? filesAsPaths.length : undefined)
      const explicitPlanMode = resolveCliPlanMode(opts['plan-mode'])
      const result = triageTask({
        summary, files: filesNum, touchesContract: Boolean(opts['touches-contract']),
        conflictsTdd: Boolean(opts['conflicts-tdd']), docOnly: Boolean(opts['doc-only']),
        bugfix: Boolean(opts.bugfix), paths: triagePaths, repoRoot,
      })
      // 规划态跟着分流结论走：门型与档位是已经判出来的事实，拿它们推默认值，
      // 人就不用为了「这算不算不可逆」再猜一遍。
      result.planMode = resolveDocPlanMode({
        kind: result.docsRequired?.includes('docs/specs/') ? 'spec' : (result.docsRequired?.length ? 'todo' : null),
        caseType: result.caseType,
        doorType: result.doorType,
        explicit: explicitPlanMode,
      })
      try {
        recordTriageDecision(mainRoot, {
          caseType: result.caseType,
          summary,
          paths: triagePaths,
          doorType: result.doorType,
          planMode: result.planMode,
          topic: opts.topic ?? null,
        })
      } catch { /* non-fatal on non-writable root */ }
      if (cli.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else {
        process.stdout.write(`分流结论：Case ${result.caseType} (${result.action})${result.blocked ? ' [BLOCKED]' : ''}\n`)
        process.stdout.write(`- 门型: ${result.doorType} | 规划内审档位: ${result.critiqueTier} | 规划态: ${result.planMode}\n- 理由: ${result.reason}\n`)
        process.stdout.write(`- 必建文档: ${result.docsRequired.join(', ') || '无 (0 文档)'}\n`)
        process.stdout.write(`- Red-Green 回归测试: ${result.redGreenRequired ? '强制' : '不需要'} | 独立审查: ${result.needsReview ? '需要' : '低风险免除'}\n`)
        for (const w of result.coupledSyncWarnings ?? []) {
          process.stdout.write(`  * 联动提醒: 触及 ${w.touchedTriggers.join(', ')} -> 检查同步 ${w.expectedCompanions.join(', ')}\n`)
        }
        const briefLines = formatContextBriefLines(result.contextBrief)
        if (briefLines.length > 0) process.stdout.write(`${briefLines.join('\n')}\n`)
        const steps = result.caseType === 5
          ? ['已阻断直接拆解！请先更新 docs/TDD.md 解决冲突并经独立确认。']
          : result.caseType === 4
            ? [{
                skill: 'dev-plan',
                text: result.prdRequired
                  ? '创建 PRD+SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind all --slug <slug> --title "<标题>"'
                  : '创建 SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind pair --slug <slug> --title "<标题>"',
              }]
            : result.caseType === 3
              ? [{ skill: 'dev-flow', text: '启动任务隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 3 --slug <slug>' }]
              : [{ skill: 'dev-flow', text: `启动任务流转：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case ${result.caseType} --slug <slug>` }]
        printNextStep(steps, { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'init' || sub === 'slice') {
      const effectiveKind = sub === 'slice' ? (opts.kind || 'spec') : opts.kind
      const effectiveSlug = opts['spec-slug'] ?? opts.slug
      if (sub === 'init' && (!effectiveKind || !effectiveSlug || !opts.title)) throw new Error('init 需要 --kind <prd|spec|todo|pair|all>、--slug <slug> 与 --title <title>')
      if (sub === 'slice' && (!opts.prd || !effectiveSlug || !opts.title)) throw new Error('slice 需要 --prd <prdPath>、--spec-slug <slug> 与 --title <title>')
      let resolvedOwner = opts.owner
      if (String(effectiveKind).toLowerCase() !== 'tdd') {
        if (opts.owner !== undefined) {
          const chk = validateDocOwnerValue(opts.owner)
          if (!chk.ok) throw Object.assign(new Error(chk.reason), { code: chk.code, exitCode: chk.exitCode })
          resolvedOwner = chk.owner
        } else {
          const hostMode = resolveHostMode(opts)
          const actorRes = resolveNonEmptyActor([opts.agent], { role: 'doc-owner', hostMode, humanApproved: Boolean(opts['human-approved']), allowSingleSessionWaive: true })
          if (!actorRes.ok) throw Object.assign(new Error(actorRes.reason), { code: 'INVALID_OWNER', exitCode: EXIT.USAGE })
          resolvedOwner = actorRes.actor
        }
      }
      const initPayload = {
        repoRoot, mainRoot, gitDir: roots.gitDir, isGit: roots.isGit,
        kind: effectiveKind, slug: effectiveSlug, specSlug: opts['spec-slug'] ?? null, title: opts.title, taskId: opts.task,
        issue: opts.issue, owner: resolvedOwner, branch: opts.branch, relatedSpec: opts.spec,
        relatedPrd: opts.prd, milestone: opts.milestone, force: Boolean(opts.force), noPrune: Boolean(opts['no-prune']),
        planMode: resolveCliPlanMode(opts['plan-mode']), worktree: Boolean(opts.worktree), inPlace: Boolean(opts['in-place']),
        multiSpec: Boolean(opts['multi-spec']), caseType: opts.case !== undefined ? Number(opts.case) : null,
        topic: opts.topic ?? null, allowOpenDraft: Boolean(opts['allow-open-draft']),
        scopePaths: opts.scope ?? [], criteria: opts.criteria ?? [], dependsOn: opts['depends-on'] ?? [],
      }
      const res = sub === 'slice' ? await sliceSpec({ ...initPayload, prd: opts.prd }) : await initDoc(initPayload)
      res.planSync = await safeSyncPlan({
        repoRoot: res.writeRoot ?? repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'init', file: res.file, files: res.files, taskId: res.taskId ?? opts.task ?? null,
        issueNumber: res.issue ?? null, summary: `初始化 ${res.kind.toUpperCase()}: ${opts.title}`,
      })
      res.contextBrief = buildContextBrief(res.writeRoot ?? repoRoot, {
        paths: opts.spec ? [opts.spec] : [], keywords: [opts.title, effectiveSlug, opts.task].filter(Boolean), excludeFiles: res.files ?? [],
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`已生成 ${res.kind.toUpperCase()}：${res.files.join(', ')}（Planned at: ${res.plannedAt}${res.worktreePath ? `, worktree=${res.worktreePath}` : ''}）\n`)
        const briefLines = formatContextBriefLines(res.contextBrief)
        if (briefLines.length > 0) process.stdout.write(`${briefLines.join('\n')}\n`)
        printNextStep([{ skill: 'dev-plan', text: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${res.file}"` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'clarify') {
      if (!opts.file || (!opts.decision && !opts['drop-criterion'])) {
        throw new Error('clarify 需要 --file <docPath> 与 --decision "<已确认结论>"（或 --drop-criterion C<N> --reason "<原因>" --by user）')
      }
      const res = clarifyDoc({
        repoRoot, file: opts.file, question: opts.question ?? '',
        decision: opts.decision ?? '', by: opts.by ?? 'user', explicitBy: opts.by,
        criterion: opts.criterion ?? '', dropCriterion: opts['drop-criterion'] ?? '', reason: opts.reason ?? '',
      })
      res.planSync = await safeSyncPlan({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'clarify', file: res.file, actor: opts.by ?? 'user',
        reason: res.droppedCriterion ? `作废 ${res.droppedCriterion.id}: ${res.droppedCriterion.reason}` : (opts.question ? `${opts.question} -> ${opts.decision}` : opts.decision),
        summary: res.entry + (res.addedCriterion ? `（新增 ${res.addedCriterion.id}）` : ''),
        taskId: resolveDocTaskId(repoRoot, res.file, opts.task ?? null),
        issueNumber: resolveDocIssueNumber(repoRoot, res.file, opts.issue ?? null),
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`已写入澄清记录到 ${res.file}：${res.entry}${res.addedCriterion ? `（新增 ${res.addedCriterion.id}）` : ''}\n`)
      return 0
    }

    if (sub === 'link') {
      const target = opts._[0] ?? opts.file ?? opts.slug
      if (!target) throw new Error('link 需要传入 <slug-or-path>（如 261115-my-feature 或 docs/specs/...）')
      const prVal = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : undefined
      // 生命周期同步不得写入批准：批准只由 `approve` 一个入口写，它同时核对依据。
      // 这里把状态改成已批准，等于绕过整条依据校验——文档会带着「已批准」却没有任何凭据。
      if (opts.approve) {
        throw Object.assign(
          new Error('BLOCKED_APPROVAL_HAS_SINGLE_ENTRY: link 不接受 --approve。批准只能由唯一入口写入，它会在写入前核对依据：'
            + 'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "<文档>"'),
          { code: 'BLOCKED_APPROVAL_HAS_SINGLE_ENTRY', exitCode: EXIT.USAGE },
        )
      }
      if (opts.status !== undefined && isApprovingStatusValue(opts.status)) {
        throw Object.assign(
          new Error(`BLOCKED_APPROVAL_HAS_SINGLE_ENTRY: link --status ${opts.status} 是批准档位，不能由生命周期同步写入。`
            + '请改用唯一入口：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "<文档>"'),
          { code: 'BLOCKED_APPROVAL_HAS_SINGLE_ENTRY', exitCode: EXIT.USAGE },
        )
      }
      const res = await syncDocsLifecycle(repoRoot, {
        slugOrPath: target, issue: opts.issue !== undefined ? parseIssueArg(opts.issue) : undefined, pr: prVal,
        branch: opts.branch, owner: opts.owner, ownerReason: opts['owner-reason'], status: opts.status,
        implemented: opts.implemented ? true : undefined, doneAt: opts['done-at'],
      })
      if (opts.milestone) {
        const msTarget = res.byKind?.spec ?? res.byKind?.prd ?? res.byKind?.todo ?? target
        const absTarget = resolve(repoRoot, msTarget)
        if (existsSync(absTarget)) {
          const fmMs = parseDocFrontmatter(readTextSafe(absTarget) ?? '')
          if (fmMs.hasFrontmatter) updateDocFrontmatter(absTarget, { milestone: opts.milestone, updated: docIsoDate() }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fmMs.data.kind ?? 'spec'] ?? [] })
        }
        if (opts.task) {
          await updateTaskLedger(mainRoot, sanitizeTaskId(opts.task), { milestone: opts.milestone })
        }
      }
      if (opts.issue !== undefined && res.issue) {
        const linkedFiles = [...new Set([
          res.byKind?.prd, res.byKind?.spec, res.byKind?.todo,
          ...(res.updated ?? []).map((u) => (typeof u === 'string' ? u : u?.file)),
          ...((res.renamed ?? []).map((r) => r.to)),
        ].filter((p) => typeof p === 'string' && p.trim()))]
        const primaryFile = res.byKind?.spec ?? res.byKind?.todo ?? res.byKind?.prd ?? linkedFiles[0] ?? target
        if (linkedFiles.length > 0) {
          res.planSync = await safeSyncPlan({
            repoRoot, mainRoot, gitDir: roots.gitDir,
            phase: 'plan-backfill', file: primaryFile, files: linkedFiles,
            taskId: resolveDocTaskId(repoRoot, primaryFile, opts.task ?? null),
            issueNumber: res.issue,
            reason: `后绑定 Issue #${res.issue}，回补既有规划状态摘要`,
          })
        }
      }
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`文档生命周期同步完成（issue=${res.issue ?? '无'}，重命名 ${res.renamed.length} 个，更新 ${res.updated.length} 个）\n`)
      return 0
    }

    if (sub === 'audit') {
      const target = opts.file ?? opts._[0] ?? '.'
      const targetAbs = resolve(repoRoot, target)
      const isDirScope = target === '.' || (existsSync(targetAbs) && statSync(targetAbs).isDirectory())
      if (isDirScope) {
        // 跨路径审计：目标目录自身是仓库根或 worktree 根时，以它作为审计根。
        //
        // 否则 `relative(repoRoot, 目标)` 会算出 `../...` 这种仓外相对路径，
        // 扫不到任何文档，于是返回 `auditedCount: 0, ok: true`——**一份都没查，却报全部通过**。
        // 这种假绿比报错危险得多：它让人以为审过了。
        const innerRoot = isStandaloneWorkRoot(targetAbs, repoRoot) ? targetAbs : null
        const auditRoot = innerRoot ?? repoRoot
        const auditScope = innerRoot ? '.' : target
        const batch = auditRepoDocs(auditRoot, auditScope)
        if (cli.json) process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`)
        else {
          // 零目标不折成通过：一份都没查却报「全部通过」，读的人会以为审过了。
          const headline = batch.applicable
            ? `${batch.ok ? '全部通过' : `${batch.failedCount} 份失败`}`
            : describeAuditNotApplicable(batch.auditOutcome, { scope: batch.scope, preservedCount: batch.preservedCount })
          process.stdout.write(`仓库工程文档审计（${batch.scope}，共 ${batch.auditedCount} 份）：${headline}\n`)
          for (const r of batch.results) {
            process.stdout.write(`- ${r.file} (${r.docType}): ${r.ok ? '通过' : `失败 (${r.errors.length})`}\n`)
            for (const e of r.errors) process.stdout.write(`  * [${e.code}] L${e.line}: ${e.message}\n    修法: ${e.fixHint}\n`)
          }
          for (const e of batch.coverageErrors ?? []) {
            process.stdout.write(`- ${e.file}：${e.message}\n`)
          }
        }
        return batch.ok && batch.applicable ? 0 : 1
      }
      const res = auditDoc({ repoRoot, file: target })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`文档审计（${res.file}，type=${res.docType}）：${res.ok ? '通过' : `失败（${res.errors.length} 项错误）`}\n`)
        for (const e of res.errors) process.stdout.write(`- [${e.code}] L${e.line}: ${e.message}\n  修法: ${e.fixHint}\n`)
        if (res.ok) {
          const docText = readTextSafe(resolve(repoRoot, res.file)) ?? ''
          const fm = parseDocFrontmatter(docText)
          const fn = parseDocFilename(res.file)
          const slugVal = fn?.slug ?? 'task'
          const statusLow = String(fm.data?.status ?? '').toLowerCase()
          const isTerminalDoc = ['done', 'archived', 'superseded', 'dropped', 'implemented'].includes(statusLow)
            || posixPath(res.file).startsWith('docs/archive/')
          if (isTerminalDoc) {
            // 已归档或终态文档不再引导新建隔离实施，避免对历史产物误导开工
          } else if (res.docType === 'prd' && !['active', 'done', 'dropped'].includes(statusLow)) {
            printNextStep([
              { skill: 'dev-plan', text: `1. 先派发独立只读 Critic 运行范围核查：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-scope --file "${res.file}" --reviewer <criticId> --round 1` },
              { skill: 'dev-plan', text: `2. PRD 须经独立只读 Plan Critique 后执行【须派发独立只读子代理/新会话，严禁在当前实现/规划上下文自跑】：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` },
            ], { repoRoot: mainRoot })
          } else if (res.docType === 'tdd') {
            printNextStep([
              { skill: 'dev-plan', text: `1. 先派发独立只读 Critic 运行范围核查：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-scope --file "${res.file}" --reviewer <criticId> --round 1` },
              { skill: 'dev-plan', text: `2. TDD 架构基线须经独立架构 Critique 确认与 AGENTS.md 模块边界、arch-rules 对齐【须派发独立只读子代理/新会话，严禁在当前实现/规划上下文自跑】：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` },
            ], { repoRoot: mainRoot })
          } else if (res.docType === 'todo' && !fm.data?.related_spec) {
            printNextStep([
              { skill: 'dev-flow', text: `Todo 自审通过（Case 3 自检直通，Critique 仅建议不强制），移交 dev-flow 启动隔离实施【须派发独立实施子代理/新会话认领实施，严禁规划作者在当前上下文自建自改】：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case 3 --todo "${res.file}"` },
            ], { repoRoot: mainRoot })
          } else if (res.docType === 'todo') {
            printNextStep([
              { skill: 'dev-flow', text: `Todo 自审通过（关联 SPEC 走 Case 4 审批流），移交 dev-flow 启动隔离实施：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case 4 --spec "${fm.data.related_spec}" --todo "${res.file}"` },
            ], { repoRoot: mainRoot })
          } else if (res.docType === 'spec' && statusLow !== 'approved') {
            printNextStep([{ skill: 'dev-plan', text: `先由独立只读 Critic 运行 critique-scope：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-scope --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
            printNextStep([{ skill: 'dev-plan', text: `独立只读 Critique 通过后执行【须派发独立只读子代理/新会话，严禁在当前实现/规划上下文自跑】：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
          }
        }
      }
      return res.ok ? 0 : 1
    }

    if (sub === 'critique-scope') {
      // 这一轮该看什么：把上轮意见与正文指纹摆出来。
      //
      // 代码审查早有增量视野硬锁，规划审核此前没有：Round 2 要么重读全文（吃光上下文），
      // 要么只看改动（新问题一条看不到）。两头都不对，根子是没有东西告诉它这一轮的范围。
      if (!opts.file) throw new Error('critique-scope 需要 --file <docPath>')
      const scopeAbs = resolve(repoRoot, opts.file)
      if (!existsSync(scopeAbs)) throw new Error(`找不到文档：${opts.file}`)
      const scopeText = readTextSafe(scopeAbs) ?? ''
      const scopeFm = parseDocFrontmatter(scopeText)
      const scopeRel = posixPath(relative(repoRoot, scopeAbs))
      const curSha = sha256Text(stripCritiqueMeta(scopeText)).slice(0, 12)
      const { entry: ledgerEntry } = readPlanCritiqueEntrySync({
        repoRoot, mainRoot, gitDir: roots.gitDir, taskId: opts.task ?? null, fmData: scopeFm.data, relDoc: scopeRel,
      })
      const priorRounds = parseCritiqueRounds(scopeFm.data, scopeText, ledgerEntry)
      const prevSha = /\bsha=([a-f0-9]{8,64})\b/i.exec(String(scopeFm.data?.plan_critique ?? ''))?.[1]
        ?? priorRounds.at(-1)?.artifact_baseline?.shortSha
        ?? priorRounds.at(-1)?.sha
        ?? null
      const excludedReviewers = collectExcludedReviewers(priorRounds, scopeFm.data?.owner)
      const roundNum = Number(opts.round ?? (priorRounds.reduce((m, r) => Math.max(m, Number(r.round) || 0), 0) + 1))
      const scope = buildCritiqueScope({
        round: roundNum,
        currentSha: curSha,
        previousSha: prevSha,
        findings: ledgerEntry?.findings ?? [],
        findingsRaw: scopeFm.data?.[CRITIQUE_FINDINGS_KEY] ?? '',
        priorRounds,
        override: ledgerEntry?.override ?? null,
        continued: ledgerEntry?.continued ?? null,
        reviewer: opts.reviewer ?? '(未指定)',
      })
      const contextBrief = buildContextBrief(repoRoot, {
        paths: extractDocPaths(scopeText),
        keywords: [scopeFm.data?.title, opts.task].filter(Boolean),
        excludeFiles: [scopeRel, 'AGENTS.md'],
      })
      const facts = await verifyDocClaims(repoRoot, scopeText, { runCommands: Boolean(opts['run-commands']) })
      const factsText = renderVerificationForReviewer(facts)
      if (cli.json) {
        process.stdout.write(`${JSON.stringify({
          file: opts.file, currentSha: curSha, round: roundNum, excludedReviewers,
          priorRoundCount: priorRounds.length, ...scope, contextBrief, facts, factsText,
        }, null, 2)}\n`)
      } else {
        const exclNote = excludedReviewers.length > 0 ? `\n> 排除复核人（禁止复用）：${excludedReviewers.join(', ')}\n` : ''
        const briefLines = formatContextBriefLines(contextBrief)
        const briefBlock = briefLines.length > 0 ? `\n${briefLines.join('\n')}\n` : ''
        process.stdout.write(`${factsText}${briefBlock}${exclNote}\n${scope.prompt}`)
      }
      return 0
    }

    if (sub === 'critique-pass') {
      if (!opts.file || !opts.reviewer) throw new Error('critique-pass 需要 --file <docPath> 与 --reviewer <reviewerId>')
      const findingArg = opts.findings ?? opts.finding ?? []
      const res = await critiquePassDoc({
        repoRoot, mainRoot, gitDir: roots.gitDir, isGit: roots.isGit,
        file: opts.file, reviewer: opts.reviewer, round: opts.round ?? null,
        summary: opts.summary ?? '', findings: Array.isArray(findingArg) ? findingArg : [findingArg],
        shouldFix: opts['should-fix'] ?? [], resolved: opts.resolved ?? [], rebutAccepted: opts['rebut-accepted'] ?? [],
        auditDoc, docType: null, taskId: opts.task ?? null,
      })
      res.planSync = await syncPlanPhaseToBackend({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'critique-pass', file: res.file, round: res.round, sha: res.sha,
        actor: res.reviewer, summary: res.summary ?? '', taskId: opts.task ?? null,
        issueNumber: resolveDocIssueNumber(repoRoot, res.file, opts.issue ?? null),
      }).catch((err) => ({ ok: false, synced: false, status: 'SYNC_ERROR', error: err?.message ?? String(err) }))
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`Critique 通过记录已写入 ${res.file}（reviewer=${res.reviewer}, round=${res.round}, sha=${res.sha}）\n`)
        const passNext = `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${res.file}"`
        printNextStep([{ skill: 'dev-plan', text: passNext }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'critique-reject') {
      if (!opts.file || !opts.reviewer) throw new Error('critique-reject 需要 --file <docPath> 与 --reviewer <reviewerId>')
      const findingArg = opts.findings ?? opts.finding ?? []
      const res = await critiqueRejectDoc({
        repoRoot, mainRoot, gitDir: roots.gitDir, isGit: roots.isGit,
        file: opts.file, reviewer: opts.reviewer, round: opts.round ?? null,
        summary: opts.summary ?? '', findings: Array.isArray(findingArg) ? findingArg : [findingArg],
        resolved: opts.resolved ?? [], rebutAccepted: opts['rebut-accepted'] ?? [], auditDoc,
        taskId: opts.task ?? null,
      })
      res.planSync = await syncPlanPhaseToBackend({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: res.stopLossTriggered ? 'stop-loss' : 'critique-reject',
        file: res.file, round: res.round, sha: res.sha, actor: res.reviewer,
        summary: res.summary || res.findings?.[0] || '', taskId: opts.task ?? null,
        issueNumber: resolveDocIssueNumber(repoRoot, res.file, opts.issue ?? null),
      }).catch((err) => ({ ok: false, synced: false, status: 'SYNC_ERROR', error: err?.message ?? String(err) }))
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`${res.status}: ${res.file}（reviewer=${res.reviewer}, round=${res.round}, sha=${res.sha}）\n`)
        if (res.stopLossTriggered) process.stderr.write(`STOP_LOSS_ESCALATE: ${res.stopLossPacket?.reasons?.join('; ') || '3-round plan stop-loss triggered'} (exit 4)\n`)
        printNextStep([{ skill: 'dev-plan', text: res.nextStep }], { repoRoot: mainRoot })
      }
      if (res.stopLossTriggered && cli.json) process.stderr.write(`STOP_LOSS_ESCALATE: exit 4\n`)
      return res.exitCode ?? 0
    }

    if (sub === 'critique-continue') {
      if (!opts.file) throw new Error('critique-continue 需要 --file <docPath>')
      const res = await critiqueContinueDoc({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        file: opts.file, reason: opts.reason ?? '',
        by: opts.by ?? opts.reviewer ?? 'human-maintainer',
        taskId: opts.task ?? null,
      })
      res.planSync = await safeSyncPlan({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'critique-continue', file: res.file, sha: res.sha,
        actor: res.continued?.by, reason: res.continued?.reason,
        summary: `停损后继续规划复核：${res.continued?.reason ?? ''}`,
        taskId: resolveDocTaskId(repoRoot, res.file, opts.task ?? null),
        issueNumber: resolveDocIssueNumber(repoRoot, res.file, opts.issue ?? null),
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`${res.status}: ${res.file}（sha=${res.sha}, reason=${res.continued.reason}, unlockApprove=false）\n`)
        printNextStep([{ skill: 'dev-plan', text: res.nextStep }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'critique-override') {
      if (!opts.file) throw new Error('critique-override 需要 --file <docPath>')
      const res = await critiqueOverrideDoc({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        file: opts.file, humanApproved: Boolean(opts['human-approved']),
        reason: opts.reason ?? '', by: opts.by ?? opts.reviewer ?? 'human-maintainer',
        taskId: opts.task ?? null,
      })
      res.planSync = await safeSyncPlan({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'critique-override', file: res.file, sha: res.sha,
        actor: res.override?.by, reason: res.override?.reason,
        summary: `人类裁决解锁规划批准：${res.override?.reason ?? ''}`,
        taskId: resolveDocTaskId(repoRoot, res.file, opts.task ?? null),
        issueNumber: resolveDocIssueNumber(repoRoot, res.file, opts.issue ?? null),
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`${res.status}: ${res.file}（sha=${res.sha}, reason=${res.override.reason}）\n`)
        printNextStep([{ skill: 'dev-plan', text: res.nextStep }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'approve') {
      if (!opts.file) throw new Error('approve 需要 --file <specPath>')
      const res = approveSpec({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        file: opts.file, skipCritiqueReason: opts['skip-critique-reason'], taskId: opts.task ?? null,
        hostMode: resolveHostMode(opts), humanApproved: Boolean(opts['human-approved']),
      })
      const fm = parseDocFrontmatter(readTextSafe(resolve(repoRoot, res.file)) ?? '')
      const taskKey = opts.task ?? fm.data?.task_id
      if (taskKey && res.criteriaFingerprint) {
        const sanitizedId = sanitizeTaskId(taskKey)
        if (readTaskLedger(mainRoot, sanitizedId)) {
          await updateTaskLedger(mainRoot, sanitizedId, {
            criteriaFingerprint: res.criteriaFingerprint,
            criteriaFrozenFrom: res.file,
            criteriaFrozenAt: docIsoDate(),
          })
        }
      }
      const fn = parseDocFilename(res.file)
      const slugVal = fn?.slug ?? 'task'
      const issueNum = resolveDocIssueNumber(repoRoot, res.file, opts.issue ?? null)
      res.planSync = await syncPlanPhaseToBackend({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'approve', file: res.file, taskId: taskKey ?? null,
        issueNumber: issueNum, summary: `已批准 ${res.file}（C1..Cn=${res.criteriaCount}）`,
      }).catch((err) => ({ ok: false, synced: false, status: 'SYNC_ERROR', error: err?.message ?? String(err) }))
      const startHint = `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case ${fm.data?.kind === 'todo' ? 3 : 4}${issueNum ? ` --issue ${issueNum}` : ' [--issue <N> | --create-issue --title "<标题>"]'}`
      if (res.status === 'approved' || res.status === 'active') res.nextStep = startHint
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`文档已切换为 ${res.status}：${res.file}（原状态：${res.previousStatus}）\n`)
        if (res.activatedTodos?.length > 0) process.stdout.write(`已联动激活配套 Todo：${res.activatedTodos.join(', ')}\n`)
        if (res.warning) process.stdout.write(`提示：${res.warning}\n`)
        if (res.nextStep) printNextStep([{ skill: 'dev-flow', text: `规划已批准，移交 dev-flow 启动隔离工作区【须派发独立实施子代理/新会话认领实施，严禁规划作者在当前上下文自建自改】：${startHint}` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'archive') {
      let targetSlugOrPath = opts._[0] ?? opts.file ?? opts.slug
      let taskLedger = null
      if (!targetSlugOrPath && (opts.task || existsSync(join(mainRoot, '.worktrees', '.state', 'tasks')))) {
        const ctx = await resolveTaskContext(roots, opts, { requireExisting: Boolean(opts.task) })
        taskLedger = ctx.ledger
        targetSlugOrPath = taskLedger?.specFile ?? taskLedger?.todoFile ?? taskLedger?.prdFile ?? taskLedger?.slug
      }
      if (!targetSlugOrPath) throw new Error('archive 需要传入 <slug-or-path> 或 --task <id>')
      const archiveRoot = (taskLedger?.worktreePath && existsSync(join(mainRoot, taskLedger.worktreePath)))
        ? join(mainRoot, taskLedger.worktreePath)
        : repoRoot
      const archiveDrop = (opts.drop?.length ?? 0) > 0
      if (archiveDrop && (!opts.reason || !String(opts.reason).trim())) {
        throw Object.assign(new Error('MISSING_DROP_REASON: archive --drop 必须附带 --reason "<作废原因>"'), { code: 'MISSING_DROP_REASON', exitCode: EXIT.USAGE })
      }
      const res = await archiveCompletedDocsGroup(archiveRoot, {
        prdFile: taskLedger?.prdFile, specFile: taskLedger?.specFile, todoFile: taskLedger?.todoFile,
        slugOrPath: targetSlugOrPath, issue: taskLedger?.linkedIssues?.[0], pr: taskLedger?.prNumber,
        branch: taskLedger?.branch, owner: taskLedger?.implementerId, doneAt: opts['done-at'],
        includeMasterPrd: Boolean(opts['include-master-prd']),
        drop: archiveDrop,
        dropReason: opts.reason ?? '',
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`成对归档完成（移动 ${res.moved.length} 份，更新互链 ${res.updated.length} 份）：${res.archived.join(', ')}\n`)
      return 0
    }

    if (sub === 'supersede') {
      const oldSpec = opts._[0] ?? opts.file
      const newSpec = opts.by
      const res = supersedeSpec({ repoRoot, oldSpecPath: oldSpec, newSpecPath: newSpec })
      const superFiles = [res.oldSpec, res.newSpec].filter(Boolean)
      const superTaskId = resolveDocTaskId(repoRoot, res.newSpec, opts.task ?? null)
        ?? resolveDocTaskId(repoRoot, res.oldSpec, null)
      const superIssue = resolveDocIssueNumber(repoRoot, res.newSpec, opts.issue ?? null)
        ?? resolveDocIssueNumber(repoRoot, res.oldSpec, null)
      res.planSync = await safeSyncPlan({
        repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'supersede', file: res.oldSpec, files: superFiles,
        reason: `被 ${res.newSpec} 取代`,
        summary: `旧规范 \`${res.oldSpec}\` 已标记为 \`superseded\`，由 \`${res.newSpec}\` 接替`,
        taskId: superTaskId,
        issueNumber: superIssue,
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`已标记取代关系：${res.oldSpec} -> superseded（by ${res.newSpec}）\n`)
      return 0
    }

    if (sub === 'list') {
      const data = listDocs(repoRoot)
      if (cli.json) process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      else {
        process.stdout.write('# 工程文档全景（实时扫描）\n')
        process.stdout.write(`- docs/TDD.md: ${data.tdd ? data.tdd.title : '缺失'}\n`)
        for (const [label, items] of [['PRD', data.prds], ['SPEC', data.specs], ['Todo', data.todos], ['Archive', data.archived]]) {
          process.stdout.write(`\n## ${label} (${items.length})\n`)
          for (const it of items) process.stdout.write(`- ${it.file}: ${it.title}${it.status ? ` status=${it.status}` : ''}\n`)
        }
      }
      return 0
    }

    throw new Error(`未知子命令：${sub}`)
  } catch (err) {
    const code = Number(err?.exitCode) || 1
    if (cli.json) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        ...(err?.code ? { code: err.code } : {}),
        exitCode: code,
        ...(err?.details ?? {}),
        ...(err?.audit ? { audit: err.audit } : {}),
        error: err instanceof Error ? err.message : String(err),
      }, null, 2)}\n`)
    }
    process.stderr.write(`doc-plan 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return code
  }
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`doc-plan 错误：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
