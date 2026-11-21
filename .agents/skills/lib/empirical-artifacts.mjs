/**
 * empirical-artifacts.mjs —— 工具无关结构化实证附件校验、UI 变更防敷衍判定与 PR 实证清单排版。
 *
 * 判据只有一条：**附件必须是真实存在的非空常规文件**，观察必须是真的写下来的运行/渲染结果。
 * 用什么工具产出附件、在哪个环境渲染，本模块一概不感知——它只看客观产物。
 * 记录落在仓外状态目录（`evidence.json` 与审查回执），不碰任何 Git 跟踪文件。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { EXIT } from './exit-codes.mjs'
import { statSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve } from 'node:path'

import { posixPath, readJsonSafe, sha256File, writeJsonAtomic } from './git.mjs'
import { evaluateTextSubstance } from './evidence-substance.mjs'

/** 单个附件体积上限：超过它就不再是「实证产物」，而是留下来的临时大二进制。 */
export const ARTIFACT_MAX_BYTES = 50 * 1024 * 1024

/**
 * 旧式合成观察串：由布尔开关直接拼出来的「已核验」，里面没有观察内容。
 * 它们能被当成实证，正是本条判据要堵的敷衍通道。
 */
export const SYNTHETIC_OBSERVATION_TEXTS = Object.freeze([
  'e2e/visual runtime behavior observed and verified',
  '实际运行、端到端交互与输出观察核验已确认',
  '独立审查已核验真实端到端运行、交互与输出观察',
])

function normRel(p) {
  return posixPath(String(p ?? '')).trim().replace(/^\.\//, '').replace(/^\/+/, '')
}

/** 把 CLI 的 `--artifact`（单值、多值或逗号分隔）统一成路径数组。 */
export function artifactPathsOf(opts = {}) {
  const raw = []
  for (const key of ['artifact', 'artifacts']) {
    const val = opts?.[key]
    if (Array.isArray(val)) raw.push(...val)
    else if (typeof val === 'string') raw.push(val)
  }
  return raw.flatMap((s) => String(s ?? '').split(',')).map((s) => s.trim()).filter(Boolean)
}

/** 把用户声明的附件路径解析为仓库内相对路径；仓库外附件保留绝对路径并标记 external。 */
function resolveArtifactRel(repoRoot, rawPath) {
  const raw = String(rawPath ?? '').trim()
  if (!raw) return null
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(repoRoot ?? process.cwd(), raw)
  if (!repoRoot) return { relPath: posixPath(abs), abs, external: true }
  const rel = relative(resolve(repoRoot), abs)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { relPath: posixPath(abs), abs, external: true }
  return { relPath: posixPath(rel), abs, external: false }
}

/**
 * 校验并登记单个附件：必须真实存在、是常规文件、字节数大于 0。
 * 目录、空文件、不存在三者各自给出可执行的修正提示，绝不退化成「跳过」。
 */
export function resolveArtifactRecord(repoRoot, rawPath, capturedAt = new Date().toISOString()) {
  const located = resolveArtifactRel(repoRoot, rawPath)
  if (!located) {
    return { ok: false, code: 'BLOCKED_ARTIFACT_INVALID', reason: '--artifact 传入了空路径，请给出实证附件的真实路径。' }
  }
  let st
  try {
    st = statSync(located.abs)
  } catch {
    return {
      ok: false,
      code: 'BLOCKED_ARTIFACT_MISSING',
      reason: `实证附件不存在：${located.relPath}；请传真实产出的附件路径，不要把尚未生成的文件写进 --artifact。`,
    }
  }
  if (st.isDirectory()) {
    return {
      ok: false,
      code: 'BLOCKED_ARTIFACT_IS_DIRECTORY',
      reason: `实证附件是目录而非文件：${located.relPath}；--artifact 只接受常规文件，请指向具体产物。`,
    }
  }
  if (!st.isFile()) {
    return {
      ok: false,
      code: 'BLOCKED_ARTIFACT_NOT_REGULAR',
      reason: `实证附件不是常规文件（符号链接、设备或管道）：${located.relPath}。`,
    }
  }
  if (st.size <= 0) {
    return {
      ok: false,
      code: 'BLOCKED_ARTIFACT_EMPTY',
      reason: `实证附件是 0 字节空文件：${located.relPath}；空文件证明不了任何事，请确认真实产出后重传。`,
    }
  }
  if (st.size > ARTIFACT_MAX_BYTES) {
    return {
      ok: false,
      code: 'BLOCKED_ARTIFACT_TOO_LARGE',
      reason: `实证附件 ${located.relPath} 有 ${st.size} 字节，超过 ${ARTIFACT_MAX_BYTES} 字节上限；大体积临时产物不要留在工作区或实证链里。`,
    }
  }
  const digest = sha256File(located.abs)
  return {
    ok: true,
    record: {
      relPath: located.relPath,
      bytes: st.size,
      sha256Prefix: String(digest ?? '').slice(0, 12),
      capturedAt: String(capturedAt),
      ...(located.external ? { external: true } : {}),
    },
  }
}

/** 批量归一化声明附件：出错即整体失败，不把坏附件混进账本。 */
export function normalizeArtifactRecords({ repoRoot = null, artifacts = [], capturedAt = null } = {}) {
  const stamp = capturedAt ? String(capturedAt) : new Date().toISOString()
  const records = []
  const errors = []
  const seen = new Set()
  for (const raw of Array.isArray(artifacts) ? artifacts : []) {
    const res = resolveArtifactRecord(repoRoot, raw, stamp)
    if (!res.ok) {
      errors.push({ path: normRel(raw), code: res.code, message: res.reason })
      continue
    }
    if (seen.has(res.record.relPath)) continue
    seen.add(res.record.relPath)
    records.push(res.record)
  }
  return { ok: errors.length === 0, records, errors, error: errors[0]?.message ?? null, code: errors[0]?.code ?? null }
}

/**
 * 判断一段观察文本是否「有实质」：拒绝占位符、无信息水话与旧式合成串。
 * 判据只有一处实现（`evidence-substance.mjs`），提审、审查回执、放行理由三处都调它。
 */
export function evaluateObservationSubstance(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { ok: false, code: 'BLOCKED_VISUAL_OBSERVATION_REQUIRED', reason: '未提供视觉/渲染观察摘要。' }
  const lowered = text.toLowerCase()
  if (SYNTHETIC_OBSERVATION_TEXTS.some((s) => lowered === s.toLowerCase() || lowered.includes(s.toLowerCase()))) {
    return {
      ok: false,
      code: 'BLOCKED_VISUAL_OBSERVATION_PLACEHOLDER',
      reason: `观察摘要「${text}」是旧式硬编码确认串，没有记录任何真实渲染结果；请写清看了哪个界面、看到了什么。`,
    }
  }
  const check = evaluateTextSubstance(text, { subject: '观察摘要' })
  if (!check.ok) return { ok: false, code: check.code, reason: check.reason }
  return { ok: true, code: null, reason: null, text: check.cleaned }
}

/**
 * 结构化实证与 UI 变更判定总入口。
 *
 * - `artifacts`：任意数量的真实非空附件，每一个都要过存在性/常规文件/非空校验。
 * - `visualFilesChanged`：命中界面资源扩展名的变更文件；为空则整套视觉判据不生效。
 * - `visualCheckedRaw`：裸布尔开关。它**只能**声明「我核验过」，不能自己充当证据。
 * - `observationSummary`：视觉/交互观察摘要，必须通过实质判据。
 * - `visualBlockedReason`：环境确实不具备渲染观察条件时的诚实报阻说明。
 */
export function validateArtifactsAndVisual({
  repoRoot = null,
  artifacts = [],
  visualFilesChanged = [],
  visualCheckedRaw = false,
  observationSummary = '',
  visualBlockedReason = '',
} = {}) {
  const normalized = normalizeArtifactRecords({ repoRoot, artifacts })
  const uiFiles = [...new Set((Array.isArray(visualFilesChanged) ? visualFilesChanged : [])
    .map((f) => posixPath(String(f ?? '')).trim())
    .filter(Boolean))].sort()
  if (!normalized.ok) {
    return {
      ok: false,
      code: normalized.code ?? 'BLOCKED_ARTIFACT_INVALID',
      exitCode: EXIT.FACT,
      reason: normalized.error,
      records: normalized.records,
      errors: normalized.errors,
      visual: { required: uiFiles.length > 0, uiFiles, satisfiedBy: null },
    }
  }

  const required = uiFiles.length > 0
  const observation = evaluateObservationSubstance(observationSummary)
  const blocked = evaluateObservationSubstance(visualBlockedReason)
  const hasArtifacts = normalized.records.length > 0
  const visual = {
    required,
    uiFiles,
    headSha: null,
    hasArtifacts,
    observational: observation.ok,
    blocked: blocked.ok,
    visualCheckedRaw: Boolean(visualCheckedRaw),
    satisfiedBy: hasArtifacts ? 'artifacts' : (observation.ok ? 'observation' : (blocked.ok ? 'blocked' : null)),
    ...(observation.ok ? { observation: observation.text } : {}),
    ...(blocked.ok ? { blockedReason: blocked.text } : {}),
  }

  if (!required || visual.satisfiedBy) {
    return { ok: true, code: null, exitCode: EXIT.OK, reason: null, records: normalized.records, errors: [], visual }
  }

  const placeholder = observation.code === 'BLOCKED_VISUAL_OBSERVATION_PLACEHOLDER' ? observation.reason : null
  const reason = [
    `BLOCKED_VISUAL_EVIDENCE_REQUIRED: 变更触及界面资源（${uiFiles.slice(0, 5).join(', ')}），仅凭 --visual-checked 布尔开关不足以放行。`,
    placeholder,
    '请至少满足一项：① 附真实非空实证附件 --artifact "<产物路径>"（可多个）；② 写下实际渲染/交互观察摘要（看了哪一屏、看到了什么）；③ 环境确实无法渲染时显式声明 --visual-blocked-reason "<阻塞原因>" 诚实报阻。',
  ].filter(Boolean).join(' ')
  return { ok: false, code: 'BLOCKED_VISUAL_EVIDENCE_REQUIRED', exitCode: EXIT.FACT, reason, records: normalized.records, errors: [], visual }
}

/**
 * 提交/合并阶段的存量实证判定：只看 `evidence.json` 里已经落下的东西。
 *
 * 「什么都没声明」不算敷衍放行——那种情况下方已有独立门禁（`visualVerifiedHead`、
 * `behavioralGate`）会拦住。这里只拦一种行为：**声明了视觉核验，却拿不出证据**。
 */
export function evaluateStoredVisualEvidence({ evidence = null, policy = null, headSha = null } = {}) {
  const uiFiles = [...new Set((Array.isArray(policy?.visualFilesChanged) ? policy.visualFilesChanged : [])
    .map((f) => posixPath(String(f ?? '')).trim())
    .filter(Boolean))].sort()
  if (uiFiles.length === 0) return { ok: true, code: null, reason: null, unclaimed: true, uiFiles }

  const artifacts = Array.isArray(evidence?.artifacts)
    ? evidence.artifacts.filter((r) => String(r?.relPath ?? '').trim())
    : []
  if (artifacts.length > 0) return { ok: true, code: null, reason: null, unclaimed: false, uiFiles, satisfiedBy: 'artifacts' }

  const stored = evidence?.visual && typeof evidence.visual === 'object' ? evidence.visual : null
  if (stored && headSha && stored.headSha && stored.headSha !== headSha) {
    return {
      ok: false,
      code: 'BLOCKED_VISUAL_EVIDENCE_STALE',
      reason: `视觉实证绑定的 HEAD（${String(stored.headSha).slice(0, 7)}）已过期，请核验当前 HEAD（${String(headSha).slice(0, 7)}）后重跑 verify。`,
      uiFiles,
    }
  }
  for (const key of ['observation', 'blockedReason']) {
    const text = String(stored?.[key] ?? '').trim()
    if (!text) continue
    const sub = evaluateObservationSubstance(text)
    if (sub.ok) return { ok: true, code: null, reason: null, unclaimed: false, uiFiles, satisfiedBy: stored.satisfiedBy ?? key }
  }

  const claims = [
    { source: 'e2eObservation', text: String(evidence?.e2eObservation?.summary ?? '').trim() },
    { source: 'visualCheckEvidence', text: String(evidence?.visualCheckEvidence ?? '').trim() },
  ].filter((c) => c.text)
  for (const claim of claims) {
    const sub = evaluateObservationSubstance(claim.text)
    if (sub.ok) return { ok: true, code: null, reason: null, unclaimed: false, uiFiles, satisfiedBy: claim.source }
    if (sub.code === 'BLOCKED_VISUAL_OBSERVATION_PLACEHOLDER') {
      return {
        ok: false,
        code: 'BLOCKED_VISUAL_EVIDENCE_PLACEHOLDER',
        reason: `BLOCKED_VISUAL_EVIDENCE_PLACEHOLDER: ${sub.reason} 界面资源（${uiFiles.slice(0, 5).join(', ')}）改动不接受布尔开关自证的核验结论。`,
        uiFiles,
      }
    }
  }

  if (stored || claims.length > 0) {
    return {
      ok: false,
      code: 'BLOCKED_VISUAL_EVIDENCE_REQUIRED',
      reason: `BLOCKED_VISUAL_EVIDENCE_REQUIRED: 已声明核验界面资源（${uiFiles.slice(0, 5).join(', ')}），但实证里没有非空附件或可核对的渲染观察。请补 --artifact 或写下实际渲染/交互观察（无渲染环境时用 --visual-blocked-reason 诚实报阻）。`,
      uiFiles,
    }
  }
  return { ok: true, code: null, reason: null, unclaimed: true, uiFiles }
}

/** 合并新旧附件记录：同一 relPath 以最新一次为准，其余按路径排序，便于稳定比对。 */
export function mergeArtifactRecords(previous = [], next = []) {
  const byPath = new Map()
  for (const rec of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(next) ? next : [])]) {
    const relPath = posixPath(String(rec?.relPath ?? '')).trim()
    if (!relPath) continue
    byPath.set(relPath, {
      relPath,
      bytes: Number(rec.bytes ?? 0),
      sha256Prefix: String(rec.sha256Prefix ?? ''),
      capturedAt: String(rec.capturedAt ?? ''),
      ...(rec.external ? { external: true } : {}),
    })
  }
  return [...byPath.values()].sort((a, b) => a.relPath.localeCompare(b.relPath))
}

/**
 * `flow verify` 前置预检：先判校验，通过后把附件元数据与视觉结论并入 `evidence.json`。
 * 只写仓外状态文件；`evidencePath` 为空时退化为纯校验（不落账）。
 */
export function precheckVisualAndArtifacts({
  repoRoot = null,
  evidencePath = null,
  headSha = null,
  artifacts = [],
  visualFilesChanged = [],
  visualCheckedRaw = false,
  observationSummary = '',
  visualBlockedReason = '',
} = {}) {
  const gate = validateArtifactsAndVisual({
    repoRoot, artifacts, visualFilesChanged, visualCheckedRaw, observationSummary, visualBlockedReason,
  })
  if (!gate.ok) return gate
  if (!evidencePath) {
    return {
      ...gate,
      visual: { ...gate.visual, headSha: headSha ?? null },
      recorded: false,
    }
  }
  const prev = readJsonSafe(evidencePath)
  const records = mergeArtifactRecords(prev?.artifacts ?? [], gate.records ?? [])
  const visual = { ...gate.visual, headSha: headSha ?? prev?.headSha ?? null, recordedAt: new Date().toISOString() }
  writeJsonAtomic(evidencePath, {
    ...(prev && typeof prev === 'object' ? prev : {}),
    ...(records.length > 0 ? { artifacts: records } : {}),
    ...(visual.required ? { visual } : {}),
    updatedAt: new Date().toISOString(),
  })
  return { ...gate, records, recorded: true }
}

/**
 * 渲染 PR「验证证据」里的结构化实证摘要与附件清单。
 * 只写客观事实：文件相对路径、字节数、校验指纹前缀、环境阻塞说明。
 *
 * 一条铁律：**没有附件记录就不能说「已附附件」**。`satisfiedBy` 只描述证据形态，
 * 真附件是否存在以 `records` 为准——两者不一致时按最保守的一侧渲染。
 */
export function formatArtifactEvidenceLines({ records = [], visual = null } = {}) {
  const lines = []
  const list = Array.isArray(records) ? records : []
  if (list.length > 0) {
    lines.push('', '| 实证附件 | 字节数 | 校验指纹 |', '| --- | --- | --- |')
    for (const rec of list) {
      const name = posixPath(String(rec.relPath ?? '(unknown)'))
      lines.push(`| \`${name}\` | ${Number(rec.bytes ?? 0)} | \`${String(rec.sha256Prefix ?? '')}\` |`)
    }
    lines.push('', `- **实证附件合计**：${list.length} 个（元数据登记在仓外 \`evidence.json\`，不改动被跟踪文件）`)
  }
  if (visual?.required) {
    const touch = `涉及界面资源 ${visual.uiFiles.slice(0, 5).join(', ')}${visual.uiFiles.length > 5 ? ' 等' : ''}`
    const byArtifacts = visual.satisfiedBy === 'artifacts' && list.length > 0
    if (byArtifacts) lines.push(`- **视觉与交互核验**：${touch}；已附真实非空实证附件`)
    else if (visual.satisfiedBy === 'observation') lines.push(`- **视觉与交互核验**：${visual.observation}`)
    else if (visual.satisfiedBy === 'blocked') {
      lines.push(`- **视觉与交互核验**：环境阻塞待人工或带界面节点核验——${visual.blockedReason}`)
    } else if (visual.claimedNoProof) {
      lines.push(`- **视觉与交互核验**：${touch}；账本声明已核验，但实证里查不到附件或观察原文，需人工复核`)
    } else lines.push(`- **视觉与交互核验**：${touch}；尚未提供实证附件或观察记录`)
  }
  return lines
}

/** 附件清单的一行摘要，用于终端输出与回执里的短段。 */
export function summarizeArtifactRecords(records = []) {
  const list = Array.isArray(records) ? records : []
  if (list.length === 0) return 'none'
  return list.map((rec) => `${basename(String(rec.relPath ?? ''))}(${Number(rec.bytes ?? 0)}B)`).join(', ')
}
