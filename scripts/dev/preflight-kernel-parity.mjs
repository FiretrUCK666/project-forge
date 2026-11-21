#!/usr/bin/env node
/**
 * preflight-kernel-parity.mjs —— 共享内核单源去重、死符号零残留、`--slot` 零残留与 800 行边界对拍门禁。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isInsideDir, isMainModule } from '../../kit/skills/lib/git-core.mjs'
import { countTextLines } from '../../kit/skills/lib/static-gates.mjs'

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
])

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

  for (const abs of productFiles) {
    const fileRel = relFn(abs)
    const text = readFn(abs)

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

  noteFn(`内核对等：${productFiles.length} 个产品脚本通过 ${SINGLE_SOURCE_DEFS.length} 项共享原语单源、--slot 零残留与 800 行边界对拍`)
  return { ok: failures.length === 0, checked: productFiles.length, failures }
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
