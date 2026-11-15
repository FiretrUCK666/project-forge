/**
 * signals.mjs —— 统一运行期信号总线（withFileLock 并发保护写入 `<gitCommonDir>/project-forge-govern/signals.jsonl`）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-flow、dev-review、dev-govern 共用。
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalPath, posixPath, readTextSafe, sha256Text, withFileLock } from './git.mjs'

export function inferSignalModule(fileRel) {
  const clean = posixPath(fileRel).replace(/^\.\//, '').trim()
  if (!clean) return 'repo'
  const parts = clean.split('/')
  if (parts.length <= 1) return 'root'
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0]
}

/**
 * 解析园艺信号与治理状态落盘目录（Git 仓写 `<gitCommonDir>/project-forge-govern`，非 Git 回退 tmpdir 哈希目录）。
 */
export function resolveGovernStateDir(mainRoot, gitDir = null, isGit = Boolean(gitDir)) {
  if (isGit) {
    return join(gitDir ?? join(mainRoot || process.cwd(), '.git'), 'project-forge-govern')
  }
  const hash = sha256Text(canonicalPath(mainRoot || process.cwd())).slice(0, 12)
  return join(tmpdir(), 'project-forge-govern', hash)
}

/** 读取并解析 `signals.jsonl`（跳过空行与半写入损坏行），兼容字符串目录或 roots 上下文对象。 */
export function readSignalsJsonl(stateDirOrRoots) {
  const stateDir = typeof stateDirOrRoots === 'string'
    ? stateDirOrRoots
    : resolveGovernStateDir(stateDirOrRoots?.mainRoot, stateDirOrRoots?.gitDir, stateDirOrRoots?.isGit ?? Boolean(stateDirOrRoots?.gitDir))
  const signalsPath = join(stateDir, 'signals.jsonl')
  if (!existsSync(signalsPath)) return { signalsPath, events: [] }
  const text = readTextSafe(signalsPath, 8 * 1024 * 1024) ?? ''
  const events = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      if (obj && typeof obj === 'object') events.push(obj)
    } catch { /* ignore corrupt partial line */ }
  }
  return { signalsPath, events }
}

/**
 * 使用 `withFileLock` 并发安全追加一条治理信号事件至 `signals.jsonl`（默认非阻塞，I/O 异常不阻断主流程）。
 */
export async function appendGovernSignal(opts = {}) {
  const {
    mainRoot,
    gitDir = null,
    isGit = Boolean(gitDir),
    stateDir: explicitStateDir,
    category = 'hygiene',
    module: explicitModule,
    pattern = '',
    severity = 'medium',
    source = 'workflow',
    file = '',
    line,
    message = '',
    note = '',
    taskId = null,
    round = null,
    verdict = null,
    meta = null,
    silent = true,
  } = opts ?? {}

  const stateDir = explicitStateDir ?? resolveGovernStateDir(mainRoot, gitDir, isGit)
  const signalsPath = join(stateDir, 'signals.jsonl')
  const lockPath = join(stateDir, 'signals.jsonl.lock')
  const fileRel = file ? posixPath(file) : ''
  const moduleName = String(explicitModule || '').trim() || inferSignalModule(fileRel)
  const rawMessage = String(message || note || '').trim()
  const rawPattern = String(pattern || '').trim()
  const finalPattern = rawPattern
    || rawMessage.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)
    || 'signal'

  const event = {
    ts: new Date().toISOString(),
    category: String(category || 'hygiene').trim().toLowerCase(),
    module: moduleName,
    pattern: finalPattern,
    severity: String(severity || 'medium').trim().toLowerCase(),
    source: String(source || 'workflow').trim().toLowerCase(),
    file: fileRel,
    ...(Number.isInteger(line) ? { line } : {}),
    message: (rawMessage || finalPattern).slice(0, 500),
    ...(taskId ? { taskId: String(taskId) } : {}),
    ...(round !== undefined && round !== null ? { round: Number(round) } : {}),
    ...(verdict ? { verdict: String(verdict) } : {}),
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  }

  try {
    await withFileLock(lockPath, () => {
      mkdirSync(stateDir, { recursive: true })
      appendFileSync(signalsPath, `${JSON.stringify(event)}\n`, 'utf8')
    }, { timeoutMs: 5000, staleMs: 15000, pollMs: 15 })
    return { ok: true, stateDir, signalsPath: posixPath(signalsPath), event }
  } catch (err) {
    if (!silent) throw err
    return { ok: false, stateDir, signalsPath: posixPath(signalsPath), event, error: err instanceof Error ? err.message : String(err) }
  }
}
