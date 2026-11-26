/**
 * fixtures-heterogeneous-dual-loop.mjs —— Wave 3 (`triage-brief-contract-parity`) C9 & C11 正反双向行为断言：
 *   - C9: triage 确定性三出口（direct/sandbox/plan-first）、单一 [NEXT STEP]、移除 fileCount>=6 悬崖
 *         （保留 fileCount>=12 prdNeed）、Case 5/PRD 严格正交与两处按需 Brief 触发统筹
 *   - C11: 7 类异构仿真仓库零定制补丁双环闭环（空/极简仓、Node/TS 单包与 Monorepo、Python/Go/Rust、
 *          Prisma/SQL 数据重型仓、UI 重型前端仓、无清单非 JS 通用仓、generic-git 非 GitHub 远端仓）
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { ensureReviewToken, readTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { resolveBriefsDir } from '../../kit/skills/lib/visual-brief.mjs'
import { determineWorkflowPolicy, readVerificationEvidence } from '../../kit/skills/lib/workflow-policy.mjs'
import { handleCleanup } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleFinalize, handleSubmit, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handlePromote } from '../../kit/skills/dev-flow/scripts/flow-sandbox.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { triageTask } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

const DOC_PLAN = 'kit/skills/dev-plan/scripts/doc-plan.mjs'

function captureOutput(fn) {
  let stdout = ''
  let stderr = ''
  const origOut = process.stdout.write
  const origErr = process.stderr.write
  process.stdout.write = (chunk) => { stdout += String(chunk); return true }
  process.stderr.write = (chunk) => { stderr += String(chunk); return true }
  return Promise.resolve()
    .then(fn)
    .then((result) => ({ result, stdout, stderr }))
    .finally(() => {
      process.stdout.write = origOut
      process.stderr.write = origErr
    })
}

function makeBaseProfileAgents(name, { smoke = 'none', highRisk = 'none' } = {}) {
  return [
    `# ${name}`,
    '',
    '```yaml',
    'quick-test: node -e "process.exit(0)"',
    'full-test: node -e "process.exit(0)"',
    `smoke-verify: ${smoke}`,
    'merge-gate: node -e "process.exit(0)"',
    `high-risk: ${highRisk}`,
    'do-not-edit: docs/archive/',
    '```',
    '',
  ].join('\n')
}

function makeSkillStubs() {
  return {
    '.gitignore': '.worktrees/\nnode_modules/\n',
    '.agents/skills/dev-plan/SKILL.md': '---\nname: dev-plan\ndescription: plan\n---\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
    '.agents/skills/dev-review/SKILL.md': '---\nname: dev-review\ndescription: review\n---\n',
  }
}

function initCleanGitRepo(dir, { origin = null } = {}) {
  gitInit(dir, { branch: 'main', name: 'Hetero Tester', email: 'hetero@example.com', ...(origin ? { origin } : {}) })
  return dir
}

async function runSandboxToMergedLoop(dir, {
  taskId,
  mutateFn,
  commitMsg,
  verifyOpts = {},
  reviewEvidence = 'ran full verify exit 0',
  withCleanup = true,
}) {
  const roots = await resolveRepoRoots(dir)
  const st = await captureOutput(() => handleStart({
    sandbox: true, task: taskId, slug: taskId, agent: `impl-${taskId}`, json: true,
  }, roots))
  if (st.result.exitCode !== EXIT.OK) return { ok: false, step: 'start', err: st.stderr || st.stdout }

  const sbDir = join(dir, '.worktrees', `sandbox-${taskId}`)
  if (!existsSync(sbDir)) return { ok: false, step: 'sandbox-dir', err: `missing ${sbDir}` }

  mutateFn(sbDir)
  gitCommitFast(sbDir, commitMsg)

  const innerVer = await captureOutput(() => handleVerify({
    task: taskId, mode: 'full', inner: true, ...verifyOpts, json: true,
  }, roots))
  if (innerVer.result.exitCode !== EXIT.OK) return { ok: false, step: 'inner-verify', err: innerVer.stderr || innerVer.stdout }
  const innerEv = readVerificationEvidence(roots.gitDir, taskId)
  if (innerEv?.inner !== true) return { ok: false, step: 'inner-flag', err: JSON.stringify(innerEv) }

  const pro = await captureOutput(() => handlePromote({
    task: taskId, 'no-issue': true, reason: `heterogeneous test ${taskId}`, json: true,
  }, roots))
  if (pro.result.exitCode !== EXIT.OK) return { ok: false, step: 'promote', err: pro.stderr || pro.stdout }
  const proJson = JSON.parse(pro.stdout)

  if (Number(proJson.caseType) >= 3) {
    const fin = await captureOutput(() => handleFinalize({ task: taskId, json: true }, roots))
    if (fin.result.exitCode !== EXIT.OK) return { ok: false, step: 'finalize', err: fin.stderr || fin.stdout }
  }

  const outerVer = await captureOutput(() => handleVerify({
    task: taskId, mode: 'full', ...verifyOpts, json: true,
  }, roots))
  if (outerVer.result.exitCode !== EXIT.OK) return { ok: false, step: 'outer-verify', err: outerVer.stderr || outerVer.stdout }
  if (verifyOpts['e2e-evidence']) {
    const smokeVer = await captureOutput(() => handleVerify({
      task: taskId, mode: 'smoke', ...verifyOpts, json: true,
    }, roots))
    if (smokeVer.result.exitCode !== EXIT.OK) return { ok: false, step: 'outer-smoke', err: smokeVer.stderr || smokeVer.stdout }
  }
  const outerEv = readVerificationEvidence(roots.gitDir, taskId)
  if (outerEv?.inner !== false) return { ok: false, step: 'outer-flag', err: JSON.stringify(outerEv) }

  const sub = await captureOutput(() => handleSubmit({ task: taskId, agent: `impl-${taskId}`, json: true }, roots))
  if (sub.result.exitCode !== EXIT.OK) return { ok: false, step: 'submit', err: sub.stderr || sub.stdout }

  const headSha = gitSync(sbDir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const ledgerSub = readTaskLedger(dir, taskId)
  const { token } = ensureReviewToken(dir, ledgerSub, 1, { headSha })
  const rev = await captureOutput(() => handleRecord({
    task: taskId, round: '1', verdict: 'pass', 'reviewer-id': `rev-${taskId}`,
    'review-token': token, evidence: reviewEvidence, 'enforce-gates': false, json: true,
  }, roots))
  if (rev.result !== EXIT.OK) return { ok: false, step: 'review', err: rev.stderr || rev.stdout }

  const mrg = await captureOutput(() => handleMerge({ task: taskId, 'reviewer-id': `rev-${taskId}`, json: true }, roots))
  if (mrg.result.exitCode !== EXIT.OK) return { ok: false, step: 'merge', err: mrg.stderr || mrg.stdout }

  if (withCleanup) {
    const pre = await captureOutput(() => handleCleanup({ task: taskId, json: true }, roots))
    const preJson = JSON.parse(pre.stdout)
    const cl = await captureOutput(() => handleCleanup({
      task: taskId, confirm: true, 'preview-hash': preJson.previewHash, json: true,
    }, roots))
    if (cl.result.exitCode !== EXIT.OK) return { ok: false, step: 'cleanup', err: cl.stderr || cl.stdout }
  }
  return { ok: true, promote: proJson, sbDir }
}

export function registerHeterogeneousDualLoopCases(cases) {
  cases.push(['[Heterogeneous-C9] triage 确定性三出口、去 fileCount>=6 悬崖、保 fileCount>=12 prdNeed、Case 5/PRD 正交与两处按需 Brief', async () => {
    const rules = await import('../../kit/skills/dev-plan/scripts/triage-rules.mjs')
    if (typeof rules.resolveRecommendedEntry !== 'function' || typeof rules.shouldAutoTriggerBrief !== 'function') {
      return 'triage-rules.mjs 缺少 resolveRecommendedEntry 或 shouldAutoTriggerBrief 导出'
    }

    const dir = tmpProject({
      ...makeSkillStubs(),
      'README.md': '# demo\n',
      'AGENTS.md': makeBaseProfileAgents('c9-triage'),
      'src/ui/a.tsx': 'export const A = () => 1\n',
      'src/ui/b.tsx': 'export const B = () => 2\n',
      'src/ui/c.tsx': 'export const C = () => 3\n',
      'src/ui/d.tsx': 'export const D = () => 4\n',
      'src/ui/e.tsx': 'export const E = () => 5\n',
      'src/ui/f.tsx': 'export const F = () => 6\n',
      'src/ui/g.tsx': 'export const G = () => 7\n',
    })
    initCleanGitRepo(dir)
    try {
      // 1. Case 1 -> recommendedEntry='direct', briefRecommended=false
      const r1 = triageTask({ summary: 'fix typo in README.md', paths: ['README.md'], repoRoot: dir })
      if (r1.caseType !== 1 || r1.recommendedEntry !== 'direct' || r1.briefRecommended !== false) {
        return `Case 1 分流异常：${JSON.stringify({ caseType: r1.caseType, recommendedEntry: r1.recommendedEntry, briefRecommended: r1.briefRecommended })}`
      }
      const cli1 = await runAbsAsync(DOC_PLAN, ['triage', '--summary', 'fix typo in README.md', '--paths', 'README.md', '--json'], { cwd: dir })
      if (cli1.status !== 0) return `Case 1 CLI triage 失败：${cli1.stderr}`
      const j1 = JSON.parse(cli1.stdout)
      if (j1.recommendedEntry !== 'direct' || j1.nextSteps?.length !== 1 || j1.nextSteps[0].includes('--sandbox')) {
        return `Case 1 CLI nextSteps 异常：${JSON.stringify({ recommendedEntry: j1.recommendedEntry, nextSteps: j1.nextSteps })}`
      }

      // 2. Case 2 -> recommendedEntry='sandbox', briefRecommended=false, 单一 [NEXT STEP] 指向 start --sandbox
      const cli2 = await runAbsAsync(DOC_PLAN, ['triage', '--summary', 'fix null check in parser', '--bugfix', '--files', '1', '--json'], { cwd: dir })
      if (cli2.status !== 0) return `Case 2 CLI triage 失败：${cli2.stderr}`
      const j2 = JSON.parse(cli2.stdout)
      if (j2.caseType !== 2 || j2.recommendedEntry !== 'sandbox' || j2.briefRecommended !== false || j2.visualBrief) {
        return `Case 2 出口或 Brief 异常：${JSON.stringify({ caseType: j2.caseType, recommendedEntry: j2.recommendedEntry, briefRecommended: j2.briefRecommended, visualBrief: j2.visualBrief })}`
      }
      if (j2.nextSteps?.length !== 1 || !j2.nextSteps[0].includes('start --sandbox')) {
        return `Case 2 单一 NEXT STEP 未指向 start --sandbox：${JSON.stringify(j2.nextSteps)}`
      }

      // 3. 7 个可逆前端组件文件 -> 留在 Case 3（已去 fileCount>=6 悬崖），recommendedEntry='sandbox'，默认零 Brief 开销
      const sevenUiPaths = ['src/ui/a.tsx', 'src/ui/b.tsx', 'src/ui/c.tsx', 'src/ui/d.tsx', 'src/ui/e.tsx', 'src/ui/f.tsx', 'src/ui/g.tsx']
      const cli3 = await runAbsAsync(DOC_PLAN, [
        'triage', '--summary', '调整 7 个按钮组件圆角与悬浮样式', '--paths', sevenUiPaths.join(','), '--files', '7', '--json',
      ], { cwd: dir })
      if (cli3.status !== 0) return `7 文件可逆 UI triage 失败：${cli3.stderr}`
      const j3 = JSON.parse(cli3.stdout)
      if (j3.caseType !== 3 || j3.recommendedEntry !== 'sandbox' || j3.briefRecommended !== false || j3.visualBrief) {
        return `7 文件可逆 UI 不应因 fileCount>=6 钝化升 Case 4 或预建 Brief：${JSON.stringify({ caseType: j3.caseType, recommendedEntry: j3.recommendedEntry, briefRecommended: j3.briefRecommended, visualBrief: j3.visualBrief })}`
      }
      if (j3.nextSteps?.length !== 1 || !j3.nextSteps[0].includes('start --sandbox')) {
        return `Case 3 sandbox 单一 NEXT STEP 异常：${JSON.stringify(j3.nextSteps)}`
      }
      if (existsSync(resolveBriefsDir(dir))) {
        return '局部可逆 Case 3 默认不应创建仓外 briefs 目录'
      }

      // 4. 保留 fileCount >= 12 -> prdRequired=true -> Case 4 + recommendedEntry='plan-first' + sandboxPocAllowed=true + briefRecommended=true
      const r12 = triageTask({ summary: '批量改造 12 个功能页面交互', files: 12, repoRoot: dir })
      if (r12.caseType !== 4 || r12.prdRequired !== true || r12.recommendedEntry !== 'plan-first' || r12.sandboxPocAllowed !== true || r12.briefRecommended !== true) {
        return `fileCount>=12 prdNeed 判据丢失或三出口字段异常：${JSON.stringify({ caseType: r12.caseType, prdRequired: r12.prdRequired, recommendedEntry: r12.recommendedEntry, sandboxPocAllowed: r12.sandboxPocAllowed, briefRecommended: r12.briefRecommended })}`
      }

      // 5. Case 4 (touchesContract) CLI -> recommendedEntry='plan-first', sandboxPocAllowed=true, briefRecommended=true, 单一 NEXT STEP
      const cli4 = await runAbsAsync(DOC_PLAN, [
        'triage', '--summary', '跨模块导出协议重构', '--touches-contract', '--topic', 'proto-c4', '--json',
      ], { cwd: dir })
      if (cli4.status !== 0) return `Case 4 CLI triage 失败：${cli4.stderr}`
      const j4 = JSON.parse(cli4.stdout)
      if (j4.caseType !== 4 || j4.recommendedEntry !== 'plan-first' || j4.sandboxPocAllowed !== true || j4.briefRecommended !== true || !j4.visualBrief) {
        return `Case 4 出口/Brief 异常：${JSON.stringify({ caseType: j4.caseType, recommendedEntry: j4.recommendedEntry, sandboxPocAllowed: j4.sandboxPocAllowed, briefRecommended: j4.briefRecommended, hasBrief: Boolean(j4.visualBrief) })}`
      }
      if (j4.nextSteps?.length !== 1 || !j4.nextSteps[0].includes('init --kind pair') || !j4.nextSteps[0].includes('--agent')) {
        return `Case 4 单一 NEXT STEP 异常：${JSON.stringify(j4.nextSteps)}`
      }

      // 6. Case 5 与 PRD 严格正交：即使传 --files 14 且文案含分批词，conflictsTdd=true 仍须 caseType=5 且 prdRequired=false
      const cli5 = await runAbsAsync(DOC_PLAN, [
        'triage', '--summary', '拆成三批推翻 TDD 重构底层架构与全部接口', '--files', '14', '--conflicts-tdd', '--json',
      ], { cwd: dir })
      if (cli5.status !== 0) return `Case 5 CLI triage 失败：${cli5.stderr}`
      const j5 = JSON.parse(cli5.stdout)
      if (j5.caseType !== 5 || j5.prdRequired !== false || j5.recommendedEntry !== 'plan-first' || j5.briefRecommended !== true) {
        return `Case 5 未与 PRD 严格正交：${JSON.stringify({ caseType: j5.caseType, prdRequired: j5.prdRequired, recommendedEntry: j5.recommendedEntry, briefRecommended: j5.briefRecommended })}`
      }
      if (j5.nextSteps?.length !== 1 || !j5.nextSteps[0].includes('init --kind tdd')) {
        return `Case 5 单一 NEXT STEP 异常：${JSON.stringify(j5.nextSteps)}`
      }

      // 7. 统筹两处 Brief 触发：局部可逆 Case 3 单轮 note 零 Brief 开销；多轮 note 仍自动触发；含原型关键词触发
      const dirBrief = tmpProject({ ...makeSkillStubs(), 'AGENTS.md': makeBaseProfileAgents('c9-brief') })
      initCleanGitRepo(dirBrief)
      try {
        await runAbsAsync(DOC_PLAN, ['triage', '--summary', '给导出命令加一个 --compact 参数', '--topic', 'local-c3', '--files', '2', '--json'], { cwd: dirBrief })
        const note1 = await runAbsAsync(DOC_PLAN, ['note', '--topic', 'local-c3', '--decision', '默认关闭 compact', '--json'], { cwd: dirBrief })
        if (note1.status !== 0) return `Case 3 首轮 note 失败：${note1.stderr}`
        if (JSON.parse(note1.stdout).visualBrief) {
          return `局部可逆 Case 3 单轮 note 不应提前生成 Brief：${note1.stdout}`
        }
        const note2 = await runAbsAsync(DOC_PLAN, ['note', '--topic', 'local-c3', '--open', '确认列宽?', '--json'], { cwd: dirBrief })
        if (note2.status !== 0) return `Case 3 多轮 note 失败：${note2.stderr}`
        if (!JSON.parse(note2.stdout).visualBrief) {
          return `多轮讨论 note 应自动触发 Living Visual Brief：${note2.stdout}`
        }
        const protoTri = await runAbsAsync(DOC_PLAN, ['triage', '--summary', '卡片布局多方向原型对比', '--files', '2', '--json'], { cwd: dirBrief })
        const jProto = JSON.parse(protoTri.stdout)
        if (jProto.briefRecommended !== true || !jProto.visualBrief) {
          return `含原型关键词的 Case 3 未按需触发 Brief：${protoTri.stdout}`
        }
      } finally { rmTree(dirBrief) }

      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['[Heterogeneous-C11] 异构栈组 A：空/极简仓、Node/TS 单包与 Monorepo（子包共享挂载）、无清单非 JS 通用仓', async () => {
    // Profile 1: 空/极简仓库（无 package.json，仅 README.md + 单脚本）
    const minimalDir = tmpProject({
      ...makeSkillStubs(),
      'README.md': '# minimal-repo\n',
      'AGENTS.md': makeBaseProfileAgents('minimal-repo'),
      'hello.mjs': 'export const greet = () => "hi"\n',
    })
    // Profile 2: Node/TS 单包与 Monorepo（pnpm-workspace.yaml + 根与子包未跟踪共享依赖）
    const monoDir = tmpProject({
      ...makeSkillStubs(),
      'package.json': JSON.stringify({ name: 'mono-root', private: true, workspaces: ['packages/*'] }, null, 2),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n',
      'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
      'AGENTS.md': makeBaseProfileAgents('mono-root'),
      'packages/web/package.json': JSON.stringify({ name: '@mono/web', version: '1.0.0' }, null, 2),
      'packages/web/src/index.ts': 'export const version: number = 1\n',
    })
    // Profile 6: 无清单非 JS 通用仓库（Makefile + Shell/C 脚本，验证 smoke-verify 与 quick-test）
    const nonJsDir = tmpProject({
      ...makeSkillStubs(),
      'AGENTS.md': makeBaseProfileAgents('nonjs-make', { smoke: 'node -e "process.exit(0)"' }),
      'Makefile': 'all:\n\t@echo ok\ntest:\n\t@echo pass\n',
      'scripts/build.sh': '#!/bin/sh\necho build\n',
      'src/main.c': 'int main(void) { return 0; }\n',
    })

    initCleanGitRepo(minimalDir)
    initCleanGitRepo(monoDir)
    mkdirSync(join(monoDir, 'node_modules', 'root-shared'), { recursive: true })
    writeFileSync(join(monoDir, 'node_modules', 'root-shared', 'index.js'), 'module.exports = "root-intact"\n', 'utf8')
    mkdirSync(join(monoDir, 'packages', 'web', 'node_modules', 'web-shared'), { recursive: true })
    writeFileSync(join(monoDir, 'packages', 'web', 'node_modules', 'web-shared', 'index.js'), 'module.exports = "web-intact"\n', 'utf8')
    initCleanGitRepo(nonJsDir)
    try {
      // Profile 1
      const tMin = triageTask({ summary: 'fix greet return value in hello.mjs', paths: ['hello.mjs'], repoRoot: minimalDir })
      if (tMin.recommendedEntry !== 'sandbox') return `Profile 1 triage 出口错：${JSON.stringify(tMin.recommendedEntry)}`
      const rMin = await runSandboxToMergedLoop(minimalDir, {
        taskId: 'het-min',
        mutateFn: (sb) => writeFileSync(join(sb, 'hello.mjs'), 'export const greet = () => "hello"\n', 'utf8'),
        commitMsg: 'fix: update greet output',
      })
      if (!rMin.ok) return `Profile 1 空/极简仓双环失败 (${rMin.step}): ${rMin.err}`

      // Profile 2
      const rMono = await runSandboxToMergedLoop(monoDir, {
        taskId: 'het-mono',
        mutateFn: (sb) => {
          if (!lstatSync(join(sb, 'node_modules')).isSymbolicLink() || !lstatSync(join(sb, 'packages/web/node_modules')).isSymbolicLink()) {
            throw new Error('Monorepo 沙箱未按子包共享挂载根与子包 node_modules')
          }
          writeFileSync(join(sb, 'packages/web/src/index.ts'), 'export const version: number = 2\n', 'utf8')
        },
        commitMsg: 'feat(web): bump version constant',
      })
      if (!rMono.ok) return `Profile 2 Node/TS Monorepo 双环失败 (${rMono.step}): ${rMono.err}`
      if (!existsSync(join(monoDir, 'node_modules/root-shared/index.js')) || !existsSync(join(monoDir, 'packages/web/node_modules/web-shared/index.js'))) {
        return 'Profile 2 cleanup 后误损主仓或子包共享 node_modules'
      }

      // Profile 6 (non-JS manifestless with smoke-verify)
      const rNonJs = await runSandboxToMergedLoop(nonJsDir, {
        taskId: 'het-make',
        mutateFn: (sb) => writeFileSync(join(sb, 'src/main.c'), 'int main(void) { return 0; /* ok */ }\n', 'utf8'),
        commitMsg: 'fix: adjust C entrypoint',
        verifyOpts: { 'e2e-evidence': 'ran smoke-verify node -e exit 0 on Makefile C project' },
      })
      if (!rNonJs.ok) return `Profile 6 无清单非 JS 通用仓双环失败 (${rNonJs.step}): ${rNonJs.err}`
      return true
    } finally {
      rmTree(minimalDir)
      rmTree(monoDir)
      rmTree(nonJsDir)
    }
  }])

  cases.push(['[Heterogeneous-C11] 异构栈组 B：Python / Go / Rust 后端仓与 Prisma/SQL 数据重型仓', async () => {
    // Profile 3: Python / Go / Rust（无 package.json）
    const pyDir = tmpProject({
      ...makeSkillStubs(),
      'pyproject.toml': '[project]\nname = "py-svc"\nversion = "0.1.0"\n',
      'AGENTS.md': makeBaseProfileAgents('py-svc'),
      'app/service.py': 'def score(x: int) -> int:\n    return x + 1\n',
    })
    const goDir = tmpProject({
      ...makeSkillStubs(),
      'go.mod': 'module example.com/gosvc\n\ngo 1.22\n',
      'AGENTS.md': makeBaseProfileAgents('go-svc'),
      'cmd/server/main.go': 'package main\nfunc main() {}\n',
    })
    const rsDir = tmpProject({
      ...makeSkillStubs(),
      'Cargo.toml': '[package]\nname = "rs_svc"\nversion = "0.1.0"\nedition = "2021"\n',
      'AGENTS.md': makeBaseProfileAgents('rs-svc'),
      'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 { a + b }\n',
    })
    // Profile 4: Prisma / SQL 数据重型仓
    const sqlDir = tmpProject({
      ...makeSkillStubs(),
      'package.json': JSON.stringify({ name: 'sql-svc', version: '1.0.0' }, null, 2),
      'AGENTS.md': makeBaseProfileAgents('sql-svc', { smoke: 'node -e "process.exit(0)"' }),
      'prisma/schema.prisma': 'model User {\n  id Int @id\n}\n',
      'prisma/migrations/001_init.sql': 'CREATE TABLE users (id INT PRIMARY KEY);\n',
      'src/repo.mjs': 'export const findUsers = () => []\n',
    })

    initCleanGitRepo(pyDir)
    initCleanGitRepo(goDir)
    initCleanGitRepo(rsDir)
    initCleanGitRepo(sqlDir)
    try {
      for (const [label, dir, rel, nextContent] of [
        ['Python', pyDir, 'app/service.py', 'def score(x: int) -> int:\n    return x + 2\n'],
        ['Go', goDir, 'cmd/server/main.go', 'package main\nfunc main() { _ = 1 }\n'],
        ['Rust', rsDir, 'src/lib.rs', 'pub fn add(a: i32, b: i32) -> i32 { a + b + 0 }\n'],
      ]) {
        const pol = determineWorkflowPolicy({ changedFiles: [rel], caseType: 2, profile: { explicitNone: new Set(['smoke-verify']) } })
        if (pol.riskTier !== 'medium' || pol.faultInjectionRequired !== false) {
          return `Profile 3 ${label} 三轴策略异常：${JSON.stringify({ riskTier: pol.riskTier, faultInjectionRequired: pol.faultInjectionRequired })}`
        }
        const loop = await runSandboxToMergedLoop(dir, {
          taskId: `het-${label.toLowerCase()}`,
          mutateFn: (sb) => writeFileSync(join(sb, rel), nextContent, 'utf8'),
          commitMsg: `fix(${label.toLowerCase()}): update handler`,
        })
        if (!loop.ok) return `Profile 3 ${label} 仓双环失败 (${loop.step}): ${loop.err}`
      }

      // Profile 4: Prisma / SQL 迁移改动 -> 真实 diff 触发 one-way -> promote 必返 SANDBOX_PROMOTE_NEEDS_SPEC + faultInjectionRequired=true
      const sqlRoots = await resolveRepoRoots(sqlDir)
      const sqlStart = await captureOutput(() => handleStart({
        sandbox: true, task: 'het-sql', slug: 'het-sql', agent: 'impl-sql', json: true,
      }, sqlRoots))
      if (sqlStart.result.exitCode !== EXIT.OK) return `Profile 4 start --sandbox 失败：${sqlStart.stderr}`
      const sqlSb = join(sqlDir, '.worktrees', 'sandbox-het-sql')
      writeFileSync(join(sqlSb, 'prisma/migrations/002_add_audit.sql'), 'ALTER TABLE users ADD COLUMN role TEXT;\n', 'utf8')
      gitCommitFast(sqlSb, 'feat(db): add role column migration')
      const sqlPro = await captureOutput(() => handlePromote({ task: 'het-sql', json: true }, sqlRoots))
      if (sqlPro.result.exitCode !== EXIT.OK || !sqlPro.stdout.includes('SANDBOX_PROMOTE_NEEDS_SPEC')) {
        return `Profile 4 SQL 迁移 promote 未拦为 SANDBOX_PROMOTE_NEEDS_SPEC：exit=${sqlPro.result.exitCode} out=${sqlPro.stdout} err=${sqlPro.stderr}`
      }
      const sqlJson = JSON.parse(sqlPro.stdout)
      if (sqlJson.status !== 'sandbox-needs-spec' || sqlJson.policy?.riskTier !== 'high' || sqlJson.policy?.faultInjectionRequired !== true) {
        return `Profile 4 SQL 迁移外环策略未标 high/faultInjectionRequired：${JSON.stringify({ status: sqlJson.status, policy: sqlJson.policy })}`
      }
      if ((sqlJson.linkedIssues ?? []).length !== 0) {
        return `Profile 4 Case 4 PoC 不应提前新建 Issue：${JSON.stringify(sqlJson.linkedIssues)}`
      }
      return true
    } finally {
      rmTree(pyDir)
      rmTree(goDir)
      rmTree(rsDir)
      rmTree(sqlDir)
    }
  }])

  cases.push(['[Heterogeneous-C11] 异构栈组 C：UI 重型前端仓（三轴正交视觉独立）与 generic-git 非 GitHub 远端闭环', async () => {
    // Profile 5: UI 重型前端仓
    const uiDir = tmpProject({
      ...makeSkillStubs(),
      'package.json': JSON.stringify({ name: 'ui-web', version: '1.0.0' }, null, 2),
      'AGENTS.md': makeBaseProfileAgents('ui-web'),
      'src/components/Btn1.tsx': 'export const Btn1 = () => "b1"\n',
      'src/components/Btn2.tsx': 'export const Btn2 = () => "b2"\n',
      'src/components/Btn3.tsx': 'export const Btn3 = () => "b3"\n',
      'src/components/Btn4.tsx': 'export const Btn4 = () => "b4"\n',
      'src/components/Btn5.tsx': 'export const Btn5 = () => "b5"\n',
      'src/components/Btn6.tsx': 'export const Btn6 = () => "b6"\n',
      'src/styles/theme.css': '.btn { border-radius: 4px; }\n',
    })
    initCleanGitRepo(uiDir)

    // Profile 7: generic-git 非 GitHub 远端（本地 bare remote）
    const bareDir = tmpProject({})
    gitSync(bareDir, ['init', '--bare'])
    const genDir = tmpProject({
      ...makeSkillStubs(),
      'AGENTS.md': makeBaseProfileAgents('generic-git-demo'),
      'src/core.mjs': 'export const compute = (n) => n * 2\n',
    })
    initCleanGitRepo(genDir, { origin: bareDir.replace(/\\/g, '/') })
    gitSync(genDir, ['push', '-u', 'origin', 'main'])

    try {
      // Profile 5: 7 UI 文件 triage -> Case 3 + sandbox；promote -> 原地晋升 Case 3，medium + visualCheckRequired=true + faultInjectionRequired=false
      const uiPaths = [
        'src/components/Btn1.tsx', 'src/components/Btn2.tsx', 'src/components/Btn3.tsx',
        'src/components/Btn4.tsx', 'src/components/Btn5.tsx', 'src/components/Btn6.tsx',
        'src/styles/theme.css',
      ]
      const uiTri = triageTask({ summary: '统一 7 个按钮组件与样式圆角', paths: uiPaths, files: 7, repoRoot: uiDir })
      if (uiTri.caseType !== 3 || uiTri.recommendedEntry !== 'sandbox' || uiTri.briefRecommended !== false) {
        return `Profile 5 UI triage 异常：${JSON.stringify({ caseType: uiTri.caseType, recommendedEntry: uiTri.recommendedEntry, briefRecommended: uiTri.briefRecommended })}`
      }
      const uiRoots = await resolveRepoRoots(uiDir)
      await captureOutput(() => handleStart({ sandbox: true, task: 'het-ui', slug: 'het-ui', agent: 'impl-ui', json: true }, uiRoots))
      const uiSb = join(uiDir, '.worktrees', 'sandbox-het-ui')
      writeFileSync(join(uiSb, 'src/styles/theme.css'), '.btn { border-radius: 8px; }\n', 'utf8')
      writeFileSync(join(uiSb, 'src/components/Chip.tsx'), 'export const Chip = () => "chip"\n', 'utf8')
      gitCommitFast(uiSb, 'feat(ui): round buttons and add chip')

      const uiInner = await captureOutput(() => handleVerify({
        task: 'het-ui', mode: 'full', inner: true, 'visual-blocked-reason': 'headless test env', json: true,
      }, uiRoots))
      if (uiInner.result.exitCode !== EXIT.OK) return `Profile 5 UI 内环 verify 失败：${uiInner.stderr}`

      const uiPro = await captureOutput(() => handlePromote({
        task: 'het-ui', 'no-issue': true, reason: 'ui heterogeneous test', json: true,
      }, uiRoots))
      if (uiPro.result.exitCode !== EXIT.OK) return `Profile 5 UI promote 失败：${uiPro.stderr}`
      const uiProJson = JSON.parse(uiPro.stdout)
      if (
        uiProJson.caseType !== 3
        || uiProJson.policy?.riskTier !== 'medium'
        || uiProJson.policy?.visualCheckRequired !== true
        || uiProJson.policy?.faultInjectionRequired !== false
      ) {
        return `Profile 5 UI 三轴策略不符：${JSON.stringify({ caseType: uiProJson.caseType, policy: uiProJson.policy })}`
      }
      // 反面：外环 verify 缺视觉证据必须阻断；正面：带 --visual-blocked-reason 通过
      const uiNoVis = await captureOutput(() => handleVerify({ task: 'het-ui', mode: 'full', json: true }, uiRoots))
      if (uiNoVis.result.exitCode !== EXIT.FACT) {
        return `Profile 5 UI 外环 verify 缺视觉证据未阻断：exit=${uiNoVis.result.exitCode}`
      }
      const uiOuter = await captureOutput(() => handleVerify({
        task: 'het-ui', mode: 'full', 'visual-blocked-reason': 'headless CI without browser display', json: true,
      }, uiRoots))
      if (uiOuter.result.exitCode !== EXIT.OK) return `Profile 5 UI 外环 verify 失败：${uiOuter.stderr}`

      // Profile 7: generic-git 非 GitHub 远端双环闭环（先验未远端合入时 merge 阻断，再模拟远端合入后 merge 核验通过）
      const genRoots = await resolveRepoRoots(genDir)
      const genStart = await captureOutput(() => handleStart({
        sandbox: true, task: 'het-gen', slug: 'het-gen', agent: 'impl-gen', json: true,
      }, genRoots))
      if (genStart.result.exitCode !== EXIT.OK) return `Profile 7 generic-git start --sandbox 失败：${genStart.stderr}`
      const genLedger0 = readTaskLedger(genDir, 'het-gen')
      if (genLedger0?.providerId !== 'generic-git') {
        return `Profile 7 未识别为 generic-git：providerId=${genLedger0?.providerId}`
      }
      const genSb = join(genDir, '.worktrees', 'sandbox-het-gen')
      writeFileSync(join(genSb, 'src/core.mjs'), 'export const compute = (n) => n * 3\n', 'utf8')
      gitCommitFast(genSb, 'fix: adjust compute multiplier')

      const genInner = await captureOutput(() => handleVerify({ task: 'het-gen', mode: 'full', inner: true, json: true }, genRoots))
      if (genInner.result.exitCode !== EXIT.OK) return `Profile 7 generic-git 内环 verify 失败：${genInner.stderr}`

      const genPro = await captureOutput(() => handlePromote({
        task: 'het-gen', 'no-issue': true, reason: 'generic-git local bare test', json: true,
      }, genRoots))
      if (genPro.result.exitCode !== EXIT.OK) return `Profile 7 generic-git promote 失败：${genPro.stderr}`

      const genOuter = await captureOutput(() => handleVerify({ task: 'het-gen', mode: 'full', json: true }, genRoots))
      if (genOuter.result.exitCode !== EXIT.OK) return `Profile 7 generic-git 外环 verify 失败：${genOuter.stderr}`

      const genSub = await captureOutput(() => handleSubmit({ task: 'het-gen', agent: 'impl-gen', json: true }, genRoots))
      if (genSub.result.exitCode !== EXIT.OK) return `Profile 7 generic-git submit 失败：${genSub.stderr}`

      const genHead = gitSync(genSb, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      const genLedger1 = readTaskLedger(genDir, 'het-gen')
      const { token: genTok } = ensureReviewToken(genDir, genLedger1, 1, { headSha: genHead })
      const genRev = await captureOutput(() => handleRecord({
        task: 'het-gen', round: '1', verdict: 'pass', 'reviewer-id': 'rev-gen',
        'review-token': genTok, evidence: 'ran full verify exit 0 on generic-git repo',
        'enforce-gates': false, json: true,
      }, genRoots))
      if (genRev.result !== EXIT.OK) return `Profile 7 generic-git review 失败：${genRev.stderr}`

      // 反面：远端尚未合并时 generic-git merge 必须硬阻断（不越权本地强合）
      const genMrgBlock = await captureOutput(() => handleMerge({ task: 'het-gen', 'reviewer-id': 'rev-gen', json: true }, genRoots))
      if (genMrgBlock.result.exitCode !== EXIT.FACT) {
        return `Profile 7 generic-git 远端未合入时 merge 未阻断：exit=${genMrgBlock.result.exitCode} out=${genMrgBlock.stdout}`
      }
      // 正面：模拟远端 MR 合入 origin/main 后，merge 现场取回并核验通过
      const pushMain = gitSync(genSb, ['push', 'origin', `HEAD:refs/heads/main`])
      if (pushMain.status !== 0) return `Profile 7 模拟远端合入失败：${pushMain.stderr}`
      const genMrgOk = await captureOutput(() => handleMerge({ task: 'het-gen', 'reviewer-id': 'rev-gen', json: true }, genRoots))
      if (genMrgOk.result.exitCode !== EXIT.OK) {
        return `Profile 7 generic-git 远端合入后 merge 核验失败：exit=${genMrgOk.result.exitCode} err=${genMrgOk.stderr}`
      }
      return true
    } finally {
      rmTree(uiDir)
      rmTree(genDir)
      rmTree(bareDir)
    }
  }])
}
