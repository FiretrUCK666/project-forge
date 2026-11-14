/**
 * govern-tests.mjs -- Multi-ecosystem test inventory, neutral CI workflow detection,
 * and anti-bloat / quality audits for dev-govern.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'

import { posixPath, readJsonSafe } from '../../lib/git.mjs'
import { discoverWorkspacePackages, isProfileExplicitNone } from '../../lib/profile.mjs'
import {
  ASSERTION_RE, CODE_EXT_RE, TEST_CASE_RE, TEST_FILE_RE, TEST_SKIP_RE,
  stripCodeCommentsLines,
} from '../../lib/static-gates.mjs'
import { addFinding, readTextStrictInfo } from './govern-checks.mjs'

const PRIORITY_SCRIPT_HINTS = ['test', 'spec', 'e2e', 'lint', 'check', 'type', 'build', 'verify', 'ci']
const JUST_RECIPE_RE = /^@?([A-Za-z_][A-Za-z0-9_-]*)(?:\s+[^:\n]*)?:(?!=)/gm
const HEAVY_E2E_TOOL_RE = /\b(?:playwright|cypress|puppeteer|selenium|testcontainers|docker(?:\s+|-)compose)\b/i
const TARGET_FILTER_RE = /\{target\}|--changed|--related|--filter|-k\b|--grep\b|--testNamePattern|-t\b|--run\b/

const TEST_ONLY_RE = /(?:\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe)\s*\(|\{\s*only\s*:\s*true\b)/
const HARD_SLEEP_RULES = [
  /\bsetTimeout\s*\([^,\n]+,\s*(?:[1-9]\d{3,})\s*\)/,
  /\b(?:sleep|delay|waitForTimeout)\s*\(\s*(?:[1-9]\d{3,})\s*\)/,
  /\b(?:time|asyncio)\.sleep\s*\(\s*(?:[1-9]\d*(?:\.\d+)?)\s*\)/,
  /^\s*sleep\s+(?:[1-9]\d*(?:\.\d+)?)(?:\s|$)/,
  /\btime\.Sleep\s*\(\s*(?:[1-9]\d*\s*\*\s*time\.(?:Second|Minute)|(?:[1-9]\d{3,})\s*\*\s*time\.Millisecond)/,
  /\bthread::sleep\s*\(\s*Duration::(?:from_secs\s*\(\s*[1-9]|from_millis\s*\(\s*(?:[1-9]\d{3,}))/,
  /\bThread\.sleep\s*\(\s*(?:[1-9]\d{3,})\s*\)/,
]
const MOCK_SETUP_RE = /\b(?:vi\.fn|vi\.spyOn|jest\.fn|jest\.spyOn|mock\.fn|sinon\.(?:stub|spy|mock)|unittest\.mock|MagicMock|patch\.object|mock\.patch|mockReturnValue|mockResolvedValue|when\([^\n]+\)\.thenReturn)\b|\bpatch\s*\(/g
const MOCK_SPY_ASSERT_RE = /\bexpect\s*\((?:[^()\n]|\([^()\n]*\))+\)\s*(?:\.\s*not)?\s*\.\s*toHaveBeenCalled\w*\s*\([^)\n]*\)|[A-Za-z0-9_$.]+\s*\.\s*assert_(?:not_)?called(?:_once|_with|_once_with)?\s*\([^)\n]*\)|\bassert\s+[A-Za-z0-9_$.]+\s*\.\s*(?:called|calledOnce|calledTwice|calledThrice|call_count)\b[^\n]*|[A-Za-z0-9_$.]+\s*\.\s*(?:calledOnce|calledTwice|calledThrice|verify)\b(?:\s*\([^)\n]*\))?/
const UNIT_HEAVY_RE = /\b(?:playwright\.launch|chromium\.launch|firefox\.launch|webkit\.launch|puppeteer\.launch|ffmpeg|ffprobe|docker(?:\s+compose|\s+build|\s+run)|testcontainers)\b|['"](?:@playwright\/test|playwright|puppeteer|cypress|selenium-webdriver|testcontainers)['"]|(?:for\s*\([^;\n]*;\s*[^;\n]*<\s*(?:[5-9]\d{4,}|[1-9]\d{5,}|1e[5-9])|for\s+\w+\s+in\s+range\(\s*(?:[5-9]\d{4,}|[1-9]\d{5,}|100_000))/i
const NON_UNIT_TEST_RE = /(?:^|\/)(?:e2e|integration|browser|perf|benchmark|benchmarks|load|stress)\/|(?:\.(?:e2e|int|integration|perf|bench)\.[^/]+$)/i

const NEUTRAL_CI_CONFIGS = Object.freeze([
  '.circleci/config.yml',
  '.circleci/config.yaml',
  'azure-pipelines.yml',
  'azure-pipelines.yaml',
  'Jenkinsfile',
  '.travis.yml',
  '.drone.yml',
  '.buildkite/pipeline.yml',
  '.buildkite/pipeline.yaml',
  '.woodpecker.yml',
])

function extractYamlRunBlocks(relFile, text) {
  const steps = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:-\s*)?(?:run|script)\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const baseIndent = m[1].length + (lines[i].includes('- ') ? 2 : 0)
    const tail = m[2].trim()
    if (!tail || /^[|>][+-]?$/.test(tail)) {
      const blockLines = []
      let blockIndent = null
      for (let j = i + 1; j < lines.length; j += 1) {
        const raw = lines[j]
        if (!raw.trim()) { blockLines.push(''); continue }
        const curIndent = /^(\s*)/.exec(raw)[1].length
        if (blockIndent === null) {
          if (curIndent <= baseIndent) break
          blockIndent = curIndent
        } else if (curIndent < blockIndent) {
          break
        }
        blockLines.push(raw.slice(blockIndent))
        i = j
      }
      const cmd = blockLines.filter((l) => !l.trim().startsWith('#')).join('\n').trim()
      if (cmd) steps.push({ file: relFile, cmd })
    } else {
      const clean = tail.replace(/\s+#.*$/, '').trim()
      if (clean && !/^(?:true|false|null)$/i.test(clean)) steps.push({ file: relFile, cmd: clean })
    }
  }
  return steps
}

function parseWorkflowCiSteps(repoRoot) {
  const steps = []
  const ciConfigFiles = []

  const wfDir = join(repoRoot, '.github', 'workflows')
  if (existsSync(wfDir)) {
    try {
      for (const name of readdirSync(wfDir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
        const rel = `.github/workflows/${name}`
        ciConfigFiles.push(rel)
        const info = readTextStrictInfo(join(wfDir, name))
        if (info?.text) steps.push(...extractYamlRunBlocks(rel, info.text))
      }
    } catch { /* ignore */ }
  }

  for (const rel of NEUTRAL_CI_CONFIGS) {
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) continue
    ciConfigFiles.push(rel)
    const info = readTextStrictInfo(abs)
    if (!info?.text) continue
    if (rel === 'Jenkinsfile') {
      for (const m of info.text.matchAll(/\bsh\s+['"]([^'"]+)['"]/g)) {
        if (m[1]?.trim()) steps.push({ file: rel, cmd: m[1].trim() })
      }
    } else {
      steps.push(...extractYamlRunBlocks(rel, info.text))
    }
  }

  const wpDir = join(repoRoot, '.woodpecker')
  if (existsSync(wpDir)) {
    try {
      for (const name of readdirSync(wpDir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
        const rel = `.woodpecker/${name}`
        ciConfigFiles.push(rel)
        const info = readTextStrictInfo(join(wpDir, name))
        if (info?.text) steps.push(...extractYamlRunBlocks(rel, info.text))
      }
    } catch { /* ignore */ }
  }

  return { steps, ciConfigFiles: [...new Set(ciConfigFiles)].sort() }
}

function collectMakefileTargets(repoRoot) {
  const mkInfo = readTextStrictInfo(join(repoRoot, 'Makefile'))
  if (!mkInfo?.text) return { targets: [], recipes: new Map() }
  const targets = []
  const recipes = new Map()
  const lines = mkInfo.text.split('\n')
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

function collectJustfileRecipes(repoRoot) {
  for (const name of ['justfile', 'Justfile', '.justfile']) {
    const info = readTextStrictInfo(join(repoRoot, name))
    if (!info?.text) continue
    const list = []
    for (const m of info.text.matchAll(JUST_RECIPE_RE)) {
      if (!list.includes(m[1])) list.push(m[1])
      if (list.length >= 30) break
    }
    return list
  }
  return []
}

function expandVerificationCommands(repoRoot, ciSteps, devProfile, discovery) {
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
    ...ciSteps.map((s) => s.cmd),
    ...(devProfile['quick-test'] ?? []),
    ...(devProfile['full-test'] ?? []),
    ...(devProfile['smoke-verify'] ?? []),
    ...(devProfile['merge-gate'] ?? []),
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

function cmdCoversTestFile(commands, testRel) {
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

  for (const rawCmd of commands) {
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

function collectTestInventory(repoRoot, files, testFiles, ciSteps, ciConfigFiles, devProfile, discovery) {
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

  const scriptsDirFiles = files
    .filter((f) => f.rel.startsWith('scripts/') && /\.(?:sh|py|mjs|cjs|js|ts|ps1)$/i.test(f.name))
    .map((f) => f.rel)
    .slice(0, 25)
  if (scriptsDirFiles.length > 0) definedScripts.scriptsDir = scriptsDirFiles

  const profileCmds = []
  for (const k of ['quick-test', 'full-test', 'smoke-verify', 'merge-gate']) {
    for (const c of devProfile[k] ?? []) profileCmds.push(`${k}: ${c}`)
  }
  if (profileCmds.length > 0) definedScripts.devProfile = profileCmds
  if (ciSteps.length > 0) definedScripts.ciRunSteps = ciSteps.slice(0, 30).map((s) => `${s.file}: ${s.cmd}`)

  const dirCounts = new Map()
  for (const tf of testFiles) {
    const parts = tf.rel.split('/').filter(Boolean)
    const bucket = parts.length >= 2 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '.'
    dirCounts.set(bucket, (dirCounts.get(bucket) ?? 0) + 1)
  }
  const testDirectories = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 15)
    .map(([dir, count]) => ({ dir, files: count }))

  return {
    totalTestFiles: testFiles.length,
    testDirectories,
    definedScripts,
    ciConfigFiles,
    hasCiConfig: ciSteps.length > 0 || ciConfigFiles.length > 0,
  }
}

export function auditTests(repoRoot, files, devProfile, rawAgentsMeta, findings) {
  const codeFiles = files.filter((f) => CODE_EXT_RE.test(f.name) && !TEST_FILE_RE.test(f.rel))
  const testFiles = files.filter((f) => CODE_EXT_RE.test(f.name) && TEST_FILE_RE.test(f.rel))
  const discovery = discoverWorkspacePackages(repoRoot, files.map((f) => f.rel))

  if (codeFiles.length > 0 && testFiles.length === 0) {
    addFinding(findings, {
      id: 'tests.missing-suite',
      category: 'tests',
      severity: 'medium',
      title: `Found ${codeFiles.length} code file(s) but no test files in scope`,
      action: 'Add unit or smoke tests covering core behavior and failure cases.',
    })
  }

  const { steps: ciSteps, ciConfigFiles } = parseWorkflowCiSteps(repoRoot)
  const testInventory = collectTestInventory(repoRoot, files, testFiles, ciSteps, ciConfigFiles, devProfile, discovery)
  const hasProfileRunners = (devProfile['quick-test']?.length ?? 0) > 0
    || (devProfile['full-test']?.length ?? 0) > 0
    || (devProfile['smoke-verify']?.length ?? 0) > 0
    || (devProfile['merge-gate']?.length ?? 0) > 0
  const hasRunnerConfig = ciSteps.length > 0 || hasProfileRunners
  const expandedCommands = hasRunnerConfig ? expandVerificationCommands(repoRoot, ciSteps, devProfile, discovery) : []

  if (!testInventory.hasCiConfig && testFiles.length > 0) {
    addFinding(findings, {
      id: 'tests.no-ci-config',
      category: 'tests',
      severity: 'low',
      title: 'No CI workflow config found (.github/workflows/*.yml or neutral CI config); orphan analysis checked local Dev Profile and scripts only',
      action: 'Add CI workflow running merge-gate/full-test so test execution is objectively enforced.',
    })
  }

  const normCmd = (c) => String(c ?? '').trim().replace(/\s+/g, ' ')
  const quickCmds = (devProfile['quick-test'] ?? []).map(normCmd).filter(Boolean)
  const fullCmds = (devProfile['full-test'] ?? []).map(normCmd).filter(Boolean)
  const gateCmds = (devProfile['merge-gate'] ?? []).map(normCmd).filter(Boolean)

  if (
    quickCmds.some((q) => HEAVY_E2E_TOOL_RE.test(q))
    || (testFiles.length >= 3 && quickCmds.length > 0 && quickCmds.some((q) => fullCmds.includes(q) || gateCmds.includes(q)))
  ) {
    addFinding(findings, {
      id: 'tests.collapsed-tiers',
      category: 'tests',
      severity: 'medium',
      file: 'AGENTS.md',
      title: 'Dev Profile quick-test collapses slow full-test/E2E into routine fast iteration',
      action: 'Separate quick-test (second-level unit filter with {target}) from heavy full-test / E2E / merge-gate.',
    })
  }

  if (testFiles.length >= 5 && quickCmds.length > 0 && !quickCmds.some((q) => TARGET_FILTER_RE.test(q))) {
    addFinding(findings, {
      id: 'tests.unfiltered-quick-test',
      category: 'tests',
      severity: 'low',
      file: 'AGENTS.md',
      title: `quick-test runs across ${testFiles.length} test files without {target} or changed/filter narrowing`,
      action: 'Parameterize quick-test with {target} (or --filter/--changed) so each edit round only runs related unit tests.',
    })
  }

  for (const f of testFiles) {
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    const lines = info.text.split('\n')
    const codeLines = stripCodeCommentsLines(info.text, ext)
    const codeOnlyText = codeLines.join('\n')
    const isMetaFixtureHarness = /(?:^|\/)(?:fixtures|verify-injections|gap-coverage)\.[^/]+$/i.test(f.rel)
      || /\bfunction\s+tmpProject\s*\(/.test(info.text)

    let actualSkipCount = 0
    let testDeclCount = 0

    for (let i = 0; i < lines.length; i += 1) {
      if (TEST_CASE_RE.test(codeLines[i])) testDeclCount += 1
      if (TEST_SKIP_RE.test(codeLines[i])) {
        if (!TEST_ONLY_RE.test(codeLines[i])) actualSkipCount += 1
        addFinding(findings, {
          id: `tests.skip.${f.rel}:${i + 1}`,
          category: 'tests',
          severity: 'medium',
          file: f.rel,
          line: i + 1,
          title: `Skipped or focused test marker in ${f.rel}:${i + 1}`,
          detail: lines[i].trim().slice(0, 100),
          action: 'Re-enable test or remove .only/.skip before merge.',
        })
      }
    }

    if (actualSkipCount > 0 && testDeclCount <= actualSkipCount) {
      addFinding(findings, {
        id: `tests.all-skipped.${f.rel}`,
        category: 'tests',
        severity: 'high',
        file: f.rel,
        title: `All tests skipped in ${f.rel} (${actualSkipCount} skipped, 0 active)`,
        action: 'Restore assertions/tests or delete obsolete skipped suite instead of carrying green-looking dead tests.',
      })
    }

    const isExplicitTestFile = /\.(?:test|spec)\.[^/]+$|_test\.[^/]+$|^test_[^/]+\.py$|(?:Tests?|IT)\.(?:java|kt|cs|swift)$|_unittest\.(?:cc|cpp)$/i.test(f.name)
      || testDeclCount > 0
    if (isExplicitTestFile && !ASSERTION_RE.test(codeOnlyText)) {
      addFinding(findings, {
        id: `tests.zero-assertion.${f.rel}`,
        category: 'tests',
        severity: 'medium',
        file: f.rel,
        title: `Zero-assertion test file: ${f.rel}`,
        action: 'Add real behavioral assertions (expect/assert) so failures cannot silently pass.',
      })
    }

    if (hasRunnerConfig && isExplicitTestFile && !cmdCoversTestFile(expandedCommands, f.rel)) {
      addFinding(findings, {
        id: `tests.orphan-suite.${f.rel}`,
        category: 'tests',
        severity: 'medium',
        file: f.rel,
        title: `Orphan test suite not covered by CI or Dev Profile: ${f.rel}`,
        action: `Wire "${f.rel}" into CI workflow steps or AGENTS.md quick-test/full-test/merge-gate.`,
      })
    }

    if (isMetaFixtureHarness) continue

    if (!NON_UNIT_TEST_RE.test(f.rel)) {
      for (let i = 0; i < codeLines.length; i += 1) {
        if (HARD_SLEEP_RULES.some((re) => re.test(codeLines[i]))) {
          addFinding(findings, {
            id: `tests.hard-sleep.${f.rel}`,
            category: 'tests',
            severity: 'medium',
            file: f.rel,
            line: i + 1,
            title: `Hard-coded sleep >= 1s in unit test ${f.rel}:${i + 1}`,
            detail: codeLines[i].trim().slice(0, 100),
            action: 'Replace fixed long sleeps with event/condition polling or fake timers.',
          })
          break
        }
      }
    }

    if (isExplicitTestFile && !NON_UNIT_TEST_RE.test(f.rel)) {
      let heavyLine = -1
      for (let i = 0; i < codeLines.length; i += 1) {
        if (UNIT_HEAVY_RE.test(codeLines[i])) { heavyLine = i + 1; break }
        if (/for\s*\(/.test(codeLines[i]) && /\b(?:height|rows|img)\b/i.test(codeLines[i])) {
          const nearby = codeLines.slice(i + 1, i + 4).join('\n')
          if (/for\s*\(/.test(nearby) && /\b(?:width|cols|pixel)\b/i.test(nearby)) { heavyLine = i + 1; break }
        }
      }
      if (heavyLine > 0) {
        addFinding(findings, {
          id: `tests.heavy-in-unit.${f.rel}`,
          category: 'tests',
          severity: 'medium',
          file: f.rel,
          line: heavyLine,
          title: `Heavy loop or browser/container launch inside unit-tier test: ${f.rel}:${heavyLine}`,
          action: 'Move heavy E2E/container/pixel workloads to full-test/e2e or shrink fixture dimensions.',
        })
      }
    }

    if (isExplicitTestFile) {
      const mockCount = (codeOnlyText.match(MOCK_SETUP_RE) ?? []).length
      const hasSpyAssert = MOCK_SPY_ASSERT_RE.test(codeOnlyText)
      const nonSpyCode = codeOnlyText.replace(new RegExp(MOCK_SPY_ASSERT_RE.source, 'g'), '')
      const hasRealAssertion = ASSERTION_RE.test(nonSpyCode)
      if (mockCount >= 5 && hasSpyAssert && !hasRealAssertion) {
        addFinding(findings, {
          id: `tests.mock-tautology.${f.rel}`,
          category: 'tests',
          severity: 'medium',
          file: f.rel,
          title: `Mock-tautology test with ${mockCount} mock setups and 0 behavioral SUT assertions: ${f.rel}`,
          action: 'Test real module outputs/state transitions instead of verifying mock call plumbing or mocked return values.',
        })
      }
    }

    if (!NON_UNIT_TEST_RE.test(f.rel) && lines.length > 800) {
      addFinding(findings, {
        id: `tests.oversized-file.${f.rel}`,
        category: 'tests',
        severity: 'low',
        file: f.rel,
        title: `Oversized unit test file (${lines.length} lines > 800): ${f.rel}`,
        action: 'Split oversized test file by feature/module so quick-test {target} stays fast.',
      })
    }

    const hasHeadlessOrTempGuard = /\bprocess\.env\.(?:CI|HEADLESS|DISPLAY)|os\.environ|headless\s*:\s*(?:true|Boolean|process\.env)/i.test(codeOnlyText)
    const hasTempHomeGuard = /\b(?:mkdtemp|tmpdir|tmp_path|tempdir|HOME\s*=|USERPROFILE\s*=)\b/i.test(codeOnlyText)
    const explicitHeaded = (/\bheadless\s*:\s*false\b|--headed\b/i.test(codeOnlyText) && !hasHeadlessOrTempGuard)
      || (/\b(?:pyautogui|pynput|NSApplication\.shared|robot\.mouseClick|osascript)\b/i.test(codeOnlyText) && !hasHeadlessOrTempGuard)
    const touchesRealHome = /(?:\b(?:os\.homedir\(\)|Path\.home\(\)|expanduser\(["']~)|["']~\/\.(?:config|local|ssh|aws|kube|gemini|claude))/i.test(codeOnlyText)
      && !hasTempHomeGuard
    if (explicitHeaded || touchesRealHome) {
      addFinding(findings, {
        id: `tests.non-headless.${f.rel}`,
        category: 'tests',
        severity: 'medium',
        file: f.rel,
        title: explicitHeaded
          ? `Non-headless GUI or headed browser test without headless/CI guard: ${f.rel}`
          : `Test accesses user home config directly without temp dir / HOME isolation: ${f.rel}`,
        action: 'Run tests headlessly and isolate config/filesystem state in temp directories.',
      })
    }
  }

  const hasExplicitQuickOrFull = rawAgentsMeta.hasQuickKey || rawAgentsMeta.hasFullKey
    || isProfileExplicitNone(devProfile, 'quick-test') || isProfileExplicitNone(devProfile, 'full-test')
  if (existsSync(join(repoRoot, 'AGENTS.md')) && !hasExplicitQuickOrFull && devProfile['quick-test'].length === 0 && devProfile['full-test'].length === 0) {
    addFinding(findings, {
      id: 'tests.no-dev-profile',
      category: 'tests',
      severity: 'low',
      file: 'AGENTS.md',
      title: 'AGENTS.md has no quick-test: or full-test: Dev Profile commands',
      action: 'Populate quick-test: / full-test: keys in AGENTS.md (or set `none` for pure-doc repos).',
    })
  }

  return { ciRunSteps: ciSteps, testInventory }
}
