#!/usr/bin/env node
/**
 * doc-plan.mjs —— 五档需求分流、四层工程文档生成、规划自审净化、Critique、批准与归档取代。
 *
 * 子命令：
 *   triage         --summary <text> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]
 *   init           --kind prd|spec|todo|pair|all --slug <slug> --title <title> [--issue <N>] [--task <id>] [--spec <path>] [--force] [--json]
 *   link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <name>] [--owner <name> --owner-reason "<原因>"] [--status <s>] [--json]
 *   audit          [--file <docPath> | .] [--json]
 *   critique-pass     --file <docPath> --reviewer <id> [--round N] [--summary <text>] [--json]
 *   critique-reject   --file <docPath> --reviewer <id> [--round N] [--summary <text>] [--findings <t>...] [--json]
 *   critique-override --file <docPath> --human-approved --reason <text> [--by <actor>] [--json]
 *   approve           --file <specPath> [--skip-critique-reason <text>] [--json]
 *   archive        [<slug-or-path>] [--task <id>] [--done-at YYYY-MM-DD] [--include-master-prd] [--json]
 *   supersede      <oldSpec> --by <newSpec> [--json]
 *   list           [--json]
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { flushAndExit, parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import {
  archiveCompletedDocsGroup, buildDocFilename, DOC_FRONTMATTER_KEY_ORDER,
  docDateTag, docIsoDate, isApprovingStatusValue, parseDocFilename, parseDocFrontmatter,
  renderStandardDocTemplate, resolveRepoCustomDocTemplate, slugify, syncDocsLifecycle, updateDocFrontmatter,
} from '../../lib/docs.mjs'
import {
  ensureWorktreesIgnored, gitRun, gitStatusPorcelainZ, isMainModule,
  canonicalPath, posixPath, readTextSafe, resolveRepoRoots, sha256Text, writeAtomic,
} from '../../lib/git.mjs'
import {
  buildCritiqueScope, collectExcludedReviewers, CRITIQUE_FINDINGS_KEY,
  critiqueContinueDoc, critiqueOverrideDoc, critiquePassDoc, critiqueRejectDoc,
  parseCritiqueRounds, readPlanCritiqueEntrySync,
} from '../../lib/critique-rounds.mjs'
import { resolveDocIssueNumber, syncPlanPhaseToBackend } from '../../lib/plan-sync.mjs'
import { renderVerificationForReviewer, verifyDocClaims } from '../../lib/doc-verify.mjs'
import { probeWorkspaceDocShape } from '../../lib/doc-shape.mjs'
import { collectTddFacts } from '../../lib/tdd-facts.mjs'
import { buildPreFilledTdd } from '../../lib/tdd-scaffold.mjs'
import { readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import {
  readTaskLedger, resolveTaskContext, sanitizeTaskId, updateTaskLedger,
} from '../../lib/ledger.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { parseIssueNumbers, parsePrNumber } from '../../lib/platform.mjs'
import { auditDoc, auditRepoDocs, listDocs, stripCritiqueMeta, triageTask } from './doc-audit.mjs'
import { describeAuditNotApplicable } from './doc-audit-repo.mjs'
import { approveSpec, clarifyDoc, supersedeSpec } from './doc-plan-ops.mjs'
import {
  isValidPlanMode, normalizePlanMode, PLAN_MODES, resolveDocPlanMode,
} from '../../lib/pending-decisions.mjs'

export { auditDoc, auditRepoDocs, listDocs, stripCritiqueMeta, triageTask }

/**
 * 目标目录自身是不是一个独立的工程根（仓库根或 worktree 根）。
 *
 * 判据是「它自己就是一个 git 根」，不是「它长得像」：`.git` 是目录（独立仓）或
 * 指向别处的文件（worktree）都算。
 *
 * 这条判据只承认 git 根，不认「带 `docs/` + `AGENTS.md`」这种形状。理由不是形状不对，
 * 而是形状不够格：一个普通子包目录完全可以两样都有。把它当成独立根，审计范围就从
 * `pkg/` 变成 `.`，仓根下真正该审的那几份受管规划**一份都不在视野里**——扫了个空，
 * 却报全部通过。这与「路径没归一化」是同一类假绿，只是换了个入口。
 *
 * 唯一的例外是审计根之外的目录：那种情况下相对路径根本算不出来，只能按它自己作根。
 */
function isStandaloneWorkRoot(targetAbs, outerRoot) {
  if (!existsSync(targetAbs)) return false
  // 两边都归一化再比：同一目录可能经符号链接或长短文件名有两个名字，
  // 拿字面量比会把「自己」认成「别人」，白跑一遍独立根逻辑。
  const target = canonicalPath(targetAbs)
  const outer = canonicalPath(outerRoot)
  if (target === outer) return false
  if (existsSync(join(target, '.git'))) return true
  const insideOuter = target.startsWith(outer + sep)
  const containsOuter = outer.startsWith(target + sep)
  return !insideOuter && !containsOuter
}

function parseIssueArg(rawIssue) {
  if (rawIssue === undefined || rawIssue === null || rawIssue === '') return null
  const nums = parseIssueNumbers(rawIssue, { strict: true })
  if (nums.length !== 1) throw new Error(`--issue 需要 1 个正整数 Issue 编号或 URL，收到：${rawIssue}`)
  return nums[0]
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

async function initDoc({
  repoRoot, mainRoot, gitDir, isGit, type, kind, slug, title,
  taskId, issue, owner, branch, relatedSpec, relatedPrd, milestone, force = false, noPrune = false,
  planMode = null, worktree = false,
}) {
  const effectiveKind = kind ?? type
  if (!['prd', 'spec', 'todo', 'tdd', 'pair', 'all'].includes(effectiveKind)) {
    throw new Error(`--kind / --type 必须是 prd、spec、todo、tdd、pair 或 all，收到：${effectiveKind}`)
  }
  const safeSlug = slugify(slug)
  const issueNum = parseIssueArg(issue)
  const dateTag = docDateTag()
  const today = docIsoDate()

  let writeRoot = repoRoot
  let existingLedger = null
  const effTaskId = taskId ? sanitizeTaskId(taskId) : (worktree ? sanitizeTaskId(safeSlug) : null)
  if (effTaskId) {
    existingLedger = readTaskLedger(mainRoot, effTaskId)
    if (existingLedger?.worktreePath && existsSync(join(mainRoot, existingLedger.worktreePath))) {
      writeRoot = join(mainRoot, existingLedger.worktreePath)
    }
  }
  let planningBranch = branch ?? existingLedger?.branch ?? null
  let planningWorktreeRel = existingLedger?.worktreePath ?? null
  if (worktree) {
    if (!isGit) throw new Error('--worktree 仅支持 Git 仓库')
    await ensureWorktreesIgnored(mainRoot, gitDir)
    planningWorktreeRel = planningWorktreeRel || `.worktrees/impl-${effTaskId}`
    planningBranch = planningBranch || `feat/${effTaskId}`
    const wtAbs = join(mainRoot, planningWorktreeRel)
    if (!existsSync(wtAbs)) {
      const hasBr = await gitRun(mainRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${planningBranch}`])
      const addArgs = hasBr.ok
        ? ['worktree', 'add', wtAbs, planningBranch]
        : ['worktree', 'add', '-b', planningBranch, wtAbs, 'HEAD']
      const wtRes = await gitRun(mainRoot, addArgs)
      if (!wtRes.ok) throw new Error(`创建规划隔离 worktree 失败：${wtRes.stderr}`)
    }
    writeRoot = wtAbs
  }

  const dirMap = { prd: 'docs/prd', spec: 'docs/specs', todo: 'docs/todo', tdd: 'docs' }
  const kindsToCreate = effectiveKind === 'pair' ? ['spec', 'todo'] : effectiveKind === 'all' ? ['prd', 'spec', 'todo'] : [effectiveKind]
  const fastHead = isGit ? readHeadFast(resolveGitDirFast(writeRoot), gitDir) : null
  const headRes = fastHead?.oid
    ? { ok: true, stdout: fastHead.oid }
    : (isGit ? await gitRun(writeRoot, ['rev-parse', 'HEAD']) : { ok: false, stdout: '' })
  const headSha = headRes.ok && headRes.stdout ? headRes.stdout.trim() : 'uncommitted'
  let headBranch = branch ?? (fastHead?.branch ?? null)
  if (!headBranch && isGit && !fastHead) {
    const sym = await gitRun(writeRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (sym.ok && sym.stdout.trim()) headBranch = sym.stdout.trim()
    else {
      const brRes = await gitRun(writeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (brRes.ok && brRes.stdout && brRes.stdout.trim() !== 'HEAD') headBranch = brRes.stdout.trim()
    }
  }
  const profile = parseAgentsProfile(writeRoot)
  const quickCmd = profile.quickTest && profile.quickTest !== 'none'
    ? profile.quickTest
    : '无自动快测命令（按手动步骤实证替代）'
  const needsShape = kindsToCreate.some((k) => k !== 'tdd')
  const docShape = needsShape && !noPrune ? await probeWorkspaceDocShape(writeRoot) : null

  let inheritedPrdAbs = relatedPrd ? resolve(writeRoot, relatedPrd) : null
  if (!inheritedPrdAbs && relatedSpec) {
    const parentSpecAbs = resolve(writeRoot, relatedSpec)
    const parentRaw = readTextSafe(parentSpecAbs)
    const parentFm = parentRaw ? parseDocFrontmatter(parentRaw) : null
    const rawRelPrd = parentFm?.data?.related_prd
    if (typeof rawRelPrd === 'string' && rawRelPrd.trim() && !/^(?:无|none|null)$/i.test(rawRelPrd.trim())) {
      const candAbs = resolve(dirname(parentSpecAbs), rawRelPrd.trim())
      if (existsSync(candAbs)) inheritedPrdAbs = candAbs
    }
  }

  const planned = []
  for (const k of kindsToCreate) {
    // TDD 是常青单文件，文件名固定为 docs/TDD.md——加日期前缀会让每份 TDD 变成新文件，
    // 而它本来就该被就地改写。
    const fileName = k === 'tdd' ? 'TDD.md' : buildDocFilename({ date: dateTag, issue: issueNum, slug: safeSlug, kind: k })
    const relFile = `${dirMap[k]}/${fileName}`
    const absFile = join(writeRoot, relFile)
    if (existsSync(absFile) && !force) throw new Error(`目标文件已存在：${relFile}（如确需重建请加 --force）`)
    planned.push({ kind: k, file: relFile, absFile })
  }

  const customTemplates = []
  for (const item of planned) {
    const relatedSpecRel = item.kind === 'todo' && relatedSpec
      ? posixPath(relative(dirname(item.absFile), resolve(writeRoot, relatedSpec)))
      : null
    const relatedPrdRel = item.kind !== 'prd' && inheritedPrdAbs
      ? posixPath(relative(dirname(item.absFile), inheritedPrdAbs))
      : null
    const customTpl = resolveRepoCustomDocTemplate(writeRoot, item.kind)
    if (customTpl) customTemplates.push({ kind: item.kind, template: customTpl.rel })
    let content
    if (item.kind === 'tdd') {
      // 从仓库事实预填：技术栈、模块表、命令这些读得出来的东西不该让人再抄一遍。
      // 只收集生成 TDD 需要的那几项事实：跑整套勘察既慢又跨层。
      const facts = await collectTddFacts(writeRoot)
      content = buildPreFilledTdd(facts, {
        repoRoot: writeRoot,
        noPrune: Boolean(noPrune),
        projectName: title,
        today,
        topLevelDirs: facts?.tddShape?.topLevelDirs ?? [],
        allPaths: facts?.tddShape?.filePaths ?? [],
      })
    } else {
      content = renderStandardDocTemplate({
        kind: item.kind, repoRoot: writeRoot, title, safeSlug, today, headSha, headBranch,
        taskId, issueNum, owner, quickCmd, relatedPrdRel, relatedSpecRel,
        pruneUnfilled: false, noPrune: Boolean(noPrune), docShape, planMode,
      })
    }
    mkdirSync(dirname(item.absFile), { recursive: true })
    writeAtomic(item.absFile, content)
  }

  if (planned.length > 1 || relatedSpec || relatedPrd) {
    const syncRes = await syncDocsLifecycle(writeRoot, {
      slugOrPath: planned[0].file,
      issue: issueNum ?? undefined,
      branch: planned.length > 1 ? (headBranch ?? undefined) : (branch ?? undefined),
      owner: owner ?? undefined,
    })
    for (const r of syncRes.renamed ?? []) {
      const hit = planned.find((p) => p.file === r.from)
      if (hit) {
        hit.file = r.to
        hit.absFile = join(writeRoot, r.to)
      }
    }
  }

  let ledgerUpdated = false
  if (milestone) {
    for (const item of planned) {
      if (item.kind !== 'tdd') updateDocFrontmatter(item.absFile, { milestone }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[item.kind] ?? [] })
    }
  }
  if (effTaskId) {
    if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
    await updateTaskLedger(mainRoot, effTaskId, (cur) => {
      const next = { ...cur }
      for (const item of planned) {
        if (item.kind === 'prd') next.prdFile = item.file
        else if (item.kind === 'spec') next.specFile = item.file
        else if (item.kind === 'todo') next.todoFile = item.file
      }
      if (issueNum && Array.isArray(next.linkedIssues) && !next.linkedIssues.includes(issueNum)) {
        next.linkedIssues = [...next.linkedIssues, issueNum]
      }
      if (milestone) next.milestone = milestone
      if (worktree) {
        next.isolation = 'worktree'
        next.worktreePath = planningWorktreeRel
        next.branch = planningBranch
        if (!cur.status || cur.status === 'planned' || cur.status === 'planning') {
          next.status = 'planning'
          next.planning = true
        }
      }
      return next
    }, {
      createIfMissing: true,
      defaults: {
        taskId: effTaskId, slug: safeSlug,
        isolation: worktree ? 'worktree' : null,
        worktreePath: worktree ? planningWorktreeRel : null,
        branch: worktree ? planningBranch : null,
        planning: worktree,
        status: worktree ? 'planning' : 'planned',
      },
    })
    ledgerUpdated = true
  }

  const primary = planned[planned.length - 1]
  return {
    type: effectiveKind, kind: effectiveKind, writeRoot, file: primary.file, absFile: primary.absFile,
    files: planned.map((p) => p.file), created: planned.map((p) => ({ kind: p.kind, file: p.file })),
    taskId: effTaskId, worktreePath: planningWorktreeRel, branch: planningBranch,
    issue: issueNum, milestone: milestone ?? null, plannedAt: headSha, ledgerUpdated, customTemplates,
  }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-plan/scripts/doc-plan.mjs <子命令> [选项]',
    '',
    '子命令：',
    '  triage             --summary <文本> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--plan-mode interactive | autonomous] [--json]',
    '  init               --kind <prd|spec|todo|pair|all> --slug <slug> --title <标题> [--issue <N>] [--task <id>] [--milestone <m>] [--prd <path>] [--spec <path>] [--plan-mode interactive | autonomous] [--worktree] [--no-prune] [--json]',
    '  clarify            --file <docPath> --decision <结论> [--question <问题>] [--by <actor>] [--criterion <C条目>] [--json]',
    '  link               <slug-or-path> [--issue <N>] [--pr <M>] [--branch <B>] [--owner <O> --owner-reason "<变更原因>"] [--status <S>] [--milestone <m>] [--json]',
    '  audit              [--file <docPath> | .] [--json]',
    '  critique-scope     --file <docPath> [--reviewer <id>] [--round <n>] [--json]',
    '  critique-pass      --file <docPath> --reviewer <id> [--round <N>] [--summary <文本>] [--findings <t>...] [--json]',
    '  critique-reject    --file <docPath> --reviewer <id> [--round <N>] [--summary <文本>] [--findings <t>...] [--json]',
    '  critique-continue  --file <docPath> --reason <改进方向> [--by <actor>] [--task <id>] [--json]',
    '  critique-override  --file <docPath> --human-approved --reason <原因> [--by <actor>] [--json]',
    '  approve            --file <specPath> [--skip-critique-reason <文本>] [--json]',
    '  archive            [<slug-or-path>] [--task <id>] [--done-at <YYYY-MM-DD>] [--include-master-prd] [--json]',
    '  supersede          <oldSpec> --by <newSpec> [--json]',
    '  list               [--json]',
  ].join('\n') + '\n')
}

const SUBCOMMANDS = ['triage', 'init', 'clarify', 'link', 'audit', 'critique-scope', 'critique-pass', 'critique-reject', 'critique-continue', 'critique-override', 'approve', 'archive', 'supersede', 'list']

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }

  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      booleanFlags: ['touches-contract', 'conflicts-tdd', 'doc-only', 'bugfix', 'force', 'approve', 'implemented', 'include-master-prd', 'no-prune', 'human-approved', 'worktree'],
      valueFlags: ['summary', 'files', 'paths', 'kind', 'type', 'slug', 'title', 'issue', 'task', 'spec', 'prd', 'file', 'pr', 'branch', 'owner', 'owner-reason', 'status', 'done-at', 'reviewer', 'round', 'skip-critique-reason', 'by', 'question', 'decision', 'criterion', 'reason', 'milestone', 'plan-mode'],
      multiFlags: ['findings', 'finding'],
      aliases: { type: 'kind' },
      usageHint: 'doc-plan.mjs <triage|init|clarify|link|audit|critique-scope|critique-pass|critique-reject|critique-continue|critique-override|approve|archive|supersede|list>',
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
    if (sub === 'triage') {
      const summary = opts.summary ?? opts._.join(' ')
      if (!summary) throw new Error('triage 需要传入 --summary "<需求描述>"')
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
      } else if (roots.isGit) {
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
      if (cli.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else {
        process.stdout.write(`分流结论：Case ${result.caseType} (${result.action})${result.blocked ? ' [BLOCKED]' : ''}\n`)
        process.stdout.write(`- 门型: ${result.doorType} | 规划内审档位: ${result.critiqueTier} | 规划态: ${result.planMode}\n- 理由: ${result.reason}\n`)
        process.stdout.write(`- 必建文档: ${result.docsRequired.join(', ') || '无 (0 文档)'}\n`)
        process.stdout.write(`- Red-Green 回归测试: ${result.redGreenRequired ? '强制' : '不需要'} | 独立审查: ${result.needsReview ? '需要' : '低风险免除'}\n`)
        for (const w of result.coupledSyncWarnings ?? []) {
          process.stdout.write(`  * 联动提醒: 触及 ${w.touchedTriggers.join(', ')} -> 检查同步 ${w.expectedCompanions.join(', ')}\n`)
        }
        const steps = result.caseType === 5
          ? ['已阻断直接拆解！请先更新 docs/TDD.md 解决冲突并经独立确认。']
          : result.caseType === 4
            ? [{ skill: 'dev-plan', text: '创建 SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind pair --slug <slug> --title "<标题>"' }]
            : result.caseType === 3
              ? [{ skill: 'dev-flow', text: '启动任务隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 3 --slug <slug>' }]
              : [{ skill: 'dev-flow', text: `启动任务流转：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case ${result.caseType} --slug <slug>` }]
        printNextStep(steps, { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'init') {
      if (!opts.kind || !opts.slug || !opts.title) throw new Error('init 需要 --kind <prd|spec|todo|pair|all>、--slug <slug> 与 --title <title>')
      const res = await initDoc({
        repoRoot, mainRoot, gitDir: roots.gitDir, isGit: roots.isGit,
        kind: opts.kind, slug: opts.slug, title: opts.title, taskId: opts.task,
        issue: opts.issue, owner: opts.owner, branch: opts.branch, relatedSpec: opts.spec,
        relatedPrd: opts.prd, milestone: opts.milestone, force: Boolean(opts.force), noPrune: Boolean(opts['no-prune']),
        planMode: resolveCliPlanMode(opts['plan-mode']),
        worktree: Boolean(opts.worktree),
      })
      res.planSync = await syncPlanPhaseToBackend({
        repoRoot: res.writeRoot ?? repoRoot, mainRoot, gitDir: roots.gitDir,
        phase: 'init', file: res.file, taskId: res.taskId ?? opts.task ?? null,
        issueNumber: res.issue ?? null, summary: `初始化 ${res.kind.toUpperCase()}: ${opts.title}`,
      }).catch((err) => ({ ok: false, synced: false, status: 'SYNC_ERROR', error: err?.message ?? String(err) }))
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`已生成 ${res.kind.toUpperCase()}：${res.files.join(', ')}（Planned at: ${res.plannedAt}${res.worktreePath ? `, worktree=${res.worktreePath}` : ''}）\n`)
        printNextStep([{ skill: 'dev-plan', text: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${res.file}"` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'clarify') {
      if (!opts.file || !opts.decision) throw new Error('clarify 需要 --file <docPath> 与 --decision "<已确认结论>"')
      const res = clarifyDoc({
        repoRoot, file: opts.file, question: opts.question ?? '',
        decision: opts.decision, by: opts.by ?? 'user', criterion: opts.criterion ?? '',
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
          const fileRefs = [...new Set(docText.match(/`[^`\n]+\/[A-Za-z0-9_.-]+\.[A-Za-z0-9]+`/g) ?? [])]
          const isNonTrivialTodo = Boolean(fm.data?.related_spec) || fileRefs.length >= 3 || /^- \[[ xX]\] C3\b/m.test(docText)
          if (res.docType === 'prd' && !['active', 'done', 'dropped'].includes(statusLow)) {
            printNextStep([{ skill: 'dev-plan', text: `PRD 须经独立只读 Plan Critique 后执行：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
          } else if (res.docType === 'tdd') {
            printNextStep([{ skill: 'dev-plan', text: `TDD 架构基线须经独立架构 Critique 确认与 AGENTS.md 模块边界、arch-rules 对齐：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
          } else if (res.docType === 'todo' && !fm.data?.related_spec && !isNonTrivialTodo) {
            printNextStep([{ skill: 'dev-flow', text: `Todo 自审通过，移交 dev-flow 启动隔离实施：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case 3 --todo "${res.file}"` }], { repoRoot: mainRoot })
          } else if (res.docType === 'todo') {
            printNextStep([
              { skill: 'dev-flow', text: `Todo 自审通过，启动隔离实施：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case 3 --todo "${res.file}"` },
            ], { repoRoot: mainRoot })
          } else if (res.docType === 'spec' && statusLow !== 'approved') {
            printNextStep([{ skill: 'dev-plan', text: `独立只读 Critique 通过后执行：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
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
      const prevSha = /\bsha=([a-f0-9]{8,64})\b/i.exec(String(scopeFm.data?.plan_critique ?? ''))?.[1] ?? null
      const { entry: ledgerEntry } = readPlanCritiqueEntrySync({
        repoRoot, mainRoot, gitDir: roots.gitDir, taskId: opts.task ?? null, fmData: scopeFm.data, relDoc: scopeRel,
      })
      const priorRounds = parseCritiqueRounds(scopeFm.data, scopeText, ledgerEntry)
      const excludedReviewers = collectExcludedReviewers(priorRounds, scopeFm.data?.owner)
      const roundNum = Number(opts.round ?? (priorRounds.reduce((m, r) => Math.max(m, Number(r.round) || 0), 0) + 1))
      const ledgerFindings = Array.isArray(ledgerEntry?.findings)
        ? ledgerEntry.findings.map((f) => `Round ${f.round}: ${(f.items ?? []).join('; ')}`).join(' ;; ')
        : ''
      const scope = buildCritiqueScope({
        round: roundNum,
        currentSha: curSha,
        previousSha: prevSha,
        findingsRaw: ledgerFindings || (scopeFm.data?.[CRITIQUE_FINDINGS_KEY] ?? ''),
        reviewer: opts.reviewer ?? '(未指定)',
      })
      const facts = await verifyDocClaims(repoRoot, scopeText)
      const factsText = renderVerificationForReviewer(facts)
      if (cli.json) {
        process.stdout.write(`${JSON.stringify({
          file: opts.file, currentSha: curSha, previousSha: prevSha, round: roundNum, excludedReviewers, ...scope, facts, factsText,
        }, null, 2)}\n`)
      } else {
        const exclNote = excludedReviewers.length > 0 ? `\n> 排除复核人（禁止复用）：${excludedReviewers.join(', ')}\n` : ''
        process.stdout.write(`${factsText}${exclNote}\n${scope.prompt}`)
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
        const passNext = res.docType === 'prd'
          ? `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" link "${res.file}" --status active`
          : `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${res.file}"`
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
        if (res.warning) process.stdout.write(`提示：${res.warning}\n`)
        if (res.nextStep) printNextStep([{ skill: 'dev-flow', text: `规划已批准，移交 dev-flow 启动隔离工作区：${startHint}` }], { repoRoot: mainRoot })
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
      const res = await archiveCompletedDocsGroup(archiveRoot, {
        prdFile: taskLedger?.prdFile, specFile: taskLedger?.specFile, todoFile: taskLedger?.todoFile,
        slugOrPath: targetSlugOrPath, issue: taskLedger?.linkedIssues?.[0], pr: taskLedger?.prNumber,
        branch: taskLedger?.branch, owner: taskLedger?.implementerId, doneAt: opts['done-at'],
        includeMasterPrd: Boolean(opts['include-master-prd']),
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`成对归档完成（移动 ${res.moved.length} 份，更新互链 ${res.updated.length} 份）：${res.archived.join(', ')}\n`)
      return 0
    }

    if (sub === 'supersede') {
      const oldSpec = opts._[0] ?? opts.file
      const newSpec = opts.by
      const res = supersedeSpec({ repoRoot, oldSpecPath: oldSpec, newSpecPath: newSpec })
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
