/**
 * shared.mjs —— 研发工作流内置技能套件的自包含基础设施。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 dev-explore、dev-plan、dev-flow 共用。
 * 不引用套件目录之外的任何仓库文件。
 */

import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync, mkdirSync, readdirSync, readFileSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIKELY_DEFAULT_BRANCHES = Object.freeze([
  'main', 'master', 'trunk', 'develop', 'default', 'development',
])

export const PACKAGE_LOCKFILES = Object.freeze([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock',
  'bun.lock', 'bun.lockb', 'poetry.lock', 'uv.lock', 'Cargo.lock',
])

let atomicCounter = 0

// ── 基础路径与文件工具 ────────────────────────────────────────────────

/** 路径统一归一化为正斜杠，避免跨平台集合比对失配。 */
export function posixPath(p) {
  return String(p ?? '').replace(/\\/g, '/')
}

/** 比较两个路径是否指向同一位置（优先使用真实路径）。 */
export function samePath(a, b) {
  try {
    return realpathSync.native(resolve(a)) === realpathSync.native(resolve(b))
  } catch {
    return resolve(a).toLowerCase() === resolve(b).toLowerCase()
  }
}

/** 判断当前模块是否作为 CLI 入口直接执行（兼容 symlink 与 junction）。 */
export function isMainModule(metaUrl, argv1) {
  if (typeof argv1 !== 'string' || argv1 === '') return false
  const target = fileURLToPath(metaUrl)
  try {
    if (resolve(argv1) === resolve(target)) return true
  } catch { /* 路径非法时转入真实路径比较 */ }
  const real = (p) => {
    try { return realpathSync.native(p) } catch { return undefined }
  }
  const a = real(argv1)
  const b = real(target)
  return a !== undefined && b !== undefined && a === b
}

/** 安全读取 UTF-8 文本文件（去掉 BOM、统一换行）；不可读或二进制返回 undefined。 */
export function readTextSafe(filePath, maxBytes = 512 * 1024) {
  try {
    const st = statSync(filePath)
    if (!st.isFile() || st.size > maxBytes) return undefined
    const buf = readFileSync(filePath)
    if (buf.subarray(0, 4096).includes(0)) return undefined
    return buf.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  } catch {
    return undefined
  }
}

/** 安全读取 JSON 文件；失败返回 undefined。 */
export function readJsonSafe(filePath) {
  const text = readTextSafe(filePath)
  if (text === undefined) return undefined
  try { return JSON.parse(text) } catch { return undefined }
}

/** 原子写入文本文件：先写同目录临时文件再改名，失败清理残留。 */
export function writeAtomic(filePath, content) {
  const abs = resolve(filePath)
  mkdirSync(dirname(abs), { recursive: true })
  atomicCounter += 1
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}-${atomicCounter}`
  writeFileSync(tmp, String(content ?? ''), 'utf8')
  try {
    renameSync(tmp, abs)
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 清理失败不影响抛出原始异常 */ }
    throw error
  }
}

/** 原子写入格式化 JSON 文件。 */
export function writeJsonAtomic(filePath, data) {
  writeAtomic(filePath, `${JSON.stringify(data, null, 2)}\n`)
}

/** 计算文本 SHA256（hex）。 */
export function sha256Text(text) {
  return createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex')
}

/** 计算文件 SHA256（hex）；不存在或不可读返回 null。 */
export function sha256File(filePath) {
  try {
    const st = statSync(filePath)
    if (!st.isFile()) return null
    return createHash('sha256').update(readFileSync(filePath)).digest('hex')
  } catch {
    return null
  }
}

// ── 安全子进程封装 ────────────────────────────────────────────────────

/**
 * 使用 execFile 安全执行命令（不经过 shell），并注入防凭据弹窗环境变量。
 * 返回 { ok, code, missing, timedOut, stdout, stderr }，永不抛出未捕获异常。
 */
export function execSafe(cmd, args = [], opts = {}) {
  return new Promise((done) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      ...(opts.env ?? {}),
    }
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout ?? 15000,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
      windowsHide: true,
      env,
    }, (error, stdout, stderr) => {
      const code = error === null
        ? 0
        : (typeof error.code === 'number' ? error.code : 1)
      done({
        ok: error === null,
        code,
        missing: error?.code === 'ENOENT',
        timedOut: Boolean(error?.killed),
        stdout: (stdout ?? '').replace(/\r\n/g, '\n').trimEnd(),
        stderr: (stderr ?? '').replace(/\r\n/g, '\n').trim(),
      })
    })

    // 防止子进程提前退出导致 stdin.end 触发未捕获 EPIPE
    if (child.stdin) child.stdin.on('error', () => {})
    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input)
    } else if (child.stdin) {
      child.stdin.end()
    }
  })
}

/** 安全执行 git 命令（保留路径 UTF-8 输出）。 */
export function gitRun(cwd, args, opts = {}) {
  return execSafe('git', ['-c', 'core.quotepath=false', ...args], { ...opts, cwd })
}

/**
 * 执行项目自备验证命令字符串（来自 Dev Profile 或用户 --cmd）。
 * 返回 { ok, code, stdout, stderr, timedOut }。
 */
export function execShellCommand(commandStr, cwd, opts = {}) {
  return new Promise((done) => {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      ...(opts.env ?? {}),
    }
    const child = spawn(commandStr, {
      cwd,
      shell: true,
      windowsHide: true,
      env,
    })
    const outChunks = []
    const errChunks = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* 进程可能已退出 */ }
    }, opts.timeout ?? 120000)

    child.stdout?.on('data', (d) => outChunks.push(d))
    child.stderr?.on('data', (d) => errChunks.push(d))
    child.on('error', (err) => {
      clearTimeout(timer)
      done({
        ok: false,
        code: 1,
        timedOut,
        stdout: Buffer.concat(outChunks).toString('utf8').trimEnd(),
        stderr: err.message,
      })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const exitCode = timedOut ? 124 : (typeof code === 'number' ? code : 1)
      done({
        ok: exitCode === 0,
        code: exitCode,
        timedOut,
        stdout: Buffer.concat(outChunks).toString('utf8').trimEnd(),
        stderr: Buffer.concat(errChunks).toString('utf8').trimEnd(),
      })
    })
  })
}

// ── 仓库根与跨分支共享账本 ─────────────────────────────────────────────

/**
 * 解析当前目录所属的 Git 仓库边界。
 * 无论在主仓根还是在 .worktrees/impl-* 中调用，mainRoot 永远指向主仓根，
 * 确保 .worktrees/.state/ 账本跨分支与跨工作树共用。
 */
export async function resolveRepoRoots(cwd = process.cwd()) {
  const absCwd = resolve(cwd)
  const res = await gitRun(absCwd, [
    'rev-parse', '--is-inside-work-tree', '--show-toplevel', '--git-common-dir', '--is-bare-repository',
  ])
  if (!res.ok || !res.stdout) {
    return {
      isGit: false,
      cwd: absCwd,
      mainRoot: absCwd,
      workTreeRoot: absCwd,
      gitDir: null,
      isWorktree: false,
      isBare: false,
    }
  }
  const lines = res.stdout.split('\n').map((l) => l.trim())
  const inside = lines[0] === 'true'
  const topLevel = lines[1] ? resolve(lines[1]) : absCwd
  const commonDir = lines[2] ? resolve(absCwd, lines[2]) : join(topLevel, '.git')
  const isBare = lines[3] === 'true'
  if (!inside || isBare) {
    return {
      isGit: isBare,
      cwd: absCwd,
      mainRoot: absCwd,
      workTreeRoot: absCwd,
      gitDir: commonDir,
      isWorktree: false,
      isBare,
    }
  }
  const mainRoot = basename(commonDir).toLowerCase() === '.git' ? dirname(commonDir) : topLevel
  return {
    isGit: true,
    cwd: absCwd,
    mainRoot,
    workTreeRoot: topLevel,
    gitDir: commonDir,
    isWorktree: !samePath(mainRoot, topLevel),
    isBare: false,
  }
}

/** 确保 .worktrees/ 已被 Git 忽略（不触碰已跟踪的 .gitignore，优先写本地 .git/info/exclude）。 */
export async function ensureWorktreesIgnored(mainRoot, gitDir) {
  const check = await gitRun(mainRoot, ['check-ignore', '-q', '.worktrees'])
  if (check.ok) return { ok: true, method: 'existing' }
  const actualGitDir = gitDir ?? join(mainRoot, '.git')
  const excludeFile = join(actualGitDir, 'info', 'exclude')
  try {
    mkdirSync(dirname(excludeFile), { recursive: true })
    const cur = readTextSafe(excludeFile) ?? ''
    const hasRule = cur.split('\n').some((l) => l.trim() === '.worktrees' || l.trim() === '.worktrees/')
    if (!hasRule) {
      const next = cur.length > 0 && !cur.endsWith('\n') ? `${cur}\n.worktrees/\n` : `${cur}.worktrees/\n`
      writeAtomic(excludeFile, next)
    }
    return { ok: true, method: 'git-info-exclude' }
  } catch {
    return { ok: false, method: 'unignored' }
  }
}

/** 校验并清洗 taskId，防止路径穿越。 */
export function sanitizeTaskId(taskId) {
  const raw = String(taskId ?? '').trim()
  if (!raw || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(raw) || raw.includes('..')) {
    throw new Error(`非法的 taskId：「${raw}」（仅允许字母、数字、点、下划线、连字符）`)
  }
  return raw
}

/** 将输入文本规范化为 kebab-case slug。 */
export function slugify(text, fallback = 'task') {
  const cleaned = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
  return cleaned || fallback
}

/** 返回任务账本绝对路径：.worktrees/.state/tasks/<taskId>.json */
export function taskLedgerPath(mainRoot, taskId) {
  return join(mainRoot, '.worktrees', '.state', 'tasks', `${sanitizeTaskId(taskId)}.json`)
}

/** 构建符合跨模块统一契约的默认任务账本结构。 */
export function createDefaultLedger(partial = {}) {
  const taskId = sanitizeTaskId(partial.taskId)
  return {
    taskId,
    slug: partial.slug ?? slugify(taskId),
    caseType: partial.caseType ?? 3,
    tier: partial.tier ?? 2,
    isolation: partial.isolation ?? 'worktree',
    role: partial.role ?? 'local-only',
    branch: partial.branch ?? null,
    baseBranch: partial.baseBranch ?? 'main',
    baseSha: partial.baseSha ?? null,
    worktreePath: partial.worktreePath ?? null,
    reviewWorktreePath: partial.reviewWorktreePath ?? null,
    todoFile: partial.todoFile ?? null,
    specFile: partial.specFile ?? null,
    prdFile: partial.prdFile ?? null,
    linkedIssues: Array.isArray(partial.linkedIssues) ? partial.linkedIssues : [],
    prNumber: partial.prNumber ?? null,
    finalized: Boolean(partial.finalized),
    finalizedHead: partial.finalizedHead ?? null,
    verifiedHead: partial.verifiedHead ?? null,
    verifiedCmd: partial.verifiedCmd ?? null,
    implementerId: partial.implementerId ?? null,
    reviewerId: partial.reviewerId ?? null,
    rounds: Array.isArray(partial.rounds) ? partial.rounds : [],
    status: partial.status ?? 'started',
    ...partial,
    taskId,
  }
}

export function readTaskLedger(mainRoot, taskId) {
  return readJsonSafe(taskLedgerPath(mainRoot, taskId))
}

export function writeTaskLedger(mainRoot, ledger) {
  const p = taskLedgerPath(mainRoot, ledger.taskId)
  const stamped = {
    ...createDefaultLedger(ledger),
    updatedAt: new Date().toISOString(),
  }
  if (!stamped.createdAt) stamped.createdAt = stamped.updatedAt
  writeJsonAtomic(p, stamped)
  return p
}

export function listTaskLedgers(mainRoot) {
  const dir = join(mainRoot, '.worktrees', '.state', 'tasks')
  if (!existsSync(dir)) return []
  const out = []
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const data = readJsonSafe(join(dir, name))
      if (data && data.taskId) out.push(data)
    }
  } catch { /* 读取失败返回已收集部分 */ }
  return out
}

// ── AGENTS.md Dev Profile 与项目风格解析 ───────────────────────────────

function stripWrapQuotes(val) {
  const s = String(val ?? '').trim()
  if ((s.startsWith('`') && s.endsWith('`'))
    || (s.startsWith('"') && s.endsWith('"'))
    || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).trim()
  }
  return s
}

function parseListValue(raw) {
  const s = String(raw ?? '').trim()
  if (!s || /^\[?\s*\]?$/.test(s)) return []
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  return inner.split(',')
    .map((x) => stripWrapQuotes(x))
    .filter((x) => x && !/^<.*>$/.test(x))
}

function isPlaceholderVal(val) {
  const s = String(val ?? '').trim()
  return !s || /^<[^>]+>$/.test(s) || /^#/.test(s)
}

/**
 * 解析 AGENTS.md 中的 Dev Profile（quick-test / full-test / merge-gate / high-risk / do-not-edit），
 * 同时兼容从「高风险路径」表格、「构建与验证」代码块与项目清单提取兜底值。
 */
export function parseAgentsProfile(repoRoot) {
  const agentsPath = join(repoRoot, 'AGENTS.md')
  const text = readTextSafe(agentsPath)
  const profile = {
    hasAgents: text !== undefined,
    quickTest: undefined,
    fullTest: undefined,
    mergeGate: undefined,
    highRisk: [],
    doNotEdit: [],
    mergeAuthority: 'reviewer',
  }

  if (text !== undefined) {
    const lines = text.split('\n')
    let activeListKey = null
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      const trimmed = line.trim()

      // 若处于多行 YAML 列表下，吸收缩进列表项
      if (activeListKey) {
        if (/^[-*]\s+/.test(trimmed) && /^\s+[-*]/.test(line)) {
          const item = stripWrapQuotes(trimmed.replace(/^[-*]\s+/, '').replace(/\s+#.*$/, ''))
          if (item && !isPlaceholderVal(item)) profile[activeListKey].push(item)
          continue
        }
        if (trimmed !== '' && !trimmed.startsWith('#')) {
          activeListKey = null
        } else {
          continue
        }
      }

      const kv = /^(?:[-*]\s+)?(quick-test|full-test|merge-gate|high-risk|do-not-edit)\s*:\s*(.*)$/i.exec(trimmed)
      if (!kv) continue
      const key = kv[1].toLowerCase()
      const rawVal = kv[2].replace(/\s+#[^`"'"]*$/, '').trim()

      if (key === 'quick-test' || key === 'full-test' || key === 'merge-gate') {
        const cleaned = stripWrapQuotes(rawVal)
        if (!isPlaceholderVal(cleaned)) {
          if (key === 'quick-test') profile.quickTest = cleaned
          else if (key === 'full-test') profile.fullTest = cleaned
          else profile.mergeGate = cleaned
        }
        continue
      }

      const targetProp = key === 'high-risk' ? 'highRisk' : 'doNotEdit'
      if (rawVal === '') {
        activeListKey = targetProp
      } else {
        for (const item of parseListValue(rawVal)) {
          profile[targetProp].push(item)
        }
      }
    }

    // 兜底解析「高风险路径」Markdown 表格第一列
    if (profile.highRisk.length === 0) {
      const hrStart = lines.findIndex((l) => /^##\s+高风险路径/.test(l))
      if (hrStart >= 0) {
        for (let i = hrStart + 1; i < lines.length; i += 1) {
          if (/^##\s+/.test(lines[i])) break
          const row = /^\|\s*`([^`]+)`\s*\|/.exec(lines[i].trim())
          if (row && !isPlaceholderVal(row[1])) profile.highRisk.push(row[1].trim())
        }
      }
    }

    if (/merge-authority\s*:\s*human/i.test(text)) {
      profile.mergeAuthority = 'human'
    }
  }

  profile.highRisk = [...new Set(profile.highRisk)]
  profile.doNotEdit = [...new Set(profile.doNotEdit)]
  if (profile.highRisk.length === 0) {
    profile.highRisk = ['.github/workflows/', 'AGENTS.md']
  }

  const fallback = detectEcosystemCommands(repoRoot)
  if (!profile.quickTest) profile.quickTest = fallback.quickTest
  if (!profile.fullTest) profile.fullTest = fallback.fullTest ?? fallback.quickTest
  if (!profile.mergeGate) profile.mergeGate = profile.fullTest ?? profile.quickTest
  profile.detectedCommands = fallback
  return profile
}

/** 从项目清单嗅探测试与门禁命令，作为 Dev Profile 缺失时的安全兜底。 */
export function detectEcosystemCommands(repoRoot) {
  const cmds = { quickTest: undefined, fullTest: undefined, lint: undefined, build: undefined, kinds: [] }
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  if (pkg) {
    cmds.kinds.push('node')
    const pm = existsSync(join(repoRoot, 'pnpm-lock.yaml')) ? 'pnpm'
      : existsSync(join(repoRoot, 'yarn.lock')) ? 'yarn'
        : existsSync(join(repoRoot, 'bun.lock')) || existsSync(join(repoRoot, 'bun.lockb')) ? 'bun' : 'npm'
    const run = pm === 'npm' ? 'npm run' : pm
    const scripts = pkg.scripts ?? {}
    if (scripts.test && !/no test specified/i.test(String(scripts.test))) {
      cmds.quickTest = pm === 'npm' ? 'npm test' : `${pm} test`
    }
    if (scripts.check) cmds.fullTest = `${run} check`
    else if (scripts.verify) cmds.fullTest = `${run} verify`
    else if (scripts.ci) cmds.fullTest = `${run} ci`
    if (scripts.lint) cmds.lint = `${run} lint`
    if (scripts.build) cmds.build = `${run} build`
  }
  if (existsSync(join(repoRoot, 'pyproject.toml')) || existsSync(join(repoRoot, 'pytest.ini'))) {
    cmds.kinds.push('python')
    if (existsSync(join(repoRoot, 'tests')) || existsSync(join(repoRoot, 'test'))
      || existsSync(join(repoRoot, 'pytest.ini'))) {
      cmds.quickTest ??= 'pytest'
    }
  }
  if (existsSync(join(repoRoot, 'Cargo.toml'))) {
    cmds.kinds.push('rust')
    cmds.quickTest ??= 'cargo test'
    cmds.build ??= 'cargo build'
  }
  if (existsSync(join(repoRoot, 'go.mod'))) {
    cmds.kinds.push('go')
    cmds.quickTest ??= 'go test ./...'
    cmds.build ??= 'go build ./...'
  }
  const makefile = readTextSafe(join(repoRoot, 'Makefile'))
  if (makefile) {
    if (/^test:/m.test(makefile)) cmds.quickTest ??= 'make test'
    if (/^check:/m.test(makefile)) cmds.fullTest ??= 'make check'
  }
  // 兜底探测 Node 内置 test 目录
  if (!cmds.quickTest && existsSync(join(repoRoot, 'test'))) {
    cmds.quickTest = 'node --test'
  }
  return cmds
}

/** 探测项目格式、默认分支、提交风格与是否启用了四层 docs/ 体系。 */
export async function detectProjectConventions(repoRoot) {
  const [originHeadRes, branchRes, initDefRes, logRes] = await Promise.all([
    gitRun(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    gitRun(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
    gitRun(repoRoot, ['config', '--get', 'init.defaultbranch']),
    gitRun(repoRoot, ['log', '--format=%s', '-n', '20']),
  ])

  let originHead
  if (originHeadRes.ok && originHeadRes.stdout) {
    const m = /^origin\/(.+)$/.exec(originHeadRes.stdout.trim())
    originHead = m ? m[1] : originHeadRes.stdout.trim()
  }
  const curBranch = branchRes.ok ? branchRes.stdout.trim() : undefined
  const initDef = initDefRes.ok ? initDefRes.stdout.trim() : undefined
  const defaultBranch = originHead
    || (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch) ? curBranch : undefined)
    || initDef
    || 'main'

  const subjects = logRes.ok && logRes.stdout
    ? logRes.stdout.split('\n').filter(Boolean)
    : []
  const convRe = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s+\S/i
  const convCount = subjects.filter((s) => convRe.test(s)).length
  const commitStyle = subjects.length > 0 && convCount > subjects.length / 2 ? 'conventional' : 'plain'

  const hasDocsSystem = existsSync(join(repoRoot, 'docs', 'TDD.md'))
    || existsSync(join(repoRoot, 'docs', 'specs'))
    || existsSync(join(repoRoot, 'docs', 'todo'))
    || existsSync(join(repoRoot, 'docs', 'prd'))

  return { defaultBranch, commitStyle, hasDocsSystem }
}

// ── GitHub 仓库归一化与五态身份判定 ────────────────────────────────────

/** 将 GitHub 地址归一为保留原始大小写的 owner/name（用于 API 调用）。 */
export function githubRepoFull(value) {
  const s = String(value ?? '').trim()
  if (!/github\.com[:/]/i.test(s)) return undefined
  let norm = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
  norm = norm.replace(/^[^@/]*@/, '')
  norm = norm.replace(/^[^/:]+:/, '')
  norm = norm.replace(/^[^/]*\.[^/]*\//, '')
  norm = norm.replace(/\.git$/i, '').replace(/\/+$/, '')
  return /^[^/\s]+\/[^/\s]+$/.test(norm) ? norm : undefined
}

/** 将 GitHub 地址归一为小写 owner/name（用于等价比较）。 */
export function githubRepoPath(value) {
  const full = githubRepoFull(value)
  return full ? full.toLowerCase() : undefined
}

/** 从项目清单提取声明的源仓库（owner/name）。 */
export function detectDeclaredRepo(repoRoot) {
  const pkg = readJsonSafe(join(repoRoot, 'package.json'))
  if (pkg) {
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
    const gh = githubRepoPath(repo)
    if (gh) return gh
  }
  const skillMd = readTextSafe(join(repoRoot, 'SKILL.md'))
  if (skillMd) {
    const m = /^[ \t]+source:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(skillMd)
    const gh = githubRepoPath(m?.[1])
    if (gh) return gh
  }
  const cargo = readTextSafe(join(repoRoot, 'Cargo.toml'))
  if (cargo) {
    const m = /^\s*repository\s*=\s*["']([^"']+)["']/m.exec(cargo)
    const gh = githubRepoPath(m?.[1])
    if (gh) return gh
  }
  const pyproject = readTextSafe(join(repoRoot, 'pyproject.toml'))
  if (pyproject) {
    const urls = /\[project\.urls\]([\s\S]*?)(?:\n\[|$)/.exec(pyproject)?.[1] ?? ''
    for (const key of ['Repository', 'Source', 'Homepage', 'Home']) {
      const m = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'mi').exec(urls)
      const gh = githubRepoPath(m?.[1])
      if (gh) return gh
    }
  }
  const gomod = readTextSafe(join(repoRoot, 'go.mod'))
  if (gomod) {
    const m = /^module\s+(\S+)/m.exec(gomod)
    const gh = githubRepoPath(m?.[1])
    if (gh) return gh
  }
  return undefined
}

/**
 * 双轴五态工作区身份判定（纯逻辑，支持注入外部 API 与本地标志）：
 * local-only | maintainer | contributor-fork | clone-readonly | inbound-external-pr | undetermined
 */
export function resolveWorkspaceIdentity({
  gitDir,
  remoteUrls = {},
  declaredRepo,
  gitIdentity = {},
  historyAuthors = [],
  commits = 0,
  externalPr,
  apiProbe,
} = {}) {
  if (externalPr) {
    return {
      role: 'inbound-external-pr',
      reason: `审阅外部传入 PR #${externalPr}`,
    }
  }

  if (gitDir && existsSync(join(gitDir, 'pf-local-mode'))) {
    return { role: 'local-only', reason: '已显式启用本地模式（.git/pf-local-mode）' }
  }

  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  if (!originRaw) {
    return { role: 'local-only', reason: '仓库没有配置任何远端' }
  }

  if (gitDir && existsSync(join(gitDir, 'pf-fork-mode'))) {
    return { role: 'contributor-fork', reason: '已选择 Fork 协作模式（.git/pf-fork-mode）' }
  }
  if (gitDir && existsSync(join(gitDir, 'pf-standalone-mode'))) {
    return { role: 'maintainer', reason: '已选择独立项目模式（.git/pf-standalone-mode）' }
  }

  const origin = githubRepoPath(originRaw)
  const upstream = githubRepoPath(remoteUrls.upstream)
  const isLocalRemote = (u) => Boolean(u) && (
    /^file:\/\//i.test(u.trim())
    || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u.trim()) && !/^[^@/]+@[^:]+:/i.test(u.trim()))
  )

  if (!origin) {
    if (isLocalRemote(originRaw)) {
      if (remoteUrls.upstream && remoteUrls.upstream !== originRaw) {
        return { role: 'contributor-fork', reason: '本地测试远端存在独立的 upstream 与 origin' }
      }
      const localEmail = (gitIdentity.email ?? '').trim().toLowerCase()
      const localName = (gitIdentity.name ?? '').trim().toLowerCase()
      const matched = historyAuthors.some((a) => {
        const lower = a.toLowerCase()
        return (localEmail && lower.includes(`<${localEmail}>`)) || (localName && lower.startsWith(`${localName} <`))
      })
      if (commits > 0 && historyAuthors.length > 0 && !matched) {
        return { role: 'clone-readonly', reason: '克隆仓历史作者与当前配置署名不匹配' }
      }
      return { role: 'maintainer', reason: '本地测试远端且属主匹配' }
    }
    return { role: 'undetermined', reason: '远端地址无法识别为 GitHub 仓库' }
  }

  if (upstream && upstream !== origin) {
    return { role: 'contributor-fork', reason: `origin (${origin}) 与 upstream (${upstream}) 不同` }
  }

  if (apiProbe?.isFork === true && (!declaredRepo || !apiProbe.parent || apiProbe.parent === declaredRepo)) {
    return { role: 'contributor-fork', reason: `API 探测表明 ${origin} 是 Fork 仓库` }
  }

  if (declaredRepo && declaredRepo !== origin) {
    if (apiProbe?.viewerPermission && /^(READ|NONE)$/i.test(apiProbe.viewerPermission)) {
      return { role: 'clone-readonly', reason: `对声明的远端 ${origin} 无写权限（${apiProbe.viewerPermission}）` }
    }
    return { role: 'contributor-fork', reason: `项目声明源仓库为 ${declaredRepo}，当前 origin 为 ${origin}` }
  }

  // origin 与 declaredRepo 一致或未声明源仓库：校验是否拥有维护者写权限或本机作者归属
  if (apiProbe?.viewerPermission) {
    if (/^(ADMIN|MAINTAIN|WRITE)$/i.test(apiProbe.viewerPermission)) {
      return { role: 'maintainer', reason: `拥有 ${origin} 写权限（${apiProbe.viewerPermission}）` }
    }
    if (/^(READ|NONE)$/i.test(apiProbe.viewerPermission)) {
      return { role: 'clone-readonly', reason: `对 ${origin} 仅具备只读权限（${apiProbe.viewerPermission}）` }
    }
  }

  const originOwner = origin.split('/')[0]
  if (apiProbe?.viewerLogin && apiProbe.viewerLogin.toLowerCase() === originOwner) {
    return { role: 'maintainer', reason: `当前登录账号 ${apiProbe.viewerLogin} 与仓库属主一致` }
  }

  // 离线判据：若已有提交历史，核对本地 git 署名是否在提交作者之中，防止把他人克隆仓误判为维护者
  const localEmail = (gitIdentity.email ?? '').trim().toLowerCase()
  const localName = (gitIdentity.name ?? '').trim().toLowerCase()
  const authorMatched = historyAuthors.some((a) => {
    const lower = a.toLowerCase()
    if (localEmail && lower.includes(`<${localEmail}>`)) return true
    if (localName && lower.startsWith(`${localName} <`)) return true
    return false
  })

  if (commits > 0 && historyAuthors.length > 0 && !authorMatched) {
    return {
      role: 'clone-readonly',
      reason: `未检测到对 ${origin} 的写权限，且本机提交署名未出现在历史作者中（疑似只读克隆他人仓库）`,
    }
  }

  if (declaredRepo && declaredRepo === origin) {
    return { role: 'maintainer', reason: `origin 与项目声明源仓库 ${origin} 一致且本机提交归属吻合` }
  }

  if (authorMatched) {
    return { role: 'maintainer', reason: '自有仓库且本机署名匹配历史提交作者' }
  }

  return { role: 'undetermined', reason: '缺乏源仓库声明与远端写权限证明，按保守贡献者处置' }
}

// ── 双轨四级内置轻量 GitHub 客户端（绝不落盘/打印 token） ─────────────

function parseGitHubUrlParts(remoteUrl) {
  const full = githubRepoFull(remoteUrl)
  if (!full) return null
  const isSsh = /^git@|^ssh:\/\//i.test(String(remoteUrl ?? '').trim())
  return { full, lower: full.toLowerCase(), protocol: isSsh ? 'ssh' : 'https' }
}

/** 探测 git credential fill（仅保留内存令牌给闭包客户端，绝不写入返回对象）。 */
async function probeHttpsCredential(cwd, remoteUrl) {
  const parts = parseGitHubUrlParts(remoteUrl)
  const pathPart = parts ? `${parts.full}.git` : ''
  const lines = ['protocol=https', 'host=github.com']
  if (pathPart) lines.push(`path=${pathPart}`)
  const res = await execSafe('git', ['credential', 'fill'], {
    cwd,
    input: `${lines.join('\n')}\n\n`,
    timeout: 3000,
  })
  if (!res.ok || !res.stdout) return { available: false, token: null }
  let token = null
  for (const line of res.stdout.split('\n')) {
    const m = /^password=(.+)$/.exec(line.trim())
    if (m && m[1]) { token = m[1]; break }
  }
  return { available: Boolean(token), token }
}

async function probeSshAuth(cwd) {
  const r22 = await execSafe('ssh', [
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', '-o', 'StrictHostKeyChecking=accept-new',
    'git@github.com',
  ], { cwd, timeout: 3500 })
  if (/successfully authenticated/i.test(r22.stderr + r22.stdout)) {
    return { available: true, port: 22 }
  }
  const r443 = await execSafe('ssh', [
    '-T', '-p', '443', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=2', '-o', 'StrictHostKeyChecking=accept-new',
    'git@ssh.github.com',
  ], { cwd, timeout: 3500 })
  if (/successfully authenticated/i.test(r443.stderr + r443.stdout)) {
    return { available: true, port: 443 }
  }
  return { available: false, port: null }
}

/**
 * 并发探测双轨四级 GitHub 环境，并返回自包含客户端实例（token 仅保存在闭包内）。
 */
export async function probeGitHubEnv({ cwd = process.cwd(), remoteUrls = {}, probeNetwork = false } = {}) {
  const originRaw = remoteUrls.origin ?? Object.values(remoteUrls)[0]
  const parsedOrigin = originRaw ? parseGitHubUrlParts(originRaw) : null

  if (!originRaw) {
    return {
      env: {
        hasRemote: false,
        protocol: null,
        trackA: { ssh: 'n/a', https: 'n/a', remediationCmd: null },
        trackB: { tier: 'offline', ghCli: false, hasToken: false },
      },
      client: createGitHubClient({ tier: 'offline', cwd }),
    }
  }

  const envToken = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null
  const [ghStatus, credResult] = await Promise.all([
    execSafe('gh', ['auth', 'status'], { cwd, timeout: 3000 }),
    probeHttpsCredential(cwd, originRaw),
  ])
  const sshResult = probeNetwork && (parsedOrigin?.protocol === 'ssh' || (!credResult.available && !envToken))
    ? await probeSshAuth(cwd)
    : { available: null, port: null }

  const ghOk = !ghStatus.missing && ghStatus.ok
  const token = envToken || credResult.token || null
  const hasHttps = credResult.available || Boolean(envToken)

  let sshState = 'unprobed'
  if (sshResult.available === true) sshState = `available:${sshResult.port}`
  else if (sshResult.available === false) sshState = 'unavailable'

  let remediationCmd = null
  if (parsedOrigin?.protocol === 'https' && !hasHttps && sshResult.available === true) {
    remediationCmd = `git remote set-url origin git@github.com:${parsedOrigin.full}.git`
  } else if (parsedOrigin?.protocol === 'https' && !hasHttps && ghOk) {
    remediationCmd = 'gh auth setup-git'
  } else if (parsedOrigin?.protocol === 'ssh' && sshResult.available === false && hasHttps) {
    remediationCmd = `git remote set-url origin https://github.com/${parsedOrigin.full}.git`
  }

  let tier = 'mcp-delegate'
  if (ghOk) tier = 'gh-cli'
  else if (token) tier = 'node-https-token'
  else if (parsedOrigin?.protocol === 'ssh' && sshResult.available === true) tier = 'half-duplex'
  else if (!probeNetwork && parsedOrigin) tier = 'mcp-delegate'

  const env = {
    hasRemote: true,
    origin: parsedOrigin?.full ?? null,
    protocol: parsedOrigin?.protocol ?? null,
    trackA: {
      ssh: sshState,
      https: hasHttps ? 'available' : 'no-credential',
      remediationCmd,
    },
    trackB: {
      tier,
      ghCli: ghOk,
      // 布尔标示，绝不暴露或序列化令牌值
      hasToken: Boolean(token),
    },
  }

  return {
    env,
    client: createGitHubClient({ tier, cwd, token }),
  }
}

/** 构造 GitHub 原生 REST 请求（node:https），仅在内存中携带 token。 */
function githubHttpsRequest(method, apiPath, token, bodyObj) {
  return new Promise((done) => {
    const payload = bodyObj === undefined ? null : Buffer.from(JSON.stringify(bodyObj), 'utf8')
    const headers = {
      'User-Agent': 'dev-flow-kit',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8'
      headers['Content-Length'] = String(payload.length)
    }

    const req = https.request({
      hostname: 'api.github.com',
      path: apiPath,
      method,
      headers,
      timeout: 10000,
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = raw ? JSON.parse(raw) : null } catch { data = raw }
        done({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode ?? 0,
          data,
        })
      })
    })
    req.on('timeout', () => {
      req.destroy()
      done({ ok: false, status: 408, data: { message: 'GitHub API timeout' } })
    })
    req.on('error', (err) => {
      done({ ok: false, status: 0, data: { message: err.message } })
    })
    if (payload) req.write(payload)
    req.end()
  })
}

/** 写 UTF-8 临时文件，执行回调后必定清理，严禁命令行直接拼非 ASCII 正文。 */
async function withUtf8TempFile(prefix, content, fn) {
  atomicCounter += 1
  const tmpFile = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${atomicCounter}.md`)
  writeFileSync(tmpFile, String(content ?? ''), 'utf8')
  try {
    return await fn(tmpFile)
  } finally {
    try { unlinkSync(tmpFile) } catch { /* 临时文件清理失败不掩盖主流程 */ }
  }
}

/** 解析 Issue / PR 正文中的依赖与引用关系（忽略代码块）。 */
export function parseBodyRelations(body) {
  const text = String(body ?? '')
  const out = { dependsOn: [], blocks: [], partOf: [], fixes: [], refs: [] }
  const cleanLines = []
  let inFence = false
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(?:```|~~~)/.test(line)) { inFence = !inFence; continue }
    if (!inFence) cleanLines.push(line)
  }
  const clean = cleanLines.join('\n')

  const extractNums = (re, bucket) => {
    for (const m of clean.matchAll(re)) {
      for (const numMatch of m[1].matchAll(/#(\d+)/g)) {
        const n = Number(numMatch[1])
        if (Number.isInteger(n) && !bucket.includes(n)) bucket.push(n)
      }
    }
  }

  extractNums(/\bdepends\s+on\s*:?\s*([^\n.;]+)/gi, out.dependsOn)
  extractNums(/\bblocks\s*:?\s*([^\n.;]+)/gi, out.blocks)
  extractNums(/\bpart\s+of\s*:?\s*([^\n.;]+)/gi, out.partOf)
  extractNums(/\b(?:fix|fixes|fixed|close|closes|closed|resolve|resolves|resolved)\s*:?\s*([^\n.;]+)/gi, out.fixes)
  extractNums(/\brefs?\s*:?\s*([^\n.;]+)/gi, out.refs)
  return out
}

/**
 * 解析混合输入列表（Issue URL / PR URL / #N / issue#N / pr#N）。
 */
export function parseFlowInputs(inputs = [], defaultRepo = null) {
  const issues = []
  const prs = []
  const unknown = []

  for (const raw of inputs) {
    const s = String(raw ?? '').trim()
    if (!s) continue
    let m = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/(\d+)/i.exec(s)
    if (m) { issues.push({ repo: m[1], number: Number(m[2]), raw: s }); continue }

    m = /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/i.exec(s)
    if (m) { prs.push({ repo: m[1], number: Number(m[2]), raw: s }); continue }

    m = /^pr#(\d+)$/i.exec(s)
    if (m) { prs.push({ repo: defaultRepo, number: Number(m[1]), raw: s }); continue }

    m = /^(?:issue)?#(\d+)$/i.exec(s)
    if (m) { issues.push({ repo: defaultRepo, number: Number(m[1]), raw: s }); continue }

    unknown.push(s)
  }
  return { issues, prs, unknown }
}

/**
 * 构造四级降级 GitHub 客户端。
 */
export function createGitHubClient({ tier = 'mcp-delegate', cwd = process.cwd(), token = null } = {}) {
  const makeMcpDelegate = (action, params, statePayload = {}) => {
    const tag = `<!-- pf-state:${JSON.stringify(statePayload)} -->`
    const bodyWithTag = params.body ? `${params.body}\n\n${tag}` : undefined
    return {
      ok: false,
      delegated: true,
      tier: tier === 'offline' || tier === 'half-duplex' ? tier : 'mcp-delegate',
      action,
      jsonPayload: {
        action,
        ...params,
        ...(bodyWithTag !== undefined ? { body: bodyWithTag } : {}),
        stateTag: tag,
      },
      stateTag: tag,
    }
  }

  return {
    tier,

    async getRepoMeta(repo) {
      if (!repo) return { ok: false, reason: 'missing-repo' }
      if (tier === 'gh-cli') {
        const res = await execSafe('gh', [
          'api', `repos/${repo}`,
        ], { cwd })
        if (!res.ok) return { ok: false, status: res.code, error: res.stderr }
        try {
          const data = JSON.parse(res.stdout)
          return {
            ok: true,
            isFork: Boolean(data.fork),
            parent: data.parent?.full_name?.toLowerCase() ?? null,
            defaultBranch: data.default_branch ?? 'main',
            viewerPermission: data.permissions?.admin ? 'ADMIN'
              : data.permissions?.maintain ? 'MAINTAIN'
                : data.permissions?.push ? 'WRITE' : 'READ',
          }
        } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await githubHttpsRequest('GET', `/repos/${repo}`, token)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const data = res.data ?? {}
        return {
          ok: true,
          isFork: Boolean(data.fork),
          parent: data.parent?.full_name?.toLowerCase() ?? null,
          defaultBranch: data.default_branch ?? 'main',
          viewerPermission: data.permissions?.admin ? 'ADMIN'
            : data.permissions?.maintain ? 'MAINTAIN'
              : data.permissions?.push ? 'WRITE' : 'READ',
        }
      }
      return makeMcpDelegate('get_repo', { repo })
    },

    async getIssue(repo, number) {
      if (tier === 'gh-cli') {
        const res = await execSafe('gh', [
          'issue', 'view', String(number), '--repo', repo,
          '--json', 'number,title,state,body,url,labels',
        ], { cwd })
        if (!res.ok) return { ok: false, error: res.stderr }
        try {
          const d = JSON.parse(res.stdout)
          return { ok: true, ...d, relations: parseBodyRelations(d.body) }
        } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await githubHttpsRequest('GET', `/repos/${repo}/issues/${number}`, token)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const d = res.data
        return {
          ok: true,
          number: d.number,
          title: d.title,
          state: String(d.state ?? '').toUpperCase(),
          body: d.body ?? '',
          url: d.html_url,
          labels: (d.labels ?? []).map((l) => l.name),
          relations: parseBodyRelations(d.body),
        }
      }
      return makeMcpDelegate('get_issue', { repo, number })
    },

    async getPr(repo, number) {
      if (tier === 'gh-cli') {
        const res = await execSafe('gh', [
          'pr', 'view', String(number), '--repo', repo,
          '--json', 'number,title,state,body,url,headRefName,baseRefName,headRepository,headRepositoryOwner,mergedAt,author',
        ], { cwd })
        if (!res.ok) return { ok: false, error: res.stderr }
        try {
          const d = JSON.parse(res.stdout)
          const headRepo = d.headRepositoryOwner?.login && d.headRepository?.name
            ? `${d.headRepositoryOwner.login}/${d.headRepository.name}` : null
          return {
            ok: true,
            number: d.number,
            title: d.title,
            state: String(d.state ?? '').toUpperCase(),
            body: d.body ?? '',
            url: d.url,
            headBranch: d.headRefName,
            baseBranch: d.baseRefName,
            headRepo,
            merged: Boolean(d.mergedAt) || String(d.state ?? '').toUpperCase() === 'MERGED',
            author: d.author?.login ?? null,
            relations: parseBodyRelations(d.body),
          }
        } catch { return { ok: false, error: 'invalid-json' } }
      }
      if (tier === 'node-https-token') {
        const res = await githubHttpsRequest('GET', `/repos/${repo}/pulls/${number}`, token)
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const d = res.data
        const state = d.merged ? 'MERGED' : String(d.state ?? '').toUpperCase()
        return {
          ok: true,
          number: d.number,
          title: d.title,
          state,
          body: d.body ?? '',
          url: d.html_url,
          headBranch: d.head?.ref ?? null,
          baseBranch: d.base?.ref ?? null,
          headRepo: d.head?.repo?.full_name ?? null,
          merged: Boolean(d.merged),
          author: d.user?.login ?? null,
          relations: parseBodyRelations(d.body),
        }
      }
      return makeMcpDelegate('get_pr', { repo, number })
    },

    async listOpenPrsByBase(repo, baseBranch) {
      if (!repo || !baseBranch) return { ok: true, prs: [], skipped: true }
      if (tier === 'gh-cli') {
        const res = await execSafe('gh', [
          'pr', 'list', '--repo', repo, '--base', baseBranch, '--state', 'open',
          '--json', 'number,title,headRefName,url',
        ], { cwd })
        if (!res.ok) return { ok: false, prs: [], error: res.stderr }
        try {
          return { ok: true, prs: JSON.parse(res.stdout) }
        } catch { return { ok: false, prs: [] } }
      }
      if (tier === 'node-https-token') {
        const q = encodeURIComponent(baseBranch)
        const res = await githubHttpsRequest('GET', `/repos/${repo}/pulls?state=open&base=${q}`, token)
        if (!res.ok) return { ok: false, prs: [], error: res.data?.message }
        return {
          ok: true,
          prs: (res.data ?? []).map((p) => ({
            number: p.number, title: p.title, headRefName: p.head?.ref, url: p.html_url,
          })),
        }
      }
      return { ok: true, prs: [], skipped: true, reason: tier }
    },

    async findOpenPrForBranch(repo, headBranch) {
      if (!repo || !headBranch) return { ok: false, prs: [] }
      if (tier === 'gh-cli') {
        const res = await execSafe('gh', [
          'pr', 'list', '--repo', repo, '--head', headBranch, '--state', 'open',
          '--json', 'number,title,headRefName,baseRefName,url,state',
        ], { cwd })
        if (!res.ok) return { ok: false, prs: [] }
        try { return { ok: true, prs: JSON.parse(res.stdout) } } catch { return { ok: false, prs: [] } }
      }
      if (tier === 'node-https-token') {
        const owner = repo.split('/')[0]
        const headParam = headBranch.includes(':') ? headBranch : `${owner}:${headBranch}`
        const res = await githubHttpsRequest(
          'GET',
          `/repos/${repo}/pulls?state=open&head=${encodeURIComponent(headParam)}`,
          token,
        )
        if (!res.ok) return { ok: false, prs: [] }
        return {
          ok: true,
          prs: (res.data ?? []).map((p) => ({
            number: p.number, title: p.title, headRefName: p.head?.ref, baseRefName: p.base?.ref, url: p.html_url,
          })),
        }
      }
      return { ok: false, prs: [], reason: tier }
    },

    async postComment({ repo, number, body, statePayload = {} }) {
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      const tag = `<!-- pf-state:${JSON.stringify(statePayload)} -->`
      const fullBody = Object.keys(statePayload).length > 0 ? `${normalizedBody}\n\n${tag}` : normalizedBody

      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-comment', fullBody, async (tmpFile) => {
          const res = await execSafe('gh', [
            'api', `repos/${repo}/issues/${number}/comments`,
            '-X', 'POST', '-F', `body=@${tmpFile}`,
          ], { cwd })
          if (!res.ok) return { ok: false, error: res.stderr }
          let created = null
          try { created = JSON.parse(res.stdout) } catch { /* 忽略解析失败 */ }
          // 回读校验，防编码层静默截断
          const readback = String(created?.body ?? '').replace(/\r\n/g, '\n').trim()
          return {
            ok: true,
            id: created?.id ?? null,
            url: created?.html_url ?? null,
            verifiedReadback: readback === fullBody,
          }
        })
      }
      if (tier === 'node-https-token') {
        const res = await githubHttpsRequest(
          'POST',
          `/repos/${repo}/issues/${number}/comments`,
          token,
          { body: fullBody },
        )
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const readback = String(res.data?.body ?? '').replace(/\r\n/g, '\n').trim()
        return {
          ok: true,
          id: res.data?.id ?? null,
          url: res.data?.html_url ?? null,
          verifiedReadback: readback === fullBody,
        }
      }
      return makeMcpDelegate('post_comment', { repo, number, body: normalizedBody }, statePayload)
    },

    async addLabels({ repo, number, labels = [] }) {
      if (labels.length === 0) return { ok: true, skipped: true }
      if (tier === 'gh-cli') {
        const args = ['issue', 'edit', String(number), '--repo', repo]
        for (const l of labels) { args.push('--add-label', l) }
        const res = await execSafe('gh', args, { cwd })
        if (!res.ok) {
          if (/403|forbidden|permission|not authorized/i.test(res.stderr)) {
            return { ok: false, skipped: true, reason: 'forbidden-403' }
          }
          return { ok: false, skipped: true, reason: res.stderr }
        }
        return { ok: true }
      }
      if (tier === 'node-https-token') {
        const res = await githubHttpsRequest(
          'POST',
          `/repos/${repo}/issues/${number}/labels`,
          token,
          { labels },
        )
        if (res.status === 403 || res.status === 404) {
          return { ok: false, skipped: true, reason: `http-${res.status}` }
        }
        if (!res.ok) return { ok: false, skipped: true, reason: res.data?.message }
        return { ok: true }
      }
      return makeMcpDelegate('add_labels', { repo, number, labels })
    },

    async createPr({ targetRepo, head, base, title, body, draft = false }) {
      const normalizedBody = String(body ?? '').replace(/\r\n/g, '\n').trim()
      if (tier === 'gh-cli') {
        return withUtf8TempFile('pf-pr-body', normalizedBody, async (tmpFile) => {
          const args = [
            'pr', 'create', '--repo', targetRepo, '--head', head, '--base', base,
            '--title', title, '--body-file', tmpFile,
          ]
          if (draft) args.push('--draft')
          const res = await execSafe('gh', args, { cwd })
          if (!res.ok) return { ok: false, error: res.stderr }
          const url = res.stdout.trim().split('\n').pop()
          const numMatch = /\/pull\/(\d+)$/.exec(url ?? '')
          return { ok: true, url, number: numMatch ? Number(numMatch[1]) : null }
        })
      }
      if (tier === 'node-https-token') {
        const res = await githubHttpsRequest('POST', `/repos/${targetRepo}/pulls`, token, {
          title, body: normalizedBody, head, base, draft,
        })
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        return { ok: true, number: res.data?.number ?? null, url: res.data?.html_url ?? null }
      }
      const oneClickUrl = `https://github.com/${targetRepo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?expand=1`
      if (tier === 'half-duplex') {
        return {
          ok: false,
          halfDuplex: true,
          tier: 'half-duplex',
          oneClickPrUrl: oneClickUrl,
          title,
          body: normalizedBody,
        }
      }
      return {
        ...makeMcpDelegate('create_pr', {
          repo: targetRepo, head, base, title, body: normalizedBody, draft,
        }, { action: 'create_pr', head, base }),
        oneClickPrUrl: oneClickUrl,
      }
    },

    async mergePr({ repo, number, method = 'merge' }) {
      // 严禁传 --delete-branch；删分支必须由收尾人类确认后单独走 cleanup
      if (tier === 'gh-cli') {
        const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge'
        const res = await execSafe('gh', ['pr', 'merge', String(number), '--repo', repo, flag], { cwd })
        if (!res.ok) return { ok: false, error: res.stderr }
        const readback = await this.getPr(repo, number)
        return {
          ok: readback.ok && readback.merged === true,
          merged: Boolean(readback.merged),
          state: readback.state ?? 'UNKNOWN',
        }
      }
      if (tier === 'node-https-token') {
        const res = await githubHttpsRequest('PUT', `/repos/${repo}/pulls/${number}/merge`, token, {
          merge_method: method,
        })
        if (!res.ok) return { ok: false, status: res.status, error: res.data?.message }
        const readback = await this.getPr(repo, number)
        return {
          ok: readback.ok && readback.merged === true,
          merged: Boolean(readback.merged),
          state: readback.state ?? 'UNKNOWN',
        }
      }
      return makeMcpDelegate('merge_pr', { repo, number, method })
    },
  }
}

// ── 弱模型防呆导航输出 ────────────────────────────────────────────────

/** 在每个 CLI 输出末尾打印清晰的下一步唯一合法动作卡片。 */
export function printNextStep(lines, { jsonMode = false } = {}) {
  if (jsonMode) return
  const items = Array.isArray(lines) ? lines.filter(Boolean) : [String(lines ?? '')]
  if (items.length === 0) return
  process.stdout.write('\n[NEXT STEP]\n')
  for (const line of items) {
    process.stdout.write(`  - ${line}\n`)
  }
}
