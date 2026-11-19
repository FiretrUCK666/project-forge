/**
 * fixtures-locate-intake.mjs —— 统一装配、按需定位、全局业务分诊、状态机/基线校准、可读 PR/Issue 与功能域命名门禁双向行为断言。
 */

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { handleBatch } from '../../kit/skills/dev-flow/scripts/flow-batch.mjs'
import { handleExplore } from '../../kit/skills/dev-flow/scripts/flow-explore.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleIntake } from '../../kit/skills/dev-flow/scripts/flow-intake.mjs'
import { handleFinalize, handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { assertSubmitOwnership, checkLifecyclePreconditions, runPreVerifyEditGateHook } from '../../kit/skills/dev-flow/scripts/flow-lifecycle-hooks.mjs'
import { handleClaim } from '../../kit/skills/dev-flow/scripts/flow-merge.mjs'
import { handleNext } from '../../kit/skills/dev-flow/scripts/flow-next.mjs'
import { handleSync } from '../../kit/skills/dev-flow/scripts/flow-sync.mjs'
import { unmountSharedDeps } from '../../kit/skills/dev-flow/scripts/worktree-deps.mjs'
import { auditRepoDocs } from '../../kit/skills/dev-plan/scripts/doc-audit.mjs'
import { runCli as runReviewPackCli } from '../../kit/skills/dev-review/scripts/review-pack.mjs'
import { buildIntakeDecisionComments, buildMergeComments } from '../../kit/skills/lib/doc-comments.mjs'
import { isManagedPlanDoc, parseDocFrontmatter, readYamlBlockScalar } from '../../kit/skills/lib/doc-frontmatter.mjs'
import { locateDocuments } from '../../kit/skills/lib/doc-locator.mjs'
import { syncDocsLifecycle } from '../../kit/skills/lib/docs.mjs'
import { buildEscalationIssuePayload } from '../../kit/skills/lib/escalation.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { addLabelsWithEnsureAndReadback, mapWithConcurrency } from '../../kit/skills/lib/github-labels.mjs'
import { buildHandoff } from '../../kit/skills/lib/handoff-package.mjs'
import { evaluateIntakeTriage, hasIntakeBlockingSignal, readIntakeRecord, writeIntakeRecord } from '../../kit/skills/lib/intake-triage.mjs'
import { readTaskLedger, updateTaskLedger, writeTaskLedger } from '../../kit/skills/lib/ledger.mjs'
import { extractHeadlessSummary, indexMarkdownSections } from '../../kit/skills/lib/markdown-scan.mjs'
import { buildSessionOrientation } from '../../kit/skills/lib/session-orient.mjs'
import { parseSkillFrontmatter } from '../../kit/skills/lib/skill-discovery.mjs'
import { createTaskBackend, TASK_BACKEND_METHODS } from '../../kit/skills/lib/task-backend.mjs'
import { hydratePrTemplateBody, resolveEffectiveBaseSha, resolveReadablePrTitle } from '../../kit/skills/lib/workflow-helpers.mjs'
import { evaluateNextState } from '../../kit/skills/lib/workflow-policy.mjs'
import { renderAgentsTemplate } from '../compose-agents.mjs'
import { excludedSkillsFor } from '../lib/agents-defaults.mjs'
import { extractHeadlessSummary as engineExtractSummary, indexMarkdownSections as engineIndexSections } from '../lib/markdown.mjs'
import * as protocol from '../lib/protocol.mjs'
import {
  gitCommitFast, gitInit, gitInitBare, gitSync, rmTree, runAbsAsync, runNode, SKILL_ROOT, tmpProject,
} from './fixtures-helpers.mjs'
import { findProcessArtifactFilenames } from './preflight-contract-rules.mjs'
import { collectKitWriteProbeTargets, scanKitWriteProbeViolations } from './write-probe-audit.mjs'

async function withQuietIo(fn) {
  let out = ''
  let err = ''
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
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

export function registerLocateIntakeCases(cases) {
  // 1. 统一装配、彻底清零 lightweight、共享 YAML 块标量读取器与 excludedSkillsFor 修复
  cases.push(['统一装配零 lightweight、共享 YAML 块标量读取器与 excludedSkillsFor 修复', async () => {
    for (const removed of ['LIGHTWEIGHT_KIT_SKILLS', 'getLightweightKitSkills', 'EQUIP_TIERS']) {
      if (removed in protocol) return `protocol.mjs 仍残留已删除导出：${removed}`
    }
    if (!Array.isArray(protocol.UNIFIED_SKILL_NAMES) || protocol.UNIFIED_SKILL_NAMES.length < 5) {
      return `UNIFIED_SKILL_NAMES 异常：${JSON.stringify(protocol.UNIFIED_SKILL_NAMES)}`
    }
    const repoAgents = readFileSync(join(SKILL_ROOT, 'AGENTS.md'), 'utf8')
    const repoBytes = Buffer.byteLength(repoAgents, 'utf8')
    if (repoBytes >= protocol.AGENTS_COMPACT_RECOMMENDED_BYTES) {
      return `本仓 AGENTS.md 超过 24KB 推荐预算：${repoBytes}`
    }
    for (const unlanded of ['dev-edit', 'dev-verify-tools', 'dev-iterate']) {
      if (repoAgents.includes(`.agents/skills/${unlanded}/SKILL.md`)) {
        return `AGENTS.md 不应写入尚未落盘的技能路由：${unlanded}`
      }
    }

    // 共享 YAML 块标量读取器正反验证（| / |- / > / >-）
    const lit = readYamlBlockScalar(['summary: |', '  line1', '  line2', 'next: ok'], 1, 0, '|')
    const fold = readYamlBlockScalar(['description: >-', '  first part', '  second part', '', '  new para'], 1, 0, '>-')
    if (lit.value !== 'line1\nline2' || lit.nextIdx !== 3) return `readYamlBlockScalar literal 异常：${JSON.stringify(lit)}`
    if (!fold.value.includes('first part second part') || !fold.value.includes('new para')) {
      return `readYamlBlockScalar folded 异常：${JSON.stringify(fold)}`
    }
    const fmDoc = parseDocFrontmatter('---\nkind: spec\ntitle: >\n  multi line\n  spec title\n---\n# Body\n')
    const fmSkill = parseSkillFrontmatter('---\nname: demo-skill\ndescription: >-\n  folded skill\n  description\n---\n# Demo\n')
    if (fmDoc.data?.title !== 'multi line spec title' || fmSkill.description !== 'folded skill description') {
      return `doc/skill frontmatter 未共用块标量解析：doc=${JSON.stringify(fmDoc.data)} skill=${JSON.stringify(fmSkill)}`
    }

    // excludedSkillsFor 准确过滤已禁用技能
    const ex = excludedSkillsFor({ kit: { disabledSkills: ['dev-govern'] } })
    if (!ex.has('dev-govern') || ex.has('dev-flow')) {
      return `excludedSkillsFor 过滤结果异常：${JSON.stringify([...ex])}`
    }

    // 空模板渲染体积合理且不含 lightweight
    const tpl = readFileSync(join(SKILL_ROOT, 'templates/agents-project.md'), 'utf8')
    const rendered = renderAgentsTemplate({
      target: { name: 'empty-demo', path: SKILL_ROOT },
      git: { present: true, remote: null, tags: [], isRepoRoot: true },
      ecosystem: { kinds: [], publishable: false, manifests: [] },
      commands: {},
      docs: { readme: 'README.md', readmes: ['README.md'] },
      conventions: { defaultBranch: 'main', commitStyle: 'plain' },
    }, tpl, SKILL_ROOT, {})
    const renderedBytes = Buffer.byteLength(rendered, 'utf8')
    if (renderedBytes > 20000 || /lightweight/i.test(rendered)) {
      return `空模板渲染体积异常或含 lightweight：bytes=${renderedBytes}`
    }
    return true
  }])

  // 2. 零写入按需定位器 doc-locate.mjs + markdown-scan 同源 + session-orient / handoff-package 集成
  cases.push(['零写入按需定位器 doc-locate.mjs、围栏感知扫描、无头文档发现与 handoff Top-3 注入', async () => {
    const mdSample = [
      '# 真实标题',
      '',
      '首段摘要内容用于无头文档定位。',
      '',
      '```md',
      '# 围栏里的假标题',
      '## 假二级标题',
      '```',
      '',
      '## 真实章节',
      '',
      '核心定位关键词 `quantumRouter` 在此处定义。',
      '',
    ].join('\n')
    const secKit = indexMarkdownSections(mdSample)
    const secEng = engineIndexSections(mdSample)
    if (secKit.length !== 2 || secEng.length !== 2 || secKit.some((s) => s.title.includes('假'))) {
      return `围栏感知 Markdown 索引失效或双端不一致：kit=${JSON.stringify(secKit)} eng=${JSON.stringify(secEng)}`
    }
    const headlessSum = extractHeadlessSummary('第一段真正摘要。\n\n第二段正文。\n', 'notes.md')
    if (headlessSum !== engineExtractSummary('第一段真正摘要。\n\n第二段正文。\n', 'notes.md') || !headlessSum.includes('第一段真正摘要')) {
      return `extractHeadlessSummary 不一致或结果错误：${headlessSum}`
    }

    const dir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'README.md': '# locate-demo\n\n演示零写入按需定位能力。\n',
      'ARCHITECTURE.md': '# Architecture Overview\n\n系统采用双层内核与零依赖边界设计。\n\n## Payment Flow\n\n处理支付编排与退款对账逻辑。\n',
      'packages/api/AGENTS.md': '# API Scoped Rules\n\n仅修改 API 路由时执行本目录约定。\n',
      'docs/design-notes.md': '这是一份无 frontmatter 且无一级标题的纯设计笔记，阐述缓存失效策略与兜底机制。\n',
      'src/router.mjs': 'export function quantumRouter(req) {\n  return req?.path || "/"\n}\n',
      'node_modules/ignored-pkg/index.mjs': 'export function quantumRouter() { return "ignored" }\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      // 查询模式（doc + code + 过滤 node_modules）
      const qRes = locateDocuments(dir, { query: '支付编排', scope: 'docs', limit: 5 })
      if (!qRes.slices?.length || !qRes.slices[0].absPath || qRes.slices[0].relPath !== 'ARCHITECTURE.md') {
        return `doc-locate 关键词查询未命中 ARCHITECTURE.md：${JSON.stringify(qRes)}`
      }
      // 符号模式（不命中 node_modules）
      const symRes = locateDocuments(dir, { symbol: 'quantumRouter', scope: 'all', limit: 5 })
      if (!symRes.slices?.some((h) => h.relPath === 'src/router.mjs') || symRes.slices.some((h) => h.relPath.includes('node_modules'))) {
        return `doc-locate 符号定位异常：${JSON.stringify(symRes.slices)}`
      }
      // CLI 端到端与零写入验证
      const cliRes = await runAbsAsync('kit/skills/dev-explore/scripts/doc-locate.mjs', [
        '--file', 'ARCHITECTURE.md', '--section', 'Payment Flow', '--dir', dir, '--json',
      ])
      if (cliRes.status !== 0) return `doc-locate CLI 失败：${cliRes.stderr}`
      const cliJson = JSON.parse(cliRes.stdout)
      if (!cliJson.slices?.length || !cliJson.slices[0].absPath) {
        return `doc-locate --file --section 输出异常：${cliRes.stdout}`
      }
      const dirty = gitSync(dir, ['status', '--porcelain'], { encoding: 'utf8' }).stdout.trim()
      if (dirty) return `doc-locate 产生了磁盘写入污染：${dirty}`

      // session-orient 识别 ARCHITECTURE.md / */AGENTS.md / 无头文档
      const orient = buildSessionOrientation(dir)
      const orientStr = JSON.stringify(orient)
      if (!orientStr.includes('ARCHITECTURE.md') || !orientStr.includes('packages/api/AGENTS.md') || !orientStr.includes('docs/design-notes.md')) {
        return `session-orient 未收录 ARCHITECTURE.md / */AGENTS.md / 无头文档：${orientStr}`
      }
      // handoff-package Top-3 relatedSlices 注入
      mkdirSync(join(dir, 'docs/specs'), { recursive: true })
      writeFileSync(join(dir, 'docs/specs/261119-loc-spec.md'), '---\nkind: spec\ntitle: Payment Flow Router\n---\n# SPEC: Payment Flow Router\n\n修改 `src/router.mjs` 与 `ARCHITECTURE.md` 中的支付编排逻辑。\n', 'utf8')
      const pkg = buildHandoff({
        mainRoot: dir,
        ledger: { taskId: 'loc-1', status: 'in-progress', specFile: 'docs/specs/261119-loc-spec.md' },
      })
      const slices = pkg?.fields?.relatedSlices
      if (!Array.isArray(slices) || slices.length === 0 || slices.length > 3) {
        return `handoff-package 未按 Top-3 注入 relatedSlices：${JSON.stringify(slices)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  // 3. 全局业务分诊 flow intake、17 接口 TaskBackend.closePr、github-labels 并发/403 降级、write-probe 与 review-pack 前置阻断
  cases.push(['全局业务分诊 flow intake、closePr 17 接口、并发限流建标回读、write-probe 审计与 review-pack 前置拦截', async () => {
    if (TASK_BACKEND_METHODS.length !== 17 || !TASK_BACKEND_METHODS.includes('closePr')) {
      return `TASK_BACKEND_METHODS 应含 17 方法与 closePr：len=${TASK_BACKEND_METHODS.length}`
    }

    // github-labels 并发池限流 4 + 缺失建标写后回读 + 403 降级
    let inFlight = 0
    let maxInFlight = 0
    const mapped = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 4, async (v) => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return v * 2
    })
    if (maxInFlight > 4 || mapped.join(',') !== '2,4,6,8,10,12,14,16') {
      return `mapWithConcurrency 并发上限或结果异常：max=${maxInFlight} out=${mapped}`
    }

    const createdLabels = []
    let addedCalls = 0
    const mockLabelsOk = await addLabelsWithEnsureAndReadback({
      tier: 'node-https-token',
      repo: 'acme/demo',
      number: 12,
      labels: ['out-of-scope'],
      callHttps: async (method, path, body) => {
        if (method === 'POST' && path.endsWith('/labels') && !path.includes('/issues/')) {
          createdLabels.push(body.name)
          return { ok: true, status: 201, data: { name: body.name } }
        }
        addedCalls += 1
        if (addedCalls === 1) return { ok: false, status: 422, error: 'Validation Failed: label does not exist' }
        return { ok: true, status: 200, data: [{ name: 'out-of-scope' }] }
      },
      readTarget: async () => ({ ok: true, labels: ['out-of-scope'] }),
    })
    if (!mockLabelsOk.ok || !createdLabels.includes('out-of-scope') || !mockLabelsOk.verifiedReadback) {
      return `缺失标签自动建标与写后回读失败：${JSON.stringify(mockLabelsOk)}`
    }
    const mockLabels403 = await addLabelsWithEnsureAndReadback({
      tier: 'node-https-token',
      repo: 'acme/demo',
      number: 12,
      labels: ['wontfix'],
      callHttps: async () => ({ ok: false, status: 403, error: 'Resource not accessible by integration' }),
    })
    if (!mockLabels403.degraded || mockLabels403.status !== 403) {
      return `HTTP 403 未降级：${JSON.stringify(mockLabels403)}`
    }

    // write-probe-audit 捕获未调用 probeForWrite 的 closePr / closeIssue
    const badProbeDir = tmpProject({
      'kit/skills/dev-flow/scripts/bad-close.mjs': 'export async function bad(b) { return b.closePr({ number: 1 }) }\n',
      'kit/skills/dev-flow/scripts/bad-issue.mjs': 'export async function bad(b) { return b.closeIssue({ number: 2 }) }\n',
    })
    try {
      const violations = scanKitWriteProbeViolations(collectKitWriteProbeTargets(badProbeDir))
      if (!violations.some((v) => v.file.includes('bad-close.mjs')) || !violations.some((v) => v.file.includes('bad-issue.mjs'))) {
        return `write-probe-audit 未捕获未鉴权的 closePr/closeIssue：${JSON.stringify(violations)}`
      }
    } finally { rmTree(badProbeDir) }

    // 真实仓库测试 intake 5 维评估、内部 approved 豁免、dry-run vs --apply、closePr 与 review-pack 前置阻断
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# forge-cli\n\n纯命令行工程治理工具，不提供移动客户端或桌面 GUI。\n',
      'docs/TDD.md': [
        '# forge-cli — 技术设计文档',
        '',
        '## 定位与非目标',
        '- 定位：纯 CLI 工程规范治理与流转引擎。',
        '- 非目标：绝不开发 iOS App、桌面 GUI 客户端或区块链矿机。',
        '',
      ].join('\n'),
      'docs/specs/261119-issue20-cli-fast-spec.md': [
        '---',
        'kind: spec',
        'status: approved',
        'approved: true',
        'issue: 20',
        'title: CLI 快速扫描优化',
        '---',
        '# SPEC: CLI 快速扫描优化',
        '',
        '## 验收标准',
        '- [ ] C1: 扫描耗时降低',
        '',
      ].join('\n'),
      'AGENTS.md': '# forge-cli\n\n## Dev Profile\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\narch-rules: none\nhigh-risk: none\ndo-not-edit: docs/archive/\n```\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
    try {
      // 内部已批准 SPEC 豁免
      const approvedEval = evaluateIntakeTriage(dir, {
        targetType: 'issue',
        targetNumber: 20,
        title: 'CLI 快速扫描优化',
        body: '按已批 SPEC 推进实现。',
      })
      if (!approvedEval.exempt || approvedEval.decision !== 'accept') {
        return `已批准内部 SPEC 未豁免：${JSON.stringify(approvedEval)}`
      }

      // 明显越界需求（命中非目标）-> reject；含糊单 -> needs-info
      const oosEval = evaluateIntakeTriage(dir, {
        targetType: 'pr',
        targetNumber: 88,
        title: '新增 iOS App 与区块链矿机模块',
        body: '把整个 CLI 改写成 iOS App 并内置区块链矿机。',
      })
      if (oosEval.decision !== 'reject') {
        return `命中非目标的外部 PR 未判定 reject：${JSON.stringify(oosEval)}`
      }
      const vagueEval = evaluateIntakeTriage(dir, {
        targetType: 'issue',
        targetNumber: 89,
        title: '优化',
        body: '',
      })
      if (vagueEval.decision !== 'needs-info') {
        return `空白含糊 Issue 未判定 needs-info：${JSON.stringify(vagueEval)}`
      }

      // 评论三段结构（结构化头 + pf-state + 人话理由）
      const built = buildIntakeDecisionComments({
        targetType: 'pr',
        targetNumber: 88,
        decision: 'reject',
        rationale: '超出本仓库 CLI 非目标边界',
        tddRefs: ['docs/TDD.md#明确非目标'],
        rollbackHint: '请先提交 RFC 讨论定位变更后再重开。',
      })
      if (!built.commentBody?.includes('<!-- pf-state:') || !built.commentBody.includes('超出本仓库 CLI 非目标边界') || !built.commentBody.includes('RFC')) {
        return `buildIntakeDecisionComments 缺少三段必备内容：\n${built.commentBody}`
      }

      // GenericRemoteBackend closePr 返回 delegatedPayload
      const genBk = createTaskBackend({ role: 'generic-git', providerId: 'generic-git', mainRoot: dir })
      const genClose = await genBk.closePr({ number: 88, reason: 'out-of-scope', comment: built.commentBody })
      if (!genClose.delegated || !genClose.delegatedPayload?.comment) {
        return `GenericRemoteBackend.closePr 缺少 delegatedPayload：${JSON.stringify(genClose)}`
      }

      // LocalOnlyBackend closePr 持久化并离线 getPr 可回读
      const localBk = createTaskBackend({ role: 'local-only', providerId: 'none', mainRoot: dir })
      const lcClose = await localBk.closePr({ number: 88, reason: 'out-of-scope', comment: built.commentBody, labels: ['out-of-scope'] })
      const lcGet = await localBk.getPr(88)
      if (!lcClose.ok || !lcGet.ok || lcGet.state !== 'CLOSED') {
        return `LocalOnlyBackend.closePr/getPr 离线持久化失败：close=${JSON.stringify(lcClose)} get=${JSON.stringify(lcGet)}`
      }

      // flow intake dry-run 不写盘，--apply 落盘分诊记录
      const roots = await resolveRepoRoots(dir)
      const dryRes = await withQuietIo(() => handleIntake({
        pr: '77', title: '新增 iOS App 客户端', body: '新增桌面 GUI 与 iOS App', decision: 'reject', rationale: '不在项目范围', json: true,
      }, roots))
      if (dryRes.res.exitCode !== 0 || readIntakeRecord(dir, 'pr', 77) !== null) {
        return `flow intake 默认预演竟写入磁盘或退出异常：res=${JSON.stringify(dryRes.res)}`
      }
      const applyRes = await withQuietIo(() => handleIntake({
        pr: '77', title: '新增 iOS App 客户端', body: '新增桌面 GUI 与 iOS App', decision: 'reject', rationale: '不在项目范围', apply: true, json: true,
      }, roots))
      const savedRec = readIntakeRecord(dir, 'pr', 77)
      if (applyRes.res.exitCode !== 0 || savedRec?.decision !== 'reject' || !hasIntakeBlockingSignal({ record: savedRec }).blocked) {
        return `flow intake --apply 未正确持久化分诊阻断记录：res=${JSON.stringify(applyRes.res)} rec=${JSON.stringify(savedRec)}`
      }

      // review-pack 前置 intake 门禁：对已 reject 的 PR 直接返回退出码 3 + BLOCKED_INTAKE_REJECTED（绕过 BLOCKED_EMPIRICAL_FIRST）
      await writeIntakeRecord(dir, { targetType: 'pr', targetNumber: 77, decision: 'reject', reason: '不在项目范围' })
      const rpBlock = await withQuietIo(() => runReviewPackCli(['--pr', '77', '--dir', dir, '--json']))
      if (rpBlock.res !== 3 || !rpBlock.out.includes('BLOCKED_INTAKE_REJECTED') || rpBlock.out.includes('BLOCKED_EMPIRICAL_FIRST')) {
        return `review-pack 未前置拦截已 reject PR：exit=${rpBlock.res} out=${rpBlock.out}`
      }
      const rpOverride = await withQuietIo(() => runReviewPackCli(['--pr', '77', '--override-intake', '--dir', dir, '--json']))
      if (rpOverride.out.includes('BLOCKED_INTAKE_REJECTED')) {
        return `--override-intake 未绕过 intake 阻断：out=${rpOverride.out}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  // 4. 状态机/锁/R1 回归 + 实时自举 rebase baseSha 校准 + B4a/B5 Should-Fix + 钩子 + 快拆依赖 + 功能域命名门禁
  cases.push(['状态机锁/R1回归、rebase 基线校准、frontmatter 收窄、钩子分发、快拆依赖与功能域命名门禁', async () => {
    // A. Tier 2 功能域文件名确定性门禁正反双向
    const badNames = [
      'scripts/dev/fixtures-issue50.mjs',
      'scripts/dev/fixtures-stagec-c1.mjs',
      'scripts/dev/wave3-runner.mjs',
      'kit/skills/lib/pr42-sync.mjs',
      'scripts/dev/fixtures-loop-b4b.mjs',
      'scripts/slice2-worker.mjs',
      'scripts/phase1-init.mjs',
    ]
    const goodNames = [
      'kit/skills/lib/local-issues.mjs',
      'kit/skills/dev-flow/scripts/flow-issues.mjs',
      'kit/skills/dev-review/scripts/review-pr.mjs',
      'kit/skills/lib/task-backend.mjs',
      'kit/skills/dev-flow/scripts/flow-batch.mjs',
      'scripts/staged-files.mjs',
      'scripts/dev/fixtures-locate-intake.mjs',
      'docs/specs/261119-issue90-stagec-c1-spec.md',
      'docs/archive/todo/261118-issue50-todo.md',
    ]
    const badHits = findProcessArtifactFilenames(badNames)
    const goodHits = findProcessArtifactFilenames(goodNames)
    if (badHits.length !== badNames.length) {
      return `过程编号文件名漏报：expected=${badNames.length} got=${JSON.stringify(badHits)}`
    }
    if (goodHits.length > 0) {
      return `合法功能名或规划文档目录被误报：${JSON.stringify(goodHits)}`
    }

    // B. B4a isManagedPlanDoc 收窄 bare plan: 至 frontmatter 块内
    const userNoteWithBodyPlan = '# Design Notes\n\nplan: migrate cache next quarter\n'
    const managedWithFmPlan = '---\nplan: yes\nstatus: draft\n---\n# Doc\n'
    if (isManagedPlanDoc('docs/notes.md', userNoteWithBodyPlan)) {
      return '普通正文中的 bare plan: 被误判为受管规划文档'
    }
    if (!isManagedPlanDoc('docs/notes.md', managedWithFmPlan)) {
      return 'frontmatter 中的 plan: 未被识别为受管规划文档'
    }

    // C. assertSubmitOwnership + checkLifecyclePreconditions 权属与释放校验
    const ownerLedger = { taskId: 'own-1', status: 'in-progress', claimedBy: 'impl-a', claimedAt: new Date().toISOString() }
    if (assertSubmitOwnership({ taskId: 'own-0', status: 'in-progress' }, { agent: 'coordinator' }).code !== 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH'
      || assertSubmitOwnership(ownerLedger, { agent: 'coordinator' }).code !== 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH') {
      return '协调者代提交未被拦截'
    }
    if (assertSubmitOwnership(ownerLedger, { agent: 'impl-b' }).code !== 'BLOCKED_SUBMIT_OWNERSHIP_MISMATCH') {
      return '非认领者提交未被拦截'
    }
    if (!assertSubmitOwnership({ ...ownerLedger }, { agent: 'impl-b', takeover: true, reason: '接管交接' }).ok) {
      return '--takeover --reason 合法接管未放行'
    }
    const releasedCheck = checkLifecyclePreconditions({ taskId: 'own-1', status: 'released' })
    if (releasedCheck.ok || releasedCheck.code !== 'BLOCKED_NOT_CLAIMED') {
      return `已释放任务未阻断为 BLOCKED_NOT_CLAIMED：${JSON.stringify(releasedCheck)}`
    }

    // D. 真实仓库综合测试：并发账本锁 + R1 回归 + rebase baseSha 校准 + flow sync + 钩子 + 脱敏信号 + 快拆依赖 + hydrateRemotePfState 鉴权
    const bare = tmpProject({})
    gitInitBare(bare)
    const dir = tmpProject({
      '.gitignore': '.worktrees/\nnode_modules/\n',
      'package.json': '{"name":"rt-demo","version":"1.0.0","scripts":{"test":"exit 0"}}\n',
      'node_modules/demo-pkg/index.js': 'module.exports = 1\n',
      'README.md': '# rt-demo\n',
      'src/base.mjs': 'export const base = 1\n',
      'AGENTS.md': [
        '# rt-demo',
        '',
        '## Dev Profile',
        '```yaml',
        'quick-test: exit 0',
        'full-test: exit 0',
        'smoke-verify: none',
        'merge-gate: exit 0',
        'arch-rules: none',
        'high-risk: none',
        'do-not-edit: docs/archive/',
        '```',
        '',
      ].join('\n'),
    })
    gitInit(dir, { branch: 'main', origin: bare.replace(/\\/g, '/'), name: 'alice', email: 'alice@example.com' })
    gitSync(dir, ['push', '-u', 'origin', 'main'])
    try {
      const roots = await resolveRepoRoots(dir)

      // 1. 并发 updateTaskLedger 原子锁 + writeTaskLedger 兼容包装
      writeTaskLedger(dir, { taskId: 'lock-t', status: 'in-progress', counters: [] })
      await Promise.all([1, 2, 3, 4].map((n) => updateTaskLedger(dir, 'lock-t', (cur) => ({
        ...cur,
        counters: [...(cur.counters ?? []), n],
      }))))
      const locked = readTaskLedger(dir, 'lock-t')
      if ((locked?.counters?.length ?? 0) !== 4) {
        return `并发 updateTaskLedger 丢更新：${JSON.stringify(locked?.counters)}`
      }

      // 2. R1 回归：auditRepoDocs 目录扫描 + flow-batch merge-queue 校验 + docs.mjs ledgerRoot
      const repoAud = auditRepoDocs(dir)
      if (!repoAud || !Array.isArray(repoAud.results)) return `auditRepoDocs 目录扫描异常：${JSON.stringify(repoAud)}`
      let mqMissingCaught = false
      try {
        await withQuietIo(() => handleBatch({ _: ['merge-queue'], tasks: 'missing-task-1', json: true }, roots))
      } catch (e) {
        mqMissingCaught = /missing-task-1/.test(String(e?.message ?? e))
      }
      if (!mqMissingCaught) return 'flow-batch merge-queue 未拦截缺失任务账本'

      // 3. 实时自举 Bug 修复：手动 git rebase origin/main 后 baseSha 滞后不误算已合入主干文件，且 flow sync 识别已基于目标分支
      const stRes = await withQuietIo(() => handleStart({ task: 'rb-t1', case: '2', slug: 'rb-t1', agent: 'impl-a' }, roots))
      if (stRes.res.exitCode !== 0) return `start rb-t1 失败：${JSON.stringify(stRes.res)}`
      await withQuietIo(() => handleClaim({ task: 'rb-t1', agent: 'impl-a' }, roots))
      await withQuietIo(() => handleExplore({ task: 'rb-t1', by: 'impl-a' }, roots))

      // 在 main 上合入一个新文件并推送 origin/main
      writeFileSync(join(dir, 'src/merged-on-main.mjs'), 'export const merged = true\n', 'utf8')
      gitCommitFast(dir, 'feat: merged on main')
      gitSync(dir, ['push', 'origin', 'main'])

      // 在 impl worktree 做一次改动并手动 git rebase origin/main（此时 ledger.baseSha 仍指向旧 main！）
      const wtDir = join(dir, '.worktrees', 'impl-rb-t1')
      mkdirSync(join(wtDir, 'docs'), { recursive: true })
      writeFileSync(join(wtDir, 'docs/own-note.md'), '# own\n', 'utf8')
      gitCommitFast(wtDir, 'docs: own note')
      gitSync(wtDir, ['fetch', 'origin'])
      const rb = gitSync(wtDir, ['rebase', 'origin/main'])
      if (rb.status !== 0) return `手动 rebase 失败：${rb.stderr}`

      const oldLedger = readTaskLedger(dir, 'rb-t1')
      const effBase = await resolveEffectiveBaseSha(wtDir, oldLedger, { gitCommonDir: roots.gitDir })
      const mainHead = gitSync(dir, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
      if (effBase !== mainHead) {
        return `resolveEffectiveBaseSha 未校准到 rebase 后的 merge-base：eff=${effBase} main=${mainHead} old=${oldLedger.baseSha}`
      }
      const syncOut = await withQuietIo(() => handleSync({ task: 'rb-t1', json: true }, roots))
      const syncJson = JSON.parse(syncOut.out || '{}')
      if (syncOut.res.exitCode !== 0 || !syncJson.alreadyBasedOnTarget) {
        return `flow sync 未识别已基于目标主干快速刷新 baseSha：out=${syncOut.out}`
      }
      // syncDocsLifecycle 在 worktree 中传入 ledgerRoot
      const syncLc = await syncDocsLifecycle(wtDir, { ledgerRoot: dir, taskId: 'rb-t1', dryRun: true })
      if (!syncLc || typeof syncLc !== 'object') return 'syncDocsLifecycle ledgerRoot 调用失败'

      // 4. flow status 与 flow next / evaluateNextState 一致
      const curLedger = readTaskLedger(dir, 'rb-t1')
      const statusNext = evaluateNextState({ activeTasks: [curLedger], selectedTask: curLedger, taskRuntime: { commitsAheadOfBase: 1 } })
      const nxRes = await withQuietIo(() => handleNext({ task: 'rb-t1', json: true }, roots))
      const nxJson = JSON.parse(nxRes.out || '{}')
      const stCli = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['status', '--task', 'rb-t1', '--dir', dir, '--json'])
      const stJson = JSON.parse(stCli.stdout || '{}')
      if (nxJson.phase !== statusNext.phase || stJson.phase !== nxJson.phase) {
        return `flow next/status 与 evaluateNextState 阶段不一致：next=${nxJson.phase} eval=${statusNext.phase} status=${stJson.phase}`
      }

      // 5. hydrateRemotePfState 对 clone-readonly 拒写回
      writeTaskLedger(dir, {
        taskId: 'ro-1', role: 'clone-readonly', status: 'in-review', prNumber: 5, branch: 'feat/ro-1',
      })
      gitSync(dir, ['remote', 'set-url', 'origin', 'https://github.com/acme/demo.git'])
      let roListCalled = false
      const roNext = await withQuietIo(() => handleNext({
        task: 'ro-1', 'probe-auth': true, json: true,
        _ghClient: { tier: 'gh-cli', async listComments() { roListCalled = true; return { ok: true, comments: [] } } },
        _ghProbe: { env: { trackB: { tier: 'gh-cli' } } },
      }, roots))
      const roJson = JSON.parse(roNext.out || '{}')
      if (roListCalled || roJson.hydration?.reason !== 'write-auth-required') {
        return `clone-readonly 未拦截远端状态回填：called=${roListCalled} ${JSON.stringify(roJson.hydration)}`
      }
      gitSync(dir, ['remote', 'set-url', 'origin', bare.replace(/\\/g, '/')])

      // 6. flow-lifecycle-hooks edit-gate 优雅跳过、--skip-edit-gate 留痕与失败阻断
      const hookSkipMissing = await runPreVerifyEditGateHook({ mainRoot: dir, implRoot: wtDir, taskId: 'rb-t1', ledger: readTaskLedger(dir, 'rb-t1') })
      if (!hookSkipMissing.ok || !hookSkipMissing.skipped) {
        return `edit-gate.mjs 不存在时未优雅跳过：${JSON.stringify(hookSkipMissing)}`
      }
      const mockGateDir = join(dir, '.agents', 'skills', 'dev-edit', 'scripts')
      mkdirSync(mockGateDir, { recursive: true })
      writeFileSync(join(mockGateDir, 'edit-gate.mjs'), 'process.stderr.write("mock edit gate fail\\n"); process.exit(3)\n', 'utf8')
      const hookBlocked = await runPreVerifyEditGateHook({ mainRoot: dir, implRoot: wtDir, taskId: 'rb-t1', ledger: readTaskLedger(dir, 'rb-t1') })
      if (hookBlocked.ok || hookBlocked.code !== 'BLOCKED_EDIT_GATE_FAILED') {
        return `失败的 mock edit-gate 未阻断：${JSON.stringify(hookBlocked)}`
      }
      const bypassLedger = readTaskLedger(dir, 'rb-t1')
      const hookBypass = await runPreVerifyEditGateHook({
        mainRoot: dir, implRoot: wtDir, taskId: 'rb-t1', ledger: bypassLedger, opts: { 'skip-edit-gate': true },
      })
      if (!hookBypass.ok || hookBypass.reason !== 'skip-edit-gate-flag' || !bypassLedger.hooks?.editGateSkippedAt) {
        return `--skip-edit-gate 未留痕放行：${JSON.stringify(hookBypass)}`
      }
      rmTree(join(dir, '.agents'))

      // 7. B5 verify.*.fail 信号对 cmd 敏感令牌脱敏
      const agentsSecret = readFileSync(join(wtDir, 'AGENTS.md'), 'utf8')
        .replace('quick-test: exit 0', 'quick-test: node -e "process.exit(1)" --token ghp_1234567890abcdefghij1234567890abcd')
      writeFileSync(join(wtDir, 'AGENTS.md'), agentsSecret, 'utf8')
      gitCommitFast(wtDir, 'test: add failing quick-test with token')
      await withQuietIo(() => handleVerify({ task: 'rb-t1', mode: 'quick', json: true }, roots))
      const sigPath = join(dir, '.worktrees', '.state', 'signals.jsonl')
      if (existsSync(sigPath)) {
        const sigText = readFileSync(sigPath, 'utf8')
        if (sigText.includes('ghp_1234567890')) {
          return `verify.*.fail 信号泄露未脱敏令牌：\n${sigText}`
        }
      }

      // 8. worktree-deps 快拆 deps 路径（仅 unlink 符号链接，绝不删主仓 node_modules）
      const linkDest = join(wtDir, 'node_modules')
      let linked = false
      try {
        symlinkSync(join(dir, 'node_modules'), linkDest, process.platform === 'win32' ? 'junction' : 'dir')
        linked = true
      } catch { /* 无符号链接权限跳过 */ }
      if (linked) {
        const um = unmountSharedDeps(wtDir, { mainRoot: dir, deps: ['node_modules'] })
        if (!um.ok || !um.fastGuided || existsSync(linkDest) || !existsSync(join(dir, 'node_modules/demo-pkg/index.js'))) {
          return `worktree-deps 快拆异常或误删主仓依赖：${JSON.stringify(um)}`
        }
      }
      return true
    } finally {
      rmTree(dir)
      rmTree(bare)
    }
  }])

  // 5. PR / Issue 标题与正文可读性根治（去引导注释、验证证据表、无审查占位段、紧凑建单与合并评论）
  cases.push(['PR/Issue 可读性根治：可读标题、零引导注释、实证表格、紧凑建单与合并评论 SHA/实施人', async () => {
    const rawPrTpl = readFileSync(join(SKILL_ROOT, '.github/pull_request_template.md'), 'utf8')
    const dir = tmpProject({
      '.github/pull_request_template.md': `<!-- 引导注释：提交前请替换为真实摘要 -->\n${rawPrTpl}\n## 独立审查与故障注入\n\n待补充\n`,
      'docs/specs/261119-issue90-demo-spec.md': [
        '---',
        'kind: spec',
        'title: 统一装配与按需定位内核升级',
        '---',
        '# SPEC: 统一装配与按需定位内核升级',
        '',
        '## 目标与范围',
        '- 清理历史双档分支并交付零写入按需定位器。',
        '- 统一全局业务分诊入口与可读 PR 正文生成。',
        '',
      ].join('\n'),
      'docs/todo/261119-issue90-demo-todo.md': [
        '---',
        'kind: todo',
        'title: 统一装配与按需定位实施清单',
        '---',
        '# Todo: 统一装配与按需定位实施清单',
        '',
        '## 完成后的记录',
        '- 全量门禁与 300 文件基准测试均已实测通过。',
        '',
      ].join('\n'),
    })
    try {
      const ledger = {
        taskId: 'demo-slug-x1',
        caseType: 4,
        branch: 'feat/demo-slug-x1',
        baseBranch: 'main',
        baseSha: '1111111222222233333333444444445555555566',
        linkedIssues: [90],
        specFile: 'docs/specs/261119-issue90-demo-spec.md',
        todoFile: 'docs/todo/261119-issue90-demo-todo.md',
        claimedBy: 'impl-c1',
        implementerId: 'alice',
        finalized: true,
        lastVerifyExitCode: 0,
        verifiedHead: 'abcdef1234567890abcdef1234567890abcdef12',
      }
      const title = resolveReadablePrTitle(dir, ledger)
      if (!title.includes('统一装配与按需定位内核升级') || title === 'demo-slug-x1') {
        return `PR 标题未从 SPEC 提取可读标题：${title}`
      }
      const body = hydratePrTemplateBody({
        repoRoot: dir,
        taskId: ledger.taskId,
        ledger,
        policy: { riskTier: 'medium', highRiskHits: [], oneWayBoundaryHits: [], independentReviewRequired: true },
        evidence: {
          mode: 'gate',
          e2eObservation: { summary: 'doc-locate 实测 58ms 返回绝对路径与行号' },
          gates: {
            quick: { cmd: 'node scripts/dev/preflight.mjs', exitCode: 0, durationMs: 420 },
            gate: { cmd: 'node scripts/dev/fixtures.mjs', exitCode: 0, durationMs: 3100 },
          },
        },
        actorDisplay: 'impl-c1',
        currentHead: ledger.verifiedHead,
        changedFiles: ['kit/skills/lib/doc-locator.mjs', 'scripts/equip.mjs'],
      })
      const bodyNoPf = body.replace(/<!--\s*pf-state:[\s\S]*?-->/g, '')
      if (/<!--/.test(bodyNoPf)) return `PR 正文仍残留引导 HTML 注释：\n${bodyNoPf}`
      if (body.includes('独立审查与故障注入') || body.includes('待补充')) {
        return `PR 正文仍残留静态独立审查占位段：\n${body}`
      }
      const tableHeaderCount = (body.match(/\| 验证项 \| 结果 \| 耗时 \| 退出码 \|/g) ?? []).length
      if (tableHeaderCount !== 1 || !body.includes('420ms') || !body.includes('doc-locate 实测 58ms')) {
        return `PR 正文缺少唯一实证验证表格或 E2E 观察（tableHeaders=${tableHeaderCount}）：\n${body}`
      }
      if (!body.includes('Fixes #90') || !body.includes('- [x] 门禁全绿')) {
        return `verifyPassed=true 时未填充关联 Issue 或未勾选实证自查项：\n${body}`
      }

      // 紧凑建单正文（escalation）不抄长文且包含三段
      const esc = buildEscalationIssuePayload({
        taskId: 'demo-slug-x1',
        title: 'fix: 同步失败',
        summary: '本地 smoke-verify 退出码 2',
        evidence: ['exitCode=2', 'stdout=FAIL'],
        criteria: ['C1: smoke-verify 返回 0'],
        sourceDoc: 'docs/specs/261119-issue90-demo-spec.md',
      })
      if (!esc.body.includes('## 背景与现象') || !esc.body.includes('## 验收标准') || esc.body.length > 3000) {
        return `escalation 建单正文格式不符合紧凑通用规范：\n${esc.body}`
      }

      // 合并评论包含 mergeCommit 短 SHA 与真实实施人 claimedBy
      const mergeCmt = buildMergeComments({
        prNumber: 95,
        branch: ledger.branch,
        baseBranch: ledger.baseBranch,
        headSha: ledger.verifiedHead,
        mergeCommit: '9876543210fedcba9876543210fedcba98765432',
        implementerDisplay: ledger.claimedBy,
        reviewerId: 'rev-1',
        linkedIssues: [90],
      })
      const mergeBody = `${mergeCmt.prCommentBody ?? ''}\n${mergeCmt.issueCommentBody ?? ''}`
      if (!mergeBody.includes('9876543') || !mergeBody.includes('impl-c1')) {
        return `合并评论缺少 mergeCommit 短 SHA 或真实实施人 claimedBy：\n${mergeBody}`
      }
      return true
    } finally { rmTree(dir) }
  }])
}
