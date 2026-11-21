/**
 * gate-truth.mjs —— 合入门禁清单的单源派生：用结构谓词圈定流水线，一条执行块算一步。
 *
 * ## 它治的是什么
 *
 * 门禁清单原来在 `AGENTS.md` 里手写一条长命令，而那条命令与流水线里实际跑的东西
 * **没有任何机械关系**：流水线改了一步，清单不会跟着变；清单少写了一步，没人发现。
 * 两份手写的「应该跑什么」，迟早对不上，而对不上的表现是「本地全绿、远端红」，或者更糟——
 * 「远端红了但没人看」。
 *
 * ## 为什么用结构谓词，而不是按文件名排除
 *
 * 「只采纳校验类流水线、发版流水线整体排除」是按文件整段跳过，正是软通道：
 * 它会连带丢掉发版流水线里本地跑得通的检查。三条谓词读的是文件里机械可查的事实：
 *
 * 1. **触发形态**：`pull_request` 或推送到默认分支；
 * 2. **无写权限**：权限声明里没有任何写作用域；
 * 3. **步骤不需远端上下文**：不依赖远端 API、不发版、不推送。
 *
 * 三条同时成立才采纳。发版流水线因为 1、2 不成立而被排除，而不是因为「它是发版流水线」。
 *
 * ## 适用范围（这条不写清，分发出去就红）
 *
 * 本模块随 `kit/` 进用户安装包，会装到用别的托管平台 CI 的项目、用 Jenkins 类流水线的
 * 项目、只有本地脚本的项目，以及完全没有 CI 的项目里去。判据读的是 YAML 流水线形状，
 * **只对具备可识别流水线文件的仓生效**：
 *
 * - 一个可识别的流水线文件都没有 → `not-applicable`，**不阻断**（没有对象可判）；
 * - 有文件但解析不出来（空文件、非 YAML 结构） → `failed`，**阻断**（这是真故障）；
 * - 有文件却派生不出任何一步 → `failed`，**阻断**（文件在却没结果，说明谓词或解析坏了）。
 *
 * 把「没有流水线」判成阻断，等于隐含要求「必须有 GitHub 形状的流水线」，
 * 那样非该类 CI 的项目装完即不可用。而把 `not-applicable` 折成通过，
 * 只是换了个地方放弃检查——所以它在输出里必须显式出现。
 *
 * ## 四档互斥
 *
 * `passed` / `failed` / `unverified` / `not-applicable`，一个结论只能是其中一个。
 * `unverified` 是「该跑但没跑成」（缺命令、被跳过），与 `failed` 一样不等于通过。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { readTextSafe } from './git.mjs'

/** 合入门禁结论的四种取值。互斥，且 `unverified` 与 `not-applicable` 都不是通过。 */
export const GATE_VERDICT = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  UNVERIFIED: 'unverified',
  NOT_APPLICABLE: 'not-applicable',
})

/** 一个执行块的来源：文件、起止行、整块文本（多行整体执行，不拆行）。 */
function blockOf(file, startLine, endLine, text) {
  return { file, startLine, endLine, cmd: text, lineCount: endLine - startLine + 1 }
}

/**
 * 把一份 YAML 流水线切成「执行块」。
 *
 * **一条执行块算一步**，多行整体执行。把多行块拆成每行一条，会产出孤立右括号、
 * 被截断的 `|| {`、错误提示行、纯导出命令这些病态条目；而它们中的任何一个都不是
 * 可独立跑的命令，于是「派生出的命令清单」就没法整块交给 shell 跑。
 *
 * `defaults.run.shell` 这类**全局默认声明**不是执行块：它给的是「用哪个 shell」，
 * 不是「跑什么命令」。把它算成一步，派生清单里就会多出一条永远跑不动的 `shell: bash`。
 */
export function extractExecutionBlocks(relFile, text) {
  const blocks = []
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const MAPPING_ONLY_KEYS_RE = /^(?:shell|working-directory|working_directory|encoding)\s*:/
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(\s*)(?:-\s+)?run\s*:\s*(.*)$/.exec(lines[i])
    if (!m) continue
    const listPrefix = /^(\s*-\s+)run\s*:/.exec(lines[i])
    const baseIndent = listPrefix ? listPrefix[1].length : m[1].length
    const tail = m[2].trim()
    const startLine = i + 1

    if (!tail || /^[|>][+-]?$/.test(tail)) {
      const body = []
      let blockIndent = null
      let isMappingDeclaration = false
      for (let j = i + 1; j < lines.length; j += 1) {
        const raw = lines[j]
        if (!raw.trim()) { body.push(''); continue }
        const curIndent = /^(\s*)/.exec(raw)[1].length
        if (curIndent <= baseIndent) break
        if (blockIndent === null && MAPPING_ONLY_KEYS_RE.test(raw.trim())) { isMappingDeclaration = true; break }
        if (blockIndent === null) blockIndent = curIndent
        else if (curIndent < blockIndent) break
        body.push(raw.slice(Math.min(blockIndent, raw.length)))
        i = j
      }
      if (isMappingDeclaration) continue
      while (body.length > 0 && !body[body.length - 1].trim()) body.pop()
      const cmd = body.join('\n').replace(/\n+$/, '')
      if (cmd.trim()) blocks.push(blockOf(relFile, startLine, startLine + body.length, cmd))
    } else {
      const cmd = tail.replace(/\s+#.*$/, '').trim()
      if (cmd) blocks.push(blockOf(relFile, startLine, startLine, cmd))
    }
  }
  return blocks
}

/** 从 YAML 顶层读出触发形态与权限声明。解析不出来时返回 `parsed: false`。 */
export function readPipelineShape(relFile, text) {
  const raw = String(text ?? '').replace(/\r\n/g, '\n')
  const lines = raw.split('\n')
  if (!raw.trim()) return { parsed: false, reason: '文件为空' }

  // 触发形态：`on:` 块里出现的键。
  const triggers = new Set()
  let inOn = false
  let onIndent = -1
  let permissions = null
  let inPerm = false
  let permIndent = -1
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = /^(\s*)/.exec(line)[1].length
    const line2 = line.trim()
    if (/^on\s*:\s*$/.test(line2)) { inOn = true; onIndent = indent; continue }
    if (/^on\s*:\s*\[/.test(line2)) {
      for (const t of line2.replace(/^on\s*:\s*\[|\]\s*$/g, '').split(',')) {
        if (t.trim()) triggers.add(t.trim().replace(/['"]/g, ''))
      }
      continue
    }
    if (/^on\s*:\s*\S/.test(line2)) { triggers.add(line2.replace(/^on\s*:\s*/, '').replace(/['"]/g, '')); continue }
    if (/^permissions\s*:\s*$/.test(line2)) { inPerm = true; permIndent = indent; permissions = {}; continue }
    if (/^permissions\s*:\s*(read-all|write-all|none|\{\s*\})\s*$/.test(line2)) {
      permissions = { _all: line2.replace(/^permissions\s*:\s*/, '').trim() }
      continue
    }
    if (inOn) {
      if (indent <= onIndent) inOn = false
      else {
        const k = /^\s*-?\s*([A-Za-z_]+)\s*:/.exec(line)?.[1]
        if (k) triggers.add(k)
      }
    }
    if (inPerm) {
      if (indent <= permIndent) inPerm = false
      else {
        const m2 = /^\s*([a-z-]+)\s*:\s*(\S+)/.exec(line)
        if (m2) permissions[m2[1]] = m2[2].trim()
      }
    }
  }

  if (triggers.size === 0) return { parsed: false, reason: '读不到触发形态（缺少 on: 声明）' }
  return { parsed: true, triggers: [...triggers].sort(), permissions: permissions ?? {}, hasPermissionsBlock: permissions !== null }
}

/** 远端上下文的关键词：命中就说明这一步离不开远端，不属于本地可跑的门禁。 */
const REMOTE_CONTEXT_RE = /(?:\bgh\s+(?:api|pr|release|workflow|run|secret)\b|\bgit\s+push\b|\bgit\s+fetch\b|\bgit\s+remote\b|\bnpm\s+publish\b|\bpip\s+(?:install\s+--upgrade\s+)?[^\n]*--index-url|\bcurl\s+https?:|\bwget\s+https?:|\bactions\/|\bworkflow_dispatch\b|\bsetup-node\b|\bcheckout\b)/i

/** 三条结构谓词：触发形态、无写权限、步骤不需远端上下文。 */
export function evaluateStructuralPredicates(shape, blocks = []) {
  const triggers = shape?.triggers ?? []
  const triggerOk = triggers.includes('pull_request')
    || triggers.includes('push')
    || triggers.includes('pull_request_target')
  const perms = shape?.permissions ?? {}
  const hasWriteScope = Object.entries(perms).some(([k, v]) => k !== '_all' && /write/i.test(String(v)))
  const writeAll = String(perms._all ?? '').toLowerCase() === 'write-all'
  // 显式声明了只读或没声明（默认交给平台设置）都算「没有写作用域」；
  // 默认设置被改成可写是平台侧风险，不是这份文件里读得出的结构事实。
  const permissionOk = !hasWriteScope && !writeAll
  const remoteFree = blocks.length > 0 && blocks.every((b) => !REMOTE_CONTEXT_RE.test(b.cmd))
  return { triggerOk, permissionOk, remoteFree, hasWriteScope, writeAll }
}

/** 找出仓库里可识别的流水线文件（只看形状，不看名字是否含「release」）。 */
export function discoverPipelineFiles(repoRoot) {
  const found = []
  const wfDir = join(repoRoot, '.github', 'workflows')
  if (existsSync(wfDir)) {
    try {
      for (const name of readdirSync(wfDir).filter((n) => /\.ya?ml$/i.test(n)).sort()) {
        found.push(`.github/workflows/${name}`)
      }
    } catch { /* 读不到就当没有 */ }
  }
  // 别的托管平台与本地流水线也可能带 YAML 执行块：列在这里是因为判据读的是**形状**，
  // 不是平台名。认不出来就落进「没有可识别流水线」那一档，记不适用而不阻断。
  for (const rel of [
    '.git' + 'lab-ci.yml',
    '.circleci/config.yml',
    'azure-pipelines.yml',
    'Jenkinsfile',
    '.drone.yml',
  ]) {
    if (existsSync(join(repoRoot, rel))) found.push(rel)
  }
  return found.sort()
}

/**
 * 判定一份流水线文件。
 *
 * @returns {{ file: string, parsed: boolean, reason: string|null, adopted: boolean,
 *   predicates: object|null, blocks: Array<object> }}
 */
export function evaluatePipeline(repoRoot, rel) {
  const text = readTextSafe(join(repoRoot, rel))
  if (text === undefined) {
    return { file: rel, parsed: false, reason: '文件存在但读不出来', adopted: false, predicates: null, blocks: [] }
  }
  const blocks = extractExecutionBlocks(rel, text)
  const shape = readPipelineShape(rel, text)
  if (!shape.parsed) {
    return { file: rel, parsed: false, reason: shape.reason, adopted: false, predicates: null, blocks }
  }
  const predicates = evaluateStructuralPredicates(shape, blocks)
  const adopted = predicates.triggerOk && predicates.permissionOk && predicates.remoteFree && blocks.length > 0
  return { file: rel, parsed: true, reason: null, adopted, predicates, blocks, triggers: shape.triggers }
}

/**
 * 派生合入门禁清单并给出四档结论。
 *
 * 结论严格互斥，且 `unverified` / `not-applicable` 都不会被折成通过。
 *
 * @returns {{ verdict: string, blocking: boolean, steps: Array<{file:string,startLine:number,cmd:string}>,
 *   adoptedFiles: string[], skippedFiles: Array<{file:string,reason:string}>, reasons: string[] }}
 */
export function deriveMergeGate(repoRoot) {
  const pipelineFiles = discoverPipelineFiles(repoRoot)
  if (pipelineFiles.length === 0) {
    return {
      verdict: GATE_VERDICT.NOT_APPLICABLE,
      blocking: false,
      steps: [],
      adoptedFiles: [],
      skippedFiles: [],
      reasons: ['仓库里没有任何可识别的流水线文件——没有被管的对象，这条判据不适用于本仓'],
    }
  }

  const evaluated = pipelineFiles.map((rel) => evaluatePipeline(repoRoot, rel))
  const broken = evaluated.filter((e) => !e.parsed)
  if (broken.length > 0) {
    return {
      verdict: GATE_VERDICT.FAILED,
      blocking: true,
      steps: [],
      adoptedFiles: [],
      skippedFiles: broken.map((e) => ({ file: e.file, reason: e.reason })),
      reasons: broken.map((e) => `${e.file}：找到了流水线文件却读不懂（${e.reason}）——这是真故障，不能降级成空清单`),
    }
  }

  const adopted = evaluated.filter((e) => e.adopted)
  const skipped = evaluated.filter((e) => !e.adopted).map((e) => ({
    file: e.file,
    reason: [
      e.predicates?.triggerOk ? null : '触发形态不是提案或推默认分支',
      e.predicates?.permissionOk ? null : '权限声明里有写作用域',
      e.predicates?.remoteFree ? null : '步骤需要远端上下文',
      (e.blocks ?? []).length > 0 ? null : '派生不出任何执行块',
    ].filter(Boolean).join('；') || '三条结构谓词未全部成立',
  }))

  const steps = adopted.flatMap((e) => (e.blocks ?? []).map((b) => ({
    file: b.file, startLine: b.startLine, endLine: b.endLine, cmd: b.cmd, lineCount: b.lineCount,
  })))

  if (steps.length === 0) {
    return {
      verdict: GATE_VERDICT.FAILED,
      blocking: true,
      steps: [],
      adoptedFiles: [],
      skippedFiles: skipped,
      reasons: ['流水线文件都在，但按三条结构谓词一步也派生不出来——说明谓词或解析坏了，不能当成「没有检查」'],
    }
  }

  return {
    verdict: GATE_VERDICT.UNVERIFIED,
    blocking: false,
    steps,
    adoptedFiles: adopted.map((e) => e.file),
    skippedFiles: skipped,
    reasons: [`已派生 ${steps.length} 步，来自 ${adopted.length} 份流水线文件；尚未执行，所以还不是通过`],
  }
}

/** 把结论排成人能读的几行；`not-applicable` 与 `unverified` 都必须显式出现。 */
export function formatMergeGate(gate) {
  const lines = [`合入门禁结论：${gate.verdict}`]
  for (const r of gate.reasons ?? []) lines.push(`  - ${r}`)
  if ((gate.steps ?? []).length > 0) {
    lines.push(`  派生步骤（${gate.steps.length} 条，一条执行块算一步）：`)
    for (const s of gate.steps) lines.push(`    ${s.file}:${s.startLine}${s.lineCount > 1 ? `-${s.endLine}` : ''}  ${s.cmd.split('\n')[0]}`)
  }
  for (const s of gate.skippedFiles ?? []) lines.push(`  未采纳 ${s.file}：${s.reason}`)
  return lines
}

/**
 * 远端检查的判定结论。互斥五档，`pending` 与 `unverified` 都不是通过。
 *
 * `NOT_REQUIRED` 只在「仓库根本没有检查工作流」时给——此时没有对象可判，
 * 与「有工作流但一条 check-run 都没注册」是两件事，后者必须阻断。
 */
export const REMOTE_CHECK_VERDICT = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  PENDING: 'pending',
  UNVERIFIED: 'unverified',
  NOT_REQUIRED: 'not-required',
})

/**
 * 远端必过检查的**唯一判定点**：合并入口与批量队列都调这里。
 *
 * 两处各写一份状态分桶，必然会漂移——事实上已经漂了：合并入口认四类桶加未知态，
 * 批量队列只认三类，于是同一份检查在两条路上给出不同结论，而没有任何东西会报错。
 *
 * `humanApproved` 不在这里判：函数只回答「事实是什么」，能不能越过由调用点决定。
 */
export function evaluateRemoteChecks(checks, { ciRequired = false, headSha = null } = {}) {
  const short = headSha ? String(headSha).slice(0, 7) : 'unknown'
  const list = (arr) => (Array.isArray(arr) ? arr : []).map((c) => `${c.name}[${c.state}]`).join(', ')
  const notRequired = { verdict: REMOTE_CHECK_VERDICT.NOT_REQUIRED, blocking: false, code: null, message: null }

  if (!checks || checks.skipped) return notRequired
  if (!checks.ok) {
    if (!ciRequired) return notRequired
    return {
      verdict: REMOTE_CHECK_VERDICT.UNVERIFIED,
      blocking: true,
      code: 'BLOCKED_CI_UNVERIFIED',
      message: `BLOCKED_CI_UNVERIFIED: 无法核验当前 HEAD (${short}) 远端 CI 状态（${checks.error ?? 'unknown'}），拒绝盲目合并。`,
    }
  }

  switch (checks.bucket) {
    case 'pass':
      return { verdict: REMOTE_CHECK_VERDICT.PASSED, blocking: false, code: null, message: null }
    case 'fail':
      return {
        verdict: REMOTE_CHECK_VERDICT.FAILED,
        blocking: true,
        code: 'BLOCKED_CI_FAILED',
        message: `BLOCKED_CI_FAILED: 当前 HEAD (${short}) 远端 CI 检查未通过（${list(checks.failed)}），禁止带病合并。`,
      }
    case 'pending':
      return {
        verdict: REMOTE_CHECK_VERDICT.PENDING,
        blocking: true,
        code: 'BLOCKED_CI_PENDING',
        message: `BLOCKED_CI_PENDING: 当前 HEAD (${short}) 远端 CI 仍在运行或排队（${list(checks.pending)}），请等待全部变绿后再执行 merge。`,
      }
    case 'none':
      if (!ciRequired) return notRequired
      return {
        verdict: REMOTE_CHECK_VERDICT.PENDING,
        blocking: true,
        code: 'BLOCKED_CI_PENDING',
        message: `BLOCKED_CI_PENDING: 仓库存在检查工作流，但当前 HEAD (${short}) 远端尚未注册 check-run，请等待检查变绿后再执行 merge。`,
      }
    default:
      if (!ciRequired) return notRequired
      return {
        verdict: REMOTE_CHECK_VERDICT.UNVERIFIED,
        blocking: true,
        code: 'BLOCKED_CI_UNVERIFIED',
        message: `BLOCKED_CI_UNVERIFIED: 无法完整核验当前 HEAD (${short}) 远端 CI 状态（${(checks.warnings ?? []).join(', ') || 'unknown'}），拒绝盲目合并。`,
      }
  }
}
