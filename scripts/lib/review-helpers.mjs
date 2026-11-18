/**
 * review-helpers.mjs —— 交付体检的 CLI 参数解析、渲染辅助与治理 PRD 产物计划覆盖检查。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），由 scripts/review.mjs 调用。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import { readTextSafe } from './text.mjs'
import { parseDocFrontmatter } from '../../kit/skills/lib/doc-frontmatter.mjs'

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
  'kit-skills': ['kit-skills', '.agents/skills', '技能套件', 'equip'],
  'docs-tdd': ['docs-tdd', 'tdd.md', 'docs/tdd', '技术设计'],
  'agents-contract': ['agents-contract', 'agents.md', '工程契约', '项目契约', 'compose-agents'],
  readme: ['readme', 'readme.md'],
  contributing: ['contributing', 'contributing.md', '贡献指南'],
  license: ['license', '许可证', '授权'],
  releasing: ['releasing', 'releasing.md', '发版说明', '发布说明'],
  'ci-check': ['ci-check', 'check.yml', '检查流', '检查工作流', 'ci 检查'],
  'ci-release': ['ci-release', 'release.yml', '发布流', '发布工作流', '发版策略', '发布流水线'],
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
