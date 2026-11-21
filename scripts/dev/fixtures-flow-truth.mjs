/**
 * fixtures-flow-truth.mjs —— 流程真相收口（Issue #113）的正反双向定点用例。
 *
 * 覆盖三组判据：
 *   1. 批准依据单点（`resolveApprovalBasis`）：`passed` / 带理由的 `skipped` / 有效的
 *      `human-override` 三种合法依据，以及 `override-stale`、`missing` 两种不成立；
 *   2. 合入门禁四档（`deriveMergeGate`）：无流水线记 `not-applicable` 且不阻断、
 *      合规流水线正常派生、有文件却解析不出来则阻断；
 *   3. 派生粒度「一条执行块算一步」：改一条输入即变一条输出，且多行块不被拆行。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parseDocFrontmatter } from '../../kit/skills/lib/doc-frontmatter.mjs'
import { deriveMergeGate, detectParserGap, evaluateRemoteChecks, extractExecutionBlocks, GATE_VERDICT } from '../../kit/skills/lib/gate-truth.mjs'
import { evaluateIntakeTriage } from '../../kit/skills/lib/intake-triage.mjs'
import { resolveApprovalBasis } from '../../kit/skills/lib/plan-exit-gate.mjs'
import { auditEntry, auditHandRolled, ENTRY_SPECS, evaluateParity, extractDeclared, HAND_ROLLED_SPECS } from './cli-parity.mjs'
import { evaluateExitCodeParity } from './exit-code-parity.mjs'
import { blockedExitOf, REGISTERED_BLOCK_CODES } from '../../kit/skills/lib/exit-codes.mjs'
import { rmTree, tmpProject } from './fixtures-helpers.mjs'

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')

/** 目录遍历：与 preflight 注入的那份同签名，避免夹具自带一套私有遍历。 */
function makeWalker() {
  return (dir, pred) => {
    const out = []
    const rec = (d) => {
      let names = []
      try { names = readdirSync(d) } catch { return }
      for (const n of names) {
        const p = join(d, n)
        let st = null
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) rec(p)
        else if (pred(n)) out.push(p)
      }
    }
    rec(dir)
    return out
  }
}

/** 造一份只有指定文件的临时仓。 */
function repoWith(files) {
  const dir = tmpProject(files)
  return dir
}

/** 一份合规的提案触发流水线：`pull_request` + 只读权限 + 本地命令。 */
const VALID_PIPELINE = [
  'name: check',
  '',
  'on:',
  '  pull_request:',
  '    types: [opened, synchronize]',
  '',
  'permissions:',
  '  contents: read',
  '',
  'jobs:',
  '  gates:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: 结构自检',
  '        run: node scripts/dev/preflight.mjs',
  '',
  '      - name: 用户包内容',
  '        run: |',
  '          git archive --format=tar HEAD | tar -t > package-list.txt',
  '          node scripts/dev/preflight.mjs --package package-list.txt',
  '',
].join('\n')

/** 一份带写作用域、由标签触发的发版流水线：三条谓词都不成立。 */
const RELEASE_PIPELINE = [
  'name: release',
  '',
  'on:',
  '  push:',
  '    tags: ["v*"]',
  '',
  'jobs:',
  '  release:',
  '    runs-on: ubuntu-latest',
  '    permissions:',
  '      contents: write',
  '    steps:',
  '      - name: 发版',
  '        run: gh release create "$TAG" --notes-file docs/release-notes/x.md',
  '',
].join('\n')

/**
 * 一份**只违反写作用域**的流水线：触发形态合规、步骤不需要远端上下文。
 *
 * 单看这一条谓词，才能证明它真的在起作用——三条谓词同时不成立时，任何一条被拆掉，
 * 另外两条仍会把这份流水线排除，断言照样通过，看上去一切正常。
 */
const WRITE_SCOPE_ONLY_PIPELINE = [
  'name: narrow',
  '',
  'on:',
  '  pull_request:',
  '',
  'permissions:',
  '  issues: write',
  '',
  'jobs:',
  '  narrow:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - name: 本地自检',
  '        run: node scripts/dev/preflight.mjs',
  '',
].join('\n')

/** 从文档全文算出批准依据结论，省得每处都拼一次。 */
function basisOf(text, docType = 'spec') {
  return resolveApprovalBasis({
    rel: docType === 'spec' ? 'docs/specs/x-spec.md' : `docs/${docType}/x-${docType}.md`,
    docType,
    text,
    data: parseDocFrontmatter(text).data ?? {},
  })
}

/** 一份最小可解析的 SPEC 正文（只要求 Frontmatter 可解析）。 */
function specText({ approved = true, planCritique = 'passed', extra = [] } = {}) {
  return [
    '---',
    'kind: spec',
    'title: 探针',
    'status: approved',
    `approved: ${approved}`,
    `plan_critique: ${planCritique}`,
    ...extra,
    '---',
    '',
    '# SPEC: 探针',
    '',
  ].join('\n')
}

export function registerFlowTruthCases(cases) {
  cases.push(['C1：批准依据三种合法取值 + 两种不成立，判据只有一处实现', async () => {
    // 依据一：passed
    if (basisOf(specText({ planCritique: 'passed' })).basis !== 'passed') {
      return '正常过审没有被判成 passed'
    }
    // 依据二：带实质理由的 skipped
    const skippedOk = basisOf(specText({ planCritique: 'skipped (reason=紧急修复，停线事故先放行)' }))
    if (!skippedOk.hasBasis || skippedOk.basis !== 'skipped') {
      return `带实质理由的 skipped 没被认成合法依据：${JSON.stringify(skippedOk)}`
    }
    // 依据二的反例：占位词的 skipped 不算依据
    const skippedStub = basisOf(specText({ planCritique: 'skipped (reason=todo)' }))
    if (skippedStub.hasBasis) {
      return '占位词的 skipped 被当成了合法依据——理由就该是理由，不是记一个「跳过」'
    }
    // 依据三：有效的 human-override。这是 SPEC 原文漏掉的第三种，漏了就会把人签的字判成「依据缺失」。
    const bare = specText({ planCritique: 'rejected (reviewer=crit-3, round=3, sha=f841d5825ad0)' })
    const { critiqueTextFingerprint } = await import('../../kit/skills/lib/critique-rounds.mjs')
    const overrideJson = JSON.stringify({
      approved: true, reason: 'approved after stop-loss', by: 'human-maintainer',
      at: '2026-11-20T00:00:00.000Z', sha: critiqueTextFingerprint(bare), overriddenRounds: [3],
    })
    const signed = specText({
      planCritique: 'rejected (reviewer=crit-3, round=3, sha=f841d5825ad0)',
      extra: [`critique_override: '${overrideJson}'`],
    })
    const human = basisOf(signed)
    if (!human.hasBasis || human.basis !== 'human-override') {
      return `有效的人类签字没被认成 human-override：${JSON.stringify(human)}`
    }
    // 依据三的反例：签字之后正文又改过 -> 依据失效
    const tampered = `${signed}\n- override 之后又加的一条\n`
    const stale = basisOf(tampered)
    if (stale.hasBasis || stale.basis !== 'override-stale') {
      return `签字过期没有被判成 override-stale：${JSON.stringify(stale)}`
    }
    // 反例：毫无依据的 approved: true
    const naked = basisOf(specText({ planCritique: 'null' }))
    if (naked.hasBasis) {
      return '没有任何依据的批准被放行了——这等于没检查'
    }
    // 类型不适用：todo 档流程里没有批准动作，按类型不适用而不是靠豁免
    const todo = basisOf(specText(), 'todo')
    if (todo.applicable || todo.basis !== 'not-applicable') {
      return `todo 档没有被判成按类型不适用：${JSON.stringify(todo)}`
    }
    return true
  }])

  cases.push(['C10：合入门禁四档互斥——无流水线记 not-applicable 不阻断，合规流水线正常派生，解析失败阻断', async () => {
    // 一、仓库里一个可识别的流水线文件都没有：在被管对象之外，记不适用且不阻断。
    const noCi = repoWith({ 'README.md': '# 纯本地项目\n' })
    try {
      const gate = deriveMergeGate(noCi)
      if (gate.verdict !== GATE_VERDICT.NOT_APPLICABLE) {
        return `无流水线文件的仓被判成 ${gate.verdict}——判据隐含要求某种形状的流水线，非该类 CI 的项目装完即不可用`
      }
      if (gate.blocking) return '不适用被当成了阻断，等于让没有流水线的仓永久卡在合入前'
      if (!gate.reasons.some((r) => r.includes('没有任何可识别的流水线文件'))) {
        return `不适用没有带原因入报告：${JSON.stringify(gate.reasons)}`
      }
    } finally { rmTree(noCi) }

    // 二、合规流水线：正常派生，且多行块整块算一步、不被拆行。
    const ci = repoWith({ '.github/workflows/check.yml': VALID_PIPELINE })
    try {
      const gate = deriveMergeGate(ci)
      if (gate.verdict !== GATE_VERDICT.UNVERIFIED) {
        return `合规流水线派生后应停在未核验（还没跑），实际 ${gate.verdict}`
      }
      if (gate.steps.length !== 2) {
        return `一条执行块应算一步、两份文件共 2 步，实际 ${gate.steps.length} 步：${JSON.stringify(gate.steps.map((s) => s.cmd))}`
      }
      const multiline = gate.steps.find((s) => s.lineCount > 1)
      if (!multiline || !multiline.cmd.includes('git archive') || !multiline.cmd.includes('--package')) {
        return `多行块被拆开了，整块交给 shell 的前提就没了：${JSON.stringify(gate.steps.map((s) => s.cmd))}`
      }
      // 未核验与通过是两件事：派生成功不等于跑过。
      if (gate.verdict === GATE_VERDICT.PASSED) return '派生成功被当成了跑通，未核验折成了通过'
    } finally { rmTree(ci) }

    // 三、有文件却读不懂：这是真故障，必须阻断，且理由要说「读不懂」。
    //
    // 只断言 verdict 不够：把「解析失败」这条判据拆掉，结果会落进第四条（派生为空）那条路，
    // verdict 一样是 FAILED。所以理由必须区分开——一个是「文件读不懂」，一个是「文件读得懂
    // 却一步都派生不出来」，两者对应不同的修法。
    const broken = repoWith({ '.github/workflows/ci.yml': 'not a yaml: [\n  broken\n' })
    try {
      const gate = deriveMergeGate(broken)
      if (gate.verdict !== GATE_VERDICT.FAILED || !gate.blocking) {
        return `解析失败没有阻断（verdict=${gate.verdict}, blocking=${gate.blocking}）——降级成空清单就是假绿`
      }
      if (!gate.reasons.some((r) => r.includes('读不懂'))) {
        return `解析失败被当成了别的问题：${JSON.stringify(gate.reasons)}——理由没说「文件读不懂」，修的人会去改谓词`
      }
    } finally { rmTree(broken) }

    // 三之二、解析漏读与「本来就没有可跑步骤」必须分开判。前者说明解析坏了、门禁会静默变空；
    // 后者只是这份流水线不适用于本仓。混在一起，要么把正常项目判死，要么把坏掉的解析放过去。
    if (!detectParserGap('on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: node a.mjs\n', [])) {
      return '文件里写着 run 步骤却切不出执行块时没被标成解析漏读——门禁会静默变空'
    }
    if (detectParserGap('on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n', [])) {
      return '本来就没有 run 步骤的文件被误标成解析漏读——那会把正常项目判死'
    }
    if (detectParserGap('on:\n  pull_request:\njobs:\n  a:\n    steps:\n      - run: node a.mjs\n', [{ cmd: 'node a.mjs' }])) {
      return '切得出执行块时仍被判成解析漏读——判据把「读到了」和「没读到」搞反了'
    }

    // 四、流水线文件在、解析得了，但按结构谓词整份被排除（只有发版步骤，没有本地可跑的检查）：
    // 记不适用、不阻断。判据不能隐含「必须有某种形状的流水线」——那样只有发版流水线的仓
    // 装完工具就不可用，而它本来没有任何可本地复现的检查。
    const releaseOnly = repoWith({
      '.github/workflows/release.yml': 'on:\n  push:\n    tags: [\'v*\']\npermissions:\n  contents: write\njobs:\n  rel:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1 --repo x/y\n',
    })
    try {
      const gate = deriveMergeGate(releaseOnly)
      if (gate.verdict !== GATE_VERDICT.NOT_APPLICABLE || gate.blocking) {
        return `只有发版流水线却判成 ${gate.verdict}（blocking=${gate.blocking}）——非该类 CI 的仓会被无理由卡死`
      }
      if (!gate.reasons.some((r) => r.includes('release.yml'))) {
        return `不适用没说清是哪份文件被排除：${JSON.stringify(gate.reasons)}`
      }
    } finally { rmTree(releaseOnly) }

    // 五、文件里明明写着 run 步骤，一条执行块都切不出来：这是解析漏读，必须阻断。
    // 与第四条的区别是「本来没有」和「该有却没读到」——后者会把门禁静默变空。
    const parserGap = repoWith({
      '.github/workflows/ci.yml': 'on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node x.mjs\n',
    })
    try {
      const gate = deriveMergeGate(parserGap)
      if (gate.steps.length === 0 && gate.verdict !== GATE_VERDICT.FAILED) {
        return `写着 run 步骤却读不出执行块时判成了 ${gate.verdict}——解析漏读必须阻断`
      }
    } finally { rmTree(parserGap) }

    // 六、正反双向：正常校验流水线必须派生得出步骤，且结论不是「不适用」。
    const healthy = repoWith({
      '.github/workflows/check.yml': 'on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node a.mjs\n',
    })
    try {
      const gate = deriveMergeGate(healthy)
      if (gate.verdict === GATE_VERDICT.NOT_APPLICABLE) return '合规流水线被判成不适用'
      if (gate.steps.length !== 1) return `合规流水线派生了 ${gate.steps.length} 步，应为 1 步`
    } finally { rmTree(healthy) }
    return true
  }])

  cases.push(['C6：结构谓词不按文件名排除——发版流水线因谓词不成立被排除，其本地可跑检查仍可采纳', async () => {
    const dir = repoWith({
      '.github/workflows/check.yml': VALID_PIPELINE,
      '.github/workflows/release.yml': RELEASE_PIPELINE,
    })
    try {
      const gate = deriveMergeGate(dir)
      if (!gate.adoptedFiles.includes('.github/workflows/check.yml')) {
        return `合规的校验流水线没被采纳：${JSON.stringify(gate.adoptedFiles)}`
      }
      if (gate.adoptedFiles.includes('.github/workflows/release.yml')) {
        return '发版流水线被采纳了——它的权限与触发形态都不该通过'
      }
      const skipped = gate.skippedFiles.find((s) => s.file === '.github/workflows/release.yml')
      if (!skipped) return `被排除的流水线没有逐条给出原因：${JSON.stringify(gate.skippedFiles)}`
      // 排除理由必须是结构事实，不能是「它是发版流水线」这种语义判断。
      if (!/写作用域|触发形态|远端上下文/.test(skipped.reason)) {
        return `排除理由不是结构事实：${skipped.reason}`
      }

      // 定点用例：改一条输入，输出必须跟着变一条。
      const before = gate.steps.length
      writeFileSync(join(dir, '.github/workflows/check.yml'), VALID_PIPELINE.replace(
        '      - name: 结构自检\n        run: node scripts/dev/preflight.mjs\n',
        '      - name: 结构自检\n        run: node scripts/dev/preflight.mjs\n\n      - name: 多加一步\n        run: node scripts/dev/extra-check.mjs\n',
      ))
      const after = deriveMergeGate(dir).steps.length
      if (after !== before + 1) {
        return `改一条输入应让输出变一条，实际 ${before} -> ${after}`
      }
    } finally { rmTree(dir) }

    // 单谓词隔离：只违反写作用域的流水线也必须被排除，且理由点名写作用域。
    //
    // 这一条是判据真的在起作用的唯一证明：三条谓词同时不成立时，拆掉任意一条，
    // 另外两条仍会排除它，看上去一切正常。只有「只违反一条」才能把它单独钉住。
    const narrow = repoWith({
      '.github/workflows/check.yml': VALID_PIPELINE,
      '.github/workflows/narrow.yml': WRITE_SCOPE_ONLY_PIPELINE,
    })
    try {
      const gate = deriveMergeGate(narrow)
      if (gate.adoptedFiles.includes('.github/workflows/narrow.yml')) {
        return '只违反写作用域的流水线被采纳了——权限谓词没起作用'
      }
      const why = gate.skippedFiles.find((s) => s.file === '.github/workflows/narrow.yml')
      if (!why || !why.reason.includes('写作用域')) {
        return `只违反写作用域时的排除理由没点名写作用域：${JSON.stringify(why)}`
      }
      if (gate.skippedFiles.some((s) => s.file === '.github/workflows/narrow.yml' && /触发形态|远端上下文/.test(s.reason))) {
        return `只违反写作用域却报了别的理由：${why.reason}`
      }
    } finally { rmTree(narrow) }
    return true
  }])

  cases.push(['C6：执行块解析——defaults.run.shell 不是执行块，注释行不进清单', async () => {
    const text = [
      'name: check',
      'on:',
      '  pull_request:',
      'defaults:',
      '  run:',
      '    shell: bash',
      'jobs:',
      '  a:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: 一步',
      '        run: node scripts/dev/preflight.mjs',
      '',
    ].join('\n')
    const blocks = extractExecutionBlocks('.github/workflows/check.yml', text)
    if (blocks.length !== 1) {
      return `应按 1 个执行块计，实际 ${blocks.length} 个：${JSON.stringify(blocks.map((b) => b.cmd))}`
    }
    if (/shell/.test(blocks[0].cmd)) return 'defaults.run.shell 被当成了执行块——它给的是用哪个 shell，不是跑什么'
    return true
  }])

  cases.push(['C7：参数三重对拍——帮助里有的必须注册得上，注册了的必须有人读，暗参数只许少不许多', async () => {
    const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
    const entry = read('kit/skills/dev-flow/scripts/flow.mjs')

    // 判据零：句中提及不算声明位置。
    const declared = extractDeclared(entry)
    if (!declared.found) return '流程入口的帮助函数体没被截出来'
    if (declared.flags.includes('body-file')) {
      return '句中提及的 --body-file 被当成了声明位置——那是别的命令的参数，算进来反向差集全是假红灯'
    }
    // 正例：行首声明与方括号分组都能认出来。
    if (!declared.flags.includes('task')) return '行首声明的 --task 没被认出来'
    if (!declared.flags.includes('json')) return '方括号分组里的 --json 没被认出来'
    // 反例一：句中提及不算（帮助正文里讲的是别的命令的参数）。
    const withProse = [
      'function printHelp() {',
      '  process.stdout.write([',
      '    \'  audit      [--changed] [--json]\',',
      '    \'  建单走 gh issue create --body-file，安装走 npm ci --ignore-scripts。\',',
      '    \'  --changed   只看改动过的文件\',',
      '  ].join(\'\\n\'))',
      '}',
    ].join('\n')
    const proseDeclared = extractDeclared(withProse)
    if (proseDeclared.flags.includes('body-file') || proseDeclared.flags.includes('ignore-scripts')) {
      return `句中提及被当成了声明位置：${JSON.stringify(proseDeclared.flags)}——反向差集因此全是假红灯`
    }
    if (!proseDeclared.flags.includes('changed') || !proseDeclared.flags.includes('json')) {
      return `真正的声明位置反而漏了：${JSON.stringify(proseDeclared.flags)}`
    }
    // 反例二：用法行括号里的参数算声明，行首没有也算。
    const usageOnly = [
      'function printHelp() {',
      '  process.stdout.write([',
      '    \'用法：node x.mjs [--alpha] [--beta <v>]\',',
      '  ].join(\'\\n\'))',
      '}',
    ].join('\n')
    const usageDeclared = extractDeclared(usageOnly)
    if (!usageDeclared.flags.includes('alpha') || !usageDeclared.flags.includes('beta')) {
      return `方括号分组里的参数没被认出来：${JSON.stringify(usageDeclared.flags)}`
    }

    // 判据一/二：五种仕样的注册与声明必须双向覆盖，全局参数走唯一白名单。
    const walkDir = makeWalker()
    const audits = [
      ...ENTRY_SPECS.map((spec) => auditEntry(spec, { ROOT, walk: walkDir })),
      ...HAND_ROLLED_SPECS.map((spec) => auditHandRolled(spec, { ROOT })),
    ]
    for (const a of audits) {
      if (!a.ok) return `参数对拍失败：${a.error}`
      if (a.undeclaredInCode.length > 0) {
        return `${a.label}帮助里声明了没注册的参数（照着敲会被拒）：${a.undeclaredInCode.join(', ')}`
      }
      if (a.dead.length > 0) {
        return `${a.label}有死参数（注册了却没有任何读取点）：${a.dead.join(', ')}`
      }
    }
    const { failures } = evaluateParity(audits)
    if (failures.length > 0) return `参数对拍不通过：${failures.join('；')}`

    // 反例三：新增一个只有代码知道、帮助里看不到的暗参数，必须被抓到。
    const flowAudit = audits.find((a) => a.label === '流程入口')
    const planted = { ...flowAudit, dark: [...flowAudit.dark, 'brand-new-flag'] }
    if (!evaluateParity([planted]).failures.some((f) => f.includes('brand-new-flag'))) {
      return '新出现的暗参数没有被抓到——那一类问题会继续悄悄长大'
    }
    // 反例四：注册了却没人读，必须被抓到。
    const deadPlanted = { ...flowAudit, dead: ['no-such-reader'] }
    if (!evaluateParity([deadPlanted]).failures.some((f) => f.includes('no-such-reader'))) {
      return '死参数没有被抓到——参数会越攒越多，看着能用其实不做事'
    }
    // 反例五：帮助里声明的参数没注册，必须被抓到。
    const fakeDeclared = { ...flowAudit, undeclaredInCode: ['not-registered'] }
    if (!evaluateParity([fakeDeclared]).failures.some((f) => f.includes('not-registered'))) {
      return '帮助里声明了没注册的参数却没被抓到'
    }
    return true
  }])

  cases.push(['C8：分诊只读平台真相——平台读不到时补充保留但带源，补充不得覆盖平台已有值', async () => {
    const dir = repoWith({ 'README.md': '# 本地仓\n' })
    try {
      const specTextWith = (extra) => [
        '---',
        'kind: spec',
        'status: approved',
        'approved: true',
        'plan_critique: passed',
        'issue: 41',
        'title: 已批 SPEC',
        ...extra,
        '---',
        '',
        '# SPEC: 已批 SPEC',
        '',
      ].join('\n')
      mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
      writeFileSync(join(dir, 'docs', 'specs', '261120-issue41-probe-spec.md'), specTextWith([]))

      // 正例：签发完整的文档豁免成立。
      const exempt = evaluateIntakeTriage(dir, {
        targetType: 'issue', targetNumber: 41, title: '随便什么标题', body: '按已批 SPEC 推进。',
      })
      if (!exempt.exempt || exempt.decisionSource !== 'internal-plan-exempt') {
        return `签发改完整的文档没有豁免分诊：${JSON.stringify({ exempt: exempt.exempt, src: exempt.decisionSource })}`
      }

      // 反例一：同一份文档改成「签字过期」就不再豁免——分诊与退场门禁必须同一个答案。
      // 这一版必须去掉 plan_critique: passed，否则「正常过审」这条依据先成立，
      // 过期判定根本轮不到执行，反例就成了空壳。
      writeFileSync(join(dir, 'docs', 'specs', '261120-issue41-probe-spec.md'), [
        '---',
        'kind: spec',
        'status: approved',
        'approved: true',
        'plan_critique: rejected',
        'issue: 41',
        'title: 已批 SPEC',
        'critique_override: {"approved":true,"sha":"deadbeefdeadbeef","by":"human","reason":"当时批过"}',
        '---',
        '',
        '# SPEC: 已批 SPEC',
        '',
      ].join('\n'))
      const stale = evaluateIntakeTriage(dir, {
        targetType: 'issue', targetNumber: 41, title: '随便什么标题', body: '按已批 SPEC 推进。',
      })
      if (stale.exempt) {
        return '签字过期（正文改过了）仍被当成已核准规划——分诊与退场门禁给出了相反的结论'
      }

      // 正例二：平台读不到某个字段时，补充保留、但要留源。
      writeFileSync(join(dir, 'docs', 'specs', '261120-issue41-probe-spec.md'), specTextWith([]))
      const supplemented = evaluateIntakeTriage(dir, {
        targetType: 'issue', targetNumber: 43, body: '按已批 SPEC 推进。',
        supplemented: [{ field: 'title', reason: '远端只读拉取失败：401 Bad credentials' }],
      })
      if (!supplemented.supplemented || supplemented.supplemented.length !== 1) {
        return `补充字段没有带源返回：${JSON.stringify(supplemented.supplemented)}`
      }
      if (!String(supplemented.reason).includes('调用方补充') || !String(supplemented.reason).includes('401')) {
        return `补充来源没写进结论：${supplemented.reason}`
      }
      if (!String(supplemented.commentBody).includes('401')) {
        return '补充来源没写进评论正文——平台外的人看不到这条判定读的是什么'
      }

      // 反例二：没有补充时结论里不许凭空冒出「调用方补充」这种标注。
      const clean = evaluateIntakeTriage(dir, { targetType: 'issue', targetNumber: 44, title: '普通提案', body: '普通正文' })
      if (String(clean.reason).includes('调用方补充')) {
        return '没有补充字段却标注了补充来源——标注本身会立刻变成噪音'
      }
      // 反例三：平台读取失败不得让分诊直接失败。
      if (!clean.ok) return '分诊因为平台读不到直接失败了——离线仓必须还能用'
    } finally { rmTree(dir) }
    return true
  }])

  cases.push(['C9：阻断码登记档位与返回处一致——未登记即失败，档位不符即失败，一码两档也失败', async () => {
    const tierName = { 1: 'EXIT.ACTION', 2: 'EXIT.USAGE', 3: 'EXIT.FACT', 4: 'EXIT.HUMAN' }

    // 正例：登记表与返回处逐条一致。
    const clean = [
      { file: 'a.mjs', text: "return { code: 'BLOCKED_NOT_VERIFIED', exitCode: EXIT.FACT }" },
      { file: 'b.mjs', text: "throw Object.assign(new Error('x'), { code: 'MISSING_REVIEWER', exitCode: EXIT.USAGE })" },
    ]
    const okRes = evaluateExitCodeParity(clean, blockedExitOf)
    if (!okRes.ok) return `合规写法被判失败：${okRes.failures.join('；')}`
    if (okRes.checked !== 2) return `只认出 ${okRes.checked} 处配对，应为 2 处`

    // 反例一：未登记的码必须报失败——没登记的码拿不到确定档位，调用方只能猜。
    const unregistered = [{ file: 'c.mjs', text: "return { code: 'BLOCKED_BRAND_NEW_CODE', exitCode: EXIT.FACT }" }]
    const unregRes = evaluateExitCodeParity(unregistered, blockedExitOf)
    if (unregRes.ok) return '未登记的阻断码被放过了——新增码不登记就永远不会被要求定档'
    if (!unregRes.failures.some((m) => m.includes('未在 exit-codes 里登记档位'))) {
      return `未登记被报成了别的问题：${unregRes.failures.join('；')}`
    }

    // 反例二：登记与返回不一致必须报失败——照登记表处理的人会做错事。
    const drifted = [{ file: 'd.mjs', text: "return { code: 'STOP_LOSS_ESCALATE', exitCode: EXIT.FACT }" }]
    const driftRes = evaluateExitCodeParity(drifted, blockedExitOf)
    if (driftRes.ok) return '停损升级返回事实档却被放过了——登记写 4、实际返 3 正是要抓的那类脱节'
    if (!driftRes.failures.some((m) => m.includes('实际返回 3 档'))) {
      return `档位不符没被指名：${driftRes.failures.join('；')}`
    }

    // 反例三：同一个码在两个地方返不同档位，也必须报——一个码只能表达一种情形。
    const mixed = [
      { file: 'e.mjs', text: "return { code: 'BLOCKED_NOT_VERIFIED', exitCode: EXIT.FACT }" },
      { file: 'f.mjs', text: "return { code: 'BLOCKED_NOT_VERIFIED', exitCode: EXIT.HUMAN }" },
    ]
    const mixedRes = evaluateExitCodeParity(mixed, blockedExitOf)
    if (mixedRes.ok) return '同一个码用两个档位却被放过了——读的人分不清该改命令还是该找人'

    // 反例四：exitCode 来自变量时不参与判断，不能因为认不出就报失败。
    const viaVar = [{ file: 'g.mjs', text: "return { code: 'BLOCKED_NOT_VERIFIED', exitCode: pre.finalExit || EXIT.FACT }" }]
    const varRes = evaluateExitCodeParity(viaVar, blockedExitOf)
    if (!varRes.ok) return `退出码来自变量时被误判成档位不符：${varRes.failures.join('；')}——这种写法本来就判不了，不该假装判了`

    // 登记表自身的完整性：四档之内、非空。全仓真实源码的对拍由 preflight 那一侧做——
    // 夹具里再扫一遍全仓，会扫到本夹具故意写错的反例串，只能靠在夹具里开口子才过。
    if (REGISTERED_BLOCK_CODES.length === 0) return '登记表是空的'
    for (const code of REGISTERED_BLOCK_CODES) {
      const tier = blockedExitOf(code)
      if (!tier || !tierName[tier]) return `${code} 的档位 ${tier} 不在四档之内`
    }
    return true
  }])

  cases.push(['M1：规划内审独立性按负责人历史判——换人后原负责人不能回来审自己的稿子', async () => {
    const { collectOwnerHistory } = await import('../../kit/skills/lib/doc-approval.mjs')
    // 正例：只有当前 owner，历史集合就是它自己。
    const one = collectOwnerHistory({ owner: 'alice' })
    if (one.length !== 1 || one[0] !== 'alice') return `单负责人历史算错：${JSON.stringify(one)}`
    // 正例：换过人之后，历史里要能同时读到新旧两任——只比当前 owner 时，旧负责人可以回来自审。
    const two = collectOwnerHistory({ owner: 'bob', previous_owners: ['alice'] })
    if (!two.includes('alice') || !two.includes('bob')) return `换人后历史不完整：${JSON.stringify(two)}`
    // 反例：同一个人写两遍不该被算成两任。
    const dup = collectOwnerHistory({ owner: 'alice', previous_owners: ['alice', 'ALICE '] })
    if (dup.length !== 1) return `同一负责人被重复计入：${JSON.stringify(dup)}`
    // 反例：空值不该进历史（否则「没写 owner」会被当成某人）。
    const none = collectOwnerHistory({ owner: '', previous_owners: ['null', '  '] })
    if (none.length !== 0) return `空负责人进了历史：${JSON.stringify(none)}`
    return true
  }])

  cases.push(['C6：远端检查判定单点——五档互斥，有工作流却没 check-run 阻断，没工作流才算不适用', async () => {
    const cases = [
      ['语义分桶全绿', { ok: true, bucket: 'pass' }, { ciRequired: true }, 'passed', false],
      ['有失败检查', { ok: true, bucket: 'fail', failed: [{ name: 'gates', state: 'FAILURE' }] }, { ciRequired: true }, 'failed', true],
      ['检查还在跑', { ok: true, bucket: 'pending', pending: [{ name: 'gates', state: 'IN_PROGRESS' }] }, { ciRequired: true }, 'pending', true],
      ['有工作流但零 check-run', { ok: true, bucket: 'none' }, { ciRequired: true }, 'pending', true],
      ['状态分桶认不出来', { ok: true, bucket: 'unknown', warnings: ['partial'] }, { ciRequired: true }, 'unverified', true],
      ['读取整体失败', { ok: false, error: 'network' }, { ciRequired: true }, 'unverified', true],
      ['仓库没有工作流', { ok: true, bucket: 'none' }, { ciRequired: false }, 'not-required', false],
      ['后端不支持读检查', { skipped: true }, { ciRequired: true }, 'not-required', false],
    ]
    for (const [label, checks, opts, wantVerdict, wantBlocking] of cases) {
      const got = evaluateRemoteChecks(checks, opts)
      if (got.verdict !== wantVerdict) return `${label} 被判成 ${got.verdict}，应为 ${wantVerdict}`
      if (got.blocking !== wantBlocking) return `${label} 的阻断性错了（blocking=${got.blocking}）`
      if (wantBlocking && !got.code) return `${label} 阻断了却没给阻断码——调用方只能猜`
      if (!wantBlocking && got.code) return `${label} 没阻断却给了阻断码 ${got.code}`
    }
    // 两款「不知道」不能被合并成同一档：等待与读取失败，修法完全不同。
    const pendingV = evaluateRemoteChecks({ ok: true, bucket: 'pending', pending: [] }, { ciRequired: true })
    const unverifiedV = evaluateRemoteChecks({ ok: false, error: 'boom' }, { ciRequired: true })
    if (pendingV.code === unverifiedV.code) return '等待与核验失败用了同一个阻断码，修的人分不清要等还是要查'
    return true
  }])
}
