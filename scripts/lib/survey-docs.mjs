/**
 * survey-docs.mjs —— 文档清单、工作流配置、设计体系与项目约定探测。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import * as protocol from './protocol.mjs'
import { isMacMetadataName, readTextSafe } from './text.mjs'
import { classifyWorkspaceIdentity, detectGitModeMarkers } from './platform/index.mjs'
import { resolveDocRequirements } from '../../kit/skills/lib/doc-requirements.mjs'
import { detectTddShapes, tddDropSections } from '../../kit/skills/lib/tdd-shape.mjs'
import { CODE_EXT_RE } from '../../kit/skills/lib/git-core.mjs'
import { isSymbolCandidatePath, summarizeSymbolCoverage } from '../../kit/skills/lib/symbol-index.mjs'
import { scanNeutralCiSteps } from '../../kit/skills/lib/profile-sniffer.mjs'
import { isManagedPlanDoc } from '../../kit/skills/lib/doc-frontmatter.mjs'

const { LIKELY_DEFAULT_BRANCHES } = protocol
const parseMarkers = protocol.parseMarkers
const DOC_EXT_RE = /\.(?:md|mdx|markdown|rst|txt|adoc|asciidoc)$/i
const SKIP_SCAN_DIRS = new Set([
  '.git', '.worktrees', 'node_modules', 'vendor', 'third_party',
  'dist', 'build', 'out', 'target', '__pycache__', '.venv', 'venv', 'fixtures',
])

const RELEASE_WORKFLOW_PATTERNS = [
  { tool: 'gh-release', re: /\bgh\s+release\b/i },
  { tool: 'npm-publish', re: /\b(?:npm|pnpm|bun)\s+publish\b|\byarn\s+npm\s+publish\b/i },
  { tool: 'pypi-publish', re: /\b(?:twine\s+upload|pypi-publish)\b|pypa\/gh-action-pypi-publish/i },
  { tool: 'cargo-publish', re: /\bcargo\s+publish\b/i },
  { tool: 'vsce-publish', re: /\b(?:vsce|ovsx)\s+publish\b/i },
  { tool: 'action-gh-release', re: /softprops\/action-gh-release|ncipollo\/release-action|actions\/create-release|actions\/upload-release-asset/i },
  { tool: 'goreleaser', re: /\bgoreleaser\b/i },
  { tool: 'release-please', re: /release-please-action|\brelease-please\b/i },
  { tool: 'changesets', re: /changesets\/action/i },
  { tool: 'semantic-release', re: /\bsemantic-release\b/i },
]

/**
 * 列出某个文档目录下**真实存在的文件**（相对仓库根的 posix 路径）。
 *
 * 只给「这个目录里有什么」，不做任何判断——判断在 `isReentryProject` 与
 * `hasRealContent` 里，那里才知道「空骨架」与「有正文」的区别。
 */
function listRelFiles(dirAbs, dirRel) {
  if (!existsSync(dirAbs)) return []
  let names = []
  try { names = readdirSync(dirAbs) } catch { return [] }
  return names
    .filter((name) => !isMacMetadataName(name))
    .sort()
    .map((name) => `${dirRel}/${name}`)
}

function walkBoundedRelFiles(root, baseDirs, { maxDepth = 5, maxFiles = 2000 } = {}) {
  const out = []
  const queue = baseDirs.map((rel) => ({ rel, depth: rel ? rel.split('/').length : 0 }))
  while (queue.length > 0 && out.length < maxFiles) {
    const { rel, depth } = queue.shift()
    const abs = rel ? join(root, rel) : root
    if (!existsSync(abs)) continue
    let entries = []
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      if (isMacMetadataName(entry.name) || entry.name === '.gitkeep') continue
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (depth < maxDepth && !SKIP_SCAN_DIRS.has(entry.name)) {
          queue.push({ rel: nextRel, depth: depth + 1 })
        }
      } else if (entry.isFile()) {
        out.push(nextRel)
        if (out.length >= maxFiles) break
      }
    }
  }
  return out
}

function normalizedRelList(root, files, fallbackDirs, opts) {
  if (Array.isArray(files) && files.length > 0) {
    return files
      .map((f) => String(f?.rel ?? f).replace(/\\/g, '/'))
      .filter(Boolean)
      .sort()
  }
  return walkBoundedRelFiles(root, fallbackDirs, opts)
}

function detectExistingDesignDocs(root, files = null) {
  const found = new Set()
  const candidates = [
    'ARCHITECTURE.md', 'architecture.md', 'DESIGN.md', 'design.md',
    'docs/ARCHITECTURE.md', 'docs/architecture.md', 'docs/DESIGN.md', 'docs/design.md',
  ]
  for (const rel of candidates) {
    if (existsSync(join(root, rel))) found.add(rel)
  }
  for (const dirRel of ['', 'docs']) {
    const dirAbs = dirRel ? join(root, dirRel) : root
    if (!existsSync(dirAbs)) continue
    let names = []
    try { names = readdirSync(dirAbs) } catch { continue }
    for (const name of names) {
      if (isMacMetadataName(name)) continue
      const fullRel = dirRel ? `${dirRel}/${name}` : name
      if (fullRel === 'docs/TDD.md') continue
      if (/(?:-|_)tdd\.md$|^tdd\.md$/i.test(name)) {
        found.add(fullRel)
      }
    }
  }
  const designRoots = [
    'docs/design', 'docs/architecture', 'docs/adr', 'docs/rfcs',
    'doc', 'documentation', 'rfcs', 'adr',
  ]
  const scanned = Array.isArray(files) && files.length > 0
    ? files.map((f) => String(f?.rel ?? f).replace(/\\/g, '/'))
    : walkBoundedRelFiles(root, designRoots, { maxDepth: 4 })
  for (const rel of scanned) {
    const inDesignDir = designRoots.some((d) => rel.startsWith(`${d}/`))
    if (inDesignDir && DOC_EXT_RE.test(rel)) found.add(rel)
  }
  return [...found].sort()
}

function detectNonStandardArtifacts(root, readmes, files = null) {
  const nonStandardDirs = ['doc', 'documentation', 'rfcs', 'adr', 'proto']
    .filter((d) => existsSync(join(root, d)))
  const relFiles = normalizedRelList(
    root,
    files,
    ['', 'docs', 'doc', 'documentation', 'rfcs', 'adr', 'runbooks', 'proto', 'protos', 'api', 'apis', 'idl', 'spec', 'specs', '.github'],
    { maxDepth: 5 },
  )
  const runbooks = new Set()
  const securityDocs = new Set()
  const apiContracts = new Set()
  const nonStandardDesign = new Set()

  for (const rel of relFiles) {
    const lower = rel.toLowerCase()
    const base = lower.split('/').pop() ?? ''
    if (/^(?:runbook(?:\.[a-z0-9_.-]+)?)\.(?:md|mdx|rst|txt|adoc)$/i.test(base)
      || /^runbooks\/.+\.(?:md|mdx|rst|txt|adoc)$/i.test(lower)) {
      runbooks.add(rel)
    }
    if (/^security(?:\.[a-z0-9_.-]+)?\.(?:md|mdx|rst|txt)$/i.test(base)
      && (!rel.includes('/') || /^(?:docs|\.github)\//i.test(lower))) {
      securityDocs.add(rel)
    }
    if (/^(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(base) || /\.proto$/i.test(base)) {
      apiContracts.add(rel)
    }
    if (/^(?:doc|documentation|rfcs|adr)\//i.test(lower) && DOC_EXT_RE.test(base)) {
      nonStandardDesign.add(rel)
    }
  }
  const nonMdReadmes = readmes.filter((r) => !/\.md$/i.test(r))
  const nonStandardDocs = [...new Set([
    ...nonStandardDirs.map((d) => `${d}/`),
    ...nonStandardDesign,
    ...runbooks,
    ...securityDocs,
    ...apiContracts,
    ...nonMdReadmes,
  ])].sort()

  return {
    nonStandardDirs,
    runbooks: [...runbooks].sort(),
    securityDocs: [...securityDocs].sort(),
    apiContracts: [...apiContracts].sort(),
    nonMdReadmes,
    nonStandardDocs,
  }
}

function detectAiConventions(root, files = null, fileSet = null) {
  const has = (rel) => (fileSet ? fileSet.has(rel) : existsSync(join(root, rel)))
  const singles = [
    'CLAUDE.md', '.clinerules', '.cursorrules', '.windsurfrules', 'CONVENTIONS.md',
    '.github/copilot-instructions.md', 'GEMINI.md', 'COPILOT_INSTRUCTIONS.md',
  ].filter((rel) => has(rel))

  const dirs = ['.cursor/rules', '.roo/rules', '.github/instructions']
  const fromDirs = []
  if (files) {
    for (const rel of files) {
      for (const dir of dirs) {
        if (rel.startsWith(`${dir}/`) && !rel.slice(dir.length + 1).includes('/') && /\.(?:md|mdc|txt|rules?)$/i.test(rel)) {
          fromDirs.push(rel)
        }
      }
    }
  } else {
    for (const dir of dirs) {
      let names = []
      try { names = readdirSync(join(root, dir), { withFileTypes: true }) } catch { continue }
      for (const entry of names) {
        if (!entry.isFile() || isMacMetadataName(entry.name)) continue
        if (!/\.(?:md|mdc|txt|rules?)$/i.test(entry.name)) continue
        fromDirs.push(`${dir}/${entry.name}`)
      }
    }
  }

  const allFiles = normalizedRelList(root, files, [''], { maxDepth: 6 })
  const subdirAgentsFiles = []
  const subdirClaudeFiles = []
  for (const rel of allFiles) {
    if (!rel.includes('/')) continue
    const parts = rel.split('/')
    if (parts.some((seg, idx) => idx < parts.length - 1 && (SKIP_SCAN_DIRS.has(seg) || seg.startsWith('.')))) {
      continue
    }
    const base = parts[parts.length - 1]
    if (/^agents\.md$/i.test(base)) subdirAgentsFiles.push(rel)
    else if (/^claude\.md$/i.test(base)) subdirClaudeFiles.push(rel)
  }

  return {
    otherAiConventions: [...new Set([...singles, ...fromDirs, ...subdirClaudeFiles])].sort(),
    subdirAgentsFiles: [...new Set(subdirAgentsFiles)].sort(),
    aiSubdirConventions: [...new Set([...subdirAgentsFiles, ...subdirClaudeFiles])].sort(),
  }
}

function parseAgentMarkers(root, agents, textByRel = null) {
  if (!agents) return { marks: 0, fills: [] }
  const text = textByRel?.get(agents) ?? readTextSafe(join(root, agents)) ?? ''
  const markers = parseMarkers(text, agents)
  return {
    marks: markers.length,
    fills: markers.filter((m) => m.kind === 'fill').map((m) => ({ line: m.line, what: m.what })),
  }
}

function sortPrimaryFirst(files, exactPrimaryLower, englishLower) {
  return [...files].sort((a, b) => {
    const la = a.toLowerCase()
    const lb = b.toLowerCase()
    const rank = (s) => (s === exactPrimaryLower ? 0 : s === englishLower ? 1 : /\.md$/i.test(s) ? 2 : 3)
    const ra = rank(la)
    const rb = rank(lb)
    return ra !== rb ? ra - rb : a < b ? -1 : a > b ? 1 : 0
  })
}

export function detectDocs(root, opts = {}) {
  const rawFiles = opts?.files ?? null
  const files = Array.isArray(rawFiles)
    ? rawFiles.map((f) => (typeof f === 'string' ? f : String(f?.rel ?? '')).replace(/\\/g, '/'))
    : rawFiles
  const fileSet = files ? new Set(files) : null
  const hasRel = (rel) => (fileSet ? fileSet.has(rel) : existsSync(join(root, rel)))
  const textByRel = opts?.textByRel ?? null
  const preNeutralCi = opts?.neutralCi ?? null
  let entries = []
  let fileEntries = []
  try {
    const dirents = readdirSync(root, { withFileTypes: true }).filter((d) => !isMacMetadataName(d.name))
    entries = dirents.map((d) => d.name)
    fileEntries = dirents.filter((d) => d.isFile()).map((d) => d.name)
  } catch {}
  const find = (name) => entries.find((e) => e.toLowerCase() === name.toLowerCase())

  const readmes = sortPrimaryFirst(
    fileEntries.filter((e) => /^readme$/i.test(e)
      || /^readme(?:\.[a-z0-9_.-]+)?\.(?:md|mdx|markdown|rst|txt|adoc|asciidoc|org)$/i.test(e)),
    'readme.md',
    'readme.en.md',
  )
  const agents = find('AGENTS.md')
  const contributingFiles = sortPrimaryFirst(
    fileEntries.filter((e) => /^contributing(?:\.[a-z0-9_.-]+)?\.(?:md|mdx|markdown|rst|txt|adoc)$/i.test(e)),
    'contributing.md',
    'contributing.en.md',
  )
  const contributing = contributingFiles[0]
  const releasing = ['RELEASING.md', 'RELEASE.md', 'RELEASING.rst', 'docs/RELEASING.md', 'docs/releasing.md']
    .find((rel) => hasRel(rel))
  const changelog = ['CHANGELOG.md', 'CHANGELOG.rst', 'CHANGES.md', 'HISTORY.md']
    .find((rel) => hasRel(rel))
  const license = entries.find((e) => /^licen[cs]e(?:\..+|-.*)?$/i.test(e))
  const aiConv = detectAiConventions(root, files, fileSet)
  const otherAiConventions = aiConv.otherAiConventions

  const wfDir = join(root, '.github', 'workflows')
  const workflows = []
  const workflowFacts = {
    hasCheck: false,
    hasRelease: false,
    checkWorkflows: [],
    releaseWorkflows: [],
    releaseTools: [],
    neutralCiConfigs: [],
    usesPullRequestTarget: false,
    checkoutsPrHead: false,
    hasContentsWrite: false,
  }
  if (existsSync(wfDir)) {
    let names = []
    try { names = readdirSync(wfDir).filter((n) => !isMacMetadataName(n)) } catch {}
    for (const name of names) {
      if (!/\.ya?ml$/i.test(name)) continue
      workflows.push(name)
      const text = textByRel?.get(`.github/workflows/${name}`) ?? readTextSafe(join(wfDir, name)) ?? ''
      const activeText = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
      let matchedRelease = false
      for (const pat of RELEASE_WORKFLOW_PATTERNS) {
        if (pat.re.test(activeText)) {
          matchedRelease = true
          if (!workflowFacts.releaseTools.includes(pat.tool)) workflowFacts.releaseTools.push(pat.tool)
        }
      }
      if (matchedRelease) {
        workflowFacts.hasRelease = true
        workflowFacts.releaseWorkflows.push(name)
      }
      const hasCheckTrigger = !matchedRelease || /\bpull_request\b|\bbranches\s*:/.test(activeText)
      const hasCheckCmd = /\b(?:test|check|lint|preflight|verify|build|pytest|unittest|ctest)\b/i.test(activeText)
      if (hasCheckTrigger && hasCheckCmd) {
        workflowFacts.hasCheck = true
        workflowFacts.checkWorkflows.push(name)
      }
      if (/pull_request_target/.test(activeText)) workflowFacts.usesPullRequestTarget = true
      if (/github\.event\.pull_request\.(?:head\.(?:sha|ref)|number)/.test(activeText)) {
        workflowFacts.checkoutsPrHead = true
      }
      if (/permissions:[\s\S]{0,160}contents:\s*write/.test(activeText)) workflowFacts.hasContentsWrite = true
    }
  }

  const neutralCi = preNeutralCi ?? scanNeutralCiSteps(root)
  const neutralCiConfigs = neutralCi.ciConfigFiles.filter((rel) => !rel.startsWith('.github/workflows/'))
  workflowFacts.neutralCiConfigs = neutralCiConfigs
  for (const rel of neutralCiConfigs) {
    const text = readTextSafe(join(root, rel)) ?? ''
    const activeText = text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    const hasSteps = neutralCi.steps.some((s) => s.file === rel)
    const hasCheckCmd = /\b(?:test|tests|check|lint|preflight|verify|build|pytest|unittest|ctest|stage|steps|script|jobs)\b/i.test(activeText)
    if (hasSteps || hasCheckCmd) {
      workflowFacts.hasCheck = true
      if (!workflowFacts.checkWorkflows.includes(rel)) workflowFacts.checkWorkflows.push(rel)
    }
  }

  const prTemplateFiles = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']
    .filter((rel) => hasRel(rel))
  const issueDir = join(root, '.github', 'ISSUE_TEMPLATE')
  let issueTemplateFiles = []
  if (files) {
    issueTemplateFiles = files.filter((f) => f.startsWith('.github/ISSUE_TEMPLATE/') && !f.slice(23).includes('/') && /\.(?:md|ya?ml)$/i.test(f))
  } else if (existsSync(issueDir)) {
    try {
      issueTemplateFiles = readdirSync(issueDir)
        .filter((f) => !isMacMetadataName(f) && /\.(?:md|ya?ml)$/i.test(f))
        .map((f) => `.github/ISSUE_TEMPLATE/${f}`)
    } catch {}
  }

  const tdd = hasRel('docs/TDD.md') ? 'docs/TDD.md' : undefined
  const existingDesignDocs = detectExistingDesignDocs(root, files)
  const nonStandard = detectNonStandardArtifacts(root, readmes, files)
  const localizedDocs = [...new Set(
    fileEntries.filter((e) => /^(?:readme|contributing|security|releasing|changelog)\.[a-z0-9_-]+\.md$/i.test(e)
      || /\.zh-cn\.md$/i.test(e)),
  )].sort()
function partitionPlanDir(root, dirRel) {
  let all
  if (Array.isArray(files) && files.length > 0) {
    const prefix = `${dirRel}/`
    all = files.filter((r) => r.startsWith(prefix)).sort()
    if (all.length === 0 && !existsSync(join(root, dirRel))) return { content: [], foreign: [] }
  } else {
    const dirAbs = join(root, dirRel)
    if (!existsSync(dirAbs)) return { content: [], foreign: [] }
    const rawFiles = walkBoundedRelFiles(root, [dirRel], { maxDepth: 4 })
    const topNames = listRelFiles(dirAbs, dirRel)
    all = [...new Set([...topNames, ...rawFiles])].sort()
  }
  const content = []
  const foreign = []
  for (const rel of all) {
    const base = rel.split('/').pop() ?? ''
    if (base === '.gitkeep') { content.push(rel); continue }
    const cachedText = textByRel?.get(rel)
    if (cachedText === undefined && !fileSet?.has(rel)) {
      const abs = join(root, rel)
      let isDir = false
      try { isDir = statSync(abs).isDirectory() } catch { isDir = false }
      if (isDir) continue
    }
    const text = cachedText ?? readTextSafe(join(root, rel)) ?? ''
    if (isManagedPlanDoc(rel, text)) content.push(rel)
    else foreign.push(rel)
  }
  return { content, foreign }
}

  const hasPlanPrefix = (p) => files?.some((f) => String(f?.rel ?? f).replace(/\\/g, '/').startsWith(p))
  const specsDir = hasPlanPrefix('docs/specs/') || existsSync(join(root, 'docs', 'specs'))
  const todoDir = hasPlanPrefix('docs/todo/') || existsSync(join(root, 'docs', 'todo'))
  const prdDir = hasPlanPrefix('docs/prd/') || existsSync(join(root, 'docs', 'prd'))
  // 「目录存在」与「目录里有真东西」是两件事：`equip` 会建空骨架，
  // 拿目录存在当「这个项目治理过」，等于让工具自己证明自己；目标仓原生非受管文档归入 preservedForeignPlanDocs。
  const specsPart = partitionPlanDir(root, 'docs/specs')
  const todoPart = partitionPlanDir(root, 'docs/todo')
  const prdPart = partitionPlanDir(root, 'docs/prd')
  const specsDirContent = specsPart.content
  const todoDirContent = todoPart.content
  const prdDirContent = prdPart.content
  const preservedForeignPlanDocs = [...new Set([...specsPart.foreign, ...todoPart.foreign, ...prdPart.foreign])].sort()
  let agentsBytes = 0
  if (agents) {
    try { agentsBytes = statSync(join(root, agents)).size } catch { agentsBytes = 0 }
  }

  return {
    readmes,
    readme: readmes[0],
    readmePair: readmes.length > 1,
    nonMdReadmes: nonStandard.nonMdReadmes,
    agents: agents ? { file: agents } : undefined,
    agentsBytes,
    agentsMarkers: parseAgentMarkers(root, agents, textByRel),
    contributing,
    contributingFiles,
    localizedDocs,
    securityDocs: nonStandard.securityDocs,
    runbooks: nonStandard.runbooks,
    apiContracts: nonStandard.apiContracts,
    nonStandardDirs: nonStandard.nonStandardDirs,
    nonStandardDocs: nonStandard.nonStandardDocs,
    releasing,
    changelog,
    license,
    tdd,
    existingDesignDocs,
    specsDir,
    todoDir,
    prdDir,
    specsDirContent,
    todoDirContent,
    prdDirContent,
    preservedForeignPlanDocs,
    otherAiConventions,
    subdirAgentsFiles: aiConv.subdirAgentsFiles,
    aiSubdirConventions: aiConv.aiSubdirConventions,
    workflows,
    neutralCiConfigs,
    workflowFacts,
    prTemplate: prTemplateFiles.length > 0,
    prTemplateFile: prTemplateFiles[0],
    issueTemplates: issueTemplateFiles.length > 0,
    issueTemplateFiles,
  }
}

const WORK_DIR_CANDIDATES = ['docs/todo', 'docs/work', 'docs/tasks', 'todo', 'work']

export const FORGE_HOOK_MARKER = '# project-forge: githooks-pre-push'

const LEFTHOOK_FILES = [
  'lefthook.yml',
  'lefthook.yaml',
  '.lefthook.yml',
  '.lefthook.yaml',
  'lefthook-local.yml',
  'lefthook-local.yaml',
]

function normalizeHooksPath(raw) {
  const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return s.replace(/^\.\//, '')
}

function readGitHooksPathSync(root) {
  if (!existsSync(join(root, '.git'))) return { value: undefined, scope: undefined }
  for (const args of [['config', '--local', '--get', 'core.hooksPath'], ['config', '--get', 'core.hooksPath']]) {
    const res = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
    if (res.status === 0 && res.stdout && res.stdout.trim()) {
      return {
        value: res.stdout.trim(),
        scope: args.includes('--local') ? 'local' : 'global',
      }
    }
  }
  return { value: undefined, scope: undefined }
}

/**
 * 只读探测本地 Git Hook 管理状况（`.husky/`、`lefthook*`、`core.hooksPath` 与 `.githooks/pre-push`）。
 */
export function detectGitHooksState(root, { coreHooksPath, hooksPathScope } = {}) {
  let rawHooksPath = coreHooksPath
  let scope = hooksPathScope
  if (rawHooksPath === undefined) {
    const probed = readGitHooksPathSync(root)
    rawHooksPath = probed.value
    scope = probed.scope
  }
  const normalizedHooksPath = rawHooksPath ? normalizeHooksPath(rawHooksPath) : ''
  const conflicts = []

  if (existsSync(join(root, '.husky'))) {
    conflicts.push({
      kind: 'husky',
      path: '.husky/',
      detail: '仓库已存在 .husky/ 钩子目录，preserve 不覆盖，请将默认分支推送护栏并入既有钩子',
    })
  }
  for (const rel of LEFTHOOK_FILES) {
    if (existsSync(join(root, rel))) {
      conflicts.push({
        kind: 'lefthook',
        path: rel,
        detail: `仓库已存在 ${rel}，preserve 不接管 core.hooksPath，请按需将保护脚本接入现有配置`,
      })
    }
  }
  if (existsSync(join(root, '.lefthook'))) {
    conflicts.push({
      kind: 'lefthook',
      path: '.lefthook/',
      detail: '仓库已存在 .lefthook/ 目录，preserve 不接管 core.hooksPath，请保持原有钩子管理入口',
    })
  }
  if (normalizedHooksPath && normalizedHooksPath !== '.githooks') {
    conflicts.push({
      kind: 'custom-hooks-path',
      path: rawHooksPath,
      detail: `仓库已配置自定义 core.hooksPath=${rawHooksPath}，preserve 不覆盖`,
    })
  }

  const prePushRel = '.githooks/pre-push'
  const prePushAbs = join(root, '.githooks', 'pre-push')
  const hasPrePush = existsSync(prePushAbs)
  let managedPrePush = false
  let prePushExecutable = false
  if (hasPrePush) {
    const content = readTextSafe(prePushAbs) ?? ''
    managedPrePush = content.includes(FORGE_HOOK_MARKER)
    if (!managedPrePush) {
      conflicts.push({
        kind: 'custom-githooks-pre-push',
        path: prePushRel,
        detail: '仓库已存在非本工具创建的 .githooks/pre-push，preserve 不覆写',
      })
    }
    try {
      const mode = statSync(prePushAbs).mode
      prePushExecutable = process.platform === 'win32'
        ? managedPrePush || /^#!\/bin\/sh/.test(content)
        : (mode & 0o111) !== 0
    } catch {
      prePushExecutable = false
    }
  }

  const hooksDirAbs = join(root, '.githooks')
  const hasGithooksDir = existsSync(hooksDirAbs)
  let githooksFiles = []
  if (hasGithooksDir) {
    try {
      githooksFiles = readdirSync(hooksDirAbs, { withFileTypes: true })
        .filter((e) => e.isFile() && !isMacMetadataName(e.name) && e.name !== '.gitkeep')
        .map((e) => e.name)
        .sort()
    } catch { githooksFiles = [] }
  }
  const customHookFiles = githooksFiles.filter((name) => !(name === 'pre-push' && managedPrePush))
  if (!managedPrePush && !hasPrePush && customHookFiles.length > 0) {
    conflicts.push({
      kind: 'custom-githooks',
      path: '.githooks/',
      detail: `仓库已存在既有 .githooks/ 钩子（${customHookFiles.join('、')}），preserve 不覆写`,
    })
  }

  return {
    coreHooksPath: normalizedHooksPath || undefined,
    coreHooksPathScope: scope || undefined,
    hasGithooksDir,
    githooksFiles,
    hasPrePush,
    managedPrePush,
    prePushExecutable,
    installed: Boolean(hasPrePush && managedPrePush && normalizedHooksPath === '.githooks'),
    conflicts,
    hasConflict: conflicts.length > 0,
  }
}

function detectWorkflowTooling(root) {
  const found = []
  const singles = [
    'release-please-config.json', '.releaserc', '.releaserc.json', '.releaserc.yml',
    '.goreleaser.yml', '.goreleaser.yaml', 'goreleaser.yml', 'goreleaser.yaml',
    'commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs',
    'lefthook.yml', 'lefthook.yaml', '.lefthook.yml', '.lefthook.yaml',
  ]
  for (const rel of singles) if (existsSync(join(root, rel))) found.push(rel)
  for (const dir of ['.changeset', '.husky', '.lefthook', '.githooks']) {
    if (existsSync(join(root, dir))) found.push(`${dir}/`)
  }
  return found
}

export function detectConventions(root, { gitFacts, docs, ecosystem }) {
  const currentBranch = gitFacts.branch && gitFacts.branch !== '(detached)' ? gitFacts.branch : undefined
  const localSet = new Set(gitFacts.localBranches ?? [])
  const remoteOriginSet = new Set(gitFacts.remoteOriginBranches ?? [])
  const existingDefaultBranch = LIKELY_DEFAULT_BRANCHES.find((b) => localSet.has(b) || remoteOriginSet.has(b))
  const defaultBranch = gitFacts.originHeadBranch
    || (currentBranch && LIKELY_DEFAULT_BRANCHES.includes(currentBranch) ? currentBranch : undefined)
    || existingDefaultBranch
    || gitFacts.initDefaultBranch
    || 'main'

  const releaseNotesMode = docs.changelog ? 'changelog' : 'dir'
  const kinds = ecosystem.kinds ?? []
  const needsBareTag = kinds.some((k) => k === 'obsidian-plugin')
  const bareHistory = (gitFacts.tags ?? []).length > 0
    && (gitFacts.tags ?? []).every((t) => /^\d+\.\d+/.test(t))
  const tagPrefix = needsBareTag || bareHistory ? '' : 'v'
  const workDir = WORK_DIR_CANDIDATES.find((rel) => existsSync(join(root, rel))) ?? 'docs/todo'

  return {
    defaultBranch,
    releaseNotesMode,
    tagPrefix,
    commitStyle: gitFacts.commitStyle ?? 'plain',
    workDir,
    workflowTooling: detectWorkflowTooling(root),
  }
}

export function summarizeTddAndSymbolCoverage(root, rawWs, facts) {
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
  const tddReq = resolveDocRequirements(root, 'tdd')
  const tddReqIds = new Set(tddReq.sections.map((s) => s.id))
  const tddShapeSummary = {
    enabled: [...tddShape.enabled],
    reasons: tddShape.reasons,
    dropSections: [...tddDropSections(tddShape, { omit: tddReq.omit, required: tddReqIds })],
    filePaths: shapePaths,
    topLevelDirs: [...new Set((rawWs.dirs ?? []).map((d) => String(d.rel ?? d).replace(/\\/g, '/').split('/')[0]).filter(Boolean))],
  }

  // 符号抽取的覆盖情况：这个仓里有几门语言有符号规则、几门没有。
  // 报出来而不是「抽不到就当没有管理」：差别只在覆盖这一面，所以必须单独说。
  const symbolCoverage = summarizeSymbolCoverage(
    (rawWs.files ?? [])
      .map((f) => String(f.rel ?? f).replace(/\\/g, '/'))
      .filter((rel) => !protocol.isToolOwnedPath(rel)
        && (CODE_EXT_RE.test(rel) || isSymbolCandidatePath(rel))),
  )
  return { tddShape: tddShapeSummary, symbolCoverage }
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

export async function runSurveyCli(argv, surveyFn) {
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
    let out
    if (format === 'markdown') {
      const { toMarkdown } = await import('./render.mjs')
      out = toMarkdown(facts)
    } else {
      out = `${JSON.stringify(facts, null, 2)}\n`
    }
    process.stdout.write(out)
    return 0
  } catch (err) {
    process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}
