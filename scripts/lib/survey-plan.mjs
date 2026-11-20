/**
 * survey-plan.mjs —— 探索策略分片判定（按真实通读成本决定 single-pass / parallel-subagents）。
 */

/**
 * 探索策略：按**真实通读成本**分档，不是按文件数。
 *
 * ## 为什么不能只数文件
 *
 * 文件数不衡量通读成本。实测的完整矩阵：
 *
 * | 真实规模 | codeFiles | 旧判据给的 tier |
 * | --- | --- | --- |
 * | 500 行 | 10 | single-pass（合理） |
 * | 2 000 行 | 40 | single-pass（合理） |
 * | 30 000 行 | 10 | **single-pass（不合理）** |
 * | 28 000 行 | 40 | **single-pass（不合理）** |
 *
 * `28 000 行(single-pass)` 比 `4 050 行(parallel-subagents)` 大 7 倍，却拿到更低的档——
 * 「随规模单调不降」被直接违反。真实后果是一个 28 189 行、30 个核心模块、双平台同构的
 * 项目被判成「小型单仓结构清晰，单 Agent 通读即可」，于是主 Agent 只来得及 grep 几个
 * 常量，最外层那几个上千行的状态机根本没读。
 *
 * ## 判据：任一维越线就升档
 *
 * 文件数、代码行数、模块数（顶层用户量最大的目录数）、语言数，各自有阈值；
 * 任何一维越线就升到 `parallel-subagents`。不取加权平均——一维极大时平均值会把它拉平，
 * 而通读成本是被最大那一维决定的。
 *
 * 阈值都给名字，不写裸数字：改阈值时知道自己在改什么。
 */
const EXPLORATION_THRESHOLDS = Object.freeze({
  /** 超过这个文件数，逐个读完已经超出一次会话的合理额度。 */
  codeFiles: 80,
  /** 超过这个行数，即使文件很少也读不完（单文件几千行的状态机是真实存在的）。 */
  codeLines: 4000,
  /** 模块目录多到一定程度，彼此边界本身就要花时间理清。 */
  modules: 8,
  /** 多语言并存时每门语言都有自己的构建与约定，成本按语言数放大。 */
  languages: 2,
})

export function computeExplorationStrategy(facts) {
  const maturity = facts?.maturity
  if (maturity === 'empty') {
    return {
      tier: 'none',
      reason: '空目录先问 3-4 个起步问题，不派深挖探索',
      shards: [],
      evidence: { codeFiles: 0, codeLines: 0, modules: 0, languages: 0 },
    }
  }

  const codeFiles = facts?.scale?.codeFiles ?? 0
  const codeLines = facts?.scale?.codeLines ?? 0
  const workspaceDeclared = Boolean(facts?.workspace?.declared)
  const subdirCount = facts?.ecosystem?.subdirs?.length ?? 0
  const kindCount = facts?.ecosystem?.kinds?.length ?? 0
  const reentry = facts?.reentry ?? {}
  const otherConventionsCount = facts?.docs?.otherAiConventions?.length ?? 0
  const moduleCount = (reentry.unregisteredTopDirs ?? []).length
    || (facts?.ecosystem?.subdirs ?? []).length
    || Math.min(codeFiles, 1)

  const evidence = { codeFiles, codeLines, modules: moduleCount, languages: kindCount }

  // 任一维越线即视为「读不完」。四个判断各自独立，不看别人。
  const oversize = []
  const oversizeDims = []
  if (codeFiles > EXPLORATION_THRESHOLDS.codeFiles) { oversize.push(`代码文件 ${codeFiles} 个`); oversizeDims.push('代码文件数') }
  if (codeLines > EXPLORATION_THRESHOLDS.codeLines) { oversize.push(`代码 ${codeLines} 行`); oversizeDims.push('代码行数') }
  if (moduleCount > EXPLORATION_THRESHOLDS.modules) { oversize.push(`模块目录 ${moduleCount} 个`); oversizeDims.push('模块目录数') }
  if (kindCount > EXPLORATION_THRESHOLDS.languages) { oversize.push(`语言/生态 ${kindCount} 种`); oversizeDims.push('语言/生态种类数') }

  const isPolyglotOrMonorepo = workspaceDeclared || subdirCount > 1 || kindCount > 1

  // ## 这一段要写进 `AGENTS.md` 自己的受管区，所以它的输入**不能来自 `AGENTS.md`**
  //
  // `reentry.drifted` 与 `reentry.staleAgentPaths` 都是从契约正文里读出来的：契约里多一行
  // 提到某个已删文件，它们就变。拿它们算策略的后果是自指——写进契约的内容取决于契约正文，
  // 于是每次生成都可能改一次自己，`--check` 在「一致」与「漂移」之间来回跳，永远收敛不了。
  // 实测形状：`retro --apply-patches` 往契约里追加一条建议规则，`--check` 立刻报漂移。
  //
  // 所以这里只认**磁盘上的事实**：技术设计文档里的失效路径（那是 `docs/TDD.md`，不是本文件）、
  // 套件漂移、磁盘上的其它 AI 约定文件、磁盘上的自有技能。契约自身的问题由 `review` 报。
  const tddDrift = (reentry.staleTddPaths ?? []).length > 0
  const kitDrift = Boolean(facts?.kit?.drifted || facts?.kit?.versionMismatch)
  const isReentryComplex = Boolean(
    reentry.isReentry
    && (tddDrift || kitDrift || otherConventionsCount > 0 || (reentry.unregisteredTopDirs?.length ?? 0) > 0),
  )

  if (oversize.length === 0 && !isPolyglotOrMonorepo && !isReentryComplex) {
    return {
      tier: 'single-pass',
      reason: `小型单仓结构清晰（${codeFiles} 文件 / ${codeLines} 行），单 Agent 通读即可`,
      shards: [],
      evidence,
      oversizeDims: [],
      multiPackage: false,
      reentryComplex: false,
    }
  }

  const reasons = [...oversize]
  if (isPolyglotOrMonorepo) reasons.push('存在多包或多生态/子目录布局')
  if (isReentryComplex) reasons.push('重入存在契约漂移、未登记模块或既有 AI 约定')

  const archTargets = [...new Set([
    ...(reentry.unregisteredTopDirs ?? []),
    ...(reentry.staleTddPaths ?? []),
    ...(facts?.workspace?.packages ?? []).slice(0, 6),
    ...(facts?.ecosystem?.subdirs ?? []).map((s) => `${s.dir}/`),
  ])].slice(0, 8)
  if (archTargets.length === 0) archTargets.push('.')

  const verifyTargets = [...new Set([
    ...(facts?.ecosystem?.manifests ?? []),
    ...(facts?.docs?.workflows ?? []).map((w) => `.github/workflows/${w}`),
    ...(reentry.staleAgentScripts ?? []),
  ])].slice(0, 8)
  if (verifyTargets.length === 0) verifyTargets.push('README.md')

  const shards = [
    {
      id: 'architecture-boundaries',
      scope: '模块边界、顶层目录与可复用基础设施',
      focus: '梳理核心入口、单向依赖、可复用模块及高风险/禁改目录边界',
      targets: archTargets,
    },
    {
      id: 'verification-runtime',
      scope: '构建、测试、冒烟验证与发布命令',
      focus: '核实清单脚本、CI 运行链、真实 smoke-verify 与过时命令声明',
      targets: verifyTargets,
    },
  ]

  const customSkills = facts?.kit?.customSkills ?? []
  if (customSkills.length > 0 || otherConventionsCount > 0 || tddDrift || kitDrift || (reentry.unregisteredTopDirs?.length ?? 0) > 0) {
    // 这一段会被写进 `AGENTS.md` 自己的受管区。所以它**不能把 `AGENTS.md` 列成目标**：
    // 第一次渲染时这个文件还不存在，渲染完它才出现，第二次就多出一项——
    // 于是「生成一次契约」本身把仓从「一致」推成「漂移」，`--check` 每次必红。
    // 判据的输入不得包含判据自己的产物，这条对契约正文同样成立。
    const selfFile = facts?.docs?.agents?.file
    const convTargets = [...new Set([
      ...(facts?.docs?.tdd ? [facts.docs.tdd] : []),
      ...(facts?.docs?.otherAiConventions ?? []),
      ...customSkills.map((s) => `${s.path}/SKILL.md`),
      ...(reentry.staleTddPaths ?? []),
    ].filter((p) => p && p !== selfFile))].slice(0, 8)
    if (convTargets.length === 0) convTargets.push('契约自身（AGENTS.md）')
    shards.push({
      id: 'conventions-and-skills',
      scope: '既有 AI 约定、自有扩展技能与重入失步校准',
      focus: '盘点必须保留的自有技能与人工规则，定位失效路径/脚本以定向校准',
      targets: convTargets,
    })
  }

  if (isPolyglotOrMonorepo) {
    const pkgTargets = [...new Set([
      ...(facts?.workspace?.packages ?? []),
      ...(facts?.ecosystem?.subdirs ?? []).map((s) => `${s.dir}/`),
      ...(facts?.ecosystem?.manifests ?? []),
    ])].slice(0, 8)
    if (pkgTargets.length === 0) pkgTargets.push('.')
    shards.push({
      id: 'polyglot-or-packages',
      scope: '多包与多语言子目录边界',
      focus: '确认各子包或子目录独立测试/构建命令、入口文件与跨包隔离约束',
      targets: pkgTargets,
    })
  }

  if (codeFiles > 0 || (facts?.ecosystem?.manifests?.length ?? 0) > 0) {
    const flowTargets = [...new Set([
      ...(facts?.docs?.readme ? [facts.docs.readme] : []),
      ...(facts?.docs?.tdd ? [facts.docs.tdd] : []),
      ...(facts?.docs?.existingDesignDocs ?? []).slice(0, 2),
      ...(facts?.ecosystem?.manifests ?? []).slice(0, 3),
      ...(facts?.ecosystem?.subdirs ?? []).map((s) => `${s.dir}/`).slice(0, 3),
    ])].slice(0, 8)
    if (flowTargets.length === 0) flowTargets.push('.')
    shards.push({
      id: 'business-flows',
      scope: '核心业务流、服务入口与文档源码差异',
      focus: '梳理服务对象、核心路由/CLI/UI/作业面，核对文档宣称与源码真实实现差异并产出改前基线',
      targets: flowTargets,
    })
  }

  return {
    tier: 'parallel-subagents',
    reason: reasons.join('；'),
    shards,
    evidence,
    // 越线的是哪几维。比 `reason` 更适合被程序比对：`reason` 里带具体数值，
    // 而数值每次改代码都会变；维度只在真的跨线时变。
    oversizeDims,
    multiPackage: isPolyglotOrMonorepo,
    reentryComplex: isReentryComplex,
  }
}
