#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit, isMainModule, readJsonSafe, readTextSafe, samePath } from './lib/text.mjs'
import { isInsideDir } from '../kit/skills/lib/git-core.mjs'
import { scanLines } from './lib/markdown.mjs'
import { STALE_TEMP_RE, processAlive } from './lib/fs-atomic.mjs'
import { VERIFY_EXIT } from '../kit/skills/lib/exit-codes.mjs'
import {
  COMMON_SKIP_DIRS, LEGACY_MARKERS, LEGACY_PATH_SPECS, PF_MANIFEST_REL,
  getKitSkills, isMacOsMetadata, isToolOwnedPath, markerSyntaxFor, parseMarkers,
} from './lib/protocol.mjs'

export { VERIFY_EXIT }

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
const TEMP_RE = STALE_TEMP_RE

/**
 * 把一行里的行内代码挖掉，剩下的才是「正文」。
 *
 * 判据只处理成对的反引号（`…`），不处理多反引号与转义——那是完整 Markdown 解析的活，
 * 而这里要防的是一件很具体的事：**正文里举例提到一个路径**，不该被当成真的引用。
 * 少挖一处（例如 ``…`` 包着的）最坏结果是多报一次，人看一眼就明白了；
 * 挖多一处是漏报，而漏报在交棒里意味着「以为干净，其实没清」。
 */
function stripInlineCode(line) {
  return String(line ?? '').replace(/(`{2,})[^\n]*?\1/g, '')
}

const SKIP_DIRS = COMMON_SKIP_DIRS
const MAX_DEPTH = 14
/** 这个脚本所在的 skill 根。「扫的是不是自己家」靠的是一条结构性事实，不靠名字。 */
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_FILES = 20000
const MAX_BYTES = 256 * 1024

const OWN_REF_NAMES = (() => {
  try {
    return readdirSync(join(SKILL_ROOT, 'references'))
      .filter((n) => n.endsWith('.md'))
      .map((n) => n.replace(/\.md$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  } catch {
    return [
      'collaboration', 'docs-set', 'handoff', 'plugin-ecosystems',
      'publish-ecosystems', 'publish', 'remote-github', 'skill-project',
      'survey', 'version-control',
    ]
  }
})()

/**
 * 本项目自己的文件里**不该出现**的指针：指向本 skill 内部的参考与脚本。
 *
 * 交棒之后这些指针全都指空——目标项目没有 `references/` 目录，也没有本 skill 的
 * `scripts/`。而它们比普通死链更要紧：那些位置上原本写着一条规则，删掉指针就把它
 * 一起删了。所以扫描时单列一档，提示的是「**先把规则搬进项目自己的文档，再删指针**」。
 */
const SKILL_INTERNAL_RE = new RegExp(
  `(?:references/(?:${OWN_REF_NAMES.join('|')})\\.md|(?:\\.\\.\\/)*project-forge/scripts/[A-Za-z0-9_.-]+|\\bscripts/(?:survey|compose-agents|equip|equip-ci|backup|review|handoff|sync-toc|update|zip)\\.mjs)`,
  'g',
)

function isVendoredRel(rel) {
  const norm = String(rel ?? '').replace(/\\/g, '/')
  return /(?:^|\/)(?:vendor|third_party)(?:\/|$)/i.test(norm)
    || /(?:^|\/)vscode-web\/extensions(?:\/|$)/i.test(norm)
}

function isSelfScan(root) {
  return samePath(resolve(root), SKILL_ROOT)
}

/** skill 自己的那几处产物目录：它们的标记是语法与讲解，不是留在别人项目里的痕迹。 */
function isSkillOwnPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  return p.startsWith('templates/') || p.startsWith('references/') || p === 'SKILL.md'
}

const LOCKFILE_NAMES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'deno.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Cargo.lock', 'go.sum',
  'gradle.lockfile', 'packages.lock.json', 'Gemfile.lock', 'composer.lock', 'flake.lock',
  'Package.resolved', 'mix.lock', 'Podfile.lock', 'pubspec.lock', 'pdm.lock', 'rye.lock', 'pixi.lock',
])

function isLockfileName(name) {
  return LOCKFILE_NAMES.has(name) || /(?:^|-)lock\.[^/]+$|\.lock$/i.test(name)
}

function isNonEngineeringLargeAsset(rel) {
  const norm = String(rel ?? '').replace(/\\/g, '/')
  if (/\.(?:svg|map|min\.[^/]+|geojson|topojson|sarif|har|jsonl|ndjson|snap)$/i.test(norm)) return true
  if (/(?:^|\/)(?:assets|static|public|data|locales|i18n|fixtures|testdata|__snapshots__|snapshots|schemas)(?:\/|$)/i.test(norm)
    && /\.(?:json|txt|ya?ml)$/i.test(norm)) {
    return true
  }
  return /\.json$/i.test(norm) && !/(?:^|\/)\.pf-manifest\.json$/i.test(norm)
}

const FORGE_OWNED_SYMLINK_EXACT = new Set([
  'AGENTS.md', 'CONTRIBUTING.md', 'RELEASING.md', 'docs/TDD.md', 'docs/feature-map.json',
])
const FORGE_OWNED_SYMLINK_PREFIXES = ['.agents/', '.pf-', '.githooks/', 'docs/prd/', 'docs/specs/', 'docs/todo/', 'docs/archive/']

/** 判定相对路径是否归属 project-forge 托管资产（托管软链须继续按严苛意图校验，非 PF 仓内软链交由 Git 跟踪/忽略语义判定）。 */
export function isForgeOwnedPath(rel) {
  const norm = String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
  if (!norm) return false
  if (isToolOwnedPath(norm)) return true
  if (FORGE_OWNED_SYMLINK_EXACT.has(norm) || /(?:^|\/)AGENTS\.md$/i.test(norm)) return true
  return FORGE_OWNED_SYMLINK_PREFIXES.some((p) => norm.startsWith(p))
}

function collectGitIgnoredPaths(root, rels) {
  if (!Array.isArray(rels) || rels.length === 0) return new Set()
  const res = spawnSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks', 'check-ignore', '-z', '--stdin'], {
    cwd: root,
    input: `${rels.join('\0')}\0`,
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  })
  if (typeof res.stdout !== 'string' || !res.stdout) return new Set()
  return new Set(res.stdout.split('\0').map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))
}

function isIntentionalSymlink(fullPath, canonRoot) {
  try {
    const rawTarget = readlinkSync(fullPath).replace(/\\/g, '/')
    const baseName = basename(fullPath).toLowerCase()
    const targetBase = basename(rawTarget).toLowerCase()
    const isDepOrAgentTarget = /(?:^|\/)(?:node_modules|\.pnpm|\.venv|vendor|third_party|\.agents)(?:\/|$)/.test(rawTarget)
      || /(?:^|\/)\.[^/]+\/skills(?:\/|$)/.test(rawTarget)
    const isContractSymlink = baseName === 'agents.md' || targetBase === 'agents.md'
      || baseName === 'skill.md' || targetBase === 'skill.md'
    if (!isDepOrAgentTarget && !isContractSymlink) return false
    if (/(?:^|\/)(?:node_modules|\.pnpm|\.venv|vendor|third_party|\.agents)(?:\/|$)/.test(rawTarget)) {
      return true
    }
    const realTarget = realpathSync(fullPath)
    return isInsideDir(realTarget, canonRoot)
  } catch {
    return false
  }
}

function collectGitTrackedFiles(root) {
  if (!existsSync(join(root, '.git'))) return null
  const top = spawnSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks', 'rev-parse', '--show-toplevel'], {
    cwd: root, encoding: 'utf8', timeout: 5000, windowsHide: true,
  })
  if (top.status !== 0 || !top.stdout?.trim() || !samePath(top.stdout.trim(), root)) return null
  const res = spawnSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks', 'ls-files', '-z'], {
    cwd: root, encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  })
  if (res.status !== 0 || typeof res.stdout !== 'string') return null
  return res.stdout.split('\0').map((p) => p.replace(/\\/g, '/')).filter(Boolean)
}

function subtreeHasUnscannedMarkers(dir, root, canonRoot, seenTracked, state, pendingSymlinks = null) {
  const stack = [dir]
  let visited = 0
  while (stack.length > 0) {
    if (visited > MAX_FILES) return true
    const cur = stack.pop()
    let entries
    try { entries = readdirSync(cur, { withFileTypes: true }) } catch { state.unreadable += 1; return true }
    for (const entry of entries) {
      if (isMacOsMetadata(entry.name) || SKIP_DIRS.has(entry.name)) continue
      visited += 1
      const full = join(cur, entry.name)
      const rel = relative(root, full).split(sep).join('/')
      if (entry.isSymbolicLink()) {
        if (seenTracked.has(rel)) continue
        state.symlinks += 1
        if (isIntentionalSymlink(full, canonRoot)) { state.skippedSymlinks += 1; continue }
        if (pendingSymlinks && !isForgeOwnedPath(rel)) { pendingSymlinks.push(rel); continue }
        return true
      }
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (entry.isFile()) {
        if (isLockfileName(entry.name)) continue
        if (!(SCAN_EXT.test(entry.name) || TEMP_RE.test(entry.name))) continue
        if (!seenTracked.has(rel)) return true
      }
    }
  }
  return false
}

function walk(root) {
  const canonRoot = (() => { try { return realpathSync(root) } catch { return resolve(root) } })()
  const out = []
  const state = {
    truncated: false,
    unreadable: 0,
    skippedLarge: 0,
    skippedVendoredLarge: 0,
    skippedLockfiles: 0,
    skippedLargeAssets: 0,
    skippedSymlinks: 0,
    depthLimited: 0,
    symlinks: 0,
  }
  const seenTracked = new Set()
  const checkAndAddFile = (full, rel, name) => {
    if (isLockfileName(name)) { state.skippedLockfiles += 1; return }
    if (!(SCAN_EXT.test(name) || TEMP_RE.test(name))) return
    if (out.length > MAX_FILES) { state.truncated = true; return }
    let size = 0
    try { size = statSync(full).size } catch { state.unreadable += 1; state.truncated = true; return }
    if (size > MAX_BYTES) {
      if (isVendoredRel(rel)) state.skippedVendoredLarge += 1
      else if (isNonEngineeringLargeAsset(rel)) state.skippedLargeAssets += 1
      else { state.skippedLarge += 1; state.truncated = true }
      return
    }
    out.push(rel)
  }

  const trackedList = collectGitTrackedFiles(root)
  const pendingUntrackedSymlinks = []
  if (trackedList) {
    for (const rel of trackedList) {
      const segs = rel.split('/')
      if (segs.some((s) => isMacOsMetadata(s) || SKIP_DIRS.has(s))) continue
      const full = join(root, ...segs)
      let lst
      try { lst = lstatSync(full) } catch { continue }
      if (lst.isSymbolicLink()) {
        seenTracked.add(rel)
        state.symlinks += 1
        // 非 project-forge 所属且已被 Git 跟踪的合法仓内软链（如测试 fixture 软链）视作项目自有受控资产，不判扫不全
        if (!isForgeOwnedPath(rel) || isIntentionalSymlink(full, canonRoot)) state.skippedSymlinks += 1
        else state.truncated = true
        continue
      }
      if (!lst.isFile()) continue
      seenTracked.add(rel)
      checkAndAddFile(full, rel, segs[segs.length - 1])
    }
  }

  const go = (dir, depth) => {
    if (depth > MAX_DEPTH) {
      state.depthLimited += 1
      if (subtreeHasUnscannedMarkers(dir, root, canonRoot, seenTracked, state, pendingUntrackedSymlinks)) state.truncated = true
      return
    }
    if (out.length > MAX_FILES) { state.truncated = true; return }
    let entries
    // 读不到这一层：它**下面**有多少东西我们一个都不知道。这不是「没有痕迹」，
    // 是「没看见」——所以也算没扫全，不能让结论落到「干净」上。
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { state.unreadable += 1; state.truncated = true; return }
    for (const entry of entries) {
      if (isMacOsMetadata(entry.name) || SKIP_DIRS.has(entry.name)) continue
      const full = join(dir, entry.name)
      // 合法/有意符号链接（指向仓内或依赖目录）豁免不计入 truncated；悬空或越界软链仍标未扫全。
      if (entry.isSymbolicLink()) {
        const rel = relative(root, full).split(sep).join('/')
        if (seenTracked.has(rel)) continue
        state.symlinks += 1
        if (isIntentionalSymlink(full, canonRoot)) { state.skippedSymlinks += 1; continue }
        if (!isForgeOwnedPath(rel) && trackedList !== null) {
          pendingUntrackedSymlinks.push(rel)
        } else {
          state.truncated = true
        }
        continue
      }
      if (entry.isDirectory()) {
        go(full, depth + 1)
      } else if (entry.isFile()) {
        const rel = relative(root, full).split(sep).join('/')
        if (seenTracked.has(rel)) continue
        checkAndAddFile(full, rel, entry.name)
      }
    }
  }
  go(root, 0)
  if (pendingUntrackedSymlinks.length > 0) {
    const ignoredSet = trackedList !== null ? collectGitIgnoredPaths(root, pendingUntrackedSymlinks) : new Set()
    for (const rel of pendingUntrackedSymlinks) {
      if (ignoredSet.has(rel)) state.skippedSymlinks += 1
      else state.truncated = true
    }
  }
  return { files: out, scan: state }
}

/**
 * 扫一遍，返回分类好的痕迹。
 *
 * `clean` 只在「一处痕迹都没有、而且确实扫全了」时为真。这两件事必须分开：
 * 一个大到扫不完的项目，报出来的是「没找到」，而不是「没有」——把这两句混同，
 * 等于用一句假话给一次不可逆动作背书。
 */
export function scan(targetDir, { strictClean = false } = {}) {
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
    const tempPid = TEMP_RE.exec(rel)?.[2]
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
        // 目标项目里（含当前文档所在目录相对路径）真实存在这个路径 → 不是悬空指针。
        if (existsSync(join(root, target)) || existsSync(join(root, dirname(rel), target))) continue
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
    const kitSkillSet = new Set(getKitSkills())
    const customSkills = []
    const skillsDir = join(root, '.agents', 'skills')
    if (existsSync(skillsDir)) {
      try {
        for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
          if (isMacOsMetadata(entry.name) || !entry.isDirectory()) continue
          if (kitSkillSet.has(entry.name) || managedTopDirs.has(entry.name)) continue
          const sub = join(skillsDir, entry.name)
          if (existsSync(join(sub, 'SKILL.md')) || existsSync(join(sub, 'skill.md'))) {
            customSkills.push(entry.name)
          }
        }
      } catch { /* ignore */ }
    }
    kitManifest = {
      path: PF_MANIFEST_REL,
      valid: Boolean(
        manifest
        && (manifest.schemaVersion === 1 || manifest.schemaVersion === 2 || manifest.schemaVersion === 3)
        && manifest.files
        && typeof manifest.files === 'object'
        && !Array.isArray(manifest.files),
      ),
      schemaVersion: manifest?.schemaVersion,
      tier: manifest?.tier,
      forgeVersion: manifest?.forgeVersion,
      managedFiles,
      disabledSkills: Array.isArray(manifest?.disabledSkills) ? manifest.disabledSkills : [],
      customizedFiles: manifest?.customizedFiles && typeof manifest.customizedFiles === 'object'
        ? Object.keys(manifest.customizedFiles).sort()
        : [],
      customSkills: customSkills.sort(),
    }
  }

  const managedActive = Boolean(!strictClean && kitManifest?.valid)
  const managedMarkers = managedActive
    ? markers.filter((m) => /^agents\.md$/i.test(m.file) && (m.kind === 'begin' || m.kind === 'end'))
    : []
  const blockingMarkers = managedActive
    ? markers.filter((m) => !(/^agents\.md$/i.test(m.file) && (m.kind === 'begin' || m.kind === 'end')))
    : markers
  const total = blockingMarkers.length + placeholders.length + legacyMarkers.length
    + legacyPaths.length + danglingPointers.length + deletableTemps.length

  return {
    target: { path: root },
    markers,
    managedMarkers,
    placeholders,
    legacyMarkers,
    legacyPaths,
    danglingPointers,
    staleTemps,
    ...(kitManifest ? { kitManifest } : {}),
    strictClean: Boolean(strictClean),
    managedMode: managedActive,
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
    if (result.kitManifest) {
      const km = result.kitManifest
      lines.push('')
      lines.push(`已保留 \`.agents/skills/\` 本地研发套件（清单 \`${km.path}\` v${km.schemaVersion ?? 1}，不计入残留痕迹）。`)
      if ((result.managedMarkers?.length ?? 0) > 0) {
        lines.push(`已保留持续 \`--upgrade\` 受管态 \`AGENTS.md\` 区间标记（${result.managedMarkers.length} 处；如需彻底剥离请传 \`--strict-clean\`）。`)
      }
      if (km.customSkills.length > 0) {
        lines.push(`检测到项目自定义技能（已完整保留）：${km.customSkills.join('、')}`)
      }
    }
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
  if ((result.scanCoverage?.skippedVendoredLarge ?? 0) > 0) {
    lines.push(`- 已跳过 ${result.scanCoverage.skippedVendoredLarge} 个嵌入第三方目录（vendor/third_party/vscode-web/extensions）大文件，不计入截断漏扫。`)
  }
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
  let strictClean = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/handoff.mjs [项目目录] [选项]',
        '',
        '  --scan          列出本 skill 留下的痕迹（默认）',
        `  --verify        判「已经干净」：干净 ${VERIFY_EXIT.clean} / 有痕迹 ${VERIFY_EXIT.dirty}`
          + ` / 没扫全 ${VERIFY_EXIT.truncated} / 不适用（skill 自己的仓库）${VERIFY_EXIT.notApplicable}`,
        '  --strict-clean  即使存在有效 .pf-manifest.json 也要求剥离全部受管标记',
        '  --json          输出机器可读结果',
        '',
        `只读：不删任何东西。退出码 ${VERIFY_EXIT.truncated} 是「这一趟没扫完」、`
          + `${VERIFY_EXIT.notApplicable} 是「这一趟不适用」，都不是干净。`,
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--verify') verify = true
    else if (arg === '--scan') { /* 默认模式，显式写出来是为了让人知道有这个动作 */ }
    else if (arg === '--strict-clean') strictClean = true
    else if (arg === '--json') asJson = true
    else if (!arg.startsWith('-')) target = arg
    else {
      process.stderr.write(`未知选项：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    const result = scan(target, { strictClean })
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

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  void flushAndExit(main(process.argv.slice(2)))
}
