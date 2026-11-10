#!/usr/bin/env node
/**
 * preflight.mjs —— 这个 skill 自己的结构自检。
 *
 * ## 它查什么，不查什么
 *
 * 只查**坏了会让用户拿到一个用不了、或者说假话的产物**的东西。风格偏好、措辞一致性、
 * 文档里的中文数字与列表项数对不对得上——一律不查。那些检查的代价是「改一句文档就红」，
 * 而它们换来的防线，一条真正的判据都换不来。
 *
 * 六类：
 *   1. 入口能被宿主认出来：frontmatter 合法、`name` 与目录名一致、体积在预算内
 *   2. 引用不断链：文档里提到的每个相对路径都真实存在；每份参考有标题与「何时读本文件」
 *   3. 零依赖：`scripts/` 只用内置模块，每个脚本能解析
 *   4. 会跑的都真跑：几个入口脚本的 `--help` 能跑通
 *   5. 端到端冒烟：在临时项目上跑一遍勘察 → 生成 → 体检 → 交棒
 *   6. 卫生：无 BOM、无 emoji、无本机绝对路径
 *
 * ## 为什么它这么短
 *
 * 上一版有 3,636 行，配套的行为夹具 6,955 行——比它检查的产品代码还长。而它检查的内容
 * 里有「注释里的四字词组」「中文数字与列表项数是否一致」这类东西，任何正常的文档润色
 * 都会让它红。
 *
 * 判据：**一条检查如果被削成恒真也不会有任何东西变坏，它就不该存在。**
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FULL_READ_MAX_LINES, FULL_READ_REFS, REFS_MAX_LINES, REPO_ONLY_DIRS, REPO_ONLY_FILES,
  SKILL_MAX_BYTES, SKILL_MAX_LINES, isRepoOnlyPath,
} from '../lib/protocol.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const failures = []
const notes = []
const fail = (msg) => failures.push(msg)
const note = (msg) => notes.push(msg)

function rel(p) {
  return relative(ROOT, p).split('\\').join('/')
}

function readText(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
}

function countLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * 读 frontmatter 里的一个标量，**支持块标量**（`key: |` 后面跟缩进的若干行）。
 *
 * 只读一行会把 `description: |` 读成两个字 —— 于是「描述太短」的检查会在一份完全合格的
 * 入口上报错，而修法看起来是「把描述写成一行」，那反而更难读。
 */
function readBlockScalar(block, key) {
  const lines = block.split('\n')
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l))
  if (idx < 0) return undefined
  const inline = lines[idx].slice(`${key}:`.length).trim()
  if (inline !== '' && inline !== '|' && inline !== '>') return inline.replace(/^["']|["']$/g, '')
  const body = []
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) break
    body.push(lines[i].trim())
  }
  return body.join(' ').trim() || undefined
}

function walk(dir, pred) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, pred))
    else if (entry.isFile() && (pred === undefined || pred(full))) out.push(full)
  }
  return out
}

// ── 1. 入口 ─────────────────────────────────────────────────────────

function checkEntry() {
  const skillPath = join(ROOT, 'SKILL.md')
  if (!existsSync(skillPath)) {
    fail('缺少 SKILL.md')
    return
  }
  const text = readText(skillPath)
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = countLines(text)

  if (lines > SKILL_MAX_LINES) {
    fail(`SKILL.md 有 ${lines} 行，超过预算 ${SKILL_MAX_LINES} 行——入口每多一行，每一次任务都要多付一次`)
  }
  if (bytes > SKILL_MAX_BYTES) {
    fail(`SKILL.md 有 ${bytes} 字节，超过预算 ${SKILL_MAX_BYTES} 字节`)
  }

  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
  if (!fm) {
    fail('SKILL.md 缺少 frontmatter（首行的 ---）')
    return
  }
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
  // `description` 允许写成块标量（`|` / `>` 后面跟缩进的若干行），那是常见写法，
  // 所以取「这一行之后所有缩进更深的行」拼起来，而不是只读这一行。
  const desc = readBlockScalar(fm[1], 'description')
  if (!name) fail('frontmatter 缺 name')
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      fail(`frontmatter 的 name「${name}」不合法：只能小写字母、数字、连字符`)
    }
    if (name !== basename(ROOT)) {
      fail(`frontmatter 的 name「${name}」与目录名「${basename(ROOT)}」不一致——宿主按目录名发现它`)
    }
  }
  if (!desc || desc.length < 20) fail('frontmatter 缺 description，或它太短（宿主靠它决定要不要加载）')

  // 驼峰旧键会让整份被丢弃。这一条值得单独查：症状是「装了但不生效」，没有任何报错。
  const camel = fm[1].match(/^[a-zA-Z]*[a-z][A-Z][a-zA-Z]*:/m)
  if (camel) fail(`frontmatter 里有驼峰键「${camel[0].replace(':', '')}」——扩展键一律用连字符形式，驼峰会让整份被丢弃`)

  note(`入口：${lines} 行 / ${bytes} 字节（预算 ${SKILL_MAX_LINES} 行 / ${SKILL_MAX_BYTES} 字节）`)
}

// ── 2. 引用与预算 ───────────────────────────────────────────────────

const PATH_RE = /\b((?:references|templates|scripts)\/[A-Za-z0-9_./-]+\.(?:md|mjs|ya?ml|txt|json))\b/g

function docsToScan() {
  const refs = walk(join(ROOT, 'references'), (f) => f.endsWith('.md'))
  return [join(ROOT, 'SKILL.md'), ...refs]
}

function checkLinks() {
  const refDir = join(ROOT, 'references')
  const refs = walk(refDir, (f) => f.endsWith('.md'))
  if (refs.length === 0) fail('references/ 下没有任何 Markdown 文件')

  for (const file of refs) {
    const name = rel(file)
    const text = readText(file)
    if (!text.startsWith('# ')) fail(`${name} 的首行必须是一级标题`)
    if (!/^##\s+何时读本文件/m.test(text)) {
      fail(`${name} 缺「## 何时读本文件」——没有它，AI 不知道什么时候该读这一份`)
    }
  }

  const seen = new Set()
  for (const doc of docsToScan()) {
    if (!existsSync(doc)) continue
    const name = rel(doc)
    const text = readText(doc)
    for (const m of text.matchAll(PATH_RE)) {
      const target = m[1]
      if (target.includes('*')) continue
      seen.add(target)
      if (!existsSync(join(ROOT, target))) {
        fail(`${name} 引用了不存在的路径：${target}`)
      }
    }
  }

  // 反过来：每个模板都要有人指得到。「写了却没人指得到」等于没写。
  //
  // 一个例外：**许可证全文按家族提到一次就够**。五种 SPDX 文本不是五个独立产物，
  // 它们是同一格的候选值——要求逐个列出名字，只是在逼文档写一张会过期的清单。
  const licenseFamily = /templates\/license-<[^>]+>\.txt/
  const licenseMentioned = docsToScan().some((doc) => existsSync(doc) && licenseFamily.test(readText(doc)))
  for (const file of walk(join(ROOT, 'templates'), () => true)) {
    const target = rel(file)
    if (seen.has(target)) continue
    if (/^templates\/license-.+\.txt$/.test(target) && licenseMentioned) continue
    fail(`${target} 没有被任何文档提到——写了却没人指得到，等于没写`)
  }

  const refLines = refs.reduce((sum, f) => sum + countLines(readText(f)), 0)
  if (refLines > REFS_MAX_LINES) fail(`references/ 合计 ${refLines} 行，超过预算 ${REFS_MAX_LINES} 行`)
  note(`参考文档：${refs.length} 篇 / ${refLines} 行`)

  let fullRead = countLines(readText(join(ROOT, 'SKILL.md')))
  for (const refPath of FULL_READ_REFS) {
    const p = join(ROOT, refPath)
    if (!existsSync(p)) { fail(`预算表里列的 ${refPath} 不存在`); continue }
    fullRead += countLines(readText(p))
  }
  if (fullRead > FULL_READ_MAX_LINES) {
    fail(`一次全量任务要读 ${fullRead} 行，超过预算 ${FULL_READ_MAX_LINES} 行——注意力被稀释的直接来源`)
  }
  note(`全量必读：${fullRead} 行（预算 ${FULL_READ_MAX_LINES}）`)
}

// ── 3. 零依赖与可解析 ───────────────────────────────────────────────

function checkScripts() {
  const scripts = walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs'))
  if (scripts.length === 0) { fail('scripts/ 下没有任何 .mjs'); return }

  for (const file of scripts) {
    const name = rel(file)
    const text = readText(file)
    for (const m of text.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1]
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue
      fail(`${name} 引入了非内置模块「${spec}」——必须保持零第三方依赖`)
    }
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (syntax.status !== 0) {
      fail(`${name} 语法错误：${(syntax.stderr || '').split('\n').slice(0, 3).join(' ')}`)
    }
  }
  note(`脚本：${scripts.length} 个，全是内置依赖、语法都能解析`)
}

// ── 4. 会跑的都真跑 ─────────────────────────────────────────────────

function checkHelps() {
  for (const name of ['survey.mjs', 'compose-agents.mjs', 'review.mjs', 'handoff.mjs', 'sync-toc.mjs']) {
    const p = join(ROOT, 'scripts', name)
    if (!existsSync(p)) { fail(`缺脚本 ${name}`); continue }
    const res = spawnSync(process.execPath, [p, '--help'], { encoding: 'utf8', timeout: 20000 })
    if (res.status !== 0) {
      fail(`${name} --help 跑不通（退出 ${res.status}）：${(res.stderr || '').trim().split('\n')[0]}`)
      continue
    }
    if (!/用法/.test(res.stdout || '')) fail(`${name} --help 没打印用法`)
  }
}

// ── 5. 端到端冒烟 ───────────────────────────────────────────────────

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8', timeout: 120000, ...opts,
  })
}

function smoke() {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-smoke-'))
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'demo-app', version: '0.1.0', private: true,
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2))
    writeFileSync(join(tmp, 'README.md'), '# demo-app\n\n一个用来跑冒烟验证的示例项目，说明足够长。\n')
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n')

    const s = run('survey.mjs', [tmp])
    if (s.status !== 0) { fail(`survey 冒烟失败：${(s.stderr || '').trim()}`); return }
    let facts
    try { facts = JSON.parse(s.stdout) } catch { fail('survey 的输出不是 JSON'); return }
    for (const field of ['maturity', 'git', 'ecosystem', 'commands', 'docs', 'risks', 'gaps', 'questions']) {
      if (facts[field] === undefined) fail(`survey 的输出缺字段 ${field}`)
    }
    if (facts.maturity !== 'greenfield') fail(`空白项目的 maturity 应为 greenfield，实际是 ${facts.maturity}`)
    if (!facts.ecosystem.kinds.includes('node')) fail(`应识别出 node 生态，实际是 ${facts.ecosystem.kinds.join(',')}`)

    const c1 = run('compose-agents.mjs', [tmp])
    if (c1.status !== 0 || !existsSync(join(tmp, 'AGENTS.md'))) { fail('compose-agents 没生成 AGENTS.md'); return }

    // 幂等：第二遍字节必须相同。
    const before = readFileSync(join(tmp, 'AGENTS.md'))
    const c2 = run('compose-agents.mjs', [tmp])
    if (c2.status !== 0) fail('compose-agents 第二遍跑失败')
    const after = readFileSync(join(tmp, 'AGENTS.md'))
    if (!before.equals(after)) fail('compose-agents 不幂等：第二遍改了文件')

    // 未填占位时 --check 必须红。
    const check1 = run('compose-agents.mjs', [tmp, '--check'])
    if (check1.status === 0) fail('AGENTS.md 还有未填占位，但 --check 放行了')

    // 侵入面：不能出现隐藏目录与被拷进来的脚本。
    for (const bad of ['.project-forge', join('scripts', 'review-record.mjs')]) {
      if (existsSync(join(tmp, bad))) fail(`compose-agents 在目标项目里留下了 ${bad}——侵入面必须为零`)
    }

    // 体检能跑，且能认出未填占位。
    const r = run('review.mjs', [tmp])
    if (!/交付体检/.test(r.stdout || '')) fail('review 没输出体检报告')
    if (!/没填|未填|fill/.test(r.stdout || '')) fail('review 没报出 AGENTS.md 里未填的占位')

    // 交棒能扫到标记，剥掉之后能判干净。
    const h1 = run('handoff.mjs', [tmp, '--verify'])
    if (h1.status === 0) fail('AGENTS.md 里还有标记，handoff --verify 却说干净')
    run('compose-agents.mjs', [tmp, '--clean'])
    const h2 = run('handoff.mjs', [tmp, '--verify'])
    if (h2.status !== 0) fail(`剥掉标记之后 handoff --verify 仍说脏：${(h2.stdout || '').trim()}`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  note('端到端：勘察 → 生成（幂等）→ 门禁 → 体检 → 交棒，全跑通')
}

// ── 6. 卫生 ─────────────────────────────────────────────────────────

const EMOJI_RE = /\p{Extended_Pictographic}/u

function checkHygiene() {
  const files = walk(ROOT, (f) => /\.(?:md|mjs|ya?ml|json|txt)$/i.test(f))
  const home = homedir().replace(/\\/g, '/')
  const homeRe = home.length > 4 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined
  for (const file of files) {
    const name = rel(file)
    const raw = readFileSync(file, 'utf8')
    if (raw.startsWith('\uFEFF')) fail(`${name} 有 UTF-8 BOM`)
    if (EMOJI_RE.test(raw)) fail(`${name} 有 emoji 字符`)
    if (homeRe && homeRe.test(raw)) fail(`${name} 里有本机绝对路径`)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────

function main() {
  const argv = process.argv.slice(2)
  const pkgIndex = argv.indexOf('--package')
  if (pkgIndex >= 0) {
    const listPath = argv[pkgIndex + 1]
    if (!listPath) {
      process.stderr.write('用法：node scripts/dev/preflight.mjs --package <条目清单文件>\n')
      return 2
    }
    return checkPackage(listPath)
  }

  checkEntry()
  checkLinks()
  checkScripts()
  checkStructureRules()
  checkHelps()
  smoke()
  checkHygiene()

  for (const n of notes) process.stdout.write(`  ${n}\n`)
  if (failures.length === 0) {
    process.stdout.write(`\n自检通过：0 项失败（${notes.length} 项读数）。\n`)
    return 0
  }
  process.stderr.write('\n')
  for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
  process.stderr.write(`\n自检未通过：${failures.length} 项失败。\n`)
  return 1
}

/**
 * `.gitattributes` 与 `REPO_ONLY_*` 必须说同一件事。
 *
 * 两处各写一份是刻意的：前者是 git 认识的文本形态，后者是代码里要用的。但**两份真相
 * 迟早会漂**，所以核对这一步不能省。不核对时的症状是：某个目录明明只服务本仓库，
 * 却出现在用户包里——而拿到包的人打开一看是个他看不懂的协作设施。
 */
function checkStructureRules() {
  const attrs = readText(join(ROOT, '.gitattributes')).replace(/\r\n/g, '\n')
  const ignored = attrs.split('\n')
    .map((line) => /^\s*\/?(\S+?)\s+export-ignore\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1].replace(/^\/+/, '').replace(/\/+$/, ''))

  const codeDirs = REPO_ONLY_DIRS.map((d) => d.replace(/\/$/, ''))
  const codeFiles = [...REPO_ONLY_FILES]

  for (const d of ignored) {
    if (codeDirs.includes(d) || codeFiles.includes(d)) continue
    fail(`.gitattributes 排除了 ${d}，而 REPO_ONLY_* 里没有它——两处说法不一致`)
  }
  for (const d of codeDirs) {
    if (ignored.includes(d)) continue
    fail(`REPO_ONLY_DIRS 里有 ${d}，而 .gitattributes 没排除它`)
  }
  for (const f of codeFiles) {
    if (ignored.includes(f)) continue
    fail(`REPO_ONLY_FILES 里有 ${f}，而 .gitattributes 没排除它`)
  }
  note(`结构规则：.gitattributes 与 REPO_ONLY_* 一致（${codeDirs.length} 处目录、${codeFiles.length} 个文件）`)
}

/**
 * 核对真跑出来的那份用户包。
 *
 * 条目清单来自 `git archive`（CI 里生成），这里只做一件事：**每个条目要么属于产品层，
 * 要么命中「不进包」的结构规则**。两处都不占的那个条目就是「没有归属」——它出现在包里
 * 但没人知道该不该在，而这一条抓的正是「清单漏一行」那类问题。
 *
 * 结构规则在 `lib/protocol.mjs` 里（与 `.gitattributes` 同源，`checkLinks` 之外的
 * 一条独立判据）。这里不自己翻译 `.gitattributes`：那等于维护第二份真相。
 */
function checkPackage(listPath) {
  if (!existsSync(listPath)) {
    process.stderr.write(`找不到条目清单：${listPath}\n`)
    return 2
  }
  const entries = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) {
    process.stderr.write('条目清单是空的——`git archive` 那一步失败时，空清单会被读成「没漏」，那是假绿。\n')
    return 1
  }

  const leaked = entries.filter((e) => isRepoOnlyPath(e) || e.startsWith('.github/'))
  if (leaked.length > 0) {
    for (const e of leaked) process.stderr.write(`FAIL  ${e} 属于「不进包」的结构规则，却出现在用户包里\n`)
    process.stderr.write(`\n用户包核对未通过：${leaked.length} 个条目不该在包里。\n`)
    return 1
  }

  // 必需项：没有它们，拿到包的人用不了。
  let missingRequired = 0
  const required = ['SKILL.md', 'LICENSE', 'README.md']
  for (const r of required) {
    if (entries.includes(r)) continue
    process.stderr.write(`FAIL  用户包里没有 ${r}\n`)
    missingRequired += 1
  }

  if (missingRequired > 0) {
    process.stderr.write(`\n用户包核对未通过：缺 ${missingRequired} 个必需项。\n`)
    return 1
  }
  process.stdout.write(`用户包：${entries.length} 个条目，没有越界，必需项齐全。\n`)
  return 0
}

process.exit(main())
