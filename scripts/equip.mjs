/**
 * `.agents/skills/` 工程套件装配、三态无损升级、字节级校验与空白工程初始化。
 *
 * - 只使用 Node 18+ 内置模块，零第三方依赖。
 * - 三态升级严格保护用户自定义改动；退役的托管文件在未改动时自动清理。
 * - 重复执行保持幂等；`--check` 零写入；`--dry-run` 仅报告计划。
 */

import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAtomic } from './lib/fs-atomic.mjs'
import { KIT_SKILLS, PF_MANIFEST_REL } from './lib/protocol.mjs'
import { isMainModule, posixPath, readTextSafe, skillVersion } from './lib/text.mjs'

const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_KIT_SKILLS_DIR = join(SKILL_ROOT, 'kit', 'skills')
const BOOTSTRAP_LANGS = new Set(['node', 'python', 'go', 'rust', 'docs'])
const EMPTY_NOISE_ENTRIES = new Set([
  '.git', '.DS_Store', 'Thumbs.db', 'desktop.ini', '.gitkeep', '.vscode', '.idea', '.agents',
])

function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

function walkKitFiles(kitDir) {
  const map = new Map()
  if (!existsSync(kitDir)) return map

  function visit(dir) {
    const entries = readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name === '.pf-manifest.json' || entry.name === '.DS_Store') continue
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(abs)
        continue
      }
      if (!entry.isFile()) continue
      const rel = posixPath(relative(kitDir, abs))
      const buf = readFileSync(abs)
      map.set(rel, { abs, buf, sha256: sha256Buffer(buf) })
    }
  }

  visit(kitDir)
  return map
}

function readExistingManifest(manifestPath) {
  if (!existsSync(manifestPath)) return { exists: false, valid: false, data: undefined }
  const text = readTextSafe(manifestPath)
  if (!text) return { exists: true, valid: false, data: undefined }
  try {
    const parsed = JSON.parse(text)
    const valid = Boolean(
      parsed
      && typeof parsed === 'object'
      && parsed.schemaVersion === 1
      && parsed.files
      && typeof parsed.files === 'object'
      && !Array.isArray(parsed.files),
    )
    return { exists: true, valid, data: valid ? parsed : undefined }
  } catch {
    return { exists: true, valid: false, data: undefined }
  }
}

function pruneEmptyParents(filePath, stopDir) {
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

function normalizePrevFiles(filesObj) {
  const map = new Map()
  if (!filesObj || typeof filesObj !== 'object') return map
  for (const [k, v] of Object.entries(filesObj)) {
    const rel = posixPath(k)
    const hash = typeof v === 'string' ? v : v?.sha256
    if (rel && typeof hash === 'string' && hash) {
      map.set(rel, hash)
    }
  }
  return map
}

function manifestsFilesEqual(prevMap, nextFiles) {
  const nextKeys = Object.keys(nextFiles)
  if (prevMap.size !== nextKeys.length) return false
  for (const k of nextKeys) {
    if (prevMap.get(k) !== nextFiles[k]?.sha256) return false
  }
  return true
}

function collectManagedDirExtras(skillsDir, kitFiles) {
  const extras = []
  const managedTopDirs = new Set(
    [...KIT_SKILLS, 'lib', ...[...kitFiles.keys()].map((k) => k.split('/')[0]).filter(Boolean)],
  )
  for (const top of managedTopDirs) {
    const topPath = join(skillsDir, top)
    if (!existsSync(topPath)) continue
    let st
    try { st = statSync(topPath) } catch { continue }
    if (!st.isDirectory()) continue
    const stack = [topPath]
    while (stack.length > 0) {
      const cur = stack.pop()
      for (const entry of readdirSync(cur, { withFileTypes: true })) {
        const abs = join(cur, entry.name)
        if (entry.isDirectory()) {
          stack.push(abs)
        } else if (entry.isFile()) {
          const rel = posixPath(relative(skillsDir, abs))
          if (!kitFiles.has(rel)) extras.push(rel)
        }
      }
    }
  }
  return extras.sort()
}

/**
 * 字节级只读校验 `<targetDir>/.agents/skills/` 与源 `kit/skills/` 的一致性。
 */
export function checkEquip(targetDir, { kitDir = DEFAULT_KIT_SKILLS_DIR } = {}) {
  const root = resolve(targetDir)
  const skillsDir = join(root, '.agents', 'skills')
  const manifestPath = join(root, PF_MANIFEST_REL)

  if (!existsSync(kitDir)) {
    return {
      ok: false,
      reason: `找不到源套件目录：${kitDir}`,
      missing: [],
      drifted: [],
      unregistered: [],
      extraManaged: [],
    }
  }

  const kitFiles = walkKitFiles(kitDir)
  const existing = readExistingManifest(manifestPath)
  const prevFiles = normalizePrevFiles(existing.data?.files)

  const missing = []
  const drifted = []
  const unregistered = []
  const extraManaged = []

  if (!existing.exists) {
    missing.push(PF_MANIFEST_REL)
  } else if (!existing.valid) {
    drifted.push(PF_MANIFEST_REL)
  }

  for (const [rel, src] of kitFiles.entries()) {
    const dest = join(skillsDir, rel)
    if (!existsSync(dest)) {
      missing.push(rel)
      continue
    }
    const diskBuf = readFileSync(dest)
    if (Buffer.compare(diskBuf, src.buf) !== 0) {
      drifted.push(rel)
    } else if (existing.valid && prevFiles.get(rel) !== src.sha256) {
      unregistered.push(rel)
    }
  }

  if (existing.valid) {
    for (const rel of prevFiles.keys()) {
      if (!kitFiles.has(rel)) extraManaged.push(rel)
    }
  }
  for (const rel of collectManagedDirExtras(skillsDir, kitFiles)) {
    if (!extraManaged.includes(rel)) extraManaged.push(rel)
  }
  extraManaged.sort()

  const ok = existing.exists
    && existing.valid
    && missing.length === 0
    && drifted.length === 0
    && unregistered.length === 0
    && extraManaged.length === 0

  return {
    ok,
    target: root,
    manifestPath: PF_MANIFEST_REL,
    missing,
    drifted,
    unregistered,
    extraManaged,
  }
}

/**
 * 将 `kit/skills/**` 按三态无损升级规则同步到 `<targetDir>/.agents/skills/**`。
 */
export function equip(targetDir, {
  kitDir = DEFAULT_KIT_SKILLS_DIR,
  dryRun = false,
  forgeVersion = skillVersion(SKILL_ROOT) || '0.0.0',
  now = new Date().toISOString(),
} = {}) {
  const root = resolve(targetDir)
  if (!existsSync(kitDir)) {
    throw new Error(`找不到源套件目录：${kitDir}`)
  }

  const skillsDir = join(root, '.agents', 'skills')
  const manifestPath = join(root, PF_MANIFEST_REL)
  const kitFiles = walkKitFiles(kitDir)
  const existing = readExistingManifest(manifestPath)
  const prevFiles = normalizePrevFiles(existing.data?.files)

  const added = []
  const upgraded = []
  const unchanged = []
  const conflicts = []
  const retired = []
  const orphanedModified = []
  const nextFiles = {}

  const kitKeys = [...kitFiles.keys()].sort()
  for (const rel of kitKeys) {
    const src = kitFiles.get(rel)
    const dest = join(skillsDir, rel)
    const oldHash = prevFiles.get(rel)

    if (!existsSync(dest)) {
      if (!dryRun) {
        mkdirSync(dirname(dest), { recursive: true })
        writeAtomic(dest, src.buf)
      }
      nextFiles[rel] = { sha256: src.sha256 }
      added.push(rel)
      continue
    }

    const diskBuf = readFileSync(dest)
    const diskHash = sha256Buffer(diskBuf)

    if (!oldHash) {
      if (diskHash === src.sha256) {
        nextFiles[rel] = { sha256: src.sha256 }
        unchanged.push(rel)
      } else {
        conflicts.push({
          path: rel,
          reason: 'untracked-modified',
          diskSha256: diskHash,
          incomingSha256: src.sha256,
        })
      }
      continue
    }

    if (diskHash === oldHash) {
      if (diskHash === src.sha256) {
        nextFiles[rel] = { sha256: src.sha256 }
        unchanged.push(rel)
      } else {
        if (!dryRun) {
          mkdirSync(dirname(dest), { recursive: true })
          writeAtomic(dest, src.buf)
        }
        nextFiles[rel] = { sha256: src.sha256 }
        upgraded.push(rel)
      }
      continue
    }

    // 目标文件被用户修改过：100% 保留，不覆盖，保留旧基线以便下次继续识别。
    nextFiles[rel] = { sha256: oldHash }
    conflicts.push({
      path: rel,
      reason: 'modified-preserved',
      baselineSha256: oldHash,
      diskSha256: diskHash,
      incomingSha256: src.sha256,
    })
  }

  for (const [rel, oldHash] of prevFiles.entries()) {
    if (kitFiles.has(rel)) continue
    const dest = join(skillsDir, rel)
    if (!existsSync(dest)) {
      retired.push(rel)
      continue
    }
    const diskHash = sha256Buffer(readFileSync(dest))
    if (diskHash === oldHash) {
      if (!dryRun) {
        unlinkSync(dest)
        pruneEmptyParents(dest, skillsDir)
      }
      retired.push(rel)
    } else {
      orphanedModified.push({
        path: rel,
        status: 'orphaned-modified',
        baselineSha256: oldHash,
        diskSha256: diskHash,
      })
    }
  }

  const sameFiles = existing.valid && manifestsFilesEqual(prevFiles, nextFiles)
  const sameVersion = existing.valid && existing.data?.forgeVersion === forgeVersion
  const manifestChanged = !existing.exists || !existing.valid || !sameFiles || !sameVersion

  const nextManifest = {
    schemaVersion: 1,
    forgeVersion,
    installedAt: manifestChanged ? (existing.valid && !sameFiles ? now : (existing.data?.installedAt || now)) : existing.data.installedAt,
    files: nextFiles,
    agentsRegions: existing.data?.agentsRegions && typeof existing.data.agentsRegions === 'object'
      ? { ...existing.data.agentsRegions }
      : {},
  }

  if (manifestChanged && !dryRun) {
    mkdirSync(dirname(manifestPath), { recursive: true })
    writeAtomic(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`)
  }

  return {
    target: root,
    dryRun,
    manifestPath: PF_MANIFEST_REL,
    manifestUpdated: manifestChanged,
    added,
    upgraded,
    unchanged,
    conflicts,
    retired,
    orphanedModified,
  }
}

function isNearlyEmptyDir(root) {
  if (!existsSync(root)) return { empty: true, blocking: [] }
  const blocking = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EMPTY_NOISE_ENTRIES.has(entry.name)) continue
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
  const ident = kebab.replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'starter_app'
  const safeIdent = /^[0-9]/.test(ident) ? `app_${ident}` : ident
  return { display: base, kebab, ident: safeIdent }
}

function starterTemplates({ lang, names }) {
  const tddDoc = [
    `# ${names.display} 技术设计说明（TDD）`,
    '',
    '## 目标与边界',
    '',
    '- 在此处记录核心模块边界、对外接口与关键不变量。',
    '',
    '## 目录结构',
    '',
    '- 源码与冒烟测试分离，保持最小可运行与零第三方依赖基线。',
    '',
  ].join('\n')

  if (lang === 'node') {
    return {
      'package.json': `${JSON.stringify({
        name: names.kebab,
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: {
          start: 'node src/index.mjs',
          test: 'node --test',
        },
        engines: { node: '>=18' },
      }, null, 2)}\n`,
      'src/index.mjs': [
        "import { pathToFileURL } from 'node:url'",
        '',
        `export function greet(name = 'world') {`,
        `  const clean = String(name ?? '').trim() || 'world'`,
        '  return `hello, ${clean}`',
        '}',
        '',
        'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {',
        '  process.stdout.write(`${greet(process.argv[2])}\\n`)',
        '}',
        '',
      ].join('\n'),
      'test/smoke.test.mjs': [
        "import test from 'node:test'",
        "import assert from 'node:assert/strict'",
        "import { greet } from '../src/index.mjs'",
        '',
        "test('greet returns default and named greetings', () => {",
        "  assert.equal(greet(), 'hello, world')",
        "  assert.equal(greet('forge'), 'hello, forge')",
        '})',
        '',
      ].join('\n'),
      'docs/TDD.md': tddDoc,
    }
  }

  if (lang === 'python') {
    return {
      'pyproject.toml': [
        '[build-system]',
        'requires = ["setuptools>=68"]',
        'build-backend = "setuptools.build_meta"',
        '',
        '[project]',
        `name = "${names.kebab}"`,
        'version = "0.1.0"',
        'description = "Starter project"',
        'requires-python = ">=3.10"',
        'dependencies = []',
        '',
      ].join('\n'),
      [`src/${names.ident}/__init__.py`]: [
        'def greet(name: str = "world") -> str:',
        '    clean = (name or "").strip() or "world"',
        '    return f"hello, {clean}"',
        '',
      ].join('\n'),
      'tests/test_smoke.py': [
        'from pathlib import Path',
        'import sys',
        'import unittest',
        '',
        'sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))',
        '',
        `from ${names.ident} import greet`,
        '',
        '',
        'class SmokeTest(unittest.TestCase):',
        '    def test_greet(self) -> None:',
        '        self.assertEqual(greet(), "hello, world")',
        '        self.assertEqual(greet("forge"), "hello, forge")',
        '',
        '',
        'if __name__ == "__main__":',
        '    unittest.main()',
        '',
      ].join('\n'),
      'docs/TDD.md': tddDoc,
    }
  }

  if (lang === 'go') {
    return {
      'go.mod': `module example.com/${names.kebab}\n\ngo 1.21\n`,
      'main.go': [
        'package main',
        '',
        'import (',
        '\t"fmt"',
        '\t"strings"',
        ')',
        '',
        'func Greet(name string) string {',
        '\tclean := strings.TrimSpace(name)',
        '\tif clean == "" {',
        '\t\tclean = "world"',
        '\t}',
        '\treturn "hello, " + clean',
        '}',
        '',
        'func main() {',
        '\tfmt.Println(Greet("world"))',
        '}',
        '',
      ].join('\n'),
      'main_test.go': [
        'package main',
        '',
        'import "testing"',
        '',
        'func TestGreet(t *testing.T) {',
        '\tif got := Greet(""); got != "hello, world" {',
        '\t\tt.Fatalf("unexpected default greeting: %q", got)',
        '\t}',
        '\tif got := Greet("forge"); got != "hello, forge" {',
        '\t\tt.Fatalf("unexpected named greeting: %q", got)',
        '\t}',
        '}',
        '',
      ].join('\n'),
      'docs/TDD.md': tddDoc,
    }
  }

  if (lang === 'rust') {
    return {
      'Cargo.toml': [
        '[package]',
        `name = "${names.ident}"`,
        'version = "0.1.0"',
        'edition = "2021"',
        '',
        '[dependencies]',
        '',
      ].join('\n'),
      'src/main.rs': [
        'pub fn greet(name: &str) -> String {',
        '    let clean = name.trim();',
        '    let target = if clean.is_empty() { "world" } else { clean };',
        '    format!("hello, {}", target)',
        '}',
        '',
        'fn main() {',
        '    println!("{}", greet("world"));',
        '}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use super::*;',
        '',
        '    #[test]',
        '    fn smoke_test() {',
        '        assert_eq!(greet(""), "hello, world");',
        '        assert_eq!(greet("forge"), "hello, forge");',
        '    }',
        '}',
        '',
      ].join('\n'),
      'docs/TDD.md': tddDoc,
    }
  }

  return {
    'README.md': [
      `# ${names.display}`,
      '',
      '项目说明与文档入口。',
      '',
    ].join('\n'),
    'docs/guide.md': [
      `# ${names.display} 使用指南`,
      '',
      '在此编写结构化的面向读者文档。',
      '',
    ].join('\n'),
    'docs/TDD.md': tddDoc,
  }
}

/**
 * 仅在空白（或仅含编辑区杂项）的目录生成最小可运行工程骨架与初始 `docs/TDD.md`。
 */
export function bootstrapEmpty(targetDir, {
  lang,
  name,
  dryRun = false,
} = {}) {
  const root = resolve(targetDir)
  if (!BOOTSTRAP_LANGS.has(lang)) {
    throw new Error(`--lang 必须是 ${[...BOOTSTRAP_LANGS].join(' | ')} 之一（收到：${lang ?? '未指定'}）`)
  }
  const check = isNearlyEmptyDir(root)
  if (!check.empty) {
    throw new Error(`目标目录非空（已存在：${check.blocking.slice(0, 5).join('、')}），拒绝执行 --bootstrap-empty`)
  }

  const names = sanitizeNames(name, root)
  const files = starterTemplates({ lang, names })
  const created = []

  for (const [rel, content] of Object.entries(files)) {
    const dest = join(root, rel)
    created.push(rel)
    if (!dryRun) {
      mkdirSync(dirname(dest), { recursive: true })
      writeAtomic(dest, content)
    }
  }

  return { target: root, lang, name: names.kebab, dryRun, created }
}

function formatCheckReport(res) {
  const lines = []
  if (res.reason) lines.push(res.reason)
  for (const p of res.missing) lines.push(`缺失：${p}`)
  for (const p of res.drifted) lines.push(`字节不一致：${p}`)
  for (const p of res.unregistered) lines.push(`未登记哈希：${p}`)
  for (const p of res.extraManaged) lines.push(`多余托管文件：${p}`)
  return lines.join('\n')
}

async function main(argv) {
  let target = process.cwd()
  let targetSpecified = false
  let check = false
  let dryRun = false
  let doBootstrap = false
  let lang
  let name
  let kitDir = DEFAULT_KIT_SKILLS_DIR

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/equip.mjs [目标目录] [选项]',
        '',
        '  --check                  只读字节级校验，不一致退出码 1',
        '  --dry-run                仅打印将执行的操作，不写文件',
        '  --bootstrap-empty        为空目录生成最小可运行骨架与初始 docs/TDD.md',
        '  --lang <lang>            骨架语言：node | python | go | rust | docs',
        '  --name <name>            项目名称（默认取目录名）',
        '',
      ].join('\n'))
      return 0
    }
    if (arg === '--check') check = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--bootstrap-empty') doBootstrap = true
    else if (arg === '--lang') lang = argv[++i]
    else if (arg.startsWith('--lang=')) lang = arg.slice('--lang='.length)
    else if (arg === '--name') name = argv[++i]
    else if (arg.startsWith('--name=')) name = arg.slice('--name='.length)
    else if (arg === '--kit-dir') kitDir = resolve(argv[++i] || '')
    else if (arg.startsWith('--kit-dir=')) kitDir = resolve(arg.slice('--kit-dir='.length))
    else if (!arg.startsWith('-') && !targetSpecified) {
      target = arg
      targetSpecified = true
    } else {
      process.stderr.write(`未知参数：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    if (check) {
      const res = checkEquip(target, { kitDir })
      if (!res.ok) {
        process.stderr.write(`${formatCheckReport(res)}\n`)
        return 1
      }
      process.stdout.write(`套件校验通过：${res.manifestPath}\n`)
      return 0
    }

    let bootstrapResult
    if (doBootstrap) {
      bootstrapResult = bootstrapEmpty(target, { lang, name, dryRun })
      if (!existsSync(kitDir)) {
        process.stdout.write(`${JSON.stringify({ bootstrap: bootstrapResult, equip: null }, null, 2)}\n`)
        return 0
      }
    }

    const equipResult = equip(target, { kitDir, dryRun })
    process.stdout.write(`${JSON.stringify({
      ...(bootstrapResult ? { bootstrap: bootstrapResult } : {}),
      equip: equipResult,
    }, null, 2)}\n`)
    return 0
  } catch (err) {
    process.stderr.write(`equip 失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
