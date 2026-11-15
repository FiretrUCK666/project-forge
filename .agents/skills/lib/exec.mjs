/**
 * exec.mjs —— 跨平台无弹窗安全子进程执行、Windows `.cmd`/`.bat` 解析、
 * POSIX 可执行位探测与进程树超时强杀原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 `git.mjs`、`platform-probe.mjs` 等套件共享。
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync, closeSync, constants, existsSync, mkdirSync, openSync,
  readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

const WIN_CMD_BATCH_EXT_RE = /\.(?:cmd|bat)$/i
const WIN_GIT_WRAPPER_RE = /[\\/]cmd[\\/]git\.exe$/i
const SAFE_BARE_ARG_RE = /^[A-Za-z0-9_./:=+-]+$/
const resolveCache = new Map()
const MAX_CACHE_ENTRIES = 128

/** 构造全平台防交互弹窗子进程环境变量。 */
export function buildNonInteractiveEnv(baseEnv = process.env, extra = {}) {
  return {
    ...baseEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    SSH_ASKPASS: '',
    SSH_ASKPASS_REQUIRE: 'never',
    GCM_INTERACTIVE: 'never',
    GH_PROMPT_DISABLED: '1',
    ...extra,
  }
}

function isExecutableFilePosix(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return false
    accessSync(filePath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isRegularFile(filePath) {
  try {
    return statSync(filePath).isFile()
  } catch {
    return false
  }
}

function winPathExts(env) {
  const raw = env?.PATHEXT || process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD'
  const list = raw.split(';').map((s) => s.trim()).filter(Boolean)
  for (const fallback of ['.exe', '.cmd', '.bat', '.com']) {
    if (!list.some((e) => e.toLowerCase() === fallback)) list.push(fallback)
  }
  return list
}

function probeWinCandidate(basePath, exts) {
  if (extname(basePath) && isRegularFile(basePath)) {
    return { path: basePath, isBatch: WIN_CMD_BATCH_EXT_RE.test(basePath) }
  }
  for (const ext of exts) {
    const candidate = `${basePath}${ext}`
    if (isRegularFile(candidate)) {
      return { path: candidate, isBatch: WIN_CMD_BATCH_EXT_RE.test(candidate) }
    }
  }
  if (isRegularFile(basePath)) {
    return { path: basePath, isBatch: WIN_CMD_BATCH_EXT_RE.test(basePath) }
  }
  return null
}

function unwrapWinGitWrapper(found) {
  if (!found || found.isBatch || !WIN_GIT_WRAPPER_RE.test(found.path)) return found
  const gitRoot = dirname(dirname(found.path))
  for (const arch of ['mingw64', 'clangarm64', 'mingw32']) {
    const archDir = join(gitRoot, arch)
    const realGit = join(archDir, 'bin', 'git.exe')
    if (isRegularFile(realGit)) {
      const extraDirs = [
        join(archDir, 'libexec', 'git-core'),
        join(archDir, 'bin'),
        join(gitRoot, 'usr', 'bin'),
      ].filter((d) => existsSync(d))
      return {
        path: realGit,
        isBatch: false,
        extraPathPrefix: extraDirs.join(';'),
        extraEnv: { PLINK_PROTOCOL: 'ssh' },
      }
    }
  }
  return found
}

function applyResolvedWinEnv(env, resolved) {
  if (!resolved?.extraPathPrefix && !resolved?.extraEnv) return env
  const next = { ...env }
  if (resolved.extraEnv) {
    for (const [k, v] of Object.entries(resolved.extraEnv)) {
      if (next[k] === undefined) next[k] = v
    }
  }
  if (resolved.extraPathPrefix) {
    const pathKey = 'PATH' in next ? 'PATH' : ('Path' in next ? 'Path' : 'PATH')
    const cur = String(next[pathKey] ?? '')
    const lowerCur = cur.toLowerCase()
    const firstPrefix = resolved.extraPathPrefix.split(';')[0]?.toLowerCase() ?? ''
    if (!firstPrefix || !lowerCur.includes(firstPrefix)) {
      next[pathKey] = cur ? `${resolved.extraPathPrefix};${cur}` : resolved.extraPathPrefix
    }
  }
  return next
}

/**
 * 解析命令真实可执行路径，兼容 Windows `.cmd`/`.bat` shim、Git-for-Windows 包装器直通
 * 与 POSIX `+x` 权限校验。找不到可执行目标返回 `null`（交由系统返回精确的 `ENOENT` / `EACCES`）。
 */
export function resolveExecutable(cmd, { cwd, env = process.env } = {}) {
  const name = String(cmd ?? '').trim()
  if (!name) return null
  const hasSep = name.includes('/') || name.includes('\\')

  if (process.platform === 'win32') {
    const exts = winPathExts(env)
    if (hasSep) {
      const abs = resolve(cwd || process.cwd(), name)
      return unwrapWinGitWrapper(probeWinCandidate(abs, exts))
    }
    const pathVal = env?.PATH ?? env?.Path ?? process.env.PATH ?? process.env.Path ?? ''
    const cacheKey = `win\0${pathVal}\0${exts.join(';')}\0${name}`
    if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey)

    let found = null
    for (const dir of pathVal.split(';')) {
      const cleanDir = dir.trim().replace(/^"+|"+$/g, '')
      if (!cleanDir) continue
      found = probeWinCandidate(join(cleanDir, name), exts)
      if (found) break
    }
    found = unwrapWinGitWrapper(found)
    if (resolveCache.size >= MAX_CACHE_ENTRIES) resolveCache.clear()
    resolveCache.set(cacheKey, found)
    return found
  }

  if (hasSep) {
    const abs = resolve(cwd || process.cwd(), name)
    return isExecutableFilePosix(abs) ? { path: abs, isBatch: false } : null
  }

  const pathVal = env?.PATH ?? process.env.PATH ?? ''
  const cacheKey = `posix\0${pathVal}\0${name}`
  if (resolveCache.has(cacheKey)) return resolveCache.get(cacheKey)

  let found = null
  for (const dir of pathVal.split(':')) {
    const cleanDir = dir.trim()
    if (!cleanDir) continue
    const candidate = join(cleanDir, name)
    if (isExecutableFilePosix(candidate)) {
      found = { path: candidate, isBatch: false }
      break
    }
  }
  if (resolveCache.size >= MAX_CACHE_ENTRIES) resolveCache.clear()
  resolveCache.set(cacheKey, found)
  return found
}

function quoteForCmdArg(arg) {
  const s = String(arg ?? '').replace(/[\r\n\0]+/g, ' ')
  if (s.length > 0 && SAFE_BARE_ARG_RE.test(s)) return s
  // 转义双引号内部前置反斜杠（Windows CommandLineToArgvW + cmd /s /c 规范）
  const escaped = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')
  return `"${escaped}"`
}

function buildWindowsCmdLine(filePath, args) {
  const quotedExe = `"${String(filePath).replace(/"/g, '')}"`
  const quotedArgs = (args ?? []).map(quoteForCmdArg)
  const inner = quotedArgs.length > 0 ? `${quotedExe} ${quotedArgs.join(' ')}` : quotedExe
  return `"${inner}"`
}

/**
 * 判断当前运行环境是否可安全使用 `detached: true`：
 * macOS Node < 20（libuv < 1.45）下 `detached: true` 会退回多线程裸 `fork()` 并触发 malloc/dyld 锁死锁；
 * Windows 走 `taskkill /T /F` 无需 `detached`。
 */
export function supportsSafeDetachedSpawn({
  platform = process.platform,
  nodeVersion = process.versions?.node,
} = {}) {
  if (platform === 'win32') return false
  const nodeMajor = Number(String(nodeVersion ?? '').split('.')[0]) || 0
  if (platform === 'darwin' && nodeMajor > 0 && nodeMajor < 20) return false
  return true
}

/** 超时或异常时按平台终止整个子进程树（仅以进程组启动时发 -pgid），防止孤儿进程驻留或误伤无关 pgid。 */
export function killProcessTree(child, useProcessGroup = true) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {
      try { child.kill() } catch { /* 已退出 */ }
    })
    return
  }
  const terminate = (sig) => {
    if (useProcessGroup) {
      try {
        process.kill(-child.pid, sig)
        return
      } catch { /* fallback to direct child kill */ }
    }
    try { child.kill(sig) } catch { /* 已退出 */ }
  }
  terminate('SIGTERM')
  const killTimer = setTimeout(() => terminate('SIGKILL'), 300)
  if (typeof killTimer.unref === 'function') killTimer.unref()
}

/**
 * 按平台解析外部命令调用参数（Windows `.cmd`/`.bat` 转经 `cmd.exe /d /s /c`，
 * Git-for-Windows 包装器直通真实二进制减少双重进程开销）。
 */
export function prepareExecInvocation(cmd, args = [], { cwd, env = process.env } = {}) {
  if (process.platform !== 'win32') {
    return { cmd, args, env, windowsVerbatimArguments: false }
  }
  const resolved = resolveExecutable(cmd, { cwd, env })
  if (resolved?.isBatch) {
    return {
      cmd: env.ComSpec || process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', buildWindowsCmdLine(resolved.path, args)],
      env,
      windowsVerbatimArguments: true,
    }
  }
  if (resolved?.path) {
    return {
      cmd: resolved.path,
      args,
      env: applyResolvedWinEnv(env, resolved),
      windowsVerbatimArguments: false,
    }
  }
  return { cmd, args, env, windowsVerbatimArguments: false }
}

/**
 * 安全执行外部命令（默认不经过 shell；Windows `.cmd`/`.bat` 自动经
 * `cmd.exe /d /s /c` + `windowsVerbatimArguments` 解析），并注入全套防弹窗环境变量。
 * 区分 cwd 不存在（`missingCwd`）与命令缺失（`missing`），永不抛出未捕获异常。
 */
export function execSafe(cmd, args = [], opts = {}) {
  return new Promise((done) => {
    if (opts.cwd && !existsSync(opts.cwd)) {
      done({
        ok: false,
        code: 1,
        missing: false,
        missingCwd: true,
        timedOut: false,
        stdout: opts.buffer ? Buffer.alloc(0) : '',
        stderr: `工作目录不存在：${opts.cwd}`,
      })
      return
    }
    const env = buildNonInteractiveEnv(process.env, opts.env ?? {})
    const isBuffer = Boolean(opts.buffer)
    const timeoutMs = opts.timeout ?? 15000
    const inv = prepareExecInvocation(cmd, args, { cwd: opts.cwd, env })
    const execCmd = inv.cmd
    const execArgs = inv.args
    const execOpts = {
      cwd: opts.cwd,
      encoding: isBuffer ? 'buffer' : 'utf8',
      timeout: timeoutMs,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      windowsHide: true,
      env: inv.env,
      ...(inv.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    }

    let forcedTimeout = false
    let treeTimer
    const child = execFile(execCmd, execArgs, execOpts, (error, stdout, stderr) => {
      if (treeTimer) clearTimeout(treeTimer)
      const timedOut = forcedTimeout || Boolean(error?.killed)
      const code = timedOut
        ? (typeof error?.code === 'number' ? error.code : 1)
        : (error === null ? 0 : (typeof error.code === 'number' ? error.code : 1))
      const outVal = isBuffer
        ? (Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ''))
        : (stdout ?? '').replace(/\r\n/g, '\n').trimEnd()
      const errVal = (Buffer.isBuffer(stderr) ? stderr.toString('utf8') : (stderr ?? ''))
        .replace(/\r\n/g, '\n')
        .trim()
      done({
        ok: !timedOut && error === null,
        code,
        missing: error?.code === 'ENOENT',
        timedOut,
        stdout: outVal,
        stderr: errVal,
      })
    })

    if (timeoutMs > 0) {
      treeTimer = setTimeout(() => {
        forcedTimeout = true
        killProcessTree(child)
      }, timeoutMs)
      if (typeof treeTimer.unref === 'function') treeTimer.unref()
    }

    if (child.stdin) child.stdin.on('error', () => {})
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input)
    } else if (child.stdin) {
      child.stdin.end()
    }
  })
}

/**
 * 执行项目自备验证命令字符串（来自 Dev Profile 或用户 --cmd）。
 * 超时时按平台杀整棵进程树（Windows taskkill /T /F，POSIX detached + 进程组 -pid）。
 */
export function execShellCommand(commandStr, cwd, opts = {}) {
  return new Promise((done) => {
    if (cwd && !existsSync(cwd)) {
      done({ ok: false, code: 1, timedOut: false, stdout: '', stderr: `工作目录不存在：${cwd}` })
      return
    }
    const env = buildNonInteractiveEnv(process.env, opts.env ?? {})
    // macOS Node 18 (libuv < 1.45) 下 detached: true 会退回非 fork-safe 裸 fork() 触发 malloc/dyld 死锁
    const canUseDetached = supportsSafeDetachedSpawn()
    const child = spawn(commandStr, {
      cwd,
      shell: true,
      detached: canUseDetached,
      stdio: opts.stdio ?? ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    })
    const outChunks = []
    const errChunks = []
    let timedOut = false
    let settled = false
    let exitedCode = null
    let closeGraceTimer = null
    const finish = (code, extraStderr = '') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (closeGraceTimer) clearTimeout(closeGraceTimer)
      const exitCode = timedOut ? 124 : (typeof code === 'number' ? code : 1)
      const errBuf = Buffer.concat(errChunks).toString('utf8').trimEnd()
      const stderr = extraStderr ? (errBuf ? `${errBuf}\n${extraStderr}` : extraStderr) : errBuf
      done({
        ok: exitCode === 0,
        code: exitCode,
        timedOut,
        stdout: Buffer.concat(outChunks).toString('utf8').trimEnd(),
        stderr,
      })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child, canUseDetached)
      closeGraceTimer = setTimeout(() => {
        try { child.stdout?.destroy() } catch { /* ignore */ }
        try { child.stderr?.destroy() } catch { /* ignore */ }
        finish(124)
      }, 1500)
      closeGraceTimer.unref?.()
    }, opts.timeout ?? 120000)
    timer.unref?.()

    child.stdout?.on('data', (d) => outChunks.push(d))
    child.stderr?.on('data', (d) => errChunks.push(d))
    child.on('exit', (code) => {
      exitedCode = code
      if (settled || closeGraceTimer) return
      closeGraceTimer = setTimeout(() => {
        try { child.stdout?.destroy() } catch { /* ignore */ }
        try { child.stderr?.destroy() } catch { /* ignore */ }
        finish(exitedCode)
      }, 1500)
      closeGraceTimer.unref?.()
    })
    child.on('error', (err) => finish(1, err.message))
    child.on('close', (code) => finish(typeof code === 'number' ? code : exitedCode))
  })
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/**
 * 基于 `O_EXCL` (`wx`) 原子文件互斥锁，支持陈旧死锁自动回收与超时拦截。
 */
export async function withFileLock(lockPath, fn, { timeoutMs = 15000, staleMs = 30000, pollMs = 25 } = {}) {
  const absLock = resolve(String(lockPath))
  mkdirSync(dirname(absLock), { recursive: true })
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const deadline = Date.now() + Math.max(50, Number(timeoutMs) || 15000)

  let acquired = false
  while (!acquired) {
    let fd
    try {
      fd = openSync(absLock, 'wx')
      try {
        writeFileSync(fd, `${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`, 'utf8')
      } finally {
        try { closeSync(fd) } catch { /* ignore */ }
      }
      acquired = true
      break
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
      let parsed = null
      let mtimeMs = 0
      try {
        const st = statSync(absLock)
        mtimeMs = st.mtimeMs
        const raw = readFileSync(absLock, 'utf8').trim()
        if (raw) parsed = JSON.parse(raw)
      } catch (readErr) {
        if (readErr?.code === 'ENOENT') continue
      }

      const stamp = Number(parsed?.createdAt) || mtimeMs || 0
      const expired = stamp > 0 && (Date.now() - stamp) >= staleMs
      const deadOwner = Boolean(parsed?.pid && parsed.pid !== process.pid && !isPidAlive(Number(parsed.pid)) && (Date.now() - stamp) >= 200)
      if (expired || deadOwner) {
        try {
          const recheck = readFileSync(absLock, 'utf8').trim()
          const curParsed = recheck ? JSON.parse(recheck) : null
          if (!parsed?.token || curParsed?.token === parsed.token) {
            unlinkSync(absLock)
            continue
          }
        } catch {
          try { unlinkSync(absLock) } catch { /* ignore */ }
          continue
        }
      }

      if (Date.now() >= deadline) {
        throw new Error(`LOCK_TIMEOUT: 无法在 ${timeoutMs}ms 内获取互斥锁 ${absLock}`)
      }
      await new Promise((r) => setTimeout(r, Math.max(5, Number(pollMs) || 25)))
    }
  }

  try {
    return await fn()
  } finally {
    try {
      const raw = readFileSync(absLock, 'utf8').trim()
      const cur = raw ? JSON.parse(raw) : null
      if (!cur?.token || cur.token === token) unlinkSync(absLock)
    } catch { /* already removed */ }
  }
}

/**
 * 为并行 Worktree 计算确定性隔离环境变量（槽位、端口偏移、测试端口与独立缓存目录）。
 */
export function computeWorktreeEnv({ mainRoot, gitDir, taskId = 'default', slotIndex, basePort = 18000 } = {}) {
  const cleanId = String(taskId ?? 'default').trim().replace(/[^a-zA-Z0-9._-]/g, '_') || 'default'
  const slot = slotIndex !== undefined && slotIndex !== null && Number.isInteger(Number(slotIndex)) && Number(slotIndex) >= 0
    ? Number(slotIndex)
    : (createHash('sha1').update(cleanId).digest()[0] % 128)
  const portOffset = slot * 100
  const port = Number(basePort) + portOffset
  const baseGitDir = gitDir || join(mainRoot || process.cwd(), '.git')
  const cacheDir = join(baseGitDir, 'project-forge-flow', 'cache', cleanId)
  mkdirSync(cacheDir, { recursive: true })
  return {
    PF_SLOT: String(slot),
    PF_PORT_OFFSET: String(portOffset),
    PF_PORT: String(port),
    PF_CACHE_DIR: cacheDir,
  }
}
