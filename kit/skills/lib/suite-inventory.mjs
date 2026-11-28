/**
 * suite-inventory.mjs —— 多生态测试盘点、原生测试目录解析与功能地图测试关联共享引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-govern/govern-tests.mjs 与 dev-iterate/iterate.mjs 共用。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'

import { FEATURE_MAP_REL, readFeatureMapSafe, updateFeatureMapTestRefs } from './feature-map.mjs'
import { posixPath, readJsonSafe, readTextSafe } from './git.mjs'
import {
  CODE_EXT_RE, FIXTURE_FILE_RE, HARD_SLEEP_RULES, MOCK_SETUP_RE, MOCK_SPY_ASSERT_RE, TEST_FILE_RE,
  checkProcessArtifactFilename, hasBehavioralAssertion, isCallbackSpyTest, isTimeoutGuardSleep,
  scanStructuralHygiene, stripCodeCommentsLines,
} from './static-gates.mjs'
import {
  collectConfiguredVerificationCommands, detectNodeTestRunner, resolveTestRunner,
} from './suite-runner.mjs'

export {
  FEATURE_MAP_REL,
  collectConfiguredVerificationCommands,
  detectNodeTestRunner,
  readFeatureMapSafe,
  resolveTestRunner,
  updateFeatureMapTestRefs,
}

const PRIORITY_SCRIPT_HINTS = ['test', 'spec', 'e2e', 'lint', 'check', 'type', 'build', 'verify', 'ci']
const JUST_RECIPE_RE = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:\n]*)?:(?!=)/gm

function readUtf8FileSafe(absPath) {
  if (!existsSync(absPath)) return null
  try {
    const buf = readFileSync(absPath)
    if (buf.subarray(0, 4096).includes(0)) return null
    return buf.toString('utf8').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
}

export function collectMakefileTargets(repoRoot) {
  const text = readUtf8FileSafe(join(repoRoot, 'Makefile'))
  if (!text) return { targets: [], recipes: new Map() }
  const targets = []
  const recipes = new Map()
  const lines = text.split('\n')
  let curTarget = null
  for (const line of lines) {
    const hdr = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(line)
    if (hdr && !hdr[1].startsWith('.')) {
      curTarget = hdr[1]
      if (!targets.includes(curTarget)) targets.push(curTarget)
      if (!recipes.has(curTarget)) recipes.set(curTarget, [])
    } else if (curTarget && line.startsWith('\t')) {
      const cmd = line.trim().replace(/^[@+-]+/, '').trim()
      if (cmd && !cmd.startsWith('#')) recipes.get(curTarget).push(cmd)
    } else if (line.trim() && !line.startsWith('#')) {
      curTarget = null
    }
  }
  return { targets: targets.slice(0, 30), recipes }
}

export function collectJustfileRecipes(repoRoot) {
  for (const name of ['justfile', 'Justfile', '.justfile']) {
    const text = readUtf8FileSafe(join(repoRoot, name))
    if (!text) continue
    const list = []
    for (const m of text.matchAll(JUST_RECIPE_RE)) {
      if (!list.includes(m[1])) list.push(m[1])
      if (list.length >= 30) break
    }
    return list
  }
  return []
}

export function expandVerificationCommands(repoRoot, ciSteps, devProfile, discovery) {
  const rootPkg = readJsonSafe(join(repoRoot, 'package.json'))
  const rootScripts = (rootPkg && typeof rootPkg.scripts === 'object' && rootPkg.scripts) ? rootPkg.scripts : {}
  const subScriptsByDir = new Map()
  for (const pkg of discovery?.packages ?? []) {
    if (!pkg.dirRel) continue
    const subPkg = readJsonSafe(join(repoRoot, pkg.dirRel, 'package.json'))
    if (subPkg?.scripts && typeof subPkg.scripts === 'object') subScriptsByDir.set(pkg.dirRel, subPkg.scripts)
  }

  const makeInfo = collectMakefileTargets(repoRoot)
  const seeds = [
    ...(ciSteps ?? []).map((s) => s.cmd),
    ...(devProfile?.['quick-test'] ?? []),
    ...(devProfile?.['full-test'] ?? []),
    ...(devProfile?.['smoke-verify'] ?? []),
    ...(devProfile?.['merge-gate'] ?? []),
  ]
  const expanded = []
  const visitedScripts = new Set()

  const visitCmd = (rawCmd, depth, activeDir = '') => {
    for (const part of String(rawCmd ?? '').split(/\n|&&|\|\||;/)) {
      const clean = part.trim()
      if (!clean) continue
      const dirHint = /(?:--prefix|--dir|--cwd)\s+([^\s]+)/.exec(clean)?.[1] ?? activeDir
      const scripts = (dirHint && subScriptsByDir.get(dirHint)) ? subScriptsByDir.get(dirHint) : rootScripts
      const pkgSingle = /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:npm|pnpm|yarn|bun)\s+(?:(?:--prefix|--dir|--cwd)\s+\S+\s+)?(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s+--.*)?$/.exec(clean)
      const makeSingle = /^make\s+([A-Za-z0-9_.-]+)(?:\s|$)/.exec(clean)
      let expandedPureScript = false
      if (depth < 3) {
        const pkgRuns = [
          /\bnpm\s+(?:--prefix\s+\S+\s+)?(?:run\s+)?([A-Za-z0-9:_-]+)\b/g,
          /\bpnpm\s+(?:--dir\s+\S+\s+)?(?:run\s+)?([A-Za-z0-9:_-]+)\b/g,
          /\byarn\s+(?:--cwd\s+\S+\s+)?(?:run\s+)?([A-Za-z0-9:_-]+)\b/g,
          /\bbun\s+run\s+([A-Za-z0-9:_-]+)\b/g,
        ]
        for (const re of pkgRuns) {
          for (const m of clean.matchAll(re)) {
            const sName = m[1]
            if (sName && scripts[sName]) {
              if (pkgSingle && pkgSingle[1] === sName) expandedPureScript = true
              const vKey = `${dirHint}:${sName}`
              if (!visitedScripts.has(vKey)) {
                visitedScripts.add(vKey)
                visitCmd(scripts[sName], depth + 1, dirHint)
              }
            }
          }
        }
        if (makeSingle && makeInfo.recipes.has(makeSingle[1])) {
          const mkKey = `make:${makeSingle[1]}`
          expandedPureScript = true
          if (!visitedScripts.has(mkKey)) {
            visitedScripts.add(mkKey)
            for (const subCmd of makeInfo.recipes.get(makeSingle[1])) visitCmd(subCmd, depth + 1, activeDir)
          }
        }
      }
      if (!expandedPureScript) expanded.push(clean)
    }
  }

  for (const s of seeds) visitCmd(s, 0)
  return expanded
}

export function cmdCoversTestFile(commands, testRel) {
  const rel = posixPath(testRel)
  const base = posix.basename(rel)
  const dir = posix.dirname(rel)
  const dirParts = dir === '.' ? [] : dir.split('/').filter(Boolean)
  const ancestorDirs = dirParts.map((_, idx) => dirParts.slice(0, idx + 1).join('/'))
  const ext = base.split('.').pop()?.toLowerCase() ?? ''
  const isJsLike = ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx'].includes(ext)
  const isPy = ext === 'py'
  const isGo = ext === 'go'
  const isRust = ext === 'rs'
  const isJvm = ['java', 'kt', 'kts'].includes(ext)
  const isDotnet = ['cs', 'fs'].includes(ext)
  const isSwift = ext === 'swift'
  const isCpp = ['c', 'cc', 'cpp'].includes(ext)

  for (const rawCmd of commands ?? []) {
    const cmd = posixPath(rawCmd)
    if (cmd.includes(rel)) return true
    if (new RegExp(`(?:^|[\\s/"'=])${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s"'])`).test(cmd)) return true
    const cmdNoSubcmd = cmd.replace(/\b(?:npm|pnpm|yarn|bun|go|cargo|deno|mvn|gradle|dotnet|swift)\s+(?:run\s+)?test\b/g, '')
    for (const d of ancestorDirs) {
      if (new RegExp(`(?:^|[\\s"'=])${d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/?(?:$|[\\s*?"'&|;]))`).test(cmdNoSubcmd)) return true
    }

    if (isJsLike) {
      if (/\bnode\s+--test\b/.test(cmd) && !/\.(?:m?js|cjs|ts)\b/.test(cmd.replace(/.*?\bnode\s+--test\b/, ''))) return true
      if (/\b(?:vitest|jest|mocha|ava|tap|bun\s+test)\b/.test(cmd) && !/\.(?:m?js|cjs|tsx?|jsx?)\b/.test(cmd)) return true
    }
    if (isPy && /\b(?:pytest|uv\s+run\s+pytest|poetry\s+run\s+pytest|python3?\s+-m\s+(?:pytest|unittest))\b/.test(cmd) && !/\.py\b/.test(cmd)) return true
    if (isGo && /\bgo\s+test\b/.test(cmd) && (/\.\/\.\.\./.test(cmd) || cmd.includes(`./${dir}`))) return true
    if (isRust && /\bcargo\s+test\b/.test(cmd)) return true
    if (isJvm && /\b(?:mvn|\.\/mvnw|gradle|\.\/gradlew)\b[^\n]*\b(?:test|verify|check)\b/.test(cmd)) return true
    if (isDotnet && /\bdotnet\s+test\b/.test(cmd)) return true
    if (isSwift && /\bswift\s+test\b/.test(cmd)) return true
    if (isCpp && /\bctest\b/.test(cmd)) return true
    if (/\b(?:just|task|make)\s+(?:test|check|verify)\b/.test(cmd)) return true
  }
  return false
}

export function collectConfiguredTestEntries(repoRoot, files, expandedCommands) {
  const codeRelSet = new Set((files ?? []).filter((f) => CODE_EXT_RE.test(f.name)).map((f) => f.rel))
  const entries = new Set()
  let hasExecutableRunner = false
  const runnerRe = /\b(?:node\s+--test|vitest|jest|mocha|ava|tap|bun\s+test|pytest|uv\s+run\s+pytest|poetry\s+run\s+pytest|python3?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+test|mvn\b[^\n]*\b(?:test|verify)|\.?\/?mvnw\b[^\n]*\b(?:test|verify)|gradle\b[^\n]*\b(?:test|check)|\.?\/?gradlew\b[^\n]*\b(?:test|check)|dotnet\s+test|swift\s+test|ctest|meson\s+test|dart\s+test|mix\s+test|bundle\s+exec\s+(?:rspec|rake\s+test))\b/

  for (const rawCmd of expandedCommands ?? []) {
    const cmd = String(rawCmd ?? '').trim()
    if (!cmd || /no test specified/i.test(cmd)) continue
    if (runnerRe.test(cmd)) hasExecutableRunner = true
    for (const tok of cmd.split(/[\s"'`;|&()]+/)) {
      const clean = posixPath(tok).replace(/^\.\//, '')
      if (!clean || clean.startsWith('-') || !CODE_EXT_RE.test(clean)) continue
      if (codeRelSet.has(clean) || existsSync(join(repoRoot, clean))) {
        entries.add(clean)
        hasExecutableRunner = true
      }
    }
  }
  return { configuredTestEntries: [...entries].sort(), hasExecutableRunner }
}

export function collectTestInventory(repoRoot, files, testFiles, ciSteps, ciConfigFiles, devProfile, discovery, configuredTestEntries = []) {
  const definedScripts = {}
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  if (pkg && typeof pkg.scripts === 'object' && pkg.scripts) {
    const entries = Object.entries(pkg.scripts).filter(([k]) => typeof k === 'string')
    const prio = entries.filter(([k]) => PRIORITY_SCRIPT_HINTS.some((h) => k.toLowerCase().includes(h)))
    const rest = entries.filter((kv) => !prio.includes(kv))
    const formatted = [...prio, ...rest].slice(0, 20).map(([k, v]) => `${k}: ${v}`)
    if (formatted.length > 0) definedScripts.packageJson = formatted
  }

  const subPkgCmds = []
  for (const p of discovery?.packages ?? []) {
    if (!p.dirRel) continue
    for (const [eco, cmdObj] of Object.entries(p.commands ?? {})) {
      if (cmdObj?.quickTest) subPkgCmds.push(`${p.dirRel} (${eco}): ${cmdObj.quickTest}`)
    }
  }
  if (subPkgCmds.length > 0) definedScripts.workspacePackages = subPkgCmds.slice(0, 20)

  const makeInfo = collectMakefileTargets(repoRoot)
  if (makeInfo.targets.length > 0) definedScripts.makefile = makeInfo.targets

  const justRecipes = collectJustfileRecipes(repoRoot)
  if (justRecipes.length > 0) definedScripts.justfile = justRecipes

  const scriptsDirFiles = (files ?? [])
    .filter((f) => f.rel.startsWith('scripts/') && /\.(?:sh|py|mjs|cjs|js|ts|ps1)$/i.test(f.name))
    .map((f) => f.rel)
    .slice(0, 25)
  if (scriptsDirFiles.length > 0) definedScripts.scriptsDir = scriptsDirFiles

  const profileCmds = []
  for (const k of ['quick-test', 'full-test', 'smoke-verify', 'merge-gate']) {
    for (const c of devProfile?.[k] ?? []) profileCmds.push(`${k}: ${c}`)
  }
  if (profileCmds.length > 0) definedScripts.devProfile = profileCmds
  if ((ciSteps ?? []).length > 0) definedScripts.ciRunSteps = ciSteps.slice(0, 30).map((s) => `${s.file}: ${s.cmd}`)
  if (configuredTestEntries.length > 0) definedScripts.configuredTestEntries = configuredTestEntries

  const seenTestRels = new Set()
  const mergedTestRels = []
  const addTestRel = (rel) => {
    const clean = posixPath(String(rel ?? '')).replace(/^\.\//, '')
    if (!clean || seenTestRels.has(clean)) return
    seenTestRels.add(clean)
    mergedTestRels.push(clean)
  }
  for (const tf of testFiles ?? []) addTestRel(tf.rel)
  for (const f of files ?? []) {
    if (FIXTURE_FILE_RE.test(f.rel)) addTestRel(f.rel)
  }
  for (const entry of configuredTestEntries ?? []) {
    const clean = posixPath(String(entry ?? '')).replace(/^\.\//, '')
    if (clean && existsSync(join(repoRoot, clean))) addTestRel(clean)
  }

  const dirCounts = new Map()
  for (const rel of mergedTestRels) {
    const parts = rel.split('/').filter(Boolean)
    const bucket = parts.length >= 2 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.'
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1)
  }
  const testDirectories = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([dir, count]) => ({ dir, files: count }))

  return {
    totalTestFiles: mergedTestRels.length,
    configuredTestEntries,
    totalTestEntries: new Set([...mergedTestRels, ...configuredTestEntries]).size,
    testDirectories,
    definedScripts,
    ciConfigFiles: ciConfigFiles ?? [],
    hasCiConfig: (ciSteps ?? []).length > 0 || (ciConfigFiles ?? []).length > 0,
  }
}

/** 判定候选测试路径是否会落入 `quick-test` 窄单测范围（用于避免重型/回归测试污染极速迭代）。 */
export function isPathInQuickTestScope(devProfile, relPath) {
  const rel = posixPath(relPath).replace(/^\.\//, '')
  const quickCmds = (devProfile?.['quick-test'] ?? []).map((c) => String(c ?? '').trim()).filter((c) => c && c.toLowerCase() !== 'none')
  for (const cmd of quickCmds) {
    if (cmd.includes('{target}')) continue
    if (/(?:test\/unit|tests\/unit|__tests__\/unit|unit\.mjs|unit_test)/i.test(cmd)) {
      if (/(?:^|\/)unit(?:\/|\.)/i.test(rel)) return true
      continue
    }
    if (cmdCoversTestFile([cmd], rel)) return true
  }
  return false
}

const TS_TEST_NAME_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|cts)$/i
const JS_TEST_NAME_RE = /\.(?:test|spec)\.(?:js|mjs|cjs|jsx)$/i

function countTestFilesByLang(repoRoot, dirs = []) {
  let tsCount = 0
  let jsCount = 0
  const stack = dirs.filter((d) => existsSync(join(repoRoot, d))).slice(0, 6)
  for (let visited = 0; stack.length > 0 && visited < 40; visited += 1) {
    const rel = stack.pop()
    let entries = []
    try { entries = readdirSync(join(repoRoot, rel), { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith('.')) stack.push(`${rel}/${ent.name}`)
      else if (ent.isFile() && TS_TEST_NAME_RE.test(ent.name)) tsCount += 1
      else if (ent.isFile() && JS_TEST_NAME_RE.test(ent.name)) jsCount += 1
    }
  }
  return { tsCount, jsCount }
}

/** 探测仓库是否为 TypeScript 项目（根/子包存在 tsconfig.json 或测试文件以 *.test.ts 为主）。 */
export function detectTypeScriptProject(repoRoot, files = [], dirRel = '') {
  if (existsSync(join(repoRoot, 'tsconfig.json')) || existsSync(join(repoRoot, 'tsconfig.base.json'))) {
    return true
  }
  const fileRels = (files ?? []).map((f) => posixPath(f.rel ?? f)).filter(Boolean)
  if (fileRels.some((r) => /(?:^|\/)tsconfig(?:\.[^/]+)?\.json$/i.test(r))) {
    return true
  }
  for (const wsDir of ['packages', 'apps', 'services']) {
    const absWs = join(repoRoot, wsDir)
    if (!existsSync(absWs)) continue
    try {
      for (const ent of readdirSync(absWs, { withFileTypes: true })) {
        if (ent.isDirectory() && (existsSync(join(absWs, ent.name, 'tsconfig.json')) || existsSync(join(absWs, ent.name, 'tsconfig.base.json')))) {
          return true
        }
      }
    } catch { /* ignore */ }
  }
  let tsTests = fileRels.filter((r) => TS_TEST_NAME_RE.test(r)).length
  let jsTests = fileRels.filter((r) => JS_TEST_NAME_RE.test(r)).length
  if (tsTests === 0 && jsTests === 0) {
    const diskCounts = countTestFilesByLang(repoRoot, [dirRel, 'tests', 'test', '__tests__', 'src'])
    tsTests = diskCounts.tsCount
    jsTests = diskCounts.jsCount
  }
  return tsTests > 0 && tsTests >= jsTests
}

const CENTRALIZED_TEST_DIR_RE = /^(?:tests?|__tests__|specs?|e2e|integration)\//i
const COLOCATED_SRC_DIR_RE = /^(?:src|lib|app|apps|packages|services|modules|components|client|server)\//i

/** 基于仓内既有测试文件分布统计推导 `colocated` vs `centralized` 布局与命名风格（`.test.` vs `.spec.`）。 */
export function inferRepoTestLayout(repoRoot, files = []) {
  const rels = []
  for (const item of Array.isArray(files) ? files : []) {
    const rel = posixPath(item?.rel ?? item).replace(/^\.\//, '')
    if (rel && TEST_FILE_RE.test(rel)) rels.push(rel)
  }
  if (rels.length === 0) {
    const stack = ['src', 'lib', 'app', 'packages', 'tests', 'test', '__tests__'].filter((d) => existsSync(join(repoRoot, d)))
    for (let visited = 0; stack.length > 0 && visited < 80; visited += 1) {
      const dir = stack.pop()
      let entries = []
      try { entries = readdirSync(join(repoRoot, dir), { withFileTypes: true }) } catch { continue }
      for (const ent of entries) {
        if (ent.name.startsWith('.') || ent.name === 'node_modules') continue
        const next = `${dir}/${ent.name}`
        if (ent.isDirectory()) stack.push(next)
        else if (ent.isFile() && TEST_FILE_RE.test(next)) rels.push(next)
      }
    }
  }
  let colocatedCount = 0
  let centralizedCount = 0
  let specCount = 0
  let testCount = 0
  for (const rel of rels) {
    if (CENTRALIZED_TEST_DIR_RE.test(rel)) centralizedCount += 1
    else if (COLOCATED_SRC_DIR_RE.test(rel) && !/(?:^|\/)(?:tests?|__tests__)\//i.test(rel)) colocatedCount += 1
    else centralizedCount += 1
    if (/(?:\.|_)spec\.[^/]+$/i.test(rel)) specCount += 1
    else if (/(?:\.|_)test\.[^/]+$|(?:^|\/)test_[^/]+$/i.test(rel)) testCount += 1
  }
  const layout = colocatedCount > centralizedCount ? 'colocated' : 'centralized'
  const namingStyle = specCount > testCount ? 'spec' : 'test'
  return { layout, namingStyle, colocatedCount, centralizedCount, specCount, testCount }
}

/** 推断目标仓原生集成/回归/E2E/性能测试目录与栈命名惯例（严禁写入 `.agents/`，避免污染 `quick-test`）。 */
export function resolveNativeTestDir(repoRoot, { ecosystem = null, tier = 'integration', devProfile = null, files = [] } = {}) {
  const cleanTier = ['integration', 'e2e', 'perf', 'regression'].includes(String(tier).toLowerCase())
    ? String(tier).toLowerCase()
    : 'integration'

  let stack = String(ecosystem ?? '').toLowerCase()
  if (!stack) {
    if (existsSync(join(repoRoot, 'Cargo.toml'))) stack = 'rust'
    else if (existsSync(join(repoRoot, 'go.mod'))) stack = 'go'
    else if (existsSync(join(repoRoot, 'pyproject.toml')) || existsSync(join(repoRoot, 'pytest.ini')) || existsSync(join(repoRoot, 'requirements.txt'))) stack = 'python'
    else if (existsSync(join(repoRoot, 'package.json')) || existsSync(join(repoRoot, 'tsconfig.json')) || (files ?? []).some((f) => /\.(?:mjs|js|ts|tsx)$/.test(f.rel ?? f))) stack = 'node'
    else stack = 'node'
  }

  const layoutStats = inferRepoTestLayout(repoRoot, files)
  const hasDir = (rel) => existsSync(join(repoRoot, rel))
  let dirRel = `tests/${cleanTier}`
  if (stack === 'go') {
    dirRel = hasDir('tests') ? `tests/${cleanTier}` : `internal/${cleanTier}`
  } else if (stack === 'rust') {
    dirRel = 'tests'
  } else if (stack === 'python') {
    dirRel = hasDir('test') && !hasDir('tests') ? `test/${cleanTier}` : `tests/${cleanTier}`
  } else {
    if (hasDir(`tests/${cleanTier}`)) dirRel = `tests/${cleanTier}`
    else if (hasDir(`test/${cleanTier}`)) dirRel = `test/${cleanTier}`
    else if (hasDir('tests')) dirRel = `tests/${cleanTier}`
    else if (hasDir('test')) dirRel = `test/${cleanTier}`
    else dirRel = `tests/${cleanTier}`
  }

  // 防污染：绝不写入 .agents/，若默认目录落在 quick-test 范围内则退避至隔离原生回归子目录
  if (dirRel.startsWith('.agents')) dirRel = `tests/${cleanTier}`
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  const isTypeScript = stack === 'node' ? detectTypeScriptProject(repoRoot, files, dirRel) : false
  const nodeRunner = stack === 'node' ? detectNodeTestRunner(repoRoot, pkg, devProfile) : null
  const extByStack = { node: isTypeScript ? '.ts' : '.mjs', python: '.py', go: '_test.go', rust: '.rs' }
  const ext = extByStack[stack] ?? '.mjs'
  const styleTok = layoutStats.namingStyle
  const probeSuffix = stack === 'node' ? (isTypeScript ? `.${styleTok}.ts` : `.${styleTok}.mjs`) : ext
  const probeFile = `${dirRel}/probe_${cleanTier}${probeSuffix}`
  let avoidsQuickTest = !isPathInQuickTestScope(devProfile, probeFile)
  if (!avoidsQuickTest) {
    const isolated = `tests/${cleanTier}-suite`
    const isoProbe = `${isolated}/probe_${cleanTier}${probeSuffix}`
    if (!isPathInQuickTestScope(devProfile, isoProbe)) {
      dirRel = isolated
      avoidsQuickTest = true
    }
  }

  const isEsm = stack === 'node' && (pkg?.type === 'module' || (files ?? []).some((f) => /\.mjs$/.test(f.rel ?? f)))
  const nodeRunnerHints = {
    vitest: 'npx vitest run',
    jest: 'npx jest',
    bun: 'bun test',
    tsx: 'npx tsx --test',
    node: 'node --test',
  }
  let pythonRunnerHint = 'python3 -m unittest'
  if (stack === 'python') {
    const venvPyRel = process.platform === 'win32' ? '.venv\\Scripts\\python.exe' : '.venv/bin/python'
    const venvPyExists = existsSync(join(repoRoot, ...(process.platform === 'win32' ? ['.venv', 'Scripts', 'python.exe'] : ['.venv', 'bin', 'python'])))
    const pyProjText = readTextSafe(join(repoRoot, 'pyproject.toml')) ?? ''
    const setupCfgText = readTextSafe(join(repoRoot, 'setup.cfg')) ?? ''
    const hasPytestConfig = existsSync(join(repoRoot, 'pytest.ini'))
      || existsSync(join(repoRoot, 'conftest.py'))
      || existsSync(join(repoRoot, 'tox.ini'))
      || /\[tool\.pytest\b/.test(pyProjText)
      || /\[tool:pytest\]/.test(setupCfgText)
      || existsSync(join(repoRoot, '.venv', 'Scripts', 'pytest.exe'))
      || existsSync(join(repoRoot, '.venv', 'bin', 'pytest'))
    if (venvPyExists) {
      pythonRunnerHint = hasPytestConfig ? `${venvPyRel} -m pytest` : `${venvPyRel} -m unittest`
    } else if (hasPytestConfig) {
      pythonRunnerHint = 'pytest'
    }
  }
  const runnerHint = stack === 'python'
    ? pythonRunnerHint
    : stack === 'go'
      ? `go test ./${dirRel}/...`
      : stack === 'rust'
        ? 'cargo test --test'
        : (nodeRunnerHints[nodeRunner] ?? 'node --test')

  return {
    stack,
    tier: cleanTier,
    dirRel: posixPath(dirRel),
    ext,
    isTypeScript,
    testRunner: nodeRunner ?? stack,
    isEsm,
    runnerHint,
    avoidsQuickTest,
    layout: layoutStats.layout,
    namingStyle: layoutStats.namingStyle,
  }
}

export function slugTestToken(raw) {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/\b(?:issue|pr|stage|wave|phase|sprint|slice|batch)(?:[-_]?\d+[a-z0-9]*|\b)/gi, 'flow')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feature-flow'
}

/** 校验拟写入的测试代码：禁止 `.agents/` 路径、禁止过程编号命名、拦截反作弊坏味（零断言/纯 Mock/硬等待/压制注释/>800行）。 */
export function validateGeneratedTestQuality(relPath, content) {
  const rel = posixPath(relPath).replace(/^\.\//, '')
  const violations = []
  if (!rel || rel.startsWith('.agents/') || rel === '.agents') {
    violations.push({ code: 'FORBIDDEN_AGENTS_TEST_PATH', message: `生成的测试严禁写入 .agents/ 目录：${rel}` })
  }
  const procHit = checkProcessArtifactFilename(rel)
  if (procHit) {
    violations.push({ code: 'PROCESS_ARTIFACT_FILENAME', message: `测试文件名命中禁用过程编号「${procHit.token}」：${rel}` })
  }
  const text = String(content ?? '').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  if (lines.length > 800) {
    violations.push({ code: 'OVERSIZED_TEST_FILE', message: `生成测试超过 800 行上限 (${lines.length}L)：${rel}` })
  }
  const ext = rel.split('.').pop()?.toLowerCase() ?? ''
  const codeLines = stripCodeCommentsLines(text, ext)
  const codeOnly = codeLines.join('\n')

  if (!hasBehavioralAssertion(codeOnly, { ext })) {
    violations.push({ code: 'ZERO_ASSERTION_TEST', message: `生成的测试缺少真实行为断言（assert/expect）：${rel}` })
  }
  const mockCount = (codeOnly.match(MOCK_SETUP_RE) ?? []).length
  const hasSpyAssert = MOCK_SPY_ASSERT_RE.test(codeOnly)
  const nonSpyCode = codeOnly.replace(new RegExp(MOCK_SPY_ASSERT_RE.source, 'g'), '')
  if (mockCount >= 5 && hasSpyAssert && !hasBehavioralAssertion(nonSpyCode, { ext }) && !isCallbackSpyTest(codeOnly)) {
    violations.push({ code: 'MOCK_TAUTOLOGY_TEST', message: `生成的测试属于纯 Mock 自证（mock=${mockCount}）：${rel}` })
  }
  for (let i = 0; i < codeLines.length; i += 1) {
    if (HARD_SLEEP_RULES.some((re) => re.test(codeLines[i]))) {
      if (isTimeoutGuardSleep(codeLines, i)) continue
      violations.push({ code: 'HARD_SLEEP_TEST', line: i + 1, message: `生成的测试包含 >=1s 硬等待：${rel}:${i + 1}` })
      break
    }
  }
  const hyg = scanStructuralHygiene({
    fileRel: rel, lines, fullLineCount: lines.length,
  })
  for (const hit of hyg?.excuseSuppressions ?? []) {
    violations.push({ code: 'EDIT_GATE_SUPPRESSION', line: hit.line, message: `无故压制注释：${hit.excerpt} (${rel})` })
  }
  for (const hit of hyg?.tombstoneComments ?? []) {
    violations.push({ code: 'EDIT_GATE_TOMBSTONE', line: hit.line, message: `履历墓碑注释：${hit.excerpt} (${rel})` })
  }
  for (const hit of hyg?.deadCodeBlocks ?? []) {
    violations.push({ code: 'EDIT_GATE_DEAD_CODE', line: hit.line, message: `注释死代码块：${hit.excerpt} (${rel})` })
  }
  return { ok: violations.length === 0, violations }
}

/** 按目标仓技术栈惯例生成原生集成/回归/E2E/性能测试代码（自带真实行为断言）。 */
export function renderNativeTestContent(repoRoot, candidate, stack) {
  const relTest = candidate.plannedTestFile
  const modRel = candidate.targetModule
  const testDir = posix.dirname(relTest)
  const importRel = modRel ? posix.relative(testDir, modRel) : null
  const normImport = importRel ? (importRel.startsWith('.') ? importRel : `./${importRel}`) : null
  const label = String(candidate.topic || candidate.featureId || 'regression-flow').replace(/['"`\\]/g, '')

  if (stack === 'python') {
    return [
      'import pathlib',
      'import unittest',
      '',
      'class GeneratedIterationTest(unittest.TestCase):',
      `    def test_${slugTestToken(label).replace(/-/g, '_')}_contract(self):`,
      `        root = pathlib.Path(__file__).resolve().parents[${testDir.split('/').filter(Boolean).length}]`,
      modRel ? `        target = root / "${modRel}"` : '        target = root',
      '        self.assertTrue(target.exists(), f"missing target: {target}")',
      modRel ? '        content = target.read_text(encoding="utf-8")' : '        content = str(target)',
      '        self.assertGreater(len(content.strip()), 0)',
      '',
      'if __name__ == "__main__":',
      '    unittest.main()',
      '',
    ].join('\n')
  }
  if (stack === 'go') {
    const pkgName = slugTestToken(posix.basename(testDir)).replace(/-/g, '_') || 'integration'
    return [
      `package ${pkgName}`,
      '',
      'import (',
      '\t"os"',
      '\t"testing"',
      ')',
      '',
      `func Test${slugTestToken(label).replace(/(?:^|-)([a-z0-9])/g, (_, c) => c.toUpperCase())}Contract(t *testing.T) {`,
      '\twd, err := os.Getwd()',
      '\tif err != nil || wd == "" { t.Fatalf("expected valid working directory, got err=%v", err) }',
      '}',
      '',
    ].join('\n')
  }
  if (stack === 'rust') {
    return [
      'use std::path::Path;',
      '',
      '#[test]',
      `fn ${slugTestToken(label).replace(/-/g, '_')}_contract() {`,
      modRel ? `    let p = Path::new("${modRel}");` : '    let p = Path::new("Cargo.toml");',
      '    assert!(p.exists(), "expected target path to exist: {:?}", p);',
      '}',
      '',
    ].join('\n')
  }
  const canImportModule = Boolean(normImport && /\.(?:mjs|js|cjs)$/.test(modRel) && existsSync(join(repoRoot, modRel)))
  if (canImportModule) {
    return [
      "import assert from 'node:assert/strict'",
      "import test from 'node:test'",
      `import * as targetMod from '${normImport}'`,
      '',
      `test('${label} (${candidate.tier}): module loads and exposes expected exports', async () => {`,
      "  assert.equal(typeof targetMod, 'object')",
      '  const exportedKeys = Object.keys(targetMod)',
      "  assert.ok(Array.isArray(exportedKeys), 'exported keys should be inspectable')",
      "  for (const fnName of exportedKeys.filter((k) => typeof targetMod[k] === 'function')) {",
      "    assert.equal(typeof targetMod[fnName], 'function')",
      '  }',
      '})',
      '',
    ].join('\n')
  }
  const depthUp = testDir.split('/').filter(Boolean).map(() => '..').join('/') || '.'
  const isTsTarget = /\.(?:ts|tsx|mts|cts)$/i.test(relTest)
  if (isTsTarget) {
    const targetRel = modRel ?? 'README.md'
    const nodeRunner = detectNodeTestRunner(repoRoot)
    if (nodeRunner === 'vitest' || nodeRunner === 'jest') {
      const lines = [
        "import { existsSync, readFileSync } from 'node:fs'",
        "import { join, resolve } from 'node:path'",
      ]
      if (nodeRunner === 'vitest') lines.push("import { expect, test } from 'vitest'")
      lines.push(
        '',
        `const REPO_ROOT: string = existsSync(join(process.cwd(), '${targetRel}'))`,
        '  ? process.cwd()',
        `  : resolve(process.cwd(), '${depthUp}')`,
        '',
        `test('${label} (${candidate.tier}): target surface exists and stays non-empty', (): void => {`,
        `  const targetAbs: string = join(REPO_ROOT, '${targetRel}')`,
        '  expect(existsSync(targetAbs)).toBe(true)',
        "  const text: string = readFileSync(targetAbs, 'utf8')",
        '  expect(text.trim().length).toBeGreaterThan(0)',
        '})',
        '',
      )
      return lines.join('\n')
    }
    return [
      "import * as assert from 'node:assert/strict'",
      "import { existsSync, readFileSync } from 'node:fs'",
      "import { dirname, join, resolve } from 'node:path'",
      "import { test } from 'node:test'",
      "import { fileURLToPath } from 'node:url'",
      '',
      `const REPO_ROOT: string = resolve(dirname(fileURLToPath(import.meta.url)), '${depthUp}')`,
      '',
      `test('${label} (${candidate.tier}): target surface exists and stays non-empty', (): void => {`,
      `  const targetAbs: string = join(REPO_ROOT, '${targetRel}')`,
      '  assert.equal(existsSync(targetAbs), true, `target file missing: ${targetAbs}`)',
      "  const text: string = readFileSync(targetAbs, 'utf8')",
      "  assert.ok(text.trim().length > 0, 'target file must not be empty')",
      '})',
      '',
    ].join('\n')
  }
  return [
    "import assert from 'node:assert/strict'",
    "import { existsSync, readFileSync } from 'node:fs'",
    "import { dirname, join, resolve } from 'node:path'",
    "import test from 'node:test'",
    "import { fileURLToPath } from 'node:url'",
    '',
    `const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '${depthUp}')`,
    '',
    `test('${label} (${candidate.tier}): target surface exists and stays non-empty', () => {`,
    `  const targetAbs = join(REPO_ROOT, '${modRel ?? 'README.md'}')`,
    '  assert.equal(existsSync(targetAbs), true, `target file missing: ${targetAbs}`)',
    "  const text = readFileSync(targetAbs, 'utf8')",
    "  assert.ok(text.trim().length > 0, 'target file must not be empty')",
    '})',
    '',
  ].join('\n')
}

