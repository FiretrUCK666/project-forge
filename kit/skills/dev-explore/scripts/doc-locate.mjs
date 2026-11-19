#!/usr/bin/env node
/**
 * doc-locate.mjs —— 零写入按需定位 CLI（文档节区间 + 源码符号边界 + 无头摘要）。
 *
 * 用法：
 *   node .agents/skills/dev-explore/scripts/doc-locate.mjs [--file <path>] [--query <terms>]
 *     [--symbol <name>] [--section <heading>] [--kind <prd|spec|todo|adr|doc|code>]
 *     [--scope <docs|src|all>] [--limit <N>] [--budget-lines <N>] [--worktree <path>] [--json]
 */

import { flushAndExit, parseStandardCli } from '../../lib/cli.mjs'
import {
  VALID_LOCATE_KINDS, VALID_LOCATE_SCOPES, formatLocateText, locateDocuments,
} from '../../lib/doc-locator.mjs'
import { isMainModule } from '../../lib/git.mjs'

function usageText() {
  return [
    '用法：node .agents/skills/dev-explore/scripts/doc-locate.mjs [targetDir] [选项]',
    '',
    '选项：',
    '  --file <path>          指定单个目标文件（相对路径或绝对路径）',
    '  --query <terms>        多关键词检索与相关度排序',
    '  --symbol <name>        定位源码符号定义边界（startLine..endLine）',
    '  --section <heading>    按 Markdown 标题精确/模糊定位节区间',
    `  --kind <kind>          过滤类型（${VALID_LOCATE_KINDS.join(' | ')}）`,
    `  --scope <scope>        检索范围（${VALID_LOCATE_SCOPES.join(' | ')}，默认 all）`,
    '  --limit <N>            返回切片数量上限（默认 5，别名 --max-slices）',
    '  --budget-lines <N>     切片总行数预算（默认 220）',
    '  --worktree <path>      指定目标仓库或工作树根目录',
    '  --json                 输出结构化 JSON',
    '  --help, -h             显示帮助',
    '',
    '承诺：严格只读，全程零文件写入、零原文件修改、零临时索引残留。',
  ].join('\n') + '\n'
}

export async function runCli(argv = []) {
  let cli
  try {
    cli = parseStandardCli(argv, {
      positionalDir: 'auto',
      booleanFlags: ['json', 'help'],
      valueFlags: [
        'file', 'query', 'symbol', 'section', 'kind', 'scope',
        'limit', 'max-slices', 'worktree', 'budget-lines', 'dir', 'repo',
      ],
      aliases: {
        h: 'help',
        repo: 'dir',
        'max-slices': 'limit',
      },
      usageHint: 'node .agents/skills/dev-explore/scripts/doc-locate.mjs --query "<关键词>" [--json]',
    })
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }

  if (cli.help) {
    process.stdout.write(usageText())
    return 0
  }

  try {
    const repoRoot = cli.opts.worktree ?? cli.targetDir
    const result = locateDocuments(repoRoot, {
      file: cli.opts.file,
      query: cli.opts.query,
      symbol: cli.opts.symbol,
      section: cli.opts.section,
      kind: cli.opts.kind,
      scope: cli.opts.scope,
      limit: cli.opts.limit !== undefined ? Number(cli.opts.limit) : undefined,
      budgetLines: cli.opts['budget-lines'] !== undefined ? Number(cli.opts['budget-lines']) : undefined,
      worktree: cli.opts.worktree,
    })

    if (cli.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(formatLocateText(result))
    }
    return 0
  } catch (err) {
    process.stderr.write(`定位失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  runCli(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`定位失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(1)
    })
}
