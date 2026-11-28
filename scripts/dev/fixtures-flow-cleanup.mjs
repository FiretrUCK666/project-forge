/**
 * fixtures-flow-cleanup.mjs —— worktree 通配清理删穿保护与全调用点安全解绑行为断言（C1..C6）。
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, seedExploredFor, tmpProject } from './fixtures-helpers.mjs'

function makeDeepDir(baseAbs, depthCount) {
  let cur = baseAbs
  for (let i = 1; i <= depthCount; i += 1) {
    cur = join(cur, `d${String(i).padStart(2, '0')}`)
  }
  mkdirSync(cur, { recursive: true })
  return cur
}

export function registerFlowCleanupCases(cases) {
  // C1 / C6: 任意名字外链、深层外链、悬空链接与部分放行均阻断，且被拦下的目标事后也完好
  cases.push(['cleanup 外链保护：任意名字、悬空链接与部分放行均阻断且主仓哨兵完好', async () => {
    const { scanOutboundLinks, unmountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
    const { handleCleanup, handleAbort } = await import('../../kit/skills/dev-flow/scripts/flow-cleanup.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { resolveRepoRoots, readTaskLedger } = await import('./test-shared.mjs')
    const names = ['vendor', 'shared', 'data', 'packages', '中文名']
    const dir = tmpProject({
      '.gitignore': `.worktrees/\n${names.map((n) => `${n}/\n`).join('')}`,
      'README.md': '# outbound\n',
    })
    gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
    for (const name of names) {
      mkdirSync(join(dir, name, 'precious'), { recursive: true })
      writeFileSync(join(dir, name, 'precious', 'SURVIVE.txt'), 'MUST SURVIVE')
    }
    gitCommitFast(dir, 'add shared dirs')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      const roots = await resolveRepoRoots(dir)
      const started = await handleStart({ task: 'outbound', case: '3', slug: 'outbound', 'allow-plan-bootstrap': true }, roots)
      if (started.exitCode !== 0) return `start 失败：${started.exitCode}`
      const ledger = readTaskLedger(dir, 'outbound')
      const implAbs = join(dir, ledger.worktreePath)

      for (const name of names) symlinkSync(join(dir, name), join(implAbs, name), linkType)
      mkdirSync(join(implAbs, 'nested', 'deeper'), { recursive: true })
      symlinkSync(join(dir, 'data'), join(implAbs, 'nested', 'deeper', 'data-deep'), linkType)
      // 悬空链接：目标不存在，cleanup 档必须以 unresolved-target 阻断
      const missingTarget = join(dir, 'nonexistent-target-for-dangling-link')
      symlinkSync(missingTarget, join(implAbs, 'dangling-link'), linkType)
      // 反向：worktree 内部链接不归类为外链
      mkdirSync(join(implAbs, 'inner'), { recursive: true })
      writeFileSync(join(implAbs, 'inner', 'a.txt'), 'inner\n')
      symlinkSync(join(implAbs, 'inner'), join(implAbs, 'inner-link'), linkType)

      const scan = scanOutboundLinks(implAbs)
      const found = scan.outbound.map((o) => o.path).sort()
      const expectedOutside = [...names, 'nested/deeper/data-deep'].sort()
      const expectedWithDangling = [...expectedOutside, 'dangling-link'].sort()
      if (found.length !== expectedWithDangling.length) {
        return `外链检出数不对：期望 ${expectedWithDangling.length} 个，实际 ${found.length} 个（${found.join(', ')}）`
      }
      const danglingHit = scan.outbound.find((o) => o.path === 'dangling-link')
      if (!danglingHit || danglingHit.kind !== 'unresolved') {
        return `悬空链接未标为 kind=unresolved：${JSON.stringify(danglingHit)}`
      }
      if (scan.internal.length !== 1 || scan.internal[0].path !== 'inner-link') {
        return `worktree 内部链接归类异常：${JSON.stringify(scan.internal)}`
      }

      // 即使把悬空链接列入 allowOutbound，cleanup 档也必须因 unresolved-target 阻断
      const deniedDangling = unmountSharedDeps(dir, implAbs, { allowOutbound: expectedWithDangling })
      if (deniedDangling.ok !== false) return '悬空链接即使在 allowOutbound 中也不得放行'
      const danglingBlock = deniedDangling.blocked.find((b) => b.path === 'dangling-link')
      if (!danglingBlock || danglingBlock.reason !== 'unresolved-target') {
        return `悬空链接 blocked[].reason 应为 unresolved-target：${JSON.stringify(deniedDangling.blocked)}`
      }
      if (deniedDangling.unmounted.length !== 0 || !lstatSync(join(implAbs, 'inner-link'), { throwIfNoEntry: false })) {
        return '存在阻断外链时不得解绑任何外链或内部链接'
      }

      // 去掉悬空链接后验证部分放行仍整单阻断、不解绑任何一条
      unlinkSync(join(implAbs, 'dangling-link'))

      const partialDenied = unmountSharedDeps(dir, implAbs, { allowOutbound: [names[0]] })
      if (partialDenied.ok !== false || partialDenied.blocked.length !== expectedOutside.length - 1 || partialDenied.unmounted.length !== 0) {
        return `部分放行时不得解绑任何链接：${JSON.stringify(partialDenied)}`
      }
      for (const name of names) {
        if (!existsSync(join(dir, name, 'precious', 'SURVIVE.txt'))) return `部分放行阻断后目标消失：${name}`
      }

      // 真实 cleanup --confirm --force 与 abort --confirm --force 都必须以 EXIT_POLICY_BLOCK(3) 拦截
      const prevOut = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 'outbound', '--json'], { cwd: dir })).stdout).previewHash
      const cl = await handleCleanup({ task: 'outbound', confirm: true, force: true, 'preview-hash': prevOut, json: true }, roots)
      if (cl.exitCode !== 3) return `cleanup --confirm --force 带着外链未返回 EXIT_POLICY_BLOCK(3)：exit=${cl.exitCode}`
      const ab = await handleAbort({ task: 'outbound', confirm: true, force: true, json: true }, roots)
      if (ab.exitCode !== 3) return `abort --confirm --force 带着外链未返回 EXIT_POLICY_BLOCK(3)：exit=${ab.exitCode}`
      for (const name of names) {
        if (!existsSync(join(dir, name, 'precious', 'SURVIVE.txt'))) return `拦截后主仓 ${name}/precious 消失`
      }
      if (!existsSync(join(dir, 'data', 'precious', 'SURVIVE.txt'))) return '拦截后深层链接目标消失'

      // 通过真实 CLI 传入可重复 --allow-outbound（含 ./ 与尾部斜杠归一）放行
      const allowFlags = expectedOutside.flatMap((p) => ['--allow-outbound', `./${p}/`])
      const cliOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'cleanup', '--task', 'outbound', '--confirm', '--preview-hash', prevOut, '--force', ...allowFlags, '--json',
      ], { cwd: dir })
      if (cliOk.status !== 0) return `CLI 显式逐条放行失败：${cliOk.stderr}\n${cliOk.stdout}`
      const parsed = JSON.parse(cliOk.stdout)
      const rmWt = parsed.removedWorktrees?.[0]
      if (!rmWt || (rmWt.unmountedLinks?.length ?? 0) !== expectedOutside.length) {
        return `cleanup 回执 unmountedLinks 数不对：${JSON.stringify(parsed)}`
      }
      for (const entry of rmWt.unmountedLinks) {
        if (!entry.path || !entry.target || entry.source !== 'allow-outbound') {
          return `unmountedLinks 缺少 path/target/source：${JSON.stringify(entry)}`
        }
      }
      if (existsSync(implAbs)) return '显式放行清理后 worktree 目录仍存在'
      for (const name of names) {
        if (!existsSync(join(dir, name, 'precious', 'SURVIVE.txt'))) return `清理后主仓 ${name}/precious 消失`
      }
      return true
    } finally { rmTree(dir) }
  }])

  // C2: 工具挂载清单写盘与按清单自动解绑（禁止 depsMode==='shared' 快捷键）+ abort 同路径 + 未注册 worktree 拦截
  cases.push(['cleanup 外链保护反向：工具挂载依赖写入账本并自动解绑，未登记外链仍阻断', async () => {
    const { handleCleanup, handleAbort } = await import('../../kit/skills/dev-flow/scripts/flow-cleanup.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleFinalize, handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { handleClaim } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
    const { handleSync } = await import('../../kit/skills/dev-flow/scripts/flow-sync.mjs')
    const { resolveRepoRoots, readTaskLedger, writeTaskLedger } = await import('./test-shared.mjs')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\npackages/app/node_modules/\n',
      'AGENTS.md': '# c2\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nmerge-gate: exit 0\n```\n',
      'package.json': '{"name":"c2","version":"1.0.0","workspaces":["packages/app"]}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
      'packages/app/package.json': '{"name":"app","version":"1.0.0"}\n',
      'packages/app/package-lock.json': '{"lockfileVersion":3}\n',
      'README.md': '# c2\n',
    })
    gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
    mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'pkg', 'i.js'), '1\n')
    mkdirSync(join(dir, 'packages', 'app', 'node_modules', 'sub'), { recursive: true })
    writeFileSync(join(dir, 'packages', 'app', 'node_modules', 'sub', 's.js'), '1\n')
    gitCommitFast(dir, 'add workspace deps')

    const outside = tmpProject({ 'precious.txt': 'OUTSIDE_SAFE' })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      const roots = await resolveRepoRoots(dir)
      const s1 = await handleStart({ task: 'c2-auto', case: '2', slug: 'c2-auto', implementer: 'impl', 'no-issue': true, reason: '回归夹具聚焦 worktree 依赖清理' }, roots)
      if (s1.exitCode !== 0) return `start 失败：${s1.exitCode}`
      await handleClaim({ task: 'c2-auto', agent: 'impl' }, roots)
      await seedExploredFor(dir, 'c2-auto')
      const l1 = readTaskLedger(dir, 'c2-auto')
      if (!Array.isArray(l1.mountedDeps) || !l1.mountedDeps.includes('node_modules') || !l1.mountedDeps.includes('packages/app/node_modules')) {
        return `start 未将实际挂载路径写入账本 mountedDeps：${JSON.stringify(l1)}`
      }
      const implAbs1 = join(dir, l1.worktreePath)

      // 即使 depsMode === 'shared' 且 node_modules 在账本清单里，额外手工外链仍必须阻断（带 force 也不可跳过外链检查）
      symlinkSync(outside, join(implAbs1, 'rogue-outside'), linkType)
      const blockedWithExtra = await handleCleanup({ task: 'c2-auto', confirm: true, force: true, json: true }, roots)
      if (blockedWithExtra.exitCode !== 3) {
        return `存在未登记外链时竟被放行（可能误用了 depsMode==='shared' 快捷键）：exit=${blockedWithExtra.exitCode}`
      }
      if (!existsSync(join(outside, 'precious.txt')) || !existsSync(join(dir, 'node_modules', 'pkg', 'i.js'))) {
        return '阻断后目标或主仓依赖丢失'
      }

      // 去除未登记外链后，无需 --allow-outbound 即可自动解绑工具挂载的依赖并标明来源
      unlinkSync(join(implAbs1, 'rogue-outside'))

      // 验证 sync 与 submit 重挂载同样刷新账本挂载清单
      writeFileSync(join(dir, 'README.md'), '# c2 main advanced\n')
      gitCommitFast(dir, 'advance main', { updateOnly: true })
      writeFileSync(join(implAbs1, 'packages', 'app', 'package-lock.json'), '{"lockfileVersion":3,"v":2}\n')
      gitCommitFast(implAbs1, 'change app lockfile')
      const syncRes = await handleSync({ task: 'c2-auto', onto: 'main' }, roots)
      if (syncRes.exitCode !== 0) return `sync 失败：${syncRes.exitCode}`
      const lAfterSync = readTaskLedger(dir, 'c2-auto')
      const implMountedAfterSync = lAfterSync.mountedDepsByWorktree?.[lAfterSync.worktreePath] ?? lAfterSync.mountedDeps
      if (implMountedAfterSync.includes('packages/app/node_modules') || !implMountedAfterSync.includes('node_modules')) {
        return `sync 重挂载未刷新账本挂载清单（app 锁变化应隔离）：${JSON.stringify(lAfterSync.mountedDepsByWorktree)}`
      }

      await handleFinalize({ task: 'c2-auto' }, roots)
      await handleVerify({ task: 'c2-auto', mode: 'gate' }, roots)
      const subRes = await handleSubmit({ task: 'c2-auto', agent: 'impl' }, roots)
      if (subRes.exitCode !== 0) return `submit 失败：${subRes.exitCode}`
      const lAfterSub = readTaskLedger(dir, 'c2-auto')
      const revMounted = lAfterSub.mountedDepsByWorktree?.[lAfterSub.reviewWorktreePath]
      if (!Array.isArray(revMounted) || !revMounted.includes('node_modules')) {
        return `submit 未把 review 槽挂载清单写入账本：${JSON.stringify(lAfterSub.mountedDepsByWorktree)}`
      }
      // review 槽已挂载 node_modules 时再次 submit，验证 flow-lifecycle 以 mode:'deps' 先解绑再推进
      writeFileSync(join(implAbs1, 'README.md'), '# c2 round 2\n')
      gitCommitFast(implAbs1, 'round 2')
      await handleFinalize({ task: 'c2-auto' }, roots)
      await handleVerify({ task: 'c2-auto', mode: 'gate' }, roots)
      const subRes2 = await handleSubmit({ task: 'c2-auto', agent: 'impl' }, roots)
      if (subRes2.exitCode !== 0) return `二次 submit（review 槽已挂载 node_modules）失败：${subRes2.exitCode}`

      // 先把分支合并进 main，再验证真实 CLI cleanup 不带 --allow-outbound，自动解绑并输出「工具挂载，自动解绑」回执
      gitSync(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-ff', lAfterSub.branch, '-m', 'merge c2-auto'])
      const prevC2 = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 'c2-auto', '--json'], { cwd: dir })).stdout).previewHash
      const clCli = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'cleanup', '--task', 'c2-auto', '--confirm', '--preview-hash', prevC2,
      ], { cwd: dir })
      if (clCli.status !== 0) return `工具挂载工作树不带 --allow-outbound 清理失败：${clCli.stderr}\n${clCli.stdout}`
      if (!clCli.stdout.includes('工具挂载，自动解绑') || !clCli.stdout.includes('node_modules ->')) {
        return `回执缺少「工具挂载，自动解绑」或路径指向明细：${clCli.stdout}`
      }
      if (existsSync(implAbs1) || existsSync(join(dir, lAfterSub.reviewWorktreePath))) {
        return 'cleanup 后 worktree 目录未删除'
      }
      if (!existsSync(join(dir, 'node_modules', 'pkg', 'i.js')) || !existsSync(join(dir, 'packages', 'app', 'node_modules', 'sub', 's.js'))) {
        return 'cleanup 后主仓共享依赖受损'
      }

      // 反证：账本有 mountedDeps=['node_modules'] 但工作树里 node_modules 被调包指向仓外目录时，必须阻断
      const sForge = await handleStart({ task: 'c2-forge', case: '2', slug: 'c2-forge', 'no-issue': true, reason: '回归夹具聚焦伪造外链拦截' }, roots)
      if (sForge.exitCode !== 0) return `start c2-forge 失败：${sForge.exitCode}`
      const lForge = readTaskLedger(dir, 'c2-forge')
      const wtForge = join(dir, lForge.worktreePath)
      unlinkSync(join(wtForge, 'node_modules'))
      symlinkSync(outside, join(wtForge, 'node_modules'), linkType)
      const forgeBlocked = await handleCleanup({ task: 'c2-forge', confirm: true, force: true, json: true }, roots)
      if (forgeBlocked.exitCode !== 3 || !existsSync(join(outside, 'precious.txt'))) {
        return `调包指向仓外的 node_modules 竟被工具清单放行：exit=${forgeBlocked.exitCode}`
      }
      await handleAbort({ task: 'c2-forge', confirm: true, force: true, 'allow-outbound': ['node_modules', 'packages/app/node_modules'], json: true }, roots)

      // 反证：账本有 depsMode='shared' 但 mountedDeps=[] 时，不得自动放行任何链接
      const s2 = await handleStart({ task: 'c2-shortcut', case: '2', slug: 'c2-shortcut', 'no-issue': true, reason: '回归夹具聚焦 mountedDeps 空清单拦截' }, roots)
      if (s2.exitCode !== 0) return `start s2 失败：${s2.exitCode}`
      const l2 = readTaskLedger(dir, 'c2-shortcut')
      l2.depsMode = 'shared'
      l2.mountedDeps = []
      l2.mountedDepsByWorktree = { [l2.worktreePath]: [] }
      writeTaskLedger(dir, l2)
      const shortcutBlocked = await handleCleanup({ task: 'c2-shortcut', confirm: true, json: true }, roots)
      if (shortcutBlocked.exitCode !== 3) {
        return `mountedDeps=[] 但 depsMode='shared' 时竟被放行：exit=${shortcutBlocked.exitCode}`
      }
      // abort --confirm 带 --allow-outbound 可安全拆除并保留主仓依赖
      const abOk = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'abort', '--task', 'c2-shortcut', '--confirm',
        '--allow-outbound', 'node_modules', '--allow-outbound', 'packages/app/node_modules', '--json',
      ], { cwd: dir })
      if (abOk.status !== 0) return `abort --allow-outbound 失败：${abOk.stderr}`
      const abParsed = JSON.parse(abOk.stdout)
      if (!abParsed.removedWorktrees?.[0]?.unmountedLinks?.some((u) => u.path === 'node_modules' && u.target)) {
        return `abort 回执缺少 unmountedLinks 明细：${abOk.stdout}`
      }
      if (!existsSync(join(dir, 'node_modules', 'pkg', 'i.js'))) return 'abort 后主仓 node_modules 受损'

      // 未在 git worktree list 注册的同名目录必须被拒绝清理
      const rogueRel = '.worktrees/impl-rogue'
      mkdirSync(join(dir, rogueRel), { recursive: true })
      writeTaskLedger(dir, {
        taskId: 'rogue', slug: 'rogue', caseType: 2, tier: 2, role: 'local-only',
        branch: 'feat/rogue', baseBranch: 'main', worktreePath: rogueRel, status: 'started',
      })
      const rogueRes = await handleCleanup({ task: 'rogue', confirm: true, json: true }, roots)
      if (rogueRes.exitCode !== 3 || !existsSync(join(dir, rogueRel))) {
        return `未注册在 git worktree list 的目录未被拦下：exit=${rogueRes.exitCode}`
      }
      return true
    } finally { rmTree(dir); rmTree(outside) }
  }])

  // C3: 内部 junction 先 unlinkSync 再删目录（对照：只 unlink 不删目录会留下 worktree 与分支；older Windows git 不先 unlink 直接删会报 Directory not empty）
  cases.push(['cleanup 内部 junction 先 unlinkSync 再删目录', async () => {
    const { unmountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
    const { handleCleanup } = await import('../../kit/skills/dev-flow/scripts/flow-cleanup.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { resolveRepoRoots, readTaskLedger } = await import('./test-shared.mjs')
    const dir = tmpProject({ '.gitignore': '.worktrees/\ninner-junc\n', 'README.md': '# c3\n' })
    gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      const roots = await resolveRepoRoots(dir)
      // 对照验证：仅存在内部 junction 时，只做 unlink 不会删掉目录与分支，而部分 Windows Git 在未解绑前直接 `git worktree remove --force`
      // 会以 Directory not empty 失败（newer Git for Windows 已兼容，故用跨版本确定性对照：只 unlink 不删目录 vs cleanup 完整两步）。
      const ctrl = await handleStart({ task: 'c3-ctrl', case: '2', slug: 'c3-ctrl', 'no-issue': true, reason: '回归夹具聚焦内部 junction 解绑' }, roots)
      if (ctrl.exitCode !== 0) return `对照 start 失败：${ctrl.exitCode}`
      const lCtrl = readTaskLedger(dir, 'c3-ctrl')
      const wtCtrl = join(dir, lCtrl.worktreePath)
      mkdirSync(join(wtCtrl, 'inner'), { recursive: true })
      writeFileSync(join(wtCtrl, 'inner', 'a.txt'), 'a\n')
      gitCommitFast(wtCtrl, 'add inner dir')
      symlinkSync(join(wtCtrl, 'inner'), join(wtCtrl, 'inner-junc'), linkType)
      const umCtrl = unmountSharedDeps(dir, wtCtrl, { mode: 'cleanup' })
      if (!umCtrl.ok || !umCtrl.unmountedInternal?.some((u) => u.path === 'inner-junc') || lstatSync(join(wtCtrl, 'inner-junc'), { throwIfNoEntry: false })) {
        return `对照内部 junction 未被 cleanup 档 unlinkSync：${JSON.stringify(umCtrl)}`
      }
      if (!existsSync(wtCtrl) || gitSync(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${lCtrl.branch}`]).status !== 0) {
        return '对照：只做 unlink 时工作树目录与分支应仍存在，须由 cleanup 执行两步删除'
      }

      const st = await handleStart({ task: 'c3-main', case: '2', slug: 'c3-main', 'no-issue': true, reason: '回归夹具聚焦内部 junction 清理' }, roots)
      if (st.exitCode !== 0) return `start 失败：${st.exitCode}`
      const l = readTaskLedger(dir, 'c3-main')
      const implAbs = join(dir, l.worktreePath)
      mkdirSync(join(implAbs, 'inner', 'nested'), { recursive: true })
      writeFileSync(join(implAbs, 'inner', 'nested', 'k.txt'), 'keep\n')
      gitCommitFast(implAbs, 'add inner nested')
      gitSync(dir, ['merge', '--ff-only', l.branch])
      symlinkSync(join(implAbs, 'inner'), join(implAbs, 'inner-junc'), linkType)

      const prevC3 = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 'c3-main', '--json'], { cwd: dir })).stdout).previewHash
      const cl = await handleCleanup({ task: 'c3-main', confirm: true, 'preview-hash': prevC3, json: true }, roots)
      if (cl.exitCode !== 0) return `含内部 junction 的 worktree 清理失败：exit=${cl.exitCode}`
      if (existsSync(implAbs)) return 'cleanup 后 worktree 目录依然存在'
      const brExists = gitSync(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${l.branch}`]).status === 0
      if (brExists) return 'cleanup 后本地分支未被删除'
      const lAfter = readTaskLedger(dir, 'c3-main')
      if (lAfter.status !== 'cleaned') return `账本状态未更新为 cleaned：${lAfter.status}`
      return true
    } finally { rmTree(dir) }
  }])

  // C4: 深度上限边界（第 24 层检出，第 25 层越界必须 fail-closed 阻断，禁止静默放行）
  cases.push(['scanOutboundLinks 深度上限越界 fail-closed（第 24 层检出、第 25 层必阻断）', async () => {
    const { scanOutboundLinks, unmountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
    const { handleCleanup } = await import('../../kit/skills/dev-flow/scripts/flow-cleanup.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { resolveRepoRoots, readTaskLedger } = await import('./test-shared.mjs')
    const dir = tmpProject({ '.gitignore': '.worktrees/\n', 'README.md': '# c4\n' })
    const outside = tmpProject({ 'SURVIVE.txt': 'DEEP_SENTINEL' })
    gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      const roots = await resolveRepoRoots(dir)
      const st = await handleStart({ task: 'c4-depth', case: '2', slug: 'c4-depth', 'no-issue': true, reason: '回归夹具聚焦外链深度上限拦截' }, roots)
      if (st.exitCode !== 0) return `start 失败：${st.exitCode}`
      const l = readTaskLedger(dir, 'c4-depth')
      const implAbs = join(dir, l.worktreePath)

      // 1. 第 24 层目录（25 个路径组件）：必须直接检出，未截断
      const dir24 = makeDeepDir(implAbs, 24)
      const link24 = join(dir24, 'link24')
      symlinkSync(outside, link24, linkType)
      const scan24 = scanOutboundLinks(implAbs)
      if (scan24.truncated || scan24.outbound.length !== 1) {
        return `第 24 层外链应直接检出且不截断：${JSON.stringify(scan24)}`
      }
      unlinkSync(link24)

      // 2. 第 25 层目录（26 个路径组件）：要么检出外链，要么报 scan-truncated；绝不允许照常删除
      const dir25 = makeDeepDir(implAbs, 25)
      const link25 = join(dir25, 'link25')
      symlinkSync(outside, link25, linkType)
      const scan25 = scanOutboundLinks(implAbs)
      const detectedOrTruncated = scan25.outbound.some((o) => o.path.endsWith('/link25')) || scan25.truncated === true
      if (!detectedOrTruncated) {
        return `第 25 层外链既未检出也未报截断（静默漏扫）：${JSON.stringify(scan25)}`
      }
      const um25 = unmountSharedDeps(dir, implAbs, { mode: 'cleanup' })
      if (um25.ok !== false) return `第 25 层越界时 unmountSharedDeps 竟然放行：${JSON.stringify(um25)}`
      const cl25 = await handleCleanup({ task: 'c4-depth', confirm: true, force: true, json: true }, roots)
      if (cl25.exitCode === 0 || !existsSync(implAbs)) {
        return `第 25 层越界时 cleanup 竟然删除成功：exit=${cl25.exitCode}`
      }
      if (!existsSync(join(outside, 'SURVIVE.txt'))) return '第 25 层越界清理后仓外哨兵丢失'
      return true
    } finally { rmTree(dir); rmTree(outside) }
  }])

  // C1(tracked) + C5(全调用点 mode:'deps' 与 runTrialMerge 护栏)
  cases.push(['跟踪的链接在删除档不许豁免，解绑档才跳过；runTrialMerge 试合实测与主仓共享依赖完好', async () => {
    const { unmountSharedDeps } = await import('../../kit/skills/dev-flow/scripts/worktree-deps.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleVerify } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const { runTrialMerge } = await import('../../kit/skills/dev-flow/scripts/flow-trial-merge.mjs')
    const { syncTier2ReviewSlotIfNeeded } = await import('../../kit/skills/dev-review/scripts/review-diff.mjs')
    const { resolveRepoRoots, readTaskLedger } = await import('./test-shared.mjs')
    const dir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'AGENTS.md': '# c5\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nmerge-gate: exit 0\n```\n',
      'package.json': '{"name":"c5","version":"1.0.0"}\n',
      'package-lock.json': '{"lockfileVersion":3}\n',
      'src/app.mjs': 'export const v = 1\n',
    })
    const outside = tmpProject({ 'SURVIVE.txt': 'keep me' })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    try {
      gitInit(dir, { branch: 'main', name: 'impl', email: 'impl@example.com' })
      mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'pkg', 'SURVIVE.txt'), 'MAIN_NM_INTACT')
      gitCommitFast(dir, 'init')

      // 1. 跟踪链接：cleanup 档不许豁免（被阻塞/显式放行后必须 unlinkSync）；deps 档跳过以免弄脏工作区
      const wt = join(dir, '.worktrees', 'wt-tracked')
      gitSync(dir, ['worktree', 'add', '-b', 'feat/wt-tracked', wt])
      const linkRel = 'linked'
      symlinkSync(outside, join(wt, linkRel), linkType)
      const blobRes = gitSync(wt, ['hash-object', '-w', '--stdin'], { input: outside, encoding: 'utf8' })
      const blobSha = blobRes.stdout.trim()
      gitSync(wt, ['update-index', '--add', '--cacheinfo', `120000,${blobSha},${linkRel}`])
      gitSync(wt, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'track link'])

      const depsModeRes = unmountSharedDeps(dir, wt, { mode: 'deps' })
      if (!depsModeRes.skipped?.some((s) => s.path === linkRel && s.reason === 'tracked-in-git') || !existsSync(join(wt, linkRel))) {
        return `deps 档应跳过已跟踪链接以防工作区变脏：${JSON.stringify(depsModeRes)}`
      }
      const blockedTracked = unmountSharedDeps(dir, wt, { mode: 'cleanup' })
      if (blockedTracked.ok !== false || !blockedTracked.blocked.some((b) => b.path === linkRel)) {
        return `cleanup 档未拦下未获准的已跟踪外链：${JSON.stringify(blockedTracked)}`
      }
      const cleanupTracked = unmountSharedDeps(dir, wt, { mode: 'cleanup', allowOutbound: [linkRel] })
      if (cleanupTracked.ok !== true || cleanupTracked.unmounted.every((u) => u.path !== linkRel) || lstatSync(join(wt, linkRel), { throwIfNoEntry: false })) {
        return `cleanup 档显式放行已跟踪链接后未真正解绑：${JSON.stringify(cleanupTracked)}`
      }
      if (!existsSync(join(outside, 'SURVIVE.txt'))) return '解绑已跟踪链接把仓外内容删了'

      // 2. review-diff syncTier2ReviewSlotIfNeeded（走 callReviewDepsHelper + { mode: 'deps' }）+ runTrialMerge 端到端
      const roots = await resolveRepoRoots(dir)
      const started = await handleStart({ task: 'c5-tm', case: '2', slug: 'c5-tm', implementer: 'impl', 'no-issue': true, reason: '回归夹具聚焦试合与共享依赖' }, roots)
      if (started.exitCode !== 0) return `start c5-tm 失败：${started.exitCode}`
      const { handleClaim: claimC5 } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')
      await claimC5({ task: 'c5-tm', agent: 'impl' }, roots)
      await seedExploredFor(dir, 'c5-tm')
      const l1 = readTaskLedger(dir, 'c5-tm')
      const implAbs = join(dir, l1.worktreePath)
      writeFileSync(join(implAbs, 'src', 'app.mjs'), 'export const v = 2\n')
      gitCommitFast(implAbs, 'feat: v2', { updateOnly: true })

      const rev1 = await syncTier2ReviewSlotIfNeeded({
        mainRoot: dir, worktreeRoot: dir, opts: {}, task: readTaskLedger(dir, 'c5-tm'), mode: 'task',
      })
      if (!rev1 || rev1.depsMode !== 'shared') return `review 槽首次挂载共享依赖失败：${JSON.stringify(rev1)}`
      writeFileSync(join(implAbs, 'src', 'app.mjs'), 'export const v = 3\n')
      gitCommitFast(implAbs, 'feat: v3', { updateOnly: true })
      const rev2 = await syncTier2ReviewSlotIfNeeded({
        mainRoot: dir, worktreeRoot: dir, opts: {}, task: readTaskLedger(dir, 'c5-tm'), mode: 'task',
      })
      if (!rev2 || rev2.depsMode !== 'shared' || !existsSync(join(dir, 'node_modules', 'pkg', 'SURVIVE.txt'))) {
        return `review 槽二次推进同步失败或主仓依赖受损：${JSON.stringify(rev2)}`
      }
      const lAfterRev = readTaskLedger(dir, 'c5-tm')
      if (!lAfterRev.mountedDepsByWorktree?.[lAfterRev.reviewWorktreePath]?.includes('node_modules')) {
        return `review-diff 同步未写盘 review 槽挂载清单：${JSON.stringify(lAfterRev.mountedDepsByWorktree)}`
      }

      await handleVerify({ task: 'c5-tm', mode: 'full' }, roots)
      const tmRes = await runTrialMerge({
        mainRoot: dir,
        ledger: readTaskLedger(dir, 'c5-tm'),
        baseBranch: 'main',
        profile: { fullTest: 'node -e "if(!require(\'fs\').existsSync(\'node_modules/pkg/SURVIVE.txt\'))process.exit(1)"' },
        policy: { riskTier: 'medium', requiredGates: ['full'] },
        runVerify: true,
      })
      if (!tmRes.ok || !tmRes.trialMerged) return `runTrialMerge 带着主仓 node_modules 试合失败：${JSON.stringify(tmRes)}`
      if (!existsSync(join(dir, 'node_modules', 'pkg', 'SURVIVE.txt'))) {
        return 'runTrialMerge 试合后主仓 node_modules 哨兵文件被删穿'
      }
      if (existsSync(join(dir, '.worktrees', '.tmp-merge-c5-tm'))) {
        return 'runTrialMerge 试合后临时 worktree 未清理'
      }

      // 3. 干净工作树含已提交跟踪的外链（core.symlinks=true）时，不传 --force 运行 cleanup --confirm --allow-outbound 也必须能删掉
      const { handleCleanup } = await import('../../kit/skills/dev-flow/scripts/flow-cleanup.mjs')
      gitSync(dir, ['config', 'core.symlinks', 'true'])
      const stTracked = await handleStart({ task: 'c1-tracked-clean', case: '2', slug: 'c1-tracked-clean', 'no-issue': true, reason: '回归夹具聚焦已跟踪外链清理' }, roots)
      if (stTracked.exitCode !== 0) return `start c1-tracked-clean 失败：${stTracked.exitCode}`
      const lTr = readTaskLedger(dir, 'c1-tracked-clean')
      const wtTr = join(dir, lTr.worktreePath)
      let dirSymOk = false
      try {
        symlinkSync(outside, join(wtTr, 'extlink'), 'dir')
        dirSymOk = true
      } catch (e) {
        if (e?.code !== 'EPERM') throw e
      }
      if (dirSymOk) {
        gitSync(wtTr, ['add', 'extlink'])
        gitSync(wtTr, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'commit tracked extlink'])
        gitSync(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '--no-ff', lTr.branch, '-m', 'merge tracked extlink'])
        const prevTr = JSON.parse((await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 'c1-tracked-clean', '--json'], { cwd: dir })).stdout).previewHash
        const clTr = await handleCleanup({ task: 'c1-tracked-clean', confirm: true, 'preview-hash': prevTr, 'allow-outbound': ['extlink'], json: true }, roots)
        if (clTr.exitCode !== 0 || existsSync(wtTr)) {
          return `干净工作树含跟踪外链不带 --force 清理失败：exit=${clTr.exitCode}`
        }
        if (!existsSync(join(outside, 'SURVIVE.txt'))) return '不带 --force 清理跟踪外链后仓外哨兵丢失'
      }
      return true
    } finally { rmTree(dir); rmTree(outside) }
  }])
}
