import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { rmTree, runAbsAsync, survey, textsOf, tmpProject } from './fixtures-helpers.mjs'
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
    const equip = await runAbsAsync('scripts/equip.mjs', [dir, '--tier', 'full'])
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

}
