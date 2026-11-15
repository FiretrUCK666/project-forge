import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

import { rmTree, survey, textsOf, tmpProject } from './fixtures-helpers.mjs'

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

}
