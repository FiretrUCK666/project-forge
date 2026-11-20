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
import { deriveMergeGate, extractExecutionBlocks, GATE_VERDICT } from '../../kit/skills/lib/gate-truth.mjs'
import { resolveApprovalBasis } from '../../kit/skills/lib/plan-exit-gate.mjs'
import { auditEntry, auditHandRolled, ENTRY_SPECS, evaluateParity, extractDeclared, HAND_ROLLED_SPECS } from './cli-parity.mjs'
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

    // 四、有文件、能解析，但一条都派生不出来：同样阻断，不许当成「没有检查」。
    const emptyJob = repoWith({
      '.github/workflows/ci.yml': 'on:\n  pull_request:\npermissions:\n  contents: read\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n',
    })
    try {
      const gate = deriveMergeGate(emptyJob)
      if (gate.verdict !== GATE_VERDICT.FAILED || !gate.blocking) {
        return `派生为空没有阻断（verdict=${gate.verdict}）——文件在却一步都没派生出来，说明谓词或解析坏了`
      }
    } finally { rmTree(emptyJob) }
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
}
