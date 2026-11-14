/**
 * survey-reentry.mjs —— 通用技能容器探测、`.pf-manifest.json`（v1/v2）读取与重入失步诊断。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import * as protocol from './protocol.mjs'
import {
  isMacMetadataName,
  posixPath,
  readTextSafe,
  skillVersion,
} from './text.mjs'
import {
  CODE_EXT,
  SKIP_DIRS,
  detectSkillKind,
  isJunkFile,
} from './survey-ecosystem.mjs'

const KIT_SKILLS = protocol.KIT_SKILLS ?? ['dev-explore', 'dev-plan', 'dev-flow', 'dev-review', 'dev-govern']
const PF_MANIFEST_REL = protocol.PF_MANIFEST_REL ?? '.agents/skills/.pf-manifest.json'

function scanManagedSkillDir(baseRel, root) {
  const full = join(root, baseRel)
  if (!existsSync(full)) return []
  let entries = []
  try {
    entries = readdirSync(full, { withFileTypes: true })
      .filter((e) => !isMacMetadataName(e.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch { return [] }
  const out = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const sub = join(full, entry.name)
    if (!existsSync(join(sub, 'SKILL.md')) && !existsSync(join(sub, 'skill.md'))) continue
    const meta = detectSkillKind(sub)
    out.push({
      dirName: entry.name,
      name: meta?.skillMeta?.name || entry.name,
      path: `${baseRel}/${entry.name}`,
      ...(meta?.skillMeta?.summary ? { summary: meta.skillMeta.summary } : {}),
      valid: meta?.skillMeta?.hasValidFrontmatter === true,
    })
  }
  return out
}

/** 通用技能容器扫描：查找 `skills/<name>/SKILL.md` 及任意隐藏/顶层容器 `<dir>/skills/<name>/SKILL.md`。 */
function discoverSkillContainers(root, { hiddenOnly = false } = {}) {
  const containers = []
  if (!hiddenOnly && existsSync(join(root, 'skills'))) {
    containers.push('skills')
  }
  let topEntries = []
  try {
    topEntries = readdirSync(root, { withFileTypes: true })
      .filter((e) => !isMacMetadataName(e.name))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  } catch { return containers }
  for (const entry of topEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name === '.git' || entry.name === '.worktrees' || SKIP_DIRS.has(entry.name)) continue
    if (hiddenOnly && !entry.name.startsWith('.')) continue
    const candidate = `${entry.name}/skills`
    if (existsSync(join(root, entry.name, 'skills'))) {
      containers.push(candidate)
    }
  }
  return [...new Set(containers)]
}

export function detectLocalSkills(root) {
  const found = []
  for (const dir of discoverSkillContainers(root)) {
    for (const item of scanManagedSkillDir(dir, root)) {
      found.push({
        path: item.path,
        name: item.name === item.dirName ? undefined : item.name,
        ...(item.summary ? { summary: item.summary } : {}),
        valid: item.valid,
      })
    }
  }
  return found
}

function hashMatchesNormalized(filePath, expectedHash) {
  try {
    const buf = readFileSync(filePath)
    if (createHash('sha256').update(buf).digest('hex') === expectedHash) return true
    if (!buf.subarray(0, 4096).includes(0)) {
      const lfBuf = Buffer.from(buf.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
      return createHash('sha256').update(lfBuf).digest('hex') === expectedHash
    }
    return false
  } catch {
    return false
  }
}

export function detectKit(root) {
  const skillsRoot = join(root, '.agents', 'skills')
  const manifestFull = join(root, PF_MANIFEST_REL)
  const manifestExists = existsSync(manifestFull)
  const hiddenContainers = discoverSkillContainers(root, { hiddenOnly: true })
  const allHiddenSkills = hiddenContainers.flatMap((dir) => scanManagedSkillDir(dir, root))
  const agentsSkills = scanManagedSkillDir('.agents/skills', root)
  const installedSkills = agentsSkills.map((s) => s.dirName)
  const managedSkills = KIT_SKILLS.filter((k) => installedSkills.includes(k))
  const customSkills = allHiddenSkills
    .filter((s) => !KIT_SKILLS.includes(s.dirName))
    .map(({ name, path, summary, valid }) => ({
      name,
      path,
      ...(summary ? { summary } : {}),
      valid,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  if (!manifestExists) {
    return {
      present: installedSkills.length > 0,
      manifestExists: false,
      manifestValid: false,
      corrupted: false,
      manifestPath: undefined,
      schemaVersion: undefined,
      tier: undefined,
      forgeVersion: undefined,
      installedAt: undefined,
      filesCount: 0,
      missingFiles: [],
      modifiedFiles: [],
      disabledSkills: [],
      removedFiles: [],
      customizedFiles: [],
      removedAgentsRegions: [],
      versionMismatch: false,
      drifted: false,
      installedSkills,
      managedSkills,
      customSkills,
      kitSkillsCovered: managedSkills,
      agentsRegions: [],
    }
  }

  const rawText = readTextSafe(manifestFull)
  let manifest
  try { manifest = rawText ? JSON.parse(rawText) : null } catch { manifest = null }
  const manifestValid = Boolean(
    manifest
    && typeof manifest === 'object'
    && (manifest.schemaVersion === 1 || manifest.schemaVersion === 2)
    && manifest.files
    && typeof manifest.files === 'object'
    && !Array.isArray(manifest.files),
  )

  if (!manifestValid) {
    return {
      present: true,
      manifestExists: true,
      manifestValid: false,
      corrupted: true,
      manifestPath: PF_MANIFEST_REL,
      schemaVersion: manifest?.schemaVersion,
      tier: manifest?.tier,
      forgeVersion: manifest?.forgeVersion,
      installedAt: manifest?.installedAt,
      filesCount: 0,
      missingFiles: [],
      modifiedFiles: [],
      disabledSkills: [],
      removedFiles: [],
      customizedFiles: [],
      removedAgentsRegions: [],
      versionMismatch: false,
      drifted: true,
      installedSkills,
      managedSkills,
      customSkills,
      kitSkillsCovered: managedSkills,
      agentsRegions: [],
    }
  }

  const disabledSkills = Array.isArray(manifest.disabledSkills)
    ? [...new Set(manifest.disabledSkills.map(String))].sort()
    : []
  const disabledSet = new Set(disabledSkills)
  const removedFiles = Array.isArray(manifest.removedFiles)
    ? [...new Set(manifest.removedFiles.map((p) => posixPath(p)))].sort()
    : (manifest.removedFiles && typeof manifest.removedFiles === 'object'
        ? Object.keys(manifest.removedFiles).map((p) => posixPath(p)).sort()
        : [])
  const removedSet = new Set(removedFiles)
  const customizedFiles = manifest.customizedFiles && typeof manifest.customizedFiles === 'object' && !Array.isArray(manifest.customizedFiles)
    ? Object.keys(manifest.customizedFiles).map((p) => posixPath(p)).sort()
    : []
  const customizedSet = new Set(customizedFiles)
  const removedAgentsRegions = Array.isArray(manifest.removedAgentsRegions)
    ? [...new Set(manifest.removedAgentsRegions.map(String))].sort()
    : []

  const missingFiles = []
  const modifiedFiles = []
  const fileKeys = Object.keys(manifest.files)
  for (const rel of fileKeys) {
    const entry = manifest.files[rel]
    const normRel = posixPath(rel)
    const topSkill = normRel.split('/')[0]
    if (removedSet.has(normRel) || disabledSet.has(topSkill)) continue
    const abs = normRel.startsWith('.agents/skills/')
      ? join(root, normRel)
      : join(skillsRoot, normRel)
    if (!existsSync(abs)) {
      missingFiles.push(normRel)
      continue
    }
    if (customizedSet.has(normRel)) continue
    const expectedHash = typeof entry === 'string' ? entry : entry?.sha256
    if (expectedHash && !hashMatchesNormalized(abs, expectedHash)) {
      modifiedFiles.push(normRel)
    }
  }

  const skillRootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const expectedForgeVersion = skillVersion(readTextSafe(join(skillRootDir, 'SKILL.md')))
  const versionMismatch = Boolean(
    expectedForgeVersion
    && manifest.forgeVersion
    && manifest.forgeVersion !== expectedForgeVersion,
  )
  const agentsRegions = manifest.agentsRegions && typeof manifest.agentsRegions === 'object'
    ? Object.keys(manifest.agentsRegions)
    : []
  const tier = manifest.tier === 'lightweight' || manifest.tier === 'full'
    ? manifest.tier
    : (manifest.schemaVersion === 1 ? 'full' : undefined)

  return {
    present: true,
    manifestExists: true,
    manifestValid: true,
    corrupted: false,
    manifestPath: PF_MANIFEST_REL,
    schemaVersion: manifest.schemaVersion,
    tier,
    forgeVersion: manifest.forgeVersion,
    installedAt: manifest.installedAt,
    filesCount: fileKeys.length,
    missingFiles,
    modifiedFiles,
    disabledSkills,
    removedFiles,
    customizedFiles,
    removedAgentsRegions,
    versionMismatch,
    drifted: missingFiles.length > 0 || modifiedFiles.length > 0 || versionMismatch,
    installedSkills,
    managedSkills,
    customSkills,
    kitSkillsCovered: managedSkills,
    agentsRegions,
  }
}

const TDD_SOURCE_PATH_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|mts|cts|py|go|rs|java|kt|kts|rb|php|cs|c|cpp|cc|h|hpp|m|mm|swift|sh|ps1|json|ya?ml|toml|sql|vue|svelte)$/i
const TDD_IGNORED_PREFIXES = ['docs/', 'node_modules/', '.worktrees/', '.git/']
const UNREGISTERED_SKIP_TOP_DIRS = new Set([
  ...SKIP_DIRS,
  '.git', '.agents', '.github', '.vscode', '.worktrees', '.husky', '.changeset',
  'docs', 'scripts', 'tests', 'test', '__tests__',
])

export function detectTddStalePaths(root, tddRel) {
  if (!tddRel) return []
  const text = readTextSafe(join(root, tddRel))
  if (!text) return []
  const source = text.replace(/\r\n/g, '\n')
  const snippets = []
  for (const m of source.matchAll(/`([^`\n]+)`/g)) snippets.push(m[1])
  for (const block of source.matchAll(/```[a-zA-Z0-9_-]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      snippets.push(line.replace(/(?:^|\s)#.*$/, ''))
    }
  }
  const stale = new Set()
  for (const chunk of snippets) {
    for (const rawToken of chunk.split(/[\s,;()]+/)) {
      const clean = rawToken.trim().replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')
      if (!clean || clean.endsWith('/') || !clean.includes('/')) continue
      if (/^(?:https?:|mailto:|git@|ssh:|~\/)/i.test(clean)) continue
      if (/^[A-Za-z]:[\\/]/.test(clean) || clean.startsWith('/')) continue
      if (clean.includes('..') || /[<>*?{}$]/.test(clean)) continue
      if (TDD_IGNORED_PREFIXES.some((p) => clean.startsWith(p))) continue
      if (!TDD_SOURCE_PATH_EXT.test(clean)) continue
      if (!existsSync(join(root, clean))) stale.add(clean)
    }
  }
  return [...stale].sort()
}

function dirContainsFiles(root, dir, { codeOnly = false, depth = 0 } = {}) {
  if (depth > 4) return false
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return false }
  for (const entry of entries) {
    if (entry.isSymbolicLink() || isMacMetadataName(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name === '.git' || entry.name === '.worktrees') continue
      if (dirContainsFiles(root, full, { codeOnly, depth: depth + 1 })) return true
    } else if (entry.isFile()) {
      const rel = relative(root, full).replace(/\\/g, '/')
      if (codeOnly ? CODE_EXT.test(entry.name) : !isJunkFile(rel)) return true
    }
  }
  return false
}

export function collectTopModuleDirs(root, workspace) {
  const candidates = []
  if (workspace?.declared && (workspace.packages?.length ?? 0) > 0) {
    for (const p of workspace.packages) candidates.push(p)
  } else {
    if (existsSync(join(root, 'src'))) {
      let entries = []
      try { entries = readdirSync(join(root, 'src'), { withFileTypes: true }) } catch {}
      for (const entry of entries) {
        if (!entry.isDirectory() || isMacMetadataName(entry.name) || SKIP_DIRS.has(entry.name)) continue
        const full = join(root, 'src', entry.name)
        if (dirContainsFiles(root, full, { codeOnly: true })) candidates.push(`src/${entry.name}`)
      }
    }
    let entries = []
    try { entries = readdirSync(root, { withFileTypes: true }) } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory() || isMacMetadataName(entry.name) || entry.name === 'src') continue
      if (UNREGISTERED_SKIP_TOP_DIRS.has(entry.name)) continue
      if (entry.name.startsWith('.')) continue
      const full = join(root, entry.name)
      if (dirContainsFiles(root, full, { codeOnly: true })) candidates.push(entry.name)
    }
  }
  return [...new Set(candidates)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

const RUNNER_TO_ECOSYSTEM = [
  { eco: 'python', re: /\b(?:pytest|uv\s+run\s+pytest|poetry\s+run\s+pytest|python3?\s+-m\s+(?:unittest|pytest))\b/ },
  { eco: 'rust', re: /\bcargo\s+(?:test|build|clippy|check)\b/ },
  { eco: 'go', re: /\bgo\s+(?:test|build|vet)\b/ },
  { eco: 'java', re: /\b(?:mvn|\.\/gradlew|gradle)\s+(?:test|build|check|package)\b/ },
  { eco: 'dotnet', re: /\bdotnet\s+(?:test|build)\b/ },
  { eco: 'swift', re: /\bswift\s+(?:test|build)\b/ },
]

function extractProfileAndBuildCommands(agentsText) {
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  const hasHeadings = lines.some((l) => /^##\s+/.test(l))
  const cmds = []
  let inRelevant = !hasHeadings
  let inFence = false
  for (const line of lines) {
    if (/^##\s+/.test(line)) {
      inRelevant = /^##\s+(?:Dev Profile|环境与构建验证|构建与验证|构建与测试)/i.test(line.trim())
      inFence = false
      continue
    }
    if (!inRelevant) continue
    if (/^```/.test(line.trim())) { inFence = !inFence; continue }
    if (!inFence) continue
    const code = line.replace(/(?:^|\s)#.*$/, '').trim()
    if (!code || code.startsWith('#')) continue
    cmds.push(code)
  }
  return cmds
}

export function isReentryProject(docs, kit) {
  return Boolean(
    kit?.manifestExists
    || (docs?.agentsMarkers?.marks ?? 0) > 0
    || docs?.tdd
    || (docs?.specsDir && docs?.todoDir),
  )
}

export function detectStaleAgentScripts({
  agentsText,
  agentClaims,
  ecosystem,
  commandsByEcosystem,
  taskEntryMeta,
}) {
  const stale = new Set()
  const pkgScripts = Array.isArray(ecosystem?.packageScripts) ? new Set(ecosystem.packageScripts) : null
  const ecoKinds = new Set((ecosystem?.kinds ?? []).filter((k) => k !== 'unknown' && k !== 'empty' && k !== 'docs-only'))
  const hasBuckets = Boolean(commandsByEcosystem && Object.keys(commandsByEcosystem).length > 0)

  if (pkgScripts) {
    for (const name of (agentClaims?.scripts ?? [])) {
      if (!pkgScripts.has(name)) stale.add(name)
    }
  } else if (ecoKinds.size > 0 && !ecoKinds.has('node')) {
    for (const name of (agentClaims?.scripts ?? [])) {
      stale.add(name)
    }
  }

  const cmdLines = extractProfileAndBuildCommands(agentsText)
  for (const code of cmdLines) {
    for (const m of code.matchAll(/\bmake\s+([A-Za-z0-9_.-]+)/g)) {
      const target = m[1]
      if (!target.startsWith('-') && taskEntryMeta?.makeTargets?.size > 0 && !taskEntryMeta.makeTargets.has(target)) {
        stale.add(`make ${target}`)
      }
    }
    for (const m of code.matchAll(/\bjust\s+([A-Za-z0-9_-]+)/g)) {
      const recipe = m[1]
      if (!recipe.startsWith('-') && taskEntryMeta?.justRecipes?.size > 0 && !taskEntryMeta.justRecipes.has(recipe)) {
        stale.add(`just ${recipe}`)
      }
    }
    if (hasBuckets && ecoKinds.size > 0) {
      for (const rule of RUNNER_TO_ECOSYSTEM) {
        const hit = rule.re.exec(code)
        if (!hit) continue
        if (!ecoKinds.has(rule.eco) && !commandsByEcosystem[rule.eco]) {
          stale.add(hit[0])
        }
      }
    }
  }

  return [...stale].sort()
}
