/**
 * fixtures-equip.mjs —— 装配夹具：equip 装备与两档升档、compose-agents 装配、backup 快照与 update 原子更新。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'
import { gitInit, rmTree, runAbs, runNode, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerEquipCases(cases) {
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

cases.push(['backup.mjs 快照去重：treeSha256 同内容跳过 unchanged-since-latest、--force 强制与变更重建', async () => {
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

cases.push(['equip.mjs + survey.mjs：五语言空目录闭环、computeArtifactPlan 与 docs/todo 优先探测', async () => {
  const { toMarkdown } = await import('../lib/render.mjs')
  const { computeArtifactPlan } = await import('../survey.mjs')

  const langs = [
    { lang: 'node', name: 'demo-node', expected: ['package.json', 'src/index.mjs', 'test/smoke.test.mjs'], entry: 'src/index.mjs' },
    { lang: 'python', name: 'demo-py', expected: ['pyproject.toml', 'src/demo_py/__init__.py', 'tests/test_smoke.py'], entry: 'src/demo_py/__init__.py' },
    { lang: 'go', name: 'demo-go', expected: ['go.mod', 'hello.go', 'hello_test.go'], entry: 'hello.go' },
    { lang: 'rust', name: 'demo-rust', expected: ['Cargo.toml', 'src/lib.rs'], entry: 'src/lib.rs' },
    { lang: 'docs', name: 'demo-docs', expected: ['docs/guide.md'], entry: 'README.md' },
  ]
  const dirs = []
  try {
    for (const item of langs) {
      const dir = tmpProject({})
      dirs.push(dir)
      const res = runAbs('scripts/equip.mjs', [dir, '--bootstrap-empty', '--lang', item.lang, '--name', item.name, '--description', `Desc ${item.lang}`])
      if (res.status !== 0) return `bootstrap-empty(${item.lang}) 失败：${res.stderr}`
      for (const reqRel of ['.gitattributes', '.gitignore', 'README.md', 'docs/TDD.md', ...item.expected]) {
        if (!existsSync(join(dir, reqRel))) return `bootstrap-empty(${item.lang}) 缺文件：${reqRel}`
      }
      if (!readFileSync(join(dir, '.gitattributes'), 'utf8').includes('* text=auto eol=lf')) {
        return `bootstrap-empty(${item.lang}) .gitattributes 缺 eol=lf`
      }
      if (!readFileSync(join(dir, '.gitignore'), 'utf8').includes('.worktrees/')) {
        return `bootstrap-empty(${item.lang}) .gitignore 缺 .worktrees/`
      }
      const readme = readFileSync(join(dir, 'README.md'), 'utf8')
      if (readme.includes('project-forge: fill') || readme.includes('img.shields.io')) {
        return `bootstrap-empty(${item.lang}) README 含占位或假徽章`
      }
      const tdd = readFileSync(join(dir, 'docs/TDD.md'), 'utf8')
      if (tdd.includes('<待补充>') || !tdd.includes(item.entry) || !tdd.includes('arch-rules: none')) {
        return `bootstrap-empty(${item.lang}) docs/TDD.md 未填实：${tdd}`
      }
      if (item.lang === 'node') {
        const nt = spawnSync(process.execPath, ['--test'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
        if (nt.status !== 0) return `bootstrap-empty(node) 单测未过：${nt.stderr || nt.stdout}`
      }
      if (item.lang === 'python') {
        const pyBin = ['python3', 'python'].find((b) => spawnSync(b, ['--version'], { stdio: 'ignore' }).status === 0)
        if (pyBin) {
          const pt = spawnSync(pyBin, ['-m', 'unittest', 'discover', '-s', 'tests'], { cwd: dir, encoding: 'utf8', timeout: 30000 })
          if (pt.status !== 0) return `bootstrap-empty(python) unittest 未过：${pt.stderr || pt.stdout}`
        }
      }
      if (item.lang === 'node' || item.lang === 'python') {
        const sBoot = await survey(dir)
        if ((sBoot.reentry?.staleTddPaths?.length ?? 0) > 0) {
          return `bootstrap-empty(${item.lang}) TDD 存在失效路径：${JSON.stringify(sBoot.reentry.staleTddPaths)}`
        }
      }
    }

    // 反面与保护：已有 .agents 自有技能时允许起步且保留；已有 README.md 时拒绝执行且不覆盖
    const withCustomAgentDir = tmpProject({
      '.agents/skills/keep-me/SKILL.md': '---\nname: keep-me\ndescription: Custom keep skill.\n---\n# keep-me\n',
    })
    dirs.push(withCustomAgentDir)
    const keepRes = runAbs('scripts/equip.mjs', [withCustomAgentDir, '--bootstrap-empty', '--lang', 'node', '--name', 'keep-demo'])
    if (keepRes.status !== 0) return `含 .agents 自有技能的空目录拒绝起步：${keepRes.stderr}`
    if (!readFileSync(join(withCustomAgentDir, '.agents/skills/keep-me/SKILL.md'), 'utf8').includes('Custom keep skill.')) {
      return 'bootstrap-empty 破坏了既有自有技能文件'
    }

    const nonEmptyDir = tmpProject({ 'README.md': '# Custom Handcrafted README\n' })
    dirs.push(nonEmptyDir)
    const blockRes = runAbs('scripts/equip.mjs', [nonEmptyDir, '--bootstrap-empty', '--lang', 'node', '--name', 'block-demo'])
    if (blockRes.status === 0) return '非空目录存在 README.md 时未拒绝 --bootstrap-empty'
    if (readFileSync(join(nonEmptyDir, 'README.md'), 'utf8') !== '# Custom Handcrafted README\n') {
      return '被拒绝的 --bootstrap-empty 意外修改了既有 README.md'
    }

    // computeArtifactPlan 空白仓 vs 异构存量仓 + docs/todo 优先于 docs/work
    const blankDir = tmpProject({})
    dirs.push(blankDir)
    const sBlank = await survey(blankDir)
    const blankPlan = Object.fromEntries((sBlank.artifactPlan ?? []).map((x) => [x.id, x]))
    if (blankPlan['pre-backup']?.action !== 'skip' || blankPlan['docs-tdd']?.action !== 'skip' || blankPlan['agents-contract']?.action !== 'skip') {
      return `空白仓 artifactPlan 不符：${JSON.stringify(sBlank.artifactPlan)}`
    }

    const heteroDir = tmpProject({
      '.gitattributes': '* text=auto eol=lf\n',
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': '{"name":"hetero","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'src/index.mjs': 'export const ok = true\n',
      'README.md': '# Custom Legacy README\n',
      'CONTRIBUTING.md': '# Contributing\n',
      'LICENSE': 'Dual License (MIT OR Apache-2.0)\n',
      'docs/TDD.md': '# TDD\n\n入口 `src/index.mjs`。\n',
      'docs/todo/261114-item.md': '# Todo\n',
      '.agents/skills/custom-ops/SKILL.md': '---\nname: custom-ops\ndescription: Custom ops skill.\n---\n# custom-ops\n',
      '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs: {}\n',
    })
    dirs.push(heteroDir)
    gitInit(heteroDir)
    const sHetero = await survey(heteroDir)
    if (sHetero.conventions?.workDir !== 'docs/todo') {
      return `存在 docs/todo 时 workDir 未优先选用 docs/todo：${sHetero.conventions?.workDir}`
    }
    const planMap = Object.fromEntries((sHetero.artifactPlan ?? []).map((x) => [x.id, x]))
    if (planMap.readme?.action !== 'preserve') {
      return `computeArtifactPlan 未将已有 README 标为 preserve：${JSON.stringify(planMap.readme)}`
    }
    if (planMap['pre-backup']?.action !== 'snapshot' || planMap.contributing?.action !== 'preserve' || planMap.license?.action !== 'preserve') {
      return `异构存量仓 artifactPlan 关键动作错误：${JSON.stringify(sHetero.artifactPlan)}`
    }
    if (planMap['kit-skills']?.action !== 'equip' || !planMap['kit-skills'].detail.includes('custom-ops')) {
      return `kit-skills 处置计划未提示保留自有技能：${JSON.stringify(planMap['kit-skills'])}`
    }
    const purePlan = computeArtifactPlan(sHetero)
    if ((purePlan?.length ?? 0) < 10) return 'computeArtifactPlan 导出项数不足 10 项'
    const mdHetero = toMarkdown(sHetero)
    if (!mdHetero.includes('## 逐项处置计划') || !mdHetero.includes('preserve')) {
      return `render.mjs 未输出逐项处置计划表格：\n${mdHetero}`
    }

    const legacyWorkDir = tmpProject({ 'README.md': '# legacy\n', 'docs/work/01-task.md': '# Task\n' })
    dirs.push(legacyWorkDir)
    const sLegacy = await survey(legacyWorkDir)
    if (sLegacy.conventions?.workDir !== 'docs/work') {
      return `仅存在存量 docs/work 时未兼容保留：${sLegacy.conventions?.workDir}`
    }

    return true
  } finally {
    for (const d of dirs) rmTree(d)
  }
}])

cases.push(['两档装配（lightweight/full）无损升档、manifest v2 删除墓碑与 --adopt-custom 绿灯', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"tier-demo","version":"1.0.0","scripts":{"test":"node --test"}}\n',
    'README.md': '# tier-demo\n\n两档渐进装配与 manifest v2 测试仓。\n',
    'src/index.mjs': 'export const ok = true\n',
  })
  gitInit(dir)
  try {
    // 1. lightweight 档：仅装 3 个核心技能，AGENTS.md 体积 < 16384 字节
    const eqLight = await runNode('equip.mjs', [dir, '--tier', 'lightweight', '--no-backup'])
    if (eqLight.status !== 0) return `equip lightweight 失败：${eqLight.stderr}`
    if (existsSync(join(dir, '.agents/skills/dev-review')) || !existsSync(join(dir, '.agents/skills/dev-flow/SKILL.md'))) {
      return 'lightweight 档未按 LIGHTWEIGHT_KIT_SKILLS 裁剪技能'
    }
    const compLight = await runNode('compose-agents.mjs', [dir, '--tier', 'lightweight', '--no-backup'])
    if (compLight.status !== 0) return `compose lightweight 失败：${compLight.stderr}`
    const lightAgents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const lightBytes = Buffer.byteLength(lightAgents, 'utf8')
    if (lightBytes >= 16384) return `lightweight AGENTS.md 体积过高：${lightBytes}`
    if (lightAgents.includes('.agents/skills/dev-review/SKILL.md')) {
      return 'lightweight 意图路由未过滤未装配的 dev-review'
    }

    // 2. 删除技能并写人改内容后升档 full：保留删除墓碑（绝不写回）并无损升档
    rmTree(join(dir, '.agents/skills/dev-plan'))
    const eqFull = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
    if (eqFull.status !== 0) return `升档 full 失败：${eqFull.stderr}`
    if (existsSync(join(dir, '.agents/skills/dev-plan'))) {
      return '用户主动删除 dev-plan 后 equip 竟将其强行写回（违反墓碑原则）'
    }
    if (!existsSync(join(dir, '.agents/skills/dev-review/SKILL.md')) || !existsSync(join(dir, 'docs/specs/.gitkeep'))) {
      return '无损升档 full 未补全 dev-review 与 docs/{prd,specs,todo}/.gitkeep'
    }

    // 3. 定制文件写入 CRLF 仍归一等价 -> 手改后 --adopt-custom 使 --check 返回 0
    const targetFlowSkill = join(dir, '.agents/skills/dev-flow/SKILL.md')
    const origFlow = readFileSync(targetFlowSkill, 'utf8')
    writeFileSync(targetFlowSkill, origFlow.replace(/\n/g, '\r\n'))
    const crlfCheck = await runNode('equip.mjs', [dir, '--check'])
    if (crlfCheck.status !== 0) return `CRLF/LF 归一等价校验误报漂移：${crlfCheck.stdout || crlfCheck.stderr}`

    writeFileSync(targetFlowSkill, `${origFlow}\n<!-- custom user note -->\n`)
    const driftBefore = await runNode('equip.mjs', [dir, '--check'])
    if (driftBefore.status === 0) return '未登记定制修改时 --check 却返回 0'

    const adopt = await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-flow/SKILL.md', '--no-backup'])
    if (adopt.status !== 0) return `--adopt-custom 失败：${adopt.stderr}`
    const checkAfter = await runNode('equip.mjs', [dir, '--check'])
    if (checkAfter.status !== 0 || !checkAfter.stdout.includes('定制豁免：dev-flow/SKILL.md')) {
      return `--adopt-custom 后 --check 未返回 0 或未列出定制豁免：status=${checkAfter.status} out=${checkAfter.stdout} err=${checkAfter.stderr}`
    }
    const { checkEquip } = await import('../equip.mjs')
    const chkStruct = checkEquip(dir)
    if (!chkStruct.ok || !chkStruct.customized?.some((c) => c.path === 'dev-flow/SKILL.md')) {
      return `checkEquip 结构校验未列出 customized：${JSON.stringify(chkStruct)}`
    }

    // 4. --restore 显式恢复已删技能
    const restore = await runNode('equip.mjs', [dir, '--restore', 'dev-plan', '--no-backup'])
    if (restore.status !== 0 || !existsSync(join(dir, '.agents/skills/dev-plan/SKILL.md'))) {
      return `--restore dev-plan 失败：${restore.stderr}`
    }

    // 5. backup.mjs 滚动淘汰时永久钉住最新 pre-forge 基线快照
    const { createBackup, listBackups } = await import('../backup.mjs')
    await createBackup(dir, { label: 'pre-forge' })
    for (let i = 1; i <= 6; i += 1) {
      writeFileSync(join(dir, 'src/index.mjs'), `export const ok = ${i}\n`)
      await createBackup(dir, { label: `equip-${i}` })
    }
    const kept = listBackups(dir).backups ?? []
    if (!kept.some((b) => b.label === 'pre-forge')) {
      return `backup 滚动清理挤出了 pre-forge 基线快照：${JSON.stringify(kept.map((b) => b.label))}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['update.mjs 同盘 staging 原子更新（中断回滚保留旧 SKILL.md）、全深度清退役与 15m 冷却', async () => {
  const {
    FAILURE_COOLDOWN_MS, applyPackage, readState, rememberState, resolveStatePath,
  } = await import('../update.mjs')
  const { PF_MANIFEST_SCHEMA_VERSION } = await import('../lib/protocol.mjs')
  if (PF_MANIFEST_SCHEMA_VERSION !== 2) return `PF_MANIFEST_SCHEMA_VERSION=${PF_MANIFEST_SCHEMA_VERSION}`
  if (FAILURE_COOLDOWN_MS !== 15 * 60 * 1000) return `FAILURE_COOLDOWN_MS=${FAILURE_COOLDOWN_MS}`

  // 1. applyPackage 写 kit/ 失败时：必须回滚并保留旧 SKILL.md 与旧文件内容
  const skillCopy = tmpProject({
    'SKILL.md': '---\nname: project-forge\ndescription: demo skill\nmetadata:\n  version: "5.0.0"\n---\n\n# old\n',
    'references/survey.md': '# old survey\n\n## 何时读本文件\n\nold\n',
    'templates/agents-project.md': '# old tpl\n',
    'scripts/update.mjs': '// old update\n',
    'scripts/lib/retired-old.mjs': '// retired deep lib\n',
    'kit/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: old\n---\n',
    'kit/skills/dev-flow/scripts/retired-ghost.mjs': '// retired deep kit\n',
  })
  const cwdShadow = tmpProject({ 'package.json': '{"name":"innocent","version":"1.0.0"}' })
  try {
    const newEntries = [
      { name: 'SKILL.md', data: Buffer.from('---\nname: project-forge\ndescription: demo skill\nmetadata:\n  version: "6.0.0"\n---\n\n# new\n') },
      { name: 'references/survey.md', data: Buffer.from('# new survey\n\n## 何时读本文件\n\nnew\n') },
      { name: 'templates/agents-project.md', data: Buffer.from('# new tpl\n') },
      { name: 'scripts/update.mjs', data: Buffer.from('// new update\n') },
      { name: 'kit/skills/dev-flow/SKILL.md', data: Buffer.from('---\nname: dev-flow\ndescription: new\n---\n') },
    ]

    // 故障注入模拟 Windows EPERM：写到 kit/ 时抛出权限异常
    const failWrite = (dest, buf) => {
      if (String(dest).replace(/\\/g, '/').includes('kit/skills/')) {
        const e = new Error('EPERM: operation not permitted')
        e.code = 'EPERM'
        throw e
      }
      writeFileSync(dest, buf)
    }
    const failRes = applyPackage(newEntries, {
      skillRoot: skillCopy,
      expectedVersion: '6.0.0',
      writeFile: failWrite,
    })
    if (failRes.ok !== false || failRes.rolledBack !== true) {
      return `write 失败未回滚：${JSON.stringify(failRes)}`
    }
    const afterFailSkill = readFileSync(join(skillCopy, 'SKILL.md'), 'utf8')
    if (!afterFailSkill.includes('5.0.0')) {
      return `中断回滚后 SKILL.md 版本被篡改：${afterFailSkill}`
    }
    if (!readFileSync(join(skillCopy, 'references/survey.md'), 'utf8').includes('# old survey')) {
      return '回滚未还原已写入的 references/survey.md'
    }

    // 2. 正常完成 applyPackage：最后写入 SKILL.md、深层清理退役文件、且不越界写入 process.cwd()
    const okRes = applyPackage(newEntries, {
      skillRoot: skillCopy,
      expectedVersion: '6.0.0',
    })
    if (!okRes.ok) return `applyPackage 正常更新失败：${JSON.stringify(okRes)}`
    if (!readFileSync(join(skillCopy, 'SKILL.md'), 'utf8').includes('6.0.0')) {
      return '正常更新后 SKILL.md 未升至 6.0.0'
    }
    if (existsSync(join(skillCopy, 'scripts/lib/retired-old.mjs')) || existsSync(join(skillCopy, 'kit/skills/dev-flow/scripts/retired-ghost.mjs'))) {
      return 'applyPackage 未递归清理 scripts/lib/** 与 kit/skills/** 退役文件'
    }
    if (existsSync(join(cwdShadow, '.agents'))) {
      return 'update.mjs 越界向当前 cwd 写入了 .agents/'
    }

    // 3. readState 未来时间戳自愈 + FAILURE_COOLDOWN_MS 状态
    const stateFile = resolveStatePath(skillCopy)
    rememberState({ checkedAt: Date.now() + 99999999, lastFailAt: Date.now() + 99999999 }, skillCopy)
    const healed = readState(skillCopy)
    if ((healed.checkedAt ?? 0) > Date.now() || (healed.lastFailAt ?? 0) > Date.now()) {
      return `未来时间戳未自愈：${JSON.stringify(healed)} (stateFile=${stateFile})`
    }
    return true
  } finally {
    rmTree(skillCopy)
    rmTree(cwdShadow)
  }
}])

}
