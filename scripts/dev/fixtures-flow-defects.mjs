/**
 * fixtures-flow-defects.mjs —— 流程缺陷收口的行为断言：跨仓引用保留目标仓、同一阻塞项按定位点判、
 * 两条装配路径同判据、纯文档项目判据、起步首次提交、路径归一、优化循环三通道报出、
 * 合并队列空跑不落盘、未装套件正文降级、审计零目标未适用、外部来源合并回告。
 *
 * 每条判据都配正反双向用例：正例证明改法成立，反例证明不会为了变绿而放宽。
 */

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  gitCommitFast, gitInit, gitSync, rmTree, runAbsAsync, runNode, SKILL_ROOT, tmpProject,
} from './fixtures-helpers.mjs'

const SKILL_CMD_RE = /\.agents[\\/]skills[\\/]/

function makeDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-fd-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

function countSkillCommands(text) {
  return (String(text ?? '').match(SKILL_CMD_RE) ?? []).length
}

export function registerFlowDefectsCases(cases) {
  // ---------------------------------------------------------------------------
  // C2 解析器：摘要里的行号要认得中文写法，否则定位点层在真实摘要上是空的
  // ---------------------------------------------------------------------------

  cases.push(['C2 摘要解析认出「第 N 行」「第N行」「第 N-M 行」「N 行」，path:line 照旧', async () => {
    const { parseMustFixItem } = await import('../../kit/skills/dev-review/scripts/review-locks.mjs')

    const hit = [
      ['kit/skills/lib/git-core.mjs:88 正则只认正斜杠', 'kit/skills/lib/git-core.mjs', 88, 88],
      ['kit/skills/lib/git-core.mjs 第 88 行只认正斜杠', 'kit/skills/lib/git-core.mjs', 88, 88],
      ['kit/skills/lib/git-core.mjs 第88行只认正斜杠', 'kit/skills/lib/git-core.mjs', 88, 88],
      ['kit/skills/lib/git-core.mjs 第 88-90 行区间', 'kit/skills/lib/git-core.mjs', 88, 90],
      ['kit/skills/lib/git-core.mjs 88 行只认正斜杠', 'kit/skills/lib/git-core.mjs', 88, 88],
    ]
    for (const [raw, file, line, endLine] of hit) {
      const r = parseMustFixItem(raw, 0)
      if (r.file !== file) return `「${raw}」文件名取成 ${JSON.stringify(r.file)}，期望 ${file}`
      if (r.line !== line) return `「${raw}」行号取成 ${JSON.stringify(r.line)}，期望 ${line}`
      if (r.endLine !== endLine) return `「${raw}」结束行取成 ${JSON.stringify(r.endLine)}，期望 ${endLine}`
    }

    // 反例：没有行号线索的摘要不许凭空编一个行号出来
    const clean = parseMustFixItem('kit/skills/lib/git-core.mjs 反斜杠路径丢文件与行号', 0)
    if (clean.file !== 'kit/skills/lib/git-core.mjs') return `反例文件名取成 ${JSON.stringify(clean.file)}`
    if (clean.line !== null) return `反例凭空编出行号 ${clean.line}——没写行号就该是 null`

    // 反例：数字出现在别处（不是行号位置）时不许误取
    const notLine = parseMustFixItem('kit/skills/lib/git-core.mjs 覆盖 3 个调用点', 0)
    if (notLine.line !== null) return `「覆盖 3 个调用点」被误取成行号 ${notLine.line}`
    return true
  }])

  // ---------------------------------------------------------------------------
  // C2 同一性：按定位点判，判据编号只排除不认定
  // ---------------------------------------------------------------------------

  cases.push(['C2 同一阻塞项按定位点判：同行/区间相交算同一个，相邻不算，同编号不同行不算', async () => {
    const { parseMustFixItem, sameBlockerItem } = await import('../../kit/skills/dev-review/scripts/review-locks.mjs')
    const p = (s) => parseMustFixItem(s, 0)

    const same = [
      ['同一问题两种措辞都指向同一行（path:line）',
        p('C2: kit/skills/lib/git-core.mjs:88 正则只认正斜杠'),
        p('C2: kit/skills/lib/git-core.mjs:88 反斜杠路径解析出空文件名')],
      ['同一问题两种措辞都写「第 N 行」且指向同一行',
        p('kit/skills/lib/git-core.mjs 第 88 行正则只认正斜杠'),
        p('kit/skills/lib/git-core.mjs 第88行反斜杠解析出空文件名')],
      ['一边 path:line 一边「第 N 行」，解析后行号相等',
        p('kit/skills/lib/git-core.mjs:88 正则只认正斜杠'),
        p('kit/skills/lib/git-core.mjs 第 88 行反斜杠解析出空文件名')],
      ['行区间相交（88-95 与 90-100）',
        p('kit/skills/lib/git-core.mjs 第 88-95 行一段'),
        p('kit/skills/lib/git-core.mjs 第 90-100 行一段')],
    ]
    for (const [label, a, b] of same) {
      if (!sameBlockerItem(a, b)) return `应判同一个但判了不同：${label}`
    }

    const diff = [
      ['相邻但不相交（88 与 89）',
        p('kit/skills/lib/git-core.mjs 第 88 行一处'),
        p('kit/skills/lib/git-core.mjs 第 89 行另一处')],
      ['区间不相交（80-85 与 90-95）',
        p('kit/skills/lib/git-core.mjs 第 80-85 行'),
        p('kit/skills/lib/git-core.mjs 第 90-95 行')],
      ['同文件无行号无判据编号',
        p('kit/skills/lib/git-core.mjs 反斜杠路径丢文件'),
        p('kit/skills/lib/git-core.mjs 正则需归一')],
      ['判据编号相同但行区间不相交（同编号下两条互不相干的缺陷）',
        p('C2: kit/skills/lib/git-core.mjs 第 88 行行号取不到'),
        p('C2: kit/skills/lib/git-core.mjs 第 200 行批量置 resolved')],
      ['两边判据编号不相等（排除条件，连定位点都不看）',
        p('C1: kit/skills/lib/git-core.mjs 第 88 行'),
        p('C2: kit/skills/lib/git-core.mjs 第 88 行')],
    ]
    for (const [label, a, b] of diff) {
      if (sameBlockerItem(a, b)) return `应判不同但判了同一个：${label}`
    }

    // 反例：不得退化成「同文件即同一个」
    if (!diff.slice(0, 1).length) return 'unreachable'
    return true
  }])

  // ---------------------------------------------------------------------------
  // C7 路径归一：反斜杠写法的文件与行号不许丢
  // ---------------------------------------------------------------------------

  cases.push(['C7 反斜杠路径与正斜杠路径解析出同一文件同一行号，URL 与盘符前缀不被吃掉', async () => {
    const { parseMustFixItem } = await import('../../kit/skills/dev-review/scripts/review-locks.mjs')

    const fwd = parseMustFixItem('kit/skills/lib/git-core.mjs:33 只认正斜杠', 0)
    const back = parseMustFixItem('kit\\skills\\lib\\git-core.mjs:33 只认正斜杠', 0)
    if (back.file !== fwd.file) return `反斜杠文件名解析成 ${JSON.stringify(back.file)}，正斜杠是 ${JSON.stringify(fwd.file)}`
    if (back.line !== fwd.line) return `反斜杠行号解析成 ${JSON.stringify(back.line)}，正斜杠是 ${JSON.stringify(fwd.line)}`

    // 反例：URL 里的斜杠不许被当成路径归一的对象
    const url = parseMustFixItem('参考 https://github.com/acme/app/issues/1 这条引用', 0)
    if (/^https?:/i.test(String(url.file ?? ''))) return `URL 被当成文件路径：${url.file}`

    // 反例：显式 file 字段这条路本来就对，改后不得回退
    const explicit = parseMustFixItem('{"file":"kit/skills/lib/git-core.mjs","line":33,"summary":"x"}', 0)
    if (explicit.file !== 'kit/skills/lib/git-core.mjs' || explicit.line !== 33) {
      return `显式 file 字段回退：${JSON.stringify({ file: explicit.file, line: explicit.line })}`
    }
    return true
  }])

  // ---------------------------------------------------------------------------
  // C2 轮次收口三态：整轮通过不等于全部解决，未提及项保持原状态并单列
  // ---------------------------------------------------------------------------

  cases.push(['C2 轮次收口三态：整轮 pass 不再批量置已解决，未提及项保持原状态并单列', async () => {
    const { resolveRepoRoots } = await import('../../kit/skills/lib/shared.mjs')
    const { handleRecord } = await import('../../kit/skills/dev-review/scripts/review-ledger.mjs')
    const { issueTokenFor } = await import('./fixtures-helpers.mjs')

    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'package.json': '{"name":"fd-r3","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      'README.md': '# fd-r3\n',
      'docs/TDD.md': '# TDD\n',
      'src/app.mjs': 'export const ok = 1\n',
    })
    gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
    const ledgerDir = join(dir, '.worktrees', '.state', 'tasks')
    mkdirSync(ledgerDir, { recursive: true })
    writeFileSync(join(ledgerDir, 't-unm.json'), JSON.stringify({ taskId: 't-unm', implementerId: 'author-a', branch: 'main', rounds: [] }, null, 2))

    const quiet = async (fn) => {
      const o = process.stdout.write
      const e = process.stderr.write
      let out = ''
      process.stdout.write = (c) => { out += String(c); return true }
      process.stderr.write = (c) => { out += String(c); return true }
      try { await fn() } finally { process.stdout.write = o; process.stderr.write = e }
      return out
    }

    try {
      const roots = await resolveRepoRoots(dir)
      // 第 1 轮：两条互不相干的阻塞项（同判据编号 C2、同一文件、不同行）
      const tok1 = await issueTokenFor(dir, 't-unm', 1)
      const r1 = await quiet(() => handleRecord({
        task: 't-unm', round: '1', verdict: 'changes',
        evidence: '夹具实测：命令已跑', 'reviewer-id': 'rev-b',
        'review-token': tok1,
        'must-fix': [
          'C2: src/app.mjs:10 行号取不到',
          'C2: src/app.mjs:200 批量置 resolved',
        ],
      }, roots))
      if (!/OK|recorded|resolved/i.test(r1) && r1.length === 0) return 'R1 无输出'

      writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 2\n')
      gitCommitFast(dir, 'fix one', { updateOnly: true })

      // 第 2 轮：未处理历史项时 pass 必被阻断；changes 时不得批量置为 resolved 且未提及项单列
      const tok2Block = await issueTokenFor(dir, 't-unm', 2)
      const passBlocked = await quiet(() => handleRecord({
        task: 't-unm', round: '2', verdict: 'pass',
        evidence: '夹具实测：E2E 观察 OK', 'reviewer-id': 'rev-c',
        'review-token': tok2Block, 'no-enforce-gates': true,
        'e2e-evidence': '夹具实测：页面渲染与交互已观察',
      }, roots))
      if (!passBlocked.includes('BLOCKED_PASS_WITH_OPEN_BLOCKERS')) {
        return `Round 2 未处置历史 Must-Fix 时 pass 未阻断：${passBlocked}`
      }

      const tok2 = await issueTokenFor(dir, 't-unm', 2)
      await quiet(() => handleRecord({
        task: 't-unm', round: '2', verdict: 'changes',
        evidence: '夹具实测：复核增量改动', 'reviewer-id': 'rev-c',
        'review-token': tok2,
      }, roots))

      const ledger = JSON.parse(readFileSync(join(ledgerDir, 't-unm.json'), 'utf8'))
      const r2 = (ledger.rounds ?? []).find((x) => Number(x.round) === 2)
      if (!r2) return '第 2 轮未写入账本'

      // 反例：整轮 pass 不得把历史未终结项批量置为 resolved
      const wronglyResolved = (ledger.rounds ?? [])
        .filter((x) => Number(x.round) < 2)
        .flatMap((x) => x.mustFix ?? [])
        .filter((m) => m.status === 'resolved' && !(r2.resolvedItems ?? []).includes(m.id))
      if (wronglyResolved.length > 0) {
        return `整轮 pass 把未提及项批量置为已解决：${wronglyResolved.map((m) => m.id).join(', ')}`
      }

      // 正例：未提及项必须出现在 unmentionedFromPrev 里，不得静默消失
      const unmentioned = r2.unmentionedFromPrev ?? []
      if (unmentioned.length !== 2) {
        return `未提及项应单列 2 条，实际 ${unmentioned.length} 条：${JSON.stringify(unmentioned)}`
      }

      // 正例：显式 --resolved 才落为已解决
      writeFileSync(join(ledgerDir, 't-res.json'), JSON.stringify({ taskId: 't-res', implementerId: 'author-a', branch: 'main', rounds: [] }, null, 2))
      writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 3\n')
      gitCommitFast(dir, 'prep r2', { updateOnly: true })
      const tokRes1 = await issueTokenFor(dir, 't-res', 1)
      await quiet(() => handleRecord({
        task: 't-res', round: '1', verdict: 'changes',
        evidence: '夹具实测：命令已跑', 'reviewer-id': 'rev-b',
        'review-token': tokRes1,
        'must-fix': ['C1: src/app.mjs:10 空值未检查'],
      }, roots))
      writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 4\n')
      gitCommitFast(dir, 'fix it', { updateOnly: true })
      const tokRes2 = await issueTokenFor(dir, 't-res', 2)
      await quiet(() => handleRecord({
        task: 't-res', round: '2', verdict: 'pass',
        evidence: '夹具实测：E2E 观察 OK', 'reviewer-id': 'rev-c',
        'review-token': tokRes2, 'no-enforce-gates': true,
        'e2e-evidence': '夹具实测：页面渲染与交互已观察',
        resolved: ['C1'],
      }, roots))
      const led2 = JSON.parse(readFileSync(join(ledgerDir, 't-res.json'), 'utf8'))
      const r1items = led2.rounds.find((x) => Number(x.round) === 1)?.mustFix ?? []
      if (!r1items.every((m) => m.status === 'resolved')) {
        return `显式 --resolved 后仍未落为已解决：${JSON.stringify(r1items.map((m) => [m.id, m.status]))}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  // ---------------------------------------------------------------------------
  // C1 跨仓引用保留目标仓：不坍缩成本地同号单
  // ---------------------------------------------------------------------------

  cases.push(['C1 引用保留目标仓：跨仓链接带出 repo，裸号按本地，认不出就进 unknown', async () => {
    const { parseFlowInputs, parseIssueNumbers } = await import('../../kit/skills/lib/github-parse.mjs')

    const url = 'https://github.com/other-org/other-repo/issues/1'
    const flow = parseFlowInputs([url])
    if (flow.issues.length !== 1) return `parseFlowInputs 未解析出 issue：${JSON.stringify(flow)}`
    const ref = flow.issues[0]
    if (ref.repo !== 'other-org/other-repo') return `引用丢了仓库：${JSON.stringify(ref)}`
    if (ref.number !== 1) return `引用编号错：${JSON.stringify(ref)}`
    if (ref.raw !== url) return `引用丢了原文：${JSON.stringify(ref)}`

    // 编号入口对外形状不变（返回数字数组），跨仓引用仍带出同一个编号
    const nums = parseIssueNumbers(url)
    if (!Array.isArray(nums) || nums.length !== 1 || nums[0] !== 1) {
      return `parseIssueNumbers 对外形状变了：${JSON.stringify(nums)}`
    }

    // 反例：裸号 / #N / issue#N 没有仓库，属于明确指向本地
    for (const [token, expected] of [['1', 1], ['#1', 1], ['issue#1', 1]]) {
      const r = parseFlowInputs([token]).issues[0]
      if (!r) return `裸号「${token}」没解析出 issue`
      if (r.repo !== null && r.repo !== undefined) return `裸号「${token}」凭空带了仓库 ${r.repo}`
      if (r.number !== expected) return `裸号「${token}」编号错：${r.number}`
    }

    // 反例：认不出来的输入必须进 unknown，不能静默丢弃
    const unk = parseFlowInputs(['not-a-url-xyz', url])
    if (!unk.unknown.includes('not-a-url-xyz')) return `无法识别的输入被静默丢弃：${JSON.stringify(unk)}`
    if (unk.issues.length !== 1) return `同一批里的合法引用被吞掉了：${JSON.stringify(unk)}`
    return true
  }])

  cases.push(['C1 跨仓引用三态：等于本仓按本地、不等于本仓阻断、本仓不可判定只报出不阻断', async () => {
    const { judgeCrossRepoReference } = await import('../../kit/skills/lib/github-parse.mjs')

    const same = judgeCrossRepoReference({ repo: 'acme/app', targetRepo: 'acme/app', raw: 'https://github.com/acme/app/issues/1' })
    if (same.state !== 'local') return `引用仓等于本仓时应按本地处理：${JSON.stringify(same)}`

    const cross = judgeCrossRepoReference({ repo: 'other-org/other-repo', targetRepo: 'acme/app', raw: 'https://github.com/other-org/other-repo/issues/1' })
    if (cross.state !== 'cross-repo') return `跨仓引用未判成跨仓：${JSON.stringify(cross)}`
    if (!cross.blocked) return `跨仓引用未在写操作前阻断：${JSON.stringify(cross)}`
    if (!/other-org\/other-repo/.test(cross.message ?? '')) return `阻断说明里没写目标仓：${JSON.stringify(cross)}`

    // 反例：无远端仓（targetRepo 为空）时不得阻断，但必须报出引用原文
    const undecidable = judgeCrossRepoReference({ repo: 'other-org/other-repo', targetRepo: null, raw: 'https://github.com/other-org/other-repo/issues/1' })
    if (undecidable.blocked) return `本仓不可判定时不该阻断：${JSON.stringify(undecidable)}`
    if (undecidable.state !== 'undecidable') return `本仓不可判定未单独成一态：${JSON.stringify(undecidable)}`
    if (!String(undecidable.message ?? '').includes('https://github.com/other-org/other-repo/issues/1')) {
      return `不可判定时没报出引用原文：${JSON.stringify(undecidable)}`
    }

    // 反例：裸号不属于跨仓判定对象
    const bare = judgeCrossRepoReference({ repo: null, targetRepo: 'acme/app', raw: '#1' })
    if (bare.state !== 'local') return `裸号不该进跨仓判定：${JSON.stringify(bare)}`
    if (bare.blocked) return `裸号被误阻断：${JSON.stringify(bare)}`
    return true
  }])

  // ---------------------------------------------------------------------------
  // C3 两条入口共用一套解析，无法识别的输入两种模式都报出
  // ---------------------------------------------------------------------------

  cases.push(['C3 flow intake 接受位置参数引用，无法识别的输入在正文与 JSON 两种模式都出现', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# c3-demo\n',
    })
    gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
    try {
      // 正例：位置参数形式的 issue URL 能被分诊接住（改前报「缺少分诊目标」）
      const pos = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['intake', 'https://github.com/other-org/other-repo/issues/7', '--dry-run', '--json'], { cwd: dir })
      const posOut = `${pos.stdout}${pos.stderr}`
      if (/缺少分诊目标/.test(posOut)) return `位置参数形式的引用仍被判成「缺少分诊目标」：${posOut.trim().slice(0, 300)}`
      if (pos.status !== 0) return `位置参数分诊失败：exit=${pos.status} ${posOut.trim().slice(0, 300)}`

      // 反例：真的一个可用输入都没有时，仍然是用法错误
      const none = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['intake', '--dry-run', '--json'], { cwd: dir })
      if (none.status === 0) return '没有任何分诊目标时竟退 0'

      // 无法识别的输入：JSON 与正文两种模式都要出现
      const unkJson = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['inspect', 'not-a-url-xyz', '--json'], { cwd: dir })
      if (unkJson.status !== 0) return `inspect --json 失败：${unkJson.stderr.slice(0, 200)}`
      if (!JSON.parse(unkJson.stdout).inputs.unknown.includes('not-a-url-xyz')) {
        return `JSON 模式丢了无法识别的输入：${unkJson.stdout.slice(0, 300)}`
      }
      const unkText = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['inspect', 'not-a-url-xyz'], { cwd: dir })
      const unkTextOut = `${unkText.stdout}${unkText.stderr}`
      if (!unkTextOut.includes('not-a-url-xyz')) {
        return `正文模式一个字都不提无法识别的输入：${unkTextOut.slice(0, 400)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  // ---------------------------------------------------------------------------
  // C5 纯文档项目的判据：文档不止一份说明文件
  // ---------------------------------------------------------------------------

  cases.push(['C5 纯文档判定：只有说明文件不算文档项目，多一份文档才算', async () => {
    const { survey } = await import('./fixtures-helpers.mjs')

    const onlyReadme = makeDir({ 'README.md': '# only\n\n只有说明文件的目录。\n' })
    const readmePlusDoc = makeDir({ 'README.md': '# two\n\n有说明也有设计文档。\n', 'docs/design-notes.md': '# 设计笔记\n' })
    try {
      const a = await survey(onlyReadme, { probeAuth: false })
      if ((a.ecosystem.kinds ?? []).includes('docs-only')) {
        return `只有一份 README 竟被判成纯文档项目：kinds=${JSON.stringify(a.ecosystem.kinds)}`
      }

      // 反例：真的只有文档的仓库（多份文档）仍必须被判成文档项目，
      // 否则每次勘察都要它写技术设计文档。
      const b = await survey(readmePlusDoc, { probeAuth: false })
      if (!(b.ecosystem.kinds ?? []).includes('docs-only')) {
        return `有 README + 设计笔记却没判成纯文档项目：kinds=${JSON.stringify(b.ecosystem.kinds)}`
      }

      // 判据不得依赖提交数：同一目录两次勘察结论必须一致
      const c = await survey(onlyReadme, { probeAuth: false })
      if (JSON.stringify(a.ecosystem.kinds) !== JSON.stringify(c.ecosystem.kinds)) {
        return '同一目录两次勘察结论不一致（判据不稳定）'
      }
      return true
    } finally { rmTree(onlyReadme); rmTree(readmePlusDoc) }
  }])

  // ---------------------------------------------------------------------------
  // C5 下游：认不出项目类型时，Dev Profile 不得当成「有代码清单」保留占位
  // ---------------------------------------------------------------------------

  cases.push(['C5 下游 Dev Profile：unknown 且零代码文件时收口为 none，有代码文件时保留占位', async () => {
    const { buildDevProfileVars } = await import('../../scripts/lib/agents-defaults.mjs')

    // 正例：认不出项目类型（kinds=['unknown']）且一个代码文件都没有——收口
    for (const kinds of [['unknown'], ['empty'], []]) {
      const p = buildDevProfileVars(
        { ecosystem: { kinds, manifests: [] }, scale: { codeFiles: 0 }, commands: {}, docs: {} },
        null,
      )
      if (p.PROFILE_QUICK_TEST !== 'none') {
        return `kinds=${JSON.stringify(kinds)} 且零代码文件时 quick-test 应为 none，实际 ${JSON.stringify(p.PROFILE_QUICK_TEST)}`
      }
      if (p.PROFILE_ARCH_RULES !== 'none') {
        return `kinds=${JSON.stringify(kinds)} 且零代码文件时 arch-rules 应为 none，实际 ${JSON.stringify(p.PROFILE_ARCH_RULES)}`
      }
      if (p.PROFILE_FILL_HINT) return `kinds=${JSON.stringify(kinds)} 且零代码文件时不该留 fill 提示`
    }

    // 反例：真有代码文件时不得收口——收口等于把该填的命令一律写成 none
    const hasCode = buildDevProfileVars(
      { ecosystem: { kinds: ['unknown'], manifests: [] }, scale: { codeFiles: 5 }, commands: {}, docs: {} },
      null,
    )
    if (hasCode.PROFILE_QUICK_TEST === 'none') {
      return '有 5 个代码文件却把 quick-test 收口成 none——认不出类型不等于没有代码'
    }
    if (!hasCode.PROFILE_FILL_HINT) return '有代码文件、又没有探测到命令时，必须留 fill 提示让人补'

    // 反例：有生态清单时同理
    const hasManifest = buildDevProfileVars(
      { ecosystem: { kinds: ['node'], manifests: ['package.json'], packageScripts: [] }, scale: { codeFiles: 0 }, commands: {}, docs: {} },
      null,
    )
    if (hasManifest.PROFILE_QUICK_TEST === 'none') return '有 package.json 却把 quick-test 收口成 none'
    return true
  }])

  // ---------------------------------------------------------------------------
  // C8 优化循环三个输入通道：丢弃、解析失败、截断都显式报出，且不改变原语义
  // ---------------------------------------------------------------------------

  cases.push(['C8 优化循环三通道：缺摘要的门禁项报出但仍生效，解析失败报出，截断报出实际上限', async () => {
    const { buildCyclePlan, formatCycleText } = await import('../../kit/skills/dev-iterate/scripts/iterate-cycle.mjs')

    // 通道 1：缺摘要的门禁项——报出，但仍按原语义推进（单向门照样触发停损）
    const missingSummary = buildCyclePlan({ pendingGates: [{ kind: 'one-way' }] })
    if (!missingSummary.warnings.some((w) => /没有摘要/.test(w))) {
      return `缺摘要的门禁项没被报出：${JSON.stringify(missingSummary.warnings)}`
    }
    if (missingSummary.pendingGates.length !== 1) {
      return `缺摘要的门禁项被丢弃了（应保留 1 条）：${JSON.stringify(missingSummary.pendingGates)}`
    }
    if (!missingSummary.pendingGates[0].oneWay) return '缺摘要的门禁项丢了单向门标记'
    if (!missingSummary.stopped || missingSummary.stopReason !== 'ONE_WAY_GATE_HIT') {
      return `缺摘要的单向门没有触发停损（报出不得改变语义）：${JSON.stringify(missingSummary.stopReason)}`
    }

    // 通道 2：进度历史解析失败——报出，且不能让零进展停损静默失效
    const badHistory = buildCyclePlan({ progressHistory: 'not-json' })
    if (!badHistory.warnings.some((w) => /不是合法 JSON|进度历史/.test(w))) {
      return `进度历史解析失败没被报出：${JSON.stringify(badHistory.warnings)}`
    }
    if (badHistory.roundsCompleted !== 0) return `解析失败时轮次应为 0，实际 ${badHistory.roundsCompleted}`

    // 通道 3：轮次上限被截断——报出实际上限
    const truncated = buildCyclePlan({ maxRounds: 99 })
    if (truncated.maxRounds !== 10) return `硬上限没生效：maxRounds=${truncated.maxRounds}`
    if (!truncated.warnings.some((w) => /超过硬上限/.test(w))) {
      return `轮次被截断却没报出：${JSON.stringify(truncated.warnings)}`
    }

    // 反例：合法输入不得被报成告警（报出不等于到处报红）
    const clean = buildCyclePlan({ maxRounds: 3, progressHistory: [{ round: 1, observed: 2, passed: 1 }], pendingGates: ['普通门禁'] })
    if (clean.warnings.length !== 0) return `合法输入被误报成告警：${JSON.stringify(clean.warnings)}`
    if (clean.stopped) return '合法输入被误判停损'

    // 正文排版也得把告警打出来，不能只留在 JSON 里
    const text = formatCycleText(truncated)
    if (!/Warning\s*:/.test(text)) return `正文没打印告警：${text.slice(0, 200)}`
    return true
  }])

  // ---------------------------------------------------------------------------
  // C9 合并队列：零工作量不落盘，有队列时照常落盘
  // ---------------------------------------------------------------------------

  cases.push(['C9 合并队列零工作量不落盘，已有条目时即使未处理完也照常落盘', async () => {
    const dir = tmpProject({
      '.gitignore': '.worktrees/\n',
      'README.md': '# c9-demo\n',
    })
    gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
    const gitDir = join(dir, '.git')
    const statePath = join(gitDir, 'project-forge-flow', 'merge-queue.json')
    try {
      // 正例：空跑一次不得凭空写出状态文件
      const emptyRun = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['batch', 'merge-queue', '--json'], { cwd: dir })
      if (emptyRun.status !== 0) return `空跑 merge-queue 失败：exit=${emptyRun.status} ${emptyRun.stderr.slice(0, 200)}`
      if (existsSync(statePath)) {
        return `零入队零待处理却写出了状态文件：${readFileSync(statePath, 'utf8').slice(0, 120)}`
      }
      if (!/"skippedWrite"/.test(emptyRun.stdout)) {
        return `空跑没有报「未写状态文件」：${emptyRun.stdout.slice(0, 200)}`
      }

      // 反例：真入队时必须照常落盘
      const enq = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['batch', 'merge-queue', '--enqueue', 'c9-one', '--enqueue-only', '--json'], { cwd: dir })
      if (enq.status !== 0) return `入队失败：exit=${enq.status} ${enq.stderr.slice(0, 200)}`
      if (!existsSync(statePath)) return '入队之后仍没写状态文件'
      const afterEnq = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!Array.isArray(afterEnq.queue) || !afterEnq.queue.includes('c9-one')) {
        return `入队结果没落盘：${JSON.stringify(afterEnq).slice(0, 200)}`
      }

      // 反例：队列已有条目、本次一个都没处理成——也不叫空跑，必须照常落盘并留下历史
      const before = readFileSync(statePath, 'utf8')
      const blocked = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['batch', 'merge-queue', '--json'], { cwd: dir })
      if (blocked.status === 0) return '队列里有处理不了的任务时不该退 0'
      if (!existsSync(statePath)) return '队列有内容时把状态文件删了'
      const afterBlocked = JSON.parse(readFileSync(statePath, 'utf8'))
      if (!Array.isArray(afterBlocked.queue) || afterBlocked.queue.length === 0) {
        return `队列已有条目却在处理后清空了：${JSON.stringify(afterBlocked).slice(0, 200)}`
      }
      if (JSON.stringify(JSON.parse(before).queue) !== JSON.stringify(afterBlocked.queue)) {
        return `未处理成的条目被从队列里弄丢了：before=${before.slice(0, 100)} after=${JSON.stringify(afterBlocked.queue)}`
      }
      return true
    } finally { rmTree(dir) }
  }])

  // ---------------------------------------------------------------------------
  // C10 正文与提示同一降级：未装套件时 7 处命令一次收口
  // ---------------------------------------------------------------------------

  cases.push(['C10 未装套件时正文与提示都不出现套件命令，已装套件时正文仍打印命令', async () => {
    const { buildSessionOrientation } = await import('../../kit/skills/lib/session-orient.mjs')
    const { resolveAvailableSkills } = await import('../../kit/skills/lib/cli.mjs')

    // 正例：未装配 .agents/skills/ 的目录
    const bare = makeDir({ 'README.md': '# bare\n\n未装套件的目录。\n' })
    try {
      const o = buildSessionOrientation(bare)
      const hits = (o.text.match(/\.agents\/skills/g) ?? []).length
      if (hits !== 0) {
        const sample = o.text.split('\n').filter((l) => l.includes('.agents/skills')).slice(0, 3).join(' | ')
        return `未装套件的正文仍打印套件命令（${hits} 处）：${sample}`
      }
      // 降级不是「把话说少」：被替换的行仍要指向一个可执行的动作类别
      const degraded = o.text.split('\n').filter((l) => /未装配/.test(l))
      if (degraded.length === 0) return `降级后正文没有给出替代做法：${o.text.slice(0, 300)}`
      const actionWords = /git|原生|手动|按|执行|提交|切换|查看|人工/
      for (const line of degraded) {
        if (!actionWords.test(line)) return `降级后这一行看不出要做什么：${line}`
        if (/^\s*(?:dev-[a-z-]+)\s*$/.test(line)) return `降级后只剩技能名没有动作：${line}`
      }
      // 结构化字段保留原值：那是给程序用的，不经降级
      if (o.docLocateHints.some((h) => !/\.agents\/skills/.test(h))) {
        return `结构化字段 docLocateHints 被降级了（应保留原值）：${JSON.stringify(o.docLocateHints.slice(0, 2))}`
      }
    } finally { rmTree(bare) }

    // 反例：已装配套件的目录里，正文照旧打印套件命令——不能一刀切全降级
    const { KIT_SKILLS } = await import('../../scripts/lib/protocol.mjs')
    const assembledFiles = { 'README.md': '# assembled\n' }
    for (const s of KIT_SKILLS) {
      assembledFiles[`.agents/skills/${s}/SKILL.md`] = `---\nname: ${s}\n---\n`
      assembledFiles[`.agents/skills/${s}/scripts/x.mjs`] = '// stub\n'
    }
    const assembled = makeDir(assembledFiles)
    try {
      if (!resolveAvailableSkills(assembled).hasSkillsDir) return '夹具没造出已装配形态'
      const o2 = buildSessionOrientation(assembled)
      const hits2 = (o2.text.match(/\.agents\/skills/g) ?? []).length
      if (hits2 === 0) return `已装套件的正文把命令也降级了（应保留）：${o2.text.slice(0, 300)}`
    } finally { rmTree(assembled) }
    return true
  }])

  // ---------------------------------------------------------------------------
  // C13 回告写失败的判定：未成功即未发出，且必须给出补发命令
  // ---------------------------------------------------------------------------

  cases.push(['C13 回告写失败判为未发出：ok!==true 即未发出，转交宿主代理不算发出', async () => {
    const { judgeCommentOutcome } = await import('../../kit/skills/dev-flow/scripts/flow-merge.mjs')

    // 正例：真写成功
    const ok = judgeCommentOutcome({ ok: true })
    if (!ok.ok) return `ok:true 竟被判未发出：${JSON.stringify(ok)}`

    // 反例之一：后端没有直连凭据时返回「未成功 + 已转交」——这不是发出去了
    const delegated = judgeCommentOutcome({ ok: false, delegated: true, tier: 'mcp-delegate' })
    if (delegated.ok) return `「已转交宿主代理」被当成发出去了：${JSON.stringify(delegated)}`
    if (!/转交/.test(delegated.reason ?? '')) return `未说明原因是被转交：${JSON.stringify(delegated)}`

    // 反例之二：后端不支持该方法
    const skipped = judgeCommentOutcome({ ok: false, skipped: true, reason: 'client-unsupported' })
    if (skipped.ok) return `「后端不支持」被当成发出去了：${JSON.stringify(skipped)}`

    // 反例之三：返回 undefined / null 也不许当成功（裸 await 拿到的就是这类值）
    for (const v of [undefined, null, {}]) {
      if (judgeCommentOutcome(v).ok) return `${JSON.stringify(v)} 被判成发出去了——空返回值不能当成功`
    }
    return true
  }])

  // ---------------------------------------------------------------------------
  // C6 起步落首次提交 + 零提交时勘察不写完成态
  // ---------------------------------------------------------------------------

  cases.push(['C6 起步落首次提交，零提交的仓库勘察报「尚未首次提交」而不是已就绪', async () => {
    const { survey, computeArtifactPlan } = await import('../../scripts/survey.mjs')

    // 正例：起步流程自己创建的仓库必须有首次提交
    const boot = makeDir()
    try {
      const res = await runAbsAsync('scripts/equip.mjs', [boot, '--bootstrap-empty', '--name', 'c6-demo', '--no-backup'], {})
      if (res.status !== 0) return `bootstrap-empty 失败：exit=${res.status} ${String(res.stderr).slice(0, 200)}`
      const trackCount = (gitSync(boot, ['ls-files'], { encoding: 'utf8' }).stdout ?? '').trim().split('\n').filter(Boolean).length
      if (trackCount === 0) return '起步后 git ls-files 为空（文件全在 ?? 里）'
      const logRes = gitSync(boot, ['log', '--oneline'], { encoding: 'utf8' })
      if (logRes.status !== 0) return `起步后 git log 报错（没有首次提交）：${String(logRes.stderr).slice(0, 160)}`
      const head = (gitSync(boot, ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout ?? '').trim()
      if (!head) return '起步后拿不到 HEAD'
    } finally { rmTree(boot) }

    // 反例之一：零提交的仓库，勘察不得把它报成「已就绪」
    const zero = makeDir({ '.gitattributes': '* text=auto\n', '.gitignore': 'node_modules/\n', 'README.md': '# zero\n' })
    gitInit(zero, { branch: 'main', commit: false })
    try {
      const facts = await survey(zero, { probeAuth: false })
      const plan = computeArtifactPlan(facts)
      const item = (plan.items ?? plan).find((a) => a.id === 'git-baseline')
      if (!item) return '勘察没给出 git 基线这一项'
      if (item.status === '已就绪') return `零提交却报「已就绪」：${JSON.stringify(item)}`
      if (!/尚未首次提交/.test(item.status)) return `零提交的结论不是「尚未首次提交」：${item.status}`
    } finally { rmTree(zero) }

    // 反例之二：用户手动初始化、零提交不是缺陷——不因此把仓库判失败
    const manual = makeDir({ '.gitattributes': '* text=auto\n', '.gitignore': 'node_modules/\n', 'README.md': '# manual\n' })
    gitInit(manual, { branch: 'main', commit: false })
    try {
      const facts = await survey(manual, { probeAuth: false })
      if (facts.errors?.length > 0) return `零提交的手工目录被勘察判错：${JSON.stringify(facts.errors)}`
    } finally { rmTree(manual) }
    return true
  }])

  // ---------------------------------------------------------------------------
  // C4 两条装配路径读同一份逐文件判定
  // ---------------------------------------------------------------------------

  cases.push(['C4 校验路径与写入路径对同一份工作区给出相同状态与相同退出码，拒绝必带修法', async () => {
    const dir = makeDir({ 'README.md': '# c4\n\n装配路径测试仓。\n' })
    try {
      gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
      // 干净装配：两条路径都退 0
      const first = await runAbsAsync('scripts/equip.mjs', [dir, '--no-backup'], {})
      if (first.status !== 0) return `干净仓首次装配失败：exit=${first.status} ${String(first.stderr).slice(0, 200)}`
      const cleanCheck = await runAbsAsync('scripts/equip.mjs', [dir, '--check'], {})
      if (cleanCheck.status !== 0) return `干净仓 --check 未退 0：exit=${cleanCheck.status}`

      // 造「本地已改且上游未变」：改一份受管文件，上游不变
      const target = join(dir, '.agents', 'skills', 'dev-flow', 'SKILL.md')
      writeFileSync(target, '---\nname: dev-flow\ndescription: 本地改过的版本\n---\n\n# 改过\n')

      const checkRes = await runAbsAsync('scripts/equip.mjs', [dir, '--check'], {})
      const writeRes = await runAbsAsync('scripts/equip.mjs', [dir, '--no-backup'], {})
      if (checkRes.status === 0) return '本地改动被保留时 --check 竟然退 0'
      if (writeRes.status === 0) return '本地改动被保留时写入路径竟然退 0'
      if (checkRes.status !== writeRes.status) {
        return `两条路径退出码不一致：check=${checkRes.status} write=${writeRes.status}`
      }

      // 拒绝必带修法：说明三种合法处置
      const report = `${checkRes.stdout}${checkRes.stderr}`
      if (!/本地已改且上游未变/.test(report)) return `校验报告没写清状态：${report.slice(0, 300)}`
      if (!/修法/.test(report)) return `校验报告没给修法：${report.slice(0, 300)}`
      for (const hint of ['--restore', '--adopt-custom']) {
        if (!report.includes(hint)) return `修法里少了 ${hint} 这条处置：${report.slice(0, 400)}`
      }

      // 反例：登记为定制之后，同样的改动不再算待处置
      const adopt = await runAbsAsync('scripts/equip.mjs', [dir, '--adopt-custom', 'dev-flow/SKILL.md', '--no-backup'], {})
      if (adopt.status !== 0) return `--adopt-custom 失败：exit=${adopt.status} ${String(adopt.stderr).slice(0, 200)}`
      const afterAdopt = await runAbsAsync('scripts/equip.mjs', [dir, '--check'], {})
      if (afterAdopt.status !== 0) return `登记定制后 --check 仍退非零：exit=${afterAdopt.status} ${String(afterAdopt.stderr).slice(0, 300)}`
      return true
    } finally { rmTree(dir) }
  }])

  cases.push(['C4b --check 精确区分「上游已更新」「双端均有修改」「本地已改且上游未变」', async () => {
    const dir = makeDir({ 'README.md': '# c4b\n' })
    const v1Kit = makeDir()
    const v2Kit = makeDir()
    try {
      cpSync(join(SKILL_ROOT, 'kit', 'skills'), v1Kit, { recursive: true })
      cpSync(v1Kit, v2Kit, { recursive: true })
      gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })

      const initRes = await runAbsAsync('scripts/equip.mjs', [dir, '--kit-dir', v1Kit, '--no-backup'], {})
      if (initRes.status !== 0) return `v1 首次装配失败：exit=${initRes.status} ${String(initRes.stderr).slice(0, 200)}`

      // 1) 正例 UPSTREAM_AHEAD：仅上游更新 dev-explore/SKILL.md，本地未改
      const v2Explore = join(v2Kit, 'dev-explore', 'SKILL.md')
      writeFileSync(v2Explore, `${readFileSync(v2Explore, 'utf8')}\n# upstream-v2\n`)
      const upCheck = await runAbsAsync('scripts/equip.mjs', [dir, '--check', '--kit-dir', v2Kit], {})
      if (upCheck.status !== 3) return `UPSTREAM_AHEAD --check 退出码应为 3，实际=${upCheck.status}`
      const upReport = `${upCheck.stdout}${upCheck.stderr}`
      if (!/上游已更新（本地未改）/.test(upReport) || !upReport.includes('equip.mjs')) {
        return `UPSTREAM_AHEAD 报告缺少状态或升级指引：${upReport.slice(0, 300)}`
      }
      if (/本地已改且上游未变/.test(upReport)) {
        return `未改本地文件竟被误判为「本地已改且上游未变」：${upReport.slice(0, 300)}`
      }

      // 2) 正例 BOTH_MODIFIED + 3) 反例 LOCAL_AHEAD
      const localEdit = join(dir, '.agents', 'skills', 'dev-edit', 'SKILL.md')
      writeFileSync(localEdit, `${readFileSync(localEdit, 'utf8')}\n# local-edit\n`)
      const v2Edit = join(v2Kit, 'dev-edit', 'SKILL.md')
      writeFileSync(v2Edit, `${readFileSync(v2Edit, 'utf8')}\n# upstream-edit\n`)
      const localReview = join(dir, '.agents', 'skills', 'dev-review', 'SKILL.md')
      writeFileSync(localReview, `${readFileSync(localReview, 'utf8')}\n# local-review\n`)

      const mixCheck = await runAbsAsync('scripts/equip.mjs', [dir, '--check', '--kit-dir', v2Kit], {})
      if (mixCheck.status !== 3) return `混合状态 --check 退出码应为 3，实际=${mixCheck.status}`
      const mixReport = `${mixCheck.stdout}${mixCheck.stderr}`
      if (/本地已改且上游未变：dev-explore\/SKILL\.md/.test(mixReport)) {
        return `dev-explore/SKILL.md 被误判为 LOCAL_AHEAD：${mixReport.slice(0, 400)}`
      }
      if (!/双端均有修改（待三方合并）：dev-edit\/SKILL\.md/.test(mixReport)) {
        return `BOTH_MODIFIED 未正确报出 dev-edit/SKILL.md：${mixReport.slice(0, 400)}`
      }
      if (!/本地已改且上游未变：dev-review\/SKILL\.md/.test(mixReport) || !mixReport.includes('--restore') || !mixReport.includes('--adopt-custom')) {
        return `LOCAL_AHEAD 未按预期报出 dev-review/SKILL.md 及修法：${mixReport.slice(0, 400)}`
      }
      return true
    } finally { rmTree(dir); rmTree(v1Kit); rmTree(v2Kit) }
  }])

  cases.push(['C11 审计零目标输出未适用且退出码非零，有受管文档全通过时仍退零', async () => {
    const empty = makeDir()
    try {
      const res = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', empty])
      const out = `${res.stdout}${res.stderr}`
      if (res.status === 0) return `空目录审计退 0，照旧把「一份都没查」当成通过：${out.trim()}`
      if (!/未适用/.test(out)) return `空目录审计没说不适用：${out.trim()}`
      if (/全部通过/.test(out)) return `空目录审计仍说全部通过：${out.trim()}`
    } finally { rmTree(empty) }

    // 反例：有受管文档且全部通过时仍必须「全部通过」且退 0
    const withDoc = makeDir({
      'src/app.mjs': 'export const ok = 1\n',
      'docs/specs/261120-ok-spec.md': [
        '---', 'kind: spec', 'title: OK', 'status: draft', 'owner: arch-1', 'approved: false', '---', '',
        '# SPEC: OK', '', '## 要解决的问题', '- 更新 `src/app.mjs` 导出。', '', '## 本期不做', '- 不改 `src/app.mjs` 之外模块。', '',
        '## 门型与回滚路径', '- two-way；git revert', '', '- [ ] C1: `node -e "process.exit(0)"` c1', '',
      ].join('\n'),
    })
    try {
      const res = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', withDoc])
      const out = `${res.stdout}${res.stderr}`
      if (res.status !== 0) return `有受管文档且全通过时退了 ${res.status}：${out.trim()}`
      if (!/全部通过/.test(out)) return `有受管文档且全通过时没说全部通过：${out.trim()}`
    } finally { rmTree(withDoc) }
    return true
  }])
}
