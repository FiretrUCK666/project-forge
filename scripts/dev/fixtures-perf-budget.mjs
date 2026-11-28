/**
 * fixtures-perf-budget.mjs —— Milestone C Wave 1A (`low-cpu-script-perf`) C1..C3 双向证伪行为断言。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  SKILL_ROOT, gitInit, gitSync, rmTree, runAbsAsync, tmpProject,
} from './fixtures-helpers.mjs'

const DYN_FALLBACK_TOKEN = ['PerfBudget', 'DynFallback', 'Token'].join('_')

export function registerPerfBudgetCases(cases) {
  cases.push([`[PerfBudget-C2] ${DYN_FALLBACK_TOKEN} 动态拼名用例（供 --only 0 命中回退验真）`, () => true])

  cases.push(['[PerfBudget-C1] proc-budget resolveWorkerConcurrency 留余量、1-2核退化与 --jobs 显式覆盖', async () => {
    const mod = await import(pathToFileURL(join(SKILL_ROOT, 'kit', 'skills', 'lib', 'proc-budget.mjs')).href)
    if (mod.DEFAULT_RESERVED_CORES !== 2) return `DEFAULT_RESERVED_CORES 应为 2，实际为 ${mod.DEFAULT_RESERVED_CORES}`

    const c16 = mod.resolveWorkerConcurrency({ cpuCount: 16 })
    if (c16 !== 14) return `16 核默认应留 2 核得 14，实际为 ${c16}`
    const c8cap = mod.resolveWorkerConcurrency({ cpuCount: 8, cap: 6 })
    if (c8cap !== 6) return `8 核 cap=6 应得 6，实际为 ${c8cap}`
    const c4cap = mod.resolveWorkerConcurrency({ cpuCount: 4, cap: 6 })
    if (c4cap !== 2) return `4 核默认应留 2 核得 2（不得吃满 4 核），实际为 ${c4cap}`
    const c2 = mod.resolveWorkerConcurrency({ cpuCount: 2 })
    if (c2 !== 1) return `2 核应安全退化为 1，实际为 ${c2}`
    const c1 = mod.resolveWorkerConcurrency({ cpuCount: 1 })
    if (c1 !== 1) return `1 核应安全退化为 1，实际为 ${c1}`

    // --jobs 显式覆盖优先于核数预留
    const override = mod.resolveWorkerConcurrency({ cpuCount: 4, requestedJobs: 5 })
    if (override !== 5) return `--jobs=5 显式覆盖未生效，实际为 ${override}`
    const overrideCap = mod.resolveWorkerConcurrency({ cpuCount: 16, requestedJobs: 4, cap: 2 })
    if (overrideCap !== 2) return `--jobs=4 受 cap=2 约束应得 2，实际为 ${overrideCap}`

    // 反面：非法 requestedJobs 回退默认留余量策略，不得返回 0/NaN
    for (const bad of [0, -3, 'abc', Number.NaN, '', null, undefined]) {
      const fb = mod.resolveWorkerConcurrency({ cpuCount: 6, requestedJobs: bad })
      if (fb !== 4) return `非法 requestedJobs=${String(bad)} 应回退为 4，实际为 ${fb}`
    }
    return true
  }])

  cases.push(['[PerfBudget-C1] proc-budget applyLowPriority 降级生效、异常兜底与 5 入口接线', async () => {
    const mod = await import(pathToFileURL(join(SKILL_ROOT, 'kit', 'skills', 'lib', 'proc-budget.mjs')).href)
    const okRes = mod.applyLowPriority(process.pid)
    if (!okRes || okRes.ok !== true || okRes.pid !== process.pid) {
      return `applyLowPriority(process.pid) 未成功：${JSON.stringify(okRes)}`
    }
    if (okRes.priority !== osConstants.priority.PRIORITY_BELOW_NORMAL) {
      return `applyLowPriority 优先级应为 PRIORITY_BELOW_NORMAL(${osConstants.priority.PRIORITY_BELOW_NORMAL})，实际为 ${okRes.priority}`
    }

    // 反面：非法 PID 与不存在 PID 必须安全返回 ok:false 且永不抛错
    for (const badPid of [-1, 0, 1.5, 'bad', null]) {
      const res = mod.applyLowPriority(badPid)
      if (!res || res.ok !== false) return `非法 pid=${String(badPid)} 未安全降级：${JSON.stringify(res)}`
    }
    const missingPidRes = mod.applyLowPriority(99999999)
    if (!missingPidRes || missingPidRes.ok !== false) {
      return `不存在的 pid 应返回 ok:false，实际：${JSON.stringify(missingPidRes)}`
    }

    // 确认全部 5 个并发入口均接入 proc-budget.mjs
    const runners = [
      'scripts/dev/verify-injections.mjs',
      'scripts/dev/fixtures.mjs',
      'scripts/dev/e2e-zip-harness.mjs',
      'scripts/dev/merge-gate.mjs',
      'kit/skills/dev-iterate/scripts/iterate.mjs',
    ]
    for (const rel of runners) {
      const src = readFileSync(join(SKILL_ROOT, rel), 'utf8')
      if (!src.includes('proc-budget.mjs') || !src.includes('resolveWorkerConcurrency') || !src.includes('applyLowPriority')) {
        return `${rel} 尚未完整接入 proc-budget.mjs（resolveWorkerConcurrency + applyLowPriority）`
      }
    }
    return true
  }])

  cases.push(['[PerfBudget-C2] fixtures.mjs --only 跨文件 import 闭包预筛、--domain 懒加载与 0 命中回退', async () => {
    const fixMod = await import('./fixtures.mjs')
    if (typeof fixMod.resolveOnlyCandidateFiles !== 'function') {
      return 'fixtures.mjs 未导出 resolveOnlyCandidateFiles 闭包预筛函数'
    }
    // 正面 1：关键字仅存在于被跨文件导入的辅助文件 fixtures-plan-wave-helpers.mjs 时，闭包必须反向纳入导入它的注册文件
    const helperOnlyAnchor = ['不是测试域', '本文件不导出'].join('：')
    const closureRes = fixMod.resolveOnlyCandidateFiles(helperOnlyAnchor)
    if (!closureRes.files.includes('fixtures-plan-wave.mjs') || !closureRes.files.includes('fixtures-plan-wave-slices.mjs')) {
      return `跨文件 import 闭包漏掉了导入 fixtures-plan-wave-helpers.mjs 的注册文件：${JSON.stringify(closureRes.files)}`
    }
    if (closureRes.files.length >= closureRes.totalFiles) {
      return `闭包预筛未收敛，返回了全量文件（${closureRes.files.length}/${closureRes.totalFiles}）`
    }

    // 正面 2：精准关键字仅加载极少数文件
    const narrow = fixMod.resolveOnlyCandidateFiles('PerfBudget-C1')
    if (narrow.files.length === 0 || narrow.files.length > 5) {
      return `精准关键字 PerfBudget-C1 预筛文件数异常：${narrow.files.length}（${JSON.stringify(narrow.files)}）`
    }

    // 正面 3：动态拼名在源码无字面命中时，--only 必须 0 命中自动回退全量导入并执行通过
    const dynPre = fixMod.resolveOnlyCandidateFiles(DYN_FALLBACK_TOKEN)
    if (dynPre.files.length !== 0) {
      return `动态拼名令牌 ${DYN_FALLBACK_TOKEN} 不应被源码字面命中，实际命中：${JSON.stringify(dynPre.files)}`
    }
    const cleanEnv = { ...process.env, PF_FIXTURE_WORKER: '' }
    const dynRun = await runAbsAsync('scripts/dev/fixtures.mjs', ['--only', DYN_FALLBACK_TOKEN], { env: cleanEnv })
    if (dynRun.status !== 0 || !/1 项通过/.test(dynRun.stdout || '')) {
      return `--only 0 命中未回退全量导入或未跑通动态拼名用例：exit=${dynRun.status} out=${dynRun.stdout} err=${dynRun.stderr}`
    }

    // 反面 1：确实不存在的关键字不得静默退出 0（动态拼串避免命中本用例函数体造成自递归）
    const neverToken = ['__NEVER', 'EXISTS', 'PERF', 'BUDGET', 'XYZ__'].join('_')
    const badOnly = await runAbsAsync('scripts/dev/fixtures.mjs', ['--only', neverToken], { env: cleanEnv })
    if (badOnly.status === 0 || !/没有用例匹配 --only/.test(badOnly.stderr || '')) {
      return `不存在的 --only 关键字未报错阻断：exit=${badOnly.status} err=${badOnly.stderr}`
    }

    // 正面 4 & 反面 2：--domain 单域懒加载与未知域拦截
    const okDom = await runAbsAsync('scripts/dev/fixtures.mjs', ['--domain', 'perf-budget', '--only', DYN_FALLBACK_TOKEN], { env: cleanEnv })
    if (okDom.status !== 0 || !/1 项通过/.test(okDom.stdout || '')) {
      return `--domain perf-budget 执行失败：exit=${okDom.status} out=${okDom.stdout} err=${okDom.stderr}`
    }
    const badDom = await runAbsAsync('scripts/dev/fixtures.mjs', ['--domain', 'nonexistent-domain-xyz'], { env: cleanEnv })
    if (badDom.status !== 2 || !/未知测试域/.test(badDom.stderr || '')) {
      return `未知 --domain 未返回退出码 2：exit=${badDom.status} err=${badDom.stderr}`
    }
    return true
  }])

  cases.push(['[PerfBudget-C2] fixtures-helpers.mjs 补齐 IN_PROCESS_CLI_SCRIPTS 并兼容 mod.runCli ?? mod.main', async () => {
    const helpersMod = await import('./fixtures-helpers.mjs')
    const set = helpersMod.IN_PROCESS_CLI_SCRIPTS
    if (!(set instanceof Set)) return 'fixtures-helpers.mjs 未导出 IN_PROCESS_CLI_SCRIPTS'
    const required = [
      'equip-ci.mjs',
      'kit/skills/dev-verify-tools/scripts/verify-tools.mjs',
      'kit/skills/dev-explore/scripts/doc-locate.mjs',
      'kit/skills/dev-edit/scripts/edit-gate.mjs',
      'kit/skills/dev-iterate/scripts/iterate.mjs',
    ]
    for (const item of required) {
      if (!set.has(item)) return `IN_PROCESS_CLI_SCRIPTS 缺少 ${item}`
    }

    // 正面：equip-ci.mjs 仅导出 main（无 runCli），runAbsAsync 必须走进程内路径返回 0 且隔离 process.exitCode
    const equipCiMod = await import('../equip-ci.mjs')
    if (typeof equipCiMod.runCli === 'function' || typeof equipCiMod.main !== 'function') {
      return '前置假设不成立：equip-ci.mjs 应仅导出 main'
    }
    const prevCode = process.exitCode
    process.exitCode = 7
    try {
      const helpRes = await runAbsAsync('scripts/equip-ci.mjs', ['--help'])
      if (helpRes.status !== 0 || !/用法/.test(helpRes.stdout || '')) {
        return `equip-ci.mjs --help 进程内执行失败：${JSON.stringify(helpRes)}`
      }
      if (helpRes.inProcess !== true) {
        return `equip-ci.mjs 未命中进程内执行路径（inProcess=${String(helpRes.inProcess)}）`
      }
      const errRes = await runAbsAsync('scripts/equip-ci.mjs', [])
      if (errRes.status !== 2) return `equip-ci.mjs 空参应返回退出码 2，实际为 ${errRes.status}`
      if (process.exitCode !== 7) return `process.exitCode 未在进程内执行后还原，实际为 ${process.exitCode}`
    } finally {
      process.exitCode = prevCode
    }

    // 正面：新补齐的 4 个 kit 脚本均可命中进程内 --help
    for (const rel of required.slice(1)) {
      const r = await runAbsAsync(rel, ['--help'])
      if (r.status !== 0 || !/用法/.test(r.stdout || '') || r.inProcess !== true) {
        return `${rel} 未命中进程内执行或 --help 失败：status=${r.status} inProcess=${String(r.inProcess)}`
      }
    }
    return true
  }])

  cases.push(['[PerfBudget-C2] sync-toc/update 导出 runCli 且 preflight-e2e checkHelps 单子进程校验 8 脚本', async () => {
    const syncTocMod = await import('../sync-toc.mjs')
    const updateMod = await import('../update.mjs')
    if (typeof syncTocMod.runCli !== 'function') return 'scripts/sync-toc.mjs 未导出 runCli'
    if (typeof updateMod.runCli !== 'function') return 'scripts/update.mjs 未导出 runCli'

    const e2eMod = await import('./preflight-e2e.mjs')
    if (typeof e2eMod.checkHelps !== 'function') return 'preflight-e2e.mjs 未导出 checkHelps'

    const okFails = []
    await e2eMod.checkHelps({ ROOT: SKILL_ROOT, fail: (m) => okFails.push(m) })
    if (okFails.length > 0) return `真实仓 checkHelps 失败：${okFails.join(' | ')}`

    // 反面：构造 8 脚本中 update.mjs 缺少「用法」输出，checkHelps 必须精准报错，绝不静默放行
    const fakeRoot = tmpProject({})
    try {
      const names = ['survey.mjs', 'backup.mjs', 'compose-agents.mjs', 'review.mjs', 'handoff.mjs', 'sync-toc.mjs', 'update.mjs', 'equip.mjs']
      mkdirSync(join(fakeRoot, 'scripts'), { recursive: true })
      for (const n of names) {
        const body = n === 'update.mjs'
          ? 'export async function runCli() { process.stdout.write("broken output\\n"); return 0 }\n'
          : `export async function runCli() { process.stdout.write("用法：${n}\\n"); return 0 }\n`
        writeFileSync(join(fakeRoot, 'scripts', n), body, 'utf8')
      }
      const negFails = []
      await e2eMod.checkHelps({ ROOT: fakeRoot, fail: (m) => negFails.push(m) })
      if (!negFails.some((m) => m.includes('update.mjs') && m.includes('没打印用法'))) {
        return `checkHelps 放行了缺少用法输出的 update.mjs：${JSON.stringify(negFails)}`
      }
    } finally {
      rmTree(fakeRoot)
    }
    return true
  }])

  cases.push(['[PerfBudget-C3] readBlobBatch 与 git show 字节等价、edit-gate 行数 <=755、trackedSet 复用与异步 ignore', async () => {
    const objMod = await import(pathToFileURL(join(SKILL_ROOT, 'kit', 'skills', 'lib', 'git-fast-objects.mjs')).href)
    if (typeof objMod.readBlobBatch !== 'function') return 'kit/skills/lib/git-fast-objects.mjs 未导出 readBlobBatch'

    const dir = tmpProject({
      'a.txt': 'hello world\n中文内容\n',
      'nested/sub/b.mjs': 'export const x = 42\n// 注释\n',
      '.gitignore': 'node_modules/\nlib\n',
      'build/tracked.txt': 'kept\n',
      'dist/untracked.txt': 'gen\n',
    })
    gitInit(dir, { branch: 'main', name: 'dev', email: 'dev@perf.test' })
    // 保留 dist/untracked.txt 为未跟踪文件
    gitSync(dir, ['rm', '--cached', '-q', 'dist/untracked.txt'])
    gitSync(dir, ['commit', '-qm', 'untrack dist'])
    try {
      // 松散对象路径
      const looseMap = await objMod.readBlobBatch(dir, 'HEAD', ['a.txt', 'nested/sub/b.mjs', 'missing.mjs'])
      const showA = gitSync(dir, ['show', 'HEAD:a.txt'], { encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n')
      const showB = gitSync(dir, ['show', 'HEAD:nested/sub/b.mjs'], { encoding: 'utf8' }).stdout.replace(/\r\n/g, '\n')
      if (looseMap.get('a.txt') !== showA) return `松散 readBlobBatch(a.txt) 不等价`
      if (looseMap.get('nested/sub/b.mjs') !== showB) return `松散 readBlobBatch(nested/sub/b.mjs) 不等价`
      if (looseMap.get('missing.mjs') !== null) return `缺失路径应返回 null，实际为 ${String(looseMap.get('missing.mjs'))}`

      // packfile 对象路径（repack 后删松散对象）
      gitSync(dir, ['repack', '-a', '-d', '-q'])
      const packMap = await objMod.readBlobBatch(dir, 'HEAD', ['a.txt', 'nested/sub/b.mjs', 'missing.mjs'])
      if (packMap.get('a.txt') !== showA || packMap.get('nested/sub/b.mjs') !== showB || packMap.get('missing.mjs') !== null) {
        return `packfile readBlobBatch 结果不等价：${JSON.stringify([...packMap.entries()])}`
      }

      // 反面：非 Git 目录安全返回 null 不抛错
      const nonGit = tmpProject({ 'x.txt': '1\n' })
      try {
        const ngMap = await objMod.readBlobBatch(nonGit, 'HEAD', ['x.txt'])
        if (ngMap.get('x.txt') !== null) return `非 Git 目录应返回 null，实际：${String(ngMap.get('x.txt'))}`
      } finally {
        rmTree(nonGit)
      }

      // 异步 detectIgnoredGovernancePathsAsync 正反双向
      const wsMod = await import('../lib/survey-workspace.mjs')
      if (typeof wsMod.detectIgnoredGovernancePathsAsync !== 'function') {
        return 'scripts/lib/survey-workspace.mjs 未导出 detectIgnoredGovernancePathsAsync'
      }
      const hits = await wsMod.detectIgnoredGovernancePathsAsync(dir)
      if (!hits.some((h) => h.path === '.agents/skills/lib/git.mjs')) {
        return `detectIgnoredGovernancePathsAsync 漏报未锚定 lib 规则：${JSON.stringify(hits)}`
      }
      const emptyShort = await wsMod.detectIgnoredGovernancePathsAsync(dir, [])
      if (emptyShort.length !== 0) return '空候选路径未短路返回 []'

      // govern-checks-hygiene trackedSet 复用：纯跟踪目录 build/ 放行，未跟踪 dist/ 告警
      const hygMod = await import(pathToFileURL(join(SKILL_ROOT, 'kit', 'skills', 'dev-govern', 'scripts', 'govern-checks-hygiene.mjs')).href)
      const findings = []
      const trackedSet = new Set(['a.txt', 'nested/sub/b.mjs', '.gitignore', 'build/tracked.txt'])
      await hygMod.auditUnignoredOutputDirs(dir, dir, true, findings, (arr, item) => arr.push(item), trackedSet)
      if (findings.some((f) => f.file === 'build')) return `纯跟踪 build/ 被误报未忽略：${JSON.stringify(findings)}`
      if (!findings.some((f) => f.file === 'dist')) return `未跟踪 dist/ 未被报出：${JSON.stringify(findings)}`

      // edit-gate.mjs 瘦身红线：<= 755 行且改调 readBlobBatch
      const editGateSrc = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'dev-edit', 'scripts', 'edit-gate.mjs'), 'utf8')
      const editLines = editGateSrc.replace(/\r\n/g, '\n').split('\n').length
      if (editLines > 755) return `edit-gate.mjs 行数超限（${editLines} > 755）`
      if (!editGateSrc.includes('readBlobBatch')) return 'edit-gate.mjs 未改调 readBlobBatch'
    } finally {
      rmTree(dir)
    }
    return true
  }])
}
