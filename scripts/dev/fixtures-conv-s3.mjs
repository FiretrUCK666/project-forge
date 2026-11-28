/**
 * fixtures-conv-s3.mjs —— Slice 3 (`ergonomics-and-budget-debloat`) C9..C12 正反双向行为断言。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseStandardCli, resolveNextSteps, withNextSteps } from '../../kit/skills/lib/cli.mjs'
import { KIT_SKILL_MAX_BYTES as KIT_MAX, KIT_SKILL_WARN_BYTES as KIT_WARN } from '../../kit/skills/lib/tool-owned.mjs'
import { evaluateNextState } from '../../kit/skills/lib/workflow-policy-next.mjs'
import { resolveRepoRoots } from './test-shared.mjs'
import { KIT_SKILL_MAX_BYTES, KIT_SKILL_MAX_LINES, KIT_SKILL_WARN_BYTES, UNIFIED_SKILL_NAMES } from '../lib/protocol.mjs'
import { evaluateKitSkillBudget } from './preflight-suite.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, SKILL_ROOT, tmpProject } from './fixtures-helpers.mjs'

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let stdout = ''
  let stderr = ''
  process.stdout.write = (c) => { stdout += String(c); return true }
  process.stderr.write = (c) => { stderr += String(c); return true }
  try {
    const res = await fn()
    return { res, stdout, stderr }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function registerConvS3Cases(cases) {
  cases.push(['Conv-S3 C9：公共参数归一化、静默旧别名/预设、triage/audit/start NEXT STEP 与 --json nextSteps', async () => {
    // 1. parseStandardCli 规范参数与静默旧别名/预设（正反双向）
    const cliSpec = {
      subcommands: ['run'],
      booleanFlags: ['confirm'],
      valueFlags: ['agent', 'mode', 'host-mode'],
      aliases: { owner: 'agent', actor: 'agent', implementer: 'agent', by: 'agent', tier: 'mode' },
      flagPresets: { 'single-session': { flag: 'host-mode', value: 'single-session', keepBoolean: true } },
    }
    const canon = parseStandardCli(['run', '--agent', 'a1', '--mode', 'full', '--host-mode', 'single-session', '--json'], cliSpec)
    if (canon.opts.agent !== 'a1' || canon.opts.mode !== 'full' || canon.opts['host-mode'] !== 'single-session' || !canon.json) {
      return `规范参数解析异常：${JSON.stringify(canon)}`
    }
    const legacy = parseStandardCli(['run', '--owner', 'o1', '--tier', 'quick', '--single-session'], cliSpec)
    if (legacy.opts.agent !== 'o1' || legacy.opts.mode !== 'quick' || legacy.opts['host-mode'] !== 'single-session' || legacy.opts['single-session'] !== true) {
      return `静默旧别名/预设兼容失效：${JSON.stringify(legacy)}`
    }
    const viaBy = parseStandardCli(['run', '--by', 'b1', '--actor', 'b2'], cliSpec)
    if (viaBy.opts.agent !== 'b2') return `别名顺序解析异常：${JSON.stringify(viaBy)}`

    // 2. withNextSteps / resolveNextSteps 单源结构化输出与去重
    const nextRes = withNextSteps({ ok: true }, ['step one', 'step one', 'step two'])
    if (!Array.isArray(nextRes.nextSteps) || nextRes.nextSteps.length !== 2 || nextRes.nextSteps[0] !== 'step one') {
      return `withNextSteps 去重/输出异常：${JSON.stringify(nextRes)}`
    }
    const resolved = resolveNextSteps(['step a'])
    if (resolved.length !== 1 || resolved[0] !== 'step a') return `resolveNextSteps 异常：${JSON.stringify(resolved)}`

    // 3. 真实仓库沙盒验证 doc-plan triage / audit 与 flow start 复用提示
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# ConvS3C9\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
      '.agents/skills/dev-plan/SKILL.md': '---\nname: dev-plan\ndescription: dev-plan\n---\n# dev-plan\n',
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: dev-flow\n---\n# dev-flow\n',
      'src/app.mjs': 'export const ok = true\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@conv.test' })
    try {
      // triage 输出必须包含 --agent <id> 且不出现 --owner，--json 必须含 nextSteps
      const tri = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--summary', '跨模块接口重构与持久化升级', '--touches-contract', '--json',
      ], { cwd: dir })
      if (tri.status !== 0) return `doc-plan triage 失败：${tri.stderr} ${tri.stdout}`
      const triJson = JSON.parse(tri.stdout)
      if (!Array.isArray(triJson.nextSteps) || triJson.nextSteps.length === 0) {
        return `doc-plan triage --json 缺少 nextSteps：${tri.stdout}`
      }
      if (!/--agent\b/.test(triJson.nextSteps[0]) || /--owner\b/.test(triJson.nextSteps[0])) {
        return `doc-plan triage NEXT STEP 未归一化为 --agent：${JSON.stringify(triJson.nextSteps)}`
      }

      // init 兼容 --owner 静默别名，audit 文本只输出一次 [NEXT STEP]，--json 含单元素 nextSteps
      const initRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 's3-cli', '--title', 'S3 CLI Test', '--owner', 'arch-legacy', '--in-place', '--json',
      ], { cwd: dir })
      if (initRes.status !== 0) return `doc-plan init 兼容 --owner 失败：${initRes.stderr} ${initRes.stdout}`
      const initJson = JSON.parse(initRes.stdout)
      if (!Array.isArray(initJson.nextSteps) || initJson.nextSteps.length === 0) {
        return `doc-plan init --json 缺少 nextSteps：${initRes.stdout}`
      }
      const specPath = initJson.file
      const cleanedSpec = readFileSync(join(dir, specPath), 'utf8')
        .replace(/<[^>]+>/g, 'src/app.mjs 实现规范说明')
        .replace(/^- \[ \] C1:.*$/m, '- [ ] C1: `src/app.mjs` 导出 `ok` 并通过测试 `exit 0`')
        .replace(/^- \[ \] C2:.*$/m, '- [ ] C2: `src/app.mjs` 边界校验通过 `exit 0`')
      writeFileSync(join(dir, specPath), cleanedSpec, 'utf8')
      const audTxt = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', specPath], { cwd: dir })
      const nextStepCount = (audTxt.stdout.match(/\[NEXT STEP\]/g) ?? []).length
      if (nextStepCount !== 1) {
        return `doc-plan audit 文本 [NEXT STEP] 出现 ${nextStepCount} 次（预期 1 次）：\n${audTxt.stdout}`
      }
      const audJson = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', specPath, '--json'], { cwd: dir })
      const audParsed = JSON.parse(audJson.stdout)
      if (!Array.isArray(audParsed.nextSteps) || audParsed.nextSteps.length !== 2) {
        return `doc-plan audit --json nextSteps 异常：${audJson.stdout}`
      }

      // flow start --planning 与已有工作树复用时的 [NEXT STEP]（规划态与认领后分别引导至 approve / next，而非 status）
      gitCommitFast(dir, 'chore: add spec')
      const roots = await resolveRepoRoots(dir)
      const stPlan1 = await withQuietIo(() => handleStart({
        task: 's3-reuse', slug: 's3-reuse', case: 4, planning: true, spec: specPath, json: true,
      }, roots))
      if (stPlan1.res.exitCode !== 0) return `flow start --planning 失败：${stPlan1.stderr} ${stPlan1.stdout}`
      const stPlan2 = await withQuietIo(() => handleStart({
        task: 's3-reuse', slug: 's3-reuse', case: 4, planning: true, spec: specPath, json: true,
      }, roots))
      const stPlan2Json = JSON.parse(stPlan2.stdout)
      if (!Array.isArray(stPlan2Json.nextSteps) || stPlan2Json.nextSteps.some((s) => /\bflow\.mjs"?\s+status\b/.test(s))) {
        return `flow start 复用规划工作树仍回退 status 提示：${stPlan2.stdout}`
      }
      if (!stPlan2Json.nextSteps.some((s) => /critique-pass|approve/.test(s))) {
        return `flow start 复用规划工作树未引导完成审批：${stPlan2.stdout}`
      }

      // 全仓 CLI 参数对拍必须 0 失败
      const parityRes = await runAbsAsync('scripts/dev/cli-parity.mjs', [], { cwd: SKILL_ROOT })
      if (parityRes.status !== 0) {
        return `cli-parity 存在漂移：${parityRes.stderr} ${parityRes.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['Conv-S3 C10 & C11：Skill 14KB/16KB 双线预算门禁与 8 套内置 SKILL.md 体积达标', async () => {
    // 1. 单源常量一致性（14KB warn / 16KB max）
    if (KIT_WARN !== 14 * 1024 || KIT_MAX !== 16 * 1024) {
      return `tool-owned 预算常量错误：warn=${KIT_WARN}, max=${KIT_MAX}`
    }
    if (KIT_SKILL_WARN_BYTES !== KIT_WARN || KIT_SKILL_MAX_BYTES !== KIT_MAX) {
      return `protocol.mjs 重导出与 tool-owned 不一致：${KIT_SKILL_WARN_BYTES}/${KIT_SKILL_MAX_BYTES}`
    }

    // 2. evaluateKitSkillBudget 三档边界正反断言
    const okRes = evaluateKitSkillBudget('dev-sample', 'x\n'.repeat(100))
    if (!okRes.ok || okRes.status !== 'ok' || okRes.warnings.length > 0 || okRes.errors.length > 0) {
      return `正常体积误报：${JSON.stringify(okRes)}`
    }
    const warnRes = evaluateKitSkillBudget('dev-sample', 'a'.repeat(KIT_SKILL_WARN_BYTES + 100))
    if (!warnRes.ok || warnRes.status !== 'warn' || warnRes.warnings[0]?.code !== 'WARN_KIT_SKILL_BUDGET') {
      return `14KB-16KB 区间未触发 WARN_KIT_SKILL_BUDGET：${JSON.stringify(warnRes)}`
    }
    const failRes = evaluateKitSkillBudget('dev-sample', 'a'.repeat(KIT_SKILL_MAX_BYTES + 1))
    if (failRes.ok || failRes.status !== 'fail' || failRes.errors.length === 0) {
      return `超 16KB 硬上限未失败阻断：${JSON.stringify(failRes)}`
    }

    // 3. 真实 8 套 kit/skills/*/SKILL.md 全部舒适低于 14KB 且 <= 180 行
    for (const dirName of UNIFIED_SKILL_NAMES) {
      const p = join(SKILL_ROOT, 'kit', 'skills', dirName, 'SKILL.md')
      if (!existsSync(p)) return `缺少内置 Skill：${p}`
      const res = evaluateKitSkillBudget(dirName, readFileSync(p, 'utf8'))
      if (!res.ok || res.status !== 'ok' || res.bytes > KIT_SKILL_WARN_BYTES || res.lines > KIT_SKILL_MAX_LINES) {
        return `kit/skills/${dirName}/SKILL.md 超出预算或告警线：bytes=${res.bytes}, lines=${res.lines}, status=${res.status}`
      }
    }
    return true
  }])

  cases.push(['Conv-S3 C11 & C12：Case 1 口径消除矛盾、WARN_WORKING_IN_MAIN_CHECKOUT 与常青文档同步', async () => {
    const tpl = readFileSync(join(SKILL_ROOT, 'templates', 'agents-project.md'), 'utf8')
    const agents = readFileSync(join(SKILL_ROOT, 'AGENTS.md'), 'utf8')
    for (const [label, text] of [['templates/agents-project.md', tpl], ['AGENTS.md', agents]]) {
      if (/Case 1-4 在隔离/.test(text)) {
        return `${label} 仍残留与 Case 1 原地微调冲突的 "Case 1-4 在隔离"`
      }
      if (!text.includes('Case 2-4 在隔离 `impl` 位派 `impl` 代理（Case 1 允许原地微调）')) {
        return `${label} 未同步对齐后的 Case 1 / Case 2-4 隔离描述`
      }
    }

    // 验证 WARN_WORKING_IN_MAIN_CHECKOUT 已消除「不改也行」的错误松绑表述
    const baseTask = {
      taskId: 't1', slug: 't1', caseType: 3, role: 'maintainer',
      branch: 'feat/t1', baseBranch: 'main', worktreePath: '.worktrees/impl-t1',
      status: 'implementing', rounds: [], implementerId: 'alice',
    }
    const nextOut = evaluateNextState({
      activeTasks: [baseTask],
      selectedTask: baseTask,
      taskRuntime: {
        opInProgress: false, opName: null, headSha: 'a'.repeat(40), dirty: 0, mainDirtyCount: 1,
        policy: { riskTier: 'medium', requiredGates: ['full'], independentReviewRequired: true },
        evidenceValidation: { ok: false, code: 'BLOCKED_NOT_VERIFIED', reason: '尚未实证' },
        nonDocChangesAfterFinalize: false,
      },
    })
    const warn = (nextOut.warnings ?? []).find((w) => w.code === 'WARN_WORKING_IN_MAIN_CHECKOUT')
    if (!warn) return `主工作区脏时未发出 WARN_WORKING_IN_MAIN_CHECKOUT：${JSON.stringify(nextOut.warnings)}`
    if (warn.message.includes('不改也行')) return `WARN_WORKING_IN_MAIN_CHECKOUT 仍残留错误文案「不改也行」：${warn.message}`
    if (!warn.message.includes('脏主仓门禁')) return `WARN_WORKING_IN_MAIN_CHECKOUT 未提示脏主仓门禁约束：${warn.message}`

    // 校验常青文档双语同步内容
    const tdd = readFileSync(join(SKILL_ROOT, 'docs', 'TDD.md'), 'utf8')
    const collab = readFileSync(join(SKILL_ROOT, 'references', 'collaboration.md'), 'utf8')
    const readmeZh = readFileSync(join(SKILL_ROOT, 'README.md'), 'utf8')
    const readmeEn = readFileSync(join(SKILL_ROOT, 'README.en.md'), 'utf8')
    if (!tdd.includes('KIT_SKILL_WARN_BYTES') || !tdd.includes('fixtures-conv-s3.mjs')) {
      return 'docs/TDD.md 尚未同步 Skill 14KB/16KB 预算常量或 Conv-S3 夹具清单'
    }
    if (!collab.includes('nextSteps') || !collab.includes('--reopen')) {
      return 'references/collaboration.md 尚未同步 nextSteps / --reopen 说明'
    }
    if (!readmeZh.includes('nextSteps') || !readmeEn.includes('nextSteps')) {
      return 'README.md 或 README.en.md 尚未同步规范 CLI 与 nextSteps 说明'
    }
    return true
  }])
}
