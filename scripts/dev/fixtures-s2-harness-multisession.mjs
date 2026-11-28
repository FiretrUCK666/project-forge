/**
 * fixtures-s2-harness-multisession.mjs —— Slice 2（C10..C19）八技能降熵去误杀、多会话零冲突与通用认知契约双向夹具。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateRepoMap } from '../../kit/skills/dev-explore/scripts/repo-map.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { inspectWorktrees } from '../../kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs'
import { auditDocs } from '../../kit/skills/dev-govern/scripts/govern-docs.mjs'
import { formatTextReport } from '../../kit/skills/dev-govern/scripts/govern-state.mjs'
import { auditTests } from '../../kit/skills/dev-govern/scripts/govern-tests.mjs'
import { buildIterationPlan } from '../../kit/skills/dev-iterate/scripts/iterate-plan.mjs'
import { initDoc } from '../../kit/skills/dev-plan/scripts/doc-plan-ops.mjs'
import {
  computeMainDriftIntersection, formatConcurrencyRadarLines, projectConcurrencyRadar,
} from '../../kit/skills/lib/concurrency-radar.mjs'
import { buildMergeComments, buildSubmitComments } from '../../kit/skills/lib/doc-comments.mjs'
import { buildDocFilename } from '../../kit/skills/lib/docs.mjs'
import { prefillFeatureMapFromRepoMap } from '../../kit/skills/lib/feature-map.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { enforceSlotBoundary } from '../../kit/skills/lib/harness-context.mjs'
import { createDefaultLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { BUILTIN_PROVIDER_IDS, getHostingProvider } from '../../kit/skills/lib/platform-registry.mjs'
import { hydratePrTemplateBody } from '../../kit/skills/lib/pr-template-hydrate.mjs'
import { parseAgentsProfile, parseDevProfile } from '../../kit/skills/lib/profile.mjs'
import { buildSessionOrientation } from '../../kit/skills/lib/session-orient.mjs'
import {
  HANDOFF_PROJECTION_MAX_BYTES,
  appendPreInitNote,
  consumePreInitNotes,
  matchTopicForContext,
  readAllActiveTopics,
  readPreInitState,
  readSessionState,
  resolveTopicFilePath,
  safeTopicFilename,
  trimHandoffProjectionBlocks,
} from '../../kit/skills/lib/session-state.mjs'
import {
  classifyDoorType,
  detectGateWeakeningInEntry,
  evaluateFileHygiene,
  isCallbackSpyTest,
  isTimeoutGuardSleep,
} from '../../kit/skills/lib/static-gates.mjs'
import { checkMechanicalSplitName } from '../../kit/skills/lib/static-gates-comment-hygiene.mjs'
import { resolveNativeTestDir } from '../../kit/skills/lib/suite-inventory.mjs'
import { createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { validateVerificationEvidence } from '../../kit/skills/lib/workflow-policy.mjs'
import {
  SKILL_ROOT, gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, tmpProject,
} from './fixtures-helpers.mjs'

export function registerS2HarnessMultisessionCases(cases) {
  cases.push(['[S2-C10/C11] 域聚类、scoped verificationTools、projectCodeFiles 计数、colocated 布局与 --focus 路径唯一', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test test/auth.test.mjs' } }),
      '.agents/skills/fake/a.mjs': 'export const a = 1\n',
      '.agents/skills/fake/b.mjs': 'export const b = 2\n',
      '.hidden-tool/x.mjs': 'export const x = 1\n',
      'src/auth/login.ts': 'export const login = () => true\n',
      'src/auth/login.spec.ts': 'import { login } from "./login"; export const t = login()\n',
      'src/auth/token.ts': 'export const token = () => true\n',
      'src/auth/token.spec.ts': 'import { token } from "./token"; export const t2 = token()\n',
      'src/billing/charge.ts': 'export const charge = () => true\n',
      'src/billing/charge.spec.ts': 'import { charge } from "./charge"; export const t3 = charge()\n',
      'src/billing/Button.stories.tsx': 'export default {}\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@s2.test' })
    try {
      const map = await generateRepoMap(dir)
      if (map.codeFileCount > 10) {
        return `微仓 codeFileCount 应排除 .agents/.hidden/stories，收到 ${map.codeFileCount}`
      }
      if ((map.features ?? []).some((f) => f.entrypoints?.some((p) => p.includes('stories') || p.includes('.agents')))) {
        return `features 不应包含 stories 或 .agents 路径：${JSON.stringify(map.features)}`
      }
      const prefilled = prefillFeatureMapFromRepoMap(dir, map)
      const fmFeatures = prefilled.featureMap?.features ?? []
      const billingFeat = fmFeatures.find((f) => String(f.id).includes('billing') || f.modules?.some((m) => m.includes('billing')))
      if (!billingFeat) return `未按域聚类生成 billing feature：${JSON.stringify(fmFeatures)}`
      if ((billingFeat.verificationTools ?? []).some((t) => String(t.command ?? '').includes('test/auth.test.mjs'))) {
        return `窄作用域 auth 测试命令不应盲绑定到 billing 模块：${JSON.stringify(billingFeat.verificationTools)}`
      }
      const layout = resolveNativeTestDir(dir, { files: ['src/auth/login.spec.ts', 'src/auth/token.spec.ts', 'src/billing/charge.spec.ts'] })
      if (layout.layout !== 'colocated' || layout.namingStyle !== 'spec') {
        return `同目录 *.spec.ts 应推导 colocated+spec：${JSON.stringify(layout)}`
      }

      // --focus 8 模块聚焦产出 8 条互异 plannedTestFile
      const focusDir = tmpProject({
        'package.json': JSON.stringify({ name: 'focus-demo', scripts: { test: 'node --test' } }),
        'src/m1/index.mjs': 'export const a1 = 1\n',
        'src/m2/index.mjs': 'export const a2 = 2\n',
        'src/m3/index.mjs': 'export const a3 = 3\n',
        'src/m4/index.mjs': 'export const a4 = 4\n',
        'src/m5/index.mjs': 'export const a5 = 5\n',
        'src/m6/index.mjs': 'export const a6 = 6\n',
        'src/m7/index.mjs': 'export const a7 = 7\n',
        'src/m8/index.mjs': 'export const a8 = 8\n',
      })
      gitInit(focusDir, { branch: 'main', name: 'dev', email: 'dev@s2.test' })
      try {
        const plan = await buildIterationPlan(focusDir, { focus: 'index', limit: 8 })
        const plannedPaths = (plan.candidates ?? []).map((g) => g.plannedTestFile).filter(Boolean)
        const uniquePaths = new Set(plannedPaths)
        if (plannedPaths.length < 8 || uniquePaths.size !== plannedPaths.length) {
          return `--focus 8 模块 plannedTestFile 未 100% 唯一：total=${plannedPaths.length}, unique=${uniquePaths.size}, paths=${JSON.stringify(plannedPaths)}`
        }
      } finally {
        rmTree(focusDir)
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[S2-C12] 11 项误杀清零、5 层 800 行棘轮保留 + isUntouchedOnMain + 可选 max-file-lines + 24KB 预算对齐', async () => {
    // 1. 业务缩写与合法文件名不误报
    if (checkMechanicalSplitName('src/billing-b2b.ts')) return 'billing-b2b.ts 被 checkMechanicalSplitName 误报'
    if (checkMechanicalSplitName('src/user-rest.ts')) return 'user-rest.ts 被 checkMechanicalSplitName 误报'
    if (checkMechanicalSplitName('src/text-overflow.css')) return 'text-overflow.css 被 checkMechanicalSplitName 误报'
    const mechPart = checkMechanicalSplitName('src/foo-part2.ts')
    if (!mechPart || mechPart.severity !== 'medium') return `foo-part2.ts 应产出 medium warning：${JSON.stringify(mechPart)}`

    // 2. JUSTIFICATION_ANCHOR_RE 双端一致 + 跨 hunk 不误拼死代码
    const anchoredFindings = detectGateWeakeningInEntry({ file: 'src/cli.mjs', status: 'M', added: ['// eslint-disable-next-line no-console -- pf-allow: CLI stdout contract'] })
    if (anchoredFindings.some((f) => f.type === 'error-suppression')) {
      return `带 pf-allow 锚点的压制注释被 detectGateWeakeningInEntry 误报：${JSON.stringify(anchoredFindings)}`
    }
    const unanchoredFindings = detectGateWeakeningInEntry({ file: 'src/cli.mjs', status: 'M', added: ['// eslint-disable-next-line no-console'] })
    if (!unanchoredFindings.some((f) => f.type === 'error-suppression')) {
      return '无锚点压制注释未被 detectGateWeakeningInEntry 拦截'
    }
    const splitHunkRes = evaluateFileHygiene({
      fileRel: 'src/demo.mjs',
      hunks: [
        { startLine: 10, addedLines: [{ line: 10, text: '// const a = 1;' }, { line: 11, text: '// return a;' }] },
        { startLine: 80, addedLines: [{ line: 80, text: '// const b = 2;' }, { line: 81, text: '// return b;' }] },
      ],
    })
    if ((splitHunkRes.deadCodeBlocks ?? []).length > 0) {
      return `跨 hunk 独立 2 行注释不应被误拼成 4 行死代码块：${JSON.stringify(splitHunkRes.deadCodeBlocks)}`
    }

    // 3. classifyDoorType 孤词不误升 one-way
    const benignDoor = classifyDoorType({ changedFiles: ['src/ui.mjs'], summary: 'release notes button label' })
    if (benignDoor.doorType === 'one-way') return `摘要孤词 release 不应误判 one-way：${JSON.stringify(benignDoor)}`

    // 4. Promise.race 超时保护 + vi.fn() 回调 spy 不误报，裸 sleep 仍拦截
    if (!isTimeoutGuardSleep(['await Promise.race([fetchData(), new Promise((_, r) => setTimeout(r, 2000))])'], 0)) {
      return 'Promise.race 超时保护未被识别'
    }
    if (isTimeoutGuardSleep(['await new Promise((r) => setTimeout(r, 2000))'], 0)) {
      return '裸 sleep 被误判为超时保护'
    }
    const spyTest = 'import { runHook } from "../src/hook.mjs"; test("cb", () => { const cb = vi.fn(); runHook(cb); expect(cb).toHaveBeenCalledTimes(1) })'
    if (!isCallbackSpyTest(spyTest)) return 'vi.fn() 回调 spy 未被识别'

    // 5. isUntouchedOnMain + 可选 max-file-lines + govern-docs 24KB 分层预算 + inspectWorktrees 排除自身
    const bigBody = Array.from({ length: 820 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
    const customLong = '# Custom\n' + 'x'.repeat(32000) + '\n'
    const dir = tmpProject({
      'AGENTS.md': [
        '# Demo',
        '<!-- project-forge: begin Dev Profile -->',
        '```yaml',
        'quick-test: exit 0',
        'full-test: exit 0',
        'smoke-verify: none',
        'merge-gate: exit 0',
        'arch-rules: none',
        'high-risk: none',
        'do-not-edit: docs/archive/',
        'max-file-lines: 900',
        '```',
        '<!-- project-forge: end Dev Profile -->',
        customLong,
      ].join('\n'),
      'src/legacy-big.mjs': bigBody,
      'src/billing-b2b.ts': 'export const b2b = 1\n',
      'tests/timer.test.mjs': 'import { describe, it } from "node:test"; it("t", async () => { await Promise.race([Promise.resolve(1), new Promise((_, r) => setTimeout(r, 2000))]) })\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@s2.test' })
    try {
      const prof = parseAgentsProfile(dir)
      const devProf = parseDevProfile(dir)
      if (prof.maxFileLines !== 900 || devProf['max-file-lines'] !== 900) {
        return `max-file-lines 解析错误：${JSON.stringify({ prof: prof.maxFileLines, devProf: devProf['max-file-lines'] })}`
      }
      const gateUntouched = await runEditGate({ dir, mode: 'standalone', files: ['src/legacy-big.mjs', 'src/billing-b2b.ts'] })
      if (!gateUntouched.ok) return `max-file-lines=900 与 billing-b2b.ts 不应阻断：${JSON.stringify(gateUntouched.blockers)}`

      // 切回默认 800 行测试 isUntouchedOnMain
      writeFileSync(join(dir, 'AGENTS.md'), [
        '# Demo',
        '<!-- project-forge: begin Dev Profile -->',
        '```yaml',
        'quick-test: exit 0',
        'full-test: exit 0',
        'smoke-verify: none',
        'merge-gate: exit 0',
        'arch-rules: none',
        'high-risk: none',
        'do-not-edit: docs/archive/',
        '```',
        '<!-- project-forge: end Dev Profile -->',
        customLong,
      ].join('\n'), 'utf8')
      gitCommitFast(dir, 'chore: default max-file-lines')
      const untouched800 = await runEditGate({ dir, mode: 'standalone', files: ['src/legacy-big.mjs'] })
      if (!untouched800.ok || !untouched800.warnings.some((w) => w.ruleId === 'edit.existing-oversized')) {
        return `isUntouchedOnMain 存量 >800L 跑 --files 应降级 edit.existing-oversized：${JSON.stringify({ ok: untouched800.ok, blockers: untouched800.blockers, warnings: untouched800.warnings })}`
      }
      // 反面：存量暴涨 > 80 行仍须硬阻断 edit.file-oversized-growth
      writeFileSync(join(dir, 'src/legacy-big.mjs'), bigBody + Array.from({ length: 95 }, (_, i) => `export const g${i} = ${i}`).join('\n') + '\n', 'utf8')
      const grown = await runEditGate({ dir, mode: 'standalone', files: ['src/legacy-big.mjs'] })
      if (grown.ok || !grown.blockers.some((b) => b.ruleId === 'edit.file-oversized-growth')) {
        return `存量 >800L 暴涨 >80 行未被 5 层棘轮阻断：${JSON.stringify(grown.blockers)}`
      }
      gitSync(dir, ['checkout', '--', 'src/legacy-big.mjs'])

      // govern-docs 24KB 分层预算：managed <= 24KB 但 custom > 30KB 降级为 info（非 critical）
      const docFindings = []
      const fileEntries = [
        { rel: 'AGENTS.md', name: 'AGENTS.md', full: join(dir, 'AGENTS.md') },
        { rel: 'src/legacy-big.mjs', name: 'legacy-big.mjs', full: join(dir, 'src/legacy-big.mjs') },
        { rel: 'tests/timer.test.mjs', name: 'timer.test.mjs', full: join(dir, 'tests/timer.test.mjs') },
      ]
      await auditDocs(dir, true, fileEntries, devProf, 'main', null, {}, docFindings)
      const overFinding = docFindings.find((f) => f.id === 'docs.agents-over-30kb')
      if (overFinding && overFinding.severity === 'critical') {
        return `managed <= 24KB 仅 custom 超 30KB 不应报 critical：${JSON.stringify(overFinding)}`
      }
      // govern-tests Promise.race 不误报硬等待
      const testFindings = []
      auditTests(dir, fileEntries, devProf, {}, testFindings)
      if (testFindings.some((f) => f.id === 'tests.hard-sleep')) {
        return `Promise.race 超时保护被 govern-tests 误报 hard-sleep：${JSON.stringify(testFindings)}`
      }
      // inspectWorktrees 排除当前 workRoot
      const wtRes = await inspectWorktrees(dir, true, 'main', { currentWorkRoot: dir })
      if ((wtRes.stale ?? []).some((s) => s.path === dir)) {
        return `inspectWorktrees 误将当前 workRoot 报为 stale：${JSON.stringify(wtRes.stale)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[S2-C13/C14] init --kind pair 幂等补建 SPEC、safeSlug 去重、full===gate 等价与 --finding 单复数合并', async () => {
    // 1. buildDocFilename 剥离尾部重复 -spec / -todo
    const fnSpec = buildDocFilename({ kind: 'spec', slug: 'auth-spec', dateTag: '261128' })
    const fnTodo = buildDocFilename({ kind: 'todo', slug: 'auth-todo', dateTag: '261128' })
    if (fnSpec.includes('-spec-spec.md') || fnTodo.includes('-todo-todo.md')) {
      return `buildDocFilename 产生双后缀：${fnSpec} / ${fnTodo}`
    }

    // 2. full-test === merge-gate 等价免重跑
    const evOk = validateVerificationEvidence({
      policy: { riskTier: 'medium', requiredGates: ['gate'], smokeRequired: false, staticDocCheckRequired: false },
      evidence: { headSha: 'abc1234', dirty: false, gates: { full: { exitCode: 0, ok: true, cmd: 'npm test', inner: false, headSha: 'abc1234' } } },
      headSha: 'abc1234',
      profile: { fullTest: 'npm test', mergeGate: 'npm  test' },
    })
    if (!evOk.ok) return `full-test === merge-gate 等价未放行：${JSON.stringify(evOk)}`
    const evDiff = validateVerificationEvidence({
      policy: { riskTier: 'medium', requiredGates: ['gate'], smokeRequired: false, staticDocCheckRequired: false },
      evidence: { headSha: 'abc1234', dirty: false, gates: { full: { exitCode: 0, ok: true, cmd: 'npm test', inner: false, headSha: 'abc1234' } } },
      headSha: 'abc1234',
      profile: { fullTest: 'npm test', mergeGate: 'npm run gate' },
    })
    if (evDiff.ok) return 'full-test !== merge-gate 不应等价放行'

    // 3. init --kind pair 幂等补建 SPEC 并双向互链 + critique-reject 单数 --finding 不被吞掉
    const dir = tmpProject({
      'AGENTS.md': '# PairDemo\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/a.mjs': 'export const a = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@s2.test' })
    try {
      const roots = await resolveRepoRoots(dir)
      const todo1 = await initDoc({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        kind: 'todo', slug: 'idem-slug', title: 'Idem Demo', owner: 'plan-1', inPlace: true,
      })
      const pair2 = await initDoc({
        repoRoot: dir, mainRoot: dir, gitDir: roots.gitDir, isGit: true,
        kind: 'pair', slug: 'idem-slug', title: 'Idem Demo', owner: 'plan-1', inPlace: true,
      })
      if (!pair2.reusedTodo || !pair2.file.endsWith('-spec.md')) {
        return `init --kind pair 未幂等复用已有 Todo 并补建 SPEC：${JSON.stringify(pair2)}`
      }
      const todoText = readFileSync(join(dir, todo1.file), 'utf8')
      const specText = readFileSync(join(dir, pair2.file), 'utf8')
      if (!todoText.includes('related_spec:') || !specText.includes('related_todo:')) {
        return 'init --kind pair 幂等补建后缺少双向互链 related_spec/related_todo'
      }

      // 单数 --finding 测试（critique-reject 约定退出码为 3 = CRITIQUE_REJECTED）
      const rej = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'critique-reject', '--file', pair2.file, '--reviewer', 'crit-s1', '--round', '1',
        '--finding', '[major] 缺核心边界条件', '--summary', '单数 finding 测试', '--json',
      ], { cwd: dir })
      if (![0, 3].includes(rej.status)) return `critique-reject 单数 --finding 执行失败：${rej.stderr} ${rej.stdout}`
      const rejOut = JSON.parse(rej.stdout)
      if (!(rejOut.findings ?? []).some((f) => String(f).includes('缺核心边界条件'))) {
        return `单数 --finding 被 multiFlags 吞掉：${JSON.stringify(rejOut)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[S2-C15/C16] Per-Topic 独立锁、deadEnds[]、>=6 并发主题零淘汰、并发雷达 5 退化边界与单源交接 <= 3072 B', async () => {
    // 1. safeTopicFilename 路径穿越、Windows 保留名、大小写碰撞、中文主题
    const fTrav = safeTopicFilename('../../etc/passwd')
    const fCon = safeTopicFilename('CON')
    const fUpper = safeTopicFilename('AuthFlow')
    const fLower = safeTopicFilename('authflow')
    const fCjk = safeTopicFilename('多会话并发治理')
    if (/[/\\:]|\.\./.test(fTrav) || /^con[-.]/i.test(fCon) || fUpper === fLower || !fCjk.endsWith('.json')) {
      return `safeTopicFilename 边界异常：${JSON.stringify({ fTrav, fCon, fUpper, fLower, fCjk })}`
    }

    // 2. >= 6 并发主题零淘汰 + deadEnds[] 持久化 + 无全局 activeTopic 单例 + 多主题省略 --topic 不误吸收
    const dir = tmpProject({
      'AGENTS.md': '# MultiSess\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/core.mjs': 'export const core = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@s2.test' })
    try {
      for (let i = 1; i <= 7; i += 1) {
        appendPreInitNote(dir, {
          topic: `topic-${i}`,
          fact: `k${i}=v${i}`,
          decision: `决策-${i}`,
          deadEnd: `死路-${i}：方案已证伪`,
        })
        if (!existsSync(resolveTopicFilePath(dir, `topic-${i}`))) {
          return `topic-${i} 未写入独立 Per-Topic 文件`
        }
      }
      const allActive = readAllActiveTopics(dir)
      if (allActive.length !== 7) return `7 个并发主题被淘汰为 ${allActive.length}`
      const rawSess = readSessionState(dir)
      if ('activeTopic' in rawSess) return 'session-state 仍残留全局单例 activeTopic'
      const t1 = readPreInitState(dir, { topic: 'topic-1' })
      if (!(t1?.deadEnds ?? []).some((d) => d.includes('死路-1'))) {
        return `deadEnds[] 未持久化：${JSON.stringify(t1)}`
      }
      // 多主题下省略 --topic 且无上下文匹配 -> 不误吸收
      const ambig = matchTopicForContext(rawSess.topics, {})
      if (!ambig.ambiguous || ambig.matched !== null) {
        return `多活跃主题省略 --topic 时不应猜测匹配：${JSON.stringify(ambig)}`
      }
      if (consumePreInitNotes(dir, {}) !== null) {
        return '多活跃主题无匹配上下文时 consumePreInitNotes 不应误消费'
      }

      // CLI doc-plan note --dead-end 实测
      const noteCli = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'note', '--topic', 'topic-1', '--dead-end', '禁止平行快照引擎', '--json',
      ], { cwd: dir })
      if (noteCli.status !== 0 || !noteCli.stdout.includes('禁止平行快照引擎')) {
        return `doc-plan note --dead-end 失败：${noteCli.stderr} ${noteCli.stdout}`
      }

      // 3. 并发雷达重叠预警 + 5 类退化边界（空目录/非Git、unborn HEAD、无远端、detached HEAD、Windows 大小写）
      mkdirSync(join(dir, '.worktrees', 'impl-sib-a'), { recursive: true })
      writeTaskLedger(dir, createDefaultLedger({
        taskId: 'sib-a', slug: 'sib-a', branch: 'feat/sib-a', worktreePath: '.worktrees/impl-sib-a',
        status: 'started', files: ['src/core.mjs'],
      }))
      const radarHit = projectConcurrencyRadar(dir, { currentTaskId: 'cur-b', currentFiles: ['src/core.mjs'] })
      if (!radarHit.hasOverlap || radarHit.warnings.length === 0) {
        return `兄弟任务写域重叠未触发并发雷达预警：${JSON.stringify(radarHit)}`
      }
      const radarDisjoint = projectConcurrencyRadar(dir, { currentTaskId: 'cur-b', currentFiles: ['src/other.mjs'] })
      if (radarDisjoint.hasOverlap || radarDisjoint.warnings.length !== 0) {
        return `不重叠写域应静默并行：${JSON.stringify(radarDisjoint)}`
      }
      const emptyNonGit = tmpProject({})
      const unbornRepo = tmpProject({ 'a.txt': 'hi\n' })
      gitSync(unbornRepo, ['init', '-b', 'main'])
      try {
        const rNonGit = projectConcurrencyRadar(emptyNonGit)
        const rUnborn = projectConcurrencyRadar(unbornRepo)
        const dUnborn = await computeMainDriftIntersection({ mainRoot: unbornRepo, baseBranch: 'main', baseSha: '0000000' })
        if (!rNonGit.ok || !rUnborn.ok || !rUnborn.unbornHead || dUnborn.drifted) {
          return `退化边界异常：${JSON.stringify({ rNonGit, rUnborn, dUnborn })}`
        }
      } finally {
        rmTree(emptyNonGit)
        rmTree(unbornRepo)
      }

      // 4. enforceSlotBoundary BLOCKED_DIRTY_MAIN 精准划分
      const isoWarn = enforceSlotBoundary({
        mainRoot: dir, implRoot: join(dir, '.worktrees', 'impl-new'),
        caseType: 3, isDirtyMain: true, commits: 1, creatingIsolatedWorktree: true,
      })
      if (!isoWarn.ok || isoWarn.dirtyMainWarning?.code !== 'WARN_DIRTY_MAIN_ISOLATED_WORKTREE') {
        return `新开隔离 worktree 脏主仓应降级预警：${JSON.stringify(isoWarn)}`
      }
      const inPlaceBlock = enforceSlotBoundary({
        mainRoot: dir, implRoot: dir, caseType: 3, isDirtyMain: true, commits: 1, creatingIsolatedWorktree: false,
      })
      if (inPlaceBlock.ok || inPlaceBlock.code !== 'BLOCKED_DIRTY_MAIN') {
        return `原地脏主仓仍须硬阻断 BLOCKED_DIRTY_MAIN：${JSON.stringify(inPlaceBlock)}`
      }

      // 5. session-orient 渲染 deadEnds + concurrencyRadar；handoff-package 含 skillPath + Day-1 + <= 3072 B 守卫
      const orient = buildSessionOrientation(dir)
      if (!orient.text.includes('已证伪死路') || !orient.text.includes('兄弟会话并发雷达')) {
        return `session-orient 缺少 deadEnds 或并发雷达渲染：\n${orient.text}`
      }
      const handoff = buildHandoff({
        mainRoot: dir,
        ledger: createDefaultLedger({ taskId: 'topic-1', slug: 'topic-1', branch: 'feat/topic-1', status: 'started' }),
        ownerRole: 'implementer',
      })
      if (!handoff.fields.skillPath?.includes('dev-edit/SKILL.md') || !handoff.prompt.includes('Deletion Test')) {
        return `handoff-package 缺少 skillPath 或 Day-1 Deletion Test 指令：\n${handoff.prompt}`
      }
      const trimmed = trimHandoffProjectionBlocks({
        skillLines: ['- 必读技能：`.agents/skills/dev-edit/SKILL.md`', '- Day-1 Deletion Test'],
        decisions: Array.from({ length: 40 }, (_, i) => `决策 ${i}: ${'x'.repeat(120)}`),
        deadEnds: Array.from({ length: 20 }, (_, i) => `死路 ${i}: ${'y'.repeat(120)}`),
        radarLines: formatConcurrencyRadarLines(radarHit),
      })
      if (trimmed.bytes > HANDOFF_PROJECTION_MAX_BYTES || !trimmed.text.includes('dev-edit/SKILL.md')) {
        return `交接块裁剪超 3072B 或丢失高优 skillPath：bytes=${trimmed.bytes}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['[S2-C17/C18/C19] 5 远端 prRefPrefix、零 PR #null、零私货 PR 模板、local-only 零泄露与零 webfetch/websearch', async () => {
    // 1. 5 大 Provider prRefPrefix
    for (const pid of BUILTIN_PROVIDER_IDS) {
      const p = getHostingProvider(pid)
      const want = pid === 'gitlab' ? '!' : '#'
      if (p?.prRefPrefix !== want) return `Provider ${pid} prRefPrefix 应为 ${want}，收到 ${p?.prRefPrefix}`
    }
    const glBackend = createTaskBackend({ role: 'maintainer', providerId: 'gitlab', targetRepo: 'grp/app' })
    if (glBackend.prRefPrefix !== '!') return `GitLab TaskBackend prRefPrefix 应为 !，收到 ${glBackend.prRefPrefix}`

    // 2. buildMergeComments 零 PR #null + 方言前缀 + 单次裸 prUrl
    const localMerge = buildMergeComments({ prNumber: null, branch: 'feat/local-x', baseBranch: 'main' })
    if (localMerge.prCommentBody.includes('#null') || localMerge.issueCommentBody.includes('#null')) {
      return `buildMergeComments 出现 #null：\n${localMerge.prCommentBody}\n${localMerge.issueCommentBody}`
    }
    const glMerge = buildMergeComments({ prNumber: 19, prRefPrefix: '!', branch: 'feat/gl', baseBranch: 'main' })
    if (!glMerge.issueCommentBody.includes('!19')) return `buildMergeComments 未用方言前缀 !：\n${glMerge.issueCommentBody}`
    const urlSubmit = buildSubmitComments({
      isRework: false, isHeadUpdate: false, round: 1, shortHead: 'abc1234',
      branch: 'feat/u', verifiedCmd: 'exit 0', prNumber: 55, prUrl: 'https://gitlab.com/g/p/-/merge_requests/55', prRefPrefix: '!',
      linkedIssues: [1],
    })
    const issBody = urlSubmit.issueCommentBodyFor(1)
    if ((issBody.match(/https:\/\/gitlab\.com\/g\/p\/-\/merge_requests\/55/g) ?? []).length !== 1 || /^###[^\n]*[!#]55/m.test(issBody)) {
      return `prUrl 未单次裸展开或标题重复 #N：\n${issBody}`
    }

    // 3. pr-template-hydrate 零 project-forge 私货
    const hydrateSrc = readFileSync(join(SKILL_ROOT, 'kit/skills/lib/pr-template-hydrate.mjs'), 'utf8')
    if (hydrateSrc.includes('SURVEY_OR_GATE_FILE_RE') || hydrateSrc.includes('勘察/门禁判定')) {
      return 'pr-template-hydrate.mjs 仍残留 project-forge 专有自查私货'
    }
    const prDir = tmpProject({
      '.github/pull_request_template.md': '## 变更摘要\n\n## 自查\n- [ ] 本地测试通过\n- [ ] 相关文档已更新\n',
      'docs/guide.md': '# Guide\n',
    })
    try {
      const rendered = hydratePrTemplateBody({
        repoRoot: prDir, taskId: 't1',
        ledger: { taskId: 't1', branch: 'feat/t1', caseType: 3, lastVerifyExitCode: 0, verifiedHead: 'aaa', finalized: true },
        currentHead: 'aaa', changedFiles: ['docs/guide.md'],
      })
      if (!rendered.includes('- [x] 本地测试通过') || !rendered.includes('- [x] 相关文档已更新')) {
        return `通用 PR 模板自查未基于事实正确勾选：\n${rendered}`
      }
    } finally {
      rmTree(prDir)
    }

    // 4. local-only 下 session-orient 与 govern-state 零远端 PR / gh CLI 泄露
    const locDir = tmpProject({
      'AGENTS.md': '# Local\nuses dev-review review-pack\n',
      'src/a.mjs': 'export const a = 1\n',
    })
    gitInit(locDir, { branch: 'main', name: 'dev', email: 'dev@s2.test' })
    try {
      const orient = buildSessionOrientation(locDir)
      if (/拿到 PR 号|去远端看/.test(orient.text)) {
        return `local-only 下 session-orient 泄露远端 PR 指引：\n${orient.text}`
      }
      const govTxt = formatTextReport({
        mode: 'issues', repoRoot: locDir, mainRoot: locDir, scope: '.', categories: ['hygiene'],
        counts: { critical: 0, high: 0, medium: 1, low: 0, info: 0 }, findings: [],
        issues: [{ title: 'Fix debt', labels: ['tech-debt'] }], nextSteps: [],
      })
      if (govTxt.includes('gh issue create')) {
        return `local-only 下 govern-state 泄露 gh CLI 指引：\n${govTxt}`
      }
    } finally {
      rmTree(locDir)
    }

    // 5. 产品层 0 命中 webfetch / websearch 且保留 mcp-delegate
    const productDocs = [
      'SKILL.md',
      'templates/agents-project.md',
      'references/survey.md',
      'references/collaboration.md',
      'kit/skills/dev-plan/SKILL.md',
      'kit/skills/dev-flow/SKILL.md',
      'kit/skills/dev-explore/SKILL.md',
      'kit/skills/dev-edit/SKILL.md',
      'kit/skills/dev-review/SKILL.md',
    ]
    for (const rel of productDocs) {
      const txt = readFileSync(join(SKILL_ROOT, rel), 'utf8')
      if (/\b(?:webfetch|websearch)\b/i.test(txt)) {
        return `产品层 ${rel} 仍残留特定宿主工具名 webfetch/websearch`
      }
    }
    const collabTxt = readFileSync(join(SKILL_ROOT, 'references/collaboration.md'), 'utf8')
    if (!collabTxt.includes('mcp-delegate')) return '运行态协议枚举 mcp-delegate 被误删'
    if (!readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8').includes('hostCapability: serial-fallback')) {
      return 'SKILL.md 缺少无子代理串行降级声明 hostCapability: serial-fallback'
    }
    return true
  }])
}
