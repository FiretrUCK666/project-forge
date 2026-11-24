/**
 * fixtures-plan-wave-slices.mjs —— 总控 PRD 切片有向图与波次交接包的正反双向夹具。
 *
 * 自动被 `scripts/dev/fixtures.mjs` 发现（域 `plan-wave-slices`）。
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  analyzePendingDecisions, deriveDefaultPlanMode, PLAN_MODES, planModeErrors, resolveDocPlanMode,
} from '../../kit/skills/lib/pending-decisions.mjs'
import {
  evaluatePlanExitGate, formatPlanExitGate, PLAN_BOOTSTRAP_FLAG, resolveCritiqueReadiness,
} from '../../kit/skills/lib/plan-exit-gate.mjs'
import { critiqueTextFingerprint } from '../../kit/skills/lib/critique-rounds.mjs'
import {
  buildSliceGraph, compileScopePattern, DERIVED_MANIFEST_PATHS, evaluateSliceGraph, extractMasterCriteria, scopesOverlap,
} from '../../kit/skills/lib/doc-slice-graph.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/shared.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleBatch } from '../../kit/skills/dev-flow/scripts/flow-batch.mjs'
import { gitCommitFast, gitSync, rmTree } from './fixtures-helpers.mjs'
import { PLAN_AGENTS, makeDoc, makeMaster, makeSpec, makeWaveRepo } from './fixtures-plan-wave-helpers.mjs'

export function registerPlanWaveSliceCases(cases) {
  cases.push(['切片图四检：认领覆盖、元数据必填、依赖判环与同波次写域碰撞各自报对，且不误伤已完成切片', async () => {
    // 正向 1：全覆盖 + 元数据齐全 + 无环 + 写域不撞 => 零错
    const good = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['kit/a/**'], deps: ['wave0'], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, scope: ['kit/b/**'], deps: ['wave0'], criteria: ['C2'] }) },
        // wave0 已完成：它既是依赖的合法目标，也不该被同波次碰撞检查拉进来
        { file: 'docs/archive/specs/261120-issue9-wave0-spec.md', text: makeSpec({ taskId: 'wave0', issue: 9, status: 'implemented', scope: ['docs/TDD.md'], criteria: ['C1'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(good)
      if (!r.ok) return `合规切片图被误判：${JSON.stringify(r.errors.map((e) => e.code))}`

      // 反向 1：总控 C3 没人认领
      writeFileSync(join(good, 'docs/prd/261120-master-prd.md'), makeMaster({ criteria: ['C1', 'C2', 'C3'] }), 'utf8')
      const uncovered = evaluateSliceGraph(good)
      const hit = uncovered.errors.find((e) => e.code === 'UNCOVERED_ACCEPTANCE_CRITERIA')
      if (!hit || !hit.missing.includes('C3')) return `漏认领的 C3 没被报出来：${JSON.stringify(uncovered.errors)}`
      writeFileSync(join(good, 'docs/prd/261120-master-prd.md'), makeMaster({ criteria: ['C1', 'C2'] }), 'utf8')

      // 反向 2：缺 scope_files / depends_on
      writeFileSync(join(good, 'docs/specs/261120-issue3-c-spec.md'), makeDoc({
        kind: 'spec',
        title: 'S-slice-c',
        status: 'approved',
        extra: ['tier: L3', 'issue: 3', 'owner: p', 'approved: true', 'plan_critique: passed', 'related_prd: ../prd/261120-master-prd.md', 'task_id: slice-c'],
        body: ['## 验收标准', '- [x] C1: 已完成'],
      }), 'utf8')
      const meta = evaluateSliceGraph(good)
      const metaHit = meta.errors.find((e) => e.code === 'SLICE_METADATA_MISSING' && e.file.includes('issue3'))
      if (!metaHit || !metaHit.missing.includes('scope_files') || !metaHit.missing.includes('depends_on')) {
        return `缺失的元数据没被报全：${JSON.stringify(meta.errors.map((e) => [e.code, e.missing]))}`
      }

      // 反向 3：显式 depends_on: [] 是合法答案，不该被当成「没写」
      writeFileSync(join(good, 'docs/specs/261120-issue3-c-spec.md'), makeSpec({ taskId: 'slice-c', issue: 3, scope: ['kit/c/**'], deps: [], criteria: ['C1'] }), 'utf8')
      const emptyOk = evaluateSliceGraph(good)
      if (!emptyOk.ok) return `显式空 depends_on 被误判成缺失：${JSON.stringify(emptyOk.errors.map((e) => e.code))}`
    } finally { rmTree(good) }

    // 反向 4：环依赖
    const cyc = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['kit/a/**'], deps: ['slice-b'], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, scope: ['kit/b/**'], deps: ['slice-a'], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(cyc)
      const hit = r.errors.find((e) => e.code === 'BLOCKED_SLICE_CYCLE' && !e.dangling)
      if (!hit) return `环依赖没被报出来：${JSON.stringify(r.errors.map((e) => e.code))}`
    } finally { rmTree(cyc) }

    // 反向 5：悬空依赖（指向一个谁也没声明过的 task_id）
    const dangling = makeWaveRepo({
      master: makeMaster({ criteria: ['C1'] }),
      specs: [{ file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['kit/a/**'], deps: ['nobody'], criteria: ['C1'] }) }],
    })
    try {
      const r = evaluateSliceGraph(dangling)
      const hit = r.errors.find((e) => e.code === 'BLOCKED_SLICE_CYCLE' && e.dangling)
      if (!hit || !hit.message.includes('nobody')) return `悬空依赖没被指出：${JSON.stringify(r.errors)}`
    } finally { rmTree(dangling) }

    // 反向 6：同波次写域碰撞（含目录前缀与 glob 两种形状）
    const collide = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['"kit/shared/**"'], deps: [], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, scope: ['kit/shared/deep/file.mjs'], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(collide)
      const hit = r.warnings.find((e) => e.code === 'SLICE_SERIAL_BY_OVERLAP' && e.serialReason === 'serial-by-overlap')
      if (!hit) return `同波次写域重叠未标记为 serial-by-overlap：${JSON.stringify(r.warnings?.map((e) => e.code))}`
      if (r.errors.some((e) => e.code === 'BLOCKED_SLICE_OVERLAP')) return '写域重叠不应再产生 BLOCKED_SLICE_OVERLAP 阻断'
      if (!hit.message.includes('kit/shared')) return `串行提示没有指出具体路径：${hit.message}`
    } finally { rmTree(collide) }

    // 反向 7：派生清单不算碰撞——它由脚本重新生成，谁「改了它」没有意义
    const manifest = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: [DERIVED_MANIFEST_PATHS[0]], deps: [], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, scope: [DERIVED_MANIFEST_PATHS[0]], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(manifest)
      if (r.warnings.some((e) => e.code === 'SLICE_SERIAL_BY_OVERLAP') || r.errors.some((e) => e.code === 'BLOCKED_SLICE_OVERLAP')) {
        return '确定性派生清单被当成了写域碰撞'
      }
    } finally { rmTree(manifest) }

    // 反向 8：两个都还没做完的活跃切片写同一份文件 -> 标记 serial-by-overlap 串行化（不阻断）
    const activeCollide = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['AGENTS.md'], deps: [], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, scope: ['AGENTS.md'], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(activeCollide)
      const hit = r.warnings.find((e) => e.code === 'SLICE_SERIAL_BY_OVERLAP' && e.serialReason === 'serial-by-overlap')
      if (!hit) return `两个活跃切片写同一份文件未标记 serial-by-overlap：${JSON.stringify(r.warnings?.map((e) => e.code))}`
      if (!hit.message.includes('AGENTS.md')) return `活跃切片重叠没有指出具体路径：${hit.message}`
    } finally { rmTree(activeCollide) }

    // 正向 4：两个都已完成（implemented）的切片写同一份文件 -> 不报。
    const doneCollide = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, status: 'implemented', scope: ['AGENTS.md'], deps: [], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, status: 'implemented', scope: ['AGENTS.md'], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(doneCollide)
      const hit = r.warnings.find((e) => e.code === 'SLICE_SERIAL_BY_OVERLAP')
      if (hit) return `已完成的切片之间被误报成同波次碰撞：${hit.message}`
      const g = buildSliceGraph(doneCollide)
      const inMaster = g.slices.filter((s) => s.kind === 'spec' && s.masterRel === 'docs/prd/261120-master-prd.md')
      if (inMaster.length !== 2) return `正例前提不成立：归属同一总控的切片数为 ${inMaster.length}，应为 2`
      if (!inMaster.every((s) => s.done)) return '正例前提不成立：这两片并未被判定为已完成'
    } finally { rmTree(doneCollide) }

    // 正向 5：活跃切片依赖一个已完成的切片、两者写同一份文件 -> 也不报。
    const mixedDep = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-new-spec.md', text: makeSpec({ taskId: 'new-slice', issue: 1, scope: ['AGENTS.md'], deps: ['old-slice'], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-old-spec.md', text: makeSpec({ taskId: 'old-slice', issue: 2, status: 'implemented', scope: ['AGENTS.md'], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(mixedDep)
      const hit = r.warnings.find((e) => e.code === 'SLICE_SERIAL_BY_OVERLAP')
      if (hit) return `依赖已完成切片时被误报成同波次碰撞：${hit.message}`
      if (r.errors.some((e) => e.code === 'BLOCKED_SLICE_CYCLE')) {
        return `依赖已完成切片被误判成环或悬空：${JSON.stringify(r.errors.map((e) => e.code))}`
      }
    } finally { rmTree(mixedDep) }
    return true
  }])

  cases.push(['切片图边界：单切片仓与无多切片总控的仓一律零错，glob 匹配按保守口径判', async () => {
    // 正向 1：一份 SPEC、没有总控 PRD —— 自己就是完整单位，不该要求 scope_files
    const single = makeWaveRepo({
      specs: [{ file: 'docs/specs/261120-issue1-only-spec.md', text: makeDoc({ kind: 'spec', title: 'S', status: 'approved', extra: ['tier: L3', 'issue: 1', 'owner: p', 'approved: true', 'plan_critique: passed'], body: ['## 验收标准', '- [x] C1: x'] }) }],
    })
    try {
      const r = evaluateSliceGraph(single)
      if (!r.ok) return `单切片仓被误判：${JSON.stringify(r.errors.map((e) => e.code))}`
    } finally { rmTree(single) }

    // 正向 2：总控里的 C 编号必须按条目形状抽，正文里提到 C1 不算
    const ids = extractMasterCriteria('## 五、验收标准\n- [ ] C1: a\n- [x] C2: b\n\n> 这段提到 C9 但不是条目\n')
    if (JSON.stringify(ids) !== JSON.stringify(['C1', 'C2'])) return `总控编号抽取误抓：${JSON.stringify(ids)}`

    // 正向 3：路径匹配的保守口径——同前缀必重叠，不同前缀不重叠
    const mk = (raw) => compileScopePattern(raw)
    if (!scopesOverlap(mk('a/**'), mk('a/b'))) return '同前缀子树被误判为不重叠'
    if (scopesOverlap(mk('a/**'), mk('b/**'))) return '不同前缀被误判为重叠'
    if (!scopesOverlap(mk('a/*.mjs'), mk('a/x.mjs'))) return '同层 glob 与具体文件应判为可能重叠'
    if (scopesOverlap(mk('a/*.mjs'), mk('a/deep/x.mjs'))) return '单星号被当成了跨层匹配'
    return true
  }])

  cases.push(['flow batch plan --handoff 为就绪波次切片配交接包，保持既有返回形状不变', async () => {
    const dir = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['kit/a/only.mjs'], deps: [], criteria: ['C1'], extra: ['case_type: 3'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, scope: ['kit/b/only.mjs'], deps: [], criteria: ['C2'] }) },
      ],
    })
    gitCommitFast(dir, 'init wave docs')
    try {
      const roots = await resolveRepoRoots(dir)
      const origOut = process.stdout.write.bind(process.stdout)
      let out = ''
      process.stdout.write = (c) => { out += String(c); return true }
      let withHandoff
      try {
        withHandoff = await handleBatch({ _: ['plan'], handoff: true, json: true }, roots)
      } finally { process.stdout.write = origOut }

      // 正向 1：既有返回形状一字不改
      for (const key of ['totalTasks', 'parallelDispatch', 'readySlicesCount', 'waves', 'order', 'parallelizable']) {
        if (!(key in withHandoff)) return `batch plan 丢了既有字段 ${key}`
      }
      const w = withHandoff.waves[0]
      if (!w.canParallel || w.tasks.length !== 2) return `两片无前置且写域不撞时应并行就绪：${JSON.stringify(w)}`

      // 正向 2：每个就绪切片都配了交接包，且字段齐全
      const handoffs = w.handoffs ?? []
      if (handoffs.length !== 2) return `交接包数量与就绪切片不符：${handoffs.length}`
      for (const h of handoffs) {
        for (const key of ['taskId', 'sourceDoc', 'criteriaCount', 'criteria', 'scopeFiles', 'dependsOn', 'dispatchCommand']) {
          if (!(key in h)) return `交接包缺字段 ${key}：${JSON.stringify(h)}`
        }
        if (!h.dispatchCommand.includes(`--task ${h.taskId}`)) return `派发命令没带 taskId：${h.dispatchCommand}`
        if (h.criteriaCount < 1) return `交接包没抽到验收标准：${h.taskId}`
        if (!h.prompt || !h.prompt.includes(h.taskId)) return `交接包正文缺失或不含 taskId：${h.taskId}`
        // 派发命令的档位必须跟着切片走：一律写死 --case 4 会让只有 Todo 的 Case 3 切片
        // 拿到一个它不满足的档位要求，命令直接跑不起来。
        if (!h.dispatchCommand.includes(`--case ${h.caseType}`)) {
          return `派发命令的档位与切片不符（caseType=${h.caseType}）：${h.dispatchCommand}`
        }
      }

      // 正向 3：档位跟着切片自己声明的走，不是一律 4。
      //
      // 只断言「命令里的档位 == 返回的 caseType」是自证的——两处都由同一个变量拼出来。
      // 得钉住一个**外部可核的期望值**：切片显式写了 `case_type: 3`，命令就必须是 `--case 3`。
      const explicitThree = handoffs.find((h) => h.taskId === 'slice-a')
      if (!explicitThree) return `交接包缺 slice-a：${JSON.stringify(handoffs.map((h) => h.taskId))}`
      if (explicitThree.caseType !== 3) {
        return `切片显式声明 case_type: 3 没被采纳，实际 ${explicitThree.caseType}`
      }
      if (!explicitThree.dispatchCommand.includes('--case 3')) {
        return `显式 Case 3 切片拿到的派发命令档位不对：${explicitThree.dispatchCommand}`
      }
      // 正向 4：没显式声明档位的切片按有无 SPEC 推——有 SPEC 就是 Case 4。
      const inferred = handoffs.find((h) => h.taskId === 'slice-b')
      if (!inferred) return `交接包缺 slice-b`
      if (inferred.caseType !== 4) return `有 SPEC 的切片应派生 Case 4，实际 ${inferred.caseType}`

      // 反向 1：不传 --handoff 时不额外计算交接包
      const origOut2 = process.stdout.write.bind(process.stdout)
      process.stdout.write = () => true
      let plain
      try {
        plain = await handleBatch({ _: ['plan'], json: true }, roots)
      } finally { process.stdout.write = origOut2 }
      if (plain.waves.some((x) => Object.prototype.hasOwnProperty.call(x, 'handoffs'))) {
        return '未传 --handoff 时仍然算了交接包'
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['flow verify 透传 --artifact / --visual-blocked-reason，裸 --visual-checked 不再伪造观察串', async () => {
    // 反向 1：源代码里不许再有那句凭空生成的观察串
    const lc = readFileSync(new URL('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs', import.meta.url), 'utf8')
    if (lc.includes('e2e/visual runtime behavior observed and verified')) {
      return '裸 --visual-checked 仍在伪造观察串——那会把「谁也没说看到了什么」写成证据'
    }

    // 正向 2：CLI 真收得下这两个标志（收不下会以「未知参数」退出 2）
    const { runAbsAsync } = await import('./fixtures-helpers.mjs')
    const helpRes = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['batch', 'plan', '--help'])
    if (helpRes.status !== 0) return `flow --help 失败：${helpRes.stderr}`
    const helpText = readFileSync(new URL('../../kit/skills/dev-flow/scripts/flow.mjs', import.meta.url), 'utf8')
    for (const flag of ["'artifact'", "'visual-blocked-reason'"]) {
      if (!helpText.includes(flag)) return `flow.mjs 未注册 ${flag}`
    }
    if (!/multiFlags: \[[^\]]*'artifact'/.test(helpText)) return 'artifact 未按可重复标志注册'

    // 正向 3：Fail-Soft 探测仍在——入口缺席时必须放行，不能为「一个还没写的函数」把整条 verify 拦死。
    const helpers = readFileSync(new URL('../../kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs', import.meta.url), 'utf8')
    if (!helpers.includes('validateVerifyPrecheck')) return '前置预检入口未接'
    if (!/typeof fn !== 'function'\) return null/.test(helpers)) {
      return '前置预检未按 Fail-Soft 处理：入口缺席时应直接放行'
    }

    // 反向 2：参数名必须与 `validateVerifyPrecheck` 读的一字不差。
    // 名字对不上时它内部拿到的根与实证路径全是 null：校验照旧通过、却什么都没落账，
    // 门禁看着在工作，附件实证链条其实断在这儿。
    for (const field of ['repoRoot:', 'gitCommonDir:', 'headSha:']) {
      if (!new RegExp(`\\b${field}`).test(helpers)) {
        return `前置预检少传 ${field}——名字对不上就等于什么都没落账`
      }
    }

    // 正向 4 / 反向 3-4：端到端验一次「附件到底有没有落进 evidence.json」。
    //
    // 这一条是整组用例的关键：前面几条只证明「标志收得下、代码里有这个函数」，
    // 而真正会坏的地方是**校验过了、记录没写进去**。附件能拦人放人却不落账，
    // 等于 `--artifact` 在端到端下完全没用，而所有断言都还是绿的。
    const { handleStart: startForArtifact } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify: verifyForArtifact } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { resolveRepoRoots: resolveRootsForArtifact } = await import('../../kit/skills/lib/shared.mjs')
    const { gitCommitFast: commitForArtifact, gitSync: gitForArtifact } = await import('./fixtures-helpers.mjs')

    const evDir = makeWaveRepo({})
    try {
      const evRoots = await resolveRootsForArtifact(evDir)
      const st = await startForArtifact({
        task: 'art-ev', case: '2', slug: 'art-ev', files: 'src/App.tsx', implementer: 'alice', 'no-issue': true, reason: 'UI 验证附件落账夹具',
      }, evRoots)
      if (st.exitCode !== 0) return `附件用例 start 失败：${st.exitCode}`
      const evWt = join(evDir, '.worktrees', 'impl-art-ev')
      mkdirSync(join(evWt, 'src'), { recursive: true })
      writeFileSync(join(evWt, 'src', 'App.tsx'), 'export const App = () => null\n', 'utf8')
      const goodArt = join(evWt, 'shot.txt')
      writeFileSync(goodArt, 'nonempty-evidence', 'utf8')
      const emptyArt = join(evWt, 'empty.txt')
      writeFileSync(emptyArt, '', 'utf8')
      gitForArtifact(evWt, ['add', '-A'])
      gitForArtifact(evWt, ['commit', '-qm', 'app'])

      const evPath = join(evDir, '.git', 'project-forge-flow', 'tasks', 'art-ev', 'evidence.json')

      // 反向 3：空文件不是实证，必须拦住，且不许把它写进 evidence.json。
      const emptyRes = await verifyForArtifact({ task: 'art-ev', mode: 'gate', artifact: [emptyArt] }, evRoots)
      if (emptyRes.exitCode === 0) return '0 字节空附件被放行了——空文件不能当实证'

      // 反向 4：不存在的附件同样必须拦住。
      const missingRes = await verifyForArtifact({ task: 'art-ev', mode: 'gate', artifact: [join(evWt, 'no-such-file.png')] }, evRoots)
      if (missingRes.exitCode === 0) return '不存在的附件被放行了'

      // 正向 4：真附件放行，且**必须真的出现在 evidence.json 里**。
      const okRes = await verifyForArtifact({ task: 'art-ev', mode: 'gate', artifact: [goodArt] }, evRoots)
      if (okRes.exitCode !== 0) return `合法附件未放行：${okRes.exitCode}`
      if (!existsSync(evPath)) return 'verify 通过了却没有写出 evidence.json'
      const ev = JSON.parse(readFileSync(evPath, 'utf8'))
      const rec = (ev.artifacts ?? []).find((r) => String(r.relPath ?? '').endsWith('shot.txt'))
      if (!rec) return `合法附件没有落进 evidence.json：${JSON.stringify(ev.artifacts)}`
      if (!(rec.bytes > 0)) return `附件登记的字节数为 ${rec.bytes}——元数据没写全`
      if (!/^[a-f0-9]{8,}$/i.test(String(rec.sha256Prefix ?? ''))) {
        return `附件缺少校验指纹：${JSON.stringify(rec)}`
      }
      if (!ev.visual || ev.visual.required !== true) {
        return `触及界面资源的变更没有留下界面核验记录：${JSON.stringify(ev.visual)}`
      }
    } finally { rmTree(evDir) }
    return true
  }])

  cases.push(['auditRepoDocs 不再重复报 UNCOVERED_ACCEPTANCE_CRITERIA，checkSliceMetadata 只检未完成未归档 SPEC', async () => {
    const { auditRepoDocs } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')
    const dir = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['kit/a/**'], deps: [], criteria: ['C1'] }) },
        // 已完成的 SPEC 不要求补 scope_files / depends_on
        {
          file: 'docs/specs/261120-issue2-done-spec.md',
          text: makeDoc({
            kind: 'spec', title: 'S-done', status: 'implemented',
            extra: ['tier: L3', 'issue: 2', 'owner: p', 'approved: true', 'plan_critique: passed', 'related_prd: ../prd/261120-master-prd.md', 'task_id: slice-done'],
            body: ['## 验收标准', '- [x] C1: 完成'],
          }),
        },
        // 已归档的 SPEC 不要求补 scope_files / depends_on
        {
          file: 'docs/archive/specs/261120-issue3-arch-spec.md',
          text: makeDoc({
            kind: 'spec', title: 'S-arch', status: 'approved',
            extra: ['tier: L3', 'issue: 3', 'owner: p', 'approved: true', 'plan_critique: passed', 'related_prd: ../../prd/261120-master-prd.md', 'task_id: slice-arch'],
            body: ['## 验收标准', '- [ ] C1: 归档'],
          }),
        },
      ],
      extra: {
        // Todo 不需要 scope_files / depends_on
        'docs/todo/261120-issue1-a-todo.md': makeDoc({
          kind: 'todo', title: 'T-a', status: 'active',
          extra: ['tier: L3', 'issue: 1', 'owner: p', 'related_prd: ../prd/261120-master-prd.md', 'related_spec: ../specs/261120-issue1-a-spec.md', 'task_id: slice-a'],
          body: ['## 待办', '- [ ] 任务'],
        }),
      },
    })
    try {
      const aud = auditRepoDocs(dir, '.')
      const uncoveredHits = (aud.coverageErrors ?? []).filter((e) => e.code === 'UNCOVERED_ACCEPTANCE_CRITERIA')
      if (uncoveredHits.length !== 1) {
        return `auditRepoDocs 重复或漏报 UNCOVERED_ACCEPTANCE_CRITERIA（期望 1 条，实际 ${uncoveredHits.length} 条）：${JSON.stringify(uncoveredHits)}`
      }
      const metaHits = (aud.coverageErrors ?? []).filter((e) => e.code === 'SLICE_METADATA_MISSING')
      if (metaHits.length !== 0) {
        return `checkSliceMetadata 误伤了 todo / implemented / archived 切片：${JSON.stringify(metaHits)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

}
