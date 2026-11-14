/**
 * govern-docs.mjs -- Documentation parity, AGENTS.md checks, Mermaid 16/12 validation,
 * Frontmatter/link audits, decision-aware TDD exemptions, and standard Todo generator.
 *
 * Self-contained module: uses Node 18+ built-in `node:*` modules and `kit/skills/lib/` only.
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  buildDocFilename, checkMermaidLabelWidth, docDateTag, parseDocFilename,
  parseDocFrontmatter, renderStandardDocTemplate,
} from '../../lib/docs.mjs'
import { gitRun, isMacOsJunkPath, posixPath } from '../../lib/git.mjs'
import { readDecisions } from '../../lib/profile.mjs'
import { CODE_EXT_RE, TEST_FILE_RE, matchGlob } from '../../lib/static-gates.mjs'
import { AGENTS_MAX_BYTES, AGENTS_WARN_BYTES, addFinding, readTextStrictInfo } from './govern-checks.mjs'

const REPO_PATH_EXT_RE = /\.(?:mjs|cjs|js|ts|tsx|jsx|py|sh|ps1|rs|go|java|kt|cs|json|ya?ml|toml|lock|txt|cfg|ini|md)$/i

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

  for (const m of agentsText.matchAll(/`([^`\n]+)`/g)) {
    const tok = m[1].trim()
    for (const word of tok.split(/\s+/)) {
      const p = extractRepoPath(word)
      if (p) paths.add(p)
    }
    for (const bm of tok.matchAll(/\bgit\s+(?:switch|checkout)\s+([A-Za-z0-9][A-Za-z0-9._/-]*)/g)) branches.add(bm[1])
  }

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
    if (f.rel.startsWith('templates/')) continue
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

async function checkDocChurnStaleness(repoRoot, isGit, scopeRel, findings) {
  if (!isGit || !(await gitRun(repoRoot, ['rev-parse', '--verify', 'HEAD'])).ok) return
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

  const hasTdd = existsSync(join(repoRoot, 'docs', 'TDD.md'))
  const targetDoc = hasTdd ? 'docs/TDD.md' : existsSync(join(repoRoot, 'README.md')) ? 'README.md' : ''
  if (!targetDoc) return

  const isDocUpdate = (rel, codeDir) => {
    if (rel === 'AGENTS.md' || rel === 'docs/TDD.md' || rel === 'README.md' || rel === 'README.en.md' || rel === 'ARCHITECTURE.md') return true
    if (codeDir && rel === `${codeDir}/AGENTS.md`) return true
    if (rel.startsWith('docs/') && rel.endsWith('.md') && !rel.startsWith('docs/todo/') && !rel.startsWith('docs/archive/')) return true
    return false
  }
  const codeDirKey = (rel) => {
    const parts = rel.split('/')
    if (parts.length <= 1) return ''
    return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]
  }

  const dirChurn = new Map()
  for (const c of commits) {
    const seenDirs = new Set()
    for (const rel of c.files) {
      if (!CODE_EXT_RE.test(rel) || TEST_FILE_RE.test(rel)) continue
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
      if (c.files.some((rel) => CODE_EXT_RE.test(rel) && !TEST_FILE_RE.test(rel) && codeDirKey(rel) === dir)) stats.sinceDoc += 1
    }
    if (stats.sinceDoc >= 8) {
      addFinding(findings, {
        id: `docs.stale-vs-churn.${dir}`,
        category: 'docs',
        severity: 'medium',
        file: targetDoc,
        title: `Doc staleness vs git churn: "${dir}/" has ${stats.sinceDoc} commit(s) in last 80 without "${targetDoc}"/doc update`,
        action: `Review recent changes in "${dir}/" and sync "${targetDoc}" / AGENTS.md if architecture or interfaces changed.`,
      })
    }
  }
}

function hasExistingArchitectureDocs(repoRoot) {
  if (existsSync(join(repoRoot, 'ARCHITECTURE.md'))) return true
  try {
    for (const name of readdirSync(repoRoot)) {
      if (/-TDD\.md$/i.test(name)) return true
    }
  } catch { /* ignore */ }
  for (const sub of ['docs/architecture', 'docs/design', 'docs/adr']) {
    if (existsSync(join(repoRoot, sub))) return true
  }
  return false
}

export async function auditDocs(repoRoot, isGit, files, devProfile, defaultBranch, scopeRel, rawAgentsMeta, findings) {
  const hasCode = files.some((f) => CODE_EXT_RE.test(f.name))
  if (!existsSync(join(repoRoot, 'README.md'))) {
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

  const tddPath = join(repoRoot, 'docs', 'TDD.md')
  const tddInfo = readTextStrictInfo(tddPath)
  if (hasCode && !tddInfo?.text) {
    if (!decisions.has('no-tdd') && !decisions.has('existing-docs') && !hasExistingArchitectureDocs(repoRoot)) {
      addFinding(findings, {
        id: 'docs.missing-tdd',
        category: 'docs',
        severity: 'medium',
        file: 'docs/TDD.md',
        title: 'Missing docs/TDD.md technical architecture authority',
        action: 'Create docs/TDD.md documenting modules, data flows, and invariants (or record `no-tdd` in AGENTS.md ## 取舍).',
      })
    }
  } else if (tddInfo?.text) {
    const allMods = discoverCodeModules(repoRoot)
    const mods = scopeRel ? allMods.filter((m) => m.path === scopeRel || m.path.startsWith(`${scopeRel}/`)) : allMods
    const undocumented = mods.filter((m) => !tddInfo.text.includes(m.name) && !tddInfo.text.includes(m.path))
    if (undocumented.length > 0) {
      addFinding(findings, {
        id: 'docs.tdd-module-drift',
        category: 'docs',
        severity: 'medium',
        file: 'docs/TDD.md',
        title: `docs/TDD.md omits ${undocumented.length} module(s): ${undocumented.slice(0, 6).map((m) => m.path).join(', ')}`,
        action: 'Update docs/TDD.md module table to match current source layout.',
      })
    }
    for (const m of tddInfo.text.matchAll(/`([^`\n]+)`/g)) {
      const tok = m[1].trim()
      if (!tok.includes('/') || /^(?:https?:|\/|[A-Za-z]:|<)/.test(tok) || /[<>*?]/.test(tok) || tok.endsWith('/')) continue
      if (!REPO_PATH_EXT_RE.test(tok)) continue
      if (!existsSync(join(repoRoot, tok))) {
        addFinding(findings, {
          id: `docs.tdd-stale-path.${tok}`,
          category: 'docs',
          severity: 'medium',
          file: 'docs/TDD.md',
          title: `Stale path referenced in docs/TDD.md: ${tok}`,
          action: `Update or remove "${tok}" in docs/TDD.md.`,
        })
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
  await checkDocChurnStaleness(repoRoot, isGit, scopeRel, findings)

  const todoDir = join(repoRoot, 'docs', 'todo')
  if (existsSync(todoDir)) {
    try {
      for (const name of readdirSync(todoDir)) {
        if (!name.endsWith('.md')) continue
        const info = readTextStrictInfo(join(todoDir, name))
        if (!info?.text) continue
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
  const todoFilename = buildDocFilename({ date: dateTag, slug: 'govern-remediation', kind: 'todo' })
  const todoRel = `docs/todo/${todoFilename}`

  let headSha = 'uncommitted'
  let headBranch = null
  if (isGit) {
    const [hr, br] = await Promise.all([
      gitRun(repoRoot, ['rev-parse', 'HEAD']),
      gitRun(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
    ])
    if (hr.ok && hr.stdout.trim()) headSha = hr.stdout.trim()
    if (br.ok && br.stdout.trim()) headBranch = br.stdout.trim()
  }

  const scopeSet = new Set()
  for (const f of sorted.slice(0, 12)) {
    if (f.file && existsSync(join(repoRoot, f.file))) scopeSet.add(f.file)
  }
  const scopePaths = scopeSet.size > 0 ? [...scopeSet] : [existsSync(join(repoRoot, 'AGENTS.md')) ? 'AGENTS.md' : 'README.md']
  const quickCmd = devProfile?.['quick-test']?.[0] || devProfile?.['full-test']?.[0] || '按项目验证脚本执行检查'
  const hasGovernSkill = existsSync(join(repoRoot, '.agents', 'skills', 'dev-govern', 'scripts', 'govern-audit.mjs'))
  const reusableModules = [
    hasGovernSkill ? '`.agents/skills/dev-govern/scripts/govern-audit.mjs`（只读审计与治理复核）' : '项目既有验证与构建脚本',
  ]

  const criteria = sorted.length > 0
    ? sorted.slice(0, 10).map((f) => `[${f.severity}] ${f.title}`)
    : ['Verify repository remains clean with zero critical/high gaps']

  const todoDraft = renderStandardDocTemplate({
    kind: 'todo',
    title: 'Governance Remediation Plan',
    safeSlug: 'govern-remediation',
    headSha,
    headBranch,
    taskId: `govern-${dateTag}`,
    quickCmd,
    scopePaths,
    reusableModules,
    nonGoals: ['不引入与治理整改批无关的业务逻辑或公开接口变更'],
    doorType: 'two-way',
    rollbackPath: '局部治理重构，可通过 git revert 或放弃当前分支回退。',
    criteria,
  })

  return { batches, todoRel, todoDraft }
}
