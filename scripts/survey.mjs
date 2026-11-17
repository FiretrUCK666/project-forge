#!/usr/bin/env node
/**
 * survey.mjs —— 目标项目的只读勘察。
 *
 * 只做一件事：把「这个项目现在是什么样」变成结构化事实。它不判断该做什么，
 * 也不写任何文件——该做什么在 SKILL.md 的能力矩阵与 references/ 的判据里。
 *
 * 三条纪律决定它的形状：
 * 一、所有版本控制查询并发；
 * 二、忽略判定一次 `check-ignore --stdin -z` 问完；
 * 三、默认不联网、不弹窗（加 `--probe-auth` 后才走无交互双轨探测）。
 */

import { existsSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { claimsOf } from './lib/claims.mjs'
import { GAP_RULES } from './lib/survey-gap-rules.mjs'
import { computeNavigation, toMarkdown } from './lib/render.mjs'
import * as protocol from './lib/protocol.mjs'
import {
  classifyWorkspaceIdentity,
  detectGitModeMarkers,
  getHostingProvider,
  resolveWorkspaceIdentity,
} from './lib/platform/index.mjs'
import {
  detectArtifacts,
  detectEcosystem,
  detectTaskEntriesDetailed,
  detectUniversalCommands,
  detectWorkspace,
} from './lib/survey-ecosystem.mjs'
import {
  classifyHomePath,
  detectConventions,
  detectDocs,
  detectGit,
  finalizeWalkWorkspace,
  scanWorkspaceRaw,
} from './lib/survey-workspace.mjs'
import { detectTddShapes, tddDropSections } from '../kit/skills/lib/tdd-shape.mjs'
import {
  collectTopModuleDirs,
  detectKit,
  detectLocalSkills,
  detectStaleAgentScripts,
  detectTddStalePaths,
  isReentryProject,
} from './lib/survey-reentry.mjs'
import {
  computeExplorationStrategy,
  computeRecommendedTier,
} from './lib/survey-plan.mjs'
import {
  flushAndExit,
  githubRepoPath,
  isMainModule,
  readJsonSafe,
  readTextSafe,
  samePath,
} from './lib/text.mjs'

const AGENTS_MAX_BYTES = protocol.AGENTS_MAX_BYTES ?? 30720

function detectReentry(root, { docs, kit, ecosystem, commandsByEcosystem, workspace, ws, taskEntryMeta }) {
  const isReentry = isReentryProject(docs, kit)
  const agentsText = docs?.agents ? (readTextSafe(join(root, docs.agents.file)) ?? '') : ''
  const tddText = docs?.tdd ? (readTextSafe(join(root, docs.tdd)) ?? '') : ''

  let staleAgentPaths = []
  let staleAgentScripts = []
  let agentClaims
  if (agentsText) {
    agentClaims = claimsOf(agentsText)
    const combinedRefs = [...new Set([
      ...(agentClaims.paths ?? []),
      ...(agentClaims.dirs ?? []).map((d) => d.replace(/\/+$/, '')),
    ])].sort()
    staleAgentPaths = combinedRefs.filter((p) => !existsSync(join(root, p)))
    staleAgentScripts = detectStaleAgentScripts({
      agentsText,
      agentClaims,
      ecosystem,
      commandsByEcosystem,
      taskEntryMeta,
    })
  }

  const staleTddPaths = detectTddStalePaths(root, docs?.tdd)

  let unregisteredTopDirs = []
  if (docs?.agents && (docs.agentsMarkers?.fills?.length ?? 0) === 0 && (ws?.codeFiles ?? 0) > 0) {
    const combinedDocText = `${agentsText}\n${tddText}`
    for (const candidate of collectTopModuleDirs(root, workspace)) {
      const leaf = candidate.includes('/') ? candidate.split('/').pop() : candidate
      const leafPrefixRe = leaf
        ? new RegExp(`(?<![A-Za-z0-9_-])${leaf.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`)
        : undefined
      const mentioned = combinedDocText.includes(candidate)
        || (leafPrefixRe ? leafPrefixRe.test(combinedDocText) : false)
      if (!mentioned) unregisteredTopDirs.push(candidate)
    }
  }

  const drifted = Boolean(
    staleAgentPaths.length
    || staleAgentScripts.length
    || staleTddPaths.length
    || kit?.drifted
    || kit?.versionMismatch,
  )

  return {
    isReentry,
    staleAgentPaths,
    staleAgentScripts,
    staleTddPaths,
    unregisteredTopDirs,
    drifted,
  }
}

export function computeArtifactPlan(facts) {
  const maturity = facts?.maturity ?? 'partial'
  const scale = facts?.scale ?? {}
  const git = facts?.git ?? {}
  const ignores = facts?.ignores ?? {}
  const docs = facts?.docs ?? {}
  const ecosystem = facts?.ecosystem ?? {}
  const conventions = facts?.conventions ?? {}
  const commands = facts?.commands ?? {}
  const kit = facts?.kit ?? {}
  const reentry = facts?.reentry ?? {}
  const recommendedTier = facts?.recommendedTier ?? kit?.recommendedTier ?? 'lightweight'
  const isEmpty = maturity === 'empty' || ((scale.totalFiles ?? 0) === 0 && (git.commits ?? 0) === 0)
  const items = []

  // 1. 写前仓外快照
  items.push(isEmpty
    ? { id: 'pre-backup', artifact: '写前仓外 .zip 快照', status: '空目录（无需快照）', action: 'skip', detail: '空白目录无现有文件，直接初始化即可' }
    : { id: 'pre-backup', artifact: '写前仓外 .zip 快照', status: '待创建', action: 'snapshot', detail: '写任何治理文件前先执行 `node scripts/backup.mjs create <目录> --label pre-forge`' })

  // 2. Git 基线
  if (git.available === false) {
    items.push({ id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: '未找到 git 命令', action: 'skip', detail: '本机缺少 git 可执行程序，先安装后再初始化版本控制' })
  } else if (git.isBare === true) {
    items.push({ id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: '裸仓库（无工作区）', action: 'ask-human', detail: '先克隆出普通工作区，再执行治理与提交' })
  } else if (git.present === true && git.isRepoRoot === false) {
    items.push({ id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: '外层仓库子目录', action: 'ask-human', detail: '确认并入外层仓库还是单独建库，边界明确前不改动历史' })
  } else if (git.present !== true) {
    items.push({ id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: '未建版本库', action: 'create', detail: '按 version-control 判据先补齐 .gitattributes、.gitignore 再初始化仓库与首次提交' })
  } else {
    const missingIgnores = []
    if (!ignores.hasGitattributes) missingIgnores.push('.gitattributes')
    if (!ignores.hasGitignore) missingIgnores.push('.gitignore')
    if ((ignores.unignoredOutputDirs?.length ?? 0) > 0) missingIgnores.push('未忽略产物目录')
    if ((ignores.ignoredButTracked?.length ?? 0) > 0) missingIgnores.push('已入库忽略文件')
    items.push(missingIgnores.length > 0
      ? { id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: `待补齐（${missingIgnores.join('、')}）`, action: 'calibrate', detail: '保留既有提交历史与规则，仅追加缺失的换行/忽略条目或清理误跟踪产物' }
      : { id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: '已就绪', action: 'preserve', detail: '版本库、.gitattributes 与 .gitignore 均已到位，保持现状' })
  }

  // 3. 受管 .agents/skills/ 与自有扩展技能（支持 v2 墓碑/定制与两档渐进装配）
  const customSkills = kit.customSkills ?? []
  const customNote = customSkills.length > 0
    ? `；原样保留自有扩展技能（${customSkills.map((s) => s.path).join('、')}）`
    : ''
  const customizedNote = (kit.customizedFiles?.length ?? 0) > 0
    ? `（含 ${kit.customizedFiles.length} 个已豁免定制文件）`
    : ''
  if (!kit.manifestExists) {
    items.push({ id: 'kit-skills', artifact: '.agents/skills/', status: `未装配（推荐 ${recommendedTier} 档）`, action: 'equip', detail: `运行 equip.mjs --tier ${recommendedTier} 写入受管技能并生成 .pf-manifest.json（v2）${customNote}` })
  } else if (kit.corrupted || kit.drifted || kit.versionMismatch || (kit.missingFiles?.length ?? 0) > 0) {
    items.push({ id: 'kit-skills', artifact: '.agents/skills/', status: `已装配 ${kit.tier ?? 'full'} 档（需无损升级/修复）`, action: 'upgrade', detail: `运行 equip.mjs 三态升级：未改文件升新、用户定制与删除墓碑严格保留、退役文件自净化${customNote}` })
  } else {
    items.push({ id: 'kit-skills', artifact: '.agents/skills/', status: `已就绪（${kit.tier ?? 'full'} 档，${kit.managedSkills?.length ?? 0} 个受管技能${customizedNote}）`, action: 'preserve', detail: `与当前版本基线一致${customNote}` })
  }

  // 4. docs/TDD.md 与存量设计文档
  const isDocsOnly = (ecosystem.kinds ?? []).includes('docs-only')
  const existingDesign = docs.existingDesignDocs ?? []
  if (isDocsOnly && !docs.tdd && existingDesign.length === 0) {
    items.push({ id: 'docs-tdd', artifact: 'docs/TDD.md', status: '纯文档项目（按需跳过）', action: 'skip', detail: '纯文档目录无需技术设计文档' })
  } else if (!docs.tdd && existingDesign.length > 0) {
    items.push({
      id: 'docs-tdd',
      artifact: 'docs/TDD.md',
      status: `已有存量设计文档（${existingDesign.slice(0, 3).join('、')}）`,
      action: 'preserve',
      detail: `沿用现有设计文档（${existingDesign.slice(0, 3).join('、')}），可在 AGENTS.md「取舍」登记权威入口，避免双轨重复生成 docs/TDD.md`,
    })
  } else if (!docs.tdd && (isEmpty || (scale.codeFiles ?? 0) === 0)) {
    items.push({ id: 'docs-tdd', artifact: 'docs/TDD.md', status: '暂无源码（待起步后生成）', action: 'skip', detail: '先选技术栈生成最小源码或使用 --bootstrap-empty 一并落盘 docs/TDD.md' })
  } else if (!docs.tdd) {
    items.push({ id: 'docs-tdd', artifact: 'docs/TDD.md', status: '缺失', action: 'create', detail: '创建 docs/TDD.md 记录核心模块边界、arch-rules 与真实 Feature Map' })
  } else if ((reentry.staleTddPaths?.length ?? 0) > 0 || (reentry.unregisteredTopDirs?.length ?? 0) > 0) {
    items.push({ id: 'docs-tdd', artifact: 'docs/TDD.md', status: '存在失效路径或未登记模块', action: 'calibrate', detail: '保留原有设计决策正文，仅校准失效源码路径并增补新模块入口' })
  } else {
    items.push({ id: 'docs-tdd', artifact: 'docs/TDD.md', status: '已就绪', action: 'preserve', detail: '保留现有架构与模块边界说明' })
  }

  // 5. AGENTS.md
  const otherAi = docs.otherAiConventions ?? []
  const otherNote = otherAi.length > 0 ? `；先读取并吸收既有 AI 规则（${otherAi.join('、')}）` : ''
  if (!docs.agents && isEmpty) {
    items.push({ id: 'agents-contract', artifact: 'AGENTS.md', status: '空目录（待项目起步后生成）', action: 'skip', detail: '先完成空目录起步骨架与源码后，再运行 compose-agents.mjs 合成契约' })
  } else if (!docs.agents) {
    items.push({ id: 'agents-contract', artifact: 'AGENTS.md', status: `缺失（推荐 ${recommendedTier} 档）`, action: 'create', detail: `运行 compose-agents.mjs --tier ${recommendedTier} 生成受管区间并按真实事实填实空白位${otherNote}` })
  } else {
    const driftReasons = []
    if ((reentry.staleAgentPaths?.length ?? 0) > 0) driftReasons.push('失效路径')
    if ((reentry.staleAgentScripts?.length ?? 0) > 0) driftReasons.push('失效脚本')
    if ((docs.agentsBytes ?? 0) > AGENTS_MAX_BYTES) driftReasons.push('超过 30KB 上限')
    if ((docs.agentsMarkers?.fills?.length ?? 0) > 0) driftReasons.push('未填占位')
    if (otherAi.length > 0) driftReasons.push('待合流其他 AI 规则')
    items.push(driftReasons.length > 0
      ? { id: 'agents-contract', artifact: 'AGENTS.md', status: `待校准（${driftReasons.join('、')}）`, action: 'calibrate', detail: `保留手写规则与「取舍」区，定向修复失效条目或外置超长设计到 docs/TDD.md${otherNote}` }
      : { id: 'agents-contract', artifact: 'AGENTS.md', status: '已就绪', action: 'preserve', detail: '受管区间完整、无失效引用且处于体积预算内' })
  }

  // 6. README.md（保留此精确条文以供故障注入检测）
  items.push(docs.readme
    ? { id: 'readme', artifact: 'README.md', status: `已存在（${(docs.readmes ?? [docs.readme]).join('、')}）`, action: 'preserve', detail: '保留原有排版、文风与结构，严禁套模板重写，仅在命令或入口失真时做最小校准' }
    : { id: 'readme', artifact: 'README.md', status: '缺失', action: 'create', detail: '基于真实入口与探测到的命令编写初始 README.md（不编造运行环境要求与假徽章）' })

  // 7. CONTRIBUTING.md
  if (docs.contributing) {
    items.push({ id: 'contributing', artifact: 'CONTRIBUTING.md', status: `已存在（${docs.contributing}）`, action: 'preserve', detail: '保留既有贡献约定，不强改文风与结构' })
  } else if (git.role === 'maintainer' && Boolean(git.remote)) {
    items.push({ id: 'contributing', artifact: 'CONTRIBUTING.md', status: '缺失（可选）', action: 'optional', detail: '仅在计划接收外部贡献时新建；单人自用仓库可跳过' })
  } else {
    items.push({ id: 'contributing', artifact: 'CONTRIBUTING.md', status: '缺失', action: 'skip', detail: '非维护者或无远端仓库，无需补充贡献指南' })
  }

  // 8. LICENSE
  items.push(docs.license
    ? { id: 'license', artifact: 'LICENSE', status: `已存在（${docs.license}）`, action: 'preserve', detail: '保留既有授权文本（含双许可等自定义声明，绝不覆盖）' }
    : { id: 'license', artifact: 'LICENSE', status: ecosystem.publishable ? '缺失（可发布包需立即定夺）' : '缺失', action: 'ask-human', detail: '授权必须由人拍板：选定具体开源协议或明确不对外授权' })

  // 9. RELEASING.md 与发版说明
  const hasReleaseEvidence = Boolean(ecosystem.publishable || (git.tags?.length ?? 0) > 0 || docs.workflowFacts?.hasRelease)
  if (docs.releasing) {
    items.push({ id: 'releasing', artifact: 'RELEASING.md / 发版说明', status: `已存在（${docs.releasing}）`, action: 'preserve', detail: '保留现有发版流程与约定（目录或 CHANGELOG 模式），仅在命令失真时最小微调' })
  } else if (hasReleaseEvidence) {
    items.push({ id: 'releasing', artifact: 'RELEASING.md / 发版说明', status: '缺失', action: 'create', detail: '项目具备可发布形态、已有版本标签或发布工作流，按实测命令补充发版说明' })
  } else if (docs.changelog) {
    items.push({ id: 'releasing', artifact: 'RELEASING.md / 发版说明', status: `已存在（${docs.changelog}）`, action: 'preserve', detail: '保留既有变更日志，不强行改换结构' })
  } else {
    items.push({ id: 'releasing', artifact: 'RELEASING.md / 发版说明', status: '暂不需要', action: 'skip', detail: '非可发布包且无版本标签/发布工作流，跳过发版文档' })
  }

  // 10. CI 检查工作流（ci-check）
  const wf = docs.workflowFacts ?? {}
  const onGithub = git.providerId
    ? (git.providerId === 'github' || Boolean(git.topology?.providerIds?.includes('github')))
    : (typeof git.remote === 'string' && /github\.com/i.test(git.remote))
  if (wf.hasCheck) {
    items.push(wf.usesPullRequestTarget && wf.checkoutsPrHead
      ? { id: 'ci-check', artifact: '.github/workflows/check.yml', status: '已有检查流（含高危 pull_request_target）', action: 'calibrate', detail: '保留既有流水线结构，立即解除 pull_request_target 检出外部提案代码的高危组合' }
      : { id: 'ci-check', artifact: '.github/workflows/check.yml', status: `已存在（${(wf.checkWorkflows?.length ? wf.checkWorkflows : docs.workflows ?? []).join('、')}）`, action: 'preserve', detail: '保留现有 CI 检查工作流，仅在命令失真时最小校准' })
  } else if (git.role === 'contributor-fork') {
    items.push({ id: 'ci-check', artifact: '.github/workflows/check.yml', status: 'Fork 贡献者仓', action: 'skip', detail: 'Fork 贡献者不擅自改动或新增上游 CI 工作流' })
  } else if (Boolean(git.remote) && !onGithub) {
    items.push({ id: 'ci-check', artifact: '.github/workflows/check.yml', status: '通用 Git 远端（generic-git）', action: 'skip', detail: '远端非 GitHub，跳过 GitHub Actions 检查工作流，仅维持本地门禁验证' })
  } else if (Boolean(git.remote) && Object.keys(commands).length > 0) {
    items.push({ id: 'ci-check', artifact: '.github/workflows/check.yml', status: '缺失', action: 'create', detail: '有 GitHub 远端且已探测到可执行校验命令，补充最小检查工作流' })
  } else {
    items.push({ id: 'ci-check', artifact: '.github/workflows/check.yml', status: Boolean(git.remote) ? '缺失（暂无可运行命令）' : '无远端', action: 'skip', detail: '无远端或尚未探测到可运行校验命令，先补齐后按需接入' })
  }

  // 11. CI 发布工作流（ci-release，支持 5 选 1 发版策略）
  const releaseTooling = (conventions.workflowTooling ?? []).filter((t) => /changeset|release-please|releaserc|goreleaser/i.test(t))
  if (wf.hasRelease || releaseTooling.length > 0) {
    const wfNames = wf.releaseWorkflows?.length ? wf.releaseWorkflows : releaseTooling
    items.push({
      id: 'ci-release',
      artifact: '.github/workflows/release.yml',
      status: `已有发布自动化/工具（${wfNames.join('、')}）`,
      action: 'preserve',
      detail: '沿用既有发布工作流或工具链（strategy=2），并在 AGENTS.md 对齐其实际发版步骤',
    })
  } else if (git.role === 'contributor-fork') {
    items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: 'Fork 贡献者仓', action: 'skip', detail: 'Fork 贡献者不配置发布工作流' })
  } else if (Boolean(git.remote) && !onGithub) {
    items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: '通用 Git 远端（generic-git）', action: 'skip', detail: '远端非 GitHub，跳过 GitHub Release 发布流水线' })
  } else if (Boolean(git.remote) && hasReleaseEvidence) {
    items.push({
      id: 'ci-release',
      artifact: '.github/workflows/release.yml',
      status: '待选择发版策略（5 选 1）',
      action: 'ask-human',
      detail: '可选：1) 不配置 / 2) 沿用工具 / 3) 纯手动 / 4) Tag 自动发布页（默认用内置 GITHUB_TOKEN，零额外 Secret）/ 5) 联动下游或推送制品库（按需配 RELEASE_TOKEN 或 OIDC）',
    })
  } else {
    items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: '暂不需要', action: 'skip', detail: '非可发布项目或暂无远端，不配置发布工作流' })
  }

  return items
}

function judgeMaturity(facts) {
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

const QUESTION_RULES = [
  {
    id: 'q.license',
    when: (f) => !f.docs.license,
    text: '这个项目要不要公开授权？要的话选哪个许可证（MIT / Apache-2.0 / BSD-3-Clause）；不要就明确不放',
  },
  {
    id: 'q.npm',
    when: (f) => f.ecosystem.publishable === true && (f.ecosystem.kinds ?? []).includes('node'),
    text: '这个项目要不要发到 npm？不发就补上 `private: true` 防误发',
  },
  {
    id: 'q.unknown-ecosystem',
    when: (f) => (f.ecosystem.kinds ?? []).includes('unknown'),
    text: '认不出这是什么项目。它是什么形态（命令行工具 / 库 / 服务 / 文档 / 插件）？',
  },
  {
    id: 'q.role',
    when: (f) => f.git.present === true && typeof f.git.remote === 'string' && f.git.remote.length > 0
      && f.git.role === 'undetermined',
    text: '本地远端是不是这个项目的正本？项目里没有声明源仓库（清单的 repository 一类），'
      + '所以比不出来——说不清的话，按贡献者处置（拉分支、开 PR），不推主干、不打标签',
  },
  {
    id: 'q.remote-setup',
    when: (f) => f.git.available !== false && f.git.isBare !== true && f.git.isRepoRoot !== false
      && (f.git.remotes ?? []).length === 0 && !f.git.localMode && f.scale.effectiveFiles > 0,
    text: '当前还没有配置远端仓库：请选择 1) 暂不配远端（写入 `.git/pf-local-mode` 纯本地运作）；2) 绑定已有 GitHub 仓库；3) 新建 GitHub 仓库（默认 `private` 私有，或 `public` 公开，并确认个人/组织归属）',
  },
  {
    id: 'q.release-strategy',
    when: (f) => f.git.present === true
      && (f.git.remotes ?? []).length > 0
      && f.git.role !== 'contributor-fork'
      && f.docs.workflowFacts?.hasRelease !== true
      && (f.conventions?.workflowTooling ?? []).every((t) => !/changeset|release-please|releaserc|goreleaser/i.test(t))
      && (f.ecosystem.publishable === true || Boolean(f.docs.releasing) || (f.git.tags?.length ?? 0) > 0),
    // 发版手段按这个平台真的能做什么来说。
    //
    // 远端不是 GitHub 时还教 gh release create，等于让人照着敲一条必然 404 的命令，
    // 而文案本身不会报错——这是最坏的一种：错在文档里，执行的人以为是自己配错了。
    text: (f) => {
      const caps = f.git?.capabilities ?? null
      const canRelease = caps?.known === true && caps.releases === true
      if (!canRelease) {
        const who = caps?.providerId ?? "未知"
        return `项目具备发布形态且尚未配置发布流水线。这个远端（${who}）的发布能力`
          + "要么不支持、要么认不出来，所以这里不给本平台专用的命令：请先在它的托管界面上确认发版方式，再决定要不要接到流水线里"
      }
      return "项目具备发布形态且尚未配置发布流水线，请选择发版策略（5 选 1）：1) 不配置；2) 沿用已有工具；"
        + "3) 纯手动 `gh release create`；4) Tag 自动发布页（默认用内置 `GITHUB_TOKEN`，零额外 Secret）；"
        + "5) 联动下游或推送制品库（按需配 `RELEASE_TOKEN` 或 OIDC 可信发布）"
    },
  },
]

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

export const GAP_RULE_IDS = Object.freeze(GAP_RULES.map((r) => r.id))
export const QUESTION_RULE_IDS = Object.freeze(QUESTION_RULES.map((r) => r.id))

function judgeGaps(facts) {
  const gaps = []
  const questions = []
  const projectGaps = []

  for (const rule of GAP_RULES) {
    for (const item of expandRule(rule, facts)) {
      gaps.push(item)
      if (rule.machineLocal !== true) projectGaps.push(item)
    }
    if (rule.question !== undefined && rule.when(facts)) {
      questions.push({ id: `${rule.id}.question`, text: rule.question })
    }
  }
  for (const rule of QUESTION_RULES) {
    for (const item of expandRule(rule, facts)) questions.push(item)
  }

  return { gaps, questions, projectGaps }
}

/**
 * 这个远端到底能做什么。
 *
 * 三态，不是两态：`true` 能做、`false` 不能做、`null` 认不出来。
 * **`null` 不许被下游当成 `true`**——「看着像能」正是给出 GitHub 专用命令然后 404 的来源。
 *
 * 取值全部来自注册表里平台自己的声明（`PROVIDER.capabilities`），不在这里写死任何平台名；
 * 未注册的托管退化成 `generic-git` 的能力表（全 false），本地仓直接 `none`。
 */
function summarizeRemoteCapabilities(role, gitFacts) {
  const providerId = role?.providerId ?? gitFacts?.providerId ?? null
  if (!providerId) return { known: false, providerId: null, issues: null, pullRequests: null, releases: null, checks: null }
  if (providerId === 'none') {
    return { known: true, providerId, issues: false, pullRequests: false, releases: false, checks: false }
  }
  const provider = getHostingProvider(providerId)
  const caps = provider?.capabilities
  if (!caps) return { known: false, providerId, issues: null, pullRequests: null, releases: null, checks: null }
  return {
    known: true,
    providerId,
    issues: caps.issues === true,
    pullRequests: caps.pr === true,
    releases: caps.releases === true,
    // 「能不能读 CI 检查状态」在平台声明里没有单独位，只有 api 通不通。api 不通一律算不能。
    checks: caps.api === true && caps.pr === true,
  }
}

export async function survey(targetDir = process.cwd(), opts = {}) {
  const root = resolve(targetDir)
  if (!existsSync(root)) throw new Error(`目标目录不存在：${root}`)

  // 先派生 git 子进程，与本地磁盘扫描（文件树、生态、文档、套件）并发推进
  const gitPromise = detectGit(root, {
    probeAuth: opts.probeAuth === true,
    verifyToken: opts.verifyToken === true,
    sshHostMap: opts.sshHostMap,
    mcpAvailable: opts.mcpAvailable,
    offline: opts.offline,
    fastUnbornStatus: opts.fastUnbornStatus === true,
  })
  const rawWs = scanWorkspaceRaw(root)
  const relFiles = rawWs.files.map((f) => f.rel)
  const ecosystem = detectEcosystem(root, relFiles)
  const taskEntryMeta = detectTaskEntriesDetailed(root)
  const taskCommands = taskEntryMeta.commands
  const docs = detectDocs(root)
  const workspace = detectWorkspace(root)
  const kit = detectKit(root)
  const localSkills = detectLocalSkills(root)
  const artifacts = detectArtifacts(root, ecosystem)
  // CI 与 Makefile 里被真实执行过的命令**永远要读**，不是「只给认不出的项目兜底」。
  //
  // 早先这里是 `ecosystem.kinds.length === 0 ? detectUniversalCommands(root) : 空`。
  // 于是一个 `kinds: ['skill']` 的仓（本仓库就是）拿到的是 `commands = {}`——它有 CI、
  // CI 里写着十几条真实命令，但整条兜底被跳过了。结果是生成的 `AGENTS.md`
  // 「构建与验证」永远空着，而体检还会说它「已就绪」。
  //
  // 优先级不变：生态清单推断出来的更具体，覆盖 CI 兜底的那一份（反过来的话，
  // 一份 CI 里偶然出现的 `npm run lint` 会把 `npm test` 顶掉）。
  const universal = detectUniversalCommands(root)

  const gitFacts = await gitPromise
  const ws = await finalizeWalkWorkspace(root, rawWs, gitFacts)
  const conventions = detectConventions(root, { gitFacts, docs, ecosystem })

  const commands = { ...universal.commands, ...taskCommands, ...ecosystem.commands }
  const commandsByEcosystem = { ...ecosystem.commandsByEcosystem }
  if (Object.keys(taskCommands).length > 0) commandsByEcosystem.task = taskCommands
  if (Object.keys(universal.commands).length > 0) {
    commandsByEcosystem['ci-or-taskfile'] = universal.commands
  }
  const commandSources = { ...(universal.sources ?? {}), ...(ecosystem.commandSources ?? {}) }

  let kinds = ecosystem.kinds
  if (kinds.length === 0) {
    if (ws.codeFiles === 0 && ws.docFiles > 0 && docs.readme) kinds = ['docs-only']
    else if (ws.totalFiles === 0) kinds = ['empty']
    else kinds = ['unknown']
  }

  let role
  if (opts.probeAuth === true && opts.fetchApi !== false && gitFacts.present === true && gitFacts.remote && !opts.probeApi) {
    role = await resolveWorkspaceIdentity({
      cwd: root,
      gitFacts,
      declaredRepo: ecosystem.declaredRepo,
      probeEnvResult: gitFacts.auth?._probeResult,
      client: opts.client,
      localIdentity: opts.localIdentity,
      localMode: opts.localMode,
      forkMode: opts.forkMode,
      standaloneMode: opts.standaloneMode,
      sshHostMap: gitFacts._sshHostMap ?? opts.sshHostMap,
      fetchApi: true,
    })
  } else {
    role = judgeRole(gitFacts, ecosystem.declaredRepo, {
      cwd: root,
      probeApi: opts.probeApi,
      localIdentity: opts.localIdentity,
      localMode: opts.localMode,
      forkMode: opts.forkMode,
      standaloneMode: opts.standaloneMode,
      sshHostMap: gitFacts._sshHostMap ?? opts.sshHostMap,
    })
  }
  if (gitFacts.auth && '_probeResult' in gitFacts.auth) {
    delete gitFacts.auth._probeResult
  }

  const reentry = detectReentry(root, {
    docs,
    kit,
    ecosystem,
    commandsByEcosystem,
    workspace,
    ws,
    taskEntryMeta,
  })

  const gitIdentityOut = {
    ...gitFacts.identity,
    ...(role.collaborationScope ? { collaborationScope: role.collaborationScope } : {}),
    ...(role.teamProbeHint ? { teamProbeHint: role.teamProbeHint } : {}),
  }

  const facts = {
    target: { path: root, name: ecosystem.projectName, dirName: basename(root) },
    maturity: 'partial',
    recommendedTier: 'lightweight',
    recommendedTierReason: '',
    git: {
      available: gitFacts.available,
      present: gitFacts.present,
      isRepoRoot: gitFacts.isRepoRoot,
      isBare: gitFacts.isBare ?? false,
      isShallow: gitFacts.isShallow ?? false,
      nestedRepos: gitFacts.present === true ? (gitFacts.nestedRepos ?? ws.nestedRepos ?? []) : [],
      workTreeRoot: gitFacts.workTreeRoot,
      branch: gitFacts.branch,
      upstream: gitFacts.upstream,
      ahead: gitFacts.ahead ?? 0,
      behind: gitFacts.behind ?? 0,
      dirty: gitFacts.dirty ?? 0,
      remote: gitFacts.remote,
      remotes: gitFacts.remotes ?? [],
      remoteUrls: gitFacts.remoteUrls ?? {},
      remotePushUrls: gitFacts.remotePushUrls ?? {},
      remoteProtocol: gitFacts.remoteProtocol,
      providerId: role.providerId ?? gitFacts.providerId,
      ...(gitFacts.topology ? { topology: gitFacts.topology } : {}),
      ...(gitFacts.localMode ? { localMode: true } : {}),
      ...(gitFacts.forkMode ? { forkMode: true } : {}),
      ...(gitFacts.standaloneMode ? { standaloneMode: true } : {}),
      identity: gitIdentityOut,
      tags: gitFacts.tags ?? [],
      historyAuthors: gitFacts.historyAuthors ?? [],
      commits: gitFacts.commits,
      commitsState: gitFacts.commitsState ?? 'ok',
      trackedFiles: gitFacts.trackedFiles ?? 0,
      head: gitFacts.head,
      initDefaultBranch: gitFacts.initDefaultBranch,
      originHeadBranch: gitFacts.originHeadBranch,
      auth: gitFacts.auth,
      declaredRepo: ecosystem.declaredRepo,
      role: role.role,
      roleReason: role.reason,
      // 这个远端到底能做什么，如实报出来。
      //
      // 早先只报 `providerId` 一个字符串，而「能不能开 Issue / 发 Release / 读检查状态」
      // 全靠下游各自猜——于是不在 GitHub 上的托管仓上，产物计划照样给出 GitHub 专用命令，
      // 而执行它的人只会看到 404。
      //
      // 报 capabilities 而不是猜：能就是 true，不能就是 false，认不出来就是 null（未知），
      // **未知不许被当成能**——那正是「看着像配好了」的来源。
      capabilities: summarizeRemoteCapabilities(role, gitFacts),
      ...(role.collaborationScope ? { collaborationScope: role.collaborationScope } : {}),
      ...(role.teamProbeHint ? { teamProbeHint: role.teamProbeHint } : {}),
    },
    ecosystem: {
      kinds,
      manifests: ecosystem.manifests,
      packageManager: ecosystem.packageManager,
      packageScripts: ecosystem.packageScripts,
      publishable: ecosystem.publishable && !ecosystem.private,
      private: ecosystem.private,
      registryFree: ecosystem.registryFree,
      declaredVersion: ecosystem.declaredVersion,
      declaredRepo: ecosystem.declaredRepo,
      skillMeta: ecosystem.skillMeta,
      subdirs: ecosystem.subdirs,
    },
    commands,
    commandsByEcosystem,
    ...(universal.detectionEvidence?.length > 0 ? { detectionEvidence: universal.detectionEvidence } : {}),
    conventions,
    workspace,
    artifacts,
    localSkills,
    kit,
    docs,
    reentry,
    ignores: {
      hasGitignore: existsSync(join(root, '.gitignore')),
      hasGitattributes: existsSync(join(root, '.gitattributes')),
      unignoredOutputDirs: ws.unignoredOutputDirs,
      ignoredButTracked: ws.ignoredButTracked,
    },
    outputs: {
      heavyDirsPresent: [],
      knownOutputDirs: ws.unignoredOutputDirs,
    },
    risks: {
      secretFiles: ws.secretFiles,
      secretContent: ws.secretContent,
      homePathLeaks: ws.homePathLeaks,
      largeFiles: ws.largeFiles,
      scanCoverage: ws.scanCoverage,
    },
    scale: {
      totalFiles: ws.totalFiles,
      effectiveFiles: ws.effectiveFiles,
      codeFiles: ws.codeFiles,
      codeLines: ws.codeLines,
      docFiles: ws.docFiles,
    },
    gaps: [],
    questions: [],
  }
  facts.outputs.heavyDirsPresent = facts.artifacts.heavyDirsPresent

  const verdict = judgeGaps(facts)
  facts.gaps = verdict.gaps
  facts.questions = verdict.questions
  facts.projectGaps = verdict.projectGaps
  facts.projectGapsComputed = true
  facts.maturity = judgeMaturity(facts)

  const tierRec = computeRecommendedTier(facts, root)
  facts.recommendedTier = tierRec.recommendedTier
  facts.recommendedTierReason = tierRec.reason
  facts.kit.recommendedTier = tierRec.recommendedTier

  facts.explorationStrategy = computeExplorationStrategy(facts)
  facts.artifactPlan = computeArtifactPlan(facts)
  facts.navigation = computeNavigation(facts)

  // 文档形态：TDD 该有哪些章节，由这个仓自己有什么决定，不由模板定死。
  // 只看路径清单，不读文件内容——路径已经足够可靠，读内容会让勘察变慢且易误判。
  // finalize 之后 files 已经不是数组，路径清单要用扫完那一刻的原始结果。
  const shapePaths = (rawWs.files ?? []).map((f) => String(f.rel ?? f).replace(/\\/g, '/'))
  const tddShape = detectTddShapes({
    paths: shapePaths,
    kinds: facts.ecosystem?.kinds ?? [],
    runtimeRequirements: facts.artifacts?.runtimeRequirements ?? [],
    codeFiles: facts.scale?.codeFiles ?? 0,
  })
  facts.tddShape = {
    enabled: [...tddShape.enabled],
    reasons: tddShape.reasons,
    dropSections: [...tddDropSections(tddShape)],
    filePaths: shapePaths,
    topLevelDirs: [...new Set((rawWs.dirs ?? []).map((d) => String(d.rel ?? d).replace(/\\/g, '/').split('/')[0]).filter(Boolean))],
  }

  delete gitFacts._sshHostMap
  delete gitFacts._hasGit
  delete gitFacts._ignoredTracked
  delete gitFacts._statusIgnored
  return facts
}

/**
 * 角色决定「能做到哪一步」，通过双轴五态分类器与平台注册表得出：
 * `local-only` / `contributor-fork` / `clone-readonly` / `maintainer` / `undetermined`。
 */
export function judgeRole(gitFacts, declaredRepo, opts = {}) {
  const markers = opts.cwd ? detectGitModeMarkers(opts.cwd) : { localMode: false, forkMode: false, standaloneMode: false }
  const localMode = typeof opts.localMode === 'boolean' ? opts.localMode : markers.localMode
  const forkMode = typeof opts.forkMode === 'boolean' ? opts.forkMode : markers.forkMode
  const standaloneMode = typeof opts.standaloneMode === 'boolean' ? opts.standaloneMode : markers.standaloneMode
  return classifyWorkspaceIdentity({
    gitFacts,
    declaredRepo,
    probeApi: opts.probeApi,
    localIdentity: opts.localIdentity,
    localMode,
    forkMode,
    standaloneMode,
    sshHostMap: opts.sshHostMap,
  })
}

export {
  main as runCli,
  computeExplorationStrategy,
  computeRecommendedTier,
  classifyHomePath,
  readTextSafe,
  readJsonSafe,
  samePath,
  githubRepoPath,
}

async function main(argv) {
  let target = process.cwd()
  let format = 'json'
  let probeAuth = false
  let verifyToken = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/survey.mjs [目标目录] [选项]',
        '',
        '  --markdown      输出给人读的报告（默认输出 JSON）',
        '  --probe-auth    额外问一次凭据助手与 SSH/gh 状态（无远端亦可探测）',
        '  --verify-token  配合 --probe-auth 对本地 Token 发一次轻量验活请求',
        '',
        '只读：不写任何文件。',
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--markdown' || arg === '--md') format = 'markdown'
    else if (arg === '--json') format = 'json'
    else if (arg === '--probe-auth') probeAuth = true
    else if (arg === '--verify-token') { probeAuth = true; verifyToken = true }
    else if (!arg.startsWith('-')) target = arg
    else {
      process.stderr.write(`未知选项：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    const facts = await survey(target, { probeAuth, verifyToken })
    process.stdout.write(format === 'markdown'
      ? toMarkdown(facts)
      : `${JSON.stringify(facts, null, 2)}\n`)
    return 0
  } catch (err) {
    process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(2)
    })
}
