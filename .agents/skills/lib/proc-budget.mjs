/**
 * proc-budget.mjs —— 零依赖进程并发预算与低优先级调度原语。
 *
 * 默认在多核主机上为前台交互至少预留 2 个逻辑核（1-2 核环境安全退化为 1），
 * 同时允许调用方通过 `--jobs` 显式覆盖并发度，并将后台 worker 降级至 `PRIORITY_BELOW_NORMAL`
 * 且安全吞掉受限容器或进程瞬态退出异常。
 */

import os from 'node:os'

export const DEFAULT_RESERVED_CORES = 2

function detectCpuCount(cpuCount) {
  if (Number.isFinite(cpuCount) && cpuCount >= 1) return Math.floor(cpuCount)
  const avail = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : (Array.isArray(os.cpus?.()) ? os.cpus().length : 1)
  return Math.max(1, Math.floor(Number(avail) || 1))
}

function normalizeCap(cap) {
  if (cap === Infinity || cap === undefined || cap === null) return Infinity
  const n = Number(cap)
  if (!Number.isFinite(n)) return Infinity
  return Math.max(1, Math.floor(n))
}

function parsePositiveInt(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return null
  return Math.floor(n)
}

/**
 * 计算后台 worker 安全并发度：
 * - 显式传入合法正整数 `requestedJobs` 时，优先尊重 `--jobs`（仅受 `cap` 约束）；
 * - 否则按 `max(1, min(cap, cpuCount - reservedCores))` 留出前台余量。
 */
export function resolveWorkerConcurrency({
  requestedJobs = null,
  cap = Infinity,
  reservedCores = DEFAULT_RESERVED_CORES,
  cpuCount,
} = {}) {
  const effectiveCap = normalizeCap(cap)
  const explicit = parsePositiveInt(requestedJobs)
  if (explicit !== null) {
    return Math.max(1, Math.min(explicit, effectiveCap))
  }
  const totalCores = detectCpuCount(cpuCount)
  const reserved = Number.isFinite(reservedCores) && reservedCores >= 0
    ? Math.floor(reservedCores)
    : DEFAULT_RESERVED_CORES
  const budgeted = Math.max(1, totalCores - reserved)
  return Math.max(1, Math.min(effectiveCap, budgeted))
}

/**
 * 将目标进程降至 `PRIORITY_BELOW_NORMAL`（默认当前进程）；
 * 对非法 PID、进程已退出（ESRCH）或容器权限受限（EPERM/EACCES）一律安全降级返回 `{ ok: false }`，绝不抛错。
 */
export function applyLowPriority(
  pid = process.pid,
  { priority = os.constants?.priority?.PRIORITY_BELOW_NORMAL ?? 10 } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: false, pid, code: 'EINVAL' }
  }
  const effectivePriority = Number.isFinite(priority)
    ? Math.trunc(priority)
    : (os.constants?.priority?.PRIORITY_BELOW_NORMAL ?? 10)
  try {
    os.setPriority(pid, effectivePriority)
    return { ok: true, pid, priority: effectivePriority }
  } catch (err) {
    return {
      ok: false,
      pid,
      code: (err && typeof err === 'object' && typeof err.code === 'string') ? err.code : 'ERR_SET_PRIORITY',
    }
  }
}
