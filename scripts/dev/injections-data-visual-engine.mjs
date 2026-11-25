/**
 * injections-data-visual-engine.mjs —— Slice 2 (`visual-engine-arch-map`) C5–C8 故障注入复验数据表（I961–I964）。
 */

export const INJECTIONS_VISUAL_ENGINE = [
  {
    id: 'I961',
    what: 'C6 static-gates: 放行未校验 SHA256 的 docs/architecture-map.html 豁免 UI 实证门禁',
    file: 'kit/skills/lib/static-gates.mjs',
    alsoDropIn: ['.agents/skills/lib/static-gates.mjs'],
    from: "  if (p === 'docs/architecture-map.html' && repoRoot) {\n    const check = verifyArchitectureMapHeader(repoRoot, p)\n    if (check.ok) return false\n  }",
    to: "  if (p === 'docs/architecture-map.html') {\n    return false\n  }",
    expect: 'Visual Engine C6：isUiVisualFile 单源豁免校验（有效图豁免 vs 篡改图与业务 HTML 拦截）',
  },
  {
    id: 'I962',
    what: 'C7 flow-lifecycle-hooks: 关闭 verify 阶段的 BLOCKED_ARCHITECTURE_MAP_DRIFT 阻断门禁',
    file: 'kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'],
    from: "  const syncRes = verifyArchitectureMapSync(root)\n  if (!syncRes.ok) {",
    to: "  const syncRes = verifyArchitectureMapSync(root)\n  if (false && !syncRes.ok) {",
    expect: 'Visual Engine C7：verify-tools render / --check、no-architecture-html 豁免、只读 verify/edit-gate 阻断与 finalize 自动重渲',
  },
  {
    id: 'I963',
    what: 'C7 edit-gate: 关闭 final 阶段对 BLOCKED_ARCHITECTURE_MAP_DRIFT 的只读阻断',
    file: 'kit/skills/dev-edit/scripts/edit-gate.mjs',
    alsoDropIn: ['.agents/skills/dev-edit/scripts/edit-gate.mjs'],
    from: "      const syncRes = verifyArchitectureMapSync(workTreeRoot)\n      if (!syncRes.ok) {",
    to: "      const syncRes = verifyArchitectureMapSync(workTreeRoot)\n      if (false && !syncRes.ok) {",
    expect: 'Visual Engine C7：verify-tools render / --check、no-architecture-html 豁免、只读 verify/edit-gate 阻断与 finalize 自动重渲',
  },
  {
    id: 'I964',
    what: 'C5 visual-layout: 放开 prototype URL scheme 校验导致 javascript: 链接未被拦截',
    file: 'kit/skills/lib/visual-layout.mjs',
    alsoDropIn: ['.agents/skills/lib/visual-layout.mjs'],
    from: "  if (scheme === 'http' || scheme === 'https' || scheme === 'file') return s\n  return ''",
    to: "  if (scheme === 'http' || scheme === 'https' || scheme === 'file' || scheme === 'javascript') return s\n  return ''",
    expect: 'Visual Engine C5：布局/单文件 HTML 渲染、25-60KB 预算、幂等重写、XSS/URL 防护与 file:// 离线韧性（正反双向）',
  },
]
