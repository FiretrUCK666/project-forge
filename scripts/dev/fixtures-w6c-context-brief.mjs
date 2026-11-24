/**
 * fixtures-w6c-context-brief.mjs —— 单源 context-brief.mjs 贯通五入口的正反双向 Red-Green 行为断言。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { handleExplore } from '../../kit/skills/dev-flow/scripts/flow-explore.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleClaim } from '../../kit/skills/dev-flow/scripts/flow-merge-claim.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = (c) => { out += String(c); return true }
  process.stderr.write = (c) => { err += String(c); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

function makeTodoDoc({ taskId, owner = 'lead-p', impactPath = 'src/billing.mjs' }) {
  return [
    '---',
    'kind: todo',
    `title: "Task ${taskId}"`,
    'status: active',
    'created: 2026-11-23',
    'updated: 2026-11-23',
    'issue: null',
    'pr: null',
    `branch: feat/${taskId}`,
    `owner: ${owner}`,
    'plan_mode: autonomous',
    'approved: false',
    `task_id: ${taskId}`,
    '---',
    `# Task ${taskId}`,
    '',
    '## 任务范围与验证基准',
    '',
    `- **影响路径**：\`${impactPath}\``,
    '- **本期不做**：none',
    '- **门型与回滚路径**：two-way',
    '',
    '## 验收标准与执行清单',
    '',
    '- [ ] C1: 完成核心逻辑并通过验证',
    '',
  ].join('\n')
}

export function registerW6cContextBriefCases(cases) {
  cases.push(['contextBrief 正向：TDD + feature-map 贯通 handoff / doc-plan / flow claim / review-pack / flow explore 五入口', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# Demo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'docs/TDD.md': [
        '# Demo TDD',
        '',
        '## 1. 模块边界与目录',
        '所有计费逻辑位于 src/billing.mjs。',
        '',
        '## 2. 计费结算核心流',
        '按分结算并在对账阶段校验零误差。',
        '',
        '## 3. 安全与审计红线',
        '严禁浮点金额。',
        '',
      ].join('\n'),
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [
          {
            id: 'billing',
            name: '计费结算核心模块',
            entrypoints: ['src/billing.mjs'],
            modules: ['src/billing.mjs'],
            businessFlows: ['按分结算与对账闭环'],
            verificationTools: [
              { id: 'verify-billing', kind: 'command', command: 'node test/billing.mjs', riskLevel: 'medium', triggerHints: ['billing', '结算'] },
            ],
            testRefs: ['test/billing.mjs'],
          },
        ],
      }, null, 2),
      'src/billing.mjs': 'export const settleCents = (c) => c\n',
      'docs/todo/261123-bill-t-todo.md': makeTodoDoc({ taskId: 'bill-t', impactPath: 'src/billing.mjs' }),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@cb.test' })
    try {
      // 1. handoff-package
      const hp = buildHandoff({
        mainRoot: dir,
        ledger: { taskId: 'bill-t', todoFile: 'docs/todo/261123-bill-t-todo.md', branch: 'feat/bill-t', baseBranch: 'main' },
        policy: { requiredGates: [] },
      })
      if (!Array.isArray(hp.fields?.evergreenToc) || !hp.fields.evergreenToc.some((d) => d.path === 'docs/TDD.md' && d.headings?.some((h) => h.title.includes('计费结算')))) {
        return `handoff-package 缺少 docs/TDD.md evergreenToc：${JSON.stringify(hp.fields?.evergreenToc)}`
      }
      if (!hp.fields?.contextBrief?.featureMap?.businessFlows?.includes('按分结算与对账闭环') || !hp.prompt.includes('doc-locate.mjs')) {
        return `handoff-package 缺少 contextBrief 业务流或 doc-locate 命令：${JSON.stringify(hp.fields?.contextBrief)}`
      }

      // 2. doc-plan triage (JSON + text) & init
      const triJsonRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--summary', '优化计费结算精度', '--paths', 'src/billing.mjs', '--json',
      ], { cwd: dir })
      if (triJsonRun.status !== 0) return `doc-plan triage --json 失败：${triJsonRun.stderr}`
      const triJson = JSON.parse(triJsonRun.stdout)
      if (!triJson.contextBrief?.evergreenToc?.some((d) => d.path === 'docs/TDD.md')
        || !triJson.contextBrief?.featureMap?.businessFlows?.includes('按分结算与对账闭环')) {
        return `doc-plan triage --json 缺少 contextBrief：${triJsonRun.stdout}`
      }
      const triTextRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--summary', '优化计费结算精度', '--paths', 'src/billing.mjs',
      ], { cwd: dir })
      if (triTextRun.status !== 0 || !triTextRun.stdout.includes('docs/TDD.md') || !triTextRun.stdout.includes('按分结算与对账闭环')) {
        return `doc-plan triage 文本输出缺少常青目录或业务流：${triTextRun.stdout}`
      }
      // 模糊需求无路径命中时应给出 totalFeaturesCount / featureOverview
      const triFuzzyRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--summary', '处理一个未知模块小问题', '--json',
      ], { cwd: dir })
      const triFuzzy = JSON.parse(triFuzzyRun.stdout)
      if (triFuzzy.contextBrief?.featureMap?.totalFeaturesCount !== 1 || !triFuzzy.contextBrief?.featureMap?.featureOverview?.some((f) => f.id === 'billing')) {
        return `模糊需求未附带 totalFeaturesCount/featureOverview：${JSON.stringify(triFuzzy.contextBrief?.featureMap)}`
      }
      const initRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'bill-init', '--title', '计费补充', '--owner', 'lead-p', '--json',
      ], { cwd: dir })
      if (initRun.status !== 0) return `doc-plan init 失败：${initRun.stderr}`
      const initJson = JSON.parse(initRun.stdout)
      if (!initJson.contextBrief?.evergreenToc?.some((d) => d.path === 'docs/TDD.md')) {
        return `doc-plan init --json 缺少 contextBrief：${initRun.stdout}`
      }

      // 3. flow claim（不走 --handoff，验证 JSON 与 stdout 均输出 contextBrief）
      const roots = await resolveRepoRoots(dir)
      const st = await withQuietIo(() => handleStart({ task: 'bill-t', slug: 'bill-t', case: '3', todo: 'docs/todo/261123-bill-t-todo.md', agent: 'impl-b' }, roots))
      if (st.res.exitCode !== 0) return `flow start 失败：${st.err}`
      const clText = await withQuietIo(() => handleClaim({ task: 'bill-t', agent: 'impl-b' }, roots))
      if (clText.res.exitCode !== 0 || !clText.out.includes('docs/TDD.md') || !clText.out.includes('按分结算与对账闭环')) {
        return `flow claim 文本输出未含 contextBrief：exit=${clText.res.exitCode} out=${clText.out}`
      }
      const clJsonIo = await withQuietIo(() => handleClaim({ task: 'bill-t', agent: 'impl-b', json: true }, roots))
      const clJson = JSON.parse(clJsonIo.out)
      if (!clJson.contextBrief?.evergreenToc?.some((d) => d.path === 'docs/TDD.md')
        || !clJson.contextBrief?.featureMap?.businessFlows?.includes('按分结算与对账闭环')) {
        return `flow claim --json 缺少 contextBrief：${clJsonIo.out}`
      }

      // 4. flow explore（验证 JSON/stdout contextBrief 与 explored 计数）
      const exText = await withQuietIo(() => handleExplore({ task: 'bill-t', by: 'impl-b' }, roots))
      if (exText.res.exitCode !== 0 || !exText.out.includes('docs/TDD.md') || !exText.out.includes('按分结算与对账闭环')) {
        return `flow explore 文本输出未含 contextBrief：exit=${exText.res.exitCode} out=${exText.out}`
      }
      const exJson = exText.res.payload
      if (!exJson.contextBrief?.evergreenToc?.some((d) => d.path === 'docs/TDD.md')
        || !(exJson.explored?.evergreenDocsCount >= 1)
        || exJson.explored?.featureMapCount !== 1) {
        return `flow explore 载荷缺少 contextBrief 或计数：${JSON.stringify(exJson)}`
      }

      // 5. review-pack（验证单源 pack.contextBrief 且 reviewContext 不再重复挂载 + 文本输出）
      const wt = join(dir, '.worktrees/impl-bill-t')
      writeFileSync(join(wt, 'src/billing.mjs'), 'export const settleCents = (c) => Math.round(c)\n', 'utf8')
      gitCommitFast(wt, 'feat: round cents', { updateOnly: true })
      const rpJsonRun = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'bill-t', '--json'], { cwd: dir })
      if (rpJsonRun.status !== 0) return `review-pack --json 失败：${rpJsonRun.stderr}`
      const rpJson = JSON.parse(rpJsonRun.stdout)
      if (!rpJson.contextBrief?.evergreenToc?.some((d) => d.path === 'docs/TDD.md')
        || !rpJson.contextBrief?.featureMap?.businessFlows?.includes('按分结算与对账闭环')) {
        return `review-pack --json 缺少单源 contextBrief：${JSON.stringify(rpJson.contextBrief)}`
      }
      if ('evergreenContext' in (rpJson.reviewContext ?? {}) || 'contextBrief' in (rpJson.reviewContext ?? {})) {
        return `review-pack --json 的 reviewContext 不得重复包含 evergreenContext 或 contextBrief：${JSON.stringify(Object.keys(rpJson.reviewContext ?? {}))}`
      }
      const rpTextRun = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'bill-t'], { cwd: dir })
      if (rpTextRun.status !== 0 || !rpTextRun.stdout.includes('docs/TDD.md') || !rpTextRun.stdout.includes('doc-locate.mjs')) {
        return `review-pack 文本输出缺少常青章节或 doc-locate 命令：${rpTextRun.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['contextBrief 无 TDD 多常青正向：ARCHITECTURE + evergreen frontmatter + 子包 AGENTS.md 与 otherEvergreenDocs 零漏', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# Monorepo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'ARCHITECTURE.md': '# Arch\n\n## 1. 服务拓扑\n核心账单服务拆分为独立子包。\n',
      'DESIGN.md': '# Design\n\n## UI 规范\n保持极简。\n',
      'RUNBOOK.md': '# Runbook\n\n## 故障排查\n查日志。\n',
      'docs/payments-guide.md': '---\nevergreen: true\n---\n# Payments Guide\n\n## 对账与清算规则\n所有账单子包须走统一清算通道。\n',
      'packages/billing/AGENTS.md': '# Billing Package\n\n## 计费子包契约\n不得绕过 calc.mjs 的舍入规则。\n',
      'packages/billing/src/calc.mjs': 'export const calc = (x) => x\n',
      'docs/feature-map.json': JSON.stringify({
        version: 1,
        features: [{
          id: 'pkg-billing',
          name: '子包计费',
          entrypoints: ['packages/billing/src/calc.mjs'],
          modules: ['packages/billing/src/calc.mjs'],
          businessFlows: ['子包计费与清算校核'],
          verificationTools: [],
          testRefs: [],
        }],
      }, null, 2),
      'docs/todo/261123-pkg-bill-todo.md': makeTodoDoc({ taskId: 'pkg-bill', impactPath: 'packages/billing/src/calc.mjs' }),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@nottdd.test' })
    try {
      const hp = buildHandoff({
        mainRoot: dir,
        ledger: { taskId: 'pkg-bill', todoFile: 'docs/todo/261123-pkg-bill-todo.md', branch: 'feat/pkg-bill', baseBranch: 'main' },
        policy: { requiredGates: [] },
      })
      const hpTocPaths = (hp.fields?.evergreenToc ?? []).map((d) => d.path)
      if (!hpTocPaths.includes('packages/billing/AGENTS.md') || !hpTocPaths.includes('docs/payments-guide.md')) {
        return `handoff 未优先带出子包 AGENTS.md 与 evergreen:true 文档：${JSON.stringify(hp.fields?.evergreenToc)}`
      }
      if ((hp.fields?.totalEvergreenDocs ?? 0) < 5 || (hp.fields?.otherEvergreenDocs?.length ?? 0) < 1) {
        return `超过 maxEvergreenDocs 时 otherEvergreenDocs 被静默截断：${JSON.stringify({ total: hp.fields?.totalEvergreenDocs, other: hp.fields?.otherEvergreenDocs })}`
      }

      const triRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--summary', '调整 billing calc', '--paths', 'packages/billing/src/calc.mjs', '--json',
      ], { cwd: dir })
      const tri = JSON.parse(triRun.stdout)
      if (!tri.contextBrief?.evergreenToc?.some((d) => d.path === 'packages/billing/AGENTS.md')) {
        return `triage 未带出 packages/billing/AGENTS.md：${triRun.stdout}`
      }

      const roots = await resolveRepoRoots(dir)
      await withQuietIo(() => handleStart({ task: 'pkg-bill', slug: 'pkg-bill', case: '3', todo: 'docs/todo/261123-pkg-bill-todo.md', agent: 'impl-p' }, roots))
      const cl = await withQuietIo(() => handleClaim({ task: 'pkg-bill', agent: 'impl-p', json: true }, roots))
      const clJson = JSON.parse(cl.out)
      if (!clJson.contextBrief?.evergreenToc?.some((d) => d.path === 'packages/billing/AGENTS.md')) {
        return `claim 未带出 packages/billing/AGENTS.md：${cl.out}`
      }

      const ex = await withQuietIo(() => handleExplore({ task: 'pkg-bill', by: 'impl-p', json: true }, roots))
      if (!ex.res.payload?.contextBrief?.evergreenToc?.some((d) => d.path === 'ARCHITECTURE.md' || d.path === 'docs/payments-guide.md')) {
        return `explore 未带出无 TDD 常青文档：${JSON.stringify(ex.res.payload?.contextBrief)}`
      }

      const wt = join(dir, '.worktrees/impl-pkg-bill')
      writeFileSync(join(wt, 'packages/billing/src/calc.mjs'), 'export const calc = (x) => x + 1\n', 'utf8')
      gitCommitFast(wt, 'feat: update calc', { updateOnly: true })
      const rp = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'pkg-bill', '--json'], { cwd: dir })
      const rpJson = JSON.parse(rp.stdout)
      if (!rpJson.contextBrief?.evergreenToc?.some((d) => d.path === 'packages/billing/AGENTS.md')
        || !(rpJson.contextBrief?.otherEvergreenDocs?.length >= 1)) {
        return `review-pack 未带出子包 AGENTS.md 或 otherEvergreenDocs：${JSON.stringify(rpJson.contextBrief)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['contextBrief 反向 Fail-Soft：缺 TDD + 缺/损坏 feature-map 时五入口零崩溃安全降级且零虚构', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# Minimal\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/app.mjs': 'export const run = () => 1\n',
      'docs/todo/261123-min-t-todo.md': makeTodoDoc({ taskId: 'min-t', impactPath: 'src/app.mjs' }),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@min.test' })
    try {
      const checkAllFive = async (expectCorrupt) => {
        const hp = buildHandoff({
          mainRoot: dir,
          ledger: { taskId: 'min-t', todoFile: 'docs/todo/261123-min-t-todo.md', branch: 'feat/min-t', baseBranch: 'main' },
          policy: { requiredGates: [] },
        })
        if ((hp.fields?.evergreenToc?.length ?? -1) !== 0 || (hp.fields?.contextBrief?.featureMap?.businessFlows?.length ?? -1) !== 0) {
          return `handoff 反向未保持空目录/零虚构：${JSON.stringify(hp.fields?.contextBrief)}`
        }
        if (Boolean(hp.fields?.contextBrief?.featureMap?.corrupt) !== expectCorrupt) {
          return `handoff corrupt 标记不符合预期(${expectCorrupt})：${JSON.stringify(hp.fields?.contextBrief?.featureMap)}`
        }

        const triRun = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
          'triage', '--summary', '修改 app', '--paths', 'src/app.mjs', '--json',
        ], { cwd: dir })
        if (triRun.status !== 0) return `triage Fail-Soft 崩溃：${triRun.stderr}`
        const tri = JSON.parse(triRun.stdout)
        if ((tri.contextBrief?.evergreenToc?.length ?? -1) !== 0 || Boolean(tri.contextBrief?.featureMap?.corrupt) !== expectCorrupt) {
          return `triage Fail-Soft 返回异常：${triRun.stdout}`
        }

        const roots = await resolveRepoRoots(dir)
        await withQuietIo(() => handleStart({ task: 'min-t', slug: 'min-t', case: '3', todo: 'docs/todo/261123-min-t-todo.md', agent: 'impl-m' }, roots))
        const cl = await withQuietIo(() => handleClaim({ task: 'min-t', agent: 'impl-m', json: true }, roots))
        if (cl.res.exitCode !== 0) return `claim Fail-Soft 崩溃：${cl.err}`
        const clJson = JSON.parse(cl.out)
        if ((clJson.contextBrief?.evergreenToc?.length ?? -1) !== 0 || Boolean(clJson.contextBrief?.featureMap?.corrupt) !== expectCorrupt) {
          return `claim Fail-Soft 载荷异常：${cl.out}`
        }

        const ex = await withQuietIo(() => handleExplore({ task: 'min-t', by: 'impl-m', json: true }, roots))
        if (ex.res.exitCode !== 0 || ex.res.payload?.explored?.evergreenDocsCount !== 0) {
          return `explore Fail-Soft 异常：${JSON.stringify(ex.res.payload)}`
        }

        const wt = join(dir, '.worktrees/impl-min-t')
        writeFileSync(join(wt, 'src/app.mjs'), 'export const run = () => 2\n', 'utf8')
        gitCommitFast(wt, 'feat: update app', { updateOnly: true })
        const rp = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 'min-t', '--json'], { cwd: dir })
        if (rp.status !== 0) return `review-pack Fail-Soft 崩溃：${rp.stderr}`
        const rpJson = JSON.parse(rp.stdout)
        if ((rpJson.contextBrief?.evergreenToc?.length ?? -1) !== 0 || Boolean(rpJson.contextBrief?.featureMap?.corrupt) !== expectCorrupt) {
          return `review-pack Fail-Soft 载荷异常：${JSON.stringify(rpJson.contextBrief)}`
        }
        return null
      }

      const missingErr = await checkAllFive(false)
      if (missingErr) return missingErr

      writeFileSync(join(dir, 'docs/feature-map.json'), '{broken json', 'utf8')
      const wt = join(dir, '.worktrees/impl-min-t')
      writeFileSync(join(wt, 'docs/feature-map.json'), '{broken json', 'utf8')
      gitCommitFast(wt, 'chore: corrupt feature-map for fail-soft test')
      const corruptErr = await checkAllFive(true)
      if (corruptErr) return corruptErr
      return true
    } finally { rmTree(dir) }
  }])
}
