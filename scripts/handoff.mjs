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
const SCAN_EXT = /\.(?:md|mdx|markdown|ya?ml|json|toml|txt)$/i
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', 'coverage'])
const MAX_DEPTH = 6
const MAX_FILES = 20000
const MAX_BYTES = 256 * 1024

/**
 * 本项目自己的文件里**不该出现**的指针：指向本 skill 内部的参考与脚本。
 *
 * 交棒之后这些指针全都指空——目标项目没有 `references/` 目录，也没有本 skill 的
 * `scripts/`。而它们比普通死链更要紧：那些位置上原本写着一条规则，删掉指针就把它
 * 一起删了。所以扫描时单列一档，提示的是「**先把规则搬进项目自己的文档，再删指针**」。
 */
const SKILL_INTERNAL_RE = /(?:references\/[A-Za-z0-9_-]+\.md|(?:\.\.\/)*project-forge\/scripts\/[A-Za-z0-9_.-]+|\bscripts\/(?:survey|compose-agents|review|handoff|sync-toc|update|zip)\.mjs)/g

/**
 * 这个脚本自己所在的那几处目录名。
 *
 * **判断依据必须是「这一趟扫的是谁」，不能是「路径叫什么」。** 早先按路径前缀跳过
 * `references/` 与 `templates/`，于是目标项目自己的 `references/` 目录里那些标记
 * 一律扫不到，`--verify` 对着一个满是痕迹的目录说「干净」——而它是交棒前唯一一道关。
 *
 * 改成：只有当我们扫的**就是这个 skill 自己的目录**时，才把它的产物目录排除。
 */
const SKILL_OWN_MARKER = 'name: project-forge'

function isSelfScan(root) {
  const skillPath = join(root, 'SKILL.md')
  if (!existsSync(skillPath)) return false
  const text = readTextSafe(skillPath)
  return typeof text === 'string' && text.includes(SKILL_OWN_MARKER)
}

function walk(root) {
  const out = []
  const state = { truncated: false, unreadable: 0, skippedLarge: 0, depthLimited: 0 }
  const go = (dir, depth) => {
    if (depth > MAX_DEPTH) { state.depthLimited += 1; state.truncated = true; return }
    if (out.length > MAX_FILES) { state.truncated = true; return }
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { state.unreadable += 1; return }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        if (SKIP_DIRS.has(entry.name)) continue
        go(full, depth + 1)
      } else if (entry.isFile() && SCAN_EXT.test(entry.name)) {
        let size = 0
        try { size = statSync(full).size } catch { state.unreadable += 1; continue }
        if (size > MAX_BYTES) { state.skippedLarge += 1; state.truncated = true; continue }
        out.push(relative(root, full).split(sep).join('/'))
      }
    }
  }
  go(root, 0)
  return { files: out, scan: state }
}

/**
 * 扫一遍，返回分类好的痕迹。
 *
 * `clean` 只在「一处痕迹都没有、而且确实扫全了」时为真。这两件事必须分开：
 * 一个大到扫不完的项目，报出来的是「没找到」，而不是「没有」——把这两句混同，
 * 等于用一句假话给一次不可逆动作背书。
 */
export function scan(targetDir) {
  const root = resolve(targetDir)
  if (!existsSync(root)) throw new Error(`目标目录不存在：${root}`)

  const markers = []
  const placeholders = []
  const legacyMarkers = []
  const danglingPointers = []
  const { files, scan: coverage } = walk(root)
  const selfScan = isSelfScan(root)

  for (const rel of files) {
    const text = readTextSafe(join(root, rel))
    if (text === undefined) { coverage.unreadable += 1; continue }

    // 扫的**就是这个 skill 自己的目录**时，`templates/` 与 `references/` 是它的源码，
    // 不是留在别人项目里的痕迹——那里面的标记是语法与讲解，不该被当成待清理的东西。
    // 目标项目自己的同名目录不受这条影响：那是它自己的文档，照常扫。
    const ownSource = selfScan && isSkillOwnPath(rel)

    if (markerSyntaxFor(rel) !== null && !ownSource) {
      for (const mark of parseMarkers(text, rel)) {
        if (mark.kind === 'fill') {
          placeholders.push({ file: rel, line: mark.line, what: mark.what })
        } else {
          markers.push({ file: rel, line: mark.line, kind: mark.kind, id: mark.id })
        }
      }
    }
    if (ownSource) continue
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]
      for (const legacy of LEGACY_MARKERS) {
        if (legacy.re.test(line)) {
          legacyMarkers.push({ file: rel, line: i + 1, what: legacy.what })
        }
      }
      // 只关心「项目自己的文件里出现了本 skill 的内部路径」。本 skill 自己的目录里
      // 出现它们是正常的（那正是它的结构），所以我们跳过它自己的那几处。
      for (const m of line.matchAll(SKILL_INTERNAL_RE)) {
        const target = m[0]
        if (!target.includes('/')) continue
        // 目标项目里真实存在这个相对路径 → 不是悬空指针，是它自己也有同名文件。
        if (existsSync(join(root, target))) continue
        danglingPointers.push({ file: rel, line: i + 1, target })
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

  const total = markers.length + placeholders.length + legacyMarkers.length
    + legacyPaths.length + danglingPointers.length

  return {
    target: { path: root },
    markers,
    placeholders,
    legacyMarkers,
    legacyPaths,
    danglingPointers,
    total,
    clean: total === 0,
    truncated: coverage.truncated,
    scanCoverage: coverage,
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

  if (result.danglingPointers.length > 0) {
    lines.push('## 指向本 skill 内部的悬空指针（先搬规则，再删指针）')
    lines.push('')
    for (const p of result.danglingPointers) {
      lines.push(`- \`${p.file}:${p.line}\` → \`${p.target}\``)
    }
    lines.push('')
    lines.push('  处置：这些位置上原本写着一条规则。**直接删指针会把规则一起删掉**——')
    lines.push('  先把那条规则搬进项目自己的文档或脚本，确认搬完再删这一行。')
    lines.push('')
  }

  lines.push('## 须知')
  lines.push('')
  lines.push('- 上面每一处都是**读出来的事实**，不是猜的：标记就写在文件里。')
  lines.push('- 这个脚本**不会替你删**。删除不可逆，判据与顺序见 `references/handoff.md`。')
  lines.push('- 项目里的 `skills/` 之类的目录是**项目自己的**，不是痕迹——它们是内容，盘点时不要碰。')
  if (result.truncated) {
    lines.push('- **这一趟没扫全**：目录太深、文件太多，或有单个文件超过 256 KB 没读。'
      + '上面列的是「扫到的」，不是「全部的」——`--verify` 会因此返回 3，别把它当成干净。')
  }

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
        '  --verify   判「已经干净」：干净退出 0，有痕迹退出 1，**没扫全退出 3**',
        '  --json     输出机器可读结果',
        '',
        '只读：不删任何东西。退出码 3 的意思是「这一趟没扫完」，不是干净。',
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--verify') verify = true
    else if (arg === '--scan') { /* 默认模式，显式写出来是为了让人知道有这个动作 */ }
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
      if (result.truncated) {
        process.stdout.write(`没扫全：目录太深、文件太多，或有单个文件超过 256 KB 没读。`
          + '这一趟的结论只能当「没查到」，不能当「没有」。\n')
        if (result.total > 0) process.stdout.write(`（已经扫到的部分里还有 ${result.total} 处痕迹，跑 --scan 看清单。）\n`)
      } else if (result.clean) {
        process.stdout.write('干净：没找到本 skill 留下的任何东西。\n')
      } else {
        process.stdout.write(`不干净：还有 ${result.total} 处痕迹。跑 --scan 看清单。\n`)
      }
    } else {
      process.stdout.write(`${toText(result)}\n`)
    }
    if (verify) {
      // 三档退出码：干净 0、还有痕迹 1、**扫不全 3**。
      // 第三档必须与「有痕迹」分开：拿 3 当 1 会让「扫不完」看起来像「找到了」，
      // 拿 3 当 0 则正好相反——把一次没做完的检查当成通过的检查，而这是不可逆动作
      // 的最后一道关。
      if (result.truncated) return 3
      return result.clean ? 0 : 1
    }
    return 0
  } catch (err) {
    process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)))
}
