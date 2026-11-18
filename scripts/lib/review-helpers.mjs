/**
 * review-helpers.mjs —— 交付体检的 CLI 参数解析、渲染辅助与治理 PRD 产物计划覆盖检查。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 scripts/review.mjs 调用。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { readTextSafe } from './text.mjs'
import { parseMarkers } from './protocol.mjs'
import { COMMAND_DISPLAY_MAX_BYTES, truncateCommandForDisplay } from '../../kit/skills/lib/command-lex.mjs'
import { parseDocFrontmatter } from '../../kit/skills/lib/doc-frontmatter.mjs'

export const REVIEW_SCOPES = new Set([
  'git', 'agents', 'docs', 'artifacts', 'kit', 'license', 'secrets', 'ci', 'release', 'collaboration', 'ecosystem',
])

export async function inspectContract(root, facts) {
  try {
    const { contractHealth } = await import('../compose-agents.mjs')
    const health = await contractHealth(root, { facts })
    return { state: 'ok', health, error: null }
  } catch (error) {
    return {
      state: 'unavailable',
      health: null,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 读目录名；读不到就返回空数组——「读不到」由别的判据报，这里不制造第二个报错。 */
export function readdirSyncSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

const PLACEHOLDER_NAME = /^(?:administrator|admin|root|user|default|ubuntu|ec2-user|vagrant|runner|builder)$/i
const PLACEHOLDER_EMAIL_DOMAIN = /@(?:localhost|.*\.local|.*\.localdomain|.*\.internal)$/i

/**
 * 系统占位署名：名字是系统默认值之一，或邮箱落在本地无效域名上。
 */
export function placeholderIdentity(name, email) {
  const hits = []
  if (typeof name === 'string' && PLACEHOLDER_NAME.test(name.trim())) hits.push(`署名是系统默认值「${name.trim()}」`)
  if (typeof email === 'string' && PLACEHOLDER_EMAIL_DOMAIN.test(email.trim())) hits.push(`邮箱落在本地无效域名上（${email.trim()}）`)
  return hits
}

export function summarizeReviewResults(facts, results) {
  const by = (level) => results.filter((r) => r.level === level)
  const missing = by('missing')
  const pending = by('pending')
  const notice = by('notice')
  const ok = by('ok')
  return {
    target: facts.target,
    maturity: facts.maturity,
    git: {
      capabilities: facts.git?.capabilities ?? null,
    },
    facts,
    results,
    missing,
    pending,
    notice,
    ok,
    unscanned: results.filter((r) => r.verdictBlocked === true).map((r) => r.id),
    verdict: missing.length > 0 ? 'missing'
      : pending.length > 0 ? 'pending'
        : notice.length > 0 ? 'notice' : 'ok',
  }
}

export function renderRef(ref) {
  if (!ref) return ''
  return `\n        读：\`${ref.file}\` 的「${ref.section}」`
}

export function reviewHelpText(scopesSet) {
  return [
    '用法：node scripts/review.mjs [目标目录] [选项]',
    '',
    '  --scope=git,agents,docs  只验这几面（逗号分隔）',
    `                           可用：${[...scopesSet].join(', ')}`,
    '  --strict                 把「待定」也算没通过（CI 用）',
    '  --json                   输出机器可读的结果',
    '',
    '三档结论：缺（会出事）/ 待定（只有使用者能定）/ 可以更好（不拦）。',
    '待定项的答案写进目标项目 AGENTS.md 的「## 取舍」节，不用记 flag。',
  ].join('\n')
}

export function parseReviewCliArgs(argv, scopesSet) {
  let target = process.cwd()
  let scopes
  let strict = false
  let asJson = false
  let help = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true
      continue
    }
    if (arg === '--strict') strict = true
    else if (arg === '--json') asJson = true
    else if (arg.startsWith('--scope=')) {
      const list = arg.slice('--scope='.length).split(',').map((s) => s.trim()).filter(Boolean)
      const bad = list.filter((s) => !scopesSet.has(s))
      if (bad.length > 0) {
        return { error: `未知切面：${bad.join('、')}（可用：${[...scopesSet].join(', ')}）` }
      }
      scopes = new Set(list)
    } else if (!arg.startsWith('-')) {
      target = arg
    } else {
      return { error: `未知选项：${arg}（用 --help 看用法）` }
    }
  }
  return { target, scopes, strict, asJson, help }
}

const GOVERNANCE_PRD_TITLE_RE = /(?:项目治理|全仓治理|规范化|标准化|工程锻造|项目起步|接管项目|产物计划|governance|onboarding|project-forge-bootstrap)/i

const ARTIFACT_COVERAGE_TOKENS = Object.freeze({
  'pre-backup': ['pre-backup', 'backup', '快照', '.zip'],
  'git-baseline': ['git-baseline', '.gitattributes', '.gitignore', 'git 基线', '版本库'],
  'git-hooks': ['git-hooks', '.githooks', 'pre-push', '--with-hooks'],
  'kit-skills': ['kit-skills', '.agents/skills', '技能套件', 'equip'],
  'docs-tdd': ['docs-tdd', 'tdd.md', 'docs/tdd', '技术设计'],
  'agents-contract': ['agents-contract', 'agents.md', '工程契约', '项目契约', 'compose-agents'],
  readme: ['readme', 'readme.md'],
  contributing: ['contributing', 'contributing.md', '贡献指南'],
  license: ['license', '许可证', '授权'],
  releasing: ['releasing', 'releasing.md', '发版说明', '发布说明'],
  'ci-check': ['ci-check', 'check.yml', '检查流', '检查工作流', 'ci 检查'],
  'ci-release': ['ci-release', 'release.yml', '发布流', '发布工作流', '发版策略', '发布流水线'],
  'branch-protection': ['branch-protection', '分支保护', '--protect-branch'],
})

function isGovernancePrd(rel, fm, text) {
  const scopeVal = String(fm.data?.scope ?? fm.data?.prd_kind ?? fm.data?.category ?? '').toLowerCase()
  if (fm.data?.governance === true || scopeVal === 'governance') return true
  const h1 = /^#\s+(.+)$/m.exec(text)?.[1] ?? ''
  const title = String(fm.data?.title ?? '')
  const base = basename(rel, '.md')
  return GOVERNANCE_PRD_TITLE_RE.test(title) || GOVERNANCE_PRD_TITLE_RE.test(h1) || GOVERNANCE_PRD_TITLE_RE.test(base)
}

function extractCriteriaLinesText(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const picked = []
  for (const line of lines) {
    if (/^\s*(?:[-*]|\d+\.)\s*(?:\[[ xX]\]\s*)?(?:\*\*)?C\d+[:：]/.test(line) || /^\s*-\s*\[[ xX]\]\s+/.test(line)) {
      picked.push(line.toLowerCase())
    }
  }
  return picked.join('\n')
}

/**
 * 核对全仓治理 PRD 的 `C1..Cn` 是否逐项覆盖 `survey.artifactPlan` 中的待处置条目。
 *
 * 位于产品层 `scripts/lib/`，绝不放进随包复制给业务仓的 `kit/`。
 */
export function checkGovernancePrdCoverage(root, facts) {
  const prdDir = join(root, 'docs', 'prd')
  if (!existsSync(prdDir)) return { checked: false, prdFiles: [], missing: [] }

  const candidates = readdirSyncSafe(prdDir).filter((f) => f.endsWith('.md')).sort()
  const govPrds = []
  for (const name of candidates) {
    const rel = `docs/prd/${name}`
    const text = readTextSafe(join(root, rel)) ?? ''
    const fm = parseDocFrontmatter(text)
    if (isGovernancePrd(rel, fm, text)) govPrds.push({ rel, text })
  }
  if (govPrds.length === 0) return { checked: false, prdFiles: [], missing: [] }

  const requiredItems = (facts?.artifactPlan ?? []).filter(
    (item) => item && !['skip', 'preserve', 'optional'].includes(item.action),
  )
  const combinedCriteria = govPrds.map((p) => extractCriteriaLinesText(p.text)).join('\n')
  const missing = []
  for (const item of requiredItems) {
    const tokens = ARTIFACT_COVERAGE_TOKENS[item.id] ?? [item.id, item.artifact].filter(Boolean)
    const hit = tokens.some((tok) => combinedCriteria.includes(String(tok).toLowerCase()))
    if (!hit) missing.push({ id: item.id, artifact: item.artifact, action: item.action })
  }

  return {
    checked: true,
    prdFiles: govPrds.map((p) => p.rel),
    missing,
  }
}

export function collectSecretsSummary(facts) {
  const secretFiles = facts.risks?.secretFiles ?? []
  const secretContent = facts.risks?.secretContent ?? []
  const trackedFiles = secretFiles.filter((f) => f.status === 'tracked')
  const exposedFiles = secretFiles.filter((f) => f.status === 'exposed')
  const trackedContent = secretContent.filter((c) => c.status === 'tracked')
  const exposedContent = secretContent.filter((c) => c.status === 'exposed')
  const homePathLeaks = facts.risks?.homePathLeaks ?? []
  const leaks = homePathLeaks.filter((f) => f.category === 'leak' || f.category === undefined)
  return {
    trackedWhere: [...trackedFiles.map((f) => f.file), ...trackedContent.map((c) => `${c.file}:${c.line}（${c.kind}）`)],
    exposedWhere: [...exposedFiles.map((f) => f.file), ...exposedContent.map((c) => `${c.file}:${c.line}（${c.kind}）`)],
    leaks,
    benignCount: homePathLeaks.length - leaks.length,
    unverified: secretFiles.filter((f) => f.status === 'unverified-large'),
    largeFiles: facts.risks?.largeFiles ?? [],
  }
}

export function collectUnfilledReleaseNotes(root) {
  const notesDir = join(root, 'docs', 'release-notes')
  if (!existsSync(notesDir)) return []
  const empty = []
  for (const name of readdirSyncSafe(notesDir)) {
    if (!/\.md$/i.test(name)) continue
    const text = readTextSafe(join(notesDir, name)) ?? ''
    if (parseMarkers(text, name).some((m) => m.kind === 'fill')) empty.push(`docs/release-notes/${name}`)
  }
  return empty
}

export function collectStaleCommandsInfo(agentsText, facts) {
  if (!agentsText || !facts.commands || Object.keys(facts.commands).length === 0) return null
  const declared = Object.values(facts.commands).filter((v) => typeof v === 'string' && v.trim())
  const missing = declared.filter((cmd) => !agentsText.includes(cmd))
  if (missing.length === 0) return null
  return {
    missingCount: missing.length,
    shown: missing.slice(0, 3).map((cmd) => truncateCommandForDisplay(cmd, COMMAND_DISPLAY_MAX_BYTES).text),
    totalBytes: missing.reduce((sum, cmd) => sum + Buffer.byteLength(cmd, 'utf8'), 0),
  }
}

export function collectReleaseTagIssues(facts) {
  const version = facts.ecosystem?.declaredVersion
  const tags = facts.git?.tags ?? []
  const kinds = facts.ecosystem?.kinds ?? []
  const needsBareTag = kinds.some((k) => k === 'obsidian-plugin')
  const bareVTags = needsBareTag ? tags.filter((t) => /^v\d/.test(t)) : []
  const numeric = tags.map((t) => t.replace(/^v/, ''))
  const tagMismatch = Boolean(version && tags.length > 0 && !numeric.includes(version))
  const withV = tags.filter((t) => /^v/.test(t)).length
  const mixedTagShapes = Boolean(version && tags.length > 0 && withV > 0 && withV < tags.length)
  return { version, tags, bareVTags, tagMismatch, withV, mixedTagShapes }
}

export function collectMissingRemoteCapabilities(caps) {
  if (!caps || caps.known !== true) return []
  const missing = []
  if (caps.issues === false) missing.push('Issue')
  if (caps.pullRequests === false) missing.push('PR')
  if (caps.releases === false) missing.push('发布')
  if (caps.checks === false) missing.push('CI 检查状态')
  return missing
}

export function renderReviewReport(result, strict) {
  const lines = []
  lines.push(`交付体检：${result.target.name}（成熟度 ${result.maturity}）`)
  lines.push('')

  const order = ['git', 'secrets', 'agents', 'docs', 'artifacts', 'kit', 'license', 'ci', 'release', 'collaboration', 'ecosystem']
  const label = { missing: '缺', pending: '待定', notice: '可以更好', ok: '齐' }

  for (const scope of order) {
    const group = result.results.filter((r) => r.scope === scope)
    if (group.length === 0) continue
    lines.push(`【${scope}】`)
    for (const r of group) {
      lines.push(`  [${label[r.level]}] ${r.title}${renderRef(r.ref)}`)
    }
    lines.push('')
  }

  if (result.missing.length > 0) {
    lines.push(`结论：${result.missing.length} 处会出事，改完重跑。`)
  } else if (result.unscanned.length > 0) {
    // 空仓不能报圆满：构建、测试、TDD、CI 这几条判据的前提不存在，它们一条都没跑。
    // 把「没查」说成「没缺」，是这类结论里最难被发现的一种假绿。
    lines.push(`结论：这一轮有几条判据的前提不存在、根本没跑起来（${result.unscanned.join('、')}），`
      + `所以这一轮不构成「查过且没问题」的结论。先把 ${result.pending.length} 项待定回答掉，重跑。`)
  } else if (result.pending.length > 0) {
    lines.push(`结论：没有会出事的缺口，但有 ${result.pending.length} 项只有使用者能定。问完把答案写进 AGENTS.md 的「## 取舍」节，重跑即可。`)
  } else if (result.notice.length > 0) {
    lines.push(`结论：可以交付。（另有 ${result.notice.length} 项「可以更好」，不拦）`)
  } else {
    lines.push('结论：可以交付。')
  }

  if (result.pending.length > 0) {
    lines.push('')
    lines.push('要问的事：')
    for (const r of result.pending) {
      lines.push(`  - ${r.title}（表态写法：\`- \\\`${r.decision}\\\`：<你的选择>\` 写进 AGENTS.md 的「## 取舍」）`)
    }
  }

  return lines.join('\n')
}

export async function runReviewCli(argv, reviewFn) {
  const parsed = parseReviewCliArgs(argv, REVIEW_SCOPES)
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(`${reviewHelpText(REVIEW_SCOPES)}\n`)
    return 0
  }

  try {
    const result = await reviewFn(parsed.target, { scopes: parsed.scopes })
    if (parsed.asJson) {
      process.stdout.write(`${JSON.stringify({
        target: result.target,
        maturity: result.maturity,
        git: result.git,
        verdict: result.verdict,
        results: result.results,
      }, null, 2)}\n`)
    } else {
      process.stdout.write(`${renderReviewReport(result, parsed.strict)}\n`)
    }

    if (result.missing.length > 0) return 1
    if (parsed.strict && result.pending.length > 0) return 2
    return 0
  } catch (err) {
    process.stderr.write(`体检失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}
