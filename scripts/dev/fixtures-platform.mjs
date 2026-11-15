/**
 * fixtures-platform.mjs —— 平台夹具：身份与远端拓扑、SSH 与凭据探针、generic-git 降级、发布通道与跨平台交棒边界。
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { SKILL_ROOT, gitInit, rmTree, runAbs, runNode, survey, tmpProject } from './fixtures-helpers.mjs'

export function registerPlatformCases(cases) {
cases.push(['无远端探测不写 known_hosts、SSH Host 别名、generic-git 放行 merge 与多远端拓扑', async () => {
  const {
    getHostingProvider, listHostingProviders, parseSshConfigHostMap,
    probeGitHubEnv, resolveRemotesTopology, resolveWorkspaceIdentity,
  } = await import('../lib/platform/index.mjs')

  // 1. 注册表边界：仅注册 github，且无远端 --probe-auth 可运行不报错
  const providers = listHostingProviders().map((p) => p.id)
  if (providers.join(',') !== 'github' || !getHostingProvider('generic-git')) {
    return `注册表或 generic-git 异常：${JSON.stringify(providers)}`
  }

  // 2. SSH Host 别名解析与多远端拓扑
  const sshMap = parseSshConfigHostMap([
    'Host github-work',
    '  HostName github.com',
    '  User git',
  ].join('\n'))
  const topo = resolveRemotesTopology(
    'origin\tgit@github-work:org/app.git (fetch)\norigin\tgit@github-work:org/app.git (push)\n',
    { sshHostMap: sshMap },
  )
  if (topo.primaryProviderId !== 'github' || topo.primary?.repoSlug !== 'org/app') {
    return `SSH 别名未解析为 github：${JSON.stringify(topo)}`
  }
  const idAlias = await resolveWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'git@github-work:org/app.git',
      remoteUrls: { origin: 'git@github-work:org/app.git' },
      userName: 'org',
      userEmail: 'org@example.com',
      commits: 1,
      historyAuthors: ['org <org@example.com>'],
    },
    declaredRepo: 'org/app',
    sshHostMap: sshMap,
  })
  if (idAlias.role !== 'maintainer') return `SSH 别名仓库被误判为 ${idAlias.role} (${idAlias.reason})`

  // 3. probeSshTransport 强制 StrictHostKeyChecking=yes 且无 known_hosts 写盘副作用
  const { probeSshTransport } = await import('../lib/platform/github-probe.mjs')
  let sawStrictYes = false
  const sshRes = await probeSshTransport({
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 2000,
    runner: async (cmd, args) => {
      if (cmd === 'ssh') {
        if (args.includes('StrictHostKeyChecking=accept-new')) throw new Error('forbidden accept-new')
        if (args.includes('StrictHostKeyChecking=yes')) sawStrictYes = true
        return { code: 255, stdout: '', stderr: 'Host key verification failed.' }
      }
      return { code: 1, stdout: '', stderr: 'no identities' }
    },
  })
  if (!sawStrictYes || sshRes.state !== 'host-key-unverified') {
    return `StrictHostKeyChecking=yes 未生效：${JSON.stringify(sshRes)}`
  }

  // 4. 无远端目录 --probe-auth 正常执行；未知主机 generic-git 放行 flow merge
  const dirNoRemote = tmpProject({ 'README.md': '# local\n' })
  const dirGeneric = tmpProject({
    '.gitignore': '.worktrees/\n',
    'README.md': '# generic\n',
    'AGENTS.md': '# generic\n\n```yaml\nquick-test: node -e "process.exit(0)"\n```\n',
  })
  try {
    gitInit(dirNoRemote)
    const sNoRem = await survey(dirNoRemote, { probeAuth: true, offline: true })
    if (!sNoRem.git?.auth?.probed) return `无远端 --probe-auth 未执行探测：${JSON.stringify(sNoRem.git?.auth)}`

    gitInit(dirGeneric)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: dirGeneric, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 't'], { cwd: dirGeneric, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dirGeneric, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'https://git.internal.corp/team/repo.git'], { cwd: dirGeneric, stdio: 'ignore' })

    const st = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-gen', '--case', '1', '--slug', 'gen', '--json'], { cwd: dirGeneric })
    if (st.status !== 0) return `generic-git start 失败：${st.stderr}`
    const l = JSON.parse(st.stdout)
    if (l.role !== 'generic-git' || l.providerId !== 'generic-git') return `generic-git 角色错误：${st.stdout}`
    const v = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-gen'], { cwd: dirGeneric })
    if (v.status !== 0) return `generic-git verify 失败：${v.stderr}`
    const m = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-gen', '--json'], { cwd: dirGeneric })
    if (m.status !== 0) return `generic-git 阻断了本地 merge：exit=${m.status} ${m.stderr}`

    const probeOffline = await probeGitHubEnv({
      cwd: dirNoRemote,
      remoteUrls: {},
      env: {},
      offline: true,
      runner: async () => ({ code: 1, stdout: '', stderr: '' }),
    })
    if (probeOffline.probed !== true || probeOffline.hasRemote !== false || probeOffline.apiChannel?.tier !== 'offline') {
      return `无远端离线通道异常：${JSON.stringify(probeOffline)}`
    }

    const probeExpired = await probeGitHubEnv({
      cwd: dirNoRemote,
      remoteUrls: {},
      env: { GH_TOKEN: 'ghp_' + 'x'.repeat(36) },
      verifyToken: true,
      runner: async () => ({ code: 1, stdout: '', stderr: '' }),
      httpRequest: async () => ({ status: 401, data: { message: 'Bad credentials' } }),
    })
    if (probeExpired.details?.tokenStatus !== 'invalid' || probeExpired.apiChannel?.tier === 'node-https-token') {
      return `过期 Token 未被验活过滤：${JSON.stringify(probeExpired)}`
    }
    return true
  } finally { rmTree(dirNoRemote); rmTree(dirGeneric) }
}])

cases.push(['发布通道：release.yml 固定解压前缀、README 一键链接与 CHANGELOG 双格式及空 tag 拦截', async () => {
  const relYml = readFileSync(join(SKILL_ROOT, '.github/workflows/release.yml'), 'utf8')
  if (!relYml.includes('--prefix="project-forge/"') || /--prefix="project-forge-\$\{?VERSION\}?\/"/.test(relYml)) {
    return '.github/workflows/release.yml 解压前缀未固定为 project-forge/'
  }
  const tplRelYml = readFileSync(join(SKILL_ROOT, 'templates/ci-release.yml'), 'utf8')
  if (!tplRelYml.includes('BARE_TAG="${TAG#v}"') || !tplRelYml.includes('index($0, "## [" bare "]")')) {
    return 'templates/ci-release.yml 未兼容无 v 的 CHANGELOG 标题格式'
  }
  if (!/workflow_dispatch[\s\S]*?-z "\$INPUT_TAG"/.test(tplRelYml)) {
    return 'templates/ci-release.yml 缺少空 workflow_dispatch tag 参数阻断检查'
  }
  if (!tplRelYml.includes('RELEASE_TOKEN') || !/401\|403/.test(tplRelYml)) {
    return 'templates/ci-release.yml 缺少 401/403 RELEASE_TOKEN 刷新指引'
  }
  for (const rName of ['README.md', 'README.en.md']) {
    const txt = readFileSync(join(SKILL_ROOT, rName), 'utf8')
    if (!txt.includes('https://github.com/FiretrUCK666/project-forge/releases/latest/download/project-forge.zip')) {
      return `${rName} 缺少最新正式版一键下载 zip 链接`
    }
    if (!txt.includes('PF_NO_UPDATE=1')) return `${rName} 缺少 PF_NO_UPDATE=1 说明`
  }
  return true
}])

cases.push(['Java 空目录起步、handoff 跳过挂载链接与 manifest、macOS 元数据过滤、NFC/进程树清理', async () => {
  // 1. --bootstrap-empty --lang java 生成可编译源码与 docs/TDD.md
  const javaDir = tmpProject({})
  const handoffDir = tmpProject({
    '.gitignore': 'node_modules/\n.worktrees/\n',
    'package.json': '{"name":"h-demo","version":"1.0.0"}\n',
    'README.md': '# h-demo\n\n带依赖链接的交棒验收项目。\n',
    '._mac_resource_fork': 'junk',
    '.DS_Store': 'junk',
    '__MACOSX/ghost.txt': 'junk',
  })
  try {
    const bootJava = await runNode('equip.mjs', [javaDir, '--bootstrap-empty', '--lang', 'java', '--name', 'JavaDemo'])
    if (bootJava.status !== 0) return `--bootstrap-empty --lang java 失败：${bootJava.stderr}`
    for (const f of ['src/main/java/app/Greeter.java', 'src/test/java/app/SmokeTest.java', 'docs/TDD.md', 'README.md']) {
      if (!existsSync(join(javaDir, f))) return `java 起步缺少 ${f}`
    }
    if (!readFileSync(join(javaDir, 'docs/TDD.md'), 'utf8').includes('## 文档信息')) {
      return 'starterTdd 未包含 ## 文档信息 元信息表'
    }

    // 2. macOS 元数据在 survey / repo-map 全面过滤 + handoff 保留 .agents/skills/ 且跳过 .worktrees/ 依赖链接退出 0
    gitInit(handoffDir)
    spawnSync('git', ['branch', '-M', 'main'], { cwd: handoffDir, stdio: 'ignore' })
    mkdirSync(join(handoffDir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(handoffDir, 'node_modules/dep/index.js'), '1\n')
    mkdirSync(join(handoffDir, '.worktrees/impl-1'), { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(join(handoffDir, 'node_modules'), join(handoffDir, '.worktrees/impl-1/node_modules'), linkType)

    const sMac = await survey(handoffDir)
    if ((sMac.scale?.totalFiles ?? 0) > 4) {
      return `survey 未过滤 macOS 元数据文件：totalFiles=${sMac.scale?.totalFiles}`
    }

    await runNode('equip.mjs', [handoffDir, '--no-backup'])
    const hv = await runNode('handoff.mjs', [handoffDir, '--verify', '--json'])
    if (hv.status !== 0) return `带 .pf-manifest.json 与 .worktrees 链接的 handoff --verify 应返回 0，实际=${hv.status}: ${hv.stdout} ${hv.stderr}`

    // 3. canonicalPath / samePath NFD-NFC 等价 + execShellCommand detached 超时杀整棵进程树
    const { canonicalPath, execShellCommand, samePath } = await import('../../kit/skills/lib/git.mjs')
    const nfc = join(handoffDir, 'caf\u00e9-doc.md')
    const nfd = join(handoffDir, 'cafe\u0301-doc.md')
    if (canonicalPath(nfc) !== canonicalPath(nfd) || !samePath(nfc, nfd)) {
      return `NFD/NFC 路径未归一等价：${canonicalPath(nfc)} vs ${canonicalPath(nfd)}`
    }
    const timeoutRes = await execShellCommand(`${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 50)"`, handoffDir, { timeout: 150 })
    if (!timeoutRes.timedOut || timeoutRes.ok) {
      return `execShellCommand 超时未触发进程树强杀：${JSON.stringify(timeoutRes)}`
    }
    return true
  } finally {
    rmTree(javaDir)
    rmTree(handoffDir)
  }
}])

cases.push(['assets/readme/*.svg 与打包边界：SVG 安全结构与 isProductLayerPath 正反双向', async () => {
  const { isProductLayerPath } = await import('./preflight.mjs')
  const { FORBIDDEN_PLATFORM_RE } = await import('../lib/protocol.mjs')
  const EMOJI_RE = /\p{Extended_Pictographic}/u

  const expectedSvgs = [
    'assets/readme/hero.svg',
    'assets/readme/hero-en.svg',
    'assets/readme/workflow.svg',
    'assets/readme/workflow-en.svg',
    'assets/readme/architecture.svg',
    'assets/readme/architecture-en.svg',
  ]
  for (const relPath of expectedSvgs) {
    if (!existsSync(join(SKILL_ROOT, relPath))) return `缺少视觉 SVG 卡片：${relPath}`
    if (!isProductLayerPath(relPath)) return `isProductLayerPath 拒绝了 assets/readme 资产：${relPath}`
    const raw = readFileSync(join(SKILL_ROOT, relPath), 'utf8')
    if (!/<svg\b/i.test(raw) || !/<\/svg>/i.test(raw) || !/\bviewBox\s*=\s*["'][^"']+["']/i.test(raw) || !/<title\b/i.test(raw)) {
      return `SVG 结构或无障碍标签不完整：${relPath}`
    }
    if (/<script\b|<foreignObject\b|<image\b/i.test(raw)) return `SVG 含禁用元素：${relPath}`
    const stripped = raw.replace(/\bxmlns(?::[a-z0-9_-]+)?\s*=\s*["']http:\/\/www\.w3\.org\/[^"']*["']/gi, '')
    if (/https?:\/\//i.test(stripped)) return `SVG 含非标准外链 URL：${relPath}`
    if (EMOJI_RE.test(raw) || FORBIDDEN_PLATFORM_RE.test(raw)) return `SVG 含 Emoji 或禁用平台词：${relPath}`
  }

  for (const bad of ['assets/other/junk.bin', 'assets/readme/nested/a.svg', 'assets/readme/hero.png', 'docs/TDD.md']) {
    if (isProductLayerPath(bad)) return `isProductLayerPath 误放行了非法路径：${bad}`
  }
  return true
}])

cases.push(['多维护者团队协同：team-collaborator 与 owner 区分、防误判底线、零提交/外部 Fork 与离线 teamProbeHint', async () => {
  const { classifyWorkspaceIdentity } = await import('../lib/platform/github.mjs')
  const { resolveWorkspaceIdentity } = await import('../../kit/skills/lib/shared.mjs')
  const { toMarkdown } = await import('../lib/render.mjs')

  const baseGitFacts = {
    present: true,
    remote: 'https://github.com/org-a/team-app.git',
    remoteUrls: { origin: 'https://github.com/org-a/team-app.git' },
    commitCount: 3,
    historyAuthors: ['Lead <lead@org-a.example>'],
    userName: 'NewMember',
    userEmail: 'new@org-a.example',
  }

  // 1. 正面（团队写权限协作者）：origin === declaredRepo 且登录账号不同于 originOwner -> maintainer + team-collaborator，无 teamProbeHint
  const ghTeam = classifyWorkspaceIdentity({
    gitFacts: baseGitFacts,
    declaredRepo: 'org-a/team-app',
    probeApi: { canPush: true, viewerPermission: 'WRITE', login: 'teammate-dev' },
  })
  if (ghTeam.role !== 'maintainer' || ghTeam.collaborationScope !== 'team-collaborator' || ghTeam.teamProbeHint) {
    return `github.mjs 未将写权限团队协作者判为 team-collaborator：${JSON.stringify(ghTeam)}`
  }
  const shTeam = resolveWorkspaceIdentity({
    remoteUrls: baseGitFacts.remoteUrls,
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
    apiProbe: { canPush: true, viewerPermission: 'WRITE', viewerLogin: 'teammate-dev' },
  })
  if (shTeam.role !== 'maintainer' || shTeam.collaborationScope !== 'team-collaborator' || shTeam.teamProbeHint) {
    return `shared.mjs 未将写权限团队协作者判为 team-collaborator：${JSON.stringify(shTeam)}`
  }

  // 2. 正面（所有者）：账号与 originOwner 同名 -> owner
  const ghOwner = classifyWorkspaceIdentity({
    gitFacts: { ...baseGitFacts, remote: 'https://github.com/alice/my-app.git', remoteUrls: { origin: 'https://github.com/alice/my-app.git' } },
    declaredRepo: 'alice/my-app',
    probeApi: { canPush: true, viewerPermission: 'ADMIN', login: 'alice' },
  })
  const shOwner = resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://github.com/alice/my-app.git' },
    declaredRepo: 'alice/my-app',
    apiProbe: { canPush: true, viewerPermission: 'ADMIN', viewerLogin: 'alice' },
  })
  if (ghOwner.role !== 'maintainer' || ghOwner.collaborationScope !== 'owner' || shOwner.role !== 'maintainer' || shOwner.collaborationScope !== 'owner') {
    return `owner 判定异常：gh=${JSON.stringify(ghOwner)}, sh=${JSON.stringify(shOwner)}`
  }

  // 3. 反面（C4 底线 + 离线 teamProbeHint）：同源无探针且历史作者非本机 -> 保守 clone-readonly + 带 teamProbeHint
  const ghOffline = classifyWorkspaceIdentity({ gitFacts: baseGitFacts, declaredRepo: 'org-a/team-app' })
  const shOffline = resolveWorkspaceIdentity({
    remoteUrls: baseGitFacts.remoteUrls,
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
  })
  if (ghOffline.role !== 'clone-readonly' || !ghOffline.teamProbeHint?.includes('--probe-auth')) {
    return `github.mjs 离线同源未保留 clone-readonly + teamProbeHint：${JSON.stringify(ghOffline)}`
  }
  if (shOffline.role !== 'clone-readonly' || !shOffline.teamProbeHint?.includes('--probe-auth')) {
    return `shared.mjs 离线同源未保留 clone-readonly + teamProbeHint：${JSON.stringify(shOffline)}`
  }

  // 4. 零提交同源无写证明 -> 保守 undetermined + 带 teamProbeHint
  const ghZero = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/org-a/empty-repo.git',
      remoteUrls: { origin: 'https://github.com/org-a/empty-repo.git' },
      commitCount: 0,
      historyAuthors: [],
      userName: 'NewMember',
      userEmail: 'new@org-a.example',
    },
    declaredRepo: 'org-a/empty-repo',
  })
  const shZero = resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://github.com/org-a/empty-repo.git' },
    declaredRepo: 'org-a/empty-repo',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: [],
    commits: 0,
  })
  if (ghZero.role !== 'undetermined' || !ghZero.teamProbeHint || shZero.role !== 'undetermined' || !shZero.teamProbeHint) {
    return `零提交同源未保守归入 undetermined + teamProbeHint：gh=${JSON.stringify(ghZero)}, sh=${JSON.stringify(shZero)}`
  }

  // 5. 外部 Fork（origin !== declaredRepo 或 upstream !== origin）与已确认只读 API -> 不应误出 teamProbeHint
  const ghFork = classifyWorkspaceIdentity({
    gitFacts: {
      ...baseGitFacts,
      remote: 'https://github.com/contrib/team-app.git',
      remoteUrls: { origin: 'https://github.com/contrib/team-app.git', upstream: 'https://github.com/org-a/team-app.git' },
    },
    declaredRepo: 'org-a/team-app',
  })
  const shFork = resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://github.com/contrib/team-app.git' },
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
  })
  if (ghFork.role !== 'contributor-fork' || ghFork.teamProbeHint || shFork.role !== 'contributor-fork' || shFork.teamProbeHint) {
    return `外部 Fork 异常或误出 teamProbeHint：gh=${JSON.stringify(ghFork)}, sh=${JSON.stringify(shFork)}`
  }

  const ghApiRead = classifyWorkspaceIdentity({
    gitFacts: baseGitFacts,
    declaredRepo: 'org-a/team-app',
    probeApi: { canPush: false, viewerPermission: 'READ', login: 'outsider' },
  })
  const shApiRead = resolveWorkspaceIdentity({
    remoteUrls: baseGitFacts.remoteUrls,
    declaredRepo: 'org-a/team-app',
    gitIdentity: { name: 'NewMember', email: 'new@org-a.example' },
    historyAuthors: baseGitFacts.historyAuthors,
    commits: 3,
    apiProbe: { canPush: false, viewerPermission: 'READ', viewerLogin: 'outsider' },
  })
  if (ghApiRead.role !== 'clone-readonly' || ghApiRead.teamProbeHint || shApiRead.role !== 'clone-readonly' || shApiRead.teamProbeHint) {
    return `已确认 API 只读不应再输出 teamProbeHint：gh=${JSON.stringify(ghApiRead)}, sh=${JSON.stringify(shApiRead)}`
  }

  // 6. 临时仓联动：flow.mjs inspect（离线带 teamProbeHint）与 survey.mjs + render.mjs
  const teamDir = tmpProject({
    'package.json': `${JSON.stringify({ name: 'team-app', version: '1.0.0', repository: 'org-a/team-app', scripts: { test: 'node --test' } }, null, 2)}\n`,
    'README.md': '# team-app\n',
    'src/index.mjs': 'export const ok = true\n',
  })
  try {
    spawnSync('git', ['init', '-q'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=Lead', '-c', 'user.email=lead@org-a.example', 'add', '-A'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['-c', 'user.name=Lead', '-c', 'user.email=lead@org-a.example', 'commit', '-qm', 'init by lead'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.name', 'NewTeammate'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'new@org-a.example'], { cwd: teamDir, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/org-a/team-app.git'], { cwd: teamDir, stdio: 'ignore' })

    const flowJsonRes = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['inspect', '--json'], { cwd: teamDir })
    if (flowJsonRes.status !== 0) return `flow.mjs inspect --json 失败：${flowJsonRes.stderr}`
    const flowJson = JSON.parse(flowJsonRes.stdout)
    if (flowJson.identity?.role !== 'clone-readonly' || !flowJson.identity?.teamProbeHint?.includes('--probe-auth')) {
      return `flow.mjs inspect --json 离线同源未给出 teamProbeHint：${JSON.stringify(flowJson.identity)}`
    }

    const flowTextRes = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['inspect'], { cwd: teamDir })
    if (flowTextRes.status !== 0 || !flowTextRes.stdout.includes('团队权限提示') || !flowTextRes.stdout.includes('--probe-auth')) {
      return `flow.mjs inspect 文本缺少团队权限提示：\n${flowTextRes.stdout}`
    }

    const sOff = await survey(teamDir)
    const mdOff = toMarkdown(sOff)
    if (sOff.git?.role !== 'clone-readonly' || !sOff.git?.teamProbeHint || !mdOff.includes('协同提示：') || !mdOff.includes('团队/组织协作者写权限')) {
      return `survey + render 离线未展现 teamProbeHint：\n${mdOff}`
    }

    const sTeam = await survey(teamDir, { probeApi: { canPush: true, viewerPermission: 'WRITE', login: 'new-teammate' } })
    const mdTeam = toMarkdown(sTeam)
    if (sTeam.git?.role !== 'maintainer' || sTeam.git?.collaborationScope !== 'team-collaborator' || sTeam.git?.teamProbeHint || !mdTeam.includes('角色 `maintainer`（团队协作者）')) {
      return `survey + render 团队协作者展示异常：${JSON.stringify(sTeam.git)}\n${mdTeam}`
    }
    return true
  } finally {
    rmTree(teamDir)
  }
}])

}
