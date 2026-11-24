/**
 * fixtures-doc-triage.mjs —— doc-plan triage 五档分流双向夹具：工具名等价、掩码、空面集拦截与 pureDocCheck 自检。
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

function createCleanTriageRepo() {
  const dir = tmpProject({
    'README.md': '# demo\n\nMinimal repository for triage verification.\n',
    'CONTRIBUTING.md': '# Contributing\n\nGuide.\n',
    'kit/skills/lib/docs.mjs': 'export function demo() {}\n',
  })
  gitInit(dir, { branch: 'main', name: 't', email: 't@t.t' })
  mkdirSync(join(dir, 'docs'), { recursive: true })
  return dir
}

export function registerDocTriageCases(cases) {
  cases.push(['triage 工具名等价性与去特例：doc-plan / planx / survey 对等价问题输出一致的非 Case 1 分流', async () => {
    const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')
    const prompts = [
      'doc-plan init 会把可选章节剪光',
      'planx init 会把可选章节剪光',
      'survey 会把可选章节剪光',
    ]

    const dir = createCleanTriageRepo()
    try {
      const directResults = prompts.map((summary) => triageTask({ summary }))
      const cliResults = []
      for (const summary of prompts) {
        const res = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
          'triage', '--dir', dir, '--summary', summary, '--json',
        ])
        if (res.status !== 0) return `CLI triage 执行失败 (${summary}): ${res.stderr}`
        cliResults.push(JSON.parse(res.stdout))
      }

      for (let i = 0; i < prompts.length; i += 1) {
        const d = directResults[i]
        const c = cliResults[i]
        if (d.caseType === 1 || d.action === 'NO_DOC_DIRECT') {
          return `工具 defect 被误判为 Case 1 (${prompts[i]}): caseType=${d.caseType}, action=${d.action}, faces=${JSON.stringify(d.faces)}`
        }
        if (c.caseType === 1 || c.action === 'NO_DOC_DIRECT') {
          return `CLI 工具 defect 被误判为 Case 1 (${prompts[i]}): ${JSON.stringify(c)}`
        }
        if (d.caseType !== c.caseType || d.action !== c.action) {
          return `CLI 与直调不一致 (${prompts[i]}): direct=${d.caseType}/${d.action}, cli=${c.caseType}/${c.action}`
        }
        if (Array.isArray(d.faces) && d.faces.includes('docs')) {
          return `工具名误命中 docs 面 (${prompts[i]}): faces=${JSON.stringify(d.faces)}`
        }
      }

      const [first, ...rest] = directResults
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i].caseType !== first.caseType || rest[i].action !== first.action) {
          return `三者分流不一致: ${prompts[0]}=${first.caseType}/${first.action} vs ${prompts[i + 1]}=${rest[i].caseType}/${rest[i].action}`
        }
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['triage 消除空面集空真与代码符号误触发，缺陷提示词落入 Case 2', async () => {
    const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')

    const nonCase1Prompts = [
      'comment out retry timer',
      'explain why auth fails',
      '把 docs.mjs 里的路径正则修一下',
      'fix doc-audit false positive',
      'update doc-plan.mjs usage help',
      'fix typo in doc-audit.mjs',
      'doc-audit false positive on headings',
      'doc-template-render.mjs strips optional sections',
      '给 doc-plan init 加一个 --no-prune 参数',
      '为什么 doc-plan init 会把可选章节剪光',
      'update spelling in retry timer',
      'question about retry timer',
      '注释掉 retry timer',
    ]

    const expectedCase2Prompts = [
      'fix doc-audit false positive',
      '把 docs.mjs 里的路径正则修一下',
      'explain why auth fails',
      'doc-audit false positive on headings',
      '为什么 doc-plan init 会把可选章节剪光',
      'fix typo in doc-audit.mjs',
    ]

    const dir = createCleanTriageRepo()
    try {
      for (const summary of nonCase1Prompts) {
        const res = triageTask({ summary })
        if (res.caseType === 1 || res.action === 'NO_DOC_DIRECT') {
          return `非纯文档提示词被误放进 Case 1: "${summary}" -> ${JSON.stringify({ caseType: res.caseType, action: res.action, faces: res.faces })}`
        }
        const cli = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
          'triage', '--dir', dir, '--summary', summary, '--json',
        ])
        if (cli.status !== 0) return `CLI triage 失败 ("${summary}"): ${cli.stderr}`
        const parsed = JSON.parse(cli.stdout)
        if (parsed.caseType === 1 || parsed.action === 'NO_DOC_DIRECT') {
          return `CLI 把非纯文档提示词误放进 Case 1: "${summary}" -> ${cli.stdout}`
        }
      }

      for (const summary of expectedCase2Prompts) {
        const res = triageTask({ summary })
        if (res.caseType !== 2 || res.action !== 'NO_DOC_RED_GREEN' || res.redGreenRequired !== true) {
          return `缺陷类提示词未落入 Case 2: "${summary}" -> caseType=${res.caseType}, action=${res.action}`
        }
      }

      const featPrompt = '给 doc-plan init 加一个 --no-prune 参数'
      const featRes = triageTask({ summary: featPrompt })
      if (featRes.caseType !== 3 || featRes.action !== 'TODO_ONLY') {
        return `新增 CLI 参数未落入 Case 3: "${featPrompt}" -> caseType=${featRes.caseType}, action=${featRes.action}`
      }

      const filesCli = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
        'triage', '--dir', dir, '--summary', 'fix typo', '--files', 'kit/skills/lib/docs.mjs', '--json',
      ])
      if (filesCli.status !== 0) return `CLI --files 代码路径失败: ${filesCli.stderr}`
      const filesJson = JSON.parse(filesCli.stdout)
      if (filesJson.caseType !== 2 || filesJson.action !== 'NO_DOC_RED_GREEN') {
        return `传入 --files kit/skills/lib/docs.mjs 的 "fix typo" 应落入 Case 2，实际: ${filesCli.stdout}`
      }

      const pathsDirect = triageTask({ summary: 'fix typo', paths: ['kit/skills/lib/docs.mjs'] })
      if (pathsDirect.caseType === 1) {
        return `直调传入 paths=[kit/skills/lib/docs.mjs] 仍误判 Case 1: ${JSON.stringify(pathsDirect)}`
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])

  cases.push(['triage 纯文档 Case 1 正向不误伤与 pureDocCheck 拦截不变式', async () => {
    const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')
    const { evaluatePureDocCheck } = await import('../../kit/skills/dev-plan/scripts/triage-rules.mjs')

    const dir = createCleanTriageRepo()
    try {
      const cliPositiveCases = [
        { summary: 'fix typo in README.md', args: [], expectedKind: 'doc-edit', target: 'README.md' },
        { summary: '补充 CONTRIBUTING.md 的发版说明', args: [], expectedKind: 'doc-edit', target: 'CONTRIBUTING.md' },
        { summary: '解释一下 dev-plan 的五档分流规则', args: [], expectedKind: 'pure-qa', target: null },
        { summary: 'fix broken phrasing', args: ['--files', 'README.md'], expectedKind: 'doc-edit', target: 'README.md' },
      ]

      for (const tc of cliPositiveCases) {
        const res = await runAbsAsync('kit/skills/dev-plan/scripts/doc-plan.mjs', [
          'triage', '--dir', dir, '--summary', tc.summary, ...tc.args, '--json',
        ])
        if (res.status !== 0) return `正向纯文档 CLI 失败 (${tc.summary}): ${res.stderr}`
        const json = JSON.parse(res.stdout)
        if (json.caseType !== 1 || json.action !== 'NO_DOC_DIRECT') {
          return `纯文档/纯问答被误伤升档 (${tc.summary}): ${res.stdout}`
        }
        const chk = json.pureDocCheck
        if (!chk || chk.passed !== true || !String(chk.whyPureDocs ?? '').trim()) {
          return `Case 1 缺少有效 pureDocCheck (${tc.summary}): ${JSON.stringify(chk)}`
        }
        if (chk.kind !== tc.expectedKind) {
          return `pureDocCheck.kind 错 (${tc.summary}): 期望 ${tc.expectedKind}，实际 ${chk.kind}`
        }
        if (!Array.isArray(chk.rejectedCodeSignals) || chk.rejectedCodeSignals.length !== 0) {
          return `纯文档 Case 1 出现了 rejectedCodeSignals (${tc.summary}): ${JSON.stringify(chk.rejectedCodeSignals)}`
        }
        if (chk.pathsVerifiedDocOnly !== true) {
          return `纯文档 Case 1 pathsVerifiedDocOnly 应为 true (${tc.summary})`
        }
        if (tc.target && !(chk.matchedDocTargets ?? []).some((t) => t.includes(tc.target))) {
          return `matchedDocTargets 未包含 ${tc.target}: ${JSON.stringify(chk.matchedDocTargets)}`
        }
      }

      for (const prose of ['改一下 README 里的错别字', 'typo in README', '翻译一下注释']) {
        const res = triageTask({ summary: prose, files: 1 })
        if (res.caseType !== 1 || res.pureDocCheck?.passed !== true) {
          return `既有纯文档用例回归失败 ("${prose}"): ${JSON.stringify(res)}`
        }
      }

      const mixedPaths = triageTask({
        summary: 'fix typo in README.md',
        paths: ['README.md', 'kit/skills/lib/docs.mjs'],
      })
      if (mixedPaths.caseType === 1 || mixedPaths.pureDocCheck?.passed !== false || mixedPaths.pureDocCheck?.pathsVerifiedDocOnly !== false) {
        return `混合代码路径未被 pureDocCheck 拦截: ${JSON.stringify(mixedPaths)}`
      }

      const forcedDocOnlyWithCodePath = triageTask({
        summary: 'fix typo',
        docOnly: true,
        paths: ['kit/skills/lib/docs.mjs'],
      })
      if (forcedDocOnlyWithCodePath.caseType === 1 || forcedDocOnlyWithCodePath.pureDocCheck?.passed !== false) {
        return `docOnly=true 搭配代码路径仍返回 Case 1: ${JSON.stringify(forcedDocOnlyWithCodePath)}`
      }

      const forcedDocOnlyWithBug = triageTask({
        summary: 'explain why auth fails',
        docOnly: true,
      })
      if (forcedDocOnlyWithBug.caseType === 1 || forcedDocOnlyWithBug.pureDocCheck?.passed !== false) {
        return `docOnly=true 搭配缺陷词仍返回 Case 1: ${JSON.stringify(forcedDocOnlyWithBug)}`
      }

      const directBlocked = evaluatePureDocCheck({
        summary: 'fix typo',
        faces: [],
        signals: {
          codePathsInText: ['doc-audit.mjs'],
          toolTokens: [],
          flagTokens: [],
          commentOutTokens: [],
          logicTokens: [],
          runtimeBugSignals: [],
          matchedDocTargets: [],
          pathsVerifiedDocOnly: true,
          nonDocPaths: [],
          pureQa: false,
        },
        hasOnlyDocFaces: false,
        docOnly: false,
        hasRuntimeBug: false,
        hasExplicitFeature: false,
      })
      if (directBlocked.passed !== false || directBlocked.rejectedCodeSignals.length === 0) {
        return `evaluatePureDocCheck 未在代码路径信号下返回 passed=false: ${JSON.stringify(directBlocked)}`
      }

      return true
    } finally {
      rmTree(dir)
    }
  }])
}
