#!/usr/bin/env node
/**
 * fixtures-edit-pyramid.mjs —— dev-edit 词法门禁、过程工件命名拦截、严格三层倒金字塔与 dev-govern 自动触发正反双向断言。
 *
 * 同时支持独立执行（`node scripts/dev/fixtures-edit-pyramid.mjs`）与由 `fixtures.mjs` 自动发现加载。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { isMainModule, resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import { listLocalIssues } from '../../kit/skills/lib/local-issues.mjs'
import { classifyTestFileTier, detectTestTierMetadata } from '../../kit/skills/lib/profile-sniffer.mjs'
import { appendGovernSignal, readSignalsJsonl, resolveGovernStateDir } from '../../kit/skills/lib/signals.mjs'
import { discoverKitSkills } from '../../kit/skills/lib/skill-discovery.mjs'
import { runEditGate } from '../../kit/skills/dev-edit/scripts/edit-gate.mjs'
import { handleStart } from '../../kit/skills/dev-flow/scripts/flow-inspect.mjs'
import { handleVerify } from '../../kit/skills/dev-flow/scripts/flow-lifecycle.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import {
  formatReviewCriteriaTable, sanitizeReviewTableCell, syncReviewToGitHub,
} from '../../kit/skills/dev-review/scripts/review-sync.mjs'
import { loadGovernState } from '../../kit/skills/dev-govern/scripts/govern-state.mjs'
import {
  SKILL_ROOT, gitCommitFast, gitInit, issueTokenFor, rmTree, runAbsAsync, seedExploredFor, tmpProject,
} from './fixtures-helpers.mjs'

async function withQuietIo(fn) {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)
  let out = ''
  let err = ''
  process.stdout.write = (chunk) => { out += String(chunk); return true }
  process.stderr.write = (chunk) => { err += String(chunk); return true }
  try {
    const res = await fn()
    return { res, out, err }
  } finally {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

export function registerEditPyramidCases(cases) {
  cases.push(['StageC C5：第 6 技能 dev-edit、edit-gate 词法去噪与过程工件命名拦截（正反双向）', async () => {
    const kitSkills = discoverKitSkills(join(SKILL_ROOT, 'kit', 'skills'))
    const devEdit = kitSkills.find((s) => s.dirName === 'dev-edit')
    if (!devEdit || devEdit.order !== 33) {
      return `discoverKitSkills 未发现 order=33 的 dev-edit：${JSON.stringify(devEdit)}`
    }
    const skillLines = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'dev-edit', 'SKILL.md'), 'utf8').split('\n').length
    if (skillLines > 130) return `kit/skills/dev-edit/SKILL.md 行数超标：${skillLines} > 130`

    const bigCode = Array.from({ length: 810 }, (_, i) => `export const v${i} = ${i}`).join('\n') + '\n'
    const tightCode = Array.from({ length: 745 }, (_, i) => `export const t${i} = ${i}`).join('\n') + '\n'
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': [
        '# c5-demo',
        '',
        '## Dev Profile',
        '',
        '```yaml',
        'quick-test: node --test',
        'full-test: node --test',
        'smoke-verify: none',
        'merge-gate: node --test',
        'arch-rules: src/ui/** -> src/db/**',
        'high-risk: src/core/',
        'do-not-edit: docs/archive/, generated/',
        '```',
        '',
      ].join('\n'),
      'src/db/conn.mjs': 'export const dbQuery = () => []\n',
      'src/shared/fmt.mjs': 'export function formatLabel(v) { return String(v) }\n',
      'src/shared/clean.mjs': [
        '// Regular explanation without history or suppression',
        "export const DOC_EXAMPLE = '@ts-ignore HACK WORKAROUND TEMP eslint-disable'",
        'export const SLEEP_PATTERN = /setTimeout\\s*\\([^,\\n]+,\\s*1500\\)/',
        "export const FAKE_IMPORT = \"import { dbQuery } from '../db/conn.mjs'\"",
        '// pf-allow: documented intentional boundary marker HACK',
        'export const ok = true',
        '',
      ].join('\n'),
      'src/shared/tight.mjs': tightCode,
      'src/ui/bad.mjs': [
        '// 以前是旧接口，后来改成直接查库',
        '// 2026-01-12 fixed old timeout',
        '// @ts-ignore',
        'import { dbQuery } from "../db/conn.mjs"',
        '// const deadA = 1;',
        '// if (deadA > 0) {',
        '//   return deadA;',
        '// }',
        'export const render = () => dbQuery()',
        '',
      ].join('\n'),
      'docs/archive/old.md': '# locked\n',
      'test/fixtures/sample.mjs': '// @ts-ignore HACK 以前是旧夹具\nexport const fx = 1\n',
      'test/bad-zero.test.mjs': "import { it } from 'node:test'\nit('empty', () => { const x = 1; void x })\n",
      'test/bad-mock.test.mjs': "import { it } from 'node:test'\nit('mock', () => { const f1 = vi.fn(); const f2 = vi.fn(); const f3 = vi.fn(); const f4 = vi.fn(); const f5 = vi.fn(); f1(); expect(f1).toHaveBeenCalled() })\n",
      'test/bad-sleep.test.mjs': "import assert from 'node:assert/strict'\nawait new Promise((r) => setTimeout(r, 1500))\nassert.ok(true)\n",
      'test/bad-headed.test.mjs': "import assert from 'node:assert/strict'\nconst opts = { headless: false }\nassert.ok(opts)\n",
      'test/good.test.mjs': "import assert from 'node:assert/strict'\nconst sample = 'setTimeout(r, 2000)'\nassert.strictEqual(typeof sample, 'string')\n",
      // 过程工件文件名（正向应阻断）与常规业务文件名（反向应放行）
      'src/issue99-fix.mjs': 'export const fix = 1\n',
      'tests/stagec-c2.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'scripts/wave3-runner.mjs': 'export const run = 1\n',
      'src/local-issues.mjs': 'export const listIssues = () => []\n',
      'src/flow-issues.mjs': 'export const syncIssues = () => []\n',
      'src/review-pr.mjs': 'export const scanPr = () => true\n',
      'src/api/v2/handler.mjs': 'export const handle = () => 200\n',
      'src/staged.mjs': 'export const staged = true\n',
      'docs/specs/261119-issue91-spec.md': '# spec\n',
    })
    gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
    mkdirSync(join(dir, 'src', 'core'), { recursive: true })
    writeFileSync(join(dir, 'src', 'core', 'huge.mjs'), bigCode, 'utf8')

    try {
      // 1. pre-edit: blocks do-not-edit, warns tight file & high-risk, returns reuseHints
      const preBlock = await runEditGate({ mode: 'pre-edit', dir, files: ['docs/archive/old.md', 'src/shared/tight.mjs', 'src/core/huge.mjs'] })
      if (preBlock.ok || preBlock.exitCode !== 3 || !preBlock.blockers.some((b) => b.ruleId === 'edit.do-not-edit')) {
        return `pre-edit 未拦截 do-not-edit：${JSON.stringify(preBlock)}`
      }
      if (!preBlock.nearLimitFiles.some((f) => f.file === 'src/shared/tight.mjs')) {
        return `pre-edit 未预警 730-800 行紧文件：${JSON.stringify(preBlock.nearLimitFiles)}`
      }
      if (!preBlock.reuseHints.some((h) => h.siblings.some((s) => s.file === 'src/shared/fmt.mjs' && s.symbols.includes('formatLabel')))) {
        return `pre-edit 未返回相邻复用符号提示：${JSON.stringify(preBlock.reuseHints)}`
      }

      // 2. 正向阻断：bad.mjs + huge.mjs + 4 类坏测试 + 3 类过程工件文件名必须全部命中对应规则
      const badRes = await runEditGate({
        mode: 'verify',
        dir,
        files: [
          'src/ui/bad.mjs', 'src/core/huge.mjs',
          'test/bad-zero.test.mjs', 'test/bad-mock.test.mjs', 'test/bad-sleep.test.mjs', 'test/bad-headed.test.mjs',
          'src/issue99-fix.mjs', 'tests/stagec-c2.test.mjs', 'scripts/wave3-runner.mjs',
        ],
      })
      const ruleIds = new Set(badRes.blockers.map((b) => b.ruleId))
      for (const want of [
        'edit.suppression-bypass',
        'edit.tombstone-comment',
        'edit.dead-code-block',
        'edit.arch-boundary',
        'edit.file-oversized',
        'edit.test-zero-assertion',
        'edit.test-mock-tautology',
        'edit.test-hard-sleep',
        'edit.test-non-headless',
        'naming.process-artifact-filename',
      ]) {
        if (!ruleIds.has(want)) return `edit-gate 漏报 ${want}：actual=${JSON.stringify([...ruleIds])}`
      }
      const namingHits = badRes.blockers.filter((b) => b.ruleId === 'naming.process-artifact-filename').map((b) => b.file)
      if (namingHits.length !== 3) {
        return `过程工件文件名阻断数不符（期望 3）：${JSON.stringify(namingHits)}`
      }
      if (badRes.exitCode !== 3) return `edit-gate 命中阻塞项未返回 exitCode=3：${badRes.exitCode}`

      // 2b. govern-audit 同步执行 naming.process-artifact-filename 且不误伤合法业务文件与 docs/specs/
      const govAud = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--categories', 'hygiene', '--json'])
      if (govAud.status !== 0) return `govern-audit hygiene 失败：${govAud.stderr}`
      const govNamingIds = (JSON.parse(govAud.stdout).findings ?? []).filter((f) => f.id.startsWith('naming.process-artifact-filename.')).map((f) => f.file)
      for (const badName of ['src/issue99-fix.mjs', 'tests/stagec-c2.test.mjs', 'scripts/wave3-runner.mjs']) {
        if (!govNamingIds.includes(badName)) return `govern-audit 漏报过程工件文件名 ${badName}：${JSON.stringify(govNamingIds)}`
      }
      for (const goodName of ['src/local-issues.mjs', 'src/flow-issues.mjs', 'src/review-pr.mjs', 'src/api/v2/handler.mjs', 'src/staged.mjs', 'docs/specs/261119-issue91-spec.md']) {
        if (govNamingIds.includes(goodName)) return `govern-audit 误报合法文件名 ${goodName}：${JSON.stringify(govNamingIds)}`
      }

      // 3. 反向防误报：词法去噪免疫字面量/正则、pf-allow 锚点、夹具白名单、745 行紧文件、合法业务文件名不阻断、--with-native 安全跳过
      const cleanRes = await runEditGate({
        mode: 'standalone',
        dir,
        files: [
          'src/shared/clean.mjs', 'src/shared/tight.mjs', 'test/fixtures/sample.mjs', 'test/good.test.mjs',
          'src/local-issues.mjs', 'src/flow-issues.mjs', 'src/review-pr.mjs', 'src/api/v2/handler.mjs', 'src/staged.mjs', 'docs/specs/261119-issue91-spec.md',
        ],
        withNative: true,
      })
      if (!cleanRes.ok || cleanRes.exitCode !== 0 || cleanRes.blockers.length > 0) {
        return `edit-gate 干净样本出现误报：${JSON.stringify(cleanRes.blockers)}`
      }
      if (cleanRes.nativeRun?.skipped !== 'no-native-config') {
        return `--with-native 在无原生配置仓未安全跳过：${JSON.stringify(cleanRes.nativeRun)}`
      }
      if (cleanRes.nearLimitFiles.length !== 1 || cleanRes.nearLimitFiles[0].file !== 'src/shared/tight.mjs') {
        return `745 行紧文件未产生 advisory 预警：${JSON.stringify(cleanRes.nearLimitFiles)}`
      }

      // 3b. 对接 flow-lifecycle-hooks.mjs 契约：不传 --changed 仅传 --task <id> --json 仍扫描变动文件
      writeFileSync(join(dir, 'src/shared/clean.mjs'), '// @ts-ignore\nexport const ok = false\n')
      const hookCli = await runAbsAsync('kit/skills/dev-edit/scripts/edit-gate.mjs', ['--dir', dir, '--task', 'c5-hook', '--json'])
      if (hookCli.status !== 3 || !hookCli.stdout.includes('edit.suppression-bypass')) {
        return `edit-gate CLI (--task 无 --changed) 未自动扫描脏文件：status=${hookCli.status}, out=${hookCli.stdout}`
      }

      // 4. --skip-edit-gate 审计与 final 阻断
      const skipNoReason = await runEditGate({ mode: 'verify', dir, skipEditGate: true })
      if (skipNoReason.exitCode !== 2) return `无 reason 的 --skip-edit-gate 未返回 exit 2：${JSON.stringify(skipNoReason)}`
      const skipFinal = await runEditGate({ mode: 'verify', dir, skipEditGate: true, final: true, reason: '赶时间' })
      if (skipFinal.exitCode !== 3) return `--final 下未禁止 --skip-edit-gate：${JSON.stringify(skipFinal)}`
      const skipOk = await runEditGate({ mode: 'verify', dir, skipEditGate: true, reason: '本次只改注释，改码门禁查的是代码结构，跳过它不会漏掉代码问题' })
      if (!skipOk.ok || !skipOk.recorded) return `带 reason 的 --skip-edit-gate 未正常记账：${JSON.stringify(skipOk)}`
      const roots = await resolveRepoRoots(dir)
      const sigs = readSignalsJsonl(roots)
      if (!sigs.events.some((e) => e.pattern === 'edit-gate.skipped')) {
        return `--skip-edit-gate 未写入 signals.jsonl 审计记录：${JSON.stringify(sigs.events)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C6：signals 指纹兼容、labelRes 失败告警、普通审查范围外高危建单与 review-sync 表格无损安全化', async () => {
    const ledgerSrc = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'dev-review', 'scripts', 'review-ledger.mjs'), 'utf8')
    if (/\bwriteTaskLedger\s*\(/.test(ledgerSrc)) {
      return 'review-ledger.mjs 仍残留未迁移的 writeTaskLedger 调用'
    }

    // 1. 表格无损安全化纯函数正反断言（绝不截断原文，仅折行并转义未转义竖线）
    const longCriterion = '（SC5）新增第 6 技能 `dev-edit/` (new) 与 `kit/skills/dev-edit/scripts/edit-gate.mjs` (new)，覆盖全量改码入口并前置集成进 `flow.mjs verify`；基于 `static-gates-lexer.mjs` 剥离注释/字面量后阻断压制注释、墓碑履历、死代码注释、`arch-rules` 越界、单测反作弊及超限文件（完整保留长条款原文绝对不得截断）'
    const rawWithPipeAndNl = `${longCriterion}\n支持 verify|standalone 模式，已转义 \\| 不重复转义`
    const sanitized = sanitizeReviewTableCell(rawWithPipeAndNl)
    if (sanitized.includes('\n') || !sanitized.includes(longCriterion) || !sanitized.includes('verify\\|standalone') || sanitized.includes('\\\\|')) {
      return `sanitizeReviewTableCell 未无损保留全文或竖线转义异常：${sanitized}`
    }
    if (sanitized.length < longCriterion.length) {
      return `sanitizeReviewTableCell 发生截断：len=${sanitized.length} < ${longCriterion.length}`
    }
    const samplePrBody = [
      '### 审核不通过 · Round 1',
      '',
      '#### 验收标准逐条核对',
      '',
      '| 标准 | 状态 | 核对内容与阻塞定位 |',
      '| --- | --- | --- |',
      `| C5 | FAIL | [MF-1] \`src/app.mjs:12\`: ${longCriterion} (verify|standalone) |`,
      '',
      '#### Must Fix（阻塞合入）',
      '',
      `1. **[MF-1] \`src/app.mjs:12\`**：${longCriterion}`,
    ].join('\n')
    const formattedBody = formatReviewCriteriaTable(samplePrBody)
    const tableRow = formattedBody.split('\n').find((l) => l.startsWith('| C5 | FAIL |'))
    if (!tableRow || !tableRow.includes(longCriterion) || !tableRow.includes('verify\\|standalone') || !tableRow.includes('src/app.mjs:12')) {
      return `formatReviewCriteriaTable 未完整保留长条款或未转义竖线：${tableRow}`
    }
    if (!formattedBody.includes(`1. **[MF-1] \`src/app.mjs:12\`**：${longCriterion}`)) {
      return 'formatReviewCriteriaTable 误改了 Must Fix 详情节正文'
    }

    // 2. 端到端仓测试：旧无指纹信号兼容、labelRes 失败可见、普通审查范围外高危自动建单与去重、低危不建单
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c6-demo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n',
      'docs/todo/261119-c6-todo.md': [
        '---', 'kind: todo', 'title: c6', 'status: active', 'created: 2026-11-19', 'updated: 2026-11-19',
        'issue: 1', 'pr: null', 'owner: planner', 'approved: true', 'task_id: c6-t', '---',
        '', '# Todo', '', '<!-- criteria:start -->',
        `- [x] C1: ${longCriterion}`,
        '<!-- criteria:end -->', '',
      ].join('\n'),
      'src/app.mjs': 'export const x = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    try {
      const roots = await resolveRepoRoots(dir)
      // 写入一条旧无指纹历史信号
      const stateDir = resolveGovernStateDir(roots.mainRoot, roots.gitDir, true)
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'signals.jsonl'), `${JSON.stringify({ ts: '2026-01-01T00:00:00Z', category: 'hygiene', module: 'src/auth', pattern: 'hygiene.excuse-suppression', severity: 'medium', message: 'legacy' })}\n`)
      const legacyLoaded = readSignalsJsonl(roots)
      const legEv = legacyLoaded.events[0]
      if (!legEv?.fingerprint || legEv.defectClass !== 'suppression-bypass' || legEv.pyramidTier !== 'tier2-deterministic-gate' || !legEv.virtualFingerprint) {
        return `旧无指纹 signals.jsonl 读时补全失败：${JSON.stringify(legEv)}`
      }

      const startRes = await withQuietIo(() => handleStart({ task: 'c6-t', case: '2', slug: 'c6-t', implementer: 'alice', 'no-issue': true, reason: '回归夹具聚焦倒金字塔复盘升级', json: true }, roots))
      if (startRes.res?.exitCode && startRes.res.exitCode !== 0) {
        return `handleStart 失败：exit=${startRes.res.exitCode}, out=${startRes.out}, err=${startRes.err}`
      }
      await seedExploredFor(dir, 'c6-t')
      const wt = join(dir, '.worktrees', 'impl-c6-t')
      writeFileSync(join(wt, 'src/app.mjs'), 'export const x = 2\n')
      gitCommitFast(wt, 'feat: c6', { updateOnly: true })
      const verRes = await withQuietIo(() => handleVerify({ task: 'c6-t', mode: 'full', json: true }, roots))
      if (verRes.res?.exitCode && verRes.res.exitCode !== 0) {
        return `handleVerify 失败：exit=${verRes.res.exitCode}, out=${verRes.out}, err=${verRes.err}`
      }

      // 普通审查（Round 1 非停损）：包含 2 条重复的高危范围外发现 + 1 条低危存量备注
      const tok = await issueTokenFor(dir, 'c6-t', 1)
      const rec = await withQuietIo(() => handleRecord({
        task: 'c6-t', round: '1', verdict: 'pass', 'reviewer-id': 'rev-1', 'review-token': tok,
        evidence: 'node --test passed (0 fail)',
        'pre-existing': [
          '[high] src/auth/session.mjs:44 token leaked [out-of-scope]',
          '[high] src/auth/session.mjs:44 token leaked [out-of-scope]',
          'minor wording suggestion in README',
        ],
        json: true,
      }, roots))
      if (rec.res !== 0) return `handleRecord 失败：exit=${rec.res}, err=${rec.err}`
      const recJson = JSON.parse(rec.out)
      if ((recJson.escalationPayloads?.length ?? 0) !== 1) {
        return `普通审查范围外高危发现未按指纹去重或误升级低危项：${JSON.stringify(recJson.escalationPayloads)}`
      }
      if ((recJson.escalatedIssues?.length ?? 0) !== 1 || !recJson.escalatedIssues[0]?.ok) {
        return `普通审查范围外高危发现未自动经 escalateToBackend 建单：${JSON.stringify(recJson.escalatedIssues)}`
      }
      const localIssues = listLocalIssues({ mainRoot: dir, gitDir: roots.gitDir }).issues
      if (localIssues.length !== 1 || !localIssues[0].title.includes(`[fp:${recJson.escalationPayloads[0].fingerprint}]`)) {
        return `本地建单数量或指纹标题异常：${JSON.stringify(localIssues)}`
      }

      // 测试 review-sync.mjs labelRes 失败不被忽略 + PR 评论表格压缩
      const failLabelClient = {
        tier: 'gh-cli',
        postComment: async () => ({ ok: true, id: 101, url: 'https://github.com/acme/demo/issues/9#issuecomment-101' }),
        addLabels: async () => ({ ok: false, error: 'HTTP 403 Forbidden (labels)', degraded: true }),
        removeLabel: async () => ({ ok: true }),
      }
      const syncDir = tmpProject({
        '.gitignore': '.worktrees/\n',
        'docs/todo/261119-sync-todo.md': `---\nkind: todo\ntitle: sync\nstatus: active\ncreated: 2026-11-19\nupdated: 2026-11-19\nissue: 9\npr: 10\nowner: alice\n---\n\n<!-- criteria:start -->\n- [x] C5: ${longCriterion}\n<!-- criteria:end -->\n`,
      })
      gitInit(syncDir, { branch: 'main', origin: 'https://github.com/acme/demo.git', name: 'alice', email: 'alice@example.com' })
      try {
        const syncRes = await syncReviewToGitHub({
          mainRoot: syncDir,
          workTreeRoot: syncDir,
          ledger: { taskId: 'sync-t', role: 'maintainer', providerId: 'github', prNumber: 10, linkedIssues: [9], todoFile: 'docs/todo/261119-sync-todo.md', baseSha: 'aaaaaaa' },
          round: 1, verdict: 'pass', headSha: 'bbbbbbb', reviewerId: 'rev-1', implementerId: 'alice',
          stopLoss: false, stopReasons: [], mustFixList: [], shouldFixList: [], preExistingList: [],
          opts: { _ghClient: failLabelClient, _ghProbe: { env: { providerId: 'github', trackB: { tier: 'gh-cli', login: 'alice' } }, client: failLabelClient } },
        })
        if (syncRes.labelSynced !== false || syncRes.fullySynced !== false || (syncRes.labelWarnings?.length ?? 0) === 0 || !String(syncRes.hint ?? '').includes('标签')) {
          return `labelRes 失败漏洞未修复（仍忽略 label 失败）：${JSON.stringify(syncRes)}`
        }
        const prTarget = syncRes.delegatedPayloads?.targets?.find((t) => t.kind === 'pr')
        const prRow = prTarget?.rawBody?.split('\n').find((l) => l.startsWith('| C5 | PASS |'))
        if (!prRow || !prRow.includes(longCriterion)) {
          return `syncReviewToGitHub PR 评论表格未完整保留 C5 原文（发生截断或丢失）：row=${prRow}`
        }
      } finally { rmTree(syncDir) }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C6：严格三层倒金字塔 govern-retro（禁默认写 AGENTS.md、Tier1 去重升格、Tier2 建议、显式 Tier3 与过期清理）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': JSON.stringify({ name: 'retro-demo', version: '1.0.0', scripts: { test: 'node --test', lint: 'echo ok' } }),
      'eslint.config.mjs': 'export default []\n',
      'AGENTS.md': [
        '# retro-demo',
        '',
        '<!-- govern-retro: begin -->',
        '## 治理复盘显式兜底规则（[TIER-3-FALLBACK]，非受管区）',
        '',
        '- [TIER-3-FALLBACK] (fp:deadbeef0001, class:suppression-bypass, expires:2020-01-01) expired legacy prompt rule',
        '<!-- govern-retro: end -->',
        '',
      ].join('\n'),
      'src/state.mjs': 'export const s = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    try {
      const roots = await resolveRepoRoots(dir)
      // 注入 2 次 state-split（应升格 Tier 1）+ 2 次 suppression-bypass（应升格 Tier 2）
      for (let i = 0; i < 2; i += 1) {
        await appendGovernSignal({
          mainRoot: dir, gitDir: roots.gitDir, isGit: true, category: 'review',
          module: 'src/state', pattern: 'review.state-split', ruleId: 'state-split',
          defectClass: 'state-split', file: 'src/state.mjs', taskId: `t-${i + 1}`, message: 'state split detected',
        })
        await appendGovernSignal({
          mainRoot: dir, gitDir: roots.gitDir, isGit: true, category: 'hygiene',
          module: 'src/ui', pattern: 'edit.suppression-bypass', ruleId: 'edit.suppression-bypass',
          defectClass: 'suppression-bypass', file: 'src/ui/a.mjs', taskId: `t-${i + 1}`, message: 'ts-ignore bypass',
        })
      }

      // 1. 默认 retro --apply-patches：清理过时 Tier 3、产出 Tier 1 建单与 Tier 2 建议，绝不新增 AGENTS.md 规则
      const r1 = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['retro', dir, '--apply-patches', '--json'])
      if (r1.status !== 0) return `retro --apply-patches 失败：${r1.stderr}`
      const j1 = JSON.parse(r1.stdout)
      if (!j1.defaultAgentsWriteDisabled || j1.tier1Escalations.length < 1 || j1.tier2Proposals.length < 1 || j1.tier3Fallbacks.length !== 0) {
        return `倒金字塔三层路由异常：${JSON.stringify({ t1: j1.tier1Escalations.length, t2: j1.tier2Proposals.length, t3: j1.tier3Fallbacks.length })}`
      }
      if (j1.staleTier3Entries.length !== 1) return `未检出过期 [TIER-3-FALLBACK] 条款：${JSON.stringify(j1.staleTier3Entries)}`
      const agentsAfter1 = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      if (agentsAfter1.includes('expired legacy prompt rule') || agentsAfter1.includes('govern-retro: begin')) {
        return `默认 retro 未清理过期 Tier 3 或擅自写入 AGENTS.md：\n${agentsAfter1}`
      }
      if (listLocalIssues({ mainRoot: dir, gitDir: roots.gitDir }).issues.length !== 1) {
        return `Tier 1 升格未生成唯一重构单：${JSON.stringify(listLocalIssues({ mainRoot: dir, gitDir: roots.gitDir }).issues)}`
      }

      // 2. 二次运行 --auto 不得对同指纹重复建单；且直调 govern-retro.mjs summary --task t-2 --json（对接 flow-lifecycle-hooks）正常执行
      const r2 = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['retro', dir, '--auto', '--task', 't-2', '--json'])
      if (r2.status !== 0) return `retro --auto 失败：${r2.stderr}`
      const j2 = JSON.parse(r2.stdout)
      if (listLocalIssues({ mainRoot: dir, gitDir: roots.gitDir }).issues.length !== 1 || !j2.tier1EscalationResults.some((x) => x.deduplicated)) {
        return `同指纹 Tier 1 重构单未去重：issues=${listLocalIssues({ mainRoot: dir, gitDir: roots.gitDir }).issues.length}, res=${JSON.stringify(j2.tier1EscalationResults)}`
      }
      const rDirect = await runAbsAsync('kit/skills/dev-govern/scripts/govern-retro.mjs', ['summary', dir, '--task', 't-2', '--json'])
      if (rDirect.status !== 0) return `govern-retro.mjs summary 直调 CLI 失败：${rDirect.stderr}`
      const jDirect = JSON.parse(rDirect.stdout)
      if (!jDirect.defaultAgentsWriteDisabled || !jDirect.auto || jDirect.taskFilter !== 't-2') {
        return `govern-retro.mjs summary 直调输出异常：${rDirect.stdout}`
      }

      // 3. --allow-tier3-fallback 缺 reason 必报错退出 2；带 reason 才写 [TIER-3-FALLBACK]
      const rBadT3 = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['retro', dir, '--allow-tier3-fallback'])
      if (rBadT3.status !== 2) return `无 reason 的 --allow-tier3-fallback 未拦截：exit=${rBadT3.status}`
      const rOkT3 = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['retro', dir, '--apply-patches', '--allow-tier3-fallback', '--reason', 'manual-only UX edge case', '--json'])
      if (rOkT3.status !== 0) return `显式 Tier 3 失败：${rOkT3.stderr}`
      const agentsAfter3 = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      if (!agentsAfter3.includes('[TIER-3-FALLBACK]') || !agentsAfter3.includes('manual-only UX edge case')) {
        return `显式 --allow-tier3-fallback 未写入带标记词条：\n${agentsAfter3}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C7：dev-govern 自动触发（audit --changed --quiet、retro --auto 跨任务聚合与 --skip-govern 记账）', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'AGENTS.md': '# c7-demo\n\n```yaml\nquick-test: exit 0\nfull-test: exit 0\narch-rules: src/ui/** -> src/db/**\n```\n\n## 取舍\n\n- `no-ci`: local\n- `no-tdd`: local\n',
      'src/db/conn.mjs': 'export const db = 1\n',
      'src/ui/ok.mjs': 'export const ok = 1\n',
      'src/ui/legacy.mjs': 'import { db } from "../db/conn.mjs"\nexport const legacy = () => db\n',
    })
    gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })

    try {
      // 1. 干净变动 -> --changed --quiet --strict 绿灯 0 噪声
      const clean = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--changed', '--quiet', '--strict', '--json'])
      if (clean.status !== 0) return `干净仓 --changed --quiet --strict 误报：${clean.stdout} ${clean.stderr}`
      const cj = JSON.parse(clean.stdout)
      if (!cj.ok || cj.findings.length !== 0) return `干净仓 --changed --quiet 结果异常：${clean.stdout}`

      // 2. 改动文件引入高危 arch-rules 违规 -> 仅报变动文件并 exit 1，忽略存量 legacy.mjs
      writeFileSync(join(dir, 'src/ui/ok.mjs'), 'import { db } from "../db/conn.mjs"\nexport const ok = () => db\n')
      const bad = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--changed', '--quiet', '--strict', '--json'])
      if (bad.status !== 1) return `高危变更未阻断 --changed --quiet --strict：exit=${bad.status}, out=${bad.stdout}`
      const bj = JSON.parse(bad.stdout)
      if (!bj.blocked || !bj.findings.some((f) => f.file === 'src/ui/ok.mjs') || bj.findings.some((f) => f.file === 'src/ui/legacy.mjs')) {
        return `--changed --quiet 增量过滤不准：${JSON.stringify(bj.findings)}`
      }

      // 3. --skip-govern 必传实质 reason 且同时写入 govern-state.json 与 signals.jsonl
      const skipFail = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--skip-govern'])
      if (skipFail.status !== 2) return `无 reason 的 --skip-govern 未报错退出 2：${skipFail.status}`
      // 反例：理由非空但只是占位词，同样要拦——只查非空等于给水话留门。
      const skipShallow = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--skip-govern', '--reason', '赶时间'])
      if (skipShallow.status === 0) return '占位词的 --skip-govern 理由被放行了——理由就该是理由'
      if (!/BLOCKED_SHALLOW_OVERRIDE_REASON/.test(skipShallow.stdout + skipShallow.stderr)) {
        return `占位词理由被拒但没说明原因：${skipShallow.stdout}${skipShallow.stderr}`
      }
      const skipOk = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--skip-govern', '--task', 'c7-task', '--reason', '紧急文档修复：只改了一处错别字，治理巡检的检查项不涉及它', '--json'])
      if (skipOk.status !== 0) return `带 reason 的 --skip-govern 失败：${skipOk.stderr}`
      const govState = loadGovernState(dir)
      if (!govState.skips.some((s) => s.taskId === 'c7-task' && String(s.reason ?? '').includes('只改了一处错别字'))) {
        return `--skip-govern 未写入 govern-state.json：${JSON.stringify(govState)}`
      }
      const roots = await resolveRepoRoots(dir)
      if (!readSignalsJsonl(roots).events.some((e) => e.pattern === 'govern.skipped' && e.taskId === 'c7-task')) {
        return '--skip-govern 未写入 signals.jsonl 审计记录'
      }

      // 4. 跨任务 retro --auto：task-a 与 task-b 各出现 1 次同指纹 -> 在 task-b 复盘时累计达到 2 触发升格
      await appendGovernSignal({ mainRoot: dir, gitDir: roots.gitDir, isGit: true, module: 'src/api', pattern: 'edit.arch-boundary', ruleId: 'edit.arch-boundary', defectClass: 'arch-boundary', file: 'src/api/a.mjs', taskId: 'task-a', message: 'cross layer' })
      await appendGovernSignal({ mainRoot: dir, gitDir: roots.gitDir, isGit: true, module: 'src/api', pattern: 'edit.arch-boundary', ruleId: 'edit.arch-boundary', defectClass: 'arch-boundary', file: 'src/api/b.mjs', taskId: 'task-b', message: 'cross layer' })
      const autoRetro = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['retro', dir, '--auto', '--task', 'task-b', '--json'])
      if (autoRetro.status !== 0) return `retro --auto 失败：${autoRetro.stderr}`
      const arj = JSON.parse(autoRetro.stdout)
      if (arj.repeatedFailures.length < 1 || !loadGovernState(dir).lastRetro?.auto) {
        return `retro --auto 未触发跨任务聚合或未落盘检查点：${JSON.stringify(arj.repeatedFailures)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['StageC C8：移除 NON_UNIT_TEST_RE 硬编码、元数据驱动测试分层与小仓零 unfiltered-quick-test 假阳性', async () => {
    const testsSrc = readFileSync(join(SKILL_ROOT, 'kit', 'skills', 'dev-govern', 'scripts', 'govern-tests.mjs'), 'utf8')
    if (/\bNON_UNIT_TEST_RE\b/.test(testsSrc)) {
      return 'govern-tests.mjs 仍残留硬编码 NON_UNIT_TEST_RE 正则'
    }

    // 1. 小型单层仓（含 6 个单测，且目录名带 integration/ 与 load/）：
    //    - 不得误报 tests.unfiltered-quick-test；
    //    - src/integration/parser.test.mjs 中的硬编码 sleep 必须被当成单测检出（不再被路径名机械排除）！
    const smallDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': JSON.stringify({ name: 'small-repo', version: '1.0.0', scripts: { test: 'node --test' } }),
      'AGENTS.md': '# small-repo\n\n```yaml\nquick-test: node --test\nfull-test: npm test\nsmoke-verify: none\nmerge-gate: npm test\n```\n\n## 取舍\n\n- `no-ci`: local\n- `no-tdd`: local\n',
      'src/app.mjs': 'export const ok = 1\n',
      'test/a.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'test/b.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'test/c.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'test/d.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'tests/load/queue.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'src/integration/parser.test.mjs': "import assert from 'node:assert/strict'\nawait new Promise((r) => setTimeout(r, 1500))\nassert.ok(true)\n",
    })
    gitInit(smallDir, { branch: 'main', name: 't', email: 't@t.t' })

    // 2. 多层仓（package.json test:e2e + playwright.config + Go build tag + Pytest marker）
    const multiDir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': JSON.stringify({
        name: 'multi-tier',
        version: '1.0.0',
        scripts: {
          test: 'node --test',
          'test:unit': 'node --test unit-tests',
          'test:e2e': 'playwright test browser-specs',
        },
      }),
      'playwright.config.ts': "export default { testDir: './browser-specs' }\n",
      'pytest.ini': '[pytest]\nmarkers =\n  e2e: end to end tests\n  integration: integration tests\n',
      'go.mod': 'module example.com/demo\n',
      'AGENTS.md': '# multi-tier\n\n```yaml\nquick-test: npm test\nfull-test: npm run test:e2e\nsmoke-verify: none\nmerge-gate: npm run test:e2e\n```\n\n## 取舍\n\n- `no-ci`: local\n- `no-tdd`: local\n',
      'unit-tests/u1.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'unit-tests/u2.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'unit-tests/u3.test.mjs': "import assert from 'node:assert/strict'\nassert.ok(true)\n",
      'browser-specs/checkout.test.mjs': "import { chromium } from '@playwright/test'\nimport assert from 'node:assert/strict'\nawait new Promise((r) => setTimeout(r, 2000))\nawait chromium.launch({ headless: true })\nassert.ok(true)\n",
      'go_int_test.go': '//go:build integration\npackage demo\nimport "testing"\nfunc TestDB(t *testing.T) { if false { t.Fatal("x") } }\n',
      'tests/test_py_e2e.py': '@pytest.mark.e2e\ndef test_flow():\n    import time\n    time.sleep(2)\n    assert True\n',
    })
    gitInit(multiDir, { branch: 'main', name: 't', email: 't@t.t' })

    try {
      const smallAud = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', smallDir, '--categories', 'tests', '--json'])
      if (smallAud.status !== 0) return `smallDir tests 审计失败：${smallAud.stderr}`
      const sj = JSON.parse(smallAud.stdout)
      const sIds = (sj.findings ?? []).map((f) => f.id)
      if (sIds.includes('tests.unfiltered-quick-test')) {
        return `小型单层仓误报 tests.unfiltered-quick-test：${JSON.stringify(sIds)}`
      }
      if (!sIds.includes('tests.hard-sleep.src/integration/parser.test.mjs')) {
        return `移除 NON_UNIT_TEST_RE 后未将 src/integration/parser.test.mjs 按单元测试检出 hard-sleep：${JSON.stringify(sIds)}`
      }

      const meta = detectTestTierMetadata(multiDir)
      if (classifyTestFileTier('browser-specs/checkout.test.mjs', '', meta).tier !== 'e2e') {
        return `未按 playwright.config / test:e2e 元数据识别 e2e 测试：${JSON.stringify(meta)}`
      }
      if (classifyTestFileTier('go_int_test.go', '//go:build integration\npackage demo', meta).tier !== 'integration') {
        return '未识别 Go //go:build integration 构建标签'
      }
      if (classifyTestFileTier('tests/test_py_e2e.py', '@pytest.mark.e2e\ndef test_flow(): pass', meta).tier !== 'e2e') {
        return '未识别 Pytest @pytest.mark.e2e 标记'
      }

      const multiAud = await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', multiDir, '--categories', 'tests', '--json'])
      const mj = JSON.parse(multiAud.stdout)
      const mIds = (mj.findings ?? []).map((f) => f.id)
      if (mIds.includes('tests.hard-sleep.browser-specs/checkout.test.mjs') || mIds.includes('tests.heavy-in-unit.browser-specs/checkout.test.mjs') || mIds.includes('tests.hard-sleep.tests/test_py_e2e.py')) {
        return `元数据识别的 E2E 测试被误报为单测违规：${JSON.stringify(mIds)}`
      }
      if (!mIds.includes('tests.unfiltered-quick-test')) {
        return `多层仓未过滤 quick-test 漏报 tests.unfiltered-quick-test：${JSON.stringify(mIds)}`
      }

      // 切换 quick-test 到 npm run test:unit 后消除 unfiltered-quick-test
      writeFileSync(join(multiDir, 'AGENTS.md'), '# multi-tier\n\n```yaml\nquick-test: npm run test:unit\nfull-test: npm run test:e2e\nsmoke-verify: none\nmerge-gate: npm run test:e2e\n```\n\n## 取舍\n\n- `no-ci`: local\n- `no-tdd`: local\n')
      const multiFixed = JSON.parse((await runAbsAsync('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', multiDir, '--categories', 'tests', '--json'])).stdout)
      if ((multiFixed.findings ?? []).some((f) => f.id === 'tests.unfiltered-quick-test')) {
        return `切换 test:unit 后仍误报 tests.unfiltered-quick-test：${JSON.stringify(multiFixed.findings)}`
      }
      return true
    } finally {
      rmTree(smallDir)
      rmTree(multiDir)
    }
  }])
}

export const registerCases = registerEditPyramidCases
export default registerEditPyramidCases

if (isMainModule(import.meta.url, process.argv[1])) {
  const cases = []
  registerEditPyramidCases(cases)
  ;(async () => {
    let failed = 0
    for (const [name, fn] of cases) {
      try {
        const res = await fn()
        if (res === true) {
          process.stdout.write(`PASS: ${name}\n`)
        } else {
          failed += 1
          process.stderr.write(`FAIL: ${name}\n  ${res}\n`)
        }
      } catch (err) {
        failed += 1
        process.stderr.write(`FAIL: ${name}\n  ${err instanceof Error ? err.stack : String(err)}\n`)
      }
    }
    process.stdout.write(`\nedit-pyramid 夹具汇总：${cases.length - failed} 通过，${failed} 失败。\n`)
    await flushAndExit(failed === 0 ? 0 : 1)
  })()
}
