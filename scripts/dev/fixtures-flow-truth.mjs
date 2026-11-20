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

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseDocFrontmatter } from '../../kit/skills/lib/doc-frontmatter.mjs'
import { deriveMergeGate, extractExecutionBlocks, GATE_VERDICT } from '../../kit/skills/lib/gate-truth.mjs'
import { resolveApprovalBasis } from '../../kit/skills/lib/plan-exit-gate.mjs'
import { rmTree, tmpProject } from './fixtures-helpers.mjs'

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

    // 三、有文件却读不懂：这是真故障，必须阻断。
    const broken = repoWith({ '.github/workflows/ci.yml': 'not a yaml: [\n  broken\n' })
    try {
      const gate = deriveMergeGate(broken)
      if (gate.verdict !== GATE_VERDICT.FAILED || !gate.blocking) {
        return `解析失败没有阻断（verdict=${gate.verdict}, blocking=${gate.blocking}）——降级成空清单就是假绿`
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
}
