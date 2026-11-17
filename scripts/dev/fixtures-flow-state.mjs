/**
 * fixtures-flow-state.mjs —— 流程状态与防死锁（正反双向）：
 *   三正交策略 / evidence.json 防旁路 / flow next 与 submit 权责锁
 *   全 Worktree 隔离 / 分支冲突拦截 / 跨轮槽复用与 --reset-review-slot
 *   1:N 总控 PRD 保护 / 子 SPEC 归档互链 / OPEN PR 防重 / 试合回滚与 Squash 清理
 *   六锁防无限审查硬拦截（Round 4 历史停损 / 同 HEAD / 增量视野 / cross-file C1 / Pass 门禁）
 */


import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitCommitFast, gitInit, gitInitBare, gitSync, issueTokenFor, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

export function registerFlowStateCases(cases) {
  cases.push(['三正交策略、无 CI 低风险静态门禁、evidence.json 防旁路、flow next 与 submit 权责锁', async () => {
    const {
      determineWorkflowPolicy, evaluateNextState, readTaskLedger, resolveRepoRoots,
      runLowRiskDocStaticCheck,
    } = await import('../../kit/skills/lib/shared.mjs')
    const { handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')

    // 1. determineWorkflowPolicy 三档正反判定 + ownArchived 豁免
    const pLow = determineWorkflowPolicy({
      changedFiles: ['docs/guide.md', 'docs/archive/todo/261116-t.md'],
      ownArchived: ['docs/archive/todo/261116-t.md'],
      doNotEditGlobs: ['docs/archive/'],
      caseType: 3,
      hasCiWorkflow: false,
    })
    if (pLow.riskTier !== 'low' || pLow.independentReviewRequired !== false || pLow.staticDocCheckRequired !== true) {
      return `ownArchived 纯文档未判为 low+staticDocCheckRequired：${JSON.stringify(pLow)}`
    }
    const pLowWithCi = determineWorkflowPolicy({
      changedFiles: ['README.md'],
      caseType: 1,
      hasCiWorkflow: true,
    })
    if (pLowWithCi.riskTier !== 'low' || pLowWithCi.staticDocCheckRequired !== false) {
      return `有 CI 纯文档未免除 local staticDocCheckRequired：${JSON.stringify(pLowWithCi)}`
    }
    if (determineWorkflowPolicy({ changedFiles: ['config.json'], caseType: 1 }).riskTier === 'low') {
      return '非白名单扩展名 config.json 误判为 low'
    }
    for (const nonLow of ['AGENTS.md', 'docs/TDD.md', 'cfg.yml']) {
      const pNon = determineWorkflowPolicy({ changedFiles: [nonLow], caseType: 1 })
      if (pNon.riskTier === 'low') return `高敏感/结构文件 ${nonLow} 误判为 low`
    }
    if (determineWorkflowPolicy({ changedFiles: ['src/App.tsx'], caseType: 1 }).riskTier !== 'high') {
      return '视觉文件 src/App.tsx 未判为 high'
    }

    // 2. runLowRiskDocStaticCheck 正反双向（死链 / 明文凭据 / 合法围栏与 Mermaid）
    const fakeToken = `${'ghp'}_${'a'.repeat(36)}`
    const docDir = tmpProject({
      'docs/bad.md': `# Bad\n\n[dead](./nope.md)\n\ntoken=${fakeToken}\n`,
      'docs/good.md': '# Good\n\n```md\n[fenced](./nope.md)\n```\n\n```mermaid\nflowchart LR\n  A["ok"] --> B["done"]\n```\n',
    })
    try {
      const sBad = runLowRiskDocStaticCheck(docDir, ['docs/bad.md'])
      const sGood = runLowRiskDocStaticCheck(docDir, ['docs/good.md'])
      if (sBad.ok || sBad.errors.length < 2 || !sGood.ok) {
        return `runLowRiskDocStaticCheck 正反异常：bad=${JSON.stringify(sBad)}, good=${JSON.stringify(sGood)}`
      }
    } finally { rmTree(docDir) }
    return true
  }])

  cases.push(['quick-only 仓库 --target 局部旁路拦截与全量放行', async () => {
    const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const qOnlyDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# qonly\n\n```yaml\nquick-test: node -e "process.exit(0)" -- {target}\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\nhigh-risk: none\n```\n',
      'src/a.mjs': 'export const q = 1\n',
    })
    gitInit(qOnlyDir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      const roots = await resolveRepoRoots(qOnlyDir)
      await handleStart({ task: 'q1', case: '2', slug: 'q1' }, roots)
      const wtq = join(qOnlyDir, '.worktrees', 'impl-q1')
      writeFileSync(join(wtq, 'src/a.mjs'), 'export const q = 2\n')
      gitCommitFast(wtq, 'q2', { updateOnly: true })
      await handleVerify({ task: 'q1', tier: 'quick', target: 'src/a.mjs' }, roots)
      const qBypass = await handleSubmit({ task: 'q1' }, roots)
      if (qBypass.exitCode !== 3) {
        return `quick-only 仓库 --target 局部旁路未被拦截：exit=${qBypass.exitCode}`
      }
      await handleVerify({ task: 'q1', tier: 'quick' }, roots)
      const qOk = await handleSubmit({ task: 'q1' }, roots)
      if (qOk.exitCode !== 0) return `quick-only 仓库全量 quick 误拦：exit=${qOk.exitCode}`
      return true
    } finally { rmTree(qOnlyDir) }
  }])

  cases.push(['quick --target 旁路拦截、flow next ownerRole 与 submit 权责锁', async () => {
    const {
      evaluateNextState, readTaskLedger, resolveRepoRoots,
    } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleNext } = await import('../../kit/skills/dev-flow/scripts/flow-next.mjs')
    // 3. quick --target 旁路拦截 + flow next (idle/ambiguous/--probe-auth/ownerRole) + submit 权责锁
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': [
        '# probe-state', '',
        '```yaml',
        'quick-test: node -e "process.exit(0)" -- {target}',
        'full-test: exit 0',
        'merge-gate: exit 0',
        'high-risk: none',
        '```', '',
      ].join('\n'),
      'package.json': '{"name":"probe-state","version":"1.0.0","repository":"https://github.com/acme/c1.git"}\n',
      'README.md': '# probe-state\n',
      'src/app.mjs': 'export const a = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com', origin: 'https://github.com/acme/c1.git' })

    try {
      const roots = await resolveRepoRoots(dir)
      const nextIdle = (await handleNext({ json: true }, roots)).payload
      if (nextIdle.phase !== 'idle' || nextIdle.ownerRole !== 'coordinator') {
        return `idle next 异常：${JSON.stringify(nextIdle)}`
      }

      await handleStart({ task: 'c1-code', case: '2', slug: 'c1-code' }, roots)
      const wt1 = join(dir, '.worktrees', 'impl-c1-code')
      writeFileSync(join(wt1, 'src/app.mjs'), 'export const a = 2\n')
      gitCommitFast(wt1, 'feat: a=2', { updateOnly: true })

      const vPartial = await handleVerify({ task: 'c1-code', tier: 'quick', target: 'src/app.mjs' }, roots)
      if (vPartial.exitCode !== 0) return `quick --target 失败：${vPartial.exitCode}`

      const subBypass = await handleSubmit({ task: 'c1-code' }, roots)
      if (subBypass.exitCode !== 3) {
        return `quick --target 旁路未被 submit 拦截：exit=${subBypass.exitCode}`
      }

      const nextVerify = (await handleNext({ task: 'c1-code', json: true }, roots)).payload
      if (nextVerify.phase !== 'needs-verify' || nextVerify.ownerRole !== 'implementer') {
        return `verify 缺失时 next phase/ownerRole 错误：${JSON.stringify(nextVerify)}`
      }

      const vFull = await handleVerify({ task: 'c1-code', mode: 'full' }, roots)
      if (vFull.exitCode !== 0) return `full verify 失败：${vFull.exitCode}`

      const nextSub = (await handleNext({ task: 'c1-code', json: true }, roots)).payload
      if (nextSub.phase !== 'needs-submit' || nextSub.ownerRole !== 'implementer') {
        return `verify 通过后 next phase/ownerRole 错误：${JSON.stringify(nextSub)}`
      }

      const mockClient = {
        tier: 'gh-cli',
        async findOpenPrForBranch() { return { ok: true, prs: [] } },
        async createPr({ title }) { return { ok: true, number: 12, url: 'https://github.com/acme/c1/pull/12', title } },
        async postComment() { return { ok: true, id: 1, verifiedReadback: true } },
        async listComments() { return { ok: true, comments: [{ id: 1, body: '<!-- pf-state:{"taskId":"c1-code","action":"review","round":1,"verdict":"pass","headSha":"abc","reviewerId":"rev-x"} -->' }] } },
        async getPr() { return { ok: true, state: 'OPEN', merged: false } },
      }
      const bare = tmpProject({})
      gitInitBare(bare)
      const bareUrl = bare.replace(/\\/g, '/')
      try {
        gitSync(dir, ['config', `url.${bareUrl}.pushInsteadOf`, 'https://github.com/acme/c1.git'])
        const l1 = readTaskLedger(dir, 'c1-code')
        const { writeTaskLedger } = await import('../../kit/skills/lib/shared.mjs')
        writeTaskLedger(dir, { ...l1, implementerId: 'alice' })

        const badCoord = await handleSubmit({ task: 'c1-code', agent: 'coordinator-hydrogen', json: true, _ghProbe: { env: { trackB: { tier: 'gh-cli', login: 'alice' } }, client: mockClient } }, roots)
        const badOther = await handleSubmit({ task: 'c1-code', agent: 'bob', json: true, _ghProbe: { env: { trackB: { tier: 'gh-cli', login: 'bob' } }, client: mockClient } }, roots)
        if (badCoord.exitCode !== 3 || badOther.exitCode !== 3) {
          return `submit 权责守卫未拦截非实施者：coord=${badCoord.exitCode}, other=${badOther.exitCode}`
        }

        const okAlice = await handleSubmit({ task: 'c1-code', agent: 'alice', json: true, _ghProbe: { env: { trackB: { tier: 'gh-cli', login: 'alice' } }, client: mockClient } }, roots)
        if (okAlice.exitCode !== 0) return `原实施者 alice submit 被误拦：exit=${okAlice.exitCode}`
      } finally { rmTree(bare) }

      await handleStart({ task: 'c1-doc', case: '1', slug: 'c1-doc' }, roots)
      const nextAmb = (await handleNext({ json: true }, roots)).payload
      if (nextAmb.phase !== 'ambiguous' || nextAmb.ownerRole !== 'coordinator' || (nextAmb.candidates?.length ?? 0) < 2) {
        return `多任务 ambiguous next 异常：${JSON.stringify(nextAmb)}`
      }

      const hydRes = await handleNext({ task: 'c1-code', 'probe-auth': true, json: true, _ghClient: mockClient }, roots)
      if (!hydRes.payload.hydration?.rehydrated || readTaskLedger(dir, 'c1-code')?.rounds?.length === 0) {
        return `--probe-auth 未从远端 pf-state 水合轮次：${JSON.stringify(hydRes.payload)}`
      }

      const revPhase = evaluateNextState({
        activeTasks: [readTaskLedger(dir, 'c1-code')],
        selectedTask: { ...readTaskLedger(dir, 'c1-code'), status: 'submitted', lastSubmittedHead: 'abc', reviewPassed: false, rounds: [] },
        taskRuntime: { opInProgress: false, headSha: 'abc', dirty: 0, policy: { riskTier: 'medium', independentReviewRequired: true, requiredGates: ['full'] }, evidenceValidation: { ok: true } },
      })
      if (revPhase.phase !== 'needs-review' || revPhase.ownerRole !== 'reviewer') {
        return `needs-review ownerRole 异常：${JSON.stringify(revPhase)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['全 Worktree 隔离（commits>0 含 Case1）、分支冲突拦截、跨轮槽复用与 --reset-review-slot', async () => {
    // 1. 0 提交仓保持 Tier 1；有提交仓 Case 1 强制 Tier 2 .worktrees/impl-* 且 baseSha 来自默认分支
    const unborn = tmpProject({ 'README.md': '# u\n' })
    gitInit(unborn, { commit: false, branch: 'main' })
    const committed = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': '{"name":"c2-wt","version":"1.0.0"}\n',
      'package-lock.json': '{"lockfileVersion":3,"v":1}\n',
      'AGENTS.md': '# c2\n\n```yaml\nquick-test: exit 0\n```\n',
      'src/a.mjs': 'export const a = 1\n',
    })
    gitInit(committed, { branch: 'main', name: 't', email: 't@t.t' })
    mkdirSync(join(committed, 'node_modules/p'), { recursive: true })
    writeFileSync(join(committed, 'node_modules/p/i.js'), '1\n')

    try {
      const sUnborn = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'u-t', '--case', '1', '--slug', 'u', '--json'], { cwd: unborn })).stdout)
      if (sUnborn.isolation !== 'branch' || sUnborn.worktreePath !== null) {
        return `0 提交仓被误建 worktree：${JSON.stringify(sUnborn)}`
      }

      // 分支已在 mainRoot 检出 -> 拦截 BLOCKED_BRANCH_IN_USE (exit 3)
      const clash = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c2-bad', '--case', '1', '--branch', 'main'], { cwd: committed })
      if (clash.status !== 3 || !clash.stderr.includes('BLOCKED_BRANCH_IN_USE')) {
        return `已被占用分支未拦截：exit=${clash.status}, err=${clash.stderr}`
      }

      const mainSha = gitSync(committed, ['rev-parse', 'refs/heads/main'], { encoding: 'utf8' }).stdout.trim()
      const sCom = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'c2-wt', '--case', '1', '--slug', 'c2-wt', '--json'], { cwd: committed })).stdout)
      if (sCom.isolation !== 'worktree' || sCom.worktreePath !== '.worktrees/impl-c2-wt' || sCom.baseSha !== mainSha) {
        return `有提交仓 Case 1 未强制 Tier 2 或 baseSha 不对：${JSON.stringify(sCom)}`
      }

      const implAbs = join(committed, sCom.worktreePath)
      const revAbs = join(committed, sCom.reviewWorktreePath)
      writeFileSync(join(implAbs, 'src/a.mjs'), 'export const a = 2\n')
      gitCommitFast(implAbs, 'r1', { updateOnly: true })
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'c2-wt'], { cwd: implAbs })
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 'c2-wt'], { cwd: implAbs })
      if (!existsSync(join(revAbs, 'node_modules/p/i.js'))) return '首轮 review 槽未挂载共享依赖'

      // 弄脏审查位 + 修改锁文件 -> 不带 --reset-review-slot 正常失败（或保留），带 --reset-review-slot 自动解绑重建并清理脏文件
      writeFileSync(join(revAbs, 'src/a.mjs'), 'DIRTY\n')
      writeFileSync(join(revAbs, 'stray.tmp'), 'junk\n')
      writeFileSync(join(implAbs, 'package-lock.json'), '{"lockfileVersion":3,"v":2}\n')
      writeFileSync(join(implAbs, 'src/a.mjs'), 'export const a = 3\n')
      gitCommitFast(implAbs, 'r2', { updateOnly: true })
      await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 'c2-wt', '--mode', 'gate'], { cwd: implAbs })
      const subReset = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 'c2-wt', '--rework', '--reset-review-slot', '--json'], { cwd: implAbs })
      if (subReset.status !== 0) return `submit --reset-review-slot 失败：${subReset.stderr}`
      if (existsSync(join(revAbs, 'stray.tmp')) || existsSync(join(revAbs, 'node_modules')) || !readFileSync(join(revAbs, 'src/a.mjs'), 'utf8').includes('a = 3')) {
        return '--reset-review-slot 未清理脏审查位或锁变化未解除共享依赖'
      }
      return true
    } finally { rmTree(unborn); rmTree(committed) }
  }])

  cases.push(['1:N 总控 PRD 保护、子 SPEC 归档互链与 OPEN PR 防重', async () => {
    const { isSharedMasterPrd, readTaskLedger, resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
    const { handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      '.github/pull_request_template.md': '# PR\n\n## 改了什么\n\n## 关联 Issue\n\n## 为什么\n\n## 实现依据\n\n## 怎么验证的\n\n## 回滚点\n\n## 风险与影响范围\n\n## 合并授权\n\n## 独立审查与故障注入\n',
      'AGENTS.md': '# c3\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\n```\n',
      'src/app.mjs': 'export const v = 1\n',
      'docs/prd/261116-issue10-master-prd.md': '---\nkind: prd\ntitle: "Master"\nstatus: active\ncreated: 2026-11-16\nupdated: 2026-11-16\nissue: 10\npr: null\nowner: "t"\nrelated_spec: null\nrelated_todo: null\n---\n\n# PRD: Master\n\n## 要解决的问题\n- 统一一个可复用的组件库\n\n## 本期不做\n- 无\n\n## 门型与回滚路径\n- two-way；revert\n\n## 五、验收标准\n\n- [ ] C1: `src/app.mjs` M1\n- [ ] C2: `src/app.mjs` M2\n',
      'docs/specs/261116-issue11-m1-spec.md': '---\nkind: spec\ntitle: "M1"\nstatus: approved\ntier: L3\ncreated: 2026-11-16\nupdated: 2026-11-16\nissue: 11\npr: null\nbranch: null\nowner: "t"\napproved: true\nimplemented: false\nplan_critique: passed\nrelated_prd: ../prd/261116-issue10-master-prd.md\nrelated_todo: ../todo/261116-issue11-m1-todo.md\nhigh_risk_paths: []\n---\n\n# SPEC: M1\n\n## 要解决的问题\n- 拆出第一个切片\n\n## 关联\n- [Master](../prd/261116-issue10-master-prd.md)\n\n## 本期不做\n- 无\n\n## 门型与回滚路径\n- two-way；revert\n\n## 验收标准\n- [x] C1: `src/app.mjs` ok\n\n## 实现说明\n- 已完成实现。\n',
      'docs/todo/261116-issue11-m1-todo.md': '---\nkind: todo\ntitle: "M1"\nstatus: active\ncreated: 2026-11-16\nupdated: 2026-11-16\nissue: 11\npr: null\nbranch: null\nowner: "t"\napproved: true\ndone_at: null\ntask_id: m1\nplanned_at: HEAD\nrelated_prd: ../prd/261116-issue10-master-prd.md\nrelated_spec: ../specs/261116-issue11-m1-spec.md\n---\n\n# Todo: M1\n\n## 要解决的问题\n- 拆出第一个切片\n\n## 本期不做\n- 无\n\n## 门型与回滚路径\n- two-way；revert\n\n## 验收标准\n- [x] C1: `src/app.mjs` ok\n\n## 完成后的记录\n**在合并之前写完，随这次改动一起提交。**\n',
      'docs/specs/261116-issue12-m2-spec.md': '---\nkind: spec\ntitle: "M2"\nstatus: draft\ntier: L3\ncreated: 2026-11-16\nupdated: 2026-11-16\nissue: 12\npr: null\nbranch: null\nowner: "t"\napproved: false\nimplemented: false\nplan_critique: pending\nrelated_prd: ../prd/261116-issue10-master-prd.md\nrelated_todo: null\nhigh_risk_paths: []\n---\n\n# SPEC: M2\n\n## 要解决的问题\n- 拆出第二个切片\n\n## 本期不做\n- 无\n\n## 门型与回滚路径\n- two-way；revert\n\n## 验收标准\n- [ ] C1: `src/app.mjs` next\n- [ ] C2: 认领总控 PRD 的另一条\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com', origin: 'https://github.com/acme/c3.git' })

    const bare = tmpProject({})
    gitInitBare(bare)
    const bareUrl = bare.replace(/\\/g, '/')

    try {
      const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
      const { handleFinalize, handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
      const { auditDoc, auditRepoDocs } = await import('../../kit/skills/dev-plan/scripts/doc-plan.mjs')
      const roots = await resolveRepoRoots(dir)

      if (!isSharedMasterPrd(dir, 'docs/prd/261116-issue10-master-prd.md', 'docs/specs/261116-issue11-m1-spec.md')) {
        return '1:N 总控 PRD 未被 isSharedMasterPrd 识别'
      }

      await handleStart({ task: 'm1', case: '4', slug: 'm1', issue: '11', spec: 'docs/specs/261116-issue11-m1-spec.md' }, roots)
      const st = readTaskLedger(dir, 'm1')
      const wt = join(dir, st.worktreePath)
      const masterAfterStart = readFileSync(join(wt, 'docs/prd/261116-issue10-master-prd.md'), 'utf8')
      if (!/^issue:\s*10\b/m.test(masterAfterStart)) {
        return `1:N 总控 PRD 的 issue 被 start 覆盖写脏：\n${masterAfterStart}`
      }

      const fin = await handleFinalize({ task: 'm1' }, roots)
      if (fin.exitCode !== 0) return `1:N 子切片 finalize 被未勾总控 PRD 误拦：${fin.exitCode}`
      if (!existsSync(join(wt, 'docs/prd/261116-issue10-master-prd.md')) || !existsSync(join(wt, 'docs/archive/specs/261116-issue11-m1-spec.md'))) {
        return '1:N 总控 PRD 被提前归档或子 SPEC 未归档'
      }
      const aud = auditRepoDocs(wt, '.')
      if (!aud.ok) return `1:N 归档后互链断链：${JSON.stringify(aud)}`
      const audArch = auditDoc({ repoRoot: wt, file: 'docs/archive/specs/261116-issue11-m1-spec.md' })
      if (!audArch.ok) return `已归档子 SPEC 指向总控 PRD 互链断链：${JSON.stringify(audArch)}`

      // 返工幂等 finalize + 零脏文件 submit + findOpenPrForBranch 复用 OPEN PR
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 2\n')
      gitCommitFast(wt, 'feat: m1 v2')
      const finRework = await handleFinalize({ task: 'm1' }, roots)
      if (finRework.exitCode !== 0) return `返工重复 finalize 失败：${finRework.exitCode}`
      await handleVerify({ task: 'm1', mode: 'gate' }, roots)

      gitSync(dir, ['config', `url.${bareUrl}.pushInsteadOf`, 'https://github.com/acme/c3.git'])
      let createdCount = 0
      const reusedClient = {
        tier: 'gh-cli',
        async findOpenPrForBranch() { return { ok: true, prs: [{ number: 55, url: 'https://github.com/acme/c3/pull/55', state: 'OPEN' }] } },
        async createPr() { createdCount += 1; return { ok: true, number: 56 } },
        async postComment() { return { ok: true, id: 1, verifiedReadback: true } },
      }
      const subReuse = await handleSubmit({ task: 'm1', json: true, _ghProbe: { env: { trackB: { tier: 'gh-cli', login: 'alice' } }, client: reusedClient } }, roots)
      if (subReuse.exitCode !== 0 || createdCount !== 0 || readTaskLedger(dir, 'm1')?.prNumber !== 55) {
        return `OPEN PR 防重失败：code=${subReuse.exitCode}, created=${createdCount}, pr=${readTaskLedger(dir, 'm1')?.prNumber}`
      }
      if (gitSync(wt, ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim() !== '') {
        return 'submit 推送后 worktree 仍留脏跟踪文件'
      }
      return true
    } finally { rmTree(bare); rmTree(dir) }
  }])

  cases.push(['--detach 试合失败回滚与推进、Squash 清理与 1:1 归档正反', async () => {
    const { isSharedMasterPrd, readTaskLedger, resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleCleanup } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const { runTrialMerge } = await import('../../kit/skills/dev-flow/scripts/flow-trial-merge.mjs')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c3b\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\n```\n',
      'src/app.mjs': 'export const v = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com', origin: 'https://github.com/acme/c3.git' })

    try {
      const roots = await resolveRepoRoots(dir)
      await handleStart({ task: 'm1b', case: '1', slug: 'm1b', implementer: 'alice' }, roots)
      const wt = join(dir, readTaskLedger(dir, 'm1b').worktreePath)
      writeFileSync(join(wt, 'src/app.mjs'), 'export const v = 2\n')
      gitCommitFast(wt, 'feat: m1b v2', { updateOnly: true })
      await handleVerify({ task: 'm1b', mode: 'full' }, roots)
      await handleRecord({ task: 'm1b', round: '1', verdict: 'pass', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-a' }, roots)

      const mainBefore = gitSync(dir, ['rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim()
      const tmFail = await runTrialMerge({
        mainRoot: dir,
        ledger: readTaskLedger(dir, 'm1b'),
        baseBranch: 'main',
        profile: { fullTest: 'node -e "process.exit(1)"' },
        policy: { riskTier: 'medium', requiredGates: ['full'] },
        runVerify: true,
      })
      if (!tmFail.blocked || tmFail.code !== 'BLOCKED_TRIAL_MERGE_VERIFY_FAILED' || existsSync(join(dir, '.worktrees/.tmp-merge-m1b')) || gitSync(dir, ['rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim() !== mainBefore) {
        return `试合失败未阻断或残留临时 worktree：${JSON.stringify(tmFail)}`
      }

      const tmOk = await runTrialMerge({
        mainRoot: dir, ledger: readTaskLedger(dir, 'm1b'), baseBranch: 'main',
        profile: { fullTest: 'exit 0' }, policy: { riskTier: 'medium', requiredGates: ['full'] }, runVerify: true,
      })
      if (!tmOk.ok || gitSync(dir, ['rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim() === mainBefore) {
        return `试合通过未推进 main：${JSON.stringify(tmOk)}`
      }

      const mergedClient = {
        tier: 'gh-cli',
        async getPr() { return { ok: true, state: 'MERGED', merged: true } },
        async listOpenPrsByBase() { return { ok: true, prs: [] } },
      }
      const clRes = await handleCleanup({ task: 'm1b', confirm: true, json: true, _ghClient: mergedClient }, roots)
      const branchStillExists = gitSync(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${readTaskLedger(dir, 'm1b').branch}`]).status === 0
      if (clRes.exitCode !== 0 || branchStillExists) {
        return `MERGED/Squash 状态 cleanup 未删除本地分支：exit=${clRes.exitCode}, exists=${branchStillExists}`
      }

      const soloDir = tmpProject({ 'README.md': '# solo\n' })
      try {
        const sInit = JSON.parse((await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'all', '--slug', 'solo', '--title', 'Solo', '--json'], { cwd: soloDir })).stdout)
        const sp = sInit.files.find((f) => f.endsWith('-solo-spec.md'))
        const prd = sInit.files.find((f) => f.endsWith('-solo-prd.md'))
        if (isSharedMasterPrd(soloDir, prd, sp)) return '1:1 PRD 被误判为 1:N 总控 PRD'
      } finally { rmTree(soloDir) }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['六锁硬拦截（Round 4 历史停损/同 HEAD/增量视野/cross-file C1/Pass 门禁/--disposition）与统一模板', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c4\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/a.mjs': 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n',
      'src/b.mjs': 'b1\nb2\nb3\nb4\nb5\nb6\nb7\nb8\nb9\nb10\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    try {
      // 1. 统一模板链路：init --kind all -> 填充 -> audit 0 错（含 Todo 断点与遗留决策非尖括号默认）
      const initAll = JSON.parse((await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'all', '--slug', 'u-c5', '--title', 'Unified C5', '--json'], { cwd: dir })).stdout)
      for (const rel of initAll.files) {
        let t = readFileSync(join(dir, rel), 'utf8')
          .replace('<two-way | one-way>', 'two-way')
          .replace(/<[^>]+>/g, 'src/a.mjs')
          .replace('- [ ] C1: src/a.mjs', '- [x] C1: `src/a.mjs` verified')
          .replace('- [ ] C2: src/a.mjs', '- [x] C2: `src/b.mjs` verified')
          .replace('<!-- 一两段说清真实用户痛点与预期可观测收益 -->', '真实痛点。')
          .replace('<!-- 在合并之前补齐真实实现摘要与验证结果 -->', '- 已实现验证。')
        writeFileSync(join(dir, rel), t)
      }
      const audAll = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '.', '--json'], { cwd: dir })
      if (audAll.status !== 0) return `C5 统一模板填充后 audit 失败：${audAll.stdout} ${audAll.stderr}`

      // 2. 六锁与统计验证（含 parseDiffHunkRanges count=0 删除锚定与 --rebut 免死）
      const { parseDiffHunkRanges } = await import('../../kit/skills/dev-review/scripts/review-locks.mjs')
      const delRanges = parseDiffHunkRanges('diff --git a/src/del.mjs b/src/del.mjs\n--- a/src/del.mjs\n+++ b/src/del.mjs\n@@ -8,2 +7,0 @@\n-old1\n-old2\n', { contextPadding: 3 })
      const dRng = delRanges.get('src/del.mjs')?.[0]
      if (!dRng || dRng.start !== 4 || dRng.end !== 10) {
        return `parseDiffHunkRanges count=0 删除锚定区间异常：${JSON.stringify(dRng)}`
      }

      const { readTaskLedger, resolveRepoRoots: resRoots } = await import('../../kit/skills/lib/shared.mjs')
      const { handleStart: hStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
      const { handleVerify: hVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
      const { handleRecord: hRecord, handleOverride: hOverride } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
      const roots = await resRoots(dir)
      await hStart({ task: 'c4-lk', case: '2', slug: 'c4-lk' }, roots)
      const st = readTaskLedger(dir, 'c4-lk')
      const wt = join(dir, st.worktreePath)
      writeFileSync(join(wt, 'src/a.mjs'), 'x1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nx10\n')
      gitCommitFast(wt, 'r1', { updateOnly: true })
      await hVerify({ task: 'c4-lk' }, roots)

      const r1 = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 'c4-lk', '--round', '1', '--verdict', 'changes', '--reviewer-id', 'rev-1',
        '--review-token', await issueTokenFor(dir, 'c4-lk', 1),
        '--must-fix', 'C1: src/a.mjs:1 err1',
        '--disposition', 'c1:rebutted-wrong', '--disposition', 'c1:rebutted-wrong',
        '--pre-existing', 'old issue', '--pre-existing', 'old   issue', '--json', '--evidence', '夹具实测：命令已跑，输出符合预期'
      ], { cwd: dir })
      if (r1.status !== 0 || JSON.parse(r1.stdout).preExistingCount !== 1 || JSON.parse(r1.stdout).dispositionStats?.total !== 1) {
        return `R1 record 或去重统计失败：${r1.stdout} ${r1.stderr}`
      }

      // 同 HEAD 复审拒绝（exit 2）
      const sameHead = await hRecord({ task: 'c4-lk', round: '2', verdict: 'pass', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 2) }, roots)
      if (sameHead !== 2) return `同 HEAD 复审未被拦截：exit=${sameHead}`

      // 推进 HEAD 仅改 src/b.mjs:1，检验增量视野硬锁
      writeFileSync(join(wt, 'src/b.mjs'), 'b1_mod\nb2\nb3\nb4\nb5\nb6\nb7\nb8\nb9\nb10\n')
      gitCommitFast(wt, 'r2', { updateOnly: true })
      await hVerify({ task: 'c4-lk' }, roots)

      const outScope = await hRecord({ task: 'c4-lk', round: '2', verdict: 'changes', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 2), 'must-fix': ['C1: src/a.mjs:10 outside hunk'] }, roots)
      if (outScope !== 2) return `Round 2 未改旧文件新刺未被拦截：exit=${outScope}`

      const subjScope = await hRecord({ task: 'c4-lk', round: '2', verdict: 'changes', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 2), 'must-fix': ['C1: rename helper style nitpick'] }, roots)
      if (subjScope !== 2) return `Round 2 无文件路径主观挑刺未被拦截：exit=${subjScope}`

      const r2CrossC1 = await hRecord({ task: 'c4-lk', round: '2', verdict: 'changes', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 2), 'must-fix': ['C1: src/b.mjs:1 new diff bug'] }, roots)
      if (r2CrossC1 !== 0) return `不同文件同标 C1 误触发停损或遭拒：exit=${r2CrossC1}`

      const badDisp = await hRecord({ task: 'c4-lk', round: '3', verdict: 'pass', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 3), disposition: ['c1:bogus'] }, roots)
      if (badDisp !== 2) return `非法 --disposition 未阻断：exit=${badDisp}`

      // Round 3 触发停损 -> Round 4 pass 绕过未解锁停损必须 exit 4 -> override 后 pass 成功
      writeFileSync(join(wt, 'src/b.mjs'), 'b1_mod2\nb2\nb3\nb4\nb5\nb6\nb7\nb8\nb9\nb10\n')
      gitCommitFast(wt, 'r3', { updateOnly: true })
      await hVerify({ task: 'c4-lk' }, roots)
      const r3Stop = await hRecord({ task: 'c4-lk', round: '3', verdict: 'changes', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 3), 'must-fix': ['C1: src/b.mjs:1 new diff bug'] }, roots)
      if (r3Stop !== 4) return `R3 停损未触发：exit=${r3Stop}`

      writeFileSync(join(wt, 'src/b.mjs'), 'b1_mod3\nb2\nb3\nb4\nb5\nb6\nb7\nb8\nb9\nb10\n')
      gitCommitFast(wt, 'r4', { updateOnly: true })
      await hVerify({ task: 'c4-lk' }, roots)
      const r4Bypass = await hRecord({ task: 'c4-lk', round: '4', verdict: 'pass', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 4) }, roots)
      if (r4Bypass !== 4) return `Round 4 pass 竟绕过了未解锁的历史停损：exit=${r4Bypass}`

      await hOverride({ task: 'c4-lk', 'human-approved': true, reason: 'approved' }, roots)
      await hVerify({ task: 'c4-lk', cmd: 'node -e "process.exit(1)"' }, roots)
      const passBlocked = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 'c4-lk', '--round', '4', '--verdict', 'pass', '--reviewer-id', 'rev-1',
        '--review-token', await issueTokenFor(dir, 'c4-lk', 4), '--evidence', '夹具实测：命令已跑，输出符合预期'
      ], { cwd: dir })
      if (passBlocked.status !== 2 || !(passBlocked.stdout + passBlocked.stderr).includes('BLOCKED_PASS_WITH_OPEN_BLOCKERS')) {
        return `失败 verify 后虚假 pass 未被拦截：exit=${passBlocked.status}, out=${passBlocked.stdout}, err=${passBlocked.stderr}`
      }
      await hVerify({ task: 'c4-lk' }, roots)
      const passOk = await hRecord({ task: 'c4-lk', round: '4', verdict: 'pass', evidence: '夹具实测：判据已跑，输出符合预期', 'evidence': '夹具实测：命令已跑，输出符合预期', 'reviewer-id': 'rev-1', 'review-token': await issueTokenFor(dir, 'c4-lk', 4) }, roots)
      if (passOk !== 0) return `override+复绿后 Round 4 pass 失败：exit=${passOk}`

      return true
    } finally { rmTree(dir) }
  }])
}
