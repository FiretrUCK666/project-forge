import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { SCRIPTS, rmTree, runAbsAsync, runNode, survey, textsOf, tmpProject } from './fixtures-helpers.mjs'
import { gitInit } from './fixtures-helpers.mjs'

export function registerSurveyCases(cases) {
cases.push(['node 项目被判成 node', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0","scripts":{"test":"node --test"}}' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('node')) return `kinds=${f.ecosystem.kinds}`
    if (f.commands.test !== 'npm test') return `test 命令是 ${f.commands.test}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['CMake 项目被判成 cpp，不是 docs-only', async () => {
  const dir = tmpProject({ 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(x CXX)\n' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('cpp')) return `kinds=${f.ecosystem.kinds}`
    if (f.ecosystem.kinds.includes('docs-only')) return '同时被判成 docs-only'
    if (f.maturity !== 'greenfield') return `maturity=${f.maturity}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['纯 md 但没 README 判成 unknown，不是 docs-only', async () => {
  const dir = tmpProject({ 'notes.md': '# 随手记\n' })
  try {
    const f = await survey(dir)
    if (f.ecosystem.kinds.includes('docs-only')) return '被误判成 docs-only'
    if (!f.ecosystem.kinds.includes('unknown')) return `kinds=${f.ecosystem.kinds}`
    if (!textsOf(f.questions).some((q) => /什么项目/.test(q))) return '没问用户这是什么项目'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['README + 只有 md 判成 docs-only', async () => {
  const dir = tmpProject({ 'README.md': '# 手册\n\n内容。\n', 'guide.md': '# 指南\n' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('docs-only')) return `kinds=${f.ecosystem.kinds}`
    return true
  } finally { rmTree(dir) }
}])

// 生态清单只认识十几种清单文件。清单外的语言（Haskell、OCaml、Zig、Nim、自研 DSL）
// 会走到 unknown，命令探测也就空了——可它们的 CI 里明明写着跑什么。
cases.push(['清单外语言：从 CI 的 run 块读出测试命令，不再空手而归', async () => {
  const dir = tmpProject({
    'stack.yaml': 'resolver: lts-21\n',
    'src/Main.hs': 'main = pure ()\n',
    'README.md': '# h\n',
    '.github/workflows/ci.yml': [
      'jobs:',
      '  build:',
      '    steps:',
      '      - run: stack build',
      '      - run: stack test',
      '',
    ].join('\n'),
  })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('unknown')) return `kinds=${f.ecosystem.kinds}`
    if (f.commands.test !== 'stack test') return `test 命令是 ${f.commands.test}（期望从 CI 读出 stack test）`
    if (f.commands.build !== 'stack build') return `build 命令是 ${f.commands.build}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['清单外语言：没有 CI 时退回 Makefile 的 target，不凭生态惯例编命令', async () => {
  const dir = tmpProject({
    'stack.yaml': 'resolver: lts-21\n',
    'src/Main.hs': 'main = pure ()\n',
    'README.md': '# h\n',
    'Makefile': 'test:\n\tstack test\nlint:\n\tstack hlint\n',
  })
  try {
    const f = await survey(dir)
    if (f.commands.test !== 'make test') return `test 命令是 ${f.commands.test}（期望 make test）`
    // 反面：Makefile 里没定义的 target 不能被编出来。
    if (f.commands.verify !== undefined) return `凭空编出了 verify 命令：${f.commands.verify}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['清单外语言：Makefile 里把测试 target 写成 check 或 spec 也能认出来', async () => {
  // 同一个「跑测试」的动作，各家叫法不一样。只认 `test` 这一个词，等于把一大批
  // 明明有测试的项目判成「没有测试命令」。
  const dir = tmpProject({
    'weird.ext': 'x\n',
    'README.md': '# x\n',
    'Makefile': 'check:\n\tmytool verify\ndist:\n\tmytool build\n',
  })
  try {
    const f = await survey(dir)
    if (f.commands.test !== 'make check') return `test 命令是 ${f.commands.test}（期望 make check）`
    if (f.commands.build !== 'make dist') return `build 命令是 ${f.commands.build}（期望 make dist）`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['已知生态不被 CI 里的偶然命令覆盖', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"a","version":"1.0.0","scripts":{"test":"node --test"}}',
    'README.md': '# a\n',
    '.github/workflows/ci.yml': 'jobs:\n  b:\n    steps:\n      - run: npm run lint\n',
  })
  try {
    const f = await survey(dir)
    if (f.commands.test !== 'npm test') return `test 命令被 CI 覆盖成了 ${f.commands.test}`
    return true
  } finally { rmTree(dir) }
}])

// 输入分层的两条铁律：判据的输入不包含判据自己的产物。
//
// 事故一：装套件前 codeFiles 是 40，装完变 86——多出来的是工具写进 `.agents/skills/`
// 的技能源码。规模判据读了这个数，于是「先装套件还是先勘察」决定了这个项目该不该
// 并行探索。因果是倒的。
//
// 事故二：只加三个空的 `docs/{prd,specs,todo}/.gitkeep`，`isReentry` 从 false 翻成 true。
// 「工具刚装了套件」被读成「这是个跨月重入的仓，正在失步」。
cases.push(['装套件前后 codeFiles 与 tier 完全相同（工具产物不参与项目规模判定）', async () => {
  const lines = Array.from({ length: 50 }, (_, k) => `export const v${k} = ${k}`).join('\n')
  const files = { 'README.md': '# p2\n\n用于验证的最小仓库。\n' }
  for (let i = 0; i < 40; i += 1) files[`src/m${i}.ts`] = lines
  const dir = tmpProject(files)
  gitInit(dir, { branch: 'main' })
  try {
    const before = await survey(dir)
    const equip = await runAbsAsync('scripts/equip.mjs', [dir])
    if (equip.status !== 0) return `equip 失败：${equip.stderr}`
    const after = await survey(dir)
    if (before.scale.codeFiles !== after.scale.codeFiles) {
      return `装套件前后 codeFiles 变了：${before.scale.codeFiles} -> ${after.scale.codeFiles}`
      + '（多出来的是工具自己写进 .agents/ 的技能源码）'
    }
    if (before.explorationStrategy.tier !== after.explorationStrategy.tier) {
      return `装套件前后 tier 变了：${before.explorationStrategy.tier} -> ${after.explorationStrategy.tier}`
      + '——「先装套件还是先勘察」不该决定这个项目该不该并行探索'
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['只加空 docs 骨架不改变「重入」判定（有内容才算痕迹）', async () => {
  const lines = Array.from({ length: 50 }, (_, k) => `export const v${k} = ${k}`).join('\n')
  const files = { 'README.md': '# p3\n\n用于验证的最小仓库。\n' }
  for (let i = 0; i < 20; i += 1) files[`src/m${i}.ts`] = lines
  const dir = tmpProject(files)
  gitInit(dir, { branch: 'main' })
  try {
    const before = await survey(dir)
    if (before.reentry.isReentry) return '起始状态不该被判定为重入'
    for (const sub of ['prd', 'specs', 'todo']) {
      mkdirSync(join(dir, 'docs', sub), { recursive: true })
      writeFileSync(join(dir, 'docs', sub, '.gitkeep'), '')
    }
    const after = await survey(dir)
    if (after.reentry.isReentry) {
      return '只加了三个空的 .gitkeep 就被判成「重入」——工具刚装的骨架不该算项目痕迹'
    }
    if (before.explorationStrategy.tier !== after.explorationStrategy.tier) {
      return `只加空骨架就改了 tier：${before.explorationStrategy.tier} -> ${after.explorationStrategy.tier}`
    }
    // 反向：真放了内容就该判重入，保护不能变成失明。
    writeFileSync(join(dir, 'docs', 'specs', '261117-demo-spec.md'), '# demo spec\n\n真实内容。\n')
    const withContent = await survey(dir)
    if (!withContent.reentry.isReentry) return 'SPEC 目录里有真文档时仍判不出「重入」'
    return true
  } finally { rmTree(dir) }
}])

// 维度单调性：文件数不衡量通读成本。
// 实测矩阵里 28000 行 / 40 文件曾被判成 single-pass，比 4050 行 / 81 文件的档位还低。
cases.push(['探索策略随真实规模单调不降，28000 行 / 40 文件必须并行', async () => {
  const { computeExplorationStrategy } = await import('../lib/survey-plan.mjs')
  const mk = (codeFiles, codeLines) => ({
    maturity: 'greenfield',
    scale: { codeFiles, codeLines, effectiveFiles: codeFiles * 2 },
    ecosystem: { kinds: ['node'], subdirs: [] },
    workspace: {}, git: {}, docs: {}, reentry: {}, kit: {},
  })
  const shapes = [[10, 500], [40, 2000], [79, 3950], [81, 4050], [10, 30000], [40, 28000]]
  const rank = { none: 0, 'single-pass': 1, 'parallel-subagents': 2 }
  const rows = shapes.map(([files, lines]) => ({ files, lines, ...computeExplorationStrategy(mk(files, lines)) }))
  for (const a of rows) {
    for (const b of rows) {
      if (a.lines > b.lines && rank[a.tier] < rank[b.tier]) {
        return `${a.lines} 行(${a.tier}) 比 ${b.lines} 行(${b.tier}) 更大，却拿到更低的档——单调性被违反`
      }
    }
  }
  const heavy = rows.find((r) => r.lines === 28000)
  if (heavy.tier !== 'parallel-subagents') return `28000 行 / 40 文件被判成 ${heavy.tier}`
  // 每一档都要带上判定依据，否则重入时无法比对「依据变了没有」。
  for (const row of rows) {
    if (!row.evidence || typeof row.evidence.codeLines !== 'number') {
      return `${row.lines} 行这一档没有带 evidence（重入时无法比对依据）`
    }
  }
  // 反向：真的小仓仍必须是 single-pass，不能一律升档。
  const small = computeExplorationStrategy(mk(10, 500))
  if (small.tier !== 'single-pass') return `500 行的小仓被误升档成 ${small.tier}`
  // 同一份输入连跑两次必须逐字相同。
  const a1 = JSON.stringify(computeExplorationStrategy(mk(40, 28000)))
  const a2 = JSON.stringify(computeExplorationStrategy(mk(40, 28000)))
  if (a1 !== a2) return '同一份输入连跑两次结果不同'
  return true
}])

// ── 计数代码段里不许出现工具产物目录 ─────────────────────────────────
//
// `.agents/skills` 这三个字在这个仓里到处都是（勘察要认它、装备要写它），
// 所以「文件里有没有这个词」这种整文件扫描必然误报。要守的是一条更窄的事实：
// **计数那一段**只数项目自己的文件。判据扫描的是那一段，不是整个文件。
cases.push(['规模计数的代码段里不许出现工具产物目录（只扫计数区间，不扫整文件）', async () => {
  const text = readFileSync(join(SCRIPTS, 'lib', 'survey-workspace.mjs'), 'utf8').replace(/\r\n/g, '\n')
  const lines = text.split('\n')
  const start = lines.findIndex((l) => /^\s*let codeFiles = 0/.test(l))
  if (start === -1) return 'survey-workspace.mjs 里找不到计数起点（let codeFiles = 0），判据锚点失效'
  // 计数区间 = 起点那几行 + 真正数文件的那个循环。循环用缩进配对找出结尾，
  // 不去猜固定的行号：行号会因为无关改动漂移，而漂移之后判据会静默失效。
  const loopStart = lines.findIndex((l, i) => i > start && /^\s*for \(const file of files\) \{$/.test(l))
  if (loopStart === -1) return 'survey-workspace.mjs 里找不到数文件的循环，判据锚点失效'
  const indent = lines[loopStart].match(/^\s*/)[0]
  const loopEnd = lines.findIndex((l, i) => i > loopStart && l === `${indent}}`)
  if (loopEnd === -1) return '数文件的循环没有闭合，判据锚点失效'
  const span = lines.slice(start, loopEnd + 1).join('\n')

  if (!span.includes('isToolOwnedPath') && !span.includes('toolOwned')) {
    return '计数区间里没有出现「这条路径属于工具」的判断——工具产物会被算进项目规模'
  }
  if (/(?:includes|startsWith)\(['"]\.agents/.test(span)) {
    return '计数区间里用字面量 .agents 判目录，而不是走统一的工具所有权判据'
  }
  return true
}])

// ── 策略变了要说清变了什么、凭什么 ──────────────────────────────────
//
// 策略写进受管区之后，重入时它会被比对：跨档就红一次，而不是默默换一套做法。
// 只说「变了」不够——还要说清是哪一维越的线，否则没人判得出这次升档是对的，
// 还是规模那一维算错了。
cases.push(['规模跨档后策略变化要带依据，受管区比对能看见这次变化', async () => {
  const small = Array.from({ length: 20 }, (_, k) => `export const v${k} = ${k}`).join('\n')
  const dir = tmpProject({ 'README.md': '# strat\n\n策略变化测试仓。\n' })
  mkdirSync(join(dir, 'src'), { recursive: true })
  for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, 'src', `m${i}.mjs`), small)
  try {
    const before = await survey(dir)
    if (before.explorationStrategy.tier !== 'single-pass') {
      return `小仓起始档位是 ${before.explorationStrategy.tier}，夹具前提不成立`
    }
    await runNode('compose-agents.mjs', [dir, '--no-backup'])
    const first = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!/## 探索策略/.test(first)) return '契约里没有「探索策略」这一节，策略没落进受管区'
    writeFileSync(
      join(dir, 'AGENTS.md'),
      first
        .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
        .replace(/^((?:quick-test|full-test|smoke-verify|merge-gate|arch-rules|high-risk|do-not-edit):\s*)<[^>\n]+>/gm, '$1none'),
    )
    if ((await runNode('compose-agents.mjs', [dir, '--check'])).status !== 0) {
      return '同一份事实再比对一次就红了——策略段不是幂等的'
    }

    // 把规模推过线：文件数与行数一起越线。
    const big = Array.from({ length: 200 }, (_, k) => `export const w${k} = ${k}`).join('\n')
    for (let i = 0; i < 20; i += 1) writeFileSync(join(dir, 'src', `b${i}.mjs`), big)
    const after = await survey(dir)
    if (after.explorationStrategy.tier === before.explorationStrategy.tier) {
      return `规模跨档后策略级别没变（${after.explorationStrategy.tier}）——那一维没被算进去`
    }
    if (after.explorationStrategy.evidence.codeFiles <= before.explorationStrategy.evidence.codeFiles) {
      return '策略变了但依据里的文件数没变——报出来的依据不是这次判定的依据'
    }
    // 理由要说清是哪一维跨的线，而不是只给一句「变大了」。
    if (!/(?:代码文件|代码 \d|模块目录|语言\/生态|多包|子目录)/.test(after.explorationStrategy.reason)) {
      return `策略变化的理由没说清是哪一维跨的线：${after.explorationStrategy.reason}`
    }

    // 受管区比对要能看见这次变化，而不是默默重算。
    const check = await runNode('compose-agents.mjs', [dir, '--check'])
    if (check.status === 0) return '规模跨档后 --check 仍然放行——策略变化没人看得见'
    if (!/探索策略/.test(check.stderr ?? '')) {
      return `--check 红了但没点名「探索策略」：${(check.stderr ?? '').split('\n')[0]}`
    }
    return true
  } finally { rmTree(dir) }
}])

}
