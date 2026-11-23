/**
 * repo-map-helpers.mjs —— 从 `repo-map.mjs` 拆出的 CI 步骤、任务入口、Feature Map、业务流与报告格式化辅助。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块与 `kit/skills/lib/`）。
 */

import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

import { isNonFeatureArtifactPath, matchTestsForSourceFile } from '../../lib/feature-map.mjs'
import { readJsonSafe, readTextSafe } from '../../lib/git.mjs'
import { isProfileExplicitNone } from '../../lib/profile.mjs'
import { isTestOrFixtureFile } from '../../lib/static-gates.mjs'
import { isToolOwnedPath } from '../../lib/tool-owned.mjs'

/** 解析 .github/workflows/*.{yml,yaml} 中的 job、working-directory 与多行 run 脚本。 */
export function extractCiRunSteps(root, readdirSyncFn) {
  const wfDir = join(root, '.github', 'workflows')
  const steps = []
  if (existsSync(wfDir)) {
    let entries = []
    try { entries = readdirSyncFn(wfDir).filter((n) => /\.(?:yml|yaml)$/i.test(n)).sort() } catch { entries = [] }
    for (const file of entries) {
      const rel = `.github/workflows/${file}`
      const text = readTextSafe(join(wfDir, file))
      if (!text) continue
      const wfName = /^name:\s*["']?([^"'\n]+)["']?/m.exec(text)?.[1]?.trim() ?? file
      const lines = text.split('\n')
      let currentJob = null; let jobWorkingDir = null; let inJobs = false; let inJobDefaultsRun = false
      let curStepName = null; let curStepWorkingDir = null; let stepBaseIndent = -1

      for (let i = 0; i < lines.length; i += 1) {
        const rawLine = lines[i]
        const trimmed = rawLine.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const indent = rawLine.length - rawLine.trimStart().length

        if (indent === 0 && /^jobs\s*:/.test(trimmed)) { inJobs = true; continue }
        if (indent === 0 && /^[A-Za-z0-9_-]+\s*:/.test(trimmed)) { inJobs = false; inJobDefaultsRun = false }
        if (inJobs && indent === 2 && /^([A-Za-z0-9_-]+)\s*:/.test(trimmed)) {
          currentJob = /^([A-Za-z0-9_-]+)\s*:/.exec(trimmed)[1]
          jobWorkingDir = null; inJobDefaultsRun = false; curStepName = null; curStepWorkingDir = null; stepBaseIndent = -1
          continue
        }
        if (inJobs && indent >= 4 && /^defaults\s*:/.test(trimmed)) { inJobDefaultsRun = false; continue }
        if (inJobs && indent >= 6 && /^run\s*:\s*$/.test(trimmed)) { inJobDefaultsRun = true; continue }
        if (inJobDefaultsRun) {
          const wdM = /^working-directory\s*:\s*["']?([^"'\n]+)["']?/.exec(trimmed)
          if (wdM) { jobWorkingDir = wdM[1].trim(); continue }
          if (indent <= 4) inJobDefaultsRun = false
        }
        if (/^\s*-\s+/.test(rawLine) && (stepBaseIndent === -1 || indent <= stepBaseIndent)) {
          stepBaseIndent = indent; curStepName = null; curStepWorkingDir = null
        } else if (stepBaseIndent >= 0 && indent < stepBaseIndent) {
          curStepName = null; curStepWorkingDir = null; stepBaseIndent = -1
        }
        const nameM = /^\s*(?:-\s+)?name\s*:\s*["']?([^"'\n]+)["']?/.exec(rawLine)
        if (nameM) curStepName = nameM[1].trim()
        const stepWdM = /^\s*(?:-\s+)?working-directory\s*:\s*["']?([^"'\n]+)["']?/.exec(rawLine)
        if (stepWdM) { curStepWorkingDir = stepWdM[1].trim(); continue }

        const runM = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(rawLine)
        if (!runM) continue
        const baseIndent = runM[1].length + (rawLine.includes('- run:') ? 2 : 0)
        const rhs = runM[2].trim()
        let scriptText = ''
        if (rhs === '|' || rhs === '|-' || rhs === '>' || rhs === '>-') {
          const blockLines = []
          let blockIndent = null
          for (let j = i + 1; j < lines.length; j += 1) {
            const cur = lines[j]
            if (cur.trim() === '') { blockLines.push(''); continue }
            const curIndent = /^(\s*)/.exec(cur)?.[1].length ?? 0
            if (curIndent <= baseIndent) break
            if (blockIndent === null) blockIndent = curIndent
            blockLines.push(cur.slice(Math.min(blockIndent, curIndent)))
            i = j
          }
          scriptText = blockLines.filter((l) => l.trim() && !l.trim().startsWith('#')).join('\n').trim()
        } else if (rhs) {
          scriptText = rhs.replace(/\s+#.*$/, '').trim()
        }
        if (scriptText) {
          steps.push({
            workflow: wfName, job: currentJob, stepName: curStepName,
            workingDirectory: curStepWorkingDir ?? jobWorkingDir ?? null, file: rel, command: scriptText,
          })
        }
      }
    }
  }
  for (const extraCi of ['.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml']) {
    if (existsSync(join(root, extraCi))) {
      steps.push({ workflow: basename(extraCi), job: null, stepName: 'ci-config', workingDirectory: null, file: extraCi, command: `(detected ${extraCi})` })
    }
  }
  return steps.slice(0, 50)
}

/** 提取根级与各子包 Makefile / justfile / Taskfile / package.json 中的可运行任务入口。 */
export function extractTaskRunners(root, packages) {
  const runners = { makefile: [], justfile: [], taskfile: [], npmScripts: [], subpackages: [] }
  for (const mkName of ['Makefile', 'GNUmakefile', 'makefile']) {
    const mkText = readTextSafe(join(root, mkName))
    if (!mkText) continue
    for (const m of mkText.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)) {
      if (!m[1].startsWith('.') && !runners.makefile.includes(m[1])) runners.makefile.push(m[1])
    }
    break
  }
  for (const jfName of ['justfile', 'Justfile', '.justfile']) {
    const jfText = readTextSafe(join(root, jfName))
    if (!jfText) continue
    for (const m of jfText.matchAll(/^@?([A-Za-z0-9_-]+)(?:\s+[^:\n]*)?:(?!=)/gm)) {
      if (!runners.justfile.includes(m[1])) runners.justfile.push(m[1])
    }
    break
  }
  for (const tfName of ['Taskfile.yml', 'Taskfile.yaml']) {
    const tfText = readTextSafe(join(root, tfName))
    if (!tfText) continue
    const tasksSec = /\ntasks:\s*\n([\s\S]*?)(?:\n[a-z]+:|\s*$)/.exec(`\n${tfText}`)
    if (tasksSec) {
      for (const m of tasksSec[1].matchAll(/^ {2}([A-Za-z0-9_.-]+)\s*:/gm)) {
        if (!runners.taskfile.includes(m[1])) runners.taskfile.push(m[1])
      }
    }
    break
  }
  const rootPkg = readJsonSafe(join(root, 'package.json'))
  if (rootPkg?.scripts && typeof rootPkg.scripts === 'object') {
    for (const [k, v] of Object.entries(rootPkg.scripts)) runners.npmScripts.push({ name: k, command: String(v) })
  }
  for (const pkg of packages) {
    if (!pkg.dirRel) continue
    const nodeCmds = pkg.commands?.node
    if (nodeCmds?.scripts?.length) runners.subpackages.push({ dir: pkg.dirRel, ecosystem: 'node', scripts: nodeCmds.scripts })
    for (const [eco, cmdObj] of Object.entries(pkg.commands)) {
      if (eco !== 'node' && cmdObj?.quickTest) runners.subpackages.push({ dir: pkg.dirRel, ecosystem: eco, quickTest: cmdObj.quickTest })
    }
  }
  return runners
}

function extractFeatureTableCellPaths(root, rawCell) {
  const cleaned = String(rawCell ?? '').replace(/`/g, ' ').replace(/\r?\n/g, ' ')
  const tokens = cleaned.split(/[\s,，;；()[\]]+/).map((t) => t.trim()).filter(Boolean)
  const paths = []
  const symbols = []
  const seen = new Set()
  for (const tok of tokens) {
    const colonParts = tok.split('::')
    const baseTok = colonParts[0]
    const cand = baseTok
      .replace(/^\.\//, '')
      .replace(/^\/+/, '')
      .replace(/(?:#L\d+(?:-L?\d+)?|:\d+(?::\d+)?)$/, '')
    if (!cand || cand.includes('..') || /^https?:/i.test(cand) || /[<>*?]/.test(cand)) continue
    if (existsSync(join(root, cand))) {
      if (!seen.has(cand)) { seen.add(cand); paths.push(cand) }
      if (colonParts[1]) symbols.push(colonParts.slice(1).join('::'))
    } else if (/^[A-Za-z_][A-Za-z0-9_.:]*(?:\([^)]*\))?$/.test(tok)) {
      symbols.push(tok)
    }
  }
  return { paths, symbols: [...new Set(symbols)] }
}

export function buildFeatureMap(root, entrypoints, testFiles, profile, runners, packages) {
  const features = []
  const seen = new Set()
  const tddText = readTextSafe(join(root, 'docs', 'TDD.md'))
  if (tddText) {
    const fmIdx = tddText.search(/^##.*(?:Feature\s*Map|功能与入口地图|模块拓扑)/mi)
    if (fmIdx >= 0) {
      for (const line of tddText.slice(fmIdx).split('\n').slice(1, 40)) {
        if (/^##\s+/.test(line)) break
        const row = /^\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/.exec(line.trim())
        if (!row) continue
        const [c1, c2, c3] = [row[1], row[2], row[3]].map((s) => s.trim().replace(/`/g, ''))
        if (!c1 || /^[-:]+$/.test(c1) || /功能|模块|Feature|Entry/i.test(c1) || /^<.*>$/.test(c1)) continue
        const extracted = extractFeatureTableCellPaths(root, row[2])
        if (extracted.paths.length === 0) continue
        const primary = extracted.paths[0]
        const key = `${c1}=>${primary}`
        if (!seen.has(key)) {
          seen.add(key)
          features.push({
            feature: c1,
            source: primary,
            ...(extracted.paths.length > 1 ? { sources: extracted.paths } : {}),
            ...(extracted.symbols.length > 0 ? { symbols: extracted.symbols } : {}),
            verifyCmd: c3 || profile.smokeVerify || profile.quickTest || '待补充',
            origin: 'docs/TDD.md',
          })
        }
      }
    }
  }
  for (const ep of entrypoints.slice(0, 18)) {
    if (isNonFeatureArtifactPath(ep)) continue
    const epBase = basename(ep).replace(/\.[^.]+$/, '')
    const matchedTest = matchTestsForSourceFile(ep, testFiles)[0]
    const matchedPkg = packages.filter((p) => p.dirRel && ep.startsWith(`${p.dirRel}/`)).sort((a, b) => b.dirRel.length - a.dirRel.length)[0]
    const pkgCmd = matchedPkg ? Object.values(matchedPkg.commands).find((c) => c?.quickTest)?.quickTest : null
    const verifyCmd = matchedTest
      ? (profile.quickTest?.includes('{target}') ? profile.quickTest.replace(/\{target\}/g, matchedTest) : `${matchedTest} (或 ${pkgCmd ?? profile.quickTest ?? '项目单测'})`)
      : (pkgCmd ?? profile.smokeVerify ?? profile.quickTest ?? (runners.npmScripts[0]?.name ? `npm run ${runners.npmScripts[0].name}` : null))
    const key = `${epBase}=>${ep}`
    if (!seen.has(key)) {
      seen.add(key)
      features.push({
        feature: epBase, source: ep,
        verifyCmd: verifyCmd ?? (isProfileExplicitNone(profile, 'quick-test') ? 'none (explicit)' : '未配置（建议补充 smoke-verify）'),
        origin: 'detected-entry',
      })
    }
  }
  return features.slice(0, 25)
}

export function buildPreferredVerifyCommands(profile, ciRunSteps, runners, packages) {
  const list = []
  const add = (role, cmd, source, workingDirectory = null) => {
    if (!cmd || list.some((x) => x.command === cmd && x.role === role && x.workingDirectory === workingDirectory)) return
    list.push({ role, command: cmd, source, ...(workingDirectory ? { workingDirectory } : {}) })
  }
  add('quick-test', profile.quickTest, profile.hasAgents ? 'AGENTS.md/auto' : 'auto')
  add('smoke-verify', profile.smokeVerify, 'AGENTS.md')
  add('full-test', profile.fullTest, 'AGENTS.md/auto')
  add('merge-gate', profile.mergeGate, 'AGENTS.md/auto')
  for (const step of ciRunSteps) {
    if (/\b(?:test|check|verify|lint|smoke|preflight|build|mvn|gradle|pytest|cargo|go)\b/i.test(step.command)) {
      add('ci-check', step.command, step.file, step.workingDirectory ?? null)
    }
  }
  for (const pkg of packages) {
    if (!pkg.dirRel) continue
    for (const c of Object.values(pkg.commands)) {
      if (c?.quickTest) add('package-test', c.quickTest, `${pkg.dirRel}/`, pkg.dirRel)
    }
  }
  const targetRe = /^(?:test|check|smoke|lint|verify|build)$/i
  for (const mk of runners.makefile) if (targetRe.test(mk)) add('make-target', `make ${mk}`, 'Makefile')
  for (const jf of runners.justfile) if (targetRe.test(jf)) add('just-target', `just ${jf}`, 'justfile')
  for (const tf of runners.taskfile) if (targetRe.test(tf)) add('task-target', `task ${tf}`, 'Taskfile.yml')
  return list.slice(0, 25)
}

export function buildBusinessFlows(root, files, entrypoints, cliEntrypoints) {
  const nonTool = files.filter((f) => !isToolOwnedPath(f.rel) && !isTestOrFixtureFile(f.rel) && !/^(?:dist|build|coverage)\//i.test(f.rel))
  const fileSet = new Set(files.map((f) => f.rel))
  const routes = nonTool
    .filter((f) => /(?:^|\/)(?:routes?|routers?|controllers?|handlers?|endpoints?|pages\/api)\//i.test(f.rel)
      || /(?:^|\/)(?:openapi|swagger)\.(?:ya?ml|json)$/i.test(f.rel) || /\.proto$/i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const ui = nonTool
    .filter((f) => /\.(?:tsx|jsx|vue|svelte|astro)$/i.test(f.rel)
      || /(?:^|\/)(?:pages|screens|views|app)\/[^/]+\.(?:tsx|jsx|vue|svelte|html)$/i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const jobs = nonTool
    .filter((f) => /(?:^|\/)(?:jobs?|workers?|queues?|cron|schedules?|pipelines?)\//i.test(f.rel))
    .map((f) => f.rel).slice(0, 15)
  const cli = cliEntrypoints.length > 0
    ? cliEntrypoints
    : entrypoints.filter((ep) => /(?:^|\/)(?:cmd|bin|cli)\//i.test(ep) || ep === 'SKILL.md')
        .map((ep) => ({ ecosystem: 'generic', name: basename(ep), file: ep }))

  const audienceCues = []
  let primaryDocText = ''
  for (const cand of ['README.md', 'README.zh-CN.md', 'README.en.md', 'ARCHITECTURE.md', 'docs/TDD.md']) {
    const txt = readTextSafe(join(root, cand))
    if (!txt) continue
    primaryDocText += `\n${txt}`
    if (audienceCues.length === 0) {
      const lead = txt.split('\n').map((l) => l.trim()).find((l) => l && !/^(?:#|<!--|\[!|!\[)/.test(l))
      if (lead) audienceCues.push(lead.slice(0, 120))
    }
  }
  if (cli.length > 0) audienceCues.push('CLI/命令行用户与自动化脚本')
  if (routes.length > 0) audienceCues.push('HTTP/RPC 接口调用方')
  if (ui.length > 0) audienceCues.push('交互式前端界面用户')
  if (jobs.length > 0) audienceCues.push('后台作业与持续集成流水线')

  const flows = [
    ...cli.slice(0, 10).map((c) => ({ name: `CLI:${c.name}`, surface: 'cli', entry: c.file, source: c.target ?? c.file })),
    ...routes.slice(0, 8).map((r) => ({ name: basename(r), surface: 'route', entry: r, source: r })),
    ...ui.slice(0, 6).map((u) => ({ name: basename(u), surface: 'ui', entry: u, source: u })),
    ...jobs.slice(0, 6).map((j) => ({ name: basename(j), surface: 'job', entry: j, source: j })),
  ]
  const docCodeGaps = []
  if (primaryDocText) {
    const seenGap = new Set()
    for (const m of primaryDocText.matchAll(/`([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.[A-Za-z0-9]+)?)`/g)) {
      const p = m[1].replace(/^\.\//, '')
      if (p.includes('<') || p.includes('*') || /^https?:/.test(p) || isToolOwnedPath(p)) continue
      if (!/\.(?:mjs|cjs|js|ts|tsx|jsx|py|go|rs|java|kt|sh|ya?ml|json|toml|proto)$/i.test(p)) continue
      if (!fileSet.has(p) && !existsSync(join(root, p)) && !seenGap.has(p)) {
        seenGap.add(p)
        docCodeGaps.push({ kind: 'missing-doc-path', path: p, detail: `文档引用的路径 ${p} 在源码树中不存在` })
      }
    }
    for (const c of cli.slice(0, 10)) {
      if (!primaryDocText.includes(c.name) && !primaryDocText.includes(c.file)) {
        docCodeGaps.push({ kind: 'undocumented-entry', path: c.file, detail: `源码 CLI 入口 ${c.name}（${c.file}）未在 README/TDD 说明` })
      }
    }
  }
  return {
    audienceCues: [...new Set(audienceCues)].slice(0, 6),
    surfaces: { routes, cli: cli.slice(0, 12), ui, jobs },
    flows: flows.slice(0, 25),
    docCodeGaps: docCodeGaps.slice(0, 15),
  }
}

export function formatRepoMapText(map) {
  const lines = [
    `# 仓库地图：${map.name}`,
    `- 路径: ${map.root}（枚举器: ${map.scanSource}）`,
    `- Git: ${map.isGit ? `是（分支: ${map.branch ?? 'detached/unborn'}）` : '否'} | 生态: ${map.devProfile.ecosystems.join(', ') || '未识别'}`,
    `- 文件统计: 共 ${map.totalFiles}${map.truncated ? '+' : ''} 个（文本 ${map.textFileCount}，源码 ${map.codeFileCount}，测试 ${map.testFileCount}）`,
  ]
  if (map.packages.length > 0) {
    lines.push('', '## 多生态包清单（Manifest-First）')
    for (const p of map.packages) lines.push(`- [${p.dirRel || '.'}] (${p.ecosystems.join(', ') || 'generic'}) manifests=${p.manifests.join(', ')}`)
  }
  const fmtCmd = (val, key) => val ?? (map.devProfile.explicitNone.includes(key) ? 'none (显式关闭)' : '未配置')
  lines.push(
    '', '## Dev Profile 与优先验证入口',
    `- quick-test: ${fmtCmd(map.devProfile.quickTest, 'quick-test')}`,
    `- smoke-verify: ${fmtCmd(map.devProfile.smokeVerify, 'smoke-verify')}`,
    `- full-test: ${fmtCmd(map.devProfile.fullTest, 'full-test')}`,
    `- merge-gate: ${fmtCmd(map.devProfile.mergeGate, 'merge-gate')}`,
    `- high-risk: ${map.devProfile.highRisk.join(', ') || '无'}`,
  )
  if (map.ciRunSteps.length > 0) {
    lines.push('', '## CI 工作流验证步骤')
    for (const s of map.ciRunSteps.slice(0, 12)) {
      lines.push(`- [${s.file}]${s.workingDirectory ? ` (cwd=${s.workingDirectory})` : ''} ${s.command.replace(/\n/g, ' ; ')}`)
    }
  }
  lines.push('', '## 顶层目录分布')
  for (const d of map.topDirectories) lines.push(`- ${d.dir}: ${d.count} 个文件`)
  if (map.reusableModules.length > 0) {
    lines.push('', '## 可复用现成模块清单')
    for (const m of map.reusableModules) lines.push(`- ${m.file}${m.exports.length > 0 ? ` [导出: ${m.exports.join(', ')}]` : ''}`)
  }
  if (map.symbolCoverage?.languageCount > 0) {
    lines.push('', `## 符号抽取覆盖：本仓 ${map.symbolCoverage.languageCount} 种语言，其中 ${map.symbolCoverage.unsupportedCount} 种缺少符号规则`)
    if (map.symbolCoverage.unsupportedCount > 0) {
      lines.push(`- 缺规则的语言（这些语言的模块没有符号清单，不是「没有符号」）：${map.symbolCoverage.unsupported.join('、')}`)
    }
  }
  if (map.featureMap.length > 0) {
    lines.push('', '## Feature Map（入口 -> 源码 -> 验证）')
    for (const fm of map.featureMap) lines.push(`- ${fm.feature}: ${fm.source} -> ${fm.verifyCmd}`)
  }
  if (map.businessFlows) {
    const bf = map.businessFlows
    lines.push('', '## 核心业务流与服务入口（Business Flows）')
    if (bf.audienceCues.length > 0) lines.push(`- 服务对象线索: ${bf.audienceCues.join('；')}`)
    for (const fl of bf.flows.slice(0, 12)) lines.push(`- [${fl.surface}] ${fl.name}: ${fl.entry}`)
    for (const g of bf.docCodeGaps.slice(0, 8)) lines.push(`- [文档差异:${g.kind}] ${g.detail}`)
  }
  if (map.testFiles.length > 0) {
    lines.push('', '## 测试文件（前 40 项）')
    for (const t of map.testFiles) lines.push(`- ${t}`)
  }
  lines.push(
    '', '## 工程文档现状与按需定位入口',
    `- AGENTS.md: ${map.docs.agents ? '有' : '无'} | ARCHITECTURE.md: ${map.docs.architecture ? map.docs.architecture.file : '无'} | docs/TDD.md: ${map.docs.tdd ? '有' : '无'} | prd: ${map.docs.prd.length} | specs: ${map.docs.specs.length} | todo: ${map.docs.todo.length}`,
  )
  if ((map.docs.subAgents ?? []).length > 0) {
    lines.push(`- 子目录 AGENTS.md: ${map.docs.subAgents.map((s) => s.file).join(', ')}`)
  }
  if ((map.docs.headlessDocs ?? []).length > 0) {
    lines.push(`- 无头/非 Frontmatter 文档 (${map.docs.headlessDocs.length} 份):`)
    for (const hd of map.docs.headlessDocs.slice(0, 6)) lines.push(`  - ${hd.file}: ${hd.summary || '无摘要'}`)
  }
  lines.push(`- 按需定位命令: ${map.docLocateHint}`)
  if (map.hotspots.length > 0) {
    lines.push('', '## 近期修改热点（git log 前 10）')
    for (const h of map.hotspots) lines.push(`- ${h.file} (${h.touches} 次)`)
  }
  return `${lines.join('\n')}\n`
}
