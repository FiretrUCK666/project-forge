/**
 * fixtures-iterate-hotspots.mjs —— 覆盖 dev-iterate plan 识别的 5 大测试盲区与高频热点模块：
 *   1. s1-s4-onboarding-flow：survey -> backup(含恢复验证) -> equip -> compose-agents -> verify-tools -> review -> handoff 全链路 E2E；
 *   2. kit/skills/lib/visual-render.mjs：HTML 壳体渲染、CSP/脚本逃逸安全、零 homedir 路径泄露、浅深色切换与多图视角标签；
 *   3. kit/skills/lib/visual-render-panels.mjs：1:N 波次导航、直接变更 vs 折叠波及、语义截断无损 <details>、快搜筛选钩子与零 XSS；
 *   4. kit/skills/lib/worktree-dep-pool.mjs：Class R/S/I 分层、sha256 只读池挂载、detach/reconcile 漂移脱钩、引用计数 GC 与 NTFS 只读树销毁；
 *   5. kit/skills/lib/exec.mjs：Windows .cmd/.bat CVE-2024-27980 元字符阻断（不抛未捕获异常）、安全参数透传与 PF_CACHE_DIR 隔离重定向。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { computeWorktreeEnv, execSafe, prepareExecInvocation, validateWinBatchArgs } from '../../kit/skills/lib/exec.mjs'
import { buildVisualModel } from '../../kit/skills/lib/visual-layout.mjs'
import { MAX_PROTOTYPE_SRCDOC_BYTES, buildGeneratedHeaderLine, renderVisualHtml } from '../../kit/skills/lib/visual-render.mjs'
import {
  renderBlueprintLandingHtml, renderCommandPaletteHtml, renderDialogsHtml,
  renderInspectorShellHtml, renderPrototypeSlot, renderPrototypeSwitcher,
} from '../../kit/skills/lib/visual-render-panels.mjs'
import {
  classifyHeavyDir, computeUnitDepFingerprint, detachWorktreeUnit, detectGlobalStoreClassRUnits,
  detectUnitDepClass, ensureDepPoolEntry, gcUnusedDepPools, isClassIPath,
  reconcileWorktreeDeps, removeReadOnlyTreeSync, resolveDepPoolRoot, setReadOnlyTreeSync,
} from '../../kit/skills/lib/worktree-dep-pool.mjs'
import { EXIT, gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, runNode, tmpProject } from './fixtures-helpers.mjs'

export function registerIterateHotspotsCases(cases) {
  cases.push(['hotspot-1：s1-s4-onboarding-flow 跨功能全链路 E2E（survey -> backup/restore -> equip -> compose-agents -> verify-tools -> review -> handoff）', async () => {
    const dir = tmpProject({
      'package.json': JSON.stringify({
        name: 's1-s4-demo',
        version: '1.0.0',
        type: 'module',
        scripts: { test: 'node src/app.mjs' },
      }, null, 2),
      '.gitignore': 'node_modules/\n.worktrees/\n',
      'LICENSE': 'MIT License\n',
      'README.md': '# s1-s4-demo\n\nRealistic onboarding E2E target repository.\n',
      'src/app.mjs': 'export function greet(name) { return `hello ${name}` }\n',
    })
    const bkRoot = tmpProject({})
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@acme-fixture.dev' })
      const env = { PF_BACKUP_DIR: bkRoot, PF_NO_REAL_AUTH_PROBE: '1' }

      // S1: 只读勘察 survey
      const sur = await runNode('survey.mjs', [dir, '--json'], { env })
      if (sur.status !== 0) return `S1 survey 失败: exit=${sur.status} err=${sur.stderr}`
      const surJson = JSON.parse(sur.stdout)
      if (!surJson?.target?.path || !Array.isArray(surJson.gaps) || !Array.isArray(surJson.artifactPlan)) {
        return `S1 survey 输出结构缺失: ${sur.stdout.slice(0, 400)}`
      }

      // S2: 写前仓外 .zip 快照备份 + 篡改后完整还原验证
      const bkCreate = await runNode('backup.mjs', ['create', dir, '--label', 's1-s4-e2e', '--json'], { env })
      if (bkCreate.status !== 0) return `S2 backup create 失败: exit=${bkCreate.status} err=${bkCreate.stderr}`
      const bkJson = JSON.parse(bkCreate.stdout)
      if (!bkJson.created || bkJson.format !== 'zip' || !existsSync(bkJson.archivePath)) {
        return `S2 backup 未生成 .zip 归档: ${bkCreate.stdout}`
      }
      const origApp = readFileSync(join(dir, 'src/app.mjs'), 'utf8')
      writeFileSync(join(dir, 'src/app.mjs'), 'export const CORRUPTED = true\n', 'utf8')
      const bkRestore = await runNode('backup.mjs', ['restore', dir, '--id', bkJson.id, '--json'], { env })
      if (bkRestore.status !== 0) return `S2 backup restore 失败: exit=${bkRestore.status} err=${bkRestore.stderr}`
      const restoredApp = readFileSync(join(dir, 'src/app.mjs'), 'utf8')
      if (restoredApp !== origApp) return `S2 backup restore 未还原文件内容: ${restoredApp}`

      // S3: equip 装配 8 技能 + manifest v3 字节级一致性校验
      const eq = await runNode('equip.mjs', [dir], { env })
      if (eq.status !== 0) return `S3 equip 失败: exit=${eq.status} err=${eq.stderr}`
      const eqCheck = await runNode('equip.mjs', [dir, '--check'], { env })
      if (eqCheck.status !== 0 || !existsSync(join(dir, '.agents/skills/.pf-manifest.json'))) {
        return `S3 equip --check 失败或缺少 manifest: exit=${eqCheck.status} out=${eqCheck.stdout} err=${eqCheck.stderr}`
      }
      const manifest = JSON.parse(readFileSync(join(dir, '.agents/skills/.pf-manifest.json'), 'utf8'))
      if (manifest.schemaVersion !== 3 || Object.keys(manifest.files ?? {}).length < 20) {
        return `S3 manifest schemaVersion 或文件条目异常: schema=${manifest.schemaVersion}`
      }

      // S3b: compose-agents 渲染 AGENTS.md，填入项目事实后通过预算、零占位与零残留校验
      const ca = await runNode('compose-agents.mjs', [dir], { env })
      if (ca.status !== 0) return `S3 compose-agents 失败: exit=${ca.status} err=${ca.stderr}`
      const filledAgents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
        .replace(/<!--\s*project-forge:\s*fill\b[^>]*-->/g, '本项目提供 `src/app.mjs` 问候模块，通过 `node src/app.mjs` 执行校验。')
        .replace(/^(\s*(?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit)\s*:\s*)<[^>]+>\s*$/gm, '$1none')
      writeFileSync(join(dir, 'AGENTS.md'), filledAgents, 'utf8')
      const caCheck = await runNode('compose-agents.mjs', [dir, '--check'], { env })
      if (caCheck.status !== 0) return `S3 compose-agents --check 失败: exit=${caCheck.status} out=${caCheck.stdout} err=${caCheck.stderr}`
      const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      if (agentsText.includes('{{') || Buffer.byteLength(agentsText, 'utf8') > 30 * 1024) {
        return 'S3 AGENTS.md 含未求值占位符或超过 30KB 预算'
      }

      // S3c: verify-tools 审计 + 渲染离线架构图
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, 'docs/feature-map.json'), JSON.stringify({
        version: 2,
        domains: [{ id: 'core', name: 'Core Domain', entrypoints: ['src/app.mjs'] }],
        features: [{
          id: 'app-core',
          name: 'App Core',
          domain: 'core',
          entrypoints: ['src/app.mjs'],
          modules: ['src/app.mjs'],
          businessFlows: ['greet flow'],
          verificationTools: [{ id: 'verify-app', kind: 'command', command: 'node src/app.mjs', riskLevel: 'low' }],
          testRefs: ['src/app.mjs'],
        }],
      }, null, 2), 'utf8')
      const vtRender = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['render', dir, '--json'], { env })
      const vtAudit = await runAbsAsync('kit/skills/dev-verify-tools/scripts/verify-tools.mjs', ['audit', dir, '--json'], { env })
      if (vtRender.status !== 0 || !existsSync(join(dir, 'docs/architecture-map.html'))) {
        return `S3 verify-tools render 失败: exit=${vtRender.status} out=${vtRender.stdout} err=${vtRender.stderr}`
      }
      if (vtAudit.status !== 0) return `S3 verify-tools audit 失败: exit=${vtAudit.status} out=${vtAudit.stdout}`
      const vtAuditJson = JSON.parse(vtAudit.stdout)
      if (!vtAuditJson.ok || (vtAuditJson.zombies?.length ?? 0) !== 0 || (vtAuditJson.blindSpots?.length ?? 0) !== 0) {
        return `S3 verify-tools audit 存在异常项: ${vtAudit.stdout}`
      }

      // S4: review 交付体检（0 个 missing）+ handoff 净度扫描
      gitCommitFast(dir, 'chore: onboard project-forge baseline')
      const rev = await runNode('review.mjs', [dir, '--json'], { env })
      const revJson = JSON.parse(rev.stdout)
      const missingCount = (revJson.results ?? []).filter((r) => r.level === 'missing').length
      if (missingCount !== 0) {
        return `S4 review 仍存在 missing 缺口 (${missingCount}): ${JSON.stringify(revJson.results.filter((r) => r.level === 'missing'))}`
      }
      const ho = await runNode('handoff.mjs', ['--scan', dir, '--json'], { env })
      if (ho.status !== 0) return `S4 handoff --scan 失败: exit=${ho.status} out=${ho.stdout} err=${ho.stderr}`
      return true
    } finally { rmTree(dir); rmTree(bkRoot) }
  }])

  cases.push(['hotspot-2：visual-render.mjs HTML 渲染、脚本/XSS 防护、零 homedir 泄露、主题切换与多图视角标签', async () => {
    const home = homedir().replace(/\\/g, '/')
    const fakeAbsModule = `${home}/secret-workspace/src/billing.mjs`
    const xssPayload = '</script><script>alert("xss")</script><img src=x onerror=alert(1)>'
    const fm = {
      version: 2,
      domains: [{ id: 'pay', name: `Pay ${xssPayload}`, entrypoints: [fakeAbsModule] }],
      features: [
        { id: 'billing', name: `Billing ${xssPayload}`, domain: 'pay', entrypoints: [fakeAbsModule], modules: [fakeAbsModule], dependsOn: ['ledger'] },
        { id: 'ledger', name: 'Ledger Core', domain: 'pay', entrypoints: ['src/ledger.mjs'], modules: ['src/ledger.mjs'] },
      ],
      flows: [{ id: 'pay-flow', name: 'Pay Flow', features: ['billing', 'ledger'], steps: [{ feature: 'billing', actor: 'user', action: 'charge' }, { feature: 'ledger', actor: 'sys', action: 'record' }] }],
    }
    const baseModel = buildVisualModel(fm, { title: `Arch ${xssPayload}`, mode: 'architecture-map' })
    const hdr = buildGeneratedHeaderLine({ mode: 'architecture-map', featureMapSha256: 'not-a-hex-sha' })
    if (!hdr.includes('<!-- @generated by project-forge architecture-map; DO NOT EDIT — schema=v2 feature-map-sha256=')) {
      return `buildGeneratedHeaderLine 格式异常: ${hdr}`
    }

    const archOut = renderVisualHtml({ visualModel: baseModel, featureMapSha256: 'a'.repeat(64), mode: 'architecture-map' })
    if (archOut.bytes !== Buffer.byteLength(archOut.html, 'utf8') || archOut.sha256.length !== 64) {
      return `renderVisualHtml 字节计数或 sha256 异常: bytes=${archOut.bytes}`
    }
    // 1. 脚本逃逸与零原始 XSS
    if (archOut.html.includes('<script>alert("xss")</script>') || archOut.html.includes('onerror=alert(1)>')) {
      return 'renderVisualHtml 存在未转义 XSS 载荷'
    }
    const dataScriptM = /<script id="pf-visual-data" type="application\/json">([\s\S]*?)<\/script>/.exec(archOut.html)
    if (!dataScriptM || dataScriptM[1].includes('</script>')) {
      return 'pf-visual-data JSON 脚本块缺少安全转义或未闭合'
    }
    // 2. 零 homedir 路径泄露
    if (archOut.html.toLowerCase().includes(home.toLowerCase())) {
      return `渲染 HTML 泄露了宿主机 homedir (${home})`
    }
    // 3. 主题切换与多视角 tab 切换 DOM
    if (!archOut.html.includes('data-theme="auto"') || !archOut.html.includes('id="btn-theme"')) {
      return '缺少浅深色主题切换控件'
    }
    if (!archOut.html.includes('data-diagram-tab="architecture"') || !archOut.html.includes('data-svg-host="architecture"')) {
      return '缺少多图视角标签或 SVG 宿主容器'
    }
    // 4. visual-brief 模式（含原型 tab、1:N 兄弟导航条与超大/非法原型拦截）
    const briefModel = {
      ...baseModel,
      mode: 'visual-brief',
      hasActiveDiff: true,
      briefData: {
        parentBriefHref: '../prd-master.html',
        siblingBriefLinks: [
          { key: 'slice-a', title: 'Slice A', wave: 1, href: 'slice-a.html', current: true },
          { key: 'slice-b', title: `Slice B ${xssPayload}`, wave: 2, href: 'slice-b.html', current: false },
        ],
      },
      prototypes: [
        { title: 'Safe HTML', kind: 'iframe', srcdoc: '<h1>Safe</h1>', selected: true },
        { title: 'Huge HTML', kind: 'iframe', srcdoc: 'x'.repeat(MAX_PROTOTYPE_SRCDOC_BYTES + 10) },
        { title: 'Bad URL', kind: 'url', url: 'javascript:alert(1)' },
      ],
    }
    const briefOut = renderVisualHtml({ visualModel: briefModel, featureMapSha256: 'b'.repeat(64), mode: 'visual-brief' })
    if (!briefOut.html.includes('data-tab-target="brief"')
      || !briefOut.html.includes('data-tab-target="prototypes"')
      || !briefOut.html.includes('pf-sibling-rail')
      || !briefOut.html.includes('sandbox="allow-scripts"')
      || !briefOut.html.includes('超出 512 KB 上限')
      || !briefOut.html.includes('原型链接协议受限')
      || briefOut.html.includes('javascript:alert(1)')) {
      return 'visual-brief 模式原型安全防护或兄弟导航渲染不完整'
    }
    return true
  }])

  cases.push(['hotspot-3：visual-render-panels.mjs 1:N 波次导航、直接/折叠波及、语义无损 <details>、筛选钩子与零 XSS', async () => {
    const xss = '<script>alert("panel-xss")</script><img src=x onerror=alert(2)>'
    const longDecision = `采用双环隔离策略确保所有核心模块 ${'kit/skills/lib/worktree-dep-pool.mjs '.repeat(4)}在并行工作树之间完全隔离；同时通过只读指纹池与无损归档锁避免任何状态污染与竞态条件。`
    const impactedNodes = Array.from({ length: 8 }, (_, i) => ({
      id: `imp-${i + 1}`,
      title: `Impacted Module ${i + 1}${i === 0 ? ` ${xss}` : ''}`,
      domain: i % 2 === 0 ? 'core' : 'edge',
      domainTitle: i % 2 === 0 ? 'Core' : 'Edge',
      diffState: 'impacted',
      entrypoints: [`src/imp-${i + 1}.mjs`],
      modules: [`src/imp-${i + 1}.mjs`],
      impactReasons: ['r1', 'r2', 'r3', `r4 ${xss}`],
    }))
    const directNodes = [
      {
        id: 'mod-added',
        title: `Added Feature ${xss}`,
        domain: 'core',
        domainTitle: 'Core',
        diffState: 'added',
        entrypoints: ['src/added.mjs'],
        modules: ['src/added.mjs'],
        changeDetail: {
          noteItems: ['[新增] src/added.mjs: create engine', 'src/b.mjs: wire hook', 'src/c.mjs: emit event', `src/d.mjs: guard ${xss}`],
          scopeFiles: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs', 'src/d.mjs', 'src/e.mjs'],
          criteriaRefs: ['C1', 'C2'],
        },
      },
      {
        id: 'mod-modified',
        title: 'Modified Engine',
        domain: 'core',
        domainTitle: 'Core',
        diffState: 'modified',
        entrypoints: ['src/engine.mjs'],
        modules: ['src/engine.mjs'],
        changeDetail: { before: 'legacy runner', after: 'hardened runner' },
      },
    ]
    const model = {
      repoName: `Demo ${xss}`,
      title: 'Change Blueprint',
      scopeChips: ['Case 4', 'L3'],
      activeTabs: [{ id: 'architecture' }, { id: 'sequence' }],
      overlayCounts: { added: 1, modified: 1, removed: 0, impacted: 8 },
      tree: {
        nodes: [...directNodes, ...impactedNodes],
        edges: [{ fromId: 'mod-added', toId: 'imp-1' }, { fromId: 'mod-modified', toId: 'imp-2' }],
      },
      briefData: {
        verdict: `Verdict ${xss}`,
        childBriefLinks: [
          { key: 'slice-1', title: 'Wave 1 Done', wave: 1, status: 'done', done: true, scopeCount: 3, href: 's1.html' },
          { key: 'slice-2', title: `Wave 1 Active ${xss}`, wave: 1, status: 'implementing', scopeCount: 2, href: 's2.html' },
          { key: 'slice-3', title: 'Wave 2 Blocked', wave: 2, status: 'draft', dependsOn: ['slice-1'], scopeCount: 4, href: 's3.html' },
        ],
        mergedDecisions: [longDecision, 'D2 short', 'D3 short', `D4 extra ${xss}`],
        goals: ['G1', 'G2', 'G3', 'G4 extra'],
        nonGoals: ['NG1'],
        criteria: [{ id: 'C1', checked: true, text: `Criteria ${xss}` }, { id: 'C2', checked: false, text: 'Verify clean' }],
        prDiff: { degraded: false, range: 'main...HEAD', hunks: { files: [{ file: 'src/added.mjs', addedCount: 5, removedCount: 1, lines: [`+ const safe = "${xss}"`] }] } },
      },
    }
    const bpHtml = renderBlueprintLandingHtml(model, { summary: 'synced' })
    // 1. 1:N 波次导航
    if (!bpHtml.includes('pf-wave-panel') || !bpHtml.includes('已完成 1 / 共 3 个切片') || !bpHtml.includes('前置：slice-1') || !bpHtml.includes('可并行起步')) {
      return '1:N 波次导航面板渲染缺失关键状态或依赖文案'
    }
    // 2. 直接变更 vs 折叠受波及（前 6 可见，后 2 折叠）
    if (!bpHtml.includes('data-bp-group="direct"')
      || !bpHtml.includes('data-bp-group="impacted"')
      || !bpHtml.includes('data-impacted-extra="1" hidden')
      || !bpHtml.includes('id="btn-toggle-impacted" data-act="toggle-impacted" data-extra-count="2"')) {
      return '直接变更与超 6 张受波及模块折叠逻辑异常'
    }
    // 3. 语义截断 + 无损 <details> 全文保留
    if (!bpHtml.includes('<details class="pf-more-fold pf-dec-fold"><summary>展开全文</summary>')
      || !bpHtml.includes('避免任何状态污染与竞态条件。')
      || !bpHtml.includes('展开其余 1 项已拍板决策')
      || !bpHtml.includes('展开其余 1 条改动明细')
      || !bpHtml.includes('展开其余 1 个文件')) {
      return '语义截断或无损 <details> 折叠展开缺失'
    }
    // 4. 快搜/筛选 DOM 钩子 + 辅助面板函数
    for (const hook of ['id="pf-bp-search"', 'id="pf-bp-match-count"', 'data-diff-filter="added"', 'data-domain-filter="all"', 'id="pf-bp-reset"', 'id="pf-bp-empty"']) {
      if (!bpHtml.includes(hook)) return `缺少快搜/筛选 DOM 钩子: ${hook}`
    }
    const extraHtml = [
      renderInspectorShellHtml(),
      renderCommandPaletteHtml(),
      renderDialogsHtml(),
      renderPrototypeSlot([{ title: 'Bad Img', kind: 'img', src: 'javascript:alert(3)' }]),
      renderPrototypeSwitcher([{ title: 'A', selected: true }, { title: 'B' }]),
    ].join('\n')
    if (!extraHtml.includes('id="pf-cmdk"') || !extraHtml.includes('id="prompt-dialog"') || !extraHtml.includes('data-proto-mode="compare"') || !extraHtml.includes('图片地址不符合安全协议规范')) {
      return '辅助面板或原型切换器/非法图片拦截渲染异常'
    }
    // 5. 零未转义 XSS
    if (bpHtml.includes('<script>alert("panel-xss")</script>') || bpHtml.includes('onerror=alert(2)>') || extraHtml.includes('javascript:alert(3)')) {
      return 'visual-render-panels 存在未转义 HTML/XSS 漏洞'
    }
    return true
  }])

  cases.push(['hotspot-4：worktree-dep-pool.mjs Class R/S/I 分层、sha256 只读池挂载、detach/reconcile、GC 与只读树安全销毁', async () => {
    // 1. Class R / S / I 分类
    if (!isClassIPath('dist') || !isClassIPath('data/app.sqlite3') || isClassIPath('node_modules')) {
      return 'isClassIPath 判定异常'
    }
    if (classifyHeavyDir('dist') !== 'I' || classifyHeavyDir('node_modules') !== 'S' || classifyHeavyDir('vendor/bundle') !== 'S' || classifyHeavyDir('src/core') !== 'unknown') {
      return 'classifyHeavyDir 分层判定异常'
    }
    const dir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': JSON.stringify({ name: 'pool-demo', dependencies: { 'pkg-a': '1.0.0' } }, null, 2),
      'package-lock.json': JSON.stringify({ name: 'pool-demo', lockfileVersion: 3, packages: { 'node_modules/pkg-a': { version: '1.0.0' } } }, null, 2),
      'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\n',
      'go.mod': 'module example.com/demo\n\ngo 1.22\n',
    })
    const roScratch = tmpProject({
      'nested/sub/readonly.txt': 'locked content\n',
    })
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@acme-fixture.dev' })
      mkdirSync(join(dir, 'node_modules/pkg-a'), { recursive: true })
      writeFileSync(join(dir, 'node_modules/pkg-a/index.js'), 'export const ver = "1.0.0"\n', 'utf8')
      // Class R vs S 锁文件探测 + 全局仓单元
      if (detectUnitDepClass(dir, '', 'node', ['pnpm-lock.yaml']).depClass !== 'R'
        || detectUnitDepClass(dir, '', 'node', ['package-lock.json']).depClass !== 'S'
        || detectUnitDepClass(dir, '', 'python', ['uv.lock']).depClass !== 'R') {
        return 'detectUnitDepClass R/S 分类异常'
      }
      const wtDir = join(dir, '.worktrees', 'impl-pool-test')
      gitSync(dir, ['worktree', 'add', '-b', 'feat/pool-test', wtDir, 'HEAD'])
      const globalR = detectGlobalStoreClassRUnits(dir, wtDir)
      if (!globalR.some((u) => u.ecosystem === 'rust' && u.envHints?.CARGO_TARGET_DIR) || !globalR.some((u) => u.ecosystem === 'go')) {
        return `detectGlobalStoreClassRUnits 未识别 Rust/Go Class R: ${JSON.stringify(globalR)}`
      }

      // 2. sha256 只读池创建与幂等复用
      const fp = computeUnitDepFingerprint(dir, '', 'node', ['package-lock.json'])
      const srcNm = join(dir, 'node_modules')
      const entry1 = ensureDepPoolEntry({ mainAbs: dir, wtAbs: wtDir, rel: 'node_modules', eco: 'node', dirRel: '', fingerprint: fp, srcReal: srcNm })
      const entry2 = ensureDepPoolEntry({ mainAbs: dir, wtAbs: wtDir, rel: 'node_modules', eco: 'node', dirRel: '', fingerprint: fp, srcReal: srcNm })
      const poolRoot = resolveDepPoolRoot(dir)
      if (!entry1.created || entry2.created || entry1.poolKey !== entry2.poolKey || !existsSync(entry1.poolDir)) {
        return `ensureDepPoolEntry 创建或幂等复用异常: e1=${JSON.stringify(entry1)} e2=${JSON.stringify(entry2)}`
      }
      if (!entry1.poolKey.endsWith(fp.slice(0, 16)) || !existsSync(join(poolRoot, 'pool-refs.json'))) {
        return `poolKey 指纹或 pool-refs.json 异常: key=${entry1.poolKey}`
      }

      // 3. 挂载只读池链接 + GC 保持引用计数=1 + reconcile 漂移自愈脱钩 + GC 彻底回收只读池
      const wtNm = join(wtDir, 'node_modules')
      symlinkSync(entry1.poolDir, wtNm, process.platform === 'win32' ? 'junction' : 'dir')
      const gcAlive = gcUnusedDepPools(dir)
      if (gcAlive.removed.length !== 0 || !gcAlive.kept.some((k) => k.poolKey === entry1.poolKey && k.refcount === 1)) {
        return `活跃 worktree 引用时 GC 误删或 refcount 异常: ${JSON.stringify(gcAlive)}`
      }
      const recClean = reconcileWorktreeDeps(dir, wtDir)
      if (recClean.drifted.length !== 0 || !recClean.unchanged.includes('node_modules')) {
        return `无漂移时 reconcile 误判漂移: ${JSON.stringify(recClean)}`
      }
      // 模拟 worktree 内锁文件漂移 -> reconcile 自动脱钩软链
      writeFileSync(join(wtDir, 'package-lock.json'), JSON.stringify({ name: 'pool-demo', lockfileVersion: 3, packages: { 'node_modules/pkg-a': { version: '2.0.0' } } }, null, 2), 'utf8')
      const recDrift = reconcileWorktreeDeps(dir, wtDir)
      if (!recDrift.detached.includes('node_modules') || existsSync(wtNm) || !existsSync(entry1.poolDir)) {
        return `锁文件漂移后 reconcile 未原子脱钩或误伤 poolDir: ${JSON.stringify(recDrift)}`
      }
      const gcAfterDrift = gcUnusedDepPools(dir)
      if (!gcAfterDrift.removed.includes(entry1.poolKey) || existsSync(entry1.poolDir)) {
        return `refcount=0 后 GC 未清理只读池目录: ${JSON.stringify(gcAfterDrift)}`
      }

      // 4. detachWorktreeUnit 显式脱钩 + 跳过非软链
      const entry3 = ensureDepPoolEntry({ mainAbs: dir, wtAbs: wtDir, rel: 'node_modules', eco: 'node', dirRel: '', fingerprint: fp, srcReal: srcNm })
      symlinkSync(entry3.poolDir, wtNm, process.platform === 'win32' ? 'junction' : 'dir')
      const det = detachWorktreeUnit(dir, wtDir, { unit: 'node_modules' })
      if (!det.ok || !det.detached.includes('node_modules') || lstatSyncSafeExists(wtNm)) {
        return `detachWorktreeUnit 未脱钩链接: ${JSON.stringify(det)}`
      }
      const detAgain = detachWorktreeUnit(dir, wtDir, { unit: 'node_modules' })
      if (!detAgain.ok || detAgain.detached.length !== 0) {
        return `detachWorktreeUnit 重复调用未优雅跳过: ${JSON.stringify(detAgain)}`
      }
      gcUnusedDepPools(dir)

      // 5. setReadOnlyTreeSync + removeReadOnlyTreeSync 只读树安全销毁（覆盖 Windows NTFS 防 EPERM）
      setReadOnlyTreeSync(roScratch)
      const rmRes = removeReadOnlyTreeSync(roScratch)
      if (!rmRes.removed || rmRes.unprotectedFiles < 1 || existsSync(roScratch)) {
        return `removeReadOnlyTreeSync 未能彻底销毁只读树: ${JSON.stringify(rmRes)}`
      }
      return true
    } finally {
      try { removeReadOnlyTreeSync(roScratch) } catch { /* ignore */ }
      try { removeReadOnlyTreeSync(resolveDepPoolRoot(dir)) } catch { /* ignore */ }
      rmTree(dir)
    }
  }])

  cases.push(['hotspot-5：exec.mjs Windows .cmd/.bat CVE-2024-27980 元字符阻断、安全参数透传与 PF_CACHE_DIR 隔离', async () => {
    const dir = tmpProject({
      'echo-safe.cmd': '@echo off\r\necho SAFE_BATCH_OUT %*\r\n',
    })
    const batchAbs = join(dir, 'echo-safe.cmd')
    try {
      // 1. validateWinBatchArgs 正反双向校验
      validateWinBatchArgs(['--check', 'path with spaces/file (1).txt', 'key=value', 'a.b/c-d_e'])
      for (const bad of ['a & calc', 'a | whoami', 'a > out', 'a < in', 'a ^ b', '%COMSPEC%', '!SECRET!', 'say "hi"', 'line1\nline2', 'a\0b']) {
        let caught = null
        try { validateWinBatchArgs([bad]) } catch (err) { caught = err }
        if (!caught || caught.code !== 'BLOCKED_UNSAFE_WIN_BATCH_ARG' || caught.exitCode !== EXIT.USAGE) {
          return `validateWinBatchArgs 漏拦危险元字符 ${JSON.stringify(bad)}: ${caught?.code}`
        }
      }

      // 2. execSafe 对危险 .cmd 参数返回结构化 BLOCKED_UNSAFE_WIN_BATCH_ARG 且绝不抛未捕获异常
      const blocked = await execSafe(batchAbs, ['ok', '& echo PWNED'], { cwd: dir, _platform: 'win32' })
      if (blocked.ok || blocked.blockedCode !== 'BLOCKED_UNSAFE_WIN_BATCH_ARG' || blocked.code !== EXIT.USAGE) {
        return `execSafe 未以结构化结果拦截危险 .cmd 参数: ${JSON.stringify(blocked)}`
      }

      // 3. 安全参数在 prepareExecInvocation 与 Windows 实跑下正常透传
      const inv = prepareExecInvocation(batchAbs, ['hello-safe-123'], { cwd: dir, platform: 'win32' })
      if (!inv.windowsVerbatimArguments || !/cmd(?:\.exe)?$/i.test(inv.cmd)) {
        return `prepareExecInvocation 未为 .cmd 构造 windowsVerbatimArguments 调用: ${JSON.stringify(inv)}`
      }
      if (process.platform === 'win32') {
        const safeRun = await execSafe(batchAbs, ['hello-safe-123'], { cwd: dir })
        if (!safeRun.ok || !safeRun.stdout.includes('SAFE_BATCH_OUT hello-safe-123')) {
          return `Windows 安全 .cmd 参数透传执行失败: ${JSON.stringify(safeRun)}`
        }
      }

      // 4. computeWorktreeEnv 隔离重定向 PF_CACHE_DIR 与子工具缓存目录
      const gitDir = join(dir, '.git')
      mkdirSync(gitDir, { recursive: true })
      const envA = computeWorktreeEnv({ mainRoot: dir, gitDir, taskId: 'task-alpha', slotIndex: 2, basePort: 19000 })
      const envB = computeWorktreeEnv({ mainRoot: dir, gitDir, taskId: 'task-beta', slotIndex: 3, basePort: 19000 })
      if (envA.PF_SLOT !== '2' || envA.PF_PORT !== '19200' || envB.PF_PORT !== '19300') {
        return `computeWorktreeEnv 槽位或端口偏移异常: A=${JSON.stringify(envA)} B=${JSON.stringify(envB)}`
      }
      if (!existsSync(envA.PF_CACHE_DIR) || envA.PF_CACHE_DIR === envB.PF_CACHE_DIR
        || !envA.VITE_CACHE_DIR.startsWith(envA.PF_CACHE_DIR)
        || !envA.CARGO_TARGET_DIR.startsWith(envA.PF_CACHE_DIR)
        || envA.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN !== 'false') {
        return `computeWorktreeEnv PF_CACHE_DIR 重定向或隔离失败: ${JSON.stringify(envA)}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}

function lstatSyncSafeExists(p) {
  try { return Boolean(lstatSync(p)) } catch { return false }
}
