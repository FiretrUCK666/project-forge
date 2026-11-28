/**
 * fixtures-multi-platform.mjs —— Milestone C 多托管平台离线 Mock Forge + bare 仓 E2E 矩阵、
 * 仓外实证附件生命周期、PR #215 planBootstrap 与 Issue #219 1:N 勾选框回归双向断言。
 *
 * 严格零第三方依赖（仅 Node 18+ `node:http` / `node:fs` / `node:path`），零私域域名/账号/令牌硬编码。
 * 自动被 `scripts/dev/fixtures.mjs` 发现（域 `multi-platform`）。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { formatArtifactEvidenceLines, stageAndSyncTaskArtifacts } from '../../kit/skills/lib/empirical-artifacts.mjs'
import { canonicalPath, gitRun, posixPath } from '../../kit/skills/lib/git.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { createDefaultLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { collectMasterIssueCriteriaState, filterBootstrapAutoAttachDocs, renderCriteriaProgressTable, resolveBootstrapStartDocs, resolvePrimaryPlanDocOrder } from '../../kit/skills/lib/master-criteria-sync.mjs'
import { syncIssueCriteriaCheckboxes } from '../../kit/skills/lib/plan-sync.mjs'
import { createProviderClient, parseRemotesTopology, probePlatformEnv, probePlatformEnvCore, resolveGitLabMrHeadSha, resolveRemoteTarget, resolveWorkspaceIdentity } from '../../kit/skills/lib/platform.mjs'
import { hydratePrTemplateBody, resolveReadablePrTitle } from '../../kit/skills/lib/pr-template-hydrate.mjs'
import { createTaskBackend } from '../../kit/skills/lib/task-backend.mjs'
import { destroyTaskArtifactsDir, isSafeTaskArtifactPath, resolveFlowArtifactsRoot, resolveTaskArtifactsDir, stageTaskArtifact } from '../../kit/skills/lib/verify-state.mjs'
import { handleAbort, handleCleanup } from '../../kit/skills/dev-flow/scripts/flow-cleanup.mjs'
import { buildTargetRepoContext, findMatchingDocStrict } from '../../kit/skills/dev-flow/scripts/flow-context.mjs'
import { inspectWorkspace } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleMilestone } from '../../kit/skills/dev-flow/scripts/flow-issues.mjs'
import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { parseAcceptanceCriteria } from '../../kit/skills/dev-review/scripts/review-gates.mjs'
import { gitInit, rmTree, tmpProject } from './fixtures-helpers.mjs'
import { alignCloneUrlScheme, buildHttpsAuthGitArgs, cloneAndPrepareRepo, runLiveForgeE2e } from './live-forge-e2e.mjs'

async function startMockForgeServer(handler) {
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const rawBuf = Buffer.concat(chunks)
      const rawText = rawBuf.toString('utf8')
      let json = null
      try { json = rawText ? JSON.parse(rawText) : null } catch { json = null }
      Promise.resolve(handler({ req, res, rawBuf, rawText, json })).catch((err) => {
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ message: String(err?.message ?? err) }))
      })
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const baseUrl = `http://127.0.0.1:${addr.port}`
  return {
    baseUrl,
    port: addr.port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let stdout = ''
  let stderr = ''
  process.stdout.write = (chunk) => { stdout += String(chunk); return true }
  process.stderr.write = (chunk) => { stderr += String(chunk); return true }
  try {
    const res = await fn()
    return { res, stdout, stderr }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

async function makeBareWithClone(files = {}) {
  const bareDir = canonicalPath(mkdtempSync(join(tmpdir(), 'pf-mp-bare-')))
  const workDir = canonicalPath(tmpProject({ 'README.md': '# multi-forge\n', ...files }))
  await gitRun(bareDir, ['init', '--bare', '-b', 'main'])
  gitInit(workDir, { initialCommit: true })
  await gitRun(workDir, ['remote', 'add', 'origin', bareDir])
  await gitRun(workDir, ['push', '-u', 'origin', 'HEAD:main'])
  const headRes = await gitRun(workDir, ['rev-parse', 'HEAD'])
  const gitDirRes = await gitRun(workDir, ['rev-parse', '--git-common-dir'])
  const gitCommonDir = canonicalPath(join(workDir, gitDirRes.stdout.trim()))
  return {
    bareDir,
    workDir,
    gitCommonDir,
    headSha: headRes.stdout.trim(),
    cleanup: () => { rmTree(workDir); rmTree(bareDir) },
  }
}

export function registerMultiPlatformCases(cases) {
  cases.push(['C11/C13：GitLab v4 Mock Forge + bare 仓实证上传缓存防重传、refs/merge-requests 真 SHA 与 .gitlab MR 模板 5 列表水合', async () => {
    const repo = await makeBareWithClone({
      '.gitlab/merge_request_templates/Default.md': [
        '## 变更摘要',
        '',
        '## 关联工单与文档',
        '',
        '## 验证证据',
        '',
        '## 风险与回滚',
        '',
      ].join('\n'),
      'docs/specs/261128-issue5-demo-spec.md': [
        '---',
        'kind: spec',
        'status: approved',
        'issue: 5',
        '---',
        '# 多平台实证上传演示',
        '',
        '## 目标',
        '- 验证 GitLab 附件上传与 5 列表单源输出。',
        '',
        '## 验收标准',
        '- [x] C1: 支持 GitLab /uploads 上传并写入 evidence.json 缓存',
        '- [ ] C2: 支持 PR 模板渲染同源验收进度表',
      ].join('\n'),
    })
    let uploadCalls = 0
    const staleRestSha = '000000000000000000000000000000000000dead'
    const mock = await startMockForgeServer(({ req, res, rawBuf }) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && url.pathname.endsWith('/uploads')) {
        uploadCalls += 1
        const ct = String(req.headers['content-type'] ?? '')
        if (!ct.includes('multipart/form-data') || !rawBuf.includes(Buffer.from('PNG_TEST_BYTES'))) {
          res.statusCode = 400
          res.end(JSON.stringify({ message: 'bad multipart upload' }))
          return
        }
        res.statusCode = 201
        res.end(JSON.stringify({
          alt: 'shot.png',
          url: '/uploads/a1b2c3/shot.png',
          full_path: '/group/demo/uploads/a1b2c3/shot.png',
          markdown: '![shot.png](/uploads/a1b2c3/shot.png)',
        }))
        return
      }
      if (req.method === 'GET' && /\/merge_requests\/1$/.test(url.pathname)) {
        res.statusCode = 200
        res.end(JSON.stringify({
          iid: 1,
          title: 'feat: demo',
          state: 'opened',
          sha: staleRestSha,
          source_branch: 'feat/demo',
          target_branch: 'main',
          diff_refs: { base_sha: repo.headSha, head_sha: staleRestSha },
          web_url: 'http://127.0.0.1/group/demo/-/merge_requests/1',
        }))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
    })

    try {
      // 在 bare 仓写入真实 GitLab MR ref（refs/merge-requests/1/head -> 真实 HEAD）
      await gitRun(repo.workDir, ['push', 'origin', `${repo.headSha}:refs/merge-requests/1/head`])
      const shaResolved = await resolveGitLabMrHeadSha({
        repoRoot: repo.workDir,
        remoteName: 'origin',
        iid: 1,
        fallbackSha: staleRestSha,
      })
      if (shaResolved.headRefOid !== repo.headSha || shaResolved.shaSource !== 'git-ls-remote') {
        return `GitLab MR 真 SHA 未优先从 refs/merge-requests/1/head 解析：${JSON.stringify(shaResolved)}`
      }

      const client = createProviderClient({
        providerId: 'gitlab',
        apiBaseUrl: `${mock.baseUrl}/api/v4`,
        repoSlug: 'group/demo',
        token: 'mock-gitlab-token',
        remoteName: 'origin',
        repoRoot: repo.workDir,
      })
      const backend = createTaskBackend({
        role: 'maintainer',
        providerId: 'gitlab',
        targetRepo: 'group/demo',
        client,
        mainRoot: repo.workDir,
        gitDir: repo.gitCommonDir,
      })
      if (backend.capabilities.uploadAttachment !== true) {
        return `GitLab 后端 capabilities.uploadAttachment 应为 true：${JSON.stringify(backend.capabilities)}`
      }

      const extArtifact = join(tmpdir(), `pf-mp-shot-${Date.now()}.png`)
      writeFileSync(extArtifact, Buffer.from('PNG_TEST_BYTES_0123456789'))
      const evidencePath = join(repo.gitCommonDir, 'project-forge-flow', 'tasks', 'mp-gl-1', 'evidence.json')
      mkdirSync(join(repo.gitCommonDir, 'project-forge-flow', 'tasks', 'mp-gl-1'), { recursive: true })
      writeFileSync(evidencePath, JSON.stringify({ taskId: 'mp-gl-1', headSha: repo.headSha, artifacts: [] }, null, 2))

      try {
        const first = await stageAndSyncTaskArtifacts({
          repoRoot: repo.workDir,
          gitCommonDir: repo.gitCommonDir,
          mainRoot: repo.workDir,
          taskId: 'mp-gl-1',
          evidencePath,
          artifacts: [extArtifact],
          backend,
          targetRepo: 'group/demo',
          observationSummary: '浅深色页面渲染正常无溢出',
        })
        if (uploadCalls !== 1 || first.uploadedCount !== 1) {
          return `首次上传计数异常：uploadCalls=${uploadCalls}, res=${JSON.stringify(first)}`
        }
        const savedEv = JSON.parse(readFileSync(evidencePath, 'utf8'))
        const stagedPath = savedEv.artifacts?.[0]?.stagedPath
        if (!stagedPath || !existsSync(stagedPath)) return `附件未暂存至仓外目录：${stagedPath}`
        const stRes = await gitRun(repo.workDir, ['status', '--porcelain'])
        if (stRes.stdout.trim() !== '') return `暂存实证附件污染了 Git 工作区：${stRes.stdout}`

        // 第二次提交命中 evidence.json 缓存，绝不重传
        const second = await stageAndSyncTaskArtifacts({
          repoRoot: repo.workDir,
          gitCommonDir: repo.gitCommonDir,
          mainRoot: repo.workDir,
          taskId: 'mp-gl-1',
          evidencePath,
          records: savedEv.artifacts,
          backend,
          targetRepo: 'group/demo',
        })
        if (uploadCalls !== 1 || second.cachedCount !== 1) {
          return `第二次同步未命中上传缓存（重复上传）：uploadCalls=${uploadCalls}, res=${JSON.stringify(second)}`
        }

        // .gitlab/merge_request_templates/Default.md 水合含验收进度表 + 5 列实证附件表 + 内嵌图
        const body = hydratePrTemplateBody({
          repoRoot: repo.workDir,
          taskId: 'mp-gl-1',
          ledger: {
            taskId: 'mp-gl-1',
            caseType: 4,
            branch: 'feat/demo',
            baseBranch: 'main',
            specFile: 'docs/specs/261128-issue5-demo-spec.md',
            linkedIssues: [5],
            verifiedCmd: 'node scripts/dev/preflight.mjs',
          },
          policy: { riskTier: 'medium', requiredGates: ['full'], smokeRequired: false, visualFilesChanged: [] },
          evidence: savedEv,
          currentHead: repo.headSha,
          changedFiles: ['docs/specs/261128-issue5-demo-spec.md'],
        })
        if (!body.includes('| 条款 | 状态 | 说明 |') || !body.includes('C1')) {
          return `MR 正文缺少同源验收清单进度表：\n${body}`
        }
        if (!body.includes('| 实证附件 | 字节数 | 校验指纹 | 实证观察摘要 | 附件展示 |')) {
          return `MR 正文缺少 5 列实证附件表：\n${body}`
        }
        if (!body.includes('![shot.png](/uploads/a1b2c3/shot.png)')) {
          return `MR 正文未内嵌 GitLab 上传 Markdown 图片：\n${body}`
        }
      } finally {
        rmTree(extArtifact)
      }
      return true
    } finally {
      await mock.close()
      repo.cleanup()
    }
  }])

  cases.push(['C10/C13：GitCode 4 字节字符写前净化守卫（防 MySQL 500）与脏 MR 列表客户端分支过滤', async () => {
    const SURROGATE_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]/
    let seenBody = ''
    const mock = await startMockForgeServer(({ req, res, rawText, json }) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && url.pathname.endsWith('/issues')) {
        if (SURROGATE_RE.test(rawText)) {
          res.statusCode = 500
          res.end(JSON.stringify({ message: 'Incorrect string value utf8mb3' }))
          return
        }
        seenBody = String(json?.description ?? json?.body ?? '')
        res.statusCode = 201
        res.end(JSON.stringify({ iid: 7, title: json?.title, state: 'opened', web_url: 'https://gitcode.com/o/r/-/issues/7' }))
        return
      }
      if (req.method === 'GET' && url.pathname.endsWith('/merge_requests')) {
        // 刻意返回未过滤的脏列表（含其他分支 MR）
        res.statusCode = 200
        res.end(JSON.stringify([
          { iid: 11, title: 'wrong branch', state: 'opened', source_branch: 'feat/unrelated', target_branch: 'main' },
          { iid: 12, title: 'right branch', state: 'opened', source_branch: 'feat/target-branch', target_branch: 'main' },
        ]))
        return
      }
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
    })
    try {
      const client = createProviderClient({
        providerId: 'gitcode',
        apiBaseUrl: `${mock.baseUrl}/api/v5`,
        repoSlug: 'o/r',
        token: 'mock-gc-token',
      })
      const fourByteChar = String.fromCodePoint(0x1F680)
      const created = await client.createIssue({
        repo: 'o/r',
        title: `fix: guard ${fourByteChar} title`,
        body: `detail with ${fourByteChar} payload`,
      })
      if (!created.ok || created.number !== 7) {
        return `GitCode 4 字节写前净化失败：${JSON.stringify(created)}`
      }
      if (SURROGATE_RE.test(seenBody)) return `4 字节代理对仍穿透到服务端：${seenBody}`

      const prs = await client.findOpenPrForBranch('o/r', 'feat/target-branch', { base: 'main' })
      if (!prs.ok || prs.prs?.length !== 1 || prs.prs[0].number !== 12) {
        return `GitCode 客户端分支过滤未筛除脏 MR：${JSON.stringify(prs)}`
      }
      return true
    } finally {
      await mock.close()
    }
  }])

  cases.push(['C11/C13：Gitee 与 Gitea 能力降级（uploadAttachment=false 不询问图床输出 5 列摘要，Gitee checks=false 跳过）', async () => {
    const dir = tmpProject({ 'shots/ui.png': 'FAKE_PNG_DATA_12345' })
    const gitCommonDir = join(dir, '.git')
    mkdirSync(gitCommonDir, { recursive: true })
    try {
      for (const pid of ['gitee', 'gitea']) {
        const client = createProviderClient({
          providerId: pid,
          apiBaseUrl: 'http://127.0.0.1:9/api/v1',
          repoSlug: 'team/app',
          token: 'mock-tok',
        })
        const backend = createTaskBackend({
          role: 'maintainer',
          providerId: pid,
          targetRepo: 'team/app',
          client,
          mainRoot: dir,
          gitDir: gitCommonDir,
        })
        if (backend.capabilities.uploadAttachment !== false) {
          return `${pid} uploadAttachment 应为 false`
        }
        const synced = await stageAndSyncTaskArtifacts({
          repoRoot: dir,
          gitCommonDir,
          mainRoot: dir,
          taskId: `fallback-${pid}`,
          artifacts: ['shots/ui.png'],
          backend,
          targetRepo: 'team/app',
          observationSummary: '表格与按钮对比度正常',
        })
        if (!synced.ok || synced.skippedUpload !== true || synced.uploadedCount !== 0) {
          return `${pid} 不应触发远程上传：${JSON.stringify(synced)}`
        }
        const table = formatArtifactEvidenceLines({ records: synced.records }).join('\n')
        if (!table.includes('| 实证附件 | 字节数 | 校验指纹 | 实证观察摘要 | 附件展示 |')) {
          return `${pid} 降级后未渲染 5 列实证表：\n${table}`
        }
        if (!table.includes('仅本地元数据')) {
          return `${pid} 降级展示列应标明仅本地元数据：\n${table}`
        }
        if (pid === 'gitee') {
          const chk = await backend.getCommitChecks({ repo: 'team/app', ref: 'abcdef1' })
          if (!chk.ok || chk.skipped !== true) {
            return `Gitee checks=false 应优雅跳过而非报错：${JSON.stringify(chk)}`
          }
        }
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C10/C13：LAN IP 自建实例识别（isLan=true）与 generic-git 离线四态核验降级', async () => {
    const lanTarget = resolveRemoteTarget(
      { origin: 'http://127.0.0.1:8088/infra/service.git' },
      { providerHint: 'gitlab' },
    )
    if (lanTarget.providerId !== 'gitlab' || lanTarget.isLan !== true || lanTarget.repoSlug !== 'infra/service') {
      return `LAN IP 自建 GitLab 识别异常：${JSON.stringify(lanTarget)}`
    }
    const genericTarget = resolveRemoteTarget({ origin: 'https://git.internal.invalid/team/repo.git' })
    if (genericTarget.providerId !== 'generic-git' || genericTarget.capabilities.api !== false) {
      return `未知自建托管应降级 generic-git：${JSON.stringify(genericTarget)}`
    }
    return true
  }])

  cases.push(['C12 回归（PR #215）：planBootstrap 阻断两处自动挂子切片 SPEC/Todo 且四入口以 prdFile 为主源', async () => {
    const dir = tmpProject({
      'docs/prd/261128-issue99-master-prd.md': [
        '---',
        'kind: prd',
        'status: draft',
        'issue: 99',
        '---',
        '# 总控主方案规划标题',
        '',
        '## 目标',
        '- 统一主规划与多波切片边界。',
        '',
        '## 验收标准',
        '- [ ] C1: 主 PRD 验收项一',
        '- [ ] C2: 主 PRD 验收项二',
      ].join('\n'),
      'docs/specs/261128-issue99-child-a-spec.md': [
        '---',
        'kind: spec',
        'status: draft',
        'issue: 99',
        '---',
        '# 子切片 A 错误标题',
        '',
        '## 验收标准',
        '- [ ] C1: 子切片 A 条款',
      ].join('\n'),
      'docs/todo/261128-issue99-child-a-todo.md': [
        '---',
        'kind: todo',
        'status: draft',
        'issue: 99',
        '---',
        '# 子切片 A Todo',
        '',
        '## 任务清单',
        '- [ ] C1: 子切片 Todo 条款',
      ].join('\n'),
    })
    try {
      const rawDocs = [
        'docs/prd/261128-issue99-master-prd.md',
        'docs/specs/261128-issue99-child-a-spec.md',
        'docs/todo/261128-issue99-child-a-todo.md',
      ]
      // 1. 正向：isBootstrap=true 且未显式传 --spec/--todo 时，过滤只剩 prd
      const filtered = filterBootstrapAutoAttachDocs(rawDocs, { isBootstrap: true })
      if (filtered.length !== 1 || !filtered[0].startsWith('docs/prd/')) {
        return `filterBootstrapAutoAttachDocs 未阻断子切片自动挂载：${JSON.stringify(filtered)}`
      }
      const resolved = resolveBootstrapStartDocs({
        root: dir, slug: 'master-plan', taskId: 'issue-99', linkedIssues: [99],
        extraDocs: rawDocs, isBootstrap: true, findStrict: findMatchingDocStrict,
      })
      if (!resolved.prdFile || resolved.specFile !== null || resolved.todoFile !== null) {
        return `resolveBootstrapStartDocs 在 planBootstrap 误挂子切片：${JSON.stringify(resolved)}`
      }
      // 2. 反向：常规切片（isBootstrap=false）正常挂载 SPEC/Todo
      const normalOrder = resolvePrimaryPlanDocOrder({ planBootstrap: false })
      const bootOrder = resolvePrimaryPlanDocOrder({ planBootstrap: true })
      if (normalOrder[0] !== 'spec' || bootOrder[0] !== 'prd') {
        return `resolvePrimaryPlanDocOrder 顺序异常：normal=${normalOrder}, boot=${bootOrder}`
      }
      // 3. 四入口以 prdFile 为主源（即使账本里遗留了 specFile）
      const bootLedger = {
        taskId: 'plan-boot',
        slug: 'plan-boot',
        planBootstrap: true,
        prdFile: 'docs/prd/261128-issue99-master-prd.md',
        specFile: 'docs/specs/261128-issue99-child-a-spec.md',
        todoFile: 'docs/todo/261128-issue99-child-a-todo.md',
        branch: 'docs/plan-boot',
        baseBranch: 'main',
      }
      const prTitle = resolveReadablePrTitle(dir, bootLedger)
      if (!prTitle.includes('总控主方案规划标题') || prTitle.includes('子切片 A')) {
        return `resolveReadablePrTitle 未优先使用 prdFile：${prTitle}`
      }
      const prBody = hydratePrTemplateBody({
        repoRoot: dir, taskId: 'plan-boot', ledger: bootLedger,
        policy: { riskTier: 'low', requiredGates: [] }, currentHead: 'abcdef1234567',
      })
      if (!prBody.includes('主 PRD 验收项一') || prBody.includes('子切片 A 条款')) {
        return `hydratePrTemplateBody 未优先使用 prdFile：\n${prBody}`
      }
      const reviewCrit = parseAcceptanceCriteria(dir, dir, bootLedger)
      if (reviewCrit.length !== 2 || !reviewCrit[0].text.includes('主 PRD 验收项一')) {
        return `parseAcceptanceCriteria 未优先使用 prdFile：${JSON.stringify(reviewCrit)}`
      }
      const handoff = buildHandoff({ mainRoot: dir, ledger: bootLedger, headSha: 'abcdef1234567' })
      if (handoff.fields.sourceDoc !== bootLedger.prdFile || !handoff.prompt.includes('主 PRD 验收项一')) {
        return `buildHandoff 未优先使用 prdFile：sourceDoc=${handoff.fields.sourceDoc}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C12 回归（Issue #219）：1:N plan-backfill 聚合已归档切片且默认 includeSelf=false 不误勾未完成切片，preserveChecked 受控', async () => {
    const dir = tmpProject({
      'docs/prd/261128-issue219-master-prd.md': [
        '---',
        'kind: prd',
        'status: approved',
        'issue: 219',
        'multi_spec: true',
        '---',
        '# 1:N 总控需求',
        '',
        '## 验收标准',
        '- [ ] C1: 切片一能力 A',
        '- [ ] C2: 切片一能力 B',
        '- [ ] C3: 切片二能力 C',
        '- [ ] C4: 切片二能力 D',
      ].join('\n'),
      'docs/archive/specs/261128-issue219-slice1-spec.md': [
        '---',
        'kind: spec',
        'status: implemented',
        'issue: 219',
        'task_id: slice1',
        'related_prd: ../../prd/261128-issue219-master-prd.md',
        '---',
        '# 切片一',
        '',
        '## 验收标准',
        '- [x] C1: 切片一能力 A',
        '- [x] C2: 切片一能力 B',
      ].join('\n'),
      'docs/specs/261128-issue219-slice2-spec.md': [
        '---',
        'kind: spec',
        'status: approved',
        'issue: 219',
        'task_id: slice2',
        'related_prd: ../prd/261128-issue219-master-prd.md',
        '---',
        '# 切片二（进行中）',
        '',
        '## 验收标准',
        '- [ ] C3: 切片二能力 C',
        '- [ ] C4: 切片二能力 D',
      ].join('\n'),
    })
    try {
      const slice2Ledger = {
        taskId: 'slice2',
        specFile: 'docs/specs/261128-issue219-slice2-spec.md',
        prdFile: 'docs/prd/261128-issue219-master-prd.md',
      }
      // 非终态默认 includeSelf=false：C1/C2 勾选，C3/C4 绝不被误勾
      const nonTerminal = collectMasterIssueCriteriaState({
        mainRoot: dir,
        implRoot: dir,
        masterPrdRel: 'docs/prd/261128-issue219-master-prd.md',
        ledger: slice2Ledger,
        taskId: 'slice2',
      })
      const byId = Object.fromEntries(nonTerminal.map((c) => [c.id, c.checked]))
      if (!byId.C1 || !byId.C2 || byId.C3 !== false || byId.C4 !== false) {
        return `非终态聚合状态异常（应仅 C1/C2 勾选）：${JSON.stringify(byId)}`
      }
      // 终态显式传 includeSelf=true：C1..C4 全勾
      const terminal = collectMasterIssueCriteriaState({
        mainRoot: dir,
        implRoot: dir,
        masterPrdRel: 'docs/prd/261128-issue219-master-prd.md',
        ledger: slice2Ledger,
        taskId: 'slice2',
        includeSelf: true,
      })
      if (!terminal.every((c) => c.checked === true)) {
        return `终态 includeSelf=true 应全部勾选：${JSON.stringify(terminal)}`
      }
      // syncIssueCriteriaCheckboxes：默认 preserveChecked=false 允许显式回退，传 true 则保留历史 [x]
      const issueBody = '## 验收标准\n- [x] C1: 切片一能力 A\n- [x] C2: 切片一能力 B\n- [ ] C3: 切片二能力 C\n'
      const kept = syncIssueCriteriaCheckboxes(issueBody, { criteria: [{ id: 'C1', checked: true }, { id: 'C2', checked: false }], preserveChecked: true })
      if (!kept.body.includes('- [x] C2:')) return `preserveChecked=true 时误回退了已勾选项：\n${kept.body}`
      const explicitUncheck = syncIssueCriteriaCheckboxes(issueBody, { criteria: [{ id: 'C1', checked: true }, { id: 'C2', checked: false }] })
      if (!explicitUncheck.body.includes('- [ ] C2:')) return `默认 preserveChecked=false 时未允许显式取消勾选：\n${explicitUncheck.body}`
      const progressTbl = renderCriteriaProgressTable(nonTerminal)
      if (!progressTbl.block.includes('| 条款 | 状态 | 说明 |') || !progressTbl.summaryLine.includes('2/4 已完成')) {
        return `renderCriteriaProgressTable 输出异常：${JSON.stringify(progressTbl)}`
      }
      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['C11/C13：仓外 artifacts/<taskId>/ 路径遍历守卫与 flow cleanup / flow abort 联动销毁', async () => {
    const repo = await makeBareWithClone({ 'shot.png': 'IMG_BYTES_987654321' })
    try {
      const taskA = 'art-clean-a'
      const taskB = 'art-abort-b'
      const taskKeep = 'art-keep-c'
      const artRoot = resolveFlowArtifactsRoot(repo.gitCommonDir, repo.workDir)
      const dirA = resolveTaskArtifactsDir(repo.gitCommonDir, taskA, repo.workDir)
      if (isSafeTaskArtifactPath(artRoot, repo.gitCommonDir, taskA, repo.workDir)) {
        return 'isSafeTaskArtifactPath 误放行了 artifacts 根目录'
      }
      if (isSafeTaskArtifactPath(join(dirA, '..', 'escape'), repo.gitCommonDir, taskA, repo.workDir)) {
        return 'isSafeTaskArtifactPath 误放行了 ../escape 越界路径'
      }
      if (!isSafeTaskArtifactPath(dirA, repo.gitCommonDir, taskA, repo.workDir)) {
        return `isSafeTaskArtifactPath 误拒合法任务目录：${dirA}`
      }

      const stA = stageTaskArtifact(repo.gitCommonDir, taskA, join(repo.workDir, 'shot.png'), repo.workDir)
      const stB = stageTaskArtifact(repo.gitCommonDir, taskB, join(repo.workDir, 'shot.png'), repo.workDir)
      const stKeep = stageTaskArtifact(repo.gitCommonDir, taskKeep, join(repo.workDir, 'shot.png'), repo.workDir)
      if (!stA.ok || !stB.ok || !stKeep.ok) return 'stageTaskArtifact 失败'
      if (!existsSync(stA.stagedPath) || !existsSync(stB.stagedPath)) return '暂存文件未落盘'

      // 1. 验证 handleCleanup 销毁 taskA 的 artifacts/<taskA>/ 且不影响 taskKeep
      const ledgerA = createDefaultLedger({
        taskId: taskA, slug: taskA, caseType: 2, tier: 1, isolation: 'branch', role: 'local-only', providerId: 'none',
        branch: null, baseBranch: 'main', baseSha: repo.headSha, status: 'merged',
      })
      writeTaskLedger(repo.workDir, ledgerA)
      const roots = { isGit: true, mainRoot: repo.workDir, workTreeRoot: repo.workDir, gitDir: repo.gitCommonDir, isWorktree: false }
      const previewOut = await withQuietIo(() => handleCleanup({ task: taskA, json: true }, roots))
      const previewHash = JSON.parse(previewOut.stdout).previewHash
      await withQuietIo(() => handleCleanup({ task: taskA, confirm: true, 'preview-hash': previewHash, json: true }, roots))
      if (existsSync(resolveTaskArtifactsDir(repo.gitCommonDir, taskA, repo.workDir))) {
        return 'flow cleanup 未销毁仓外 artifacts/<taskA>/'
      }
      if (!existsSync(stKeep.stagedPath)) return 'flow cleanup 误删了兄弟任务 artifacts'

      // 2. 验证 handleAbort 销毁 taskB 的 artifacts/<taskB>/
      const ledgerB = createDefaultLedger({
        taskId: taskB, slug: taskB, caseType: 2, tier: 1, isolation: 'branch', role: 'local-only', providerId: 'none',
        branch: null, baseBranch: 'main', baseSha: repo.headSha, status: 'started',
      })
      writeTaskLedger(repo.workDir, ledgerB)
      await withQuietIo(() => handleAbort({ task: taskB, confirm: true, json: true }, roots))
      if (existsSync(resolveTaskArtifactsDir(repo.gitCommonDir, taskB, repo.workDir))) {
        return 'flow abort 未销毁仓外 artifacts/<taskB>/'
      }
      if (!existsSync(stKeep.stagedPath)) return 'flow abort 误删了兄弟任务 artifacts'

      // 3. 验证 destroyTaskArtifactsDir 幂等
      const again = destroyTaskArtifactsDir({ gitCommonDir: repo.gitCommonDir, mainRoot: repo.workDir, taskId: taskB })
      if (again.destroyed !== false || again.fileCount !== 0) {
        return `重复销毁应幂等返回 destroyed=false：${JSON.stringify(again)}`
      }
      return true
    } finally {
      repo.cleanup()
    }
  }])

  cases.push(['C13：opt-in live-forge-e2e 缺失环境变量退出 2、--dry-run 强制一次性私仓前缀且零硬编码凭据', async () => {
    const missing = await withQuietIo(() => runLiveForgeE2e([], {}))
    if (missing.res !== 2) return `缺少环境变量应返回退出码 2，收到：${missing.res}`
    const dry = await withQuietIo(() => runLiveForgeE2e(['--dry-run'], {
      PF_LIVE_FORGE_PROVIDER: 'gitlab',
      PF_LIVE_FORGE_URL: 'https://forge.example.invalid',
      PF_LIVE_FORGE_TOKEN: 'dummy-ephemeral-token',
    }))
    if (dry.res !== 0) return `--dry-run 应返回 0，收到：${dry.res}`
    const parsed = JSON.parse(dry.stdout)
    if (!parsed.ok || !String(parsed.repoName ?? '').startsWith('pf-e2e-disposable-')) {
      return `临时私仓命名未强制一次性前缀：${dry.stdout}`
    }
    if (dry.stdout.includes('dummy-ephemeral-token')) return '输出泄露了令牌原文'
    if (alignCloneUrlScheme('http://forge.example.invalid/g/r.git', 'https://forge.example.invalid') !== 'https://forge.example.invalid/g/r.git') {
      return 'alignCloneUrlScheme 未将 http 升级为 https'
    }
    if (alignCloneUrlScheme('http://127.0.0.1:8080/g/r.git', 'http://127.0.0.1:8080') !== 'http://127.0.0.1:8080/g/r.git') {
      return 'alignCloneUrlScheme 误改写 http forge 的 cloneUrl'
    }
    const authArgs = buildHttpsAuthGitArgs('gitlab', 'secret-tok-xyz')
    if (authArgs.length !== 2 || authArgs[1].includes('secret-tok-xyz') || !authArgs[1].startsWith('http.extraHeader=Authorization: Basic ')) {
      return `buildHttpsAuthGitArgs 格式或脱敏异常：${JSON.stringify(authArgs)}`
    }
    const emptyBare = canonicalPath(mkdtempSync(join(tmpdir(), 'pf-e2e-empty-bare-')))
    const workTmp = canonicalPath(mkdtempSync(join(tmpdir(), 'pf-e2e-work-')))
    try {
      await gitRun(emptyBare, ['init', '--bare', '-b', 'main'])
      const prep = await cloneAndPrepareRepo({
        workDir: workTmp, created: { sshUrl: 'ssh://invalid-unreachable.invalid:1/none.git', cloneUrl: emptyBare, defaultBranch: 'main' },
        providerId: 'gitlab', forgeUrl: 'https://forge.example.invalid', token: 'tok-1', repoName: 'empty-seed',
        gitRunner: async (cwd, args, o) => (args.includes('ssh://invalid-unreachable.invalid:1/none.git') ? { ok: false, stderr: 'ssh refused' } : gitRun(cwd, args, o)),
      })
      if (prep.usedTransport !== 'https' || !prep.seededEmptyRepo || prep.baseBranch !== 'main') return `cloneAndPrepareRepo 异常：${JSON.stringify(prep)}`
    } finally { rmTree(emptyBare); rmTree(workTmp) }
    return true
  }])

  cases.push(['Issue #235 C1/C2：SSH 端口透传 -p、AGENTS.md 自动读取 platform-provider/api-base 与 inspect 拓扑透传', async () => {
    const seenSshArgs = []
    const sshCore = await probePlatformEnvCore({
      providerId: 'gitlab', remoteUrls: { origin: 'ssh://git@gitlab.example.com:10022/grp/sub/app.git' },
      host: 'gitlab.example.com', apiBaseUrl: 'https://gitlab.example.com/api/v4', repoSlug: 'grp/sub/app', probeNetwork: true,
      runner: async (cmd, args) => (cmd === 'ssh' ? (seenSshArgs.push(args), { code: 0, stdout: 'Welcome to GitLab, @alice!', stderr: '' }) : { code: 1, stdout: '', stderr: '' }),
    })
    if (!seenSshArgs[0]?.includes('-p') || !seenSshArgs[0]?.includes('10022') || sshCore.ssh.port !== 10022 || !sshCore.sshWorks) {
      return `C1 SSH 自定义端口未透传：args=${JSON.stringify(seenSshArgs)}, ssh=${JSON.stringify(sshCore.ssh)}`
    }
    const dirWithAgents = tmpProject({ 'README.md': '# gl\n', 'AGENTS.md': '# Contract\n- `platform-provider`: `gitlab`\n- `platform-api-base`: `https://git.custom.example/api/v4`\n' })
    const dirPlain = tmpProject({ 'README.md': '# plain\n' })
    try {
      const sshRemote = 'ssh://git@git.custom.example:10022/grp/sub/app.git'
      gitInit(dirWithAgents, { branch: 'main', name: 'alice', email: 'alice@example.com', origin: sshRemote })
      const tAuto = resolveRemoteTarget({ origin: sshRemote }, { cwd: dirWithAgents, sshHostMap: false })
      const tPlain = resolveRemoteTarget({ origin: sshRemote }, { cwd: dirPlain, sshHostMap: false })
      if (tAuto.providerId !== 'gitlab' || tAuto.apiBaseUrl !== 'https://git.custom.example/api/v4' || tPlain.providerId !== 'generic-git') {
        return `C2 AGENTS.md 自动读取异常：auto=${JSON.stringify(tAuto)}, plain=${JSON.stringify(tPlain)}`
      }
      const probed = await probePlatformEnv({ cwd: dirWithAgents, remoteUrls: { origin: sshRemote }, env: { GITLAB_TOKEN: 'glpat-auto-1' } })
      const idRes = resolveWorkspaceIdentity({ cwd: dirWithAgents, remoteUrls: { origin: sshRemote }, gitIdentity: { name: 'alice', email: 'alice@example.com' } })
      const topo = parseRemotesTopology(`origin\t${sshRemote} (fetch)\n`, { providerHint: 'gitlab', sshHostMap: false })
      const insp = await inspectWorkspace(dirWithAgents, { env: {} })
      const ctxStale = buildTargetRepoContext('maintainer', { origin: sshRemote }, null, null, { cwd: dirWithAgents, providerHint: 'generic-git' })
      if (probed.env.providerId !== 'gitlab' || idRes.providerId !== 'gitlab' || topo.providerId !== 'gitlab' || insp.remotesTopology?.[0]?.providerId !== 'gitlab' || insp.identity?.providerId !== 'gitlab' || ctxStale.providerId !== 'gitlab' || !ctxStale.capabilities?.milestones) {
        return `C2 拓扑/探测透传失败：${JSON.stringify({ p: probed.env.providerId, id: idRes.providerId, topo: topo.providerId, inspTopo: insp.remotesTopology?.[0]?.providerId, inspId: insp.identity?.providerId, ctxStale: ctxStale.providerId })}`
      }
      return true
    } finally { rmTree(dirWithAgents); rmTree(dirPlain) }
  }])

  cases.push(['Issue #235 C3/C4：GitLab 10.x 标签 400 回退、里程碑全局 id 与 isPr=true 零泄漏至 /issues', async () => {
    const state = { issueLabels: ['old'], mrLabels: ['in-review'], hits: [], closedMsId: null, assignedMsId: null, msTargets: [] }
    const mock = await startMockForgeServer(({ req, res, json }) => {
      const p = new URL(req.url, 'http://127.0.0.1').pathname
      state.hits.push(`${req.method} ${p}`)
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST' && p.endsWith('/milestones')) return res.end(JSON.stringify({ id: 42, iid: 1, title: json?.title, state: 'active' }))
      if (req.method === 'PUT' && p.endsWith('/milestones/42')) { state.closedMsId = 42; return res.end(JSON.stringify({ id: 42, iid: 1, state: 'closed' })) }
      if (req.method === 'GET' && p.endsWith('/labels')) return res.end(JSON.stringify([]))
      if (req.method === 'GET' && /\/(issues|merge_requests)\/\d+$/.test(p)) {
        return res.end(JSON.stringify({ iid: 5, state: 'opened', labels: p.includes('/merge_requests/') ? state.mrLabels : state.issueLabels }))
      }
      if (req.method === 'PUT' && /\/(issues|merge_requests)\/\d+$/.test(p)) {
        const isMr = p.includes('/merge_requests/')
        if ('add_labels' in (json ?? {}) || 'remove_labels' in (json ?? {})) { res.statusCode = 400; return res.end(JSON.stringify({ message: '400 10.x' })) }
        if ('labels' in (json ?? {})) {
          const next = String(json.labels).split(',').map((s) => s.trim()).filter(Boolean)
          if (isMr) state.mrLabels = next; else state.issueLabels = next
        }
        if ('milestone_id' in (json ?? {})) { state.assignedMsId = json.milestone_id; state.msTargets.push(`${isMr ? 'mr' : 'issue'}:${p.split('/').pop()}=${json.milestone_id}`) }
        return res.end(JSON.stringify({ iid: 5, labels: isMr ? state.mrLabels : state.issueLabels }))
      }
      if (p.endsWith('/notes')) return res.end(JSON.stringify(req.method === 'POST' ? { id: 9, body: json?.body } : []))
      res.statusCode = 404
      res.end(JSON.stringify({ message: 'not found' }))
    })
    const glDir = tmpProject({ 'README.md': '# gl\n', 'AGENTS.md': '# Contract\n- `platform-provider`: `gitlab`\n' })
    try {
      gitInit(glDir, { branch: 'main', name: 'alice', email: 'alice@example.com', origin: 'ssh://git@git.custom.example:10022/grp/app.git' })
      const glRoots = { isGit: true, mainRoot: glDir, workTreeRoot: glDir, gitDir: join(glDir, '.git'), isWorktree: false }
      const client = createProviderClient({ providerId: 'gitlab', apiBaseUrl: `${mock.baseUrl}/api/v4`, repoSlug: 'grp/app', token: 'gl-tok' })
      const backend = createTaskBackend({ role: 'maintainer', providerId: 'gitlab', targetRepo: 'grp/app', client, mainRoot: glDir })
      const ms = await backend.createMilestone({ title: 'v1.0' })
      const msA = await backend.assignMilestone({ number: 5, milestone: ms.number })
      const msC = await backend.closeMilestone({ number: ms.number })
      if (!ms.ok || ms.number !== 42 || ms.iid !== 1 || !msA.ok || state.assignedMsId !== 42 || !msC.ok || state.closedMsId !== 42) {
        return `C3 里程碑全局 id 失败：${JSON.stringify({ ms, msA, msC, state })}`
      }
      const addIss = await backend.addLabels({ number: 5, labels: ['added'] })
      const rmIss1 = await backend.removeLabel({ number: 5, label: 'old' })
      const rmIss2 = await backend.removeLabel({ number: 5, label: 'added' })
      if (!addIss.ok || !rmIss1.ok || !rmIss2.ok || state.issueLabels.length !== 0) {
        return `C3 10.x 标签 400 回退或清空末标签失败：${JSON.stringify({ addIss, rmIss1, rmIss2, issueLabels: state.issueLabels })}`
      }
      state.hits = []
      const prCmt = await backend.postComment({ number: 5, isPr: true, body: 'mr review' })
      const prSync = await backend.syncStateLabel({ number: 5, state: 'reviewed', isPr: true })
      const prNotes = await backend.listComments({ number: 5, isPr: true })
      const leakedIssue = state.hits.filter((h) => h.includes('/issues/'))
      const mrHits = state.hits.filter((h) => h.includes('/merge_requests/5'))
      if (!prCmt.ok || !prSync.ok || !prNotes.ok || leakedIssue.length > 0 || mrHits.length < 3 || !state.mrLabels.includes('reviewed') || state.mrLabels.includes('in-review')) {
        return `C4 isPr=true 路由泄漏至 /issues：${JSON.stringify({ prCmt, prSync, prNotes, leakedIssue, hits: state.hits, mrLabels: state.mrLabels })}`
      }
      state.hits = []; state.msTargets = []
      const cIss1 = await backend.postComment({ number: 1, isPr: false, body: 'same', statePayload: { phase: 'init' } })
      const cMr1 = await backend.postComment({ number: 1, isPr: true, body: 'same', statePayload: { phase: 'init' } })
      if (cIss1.deduplicated || cMr1.deduplicated || !state.hits.includes('POST /api/v4/projects/grp%2Fapp/issues/1/notes') || !state.hits.includes('POST /api/v4/projects/grp%2Fapp/merge_requests/1/notes')) {
        return `MF-1 同 iid=1 Issue/MR 去重冲突：${JSON.stringify({ cIss1, cMr1, hits: state.hits })}`
      }
      await withQuietIo(() => handleMilestone({ action: 'assign', milestone: '42', issue: '1', pr: '1', _ghClient: client, json: true }, glRoots))
      if (!state.msTargets.includes('issue:1=42') || !state.msTargets.includes('mr:1=42')) {
        return `MF-2a milestone assign 未分开路由 Issue/MR #1：${JSON.stringify(state.msTargets)}`
      }
      writeTaskLedger(glDir, createDefaultLedger({ taskId: 'gl-shared-iid', slug: 'gl-shared-iid', caseType: 2, tier: 1, isolation: 'branch', role: 'maintainer', providerId: 'gitlab', branch: 'main', baseBranch: 'main', linkedIssues: [1], prNumber: 1, status: 'submitted' }))
      state.hits = []
      await withQuietIo(() => handleNext({ task: 'gl-shared-iid', 'probe-auth': true, _ghClient: client, json: true }, glRoots))
      if (!state.hits.includes('GET /api/v4/projects/grp%2Fapp/merge_requests/1/notes') || !state.hits.includes('GET /api/v4/projects/grp%2Fapp/issues/1/notes')) {
        return `MF-2b flow-next 未同时拉取 Issue/MR #1 评论：${JSON.stringify(state.hits)}`
      }
      return true
    } finally { await mock.close(); rmTree(glDir) }
  }])
}
