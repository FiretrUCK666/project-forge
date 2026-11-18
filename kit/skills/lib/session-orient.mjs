/**
 * session-orient.mjs —— 冷启动时把「这个仓现在到哪一步了」摆出来。
 *
 * ## 它治的病
 *
 * 新开的会话不知道任何背景。它跑到 `flow next`，拿到一句话：
 *
 * > 当前无活跃任务；请先运行 doc-plan.mjs triage 或 flow.mjs start --task <id> 启动任务。
 *
 * 于是它只能自己翻 `docs/` 目录、一份份读文档，才知道这个仓正在做什么、哪一步没做。
 * 而**已有的进度信息全在仓库里**——PRD/SPEC/Todo 的 frontmatter、勾选数、最近提交。
 * 只是没有任何一个入口把它们摆出来。
 *
 * 更麻烦的是另一半：PR/Issue 上的审查评论很详细（根因、建议修法、逐条核对），
 * 但那只在远端。本地是一张白纸，新会话连「去翻哪个 PR」都不知道。
 *
 * ## 这里做什么
 *
 * 只读地扫一遍仓库，输出四段：
 *
 * 1. **规划文档全景**：几份 PRD/SPEC/Todo，各是什么状态、勾了几条；
 * 2. **卡在哪**：没批准的、待拍板未清的、勾选未完成的；
 * 3. **账本里的任务**：进行中的任务、分支、阶段；
 * 4. **下一步三个候选**：按「最挡路的先做」排。
 *
 * ## 不做什么
 *
 * 不替调用方做决定，也不编造进度。扫不到就写「没有」，不猜。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { listDocs } from '../dev-plan/scripts/doc-audit.mjs'
import { listTaskLedgers } from './ledger.mjs'
import { readTextSafe } from './git.mjs'
import { readGitConfigFast, resolveGitDirFast } from './git-fast.mjs'
import { listLocalIssues } from './local-issues.mjs'
import { detectGitModeMarkers } from './platform.mjs'

/** 这份文档当前卡在哪一格。空数组表示它不需要人管。 */
function blockOf(doc, kind) {
  const out = []
  const status = String(doc.status ?? '').toLowerCase()
  if (kind === 'prd' && !['active', 'done', 'dropped'].includes(status)) {
    out.push('未批准（state=draft，需 critique-pass 后 approve）')
  }
  if (kind === 'spec' && !['approved', 'implementing', 'in_review', 'implemented', 'superseded'].includes(status)) {
    out.push('未批准（state=draft，需 critique-pass 后 approve）')
  }
  if (kind === 'todo' && ['draft', 'pending'].includes(status)) {
    out.push('未启动（Todo 仍是 draft/pending）')
  }
  if (Number(doc.totalChecks ?? 0) > 0 && Number(doc.doneChecks ?? 0) < Number(doc.totalChecks ?? 0)
    && ['implemented', 'done', 'archived'].includes(status)) {
    out.push(`勾选未完成（${doc.doneChecks}/${doc.totalChecks}）却已标 ${status}`)
  }
  return out
}

function summarize(kind, doc) {
  const checks = Number(doc.totalChecks ?? 0) > 0 ? `${doc.doneChecks}/${doc.totalChecks} 条已勾` : '无勾选项'
  return {
    kind,
    file: doc.file,
    title: String(doc.title ?? '').replace(/^[^：:]*[：:]\s*/, ''),
    status: doc.status ?? null,
    issue: doc.issue ?? null,
    checks,
    blockedBy: blockOf(doc, kind),
  }
}

/**
 * 生成冷启动全景。
 *
 * @param {string} mainRoot 主仓根
 * @returns {{ docs: object, tasks: object, stuck: Array, nextSteps: Array, text: string }}
 */
export function buildSessionOrientation(mainRoot) {
  const listed = listDocs(mainRoot)
  const docs = {
    tdd: listed.tdd ? summarize('tdd', listed.tdd) : null,
    prd: (listed.prds ?? []).map((d) => summarize('prd', d)),
    specs: (listed.specs ?? []).map((d) => summarize('spec', d)),
    todos: (listed.todos ?? []).map((d) => summarize('todo', d)),
  }

  // 账本里的任务：`listTaskLedgers` 返回的是活跃任务，读不出来就当没有。
  let tasks = []
  try {
    // 只看未终结的任务：已清理的历史任务摆出来只会淹没真正的进度。
    tasks = (listTaskLedgers(mainRoot, { includeTerminal: false }) ?? []).map((t) => ({
      taskId: t.taskId ?? null,
      status: t.status ?? null,
      branch: t.branch ?? null,
      worktreePath: t.worktreePath ?? null,
      specFile: t.specFile ?? null,
      todoFile: t.todoFile ?? null,
    }))
  } catch {
    tasks = []
  }

  let openLocalIssues = []
  let pendingLocalMigration = false
  try {
    const fastGitDir = resolveGitDirFast(mainRoot)
    openLocalIssues = listLocalIssues({ mainRoot, gitDir: fastGitDir, state: 'open' }).issues ?? []
    if (openLocalIssues.length > 0 && fastGitDir) {
      const cfg = readGitConfigFast(fastGitDir, { systemMap: false })
      const hasRemote = Boolean(cfg?.remoteText && cfg.remoteText.trim().length > 0)
      const markers = detectGitModeMarkers(fastGitDir, { hasRemote })
      pendingLocalMigration = hasRemote && !markers.localMode
    }
  } catch {
    openLocalIssues = []
  }

  const stuck = [
    ...docs.prd.flatMap((d) => d.blockedBy.map((why) => ({ file: d.file, why }))),
    ...docs.specs.flatMap((d) => d.blockedBy.map((why) => ({ file: d.file, why }))),
    ...docs.todos.flatMap((d) => d.blockedBy.map((why) => ({ file: d.file, why }))),
  ]

  // 下一步候选：按「最挡路的先做」排。三条，不多不少——太多了等于没排。
  const nextSteps = []
  const unapprovedPrd = docs.prd.filter((d) => d.blockedBy.some((b) => b.includes('未批准')))
  const unapprovedSpec = docs.specs.filter((d) => d.blockedBy.some((b) => b.includes('未批准')))
  const openTodo = docs.todos.filter((d) => !['done', 'archived', 'dropped'].includes(String(d.status ?? '').toLowerCase()))
  if (unapprovedPrd.length > 0) {
    nextSteps.push({
      action: `先把 ${unapprovedPrd.length} 份 PRD 走完独立 Critique 并 approve`,
      command: `node .agents/skills/dev-plan/scripts/doc-plan.mjs critique-scope --file "${unapprovedPrd[0].file}"`,
    })
  }
  if (unapprovedSpec.length > 0) {
    nextSteps.push({
      action: `再把 ${unapprovedSpec.length} 份 SPEC 走完独立 Critique 并 approve`,
      command: `node .agents/skills/dev-plan/scripts/doc-plan.mjs audit "${unapprovedSpec[0].file}"`,
    })
  }
  if (openTodo.length > 0 && tasks.length === 0) {
    nextSteps.push({
      action: `为未闭环的 Todo 起隔离工作位（共 ${openTodo.length} 份）`,
      command: `node .agents/skills/dev-flow/scripts/flow.mjs start --task <id> --todo "${openTodo[0].file}"`,
    })
  }
  if (tasks.length > 0) {
    nextSteps.unshift({
      action: `有 ${tasks.length} 个账本任务在跑，先看它卡在哪`,
      command: `node .agents/skills/dev-flow/scripts/flow.mjs next --task ${tasks[0].taskId}`,
    })
  }
  if (nextSteps.length === 0) {
    nextSteps.push({
      action: '没有未闭环的规划文档，也没有账本任务——可以接新需求了',
      command: 'node .agents/skills/dev-plan/scripts/doc-plan.mjs triage "<需求一句话>"',
    })
  }

  const lines = []
  lines.push('# 这个仓现在到哪一步了')
  lines.push('')
  lines.push('> 由 `flow next` 冷启动时自动生成：只读扫描规划文档与账本，不猜进度。')
  lines.push('> 新会话不必自己翻目录——先看这一段。')
  lines.push('')

  lines.push('## 规划文档全景')
  lines.push('')
  if (docs.tdd) lines.push(`- **TDD**：\`${docs.tdd.file}\`（常青架构，随时可读）`)
  lines.push(`- **PRD**：${docs.prd.length} 份`)
  for (const d of docs.prd) lines.push(`  - \`${d.file}\` — ${d.status ?? '无状态'} · ${d.checks}${d.issue ? ` · Issue #${d.issue}` : ''}`)
  lines.push(`- **SPEC**：${docs.specs.length} 份`)
  for (const d of docs.specs) lines.push(`  - \`${d.file}\` — ${d.status ?? '无状态'} · ${d.checks}${d.issue ? ` · Issue #${d.issue}` : ''}`)
  lines.push(`- **Todo**：${docs.todos.length} 份`)
  for (const d of docs.todos) lines.push(`  - \`${d.file}\` — ${d.status ?? '无状态'} · ${d.checks}${d.issue ? ` · Issue #${d.issue}` : ''}`)
  lines.push('')

  if (tasks.length > 0) {
    lines.push('## 账本里的任务')
    lines.push('')
    for (const t of tasks) {
      lines.push(`- \`${t.taskId}\` — ${t.status ?? '无状态'} · 分支 \`${t.branch ?? '-'}\` · 实施位 \`${t.worktreePath ?? '(分支模式)'}\``)
    }
    lines.push('')
  }

  if (openLocalIssues.length > 0) {
    lines.push('## 未闭环本地工单')
    lines.push('')
    for (const it of openLocalIssues.slice(0, 10)) {
      lines.push(`- #${it.number} [${it.state}] ${it.title}${it.assignees?.length ? `（认领：${it.assignees.join(', ')}）` : ''}`)
    }
    if (openLocalIssues.length > 10) lines.push(`- ... 其余 ${openLocalIssues.length - 10} 条请运行 \`flow.mjs issue list\``)
    if (pendingLocalMigration) {
      lines.push('- **切回远端迁移提示**：仓库已绑定远端，建议运行 `node ".agents/skills/dev-flow/scripts/flow.mjs" issue migrate` 将本地工单迁回远端。')
    }
    lines.push('')
  }

  lines.push('## 卡在哪')
  lines.push('')
  if (stuck.length === 0) {
    lines.push('没有卡住的文档。')
  } else {
    for (const s of stuck) lines.push(`- \`${s.file}\`：${s.why}`)
  }
  lines.push('')

  lines.push('## 下一步（按挡路程度排）')
  lines.push('')
  nextSteps.slice(0, 3).forEach((s, i) => {
    lines.push(`${i + 1}. ${s.action}`)
    lines.push(`   \`${s.command}\``)
  })
  lines.push('')

  // 远端评论只在远端：把这件事说明白，否则新会话会以为本地就是全部。
  const hasAgents = existsSync(join(mainRoot, 'AGENTS.md'))
  if (hasAgents) {
    const agentsText = readTextSafe(join(mainRoot, 'AGENTS.md')) ?? ''
    if (/dev-review|review-pack/.test(agentsText)) {
      lines.push('> **审查细节不在本地**：PR/Issue 上的评论才有根因与建议修法（逐条核对表、Must Fix、故障注入记录）。')
      lines.push('> 要读它们，先 `flow next --task <id>` 拿到 PR 号，再去远端看；本地账本只记结论与轮次。')
      lines.push('')
    }
  }

  return {
    docs,
    tasks,
    localIssues: openLocalIssues.map((i) => ({ number: i.number, title: i.title, state: i.state, labels: i.labels ?? [], assignees: i.assignees ?? [] })),
    pendingLocalMigration,
    stuck,
    nextSteps: nextSteps.slice(0, 3),
    text: `${lines.join('\n').trimEnd()}\n`,
  }
}
