/**
 * fixtures-plan-wave.mjs —— 双态规划、规划退场门禁、切片图校验与波次交接包的正反双向夹具。
 *
 * 四个模块各一组用例：`pending-decisions.mjs`（规划态枚举）、`plan-exit-gate.mjs`（退场门禁）、
 * `doc-slice-graph.mjs`（切片图四检）、`flow batch plan --handoff`（交接包与透传标志）。
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
import { gitCommitFast, gitInit, gitSync, rmTree, tmpProject } from './fixtures-helpers.mjs'

const PLAN_AGENTS = [
  '# plan-wave',
  '',
  '```yaml',
  'quick-test: exit 0',
  'full-test: exit 0',
  'smoke-verify: none',
  'merge-gate: exit 0',
  'high-risk: none',
  '```',
  '',
].join('\n')

/** 拼一份规划文档：只列本次判据关心的字段，其余按模板最小形状给。 */
function makeDoc({ kind, title = 'T', status, extra = [], body = [] }) {
  return [
    '---',
    `kind: ${kind}`,
    `title: "${title}"`,
    `status: ${status}`,
    'created: 2026-11-20',
    'updated: 2026-11-20',
    ...extra,
    '---',
    '',
    `# ${title}`,
    '',
    '## 要解决的问题',
    '- 判据测试。',
    '',
    '## 本期不做',
    '- 不做别的。',
    '',
    '## 门型与回滚路径',
    '- two-way；revert',
    '',
    ...body,
    '',
  ].join('\n')
}

function makeMaster({ criteria = ['C1', 'C2'], extra = [] } = {}) {
  return makeDoc({
    kind: 'prd',
    title: 'Master',
    status: 'active',
    extra: ['owner: p', 'multi_spec: true', 'plan_critique: passed', 'related_spec: null', 'related_todo: null', ...extra],
    body: ['## 五、验收标准', ...criteria.map((c) => `- [ ] ${c}: 切片 ${c}`)],
  })
}

function makeSpec({ taskId, issue = 1, status = 'approved', approved = true, critique = 'passed', scope = [], deps = [], criteria = ['C1'], extra = [] } = {}) {
  const extraLines = [
    `issue: ${issue}`,
    'pr: null',
    'branch: null',
    'owner: p',
    `approved: ${approved}`,
    'implemented: false',
    `plan_critique: ${critique}`,
    'related_prd: ../prd/261120-master-prd.md',
    'related_todo: null',
    'high_risk_paths: []',
    `task_id: ${taskId}`,
    `depends_on: [${deps.join(', ')}]`,
    `scope_files: [${scope.join(', ')}]`,
    ...extra,
  ]
  // 正文里的写域清单是 `flow batch plan` 用的那一份：它从「改动文件」这类标题下
  // 抽反引号包住的带扩展名路径。与 Frontmatter 的 `scope_files` 是同一件事的两个入口，
  // 两边都要给，波次编排才排得出并行；glob 写法只进 Frontmatter（正文抽取只认具体文件）。
  const plainScope = scope.map((s) => String(s).replace(/^"|"$/g, '')).filter((s) => !s.includes('*'))
  const scopeBody = plainScope.length > 0
    ? ['## 改动文件', '', ...plainScope.map((s) => `- \`${s}\``), '']
    : []
  return makeDoc({
    kind: 'spec',
    title: `S-${taskId}`,
    status,
    extra: ['tier: L3', ...extraLines],
    body: [...scopeBody, '## 验收标准', ...criteria.map((c) => `- [x] ${c}: 已完成`)],
  })
}

function makeWaveRepo({ specs = [], master = null } = {}) {
  const files = {
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': PLAN_AGENTS,
    'src/app.mjs': 'export const v = 1\n',
  }
  if (master !== null) files['docs/prd/261120-master-prd.md'] = master
  for (const { file, text } of specs) files[file] = text
  const dir = tmpProject(files)
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
  return dir
}

export function registerPlanWaveCases(cases) {
  cases.push(['plan_mode 双态：默认推导只认已声明的门型与档位，非法枚举被结构化拦下', async () => {
    // 正向 1：两条合规流都有名字，且都能从已有事实推出来
    if (PLAN_MODES.length !== 2 || !PLAN_MODES.includes('interactive') || !PLAN_MODES.includes('autonomous')) {
      return `规划态枚举形状不对：${JSON.stringify(PLAN_MODES)}`
    }
    const cases = [
      [{ doorType: 'one-way' }, 'interactive', '单向门撤不回来，必须逐题问到零'],
      [{ caseType: 4 }, 'interactive', 'Case 4 改外部契约，猜错要别人跟着改'],
      [{ kind: 'prd' }, 'interactive', '总控 PRD 是整个产品的容器'],
      [{ caseType: 3, doorType: 'two-way' }, 'autonomous', '局部可逆的 L2 默认推进'],
      [{ kind: 'todo' }, 'autonomous', 'Todo 自己不是决策容器'],
    ]
    for (const [input, want, why] of cases) {
      const got = deriveDefaultPlanMode(input)
      if (got !== want) return `${JSON.stringify(input)} 应推导为 ${want}（${why}），实际 ${got}`
    }

    // 正向 2：显式合法值优先于推导
    if (resolveDocPlanMode({ kind: 'prd', explicit: 'autonomous' }) !== 'autonomous') {
      return '显式声明的合法规划态被默认推导覆盖了'
    }
    if (resolveDocPlanMode({ caseType: 3, explicit: 'INTERACTIVE' }) !== 'interactive') {
      return '规划态没有做大小写归一'
    }

    // 反向 1：非法枚举必须报出来，且带上能照着改的提示
    const badDoc = ['---', 'kind: spec', 'plan_mode: manual', '---', '', '# x', ''].join('\n')
    const errs = planModeErrors(badDoc)
    if (errs.length !== 1 || errs[0].code !== 'INVALID_PLAN_MODE') {
      return `非法 plan_mode 未被识别：${JSON.stringify(errs)}`
    }
    if (!errs[0].fixHint.includes('interactive') || !errs[0].fixHint.includes('autonomous')) {
      return `非法 plan_mode 的提示没有给出合法取值：${errs[0].fixHint}`
    }

    // 反向 2：非法值不许被「默认推导」悄悄吃掉——那会让人以为自己选了 interactive
    if (resolveDocPlanMode({ caseType: 4, explicit: 'manual' }) !== 'interactive') {
      return '非法显式值没有被归一到推导结果'
    }

    // 反向 3：没有 Frontmatter 的文档不报——那不是规划单，别拿规划判据套它
    if (planModeErrors('# 普通文档\n\n没有任何 Frontmatter。\n').length !== 0) {
      return '对没有 Frontmatter 的文档报了 plan_mode 错'
    }
    return true
  }])

  cases.push(['规划退场门禁：Case 3/4 按已绑定文档判，Case 1/2/5 不适用，自举可显式豁免', async () => {
    const dir = makeWaveRepo({
      master: makeMaster({ criteria: ['C1'] }),
      specs: [
        {
          file: 'docs/specs/261120-issue1-a-spec.md',
          text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['src/a.mjs'], criteria: ['C1'] }),
        },
      ],
    })
    try {
      const readySpec = 'docs/specs/261120-issue1-a-spec.md'

      // 正向 1：过审 SPEC 绑定后放行
      const ok = evaluatePlanExitGate(dir, {
        caseType: 4, taskId: 'slice-a', docs: { spec: readySpec },
      })
      if (!ok.ok || ok.blocked) return `过审 SPEC 被误拦：${JSON.stringify(ok.reasons)}`

      // 反向 1：未过审（draft + approved: false + critique pending）必须拦，且三条理由都在
      const draftPath = 'docs/specs/261120-issue2-b-spec.md'
      writeFileSync(join(dir, draftPath), makeSpec({
        taskId: 'slice-b', issue: 2, status: 'draft', approved: false, critique: 'pending', scope: ['src/b.mjs'],
      }), 'utf8')
      const blocked = evaluatePlanExitGate(dir, { caseType: 4, taskId: 'slice-b', docs: { spec: draftPath } })
      if (!blocked.blocked || blocked.code !== 'BLOCKED_PLAN_NOT_READY' || blocked.exitCode !== 3) {
        return `未过审 SPEC 未被以退出码 3 拦下：${JSON.stringify({ code: blocked.code, exitCode: blocked.exitCode })}`
      }
      const text = formatPlanExitGate(blocked).join('\n')
      if (!text.includes('尚未过审') || !text.includes('规划内审')) {
        return `门禁文本没有说清哪条不过：${text}`
      }

      // 反向 2：待拍板未清零时，就算过了审也要拦——这是两种规划态的共同下限
      const pendingPath = 'docs/specs/261120-issue3-c-spec.md'
      writeFileSync(join(dir, pendingPath), `${makeSpec({ taskId: 'slice-c', issue: 3, scope: ['src/c.mjs'] })}\n## 待拍板问题\n\n- 要不要拆成两片？\n`, 'utf8')
      const pendingBlocked = evaluatePlanExitGate(dir, { caseType: 4, taskId: 'slice-c', docs: { spec: pendingPath } })
      if (!pendingBlocked.blocked || !pendingBlocked.reasons.some((r) => r.code === 'BLOCKED_PENDING_DECISIONS')) {
        return `未清零的待拍板事项没有拦住：${JSON.stringify(pendingBlocked.reasons.map((r) => r.code))}`
      }

      // 反向 3：Case 3 不走 approve，未过审不该被拿来卡 L2
      const case3 = evaluatePlanExitGate(dir, { caseType: 3, taskId: 'slice-b', docs: { spec: draftPath } })
      if (!case3.ok) return `Case 3 被 Case 4 的过审判据误拦：${JSON.stringify(case3.reasons)}`

      // 反向 4：Case 1/2/5 一律不适用
      for (const ct of [1, 2, 5]) {
        const r = evaluatePlanExitGate(dir, { caseType: ct, taskId: 'x', docs: { spec: draftPath } })
        if (!r.ok || r.applicable) return `Case ${ct} 不应进入规划退场判定：${JSON.stringify(r)}`
      }

      // 正向 2：自举豁免放行，但把本该拦的理由原样带回来
      const boot = evaluatePlanExitGate(dir, {
        caseType: 4, taskId: 'slice-b', docs: { spec: draftPath }, allowBootstrap: true,
      })
      if (!boot.ok || !boot.bootstrap || (boot.wouldBlock ?? []).length === 0) {
        return `自举豁免没有放行或没有留痕：${JSON.stringify(boot)}`
      }
      if (!formatPlanExitGate(boot).join('\n').includes(PLAN_BOOTSTRAP_FLAG)) {
        return '自举豁免放行时没有说明被绕过的是哪一条'
      }

      // 反向 5：一份规划都没绑时不拦，但要留一条可见的警告
      const unbound = evaluatePlanExitGate(dir, { caseType: 3, taskId: 'no-docs', docs: {} })
      if (!unbound.ok) return '没绑文档就被拦了——先 start 后 init 的合法顺序会被判死'
      if (!unbound.warnings?.some((w) => w.code === 'WARN_PLAN_NOT_BOUND')) {
        return `没绑文档时没有留可见的警告：${JSON.stringify(unbound)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['规划退场门禁接入 flow start：未过审以退出码 3 拦住，且不留下分支或工作位', async () => {
    const dir = makeWaveRepo({
      master: makeMaster({ criteria: ['C1'] }),
      specs: [{
        file: 'docs/specs/261120-issue1-a-spec.md',
        text: makeSpec({ taskId: 'slice-a', issue: 1, status: 'draft', approved: false, critique: 'pending', scope: ['src/a.mjs'] }),
      }],
    })
    gitCommitFast(dir, 'init plan docs')
    try {
      const roots = await resolveRepoRoots(dir)
      const origOut = process.stdout.write.bind(process.stdout)
      const origErr = process.stderr.write.bind(process.stderr)
      let out = ''
      let err = ''
      process.stdout.write = (c) => { out += String(c); return true }
      process.stderr.write = (c) => { err += String(c); return true }
      let blocked
      let booted
      try {
        blocked = await handleStart({
          task: 'gate-block', case: '4', slug: 'gate-block',
          spec: 'docs/specs/261120-issue1-a-spec.md', implementer: 'alice',
        }, roots)
        booted = await handleStart({
          task: 'gate-boot', case: '4', slug: 'gate-boot',
          spec: 'docs/specs/261120-issue1-a-spec.md', implementer: 'alice',
          'allow-plan-bootstrap': true,
        }, roots)
      } finally {
        process.stdout.write = origOut
        process.stderr.write = origErr
      }
      if (blocked.exitCode !== 3) return `flow start 未以退出码 3 拦下未过审规划：${blocked.exitCode}`
      if (!err.includes('BLOCKED_PLAN_NOT_READY')) return `stderr 没有报出阻断码：${err.slice(0, 200)}`
      // 反向：拦住之后不许留下任何工作位痕迹——门禁必须在建分支建工作位之前
      const { existsSync } = await import('node:fs')
      if (existsSync(join(dir, '.worktrees', 'impl-gate-block'))) {
        return '门禁拦下之后仍然建了工作位——它必须在建分支之前'
      }
      if (booted.exitCode !== 0) return `--allow-plan-bootstrap 未能放行规划 PR 自举：${booted.exitCode}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['停损 override 放行后门禁不再误拦：签字有效即过审，无签字或正文改动过仍拦住', async () => {
    // 真实形状来自 e2e Scenario I：critique-reject 三轮触发停损 -> 人类 critique-override
    // -> approve（只改 status/approved，**不动** plan_critique）-> flow start --case 4。
    // `plan_critique: rejected (...)` 会在 override 之后原样留着，它是「当初被拒过」的历史，
    // 不是「现在仍未过审」。把两者等价，等于让人签的字不生效。
    const specBody = (overrideJson) => {
      const lines = [
        '---', 'kind: spec', 'title: "S-stop-loss"', 'status: approved', 'tier: L3',
        'created: 2026-11-20', 'updated: 2026-11-20', 'issue: 1', 'pr: null', 'branch: null',
        'owner: planner', 'plan_mode: autonomous', 'approved: true', 'implemented: false',
        'plan_critique: rejected (reviewer=crit-3, round=3, sha=f841d5825ad0)',
        ...(overrideJson ? [`critique_override: '${overrideJson}'`] : []),
        'related_prd: ../prd/261120-master-prd.md', 'related_todo: null', 'high_risk_paths: []',
        'task_id: slice-stop', 'depends_on: []', 'scope_files: [src/a.mjs]',
        '---', '', '# SPEC: S-stop-loss', '', '## 要解决的问题', '- a', '', '## 本期不做', '- b', '',
        '## 门型与回滚路径', '- two-way', '', '## 验收标准', '- [x] C1: `src/a.mjs` ok', '',
      ]
      return lines.join('\n')
    }
    const overrideFor = (text) => JSON.stringify({
      approved: true, reason: 'approved after stop-loss', by: 'human-maintainer',
      at: '2026-11-20T00:00:00.000Z', sha: critiqueTextFingerprint(text), overriddenRounds: [3],
    })

    const bare = specBody(null)
    const withOverride = specBody(overrideFor(bare))
    // override 记在 Frontmatter 里且被 stripCritiqueMeta 剥掉，所以签字前后正文指纹应当一致。
    if (critiqueTextFingerprint(withOverride) !== critiqueTextFingerprint(bare)) {
      return '签字前后正文指纹不一致——override 元字段混进了指纹'
    }
    const tampered = `${withOverride}\n- override 之后又加的一条\n`

    const dir = makeWaveRepo({
      master: makeMaster({ criteria: ['C1'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-stop-spec.md', text: bare },
        { file: 'docs/specs/261120-issue2-signed-spec.md', text: withOverride },
        { file: 'docs/specs/261120-issue3-tampered-spec.md', text: tampered },
      ],
    })
    gitCommitFast(dir, 'init stop-loss docs')
    try {
      // 正面：签字有效 -> 放行
      const fresh = evaluatePlanExitGate(dir, { caseType: 4, taskId: 'slice-stop', docs: { spec: 'docs/specs/261120-issue2-signed-spec.md' } })
      if (!fresh.ok) {
        return `override 签字有效仍被拦截：${JSON.stringify((fresh.reasons ?? []).map((r) => r.message))}`
      }

      // 反面 A：没有 override -> 仍拦住，判据是 plan_critique 本身
      const unsigned = evaluatePlanExitGate(dir, { caseType: 4, taskId: 'slice-stop', docs: { spec: 'docs/specs/261120-issue1-stop-spec.md' } })
      if (!unsigned.blocked) return '没有 override 的 rejected 文档被放行了'
      if (!unsigned.reasons.some((r) => r.code === 'BLOCKED_PLAN_NOT_READY' && r.message.includes('rejected'))) {
        return `拦截理由没说清是内审未过：${JSON.stringify(unsigned.reasons.map((r) => r.message))}`
      }
      if (!unsigned.reasons.some((r) => String(r.fixHint).includes('critique-override'))) {
        return `拦截理由没指出可以用 override 裁决：${JSON.stringify(unsigned.reasons.map((r) => r.fixHint))}`
      }

      // 反面 B：有 override 但正文改过 -> 仍拦，且理由必须是「override 之后正文被改动」
      const stale = evaluatePlanExitGate(dir, { caseType: 4, taskId: 'slice-stop', docs: { spec: 'docs/specs/261120-issue3-tampered-spec.md' } })
      if (!stale.blocked) return 'override 之后正文被改动，却仍然放行了——人批的不是这一版'
      const staleReason = stale.reasons.find((r) => r.code === 'BLOCKED_PLAN_NOT_READY' && /override/.test(r.message))
      if (!staleReason) {
        return `正文改动后的拦截理由没说清是 override 过期：${JSON.stringify(stale.reasons.map((r) => r.message))}`
      }
      if (!staleReason.message.includes('critique-override') || !staleReason.message.includes('正文')) {
        return `override 过期理由措辞不清：${staleReason.message}`
      }

      // 判据要点直测：三种输入各自落到 should/shouldn't block
      const { parseDocFrontmatter } = await import('../../kit/skills/lib/doc-frontmatter.mjs')
      const readinessOf = (text) => resolveCritiqueReadiness({
        rel: 'docs/specs/x-spec.md', text, data: parseDocFrontmatter(text).data,
      })
      if (readinessOf(withOverride).basis !== 'human-override') return '签字有效时判据依据不是 human-override'
      if (readinessOf(bare).basis !== 'critique-unready') return '无签字时判据依据不是 critique-unready'
      if (readinessOf(tampered).basis !== 'override-stale') return '正文改动时判据依据不是 override-stale'
      return true
    } finally { rmTree(dir) }
  }])

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
      const hit = r.errors.find((e) => e.code === 'BLOCKED_SLICE_OVERLAP')
      if (!hit) return `同波次写域碰撞没被报出来：${JSON.stringify(r.errors.map((e) => e.code))}`
      if (!hit.message.includes('kit/shared')) return `碰撞报告没有指出具体路径：${hit.message}`
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
      if (r.errors.some((e) => e.code === 'BLOCKED_SLICE_OVERLAP')) {
        return '确定性派生清单被当成了写域碰撞'
      }
    } finally { rmTree(manifest) }

    // 反向 8：两个都还没做完的活跃切片写同一份文件 -> 必须报碰撞。
    // 这一条与下面的正向构成一对：只有「已完成」这一条线能把同样形状的碰撞判掉，
    // 不能反过来把活跃切片的碰撞也一并放过。
    const activeCollide = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, scope: ['AGENTS.md'], deps: [], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, scope: ['AGENTS.md'], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(activeCollide)
      const hit = r.errors.find((e) => e.code === 'BLOCKED_SLICE_OVERLAP')
      if (!hit) return `两个活跃切片写同一份文件没被报碰撞：${JSON.stringify(r.errors.map((e) => e.code))}`
      if (!hit.message.includes('AGENTS.md')) return `活跃切片碰撞没有指出具体路径：${hit.message}`
    } finally { rmTree(activeCollide) }

    // 正向 4：两个都已完成（implemented）的切片写同一份文件 -> 不报。
    //
    // 已完成/已归档的切片不会再被并行派发，「它们都写过 AGENTS.md」是既成事实，
    // 不是待处理的冲突。把它们算进同波次碰撞，会让每一次合并之后的仓库常驻一条
    // 历史交叉告警——报出来的不是问题，是噪音。
    //
    // 两份都放 `docs/specs/`：只有这样它们才都归属同一份活跃总控、才都进候选集，
    // 判决才真的由「已完成」这一条线作出。放进 `docs/archive/specs/` 时
    // `related_prd` 会解析到归档目录、匹配不上活跃总控，用例会因为归属不符而静默通过——
    // 那不是在测过滤条件，那是在测一个永远不会失败的摆设。
    const doneCollide = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-a-spec.md', text: makeSpec({ taskId: 'slice-a', issue: 1, status: 'implemented', scope: ['AGENTS.md'], deps: [], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-b-spec.md', text: makeSpec({ taskId: 'slice-b', issue: 2, status: 'implemented', scope: ['AGENTS.md'], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(doneCollide)
      const hit = r.errors.find((e) => e.code === 'BLOCKED_SLICE_OVERLAP')
      if (hit) return `已完成的切片之间被误报成同波次碰撞：${hit.message}`
      // 前提自检：这两片确实都在候选视野里，否则上面的「没报错」毫无意义。
      const g = buildSliceGraph(doneCollide)
      const inMaster = g.slices.filter((s) => s.kind === 'spec' && s.masterRel === 'docs/prd/261120-master-prd.md')
      if (inMaster.length !== 2) return `正例前提不成立：归属同一总控的切片数为 ${inMaster.length}，应为 2`
      if (!inMaster.every((s) => s.done)) return '正例前提不成立：这两片并未被判定为已完成'
    } finally { rmTree(doneCollide) }

    // 正向 5：活跃切片依赖一个已完成的切片、两者写同一份文件 -> 也不报。
    //
    // 依赖已满足，活跃切片必然落在更晚的波次；硬把它和前一片拉到同一波次，
    // 等于说「你的前置跟你并行」——那既不合拓扑，也把最常见的续做场景判成冲突。
    const mixedDep = makeWaveRepo({
      master: makeMaster({ criteria: ['C1', 'C2'] }),
      specs: [
        { file: 'docs/specs/261120-issue1-new-spec.md', text: makeSpec({ taskId: 'new-slice', issue: 1, scope: ['AGENTS.md'], deps: ['old-slice'], criteria: ['C1'] }) },
        { file: 'docs/specs/261120-issue2-old-spec.md', text: makeSpec({ taskId: 'old-slice', issue: 2, status: 'implemented', scope: ['AGENTS.md'], deps: [], criteria: ['C2'] }) },
      ],
    })
    try {
      const r = evaluateSliceGraph(mixedDep)
      const hit = r.errors.find((e) => e.code === 'BLOCKED_SLICE_OVERLAP')
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
        task: 'art-ev', case: '1', slug: 'art-ev', files: 'src/App.tsx', implementer: 'alice',
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

  cases.push(['doc-plan triage 与 init 认 --plan-mode 并回写 Frontmatter，非法值以结构化错误拒绝', async () => {
    const { runAbsAsync } = await import('./fixtures-helpers.mjs')
    const dir = tmpProject({ 'AGENTS.md': PLAN_AGENTS })
    gitSync(dir, ['init', '-q', '-b', 'main'])
    gitSync(dir, ['config', 'user.name', 'alice'])
    gitSync(dir, ['config', 'user.email', 'alice@example.com'])
    mkdirSync(join(dir, 'docs'), { recursive: true })
    try {
      // 正向 1：triage 回显规划态
      const tri = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--summary', '改一个跨模块的外部契约', '--dir', dir, '--json',
      ])
      if (tri.status !== 0) return `triage 失败：${tri.stderr}`
      const triJson = JSON.parse(tri.stdout)
      if (!PLAN_MODES.includes(triJson.planMode)) return `triage 没有给出规划态：${JSON.stringify(triJson.planMode)}`
      if (triJson.planMode !== 'interactive') return `跨模块契约变更应推导为 interactive，实际 ${triJson.planMode}`

      // 正向 2：显式 --plan-mode 写进 Frontmatter
      const initOk = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--dir', dir, '--kind', 'pair', '--slug', 'pm', '--title', 'PM', '--plan-mode', 'autonomous', '--json',
      ])
      if (initOk.status !== 0) return `init --plan-mode 失败：${initOk.stderr}`
      for (const rel of JSON.parse(initOk.stdout).files) {
        const txt = readFileSync(join(dir, rel), 'utf8')
        if (!/^plan_mode: autonomous$/m.test(txt)) return `${rel} 没有写入 plan_mode: autonomous`
      }

      // 反向 1：非法枚举被结构化拒绝（不是静默降级）
      const initBad = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--dir', dir, '--kind', 'todo', '--slug', 'bad', '--title', 'Bad', '--plan-mode', 'manual', '--json',
      ])
      if (initBad.status === 0) return '非法 --plan-mode 被放行了'
      const badJson = JSON.parse(initBad.stdout)
      if (badJson.code !== 'INVALID_PLAN_MODE' || !Array.isArray(badJson.allowed)) {
        return `非法 --plan-mode 没有给出结构化错误：${initBad.stdout.slice(0, 200)}`
      }

      // 反向 2：文档里被改成非法值时 audit 抓得住
      const todoRel = JSON.parse(initOk.stdout).files.find((f) => f.endsWith('-todo.md'))
      const todoAbs = join(dir, todoRel)
      writeFileSync(todoAbs, readFileSync(todoAbs, 'utf8').replace(/^plan_mode: .*$/m, 'plan_mode: manual'), 'utf8')
      const auditBad = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', todoRel, '--dir', dir, '--json'])
      if (auditBad.status === 0) return '非法 plan_mode 的文档通过了 audit'
      if (!auditBad.stdout.includes('INVALID_PLAN_MODE')) return `audit 报的不是 INVALID_PLAN_MODE：${auditBad.stdout.slice(0, 300)}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['doc-plan audit 跨路径审计不假绿：目标目录自身是 worktree 根时以它作审计根', async () => {
    const { runAbsAsync } = await import('./fixtures-helpers.mjs')
    const dir = makeWaveRepo({ specs: [{ file: 'docs/todo/261120-w-todo.md', text: makeDoc({ kind: 'todo', title: 'W', status: 'active', extra: ['owner: p', 'approved: false', 'done_at: null', 'task_id: w', 'planned_at: HEAD', 'related_prd: null', 'related_spec: null'], body: ['## 验收标准', '- [ ] C1: x'] }) }] })
    const wtRel = '.worktrees/impl-x'
    gitSync(dir, ['worktree', 'add', '-q', wtRel, '-b', 'feat/x'])
    const wtAbs = join(dir, wtRel)
    mkdirSync(join(wtAbs, 'docs/todo'), { recursive: true })
    // 故意写一个非法 status：审计必须抓到它，否则「扫不到 = 假绿」这条就没被证伪。
    writeFileSync(join(wtAbs, 'docs/todo/261120-y-todo.md'), makeDoc({
      kind: 'todo', title: 'Y', status: 'bogus-state',
      extra: ['owner: p', 'approved: false', 'done_at: null', 'task_id: y', 'planned_at: HEAD', 'related_prd: null', 'related_spec: null'],
      body: ['## 验收标准', '- [ ] C1: 未勾选'],
    }), 'utf8')
    try {
      // 反向：worktree 里那份 Todo 还没勾完，跨路径审计必须审到它并报失败。
      // 只按外仓根算相对路径会扫不到任何文档，返回 auditedCount: 0 / ok: true ——
      // 一份都没查却报全部通过，比报错危险得多。
      const res = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', wtAbs, '--dir', dir, '--json'])
      const out = JSON.parse(res.stdout)
      if (out.auditedCount === 0) return `跨路径审计没扫到任何文档（假绿）：${res.stdout.slice(0, 200)}`
      if (out.ok) return '跨路径审计漏报了 worktree 里的问题文档'

      // 正向：目标目录不是独立工程根时，仍按外仓根审计——不要把所有子目录都当成新根。
      const sub = join(dir, 'docs')
      const subRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', sub, '--dir', dir, '--json'])
      const subOut = JSON.parse(subRes.stdout)
      if (subOut.auditedCount === 0) return '审计普通子目录时一份文档都没扫到'
      if (subOut.scope !== 'docs') return `普通子目录被当成独立根了（scope=${subOut.scope}）`

      // 反向 2：一个带 `docs/` + `AGENTS.md` 的普通子包目录**不是**独立工程根。
      //
      // 早先按「长得像工程根」认，这种目录会被当成新根、审计范围从 `pkg/` 变成 `.`，
      // 于是仓根那几份真正该审的受管规划一份都不在视野里——扫了个空却报全部通过。
      // 这和路径没归一是同一类假绿，只是换了个入口。
      const pkg = join(dir, 'pkg')
      mkdirSync(join(pkg, 'docs'), { recursive: true })
      writeFileSync(join(pkg, 'AGENTS.md'), '# pkg\n', 'utf8')
      writeFileSync(join(pkg, 'docs', 'note.md'), '# note\n', 'utf8')
      const pkgRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', pkg, '--dir', dir, '--json'])
      const pkgOut = JSON.parse(pkgRes.stdout)
      if (pkgOut.scope === '.') {
        return '带 docs/ 与 AGENTS.md 的普通子包目录被当成了独立工程根——仓根受管规划会滑出视野'
      }

      // 同一目录两个名字（符号链接 / 短文件名）时，两边坐标系必须对齐。
      //
      // 这不是假想的边角：macOS 的临时目录就是 `/var -> /private/var` 的符号链接，
      // 审计根按 realpath 归一、scope 参数却是原样路径，`relative()` 就会算出仓外相对路径，
      // 一份文档都匹配不上，然后返回 `auditedCount: 0, ok: true`。这种情况在本机
      // （临时目录没有链接）永远复现不出来，所以必须在这里自己造一个别名出来。
      const alias = `${dir}-alias`
      let aliasReady = true
      try { symlinkSync(dir, alias, process.platform === 'win32' ? 'junction' : 'dir') } catch { aliasReady = false }
      if (aliasReady) {
        try {
          const aliasRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', join(alias, 'docs'), '--dir', dir, '--json'])
          const aliasOut = JSON.parse(aliasRes.stdout)
          if (aliasOut.auditedCount === 0) {
            return `同一目录换个别名访问就一份都扫不到了（假绿）；scope=${aliasOut.scope}，ok=${aliasOut.ok}`
          }
          if (!String(aliasOut.scope).startsWith('docs')) {
            return `别名访问时算出的审计范围跑到了仓外：${aliasOut.scope}`
          }
        } finally { rmTree(alias) }
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['待拍板扫描器保持原判据：只有「已定/决定/结论」算拍板，光写「建议」不算', async () => {
    // 正向：明确结论 + 整节写「无」都算清零
    const cleared = analyzePendingDecisions([
      '## 待拍板问题', '', '- 要不要拆两片？已定：拆。', '', '## 其他', '', '- 待确认：无', '',
    ].join('\n'))
    if (cleared.unresolved.length !== 0) return `已拍板文档仍被报未清零：${JSON.stringify(cleared.unresolved)}`

    // 反向 1：只写「建议」不算拍板
    const suggested = analyzePendingDecisions(['## 待拍板问题', '', '- 要不要拆两片？建议：拆成两片。', ''].join('\n'))
    if (suggested.unresolved.length !== 1) return `只写「建议」被当成了拍板：${JSON.stringify(suggested)}`

    // 反向 2：一条问号都没有的文档不该被报
    if (analyzePendingDecisions('# 普通文档\n\n没有问题。\n').found) return '没有待拍板节的文档被误判为有待拍板事项'
    return true
  }])
}
