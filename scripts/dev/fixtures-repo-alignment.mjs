/**
 * fixtures-repo-alignment.mjs —— 全仓模板水合、平台能力分流与单源收敛正反双向断言。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SKILL_ROOT, gitInit, gitSync, rmTree, runAbsAsync, runNode, tmpProject } from './fixtures-helpers.mjs'

export function registerRepoAlignmentCases(cases) {
  cases.push(['C1：templates/agents-project.md 与 equip-bootstrap --bootstrap-empty 无占位残余（正反双向）', async () => {
    const bootDir = tmpProject({})
    const keepDir = tmpProject({ 'AGENTS.md': '# keep\n\n## 取舍\n\n- `no-ci`：不配\n' })
    try {
      const tplAgents = readFileSync(join(SKILL_ROOT, 'templates', 'agents-project.md'), 'utf8')
      if (!tplAgents.includes('本项目尚未在清单里声明标准命令。')) {
        return 'templates/agents-project.md 缺少「里」字导致正则失配'
      }
      const res = await runNode('equip.mjs', [bootDir, '--bootstrap-empty', '--lang', 'python', '--name', 'PyDemo'])
      if (res.status !== 0) return `--bootstrap-empty 失败：${res.stderr}`
      const generated = readFileSync(join(bootDir, 'AGENTS.md'), 'utf8')
      if (generated.includes('本项目尚未在清单') || generated.includes('把真实命令写在这里')) {
        return 'equip-bootstrap --bootstrap-empty 仍残留空命令模板占位块'
      }
      if (!generated.includes('quick-test: none')) {
        return 'equip-bootstrap --bootstrap-empty 未正确水合 Dev Profile 为 none'
      }
      const keepRes = await runNode('equip.mjs', [keepDir, '--bootstrap-empty', '--no-backup'])
      if (keepRes.status === 0 || !readFileSync(join(keepDir, 'AGENTS.md'), 'utf8').includes('- `no-ci`：不配')) {
        return '--bootstrap-empty 未拒绝或误覆盖已有 AGENTS.md'
      }
      return true
    } finally {
      rmTree(bootDir)
      rmTree(keepDir)
    }
  }])

  cases.push(['C1/C4：equip-ci 按生态水合 check.yml 与 release.yml 裸标签及 VERSION_MANIFEST（正反双向）', async () => {
    const pyDir = tmpProject({
      'pyproject.toml': '[project]\nname = "py-app"\nversion = "1.2.3"\nrequires-python = ">=3.11"\n',
      'tests/test_ok.py': 'def test_ok():\n    assert True\n',
    })
    const bareRelDir = tmpProject({
      'manifest.json': '{"id":"my-plugin","version":"2.0.0","minAppVersion":"1.0.0"}\n',
      'package.json': '{"name":"my-plugin","version":"2.0.0"}\n',
    })
    try {
      gitInit(pyDir, { branch: 'main', origin: 'https://github.com/acme/py-app.git' })
      const chk = await runNode('equip-ci.mjs', [pyDir, '--kind', 'check', '--dry-run', '--json'])
      if (chk.status !== 0) return `python check --dry-run 失败：${chk.stderr}`
      const chkOut = JSON.parse(chk.stdout)
      const activeCheckYaml = chkOut.content.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
      if (activeCheckYaml.includes('actions/setup-node@v4') || activeCheckYaml.includes('<清单声明的版本>')) {
        return `非 Node 仓库 check.yml 仍残留 setup-node@v4：\n${activeCheckYaml.slice(0, 500)}`
      }
      if (!activeCheckYaml.includes('actions/setup-python@')) {
        return 'Python 仓库 check.yml 未水合 actions/setup-python'
      }

      gitInit(bareRelDir, { branch: 'trunk', origin: 'https://github.com/acme/my-plugin.git' })
      gitSync(bareRelDir, ['add', '.'])
      gitSync(bareRelDir, ['commit', '-m', 'init'])
      gitSync(bareRelDir, ['tag', '1.9.0'])
      const rel = await runNode('equip-ci.mjs', [bareRelDir, '--kind', 'release', '--dry-run', '--json'])
      if (rel.status !== 0) return `bare tag release --dry-run 失败：${rel.stderr}`
      const relOut = JSON.parse(rel.stdout)
      if (!relOut.content.includes("tags: ['[0-9]*']") || relOut.content.includes("startsWith(github.ref, 'refs/tags/v')")) {
        return '裸标签仓库 release.yml 未同步改写 tags 与 job.if 条件'
      }
      if (!relOut.content.includes("VERSION_MANIFEST: 'manifest.json'")) {
        return 'release.yml 未水合 VERSION_MANIFEST 为 manifest.json'
      }
      return true
    } finally {
      rmTree(pyDir)
      rmTree(bareRelDir)
    }
  }])

  cases.push(['C1：docs-tdd/prd/spec 模板契约与 doc-plan quick-test none 兜底（正反双向）', async () => {
    const dir = tmpProject({
      'README.md': '# doc-demo\n\n纯文档测试项目。\n',
      'AGENTS.md': '# doc-demo\n\n## Dev Profile\n\n```yaml\nquick-test: none\nfull-test: none\nsmoke-verify: none\nmerge-gate: none\narch-rules: none\nhigh-risk: AGENTS.md\ndo-not-edit: none\n```\n',
    })
    try {
      const tddTpl = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'templates', 'docs-tdd.md'), 'utf8')
      if (/<!--\s*section:\s*(?:doc-info|flow|invariants)\s+optional\s*-->/.test(tddTpl)) {
        return 'docs-tdd.md 核心节 doc-info/flow/invariants 仍误标 optional'
      }
      if (!/^##\s+安全与权限边界细节$/m.test(tddTpl)) {
        return 'docs-tdd.md 安全章节未使用二级标题 ## 安全与权限边界细节'
      }
      if (tddTpl.includes('纯解释型脚本项目可以整节删掉')) {
        return 'docs-tdd.md 仍保留允许删除核心 build 节的矛盾注释'
      }

      const prdTpl = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'templates', 'docs-prd.md'), 'utf8')
      if (!/^plan_mode:\s*interactive$/m.test(prdTpl) || !/^multi_spec:\s*false$/m.test(prdTpl) || !prdTpl.includes('superseded')) {
        return 'docs-prd.md 缺少 plan_mode: interactive / multi_spec: false / superseded'
      }

      const specTpl = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'templates', 'docs-spec.md'), 'utf8')
      if (!/^task_id:\s*null$/m.test(specTpl) || !/^scope_files:\s*\[\]$/m.test(specTpl) || !/^depends_on:\s*\[\]$/m.test(specTpl)) {
        return 'docs-spec.md 缺少 task_id/scope_files/depends_on frontmatter 字段'
      }

      gitInit(dir, { branch: 'main' })
      gitSync(dir, ['add', '.'])
      gitSync(dir, ['commit', '-m', 'init'])
      const initRes = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'init', '--kind', 'todo', '--slug', 'quick-none', '--title', 'Quick None Test', '--owner', 'arch-1', '--in-place', '--json',
      ], { cwd: dir })
      if (initRes.status !== 0) return `doc-plan init todo 失败：${initRes.stderr}`
      const created = JSON.parse(initRes.stdout)
      const todoPath = join(dir, created.files[0])
      const todoText = readFileSync(todoPath, 'utf8')
      if (todoText.includes('<填写项目快测命令>')) {
        return 'quick-test: none 时 doc-plan init 仍注入尖括号占位 <填写项目快测命令>'
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C2：review.mjs 按平台能力对 collab.* 与 release.absent 分流并保持 local-only ci.absent（正反双向）', async () => {
    const localDir = tmpProject({
      'README.md': '# local-pkg\n\n本地可发布测试包。\n',
      'package.json': '{"name":"local-pkg","version":"1.0.0"}\n',
    })
    const genDir = tmpProject({
      'README.md': '# gen-pkg\n\n通用 Git 远端可发布测试包。\n',
      'package.json': '{"name":"gen-pkg","version":"1.0.0"}\n',
      '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    })
    const ghDir = tmpProject({
      'README.md': '# gh-pkg\n\nGitHub 远端可发布测试包。\n',
      'package.json': '{"name":"gh-pkg","version":"1.0.0"}\n',
    })
    try {
      gitInit(localDir, { branch: 'main' })
      gitInit(genDir, { branch: 'main', origin: 'https://git.internal.corp/team/gen-pkg.git' })
      gitInit(ghDir, { branch: 'main', origin: 'https://github.com/acme/gh-pkg.git' })

      const revLocal = JSON.parse((await runNode('review.mjs', [localDir, '--json'])).stdout)
      const localIds = new Set(revLocal.results.map((r) => r.id))
      if (!localIds.has('ci.absent')) return 'local-only 无 CI 仓库遗失 ci.absent 契约'
      if (localIds.has('release.absent') || localIds.has('collab.pr-template') || localIds.has('collab.issue-templates')) {
        return `local-only 误报远端/发布项：${JSON.stringify([...localIds])}`
      }

      const revGen = JSON.parse((await runNode('review.mjs', [genDir, '--json'])).stdout)
      const genIds = new Set(revGen.results.map((r) => r.id))
      for (const bad of ['collab.pr-template', 'collab.issue-templates', 'collab.branch-protection', 'release.absent']) {
        if (genIds.has(bad)) return `generic-git 远端误报 GitHub 专属条目 ${bad}`
      }

      const revGh = JSON.parse((await runNode('review.mjs', [ghDir, '--json'])).stdout)
      const ghIds = new Set(revGh.results.map((r) => r.id))
      for (const req of ['collab.pr-template', 'collab.issue-templates', 'collab.branch-protection', 'release.absent']) {
        if (!ghIds.has(req)) return `GitHub 仓库漏报 ${req}`
      }
      return true
    } finally {
      rmTree(localDir)
      rmTree(genDir)
      rmTree(ghDir)
    }
  }])

  cases.push(['C2：registry.mjs 无远端返回 none/全 false 能力表且 ledger/task-backend/flow 无隐性 github 默认（正反双向）', async () => {
    const {
      classifyTopologyIdentity, probeTopologyEnv, resolveTopologyIdentity,
    } = await import('../lib/platform/registry.mjs')
    const { createDefaultLedger } = await import('../../kit/skills/lib/ledger.mjs')
    const { createTaskBackend } = await import('../../kit/skills/lib/task-backend.mjs')

    const topoClass = classifyTopologyIdentity({ gitFacts: { present: true, remoteUrls: {} } })
    const topoRes = await resolveTopologyIdentity({ gitFacts: { present: true, remoteUrls: {} } })
    const topoEnv = await probeTopologyEnv({ remoteUrls: {}, offline: true, runner: async () => ({ code: 1, stdout: '', stderr: '' }) })
    if (topoClass.providerId !== 'none' || topoRes.providerId !== 'none' || topoEnv.providerId !== 'none') {
      return `无远端拓扑 providerId 未返回 none：class=${topoClass.providerId}, res=${topoRes.providerId}, env=${topoEnv.providerId}`
    }
    for (const key of ['api', 'pr', 'issues', 'releases', 'labels', 'milestones', 'branchProtection', 'mention', 'uploadAttachment', 'checks']) {
      if (topoClass.capabilities?.[key] !== false || topoRes.capabilities?.[key] !== false || topoEnv.capabilities?.[key] !== false) {
        return `无远端拓扑能力位 ${key} 伪装为 true`
      }
    }

    const lLocal = createDefaultLedger({ taskId: 't-local' })
    const lGen = createDefaultLedger({ taskId: 't-gen', role: 'generic-git', providerId: 'generic-git' })
    if (lLocal.providerId !== 'none' || lGen.providerId !== 'generic-git') {
      return `createDefaultLedger 默认 providerId 异常：local=${lLocal.providerId}, gen=${lGen.providerId}`
    }

    const bkDefault = createTaskBackend({})
    const bkGeneric = createTaskBackend({ role: 'maintainer', providerId: 'generic-git', targetRepo: 'team/app' })
    const bkGh = createTaskBackend({ role: 'maintainer', providerId: 'github', targetRepo: 'acme/app' })
    if (bkDefault.kind !== 'local-only' || bkGeneric.kind !== 'generic-git' || bkGh.kind !== 'github') {
      return `createTaskBackend 默认/分流异常：default=${bkDefault.kind}, gen=${bkGeneric.kind}, gh=${bkGh.kind}`
    }
    return true
  }])

  cases.push(['C3：platform-registry.mjs 双端 10 键能力、5 方言、trim/toLowerCase、file:// 与 registerHostingProvider 对等（正反双向）', async () => {
    const kitPlatform = await import('../../kit/skills/lib/platform.mjs')
    const engineRegistry = await import('../lib/platform/registry.mjs')

    const kitGh = kitPlatform.getHostingProvider(' GitHub ')
    const engGh = engineRegistry.getHostingProvider(' GitHub ')
    if (!kitGh || !engGh || kitGh.id !== 'github' || engGh.id !== 'github') {
      return 'getHostingProvider 未实现 trim/toLowerCase 归一化'
    }
    const expectedKeys = ['api', 'pr', 'issues', 'releases', 'labels', 'milestones', 'branchProtection', 'mention', 'uploadAttachment', 'checks']
    for (const k of expectedKeys) {
      if (typeof kitGh.capabilities?.[k] !== 'boolean' || typeof engGh.capabilities?.[k] !== 'boolean') {
        return `双端 GitHub provider capabilities 缺少 10 键能力位 ${k}`
      }
    }
    if (kitGh.capabilities?.mention !== true || engGh.capabilities?.mention !== true || kitGh.capabilities?.uploadAttachment !== false || kitGh.capabilities?.checks !== true) {
      return '双端 GitHub provider 10 键能力位取值异常'
    }
    const kitGl = kitPlatform.getHostingProvider('gitlab')
    const kitGe = kitPlatform.getHostingProvider('gitee')
    if (kitGl?.capabilities?.uploadAttachment !== true || kitGe?.capabilities?.checks !== false) {
      return 'GitLab/Gitee 10 键能力位异常'
    }
    const fileDesc = kitPlatform.resolveRemoteDescriptor('file:///srv/git/team-repo.git')
    if (fileDesc.providerId !== 'generic-git' || fileDesc.repoSlug !== 'git/team-repo' || fileDesc.capabilities?.mention !== false || fileDesc.capabilities?.uploadAttachment !== false || fileDesc.capabilities?.checks !== false) {
      return `file:// 描述符解析异常：${JSON.stringify(fileDesc)}`
    }
    if (engGh !== engineRegistry.getHostingProvider('github')) {
      return 'engine 与 kit 注册表未共享同一底层实现'
    }
    return true
  }])

  cases.push(['C3：preflight-kernel-parity 单源原语与 cli-parity 12 入口及 printHelp 覆盖（正反双向）', async () => {
    const { runKernelParityChecks } = await import('./preflight-kernel-parity.mjs')
    const { ENTRY_SPECS, auditEntry, evaluateParity } = await import('./cli-parity.mjs')
    const { readdirSync } = await import('node:fs')
    const { join: pJoin } = await import('node:path')

    const kp = runKernelParityChecks({ ROOT: SKILL_ROOT })
    if (!kp.ok) return `kernel-parity 失败：${kp.failures.join('；')}`
    if (ENTRY_SPECS.length < 12) return `cli-parity ENTRY_SPECS 数量不足 12：当前 ${ENTRY_SPECS.length}`

    const walk = (dir, pred) => {
      const out = []
      const stack = [dir]
      while (stack.length) {
        const cur = stack.pop()
        for (const e of readdirSync(cur, { withFileTypes: true })) {
          const full = pJoin(cur, e.name)
          if (e.isDirectory()) stack.push(full)
          else if (pred(full)) out.push(full)
        }
      }
      return out
    }
    const audits = ENTRY_SPECS.map((s) => auditEntry(s, { ROOT: SKILL_ROOT, walk }))
    const ev = evaluateParity(audits)
    if (ev.failures.length > 0) return `cli-parity 12 入口失败：${ev.failures.join('；')}`

    for (const rel of [
      'kit/skills/dev-explore/scripts/doc-locate.mjs',
      'kit/skills/dev-explore/scripts/repo-map.mjs',
      'kit/skills/dev-flow/scripts/flow-intake.mjs',
      'kit/skills/dev-govern/scripts/govern-retro.mjs',
    ]) {
      const r = await runAbsAsync(rel, ['--help'], { cwd: SKILL_ROOT })
      if (r.status !== 0 || !r.stdout.includes('用法')) {
        return `${rel} --help 未正常输出帮助并退出 0：status=${r.status}`
      }
    }
    return true
  }])

  cases.push(['C4：issue-template-hydrate 剥离空节与裸列表且 feature_request.md 含 kit/（正反双向）', async () => {
    const { hydrateIssueBody } = await import('../../kit/skills/lib/issue-template-hydrate.mjs')
    const dir = tmpProject({
      '.github/ISSUE_TEMPLATE/bug_report.md': readFileSync(join(SKILL_ROOT, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), 'utf8'),
      '.github/ISSUE_TEMPLATE/feature_request.md': readFileSync(join(SKILL_ROOT, '.github', 'ISSUE_TEMPLATE', 'feature_request.md'), 'utf8'),
    })
    try {
      const emptyBug = hydrateIssueBody(dir, 'bug', { title: 'Bug 标题', summary: '实际报错现象' })
      if (/^1\.\s*$/m.test(emptyBug) || /^##\s+(?:怎么复现|补充信息)\s*$/m.test(emptyBug)) {
        return `issue-template-hydrate 空字段仍残留裸序号或空标题：\n${emptyBug}`
      }
      const fullBug = hydrateIssueBody(dir, 'bug', {
        title: 'Bug 标题',
        summary: '实际报错现象',
        repro: '1. 运行 node a.mjs\n2. 观察退出码',
        extra: '已验证 node 20',
      })
      if (!fullBug.includes('## 怎么复现') || !fullBug.includes('运行 node a.mjs') || !fullBug.includes('已验证 node 20')) {
        return `issue-template-hydrate 非空 repro/extra 未正确填充：\n${fullBug}`
      }
      const featTpl = readFileSync(join(SKILL_ROOT, '.github', 'ISSUE_TEMPLATE', 'feature_request.md'), 'utf8')
      if (!featTpl.includes('`kit/`')) return '.github/ISSUE_TEMPLATE/feature_request.md 高风险清单缺少 kit/'
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C4/C5：templates 与 references/10 份及 8 技能 SKILL.md 参数与 Tier 正序同构对齐（正反双向）', async () => {
    const collab = readFileSync(join(SKILL_ROOT, 'references', 'collaboration.md'), 'utf8')
    if (collab.includes('退出码 2') && !collab.includes('退出码 3')) {
      return 'references/collaboration.md 阻塞退出码仍写为 2'
    }
    const surveyRef = readFileSync(join(SKILL_ROOT, 'references', 'survey.md'), 'utf8')
    if (!surveyRef.includes('13') || !surveyRef.includes('docs/feature-map.json')) {
      return 'references/survey.md 未同步 13 项产物与 docs/feature-map.json'
    }
    const govSkill = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'dev-govern', 'SKILL.md'), 'utf8')
    const iterSkill = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'dev-iterate', 'SKILL.md'), 'utf8')
    const tddDoc = readFileSync(join(SKILL_ROOT, 'docs', 'TDD.md'), 'utf8')
    if (/Tier\s*1[^。\n]*可回退|Tier\s*2[^。\n]*结构/i.test(govSkill + iterSkill + tddDoc)) {
      return 'dev-govern / dev-iterate / docs/TDD.md 的 Tier 1/2 语义仍写反'
    }
    if (/静态门禁[^。\n]{0,20}Tier\s*1|共享边界原语[^。\n]{0,20}Tier\s*2/.test(govSkill + iterSkill + tddDoc)) {
      return 'dev-govern / dev-iterate / docs/TDD.md 仍把静态门禁写为 Tier 1、共享原语写为 Tier 2'
    }
    const flowHelp = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['--help'], { cwd: SKILL_ROOT })
    if (flowHelp.status !== 0 || !flowHelp.stdout.includes('accept|reject|merge-duplicate|needs-info|defer')) {
      return 'flow.mjs --help intake --decision 枚举未对齐 INTAKE_DECISIONS'
    }
    return true
  }])
}
