/**
 * verify-tools-render.mjs —— 从 `verify-tools.mjs` 抽离的 `sync` 与 `render` 子命令处理器。
 *
 * 接通 Wave 1 增量静态分析与 3 层 10 类图表证据抽取，并支持可选 `--telemetry-spans <path>`
 * 载入真实实测耗时 JSON 以按需激活 Tier 3 `waterfall`。
 */

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

import {
  ARCHITECTURE_MAP_REL,
  renderArchitectureMapAsync,
  renderArchitectureMapFromRepo,
  verifyArchitectureMapSync,
} from '../../lib/architecture-map.mjs'
import { EXIT } from '../../lib/exit-codes.mjs'
import { FEATURE_MAP_REL, prefillFeatureMapFromRepoMap } from '../../lib/feature-map.mjs'
import { gitRun, posixPath, readJsonSafe } from '../../lib/git.mjs'
import { generateRepoMap } from '../../dev-explore/scripts/repo-map.mjs'
import { guardExistingFeatureMapForWrite } from './verify-tools-audit.mjs'

export function splitCsv(raw) {
  if (!raw) return []
  const list = Array.isArray(raw) ? raw : [raw]
  return list.flatMap((v) => String(v ?? '').split(',')).map((s) => s.trim()).filter(Boolean)
}

export function normRelFile(repoRoot, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const rel = isAbsolute(s) ? relative(repoRoot, s) : s
  return posixPath(rel).replace(/^\.\//, '').replace(/^\/+/, '')
}

export async function resolveCurrentHead(repoRoot) {
  const res = await gitRun(repoRoot, ['rev-parse', 'HEAD'])
  return res.ok ? res.stdout.trim() : null
}

function emitRenderOut(opts, payload, lines) {
  if (opts.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
  else process.stdout.write(`${lines.join('\n')}\n`)
}

export async function handleSync(opts, roots) {
  const workRoot = roots.workTreeRoot
  if (!opts['dry-run']) {
    const guard = guardExistingFeatureMapForWrite(workRoot, opts)
    if (!guard.ok) return { exitCode: guard.exitCode, ok: false, code: 'BLOCKED_CORRUPT_FEATURE_MAP' }
  }
  const map = await generateRepoMap(workRoot, { writeFeatureMap: !opts['dry-run'] })
  const res = map.featureMapSync ?? prefillFeatureMapFromRepoMap(workRoot, map, { write: !opts['dry-run'] })
  const archRes = !opts['dry-run'] ? renderArchitectureMapFromRepo(workRoot) : null
  const payload = {
    ok: true,
    action: opts['dry-run'] ? 'sync-dry-run' : 'synced',
    path: FEATURE_MAP_REL,
    existed: res.existed,
    written: res.written,
    featureCount: res.featureMap.features.length,
    addedFeatures: res.addedFeatures,
    updatedFeatures: res.updatedFeatures,
    featureMap: res.featureMap,
    ...(archRes ? { architectureMap: { relPath: archRes.relPath, written: archRes.written, optedOut: Boolean(archRes.optedOut), bytes: archRes.bytes ?? 0 } } : {}),
  }
  emitRenderOut(opts, payload, [
    `[verify-tools sync] ${FEATURE_MAP_REL}: features=${payload.featureCount} (added=${res.addedFeatures}, updated=${res.updatedFeatures}, written=${res.written})`,
  ])
  return { exitCode: EXIT.OK, ...payload }
}

function loadTelemetrySpans(workRoot, rawPath) {
  const p = String(rawPath ?? '').trim()
  if (!p) return { ok: true, spans: null }
  const abs = isAbsolute(p) ? p : resolve(workRoot, p)
  if (!existsSync(abs)) {
    return {
      ok: false,
      exitCode: EXIT.ACTION,
      code: 'FILE_NOT_FOUND',
      message: `找不到 --telemetry-spans 文件：${p}`,
    }
  }
  const parsed = readJsonSafe(abs, 8 * 1024 * 1024)
  if (!parsed) {
    return {
      ok: false,
      exitCode: EXIT.USAGE,
      code: 'INVALID_FACT_FORMAT',
      message: `--telemetry-spans 不是合法 JSON：${p}`,
    }
  }
  const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.spans) ? parsed.spans : null)
  if (!list) {
    return {
      ok: false,
      exitCode: EXIT.USAGE,
      code: 'INVALID_FACT_FORMAT',
      message: `--telemetry-spans 须为 span 数组或包含 spans 数组的对象：${p}`,
    }
  }
  return { ok: true, spans: list }
}

export async function handleRender(opts, roots) {
  const workRoot = roots.workTreeRoot
  const outRel = typeof opts.out === 'string' && opts.out.trim() ? opts.out.trim() : ARCHITECTURE_MAP_REL
  if (opts.check) {
    const checkRes = verifyArchitectureMapSync(workRoot, { outRel })
    emitRenderOut(opts, checkRes, [
      checkRes.ok
        ? `[verify-tools render --check] OK (${checkRes.reason}): ${checkRes.relPath}`
        : `[verify-tools render --check] DRIFT (${checkRes.code}): ${checkRes.message}`,
    ])
    return { exitCode: checkRes.ok ? EXIT.OK : (checkRes.exitCode ?? EXIT.FACT), ...checkRes }
  }

  const loadedSpans = loadTelemetrySpans(workRoot, opts['telemetry-spans'])
  if (!loadedSpans.ok) {
    emitRenderOut(opts, loadedSpans, [`[verify-tools render] FAILED (${loadedSpans.code}): ${loadedSpans.message}`])
    process.stderr.write(`${loadedSpans.code}: ${loadedSpans.message}\n`)
    return { exitCode: loadedSpans.exitCode, ...loadedSpans }
  }

  const res = await renderArchitectureMapAsync(workRoot, {
    outRel,
    write: true,
    telemetrySpans: loadedSpans.spans,
  })
  emitRenderOut(opts, res, [
    res.ok
      ? `[verify-tools render] ${res.optedOut ? 'opted-out (no-architecture-html)' : `${res.relPath} (${res.bytes} bytes, written=${res.written}, tabs=${(res.activeTabs || []).map((t) => t.id).join(',') || 'architecture'})`}`
      : `[verify-tools render] FAILED: ${res.message}`,
  ])
  return { exitCode: res.ok ? EXIT.OK : (res.exitCode ?? EXIT.FACT), ...res }
}
