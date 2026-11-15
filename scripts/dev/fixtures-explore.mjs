/**
 * fixtures-explore.mjs —— 勘察夹具：repo-map 的命令与可复用模块提取、survey 的重入漂移与探索策略分级。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gitInit, gitSync, rmTree, runAbsAsync, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerExploreCases(cases) {
cases.push(['repo-map.mjs：CI run、Makefile/justfile、reusableModules、Feature Map 正反双向', async () => {
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
    const pos = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', [posDir, '--json'])
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

    const neg = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', [negDir, '--json'])
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

cases.push(['8 层深 Java+React repo-map、Dev Profile 显式 none 与未知 flag/冲突态拦截', async () => {
  const { resolveAvailableSkills } = await import('../../kit/skills/lib/cli.mjs')
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# doc-only-or-poly\n\n## Dev Profile\n\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
    'README.md': '# poly\n',
    '.github/workflows/ci.yml': [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  be:',
      '    defaults:',
      '      run:',
      '        working-directory: backend',
      '    steps:',
      '      - run: |',
      '          if [ -f pom.xml ]; then',
      '            mvn test',
      '          fi',
    ].join('\n'),
    'backend/pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
    'backend/src/main/java/com/acme/deep/nested/svc/core/App.java': 'public class App {}\n',
    'backend/src/test/java/com/acme/deep/nested/svc/core/AppTest.java': 'import org.junit.jupiter.api.Test; class AppTest { @Test void ok() {} }\n',
    'frontend/package.json': '{"name":"fe","scripts":{"test":"vitest"}}\n',
    'frontend/src/App.tsx': 'export const App = () => null\n',
    '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
  })
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
  try {
    // 1. 8 层深 Java + 前端分离 repo-map，保留 working-directory 与多行 if/fi
    const mapRes = await runAbsAsync('kit/skills/dev-explore/scripts/repo-map.mjs', [dir, '--json'])
    if (mapRes.status !== 0) return `repo-map 失败：${mapRes.stderr}`
    const mj = JSON.parse(mapRes.stdout)
    if (!mj.testFiles?.some((f) => f.includes('AppTest.java'))
      || !mj.packages?.some((p) => p.dirRel === 'backend')
      || !mj.packages?.some((p) => p.dirRel === 'frontend')
      || (mj.codeFileCount ?? 0) < 3) {
      return `repo-map 漏掉深层 Java 或前端源码：${JSON.stringify({ codeFileCount: mj.codeFileCount, testFiles: mj.testFiles, packages: mj.packages })}`
    }
    if (!mj.ciRunSteps?.some((s) => s.workingDirectory === 'backend' && s.command.includes('if [ -f pom.xml ]; then'))) {
      return `repo-map 未保留 CI working-directory 或多行 if/fi：${JSON.stringify(mj.ciRunSteps)}`
    }

    // 2. 未知 flag 报错退出 2；resolveAvailableSkills 感知缺失技能
    const badFlag = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['inspect', '--no-such-flag', dir])
    if (badFlag.status !== 2) return `未知 flag 未退出 2：status=${badFlag.status}`
    const avail = resolveAvailableSkills(dir)
    if (!avail.has('dev-flow') || avail.has('dev-review')) return `resolveAvailableSkills 探测错误：${avail.skills}`

    // 3. Dev Profile 显式 none -> flow verify 与 submit 正常放行 + status/abort 可用
    const st = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-none', '--case', '1', '--slug', 'none-ok', '--json'], { cwd: dir })
    if (st.status !== 0) return `start 失败：${st.stderr}`
    const ver = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--json'], { cwd: dir })
    if (ver.status !== 0) return `Dev Profile quick-test: none 时 verify 失败：${ver.stderr}`
    const sub = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--json'], { cwd: dir })
    if (sub.status !== 0) return `submit 失败：${sub.stderr}`
    const stat = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['status', '--json'], { cwd: dir })
    if (stat.status !== 0 || JSON.parse(stat.stdout).taskId !== 't-none') return `status 自动推断失败：${stat.stdout}`

    // 4. MERGE_HEAD 冲突态自动阻断 verify 与 review-pack
    const tNoneWtRel = JSON.parse(st.stdout).worktreePath
    const tNoneRoot = tNoneWtRel ? resolve(dir, tNoneWtRel) : dir
    const wtMergeRel = gitSync(tNoneRoot, ['rev-parse', '--git-path', 'MERGE_HEAD'], { encoding: 'utf8' }).stdout.trim()
    const wtMergeHeadAbs = resolve(tNoneRoot, wtMergeRel)
    writeFileSync(wtMergeHeadAbs, '0'.repeat(40) + '\n')
    writeFileSync(join(dir, '.git', 'MERGE_HEAD'), '0'.repeat(40) + '\n')
    const verConflict = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify'], { cwd: dir })
    const revConflict = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--local'], { cwd: dir })
    rmTree(wtMergeHeadAbs)
    rmTree(join(dir, '.git', 'MERGE_HEAD'))
    if (verConflict.status === 0 || !/BLOCKED_GIT_CONFLICT_IN_PROGRESS/.test(verConflict.stderr)) {
      return `MERGE_HEAD 未阻断 verify：${verConflict.stderr}`
    }
    if (revConflict.status === 0 || !/BLOCKED_GIT_CONFLICT_IN_PROGRESS/.test(revConflict.stderr)) {
      return `MERGE_HEAD 未阻断 review-pack：${revConflict.stderr}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['survey.mjs + compose-agents.mjs：自有技能共存路由、reentry 漂移校准、explorationStrategy 与纯本地非 GitHub 提示', async () => {
  const { toMarkdown } = await import('../lib/render.mjs')
  const { FORBIDDEN_PLATFORM_RE } = await import('../lib/protocol.mjs')
  const { equip } = await import('../equip.mjs')

  // 1. 自有扩展技能（.agents/skills + .claude/skills）自动进入 AGENTS.md 意图路由且与 --check / equip 共存
  const customDir = tmpProject({
    'package.json': JSON.stringify({ name: 'custom-sk', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# custom-sk\n\n自有扩展技能并存与重入测试项目。\n',
    'src/app.mjs': 'export const ok = 1\n',
    '.agents/skills/my-billing/SKILL.md': [
      '---',
      'name: my-billing',
      'description: Reconcile invoices and ledger entries cleanly. Ignore second sentence details.',
      '---',
      '# my-billing',
    ].join('\n'),
    '.claude/skills/deploy-guard/SKILL.md': [
      '---',
      'name: deploy-guard',
      'description: Pre-deploy verification checklist for production releases',
      '---',
      '# deploy-guard',
    ].join('\n'),
  })
  gitInit(customDir)

  // 2. 跨月重入漂移仓（AGENTS 失效路径+脚本、TDD 失效路径、未登记 src/new-module、非 GitHub 远端）
  const reentryDir = tmpProject({
    'package.json': JSON.stringify({ name: 'reentry-demo', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# reentry-demo\n\n跨月重入校准与非 GitHub 远端导航测试仓。\n',
    'src/existing.mjs': 'export const e = 1\n',
    'src/new-module/service.mjs': 'export const s = 2\n',
    'docs/TDD.md': [
      '# TDD',
      '',
      '现有模块 `src/existing.mjs`，已删源码 `src/deleted-tdd.mjs`。',
      '未来规划示例 `docs/future/plan.md` 与外链 `https://example.com/a.js` 不应误报。',
    ].join('\n'),
    'AGENTS.md': [
      '# reentry-demo',
      '',
      '## Dev Profile',
      '```yaml',
      'quick-test: npm test',
      'full-test: npm run removed-script',
      '```',
      '',
      '## 架构',
      '核心文件：`src/existing.mjs`、`src/old/deleted.mjs`。',
    ].join('\n'),
  })
  gitInit(reentryDir, { origin: 'https://code.example.org/org/reentry-demo.git' })

  // 3. 空目录与小型干净仓 vs 大仓（> 80 代码文件）explorationStrategy 分级
  const emptyDir = tmpProject({})
  const smallCleanDir = tmpProject({
    'package.json': JSON.stringify({ name: 'small-clean', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# small-clean\n\n小型干净单仓。\n',
    'src/only.mjs': 'export const a = 1\n',
  })
  gitInit(smallCleanDir)
  const largeFiles = { 'README.md': '# large-repo\n\n大仓多文件分片探索测试。\n', 'package.json': '{"name":"large-repo","version":"1.0.0"}\n' }
  for (let i = 0; i < 85; i += 1) largeFiles[`src/m${i}.mjs`] = `export const v${i} = ${i}\n`
  const largeDir = tmpProject(largeFiles)

  try {
    // 验证自有技能装配、渲染共存与卸载恢复
    equip(customDir, { noBackup: true })
    const gen1 = await runAbsAsync('scripts/compose-agents.mjs', [customDir, '--no-backup'])
    if (gen1.status !== 0) return `compose-agents customDir 失败：${gen1.stderr}`
    const filledCustom = readFileSync(join(customDir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(customDir, 'AGENTS.md'), filledCustom)

    const agentsCustom = readFileSync(join(customDir, 'AGENTS.md'), 'utf8')
    if (!agentsCustom.includes('### 项目自有技能（自动识别，与上方研发流并存）') || !agentsCustom.includes('.agents/skills/my-billing/SKILL.md') || !agentsCustom.includes('.claude/skills/deploy-guard/SKILL.md')) {
      return `AGENTS.md 未包含项目自有扩展技能路由块：\n${agentsCustom.slice(0, 1200)}`
    }
    const chkCustom = await runAbsAsync('scripts/compose-agents.mjs', [customDir, '--check'])
    if (chkCustom.status !== 0) return `含自有技能的 AGENTS.md --check 失败：${chkCustom.stderr}`

    const sCustom = await survey(customDir)
    if ((sCustom.kit?.customSkills?.length ?? 0) !== 2 || !sCustom.kit.customSkills.some((s) => s.name === 'my-billing' && s.summary)) {
      return `survey customSkills 识别不对：${JSON.stringify(sCustom.kit?.customSkills)}`
    }

    // 删掉自有技能 -> 重跑 compose-agents 后自有技能区块消失
    rmTree(join(customDir, '.agents/skills/my-billing'))
    rmTree(join(customDir, '.claude/skills/deploy-guard'))
    await runAbsAsync('scripts/compose-agents.mjs', [customDir, '--no-backup'])
    if (readFileSync(join(customDir, 'AGENTS.md'), 'utf8').includes('### 项目自有技能')) {
      return '移除自有技能后 AGENTS.md 未清理自有技能条件块'
    }

    // 验证重入漂移、docs.tdd-stale-paths 与非 GitHub 远端无禁词渲染
    const sRe = await survey(reentryDir)
    if (!sRe.reentry?.isReentry || !sRe.reentry?.drifted) return `重入仓未检出 drifted：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleAgentPaths.includes('src/old/deleted.mjs')) return `staleAgentPaths 漏检：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleAgentScripts.includes('removed-script')) return `staleAgentScripts 漏检：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleTddPaths.includes('src/deleted-tdd.mjs')) return `reentry.staleTddPaths 未检出失效 TDD 路径：${JSON.stringify(sRe.reentry)}`
    if (sRe.reentry.staleTddPaths.some((p) => p.includes('docs/future') || p.includes('example.com'))) {
      return `staleTddPaths 误报了未来路径或 URL：${JSON.stringify(sRe.reentry.staleTddPaths)}`
    }
    if (!sRe.reentry.unregisteredTopDirs.includes('src/new-module')) {
      return `unregisteredTopDirs 未检出新增顶层目录：${JSON.stringify(sRe.reentry.unregisteredTopDirs)}`
    }
    if (sRe.explorationStrategy?.tier !== 'parallel-subagents' || !sRe.explorationStrategy.shards.some((s) => s.id === 'conventions-and-skills')) {
      return `重入漂移仓未切换 parallel-subagents：${JSON.stringify(sRe.explorationStrategy)}`
    }

    const mdRe = toMarkdown(sRe)
    if (FORBIDDEN_PLATFORM_RE.test(mdRe)) return '非 GitHub 远端导航或 Markdown 渲染输出了受限平台词汇'
    if (!mdRe.includes('远端不在 GitHub 上') || !mdRe.includes('跨月重入失步校准')) {
      return `toMarkdown 缺少非 GitHub 声明或重入校准摘要：\n${mdRe}`
    }

    const revRe = await runAbsAsync('scripts/review.mjs', [reentryDir])
    if (revRe.status !== 0 && !revRe.stdout) return `review.mjs reentryDir 异常退出：${revRe.stderr}`
    const { reviewProject } = await import('../review.mjs')
    const revReObj = await reviewProject(reentryDir)
    if (!revReObj.missing.some((f) => f.id === 'docs.tdd-stale-paths')) {
      return `review.mjs 未产出 docs.tdd-stale-paths：${JSON.stringify(revReObj.missing)}`
    }

    // 验证 explorationStrategy 三档分级：empty -> none、small -> single-pass、>80 files -> parallel-subagents
    const [sEmpty, sSmall, sLarge] = await Promise.all([survey(emptyDir), survey(smallCleanDir), survey(largeDir)])
    if (sEmpty.explorationStrategy?.tier !== 'none') return `empty 目录探索策略错误：${JSON.stringify(sEmpty.explorationStrategy)}`
    if (sSmall.explorationStrategy?.tier !== 'single-pass') return `小型干净仓探索策略错误：${JSON.stringify(sSmall.explorationStrategy)}`
    if (sLarge.explorationStrategy?.tier !== 'parallel-subagents') return `大型仓未触发 parallel-subagents：${JSON.stringify(sLarge.explorationStrategy)}`

    return true
  } finally {
    rmTree(customDir)
    rmTree(reentryDir)
    rmTree(emptyDir)
    rmTree(smallCleanDir)
    rmTree(largeDir)
  }
}])

}
