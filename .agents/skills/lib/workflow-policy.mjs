/**
 * workflow-policy.mjs —— L3 纯策略判定、分层实证 evidence.json 校验、无 CI 低风险静态检查与状态路由核心。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），不依赖 dev-govern，确保 lightweight 档位完整可用。
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { checkMermaidLabelWidth } from './docs.mjs'
import { posixPath, readJsonSafe, readTextSafe, writeJsonAtomic } from './git.mjs'
import { sanitizeTaskId, nextReviewRound } from './ledger.mjs'
import { parseBodyRelations } from './platform.mjs'
import { isProfileExplicitNone } from './profile.mjs'
import { GATE_WORKFLOW_FILE_RE, LOCKFILE_NAMES, UI_VISUAL_EXT_RE, matchGlob } from './static-gates.mjs'

export const LOW_RISK_TEXT_EXT_RE = /\.(?:md|mdx|txt|rst)$/i
export const GATE_TIER_RANK = Object.freeze({ quick: 1, smoke: 2, full: 3, gate: 4 })

const EXTRA_CI_FILE_RE = /(?:^|\/)(?:\.travis\.ya?ml|\.drone\.ya?ml|\.buildkite\/pipeline\.ya?ml|\.woodpecker(?:\.ya?ml|\/[^/]+\.ya?ml))$/i
const MANIFEST_HIGH_BASENAMES = new Set([
  'package.json', 'pyproject.toml', 'cargo.toml', 'go.mod', 'go.work',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'composer.json', 'gemfile',
  'pubspec.yaml', 'mix.exs', 'package.swift', '.gitattributes', 'skill.md', 'license', 'releasing.md',
])
const LOW_RISK_EXCLUDED_EXACT = new Set([
  'agents.md', 'docs/tdd.md', 'architecture.md', 'releasing.md', 'skill.md', '.gitattributes', '.gitignore',
])
const SECRET_LITERALS = [
  { label: 'GitHub token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { label: 'GitHub fine-grained token', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'npm token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'PyPI token', re: /\bpypi-[A-Za-z0-9_-]{50,}\b/ },
  { label: 'AWS access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'API key sk-*', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { label: 'PEM private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,}/ },
]

function normRel(p) {
  return posixPath(String(p ?? '')).trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

/** 探测仓库是否配置了会在 PR/push 自动触发的 CI 检查工作流。 */
export function hasRepoCiWorkflow(repoRoot) {
  const wfDir = join(repoRoot, '.github', 'workflows')
  if (!existsSync(wfDir)) return false
  try {
    for (const name of readdirSync(wfDir)) {
      if (!/\.(?:yml|yaml)$/i.test(name)) continue
      const txt = (readTextSafe(join(wfDir, name)) ?? '').replace(/#[^\n]*/g, '').slice(0, 2000)
      if (!/\bon\s*:/i.test(txt)) continue
      if (/\bpull_request\b/i.test(txt)) return true
      if (/\bpush\b/i.test(txt) && !(/\btags\s*:/i.test(txt) && !/\bbranches\s*:/i.test(txt))) return true
    }
  } catch { /* ignore */ }
  return false
}

/** 根据风险档位与 Dev Profile 解析最高优先级非 `none` 验证层级。 */
export function resolveRequiredGates(riskTier, profile = null) {
  if (riskTier === 'low') return []
  if (!profile) return riskTier === 'high' ? ['gate'] : ['full']
  const hasCmd = (prop, key) => Boolean(profile[prop]) && !isProfileExplicitNone(profile, key)
  if (riskTier === 'high') {
    if (hasCmd('mergeGate', 'merge-gate')) return ['gate']
    if (hasCmd('fullTest', 'full-test')) return ['full']
    if (hasCmd('smokeVerify', 'smoke-verify')) return ['smoke']
    if (hasCmd('quickTest', 'quick-test')) return ['quick']
    return []
  }
  if (hasCmd('fullTest', 'full-test')) return ['full']
  if (hasCmd('smokeVerify', 'smoke-verify')) return ['smoke']
  if (hasCmd('quickTest', 'quick-test')) return ['quick']
  return []
}

function isLowRiskExcluded(rel, highRiskGlobs, doNotEditGlobs, ownArchivedSet) {
  const low = rel.toLowerCase()
  if (LOW_RISK_EXCLUDED_EXACT.has(low) || low.endsWith('/agents.md') || low.endsWith('/skill.md')) return true
  if (low.startsWith('.github/') || low.startsWith('.agents/')) return true
  if (highRiskGlobs.some((pat) => matchGlob(rel, pat))) return true
  if (!ownArchivedSet.has(rel) && doNotEditGlobs.some((pat) => matchGlob(rel, pat))) return true
  return false
}

function isOneWayBoundaryFile(rel) {
  const base = (rel.split('/').pop() ?? '').toLowerCase()
  if (GATE_WORKFLOW_FILE_RE.test(rel) || EXTRA_CI_FILE_RE.test(rel)) return true
  if (rel.startsWith('.husky/') || rel.startsWith('.githooks/') || rel.startsWith('.agents/skills/')) return true
  if (LOCKFILE_NAMES.has(base) || MANIFEST_HIGH_BASENAMES.has(base)) return true
  if (/(?:^|\/)(?:migrations?|migrate|schema|auth|rbac|acl|security|secrets?)(?:\/|\.)/i.test(rel) || /\.sql$/i.test(rel)) return true
  return false
}

/**
 * 计算三正交工作流策略：
 *   - `low`: 纯非可执行文本/文档白名单（排除关键契约/CI/high-risk/未豁免 do-not-edit，Case < 4，无门禁弱化与视觉变动）；
 *   - `high`: highRisk、门禁弱化、Case >= 4、视觉改动或 one-way 边界；
 *   - `medium`: 其余常规源码/测试变更与 Case 2/3。
 */
export function determineWorkflowPolicy({
  changedFiles = [],
  ownArchived = [],
  caseType = 3,
  highRiskGlobs = [],
  doNotEditGlobs = [],
  gateWeakeningHits = [],
  isDocsOnlyRepo = false,
  hasRemote = false,
  hasCiWorkflow = false,
  visualFilesChanged = [],
  diffBytes = 0,
  profile = null,
} = {}) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map(normRel).filter(Boolean))].sort()
  const ownSet = new Set([...(ownArchived ?? [])].map(normRel).filter(Boolean))
  const hrList = Array.isArray(highRiskGlobs) ? highRiskGlobs : []
  const dneList = Array.isArray(doNotEditGlobs) ? doNotEditGlobs : []
  const gwHits = Array.isArray(gateWeakeningHits) ? gateWeakeningHits : []
  const visualSet = new Set([
    ...(Array.isArray(visualFilesChanged) ? visualFilesChanged : []).map(normRel).filter(Boolean),
    ...files.filter((f) => UI_VISUAL_EXT_RE.test(f)),
  ])
  const effectiveVisual = [...visualSet].sort()

  const highRiskHits = files.filter((f) => hrList.some((pat) => matchGlob(f, pat)))
  const nonExemptDoNotEdit = files.filter((f) => !ownSet.has(f) && dneList.some((pat) => matchGlob(f, pat)))
  const oneWayBoundaryHits = files.filter((f) => isOneWayBoundaryFile(f))

  const reasons = []
  if (highRiskHits.length > 0) reasons.push(`命中 high-risk 路径 (${highRiskHits.slice(0, 3).join(', ')})`)
  if (gwHits.length > 0) reasons.push(`检测到门禁弱化 (${gwHits.length})`)
  if (Number(caseType) >= 4) reasons.push(`Case ${caseType} >= 4`)
  if (effectiveVisual.length > 0) reasons.push(`包含视觉/UI 文件 (${effectiveVisual.slice(0, 3).join(', ')})`)
  if (oneWayBoundaryHits.length > 0) reasons.push(`触及 one-way 边界 (${oneWayBoundaryHits.slice(0, 3).join(', ')})`)
  if (nonExemptDoNotEdit.length > 0) reasons.push(`触及 do-not-edit 路径 (${nonExemptDoNotEdit.slice(0, 3).join(', ')})`)

  const isHigh = reasons.length > 0
  const isLow = !isHigh
    && files.length > 0
    && Number(caseType) < 4
    && files.every((f) => LOW_RISK_TEXT_EXT_RE.test(f) && !isLowRiskExcluded(f, hrList, dneList, ownSet))

  const riskTier = isHigh ? 'high' : (isLow ? 'low' : 'medium')
  if (riskTier === 'low') reasons.push('全部变更命中纯非可执行文档白名单')
  else if (riskTier === 'medium') reasons.push(files.length === 0 && isDocsOnlyRepo ? '无文件 diff 的文档仓任务按标准校验处理' : '常规源码或非白名单变更')

  return {
    riskTier,
    issueRequired: riskTier === 'low' ? false : Boolean(hasRemote),
    independentReviewRequired: riskTier !== 'low',
    faultInjectionRequired: riskTier === 'high',
    requiredGates: resolveRequiredGates(riskTier, profile),
    staticDocCheckRequired: riskTier === 'low' && !hasCiWorkflow,
    reasons,
    highRiskHits,
    oneWayBoundaryHits,
    visualFilesChanged: effectiveVisual,
    diffBytes: Number(diffBytes) || 0,
  }
}

function decodeUriSafe(raw) {
  try { return decodeURIComponent(raw) } catch { return raw }
}

/**
 * 无远端 CI 的低风险改动独立静态必检（不引入 dev-govern）：
 * 检查改动文档中的 Markdown 相对死链（围栏感知）、Mermaid 16/12 标签与 HTML 禁止项、以及硬编码秘密与本机路径泄露。
 */
export function runLowRiskDocStaticCheck(repoRoot, changedFiles = []) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map(normRel).filter(Boolean))].sort()
  const checkedFiles = []
  const errors = []

  const homeRaw = homedir()
  const homeSlash = homeRaw.replace(/\\/g, '/')
  const homeRes = []
  for (const cand of new Set([homeRaw, homeSlash].filter((s) => s.length > 4))) {
    homeRes.push(new RegExp(cand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  }

  for (const rel of files) {
    if (!LOW_RISK_TEXT_EXT_RE.test(rel)) continue
    const abs = join(repoRoot, rel)
    if (!existsSync(abs)) continue
    const text = readTextSafe(abs)
    if (text === undefined) continue
    checkedFiles.push(rel)

    const lines = text.split('\n')
    const isMd = /\.(?:md|mdx)$/i.test(rel)
    if (isMd && !rel.startsWith('templates/')) {
      let fenceChar = ''
      let fenceLen = 0
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
          const targetAbs = decoded.startsWith('/') ? join(repoRoot, decoded.slice(1)) : resolve(dirname(abs), decoded)
          if (!existsSync(targetAbs)) {
            errors.push({ type: 'dead-link', file: rel, line: i + 1, target: clean, message: `${rel}:${i + 1} 存在失效相对链接 "${clean}"` })
          }
        }
      }
    }

    if (isMd && !rel.startsWith('templates/') && !rel.startsWith('docs/archive/') && /```+\s*mermaid/i.test(text)) {
      const mRes = checkMermaidLabelWidth(text)
      for (const v of mRes.violations) {
        errors.push({ type: 'mermaid', file: rel, line: v.line, message: `${rel}:${v.line} ${v.message}` })
      }
    }

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const pat of SECRET_LITERALS) {
        if (pat.re.test(line)) {
          errors.push({ type: 'secret-leak', file: rel, line: i + 1, message: `${rel}:${i + 1} 检测到疑似明文凭据 (${pat.label})` })
          break
        }
      }
      if (homeRes.some((re) => re.test(line))) {
        errors.push({ type: 'home-path-leak', file: rel, line: i + 1, message: `${rel}:${i + 1} 检测到本机用户目录绝对路径泄露` })
      }
    }
  }

  return { ok: errors.length === 0, checkedFiles, errors }
}

export function verificationEvidencePath(gitCommonDir, taskId) {
  return join(gitCommonDir, 'project-forge-flow', 'tasks', sanitizeTaskId(taskId), 'evidence.json')
}

export function readVerificationEvidence(gitCommonDir, taskId) {
  if (!gitCommonDir || !taskId) return null
  return readJsonSafe(verificationEvidencePath(gitCommonDir, taskId)) ?? null
}

export function writeVerificationEvidence(gitCommonDir, taskId, record) {
  const path = verificationEvidencePath(gitCommonDir, taskId)
  writeJsonAtomic(path, { ...record, updatedAt: new Date().toISOString() })
  return path
}

function configuredCmdForTier(profile, tierName) {
  if (!profile) return undefined
  const map = { quick: ['quickTest', 'quick-test'], smoke: ['smokeVerify', 'smoke-verify'], full: ['fullTest', 'full-test'], gate: ['mergeGate', 'merge-gate'] }
  const pair = map[tierName]
  if (!pair || isProfileExplicitNone(profile, pair[1])) return undefined
  return profile[pair[0]]
}

/**
 * 现场校验分层实证 evidence.json，堵死 `--tier quick --target` 与跳过必填门禁的旁路。
 */
export function validateVerificationEvidence({ policy, evidence, headSha, profile = null, explicitCmdUsed = false } = {}) {
  if (!evidence || typeof evidence !== 'object' || !evidence.gates || Object.keys(evidence.gates).length === 0) {
    return { ok: false, code: 'BLOCKED_NOT_VERIFIED', exitCode: 3, reason: '缺少当前任务的 verify 实证记录（evidence.json），请先运行 flow.mjs verify。' }
  }
  if (evidence.dirty === true || (headSha && evidence.headSha !== headSha)) {
    return {
      ok: false,
      code: 'BLOCKED_STALE_VERIFICATION',
      exitCode: 3,
      reason: `实证已过期（dirty=${Boolean(evidence.dirty)}, evidenceHead=${String(evidence.headSha ?? '').slice(0, 7)}, currentHead=${String(headSha ?? '').slice(0, 7)}），请提交并重跑 verify。`,
    }
  }

  if (policy?.staticDocCheckRequired) {
    const ds = evidence.gates?.docStatic
    if (!ds || ds.ok !== true || ds.exitCode !== 0 || ds.dirty === true || (headSha && ds.headSha !== headSha)) {
      const detail = ds?.errors?.length ? ds.errors.map((e) => e.message).slice(0, 3).join('；') : '尚未执行低风险文档静态门禁'
      return {
        ok: false,
        code: 'BLOCKED_STATIC_DOC_CHECK_FAILED',
        exitCode: 3,
        reason: `无 CI 仓库的低风险文档静态必检未通过：${detail}`,
      }
    }
  }

  if (policy?.riskTier === 'low') {
    if (evidence.exitCode !== 0) {
      return { ok: false, code: 'BLOCKED_NOT_VERIFIED', exitCode: 3, reason: '最新 verify 退出码非 0，请修复后重跑。' }
    }
    return { ok: true, code: null, exitCode: 0 }
  }

  const requiredGates = Array.isArray(policy?.requiredGates)
    ? policy.requiredGates
    : resolveRequiredGates(policy?.riskTier ?? 'medium', profile)

  const validGates = []
  for (const name of ['gate', 'full', 'smoke', 'quick']) {
    const g = evidence.gates?.[name]
    if (!g) continue
    if (headSha && g.headSha !== headSha) continue
    if (g.dirty === true || g.exitCode !== 0 || g.partial === true) continue
    const cfgCmd = configuredCmdForTier(profile, name)
    if (g.customCmd === true && cfgCmd && g.cmd !== cfgCmd) continue
    validGates.push({ name, rank: GATE_TIER_RANK[name] ?? 0, gate: g })
  }

  if (requiredGates.length > 0) {
    const requiredTier = requiredGates[0]
    const minRank = GATE_TIER_RANK[requiredTier] ?? 1
    if (!validGates.some((v) => v.rank >= minRank)) {
      const onlyPartial = Boolean(evidence.gates?.quick?.partial && (!headSha || evidence.gates.quick.headSha === headSha))
      return {
        ok: false,
        code: 'BLOCKED_INSUFFICIENT_VERIFICATION_TIER',
        exitCode: 3,
        requiredTier,
        reason: onlyPartial
          ? `仅有单文件快测（quick --target=${evidence.gates.quick.target}），不足以满足 ${policy?.riskTier} 风险所需的 ${requiredTier} 全量门禁。`
          : `${policy?.riskTier ?? 'medium'} 风险变更要求通过 ${requiredTier}（或更高级）门禁，当前仅通过 [${validGates.map((v) => v.name).join(', ') || 'none'}]。`,
      }
    }
    return { ok: true, code: null, exitCode: 0 }
  }

  if (validGates.length === 0) {
    const hasPartialOnly = Boolean(evidence.gates?.quick?.partial && (!headSha || evidence.gates.quick.headSha === headSha))
    if (hasPartialOnly) {
      return {
        ok: false,
        code: 'BLOCKED_INSUFFICIENT_VERIFICATION_TIER',
        exitCode: 3,
        reason: `仅有单文件快测（quick --target=${evidence.gates.quick.target}），请运行不带 --target 的全量 verify。`,
      }
    }
    if (!explicitCmdUsed && evidence.exitCode !== 0) {
      return { ok: false, code: 'BLOCKED_NOT_VERIFIED', exitCode: 3, reason: '当前 HEAD 未通过 verify 校验。' }
    }
    return {
      ok: false,
      code: 'BLOCKED_NOT_VERIFIED',
      exitCode: 3,
      reason: '当前 HEAD 缺少有效的全量 verify 通过记录。',
    }
  }
  return { ok: true, code: null, exitCode: 0 }
}

function replaceSectionBody(md, headingTitle, newBody) {
  const re = new RegExp(`(^##\\s+${headingTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$)([\\s\\S]*?)(?=\\n##\\s+|\\s*$)`, 'm')
  if (!re.test(md)) return `${md.trimEnd()}\n\n## ${headingTitle}\n\n${newBody}\n`
  return md.replace(re, `$1\n\n${newBody}\n`)
}

/** 读取 `.github/pull_request_template.md` 并注入任务上下文、`Fixes #N`、实证输出与 `pf-state`。 */
export function hydratePrTemplateBody({
  repoRoot,
  taskId,
  ledger,
  policy = null,
  actorDisplay = 'maintainer',
  visualFilesChanged = [],
  visualVerifiedOnHead = false,
  currentHead = '',
  changedFiles = [],
} = {}) {
  const shortHead = String(currentHead ?? '').slice(0, 7) || 'unknown'
  const fixesLine = (ledger?.linkedIssues ?? []).map((n) => `Fixes #${n}`).join('\n') || '无（独立变更任务）'
  const docLinks = [ledger?.specFile, ledger?.todoFile, ledger?.prdFile].filter(Boolean)
  const docSummary = docLinks.length > 0 ? docLinks.map((p) => `\`${p}\``).join('、') : `无（Case ${ledger?.caseType ?? 3}）`
  const pfTag = `<!-- pf-state:${JSON.stringify({ taskId, action: 'pr-body', branch: ledger?.branch ?? null, headSha: currentHead || null })} -->`

  const tplPath = repoRoot ? join(repoRoot, '.github', 'pull_request_template.md') : ''
  const tplRaw = tplPath && existsSync(tplPath) ? readTextSafe(tplPath) : null
  if (!tplRaw) {
    return [
      '## 改动说明',
      `- 任务编号：\`${taskId}\``,
      `- 提交人：${actorDisplay}`,
      `- 验证命令：\`${ledger?.verifiedCmd ?? 'verified'}\` @ \`${shortHead}\``,
      visualFilesChanged.length > 0
        ? `- 视觉与交互实证：${visualVerifiedOnHead ? `已核验（${ledger?.visualCheckEvidence ?? 'confirmed'}）` : `涉及 UI/视觉文件（${visualFilesChanged.slice(0, 5).join(', ')}），审查须核对实际渲染与浅深色截图`}`
        : null,
      `\n${fixesLine}`,
      '',
      '## 实现依据',
      `- role=${ledger?.role ?? 'unknown'}, case=${ledger?.caseType ?? 3}, risk=${policy?.riskTier ?? 'medium'}, isolation=${ledger?.isolation ?? 'worktree'}`,
      `- 关联文档：${docSummary}`,
      '',
      pfTag,
    ].filter((x) => x !== null).join('\n')
  }

  let body = tplRaw.replace(/\r\n/g, '\n')
  body = replaceSectionBody(body, '改了什么', `- \`${ledger?.caseType === 2 ? 'fix' : 'feat'}: ${ledger?.slug ?? taskId}\`（任务 \`${taskId}\`，提交人：${actorDisplay}，涉及 ${changedFiles.length} 个文件）`)
  body = replaceSectionBody(body, '关联 Issue', fixesLine)
  body = replaceSectionBody(body, '为什么', `- 完成任务 \`${taskId}\` 并同步对应工程文档。\n\n关联文档: ${docSummary}`)
  body = replaceSectionBody(body, '实现依据', `1. 分档：Case ${ledger?.caseType ?? 3}（risk=${policy?.riskTier ?? 'medium'}）\n2. 隔离：\`${ledger?.worktreePath ?? 'branch'}\` / 分支 \`${ledger?.branch ?? 'unknown'}\`\n3. 关联文档：${docSummary}`)
  const verifyText = [
    `- 命令：\`${ledger?.verifiedCmd ?? 'verified'}\`（mode=${ledger?.verifiedMode ?? 'quick'}，exit=${ledger?.lastVerifyExitCode ?? 0}，HEAD=\`${shortHead}\`）`,
    visualFilesChanged.length > 0
      ? `- 视觉核验：${visualVerifiedOnHead ? `已核验（${ledger?.visualCheckEvidence ?? 'confirmed'}）` : `涉及 ${visualFilesChanged.slice(0, 5).join(', ')}`}`
      : null,
  ].filter(Boolean).join('\n')
  body = replaceSectionBody(body, '怎么验证的', verifyText)
  body = replaceSectionBody(body, '回滚点', `- 回滚基线：\`${String(ledger?.baseSha ?? '').slice(0, 7) || ledger?.baseBranch || 'main'}\`（反向提交 \`git revert\` 并重跑门禁）`)
  body = replaceSectionBody(body, '风险与影响范围', `- 风险等级：\`${policy?.riskTier ?? 'medium'}\`${policy?.highRiskHits?.length ? `（命中高风险路径：${policy.highRiskHits.slice(0, 5).join(', ')}）` : ''}`)
  body = replaceSectionBody(body, '合并授权', policy?.independentReviewRequired === false ? '- 低风险纯文档改动：门禁绿灯可直接合入' : '- 独立审查 `fail` 为空且 CI 绿灯后由审查者合入（若含弱化门禁须人工确认）')
  body = replaceSectionBody(body, '独立审查与故障注入', policy?.independentReviewRequired === false
    ? '低风险纯非可执行文档改动，免除独立审查子代理（已完成本地静态文档门禁）。'
    : `- **审查来源**：待独立审查子代理接手\n- **逐条标准状态**：待 Round 1 核对（HEAD \`${shortHead}\`）\n- **故障注入记录**：待补充\n- **止损记录**：未触发`)
  return `${body.trimEnd()}\n\n${pfTag}\n`
}

/** 评估唯一活跃任务或集合状态并给出单一入口下一步路由与精简上下文。 */
export function evaluateNextState({
  activeTasks = [],
  selectedTask = null,
  taskRuntime = null,
} = {}) {
  if (!selectedTask) {
    if (activeTasks.length === 0) {
      return {
        taskId: null,
        phase: 'idle',
        ownerRole: 'coordinator',
        nextAction: '当前无活跃任务；请先运行 doc-plan.mjs triage 或 flow.mjs start --task <id> 启动任务。',
        command: 'node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --slug <slug>',
        blockingReasons: [],
        worktreePath: null,
        reviewWorktreePath: null,
        policy: null,
        coordinatorGuidance: { delegateImpl: false, delegateFreshReview: false, note: '无活跃任务，先规划或 start 新建隔离工作位。' },
        compactContext: null,
        candidates: [],
      }
    }
    return {
      taskId: null,
      phase: 'ambiguous',
      ownerRole: 'coordinator',
      nextAction: `检测到 ${activeTasks.length} 个未闭环任务，请显式传入 --task <id> 消歧。`,
      command: `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${activeTasks[0].taskId}`,
      blockingReasons: ['MULTIPLE_ACTIVE_TASKS'],
      worktreePath: null,
      reviewWorktreePath: null,
      policy: null,
      coordinatorGuidance: { delegateImpl: false, delegateFreshReview: false, note: '存在多条并发任务，需按 --task 指定单条任务。' },
      compactContext: null,
      candidates: activeTasks.map((t) => ({ taskId: t.taskId, status: t.status, branch: t.branch ?? null, worktreePath: t.worktreePath ?? null })),
    }
  }

  const t = selectedTask
  const rt = taskRuntime ?? {}
  const policy = rt.policy ?? null
  const rounds = Array.isArray(t.rounds) ? t.rounds : []
  const lastRound = rounds.length > 0 ? rounds[rounds.length - 1] : null
  const nextRound = nextReviewRound(t)
  const currentHead = rt.headSha ?? null
  const evidenceVal = rt.evidenceValidation ?? { ok: false, code: 'BLOCKED_NOT_VERIFIED' }
  const needsFinalize = t.caseType === 3 || t.caseType === 4 || Boolean(t.todoFile) || Boolean(t.specFile)
  // 「一件事都没做过」：基线 SHA 与当前 HEAD 相同、工作区干净。
  // 用它区分「还没开始」与「做完了待归档」——两者都满足「尚未 finalized」。
  const nothingImplementedYet = Boolean(
    !t.finalized && t.baseSha && currentHead && t.baseSha === currentHead && !(rt.dirty > 0),
  )
  const finalizeStale = Boolean(needsFinalize && (!t.finalized || (t.finalizedHead && currentHead && t.finalizedHead !== currentHead && rt.nonDocChangesAfterFinalize)))
  const stopLossActive = Boolean((t.lastReview?.stopLossTriggered || lastRound?.stopLossTriggered) && !t.humanApprovedStopLoss)
  const reviewCoversHead = Boolean(t.reviewPassed === true && (!currentHead || t.reviewPassedHead === currentHead) && (!lastRound || !currentHead || lastRound.headSha === currentHead))

  let phase
  let ownerRole = 'implementer'
  let nextAction
  let command
  const blockingReasons = []

  if (rt.opInProgress) {
    phase = 'blocked'
    ownerRole = 'implementer'
    blockingReasons.push('BLOCKED_GIT_CONFLICT_IN_PROGRESS')
    nextAction = `工作区处于 ${rt.opName ?? 'git'} 冲突状态，请先解决冲突`
    command = 'git status'
  } else if (t.role === 'clone-readonly') {
    phase = 'blocked'
    ownerRole = 'human'
    blockingReasons.push('ACTION_REQUIRED_CLONE_CHOICE')
    nextAction = '当前仓库为只读克隆，请确认 --clone-choice <fork|standalone|local>'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" start --task ${t.taskId} --clone-choice <fork|standalone|local>`
  } else if (t.status === 'released') {
    phase = 'released'
    ownerRole = 'coordinator'
    nextAction = '任务已被释放认领，请先重新 claim 后继续'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task ${t.taskId}`
  } else if (t.status === 'merged') {
    phase = 'needs-cleanup'
    ownerRole = 'coordinator'
    nextAction = '分支已合入，请向用户列清单确认后再执行 cleanup --confirm'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --task ${t.taskId} --confirm`
  } else if (t.role === 'inbound-external-pr') {
    ownerRole = 'reviewer'
    if (!reviewCoversHead) {
      phase = 'needs-review'
      nextAction = `对外部 PR #${t.prNumber ?? ''} 运行安全扫描与隔离审查`
      command = `node ".agents/skills/dev-review/scripts/review-pack.mjs" --pr ${t.prNumber} --untrusted-scan`
    } else {
      phase = 'ready-to-merge'
      nextAction = '外部 PR 独立审查已通过，按合并权限合并'
      command = `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${t.taskId}`
    }
  } else if (rt.dirty > 0) {
    phase = 'implementing'
    ownerRole = 'implementer'
    nextAction = '实施工作位存在未提交改动，完成后提交并继续 finalize/verify'
    command = `git -C "${t.worktreePath ?? '.'}" status`
  } else if ((t.issueContextUnavailable ?? []).length > 0) {
    phase = 'needs-issue-context'
    ownerRole = 'implementer'
    blockingReasons.push('ISSUE_CONTEXT_UNAVAILABLE')
    const nums = t.issueContextUnavailable.join('、')
    nextAction = `拿不到 Issue #${nums} 的正文，先取回来再动手：gh issue view <N> --repo <声明仓库>，`
      + '或显式说明「这一条凭现有信息无法澄清」并写进 Todo 的待拍板事项'
    command = `gh issue view ${t.issueContextUnavailable[0]} --json number,title,body`
  } else if (stopLossActive) {
    phase = 'stop-loss-escalated'
    ownerRole = 'human'
    blockingReasons.push('STOP_LOSS_ESCALATE')
    nextAction = '已触发停损熔断，须人类审阅后执行 override 解锁'
    command = `node ".agents/skills/dev-review/scripts/review-pack.mjs" override --task ${t.taskId} --human-approved --reason "<理由>"`
  } else if (t.status === 'rework' && t.queueConflict) {
    phase = 'needs-rework'
    ownerRole = 'implementer'
    blockingReasons.push(t.queueConflict.code || 'BLOCKED_TRIAL_MERGE_CONFLICT')
    nextAction = `合并队列试合失败（${t.queueConflict.code ?? 'conflict'}），请先同步基线（flow.mjs sync）解决冲突并重跑 verify`
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" sync --task ${t.taskId}`
  } else if (lastRound?.verdict === 'changes' && lastRound?.headSha && currentHead && lastRound.headSha === currentHead) {
    phase = 'needs-rework'
    ownerRole = 'implementer'
    blockingReasons.push('CHANGES_REQUESTED')
    nextAction = `Round ${lastRound.round} 已退回修改，请在 ${t.worktreePath ?? '原分支'} 修复并提交新 commit 后执行 verify + submit --rework`
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" rework --task ${t.taskId}`
  } else if (nothingImplementedYet) {
    // 还没提交过任何东西，下一步是实施，不是归档。
    // 少了这一支，对新任务来说「尚未 finalized」天然成立，刚建好就要求归档。
    phase = 'implementing'
    ownerRole = 'implementer'
    nextAction = '按交接包实施，改完提交；提交后按 flow next 继续'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" next --task ${t.taskId}`
  } else if (finalizeStale) {
    phase = 'needs-finalize'
    ownerRole = 'implementer'
    blockingReasons.push(!t.finalized ? 'BLOCKED_NOT_FINALIZED' : 'BLOCKED_STALE_FINALIZE')
    nextAction = '请先运行 finalize 完成验收勾选与文档成对归档'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" finalize --task ${t.taskId}`
  } else if (!evidenceVal.ok) {
    phase = 'needs-verify'
    ownerRole = 'implementer'
    if (evidenceVal.code) blockingReasons.push(evidenceVal.code)
    const recTier = policy?.requiredGates?.[0] ?? 'full'
    const modeFlag = policy?.riskTier === 'low' ? '' : ` --mode ${recTier}`
    nextAction = evidenceVal.reason ?? '请运行匹配的 verify 门禁锁定当前 HEAD'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" verify --task ${t.taskId}${modeFlag}`
  } else if (!['submitted', 'local-ready', 'awaiting-upstream-merge'].includes(t.status) || (t.lastSubmittedHead && currentHead && t.lastSubmittedHead !== currentHead)) {
    phase = 'needs-submit'
    ownerRole = 'implementer'
    const reworkFlag = rounds.length > 0 ? ' --rework' : ''
    nextAction = '实证已锁定当前 HEAD，由实施者执行 submit 推送并提 PR/同步审查工作位'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" submit --task ${t.taskId}${reworkFlag}`
  } else if (policy?.independentReviewRequired !== false && !reviewCoversHead) {
    phase = 'needs-review'
    ownerRole = 'reviewer'
    nextAction = `请新建独立审查子代理执行 Round ${nextRound} 审查（禁止复用旧上下文）`
    command = `node ".agents/skills/dev-review/scripts/review-pack.mjs" --task ${t.taskId} --round ${nextRound}`
  } else if (t.role === 'contributor-fork') {
    phase = 'awaiting-upstream-merge'
    ownerRole = 'human'
    nextAction = '等待上游维护者合并 PR，合并前严禁删除 Fork 分支'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" status --task ${t.taskId}`
  } else if (t.role === 'generic-git') {
    phase = 'awaiting-remote-mr'
    ownerRole = 'human'
    nextAction = '请先在远端托管完成 MR 合并，再带 --remote-merged 确认收尾'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${t.taskId} --remote-merged`
  } else {
    phase = 'ready-to-merge'
    ownerRole = 'reviewer'
    nextAction = '门禁与审查全部就绪，由审查者执行 merge 完成合并'
    command = `node ".agents/skills/dev-flow/scripts/flow.mjs" merge --task ${t.taskId}`
  }

  // 主工作区直接改文件：warning 不是 blocker。
  //
  // Case 2/3/4 的活该在 `.worktrees/impl-<id>/` 里干。主 Agent 若在自己的工作区直接 write，
  // 隔离位形同虚设，而「这次改动包含什么」也就说不清了——可这条此前没有任何东西看得见。
  //
  // 它是**警告不是拦截**：小改动（Case 1）本来就该在主工作区做，拦死会把正常路径也堵住。
  // 真正的硬拦留在 merge。所以它进 `warnings` 而不进 `blockingReasons`——两件事不能混。
  const warnings = []
  if ((rt.mainDirtyCount ?? 0) > 0 && t.worktreePath) {
    warnings.push({
      code: 'WARN_WORKING_IN_MAIN_CHECKOUT',
      message: `主工作区有 ${rt.mainDirtyCount} 处未提交改动，而这条任务的实施位是 ${t.worktreePath}`
        + '——Case 2/3/4 的活应该落在隔离位；小改动（Case 1）才在主工作区直接改。'
        + '不改也行，但「这次改动包含什么」会因此说不清。',
    })
  }

  return {
    taskId: t.taskId,
    phase,
    ownerRole,
    nextAction,
    command,
    blockingReasons,
    warnings,
    worktreePath: t.worktreePath ?? null,
    reviewWorktreePath: t.reviewWorktreePath ?? null,
    policy,
    coordinatorGuidance: {
      delegateImpl: t.caseType >= 2 && t.caseType <= 4 && ['implementing', 'needs-rework', 'needs-finalize', 'needs-verify', 'needs-submit'].includes(phase),
      delegateFreshReview: phase === 'needs-review',
      freshReviewRequiredForRound2Plus: nextRound >= 2,
      note: phase === 'needs-review' && nextRound >= 2
        ? 'Round 2+ 必须新建独立 review 子代理，并在增量视野硬锁下复审。'
        : (t.caseType >= 2 && t.caseType <= 4 ? 'Case 2/3/4 单任务在隔离 impl worktree 由 impl 子代理闭环实施、verify 与 submit 提 PR。' : '按 nextAction 推进。'),
    },
    compactContext: {
      taskId: t.taskId,
      caseType: t.caseType,
      role: t.role,
      branch: t.branch ?? null,
      baseBranch: t.baseBranch ?? 'main',
      headSha: currentHead,
      riskTier: policy?.riskTier ?? 'medium',
      requiredGates: policy?.requiredGates ?? [],
      round: rounds.length,
      lastVerdict: lastRound?.verdict ?? null,
      prNumber: t.prNumber ?? null,
    },
  }
}

/** 对多个 Issue 依正文提取出的 Depends on / Blocks 关系进行拓扑排序与策略建议。 */
export function analyzeIssueDependencies(issueItems = []) {
  const byNum = new Map()
  for (const it of issueItems) if (Number.isInteger(it?.number)) byNum.set(it.number, it)
  const nums = [...byNum.keys()]
  if (nums.length <= 1) {
    return { hasDependencies: false, orderedIssues: nums, edges: [], hasCycle: false, strategy: nums.length === 1 ? 'single-issue' : 'none' }
  }
  const adj = new Map(nums.map((n) => [n, new Set()]))
  const indeg = new Map(nums.map((n) => [n, 0]))
  const edges = []
  const addEdge = (from, to, kind) => {
    if (!byNum.has(from) || !byNum.has(to) || from === to || adj.get(from).has(to)) return
    adj.get(from).add(to)
    indeg.set(to, (indeg.get(to) ?? 0) + 1)
    edges.push({ from, to, kind })
  }
  for (const item of byNum.values()) {
    const rel = item.relations ?? parseBodyRelations(item.body ?? '')
    for (const dep of rel.dependsOn ?? []) addEdge(dep, item.number, 'depends-on')
    for (const blk of rel.blocks ?? []) addEdge(item.number, blk, 'blocks')
  }
  const queue = nums.filter((n) => indeg.get(n) === 0).sort((a, b) => a - b)
  const ordered = []
  while (queue.length > 0) {
    const cur = queue.shift()
    ordered.push(cur)
    for (const next of adj.get(cur)) {
      indeg.set(next, indeg.get(next) - 1)
      if (indeg.get(next) === 0) { queue.push(next); queue.sort((a, b) => a - b) }
    }
  }
  const hasCycle = ordered.length < nums.length
  if (hasCycle) for (const n of nums.sort((a, b) => a - b)) if (!ordered.includes(n)) ordered.push(n)
  const parents = new Set()
  for (const it of byNum.values()) for (const p of it.relations?.partOf ?? []) parents.add(p)
  return {
    hasDependencies: edges.length > 0, orderedIssues: ordered, edges, hasCycle,
    strategy: edges.length > 0 ? 'serial-order' : (parents.size === 1 ? 'same-branch-or-parallel' : 'parallel-or-combine'),
  }
}
