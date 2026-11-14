import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitInit, loadPreflight,
  readDirRefs, rmTree, runAbs, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'

export function registerV5WaveCases(cases) {
cases.push(['backup.mjs + equip/compose-agents：写前快照创建、恢复防污染清理多余文件、dry-run 与空变更跳过', async () => {
  const backupStore = mkdtempSync(join(tmpdir(), 'pf-bk-'))
  const bkEnv = { ...process.env, PF_BACKUP_DIR: backupStore }
  const dir = tmpProject({
    'package.json': '{"name":"bk-demo","version":"1.0.0"}\n',
    'README.md': '# bk-demo\n\n备份测试项目。\n',
    'src/a.mjs': 'export const a = 1\n',
    'src/b.mjs': 'export const b = 2\n',
  })

  try {
    // 1. 直接创建快照 -> 落在 PF_BACKUP_DIR 下且项目目录不被污染
    const cr = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'snap', '--json'], { env: bkEnv })
    if (cr.status !== 0) return `backup create 失败：${cr.stderr}`
    const crJson = JSON.parse(cr.stdout)
    if (!crJson.created || crJson.count < 4 || !existsSync(crJson.archivePath)) {
      return `快照未成功创建：${cr.stdout}`
    }
    if (!crJson.backupDir.startsWith(backupStore)) return `快照未落入 PF_BACKUP_DIR：${crJson.backupDir}`

    // list 命中快照
    const ls = runAbs('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv })
    if (ls.status !== 0) return `backup list 失败：${ls.stderr}`
    const lsJson = JSON.parse(ls.stdout)
    if ((lsJson.backups?.length ?? 0) !== 1) return `backup list 计数不对：${ls.stdout}`

    // 2. 篡改原文件 + 删文件 + 制造写后新增孤儿文件，先验证 --dry-run 不落盘
    writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 999\n')
    rmSync(join(dir, 'src/b.mjs'))
    writeFileSync(join(dir, 'src/orphan-extra.mjs'), 'export const extra = 1\n')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub/orphan2.mjs'), 'export const o2 = 1\n')

    const dr = runAbs('scripts/backup.mjs', ['restore', dir, '--id', 'latest', '--dry-run', '--json'], { env: bkEnv })
    if (dr.status !== 0) return `backup restore dry-run 失败：${dr.stderr}`
    const drJson = JSON.parse(dr.stdout)
    if (!drJson.dryRun || !drJson.removedOrphans.includes('src/orphan-extra.mjs') || !drJson.removedOrphans.includes('sub/orphan2.mjs')) {
      return `dry-run 未识别待清理多余文件：${dr.stdout}`
    }
    if (!existsSync(join(dir, 'src/orphan-extra.mjs')) || existsSync(join(dir, 'src/b.mjs'))) {
      return 'restore --dry-run 竟直接改写了磁盘文件'
    }

    // 3. 真实 restore -> 原文件完好恢复，且多余文件与空目录被彻底清理
    const rs = runAbs('scripts/backup.mjs', ['restore', dir, '--id', 'latest', '--json'], { env: bkEnv })
    if (rs.status !== 0) return `backup restore 失败：${rs.stderr}`
    if (readFileSync(join(dir, 'src/a.mjs'), 'utf8') !== 'export const a = 1\n') return 'restore 未恢复 src/a.mjs'
    if (readFileSync(join(dir, 'src/b.mjs'), 'utf8') !== 'export const b = 2\n') return 'restore 未恢复 src/b.mjs'
    if (existsSync(join(dir, 'src/orphan-extra.mjs')) || existsSync(join(dir, 'sub/orphan2.mjs')) || existsSync(join(dir, 'sub'))) {
      return `restore 未清理多余文件：${dir}`
    }

    // 4. --no-backup 与幂等空变更跳过
    const bkFilesBeforeNoBk = readdirSync(crJson.backupDir).length
    const caNoBk = runAbs('scripts/compose-agents.mjs', [dir, '--no-backup'], { env: bkEnv })
    if (caNoBk.status !== 0) return `compose-agents --no-backup 失败：${caNoBk.stderr}`
    if (readdirSync(crJson.backupDir).length !== bkFilesBeforeNoBk) return 'compose-agents --no-backup 仍创建了快照'

    const eq1 = runAbs('scripts/equip.mjs', [dir], { env: bkEnv })
    if (eq1.status !== 0) return `equip 首次运行失败：${eq1.stderr}`
    const eq1Json = JSON.parse(eq1.stdout).equip
    if (!eq1Json?.backup?.created) return `equip 首次变更未触发写前快照：${eq1.stdout}`

    const eq2 = runAbs('scripts/equip.mjs', [dir], { env: bkEnv })
    if (eq2.status !== 0) return `equip 二次运行失败：${eq2.stderr}`
    const eq2Json = JSON.parse(eq2.stdout).equip
    if (eq2Json?.backup?.created || eq2Json?.backup?.skippedReason !== 'no-pending-changes') {
      return `equip 无变更二次运行未跳过快照：${eq2.stdout}`
    }

    const agentsFilled = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(dir, 'AGENTS.md'), agentsFilled)
    const caCheck = runAbs('scripts/compose-agents.mjs', [dir, '--check'], { env: bkEnv })
    if (caCheck.status !== 0) return `compose-agents --check 失败：${caCheck.stderr}`
    const bkCountAfterCheck = JSON.parse(runAbs('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv }).stdout).backups.length
    if (bkCountAfterCheck !== 2) return `--check 只读检查意外生成了快照：count=${bkCountAfterCheck}`

    // 5. 纯路径断言：无 .git 且未设 PF_BACKUP_DIR 时仍回退到 ~/.project-forge/backups/
    const { resolveBackupDir } = await import('../backup.mjs')
    const fallbackDir = resolveBackupDir(dir, { env: {} })
    const expectedHomeBackups = join(homedir(), '.project-forge', 'backups')
    if (!fallbackDir.startsWith(`${expectedHomeBackups}${sep}`) || !basename(fallbackDir).startsWith(`${basename(dir).toLowerCase()}-`)) {
      return `未设 PF_BACKUP_DIR 且无 .git 时 resolveBackupDir 未回退到 ~/.project-forge/backups/：${fallbackDir}`
    }

    return true
  } finally {
    rmTree(dir)
    rmTree(backupStore)
  }
}])

cases.push(['repo-map.mjs Wave 2 扩展：CI run、Makefile/justfile、reusableModules、Feature Map 正反双向', async () => {
  const posDir = tmpProject({
    '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
    Makefile: 'check:\n\tnode --test\n',
    justfile: 'lint:\n\techo ok\n',
    'AGENTS.md': '# demo\n\n```yaml\nquick-test: node --test\nsmoke-verify: node src/cli.mjs --smoke\n```\n',
    'package.json': '{"name":"rmap-pos","version":"1.0.0","main":"src/cli.mjs"}\n',
    'src/utils.mjs': 'export function helper() { return 1 }\n',
    'src/cli.mjs': 'import { helper } from "./utils.mjs"\nconsole.log(helper())\n',
    'test/cli.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n',
  })
  const negDir = tmpProject({
    'README.md': '# plain\n',
    'src/index.mjs': 'export const x = 1\n',
  })

  try {
    const pos = runAbs('kit/skills/dev-explore/scripts/repo-map.mjs', [posDir, '--json'])
    if (pos.status !== 0) return `repo-map 正面运行失败：${pos.stderr}`
    const pj = JSON.parse(pos.stdout)
    if (!pj.ciRunSteps?.some((s) => s.command.includes('npm test'))) return `未提取 CI run 步骤：${JSON.stringify(pj.ciRunSteps)}`
    if (!pj.taskRunners?.makefile?.includes('check') || !pj.taskRunners?.justfile?.includes('lint')) {
      return `未提取 Makefile/justfile 目标：${JSON.stringify(pj.taskRunners)}`
    }
    if (pj.devProfile?.smokeVerify !== 'node src/cli.mjs --smoke') return `未读取 smoke-verify：${pj.devProfile?.smokeVerify}`
    if (!pj.preferredVerifyCommands?.some((c) => c.role === 'smoke-verify')) {
      return `preferredVerifyCommands 缺少 smoke-verify：${JSON.stringify(pj.preferredVerifyCommands)}`
    }
    if (!pj.reusableModules?.some((m) => m.file === 'src/utils.mjs' && m.exports.includes('helper'))) {
      return `未提取可复用模块 src/utils.mjs：${JSON.stringify(pj.reusableModules)}`
    }
    if ((pj.featureMap?.length ?? 0) === 0) return 'featureMap 为空'

    const neg = runAbs('kit/skills/dev-explore/scripts/repo-map.mjs', [negDir, '--json'])
    if (neg.status !== 0) return `repo-map 反面运行失败：${neg.stderr}`
    const nj = JSON.parse(neg.stdout)
    if ((nj.ciRunSteps?.length ?? 0) !== 0 || (nj.taskRunners?.makefile?.length ?? 0) !== 0 || (nj.taskRunners?.justfile?.length ?? 0) !== 0) {
      return `无 CI/Makefile/justfile 项目误报提取结果：${neg.stdout}`
    }
    if (nj.devProfile?.smokeVerify !== null) return `无 AGENTS.md 项目误报 smokeVerify：${nj.devProfile?.smokeVerify}`
    return true
  } finally {
    rmTree(posDir)
    rmTree(negDir)
  }
}])

cases.push(['doc-plan.mjs Wave 2 契约：critiqueTier 分级、audit 防幻觉与占位拦截、critique-pass 防篡改、approve 与豁免', async () => {
  const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-plan.mjs')
  const t3 = triageTask({ summary: 'add export flag', files: 2 })
  const t4 = triageTask({ summary: 'alter contract schema', touchesContract: true })
  if (t3.critiqueTier !== 'self-audit') return `Case 3 critiqueTier 错误：${t3.critiqueTier}`
  if (t4.critiqueTier !== 'independent-critique') return `Case 4 critiqueTier 错误：${t4.critiqueTier}`

  const dir = tmpProject({
    'src/real.mjs': 'export const ok = 1\n',
    'docs/specs/bad.md': [
      '# Bad Spec',
      '- Status: draft',
      '',
      '修改 `src/ghost.mjs` 与 `<target>`。',
    ].join('\n'),
    'docs/specs/good.md': [
      '# Good Spec',
      '- Status: draft',
      '- Plan Critique: pending',
      '',
      '改动 `src/real.mjs` 与 `src/planned.mjs` (new)。',
      '',
      '## 本期不做',
      '',
      '- 不修改外部公共 CLI。',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：two-way，直接 `git revert` 即可回滚。',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: `node src/real.mjs` 退出码为 0。',
      '',
    ].join('\n'),
    'docs/specs/exempt.md': [
      '# Exempt Spec',
      '- Status: draft',
      '- Plan Critique: pending',
      '',
      '修改 `src/real.mjs`。',
      '',
      '## 本期不做',
      '',
      '- 不改其他模块。',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：two-way，可回退。',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: 验证通过。',
      '',
    ].join('\n'),
  })

  try {
    // 1. 坏 SPEC audit 与 approve 必须阻断
    const badAudit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/specs/bad.md', '--json'], { cwd: dir })
    if (badAudit.status === 0) return '缺陷 SPEC 的 audit 竟通过了'
    const badJson = JSON.parse(badAudit.stdout)
    const codes = new Set(badJson.errors.map((e) => e.code))
    for (const req of ['UNRESOLVED_ANGLE_PLACEHOLDER', 'HALLUCINATED_PATH', 'MISSING_NON_GOALS', 'MISSING_DOOR_OR_ROLLBACK', 'MISSING_ACCEPTANCE_CRITERIA']) {
      if (!codes.has(req)) return `坏 SPEC audit 漏报 ${req}：${badAudit.stdout}`
    }
    const badApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/bad.md'], { cwd: dir })
    if (badApprove.status === 0 || !/BLOCKED_AUDIT_FAILED/.test(badApprove.stderr)) {
      return `未通过 audit 的 SPEC 竟被 approve 放行：${badApprove.stderr}`
    }

    // 2. 好 SPEC audit 放行，但未 critique-pass 不允许直接 approve
    const goodAudit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/specs/good.md', '--json'], { cwd: dir })
    if (goodAudit.status !== 0) return `合规 SPEC audit 误杀：${goodAudit.stdout}\n${goodAudit.stderr}`

    const noCritApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md'], { cwd: dir })
    if (noCritApprove.status === 0 || !/BLOCKED_CRITIQUE_REQUIRED/.test(noCritApprove.stderr)) {
      return `未 critique-pass 的 SPEC 竟被 approve 放行：exit=${noCritApprove.status} stderr=${noCritApprove.stderr}`
    }

    // 3. critique-pass 后篡改正文 -> BLOCKED_CRITIQUE_STALE
    const crit1 = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/good.md', '--reviewer', 'indep-r1', '--round', '1', '--json'], { cwd: dir })
    if (crit1.status !== 0) return `critique-pass 失败：${crit1.stderr}`

    const goodAbs = join(dir, 'docs/specs/good.md')
    writeFileSync(goodAbs, readFileSync(goodAbs, 'utf8') + '\n- 事后偷偷追加的范围\n')
    const staleApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md'], { cwd: dir })
    if (staleApprove.status === 0 || !/BLOCKED_CRITIQUE_STALE/.test(staleApprove.stderr)) {
      return `critique-pass 后篡改正文未拦截：exit=${staleApprove.status} stderr=${staleApprove.stderr}`
    }

    // 4. 重审并 approve 成功；另测 --skip-critique-reason 豁免
    const crit2 = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/good.md', '--reviewer', 'indep-r1', '--round', '2', '--json'], { cwd: dir })
    if (crit2.status !== 0) return `二次 critique-pass 失败：${crit2.stderr}`
    const okApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md', '--json'], { cwd: dir })
    if (okApprove.status !== 0 || JSON.parse(okApprove.stdout).status !== 'approved') {
      return `复核后 approve 失败：${okApprove.stderr}`
    }

    const exApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/exempt.md', '--skip-critique-reason', 'emergency-fix', '--json'], { cwd: dir })
    if (exApprove.status !== 0 || !JSON.parse(exApprove.stdout).critiqueSkipped) {
      return `--skip-critique-reason 豁免失败：${exApprove.stderr}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['flow.mjs Wave 2 契约：smoke --target 替换与缺参阻断、门禁弱化阻断与人工豁免、干净增量测试放行', async () => {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': [
      '# flow-w2',
      '',
      '```yaml',
      'quick-test: node -e "process.exit(0)"',
      'smoke-verify: node scripts/smoke.mjs --file {target}',
      'high-risk: none',
      '```',
      '',
    ].join('\n'),
    'package.json': '{"name":"flow-w2","version":"1.0.0"}\n',
    'scripts/smoke.mjs': 'import { existsSync } from "node:fs"\nconst f = process.argv[process.argv.indexOf("--file") + 1]\nif (!existsSync(f)) process.exit(2)\n',
    'src/ok.mjs': 'export const ok = 1\n',
    'test/ok.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\nassert.equal(2, 2)\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })

  try {
    // 1. smoke --target 缺参 / 元字符阻断 / 正常替换
    const s1 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-w2', '--case', '1', '--slug', 'w2-gate', '--json'], { cwd: dir })
    if (s1.status !== 0) return `start t-w2 失败：${s1.stderr}`

    const missTarget = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke'], { cwd: dir })
    if (missTarget.status === 0 || !/MISSING_TARGET_ARG/.test(missTarget.stderr)) {
      return `smoke 缺 --target 未拦截：${missTarget.stderr}`
    }
    const badTarget = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke', '--target', 'a;echo'], { cwd: dir })
    if (badTarget.status === 0 || !/INVALID_TARGET_ARG/.test(badTarget.stderr)) {
      return `smoke 非法元字符 --target 未拦截：${badTarget.stderr}`
    }
    const okSmoke = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke', '--target', 'src/ok.mjs', '--json'], { cwd: dir })
    if (okSmoke.status !== 0) return `smoke --target src/ok.mjs 失败：${okSmoke.stderr}`
    if (!JSON.parse(okSmoke.stdout).cmd.includes('src/ok.mjs')) return `smoke 未替换 {target}：${okSmoke.stdout}`

    // 2. 删减测试断言（门禁弱化）-> verify 后 merge 必须 exit 4 (BLOCKED_GATE_WEAKENING)
    writeFileSync(join(dir, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'weaken test'], { cwd: dir, stdio: 'ignore' })

    const vWeak = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--cmd', 'node -e "process.exit(0)"'], { cwd: dir })
    if (vWeak.status !== 0) return `verify 失败：${vWeak.stderr}`

    const mGate = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2', '--json'], { cwd: dir })
    if (mGate.status !== 4) return `门禁弱化改动未被 merge 拦截：exit=${mGate.status} out=${mGate.stdout} err=${mGate.stderr}`
    if (JSON.parse(mGate.stdout).code !== 'BLOCKED_GATE_WEAKENING') return `缺少 BLOCKED_GATE_WEAKENING：${mGate.stdout}`

    // 3. 人工豁免 --human-approved 放行并入 main
    const mApproved = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2', '--human-approved', '--json'], { cwd: dir })
    if (mApproved.status !== 0 || JSON.parse(mApproved.stdout).status !== 'merged') {
      return `--human-approved merge 失败：exit=${mApproved.status} out=${mApproved.stdout} err=${mApproved.stderr}`
    }

    // 4. 反面证伪：新增测试断言（非弱化）无 --human-approved 直接合并放行
    const s2 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-w2-clean', '--case', '1', '--slug', 'w2-clean', '--json'], { cwd: dir })
    if (s2.status !== 0) return `start t-w2-clean 失败：${s2.stderr}`
    writeFileSync(join(dir, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\nassert.equal(3, 3)\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'add assertion'], { cwd: dir, stdio: 'ignore' })
    runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2-clean', '--cmd', 'node -e "process.exit(0)"'], { cwd: dir })
    const mClean = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2-clean', '--json'], { cwd: dir })
    if (mClean.status !== 0) return `正常增量测试被 merge 误杀为门禁弱化：exit=${mClean.status} out=${mClean.stdout} err=${mClean.stderr}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['review-pack.mjs Wave 2 扩展：双轨门禁、arch-rules、tombstone/excuse 检出与 two-way/one-way 误伤防线', async () => {
  const dir = tmpProject({
    'AGENTS.md': [
      '# rev-w2',
      '',
      '```yaml',
      'smoke-verify: node -e "process.exit(0)"',
      'arch-rules: src/ui/** -> src/db/**',
      '```',
      '',
    ].join('\n'),
    'src/db/conn.mjs': 'export const query = () => []\n',
    'src/shared/fmt.mjs': 'export const fmt = (v) => String(v)\n',
    'src/ui/good.mjs': 'import { fmt } from "../shared/fmt.mjs"\nexport const render = (v) => fmt(v)\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })

  try {
    // 1. 正向干净改动（正常注释 + 合法跨模块引用）-> structural clean & two-way & behavioral smokeRequired
    writeFileSync(join(dir, 'src/ui/good.mjs'), '// Format user value safely\nimport { fmt } from "../shared/fmt.mjs"\nexport const render = (v) => fmt(v)\n')
    const pClean = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--json'], { cwd: dir })
    if (pClean.status !== 0) return `review-pack --local 干净改动失败：${pClean.stderr}`
    const cj = JSON.parse(pClean.stdout)
    if (!cj.behavioralGate?.smokeRequired || !cj.behavioralGate.runtimeFilesTouched.includes('src/ui/good.mjs')) {
      return `behavioralGate 未识别运行时改动与 smoke-verify：${JSON.stringify(cj.behavioralGate)}`
    }
    if ((cj.structuralGate?.archViolations?.length ?? 0) !== 0 || (cj.structuralGate?.excuseSuppressions?.length ?? 0) !== 0 || (cj.structuralGate?.tombstoneComments?.length ?? 0) !== 0) {
      return `干净改动被 structuralGate 误报：${JSON.stringify(cj.structuralGate)}`
    }
    if (cj.doorAssessment?.doorType !== 'two-way' || cj.doorAssessment?.mergeAuthority !== 'reviewer-direct') {
      return `普通改动门型误判：${JSON.stringify(cj.doorAssessment)}`
    }

    // 2. 越界依赖 + 墓碑注释 + excuse suppression + workflow 改动 -> attention-required + one-way
    writeFileSync(join(dir, 'src/ui/bad.mjs'), [
      '// 以前是同步调用，后来改成异步查询',
      '// eslint-disable-next-line no-unused-vars',
      'import { query } from "../db/conn.mjs"',
      'export const load = () => query()',
    ].join('\n'))
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n')

    const pBad = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--json'], { cwd: dir })
    if (pBad.status !== 0) return `review-pack --local 坏改动运行失败：${pBad.stderr}`
    const bj = JSON.parse(pBad.stdout)
    if ((bj.structuralGate?.archViolations?.length ?? 0) < 1) return `未检出 arch-rules 违例：${JSON.stringify(bj.structuralGate)}`
    if ((bj.structuralGate?.tombstoneComments?.length ?? 0) < 1) return `未检出墓碑注释：${JSON.stringify(bj.structuralGate)}`
    if ((bj.structuralGate?.excuseSuppressions?.length ?? 0) < 1) return `未检出 excuse suppression：${JSON.stringify(bj.structuralGate)}`
    if (bj.structuralGate?.status !== 'attention-required') return `structuralGate 状态不对：${bj.structuralGate?.status}`
    if (bj.doorAssessment?.doorType !== 'one-way' || bj.doorAssessment?.mergeAuthority !== 'human-required') {
      return `CI workflow 改动未判为 one-way + human-required：${JSON.stringify(bj.doorAssessment)}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['govern-audit.mjs Wave 2 扩展：fence-aware 死链接、注释死代码、上帝文件、arch-rules、4 态 worktree 与 record/cluster/sample', async () => {
  const godLines = Array.from({ length: 820 }, (_, i) => `export const k${i} = ${i}`).join('\n') + '\n'
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# gov-w2\n\n```yaml\narch-rules: src/ui/** -> src/db/**\n```\n',
    'README.md': '# gov-w2\n',
    'docs/TDD.md': '# TDD\n',
    'docs/guide.md': [
      '# Guide',
      '',
      '```markdown',
      '[in-fence](docs/nonexistent-in-fence.md)',
      '```',
      '',
      'Inline code `[in-code](docs/nonexistent-inline.md)` should pass.',
      '',
      'Real broken [real-dead](docs/actually-missing.md).',
    ].join('\n'),
    'src/db/db.mjs': 'export const db = 1\n',
    'src/ui/view.mjs': [
      '// normal header note line 1',
      '// normal header note line 2',
      '// normal header note line 3',
      '// normal header note line 4',
      '// normal prose comment without code',
      '// line two prose comment',
      '// line three prose comment',
      '// line four prose comment',
      'import { db } from "../db/db.mjs"',
      'export const view = () => db',
      '// const deadA = 1;',
      '// if (deadA > 0) {',
      '//   return deadA;',
      '// }',
    ].join('\n'),
    'src/big.mjs': godLines,
    'src/hot.mjs': 'export const h = 0\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })

  const wtMerged = join(dir, '.worktrees', 'wt-merged')
  const wtSquash = join(dir, '.worktrees', 'wt-squash')
  const wtNoOwn = join(dir, '.worktrees', 'wt-no-own')
  const wtUnmerged = join(dir, '.worktrees', 'wt-unmerged')

  try {
    // 构造 4 态 worktree + 1 个 Revert 与 3 次高频修改提交给 sample
    spawnSync('git', ['checkout', '-qb', 'wt-merged'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(dir, 'src/merged.mjs'), 'export const m = 1\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'merged commit'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['merge', '--no-ff', 'wt-merged', '-qm', 'merge wt-merged'], { cwd: dir, stdio: 'ignore' })

    spawnSync('git', ['checkout', '-qb', 'wt-squash'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(dir, 'src/sq.mjs'), 'export const sq = 1\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'squash feat'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['merge', '--squash', '-q', 'wt-squash'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'squash feat onto main'], { cwd: dir, stdio: 'ignore' })

    for (let k = 1; k <= 3; k += 1) {
      writeFileSync(join(dir, 'src/hot.mjs'), `export const h = ${k}\n`)
      spawnSync('git', ['add', 'src/hot.mjs'], { cwd: dir, stdio: 'ignore' })
      spawnSync('git', ['commit', '-qm', `touch hot ${k}`], { cwd: dir, stdio: 'ignore' })
    }
    writeFileSync(join(dir, 'src/hot.mjs'), 'export const h = 2\n')
    spawnSync('git', ['add', 'src/hot.mjs'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'Revert "touch hot 3"'], { cwd: dir, stdio: 'ignore' })

    spawnSync('git', ['branch', 'wt-no-own', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['branch', 'wt-unmerged', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['worktree', 'add', '-q', wtMerged, 'wt-merged'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['worktree', 'add', '-q', wtSquash, 'wt-squash'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['worktree', 'add', '-q', wtNoOwn, 'wt-no-own'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(wtNoOwn, 'wip.txt'), 'uncommitted note\n')
    spawnSync('git', ['worktree', 'add', '-q', wtUnmerged, 'wt-unmerged'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(wtUnmerged, 'src/unmerged.mjs'), 'export const u = 1\n')
    spawnSync('git', ['add', '-A'], { cwd: wtUnmerged, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'unique unmerged commit'], { cwd: wtUnmerged, stdio: 'ignore' })

    // 1. reconcile（4 态 worktree）+ audit 全类别扫描验证
    const rec = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['reconcile', dir, '--json'])
    if (rec.status !== 0) return `govern-audit reconcile 失败：${rec.stderr}`
    const rj = JSON.parse(rec.stdout)

    const aud = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--json'])
    if (aud.status !== 0) return `govern-audit audit 失败：${aud.stderr}`
    const aj = JSON.parse(aud.stdout)
    const ids = aj.findings.map((f) => f.id)
    if (ids.some((id) => id.includes('nonexistent-in-fence') || id.includes('nonexistent-inline'))) {
      return `围栏代码块内相对链接被误判为死链接：${JSON.stringify(ids)}`
    }
    if (!ids.some((id) => id.includes('actually-missing.md'))) return `真实死链接未被检出：${JSON.stringify(ids)}`
    if (!ids.some((id) => id.startsWith('deadcode.commented-block.src/ui/view.mjs:11'))) {
      return `注释死代码块未检出或把普通注释误报了：${JSON.stringify(ids)}`
    }
    if (ids.some((id) => id.startsWith('deadcode.commented-block.src/ui/view.mjs:5'))) {
      return `普通自然语言注释块被误判为死代码：${JSON.stringify(ids)}`
    }
    if (!ids.includes('hygiene.god-file.src/big.mjs')) return `上帝文件未检出：${JSON.stringify(ids)}`
    if (!ids.some((id) => id.startsWith('hygiene.arch-boundary.src/ui/view.mjs:'))) {
      return `arch-rules 边界违例未检出：${JSON.stringify(ids)}`
    }

    const wc = rj.reconcileSummary?.worktrees?.counts ?? {}
    if (wc.merged !== 1 || wc.squash_or_rebase_merged !== 1 || wc.no_own_commits !== 1 || wc.unmerged !== 1) {
      return `worktree 四态识别数量有误：${JSON.stringify(rj.reconcileSummary?.worktrees)}`
    }

    // 2. record -> cluster -> sample
    const r1 = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['record', dir, '--module', 'src/ui', '--pattern', 'arch-boundary', '--message', 'direct db import', '--json'])
    if (r1.status !== 0 || JSON.parse(r1.stdout).ruleSinkCandidate !== false) return `首次 record 判据有误：${r1.stdout}`
    const r2 = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['record', dir, '--module', 'src/ui', '--pattern', 'arch-boundary', '--message', 'second db import', '--json'])
    if (r2.status !== 0 || JSON.parse(r2.stdout).ruleSinkCandidate !== true || JSON.parse(r2.stdout).modulePatternCount !== 2) {
      return `二次 record 未触发下沉候选：${r2.stdout}`
    }

    const cl = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['cluster', dir, '--signals-only', '--json'])
    if (cl.status !== 0) return `cluster 失败：${cl.stderr}`
    const clj = JSON.parse(cl.stdout)
    if ((clj.cluster?.sinkCandidateCount ?? 0) < 1) return `cluster 未识别下沉候选：${cl.stdout}`

    const smp = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['sample', dir, '--commits', '20', '--json'])
    if (smp.status !== 0) return `sample 失败：${smp.stderr}`
    const sj = JSON.parse(smp.stdout)
    if (sj.revertCount < 1 || !sj.reworkHotspots?.some((h) => h.file === 'src/hot.mjs')) {
      return `sample 未识别 Revert 与 48h 高频返工热点：${smp.stdout}`
    }
    return true
  } finally {
    for (const wt of [wtMerged, wtSquash, wtNoOwn, wtUnmerged]) {
      spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir, stdio: 'ignore' })
    }
    rmTree(dir)
  }
}])

cases.push(['backup.mjs Wave 3 去重：treeSha256 同内容跳过 unchanged-since-latest、--force 强制与变更重建', async () => {
  const backupStore = mkdtempSync(join(tmpdir(), 'pf-bk3-'))
  const bkEnv = { ...process.env, PF_BACKUP_DIR: backupStore }
  const dir = tmpProject({
    'package.json': '{"name":"bk-w3","version":"1.0.0"}\n',
    'src/index.mjs': 'export const v = 1\n',
  })

  try {
    const c1 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'pre-forge', '--json'], { env: bkEnv })
    if (c1.status !== 0) return `pre-forge backup 失败：${c1.stderr}`
    const j1 = JSON.parse(c1.stdout)
    if (!j1.created || !j1.treeSha256) return `首次快照缺少 treeSha256：${c1.stdout}`

    // 工作区未变动时立即再次调用 -> 命中 unchanged-since-latest 且不增加快照数
    const c2 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'equip', '--json'], { env: bkEnv })
    if (c2.status !== 0) return `二次去重调用失败：${c2.stderr}`
    const j2 = JSON.parse(c2.stdout)
    if (j2.created || j2.skippedReason !== 'unchanged-since-latest' || j2.id !== j1.id) {
      return `相同工作区二次快照未触发 unchanged-since-latest 去重：${c2.stdout}`
    }

    // 传 --force 必须无视去重写入新快照
    const c3 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'equip', '--force', '--json'], { env: bkEnv })
    if (c3.status !== 0) return `--force backup 失败：${c3.stderr}`
    const j3 = JSON.parse(c3.stdout)
    if (!j3.created || j3.id === j1.id) return `--force 未生成新快照：${c3.stdout}`

    // 修改文件内容 -> treeSha256 变化并写入新快照
    writeFileSync(join(dir, 'src/index.mjs'), 'export const v = 2\n')
    const c4 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'edit', '--json'], { env: bkEnv })
    if (c4.status !== 0) return `变更后 backup 失败：${c4.stderr}`
    const j4 = JSON.parse(c4.stdout)
    if (!j4.created || !j4.treeSha256 || j4.treeSha256 === j1.treeSha256) {
      return `文件变更后未生成新 treeSha256 快照：${c4.stdout}`
    }

    const ls = JSON.parse(runAbs('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv }).stdout)
    if ((ls.backups?.length ?? 0) !== 3) return `预期保留 3 份快照，实际：${ls.backups?.length}`
    return true
  } finally {
    rmTree(dir)
    rmTree(backupStore)
  }
}])

cases.push(['claims.mjs + review.mjs Wave 3：dirs 并入 claim.path、claim.script 核对与零误报防线', async () => {
  const { claimsOf, verifyClaims } = await import('../lib/claims.mjs')
  const { reviewProject } = await import('../review.mjs')

  const dir = tmpProject({
    'package.json': JSON.stringify({
      name: 'claims-w3',
      version: '1.0.0',
      scripts: { test: 'node --test', lint: 'echo ok' },
    }),
    'README.md': '# claims-w3\n\n测试契约脚本与目录前缀核对的仓库说明。\n',
    'docs/TDD.md': '# TDD\n',
    'src/core/app.mjs': 'export const app = 1\n',
    'AGENTS.md': [
      '# claims-w3',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: npm test',
      'full-test: npm run nonexistent-full',
      'high-risk: src/core/, src/payments/, src/legacy/**, .github/workflows/, none',
      'do-not-edit: docs/missing-archive/, .worktrees/',
      '```',
      '',
      '## 环境与构建验证',
      '',
      '```sh',
      'npm run lint',
      'pnpm run nonexistent-check',
      'npm test # 注释里带 npm run <placeholder> 不应提取',
      '```',
      '',
      '## 高风险路径',
      '',
      '| 路径 | 原因 |',
      '| --- | --- |',
      '| `src/core/` | 核心目录存在 |',
      '| `src/removed-dir/` | 已删除目录 |',
      '',
    ].join('\n'),
  })
  gitInit(dir)

  try {
    const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const c = claimsOf(agentsText)
    for (const expectedDir of ['src/core/', 'src/payments/', 'src/removed-dir/', 'docs/missing-archive/']) {
      if (!c.dirs.includes(expectedDir)) return `claimsOf 未提取目录前缀 ${expectedDir}：${JSON.stringify(c.dirs)}`
    }
    if (c.dirs.some((d) => d.includes('legacy') || d.includes('.github') || d.includes('.worktrees'))) {
      return `claimsOf 误把通配符或可选设施列入 dirs：${JSON.stringify(c.dirs)}`
    }
    for (const expectedScript of ['test', 'lint', 'nonexistent-full', 'nonexistent-check']) {
      if (!c.scripts.includes(expectedScript)) return `claimsOf 未提取脚本 ${expectedScript}：${JSON.stringify(c.scripts)}`
    }
    if (c.scripts.some((s) => s.includes('placeholder'))) return `claimsOf 误从注释提取脚本：${JSON.stringify(c.scripts)}`

    const rev = await reviewProject(dir)
    const missingIds = new Set(rev.missing.map((f) => f.id))
    if (!missingIds.has('claim.path')) return `review.mjs 未把失效目录前缀报进 claim.path：${JSON.stringify([...missingIds])}`
    if (!missingIds.has('claim.script')) return `review.mjs 未拦截失效 package.json 脚本：${JSON.stringify([...missingIds])}`

    // 反面防误报：无 packageScripts 时不输出假绿也不误报；本仓自身 0 缺失项
    const noPkgClaims = verifyClaims(agentsText, { conventions: { defaultBranch: 'main' }, ecosystem: {} }, () => true)
    if (noPkgClaims.some((x) => x.id === 'claim.script')) {
      return `无 package.json 脚本清单时不应产生 claim.script 条目：${JSON.stringify(noPkgClaims)}`
    }
    const selfRev = await reviewProject(SKILL_ROOT)
    if (selfRev.missing.length > 0) return `本仓库自身 review 存在误报缺失项：${JSON.stringify(selfRev.missing)}`
    return true
  } finally {
    rmTree(dir)
  }
}])

}
