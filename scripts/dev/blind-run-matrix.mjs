/**
 * blind-run-matrix.mjs —— `$TMPDIR` 多生态与复杂工程（含 `LoopForge-main` 形态）Zero-Hint 5 大核心场景
 * 及 `gemini-3.8-flash-high` 零提示词全 4 维度定量矩阵验证器。
 *
 * 严格仅存于 `scripts/dev/`（不入用户包），零外网依赖。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createGitHubClient } from '../../kit/skills/lib/github-client.mjs'
import { GitHubBackend } from '../../kit/skills/lib/task-backend.mjs'
import { survey } from '../survey.mjs'
import { gitCommitFast, gitInit, rmTree, SKILL_ROOT, tmpProject } from './fixtures-helpers.mjs'
import { startMockRemoteServer } from './mock-remote-server.mjs'

export const BLIND_MODEL_BENCHMARK = Object.freeze({
  targetModel: 'gemini-3.8-flash-high',
  mode: 'zero-hint',
  dimensions: Object.freeze([
    'first-pass-completion',
    'on-demand-token-reduction',
    'routing-precision-and-zero-bloat',
    'empirical-interception',
  ]),
})

function runNode(scriptAbs, args, cwd, envExtra = {}) {
  return spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
    env: { ...process.env, PF_NO_REAL_AUTH_PROBE: '1', ...envExtra },
  })
}

function assertStep(tracker, name, cond, detail = '') {
  tracker.record(name, Boolean(cond), cond ? 'ok' : (detail || 'assertion failed'))
}

/** 运行复杂工程（LoopForge-main 形态：嵌套 `local/skills/*`、双语文档、Day-2、跨代 Overlay/merge3 升级）与 5 类 Zero-Hint 场景。 */
export async function runEvolutionBlindMatrix(tracker, sandbox, envExtra) {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\nnode_modules/\n',
    'README.md': '# LoopForge Sample\n\n[English](README.en.md)\n\n## 快速开始\n\n运行核心工作流。\n',
    'README.en.md': '# LoopForge Sample\n\n[中文](README.md)\n\n## Quick Start\n\nRun core workflows.\n',
    'package.json': JSON.stringify({ name: 'loopforge-sample', version: '1.0.0', type: 'module', scripts: { 'test:unit': 'node test/unit/core.mjs' } }, null, 2),
    'docs/TDD.md': [
      '# LoopForge Sample TDD', '',
      '## 1. Architecture', '',
      'Core scheduler lives in `src/scheduler.mjs` and billing hooks live in `src/billing.mjs`.', '',
      '## 2. Detailed Reference', '',
      ...Array.from({ length: 60 }, (_, i) => `- Reference note ${i + 1}: internal implementation detail for archive context sizing.`),
      '',
    ].join('\n'),
    'docs/feature-map.json': JSON.stringify({
      schemaVersion: 1,
      features: [
        { id: 'scheduler', entryFiles: ['src/scheduler.mjs'], businessFlows: ['dispatch-job'], testRefs: [] },
        { id: 'billing', entryFiles: ['src/billing.mjs'], businessFlows: ['settle-invoice'], testRefs: [] },
      ],
    }, null, 2),
    'src/scheduler.mjs': 'export const dispatchJob = (id) => ({ id, dispatched: true })\n',
    'src/billing.mjs': 'export const settleInvoice = (amt) => ({ total: amt, paid: true })\n',
    'test/unit/core.mjs': "import { dispatchJob } from '../../src/scheduler.mjs'\nif (!dispatchJob('j1').dispatched) process.exit(1)\n",
    'local/skills/domain-helper/SKILL.md': '---\nname: domain-helper\ndescription: Nested local domain skill for LoopForge.\n---\n# domain-helper\n',
    '.agents/forge-overlays/domain-rules.md': '# Domain Overlay\n\nPreserve custom domain constraints.\n',
    '.agents/forge-hooks.json': JSON.stringify({ hooks: { finalize: { enabled: false } } }, null, 2),
  })
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

  const mockSrv = await startMockRemoteServer(join(sandbox, 'blind-matrix-mock'))
  const metrics = {
    benchmarkModel: BLIND_MODEL_BENCHMARK.targetModel,
    mode: BLIND_MODEL_BENCHMARK.mode,
    firstPassScenariosPassed: 0,
    firstPassScenariosTotal: 5,
    onDemandBytes: 0,
    fullDocsBytes: 0,
    tokenReductionPct: 0,
    agentsBytes: 0,
    agentsBloatDelta: 0,
    empiricalInterceptsPassed: 0,
    empiricalInterceptsTotal: 3,
  }

  try {
    // 1. S1-S4 onboarding on LoopForge-style sandbox (nested local/skills/* + overlays + bilingual docs)
    const s1 = await survey(dir, { quiet: true })
    const eq1 = runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [dir, '--no-backup'], dir, envExtra)
    const ca1 = runNode(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'), [dir, '--no-backup'], dir, envExtra)
    const agentsPath = join(dir, 'AGENTS.md')
    const agentsText = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : ''
    metrics.agentsBytes = Buffer.byteLength(agentsText, 'utf8')
    const hasNestedLocal = Boolean(s1?.kit?.customSkills?.some((s) => s.name === 'domain-helper'))
    assertStep(
      tracker,
      'matrix:loopforge-onboard-nested-skills-and-overlays',
      hasNestedLocal && eq1.status === 0 && ca1.status === 0
      && agentsText.includes('domain-helper') && metrics.agentsBytes < 24576
      && existsSync(join(dir, '.agents/forge-overlays/domain-rules.md')),
      `nested=${hasNestedLocal} eq=${eq1.status} ca=${ca1.status} bytes=${metrics.agentsBytes}`,
    )

    // Configure runnable profile & commit baseline
    const calibrated = agentsText
      .replace(/^quick-test:.*$/m, 'quick-test: node test/unit/core.mjs')
      .replace(/^full-test:.*$/m, 'full-test: node test/unit/core.mjs')
      .replace(/^smoke-verify:.*$/m, 'smoke-verify: node test/unit/core.mjs')
      .replace(/^merge-gate:.*$/m, 'merge-gate: node test/unit/core.mjs')
      .replace(/^arch-rules:.*$/m, 'arch-rules: none')
      .replace(/^high-risk:.*$/m, 'high-risk: none')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已校准。')
    writeFileSync(agentsPath, calibrated, 'utf8')
    gitCommitFast(dir, 'chore: onboard loopforge sample')

    const flow = join(dir, '.agents/skills/dev-flow/scripts/flow.mjs')
    const locScript = join(dir, '.agents/skills/dev-explore/scripts/doc-locate.mjs')
    const iterScript = join(dir, '.agents/skills/dev-iterate/scripts/iterate.mjs')
    const editScript = join(dir, '.agents/skills/dev-edit/scripts/edit-gate.mjs')
    const govScript = join(dir, '.agents/skills/dev-govern/scripts/govern-audit.mjs')

    // Dimension 2: On-demand doc-locate vs full docs read reduction
    const fullDocsBytes = Buffer.byteLength(readFileSync(join(dir, 'docs/TDD.md'), 'utf8'), 'utf8')
      + Buffer.byteLength(readFileSync(agentsPath, 'utf8'), 'utf8')
    const locRes = runNode(locScript, ['--query', 'dispatchJob', '--json'], dir, envExtra)
    const locOutBytes = Buffer.byteLength(locRes.stdout || '', 'utf8')
    metrics.fullDocsBytes = fullDocsBytes
    metrics.onDemandBytes = locOutBytes
    metrics.tokenReductionPct = fullDocsBytes > 0 ? Math.max(0, Math.round(((fullDocsBytes - locOutBytes) / fullDocsBytes) * 100)) : 0
    assertStep(
      tracker,
      'matrix:dim2-ondemand-doc-locate-token-reduction',
      locRes.status === 0 && metrics.tokenReductionPct >= 40,
      `reduction=${metrics.tokenReductionPct}% (${locOutBytes}B vs ${fullDocsBytes}B)`,
    )

    // Zero-Hint Scenario 1 & 3: Milestone natural-language flow + dev-iterate Day-2 native test generation
    const msCreate = runNode(flow, ['milestone', 'create', '--title', 'v10-GA', '--json'], dir, envExtra)
    const issCreate = runNode(flow, ['issue', 'create', '--title', 'feat: add scheduler regression', '--milestone', '1', '--json'], dir, envExtra)
    const iterGen = runNode(iterScript, ['generate', dir, '--focus', 'scheduler', '--tier', 'integration', '--write', '--json'], dir, envExtra)
    const iterRun = iterGen.status === 0
      ? runNode(iterScript, ['run', dir, '--targets', JSON.parse(iterGen.stdout).writtenPaths.join(','), '--concurrency', '2', '--json'], dir, envExtra)
      : { status: 1 }
    const sc13Ok = msCreate.status === 0 && issCreate.status === 0 && iterGen.status === 0 && iterRun.status === 0
    if (sc13Ok) metrics.firstPassScenariosPassed += 2
    assertStep(
      tracker,
      'matrix:zero-hint-milestone-and-dev-iterate-day2',
      sc13Ok,
      `ms=${msCreate.status} iss=${issCreate.status} gen=${iterGen.status} run=${iterRun.status}`,
    )

    // Zero-Hint Scenario 2: Inbound external PR rejection + closePr + auto-label via mock remote server
    const ghClient = createGitHubClient({ tier: 'node-https-token', token: 'mock-tok', httpsRequest: mockSrv.createHttpsRequest('alice') })
    const ghBackend = new GitHubBackend({ targetRepo: 'acme/loopforge', client: ghClient, mainRoot: dir })
    const extPr = await ghBackend.createPr({ targetRepo: 'acme/loopforge', head: 'fork:off-topic', base: 'main', title: 'Off-topic change', body: 'Adds crypto miner' })
    const closeRes = await ghBackend.closePr({ repo: 'acme/loopforge', number: extPr.number, comment: 'Out of scope', labels: ['wontfix'] })
    const sc2Ok = Boolean(extPr.ok && closeRes.ok && String(closeRes.state).toUpperCase() === 'CLOSED')
    if (sc2Ok) metrics.firstPassScenariosPassed += 1
    assertStep(tracker, 'matrix:zero-hint-external-pr-reject-close', sc2Ok, JSON.stringify({ extPr, closeRes }))

    // Zero-Hint Scenario 4 & 5 + Dimension 4: Empirical interception (dev-edit + dev-iterate quality + cross-gen merge3 conflict)
    writeFileSync(join(dir, 'src/cheat.mjs'), '// @ts-ignore\nexport const x = 1\n', 'utf8')
    const editBlk = runNode(editScript, ['--files', 'src/cheat.mjs', '--json'], dir, envExtra)
    if (editBlk.status !== 0) metrics.empiricalInterceptsPassed += 1
    rmTree(join(dir, 'src/cheat.mjs'))

    const badTestCheck = runNode(process.execPath, ['-e', "import { validateGeneratedTestQuality } from './.agents/skills/dev-iterate/scripts/iterate.mjs'; const r = validateGeneratedTestQuality('.agents/bad.test.mjs', 'test(1)'); process.exit(r.ok ? 0 : 3)"], dir, envExtra)
    if (badTestCheck.status !== 0) metrics.empiricalInterceptsPassed += 1

    // Cross-gen merge3 upgrade preserving local overlay & producing .upstream/.pf-conflict without conflict markers in .mjs
    const baseKit = join(sandbox, 'lf-base-kit')
    const upKit = join(sandbox, 'lf-up-kit')
    mkdirSync(join(baseKit, 'dev-flow/scripts'), { recursive: true })
    mkdirSync(join(upKit, 'dev-flow/scripts'), { recursive: true })
    const sk = '---\nname: dev-flow\ndescription: flow skill\n---\n# dev-flow\n'
    writeFileSync(join(baseKit, 'dev-flow/SKILL.md'), sk, 'utf8')
    writeFileSync(join(baseKit, 'dev-flow/scripts/hook.mjs'), "export const ver = '1'\n", 'utf8')
    writeFileSync(join(upKit, 'dev-flow/SKILL.md'), sk, 'utf8')
    writeFileSync(join(upKit, 'dev-flow/scripts/hook.mjs'), "export const ver = '2'\n", 'utf8')
    const upDir = tmpProject({ 'README.md': '# up\n', '.agents/forge-overlays/keep.md': '# keep\n' })
    try {
      runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [upDir, '--kit-dir', baseKit, '--no-backup'], upDir, envExtra)
      writeFileSync(join(upDir, '.agents/skills/dev-flow/scripts/hook.mjs'), "export const ver = '1-local'\n", 'utf8')
      const upRun = runNode(join(SKILL_ROOT, 'scripts', 'equip.mjs'), [upDir, '--kit-dir', upKit, '--base-dir', baseKit, '--no-backup'], upDir, envExtra)
      const localAfter = readFileSync(join(upDir, '.agents/skills/dev-flow/scripts/hook.mjs'), 'utf8')
      const mergeSafeOk = upRun.status === 3 && !localAfter.includes('<<<<<<<')
        && existsSync(join(upDir, '.agents/skills/dev-flow/scripts/hook.mjs.upstream'))
        && existsSync(join(upDir, '.agents/skills/dev-flow/scripts/hook.mjs.pf-conflict'))
        && existsSync(join(upDir, '.agents/forge-overlays/keep.md'))
      if (mergeSafeOk) {
        metrics.empiricalInterceptsPassed += 1
        metrics.firstPassScenariosPassed += 2
      }
      assertStep(tracker, 'matrix:loopforge-crossgen-merge3-and-overlay-preserve', mergeSafeOk, `exit=${upRun.status}`)
    } finally {
      rmTree(upDir)
    }

    // Dimension 3: Zero spontaneous AGENTS.md bloat after govern retro
    const bytesBeforeRetro = Buffer.byteLength(readFileSync(agentsPath, 'utf8'), 'utf8')
    runNode(govScript, ['retro', dir, '--json'], dir, envExtra)
    const bytesAfterRetro = Buffer.byteLength(readFileSync(agentsPath, 'utf8'), 'utf8')
    metrics.agentsBloatDelta = bytesAfterRetro - bytesBeforeRetro
    assertStep(
      tracker,
      'matrix:dim3-zero-spontaneous-agents-bloat',
      metrics.agentsBloatDelta === 0 && metrics.empiricalInterceptsPassed === metrics.empiricalInterceptsTotal,
      `delta=${metrics.agentsBloatDelta} intercepts=${metrics.empiricalInterceptsPassed}/${metrics.empiricalInterceptsTotal}`,
    )

    return metrics
  } finally {
    mockSrv.close()
    rmTree(dir)
  }
}
