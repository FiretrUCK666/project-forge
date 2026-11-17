/**
 * tdd-facts.mjs —— 只收集「生成一份 TDD 需要的事实」，不跑整套勘察。
 *
 * ## 为什么单独一份
 *
 * `scripts/survey.mjs` 是产品层的完整勘察引擎（几十个维度、扫全仓、算缺口）。
 * 而 `doc-plan init --kind tdd` 只需要其中很小一部分：文件清单、生态、命令、
 * 版本下限、有没有远端。为了这点东西去调整套勘察，既慢又跨越了分层
 * （`kit/**` 不该 import `scripts/lib/**`）。
 *
 * 所以这里用 `kit` 自己的 `gitLsFilesTextAndCode` 直接算，边界干净、依赖为零。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { gitLsFilesTextAndCode, readTextSafe } from './git.mjs'
import { isToolOwnedPath } from './tool-owned.mjs'
import { detectTddShapes } from './tdd-shape.mjs'

/** 清单文件 -> 生态。顺序即判定优先级：一个仓可以同时命中多个。 */
const MANIFEST_ECOSYSTEM = Object.freeze([
  ['package.json', 'node'],
  ['pnpm-workspace.yaml', 'node'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['setup.py', 'python'],
  ['Pipfile', 'python'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'java'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
  ['*.csproj', 'dotnet'],
  ['pubspec.yaml', 'dart'],
  ['Package.swift', 'swift'],
  ['mix.exs', 'elixir'],
  ['CMakeLists.txt', 'cpp'],
  ['Makefile', 'make'],
  ['SKILL.md', 'skill'],
])

/**
 * 从清单文件里读运行环境下限。读不出来返回 null——**不编版本号**。
 *
 * `manifestRel` 是这份清单的**真实相对路径**（多包仓里它常常不在根上）。
 */
function readRuntimeRequirement(root, kind, manifestRel = null) {
  const at = (rel) => (existsSync(join(root, rel)) ? readTextSafe(join(root, rel)) : null)
  const dir = manifestRel && manifestRel.includes('/') ? `${manifestRel.slice(0, manifestRel.lastIndexOf('/'))}/` : ''
  const tryRead = (name) => at(`${dir}${name}`)
  try {
    if (kind === 'node') {
      const pkg = tryRead('package.json')
      if (!pkg) return null
      const engines = JSON.parse(pkg)?.engines?.node
      return typeof engines === 'string' ? `Node ${engines}` : null
    }
    if (kind === 'python') {
      const py = tryRead('pyproject.toml')
      const m = py && /requires-python\s*=\s*["']([^"']+)["']/.exec(py)
      if (m) return `Python ${m[1]}`
      const rt = tryRead('runtime.txt')
      return rt?.trim() ? `Python ${rt.trim()}` : null
    }
    if (kind === 'java') {
      const pom = tryRead('pom.xml')
      const m = pom && /<(?:maven\.compiler\.(?:source|release)|java\.version|release)>([^<]+)</.exec(pom)
      return m ? `Java ${m[1]}` : null
    }
    if (kind === 'go') {
      const mod = tryRead('go.mod')
      const m = mod && /^go\s+([\d.]+)$/m.exec(mod)
      return m ? `Go ${m[1]}` : null
    }
    if (kind === 'rust') {
      const cargo = tryRead('Cargo.toml')
      const m = cargo && /rust-version\s*=\s*["']([^"']+)["']/.exec(cargo)
      return m ? `Rust ${m[1]}` : null
    }
    if (kind === 'ruby') {
      const gem = tryRead('.ruby-version')
      return gem?.trim() ? `Ruby ${gem.trim()}` : null
    }
  } catch { /* 清单坏了当没有，不抛 */ }
  return null
}

/** 从 `AGENTS.md` 的 Dev Profile 里读命令。读不到返回空对象。 */
function readProfileCommands(root) {
  const agents = existsSync(join(root, 'AGENTS.md')) ? readTextSafe(join(root, 'AGENTS.md')) : null
  if (!agents) return {}
  const block = /```yaml\n([\s\S]*?)```/.exec(agents)
  if (!block) return {}
  const out = {}
  for (const line of block[1].split('\n')) {
    const m = /^([a-z-]+):\s*(.+)$/.exec(line.trim())
    if (!m) continue
    const key = m[1]
    const val = m[2].trim()
    if (!val || val === 'none') continue
    if (key === 'quick-test') out.test = val
    else if (key === 'full-test') out['full-test'] = val
    else if (key === 'smoke-verify') out.smoke = val
  }
  return out
}

/** 这些目录里的清单不是项目自己的（依赖、构建产物、样例）。 */
const NOT_PROJECT_MANIFEST = /^(?:node_modules|dist|build|target|vendor|__pycache__|\.git|coverage)\//

/**
 * 在文件清单里找清单文件。
 *
 * **不能只看仓库根**：多包仓（`trust-gateway-be/pom.xml` + `trust-gateway-fe/package.json`）
 * 的清单一个都不在根上。早先只查根，于是这类仓被判定成「没有生态」，
 * 生成的 TDD 里技术栈全是 `<待核实>`——那是勘察自己没看见，不是项目没写。
 *
 * 返回每个命中的**真实相对路径**，后续读版本号要用它，不能再拼根路径。
 */
function findManifests(filePaths) {
  const hits = []
  for (const [name, kind] of MANIFEST_ECOSYSTEM) {
    const matches = filePaths.filter((p) => {
      if (NOT_PROJECT_MANIFEST.test(p)) return false
      // 工具产物目录里的清单不是这个项目自己的——.agents/skills/*/SKILL.md 是装配进来的，
      // 把它当成「本项目是技能包」会让生成的 TDD 说错自己是干什么的。
      if (isToolOwnedPath(p)) return false
      const base = p.includes('/') ? p.slice(p.lastIndexOf('/') + 1) : p
      if (name.includes('*')) return base.endsWith(name.replace('*', ''))
      return base === name
    })
    // 每一种清单只留最浅的那几个：深层的多半是样例或测试夹具。
    const sorted = matches.sort((a, b) => a.split('/').length - b.split('/').length)
    const keep = sorted.slice(0, 4)
    for (const rel of keep) hits.push({ name, kind, rel })
  }
  return hits
}

/**
 * 收集一份 TDD 需要的事实。
 *
 * @param {string} root 仓库根
 * @returns {Promise<object>}
 */
export async function collectTddFacts(root) {
  const ls = await gitLsFilesTextAndCode(root, { isGit: existsSync(join(root, '.git')) })
  const filePaths = (ls.files ?? []).map((f) => String(f.rel ?? f).replace(/\\/g, '/'))

  const manifestHits = findManifests(filePaths)
  const presentManifests = [...new Set(manifestHits.map((h) => h.name))]
  const kinds = [...new Set(manifestHits.map((h) => h.kind))]

  // 纯文档仓：没有任何代码文件
  const hasCode = filePaths.some((p) => /\.(?:mjs|js|cjs|ts|tsx|jsx|py|go|rs|java|kt|rb|php|cs|swift|dart|ex|exs|c|cpp|h|hpp)$/i.test(p))
  if (!hasCode && kinds.length === 0) kinds.push('docs-only')

  // 版本号从命中的**真实位置**读；同一个生态取第一个读得出的。
  const runtimeRequirements = []
  for (const kind of kinds) {
    for (const hit of manifestHits.filter((h) => h.kind === kind)) {
      const req = readRuntimeRequirement(root, kind, hit.rel)
      if (req && !runtimeRequirements.includes(req)) runtimeRequirements.push(req)
    }
  }

  const shape = detectTddShapes({
    paths: filePaths,
    kinds,
    runtimeRequirements,
    codeFiles: filePaths.filter((p) => /\.(?:mjs|js|ts|py|go|rs|java|rb|php|cs)$/i.test(p)).length,
  })

  const topLevelDirs = [...new Set(filePaths.map((p) => p.split('/')[0]).filter((d) => d && !d.includes('.')))]
  const hasRemote = existsSync(join(root, '.git', 'config'))
    ? /\[remote\s+"origin"\]/.test(readTextSafe(join(root, '.git', 'config')) ?? '')
    : false

  return {
    target: { path: root, name: readTextSafe(join(root, 'README.md'))?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? null },
    ecosystem: { kinds, manifests: presentManifests },
    artifacts: { runtimeRequirements },
    commands: readProfileCommands(root),
    workspace: { declared: presentManifests.includes('pnpm-workspace.yaml'), packages: [] },
    git: { hasRemote, remoteUrl: null },
    reentry: { unregisteredTopDirs: topLevelDirs },
    tddShape: {
      enabled: [...shape.enabled],
      reasons: shape.reasons,
      topLevelDirs,
      filePaths,
    },
    scale: { codeFiles: filePaths.filter((p) => /\.(?:mjs|js|ts|py|go|rs|java|rb|php|cs)$/i.test(p)).length },
  }
}
