#!/usr/bin/env node
/**
 * repo-map.mjs —— 只读探索仓库结构、入口、CI 步骤、可复用模块、Feature Map 与 git 热点。
 *
 * 用法：
 *   node .agents/skills/dev-explore/scripts/repo-map.mjs [targetDir] [--focus <subdir>] [--json]
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'

import {
  gitRun, isMainModule, parseAgentsProfile, posixPath,
  printNextStep, readJsonSafe, readTextSafe, resolveRepoRoots,
} from '../../lib/shared.mjs'

const SKIP_DIRS = new Set([
  '.git', '.worktrees', 'node_modules', '.pnpm-store', '.yarn',
  '.venv', 'venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache',
  'dist', 'build', 'out', 'target', 'coverage', '.next', '.nuxt', '.cache',
])

const CODE_RE = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rs|go|java|kt|rb|php|cs|c|cpp|h|hpp|swift|dart|ex|exs|sh|ps1)$/i
const TEST_FILE_RE = /(?:^|\/)(?:tests?|__tests__|spec|specs)\/|(?:\.test\.|\.spec\.|_test\.|^test_)/i
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
    for (const field of [pkg.main, pkg.module, pkg.exports]) {
      if (typeof field === 'string') entries.add(posixPath(field.replace(/^\.\//, '')))
    }
    if (typeof pkg.bin === 'string') entries.add(posixPath(pkg.bin.replace(/^\.\//, '')))
    else if (pkg.bin && typeof pkg.bin === 'object') {
      for (const v of Object.values(pkg.bin)) {
        if (typeof v === 'string') entries.add(posixPath(v.replace(/^\.\//, '')))
      }
    }
  }

  for (const f of files) {
    if (ENTRY_NAMES.has(f.name) || /^(?:bin|cmd|scripts)\/[^/]+\.(?:js|mjs|ts|py|go|sh)$/i.test(f.rel)) {
      entries.add(f.rel)
    }
  }
  return [...entries].slice(0, 25)
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

/** 解析 .github/workflows/*.{yml,yaml} 中的 job 与 run 步骤。 */
function extractCiRunSteps(root) {
  const wfDir = join(root, '.github', 'workflows')
  if (!existsSync(wfDir)) return []
  let entries = []
  try {
    entries = readdirSync(wfDir).filter((n) => /\.(?:yml|yaml)$/i.test(n)).sort()
  } catch { return [] }

  const steps = []
  for (const file of entries) {
    const rel = `.github/workflows/${file}`
    const text = readTextSafe(join(wfDir, file))
    if (!text) continue
    const wfName = /^name:\s*["']?([^"'\n]+)["']?/m.exec(text)?.[1]?.trim() ?? file
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i += 1) {
      const m = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(lines[i])
      if (!m) continue
      const baseIndent = m[1].length + (lines[i].includes('- run:') ? 2 : 0)
      const rhs = m[2].trim()

      let cmdLines = []
      if (rhs === '|' || rhs === '|-' || rhs === '>' || rhs === '>-') {
        for (let j = i + 1; j < lines.length; j += 1) {
          const cur = lines[j]
          if (cur.trim() === '') continue
          const curIndent = /^(\s*)/.exec(cur)?.[1].length ?? 0
          if (curIndent <= baseIndent) break
          const cleaned = cur.trim()
          if (cleaned && !cleaned.startsWith('#')) cmdLines.push(cleaned)
        }
      } else if (rhs) {
        cmdLines.push(rhs)
      }

      if (cmdLines.length > 0) {
        steps.push({
          workflow: wfName,
          file: rel,
          command: cmdLines.join(' && '),
        })
      }
    }
  }
  return steps.slice(0, 40)
}

/** 提取 Makefile / justfile / package.json 中的可运行任务入口。 */
function extractTaskRunners(root) {
  const runners = { makefile: [], justfile: [], npmScripts: [] }

  for (const mkName of ['Makefile', 'GNUmakefile', 'makefile']) {
    const mkText = readTextSafe(join(root, mkName))
    if (!mkText) continue
    for (const m of mkText.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)) {
      const target = m[1]
      if (target.startsWith('.')) continue
      if (!runners.makefile.includes(target)) runners.makefile.push(target)
    }
    break
  }

  for (const jfName of ['justfile', 'Justfile']) {
    const jfText = readTextSafe(join(root, jfName))
    if (!jfText) continue
    for (const m of jfText.matchAll(/^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:/gm)) {
      const target = m[1]
      if (!runners.justfile.includes(target)) runners.justfile.push(target)
    }
    break
  }

  const pkg = readJsonSafe(join(root, 'package.json'))
  if (pkg?.scripts && typeof pkg.scripts === 'object') {
    for (const [k, v] of Object.entries(pkg.scripts)) {
      runners.npmScripts.push({ name: k, command: String(v) })
    }
  }
  return runners
}

/** 扫描潜在可复用共享模块与公开导出符号，抑制重复造轮子。 */
function extractReusableModules(root, files) {
  const candidates = files.filter((f) => {
    if (!CODE_RE.test(f.name) || TEST_FILE_RE.test(f.rel)) return false
    return /(?:^|\/)(?:lib|shared|utils?|helpers?|common|core)\//i.test(f.rel)
      || /(?:shared|utils?|helpers?|common|protocol|template|render)\.[^/]+$/i.test(f.name)
  })

  const out = []
  for (const item of candidates.slice(0, 60)) {
    const text = readTextSafe(item.full, 256 * 1024)
    if (!text) continue
    const exportsList = []
    for (const m of text.matchAll(/^(?:export\s+(?:async\s+)?(?:function|const|class)|pub\s+(?:fn|struct)|func|def)\s+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
      if (!m[1].startsWith('_') && !exportsList.includes(m[1])) exportsList.push(m[1])
    }
    if (exportsList.length > 0 || /(?:^|\/)lib\//.test(item.rel)) {
      out.push({
        file: item.rel,
        exports: exportsList.slice(0, 12),
        exportCount: exportsList.length,
      })
    }
  }
  return out.sort((a, b) => b.exportCount - a.exportCount || a.file.localeCompare(b.file)).slice(0, 20)
}

/** 构造 Feature Map：整合 docs/TDD.md 现有映射 + 自动嗅探到的入口/脚本到测试/冒烟命令映射。 */
function buildFeatureMap(root, entrypoints, testFiles, profile, runners) {
  const features = []
  const seen = new Set()

  // 1. 优先读取 docs/TDD.md 中声明的 Feature Map 表格行
  const tddText = readTextSafe(join(root, 'docs', 'TDD.md'))
  if (tddText) {
    const fmIdx = tddText.search(/^##.*(?:Feature\s*Map|功能与入口地图|模块拓扑)/mi)
    if (fmIdx >= 0) {
      const slice = tddText.slice(fmIdx)
      for (const line of slice.split('\n').slice(1, 35)) {
        if (/^##\s+/.test(line)) break
        const row = /^\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/.exec(line.trim())
        if (!row) continue
        const c1 = row[1].trim().replace(/`/g, '')
        const c2 = row[2].trim().replace(/`/g, '')
        const c3 = row[3].trim().replace(/`/g, '')
        if (!c1 || /^[-:]+$/.test(c1) || /功能|模块|Feature|Entry/i.test(c1) || /^<.*>$/.test(c1)) continue
        const key = `${c1}=>${c2}`
        if (!seen.has(key)) {
          seen.add(key)
          features.push({ feature: c1, source: c2, verifyCmd: c3 || profile.smokeVerify || profile.quickTest || '待补充', origin: 'docs/TDD.md' })
        }
      }
    }
  }

  // 2. 自动为入口文件配对最相近的测试文件或验证命令
  for (const ep of entrypoints.slice(0, 15)) {
    const epBase = basename(ep).replace(/\.[^.]+$/, '')
    const matchedTest = testFiles.find((t) => t.toLowerCase().includes(epBase.toLowerCase()))
    const verifyCmd = matchedTest
      ? (profile.quickTest?.includes('{target}') ? profile.quickTest.replace(/\{target\}/g, matchedTest) : `${matchedTest} (或 ${profile.quickTest ?? '项目单测'})`)
      : (profile.smokeVerify ?? profile.quickTest ?? (runners.npmScripts[0]?.name ? `npm run ${runners.npmScripts[0].name}` : null))
    const key = `${epBase}=>${ep}`
    if (!seen.has(key)) {
      seen.add(key)
      features.push({
        feature: epBase,
        source: ep,
        verifyCmd: verifyCmd ?? '未配置（建议补充 smoke-verify）',
        origin: 'detected-entry',
      })
    }
  }

  return features.slice(0, 20)
}

function buildPreferredVerifyCommands(profile, ciRunSteps, runners) {
  const list = []
  const add = (role, cmd, source) => {
    if (!cmd) return
    if (list.some((x) => x.command === cmd && x.role === role)) return
    list.push({ role, command: cmd, source })
  }
  add('quick-test', profile.quickTest, profile.hasAgents ? 'AGENTS.md/auto' : 'auto')
  add('smoke-verify', profile.smokeVerify, 'AGENTS.md')
  add('full-test', profile.fullTest, 'AGENTS.md/auto')
  add('merge-gate', profile.mergeGate, 'AGENTS.md/auto')
  for (const step of ciRunSteps) {
    if (/\b(?:test|check|verify|lint|smoke|preflight|build)\b/i.test(step.command)) {
      add('ci-check', step.command, step.file)
    }
  }
  for (const mk of runners.makefile) {
    if (/^(?:test|check|smoke|lint|verify|build)$/i.test(mk)) add('make-target', `make ${mk}`, 'Makefile')
  }
  for (const jf of runners.justfile) {
    if (/^(?:test|check|smoke|lint|verify|build)$/i.test(jf)) add('just-target', `just ${jf}`, 'justfile')
  }
  return list.slice(0, 15)
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
  const ciRunSteps = extractCiRunSteps(root)
  const taskRunners = extractTaskRunners(root)
  const reusableModules = extractReusableModules(root, files)
  const featureMap = buildFeatureMap(root, entrypoints, testFiles, profile, taskRunners)
  const preferredVerifyCommands = buildPreferredVerifyCommands(profile, ciRunSteps, taskRunners)

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
      smokeVerify: profile.smokeVerify ?? null,
      mergeGate: profile.mergeGate ?? null,
      archRules: profile.archRules,
      highRisk: profile.highRisk,
      doNotEdit: profile.doNotEdit,
      ecosystems: profile.detectedCommands?.kinds ?? [],
    },
    ciRunSteps,
    taskRunners,
    preferredVerifyCommands,
    reusableModules,
    featureMap,
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
  lines.push('## Dev Profile 与优先验证入口')
  lines.push(`- quick-test: ${map.devProfile.quickTest ?? '未配置'}`)
  lines.push(`- smoke-verify: ${map.devProfile.smokeVerify ?? '未配置'}`)
  lines.push(`- full-test: ${map.devProfile.fullTest ?? '未配置'}`)
  lines.push(`- merge-gate: ${map.devProfile.mergeGate ?? '未配置'}`)
  lines.push(`- high-risk: ${map.devProfile.highRisk.join(', ') || '无'}`)
  if (map.devProfile.archRules.length > 0) {
    lines.push(`- arch-rules: ${map.devProfile.archRules.map((r) => r.raw).join('; ')}`)
  }
  if (map.devProfile.doNotEdit.length > 0) {
    lines.push(`- do-not-edit: ${map.devProfile.doNotEdit.join(', ')}`)
  }
  if (map.ciRunSteps.length > 0) {
    lines.push('')
    lines.push('## CI 工作流验证步骤（.github/workflows）')
    for (const s of map.ciRunSteps.slice(0, 12)) {
      lines.push(`- [${s.file}] ${s.command}`)
    }
  }
  if (map.taskRunners.makefile.length > 0 || map.taskRunners.justfile.length > 0) {
    lines.push('')
    lines.push('## 任务脚本入口（Makefile / justfile）')
    if (map.taskRunners.makefile.length > 0) lines.push(`- Makefile: ${map.taskRunners.makefile.join(', ')}`)
    if (map.taskRunners.justfile.length > 0) lines.push(`- justfile: ${map.taskRunners.justfile.join(', ')}`)
  }
  lines.push('')
  lines.push('## 顶层目录分布')
  for (const d of map.topDirectories) {
    lines.push(`- ${d.dir}: ${d.count} 个文件`)
  }
  if (map.reusableModules.length > 0) {
    lines.push('')
    lines.push('## 可复用现成模块清单（先复用，不重复造轮子）')
    for (const m of map.reusableModules) {
      lines.push(`- ${m.file}${m.exports.length > 0 ? ` [导出: ${m.exports.join(', ')}]` : ''}`)
    }
  }
  if (map.featureMap.length > 0) {
    lines.push('')
    lines.push('## Feature Map（入口 -> 源码 -> 验证）')
    for (const fm of map.featureMap) {
      lines.push(`- ${fm.feature}: ${fm.source} -> ${fm.verifyCmd}`)
    }
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
      '只读输出仓库目录结构、入口、Dev Profile 命令、CI 步骤、可复用模块、Feature Map 与热点文件。',
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
