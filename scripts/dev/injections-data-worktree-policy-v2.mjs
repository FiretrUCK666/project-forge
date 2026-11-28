/**
 * injections-data-worktree-policy-v2.mjs —— Wave 2 (C7..C9) 故障注入复验数据表（I1121-I1126）。
 */

export const INJECTIONS_WORKTREE_POLICY_V2 = [
  {
    id: 'I1121',
    what: 'C8 exec.mjs: Windows .cmd/.bat 参数校验放行命令拼接元字符（CVE-2024-27980 回归）',
    file: 'kit/skills/lib/exec.mjs',
    alsoDropIn: ['.agents/skills/lib/exec.mjs'],
    from: '    if (UNSAFE_WIN_BATCH_ARG_RE.test(raw)) {',
    to: '    if (false && UNSAFE_WIN_BATCH_ARG_RE.test(raw)) {',
    expect: '[C8]',
  },
  {
    id: 'I1122',
    what: 'C8 exec.mjs: execSafe 丢失 BLOCKED_UNSAFE_WIN_BATCH_ARG 结构化返回契约',
    file: 'kit/skills/lib/exec.mjs',
    alsoDropIn: ['.agents/skills/lib/exec.mjs'],
    from: "      if (err?.blockedCode === 'BLOCKED_UNSAFE_WIN_BATCH_ARG' || err?.code === 'BLOCKED_UNSAFE_WIN_BATCH_ARG') {",
    to: "      if (false && err?.blockedCode === 'BLOCKED_UNSAFE_WIN_BATCH_ARG') {",
    expect: '[C8]',
  },
  {
    id: 'I1123',
    what: 'C7 worktree-dep-pool.mjs: removeReadOnlyTreeSync 跳过递归解除只读位（Windows NTFS EPERM 回归）',
    file: 'kit/skills/lib/worktree-dep-pool.mjs',
    alsoDropIn: ['.agents/skills/lib/worktree-dep-pool.mjs'],
    from: '  unprotect(dirPath)\n  if (!dryRunRm) rmSync(dirPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })',
    to: '  if (!dryRunRm) rmSync(dirPath, { recursive: true, force: true, maxRetries: 1, retryDelay: 10 })',
    expect: '[C7]',
  },
  {
    id: 'I1124',
    what: 'C9 workflow-policy.mjs: isOneWayBoundaryFile 漏判 *.prisma / k8s/** 单向门文件',
    file: 'kit/skills/lib/workflow-policy.mjs',
    alsoDropIn: ['.agents/skills/lib/workflow-policy.mjs'],
    from: '  if (/\\.(?:prisma|cql|cypher|proto|graphql|gql|tf|tfvars)$/i.test(base)) return true',
    to: '  if (false && /\\.(?:prisma|cql|cypher|proto|graphql|gql|tf|tfvars)$/i.test(base)) return true',
    expect: '[C9]',
  },
  {
    id: 'I1125',
    what: 'C9 workflow-policy.mjs: resolveScopedVerificationGate 退回仅读 p.dir/p.ecosystem 导致 affectedPackages 坍缩',
    file: 'kit/skills/lib/workflow-policy.mjs',
    alsoDropIn: ['.agents/skills/lib/workflow-policy.mjs'],
    from: "  const pkgDirOf = (p) => posixPath(String(p?.dirRel ?? p?.dir ?? '')).replace(/^\\.\\//, '').replace(/\\/+$/, '')",
    to: "  const pkgDirOf = (p) => posixPath(String(p?.dir ?? '')).replace(/^\\.\\//, '').replace(/\\/+$/, '')",
    expect: '[C9]',
  },
  {
    id: 'I1126',
    what: 'C9 flow-intake.mjs: --apply 忽略 contextBasis 指纹漂移继续写回远端',
    file: 'kit/skills/dev-flow/scripts/flow-intake.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-intake.mjs'],
    from: '      if (baseline && latestBasis && baseline !== latestBasis) {',
    to: '      if (false && baseline && latestBasis && baseline !== latestBasis) {',
    expect: '[C9]',
  },
]
