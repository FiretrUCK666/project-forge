/**
 * fixtures-equip.mjs —— 装配夹具：equip 装备与两档升档、compose-agents 装配、backup 快照与 update 原子更新。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { SKILL_ROOT, gitInit, rmTree, runAbsAsync, runNode, survey, tmpProject } from './fixtures-helpers.mjs'
import { KIT_SKILLS, LIGHTWEIGHT_KIT_SKILLS } from '../lib/protocol.mjs'

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
    const cr = await runAbsAsync('scripts/backup.mjs', ['create', dir, '--label', 'snap', '--json'], { env: bkEnv })
    if (cr.status !== 0) return `backup create 失败：${cr.stderr}`
    const crJson = JSON.parse(cr.stdout)
    if (!crJson.created || crJson.count < 4 || !existsSync(crJson.archivePath)) {
      return `快照未成功创建：${cr.stdout}`
    }
    if (!crJson.backupDir.startsWith(backupStore)) return `快照未落入 PF_BACKUP_DIR：${crJson.backupDir}`

    // list 命中快照
    const ls = await runAbsAsync('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv })
    if (ls.status !== 0) return `backup list 失败：${ls.stderr}`
    const lsJson = JSON.parse(ls.stdout)
    if ((lsJson.backups?.length ?? 0) !== 1) return `backup list 计数不对：${ls.stdout}`

    // 2. 篡改原文件 + 删文件 + 制造写后新增孤儿文件，先验证 --dry-run 不落盘
    writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 999\n')
    rmSync(join(dir, 'src/b.mjs'))
    writeFileSync(join(dir, 'src/orphan-extra.mjs'), 'export const extra = 1\n')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub/orphan2.mjs'), 'export const o2 = 1\n')

    const dr = await runAbsAsync('scripts/backup.mjs', ['restore', dir, '--id', 'latest', '--dry-run', '--json'], { env: bkEnv })
    if (dr.status !== 0) return `backup restore dry-run 失败：${dr.stderr}`
    const drJson = JSON.parse(dr.stdout)
    if (!drJson.dryRun || !drJson.removedOrphans.includes('src/orphan-extra.mjs') || !drJson.removedOrphans.includes('sub/orphan2.mjs')) {
      return `dry-run 未识别待清理多余文件：${dr.stdout}`
    }
    if (!existsSync(join(dir, 'src/orphan-extra.mjs')) || existsSync(join(dir, 'src/b.mjs'))) {
      return 'restore --dry-run 竟直接改写了磁盘文件'
    }

    // 3. 真实 restore -> 原文件完好恢复，且多余文件与空目录被彻底清理
    const rs = await runAbsAsync('scripts/backup.mjs', ['restore', dir, '--id', 'latest', '--json'], { env: bkEnv })
    if (rs.status !== 0) return `backup restore 失败：${rs.stderr}`
    if (readFileSync(join(dir, 'src/a.mjs'), 'utf8') !== 'export const a = 1\n') return 'restore 未恢复 src/a.mjs'
    if (readFileSync(join(dir, 'src/b.mjs'), 'utf8') !== 'export const b = 2\n') return 'restore 未恢复 src/b.mjs'
    if (existsSync(join(dir, 'src/orphan-extra.mjs')) || existsSync(join(dir, 'sub/orphan2.mjs')) || existsSync(join(dir, 'sub'))) {
      return `restore 未清理多余文件：${dir}`
    }

    // 4. --no-backup 与幂等空变更跳过
    const bkFilesBeforeNoBk = readdirSync(crJson.backupDir).length
    const caNoBk = await runAbsAsync('scripts/compose-agents.mjs', [dir, '--no-backup'], { env: bkEnv })
    if (caNoBk.status !== 0) return `compose-agents --no-backup 失败：${caNoBk.stderr}`
    if (readdirSync(crJson.backupDir).length !== bkFilesBeforeNoBk) return 'compose-agents --no-backup 仍创建了快照'

    const eq1 = await runAbsAsync('scripts/equip.mjs', [dir], { env: bkEnv })
    if (eq1.status !== 0) return `equip 首次运行失败：${eq1.stderr}`
    const eq1Json = JSON.parse(eq1.stdout).equip
    if (!eq1Json?.backup?.created) return `equip 首次变更未触发写前快照：${eq1.stdout}`

    const eq2 = await runAbsAsync('scripts/equip.mjs', [dir], { env: bkEnv })
    if (eq2.status !== 0) return `equip 二次运行失败：${eq2.stderr}`
    const eq2Json = JSON.parse(eq2.stdout).equip
    if (eq2Json?.backup?.created || eq2Json?.backup?.skippedReason !== 'no-pending-changes') {
      return `equip 无变更二次运行未跳过快照：${eq2.stdout}`
    }

    const agentsFilled = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(dir, 'AGENTS.md'), agentsFilled)
    const caCheck = await runAbsAsync('scripts/compose-agents.mjs', [dir, '--check'], { env: bkEnv })
    if (caCheck.status !== 0) return `compose-agents --check 失败：${caCheck.stderr}`
    const bkCountAfterCheck = JSON.parse((await runAbsAsync('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv })).stdout).backups.length
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
    const c1 = await runAbsAsync('scripts/backup.mjs', ['create', dir, '--label', 'pre-forge', '--json'], { env: bkEnv })
    if (c1.status !== 0) return `pre-forge backup 失败：${c1.stderr}`
    const j1 = JSON.parse(c1.stdout)
    if (!j1.created || !j1.treeSha256) return `首次快照缺少 treeSha256：${c1.stdout}`

    // 工作区未变动时立即再次调用 -> 命中 unchanged-since-latest 且不增加快照数
    const c2 = await runAbsAsync('scripts/backup.mjs', ['create', dir, '--label', 'equip', '--json'], { env: bkEnv })
    if (c2.status !== 0) return `二次去重调用失败：${c2.stderr}`
    const j2 = JSON.parse(c2.stdout)
    if (j2.created || j2.skippedReason !== 'unchanged-since-latest' || j2.id !== j1.id) {
      return `相同工作区二次快照未触发 unchanged-since-latest 去重：${c2.stdout}`
    }

    // 传 --force 必须无视去重写入新快照
    const c3 = await runAbsAsync('scripts/backup.mjs', ['create', dir, '--label', 'equip', '--force', '--json'], { env: bkEnv })
    if (c3.status !== 0) return `--force backup 失败：${c3.stderr}`
    const j3 = JSON.parse(c3.stdout)
    if (!j3.created || j3.id === j1.id) return `--force 未生成新快照：${c3.stdout}`

    // 修改文件内容 -> treeSha256 变化并写入新快照
    writeFileSync(join(dir, 'src/index.mjs'), 'export const v = 2\n')
    const c4 = await runAbsAsync('scripts/backup.mjs', ['create', dir, '--label', 'edit', '--json'], { env: bkEnv })
    if (c4.status !== 0) return `变更后 backup 失败：${c4.stderr}`
    const j4 = JSON.parse(c4.stdout)
    if (!j4.created || !j4.treeSha256 || j4.treeSha256 === j1.treeSha256) {
      return `文件变更后未生成新 treeSha256 快照：${c4.stdout}`
    }

    const ls = JSON.parse((await runAbsAsync('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv })).stdout)
    if ((ls.backups?.length ?? 0) !== 3) return `预期保留 3 份快照，实际：${ls.backups?.length}`
    return true
  } finally {
    rmTree(dir)
    rmTree(backupStore)
  }
}])

cases.push(['equip.mjs + survey.mjs：通用空目录基线、已有 README/LICENSE 兼容、降档保留与 docs/todo 优先探测', async () => {
  const { toMarkdown } = await import('../lib/render.mjs')
  const { computeArtifactPlan } = await import('../survey.mjs')

  const stacks = [
    { stack: undefined, name: 'demo-universal', expectedIgnore: '.worktrees/' },
    { stack: 'node', name: 'demo-node', expectedIgnore: 'node_modules/' },
    { stack: 'python', name: 'demo-py', expectedIgnore: '__pycache__/' },
    { stack: 'go', name: 'demo-go', expectedIgnore: 'coverage.out' },
    { stack: 'rust', name: 'demo-rust', expectedIgnore: 'target/' },
    { stack: 'docs', name: 'demo-docs', expectedIgnore: '_site/' },
  ]
  const dirs = []
  try {
    const stackChecks = await Promise.all(stacks.map(async (item) => {
      const dir = tmpProject({})
      dirs.push(dir)
      const args = [dir, '--bootstrap-empty', '--name', item.name, '--description', `Desc ${item.stack ?? 'universal'}`]
      if (item.stack) args.push('--stack', item.stack)
      const res = await runAbsAsync('scripts/equip.mjs', args)
      if (res.status !== 0) return `bootstrap-empty(${item.stack ?? 'default'}) 失败：${res.stderr}`
      for (const reqRel of ['.gitattributes', '.gitignore', 'README.md', 'docs/TDD.md', 'AGENTS.md', '.agents/skills/.pf-manifest.json']) {
        if (!existsSync(join(dir, reqRel))) return `bootstrap-empty(${item.stack ?? 'default'}) 缺文件：${reqRel}`
      }
      if (!readFileSync(join(dir, '.gitattributes'), 'utf8').includes('* text=auto eol=lf')) {
        return `bootstrap-empty(${item.stack ?? 'default'}) .gitattributes 缺 eol=lf`
      }
      if (!readFileSync(join(dir, '.gitignore'), 'utf8').includes(item.expectedIgnore)) {
        return `bootstrap-empty(${item.stack ?? 'default'}) .gitignore 缺 ${item.expectedIgnore}`
      }
      const readme = readFileSync(join(dir, 'README.md'), 'utf8')
      if (readme.includes('project-forge: fill') || readme.includes('img.shields.io') || readme.includes('greet')) {
        return `bootstrap-empty(${item.stack ?? 'default'}) README 含占位、假徽章或玩具码`
      }
      const tdd = readFileSync(join(dir, 'docs/TDD.md'), 'utf8')
      if (tdd.includes('<待补充>') || !tdd.includes('AGENTS.md') || !tdd.includes('arch-rules: none') || tdd.includes('greet')) {
        return `bootstrap-empty(${item.stack ?? 'default'}) docs/TDD.md 异常：${tdd}`
      }
      return null
    }))
    const stackErr = stackChecks.find(Boolean)
    if (stackErr) return stackErr

    // 1. 首装通用基线后立刻通过 compose-agents --check 与 review.mjs 且保留已有 README/LICENSE/.agents
    const withPresetFiles = tmpProject({
      'README.md': '# Custom Handcrafted README\n\n这是已经写好的项目入口说明文本，确保通过长度检查。\n',
      'LICENSE': 'MIT License\n\nCopyright (c) 2026 Custom Author\n',
      '.agents/skills/keep-me/SKILL.md': '---\nname: keep-me\ndescription: Custom keep skill.\n---\n# keep-me\n',
    })
    dirs.push(withPresetFiles)
    const keepRes = await runAbsAsync('scripts/equip.mjs', [withPresetFiles, '--bootstrap-empty', '--name', 'keep-demo'])
    if (keepRes.status !== 0) return `含 README/LICENSE/.agents 的近空目录拒绝起步：${keepRes.stderr}`
    if (readFileSync(join(withPresetFiles, 'README.md'), 'utf8') !== '# Custom Handcrafted README\n\n这是已经写好的项目入口说明文本，确保通过长度检查。\n') {
      return 'bootstrap-empty 覆盖了既有 README.md'
    }
    if (!readFileSync(join(withPresetFiles, 'LICENSE'), 'utf8').includes('Custom Author')) {
      return 'bootstrap-empty 破坏了既有 LICENSE'
    }
    if (!readFileSync(join(withPresetFiles, '.agents/skills/keep-me/SKILL.md'), 'utf8').includes('Custom keep skill.')) {
      return 'bootstrap-empty 破坏了既有自有技能文件'
    }
    const caChk = await runAbsAsync('scripts/compose-agents.mjs', [withPresetFiles, '--check'])
    if (caChk.status !== 0) return `bootstrap-empty 初装后未立刻过 compose-agents --check：${caChk.stdout}\n${caChk.stderr}`
    const revChk = await runAbsAsync('scripts/review.mjs', [withPresetFiles])
    if (revChk.status !== 0) return `bootstrap-empty 初装后未立刻过 review.mjs：${revChk.stdout}\n${revChk.stderr}`

    // 2. 反面：含源码文件或生态清单的非空目录必须拒绝 --bootstrap-empty
    const nonEmptyDir = tmpProject({ 'src/app.mjs': 'export const app = 1\n' })
    dirs.push(nonEmptyDir)
    const blockRes = await runAbsAsync('scripts/equip.mjs', [nonEmptyDir, '--bootstrap-empty', '--stack', 'node', '--name', 'block-demo'])
    if (blockRes.status === 0) return '存在源码文件的非空目录未拒绝 --bootstrap-empty'
    if (readFileSync(join(nonEmptyDir, 'src/app.mjs'), 'utf8') !== 'export const app = 1\n') {
      return '被拒绝的 --bootstrap-empty 意外修改了既有源码'
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
    const lightSet = new Set(LIGHTWEIGHT_KIT_SKILLS)
    const fullOnlySkills = KIT_SKILLS.filter((s) => !lightSet.has(s))
    const tombSkill = lightSet.has('dev-plan') ? 'dev-plan' : LIGHTWEIGHT_KIT_SKILLS[0]

    // 1. lightweight 档：仅装轻量级技能，AGENTS.md 体积 < 14336 字节
    const eqLight = await runNode('equip.mjs', [dir, '--tier', 'lightweight', '--no-backup'])
    if (eqLight.status !== 0) return `equip lightweight 失败：${eqLight.stderr}`
    if (
      LIGHTWEIGHT_KIT_SKILLS.some((s) => !existsSync(join(dir, `.agents/skills/${s}/SKILL.md`)))
      || fullOnlySkills.some((s) => existsSync(join(dir, `.agents/skills/${s}`)))
    ) {
      return 'lightweight 档未按动态轻量级清单裁剪技能'
    }
    const compLight = await runNode('compose-agents.mjs', [dir, '--tier', 'lightweight', '--no-backup'])
    if (compLight.status !== 0) return `compose lightweight 失败：${compLight.stderr}`
    const lightAgents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const lightBytes = Buffer.byteLength(lightAgents, 'utf8')
    if (lightBytes >= 14336) return `lightweight AGENTS.md 体积过高：${lightBytes}`
    if (fullOnlySkills.some((s) => lightAgents.includes(`.agents/skills/${s}/SKILL.md`))) {
      return 'lightweight 意图路由未过滤仅 full 档技能'
    }

    // 2. 删除技能并写人改内容后升档 full：保留删除墓碑（绝不写回）并无损升档
    rmTree(join(dir, `.agents/skills/${tombSkill}`))
    const eqFull = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
    if (eqFull.status !== 0) return `升档 full 失败：${eqFull.stderr}`
    if (existsSync(join(dir, `.agents/skills/${tombSkill}`))) {
      return `用户主动删除 ${tombSkill} 后 equip 竟将其强行写回（违反墓碑原则）`
    }
    if (fullOnlySkills.some((s) => !existsSync(join(dir, `.agents/skills/${s}/SKILL.md`))) || !existsSync(join(dir, 'docs/specs/.gitkeep'))) {
      return '无损升档 full 未补全 full 技能或 docs/{prd,specs,todo}/.gitkeep'
    }

    // 3. --restore 显式恢复已删核心技能，确保核心套件完好再校验 CRLF 与定制豁免
    const restore = await runNode('equip.mjs', [dir, '--restore', tombSkill, '--no-backup'])
    if (restore.status !== 0 || !existsSync(join(dir, `.agents/skills/${tombSkill}/SKILL.md`))) {
      return `--restore ${tombSkill} 失败：${restore.stderr}`
    }

    // 4. 定制文件写入 CRLF 仍归一等价 -> 手改后 --adopt-custom 使 --check 返回 0
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

cases.push(['M1 zip 读写与 backup 5 缺陷：默认 .zip、i+16 偏移、>20MB 恢复、CRC32 防篡改、./ 前缀与长 UTF-8', async () => {
  const { readZip, writeZip } = await import('../zip.mjs')
  const { createBackup, listBackups, restoreBackup, packTar, unpackTar, truncateUtf8Bytes } = await import('../backup.mjs')

  // 1. writeZip + 非紧邻中央目录 padding（验 i+16 偏移）+ CRC32 篡改拦截
  const zRaw = writeZip([
    { name: 'README.md', data: Buffer.from('# demo\n'), mode: 0o644 },
    { name: 'src/中文路径/hello.mjs', data: Buffer.from('export const x = "你好世界"\n'.repeat(8)), mode: 0o755 },
  ])
  const parsedOk = readZip(zRaw)
  if (parsedOk.length !== 2 || parsedOk[1].name !== 'src/中文路径/hello.mjs') {
    return `writeZip/readZip 往返异常：${JSON.stringify(parsedOk.map((e) => e.name))}`
  }

  // 在中央目录之前插入 16B 填充并修正 EOCD cdOffset（若误用 offset - size 则必坏）
  const eocdAt = zRaw.length - 22
  const origCdOff = zRaw.readUInt32LE(eocdAt + 16)
  const pad = Buffer.alloc(16, 0xaa)
  const paddedZip = Buffer.concat([zRaw.subarray(0, origCdOff), pad, zRaw.subarray(origCdOff)])
  paddedZip.writeUInt32LE(origCdOff + 16, paddedZip.length - 6)
  const parsedPadded = readZip(paddedZip)
  if (parsedPadded.length !== 2) return '非紧邻中央目录未按 EOCD i+16 读取'

  // 篡改中央目录期待 CRC32，验证 readZip 必报错（对应注入 I53）
  const badCrcZip = Buffer.from(zRaw)
  const badCdStart = badCrcZip.readUInt32LE(badCrcZip.length - 6)
  badCrcZip.writeUInt32LE((badCrcZip.readUInt32LE(badCdStart + 16) ^ 0xdeadbeef) >>> 0, badCdStart + 16)
  let crcRejected = false
  try { readZip(badCrcZip) } catch { crcRejected = true }
  if (!crcRejected) return '损坏 CRC32 的 .zip 未被拦截'

  // 2. truncateUtf8Bytes 不劈裂多字节字符 + USTAR ./ 前缀与越界拦截 + COMMON_SKIP_DIRS
  const longZh = '深层中文目录/'.repeat(10) + '测试脚本.mjs'
  const cut = truncateUtf8Bytes(longZh, 95)
  if (cut.length > 95 || cut.toString('utf8').includes('\uFFFD')) {
    return `truncateUtf8Bytes 劈裂了多字节字符：len=${cut.length}`
  }
  const tarDot = packTar([{ relPath: './src/main.mjs', data: Buffer.from('1\n') }, { relPath: longZh, data: Buffer.from('2\n') }])
  const tarRead = unpackTar(tarDot)
  if (tarRead[0].relPath !== 'src/main.mjs' || tarRead[1].relPath !== longZh) {
    return `packTar/unpackTar ./ 或 PAX 长中文处理失败：${JSON.stringify(tarRead.map((f) => f.relPath))}`
  }

  // 3. backup 默认 .zip、向下兼容 .tar.gz、>20MB 整仓恢复及 COMMON_SKIP_DIRS（如 .turbo/.gradle）跳过
  const backupStore = mkdtempSync(join(tmpdir(), 'pf-m1-bk-'))
  const bkEnv = { ...process.env, PF_BACKUP_DIR: backupStore }
  const bigChunk = Buffer.alloc(7 * 1024 * 1024, 66)
  const dir = tmpProject({
    'README.md': '# zip-test\n',
    'a1.bin': bigChunk,
    'a2.bin': bigChunk,
    'a3.bin': bigChunk,
    '.turbo/cache.json': 'skip\n',
    '.gradle/build.bin': 'skip\n',
  })
  try {
    const zipSnap = createBackup(dir, { label: 'zip-def', env: bkEnv })
    if (!zipSnap.created || zipSnap.format !== 'zip' || !zipSnap.archivePath.endsWith('.zip')) {
      return `createBackup 默认不是 .zip：${JSON.stringify(zipSnap)}`
    }
    if (zipSnap.count !== 4) return `COMMON_SKIP_DIRS 未跳过 .turbo/.gradle（count=${zipSnap.count}）`

    writeFileSync(join(dir, 'README.md'), '# mutated\n')
    const gzSnap = createBackup(dir, { label: 'legacy-gz', format: 'tar.gz', env: bkEnv })
    if (!gzSnap.created || !gzSnap.archivePath.endsWith('.tar.gz')) {
      return `显式 --format tar.gz 未生效：${JSON.stringify(gzSnap)}`
    }
    const listed = listBackups(dir, { env: bkEnv })
    if (listed.backups.length !== 2) return `listBackups 数量错误：${listed.backups.length}`

    // 恢复 .zip（总字节 21MB > 20MB 单包默认上限，单文件 7MB < 20MB）
    rmSync(join(dir, 'a3.bin'))
    const rZip = restoreBackup(dir, { id: zipSnap.id, env: bkEnv })
    if (!rZip.ok || !existsSync(join(dir, 'a3.bin')) || readFileSync(join(dir, 'README.md'), 'utf8') !== '# zip-test\n') {
      return `>20MB .zip 快照恢复失败：${JSON.stringify(rZip)}`
    }

    // 向上/向下兼容恢复 .tar.gz 快照
    const rGz = restoreBackup(dir, { id: gzSnap.id, env: bkEnv })
    if (!rGz.ok || readFileSync(join(dir, 'README.md'), 'utf8') !== '# mutated\n') {
      return `兼容恢复 .tar.gz 快照失败：${JSON.stringify(rGz)}`
    }
    return true
  } finally {
    rmTree(dir)
    rmTree(backupStore)
  }
}])

cases.push(['M1 update.mjs 6 项修复：--check 只读、--equip 冷却期刷新、全目录核验回滚、退役清理与用户自建保留、代理与缺 source', async () => {
  const { createServer } = await import('node:http')
  const { applyPackage, download, fallbackSource, resolveStatePath } = await import('../update.mjs')

  // 1. 缺 metadata.source 且无 PF_UPDATE_SOURCE 时 fallbackSource 不隐式回退 UPSTREAM
  const savedSrc = process.env.PF_UPDATE_SOURCE
  delete process.env.PF_UPDATE_SOURCE
  try {
    if (fallbackSource() !== undefined) return `fallbackSource 竟隐式回退到：${fallbackSource()}`
  } finally {
    if (savedSrc !== undefined) process.env.PF_UPDATE_SOURCE = savedSrc
  }

  // 2. applyPackage：verifyInstalled 全目录核验失败原子回滚（连带已删退役文件），同时清理包内退役顶层文件且保留用户自建
  const pkgDir = tmpProject({
    'SKILL.md': '---\nname: project-forge\ndescription: demo skill test\nmetadata:\n  version: "6.0.0"\n---\n# v6\n',
    'references/survey.md': '# old survey\n\n## 何时读本文件\n\nold\n',
    'references/user-custom-guide.md': '# user handwritten note\n',
    'scripts/selftest.mjs': '// known retired top-level script\n',
    'scripts/user-custom-tool.mjs': '// user custom script\n',
    'scripts/update.mjs': '// old\n',
    'templates/agents-project.md': '# old\n',
    'kit/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: old\n---\n',
  })
  const entries = [
    { name: 'SKILL.md', data: Buffer.from('---\nname: project-forge\ndescription: demo skill test\nmetadata:\n  version: "7.0.0"\n---\n# v7\n') },
    { name: 'references/survey.md', data: Buffer.from('# new survey\n\n## 何时读本文件\n\nnew\n') },
    { name: 'scripts/update.mjs', data: Buffer.from('// new update\n') },
    { name: 'templates/agents-project.md', data: Buffer.from('# new tpl\n') },
    { name: 'kit/skills/dev-flow/SKILL.md', data: Buffer.from('---\nname: dev-flow\ndescription: new\n---\n') },
  ]

  // 2a. 模拟 kit/ 文件静默截断，verifyInstalled 在 applyPackage 内拦截并回滚（含恢复 scripts/selftest.mjs）
  const silentTruncateWriter = (dest, buf) => {
    const p = String(dest).replace(/\\/g, '/')
    if (p.endsWith('kit/skills/dev-flow/SKILL.md')) {
      writeFileSync(dest, Buffer.from('truncated'))
      return
    }
    writeFileSync(dest, buf)
  }
  const failVerifyRes = applyPackage(entries, {
    skillRoot: pkgDir,
    expectedVersion: '7.0.0',
    writeFile: silentTruncateWriter,
  })
  if (failVerifyRes.ok !== false || failVerifyRes.rolledBack !== true) {
    return `verifyInstalled 失败未触发回滚：${JSON.stringify(failVerifyRes)}`
  }
  if (!readFileSync(join(pkgDir, 'SKILL.md'), 'utf8').includes('6.0.0') || !existsSync(join(pkgDir, 'scripts/selftest.mjs'))) {
    return 'verifyInstalled 回滚未还原旧 SKILL.md 或未恢复已删退役文件'
  }

  // 2b. 正常更新：清理包内退役顶层 scripts/selftest.mjs，保留用户自建 references/user-custom-guide.md & scripts/user-custom-tool.mjs
  const okApply = applyPackage(entries, { skillRoot: pkgDir, expectedVersion: '7.0.0' })
  if (!okApply.ok) return `正常 applyPackage 失败：${JSON.stringify(okApply)}`
  if (existsSync(join(pkgDir, 'scripts/selftest.mjs'))) return 'applyPackage 未清理已知退役顶层 scripts/selftest.mjs'
  if (!existsSync(join(pkgDir, 'references/user-custom-guide.md')) || !existsSync(join(pkgDir, 'scripts/user-custom-tool.mjs'))) {
    return 'applyPackage 误删了用户自建未托管文件'
  }
  if (!okApply.staleFiles.includes('references/user-custom-guide.md')) {
    return `用户自建文件未留在 staleFiles：${JSON.stringify(okApply.staleFiles)}`
  }

  // 3. 本地代理 HTTP_PROXY & NO_PROXY 验证 + --check 严格只读（支撑 I54）
  let proxyHits = 0
  const proxyServer = createServer((req, res) => {
    if (req.url?.startsWith('http://')) {
      proxyHits += 1
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('via-proxy-ok')
      return
    }
    res.writeHead(404).end()
  })
  const mockGhServer = createServer((req, res) => {
    if (req.url === '/releases/latest') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ tag_name: 'v9.9.9' }))
      return
    }
    res.writeHead(404).end()
  })
  const cacheHome = mkdtempSync(join(tmpdir(), 'pf-upd-cache-'))
  const equipProj = tmpProject({ 'README.md': '# eq\n' })
  const pkgSub = tmpProject({
    'SKILL.md': '---\nname: project-forge\ndescription: demo subpkg\nmetadata:\n  version: "6.0.0"\n  source: "http://127.0.0.1:1"\n---\n# sub\n',
    'zip.mjs': readFileSync(join(SKILL_ROOT, 'scripts/zip.mjs'), 'utf8'),
  })

  try {
    await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r))
    await new Promise((r) => mockGhServer.listen(0, '127.0.0.1', r))
    const pPort = proxyServer.address().port
    const gPort = mockGhServer.address().port

    const proxied = await download('http://proxy-target.invalid/test', { env: { HTTP_PROXY: `http://127.0.0.1:${pPort}` } })
    if (!proxied.ok || proxyHits !== 1 || proxied.body.toString('utf8') !== 'via-proxy-ok') {
      return `HTTP_PROXY 未经代理请求：${JSON.stringify({ proxied, proxyHits })}`
    }

    // 拷贝精简可运行包副本到临时目录验证 update.mjs CLI：--check 只读 + --equip 最新版刷新
    cpSync(join(SKILL_ROOT, 'scripts', 'lib'), join(pkgSub, 'scripts', 'lib'), { recursive: true })
    cpSync(join(SKILL_ROOT, 'kit', 'skills'), join(pkgSub, 'kit', 'skills'), { recursive: true })
    for (const f of ['scripts/update.mjs', 'scripts/zip.mjs', 'scripts/equip.mjs', 'scripts/backup.mjs']) {
      mkdirSync(dirname(join(pkgSub, f)), { recursive: true })
      writeFileSync(join(pkgSub, f), readFileSync(join(SKILL_ROOT, f)))
    }
    writeFileSync(join(pkgSub, 'SKILL.md'), `---\nname: project-forge\ndescription: demo subpkg\nmetadata:\n  version: "6.0.0"\n  source: "http://127.0.0.1:${gPort}"\n---\n# sub\n`)

    const runNodeAsync = (args, env) => new Promise((done) => {
      const child = spawn(process.execPath, [join(pkgSub, 'scripts/update.mjs'), ...args], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      let killFallback = null
      const finish = (status) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killFallback) clearTimeout(killFallback)
        done({
          status: timedOut ? 1 : (status ?? 1),
          stdout,
          stderr: timedOut ? `${stderr}\nupdate.mjs 执行超时 (>45000ms): ${args.join(' ')}` : stderr,
        })
      }
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill('SIGTERM') } catch { /* ignore */ }
        killFallback = setTimeout(() => {
          try { child.kill('SIGKILL') } catch { /* ignore */ }
          finish(1)
        }, 1500)
        killFallback.unref?.()
      }, 45000)
      timer.unref?.()
      child.stdout?.on('data', (c) => { stdout += c })
      child.stderr?.on('data', (c) => { stderr += c })
      child.on('close', (status) => finish(status))
      child.on('error', (err) => { stderr += `\n${err.message}`; finish(1) })
    })
    const isoEnv = { ...process.env, LOCALAPPDATA: cacheHome, XDG_CACHE_HOME: cacheHome, HOME: cacheHome, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '' }
    const chkRun = await runNodeAsync(['--check'], isoEnv)
    if (chkRun.status !== 0 || !chkRun.stdout.includes('9.9.9')) {
      return `update.mjs --check 执行失败：${chkRun.stdout} ${chkRun.stderr}`
    }
    const cacheDirs = [
      join(cacheHome, 'project-forge', 'cache'),
      join(cacheHome, 'project-forge'),
      join(cacheHome, 'Library', 'Caches', 'project-forge'),
      join(cacheHome, '.cache', 'project-forge'),
    ]
    const findStates = (d) => existsSync(d)
      ? readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? findStates(join(d, e.name)) : [join(d, e.name)])
      : []
    const stateFiles = [...new Set([
      ...cacheDirs.flatMap((d) => findStates(d)),
      ...findStates(cacheHome),
    ])].filter((f) => f.endsWith('.json'))
    if (stateFiles.some((sf) => JSON.parse(readFileSync(sf, 'utf8')).lastOkAt > 0)) {
      return 'update.mjs --check 篡改了节流状态'
    }
    void resolveStatePath

    // 同版 --equip：远端回报 9.9.9（已是最新），仍必须刷新 --equip 目标项目
    writeFileSync(join(pkgSub, 'SKILL.md'), `---\nname: project-forge\ndescription: demo subpkg\nmetadata:\n  version: "9.9.9"\n  source: "http://127.0.0.1:${gPort}"\n---\n# sub\n`)
    const eqRun = await runNodeAsync(['--equip', equipProj], isoEnv)
    if (eqRun.status !== 0 || !existsSync(join(equipProj, '.agents/skills/dev-flow/SKILL.md'))) {
      return `最新版时 update.mjs --equip 未刷新目标仓：${eqRun.stdout} ${eqRun.stderr}`
    }
    return true
  } finally {
    proxyServer.closeAllConnections?.()
    mockGhServer.closeAllConnections?.()
    proxyServer.close()
    mockGhServer.close()
    rmTree(pkgDir)
    rmTree(pkgSub)
    rmTree(equipProj)
    rmTree(cacheHome)
  }
}])

}
