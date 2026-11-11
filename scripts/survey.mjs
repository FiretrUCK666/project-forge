#!/usr/bin/env node
/**
 * survey.mjs —— 目标项目的只读勘察。
 *
 * 只做一件事：把「这个项目现在是什么样」变成结构化事实。它不判断该做什么，
 * 也不写任何文件——该做什么在 SKILL.md 的能力矩阵与 references/ 的判据里。
 *
 * 三条纪律决定它的形状：
 *
 * 一、**所有版本控制查询并发**。它们互相独立，而本机起一个进程要几百毫秒；
 *     串行九次就是两三秒，并发则是「一个进程的延迟」。勘察会被反复调用，
 *     这个差别决定它还叫不叫「随手可跑」。
 * 二、**忽略判定一次问完**：候选目录收齐后走一次 `check-ignore --stdin -z`，
 *     不在循环里逐条问。逐条问的耗时随文件数线性增长。
 * 三、**不联网**。网络往返会让勘察变奢侈。唯一要问凭据助手的探测因此改成显式开关。
 *
 * 还有一条属于「怎么说」而不属于「查什么」：读不到就写读不到。拿不到的事实留空并给出
 * 状态，不猜成「没有」——「没查到」与「不存在」在判定上完全不同。
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative, resolve } from 'node:path'

import { toMarkdown } from './lib/render.mjs'
import { LIKELY_DEFAULT_BRANCHES } from './lib/protocol.mjs'
import {
  githubRepoPath, isMainModule, readJsonSafe, readTextSafe, samePath,
} from './lib/text.mjs'

// ── 扫描时跳过的目录 ────────────────────────────────────────────────
// 这些目录里的文件对治理没有意义，读它们只会拖慢。它们共同的特点是「可以用一条标准
// 命令重新生成」。判断是否被忽略是 .gitignore 的事，这里只是不进去。
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.pnpm-store', '.yarn', 'bower_components',
  '.venv', 'venv', '__pycache__', '.mypy_cache', '.pytest_cache', '.ruff_cache',
  '.tox', '.gradle', '.cache', '.next', '.nuxt', '.svelte-kit', '.turbo',
  'target', 'dist', 'build', 'out', 'coverage', '.idea', '.vs',
])

// 出现了却不在忽略规则里，就是真缺口：它会被提交进版本库。
const OUTPUT_DIRS = new Set([
  'node_modules', '.venv', '__pycache__', 'dist', 'build', 'out', 'target', 'coverage',
])

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|keystore)$/i,
  /^id_(?:rsa|ed25519|ecdsa)$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
]
const SAFE_ENV_EXAMPLES = /^\.env\.(?:example|sample|template|defaults)$/i

// 只认「够长、够独特、误报率低」的形状。判据是形状，所以它知道的是「像凭据」，
// 不知道「是不是真的」——报告里因此写「待确认」，不写「已泄露」。
const SECRET_CONTENT_PATTERNS = [
  { label: 'GitHub 令牌', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { label: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'npm 令牌', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'PyPI 令牌', re: /\bpypi-[A-Za-z0-9_-]{50,}\b/ },
  { label: 'API 密钥', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { label: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
]

// 认得出来的源码扩展名。**这张表决定「这是什么项目」**，所以它必须涵盖真实世界里
// 常见的写法，而不只是几家大厂的主语言。
//
// 一个 `.vue` 组件库被漏在这里时，它的代码文件数是 0，于是整仓被判成 `docs-only`
// ——「纯文档项目」，接下来该做的几件事全都不做。而它看起来完全正常：README 有、
// 文件数不为零、判断还给出了一个说得通的理由。
const CODE_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|py|rs|go|java|kt|kts|scala|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|ps1|lua|r|swift|dart|ex|exs|clj|hs|erl|jl|zig|sol|sql|proto)$/i

// 能按文本读的扩展名。内容扫描（凭据、本机路径）只在这类文件上做。
const TEXT_EXT = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|astro|py|rs|go|java|kt|kts|scala|c|cc|cpp|h|hpp|cs|rb|php|sh|bash|zsh|ps1|lua|r|swift|dart|ex|exs|clj|hs|erl|jl|zig|sol|sql|proto|md|mdx|txt|rst|ya?ml|json|toml|html|css|scss|svg)$/i

const DOC_EXT = /\.(?:md|mdx|txt|rst)$/i

// ── 子进程 ──────────────────────────────────────────────────────────

/**
 * 跑一个命令，返回结构化结果。**失败不抛异常**：调用方要区分「命令不存在」
 * 与「命令跑了但报错」，而这两种在判定上完全不同。
 */
function run(cmd, args, opts = {}) {
  return new Promise((done) => {
    const child = execFile(cmd, args, {
      cwd: opts.cwd,
      encoding: 'utf8',
      timeout: opts.timeout ?? 15000,
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      // 子进程默认继承环境；`env` 给了就用它叠在继承之上——**不是替换**，
      // 否则 PATH 没了，连 `git` 都起不来。
      env: opts.env === undefined ? process.env : { ...process.env, ...opts.env },
    }, (error, stdout, stderr) => {
      done({
        ok: error === null,
        status: error?.code ?? 0,
        missing: error?.code === 'ENOENT',
        stdout: (stdout ?? '').trim(),
        stderr: (stderr ?? '').trim(),
      })
    })

    // **给 stdin 挂一个 error 监听器，不然写进一个已经退出的进程会把整个脚本带崩。**
    // 这不是罕见情况：`git check-ignore --stdin` 在候选路径一条都不匹配时可能先退出，
    // 那时再往里写就是一个 EPIPE，而它抛在 stream 上、不在 Promise 里，`try` 拦不住——
    // 症状是整趟勘察带着栈死掉，报的还是个与判定毫无关系的错误。
    //
    // 吞掉它是对的：命令的结论由退出码与 stdout 给出，写失败这件事不影响那个结论。
    if (child.stdin) child.stdin.on('error', () => { /* 子进程提前退出，结论仍由退出码给出 */ })

    if (opts.input !== undefined && child.stdin) {
      child.stdin.end(opts.input)
    } else if (child.stdin) {
      child.stdin.end()
    }
  })
}

function git(cwd, args, opts = {}) {
  return run('git', ['-c', 'core.quotepath=false', ...args], { ...opts, cwd })
}

// ── 文件读取 ────────────────────────────────────────────────────────
//
// 三个都从 `lib/text.mjs` 取，本文件不再各写一份：`readTextSafe` 的「多大算太大、
// 含 NUL 就不读」、`samePath` 的「按真实路径归一」，都是别处也要用的判据。
// 同一件事两处各写一遍，迟早给出两个答案，而那种分歧出现在「读文件」上时是静默损坏。

function tomlString(text, key) {
  return new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)?.[1]
}

// ── 版本控制事实 ────────────────────────────────────────────────────

/**
 * 九次查询全部并发，一次往返拿到全部版本控制事实。
 *
 * 每条查询各自带「读不到」的表示，最终由调用点决定那意味着什么。比如 `commits` 与
 * `commitsState` 是分开的两个字段：读不出来时前者没有值，**不能当成 0**——把已有历史
 * 的仓库读成「零提交」，会把它带向「首次提交」。
 */
async function detectGit(root, { probeAuth = false } = {}) {
  const [top, cfg, st, remotes, tagsRes, logRes, lsFiles, checkIgnore, originHead, bare, shallow] = await Promise.all([
    git(root, ['rev-parse', '--is-inside-work-tree', '--show-toplevel']),
    git(root, ['config', '--list', '--show-scope', '--show-origin']),
    git(root, ['status', '--porcelain=v2', '--branch', '--untracked-files=normal']),
    git(root, ['remote', '-v']),
    git(root, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)', 'refs/tags']),
    git(root, ['log', '--format=%an <%ae>', '--no-merges', '-n', '200']),
    git(root, ['ls-files', '-z']),
    git(root, ['check-ignore', '-z', '--stdin'], { input: '' }),
    git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']),
    git(root, ['rev-parse', '--is-bare-repository']),
    git(root, ['rev-parse', '--is-shallow-repository']),
  ])

  if (top.missing) {
    return { available: false, present: false, auth: { https: 'n/a', network: 'n/a' } }
  }
  // **裸仓库要先判，再判工作区。** `--is-inside-work-tree` 在裸仓库上是 false，
  // 照它判会得到「这不是仓库」——下一步就会有人在这里 `git init`，而它明明已经是仓库。
  const isBare = bare.ok && bare.stdout === 'true'
  if (isBare) {
    return {
      available: true,
      present: true,
      isBare: true,
      isShallow: false,
      isRepoRoot: true,
      workTreeRoot: root,
      barePath: root,
      branch: undefined,
      remote: undefined,
      remotes: [],
      remoteUrls: {},
      identity: { name: undefined, email: undefined, scope: 'unset' },
      commits: undefined,
      commitsState: 'unreadable',
      trackedPaths: [],
      trackedFiles: 0,
      nestedRepos: [],
      auth: { https: 'n/a', network: 'n/a', reason: '裸仓库没有工作区' },
    }
  }
  if (!top.ok || !top.stdout) {
    return { available: true, present: false, auth: { https: 'n/a', network: 'n/a' } }
  }
  const isShallow = shallow.ok && shallow.stdout === 'true'
  const [insideFlag, workTreeRoot] = top.stdout.split('\n')
  const isRepoRoot = samePath(root, workTreeRoot)

  const config = parseConfigList(cfg.ok ? cfg.stdout : '')
  const statusInfo = parsePorcelainV2(st.ok ? st.stdout : '')

  const remoteUrls = {}
  for (const line of (remotes.stdout || '').split('\n')) {
    const m = /^(\S+)\s+(\S+)\s+\(fetch\)$/.exec(line.trim())
    if (m) remoteUrls[m[1]] = m[2]
  }
  const remoteNames = Object.keys(remoteUrls)
  const remote = remoteUrls.origin ?? (remoteNames.length > 0 ? remoteUrls[remoteNames[0]] : undefined)

  const tags = tagsRes.ok && tagsRes.stdout ? tagsRes.stdout.split('\n').filter(Boolean) : []
  const historyAuthors = logRes.ok && logRes.stdout
    ? [...new Set(logRes.stdout.split('\n').filter(Boolean))]
    : []

  // 提交风格：只为一个用途——生成契约时提醒「沿用既有写法，别混第二套」。
  // 判据是最近 20 条主题的**形状**，读不到就是 undefined，不猜。
  const recentSubjects = logRes.ok && logRes.stdout
    ? (await git(root, ['log', '--format=%s', '-n', '20'])).stdout.split('\n').filter(Boolean)
    : []
  const commitStyle = detectCommitStyle(recentSubjects)
  const trackedPaths = lsFiles.ok && lsFiles.stdout ? lsFiles.stdout.split('\0').filter(Boolean) : []

  const head = statusInfo.oid && statusInfo.oid !== '(initial)' ? statusInfo.oid : undefined
  let commits = 0
  let commitsState = 'ok'
  if (head !== undefined) {
    const count = await git(root, ['rev-list', '--count', 'HEAD'])
    if (count.ok && /^\d+$/.test(count.stdout)) commits = Number(count.stdout)
    else commitsState = 'unreadable'
  }

  const auth = { https: 'undetermined', network: 'undetermined', reason: '默认不联网、不问凭据助手' }
  if (!remote) {
    auth.https = 'n/a'
    auth.network = 'n/a'
    auth.reason = '没有远端'
  } else if (probeAuth) {
    const probe = await probeCredential(root, remote)
    auth.https = probe.state
    auth.reason = probe.reason
  }

  return {
    available: true,
    present: true,
    isRepoRoot,
    isBare: false,
    isShallow,
    workTreeRoot,
    insideWorkTree: insideFlag === 'true',
    branch: statusInfo.head,
    originHeadBranch: parseOriginHead(originHead),
    commitStyle,
    upstream: statusInfo.upstream,
    ahead: statusInfo.ahead,
    behind: statusInfo.behind,
    dirty: statusInfo.dirty,
    remote,
    remotes: remoteNames,
    remoteUrls,
    remoteProtocol: remote ? (/^git@|^ssh:/.test(remote) ? 'ssh' : 'https') : undefined,
    reachableRoot: workTreeRoot,
    identity: {
      name: config.get('user.name')?.value,
      email: config.get('user.email')?.value,
      scope: config.get('user.name')?.scope ?? 'unset',
      credentialHelper: config.get('credential.helper')?.value,
      credentialHelperScope: config.get('credential.helper')?.scope,
    },
    tags,
    historyAuthors,
    commits,
    commitsState,
    trackedPaths: trackedPaths.length > 20000 ? trackedPaths.slice(0, 20000) : trackedPaths,
    trackedFiles: trackedPaths.length,
    head,
    initDefaultBranch: config.get('init.defaultbranch')?.value,
    auth,
    _hasGit: true,
    _ignoreProbeOk: checkIgnore.ok || checkIgnore.status === 1,
  }
}

/**
 * 解析 `git config --list --show-scope --show-origin`。
 *
 * 输出是 `scope<TAB>origin<TAB>key=value`，而 origin 里**可以有空格**
 * （Windows 上装在 `Program Files` 就会）。所以按制表符切，不用空白切。
 */
function parseConfigList(text) {
  const map = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const scope = parts[0].trim()
    if (!/^(system|global|local|worktree|command)$/.test(scope)) continue
    const body = parts.slice(2).join('\t')
    const eq = body.indexOf('=')
    if (eq < 0) continue
    map.set(body.slice(0, eq).toLowerCase(), { scope, value: body.slice(eq + 1) })
  }
  return map
}

/**
 * 解析 `git symbolic-ref --short refs/remotes/origin/HEAD`：`origin/main` → `main`。
 *
 * 这一路比「当前分支」权威：当前检出的可能是一个功能分支，而契约里要写的是**默认分支**
 * ——合并收尾、拉取正本都要回它那儿。读不到返回 undefined，由调用方逐级降级。
 */
function parseOriginHead(res) {
  if (!res?.ok || !res.stdout) return undefined
  const m = /^origin\/(.+)$/.exec(res.stdout.trim())
  return m ? m[1] : res.stdout.trim() || undefined
}

/**
 * 从最近若干条提交主题判提交风格。`plain` 是默认值，不是「判不出来」——
 * 三种形状里它最宽松，把它当兜底不会让人写错东西。
 */
function detectCommitStyle(subjects) {
  if (!Array.isArray(subjects) || subjects.length === 0) return 'plain'
  const conventional = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]*\))?!?:\s+\S/i
  const gitmoji = /^(?::[a-z_]+:|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}])/u
  let conv = 0
  let emoji = 0
  for (const s of subjects) {
    if (conventional.test(s)) conv += 1
    else if (gitmoji.test(s)) emoji += 1
  }
  const half = subjects.length / 2
  if (conv > half) return 'conventional'
  if (emoji > half) return 'gitmoji'
  return 'plain'
}

/** 解析 `git status --porcelain=v2 --branch`：分支、上游、领先落后、脏文件数一次拿到。 */
function parsePorcelainV2(text) {
  const out = { head: undefined, oid: undefined, upstream: undefined, ahead: 0, behind: 0, dirty: 0 }
  for (const line of String(text ?? '').split('\n')) {
    if (line.startsWith('# branch.head ')) out.head = line.slice(14).trim()
    else if (line.startsWith('# branch.oid ')) out.oid = line.slice(13).trim()
    else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(17).trim()
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line)
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]) }
    } else if (line.trim() !== '') out.dirty += 1
  }
  return out
}

/**
 * 问一次凭据助手有没有 HTTPS 凭据。
 *
 * 只判退出码，**绝不读密码值、绝不打印**：输入是「要哪一处的凭据」，输出被丢弃。
 * 判据跨平台一致——`git credential fill` 取不到就非零退出。
 *
 * ## 三行都得给，`path` 尤其不能漏
 *
 * 凭据有两种存法：按主机（`credential.https://github.com`）与按路径
 * （`credential.https://github.com/owner/repo`）。只给 `host` 时，凭据助手查的是前者，
 * 而很多人的凭据恰恰是按路径存的——症状是「明明登录了却推不上去」，所有报错都说认证失败。
 * 这一条是这套流程自己写在参考文档里的硬判据，代码不能比文档松。
 *
 * ## 两个环境变量不是可选项
 *
 * 没有可用的凭据时，`git credential fill` 会**弹一个图形登录框**等人输入。在桌面环境上
 * 那会一直卡到超时（或者更糟：卡到人回来点掉），而调用方以为自己在做一次「几百毫秒的探测」。
 * 两个变量分别关掉终端与图形助手的交互，它才真的是一次探测。
 */
async function probeCredential(root, remote) {
  const url = /^https?:\/\//i.test(remote) ? remote : 'https://github.com'
  let host = 'github.com'
  let path = ''
  try {
    const parsed = new URL(url)
    host = parsed.host
    path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
    // 按路径存凭据时，那条路径要带 `.git` 后缀（`owner/repo.git`），
    // 与 `git remote` 里写的裸路径不是一回事。
    if (path !== '' && !/\.git$/i.test(path)) path = `${path}.git`
  } catch { /* 用默认值：认不出就按主机问，那仍然比不问强 */ }

  const lines = [`protocol=https`, `host=${host}`]
  if (path !== '') lines.push(`path=${path}`)
  const res = await run('git', ['credential', 'fill'], {
    cwd: root,
    input: `${lines.join('\n')}\n\n`,
    timeout: 5000,
    // 关掉交互：没有凭据时助手会弹窗等人，而探测不能等人。
    env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
  if (res.missing) return { state: 'undetermined', reason: '这台机器上找不到 git' }
  if (res.ok) return { state: 'available', reason: '凭据助手取到了凭据' }
  return { state: 'no-credential', reason: '凭据助手没取到凭据' }
}

// ── 生态判定 ────────────────────────────────────────────────────────
//
// 表格驱动：**加一个生态就加一行**，不动引擎。每行给出「认它的证据」与「它的命令」。

const ECOSYSTEMS = [
  {
    kind: 'node',
    manifest: () => 'package.json',
    detect: (root) => existsSync(join(root, 'package.json')),
    read: (root, s) => {
      const pkg = readJsonSafe(join(root, 'package.json'))
      if (!pkg) return
      if (typeof pkg.name === 'string' && pkg.name.trim()) s.projectName = pkg.name.trim().replace(/^@[^/]+\//, '')
      if (typeof pkg.version === 'string') s.declaredVersion = pkg.version.trim()
      if (pkg.private === true) s.private = true
      const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
      if (repo) s.declaredRepo = githubRepoPath(repo)
      s.packageManager = existsSync(join(root, 'pnpm-lock.yaml')) ? 'pnpm'
        : existsSync(join(root, 'yarn.lock')) ? 'yarn'
          : (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) ? 'bun'
            : 'npm'
      const scripts = pkg.scripts ?? {}
      const runPrefix = s.packageManager === 'npm' ? 'npm run' : s.packageManager
      s.commands.install = s.packageManager === 'npm' && existsSync(join(root, 'package-lock.json'))
        ? 'npm ci' : `${s.packageManager} install`
      if (scripts.build) s.commands.build = `${runPrefix} build`
      if (scripts.typecheck) s.commands.typecheck = `${runPrefix} typecheck`
      if (scripts.lint) s.commands.lint = `${runPrefix} lint`
      if (scripts.test && !/no test specified/.test(String(scripts.test))) {
        s.commands.test = s.packageManager === 'npm' ? 'npm test' : `${s.packageManager} test`
      }
      if (scripts.check) s.commands.verify = `${runPrefix} check`
      else if (scripts.verify) s.commands.verify = `${runPrefix} verify`
      if (!s.private && typeof pkg.name === 'string' && typeof pkg.version === 'string') s.publishable = true
      if (pkg.engines?.node) s.runtimeRequirements.push(`Node ${pkg.engines.node}`)
    },
  },
  {
    kind: 'python',
    manifest: (root) => (existsSync(join(root, 'pyproject.toml')) ? 'pyproject.toml'
      : existsSync(join(root, 'requirements.txt')) ? 'requirements.txt' : 'setup.py'),
    detect: (root) => existsSync(join(root, 'pyproject.toml'))
      || existsSync(join(root, 'requirements.txt')) || existsSync(join(root, 'setup.py')),
    read: (root, s) => {
      const pyproject = join(root, 'pyproject.toml')
      if (existsSync(pyproject)) {
        const text = readTextSafe(pyproject) ?? ''
        const name = tomlString(text, 'name')
        const version = tomlString(text, 'version')
        if (name) s.projectName = name
        if (version && !s.declaredVersion) s.declaredVersion = version
        if (/\[build-system\]/.test(text) && name) s.publishable = true
        const requires = tomlString(text, 'requires-python')
        if (requires) s.runtimeRequirements.push(`Python ${requires}`)
        // 声明的源仓库：`[project.urls]` 里的 Repository / Homepage。
        // 读不到就留空——角色判定宁可报「比不出来」，也不要拿一个猜出来的仓库去比。
        const urls = /\[project\.urls\]([\s\S]*?)(?:\n\[|$)/.exec(text)?.[1] ?? ''
        if (!s.declaredRepo) {
          for (const key of ['Repository', 'Source', 'Homepage', 'Home']) {
            const value = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'mi').exec(urls)?.[1]
            const repo = githubRepoPath(value)
            if (repo) { s.declaredRepo = repo; break }
          }
        }
      }
      // `setup.py` 里偶尔也写着 url，读得到就用——它比「没有」强，但只作兜底。
      if (!s.declaredRepo && existsSync(join(root, 'setup.py'))) {
        const text = readTextSafe(join(root, 'setup.py')) ?? ''
        s.declaredRepo = githubRepoPath(/url\s*=\s*["']([^"']+)["']/.exec(text)?.[1])
      }
      // 安装命令按**项目里真实存在的文件**选，不按生态惯例编。
      // `pip install -e .` 要求有 pyproject.toml / setup.py；只有 requirements.txt 时
      // 用它会在 CI 里当场失败，而那条失败看起来像「代码坏了」。
      if (existsSync(join(root, 'uv.lock'))) s.commands.install ??= 'uv sync'
      else if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'setup.py'))) {
        s.commands.install ??= 'pip install -e .'
      } else if (existsSync(join(root, 'requirements.txt'))) {
        s.commands.install ??= 'pip install -r requirements.txt'
      }
      // 测试命令要有**测试存在的证据**：一个配置文件、或者一个测试目录。
      // 两样都没有的项目跑 pytest 会得到「collected 0 items」再以非零退出，
      // 而那在 CI 里就是一条红——红的原因却不是代码坏了。
      if (hasPytestEvidence(root)) s.commands.test ??= 'pytest'
    },
  },
  {
    kind: 'rust',
    manifest: () => 'Cargo.toml',
    detect: (root) => existsSync(join(root, 'Cargo.toml')),
    read: (root, s) => {
      const text = readTextSafe(join(root, 'Cargo.toml')) ?? ''
      const name = tomlString(text, 'name')
      const version = tomlString(text, 'version')
      if (name) s.projectName = name
      if (version && !s.declaredVersion) s.declaredVersion = version
      if (/publish\s*=\s*false/.test(text)) s.private = true
      else if (name && version) s.publishable = true
      const rustVersion = tomlString(text, 'rust-version')
      if (rustVersion) s.runtimeRequirements.push(`Rust ${rustVersion}`)
      // `repository` 字段就是 Cargo 的「源仓库」声明。它读得到，角色就判得出来；
      // 读不到时角色停在 undetermined，那一条会在 questions 里问清楚。
      if (!s.declaredRepo) s.declaredRepo = githubRepoPath(tomlString(text, 'repository'))
      s.commands.build ??= 'cargo build'
      s.commands.test ??= 'cargo test'
      s.commands.lint ??= 'cargo clippy -- -D warnings'
    },
  },
  {
    kind: 'go',
    manifest: () => 'go.mod',
    detect: (root) => existsSync(join(root, 'go.mod')),
    read: (root, s) => {
      const text = readTextSafe(join(root, 'go.mod')) ?? ''
      const mod = /^module\s+(\S+)/m.exec(text)?.[1]
      if (mod) {
        s.projectName = mod.split('/').pop() || s.projectName
        s.declaredRepo ??= githubRepoPath(mod)
        // Go 的「发布」就是打标签，没有上传动作——所以它是「不需要制品库」而不是「不可发布」。
        s.registryFree = true
      }
      const goVer = /^go\s+(\S+)/m.exec(text)?.[1]
      if (goVer) s.runtimeRequirements.push(`Go ${goVer}`)
      s.commands.build ??= 'go build ./...'
      s.commands.test ??= 'go test ./...'
    },
  },
  {
    kind: 'java',
    manifest: (root) => (existsSync(join(root, 'pom.xml')) ? 'pom.xml' : 'build.gradle'),
    detect: (root) => existsSync(join(root, 'pom.xml')) || existsSync(join(root, 'build.gradle'))
      || existsSync(join(root, 'build.gradle.kts')),
    read: (root, s) => {
      if (existsSync(join(root, 'pom.xml'))) {
        s.commands.build ??= 'mvn -B package'
        if (hasSuffix(root, '.java')) s.commands.test ??= 'mvn -B test'
        s.publishable = true
        return
      }
      // gradlew 是**提交进仓库的脚本**，不是「装了 Gradle 就有」。没提交它时
      // `./gradlew` 在 CI 里是「找不到文件」，而错误信息看起来像仓库缺了个东西。
      const wrapper = existsSync(join(root, 'gradlew')) || existsSync(join(root, 'gradlew.bat'))
      const gradle = wrapper ? './gradlew' : 'gradle'
      s.commands.build ??= `${gradle} build`
      if (gradleTestEvidence(root)) s.commands.test ??= `${gradle} test`
    },
  },
  {
    kind: 'ruby',
    manifest: () => 'Gemfile',
    detect: (root) => existsSync(join(root, 'Gemfile')) || hasSuffix(root, '.gemspec'),
    read: (root, s) => {
      s.commands.install ??= 'bundle install'
      // `bundle exec rake test` 要求有 Rakefile 且里面真有 test 任务。
      // 两者缺一时跑到的是「不知道 test 这个任务」，而它看起来像测试坏了。
      if (existsSync(join(root, 'Rakefile')) && hasRakeTestTarget(root)) {
        s.commands.test ??= 'bundle exec rake test'
      } else if (existsSync(join(root, 'spec')) || hasSuffix(root, '_spec.rb')) {
        s.commands.test ??= 'bundle exec rspec'
      }
      if (hasSuffix(root, '.gemspec')) s.publishable = true
    },
  },
  {
    kind: 'php',
    manifest: () => 'composer.json',
    detect: (root) => existsSync(join(root, 'composer.json')),
    read: (root, s) => {
      const c = readJsonSafe(join(root, 'composer.json'))
      if (c?.name) s.projectName = c.name
      s.commands.install ??= 'composer install'
      if (c?.name) s.publishable = true
      // composer 的 `repository` 可能是字符串，也可能是 `{ url: … }`；
      // `homepage` 里也常写着源码地址。三个都试一遍，认不出就留空。
      const candidates = [
        typeof c?.repository === 'string' ? c.repository : c?.repository?.url,
        typeof c?.homepage === 'string' ? c.homepage : undefined,
      ]
      if (!s.declaredRepo) {
        for (const candidate of candidates) {
          const repo = githubRepoPath(candidate)
          if (repo) { s.declaredRepo = repo; break }
        }
      }
    },
  },
  {
    kind: 'dotnet',
    manifest: () => '*.csproj',
    detect: (root) => hasSuffix(root, '.csproj') || hasSuffix(root, '.sln'),
    read: (root, s) => {
      s.commands.build ??= 'dotnet build'
      if (hasSuffix(root, 'Tests.csproj') || hasSuffix(root, '.Tests.csproj')) {
        s.commands.test ??= 'dotnet test'
      }
    },
  },
  {
    kind: 'cpp',
    manifest: (root) => (existsSync(join(root, 'CMakeLists.txt')) ? 'CMakeLists.txt' : 'meson.build'),
    detect: (root) => existsSync(join(root, 'CMakeLists.txt')) || existsSync(join(root, 'meson.build')),
    read: (root, s) => {
      if (existsSync(join(root, 'CMakeLists.txt'))) {
        s.commands.build ??= 'cmake -B build && cmake --build build'
        // `ctest` 要求 CMake 里**登记过测试**（enable_testing / add_test）。
        // 没登记时它跑到的是「No tests were found」，退出码非零。
        if (cmakeHasTests(root)) s.commands.test ??= 'ctest --test-dir build --output-on-failure'
      } else {
        s.commands.build ??= 'meson compile -C build'
        if (existsSync(join(root, 'test')) || existsSync(join(root, 'tests'))) {
          s.commands.test ??= 'meson test -C build'
        }
      }
    },
  },
  {
    kind: 'dart',
    manifest: () => 'pubspec.yaml',
    detect: (root) => existsSync(join(root, 'pubspec.yaml')),
    read: (root, s) => {
      s.commands.install ??= 'dart pub get'
      if (existsSync(join(root, 'test'))) s.commands.test ??= 'dart test'
      s.publishable = true
    },
  },
  {
    kind: 'swift',
    manifest: () => 'Package.swift',
    detect: (root) => existsSync(join(root, 'Package.swift')),
    read: (root, s) => {
      s.commands.build ??= 'swift build'
      if (existsSync(join(root, 'Tests')) || existsSync(join(root, 'Tests.swift'))) {
        s.commands.test ??= 'swift test'
      }
    },
  },
  {
    kind: 'elixir',
    manifest: () => 'mix.exs',
    detect: (root) => existsSync(join(root, 'mix.exs')),
    read: (root, s) => {
      s.commands.install ??= 'mix deps.get'
      if (existsSync(join(root, 'test'))) s.commands.test ??= 'mix test'
    },
  },
]

/**
 * Gradle 项目里有没有测试的证据。
 *
 * 三种：`src/test/` 目录、构建脚本里出现 `useJUnit` / `test {` 、或根目录里放着测试源。
 * 三样都没有时 `gradle test` 是「NO-SOURCE」——它会**成功退出**，看起来像跑过了。
 * 那比失败更糟：报告里会有一行「测试通过」，而那行什么都没有验。
 */
function gradleTestEvidence(root) {
  if (existsSync(join(root, 'src', 'test'))) return true
  for (const rel of ['build.gradle', 'build.gradle.kts']) {
    const text = readTextSafe(join(root, rel)) ?? ''
    if (/useJUnit|useTestNG|enableTest|tasks\.test|test\s*\{/.test(text)) return true
  }
  return false
}

/** CMake 里有没有登记过测试。 */
function cmakeHasTests(root) {
  const text = readTextSafe(join(root, 'CMakeLists.txt')) ?? ''
  if (/enable_testing\s*\(|add_test\s*\(|include\s*\(\s*CTest/.test(text)) return true
  return existsSync(join(root, 'tests')) || existsSync(join(root, 'test'))
}

/** Rakefile 里有没有 test 任务。 */
function hasRakeTestTarget(root) {
  const text = readTextSafe(join(root, 'Rakefile')) ?? ''
  return /^\s*task\s+:test\b|^\s*desc\s+.{0,80}\btest\b/m.test(text) || /^\s*task\s+default:/m.test(text)
}

/**
 * 这一条算不算「有效文件」。
 *
 * 判据是**它是不是操作系统或编辑器自动生成的垃圾**，而不是「它小不小」。
 * 一个只有 `.DS_Store` 与 `.vscode/settings.json` 的目录，实际上什么都没开始写；
 * 把它算成「有文件」会让成熟度从 `empty` 跳到 `greenfield`，而那一步的差别是
 * 「先让项目存在」与「该做的一次配齐」。
 */
function isJunkFile(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  if (/(^|\/)\.DS_Store$/.test(p)) return true
  if (/(^|\/)Thumbs\.db$/i.test(p)) return true
  if (/(^|\/)desktop\.ini$/i.test(p)) return true
  if (/(^|\/)\.(vscode|idea|fleet)\//.test(p)) return true
  return false
}

/** 一次 `git config` 列表里某个键的值。 */
function escapeRe(text) {
  return String(text ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}


/**
 * 这个仓库里有没有「能跑 pytest」的证据。
 *
 * 判据是**证据**，不是惯例：一个 `pytest.ini`、`[tool.pytest.ini_options]` 段、
 * `tests/` 目录，或者任何 `test_*.py` / `*_test.py`。四样都没有时跑 `pytest` 的结果是
 * 「collected 0 items」加非零退出——一条看起来像代码坏了的红。
 */
function hasPytestEvidence(root) {
  for (const rel of ['pytest.ini', 'tox.ini', 'conftest.py']) {
    if (existsSync(join(root, rel))) return true
  }
  for (const rel of ['pyproject.toml', 'setup.cfg']) {
    const text = readTextSafe(join(root, rel)) ?? ''
    if (/\[tool\.pytest|\[tool:pytest\]/.test(text)) return true
  }
  for (const dir of ['tests', 'test']) {
    if (existsSync(join(root, dir))) return true
  }
  return hasSuffix(root, '_test.py') || hasPrefix(root, 'test_', '.py')
}

/**
 * 目录里有没有以某个后缀结尾的文件。
 *
 * 「这个项目有 `.csproj` 吗」这类问题用它——**看文件名，不看固定路径**，
 * 因为各家把清单放在哪里是人的习惯，不是事实。
 */
function hasSuffix(root, suffix) {
  try { return readdirSync(root).some((name) => name.endsWith(suffix)) } catch { return false }
}

/** 目录里有没有以某个前缀开头、某个后缀结尾的文件。 */
function hasPrefix(root, prefix, suffix) {
  try {
    return readdirSync(root).some((name) => name.startsWith(prefix) && name.endsWith(suffix))
  } catch { return false }
}

/**
 * 插件类：宿主安装插件时通常不替它构建，所以产物该不该入库与普通项目相反。
 * 判据只认清单里区分这一类的字段，不认目录名——目录名是人的习惯，不是事实。
 */
const PLUGIN_HINTS = [
  { kind: 'vscode-extension', marker: 'package.json', test: (root) => {
    const p = readJsonSafe(join(root, 'package.json'))
    return Boolean(p?.engines?.vscode || p?.contributes)
  } },
  { kind: 'obsidian-plugin', marker: 'manifest.json', test: (root) => {
    const m = readJsonSafe(join(root, 'manifest.json'))
    return Boolean(m && typeof m.id === 'string' && typeof m.minAppVersion === 'string')
  } },
  { kind: 'dsh-plugin', marker: 'package.json', test: (root) => {
    const p = readJsonSafe(join(root, 'package.json'))
    return Boolean(p?.dsh || p?.dependencies?.cordis || p?.peerDependencies?.cordis)
  } },
]

/** 能力目录：宿主加载的是指令而不是代码。判据是入口文件里那两项必修声明。 */
function detectSkillKind(root) {
  for (const name of ['SKILL.md', 'skill.md']) {
    const p = join(root, name)
    if (!existsSync(p)) continue
    const text = readTextSafe(p) ?? ''
    const fm = /^---\n([\s\S]*?)\n---/.exec(text)
    if (!fm) return { skillMeta: { hasValidFrontmatter: false, entry: name } }
    const nameValue = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
    const descValue = /^description:\s*(?:[|>]\s*)?(.+)$/m.exec(fm[1])?.[1]?.trim()
    const verValue = /^[ \t]+version:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(fm[1])?.[1]?.trim()
    // `metadata.source` 是这个能力目录声明的来处。它决定「origin 是不是正本」——
    // 读不到它，角色就永远停在 `undetermined`，而这个字段本来就是为这个判定存在的。
    const srcValue = /^[ \t]+source:[ \t]*["']?([^"'\n]+?)["']?[ \t]*$/m.exec(fm[1])?.[1]?.trim()
    return {
      skillMeta: {
        hasValidFrontmatter: Boolean(nameValue && descValue),
        entry: name,
        name: nameValue,
        version: verValue,
        source: srcValue,
      },
    }
  }
  return undefined
}

function detectEcosystem(root) {
  const s = newEcosystemState()
  scanEcosystemAt(root, s)
  scanSubdirectories(root, s)
  for (const hint of PLUGIN_HINTS) {
    if (!hint.test(root)) continue
    if (!s.kinds.includes(hint.kind)) s.kinds.push(hint.kind)
    if (!s.manifests.includes(hint.marker)) s.manifests.push(hint.marker)
  }

  const skill = detectSkillKind(root)
  if (skill) {
    s.kinds.push('skill')
    s.skillMeta = skill.skillMeta
    if (!s.manifests.includes(skill.skillMeta.entry)) s.manifests.push(skill.skillMeta.entry)
    if (skill.skillMeta.version && !s.declaredVersion) s.declaredVersion = skill.skillMeta.version
    if (skill.skillMeta.source && !s.declaredRepo) {
      s.declaredRepo = githubRepoPath(skill.skillMeta.source)
    }
    // 能力目录靠克隆或复制分发，不经过制品库——「发布」这个动作对它不成立，不是被禁止。
    s.registryFree = true
  }

  return s
}

/** 一阶子目录里值得看一眼的那几个名字。前后端分离、monorepo 的常见布局。 */
const SUBDIR_CANDIDATES = ['frontend', 'backend', 'client', 'server', 'web', 'api', 'app', 'apps', 'packages', 'services', 'libs']

function newEcosystemState() {
  return {
    projectName: undefined,
    kinds: [],
    manifests: [],
    commands: {},
    commandsByEcosystem: {},
    runtimeRequirements: [],
    publishable: false,
    private: false,
    registryFree: false,
    declaredVersion: undefined,
    declaredRepo: undefined,
    packageManager: undefined,
    skillMeta: undefined,
    subdirs: [],
  }
}

/**
 * 根目录一个生态都没命中时，往**一阶子目录**看一层。
 *
 * 前后端分离的项目太常见了：根下只有 `frontend/` 与 `backend/`，各自的清单都在自己目录里。
 * 只看根目录会把整仓判成 `unknown`，而 `unknown` 那一行的处置是「先问用户」——
 * 于是一个结构清清楚楚的仓库被挡在了门外。
 *
 * **只在根目录没命中时下潜**：根上已经有清单的项目，子目录里多半是依赖或示例，
 * 跟着扫会凭空多出几个生态，而多出来的那些会让 CI 去装根本不需要的工具链。
 */
function scanSubdirectories(root, s) {
  if (s.kinds.length > 0) return
  for (const dir of SUBDIR_CANDIDATES) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    const sub = newEcosystemState()
    scanEcosystemAt(full, sub, { name: dir })
    if (sub.kinds.length === 0) continue
    for (const kind of sub.kinds) if (!s.kinds.includes(kind)) s.kinds.push(kind)
    for (const name of sub.manifests) if (!s.manifests.includes(name)) s.manifests.push(name)
    if (sub.publishable) s.publishable = true
    if (sub.private) s.private = true
    for (const req of sub.runtimeRequirements) {
      if (!s.runtimeRequirements.includes(req)) s.runtimeRequirements.push(req)
    }
    s.subdirs.push({ dir, kinds: sub.kinds, commands: sub.commands })
    for (const [key, value] of Object.entries(sub.commands)) {
      if (s.commands[key] === undefined) s.commands[key] = value
    }
    // 顶层 `commands` 只留先填上的那一份；子目录各自那一份按目录名分桶，
    // 与「多生态必须分桶」是同一条理由。
    if (Object.keys(sub.commands).length > 0) s.commandsByEcosystem[dir] = sub.commands
  }
}

/** 在给定的一个目录上跑一遍生态表。**只看这一层**，不递归。 */
function scanEcosystemAt(root, s, { name } = {}) {
  if (s.projectName === undefined) s.projectName = name ?? basename(root)
  for (const row of ECOSYSTEMS) {
    if (!row.detect(root)) continue
    s.kinds.push(row.kind)
    if (row.manifest) {
      const manifest = row.manifest(root)
      if (manifest && !s.manifests.includes(manifest)) s.manifests.push(manifest)
    }
    // 每个生态的命令先落在它自己那一桶里，再合并进顶层。
    //
    // **必须分桶**：一个仓库同时有前端 `package.json` 与后端 `pyproject.toml` 时，
    // 只有一个顶层 `commands` 会让后读到的生态盖掉先读到的——生成的契约与 CI 于是
    // 只测其中一半，而它看起来完全正常：测试绿着，另一半一次都没跑过。
    //
    // 做法是把 `s.commands` 临时换成一只空桶再交给 `row.read`：那些描述行里写的是
    // `s.commands.test ??= …`，共用一只桶时第二个生态会被第一个「已经填过了」挡掉。
    const scoped = {}
    const merged = s.commands
    s.commands = scoped
    try {
      row.read(root, s)
    } finally {
      s.commands = merged
    }
    for (const [key, value] of Object.entries(scoped)) {
      if (merged[key] === undefined) merged[key] = value
    }
    if (Object.keys(scoped).length > 0) s.commandsByEcosystem[row.kind] = scoped
  }
}

/**
 * 通用任务入口：命令写在 Makefile / justfile 这类文件里的项目。
 * 只看文件里**真实存在**的目标，不按惯例编一个——编出来的命令会在 CI 里失败，
 * 而那条失败看起来像「代码坏了」。
 */
function detectTaskEntries(root) {
  const commands = {}
  const makefile = ['Makefile', 'makefile', 'GNUmakefile'].find((n) => existsSync(join(root, n)))
  if (makefile) {
    const text = readTextSafe(join(root, makefile)) ?? ''
    const targets = new Set([...text.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((m) => m[1]))
    if (targets.has('test')) commands.test ??= 'make test'
    if (targets.has('build')) commands.build ??= 'make build'
    if (targets.has('lint')) commands.lint ??= 'make lint'
  }
  const justfile = ['justfile', 'Justfile'].find((n) => existsSync(join(root, n)))
  if (justfile) {
    const text = readTextSafe(join(root, justfile)) ?? ''
    const recipes = new Set([...text.matchAll(/^([A-Za-z0-9_-]+)(?:\s+[^:]*)?:/gm)].map((m) => m[1]))
    if (recipes.has('test')) commands.test ??= 'just test'
    if (recipes.has('build')) commands.build ??= 'just build'
  }
  return commands
}

// ── 工作区扫描 ──────────────────────────────────────────────────────

/**
 * 扫一遍工作区，并把忽略判定**一次问完**。
 *
 * 忽略判定走一次 `check-ignore --stdin -z`：候选路径一次性喂进去，NUL 分隔。
 * 逐条 spawn 会让耗时随文件数线性增长——实测三百个文件的仓库会从两秒变成二十七秒。
 */
async function walkWorkspace(root, gitFacts) {
  const canAskGit = gitFacts.present === true && gitFacts.isRepoRoot !== false
  const trackedSet = new Set(canAskGit ? gitFacts.trackedPaths : [])

  const homeNorm = homedir().replace(/\\/g, '/')
  // 家目录出现在正文里时，判据要**两边都卡边界**。
  //
  // 只卡一边（`^C:/Users/x`）会漏掉 `--home=C:/Users/x` 这种写法；只卡另一边会误报
  // `/root/theme` 这类源码路径。两头都要求「前面不是路径字符、后面不是名字字符」，
  // 才是真的「这里硬编码了一个本机绝对路径」。
  //
  // `/root` 这类**短路径**（容器里以 root 运行时 `homedir()` 就是它）单独处理：它太短、
  // 太容易与别的东西撞（前端路由 `/root`、CSS 的 `:root` 变量），所以额外要求后面
  // 紧跟一段真实路径。宁可漏报一处，也不要把一堆样式表报成「本机路径泄露」——
  // 那种报告会让人去改一行完全正确的代码。
  const homeRe = homeNorm.length > 4
    ? new RegExp(`(?<![\\w.\\-/:])${homeNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i')
    : undefined

  const files = []
  const dirs = []
  // 扫描覆盖度：**读过哪些、跳过了哪些**必须能报出来。
  //
  // 不报的话，「没扫到」和「没扫」看起来一模一样——报告说「没扫到凭据」，而它实际
  // 只翻了前两千个文件。这类假绿比不扫更糟：它替一个没做过的检查背书。
  let depthReached = 0
  let truncated = false
  const walk = (dir, depth) => {
    if (depth > 6 || files.length > 20000) { truncated = true; return }
    if (depth > depthReached) depthReached = depth
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      const rel = relative(root, full).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (entry.name === '.git') {
          // 根上的 `.git` 是这个仓库自己；子目录里的同一个名字是**另一个仓库**。
          if (rel !== '.git') nestedRepos.push(rel)
          continue
        }
        dirs.push(rel)
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        // 子模块的 `.git` 是**文件**（一行 `gitdir: …`），不是目录——上面那个分支抓不到它。
        if (entry.name === '.git') { nestedRepos.push(rel); continue }
        if (entry.name === '.gitmodules') nestedRepos.push(rel)
        files.push({ rel, name: entry.name, full })
      }
    }
  }
  const nestedRepos = []
  walk(root, 0)
  // `.gitmodules` 与 `.git` 可能指向同一处，去重之后才是一份可读的清单。
  const nestedUnique = [...new Set(nestedRepos.map((p) => p.replace(/\/?\.gitmodules$/, '').replace(/\/?\.git$/, '') || '.'))]
    .filter((p) => p !== '.')

  const ignoredSet = new Set()
  const ignoredTracked = []
  if (canAskGit) {
    const candidates = [...dirs, ...files.map((f) => f.rel)]
    if (candidates.length > 0) {
      const res = await git(root, ['check-ignore', '-z', '--stdin'], { input: `${candidates.join('\0')}\0` })
      // 退出码 1 表示「一条也没命中」，那是正常结果，不是失败。
      if (res.ok || res.status === 1) {
        for (const item of res.stdout.split('\0')) if (item) ignoredSet.add(item)
      }
    }
    // 已入库却又命中忽略规则的：直接从上面那批结果里取，不再跑一次 ls-files。
    for (const p of trackedSet) if (ignoredSet.has(p)) ignoredTracked.push(p)
  }

  let codeFiles = 0
  let docFiles = 0
  let effectiveFiles = 0
  let skippedLargeFiles = 0
  let unreadableFiles = 0
  const secretFiles = []
  const secretContent = []
  const homePathLeaks = []
  const largeFiles = []
  const unignoredOutputDirs = []

  for (const dir of dirs) {
    const leaf = dir.split('/').pop()
    if (OUTPUT_DIRS.has(leaf) && !ignoredSet.has(dir)) unignoredOutputDirs.push(dir)
  }

  for (const file of files) {
    // 「有效文件」：一个目录里只有 `.DS_Store`、`Thumbs.db`、`.vscode/settings.json`
    // 时，它是**空目录**，不是「白纸项目」。这两档的处置完全不同——empty 是
    // 「先让项目存在」，greenfield 是「该做的一次配齐」。
    if (isJunkFile(file.rel)) {
      // 算进总数（它确实在磁盘上），但不算「有效」。
    } else {
      effectiveFiles += 1
      if (CODE_EXT.test(file.name)) codeFiles += 1
      else if (DOC_EXT.test(file.name)) docFiles += 1
    }

    const tracked = trackedSet.has(file.rel)
    const ignored = ignoredSet.has(file.rel)

    let st
    try { st = statSync(file.full) } catch { continue }
    if (st.size >= 20 * 1024 * 1024 && !ignored) {
      largeFiles.push({ file: file.rel, sizeMB: Math.round(st.size / (1024 * 1024)), tracked })
    }

    if (SECRET_FILE_PATTERNS.some((re) => re.test(file.name)) && !SAFE_ENV_EXAMPLES.test(file.name)) {
      // **没有版本库时判不了忽略状态，那是「没查」而不是「没忽略」。** 把这两件事混同，
      // 会让一个刚起步、`.gitignore` 已经写好的项目被报成一堆「未忽略的敏感文件」——
      // 而它其实什么都不缺，只是还没 `git init`。
      //
      // `unverified-large` 是第五种，也是最容易被误读的一种：文件太大没扫内容，所以
      // 「里面有没有真凭据」这件事**没有答案**。把它算进 checked 会让报告说「没扫到凭据」，
      // 而那句话覆盖不到这个文件。它必须单独报出来，由人决定要不要打开看一眼。
      const tooLarge = st.size > 256 * 1024
      const status = !canAskGit ? 'undetermined'
        : tooLarge ? 'unverified-large'
          : tracked ? 'tracked' : (ignored ? 'ignored' : 'exposed')
      secretFiles.push({ file: file.rel, status, sizeKB: Math.round(st.size / 1024) })
      if (tooLarge) skippedLargeFiles += 1
    }

    // 内容扫描只做「已跟踪或未忽略」的文本文件：被忽略的本地文件里出现凭据形状是正常的
    // （那正是它该待的地方），报出来只会制造噪音。
    if (ignored || !TEXT_EXT.test(file.name) || st.size > 256 * 1024) continue
    const text = readTextSafe(file.full)
    if (text === undefined) { unreadableFiles += 1; continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const pat of SECRET_CONTENT_PATTERNS) {
        if (pat.re.test(line)) {
          secretContent.push({ file: file.rel, line: i + 1, kind: pat.label, status: tracked ? 'tracked' : 'exposed' })
        }
      }
      // 行里的分隔符先归一成 `/` 再比：Windows 上一条本机路径在源码里可以写成
      // `C:\Users\…`（反斜杠，还得转义）、`C:/Users/…`（正斜杠）或 `C:\\Users\\…`
      // （字符串字面量里的双反斜杠）。只按一种写法匹配，另外两种就永远扫不到——
      // 而扫不到的表现是「没有泄露」，不是「没查」。
      if (homeRe && homeRe.test(line.replace(/\\\\/g, '/').replace(/\\/g, '/'))) {
        const category = classifyHomePath(file.rel, line)
        if (category) homePathLeaks.push({ file: file.rel, line: i + 1, category })
      }
    }
  }

  return {
    totalFiles: files.length,
    effectiveFiles,
    codeFiles,
    docFiles,
    unignoredOutputDirs,
    ignoredButTracked: ignoredTracked,
    secretFiles,
    secretContent,
    homePathLeaks,
    largeFiles,
    scanCoverage: { truncated, depthReached, skippedLargeFiles, unreadableFiles },
    nestedRepos: nestedUnique,
  }
}

/**
 * 一处本机绝对路径意味着什么，取决于它在哪。
 *
 * 这一条是从误报里学来的：把测试夹具里的假路径报成「泄露」的结果，是每次体检都红一次，
 * 而修它的人做的第一件事是**把那一行改掉**——改掉的正好是一份有用的夹具。
 * 所以分四类，各自处置不同：
 *
 *   - `test-data`：测试、规格、夹具、示例目录里的路径。**这一类不许改**，它是数据；
 *   - `doc-example`：文档正文里的示例路径（`~` 或占位形式）。同理不动；
 *   - `generated`：工作记录、变更记录这类「本来就该写当时现场」的文档。不动；
 *   - `leak`：其余全部。**只有这一档要修**——它会被别人照抄去跑，然后失败。
 */
export function classifyHomePath(rel, line) {
  const path = String(rel ?? '').replace(/\\/g, '/')
  if (/(^|\/)(?:tests?|specs?|__tests__|fixtures?|examples?|__mocks__|testdata)(\/|$)/i.test(path)) return 'test-data'
  if (/\.(?:test|spec)\.[a-z0-9]+$/i.test(path)) return 'test-data'
  if (/(^|\/)(?:docs\/work|docs\/tasks|docs\/adr|work)(\/|$)/i.test(path)) return 'generated'
  if (/^changelog\.md$/i.test(path) || /(^|\/)release-notes\//i.test(path)) return 'generated'
  if (/\.(?:md|mdx|rst|txt)$/i.test(path)) {
    // 文档里出现现场路径，多数是「照着我的机器抄了一遍」的示例，加占位符就能修好；
    // 但它仍然值得看一眼——所以单列一档，不并入 leak 也不并入 test-data。
    if (/[`'"]|<|>|\bexample\b|示例/i.test(line)) return 'doc-example'
    return 'leak'
  }
  return 'leak'
}

// ── 文档与自动化 ────────────────────────────────────────────────────

/**
 * 项目里已有的「别的 AI 约定文件」。
 *
 * 存在两份约定（`CLAUDE.md` 与 `AGENTS.md` 各写一套）时，**两份都会漂**——
 * 而漂的那一份通常是没人读的那一份。所以勘察要把它们全找出来，交给 S2 决定合到哪儿，
 * 而不是当作没看见。
 *
 * 单文件与目录两种形状都要认：`.cursorrules` 是单文件，`.cursor/rules/` 下面是一堆；
 * 各家扩展名不同（`.mdc`、`.md`、`.txt`），所以目录里按「文本文件」挑，不按固定后缀。
 */
function detectOtherAiConventions(root) {
  const singles = [
    'CLAUDE.md', '.clinerules', '.cursorrules', '.windsurfrules', 'CONVENTIONS.md',
    '.github/copilot-instructions.md', 'GEMINI.md', 'COPILOT_INSTRUCTIONS.md',
  ].filter((rel) => existsSync(join(root, rel)))

  const dirs = ['.cursor/rules', '.roo/rules', '.github/instructions']
  const fromDirs = []
  for (const dir of dirs) {
    let names = []
    try { names = readdirSync(join(root, dir), { withFileTypes: true }) } catch { continue }
    for (const entry of names) {
      if (!entry.isFile()) continue
      if (!/\.(?:md|mdc|txt|rules?)$/i.test(entry.name)) continue
      fromDirs.push(`${dir}/${entry.name}`)
    }
  }
  return [...singles, ...fromDirs]
}

function detectDocs(root) {
  let entries = []
  try { entries = readdirSync(root) } catch { /* 空目录 */ }
  const find = (name) => entries.find((e) => e.toLowerCase() === name.toLowerCase())

  const readmes = entries.filter((e) => /^readme(?:\.[a-z0-9_-]+)?\.md$/i.test(e))
  const agents = find('AGENTS.md')
  const contributing = find('CONTRIBUTING.md')
  // 发版规范不止一个名字。只认 `RELEASING.md` 会让一个写着 `RELEASE.md` 或
  // `docs/releasing.md` 的项目被判成「没有发版规范」，然后被劝去新建一份——
  // 结果是两份规范并存，改哪一份都有另一半没跟上。
  const releasing = ['RELEASING.md', 'RELEASE.md', 'RELEASING.rst', 'docs/RELEASING.md', 'docs/releasing.md']
    .find((rel) => existsSync(join(root, rel)))
  const changelog = ['CHANGELOG.md', 'CHANGELOG.rst', 'CHANGES.md', 'HISTORY.md']
    .find((rel) => existsSync(join(root, rel)))
  const license = entries.find((e) => /^licen[cs]e(?:\..+|-.*)?$/i.test(e))

  // 「别的 AI 约定文件」要**展开到具体文件**，不能只报一个目录名。
  //
  // 报 `.cursor/rules` 这么个名字，读的人拿不到任何可行动的信息：那个目录里有几条规则、
  // 讲的是什么，全得自己去看。而合流这件事的第一步恰恰是「逐条读一遍」。
  // 目录里的规则文件也不止 `.mdc` 一种，各家扩展名不同，所以按「列目录、挑文本文件」处理。
  const otherAiConventions = detectOtherAiConventions(root)

  const wfDir = join(root, '.github', 'workflows')
  const workflows = []
  const workflowFacts = {
    hasCheck: false,
    hasRelease: false,
    usesPullRequestTarget: false,
    checkoutsPrHead: false,
    hasContentsWrite: false,
  }
  if (existsSync(wfDir)) {
    let names = []
    try { names = readdirSync(wfDir) } catch { /* 读不到目录 */ }
    for (const name of names) {
      if (!/\.ya?ml$/i.test(name)) continue
      workflows.push(name)
      const text = readTextSafe(join(wfDir, name)) ?? ''
      // 「有检查」的判据是它真的跑了一条验证类命令，而不是它叫 check。
      if (/\b(?:test|check|lint|preflight|verify|build)\b/i.test(text)) workflowFacts.hasCheck = true
      if (/\b(?:gh\s+release|npm\s+publish|twine\s+upload|cargo\s+publish|pypi-publish|vsce\s+publish)\b/i.test(text)) {
        workflowFacts.hasRelease = true
      }
      if (/pull_request_target/.test(text)) workflowFacts.usesPullRequestTarget = true
      // 判的是**配对**：拿到了能写仓库的令牌，又去检出提案那边的代码，才是危险形状。
      // 只用了这个触发器打标签、评论是合法用法，按关键词判会误报。
      if (/github\.event\.pull_request\.(?:head\.(?:sha|ref)|number)/.test(text)) {
        workflowFacts.checkoutsPrHead = true
      }
      if (/permissions:[\s\S]{0,160}contents:\s*write/.test(text)) workflowFacts.hasContentsWrite = true
    }
  }

  const prTemplateFiles = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md']
    .filter((rel) => existsSync(join(root, rel)))
  const issueDir = join(root, '.github', 'ISSUE_TEMPLATE')
  let issueTemplateFiles = []
  if (existsSync(issueDir)) {
    try {
      issueTemplateFiles = readdirSync(issueDir)
        .filter((f) => /\.(?:md|ya?ml)$/i.test(f))
        .map((f) => `.github/ISSUE_TEMPLATE/${f}`)
    } catch { /* 读不到 */ }
  }

  return {
    readmes,
    readme: readmes[0],
    readmePair: readmes.length > 1,
    agents: agents ? { file: agents } : undefined,
    contributing,
    releasing,
    changelog,
    license,
    otherAiConventions,
    workflows,
    workflowFacts,
    prTemplate: prTemplateFiles.length > 0,
    prTemplateFile: prTemplateFiles[0],
    issueTemplates: issueTemplateFiles.length > 0,
    issueTemplateFiles,
  }
}

// ── 既有约定：从项目现状读，不写死 ──────────────────────────────────

const WORK_DIR_CANDIDATES = ['docs/work', 'docs/tasks', 'docs/adr', 'todo', 'work']

/**
 * 项目自己的既有约定。
 *
 * 这些取值**只在两种地方出现**：生成契约时填进去，以及体检时用来核对。把它们写死在
 * 文档里（「默认分支是 main」「说明放 docs/release-notes/」）的代价是：一份对着存量
 * 仓库跑的流程，会要求一个把默认分支叫 `trunk`、把变更记录放根目录 `CHANGELOG.md`
 * 的项目改掉它原本正确的做法。
 *
 * 每一条都给「读不到时的默认值」——不是猜，是**新项目的合理起点**。
 */
function detectConventions(root, { gitFacts, docs, ecosystem }) {
  const currentBranch = gitFacts.branch && gitFacts.branch !== '(detached)' ? gitFacts.branch : undefined
  const defaultBranch = gitFacts.originHeadBranch
    || (currentBranch && LIKELY_DEFAULT_BRANCHES.includes(currentBranch) ? currentBranch : undefined)
    || gitFacts.initDefaultBranch
    || 'main'

  const releaseNotesMode = docs.changelog ? 'changelog' : 'dir'

  // 标签前缀：默认带 `v`，两个例外把它变成裸版本号。
  //   - 命中要求裸版本号的生态（Obsidian 一类插件市场）；
  //   - 历史标签本来就全是裸数字——那是项目已经选定的形状，不该被改。
  const kinds = ecosystem.kinds ?? []
  const needsBareTag = kinds.some((k) => k === 'obsidian-plugin')
  const bareHistory = (gitFacts.tags ?? []).length > 0
    && (gitFacts.tags ?? []).every((t) => /^\d+\.\d+/.test(t))
  const tagPrefix = needsBareTag || bareHistory ? '' : 'v'

  const workDir = WORK_DIR_CANDIDATES.find((rel) => existsSync(join(root, rel))) ?? 'docs/work'

  return {
    defaultBranch,
    releaseNotesMode,
    tagPrefix,
    commitStyle: gitFacts.commitStyle ?? 'plain',
    workDir,
    workflowTooling: detectWorkflowTooling(root),
  }
}

/**
 * 项目已经在用的发版与提交工具链。
 *
 * 探它只为一件事：**写契约时别跟项目自己的工具打架**。一个用 changesets 的项目，
 * 发布流程是「改 changeset → 合并 → CI 出 PR」；照着模板默认那句「先写说明、再打标签」
 * 写，写出来的是一份没人能照做的规范。而工具名一旦写进文档又没人核对，它就会一直错下去。
 *
 * 只报**文件名**，不猜它怎么配——判据要人能一眼核。
 * 这几种形状是各家工具的固定约定文件，不是本项目自定的规矩，所以写死在这里没有问题。
 */
function detectWorkflowTooling(root) {
  const found = []
  const singles = [
    'release-please-config.json', '.releaserc', '.releaserc.json', '.releaserc.yml',
    'commitlint.config.js', 'commitlint.config.cjs', 'commitlint.config.mjs',
    'lefthook.yml', 'lefthook.yaml',
  ]
  for (const rel of singles) if (existsSync(join(root, rel))) found.push(rel)
  for (const dir of ['.changeset', '.husky']) {
    if (existsSync(join(root, dir))) found.push(`${dir}/`)
  }
  return found
}

// ── 多包、产物、本地 skills ──────────────────────────────────────────

function detectWorkspace(root) {
  const cargo = readTextSafe(join(root, 'Cargo.toml')) ?? ''
  const declared = existsSync(join(root, 'pnpm-workspace.yaml'))
    || existsSync(join(root, 'lerna.json'))
    || Boolean(readJsonSafe(join(root, 'package.json'))?.workspaces)
    || (/^\s*\[workspace\]/m.test(cargo))
    || existsSync(join(root, 'go.work'))
  const packages = []
  if (declared) {
    for (const dir of ['packages', 'apps', 'crates', 'workspaces']) {
      const p = join(root, dir)
      if (!existsSync(p)) continue
      try {
        for (const entry of readdirSync(p, { withFileTypes: true })) {
          if (entry.isDirectory()) packages.push(`${dir}/${entry.name}`)
        }
      } catch { /* 读不到 */ }
    }
  }
  return { declared, packages: packages.slice(0, 50) }
}

function detectArtifacts(root, ecosystem) {
  const hooks = []
  const pkg = readJsonSafe(join(root, 'package.json'))
  if (pkg?.scripts) {
    for (const key of ['preinstall', 'postinstall', 'prepare']) {
      if (typeof pkg.scripts[key] === 'string') hooks.push(`${key}: ${pkg.scripts[key]}`)
    }
  }
  return {
    heavyDirsPresent: ['dist', 'build', 'out', 'target'].filter((d) => existsSync(join(root, d))),
    installHooks: hooks,
    hasNpmIgnore: existsSync(join(root, '.npmignore')),
    runtimeRequirements: ecosystem.runtimeRequirements,
    publishableManifest: ecosystem.publishable
      ? { ecosystem: ecosystem.kinds[0], file: ecosystem.manifests[0] }
      : undefined,
  }
}

/** 仓库自带的本地 skills。盘点它们是为了**不误删**——它们是项目的一部分，不是痕迹。 */
function detectLocalSkills(root) {
  const found = []
  for (const dir of ['.dsh/skills', 'skills', '.claude/skills', '.github/skills']) {
    const full = join(root, dir)
    if (!existsSync(full)) continue
    let entries = []
    try { entries = readdirSync(full, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const sub = join(full, entry.name)
      if (!existsSync(join(sub, 'SKILL.md')) && !existsSync(join(sub, 'skill.md'))) continue
      const meta = detectSkillKind(sub)
      found.push({
        path: `${dir}/${entry.name}`,
        name: meta?.skillMeta?.name,
        valid: meta?.skillMeta?.hasValidFrontmatter === true,
      })
    }
  }
  return found
}

// ── 成熟度与缺口 ────────────────────────────────────────────────────

/**
 * 成熟度是**一个值**，不是评分。它回答「这次该用多大的力气」。
 * 分成四档而不是打分，是因为打分要维护权重，而权重没有事实来源；
 * 四档各自对应一套动作，读的人一眼知道下一步。
 *
 * ## `mature` 意味着「这次只体检」，所以它的门槛必须高
 *
 * 早先的判据是「有 git + 有 README 或 AGENTS.md + 有远端 + 有 CI」。那个条件放过了
 * 一类仓库：有 README、有远端、有 CI，但**完全没有 AGENTS.md**、没有 `.gitattributes`，
 * 甚至带着未忽略的产物目录或已入库的凭据。它们被报成 `mature`，于是这次治理只跑体检，
 * 而缺的那几件事一件都没做——`mature` 的定义是「该有的都有，只体检」，缺东西就不是它。
 *
 * 现在的判据是**项目类缺口为空**：本机事实（署名、凭据助手、gh 登录态）不算——
 * 那些换台机器就变，把它们算进去会让每一次全新克隆都判不成 mature。
 */
function judgeMaturity(facts) {
  if (facts.scale.effectiveFiles === 0 && facts.scale.totalFiles === 0) return 'empty'
  // 只有 `.DS_Store`、`.vscode/settings.json` 这类文件的目录，是**空目录**而不是白纸项目：
  // 判成 greenfield 会让人以为「这里已经有东西了，只差配工程设施」。
  if (facts.scale.effectiveFiles === 0 && (facts.git.commits ?? 0) === 0) return 'empty'

  const hasGit = facts.git.present === true && facts.git.isRepoRoot !== false
  // 「起步了没有」只要有一份就够。缺另一份是**缺口**，由 `projectGaps` 负责挡住
  // `mature`，不该把整档打到 greenfield——那是「白纸」的意思，而它显然不是白纸。
  const hasDocs = Boolean(facts.docs.agents || facts.docs.readme)
  if (!hasGit || !hasDocs) return 'greenfield'

  const projectGaps = facts.projectGaps ?? []
  const hasRemote = typeof facts.git.remote === 'string' && facts.git.remote.length > 0
  if (hasRemote && facts.projectGapsComputed
    && facts.docs.workflowFacts.hasCheck && facts.ignores.hasGitattributes
    && projectGaps.length === 0) return 'mature'
  return 'partial'
}

/**
 * 缺口清单只放「不做就会出事」的东西，**不放偏好**。
 * 单语 README、没有贡献指南、没有 CI 都不是缺口——把偏好写成缺口，
 * 会让每个项目都欠一笔永远还不完的债，而还的方式是加 flag 把它压下去。
 */
function judgeGaps(facts) {
  const gaps = []
  const questions = []

  if (facts.git.available === false) {
    gaps.push('这台机器上找不到 git —— 版本管理这一整条路暂时走不了')
  } else if (facts.git.isBare === true) {
    // 裸仓库没有工作区。早先它被判成 present:false，于是缺口写着「还没有版本库」，
    // 下一步就会有人在这里 `git init` —— 而它明明已经是一个仓库。
    gaps.push('这是一个**裸仓库**：没有工作区，改文件的地方根本不存在。要先克隆出工作区再改')
  } else if (facts.git.present === true && facts.git.isRepoRoot === false) {
    gaps.push(`这个目录在外层仓库 \`${facts.git.workTreeRoot}\` 里面，不是仓库根 —— 边界没说清之前不能提交或推送`)
    questions.push('这个目录该并入外层仓库，还是在这里单独建一个仓库？')
  } else if (facts.git.present !== true) {
    gaps.push('还没有版本库')
  }

  if ((facts.git.nestedRepos ?? []).length > 0) {
    gaps.push(`子目录里还有独立仓库（${facts.git.nestedRepos.slice(0, 3).join('、')}）—— 父目录建库会把它们变成「看着像目录、其实是独立仓库」的东西，两边的提交互不可见`)
    questions.push('这些子仓库该当子模块、各自独立，还是并入父仓库？三种处置互相不兼容，选错要拆历史')
  }

  if (facts.git.present === true) {
    if (!facts.git.identity?.name) gaps.push('提交署名缺 `user.name`')
    if (!facts.git.identity?.email) gaps.push('提交署名缺 `user.email`')
    if (facts.git.isShallow === true) {
      gaps.push('这是**浅克隆**（`--depth`）—— 扫历史找凭据会漏，而漏的方式是「看起来干净」')
    }
  }

  for (const dir of facts.ignores.unignoredOutputDirs) {
    gaps.push(`依赖或产物目录没有被忽略：\`${dir}\``)
  }
  if (facts.ignores.ignoredButTracked.length > 0) {
    gaps.push(`有 ${facts.ignores.ignoredButTracked.length} 个已入库文件同时命中忽略规则 —— 忽略规则对已入库的文件无效`)
  }

  const trackedFiles = facts.risks.secretFiles.filter((f) => f.status === 'tracked')
  const exposedFiles = facts.risks.secretFiles.filter((f) => f.status === 'exposed')
  const trackedContent = facts.risks.secretContent.filter((c) => c.status === 'tracked')
  if (trackedFiles.length > 0 || trackedContent.length > 0) {
    const where = [
      ...trackedFiles.map((f) => f.file),
      ...trackedContent.map((c) => `${c.file}:${c.line}`),
    ]
    gaps.push(`凭据形状的东西已经在版本库里了（${where.join('、')}）—— 改文件不够，要轮换并把历史处理掉`)
  }
  if (exposedFiles.length > 0) {
    gaps.push(`有未忽略的敏感文件：${exposedFiles.map((f) => f.file).join('、')}`)
  }

  if (!facts.docs.readme) gaps.push('没有 README —— 别人打开仓库第一眼没有说明')
  // AGENTS.md 不是「偏好」：没有它，AI 每次新开会话都要重新摸一遍这个项目，
  // 而摸出来的结论每次都可能不同。有仓库、有 README、却没有契约，是一处真缺口。
  if (!facts.docs.agents && facts.scale.effectiveFiles > 0) {
    gaps.push('没有 AGENTS.md —— AI 每次新开会话都要重新摸一遍这个项目，摸出来的结论每次可能不同')
  }
  // `.gitattributes` 也一樣：它必须在**首次提交之前**就位，晚了要重新规范化整个工作区。
  if (facts.git.present === true && !facts.ignores.hasGitattributes && (facts.git.trackedFiles ?? 0) > 0) {
    gaps.push('没有 `.gitattributes` —— 跨平台协作时同一份文件在两台机器上算出不同的字节，而已经入库的文件要重新规范化')
  }
  if (!facts.docs.license) {
    gaps.push('没有 LICENSE')
    questions.push('这个项目要不要公开授权？要的话选哪个许可证（MIT / Apache-2.0 / BSD-3-Clause）；不要就明确不放')
  }
  if (facts.docs.workflowFacts.usesPullRequestTarget && facts.docs.workflowFacts.checkoutsPrHead) {
    gaps.push('工作流用了 `pull_request_target` 又检出了提案那边的代码 —— 这等于让任意陌生人拿你的密钥跑他的代码')
  }

  if (facts.ecosystem.publishable && facts.ecosystem.kinds.includes('node')) {
    questions.push('这个项目要不要发到 npm？不发就补上 `private: true` 防误发')
  }
  if (facts.ecosystem.kinds.includes('unknown')) {
    questions.push('认不出这是什么项目。它是什么形态（命令行工具 / 库 / 服务 / 文档 / 插件）？')
  }
  // 角色比不出来时，把问题问清楚。这一条不是格式检查，是**权限问题**：
  // 判不出「这是不是正本」，下一步该推主干还是开 PR 就没有依据。
  if (facts.git.present === true && typeof facts.git.remote === 'string' && facts.git.remote.length > 0
    && facts.git.role === 'undetermined') {
    questions.push('本地远端是不是这个项目的正本？项目里没有声明源仓库（清单的 repository 一类），'
      + '所以比不出来——说不清的话，按贡献者处置（拉分支、开 PR），不推主干、不打标签')
  }

  // 被算进成熟度的那一部分：**跟着仓库走**的东西。本机事实（署名、凭据助手、
  // gh 登录态）不进来——它们在干净克隆里必然缺失，判进去会让每次新机器上的检查都红一次。
  const machineLocal = [
    '提交署名缺 `user.name`',
    '提交署名缺 `user.email`',
    '这台机器上找不到 git —— 版本管理这一整条路暂时走不了',
  ]
  const projectGaps = gaps.filter((g) => !machineLocal.includes(g))

  return { gaps, questions, projectGaps }
}

// ── 主流程 ──────────────────────────────────────────────────────────

export async function survey(targetDir = process.cwd(), opts = {}) {
  const root = resolve(targetDir)
  if (!existsSync(root)) throw new Error(`目标目录不存在：${root}`)

  const gitFacts = await detectGit(root, { probeAuth: opts.probeAuth === true })
  const ecosystem = detectEcosystem(root)
  const taskCommands = detectTaskEntries(root)
  const ws = await walkWorkspace(root, gitFacts)
  const docs = detectDocs(root)
  const conventions = detectConventions(root, { gitFacts, docs, ecosystem })

  // 任务入口先落，生态命令补在它后面：Makefile 里那条 `test` 是这个项目自己写下的，
  // 比按生态惯例推出来的更贴近事实。
  const commands = { ...ecosystem.commands, ...taskCommands }
  const commandsByEcosystem = { ...ecosystem.commandsByEcosystem }
  if (Object.keys(taskCommands).length > 0) commandsByEcosystem.task = taskCommands

  let kinds = ecosystem.kinds
  if (kinds.length === 0) {
    if (ws.codeFiles === 0 && ws.docFiles > 0 && docs.readme) kinds = ['docs-only']
    else if (ws.totalFiles === 0) kinds = ['empty']
    else kinds = ['unknown']
  }

  const role = judgeRole(gitFacts, ecosystem.declaredRepo)

  const facts = {
    target: { path: root, name: ecosystem.projectName, dirName: basename(root) },
    maturity: 'partial',
    git: {
      available: gitFacts.available,
      present: gitFacts.present,
      isRepoRoot: gitFacts.isRepoRoot,
      isBare: gitFacts.isBare ?? false,
      isShallow: gitFacts.isShallow ?? false,
      nestedRepos: gitFacts.present === true ? (gitFacts.nestedRepos ?? ws.nestedRepos ?? []) : [],
      workTreeRoot: gitFacts.workTreeRoot,
      branch: gitFacts.branch,
      upstream: gitFacts.upstream,
      ahead: gitFacts.ahead ?? 0,
      behind: gitFacts.behind ?? 0,
      dirty: gitFacts.dirty ?? 0,
      remote: gitFacts.remote,
      remotes: gitFacts.remotes ?? [],
      remoteUrls: gitFacts.remoteUrls ?? {},
      remoteProtocol: gitFacts.remoteProtocol,
      identity: gitFacts.identity,
      tags: gitFacts.tags ?? [],
      historyAuthors: gitFacts.historyAuthors ?? [],
      commits: gitFacts.commits,
      commitsState: gitFacts.commitsState ?? 'ok',
      trackedFiles: gitFacts.trackedFiles ?? 0,
      head: gitFacts.head,
      initDefaultBranch: gitFacts.initDefaultBranch,
      originHeadBranch: gitFacts.originHeadBranch,
      auth: gitFacts.auth,
      declaredRepo: ecosystem.declaredRepo,
      role: role.role,
      roleReason: role.reason,
    },
    ecosystem: {
      kinds,
      manifests: ecosystem.manifests,
      packageManager: ecosystem.packageManager,
      publishable: ecosystem.publishable && !ecosystem.private,
      private: ecosystem.private,
      registryFree: ecosystem.registryFree,
      declaredVersion: ecosystem.declaredVersion,
      declaredRepo: ecosystem.declaredRepo,
      skillMeta: ecosystem.skillMeta,
      subdirs: ecosystem.subdirs,
    },
    commands,
    commandsByEcosystem,
    conventions,
    workspace: detectWorkspace(root),
    artifacts: detectArtifacts(root, ecosystem),
    localSkills: detectLocalSkills(root),
    docs,
    ignores: {
      hasGitignore: existsSync(join(root, '.gitignore')),
      hasGitattributes: existsSync(join(root, '.gitattributes')),
      unignoredOutputDirs: ws.unignoredOutputDirs,
      ignoredButTracked: ws.ignoredButTracked,
    },
    outputs: {
      heavyDirsPresent: [],
      knownOutputDirs: ws.unignoredOutputDirs,
    },
    risks: {
      secretFiles: ws.secretFiles,
      secretContent: ws.secretContent,
      homePathLeaks: ws.homePathLeaks,
      largeFiles: ws.largeFiles,
      scanCoverage: ws.scanCoverage,
    },
    scale: {
      totalFiles: ws.totalFiles,
      effectiveFiles: ws.effectiveFiles,
      codeFiles: ws.codeFiles,
      docFiles: ws.docFiles,
    },
    gaps: [],
    questions: [],
  }
  facts.outputs.heavyDirsPresent = facts.artifacts.heavyDirsPresent

  // 项目类缺口与「本机事实」分开记：成熟度只由前者决定，后者换台机器就变。
  // 混在一起时，一次全新克隆会因为「署名没配」被判成不够成熟——而项目本身完全健康。
  //
  // **顺序不能反**：先算缺口，再定成熟度。`projectGaps` 为空这件事本身就是 `mature`
  // 的一个条件，先算成熟度会拿一个还没算出来的值去判。
  const verdict = judgeGaps(facts)
  facts.gaps = verdict.gaps
  facts.questions = verdict.questions
  facts.projectGaps = verdict.projectGaps
  facts.projectGapsComputed = true
  facts.maturity = judgeMaturity(facts)

  delete gitFacts._hasGit
  delete gitFacts._ignoreProbeOk
  return facts
}

/**
 * 角色决定「能做到哪一步」，所以默认值必须是保守的那一档。
 * `undetermined` 不是「维护者」——它的意思是「比不出来」，按贡献者处置。
 */
function judgeRole(gitFacts, declaredRepo) {
  if (gitFacts.present !== true || !gitFacts.remote) {
    return { role: 'maintainer', reason: '没有远端：本地提交不涉及别人的仓库' }
  }
  const origin = githubRepoPath(gitFacts.remoteUrls?.origin ?? gitFacts.remote)
  const upstream = githubRepoPath(gitFacts.remoteUrls?.upstream)
  if (!origin) return { role: 'undetermined', reason: '远端不是能认出来的 GitHub 地址，比不了' }
  if (upstream && upstream !== origin) {
    return { role: 'contributor-fork', reason: `origin 指向 ${origin}，而 upstream 指向 ${upstream}` }
  }
  if (declaredRepo && declaredRepo !== origin) {
    return { role: 'contributor-fork', reason: `项目声明的源仓库是 ${declaredRepo}，而 origin 是 ${origin}` }
  }
  if (!declaredRepo) {
    return { role: 'undetermined', reason: '项目没有声明源仓库，比不出 origin 是不是正本' }
  }
  return { role: 'maintainer', reason: `origin 就是项目声明的源仓库 ${origin}` }
}

export { readTextSafe, readJsonSafe, samePath, githubRepoPath }

// ── 命令行 ──────────────────────────────────────────────────────────

async function main(argv) {
  let target = process.cwd()
  let format = 'json'
  let probeAuth = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/survey.mjs [目标目录] [选项]',
        '',
        '  --markdown     输出给人读的报告（默认输出 JSON）',
        '  --probe-auth   额外问一次凭据助手（慢几百毫秒，默认不问）',
        '',
        '只读：不写任何文件。',
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--markdown' || arg === '--md') format = 'markdown'
    else if (arg === '--json') format = 'json'
    else if (arg === '--probe-auth') probeAuth = true
    else if (!arg.startsWith('-')) target = arg
    else {
      process.stderr.write(`未知选项：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    const facts = await survey(target, { probeAuth })
    process.stdout.write(format === 'markdown'
      ? toMarkdown(facts)
      : `${JSON.stringify(facts, null, 2)}\n`)
    return 0
  } catch (err) {
    process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
