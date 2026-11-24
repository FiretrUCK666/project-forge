import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitCommitFast, gitInit, gitSync, issueTokenFor, loadPreflight,
  readDirRefs, rmTree, runAbsAsync, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'


/** 文档规则：渲染、三态、分组、判据冻结与认节。 */
export function registerDocRuleCases(cases) {
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

cases.push(['算不出来不等于算出来没问题：catch 分支不得返回与「成功」同形的值', async () => {
  const source = readFileSync(join(SKILL_ROOT, 'scripts', 'lib', 'review-helpers.mjs'), 'utf8')
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

cases.push(['1:N 切片 SPEC 从 C4+ 起始允许 audit 与 approve，缺少 C<N> 验收条目仍拦截', async () => {
  const s1Bare = [
    '---', 'kind: spec', 'title: Slice1', 'status: approved', 'tier: L3',
    'created: 2026-11-18', 'updated: 2026-11-18', 'issue: 11', 'owner: planner',
    'approved: true', 'plan_critique: passed (reviewer=critic-a, round=1)',
    'related_prd: ../prd/261118-issue10-master-prd.md', 'task_id: s1', 'scope_files: [src/app.mjs]', 'depends_on: []', '---', '',
    '# SPEC: Slice1', '', '## 要解决的问题', '- 落地第 1 批（C1..C3），修改 `src/app.mjs`。', '',
    '## 本期不做', '- 不含第 2 批模块。', '', '## 验收标准', '',
    '- [ ] C1: `node src/app.mjs` slice 1a',
    '- [ ] C2: `node src/app.mjs` slice 1b',
    '- [ ] C3: `node src/app.mjs` slice 1c', '',
  ].join('\n')
  const { critiqueTextFingerprint: fpS1 } = await import('../../kit/skills/lib/critique-rounds.mjs')
  const s1RealSha = fpS1(s1Bare)
  const dir = tmpProject({
    'src/app.mjs': 'export const ok = 1\n',
    'docs/prd/261118-issue10-master-prd.md': [
      '---', 'kind: prd', 'title: Master', 'status: active', 'created: 2026-11-18',
      'updated: 2026-11-18', 'issue: 10', 'owner: planner', 'multi_spec: true', '---', '',
      '# PRD: Master', '', '## 要解决的问题', '- 拆成多个独立切片交付，统一更新 `src/app.mjs`。', '',
      '## 本期不做', '- 不改外部公共接口或 `node src/app.mjs` 入口参数。', '', '## 验收标准', '',
      '- [ ] C1: `node src/app.mjs` slice 1a',
      '- [ ] C2: `node src/app.mjs` slice 1b',
      '- [ ] C3: `node src/app.mjs` slice 1c',
      '- [ ] C4: `node src/app.mjs` slice 2a',
      '- [ ] C5: `node src/app.mjs` slice 2b', '',
    ].join('\n'),
    'docs/specs/261118-issue11-s1-spec.md': s1Bare.replace(
      'plan_critique: passed (reviewer=critic-a, round=1)',
      `plan_critique: passed (reviewer=critic-a, round=1, sha=${s1RealSha})`,
    ),
    'docs/specs/261118-issue12-s2-spec.md': [
      '---', 'kind: spec', 'title: Slice2', 'status: draft', 'tier: L3',
      'created: 2026-11-18', 'updated: 2026-11-18', 'issue: 12', 'owner: planner',
      'approved: false', 'plan_critique: pending',
      'related_prd: ../prd/261118-issue10-master-prd.md', 'task_id: s2', 'scope_files: [src/app.mjs]', 'depends_on: [s1]', '---', '',
      '# SPEC: Slice2', '', '## 要解决的问题', '- 落地第 2 批（C4..C5），需修改 `src/app.mjs`。', '',
      '## 本期不做', '- 不碰第 1 批模块 `src/app.mjs` 的旧导出。', '', '## 验收标准', '',
      '- [ ] C4: `node src/app.mjs` slice 2a 退出码为 0',
      '- [ ] C5: `node src/app.mjs` slice 2b 退出码为 0', '',
    ].join('\n'),
  })
  try {
    // 正向：从 C4 起始的 1:N 切片 SPEC 经 audit 与 critique-pass 后必须允许 approve
    const s2 = 'docs/specs/261118-issue12-s2-spec.md'
    const repoAudit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '.', '--json'], { cwd: dir })
    if (repoAudit.status !== 0) return `1:N 切片仓库 audit 失败：${repoAudit.stdout}\n${repoAudit.stderr}`
    const crit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'critique-pass', '--file', s2, '--reviewer', 'indep-critic', '--round', '1', '--json',
    ], { cwd: dir })
    if (crit.status !== 0) return `从 C4 起始切片 critique-pass 失败：${crit.stderr}`
    const app = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', s2, '--json'], { cwd: dir })
    if (app.status !== 0) return `从 C4 起始切片 approve 被拒：${app.stderr}`
    const appJson = JSON.parse(app.stdout)
    if (appJson.status !== 'approved' || appJson.criteriaCount !== 2) {
      return `approve 返回状态或条目数不对：${app.stdout}`
    }

    // 反向 1：既无验收标准节也无 - [ ] C<N>: 的 SPEC 必须被 audit 与 approve 同时拦下
    const noSectionRel = 'docs/specs/261118-issue13-nocrit-spec.md'
    writeFileSync(join(dir, noSectionRel), [
      '---', 'kind: spec', 'title: NoCrit', 'status: draft', 'tier: L3',
      'created: 2026-11-18', 'updated: 2026-11-18', 'issue: 13', 'owner: planner',
      'related_prd: ../prd/261118-issue10-master-prd.md', '---', '',
      '# SPEC: NoCrit', '', '## 要解决的问题', '- 修复 `src/app.mjs`。', '',
      '## 本期不做', '- 不改外部接口。', '', '- [ ] 跑通 `node src/app.mjs`', '',
    ].join('\n'))
    const badAudit = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', noSectionRel, '--json'], { cwd: dir })
    if (badAudit.status === 0 || !JSON.parse(badAudit.stdout).errors.some((e) => e.code === 'MISSING_ACCEPTANCE_CRITERIA')) {
      return `缺验收条目的 SPEC 竟通过了 audit：${badAudit.stdout}`
    }
    const badApprove = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', noSectionRel], { cwd: dir })
    if (badApprove.status === 0 || !/BLOCKED_AUDIT_FAILED/.test(badApprove.stderr)) {
      return `缺验收条目的 SPEC 竟被 approve 放行：${badApprove.stderr}`
    }

    // 反向 2：即使带了验收标准标题但缺少 - [ ] C<N>: 编号条目，approve 仍必须拒绝
    const noCidRel = 'docs/specs/261118-issue14-noid-spec.md'
    writeFileSync(join(dir, noCidRel), [
      '---', 'kind: spec', 'title: NoCid', 'status: draft', 'tier: L3',
      'created: 2026-11-18', 'updated: 2026-11-18', 'issue: 14', 'owner: planner',
      'related_prd: ../prd/261118-issue10-master-prd.md', '---', '',
      '# SPEC: NoCid', '', '## 要解决的问题', '- 修复 `src/app.mjs`。', '',
      '## 本期不做', '- 不改外部接口。', '', '## 验收标准', '',
      '- [ ] 仅写描述而不写 C 编号', '',
    ].join('\n'))
    const critNoCid = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
      'critique-pass', '--file', noCidRel, '--reviewer', 'indep-critic', '--round', '1', '--json',
    ], { cwd: dir })
    if (critNoCid.status !== 0) return `准备反向夹具 critique-pass 失败：${critNoCid.stderr}`
    const appNoCid = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', noCidRel], { cwd: dir })
    if (appNoCid.status === 0 || !/可判定验收标准才可批准/.test(appNoCid.stderr)) {
      return `缺少 C<N> 条目的 SPEC 竟被 approve 放行：exit=${appNoCid.status} stderr=${appNoCid.stderr}`
    }
    return true
  } finally { rmTree(dir) }
}])

}
