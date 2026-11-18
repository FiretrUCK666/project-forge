/**
 * survey-docs.mjs —— 文档清单、工作流配置、设计体系与项目约定探测。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import * as protocol from './protocol.mjs'
import { isMacMetadataName, readTextSafe } from './text.mjs'

const LIKELY_DEFAULT_BRANCHES = protocol.LIKELY_DEFAULT_BRANCHES ?? ['main', 'master', 'trunk', 'develop', 'default', 'development']
const parseMarkers = protocol.parseMarkers

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

function detectExistingDesignDocs(root) {
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
  for (const subRel of ['docs/design', 'docs/architecture', 'docs/adr']) {
    const subAbs = join(root, subRel)
    if (!existsSync(subAbs)) continue
    let entries = []
    try { entries = readdirSync(subAbs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isFile() || isMacMetadataName(entry.name) || entry.name === '.gitkeep') continue
      if (/\.(?:md|mdx|rst|txt)$/i.test(entry.name)) found.add(`${subRel}/${entry.name}`)
    }
  }
  return [...found].sort()
}

function detectOtherAiConventions(root) {
  const singles = [
    'CLAUDE.md', '.clinerules', '.cursorrules', '.windsurfrules', 'CONVENTIONS.md',
    '.github/copilot-instructions.md', 'GEMINI.md', 'COPILOT_INSTRUCTIONS.md',
  ].filter((rel) => existsSync(join(root, rel)))

  const dirs = ['.cursor/rules', '.roo/rules', '.github/instructions']
  const fromDirs = []
  for (const dir of dirs) {
    let names = []
    try { names = readdirSync(join(root, dir), { withFileTypes: true }) } catch { continue }
    for (const entry of names) {
      if (!entry.isFile() || isMacMetadataName(entry.name)) continue
      if (!/\.(?:md|mdc|txt|rules?)$/i.test(entry.name)) continue
      fromDirs.push(`${dir}/${entry.name}`)
    }
  }
  return [...singles, ...fromDirs]
}

function parseAgentMarkers(root, agents) {
  if (!agents) return { marks: 0, fills: [] }
  const text = readTextSafe(join(root, agents)) ?? ''
  const markers = parseMarkers(text, agents)
  return {
    marks: markers.length,
    fills: markers.filter((m) => m.kind === 'fill').map((m) => ({ line: m.line, what: m.what })),
  }
}

export function detectDocs(root) {
  let entries = []
  try { entries = readdirSync(root).filter((n) => !isMacMetadataName(n)) } catch {}
  const find = (name) => entries.find((e) => e.toLowerCase() === name.toLowerCase())

  const readmes = entries.filter((e) => /^readme(?:\.[a-z0-9_-]+)?\.md$/i.test(e))
  const agents = find('AGENTS.md')
  const contributing = find('CONTRIBUTING.md')
  const releasing = ['RELEASING.md', 'RELEASE.md', 'RELEASING.rst', 'docs/RELEASING.md', 'docs/releasing.md']
    .find((rel) => existsSync(join(root, rel)))
  const changelog = ['CHANGELOG.md', 'CHANGELOG.rst', 'CHANGES.md', 'HISTORY.md']
    .find((rel) => existsSync(join(root, rel)))
  const license = entries.find((e) => /^licen[cs]e(?:\..+|-.*)?$/i.test(e))
  const otherAiConventions = detectOtherAiConventions(root)

  const wfDir = join(root, '.github', 'workflows')
  const workflows = []
  const workflowFacts = {
    hasCheck: false,
    hasRelease: false,
    checkWorkflows: [],
    releaseWorkflows: [],
    releaseTools: [],
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
      const text = readTextSafe(join(wfDir, name)) ?? ''
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

  const prTemplateFiles = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']
    .filter((rel) => existsSync(join(root, rel)))
  const issueDir = join(root, '.github', 'ISSUE_TEMPLATE')
  let issueTemplateFiles = []
  if (existsSync(issueDir)) {
    try {
      issueTemplateFiles = readdirSync(issueDir)
        .filter((f) => !isMacMetadataName(f) && /\.(?:md|ya?ml)$/i.test(f))
        .map((f) => `.github/ISSUE_TEMPLATE/${f}`)
    } catch {}
  }

  const tdd = existsSync(join(root, 'docs', 'TDD.md')) ? 'docs/TDD.md' : undefined
  const existingDesignDocs = detectExistingDesignDocs(root)
  const specsDir = existsSync(join(root, 'docs', 'specs'))
  const todoDir = existsSync(join(root, 'docs', 'todo'))
  const prdDir = existsSync(join(root, 'docs', 'prd'))
  // 「目录存在」与「目录里有真东西」是两件事：`equip` 会建空骨架，
  // 拿目录存在当「这个项目治理过」，等于让工具自己证明自己。
  const specsDirContent = listRelFiles(join(root, 'docs', 'specs'), 'docs/specs')
  const todoDirContent = listRelFiles(join(root, 'docs', 'todo'), 'docs/todo')
  let agentsBytes = 0
  if (agents) {
    try { agentsBytes = statSync(join(root, agents)).size } catch { agentsBytes = 0 }
  }

  return {
    readmes,
    readme: readmes[0],
    readmePair: readmes.length > 1,
    agents: agents ? { file: agents } : undefined,
    agentsBytes,
    agentsMarkers: parseAgentMarkers(root, agents),
    contributing,
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
    otherAiConventions,
    workflows,
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

  return {
    coreHooksPath: normalizedHooksPath || undefined,
    coreHooksPathScope: scope || undefined,
    hasGithooksDir: existsSync(join(root, '.githooks')),
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
  for (const dir of ['.changeset', '.husky', '.lefthook']) {
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
