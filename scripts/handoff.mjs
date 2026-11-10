#!/usr/bin/env node
/**
 * handoff.mjs —— 找出本 skill 在一个项目里留下了什么，以及怎么安全地拿掉。
 *
 * ## 它只找，不动手
 *
 * 删东西是不可逆的。所以这个脚本**一个字节都不写**：它列出「哪里有、是什么、怎么处置」，
 * 动手是人的事。这条分工由两个不用猜测的事实支撑：
 *
 *   一、**痕迹是看得见的**。本 skill 写下的每一处都带 `project-forge:` 标记，
 *       标记就写在文件里，人和 AI 都能 grep 到。
 *   二、**没有账本**。早先版本靠一个藏在 `.project-forge/` 里的哈希账本倒推「这段是不是
 *       我写的」。那个做法能精确到字节，代价是用户项目里多一个他不知道存在、
 *       删了会退化成「什么都不认」的目录。换成标记之后，同一件事从「推断」变成「读取」。
 *
 * ## 三档处置
 *
 *   - `marker`：标记行本身。删掉标记、留下正文，是纯减法，随时可做。
 *   - `placeholder`：还没填的 `fill`。它意味着**有一节内容缺失**，删掉标记不等于填好。
 *   - `legacy`：更早版本留下的东西（旧标记、账本目录、拷进项目的脚本）。它们各自有
 *     不同的处置，不能一并删掉。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readTextSafe, samePath } from './survey.mjs'
import {
  LEGACY_MARKERS, LEGACY_PATH_SPECS, markerSyntaxFor, parseMarkers,
} from './lib/protocol.mjs'

/** 扫哪些文件。只扫文本类；二进制里的「标记」不可能是我们写的。 */
const SCAN_EXT = /\.(?:md|mdx|markdown|yml|yaml|json|toml|txt)$/i
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', 'coverage'])

function walk(root) {
  const out = []
  const go = (dir, depth) => {
    if (depth > 6 || out.length > 20000) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        if (SKIP_DIRS.has(entry.name)) continue
        go(full, depth + 1)
      } else if (entry.isFile() && SCAN_EXT.test(entry.name)) {
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  go(root, 0)
  return out
}

/**
 * 扫一遍，返回分类好的痕迹。
 *
 * `clean` 只在「一处痕迹都没有」时为真——含未填占位与旧版残留。
 * 拿它当关卡是安全的：宁可怕多见，也不要让「有痕迹」被读成「干净」。
 */
export function scan(targetDir) {
  const root = resolve(targetDir)
  if (!existsSync(root)) throw new Error(`目标目录不存在：${root}`)

  const markers = []
  const placeholders = []
  const legacyMarkers = []
  const files = walk(root)

  for (const rel of files) {
    const text = readTextSafe(join(root, rel))
    if (text === undefined) continue
    if (markerSyntaxFor(rel) !== null) {
      for (const mark of parseMarkers(text, rel)) {
        if (mark.kind === 'fill') {
          placeholders.push({ file: rel, line: mark.line, what: mark.what })
        } else {
          markers.push({ file: rel, line: mark.line, kind: mark.kind, id: mark.id })
        }
      }
    }
    for (const legacy of LEGACY_MARKERS) {
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i += 1) {
        if (legacy.re.test(lines[i])) {
          legacyMarkers.push({ file: rel, line: i + 1, what: legacy.what })
        }
      }
    }
  }

  const legacyPaths = LEGACY_PATH_SPECS
    .map((spec) => {
      const full = join(root, spec.path)
      if (!existsSync(full)) return undefined
      const isDir = statSync(full).isDirectory()
      return { path: spec.path, kind: isDir ? 'dir' : 'file', what: spec.what }
    })
    .filter(Boolean)

  const inHandoff = markers.filter((m) => m.kind === 'begin' || m.kind === 'end').length > 0

  return {
    target: { path: root },
    markers,
    placeholders,
    legacyMarkers,
    legacyPaths,
    clean: markers.length === 0 && placeholders.length === 0
      && legacyMarkers.length === 0 && legacyPaths.length === 0,
    inHandoff,
  }
}

const KIND_LABEL = {
  generated: '来历标记',
  begin: '受管区间开始',
  end: '受管区间结束',
}

const PLACEHOLDER_ACTION = '这里缺内容，不是缺标记。先读代码把它填上，再删掉那一行标记'

export function toText(result) {
  const lines = []
  lines.push(`痕迹勘察：${result.target.path}`)
  lines.push('')

  if (result.clean) {
    lines.push('没找到任何本 skill 留下的东西。这个项目是干净的。')
    return lines.join('\n')
  }

  if (result.markers.length > 0) {
    lines.push('## 标记（删掉标记行，正文保留）')
    lines.push('')
    for (const m of result.markers) {
      lines.push(`- \`${m.file}:${m.line}\` ${KIND_LABEL[m.kind] ?? m.kind}${m.id ? `「${m.id}」` : ''}`)
    }
    lines.push('')
    lines.push('  处置：删掉这些行。它们只说明来历，不含内容——删掉之后文件还是完整的。')
    lines.push('  一条命令全删：`node "<本 skill 目录>/scripts/compose-agents.mjs" "<项目>" --clean`')
    lines.push('')
  }

  if (result.placeholders.length > 0) {
    lines.push('## 还没填的占位（这才是真正欠的东西）')
    lines.push('')
    for (const p of result.placeholders) {
      lines.push(`- \`${p.file}:${p.line}\` ${p.what}`)
    }
    lines.push('')
    lines.push(`  处置：${PLACEHOLDER_ACTION}。**删标记不等于填好**——把手填的那一步补上，`)
    lines.push('  否则这份契约看起来像有，实际是空的。')
    lines.push('')
  }

  if (result.legacyMarkers.length > 0 || result.legacyPaths.length > 0) {
    lines.push('## 旧版留下的东西')
    lines.push('')
    for (const m of result.legacyMarkers) {
      lines.push(`- \`${m.file}:${m.line}\` ${m.what} —— 旧版的标记语法，现在不再生成也不再解释。删掉它不影响正文`)
    }
    for (const p of result.legacyPaths) {
      lines.push(`- \`${p.path}\`（${p.kind}）${p.what} —— **删之前先看一眼里面的东西**，那是旧版的归属记录，不是这个项目的资产`)
    }
    lines.push('')
  }

  lines.push('## 须知')
  lines.push('')
  lines.push('- 上面每一处都是**读出来的事实**，不是猜的：标记就写在文件里。')
  lines.push('- 这个脚本**不会替你删**。删除不可逆，判据与顺序见 `references/handoff.md`。')
  lines.push('- 项目里的 `skills/` 之类的目录是**项目自己的**，不是痕迹——它们是内容，盘点时不要碰。')

  return lines.join('\n')
}

function main(argv) {
  let target = process.cwd()
  let asJson = false
  let verify = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/handoff.mjs [项目目录] [选项]',
        '',
        '  --scan     列出本 skill 留下的痕迹（默认）',
        '  --verify   判「已经干净」：干净退出 0，有痕迹退出 1',
        '  --json     输出机器可读结果',
        '',
        '只读：不删任何东西。',
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--verify') verify = true
    else if (arg === '--json') asJson = true
    else if (!arg.startsWith('-')) target = arg
    else {
      process.stderr.write(`未知选项：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    const result = scan(target)
    if (asJson) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else if (verify) {
      if (result.clean) {
        process.stdout.write('干净：没找到本 skill 留下的任何东西。\n')
      } else {
        const total = result.markers.length + result.placeholders.length
          + result.legacyMarkers.length + result.legacyPaths.length
        process.stdout.write(`不干净：还有 ${total} 处痕迹。跑 --scan 看清单。\n`)
      }
    } else {
      process.stdout.write(`${toText(result)}\n`)
    }
    if (verify) return result.clean ? 0 : 1
    return 0
  } catch (err) {
    process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
