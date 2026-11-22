/**
 * govern-docs.mjs -- Documentation parity, AGENTS.md checks, Mermaid 16/12 validation,
 * Frontmatter/link audits, decision-aware TDD exemptions, and standard Todo generator.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { resolveAvailableSkills } from '../../lib/cli.mjs'
import {
  buildDocFilename, checkMermaidLabelWidth, docDateTag, isManagedPlanDoc, parseDocFilename,
  parseDocFrontmatter, renderStandardDocTemplate,
} from '../../lib/docs.mjs'
import { gitRun, isMacOsJunkPath, posixPath, readJsonSafe } from '../../lib/git.mjs'
import { collectAncestorsDagFast, readHeadFast, resolveGitDirFast } from '../../lib/git-fast.mjs'
import { readDecisions, resolveAuthoritativeTddPath } from '../../lib/profile.mjs'
import { CODE_EXT_RE, isTestOrFixtureFile, matchGlob } from '../../lib/static-gates.mjs'
import { checkTddStructure } from '../../lib/tdd-structure.mjs'
import { AGENTS_MAX_BYTES, AGENTS_WARN_BYTES, addFinding, readTextStrictInfo } from './govern-checks.mjs'
import { checkEvergreenAuthorityDocs, discoverEvergreenAuthorityDocs } from './govern-evergreen.mjs'

export { discoverEvergreenAuthorityDocs }

const REPO_PATH_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|rs|go|java|kt|cs|json|ya?ml|toml|lock|txt|cfg|ini|md)$/i

function isRootReadmeRel(rel) {
  return /^readme$/i.test(rel)
    || /^readme(?:\.[a-z0-9_.-]+)?\.(?:md|mdx|markdown|rst|txt|adoc|asciidoc|org)$/i.test(rel)
}

function findPrimaryReadmeRel(repoRoot) {
  try {
    const names = readdirSync(repoRoot, { withFileTypes: true })
      .filter((d) => d.isFile() && isRootReadmeRel(d.name))
      .map((d) => d.name)
      .sort()
    return names.find((n) => /^readme\.md$/i.test(n)) ?? names[0] ?? ''
  } catch {
    return ''
  }
}

function checkAgentsPathsAndRefs(repoRoot, agentsText, devProfile, defaultBranch, findings) {
  const paths = new Set()
  const branches = new Set()

  const extractRepoPath = (token) => {
    const raw = String(token ?? '').trim().replace(/^['"]|['"]$/g, '')
    if (!raw || !raw.includes('/')) return undefined
    if (/^(?:https?:|mailto:|\/|[A-Za-z]:[\\/]|<.*>$)/.test(raw)) return undefined
    if (/[<>*?]/.test(raw) || raw.endsWith('/')) return undefined
    if (!REPO_PATH_EXT_RE.test(raw)) return undefined
    return raw
  }

  const optionalSuffixRe = /^\s*[（(]\s*(?:若存在|如存在|如果存在|可选|按需|if\s+(?:it\s+)?exists?|optional)[^）)]*[）)]/i
  const optionalPrefixRe = /(?:若存在|如存在|如果存在|可选|optional|if\s+exists?)\s*[:：]?\s*$/i
  const requiredPaths = new Set()
  const optionalPaths = new Set()

  for (const m of agentsText.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim()
    const matchIdx = m.index ?? 0
    const before = agentsText.slice(Math.max(0, matchIdx - 24), matchIdx)
    const after = agentsText.slice(matchIdx + m[0].length, matchIdx + m[0].length + 28)
    const isOptional = optionalSuffixRe.test(after) || optionalPrefixRe.test(before)
    for (const word of tok.split(/\s+/)) {
      const p = extractRepoPath(word)
      if (!p) continue
      if (isOptional) optionalPaths.add(p)
      else requiredPaths.add(p)
    }
    for (const bm of tok.matchAll(/\bgit\s+(?:switch|checkout)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)/g)) branches.add(bm[1])
  }
  for (const p of requiredPaths) paths.add(p)
  for (const p of optionalPaths) if (requiredPaths.has(p)) paths.add(p)

  for (const block of agentsText.matchAll(/```[a-zA-Z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split('\n')) {
      const clean = line.replace(/\s+#.*$/, '').trim()
      if (!clean || clean.startsWith('#')) continue
      for (const bm of clean.matchAll(/\bgit\s+(?:switch|checkout)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)/g)) branches.add(bm[1])
      for (const word of clean.split(/\s+/)) {
        const p = extractRepoPath(word)
        if (p) paths.add(p)
      }
    }
  }

  for (const p of [...paths].sort()) {
    if (!existsSync(join(repoRoot, p))) {
      addFinding(findings, {
        id: `docs.agents-stale-path.${p}`,
        category: 'docs',
        severity: 'high',
        file: 'AGENTS.md',
        title: `Stale path in AGENTS.md: ${p} does not exist`,
        action: `Update or remove "${p}" in AGENTS.md.`,
      })
    }
  }

  if (defaultBranch) {
    for (const b of [...branches].sort()) {
      if (b !== defaultBranch && b !== 'HEAD') {
        addFinding(findings, {
          id: `docs.agents-stale-branch.${b}`,
          category: 'docs',
          severity: 'medium',
          file: 'AGENTS.md',
          title: `AGENTS.md references branch "${b}" instead of default branch "${defaultBranch}"`,
          action: `Align branch references in AGENTS.md to "${defaultBranch}".`,
        })
      }
    }
  }

  for (const cmdKey of ['quick-test', 'full-test', 'smoke-verify', 'merge-gate']) {
    for (const cmd of devProfile[cmdKey] ?? []) {
      for (const word of cmd.split(/\s+/)) {
        const p = extractRepoPath(word)
        if (p && !existsSync(join(repoRoot, p))) {
          addFinding(findings, {
            id: `docs.devprofile-missing-script.${cmdKey}.${p}`,
            category: 'docs',
            severity: 'high',
            file: 'AGENTS.md',
            title: `Dev Profile "${cmdKey}" points to missing file "${p}"`,
            action: `Fix ${cmdKey}: command in AGENTS.md.`,
          })
        }
      }
    }
  }
}

function discoverCodeModules(repoRoot) {
  const modules = []
  const seen = new Set()
  const containerRoots = ['src', 'lib', 'scripts', 'packages', 'apps', 'services', 'app', 'cmd', 'internal', 'pkg', 'kit/skills']
  for (const cr of containerRoots) {
    const abs = join(repoRoot, cr)
    if (!existsSync(abs)) continue
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || isMacOsJunkPath(entry.name)) continue
      const p = `${cr}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'dev') continue
        if (!seen.has(p)) { seen.add(p); modules.push({ name: entry.name, path: p }) }
      } else if (entry.isFile() && CODE_EXT_RE.test(entry.name)) {
        if (!seen.has(p)) { seen.add(p); modules.push({ name: entry.name, path: p }) }
      }
    }
  }
  return modules
}

function decodeUriSafe(raw) {
  try { return decodeURIComponent(raw) } catch { return raw }
}

function checkMarkdownDeadLinks(repoRoot, files, findings) {
  for (const f of files) {
    if (!/\.mdx?$/i.test(f.name)) continue
    if (f.rel.startsWith('templates/') || f.rel.startsWith('docs/archive/')) continue
    const info = readTextStrictInfo(f.full)
    if (!info?.text) continue
    const lines = info.text.split('\n')
    let fenceChar = ''
    let fenceLen = 0
    let perFileCount = 0

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const fm = /^\s*(`{3,}|~{3,})/.exec(line)
      if (fm) {
        const ch = fm[1][0]
        const len = fm[1].length
        if (!fenceChar) { fenceChar = ch; fenceLen = len }
        else if (fenceChar === ch && len >= fenceLen) { fenceChar = ''; fenceLen = 0 }
        continue
      }
      if (fenceChar) continue

      const stripped = line.replace(/`+[^`\n]*`+/g, '')
      const candidates = []
      for (const m of stripped.matchAll(/!?\[[^\]]*\]\(([^)\n]+)\)/g)) candidates.push(m[1])
      const refM = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(stripped)
      if (refM) candidates.push(refM[1])

      for (const raw of candidates) {
        const noTitle = raw.trim().replace(/\s+(?:"[^"]*"|'[^']*')\s*$/, '').trim()
        if (!noTitle || noTitle.startsWith('#')) continue
        if (/^(?:https?:|mailto:|tel:|data:|javascript:|file:)/i.test(noTitle)) continue
        if (/[<>\{\}*?]/.test(noTitle)) continue
        const clean = noTitle.split(/[?#]/)[0].trim()
        if (!clean) continue
        const decoded = decodeUriSafe(clean)
        const targetAbs = decoded.startsWith('/') ? join(repoRoot, decoded.slice(1)) : resolve(dirname(f.full), decoded)
        if (!existsSync(targetAbs)) {
          perFileCount += 1
          if (perFileCount <= 15) {
            addFinding(findings, {
              id: `docs.dead-link.${f.rel}:${i + 1}.${clean}`,
              category: 'docs',
              severity: 'medium',
              file: f.rel,
              line: i + 1,
              title: `Broken relative Markdown link in ${f.rel}:${i + 1} -> "${clean}"`,
              action: `Fix or remove broken link "${clean}" in ${f.rel}.`,
            })
          }
        }
      }
    }
  }
}

export function isAuthoritativeEvergreenDoc(rel, { authoritativeTddPath = null, codeDir = '' } = {}) {
  if (rel === 'AGENTS.md' || rel === 'docs/TDD.md' || isRootReadmeRel(rel) || rel === 'ARCHITECTURE.md') return true
  if (/^(?:contributing|security)(?:\.[a-z0-9_.-]+)?\.(?:md|mdx|rst|txt)$/i.test(rel)) return true
  if (authoritativeTddPath && rel === authoritativeTddPath) return true
  if (codeDir && (rel === `${codeDir}/AGENTS.md` || rel === `${codeDir}/CLAUDE.md`)) return true
  return false
}

async function checkDocChurnStaleness(repoRoot, isGit, scopeRel, findings, authoritativeTddPath = null) {
  if (!isGit) return
  const wtGitDir = resolveGitDirFast(repoRoot)
  const fastHead = readHeadFast(wtGitDir)
  if (fastHead ? !fastHead.oid : !(await gitRun(repoRoot, ['rev-parse', '--verify', 'HEAD'])).ok) return
  if (fastHead?.oid && wtGitDir) {
    const fastSmallHistory = collectAncestorsDagFast(wtGitDir, fastHead.oid, 7)
    if (fastSmallHistory && fastSmallHistory.size < 8) return
  }
  const logRes = await gitRun(repoRoot, ['log', '-n', '80', '--name-only', '--format=__COMMIT__%ct'])
  if (!logRes.ok || !logRes.stdout) return

  const commits = []
  let cur = null
  for (const line of logRes.stdout.split('\n')) {
    if (line.startsWith('__COMMIT__')) {
      if (cur) commits.push(cur)
      cur = { ts: Number(line.slice(10)) || 0, files: [] }
    } else if (cur && line.trim()) {
      const clean = posixPath(line.trim())
      if (!clean.startsWith('.worktrees/') && !isMacOsJunkPath(clean)) cur.files.push(clean)
    }
  }
  if (cur) commits.push(cur)
  if (commits.length < 8) return

  const targetDoc = authoritativeTddPath
    || (existsSync(join(repoRoot, 'docs', 'TDD.md')) ? 'docs/TDD.md' : findPrimaryReadmeRel(repoRoot))
  if (!targetDoc) return

  const isDocUpdate = (rel, codeDir) => isAuthoritativeEvergreenDoc(rel, { authoritativeTddPath, codeDir })
  const codeDirKey = (rel) => {
    const parts = rel.split('/')
    if (parts.length <= 1) return ''
    return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]
  }

  const manifest = !scopeRel ? readJsonSafe(join(repoRoot, '.agents', 'skills', '.pf-manifest.json')) : null
  const hasManagedSkillsMirror = Boolean(
    !scopeRel
    && manifest
    && typeof manifest === 'object'
    && !Array.isArray(manifest)
    && typeof manifest.files === 'object'
    && manifest.files !== null
    && !Array.isArray(manifest.files),
  )
  const shouldSkipChurnFile = (rel) =>
    !CODE_EXT_RE.test(rel)
    || isTestOrFixtureFile(rel)
    || (hasManagedSkillsMirror && rel.startsWith('.agents/skills/'))

  const dirChurn = new Map()
  for (const c of commits) {
    const seenDirs = new Set()
    for (const rel of c.files) {
      if (shouldSkipChurnFile(rel)) continue
      if (scopeRel && rel !== scopeRel && !rel.startsWith(`${scopeRel}/`)) continue
      const d = codeDirKey(rel)
      if (!d || seenDirs.has(d)) continue
      seenDirs.add(d)
      if (!dirChurn.has(d)) dirChurn.set(d, { sinceDoc: 0 })
    }
  }

  for (const [dir, stats] of dirChurn.entries()) {
    for (const c of commits) {
      if (c.files.some((rel) => isDocUpdate(rel, dir))) break
      if (c.files.some((rel) => !shouldSkipChurnFile(rel) && codeDirKey(rel) === dir)) stats.sinceDoc += 1
    }
    if (stats.sinceDoc >= 8) {
      addFinding(findings, {
        id: `docs.stale-vs-churn.${dir}`,
        category: 'docs',
        severity: 'medium',
        file: targetDoc,
        title: `Doc staleness vs git churn: "${dir}/" has ${stats.sinceDoc} commit(s) in last 80 without "${targetDoc}"/doc update`,
        action: `Run dev-explore (\`repo-map.mjs --focus ${dir}\`) to inspect recent interface/entrypoint changes and sync "${targetDoc}" / AGENTS.md.`,
      })
    }
  }
}

function extractTddBacktickPaths(rawTok) {
  const tok = String(rawTok ?? '').trim()
  if (!tok || /^(?:https?:|mailto:|git@|ssh:|\/|[A-Za-z]:|<)/.test(tok)) return []
  if (/[\s;|&]/.test(tok)) {
    const out = []
    for (const word of tok.split(/[\s,;()'"`]+/)) {
      const clean = word.trim().replace(/^\.\//, '')
      if (!clean || !clean.includes('/') || clean.endsWith('/')) continue
      if (clean.startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(clean)) continue
      if (/^(?:https?:|mailto:|git@|ssh:|\/|[A-Za-z]:|<)/.test(clean)) continue
      if (/[<>*?{}$]/.test(clean) || clean.includes('..')) continue
      if (!REPO_PATH_EXT_RE.test(clean)) continue
      out.push(clean)
    }
    return out
  }
  const clean = tok.replace(/^\.\//, '')
  if (!clean.includes('/') || clean.endsWith('/')) return []
  if (/[<>*?{}$]/.test(clean) || clean.includes('..')) return []
  if (!REPO_PATH_EXT_RE.test(clean)) return []
  return [clean]
}

function hasExistingArchitectureDocs(repoRoot) {
  if (resolveAuthoritativeTddPath(repoRoot)) return true
  return existsSync(join(repoRoot, 'docs', 'adr'))
}

/**
 * TDD 的「空壳」判据：文件在、但里面没有架构。
 *
 * 三种形状各自能骗过一道检查：
 *
 *   - **模板原样**：把模板复制过来就提交，占位符原封不动。文件存在、章节齐全，
 *     一个字的信息都没有；
 *   - **只有骨架**：标题对了，内容只有模块名清单。看起来像写了，实际没讲任何职责与边界；
 *   - **短到不可能**：三五行，撑不起「模块、数据流、不变量」这三件事。
 *
 * 只靠「文件在不在」判的后果是把这四种都当成合格——包括「文件完全不存在」那一种
 * 由 `docs.missing-tdd` 单独管。空壳比没有更糟：它看起来像有。
 *
 * @returns {string[]} 命中的理由；空数组表示不像空壳
 */
function tddShellReasons(text) {
  const reasons = []
  const raw = String(text ?? '').replace(/\r\n/g, '\n')
  // 模板占位符原样留着：`{{VAR}}` 是本工具的占位语法，「待补齐」是模板里的填空提示。
  const placeholders = [...new Set(raw.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])]
  if (placeholders.length > 0) {
    reasons.push(`还留着 ${placeholders.length} 个未填的模板占位符（${placeholders.slice(0, 3).join('、')}）`)
  }
  // 去掉前置 frontmatter 与空行后再数：模板的前几行大多是 YAML，不算正文。
  const body = raw.replace(/^---\n[\s\S]*?\n---\n/, '')
  const meaningful = body.split('\n').filter((line) => line.trim() && !/^\s*<!--/.test(line))
  if (meaningful.length <= 4) {
    reasons.push(`正文只有 ${meaningful.length} 行非空内容`)
  } else {
    const missing = checkTddStructure(raw)
    if (missing.length >= 3) {
      reasons.push(`主干缺 ${missing.length} 节（${missing.map((m) => m.code).slice(0, 3).join('、')}）——标题在，内容没写`)
    }
  }
  return reasons
}

export async function auditDocs(repoRoot, isGit, files, devProfile, defaultBranch, scopeRel, rawAgentsMeta, findings) {
  const hasCode = files.some((f) => CODE_EXT_RE.test(f.name))
  const hasReadme = files.some((f) => !f.rel.includes('/') && isRootReadmeRel(f.name)) || Boolean(findPrimaryReadmeRel(repoRoot))
  if (!hasReadme) {
    addFinding(findings, {
      id: 'docs.missing-readme',
      category: 'docs',
      severity: 'high',
      title: 'Missing README.md',
      action: 'Create README.md with project purpose, setup, and usage commands.',
    })
  }

  const agentsPath = join(repoRoot, 'AGENTS.md')
  const agentsInfo = readTextStrictInfo(agentsPath)
  const decisions = agentsInfo?.text ? readDecisions(agentsInfo.text) : new Set()

  if (!agentsInfo?.text) {
    addFinding(findings, {
      id: 'docs.missing-agents',
      category: 'docs',
      severity: hasCode ? 'medium' : 'low',
      title: 'Missing AGENTS.md contract',
      action: 'Create AGENTS.md with Dev Profile and repository invariants.',
    })
  } else {
    const bytes = Buffer.byteLength(agentsInfo.text, 'utf8')
    if (bytes > AGENTS_MAX_BYTES) {
      addFinding(findings, {
        id: 'docs.agents-over-30kb',
        category: 'docs',
        severity: 'critical',
        file: 'AGENTS.md',
        title: `AGENTS.md is ${bytes} bytes (> ${AGENTS_MAX_BYTES} byte hard cap)`,
        action: 'Prune redundant prose or move subdirectory-specific rules to <subdir>/AGENTS.md.',
      })
    } else if (bytes > AGENTS_WARN_BYTES) {
      addFinding(findings, {
        id: 'docs.agents-near-24kb',
        category: 'docs',
        severity: 'medium',
        file: 'AGENTS.md',
        title: `AGENTS.md is ${bytes} bytes (approaching ${AGENTS_MAX_BYTES} byte cap; warn >= ${AGENTS_WARN_BYTES})`,
        action: 'Keep AGENTS.md compact by trimming obsolete notes and linking to docs/TDD.md.',
      })
    }
    checkAgentsPathsAndRefs(repoRoot, agentsInfo.text, devProfile, defaultBranch, findings)
    if (!scopeRel && rawAgentsMeta.hasHighRiskKey && Array.isArray(devProfile['high-risk']) && devProfile['high-risk'].length > 0) {
      for (const rawPat of devProfile['high-risk']) {
        const pat = String(rawPat ?? '').trim()
        if (!pat) continue
        const matched = files.some((f) => matchGlob(f.rel, pat))
          || (!/[*?]/.test(pat) && existsSync(join(repoRoot, pat.replace(/\/+$/, ''))))
        if (!matched) {
          addFinding(findings, {
            id: `docs.devprofile-unmatched-high-risk.${pat}`,
            category: 'docs',
            severity: 'medium',
            file: 'AGENTS.md',
            title: `Dev Profile high-risk pattern "${pat}" matched 0 files in repository`,
            action: 'Update or remove stale high-risk pattern in AGENTS.md.',
          })
        }
      }
    }
  }

  const authoritativeTddPath = resolveAuthoritativeTddPath(repoRoot, decisions)
  const tddInfo = authoritativeTddPath ? readTextStrictInfo(join(repoRoot, authoritativeTddPath)) : undefined
  if (hasCode && !tddInfo?.text) {
    if (!decisions.has('no-tdd') && !decisions.has('existing-docs') && !hasExistingArchitectureDocs(repoRoot)) {
      addFinding(findings, {
        id: 'docs.missing-tdd',
        category: 'docs',
        severity: 'medium',
        file: 'docs/TDD.md',
        title: 'Missing docs/TDD.md technical architecture authority',
        action: 'Run dev-explore (`repo-map.mjs`) first, then create docs/TDD.md documenting modules, data flows, and invariants (or record `no-tdd` / `tdd-authority` in AGENTS.md ## 取舍).',
      })
    }
  } else if (tddInfo?.text && authoritativeTddPath) {
    const isTddDocFormat = /(?:^|\/).*tdd\.md$/i.test(authoritativeTddPath)
    if (isTddDocFormat && !decisions.has('existing-docs') && !decisions.has('no-tdd')) {
      // 空壳 TDD 与「没有 TDD」是两种不同的病，判红的通道也不同：
      // `docs.missing-tdd` 只说明「缺一份」，档位 medium；空壳是「有一份假的」，
      // 它会让每个照着它理解架构的人读错，所以按 high 阻断（`--strict` 会因它退出非 0）。
      const shellReasons = tddShellReasons(tddInfo.text)
      if (shellReasons.length > 0) {
        addFinding(findings, {
          id: 'docs.tdd-shell',
          category: 'docs',
          severity: 'high',
          file: authoritativeTddPath,
          title: `${authoritativeTddPath} exists but carries no architecture: ${shellReasons.join('；')}`,
          action: `Run dev-explore (\`repo-map.mjs\`) and write real modules, data flows, and invariants into ${authoritativeTddPath} (or record \`no-tdd\` / \`existing-docs\` in AGENTS.md ## 取舍 if the project genuinely has no architecture to document).`,
        })
      }
      const allMods = discoverCodeModules(repoRoot)
      const mods = scopeRel ? allMods.filter((m) => m.path === scopeRel || m.path.startsWith(`${scopeRel}/`)) : allMods
      const undocumented = mods.filter((m) => !tddInfo.text.includes(m.name) && !tddInfo.text.includes(m.path))
      if (undocumented.length > 0) {
        addFinding(findings, {
          id: 'docs.tdd-module-drift',
          category: 'docs',
          severity: 'medium',
          file: authoritativeTddPath,
          title: `${authoritativeTddPath} omits ${undocumented.length} module(s): ${undocumented.slice(0, 6).map((m) => m.path).join(', ')}`,
          action: `Run dev-explore (\`repo-map.mjs\`) and update ${authoritativeTddPath} module table to match current source layout.`,
        })
      }
    }
    const checkedPaths = new Set()
    for (const m of tddInfo.text.matchAll(/`([^`\n]+)`/g)) {
      for (const cand of extractTddBacktickPaths(m[1])) {
        if (checkedPaths.has(cand)) continue
        checkedPaths.add(cand)
        if (!existsSync(join(repoRoot, cand))) {
          addFinding(findings, {
            id: `docs.tdd-stale-path.${cand}`,
            category: 'docs',
            severity: 'medium',
            file: authoritativeTddPath,
            title: `Stale path referenced in ${authoritativeTddPath}: ${cand}`,
            action: `Update or remove "${cand}" in ${authoritativeTddPath}.`,
          })
        }
      }
    }
  }

  for (const f of files) {
    if (!/\.mdx?$/i.test(f.name)) continue
    if (f.rel.startsWith('templates/') || f.rel.startsWith('docs/archive/')) continue
    const info = readTextStrictInfo(f.full)
    if (!info?.text || !/```+\s*mermaid/i.test(info.text)) continue
    const mRes = checkMermaidLabelWidth(info.text)
    for (const v of mRes.violations.slice(0, 8)) {
      addFinding(findings, {
        id: `docs.mermaid-label-width.${f.rel}:${v.line}.${v.kind}`,
        category: 'docs',
        severity: 'medium',
        file: f.rel,
        line: v.line,
        title: `Mermaid truncation risk in ${f.rel}:${v.line}: ${v.message}`,
        action: v.fixHint,
      })
    }
  }

  checkMarkdownDeadLinks(repoRoot, files, findings)
  checkEvergreenAuthorityDocs(repoRoot, files, agentsInfo?.text ?? '', authoritativeTddPath, findings)
  await checkDocChurnStaleness(repoRoot, isGit, scopeRel, findings, authoritativeTddPath)

  const todoDir = join(repoRoot, 'docs', 'todo')
  if (existsSync(todoDir)) {
    try {
      for (const name of readdirSync(todoDir)) {
        if (!name.endsWith('.md')) continue
        const info = readTextStrictInfo(join(todoDir, name))
        if (!info?.text) continue
        if (!isManagedPlanDoc(`docs/todo/${name}`, info.text)) continue
        const unchecked = (info.text.match(/^- \[ \]\s+.+$/gm) ?? []).length
        if (unchecked === 0) {
          addFinding(findings, {
            id: `docs.unarchived-completed-todo.${name}`,
            category: 'docs',
            severity: 'low',
            file: `docs/todo/${name}`,
            title: `Completed todo not yet archived: docs/todo/${name}`,
            action: `Move to docs/archive/todo/${name}.`,
          })
        }
      }
    } catch { /* ignore */ }
  }

  const activeDocStatus = {
    prd: new Set(['draft', 'active', 'in_review', 'done', 'dropped']),
    spec: new Set(['draft', 'approved', 'implementing', 'in_review', 'implemented', 'superseded']),
    todo: new Set(['draft', 'active', 'pending', 'in_review', 'done', 'archived', 'dropped']),
  }
  for (const [subDir, expectedKind] of [['prd', 'prd'], ['specs', 'spec'], ['todo', 'todo']]) {
    const dirRel = `docs/${subDir}`
    if (scopeRel && scopeRel !== dirRel && !scopeRel.startsWith(`${dirRel}/`) && !dirRel.startsWith(`${scopeRel}/`)) continue
    const dirAbs = join(repoRoot, 'docs', subDir)
    if (!existsSync(dirAbs)) continue
    let entries = []
    try { entries = readdirSync(dirAbs, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      if (!ent.isFile() || !ent.name.endsWith('.md')) continue
      const relDoc = `${dirRel}/${ent.name}`
      const fullDoc = join(dirAbs, ent.name)
      const info = readTextStrictInfo(fullDoc)
      if (!info?.text) continue
      if (!isManagedPlanDoc(relDoc, info.text)) continue
      const fm = parseDocFrontmatter(info.text)
      const fn = parseDocFilename(ent.name)

      if (fm.malformedFrontmatter) {
        addFinding(findings, {
          id: `docs.frontmatter-invalid.${relDoc}`,
          category: 'docs',
          severity: 'medium',
          file: relDoc,
          title: `Invalid YAML frontmatter in ${relDoc}: ${fm.syntaxErrors[0] ?? 'syntax error'}`,
          action: 'Fix YAML frontmatter header (`--- ... ---`) or regenerate via `doc-plan.mjs`.',
        })
        continue
      }

      if (fm.hasFrontmatter) {
        const kindVal = fm.data.kind
        const statusVal = typeof fm.data.status === 'string' ? fm.data.status.toLowerCase() : ''
        const rawIssue = fm.data.issue
        let issueNum = null
        let issueInvalid = false
        if (rawIssue !== undefined && rawIssue !== null && rawIssue !== '') {
          if (typeof rawIssue === 'number') {
            if (Number.isInteger(rawIssue) && rawIssue > 0) issueNum = rawIssue
            else issueInvalid = true
          } else {
            const s = String(rawIssue).trim()
            if (/^#?\d+$/.test(s)) {
              issueNum = Number(s.replace(/^#/, ''))
              if (issueNum <= 0) issueInvalid = true
            } else {
              const um = /\/issues\/(\d+)(?:[/?#]|$)/.exec(s)
              if (um) issueNum = Number(um[1])
              else issueInvalid = true
            }
          }
        }

        if (!kindVal || kindVal !== expectedKind || !statusVal || !activeDocStatus[expectedKind].has(statusVal) || issueInvalid) {
          addFinding(findings, {
            id: `docs.frontmatter-invalid.${relDoc}`,
            category: 'docs',
            severity: 'medium',
            file: relDoc,
            title: `Invalid frontmatter metadata in ${relDoc} (check kind=${expectedKind}, status, or issue)`,
            action: `Ensure YAML frontmatter specifies \`kind: ${expectedKind}\`, valid \`status\`, and valid \`issue\` (integer or null).`,
          })
        }

        if (!issueInvalid && fn && ((issueNum && fn.issue !== issueNum) || (fn.issue && issueNum !== fn.issue))) {
          addFinding(findings, {
            id: `docs.filename-issue-mismatch.${relDoc}`,
            category: 'docs',
            severity: 'medium',
            file: relDoc,
            title: `Frontmatter issue (${issueNum ?? 'null'}) mismatches filename ${ent.name}`,
            action: `Run \`doc-plan.mjs link ${relDoc} --issue ${issueNum ?? fn.issue}\` to synchronize filename and frontmatter.`,
          })
        }

        for (const rk of ['related_prd', 'related_spec', 'related_todo']) {
          const rv = fm.data[rk]
          if (typeof rv === 'string' && rv.trim() && !/^(?:无|none|null)$/i.test(rv.trim())) {
            const targetAbs = resolve(dirname(fullDoc), rv.trim())
            if (!existsSync(targetAbs)) {
              addFinding(findings, {
                id: `docs.broken-related-link.${relDoc}.${rk}`,
                category: 'docs',
                severity: 'medium',
                file: relDoc,
                title: `Broken frontmatter link \`${rk}: ${rv.trim()}\` in ${relDoc}`,
                action: 'Fix the relative path or run `doc-plan.mjs link` to resync sibling links.',
              })
            }
          }
        }
      }
    }
  }
}

function sanitizeCriterionText(raw, repoRoot) {
  let s = String(raw ?? '')
    .replace(/<([^>\n]+)>/g, '{$1}')
    .replace(/\b(?:TBD|TODO|FIXME)\b/gi, '待清理标记')
    .replace(/待补充|待填写|待核实/g, '待治理项')
  s = s.replace(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+)\b/g, (m, p) => (existsSync(join(repoRoot, p)) ? m : `${p}（旧路径不存在 / removed）`))
  return s.replace(/\s+/g, ' ').trim()
}

export async function buildPlan(findings, repoRoot, devProfile, isGit) {
  const order = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9))
  const batch1 = sorted.filter((f) => f.severity === 'critical' || f.severity === 'high')
  const batch2 = sorted.filter((f) => f.severity === 'medium')
  const batch3 = sorted.filter((f) => f.severity === 'low' || f.severity === 'info')

  const batches = [
    { batch: 1, name: 'Critical & High (Security / Broken Contracts / Size Gates)', items: batch1 },
    { batch: 2, name: 'Medium (Docs Parity / Tests / Stale Worktrees / Hygiene)', items: batch2 },
    { batch: 3, name: 'Low & Info (Deadcode Markers / Perf Hints / Local Drift)', items: batch3 },
  ].filter((b) => b.items.length > 0)

  const dateTag = docDateTag()
  const taskId = `govern-${dateTag}`
  const todoFilename = buildDocFilename({ date: dateTag, slug: 'govern-remediation', kind: 'todo' })
  const todoRel = `docs/todo/${todoFilename}`

  let headSha = 'uncommitted'
  let headBranch = null
  if (isGit) {
    const fastPlanHead = readHeadFast(resolveGitDirFast(repoRoot))
    if (fastPlanHead) {
      if (fastPlanHead.oid) headSha = fastPlanHead.oid
      if (fastPlanHead.branch) headBranch = fastPlanHead.branch
    } else {
      const [hr, br] = await Promise.all([
        gitRun(repoRoot, ['rev-parse', 'HEAD']),
        gitRun(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
      ])
      if (hr.ok && hr.stdout.trim()) headSha = hr.stdout.trim()
      if (br.ok && br.stdout.trim()) headBranch = br.stdout.trim()
    }
  }

  const scopeSet = new Set()
  for (const f of sorted.slice(0, 12)) {
    if (f.file && existsSync(join(repoRoot, f.file))) scopeSet.add(f.file)
  }
  const scopePaths = scopeSet.size > 0 ? [...scopeSet] : [existsSync(join(repoRoot, 'AGENTS.md')) ? 'AGENTS.md' : 'README.md']
  const quickCmd = devProfile?.['quick-test']?.[0] || devProfile?.['full-test']?.[0] || '按项目验证脚本执行检查'
  const skills = resolveAvailableSkills(repoRoot)
  const exploreRef = ['.agents/skills/dev-explore/scripts/repo-map.mjs', '.agents/skills/dev-explore/SKILL.md'].find((p) => existsSync(join(repoRoot, p)))
  const governRef = ['.agents/skills/dev-govern/scripts/govern-audit.mjs', '.agents/skills/dev-govern/SKILL.md'].find((p) => existsSync(join(repoRoot, p)))
  const reusableModules = [
    ...(skills.has('dev-explore') && exploreRef ? [`\`${exploreRef}\`（只读梳理模块入口与可复用基建）`] : []),
    ...(governRef ? [`\`${governRef}\`（只读审计与治理复核）`] : ['项目既有验证与构建脚本']),
  ]

  const hasExploreTargets = sorted.some((f) => /^(?:docs\.(?:missing-tdd|tdd-module-drift|tdd-stale-path|stale-vs-churn)|hygiene\.(?:god-file|arch-boundary))/.test(String(f.id ?? '')))
  const hasL3Debt = sorted.some((f) => /^(?:hygiene\.(?:arch-boundary|god-file)|docs\.agents-over-30kb)/.test(String(f.id ?? '')))

  const criteria = sorted.length > 0
    ? sorted.slice(0, 10).map((f) => `[${f.severity}] ${sanitizeCriterionText(f.title, repoRoot)}（复跑 govern-audit 确认 \`${f.id}\` 归零，退出码 0）`)
    : ['复跑 govern-audit 确认仓库维持 0 个 critical/high 缺陷（退出码 0）']

  // 治理整改的 Todo 是**已经定好**的内容（批次、验收命令、范围都是算出来的），
  // 所以直接给足取值，别让模板里的示范占位留下来——一份带着 `<可能出问题的事>`
  // 的文档过不了自己的 audit，等于每次生成都要人再修一遍。
  const todoDraft = renderStandardDocTemplate({
    kind: 'todo',
    title: 'Governance Remediation Plan',
    safeSlug: 'govern-remediation',
    owner: 'govern-audit',
    headSha,
    headBranch,
    taskId,
    quickCmd,
    scopePaths,
    reusableModules,
    nonGoals: ['不引入与治理整改批无关的业务逻辑或公开接口变更'],
    doorType: 'two-way',
    rollbackPath: '局部治理重构，可通过 git revert 或放弃当前分支回退。',
    criteria,
  })

  return { batches, taskId, todoRel, todoDraft, hasExploreTargets, hasL3Debt }
}
