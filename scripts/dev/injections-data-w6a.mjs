/**
 * injections-data-w6a.mjs —— Wave 6 Slice 6A 故障注入复验样本集（I425–I434）。
 *
 * 覆盖 C1..C5 核心不变量：
 *   I425-I426 (C1): 工作流 job 级 pull_request_target 结构化分析 + zizmor ignore 豁免
 *   I427-I428 (C2): matchGlobList ! 负向排除 + survey 严格零写入
 *   I429-I430 (C3): backup 无 512KB index.json 截断 + handoff 锁文件豁免/--strict-clean
 *   I431-I432 (C4): 动态 ${...} PEM 模板字面量豁免 + review.mjs secrets.tracked 含 secrets-are-placeholders
 *   I433-I434 (C5): compose-agents 大小写与仓内软链保真 + 悬空/越界软链退出码 2 拦截
 */

export const INJECTIONS_W6A = [
  {
    id: 'I425',
    what: 'C1 survey-docs: triggerIgnored 跳过时仍把 zizmor 显式豁免的 pull_request_target 判为危险工作流',
    file: 'scripts/lib/survey-docs.mjs',
    from: "    if (triggerIgnored) continue",
    to: "    if (false && triggerIgnored) continue",
    expect: 'W6A C1：工作流 job 级 pull_request_target',
  },
  {
    id: 'I426',
    what: 'C1 survey-docs: analyzeWorkflowSecurity 把 jobs.filter(unsafe) 错误替换为整段文件存在即高危',
    file: 'scripts/lib/survey-docs.mjs',
    from: "    const unsafeJobs = jobs.filter((j) => jobHasUnsafePrCheckout(j.lines, j.prevLine)).map((j) => j.id)",
    to: "    const unsafeJobs = jobs.length > 0 ? [jobs[0].id] : []",
    expect: 'W6A C1：工作流 job 级 pull_request_target',
  },
  {
    id: 'I427',
    what: 'C2 git-core: matchGlobList 忽略 ! 负向排除模式，导致 excluded/fixtures 子目录爆炸',
    file: 'kit/skills/lib/git-core.mjs',
    alsoDropIn: ['.agents/skills/lib/git-core.mjs'],
    from: "  for (const neg of negatives) {",
    to: "  for (const neg of []) {",
    expect: 'W6A C2：.slnx/MinVer/Benchmarks',
  },
  {
    id: 'I428',
    what: 'C2 survey-ecosystem: hasDotnetMinVer 返回 false 导致 MinVer 版本源退回 *.csproj',
    file: 'scripts/lib/survey-ecosystem.mjs',
    from: "      if (hasDotnetMinVer(root, s._repoRoot ?? root)) {",
    to: "      if (false && hasDotnetMinVer(root, s._repoRoot ?? root)) {",
    expect: 'W6A C2：.slnx/MinVer/Benchmarks',
  },
  {
    id: 'I429',
    what: 'C3 backup: readIndex 恢复 512KB 硬截断，>512KB index.json 静默丢历史快照',
    file: 'scripts/backup.mjs',
    from: "  const existing = readJsonSafe(indexPath, Infinity)",
    to: "  const existing = readJsonSafe(indexPath)",
    expect: 'W6A C3：backup 取消 512KB index.json 截断',
  },
  {
    id: 'I430',
    what: 'C3 handoff: --strict-clean 失效，仍按持续受管模式放行含标记 AGENTS.md',
    file: 'scripts/handoff.mjs',
    from: "  const managedActive = Boolean(!strictClean && kitManifest?.valid)",
    to: "  const managedActive = Boolean(kitManifest?.valid)",
    expect: 'W6A C3：backup 取消 512KB index.json 截断',
  },
  {
    id: 'I431',
    what: 'C4 credential-scan: matchSecretContentLine 取消动态 ${...} PEM 模板字面量豁免',
    file: 'kit/skills/lib/credential-scan.mjs',
    alsoDropIn: ['.agents/skills/lib/credential-scan.mjs'],
    from: "    if (pat.label === 'PEM private key block' && dynPem) continue",
    to: "    if (false && pat.label === 'PEM private key block' && dynPem) continue",
    expect: 'W6A C4：动态 ${...} PEM 豁免',
  },
  {
    id: 'I432',
    what: 'C4 review: secrets.tracked 移除 decision: secrets-are-placeholders 导致无法表态消解',
    file: 'scripts/review.mjs',
    from: "      `凭据形状的东西已经进了版本库：${sec.trackedWhere.join('、')}——改文件不管用，要轮换凭据并把历史处理掉`, {\n        decision: 'secrets-are-placeholders',",
    to: "      `凭据形状的东西已经进了版本库：${sec.trackedWhere.join('、')}——改文件不管用，要轮换凭据并把历史处理掉`, {",
    expect: 'W6A C4：动态 ${...} PEM 豁免',
  },
  {
    id: 'I433',
    what: 'C5 compose-agents-helpers: resolveAgentsFileTarget 退回硬编码 AGENTS.md 破坏小写文件保真',
    file: 'scripts/lib/compose-agents-helpers.mjs',
    from: "  const matched = exact ?? entries.find((n) => n.toLowerCase() === 'agents.md')",
    to: "  const matched = exact",
    expect: 'W6A C5：模板空骨架 <16KB',
  },
  {
    id: 'I434',
    what: 'C5 compose-agents: 悬空或越界软链未以退出码 2 阻断覆盖',
    file: 'scripts/compose-agents.mjs',
    from: "  if (targetInfo.dangling || targetInfo.outsideRepo) {\n    process.stderr.write(`${targetInfo.error}\\n`)\n    return 2\n  }",
    to: "  if (false && (targetInfo.dangling || targetInfo.outsideRepo)) {\n    process.stderr.write(`${targetInfo.error}\\n`)\n    return 2\n  }",
    expect: 'W6A C5：模板空骨架 <16KB',
  },
]
