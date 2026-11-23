/**
 * govern-tests.mjs -- Multi-ecosystem test inventory, neutral CI workflow detection,
 * and anti-bloat / quality audits for dev-govern.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { readTextSafe } from '../../lib/git.mjs'
import { detectGitModeMarkers } from '../../lib/platform.mjs'
import { discoverWorkspacePackages, isProfileExplicitNone, readDecisions } from '../../lib/profile.mjs'
import {
  classifyTestFileTier, detectTestTierMetadata, scanNeutralCiSteps,
} from '../../lib/profile-sniffer.mjs'
import {
  ASSERTION_RE, CODE_EXT_RE, HARD_SLEEP_RULES, MOCK_SETUP_RE, MOCK_SPY_ASSERT_RE,
  TEST_CASE_RE, TEST_FILE_RE, TEST_SKIP_RE, isMetaTestHarness, isTestOrFixtureFile, stripCodeCommentsLines,
} from '../../lib/static-gates.mjs'
import {
  cmdCoversTestFile, collectConfiguredTestEntries, collectTestInventory, expandVerificationCommands,
} from '../../lib/test-inventory.mjs'
import { addFinding, readTextStrictInfo } from './govern-checks.mjs'

const HEAVY_E2E_TOOL_RE = /\b(?:playwright|cypress|puppeteer|selenium|testcontainers|docker(?:\s+|-)compose)\b/i
const TARGET_FILTER_RE = /\{target\}|--changed|--related|--filter|-k\b|--grep\b|--testNamePattern|-t\b|--run\b/
const UNIT_SCOPED_QUICK_RE = /(?:test:unit\b|--lib\b|-m\s+["']?not\s+(?:e2e|integration|slow)|(?:^|\s)tests?\/unit\b)/i

const TEST_ONLY_RE = /(?:\b(?:it|test|describe|context|suite)\.only\s*\(|\b(?:fit|fdescribe)\s*\(|\{\s*only\s*:\s*true\b)/
const UNIT_HEAVY_RE = /\b(?:playwright\.launch|chromium\.launch|firefox\.launch|webkit\.launch|puppeteer\.launch|ffmpeg|ffprobe|docker(?:\s+compose|\s+build|\s+run)|testcontainers)\b|['"](?:@playwright\/test|playwright|puppeteer|cypress|selenium-webdriver|testcontainers)['"]|(?:for\s*\([^;\n]*;\s*[^;\n]*<\s*(?:[5-9]\d{4,}|[1-9]\d{5,}|1e[5-9])|for\s+\w+\s+in\s+range\(\s*(?:[5-9]\d{4,}|[1-9]\d{5,}|100_000))/i

function parseWorkflowCiSteps(repoRoot) {
  return scanNeutralCiSteps(repoRoot)
}

function isPureLocalOrNoCiRepo(repoRoot) {
  const agentsText = readTextSafe(join(repoRoot, 'AGENTS.md')) ?? ''
  if (readDecisions(agentsText).has('no-ci')) return true
  const dotGit = join(repoRoot, '.git')
  if (!existsSync(dotGit)) return true
  try {
    const st = statSync(dotGit)
    let gitDir = dotGit
    let commonDir = dotGit
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/im.exec(readTextSafe(dotGit) ?? '')
      if (m) {
        gitDir = resolve(repoRoot, m[1].trim())
        const cm = readTextSafe(join(gitDir, 'commondir'))
        commonDir = cm ? resolve(gitDir, cm.trim()) : gitDir
      }
    }
    const cfg = readTextSafe(join(commonDir, 'config')) ?? ''
    const hasRemote = /^\s*\[remote\s+"[^"]+"\]/m.test(cfg)
    const markers = detectGitModeMarkers(gitDir, { hasRemote })
    if (markers.localMode) return true
    return !hasRemote
  } catch {
    return false
  }
}

const CLASS_DECL_LINE_RE = /^\s*(?:public\s+|internal\s+|private\s+|protected\s+|abstract\s+|final\s+|export\s+(?:default\s+)?)*class\s+/

function extractTestClassInheritance(codeOnlyText, ext) {
  const definedClasses = []
  const allParents = []
  const pushParent = (raw, arr) => {
    const clean = String(raw ?? '').trim().replace(/<.*$/, '').replace(/\(.*$/, '').trim()
    if (!clean || clean === 'object') return
    const shortName = clean.split(/[.:]/).pop()
    if (shortName && !arr.includes(shortName)) arr.push(shortName)
    if (clean !== shortName && !arr.includes(clean)) arr.push(clean)
  }
  const addDef = (name, parents) => {
    definedClasses.push({ name, parents })
    for (const p of parents) if (!allParents.includes(p)) allParents.push(p)
  }

  if (ext === 'py') {
    for (const m of codeOnlyText.matchAll(/^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*:/gm)) {
      const parents = []
      for (const seg of (m[2] ?? '').split(',')) pushParent(seg, parents)
      addDef(m[1], parents)
    }
  } else if (ext === 'kt' || ext === 'kts' || ext === 'cs') {
    for (const m of codeOnlyText.matchAll(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^>]*>)?(?:\s*\([^)]*\))?(?:\s*:\s*([A-Za-z_][A-Za-z0-9_.,\s<>()]*))?/gm)) {
      const parents = []
      for (const seg of (m[2] ?? '').split(',')) pushParent(seg, parents)
      addDef(m[1], parents)
    }
  } else if (ext === 'rb') {
    for (const m of codeOnlyText.matchAll(/^\s*class\s+([A-Za-z_][A-Za-z0-9_:]*)(?:\s*<\s*([A-Za-z_][A-Za-z0-9_:]*))?/gm)) {
      const parents = []
      if (m[2]) pushParent(m[2], parents)
      addDef(m[1].split('::').pop(), parents)
    }
  } else {
    for (const m of codeOnlyText.matchAll(/\bclass\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*<[^>]*>)?(?:\s+extends\s+([A-Za-z_$][A-Za-z0-9_$.]*))?/gm)) {
      const parents = []
      if (m[2]) pushParent(m[2], parents)
      addDef(m[1], parents)
    }
  }
  return { definedClasses, allParents }
}

function resolveInheritedTestCapabilities(parents, classIndex) {
  let hasAssertions = false
  let hasTests = false
  const queue = [...(parents ?? [])]
  const visited = new Set()
  let depth = 0
  while (queue.length > 0 && depth < 32) {
    depth += 1
    const name = queue.shift()
    if (!name || visited.has(name)) continue
    visited.add(name)
    const entries = classIndex.get(name)
    if (!entries) continue
    for (const ent of entries) {
      if (ent.hasAssertions) hasAssertions = true
      if (ent.hasTests) hasTests = true
      for (const p of ent.parents) if (!visited.has(p)) queue.push(p)
    }
  }
  return { hasAssertions, hasTests }
}

function hasClassLevelSkipMarker(codeLines) {
  for (let i = 0; i < codeLines.length; i += 1) {
    if (!TEST_SKIP_RE.test(codeLines[i])) continue
    for (let j = i; j <= Math.min(codeLines.length - 1, i + 2); j += 1) {
      if (CLASS_DECL_LINE_RE.test(codeLines[j])) return true
    }
  }
  return false
}

export function auditTests(repoRoot, files, devProfile, rawAgentsMeta, findings) {
  const discovery = discoverWorkspacePackages(repoRoot, files.map((f) => f.rel))

  const { steps: ciSteps, ciConfigFiles } = parseWorkflowCiSteps(repoRoot)
  const hasProfileRunners = (devProfile['quick-test']?.length ?? 0) > 0
    || (devProfile['full-test']?.length ?? 0) > 0
    || (devProfile['smoke-verify']?.length ?? 0) > 0
    || (devProfile['merge-gate']?.length ?? 0) > 0
  const hasRunnerConfig = ciSteps.length > 0 || hasProfileRunners
  const expandedCommands = hasRunnerConfig ? expandVerificationCommands(repoRoot, ciSteps, devProfile, discovery) : []
  const { configuredTestEntries, hasExecutableRunner } = collectConfiguredTestEntries(repoRoot, files, expandedCommands)
  const configuredSet = new Set(configuredTestEntries)
  const codeFiles = files.filter((f) => CODE_EXT_RE.test(f.name) && !isTestOrFixtureFile(f.rel) && !configuredSet.has(f.rel))
  const testFiles = files.filter((f) => CODE_EXT_RE.test(f.name) && TEST_FILE_RE.test(f.rel))
  const testInventory = collectTestInventory(repoRoot, files, testFiles, ciSteps, ciConfigFiles, devProfile, discovery, configuredTestEntries)

  if (codeFiles.length > 0 && testInventory.totalTestFiles === 0 && configuredTestEntries.length === 0 && !hasExecutableRunner) {
    addFinding(findings, {
      id: 'tests.missing-suite',
      category: 'tests',
      severity: 'medium',
      title: `Found ${codeFiles.length} code file(s) but no test files or configured Dev Profile / CI test runners in scope`,
      action: 'Add unit or smoke tests covering core behavior and failure cases.',
    })
  }

  if (!testInventory.hasCiConfig && !isPureLocalOrNoCiRepo(repoRoot) && (testFiles.length > 0 || configuredTestEntries.length > 0)) {
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

  const tierMeta = detectTestTierMetadata(repoRoot, files.map((f) => f.rel))
  const tierCounts = { unit: 0, integration: 0, e2e: 0 }
  let totalTestLines = 0

  const parsedTestFiles = []
  const testClassIndex = new Map()
  for (const f of testFiles) {
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const ext = f.name.split('.').pop()?.toLowerCase() ?? ''
    const lines = info.text.split('\n')
    const codeLines = stripCodeCommentsLines(info.text, ext)
    const codeOnlyText = codeLines.join('\n')
    const classInfo = extractTestClassInheritance(codeOnlyText, ext)
    const hasAssertions = ASSERTION_RE.test(codeOnlyText)
    const hasTests = TEST_CASE_RE.test(codeOnlyText) || /\bdef\s+test_/.test(codeOnlyText) || /@(?:Test|ParameterizedTest)\b/.test(codeOnlyText)
    for (const cls of classInfo.definedClasses) {
      if (!testClassIndex.has(cls.name)) testClassIndex.set(cls.name, [])
      testClassIndex.get(cls.name).push({ file: f.rel, parents: cls.parents, hasAssertions, hasTests })
    }
    parsedTestFiles.push({ f, info, ext, lines, codeLines, codeOnlyText, classInfo })
  }

  for (const item of parsedTestFiles) {
    const { f, info, ext, lines, codeLines, codeOnlyText, classInfo } = item
    totalTestLines += lines.length
    const { tier: fileTier } = classifyTestFileTier(f.rel, info.text, tierMeta)
    tierCounts[fileTier] = (tierCounts[fileTier] ?? 0) + 1
    const isUnitTier = fileTier === 'unit'
    const isMetaFixtureHarness = isMetaTestHarness(f.rel, info.text)
    const inherited = resolveInheritedTestCapabilities(classInfo.allParents, testClassIndex)

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

    if (actualSkipCount > 0 && testDeclCount <= actualSkipCount && (!inherited.hasTests || hasClassLevelSkipMarker(codeLines))) {
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
    const isGoTest = /\.go$/i.test(f.name)
    const hasGoUnitTestFunc = isGoTest && /\bfunc\s+Test[A-Z0-9_]\w*\s*\(/.test(codeOnlyText)
    const hasGoBenchOrExampleFunc = isGoTest && /\bfunc\s+(?:Benchmark|Example)[A-Z0-9_]\w*\s*\(/.test(codeOnlyText)
    const isGoBenchOrExampleOnly = isGoTest && !hasGoUnitTestFunc && (
      /_(?:bench|example)_test\.go$/i.test(f.name) || hasGoBenchOrExampleFunc
    )
    if (isExplicitTestFile && !isGoBenchOrExampleOnly && !ASSERTION_RE.test(codeOnlyText) && !inherited.hasAssertions) {
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

    if (isUnitTier) {
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

    if (isExplicitTestFile && isUnitTier) {
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

    if (isUnitTier && lines.length > 800) {
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

  const hasNonUnitTier = (tierCounts.e2e + tierCounts.integration) > 0 || tierMeta.hasMultiTierConfig
  const hasNarrowQuick = quickCmds.some((q) => TARGET_FILTER_RE.test(q) || UNIT_SCOPED_QUICK_RE.test(q))
  const needsQuickFilter = testFiles.length >= 15 || totalTestLines >= 2500 || (hasNonUnitTier && testFiles.length >= 5)
  if (quickCmds.length > 0 && !hasNarrowQuick && needsQuickFilter) {
    addFinding(findings, {
      id: 'tests.unfiltered-quick-test',
      category: 'tests',
      severity: 'low',
      file: 'AGENTS.md',
      title: `quick-test runs across ${testFiles.length} test files (${tierCounts.unit} unit / ${tierCounts.integration} integration / ${tierCounts.e2e} e2e) without {target} or unit-tier narrowing`,
      action: 'Parameterize quick-test with {target} (or --filter/--changed/test:unit) so each edit round only runs fast unit tests.',
    })
  }
  testInventory.tierSummary = { ...tierCounts, hasMultiTierConfig: tierMeta.hasMultiTierConfig, totalTestLines }

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
