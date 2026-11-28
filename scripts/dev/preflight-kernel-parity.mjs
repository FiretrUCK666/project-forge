#!/usr/bin/env node
/**
 * preflight-kernel-parity.mjs —— 共享内核单源去重、死符号零残留、`--slot` 零残留、
 * 零循环导入（SCC = 0）、产品层 800 行上限与跨模块重复导出拦截门禁。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { findSccs } from '../../kit/skills/lib/doc-graph.mjs'
import { isInsideDir, isMainModule } from '../../kit/skills/lib/git-core.mjs'
import { countTextLines } from '../../kit/skills/lib/static-gates.mjs'
import { stripCodeCommentsLines } from '../../kit/skills/lib/static-gates-lexer.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_ROOT = resolve(HERE, '..', '..')

function walkMjs(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.worktrees' || ent.name === '.agents') continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) walkMjs(full, out)
    else if (ent.isFile() && ent.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

const SINGLE_SOURCE_DEFS = Object.freeze([
  { name: 'readTextSafe', re: /\bfunction\s+readTextSafe\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'importSafeRead', re: /\bfunction\s+importSafeRead\s*\(/, canonical: null },
  { name: 'isMacOsJunkPath', re: /\bfunction\s+isMacOsJunkPath\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'isMacMetadataName', re: /\bfunction\s+isMacMetadataName\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'isMacMetadataPath', re: /\bfunction\s+isMacMetadataPath\s*\(/, canonical: null },
  { name: 'isMacOsMetadata', re: /\bfunction\s+isMacOsMetadata(?:Path)?\s*\(/, canonical: null },
  { name: 'isInsideDir', re: /\bfunction\s+isInsideDir\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'stripHomedirLeaks', re: /\bfunction\s+stripHomedirLeaks\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'containsHomedirLeak', re: /\bfunction\s+containsHomedirLeak\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'parseSshConfigHostMap', re: /\bfunction\s+parseSshConfigHostMap\s*\(/, canonical: 'kit/skills/lib/platform-probe.mjs' },
  { name: 'lookupSshHost', re: /\bfunction\s+lookupSshHost\s*\(/, canonical: 'kit/skills/lib/platform-probe.mjs' },
  { name: 'countTextLines', re: /\bfunction\s+countTextLines\s*\(/, canonical: 'kit/skills/lib/static-gates.mjs' },
  { name: 'canonicalPath', re: /\bfunction\s+canonicalPath\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'samePath', re: /\bfunction\s+samePath\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'posixPath', re: /\bfunction\s+posixPath\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'isMainModule', re: /\bfunction\s+isMainModule\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'writeAtomic', re: /\bfunction\s+writeAtomic\s*\(/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'VERIFY_EXIT', re: /\bconst\s+VERIFY_EXIT\s*=/, canonical: 'kit/skills/lib/exit-codes.mjs' },
  { name: 'LIKELY_DEFAULT_BRANCHES', re: /\bconst\s+LIKELY_DEFAULT_BRANCHES\s*=/, canonical: 'kit/skills/lib/git-core.mjs' },
  { name: 'summarizeSkillDescription', re: /\bfunction\s+summarizeSkillDescription\s*\(/, canonical: 'kit/skills/lib/skill-discovery.mjs' },
  { name: 'DEFAULT_KIT_SKILLS_DIR', re: /\bconst\s+DEFAULT_KIT_SKILLS_DIR\s*=/, canonical: 'kit/skills/lib/skill-discovery.mjs' },
  { name: 'parseRemoteUrlHost', re: /\bfunction\s+parseRemoteUrlHost\s*\(/, canonical: 'kit/skills/lib/platform-probe.mjs' },
  { name: 'githubRepoPath', re: /\bfunction\s+githubRepoPath\s*\(/, canonical: 'kit/skills/lib/platform-probe.mjs' },
  { name: 'NON_API_CLIENT_TIERS', re: /\bconst\s+NON_API_CLIENT_TIERS\s*=/, canonical: 'kit/skills/lib/github-client.mjs' },
  { name: 'PLACEHOLDER_TEXT_RE', re: /\bconst\s+PLACEHOLDER_TEXT_RE\s*=/, canonical: 'kit/skills/lib/doc-substantive.mjs' },
  { name: 'parseArchRuleItem', re: /\bfunction\s+parseArchRuleItem\s*\(/, canonical: 'kit/skills/lib/profile.mjs' },
  { name: 'looksLikeCommentedCode', re: /\bfunction\s+looksLikeCommentedCode\s*\(/, canonical: 'kit/skills/lib/static-gates-lexer.mjs' },
  { name: 'extractCriteria', re: /\bfunction\s+extractCriteria\s*\(/, canonical: 'kit/skills/lib/criteria-lock.mjs' },
  { name: 'DECIDED_RE', re: /\bconst\s+DECIDED_RE\s*=/, canonical: 'kit/skills/lib/pending-decisions.mjs' },
  { name: 'AGENTS_MAX_BYTES', re: /\bconst\s+AGENTS_MAX_BYTES\s*=/, canonical: 'kit/skills/lib/tool-owned.mjs' },
  { name: 'registerHostingProvider', re: /\bfunction\s+registerHostingProvider\s*\(/, canonical: 'kit/skills/lib/platform-registry.mjs' },
])

const RETIRED_DEAD_EXPORTS = Object.freeze([
  'parentOf', 'emitMarker', 'hasMarkers', 'WORKTREES_STATE_RE', 'WORKTREES_STATE_REL',
  'readTextFile', 'normVersion', 'repoRelation', 'detectTaskEntries', 'scanWorkspaceRaw',
  'supportedLanguages', 'readFeatureMapDocHint', 'findTocDrift', 'splitJudgeable', 'templateVarNames',
  'renderCatalogHtml', 'NO_ARCHITECTURE_HTML_DECISION', 'syncArchitectureMap',
])

const STANDARD_ENTRYPOINT_NAMES = new Set(['runCli', 'main'])
const STANDARD_HANDLER_RE = /^handle[A-Z]/

/**
 * 存量双栈/已知成对导出白名单（严锁精确文件对，仅允许收口清零、绝不允许新增第三个副本或未登记重名）。
 */
const DUPLICATE_EXPORT_ALLOWLIST = Object.freeze({
  // 双栈平台层（scripts/lib/platform/ 与 kit/skills/lib/，收口清零目标）
  GENERIC_GIT_PROVIDER: ['kit/skills/lib/platform-registry.mjs', 'scripts/lib/platform/registry.mjs'],
  GITCODE_PROVIDER: ['kit/skills/lib/platform-registry.mjs', 'scripts/lib/platform/registry.mjs'],
  GITEA_PROVIDER: ['kit/skills/lib/platform-registry.mjs', 'scripts/lib/platform/registry.mjs'],
  GITEE_PROVIDER: ['kit/skills/lib/platform-registry.mjs', 'scripts/lib/platform/registry.mjs'],
  GITHUB_PROVIDER: ['kit/skills/lib/platform-registry.mjs', 'scripts/lib/platform/github.mjs'],
  GITLAB_PROVIDER: ['kit/skills/lib/platform-registry.mjs', 'scripts/lib/platform/registry.mjs'],
  getHostingProvider: ['kit/skills/lib/platform-registry.mjs', 'scripts/lib/platform/registry.mjs'],
  classifyWorkspaceIdentity: ['kit/skills/lib/platform.mjs', 'scripts/lib/platform/github.mjs'],
  createGitHubClient: ['kit/skills/lib/github-client.mjs', 'scripts/lib/platform/github-client.mjs'],
  probeGitHubEnv: ['kit/skills/lib/platform.mjs', 'scripts/lib/platform/github-probe.mjs'],
  resolveWorkspaceIdentity: ['kit/skills/lib/platform.mjs', 'scripts/lib/platform/github.mjs'],
  SKIP_DIRS: ['kit/skills/dev-iterate/scripts/iterate-plan.mjs', 'scripts/lib/survey-ecosystem.mjs'],
  // 存量 kit 内部成对导出（严控不新增）
  VERIFIED_API_TIERS: ['kit/skills/lib/github-client.mjs', 'kit/skills/lib/github-parse.mjs'],
  checkAuthorIsNotImplementer: ['kit/skills/lib/doc-requirements.mjs', 'kit/skills/lib/harness-context.mjs'],
  createLabel: ['kit/skills/lib/github-client.mjs', 'kit/skills/lib/github-labels.mjs'],
  displayWidth: ['kit/skills/lib/doc-templates.mjs', 'kit/skills/lib/visual-router.mjs'],
  hasBehavioralAssertion: ['kit/skills/lib/static-gates-assertions.mjs', 'kit/skills/lib/static-gates.mjs'],
  isVerifiedTier: ['kit/skills/lib/github-client.mjs', 'kit/skills/lib/github-parse.mjs'],
  scopesOverlap: ['kit/skills/lib/doc-slice-graph.mjs', 'kit/skills/lib/sandbox-scope.mjs'],
  syncDetachedWorktree: ['kit/skills/lib/git-worktree-env.mjs', 'kit/skills/lib/git.mjs'],
})

const STATIC_REL_IMPORT_RE = /(?:^|[\n;])\s*(?:import|export)\s+(?:[^'"()]*?\s+from\s+)?['"](\.[^'"]+)['"]/g
const DYNAMIC_REL_IMPORT_RE = /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g
const EXPORT_DEF_RE = /^\s*export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm

/** 扫描产品层全部静态与动态相对导入，基于 Tarjan SCC 阻断任何循环导入。 */
export function scanCircularImports(entries) {
  const fileSet = new Set(entries.map((e) => e.rel))
  const edges = new Map(entries.map((e) => [e.rel, new Set()]))
  for (const { rel, codeText } of entries) {
    const baseDir = dirname(rel)
    for (const re of [STATIC_REL_IMPORT_RE, DYNAMIC_REL_IMPORT_RE]) {
      re.lastIndex = 0
      let m
      while ((m = re.exec(codeText)) !== null) {
        const spec = m[1].trim()
        if (!spec.startsWith('.')) continue
        const target = relative('.', resolve('.', baseDir, spec)).replace(/\\/g, '/')
        if (fileSet.has(target)) edges.get(rel).add(target)
      }
    }
  }
  return findSccs([...fileSet].sort(), edges)
}

/** 扫描跨模块重复导出定义（排除 `export { ... } from ...` 重导出与标准入口）。 */
export function scanDuplicateExportDefs(entries, allowlist = DUPLICATE_EXPORT_ALLOWLIST) {
  const defs = new Map()
  for (const { rel, codeText } of entries) {
    EXPORT_DEF_RE.lastIndex = 0
    let m
    while ((m = EXPORT_DEF_RE.exec(codeText)) !== null) {
      const name = m[1]
      if (STANDARD_ENTRYPOINT_NAMES.has(name) || STANDARD_HANDLER_RE.test(name)) continue
      if (!defs.has(name)) defs.set(name, new Set())
      defs.get(name).add(rel)
    }
  }
  const violations = []
  for (const [name, fileSet] of [...defs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (fileSet.size < 2) continue
    const files = [...fileSet].sort()
    const allowed = Array.isArray(allowlist[name]) ? [...allowlist[name]].sort() : null
    if (allowed && allowed.length === files.length && allowed.every((f, idx) => f === files[idx])) {
      continue
    }
    violations.push({ name, files })
  }
  return violations
}

export function runKernelParityChecks({ ROOT = DEFAULT_ROOT, rel, readText, fail, note } = {}) {
  const relFn = rel ?? ((p) => p.slice(ROOT.length + 1).replace(/\\/g, '/'))
  const readFn = readText ?? ((p) => readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
  const failures = []
  const failFn = fail ?? ((msg) => failures.push(msg))
  const noteFn = note ?? (() => {})

  const productFiles = [
    ...walkMjs(join(ROOT, 'kit', 'skills')),
    ...walkMjs(join(ROOT, 'scripts')).filter((f) => !relFn(f).startsWith('scripts/dev/')),
  ]
  const parsedEntries = []

  for (const abs of productFiles) {
    const fileRel = relFn(abs)
    const text = readFn(abs)
    const codeText = stripCodeCommentsLines(text, 'mjs').join('\n')
    parsedEntries.push({ rel: fileRel, text, codeText })

    const lines = countTextLines(text)
    if (lines > 800) {
      failFn(`内核对等：${fileRel} 有 ${lines} 行，超过产品脚本单文件 800 行上限`)
    }

    if (/(?:^|[\s'"`])--slot(?:[\s'"`=]|$)/.test(text)) {
      failFn(`内核对等：${fileRel} 仍残留废弃参数 --slot`)
    }

    for (const spec of SINGLE_SOURCE_DEFS) {
      if (spec.re.test(text) && fileRel !== spec.canonical) {
        failFn(`内核对等：${fileRel} 存在重复实现 ${spec.name}（唯一真源为 ${spec.canonical ?? '已移除'}）`)
      }
    }

    for (const dead of RETIRED_DEAD_EXPORTS) {
      if (new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const|let)\\s+${dead}\\b`).test(text)) {
        failFn(`内核对等：${fileRel} 仍导出已清理的零引用死符号 ${dead}`)
      }
    }
  }

  const sccs = scanCircularImports(parsedEntries)
  for (const scc of sccs) {
    failFn(`内核对等：检测到生产代码循环导入 SCC（${scc.length} 个文件）：${scc.join(' -> ')}`)
  }

  const dupViolations = scanDuplicateExportDefs(parsedEntries)
  for (const v of dupViolations) {
    failFn(`内核对等：检测到未登记的跨模块重复导出定义 ${v.name}：${v.files.join(', ')}`)
  }

  const sample800 = `${Array.from({ length: 800 }, (_, i) => `const l${i} = ${i}`).join('\n')}\n`
  if (countTextLines(sample800) !== 800) {
    failFn(`内核对等：countTextLines 对 800 行末尾换行文本返回 ${countTextLines(sample800)}（预期 800）`)
  }
  const editGateRel = join(ROOT, 'kit', 'skills', 'dev-edit', 'scripts', 'edit-gate.mjs')
  if (existsSync(editGateRel) && !readFn(editGateRel).includes('countTextLines')) {
    failFn('内核对等：edit-gate.mjs 未复用 static-gates.mjs 的 countTextLines')
  }

  if (isInsideDir('/tmp/repo2', '/tmp/repo') || !isInsideDir('/tmp/repo/sub', '/tmp/repo')) {
    failFn('内核对等：isInsideDir 路径分隔符前缀边界判定失效（/tmp/repo2 与 /tmp/repo 混淆）')
  }

  noteFn(`内核对等：${productFiles.length} 个产品脚本通过 ${SINGLE_SOURCE_DEFS.length} 项单源、SCC=0 零循环导入、<=800 行上限与跨模块去重门禁`)
  return { ok: failures.length === 0, checked: productFiles.length, sccCount: sccs.length, failures }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const notes = []
  const res = runKernelParityChecks({ note: (m) => notes.push(m) })
  for (const n of notes) process.stdout.write(`  ${n}\n`)
  if (!res.ok) {
    for (const f of res.failures) process.stderr.write(`FAIL  ${f}\n`)
    process.exit(1)
  }
  process.stdout.write('preflight-kernel-parity: PASS\n')
  process.exit(0)
}
