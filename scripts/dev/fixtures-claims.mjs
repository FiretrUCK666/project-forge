import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitCommitFast, gitInit, gitSync, issueTokenFor, loadPreflight,
  readDirRefs, rmTree, runAbsAsync, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'


/** 契约回查、锚点、缺口覆盖、身份与凭据、工具链行为。 */
export function registerClaimsCases(cases) {
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


// ── 命令词法：动作词只在命令位置匹配 ──────────────────────────────────
//
// 判据治的是「文本里出现过 test 就算测试命令」。两种误判各自坑一类项目：
// 路径中间带 test 的辅助脚本被当成测试入口（真跑起来什么都没有），
// 而唯一入口就叫 test-mac-pure.sh 的项目永远探测不到测试命令。
cases.push(['命令动作词只认命令位置：脚本名保留、路径中间分量与属性名不算', async () => {
  const { classifyCommandText } = await import('../../kit/skills/lib/command-lex.mjs')
  const RULES = [
    { key: 'test', re: /\b(?:test|tests|check|verify)\b/i },
    { key: 'install', re: /\b(?:install|restore)\b/i },
  ]

  // 正面：脚本名本身就叫 test 的（唯一入口）必须认出来——带不带 ./ 都算。
  if (classifyCommandText('bash scripts/test-mac-pure.sh', RULES) !== 'test') {
    return 'bash 调用的 test-*.sh 脚本没被认成测试入口——这类项目会永远探测不到测试命令'
  }
  if (classifyCommandText('./scripts/test-mac-pure.sh', RULES) !== 'test') {
    return './ 调用的 test-*.sh 脚本没被认成测试入口'
  }
  if (classifyCommandText('npm test', RULES) !== 'test') return 'npm test 没被认成测试'
  if (classifyCommandText('pip install -r requirements.txt', RULES) !== 'install') return 'pip install 没被认成安装'

  // 反面：路径中间分量里的关键词不算动作。
  if (classifyCommandText('node scripts/ci/test-helper/run.mjs', RULES) !== undefined) {
    return 'test-helper 目录名让整条命令变成了测试命令'
  }
  if (classifyCommandText('bash scripts/test-helper/run.sh', RULES) !== undefined) {
    return 'test-helper 目录名让 shell 脚本变成了测试命令'
  }
  // 反面：属性名（.Restore / .Length）不是动作。
  if (classifyCommandText('echo .Restore', RULES) !== undefined) return '属性名 .Restore 被当成了安装动作'
  if (classifyCommandText('dotnet msbuild /t:Restore', RULES) !== undefined) return '/t:Restore 参数被当成了安装动作'
  // 反面：选项取值不是动作。
  if (classifyCommandText('git archive --format=zip -o a.zip HEAD', RULES) !== undefined) {
    return '--format 的取值被当成了动作词'
  }
  // 反面：引号里的 && 不是分段符。
  if (classifyCommandText('echo "a && b" && npm test', RULES) !== 'test') {
    return '引号里的 && 被当成了分段，第二段的 test 没被认出来'
  }
  return true
}])

}
