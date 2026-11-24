/**
 * workflow-policy.mjs —— L3 纯策略判定、分层实证 evidence.json 校验、无 CI 低风险静态检查与状态路由核心。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），不依赖 dev-govern，确保全模式稳定可用。
 */

import { EXIT } from './exit-codes.mjs'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import { checkMermaidLabelWidth } from './docs.mjs'
import { evaluateStoredVisualEvidence, precheckVisualAndArtifacts } from './empirical-artifacts.mjs'
import { validateE2eEvidenceText } from './feature-map.mjs'
import { posixPath, readJsonSafe, readTextSafe, unescapeGitPath, writeJsonAtomic } from './git.mjs'
import { sanitizeTaskId } from './ledger.mjs'
import { discoverWorkspacePackages, isProfileExplicitNone, resolveTierCommand } from './profile.mjs'
import { GATE_WORKFLOW_FILE_RE, CODE_EXT_RE, LOCKFILE_NAMES, TEST_FILE_RE, UI_VISUAL_EXT_RE, matchGlob } from './static-gates.mjs'
import {
  evaluateNextState,
  isEquivalentConcurrentCommand,
  normalizeConcurrentVerifyCommand,
  validateReviewRecordClosure,
} from './workflow-policy-next.mjs'
import {
  analyzeIssueDependencies,
  buildE2eDiagnosticPacket,
  buildE2eObservation,
  buildInspectNextSteps,
  buildMultiTaskWavePlan,
  buildSubmitNextSteps,
  buildVerificationEvidenceSection,
  hasValidE2eObservationOnHead,
  hydratePrTemplateBody,
  redactDiagnosticText,
  resolveEffectiveBaseSha,
  resolveReadablePrTitle,
  resolveReadablePrTitleWithSource,
  scanUnstartedReadySlices,
  scoreExecutionResult,
  validatePreMergeShaAndWorktree,
} from './workflow-helpers.mjs'

export {
  analyzeIssueDependencies,
  buildE2eDiagnosticPacket,
  buildE2eObservation,
  buildInspectNextSteps,
  buildMultiTaskWavePlan,
  buildSubmitNextSteps,
  buildVerificationEvidenceSection,
  evaluateNextState,
  hasValidE2eObservationOnHead,
  hydratePrTemplateBody,
  isEquivalentConcurrentCommand,
  normalizeConcurrentVerifyCommand,
  redactDiagnosticText,
  resolveEffectiveBaseSha,
  resolveReadablePrTitle,
  resolveReadablePrTitleWithSource,
  scanUnstartedReadySlices,
  scoreExecutionResult,
  validateE2eEvidenceText,
  validatePreMergeShaAndWorktree,
  validateReviewRecordClosure,
}

export const LOW_RISK_TEXT_EXT_RE = /\.(?:md|mdx|txt|rst)$/i
export const GATE_TIER_RANK = Object.freeze({ quick: 1, smoke: 2, full: 3, gate: 4 })

export const EXTRA_CI_FILE_RE = /(?:^|\/)(?:\.travis\.ya?ml|\.drone\.ya?ml|\.buildkite\/pipeline\.ya?ml|\.woodpecker(?:\.ya?ml|\/[^/]+\.ya?ml))$/i
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

/** 探测仓库是否配置了会在提案或推默认分支时自动触发的检查工作流（读触发键，不认文件名）。 */
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
  } catch { /* 读不到就当没有 */ }
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
  hasDevReview = true,
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

  const independentReviewRequired = hasDevReview ? (riskTier !== 'low') : false
  const humanApprovalRequired = !hasDevReview && riskTier === 'high'
  const runtimeFilesTouched = files.filter((f) => CODE_EXT_RE.test(f) && !TEST_FILE_RE.test(f))
  const smokeExplicitNone = isProfileExplicitNone(profile, 'smoke-verify')
  const smokeConfigured = Boolean(profile?.smokeVerify) && !smokeExplicitNone
  const smokeRequired = runtimeFilesTouched.length > 0 && riskTier !== 'low' && !smokeExplicitNone

  return {
    riskTier,
    issueRequired: riskTier === 'low' ? false : Boolean(hasRemote),
    independentReviewRequired,
    humanApprovalRequired,
    faultInjectionRequired: riskTier === 'high',
    requiredGates: resolveRequiredGates(riskTier, profile),
    staticDocCheckRequired: riskTier === 'low' && !hasCiWorkflow,
    runtimeFilesTouched,
    smokeRequired,
    smokeConfigured,
    smokeExplicitNone,
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
 * 解析 unified diff 中各文件的新增/修改行号集合（1-based）：
 * 返回 Map<relPath, Set<number> | null>；`null` 表示新建全文件（`--- /dev/null`），`diffText` 非字符串时返回 `null`。
 */
export function parseUnifiedDiffChangedLines(diffText) {
  if (typeof diffText !== 'string') return null
  const lines = diffText.replace(/\r\n/g, '\n').split('\n')
  const map = new Map()
  let currentFile = null
  let isNewFile = false
  let inHunk = false
  let newLine = 0
  let hunkCount = 0
  let hunkStart = 0
  let sawHunkBody = false

  const finalizeHunk = () => {
    if (inHunk && currentFile && !isNewFile && !sawHunkBody && hunkCount > 0) {
      const set = map.get(currentFile)
      if (set instanceof Set) {
        for (let k = 0; k < hunkCount; k += 1) set.add(hunkStart + k)
      }
    }
    inHunk = false
  }

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finalizeHunk()
      const m = /^diff --git (?:"a\/([^"]+)"|a\/(.+?)) (?:"b\/([^"]+)"|b\/(.+))$/.exec(line)
      const rawB = m ? (m[3] !== undefined ? `"${m[3]}"` : m[4]) : null
      currentFile = rawB ? normRel(unescapeGitPath(rawB)) : null
      isNewFile = false
      if (currentFile && !map.has(currentFile)) map.set(currentFile, new Set())
      continue
    }
    if (line.startsWith('--- ')) {
      finalizeHunk()
      isNewFile = line.slice(4).trim() === '/dev/null'
      continue
    }
    if (line.startsWith('+++ ')) {
      finalizeHunk()
      const target = line.slice(4).split('\t')[0].trim()
      if (target === '/dev/null') {
        currentFile = null
        continue
      }
      const nextFile = target.startsWith('b/')
        ? normRel(unescapeGitPath(target.slice(2)))
        : (target.startsWith('"b/') ? normRel(unescapeGitPath(`"${target.slice(3)}`)) : normRel(unescapeGitPath(target)))
      currentFile = nextFile || null
      if (currentFile) {
        if (isNewFile) map.set(currentFile, null)
        else if (!map.has(currentFile)) map.set(currentFile, new Set())
      }
      continue
    }
    if (line.startsWith('@@')) {
      finalizeHunk()
      const hm = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (hm) {
        inHunk = true
        hunkStart = Number(hm[1])
        hunkCount = hm[2] !== undefined ? Number(hm[2]) : 1
        newLine = hunkStart
        sawHunkBody = false
      }
      continue
    }
    if (!inHunk || !currentFile || line.startsWith('\\')) continue
    sawHunkBody = true
    const set = map.get(currentFile)
    if (line.startsWith('+')) {
      if (set instanceof Set) set.add(newLine)
      newLine += 1
    } else if (!line.startsWith('-')) {
      newLine += 1
    }
  }
  finalizeHunk()
  return map
}

/**
 * 无远端 CI 的低风险改动独立静态必检（不引入 dev-govern）：
 * 检查改动文档中的 Markdown 相对死链（围栏感知）、Mermaid 16/12 标签与 HTML 禁止项、以及硬编码秘密与本机路径泄露。
 * 传入 `{ diffText }` 时，对存在 diff hunks 的既有修改文件仅检查其新增/修改行；新建或未在 diffText 中的文件保持全文件检查。
 */
export function runLowRiskDocStaticCheck(repoRoot, changedFiles = [], options = {}) {
  const files = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map(normRel).filter(Boolean))].sort()
  const changedLinesByFile = parseUnifiedDiffChangedLines(options?.diffText ?? null)
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

    const diffLineEntry = changedLinesByFile?.get(rel)
    const changedLineSet = diffLineEntry instanceof Set ? diffLineEntry : null
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
        if (changedLineSet && !changedLineSet.has(i + 1)) continue

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
        if (changedLineSet && !changedLineSet.has(v.line)) continue
        errors.push({ type: 'mermaid', file: rel, line: v.line, message: `${rel}:${v.line} ${v.message}` })
      }
    }

    for (let i = 0; i < lines.length; i += 1) {
      if (changedLineSet && !changedLineSet.has(i + 1)) continue
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

/** `flow verify` 前置实证预检：校验附件与界面核验结论，通过后把元数据并入 `evidence.json`（只写仓外状态，不碰被跟踪文件）。 */
export function validateVerifyPrecheck({ repoRoot = null, gitCommonDir = null, taskId = null, headSha = null, policy = null, record = true, ...rest } = {}) {
  const evidencePath = record && gitCommonDir && taskId ? verificationEvidencePath(gitCommonDir, taskId) : null
  return precheckVisualAndArtifacts({
    ...rest, repoRoot, evidencePath, headSha,
    visualFilesChanged: rest.visualFilesChanged ?? policy?.visualFilesChanged ?? [],
  })
}

function configuredCmdForTier(profile, tierName) {
  return resolveTierCommand(profile, tierName)
}

/**
 * 现场校验分层实证 evidence.json，堵死 `--tier quick --target` 与跳过必填门禁的旁路。
 * 界面资源的实证底线同时守一道：只留下布尔开关自证的不算放行（判据归 `empirical-artifacts.mjs`）。
 */
export function validateVerificationEvidence({ policy, evidence, headSha, profile = null, explicitCmdUsed = false } = {}) {
  if (!evidence || typeof evidence !== 'object' || !evidence.gates || Object.keys(evidence.gates).length === 0) {
    return { ok: false, code: 'BLOCKED_NOT_VERIFIED', exitCode: EXIT.FACT, reason: '缺少当前任务的 verify 实证记录（evidence.json），请先运行 flow.mjs verify。' }
  }
  const vis = evaluateStoredVisualEvidence({ evidence, policy, headSha })
  if (!vis.ok) return { ok: false, code: vis.code, exitCode: EXIT.FACT, uiFiles: vis.uiFiles, reason: vis.reason }
  if (evidence.dirty === true || (headSha && evidence.headSha !== headSha)) {
    return {
      ok: false,
      code: 'BLOCKED_STALE_VERIFICATION',
      exitCode: EXIT.FACT,
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
        exitCode: EXIT.FACT,
        reason: `无 CI 仓库的低风险文档静态必检未通过：${detail}`,
      }
    }
  }

  if (policy?.riskTier === 'low') {
    if (evidence.exitCode !== 0) {
      return { ok: false, code: 'BLOCKED_NOT_VERIFIED', exitCode: EXIT.FACT, reason: '最新 verify 退出码非 0，请修复后重跑。' }
    }
    return { ok: true, code: null, exitCode: EXIT.OK }
  }

  const requiredGates = Array.isArray(policy?.requiredGates)
    ? policy.requiredGates
    : resolveRequiredGates(policy?.riskTier ?? 'medium', profile)

  const validGates = []
  const rejectedCustomGates = []
  for (const name of ['gate', 'full', 'smoke', 'quick']) {
    const g = evidence.gates?.[name]
    if (!g) continue
    if (headSha && g.headSha !== headSha) continue
    if (g.dirty === true || g.exitCode !== 0 || g.partial === true) continue
    if (g.status !== 'skipped-explicit-none' && (g.errorOnly === true || g.executed === false || g.succeeded === false)) continue
    const cfgCmd = configuredCmdForTier(profile, name)
    if (g.customCmd === true && cfgCmd && !isEquivalentConcurrentCommand(g.cmd, cfgCmd)) {
      rejectedCustomGates.push({ name, cmd: g.cmd, configuredCmd: cfgCmd })
      continue
    }
    validGates.push({ name, rank: GATE_TIER_RANK[name] ?? 0, gate: g })
  }
  const formatRejectedReason = (rej) => `已运行自定义 --cmd（"${rej.cmd}"），但与配置的 ${rej.name} 命令（"${rej.configuredCmd}"）不一致而被拒收（仅允许等价命令或追加并发标志）。`

  if (policy?.smokeRequired && policy?.riskTier !== 'low' && !isProfileExplicitNone(profile, 'smoke-verify')) {
    const hasSmokeGate = validGates.some((v) => v.name === 'smoke') && evidence.smokeVerifiedOnHead !== false
    if (!hasSmokeGate) {
      const noCfg = !profile?.smokeVerify
      const rejSmoke = rejectedCustomGates.find((r) => r.name === 'smoke')
      return {
        ok: false,
        code: 'BLOCKED_INSUFFICIENT_VERIFICATION_TIER',
        exitCode: EXIT.FACT,
        requiredTier: 'smoke',
        ...(rejectedCustomGates.length > 0 ? { rejectedCustomGates } : {}),
        reason: rejSmoke
          ? formatRejectedReason(rejSmoke)
          : (noCfg
              ? '运行时代码改动且 Dev Profile 未配置真实 smoke-verify 命令也未显式写 smoke-verify: none：请在 AGENTS.md 补齐 smoke-verify，或运行 verify --mode smoke --cmd "<端到端命令>" --e2e-evidence "<运行观察>"。'
              : `运行时代码改动禁止仅用 full/gate（单测）顶替 smoke-verify，当前 HEAD 缺少 smoke 执行实证（已通过 [${validGates.map((v) => v.name).join(', ') || 'none'}]）。`),
      }
    }
    const rawObsSummary = evidence.e2eObservation?.summary ?? ''
    if (evidence.e2eObservation?.shallowRejected || (rawObsSummary && !validateE2eEvidenceText(rawObsSummary).ok)) {
      const check = validateE2eEvidenceText(rawObsSummary)
      return {
        ok: false,
        code: 'BLOCKED_SHALLOW_E2E_EVIDENCE',
        exitCode: EXIT.FACT,
        requiredTier: 'smoke',
        reason: check.reason ?? 'E2E 观察回执仅为无实质水话，请写明执行入口与观察到的真实输出/状态。',
      }
    }
    const hasE2eObs = hasValidE2eObservationOnHead(evidence, headSha)
      || Boolean(evidence.visualCheckEvidence && (!headSha || evidence.visualVerifiedHead === headSha))
    if (!hasE2eObs) {
      return {
        ok: false,
        code: 'BLOCKED_E2E_OBSERVATION_REQUIRED',
        exitCode: EXIT.FACT,
        requiredTier: 'smoke',
        reason: '已完成 smoke 命令执行，但缺少当前 HEAD 的结构化 E2E 运行观察回执（e2eObservation），请核验真实输出/状态后传 --e2e-evidence "<观察实证>"。',
      }
    }
  }

  if (requiredGates.length > 0) {
    const requiredTier = requiredGates[0]
    const minRank = GATE_TIER_RANK[requiredTier] ?? 1
    if (!validGates.some((v) => v.rank >= minRank)) {
      const onlyPartial = Boolean(evidence.gates?.quick?.partial && (!headSha || evidence.gates.quick.headSha === headSha))
      const rejTier = rejectedCustomGates.find((r) => r.name === requiredTier || (GATE_TIER_RANK[r.name] ?? 0) >= minRank) ?? rejectedCustomGates[0]
      return {
        ok: false,
        code: 'BLOCKED_INSUFFICIENT_VERIFICATION_TIER',
        exitCode: EXIT.FACT,
        requiredTier,
        ...(rejectedCustomGates.length > 0 ? { rejectedCustomGates } : {}),
        reason: rejTier
          ? `${formatRejectedReason(rejTier)}（当前已通过 [${validGates.map((v) => v.name).join(', ') || 'none'}]）`
          : (onlyPartial
              ? `仅有单文件快测（quick --target=${evidence.gates.quick.target}），不足以满足 ${policy?.riskTier} 风险所需的 ${requiredTier} 全量门禁。`
              : `${policy?.riskTier ?? 'medium'} 风险变更要求通过 ${requiredTier}（或更高级）门禁，当前仅通过 [${validGates.map((v) => v.name).join(', ') || 'none'}]。`),
      }
    }
    return { ok: true, code: null, exitCode: EXIT.OK }
  }

  if (validGates.length === 0) {
    const hasPartialOnly = Boolean(evidence.gates?.quick?.partial && (!headSha || evidence.gates.quick.headSha === headSha))
    if (hasPartialOnly) {
      return {
        ok: false,
        code: 'BLOCKED_INSUFFICIENT_VERIFICATION_TIER',
        exitCode: EXIT.FACT,
        reason: `仅有单文件快测（quick --target=${evidence.gates.quick.target}），请运行不带 --target 的全量 verify。`,
      }
    }
    if (rejectedCustomGates.length > 0) {
      return {
        ok: false,
        code: 'BLOCKED_INSUFFICIENT_VERIFICATION_TIER',
        exitCode: EXIT.FACT,
        rejectedCustomGates,
        reason: formatRejectedReason(rejectedCustomGates[0]),
      }
    }
    if (!explicitCmdUsed && evidence.exitCode !== 0) {
      return { ok: false, code: 'BLOCKED_NOT_VERIFIED', exitCode: EXIT.FACT, reason: '当前 HEAD 未通过 verify 校验。' }
    }
    return {
      ok: false,
      code: 'BLOCKED_NOT_VERIFIED',
      exitCode: EXIT.FACT,
      reason: '当前 HEAD 缺少有效的全量 verify 通过记录。',
    }
  }
  return { ok: true, code: null, exitCode: EXIT.OK }
}

const PURE_DOC_ASSET_RE = /^(?:docs\/|README|CHANGELOG|LICENSE|\.gitignore)|\.(?:md|mdx|txt|png|jpg|jpeg|svg|webp)$/i

function inferFileStack(relFile) {
  const f = posixPath(String(relFile ?? '')).replace(/^\.\//, '')
  const low = f.toLowerCase()
  const base = basename(low)
  if (!f || PURE_DOC_ASSET_RE.test(f)) return 'doc'
  if (/\.(?:mjs|cjs|js|jsx|ts|tsx|mts|cts|vue|svelte|astro)$/.test(low)
    || /^(?:package(?:-lock)?\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|bun\.lockb?|tsconfig(?:\.[^.]+)?\.json|vite\.config\.[^/]+|vitest\.config\.[^/]+)$/.test(base)) {
    return 'node'
  }
  if (/\.(?:py|pyi|pyx)$/.test(low) || /^(?:pyproject\.toml|setup\.py|setup\.cfg|pipfile|uv\.lock|poetry\.lock)$/.test(base) || /^requirements.*\.txt$/.test(base)) {
    return 'python'
  }
  if (/\.rs$/.test(low) || base === 'cargo.toml' || base === 'cargo.lock') return 'rust'
  if (/\.go$/.test(low) || base === 'go.mod' || base === 'go.sum' || base === 'go.work') return 'go'
  if (/\.(?:java|kt|kts|groovy|scala)$/.test(low) || base === 'pom.xml' || /^build\.gradle(?:\.kts)?$/.test(base)) return 'java'
  if (/\.rb$/.test(low) || base === 'gemfile' || base === 'rakefile') return 'ruby'
  if (/\.(?:cs|fs|vb)$/.test(low) || /\.(?:csproj|fsproj|sln)$/.test(base)) return 'dotnet'
  if (/\.php$/.test(low) || base === 'composer.json' || base === 'composer.lock') return 'php'
  if (/\.dart$/.test(low) || base === 'pubspec.yaml') return 'dart'
  if (/\.swift$/.test(low) || base === 'package.swift') return 'swift'
  if (/\.(?:ex|exs)$/.test(low) || base === 'mix.exs') return 'elixir'
  if (/\.(?:c|cc|cpp|cxx|h|hpp)$/.test(low) || base === 'cmakelists.txt') return 'cpp'
  return 'shared'
}

export function inferCommandStack(cmd) {
  const s = String(cmd ?? '').trim()
  if (!s) return null
  if (/\b(?:pnpm|npm|yarn|bun|npx|node|vitest|jest|mocha|eslint|oxlint|tsc|vite)\b/i.test(s)) return 'node'
  if (/\b(?:pytest|python3?|pip3?|uv|poetry|ruff|mypy|flake8|unittest)\b/i.test(s)) return 'python'
  if (/\b(?:cargo|rustc|clippy|rustfmt)\b/i.test(s)) return 'rust'
  if (/\b(?:go\s+(?:test|build|vet|run|mod)|golangci-lint)\b/i.test(s)) return 'go'
  if (/\b(?:mvn|mvnw|gradle|gradlew|javac|java)\b/i.test(s)) return 'java'
  if (/\b(?:bundle|rake|rspec|rubocop|ruby)\b/i.test(s)) return 'ruby'
  if (/\bdotnet\b/i.test(s)) return 'dotnet'
  if (/\b(?:composer|phpunit|php)\b/i.test(s)) return 'php'
  if (/\b(?:dart|flutter)\b/i.test(s)) return 'dart'
  if (/\bswift\b/i.test(s)) return 'swift'
  if (/\bmix\b/i.test(s)) return 'elixir'
  if (/\b(?:cmake|ctest|meson|ninja|clang|gcc|g\+\+)\b/i.test(s)) return 'cpp'
  return null
}

function mapEcosystemToStack(eco) {
  const e = String(eco ?? '').toLowerCase()
  if (e === 'node' || e === 'deno' || e === 'js' || e === 'ts') return 'node'
  if (e === 'python' || e === 'rust' || e === 'go' || e === 'java' || e === 'ruby'
    || e === 'dotnet' || e === 'php' || e === 'dart' || e === 'swift' || e === 'elixir' || e === 'cpp') {
    return e
  }
  return null
}

/**
 * 多语言 / 多子包仓库单栈局部变更验证作用域分析：
 * 当变更文件全部落在单一语言栈（且无跨栈/构建/CI 共享文件改动）时，返回受波及栈与包集合，
 * 过滤掉未改动语言栈的验证命令，避免局部前端改动因缺失未改栈运行时（如 `go`/`cargo`）而误阻塞。
 */
export function resolveScopedVerificationGate({ repoRoot = null, changedFiles = [], packages = null, profile = null } = {}) {
  const normFiles = [...new Set((Array.isArray(changedFiles) ? changedFiles : []).map((f) => posixPath(String(f ?? '')).replace(/^\.\//, '')).filter(Boolean))]
  const rawPkgs = Array.isArray(packages)
    ? packages
    : (repoRoot ? (discoverWorkspacePackages(repoRoot)?.packages ?? []) : [])
  const runtimeStacks = new Set()
  let hasCrossStackSharedTrigger = false

  for (const f of normFiles) {
    const st = inferFileStack(f)
    if (st === 'doc') continue
    if (st === 'shared') { hasCrossStackSharedTrigger = true; continue }
    runtimeStacks.add(st)
  }

  const affectedPackages = []
  for (const f of normFiles) {
    if (inferFileStack(f) === 'doc') continue
    const matches = rawPkgs
      .filter((p) => {
        const dir = posixPath(String(p?.dir ?? '')).replace(/^\.\//, '').replace(/\/+$/, '')
        return !dir || f.startsWith(`${dir}/`) || f === dir
      })
      .sort((a, b) => String(b?.dir ?? '').length - String(a?.dir ?? '').length)
    const hit = matches[0]
    if (hit) {
      const dir = posixPath(String(hit.dir ?? '')).replace(/^\.\//, '').replace(/\/+$/, '')
      if (!affectedPackages.some((x) => x.dir === dir && x.ecosystem === hit.ecosystem)) {
        affectedPackages.push({ dir, name: hit.name ?? (dir || 'root'), ecosystem: hit.ecosystem ?? null })
      }
    }
  }

  const repoStacks = new Set()
  for (const p of rawPkgs) {
    const st = mapEcosystemToStack(p?.ecosystem)
    if (st) repoStacks.add(st)
  }
  if (profile && typeof profile === 'object') {
    for (const key of ['quick-test', 'smoke-verify', 'full-test', 'merge-gate']) {
      for (const raw of profile[key] ?? []) {
        for (const seg of String(raw ?? '').split(/\s*&&\s*/)) {
          const cs = inferCommandStack(seg)
          if (cs) repoStacks.add(cs)
        }
      }
    }
  }

  const singleStackScoped = !hasCrossStackSharedTrigger && runtimeStacks.size === 1 && (repoStacks.size > 1 || (rawPkgs.length > 1 && affectedPackages.length > 0 && affectedPackages.length < rawPkgs.length))
  const affectedStacks = [...runtimeStacks]
  const affectedPkgDirs = new Set(affectedPackages.map((p) => p.dir).filter(Boolean))

  const filterCommands = (commands = []) => {
    const kept = []
    const skipped = []
    if (!singleStackScoped) {
      return { kept: [...commands], skipped }
    }
    for (const rawCmd of commands) {
      const clean = String(rawCmd ?? '').trim()
      if (!clean) continue
      const segments = clean.includes('&&') ? clean.split(/\s*&&\s*/).map((s) => s.trim()).filter(Boolean) : [clean]
      const segKept = []
      let anySkipped = false
      for (const seg of segments) {
        const cs = inferCommandStack(seg)
        if (cs && !runtimeStacks.has(cs)) {
          skipped.push({ cmd: seg, stack: cs, reason: `unaffected-stack:${cs}` })
          anySkipped = true
          continue
        }
        if (affectedPkgDirs.size > 0 && rawPkgs.length > 1) {
          const subDirHint = /(?:--filter\s+['"]?([^\s'"]+)|--prefix\s+['"]?([^\s'"]+)|-C\s+['"]?([^\s'"]+)|\bcd\s+([^\s&;]+))/.exec(seg)
          const hinted = (subDirHint?.[1] || subDirHint?.[2] || subDirHint?.[3] || subDirHint?.[4] || '').replace(/^\.\//, '').replace(/\/+$/, '')
          const matchesPkg = !hinted || affectedPackages.some((p) => p.dir === hinted || p.name === hinted || p.dir.endsWith(`/${hinted}`))
          if (!matchesPkg) {
            skipped.push({ cmd: seg, stack: cs ?? affectedStacks[0], reason: `unaffected-package:${hinted}` })
            anySkipped = true
            continue
          }
        }
        segKept.push(seg)
      }
      if (segKept.length > 0) {
        kept.push(anySkipped ? segKept.join(' && ') : clean)
      }
    }
    return { kept, skipped }
  }

  return {
    scoped: singleStackScoped,
    affectedStacks,
    repoStacks: [...repoStacks],
    affectedPackages,
    hasCrossStackSharedTrigger,
    filterCommands,
  }
}
