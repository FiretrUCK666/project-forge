/**
 * fixtures-worktree-policy-v2.mjs —— Wave 2 (C7..C9) 正反双向行为断言：
 *   - C7: Class R/S/I 并发依赖引擎、仓外只读 dep-pool、Windows NTFS 撤只读位清理、毒化探测、detach/reconcile 与引用计数 GC；
 *   - C8: computeWorktreeEnv 缓存重定向与 Windows .cmd/.bat CVE-2024-27980 两层精准硬化 + execSafe 永不抛异常；
 *   - C9: workflow-policy 单向门扩展、resolveScopedVerificationGate dirRel/ecosystems 修复与 intake contextBasis 防脏写。
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { blockedExitOf, EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { computeWorktreeEnv, execSafe, prepareExecInvocation } from '../../kit/skills/lib/exec.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { parseAgentsProfile, parseDevProfile } from '../../kit/skills/lib/profile.mjs'
import { determineWorkflowPolicy, isOneWayBoundaryFile, resolveScopedVerificationGate } from '../../kit/skills/lib/workflow-policy.mjs'
import { handleIntake } from '../../kit/skills/dev-flow/scripts/flow-intake.mjs'
import { mountSharedDeps, scanOutboundLinks, unmountSharedDeps } from '../../kit/skills/dev-flow/scripts/worktree-deps.mjs'
import { gitInit, gitSync, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = (c) => { out += String(c); return true }
  process.stderr.write = (c) => { err += String(c); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function registerWorktreePolicyV2Cases(cases) {
  cases.push(['[C7] Class R/S/I 三类依赖池、Windows 只读清理防 EPERM、毒化隔离与 detach/reconcile/GC', async () => {
    const poolMod = await import('../../kit/skills/lib/worktree-dep-pool.mjs')
    const {
      classifyHeavyDir,
      detachWorktreeUnit,
      gcUnusedDepPools,
      reconcileWorktreeDeps,
      removeReadOnlyTreeSync,
      resolveDepPoolRoot,
    } = poolMod

    // 1. removeReadOnlyTreeSync 直接实测（含只读文件 0o444 与只读目录 0o555）
    const roRoot = tmpProject({ 'nested/locked.txt': 'ro-data\n' })
    const roSub = join(roRoot, 'nested')
    const roFile = join(roSub, 'locked.txt')
    try {
      chmodSync(roFile, 0o444)
      if (process.platform !== 'win32') chmodSync(roSub, 0o555)
      const preRes = removeReadOnlyTreeSync(roRoot, { dryRunRm: true })
      if (preRes.unprotectedFiles < 1 || (statSync(roFile).mode & 0o222) === 0) {
        return `removeReadOnlyTreeSync 未先解除只读位防 Windows NTFS EPERM：${JSON.stringify(preRes)} mode=${statSync(roFile).mode.toString(8)}`
      }
      chmodSync(roFile, 0o444)
      if (process.platform !== 'win32') chmodSync(roSub, 0o555)
      removeReadOnlyTreeSync(roRoot)
      if (existsSync(roRoot)) return `removeReadOnlyTreeSync 未彻底删除只读目录树：${roRoot}`
    } finally {
      if (existsSync(roRoot)) {
        try { chmodSync(roSub, 0o777) } catch { /* ignore */ }
        try { chmodSync(roFile, 0o666) } catch { /* ignore */ }
        rmTree(roRoot)
      }
    }

    // 2. Class I 分类校验（构建产物与 DB/NoSQL 卷绝不共享）
    for (const ci of ['dist', 'build', 'target', '.next', '.dart_tool', 'pg_data', 'redis_data', 'mongo_data', 'volumes', '.qdrant', '.chroma', 'data.sqlite']) {
      if (classifyHeavyDir(ci) !== 'I') return `Class I 路径分类错误：${ci} -> ${classifyHeavyDir(ci)}`
    }

    // 3. Class R（pnpm + Rust + Go）：绝不软链 node_modules，返回 class-r-global-store 与环境变量提示
    const rDir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\ntarget/\n',
      'package.json': '{"name":"r-app","dependencies":{"vite":"^5.0.0"}}\n',
      'pnpm-lock.yaml': 'lockfileVersion: "9.0"\n',
      'vite.config.ts': 'export default {}\n',
      'Cargo.toml': '[package]\nname = "r-app"\nversion = "0.1.0"\n',
      'go.mod': 'module example.com/r\ngo 1.22\n',
    })
    gitInit(rDir, { branch: 'main' })
    mkdirSync(join(rDir, 'node_modules', '.pnpm', 'vite'), { recursive: true })
    writeFileSync(join(rDir, 'node_modules', '.pnpm', 'vite', 'index.js'), '1\n')
    try {
      const wtR = join(rDir, '.worktrees', 'impl-r')
      gitSync(rDir, ['worktree', 'add', '-b', 'feat/r', wtR, 'HEAD'])
      const mR = mountSharedDeps(rDir, wtR)
      if (mR.mode !== 'class-r-global-store') return `Class R 仓未返回 class-r-global-store：${JSON.stringify(mR)}`
      if (existsSync(join(wtR, 'node_modules'))) return 'Class R pnpm 仓不应软链主仓 node_modules'
      if (mR.envHints?.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN !== 'false' || mR.envHints?.npm_config_verify_deps_before_run !== 'false') {
        return `Class R 缺少 pnpm 环境变量提示：${JSON.stringify(mR.envHints)}`
      }
      if (!mR.envHints?.CARGO_TARGET_DIR || !mR.hints?.some((h) => h.includes('server.fs.allow'))) {
        return `Class R 缺少 CARGO_TARGET_DIR 或 Vite server.fs.allow 提示：${JSON.stringify(mR)}`
      }
    } finally { rmTree(rDir) }

    // 4. Class S 仓外只读 dep-pool、worktree-shared-readonly、refcount GC 与损坏索引重建、reconcile/detach
    const sDir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\nassets-cache/\npg_data/\n',
      'AGENTS.md': [
        '# s-demo',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: exit 0',
        'full-test: exit 0',
        'smoke-verify: none',
        'merge-gate: exit 0',
        'arch-rules: none',
        'high-risk: AGENTS.md',
        'do-not-edit: docs/archive/',
        'worktree-shared-readonly: assets-cache, pg_data',
        '```',
      ].join('\n'),
      'package.json': '{"name":"s-demo","dependencies":{"lodash":"^4.17.21"}}\n',
      'package-lock.json': '{"name":"s-demo","lockfileVersion":3}\n',
    })
    gitInit(sDir, { branch: 'main' })
    mkdirSync(join(sDir, 'node_modules', 'lodash'), { recursive: true })
    writeFileSync(join(sDir, 'node_modules', 'lodash', 'index.js'), 'module.exports = 42\n')
    mkdirSync(join(sDir, 'assets-cache'), { recursive: true })
    writeFileSync(join(sDir, 'assets-cache', 'blob.bin'), 'cached-ro\n')
    mkdirSync(join(sDir, 'pg_data'), { recursive: true })
    writeFileSync(join(sDir, 'pg_data', 'PG_VERSION'), '16\n')
    try {
      const prof = parseAgentsProfile(sDir)
      const devProf = parseDevProfile(sDir)
      if (!prof.worktreeSharedReadonly?.includes('assets-cache') || !devProf['worktree-shared-readonly']?.includes('assets-cache')) {
        return `profile.mjs 未解析 worktree-shared-readonly：${JSON.stringify(prof.worktreeSharedReadonly)}`
      }

      const wt1 = join(sDir, '.worktrees', 'impl-s1')
      const wt2 = join(sDir, '.worktrees', 'impl-s2')
      gitSync(sDir, ['worktree', 'add', '-b', 'feat/s1', wt1, 'HEAD'])
      gitSync(sDir, ['worktree', 'add', '-b', 'feat/s2', wt2, 'HEAD'])

      const m1 = mountSharedDeps(sDir, wt1)
      const m2 = mountSharedDeps(sDir, wt2)
      if (m1.mode !== 'shared' && m1.mode !== 'partial') return `Class S mount 模式异常：${JSON.stringify(m1)}`
      if (!existsSync(join(wt1, 'node_modules', 'lodash', 'index.js'))) return 'Class S node_modules 未挂载可读'
      if (!existsSync(join(wt1, 'assets-cache', 'blob.bin'))) return 'worktree-shared-readonly 自定义只读目录未挂载'
      if (existsSync(join(wt1, 'pg_data'))) return 'Class I 数据卷 pg_data 竟被误挂载进 worktree'

      const poolRoot = resolveDepPoolRoot(sDir)
      const nmReal = realpathSync.native(join(wt1, 'node_modules'))
      if (!nmReal.toLowerCase().replace(/\\/g, '/').includes(poolRoot.toLowerCase().replace(/\\/g, '/'))) {
        return `Class S 未指向仓外 dep-pool（仍直连主仓）：nmReal=${nmReal}, poolRoot=${poolRoot}`
      }
      const pooledFileStat = statSync(join(nmReal, 'lodash', 'index.js'))
      if ((pooledFileStat.mode & 0o222) !== 0) {
        return `dep-pool 文件未置只读位：mode=${pooledFileStat.mode.toString(8)}`
      }

      // cleanup 档应放行 dep-pool 挂载为 tool-mounted
      const scan1 = scanOutboundLinks(wt1)
      if (!scan1.outbound.some((l) => l.path === 'node_modules')) return `scanOutboundLinks 未发现 dep-pool 外链：${JSON.stringify(scan1)}`
      const dryClean = unmountSharedDeps(sDir, wt1, { mode: 'cleanup', mountedPaths: m1.mountedPaths, dryRun: true })
      if (!dryClean.ok || dryClean.blocked.length > 0) return `unmountSharedDeps 未放行 dep-pool 为 tool-mounted：${JSON.stringify(dryClean)}`

      // 漂移自愈：改 wt1 锁文件后 reconcile 自动脱钩 node_modules
      writeFileSync(join(wt1, 'package-lock.json'), '{"name":"s-demo","lockfileVersion":3,"v":2}\n')
      const rec = reconcileWorktreeDeps(sDir, wt1)
      if (!rec.detached?.includes('node_modules') || lstatSync(join(wt1, 'node_modules'), { throwIfNoEntry: false })) {
        return `reconcileWorktreeDeps 未自动脱钩漂移依赖：${JSON.stringify(rec)}`
      }

      // detach 指定单元
      const det = detachWorktreeUnit(sDir, wt1, { unit: 'assets-cache' })
      if (!det.ok || lstatSync(join(wt1, 'assets-cache'), { throwIfNoEntry: false })) {
        return `detachWorktreeUnit 未脱钩 assets-cache：${JSON.stringify(det)}`
      }

      // pool-refs.json 损坏时 GC 必须先扫描活跃 worktree (wt2) 重建计数，绝不误删 wt2 仍在用的池
      writeFileSync(join(poolRoot, 'pool-refs.json'), '{CORRUPTED_JSON', 'utf8')
      const gcWhileActive = gcUnusedDepPools(sDir)
      if (!gcWhileActive.rebuilt || !existsSync(nmReal)) {
        return `pool-refs.json 损坏时 GC 误删活跃 worktree 池条目：${JSON.stringify(gcWhileActive)}`
      }

      // 卸载 wt2 后池 refcount=0，GC 经 removeReadOnlyTreeSync 无 EPERM 彻底清理
      const um2 = unmountSharedDeps(sDir, wt2, { mode: 'cleanup', mountedPaths: m2.mountedPaths })
      if (!um2.ok) return `wt2 cleanup 卸载失败：${JSON.stringify(um2)}`
      const gcAfter = gcUnusedDepPools(sDir)
      if (!gcAfter.ok || existsSync(nmReal)) {
        return `refcount=0 后 GC 未清理只读 dep-pool：${JSON.stringify(gcAfter)}`
      }
      if (!existsSync(join(sDir, 'node_modules', 'lodash', 'index.js'))) return 'GC 误伤主仓 node_modules'
    } finally { rmTree(sDir) }

    // 5. 毒化探测：.prisma 生成代码 + POSIX .venv/bin/* 主仓绝对路径 shebang
    const pDir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n.venv/\n',
      'package.json': '{"name":"poison"}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
      'requirements.txt': 'pytest==8.0.0\n',
    })
    gitInit(pDir, { branch: 'main' })
    mkdirSync(join(pDir, 'node_modules', '.prisma', 'client'), { recursive: true })
    writeFileSync(join(pDir, 'node_modules', '.prisma', 'client', 'index.js'), '1\n')
    mkdirSync(join(pDir, '.venv', 'bin'), { recursive: true })
    writeFileSync(join(pDir, '.venv', 'bin', 'pytest'), `#!${join(pDir, '.venv', 'bin', 'python3')}\nimport sys\n`)
    try {
      const wtP = join(pDir, '.worktrees', 'impl-p')
      gitSync(pDir, ['worktree', 'add', '-b', 'feat/p', wtP, 'HEAD'])
      const mP = mountSharedDeps(pDir, wtP)
      if (mP.mode !== 'isolated' || mP.mounted.length !== 0) return `.prisma / POSIX shebang 毒化未隔离：${JSON.stringify(mP)}`
      if (!mP.isolatedUnits.some((u) => u.ecosystem === 'node') || !mP.isolatedUnits.some((u) => u.ecosystem === 'python')) {
        return `毒化隔离记录缺失 node 或 python：${JSON.stringify(mP.isolatedUnits)}`
      }
    } finally { rmTree(pDir) }

    return true
  }])

  cases.push(['[C8] exec.mjs 缓存重定向与 Windows .cmd/.bat CVE-2024-27980 两层硬化及 execSafe 不抛异常', async () => {
    if (blockedExitOf('BLOCKED_UNSAFE_WIN_BATCH_ARG') !== EXIT.USAGE) {
      return `BLOCKED_UNSAFE_WIN_BATCH_ARG 未登记在 USAGE_CODES：${blockedExitOf('BLOCKED_UNSAFE_WIN_BATCH_ARG')}`
    }

    // 1. computeWorktreeEnv 缓存重定向 + pnpm 透传
    const envDir = tmpProject({})
    try {
      const wtEnv = computeWorktreeEnv({ mainRoot: envDir, gitDir: join(envDir, '.git'), taskId: 'c8-cache', slotIndex: 3 })
      for (const k of ['VITE_CACHE_DIR', 'JEST_CACHE_DIR', 'BABEL_CACHE_PATH', 'ESLINT_CACHE_LOCATION', 'CARGO_TARGET_DIR']) {
        if (!wtEnv[k] || !wtEnv[k].includes(wtEnv.PF_CACHE_DIR)) {
          return `computeWorktreeEnv 未将 ${k} 重定向至 PF_CACHE_DIR：${JSON.stringify(wtEnv)}`
        }
      }
      if (wtEnv.PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN !== 'false') {
        return `computeWorktreeEnv 未透传 PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false：${JSON.stringify(wtEnv)}`
      }
    } finally { rmTree(envDir) }

    // 2. Layer 1: npm.cmd / pnpm.cmd 静态解析底层 JS 直调 node（绕过 cmd.exe）
    const binDir = tmpProject({
      'npm.cmd': '@echo off\r\nnode "%~dp0\\node_modules\\npm\\bin\\npm-cli.js" %*\r\n',
      'node_modules/npm/bin/npm-cli.js': 'process.stdout.write("DIRECT_NODE:" + JSON.stringify(process.argv.slice(2)))\n',
      'gh.cmd': '@echo off\r\necho GH_OK %~1 %~2\r\n',
    })
    try {
      const npmCmd = join(binDir, 'npm.cmd')
      const ghCmd = join(binDir, 'gh.cmd')
      const npmInv = prepareExecInvocation(npmCmd, ['--version', 'a"&whoami&"'], { cwd: binDir, platform: 'win32' })
      if (npmInv.cmd !== process.execPath || npmInv.windowsVerbatimArguments !== false || !npmInv.args[0].endsWith('npm-cli.js')) {
        return `npm.cmd 未走第一层直调 node：${JSON.stringify(npmInv)}`
      }

      // Layer 2 正面放行：含空格/括号合法路径与正常测试垫片参数
      const safeInv = prepareExecInvocation(ghCmd, ['C:\\Program Files (x86)\\Tool\\app', '--json', 'state,title', '--format={{.Name}}'], { cwd: binDir, platform: 'win32' })
      if (!safeInv || !safeInv.windowsVerbatimArguments) {
        return `合法含括号路径与垫片参数被误杀：${JSON.stringify(safeInv)}`
      }

      // Layer 2 反面拦截：批处理命令拼接/变量展开/双引号闭合元字符
      for (const badArg of ['a"&whoami&"', 'foo|calc', 'a&b', 'a>out.txt', '%COMSPEC%', 'a^b', '!PATH!', 'line1\nwhoami']) {
        let threw = null
        try {
          prepareExecInvocation(ghCmd, [badArg], { cwd: binDir, platform: 'win32' })
        } catch (err) {
          threw = err
        }
        if (!threw || (threw.blockedCode !== 'BLOCKED_UNSAFE_WIN_BATCH_ARG' && threw.code !== 'BLOCKED_UNSAFE_WIN_BATCH_ARG') || threw.exitCode !== EXIT.USAGE) {
          return `Windows .cmd 注入载荷未拦截 (${JSON.stringify(badArg)})：${threw ? threw.message : '未抛出'}`
        }
      }

      // Layer 3: execSafe 永不抛异常契约（跨平台走 _platform: 'win32' + Windows 真跑 .cmd 实测）
      const blockedCrossPlat = await execSafe(ghCmd, ['a"&whoami&"'], { cwd: binDir, _platform: 'win32' })
      if (blockedCrossPlat.ok !== false || blockedCrossPlat.code !== EXIT.USAGE || blockedCrossPlat.blockedCode !== 'BLOCKED_UNSAFE_WIN_BATCH_ARG') {
        return `execSafe 未在 try/catch 内返回 BLOCKED_UNSAFE_WIN_BATCH_ARG + code=2：${JSON.stringify(blockedCrossPlat)}`
      }
      if (process.platform === 'win32') {
        const directRes = await execSafe(npmCmd, ['--arg', 'a"&whoami&"'], { cwd: binDir })
        if (!directRes.ok || !directRes.stdout.includes('DIRECT_NODE:') || !directRes.stdout.includes('whoami')) {
          return `Windows npm.cmd 直调 node 实测失败：${JSON.stringify(directRes)}`
        }
        const safeGh = await execSafe(ghCmd, ['C:\\Program Files (x86)\\Tool', 'alpha'], { cwd: binDir })
        if (!safeGh.ok || !safeGh.stdout.includes('Program Files (x86)')) {
          return `Windows gh.cmd 放行合法括号路径失败：${JSON.stringify(safeGh)}`
        }
      }
    } finally { rmTree(binDir) }

    return true
  }])

  cases.push(['[C9] workflow-policy 单向门扩展、resolveScopedVerificationGate 修复与 intake contextBasis 防脏写', async () => {
    if (blockedExitOf('BLOCKED_STALE_INTAKE_CONTEXT') !== EXIT.FACT) {
      return `BLOCKED_STALE_INTAKE_CONTEXT 未登记在 FACT_CODES：${blockedExitOf('BLOCKED_STALE_INTAKE_CONTEXT')}`
    }

    // 1. isOneWayBoundaryFile 正反双向
    const mustBeOneWay = [
      'prisma/schema.prisma',
      'drizzle/0001_init.ts',
      'firestore.rules',
      'db/schema.cql',
      'graph/init.cypher',
      'config/redis.conf',
      'qdrant/config.yaml',
      'config/milvus.yml',
      'chroma/settings.json',
      'proto/service.proto',
      'api/schema.graphql',
      'api/queries.gql',
      'docs/openapi.yaml',
      'api/swagger-v2.yml',
      'docker-compose.yml',
      'compose.prod.yaml',
      'k8s/deployment.yaml',
      'helm/values.yaml',
      'infra/main.tf',
      'terraform/prod.tfvars',
    ]
    for (const f of mustBeOneWay) {
      if (!isOneWayBoundaryFile(f)) return `isOneWayBoundaryFile 漏判单向门文件：${f}`
      const pol = determineWorkflowPolicy({ changedFiles: [f], caseType: 2 })
      if (pol.riskTier !== 'high' || !pol.oneWayBoundaryHits.includes(f)) {
        return `determineWorkflowPolicy 未将单向门文件 ${f} 提升为 high：${JSON.stringify(pol)}`
      }
    }
    for (const safeFile of ['src/utils/math.mjs', 'README.md', 'docs/guide.md', 'tests/unit/a.test.mjs']) {
      if (isOneWayBoundaryFile(safeFile)) return `isOneWayBoundaryFile 误判常规文件：${safeFile}`
    }

    // 2. resolveScopedVerificationGate：真实 discoverWorkspacePackages (dirRel + ecosystems) 与 camelCase profile.quickTest
    const monoDir = tmpProject({
      'package.json': '{"name":"mono","private":true}\n',
      'frontend/package.json': '{"name":"web","scripts":{"test":"vitest run"}}\n',
      'frontend/src/App.tsx': 'export const App = () => 1\n',
      'backend/go.mod': 'module example.com/api\ngo 1.22\n',
      'backend/main.go': 'package main\nfunc main() {}\n',
    })
    try {
      const camelProfile = { quickTest: 'pnpm --filter web test && go test ./...' }
      const gate = resolveScopedVerificationGate({
        repoRoot: monoDir,
        changedFiles: ['frontend/src/App.tsx'],
        profile: camelProfile,
      })
      if (!gate.scoped || !gate.repoStacks.includes('go') || !gate.repoStacks.includes('node')) {
        return `resolveScopedVerificationGate 未正确读取 dirRel/ecosystems 或 camelCase quickTest：${JSON.stringify(gate)}`
      }
      if (!gate.affectedPackages.some((p) => p.dir === 'frontend' && p.ecosystem === 'node')) {
        return `affectedPackages 仍坍缩为空 dir/null ecosystem：${JSON.stringify(gate.affectedPackages)}`
      }
      const filtered = gate.filterCommands(['pnpm --filter web test && go test ./...'])
      if (filtered.kept.join('') !== 'pnpm --filter web test' || !filtered.skipped.some((s) => s.stack === 'go')) {
        return `filterCommands 未正确过滤未改栈命令：${JSON.stringify(filtered)}`
      }
      // 旧字段 { dir, ecosystem } 仍向后兼容
      const legacyGate = resolveScopedVerificationGate({
        changedFiles: ['svc/main.go'],
        packages: [{ dir: 'svc', name: 'svc', ecosystem: 'go' }, { dir: 'web', name: 'web', ecosystem: 'node' }],
      })
      if (!legacyGate.scoped || !legacyGate.affectedPackages.some((p) => p.dir === 'svc' && p.ecosystem === 'go')) {
        return `legacy dir/ecosystem 兼容退化：${JSON.stringify(legacyGate)}`
      }
    } finally { rmTree(monoDir) }

    // 3. intake contextBasis SHA-256 防脏写复核 + 帮助文案 + subcommand-parity
    const { computeIntakeContextBasis } = await import('../../kit/skills/lib/intake-triage.mjs')
    const b1 = computeIntakeContextBasis({ targetType: 'issue', targetNumber: 77, state: 'OPEN', title: 'Feat A', body: 'Details', labels: ['bug', 'triage'] })
    const b2 = computeIntakeContextBasis({ targetType: 'issue', targetNumber: 77, state: 'OPEN', title: 'Feat A', body: 'Details', labels: ['triage', 'bug'] })
    const b3 = computeIntakeContextBasis({ targetType: 'issue', targetNumber: 77, state: 'OPEN', title: 'Feat A edited', body: 'Details', labels: ['bug', 'triage'] })
    if (!/^[0-9a-f]{64}$/.test(b1) || b1 !== b2 || b1 === b3) {
      return `computeIntakeContextBasis 确定性或敏感性异常：b1=${b1} b2=${b2} b3=${b3}`
    }

    const intakeDir = tmpProject({
      'AGENTS.md': '# demo\n\n## 非目标\n- 不做无关功能\n',
      'README.md': '# demo\n',
    })
    gitInit(intakeDir, { branch: 'main' })
    gitSync(intakeDir, ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'])
    try {
      const roots = await resolveRepoRoots(intakeDir)
      let remoteTitle = 'Add caching option'
      let remoteWrites = 0
      const mockClient = {
        tier: 'gh-cli',
        async getIssue() { return { ok: true, number: 77, state: 'OPEN', title: remoteTitle, body: 'Add clean caching option with tests and benchmarks.', labels: ['enhancement'] } },
        async listIssues() { return { ok: true, issues: [] } },
        async listComments() { return { ok: true, comments: [] } },
        async postComment() { remoteWrites += 1; return { ok: true, id: 1 } },
        async addLabels() { remoteWrites += 1; return { ok: true } },
        async closeIssue() { remoteWrites += 1; return { ok: true } },
      }
      const mockProbe = { env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'maint' } }, client: mockClient }

      const dry = await withQuietIo(() => handleIntake({ issue: '77', 'dry-run': true, json: true, _ghProbe: mockProbe, _ghClient: mockClient }, roots))
      if (dry.res.exitCode !== 0 || !/^[0-9a-f]{64}$/.test(dry.res.result?.contextBasis ?? '')) {
        return `intake dry-run 未返回有效 contextBasis：${JSON.stringify(dry.res)}`
      }
      const basisBefore = dry.res.result.contextBasis

      // 模拟远端并发变更 -> --apply --context-basis 旧值必须被 BLOCKED_STALE_INTAKE_CONTEXT 拦下且零远端写
      remoteTitle = 'Add caching option (edited concurrently by author)'
      const stale = await withQuietIo(() => handleIntake({
        issue: '77', apply: true, 'context-basis': basisBefore, decision: 'accept', rationale: 'LGTM after review', json: true,
        _ghProbe: mockProbe, _ghClient: mockClient,
      }, roots))
      if (stale.res.exitCode !== EXIT.FACT || stale.res.result?.code !== 'BLOCKED_STALE_INTAKE_CONTEXT' || remoteWrites !== 0) {
        return `contextBasis 漂移未阻断或发生了远端脏写：exit=${stale.res.exitCode} writes=${remoteWrites} res=${JSON.stringify(stale.res.result)}`
      }

      // 使用最新 contextBasis -> 正常写回
      const dryFresh = await withQuietIo(() => handleIntake({ issue: '77', 'dry-run': true, json: true, _ghProbe: mockProbe, _ghClient: mockClient }, roots))
      const applied = await withQuietIo(() => handleIntake({
        issue: '77', apply: true, 'context-basis': dryFresh.res.result.contextBasis, decision: 'accept', rationale: 'LGTM after refresh', json: true,
        _ghProbe: mockProbe, _ghClient: mockClient,
      }, roots))
      if (applied.res.exitCode !== 0 || remoteWrites < 1) {
        return `匹配 contextBasis 时 --apply 未成功写回：exit=${applied.res.exitCode} writes=${remoteWrites}`
      }
    } finally { rmTree(intakeDir) }

    // 4. 帮助文案对齐与 CLI 对拍
    const helpIntake = await runAbsAsync('kit/skills/dev-flow/scripts/flow-intake.mjs', ['--help'])
    if (helpIntake.status !== 0 || !helpIntake.stdout.includes('merge-duplicate') || helpIntake.stdout.includes('reject-out-of-scope') || !helpIntake.stdout.includes('--context-basis')) {
      return `flow-intake --help 文案未对齐：${helpIntake.stdout}`
    }
    const helpFlow = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['--help'])
    if (helpFlow.status !== 0 || !helpFlow.stdout.includes('--context-basis')) {
      return `flow.mjs --help 缺少 --context-basis：${helpFlow.stdout}`
    }
    return true
  }])
}
