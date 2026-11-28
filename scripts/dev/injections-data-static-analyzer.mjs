/**
 * injections-data-static-analyzer.mjs —— Milestone B Slice 1 (`zero-token-static-analyzer`, C1..C4)
 * 故障注入复验数据表（I1001-I1006）。
 */

export const INJECTIONS_STATIC_ANALYZER = [
  {
    id: 'I1001',
    what: 'C1 static-analyzer: 破坏 isCacheEntryFresh 使变更文件错误复用旧缓存而不失效',
    file: 'kit/skills/lib/static-analyzer.mjs',
    alsoDropIn: ['.agents/skills/lib/static-analyzer.mjs'],
    from: 'function isCacheEntryFresh(cached, { blobSha, mtimeMs, size }) {\n  if (!cached || typeof cached !== \'object\') return false\n  if (cached.size !== size) return false\n  if (blobSha) return cached.blobSha === blobSha\n  return !cached.blobSha && cached.mtimeMs === mtimeMs\n}',
    to: 'function isCacheEntryFresh(cached) {\n  return Boolean(cached && typeof cached === \'object\')\n}',
    expect: '[StaticAnalyzer-C1]',
  },
  {
    id: 'I1002',
    what: 'C2 static-evidence: 放宽 Tier 2 class 阈值 (<3 边即激活) 导致低证据产出空/弱 Tab',
    file: 'kit/skills/lib/static-evidence.mjs',
    alsoDropIn: ['.agents/skills/lib/static-evidence.mjs'],
    from: '  const active = edges.length >= 3',
    to: '  const active = edges.length >= 1',
    expect: '[StaticAnalyzer-C2]',
  },
  {
    id: 'I1003',
    what: 'C2 static-evidence: 放宽 Tier 3 waterfall 非负有限数值校验导致非法遥测 span 激活',
    file: 'kit/skills/lib/static-evidence.mjs',
    alsoDropIn: ['.agents/skills/lib/static-evidence.mjs'],
    from: '    if (!id || !label || !Number.isFinite(startMs) || startMs < 0 || !Number.isFinite(durationMs) || durationMs < 0) {\n      continue\n    }',
    to: '    if (!id || !label) {\n      continue\n    }',
    expect: '[StaticAnalyzer-C2]',
  },
  {
    id: 'I1004',
    what: 'C3 diff-materiality: 绕过 SCHEMA_MIGRATION_RE 必触发门控导致 Schema 迁移未标记 mandatory',
    file: 'kit/skills/lib/diff-materiality.mjs',
    alsoDropIn: ['.agents/skills/lib/diff-materiality.mjs'],
    from: '    if (SCHEMA_MIGRATION_RE.test(file)) {',
    to: '    if (false && SCHEMA_MIGRATION_RE.test(file)) {',
    expect: '[StaticAnalyzer-C3]',
  },
  {
    id: 'I1005',
    what: 'C3 diff-materiality: 绕过 LOCKFILE_NAMES 过滤导致纯锁文件改动被误判为实质变更',
    file: 'kit/skills/lib/diff-materiality.mjs',
    alsoDropIn: ['.agents/skills/lib/diff-materiality.mjs'],
    from: '    if (LOCKFILE_NAMES.has(baseName)) {',
    to: '    if (false && LOCKFILE_NAMES.has(baseName)) {',
    expect: '[StaticAnalyzer-C3]',
  },
  {
    id: 'I1006',
    what: 'C3 architecture-map: 放行 verifyArchitectureMapSync 的 dirty-diff-overlay 检查导致脏常青图逃逸',
    file: 'kit/skills/lib/architecture-map.mjs',
    alsoDropIn: ['.agents/skills/lib/architecture-map.mjs'],
    from: '  const dirtyCheck = detectDirtyDiffOverlay(html)\n  if (dirtyCheck.dirty) {',
    to: '  const dirtyCheck = detectDirtyDiffOverlay(html)\n  if (false && dirtyCheck.dirty) {',
    expect: '[StaticAnalyzer-C3]',
  },
]
