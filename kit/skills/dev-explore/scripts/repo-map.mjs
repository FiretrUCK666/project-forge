#!/usr/bin/env node
/**
 * repo-map.mjs —— 只读探索仓库结构、入口、测试分布、Dev Profile 与 git 热点文件。
 *
 * 用法：
 *   node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--focus <subdir>] [--json]
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import {
  gitRun, isMainModule, parseAgentsProfile, posixPath,
  printNextStep, readJsonSafe, resolveRepoRoots,
} from '../../lib/shared.mjs'

const SKIP_DIRS = new Set([
  '.git', '.worktrees', 'node_modules', '.pnpm-store', '.yarn',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache',
])

const CODE_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|rb|php|cs|c|cpp|h|hpp|swift|dart|ex|exs|sh|ps1)$/i
const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec)\/|(?:\.test\.|\.spec\.|_test\.|^test_)/i
const ENTRY_NAMES = new Set([
  'index.js', 'index.mjs', 'index.ts', 'main.js', 'main.mjs', 'main.ts',
  'app.js', 'app.ts', 'server.js', 'server.ts', 'cli.js', 'cli.mjs', 'cli.ts',
  'main.py', '__main__.py', 'app.py', 'main.go', 'main.rs', 'lib.rs', 'SKILL.md',
])

function walkRepoTree(root, focusRoot, maxDepth = 4) {
  const files = []
  const dirSummary = new Map()
  let truncated = false

  function visit(dir, depth) {
    if (files.length >= 6000) { truncated = true; return }
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = posixPath(relative(root, full))
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        const inFocus = focusRoot ? (rel === focusRoot || rel.startsWith(`${focusRoot}/`) || focusRoot.startsWith(`${rel}/`)) : true
        const limitDepth = focusRoot && (rel === focusRoot || rel.startsWith(`${focusRoot}/`)) ? maxDepth + 2 : maxDepth
        if (!inFocus && depth >= 1) continue
        if (depth < limitDepth) visit(full, depth + 1)
      } else if (entry.isFile()) {
        files.push({ rel, name: entry.name, full })
        const top = rel.includes('/') ? rel.split('/')[0] : '.'
        dirSummary.set(top, (dirSummary.get(top) ?? 0) + 1)
      }
    }
  }

  visit(root, 0)
  return { files, dirSummary, truncated }
}

function detectEntrypoints(root, files) {
  const entries = new Set()
  const pkg = readJsonSafe(join(root, 'package.json'))
  if (pkg) {
    if (typeof pkg.main === 'string') entries.add(posixPath(pkg.main.replace(/^\.\//, '')))
    if (typeof pkg.module === 'string') entries.add(posixPath(pkg.module.replace(/^\.\//, '')))
    if (typeof pkg.bin === 'string') entries.add(posixPath(pkg.bin.replace(/^\.\//, '')))
    else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const v of Object.values(pkg.bin)) {
        if (typeof v === 'string') entries.add(posixPath(v.replace(/^\.\//, '')))
      }
    }
    if (typeof pkg.exports === 'string') entries.add(posixPath(pkg.exports.replace(/^\.\//, '')))
  }

  for (const f of files) {
    if (ENTRY_NAMES.has(f.name) || /^(?:bin|cmd|scripts)\/[^/]+\.(?:js|mjs|ts|py|go|sh)$/i.test(f.rel)) {
      entries.add(f.rel)
    }
  }
  return [...entries].slice(0, 20)
}

function detectDocsPresence(root) {
  const scanDir = (relDir) => {
    const abs = join(root, relDir)
    if (!existsSync(abs)) return []
    try {
      return readdirSync(abs).filter((n) => n.endsWith('.md')).sort().map((n) => `${relDir}/${n}`)
    } catch { return [] }
  }
  return {
    agents: existsSync(join(root, 'AGENTS.md')),
    readme: existsSync(join(root, 'README.md')),
    tdd: existsSync(join(root, 'docs', 'TDD.md')),
    specs: scanDir('docs/specs'),
    todo: scanDir('docs/todo'),
    prd: scanDir('docs/prd'),
  }
}

async function detectHotspots(root, focus) {
  const args = ['log', '-n', '60', '--name-only', '--pretty=format:']
  if (focus) args.push('--', focus)
  const res = await gitRun(root, args)
  if (!res.ok || !res.stdout) return []
  const counts = new Map()
  for (const line of res.stdout.split('\n')) {
    const p = posixPath(line.trim())
    if (!p) continue
    counts.set(p, (counts.get(p) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([file, touches]) => ({ file, touches }))
}

export async function generateRepoMap(targetDir = process.cwd(), { focus } = {}) {
  const absTarget = resolve(targetDir)
  if (!existsSync(absTarget) || !statSync(absTarget).isDirectory()) {
    throw new Error(`目标目录不存在：${absTarget}`)
  }

  const roots = await resolveRepoRoots(absTarget)
  const root = roots.isGit ? roots.workTreeRoot : absTarget
  const focusRel = focus ? posixPath(focus).replace(/^\/+|\/+$/g, '') : undefined
  if (focusRel && !existsSync(join(root, focusRel))) {
    throw new Error(`--focus 指定的子目录不存在：${focusRel}`)
  }

  const [branchRes, hotspots] = await Promise.all([
    roots.isGit ? gitRun(root, ['symbolic-ref', '--short', 'HEAD']) : Promise.resolve({ ok: false, stdout: '' }),
    roots.isGit ? detectHotspots(root, focusRel) : Promise.resolve([]),
  ])

  const profile = parseAgentsProfile(root)
  const { files, dirSummary, truncated } = walkRepoTree(root, focusRel)
  const codeFiles = files.filter((f) => CODE_RE.test(f.name))
  const testFiles = files.filter((f) => TEST_FILE_RE.test(f.rel)).map((f) => f.rel)
  const entrypoints = detectEntrypoints(root, files)
  const docs = detectDocsPresence(root)

  const focusAgents = focusRel && existsSync(join(root, focusRel, 'AGENTS.md'))
    ? `${focusRel}/AGENTS.md` : null
  const focusFiles = focusRel
    ? files.filter((f) => f.rel === focusRel || f.rel.startsWith(`${focusRel}/`)).map((f) => f.rel).slice(0, 60)
    : []

  return {
    root,
    name: basename(root),
    isGit: roots.isGit,
    branch: branchRes.ok ? branchRes.stdout.trim() : null,
    focus: focusRel ?? null,
    focusAgents,
    focusFiles,
    truncated,
    totalFiles: files.length,
    codeFileCount: codeFiles.length,
    testFileCount: testFiles.length,
    topDirectories: [...dirSummary.entries()].map(([dir, count]) => ({ dir, count })),
    entrypoints,
    testFiles: testFiles.slice(0, 30),
    devProfile: {
      quickTest: profile.quickTest ?? null,
      fullTest: profile.fullTest ?? null,
      mergeGate: profile.mergeGate ?? null,
      highRisk: profile.highRisk,
      doNotEdit: profile.doNotEdit,
      ecosystems: profile.detectedCommands?.kinds ?? [],
    },
    docs,
    hotspots,
  }
}

function formatText(map) {
  const lines = []
  lines.push(`# 仓库地图：${map.name}`)
  lines.push(`- 路径: ${map.root}`)
  lines.push(`- Git: ${map.isGit ? `是（分支: ${map.branch ?? 'detached'}）` : '否'} | 生态: ${map.devProfile.ecosystems.join(', ') || '未识别'}`)
  lines.push(`- 文件统计: 共 ${map.totalFiles}${map.truncated ? '+' : ''} 个（源码 ${map.codeFileCount}，测试 ${map.testFileCount}）`)
  lines.push('')
  lines.push('## Dev Profile 与验证命令')
  lines.push(`- quick-test: ${map.devProfile.quickTest ?? '未配置'}`)
  lines.push(`- full-test: ${map.devProfile.fullTest ?? '未配置'}`)
  lines.push(`- merge-gate: ${map.devProfile.mergeGate ?? '未配置'}`)
  lines.push(`- high-risk: ${map.devProfile.highRisk.join(', ') || '无'}`)
  if (map.devProfile.doNotEdit.length > 0) {
    lines.push(`- do-not-edit: ${map.devProfile.doNotEdit.join(', ')}`)
  }
  lines.push('')
  lines.push('## 顶层目录分布')
  for (const d of map.topDirectories) {
    lines.push(`- ${d.dir}: ${d.count} 个文件`)
  }
  if (map.entrypoints.length > 0) {
    lines.push('')
    lines.push('## 探测到的入口文件')
    for (const e of map.entrypoints) lines.push(`- ${e}`)
  }
  if (map.focus) {
    lines.push('')
    lines.push(`## 聚焦子目录 (${map.focus})`)
    if (map.focusAgents) lines.push(`- 局部契约: ${map.focusAgents}`)
    for (const f of map.focusFiles) lines.push(`- ${f}`)
  }
  if (map.testFiles.length > 0) {
    lines.push('')
    lines.push('## 测试文件（前 30 项）')
    for (const t of map.testFiles) lines.push(`- ${t}`)
  }
  lines.push('')
  lines.push('## 工程文档现状')
  lines.push(`- AGENTS.md: ${map.docs.agents ? '有' : '无'} | docs/TDD.md: ${map.docs.tdd ? '有' : '无'} | specs: ${map.docs.specs.length} | todo: ${map.docs.todo.length}`)
  if (map.hotspots.length > 0) {
    lines.push('')
    lines.push('## 近期修改热点（git log 前 10）')
    for (const h of map.hotspots) lines.push(`- ${h.file} (${h.touches} 次)`)
  }
  return `${lines.join('\n')}\n`
}

function parseArgs(argv) {
  let targetDir = process.cwd()
  let focus
  let json = false
  let help = false

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') help = true
    else if (a === '--json') json = true
    else if (a === '--focus') { focus = argv[i + 1]; i += 1 }
    else if (a.startsWith('--focus=')) focus = a.slice('--focus='.length)
    else if (!a.startsWith('-')) targetDir = a
    else throw new Error(`未知参数：${a}`)
  }
  return { targetDir, focus, json, help }
}

async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return 2
  }
  if (opts.help) {
    process.stdout.write([
      '用法：node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--focus <subdir>] [--json]',
      '',
      '只读输出仓库目录结构、入口、Dev Profile 命令、测试分布与近期修改热点。',
    ].join('\n') + '\n')
    return 0
  }

  try {
    const map = await generateRepoMap(opts.targetDir, { focus: opts.focus })
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(map, null, 2)}\n`)
    } else {
      process.stdout.write(formatText(map))
      printNextStep([
        '若需基于探索结果立项或改动，先运行环境探测与五档分流：',
        'node ".agents/skills/dev-flow/scripts/flow.mjs" inspect',
        'node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<任务摘要>"',
      ])
    }
    return 0
  } catch (err) {
    process.stderr.write(`探索失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
