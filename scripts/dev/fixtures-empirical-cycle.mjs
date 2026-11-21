/**
 * fixtures-empirical-cycle.mjs —— 工具无关结构化实证（C1/C2）、PoC 先行建单（C3）
 * 与有界优化循环（C4）的正反双向断言。
 *
 * 自动被 `scripts/dev/fixtures.mjs` 发现（域 `empirical-cycle`）。
 */

import { EXIT } from '../../kit/skills/lib/exit-codes.mjs'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  ARTIFACT_MAX_BYTES, SYNTHETIC_OBSERVATION_TEXTS, artifactPathsOf,
  evaluateObservationSubstance, evaluateStoredVisualEvidence, formatArtifactEvidenceLines,
  mergeArtifactRecords, normalizeArtifactRecords, precheckVisualAndArtifacts, summarizeArtifactRecords,
  validateArtifactsAndVisual,
} from '../../kit/skills/lib/empirical-artifacts.mjs'
import {
  REPRO_EVIDENCE_MAX_CHARS, buildEscalationIssuePayload,
  normalizeReproEvidence, validateReproEvidenceFields,
} from '../../kit/skills/lib/escalation.mjs'
import { hydratePrTemplateBody } from '../../kit/skills/lib/pr-template-hydrate.mjs'
import {
  DEFAULT_MAX_ROUNDS, HARD_MAX_ROUNDS, STOP_REASONS,
  buildCyclePlan, computeRoundProgress, detectStopLoss,
  normalizeMaxRounds, normalizePendingGates, normalizeProgressHistory,
  trailingZeroProgressRounds,
} from '../../kit/skills/dev-iterate/scripts/iterate-cycle.mjs'
import { validateVerificationEvidence, validateVerifyPrecheck } from '../../kit/skills/lib/workflow-policy.mjs'
import { resolveRepoRoots } from '../../kit/skills/lib/git.mjs'
import {
  createDefaultLedger, ensureReviewToken, readTaskLedger, updateTaskLedger,
} from '../../kit/skills/lib/ledger.mjs'
import { handleRecord } from '../../kit/skills/dev-review/scripts/review-ledger.mjs'
import { resolveReviewObservationInputs } from '../../kit/skills/dev-review/scripts/review-empirical-state.mjs'
import { gitInit, rmTree, runAbs, tmpProject } from './fixtures-helpers.mjs'

function makeRepo() {
  const dir = tmpProject({
    'README.md': '# empirical\n',
    'artifacts/report.json': '{"ok":true}\n',
    'artifacts/empty.txt': '',
    'artifacts/nested/keep.txt': 'x\n',
  })
  return dir
}

/** 静音收集 CLI 输出，供直接调用 `handleRecord` 的断言使用。 */
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

export function registerEmpiricalCycleCases(cases) {
  cases.push(['C1：实证附件必须真实存在、是常规文件且非空，元数据登记为 relPath/bytes/sha256Prefix/capturedAt', async () => {
    const dir = makeRepo()
    try {
      const okRes = normalizeArtifactRecords({ repoRoot: dir, artifacts: ['artifacts/report.json'] })
      if (!okRes.ok || okRes.records.length !== 1) return `合法附件未被接收：${JSON.stringify(okRes)}`
      const rec = okRes.records[0]
      if (rec.relPath !== 'artifacts/report.json' || !(rec.bytes > 0)) return `附件元数据字段不符：${JSON.stringify(rec)}`
      if (!/^[0-9a-f]{12}$/.test(rec.sha256Prefix)) return `sha256Prefix 不是 12 位十六进制：${rec.sha256Prefix}`
      if (!rec.capturedAt || Number.isNaN(Date.parse(rec.capturedAt))) return `capturedAt 非 ISO 时间：${rec.capturedAt}`

      const missing = normalizeArtifactRecords({ repoRoot: dir, artifacts: ['artifacts/nope.png'] })
      if (missing.ok || missing.code !== 'BLOCKED_ARTIFACT_MISSING') return `缺失附件未阻断：${JSON.stringify(missing)}`
      const isDir = normalizeArtifactRecords({ repoRoot: dir, artifacts: ['artifacts/nested'] })
      if (isDir.ok || isDir.code !== 'BLOCKED_ARTIFACT_IS_DIRECTORY') return `目录被当作附件放行：${JSON.stringify(isDir)}`
      const empty = normalizeArtifactRecords({ repoRoot: dir, artifacts: ['artifacts/empty.txt'] })
      if (empty.ok || empty.code !== 'BLOCKED_ARTIFACT_EMPTY') return `0 字节空文件未阻断：${JSON.stringify(empty)}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C1：多值 --artifact 归一化、去重与合并，渲染出相对路径+字节数+指纹的实证清单', async () => {
    const dir = makeRepo()
    try {
      const paths = artifactPathsOf({ artifact: ['artifacts/report.json', ' artifacts/report.json , artifacts/nested/keep.txt '] })
      if (paths.length !== 3) return `--artifact 多值解析异常：${JSON.stringify(paths)}`
      const recs = normalizeArtifactRecords({ repoRoot: dir, artifacts: paths })
      if (!recs.ok || recs.records.length !== 2) return `重复附件未去重：${JSON.stringify(recs.records)}`

      const merged = mergeArtifactRecords(
        [{ relPath: 'artifacts/report.json', bytes: 1, sha256Prefix: 'aaaaaaaaaaaa', capturedAt: '2026-01-01T00:00:00.000Z' }],
        recs.records,
      )
      if (merged.length !== 2) return `合并后条目数不符：${merged.length}`
      const hit = merged.find((r) => r.relPath === 'artifacts/report.json')
      if (hit.capturedAt === '2026-01-01T00:00:00.000Z') return '合并未以最新一次记录为准'

      const lines = formatArtifactEvidenceLines({
        records: merged,
        visual: { required: true, uiFiles: ['src/App.tsx'], satisfiedBy: 'artifacts' },
      }).join('\n')
      if (!lines.includes('artifacts/report.json') || !lines.includes('| 实证附件 | 字节数 | 校验指纹 |')) {
        return `PR 实证表未渲染附件清单：\n${lines}`
      }
      if (!lines.includes('视觉与交互核验') || !lines.includes('src/App.tsx')) return `PR 实证表缺少视觉核验行：\n${lines}`
      const summary = summarizeArtifactRecords(merged)
      if (!summary.includes('report.json(')) return `附件摘要格式异常：${summary}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C1：verify 前置预检拒绝坏附件且不写入 evidence.json，合法附件才落账并绑定 HEAD', async () => {
    const dir = makeRepo()
    const evidencePath = join(dir, 'evidence.json')
    try {
      const bad = precheckVisualAndArtifacts({
        repoRoot: dir, evidencePath, headSha: 'c'.repeat(40), artifacts: ['artifacts/empty.txt'],
      })
      if (bad.ok) return '前置预检未拦下 0 字节空附件'
      if (existsSync(evidencePath)) return '坏附件被写进了 evidence.json'

      const good = precheckVisualAndArtifacts({
        repoRoot: dir, evidencePath, headSha: 'c'.repeat(40),
        artifacts: ['artifacts/report.json'], visualFilesChanged: ['src/App.tsx'],
        observationSummary: '打开首页确认浅色主题下卡片无截断、深色主题下文字对比度足够，控制台无报错',
      })
      if (!good.ok || !good.recorded) return `合法附件未落账：${JSON.stringify(good)}`
      const written = JSON.parse(readFileSync(evidencePath, 'utf8'))
      if (!Array.isArray(written.artifacts) || written.artifacts.length !== 1) return `evidence.json 附件未登记：${JSON.stringify(written)}`
      if (written.visual?.headSha !== 'c'.repeat(40)) return `视觉实证未绑定 HEAD：${JSON.stringify(written.visual)}`

      const gate = validateVerifyPrecheck({
        repoRoot: dir, headSha: 'c'.repeat(40), policy: { visualFilesChanged: ['src/App.tsx'] },
        visualCheckedRaw: true, artifacts: [],
      })
      if (gate.ok) return 'validateVerifyPrecheck 未把裸 --visual-checked 挡下'
      if (gate.code !== 'BLOCKED_VISUAL_EVIDENCE_REQUIRED') return `阻断码不符：${gate.code}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C1：PR 验证表按四种证据形态如实渲染——有附件、只有观察、环境阻塞、什么都没有，且绝不在无附件时声称已附附件', async () => {
    const head = 'd'.repeat(40)
    const ui = ['src/App.tsx']
    const render = (evidence, extra = {}) => hydratePrTemplateBody({
      repoRoot: null,
      taskId: 'render-probe',
      ledger: { taskId: 'render-probe', caseType: 3, branch: 'feat/render', lastVerifyExitCode: 0, verifiedHead: head, ...(extra.ledger ?? {}) },
      policy: { riskTier: 'medium', highRiskHits: [], oneWayBoundaryHits: [] },
      evidence: { gates: { full: { cmd: 'node test.mjs', exitCode: EXIT.OK, durationMs: 10 } }, ...evidence },
      currentHead: head,
      changedFiles: [...ui],
      visualFilesChanged: [...ui],
      ...(extra.rest ?? {}),
    })

    // ① 有真实附件：只能说「已附真实非空实证附件」，并列出附件表。
    const withArtifacts = render({ artifacts: [{ relPath: 'shots/dark.png', bytes: 20, sha256Prefix: 'aaaaaaaaaaaa' }] }, {
      rest: { visualVerifiedOnHead: true },
    })
    if (!withArtifacts.includes('已附真实非空实证附件')) return `有附件时未声明已附附件：\n${withArtifacts}`
    if (!withArtifacts.includes('| 实证附件 | 字节数 | 校验指纹 |') || !withArtifacts.includes('shots/dark.png')) {
      return `有附件时未渲染附件表：\n${withArtifacts}`
    }

    // ② 只有观察：渲染观察原文，不得出现「已附附件」。
    const obsText = '在预览环境打开列表页，浅色与深色主题下卡片均无截断，翻页交互后数据刷新正常'
    const withObs = render({ visual: { required: true, headSha: head, observation: obsText } }, { rest: { visualVerifiedOnHead: true } })
    if (!withObs.includes(obsText)) return `只有观察时未渲染观察原文：\n${withObs}`
    if (withObs.includes('已附真实非空实证附件')) return `只有观察却声称已附附件：\n${withObs}`

    // ③ 环境阻塞：披露待人工核验，不得出现「已附附件」。
    const blockedReason = '当前环境无图形会话，无法启动界面渲染进程；改由人工或有界面节点复核'
    const withBlocked = render({ visual: { required: true, headSha: head, blockedReason } }, { rest: { visualVerifiedOnHead: true } })
    if (!withBlocked.includes('环境阻塞待人工或带界面节点核验')) return `环境阻塞未披露：\n${withBlocked}`
    if (withBlocked.includes('已附真实非空实证附件')) return `环境阻塞却声称已附附件：\n${withBlocked}`

    // ④ 什么都没有（这正是 flow verify 的真实产出形态）：不得声称已附附件，也不得伪造观察。
    const empty = render({}, { rest: { visualVerifiedOnHead: true } })
    if (empty.includes('已附真实非空实证附件')) return `无任何证据却声称已附附件（MF-1 回归）：\n${empty}`
    if (!empty.includes('需人工复核') && !empty.includes('尚未提供实证附件或观察记录')) {
      return `无任何证据时未如实披露：\n${empty}`
    }
    if (empty.includes('| 实证附件 | 字节数 | 校验指纹 |')) return `无附件时却渲染了附件表：\n${empty}`

    // ⑤ 账本里存着真实观察：应作为 observation 渲染出来，而不是丢掉原文去说「已核验」。
    const ledgerObs = '独立审查在预览节点打开结算页，确认深色主题下按钮对比度足够且无横向滚动'
    const fromLedger = render({}, { ledger: { visualCheckEvidence: ledgerObs }, rest: { visualVerifiedOnHead: true } })
    if (!fromLedger.includes(ledgerObs)) return `账本观察原文未渲染：\n${fromLedger}`

    // ⑥ 纯函数层同口径：satisfiedBy=artifacts 但无记录时必须回落到「尚未提供」。
    const lines = formatArtifactEvidenceLines({
      records: [],
      visual: { required: true, uiFiles: ui, satisfiedBy: 'artifacts', observation: '', blockedReason: '' },
    }).join('\n')
    if (lines.includes('已附真实非空实证附件')) return `formatArtifactEvidenceLines 在无记录时仍声称已附附件：\n${lines}`
    if (!lines.includes('尚未提供实证附件或观察记录')) return `无记录时未回落到诚实文案：\n${lines}`
    return true
  }])

  cases.push(['C2：触及 UI_VISUAL_EXT_RE 时裸 --visual-checked 被阻断，须有真附件、实质观察或显式环境阻塞说明', async () => {
    const dir = makeRepo()
    try {
      const ui = ['src/App.tsx']
      const bare = validateArtifactsAndVisual({ repoRoot: dir, visualFilesChanged: ui, visualCheckedRaw: true })
      if (bare.ok || bare.code !== 'BLOCKED_VISUAL_EVIDENCE_REQUIRED') return `裸 --visual-checked 未被阻断：${JSON.stringify(bare)}`
      if (bare.visual.satisfiedBy !== null) return `裸开关竟被记为已满足：${JSON.stringify(bare.visual)}`
      if (!bare.reason.includes('--artifact') || !bare.reason.includes('--visual-blocked-reason')) {
        return `阻断说明未给出两条真实出路：${bare.reason}`
      }

      const legacy = validateArtifactsAndVisual({
        repoRoot: dir, visualFilesChanged: ui, visualCheckedRaw: true,
        observationSummary: SYNTHETIC_OBSERVATION_TEXTS[0],
      })
      if (legacy.ok || legacy.code !== 'BLOCKED_VISUAL_EVIDENCE_REQUIRED') return `旧式硬编码确认串仍被放行：${JSON.stringify(legacy)}`

      const withArtifact = validateArtifactsAndVisual({
        repoRoot: dir, visualFilesChanged: ui, visualCheckedRaw: true, artifacts: ['artifacts/report.json'],
      })
      if (!withArtifact.ok || withArtifact.visual.satisfiedBy !== 'artifacts') return `真附件未放行：${JSON.stringify(withArtifact)}`

      const withObs = validateArtifactsAndVisual({
        repoRoot: dir, visualFilesChanged: ui, visualCheckedRaw: true,
        observationSummary: '渲染首页后确认浅色/深色两套主题下卡片无截断，输入框聚焦态边框可见，控制台零报错',
      })
      if (!withObs.ok || withObs.visual.satisfiedBy !== 'observation') return `实质观察未放行：${JSON.stringify(withObs)}`

      const blocked = validateArtifactsAndVisual({
        repoRoot: dir, visualFilesChanged: ui, visualCheckedRaw: false,
        visualBlockedReason: '当前环境无图形会话，无法启动界面渲染进程；改由人工或有界面节点复核',
      })
      if (!blocked.ok || blocked.visual.satisfiedBy !== 'blocked') return `显式环境阻塞未诚实记录：${JSON.stringify(blocked)}`

      const noUi = validateArtifactsAndVisual({
        repoRoot: dir, visualFilesChanged: [], visualCheckedRaw: true,
      })
      if (!noUi.ok) return `未触及界面资源时不应触发视觉判据：${JSON.stringify(noUi)}`

      if (!(ARTIFACT_MAX_BYTES > 0)) return 'ARTIFACT_MAX_BYTES 未定义'
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C2：submit 阶段核对已落账实证——旧式确认串与「声明了却没证据」都阻断，未声明时交给既有门禁', async () => {
    const head = 'a'.repeat(40)
    const policy = { riskTier: 'medium', visualFilesChanged: ['src/App.tsx'] }

    const unclaimed = evaluateStoredVisualEvidence({ evidence: { gates: {} }, policy, headSha: head })
    if (!unclaimed.ok || !unclaimed.unclaimed) return `未声明核验时不应由本判据阻断：${JSON.stringify(unclaimed)}`

    const placeholder = evaluateStoredVisualEvidence({
      evidence: { gates: {}, visualVerifiedHead: head, visualCheckEvidence: SYNTHETIC_OBSERVATION_TEXTS[2] },
      policy, headSha: head,
    })
    if (placeholder.ok || placeholder.code !== 'BLOCKED_VISUAL_EVIDENCE_PLACEHOLDER') {
      return `旧式独立审查确认串未阻断：${JSON.stringify(placeholder)}`
    }

    const claimedNoProof = evaluateStoredVisualEvidence({
      evidence: { gates: {}, visual: { required: true, headSha: head, satisfiedBy: null } },
      policy, headSha: head,
    })
    if (claimedNoProof.ok || claimedNoProof.code !== 'BLOCKED_VISUAL_EVIDENCE_REQUIRED') {
      return `声明了核验却无证据未阻断：${JSON.stringify(claimedNoProof)}`
    }

    const withArtifact = evaluateStoredVisualEvidence({
      evidence: { gates: {}, artifacts: [{ relPath: 'shots/dark.png', bytes: 12, sha256Prefix: 'bbbbbbbbbbbb', capturedAt: '2026-01-01' }] },
      policy, headSha: head,
    })
    if (!withArtifact.ok || withArtifact.satisfiedBy !== 'artifacts') return `已登记真附件仍被阻断：${JSON.stringify(withArtifact)}`

    const withObs = evaluateStoredVisualEvidence({
      evidence: { gates: {}, visual: { required: true, headSha: head, observation: '在预览环境打开列表页，浅色与深色主题下均无重叠遮挡，翻页交互后数据刷新正常' } },
      policy, headSha: head,
    })
    if (!withObs.ok) return `已登记实质观察仍被阻断：${JSON.stringify(withObs)}`

    const stale = evaluateStoredVisualEvidence({
      evidence: { gates: {}, visual: { required: true, headSha: 'b'.repeat(40), observation: '上一个 HEAD 的渲染观察记录' } },
      policy, headSha: head,
    })
    if (stale.ok || stale.code !== 'BLOCKED_VISUAL_EVIDENCE_STALE') return `跨 HEAD 的旧观察未阻断：${JSON.stringify(stale)}`

    const noUiPolicy = { riskTier: 'medium', visualFilesChanged: [] }
    const noUi = evaluateStoredVisualEvidence({ evidence: { gates: {} }, policy: noUiPolicy, headSha: head })
    if (!noUi.ok || !noUi.unclaimed) return `无界面变更时不应触发视觉判据：${JSON.stringify(noUi)}`

    const gate = validateVerificationEvidence({
      policy: { riskTier: 'medium', requiredGates: ['full'], visualFilesChanged: ['src/App.tsx'] },
      evidence: {
        headSha: head, dirty: false, exitCode: EXIT.OK,
        gates: { full: { headSha: head, exitCode: EXIT.OK, executed: true, succeeded: true, dirty: false } },
        visualVerifiedHead: head,
        visualCheckEvidence: SYNTHETIC_OBSERVATION_TEXTS[1],
      },
      headSha: head,
    })
    if (gate.ok) return 'validateVerificationEvidence 未拦下旧式硬编码视觉核验结论'
    return true
  }])

  cases.push(['C2：观察文本实质判据拒绝占位水话与旧串，接受具体渲染观察', async () => {
    const ok = evaluateObservationSubstance('打开结算页确认金额与明细一致，深色主题下按钮对比度清晰、无横向滚动')
    if (!ok.ok) return `实质观察被误判：${JSON.stringify(ok)}`
    for (const bad of ['', '   ', 'lgtm', '已验证', 'ok', 'pass', ...SYNTHETIC_OBSERVATION_TEXTS]) {
      const res = evaluateObservationSubstance(bad)
      if (res.ok) return `敷衍观察「${bad}」被放行`
    }
    return true
  }])

  cases.push(['C3：escalation 建单接收可选 reproEvidence 与 pocCommand，且不绑定任何具体扫描器工具名', async () => {
    const payload = buildEscalationIssuePayload({
      title: '同步失败',
      summary: '本地同步命令退出码 2',
      caseType: 3,
      files: ['src/a.mjs', 'src/b.mjs'],
      severity: 'high',
      reproEvidence: ['exit=2', 'stderr=connection refused'],
      pocCommand: 'node  scripts/dev/repro.mjs   --case sync',
    })
    if (payload.reproEvidence !== 'exit=2；stderr=connection refused') return `reproEvidence 未归一化：${payload.reproEvidence}`
    if (payload.pocCommand !== 'node scripts/dev/repro.mjs --case sync') return `pocCommand 未压平空白：${payload.pocCommand}`
    if (!payload.body.includes('- 最小复现：exit=2')) return `建单正文缺少最小复现：\n${payload.body}`
    if (!payload.body.includes('- 复现命令：`node scripts/dev/repro.mjs --case sync`')) return `建单正文缺少可重放命令：\n${payload.body}`

    const absent = buildEscalationIssuePayload({ title: '无复现', summary: 'x', caseType: 3 })
    if (absent.reproEvidence !== undefined || absent.pocCommand !== undefined) return '未提供时不应当凭空补字段'
    if (absent.body.includes('最小复现') || absent.body.includes('复现命令')) return '未提供复现证据时正文不应出现空段'

    const long = 'x'.repeat(REPRO_EVIDENCE_MAX_CHARS + 1)
    const vBad = validateReproEvidenceFields({ reproEvidence: long })
    if (vBad.ok || vBad.errors.length === 0) return '超长 reproEvidence 未报错'
    const vOk = validateReproEvidenceFields({ reproEvidence: 'exit=1', pocCommand: 'node repro.mjs' })
    if (!vOk.ok) return `合法复现字段被误判：${JSON.stringify(vOk)}`

    // 校验必须真的接线到建单链路：超长字段被截断、标注截断、并带出警告，不能原样写进正文。
    const overflowPayload = buildEscalationIssuePayload({ title: '超长复现', summary: 'x', caseType: 3, reproEvidence: long })
    if (overflowPayload.reproEvidence === long) return '超长 reproEvidence 被原样写进建单正文（validateReproEvidenceFields 未接线）'
    if (overflowPayload.reproEvidence.length > REPRO_EVIDENCE_MAX_CHARS) return `截断后仍超限：${overflowPayload.reproEvidence.length}`
    if (!overflowPayload.reproEvidence.endsWith('（已截断）')) return `截断后未标注截断：${overflowPayload.reproEvidence.slice(-10)}`
    if (overflowPayload.reproTruncated !== true || !overflowPayload.reproWarnings?.length) {
      return `截断未在载荷上留痕：${JSON.stringify({ t: overflowPayload.reproTruncated, w: overflowPayload.reproWarnings })}`
    }
    if (overflowPayload.body.includes(long)) return '超长 reproEvidence 仍被整段抄进建单正文'
    const cleanPayload = buildEscalationIssuePayload({ title: '正常复现', summary: 'x', caseType: 3, reproEvidence: 'exit=1' })
    if (cleanPayload.reproTruncated !== undefined) return '未超限时不应标记截断'

    const normalized = normalizeReproEvidence({ reproEvidence: ['a'], pocCommand: ['b', 'c'] })
    if (normalized.pocCommand !== 'b && c') return `数组形态 pocCommand 未拼接：${normalized.pocCommand}`
    return true
  }])

  cases.push(['C2：审查记录阶段的 --e2e-evidence 与 --visual-blocked-reason 都过实质判据，占位理由被拒而不是静默丢弃', async () => {
    const okObs = resolveReviewObservationInputs({ 'e2e-evidence': '实跑 node test.mjs 输出 12 项通过 0 失败，退出码 0' })
    if (!okObs.ok || !okObs.e2eText) return `合法 E2E 观察被误判：${JSON.stringify(okObs)}`

    const waterE2e = resolveReviewObservationInputs({ 'e2e-evidence': 'lgtm' })
    if (waterE2e.ok || waterE2e.field !== 'e2e-evidence') return `水话 E2E 观察未被拒：${JSON.stringify(waterE2e)}`

    const waterBlocked = resolveReviewObservationInputs({ 'visual-blocked-reason': 'ok' })
    if (waterBlocked.ok || waterBlocked.field !== 'visual-blocked-reason') return `占位阻塞理由未被拒：${JSON.stringify(waterBlocked)}`

    const realBlocked = resolveReviewObservationInputs({
      'visual-blocked-reason': '当前环境无图形会话，无法启动界面渲染进程；改由人工或有界面节点复核',
    })
    if (!realBlocked.ok || !realBlocked.blockedReasonText) return `真实的阻塞理由被误判：${JSON.stringify(realBlocked)}`

    const legacyBlocked = resolveReviewObservationInputs({ 'visual-blocked-reason': SYNTHETIC_OBSERVATION_TEXTS[1] })
    if (legacyBlocked.ok) return '旧式硬编码确认串被当成合法阻塞理由'

    // 经真实 CLI 走一遍 record：参数必须被读到，不能注册了却不消费。
    const dir = makeRepo()
    try {
      gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
      const roots = await resolveRepoRoots(dir)
      await updateTaskLedger(dir, 'obs-t', () => createDefaultLedger({
        taskId: 'obs-t', caseType: 2, role: 'maintainer', providerId: 'github', branch: 'fix/obs',
        implementerId: 'impl-x', verifiedHead: 'e'.repeat(40), lastVerifyExitCode: 0,
      }), { createIfMissing: true })
      const token = ensureReviewToken(dir, readTaskLedger(dir, 'obs-t'), 1).token

      const water = await withQuietIo(() => handleRecord({
        task: 'obs-t', round: '1', verdict: 'changes', 'reviewer-id': 'rev-y', 'review-token': token,
        evidence: 'ran node test.mjs', 'visual-blocked-reason': 'ok', json: true,
      }, roots))
      if (water.res !== 3) return `占位 --visual-blocked-reason 未经 CLI 阻断：exit=${water.res} out=${water.stdout}`

      const goodBlocked = '当前环境无图形会话，无法启动界面渲染进程；改由人工或有界面节点复核'
      const accepted = await withQuietIo(() => handleRecord({
        task: 'obs-t', round: '1', verdict: 'changes', 'reviewer-id': 'rev-y', 'review-token': token,
        evidence: 'ran node test.mjs', 'visual-blocked-reason': goodBlocked, json: true,
      }, roots))
      if (accepted.res !== 0) return `真实阻塞理由未经 CLI 放行：exit=${accepted.res} out=${accepted.stdout} err=${accepted.stderr}`
      const ledgerAfter = readTaskLedger(dir, 'obs-t')
      if (!String(ledgerAfter.visualBlockedReason ?? '').includes('当前环境无图形会话')) {
        return `--visual-blocked-reason 未被写入账本（注册了却不消费）：${ledgerAfter.visualBlockedReason}`
      }
      // 阻塞说明落自己的字段；证据字段只写真实观察，两者不共用。
      if (ledgerAfter.visualCheckEvidence) {
        return `阻塞说明被当成了观察证据：${ledgerAfter.visualCheckEvidence}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C4：cycle 四阶段编排只读，默认 3 轮、硬上限 10 轮', async () => {
    const plan = buildCyclePlan({ goal: '验证有界循环编排' })
    if (plan.goal !== '验证有界循环编排') return `goal 未透传：${plan.goal}`
    if (plan.maxRounds !== DEFAULT_MAX_ROUNDS || plan.maxRounds !== 3) return `默认轮次不是 3：${plan.maxRounds}`
    if (plan.hardMaxRounds !== HARD_MAX_ROUNDS || plan.hardMaxRounds !== 10) return `硬上限不是 10：${plan.hardMaxRounds}`
    if (plan.phases.join('>') !== 'observe>poc-escalate>fix-verify>reflect') return `四阶段顺序异常：${plan.phases.join('>')}`
    if (plan.stages.length !== 4) return `阶段编排条数不是 4：${plan.stages.length}`
    if (plan.readOnly !== true || plan.mutatesSource !== false) return 'cycle 未声明只读'
    if (!plan.policy.includes('dev-plan -> dev-edit -> dev-review')) return `未声明不跳过正流：${plan.policy}`
    if (plan.stopped) return '空历史不应停损'

    if (normalizeMaxRounds(0) !== DEFAULT_MAX_ROUNDS) return 'maxRounds=0 未回落默认值'
    if (normalizeMaxRounds('abc') !== DEFAULT_MAX_ROUNDS) return 'maxRounds 非数字未回落默认值'
    if (normalizeMaxRounds(99) !== HARD_MAX_ROUNDS) return 'maxRounds 未截到硬上限'
    if (normalizeMaxRounds(4) !== 4) return '合法 maxRounds 被改动'
    return true
  }])

  cases.push(['C4：三条硬停损——轮次上限、连续两轮零进展、单向门，均输出 stopped 与 stopReason', async () => {
    const roundLimit = buildCyclePlan({ goal: 'g', maxRounds: 2, progressHistory: [
      { round: 1, observed: 3, passed: 2 }, { round: 2, observed: 4, passed: 3 },
    ] })
    if (!roundLimit.stopped || roundLimit.stopReason !== STOP_REASONS.ROUND_LIMIT) return `轮次上限未停损：${JSON.stringify(roundLimit)}`
    if (roundLimit.nextRound !== null || roundLimit.stages.length !== 0) return '轮次上限后仍给了下一轮编排'

    const stall = buildCyclePlan({ goal: 'g', maxRounds: 5, progressHistory: [
      { round: 1, observed: 5, passed: 3 }, { round: 2, observed: 5, passed: 3 }, { round: 3, observed: 5, passed: 3 },
    ] })
    if (!stall.stopped || stall.stopReason !== STOP_REASONS.NO_PROGRESS) return `零进展未停损：${JSON.stringify(stall)}`
    if (!stall.stalled) return '停滞标记未置位'

    const oneWay = buildCyclePlan({ goal: 'g', pendingGates: [{ kind: 'one-way', summary: '公共接口签名冻结' }] })
    if (!oneWay.stopped || oneWay.stopReason !== STOP_REASONS.ONE_WAY) return `单向门未停损：${JSON.stringify(oneWay)}`

    const progressing = buildCyclePlan({ goal: 'g', maxRounds: 5, progressHistory: [
      { round: 1, observed: 5, passed: 3 }, { round: 2, observed: 6, passed: 4 },
    ] })
    if (progressing.stopped) return `有进展时误停损：${JSON.stringify(progressing)}`
    if (progressing.nextRound !== 3) return `下一轮编号异常：${progressing.nextRound}`

    const mixed = buildCyclePlan({ goal: 'g', maxRounds: 5, progressHistory: [
      { round: 1, observed: 5, passed: 3 }, { round: 2, observed: 5, passed: 3 }, { round: 3, observed: 6, passed: 3 },
    ] })
    if (mixed.stopped) return `仅一轮零进展不应停损：${JSON.stringify(mixed)}`

    const empty = detectStopLoss({ maxRounds: 3, roundProgress: [], pendingGates: [], nextRound: 1 })
    if (empty.stopped) return '空历史 detectStopLoss 误报'

    const gates = normalizePendingGates([{ kind: 'two-way', summary: '普通取舍' }])
    if (gates[0].oneWay) return 'two-way 门禁被误判为单向门'
    const wayGates = normalizePendingGates(['接口冻结需人工拍板'])
    if (wayGates.length !== 1 || !wayGates[0].oneWay) return `中文 one-way 标记未识别：${JSON.stringify(wayGates)}`
    return true
  }])

  cases.push(['C4：进度历史归一化按轮次排序并算净增量，尾部零进展计数只数连续的尾巴', async () => {
    const history = normalizeProgressHistory(JSON.stringify([
      { round: 3, observed: 5, passed: 3 },
      { round: 1, observed: 2, passed: 1 },
      { round: 2, observed: 4, passed: 2 },
    ]))
    if (history.map((r) => r.round).join(',') !== '1,2,3') return `进度历史未按轮次排序：${history.map((r) => r.round).join(',')}`
    const progress = computeRoundProgress(history)
    if (progress.map((p) => p.progress).join(',') !== '3,3,2') return `净增量计算异常：${progress.map((p) => p.progress).join(',')}`
    if (trailingZeroProgressRounds(progress) !== 0) return '有进展时不应计零进展'

    const dead = computeRoundProgress(normalizeProgressHistory([
      { round: 1, observed: 1, passed: 1 },
      { round: 2, observed: 1, passed: 1 },
    ]))
    if (trailingZeroProgressRounds(dead) !== 1) return `尾部零进展计数异常：${trailingZeroProgressRounds(dead)}`
    if (normalizeProgressHistory('not-json').length !== 0) return '非法 JSON 未安全降级为空历史'
    if (normalizeProgressHistory([{ round: 1, observed: -5, passed: 'x' }])[0].observed !== 0) return '负数/非数字计数未归零'
    return true
  }])

  cases.push(['C4：cycle 子命令经真实 CLI 输出结构化 JSON，停损时退出码 4 且不改动工作区', async () => {
    const script = 'kit/skills/dev-iterate/scripts/iterate.mjs'

    const ok = runAbs(script, ['cycle', '--goal', '验证有界循环编排', '--json'])
    if (ok.status !== 0) return `cycle 正常路径退出码异常：${ok.status} ${ok.stderr}`
    const okPlan = JSON.parse(ok.stdout)
    if (okPlan.readOnly !== true || okPlan.phases.length !== 4) return `cycle JSON 结构缺失：${ok.stdout.slice(0, 200)}`

    const capped = runAbs(script, ['cycle', '--goal', 'g', '--max-rounds', '99', '--json'])
    if (JSON.parse(capped.stdout).maxRounds !== HARD_MAX_ROUNDS) return 'CLI 未把 maxRounds 截到硬上限'

    const stopped = runAbs(script, [
      'cycle', '--goal', 'g', '--pending-gates', JSON.stringify([{ kind: 'one-way', summary: '接口冻结' }]), '--json',
    ])
    if (stopped.status !== 4) return `停损时退出码不是 4：${stopped.status}`
    if (JSON.parse(stopped.stdout).stopReason !== STOP_REASONS.ONE_WAY) return `停损原因不符：${stopped.stdout}`

    const dir = makeRepo()
    try {
      const before = runAbs(script, ['cycle', '--dir', dir, '--goal', '只读核对', '--json'])
      if (before.status !== 0) return `cycle --dir 退出码异常：${before.status} ${before.stderr}`
      mkdirSync(join(dir, 'artifacts', 'cycle'), { recursive: true })
      writeFileSync(join(dir, 'artifacts', 'cycle', 'marker.txt'), 'x\n', 'utf8')
      const after = runAbs(script, ['cycle', '--dir', dir, '--goal', '只读核对', '--json'])
      if (after.stdout.trim() !== before.stdout.trim()) return 'cycle 输出依赖可写状态，未保持只读'
      return true
    } finally { rmTree(dir) }
  }])
}
