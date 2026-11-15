/**
 * equip-bootstrap.mjs —— 通用 `--bootstrap-empty` 工程基线初始化与自洽初始契约生成。
 *
 * - 废除硬编码业务玩具代码，仅搭工程治理基线（git init、.gitattributes、.gitignore、
 *   可选 README.md、docs/TDD.md、docs/{prd,specs,todo}/.gitkeep 与无未填标记 AGENTS.md）。
 * - 兼容已有 README* / LICENSE* / .gitignore / .gitattributes / .github/ / .agents/。
 * - 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from './fs-atomic.mjs'
import { isMacOsMetadata } from './protocol.mjs'
import { posixPath, readTextSafe } from './text.mjs'

export const BOOTSTRAP_STACKS = new Set([
  'universal', 'node', 'python', 'rust', 'go', 'java',
  'ruby', 'php', 'dotnet', 'cpp', 'dart', 'swift', 'elixir', 'docs',
])

const EMPTY_NOISE_ENTRIES = new Set([
  '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep', '.vscode', '.idea',
  '.agents', '.github', '.gitignore', '.gitattributes',
])

const STACK_GITIGNORE = Object.freeze({
  universal: [],
  node: ['node_modules/', '.pnpm-store/', 'dist/', 'build/', 'coverage/'],
  python: ['__pycache__/', '*.py[cod]', '.venv/', 'venv/', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', 'dist/', 'build/', '*.egg-info/'],
  go: ['bin/', 'dist/', 'coverage.out', '*.exe'],
  rust: ['target/'],
  java: ['out/', 'target/', 'build/', '*.class', '*.jar', '.gradle/'],
  ruby: ['vendor/bundle/', '.bundle/', 'coverage/'],
  php: ['vendor/', '.phpunit.result.cache'],
  dotnet: ['bin/', 'obj/', '*.user'],
  cpp: ['build/', 'out/', 'CMakeFiles/', 'CMakeCache.txt', '*.o', '*.a'],
  dart: ['.dart_tool/', 'build/', '.packages'],
  swift: ['.build/', '.swiftpm/', 'DerivedData/'],
  elixir: ['_build/', 'deps/', '.elixir_ls/'],
  docs: ['dist/', 'build/', '_site/'],
})

const STACK_RUNTIME_NOTE = Object.freeze({
  universal: '通用治理基线（待选定业务技术栈后由 `survey` / `Dev Profile` 自动接管）',
  node: 'Node.js（建议 18+，按实际 `package.json` 声明校准）',
  python: 'Python（按 `pyproject.toml` / `requirements*.txt` 校准）',
  go: 'Go（按 `go.mod` 校准）',
  rust: 'Rust（按 `Cargo.toml` 校准）',
  java: 'Java（按 `pom.xml` / `build.gradle*` 校准）',
  ruby: 'Ruby（按 `Gemfile` 校准）',
  php: 'PHP（按 `composer.json` 校准）',
  dotnet: '.NET（按 `.csproj` / `.sln` 校准）',
  cpp: 'C / C++（按 `CMakeLists.txt` 校准）',
  dart: 'Dart / Flutter（按 `pubspec.yaml` 校准）',
  swift: 'Swift（按 `Package.swift` / Xcode 工程校准）',
  elixir: 'Elixir（按 `mix.exs` 校准）',
  docs: '纯文档项目（无编译或运行时依赖）',
})

function isAllowedStarterEntry(name) {
  if (EMPTY_NOISE_ENTRIES.has(name) || isMacOsMetadata(name)) return true
  if (/^(?:README|LICENSE|COPYING)(?:\.[a-z0-9_-]+)?$/i.test(name)) return true
  return false
}

export function isNearlyEmptyDir(root) {
  if (!existsSync(root)) return { empty: true, blocking: [] }
  const blocking = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (isAllowedStarterEntry(entry.name)) continue
    blocking.push(entry.name)
  }
  return { empty: blocking.length === 0, blocking }
}

function sanitizeNames(rawName, targetDir) {
  const base = (rawName || basename(resolve(targetDir)) || 'starter-app').trim()
  const kebab = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'starter-app'
  return { display: base, kebab }
}

function localIsoDate(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const BASE_GITATTRIBUTES = [
  '# 统一文本行尾与常见二进制规则（需在首次提交前就位）',
  '* text=auto eol=lf',
  '',
  '*.bat text eol=crlf',
  '*.cmd text eol=crlf',
  '*.ps1 text eol=crlf',
  '',
  '*.png binary',
  '*.jpg binary',
  '*.jpeg binary',
  '*.gif binary',
  '*.ico binary',
  '*.webp binary',
  '*.pdf binary',
  '*.zip binary',
  '*.gz binary',
  '*.tgz binary',
  '*.7z binary',
  '*.woff binary',
  '*.woff2 binary',
  '*.ttf binary',
  '',
].join('\n')

const BASE_GITIGNORE = [
  '# Worktree、系统杂项与本地环境变量',
  '.worktrees/',
  '.DS_Store',
  '._*',
  'Thumbs.db',
  'desktop.ini',
  '.env',
  '.env.*',
  '!.env.example',
  '*.log',
  'tmp/',
  '.cache/',
]

function buildGitignore(stackEntries = []) {
  const extra = stackEntries.length > 0 ? ['', ...stackEntries] : []
  return [...BASE_GITIGNORE, ...extra, ''].join('\n')
}

function starterReadme({ names, summary, stack }) {
  return [
    `# ${names.display}`,
    '',
    summary,
    '',
    '## 快速开始',
    '',
    `- 基线配置：\`${stack}\`（工程边界与后续构建命令以 \`AGENTS.md\` 与 \`docs/TDD.md\` 为准）`,
    '- 待补齐真实源码或文档入口后，运行 `node scripts/compose-agents.mjs .`（或更新 `AGENTS.md` `Dev Profile`）同步命令契约。',
    '',
    '## 目录与文档导航',
    '',
    '- `AGENTS.md`：项目工程契约与研发流指令入口',
    '- `docs/TDD.md`：架构边界、`arch-rules` 与 Feature Map',
    '- `docs/{prd,specs,todo}/`：四层工程规划与任务追踪目录',
    '',
  ].join('\n')
}

function starterTdd({ names, summary, stack, today = localIsoDate() }) {
  const runtimeStack = STACK_RUNTIME_NOTE[stack] ?? STACK_RUNTIME_NOTE.universal
  return [
    `# ${names.display} 技术设计说明（TDD）`,
    '',
    '## 文档信息', '',
    '| 项目 | 内容 |', '| --- | --- |',
    '| 文档版本 | `0.1.0` |',
    `| 编制日期 | \`${today}\` |`,
    `| 最近更新日期 | \`${today}\` |`,
    `| 基线依据 | \`--bootstrap-empty --stack ${stack}\` 通用治理基线 |`,
    `| 运行环境与生态栈 | ${runtimeStack} |`,
    '| 托管平台适配范围 | GitHub（本地无远端同样完整运行） |',
    '| 关联工程契约 | `AGENTS.md` |', '',
    '## 目标与边界', '',
    `- ${summary}`,
    '- 初始化阶段仅落盘工程治理基线，未预设具体业务源码；真实模块入口就位后同步补充下表。', '',
    '## 系统拓扑', '',
    '```mermaid',
    'flowchart LR',
    '  Spec["需求规划"] --> Flow["隔离研发"]',
    '  Flow --> Gate["门禁验收"]',
    '```', '',
    '## 模块分层与禁引规则（arch-rules）', '',
    '- 当前为初始通用治理基线，暂无跨层禁引规则（`arch-rules: none`）。', '',
    '## 功能与入口地图（Feature Map）', '',
    '| 功能 / 能力 | 入口文件 | 说明 |',
    '| --- | --- | --- |',
    '| 工程契约 | `AGENTS.md` | 项目协作规范与 Dev Profile 入口 |',
    '| 架构设计基线 | `docs/TDD.md` | 系统边界、拓扑与模块映射说明 |',
    '| 项目说明入口 | `README.md` | 面向协作者的导航说明 |', '',
  ].join('\n')
}

/** 生成通用工程治理基线文件内容映射（零玩具业务源码）。 */
export function starterTemplates(stack = 'universal', rawName = '', description = '') {
  const effStack = stack || 'universal'
  const names = sanitizeNames(rawName, process.cwd())
  const summary = String(description ?? '').trim() || `${names.display} 通用工程治理与规范基线。`
  const extraIgnore = STACK_GITIGNORE[effStack] ?? []

  return {
    '.gitattributes': BASE_GITATTRIBUTES,
    '.gitignore': buildGitignore(extraIgnore),
    'README.md': starterReadme({ names, summary, stack: effStack }),
    'docs/TDD.md': starterTdd({ names, summary, stack: effStack }),
  }
}

function hydrateInitialAgentsDefaults(rendered, { displayName, stack }) {
  return String(rendered ?? '')
    .replace(
      /<!-- project-forge: fill 项目定位：[^\n]*-->/g,
      `${displayName}：已完成通用工程治理基线初始化（\`${stack}\` 栈；后续新增核心源码或构建配置后同步补齐模块说明）。`,
    )
    .replace(
      /quick-test:[^\n]*\nfull-test:[^\n]*\nsmoke-verify:[^\n]*\nmerge-gate:[^\n]*\narch-rules:[^\n]*\nhigh-risk:[^\n]*\ndo-not-edit:[^\n]*/m,
      [
        'quick-test: none',
        'full-test: none',
        'smoke-verify: none',
        'merge-gate: none',
        'arch-rules: none',
        'high-risk: AGENTS.md, docs/TDD.md',
        'do-not-edit: none',
      ].join('\n'),
    )
    .replace(/<!-- project-forge: fill Dev Profile：[^\n]*-->\n*/g, '')
    .replace(
      /<!-- project-forge: fill 模块入口：[^\n]*-->/g,
      '- 项目工程契约：`AGENTS.md`\n- 架构设计与 Feature Map：`docs/TDD.md`\n- 仓库说明入口：`README.md`',
    )
    .replace(
      /<!-- project-forge: fill 关键不变量：[^\n]*-->/g,
      '- 重要设计决策、模块边界与新增依赖变更须同步维护 `docs/TDD.md` 与 `AGENTS.md`。',
    )
    .replace(
      /本项目尚未在清单里声明标准命令。[^\n]*\n+<!-- project-forge: fill 构建与验证命令：[^\n]*-->\n```sh\n# [^\n]*\n```/m,
      '本项目当前为通用初始化基线，尚无构建与测试命令（真实源码与清单就位后替换为实际构建/测试命令）。',
    )
    .replace(/<!-- project-forge: fill 构建与验证命令：[^\n]*-->\n*/g, '')
    .replace(/<!-- project-forge: fill 项目特有红线：[^\n]*-->/g, '- 暂未追加额外项目特有红线（需要时直接在本节增补并删除本句）。')
    .replace(
      /<!-- project-forge: fill 高风险路径：[^\n]*-->/g,
      '- `AGENTS.md`：项目核心工程契约\n- `docs/TDD.md`：架构设计基线',
    )
    .replace(
      /\|\s*`<核心模块或公开契约>`\s*\|[^\n]*\n/g,
      '| `docs/TDD.md` | `AGENTS.md`（同步模块边界与 Dev Profile） |\n',
    )
    .replace(/<!-- project-forge: fill 改哪看哪：[^\n]*-->\n*/g, '')
    .replace(/\n{3,}/g, '\n\n')
}

export async function generateInitialBootstrappedAgents(root, { stack = 'universal', name, noBackup = false } = {}) {
  const agentsPath = join(root, 'AGENTS.md')
  if (existsSync(agentsPath)) return { created: false, skipped: true }
  const { survey } = await import('../survey.mjs')
  const { renderAgentsTemplate } = await import('../compose-agents.mjs')
  const { markerRegions } = await import('./protocol.mjs')
  const { regionBodySha } = await import('./agents-sections.mjs')

  const templatePath = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'agents-project.md')
  const template = readFileSync(templatePath, 'utf8').replace(/\r\n/g, '\n')
  const facts = await survey(root)
  const manifestPath = join(root, '.agents', 'skills', '.pf-manifest.json')
  const manifestRaw = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : null
  const manifestObj = manifestRaw ? JSON.parse(manifestRaw) : null
  const rendered = renderAgentsTemplate(facts, template, root, { manifest: manifestObj ? { data: manifestObj, invalid: false } : null })
  const finalAgents = hydrateInitialAgentsDefaults(rendered, { displayName: name || facts.target?.name || basename(root), stack })
  writeAtomic(agentsPath, finalAgents.endsWith('\n') ? finalAgents : `${finalAgents}\n`)

  if (manifestObj) {
    const lines = finalAgents.replace(/\r\n/g, '\n').split('\n')
    const { regions } = markerRegions(finalAgents, 'AGENTS.md')
    const nextRegions = {}
    for (const r of regions) nextRegions[r.id] = { sha256: regionBodySha(lines.slice(r.start + 1, r.end)) }
    manifestObj.agentsRegions = nextRegions
    writeAtomic(manifestPath, `${JSON.stringify(manifestObj, null, 2)}\n`)
  }
  return { created: true, bytes: Buffer.byteLength(finalAgents, 'utf8') }
}

/** 初始化空目录（或仅含 README/LICENSE/.github/.agents 等起步文件）的通用治理基线。 */
export function bootstrapEmpty(targetDir, {
  stack,
  lang,
  name,
  description = '',
  dryRun = false,
} = {}) {
  const root = resolve(targetDir)
  const effectiveStack = stack ?? lang ?? 'universal'
  if (!BOOTSTRAP_STACKS.has(effectiveStack)) {
    throw new Error(`--stack / --lang 必须是 ${[...BOOTSTRAP_STACKS].join(' | ')} 之一（收到：${effectiveStack}）`)
  }
  const check = isNearlyEmptyDir(root)
  if (!check.empty) {
    throw new Error(`目标目录非空（已存在：${check.blocking.slice(0, 5).join('、')}），拒绝执行 --bootstrap-empty`)
  }

  const names = sanitizeNames(name, root)
  const files = {
    ...starterTemplates(effectiveStack, names.display, description),
    'docs/prd/.gitkeep': '',
    'docs/specs/.gitkeep': '',
    'docs/todo/.gitkeep': '',
  }
  const created = []
  const skipped = []

  for (const [rel, content] of Object.entries(files)) {
    const dest = join(root, rel)
    if (existsSync(dest)) {
      skipped.push(rel)
      continue
    }
    created.push(rel)
    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true })
      writeAtomic(dest, String(content).replace(/\r\n/g, '\n'))
    }
  }

  let gitInitialized = false
  if (!dryRun && !existsSync(join(root, '.git'))) {
    let initRes = spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root, windowsHide: true })
    if (initRes.status !== 0) initRes = spawnSync('git', ['init', '-q'], { cwd: root, windowsHide: true })
    gitInitialized = initRes.status === 0
  }

  return {
    target: root,
    stack: effectiveStack,
    lang: effectiveStack,
    name: names.kebab,
    dryRun,
    gitInitialized,
    created,
    ...(skipped.length > 0 ? { skipped } : {}),
  }
}

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function isTextBuffer(buf) {
  if (buf.subarray(0, 8192).includes(0)) return false
  try { new TextDecoder('utf-8', { fatal: true }).decode(buf); return true } catch { return false }
}

export function normalizeWriteBuffer(buf) {
  if (!isTextBuffer(buf)) return buf
  return Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
}

export function normalizedSha256(buf) {
  return sha256Buffer(normalizeWriteBuffer(buf))
}

export function sortObjectKeys(obj) {
  const out = {}
  for (const k of Object.keys(obj ?? {}).sort()) out[k] = obj[k]
  return out
}

export function walkKitFiles(kitDir) {
  const map = new Map()
  if (!existsSync(kitDir)) return map
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.pf-manifest.json' || isMacOsMetadata(entry.name)) continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) { visit(abs); continue }
      if (!entry.isFile()) continue
      const buf = normalizeWriteBuffer(readFileSync(abs))
      map.set(posixPath(relative(kitDir, abs)), { abs, buf, sha256: sha256Buffer(buf) })
    }
  }
  visit(kitDir)
  return map
}

export function filterKitByTier(kitFiles, tier, lightweightSkills) {
  if (tier !== 'lightweight') return new Map(kitFiles)
  const allowedTops = new Set(['lib', ...lightweightSkills])
  const filtered = new Map()
  for (const [rel, item] of kitFiles.entries()) {
    if (allowedTops.has(rel.split('/')[0])) filtered.set(rel, item)
  }
  return filtered
}

export function normalizeStringArray(arr) {
  if (!Array.isArray(arr)) return []
  return [...new Set(arr.map((x) => posixPath(String(x ?? '')).replace(/^\/+|\/+$/g, '')).filter(Boolean))].sort()
}

export function normalizeRemovedFiles(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    const rel = posixPath(k).replace(/^\.agents\/skills\//, '').replace(/^\/+/, '')
    if (!rel) continue
    if (typeof v === 'string') out[rel] = { removedAt: v, baseSha256: null }
    else if (v && typeof v === 'object') {
      out[rel] = {
        removedAt: typeof v.removedAt === 'string' ? v.removedAt : '',
        baseSha256: typeof v.baseSha256 === 'string' ? v.baseSha256 : null,
      }
    }
  }
  return sortObjectKeys(out)
}

export function normalizeCustomizedFiles(obj) {
  const out = {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
  for (const [k, v] of Object.entries(obj)) {
    const rel = posixPath(k).replace(/^\.agents\/skills\//, '').replace(/^\/+/, '')
    if (!rel || !v || typeof v !== 'object' || typeof v.baseSha256 !== 'string' || !v.baseSha256) continue
    out[rel] = {
      adoptedAt: typeof v.adoptedAt === 'string' ? v.adoptedAt : '',
      baseSha256: v.baseSha256,
      upstreamSha256: typeof v.upstreamSha256 === 'string' ? v.upstreamSha256 : null,
    }
  }
  return sortObjectKeys(out)
}

export function readExistingManifest(manifestPath) {
  if (!existsSync(manifestPath)) return { exists: false, valid: false, data: undefined }
  const text = readTextSafe(manifestPath)
  if (!text) return { exists: true, valid: false, data: undefined }
  try {
    const parsed = JSON.parse(text)
    const valid = Boolean(
      parsed && typeof parsed === 'object' && (parsed.schemaVersion === 1 || parsed.schemaVersion === 2)
      && parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files),
    )
    return { exists: true, valid, data: valid ? parsed : undefined }
  } catch {
    return { exists: true, valid: false, data: undefined }
  }
}

export function normalizePrevFiles(filesObj) {
  const map = new Map()
  if (!filesObj || typeof filesObj !== 'object') return map
  for (const [k, v] of Object.entries(filesObj)) {
    const rel = posixPath(k)
    const hash = typeof v === 'string' ? v : v?.sha256
    if (rel && typeof hash === 'string' && hash) map.set(rel, hash)
  }
  return map
}

export function pruneEmptyParents(filePath, stopDir) {
  let cur = dirname(filePath)
  const stop = resolve(stopDir)
  while (cur.length > stop.length && cur.startsWith(stop)) {
    try {
      if (readdirSync(cur).length > 0) break
      rmdirSync(cur)
      cur = dirname(cur)
    } catch {
      break
    }
  }
}

