/**
 * doc-shape.mjs —— 基于真实工作区证据探测规划文档（PRD / SPEC / Todo）形态开关、
 * 合并模板声明、生成可读跳过说明与校验跳过合法性。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），零硬编码仓库名。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { COMMON_SKIP_DIRS, gitLsFilesTextAndCode, posixPath, readTextSafe } from './git.mjs'
import { parseAgentsProfile } from './profile.mjs'
import { FORM_INDEPENDENT_CORE, resolveDocRequirements } from './doc-requirements.mjs'
import { isToolOwnedPath } from './tool-owned.mjs'

export const DOC_SHAPE_SIGNALS = Object.freeze([
  'authRoles',
  'stateRules',
  'uiFrontend',
  'ciRollout',
  'cliEntry',
  'multiCollab',
])

const NOT_PROJECT_DIRS_RE = /^(?:node_modules|dist|build|target|vendor|__pycache__|\.git|\.worktrees|coverage|out)\//i
const CODE_OR_MANIFEST_RE = /(?:\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|kt|cs|rb|php|swift|dart|ex|exs|c|cpp|h|hpp)$|(?:^|\/)(?:package\.json|go\.mod|Cargo\.toml|pyproject\.toml|pom\.xml|build\.gradle(?:\.kts)?|Gemfile|composer\.json|mix\.exs|pubspec\.yaml|Package\.swift)$)/i

const SECTION_TAGS = Object.freeze({
  users: 'users(roles)',
})

const SECTION_LABELS = Object.freeze({
  users: '用户身份与权限',
  flow: '关键业务流程',
  rules: '状态与业务规则',
  reuse: '复用既有模块',
  nfr: '非功能要求',
  pending: '待拍板问题',
  rollout: '上线与兼容策略',
  metrics: '成功度量',
  door: '门型与回滚路径',
  dependencies: '依赖与前置条件',
  risks: '风险与开放问题',
  design: '设计方案与契约变更',
  alternatives: '备选方案与否决理由',
  breakdown: '改动清单与影响面',
  implementation: '实现说明',
  steps: '执行步骤',
  risk: '风险与应对',
  rollback: '回滚预案',
  coordination: '协作与依赖',
  breakpoint: '断点与遗留决策',
  clarifications: '澄清与补充记录',
})

const OPTIONAL_ORDER_BY_KIND = Object.freeze({
  prd: ['users', 'flow', 'rules', 'reuse', 'nfr', 'pending', 'rollout', 'metrics', 'door', 'dependencies', 'risks', 'clarifications'],
  spec: ['design', 'alternatives', 'breakdown', 'door', 'rollout', 'clarifications', 'implementation'],
  todo: ['steps', 'risk', 'rollback', 'coordination', 'breakpoint', 'clarifications'],
})

function walkPathsSync(repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) return []
  const out = []
  const queue = [repoRoot]
  while (queue.length > 0 && out.length < 20000) {
    const cur = queue.shift()
    let entries = []
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue
      const full = join(cur, ent.name)
      const rel = posixPath(full.slice(repoRoot.length).replace(/^[\\/]+/, ''))
      if (!rel || isToolOwnedPath(rel)) continue
      if (ent.isDirectory()) {
        if (COMMON_SKIP_DIRS.has(ent.name) || ent.name === '.git' || ent.name === '.worktrees') continue
        queue.push(full)
      } else if (ent.isFile()) {
        out.push(rel)
      }
    }
  }
  return out
}

function readPkgDepsText(repoRoot, nonDocPaths) {
  const manifestRels = nonDocPaths.filter((p) => /(?:^|\/)(?:package\.json|go\.mod|Cargo\.toml|pyproject\.toml|Gemfile|composer\.json)$/i.test(p)).slice(0, 6)
  let buf = ''
  for (const rel of manifestRels) {
    const txt = readTextSafe(join(repoRoot, rel))
    if (txt) buf += `\n${txt}`
  }
  return buf
}

function probeGoOrPythonCli(repoRoot, nonDocPaths, manifestText) {
  if (/"bin"\s*:/.test(manifestText)) return true
  if (/\[\[bin\]\]/m.test(manifestText) || /\[(?:project|tool\.poetry)\.scripts\]/i.test(manifestText)) return true
  if (nonDocPaths.some((p) => /(?:^|\/)src\/main\.rs$/i.test(p))) return true
  const goMains = nonDocPaths.filter((p) => /(?:^|\/)main\.go$/i.test(p)).slice(0, 3)
  for (const rel of goMains) {
    const txt = readTextSafe(join(repoRoot, rel)) ?? ''
    if (/\bpackage\s+main\b/.test(txt) || /"(?:flag|github\.com\/spf13\/cobra|github\.com\/urfave\/cli)"/.test(txt)) return true
  }
  return false
}

/** 基于真实相对路径列表与仓库清单推导形态信号（零硬编码仓库名）。 */
export function analyzeDocShapeFromPaths(repoRoot, filePaths = []) {
  const cleanPaths = (filePaths ?? [])
    .map((f) => posixPath(typeof f === 'string' ? f : f?.rel ?? '').replace(/^\.\//, ''))
    .filter((p) => p && !isToolOwnedPath(p) && !NOT_PROJECT_DIRS_RE.test(p))

  const nonArchive = cleanPaths.filter((p) => !/^docs\/archive\//i.test(p))
  const nonDocPaths = nonArchive.filter((p) => !/^docs\//i.test(p))
  const hasCode = nonDocPaths.some((p) => CODE_OR_MANIFEST_RE.test(p))
  const manifestText = repoRoot ? readPkgDepsText(repoRoot, nonDocPaths) : ''

  const authHit = nonDocPaths.find((p) => /(?:^|\/)(?:auth|authn|authz|rbac|acl|permissions?|roles?|login|logout|sessions?|jwt|oauth|oidc|sso|security|guards?)(?:\/|[._-]|$)/i.test(p))
    ?? nonArchive.find((p) => /(?:^|\/)CODEOWNERS$/i.test(p))
  const authDeps = /\b(?:passport|next-auth|@auth\/|clerk|auth0|jsonwebtoken|casbin|devise|spring-security)\b/i.test(manifestText)
  const authRoles = Boolean(authHit || authDeps)

  const stateHit = nonDocPaths.find((p) => /(?:^|\/)(?:migrations?|migrate|schema|prisma|alembic|flyway|liquibase|models?|entities|fsm|state[-_]?machines?|workflow[-_]?policy|ledger|states?)(?:\/|[._-]|$)/i.test(p)
    || /\.(?:sql|prisma|graphql)$/i.test(p))
  const stateRules = Boolean(stateHit)

  const uiHit = nonDocPaths.find((p) => /\.(?:tsx|jsx|vue|svelte|astro|html|css|scss|less)$/i.test(p)
    || /(?:^|\/)(?:vite|next|nuxt|svelte|astro|webpack|tailwind)\.config\./i.test(p))
  const uiDeps = /"(?:react|vue|svelte|next|nuxt|@angular\/core)"\s*:/.test(manifestText)
  const uiFrontend = Boolean(uiHit || uiDeps)

  const ciHit = nonArchive.find((p) => /(?:^|\/)\.github\/workflows\/.+\.ya?ml$/i.test(p)
    || /(?:^|\/)(?:Dockerfile(?:\..+)?|docker-compose(?:\.[^/]+)?\.ya?ml|compose(?:\.[^/]+)?\.ya?ml|k8s\/|helm\/|deploy\/|RELEASING\.md$|release\.(?:sh|mjs|py|yml|yaml)$)$/i.test(p)
    || /(?:^|\/)(?:migrations?|migrate|alembic\.ini)\b/i.test(p))
  const ciRollout = Boolean(ciHit)

  const cliHit = nonDocPaths.find((p) => /(?:^|\/)(?:cmd|bin)\//i.test(p)
    || /(?:^|\/)(?:cli|main)\.[A-Za-z0-9]+$/i.test(p)
    || /(?:^|\/)SKILL\.md$/i.test(p))
  const cliEntry = Boolean(cliHit || (repoRoot && probeGoOrPythonCli(repoRoot, nonDocPaths, manifestText)))

  const profile = repoRoot ? parseAgentsProfile(repoRoot) : null
  const collabFileHit = nonArchive.find((p) => /(?:^|\/)(?:CODEOWNERS|CONTRIBUTING\.md|pnpm-workspace\.yaml|go\.work|lerna\.json|nx\.json|turbo\.json)$/i.test(p))
  const codeTopDirs = new Set(
    nonDocPaths
      .filter((p) => CODE_OR_MANIFEST_RE.test(p) && p.includes('/'))
      .map((p) => p.split('/')[0]),
  )
  const workspacePackages = new Set(
    nonDocPaths
      .filter((p) => /^(?:packages|apps|services)\/[^/]+\//i.test(p))
      .map((p) => p.split('/').slice(0, 2).join('/')),
  )
  const multiCollab = Boolean(
    collabFileHit
    || (profile?.archRules?.length ?? 0) > 0
    || workspacePackages.size >= 2
    || codeTopDirs.size >= 3,
  )

  const perfHit = nonDocPaths.find((p) => /(?:^|\/)(?:bench(?:mark)?s?|perf)\//i.test(p) || /\.bench\./i.test(p))
  const codeFileCount = nonDocPaths.filter((p) => /\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|kt|cs|rb|php)$/i.test(p)).length

  return {
    hasCode,
    codeFileCount,
    signals: { authRoles, stateRules, uiFrontend, ciRollout, cliEntry, multiCollab },
    evidence: {
      authRoles: authHit ?? (authDeps ? 'manifest-auth-dep' : null),
      stateRules: stateHit ?? null,
      uiFrontend: uiHit ?? (uiDeps ? 'manifest-ui-dep' : null),
      ciRollout: ciHit ?? null,
      cliEntry: cliHit ?? (cliEntry ? 'manifest-cli-bin' : null),
      multiCollab: collabFileHit ?? (workspacePackages.size >= 2 ? 'workspace-packages' : (codeTopDirs.size >= 3 ? `dirs:${codeTopDirs.size}` : null)),
      perf: perfHit ?? null,
    },
  }
}

/** 异步探测工作区文档形态（优先使用 gitLsFilesTextAndCode，回退本地文件遍历）。 */
export async function probeWorkspaceDocShape(repoRoot) {
  if (!repoRoot || !existsSync(repoRoot)) {
    return analyzeDocShapeFromPaths(null, [])
  }
  const ls = await gitLsFilesTextAndCode(repoRoot, { isGit: existsSync(join(repoRoot, '.git')) })
  const paths = (ls.files ?? []).map((f) => f.rel)
  return analyzeDocShapeFromPaths(repoRoot, paths)
}

/** 同步探测工作区文档形态（供同步模板渲染入口使用）。 */
export function detectDocShapesSync(repoRoot) {
  return analyzeDocShapeFromPaths(repoRoot, walkPathsSync(repoRoot))
}

function shouldKeepOptionalSection(kind, id, shape) {
  const s = shape.signals
  const hasCode = shape.hasCode
  if (id === 'clarifications' || id === 'pending' || id === 'door' || id === 'implementation' || id === 'steps' || id === 'breakpoint') {
    return { keep: true, reason: '默认适用通用骨架' }
  }
  if (kind === 'prd') {
    if (id === 'users') return { keep: s.authRoles, reason: s.authRoles ? '检出鉴权/权限信号' : '未检出鉴权/权限信号' }
    if (id === 'flow') return { keep: hasCode || s.cliEntry || s.uiFrontend || s.authRoles || s.stateRules, reason: '存在代码或入口交互链路' }
    if (id === 'rules') return { keep: s.stateRules, reason: s.stateRules ? '检出状态机/持久化模型信号' : '未检出状态机/持久化信号' }
    if (id === 'reuse') return { keep: hasCode || s.multiCollab, reason: hasCode ? '代码仓需核实可复用模块' : '纯空仓无代码模块' }
    if (id === 'nfr') return { keep: s.uiFrontend || s.stateRules || s.multiCollab || Boolean(shape.evidence.perf) || shape.codeFileCount >= 20, reason: s.uiFrontend || s.stateRules || s.multiCollab ? '存在前端/持久化/多协作者质量要求' : '小型单模块工程无需专节' }
    if (id === 'rollout') return { keep: s.ciRollout, reason: s.ciRollout ? '检出 CI/发布部署流信号' : '未检出 CI/发布部署流信号' }
    if (id === 'metrics') return { keep: s.uiFrontend || s.ciRollout || s.multiCollab, reason: '无在线指标或前端发布观测信号' }
    if (id === 'dependencies') return { keep: s.multiCollab || s.ciRollout, reason: '无跨模块/团队外部依赖信号' }
    if (id === 'risks') return { keep: s.multiCollab || s.ciRollout || s.authRoles || s.stateRules, reason: '无高风险部署/鉴权/跨模块协作信号' }
  }
  if (kind === 'spec') {
    if (id === 'design') return { keep: hasCode || s.cliEntry || s.uiFrontend || s.authRoles || s.stateRules, reason: '代码变更需设计契约说明' }
    if (id === 'alternatives') return { keep: hasCode || s.cliEntry || s.multiCollab, reason: '技术方案需记录否决理由' }
    if (id === 'breakdown') return { keep: hasCode || s.cliEntry || s.multiCollab, reason: '代码仓需改动影响面清单' }
    if (id === 'rollout') return { keep: s.ciRollout || s.stateRules, reason: s.ciRollout || s.stateRules ? '检出发布流/迁移信号' : '未检出发布/迁移信号' }
  }
  if (kind === 'todo') {
    if (id === 'risk') return { keep: hasCode || s.cliEntry || s.ciRollout || s.authRoles || s.stateRules || s.multiCollab, reason: '执行阶段风险跟踪' }
    if (id === 'rollback') return { keep: hasCode || s.cliEntry || s.ciRollout || s.stateRules || s.multiCollab, reason: '保留回滚预案' }
    if (id === 'coordination') return { keep: s.multiCollab, reason: s.multiCollab ? '检出多模块/多协作者信号' : '未检出多协作者/多模块信号' }
  }
  return { keep: true, reason: '默认保留' }
}

/** 合并工作区形态与项目模板声明，输出不可越界的裁剪集合与跳过明细。 */
export function resolveDocShapePolicy(repoRoot, kind, { noPrune = false, docShape = null } = {}) {
  const req = resolveDocRequirements(repoRoot, kind)
  const coreIds = FORM_INDEPENDENT_CORE[kind] ?? []
  const protectedIds = new Set([...coreIds, ...req.sections.map((s) => s.id)])
  const shape = docShape ?? (repoRoot ? detectDocShapesSync(repoRoot) : analyzeDocShapeFromPaths(null, []))

  if (noPrune) {
    return { kind, shape, req, dropSections: new Set(), skipped: [], noPrune: true }
  }

  const dropSections = new Set()
  const skipped = []
  const optionals = OPTIONAL_ORDER_BY_KIND[kind] ?? []

  for (const id of optionals) {
    if (protectedIds.has(id)) continue
    if (req.omit.has(id)) {
      dropSections.add(id)
      skipped.push({ id, tag: SECTION_TAGS[id] ?? id, label: SECTION_LABELS[id] ?? id, reason: '项目模板 omit_sections 声明' })
      continue
    }
    const decision = shouldKeepOptionalSection(kind, id, shape)
    if (!decision.keep) {
      dropSections.add(id)
      skipped.push({ id, tag: SECTION_TAGS[id] ?? id, label: SECTION_LABELS[id] ?? id, reason: decision.reason })
    }
  }

  for (const omitId of req.omit) {
    if (!protectedIds.has(omitId) && !dropSections.has(omitId)) {
      dropSections.add(omitId)
      skipped.push({ id: omitId, tag: SECTION_TAGS[omitId] ?? omitId, label: SECTION_LABELS[omitId] ?? omitId, reason: '项目模板 omit_sections 声明' })
    }
  }

  return { kind, shape, req, dropSections, skipped, noPrune: false }
}

/** 生成机器可解析注释与人类可复核摘要（不含尖括号占位或文件路径）。 */
export function formatDocShapeSkippedBlock(skipped = []) {
  if (!Array.isArray(skipped) || skipped.length === 0) return ''
  const tags = skipped.map((s) => s.tag ?? s.id)
  const uniqueReasons = [...new Set(skipped.map((s) => s.reason).filter(Boolean))]
  const reasonText = uniqueReasons.slice(0, 3).join('；') || '当前工作区形态未检出对应信号'
  return [
    `<!-- doc-shape-skipped: ${tags.join(', ')} | reason: ${reasonText} -->`,
    `> 形态裁剪说明（doc-shape）：已跳过 ${tags.map((t) => `\`${t}\``).join('、')}（依据：${reasonText}；如需保留可加 \`--no-prune\` 或在模板声明 \`required_sections\`）。`,
  ].join('\n')
}

function normalizeSkippedToken(rawTok) {
  const clean = String(rawTok ?? '').trim().replace(/^`+|`+$/g, '')
  if (!clean) return null
  const base = clean.split(/[/(（]/)[0].trim().toLowerCase()
  if (!base) return null
  if (base === 'roles' || base === 'role') return 'users'
  return base
}

/** 从文档正文剥除代码块与行内反引号后解析 `<!-- doc-shape-skipped: ... -->` 标记。 */
export function parseDocShapeSkippedComment(text) {
  const norm = String(text ?? '').replace(/\r\n/g, '\n')
  const lines = norm.split('\n')
  const skippedSections = []
  const seen = new Set()
  let firstLine = 0
  let hasMarker = false
  let inFence = false

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i]
    if (/^\s*(?:```|~~~)/.test(rawLine)) { inFence = !inFence; continue }
    if (inFence) continue
    const noInlineCode = rawLine.replace(/`[^`\n]*`/g, '')
    for (const m of noInlineCode.matchAll(/<!--\s*doc-shape-skipped\s*:\s*([^>]+?)-->/gi)) {
      hasMarker = true
      if (!firstLine) firstLine = i + 1
      const listPart = m[1].split('|')[0]
      for (const tok of listPart.split(/[,，、\s]+/)) {
        const id = normalizeSkippedToken(tok)
        if (id && !seen.has(id)) {
          seen.add(id)
          skippedSections.push(id)
        }
      }
    }
  }
  return { hasMarker, line: firstLine || 1, skippedSections }
}

/** 校验文档中的 `doc-shape-skipped` 标记未越界跳过主干三节或项目 `required_sections`。 */
export function validateSkippedSections(text, docRequirements, docType) {
  const parsed = parseDocShapeSkippedComment(text)
  if (!parsed.hasMarker || parsed.skippedSections.length === 0) {
    return { skippedSections: [], errors: [] }
  }
  const coreIds = new Set(FORM_INDEPENDENT_CORE[docType] ?? [])
  const requiredIds = new Set((docRequirements?.sections ?? []).map((s) => s.id))
  const errors = []
  for (const id of parsed.skippedSections) {
    if (coreIds.has(id) || requiredIds.has(id)) {
      errors.push({
        code: 'DOC_SKIP_INVALID_SECTION',
        line: parsed.line,
        section: id,
        message: `doc-shape-skipped 非法跳过了不可豁免章节「${id}」（属于主干三节或项目模板 required_sections）`,
        fixHint: '删除该跳过标记并补齐对应章节内容，或核对项目模板的 required_sections 声明。',
      })
    }
  }
  return { skippedSections: parsed.skippedSections, errors }
}
