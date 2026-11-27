#!/usr/bin/env node
/**
 * e2e-zip-harness.mjs —— 基于真实 `git archive --format=zip` + `readZip` 解压安装包的 Fake-Agent E2E 测试台。
 *
 * 严格隔离验证：全量场景与防绕过断言均在解压后的独立安装包（pkgRoot）与临时沙盒仓库内执行，
 * 绝不直接调用源仓库业务实现脚本，退出码 0 仅在 7 大场景、跨会话接管与全部负面拦截全部成立时返回。
 */

import { spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { prepareExecInvocation } from '../../kit/skills/lib/exec.mjs'
import { applyLowPriority, resolveWorkerConcurrency } from '../../kit/skills/lib/proc-budget.mjs'
import { readZip, stripCommonPrefix } from '../zip.mjs'
import { EVOLUTION_SCENARIOS } from './e2e-scenarios-evolution.mjs'
import { STAGE_B_SCENARIOS } from './e2e-scenarios-lifecycle.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..')

async function issueTokenFor(repoRoot, taskId, round) {
  const { readTaskLedger, writeTaskLedger, ensureReviewToken } =
    await import(pathToFileURL(join(repoRoot, '.agents', 'skills', 'lib', 'ledger.mjs')).href)
  const ledger = readTaskLedger(repoRoot, taskId)
  const { token } = ensureReviewToken(repoRoot, ledger, round)
  return token
}

async function recordWithToken(flowScript, revScript, taskId, cwd, env, extra = []) {
  const nextRes = runNodeScript(flowScript, ['next', '--task', taskId, '--json'], cwd, env)
  assertOk(nextRes, `recordWithToken next (${taskId})`)
  const nextJson = JSON.parse(nextRes.stdout)
  const token = nextJson.reviewToken
  if (!token) {
    throw new Error(`recordWithToken(${taskId}) missing reviewToken in phase=${nextJson.phase}, blocking=${JSON.stringify(nextJson.blockingReasons)}`)
  }
  return runNodeScript(revScript, ['record', '--task', taskId, ...extra,
    '--review-token', token, '--evidence', 'E2E 实测：门禁已跑，输出符合预期'], cwd, env)
}

function runNodeScript(scriptAbs, args, cwd, envExtra = {}) {
  return spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
    env: { ...process.env, PF_NO_REAL_AUTH_PROBE: '1', ...envExtra },
  })
}

function runGit(cwd, args) {
  const inv = prepareExecInvocation('git', args, { cwd, env: process.env })
  const res = spawnSync(inv.cmd, inv.args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: inv.env,
    ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`)
  return res
}

function writeFiles(baseDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(baseDir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, 'utf8')
  }
}

let SEEDED_GIT_TEMPLATE = null

function ensureSeededGitTemplate(sandbox) {
  if (SEEDED_GIT_TEMPLATE && existsSync(SEEDED_GIT_TEMPLATE)) return SEEDED_GIT_TEMPLATE
  const tpl = join(sandbox, '_seeded-git-tpl')
  mkdirSync(tpl, { recursive: true })
  runGit(tpl, ['init', '-q', '-b', 'main'])
  runGit(tpl, ['config', 'user.name', 'alice'])
  runGit(tpl, ['config', 'user.email', 'alice@example.com'])
  SEEDED_GIT_TEMPLATE = join(tpl, '.git')
  return SEEDED_GIT_TEMPLATE
}

function initGitRepo(dir, files = {}, origin = null) {
  mkdirSync(dir, { recursive: true })
  if (SEEDED_GIT_TEMPLATE && existsSync(SEEDED_GIT_TEMPLATE)) {
    cpSync(SEEDED_GIT_TEMPLATE, join(dir, '.git'), { recursive: true })
  } else {
    runGit(dir, ['init', '-q', '-b', 'main'])
    runGit(dir, ['config', 'user.name', 'alice'])
    runGit(dir, ['config', 'user.email', 'alice@example.com'])
  }
  writeFiles(dir, files)
  if (origin) runGit(dir, ['remote', 'add', 'origin', origin])
  if (Object.keys(files).length > 0) {
    runGit(dir, ['add', '-A'])
    runGit(dir, ['commit', '-qm', 'init'])
  }
}

function assertOk(res, label) {
  if (res.status !== 0) {
    throw new Error(`${label} failed (exit=${res.status}):\nOUT: ${res.stdout}\nERR: ${res.stderr}`)
  }
}

function assertBlocked(res, codeFragment, label) {
  const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  if (res.status === 0 || !combined.includes(codeFragment)) {
    throw new Error(`${label} expected block "${codeFragment}" but got exit=${res.status}:\n${combined}`)
  }
}

function extractRealArchivePackage(sandbox) {
  const zipFile = join(sandbox, 'project-forge.zip')
  runGit(REPO_ROOT, ['archive', '--format=zip', '--prefix=project-forge/', '-o', zipFile, 'HEAD'])
  const rawEntries = readZip(readFileSync(zipFile))
  if (rawEntries.length === 0) throw new Error('git archive produced empty zip')
  if (!rawEntries.every((e) => e.name.startsWith('project-forge/'))) {
    throw new Error('zip entries missing project-forge/ common prefix')
  }
  const entries = stripCommonPrefix(rawEntries)
  const forbidden = entries.filter((e) =>
    /^(?:scripts\/dev\/|docs\/|\.agents\/)/.test(e.name)
    || ['AGENTS.md', 'CONTRIBUTING.md', 'RELEASING.md', '.gitattributes', '.gitignore'].includes(e.name))
  if (forbidden.length > 0) {
    throw new Error(`zip package leaked repo-only files: ${forbidden.map((f) => f.name).join(', ')}`)
  }
  const pkgRoot = join(sandbox, 'installed', 'project-forge')
  for (const e of entries) {
    const abs = join(pkgRoot, e.name)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, e.data)
  }
  for (const req of ['SKILL.md', 'README.md', 'LICENSE', 'scripts/equip.mjs', 'scripts/survey.mjs', 'kit/skills/dev-flow/scripts/flow.mjs']) {
    if (!existsSync(join(pkgRoot, req))) throw new Error(`extracted zip missing required file: ${req}`)
  }
  return { pkgRoot, entryCount: entries.length }
}

async function loadPkgEngines(pkgRoot) {
  const [surveyMod, equipMod, composeMod, reviewMod, backupMod] = await Promise.all([
    import(pathToFileURL(join(pkgRoot, 'scripts', 'survey.mjs')).href),
    import(pathToFileURL(join(pkgRoot, 'scripts', 'equip.mjs')).href),
    import(pathToFileURL(join(pkgRoot, 'scripts', 'compose-agents.mjs')).href),
    import(pathToFileURL(join(pkgRoot, 'scripts', 'review.mjs')).href),
    import(pathToFileURL(join(pkgRoot, 'scripts', 'backup.mjs')).href),
  ])
  return {
    survey: surveyMod.survey,
    equip: equipMod.equip,
    checkEquip: equipMod.checkEquip,
    composeAgents: composeMod.composeAgents,
    checkCompose: composeMod.checkAgents,
    reviewProject: reviewMod.reviewProject,
    createBackup: backupMod.createBackup,
  }
}

async function runScenarioA(pkgRoot, sandbox, env, eng) {
  const repoA = join(sandbox, 'repo-a')
  mkdirSync(repoA, { recursive: true })
  const bootRes = runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoA, '--bootstrap-empty', '--no-backup'], repoA, env)
  assertOk(bootRes, 'Scenario A bootstrap-empty')
  const boot = JSON.parse(bootRes.stdout || '{}')
  if (!boot?.bootstrap?.created?.length) throw new Error(`Scenario A bootstrap-empty failed: ${bootRes.stdout}`)
  for (const f of ['docs/TDD.md', '.gitattributes', '.gitignore', 'AGENTS.md', '.agents/skills/dev-flow/SKILL.md']) {
    if (!existsSync(join(repoA, f))) throw new Error(`Scenario A missing ${f}`)
  }
  if (existsSync(join(repoA, 'src', 'greet.js')) || existsSync(join(repoA, 'greet.py'))) {
    throw new Error('Scenario A leaked toy greet code')
  }
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'compose-agents.mjs'), [repoA, '--check'], repoA, env), 'Scenario A compose --check')
  const rev = await eng.reviewProject(repoA)
  if ((rev.missing ?? []).length > 0) throw new Error(`Scenario A review has missing items: ${JSON.stringify(rev.missing)}`)
}

async function runScenarioBAndC(pkgRoot, sandbox, env, eng) {
  const repoB = join(sandbox, 'repo-b')
  mkdirSync(repoB, { recursive: true })
  initGitRepo(repoB, {
    'README.md': '# mono\n\nMulti-ecosystem monorepo.\n',
    'package.json': '{"name":"mono","version":"1.0.0","scripts":{"lint":"echo lint"}}\n',
    'services/billing/pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
    'services/billing/src/test/java/BTest.java': 'class BTest {}\n',
    '.circleci/config.yml': 'version: 2.1\njobs:\n    test:\n        steps:\n            - run:\n                name: Verify\n                command: |\n                    npm run lint\n',
    '.agents/skills/custom-helper/SKILL.md': '---\nname: custom-helper\ndescription: Custom helper skill for monorepo.\n---\n# custom-helper\n',
  })

  const facts = await eng.survey(repoB)
  if (!facts.ecosystem?.kinds?.includes('node') || !facts.ecosystem?.kinds?.includes('java')) {
    throw new Error(`Scenario B missed node/java: ${JSON.stringify(facts.ecosystem)}`)
  }
  if (!(facts.kit?.customSkills ?? []).some((s) => s.name === 'custom-helper')) {
    throw new Error('Scenario B missed custom skill custom-helper')
  }

  await eng.equip(repoB, { noBackup: true, env })
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'compose-agents.mjs'), [repoB, '--no-backup'], repoB, env), 'Scenario B compose')
  if (!existsSync(join(repoB, '.agents/skills/custom-helper/SKILL.md'))) {
    throw new Error('Scenario B overwrote custom skill')
  }

  // Scenario C: .zip backup + --adopt-custom + unified equip idempotency
  const bkData = eng.createBackup(repoB, { label: 'e2e-c', env })
  const bkFile = bkData.archivePath ?? bkData.path
  if (bkData.format !== 'zip' || !bkFile || !existsSync(bkFile)) throw new Error(`Scenario C backup not .zip: ${JSON.stringify(bkData)}`)
  if (readZip(readFileSync(bkFile)).length === 0) throw new Error('Scenario C backup .zip unreadable')

  const agentsPath = join(repoB, 'AGENTS.md')
  const filled = readFileSync(agentsPath, 'utf8')
    .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    .replace('**提交纪律**：', '**提交纪律（项目定制）**：')
    .replace(/<(?:填写|单文件|运行时|高风险|禁改|禁止|跨层)[^>]*>/g, 'none')
  writeFileSync(agentsPath, filled, 'utf8')
  if (runNodeScript(join(pkgRoot, 'scripts', 'compose-agents.mjs'), [repoB, '--check'], repoB, env).status === 0) {
    throw new Error('Scenario C customized section did not trigger --check drift before --adopt-custom')
  }
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'compose-agents.mjs'), [repoB, '--adopt-custom', '--no-backup'], repoB, env), 'Scenario C adopt-custom')
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'compose-agents.mjs'), [repoB, '--check'], repoB, env), 'Scenario C check after adopt-custom')

  await eng.equip(repoB, { noBackup: true, env })
  if (!existsSync(join(repoB, '.agents/skills/dev-review/SKILL.md'))) {
    throw new Error('Scenario C unified equip missing dev-review')
  }
  const chk = eng.checkEquip(repoB)
  if (!chk.ok) throw new Error(`Scenario C equip --check failed: ${JSON.stringify(chk)}`)
}

async function runScenarioD(pkgRoot, sandbox, env) {
  // D1: local-only no-remote zero leak + full flow
  const repoD1 = join(sandbox, 'repo-d1')
  mkdirSync(repoD1, { recursive: true })
  initGitRepo(repoD1, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# local-only\n',
    'package.json': '{"name":"local-app","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'src/a.mjs': 'export const a = 1\n',
  })
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoD1, '--no-backup'], repoD1, env), 'Scenario D1 equip')
  const composeD1 = runNodeScript(join(pkgRoot, 'scripts', 'compose-agents.mjs'), [repoD1, '--no-backup'], repoD1, env)
  assertOk(composeD1, 'Scenario D1 compose')
  const agentsD1 = readFileSync(join(repoD1, 'AGENTS.md'), 'utf8')
  for (const leak of [/\bPR\b/, /\borigin\b/i, /\bpush\b/i]) {
    if (leak.test(agentsD1)) throw new Error(`Scenario D1 no-remote leaked ${leak}`)
  }
  writeFiles(repoD1, {
    'AGENTS.md': '# local-only\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
  })
  runGit(repoD1, ['add', '-A'])
  runGit(repoD1, ['commit', '-qm', 'set fast profile and equip skills'])

  const flowD1 = join(repoD1, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  const revD1 = join(repoD1, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')
  const startD1 = JSON.parse(runNodeScript(flowD1, ['start', '--task', 'd1', '--case', '2', '--slug', 'd1', '--implementer', 'alice', '--no-issue', '--reason', 'E2E 场景验证 local-only 完整流转', '--json'], repoD1, env).stdout)
  if (startD1.explored !== null) {
    throw new Error(`Scenario D1 expected explored === null on start, got ${JSON.stringify(startD1.explored)}`)
  }
  assertOk(runNodeScript(flowD1, ['claim', '--task', 'd1', '--agent', 'alice'], repoD1, env), 'Scenario D1 claim')
  const wtD1 = join(repoD1, '.worktrees', 'impl-d1')
  writeFiles(wtD1, { 'src/a.mjs': 'export const a = 2\n' })
  runGit(wtD1, ['add', '-A'])
  runGit(wtD1, ['commit', '-qm', 'fix: d1'])
  assertOk(runNodeScript(flowD1, ['verify', '--task', 'd1', '--mode', 'full'], wtD1, env), 'Scenario D1 verify')
  assertOk(runNodeScript(flowD1, ['explore', '--task', 'd1'], repoD1, env), 'Scenario D1 explicit explore')
  const postExploreD1 = JSON.parse(runNodeScript(flowD1, ['next', '--task', 'd1', '--json'], repoD1, env).stdout)
  if (postExploreD1.phase === 'needs-explore') {
    throw new Error(`Scenario D1 expected phase != needs-explore after explore, got ${postExploreD1.phase}`)
  }
  assertOk(runNodeScript(flowD1, ['submit', '--task', 'd1', '--agent', 'alice'], wtD1, env), 'Scenario D1 submit after explore')
  const nextD1 = JSON.parse(runNodeScript(flowD1, ['next', '--task', 'd1', '--json'], repoD1, env).stdout)
  if (!nextD1.reviewToken) throw new Error(`Scenario D1 missing reviewToken after explore: ${JSON.stringify(nextD1)}`)
  assertOk(runNodeScript(revD1, ['record', '--task', 'd1', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-d1',
    '--review-token', nextD1.reviewToken, '--evidence', 'E2E 实测：门禁已跑，输出符合预期'], repoD1, env), 'Scenario D1 review pass')
  assertOk(runNodeScript(flowD1, ['merge', '--task', 'd1'], repoD1, env), 'Scenario D1 merge')
  cleanupWithHash(flowD1, 'd1', repoD1, env, 'Scenario D1 cleanup')

  // D2: generic-git 在核不到远端事实时阻断，人类签字才放行
  const repoD2 = join(sandbox, 'repo-d2')
  mkdirSync(repoD2, { recursive: true })
  initGitRepo(repoD2, {
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# gen\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
    'src/g.mjs': 'export const g = 1\n',
  }, 'https://git.internal.corp/team/app.git')
  const bareD2 = join(sandbox, 'bare-d2')
  mkdirSync(bareD2, { recursive: true })
  runGit(bareD2, ['init', '--bare', '-q'])
  runGit(repoD2, ['config', `url.${bareD2.replace(/\\/g, '/')}.pushInsteadOf`, 'https://git.internal.corp/team/app.git'])

  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoD2, '--no-backup'], repoD2, env), 'Scenario D2 equip')
  runGit(repoD2, ['add', '-A'])
  runGit(repoD2, ['commit', '-qm', 'chore: equip'])
  const flowD2 = join(repoD2, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  const revD2 = join(repoD2, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')
  assertOk(runNodeScript(flowD2, ['start', '--task', 'd2', '--case', '2', '--slug', 'd2', '--implementer', 'alice', '--no-issue', '--reason', 'E2E 场景验证 generic-git 合流门禁'], repoD2, env), 'Scenario D2 start')
  assertOk(runNodeScript(flowD2, ['claim', '--task', 'd2', '--agent', 'alice'], repoD2, env), 'Scenario D2 claim')
  assertOk(runNodeScript(flowD2, ['explore', '--task', 'd2'], repoD2, env), 'Scenario D2 explore')
  const wtD2 = join(repoD2, '.worktrees', 'impl-d2')
  writeFiles(wtD2, { 'src/g.mjs': 'export const g = 2\n' })
  runGit(wtD2, ['add', '-A'])
  runGit(wtD2, ['commit', '-qm', 'fix: d2'])
  assertOk(runNodeScript(flowD2, ['verify', '--task', 'd2', '--mode', 'full'], wtD2, env), 'Scenario D2 verify')
  assertOk(runNodeScript(flowD2, ['submit', '--task', 'd2', '--agent', 'alice'], wtD2, env), 'Scenario D2 submit')
  assertOk(await recordWithToken(flowD2, revD2, 'd2', repoD2, env, ['--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-d2']), 'Scenario D2 review pass')
  assertBlocked(runNodeScript(flowD2, ['merge', '--task', 'd2'], repoD2, env), 'BLOCKED_', 'Scenario D2 generic-git unconfirmed merge')
  assertOk(runNodeScript(flowD2, ['merge', '--task', 'd2', '--human-approved', '--reason', '远端是不可达的内网仓，已在别处人工核对合并结果'], repoD2, env), 'Scenario D2 generic-git human-approved')
}

async function runScenarioE(pkgRoot, sandbox, env) {
  const repoE = join(sandbox, 'repo-e')
  mkdirSync(repoE, { recursive: true })
  initGitRepo(repoE, {
    '.gitignore': '.worktrees/\n',
    'README.md': '# repo-e\n',
    'AGENTS.md': '# e\n\n```yaml\nquick-test: node -e "process.exit(0)" -- {target}\nfull-test: node -e "process.exit(0)"\nsmoke-verify: none\nmerge-gate: node -e "process.exit(0)"\nhigh-risk: none\n```\n',
    'src/app.mjs': 'export const app = 1\n',
    'src/untouched.mjs': 'export const untouched = 1\n',
    'docs/prd/261116-issue10-master-prd.md': '---\nkind: prd\ntitle: "Master"\nstatus: active\ncreated: 2026-11-16\nupdated: 2026-11-16\nissue: 10\npr: null\nowner: "alice"\nplan_critique: passed\nrelated_spec: null\nrelated_todo: null\n---\n# Master\n- [ ] C1: child1\n- [ ] C2: child2\n',
    'docs/specs/261116-issue12-child2-spec.md': '---\nkind: spec\ntitle: "Child2"\nstatus: draft\ntier: L3\ncreated: 2026-11-16\nupdated: 2026-11-16\nissue: 12\npr: null\nbranch: null\nowner: "alice"\napproved: false\nimplemented: false\nplan_critique: pending\nrelated_prd: ../prd/261116-issue10-master-prd.md\nrelated_todo: null\nscope_files: [src/untouched.mjs]\ndepends_on: []\nhigh_risk_paths: []\n---\n# Child2\n\n## 要解决的问题\n- 调整 `src/untouched.mjs` 出口。\n\n## 本期不做\n- 不修改 `src/app.mjs`。\n\n## 门型与回滚路径\n- two-way，回滚 `src/untouched.mjs`。\n\n## 验收标准\n- [ ] C1: `src/untouched.mjs` future\n',
  })

  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoE, '--no-backup'], repoE, env), 'Scenario E equip')
  const planE = join(repoE, '.agents', 'skills', 'dev-plan', 'scripts', 'doc-plan.mjs')
  const flowE = join(repoE, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  const revE = join(repoE, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')
  const govE = join(repoE, '.agents', 'skills', 'dev-govern', 'scripts', 'govern-audit.mjs')

  const initRes = runNodeScript(planE, ['init', '--kind', 'spec', '--slug', 'child1', '--title', 'Child One', '--owner', 'alice', '--in-place', '--json'], repoE, env)
  assertOk(initRes, 'Scenario E doc-plan init spec')
  const specRel = JSON.parse(initRes.stdout).file
  const specClean = readFileSync(join(repoE, specRel), 'utf8')
    .replace('related_prd: null', 'related_prd: ../prd/261116-issue10-master-prd.md\nscope_files: [src/app.mjs]\ndepends_on: []')
    .replace('<two-way | one-way>', 'two-way')
    .replace(/<[^>]+>/g, '`src/app.mjs` 实际边界说明（不影响 `src/untouched.mjs`）')
    .replace(/^- \[ \] C1:.*$/m, '- [x] C1: verified `src/app.mjs`')
    .replace(/^- \[ \] C2:.*$/m, '- [x] C2: verified tests')
    .replace('<!-- 在合并之前补齐真实实现摘要与验证结果 -->', '- 已实现并通过测试。')
  writeFileSync(join(repoE, specRel), specClean, 'utf8')

  assertBlocked(runNodeScript(planE, ['critique-pass', '--file', specRel, '--reviewer', '@Alice', '--round', '1'], repoE, env), 'SELF_CRITIQUE_REJECTED', 'Scenario E anti-self-critique')
  assertOk(runNodeScript(planE, ['critique-pass', '--file', specRel, '--reviewer', 'critic-ext', '--round', '1'], repoE, env), 'Scenario E critique-pass')
  assertOk(runNodeScript(planE, ['approve', '--file', specRel], repoE, env), 'Scenario E approve')
  runGit(repoE, ['add', '-A'])
  runGit(repoE, ['commit', '-qm', 'docs: add approved child1 spec'])

  assertOk(runNodeScript(flowE, ['start', '--task', 't-e', '--case', '3', '--slug', 'child1', '--spec', specRel, '--prd', 'docs/prd/261116-issue10-master-prd.md', '--implementer', 'bob'], repoE, env), 'Scenario E flow start')
  assertOk(runNodeScript(flowE, ['explore', '--task', 't-e'], repoE, env), 'Scenario E flow explore')
  const wtE = join(repoE, '.worktrees', 'impl-t-e')
  writeFiles(wtE, { 'src/app.mjs': 'export const app = 2\n' })
  runGit(wtE, ['add', '-A'])
  runGit(wtE, ['commit', '-qm', 'feat: app=2'])

  assertOk(runNodeScript(flowE, ['finalize', '--task', 't-e', '--json'], wtE, env), 'Scenario E finalize')
  if (!existsSync(join(wtE, 'docs/prd/261116-issue10-master-prd.md'))) {
    throw new Error('Scenario E 1:N master PRD was prematurely archived')
  }
  runGit(wtE, ['add', '-A'])
  runGit(wtE, ['commit', '-qm', 'docs: finalize child1'])

  // Negative: quick --target bypass blocked by submit
  assertOk(runNodeScript(flowE, ['verify', '--task', 't-e', '--tier', 'quick', '--target', 'src/app.mjs'], wtE, env), 'Scenario E verify partial')
  assertBlocked(runNodeScript(flowE, ['submit', '--task', 't-e', '--agent', 'bob'], wtE, env), 'BLOCKED_INSUFFICIENT_VERIFICATION_TIER', 'Scenario E quick --target bypass')

  assertOk(runNodeScript(flowE, ['verify', '--task', 't-e', '--mode', 'gate'], wtE, env), 'Scenario E verify gate')
  assertOk(runNodeScript(flowE, ['submit', '--task', 't-e', '--agent', 'bob'], wtE, env), 'Scenario E submit r1')

  // Round 1 changes -> negative same-HEAD rereview -> cross-session --takeover -> negative out-of-scope -> pass
  assertOk(await recordWithToken(flowE, revE, 't-e', repoE, env, ['--round', '1', '--verdict', 'changes', '--reviewer-id', 'rev-1', '--must-fix', 'C1: src/app.mjs:1 adjust']), 'Scenario E record r1')
  const sameHeadToken = await issueTokenFor(repoE, 't-e', 2)
  assertBlocked(runNodeScript(revE, ['record', '--task', 't-e', '--round', '2', '--verdict', 'pass', '--reviewer-id', 'rev-2',
    '--review-token', sameHeadToken, '--evidence', 'E2E 实测：同 HEAD 重审'], repoE, env), 'BLOCKED_SAME_HEAD_REREVIEW', 'Scenario E same-HEAD rereview')

  assertOk(runNodeScript(flowE, ['rework', '--task', 't-e'], wtE, env), 'Scenario E rework')
  writeFiles(wtE, { 'src/app.mjs': 'export const app = 3\n' })
  runGit(wtE, ['add', '-A'])
  runGit(wtE, ['commit', '-qm', 'fix: app=3'])
  assertOk(runNodeScript(flowE, ['finalize', '--task', 't-e', '--json'], wtE, env), 'Scenario E re-finalize')
  assertOk(runNodeScript(flowE, ['verify', '--task', 't-e', '--mode', 'gate'], wtE, env), 'Scenario E verify r2')
  assertBlocked(runNodeScript(flowE, ['submit', '--task', 't-e', '--agent', 'alice'], wtE, env), 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH', 'Scenario E ownership mismatch')
  assertOk(runNodeScript(flowE, ['submit', '--task', 't-e', '--agent', 'bob', '--takeover', '--reason', 'cross-session handoff'], wtE, env), 'Scenario E takeover submit')

  assertBlocked(await recordWithToken(flowE, revE, 't-e', repoE, env, ['--round', '2', '--verdict', 'changes', '--reviewer-id', 'rev-2', '--must-fix', 'C1: src/untouched.mjs:1 out of scope']), 'BLOCKED_OUT_OF_SCOPE_MUST_FIX', 'Scenario E out-of-scope must-fix')
  assertOk(await recordWithToken(flowE, revE, 't-e', repoE, env, ['--round', '2', '--verdict', 'pass', '--reviewer-id', 'rev-2', '--resolved', 'C1']), 'Scenario E record r2 pass')

  const sigFile = join(repoE, '.git', 'project-forge-govern', 'signals.jsonl')
  if (!existsSync(sigFile) || !readFileSync(sigFile, 'utf8').includes('verify.gate.pass')) {
    throw new Error('Scenario E did not auto-write signals.jsonl')
  }
  const retroRes = runNodeScript(govE, ['retro', repoE, '--task', 't-e', '--json'], repoE, env)
  assertOk(retroRes, 'Scenario E retro')
}

async function runScenarioF(pkgRoot, sandbox, env) {
  const repoF = join(sandbox, 'repo-f')
  mkdirSync(repoF, { recursive: true })
  initGitRepo(repoF, {
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# f\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
    'base.mjs': 'export const b = 1\n',
  })
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoF, '--no-backup'], repoF, env), 'Scenario F equip')
  runGit(repoF, ['add', '-A'])
  runGit(repoF, ['commit', '-qm', 'chore: equip'])

  const { resolveRepoRoots } = await import(pathToFileURL(join(pkgRoot, 'kit/skills/lib/shared.mjs')).href)
  const { handleStart } = await import(pathToFileURL(join(pkgRoot, 'kit/skills/dev-flow/scripts/flow-inspect.mjs')).href)
  const roots = await resolveRepoRoots(repoF)
  const depBlock = await handleStart({
    issue: '12', task: 'iss-12',
    _ghProbe: { env: { providerId: 'github', trackB: { tier: 'offline' } }, client: {} },
    knownIssueStates: { 11: { number: 11, state: 'OPEN', title: 'Dep' }, 12: { number: 12, state: 'OPEN', body: 'Depends on #11' } },
  }, roots)
  if (depBlock.exitCode !== 3) throw new Error(`Scenario F expected BLOCKED_UNRESOLVED_DEPENDENCY (exit=3), got ${depBlock.exitCode}`)

  const flowF = join(repoF, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  assertOk(runNodeScript(flowF, ['start', '--task', 'p1', '--case', '2', '--slug', 'parent', '--implementer', 'alice', '--no-issue', '--reason', 'E2E 场景验证父子堆叠分支'], repoF, env), 'Scenario F parent start')
  assertOk(runNodeScript(flowF, ['claim', '--task', 'p1', '--agent', 'alice'], repoF, env), 'Scenario F parent claim')
  assertOk(runNodeScript(flowF, ['explore', '--task', 'p1'], repoF, env), 'Scenario F parent explore')
  const wtP = join(repoF, '.worktrees', 'impl-p1')
  writeFiles(wtP, { 'parent.mjs': 'export const p = 1\n' })
  runGit(wtP, ['add', '-A'])
  runGit(wtP, ['commit', '-qm', 'parent work'])

  assertOk(runNodeScript(flowF, ['start', '--task', 'c1', '--case', '2', '--slug', 'child', '--after', 'p1', '--implementer', 'alice', '--no-issue', '--reason', 'E2E 场景验证堆叠子分支'], repoF, env), 'Scenario F child --after start')
  assertOk(runNodeScript(flowF, ['claim', '--task', 'c1', '--agent', 'alice'], repoF, env), 'Scenario F child claim')
  assertOk(runNodeScript(flowF, ['explore', '--task', 'c1'], repoF, env), 'Scenario F child explore')
  const wtC = join(repoF, '.worktrees', 'impl-c1')
  writeFiles(wtC, { 'child.mjs': 'export const c = 1\n' })
  runGit(wtC, ['add', '-A'])
  runGit(wtC, ['commit', '-qm', 'child work'])
  assertOk(runNodeScript(flowF, ['verify', '--task', 'c1', '--mode', 'quick'], wtC, env), 'Scenario F child verify')
  assertBlocked(runNodeScript(flowF, ['merge', '--task', 'c1'], repoF, env), 'BLOCKED_STACK_PARENT_UNMERGED', 'Scenario F stacked parent unmerged')
}

async function runScenarioG(pkgRoot, sandbox, env) {
  const repoG = join(sandbox, 'repo-g')
  mkdirSync(repoG, { recursive: true })
  initGitRepo(repoG, {
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# g\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\nhigh-risk: none\n```\n',
    'src/a.mjs': 'export const a = 1\n',
    'src/b.mjs': 'export const b = 1\n',
  })
  assertOk(runNodeScript(join(pkgRoot, 'scripts', 'equip.mjs'), [repoG, '--no-backup'], repoG, env), 'Scenario G equip')
  runGit(repoG, ['add', '-A'])
  runGit(repoG, ['commit', '-qm', 'equip skills'])
  const flowG = join(repoG, '.agents', 'skills', 'dev-flow', 'scripts', 'flow.mjs')
  const revG = join(repoG, '.agents', 'skills', 'dev-review', 'scripts', 'review-pack.mjs')

  assertOk(runNodeScript(flowG, ['start', '--task', 'ta', '--case', '2', '--slug', 'ta', '--files', 'src/a.mjs', '--implementer', 'alice', '--no-issue', '--reason', 'E2E 场景验证并行波次调度'], repoG, env), 'Scenario G start ta')
  assertOk(runNodeScript(flowG, ['start', '--task', 'tb', '--case', '2', '--slug', 'tb', '--files', 'src/b.mjs', '--implementer', 'alice', '--no-issue', '--reason', 'E2E 场景验证并行波次调度'], repoG, env), 'Scenario G start tb')
  assertOk(runNodeScript(flowG, ['start', '--task', 'tc', '--case', '2', '--slug', 'tc', '--files', 'src/a.mjs', '--implementer', 'alice', '--no-issue', '--reason', 'E2E 场景验证并行波次调度'], repoG, env), 'Scenario G start tc')
  assertOk(runNodeScript(flowG, ['explore', '--task', 'ta'], repoG, env), 'Scenario G explore ta')
  assertOk(runNodeScript(flowG, ['explore', '--task', 'tb'], repoG, env), 'Scenario G explore tb')
  assertOk(runNodeScript(flowG, ['explore', '--task', 'tc'], repoG, env), 'Scenario G explore tc')

  assertBlocked(runNodeScript(flowG, ['batch', 'check-disjoint', '--tasks', 'ta,tc'], repoG, env), 'BLOCKED_OVERLAPPING_SLICE_FILES', 'Scenario G overlap check')
  const planRes = runNodeScript(flowG, ['batch', 'plan', '--tasks', 'ta,tb,tc', '--json'], repoG, env)
  assertOk(planRes, 'Scenario G batch plan')
  if ((JSON.parse(planRes.stdout).waves?.length ?? 0) < 2) throw new Error(`Scenario G plan did not split conflicting tasks: ${planRes.stdout}`)

  const resSess = runNodeScript(flowG, ['batch', 'resume-session', '--task', 'ta', '--json'], repoG, env)
  assertOk(resSess, 'Scenario G resume-session')
  if (JSON.parse(resSess.stdout).sessionHandle?.epoch !== 1) throw new Error(`Scenario G resume-session epoch error: ${resSess.stdout}`)

  const wtA = join(repoG, '.worktrees', 'impl-ta')
  writeFiles(wtA, { 'src/a.mjs': 'export const a = 2\n' })
  runGit(wtA, ['add', '-A'])
  runGit(wtA, ['commit', '-qm', 'feat: ta'])
  assertOk(runNodeScript(flowG, ['verify', '--task', 'ta', '--mode', 'gate'], wtA, env), 'Scenario G verify ta')
  assertOk(runNodeScript(flowG, ['submit', '--task', 'ta', '--agent', 'alice'], wtA, env), 'Scenario G submit ta')
  assertOk(await recordWithToken(flowG, revG, 'ta', repoG, env, ['--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-g']), 'Scenario G review ta')
  const mq = runNodeScript(flowG, ['batch', 'merge-queue', '--tasks', 'ta', '--json'], repoG, env)
  assertOk(mq, 'Scenario G merge-queue ta')
  if (JSON.parse(mq.stdout).processed?.[0]?.status !== 'merged') throw new Error(`Scenario G merge-queue failed: ${mq.stdout}`)
}

function runScenarioWorkerAsync(scenarioKey, pkgRoot, workerSandbox, seedGitDir) {
  mkdirSync(workerSandbox, { recursive: true })
  return new Promise((resolveDone) => {
    const child = spawn(process.execPath, [
      fileURLToPath(import.meta.url),
      '--worker', scenarioKey,
      '--pkg-root', pkgRoot,
      '--sandbox', workerSandbox,
      '--seed-git', seedGitDir,
      '--backup-dir', join(workerSandbox, 'backups'),
    ], { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    if (child.pid) applyLowPriority(child.pid)
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += String(c) })
    child.stderr.on('data', (c) => { err += String(c) })
    child.on('error', (e) => resolveDone({ scenarioKey, code: 1, out, err: e.message }))
    child.on('close', (code) => resolveDone({ scenarioKey, code: code ?? 1, out, err }))
  })
}

async function runPoolWorkers(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const idx = next++
      results[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return results
}

function parseWorkerArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && argv[i].includes('=')) {
      const eq = argv[i].indexOf('=')
      out[argv[i].slice(2, eq)] = argv[i].slice(eq + 1)
    } else if (argv[i].startsWith('--') && i + 1 < argv.length) {
      out[argv[i].slice(2)] = argv[i + 1]
      i++
    }
  }
  return out
}

function cleanupWithHash(flowScript, task, cwd, env, label) {
  const preview = JSON.parse(runNodeScript(flowScript, ['cleanup', '--task', task, '--json'], cwd, env).stdout)
  if (!preview.previewHash) throw new Error(`${label} missing previewHash`)
  assertOk(runNodeScript(flowScript, ['cleanup', '--task', task, '--confirm', '--preview-hash', preview.previewHash], cwd, env), label)
}

async function runSingleScenario(scenarioKey, pkgRoot, sandbox, env) {
  const helpers = {
    assertOk, assertBlocked, cleanupWithHash, initGitRepo, issueTokenFor, recordWithToken, runGit, runNodeScript, writeFiles,
  }
  if (scenarioKey === 'a-c') {
    const eng = await loadPkgEngines(pkgRoot)
    await runScenarioA(pkgRoot, sandbox, env, eng)
    await runScenarioBAndC(pkgRoot, sandbox, env, eng)
    return
  }
  if (scenarioKey === 'd') return runScenarioD(pkgRoot, sandbox, env)
  if (scenarioKey === 'e') return runScenarioE(pkgRoot, sandbox, env)
  if (scenarioKey === 'f') return runScenarioF(pkgRoot, sandbox, env)
  if (scenarioKey === 'g') return runScenarioG(pkgRoot, sandbox, env)
  if (STAGE_B_SCENARIOS[scenarioKey]) return STAGE_B_SCENARIOS[scenarioKey](pkgRoot, sandbox, env, helpers)
  if (EVOLUTION_SCENARIOS[scenarioKey]) return EVOLUTION_SCENARIOS[scenarioKey](pkgRoot, sandbox, env, helpers)
  throw new Error(`Unknown e2e worker scenario: ${scenarioKey}`)
}

async function main() {
  const workerArgs = parseWorkerArgs(process.argv.slice(2))
  if (workerArgs.worker) {
    applyLowPriority(process.pid)
    try {
      SEEDED_GIT_TEMPLATE = workerArgs['seed-git'] || null
      const env = { PF_BACKUP_DIR: workerArgs['backup-dir'] || join(workerArgs.sandbox, 'backups'), PF_NO_REAL_AUTH_PROBE: '1' }
      await runSingleScenario(workerArgs.worker, workerArgs['pkg-root'], workerArgs.sandbox, env)
      return 0
    } catch (err) {
      process.stderr.write(`FAIL  e2e-zip-harness[${workerArgs.worker}]: ${err instanceof Error ? err.stack || err.message : String(err)}\n`)
      return 1
    }
  }

  const sandbox = mkdtempSync(join(tmpdir(), 'pf-zip-e2e-'))
  const t0 = performance.now()
  try {
    const { pkgRoot, entryCount } = extractRealArchivePackage(sandbox)
    const seedGitDir = ensureSeededGitTemplate(sandbox)
    const scenarioKeys = [
      'a-c', 'd', 'e', 'f', 'g',
      ...Object.keys(STAGE_B_SCENARIOS),
      ...Object.keys(EVOLUTION_SCENARIOS),
    ]
    const rawJobs = workerArgs.jobs ?? null
    const jobs = Math.min(
      resolveWorkerConcurrency({ requestedJobs: rawJobs, cap: rawJobs !== null ? scenarioKeys.length : 6 }),
      scenarioKeys.length,
    )
    const results = await runPoolWorkers(scenarioKeys, jobs, (key) =>
      runScenarioWorkerAsync(key, pkgRoot, join(sandbox, `w-${key}`), seedGitDir))
    const failed = results.filter((r) => r.code !== 0)
    if (failed.length > 0) {
      const detail = failed.map((f) => `[${f.scenarioKey}] exit=${f.code}\n${f.err || f.out}`).join('\n---\n')
      throw new Error(detail)
    }
    const ms = Math.round(performance.now() - t0)
    process.stdout.write(`真 .zip 安装包 Fake-Agent E2E 全通：基础场景 A–G + 生命周期与演化 Scenarios H–L（包条目 ${entryCount}，${jobs} 进程并发，耗时 ${ms} ms）。\n`)
    return 0
  } catch (err) {
    process.stderr.write(`FAIL  e2e-zip-harness: ${err instanceof Error ? err.stack || err.message : String(err)}\n`)
    return 1
  } finally {
    try { rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* ignore */ }
  }
}

main().then((code) => process.exit(code))
