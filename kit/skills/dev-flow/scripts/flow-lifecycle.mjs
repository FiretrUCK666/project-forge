/**
 * flow-lifecycle.mjs —— finalize（成对归档 + TDD 日期校验）、verify（尊重 none）、submit（同步 review 槽）与 rework。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 flow.mjs 调度。
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { printNextStep } from '../../lib/cli.mjs'
import {
  archiveCompletedDocsGroup, DOC_FRONTMATTER_KEY_ORDER, docIsoDate, evaluateCoupledSync,
  parseCoupledSyncRules, parseDocFilename, parseDocFrontmatter, updateDocFrontmatter,
} from '../../lib/docs.mjs'
import {
  detectInProgressGitOp, execShellCommand, gitDiffNameStatusZ, gitRun,
  gitStatusPorcelainZ, posixPath, readTextSafe, sha256Text, syncDetachedWorktree, writeAtomic,
} from '../../lib/git.mjs'
import { resolveTaskContext, writeTaskLedger } from '../../lib/ledger.mjs'
import { detectDeclaredRepo, parseRemotesTopology, parseRemoteUrls, probeGitHubEnv } from '../../lib/platform.mjs'
import { isProfileExplicitNone, parseAgentsProfile } from '../../lib/profile.mjs'
import { matchGlob, UI_VISUAL_EXT_RE } from '../../lib/static-gates.mjs'
import { buildTargetRepoContext, EXIT_POLICY_BLOCK, getChangedFiles, syncTaskDocsSafe } from './flow-inspect.mjs'
import { mountSharedDeps } from './worktree-deps.mjs'

function computeFlowCoupledSync(implRoot, mainRoot, changedFiles) {
  const agentsRoot = existsSync(join(implRoot, 'AGENTS.md')) ? implRoot : mainRoot
  const agentsText = readTextSafe(join(agentsRoot, 'AGENTS.md'))
  if (!agentsText) return []
  const rules = parseCoupledSyncRules(agentsText)
  return rules.length > 0 ? evaluateCoupledSync(changedFiles, rules, agentsRoot) : []
}

async function collectFinalizeChangedFiles(implRoot, ledger) {
  const merged = new Set(await getChangedFiles(implRoot, ledger.baseSha))
  for (const baseRef of [...new Set([ledger.baseBranch, 'main', 'master'].filter(Boolean))]) {
    const mb = await gitRun(implRoot, ['merge-base', baseRef, 'HEAD'])
    if (mb.ok && mb.stdout?.trim()) {
      for (const f of await getChangedFiles(implRoot, mb.stdout.trim())) merged.add(f)
      break
    }
  }
  return [...merged].sort()
}

function findUncheckedLines(text) {
  const out = []
  let inFence = false
  for (const line of String(text ?? '').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^- \[ \]/.test(line) && !/(?:<!--\s*waive:|\[waive:|豁免|跳过原因)/i.test(line)) {
      out.push(line.trim())
    }
  }
  return out
}

function findStrictDocBySlug(root, dirRel, ledger) {
  const abs = join(root, dirRel)
  if (!existsSync(abs)) return null
  try {
    for (const n of readdirSync(abs).filter((x) => x.endsWith('.md')).sort()) {
      const fn = parseDocFilename(n)
      if (fn && fn.slug === ledger.slug) return `${dirRel}/${n}`
      const fm = parseDocFrontmatter(readTextSafe(join(abs, n)) ?? '')
      if (fm.data?.task_id === ledger.taskId) return `${dirRel}/${n}`
    }
  } catch { /* ignore */ }
  return null
}

async function checkTddSyncParity(implRoot, changed, ledger) {
  const tddPath = join(implRoot, 'docs', 'TDD.md')
  const changedEntries = ledger.baseSha ? (await gitDiffNameStatusZ(implRoot, [`${ledger.baseSha}..HEAD`])).entries : []
  const st = await gitStatusPorcelainZ(implRoot)
  const touchedBoundary = changedEntries.some((e) =>
    (/^[ADR]/.test(e.status) && /^(?:src|lib|scripts|kit|packages|apps|services|backend|frontend)\//i.test(e.file))
    || /^(?:package\.json|Cargo\.toml|pyproject\.toml|go\.mod|go\.work|pom\.xml|build\.gradle(?:\.kts)?)$/i.test(basename(e.file)))
    || st.entries.some((e) => e.xy === '??' && /^(?:src|lib|scripts|kit|packages|apps|services|backend|frontend)\//i.test(e.file))
    || changed.some((f) => /^(?:src|lib|scripts|kit|bin|cmd)\/|package\.json$|Cargo\.toml$|pyproject\.toml$|go\.mod$|pom\.xml$/i.test(f))
  const touchedAnyDoc = changed.some((f) => /^(?:docs\/TDD\.md|README(?:\.[a-z0-9_-]+)?\.md|AGENTS\.md)$/i.test(f))
  let tddDateStale = false
  if (touchedBoundary && existsSync(tddPath)) {
    const tddText = readTextSafe(tddPath) ?? ''
    const today = docIsoDate()
    const hasMetaDate = /最近更新[^\n]*\d{4}-\d{2}-\d{2}/.test(tddText)
    if (hasMetaDate && !changed.includes('docs/TDD.md') && !tddText.includes(today)) tddDateStale = true
  }
  return {
    docParityReminder: touchedBoundary && !touchedAnyDoc,
    tddDateStale,
    tddSyncWarning: (touchedBoundary && !changed.includes('docs/TDD.md')) || tddDateStale
      ? '本次改动涉及模块目录边界或对外清单，请核对 docs/TDD.md 的最近更新日期与模块职责表并随本次提交更新。'
      : null,
  }
}

export async function handleFinalize(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`实施工作区不存在：${implRoot}`)

  const op = await detectInProgressGitOp(implRoot)
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突后再 finalize`)

  const headRes = await gitRun(implRoot, ['rev-parse', 'HEAD'])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  const today = docIsoDate()

  // contributor-fork：若上游仓库并未接入 docs/ 体系，严禁把本地私有 docs/ 混入 PR diff
  if (ledger.role === 'contributor-fork') {
    const baseRef = ledger.baseSha || ledger.baseBranch || 'HEAD'
    const baseTree = await gitRun(implRoot, ['ls-tree', '-r', '--name-only', baseRef, '--', 'docs/'])
    const baseDocs = baseTree.ok ? baseTree.stdout.split('\n').filter(Boolean) : []
    const upstreamUsesDocs = baseDocs.some((p) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/)/.test(p))
    if (!upstreamUsesDocs) {
      const committedDiff = ledger.baseSha ? await gitRun(implRoot, ['diff', '--name-only', `${ledger.baseSha}..HEAD`]) : { ok: false, stdout: '' }
      const committedDocs = (committedDiff.stdout || '').split('\n').filter((f) => /^docs\/(?:TDD\.md|specs\/|todo\/|prd\/|archive\/)/.test(f.trim()))
      if (committedDocs.length > 0) {
        process.stderr.write(`BLOCKED_FORK_PRIVATE_DOCS: 上游仓未接入 docs/ 体系，私有规划文件不应混入 Fork PR 提交：${committedDocs.join(', ')}\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
      for (const relDoc of [ledger.todoFile, ledger.specFile, ledger.prdFile].filter(Boolean)) {
        const docPath = join(implRoot, relDoc)
        if (!existsSync(docPath)) continue
        const unchecked = findUncheckedLines(readTextSafe(docPath) ?? '')
        if (unchecked.length > 0) {
          process.stderr.write(`BLOCKED_UNCHECKED_DOC: ${relDoc} 仍有未勾选验收条目：\n${unchecked.map((u) => `  ${u}`).join('\n')}\n`)
          return { exitCode: 1 }
        }
      }
      const privateKeepDir = join(roots.mainRoot, '.worktrees', '.state', 'private-docs', taskId)
      const relocated = []
      for (const [kind, relDoc] of [['todo', ledger.todoFile], ['spec', ledger.specFile], ['prd', ledger.prdFile]]) {
        if (!relDoc) continue
        const src = join(implRoot, relDoc)
        if (!existsSync(src)) continue
        await gitRun(implRoot, ['reset', '--', relDoc])
        mkdirSync(privateKeepDir, { recursive: true })
        const dst = join(privateKeepDir, basename(relDoc))
        try { renameSync(src, dst) } catch { copyFileSync(src, dst) }
        relocated.push(relDoc)
        const privRel = posixPath(`.worktrees/.state/private-docs/${taskId}/${basename(relDoc)}`)
        if (kind === 'todo') ledger.privateTodoFile = privRel
        if (kind === 'spec') ledger.privateSpecFile = privRel
        if (kind === 'prd') ledger.privatePrdFile = privRel
      }
      ledger.privateDocsDir = `.worktrees/.state/private-docs/${taskId}`
      const changedFork = await collectFinalizeChangedFiles(implRoot, ledger)
      const coupledSyncWarnings = computeFlowCoupledSync(implRoot, roots.mainRoot, changedFork)
      ledger.finalized = true
      ledger.finalizedHead = currentHead
      ledger.status = 'finalized'
      writeTaskLedger(roots.mainRoot, ledger)
      const res = { taskId, role: ledger.role, upstreamUsesDocs: false, privateDocsIsolated: true, relocatedPrivateDocs: relocated, finalizedHead: currentHead, coupledSyncWarnings }
      if (opts.json) process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      else {
        process.stdout.write('Fork finalize 完成（上游未接入 docs/，私有规划已安全隔离到 .worktrees/.state/private-docs/）。\n')
        printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` }], { repoRoot: roots.mainRoot })
      }
      if (opts['strict-sync'] && coupledSyncWarnings.length > 0) {
        process.stderr.write(`BLOCKED_COUPLED_SYNC: 触发 AGENTS.md「改哪看哪」联动同步规则（共 ${coupledSyncWarnings.length} 组）。\n`)
        return { exitCode: 1 }
      }
      return { exitCode: 0 }
    }
  }

  const todoRel = ledger.todoFile ?? findStrictDocBySlug(implRoot, 'docs/todo', ledger)
  const specRel = ledger.specFile ?? findStrictDocBySlug(implRoot, 'docs/specs', ledger)
  const prdRel = ledger.prdFile ?? findStrictDocBySlug(implRoot, 'docs/prd', ledger)

  for (const [label, relDoc] of [['TODO', todoRel], ['SPEC', specRel], ['PRD', prdRel]]) {
    if (!relDoc) continue
    const absDoc = join(implRoot, relDoc)
    if (!existsSync(absDoc)) continue
    const unchecked = findUncheckedLines(readTextSafe(absDoc) ?? '')
    if (unchecked.length > 0) {
      process.stderr.write(`BLOCKED_UNCHECKED_${label}: ${relDoc} 仍有未勾选验收条目：\n${unchecked.map((u) => `  ${u}`).join('\n')}\n`)
      return { exitCode: 1 }
    }
  }

  if (specRel && existsSync(join(implRoot, specRel))) {
    const specAbs = join(implRoot, specRel)
    let specText = readTextSafe(specAbs) ?? ''
    if (!/^##\s+实现说明\s*$/m.test(specText)) specText = `${specText.trimEnd()}\n\n## 实现说明\n\n`
    const secStart = specText.search(/^##\s+实现说明\s*$/m)
    const afterSec = specText.slice(secStart)
    const nextH2 = afterSec.slice(1).search(/\n##\s+/)
    const secBody = (nextH2 > 0 ? afterSec.slice(0, nextH2 + 1) : afterSec).replace(/^##\s+实现说明\s*\n?/, '')
    if (/<!--\s*project-forge:\s*fill|\b(?:TBD|TODO|FIXME)\b/i.test(secBody)) {
      process.stderr.write(`BLOCKED_SPEC_IMPL_NOTE_EMPTY: ${specRel} 的「实现说明」仍含未填占位，请补齐真实说明后再 finalize。\n`)
      return { exitCode: 1 }
    }
    if (!secBody.replace(/<!--[\s\S]*?-->/g, '').trim()) {
      const autoSummary = [`- 实现提交基线: ${currentHead ?? 'uncommitted'}`, `- 关联任务: ${taskId}`, opts.note ? `- 说明: ${opts.note}` : null].filter(Boolean).join('\n')
      specText = specText.replace(/(^##\s+实现说明\s*\n(?:<!--[\s\S]*?-->\s*\n?)?)/m, `$1\n${autoSummary}\n`)
    }
    writeAtomic(specAbs, specText)
  }

  let archivedGroup = { moved: [], byKind: { prd: prdRel, spec: specRel, todo: todoRel } }
  if (prdRel || specRel || todoRel) {
    archivedGroup = await archiveCompletedDocsGroup(implRoot, {
      prdFile: prdRel, specFile: specRel, todoFile: todoRel, slugOrPath: specRel ?? todoRel ?? prdRel ?? ledger.slug,
      issue: ledger.linkedIssues?.[0], pr: ledger.prNumber ?? undefined, branch: ledger.branch, owner: ledger.implementerId ?? undefined, doneAt: today,
    })
    if (archivedGroup.byKind.prd) { ledger.prdFile = archivedGroup.byKind.prd; ledger.archivedPrdFile = archivedGroup.byKind.prd }
    if (archivedGroup.byKind.spec) { ledger.specFile = archivedGroup.byKind.spec; ledger.archivedSpecFile = archivedGroup.byKind.spec }
    if (archivedGroup.byKind.todo) { ledger.todoFile = archivedGroup.byKind.todo; ledger.archivedTodoFile = archivedGroup.byKind.todo }
  }

  const changed = await collectFinalizeChangedFiles(implRoot, ledger)
  const parity = await checkTddSyncParity(implRoot, changed, ledger)
  const coupledSyncWarnings = computeFlowCoupledSync(implRoot, roots.mainRoot, changed)

  ledger.finalized = true
  ledger.finalizedHead = currentHead
  ledger.status = 'finalized'
  writeTaskLedger(roots.mainRoot, ledger)

  const out = {
    taskId, finalized: true, finalizedHead: currentHead,
    prdFile: ledger.prdFile, specFile: ledger.specFile, todoFile: ledger.todoFile,
    archivedDocs: archivedGroup.moved,
    docParityReminder: parity.docParityReminder,
    tddSyncWarning: parity.tddSyncWarning,
    coupledSyncWarnings,
  }
  if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
  else {
    process.stdout.write(`finalize 完成：HEAD=${currentHead ?? 'uncommitted'}，Todo=${ledger.todoFile ?? '无'}，SPEC=${ledger.specFile ?? '无'}\n`)
    if (parity.tddSyncWarning) process.stdout.write(`[TDD SYNC REMINDER]: ${parity.tddSyncWarning}\n`)
    for (const w of coupledSyncWarnings) {
      process.stdout.write(`[COUPLED SYNC]: 触及 ${w.touchedTriggers.join(', ')} -> 需检查伴随更新 ${w.expectedCompanions.join(', ')}\n`)
    }
    printNextStep([
      '1. 若 finalize 移动或更新了文档，先在工作区提交变更：git add -A && git commit -m "..."',
      { skill: 'dev-flow', text: `2. 运行实证门禁锁定 HEAD：node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` },
    ], { repoRoot: roots.mainRoot })
  }
  if (opts['strict-sync'] && coupledSyncWarnings.length > 0) {
    process.stderr.write(`BLOCKED_COUPLED_SYNC: 触发 AGENTS.md「改哪看哪」联动同步规则且未更新伴随文件（共 ${coupledSyncWarnings.length} 组）。\n`)
    return { exitCode: 1 }
  }
  return { exitCode: 0 }
}

export async function handleVerify(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

  const op = await detectInProgressGitOp(implRoot)
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突再执行 verify`)

  const profile = parseAgentsProfile(implRoot)
  const mode = opts.tier ?? opts.mode ?? 'quick'
  if (!['quick', 'smoke', 'full', 'gate'].includes(mode)) {
    process.stderr.write(`INVALID_VERIFY_MODE: --mode / --tier 仅支持 quick | smoke | full | gate，收到：${mode}\n`)
    return { exitCode: 1 }
  }
  let rawTarget = opts.target !== undefined ? String(opts.target).trim() : null
  if (rawTarget !== null) {
    if (!rawTarget || /[;&|`$><\r\n]/.test(rawTarget)) {
      process.stderr.write(`INVALID_TARGET_ARG: --target 值非法或含不允许的元字符：${opts.target}\n`)
      return { exitCode: 1 }
    }
    rawTarget = posixPath(rawTarget)
  }

  const keyByMode = { quick: 'quick-test', smoke: 'smoke-verify', full: 'full-test', gate: 'merge-gate' }
  const profileKey = keyByMode[mode]
  const isExplicitNone = !opts.cmd && isProfileExplicitNone(profile, profileKey)

  let cmd = opts.cmd
  if (!cmd && !isExplicitNone) {
    if (mode === 'gate') cmd = profile.mergeGate ?? profile.fullTest ?? profile.quickTest
    else if (mode === 'full') cmd = profile.fullTest ?? profile.quickTest
    else if (mode === 'smoke') cmd = profile.smokeVerify
    else cmd = profile.quickTest
  }

  if (!cmd && isExplicitNone) {
    const [headRes, stRes, changedFiles] = await Promise.all([
      gitRun(implRoot, ['rev-parse', 'HEAD']),
      gitRun(implRoot, ['status', '--porcelain']),
      getChangedFiles(implRoot, ledger.baseSha),
    ])
    const currentHead = headRes.ok ? headRes.stdout.trim() : null
    ledger.verifiedHead = currentHead
    ledger.verifiedCmd = 'none (explicitly disabled)'
    ledger.verifiedMode = mode
    ledger.verifiedTarget = rawTarget
    ledger.verifiedDirtyHash = sha256Text(stRes.stdout)
    ledger.lastVerifyExitCode = 0
    ledger.visualFilesChanged = changedFiles.filter((f) => UI_VISUAL_EXT_RE.test(f))
    ledger.empiricalVisualCheckRequired = ledger.visualFilesChanged.length > 0
    ledger.status = 'verified'
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ taskId, mode, cmd: ledger.verifiedCmd, skippedReason: 'explicit-none', ok: true, exitCode: 0, verifiedHead: currentHead }, null, 2)}\n`)
    } else {
      process.stdout.write(`verify (${mode}): AGENTS.md Dev Profile 显式配置 \`${profileKey}: none\`，已放行并绑定 HEAD=${currentHead ?? 'unborn'}\n`)
      printNextStep([{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  if (!cmd) {
    process.stderr.write(`NO_VERIFY_COMMAND: 未从 AGENTS.md Dev Profile 或项目清单识别到 ${mode} 验证命令，请通过 --cmd "<命令>" 显式传入（纯文档仓请配 \`${profileKey}: none\`）。\n`)
    return { exitCode: 1 }
  }

  let targetTip = null
  if (cmd.includes('{target}')) {
    if (rawTarget) {
      const safeTarget = /\s/.test(rawTarget) ? `"${rawTarget}"` : rawTarget
      cmd = cmd.replace(/\{target\}/g, safeTarget)
    } else if (mode === 'quick') {
      cmd = cmd.replace(/\s*(?:--[A-Za-z0-9_-]+(?:=|\s+)|-[A-Za-z]\s+)?\{target\}\s*/g, ' ').replace(/\s+/g, ' ').trim()
      targetTip = '提示：quick 分层未传入 --target <path>，已省略 {target} 执行；单测迭代建议传 --target <path> 缩窄范围。'
    } else {
      process.stderr.write(`MISSING_TARGET_ARG: 验证命令 "${cmd}" 含 {target} 占位符，请追加 --target <file> 指定单测文件或用例。\n`)
      return { exitCode: 1 }
    }
  }

  const runRes = await execShellCommand(cmd, implRoot)
  const [headRes, stRes, changedFiles] = await Promise.all([
    gitRun(implRoot, ['rev-parse', 'HEAD']),
    gitRun(implRoot, ['status', '--porcelain']),
    getChangedFiles(implRoot, ledger.baseSha),
  ])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  const visualFilesChanged = changedFiles.filter((f) => UI_VISUAL_EXT_RE.test(f))
  const empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const hasVisualCheckFlag = Boolean(opts['visual-checked'] || opts['visual-evidence'])

  ledger.verifiedHead = runRes.ok ? currentHead : null
  ledger.verifiedCmd = cmd
  ledger.verifiedMode = mode
  ledger.verifiedTarget = rawTarget
  ledger.verifiedDirtyHash = sha256Text(stRes.stdout)
  ledger.lastVerifyExitCode = runRes.code
  ledger.visualFilesChanged = visualFilesChanged
  ledger.empiricalVisualCheckRequired = empiricalVisualCheckRequired
  if (runRes.ok && hasVisualCheckFlag) {
    ledger.visualVerifiedHead = currentHead
    ledger.visualCheckEvidence = typeof opts['visual-evidence'] === 'string'
      ? opts['visual-evidence']
      : (ledger.visualCheckEvidence ?? '实际渲染、端到端交互与浅深色截图核验已确认')
  }
  ledger.status = runRes.ok ? 'verified' : 'verify-failed'
  writeTaskLedger(roots.mainRoot, ledger)

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      taskId, mode, target: rawTarget, cmd, ...(targetTip ? { targetTip } : {}),
      ok: runRes.ok, exitCode: runRes.code, verifiedHead: ledger.verifiedHead,
      visualFilesChanged, empiricalVisualCheckRequired,
      visualVerifiedHead: ledger.visualVerifiedHead, visualCheckEvidence: ledger.visualCheckEvidence,
      stdout: runRes.stdout, stderr: runRes.stderr,
    }, null, 2)}\n`)
  } else {
    if (runRes.stdout) process.stdout.write(`${runRes.stdout}\n`)
    if (runRes.stderr) process.stderr.write(`${runRes.stderr}\n`)
    if (targetTip) process.stdout.write(`${targetTip}\n`)
    process.stdout.write(`verify (${mode}${rawTarget ? ` target=${rawTarget}` : ''}): cmd="${cmd}" exit=${runRes.code} HEAD=${currentHead ?? 'unborn'}\n`)
    if (runRes.ok) {
      const next = [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId}` }]
      if (empiricalVisualCheckRequired && ledger.visualVerifiedHead !== currentHead) {
        next.unshift(`检测到 UI/视觉改动（${visualFilesChanged.slice(0, 5).join(', ')}）：请核验实际渲染、交互与浅深色截图后补 --visual-checked。`)
      }
      printNextStep(next, { repoRoot: roots.mainRoot })
    } else {
      printNextStep([`验证未通过（exit=${runRes.code}），请修复后重新运行 verify。`], { repoRoot: roots.mainRoot })
    }
  }
  return { exitCode: runRes.ok ? 0 : (runRes.code || 1) }
}

export async function handleSubmit(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  if (!existsSync(implRoot)) throw new Error(`工作区目录不存在：${implRoot}`)

  const op = await detectInProgressGitOp(implRoot)
  if (op.inProgress) throw new Error(`BLOCKED_GIT_CONFLICT_IN_PROGRESS: 工作区正处于 ${op.op} 冲突状态，请先解决冲突`)

  const [headRes, stZ] = await Promise.all([gitRun(implRoot, ['rev-parse', 'HEAD']), gitStatusPorcelainZ(implRoot)])
  const currentHead = headRes.ok ? headRes.stdout.trim() : null
  if (stZ.entries.length > 0) {
    process.stderr.write('BLOCKED_DIRTY_WORKTREE: 存在未提交改动，请先提交后再运行 verify 与 submit。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const needsFinalize = ledger.caseType === 3 || ledger.caseType === 4 || Boolean(ledger.todoFile) || Boolean(ledger.specFile)
  if (needsFinalize) {
    if (!ledger.finalized) {
      process.stderr.write(`BLOCKED_NOT_FINALIZED: Case ${ledger.caseType} 任务必须先执行 flow.mjs finalize --task ${taskId} 完成文档同步锁。\n`)
      return { exitCode: EXIT_POLICY_BLOCK }
    }
    if (ledger.finalizedHead && currentHead && ledger.finalizedHead !== currentHead) {
      const postFin = await gitDiffNameStatusZ(implRoot, [`${ledger.finalizedHead}..${currentHead}`])
      const nonDocChanges = postFin.entries.map((e) => e.file).filter((f) => f && !/^docs\//.test(f))
      if (nonDocChanges.length > 0) {
        process.stderr.write(`BLOCKED_STALE_FINALIZE: finalize 之后又改了非文档文件（${nonDocChanges.join(', ')}），请重新运行 finalize。\n`)
        return { exitCode: EXIT_POLICY_BLOCK }
      }
    }
  }

  if (ledger.lastVerifyExitCode !== 0 || (currentHead && ledger.verifiedHead !== currentHead)) {
    if (!ledger.verifiedHead) {
      process.stderr.write(`BLOCKED_NOT_VERIFIED: 提交前必须先运行并通过 flow.mjs verify --task ${taskId}。\n`)
    } else {
      process.stderr.write(`BLOCKED_STALE_VERIFICATION: 代码已变更（verifiedHead=${String(ledger.verifiedHead).slice(0, 7)} !== HEAD=${currentHead?.slice(0, 7)}），必须重跑 verify。\n`)
    }
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const changedForVisual = await getChangedFiles(implRoot, ledger.baseSha)
  const visualFilesChanged = changedForVisual.filter((f) => UI_VISUAL_EXT_RE.test(f))
  ledger.visualFilesChanged = visualFilesChanged
  ledger.empiricalVisualCheckRequired = visualFilesChanged.length > 0
  const visualVerifiedOnHead = ledger.empiricalVisualCheckRequired && ledger.visualVerifiedHead === currentHead

  if (ledger.role === 'clone-readonly') {
    process.stderr.write('BLOCKED_CLONE_READONLY: 当前身份为只读克隆，禁止推送；请先走 Fork 或本地模式。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  // Tier 2 在提交独立审查前自动将干净 .worktrees/review-{taskId} 同步推进到 currentHead 并挂载依赖，彻底消除空 diff
  let reviewSlotSync = null
  if (ledger.tier === 2 && currentHead && ledger.reviewWorktreePath) {
    const reviewAbs = resolve(roots.mainRoot, ledger.reviewWorktreePath)
    reviewSlotSync = await syncDetachedWorktree(roots.mainRoot, reviewAbs, currentHead)
    const revDeps = mountSharedDeps(roots.mainRoot, reviewAbs)
    ledger.reviewWorktreeHead = currentHead
    reviewSlotSync.depsMode = revDeps.mode
  }

  const nextRound = (ledger.rounds ?? []).length > 0
    ? Math.max(...ledger.rounds.map((r) => Number(r.round) || 1)) + 1
    : 1

  if (ledger.role === 'local-only') {
    ledger.status = 'local-ready'
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify({ ...ledger, reviewSlotSync }, null, 2)}\n`)
    else {
      process.stdout.write(`本地模式提交校验已通过（HEAD=${currentHead?.slice(0, 7)}，未配置远端不执行 push）。\n`)
      printNextStep([{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const remoteRes = await gitRun(roots.mainRoot, ['remote', '-v'])
  const remoteUrls = parseRemoteUrls(remoteRes.stdout)
  const topology = parseRemotesTopology(remoteRes.stdout)
  const declaredRepo = detectDeclaredRepo(roots.mainRoot)
  const { originFull, originLower, upstreamLower, targetRepo, pushRemote } = buildTargetRepoContext(ledger.role, remoteUrls, declaredRepo, topology)

  if (ledger.role === 'contributor-fork' && originLower && upstreamLower && originLower === upstreamLower) {
    process.stderr.write('BLOCKED_FORK_REMOTE_LOCK: origin 与 upstream 指向相同仓，禁止直接向正本推送。\n')
    return { exitCode: EXIT_POLICY_BLOCK }
  }

  const pushRes = await gitRun(implRoot, ['push', '-u', pushRemote, ledger.branch])
  if (!pushRes.ok) throw new Error(`推送到 ${pushRemote}/${ledger.branch} 失败：${pushRes.stderr}`)

  if (ledger.role === 'generic-git' || ledger.providerId === 'generic-git' || !targetRepo) {
    ledger.status = 'submitted'
    writeTaskLedger(roots.mainRoot, ledger)
    if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, providerId: ledger.providerId, status: ledger.status, head: currentHead, pushRemote, reviewSlotSync }, null, 2)}\n`)
    else {
      process.stdout.write(`submit 完成：已推送至 ${pushRemote}/${ledger.branch} @ ${currentHead?.slice(0, 7)}（generic-git 模式跳过平台 API）。\n`)
      printNextStep([{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}` }], { repoRoot: roots.mainRoot })
    }
    return { exitCode: 0 }
  }

  const ghProbe = await probeGitHubEnv({ cwd: roots.mainRoot, remoteUrls })
  const isRework = Boolean(opts.rework) || Boolean(ledger.prNumber)
  const shortHead = currentHead?.slice(0, 7) ?? 'unknown'
  const fixesLine = (ledger.linkedIssues ?? []).map((n) => `Fixes #${n}`).join('\n')
  const originOwner = originFull ? originFull.split('/')[0] : null
  const headSpec = ledger.role === 'contributor-fork' && originOwner ? `${originOwner}:${ledger.branch}` : ledger.branch

  let prResult = null
  const commentResults = []
  if (isRework && ledger.prNumber) {
    const reworkMsg = [`返工已提交：新 HEAD \`${shortHead}\``, `- 验证命令：\`${ledger.verifiedCmd}\`（退出码 0）`, '- 请重新审核（更新同一 PR）。'].join('\n')
    prResult = { reusedPr: ledger.prNumber, head: shortHead }
    commentResults.push({
      target: `PR #${ledger.prNumber}`,
      res: await ghProbe.client.postComment({ repo: targetRepo, number: ledger.prNumber, body: reworkMsg, statePayload: { taskId, action: 'rework-submitted', headSha: currentHead } }),
    })
    for (const iss of ledger.linkedIssues ?? []) {
      commentResults.push({
        target: `Issue #${iss}`,
        res: await ghProbe.client.postComment({ repo: targetRepo, number: iss, body: `${reworkMsg}\n- 关联 PR: #${ledger.prNumber}`, statePayload: { taskId, action: 'rework-submitted', prNumber: ledger.prNumber, headSha: currentHead } }),
      })
    }
  } else {
    const title = opts.title ?? `${ledger.caseType === 2 ? 'fix' : 'feat'}: ${ledger.slug}`
    const body = opts.body ?? [
      '## 改动说明', `- 任务编号：\`${taskId}\``, `- 验证命令：\`${ledger.verifiedCmd}\` @ \`${shortHead}\``,
      ledger.empiricalVisualCheckRequired
        ? `- 视觉与交互实证：${visualVerifiedOnHead ? `已核验（${ledger.visualCheckEvidence ?? 'confirmed'}）` : `涉及 UI/视觉文件（${visualFilesChanged.slice(0, 5).join(', ')}），审查须核对实际渲染与浅深色截图`}`
        : null,
      fixesLine ? `\n${fixesLine}` : null, '', '## 实现依据', `- role=${ledger.role}, case=${ledger.caseType}, isolation=${ledger.isolation}`,
    ].filter((x) => x !== null).join('\n')

    prResult = await ghProbe.client.createPr({ targetRepo, head: headSpec, base: ledger.baseBranch, title, body, draft: Boolean(opts.draft) })
    if (prResult.ok && prResult.number) {
      ledger.prNumber = prResult.number
      ledger.prUrl = prResult.url ?? null
      for (const iss of ledger.linkedIssues ?? []) {
        commentResults.push({
          target: `Issue #${iss}`,
          res: await ghProbe.client.postComment({ repo: targetRepo, number: iss, body: `已提 PR：#${prResult.number}${prResult.url ? ` (${prResult.url})` : ''}\nFixes #${iss}`, statePayload: { taskId, action: 'pr-created', prNumber: prResult.number } }),
        })
      }
    }
  }

  if (ledger.prNumber) {
    await syncTaskDocsSafe(implRoot, ledger, { pr: ledger.prNumber, status: 'in_review', preserveTerminalStatus: true })
    const archRel = ledger.archivedTodoFile || (ledger.todoFile?.startsWith('docs/archive/') ? ledger.todoFile : null)
    if (archRel && existsSync(join(implRoot, archRel))) {
      const archRaw = readTextSafe(join(implRoot, archRel)) ?? ''
      if (parseDocFrontmatter(archRaw).hasFrontmatter) {
        updateDocFrontmatter(join(implRoot, archRel), { pr: ledger.prNumber, updated: today }, { defaultKeyOrder: DOC_FRONTMATTER_KEY_ORDER.todo })
      }
    }
  }

  ledger.status = ledger.role === 'contributor-fork' ? 'awaiting-upstream-merge' : 'submitted'
  writeTaskLedger(roots.mainRoot, ledger)
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, role: ledger.role, status: ledger.status, head: currentHead, prResult, commentResults, reviewSlotSync }, null, 2)}\n`)
  else {
    process.stdout.write(`submit 完成：已推分支 ${pushRemote}/${ledger.branch} @ ${shortHead}，状态=${ledger.status}\n`)
    if (prResult?.oneClickPrUrl) process.stdout.write(`- 一键创建 PR 链接：${prResult.oneClickPrUrl}\n`)
    if (prResult?.delegated) process.stdout.write(`- 待宿主 MCP 代理执行 PR 载荷：${JSON.stringify(prResult.jsonPayload)}\n`)
    printNextStep([
      ledger.role === 'contributor-fork'
        ? '当前处于 awaiting-upstream-merge，请等待上游维护者合并；合并前严禁删除该 Fork 分支。'
        : { skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}` },
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}

export async function handleRework(opts, roots) {
  const ctx = await resolveTaskContext(roots, opts)
  const { taskId, ledger } = ctx
  const implRoot = ledger.worktreePath ? resolve(roots.mainRoot, ledger.worktreePath) : roots.mainRoot
  const profile = parseAgentsProfile(implRoot)
  const changed = await getChangedFiles(implRoot, ledger.baseSha)

  // 豁免由 finalize 成对自动归档移入 docs/archive/ 的关联文档，避免与 do-not-edit: docs/archive/ 自相冲突
  const ownArchived = new Set([ledger.archivedTodoFile, ledger.archivedSpecFile, ledger.archivedPrdFile].filter(Boolean))
  const forbiddenTouched = changed.filter((f) => !ownArchived.has(f) && profile.doNotEdit.some((pat) => matchGlob(f, pat)))
  const rebutsInput = Array.isArray(opts.rebut) ? opts.rebut : (opts.rebut ? [opts.rebut] : [])
  const addedRebuts = []

  for (const raw of rebutsInput) {
    const idx = raw.indexOf(':')
    const findingId = idx > 0 ? raw.slice(0, idx).trim() : 'general'
    const reason = idx > 0 ? raw.slice(idx + 1).trim() : raw.trim()
    const item = { findingId, reason, recordedAt: new Date().toISOString() }
    addedRebuts.push(item)
    ledger.rebuts = [...(ledger.rebuts ?? []), item]
    if ((ledger.rounds ?? []).length > 0) {
      const last = ledger.rounds[ledger.rounds.length - 1]
      last.rebuts = [...(last.rebuts ?? []), item]
    }
  }

  ledger.status = 'rework'
  writeTaskLedger(roots.mainRoot, ledger)
  if (opts.json) process.stdout.write(`${JSON.stringify({ taskId, branch: ledger.branch, prNumber: ledger.prNumber, forbiddenTouched, addedRebuts }, null, 2)}\n`)
  else {
    process.stdout.write(`进入返工模式（task=${taskId}，原分支=${ledger.branch}，原 PR=${ledger.prNumber ?? '待创建'}）：\n`)
    if (forbiddenTouched.length > 0) process.stdout.write(`- 警告：以下变更命中 do-not-edit 列表：${forbiddenTouched.join(', ')}\n`)
    if (addedRebuts.length > 0) process.stdout.write(`- 已记录 ${addedRebuts.length} 条有据反驳。\n`)
    printNextStep([
      { skill: 'dev-flow', text: `1. node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${taskId}` },
      { skill: 'dev-flow', text: `2. node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${taskId} --rework` },
    ], { repoRoot: roots.mainRoot })
  }
  return { exitCode: 0 }
}
