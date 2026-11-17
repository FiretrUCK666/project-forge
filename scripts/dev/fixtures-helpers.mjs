/**
 * fixtures-helpers.mjs —— 行为断言共享沙盒夹具与执行辅助原语。
 */

import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import { prepareExecInvocation } from '../../kit/skills/lib/exec.mjs'
import { textsOf, survey as runSurvey } from '../survey.mjs'
import { tryFastNodeCommit, tryFastNodeInitialCommit } from './fixtures-git-fast.mjs'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS = resolve(HERE, '..')
export const SKILL_ROOT = resolve(HERE, '..', '..')

export { textsOf }

export function initTestBackupDir() {
  if (!String(process.env.PF_NO_REAL_AUTH_PROBE ?? '').trim()) {
    process.env.PF_NO_REAL_AUTH_PROBE = '1'
  }
  if (!String(process.env.PF_BACKUP_DIR ?? '').trim()) {
    const testBackupRoot = mkdtempSync(join(tmpdir(), 'pf-test-bk-'))
    process.env.PF_BACKUP_DIR = testBackupRoot
    process.on('exit', () => {
      try {
        rmSync(testBackupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch { /* 留给系统清理 */ }
    })
  }
}

export function tmpProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-fix-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

export function rmTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch { /* 留给系统清理 */ }
}

export function existingKept(result, pid) {
  return (result.kept ?? []).some((p) => p.endsWith(`.tmp-${pid}`))
}

let lastFixtureTraceAt = 0

export function traceFixtureStage(stage, force = false) {
  const tf = process.env.PF_TRACE_FILE
  if (!tf) return
  const now = Date.now()
  if (force) lastFixtureTraceAt = 0
  else if (now - lastFixtureTraceAt < 250) return
  else lastFixtureTraceAt = now
  try { writeFileSync(tf, `${now} ${stage}\n`) } catch { /* ignore */ }
}

export function gitSync(cwd, args, opts = {}) {
  traceFixtureStage(`git:${args[0] ?? ''}`)
  const baseEnv = opts.env ?? process.env
  const targetCwd = opts.cwd ?? cwd
  const inv = prepareExecInvocation('git', args, { cwd: targetCwd, env: baseEnv })
  return spawnSync(inv.cmd, inv.args, {
    cwd: targetCwd,
    encoding: 'utf8',
    stdio: opts.stdio ?? (opts.encoding ? 'pipe' : 'ignore'),
    timeout: opts.timeout ?? 30000,
    windowsHide: true,
    ...opts,
    env: inv.env,
    ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  })
}

let emptyGitTplDir
let seedGitRepoDir
let seedBareGitDir
function getEmptyGitTemplateDir() {
  if (!emptyGitTplDir) {
    emptyGitTplDir = mkdtempSync(join(tmpdir(), 'pf-gtpl-'))
    process.on('exit', () => {
      try { rmSync(emptyGitTplDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ }
    })
  }
  return emptyGitTplDir
}

function getSeedGitDir() {
  if (!seedGitRepoDir) {
    const repo = mkdtempSync(join(tmpdir(), 'pf-gseed-'))
    gitSync(repo, ['init', '-q', `--template=${getEmptyGitTemplateDir()}`])
    appendFileSync(join(repo, '.git', 'config'), '[core]\n\tfsync = none\n[gc]\n\tauto = 0\n', 'utf8')
    seedGitRepoDir = join(repo, '.git')
    process.on('exit', () => {
      try { rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ }
    })
  }
  return seedGitRepoDir
}

export function gitInitBare(dir) {
  if (!seedBareGitDir) {
    const bare = mkdtempSync(join(tmpdir(), 'pf-gbare-'))
    gitSync(undefined, ['init', '--bare', '-q', `--template=${getEmptyGitTemplateDir()}`, bare])
    appendFileSync(join(bare, 'config'), '[core]\n\tfsync = none\n[gc]\n\tauto = 0\n', 'utf8')
    seedBareGitDir = bare
    process.on('exit', () => {
      try { rmSync(bare, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch { /* ignore */ }
    })
  }
  cpSync(seedBareGitDir, dir, { recursive: true })
}

export function gitCommitFast(dir, message, opts = {}) {
  traceFixtureStage('git:commit-fast')
  if (tryFastNodeCommit(dir, message, opts)) return
  const args = ['-c', 'core.fsync=none']
  if (opts.name) args.push('-c', `user.name=${opts.name}`)
  if (opts.email) args.push('-c', `user.email=${opts.email}`)
  if (Array.isArray(opts.files) && opts.files.length > 0) {
    gitSync(dir, [...args, 'add', ...opts.files])
    gitSync(dir, [...args, 'commit', '-qm', message])
  } else if (opts.updateOnly) {
    gitSync(dir, [...args, 'commit', '-qam', message])
  } else {
    gitSync(dir, [...args, 'add', '-A'])
    gitSync(dir, [...args, 'commit', '-qm', message])
  }
}

export function gitInit(dir, opts = {}) {
  cpSync(getSeedGitDir(), join(dir, '.git'), { recursive: true })
  if (opts.branch) {
    writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${opts.branch}\n`, 'utf8')
  }
  const cfgBlocks = []
  if (opts.name || opts.email) {
    cfgBlocks.push('[user]')
    if (opts.name) cfgBlocks.push(`\tname = ${opts.name}`)
    if (opts.email) cfgBlocks.push(`\temail = ${opts.email}`)
  }
  if (opts.origin) {
    cfgBlocks.push('[remote "origin"]', `\turl = ${opts.origin}`, '\tfetch = +refs/heads/*:refs/remotes/origin/*')
  }
  if (opts.upstream) {
    cfgBlocks.push('[remote "upstream"]', `\turl = ${opts.upstream}`, '\tfetch = +refs/heads/*:refs/remotes/upstream/*')
  }
  if (cfgBlocks.length > 0) {
    appendFileSync(join(dir, '.git', 'config'), `${cfgBlocks.join('\n')}\n`, 'utf8')
  }
  if (opts.commit !== false) {
    const cName = opts.name || 't'
    const cEmail = opts.email || 't@t.t'
    const msg = opts.message || 'init'
    if (tryFastNodeInitialCommit(dir, opts.branch, cName, cEmail, msg)) return
    gitSync(dir, ['-c', 'core.fsync=none', '-c', `user.name=${cName}`, '-c', `user.email=${cEmail}`, 'add', '-A'])
    gitSync(dir, ['-c', 'core.fsync=none', '-c', `user.name=${cName}`, '-c', `user.email=${cEmail}`, 'commit', '-qm', msg])
  }
}

export async function survey(dir, opts) {
  return runSurvey(dir, opts)
}

export function readDirRefs(dir) {
  const prefix = dir.slice(SKILL_ROOT.length + 1).replace(/\\/g, '/')
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => `${prefix}/${n}`)
  } catch { return [] }
}

const IN_PROCESS_CLI_SCRIPTS = new Set([
  'backup.mjs', 'compose-agents.mjs', 'equip.mjs', 'handoff.mjs', 'review.mjs', 'survey.mjs',
  'kit/skills/dev-explore/scripts/repo-map.mjs',
  'kit/skills/dev-flow/scripts/flow.mjs',
  'kit/skills/dev-flow/scripts/worktree-deps.mjs',
  'kit/skills/dev-plan/scripts/doc-plan.mjs',
  'kit/skills/dev-review/scripts/review-pack.mjs',
  'kit/skills/dev-govern/scripts/govern-audit.mjs',
])
const cliModCache = new Map()
let inProcessQueue = Promise.resolve()

function execCliInProcess(absPath, args, opts = {}) {
  traceFixtureStage(`cli:${basename(absPath)}:${args[0] ?? ''}`)
  const task = inProcessQueue.then(() => runCliInProcessUnlocked(absPath, args, opts))
  inProcessQueue = task.catch(() => {})
  return task
}

async function runCliInProcessUnlocked(absPath, args, opts = {}) {
  let mod = cliModCache.get(absPath)
  if (!mod) {
    mod = await import(pathToFileURL(absPath).href)
    cliModCache.set(absPath, mod)
  }
  if (typeof mod?.runCli !== 'function') return null

  const outChunks = []
  const errChunks = []
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  const capture = (bucket) => (chunk, enc, cb) => {
    if (typeof enc === 'function') { cb = enc; enc = undefined }
    bucket.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8'))
    if (typeof cb === 'function') cb()
    return true
  }
  const prevCwd = process.cwd()
  const changedCwd = Boolean(opts.cwd && resolve(opts.cwd) !== prevCwd)
  const savedEnv = new Map()
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      savedEnv.set(k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined)
      if (v === undefined || v === null) delete process.env[k]
      else process.env[k] = String(v)
    }
  }
  process.stdout.write = capture(outChunks)
  process.stderr.write = capture(errChunks)
  let status = 0
  try {
    if (changedCwd) process.chdir(opts.cwd)
    status = await Promise.resolve(mod.runCli([...args]))
  } catch (err) {
    errChunks.push(Buffer.from(err instanceof Error ? `${err.stack || err.message}\n` : `${String(err)}\n`, 'utf8'))
    status = 1
  } finally {
    if (changedCwd) process.chdir(prevCwd)
    for (const [k, prev] of savedEnv.entries()) {
      if (prev === undefined) delete process.env[k]
      else process.env[k] = prev
    }
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
  return {
    status: typeof status === 'number' ? status : 0,
    stdout: Buffer.concat(outChunks).toString('utf8'),
    stderr: Buffer.concat(errChunks).toString('utf8'),
  }
}

export async function runNode(script, args, opts = {}) {
  if (!opts.input && IN_PROCESS_CLI_SCRIPTS.has(script)) {
    const inProc = await execCliInProcess(join(SCRIPTS, script), args, opts)
    if (inProc) return inProc
  }
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    ...opts,
  })
}

export async function runAbsAsync(scriptRel, args, opts = {}) {
  const norm = scriptRel.replace(/\\/g, '/')
  if (!opts.input && (IN_PROCESS_CLI_SCRIPTS.has(norm) || IN_PROCESS_CLI_SCRIPTS.has(norm.replace(/^scripts\//, '')))) {
    const inProc = await execCliInProcess(join(SKILL_ROOT, scriptRel), args, opts)
    if (inProc) return inProc
  }
  return spawnSync(process.execPath, [join(SKILL_ROOT, scriptRel), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    ...opts,
  })
}

export function runAbs(scriptRel, args, opts = {}) {
  return spawnSync(process.execPath, [join(SKILL_ROOT, scriptRel), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    ...opts,
  })
}

let preflightLib
export async function loadPreflight() {
  if (preflightLib === undefined) preflightLib = await import('./preflight.mjs')
  return preflightLib
}

export function createTempHookEnv(extra = {}) {
  return { ...process.env, ...extra }
}

export function hasFile(root, rel) {
  return existsSync(join(root, rel))
}

/**
 * 给某个任务发一枚审查令牌，供夹具调用 `review-pack record --review-token`。
 *
 * 夹具不该自己造令牌字面量：令牌是「由 flow next 现场签发」的东西，夹具绕过签发点
 * 直接编一个，测出来的就不是真实链路。这里走与 `flow next` 同一个签发函数。
 *
 * `round` 不传时取「下一个轮次」，与 `flow next` 的算法一致。
 */
export async function issueTokenFor(mainRoot, taskId, round) {
  const { readTaskLedger, writeTaskLedger, ensureReviewToken } = await import('../../kit/skills/lib/ledger.mjs')
  const ledger = readTaskLedger(mainRoot, taskId)
  if (!ledger) throw new Error(`找不到任务账本：${taskId}`)
  const effectiveRound = round ?? ((ledger.rounds ?? []).length + 1)
  const { token } = ensureReviewToken(mainRoot, ledger, effectiveRound)
  // ensureReviewToken 可能已写盘；这里再读一次保证调用方拿到的是落盘后的账本
  void writeTaskLedger
  return token
}
