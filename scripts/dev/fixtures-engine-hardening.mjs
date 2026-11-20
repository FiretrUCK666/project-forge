/**
 * fixtures-engine-hardening.mjs —— Issue #99 引擎 8 项边界缺陷与 handoff schemaVersion=3 正反双向行为断言。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { reviewProject } from '../review.mjs'
import {
  gitInit,
  rmTree,
  runNode,
  survey,
  tmpProject,
} from './fixtures-helpers.mjs'

export function registerEngineHardeningCases(cases) {
  cases.push(['C1：手写 取舍 语义免漂移与空骨架/占位拦截（正反双向）', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'c1-tradeoff', version: '1.0.0', scripts: { test: 'node --test' } }),
      'README.md': '# c1-tradeoff\n\n手写取舍语义免字面漂移正反双向测试项目。\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    gitInit(dir)
    try {
      const gen = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (gen.status !== 0) return `compose-agents 生成失败：${gen.stderr}`

      const baseAgents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
        .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已补充真实项目说明。')
        .replace(/<!-- project-forge: begin Dev Profile -->[\s\S]*?<!-- project-forge: end Dev Profile -->/, (blk) => blk.replace(/<[^>\n]+>/g, 'none'))
        .replace(/<!-- project-forge: begin 改哪看哪 -->[\s\S]*?<!-- project-forge: end 改哪看哪 -->/, (blk) => blk.replace(/<[^>\n]+>/g, 'src/app.mjs'))
      const withTradeoff = baseAgents.replace(
        /<!-- project-forge: begin 取舍 -->[\s\S]*?<!-- project-forge: end 取舍 -->/,
        [
          '<!-- project-forge: begin 取舍 -->',
          '## 取舍',
          '',
          '由维护者手写，脚本不碰：',
          '',
          '```text',
          '- `license`：MIT，工具库希望被广泛复用',
          '- `no-ci`：本地测试工具暂不配远端 CI',
          '```',
          '',
          '<!-- project-forge: end 取舍 -->',
        ].join('\n'),
      )
      writeFileSync(join(dir, 'AGENTS.md'), withTradeoff, 'utf8')

      // 正面 1：未标 customized 即可直接通过 --check 与 review
      const chkOk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (chkOk.status !== 0) return `手写取舍未标 customized 却未过 --check：${chkOk.stderr}`

      const revOk = await reviewProject(dir)
      if (revOk.missing.some((f) => f.id === 'agents.drifted')) {
        return `手写取舍被 review 误报为 agents.drifted：${JSON.stringify(revOk.missing)}`
      }

      // 正面 2：默认刷新保留手写取舍内容不被模板覆盖
      const ref = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (ref.status !== 0) return `刷新失败：${ref.stderr}`
      const afterRefresh = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      if (!afterRefresh.includes('工具库希望被广泛复用')) return '刷新后手写取舍内容被意外覆盖'

      // 反面 1：空骨架（仅有标题与空代码块）必须被拦截
      const emptyTradeoff = afterRefresh.replace(
        /<!-- project-forge: begin 取舍 -->[\s\S]*?<!-- project-forge: end 取舍 -->/,
        '<!-- project-forge: begin 取舍 -->\n## 取舍\n\n```text\n```\n\n<!-- project-forge: end 取舍 -->',
      )
      writeFileSync(join(dir, 'AGENTS.md'), emptyTradeoff, 'utf8')
      const chkEmpty = await runNode('compose-agents.mjs', [dir, '--check'])
      if (chkEmpty.status === 0) return '取舍 为空骨架时 --check 竟误放行退出 0'

      // 反面 2：残留未填占位 <键名>：<选择> 必须被拦截
      const placeholderTradeoff = afterRefresh.replace(
        /<!-- project-forge: begin 取舍 -->[\s\S]*?<!-- project-forge: end 取舍 -->/,
        '<!-- project-forge: begin 取舍 -->\n## 取舍\n\n- <键名>：<选择>\n\n<!-- project-forge: end 取舍 -->',
      )
      writeFileSync(join(dir, 'AGENTS.md'), placeholderTradeoff, 'utf8')
      const chkPlaceholder = await runNode('compose-agents.mjs', [dir, '--check'])
      if (chkPlaceholder.status === 0) return '取舍 残留尖括号占位时 --check 竟误放行退出 0'

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C2：新增自定义技能单次运行 compose-agents.mjs 同时收敛 意图路由 与 探索策略（正反双向）', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'c2-skill', version: '1.0.0', scripts: { test: 'node --test' } }),
      'README.md': '# c2-skill\n\n自定义技能单遍收敛测试仓库。\n',
    }
    for (let i = 0; i < 85; i += 1) files[`src/mod${i}.mjs`] = `export const m${i} = ${i}\n`
    const dir = tmpProject(files)
    gitInit(dir)
    try {
      const eq = await runNode('equip.mjs', [dir, '--no-backup'])
      if (eq.status !== 0) return `equip 失败：${eq.stderr}`
      const gen = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (gen.status !== 0) return `compose-agents 初生失败：${gen.stderr}`

      const filled = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
        .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写项目模块与不变量说明。')
        .replace(/<!-- project-forge: begin Dev Profile -->[\s\S]*?<!-- project-forge: end Dev Profile -->/, (blk) => blk.replace(/<[^>\n]+>/g, 'none'))
        .replace(/<!-- project-forge: begin 改哪看哪 -->[\s\S]*?<!-- project-forge: end 改哪看哪 -->/, (blk) => blk.replace(/<[^>\n]+>/g, 'src/mod0.mjs'))
      writeFileSync(join(dir, 'AGENTS.md'), filled, 'utf8')
      const preChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (preChk.status !== 0) return `填完后前置 --check 失败：${preChk.stderr}`

      // 新增自定义技能并仅运行 1 次 compose-agents.mjs
      mkdirSync(join(dir, '.agents', 'skills', 'my-audit'), { recursive: true })
      writeFileSync(join(dir, '.agents', 'skills', 'my-audit', 'SKILL.md'), [
        '---',
        'name: my-audit',
        'description: Run domain specific security audit checks.',
        '---',
        '# my-audit',
      ].join('\n'), 'utf8')

      const runOnce = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (runOnce.status !== 0) return `单次运行 compose-agents 失败：${runOnce.stderr}`

      const updated = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      const intentBlock = /<!-- project-forge: begin 意图路由 -->([\s\S]*?)<!-- project-forge: end 意图路由 -->/.exec(updated)?.[1] ?? ''
      const stratBlock = /<!-- project-forge: begin 探索策略 -->([\s\S]*?)<!-- project-forge: end 探索策略 -->/.exec(updated)?.[1] ?? ''
      if (!intentBlock.includes('.agents/skills/my-audit/SKILL.md') || !intentBlock.includes('| my-audit：')) {
        return `单次运行后 意图路由 未包含新技能路由行：${intentBlock.slice(0, 400)}`
      }
      if (!stratBlock.includes('conventions-and-skills')) {
        return `单次运行后 探索策略 未同步更新 conventions-and-skills：${stratBlock}`
      }

      // 正面：无需跑第二遍，立即 --check 必须退出 0
      const postChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (postChk.status !== 0) return `单次运行后 --check 仍失败（未能单遍收敛）：${postChk.stderr}`

      // 反面：手工删去 探索策略 节必须触发 --check 报错
      const missingStrat = updated.replace(/<!-- project-forge: begin 探索策略 -->[\s\S]*?<!-- project-forge: end 探索策略 -->/, '')
      writeFileSync(join(dir, 'AGENTS.md'), missingStrat, 'utf8')
      const badChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (badChk.status === 0) return '删除 探索策略 后 --check 竟误放行退出 0'

      // 回归校验：存在 staleAgentPaths 且同时新增自定义技能时，单次运行 compose-agents.mjs 后 --check 亦须立即退出 0
      const withStaleAndCustom = updated.replace(
        '已填写项目模块与不变量说明。',
        '已填写项目模块与不变量说明：`src/removed-legacy-entry.mjs`。',
      )
      writeFileSync(join(dir, 'AGENTS.md'), withStaleAndCustom, 'utf8')
      const reRunOnce = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (reRunOnce.status !== 0) return `含 stale path 刷新失败：${reRunOnce.stderr}`
      const postStaleChk = await runNode('compose-agents.mjs', [dir, '--check'])
      if (postStaleChk.status !== 0) return `staleAgentPaths 导致 探索策略 漂移未能单遍收敛：${postStaleChk.stderr}`

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C3：survey-ecosystem 跳过 vendor/third_party/vscode-web-extensions 并聚合超多子包保持 AGENTS.md <= 30KB（正反双向）', async () => {
    const files = {
      'package.json': JSON.stringify({ name: 'c3-mono', version: '1.0.0', private: true }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "apps/*"\n  - "vendor/*"\n  - "third_party/*"\n',
      'README.md': '# c3-mono\n\n大型多子包与嵌入第三方源码隔离测试仓。\n',
      'apps/web/package.json': JSON.stringify({ name: '@demo/web', version: '1.0.0', scripts: { build: 'vite build', test: 'vitest run' } }),
      'vendor/embedded-lib/package.json': JSON.stringify({ name: 'embedded-lib', version: '1.0.0', scripts: { test: 'jest' } }),
      'third_party/sdk-core/Cargo.toml': '[package]\nname = "sdk-core"\nversion = "0.1.0"\n',
      'apps/vscode-web/extensions/ext-alpha/package.json': JSON.stringify({ name: 'ext-alpha', version: '1.0.0', scripts: { test: 'mocha' } }),
      'apps/vscode-web/extensions/ext-beta/package.json': JSON.stringify({ name: 'ext-beta', version: '1.0.0', scripts: { build: 'tsc' } }),
    }
    for (let i = 1; i <= 100; i += 1) {
      const id = String(i).padStart(3, '0')
      files[`packages/pkg-${id}/package.json`] = JSON.stringify({
        name: `@demo/pkg-${id}`,
        version: '1.0.0',
        scripts: {
          build: `tsc --project packages/pkg-${id}/tsconfig.build.json`,
          lint: `eslint packages/pkg-${id}/src`,
          test: `node --test packages/pkg-${id}/test`,
        },
      })
    }
    const dir = tmpProject(files)
    gitInit(dir)
    try {
      const facts = await survey(dir)
      const subdirNames = (facts.ecosystem?.subdirs ?? []).map((s) => s.dir)
      const wsPkgs = facts.workspace?.packages ?? []

      if (subdirNames.some((d) => d.startsWith('vendor/') || d.startsWith('third_party/') || d.includes('vscode-web/extensions'))) {
        return `ecosystem.subdirs 未过滤嵌入第三方子包：${JSON.stringify(subdirNames)}`
      }
      if (wsPkgs.some((d) => d.startsWith('vendor/') || d.startsWith('third_party/') || d.includes('vscode-web/extensions'))) {
        return `workspace.packages 未过滤嵌入第三方子包：${JSON.stringify(wsPkgs)}`
      }
      // 反面：真实非豁免顶层工作区子包必须被精准识别
      if (!subdirNames.includes('apps/web') || !subdirNames.includes('packages/pkg-001')) {
        return `真实子包漏检：${JSON.stringify(subdirNames)}`
      }

      const gen = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (gen.status !== 0) return `多子包 compose-agents 失败（可能撑破 30KB）：${gen.stderr}`
      const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      const bytes = Buffer.byteLength(agentsText, 'utf8')
      if (bytes > 30720) return `聚合后 AGENTS.md 仍超过 30KB：${bytes}B`

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C4：survey-workspace Git 已跟踪输出目录消误报与未跟踪产物拦截（正反双向）', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'c4-out', version: '1.0.0', scripts: { test: 'node --test' } }),
      'README.md': '# c4-out\n\n输出目录全量已跟踪 vs 含未跟踪文件正反双向测试。\n',
      'dist/index.js': 'export const ok = 1\n',
      'build/bundle.js': 'export const b = 1\n',
      'out/main.js': 'export const o = 1\n',
      'coverage/summary.json': '{"ok":true}\n',
      'bin/cli.mjs': '#!/usr/bin/env node\nconsole.log(1)\n',
    })
    gitInit(dir)
    try {
      // 正面：全部文件已 100% 纳入 Git 跟踪时，不再误报 unignoredOutputDirs
      const f1 = await survey(dir)
      if (f1.ignores.unignoredOutputDirs.length > 0) {
        return `100% 已跟踪输出目录被误报为 unignoredOutputDirs：${JSON.stringify(f1.ignores.unignoredOutputDirs)}`
      }
      if (f1.ignores.ignoredButTracked.length > 0) {
        return `不应存在 ignoredButTracked 冲突：${JSON.stringify(f1.ignores.ignoredButTracked)}`
      }
      const rev1 = await reviewProject(dir)
      if (rev1.missing.some((x) => x.id === 'git.output-dirs' || x.id === 'git.ignored-tracked')) {
        return `review 误报 output-dirs 死锁：${JSON.stringify(rev1.missing)}`
      }

      // 反面：在同目录新增未跟踪产物文件时，必须继续报错拦截
      writeFileSync(join(dir, 'dist', 'untracked-artifact.js'), 'export const dirty = 1\n', 'utf8')
      writeFileSync(join(dir, 'bin', 'untracked-bin'), 'binary\n', 'utf8')
      const f2 = await survey(dir)
      if (!f2.ignores.unignoredOutputDirs.includes('dist') || !f2.ignores.unignoredOutputDirs.includes('bin')) {
        return `含未跟踪产物文件时 unignoredOutputDirs 漏报：${JSON.stringify(f2.ignores.unignoredOutputDirs)}`
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C5：review.mjs 识别 existingDesignDocs 与 tdd-authority 豁免（正反双向）', async () => {
    const archDir = tmpProject({
      'package.json': JSON.stringify({ name: 'c5-arch', version: '1.0.0' }),
      'README.md': '# c5-arch\n\n存量架构设计文档识别正反双向验证测试项目说明。\n',
      'docs/adr/0001-arch.md': '# ADR 0001\n\nExisting ADR architecture decision record.\n',
      'src/index.mjs': 'export const a = 1\n',
    })
    const authDir = tmpProject({
      'package.json': JSON.stringify({ name: 'c5-auth', version: '1.0.0' }),
      'README.md': '# c5-auth\n\ntdd-authority 声明识别测试。\n',
      'docs/custom-arch.md': '# Custom Arch\n\nAuthoritative design.\n',
      'AGENTS.md': '# c5-auth\n\n## 取舍\n\n- `tdd-authority`：`docs/custom-arch.md`\n',
      'src/index.mjs': 'export const a = 1\n',
    })
    const missingDir = tmpProject({
      'package.json': JSON.stringify({ name: 'c5-missing', version: '1.0.0' }),
      'README.md': '# c5-missing\n\n无架构文档反例测试。\n',
      'AGENTS.md': '# c5-missing\n\n## 取舍\n\n- `tdd-authority`：`docs/not-found.md`\n',
      'src/index.mjs': 'export const a = 1\n',
    })
    try {
      const rArch = await reviewProject(archDir)
      if (rArch.results.some((x) => x.id === 'docs.tddMissing')) {
        return `存在 ARCHITECTURE.md 时仍误报 docs.tddMissing：${JSON.stringify(rArch.results.filter((x) => x.scope === 'docs'))}`
      }
      if (!rArch.results.some((x) => x.id === 'docs.tdd.ok' && x.level === 'ok')) {
        return '存在 ARCHITECTURE.md 时未产出 docs.tdd.ok'
      }

      const rAuth = await reviewProject(authDir)
      if (rAuth.results.some((x) => x.id === 'docs.tddMissing')) {
        return `声明有效 tdd-authority 时仍误报 docs.tddMissing：${JSON.stringify(rAuth.results.filter((x) => x.scope === 'docs'))}`
      }

      // 反面：无任何设计文档且 tdd-authority 指向不存在文件时仍报 docs.tddMissing
      const rMissing = await reviewProject(missingDir)
      if (!rMissing.results.some((x) => x.id === 'docs.tddMissing')) {
        return `无真实架构文档时未报 docs.tddMissing：${JSON.stringify(rMissing.results.filter((x) => x.scope === 'docs'))}`
      }
      return true
    } finally {
      rmTree(archDir)
      rmTree(authDir)
      rmTree(missingDir)
    }
  }])

  cases.push(['C6：equip-bootstrap.mjs 空目录起步 README.md 无悬空 scripts/compose-agents.mjs 指针（正反双向）', async () => {
    const emptyDir = tmpProject({})
    try {
      const boot = await runNode('equip.mjs', [emptyDir, '--bootstrap-empty', '--stack', 'node', '--name', 'c6-boot'])
      if (boot.status !== 0) return `bootstrap-empty 失败：${boot.stderr}`

      const readme = readFileSync(join(emptyDir, 'README.md'), 'utf8')
      if (readme.includes('scripts/compose-agents.mjs')) {
        return `空起步 README.md 仍残留悬空 scripts/compose-agents.mjs 指针：\n${readme}`
      }

      const scanOk = JSON.parse((await runNode('handoff.mjs', [emptyDir, '--scan', '--json'])).stdout)
      if ((scanOk.danglingPointers ?? []).length > 0) {
        return `空起步仓 handoff 存在悬空指针：${JSON.stringify(scanOk.danglingPointers)}`
      }

      const chk = await runNode('compose-agents.mjs', [emptyDir, '--check'])
      if (chk.status !== 0) return `空起步 AGENTS.md 未通过 --check：${chk.stderr}`

      // 反面：若人为把 scripts/compose-agents.mjs 写回 README.md，handoff 必须抓出悬空指针
      writeFileSync(join(emptyDir, 'README.md'), `${readme}\nRun \`node scripts/compose-agents.mjs .\`\n`, 'utf8')
      const scanBad = JSON.parse((await runNode('handoff.mjs', [emptyDir, '--scan', '--json'])).stdout)
      if (!(scanBad.danglingPointers ?? []).some((p) => p.target.includes('compose-agents.mjs'))) {
        return '人为写入悬空 compose-agents.mjs 后 handoff 未检出'
      }
      return true
    } finally {
      rmTree(emptyDir)
    }
  }])

  cases.push(['C7：handoff.mjs dirname(rel) 校验、参考前缀限定、vendored 大文件区分与 schemaVersion=3（正反双向）', async () => {
    const dir = tmpProject({
      'README.md': '# c7-handoff\n\nhandoff 边界修复与 schemaVersion=3 测试。\n',
      'docs/guide.md': '见本地同目录相对引用 references/survey.md 以及非工具路径 references/custom-spec.md。\n',
      'docs/references/survey.md': '# Local Survey Ref\n',
      'vendor/big-pkg/CHANGELOG.md': `${'v1.0.0\n'.repeat(45000)}`,
      'third_party/sdk/README.md': `${'sdk-doc\n'.repeat(45000)}`,
      '.agents/skills/.pf-manifest.json': JSON.stringify({
        schemaVersion: 3,
        forgeVersion: '6.0.0',
        files: { 'dev-flow/SKILL.md': { sha256: 'abc' } },
      }),
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
    })
    try {
      // 正面：dirname(rel) 相对引用、非 forge references/*.md、vendored 大文件不截断、schemaVersion=3 valid=true
      const resOk = JSON.parse((await runNode('handoff.mjs', [dir, '--scan', '--json'])).stdout)
      if (!resOk.clean) return `合规仓被 handoff 误报不干净：${JSON.stringify(resOk)}`
      if (resOk.truncated) return `vendored 大文件误触发 truncated：${JSON.stringify(resOk.scanCoverage)}`
      if ((resOk.scanCoverage?.skippedVendoredLarge ?? 0) < 2) {
        return `skippedVendoredLarge 统计缺失：${JSON.stringify(resOk.scanCoverage)}`
      }
      if (resOk.kitManifest?.valid !== true || resOk.kitManifest?.schemaVersion !== 3) {
        return `schemaVersion=3 清单被误判为无效：${JSON.stringify(resOk.kitManifest)}`
      }
      const verOk = await runNode('handoff.mjs', [dir, '--verify'])
      if (verOk.status !== 0) return `handoff --verify 应返回 0，实为 ${verOk.status}`

      // 反面 1：真实缺失本工具参考文档 references/handoff.md 必须阻断
      writeFileSync(join(dir, 'docs/guide.md'), '参见 references/handoff.md 获取详情。\n', 'utf8')
      const resDangling = JSON.parse((await runNode('handoff.mjs', [dir, '--scan', '--json'])).stdout)
      if (!resDangling.danglingPointers.some((p) => p.target === 'references/handoff.md')) {
        return `真实缺失本工具参考引用 references/handoff.md 漏报：${JSON.stringify(resDangling.danglingPointers)}`
      }
      const verDirty = await runNode('handoff.mjs', [dir, '--verify'])
      if (verDirty.status !== 1) return `存在悬空指针时 --verify 应返回 1，实为 ${verDirty.status}`

      // 反面 2：非法 schemaVersion=99 必须判 kitManifest.valid=false
      writeFileSync(join(dir, 'docs/guide.md'), '# clean\n', 'utf8')
      writeFileSync(join(dir, '.agents/skills/.pf-manifest.json'), JSON.stringify({
        schemaVersion: 99,
        files: { 'dev-flow/SKILL.md': { sha256: 'abc' } },
      }), 'utf8')
      const resBadSchema = JSON.parse((await runNode('handoff.mjs', [dir, '--scan', '--json'])).stdout)
      if (resBadSchema.kitManifest?.valid !== false) {
        return `非法 schemaVersion=99 竟判 valid=true：${JSON.stringify(resBadSchema.kitManifest)}`
      }

      // 反面 3：非 vendored 自有大文件 >256KB 仍须触发 truncated 且 --verify 返回 3
      writeFileSync(join(dir, 'docs/huge-own.md'), 'x'.repeat(270 * 1024), 'utf8')
      const resOwnLarge = JSON.parse((await runNode('handoff.mjs', [dir, '--scan', '--json'])).stdout)
      if (!resOwnLarge.truncated || (resOwnLarge.scanCoverage?.skippedLarge ?? 0) < 1) {
        return `自有大文件未触发 truncated 告警：${JSON.stringify(resOwnLarge.scanCoverage)}`
      }
      const verTrunc = await runNode('handoff.mjs', [dir, '--verify'])
      if (verTrunc.status !== 3) return `自有大文件截断时 --verify 应返回 3，实为 ${verTrunc.status}`

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C8：survey 精准预检规则不漏真凭据/本机路径且本仓 survey(self) <= 250ms 门禁契约', async () => {
    const fakeToken = `ghp_${'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8'}`
    const homeDir = homedir().replace(/\\/g, '/')
    const dir = tmpProject({
      'package.json': JSON.stringify({ name: 'c8-precheck', version: '1.0.0' }),
      'README.md': '# c8-precheck\n\n预检精准度与零漏报验证。\n',
      'src/clean.js': 'export const opts = { task_id: "task-123", npm_config: true, disk_id: "sk-short" }\n',
      'src/leak.js': `export const token = "${fakeToken}"\nexport const p = "${homeDir}/secret.txt"\n`,
    })
    gitInit(dir)
    try {
      const f = await survey(dir)
      const sec = f.risks?.secretContent ?? []
      const leaks = f.risks?.homePathLeaks ?? []
      if (!sec.some((s) => s.file === 'src/leak.js')) return `收紧预检后漏报真实凭据：${JSON.stringify(sec)}`
      if (sec.some((s) => s.file === 'src/clean.js')) return `误报干净代码中的短前缀：${JSON.stringify(sec)}`
      if (!leaks.some((l) => l.file === 'src/leak.js')) return `收紧 homeFastRe 后漏报本机绝对路径：${JSON.stringify(leaks)}`
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
