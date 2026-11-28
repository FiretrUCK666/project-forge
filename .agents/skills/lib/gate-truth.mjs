/**
 * gate-truth.mjs —— 合入门禁清单的单源派生：用结构谓词圈定流水线，一条执行块算一步。
 *
 * ## 它治的是什么
 *
 * 如果仅靠在 `AGENTS.md` 里手写一条长命令维护门禁清单，那条命令与流水线里实际跑的东西
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
 * 本模块随 `kit/` 进用户安装包：其中 `kit/` 里的流程脚本（`flow-merge.mjs`、
 * `flow-batch.mjs`）只调用远端检查判定（`evaluateRemoteChecks`），与下面的四档无关；
 * 而 `deriveMergeGate` 派生器目前由本仓开发期门禁编排脚本（不进用户包）调用。即便被调用到
 * 用别的托管平台 CI、Jenkins 类流水线、只有本地脚本或完全没有 CI 的项目里，它读的是
 * 可识别的 YAML 流水线形状，**只对具备可识别流水线文件的仓生效**：
 *
 * - 一个可识别的流水线文件都没有 → `not-applicable`，**不阻断**（没有对象可判）；
 * - 有文件但解析不出来（空文件、非 YAML 结构） → `failed`，**阻断**（这是真故障）；
 * - 有文件却派生不出任何一步 → `failed`，**阻断**（文件在却没结果，说明谓词或解析坏了）。
 *
 * 后两条不能合成 `not-applicable`：**「没有对象」与「有对象却读不出结果」是两件事**。
 * 前者是判据不适用于本仓，后者是本判据自己坏了——把后者降级成前者，门禁会静默变空，
 * 而输出看起来只像「这个仓不需要检查」。
 *
 * 正因 `kit/` 进用户包的调用方只走 `evaluateRemoteChecks`，且 `deriveMergeGate` 对无
 * 可识别流水线文件的仓固定返回 `not-applicable`（不阻断），这里可以要求「有流水线就得派生出步骤」，
 * 不会把非该类 CI 的用户项目判死。
 *
 * 把 `not-applicable` 折成通过则是另一种放弃：它在输出里必须显式出现。
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
  return {
    parsed: true,
    triggers: [...triggers].sort(),
    permissions: permissions ?? {},
    hasPermissionsBlock: permissions !== null,
    env: readDeclaredEnv(lines),
  }
}

/**
 * 读顶层 `env:` 块里声明的环境条件。
 *
 * 流水线里写着的东西要照原样带给实跑：`bench` 这类脚本会按 CI 标记放大预算，
 * 本地不带上同一个标记，就会得到一张与远端不同的成绩单——然后拿它当代码有问题。
 * 只读顶层、只认字面量，不做变量求值：求值需要平台上下文，而本判据要求可离线复核。
 */
function readDeclaredEnv(lines) {
  const env = {}
  let inEnv = false
  let envIndent = -1
  for (const line of lines) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = /^(\s*)/.exec(line)[1].length
    const body = line.trim()
    if (/^env\s*:\s*$/.test(body)) { inEnv = true; envIndent = indent; continue }
    if (!inEnv) continue
    if (indent <= envIndent) { inEnv = false; continue }
    const m = /^([A-Za-z_][\w]*)\s*:\s*(.*)$/.exec(body)
    if (!m) continue
    const raw = m[2].trim()
    if (!raw || raw.startsWith('${{')) continue
    env[m[1]] = raw.replace(/^['"]|['"]$/g, '')
  }
  return env
}

/** 远端上下文的关键词：命中就说明这一步离不开远端，不属于本地可跑的门禁。 */
const REMOTE_CONTEXT_RE = /(?:\bgh\s+(?:api|pr|release|workflow|run|secret)\b|\bgit\s+push\b|\bgit\s+fetch\b|\bgit\s+remote\b|\bnpm\s+publish\b|\bpip\s+(?:install\s+--upgrade\s+)?[^\n]*--index-url|\bcurl\s+https?:|\bwget\s+https?:|\bactions\/|\bworkflow_dispatch\b|\bsetup-node\b|\bcheckout\b)/i

/**
 * 只在平台上才有值的上下文：引用它们的步骤本地跑不出同一个结论。
 *
 * `needs.<job>.result`、`matrix.*`、`secrets.*`、`github.*` 这些值的来源是那次运行的编排状态，
 * 本地没有对应物；代入空串会让条件判断落到「没给值」那一支，跑出来的结论与该步骤的意图相反。
 * `runner.temp` 不在此列——它有本地等价物（系统临时目录），可以代入后照原样跑。
 */
const PLATFORM_ONLY_CONTEXT_RE = /\$\{\{\s*(?:needs\.|matrix\.|secrets\.|github\.|strategy\.|env\.)/i

/** 三条结构谓词：触发形态、无写权限、步骤不需远端或平台上下文。 */
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
  // 「步骤不需要远端上下文」是**逐条**判的，不是整份文件一刀切：
  // 同一份校验流水线里，本地能跑的检查与只在平台上成立的汇总判断常常并存，
  // 按文件判会把能跑的那些一起丢掉——那正是按文件名整段跳过换了个样子的做法。
  const runnable = blocks.filter((b) => !REMOTE_CONTEXT_RE.test(b.cmd) && !PLATFORM_ONLY_CONTEXT_RE.test(b.cmd))
  const platformOnly = blocks.filter((b) => REMOTE_CONTEXT_RE.test(b.cmd) || PLATFORM_ONLY_CONTEXT_RE.test(b.cmd))
  return { triggerOk, permissionOk, hasWriteScope, writeAll, runnable, platformOnly }
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
 * 解析漏读的判定：文本里写着 `run:`，却一个执行块都没切出来。
 *
 * 抽成独立判据是因为它必须与「本来就没有可跑步骤」分开：
 * 前者说明解析坏了、门禁会静默变空；后者只是这份流水线不适用于本仓。
 * 混在一起，要么把正常项目判死，要么把坏掉的解析当成「没有检查」放过去。
 */
export function detectParserGap(text, blocks) {
  if ((blocks ?? []).length > 0) return false
  return /(^|\n)\s*(?:-\s+)?run\s*:/.test(String(text ?? ''))
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
  const adopted = predicates.triggerOk && predicates.permissionOk && predicates.runnable.length > 0
  const parserGap = detectParserGap(text, blocks)
  return { file: rel, parsed: true, reason: null, adopted, parserGap, predicates, blocks: predicates.runnable, skippedBlocks: predicates.platformOnly, triggers: shape.triggers, env: shape.env }
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
      (e.blocks ?? []).length > 0 ? null : '派生不出任何可在本地跑的执行块',
    ].filter(Boolean).join('；') || '三条结构谓词未全部成立',
  }))
  // 被排除的步骤要逐条报出来：同一份流水线里既有本地能跑的检查也有只在平台上成立的判断，
  // 静默丢掉后者，读的人会以为整份流水线都跑过了。
  const skippedSteps = []
  for (const e of evaluated) {
    for (const b of e.skippedBlocks ?? []) {
      skippedSteps.push({ file: b.file, startLine: b.startLine, cmd: b.cmd, reason: '步骤需要远端或平台上下文（needs/matrix/secrets/github），本地跑不出同一结论' })
    }
  }

  const steps = adopted.flatMap((e) => (e.blocks ?? []).map((b) => ({
    file: b.file, startLine: b.startLine, endLine: b.endLine, cmd: b.cmd, lineCount: b.lineCount,
  })))

  // 两种失败原因必须分开报告，但均判为 FAILED / blocking: true，防止门禁静默变空：
  // 前者是文件写着 run 步骤却切不出执行块（解析漏读），后者是谓词把现有流水线全部排除。
  const parserGaps = evaluated.filter((e) => e.parserGap)
  if (parserGaps.length > 0) {
    return {
      verdict: GATE_VERDICT.FAILED,
      blocking: true,
      steps: [],
      adoptedFiles: adopted.map((e) => e.file),
      skippedFiles: skipped,
      skippedSteps,
      reasons: parserGaps.map((e) => `${e.file}：文件里写着 run 步骤，却一条执行块都没切出来——解析漏读了，不能当成「没有检查」`),
    }
  }

  // 找到了流水线文件，却一条本地可跑的步骤都派不出来：这是派生坏了，不是「不适用」。
  // 「没有对象」与「有对象却读不出结果」混成一档，门禁会静默变空而输出看着正常。
  if (steps.length === 0) {
    return {
      verdict: GATE_VERDICT.FAILED,
      blocking: true,
      steps: [],
      adoptedFiles: [],
      skippedFiles: skipped,
      skippedSteps,
      reasons: [
        `${pipelineFiles.length} 份流水线文件在，但一条步骤也派生不出来（${skipped.map((s) => s.file).join('、')}）：`
        + '要么结构谓词把它们全排除了，要么解析漏读了——两种都得先看清楚，不能当成「没有检查」',
      ],
    }
  }

  return {
    verdict: GATE_VERDICT.UNVERIFIED,
    blocking: false,
    steps,
    adoptedFiles: adopted.map((e) => e.file),
    skippedFiles: skipped,
    skippedSteps,
    // 流水线自己声明的环境条件随派生结果一起交出去：编排脚本按它设置进程环境，
    // 才跑得出与远端同一张成绩单（例如按 CI 标记放大的性能预算）。
    // 默认值取托管平台 runner 的惯例值 CI=true，不自造 1：脚本按 CI === 'true'
    // 判断要不要放大预算，写成 1 等于没写，跑出来还是本地口径。
    evidenceEnv: { CI: 'true', ...(adopted.find((e) => e.env)?.env ?? {}) },
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
  if ((gate.skippedSteps ?? []).length > 0) {
    lines.push(`  跳过的步骤（${gate.skippedSteps.length} 条，本地跑不出同一结论）：`)
    for (const s of gate.skippedSteps) lines.push(`    ${s.file}:${s.startLine}  ${s.cmd.split('\n')[0]}`)
  }
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
