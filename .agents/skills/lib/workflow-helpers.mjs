/**
 * workflow-helpers.mjs —— PR 模板回填、多 Issue 拓扑、交棒下一步构造与多任务波次排期。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 workflow-policy.mjs 重导出。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { isManagedPlanDoc, parseDocFilename, parseDocFrontmatter } from './doc-frontmatter.mjs'
import { formatWorkTitle } from './escalation.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { parseBodyRelations } from './platform.mjs'

function replaceSectionBody(md, headingTitle, newBody) {
  const re = new RegExp(`(^##\\s+${headingTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$)([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, 'm')
  if (!re.test(md)) return `${md.trimEnd()}\n\n## ${headingTitle}\n\n${newBody}\n`
  return md.replace(re, `$1\n\n${newBody}\n`)
}

/** 读取 `.github/pull_request_template.md` 并注入任务上下文、`Fixes #N`、实证输出与 `pf-state`。 */
export function hydratePrTemplateBody({
  repoRoot,
  taskId,
  ledger,
  policy = null,
  actorDisplay = 'maintainer',
  visualFilesChanged = [],
  visualVerifiedOnHead = false,
  currentHead = '',
  changedFiles = [],
} = {}) {
  const shortHead = String(currentHead ?? '').slice(0, 7) || 'unknown'
  const fixesLine = (ledger?.linkedIssues ?? []).map((n) => `Fixes #${n}`).join('\n') || '无（独立变更任务）'
  const docLinks = [ledger?.specFile, ledger?.todoFile, ledger?.prdFile].filter(Boolean)
  const docSummary = docLinks.length > 0 ? docLinks.map((p) => `\`${p}\``).join('、') : `无（Case ${ledger?.caseType ?? 3}）`
  const pfTag = `<!-- pf-state:${JSON.stringify({ taskId, action: 'pr-body', branch: ledger?.branch ?? null, headSha: currentHead || null })} -->`

  const tplPath = repoRoot ? join(repoRoot, '.github', 'pull_request_template.md') : ''
  const tplRaw = tplPath && existsSync(tplPath) ? readTextSafe(tplPath) : null
  if (!tplRaw) {
    return [
      '## 改动说明',
      `- 任务编号：\`${taskId}\``,
      `- 提交人：${actorDisplay}`,
      `- 验证命令：\`${ledger?.verifiedCmd ?? 'verified'}\` @ \`${shortHead}\``,
      visualFilesChanged.length > 0
        ? `- 视觉与交互实证：${visualVerifiedOnHead ? `已核验（${ledger?.visualCheckEvidence ?? 'confirmed'}）` : `涉及 UI/视觉文件（${visualFilesChanged.slice(0, 5).join(', ')}），审查须核对实际渲染与浅深色截图`}`
        : null,
      `\n${fixesLine}`,
      '',
      '## 实现依据',
      `- role=${ledger?.role ?? 'unknown'}, case=${ledger?.caseType ?? 3}, risk=${policy?.riskTier ?? 'medium'}, isolation=${ledger?.isolation ?? 'worktree'}`,
      `- 关联文档：${docSummary}`,
      '',
      pfTag,
    ].filter((x) => x !== null).join('\n')
  }

  let body = tplRaw.replace(/\r\n/g, '\n')
  body = replaceSectionBody(body, '改了什么', `- \`${formatWorkTitle(ledger?.slug ?? taskId, ledger?.caseType)}\`（任务 \`${taskId}\`，提交人：${actorDisplay}，涉及 ${changedFiles.length} 个文件）`)
  body = replaceSectionBody(body, '关联 Issue', fixesLine)
  body = replaceSectionBody(body, '为什么', `- 完成任务 \`${taskId}\` 并同步对应工程文档。\n\n关联文档: ${docSummary}`)
  body = replaceSectionBody(body, '实现依据', `1. 分档：Case ${ledger?.caseType ?? 3}（risk=${policy?.riskTier ?? 'medium'}）\n2. 隔离：\`${ledger?.worktreePath ?? 'branch'}\` / 分支 \`${ledger?.branch ?? 'unknown'}\`\n3. 关联文档：${docSummary}`)
  const verifyText = [
    `- 命令：\`${ledger?.verifiedCmd ?? 'verified'}\`（mode=${ledger?.verifiedMode ?? 'quick'}，exit=${ledger?.lastVerifyExitCode ?? 0}，HEAD=\`${shortHead}\`）`,
    visualFilesChanged.length > 0
      ? `- 视觉核验：${visualVerifiedOnHead ? `已核验（${ledger?.visualCheckEvidence ?? 'confirmed'}）` : `涉及 ${visualFilesChanged.slice(0, 5).join(', ')}`}`
      : null,
  ].filter(Boolean).join('\n')
  body = replaceSectionBody(body, '怎么验证的', verifyText)
  body = replaceSectionBody(body, '回滚点', `- 回滚基线：\`${String(ledger?.baseSha ?? '').slice(0, 7) || ledger?.baseBranch || 'main'}\`（反向提交 \`git revert\` 并重跑门禁）`)
  body = replaceSectionBody(body, '风险与影响范围', `- 风险等级：\`${policy?.riskTier ?? 'medium'}\`${policy?.highRiskHits?.length ? `（命中高风险路径：${policy.highRiskHits.slice(0, 5).join(', ')}）` : ''}`)
  body = replaceSectionBody(body, '合并授权', policy?.independentReviewRequired === false ? '- 低风险纯文档改动：门禁绿灯可直接合入' : '- 独立审查 `fail` 为空且 CI 绿灯后由审查者合入（若含弱化门禁须人工确认）')
  body = replaceSectionBody(body, '独立审查与故障注入', policy?.independentReviewRequired === false
    ? '低风险纯非可执行文档改动，免除独立审查子代理（已完成本地静态文档门禁）。'
    : `- **审查来源**：待独立审查子代理接手\n- **逐条标准状态**：待 Round 1 核对（HEAD \`${shortHead}\`）\n- **故障注入记录**：待补充\n- **止损记录**：未触发`)
  return `${body.trimEnd()}\n\n${pfTag}\n`
}

/** 对多个 Issue 依正文提取出的 Depends on / Blocks 关系进行拓扑排序与策略建议。 */
export function analyzeIssueDependencies(issueItems = []) {
  const byNum = new Map()
  for (const it of issueItems) if (Number.isInteger(it?.number)) byNum.set(it.number, it)
  const nums = [...byNum.keys()]
  if (nums.length <= 1) {
    return { hasDependencies: false, orderedIssues: nums, edges: [], hasCycle: false, strategy: nums.length === 1 ? 'single-issue' : 'none' }
  }
  const adj = new Map(nums.map((n) => [n, new Set()]))
  const indeg = new Map(nums.map((n) => [n, 0]))
  const edges = []
  const addEdge = (from, to, kind) => {
    if (!byNum.has(from) || !byNum.has(to) || from === to || adj.get(from).has(to)) return
    adj.get(from).add(to)
    indeg.set(to, (indeg.get(to) ?? 0) + 1)
    edges.push({ from, to, kind })
  }
  for (const item of byNum.values()) {
    const rel = item.relations ?? parseBodyRelations(item.body ?? '')
    for (const dep of rel.dependsOn ?? []) addEdge(dep, item.number, 'depends-on')
    for (const blk of rel.blocks ?? []) addEdge(item.number, blk, 'blocks')
  }
  const queue = nums.filter((n) => indeg.get(n) === 0).sort((a, b) => a - b)
  const ordered = []
  while (queue.length > 0) {
    const cur = queue.shift()
    ordered.push(cur)
    for (const next of adj.get(cur)) {
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0) { queue.push(next); queue.sort((a, b) => a - b) }
    }
  }
  const hasCycle = ordered.length < nums.length
  if (hasCycle) for (const n of nums.sort((a, b) => a - b)) if (!ordered.includes(n)) ordered.push(n)
  const parents = new Set()
  for (const it of byNum.values()) for (const p of it.relations?.partOf ?? []) parents.add(p)
  return {
    hasDependencies: edges.length > 0, orderedIssues: ordered, edges, hasCycle,
    strategy: edges.length > 0 ? 'serial-order' : (parents.size === 1 ? 'same-branch-or-parallel' : 'parallel-or-combine'),
  }
}

/** 构造 `flow.mjs submit` 结束时的下一步唯一合法动作（避免 lightweight 档引导不存在的 review-pack.mjs）。 */
export function buildSubmitNextSteps({ taskId, role, policy, nextRound = 1, hasDevReview = true } = {}) {
  if (role === 'contributor-fork') {
    return ['当前处于 awaiting-upstream-merge，请等待上游维护者合并；合并前严禁删除该 Fork 分支。']
  }
  if (hasDevReview && policy?.independentReviewRequired !== false) {
    return [{ skill: 'dev-review', text: `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${taskId} --round ${nextRound}` }]
  }
  const remoteFlag = role === 'generic-git' ? ' --remote-merged' : ''
  const approveFlag = policy?.humanApprovalRequired ? ' --human-approved --reason "<确认原因>"' : ''
  return [{ skill: 'dev-flow', text: `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${taskId}${remoteFlag}${approveFlag}` }]
}

/** 构造 `flow.mjs inspect` 结束时的下一步指引（在 lightweight 档阻断外部 PR 并指引升档而非打印 review-pack.mjs）。 */
export function buildInspectNextSteps({ role, teamProbeHint, extPrNum, reuseExistingPr, hasDevReview = true } = {}) {
  if (extPrNum) {
    if (!hasDevReview) {
      return ['当前项目为 lightweight 档且未装配 dev-review，外部 PR 不可信扫描与审查需先升级为 full 档（--tier full）。']
    }
    return [
      { skill: 'dev-flow', text: `1. 建立只读隔离审查位（不挂载依赖）：node ".agents/skills/dev-flow/scripts/flow.mjs" start --external-pr ${extPrNum}` },
      { skill: 'dev-review', text: `2. 先跑不可信供应链静态扫描：node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${extPrNum} --untrusted-scan` },
    ]
  }
  if (reuseExistingPr) {
    const steps = [
      { skill: 'dev-flow', text: `1. 接手/返工该已有 PR（复用原分支，禁止新开第二个 PR）：node ".agents/skills/dev-flow/scripts/flow.mjs" start --pr ${reuseExistingPr.prNumber}` },
    ]
    if (hasDevReview) {
      steps.push({ skill: 'dev-flow', text: `2. 若仅独立审查该 PR：node ".agents/skills/dev-flow/scripts/flow.mjs" start --external-pr ${reuseExistingPr.prNumber} 后运行 review-pack.mjs --pr ${reuseExistingPr.prNumber}` })
    }
    return steps
  }
  if (role === 'clone-readonly') {
    return [
      teamProbeHint
        ? '若是组织/团队协作者，可先运行 flow.mjs inspect --probe-auth 验证写权限；若确认为只读克隆，再带 --clone-choice 运行 start'
        : '只读克隆仓，请先向用户确认 --clone-choice <fork|standalone|local> 再运行 flow.mjs start',
    ]
  }
  return [{ skill: 'dev-plan', text: '1. 按任务规模运行 doc-plan.mjs triage；2. 执行 flow.mjs start --task <id>' }]
}

const WRITE_SCOPE_HEADING_RE = /(?:改动|涉及|修改|变更|受影响|写域|产物|目标).{0,8}(?:文件|路径|范围|清单)|^\s*(?:files|scope)\b/i
const WRITE_SCOPE_SKIP_LINE_RE = /(?:不动|不改|不修改|不触碰|范围外|out of scope|禁止改|do-not-edit)/i
const PATH_TOKEN_RE = /`([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})`/g

function extractSpecWriteScope(raw) {
  const files = new Set()
  let inFence = false
  let inScopeSec = false
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (inFence) continue
    if (/^##+\s+/.test(line)) inScopeSec = WRITE_SCOPE_HEADING_RE.test(line)
    if (WRITE_SCOPE_SKIP_LINE_RE.test(line)) continue
    if (!inScopeSec && !WRITE_SCOPE_HEADING_RE.test(line) && !/^\s*(?:[-*]|\d+\.)\s+.*`[A-Za-z0-9_.-]+\//.test(line)) continue
    for (const m of line.matchAll(PATH_TOKEN_RE)) {
      const p = posixPath(m[1]).replace(/^\.\//, '')
      if (/^docs\/(?:prd|specs|todo|archive)\//.test(p)) continue
      files.add(p)
    }
  }
  return [...files].sort()
}

/**
 * C11: 扫描尚未建账本的就绪规划切片（`docs/specs/*.md` status=approved 与独立 `docs/todo/*.md` status=active），
 * 解析 `Depends on` 与改动文件写域（未声明写域按 `conservativeSerial: true` 保守串行处理）。
 */
export function scanUnstartedReadySlices(repoRoot, allLedgers = []) {
  if (!repoRoot) return []
  const trackedSpecs = new Set()
  const trackedTodos = new Set()
  const trackedTaskIds = new Set()
  const trackedIssues = new Set()
  const closedIssues = new Set()
  for (const l of Array.isArray(allLedgers) ? allLedgers : []) {
    for (const f of [l?.specFile, l?.archivedSpecFile].filter(Boolean)) trackedSpecs.add(posixPath(f))
    for (const f of [l?.todoFile, l?.archivedTodoFile].filter(Boolean)) trackedTodos.add(posixPath(f))
    if (l?.taskId) trackedTaskIds.add(String(l.taskId))
    const isClosed = ['merged', 'cleaned', 'aborted'].includes(String(l?.status ?? '').toLowerCase())
    for (const n of l?.linkedIssues ?? []) {
      trackedIssues.add(Number(n))
      if (isClosed) closedIssues.add(Number(n))
    }
  }

  const rawItems = []
  const specDir = join(repoRoot, 'docs', 'specs')
  if (existsSync(specDir)) {
    for (const name of readdirSync(specDir).filter((n) => n.endsWith('.md')).sort()) {
      const rel = `docs/specs/${name}`
      if (trackedSpecs.has(rel)) continue
      const text = readTextSafe(join(specDir, name)) ?? ''
      if (!isManagedPlanDoc(rel, text)) continue
      const fm = parseDocFrontmatter(text)
      if (String(fm.data?.status ?? '').toLowerCase() !== 'approved') continue
      const fn = parseDocFilename(rel)
      const iss = Number(fm.data?.issue) || fn?.issue || null
      if (iss && trackedIssues.has(iss)) continue
      const taskId = String(fm.data?.task_id ?? (iss ? `issue-${iss}` : (fn?.slug || basename(name, '.md'))))
      if (trackedTaskIds.has(taskId)) continue
      const files = extractSpecWriteScope(text)
      const relDeps = parseBodyRelations(text).dependsOn.filter((n) => !closedIssues.has(n))
      const rawDeps = Array.isArray(fm.data?.depends_on) ? fm.data.depends_on : (fm.data?.depends_on ? [fm.data.depends_on] : [])
      rawItems.push({
        taskId, kind: 'spec', specFile: rel, issue: iss, slug: fn?.slug ?? taskId,
        files, hasWriteScope: files.length > 0, conservativeSerial: files.length === 0,
        dependsOnIssues: relDeps, rawDependsOn: rawDeps.map(String), readyUnstarted: true,
      })
    }
  }

  const todoDir = join(repoRoot, 'docs', 'todo')
  if (existsSync(todoDir)) {
    for (const name of readdirSync(todoDir).filter((n) => n.endsWith('.md')).sort()) {
      const rel = `docs/todo/${name}`
      if (trackedTodos.has(rel)) continue
      const text = readTextSafe(join(todoDir, name)) ?? ''
      if (!isManagedPlanDoc(rel, text)) continue
      const fm = parseDocFrontmatter(text)
      if (String(fm.data?.status ?? '').toLowerCase() !== 'active' || fm.data?.related_spec) continue
      const fn = parseDocFilename(rel)
      const iss = Number(fm.data?.issue) || fn?.issue || null
      if (iss && trackedIssues.has(iss)) continue
      const taskId = String(fm.data?.task_id ?? (iss ? `issue-${iss}` : (fn?.slug || basename(name, '.md'))))
      if (trackedTaskIds.has(taskId)) continue
      const files = extractSpecWriteScope(text)
      rawItems.push({
        taskId, kind: 'todo', todoFile: rel, issue: iss, slug: fn?.slug ?? taskId,
        files, hasWriteScope: files.length > 0, conservativeSerial: files.length === 0,
        dependsOnIssues: parseBodyRelations(text).dependsOn.filter((n) => !closedIssues.has(n)),
        rawDependsOn: [], readyUnstarted: true,
      })
    }
  }

  const byIssue = new Map()
  for (const it of rawItems) if (it.issue) byIssue.set(Number(it.issue), it.taskId)
  for (const l of Array.isArray(allLedgers) ? allLedgers : []) {
    if (['merged', 'cleaned', 'aborted'].includes(String(l?.status ?? '').toLowerCase())) continue
    for (const n of l?.linkedIssues ?? []) if (!byIssue.has(Number(n))) byIssue.set(Number(n), l.taskId)
  }
  return rawItems.map((it) => ({
    ...it,
    dependsOn: [...new Set([
      ...it.rawDependsOn,
      ...it.dependsOnIssues.map((n) => byIssue.get(n)).filter(Boolean),
    ])].filter((d) => d !== it.taskId),
  }))
}

/** 多未闭环/就绪任务按依赖与声明写域计算并行波次计划（缺写域切片保守串行）。 */
export function buildMultiTaskWavePlan(activeTasks = [], filesByTask = null) {
  const activeIds = new Set(activeTasks.map((t) => t.taskId))
  const items = activeTasks.map((t) => {
    const rawFiles = filesByTask?.[t.taskId] ?? t.files ?? t.scopeFiles ?? []
    const files = [...new Set(rawFiles.map((f) => posixPath(String(f ?? '')).replace(/^\.\//, '').trim()).filter(Boolean))].sort()
    const deps = [...new Set([
      ...(Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : []),
      ...(t.parentTaskId ? [String(t.parentTaskId)] : []),
    ])].filter((d) => activeIds.has(d) && d !== t.taskId)
    const conservativeSerial = Boolean(t.conservativeSerial || (t.hasWriteScope === false && files.length === 0))
    return {
      taskId: t.taskId, files, deps, conservativeSerial,
      readyUnstarted: Boolean(t.readyUnstarted), specFile: t.specFile ?? null, todoFile: t.todoFile ?? null,
      status: t.status ?? (t.readyUnstarted ? 'ready' : 'active'), branch: t.branch ?? null,
    }
  })

  const byId = new Map(items.map((it) => [it.taskId, it]))
  const placedWave = new Map()
  const waves = []
  const remaining = new Set(items.map((it) => it.taskId))
  let waveNum = 0

  while (remaining.size > 0 && waveNum < items.length + 2) {
    waveNum += 1
    const curWave = []
    const usedFiles = new Set()
    let waveHasSerial = false
    for (const id of [...remaining]) {
      const it = byId.get(id)
      if (!it.deps.every((d) => placedWave.has(d) && placedWave.get(d) < waveNum)) continue
      if (waveHasSerial || (curWave.length > 0 && it.conservativeSerial)) continue
      if (it.files.some((f) => usedFiles.has(f))) continue
      curWave.push({
        taskId: id,
        files: it.files,
        deps: it.deps,
        slotIndex: curWave.length,
        ...(it.conservativeSerial ? { conservativeSerial: true } : {}),
        ...(it.readyUnstarted ? { readyUnstarted: true, specFile: it.specFile, todoFile: it.todoFile } : {}),
        reason: it.conservativeSerial
          ? '未声明写域，保守单列串行以防并行写冲突'
          : (it.deps.length > 0 ? `等待前置 ${it.deps.join(',')} 合入后可并入本波` : '无未满足前置依赖且写域无重叠'),
      })
      if (it.conservativeSerial) waveHasSerial = true
      it.files.forEach((f) => usedFiles.add(f))
    }
    if (curWave.length === 0) {
      const fallbackId = [...remaining][0]
      const it = byId.get(fallbackId)
      curWave.push({ taskId: fallbackId, files: it.files, deps: it.deps, slotIndex: 0, cycleOrForced: true, reason: '存在依赖环或未清依赖，强制单列串行' })
    }
    for (const entry of curWave) {
      placedWave.set(entry.taskId, waveNum)
      remaining.delete(entry.taskId)
    }
    waves.push({
      wave: waveNum,
      canParallel: curWave.length > 1,
      tasks: curWave,
    })
  }

  const parallelDispatch = (waves[0]?.tasks?.length ?? 0) >= 2
  return {
    totalTasks: items.length,
    parallelDispatch,
    waves,
    order: waves.flatMap((w) => w.tasks.map((t) => t.taskId)),
    parallelizable: waves[0]?.tasks.map((t) => t.taskId) ?? [],
    hasDependencies: items.some((it) => it.deps.length > 0),
  }
}
