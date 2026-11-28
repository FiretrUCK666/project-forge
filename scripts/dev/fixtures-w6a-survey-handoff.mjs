/**
 * fixtures-w6a-survey-handoff.mjs —— Wave 6 Slice 6A（C1..C5）正反双向行为断言。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isDynamicPemTemplateLine, isSensitiveSecretFile } from '../../kit/skills/lib/credential-scan.mjs'
import { matchGlobList, readJsonSafe } from '../../kit/skills/lib/git-core.mjs'
import { detectOptionalNativeCheckers } from '../../kit/skills/lib/profile-sniffer.mjs'
import { createBackup, listBackups, restoreBackup } from '../backup.mjs'
import { renderAgentsTemplate } from '../compose-agents.mjs'
import { scan as handoffScan } from '../handoff.mjs'
import { reviewProject } from '../review.mjs'
import { detectGitHooksState } from '../lib/survey-docs.mjs'
import { gitCommitFast, gitInit, rmTree, runNode, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerW6aSurveyHandoffCases(cases) {
  cases.push(['W6A C1：工作流 job 级 pull_request_target、现代发布命令与 simple-git-hooks/.git/hooks 探测（正反双向）', async () => {
    // 1. 跨文件不误聚合 + pull_request.number 评论豁免 + zizmor ignore 豁免
    const safeDir = tmpProject({
      'README.md': '# c1-safe\n\nSafe workflow usage.\n',
      '.github/workflows/label.yml': [
        'name: Label',
        'on:',
        '  pull_request_target:',
        '    types: [opened]',
        'jobs:',
        '  comment:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: gh pr comment ${{ github.event.pull_request.number }} --body "hi"',
      ].join('\n'),
      '.github/workflows/ci.yml': [
        'name: CI',
        'on:',
        '  pull_request:',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with:',
        '          ref: ${{ github.event.pull_request.head.sha }}',
        '      - run: uv publish',
      ].join('\n'),
      '.github/workflows/zizmor-ok.yml': [
        'name: Zizmor Ignored',
        'on:',
        '  pull_request_target: # zizmor: ignore[dangerous-triggers]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with:',
        '          ref: ${{ github.event.pull_request.head.ref }}',
      ].join('\n'),
      'package.json': JSON.stringify({
        name: 'c1-safe',
        version: '1.0.0',
        'simple-git-hooks': { 'pre-commit': 'npm test' },
      }),
    })
    gitInit(safeDir)
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/c1-safe.git'], { cwd: safeDir })
    mkdirSync(join(safeDir, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(safeDir, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho custom\n', 'utf8')

    // 2. 同文件不安全 refs/pull/<number>/merge 检出 + 现代发布命令（jsr publish / dotnet nuget push / vp pack）
    const unsafeDir = tmpProject({
      'README.md': '# c1-unsafe\n\nUnsafe workflow.\n',
      '.github/workflows/pwn.yml': [
        'name: Pwn',
        'on: pull_request_target',
        'jobs:',
        '  safe_job:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo ${{ github.event.pull_request.number }}',
        '  unsafe_job:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with:',
        '          ref: refs/pull/${{ github.event.pull_request.number }}/merge',
      ].join('\n'),
      '.github/workflows/release.yml': [
        'name: Release',
        'on: push',
        'jobs:',
        '  pub:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: jsr publish',
        '      - run: dotnet nuget push *.nupkg',
        '      - run: vp pack',
      ].join('\n'),
    })
    gitInit(unsafeDir)
    mkdirSync(join(unsafeDir, '.git', 'hooks'), { recursive: true })
    // 空的 .git/hooks 文件与 *.sample 不应被误报为 hook 冲突
    writeFileSync(join(unsafeDir, '.git', 'hooks', 'post-commit'), '', 'utf8')
    writeFileSync(join(unsafeDir, '.git', 'hooks', 'pre-applypatch.sample'), '#!/bin/sh\necho sample\n', 'utf8')

    try {
      const fSafe = await survey(safeDir)
      if (fSafe.docs.workflowFacts?.checkoutsPrHead) {
        return `C1 跨文件/number/zizmor 误判为 checkoutsPrHead：${JSON.stringify(fSafe.docs.workflowFacts)}`
      }
      if ((fSafe.docs.workflowFacts?.unsafePullRequestTargetWorkflows?.length ?? 0) !== 0) {
        return `C1 unsafePullRequestTargetWorkflows 应为空：${JSON.stringify(fSafe.docs.workflowFacts)}`
      }
      if (!fSafe.docs.workflowFacts?.hasRelease || !fSafe.docs.workflowFacts?.releaseTools?.includes('uv-publish')) {
        return `C1 未识别 uv publish：${JSON.stringify(fSafe.docs.workflowFacts)}`
      }
      const rSafe = await reviewProject(safeDir)
      if (rSafe.results.some((r) => r.id === 'ci.pwn-request')) {
        return `C1 合法工作流被误报 ci.pwn-request：${JSON.stringify(rSafe.results.filter((r) => r.scope === 'ci'))}`
      }
      if (!rSafe.results.some((r) => r.id === 'collab.prt-safe')) {
        return 'C1 合法 pull_request_target 未报 collab.prt-safe'
      }
      const hooksSafe = detectGitHooksState(safeDir)
      if (!hooksSafe.hasConflict
        || !hooksSafe.conflicts.some((c) => c.kind === 'root-hook-config' && c.path === 'package.json#simple-git-hooks')
        || !hooksSafe.conflicts.some((c) => c.kind === 'custom-git-hooks')) {
        return `C1 未探测到 simple-git-hooks 或自定义 .git/hooks：${JSON.stringify(hooksSafe)}`
      }

      const fUnsafe = await survey(unsafeDir)
      if (!fUnsafe.docs.workflowFacts?.checkoutsPrHead
        || (fUnsafe.docs.workflowFacts?.unsafePullRequestTargetWorkflows?.length ?? 0) === 0) {
        return `C1 漏报同文件 refs/pull/.../merge 检出：${JSON.stringify(fUnsafe.docs.workflowFacts)}`
      }
      if (!fUnsafe.docs.workflowFacts?.hasRelease
        || !fUnsafe.docs.workflowFacts?.releaseTools?.includes('jsr-publish')
        || !fUnsafe.docs.workflowFacts?.releaseTools?.includes('dotnet-publish')
        || !fUnsafe.docs.workflowFacts?.releaseTools?.includes('vp-pack')) {
        return `C1 现代发布工具识别不全：${JSON.stringify(fUnsafe.docs.workflowFacts?.releaseTools)}`
      }
      const rUnsafe = await reviewProject(unsafeDir)
      if (!rUnsafe.results.some((r) => r.id === 'ci.pwn-request' && r.level === 'missing')) {
        return 'C1 危险 refs/pull/.../merge 检出未在 review 报 ci.pwn-request'
      }
      const hooksUnsafe = detectGitHooksState(unsafeDir)
      if (hooksUnsafe.hasConflict) {
        return `C1 空 hook 或 .sample 不应判为冲突：${JSON.stringify(hooksUnsafe)}`
      }
      return true
    } finally {
      rmTree(safeDir)
      rmTree(unsafeDir)
    }
  }])

  cases.push(['W6A C2：.slnx/MinVer/Benchmarks、Deno/JSR、pnpm 继承与 ! glob、Linter 隔离及 survey 零写入（正反双向）', async () => {
    if (!matchGlobList('packages/a', ['packages/*', '!**/test/**'])) {
      return 'matchGlobList 正向 packages/a 失败'
    }
    if (matchGlobList('packages/a/test', ['packages/*', '!**/test/**', '!packages/excluded'])
      || matchGlobList('packages/excluded', ['packages/*', '!**/test/**', '!packages/excluded'])) {
      return 'matchGlobList 未按 ! 负向排除'
    }

    // 1. .NET (.slnx + MinVer + Benchmarks vs Tests)
    const dotnetDir = tmpProject({
      'README.md': '# dotnet-demo\n\n.slnx + MinVer + Benchmarks test.\n',
      'App.slnx': '<Solution><Project Path="src/Core/Core.csproj" /></Solution>\n',
      'Directory.Build.props': '<Project><ItemGroup><PackageReference Include="MinVer" Version="5.0.0" /></ItemGroup></Project>\n',
      'src/Core/Core.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n',
      'benchmarks/Benchmarks/Benchmarks.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="BenchmarkDotNet" Version="0.13.0" /></ItemGroup></Project>\n',
      'tests/Core.Tests/Core.Tests.csproj': '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /><PackageReference Include="xunit" Version="2.6.0" /></ItemGroup></Project>\n',
      '.github/workflows/release.yml': 'name: Release\non:\n  push:\n    tags: ["v*"]\njobs:\n  pub:\n    runs-on: ubuntu-latest\n    steps:\n      - run: dotnet nuget push *.nupkg\n',
    })

    // 2. Deno/JSR + pnpm-workspace.yaml 继承与 ! 负向排除 + 无清单目录不爆炸 + 根 Linter 探测
    const denoPnpmDir = tmpProject({
      'README.md': '# deno-pnpm\n\nJSR and pnpm workspace test.\n',
      'deno.jsonc': '{\n  // deno config\n  "name": "@scope/deno-app",\n  "version": "0.2.0",\n  "exports": "./mod.ts",\n  "tasks": { "test": "deno test -A", "check": "deno check mod.ts" }\n}\n',
      'jsr.json': JSON.stringify({ name: '@scope/jsr-pkg', version: '0.3.0', exports: './mod.ts' }),
      'pnpm-workspace.yaml': 'packages:\n  - "packages/*"\n  - "!packages/ignored-pkg"\n  - "!**/fixtures/**"\n',
      'package.json': JSON.stringify({ name: 'pnpm-root', private: true }),
      'packages/api/package.json': JSON.stringify({ name: '@repo/api', version: '1.0.0', scripts: { test: 'vitest run' } }),
      'packages/ignored-pkg/package.json': JSON.stringify({ name: '@repo/ignored', version: '1.0.0' }),
      'packages/empty-folder/notes.txt': 'not a package\n',
      'packages/fixtures/demo/package.json': JSON.stringify({ name: '@repo/fixture', version: '1.0.0' }),
      '.oxlintrc.json': JSON.stringify({ rules: {} }),
      'dprint.json': JSON.stringify({ typescript: {} }),
    })
    gitInit(denoPnpmDir)

    try {
      const fDot = await survey(dotnetDir)
      if (!fDot.ecosystem.kinds.includes('dotnet') || !fDot.ecosystem.manifests.includes('App.slnx')) {
        return `C2 未识别 .slnx：${JSON.stringify(fDot.ecosystem)}`
      }
      if (fDot.commandsByEcosystem['benchmarks/Benchmarks']?.test) {
        return `C2 Benchmarks 误选了 dotnet test：${JSON.stringify(fDot.commandsByEcosystem)}`
      }
      if (!fDot.commandsByEcosystem['tests/Core.Tests']?.test?.includes('dotnet test')) {
        return `C2 明确测试工程漏选 dotnet test：${JSON.stringify(fDot.commandsByEcosystem)}`
      }
      const tpl = readFileSync(join(process.cwd(), 'templates', 'agents-project.md'), 'utf8')
      const dotAgents = renderAgentsTemplate(fDot, tpl, dotnetDir, {})
      if (dotAgents.includes('`*.csproj`') || !dotAgents.includes('MinVer')) {
        return `C2 MinVer 版本源被 *.csproj 覆盖：\n${dotAgents.slice(0, 1200)}`
      }

      const fDp = await survey(denoPnpmDir)
      if (!fDp.ecosystem.kinds.includes('deno') || fDp.ecosystem.declaredVersion !== '0.3.0' || !fDp.ecosystem.publishable) {
        return `C2 Deno/JSR 提取失败：${JSON.stringify(fDp.ecosystem)}`
      }
      const pkgs = fDp.workspace?.packages ?? []
      if (!pkgs.includes('packages/api')) return `C2 合法 pnpm 子包未识别：${JSON.stringify(pkgs)}`
      if (pkgs.includes('packages/ignored-pkg') || pkgs.includes('packages/empty-folder') || pkgs.includes('packages/fixtures/demo')) {
        return `C2 ! 负向 glob 或 hasManifest 边界失效：${JSON.stringify(pkgs)}`
      }
      if (fDp.ecosystem.packageManager !== 'pnpm') {
        return `C2 pnpm-workspace.yaml 未推导 packageManager=pnpm：${fDp.ecosystem.packageManager}`
      }
      if (fDp.commandsByEcosystem['packages/api']?.test !== 'pnpm --dir packages/api test'
        && fDp.commandsByEcosystem['packages/api']?.test !== 'pnpm test') {
        return `C2 子包未继承 pnpm 命令：${JSON.stringify(fDp.commandsByEcosystem['packages/api'])}`
      }

      const checkers = detectOptionalNativeCheckers(denoPnpmDir)
      const cfgTools = (checkers.configured ?? []).map((a) => a.tool)
      if (!checkers.hasNativeConfig || !cfgTools.includes('oxlint') || !cfgTools.includes('dprint') || 'agentIgnoreAdvice' in checkers) {
        return `C2 detectOptionalNativeCheckers 契约异常（应保留 configured/hasNativeConfig 且无 agentIgnoreAdvice）：${JSON.stringify(checkers)}`
      }

      // 严格零写入：survey() 不得写入 .git/project-forge-flow/session-state.json
      const ssPath = join(denoPnpmDir, '.git', 'project-forge-flow', 'session-state.json')
      if (existsSync(ssPath)) {
        return `C2 survey() 违反零写入不变量，创建了 ${ssPath}`
      }
      return true
    } finally {
      rmTree(dotnetDir)
      rmTree(denoPnpmDir)
    }
  }])

  cases.push(['W6A C3：backup 取消 512KB index.json 截断 + handoff 锁文件/大资产/软链豁免与 --strict-clean（正反双向）', async () => {
    const bkEnvDir = tmpProject({})
    const dir = tmpProject({
      'README.md': '# c3-handoff\n\nClean repo with lockfile, large static json and symlink.\n',
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n' + 'pkg: 1\n'.repeat(50000),
      'uv.lock': 'version = 1\n' + '[[package]]\n'.repeat(40000),
      'data/static.json': JSON.stringify({ items: Array.from({ length: 15000 }, (_, i) => ({ id: i, v: 'x'.repeat(20) })) }),
      'docs/guide.md': '# Guide\n\nClean doc.\n',
      '.agents/skills/.pf-manifest.json': JSON.stringify({
        schemaVersion: 3,
        forgeVersion: '6.0.0',
        files: { 'dev-flow/SKILL.md': { sha256: 'abc' } },
      }),
      '.agents/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: flow\n---\n',
      'AGENTS.md': '<!-- project-forge: begin 项目定位 -->\n## 项目定位\n\nDemo.\n<!-- project-forge: end 项目定位 -->\n',
    })
    gitInit(dir)
    const env = { ...process.env, PF_BACKUP_DIR: bkEnvDir }
    try {
      // 1. backup 精简条目（不写冗长 existingPaths）+ 读 >512KB 旧 index.json 不截断
      const bk1 = createBackup(dir, { label: 'pre-forge', env })
      if (!bk1.created) return `backup 创建失败：${JSON.stringify(bk1)}`
      const indexPath = join(bk1.backupDir, 'index.json')
      const idxObj = JSON.parse(readFileSync(indexPath, 'utf8'))
      if ('existingPaths' in (idxObj.backups[0] ?? {})) {
        return 'C3 backup index.json 未精简冗余 existingPaths'
      }
      // 人为膨胀 index.json 至 > 600KB 测试大体积无截断读取
      idxObj.backups[0].existingPaths = Array.from({ length: 28000 }, (_, i) => `fake/path/item-${i}.txt`)
      const bigJson = JSON.stringify(idxObj)
      if (Buffer.byteLength(bigJson, 'utf8') <= 512 * 1024) return '测试前置条件：index.json 应 > 512KB'
      writeFileSync(indexPath, bigJson, 'utf8')
      if (!readJsonSafe(indexPath, Infinity)) return 'readJsonSafe(indexPath, Infinity) 读取 >512KB 失败'
      const listed = listBackups(dir, { env })
      if (listed.backups.length !== 1) return `listBackups 读取 >512KB index.json 截断：${listed.backups.length}`
      const restored = restoreBackup(dir, { id: bk1.id, dryRun: true, env })
      if (!restored.ok) return `restoreBackup 读取 >512KB index.json 失败：${JSON.stringify(restored)}`

      // 2. handoff 合法软链豁免 + 锁文件 + 大数据资产不触发 truncated；ongoing --upgrade 放行 vs --strict-clean 阻断
      let symCreated = false
      try {
        mkdirSync(join(dir, 'packages', 'sub'), { recursive: true })
        symlinkSync('../../AGENTS.md', join(dir, 'packages', 'sub', 'AGENTS.md'))
        symCreated = true
      } catch { /* 无权限创建软链时跳过软链子断言 */ }

      const sManaged = handoffScan(dir)
      if (sManaged.truncated) {
        return `C3 锁文件/大数据静态资产/合法软链误触发 truncated：${JSON.stringify(sManaged.scanCoverage)}`
      }
      if ((sManaged.scanCoverage?.skippedLockfiles ?? 0) < 2) {
        return `C3 skippedLockfiles 统计缺失：${JSON.stringify(sManaged.scanCoverage)}`
      }
      if (symCreated && (sManaged.scanCoverage?.skippedSymlinks ?? 0) < 1) {
        return `C3 skippedSymlinks 统计缺失：${JSON.stringify(sManaged.scanCoverage)}`
      }
      const vManaged = await runNode('handoff.mjs', [dir, '--verify'])
      if (vManaged.status !== 0) {
        return `C3 持续 --upgrade 受管态应返回 0，实为 ${vManaged.status}: ${vManaged.stdout}`
      }
      const vStrict = await runNode('handoff.mjs', [dir, '--verify', '--strict-clean'])
      if (vStrict.status !== 1) {
        return `C3 --strict-clean 应要求剥离标记返回 1，实为 ${vStrict.status}`
      }

      // 反面：未填 fill 即使无 --strict-clean 也必须返回 1
      writeFileSync(join(dir, 'AGENTS.md'), '<!-- project-forge: fill 项目定位：待填 -->\n', 'utf8')
      const vFill = await runNode('handoff.mjs', [dir, '--verify'])
      if (vFill.status !== 1) return `C3 含未填 fill 仍应返回 1，实为 ${vFill.status}`

      return true
    } finally {
      rmTree(bkEnvDir)
      rmTree(dir)
    }
  }])

  cases.push(['W6A C4：动态 ${...} PEM 豁免、.env* 夹具扫描、secrets-are-placeholders 统一消解与 ! 放行输出目录（正反双向）', async () => {
    // 1. 动态 PEM 模板字面量 vs 真实静态 PEM
    const dynLine = 'const tpl = `-----BEGIN PRIVATE KEY-----\\n${body}`'
    if (!isDynamicPemTemplateLine(dynLine)) return 'isDynamicPemTemplateLine 未识别动态 PEM 插值'
    const realPem = `-----BEGIN RSA ${'PRIVATE'} KEY-----\nMIIEowIBAAKCAQEA1234567890\n-----END RSA PRIVATE KEY-----\n`

    // 2. 无害夹具与 ! 放行目录
    const cleanDir = tmpProject({
      'README.md': '# c4-clean\n\nClean fixtures and negated output dirs.\n',
      '.gitignore': 'dist/\n!dist/kept/\nnode_modules/\n',
      'src/pem-helper.mjs': `export const mkPem = (body) => \`-----BEGIN PRIVATE KEY-----\\n\${body}\\n-----END PRIVATE KEY-----\`;\n`,
      'tests/fixtures/.env.test': 'API_URL=http://localhost:3000\nAPI_KEY=placeholder_key\n',
      'tests/fixtures/node_modules/pkg/index.js': 'export const ok = 1\n',
      'dist/kept/bundle.js': 'export const kept = 1\n',
    })
    gitInit(cleanDir)

    // 3. 真实 .env 秘钥 + secrets-are-placeholders 统一消解 secrets.tracked 与 secrets.exposed
    const fakeGhp = `ghp_${'z9y8x7w6v5u4t3s2r1q0p9o8n7m6l5k4j3i2'}`
    const secretDir = tmpProject({
      'README.md': '# c4-secrets\n\nEnv secret content and placeholder decision.\n',
      'tests/fixtures/.env.secret': `GITHUB_TOKEN=${fakeGhp}\n`,
      '.env.local': `AWS_KEY=${'AKIA'}IOSFODNN7EXAMPLE\n`,
    })
    gitInit(secretDir)

    try {
      const fClean = await survey(cleanDir)
      if (fClean.risks.secretContent.length > 0) {
        return `C4 动态 PEM 模板字面量误报 secretContent：${JSON.stringify(fClean.risks.secretContent)}`
      }
      if (fClean.risks.secretFiles.some((f) => f.file === 'tests/fixtures/.env.test')) {
        return `C4 无害测试夹具 .env.test 误报 secretFiles：${JSON.stringify(fClean.risks.secretFiles)}`
      }
      if (fClean.ignores.unignoredOutputDirs.length > 0) {
        return `C4 100% 跟踪 node_modules 夹具或 !dist/kept/ 放行目录误报 output-dirs：${JSON.stringify(fClean.ignores.unignoredOutputDirs)}`
      }

      const fSec = await survey(secretDir)
      if (!fSec.risks.secretContent.some((s) => s.file === 'tests/fixtures/.env.secret')
        || !fSec.risks.secretContent.some((s) => s.file === '.env.local')) {
        return `C4 .env* 真实凭据正文漏扫：${JSON.stringify(fSec.risks.secretContent)}`
      }
      // 真实静态 PEM 仍严格拦截
      writeFileSync(join(secretDir, 'src-pem.txt'), realPem, 'utf8')
      gitCommitFast(secretDir, 'add static pem')
      const fPem = await survey(secretDir)
      if (!fPem.risks.secretContent.some((s) => s.file === 'src-pem.txt')) {
        return `C4 真实静态 PEM 块漏报：${JSON.stringify(fPem.risks.secretContent)}`
      }

      const rBefore = await reviewProject(secretDir)
      if (!rBefore.results.some((r) => r.id === 'secrets.tracked' && r.level === 'missing')) {
        return `C4 未表态时应报 secrets.tracked missing：${JSON.stringify(rBefore.results.filter((r) => r.scope === 'secrets'))}`
      }
      writeFileSync(join(secretDir, 'AGENTS.md'), '# c4-secrets\n\n## 取舍\n\n- `secrets-are-placeholders`：均为测试占位\n', 'utf8')
      const rAfter = await reviewProject(secretDir)
      if (rAfter.missing.some((r) => r.id === 'secrets.tracked' || r.id === 'secrets.exposed')) {
        return `C4 表态 secrets-are-placeholders 后未同时消解 tracked/exposed：${JSON.stringify(rAfter.missing)}`
      }
      if (isSensitiveSecretFile('.env.test', 'PORT=3000\nAPI_KEY=placeholder\n', 'tests/fixtures/.env.test')) {
        return 'C4 isSensitiveSecretFile 对无害夹具 .env.test 误报'
      }
      return true
    } finally {
      rmTree(cleanDir)
      rmTree(secretDir)
    }
  }])

  cases.push(['W6A C5：模板空骨架 <16KB、14KB 存量 --upgrade <30KB、零指导语泄漏与小写/软链 agents.md 保留（正反双向）', async () => {
    const dir = tmpProject({
      'README.md': '# c5-slim\n\nSlim AGENTS skeleton and symlink/lowercase test.\n',
      'package.json': JSON.stringify({ name: 'c5-slim', version: '1.0.0', scripts: { test: 'node --test' } }),
      'CLAUDE.md': '# legacy rules\n',
    })
    gitInit(dir)

    const lowerDir = tmpProject({
      'README.md': '# c5-lower\n\nLowercase agents.md preservation.\n',
      'agents.md': '# c5-lower\n\n## 项目定位\n\n小写文件名测试。\n\n## 构建与验证\n\n`node --test`\n\n## 修改守则\n\n保持简洁。\n',
    })
    gitInit(lowerDir)

    const symDir = tmpProject({
      'README.md': '# c5-sym\n\nSymlink agents.md preservation.\n',
      'docs/shared-agents.md': '# c5-sym\n\n## 项目定位\n\n共享契约。\n\n## 构建与验证\n\n`node --test`\n\n## 修改守则\n\n保持简洁。\n',
    })
    gitInit(symDir)

    try {
      // 1. 新渲染空骨架 < 16KB 且零指导语泄漏
      const c5Gen = await runNode('compose-agents.mjs', [dir, '--no-backup'])
      if (c5Gen.status !== 0) return `C5 compose-agents 生成失败：${c5Gen.stderr}`
      const genText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      const genBytes = Buffer.byteLength(genText, 'utf8')
      if (genBytes >= 16384) return `C5 新渲染受管骨架体积 ${genBytes}B >= 16KB`
      for (const leak of ['CONVENTIONS_HINT', '暂未追加', '目录结尾带', '逐条读一遍', '合完问用户']) {
        if (genText.includes(leak)) return `C5 新骨架仍泄漏指导语「${leak}」`
      }

      // 2. 14KB 存量手写 AGENTS.md 执行 --upgrade 后总体积 <= 30720B
      const hand14k = `# c5-slim\n\n## 项目定位\n\n手写说明。\n\n## 自定义手册\n\n${'x'.repeat(14 * 1024)}\n`
      writeFileSync(join(dir, 'AGENTS.md'), hand14k, 'utf8')
      const upRes = await runNode('compose-agents.mjs', [dir, '--upgrade', '--no-backup'])
      if (upRes.status !== 0) return `C5 14KB 存量 --upgrade 失败：${upRes.stderr}`
      const upBytes = readFileSync(join(dir, 'AGENTS.md')).byteLength
      if (upBytes > 30720) return `C5 14KB 存量 --upgrade 后超 30KB：${upBytes}B`

      // 3. 小写 agents.md 保留大小写且不新建 AGENTS.md
      const lowUp = await runNode('compose-agents.mjs', [lowerDir, '--upgrade', '--no-backup'])
      if (lowUp.status !== 0) return `C5 小写 agents.md --upgrade 失败：${lowUp.stderr}`
      let lowText = readFileSync(join(lowerDir, 'agents.md'), 'utf8')
      if (!lowText.includes('<!-- project-forge: begin')) return 'C5 未写回原小写 agents.md'
      lowText = lowText
        .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填完。')
        .replace(/^((?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit):\s*)<[^>\n]+>/gm, '$1none')
      writeFileSync(join(lowerDir, 'agents.md'), lowText, 'utf8')
      const lowChk = await runNode('compose-agents.mjs', [lowerDir, '--check'])
      if (lowChk.status !== 0) return `C5 小写 agents.md --check 失败：${lowChk.stderr}`
      if (!readdirSync(lowerDir).includes('agents.md') || readdirSync(lowerDir).includes('AGENTS.md')) {
        return 'C5 小写 agents.md 文件名未保留或重复生成了 AGENTS.md'
      }

      // 4. 有效软链保持软链不破坏；悬空与越界软链拒绝覆盖（退出码 2）
      let canSymlink = false
      try {
        symlinkSync('docs/shared-agents.md', join(symDir, 'agents.md'))
        canSymlink = true
      } catch { /* 无软链权限时跳过 */ }
      if (canSymlink) {
        const symUp = await runNode('compose-agents.mjs', [symDir, '--upgrade', '--no-backup'])
        if (symUp.status !== 0) return `C5 合法软链 --upgrade 失败：${symUp.stderr}`
        if (!lstatSync(join(symDir, 'agents.md')).isSymbolicLink()) return 'C5 写入破坏了 agents.md 软链'
        if (readlinkSync(join(symDir, 'agents.md')).replace(/\\/g, '/') !== 'docs/shared-agents.md') return 'C5 软链指向改变'
        let sharedText = readFileSync(join(symDir, 'docs/shared-agents.md'), 'utf8')
        if (!sharedText.includes('<!-- project-forge: begin')) {
          return 'C5 未通过 realpath 写回软链目标文件'
        }
        sharedText = sharedText
          .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填完。')
          .replace(/^((?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit):\s*)<[^>\n]+>/gm, '$1none')
        writeFileSync(join(symDir, 'docs/shared-agents.md'), sharedText, 'utf8')
        const symChk = await runNode('compose-agents.mjs', [symDir, '--check'])
        if (symChk.status !== 0) return `C5 合法软链 --check 失败：${symChk.stderr}`
        if (!lstatSync(join(symDir, 'agents.md')).isSymbolicLink()) return 'C5 --check 后软链状态改变'

        // 反面：悬空软链必须报退出码 2
        const dangleDir = tmpProject({ 'README.md': '# dangle\n' })
        try {
          symlinkSync('missing-target.md', join(dangleDir, 'agents.md'))
          const dRes = await runNode('compose-agents.mjs', [dangleDir, '--upgrade', '--no-backup'])
          if (dRes.status !== 2) return `C5 悬空软链未以退出码 2 拒绝覆盖：status=${dRes.status}`
        } finally {
          rmTree(dangleDir)
        }
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(lowerDir)
      rmTree(symDir)
    }
  }])
}
