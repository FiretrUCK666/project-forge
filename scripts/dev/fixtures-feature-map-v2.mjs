#!/usr/bin/env node
/**
 * fixtures-feature-map-v2.mjs —— feature-map v2 层次拓扑（domains/dependsOn/actors/flows）、
 * 叶子图校验内核、repo-map/verify-tools/contextBrief/flow/govern/iterate 全链路正反双向行为断言。
 *
 * 自动被 `scripts/dev/fixtures.mjs` 发现执行，也可直接运行 `node scripts/dev/fixtures-feature-map-v2.mjs`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { buildContextBrief, formatContextBriefLines } from '../../kit/skills/lib/context-brief.mjs'
import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { EXIT, blockedExitOf } from '../../kit/skills/lib/exit-codes.mjs'
import {
  buildFallbackDomains, computeFeatureMapCanonicalSha256, computeFeatureMapFingerprint,
  sliceFeatureMapContext, validateFeatureMapTopology, verifyArchitectureMapHeader,
} from '../../kit/skills/lib/feature-map-graph.mjs'
import {
  FEATURE_MAP_REL, mergeFeatureMapIncremental, readFeatureMap, readFeatureMapSafe,
  sanitizeFeatureEntry, sanitizeFeatureMap, updateFeatureMapTestRefs, validateFeatureMap,
} from '../../kit/skills/lib/feature-map.mjs'
import { isMainModule, resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { readFeatureMapSafe as tiReadSafe, updateFeatureMapTestRefs as tiUpdateRefs } from '../../kit/skills/lib/suite-inventory.mjs'
import { checkCase2StructuralDriftOnVerify, checkFeatureMapSyncOnFinalize } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'
import { runReconcileVerifyToolsAudit } from '../../kit/skills/dev-govern/scripts/govern-checks-hygiene.mjs'
import { buildIterationPlan } from '../../kit/skills/dev-iterate/scripts/iterate.mjs'
import { assembleReviewContext, formatReviewContextLines } from '../../kit/skills/dev-review/scripts/review-context.mjs'
import { gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

const VT_SCRIPT = 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs'
const RM_SCRIPT = 'kit/skills/dev-explore/scripts/repo-map.mjs'

export function registerFeatureMapV2Cases(cases) {
  cases.push(['FMv2 C1：叶子图模块无上游循环、v1/v2 双向兼容、docAnchors 保留、拓扑判环与脆弱边界正反双向', async () => {
    const dir = tmpProject({
      'src/auth.mjs': 'export const login = () => true\n',
      'src/orders.mjs': 'export const order = () => true\n',
      'lib/db.mjs': 'export const query = () => []\n',
      'test/e2e/checkout.e2e.test.mjs': 'import assert from "node:assert/strict"\nassert.ok(true)\n',
    })
    try {
      // 1. 叶子模块隔离边界：feature-map-graph.mjs 绝不导入 feature-map.mjs 或 static-gates.mjs
      const graphSrc = readFileSync(join(process.cwd(), 'kit/skills/lib/feature-map-graph.mjs'), 'utf8')
      const graphImports = [...graphSrc.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
      if (graphImports.some((spec) => !spec.startsWith('node:') && spec !== './git-core.mjs')) {
        return `feature-map-graph.mjs 违反叶子边界，仅允许 node:* 与 ./git-core.mjs，实际导入：${JSON.stringify(graphImports)}`
      }

      // 2. 纯 v1 保持 version: 1 幂等返回；sanitizeFeatureEntry 显式保留 docAnchors[] 与 owner
      const v1Raw = {
        version: 1,
        features: [{
          id: 'auth',
          name: 'Auth',
          owner: 'sec-team',
          entrypoints: ['src/auth.mjs'],
          modules: ['src/auth.mjs'],
          businessFlows: ['登录'],
          verificationTools: [],
          testRefs: [],
          docAnchors: ['docs/TDD.md#auth'],
        }],
      }
      const v1Clean = sanitizeFeatureMap(v1Raw)
      if (v1Clean.version !== 1 || v1Clean.features[0].docAnchors?.[0] !== 'docs/TDD.md#auth' || v1Clean.features[0].owner !== 'sec-team') {
        return `v1 清洗未保持 version: 1 或丢失 docAnchors/owner：${JSON.stringify(v1Clean)}`
      }
      if ('domains' in v1Clean || 'flows' in v1Clean) {
        return `纯 v1 不应强行注入空 domains/flows：${JSON.stringify(v1Clean)}`
      }

      // 3. v2 规范化 + 合法拓扑校验 + 指纹稳定性（键序无关）+ HTML 首行指纹核验
      const v2A = {
        version: 2,
        domains: [
          { id: 'core', name: 'Core', entrypoints: ['lib/db.mjs'], docAnchors: ['docs/TDD.md#core'] },
          { id: 'biz', name: 'Business', entrypoints: ['src/auth.mjs'] },
        ],
        features: [
          { id: 'db', name: 'DB', domain: 'core', dependsOn: [], actors: ['system'], entrypoints: ['lib/db.mjs'], modules: ['lib/db.mjs'], businessFlows: [], verificationTools: [], testRefs: ['test/db.test.mjs'], docAnchors: ['docs/TDD.md#db'] },
          { id: 'auth', name: 'Auth', domain: 'biz', dependsOn: ['db'], actors: ['user'], entrypoints: ['src/auth.mjs'], modules: ['src/auth.mjs'], businessFlows: [], verificationTools: [], testRefs: [], docAnchors: ['docs/TDD.md#auth'] },
          { id: 'orders', name: 'Orders', domain: 'biz', dependsOn: ['auth'], actors: ['buyer'], entrypoints: ['src/orders.mjs'], modules: ['src/orders.mjs'], businessFlows: [], verificationTools: [], testRefs: [] },
        ],
        flows: [
          {
            id: 'checkout-flow',
            name: 'Checkout Flow',
            actors: ['buyer'],
            features: ['auth', 'orders'],
            steps: [{ feature: 'auth', action: 'verify' }, { feature: 'orders', action: 'submit' }],
            branches: [{ when: 'unauth', toFeature: 'auth' }],
          },
        ],
      }
      const v2Reordered = {
        flows: v2A.flows,
        features: v2A.features,
        domains: v2A.domains,
        version: 2,
      }
      const okVal = validateFeatureMap(v2A)
      if (!okVal.ok) return `合法 v2 地图校验失败：${JSON.stringify(okVal.errors)}`
      if (computeFeatureMapFingerprint(v2A) !== computeFeatureMapCanonicalSha256(v2Reordered)) {
        return 'computeFeatureMapFingerprint 对键序不同的等价地图产出不同 SHA256'
      }
      mkdirSync(join(dir, 'docs'), { recursive: true })
      writeFileSync(join(dir, FEATURE_MAP_REL), JSON.stringify(v2A, null, 2), 'utf8')
      const expectedSha = computeFeatureMapFingerprint(v2A)
      writeFileSync(join(dir, 'docs/architecture-map.html'), `<!-- @generated by project-forge feature-map-sha256=${expectedSha} -->\n<html></html>\n`, 'utf8')
      const hdrOk = verifyArchitectureMapHeader(dir)
      if (!hdrOk.ok || hdrOk.actualSha !== expectedSha) {
        return `verifyArchitectureMapHeader 正向核验失败：${JSON.stringify(hdrOk)}`
      }
      writeFileSync(join(dir, 'docs/architecture-map.html'), '<!-- @generated by project-forge feature-map-sha256=0000000000000000000000000000000000000000000000000000000000000000 -->\n<html></html>\n', 'utf8')
      const hdrBad = verifyArchitectureMapHeader(dir)
      if (hdrBad.ok || hdrBad.reason !== 'sha256-mismatch') {
        return `verifyArchitectureMapHeader 未拦截篡改 SHA256：${JSON.stringify(hdrBad)}`
      }

      // 4. 反向拓扑拦截：悬空 domain、自环/悬空 dependsOn、三色 DFS 环链、悬空 steps/branches、flows FORBIDDEN_TRACKED_KEYS
      const cyclicAndDangling = {
        version: 2,
        domains: [{ id: 'core', name: 'Core', contentHash: 'bad-hash' }],
        features: [
          { id: 'a', name: 'A', domain: 'missing-dom', dependsOn: ['b', 'ghost'], verificationTools: [], testRefs: [] },
          { id: 'b', name: 'B', domain: 'core', dependsOn: ['c'], verificationTools: [], testRefs: [] },
          { id: 'c', name: 'C', domain: 'core', dependsOn: ['a', 'c'], verificationTools: [], testRefs: [] },
        ],
        flows: [
          {
            id: 'bad-flow',
            name: 'Bad Flow',
            actors: ['user'],
            features: ['a', 'no-feat'],
            verifiedAt: '2026-11-25',
            steps: [{ feature: 'no-step-feat', action: 'x' }],
            branches: [{ when: 'err', toFeature: 'no-branch-feat' }],
          },
        ],
      }
      const badTopo = validateFeatureMapTopology(cyclicAndDangling)
      const joinedErrs = badTopo.errors.join('\n')
      if (badTopo.ok
        || !joinedErrs.includes('missing-dom')
        || !joinedErrs.includes('ghost')
        || !joinedErrs.includes('自环')
        || !badTopo.cycles.some((cy) => cy.includes('a') && cy.includes('b') && cy.includes('c'))
        || !joinedErrs.includes('no-step-feat')
        || !joinedErrs.includes('no-branch-feat')
        || !joinedErrs.includes('contentHash')
        || !joinedErrs.includes('verifiedAt')) {
        return `validateFeatureMapTopology 漏拦拓扑或易变键缺陷：${JSON.stringify(badTopo)}`
      }

      // 5. buildFallbackDomains 与 sliceFeatureMapContext 紧凑切片（严禁泄漏邻域 modules/testRefs，flows<=6）
      const fallbackDoms = buildFallbackDomains(v1Raw)
      if (fallbackDoms.length !== 1 || fallbackDoms[0].id !== 'src' || fallbackDoms[0].synthetic !== true) {
        return `buildFallbackDomains 对 v1 分组异常：${JSON.stringify(fallbackDoms)}`
      }
      const manyFlowsMap = {
        ...v2A,
        flows: Array.from({ length: 8 }, (_, idx) => ({
          id: `flow-${idx}`, name: `Flow ${idx}`, actors: ['user'], features: ['auth', 'orders'],
        })),
      }
      const sliced = sliceFeatureMapContext(manyFlowsMap, { matchedFeatureIds: ['auth'], limit: 6 })
      if (sliced.upstream.length !== 1 || sliced.upstream[0].id !== 'db'
        || sliced.downstream.length !== 1 || sliced.downstream[0].id !== 'orders'
        || 'modules' in sliced.upstream[0] || 'testRefs' in sliced.upstream[0]
        || 'modules' in sliced.downstream[0] || 'testRefs' in sliced.downstream[0]
        || sliced.matchedFlows.length !== 6) {
        return `sliceFeatureMapContext 上下游指针越界膨胀或流上限失效：${JSON.stringify(sliced)}`
      }

      // 6. suite-inventory 薄重导出与 v2 无损更新 testRefs
      if (tiReadSafe !== readFeatureMapSafe || tiUpdateRefs !== updateFeatureMapTestRefs) {
        return 'suite-inventory.mjs 未薄重导出 feature-map.mjs 的 readFeatureMapSafe/updateFeatureMapTestRefs'
      }
      const upd = updateFeatureMapTestRefs(dir, { featureIds: ['auth'], testPaths: ['test/e2e/checkout.e2e.test.mjs'] })
      const afterUpd = readFeatureMapSafe(dir)
      if (!upd.updated || afterUpd.version !== 2 || afterUpd.domains.length !== 2 || afterUpd.flows.length !== 1
        || !afterUpd.features.find((f) => f.id === 'auth')?.testRefs?.includes('test/e2e/checkout.e2e.test.mjs')) {
        return `updateFeatureMapTestRefs 破坏 v2 字段或未追加 testRefs：${JSON.stringify(afterUpd)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['FMv2 C2：repo-map Layer-1 无环拓扑推断、verify-tools sync 去重、audit 报拓扑错与 clean 保 v2 正反双向', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# topo-demo\n\n## Dev Profile\n```yaml\nquick-test: node test/a.test.mjs\nsmoke-verify: none\n```\n',
      'package.json': JSON.stringify({ name: 'topo-demo', type: 'module', workspaces: ['packages/*'] }, null, 2),
      'packages/core/package.json': JSON.stringify({ name: '@demo/core', main: 'src/db.mjs' }, null, 2),
      'packages/core/src/db.mjs': 'import { helper } from "../../api/src/routes.mjs"\nexport const db = () => helper ? 1 : 0\n',
      'packages/api/package.json': JSON.stringify({ name: '@demo/api', main: 'src/routes.mjs' }, null, 2),
      'packages/api/src/routes.mjs': 'import { db } from "../../core/src/db.mjs"\nexport const helper = () => db()\n',
      'test/a.test.mjs': 'import assert from "node:assert/strict"\nassert.ok(true)\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@topo.test' })
    try {
      // 1. repo-map --write-feature-map 发出 v2 且互引模块被自动破环为无环 DAG
      const rmRes = await runAbsAsync(RM_SCRIPT, [dir, '--write-feature-map', '--json'])
      if (rmRes.status !== 0) return `repo-map --write-feature-map 失败：${rmRes.stderr}`
      const fm1 = JSON.parse(readFileSync(join(dir, FEATURE_MAP_REL), 'utf8'))
      if (fm1.version !== 2 || !Array.isArray(fm1.domains) || fm1.domains.length < 2) {
        return `repo-map --write-feature-map 未生成 v2 domains[]：${JSON.stringify(fm1)}`
      }
      const topo1 = validateFeatureMapTopology(fm1)
      if (!topo1.ok || topo1.cycles.length > 0) {
        return `repo-map 互引模块未自动破环保证无环：${JSON.stringify(topo1)}`
      }

      // 2. 手工覆盖 domain / dependsOn / flows 后再跑 verify-tools sync，不得覆盖手工值，且单次调用 addedFeatures 精确
      const dbFeat = fm1.features.find((f) => f.id === 'db')
      dbFeat.domain = 'packages-core'
      dbFeat.dependsOn = []
      fm1.flows = [{ id: 'main-flow', name: 'Main', actors: ['user'], features: ['routes', 'db'] }]
      writeFileSync(join(dir, FEATURE_MAP_REL), JSON.stringify(fm1, null, 2), 'utf8')

      writeFileSync(join(dir, 'packages/api/src/extra.mjs'), 'export const extra = () => 2\n', 'utf8')
      const fmForSync = { ...fm1, features: fm1.features.filter((f) => f.id !== 'extra') }
      writeFileSync(join(dir, FEATURE_MAP_REL), JSON.stringify(fmForSync, null, 2), 'utf8')
      const syncOut = await runAbsAsync(VT_SCRIPT, ['sync', dir, '--json'])
      if (syncOut.status !== 0) return `verify-tools sync 失败：${syncOut.stderr}`
      const syncJson = JSON.parse(syncOut.stdout)
      if (syncJson.featureMap.version !== 2 || syncJson.featureMap.flows?.length !== 1) {
        return `verify-tools sync 丢失 v2 flows：${JSON.stringify(syncJson)}`
      }

      // 3. verify-tools clean --confirm 修复 handleClean 不再剥除 version:2 / domains[] / flows[] / dependsOn / docAnchors
      const fmWithZombie = {
        ...syncJson.featureMap,
        features: syncJson.featureMap.features.map((f) => f.id === 'routes'
          ? { ...f, modules: [...f.modules, 'packages/api/src/deleted-ghost.mjs'], docAnchors: ['docs/TDD.md#routes'] }
          : f),
      }
      writeFileSync(join(dir, FEATURE_MAP_REL), JSON.stringify(fmWithZombie, null, 2), 'utf8')
      const cleanRes = await runAbsAsync(VT_SCRIPT, ['clean', dir, '--confirm', '--json'])
      if (cleanRes.status !== 0) return `verify-tools clean 失败：${cleanRes.stderr}`
      const afterClean = JSON.parse(readFileSync(join(dir, FEATURE_MAP_REL), 'utf8'))
      if (afterClean.version !== 2 || !Array.isArray(afterClean.domains) || afterClean.domains.length < 2
        || afterClean.flows?.length !== 1
        || afterClean.features.find((f) => f.id === 'routes')?.docAnchors?.[0] !== 'docs/TDD.md#routes') {
        return `verify-tools clean 剥除了 v2 扩展字段或 docAnchors：${JSON.stringify(afterClean)}`
      }

      // 4. 反向：verify-tools audit 拦截悬空/环路拓扑错误（且不把根 flows[] 误判为 duplicateFlows）
      const brokenMap = {
        ...afterClean,
        features: afterClean.features.map((f) => f.id === 'db' ? { ...f, dependsOn: ['routes'] } : (f.id === 'routes' ? { ...f, dependsOn: ['db'] } : f)),
      }
      writeFileSync(join(dir, FEATURE_MAP_REL), JSON.stringify(brokenMap, null, 2), 'utf8')
      const auditBad = await runAbsAsync(VT_SCRIPT, ['audit', dir, '--json'])
      const auditJson = JSON.parse(auditBad.stdout || '{}')
      if (auditBad.status !== 3 || auditJson.ok !== false || (auditJson.topologyErrors?.length ?? 0) === 0 || auditJson.duplicateFlows.length !== 0) {
        return `verify-tools audit 未拦截环路拓扑或误报 duplicateFlows：status=${auditBad.status} out=${auditBad.stdout}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['FMv2 C3：contextBrief budgetLines=48、显式渲染上限、角色加权与单一 contextBrief 契约', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# BriefDemo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'docs/TDD.md': '# TDD\n\n## Core\n`src/core.mjs` core.\n',
      'src/core.mjs': 'export const core = () => 1\n',
      'src/api.mjs': 'import { core } from "./core.mjs"\nexport const api = () => core()\n',
      'src/web.mjs': 'import { api } from "./api.mjs"\nexport const web = () => api()\n',
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        domains: [
          { id: 'foundation', name: 'Foundation', entrypoints: ['src/core.mjs'] },
          { id: 'gateway', name: 'Gateway', entrypoints: ['src/api.mjs'] },
          { id: 'surface', name: 'Surface', entrypoints: ['src/web.mjs'] },
        ],
        features: [
          { id: 'core', name: 'Core', domain: 'foundation', dependsOn: [], entrypoints: ['src/core.mjs'], modules: ['src/core.mjs'], businessFlows: ['核心原语'], verificationTools: [{ id: 'vt-core', kind: 'command', command: 'exit 0', riskLevel: 'medium' }], testRefs: [], docAnchors: ['docs/TDD.md#core'] },
          { id: 'api', name: 'API', domain: 'gateway', dependsOn: ['core'], entrypoints: ['src/api.mjs'], modules: ['src/api.mjs'], businessFlows: ['接口路由'], verificationTools: [{ id: 'vt-api', kind: 'command', command: 'exit 0', riskLevel: 'medium' }], testRefs: [] },
          { id: 'web', name: 'Web', domain: 'surface', dependsOn: ['api'], entrypoints: ['src/web.mjs'], modules: ['src/web.mjs'], businessFlows: ['前端渲染'], verificationTools: [], testRefs: [] },
        ],
        flows: [
          { id: 'e2e-req', name: 'Request Flow', actors: ['user'], features: ['web', 'api', 'core'] },
        ],
      }, null, 2),
      'docs/specs/261125-api-spec.md': '---\nkind: spec\ntitle: "API"\nstatus: approved\nscope_files: [src/api.mjs]\n---\n# API\n\n- [ ] C1: `src/api.mjs` works\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@cb2.test' })
    try {
      const brief = buildContextBrief(dir, { paths: ['src/api.mjs'], role: 'implementer' })
      if (brief.featureMap.domainSummary.length !== 3
        || brief.featureMap.upstream[0]?.id !== 'core'
        || brief.featureMap.downstream[0]?.id !== 'web'
        || brief.featureMap.matchedFlows[0]?.id !== 'e2e-req') {
        return `buildContextBrief 未产出 v2 拓扑切片：${JSON.stringify(brief.featureMap)}`
      }
      const capLines = formatContextBriefLines(brief, { maxDomains: 1, maxNeighbors: 1, maxFlows: 1, role: 'explore' }).join('\n')
      if (!capLines.includes('Domains (1):') || !capLines.includes('Topology Flows (1):')) {
        return `formatContextBriefLines 显式上限或 explore 角色权重渲染异常：\n${capLines}`
      }

      const hpExplore = buildHandoff({ mainRoot: dir, role: 'explore', ledger: { taskId: 'cb-1', specFile: 'docs/specs/261125-api-spec.md' } })
      const hpImpl = buildHandoff({ mainRoot: dir, role: 'implementer', ledger: { taskId: 'cb-1', specFile: 'docs/specs/261125-api-spec.md' } })
      if (!hpExplore.prompt.includes('域总览：') || hpImpl.prompt.includes('域总览：') || !hpImpl.prompt.includes('下游波及（1-hop）：')) {
        return `handoff 角色权重裁剪不符合预期：\nexplore=${hpExplore.prompt}\nimpl=${hpImpl.prompt}`
      }
      if ((JSON.stringify(hpImpl).match(/"contextBrief"/g) ?? []).length !== 1) {
        return 'handoff JSON 违反单一 contextBrief 出现次数约束'
      }

      const rc = await assembleReviewContext({
        reviewRoot: dir,
        mainRoot: dir,
        gitDir: join(dir, '.git'),
        diff: { files: [{ file: 'src/api.mjs' }], untracked: [] },
        effectiveProfile: {},
        task: { taskId: 'cb-1' },
      })
      const rcText = formatReviewContextLines(rc).join('\n')
      if (!rcText.includes('1-Hop Downstream Impact: web') || !rcText.includes('1-Hop Upstream Deps: core') || !rcText.includes('[e2e-req]')) {
        return `review-context 未输出 1-hop 影响面或跨模块流：\n${rcText}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['FMv2 C4：BLOCKED_FEATURE_MAP_TOPOLOGY(EXIT.FACT=3)、reconcile 建议依赖与 iterate 跨流 E2E 盲区', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# C4Demo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'src/core.mjs': 'export const core = () => 1\n',
      'src/order.mjs': 'import { core } from "./core.mjs"\nexport const order = () => core()\n',
      'test/order.test.mjs': 'import assert from "node:assert/strict"\nassert.ok(true)\n',
      'docs/feature-map.json': JSON.stringify({
        version: 2,
        domains: [{ id: 'src', name: 'Src' }],
        features: [
          { id: 'core', name: 'Core', domain: 'src', dependsOn: ['order'], entrypoints: ['src/core.mjs'], modules: ['src/core.mjs'], businessFlows: ['核心'], verificationTools: [], testRefs: [] },
          { id: 'order', name: 'Order', domain: 'src', dependsOn: ['core'], entrypoints: ['src/order.mjs'], modules: ['src/order.mjs'], businessFlows: ['下单'], verificationTools: [], testRefs: ['test/order.test.mjs'] },
        ],
        flows: [
          { id: 'order-e2e', name: 'Order E2E', actors: ['user'], features: ['order', 'core'] },
        ],
      }, null, 2),
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@c4.test' })
    try {
      if (blockedExitOf('BLOCKED_FEATURE_MAP_TOPOLOGY') !== EXIT.FACT) {
        return `exit-codes.mjs 未将 BLOCKED_FEATURE_MAP_TOPOLOGY 登记为 EXIT.FACT(3)`
      }
      const roots = await resolveRepoRoots(dir)

      // 1. finalize 与 Case 2 verify 拦截环形拓扑 BLOCKED_FEATURE_MAP_TOPOLOGY (EXIT.FACT=3)
      const finBad = await checkFeatureMapSyncOnFinalize({
        implRoot: dir, mainRoot: dir, ledger: {}, changedEntries: [{ status: 'M', file: FEATURE_MAP_REL }],
      })
      if (finBad.ok || finBad.code !== 'BLOCKED_FEATURE_MAP_TOPOLOGY' || finBad.exitCode !== EXIT.FACT) {
        return `checkFeatureMapSyncOnFinalize 未拦截拓扑环：${JSON.stringify(finBad)}`
      }
      const c2Bad = await checkCase2StructuralDriftOnVerify({
        implRoot: dir, mainRoot: dir, ledger: { caseType: 2 }, statusEntries: [{ xy: ' M', file: FEATURE_MAP_REL }],
      })
      if (c2Bad.ok || c2Bad.code !== 'BLOCKED_FEATURE_MAP_TOPOLOGY' || c2Bad.exitCode !== EXIT.FACT) {
        return `checkCase2StructuralDriftOnVerify 未拦截拓扑环：${JSON.stringify(c2Bad)}`
      }

      // 2. 修复环路但保留 order->core 未声明跨依赖：reconcile 不阻断且产出 suggestedCrossFeatureDeps
      const cleanMap = {
        version: 2,
        domains: [{ id: 'src', name: 'Src' }],
        features: [
          { id: 'core', name: 'Core', domain: 'src', dependsOn: [], entrypoints: ['src/core.mjs'], modules: ['src/core.mjs'], businessFlows: ['核心'], verificationTools: [], testRefs: [] },
          { id: 'order', name: 'Order', domain: 'src', dependsOn: [], entrypoints: ['src/order.mjs'], modules: ['src/order.mjs'], businessFlows: ['下单'], verificationTools: [], testRefs: ['test/order.test.mjs'] },
          { id: 'leaf', name: 'Leaf', domain: 'src', dependsOn: ['core'], entrypoints: ['src/order.mjs'], modules: ['src/order.mjs'], businessFlows: ['叶'], verificationTools: [], testRefs: [] },
        ],
        flows: [
          { id: 'order-e2e', name: 'Order E2E', actors: ['user'], features: ['order', 'core'] },
        ],
      }
      writeFileSync(join(dir, FEATURE_MAP_REL), JSON.stringify(cleanMap, null, 2), 'utf8')
      gitCommitFast(dir, 'docs: acyclic feature-map', { updateOnly: true })
      const finOk = await checkFeatureMapSyncOnFinalize({
        implRoot: dir, mainRoot: dir, ledger: {}, changedEntries: [{ status: 'M', file: FEATURE_MAP_REL }],
      })
      if (!finOk.ok) return `合法无环 v2 地图误报阻断：${JSON.stringify(finOk)}`

      const recFindings = []
      const recRes = await runReconcileVerifyToolsAudit(dir, dir, roots.gitDir, recFindings, (list, item) => list.push(item))
      if (recRes.status !== 'OK' || !recRes.suggestedCrossFeatureDeps?.some((d) => d.from === 'order' && d.to === 'core')) {
        return `reconcile 未产出非阻断 suggestedCrossFeatureDeps：${JSON.stringify(recRes)}`
      }

      // 3. iterate plan 识别跨 feature flows[] E2E 盲区，并提高被依赖核心 feature 权重
      const e2ePlan = await buildIterationPlan(dir, { tier: 'e2e', limit: 5 })
      if (!e2ePlan.candidates.some((c) => c.source === 'cross-feature-flow' && c.flowId === 'order-e2e' && c.tier === 'e2e')) {
        return `iterate plan 未识别跨 feature flows[] E2E 盲区：${JSON.stringify(e2ePlan.candidates)}`
      }
      const coreGap = e2ePlan.candidates.find((c) => c.source === 'feature-map-gap' && c.featureId === 'core')
      const leafGap = e2ePlan.candidates.find((c) => c.source === 'feature-map-gap' && c.featureId === 'leaf')
      if (!coreGap || !leafGap || coreGap.priority <= leafGap.priority) {
        return `iterate plan 未按被依赖入度提高核心 feature 权重：${JSON.stringify({ coreGap, leafGap })}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const cases = []
  registerFeatureMapV2Cases(cases)
  let failed = 0
  for (const [name, fn] of cases) {
    try {
      const res = await fn()
      if (res === true) process.stdout.write(`PASS  ${name}\n`)
      else { failed += 1; process.stderr.write(`FAIL  ${name} —— ${res}\n`) }
    } catch (err) {
      failed += 1
      process.stderr.write(`FAIL  ${name} —— ${err instanceof Error ? err.message : String(err)}\n`)
    }
  }
  await flushAndExit(failed === 0 ? 0 : 1)
}
