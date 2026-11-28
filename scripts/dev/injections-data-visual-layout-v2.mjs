/**
 * injections-data-visual-layout-v2.mjs —— Milestone B Slice 2 (`multi-diagram-layout-engine`, C5..C8)
 * 故障注入复验数据表（I1011-I1015）。
 */

export const INJECTIONS_VISUAL_LAYOUT_V2 = [
  {
    id: 'I1011',
    what: 'C5 visual-layout-diagrams: 关闭 tree >=3 叶子节点垂直叠放导致宽树水平爆炸',
    file: 'kit/skills/lib/visual-layout-diagrams.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-layout-diagrams.mjs'],
    from: 'export const LEAF_STACK_THRESHOLD = 3',
    to: 'export const LEAF_STACK_THRESHOLD = 999',
    expect: '[VisualLayoutV2-C5]',
  },
  {
    id: 'I1012',
    what: 'C5 visual-layout-charts: 关闭 timeline >4x 长静默区间自动压缩断口',
    file: 'kit/skills/lib/visual-layout-charts.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-layout-charts.mjs'],
    from: 'export const QUIET_GAP_RATIO = 4',
    to: 'export const QUIET_GAP_RATIO = 999999',
    expect: '[VisualLayoutV2-C5]',
  },
  {
    id: 'I1013',
    what: 'C6 visual-router: 关闭 Dijkstra 障碍盒拦截导致复杂迷宫正交路由穿盒',
    file: 'kit/skills/lib/visual-router.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-router.mjs'],
    from: '      if (isSegmentBlockedByObstacles(x1, y1, x2, y2, allBoxes)) continue',
    to: '      if (false && isSegmentBlockedByObstacles(x1, y1, x2, y2, allBoxes)) continue',
    expect: '[VisualLayoutV2-C6]',
  },
  {
    id: 'I1014',
    what: 'C7 visual-geometry-check: 放行 NODE_OVERLAP 检测导致节点重叠违例逃逸',
    file: 'kit/skills/lib/visual-geometry-check.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-geometry-check.mjs'],
    from: '      const area = computeOverlapArea(a.box, b.box, epsilon)\n      if (area > 0) {',
    to: '      const area = computeOverlapArea(a.box, b.box, epsilon)\n      if (false && area > 0) {',
    expect: '[VisualLayoutV2-C7]',
  },
  {
    id: 'I1015',
    what: 'C7 visual-geometry-check: 放行 EDGE_CROSSES_BOX 检测导致连线穿盒违例逃逸',
    file: 'kit/skills/lib/visual-geometry-check.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-geometry-check.mjs'],
    from: '        if (segmentIntersectsRectInterior(p1, p2, cand.box, epsilon)) {',
    to: '        if (false && segmentIntersectsRectInterior(p1, p2, cand.box, epsilon)) {',
    expect: '[VisualLayoutV2-C7]',
  },
]
