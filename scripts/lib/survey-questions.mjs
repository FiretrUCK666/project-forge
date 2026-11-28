/**
 * survey-questions.mjs —— 勘察问答规则、成熟度判定、取舍读取与 NEED_HUMAN 摘要。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 scripts/survey.mjs 调用。
 */

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { GAP_RULES } from './survey-gap-rules.mjs'
import { readDecisionMap } from '../../kit/skills/lib/profile.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS_DIR = resolve(HERE, '..').replace(/\\/g, '/')

function quoteCliArg(value) {
  const s = String(value ?? '')
  return /\s/.test(s) ? `"${s}"` : s
}

function resolveEngineScript(fileName) {
  return quoteCliArg(`${SCRIPTS_DIR}/${fileName}`)
}

function getDecisionsMap(facts) {
  const raw = facts?.decisions
  if (raw instanceof Map) return raw
  if (raw && typeof raw === 'object') return new Map(Object.entries(raw))
  if (typeof facts?.docs?.agentsText === 'string') return readDecisionMap(facts.docs.agentsText)
  return new Map()
}

export function hasDecision(facts, key) {
  if (!key) return false
  return getDecisionsMap(facts).has(String(key).toLowerCase())
}

export function decisionValue(facts, key) {
  if (!key) return undefined
  return getDecisionsMap(facts).get(String(key).toLowerCase())
}

export function textsOf(items) {
  return (items ?? []).map((one) => (typeof one === 'string' ? one : one.text))
}

function expandRule(rule, facts) {
  if (typeof rule.each === 'function') {
    if (!rule.when(facts)) return []
    return rule.each(facts).map((one) => ({ id: rule.id, text: one.text }))
  }
  if (!rule.when(facts)) return []
  const text = typeof rule.text === 'function' ? rule.text(facts) : rule.text
  return [{ id: rule.id, text }]
}

export const QUESTION_RULES = [
  {
    id: 'q.license',
    when: (f) => !f.docs.license && !hasDecision(f, 'license'),
    text: '这个项目要不要公开授权？要的话选哪个许可证（MIT / Apache-2.0 / BSD-3-Clause）；不要就明确不放',
  },
  {
    id: 'q.npm',
    when: (f) => f.ecosystem.publishable === true
      && (f.ecosystem.kinds ?? []).includes('node')
      && !hasDecision(f, 'npm')
      && !hasDecision(f, 'no-npm'),
    text: '这个项目要不要发到 npm？不发就补上 `private: true` 防误发',
  },
  {
    id: 'q.unknown-ecosystem',
    when: (f) => (f.ecosystem.kinds ?? []).includes('unknown') && !hasDecision(f, 'project-kind'),
    text: '认不出这是什么项目。它是什么形态（命令行工具 / 库 / 服务 / 文档 / 插件）？',
  },
  {
    id: 'q.git-identity',
    when: (f) => f.git.present === true
      && f.git.isBare !== true
      && (!f.git.identity?.name || !f.git.identity?.email)
      && !hasDecision(f, 'git-identity'),
    text: (f) => {
      const missing = [
        !f.git.identity?.name ? '`user.name`' : null,
        !f.git.identity?.email ? '`user.email`' : null,
      ].filter(Boolean).join(' 与 ')
      return `当前 Git 提交署名缺少 ${missing}，后续提交会被 Git 拒绝或归属不清；`
        + '请确认要使用的提交姓名与邮箱并配置 `git config user.name` / `user.email`，'
        + '或在 AGENTS.md「## 取舍」写 `git-identity` 说明暂缓原因'
    },
  },
  {
    id: 'q.role',
    when: (f) => f.git.present === true
      && typeof f.git.remote === 'string'
      && f.git.remote.length > 0
      && f.git.role === 'undetermined'
      && !hasDecision(f, 'role'),
    text: '本地远端是不是这个项目的正本？项目里没有声明源仓库（清单的 repository 一类），'
      + '所以比不出来——说不清的话，按贡献者处置（拉分支、开 PR），不推主干、不打标签',
  },
  {
    id: 'q.remote-setup',
    when: (f) => f.git.available !== false
      && f.git.isBare !== true
      && f.git.isRepoRoot !== false
      && (f.git.remotes ?? []).length === 0
      && !f.git.localMode
      && f.scale.effectiveFiles > 0
      && !hasDecision(f, 'remote-setup'),
    text: '当前还没有配置远端仓库，请选择 1) 暂不配远端（已自动按 `local-only` 纯本地运作，无需写 `.git/pf-local-mode`，可在 `AGENTS.md`「## 取舍」写 `remote-setup: local-only`）；'
      + '2) 绑定已有远端（支持 SSH `git remote add origin git@<host>:<owner>/<repo>.git` 与 HTTP(S) `git remote add origin https://<host>/<owner>/<repo>.git`，勿把令牌写进 URL）；'
      + '3) 新建远端仓库（GitHub 默认 `private` 私有或按需 `public`，确认个人/组织归属，如 `gh repo create <owner>/<name> --private --source=. --push`）',
  },
  {
    id: 'q.branch-protection',
    when: (f) => f.git.present === true
      && f.git.isBare !== true
      && f.git.isRepoRoot !== false
      && (f.git.remotes ?? []).length > 0
      && f.git.role !== 'contributor-fork'
      && !hasDecision(f, 'no-ci')
      && !hasDecision(f, 'branch-protection')
      && !hasDecision(f, 'no-branch-protection'),
    text: (f) => {
      const branch = f.conventions?.defaultBranch || f.git?.originHeadBranch || f.git?.initDefaultBranch || 'main'
      if (f.git?.capabilities?.branchProtection === true) {
        return `尚未在 AGENTS.md「## 取舍」记录默认分支（\`${branch}\`）的分支保护决策。`
          + '建议开启**开关 A**（禁直推、禁强推、禁删默认分支、要求 PR 与状态检查通过，**严禁默认设置 `required_approving_review_count >= 1`**）：'
          + `运行 \`node scripts/equip-ci.mjs . --protect-branch --branch ${branch}\`（HTTP 403/权限受限将自动提示降级至 \`node scripts/equip.mjs . --with-hooks\`），`
          + '并在 AGENTS.md「## 取舍」写入 `branch-protection`（或 `no-branch-protection` 豁免）以防重问'
      }
      return `当前远端不支持统一 API 自动配置分支保护（默认分支 \`${branch}\`）：`
        + '请在托管仓库设置中为默认分支手工开启**开关 A** 原则（禁直推/强推/删默认分支、要求变更提案与状态检查通过，且不要强制他人审批），'
        + '并可运行 `node scripts/equip.mjs . --with-hooks` 安装本地 `.githooks/pre-push` 防直推护栏；'
        + '完成后在 AGENTS.md「## 取舍」写入 `branch-protection`（或 `no-branch-protection`）以防重问'
    },
  },
  {
    id: 'q.release-strategy',
    when: (f) => f.git.present === true
      && (f.git.remotes ?? []).length > 0
      && f.git.role !== 'contributor-fork'
      && f.docs.workflowFacts?.hasRelease !== true
      && (f.conventions?.workflowTooling ?? []).every((t) => !/changeset|release-please|releaserc|goreleaser/i.test(t))
      && (f.ecosystem.publishable === true || Boolean(f.docs.releasing) || (f.git.tags?.length ?? 0) > 0)
      && !hasDecision(f, 'no-auto-release')
      && !hasDecision(f, 'no-release')
      && !hasDecision(f, 'release-strategy'),
    text: (f) => {
      const caps = f.git?.capabilities ?? null
      const canRelease = caps?.known === true && caps.releases === true
      if (!canRelease) {
        const who = caps?.providerId ?? '未知'
        return `项目具备发布形态且尚未配置发布流水线。这个远端（${who}）的发布能力`
          + '要么不支持、要么认不出来，所以这里不给本平台专用的命令：请先在它的托管界面上确认发版方式，再决定要不要接到流水线里'
      }
      return '项目具备发布形态且尚未配置发布流水线，请选择发版策略（5 选 1）：1) 不配置；2) 沿用已有工具；'
        + '3) 纯手动 `gh release create`；4) Tag 自动发布页（默认用内置 `GITHUB_TOKEN`，零额外 Secret）；'
        + '5) 联动下游或推送制品库（按需配 `RELEASE_TOKEN` 或 OIDC 可信发布）'
    },
  },
]

export const GAP_RULE_IDS = Object.freeze(GAP_RULES.map((r) => r.id))
export const QUESTION_RULE_IDS = Object.freeze(QUESTION_RULES.map((r) => r.id))

export function judgeMaturity(facts) {
  if (facts.scale.effectiveFiles === 0 && facts.scale.totalFiles === 0) return 'empty'
  if (facts.scale.effectiveFiles === 0 && (facts.git.commits ?? 0) === 0) return 'empty'

  const hasGit = facts.git.present === true && facts.git.isRepoRoot !== false
  const hasDocs = Boolean(facts.docs.agents || facts.docs.readme)
  if (!hasGit || !hasDocs) return 'greenfield'

  const projectGaps = facts.projectGaps ?? []
  const hasRemote = typeof facts.git.remote === 'string' && facts.git.remote.length > 0
  if (hasRemote && facts.projectGapsComputed
    && facts.docs.workflowFacts.hasCheck && facts.ignores.hasGitattributes
    && projectGaps.length === 0) return 'mature'
  return 'partial'
}

export function judgeGaps(facts) {
  const gaps = []
  const questions = []
  const projectGaps = []

  for (const rule of GAP_RULES) {
    for (const item of expandRule(rule, facts)) {
      gaps.push(item)
      if (rule.machineLocal !== true) projectGaps.push(item)
    }
    const qDecisionKey = rule.id === 'git.nested-repos' ? 'nested-repo' : (rule.decision ?? rule.id)
    if (rule.question !== undefined && rule.when(facts) && !hasDecision(facts, qDecisionKey)) {
      questions.push({ id: `${rule.id}.question`, text: rule.question })
    }
  }
  for (const rule of QUESTION_RULES) {
    for (const item of expandRule(rule, facts)) questions.push(item)
  }

  return { gaps, questions, projectGaps }
}

/** 汇总需人工拍板的机器可读摘要（questions 与 artifactPlan ask-human 合流）。 */
export function summarizeNeedsHuman(facts) {
  const qIds = (facts?.questions ?? []).map((q) => q.id).filter(Boolean)
  const askIds = (facts?.artifactPlan ?? []).filter((a) => a?.action === 'ask-human').map((a) => a.id).filter(Boolean)
  const kinds = [...new Set([...qIds, ...askIds])]
  const count = (facts?.questions?.length ?? 0) > 0 ? facts.questions.length : askIds.length
  return count > 0
    ? { required: true, count, kinds, marker: 'NEEDS_HUMAN' }
    : { required: false, count: 0, kinds: [] }
}

/**
 * 计算 S2/S3 推荐下一步命令行与是否自动附带 `--with-hooks`。
 *
 * 规则：
 * 1. 当 `needsHuman.count > 0` 时严格遵守 S2 停步门禁，只输出询问用户拍板的 `[NEXT STEP]`，绝不提前放出 `equip.mjs`；
 * 2. 当 `needsHuman.count === 0` 时基于本 skill 绝对 `scripts/` 路径输出：非空仓先 `backup.mjs create --label pre-forge` 再 `equip.mjs`（无冲突且未写 `no-git-hooks` 时自动附带 `--with-hooks`）。
 */
export function computeS3NextStep(facts) {
  const git = facts?.git ?? {}
  const hooks = git.hooks ?? {}
  const targetPath = facts?.target?.path || '.'
  const isEmpty = facts?.maturity === 'empty'
    || ((facts?.scale?.totalFiles ?? 0) === 0 && (git.commits ?? 0) === 0)

  const hooksDisabled = hasDecision(facts, 'no-git-hooks')
  const hooksConflict = Boolean(hooks.hasConflict || (hooks.conflicts?.length ?? 0) > 0)
  const hooksInstalled = Boolean(hooks.installed)
  const gitUsable = git.available !== false && git.isBare !== true && git.isRepoRoot !== false
  const withHooks = Boolean(gitUsable && !hooksDisabled && !hooksConflict && !hooksInstalled)

  let hookReason = '无本地 Hook 冲突且未配置 `no-git-hooks`，已自动附带 `--with-hooks`'
  if (!gitUsable) hookReason = '当前目录非可用普通仓库根目录，跳过 `--with-hooks`'
  else if (hooksDisabled) hookReason = 'AGENTS.md「## 取舍」已写 `no-git-hooks`，已跳过 `--with-hooks`'
  else if (hooksConflict) {
    const paths = (hooks.conflicts ?? []).map((c) => c.path).filter(Boolean).join('、')
    hookReason = `检测到既有 Hook（${paths || '外部钩子配置'}），按 preserve 原则保留现有配置，不附带 \`--with-hooks\``
  } else if (hooksInstalled) {
    hookReason = '本地 `.githooks/pre-push` 已由 project-forge 配置就位'
  }

  const needsHuman = facts?.needsHuman ?? summarizeNeedsHuman(facts)
  if ((needsHuman?.count ?? 0) > 0) {
    const pendingKinds = (needsHuman.kinds ?? []).join('、') || 'NEEDS_HUMAN'
    return {
      stage: 'S2',
      blockedByNeedsHuman: true,
      needsHumanCount: needsHuman.count,
      needsHumanKinds: needsHuman.kinds ?? [],
      withHooks,
      hooksConflict,
      hooksDisabled,
      hooksInstalled,
      reason: `当前存在 ${needsHuman.count} 项需人工拍板事项（NEEDS_HUMAN > 0），按 S2 停步门禁暂停 S3 写入；待用户确认后继续（Hook 预判：${hookReason}）`,
      text: `[NEXT STEP] 先向用户询问并确认上方 ${needsHuman.count} 项待拍板问题（${pendingKinds}），获得明确决定前严禁执行任何 S3 写入或装配命令。`,
    }
  }

  const quotedTarget = quoteCliArg(targetPath)
  const backupCommand = isEmpty
    ? undefined
    : `node ${resolveEngineScript('backup.mjs')} create ${quotedTarget} --label pre-forge`
  const equipCommand = isEmpty
    ? `node ${resolveEngineScript('equip.mjs')} ${quotedTarget} --bootstrap-empty${withHooks ? ' --with-hooks' : ''}`
    : `node ${resolveEngineScript('equip.mjs')} ${quotedTarget}${withHooks ? ' --with-hooks' : ''}`

  const canProtectApi = Boolean(
    git.present === true
    && !git.localMode
    && (git.remotes ?? []).length > 0
    && git.role !== 'contributor-fork'
    && git.capabilities?.branchProtection === true
    && !hasDecision(facts, 'no-ci')
    && !hasDecision(facts, 'no-branch-protection'),
  )
  const defaultBranch = facts?.conventions?.defaultBranch || git.originHeadBranch || git.initDefaultBranch || 'main'
  const protectBranchCommand = canProtectApi
    ? `node ${resolveEngineScript('equip-ci.mjs')} ${quotedTarget} --protect-branch --branch ${defaultBranch}`
    : undefined

  const commandChain = [backupCommand, equipCommand, protectBranchCommand].filter(Boolean).join(' && ')

  return {
    stage: 'S3',
    blockedByNeedsHuman: false,
    withHooks,
    hooksConflict,
    hooksDisabled,
    hooksInstalled,
    ...(backupCommand ? { backupCommand } : {}),
    equipCommand,
    ...(protectBranchCommand ? { protectBranchCommand } : {}),
    reason: hookReason,
    text: `[NEXT STEP] ${commandChain}`,
  }
}
