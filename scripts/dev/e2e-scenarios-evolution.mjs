#!/usr/bin/env node
/**
 * e2e-scenarios-evolution.mjs —— 离线全链路 Scenarios H–L 端到端验证（基于解压独立安装包 + 本地模拟远端）。
 *
 * 覆盖：
 *   - Scenario H：统一完整技能装配、`doc-locate` 零写盘精确定位与 `handoff` 精简切片；
 *   - Scenario I：`flow intake` 拒审关单 + 自动建标打标 + `closePr`、并发 `ledger.mjs` 锁安全与本地模拟远端双协作者抢锁/403 降级；
 *   - Scenario J：`dev-edit` 全入口阻断违禁写法 + `signals.jsonl` 跨两次复发升格（零默认膨胀 `AGENTS.md`）+ `dev-govern` 常青文档泛化；
 *   - Scenario K：`docs/feature-map.json` 增量同步 + `dev-review` 先实证后 `--include-diff` 门禁 + 清理校验；
 *   - Scenario L：`dev-iterate` 原生测试生成/并发实跑/`escalation` 建单 + Overlay/Hook/嵌套发现/`untrusted-scan` + `merge3` 无 `.mjs` 冲突标 + 语法/ABI 异常瞬时回滚。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { prepareExecInvocation } from '../../kit/skills/lib/exec.mjs'
import { readZip, stripCommonPrefix } from '../zip.mjs'
import { startMockRemoteServer } from './mock-remote-server.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

async function runScenarioH(pkgRoot, sandbox, env, h) {
  const repoH = join(sandbox, 'evo-h')
  h.initGitRepo(repoH, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# Evo H\n\nUnified full skill assembly and on-demand locate demo.\n',
    'docs/TDD.md': '# Evo H TDD\n\n## 1. Architecture\n\nCore entry `src/core.mjs` handles routing.\n\n## 2. Verification\n\nRun `node test/unit.mjs`.\n',
    'src/core.mjs': 'export function routeOrder(id) { return { ok: true, id } }\n',
    'test/unit.mjs': "import { routeOrder } from '../src/core.mjs'\nif (!routeOrder(1).ok) process.exit(1)\n",
  })

  h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoH, '--no-backup'], repoH, env), 'Scenario H equip')
  const manifest = JSON.parse(readFileSync(join(repoH, '.agents/skills/.pf-manifest.json'), 'utf8'))
  if (manifest.schemaVersion !== 3) throw new Error(`Scenario H expected manifest schemaVersion=3, got ${manifest.schemaVersion}`)
  if (!existsSync(join(repoH, '.agents/skills/dev-iterate/SKILL.md'))) throw new Error('Scenario H missing dev-iterate skill')

  // doc-locate zero-write precision lookup
  const stBefore = h.runGit(repoH, ['status', '--porcelain']).stdout
  const locRes = h.runNodeScript(join(repoH, '.agents/skills/dev-explore/scripts/doc-locate.mjs'), ['--query', 'routeOrder', '--json'], repoH, env)
  h.assertOk(locRes, 'Scenario H doc-locate')
  const locJson = JSON.parse(locRes.stdout)
  if (!Array.isArray(locJson.slices) || locJson.slices.length === 0) throw new Error(`Scenario H doc-locate missed slices: ${locRes.stdout}`)
  const stAfter = h.runGit(repoH, ['status', '--porcelain']).stdout
  if (stBefore !== stAfter) throw new Error('Scenario H doc-locate polluted working tree')
}

async function runScenarioI(pkgRoot, sandbox, env, h) {
  const mockSrv = await startMockRemoteServer(join(sandbox, 'mock-remote-i'))
  try {
    const repoI = join(sandbox, 'evo-i')
    h.initGitRepo(repoI, {
      '.gitignore': '.worktrees/\n',
      'README.md': '# Evo I\n',
      'AGENTS.md': '# Evo I\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
      'src/app.mjs': 'export const ok = true\n',
    })
    h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoI, '--no-backup'], repoI, env), 'Scenario I equip')

    const { createGitHubClient } = await import(pathToFileURL(join(pkgRoot, 'kit/skills/lib/github-client.mjs')).href)
    const { GitHubBackend } = await import(pathToFileURL(join(pkgRoot, 'kit/skills/lib/task-backend.mjs')).href)
    const { updateTaskLedger, readTaskLedger } = await import(pathToFileURL(join(pkgRoot, 'kit/skills/lib/ledger.mjs')).href)

    // 1. Auto-create labels + closePr + mergeCommit readback via local HTTP mock remote
    const aliceClient = createGitHubClient({ tier: 'node-https-token', token: 'mock-tok', httpsRequest: mockSrv.createHttpsRequest('alice') })
    const aliceBackend = new GitHubBackend({ targetRepo: 'acme/mock', client: aliceClient, mainRoot: repoI })
    const createdPr = await aliceBackend.createPr({ targetRepo: 'acme/mock', head: 'ext/off-scope', base: 'main', title: 'Off-scope PR', body: 'Adds unrelated subsystem' })
    if (!createdPr.ok || !createdPr.number) throw new Error(`Scenario I createPr failed: ${JSON.stringify(createdPr)}`)
    const closed = await aliceBackend.closePr({
      repo: 'acme/mock', number: createdPr.number,
      comment: '### 业务分诊结论 · 拒绝关闭（REJECT）\n\n超出仓库边界。',
      labels: ['wontfix', 'triage:rejected'],
    })
    if (!closed.ok || String(closed.state).toUpperCase() !== 'CLOSED') throw new Error(`Scenario I closePr failed: ${JSON.stringify(closed)}`)

    // 2. Dual-collaborator claim -> 403 fork label downgrade -> takeover
    const iss = await aliceBackend.createIssue({ repo: 'acme/mock', title: 'feat: sync work', body: 'test' })
    const claimA = await aliceBackend.claimTask({ taskId: 'ti-1', issues: [iss.number], actor: 'alice', branch: 'feat/ti-1' })
    if (!claimA.ok) throw new Error(`Scenario I claimA failed: ${JSON.stringify(claimA)}`)

    await mockSrv.configure({ simulateLabel403: true })
    const bobClient = createGitHubClient({ tier: 'node-https-token', token: 'mock-tok', httpsRequest: mockSrv.createHttpsRequest('bob') })
    const bobBackend = new GitHubBackend({ targetRepo: 'acme/mock', client: bobClient, mainRoot: repoI })
    const forkLbl = await bobBackend.syncStateLabel({ repo: 'acme/mock', number: iss.number, state: 'in-progress' })
    if (!forkLbl.skipped) throw new Error(`Scenario I expected 403 label downgrade skipped=true, got ${JSON.stringify(forkLbl)}`)

    await mockSrv.configure({ simulateLabel403: false })
    const takeoverB = await bobBackend.claimTask({
      taskId: 'ti-1', issues: [iss.number], actor: 'bob', branch: 'feat/ti-1',
      takeover: true, previousActor: 'alice', reason: 'handoff',
    })
    if (!takeoverB.ok) throw new Error(`Scenario I takeover failed: ${JSON.stringify(takeoverB)}`)

    // 3. Merge returns real mergeCommit SHA
    const pr2 = await aliceBackend.createPr({ targetRepo: 'acme/mock', head: 'feat/ok', base: 'main', title: 'Valid PR', body: 'ok' })
    const merged = await aliceBackend.mergePr({ repo: 'acme/mock', number: pr2.number })
    if (!merged.ok || !merged.mergeCommit) throw new Error(`Scenario I mergePr missing mergeCommit: ${JSON.stringify(merged)}`)

    // 4. Concurrent locked ledger updates preserve all mutations
    await Promise.all(Array.from({ length: 8 }, (_, idx) => updateTaskLedger(repoI, 'conc-i', (cur) => {
      const base = cur ?? { taskId: 'conc-i', marks: [] }
      return { ...base, marks: [...(base.marks ?? []), idx] }
    }, { createIfMissing: true })))
    const finalLedger = readTaskLedger(repoI, 'conc-i')
    if ((finalLedger?.marks?.length ?? 0) !== 8) throw new Error(`Scenario I concurrent ledger lost updates: ${JSON.stringify(finalLedger?.marks)}`)
  } finally {
    mockSrv.close()
  }
}

async function runScenarioJ(pkgRoot, sandbox, env, h) {
  const repoJ = join(sandbox, 'evo-j')
  h.initGitRepo(repoJ, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# Evo J\n',
    'AGENTS.md': '# Evo J\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
    'DESIGN.md': '# Design Root\n\nStandalone design rules.\n',
    'docs/DESIGN.md': '# Design Docs\n\nAnother unlinked design copy.\n',
    'src/ok.mjs': 'export const ok = 1\n',
  })
  h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoJ, '--no-backup'], repoJ, env), 'Scenario J equip')
  h.runGit(repoJ, ['add', '-A'])
  h.runGit(repoJ, ['commit', '-qm', 'equip'])

  // 1. dev-edit blocks suppression comment
  writeFileSync(join(repoJ, 'src/bad.mjs'), '// eslint-disable-next-line no-console\nexport const bad = 1\n', 'utf8')
  const editRes = h.runNodeScript(join(repoJ, '.agents/skills/dev-edit/scripts/edit-gate.mjs'), ['--files', 'src/bad.mjs', '--json'], repoJ, env)
  if (editRes.status === 0) throw new Error('Scenario J dev-edit failed to block suppression comment')

  // 2. signals.jsonl 2x repeat triggers Tier 1/2 retro without bloating AGENTS.md
  const agentsBefore = readFileSync(join(repoJ, 'AGENTS.md'), 'utf8')
  const govScript = join(repoJ, '.agents/skills/dev-govern/scripts/govern-audit.mjs')
  h.assertOk(h.runNodeScript(govScript, ['record', repoJ, '--pattern', 'edit.suppression', '--file', 'src/bad.mjs', '--message', 'repeat 1'], repoJ, env), 'Scenario J signal 1')
  h.assertOk(h.runNodeScript(govScript, ['record', repoJ, '--pattern', 'edit.suppression', '--file', 'src/bad.mjs', '--message', 'repeat 2'], repoJ, env), 'Scenario J signal 2')
  const retroRes = h.runNodeScript(govScript, ['retro', repoJ, '--json'], repoJ, env)
  h.assertOk(retroRes, 'Scenario J retro')
  if (readFileSync(join(repoJ, 'AGENTS.md'), 'utf8') !== agentsBefore) throw new Error('Scenario J retro unexpectedly bloated AGENTS.md')

  // 3. dev-govern duplicate evergreen authority detection
  const auditRes = h.runNodeScript(govScript, ['audit', repoJ, '--categories', 'docs', '--json'], repoJ, env)
  h.assertOk(auditRes, 'Scenario J govern audit docs')
  const auditJson = JSON.parse(auditRes.stdout)
  if (!(auditJson.findings ?? []).some((f) => f.id === 'docs.duplicate-authority.design')) {
    throw new Error(`Scenario J missed docs.duplicate-authority.design: ${JSON.stringify(auditJson.findings)}`)
  }
}

async function runScenarioK(pkgRoot, sandbox, env, h) {
  const repoK = join(sandbox, 'evo-k')
  h.initGitRepo(repoK, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# Evo K\n',
    'AGENTS.md': '# Evo K\n\n```yaml\nquick-test: node test/smoke.mjs\nfull-test: node test/smoke.mjs\nsmoke-verify: node test/smoke.mjs\nmerge-gate: node test/smoke.mjs\nhigh-risk: none\n```\n',
    'docs/feature-map.json': JSON.stringify({
      schemaVersion: 1,
      features: [{ id: 'orders', entryFiles: ['src/orders.mjs'], businessFlows: ['create-order'], testRefs: [] }],
    }, null, 2),
    'src/orders.mjs': 'export const createOrder = (id) => ({ id, ok: true })\n',
    'test/smoke.mjs': "import { createOrder } from '../src/orders.mjs'\nif (!createOrder(1).ok) process.exit(1)\n",
  })
  h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoK, '--no-backup'], repoK, env), 'Scenario K equip')
  h.runGit(repoK, ['add', '-A'])
  h.runGit(repoK, ['commit', '-qm', 'equip'])

  const flowK = join(repoK, '.agents/skills/dev-flow/scripts/flow.mjs')
  const revK = join(repoK, '.agents/skills/dev-review/scripts/review-pack.mjs')
  h.assertOk(h.runNodeScript(flowK, ['start', '--task', 'tk', '--case', '2', '--slug', 'tk', '--implementer', 'alice'], repoK, env), 'Scenario K start')
  h.assertOk(h.runNodeScript(flowK, ['explore', '--task', 'tk'], repoK, env), 'Scenario K explore')
  const wtK = join(repoK, '.worktrees/impl-tk')
  writeFileSync(join(wtK, 'src/orders.mjs'), 'export const createOrder = (id) => ({ id, ok: true, v: 2 })\n', 'utf8')
  h.runGit(wtK, ['add', '-A'])
  h.runGit(wtK, ['commit', '-qm', 'feat: orders v2'])

  // Empirical-first gate: --include-diff blocked before empirical observation
  h.assertOk(h.runNodeScript(flowK, ['verify', '--task', 'tk', '--mode', 'smoke'], wtK, env), 'Scenario K verify smoke without obs')
  const diffBlk = h.runNodeScript(revK, ['--task', 'tk', '--dir', repoK, '--include-diff', '--json'], repoK, env)
  if (diffBlk.status !== 3) throw new Error(`Scenario K expected --include-diff exit=3 before e2e obs, got ${diffBlk.status}`)

  h.assertOk(h.runNodeScript(flowK, ['verify', '--task', 'tk', '--mode', 'gate', '--e2e-evidence', 'orders smoke ok'], wtK, env), 'Scenario K verify gate+e2e')
  h.assertOk(h.runNodeScript(flowK, ['submit', '--task', 'tk', '--agent', 'alice'], wtK, env), 'Scenario K submit')
  h.assertOk(h.runNodeScript(revK, ['check-empirical', '--task', 'tk', '--dir', repoK, '--json'], repoK, env), 'Scenario K check-empirical')
}

async function runScenarioL(pkgRoot, sandbox, env, h) {
  const repoL = join(sandbox, 'evo-l')
  h.initGitRepo(repoL, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# Evo L\n',
    'package.json': '{"name":"evo-l","type":"module","scripts":{"test:unit":"node test/unit/a.mjs"}}\n',
    'AGENTS.md': '# Evo L\n\n```yaml\nquick-test: node test/unit/a.mjs\nfull-test: node --test tests/integration\nsmoke-verify: none\nmerge-gate: node test/unit/a.mjs\nhigh-risk: none\n```\n',
    'docs/feature-map.json': JSON.stringify({
      schemaVersion: 1,
      features: [{ id: 'billing', entryFiles: ['src/billing.mjs'], businessFlows: ['charge'], testRefs: [] }],
    }, null, 2),
    'src/billing.mjs': 'export const charge = (n) => n * 100\n',
    'test/unit/a.mjs': "import { charge } from '../../src/billing.mjs'\nif (charge(2) !== 200) process.exit(1)\n",
    '.agents/forge-overlays/custom.md': '# Local overlay rule\n',
    '.agents/forge-hooks.json': JSON.stringify({ hooks: { finalize: { enabled: false } } }, null, 2),
    'packages/deep/a/b/c/d/e/skills/nested-ops/SKILL.md': '---\nname: nested-ops\ndescription: Deeply nested skill.\n---\n# nested-ops\n',
  })
  h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoL, '--no-backup'], repoL, env), 'Scenario L equip')
  h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoL, '--check'], repoL, env), 'Scenario L equip --check with overlays/hooks')

  // 1. dev-iterate generates native test (never in .agents/), updates feature-map testRefs, runs concurrently, escalates real failure
  const iterScript = join(repoL, '.agents/skills/dev-iterate/scripts/iterate.mjs')
  const genRes = h.runNodeScript(iterScript, ['generate', repoL, '--focus', 'billing', '--tier', 'integration', '--write', '--json'], repoL, env)
  h.assertOk(genRes, 'Scenario L dev-iterate generate')
  const genJson = JSON.parse(genRes.stdout)
  if (!genJson.writtenPaths.length || genJson.writtenPaths.some((p) => p.startsWith('.agents/'))) {
    throw new Error(`Scenario L invalid generated paths: ${JSON.stringify(genJson)}`)
  }
  const fmAfter = JSON.parse(readFileSync(join(repoL, 'docs/feature-map.json'), 'utf8'))
  if (!fmAfter.features[0].testRefs.includes(genJson.writtenPaths[0])) {
    throw new Error(`Scenario L did not attach testRef back to feature-map.json: ${JSON.stringify(fmAfter)}`)
  }
  const runPass = h.runNodeScript(iterScript, ['run', repoL, '--targets', genJson.writtenPaths.join(','), '--concurrency', '2', '--json'], repoL, env)
  h.assertOk(runPass, 'Scenario L dev-iterate run pass')

  // Intentional failing regression test -> escalation + signals.jsonl without modifying business source
  const failTestAbs = join(repoL, 'tests/integration/failing-check.test.mjs')
  mkdirSync(dirname(failTestAbs), { recursive: true })
  writeFileSync(failTestAbs, "import assert from 'node:assert/strict'\nimport test from 'node:test'\ntest('regression fails', () => { assert.equal(1, 2) })\n", 'utf8')
  const runFail = h.runNodeScript(iterScript, ['run', repoL, '--targets', 'tests/integration/failing-check.test.mjs', '--escalate', '--json'], repoL, env)
  if (runFail.status === 0) throw new Error('Scenario L failing test should exit non-zero')
  const failJson = JSON.parse(runFail.stdout)
  if (failJson.signalsWritten < 1 || !failJson.escalations?.[0]?.ok) {
    throw new Error(`Scenario L failed to escalate or record signal: ${runFail.stdout}`)
  }

  // 2. merge3 conflict on .mjs: zero conflict markers in target, writes .upstream + .pf-conflict + pendingConflicts + exit 3
  const baseKit = join(sandbox, 'kit-base-l')
  const upKit = join(sandbox, 'kit-up-l')
  mkdirSync(join(baseKit, 'dev-flow/scripts'), { recursive: true })
  mkdirSync(join(upKit, 'dev-flow/scripts'), { recursive: true })
  const baseFlow = "export const version = 'v1'\nexport const mode = 'base'\n"
  const localFlow = "export const version = 'v1-local'\nexport const mode = 'base'\n"
  const upFlow = "export const version = 'v2-upstream'\nexport const mode = 'base'\n"
  const skillMd = '---\nname: dev-flow\ndescription: mock flow skill\n---\n# dev-flow\n'
  writeFileSync(join(baseKit, 'dev-flow/SKILL.md'), skillMd, 'utf8')
  writeFileSync(join(baseKit, 'dev-flow/scripts/demo.mjs'), baseFlow, 'utf8')
  writeFileSync(join(upKit, 'dev-flow/SKILL.md'), skillMd, 'utf8')
  writeFileSync(join(upKit, 'dev-flow/scripts/demo.mjs'), upFlow, 'utf8')

  const m3Repo = join(sandbox, 'evo-l-m3')
  h.initGitRepo(m3Repo, { 'README.md': '# m3\n' })
  h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [m3Repo, '--kit-dir', baseKit, '--no-backup'], m3Repo, env), 'Scenario L m3 base equip')
  const targetMjs = join(m3Repo, '.agents/skills/dev-flow/scripts/demo.mjs')
  writeFileSync(targetMjs, localFlow, 'utf8')
  const confRes = h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [m3Repo, '--kit-dir', upKit, '--base-dir', baseKit, '--no-backup'], m3Repo, env)
  if (confRes.status !== 3) throw new Error(`Scenario L merge3 conflict expected exit=3, got ${confRes.status}: ${confRes.stderr}`)
  const keptLocal = readFileSync(targetMjs, 'utf8')
  if (keptLocal !== localFlow || keptLocal.includes('<<<<<<<')) throw new Error('Scenario L merge3 corrupted local .mjs or wrote conflict markers')
  if (existsSync(`${targetMjs}.upstream`) || existsSync(`${targetMjs}.pf-conflict`)) {
    throw new Error('Scenario L workspace should not contain .upstream or .pf-conflict sidecar')
  }
  const confJson = JSON.parse(confRes.stdout).equip
  const cDet = confJson?.pendingConflictDetails?.find((x) => x.path === 'dev-flow/scripts/demo.mjs')
  if (!cDet || !existsSync(cDet.upstreamPath) || !existsSync(cDet.conflictPath)) {
    throw new Error(`Scenario L missing out-of-tree .upstream or .pf-conflict sidecar: ${confRes.stdout}`)
  }
  const m3Man = JSON.parse(readFileSync(join(m3Repo, '.agents/skills/.pf-manifest.json'), 'utf8'))
  if (!m3Man.pendingConflicts?.['dev-flow/scripts/demo.mjs']?.outOfTree) throw new Error('Scenario L manifest missing outOfTree pendingConflicts entry')

  // 3. equip-integrity rollback on broken syntax / ESM ABI
  const badKit = join(sandbox, 'kit-bad-l')
  mkdirSync(join(badKit, 'dev-flow/scripts'), { recursive: true })
  writeFileSync(join(badKit, 'dev-flow/SKILL.md'), skillMd, 'utf8')
  writeFileSync(join(badKit, 'dev-flow/scripts/demo.mjs'), 'export const broken = (\n', 'utf8')
  const rbRepo = join(sandbox, 'evo-l-rb')
  h.initGitRepo(rbRepo, { 'README.md': '# rb\n' })
  h.assertOk(h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [rbRepo, '--kit-dir', baseKit, '--no-backup'], rbRepo, env), 'Scenario L rb base equip')
  const rbRes = h.runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [rbRepo, '--kit-dir', badKit, '--no-backup'], rbRepo, env)
  if (rbRes.status === 0) throw new Error('Scenario L broken syntax kit should fail and roll back')
  const restoredText = readFileSync(join(rbRepo, '.agents/skills/dev-flow/scripts/demo.mjs'), 'utf8')
  if (restoredText !== baseFlow) throw new Error(`Scenario L integrity rollback did not restore base file: ${restoredText}`)
}

export const EVOLUTION_SCENARIOS = {
  'evo-h': runScenarioH,
  'evo-i': runScenarioI,
  'evo-j': runScenarioJ,
  'evo-k': runScenarioK,
  'evo-l': runScenarioL,
}

/** 运行全部离线演化端到端场景（Scenarios H–L）。 */
export async function runEvolutionScenarios(pkgRoot, sandbox, env, helpers) {
  for (const fn of [runScenarioH, runScenarioI, runScenarioJ, runScenarioK, runScenarioL]) {
    await fn(pkgRoot, sandbox, env, helpers)
  }
}

function defaultHelpers() {
  const runNodeScript = (scriptAbs, args, cwd, envExtra = {}) => spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd, encoding: 'utf8', timeout: 90000, windowsHide: true,
    env: { ...process.env, PF_NO_REAL_AUTH_PROBE: '1', ...envExtra },
  })
  const runGit = (cwd, args) => {
    const inv = prepareExecInvocation('git', args, { cwd, env: process.env })
    const res = spawnSync(inv.cmd, inv.args, { cwd, encoding: 'utf8', windowsHide: true, env: inv.env })
    if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
    return res
  }
  const initGitRepo = (dir, files = {}) => {
    mkdirSync(dir, { recursive: true })
    runGit(dir, ['init', '-q', '-b', 'main'])
    runGit(dir, ['config', 'user.name', 'alice'])
    runGit(dir, ['config', 'user.email', 'alice@example.com'])
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content, 'utf8')
    }
    if (Object.keys(files).length > 0) { runGit(dir, ['add', '-A']); runGit(dir, ['commit', '-qm', 'init']) }
  }
  const assertOk = (res, label) => {
    if (res.status !== 0) throw new Error(`${label} failed (exit=${res.status}):\nOUT: ${res.stdout}\nERR: ${res.stderr}`)
  }
  return { runNodeScript, runGit, initGitRepo, assertOk }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const sandbox = mkdtempSync(join(tmpdir(), 'pf-evo-e2e-'))
  const env = { PF_BACKUP_DIR: join(sandbox, 'backups'), PF_NO_REAL_AUTH_PROBE: '1' }
  const h = defaultHelpers()
  const t0 = performance.now()
  try {
    const zipFile = join(sandbox, 'project-forge.zip')
    h.runGit(REPO_ROOT, ['archive', '--format=zip', '--prefix=project-forge/', '-o', zipFile, 'HEAD'])
    const entries = stripCommonPrefix(readZip(readFileSync(zipFile)))
    const pkgRoot = join(sandbox, 'pkg')
    for (const e of entries) {
      const abs = join(pkgRoot, e.name)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, e.data)
    }
    await runEvolutionScenarios(pkgRoot, sandbox, env, h)
    process.stdout.write(`离线演化端到端 Scenarios H–L 全通（耗时 ${Math.round(performance.now() - t0)} ms）。\n`)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`FAIL e2e-scenarios-evolution: ${err instanceof Error ? err.stack || err.message : String(err)}\n`)
    process.exit(1)
  } finally {
    try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }) } catch { /* ignore */ }
  }
}
