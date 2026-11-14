import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  SKILL_ROOT, gitInit, rmTree, runAbs, survey, tmpProject,
} from './fixtures-helpers.mjs'

export function registerV6KitCases(cases) {
// ── v6 五套技能正交重构、四误报根除与 Issue/PR 实时协同闭环（C1–C4, C16–C24） ───────

  cases.push(['v6 C1–C4：四层统一模板、中文 slug 成对归档、approve 不写非法枚举与 Mermaid 16/12 门禁', async () => {
    const { checkMermaidLabelWidth } = await import('../../kit/skills/lib/shared.mjs')
    const { syncDocsLifecycle } = await import('../../kit/skills/lib/docs.mjs')

    // 1. 常驻 .gitkeep 与 Mermaid 宽度正反双向
    for (const kp of ['docs/prd/.gitkeep', 'docs/specs/.gitkeep', 'docs/todo/.gitkeep']) {
      if (!existsSync(join(SKILL_ROOT, kp))) return `缺少常驻占位文件：${kp}`
    }
    const okMmd = checkMermaidLabelWidth('```mermaid\nflowchart LR\n  A["短节点"] -->|确认| B{"是否放行"}\n```')
    if (!okMmd.ok) return `合法短标签 Mermaid 被误报：${JSON.stringify(okMmd.violations)}`
    const badMmd = checkMermaidLabelWidth('```mermaid\nflowchart LR\n  A["这是一个非常长而且一定截断的矩形节点<br/>换行"] --> B{"超长菱形判断节点文本"}\n```')
    if (badMmd.ok || badMmd.violations.length < 3) {
      return `Mermaid 超宽/HTML 门禁未拦截：${JSON.stringify(badMmd)}`
    }

    // 2. 中文 slug + approveSpec + stripCritiqueMeta(link --issue) + 成对归档
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# doc-v6\n',
      'docs/TDD.md': '# TDD\n\n## 文档信息\n\n| 项目 | 内容 |\n| --- | --- |\n| 最近更新 | 2026-01-01 |\n',
      'src/app.mjs': 'export const a = 1\n',
    })
    gitInit(dir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })
    try {
      const initRes = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'all', '--slug', '中文特性', '--title', '中文特性方案', '--json',
      ], { cwd: dir })
      if (initRes.status !== 0) return `doc-plan init all 失败：${initRes.stderr}`
      const initJson = JSON.parse(initRes.stdout)
      const specRel = initJson.files.find((f) => f.endsWith('-spec.md'))
      const todoRel = initJson.files.find((f) => f.endsWith('-todo.md'))
      const prdRel = initJson.files.find((f) => f.endsWith('-prd.md'))

      for (const rel of [specRel, todoRel, prdRel]) {
        const p = join(dir, rel)
        let txt = readFileSync(p, 'utf8')
        txt = txt.replace('<two-way | one-way>', 'two-way')
          .replace(/<[^>]+>/g, '实际值')
          .replace('- [ ] C1: 实际值', '- [x] C1: 验证 `src/app.mjs` 返回退出码 0')
          .replace('- [ ] C2: 实际值', '- [x] C2: `src/app.mjs` 导出 `a` 成立')
          .replace('<!-- 一两段说清真实用户痛点与预期可观测收益 -->', '真实用户背景。')
          .replace('<!-- 在合并之前补齐真实实现摘要与验证结果 -->', '- 已在 src/app.mjs 实现并验证通过。')
        writeFileSync(p, txt)
      }

      const cp = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', specRel, '--reviewer', 'critic-1'], { cwd: dir })
      if (cp.status !== 0) return `critique-pass 失败：${cp.stderr}`

      // link --issue 后不应触发 BLOCKED_CRITIQUE_STALE 且中文 slug 不嵌套重复日期
      const lk = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['link', specRel, '--issue', '42', '--json'], { cwd: dir })
      if (lk.status !== 0) return `link --issue 失败：${lk.stderr}`
      const lkJson = JSON.parse(lk.stdout)
      const renamedSpec = lkJson.byKind?.spec
      if (!renamedSpec || /-26\d{4}-/.test(renamedSpec)) {
        return `中文 slug 重命名重复损坏：${renamedSpec}`
      }
      const renamedTodo = lkJson.byKind?.todo
      const apTodo = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', renamedTodo], { cwd: dir })
      if (apTodo.status !== 0) return `Todo approve 失败：${apTodo.stderr}`
      if (/^status:\s*approved/m.test(readFileSync(join(dir, renamedTodo), 'utf8'))) {
        return 'approveSpec 向 Todo 写了非法 status: approved'
      }
      const apSpec = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', renamedSpec], { cwd: dir })
      if (apSpec.status !== 0) return `link --issue 后 approveSpec 失败（误触 critique stale）：${apSpec.stderr}`

      // 成对归档：PRD / SPEC / Todo 一并移入 docs/archive/{prd,specs,todo}/ 并重算 related_* 零断链
      const arch = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['archive', renamedSpec, '--json'], { cwd: dir })
      if (arch.status !== 0) return `doc-plan archive 失败：${arch.stderr}`
      const archJson = JSON.parse(arch.stdout)
      for (const k of ['prd', 'spec', 'todo']) {
        if (!archJson.byKind?.[k]?.startsWith('docs/archive/')) return `${k} 未成对归档：${JSON.stringify(archJson.byKind)}`
      }
      const audAfter = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '.', '--json'], { cwd: dir })
      if (audAfter.status !== 0) return `归档后 doc-plan audit 断链：${audAfter.stdout} ${audAfter.stderr}`

      // syncDocsLifecycle 单遍替换防嵌套测试
      await syncDocsLifecycle(dir, { slugOrPath: archJson.byKind.spec })
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['v6 C17/C18/C20：8层深 Java+React repo-map、Dev Profile 显式 none 与未知 flag/冲突态拦截', async () => {
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
    gitInit(dir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })
    try {
      // 1. 8 层深 Java + 前端分离 repo-map，保留 working-directory 与多行 if/fi
      const mapRes = runAbs('kit/skills/dev-explore/scripts/repo-map.mjs', [dir, '--json'])
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
      const badFlag = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['inspect', '--no-such-flag', dir])
      if (badFlag.status !== 2) return `未知 flag 未退出 2：status=${badFlag.status}`
      const avail = resolveAvailableSkills(dir)
      if (!avail.has('dev-flow') || avail.has('dev-review')) return `resolveAvailableSkills 探测错误：${avail.skills}`

      // 3. Dev Profile 显式 none -> flow verify 与 submit 正常放行 + status/abort 可用
      const st = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-none', '--case', '1', '--slug', 'none-ok', '--json'], { cwd: dir })
      if (st.status !== 0) return `start 失败：${st.stderr}`
      const ver = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--json'], { cwd: dir })
      if (ver.status !== 0) return `Dev Profile quick-test: none 时 verify 失败：${ver.stderr}`
      const sub = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--json'], { cwd: dir })
      if (sub.status !== 0) return `submit 失败：${sub.stderr}`
      const stat = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['status', '--json'], { cwd: dir })
      if (stat.status !== 0 || JSON.parse(stat.stdout).taskId !== 't-none') return `status 自动推断失败：${stat.stdout}`

      // 4. MERGE_HEAD 冲突态自动阻断 verify 与 review-pack
      writeFileSync(join(dir, '.git', 'MERGE_HEAD'), '0'.repeat(40) + '\n')
      const verConflict = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify'], { cwd: dir })
      const revConflict = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local'], { cwd: dir })
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

  cases.push(['v6 C21/C22/C23：Tier 2 review 槽同步防空 Diff、changes 清零 reviewPassedHead、STOP_LOSS 人工解锁与子包/Workspace 防毒化', async () => {
    const { mountSharedDeps, unmountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
    const dir = tmpProject({
      '.gitignore': 'node_modules/\nfrontend/node_modules/\nbackend/node_modules/\n.worktrees/\n',
      'package.json': '{"name":"mono","version":"1.0.0","workspaces":["frontend","backend"]}\n',
      'pnpm-workspace.yaml': 'packages:\n  - frontend\n  - backend\n',
      'frontend/package.json': '{"name":"fe","version":"1.0.0"}\n',
      'frontend/package-lock.json': '{"lockfileVersion":3}\n',
      'backend/package.json': '{"name":"be","version":"1.0.0"}\n',
      'backend/package-lock.json': '{"lockfileVersion":3}\n',
      'AGENTS.md': '# mono\n\n```yaml\nquick-test: node -e "process.exit(0)"\nfull-test: node -e "process.exit(0)"\nmerge-gate: node -e "process.exit(0)"\n```\n',
      'src/app.mjs': 'export const v = 1\n',
    })
    gitInit(dir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 'impl'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'impl@example.com'], { cwd: dir, stdio: 'ignore' })
    mkdirSync(join(dir, 'frontend/node_modules/pkg'), { recursive: true })
    writeFileSync(join(dir, 'frontend/node_modules/pkg/i.js'), '1\n')
    mkdirSync(join(dir, 'backend/node_modules/pkg'), { recursive: true })
    writeFileSync(join(dir, 'backend/node_modules/pkg/i.js'), '1\n')
    // 在根 node_modules 放入指向主仓源码的 Workspace 软链，触发防毒化自动隔离
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(join(dir, 'frontend'), join(dir, 'node_modules/fe-ws'), linkType)

    try {
      const t2Init = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'todo', '--slug', 't2-feat', '--title', 'T2 Feature'], { cwd: dir })
      if (t2Init.status !== 0) return `t2 doc-plan init 失败：${t2Init.stderr}`
      const st = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-t2', '--case', '3', '--slug', 't2-feat', '--json'], { cwd: dir })
      if (st.status !== 0) return `Tier 2 start 失败：${st.stderr}`
      const l = JSON.parse(st.stdout)
      const implAbs = join(dir, l.worktreePath)
      const revAbs = join(dir, l.reviewWorktreePath)
      if (!l.todoFile || !existsSync(join(implAbs, l.todoFile))) {
        return `Tier 2 start 未迁入关联 todoFile：${JSON.stringify(l)}`
      }
      if (existsSync(revAbs)) return 'Tier 2 start 不应在 baseSha 预创建陈旧 review 空槽'

      // Workspace 软链指回主仓 -> 根 node_modules 隔离；backend 与 frontend 均共享；改 frontend 锁只隔离 frontend
      if (!l.depsMount?.isolatedUnits?.some((u) => u.reason === 'workspace-symlink-poisoning')) {
        return `未隔离指回主仓的 Workspace 软链：${JSON.stringify(l.depsMount)}`
      }
      if (!existsSync(join(implAbs, 'frontend/node_modules/pkg/i.js')) || !existsSync(join(implAbs, 'backend/node_modules/pkg/i.js'))) {
        return '子包独立锁比对未挂载子包共享依赖'
      }
      unmountSharedDeps(dir, implAbs)
      writeFileSync(join(implAbs, 'frontend/package-lock.json'), '{"lockfileVersion":3,"changed":1}\n')
      const mPartial = mountSharedDeps(dir, implAbs)
      if (existsSync(join(implAbs, 'frontend/node_modules')) || !existsSync(join(implAbs, 'backend/node_modules/pkg/i.js'))) {
        return `frontend 锁变更未做到单包隔离：${JSON.stringify(mPartial)}`
      }

      // 提交业务代码 -> verify -> submit 自动同步 review 槽至最新 HEAD（不再是空 diff）
      writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 2\n')
      writeFileSync(
        join(implAbs, l.todoFile),
        readFileSync(join(implAbs, l.todoFile), 'utf8').replace('<two-way | one-way>', 'two-way').replace(/<[^>]+>/g, '`src/app.mjs`').replace(/- \[ \]/g, '- [x]'),
      )
      spawnSync('git', ['add', '-A'], { cwd: implAbs, stdio: 'ignore' })
      spawnSync('git', ['commit', '-qm', 'feat: v2'], { cwd: implAbs, stdio: 'ignore' })
      runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-t2'], { cwd: implAbs })
      spawnSync('git', ['add', '-A'], { cwd: implAbs, stdio: 'ignore' })
      spawnSync('git', ['commit', '-qm', 'docs: archive'], { cwd: implAbs, stdio: 'ignore' })
      runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-t2'], { cwd: implAbs })
      const sub = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-t2', '--json'], { cwd: implAbs })
      if (sub.status !== 0) return `Tier 2 submit 失败：${sub.stderr}`
      const subJson = JSON.parse(sub.stdout)
      if (!existsSync(revAbs) || (subJson.reviewSlotSync?.headSha ?? '') === l.baseSha) {
        return `submit 未推进 review 槽到最新 HEAD：${sub.stdout}`
      }

      const pack = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--task', 't-t2', '--json'], { cwd: dir })
      const packJson = JSON.parse(pack.stdout)
      if ((packJson.diff?.files?.length ?? 0) === 0 || packJson.diffText !== undefined) {
        return `review-pack 空 diff 或未默认精简 diffText：${pack.stdout.slice(0, 400)}`
      }

      // Round 1 pass 后再提交新改动并 verify（未复审），merge 必须拦截陈旧 reviewPassedHead
      runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-t2', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'rev-a'], { cwd: dir })
      writeFileSync(join(implAbs, 'src/app.mjs'), 'export const v = 3\n')
      spawnSync('git', ['add', '-A'], { cwd: implAbs, stdio: 'ignore' })
      spawnSync('git', ['commit', '-qm', 'feat: v3'], { cwd: implAbs, stdio: 'ignore' })
      runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-t2'], { cwd: implAbs })
      const mStaleHead = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-t2'], { cwd: dir })
      if (mStaleHead.status === 0) return '新提交仅 verify 未复审却被 merge 放行了（reviewPassedHead 校验失效）'

      // Round 2 changes 必须清空 reviewPassedHead -> merge 阻断；触发 stop-loss 后可 override 解锁
      runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-t2', '--round', '2', '--verdict', 'changes', '--must-fix', 'C1: bug', '--reviewer-id', 'rev-a'], { cwd: dir })
      const t2AfterR2 = JSON.parse(readFileSync(join(dir, '.worktrees/.state/tasks/t-t2.json'), 'utf8'))
      if (t2AfterR2.reviewPassedHead !== null) return `verdict=changes 未清空 reviewPassedHead：${t2AfterR2.reviewPassedHead}`
      const mBlocked = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-t2'], { cwd: dir })
      if (mBlocked.status === 0) return 'verdict=changes 后 merge 竟然放行了'

      const r3Stop = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-t2', '--round', '3', '--verdict', 'changes', '--must-fix', 'C1: bug', '--reviewer-id', 'rev-a'], { cwd: dir })
      if (r3Stop.status !== 4) return `Round 3 未触发 STOP_LOSS_ESCALATE (exit=4)：${r3Stop.status}`
      const ov = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['override', '--task', 't-t2', '--human-approved', '--reason', 'human verified'], { cwd: dir })
      if (ov.status !== 0) return `override 失败：${ov.stderr}`
      const mOk = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-t2', '--human-approved', '--reason', 'human verified'], { cwd: dir })
      if (mOk.status !== 0) return `override 后 merge 仍阻断：${mOk.stderr}`
      const clOk = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-t2', '--confirm', '--json'], { cwd: dir })
      if (clOk.status !== 0) return `cleanup 失败：${clOk.stderr}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['v6 C24 与 4 处异构项目误报根除：权威架构文档识别、Dev Profile 测试入口、TDD 命令串与 .exec/TEMP 零误报', async () => {
    const { resolveAuthoritativeTddPath } = await import('../../kit/skills/lib/shared.mjs')
    const { extractLineCommentInfo } = await import('../../kit/skills/lib/static-gates.mjs')

    // 1. 词法剥离器：Rust 'a 生命周期、C 宏常量定义、注释内跳过标记不误报
    const rustInfo = extractLineCommentInfo("fn f<'a>(x: &'a str) -> &'a str { x } // 'a", false, 'rs')
    if (rustInfo.commentText.trim() !== "'a") return `Rust lifetime 误解析：${JSON.stringify(rustInfo)}`
    const cInfo = extractLineCommentInfo('#define TEMP 64 // ok', false, 'c')
    if (/\bTEMP\b/.test(cInfo.commentText)) return `C #define TEMP 被当成注释：${JSON.stringify(cInfo)}`

    // 2. 异构仓库：ARCHITECTURE.md + Dev Profile 测试入口 + TDD CLI 命令串 + .exec() + govern-audit --save-baseline/--changed
    const archDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# arch-demo\n',
      'ARCHITECTURE.md': '# Arch\n\n运行命令 `node scripts/run-tests.mjs`。\n',
      'AGENTS.md': [
        '# arch-demo',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: node scripts/run-tests.mjs',
        'full-test: node scripts/run-tests.mjs',
        '```',
      ].join('\n'),
      'scripts/run-tests.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'src/parser.mjs': "const s = 'x'; export const r = /a/.exec(`\\n${s}`)\n",
    })
    gitInit(archDir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: archDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: archDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: archDir, stdio: 'ignore' })
    try {
      if (resolveAuthoritativeTddPath(archDir) !== 'ARCHITECTURE.md') {
        return `未识别 ARCHITECTURE.md：${resolveAuthoritativeTddPath(archDir)}`
      }
      const noTddAgents = '# x\n\n## 取舍\n\n- `no-tdd`: 纯脚本无架构文档\n'
      if (resolveAuthoritativeTddPath(archDir, noTddAgents) !== null) {
        return '声明 no-tdd 时未返回 null'
      }

      const aud = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', archDir, '--all', '--json'])
      if (aud.status !== 0) return `govern-audit 失败：${aud.stderr}`
      const aj = JSON.parse(aud.stdout)
      const ids = aj.findings.map((f) => f.id)
      for (const forbidden of ['docs.missing-tdd', 'tests.missing-suite']) {
        if (ids.includes(forbidden)) return `异构项目出现误报 ${forbidden}：${JSON.stringify(ids)}`
      }
      if (ids.some((id) => id.startsWith('docs.tdd-stale-path.node ') || id.startsWith('sec.dynamic-exec.'))) {
        return `CLI 命令串或 RegExp.exec 仍被误报：${JSON.stringify(ids)}`
      }

      // 反面：真正不存在的命令脚本路径必须报 docs.tdd-stale-path.scripts/ghost.mjs；真无测试入口必须报 tests.missing-suite
      writeFileSync(join(archDir, 'ARCHITECTURE.md'), '# Arch\n\n`node scripts/ghost.mjs` 与 `src/missing.mjs`。\n')
      writeFileSync(join(archDir, 'AGENTS.md'), '# arch-demo\n\n## Dev Profile\n```yaml\nquick-test: none\n```\n')
      const audBad = JSON.parse(runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', archDir, '--all', '--json']).stdout)
      const badIds = audBad.findings.map((f) => f.id)
      if (!badIds.includes('docs.tdd-stale-path.scripts/ghost.mjs') || !badIds.includes('tests.missing-suite')) {
        return `反面校验漏报真实缺陷：${JSON.stringify(badIds)}`
      }
      return true
    } finally { rmTree(archDir) }
  }])

  cases.push(['v6 Trust Gateway：createIssue/listComments、start --create-issue 联动改名、claim 互斥/--takeover、release 与 record 实时双写', async () => {
    const { createGitHubClient } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart, handleClaim } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleRelease } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const { resolveRepoRoots } = await import('../../kit/skills/lib/git.mjs')

    // 1. 内存 stateful mock GitHub runner（验证 --body-file UTF-8 临时文件、listComments、add/removeLabel）
    const issues = new Map()
    const labelsByNum = new Map()
    const commentsByNum = new Map()
    let nextNum = 77
    const runner = async (cmd, args) => {
      if (cmd !== 'gh') return { ok: false, code: 1, stdout: '', stderr: 'not gh' }
      if (args[0] === 'issue' && args[1] === 'create') {
        const title = args[args.indexOf('--title') + 1]
        const bodyFile = args[args.indexOf('--body-file') + 1]
        const body = readFileSync(bodyFile, 'utf8')
        const num = nextNum++
        issues.set(num, { number: num, title, body })
        commentsByNum.set(num, [])
        labelsByNum.set(num, new Set())
        return { ok: true, code: 0, stdout: `https://github.com/acme/demo/issues/${num}\n`, stderr: '' }
      }
      if (args[0] === 'api' && /repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments/.test(args[1])) {
        const num = Number(/issues\/(\d+)\/comments/.exec(args[1])[1])
        if (args.includes('POST')) {
          const fSpec = args[args.indexOf('-F') + 1]
          const body = readFileSync(fSpec.replace(/^body=@/, ''), 'utf8')
          const entry = { id: (commentsByNum.get(num)?.length ?? 0) + 1, user: { login: 'tester' }, body, html_url: `https://github.com/acme/demo/issues/${num}#c` }
          if (!commentsByNum.has(num)) commentsByNum.set(num, [])
          commentsByNum.get(num).push(entry)
          return { ok: true, code: 0, stdout: JSON.stringify(entry), stderr: '' }
        }
        return { ok: true, code: 0, stdout: JSON.stringify(commentsByNum.get(num) ?? []), stderr: '' }
      }
      if (args[0] === 'issue' && args[1] === 'edit') {
        const num = Number(args[2])
        if (!labelsByNum.has(num)) labelsByNum.set(num, new Set())
        const set = labelsByNum.get(num)
        for (let i = 0; i < args.length; i++) {
          if (args[i] === '--add-label') set.add(args[i + 1])
          if (args[i] === '--remove-label') set.delete(args[i + 1])
        }
        return { ok: true, code: 0, stdout: '', stderr: '' }
      }
      return { ok: false, code: 1, stdout: '', stderr: 'unsupported' }
    }

    const client = createGitHubClient({ tier: 'gh-cli', login: 'alice', runner })
    const mcpClient = createGitHubClient({ tier: 'mcp-delegate' })
    const mcpIssue = await mcpClient.createIssue({ repo: 'acme/demo', title: 'delegated', body: 'hi', labels: ['bug'] })
    if (!mcpIssue.delegated || mcpIssue.jsonPayload?.action !== 'create_issue') {
      return `mcp-delegate createIssue 载荷异常：${JSON.stringify(mcpIssue)}`
    }

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': '{"name":"gw","version":"1.0.0","repository":"https://github.com/acme/demo.git"}\n',
      'README.md': '# gw\n',
      'src/app.mjs': 'export const gw = 1\n',
    })
    gitInit(dir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 'alice'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'alice@example.com'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '--allow-empty', '-qm', 'alice init'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: dir, stdio: 'ignore' })

    try {
      // 预先建一份 Todo，测试 start --create-issue 自动建单并联动重命名 todo 文件
      runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--kind', 'todo', '--slug', 'gw-feat', '--title', 'Gateway 功能'], { cwd: dir })
      const roots = await resolveRepoRoots(dir)
      const stRes = await handleStart({ 'create-issue': true, title: 'Gateway 功能', slug: 'gw-feat', case: '3', json: true, _ghClient: client }, roots)
      if (stRes.exitCode !== 0) return `start --create-issue 失败：exit=${stRes.exitCode}`
      const implAbs = join(dir, '.worktrees/impl-gw-feat')
      const ledger = JSON.parse(readFileSync(join(dir, '.worktrees/.state/tasks/gw-feat.json'), 'utf8'))
      if (!ledger.linkedIssues?.includes(77) || !ledger.todoFile?.includes('-issue77-') || !existsSync(join(implAbs, ledger.todoFile))) {
        return `start --create-issue 未写账本或未重命名 Todo：${JSON.stringify(ledger)}`
      }

      // Alice 认领 Issue #77 -> Bob 无 --takeover 被阻断 -> Bob 带 --takeover --reason 在 Issue+PR 双写接管 -> release -> 新认领放行
      const cAlice = await handleClaim({ task: 'gw-feat', agent: 'alice', json: true, _ghClient: client }, roots)
      if (cAlice.exitCode !== 0 || !labelsByNum.get(77)?.has('in-progress')) return 'alice claim 失败或未加 in-progress'

      const cBobBlocked = await handleClaim({ task: 'gw-feat', agent: 'bob', json: true, _ghClient: client }, roots)
      if (cBobBlocked.exitCode !== 3) return `他人重复 claim 未阻断：exit=${cBobBlocked.exitCode}`

      const cBobTakeNoReason = await handleClaim({ task: 'gw-feat', agent: 'bob', takeover: true, json: true, _ghClient: client }, roots)
      if (cBobTakeNoReason.exitCode === 0) return '--takeover 缺 --reason 未阻断'

      const cBobTake = await handleClaim({ task: 'gw-feat', agent: 'bob', pr: '88', takeover: true, reason: '交接给 Bob 跟进', json: true, _ghClient: client }, roots)
      if (cBobTake.exitCode !== 0 || !(commentsByNum.get(88) ?? []).some((c) => c.body.includes('接管认领'))) {
        return `takeover 未双写到 PR #88：${JSON.stringify(commentsByNum.get(88))}`
      }

      const relRes = await handleRelease({ task: 'gw-feat', agent: 'bob', reason: '暂缓处理', json: true, _ghClient: client }, roots)
      if (relRes.exitCode !== 0 || labelsByNum.get(77)?.has('in-progress')) {
        return 'release 未释放或未卸除 in-progress 标签'
      }

      // 释放后 Carol 无需 --takeover 即可直接认领
      const cCarol = await handleClaim({ task: 'gw-feat', agent: 'carol', json: true, _ghClient: client }, roots)
      if (cCarol.exitCode !== 0) return `release 后重新 claim 失败：exit=${cCarol.exitCode}`

      // review-pack record 实时双写四字段评论到 PR #88 与 Issue #77 并贴标签；离线绝不阻塞
      const recChangesCode = await handleRecord({
        task: 'gw-feat', round: '1', verdict: 'changes', 'reviewer-id': 'rev-z',
        'must-fix': ['C1: 修复空指针'], 'fault-injection': '注入故障后变红，还原复绿', json: true, _ghClient: client,
      }, roots)
      if (recChangesCode !== 0 || !labelsByNum.get(88)?.has('changes-requested') || !labelsByNum.get(77)?.has('changes-requested')) {
        return `record changes 未双写 PR/Issue 或未贴 changes-requested：code=${recChangesCode}, labels88=${[...(labelsByNum.get(88) ?? [])]}`
      }
      const prComs = commentsByNum.get(88) ?? []
      const lastPrCom = prComs[prComs.length - 1]?.body ?? ''
      for (const kw of ['审查来源', '逐条标准状态', '故障注入记录', '止损记录', '"action":"review"']) {
        if (!lastPrCom.includes(kw)) return `PR 评论缺关键字段 ${kw}：\n${lastPrCom}`
      }

      // 离线/无凭据 CLI 调用绝不阻塞（exit 0）
      const offlineRec = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
        'record', '--task', 'gw-feat', '--round', '2', '--verdict', 'pass', '--reviewer-id', 'rev-z', '--json',
      ], { cwd: dir })
      if (offlineRec.status !== 0 || !JSON.parse(offlineRec.stdout).githubSync) {
        return `离线 record 阻塞或缺少 githubSync 提示：status=${offlineRec.status}, out=${offlineRec.stdout}, err=${offlineRec.stderr}`
      }
      return true
    } finally {
      const wtAbs = join(dir, '.worktrees/impl-gw-feat')
      spawnSync('git', ['worktree', 'remove', '--force', wtAbs], { cwd: dir, stdio: 'ignore' })
      rmTree(dir)
    }
  }])

  cases.push(['v6 五套技能全场景联通：dev-govern 联动 explore/plan/flow 且产出 0 错 Todo + URL 直传正反双向', async () => {
    const { mkdirSync: mkd, rmSync: rmf } = await import('node:fs')
    // 1. dev-govern plan --write-todo 联动 dev-explore / dev-plan / dev-flow，并按需在 lightweight 降级
    const govDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# gov-link\n',
      'AGENTS.md': [
        '# Gov Link',
        '',
        '## 项目定位',
        'Gov test',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: node -e "process.exit(0)"',
        'arch-rules: src/ui/** -> src/db/**',
        '```',
        '',
        '- Old ref: `src/missing-old.mjs`',
      ].join('\n'),
      'src/db/conn.mjs': 'export const db = 1\n',
      'src/ui/app.mjs': "import { db } from '../db/conn.mjs'\n// TODO: clean me\nexport const ui = db\n",
      '.agents/skills/dev-explore/SKILL.md': '---\nname: dev-explore\ndescription: explore\n---\n',
      '.agents/skills/dev-plan/SKILL.md': '---\nname: dev-plan\ndescription: plan\n---\n',
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
      '.agents/skills/dev-govern/SKILL.md': '---\nname: dev-govern\ndescription: govern\n---\n',
    })
    gitInit(govDir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: govDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: govDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: govDir, stdio: 'ignore' })
    try {
      const govRes = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['plan', '--write-todo', '--json'], { cwd: govDir })
      if (govRes.status !== 0) return `govern-audit plan --write-todo 失败：${govRes.stderr}`
      const gj = JSON.parse(govRes.stdout)
      const todoRel = gj.plan?.todoRel
      if (!todoRel || !existsSync(join(govDir, todoRel))) {
        return `govern-audit --write-todo 未写出 Todo：${JSON.stringify(gj.plan)}`
      }
      const nsText = (gj.nextSteps ?? []).join('\n')
      if (!nsText.includes('repo-map.mjs') || !nsText.includes('doc-plan.mjs" audit') || !nsText.includes('doc-plan.mjs" triage') || !nsText.includes('flow.mjs" start')) {
        return `govern-audit nextSteps 缺少兄弟技能联动：${nsText}`
      }
      const audTodo = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', todoRel, '--json'], { cwd: govDir })
      if (audTodo.status !== 0) {
        return `govern 生成的 Todo 未通过 doc-plan audit：${audTodo.stdout} ${audTodo.stderr}`
      }

      // 缺少兄弟技能时应优雅降级为纯 Git 指引
      for (const sk of ['dev-explore', 'dev-plan', 'dev-flow']) {
        rmf(join(govDir, '.agents', 'skills', sk), { recursive: true, force: true })
      }
      const govMin = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['plan', '--json'], { cwd: govDir })
      const gmj = JSON.parse(govMin.stdout)
      const gmText = (gmj.nextSteps ?? []).join('\n')
      if (gmText.includes('repo-map.mjs') || gmText.includes('doc-plan.mjs') || gmText.includes('flow.mjs start') || !gmText.includes('git switch -c')) {
        return `缺省兄弟技能时 govern nextSteps 未降级：${gmText}`
      }
    } finally { rmTree(govDir) }

    // 2. 全链路直接粘贴 Issue/PR URL（正反双向）
    const urlDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# url-test\n',
      'src/app.mjs': 'export const u = 1\n',
    })
    gitInit(urlDir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: urlDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 'u'], { cwd: urlDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'u@u.u'], { cwd: urlDir, stdio: 'ignore' })
    spawnSync('git', ['commit', '--allow-empty', '-qm', 'init'], { cwd: urlDir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: urlDir, stdio: 'ignore' })
    mkd(join(urlDir, '.worktrees'), { recursive: true })
    try {
      const dpOk = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'url-test', '--title', 'URL 测试',
        '--issue', 'https://github.com/acme/demo/issues/42', '--json',
      ], { cwd: urlDir })
      if (dpOk.status !== 0 || !JSON.parse(dpOk.stdout).file?.includes('-issue42-')) {
        return `doc-plan --issue URL 失败：${dpOk.stdout} ${dpOk.stderr}`
      }
      const dpBad = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'bad-url', '--title', 'Bad URL',
        '--issue', 'https://github.com/acme/demo/pull/88',
      ], { cwd: urlDir })
      if (dpBad.status === 0) return 'doc-plan --issue 误放行了 PR URL'

      const stPrPos = runAbs('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', 'https://github.com/acme/demo/pull/88', '--pr-ref', 'HEAD', '--json',
      ], { cwd: urlDir })
      if (stPrPos.status !== 0 || JSON.parse(stPrPos.stdout).prNumber !== 88) {
        return `flow start 位置 PR URL 失败：${stPrPos.stdout} ${stPrPos.stderr}`
      }

      const stExt = runAbs('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--external-pr', 'https://github.com/acme/demo/pull/89', '--pr-ref', 'HEAD', '--json',
      ], { cwd: urlDir })
      if (stExt.status !== 0 || JSON.parse(stExt.stdout).role !== 'inbound-external-pr') {
        return `flow start --external-pr URL 失败：${stExt.stdout} ${stExt.stderr}`
      }

      const rpPos = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
        'https://github.com/acme/demo/pull/89', '--json',
      ], { cwd: urlDir })
      if (rpPos.status !== 0 || !JSON.parse(rpPos.stdout).worktreeRoot?.endsWith('.worktrees/review-pr-89')) {
        return `review-pack 位置 PR URL 失败：${rpPos.stdout} ${rpPos.stderr}`
      }

      const rpBad = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
        '--pr', 'https://github.com/acme/demo/issues/42',
      ], { cwd: urlDir })
      if (rpBad.status !== 2) return `review-pack --pr 未拒绝 Issue URL：status=${rpBad.status}`

      // finalize 实现说明：大写 TODO 阻断，合法 Todo / docs/todo/ 放行
      const spInit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'spec', '--slug', 'note-case', '--title', 'Impl Note Case', '--json',
      ], { cwd: urlDir })
      const spRel = JSON.parse(spInit.stdout).file
      let spTxt = readFileSync(join(urlDir, spRel), 'utf8')
        .replace('<two-way | one-way>', 'two-way')
        .replace(/<[^>]+>/g, '真实值')
        .replace('- [ ] C1: 真实值', '- [x] C1: verified')
        .replace('- [ ] C2: 真实值', '- [x] C2: verified')
        .replace('<!-- 在合并之前补齐真实实现摘要与验证结果 -->', '- TODO: fill later')
      writeFileSync(join(urlDir, spRel), spTxt)
      spawnSync('git', ['add', spRel], { cwd: urlDir, stdio: 'ignore' })
      spawnSync('git', ['commit', '-qm', 'spec todo'], { cwd: urlDir, stdio: 'ignore' })
      runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 'note-case', '--slug', 'note-case', '--case', '4'], { cwd: urlDir })
      const finBad = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'note-case'], { cwd: urlDir })
      if (finBad.status === 0 || !finBad.stderr.includes('BLOCKED_SPEC_IMPL_NOTE_EMPTY')) {
        return `finalize 未拦截大写 TODO 占位：status=${finBad.status}, err=${finBad.stderr}`
      }
      const spWtAbs = join(urlDir, '.worktrees/impl-note-case', spRel)
      writeFileSync(spWtAbs, readFileSync(spWtAbs, 'utf8').replace('- TODO: fill later', '- 已按 Todo 与 docs/todo/ 收尾验证。'))
      spawnSync('git', ['add', '-A'], { cwd: join(urlDir, '.worktrees/impl-note-case'), stdio: 'ignore' })
      spawnSync('git', ['commit', '-qm', 'spec real note'], { cwd: join(urlDir, '.worktrees/impl-note-case'), stdio: 'ignore' })
      const finOk = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 'note-case'], { cwd: urlDir })
      if (finOk.status !== 0) return `finalize 误拦合法 Todo 实现说明：${finOk.stderr}`

      return true
    } finally {
      for (const wt of ['.worktrees/impl-pr-88', '.worktrees/review-pr-89', '.worktrees/impl-note-case']) {
        spawnSync('git', ['worktree', 'remove', '--force', join(urlDir, wt)], { cwd: urlDir, stdio: 'ignore' })
      }
      rmTree(urlDir)
    }
  }])
}
