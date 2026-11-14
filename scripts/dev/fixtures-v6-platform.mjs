import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  SKILL_ROOT, gitInit, rmTree, runAbs, runNode, survey, tmpProject,
} from './fixtures-helpers.mjs'

export function registerV6PlatformCases(cases) {
// ── v6 平台抽象、自更新原子性、两档渐进装配与跨平台门禁（C5–C15, C25） ──────────

  cases.push(['v6 C5/C6/C13：release.yml 固定解压前缀、README 一键链接与 CHANGELOG 双格式及空 tag 拦截', async () => {
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

  cases.push(['v6 C7：update.mjs 同盘 staging 原子更新（中断回滚保留旧 SKILL.md）、全深度清退役与 15m 冷却', async () => {
    const {
      FAILURE_COOLDOWN_MS, applyPackage, readState, rememberState, resolveStatePath,
    } = await import('../update.mjs')
    const { PF_MANIFEST_SCHEMA_VERSION } = await import('../lib/protocol.mjs')
    if (PF_MANIFEST_SCHEMA_VERSION !== 2) return `PF_MANIFEST_SCHEMA_VERSION=${PF_MANIFEST_SCHEMA_VERSION}`
    if (FAILURE_COOLDOWN_MS !== 15 * 60 * 1000) return `FAILURE_COOLDOWN_MS=${FAILURE_COOLDOWN_MS}`

    // 1. applyPackage 写 kit/ 失败时：必须回滚并保留旧 SKILL.md 与旧文件内容
    const skillCopy = tmpProject({
      'SKILL.md': '---\nname: project-forge\ndescription: demo skill\nmetadata:\n  version: "5.0.0"\n---\n\n# old\n',
      'references/survey.md': '# old survey\n\n## 何时读本文件\n\nold\n',
      'templates/agents-project.md': '# old tpl\n',
      'scripts/update.mjs': '// old update\n',
      'scripts/lib/retired-old.mjs': '// retired deep lib\n',
      'kit/skills/dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: old\n---\n',
      'kit/skills/dev-flow/scripts/retired-ghost.mjs': '// retired deep kit\n',
    })
    const cwdShadow = tmpProject({ 'package.json': '{"name":"innocent","version":"1.0.0"}' })
    try {
      const newEntries = [
        { name: 'SKILL.md', data: Buffer.from('---\nname: project-forge\ndescription: demo skill\nmetadata:\n  version: "6.0.0"\n---\n\n# new\n') },
        { name: 'references/survey.md', data: Buffer.from('# new survey\n\n## 何时读本文件\n\nnew\n') },
        { name: 'templates/agents-project.md', data: Buffer.from('# new tpl\n') },
        { name: 'scripts/update.mjs', data: Buffer.from('// new update\n') },
        { name: 'kit/skills/dev-flow/SKILL.md', data: Buffer.from('---\nname: dev-flow\ndescription: new\n---\n') },
      ]

      // 故障注入模拟 Windows EPERM：写到 kit/ 时抛出权限异常
      const failWrite = (dest, buf) => {
        if (String(dest).replace(/\\/g, '/').includes('kit/skills/')) {
          const e = new Error('EPERM: operation not permitted')
          e.code = 'EPERM'
          throw e
        }
        writeFileSync(dest, buf)
      }
      const failRes = applyPackage(newEntries, {
        skillRoot: skillCopy,
        expectedVersion: '6.0.0',
        writeFile: failWrite,
      })
      if (failRes.ok !== false || failRes.rolledBack !== true) {
        return `write 失败未回滚：${JSON.stringify(failRes)}`
      }
      const afterFailSkill = readFileSync(join(skillCopy, 'SKILL.md'), 'utf8')
      if (!afterFailSkill.includes('5.0.0')) {
        return `中断回滚后 SKILL.md 版本被篡改：${afterFailSkill}`
      }
      if (!readFileSync(join(skillCopy, 'references/survey.md'), 'utf8').includes('# old survey')) {
        return '回滚未还原已写入的 references/survey.md'
      }

      // 2. 正常完成 applyPackage：最后写入 SKILL.md、深层清理退役文件、且不越界写入 process.cwd()
      const okRes = applyPackage(newEntries, {
        skillRoot: skillCopy,
        expectedVersion: '6.0.0',
      })
      if (!okRes.ok) return `applyPackage 正常更新失败：${JSON.stringify(okRes)}`
      if (!readFileSync(join(skillCopy, 'SKILL.md'), 'utf8').includes('6.0.0')) {
        return '正常更新后 SKILL.md 未升至 6.0.0'
      }
      if (existsSync(join(skillCopy, 'scripts/lib/retired-old.mjs')) || existsSync(join(skillCopy, 'kit/skills/dev-flow/scripts/retired-ghost.mjs'))) {
        return 'applyPackage 未递归清理 scripts/lib/** 与 kit/skills/** 退役文件'
      }
      if (existsSync(join(cwdShadow, '.agents'))) {
        return 'update.mjs 越界向当前 cwd 写入了 .agents/'
      }

      // 3. readState 未来时间戳自愈 + FAILURE_COOLDOWN_MS 状态
      const stateFile = resolveStatePath(skillCopy)
      rememberState({ checkedAt: Date.now() + 99999999, lastFailAt: Date.now() + 99999999 }, skillCopy)
      const healed = readState(skillCopy)
      if ((healed.checkedAt ?? 0) > Date.now() || (healed.lastFailAt ?? 0) > Date.now()) {
        return `未来时间戳未自愈：${JSON.stringify(healed)} (stateFile=${stateFile})`
      }
      return true
    } finally {
      rmTree(skillCopy)
      rmTree(cwdShadow)
    }
  }])

  cases.push(['v6 C8/C9：两档装配（lightweight/full）无损升档、manifest v2 删除墓碑与 --adopt-custom 绿灯', async () => {
    const dir = tmpProject({
      'package.json': '{"name":"tier-demo","version":"1.0.0","scripts":{"test":"node --test"}}\n',
      'README.md': '# tier-demo\n\n两档渐进装配与 manifest v2 测试仓。\n',
      'src/index.mjs': 'export const ok = true\n',
    })
    gitInit(dir)
    try {
      // 1. lightweight 档：仅装 3 个核心技能，AGENTS.md 体积 < 16384 字节
      const eqLight = await runNode('equip.mjs', [dir, '--tier', 'lightweight', '--no-backup'])
      if (eqLight.status !== 0) return `equip lightweight 失败：${eqLight.stderr}`
      if (existsSync(join(dir, '.agents/skills/dev-review')) || !existsSync(join(dir, '.agents/skills/dev-flow/SKILL.md'))) {
        return 'lightweight 档未按 LIGHTWEIGHT_KIT_SKILLS 裁剪技能'
      }
      const compLight = await runNode('compose-agents.mjs', [dir, '--tier', 'lightweight', '--no-backup'])
      if (compLight.status !== 0) return `compose lightweight 失败：${compLight.stderr}`
      const lightAgents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      const lightBytes = Buffer.byteLength(lightAgents, 'utf8')
      if (lightBytes >= 16384) return `lightweight AGENTS.md 体积过高：${lightBytes}`
      if (lightAgents.includes('.agents/skills/dev-review/SKILL.md')) {
        return 'lightweight 意图路由未过滤未装配的 dev-review'
      }

      // 2. 删除技能并写人改内容后升档 full：保留删除墓碑（绝不写回）并无损升档
      rmTree(join(dir, '.agents/skills/dev-plan'))
      const eqFull = await runNode('equip.mjs', [dir, '--tier', 'full', '--no-backup'])
      if (eqFull.status !== 0) return `升档 full 失败：${eqFull.stderr}`
      if (existsSync(join(dir, '.agents/skills/dev-plan'))) {
        return '用户主动删除 dev-plan 后 equip 竟将其强行写回（违反墓碑原则）'
      }
      if (!existsSync(join(dir, '.agents/skills/dev-review/SKILL.md')) || !existsSync(join(dir, 'docs/specs/.gitkeep'))) {
        return '无损升档 full 未补全 dev-review 与 docs/{prd,specs,todo}/.gitkeep'
      }

      // 3. 定制文件写入 CRLF 仍归一等价 -> 手改后 --adopt-custom 使 --check 返回 0
      const targetFlowSkill = join(dir, '.agents/skills/dev-flow/SKILL.md')
      const origFlow = readFileSync(targetFlowSkill, 'utf8')
      writeFileSync(targetFlowSkill, origFlow.replace(/\n/g, '\r\n'))
      const crlfCheck = await runNode('equip.mjs', [dir, '--check'])
      if (crlfCheck.status !== 0) return `CRLF/LF 归一等价校验误报漂移：${crlfCheck.stdout || crlfCheck.stderr}`

      writeFileSync(targetFlowSkill, `${origFlow}\n<!-- custom user note -->\n`)
      const driftBefore = await runNode('equip.mjs', [dir, '--check'])
      if (driftBefore.status === 0) return '未登记定制修改时 --check 却返回 0'

      const adopt = await runNode('equip.mjs', [dir, '--adopt-custom', 'dev-flow/SKILL.md', '--no-backup'])
      if (adopt.status !== 0) return `--adopt-custom 失败：${adopt.stderr}`
      const checkAfter = await runNode('equip.mjs', [dir, '--check'])
      if (checkAfter.status !== 0 || !checkAfter.stdout.includes('定制豁免：dev-flow/SKILL.md')) {
        return `--adopt-custom 后 --check 未返回 0 或未列出定制豁免：status=${checkAfter.status} out=${checkAfter.stdout} err=${checkAfter.stderr}`
      }
      const { checkEquip } = await import('../equip.mjs')
      const chkStruct = checkEquip(dir)
      if (!chkStruct.ok || !chkStruct.customized?.some((c) => c.path === 'dev-flow/SKILL.md')) {
        return `checkEquip 结构校验未列出 customized：${JSON.stringify(chkStruct)}`
      }

      // 4. --restore 显式恢复已删技能
      const restore = await runNode('equip.mjs', [dir, '--restore', 'dev-plan', '--no-backup'])
      if (restore.status !== 0 || !existsSync(join(dir, '.agents/skills/dev-plan/SKILL.md'))) {
        return `--restore dev-plan 失败：${restore.stderr}`
      }

      // 5. backup.mjs 滚动淘汰时永久钉住最新 pre-forge 基线快照
      const { createBackup, listBackups } = await import('../backup.mjs')
      await createBackup(dir, { label: 'pre-forge' })
      for (let i = 1; i <= 6; i += 1) {
        writeFileSync(join(dir, 'src/index.mjs'), `export const ok = ${i}\n`)
        await createBackup(dir, { label: `equip-${i}` })
      }
      const kept = listBackups(dir).backups ?? []
      if (!kept.some((b) => b.label === 'pre-forge')) {
        return `backup 滚动清理挤出了 pre-forge 基线快照：${JSON.stringify(kept.map((b) => b.label))}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['v6 C10/C11/C14：无远端探测不写 known_hosts、SSH Host 别名、generic-git 放行 merge 与多远端拓扑', async () => {
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

  cases.push(['v6 C15/C19/C25：Java 空目录起步、handoff 跳过挂载链接与 manifest、macOS 元数据过滤、NFC/进程树清理', async () => {
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
}
