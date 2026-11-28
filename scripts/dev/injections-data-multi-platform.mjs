/**
 * injections-data-multi-platform.mjs —— Milestone C Wave 3 多平台、仓外实证附件与双同步 Bug 故障注入复验表。
 *
 * 自动被 `scripts/dev/injections-data.mjs` 发现加载；所有 `kit/skills/` 目标均带 `alsoDropIn` 同步注入 `.agents/skills/`。
 */

export const INJECTIONS_MULTI_PLATFORM = [
  {
    id: 'I_MP1',
    what: 'master-criteria-sync.mjs: 放开 planBootstrap 期间自动挂载 docs/specs/ 导致 PR #215 回归',
    file: 'kit/skills/lib/master-criteria-sync.mjs',
    alsoDropIn: ['.agents/skills/lib/master-criteria-sync.mjs'],
    from: '  const allowSpec = !isBootstrap || !effectiveHasPrd || Boolean(explicitSpec)',
    to: '  const allowSpec = true',
    expect: 'C12 回归（PR #215）：planBootstrap 阻断两处自动挂子切片 SPEC/Todo 且四入口以 prdFile 为主源',
  },
  {
    id: 'I_MP2',
    what: 'master-criteria-sync.mjs: resolvePrimaryPlanDocOrder 在 planBootstrap 仍先读 spec 而非 prd',
    file: 'kit/skills/lib/master-criteria-sync.mjs',
    alsoDropIn: ['.agents/skills/lib/master-criteria-sync.mjs'],
    from: "  return ledger?.planBootstrap === true\n    ? ['prd', 'spec', 'todo']\n    : ['spec', 'todo', 'prd']",
    to: "  return ['spec', 'todo', 'prd']",
    expect: 'C12 回归（PR #215）：planBootstrap 阻断两处自动挂子切片 SPEC/Todo 且四入口以 prdFile 为主源',
  },
  {
    id: 'I_MP3',
    what: 'master-criteria-sync.mjs: collectMasterIssueCriteriaState 默认 includeSelf=true 误勾未完成当前切片',
    file: 'kit/skills/lib/master-criteria-sync.mjs',
    alsoDropIn: ['.agents/skills/lib/master-criteria-sync.mjs'],
    from: '  includeSelf = false,\n} = {}) {',
    to: '  includeSelf = true,\n} = {}) {',
    expect: 'C12 回归（Issue #219）：1:N plan-backfill 聚合已归档切片且默认 includeSelf=false 不误勾未完成切片，preserveChecked 受控',
  },
  {
    id: 'I_MP4',
    what: 'plan-sync.mjs: syncIssueCriteriaCheckboxes 忽略 preserveChecked=true 回退已勾选条目',
    file: 'kit/skills/lib/plan-sync.mjs',
    alsoDropIn: ['.agents/skills/lib/plan-sync.mjs'],
    from: '        nextChecked = preserveChecked === true ? (curChecked || desired) : desired',
    to: '        nextChecked = desired',
    expect: 'C12 回归（Issue #219）：1:N plan-backfill 聚合已归档切片且默认 includeSelf=false 不误勾未完成切片，preserveChecked 受控',
  },
  {
    id: 'I_MP5',
    what: 'verify-state.mjs: 放宽 isSafeTaskArtifactPath 路径遍历校验允许逃逸至 artifacts 根目录之外',
    file: 'kit/skills/lib/verify-state.mjs',
    alsoDropIn: ['.agents/skills/lib/verify-state.mjs'],
    from: "  if (samePath(cand, artifactsRoot)) return false\n  if (samePath(cand, expected)) return true\n  const rel = relative(expected, cand)\n  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel))",
    to: "  if (samePath(cand, artifactsRoot)) return false\n  if (samePath(cand, expected)) return true\n  return Boolean(cand && expected)",
    expect: 'C11/C13：仓外 artifacts/<taskId>/ 路径遍历守卫与 flow cleanup / flow abort 联动销毁',
  },
  {
    id: 'I_MP6',
    what: 'empirical-artifacts.mjs: 绕过 evidence.json 附件上传缓存导致重复上传',
    file: 'kit/skills/lib/empirical-artifacts.mjs',
    alsoDropIn: ['.agents/skills/lib/empirical-artifacts.mjs'],
    from: "      const cached = rec.uploaded\n        && String(rec.uploaded.providerId ?? '').toLowerCase() === providerKey\n        && String(rec.uploaded.sha256Prefix ?? '') === String(rec.sha256Prefix ?? '')\n        && Boolean(rec.uploaded.url || rec.uploaded.markdown)",
    to: '      const cached = false',
    expect: 'C11/C13：GitLab v4 Mock Forge + bare 仓实证上传缓存防重传、refs/merge-requests 真 SHA 与 .gitlab MR 模板 5 列表水合',
  },
  {
    id: 'I_MP7',
    what: 'empirical-artifacts.mjs: 实证表退化为旧 3 列丢失观察摘要与附件展示列',
    file: 'kit/skills/lib/empirical-artifacts.mjs',
    alsoDropIn: ['.agents/skills/lib/empirical-artifacts.mjs'],
    from: "    lines.push('', '| 实证附件 | 字节数 | 校验指纹 | 实证观察摘要 | 附件展示 |', '| --- | --- | --- | --- | --- |')",
    to: "    lines.push('', '| 实证附件 | 字节数 | 校验指纹 |', '| --- | --- | --- |')",
    expect: 'C11/C13：Gitee 与 Gitea 能力降级（uploadAttachment=false 不询问图床输出 5 列摘要，Gitee checks=false 跳过）',
  },
  {
    id: 'I_MP8',
    what: 'flow-cleanup.mjs: handleCleanup 漏调 destroyTaskArtifactsDir 导致仓外实证附件残留',
    file: 'kit/skills/dev-flow/scripts/flow-cleanup.mjs',
    alsoDropIn: ['.agents/skills/dev-flow/scripts/flow-cleanup.mjs'],
    from: '  const artifactsCleanup = destroyTaskArtifactsDir({ gitCommonDir: roots.gitDir, mainRoot: roots.mainRoot, taskId })\n  await releaseGitClaimLease',
    to: '  const artifactsCleanup = { destroyed: false, dir: null, fileCount: 0 }\n  await releaseGitClaimLease',
    expect: 'C11/C13：仓外 artifacts/<taskId>/ 路径遍历守卫与 flow cleanup / flow abort 联动销毁',
  },
]
