#!/usr/bin/env node
/**
 * doc-plan.mjs —— 五档需求分流、四层工程文档生成、规划自审净化、Critique、批准与归档取代。
 *
 * 子命令：
 *   triage         --summary <text> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]
 *   init           --kind prd|spec|todo|pair|all --slug <slug> --title <title> [--issue <N>] [--task <id>] [--spec <path>] [--force] [--json]
 *   link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <name>] [--owner <name>] [--status <s>] [--approve] [--json]
 *   audit          [--file <docPath> | .] [--json]
 *   critique-pass  --file <docPath> --reviewer <id> [--round 1|2] [--summary <text>] [--json]
 *   approve        --file <specPath> [--skip-critique-reason <text>] [--json]
 *   archive        [<slug-or-path>] [--task <id>] [--done-at YYYY-MM-DD] [--json]
 *   supersede      <oldSpec> --by <newSpec> [--json]
 *   list           [--json]
 */

import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

import { parseStandardCli, printNextStep } from '../../lib/cli.mjs'
import {
  archiveCompletedDocsGroup, buildDocFilename, DOC_FRONTMATTER_KEY_ORDER,
  docDateTag, docIsoDate, parseDocFilename, parseDocFrontmatter,
  renderStandardDocTemplate, slugify, syncDocsLifecycle, updateDocFrontmatter,
} from '../../lib/docs.mjs'
import {
  ensureWorktreesIgnored, gitRun, gitStatusPorcelainZ, isMainModule,
  posixPath, readTextSafe, resolveRepoRoots, sha256Text, writeAtomic,
} from '../../lib/git.mjs'
import {
  createDefaultLedger, readTaskLedger, resolveTaskContext, sanitizeTaskId, writeTaskLedger,
} from '../../lib/ledger.mjs'
import { parseAgentsProfile } from '../../lib/profile.mjs'
import { parseIssueNumbers, parsePrNumber } from '../../lib/platform.mjs'
import { auditDoc, auditRepoDocs, detectDocType, listDocs, stripCritiqueMeta, triageTask } from './doc-audit.mjs'

export { auditDoc, auditRepoDocs, listDocs, stripCritiqueMeta, triageTask }

function parseIssueArg(rawIssue) {
  if (rawIssue === undefined || rawIssue === null || rawIssue === '') return null
  const nums = parseIssueNumbers(rawIssue, { strict: true })
  if (nums.length !== 1) throw new Error(`--issue 需要 1 个正整数 Issue 编号或 URL，收到：${rawIssue}`)
  return nums[0]
}

async function initDoc({
  repoRoot, mainRoot, gitDir, isGit, type, kind, slug, title,
  taskId, issue, owner, branch, relatedSpec, force = false,
}) {
  const effectiveKind = kind ?? type
  if (!['prd', 'spec', 'todo', 'pair', 'all'].includes(effectiveKind)) {
    throw new Error(`--kind / --type 必须是 prd、spec、todo、pair 或 all，收到：${effectiveKind}`)
  }
  const safeSlug = slugify(slug)
  const issueNum = parseIssueArg(issue)
  const dateTag = docDateTag()
  const today = docIsoDate()

  // 若绑定 taskId 且已有隔离 worktree，直接落盘至实施工作树防止 doc-plan 与 flow start 撕裂
  let writeRoot = repoRoot
  let existingLedger = null
  if (taskId) {
    existingLedger = readTaskLedger(mainRoot, sanitizeTaskId(taskId))
    if (existingLedger?.worktreePath && existsSync(join(mainRoot, existingLedger.worktreePath))) {
      writeRoot = join(mainRoot, existingLedger.worktreePath)
    }
  }

  const dirMap = { prd: 'docs/prd', spec: 'docs/specs', todo: 'docs/todo' }
  const kindsToCreate = effectiveKind === 'pair' ? ['spec', 'todo'] : effectiveKind === 'all' ? ['prd', 'spec', 'todo'] : [effectiveKind]
  const headRes = isGit ? await gitRun(writeRoot, ['rev-parse', 'HEAD']) : { ok: false, stdout: '' }
  const headSha = headRes.ok && headRes.stdout ? headRes.stdout.trim() : 'uncommitted'
  let headBranch = branch ?? null
  if (!headBranch && isGit) {
    const sym = await gitRun(writeRoot, ['symbolic-ref', '--short', 'HEAD'])
    if (sym.ok && sym.stdout.trim()) headBranch = sym.stdout.trim()
    else {
      const brRes = await gitRun(writeRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (brRes.ok && brRes.stdout && brRes.stdout.trim() !== 'HEAD') headBranch = brRes.stdout.trim()
    }
  }
  const profile = parseAgentsProfile(writeRoot)
  const quickCmd = profile.quickTest ?? '<填写项目快测命令>'

  const planned = []
  for (const k of kindsToCreate) {
    const fileName = buildDocFilename({ date: dateTag, issue: issueNum, slug: safeSlug, kind: k })
    const relFile = `${dirMap[k]}/${fileName}`
    const absFile = join(writeRoot, relFile)
    if (existsSync(absFile) && !force) throw new Error(`目标文件已存在：${relFile}（如确需重建请加 --force）`)
    planned.push({ kind: k, file: relFile, absFile })
  }

  for (const item of planned) {
    const relatedSpecRel = item.kind === 'todo' && relatedSpec
      ? posixPath(relative(dirname(item.absFile), resolve(writeRoot, relatedSpec)))
      : null
    const content = renderStandardDocTemplate({
      kind: item.kind, title, safeSlug, today, headSha, headBranch,
      taskId, issueNum, owner, quickCmd, relatedSpecRel,
    })
    mkdirSync(dirname(item.absFile), { recursive: true })
    writeAtomic(item.absFile, content)
  }

  if (planned.length > 1) {
    await syncDocsLifecycle(writeRoot, {
      slugOrPath: planned[0].file,
      issue: issueNum ?? undefined,
      branch: headBranch ?? undefined,
      owner: owner ?? undefined,
    })
  }

  let ledgerUpdated = false
  if (taskId) {
    if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
    const id = sanitizeTaskId(taskId)
    const ledger = existingLedger ?? createDefaultLedger({ taskId: id, slug: safeSlug, isolation: null, status: 'planned' })
    for (const item of planned) {
      if (item.kind === 'prd') ledger.prdFile = item.file
      else if (item.kind === 'spec') ledger.specFile = item.file
      else if (item.kind === 'todo') ledger.todoFile = item.file
    }
    if (issueNum && Array.isArray(ledger.linkedIssues) && !ledger.linkedIssues.includes(issueNum)) {
      ledger.linkedIssues = [...ledger.linkedIssues, issueNum]
    }
    writeTaskLedger(mainRoot, ledger)
    ledgerUpdated = true
  }

  const primary = planned[planned.length - 1]
  return {
    type: effectiveKind, kind: effectiveKind, writeRoot, file: primary.file, absFile: primary.absFile,
    files: planned.map((p) => p.file), created: planned.map((p) => ({ kind: p.kind, file: p.file })),
    issue: issueNum, plannedAt: headSha, ledgerUpdated,
  }
}

function critiquePassDoc({ repoRoot, file, reviewer, round = 1, summary = '' }) {
  if (!reviewer || !String(reviewer).trim()) throw new Error('critique-pass 必须指定 --reviewer <reviewerId>')
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到文档：${file}`)

  const audit = auditDoc({ repoRoot, file })
  if (!audit.ok) {
    const err = new Error(`文档尚有 ${audit.errors.length} 处审计问题未自净化，禁止记录 critique-pass`)
    err.audit = audit
    throw err
  }

  const text = readTextSafe(abs)
  if (text === undefined) throw new Error(`无法读取文本文件：${file}`)
  const fm = parseDocFrontmatter(text)
  const relDoc = posixPath(relative(repoRoot, abs))
  const docType = detectDocType(relDoc, text)
  const digest = sha256Text(stripCritiqueMeta(text)).slice(0, 12)
  const cleanSummary = String(summary ?? '').replace(/[\r\n]+/g, ' ').trim()
  const stampValue = `passed (reviewer=${String(reviewer).trim()}, round=${round}, sha=${digest}${cleanSummary ? `, summary=${cleanSummary}` : ''})`

  if (fm.hasFrontmatter) {
    updateDocFrontmatter(abs, { plan_critique: stampValue, updated: docIsoDate() }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  } else {
    const stampLine = `- Plan Critique: ${stampValue}`
    let updated
    if (/^(?:-\s+)?Plan Critique:.*$/mi.test(text)) updated = text.replace(/^(?:-\s+)?Plan Critique:.*$/mi, stampLine)
    else if (/^(?:-\s+)?Status:.*$/mi.test(text)) updated = text.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${stampLine}`)
    else updated = text.replace(/^(#[^\n]*\n)/, `$1\n${stampLine}\n`)
    writeAtomic(abs, updated)
  }

  return { file: relDoc, reviewer: String(reviewer).trim(), round: Number(round), sha: digest, summary: cleanSummary || null, status: 'passed' }
}

function approveSpec({ repoRoot, file, skipCritiqueReason }) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) throw new Error(`找不到 SPEC/PRD 文件：${file}`)
  const text = readTextSafe(abs)
  if (text === undefined) throw new Error(`无法读取文本文件：${file}`)

  const audit = auditDoc({ repoRoot, file })
  if (!audit.ok) {
    const err = new Error(`BLOCKED_AUDIT_FAILED: ${audit.file} 尚未通过 doc-plan.mjs audit（共 ${audit.errors.length} 项缺陷），请先自修后再 approve`)
    err.audit = audit
    throw err
  }

  const fm = parseDocFrontmatter(text)
  const legacyStatusMatch = /^((?:-\s+)?Status:\s*)(\S+)(\s*)$/mi.exec(text)
  const curStatusRaw = fm.hasFrontmatter ? fm.data?.status : (fm.data?.status ?? legacyStatusMatch?.[2])
  if (!curStatusRaw) throw new Error(`${file} 缺少 status 字段，无法切换状态`)
  const curStatus = String(curStatusRaw).toLowerCase()
  if (curStatus === 'superseded' || curStatus === 'implemented') {
    throw new Error(`${file} 当前状态为 ${curStatus}，不允许直接 approve`)
  }
  if (!/^- \[[ xX]\] C1\b/m.test(text)) throw new Error(`${file} 至少需要包含一条「- [ ] C1: ...」可判定验收标准才可批准`)

  const docType = detectDocType(audit.file, text)
  let workingText = text
  let critiqueSkipped = false
  let skippedCritiqueValue = null

  if (docType === 'spec' || docType === 'prd') {
    const critiqueVal = String(fm.data?.plan_critique ?? (/^(?:-\s+)?Plan Critique:\s*(.+)$/mi.exec(workingText)?.[1] ?? '')).trim()
    if (!/^passed\b/i.test(critiqueVal)) {
      if (skipCritiqueReason && String(skipCritiqueReason).trim()) {
        skippedCritiqueValue = `skipped (reason=${String(skipCritiqueReason).trim()})`
        if (!fm.hasFrontmatter) {
          const skipLine = `- Plan Critique: ${skippedCritiqueValue}`
          workingText = /^(?:-\s+)?Plan Critique:.*$/mi.test(workingText)
            ? workingText.replace(/^(?:-\s+)?Plan Critique:.*$/mi, skipLine)
            : workingText.replace(/^((?:-\s+)?Status:.*)$/mi, `$1\n${skipLine}`)
        }
        critiqueSkipped = true
      } else {
        throw new Error(`BLOCKED_CRITIQUE_REQUIRED: ${audit.file} 为 ${docType.toUpperCase()} 文档，必须先通过独立 Critique 并运行 critique-pass，或传入 --skip-critique-reason "<原因>"`)
      }
    } else {
      const shaMatch = /\bsha=([a-f0-9]{8,64})\b/i.exec(critiqueVal)
      if (shaMatch) {
        const currentSha = sha256Text(stripCritiqueMeta(workingText)).slice(0, shaMatch[1].length)
        if (currentSha !== shaMatch[1].toLowerCase() && !skipCritiqueReason) {
          throw new Error(`BLOCKED_CRITIQUE_STALE: ${audit.file} 在 critique-pass 之后正文已被修改（recorded=${shaMatch[1]} !== current=${currentSha}），请重新复核并执行 critique-pass`)
        }
      }
    }
  }

  const nextStatus = docType === 'todo'
    ? (['draft', 'pending'].includes(curStatus) ? 'active' : curStatus)
    : (docType === 'prd' ? 'active' : 'approved')
  const hasPlaceholder = /^- \[[ xX]\] C\d+:\s*<[^>]+>/m.test(workingText)
  if (fm.hasFrontmatter) {
    const patch = { status: nextStatus, updated: docIsoDate() }
    if (docType === 'spec' || docType === 'todo') patch.approved = true
    if (skippedCritiqueValue) patch.plan_critique = skippedCritiqueValue
    updateDocFrontmatter(abs, patch, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER[fm.data.kind ?? docType] ?? [] })
  } else {
    writeAtomic(abs, workingText.replace(/^((?:-\s+)?Status:\s*)\S+(\s*)$/mi, `$1${nextStatus}$2`))
  }

  return {
    file: posixPath(relative(repoRoot, abs)), previousStatus: curStatus, status: nextStatus, critiqueSkipped,
    warning: hasPlaceholder ? '检测到仍有占位描述 <...>，动手实现前请替换成真实可判定条件' : null,
  }
}

function supersedeSpec({ repoRoot, oldSpecPath, newSpecPath }) {
  if (!oldSpecPath || !newSpecPath) throw new Error('supersede 需要 <oldSpec> 与 --by <newSpec>')
  const oldAbs = resolve(repoRoot, oldSpecPath)
  const newAbs = resolve(repoRoot, newSpecPath)
  if (!existsSync(oldAbs)) throw new Error(`找不到被取代 SPEC：${oldSpecPath}`)
  if (!existsSync(newAbs)) throw new Error(`找不到新 SPEC：${newSpecPath}`)
  const today = docIsoDate()
  const relOldToNew = posixPath(relative(dirname(oldAbs), newAbs))
  const relNewToOld = posixPath(relative(dirname(newAbs), oldAbs))
  updateDocFrontmatter(oldAbs, { status: 'superseded', updated: today, superseded_by: relOldToNew }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER.spec })
  updateDocFrontmatter(newAbs, { updated: today, supersedes: relNewToOld }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER.spec })
  return { oldSpec: posixPath(relative(repoRoot, oldAbs)), newSpec: posixPath(relative(repoRoot, newAbs)), status: 'superseded', supersededBy: relOldToNew }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-plan/scripts/doc-plan.mjs <子命令> [选项]',
    '',
    '子命令：',
    '  triage         --summary <文本> [--files <n>] [--paths a,b] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]',
    '  init           --kind <prd|spec|todo|pair|all> --slug <slug> --title <标题> [--issue <N>] [--task <id>] [--json]',
    '  link           <slug-or-path> [--issue <N>] [--pr <M>] [--branch <B>] [--owner <O>] [--status <S>] [--approve] [--json]',
    '  audit          [--file <docPath> | .] [--json]',
    '  critique-pass  --file <docPath> --reviewer <id> [--round 1|2] [--summary <文本>] [--json]',
    '  approve        --file <specPath> [--skip-critique-reason <文本>] [--json]',
    '  archive        [<slug-or-path>] [--task <id>] [--done-at <YYYY-MM-DD>] [--json]',
    '  supersede      <oldSpec> --by <newSpec> [--json]',
    '  list           [--json]',
  ].join('\n') + '\n')
}

const SUBCOMMANDS = ['triage', 'init', 'link', 'audit', 'critique-pass', 'approve', 'archive', 'supersede', 'list']

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') { printHelp(); return 0 }

  let cli
  try {
    cli = parseStandardCli(argv, {
      subcommands: SUBCOMMANDS,
      booleanFlags: ['touches-contract', 'conflicts-tdd', 'doc-only', 'bugfix', 'force', 'approve', 'implemented'],
      valueFlags: ['summary', 'files', 'paths', 'kind', 'type', 'slug', 'title', 'issue', 'task', 'spec', 'file', 'pr', 'branch', 'owner', 'status', 'done-at', 'reviewer', 'round', 'skip-critique-reason', 'by'],
      aliases: { type: 'kind' },
      usageHint: 'doc-plan.mjs <triage|init|link|audit|critique-pass|approve|archive|supersede|list>',
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
      const filesNum = opts.files !== undefined ? Number(opts.files) : undefined
      let triagePaths = []
      if (opts.paths !== undefined) triagePaths = String(opts.paths).split(',').map((s) => s.trim()).filter(Boolean)
      else if (roots.isGit) triagePaths = (await gitStatusPorcelainZ(repoRoot)).entries.map((e) => e.file)
      const result = triageTask({
        summary, files: filesNum, touchesContract: Boolean(opts['touches-contract']),
        conflictsTdd: Boolean(opts['conflicts-tdd']), docOnly: Boolean(opts['doc-only']),
        bugfix: Boolean(opts.bugfix), paths: triagePaths, repoRoot,
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      else {
        process.stdout.write(`分流结论：Case ${result.caseType} (${result.action})${result.blocked ? ' [BLOCKED]' : ''}\n`)
        process.stdout.write(`- 门型: ${result.doorType} | 规划内审档位: ${result.critiqueTier}\n- 理由: ${result.reason}\n`)
        process.stdout.write(`- 必建文档: ${result.docsRequired.join(', ') || '无 (0 文档)'}\n`)
        process.stdout.write(`- Red-Green 回归测试: ${result.redGreenRequired ? '强制' : '不需要'} | 独立审查: ${result.needsReview ? '需要' : '低风险免除'}\n`)
        for (const w of result.coupledSyncWarnings ?? []) {
          process.stdout.write(`  * 联动提醒: 触及 ${w.touchedTriggers.join(', ')} -> 检查同步 ${w.expectedCompanions.join(', ')}\n`)
        }
        const steps = result.caseType === 5
          ? ['已阻断直接拆解！请先更新 docs/TDD.md 解决冲突并经独立确认。']
          : result.caseType === 4
            ? [
                { skill: 'dev-plan', text: '1. 创建 SPEC+Todo: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind pair --slug <slug> --title "<标题>"' },
                '2. 自检净化并派独立只读 Critique -> critique-pass -> 人类 approve',
              ]
            : result.caseType === 3
              ? [
                  { skill: 'dev-flow', text: '1. 启动任务隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 3 --slug <slug>' },
                  { skill: 'dev-plan', text: '2. 生成 Todo 并跑 audit 自净化：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --kind todo --slug <slug> --title "<标题>" --task <id>' },
                ]
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
        issue: opts.issue, owner: opts.owner, branch: opts.branch, relatedSpec: opts.spec, force: Boolean(opts.force),
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`已生成 ${res.kind.toUpperCase()}：${res.files.join(', ')}（Planned at: ${res.plannedAt}）\n`)
        printNextStep([{ skill: 'dev-plan', text: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" audit --file "${res.file}"` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'link') {
      const target = opts._[0] ?? opts.file ?? opts.slug
      if (!target) throw new Error('link 需要传入 <slug-or-path>（如 261115-my-feature 或 docs/specs/...）')
      const prVal = opts.pr !== undefined ? parsePrNumber(opts.pr, { strict: true }) : undefined
      const res = await syncDocsLifecycle(repoRoot, {
        slugOrPath: target, issue: opts.issue !== undefined ? parseIssueArg(opts.issue) : undefined, pr: prVal,
        branch: opts.branch, owner: opts.owner, status: opts.status,
        approved: opts.approve ? true : undefined, implemented: opts.implemented ? true : undefined, doneAt: opts['done-at'],
      })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else process.stdout.write(`文档生命周期同步完成（issue=${res.issue ?? '无'}，重命名 ${res.renamed.length} 个，更新 ${res.updated.length} 个）\n`)
      return 0
    }

    if (sub === 'audit') {
      const target = opts.file ?? opts._[0] ?? '.'
      const targetAbs = resolve(repoRoot, target)
      const isDirScope = target === '.' || (existsSync(targetAbs) && statSync(targetAbs).isDirectory())
      if (isDirScope) {
        const batch = auditRepoDocs(repoRoot, target)
        if (cli.json) process.stdout.write(`${JSON.stringify(batch, null, 2)}\n`)
        else {
          process.stdout.write(`仓库工程文档审计（${batch.scope}，共 ${batch.auditedCount} 份）：${batch.ok ? '全部通过' : `${batch.failedCount} 份失败`}\n`)
          for (const r of batch.results) {
            process.stdout.write(`- ${r.file} (${r.docType}): ${r.ok ? '通过' : `失败 (${r.errors.length})`}\n`)
            for (const e of r.errors) process.stdout.write(`  * [${e.code}] L${e.line}: ${e.message}\n    修法: ${e.fixHint}\n`)
          }
        }
        return batch.ok ? 0 : 1
      }
      const res = auditDoc({ repoRoot, file: target })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`文档审计（${res.file}，type=${res.docType}）：${res.ok ? '通过' : `失败（${res.errors.length} 项错误）`}\n`)
        for (const e of res.errors) process.stdout.write(`- [${e.code}] L${e.line}: ${e.message}\n  修法: ${e.fixHint}\n`)
        if (res.ok) {
          const fm = parseDocFrontmatter(readTextSafe(resolve(repoRoot, res.file)) ?? '')
          const fn = parseDocFilename(res.file)
          const slugVal = fn?.slug ?? 'task'
          if (res.docType === 'todo' && !fm.data?.related_spec) {
            printNextStep([{ skill: 'dev-flow', text: `Todo 自审通过，移交 dev-flow 启动隔离实施：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${fm.data?.task_id ?? slugVal} --slug ${slugVal} --case 3 --todo "${res.file}"` }], { repoRoot: mainRoot })
          } else if (res.docType === 'spec' && String(fm.data?.status ?? '').toLowerCase() !== 'approved') {
            printNextStep([{ skill: 'dev-plan', text: `独立只读 Critique 通过后执行：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" critique-pass --file "${res.file}" --reviewer <criticId> --round 1` }], { repoRoot: mainRoot })
          }
        }
      }
      return res.ok ? 0 : 1
    }

    if (sub === 'critique-pass') {
      if (!opts.file || !opts.reviewer) throw new Error('critique-pass 需要 --file <docPath> 与 --reviewer <reviewerId>')
      const res = critiquePassDoc({ repoRoot, file: opts.file, reviewer: opts.reviewer, round: opts.round ?? 1, summary: opts.summary ?? '' })
      if (cli.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write(`Critique 通过记录已写入 ${res.file}（reviewer=${res.reviewer}, round=${res.round}, sha=${res.sha}）\n`)
        printNextStep([{ skill: 'dev-plan', text: `node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${res.file}"` }], { repoRoot: mainRoot })
      }
      return 0
    }

    if (sub === 'approve') {
      if (!opts.file) throw new Error('approve 需要 --file <specPath>')
      const res = approveSpec({ repoRoot, file: opts.file, skipCritiqueReason: opts['skip-critique-reason'] })
      const fm = parseDocFrontmatter(readTextSafe(resolve(repoRoot, res.file)) ?? '')
      const fn = parseDocFilename(res.file)
      const slugVal = fn?.slug ?? 'task'
      const issueNum = Number.isInteger(Number(fm.data?.issue)) && Number(fm.data.issue) > 0 ? Number(fm.data.issue) : (fn?.issue ?? null)
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
    if (cli.json && err?.audit) process.stdout.write(`${JSON.stringify({ ok: false, error: err.message, audit: err.audit }, null, 2)}\n`)
    process.stderr.write(`doc-plan 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
