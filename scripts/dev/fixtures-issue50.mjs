/**
 * fixtures-issue50.mjs —— Issue #50（C1..C10 平台能力与文档系统闭环）正反双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { survey } from '../survey.mjs'
import { toMarkdown } from '../lib/render.mjs'
import { reviewProject } from '../review.mjs'
import { ARTIFACT_EXECUTORS, findUnexecutableArtifacts } from '../lib/artifact-executors.mjs'
import { checkGovernancePrdCoverage } from '../lib/review-helpers.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { hasExploredEvidence, readTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { parseDocFrontmatter, syncDocsLifecycle } from '../../kit/skills/lib/docs.mjs'
import { resolveDocRequirements } from '../../kit/skills/lib/doc-requirements.mjs'
import { collectTddFacts } from '../../kit/skills/lib/tdd-facts.mjs'
import { buildPreFilledTdd } from '../../kit/skills/lib/tdd-scaffold.mjs'
import { checkTddStructure } from '../../kit/skills/lib/tdd-structure.mjs'
import { auditDoc, checkMasterPrdCoverage, checkOrphanSlices, triageTask } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleExplore } from '../../kit/skills/dev-flow/scripts/flow-explore.mjs'
import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { handleFinalize, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleClaim, handleMerge } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { assessStructuralGate } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { SKILL_ROOT, gitInit, gitSync, rmTree, runAbsAsync, runNode, seedExploredFor, tmpProject } from './fixtures-helpers.mjs'

function makeNodeGitProject(extraFiles = {}, gitOpts = {}, pkgOpts = {}) {
  const pkg = {
    name: 'issue50-demo',
    version: '1.0.0',
    ...(pkgOpts.publishable ? {} : { private: true }),
    scripts: { test: 'node test/ok.test.mjs' },
  }
  const dir = tmpProject({
    '.gitignore': '.worktrees/\nnode_modules/\n',
    'package.json': JSON.stringify(pkg, null, 2),
    'README.md': '# issue50-demo\n\nIssue 50 test repo.\n',
    'src/index.mjs': 'export function main() { return 1 }\n',
    'test/ok.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n',
    ...extraFiles,
  })
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com', ...gitOpts })
  return dir
}

function validGovTdd() {
  return [
    '# 技术设计文档（TDD）',
    '',
    '- **文档版本**：1.0.0',
    '- **最近更新**：2026-01-01',
    '',
    '## 1. 背景、定位与非目标',
    '- **核心定位**：提供示例任务编排能力。',
    '- **明确不做**：不做跨进程持久化。',
    '',
    '## 2. 系统架构全景',
    '| 模块 | 职责 | 依赖方向 | 入口文件 |',
    '| --- | --- | --- | --- |',
    '| `src/` | 核心入口 | 零外部依赖 | `src/index.mjs` |',
    '',
    '## 3. 核心流程',
    '- 正常主链路：调用 `src/index.mjs` 读取配置并返回状态。',
    '',
    '## 4. 不变量与安全红线',
    '- 单一真相源：仅从配置文件读取参数。',
    '',
    '## 5. 构建与验证链路',
    '- `quick-test`: `node test/ok.test.mjs`',
    '',
  ].join('\n')
}

export function registerIssue50Cases(cases) {
  cases.push(['C1 回归：survey 产物计划与 QUESTION_RULES 兑现 AGENTS.md 取舍及 needsHuman', async () => {
    const dir = makeNodeGitProject({}, { origin: 'https://github.com/acme/demo.git' })
    try {
      const fAsk = await survey(dir)
      const askLic = fAsk.artifactPlan.find((a) => a.id === 'license')
      if (!askLic || askLic.action !== 'ask-human') return `未表态时 license 应为 ask-human，实际：${JSON.stringify(askLic)}`
      if (!fAsk.questions.some((q) => q.id === 'q.license')) return `未表态时 questions 应含 q.license：${JSON.stringify(fAsk.questions)}`
      if (!fAsk.needsHuman?.required || (fAsk.needsHuman.count ?? 0) < 1) return `needsHuman 未置位：${JSON.stringify(fAsk.needsHuman)}`
      const mdAsk = toMarkdown(fAsk)
      if (!mdAsk.includes('<!-- NEEDS_HUMAN: count=')) return `render.mjs 未输出 NEEDS_HUMAN 标记：\n${mdAsk}`

      writeFileSync(join(dir, 'AGENTS.md'), [
        '# AGENTS',
        '',
        '## 取舍',
        '',
        '```text',
        '- `license`: MIT 开源授权',
        '- `no-contributing`: 单人仓库暂不接收 PR',
        '- `no-tdd`: 原型期暂不单建 TDD',
        '- `no-ci`: 本地手跑门禁',
        '- `no-auto-release`: 手动发版',
        '```',
        '',
      ].join('\n'), 'utf8')
      const fDecided = await survey(dir)
      const byId = Object.fromEntries(fDecided.artifactPlan.map((a) => [a.id, a]))
      if (byId.license?.action !== 'create') return `表态 license=MIT 后应转为 create，实际：${JSON.stringify(byId.license)}`
      if (byId.contributing?.action !== 'skip') return `no-contributing 未兑现：${JSON.stringify(byId.contributing)}`
      if (byId['docs-tdd']?.action !== 'skip') return `no-tdd 未兑现：${JSON.stringify(byId['docs-tdd'])}`
      if (byId['ci-check']?.action !== 'skip') return `no-ci 未兑现：${JSON.stringify(byId['ci-check'])}`
      if (byId['ci-release']?.action !== 'skip') return `no-auto-release 未兑现：${JSON.stringify(byId['ci-release'])}`
      if (fDecided.questions.some((q) => q.id === 'q.license' || q.id === 'q.release-strategy')) {
        return `已表态问题仍出现在 questions：${JSON.stringify(fDecided.questions)}`
      }
      if (fDecided.needsHuman?.required !== false || fDecided.needsHuman?.count !== 0) {
        return `全部表态后 needsHuman 应清零：${JSON.stringify(fDecided.needsHuman)}`
      }

      writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS\n\n## 取舍\n\n```text\n- `license`: 暂不授权\n```\n', 'utf8')
      const fSkipLic = await survey(dir)
      const skipLic = fSkipLic.artifactPlan.find((a) => a.id === 'license')
      if (skipLic?.action !== 'skip') return `表态不公开授权时 license 应为 skip，实际：${JSON.stringify(skipLic)}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C2 回归：非 GitHub 远端隐藏 release 策略且 review --json 输出 git.capabilities', async () => {
    const dir = makeNodeGitProject({}, { origin: 'https://git.internal.corp/team/repo.git' }, { publishable: true })
    const dirGh = makeNodeGitProject({}, { origin: 'https://github.com/acme/demo.git' }, { publishable: true })
    try {
      gitSync(dir, ['tag', 'v1.0.0'])
      const f = await survey(dir)
      if (f.git.capabilities?.releases !== false) return `generic-git releases 应为 false：${JSON.stringify(f.git.capabilities)}`
      const ciRel = f.artifactPlan.find((a) => a.id === 'ci-release')
      if (ciRel?.action === 'ask-human') return `非 GitHub 远端不应给出 ask-human 发版策略：${JSON.stringify(ciRel)}`
      const relQ = f.questions.find((q) => q.id === 'q.release-strategy')
      if (relQ && /RELEASE_TOKEN|gh release/i.test(relQ.text)) {
        return `非 GitHub 远端 q.release-strategy 不得出现 GitHub 专用命令或 RELEASE_TOKEN：${relQ.text}`
      }

      const fGh = await survey(dirGh)
      if (fGh.git.capabilities?.releases !== true) return `GitHub 远端 releases 应为 true：${JSON.stringify(fGh.git.capabilities)}`
      const relQGh = fGh.questions.find((q) => q.id === 'q.release-strategy')
      if (!relQGh || !/5 选 1/.test(relQGh.text)) return `GitHub 远端应保留 5 选 1 发版策略问句：${JSON.stringify(relQGh)}`

      const revCli = await runNode('review.mjs', [dir, '--json'])
      if (revCli.status !== 0 && revCli.status !== 1) return `review.mjs --json 异常退出 ${revCli.status}: ${revCli.stderr}`
      const parsed = JSON.parse(revCli.stdout)
      if (!parsed.git?.capabilities || parsed.git.capabilities.releases !== false || parsed.git.capabilities.providerId !== 'generic-git') {
        return `review.mjs --json 缺少预期 git.capabilities：${JSON.stringify(parsed.git)}`
      }
      return true
    } finally { rmTree(dir); rmTree(dirGh) }
  }])

  cases.push(['C3 回归：review artifacts 切面与执行器对齐', async () => {
    for (const key of ['kit-skills', 'contributing', 'license']) {
      if (!ARTIFACT_EXECUTORS[key]) return `ARTIFACT_EXECUTORS 缺少键 ${key}`
    }
    for (const legacy of ['docs-set', 'skills-kit']) {
      if (ARTIFACT_EXECUTORS[legacy]) return `ARTIFACT_EXECUTORS 存在失效旧键 ${legacy}`
    }
    const skipCheck = findUnexecutableArtifacts([
      { id: 'x-opt', artifact: 'X', action: 'optional' },
      { id: 'x-upg', artifact: 'Y', action: 'upgrade' },
      { id: 'kit-skills', artifact: '.agents/skills/', action: 'create' },
    ])
    if (skipCheck.length !== 0) return `optional/upgrade/kit-skills 不应报缺执行者：${JSON.stringify(skipCheck)}`
    const badCheck = findUnexecutableArtifacts([{ id: 'ghost-artifact', artifact: 'Ghost', action: 'create' }])
    if (badCheck.length !== 1 || badCheck[0].code !== 'ARTIFACT_WITHOUT_EXECUTOR') {
      return `未知 create 产物应报 ARTIFACT_WITHOUT_EXECUTOR：${JSON.stringify(badCheck)}`
    }

    const dir = makeNodeGitProject({
      'AGENTS.md': '# AGENTS\n\n## 取舍\n\n```text\n- `license`: MIT\n```\n',
    }, { origin: 'https://github.com/acme/demo.git' })
    try {
      const f = await survey(dir)
      const unexec = findUnexecutableArtifacts(f.artifactPlan)
      if (unexec.length > 0) return `真实 survey artifactPlan 存在无执行者项：${JSON.stringify(unexec)}`
      const rev = await reviewProject(dir, { scopes: new Set(['artifacts']) })
      const artHits = rev.results.filter((r) => r.scope === 'artifacts')
      if (artHits.length === 0) return `reviewProject --scope=artifacts 未返回 artifacts 结果：${JSON.stringify(rev.results)}`
      const cli = await runNode('review.mjs', [dir, '--scope=artifacts', '--json'])
      if (cli.status !== 0 && cli.status !== 1) return `review.mjs --scope=artifacts 异常失败：${cli.status} ${cli.stderr}`
      const cliJson = JSON.parse(cli.stdout)
      if (!cliJson.results?.some((r) => r.scope === 'artifacts')) return `CLI --scope=artifacts 缺结果：${cli.stdout}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C4 / C7 / C10 回归：dev-explore 只读契约、critique-scope CLI 与 PRD/切片完整性', async () => {
    const exploreSkill = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'dev-explore', 'SKILL.md'), 'utf8')
    if (!/只读/.test(exploreSkill)) return 'dev-explore SKILL.md 缺少严格只读约束描述'

    const dir = makeNodeGitProject({
      'docs/prd/261118-issue7-demo-prd.md': [
        '---', 'kind: prd', 'status: active', 'task_id: t-c10', 'issue: 7', 'owner: lead',
        '---', '# 总控 PRD', '', '- [ ] C1: 登录入口正常', '- [ ] C2: 退出入口正常', '',
        '## 背景与非目标', '- 聚焦账号接口，非目标为第三方计费。',
        '## 目标与边界', '- 覆写与新增接口。',
        '## 方案', '- 分批拆两份 SPEC 实现。',
        '## 验证与回归范围', '- 运行单测校验返回码。',
      ].join('\n'),
      'docs/specs/261118-issue8-spec-a.md': [
        '---', 'kind: spec', 'status: draft', 'task_id: spec-a', 'issue: 8', 'owner: lead',
        'related_prd: ../prd/261118-issue7-demo-prd.md',
        '---', '# SPEC A', '', '- [ ] C1: 登录入口校验（`src/index.mjs` exit=0）', '',
        '## 门型与风险边界', '- **门型判定**：two-way',
        '## 非目标', '- 不改登出模块。',
        '## 方案', '- 在 `src/index.mjs` 导出登录辅助函数。',
        '## 影响范围与回滚', '- 回滚直接 `git revert HEAD` 并在 `test/ok.test.mjs` 验证。',
        '## 变更记录', '- 初稿（2026-11-18）。',
      ].join('\n'),
      'docs/specs/261118-issue9-spec-b.md': [
        '---', 'kind: spec', 'status: draft', 'task_id: spec-b', 'issue: 9', 'owner: lead',
        '---', '# SPEC B', '', '- [ ] C1: 验证函数行为（`src/index.mjs`）', '',
        '## 非目标', '- 不改登录模块。',
        '## 方案', '- 更新 `src/index.mjs`。',
        '## 变更记录', '- 初稿（2026-11-18）。',
      ].join('\n'),
    })
    try {
      const covBad = checkMasterPrdCoverage(dir)
      if (!covBad.some((e) => e.code === 'UNCOVERED_ACCEPTANCE_CRITERIA' && e.missing.includes('C2'))) {
        return `checkMasterPrdCoverage 未检出遗漏 C2：${JSON.stringify(covBad)}`
      }
      const orphanBad = checkOrphanSlices(dir)
      if (!orphanBad.some((e) => e.code === 'ORPHAN_SLICES_NO_MASTER_PRD')) {
        return `checkOrphanSlices 未检出无主切片：${JSON.stringify(orphanBad)}`
      }

      const relSpec = 'docs/specs/261118-issue8-spec-a.md'
      const scopeRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-scope', '--file', relSpec, '--reviewer', 'critic-1', '--json',
      ], { cwd: dir })
      if (scopeRes.status !== 0) return `critique-scope CLI 失败：status=${scopeRes.status} stderr=${scopeRes.stderr}`
      const scopeJson = JSON.parse(scopeRes.stdout)
      if (!scopeJson.currentSha || !scopeJson.prompt || scopeJson.file !== relSpec) {
        return `critique-scope JSON 字段不全：${scopeRes.stdout}`
      }
      const gitRevClaim = scopeJson.facts?.commands?.find((c) => c.cmd === 'git revert HEAD')
      if (gitRevClaim && gitRevClaim.ran !== false) {
        return `critique-scope 误执行了带副作用的 git revert 命令：${JSON.stringify(gitRevClaim)}`
      }

      const r1 = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', relSpec, '--reviewer', 'critic-1', '--round', '1', '--summary', 'round1 ok',
      ], { cwd: dir })
      if (r1.status !== 0) return `critique-pass Round 1 失败：${r1.stderr}`
      const specAbs = join(dir, relSpec)
      writeFileSync(specAbs, `${readFileSync(specAbs, 'utf8')}\n- 补充说明\n`, 'utf8')
      const r2Same = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', relSpec, '--reviewer', 'critic-1', '--round', '2',
      ], { cwd: dir })
      if (r2Same.status === 0 || !r2Same.stderr.includes('BLOCKED_CRITIQUE_SAME_REVIEWER')) {
        return `Round 2 同审未阻断：status=${r2Same.status} err=${r2Same.stderr}`
      }
      const r2Fresh = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-pass', '--file', relSpec, '--reviewer', 'critic-2', '--round', '2',
      ], { cwd: dir })
      if (r2Fresh.status !== 0) return `Round 2 独立审失败：${r2Fresh.stderr}`

      const mapRes = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', ['--json'], { cwd: dir })
      if (mapRes.status !== 0) return `repo-map 只读运行失败：${mapRes.stderr}`
      const st = gitSync(dir, ['status', '--short'])
      if (/^M /m.test(st.stdout)) return `repo-map 不应改动已跟踪文件：${st.stdout}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C5 回归：治理任务强求 PRD 与产物计划覆盖', async () => {
    const dir = makeNodeGitProject({}, { origin: 'https://github.com/acme/demo.git' })
    try {
      const tGov = triageTask({ summary: '将仓库进行规范化治理并接入套件与 CI', repoRoot: dir })
      if (tGov.caseType !== 4 || tGov.prdRequired !== true) {
        return `治理任务应为 Case 4 且 prdRequired=true：${JSON.stringify(tGov)}`
      }
      const tThreeFaces = triageTask({ summary: '调整 docs/TDD.md 架构文档、补齐 CI 检查流并修改 src/index.mjs 契约', repoRoot: dir })
      if (tThreeFaces.caseType !== 4) {
        return `跨三面无治理字眼输入应判 Case 4：${JSON.stringify(tThreeFaces)}`
      }
      const tNarrow = triageTask({ summary: '修复单个函数边界空值解析失败', repoRoot: dir })
      if (tNarrow.prdRequired !== false) return `窄范围修复不应误判 prdRequired=true：${JSON.stringify(tNarrow)}`

      mkdirSync(join(dir, 'docs', 'prd'), { recursive: true })
      writeFileSync(join(dir, 'docs/prd/261118-issue5-governance-prd.md'), [
        '---', 'kind: prd', 'status: active', 'task_id: gov-1', 'issue: 5', 'owner: lead', 'governance: true',
        '---', '# 项目治理 PRD', '',
        '- [ ] C1: 完成 `pre-backup` 仓外备份与 `git-baseline` 基线配置',
        '- [ ] C2: 完成 `kit-skills` 装配与 `agents-contract` 契约生成',
        '- [ ] C3: 完成 `docs-tdd` 架构文档与 `readme`、`license` 补齐',
        '',
        '## 背景与非目标', '- 治理项目基线，非目标为重写业务源码。',
        '## 验证与回归范围', '- 运行 `node scripts/review.mjs .` 校验全绿。',
      ].join('\n'), 'utf8')
      const facts = await survey(dir)
      const covMiss = checkGovernancePrdCoverage(dir, facts)
      if (!covMiss.checked || !covMiss.missing.some((m) => m.id === 'ci-check')) {
        return `漏写 ci-check 的治理 PRD 应报覆盖缺失：${JSON.stringify(covMiss)}`
      }
      const revMiss = await reviewProject(dir, { scopes: new Set(['docs']) })
      if (!revMiss.missing.some((r) => r.id === 'docs.governance-prd-coverage')) {
        return `review.mjs docs 切面未报 docs.governance-prd-coverage：${JSON.stringify(revMiss.missing)}`
      }

      mkdirSync(join(dir, 'docs', 'prd'), { recursive: true })
      writeFileSync(join(dir, 'docs/prd/261118-issue5-governance-prd.md'), [
        '---', 'kind: prd', 'status: active', 'task_id: gov-1', 'issue: 5', 'owner: lead', 'governance: true',
        '---', '# 项目治理 PRD', '',
        '- [ ] C1: 完成 `pre-backup` 仓外备份与 `git-baseline` 基线配置',
        '- [ ] C2: 完成 `kit-skills` 装配与 `agents-contract` 契约生成',
        '- [ ] C3: 完成 `docs-tdd` 架构文档与 `readme`、`license` 补齐',
        '- [ ] C4: 完成 `ci-check` 最小检查流配置',
        '',
        '## 背景与非目标', '- 治理项目基线，非目标为重写业务源码。',
        '## 验证与回归范围', '- 运行 `node scripts/review.mjs .` 校验全绿。',
      ].join('\n'), 'utf8')
      const covOk = checkGovernancePrdCoverage(dir, facts)
      if (!covOk.checked || covOk.missing.length !== 0) {
        return `补齐 ci-check 后治理 PRD 覆盖应通过：${JSON.stringify(covOk)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C6 回归：探索门禁、多任务波次、TDD 同步阻断与空 diff 审查门', async () => {
    const dir = makeNodeGitProject({
      'docs/TDD.md': validGovTdd(),
      'AGENTS.md': [
        '# AGENTS', '',
        '```yaml',
        'quick-test: node test/ok.test.mjs',
        'full-test: node test/ok.test.mjs',
        'smoke-verify: node test/ok.test.mjs',
        'merge-gate: node test/ok.test.mjs',
        'high-risk: AGENTS.md',
        'do-not-edit: docs/archive/',
        '```', '',
      ].join('\n'),
    })
    try {
      const roots = await resolveRepoRoots(dir)

      // 1) explored gate: needs-explore -> explore -> BLOCKED_NOT_EXPLORED -> pass
      const stExp = await handleStart({ task: 't-exp', slug: 'exp-gate', case: '2', implementer: 'dev-a' }, roots)
      if (stExp.exitCode !== 0) return `t-exp start 失败：${stExp.exitCode}`
      const clExp = await handleClaim({ task: 't-exp', agent: 'dev-a' }, roots)
      if (clExp.exitCode !== 0) return `t-exp claim 失败：${clExp.exitCode}`
      const nxNeedExp = await handleNext({ task: 't-exp', json: true }, roots)
      if (nxNeedExp.payload?.phase !== 'needs-explore') {
        return `未探索任务应路由到 needs-explore，实际：${JSON.stringify(nxNeedExp.payload)}`
      }
      const implExp = join(dir, '.worktrees', 'impl-t-exp')
      writeFileSync(join(implExp, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\nassert.equal(2, 2)\n', 'utf8')
      gitSync(implExp, ['commit', '-qam', 'test: update'])
      const vExp = await handleVerify({ task: 't-exp', mode: 'gate' }, roots)
      if (vExp.exitCode !== 0) return `t-exp verify 失败：${vExp.exitCode}`
      const mBlockedExp = await handleMerge({ task: 't-exp' }, roots)
      if (mBlockedExp.exitCode !== 4 || mBlockedExp.code !== 'BLOCKED_NOT_EXPLORED') {
        return `缺 explored 时 merge 未按 exit 4 BLOCKED_NOT_EXPLORED 阻断：${JSON.stringify(mBlockedExp)}`
      }
      const runEx = await handleExplore({ task: 't-exp', by: 'dev-a' }, roots)
      if (runEx.exitCode !== 0) return `handleExplore 失败：${runEx.exitCode}`
      const expLedger = readTaskLedger(dir, 't-exp')
      if (!hasExploredEvidence(expLedger)) return `explore 未写入有效 explored 证据：${JSON.stringify(expLedger?.explored)}`
      const nxAfterExp = await handleNext({ task: 't-exp', json: true }, roots)
      if (nxAfterExp.payload?.phase === 'needs-explore') return '记录 explored 后不应仍停留在 needs-explore'

      // Empty diff structural gate
      const emptyGate = assessStructuralGate({ reviewRoot: implExp, diff: { files: [], untracked: [], text: '' }, devProfile: {}, parity: {} })
      if (emptyGate.status !== 'nothing-to-review') return `空 diff 结构门应返回 nothing-to-review：${JSON.stringify(emptyGate)}`

      // 2) multi-task wave scheduling
      const dirMulti = makeNodeGitProject({ 'src/a.mjs': 'export const a = 1\n', 'src/b.mjs': 'export const b = 1\n' })
      try {
        const mRoots = await resolveRepoRoots(dirMulti)
        await handleStart({ task: 'w-a', slug: 'wa', case: '1', files: 'src/a.mjs', implementer: 'dev-a' }, mRoots)
        await handleStart({ task: 'w-b', slug: 'wb', case: '1', files: 'src/b.mjs', implementer: 'dev-a' }, mRoots)
        await handleStart({ task: 'w-c', slug: 'wc', case: '1', files: 'src/a.mjs', implementer: 'dev-a' }, mRoots)
        const mNext = await handleNext({ json: true }, mRoots)
        if (mNext.payload?.phase !== 'ambiguous' || !mNext.payload?.wavePlan?.waves?.length) {
          return `多任务 flow next 未返回 wavePlan：${JSON.stringify(mNext.payload)}`
        }
        const waves = mNext.payload.wavePlan.waves
        if (!waves[0].canParallel || waves[0].tasks.length !== 2 || waves.length < 2) {
          return `多任务波次切分不符合写域并行规则：${JSON.stringify(waves)}`
        }
      } finally { rmTree(dirMulti) }

      // 3) finalize BLOCKED_TDD_SYNC + --no-tdd override
      const dirTdd = makeNodeGitProject({
        'docs/TDD.md': validGovTdd(),
        'docs/todo/261118-issue6-mod-todo.md': [
          '---', 'kind: todo', 'status: active', 'task_id: t-tdd', 'issue: 6', 'owner: lead',
          '---', '# Todo', '', '- [x] C1: 新增功能模块并完成测试（`src/new-mod.mjs`）', '',
          '## 变更范围与做法', '- 新增 `src/new-mod.mjs` 导出函数。',
          '## 完成后的记录', '- 实证通过。',
        ].join('\n'),
      })
      try {
        const tRoots = await resolveRepoRoots(dirTdd)
        const sTdd = await handleStart({
          task: 't-tdd', slug: 'mod', case: '3', todo: 'docs/todo/261118-issue6-mod-todo.md', implementer: 'dev-a',
        }, tRoots)
        if (sTdd.exitCode !== 0) return `t-tdd start 失败：${sTdd.exitCode}`
        await seedExploredFor(dirTdd, 't-tdd')
        const implTdd = join(dirTdd, '.worktrees', 'impl-t-tdd')
        writeFileSync(join(implTdd, 'src/new-mod.mjs'), 'export function runNewMod() { return 42 }\n', 'utf8')
        gitSync(implTdd, ['add', '-A'])
        gitSync(implTdd, ['commit', '-qm', 'feat: add src/new-mod.mjs without tdd'])
        const finBlock = await handleFinalize({ task: 't-tdd', json: true }, tRoots)
        if (finBlock.exitCode !== 1) return `未同步 docs/TDD.md 时 finalize 应阻断返回 1：${JSON.stringify(finBlock)}`
        if (!existsSync(join(implTdd, 'docs/todo/261118-issue6-mod-todo.md'))) {
          return 'finalize 阻断后提前归档了 Todo 文档'
        }
        const finOverride = await handleFinalize({ task: 't-tdd', 'no-tdd': true }, tRoots)
        if (finOverride.exitCode !== 0) return `带 --no-tdd 重试 finalize 应放行：${finOverride.exitCode}`
      } finally { rmTree(dirTdd) }

      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C8 回归：同 slug 不同任务文档隔离与同任务跨日互链', async () => {
    const dir = makeNodeGitProject({
      'docs/specs/261117-issue10-auth-spec.md': [
        '---', 'kind: spec', 'status: approved', 'task_id: auth-10', 'issue: 10', 'owner: lead',
        '---', '# Auth 10 SPEC', '', '- [ ] C1: 登录令牌签发',
      ].join('\n'),
      'docs/todo/261118-issue11-auth-todo.md': [
        '---', 'kind: todo', 'status: active', 'task_id: auth-11', 'issue: 11', 'owner: lead',
        '---', '# Auth 11 Todo', '', '- [ ] C1: 令牌吊销清单',
      ].join('\n'),
      'docs/todo/261118-issue10-auth-todo.md': [
        '---', 'kind: todo', 'status: active', 'task_id: auth-10', 'issue: 10', 'owner: lead',
        '---', '# Auth 10 Todo', '', '- [ ] C1: 登录令牌签发落地',
      ].join('\n'),
    })
    try {
      const res = await syncDocsLifecycle(dir, {
        slugOrPath: 'docs/specs/261117-issue10-auth-spec.md',
        issue: 10,
      })
      const specFm = parseDocFrontmatter(readFileSync(join(dir, 'docs/specs/261117-issue10-auth-spec.md'), 'utf8'))
      const otherTodoFm = parseDocFrontmatter(readFileSync(join(dir, 'docs/todo/261118-issue11-auth-todo.md'), 'utf8'))
      if (otherTodoFm.data?.related_spec) {
        return `不同 Issue 同 slug 活跃 Todo 被错误混链：${JSON.stringify(otherTodoFm.data)}`
      }
      if (!String(specFm.data?.related_todo ?? '').includes('261118-issue10-auth-todo.md')) {
        return `同任务跨日文档未正确互链：${JSON.stringify(specFm.data)} updated=${JSON.stringify(res.updated)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C9 回归：自定义 TDD 模板声明与三项不可豁免核心校验', async () => {
    const dir = makeNodeGitProject({
      'docs/templates/tdd.md': [
        '---',
        'omit_sections:',
        '  - data',
        '  - api',
        '  - invariants',
        '  - flow',
        'required_sections:',
        '  - methodology',
        '---',
        '# Custom Paper TDD',
        '',
        '## methodology',
        '- 说明实验对比基准与复现步骤。',
        '',
      ].join('\n'),
    })
    try {
      const req = resolveDocRequirements(dir, 'tdd')
      if (!req.omit.has('invariants') || !req.sections.some((s) => s.id === 'methodology')) {
        return `resolveDocRequirements 未读取 docs/templates/tdd.md：${JSON.stringify({ omit: [...req.omit], sections: req.sections.map((s) => s.id) })}`
      }
      const facts = await collectTddFacts(dir)
      const scaffolded = buildPreFilledTdd(facts, { repoRoot: dir, projectName: 'paper-lab' })
      if (!scaffolded.includes('## methodology')) return `scaffolded TDD 未附加自定义 methodology 节：\n${scaffolded}`

      const customOkTdd = [
        '# Paper TDD', '',
        '## 1. 背景、定位与非目标',
        '- **核心定位**：验证算法原型准确率。',
        '- **明确不做**：不做生产集群调度。', '',
        '## 2. 系统架构与模块边界',
        '| 模块 | 职责 | 依赖方向 | 入口文件 |',
        '| --- | --- | --- | --- |',
        '| `src/` | 实验入口 | 无外部依赖 | `src/index.mjs` |', '',
        '## 3. methodology',
        '- **评估方法论**：采用固定随机种子比较基线指标与消融偏差。', '',
        '## 4. 构建与验证链路',
        '- 运行 `node test/ok.test.mjs` 验证回归结果。', '',
      ].join('\n')
      writeFileSync(join(dir, 'docs/TDD.md'), customOkTdd, 'utf8')
      const stOk = checkTddStructure(customOkTdd, { repoRoot: dir })
      const audOk = auditDoc({ repoRoot: dir, file: 'docs/TDD.md' })
      if (stOk.length > 0 || !audOk.ok) {
        return `合法自定义 TDD 未通过审计：st=${JSON.stringify(stOk)} aud=${JSON.stringify(audOk.errors)}`
      }

      writeFileSync(join(dir, 'docs/templates/tdd.md'), [
        '---',
        'omit_sections:',
        '  - background',
        '  - arch',
        '  - build',
        'required_sections:',
        '  - methodology',
        '---',
      ].join('\n'), 'utf8')
      const reqBad = resolveDocRequirements(dir, 'tdd')
      if (reqBad.omit.has('arch') || reqBad.omit.has('build') || !reqBad.sections.some((s) => s.id === 'arch')) {
        return `三大核心节被误允许从 TDD 声明豁免：${JSON.stringify({ omit: [...reqBad.omit], sections: reqBad.sections.map((s) => s.id) })}`
      }
      const bareTdd = '# Bare TDD\n\n## methodology\n- 仅有方法论描述。\n'
      writeFileSync(join(dir, 'docs/TDD.md'), bareTdd, 'utf8')
      const audBad = auditDoc({ repoRoot: dir, file: 'docs/TDD.md' })
      const errCodes = new Set(audBad.errors.map((e) => e.code))
      if (audBad.ok || !errCodes.has('MISSING_TDD_ARCH') || !errCodes.has('MISSING_TDD_BUILD')) {
        return `试图豁免三大不可豁免核心时未拦截：${JSON.stringify(audBad.errors)}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
