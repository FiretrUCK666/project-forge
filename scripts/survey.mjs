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

import { computeNavigation } from './lib/navigation.mjs'
import * as protocol from './lib/protocol.mjs'
import {
  computeS3NextStep,
  decisionValue,
  GAP_RULE_IDS,
  hasDecision,
  judgeGaps,
  judgeMaturity,
  QUESTION_RULE_IDS,
  summarizeNeedsHuman,
  textsOf,
} from './lib/survey-questions.mjs'
import {
  detectGitHooksState,
} from './lib/survey-docs.mjs'
import { readDecisionMap } from '../kit/skills/lib/profile.mjs'
import { detectOptionalNativeCheckers } from '../kit/skills/lib/profile-sniffer.mjs'
import { resolveDocRequirements } from '../kit/skills/lib/doc-requirements.mjs'
import { detectTddShapes, tddDropSections } from '../kit/skills/lib/tdd-shape.mjs'
import { CODE_EXT_RE } from '../kit/skills/lib/git-core.mjs'
import { isSymbolCandidatePath, summarizeSymbolCoverage } from '../kit/skills/lib/symbol-index.mjs'
import {
  classifyWorkspaceIdentity,
  detectGitModeMarkers,
  getHostingProvider,
  resolveWorkspaceIdentity,
} from './lib/platform/index.mjs'
import {
  classifyHomePath,
  detectConventions,
  detectGit,
  detectIgnoredGovernancePaths,
  finalizeWalkWorkspace,
} from './lib/survey-workspace.mjs'
import { detectReentry, scanProjectStaticFacts } from './lib/survey-scan.mjs'
import { computeExplorationStrategy } from './lib/survey-plan.mjs'
import {
  flushAndExit,
  githubRepoPath,
  isMainModule,
  readJsonSafe,
  readTextSafe,
  samePath,
} from './lib/text.mjs'

const { AGENTS_MAX_BYTES } = protocol

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
    if ((ignores.ignoredGovernancePaths?.length ?? 0) > 0) missingIgnores.push('治理路径被 .gitignore 遮蔽')
    // 「版本库在」与「有历史」是两件事：只 init 没提交的目录，文件全在 `??` 里、
    // `git log` 报错，而只看「.git 在不在」就会写「已就绪」——用户拿到的是一句空话。
    const noCommits = Number(git.commits ?? 0) === 0
    if (noCommits && missingIgnores.length === 0) {
      items.push({
        id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore',
        status: '尚未首次提交（版本库存在但零提交）', action: 'create',
        detail: '跑 git add -A && git commit -m "chore: 初始化项目基线" 落首次提交；起步流程自己创建的仓库会自动完成这一步',
      })
    } else {
      items.push(missingIgnores.length > 0
        ? { id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: `待补齐（${missingIgnores.join('、')}）`, action: 'calibrate', detail: '保留既有提交历史与规则，仅追加缺失的换行/忽略条目或清理误跟踪产物' }
        : { id: 'git-baseline', artifact: '.git / .gitattributes / .gitignore', status: '已就绪', action: 'preserve', detail: '版本库、.gitattributes 与 .gitignore 均已到位，保持现状' })
    }
  }

  // 3. 受管 .agents/skills/ 与自有扩展技能（统一全量装配 + v2 墓碑/定制保护）
  const customSkills = kit.customSkills ?? []
  const customNote = customSkills.length > 0
    ? `；原样保留自有扩展技能（${customSkills.map((s) => s.path).join('、')}）`
    : ''
  const customizedNote = (kit.customizedFiles?.length ?? 0) > 0
    ? `（含 ${kit.customizedFiles.length} 个已豁免定制文件）`
    : ''
  if (!kit.manifestExists && hasDecision(facts, 'no-kit')) {
    items.push({ id: 'kit-skills', artifact: '.agents/skills/', status: '已在取舍中豁免（no-kit）', action: 'skip', detail: 'AGENTS.md「取舍」已明确不装配本地技能套件' })
  } else if (!kit.manifestExists) {
    items.push({ id: 'kit-skills', artifact: '.agents/skills/', status: '未装配', action: 'equip', detail: `运行 equip.mjs 统一装配全部已落盘研发技能并生成 .pf-manifest.json（v3）${customNote}` })
  } else if (kit.corrupted || kit.drifted || kit.versionMismatch || (kit.missingFiles?.length ?? 0) > 0) {
    items.push({ id: 'kit-skills', artifact: '.agents/skills/', status: '已装配（需无损升级/修复）', action: 'upgrade', detail: `运行 equip.mjs 三态升级：未改文件升新、用户定制与删除墓碑严格保留、退役文件自净化${customNote}` })
  } else {
    items.push({ id: 'kit-skills', artifact: '.agents/skills/', status: `已就绪（${kit.managedSkills?.length ?? 0} 个受管技能${customizedNote}）`, action: 'preserve', detail: `与当前版本基线一致${customNote}` })
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
  } else if (!docs.tdd && hasDecision(facts, 'no-tdd')) {
    items.push({ id: 'docs-tdd', artifact: 'docs/TDD.md', status: '已在取舍中豁免（no-tdd）', action: 'skip', detail: 'AGENTS.md「取舍」已明确不单独建 docs/TDD.md' })
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
    items.push({ id: 'agents-contract', artifact: 'AGENTS.md', status: '缺失', action: 'create', detail: `运行 compose-agents.mjs 生成紧凑受管契约并按真实事实填实空白位${otherNote}` })
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
  } else if (hasDecision(facts, 'no-contributing')) {
    items.push({ id: 'contributing', artifact: 'CONTRIBUTING.md', status: '已在取舍中豁免（no-contributing）', action: 'skip', detail: 'AGENTS.md「取舍」已明确跳过贡献指南' })
  } else if (git.role === 'maintainer' && Boolean(git.remote)) {
    items.push({ id: 'contributing', artifact: 'CONTRIBUTING.md', status: '缺失（可选）', action: 'optional', detail: '仅在计划接收外部贡献时新建；单人自用仓库可跳过' })
  } else {
    items.push({ id: 'contributing', artifact: 'CONTRIBUTING.md', status: '缺失', action: 'skip', detail: '非维护者或无远端仓库，无需补充贡献指南' })
  }

  // 8. LICENSE
  if (docs.license) {
    items.push({ id: 'license', artifact: 'LICENSE', status: `已存在（${docs.license}）`, action: 'preserve', detail: '保留既有授权文本（含双许可等自定义声明，绝不覆盖）' })
  } else if (hasDecision(facts, 'license')) {
    const licChoice = String(decisionValue(facts, 'license') ?? '').trim()
    const skipLicense = /^(?:暂不|暂未|不放|不公开|不对外|私有|不授权|保留版权|proprietary|无|none|skip|n\/a|不适用)/i.test(licChoice)
    items.push(skipLicense
      ? { id: 'license', artifact: 'LICENSE', status: `已在取舍中定为不公开授权（${licChoice}）`, action: 'skip', detail: 'AGENTS.md「取舍」已明确暂不对外授权，跳过 LICENSE 生成' }
      : { id: 'license', artifact: 'LICENSE', status: `已在取舍中选定（${licChoice}）`, action: 'create', detail: `按 AGENTS.md「取舍」选定的 ${licChoice} 协议补齐 LICENSE 文件` })
  } else {
    items.push({ id: 'license', artifact: 'LICENSE', status: ecosystem.publishable ? '缺失（可发布包需立即定夺）' : '缺失', action: 'ask-human', detail: '授权必须由人拍板：选定具体开源协议或明确不对外授权' })
  }

  // 9. RELEASING.md 与发版说明
  const hasReleaseEvidence = Boolean(ecosystem.publishable || (git.tags?.length ?? 0) > 0 || docs.workflowFacts?.hasRelease)
  if (docs.releasing) {
    items.push({ id: 'releasing', artifact: 'RELEASING.md / 发版说明', status: `已存在（${docs.releasing}）`, action: 'preserve', detail: '保留现有发版流程与约定（目录或 CHANGELOG 模式），仅在命令失真时最小微调' })
  } else if (hasDecision(facts, 'no-release-spec')) {
    items.push({ id: 'releasing', artifact: 'RELEASING.md / 发版说明', status: '已在取舍中豁免（no-release-spec）', action: 'skip', detail: 'AGENTS.md「取舍」已明确不建发版文档' })
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
    items.push((wf.unsafePullRequestTargetWorkflows?.length ?? 0) > 0 || (wf.usesPullRequestTarget && wf.checkoutsPrHead)
      ? { id: 'ci-check', artifact: '.github/workflows/check.yml', status: '已有检查流（含高危 pull_request_target）', action: 'calibrate', detail: '保留既有流水线结构，立即解除 pull_request_target 检出外部提案代码的高危组合' }
      : { id: 'ci-check', artifact: '.github/workflows/check.yml', status: `已存在（${(wf.checkWorkflows?.length ? wf.checkWorkflows : docs.workflows ?? []).join('、')}）`, action: 'preserve', detail: '保留现有 CI 检查工作流，仅在命令失真时最小校准' })
  } else if (hasDecision(facts, 'no-ci')) {
    items.push({ id: 'ci-check', artifact: '.github/workflows/check.yml', status: '已在取舍中豁免（no-ci）', action: 'skip', detail: 'AGENTS.md「取舍」已明确不配置 CI 检查工作流' })
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
  const canReleasePlatform = git.capabilities ? (git.capabilities.known === true && git.capabilities.releases === true) : onGithub
  if (wf.hasRelease || releaseTooling.length > 0) {
    const wfNames = wf.releaseWorkflows?.length ? wf.releaseWorkflows : releaseTooling
    items.push({
      id: 'ci-release',
      artifact: '.github/workflows/release.yml',
      status: `已有发布自动化/工具（${wfNames.join('、')}）`,
      action: 'preserve',
      detail: '沿用既有发布工作流或工具链（strategy=2），并在 AGENTS.md 对齐其实际发版步骤',
    })
  } else if (hasDecision(facts, 'no-auto-release') || hasDecision(facts, 'no-release')) {
    items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: '已在取舍中豁免自动发版', action: 'skip', detail: 'AGENTS.md「取舍」已明确不启用自动发布工作流' })
  } else if (hasDecision(facts, 'release-strategy')) {
    const rsChoice = String(decisionValue(facts, 'release-strategy') ?? '').trim()
    const manualOrSkip = /^(?:1\b|2\b|3\b|不配置|沿用|纯手动|手动|none|manual|skip|不适用)/i.test(rsChoice)
    if (manualOrSkip || !onGithub || !canReleasePlatform) {
      items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: `已在取舍中定为 ${rsChoice}`, action: 'skip', detail: '按 AGENTS.md「取舍」跳过 GitHub Actions 自动发布流生成' })
    } else {
      items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: `已在取舍中选定（${rsChoice}）`, action: 'create', detail: '按 AGENTS.md「取舍」选定的发版策略生成 .github/workflows/release.yml' })
    }
  } else if (git.role === 'contributor-fork') {
    items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: 'Fork 贡献者仓', action: 'skip', detail: 'Fork 贡献者不配置发布工作流' })
  } else if (Boolean(git.remote) && (!onGithub || !canReleasePlatform)) {
    items.push({ id: 'ci-release', artifact: '.github/workflows/release.yml', status: '通用 Git 远端（generic-git）', action: 'skip', detail: '远端非 GitHub 或不支持 Release API，跳过 GitHub Release 发布流水线' })
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

  // 12. 默认分支保护（开关 A）
  if (hasDecision(facts, 'no-branch-protection') || hasDecision(facts, 'no-ci')) {
    items.push({ id: 'branch-protection', artifact: '默认分支保护（开关 A）', status: '已在取舍中豁免', action: 'skip', detail: 'AGENTS.md「取舍」已明确豁免或禁用 CI/分支保护' })
  } else if (git.role === 'contributor-fork' || !git.remote) {
    items.push({ id: 'branch-protection', artifact: '默认分支保护（开关 A）', status: !git.remote ? '无远端' : 'Fork 贡献者仓', action: 'skip', detail: '无远端或 Fork 贡献者仓不配置上游默认分支保护' })
  } else if (hasDecision(facts, 'branch-protection') && git.capabilities?.branchProtection === true) {
    items.push({ id: 'branch-protection', artifact: '默认分支保护（开关 A）', status: '待应用开关 A', action: 'create', detail: '运行 equip-ci.mjs --protect-branch 应用开关 A（禁直推/强推/删分支、不强制审批；403 时降级 --with-hooks）' })
  } else {
    const canProtectApi = git.capabilities?.branchProtection === true
    items.push({
      id: 'branch-protection',
      artifact: '默认分支保护（开关 A）',
      status: hasDecision(facts, 'branch-protection') ? '已在取舍确认（托管端手工/本地护栏）' : '可选（开关 A 待确认）',
      action: 'optional',
      detail: canProtectApi
        ? '运行 equip-ci.mjs --protect-branch 配置开关 A（严禁设置 required_approving_review_count >= 1），或在取舍写 no-branch-protection'
        : '当前远端不支持统一分支保护 API：在托管界面按开关 A 原则启用，并配合 equip.mjs --with-hooks',
    })
  }

  // 13. 跨宿主本地 Git Hook（.githooks/pre-push，opt-in 且冲突时严格 preserve）
  const hooksState = git.hooks ?? {}
  if (hasDecision(facts, 'no-git-hooks')) {
    items.push({ id: 'git-hooks', artifact: '.githooks/pre-push', status: '已在取舍中豁免（no-git-hooks）', action: 'skip', detail: 'AGENTS.md「取舍」已明确跳过本地 Git Hook' })
  } else if (hooksState.installed) {
    items.push({ id: 'git-hooks', artifact: '.githooks/pre-push', status: '已就绪（core.hooksPath=.githooks）', action: 'preserve', detail: '跨宿主 pre-push 防直推护栏已配置，保持现状' })
  } else if (hooksState.hasConflict) {
    const conflictDesc = (hooksState.conflicts ?? []).map((c) => c.path).filter(Boolean).join('、')
    items.push({ id: 'git-hooks', artifact: '.githooks/pre-push', status: `检测到既有 Hook（${conflictDesc}）`, action: 'preserve', detail: '严格 preserve 共存，不覆写既有钩子与 core.hooksPath；请确认已有钩子包含默认分支保护' })
  } else if (git.available === false || git.isBare === true || git.isRepoRoot === false) {
    items.push({ id: 'git-hooks', artifact: '.githooks/pre-push', status: '当前目录不适用', action: 'skip', detail: '仅在可用普通仓库根目录启用本地 Git Hook' })
  } else {
    items.push({ id: 'git-hooks', artifact: '.githooks/pre-push', status: '未配置（opt-in，S3 自动推荐）', action: 'optional', detail: '运行 equip.mjs --with-hooks 写入 .githooks/pre-push（+x）并配局部 core.hooksPath' })
  }

  // 14 & 15. 功能地图（docs/feature-map.json）与离线交互式架构图（docs/architecture-map.html）
  const isEmptyCodeRepo = facts.maturity === 'empty' || (facts.scale?.codeFiles ?? 0) === 0
  if (isEmptyCodeRepo || isDocsOnly) {
    items.push({
      id: 'feature-map',
      artifact: 'docs/feature-map.json',
      status: isDocsOnly ? '纯文档项目' : '空白/零源码目录',
      action: 'skip',
      detail: '零源码或纯文档目录不预先生成 docs/feature-map.json，待首次业务代码落地后再同步',
    })
    items.push({
      id: 'architecture-map',
      artifact: 'docs/architecture-map.html',
      status: isDocsOnly ? '纯文档项目' : '空白/零源码目录',
      action: 'skip',
      detail: '零源码或纯文档目录不预先生成 docs/architecture-map.html',
    })
  } else {
    if (docs.featureMap) {
      items.push({ id: 'feature-map', artifact: 'docs/feature-map.json', status: `已有（${docs.featureMap}）`, action: 'preserve', detail: '已有功能地图，后续随研发验证增量校准' })
    } else {
      items.push({ id: 'feature-map', artifact: 'docs/feature-map.json', status: '尚未生成', action: 'create', detail: '运行 verify-tools.mjs sync 从仓库入口与模块结构索引生成 docs/feature-map.json' })
    }
    if (hasDecision(facts, 'no-architecture-html')) {
      items.push({ id: 'architecture-map', artifact: 'docs/architecture-map.html', status: '已在取舍中豁免（no-architecture-html）', action: 'skip', detail: 'AGENTS.md「取舍」已声明不生成离线架构图 HTML' })
    } else if (docs.architectureMap && docs.architectureMapSync?.ok) {
      items.push({ id: 'architecture-map', artifact: 'docs/architecture-map.html', status: '已有且与 feature-map 同步', action: 'preserve', detail: '保留既有离线交互式架构图，后续变更由 verify-tools render / flow finalize 自动刷新' })
    } else if (docs.architectureMap && docs.architectureMapSync && !docs.architectureMapSync.ok) {
      items.push({ id: 'architecture-map', artifact: 'docs/architecture-map.html', status: `与 feature-map 存在漂移（${docs.architectureMapSync.reason || 'drift'}）`, action: 'calibrate', detail: '运行 verify-tools.mjs render 重新渲染同步 docs/architecture-map.html' })
    } else {
      items.push({ id: 'architecture-map', artifact: 'docs/architecture-map.html', status: '尚未生成', action: 'create', detail: '运行 verify-tools.mjs render 生成离线单文件交互式 docs/architecture-map.html' })
    }
  }

  return items
}

export { GAP_RULE_IDS, QUESTION_RULE_IDS, textsOf }

/**
 * 这个仓库算不算「纯文档项目」。
 *
 * 判据是「文档不止一份说明文件」，不是「有说明文件」。说明文件是每个仓库的标配：
 * 只有 README 的目录，既可能是刚起步马上要写代码，也可能是长期只放说明，
 * 两种处置正相反，而这一条判据在两者上给出同一个结论，等于没判。
 *
 * 多一份非说明文档（TDD、设计笔记、规范……）才算「这是个文档项目」的证据。
 * 不用提交数阈值：那是会被时间推移改变结论的魔数，「几次算少」也没有事实依据。
 */
function isDocsOnlyByDocuments(ws, docs) {
  if (!(ws.docFiles > 0) || !docs.readme) return false
  // 说明文件的变体（README.zh-CN.md、README.rst……）与 README 本体算同一份，
  // 拿它凑「不止一份」等于把双语主页当成文档项目。
  const readmeVariants = new Set(docs.readmes ?? [docs.readme])
  return ws.docFiles > readmeVariants.size
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
export function summarizeRemoteCapabilities(role, gitFacts) {
  const providerId = role?.providerId ?? gitFacts?.providerId ?? null
  if (!providerId) return { known: false, providerId: null, issues: null, pullRequests: null, releases: null, checks: null, branchProtection: null }
  if (providerId === 'none') {
    return { known: true, providerId, issues: false, pullRequests: false, releases: false, checks: false, branchProtection: false }
  }
  const provider = getHostingProvider(providerId)
  const caps = provider?.capabilities
  if (!caps) return { known: false, providerId, issues: null, pullRequests: null, releases: null, checks: null, branchProtection: null }
  return {
    known: true,
    providerId,
    issues: caps.issues === true,
    pullRequests: caps.pr === true,
    releases: caps.releases === true,
    // 「能不能读 CI 检查状态」在平台声明里没有单独位，只有 api 通不通。api 不通一律算不能。
    checks: caps.api === true && caps.pr === true,
    branchProtection: caps.branchProtection === true,
  }
}

export async function survey(targetDir = process.cwd(), opts = {}) {
  const root = resolve(targetDir)
  if (!existsSync(root)) throw new Error(`目标目录不存在：${root}`)

  // 先派生 git 子进程，再启动工作区异步读盘与纯内存生态计算，使 git 子进程、libuv 线程池与主线程同步分析三路并行
  const gitPromise = detectGit(root, {
    probeAuth: opts.probeAuth === true,
    verifyToken: opts.verifyToken === true,
    sshHostMap: opts.sshHostMap,
    mcpAvailable: opts.mcpAvailable,
    offline: opts.offline,
    fastUnbornStatus: opts.fastUnbornStatus === true,
  })
  const staticPromise = scanProjectStaticFacts(root)
  const [gitFacts, staticFacts] = await Promise.all([gitPromise, staticPromise])
  const {
    rawWs, relFiles, relSet, dirSet, ecosystem, taskEntryMeta, taskCommands, docs, docGraph, workspace,
    kit, localSkills, artifacts, universal, agentsText, tddText,
  } = staticFacts
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
    // 纯文档项目的判据是「文档不止一份说明文件」，不是「有说明文件」。
    // 说明文件是每个仓库的标配，它单独存在不构成「这是一个文档项目」的证据：
    // 一个刚起步、马上就要写代码的目录，与一个长期只放说明文件的目录，
    // 在「只有 README」这一条上完全没有区别，而两者的处置正相反。
    // 不用提交数阈值——那是个会被时间推移改变结论的魔数，且「几次算少」没有事实依据。
    if (ws.codeFiles === 0 && isDocsOnlyByDocuments(ws, docs)) kinds = ['docs-only']
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
    agentsText,
    tddText,
    relSet,
    dirSet,
    relFiles,
  })

  const gitIdentityOut = {
    ...gitFacts.identity,
    ...(role.collaborationScope ? { collaborationScope: role.collaborationScope } : {}),
    ...(role.teamProbeHint ? { teamProbeHint: role.teamProbeHint } : {}),
  }

  const decisions = Object.fromEntries(readDecisionMap(agentsText))

  const facts = {
    target: { path: root, name: ecosystem.projectName, dirName: basename(root) },
    maturity: 'partial',
    decisions,
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
      hooks: gitFacts.isBare !== true
        ? detectGitHooksState(root, { coreHooksPath: gitFacts.hooksPath ?? null, hooksPathScope: gitFacts.hooksPathScope })
        : { installed: false, hasConflict: false, conflicts: [] },
      auth: gitFacts.auth,
      declaredRepo: ecosystem.declaredRepo,
      role: role.role,
      roleReason: role.reason,
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
      ...(ecosystem.versionSource ? { versionSource: ecosystem.versionSource } : {}),
      ...(ecosystem.exports !== undefined ? { exports: ecosystem.exports } : {}),
      declaredRepo: ecosystem.declaredRepo,
      skillMeta: ecosystem.skillMeta,
      subdirs: ecosystem.subdirs,
    },
    commands,
    commandsByEcosystem,
    commandSources,
    ...(universal.detectionEvidence?.length > 0 ? { detectionEvidence: universal.detectionEvidence } : {}),
    conventions,
    workspace,
    artifacts: { ...artifacts, nativeCheckers: detectOptionalNativeCheckers(root) },
    localSkills,
    kit,
    docs,
    docGraph,
    reentry,
    ignores: {
      hasGitignore: relSet ? relSet.has('.gitignore') : existsSync(join(root, '.gitignore')),
      hasGitattributes: relSet ? relSet.has('.gitattributes') : existsSync(join(root, '.gitattributes')),
      unignoredOutputDirs: ws.unignoredOutputDirs,
      ignoredButTracked: ws.ignoredButTracked,
      ignoredGovernancePaths: (gitFacts.present === true && gitFacts.isRepoRoot !== false)
        ? detectIgnoredGovernancePaths(root)
        : [],
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

  facts.explorationStrategy = computeExplorationStrategy(facts)
  facts.artifactPlan = computeArtifactPlan(facts)
  facts.needsHuman = summarizeNeedsHuman(facts)
  facts.navigation = computeNavigation(facts)
  facts.nextStep = computeS3NextStep(facts)

  Object.assign(facts, summarizeTddAndSymbolCoverage(root, rawWs, facts))

  delete gitFacts._sshHostMap
  delete gitFacts._hasGit
  delete gitFacts._ignoredTracked
  delete gitFacts._statusIgnored
  return facts
}

function summarizeTddAndSymbolCoverage(root, rawWs, facts) {
  const shapePaths = (rawWs.files ?? []).map((f) => String(f.rel ?? f).replace(/\\/g, '/'))
  const tddShape = detectTddShapes({
    paths: shapePaths,
    kinds: facts.ecosystem?.kinds ?? [],
    runtimeRequirements: facts.artifacts?.runtimeRequirements ?? [],
    codeFiles: facts.scale?.codeFiles ?? 0,
  })
  const tddReq = resolveDocRequirements(root, 'tdd')
  const tddReqIds = new Set(tddReq.sections.map((s) => s.id))
  const tddShapeSummary = {
    enabled: [...tddShape.enabled],
    reasons: tddShape.reasons,
    dropSections: [...tddDropSections(tddShape, { omit: tddReq.omit, required: tddReqIds })],
    filePaths: shapePaths,
    topLevelDirs: [...new Set((rawWs.dirs ?? []).map((d) => String(d.rel ?? d).replace(/\\/g, '/').split('/')[0]).filter(Boolean))],
  }
  const symbolCoverage = summarizeSymbolCoverage(
    (rawWs.files ?? [])
      .map((f) => String(f.rel ?? f).replace(/\\/g, '/'))
      .filter((rel) => !protocol.isToolOwnedPath(rel)
        && (CODE_EXT_RE.test(rel) || isSymbolCandidatePath(rel))),
  )
  return { tddShape: tddShapeSummary, symbolCoverage }
}

/** 角色决定「能做到哪一步」：`local-only` / `contributor-fork` / `clone-readonly` / `maintainer` / `undetermined`。 */
function judgeRole(gitFacts, declaredRepo, opts = {}) {
  const markers = opts.cwd ? detectGitModeMarkers(opts.cwd) : { localMode: false, forkMode: false, standaloneMode: false }
  return classifyWorkspaceIdentity({
    gitFacts,
    declaredRepo,
    probeApi: opts.probeApi,
    localIdentity: opts.localIdentity,
    localMode: typeof opts.localMode === 'boolean' ? opts.localMode : markers.localMode,
    forkMode: typeof opts.forkMode === 'boolean' ? opts.forkMode : markers.forkMode,
    standaloneMode: typeof opts.standaloneMode === 'boolean' ? opts.standaloneMode : markers.standaloneMode,
    sshHostMap: opts.sshHostMap,
  })
}

async function runSurveyCli(argv, surveyFn) {
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
    const facts = await surveyFn(target, { probeAuth, verifyToken })
    const out = format === 'markdown'
      ? (await import('./lib/render.mjs')).toMarkdown(facts)
      : `${JSON.stringify(facts, null, 2)}\n`
    process.stdout.write(out)
    return 0
  } catch (err) {
    process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

const main = (argv) => runSurveyCli(argv, survey)

export {
  judgeRole,
  main as runCli,
  computeExplorationStrategy,
  classifyHomePath,
  readTextSafe,
  readJsonSafe,
  samePath,
  githubRepoPath,
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(2)
    })
}
