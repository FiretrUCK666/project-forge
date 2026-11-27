/**
 * fixtures-visual-layout-v2.mjs —— Milestone B Slice 2 (`multi-diagram-layout-engine`, C5..C8)
 * 10 类图表确定性布局、端口散布/干线捆绑/避障正交路由与纯 Node SVG 几何自检正反双向断言。
 */

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { gitCommitFast, gitInit, gitSync, rmTree, tmpProject } from './fixtures-helpers.mjs'
import { analyzeRepoStatic } from '../../kit/skills/lib/static-analyzer.mjs'
import { extractMultiDiagramEvidence } from '../../kit/skills/lib/static-evidence.mjs'
import { buildVisualModel } from '../../kit/skills/lib/visual-layout.mjs'
import { renderVisualHtml } from '../../kit/skills/lib/visual-render.mjs'

async function loadLayoutV2Mods() {
  const router = await import('../../kit/skills/lib/visual-router.mjs')
  const diagrams = await import('../../kit/skills/lib/visual-layout-diagrams.mjs')
  const charts = await import('../../kit/skills/lib/visual-layout-charts.mjs')
  const geo = await import('../../kit/skills/lib/visual-geometry-check.mjs')
  return { router, diagrams, charts, geo }
}

function makeSampleFeatureMap() {
  return {
    version: 2,
    repoName: 'LayoutV2Demo',
    domains: [
      { id: 'core', name: '核心层' },
      { id: 'service', name: '服务层' },
      { id: 'ui', name: '交互层' },
    ],
    features: [
      { id: 'db', title: '存储内核', domain: 'core', actors: ['system'], modules: ['src/db.mjs'], entrypoints: ['src/db.mjs'], tests: ['test/db.test.mjs'], dependsOn: [] },
      { id: 'auth', title: '鉴权服务', domain: 'service', actors: ['system'], modules: ['src/auth.mjs'], entrypoints: ['src/auth.mjs'], tests: ['test/auth.test.mjs'], dependsOn: ['db'] },
      { id: 'billing', title: '计费引擎', domain: 'service', actors: ['system'], modules: ['src/billing.mjs'], entrypoints: ['src/billing.mjs'], tests: ['test/billing.test.mjs'], dependsOn: ['db', 'auth'] },
      { id: 'portal', title: '控制台', domain: 'ui', actors: ['user'], modules: ['src/portal.mjs'], entrypoints: ['src/portal.mjs'], tests: ['test/portal.test.mjs'], dependsOn: ['auth', 'billing'] },
    ],
    flows: [
      {
        id: 'checkout',
        title: '下单计费流',
        actors: ['user', 'system'],
        features: ['portal', 'auth', 'billing', 'db'],
        steps: [
          { feature: 'portal', actor: 'user', action: '提交订单' },
          { feature: 'auth', actor: 'system', action: '校验会话' },
          { feature: 'billing', actor: 'system', action: '生成账单' },
          { feature: 'db', actor: 'system', action: '落库事务' },
        ],
      },
    ],
  }
}

function makeSyntheticEvidence() {
  return {
    activeTabs: [
      { id: 'architecture', tier: 1, title: '架构全景' },
      { id: 'workflow', tier: 1, title: '主流程' },
      { id: 'tree', tier: 1, title: '目录树' },
      { id: 'erd', tier: 2, title: '数据实体 (ERD)' },
      { id: 'class', tier: 2, title: '类型继承关系' },
      { id: 'sequence', tier: 2, title: '调用时序链' },
      { id: 'lifecycle', tier: 2, title: '状态生命周期' },
      { id: 'dataflow', tier: 2, title: '管道与工作流数据流' },
      { id: 'timeline', tier: 2, title: '演进时间线' },
      { id: 'waterfall', tier: 3, title: '实测耗时瀑布' },
    ],
    skippedTabs: [],
    diagrams: {
      tree: {
        id: 'tree',
        tier: 1,
        empty: false,
        totalFiles: 9,
        root: {
          name: 'demo-repo',
          path: '',
          isFile: false,
          fileCount: 9,
          children: [
            {
              name: 'src',
              path: 'src',
              isFile: false,
              fileCount: 6,
              children: [
                { name: 'a.mjs', path: 'src/a.mjs', isFile: true, fileCount: 1, children: [] },
                { name: 'b.mjs', path: 'src/b.mjs', isFile: true, fileCount: 1, children: [] },
                { name: 'c.mjs', path: 'src/c.mjs', isFile: true, fileCount: 1, children: [] },
                { name: 'd.mjs', path: 'src/d.mjs', isFile: true, fileCount: 1, children: [] },
                {
                  name: 'sub',
                  path: 'src/sub',
                  isFile: false,
                  fileCount: 2,
                  children: [
                    { name: 'x.mjs', path: 'src/sub/x.mjs', isFile: true, fileCount: 1, children: [] },
                    { name: 'y.mjs', path: 'src/sub/y.mjs', isFile: true, fileCount: 1, children: [] },
                  ],
                },
              ],
            },
            {
              name: 'docs',
              path: 'docs',
              isFile: false,
              fileCount: 2,
              children: [
                { name: 'README.md', path: 'docs/README.md', isFile: true, fileCount: 1, children: [] },
                { name: 'TDD.md', path: 'docs/TDD.md', isFile: true, fileCount: 1, children: [] },
              ],
            },
          ],
        },
      },
      erd: {
        id: 'erd',
        tier: 2,
        entities: [
          { name: 'User', source: 'prisma/schema.prisma', fields: ['id:Int', 'email:String', 'orders:Order[]'] },
          { name: 'Order', source: 'prisma/schema.prisma', fields: ['id:Int', 'userId:Int', 'total:Decimal', 'items:OrderItem[]'] },
          { name: 'OrderItem', source: 'prisma/schema.prisma', fields: ['id:Int', 'orderId:Int', 'sku:String', 'qty:Int'] },
          { name: 'AuditLog', source: 'migrations/001.sql', fields: ['id:INT', 'user_id:INT', 'action:TEXT'] },
        ],
        relations: [
          { from: 'Order', to: 'User', label: 'user' },
          { from: 'OrderItem', to: 'Order', label: 'order' },
          { from: 'AuditLog', to: 'User', label: 'user_id' },
        ],
      },
      class: {
        id: 'class',
        tier: 2,
        classes: ['BaseService', 'AuthService', 'BillingService', 'Serializable', 'AdminAuthService'],
        edges: [
          { from: 'AuthService', to: 'BaseService', kind: 'extends', file: 'src/auth.ts' },
          { from: 'BillingService', to: 'BaseService', kind: 'extends', file: 'src/billing.ts' },
          { from: 'BillingService', to: 'Serializable', kind: 'implements', file: 'src/billing.ts' },
          { from: 'AdminAuthService', to: 'AuthService', kind: 'extends', file: 'src/admin.ts' },
        ],
      },
      sequence: {
        id: 'sequence',
        tier: 2,
        maxHops: 4,
        participants: ['src/ui/Page.tsx', 'src/hooks/useOrder.ts', 'src/svc/order.ts', 'src/repo/db.ts'],
        steps: [
          { hop: 1, from: 'src/ui/Page.tsx', to: 'src/hooks/useOrder.ts', label: 'submitOrder()' },
          { hop: 2, from: 'src/hooks/useOrder.ts', to: 'src/svc/order.ts', label: 'createOrder()' },
          { hop: 3, from: 'src/svc/order.ts', to: 'src/svc/order.ts', label: 'validate()' },
          { hop: 4, from: 'src/svc/order.ts', to: 'src/repo/db.ts', label: 'insertRow()' },
        ],
      },
      lifecycle: {
        id: 'lifecycle',
        tier: 2,
        states: ['draft', 'pending', 'paid', 'shipped', 'cancelled'],
        transitions: [
          { from: 'draft', to: 'pending', label: 'submit' },
          { from: 'pending', to: 'paid', label: 'pay' },
          { from: 'paid', to: 'shipped', label: 'ship' },
          { from: 'paid', to: 'draft', label: 'refund' },
          { from: 'draft', to: 'shipped', label: 'fast-track' },
          { from: 'pending', to: 'cancelled', label: 'cancel' },
        ],
      },
      dataflow: {
        id: 'dataflow',
        tier: 2,
        stages: [
          { id: 'ci.yml:lint', source: '.github/workflows/ci.yml', kind: 'ci-job' },
          { id: 'ci.yml:unit', source: '.github/workflows/ci.yml', kind: 'ci-job' },
          { id: 'ci.yml:build', source: '.github/workflows/ci.yml', kind: 'ci-job' },
          { id: 'ci.yml:deploy', source: '.github/workflows/ci.yml', kind: 'ci-job' },
        ],
        edges: [
          { from: 'ci.yml:lint', to: 'ci.yml:build' },
          { from: 'ci.yml:unit', to: 'ci.yml:build' },
          { from: 'ci.yml:build', to: 'ci.yml:deploy' },
        ],
      },
      timeline: {
        id: 'timeline',
        tier: 2,
        events: [
          { kind: 'tag', id: 'v0.1.0', date: '2025-01-01T00:00:00Z', sha: '1111111', label: 'init' },
          { kind: 'merge', id: 'm1', date: '2025-01-03T00:00:00Z', sha: '2222222', label: 'feat: auth' },
          { kind: 'tag', id: 'v0.2.0', date: '2025-01-06T00:00:00Z', sha: '3333333', label: 'release v0.2' },
          { kind: 'tag', id: 'v1.0.0', date: '2026-01-10T00:00:00Z', sha: '4444444', label: 'major v1.0' },
        ],
      },
      waterfall: {
        id: 'waterfall',
        tier: 3,
        totalMs: 120,
        spans: [
          { id: 's1', label: 'scan-files', startMs: 0, durationMs: 30, endMs: 30 },
          { id: 's2', label: 'parse-imports', startMs: 30, durationMs: 45, endMs: 75 },
          { id: 's3', label: 'layout-route', startMs: 75, durationMs: 45, endMs: 120 },
        ],
      },
    },
  }
}

export function registerVisualLayoutV2Cases(cases) {
  cases.push(['[VisualLayoutV2-C5] 10 类图表确定性布局：tree 叶子叠放、class 半列步进、lifecycle 脊柱顶弧、timeline 静默断口压缩、waterfall 实测校验与字节级幂等', async () => {
    const { diagrams, charts, geo } = await loadLayoutV2Mods()
    const featureMap = makeSampleFeatureMap()
    const evidence = makeSyntheticEvidence()

    const m1 = buildVisualModel({ featureMap, evidence, mode: 'architecture-map' })
    const m2 = buildVisualModel({ featureMap, evidence, mode: 'architecture-map' })
    if (JSON.stringify(m1) !== JSON.stringify(m2)) {
      return '同一输入重复调用 buildVisualModel 未产出字节级一致模型'
    }

    const expectedTypes = ['architecture', 'workflow', 'tree', 'erd', 'class', 'sequence', 'lifecycle', 'dataflow', 'timeline', 'waterfall']
    for (const kind of expectedTypes) {
      const diag = m1.diagrams?.[kind]
      if (!diag) return `buildVisualModel.diagrams 缺少图表类型: ${kind}`
      const check = geo.verifyDiagramGeometry(diag)
      if (!check.ok) {
        return `${kind} 图表几何校验未通过: ${JSON.stringify(check.violations.slice(0, 5))}`
      }
    }

    // 1. tree: >=3 叶子节点自动垂直叠放，反例 <3 叶子不触发叠放
    const treeLayout = m1.diagrams.tree
    const stackedLeaves = treeLayout.nodes.filter((n) => n.isStackedLeaf)
    if (stackedLeaves.length < 4 || (treeLayout.meta?.stackedLeafGroups ?? 0) < 1) {
      return `tree 未对 >=3 叶子节点执行垂直叠放: stacked=${stackedLeaves.length}, meta=${JSON.stringify(treeLayout.meta)}`
    }
    const xsOfSrcLeaves = new Set(stackedLeaves.filter((n) => n.path?.startsWith('src/')).map((n) => n.x))
    if (xsOfSrcLeaves.size !== 1) {
      return `同父节点垂直叠放叶子 x 坐标应一致对齐，实得: ${JSON.stringify([...xsOfSrcLeaves])}`
    }
    const smallTree = diagrams.layoutTreeDiagram({
      root: {
        name: 'small',
        path: '',
        isFile: false,
        children: [
          { name: 'one.js', path: 'one.js', isFile: true, children: [] },
          { name: 'two.js', path: 'two.js', isFile: true, children: [] },
        ],
      },
    })
    if ((smallTree.meta?.stackedLeafGroups ?? 0) !== 0 || smallTree.nodes.some((n) => n.isStackedLeaf)) {
      return `仅 2 个叶子节点不应触发垂直叠放: ${JSON.stringify(smallTree.meta)}`
    }

    // 2. erd: 字段高度随字段数精确伸缩且附基数标签
    const erdLayout = m1.diagrams.erd
    const userNode = erdLayout.nodes.find((n) => n.id === 'User')
    const orderNode = erdLayout.nodes.find((n) => n.id === 'Order')
    if (!userNode || !orderNode || orderNode.h <= userNode.h) {
      return `erd 实体卡高度应随字段数增长: User=${userNode?.h}, Order=${orderNode?.h}`
    }
    if (!erdLayout.edges.every((e) => e.cardinality === '1:N' || e.cardinality === '1:1')) {
      return `erd 关系边缺少合法基数标签: ${JSON.stringify(erdLayout.edges.map((e) => e.cardinality))}`
    }

    // 3. class: 半列步进 + extends(solid) / implements(dashed) 区分
    const classLayout = m1.diagrams.class
    if (!classLayout.meta?.halfColStaggered) {
      return `class 布局未启用半列步进交错: ${JSON.stringify(classLayout.meta)}`
    }
    const extEdge = classLayout.edges.find((e) => e.kind === 'extends')
    const impEdge = classLayout.edges.find((e) => e.kind === 'implements')
    if (!extEdge || extEdge.lineStyle !== 'solid' || !impEdge || impEdge.lineStyle !== 'dashed') {
      return `class 未区分 extends(solid) 与 implements(dashed): ${JSON.stringify({ extEdge, impEdge })}`
    }

    // 4. sequence: 生命线完整且消息 y 严格递增、含自调用
    const seqLayout = m1.diagrams.sequence
    if (!Array.isArray(seqLayout.lifelines) || seqLayout.lifelines.length !== 4) {
      return `sequence 生命线数量异常: ${seqLayout.lifelines?.length}`
    }
    for (let i = 1; i < seqLayout.messages.length; i++) {
      if (seqLayout.messages[i].y <= seqLayout.messages[i - 1].y) {
        return `sequence 消息 y 坐标未严格递增: ${JSON.stringify(seqLayout.messages.map((m) => m.y))}`
      }
    }
    if (!seqLayout.messages.some((m) => m.isSelfCall)) {
      return 'sequence 未正确识别自调用消息环'
    }

    // 5. lifecycle: 主干脊柱 >= 4 且跨跳/回退边标记顶部跳弧
    const lcLayout = m1.diagrams.lifecycle
    if (!Array.isArray(lcLayout.spineIds) || lcLayout.spineIds.length < 4) {
      return `lifecycle 未提取最长主干脊柱: ${JSON.stringify(lcLayout.spineIds)}`
    }
    if (!lcLayout.edges.some((e) => e.isTopArc)) {
      return `lifecycle 跨跳/回退迁移未走顶部跳弧: ${JSON.stringify(lcLayout.edges)}`
    }

    // 6. timeline: 长静默区间 (>4x 中位间隔) 自动压缩断口；反例均匀间隔零断口
    const tlLayout = m1.diagrams.timeline
    if (!Array.isArray(tlLayout.quietBreaks) || tlLayout.quietBreaks.length < 1) {
      return `timeline 未对超过中位间隔 4x 的长静默区间插入压缩断口: ${JSON.stringify(tlLayout.quietBreaks)}`
    }
    const uniformTl = charts.layoutTimelineDiagram({
      events: [
        { kind: 'tag', id: 'v1', date: '2025-01-01T00:00:00Z', label: 'v1' },
        { kind: 'tag', id: 'v2', date: '2025-01-08T00:00:00Z', label: 'v2' },
        { kind: 'tag', id: 'v3', date: '2025-01-15T00:00:00Z', label: 'v3' },
      ],
    })
    if ((uniformTl.quietBreaks?.length ?? 0) !== 0) {
      return `均匀时间间隔不应触发静默压缩断口: ${JSON.stringify(uniformTl.quietBreaks)}`
    }

    // 7. waterfall: 仅消费真实实测 span，反例负数/NaN 被过滤
    const wfLayout = m1.diagrams.waterfall
    if (wfLayout.nodes.length !== 3 || wfLayout.totalMs !== 120) {
      return `waterfall 甘特条数量或总时长异常: ${JSON.stringify({ n: wfLayout.nodes.length, totalMs: wfLayout.totalMs })}`
    }
    const badWf = charts.layoutWaterfallDiagram({
      spans: [{ id: 'bad', label: 'bad', startMs: -5, durationMs: NaN }],
    })
    if (badWf.nodes.length !== 0) {
      return `waterfall 不应渲染非法负值/NaN span: ${JSON.stringify(badWf.nodes)}`
    }
    return true
  }])

  cases.push(['[VisualLayoutV2-C6] visual-router：端口防重叠散布、同侧共享干线捆绑、避障网格 Dijkstra 零穿盒与极端围困安全退化', async () => {
    const { router, geo } = await loadLayoutV2Mods()

    // 1. spreadSidePorts: 同侧多边互不重合，单边居中
    const box = { id: 'src', x: 40, y: 100, w: 200, h: 100 }
    const ports4 = router.spreadSidePorts(box, 'right', 4, 16)
    if (ports4.length !== 4) return `spreadSidePorts 应返回 4 个端口，实得 ${ports4.length}`
    const uniqueY = new Set(ports4.map((p) => p.y))
    if (uniqueY.size !== 4) return `spreadSidePorts 同侧 4 端口发生重合: ${JSON.stringify(ports4)}`
    if (ports4.some((p) => p.x !== 240 || p.y < 116 || p.y > 184)) {
      return `spreadSidePorts 越出边或留白范围: ${JSON.stringify(ports4)}`
    }
    const port1 = router.spreadSidePorts(box, 'right', 1, 16)
    if (port1.length !== 1 || port1[0].y !== 150) {
      return `单端口应严格居中: ${JSON.stringify(port1)}`
    }

    // 2. bundleSharedTrunk: 同源同侧多边提取共享干线且散布端口不重合
    const boxMap = new Map([
      ['A', { id: 'A', x: 40, y: 180, w: 160, h: 90, cx: 120, cy: 225 }],
      ['B1', { id: 'B1', x: 420, y: 40, w: 160, h: 80, cx: 500, cy: 80 }],
      ['B2', { id: 'B2', x: 420, y: 180, w: 160, h: 80, cx: 500, cy: 220 }],
      ['B3', { id: 'B3', x: 420, y: 320, w: 160, h: 80, cx: 500, cy: 360 }],
    ])
    const fanEdges = [
      { id: 'A->B1', fromId: 'A', toId: 'B1' },
      { id: 'A->B2', fromId: 'A', toId: 'B2' },
      { id: 'A->B3', fromId: 'A', toId: 'B3' },
    ]
    const bundled = router.bundleSharedTrunk(fanEdges, boxMap)
    const srcYs = fanEdges.map((e) => bundled.assignments.get(e.id)?.srcPort?.y)
    if (new Set(srcYs).size !== 3) {
      return `同源同侧 3 条边端口未散布去重: ${JSON.stringify(srcYs)}`
    }
    const trunkCoords = fanEdges.map((e) => bundled.assignments.get(e.id)?.trunk?.coord)
    if (trunkCoords.some((c) => !Number.isFinite(c)) || new Set(trunkCoords).size !== 1) {
      return `同源同侧 3 条边未共享同一干线坐标: ${JSON.stringify(trunkCoords)}`
    }

    // 3. routeOrthogonalObstacleGrid: 复杂双障碍迷宫必须 0 穿盒且含圆角正交路径
    const srcBox = { id: 'S', x: 40, y: 180, w: 140, h: 80 }
    const dstBox = { id: 'T', x: 560, y: 180, w: 140, h: 80 }
    const obs1 = { id: 'O1', x: 240, y: 100, w: 110, h: 240 }
    const obs2 = { id: 'O2', x: 390, y: 140, w: 110, h: 220 }
    const obstacles = [srcBox, dstBox, obs1, obs2]
    const routed = router.routeOrthogonalObstacleGrid(
      { x: srcBox.x + srcBox.w, y: srcBox.y + srcBox.h / 2, side: 'right' },
      { x: dstBox.x, y: dstBox.y + dstBox.h / 2, side: 'left' },
      obstacles,
      { srcBox, dstBox, clearance: 16, bendPenalty: 18 },
    )
    if (routed.routedFallback) {
      return `存在可行通道时不应退化为 routedFallback: ${JSON.stringify(routed)}`
    }
    const check = geo.verifyDiagramGeometry({
      id: 'maze',
      width: 780,
      height: 460,
      nodes: obstacles,
      edges: [{ id: 'S->T', fromId: 'S', toId: 'T', points: routed.points, pathD: routed.pathD }],
    })
    if (!check.ok || check.stats.crossings !== 0) {
      return `复杂障碍路由发生穿盒或越界: ${JSON.stringify(check)}`
    }
    if (!routed.pathD.includes(' Q ') || !routed.pathD.startsWith('M ')) {
      return `避障路由路径缺少圆角正交 SVG 指令: ${routed.pathD}`
    }

    // 4. 极端围困场景：目标盒被巨大障碍盒完全吞没 -> 安全退化 routedFallback: true 且无 NaN
    const walledTarget = { id: 'WT', x: 300, y: 200, w: 80, h: 60 }
    const giantWall = { id: 'WALL', x: 220, y: 120, w: 240, h: 220 }
    const fallbackRes = router.routeOrthogonalObstacleGrid(
      { x: 140, y: 230, side: 'right' },
      { x: 300, y: 230, side: 'left' },
      [srcBox, walledTarget, giantWall],
      { srcBox, dstBox: walledTarget, clearance: 14 },
    )
    if (!fallbackRes.routedFallback || !fallbackRes.pathD || fallbackRes.points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) {
      return `完全围困场景应安全退化为 routedFallback 且坐标有限: ${JSON.stringify(fallbackRes)}`
    }
    return true
  }])

  cases.push(['[VisualLayoutV2-C7] visual-geometry-check：纯 Node 确定性检出 NODE_OVERLAP / OUT_OF_BOUNDS / EDGE_CROSSES_BOX / EMPTY_ACTIVE_DIAGRAM（正反双向）', async () => {
    const { geo } = await loadLayoutV2Mods()

    // 正向：干净无碰撞图必过
    const cleanDiagram = {
      id: 'clean',
      width: 600,
      height: 300,
      nodes: [
        { id: 'grp', x: 20, y: 20, w: 560, h: 260, isContainer: true },
        { id: 'n1', x: 40, y: 80, w: 120, h: 60 },
        { id: 'n2', x: 420, y: 80, w: 120, h: 60 },
      ],
      edges: [
        { id: 'e1', fromId: 'n1', toId: 'n2', pathD: 'M 160 110 L 420 110' },
      ],
    }
    const cleanRes = geo.verifyDiagramGeometry(cleanDiagram)
    if (!cleanRes.ok || cleanRes.violations.length !== 0) {
      return `合法容器嵌套与无碰撞连线被误报: ${JSON.stringify(cleanRes)}`
    }

    // 负向 1：NODE_OVERLAP
    const overlapRes = geo.verifyDiagramGeometry({
      id: 'ov',
      width: 500,
      height: 300,
      nodes: [
        { id: 'a', x: 50, y: 50, w: 120, h: 80 },
        { id: 'b', x: 130, y: 90, w: 120, h: 80 },
      ],
      edges: [],
    })
    if (overlapRes.ok || overlapRes.stats.overlaps < 1 || !overlapRes.violations.some((v) => v.code === 'NODE_OVERLAP')) {
      return `未检出人工注入的 NODE_OVERLAP: ${JSON.stringify(overlapRes)}`
    }

    // 负向 2：OUT_OF_BOUNDS
    const oobRes = geo.verifyDiagramGeometry({
      id: 'oob',
      width: 300,
      height: 200,
      nodes: [{ id: 'a', x: 250, y: 40, w: 100, h: 60 }],
      edges: [],
    })
    if (oobRes.ok || oobRes.stats.outOfBounds < 1 || !oobRes.violations.some((v) => v.code === 'OUT_OF_BOUNDS')) {
      return `未检出人工注入的 OUT_OF_BOUNDS: ${JSON.stringify(oobRes)}`
    }

    // 负向 3：EDGE_CROSSES_BOX（仅传 pathD，无 points 数组也能精确解析检出）
    const crossRes = geo.verifyDiagramGeometry({
      id: 'cross',
      width: 600,
      height: 300,
      nodes: [
        { id: 's', x: 20, y: 100, w: 100, h: 60 },
        { id: 'mid', x: 240, y: 80, w: 120, h: 100 },
        { id: 't', x: 460, y: 100, w: 100, h: 60 },
      ],
      edges: [
        { id: 'bad-edge', fromId: 's', toId: 't', pathD: 'M 120 130 L 460 130' },
      ],
    })
    if (crossRes.ok || crossRes.stats.crossings < 1 || !crossRes.violations.some((v) => v.code === 'EDGE_CROSSES_BOX')) {
      return `未检出人工注入的 EDGE_CROSSES_BOX: ${JSON.stringify(crossRes)}`
    }

    // 负向 4：EMPTY_ACTIVE_DIAGRAM
    const emptyRes = geo.verifyDiagramGeometry({
      id: 'empty',
      width: 400,
      height: 300,
      nodes: [],
      edges: [],
    })
    if (emptyRes.ok || !emptyRes.violations.some((v) => v.code === 'EMPTY_ACTIVE_DIAGRAM')) {
      return `未检出人工注入的 EMPTY_ACTIVE_DIAGRAM: ${JSON.stringify(emptyRes)}`
    }
    return true
  }])

  cases.push(['[VisualLayoutV2-C8] 端到端串联 Wave 1 静态证据 -> 10 类图布局 -> geometryReport 全绿与 4 功能 HTML 体积 <= 60KB 零回归', async () => {
    const dir = tmpProject({
      'prisma/schema.prisma': 'model Account { id Int @id\n orders Order[] }\nmodel Order { id Int @id\n accountId Int\n account Account @relation(fields: [accountId], references: [id]) }\n',
      'src/base.ts': 'export class BaseHandler {}\nexport interface Runner {}\nexport class HttpHandler extends BaseHandler implements Runner {}\nexport class GrpcHandler extends BaseHandler {}\n',
      'src/ui.ts': 'import { ctl } from "./ctl.js"\nexport const ui = () => ctl()\n',
      'src/ctl.ts': 'import { svc } from "./svc.js"\nexport const ctl = () => svc()\n',
      'src/svc.ts': 'import { repo } from "./repo.js"\nexport type JobStatus = "queued" | "running" | "done" | "failed"\nexport const JOB_TRANSITIONS = { queued: ["running"], running: ["done", "failed"], failed: ["queued"] }\nexport const svc = () => repo()\n',
      'src/repo.ts': 'export const repo = () => 1\n',
      '.github/workflows/ci.yml': 'name: CI\non: [push]\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo lint\n  test:\n    needs: lint\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo test\n',
    })
    try {
      gitInit(dir, { branch: 'main', message: 'chore: init' })
      gitSync(dir, ['tag', 'v0.1.0'])
      writeFileSync(join(dir, 'src/repo.ts'), 'export const repo = () => 2\n', 'utf8')
      gitCommitFast(dir, 'feat: bump repo')
      gitSync(dir, ['tag', 'v0.2.0'])

      const analysis = await analyzeRepoStatic(dir)
      const evidence = await extractMultiDiagramEvidence(dir, {
        analysis,
        telemetrySpans: [
          { id: 't1', label: 'analyze', startMs: 0, durationMs: 14 },
          { id: 't2', label: 'layout', startMs: 14, durationMs: 9 },
        ],
      })
      const model = buildVisualModel({ featureMap: makeSampleFeatureMap(), evidence, analysis })
      if (!model.geometryReport?.ok) {
        return `端到端多图 geometryReport 未通过: ${JSON.stringify(model.geometryReport)}`
      }
      if (!Array.isArray(model.activeTabs) || model.activeTabs.length !== 10) {
        return `端到端全证据仓库应激活全部 10 类图，实得 ${model.activeTabs?.length}: ${JSON.stringify(model.activeTabs?.map((t) => t.id))}`
      }
      const rendered = renderVisualHtml({ visualModel: model, featureMapSha256: 'e'.repeat(64) })
      if (rendered.bytes > 60 * 1024) {
        return `4 功能 HTML 体积超出 60KB 红线: ${rendered.bytes} bytes`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])
}
