/**
 * merge3.mjs —— 跨代升级无破坏三方合并引擎。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 * 核心安全红线：
 *   - 当 `.mjs` 或其它程序代码/配置脚本发生双端冲突时，**严禁向源文件写入 `<<<<<<<` 冲突标记**；
 *   - 保留用户本地可用代码原样，同时产出 `{target}.upstream` 上游新本与 `{target}.pf-conflict` 结构化冲突详情，
 *     供 `equip.mjs` 在 `.pf-manifest.json` 登记 `pendingConflicts` 并返回非零冲突码。
 */

const CODE_SAFE_EXT_RE = /\.(?:m?js|cjs|tsx?|jsx?|mts|cts|json|sh|bash|ps1|bat|cmd|py|go|rs|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|ya?ml|toml)$/i

export const CONFLICT_MARKER_RE = /^(?:<<<<<<<|=======|>>>>>>>)\b/m

/** 判断路径是否属于严禁写入文本冲突标记的程序代码/结构化文件。 */
export function isCodeLikePath(relPath) {
  return CODE_SAFE_EXT_RE.test(String(relPath ?? '').trim())
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
  now = new Date().toISOString(),
} = {}) {
  const payload = {
    schemaVersion: 1,
    file: relPath,
    recordedAt: now,
    status: 'pending-conflict',
    preservedLocalFile: true,
    conflictMarkersWrittenToTarget: false,
    upstreamSidecar: upstreamSidecarRel,
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
      `对比保留的本地文件 ${relPath} 与上游新版 ${upstreamSidecarRel}，按需手工融合。`,
      `确认融合无误后删除 ${upstreamSidecarRel} 与 ${relPath}.pf-conflict，再运行 equip.mjs --adopt-custom ${relPath} 或 equip.mjs --restore ${relPath} 解除 pendingConflict。`,
    ],
  }
  return `${JSON.stringify(payload, null, 2)}\n`
}

/** 为 `equip.mjs` 执行单个已修改托管文件的三方升级判定，返回 merge 写盘或无标记冲突旁路方案。 */
export function resolveThreeWayEquipFile({
  rel, dest, srcBuf, srcSha, oldHash, diskHash, currentText, baseText, now,
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
  const conflictBuf = Buffer.from(formatPfConflictArtifact({
    relPath: rel, baseHash: oldHash, currentHash: diskHash, upstreamHash: srcSha, conflicts: m3.conflicts, now,
  }), 'utf8')
  return {
    kind: 'conflict',
    writes: [
      { dest: `${dest}.upstream`, buf: srcBuf },
      { dest: `${dest}.pf-conflict`, buf: conflictBuf },
    ],
    pendingEntry: {
      recordedAt: now,
      baseSha256: oldHash,
      diskSha256: diskHash,
      upstreamSha256: srcSha,
      upstreamFile: `${rel}.upstream`,
      conflictFile: `${rel}.pf-conflict`,
    },
    conflictRecord: {
      path: rel,
      reason: 'merge3-conflict-preserved',
      baselineSha256: oldHash,
      diskSha256: diskHash,
      incomingSha256: srcSha,
      upstreamFile: `${rel}.upstream`,
      conflictFile: `${rel}.pf-conflict`,
    },
  }
}
