/**
 * merge3.mjs —— 跨代升级无破坏三方合并引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 * 核心安全红线：
 *   - 当 `.mjs` 或其它程序代码/配置脚本发生双端冲突时，**严禁向源文件写入 `<<<<<<<` 冲突标记**；
 *   - 保留用户本地可用代码原样，同时将 `{target}.upstream` 上游新本与 `{target}.pf-conflict` 结构化冲突详情
 *     写入仓外冲突目录，供 `equip.mjs` 在 `.pf-manifest.json` 登记 `pendingConflicts` 并返回非零冲突码。
 */

import { join } from 'node:path'

const CODE_SAFE_EXT_RE = /\.(?:m?js|cjs|tsx?|jsx?|mts|cts|json|sh|bash|ps1|bat|cmd|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|ya?ml|toml)$/i

export const CONFLICT_MARKER_RE = /^(?:<<<<<<<|=======|>>>>>>>)\b/m

/** 判断路径是否属于严禁写入文本冲突标记的程序代码/结构化文件。 */
export function isCodeLikePath(relPath) {
  return CODE_SAFE_EXT_RE.test(String(relPath ?? '').trim())
}

/**
 * 装配逐文件判定的封闭枚举。
 *
 * ## 为什么必须是同一个判定
 *
 * 校验路径与写入路径过去各读一个字段：前者读字节比对后的 `drifted`，后者只读
 * `pendingConflicts`。「本地改了、上游没改」这类情况进的是运行报告 `conflicts[]`，
 * 不进 `pendingConflicts`——于是写路径永远看到空对象、永远退 0，而校验路径退 1。
 * 同一个动作两个相反结论，根因不是退出码写错，是两条路径量的不是同一件事。
 *
 * 现在两边都算这一个判定：校验路径判完就报，写入路径判完再动作、动作完再判一次。
 * **比较的是运行结束后的状态**——写入路径把它能解决的都解决了，剩下什么才是结论。
 */
export const EQUIP_FILE_STATES = Object.freeze({
  SYNCED: '同步',
  EXEMPT_CUSTOM: '豁免定制',
  UPSTREAM_AHEAD: '上游已更新（本地未改）',
  LOCAL_AHEAD: '本地已改且上游未变',
  BOTH_MODIFIED: '双端均有修改（待三方合并）',
  THREE_WAY_CONFLICT: '三方冲突待裁决',
  MISSING: '缺失',
  EXTRA: '多余',
})

/** 判定为「需要处置」的阻塞状态：`UPSTREAM_AHEAD` 可直接 `equip` 无损升级，不属本地冲突阻塞。 */
const BLOCKING_STATES = new Set([
  EQUIP_FILE_STATES.LOCAL_AHEAD,
  EQUIP_FILE_STATES.BOTH_MODIFIED,
  EQUIP_FILE_STATES.THREE_WAY_CONFLICT,
])

/**
 * 单文件判定。纯函数：只吃哈希与登记项，不读盘、不写盘。
 *
 * @returns {{state: string, blocking: boolean, fixHint: string}}
 */
export function judgeManagedFile({
  rel = '', upstreamSha = null, diskSha = null, baselineSha = null, customEntry = null, pendingEntry = null,
  conflictDir = null, skillsDir = null,
} = {}) {
  const hintOpts = {
    outOfTree: Boolean(pendingEntry?.outOfTree),
    conflictDir,
    skillsDir,
    upstreamFile: pendingEntry?.upstreamFile,
    conflictFile: pendingEntry?.conflictFile,
  }
  // 缺文件 / 多余文件由调用方先判（那需要看盘），这里只管「三方都在」的情形。
  if (!diskSha) return { state: EQUIP_FILE_STATES.MISSING, blocking: false, fixHint: fixHintFor(EQUIP_FILE_STATES.MISSING, rel, hintOpts) }
  if (!upstreamSha) return { state: EQUIP_FILE_STATES.EXTRA, blocking: false, fixHint: fixHintFor(EQUIP_FILE_STATES.EXTRA, rel, hintOpts) }
  if (pendingEntry) {
    return { state: EQUIP_FILE_STATES.THREE_WAY_CONFLICT, blocking: true, fixHint: fixHintFor(EQUIP_FILE_STATES.THREE_WAY_CONFLICT, rel, hintOpts) }
  }
  if (diskSha === upstreamSha) {
    return { state: EQUIP_FILE_STATES.SYNCED, blocking: false, fixHint: '' }
  }
  // 登记为定制、且磁盘仍是登记时那一版、上游也没动：这是一份被明确保留的定制。
  if (customEntry && diskSha === customEntry.baseSha256 && customEntry.upstreamSha256 === upstreamSha) {
    return { state: EQUIP_FILE_STATES.EXEMPT_CUSTOM, blocking: false, fixHint: '' }
  }
  // 上游也变了、本地也变了 → 两条改动撞在一起，得有人裁决。
  // 登记过定制不代表「永远不跟上上游」：上游改了同一处却不告诉人，就是沉默放过。
  if (customEntry && diskSha === customEntry.baseSha256 && customEntry.upstreamSha256 !== upstreamSha) {
    return { state: EQUIP_FILE_STATES.THREE_WAY_CONFLICT, blocking: true, fixHint: fixHintFor(EQUIP_FILE_STATES.THREE_WAY_CONFLICT, rel, hintOpts) }
  }
  // 磁盘与清单基线一致、上游已有新版：本地未改，可直接无损升级。
  if (baselineSha && diskSha === baselineSha && upstreamSha !== baselineSha) {
    return { state: EQUIP_FILE_STATES.UPSTREAM_AHEAD, blocking: false, fixHint: fixHintFor(EQUIP_FILE_STATES.UPSTREAM_AHEAD, rel, hintOpts) }
  }
  // 磁盘与上游均相对清单基线有修改：待三方合并。
  if (baselineSha && diskSha !== baselineSha && upstreamSha !== baselineSha) {
    return { state: EQUIP_FILE_STATES.BOTH_MODIFIED, blocking: true, fixHint: fixHintFor(EQUIP_FILE_STATES.BOTH_MODIFIED, rel, hintOpts) }
  }
  // 磁盘与清单基线不同、上游没改：本地改动被保留下来。
  if (baselineSha && diskSha !== baselineSha && upstreamSha === baselineSha) {
    return { state: EQUIP_FILE_STATES.LOCAL_AHEAD, blocking: true, fixHint: fixHintFor(EQUIP_FILE_STATES.LOCAL_AHEAD, rel, hintOpts) }
  }
  return { state: EQUIP_FILE_STATES.LOCAL_AHEAD, blocking: true, fixHint: fixHintFor(EQUIP_FILE_STATES.LOCAL_AHEAD, rel, hintOpts) }
}

/** 每类状态一句可执行修法：改了什么、三种合法处置各是什么。 */
export function fixHintFor(state, rel = '', opts = {}) {
  const name = rel || '<该文件>'
  if (state === EQUIP_FILE_STATES.UPSTREAM_AHEAD) {
    return `${name} 本地未改、上游已有新版本。运行 node scripts/equip.mjs . 即可直接无损升级。`
  }
  if (state === EQUIP_FILE_STATES.BOTH_MODIFIED) {
    return `${name} 本地与上游均相对基线有修改。运行 node scripts/equip.mjs . 将执行无损三方合并（非重叠改动自动合并；冲突时保留本地并在仓外生成对照，不污染源码）。`
  }
  if (state === EQUIP_FILE_STATES.LOCAL_AHEAD) {
    return `${name} 磁盘版本与清单基线不同、上游未改。三种合法处置：`
      + `① 先复制一份你的版本留底，再 node scripts/equip.mjs . --restore ${name} 接受上游覆盖；`
      + `② node scripts/equip.mjs . --adopt-custom ${name} 把改动登记为定制（上游升级时仍保留你的版本）；`
      + `③ 手工改回上游内容后重跑，等于丢弃本地改动。`
  }
  if (state === EQUIP_FILE_STATES.THREE_WAY_CONFLICT) {
    const upLoc = opts.outOfTree && opts.conflictDir
      ? join(opts.conflictDir, opts.upstreamFile || `${name}.upstream`)
      : `${name}.upstream`
    const cfLoc = opts.outOfTree && opts.conflictDir
      ? join(opts.conflictDir, opts.conflictFile || `${name}.pf-conflict`)
      : `${name}.pf-conflict`
    const localLoc = opts.skillsDir ? join(opts.skillsDir, name) : `.agents/skills/${name}`
    const diffPart = opts.outOfTree && opts.conflictDir ? `（对比：diff -u "${localLoc}" "${upLoc}"）` : ''
    return `${name} 上游与本地改到了同一处，不能自动合并。冲突对照已写入 ${upLoc}（上游新本）与 ${cfLoc}（冲突详情）${diffPart}：`
      + `① 按冲突详情手工合并，再 node scripts/equip.mjs . --adopt-custom ${name} 登记；`
      + `② node scripts/equip.mjs . --restore ${name} 放弃本地改动采用上游；`
      + `③ 保留本地不动，但需在 .pf-manifest.json 的 pendingConflicts 里显式留痕，命令会一直退非零直到处置。`
  }
  if (state === EQUIP_FILE_STATES.MISSING) return `${name} 在本地不存在，跑 node scripts/equip.mjs . 会补回上游版本。`
  if (state === EQUIP_FILE_STATES.EXTRA) return `${name} 上游已不再提供，跑 node scripts/equip.mjs . 会把它移出受管清单。`
  return ''
}

/** 未通过判定的状态：两条路径用同一个谓词，结论不会分叉。 */
export function isBlockingEquipState(state) {
  return BLOCKING_STATES.has(state)
}

/**
 * 把装配校验结论排成人能读的几行。
 *
 * 需要处置的状态各带一句可执行修法：只说「字节不一致」等于让人自己去猜怎么收场，
 * 而这正是这条判据要治的「拒绝了却不告诉你怎么办」。
 */
export function formatEquipCheckReport(res) {
  const lines = []
  if (res.reason) lines.push(res.reason)
  for (const p of res.missing ?? []) lines.push(`缺失：${p}`)
  for (const d of res.drifted ?? []) {
    if (d && typeof d === 'object') {
      lines.push(`${d.state}：${d.path}`)
      if (d.fixHint) lines.push(`  修法：${d.fixHint}`)
    } else {
      lines.push(`字节不一致：${d}`)
    }
  }
  for (const p of res.unregistered ?? []) lines.push(`未登记哈希：${p}`)
  for (const p of res.extraManaged ?? []) lines.push(`多余托管文件：${p}`)
  const detailByPath = new Map((res.pendingConflictDetails ?? []).map((item) => [item.path, item]))
  for (const p of res.pendingConflicts ?? []) {
    const det = detailByPath.get(p)
    if (det) {
      lines.push(`待裁决三方冲突：${p}（仓外对照：${det.conflictPath} 与 ${det.upstreamPath}）`)
      lines.push(`  对比：${det.diffCommand}`)
      lines.push(`  一键处置：${det.adoptCommand} | ${det.restoreCommand}`)
    } else {
      lines.push(`待裁决三方冲突：${p}（见 ${p}.pf-conflict 与 ${p}.upstream）`)
    }
  }
  for (const b of res.brokenImports ?? []) lines.push(`相对导入断链：${b}`)
  for (const f of res.invalidFrontmatters ?? []) lines.push(`frontmatter 缺少 name/description：${f}`)
  for (const c of res.customized ?? []) {
    lines.push(c.upstreamChanged ? `定制豁免：${c.path}（上游新版有变化，可供参考合并）` : `定制豁免：${c.path}（与上游基线一致）`)
  }
  return lines.join('\n')
}

/**
 * 把一个工作区的逐文件状态算出来。
 *
 * 校验路径拿运行前的盘面算，写入路径拿动作完的账本算——**两边算的是同一个函数**，
 * 所以对同一份工作区给出同一个状态序列。「本地改动被保留」这类事情在两条路径上落到
 * 同一个状态、同一个退出码，不再是一边退 0 一边退 1。
 *
 * @param {{files: Map<string,{upstreamSha:string|null}>, diskHashes: Map<string,string|null>,
 *   baseline: Map<string,string>, customized: object, pendingConflicts: object}} input
 * @returns {{states: Map<string, object>, blocking: string[], byState: Map<string, string[]>}}
 */
export function computeFileStates({ files, diskHashes, baseline = new Map(), customized = {}, pendingConflicts = {} } = {}) {
  const states = new Map()
  const blocking = []
  const byState = new Map()
  const rels = new Set([...files.keys(), ...diskHashes.keys(), ...baseline.keys()])
  for (const rel of [...rels].sort()) {
    const verdict = judgeManagedFile({
      rel,
      upstreamSha: files.get(rel)?.upstreamSha ?? files.get(rel)?.sha256 ?? null,
      diskSha: diskHashes.get(rel) ?? null,
      baselineSha: baseline.get(rel) ?? null,
      customEntry: customized[rel] ?? null,
      pendingEntry: pendingConflicts[rel] ?? null,
    })
    states.set(rel, verdict)
    if (verdict.blocking) blocking.push(rel)
    if (!byState.has(verdict.state)) byState.set(verdict.state, [])
    byState.get(verdict.state).push(rel)
  }
  return { states, blocking, byState }
}

function normLines(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n')
  if (!s) return []
  return s.split('\n')
}

/** 计算两个行数组的编辑脚本（Myers / LCS 动态规划，对超大文件自动退化至前缀/后缀分块防 OOM）。 */
function diffLineOps(baseLines, targetLines) {
  let prefix = 0
  const minLen = Math.min(baseLines.length, targetLines.length)
  while (prefix < minLen && baseLines[prefix] === targetLines[prefix]) prefix += 1

  let suffix = 0
  while (
    suffix < (baseLines.length - prefix)
    && suffix < (targetLines.length - prefix)
    && baseLines[baseLines.length - 1 - suffix] === targetLines[targetLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  const midBase = baseLines.slice(prefix, baseLines.length - suffix)
  const midTarget = targetLines.slice(prefix, targetLines.length - suffix)
  if (midBase.length === 0 && midTarget.length === 0) return []

  // 超大差异块直接退化为单块替换，避免二次矩阵内存爆炸
  if (midBase.length * midTarget.length > 250000) {
    return [{
      baseStart: prefix,
      baseEnd: prefix + midBase.length,
      lines: midTarget,
    }]
  }

  const m = midBase.length
  const n = midTarget.length
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1))
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = midBase[i] === midTarget[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const hunks = []
  let i = 0
  let j = 0
  while (i < m || j < n) {
    if (i < m && j < n && midBase[i] === midTarget[j]) {
      i += 1
      j += 1
      continue
    }
    const startI = i
    const startJ = j
    while (i < m || j < n) {
      if (i < m && j < n && midBase[i] === midTarget[j]) break
      if (i < m && (j >= n || dp[i + 1][j] >= dp[i][j + 1])) i += 1
      else j += 1
    }
    hunks.push({
      baseStart: prefix + startI,
      baseEnd: prefix + i,
      lines: midTarget.slice(startJ, j),
    })
  }
  return hunks
}

function sameLines(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function hunksOverlap(a, b) {
  if (a.baseStart === a.baseEnd && b.baseStart === b.baseEnd) {
    return a.baseStart === b.baseStart
  }
  if (a.baseStart === a.baseEnd) {
    return a.baseStart >= b.baseStart && a.baseStart <= b.baseEnd
  }
  if (b.baseStart === b.baseEnd) {
    return b.baseStart >= a.baseStart && b.baseStart <= a.baseEnd
  }
  return a.baseStart < b.baseEnd && b.baseStart < a.baseEnd
}

/**
 * 执行条件三方行合并：
 * - `current === base` -> `fast-forward`（直接升级为 upstream）
 * - `upstream === base` 或 `current === upstream` -> `keep-current`（无需改写）
 * - 仅改动不重叠区间 -> `merged`（无感保留用户改动并合入上游更新）
 * - 存在重叠冲突 -> `conflict`（**绝不向代码文件写入 `<<<<<<<`**，保留用户版本并输出冲突详情）。
 */
export function merge3Text(baseText, currentText, upstreamText, { relPath = '' } = {}) {
  const normBase = String(baseText ?? '').replace(/\r\n/g, '\n')
  const normCurrent = String(currentText ?? '').replace(/\r\n/g, '\n')
  const normUpstream = String(upstreamText ?? '').replace(/\r\n/g, '\n')

  if (normCurrent === normUpstream) {
    return { ok: true, status: 'unchanged', conflict: false, mergedText: normCurrent, conflicts: [] }
  }
  if (normCurrent === normBase) {
    return { ok: true, status: 'fast-forward', conflict: false, mergedText: normUpstream, conflicts: [] }
  }
  if (normUpstream === normBase) {
    return { ok: true, status: 'keep-current', conflict: false, mergedText: normCurrent, conflicts: [] }
  }

  const baseLines = normLines(normBase)
  const curLines = normLines(normCurrent)
  const upLines = normLines(normUpstream)

  const curHunks = diffLineOps(baseLines, curLines)
  const upHunks = diffLineOps(baseLines, upLines)

  const merged = []
  const conflicts = []
  let basePos = 0
  let ci = 0
  let ui = 0

  while (ci < curHunks.length || ui < upHunks.length) {
    const ch = ci < curHunks.length ? curHunks[ci] : null
    const uh = ui < upHunks.length ? upHunks[ui] : null

    if (ch && uh && hunksOverlap(ch, uh)) {
      if (ch.baseStart === uh.baseStart && ch.baseEnd === uh.baseEnd && sameLines(ch.lines, uh.lines)) {
        merged.push(...baseLines.slice(basePos, ch.baseStart))
        merged.push(...ch.lines)
        basePos = ch.baseEnd
        ci += 1
        ui += 1
        continue
      }
      const spanStart = Math.min(ch.baseStart, uh.baseStart)
      const spanEnd = Math.max(ch.baseEnd, uh.baseEnd)
      conflicts.push({
        baseStartLine: spanStart + 1,
        baseEndLine: Math.max(spanStart + 1, spanEnd),
        baseLines: baseLines.slice(spanStart, spanEnd),
        currentLines: ch.lines,
        upstreamLines: uh.lines,
      })
      basePos = spanEnd
      ci += 1
      ui += 1
      continue
    }

    const pickCurrent = Boolean(ch && (!uh || ch.baseStart < uh.baseStart || (ch.baseStart === uh.baseStart && ch.baseEnd <= uh.baseEnd)))
    const chosen = pickCurrent ? ch : uh
    if (chosen.baseStart > basePos) merged.push(...baseLines.slice(basePos, chosen.baseStart))
    merged.push(...chosen.lines)
    basePos = Math.max(basePos, chosen.baseEnd)
    if (pickCurrent) ci += 1
    else ui += 1
  }

  if (basePos < baseLines.length) merged.push(...baseLines.slice(basePos))

  if (conflicts.length > 0) {
    const codeSafe = isCodeLikePath(relPath)
    return {
      ok: false,
      status: 'conflict',
      conflict: true,
      codeSafe,
      // 严禁把冲突标记写进源码文件：保留用户现有工作副本原样
      mergedText: normCurrent,
      upstreamContent: normUpstream,
      conflicts,
    }
  }

  return {
    ok: true,
    status: 'merged',
    conflict: false,
    mergedText: merged.join('\n'),
    conflicts: [],
  }
}

/** 生成 `{target}.pf-conflict` 结构化冲突说明文档（不含污染源码的风险，供人或工具精确裁决）。 */
export function formatPfConflictArtifact({
  relPath,
  baseHash = null,
  currentHash = null,
  upstreamHash = null,
  conflicts = [],
  upstreamSidecarRel = `${relPath}.upstream`,
  conflictSidecarRel = `${relPath}.pf-conflict`,
  outOfTree = false,
  upstreamAbsPath = null,
  conflictAbsPath = null,
  diskAbsPath = null,
  now = new Date().toISOString(),
} = {}) {
  const upDisplay = upstreamAbsPath || upstreamSidecarRel
  const cfDisplay = conflictAbsPath || conflictSidecarRel
  const localDisplay = diskAbsPath || `.agents/skills/${relPath}`
  const payload = {
    schemaVersion: 1,
    file: relPath,
    recordedAt: now,
    status: 'pending-conflict',
    outOfTree,
    preservedLocalFile: true,
    conflictMarkersWrittenToTarget: false,
    upstreamSidecar: upstreamSidecarRel,
    conflictSidecar: conflictSidecarRel,
    hashes: {
      baseSha256: baseHash,
      currentSha256: currentHash,
      upstreamSha256: upstreamHash,
    },
    hunkCount: conflicts.length,
    hunks: conflicts.map((c, idx) => ({
      index: idx + 1,
      baseLinesRange: `${c.baseStartLine}-${c.baseEndLine}`,
      base: c.baseLines,
      local: c.currentLines,
      upstream: c.upstreamLines,
    })),
    resolutionSteps: [
      `对比保留的本地文件 ${localDisplay} 与上游新版 ${upDisplay}（详情见 ${cfDisplay}）：diff -u "${localDisplay}" "${upDisplay}"`,
      `手工融合后执行 node scripts/equip.mjs . --adopt-custom ${relPath}，或放弃本地改动执行 node scripts/equip.mjs . --restore ${relPath}（将自动清理仓外旁路并解除 pendingConflict）。`,
    ],
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 为 `equip.mjs` 执行单个已修改托管文件的三方升级判定，返回 merge 写盘或无标记冲突旁路方案。 */
export function resolveThreeWayEquipFile({
  rel, dest, srcBuf, srcSha, oldHash, diskHash, currentText, baseText, now,
  conflictDir = null, outOfTree = Boolean(conflictDir),
}) {
  const upstreamText = srcBuf.toString('utf8')
  const m3 = baseText != null
    ? merge3Text(baseText, currentText, upstreamText, { relPath: rel })
    : {
        ok: false,
        status: 'conflict',
        conflict: true,
        codeSafe: true,
        conflicts: [{
          baseStartLine: 1,
          baseEndLine: 1,
          baseLines: [],
          currentLines: currentText.split('\n').slice(0, 6),
          upstreamLines: upstreamText.split('\n').slice(0, 6),
        }],
      }
  if (m3.ok) {
    return { kind: 'merged', buf: Buffer.from(m3.mergedText, 'utf8') }
  }
  const useOutOfTree = Boolean(outOfTree && conflictDir)
  const upstreamFile = `${rel}.upstream`
  const conflictFile = `${rel}.pf-conflict`
  const upstreamDest = useOutOfTree ? join(conflictDir, upstreamFile) : `${dest}.upstream`
  const conflictDest = useOutOfTree ? join(conflictDir, conflictFile) : `${dest}.pf-conflict`
  const conflictBuf = Buffer.from(formatPfConflictArtifact({
    relPath: rel, baseHash: oldHash, currentHash: diskHash, upstreamHash: srcSha, conflicts: m3.conflicts,
    upstreamSidecarRel: upstreamFile, conflictSidecarRel: conflictFile,
    outOfTree: useOutOfTree,
    ...(useOutOfTree ? { upstreamAbsPath: upstreamDest, conflictAbsPath: conflictDest, diskAbsPath: dest } : {}),
    now,
  }), 'utf8')
  return {
    kind: 'conflict',
    writes: [
      { dest: upstreamDest, buf: srcBuf },
      { dest: conflictDest, buf: conflictBuf },
    ],
    pendingEntry: {
      recordedAt: now,
      baseSha256: oldHash,
      diskSha256: diskHash,
      upstreamSha256: srcSha,
      ...(useOutOfTree ? { outOfTree: true } : {}),
      upstreamFile,
      conflictFile,
    },
    conflictRecord: {
      path: rel,
      reason: 'merge3-conflict-preserved',
      baselineSha256: oldHash,
      diskSha256: diskHash,
      incomingSha256: srcSha,
      outOfTree: useOutOfTree,
      upstreamFile,
      conflictFile,
      ...(useOutOfTree ? {
        upstreamPath: upstreamDest,
        conflictPath: conflictDest,
        diffCommand: `diff -u "${dest}" "${upstreamDest}"`,
        adoptCommand: `node scripts/equip.mjs . --adopt-custom ${rel}`,
        restoreCommand: `node scripts/equip.mjs . --restore ${rel}`,
      } : {}),
    },
  }
}
