/**
 * fixtures-w6b-kit-hygiene.mjs —— Wave 6 Slice 6B（C7..C12, C19）正反双向行为断言。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { collectDocClaims } from '../../kit/skills/lib/doc-facts.mjs'
import { verifyDocClaims } from '../../kit/skills/lib/doc-verify.mjs'
import { evaluateIntakeTriage } from '../../kit/skills/lib/intake-triage.mjs'
import { evaluateTextSubstance } from '../../kit/skills/lib/evidence-substance.mjs'
import { findChangelogVoice } from '../../kit/skills/lib/no-changelog-voice.mjs'
import {
  TEST_CASE_RE, UI_VISUAL_EXT_RE, isTestOrFixtureFile, scanStructuralHygiene,
} from '../../kit/skills/lib/static-gates.mjs'
import { prefillFeatureMapFromRepoMap } from '../../kit/skills/lib/feature-map.mjs'
import { generateRepoMap } from '../../kit/skills/dev-explore/scripts/repo-map.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { assessStructuralGate } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { SKILL_ROOT, gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

export function registerW6bKitHygieneCases(cases) {
  cases.push(['W6B C7：SUBCOMMAND_META 单源、subcommand-parity 对拍与 doc-verify/triage-rules 消费（正反双向）', async () => {
    const metaMod = await import('../../kit/skills/lib/subcommand-meta.mjs')
    const parityMod = await import('./subcommand-parity.mjs')

    if (!metaMod.SUBCOMMAND_META || typeof metaMod.subcommandNamesFor !== 'function'
      || typeof metaMod.mutatingSubcommandsFor !== 'function' || typeof metaMod.allSubcommandNames !== 'function') {
      return 'subcommand-meta.mjs 缺少 SUBCOMMAND_META / subcommandNamesFor / mutatingSubcommandsFor / allSubcommandNames'
    }
    for (const tool of ['flow', 'doc-plan', 'govern-audit', 'review-pack', 'verify-tools', 'iterate']) {
      const names = metaMod.subcommandNamesFor(tool)
      if (!Array.isArray(names) || names.length === 0) return `SUBCOMMAND_META 缺少工具 ${tool}`
    }
    const flowMutating = metaMod.mutatingSubcommandsFor('flow')
    if (!flowMutating.includes('intake') || !flowMutating.includes('milestone') || flowMutating.includes('inspect')) {
      return `flow mutatingSubcommandsFor 判定异常：${JSON.stringify(flowMutating)}`
    }
    const parityRes = parityMod.evaluateSubcommandParity(SKILL_ROOT)
    if (!parityRes.ok) return `subcommand-parity 对拍失败：${parityRes.failures.join('；')}`

    // 反向：doc-verify 拒绝变更型子命令（含新增的 intake / critique-reject / cycle）
    const dir = tmpProject({ 'README.md': '# c7\n\nSubcommand check.\n', 'src/app.mjs': 'export const ok = true\n' })
    gitInit(dir)
    try {
      const verify = await verifyDocClaims(dir, [
        '`node .agents/skills/dev-flow/scripts/flow.mjs intake --pr 1`',
        '`node .agents/skills/dev-plan/scripts/doc-plan.mjs critique-reject --file a.md`',
        '`node .agents/skills/dev-iterate/scripts/iterate.mjs cycle`',
      ].join('\n'))
      const ranBad = verify.commands.filter((c) => c.ran)
      if (ranBad.length > 0) return `doc-verify 误执行了变更型子命令：${JSON.stringify(ranBad)}`
    } finally {
      rmTree(dir)
    }

    // 正向：iterate --help 包含 cycle
    const itHelp = await runAbsAsync('kit/skills/dev-iterate/scripts/iterate.mjs', ['--help'])
    if (itHelp.status !== 0 || !itHelp.stdout.includes('cycle')) {
      return `iterate.mjs --help 缺少 cycle：${itHelp.stdout}`
    }
    return true
  }])

  cases.push(['W6B C8：doc-verify COMMON_SKIP_DIRS、多语言 PATH_RE 与安全只读多生态命令核查（正反双向）', async () => {
    const claims = collectDocClaims([
      '`src/main.rs`',
      '`pkg/handler/auth.go`',
      '`app/service.py`',
      '`src/Core/Core.csproj`',
      '`App.slnx`',
      '`src/components/App.tsx`',
      '`cargo --version`',
      '`git status`',
      '`cargo install evil-pkg`',
      '`python -c "import os"`',
    ].join('\n'))
    for (const p of ['src/main.rs', 'pkg/handler/auth.go', 'app/service.py', 'src/Core/Core.csproj', 'src/components/App.tsx']) {
      if (!claims.paths.includes(p)) return `PATH_RE 漏识多语言路径 ${p}：${JSON.stringify(claims.paths)}`
    }
    if (!claims.commands.includes('cargo --version')) return `CMD_RE 漏识 cargo 命令：${JSON.stringify(claims.commands)}`

    const dir = tmpProject({
      '.gitignore': '',
      'AGENTS.md': '# c8\n\n## Dev Profile\n```yaml\nquick-test: node --version\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\n```\n',
      'src/main.rs': 'pub fn forge_entry_rust() {}\n',
      'target/debug/generated.rs': 'pub fn target_leak_symbol() {}\n',
      '.venv/lib/site.py': 'def venv_leak_symbol(): pass\n',
    })
    gitInit(dir)
    try {
      const res = await verifyDocClaims(dir, [
        '符号 `forge_entry_rust` 与 `target_leak_symbol` 与 `venv_leak_symbol`。',
        '命令 `node --version` 与 `cargo install evil-pkg` 与 `git push origin main` 与 `npm install foo`。',
      ].join('\n'))
      const nameOk = new Map(res.names.map((n) => [n.name, n.ok]))
      if (!nameOk.get('forge_entry_rust')) return 'doc-verify 漏扫 src/main.rs 中的符号'
      if (nameOk.get('target_leak_symbol') || nameOk.get('venv_leak_symbol')) {
        return `doc-verify 未跳过 COMMON_SKIP_DIRS (target/.venv)：${JSON.stringify(res.names)}`
      }
      const cmdMap = new Map(res.commands.map((c) => [c.cmd, c]))
      if (!cmdMap.get('node --version')?.ran || !cmdMap.get('node --version')?.ok) {
        return `doc-verify 未执行安全只读/Dev Profile 命令：${JSON.stringify(res.commands)}`
      }
      for (const unsafeCmd of ['cargo install evil-pkg', 'git push origin main', 'npm install foo']) {
        if (cmdMap.get(unsafeCmd)?.ran) return `doc-verify 误执行了带副作用命令 ${unsafeCmd}`
      }
    } finally {
      rmTree(dir)
    }
    return true
  }])

  cases.push(['W6B C9：kit/ 去本仓自用泄漏（动态读取目标仓 Non-Goals 与红线，静态门禁防回流）', async () => {
    const ev = evaluateTextSubstance('ok')
    if (/survey\.mjs/.test(ev.reason ?? '')) {
      return `evidence-substance.mjs 仍泄漏 survey.mjs 示例：${ev.reason}`
    }

    const dir = tmpProject({
      'README.md': '# acme-payments\n',
      'AGENTS.md': [
        '# acme-payments',
        '',
        '## 关键不变量',
        '- 禁止使用明文信用卡号落盘日志。',
        '',
      ].join('\n'),
      'docs/ARCHITECTURE.md': [
        '# Architecture',
        '',
        '## Non-Goals',
        '- Do not build cryptocurrency mining or desktop Electron shell.',
        '',
      ].join('\n'),
    })
    try {
      const hit = evaluateIntakeTriage(dir, {
        targetType: 'issue',
        targetNumber: 12,
        title: 'Add desktop Electron shell and cryptocurrency mining worker',
        body: 'Bundle an Electron desktop wrapper and cryptocurrency mining daemon.',
      })
      if (hit.decision !== 'reject') {
        return `intake-triage 未动态识别目标仓 ARCHITECTURE.md Non-Goals：${JSON.stringify(hit)}`
      }
      if (hit.tddRefs.some((r) => r.includes('SKILL.md') || r.includes('docs/TDD.md#技术基线'))) {
        return `intake-triage 仍硬编码本仓私有锚点：${JSON.stringify(hit.tddRefs)}`
      }
      const pass = evaluateIntakeTriage(dir, {
        targetType: 'issue',
        targetNumber: 13,
        title: 'Add lodash and React UI dashboard',
        body: 'Use lodash helper and generate React UI components for invoices.',
      })
      if (pass.decision === 'reject') {
        return `intake-triage 对外部仓误套用了本仓零第三方依赖/不生成业务代码硬编码规则：${JSON.stringify(pass)}`
      }
    } finally {
      rmTree(dir)
    }

    // 静态防泄漏检查函数存在且对当前仓库通过，并对含泄漏的 kit/ 返回阻断（正反双向）
    const suite = await import('./preflight-suite.mjs')
    if (typeof suite.scanKitPrivateLeaks !== 'function') {
      return 'preflight-suite.mjs 未导出 scanKitPrivateLeaks 静态防泄漏扫描函数'
    }
    const leaks = suite.scanKitPrivateLeaks(SKILL_ROOT)
    if (leaks.length > 0) return `kit/ 仍存在本仓私有泄漏：${leaks.slice(0, 5).join('；')}`
    const leakDir = tmpProject({
      'kit/skills/lib/bad-leak.mjs': "export const x = 'verify-injections'\nexport const cmd = 'node scripts/survey.mjs .'\n",
    })
    try {
      const badLeaks = suite.scanKitPrivateLeaks(leakDir)
      if (!badLeaks.some((l) => l.includes('verify-injections')) || !badLeaks.some((l) => l.includes('scripts/survey.mjs'))) {
        return `scanKitPrivateLeaks 漏报 kit/ 本仓私有符号或脚本泄漏：${JSON.stringify(badLeaks)}`
      }
    } finally {
      rmTree(leakDir)
    }
    return true
  }])

  cases.push(['W6B C10：单源履历词形引擎（剥离字面量查 .mjs 注释，识别新词形）与基线清零', async () => {
    const voiceMod = await import('../../kit/skills/lib/no-changelog-voice.mjs')
    const sgMod = await import('../../kit/skills/lib/static-gates.mjs')
    if (!(voiceMod.CHANGELOG_VOICE_TOMBSTONE_RE instanceof RegExp)) {
      return 'no-changelog-voice.mjs 未导出 CHANGELOG_VOICE_TOMBSTONE_RE'
    }
    if (!(sgMod.TOMBSTONE_COMMENT_RE instanceof RegExp)) {
      return 'static-gates.mjs 未保留 TOMBSTONE_COMMENT_RE 兼容导出'
    }

    // 正向：.mjs 真实注释中的新增履历词形必须被捕获（且字符串字面量不被误报）
    const mjsCode = [
      'const msg = "原来的做法和以前写在字符串里不算履历";',
      '// 原来的做法是把状态存在全局对象里。',
      '// 原来在这里写死了一个路径，以前写在三个文件里。',
    ].join('\n')
    const hits = findChangelogVoice(mjsCode, { file: 'demo.mjs' })
    if (hits.length !== 2 || hits[0].line !== 2 || hits[1].line !== 3) {
      return `.mjs 字面量剥离或新词形识别异常（预期 2/3 行命中，实际=${JSON.stringify(hits)}）`
    }

    // 反向：合法现状描述（这里原来没有校验）不误报
    const cleanMd = '## 现状\n这里原来没有校验，现在补充入口。\n'
    if (findChangelogVoice(cleanMd, { file: 'doc.md' }).length > 0) {
      return '合法现状描述被误判为履历体'
    }

    // 基线必须清零
    const baseline = JSON.parse(readFileSync(join(SKILL_ROOT, '.github', 'changelog-voice-baseline.json'), 'utf8'))
    if (Object.keys(baseline).length !== 0) {
      return `.github/changelog-voice-baseline.json 未清零：${JSON.stringify(baseline)}`
    }
    return true
  }])

  cases.push(['W6B C11：feature-map/repo-map 精度、UI_VISUAL_EXT_RE/TEST_CASE_RE、govern 静默基线/译文/VitePress/build', async () => {
    // 1. UI_VISUAL_EXT_RE 与 isUiVisualFile 免疫测试/夹具，不放行正常界面文件
    if (UI_VISUAL_EXT_RE.test('src/components/Button.test.tsx')
      || UI_VISUAL_EXT_RE.test('tests/App.tsx')
      || UI_VISUAL_EXT_RE.test('src/__fixtures__/Card.vue')
      || UI_VISUAL_EXT_RE.test('test/fixtures/page.html')) {
      return 'UI_VISUAL_EXT_RE 仍对测试或夹具路径返回 true'
    }
    if (!UI_VISUAL_EXT_RE.test('src/components/Contest.tsx') || !UI_VISUAL_EXT_RE.test('src/pages/SpecView.vue')) {
      return 'UI_VISUAL_EXT_RE 误排除了名称含 test/spec 的真实界面组件'
    }

    // 2. TEST_CASE_RE 不把 re.test(file) 算成用例声明
    if (TEST_CASE_RE.test('if (re.test(file)) return true')) {
      return 'TEST_CASE_RE 误匹配了成员调用 re.test(file)'
    }
    if (!TEST_CASE_RE.test('  test("real case", () => {})') || !TEST_CASE_RE.test('it.skip("s", () => {})')) {
      return 'TEST_CASE_RE 漏匹配真实测试用例'
    }

    // 3. feature-map 同生态匹配 + 过滤 dist/.github/workflows/*.test.* + repo-map 过滤
    const fmDir = tmpProject({})
    let fmOut
    try {
      fmOut = prefillFeatureMapFromRepoMap(fmDir, {
        testFiles: ['app_test.go', 'apply_test.go', 'tests/app.test.tsx', 'tests/apply.test.ts'],
        featureMap: [
          { feature: 'App', source: 'src/App.tsx', verifyCmd: 'npm test' },
          { feature: 'DistLeak', source: 'dist/bundle.js', verifyCmd: 'npm test' },
          { feature: 'CiLeak', source: '.github/workflows/ci.yml', verifyCmd: 'npm test' },
        ],
        businessFlows: {
          flows: [{ name: 'ci', surface: 'job', entry: '.github/workflows/ci.yml', source: '.github/workflows/ci.yml' }],
        },
      })
    } finally {
      rmTree(fmDir)
    }
    const feats = fmOut.featureMap.features
    const appFeat = feats.find((f) => f.entrypoints.includes('src/App.tsx'))
    if (!appFeat || appFeat.testRefs.includes('app_test.go') || appFeat.testRefs.includes('apply_test.go') || !appFeat.testRefs.includes('tests/app.test.tsx')) {
      return `feature-map 同生态精确匹配异常：${JSON.stringify(appFeat)}`
    }
    if (feats.some((f) => f.entrypoints.some((e) => e.startsWith('dist/') || e.startsWith('.github/workflows/')))) {
      return `feature-map 未过滤 dist/ 或 .github/workflows/：${JSON.stringify(feats)}`
    }

    // 4. repo-map 过滤 dist/ 与 .github/workflows/、govern 译文/VitePress/build 跟踪目录/--save-baseline --quiet
    const monoDir = tmpProject({
      '.gitignore': 'node_modules/\n',
      'README.md': '# mono\n\nMonorepo demo.\n',
      'AGENTS.md': [
        '# mono',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: node --version',
        'full-test: node --version',
        'smoke-verify: none',
        'merge-gate: none',
        '```',
        '',
        '## 取舍',
        '- `no-ci`: none',
        '- `no-tdd`: none',
        '',
      ].join('\n'),
      'dist/index.js': 'console.log(1)\n',
      '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
      'src/main.go': 'package main\nfunc main() {}\n',
      'build/gen.go': 'package build\nfunc Gen() {}\n',
      'docs/zh/guide.md': '# 指南\n\n[broken](./non-existent-zh-only.md)\n',
      'docs/guide/intro.md': '# Intro\n\nSee `/guide/advanced` and `src/index.ts`.\n',
      'docs/guide/advanced.md': '# Advanced\n',
      'packages/web/README.md': '---\nevergreen: true\n---\n# Web\n\nEntry `src/index.ts`.\n',
      'packages/web/src/index.ts': 'export const web = 1\n',
      'tests/unit_bad.test.mjs': '// zero assertions test\nconst x = 1\n',
    })
    gitInit(monoDir)
    gitCommitFast(monoDir, 'chore: init')
    try {
      const rmap = await generateRepoMap(monoDir)
      if (rmap.entrypoints.some((e) => e.startsWith('dist/') || e.startsWith('.github/workflows/'))) {
        return `repo-map entrypoints 未过滤 dist/ 或 .github/workflows/：${JSON.stringify(rmap.entrypoints)}`
      }

      const audRes = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', monoDir, '--save-baseline', '--quiet', '--json'])
      if (audRes.status !== 0) return `govern-audit --save-baseline --quiet 失败：${audRes.stderr}`
      const audJson = JSON.parse(audRes.stdout)
      const ids = (audJson.findings ?? []).map((f) => f.id)
      if (!ids.some((id) => id.startsWith('tests.zero-assertion.'))) {
        return `--save-baseline --quiet 仍跳过了 tests 类别：${JSON.stringify(ids)}`
      }
      if (ids.includes('hygiene.unignored-dir.build')) {
        return `build/ 为纯 Git 跟踪源码目录却误报 hygiene.unignored-dir.build：${JSON.stringify(ids)}`
      }
      if (ids.some((id) => id.includes('docs/zh/guide.md'))) {
        return `govern-docs 未跳过译文目录 docs/zh/：${JSON.stringify(ids)}`
      }
      if (ids.some((id) => id.includes('packages/web/README.md') && id.includes('authority-stale-path'))) {
        return `govern-evergreen 未按子包目录解析 src/index.ts：${JSON.stringify(ids)}`
      }
    } finally {
      rmTree(monoDir)
    }
    return true
  }])

  cases.push(['W6B C12 + C19：edit-gate --base/游离 HEAD 兼容、自动生成源码豁免与纯声明式数据降级（含防绕过反面）', async () => {
    // 1. 跨语言自动生成源码豁免（正反双向）
    const genGo = [
      '// Code generated by protoc-gen-go. DO NOT EDIT.',
      'package pb',
      ...Array.from({ length: 830 }, (_, i) => `var Field${i} = ${i}`),
    ].join('\n') + '\n'
    const genPy = [
      '# AUTO-GENERATED FILE — DO NOT EDIT',
      ...Array.from({ length: 820 }, (_, i) => `K_${i} = ${i}`),
    ].join('\n') + '\n'
    const genRes = scanStructuralHygiene({
      fileRel: 'api/pb/service.pb.go',
      lines: genGo.split('\n'),
      fullText: genGo,
      fullLineCount: 831,
    })
    if (!genRes.generatedExempt || genRes.godFile !== null || genRes.nearLimitFile !== null) {
      return `C19 自动生成 Go 文件未获豁免：${JSON.stringify(genRes)}`
    }
    const genPyRes = scanStructuralHygiene({
      fileRel: 'api/schema_pb2.py',
      lines: genPy.split('\n'),
      fullText: genPy,
      fullLineCount: 821,
    })
    if (!genPyRes.generatedExempt || genPyRes.godFile !== null) {
      return `C19 自动生成 Python 文件未获豁免：${JSON.stringify(genPyRes)}`
    }

    // 反向 1：字符串里的 @generated 或第 25 行注释不得豁免
    const fakeGen = [
      'export const marker = "// @generated DO NOT EDIT"',
      ...Array.from({ length: 24 }, (_, i) => `export function fn${i}() { return ${i} }`),
      '// @generated',
      ...Array.from({ length: 800 }, (_, i) => `export function biz${i}(x) { if (x > ${i}) return x + 1; return 0 }`),
    ].join('\n') + '\n'
    const fakeGenRes = scanStructuralHygiene({
      fileRel: 'src/fake-gen.mjs',
      lines: fakeGen.split('\n'),
      fullText: fakeGen,
      fullLineCount: 826,
    })
    if (fakeGenRes.generatedExempt || !fakeGenRes.godFile) {
      return `C19 字符串伪装或超前20行头标不应豁免：${JSON.stringify(fakeGenRes)}`
    }

    // 2. 纯声明式数据源码降级（正反双向）
    const declTable = [
      'export const ROUTE_CATALOG = {',
      ...Array.from({ length: 820 }, (_, i) => `  'route.${i}': { path: '/v1/items/${i}', title: 'Item ${i}', auth: true },`),
      '}',
    ].join('\n') + '\n'
    const declRes = scanStructuralHygiene({
      fileRel: 'src/routes-catalog.ts',
      lines: declTable.split('\n'),
      fullText: declTable,
      fullLineCount: 822,
    })
    if (declRes.godFile !== null || declRes.nearLimitFile !== null || !declRes.declarativeDataFile) {
      return `C19 纯声明式数据表未降级为 declarativeDataFile：${JSON.stringify(declRes)}`
    }

    // 反向 2：假表绕过（前半段数据表 + 后半段控制流业务逻辑，或大段注释垫行数）仍必须拦截 godFile
    const mixedBypass = [
      'export const TABLE = {',
      ...Array.from({ length: 420 }, (_, i) => `  k${i}: 'v${i}',`),
      '}',
      ...Array.from({ length: 400 }, (_, i) => `export function handle${i}(a) { if (a > ${i}) return a * 2; return 0 }`),
    ].join('\n') + '\n'
    const mixedRes = scanStructuralHygiene({
      fileRel: 'src/mixed-god.ts',
      lines: mixedBypass.split('\n'),
      fullText: mixedBypass,
      fullLineCount: 823,
    })
    if (!mixedRes.godFile || mixedRes.declarativeDataFile) {
      return `C19 混杂业务逻辑的假表不应降级：${JSON.stringify(mixedRes)}`
    }
    const nestedLogicTable = [
      'export const HANDLERS = {',
      ...Array.from({ length: 280 }, (_, i) => `  op${i}: (x) => {\n    if (x > ${i}) return x + 1\n    return 0\n  },`),
      '}',
    ].join('\n') + '\n'
    const nestedLogicLines = nestedLogicTable.split('\n')
    const nestedLogicRes = scanStructuralHygiene({
      fileRel: 'src/nested-handlers.ts',
      lines: nestedLogicLines,
      fullText: nestedLogicTable,
      fullLineCount: nestedLogicLines.length,
    })
    if (!nestedLogicRes.godFile || nestedLogicRes.declarativeDataFile) {
      return `C19 含嵌套控制流与箭头函数的派发表不应降级：${JSON.stringify(nestedLogicRes)}`
    }

    // 3. edit-gate --base + 游离 HEAD + review-gates 不误报 godFiles
    const dir = tmpProject({
      'README.md': '# c12-c19\n',
      'AGENTS.md': '# c12-c19\n\n## Dev Profile\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\narch-rules: none\nhigh-risk: none\ndo-not-edit: none\n```\n',
      'src/base.ts': 'export const base = 1\n',
    })
    gitInit(dir)
    gitCommitFast(dir, 'chore: base')
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'routes-catalog.ts'), declTable, 'utf8')
    writeFileSync(join(dir, 'src', 'service.pb.go'), genGo, 'utf8')
    gitCommitFast(dir, 'feat: add catalog and generated go')
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
    // 切换到游离 HEAD 并执行 edit-gate --changed --base <baseSha>
    execFileSync('git', ['checkout', '--detach', headSha], { cwd: dir, stdio: 'ignore' })
    try {
      const gateRes = await runEditGate({ mode: 'verify', dir, changed: true, base: baseSha })
      if (!gateRes.ok || gateRes.blockers.length > 0) {
        return `edit-gate 在游离 HEAD --base 下对自动生成/纯声明数据误阻断：${JSON.stringify(gateRes.blockers)}`
      }
      if (!gateRes.checkedFiles.includes('src/routes-catalog.ts') || !gateRes.checkedFiles.includes('src/service.pb.go')) {
        return `edit-gate --base 未检出分支改动文件：${JSON.stringify(gateRes.checkedFiles)}`
      }
      const revGate = assessStructuralGate({
        reviewRoot: dir,
        diff: { files: [{ status: 'A', file: 'src/routes-catalog.ts' }, { status: 'A', file: 'src/service.pb.go' }], untracked: [], text: '' },
        devProfile: { 'arch-rules': [] },
        parity: { mermaidViolations: [] },
      })
      if ((revGate.godFiles ?? []).length > 0) {
        return `review-gates assessStructuralGate 对生成/声明文件误报 godFiles：${JSON.stringify(revGate.godFiles)}`
      }
    } finally {
      rmTree(dir)
    }
    return true
  }])
}
