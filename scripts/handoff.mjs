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
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule, readJsonSafe, readTextSafe, samePath } from './lib/text.mjs'
import { scanLines } from './lib/markdown.mjs'
import { processAlive } from './lib/fs-atomic.mjs'
import {
  KIT_SKILLS, LEGACY_MARKERS, LEGACY_PATH_SPECS, PF_MANIFEST_REL, markerSyntaxFor, parseMarkers,
} from './lib/protocol.mjs'

/** 扫哪些文件。只扫文本类；二进制里的「标记」不可能是我们写的。 */
const SCAN_EXT = /\.(?:md|mdx|markdown|ya?ml|json|toml|txt)$/i

/**
 * 临时文件名：`原名.tmp-<pid>`。
 *
 * 它们必须**也被扫到**，否则「交棒时先清干净本工具留下的临时文件」这条承诺就是假话：
 * 这个形状的扩展名是 `.tmp-12345`，上面那条 `SCAN_EXT` 一个都不匹配，于是
 * `--scan` 与 `--verify` 全都看不见它——而它恰恰是这套工具唯一会**主动留下**的东西
 * （写文件写到一半被杀的时候）。
 */
const TEMP_RE = /\.tmp-(\d+)$/

/**
 * 把一行里的行内代码挖掉，剩下的才是「正文」。
 *
 * 判据只处理成对的反引号（`…`），不处理多反引号与转义——那是完整 Markdown 解析的活，
 * 而这里要防的是一件很具体的事：**正文里举例提到一个路径**，不该被当成真的引用。
 * 少挖一处（例如 ``…`` 包着的）最坏结果是多报一次，人看一眼就明白了；
 * 挖多一处是漏报，而漏报在交棒里意味着「以为干净，其实没清」。
 */
function stripInlineCode(line) {
  return String(line ?? '').replace(/`[^`]*`/g, '')
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'target', 'coverage'])
const MAX_DEPTH = 6
/** 这个脚本所在的 skill 根。「扫的是不是自己家」靠的是一条结构性事实，不靠名字。 */
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_FILES = 20000
const MAX_BYTES = 256 * 1024

/**
 * 本项目自己的文件里**不该出现**的指针：指向本 skill 内部的参考与脚本。
 *
 * 交棒之后这些指针全都指空——目标项目没有 `references/` 目录，也没有本 skill 的
 * `scripts/`。而它们比普通死链更要紧：那些位置上原本写着一条规则，删掉指针就把它
 * 一起删了。所以扫描时单列一档，提示的是「**先把规则搬进项目自己的文档，再删指针**」。
 */
const SKILL_INTERNAL_RE = /(?:references\/[A-Za-z0-9_-]+\.md|(?:\.\.\/)*project-forge\/scripts\/[A-Za-z0-9_.-]+|\bscripts\/(?:survey|compose-agents|equip|review|handoff|sync-toc|update|zip)\.mjs)/g

/**
 * 这一趟扫的是不是 **skill 自己的源码仓库**。
 *
 * ## 判据：位置，不是名字
 *
 * 早先按「`SKILL.md` 里写着 `name: project-forge`」判断。两个方向都会错：
 *
 *   - **漏**：别人 fork 之后改了名字，这条判据立刻失效；
 *   - **误**：一个被复制走的 skill 副本也写着同一行，于是**它的**痕迹被当成「不适用」跳过。
 *
 * 现在改成比位置：正在跑的这个脚本就在 skill 自己的目录里，所以「目标目录等于脚本所在的
 * skill 根」是一个**结构性事实**，与叫什么名字无关，也不需要任何人维护一份名单。
 *
 * ## 为什么这件事必须判准
 *
 * 交棒是「把一个项目从这套流程里摘出来」。skill 自己的仓库摘不出来——它就是这套流程。
 * 对它跑交棒，正确的回答是「不适用」，而不是「干净」（假话）或「还有 14 处痕迹」
 * （让人去删自己的语法）。
 */
function isSelfScan(root) {
  return samePath(resolve(root), SKILL_ROOT)
}

/** skill 自己的那几处产物目录：它们的标记是语法与讲解，不是留在别人项目里的痕迹。 */
function isSkillOwnPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  return p.startsWith('templates/') || p.startsWith('references/') || p === 'SKILL.md'
}

function walk(root) {
  const out = []
  const state = { truncated: false, unreadable: 0, skippedLarge: 0, depthLimited: 0, symlinks: 0 }
  const go = (dir, depth) => {
    if (depth > MAX_DEPTH) { state.depthLimited += 1; state.truncated = true; return }
    if (out.length > MAX_FILES) { state.truncated = true; return }
    let entries
    // 读不到这一层：它**下面**有多少东西我们一个都不知道。这不是「没有痕迹」，
    // 是「没看见」——所以也算没扫全，不能让结论落到「干净」上。
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { state.unreadable += 1; state.truncated = true; return }
    for (const entry of entries) {
      // 符号链接不跟：跟进去会绕成环，也会跑到目录之外。但**必须记一笔**——
      // 跳过一棵链接过来的目录，里面的东西一个都没看，而结论仍会说「干净」。
      if (entry.isSymbolicLink()) { state.symlinks += 1; state.truncated = true; continue }
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        if (SKIP_DIRS.has(entry.name)) continue
        go(full, depth + 1)
      } else if (entry.isFile() && (SCAN_EXT.test(entry.name) || TEMP_RE.test(entry.name))) {
        let size = 0
        try { size = statSync(full).size } catch { state.unreadable += 1; state.truncated = true; continue }
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
  const staleTemps = []
  const { files, scan: coverage } = walk(root)
  const selfScan = isSelfScan(root)

  for (const rel of files) {
    // 临时文件不读内容：它的存在本身就是结论，读它只是白花时间。
    const tempPid = TEMP_RE.exec(rel)?.[1]
    if (tempPid !== undefined) {
      const alive = processAlive(Number(tempPid))
      staleTemps.push({ file: rel, pid: Number(tempPid), alive })
      continue
    }
    // 读不出来的文件同样算「没看见」，不算「干净」：内容里可能正藏着一条标记，
    // 而报告说「一处都没有」。这条与上面那几条是同一个道理——不知道，就别替我担保。
    const text = readTextSafe(join(root, rel))
    if (text === undefined) { coverage.unreadable += 1; coverage.truncated = true; continue }

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
    // 悬空指针与旧版标记都只在**围栏之外、且不在行内代码里**才算。
    //
    // 这条判据来自一次真实的误报：一份工作记录在正文里写着「目标项目自带
    // `` `references/arch.md` `` 且里面有标记」，那句话是**举例**，而扫描把它当成了
    // 一处指向本 skill 内部的悬空指针。交棒时照着处置表去「搬规则、删指针」，
    // 搬的是一句说明里的示例——而示例删掉之后那句话就读不通了。
    for (const info of scanLines(text)) {
      if (info.inFence) continue
      const line = stripInlineCode(info.line)
      for (const legacy of LEGACY_MARKERS) {
        if (legacy.re.test(line)) {
          legacyMarkers.push({ file: rel, line: info.index + 1, what: legacy.what })
        }
      }
      // 只关心「项目自己的文件里出现了本 skill 的内部路径」。本 skill 自己的目录里
      // 出现它们是正常的（那正是它的结构），所以我们跳过它自己的那几处。
      for (const m of line.matchAll(SKILL_INTERNAL_RE)) {
        const target = m[0]
        if (!target.includes('/')) continue
        // 目标项目里真实存在这个相对路径 → 不是悬空指针，是它自己也有同名文件。
        if (existsSync(join(root, target))) continue
        danglingPointers.push({ file: rel, line: info.index + 1, target })
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

  // 「属主已经不在」的临时文件才算痕迹。属主还活着的那些属于**正在写文件的那个进程**，
  // 报成待清理会让人去删别的会话正在用的东西。
  const deletableTemps = staleTemps.filter((t) => !t.alive)

  let kitManifest
  const kitManifestFull = join(root, PF_MANIFEST_REL)
  if (!selfScan && existsSync(kitManifestFull)) {
    const manifest = readJsonSafe(kitManifestFull)
    const managedFiles = manifest?.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files)
      ? Object.keys(manifest.files).sort()
      : []
    const managedTopDirs = new Set(managedFiles.map((f) => f.split('/')[0]).filter(Boolean))
    const customSkills = []
    const skillsDir = join(root, '.agents', 'skills')
    if (existsSync(skillsDir)) {
      try {
        for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          if (KIT_SKILLS.includes(entry.name) || managedTopDirs.has(entry.name)) continue
          const sub = join(skillsDir, entry.name)
          if (existsSync(join(sub, 'SKILL.md')) || existsSync(join(sub, 'skill.md'))) {
            customSkills.push(entry.name)
          }
        }
      } catch { /* ignore */ }
    }
    kitManifest = {
      path: PF_MANIFEST_REL,
      valid: Boolean(manifest && manifest.schemaVersion === 1),
      forgeVersion: manifest?.forgeVersion,
      managedFiles,
      customSkills: customSkills.sort(),
    }
  }

  const total = markers.length + placeholders.length + legacyMarkers.length
    + legacyPaths.length + danglingPointers.length + deletableTemps.length
    + (kitManifest ? 1 : 0)

  return {
    target: { path: root },
    markers,
    placeholders,
    legacyMarkers,
    legacyPaths,
    danglingPointers,
    staleTemps,
    ...(kitManifest ? { kitManifest } : {}),
    total,
    clean: total === 0,
    selfScan,
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

  // 自扫：下面那些清单不是「待清理」，而是这套 skill 自己的语法与讲解。
  // 不把这句话说在前面，看的人会照着清单去删自己的模板。
  if (result.selfScan) {
    lines.push('**这一趟不适用**：目标就是这套 skill 自己的源码仓库。')
    lines.push('')
    lines.push('交棒是「把一个项目从这套流程里摘出来」，而它就是这套流程——')
    lines.push('`templates/` 与 `references/` 里的标记是语法与讲解，删掉会把工具弄坏。')
    lines.push('下面这份清单只作为「它自己身上有哪些标记」的说明，**不要拿它当清理待办**。')
    lines.push('')
  }

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

  // 临时文件单独一档：它们不含内容，删掉不损失任何东西；而它们恰恰是**本工具自己留下**的，
  // 交棒时不报，就等于留了一堆没人知道来历的文件在别人的项目里。
  const temps = (result.staleTemps ?? []).filter((t) => !t.alive)
  if (temps.length > 0) {
    lines.push('## 写到一半留下的临时文件（直接删）')
    lines.push('')
    for (const t of temps) {
      lines.push(`- \`${t.file}\`（进程 ${t.pid} 已经不在了）`)
    }
    lines.push('')
    lines.push('  处置：直接删。它们没有正文，是上次写文件被中断时留下的半成品。')
    lines.push('  一条命令全删：`node "<本 skill 目录>/scripts/compose-agents.mjs" "<项目>" --clean`')
    lines.push('')
  }

  if (result.kitManifest) {
    lines.push('## 受管技能套件清单元信息（按需保留或清出）')
    lines.push('')
    lines.push(`- \`${result.kitManifest.path}\`（forge ${result.kitManifest.forgeVersion ?? '未知'}，登记 ${result.kitManifest.managedFiles.length} 个托管文件）`)
    if (result.kitManifest.customSkills.length > 0) {
      lines.push(`  检测到项目自定义技能（不得删除）：${result.kitManifest.customSkills.join('、')}`)
    }
    lines.push('  处置：`.agents/skills/` 中的技能本身可按需留在项目里日常使用；若要彻底脱离本工具追踪，删除清单文件即可。')
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

/**
 * `--verify` 的退出码。**这是唯一一处定义**——帮助文本、`SKILL.md` 与
 * `references/handoff.md` 里的那几行都对着它，`preflight` 会核对三处说的是不是同一批码。
 *
 * 为什么值得单独立成常量：四个码里有两个是**非零但不代表「有痕迹」**的特殊档
 * （没扫全、这一趟不适用）。少一档、改一个数字，症状都是「一次没做完或不适用的检查
 * 被读成了通过」——而那正是不可逆动作前的最后一道关。
 */
export const VERIFY_EXIT = Object.freeze({
  clean: 0,
  dirty: 1,
  truncated: 3,
  notApplicable: 4,
})

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
        `  --verify   判「已经干净」：干净 ${VERIFY_EXIT.clean} / 有痕迹 ${VERIFY_EXIT.dirty}`
          + ` / 没扫全 ${VERIFY_EXIT.truncated} / 不适用（skill 自己的仓库）${VERIFY_EXIT.notApplicable}`,
        '  --json     输出机器可读结果',
        '',
        `只读：不删任何东西。退出码 ${VERIFY_EXIT.truncated} 是「这一趟没扫完」、`
          + `${VERIFY_EXIT.notApplicable} 是「这一趟不适用」，都不是干净。`,
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
      if (result.selfScan) {
        // 这一档不能给 0：0 的意思是「干净」，而这里的真相是「这一趟不适用」。
        process.stdout.write('不适用：目标就是这套 skill 自己的源码仓库。\n'
          + '交棒是「把一个项目从这套流程里摘出来」，而它就是这套流程——\n'
          + '它的 templates/ 与 references/ 里的标记是语法与讲解，删掉会把工具弄坏。\n')
        return VERIFY_EXIT.notApplicable
      }
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
      // 四档退出码：干净 0、还有痕迹 1、**扫不全 3**、**这一趟不适用 4**。
      // 第三档必须与「有痕迹」分开：拿 3 当 1 会让「扫不完」看起来像「找到了」，
      // 拿 3 当 0 则正好相反——把一次没做完的检查当成通过的检查，而这是不可逆动作
      // 的最后一道关。
      if (result.truncated) return VERIFY_EXIT.truncated
      return result.clean ? VERIFY_EXIT.clean : VERIFY_EXIT.dirty
    }
    return 0
  } catch (err) {
    process.stderr.write(`勘察失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  process.exit(main(process.argv.slice(2)))
}
