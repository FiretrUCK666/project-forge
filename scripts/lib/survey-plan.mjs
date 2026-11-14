/**
 * survey-plan.mjs —— 探索策略分片与两档渐进装配（lightweight / full）推荐判定。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 依据仓库规模、多包布局与团队协作信号，推荐装配档位（`lightweight` | `full`）。
 * 存量个人小仓、纯文档与空白起步推荐 `lightweight` 降低侵入；大型、多包或团队协作仓推荐 `full`。
 */
export function computeRecommendedTier(facts, root) {
  const kit = facts?.kit ?? {}
  if (kit.tier === 'full') {
    return {
      recommendedTier: 'full',
      reason: '当前项目已装配 full 全量档位',
    }
  }

  const codeFiles = facts?.scale?.codeFiles ?? 0
  const effectiveFiles = facts?.scale?.effectiveFiles ?? 0
  const workspaceDeclared = Boolean(facts?.workspace?.declared)
  const subdirCount = facts?.ecosystem?.subdirs?.length ?? 0
  const multiAuthor = (facts?.git?.historyAuthors?.length ?? 0) > 1
  const teamScope = facts?.git?.collaborationScope === 'team-collaborator'
  const hasCollabDocs = Boolean(
    facts?.docs?.contributing
    || facts?.docs?.prTemplate
    || facts?.docs?.issueTemplates
    || (root && (existsSync(join(root, '.github', 'CODEOWNERS')) || existsSync(join(root, 'CODEOWNERS')))),
  )
  const hasFullDocsLayers = Boolean(facts?.docs?.specsDir && facts?.docs?.todoDir && facts?.docs?.prdDir)

  const reasons = []
  if (codeFiles > 80 || effectiveFiles > 120) reasons.push(`项目规模较大（代码 ${codeFiles} 个 / 有效文件 ${effectiveFiles} 个）`)
  if (workspaceDeclared || subdirCount > 1) reasons.push('存在多包或前后端分离布局')
  if (teamScope || multiAuthor || hasCollabDocs) reasons.push('检测到多人协同或团队 PR 治理信号')
  if (hasFullDocsLayers) reasons.push('已建立完整四层工程文档目录')

  if (reasons.length > 0) {
    return {
      recommendedTier: 'full',
      reason: `${reasons.join('、')}，推荐 full 档位（5 套内置研发技能 + 完整协作/审校契约）`,
    }
  }

  return {
    recommendedTier: 'lightweight',
    reason: '个人或中小规模仓，推荐 lightweight 轻量档位（紧凑 AGENTS.md + 核心 explore/plan/flow 三技能；后续可随时 --tier full 无损升档）',
  }
}

export function computeExplorationStrategy(facts) {
  const maturity = facts?.maturity
  if (maturity === 'empty') {
    return {
      tier: 'none',
      reason: '空目录先问 3-4 个起步问题，不派深挖探索',
      shards: [],
    }
  }

  const codeFiles = facts?.scale?.codeFiles ?? 0
  const workspaceDeclared = Boolean(facts?.workspace?.declared)
  const subdirCount = facts?.ecosystem?.subdirs?.length ?? 0
  const kindCount = facts?.ecosystem?.kinds?.length ?? 0
  const reentry = facts?.reentry ?? {}
  const otherConventionsCount = facts?.docs?.otherAiConventions?.length ?? 0

  const isLarge = codeFiles > 80
  const isPolyglotOrMonorepo = workspaceDeclared || subdirCount > 1 || kindCount > 1
  const isReentryComplex = Boolean(
    reentry.isReentry
    && (reentry.drifted || (reentry.unregisteredTopDirs?.length ?? 0) > 0 || otherConventionsCount > 0),
  )

  if (!isLarge && !isPolyglotOrMonorepo && !isReentryComplex) {
    return {
      tier: 'single-pass',
      reason: '小型单仓结构清晰，单 Agent 通读即可',
      shards: [],
    }
  }

  const reasons = []
  if (isLarge) reasons.push(`代码文件 ${codeFiles} 个`)
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
  if (customSkills.length > 0 || otherConventionsCount > 0 || reentry.drifted || (reentry.unregisteredTopDirs?.length ?? 0) > 0) {
    const convTargets = [...new Set([
      ...(facts?.docs?.agents ? [facts.docs.agents.file] : []),
      ...(facts?.docs?.tdd ? [facts.docs.tdd] : []),
      ...(facts?.docs?.otherAiConventions ?? []),
      ...customSkills.map((s) => `${s.path}/SKILL.md`),
      ...(reentry.staleAgentPaths ?? []),
    ])].slice(0, 8)
    if (convTargets.length === 0) convTargets.push('AGENTS.md')
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

  return {
    tier: 'parallel-subagents',
    reason: reasons.join('；'),
    shards,
  }
}
