#!/usr/bin/env node
/**
 * selftest.mjs —— 行为自检
 *
 * preflight.mjs 检查的是**结构性**契约（引用完整、内核一致、规范合规），它抓不到
 * 「判定逻辑写错了」这类问题——因为静态检查看不出 survey 把 CMake 项目判成了纯文档目录。
 *
 * 这个脚本补上另一半：**造出能证伪每条判定的 fixture，实跑，断言结果**。
 * 「静态检查全绿、实际行为错误」的判定缺陷只有实跑才能暴露，而手工造一次 fixture
 * 就丢，下一个改动会把同样的错误再引入一遍。所以把它固化成常驻检查。
 *
 * 用法：node scripts/selftest.mjs
 * 退出码 0 = 全部通过；1 = 有失败。临时 fixture 用完即删。
 */

import {
  mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync, symlinkSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import {
  evalFreshnessMarker, FRESHNESS_STALE_DAYS, listRepoFiles,
  normVersion, compareHostMarker, parseMarkerKeys, hostDateBatchStatus,
  freshnessSectionBody, hasActionableSources,
} from './preflight.mjs'
import { isMainModule, authorMarkers, parseGitHubRepo, kindVocabulary } from './survey.mjs'
import { badgeVerdict, tierSecrets, unhandledRiskKeys } from './review.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const ROOT = join(tmpdir(), `project-forge-selftest-${process.pid}`)

/**
 * 夹具里的「凭据形状」一律**运行时拼出**，不在源码里留字面量。
 *
 * 为什么：这个仓库自己的源码也会被自己的密钥扫描扫到，而交付门禁对**已跟踪**的命中
 * 一律报缺——于是本仓库跑 `review.mjs .` 永远带着一条假「凭据」缺，而唯一的消项 flag
 * 语义（"确认为占位或测试数据"）与它并不对应。拼出来两边都干净：扫描器仍被这些夹具
 * 证明有效，仓库里不再存凭据形状的字符串。
 */
const FAKE_GH_TOKEN = `ghp_${'a'.repeat(36)}`
const FAKE_NPM_TOKEN = `npm_${'b'.repeat(36)}`
const FAKE_AWS_KEY = `AKIA${'C'.repeat(16)}`
// 锚点用例里要放一个 emoji（验证它不进锚点）。emoji 一律**运行时拼出**：
// 源码里留一个图形字符会被 preflight 的「禁 emoji」判红——那是项目的硬性规范。
const FAKE_EMOJI = String.fromCodePoint(0x1f680)

/**
 * 环境能力探测。
 *
 * 「有没有 git」直接决定哪些断言可以跑：没有 git 时，`git init` 不起作用，涉及仓库
 * 状态的断言会全部失败——**那是环境缺失，不是代码缺陷**。把它们报成失败会误导人，
 * 也会让人开始怀疑一个其实正确的实现。所以按能力分组跳过，并说明跳过了什么。
 */
const HAS_GIT = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
  return r.error === undefined && r.status === 0
})()

let passed = 0
let failed = 0
let skipped = 0
const failures = []
const skips = []

function check(ok, label, detail) {
  if (ok) { passed += 1; return }
  failed += 1
  failures.push(`${label}${detail === undefined ? '' : `  —— ${detail}`}`)
}

/** 整组跳过（环境不具备），与「断言失败」严格区分。 */
function skipGroup(title, why) {
  skipped += 1
  skips.push(`${title}（${why}）`)
  process.stdout.write(`\n${title}\n  跳过：${why}\n`)
}

function group(title) {
  process.stdout.write(`\n${title}\n`)
}

function report(ok, label) {
  process.stdout.write(`  ${ok ? '通过' : '失败'}  ${label}\n`)
}

/** 造一个 fixture 目录。files 的键是相对路径。 */
function fixture(name, files) {
  const dir = join(ROOT, name)
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, content, 'utf8')
  }
  mkdirSync(dir, { recursive: true })
  return dir
}

function survey(dir, ...extra) {
  const r = spawnSync(process.execPath, [join(HERE, 'survey.mjs'), dir, '--json', ...extra],
    { encoding: 'utf8' })
  if (r.status !== 0) return { error: (r.stderr ?? '').slice(0, 300) }
  try {
    return JSON.parse((r.stdout ?? '').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { error: `输出不是合法 JSON：${error.message}` }
  }
}

function compose(dir, ...extra) {
  return spawnSync(process.execPath, [join(HERE, 'compose-agents.mjs'), dir, ...extra],
    { encoding: 'utf8' })
}

/** 把一棵目录树整份复制到 dest（跳过 skip 里的名字）。端到端跑 preflight 时用。 */
function copyTree(src, dest, skip = new Set()) {
  mkdirSync(dest, { recursive: true })
  for (const e of readdirSync(src, { withFileTypes: true, encoding: 'utf8' })) {
    if (skip.has(e.name)) continue
    const from = join(src, e.name)
    const to = join(dest, e.name)
    if (e.isDirectory()) { copyTree(from, to, skip); continue }
    if (e.isFile()) copyFileSync(from, to)
  }
}

/** 在 fixture 里跑 git，用来造仓库状态。 */
function gitIn(dir, ...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
}

/** 在某个目录里跑真实的 preflight.mjs——它按脚本自身位置推导检查对象。 */
function preflightIn(dir) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'preflight.mjs')],
    { encoding: 'utf8', windowsHide: true })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

/**
 * 端到端自检用的 selftest 替身。
 *
 * 真实 selftest 会跑 preflight，而 preflight 又会跑 selftest —— 直接套娃。
 * 这里只提供 preflight 期望的那一行摘要，让「脚本真的能跑起来」这条检查有事可做。
 */
const SELFTEST_STUB = [
  '#!/usr/bin/env node',
  '// preflight 的端到端 fixture 专用替身：只输出摘要行，不做任何检查。',
  '// 用途是让 preflight 的「脚本真的能跑起来」那一步有输出可断言，',
  '// 同时避免 preflight 与 selftest 互相调用造成无限递归。',
  'process.stdout.write("行为自检：0 项通过，0 项失败\\n")',
  '',
].join('\n')

// ── 一、未初始化 git 时的密钥扫描（曾静默退化成只扫顶层） ────────────────────

group('[1] 无 git 仓库时的密钥扫描必须覆盖子目录')
{
  const dir = fixture('secrets', {
    'README.md': '# app\n',
    'src/config.py': `API_KEY = "${FAKE_GH_TOKEN}"\n`,
    'tests/fixtures/token.json': `{"t":"${FAKE_NPM_TOKEN}"}\n`,
    'bin/.env': `AWS_KEY=${FAKE_AWS_KEY}\n`,
    '中文目录/泄漏.txt': `token = "${FAKE_GH_TOKEN}"\n`,
  })
  const s = survey(dir)
  const hits = (s.risks?.secretContent ?? []).map((h) => h.path).join(' ')
  check(s.git?.present !== true, '前置：目录确实没有 git 仓库', JSON.stringify(s.git?.present))
  check(/config\.py/.test(hits), '扫到子目录 src/config.py', hits)
  check(/token\.json/.test(hits), '扫到深层 tests/fixtures/', hits)
  check(/\.env/.test(hits), '扫到 bin/.env（像产物但可能藏源码的目录）', hits)
  check(/泄漏/.test(hits), '扫到非 ASCII 路径（git 默认会转义它）', hits)
  check(typeof s.risks?.contentScan?.filesScanned === 'number',
    '报告了扫描覆盖范围（「没报」与「没扫」必须可区分）')
  // 深度超限：25 层嵌套必触发 depthLimited，“没扫到深层”不能读成干净
  const deepFiles = {}
  let deepPath = ''
  for (let i = 0; i < 25; i += 1) deepPath += `d${i}/`
  deepFiles[`${deepPath}deep.py`] = 'x = 1\n'
  const deepDir = fixture('deep-limit', deepFiles)
  const sd = survey(deepDir)
  const okDepth = (sd.risks?.contentScan?.depthLimited ?? 0) > 0
  check(okDepth, '超深目录 → depthLimited 计数大于 0', JSON.stringify(sd.risks?.contentScan?.depthLimited))
  report(okDepth, '深度超限：如实标记')
  // 文件数超限：超 5000 候选必触发 truncated，“0 命中”不能读成干净
  const manyFiles = {}
  for (let i = 0; i < 5100; i += 1) manyFiles[`f${String(i).padStart(4, '0')}.txt`] = 'x\n'
  const manyDir = fixture('many-files', manyFiles)
  const sm = survey(manyDir)
  const okTrunc = sm.risks?.contentScan?.truncated === true
  check(okTrunc, '超量文件 → truncated 为真', String(sm.risks?.contentScan?.filesScanned))
  report(okTrunc, '文件超限：如实标记')
  for (const [label, ok] of [['密钥覆盖子目录', /config\.py/.test(hits)],
    ['密钥覆盖 bin/', /\.env/.test(hits)], ['密钥覆盖中文路径', /泄漏/.test(hits)]]) report(ok, label)
}

// ── 二、仓库边界（曾把外层仓库的远端当成目标目录的） ─────────────────────────

if (!HAS_GIT) {
  skipGroup('[2] 目录在别人的仓库里时必须识别出来', '环境里没有 git')
} else {
group('[2] 目录在别人的仓库里时必须识别出来')
{
  const outer = fixture('outer', { 'inner/README.md': '# inner\n', 'outer.txt': 'x\n' })
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.invalid/o.git'],
    ['config', 'user.name', 'T'], ['config', 'user.email', 't@example.com']]) {
    spawnSync('git', args, { cwd: outer })
  }
  spawnSync('git', ['add', '-A'], { cwd: outer })
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: outer })

  const inner = join(outer, 'inner')
  const s = survey(inner)
  check(s.git?.isRepoRoot === false, '子目录 → isRepoRoot 为假',
    String(s.git?.isRepoRoot))
  check(typeof s.git?.note === 'string', '带 note 说明这些值属于外层仓库')
  check(s.git?.remote !== undefined, '（外层仓库确实有远端，说明这个误判有实际后果）')
  report(s.git?.isRepoRoot === false, '子目录不被当成仓库根')
}
}

if (!HAS_GIT) {
  skipGroup('[3] 仓库根的各种路径写法都必须判真', '环境里没有 git')
} else {
group('[3] 仓库根的各种路径写法都必须判真')
{
  const repo = fixture('repo-root', { 'README.md': '# r\n' })
  for (const args of [['init', '-q'], ['config', 'user.name', 'T'],
    ['config', 'user.email', 't@example.com']]) spawnSync('git', args, { cwd: repo })
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

  const cases = [
    ['精确路径', repo],
    ['正斜杠', repo.replace(/\\/g, '/')],
    ['结尾分隔符', repo + (process.platform === 'win32' ? '\\' : '/')],
  ]
  // 大小写只在**大小写不敏感的**文件系统上才该判真。在 Linux 上，全大写的路径是一个
  // 真正不存在的路径，判假才是对的。所以这一条按平台能力条件化——把 Windows 的行为
  // 当成所有平台的行为，测试本身就成了错的（CI 在 Ubuntu 上就是这样红的）。
  const caseInsensitive = existsSync(repo.toUpperCase())
  if (caseInsensitive) cases.push(['大小写变化', repo.toUpperCase()])

  for (const [label, p] of cases) {
    const ok = survey(p).git?.isRepoRoot === true
    check(ok, `${label} → true`)
    report(ok, label)
  }
  process.stdout.write(`  （本机文件系统${caseInsensitive ? '不区分' : '区分'}大小写，`
    + `${caseInsensitive ? '已' : '未'}断言大小写场景）\n`)
}
}

// ── 四、生态判定（曾把有代码的项目判成纯文档目录） ───────────────────────────

group('[4] 生态判定：代码在子目录里也不能判成纯文档')
{
  const cases = [
    ['readme+src', { 'README.md': '# x\n', 'src/app.js': 'export const a=1\n' }, 'node'],
    ['cmake', { 'README.md': '# x\n', 'src/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\n', 'src/main.cpp': 'int main(){return 0;}\n' }, 'cpp'],
    ['monorepo', { 'README.md': '# x\n', 'packages/a/package.json': '{"name":"a"}\n' }, 'node'],
    ['plugin-no-manifest', { 'README.md': '# x\n', 'cordis.patch.yml': '- id: f\n' }, 'dsh-plugin'],
  ]
  for (const [name, files, expect] of cases) {
    const dir = fixture(`eco-${name}`, files)
    const kinds = survey(dir).ecosystem?.kinds ?? []
    const ok = kinds.includes(expect) && !kinds.includes('docs-only')
    check(ok, `${name} → ${expect} 且不是 docs-only`, JSON.stringify(kinds))
    report(ok, `${name} → ${expect}`)
  }
}

group('[5] 生态判定：纯文档目录仍要判成 docs-only')
{
  const cases = [
    ['only-md', { 'README.md': '# x\n', 'GUIDE.md': '# y\n' }],
    ['with-license', { 'README.md': '# x\n', 'LICENSE': 'MIT\n' }],
    ['with-gitignore', { 'README.md': '# x\n', '.gitignore': 'node_modules/\n' }],
  ]
  for (const [name, files] of cases) {
    const dir = fixture(`docs-${name}`, files)
    const kinds = survey(dir).ecosystem?.kinds ?? []
    const ok = kinds.includes('docs-only')
    check(ok, `${name} → docs-only`, JSON.stringify(kinds))
    report(ok, `${name} → docs-only`)
  }
  // 边界另一侧：陌生非文档文件不是纯文档，空目录不是“没扫到”
  const unrec = survey(fixture('docs-unrec', { 'README.md': '# x\n', 'data.xyz': '???\n' }))
  const okU = (unrec.ecosystem?.kinds ?? []).includes('unrecognized')
  check(okU, '陌生文件 → unrecognized（不误判 docs-only 跳过发布链）', JSON.stringify(unrec.ecosystem?.kinds))
  report(okU, '陌生文件 → unrecognized')
  const unk = survey(fixture('docs-empty', {}))
  const okN = (unk.ecosystem?.kinds ?? []).includes('unknown')
  check(okN, '空目录 → unknown（停下问，不编生态）', JSON.stringify(unk.ecosystem?.kinds))
  report(okN, '空目录 → unknown')
}

// ── 六、AGENTS.md 生成与刷新 ────────────────────────────────────────────────

group('[6] 生成：按项目事实取舍条件段落')
{
  const dir = fixture('gen', {
    'package.json': JSON.stringify({
      name: '@scope/my-tool', version: '0.1.0',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2),
    'src/index.ts': 'export const x = 1\n',
  })
  compose(dir)
  const t = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  const checks = [
    ['标题用清单里的包名而非目录名', /^# my-tool — /m.test(t)],
    ['自动填入构建命令', /npm run build/.test(t)],
    ['自动填入测试命令', /npm run test/.test(t)],
    ['含版本管理节', /^## 版本管理（必守）$/m.test(t)],
    ['含提交纪律（与发布无关，必须总有）', /^### 提交纪律$/m.test(t)],
    ['含回滚分档（与发布无关，必须总有）', /^### 回滚分档$/m.test(t)],
    ['含版本号语义（有清单 → 可发布）', /^### 版本号语义$/m.test(t)],
    ['含依赖版本同步', /^## 依赖版本同步$/m.test(t)],
    ['无远端 → 不含角色判定', !/^### 角色判定$/m.test(t)],
    ['无残留条件标记', !/<!--\s*pf:(if|endif)/.test(t)],
    ['无连续 3 行以上空行', !/\n{3,}/.test(t)],
  ]
  for (const [label, ok] of checks) { check(ok, label); report(ok, label) }
  // 另一侧：无依赖则无“依赖版本同步”节（条件双向可验证非冻结）
  const nodeps = fixture('gen-nodeps', {
    'package.json': JSON.stringify({ name: 'bare', version: '0.1.0' }, null, 2),
  })
  compose(nodeps)
  const tn = readFileSync(join(nodeps, 'AGENTS.md'), 'utf8')
  const okNd = !/^## 依赖版本同步$/m.test(tn)
  check(okNd, '无依赖 → 不含依赖版本同步')
  report(okNd, '无依赖：该节隐藏')
}

group('[7] 刷新：条件随事实变化，人写的内容不被冲掉')
{
  const dir = join(ROOT, 'gen')
  const agents = join(dir, 'AGENTS.md')
  // 模拟 AI 填完待填写项
  writeFileSync(agents, readFileSync(agents, 'utf8')
    .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写的真实内容）'), 'utf8')

  if (HAS_GIT) {
    spawnSync('git', ['init', '-q'], { cwd: dir })
    spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: dir })
  } else {
    // 没有 git 时用一个等价的替代信号：手写一个 .git 目录不足以让 git 认它，所以改为
    // 直接跳过「远端出现」这一组断言，其余（人写内容保留、幂等）照常验证。
    process.stdout.write('  （环境里没有 git，跳过「建好远端后角色判定出现」这一条）\n')
  }
  compose(dir)
  const t = readFileSync(agents, 'utf8')
  const checks = [
    ['人写的内容保留', /（已填写的真实内容）/.test(t)],
    ['没有重复的版本节', (t.match(/^## 版本管理（必守）$/gm) ?? []).length === 1],
    ['没有内核被追加多份', (t.match(/project-forge:kernel:start/g) ?? []).length === 1],
  ]
  if (HAS_GIT) {
    checks.unshift(
      ['建好远端后「角色判定」出现（曾永久冻结）', /^### 角色判定/m.test(t)],
      ['发版规则出现', /^### 发版规则/m.test(t)],
    )
  }
  for (const [label, ok] of checks) { check(ok, label); report(ok, label) }

  const r = compose(dir)
  const stable = readFileSync(agents, 'utf8') === t
  check(stable, '幂等：再跑一次内容不变')
  report(stable && /无需改动/.test(r.stdout), '幂等：再跑一次报「无需改动」')
}

group('[8] 手写的 AGENTS.md：默认不动，--upgrade 只做加法')
{
  const dir = fixture('handwritten', {
    'package.json': '{"name":"legacy","version":"1.0.0"}\n',
    'src/index.ts': 'export const x = 1\n',
  })
  const original = `# legacy\n\n一句说明。\n\n## 项目简介\n\n做报表用的。\n\n## 怎么跑\n\nnpm test。\n\n## 注意事项\n\n- 别乱改数据库\n`
  writeFileSync(join(dir, 'AGENTS.md'), original, 'utf8')

  const r1 = compose(dir)
  const untouched = readFileSync(join(dir, 'AGENTS.md'), 'utf8') === original
  check(r1.status === 0, '默认运行不报错', `退出码 ${r1.status}`)
  check(untouched, '默认运行不动手写文件')
  check(/缺少这些节/.test(r1.stdout), '输出了缺口报告')
  report(r1.status === 0 && untouched, '默认运行：不报错、不动文件、给出体检')

  const r2 = compose(dir, '--upgrade')
  const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  const lost = original.split('\n').filter((l) => l.trim() !== '')
    .filter((l) => !new Set(after.split('\n').map((x) => x.trim())).has(l.trim()))
  const checks = [
    ['--upgrade 成功', r2.status === 0],
    ['插入了内核', /project-forge:kernel:start/.test(after)],
    ['内核内容非空', /行事总纲/.test(after)],
    ['原有内容一行未丢', lost.length === 0],
    ['补上了可自动补的节', /^## 版本管理（必守）$/m.test(after)],
    ['未补需要人写的空节', !/pf:author/.test(after)],
  ]
  for (const [label, ok] of checks) { check(ok, label, lost.length > 0 ? `丢失：${lost.join(' | ')}` : undefined); report(ok, label) }

  // `--check` 会验「有没有缺失的节」，但**按文件性质区别对待**：
  //   - 脚本生成的文件（带 managed 标记）→ 缺节是缺陷，失败；
  //   - 作者手写后被升级的 → 作者的编排是权威，缺节只提示。
  // 前者防「被掏空的契约过 CI」，后者防「逼作者改成模板的样子」——两种错法都发生过。
  const upCheck = compose(dir, '--check')
  const okUp = upCheck.status === 0 && /提示：缺失/.test(upCheck.stdout ?? '')
  check(okUp, '作者编排的文件：缺节只提示，--check 仍通过', `exit=${upCheck.status}`)
  report(okUp, '作者编排的文件：缺节只提示')

  // 生成的文件删掉一整节 → 必须失败（审计指出的「掏空的契约过 CI」）
  const gdir = fixture('gutted', { 'package.json': '{"name":"g","version":"1.0.0"}\n' })
  compose(gdir)
  const gf = join(gdir, 'AGENTS.md')
  const gt = readFileSync(gf, 'utf8')
  // 删「文档同步」——它对任何项目都会生成，不像「依赖版本同步」只在有依赖时才有。
  // 注意结束锚点用 `(?![\s\S])` 而不是 `\Z`：后者不是 JavaScript 的正则转义，
  // 会被当成字面量 Z，于是当这一节位于文件末尾时匹配不上。
  const killed = gt.replace(/^## 文档同步[\s\S]*?(?=^## |(?![\s\S]))/m, '')
  check(killed !== gt && killed.length < gt.length, '前提：成功删掉一节',
    `${gt.length} -> ${killed.length}`)
  writeFileSync(gf, killed, 'utf8')
  const gcheck = compose(gdir, '--check')
  const okGut = gcheck.status !== 0 && /缺失/.test(gcheck.stderr ?? '')
  check(okGut, '生成的文件被掏空 → --check 失败', `exit=${gcheck.status}`)
  report(okGut, '生成的文件被掏空 → --check 失败')

  // 在正文里合法地加一行注释，不该被指控成「内核不一致」
  const cdir = fixture('comment-added', { 'package.json': '{"name":"c","version":"1.0.0"}\n' })
  compose(cdir)
  const cf = join(cdir, 'AGENTS.md')
  writeFileSync(cf, readFileSync(cf, 'utf8')
    .replace('### 提交纪律', '<!-- 我们自己的补充说明 -->\n### 提交纪律'), 'utf8')
  const ccheck = compose(cdir, '--check')
  const okComment = ccheck.status === 0
  check(okComment, '正文合法编辑不被误指为内核不一致', `exit=${ccheck.status}`)
  report(okComment, '正文合法编辑不被误报')
}

group('[9] 多生态：命令按生态分组，不互相覆盖')
{
  // 两边都**显式声明**了测试框架：只有这样断言才有意义。若不声明，勘察给出的是
  // 「按标准库推断」的带说明命令（那是正确的行为，见第 13 组）。
  const dir = fixture('multi', {
    'package.json': JSON.stringify({
      name: 'mixed', version: '1.0.0',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2),
    'pyproject.toml': '[project]\nname = "mixed"\nversion = "1.0.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'requirements.txt': 'pdfplumber>=0.10\n',
    'src/index.ts': 'export const x = 1\n',
    'tests/test_a.py': 'def test_a(): pass\n',
  })
  const s = survey(dir)
  check(s.commands?.byEcosystem !== undefined, '勘察输出含 byEcosystem')
  check(Array.isArray(s.commands?.multipleEcosystems), '勘察输出含 multipleEcosystems')
  compose(dir)
  const t = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  const checks = [
    ['命令块标了生态', /# node/.test(t) && /# python/.test(t)],
    ['node 与 python 的命令都在', /npm run test/.test(t) && /python -m pytest/.test(t)],
  ]
  for (const [label, ok] of checks) { check(ok, label); report(ok, label) }
}

group('[13] Python 测试命令：只在项目声明了框架时才给，不按生态惯例编')
{
  // 声明了 pytest → 给 pytest
  const withPytest = fixture('py-pytest', {
    'pyproject.toml': '[project]\nname = "p"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'tests/test_a.py': 'def test_a(): pass\n',
  })
  const c1 = survey(withPytest).commands ?? {}
  const ok1 = c1.test === 'python -m pytest'
  check(ok1, '声明了 pytest → 给 pytest', JSON.stringify(c1.test))
  report(ok1, '声明 pytest → 用 pytest')

  // **没有**声明框架（用标准库 unittest 的项目就是这样）→ 给标准库那条，
  // 且必须带说明。曾经这里按生态惯例给 pytest，结果一个 unittest 项目拿到跑不通的
  // 「硬门禁」命令，还把 P7 的诚实分支遮住了。
  const noDecl = fixture('py-nodecl', {
    'pyproject.toml': '[project]\nname = "p"\n',
    'tests/test_a.py': 'import unittest\n',
  })
  const c2 = survey(noDecl).commands ?? {}
  const ok2 = c2.test === 'python -m unittest discover -s tests -v'
  check(ok2, '未声明框架 → 给标准库那条', JSON.stringify(c2.test))
  report(ok2, '未声明框架 → 给标准库那条')
  const ok3 = typeof c2.testNote === 'string' && c2.testNote.length > 0
  check(ok3, '未声明框架时带「这是推断」的说明')
  report(ok3, '并注明这是推断，非项目声明')

  // 显式声明 unittest → 给 unittest 且不带推断说明（第三分支不断言会回退到惯例旧错）
  const withUnit = fixture('py-unit', {
    'pyproject.toml': '[project]\nname = "p"\n\n[tool.unittest]\n',
    'tests/test_a.py': 'import unittest\n',
  })
  const c3 = survey(withUnit).commands ?? {}
  const ok4 = c3.test === 'python -m unittest discover -s tests -v' && c3.testNote === undefined
  check(ok4, '声明 unittest → 给 unittest 且无推断说明', JSON.stringify(c3.test))
  report(ok4, '声明 unittest → 无推断说明')
}

group('[10] 运行环境下限：读项目自己的声明，读不到就是没有')
{
  const nodeProj = fixture('env-node', {
    'package.json': JSON.stringify({ name: 'e', version: '1.0.0', engines: { node: '>=20' } }),
  })
  const reqs = survey(nodeProj).artifacts?.runtimeRequirements ?? []
  const ok1 = reqs.some((r) => r.runtime === 'node' && r.range === '>=20')
  check(ok1, '读出 package.json 的 engines.node', JSON.stringify(reqs))
  report(ok1, '读出 package.json 的 engines.node')

  const pyProj = fixture('env-py', {
    'pyproject.toml': '[project]\nname = "e"\nrequires-python = ">=3.10"\n',
  })
  const reqs2 = survey(pyProj).artifacts?.runtimeRequirements ?? []
  const ok2 = reqs2.some((r) => r.runtime === 'python' && r.range === '>=3.10')
  check(ok2, '读出 pyproject.toml 的 requires-python', JSON.stringify(reqs2))
  report(ok2, '读出 pyproject.toml 的 requires-python')

  // 没声明时必须是空数组，不能凭空给一个值——文档套装禁止编造版本号，
  // 而「编造」的入口正是勘察这里给了一个看似合理的默认值。
  const bare = fixture('env-none', { 'README.md': '# x\n', 'src/a.js': 'export const a=1\n' })
  const reqs3 = survey(bare).artifacts?.runtimeRequirements ?? []
  const ok3 = reqs3.length === 0
  check(ok3, '未声明时为空（不得凭空给默认值）', JSON.stringify(reqs3))
  report(ok3, '未声明时为空，不编造')
}

group('[11] 本机路径分档：真泄漏要报，测试数据不要误导')
{
  const realHome = homedir().replace(/\\/g, '/')
  // 真泄漏：源码里写了本机真实主目录（用正斜杠写法——很多工具与配置都这么写，
  // 只认反斜杠的检测会完全漏掉它）
  const leak = fixture('leak-real', {
    'src/config.ts': `export const ROOT = '${realHome}/projects/thing'\n`,
  })
  const hits = survey(leak).risks?.homePathLeaks ?? []
  const ok1 = hits.some((h) => h.kind === 'leak')
  check(ok1, '源码里的本机真实路径判为 leak（正斜杠写法也要认）',
    JSON.stringify(hits.map((h) => [h.path, h.kind])))
  report(ok1, '真泄漏：判为 leak')

  // 测试数据：假路径不该被当成泄漏，且建议必须明确「不要改它」——
  // 曾经这里报「本机私有路径」并建议改成相对路径，照着做会把测试改坏。
  const fake = fixture('leak-testdata', {
    'tests/controller.spec.ts': "sessions.setInfo('s-1', { cwd: '/home/me/deepseek' })\n",
  })
  const hits2 = survey(fake).risks?.homePathLeaks ?? []
  const ok2 = hits2.length > 0 && !hits2.some((h) => h.kind === 'leak')
  check(ok2, '测试文件里的假路径不判为 leak', JSON.stringify(hits2.map((h) => h.kind)))
  report(ok2, '测试数据：不判为 leak')
  const ok3 = hits2.every((h) => !/改成相对路径或环境变量/.test(h.advice ?? ''))
  check(ok3, '测试数据给出的建议不是「改成相对路径」')
  report(ok3, '测试数据：建议不改它')

  // 文档示例：文档里的路径判为 doc-example（提示确认即可）；模板文件放行不报
  const doc = fixture('leak-doc', {
    'README.md': '# x\n\n路径示例：/home/someone/projects/demo\n',
    '.env.example': 'API_KEY=your-key-here\n',
  })
  const hits3 = survey(doc).risks?.homePathLeaks ?? []
  // 非空前提：`every` 在空数组上恒真，缺了它「一个都没识别出来」也会显示通过。
  const ok4 = hits3.length > 0 && hits3.every((h) => h.kind !== 'leak')
  check(ok4, '文档里的示例路径不判为 leak', JSON.stringify(hits3.map((h) => h.kind)))
  report(ok4, '文档示例：不判为 leak')
  const files3 = survey(doc).risks?.secretFiles ?? []
  // 这一条是**否定**断言（这些文件不该出现在命中里）：空数组就是它想要的结果，
  // 所以不能像上面那样加「非空前提」——但否定断言只有在「检测器确实活着」时才可信，
  // 于是配一条正向断言：同目录里的真 `.env` 必须被报出来。
  const ok5 = !files3.some((f) => /env\.example/.test(typeof f === 'string' ? f : f.path))
  const probeFiles = survey(fixture('leak-doc-probe', { '.env': 'x=1\n', 'README.md': '# x\n' })).risks?.secretFiles ?? []
  const ok5b = probeFiles.some((f) => /(^|[\\/])\.env$/.test(typeof f === 'string' ? f : f.path))
  check(ok5b, '同一判定对真 .env 仍报出来（否定断言的前提：检测器活着）', JSON.stringify(probeFiles))
  report(ok5b, '模板放行的对照：真 .env 仍被报出')
  check(ok5, '.env.example 模板文件放行', JSON.stringify(files3))
  report(ok5, '模板文件：放行')
}

group('[12] 生态与命令：细化不算第二套命令')
{
  // dsh-plugin 是 node 的细化，只有一套命令；把它算成多生态会让 AI 去找不存在的第二套。
  const plugin = fixture('eco-plugin', {
    'package.json': JSON.stringify({
      name: 'p', version: '1.0.0', private: true, scripts: { build: 'tsc', test: 'vitest' },
    }, null, 2),
    'cordis.patch.yml': '- id: p\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  })
  const r1 = survey(plugin)
  const ok1 = r1.commands?.multipleEcosystems === undefined
  check(ok1, 'node + dsh-plugin 不报多生态', JSON.stringify(r1.commands?.multipleEcosystems))
  report(ok1, '插件项目：不误报多生态')
  const ok2 = r1.commands?.packageManager === 'pnpm'
  check(ok2, '包管理器取锁文件（pnpm），不写死 npm', String(r1.commands?.packageManager))
  report(ok2, '插件项目：沿用它自己的 pnpm')

  // 真两套命令仍要报
  const multi = fixture('eco-multi', {
    'package.json': JSON.stringify({ name: 'm', version: '1.0.0', scripts: { test: 'vitest' } }),
    'pyproject.toml': '[project]\nname = "m"\n',
    'tests/test_a.py': 'def test_a(): pass\n',
  })
  const ok3 = Array.isArray(survey(multi).commands?.multipleEcosystems)
  check(ok3, 'node + python 仍报多生态')
  report(ok3, '真多生态：仍然报')
}

group('[14] 完成判据不能空转：只升级不填写时，必须报出缺失的节')
{
  const dir = fixture('vacuous', {
    'pyproject.toml': '[project]\nname = "x"\nversion = "1.0.0"\n',
    'main.py': 'print(1)\n',
  })
  writeFileSync(join(dir, 'AGENTS.md'), '# x\n\n说明。\n\n## 怎么跑\n\npython main.py\n', 'utf8')
  compose(dir, '--upgrade')
  const st = compose(dir, '--status')
  const out = st.stdout ?? ''
  // 只做升级、一个项目节都没写时，pf:author 数立刻是 0——只看这个数字会以为写完了。
  const noAuthors = /待填写 0 处/.test(out)
  check(noAuthors, '前提：升级后待填写确实是 0')
  const reportsMissing = /缺失 \d+ 节/.test(out)
  check(reportsMissing, '--status 报出缺失的节（否则完成判据会空转）', out.split('\n')[0])
  report(reportsMissing, '--status 报出缺失节数')
  const warns = /不算完成/.test(out)
  check(warns, '--status 明确说明这些节没写就不算完成')
  report(warns, '并说明不算完成')

  // 新生成的文件：节**都在**（来自模板），但都还没填——所以判据必须落在
  // 「待填写」上，且绝不能报「内容完整」。只看缺失节数会漏掉这种情况。
  const fresh = fixture('fresh', { 'README.md': '# x\n', 'src/a.js': 'export const a=1\n' })
  compose(fresh)
  const st2 = compose(fresh, '--status')
  const out2 = st2.stdout ?? ''
  const authorCount = Number((/待填写 (\d+) 处/.exec(out2) ?? [])[1] ?? -1)
  const ok1 = authorCount > 0
  check(ok1, '新生成的文件报出待填写项', String(authorCount))
  report(ok1, `新生成文件报待填写 ${authorCount} 处`)
  // 注意：提示语里有一句「写完后重跑本脚本，确认「内容完整」」，它**包含**这个短语。
  // 所以断言要匹配「以它开头的整行」，不能匹配子串——否则测试永远为假。
  const hasCompleteLine = (text) => text.split('\n').some((l) => l.trim().startsWith('内容完整'))
  const ok2 = !hasCompleteLine(out2)
  check(ok2, '新生成的文件不得报「内容完整」')
  report(ok2, '且不报「内容完整」')

  // 反例：两个数字都归零时才该报「内容完整」——用一个已填好的文件验证
  const done = fixture('done', {
    'package.json': JSON.stringify({ name: 'd', version: '1.0.0', private: true, scripts: { test: 'x' } }),
  })
  compose(done)
  const dpath = join(done, 'AGENTS.md')
  // 把待填写标记全部换成真实内容
  writeFileSync(dpath, readFileSync(dpath, 'utf8')
    .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写）'), 'utf8')
  const st3 = compose(done, '--status')
  const ok3 = hasCompleteLine(st3.stdout ?? '')
  check(ok3, '两个数字都归零时报「内容完整」')
  report(ok3, '填完后报「内容完整」')
}

group('[15] 非 JS 项目必须照样拿到发布那一半契约')
{
  // 这条曾经整块丢失：判「能不能发布」时只认 package.json，于是所有非 JS 项目
  // 都被写成「本项目不对外发布」，版本号语义、抬版本号判据、发版规则全没了。
  for (const [label, files] of [
    ['Python', { 'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n' }],
    ['Rust', { 'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\n' }],
    ['Go', { 'go.mod': 'module p\n\ngo 1.22\n' }],
  ]) {
    const dir = fixture(`pub-${label.toLowerCase()}`, files)
    compose(dir)
    const t = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const ok1 = !/不对外发布/.test(t)
    check(ok1, `${label}：不判成「不对外发布」`)
    report(ok1, `${label}：不判成不可发布`)
    const ok2 = /^### 版本号语义$/m.test(t) && /^### 发版规则$/m.test(t)
    check(ok2, `${label}：含版本号语义与发版规则`)
    report(ok2, `${label}：含版本号语义与发版规则`)
  }
  // 反侧：private 明确不可发布 → 写“不对外发布”，且无版本号语义与发版规则
  const priv = fixture('pub-private', {
    'package.json': JSON.stringify({ name: 'p', version: '1.0.0', private: true }, null, 2),
  })
  compose(priv)
  const tp = readFileSync(join(priv, 'AGENTS.md'), 'utf8')
  const okP = /不对外发布/.test(tp) && !/^### 版本号语义$/m.test(tp) && !/^### 发版规则$/m.test(tp)
  check(okP, 'private：写不对外发布且无发版规则')
  report(okP, 'private：反侧正确')
}

group('[33] 易漏生态分支：skill、损坏清单、dotnet 各有出口')
{
  // 根 SKILL.md 即 skill（被宿主加载的能力目录），不因无清单被判 unknown
  const sk = fixture('eco-skill', { 'SKILL.md': '---\nname: my-skill\ndescription: 做 X 时用\n---\n\n# my-skill\n' })
  const okS = (survey(sk).ecosystem?.kinds ?? []).includes('skill')
  check(okS, '根 SKILL.md → skill', JSON.stringify(survey(sk).ecosystem?.kinds))
  report(okS, 'skill：认出 skill')
  // 损坏的 package.json 仍按 node 处理（ corruption 是事实，不是换生态的理由）
  const bad = fixture('eco-corrupt', { 'package.json': '{oops' })
  const okC = (survey(bad).ecosystem?.kinds ?? []).includes('node')
  check(okC, '损坏清单 → 仍判 node 并带损坏证据', JSON.stringify(survey(bad).ecosystem?.kinds))
  report(okC, '损坏清单：不换生态')
  // dotnet csproj 即 dotnet，不落空
  const dn = fixture('eco-dotnet', { 'app.csproj': '<Project></Project>\n' })
  const okD = (survey(dn).ecosystem?.kinds ?? []).includes('dotnet')
  check(okD, 'csproj → dotnet', JSON.stringify(survey(dn).ecosystem?.kinds))
  report(okD, 'dotnet：认出')
}

group('[16] 报告要给到行，并说明在不在版本库里')
{
  const dir = fixture('line-num', {
    'src/c.py': `# a\n# b\nK = "${FAKE_GH_TOKEN}"\n`,
    'free.env': `${FAKE_NPM_TOKEN}\n`,
  })
  if (HAS_GIT) {
    for (const args of [['init', '-q'], ['config', 'user.name', 'T'],
      ['config', 'user.email', 't@e.com'], ['add', 'src'], ['commit', '-q', '-m', 'i']]) {
      spawnSync('git', args, { cwd: dir })
    }
  }
  const hits = survey(dir).risks?.secretContent ?? []
  // 同上：必须有命中，否则这条断言在「扫描整个失效」时也会通过。
  const ok1 = hits.length > 0 && hits.every((h) => Number.isInteger(h.line) && h.line > 0)
  check(ok1, '凭据命中带行号（只给文件名不构成可执行的报告）', JSON.stringify(hits))
  report(ok1, '凭据命中带行号')
  if (HAS_GIT) {
    const tracked = hits.find((h) => /c\.py/.test(h.path))
    const untracked = hits.find((h) => /env/.test(h.path))
    const ok2 = tracked?.tracked === true && untracked?.tracked === false
    check(ok2, '区分「已在版本库里」与「尚未跟踪」（决定处置方式）',
      JSON.stringify(hits.map((h) => [h.path, h.tracked])))
    report(ok2, '区分已跟踪 / 未跟踪')
  }
}

group('[17] 忽略规则：交叉核对「目录存在」与「是否已忽略」')
{
  if (!HAS_GIT) {
    skipGroup('[17] 忽略规则交叉核对', '环境里没有 git')
  } else {
    // venv 就在那里，而忽略规则没覆盖它——下一次 git add -A 会把整个虚拟环境写进历史。
    // 勘察本来两边都看得到，却不做交叉核对，于是这件事要人自己去发现。
    const gap = fixture('ignore-gap', {
      'src/a.py': 'x = 1\n',
      'venv/lib/thing.py': 'y = 2\n',
      '.gitignore': '*.pyc\n',
    })
    spawnSync('git', ['init', '-q'], { cwd: gap })
    const s = survey(gap)
    const notIgnored = s.ignores?.unignoredOutputDirs ?? []
    const ok1 = notIgnored.includes('venv')
    check(ok1, '报出「存在但未被忽略」的目录', JSON.stringify(notIgnored))
    report(ok1, 'venv 存在但未忽略 → 报出来')

    // 反向：忽略规则覆盖了它之后，就不该再报（否则成噪音，人会开始忽略这条提示）
    writeFileSync(join(gap, '.gitignore'), '*.pyc\nvenv/\n', 'utf8')
    const s2 = survey(gap)
    const ok2 = (s2.ignores?.unignoredOutputDirs ?? []).length === 0
    check(ok2, '已忽略后不再报', JSON.stringify(s2.ignores?.unignoredOutputDirs))
    report(ok2, '补上忽略规则后不再报')

    // 缺忽略文件本身也要报（没有它，产物与依赖会被提交）
    const noIgnore = fixture('ignore-none', { 'src/a.py': 'x = 1\n', 'venv/lib/y.py': 'z\n' })
    spawnSync('git', ['init', '-q'], { cwd: noIgnore })
    const md = spawnSync(process.execPath, [join(HERE, 'survey.mjs'), noIgnore, '--markdown'],
      { encoding: 'utf8' }).stdout ?? ''
    const ok3 = /忽略文件：\*\*缺\*\*/.test(md)
    check(ok3, '缺忽略文件时明确报「缺」')
    report(ok3, '缺忽略文件 → 明确报缺')
  }
}

group('[18] 手工改坏的文件：一律拒绝写坏，并说清怎么修')
{
  const base = { 'package.json': JSON.stringify({ name: 'r', version: '1.0.0', scripts: { test: 'x' } }) }

  // 三态判定：手写 / 受管 / **受损**。受损必须停下——曾经它被压进「手写」，
  // 于是 --upgrade 把 14KB 内核又插一遍，文件里出现两份内核，而 --check 与 --status
  // 同时报绿（--check 只看第一对标记，--status 数不到缺节）。
  const damaged = [
    ['只删掉结束标记', (t) => t.replace('<!-- project-forge:kernel:end -->', '')],
    ['只删掉开始标记', (t) => t.replace('<!-- project-forge:kernel:start -->', '')],
    ['整段内核被复制两份', (t) => {
      const S = '<!-- project-forge:kernel:start -->'
      const E = '<!-- project-forge:kernel:end -->'
      const s = t.indexOf(S)
      const e = t.indexOf(E) + E.length
      return `${t.slice(0, e)}\n${t.slice(s, e)}\n${t.slice(e)}`
    }],
  ]
  // fixture 名用**序号**，不要从中文标签里剥字母：剥完三个都是空串，于是三个用例共用
  // 同一个目录，后两个跑在被前一个改坏的文件上——测试自己就成了污染源。
  for (const [i, [label, mutate]] of damaged.entries()) {
    const dir = fixture(`damaged-${i}`, base)
    compose(dir)
    const f = join(dir, 'AGENTS.md')
    const broken = mutate(readFileSync(f, 'utf8'))
    if (broken === readFileSync(f, 'utf8')) { check(false, `${label}：测试构造失败`); continue }
    writeFileSync(f, broken, 'utf8')
    const hashBefore = readFileSync(f, 'utf8')

    const r1 = compose(dir)
    const ok1 = r1.status === 2
    check(ok1, `${label} → 普通运行拒绝（exit 2）`, `exit=${r1.status}`)
    const r2 = compose(dir, '--upgrade')
    const ok2 = r2.status === 2
    check(ok2, `${label} → --upgrade 也拒绝`, `exit=${r2.status}`)
    const r3 = compose(dir, '--check')
    const ok3 = r3.status !== 0
    check(ok3, `${label} → --check 报失败`, `exit=${r3.status}`)
    const untouched = readFileSync(f, 'utf8') === hashBefore
    check(untouched, `${label} → 文件一个字节没动`)
    const hints = /标记受损|标记/.test(r1.stderr ?? '')
    check(hints, `${label} → 报错说明是标记问题并给出修法`)
    report(ok1 && ok2 && ok3 && untouched, `${label}：三条路径都拒绝且文件未动`)
  }

  // 正常受管文件仍应照常工作（别把守卫做得太紧）
  const good = fixture('still-works', base)
  compose(good)
  const ok4 = compose(good, '--check').status === 0
  check(ok4, '正常文件仍然通过 --check')
  report(ok4, '正常文件不受影响')
}

group('[19] 发版规则：有版本号与没有版本号，两种写法都要有')
{
  // 有版本号 → 标签名对齐清单里那一处
  const withV = fixture('ver-with', {
    'package.json': JSON.stringify({ name: 'a', version: '1.2.3' }),
  })
  compose(withV)
  const t1 = readFileSync(join(withV, 'AGENTS.md'), 'utf8')
  const ok1 = /标签名必须与清单文件里的版本号一致/.test(t1)
  check(ok1, '有版本号 → 标签名要对齐它')
  report(ok1, '有版本号：标签名对齐清单')
  const ok2 = !/本项目没有版本号/.test(t1)
  check(ok2, '有版本号 → 不出现「没有版本号」分支')
  report(ok2, '有版本号：不误报「没有版本号」')

  // 没有版本号 → 命名自定，且**不得**出现「必须与版本号一致」（那会让执行者无从下手）
  const noV = fixture('ver-none', {
    'go.mod': 'module x\n\ngo 1.22\n',
    'main.go': 'package main\n',
  })
  compose(noV)
  const t2 = readFileSync(join(noV, 'AGENTS.md'), 'utf8')
  const ok3 = /本项目没有版本号/.test(t2) && /单调、不重复、可排序/.test(t2)
  check(ok3, '没有版本号 → 给出自定命名规则')
  report(ok3, '没有版本号：给出命名规则')
  const ok4 = !/标签名必须与清单文件里的版本号一致/.test(t2)
  check(ok4, '没有版本号 → 不出现「必须与版本号一致」')
  report(ok4, '没有版本号：不出现矛盾要求')
  const ok5 = /不要编一个出来/.test(t2)
  check(ok5, '没有版本号 → 明确禁止编造一个')
  report(ok5, '没有版本号：禁止编造')
}

group('[20] 已有的 README：双语要认出来，结构不同不强行对齐')
{
  // 双语 README 必须被认成**一对**，而不是两个无关文件——只有知道它们是一对，
  // 「改一份要看另一份」这条才谈得上。
  const bi = fixture('readme-bilingual', {
    'README.md': '# 中文说明\n\n## 安装\n\n## 使用\n',
    'README.en.md': '# English\n\n## Installation\n\n## Usage\n',
    'src/a.js': 'export const a=1\n',
  })
  const pair = survey(bi).docs?.readmePair
  const ok1 = pair !== undefined && pair.default === 'README.md'
  check(ok1, '双语 README 被认成一对', JSON.stringify(pair))
  report(ok1, '双语 README：认成一对')
  const ok2 = Array.isArray(pair?.variants) && pair.variants.includes('README.en.md')
  check(ok2, '另一语言的文件列在 variants 里')
  report(ok2, '双语 README：列出另一语言')

  // 报告里要写明「两份都会随包发出」「会漂移」——否则「成对」这个事实没有可操作的后果
  const md = spawnSync(process.execPath, [join(HERE, 'survey.mjs'), bi, '--markdown'],
    { encoding: 'utf8' }).stdout ?? ''
  const ok3 = /双语 README/.test(md) && /漂移/.test(md)
  check(ok3, '报告里写明成对关系的后果（随包发出 + 会漂移）')
  report(ok3, '报告写明后果')

  // 单语 README 不该被误报成一对（否则「成对」这个信号会贬值）
  const single = fixture('readme-single', { 'README.md': '# x\n\n## 安装\n', 'src/a.js': 'x\n' })
  const ok4 = survey(single).docs?.readmePair === undefined
  check(ok4, '单语 README 不报成一对')
  report(ok4, '单语 README：不误报')

  // 结构完全不同的 README：必须报出**它现有的节**（事实），而不是「缺哪几节」（结论）。
  // README 没有标准结构，脚本不该假装能判合格与否。
  const custom = fixture('readme-custom', {
    'README.md': '# tool\n\n## 它解决什么\n\n## 装在哪\n\n## 日常用法\n',
    'src/a.js': 'x\n',
  })
  const sections = survey(custom).docs?.readmeSections ?? []
  const ok5 = sections.includes('## 它解决什么') && sections.includes('## 日常用法')
  check(ok5, '报出自定义结构的实际节名（不按模板改名判断）', JSON.stringify(sections))
  report(ok5, '结构不同：报实际节名')
  const ok6 = sections.length === 3
  check(ok6, '不把模板的节名混进来', String(sections.length))
  report(ok6, '不混入模板节名')
}

group('[21] 插件类：三种生态各自认出，未知生态不被误判')
{
  // 三个生态的清单文件与判定字段都不同——这正说明「一个通用类型」不够用：
  // VS Code 用 package.json 的 engines.vscode，Obsidian 用独立的 manifest.json，
  // 混淆任何两个都会把产物入库、发布范围这类判断做错。
  const vsc = fixture('plug-vscode', {
    'package.json': JSON.stringify({
      name: 'myext', version: '1.0.0', publisher: 'me', engines: { vscode: '^1.80.0' },
    }, null, 2),
    'src/extension.ts': 'export function activate() {}\n',
  })
  const okVsc = (survey(vsc).ecosystem?.kinds ?? []).includes('vscode-extension')
  check(okVsc, 'VS Code 扩展被认出（engines.vscode）', JSON.stringify(survey(vsc).ecosystem?.kinds))
  report(okVsc, 'VS Code：认出 vscode-extension')

  const obs = fixture('plug-obsidian', {
    'manifest.json': JSON.stringify({
      id: 'my-plugin', name: 'My Plugin', version: '1.0.0', minAppVersion: '1.0.0',
    }, null, 2),
    'main.js': 'module.exports = class {}\n',
  })
  const okObs = (survey(obs).ecosystem?.kinds ?? []).includes('obsidian-plugin')
  check(okObs, 'Obsidian 插件被认出（manifest.json 的 minAppVersion）',
    JSON.stringify(survey(obs).ecosystem?.kinds))
  report(okObs, 'Obsidian：认出 obsidian-plugin')

  const dsh = fixture('plug-dsh', {
    'package.json': JSON.stringify({ name: 'p', version: '1.0.0', dsh: { bundle: {} } }),
    'cordis.patch.yml': '- id: p\n',
  })
  const okDsh = (survey(dsh).ecosystem?.kinds ?? []).includes('dsh-plugin')
  check(okDsh, 'DSH 插件仍被认出', JSON.stringify(survey(dsh).ecosystem?.kinds))
  report(okDsh, 'DSH：认出 dsh-plugin')

  // 关键的**反向**断言：一个普通的 `manifest.json`（不含 minAppVersion，例如 PWA 或
  // 浏览器扩展的清单）不该被误判成 Obsidian 插件——误判会让产物入库等判断全错。
  const pwa = fixture('plug-pwa', {
    'manifest.json': JSON.stringify({ name: 'App', short_name: 'App', start_url: '/', display: 'standalone' }, null, 2),
    'index.html': '<html></html>\n',
  })
  const pwaKinds = survey(pwa).ecosystem?.kinds ?? []
  const okPwa = !pwaKinds.includes('obsidian-plugin')
  check(okPwa, '普通 manifest.json 不被误判成 Obsidian 插件', JSON.stringify(pwaKinds))
  report(okPwa, '反向：PWA 清单不误判')

  // 未知生态：不该被硬塞进已知类型，应落到需要人判断的那一类
  const unknown = fixture('plug-unknown-host', {
    'myhost-extension.json': JSON.stringify({ hostVersion: '3.0', id: 'x' }, null, 2),
    'src/main.rs': 'fn main() {}\n',
  })
  const ukKinds = survey(unknown).ecosystem?.kinds ?? []
  const okUnknown = !ukKinds.some((k) => /plugin|extension/.test(k))
  check(okUnknown, '未知宿主不被硬塞进已知插件类型', JSON.stringify(ukKinds))
  report(okUnknown, '未知宿主：不硬塞已知类型')
}

group('[22] 双语文档的成对维护规则必须**写进项目契约**，不只是写在参考文件里')
{
  // 这一组测的是「机制缺口」：references 里写了双语会漂移、要成对改，但模板里没有
  // 对应段落——于是生成出来的契约里没有这条规则，项目也就不会照它做。
  // 实测后果：一个双语文档的项目，英文版漏掉了一条更新命令，而它的契约里一个字都没提。
  //
  // 规则写在参考文件里只对「读过那份文件的人」有效；写进项目自己的契约，
  // 才对以后每一次会话有效。所以断言落在**生成物**上，不是落在模板上。
  const bi = fixture('doc-bi', {
    'package.json': JSON.stringify({ name: 'bi', version: '1.0.0' }),
    'README.md': '# bi\n\n## 安装\n',
    'README.en.md': '# bi\n\n## Install\n',
  })
  compose(bi)
  const t = readFileSync(join(bi, 'AGENTS.md'), 'utf8')
  const ok1 = /双语说明文档要/.test(t)
  check(ok1, '有双语 README → 生成的契约含成对维护一节')
  report(ok1, '有双语 README：契约含那一节')
  const ok2 = /另一份同步了吗/.test(t)
  check(ok2, '含可自查的那句话（改完要能回答「另一份同步了吗」）')
  report(ok2, '含自查句')
  const ok3 = /漂移/.test(t) && /默认语言那份是权威/.test(t)
  check(ok3, '含「会漂移」与「哪份权威」两条关键判据')
  report(ok3, '含漂移与权威判据')

  // 反向：单语项目不该出现这一节（否则是噪音，而且会让 AI 去找不存在的第二份文档）
  const mono = fixture('doc-mono', {
    'package.json': JSON.stringify({ name: 'mono', version: '1.0.0' }),
    'README.md': '# mono\n',
  })
  compose(mono)
  const t2 = readFileSync(join(mono, 'AGENTS.md'), 'utf8')
  const ok4 = !/双语说明文档要/.test(t2)
  check(ok4, '单语 README → 不含这一节')
  report(ok4, '单语：不误报')

  // 变体的写法要认全：语言后缀有多种常见拼法，只认一种会漏
  for (const [label, name] of [['点分', 'README.en.md'], ['下划线', 'README_CN.md'], ['连字符', 'README.zh-CN.md']]) {
    const d = fixture(`doc-var-${label === '点分' ? 'dot' : label === '下划线' ? 'under' : 'dash'}`, {
      'package.json': JSON.stringify({ name: 'v', version: '1.0.0' }),
      'README.md': '# v\n',
      [name]: '# v\n',
    })
    const ok = survey(d).docs?.readmePair !== undefined
    check(ok, `变体写法「${name}」被认成一对`)
    report(ok, `变体写法 ${name}`)
  }
}

group('[23] 目录同步：从标题生成、锚点算对、三种现状都能接管')
{
  const toc = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'sync-toc.mjs'), join(dir, 'README.md'), ...a], { encoding: 'utf8' })

  // ① 有手写目录、没有标记 → 就地接管，**不新增第二个目录**
  const hand = fixture('toc-hand', {
    'README.md': [
      '# x', '', '## 目录', '', '- [旧的](#错的锚点)', '',
      '## 第一节', '', '正文', '', '## 第二节', '', '正文', '',
      '## 第三节', '', '正文', '', '## 第四节', '', '正文', '', '## 第五节', '', '正文', '',
    ].join('\n'),
  })
  const r1 = toc(hand)
  const t1 = readFileSync(join(hand, 'README.md'), 'utf8')
  const dirCount = (t1.match(/^## 目录$/gm) ?? []).length
  const ok1 = dirCount === 1
  check(ok1, '手写目录被接管，且没有出现第二个「目录」节', `目录节 ${dirCount} 个`)
  report(ok1, '手写目录：就地接管，不重复')
  const ok2 = !/错的锚点/.test(t1) && /#第一节/.test(t1)
  check(ok2, '内容被换成按标题算出的正确锚点')
  report(ok2, '锚点已重算')
  check(r1.status === 0, '接管成功退出码 0')

  // ② 幂等 + --check 能发现漂移
  const r2 = toc(hand, '--check')
  check(r2.status === 0, '接管后 --check 通过', `exit=${r2.status}`)
  report(r2.status === 0, '接管后 --check 通过')
  writeFileSync(join(hand, 'README.md'),
    readFileSync(join(hand, 'README.md'), 'utf8') + '\n## 第六节\n\n正文\n', 'utf8')
  const r3 = toc(hand, '--check')
  const ok3 = r3.status !== 0 && /不同步/.test(r3.stdout ?? '')
  check(ok3, '加了一节之后 --check 报不同步', `exit=${r3.status}`)
  report(ok3, '加节后 --check 报不同步')

  // ③ 锚点算法：中文、序号、中英混排、大小写
  const anchors = fixture('toc-anchor', {
    'README.md': [
      '# x', '',
      '## 环境要求', '', 'a', '',
      '## 1. 局域网访问', '', 'a', '',
      '## 3. 移动端交互与 PWA 独立全屏 App', '', 'a', '',
      '## What it does', '', 'a', '',
      '## 第六节', '', 'a', '',
    ].join('\n'),
  })
  toc(anchors)
  const t3 = readFileSync(join(anchors, 'README.md'), 'utf8')
  const wants = [
    ['中文标题', '#环境要求'],
    ['带序号的中文', '#1-局域网访问'],
    ['中英混排', '#3-移动端交互与-pwa-独立全屏-app'],
    ['英文标题', '#what-it-does'],
  ]
  for (const [label, anchor] of wants) {
    const ok = t3.includes(`(#${anchor.replace(/^#/, '')})`)
    check(ok, `锚点：${label} → ${anchor}`)
    report(ok, `锚点 ${label}`)
  }

  // ④ 代码块里的 `## x` 不是标题，不该进目录
  const fenced = fixture('toc-fence', {
    'README.md': [
      '# x', '', '## 真标题', '', '```md', '## 这是代码块里的假标题', '```', '',
      '## 二', '', 'a', '', '## 三', '', 'a', '', '## 四', '', 'a', '', '## 五', '', 'a', '',
    ].join('\n'),
  })
  toc(fenced)
  const t4 = readFileSync(join(fenced, 'README.md'), 'utf8')
  const ok4 = !/假标题/.test(t4.replace(/```md[\s\S]*?```/, ''))
  check(ok4, '围栏代码块里的 `## x` 不进目录')
  report(ok4, '代码块里的标题被跳过')

  // ⑤ 节数少时不加目录（短 README 加目录是累赘）
  const short = fixture('toc-short', { 'README.md': '# x\n\n## 一\n\na\n\n## 二\n\nb\n' })
  const r5 = toc(short)
  const ok5 = !/## 目录/.test(readFileSync(join(short, 'README.md'), 'utf8')) && /不需要目录/.test(r5.stdout ?? '')
  check(ok5, '节数少于阈值时不加目录，并说明原因')
  report(ok5, '短 README：不加目录')
}

group('[24] 工作流自动化现状：有无发布 job、用没用 Secrets 要能读出来')
{
  // 正向：带发布 job 且引用 Secrets 的工作流
  const withRelease = fixture('auto-with', {
    'package.json': '{"name":"demo","version":"0.1.0"}\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create "$TAG" --generate-notes\n        env:\n          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}\n',
  })
  const a1 = survey(withRelease).docs?.workflowAutomation
  const ok1 = a1?.hasReleaseJob === true && a1?.usesSecrets === true
  check(ok1, '带发布 job 的工作流被认出', JSON.stringify(a1))
  report(ok1, '有发布 job：认出')

  // OIDC 短时身份也要认出来——npm 自动发布靠它，没有就是没接线
  const withOidc = fixture('auto-oidc', {
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\n  contents: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n',
  })
  const a3 = survey(withOidc).docs?.workflowAutomation
  const ok3 = a3?.usesOidc === true
  check(ok3, 'OIDC 声明被认出', JSON.stringify(a3))
  report(ok3, '有 OIDC：认出')

  // 反向：纯检查工作流不误报发布 job
  const plain = fixture('auto-plain', {
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const a2 = survey(plain).docs?.workflowAutomation
  const ok2 = a2?.hasReleaseJob === false
  check(ok2, '纯检查工作流不误报发布 job', JSON.stringify(a2))
  report(ok2, '无发布 job：不误报')

  // 英文模板模式要被点名：有 generate-notes、无 notes-file → review 必须待问
  const rEn = spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), withRelease], { encoding: 'utf8' })
  const okEn = /英文模板模式/.test(rEn.stdout ?? '')
  check(okEn, '纯英文模板触发待问', (rEn.stdout ?? '').split('\n')[0])
  report(okEn, '英文模板：待问，不默过')
}

group('[25] 交付门禁：缺项拦得住，待问消得掉')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

  // 空项目：AGENTS 缺失 → 缺，退出码非零
  const bare = fixture('review-bare', { 'README.md': '# x\n' })
  const r1 = review(bare)
  const ok1 = r1.status !== 0 && /\[缺\]/.test(r1.stdout ?? '')
  check(ok1, '缺 AGENTS 时报缺且非零退出', `exit=${r1.status}`)
  report(ok1, '缺项：拦得住')

  // 待问全部用 flag 消掉（除 AGENTS 缺失仍是缺）→ 待问清零
  const r2 = review(bare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok2 = !/\[待问\]/.test(r2.stdout ?? '') && /\[缺\]/.test(r2.stdout ?? '')
  check(ok2, 'flag 能消掉待问，只剩真缺项', (r2.stdout ?? '').split('\n')[0])
  report(ok2, '待问：消得掉')

  // 未知 flag 直接报错，不静默忽略
  const r3 = review(bare, '--no-whatever')
  const ok3 = r3.status !== 0 && /无法识别/.test(r3.stderr ?? '')
  check(ok3, '未知 flag 报错')
  report(ok3, '未知 flag：报错')

  // 凭据命中拦得住，确认为占位后 flag 消得掉（flag 本身就是用户答复的载体）
  const sec = fixture('review-secret', {
    'README.md': '# x\n',
    'src/a.py': `K = "${FAKE_GH_TOKEN}"\n`,
  })
  const r4 = review(sec, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok4 = /凭据形状/.test(r4.stdout ?? '') && r4.status !== 0
  check(ok4, '凭据命中 → 报缺且非零退出', `exit=${r4.status}`)
  report(ok4, '凭据：拦得住')
  const r5 = review(sec, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--secrets-reviewed')
  const ok5 = !/凭据形状/.test(r5.stdout ?? '')
  check(ok5, '--secrets-reviewed 消掉已确认的凭据项')
  report(ok5, '确认后：消得掉')
}

group('[26] 起草发布说明：中文提交即中文说明，无上一版不交白卷')
{
  if (!HAS_GIT) {
    skipGroup('[26] 起草发布说明', '环境里没有 git')
  } else {
    const draft = (dir, ...a) => spawnSync(process.execPath,
      [join(HERE, 'draft-release-notes.mjs'), ...a], { encoding: 'utf8', cwd: dir })
    const repo = fixture('draft-repo', { 'README.md': '# x\n' })
    for (const args of [['init', '-q'], ['config', 'user.name', 'T'],
      ['config', 'user.email', 't@e.com'], ['add', '-A'], ['commit', '-q', '-m', '中文首版']]) {
      spawnSync('git', args, { cwd: repo })
    }
    spawnSync('git', ['tag', 'v9.9.1'], { cwd: repo })
    writeFileSync(join(repo, 'CHANGE.txt'), 'more\n', 'utf8')
    for (const args of [['add', '-A'], ['commit', '-q', '-m', '中文第二版']]) {
      spawnSync('git', args, { cwd: repo })
    }
    spawnSync('git', ['tag', 'v9.9.2'], { cwd: repo })

    const r1 = draft(repo, 'v9.9.2', join(repo, 'notes.md'))
    const t1 = existsSync(join(repo, 'notes.md')) ? readFileSync(join(repo, 'notes.md'), 'utf8') : ''
    const ok1 = r1.status === 0 && /中文第二版/.test(t1) && !/中文首版/.test(t1)
    check(ok1, '区间提交逐条列出，不含上一版之前', t1.split('\n')[0])
    report(ok1, '区间正确：只含本版提交')
    const ok2 = /完整改动/.test(t1)
    check(ok2, '带完整改动对比行')
    report(ok2, '对比行：有')

    const r2 = draft(repo, 'v0.0.0-nope', join(repo, 'bad.md'))
    const ok3 = r2.status !== 0 && /不存在/.test(r2.stderr ?? '')
    check(ok3, '不存在的标签拒绝并指路（先打标签）')
    report(ok3, '坏标签：拒绝')
  }
}

if (!HAS_GIT) {
  skipGroup('[27] 署名门禁：有仓库无署名必报缺', '环境里没有 git')
} else {
group('[27] 署名门禁：有仓库无署名必报缺，有署名放行')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

  // 有仓库、无任何署名 → 缺。把全局配置从环境里隔离掉，测的是真缺失
  // （否则本机全局署名会继承进来，缺的数量永远是 0）。
  const bare = fixture('review-nosig', { 'README.md': '# x\n' })
  spawnSync('git', ['init', '-q'], { cwd: bare })
  const noGlobalEnv = {
    ...process.env,
    HOME: bare,
    USERPROFILE: bare,
    GIT_CONFIG_GLOBAL: join(bare, 'no-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const reviewNoGlobal = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8', env: noGlobalEnv })
  const r1 = reviewNoGlobal(bare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const out1 = `${r1.stdout ?? ''}\n${r1.stderr ?? ''}`
  const ok1 = /署名缺失/.test(out1)
  check(ok1, '无署名报缺', out1.split('\n')[0])
  report(ok1, '无署名：报缺')

  // 同一仓库补上署名 → 放行（只看有无，占位值靠人眼是 G7 的事）
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: bare })
  spawnSync('git', ['config', 'user.email', 't@e.com'], { cwd: bare })
  const r2 = reviewNoGlobal(bare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok2 = /提交署名有/.test(r2.stdout ?? '')
  check(ok2, '有署名放行')
  report(ok2, '有署名：放行')
}
}

group('[28] DSH 插件：Bundle 与双半区按事实识别，不写死取值')
{
  // 最小 host-only bundle：有补丁声明 + 补丁含包名 + host 入口
  const hostOnly = fixture('dsh-hostonly', {
    'package.json': JSON.stringify({
      name: 'dsh-hello', version: '0.1.0', type: 'module',
      main: 'lib/index.js', exports: { '.': './lib/index.js' },
      files: ['lib/index.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: hello\n      name: 'dsh-hello'\n",
    'lib/index.js': 'export const name = "hello"\n',
  })
  const s1 = survey(hostOnly)
  const ok1 = (s1.ecosystem?.kinds ?? []).includes('dsh-plugin')
  check(ok1, 'host-only bundle 认出 dsh-plugin', JSON.stringify(s1.ecosystem?.kinds))
  report(ok1, 'host-only：认出 dsh-plugin')
  const ok2 = s1.dsh?.bundlePatch?.exists === true && s1.dsh?.hasClientDecl === false
  check(ok2, '补丁存在且无 client 声明', JSON.stringify(s1.dsh))
  report(ok2, 'host-only：补丁存在、无 client')
  const ok3 = s1.dsh?.discoveryCarrierLikely === true
  check(ok3, '补丁含包名 → 发现载体可能存在', String(s1.dsh?.discoveryCarrierLikely))
  report(ok3, 'host-only：载体检查通过')
  compose(hostOnly)
  const t1 = readFileSync(join(hostOnly, 'AGENTS.md'), 'utf8')
  const ok4 = /插件标识与加载/.test(t1) && !/双半区与浏览器产物/.test(t1)
  check(ok4, '生成契约含标识节、不含双半区节（按事实取舍）')
  report(ok4, 'host-only：条件段取舍正确')

  // 双面 bundle：client 声明 + 双入口 + 补丁含包名
  const dual = fixture('dsh-dual', {
    'package.json': JSON.stringify({
      name: '@scope/dsh-dual', version: '0.1.0', type: 'module',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      files: ['lib/index.js', 'lib/client.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: dual\n      name: '@scope/dsh-dual'\n",
    'lib/index.js': 'export function apply() {}\n',
    'lib/client.js': 'globalThis.x = 1\n',
  })
  const s2 = survey(dual)
  const ok5 = s2.dsh?.hasClientDecl === true && s2.dsh?.hasClientEntry === true
  check(ok5, '双面：client 声明与入口同时识别', JSON.stringify(s2.dsh))
  report(ok5, '双面：client 识别')
  compose(dual)
  const t2 = readFileSync(join(dual, 'AGENTS.md'), 'utf8')
  const ok6 = /双半区与浏览器产物/.test(t2) && /补丁层与挂载/.test(t2)
  check(ok6, '双面契约含双半区与补丁层两节')
  report(ok6, '双面：两节都在')

  // 缺载体：补丁文本里没有包名 → 告警，不硬判失败
  const nocarrier = fixture('dsh-nocarrier', {
    'package.json': JSON.stringify({
      name: 'dsh-nocarrier', version: '0.1.0',
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: other\n      name: 'some-other-package'\n",
  })
  const s3 = survey(nocarrier)
  const ok7 = s3.dsh?.discoveryCarrierLikely === false
    && (s3.dsh?.warnings ?? []).some((w) => /载体/.test(w))
  check(ok7, '缺载体 → 报警告（不断言加载一定失败）', JSON.stringify(s3.dsh?.warnings))
  report(ok7, '缺载体：报警告')

  // 声明与入口不一致：有 client 声明无 ./client 入口 → 告警
  const mismatch = fixture('dsh-mismatch', {
    'package.json': JSON.stringify({
      name: 'dsh-mismatch', version: '0.1.0',
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: m\n      name: 'dsh-mismatch'\n",
  })
  const s4 = survey(mismatch)
  const ok8 = (s4.dsh?.warnings ?? []).some((w) => /.\/client/.test(w))
  check(ok8, 'client 声明无入口 → 报警告', JSON.stringify(s4.dsh?.warnings))
  report(ok8, '声明入口不一致：报警告')

  // 反向：普通 node 项目不出现 DSH 段
  const plain = fixture('dsh-plain', {
    'package.json': JSON.stringify({ name: 'plain', version: '1.0.0', scripts: { test: 'x' } }),
  })
  compose(plain)
  const t3 = readFileSync(join(plain, 'AGENTS.md'), 'utf8')
  const ok9 = !/插件标识与加载/.test(t3)
  check(ok9, '非插件项目不含 DSH 段（不制造噪音）')
  report(ok9, '非插件：不误报 DSH 段')
}

group('[32] DSH 新事实与本地 skills：按分发判、不写死名单')
{
  // files 缺 lib：成品包路线应报缺（review 拦），勘察只报事实
  const nofiles = fixture('dsh-nofiles', {
    'package.json': JSON.stringify({
      name: 'dsh-nofiles', version: '0.1.0', type: 'module',
      main: 'lib/index.js', exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: n\n      name: 'dsh-nofiles'\n",
    'lib/index.js': 'export const name = "n"\n',
  })
  const sn = survey(nofiles)
  const okN1 = sn.dsh?.filesHasLib === false
  check(okN1, 'files 缺 lib → 事实为假', JSON.stringify(sn.dsh?.filesHasLib))
  report(okN1, 'files 缺 lib：勘察报假')

  // invariant 入口识别
  const inv = fixture('dsh-invariant', {
    'package.json': JSON.stringify({
      name: 'dsh-inv', version: '0.1.0', type: 'module',
      exports: { '.': './lib/index.js', './invariant': './lib/invariant.js' },
      files: ['lib/index.js', 'lib/invariant.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: v\n      name: 'dsh-inv'\n",
    'lib/index.js': 'export const name = "v"\n',
    'lib/invariant.js': 'export const name = "v-invariant"\n',
  })
  const si = survey(inv)
  const okN2 = si.dsh?.hasInvariantEntry === true
  check(okN2, 'invariant 入口识别', JSON.stringify(si.dsh?.exportsKeys))
  report(okN2, 'invariant：识别')
  compose(inv)
  const ti = readFileSync(join(inv, 'AGENTS.md'), 'utf8')
  const okN2b = /伴生/.test(ti)
  check(okN2b, '有 invariant → 契约含伴生段')
  report(okN2b, 'invariant：契约渲染')

  // 宿主运行时放错位置
  const baddep = fixture('dsh-baddep', {
    'package.json': JSON.stringify({
      name: 'dsh-baddep', version: '0.1.0',
      exports: { '.': './lib/index.js' },
      files: ['lib/index.js', 'cordis.patch.yml'],
      dependencies: { cordis: '^4.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: b\n      name: 'dsh-baddep'\n",
    'lib/index.js': 'export const name = "b"\n',
  })
  const sb = survey(baddep)
  const okN3 = sb.dsh?.hostRuntimeInDeps === true
  check(okN3, '宿主运行时进 dependencies → 标出', JSON.stringify(sb.dsh?.hostRuntimeInDeps))
  report(okN3, '依赖放错：标出')

  // 本地 skills 通用盘点：完全不同的名字也能认出，不写死名单
  const wskills = fixture('localskills', {
    'package.json': JSON.stringify({ name: 'w', version: '1.0.0' }),
    '.claude/skills/my-helper/SKILL.md': '---\nname: my-helper\ndescription: 帮我整理发布说明的本地 workflow\n---\n\n# my-helper\n',
  })
  const sw = survey(wskills)
  const okN4 = Array.isArray(sw.localSkills) && sw.localSkills.some((x) => x.path === '.claude/skills/my-helper')
  check(okN4, '本地 skills 按位置盘点（不写死名单）', JSON.stringify(sw.localSkills))
  report(okN4, '本地 skills：盘点出')
  compose(wskills)
  const tw = readFileSync(join(wskills, 'AGENTS.md'), 'utf8')
  const okN4b = /仓库本地 skills/.test(tw)
  check(okN4b, '有 skills → 契约含本地 skills 段')
  report(okN4b, '本地 skills：契约渲染')

  // 反向：无 skills 时为空数组，不误报
  const noskills = fixture('noskills', {
    'package.json': JSON.stringify({ name: 'n', version: '1.0.0' }),
  })
  const sn2 = survey(noskills)
  const okN5 = Array.isArray(sn2.localSkills) && sn2.localSkills.length === 0
  check(okN5, '无 skills 时为空（不误报）', JSON.stringify(sn2.localSkills))
  report(okN5, '无 skills：为空')
}

group('[29] CONTRIBUTING 内容门：通用齐全才放行，专属按生态查')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const GOOD = `# C 贡献指南

## 提问与反馈

到 Issue 区提出。

## 报告缺陷

四件事。

## 提出改动

先 fork，在分支上开发，跑完门禁全绿再提交开请求。不推主干，不打标签，不发布。

## 开发环境

用 pnpm 安装依赖后构建测试。

## 提交前门禁

跑构建测试，全绿才算完成。

## 硬性规范

完整规范以 AGENTS.md 为准。

## 提交信息

一句话。

## 许可

见 LICENSE。
`

  // 好文件：node+插件生态下无 CONTRIBUTING 缺项
  const good = fixture('contrib-good', {
    'package.json': JSON.stringify({
      name: 'p', version: '1.0.0', scripts: { build: 'tsc', test: 'vitest run' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: p\n      name: 'p'\n",
    'AGENTS.md': '# p\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    'README.md': '# p\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': `${GOOD}产物与源码一起提交。本地挂载后重启宿主验证。\n`,
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const r1 = review(good, '--no-bilingual', '--no-auto-release')
  const ok1 = !/CONTRIBUTING 缺/.test(r1.stdout ?? '')
  check(ok1, '好文件不报 CONTRIBUTING 缺', (r1.stdout ?? '').split('\n').find((l) => /CONTRIBUTING/.test(l)) ?? '')
  report(ok1, '好文件：放行')

  // 缺 fork 与门禁 → 报缺
  const bad = fixture('contrib-bad', {
    'package.json': JSON.stringify({ name: 'q', version: '1.0.0', scripts: { test: 'x' } }),
    'AGENTS.md': '# q\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    'README.md': '# q\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': '# 贡献\n\n随便改改就行。\n',
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const r2 = review(bad, '--no-bilingual', '--no-auto-release')
  const ok2 = r2.status !== 0 && /CONTRIBUTING 缺/.test(r2.stdout ?? '')
  check(ok2, '缺核心节报缺且非零退出', `exit=${r2.status}`)
  report(ok2, '坏文件：拦得住')

  // 插件缺产物同提交 → 报缺
  const noartifact = fixture('contrib-noartifact', {
    'package.json': JSON.stringify({
      name: 'r', version: '1.0.0', scripts: { test: 'x' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: r\n      name: 'r'\n",
    'AGENTS.md': '# r\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    'README.md': '# r\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': GOOD,
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const r3 = review(noartifact, '--no-bilingual', '--no-auto-release')
  const ok3 = /产物同提交/.test(r3.stdout ?? '')
  check(ok3, '插件缺产物同提交报缺', (r3.stdout ?? '').split('\n').find((l) => /产物/.test(l)) ?? '')
  report(ok3, '插件专属：拦得住')
}

group('[30] 事实采全与门禁诚实：tracked/远端/发布链/截断/strict')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

  // 敏感文件名带 tracked 比特（无仓库时为尚未跟踪，不断言真值只断言形状）
  {
    const dir = fixture('facts-secretfile', { '.env': 'x=1\n', 'README.md': '# x\n' })
    const hits = survey(dir).risks?.secretFiles ?? []
    const ok = Array.isArray(hits) && hits.length > 0
      && hits.every((h) => typeof h.path === 'string' && typeof h.tracked === 'boolean')
      // 两个比特都要在：tracked 决定「能不能从这次提交排除」，ignored 决定
      // 「进不进版本库」。缺一个，门禁就只能一律报缺。
      && hits.every((h) => typeof h.ignored === 'boolean')
    check(ok, 'secretFiles 带 path/tracked（分案首问可答）', JSON.stringify(hits.slice(0, 2)))
    report(ok, 'secretFiles：形状正确')
  }

  // Obsidian 发布链：含 minAppVersion 即有可发布身份、版本号与下限
  {
    const dir = fixture('facts-obsidian', {
      'manifest.json': JSON.stringify({
        id: 'my-plugin', name: 'My Plugin', version: '1.2.3', minAppVersion: '1.0.0',
        description: 'd', author: 'a', isDesktopOnly: false,
      }),
      'main.js': 'module.exports = {}\n',
    })
    const s = survey(dir)
    const ok = (s.ecosystem?.kinds ?? []).includes('obsidian-plugin')
      && s.artifacts?.publishableManifest?.ecosystem === 'obsidian'
      && s.artifacts?.declaredVersion === '1.2.3'
      && (s.artifacts?.runtimeRequirements ?? []).some((r) => r.runtime === 'obsidian')
    check(ok, 'Obsidian 有发布身份/版本/下限', JSON.stringify(s.artifacts?.publishableManifest))
    report(ok, 'Obsidian：发布链不断')

    const pwa = fixture('facts-pwa', {
      'manifest.json': JSON.stringify({ name: 'App', short_name: 'App', start_url: '/' }),
      'index.html': '<html></html>\n',
    })
    const sp = survey(pwa)
    const okPwa = !(sp.ecosystem?.kinds ?? []).includes('obsidian-plugin')
      && sp.artifacts?.publishableManifest === undefined
    check(okPwa, 'PWA 同名文件不进发布链', JSON.stringify(sp.ecosystem?.kinds))
    report(okPwa, 'PWA：不误判发布身份')
  }

  // 工作流超 64KB 置 truncated，不把“没看到”当“没有”
  {
    const big = `# pad\n${'x'.repeat(70000)}\ngh release create\n`
    const dir = fixture('facts-bigwf', {
      'package.json': '{"name":"w","version":"1.0.0"}\n',
      '.github/workflows/release.yml': `name: release\non: [push]\njobs:\n  r:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n${big}`,
    })
    const auto = survey(dir).docs?.workflowAutomation
    const ok = auto?.truncated === true
    check(ok, '大工作流标 truncated', JSON.stringify({ truncated: auto?.truncated }))
    report(ok, '工作流截断：诚实')
  }

  // 双非默认 README 同样成对（缺默认需标出）
  {
    const dir = fixture('facts-bipair', {
      'README.zh-CN.md': '# 中文\n',
      'README.en.md': '# English\n',
      'src/a.js': 'export const a=1\n',
    })
    const pair = survey(dir).docs?.readmePair
    const ok = pair !== undefined && pair.defaultMissing === true
    check(ok, '双非默认成对并标 defaultMissing', JSON.stringify(pair))
    report(ok, '双语：双非默认不漏')
  }

  // --strict：仅剩待问时默认放行、严格拦住
  {
    const contrib = '# C\n\n## 提问与反馈\n到 Issue 区。\n\n## 报告缺陷\n四件事。\n\n'
      + '## 提出改动\n先 fork，在分支上开发，门禁全绿开请求。不推主干，不打标签，不发布。\n\n'
      + '## 开发环境\n用 pnpm 安装依赖。\n\n## 提交前门禁\n跑构建测试，全绿。\n\n'
      + '## 硬性规范\n完整规范以 AGENTS.md 为准。\n\n## 提交信息\n一句话。\n\n## 许可\n见 LICENSE。\n'
    const dir = fixture('facts-strict', {
      'package.json': JSON.stringify({ name: 't', version: '1.0.0', private: true, scripts: { test: 'x' } }),
      'README.md': '# t\n',
      'LICENSE': 'MIT\n',
      'CONTRIBUTING.md': contrib,
      '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
    })
    // 用脚本生成合法 AGENTS 并填实，使“仅剩双语待问”精确成立
    compose(dir)
    const apath = join(dir, 'AGENTS.md')
    writeFileSync(apath, readFileSync(apath, 'utf8')
      .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写）'), 'utf8')
    const r1 = review(dir)
    const ok1 = r1.status === 0 && /\[待问\]/.test(r1.stdout ?? '')
    check(ok1, '仅剩待问时默认 exit 0 但有待问', `exit=${r1.status}`)
    report(ok1, '默认：待问不拦但明示')
    const r2 = review(dir, '--strict')
    const ok2 = r2.status === 2 && /\[待问\]/.test(r2.stdout ?? '')
    check(ok2, '--strict 下待问 exit 2', `exit=${r2.status}`)
    report(ok2, '严格：待问拦得住')
  }

  if (!HAS_GIT) {
    skipGroup('[30] git 相关事实（远端/署名历史/标签对齐/上游）', '环境里没有 git')
  } else {
    // 远端全地址 + 历史署名（全局配置走临时文件，不碰本机真实全局配置）
    const dir = fixture('facts-git', { 'README.md': '# x\n' })
    for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.invalid/r.git'],
      ['remote', 'add', 'fork', 'https://example.invalid/f.git'],
      ['config', 'user.name', 'T'], ['config', 'user.email', 't@e.com']]) {
      spawnSync('git', args, { cwd: dir })
    }
    spawnSync('git', ['add', '-A'], { cwd: dir })
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    writeFileSync(join(dir, 'fake-global-gitconfig'), '[user]\n\tname = G\n\temail = g@e.com\n', 'utf8')
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL
    const prevNoSys = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'fake-global-gitconfig')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    let g = {}
    try {
      g = survey(dir).git ?? {}
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal
      if (prevNoSys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
      else process.env.GIT_CONFIG_NOSYSTEM = prevNoSys
    }
    const okUrl = g.remoteUrls?.origin === 'https://example.invalid/r.git'
      && g.remoteUrls?.fork === 'https://example.invalid/f.git'
    check(okUrl, '远端全地址可查（fork 比对有米）', JSON.stringify(g.remoteUrls))
    report(okUrl, '远端：全地址')
    const okMail = g.identity?.globalEmail === 'g@e.com'
    check(okMail, '全局邮箱可查', String(g.identity?.globalEmail))
    report(okMail, '署名：全局邮箱')

    // 标签与版本号未对齐 → 事实 false，review 报待问
    const ver = fixture('facts-ver', {
      'package.json': JSON.stringify({ name: 'v', version: '1.2.3' }),
      'README.md': '# v\n',
    })
    for (const args of [['init', '-q'], ['config', 'user.name', 'T'], ['config', 'user.email', 't@e.com']]) {
      spawnSync('git', args, { cwd: ver })
    }
    spawnSync('git', ['add', '-A'], { cwd: ver })
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: ver })
    spawnSync('git', ['tag', 'v9.9.9'], { cwd: ver })
    const va = survey(ver).artifacts ?? {}
    const okVa = va.versionAligned === false
    check(okVa, '标签版本不一致判 false（不编造对齐）', String(va.versionAligned))
    report(okVa, '版本对齐：事实比对')
  }
}

group('[31] DSH 专章滞后提醒：对齐安静，漂移警告，不拦流程')
{
  const mkDual = (ver) => fixture(`dsh-fresh-${ver.replace(/[^a-z0-9]+/gi, '_')}`, {
    'package.json': JSON.stringify({
      name: 'dsh-fresh', version: '0.1.0',
      devDependencies: { '@deepseek-ai/dsh-foo': ver },
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: fresh\n      name: 'dsh-fresh'\n",
    'lib/index.js': 'export const name = "fresh"\n',
  })
  // 与标记一致 → 安静（只断言无警告，不断言其他输出）
  //
  // 基准从专章的核对标记**现场取**，不写死版本号：写死就等于每次重核宿主后都要有人
  // 记得来改这个 fixture，而忘了改的症状恰好就是「对齐场景报红」——那会让人误以为
  // 实现坏了。对齐断言该问的只有一件事：**与标记相同的锁定版本，会不会被误报成漂移**。
  {
    const markerText = readFileSync(join(SKILL_ROOT, 'references', 'plugins', 'dsh.md'), 'utf8')
    const hostPin = /dsh-verified:\s*host=(\S+)/.exec(markerText)?.[1]
    check(typeof hostPin === 'string' && hostPin.length > 0,
      '专章核对标记的 host= 取得到（对齐 fixture 的基准）', String(hostPin))
    report(typeof hostPin === 'string' && hostPin.length > 0, `专章标记 host=${hostPin}`)
    const dir = mkDual(`^${hostPin}`)
    const pin = `^${hostPin}`
    const pinned = survey(dir).dsh?.pinnedVersions ?? []
    const okPin = pinned.includes(pin)
    check(okPin, '锁定版本被收录', JSON.stringify(pinned))
    report(okPin, '锁定版本：收录')
    const r = compose(dir)
    const okQuiet = !/兼容范围/.test(r.stdout ?? '')
    check(okQuiet, '兼容范围与标记一致时无提示')
    report(okQuiet, '对齐：安静')
  }
  // 漂移 → 提示但不失败。
  //
  // 哨兵值**从基准派生**，不写死 `9.9.9`：写死的话，专章标记恰好是 9.9.9 时这个
  // 反例会静默退化成「对齐」用例——一个不再能证伪的断言（实测过这类碰撞风险）。
  {
    const markerForDrift = readFileSync(join(SKILL_ROOT, 'references', 'plugins', 'dsh.md'), 'utf8')
    const base = /dsh-verified:\s*[^>]*?host=(\S+)/.exec(markerForDrift)?.[1] ?? '1.0.0'
    const driftPin = base === '9.9.9' ? '8.8.8' : '9.9.9'
    const dir = mkDual(`^${driftPin}`)
    const r = compose(dir)
    const okWarn = /兼容范围/.test(r.stdout ?? '') && r.status === 0
    check(okWarn, '兼容范围与标记不同时提示且不拦流程', `exit=${r.status}`)
    report(okWarn, '漂移：提示')
  }
  // 未知 dsh 字段现形；已知字段不误报
  {
    const dir = fixture('dsh-unknownkey', {
      'package.json': JSON.stringify({
        name: 'dsh-unk', version: '0.1.0',
        exports: { '.': './lib/index.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, frobnicate: {} },
      }, null, 2),
      'cordis.patch.yml': "- insert:\n    - id: unk\n      name: 'dsh-unk'\n",
    })
    const unk = survey(dir).dsh?.unknownKeys ?? []
    const okUnk = unk.includes('frobnicate')
    check(okUnk, '未知 dsh 字段被点名', JSON.stringify(unk))
    report(okUnk, '未知字段：现形')
    const md = spawnSync(process.execPath, [join(HERE, 'survey.mjs'), dir, '--markdown'],
      { encoding: 'utf8' }).stdout ?? ''
    const okMd = /不认识的字段/.test(md) && /frobnicate/.test(md)
    check(okMd, '报告里写明未知字段名', 'markdown 含提示行')
    report(okMd, '未知字段：报告可读')
  }
}

group('[34] Python/Go/Rust 发布事实与门禁：只认本生态清单')
{
  const rv = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const rvOut = (r) => r.stdout ?? ''

  // Python：有后端 → 有构建命令、无构建后端待问
  const pyFull = fixture('eco-pyfull', {
    'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\nrequires-python = ">=3.10"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
  })
  const sp = survey(pyFull)
  const okP1 = sp.artifacts?.pythonBuild?.hasBuildSystem === true
    && survey(pyFull).commands?.build === 'python -m build'
  check(okP1, 'Python 有后端 → 有构建命令', JSON.stringify(survey(pyFull).commands?.build))
  report(okP1, 'Python：构建命令有权威来源')
  const okP2 = !/构建后端/.test(rvOut(rv(pyFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okP2, 'Python 有后端 → 门禁不问构建后端')
  report(okP2, 'Python：门禁放行')
  const pyBare = fixture('eco-pybare', { 'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n' })
  const okP3 = survey(pyBare).artifacts?.pythonBuild?.hasBuildSystem === false
    && /构建后端/.test(rvOut(rv(pyBare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okP3, 'Python 无后端 → 事实为假且门禁待问')
  report(okP3, 'Python：缺后端拦得住')

  // Go：有 go 指令 → 无待问；无 → 待问；retract 照实读
  const goFull = fixture('eco-gofull', {
    'go.mod': 'module example.com/m\n\ngo 1.22\n',
  })
  const sg = survey(goFull)
  const okG1 = sg.artifacts?.goModule?.module === 'example.com/m'
    && sg.artifacts?.goModule?.goDirective === '1.22'
    && sg.artifacts?.goModule?.hasRetract === false
  check(okG1, 'Go 读出模块路径、指令与 retract', JSON.stringify(sg.artifacts?.goModule))
  report(okG1, 'Go：事实照实读')
  const okG2 = !/go 指令/.test(rvOut(rv(goFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okG2, 'Go 有指令 → 门禁不问')
  report(okG2, 'Go：门禁放行')
  const goBare = fixture('eco-gobare', { 'go.mod': 'module example.com/m\n' })
  const okG3 = /go 指令/.test(rvOut(rv(goBare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okG3, 'Go 无指令 → 门禁待问')
  report(okG3, 'Go：缺指令问得住')

  // Rust：元数据齐 → 放行；缺 license → 报缺；publish=false → 不可发布
  const rsFull = fixture('eco-rsfull', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\n',
  })
  const okR1 = !/Rust 缺/.test(rvOut(rv(rsFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okR1, 'Rust 元数据齐 → 门禁不拦')
  report(okR1, 'Rust：门禁放行')
  const rsBare = fixture('eco-rsbare', { 'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\n' })
  const rBare = rvOut(rv(rsBare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okR2 = /Rust 缺 license/.test(rBare) && /Rust 缺 description/.test(rBare)
  check(okR2, 'Rust 缺元数据 → 报缺')
  report(okR2, 'Rust：缺项拦得住')
  const rsPriv = fixture('eco-rspriv', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\npublish = false\n',
  })
  const okR3 = survey(rsPriv).artifacts?.private === true
  check(okR3, 'Rust publish=false → 不可发布', String(survey(rsPriv).artifacts?.private))
  report(okR3, 'Rust：私有开关复用机器')
  compose(rsPriv)
  const okR4 = /不对外发布/.test(readFileSync(join(rsPriv, 'AGENTS.md'), 'utf8'))
  check(okR4, 'Rust 私有 → 契约写不对外发布')
  report(okR4, 'Rust：契约一致')

  // Rust 新增位：keywords 超 5 个报缺（服务端拒绝），edition 缺席只待问（可发布）。
  // 正反都要：超了拦得住，不超不误报——只验正面等于没验。
  const rsOver = fixture('eco-rsover', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\nkeywords = ["a", "b", "c", "d", "e", "f"]\n',
  })
  const rOver = rvOut(rv(rsOver, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okR5 = /keywords 6 个/.test(rOver)
  check(okR5, 'Rust keywords 超 5 → 报缺', rOver.split('\n').find((l) => /keywords/.test(l)) ?? '')
  report(okR5, 'Rust：超限拦得住')
  const rFull2 = rvOut(rv(rsFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okR6 = !/keywords/.test(rFull2) && /edition/.test(rFull2)
  check(okR6, 'Rust 元数据齐 → 不误报超限，但提示 edition 未声明')
  report(okR6, 'Rust：反向不误报')

  // Python 新增位：缺 readme/license 报缺（服务端大概率拒绝），缺 requires-python
  // 只待问（不挡发布），dynamic version 提示 tag 对齐按后端取值。
  const pyNoReadme = fixture('eco-pynoreadme', {
    'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
  })
  const rPyNo = rvOut(rv(pyNoReadme, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okPy4 = /Python 缺 readme/.test(rPyNo) && /Python 缺 license/.test(rPyNo)
  check(okPy4, 'Python 缺 readme/license → 报缺', rPyNo.split('\n').find((l) => /Python 缺/.test(l)) ?? '')
  report(okPy4, 'Python：缺元数据拦得住')
  const pyDyn = fixture('eco-pydyn', {
    'pyproject.toml': '[project]\nname = "p"\ndynamic = ["version"]\nreadme = "README.md"\nlicense = "MIT"\nrequires-python = ">=3.10"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    'README.md': '# p\n',
  })
  const rPyDyn = rvOut(rv(pyDyn, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okPy5 = !/Python 缺/.test(rPyDyn) && /dynamic/.test(rPyDyn)
  check(okPy5, 'Python 元数据齐 + dynamic → 不报缺，但提示对齐按后端取值')
  report(okPy5, 'Python：dynamic 提示到位')
}

group('[35] Obsidian 发布链：附件语境与触发器形状，机器说了算')
{
  const rv = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const rvOut = (r) => r.stdout ?? ''
  const baseFlags = ['--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release']
  const manifestOf = (id) => JSON.stringify({
    id, name: 'My Plugin', version: '1.2.3', minAppVersion: '1.0.0',
    description: 'd.', author: 'a', isDesktopOnly: false,
  })
  // 未构建态的 CONTRIBUTING 骨架：review 的 CONTRIBUTING 门只认关键词有无，
  // 这里给一份关键词齐全的，把变量固定在 Obsidian 门上，不让贡献指南门串扰。
  const OBS_CONTRIB = '# C\n\n提问与反馈到 Issue 区。\n\n报告缺陷四件事。\n\n'
    + '提出改动：先 fork，在分支上开发，门禁全绿开请求。不推主干，不打标签，不发布。\n\n'
    + '开发环境：构建测试。\n\n提交前门禁：跑构建测试，全绿。\n\n'
    + '硬性规范：完整规范以 AGENTS.md 为准。\n\n提交信息：一句话。\n\n许可：见 LICENSE。\n\n'
    + '产物与源码一起提交。本地挂载后重启宿主验证。\n'

  // 1) 官方模板态：main.js 被忽略、根目录无 main.js → 不报缺，只报附件待核。
  // 旧判据在这里报“产物缺 main.js”，按官方模板做的项目永远过不了门——这就是要锁死的回归。
  const tplState = fixture('obs-tplstate', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
  })
  const sTpl = survey(tplState)
  const okT1 = sTpl.artifacts?.obsidianArtifacts?.mainJs === false
    && sTpl.artifacts?.obsidianArtifacts?.mainJsIgnored === true
  check(okT1, '模板态：main.js 缺但被忽略 → 事实分得清', JSON.stringify(sTpl.artifacts?.obsidianArtifacts))
  report(okT1, 'Obsidian：模板态事实正确')
  const rTpl = rvOut(rv(tplState, ...baseFlags))
  const okT2 = !/产物缺 main\.js/.test(rTpl) && /只进发布附件/.test(rTpl)
  check(okT2, '模板态：不报“产物缺”，报附件语境')
  report(okT2, 'Obsidian：模板态不误报')

  // 2) 反向：main.js 既不在根目录、也没被忽略 → 待问（还没构建 or 忽略漏了）。
  const noBuild = fixture('obs-nobuild', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    'README.md': '# p\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': OBS_CONTRIB,
    'AGENTS.md': '# p\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const rNoBuild = rvOut(rv(noBuild, ...baseFlags))
  const okN1 = /还没构建/.test(rNoBuild)
  check(okN1, '未构建态 → 待问（不报缺）')
  report(okN1, 'Obsidian：未构建问得住')

  // 3) id 形状非法（含大写 obsidian 结尾 plugin 三毒俱全）→ 报缺，拦得住。
  const badId = fixture('obs-badid', {
    'manifest.json': `${manifestOf('Obsidian-Foo-Plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
  })
  const rBad = rvOut(rv(badId, ...baseFlags))
  const okB1 = /形状非法/.test(rBad)
  check(okB1, '非法 id → 报缺', rBad.split('\n').find((l) => /形状/.test(l)) ?? '')
  report(okB1, 'Obsidian：非法 id 拦得住')

  // 4) 触发器形状：v* 触发器 + refs/tags/v 条件 → 待问裸版本；裸版本触发器则安静。
  const vTrigger = fixture('obs-vtrigger', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    if: startsWith(github.ref, \'refs/tags/v\')\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const rV = rvOut(rv(vTrigger, ...baseFlags))
  const okV1 = /裸版本/.test(rV)
  check(okV1, 'v* 触发器 → 待问裸版本')
  report(okV1, 'Obsidian：v 形状问得住')
  const bareTrigger = fixture('obs-baretrigger', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["[0-9]*.[0-9]*.[0-9]*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const rBare = rvOut(rv(bareTrigger, ...baseFlags))
  const okV2 = !/裸版本/.test(rBare)
  check(okV2, '裸版本触发器 → 不误报')
  report(okV2, 'Obsidian：裸形安静')
}

group('[36] 发布自动化接线：动作痕迹无 OIDC 即待问，有 OIDC 即安静')
{
  const rv = (dir, ...a) => spawnSync(process.execPath,
    [join(HERE, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const rvOut = (r) => r.stdout ?? ''
  const baseFlags = ['--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release']
  const relBase = (extraStep) => 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n'
    + `      - run: ${extraStep}\n        env:\n          GH_TOKEN: \${{ secrets.RELEASE_TOKEN }}\n`

  // npm：有 publish 无 OIDC → 待问；加了 id-token 即安静。
  const npmNo = fixture('auto-npmno', {
    'package.json': '{"name":"p","version":"1.0.0"}\n',
    '.github/workflows/release.yml': `${relBase('npm publish')}`,
  })
  const okN1 = /npm 有发布动作但无 OIDC/.test(rvOut(rv(npmNo, ...baseFlags)))
  check(okN1, 'npm 无 OIDC → 待问')
  report(okN1, 'npm 接线：问得住')
  const npmYes = fixture('auto-npmyes', {
    'package.json': '{"name":"p","version":"1.0.0"}\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n        env:\n          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}\n',
  })
  const okN2 = !/npm 有发布动作但无 OIDC/.test(rvOut(rv(npmYes, ...baseFlags)))
  check(okN2, 'npm 有 OIDC → 不误报')
  report(okN2, 'npm 接线：安静')

  // PyPI：twine 痕迹无 OIDC → 待问。
  const pyNo = fixture('auto-pyno', {
    'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n',
    '.github/workflows/release.yml': `${relBase('twine upload dist/*')}`,
  })
  const okP1 = /PyPI 有发布动作但无 OIDC/.test(rvOut(rv(pyNo, ...baseFlags)))
  check(okP1, 'PyPI 无 OIDC → 待问')
  report(okP1, 'PyPI 接线：问得住')

  // cargo：cargo publish 痕迹无 OIDC → 待问。
  const rsNo = fixture('auto-rsno', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\n',
    '.github/workflows/release.yml': `${relBase('cargo publish')}`,
  })
  const okR1 = /crates\.io 有发布动作但无 OIDC/.test(rvOut(rv(rsNo, ...baseFlags)))
  check(okR1, 'cargo 无 OIDC → 待问')
  report(okR1, 'cargo 接线：问得住')

  // Release 形状三件套：缺 contents:write 即待问；齐了即安静。
  const noContents = fixture('auto-nocontents', {
    'package.json': '{"name":"p","version":"1.0.0"}\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - run: gh release create test --notes-file n\n        env:\n          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}\n',
  })
  const okC1 = /contents: write/.test(rvOut(rv(noContents, ...baseFlags)))
  check(okC1, '缺 contents:write → 待问')
  report(okC1, 'Release 形状：问得住')
}

group('[37] 保鲜标记判据：好标记放行，坏标记各有断言')
{
  // 测的是 preflight 导出的纯函数，不是整次 preflight——整次跑只能看到本仓库
  // 现状，覆盖不了“坏标记长什么样”。日期相对今天算，不写死：写死的那天起，
  // 用例自己就过期了（那正是本检查要消灭的东西）。
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayMs = Date.parse(`${todayStr}T00:00:00Z`)
  const daysAgo = (n) => new Date(todayMs - n * 86400000).toISOString().slice(0, 10)
  const tomorrowStr = new Date(todayMs + 86400000).toISOString().slice(0, 10)
  const doc = (marker) => `# x\n\n## 事实来源\n\n来源略。\n\n${marker}\n`
  const run = (rel, text) => evalFreshnessMarker(rel, text, todayStr, tomorrowStr)

  // 1) 好标记：当天 → 无错无警告，scope/date/ageDays 正确。
  {
    const r = run('references/publish-npm.md', doc(`<!-- npm-verified: date=${todayStr} -->`))
    const ok = r.errors.length === 0 && r.warnings.length === 0
      && r.scope === 'npm' && r.date === todayStr && r.ageDays === 0
    check(ok, '好标记放行且读出 scope/date/age', JSON.stringify({ scope: r.scope, date: r.date, ageDays: r.ageDays }))
    report(ok, '好标记：放行')
  }

  // 2) 扩展键允许：dsh 的 host= 是合法扩展，检查只认 date。
  {
    const r = run('references/plugins/dsh.md', doc(`<!-- dsh-verified: host=9.9.9 date=${todayStr} -->`))
    const ok = r.errors.length === 0 && r.scope === 'dsh'
    check(ok, '扩展键不拦', JSON.stringify(r.errors))
    report(ok, '扩展键：允许')
  }

  // 3) 坏日期：月份 13、不存在的 2 月 30 日 → 各报一个错。
  {
    const r1 = run('references/publish-go.md', doc('<!-- go-verified: date=2026-13-40 -->'))
    const r2 = run('references/publish-go.md', doc('<!-- go-verified: date=2026-02-30 -->'))
    const ok = r1.errors.length === 1 && r2.errors.length === 1
    check(ok, '坏日期拦得住', `${r1.errors[0] ?? ''} / ${r2.errors[0] ?? ''}`)
    report(ok, '坏日期：拦得住')
  }

  // 4) 未来日期 → 错（笔误）；缺 date → 错。
  {
    const r1 = run('references/publish-go.md', doc('<!-- go-verified: date=9999-01-01 -->'))
    const r2 = run('references/publish-go.md', doc('<!-- go-verified: -->'))
    const ok = r1.errors.some((e) => /未来/.test(e)) && r2.errors.length === 1
    check(ok, '未来与缺 date 拦得住')
    report(ok, '未来/缺 date：拦得住')
  }

  // 5) scope 错位：从别的文件复制忘了改 → 点名双方。
  {
    const r = run('references/publish-npm.md', doc(`<!-- rust-verified: date=${todayStr} -->`))
    const ok = r.errors.some((e) => /rust/.test(e) && /npm/.test(e))
    check(ok, 'scope 错位点名双方', r.errors[0] ?? '')
    report(ok, '错 scope：点名')
  }

  // 6) 超期：阈值之外 → 无错、有警告且报出天数；阈值之内 → 安静。
  {
    const stale = run('references/publish-go.md', doc(`<!-- go-verified: date=${daysAgo(FRESHNESS_STALE_DAYS + 10)} -->`))
    const fresh = run('references/publish-go.md', doc(`<!-- go-verified: date=${daysAgo(FRESHNESS_STALE_DAYS - 10)} -->`))
    const ok = stale.errors.length === 0 && stale.warnings.length === 1
      && /天前/.test(stale.warnings[0]) && fresh.warnings.length === 0
    check(ok, '超期警告、期内安静', stale.warnings[0] ?? '')
    report(ok, '超期：只警告不失败')
  }

  // 7) 双标记 → 错；无标记 → 判据函数无错（“是否必需”由 preflight 按文件家族定）。
  {
    const r1 = run('references/publish-go.md', doc(`<!-- go-verified: date=${todayStr} -->\n\n<!-- go-verified: date=${todayStr} -->`))
    const r2 = run('references/publish-go.md', doc('# x\n\n## 事实来源\n\n来源略。\n'))
    const ok = r1.errors.length === 1 && r2.errors.length === 0 && r2.count === 0
    check(ok, '双标记拦、无标记不判')
    report(ok, '数量：只认恰好一个')
  }

  // 8) 标记在节之前（npm 曾经的结构漂移）→ 错；无节有标记（悬空）→ 错。
  {
    const r1 = run('references/publish-npm.md', `<!-- npm-verified: date=${todayStr} -->\n\n## 事实来源\n\n来源略。\n`)
    const r2 = run('references/publish-npm.md', `# x\n\n<!-- npm-verified: date=${todayStr} -->\n`)
    const ok = r1.errors.some((e) => /之前/.test(e)) && r2.errors.some((e) => /悬空|没有对应/.test(e))
    check(ok, '错位与悬空拦得住')
    report(ok, '位置：必须在节末尾')
  }
}

// ── 检查域与判据的适用范围（守的是一类错误，不是一次） ──────────────────────

group('[38] 文本检查域 = 仓库定义域：本机状态目录不参与，仓库内的照旧全查')
{
  // 这一组守的是**一类**错误：检查器走文件系统，把「工作目录里现在有什么」当成「这个
  // 仓库的内容」。于是依赖目录、编辑器缓存、多智能体协作的团队清单都被拿去查 emoji 与
  // 私有路径，还被要求解释「为什么在这」——而它们 `git ls-files` 计数为 0，根本不属于
  // 这个仓库。
  //
  // 判据必须是仓库的定义域（受跟踪 + 未忽略），且**不能靠往豁免名单里加目录名**：那样
  // 每来一个工具就要再加一条。下面同时给正例与反例：被忽略的目录必须缺席，未忽略的新
  // 目录必须照旧被抓——否则「缺席」可能只是检查失灵。
  const EMOJI_MARK = String.fromCodePoint(0x2795)
  const FAKE_HOME = ['C:', 'Users', 'someone', 'work.md'].join('\\')

  // 1) 判定本身：受跟踪的、未忽略的新文件都在域内，被忽略的不在。
  if (HAS_GIT) {
    const repo = fixture('domain-git', {
      '.gitignore': 'generated-state/\n',
      'tracked.md': '# tracked\n',
      'untracked.md': '# untracked\n',
      'generated-state/state.json': '{ "note": "本机状态" }\n',
    })
    gitIn(repo, 'init')
    gitIn(repo, 'add', 'tracked.md')
    const d = listRepoFiles(repo)
    const ok = d.source === 'git'
      && d.files.includes('tracked.md')
      && d.files.includes('untracked.md')
      && d.files.includes('.gitignore')
      && !d.files.some((p) => p.startsWith('generated-state/'))
      && !d.files.some((p) => p.startsWith('.git/'))
    check(ok, '定义域 = 受跟踪 + 未忽略', JSON.stringify({ source: d.source, files: d.files }))
    report(ok, '定义域：被忽略的目录不进')
  } else {
    skipGroup('[38.1] 定义域的版本控制判定', '本机没有 git')
  }

  // 2) 没有 git 时：退回文件系统扫描（跳过两个一定不属于仓库的目录），判定要如实交代来源。
  {
    const plain = fixture('domain-fs', {
      'a.md': '# a\n',
      'node_modules/pkg/index.js': 'x\n',
      '.git/config': 'y\n',
    })
    const d = listRepoFiles(plain)
    const ok = d.source === 'fs' && d.files.includes('a.md')
      && !d.files.some((p) => p.startsWith('node_modules/') || p.startsWith('.git/'))
    check(ok, '无 git 时降级但可用', JSON.stringify({ source: d.source, files: d.files }))
    report(ok, '降级：退回文件系统扫描')
  }

  // 3) 端到端（正例）：整棵 skill 树 + 被忽略的本机状态目录 → 全绿，且那些目录一个字都不提。
  if (!HAS_GIT) {
    skipGroup('[38.3] 检查域的端到端判定', '本机没有 git')
  } else {
    const clone = join(fixture('domain-e2e', {}), 'project-forge')
    copyTree(SKILL_ROOT, clone, new Set(['.git', '.agent-teams', 'node_modules', 'selftest.mjs']))
    writeFileSync(join(clone, 'scripts', 'selftest.mjs'), SELFTEST_STUB, 'utf8')
    // 两个本机状态目录：一个被仓库自己的 .gitignore 兜住（真实场景），一个由本 fixture
    // 新加一条忽略规则兜住——后者证明判据认的是「被忽略」这件事，不是某个目录名。
    mkdirSync(join(clone, '.agent-teams'), { recursive: true })
    writeFileSync(join(clone, '.agent-teams', 'team.json'),
      `{"note":"本机状态","mark":"${EMOJI_MARK}","path":"${FAKE_HOME}"}\n`, 'utf8')
    writeFileSync(join(clone, '.gitignore'),
      `${readFileSync(join(clone, '.gitignore'), 'utf8')}**/.other-tool/\n`, 'utf8')
    mkdirSync(join(clone, '.other-tool'), { recursive: true })
    writeFileSync(join(clone, '.other-tool', 'cache.json'), `{"mark":"${EMOJI_MARK}"}\n`, 'utf8')
    gitIn(clone, 'init')
    gitIn(clone, 'add', '-A')

    const r1 = preflightIn(clone)
    const silent = !/\.agent-teams|\.other-tool/.test(r1.out)
    check(silent, '被忽略的本机状态目录不进检查域、不做顶层告警',
      r1.out.split('\n').filter((l) => /FAIL|WARN/.test(l)).join(' / '))
    report(silent, '本机状态：不进域、不告警')
    const green = r1.status === 0 && /0 项失败/.test(r1.out)
    check(green, '植入本机状态后仍然全绿', `exit=${r1.status}`)
    report(green, '结果：0 项失败')

    // 4) 端到端（反例，证伪用）：同一个仓库里，未忽略的新目录必须照旧被抓——内容与顶层归属都报。
    mkdirSync(join(clone, '.unregistered-tool'), { recursive: true })
    writeFileSync(join(clone, '.unregistered-tool', 'state.json'),
      `{"mark":"${EMOJI_MARK}"}\n`, 'utf8')
    const r2 = preflightIn(clone)
    const caught = r2.status === 1 && /\.unregistered-tool\/state\.json/.test(r2.out)
      && /未登记的条目：\.unregistered-tool/.test(r2.out)
    check(caught, '未忽略的新目录照旧被抓（内容与顶层归属都报）',
      r2.out.split('\n').filter((l) => /FAIL|WARN/.test(l)).join(' / '))
    report(caught, '对照：未忽略的新目录照旧被抓')
  }

  // 5) 端到端（降级）：没有版本控制时，提示必须出现（不许静默假装成功），且正常文件照旧查。
  {
    const plain = join(fixture('domain-nogit', {}), 'project-forge')
    copyTree(SKILL_ROOT, plain, new Set(['.git', '.agent-teams', 'node_modules', 'selftest.mjs']))
    writeFileSync(join(plain, 'scripts', 'selftest.mjs'), SELFTEST_STUB, 'utf8')
    writeFileSync(join(plain, 'notes-with-emoji.md'), `# 正常文件\n\n${EMOJI_MARK}\n`, 'utf8')
    const r = preflightIn(plain)
    const declared = /退回文件系统扫描/.test(r.out)
    check(declared, '无 git 时显式报告降级', r.out.split('\n').filter((l) => /WARN/.test(l)).join(' / '))
    report(declared, '降级：显式报告，不静默')
    const stillScanned = /notes-with-emoji\.md/.test(r.out) && /自检完成/.test(r.out)
    check(stillScanned, '降级时正常文件照旧全查，且不崩')
    report(stillScanned, '降级：正常文件照旧查')
  }
}

group('[39] 缺节判据只对结构由脚本决定的文件成立')
{
  // 这一组守的是「拿骨架的 H2 标题字面差集当缺节判据」这一类错误：**写了但措辞不同**
  // （本 skill 自己的「版本管理流程」对骨架的「版本管理」）会被永远报成没写，而作者
  // 并没有「补」的义务——脚本从来不会替他补这些节。判据必须先问结构是谁定的：
  //   生成 → 缺节是缺陷（防空壳契约过 CI）；升级 → 缺节是待办；作者编排 → 判据不适用。
  const pkg = '{"name":"t","version":"1.0.0","scripts":{"test":"x"}}\n'

  // 1) 生成的文件：掏空一节 → --check 必须失败。
  {
    const dir = fixture('sec-managed', { 'package.json': pkg })
    compose(dir)
    const f = join(dir, 'AGENTS.md')
    const before = readFileSync(f, 'utf8')
    check(before.includes('<!-- project-forge:managed -->'), '前提：生成物带 managed 标记')
    const gutted = before.replace(/^## 版本管理（必守）[\s\S]*?(?=^## |(?![\s\S]))/m, '')
    check(gutted !== before && gutted.length < before.length, '前提：成功删掉一节')
    writeFileSync(f, gutted, 'utf8')
    const r = compose(dir, '--check')
    const ok = r.status === 1 && /缺失/.test(r.stderr ?? '')
    check(ok, '生成的文件缺节 → --check 失败', `exit=${r.status}`)
    report(ok, '生成：缺节是缺陷')
  }

  // 2) 作者编排的文件：抹掉 managed 标记并删掉一整节 → 判据不适用：--check 通过且不报缺节。
  {
    const dir = fixture('sec-authored', { 'package.json': pkg })
    compose(dir)
    const f = join(dir, 'AGENTS.md')
    const text = readFileSync(f, 'utf8')
      .replace('<!-- project-forge:managed -->\n\n', '')
      .replace(/^## 测试（约定）[\s\S]*?(?=^## |(?![\s\S]))/m, '')
      .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写）')
    writeFileSync(f, text, 'utf8')
    const r1 = compose(dir, '--check')
    const ok1 = r1.status === 0 && !/缺失/.test(`${r1.stdout ?? ''}${r1.stderr ?? ''}`)
    check(ok1, '作者编排的文件：不判缺节，--check 通过', `exit=${r1.status} ${(r1.stdout ?? '').trim()}`)
    report(ok1, '作者编排：不判缺节')
    const r2 = compose(dir, '--status')
    const out2 = r2.stdout ?? ''
    const ok2 = /缺失 0 节/.test(out2) && out2.split('\n').some((l) => l.trim().startsWith('内容完整'))
    check(ok2, '作者编排的文件：缺失记 0，且报内容完整', out2.trim().split('\n')[0])
    report(ok2, '作者编排：内容完整')
  }

  // 3) 升级的文件：--upgrade 落一个 upgraded 标记（判据有据可依，不靠猜），缺节仍作待办报出。
  {
    const dir = fixture('sec-upgraded', { 'package.json': pkg })
    writeFileSync(join(dir, 'AGENTS.md'), '# x\n\n说明。\n\n## 怎么跑\n\nnpm test\n', 'utf8')
    compose(dir, '--upgrade')
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const marked = after.includes('<!-- project-forge:upgraded -->')
    check(marked, '--upgrade 留下 upgraded 标记（判据有据可依）', after.slice(0, 80).replace(/\n/g, ' '))
    report(marked, '升级：标记落盘')
    const r = compose(dir, '--check')
    const ok = r.status === 0 && /提示：缺失/.test(r.stdout ?? '')
    check(ok, '升级的文件：缺节是待办（提示），不是缺陷', `exit=${r.status}`)
    report(ok, '升级：缺节只提示')

    // 4) 同一批缺节只打印一次：曾经 reportGaps 说「这些节没写，文档就不算完成」，紧接着
    //    reportRefresh 又说「未自动添加，需要就手动补」——同一事实两个结论。
    const r2 = compose(dir)
    const text = `${r2.stdout ?? ''}${r2.stderr ?? ''}`
    const heads = (text.match(/缺失 \d+ 个节|模板里有、本文件没有的节/g) ?? []).length
    const ok2 = heads <= 1
    check(ok2, '同一批缺节只报一次（两处矛盾的报告已合并）', `出现 ${heads} 次`)
    report(ok2, '缺节报告：只出现一次')
  }
}

group('[40] 保鲜节标题：编号与括注是装饰，不该让专章判成缺节')
{
  // 专章模板的骨架写的是 `## 八、事实来源（必填）`：编号让它在文件里定位得到，括注提醒
  // 写的人这一节必填。判据要抓的是「这一节在不在」，不是标题那一串字——按字面匹配会让
  // 照模板新建的专章被判成没有来源节，模板与检查器互相打架。
  const todayStr = new Date().toISOString().slice(0, 10)
  const tomorrowStr = new Date(Date.parse(`${todayStr}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const withHeading = (h) => `# 测试生态 插件\n\n## 何时读本文件\n\n- 略\n\n${h}\n\n来源略。\n\n`
    + `<!-- foo-verified: date=${todayStr} -->\n`
  const run = (text) => evalFreshnessMarker('references/plugins/foo.md', text, todayStr, tomorrowStr)

  for (const [label, heading] of [
    ['裸标题', '## 事实来源'],
    ['中文编号', '## 八、事实来源'],
    ['尾部括注', '## 事实来源（必填）'],
    ['编号 + 括注（专章模板的写法）', '## 八、事实来源（必填）'],
    ['阿拉伯编号', '## 3. 事实来源'],
  ]) {
    const r = run(withHeading(heading))
    const ok = r.hasSection && r.errors.length === 0
    check(ok, `标题形状放行：${label}`, JSON.stringify(r.errors))
    report(ok, `放行：${label}`)
  }

  // 反例：放宽的是装饰，不是判据本身——真缺节仍然红。
  {
    const r = run(`# x\n\n## 何时读本文件\n\n- 略\n\n来源略。\n\n<!-- foo-verified: date=${todayStr} -->\n`)
    const ok = !r.hasSection && r.errors.some((e) => /没有对应/.test(e))
    check(ok, '真缺节仍然红', JSON.stringify(r.errors))
    report(ok, '反例：真缺节仍然红')
  }
  // 反例：改名不算这一节（判据没有被放宽成「有来源二字就算」）。
  {
    const ok = !run(withHeading('## 事实来源与更新')).hasSection
    check(ok, '改名不算这一节（判据没被放宽成永真）')
    report(ok, '反例：改名不算')
  }
  // 反例：三级标题不算——要求的是二级标题。
  {
    const ok = !run(withHeading('### 事实来源')).hasSection
    check(ok, '三级标题不算（要求二级标题）')
    report(ok, '反例：三级标题不算')
  }
}

// ── 机制类断言：把这次审计发现的一类类错误固定下来 ──────────────────────────

const readSkill = (rel) => readFileSync(join(SKILL_ROOT, rel), 'utf8')

group('[41] 文档与实现的一致性机制：互引、范围、取值、声明口径')
{
  // 这一组不测某个具体案例，测的是**这一类错误的可检性**：指错节、两处范围不一致、
  // 写死的取值、未登记的声明。每条都对应一次真实发现，且都能被单独证伪。

  // 1) 同文件内的「见第 N 节」必须真有那一节。跨文件引用（写「专章」或给出 references/
  //    路径的）不在本组判定范围内——那要靠人读目标文件。
  {
    const dir = join(SKILL_ROOT, 'references')
    const walk = (sub) => {
      const out = []
      for (const e of readdirSync(join(dir, sub), { withFileTypes: true, encoding: 'utf8' })) {
        const rel = sub === '' ? e.name : `${sub}/${e.name}`
        if (e.isDirectory()) { out.push(...walk(rel)); continue }
        if (e.isFile() && e.name.endsWith('.md')) out.push(rel)
      }
      return out
    }
    const bad = []
    for (const rel of walk('')) {
      const text = readSkill(`references/${rel}`)
      const headings = [...text.matchAll(/^##\s+([0-9一二三四五六七八九十百]+)、/gm)].map((m) => m[1])
      for (const m of text.matchAll(/见第([0-9一二三四五六七八九十百]+)节/g)) {
        const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10)
        if (/专章|references\//.test(around)) continue // 跨文件引用，本组不判
        if (!headings.includes(m[1])) bad.push(`references/${rel} 的「${m[0]}」在本文件里没有对应标题`)
      }
    }
    const ok = bad.length === 0
    check(ok, '同文件互引指向真实存在的节', bad.slice(0, 4).join(' / '))
    report(ok, '互引：指到的节真实存在')
  }

  // 2) 宿主升级后要重核的范围，代码提示与专章必须说同一件事。
  {
    const dsh = readSkill('references/plugins/dsh.md')
    const compose = readSkill('scripts/compose-agents.mjs')
    const inDoc = /重核第([一二三四五六七八九十]+)节至第([一二三四五六七八九十]+)节/.exec(dsh)
    const inCode = /重核第([一二三四五六七八九十]+)节至第([一二三四五六七八九十]+)节/.exec(compose)
    const ok = inDoc !== null && inCode !== null
      && inDoc[1] === inCode[1] && inDoc[2] === inCode[2]
    check(ok, 'dsh 重核范围：代码提示与专章一致',
      `专章=${inDoc?.[0] ?? '(未写)'} 代码=${inCode?.[0] ?? '(未写)'}`)
    report(ok, '重核范围：两处一致')
  }

  // 3) 多生态的扁平命令字段是「先到者胜」：行为钉住，文档才不能凭想象改写机制。
  {
    const dir = fixture('flat-order', {
      'package.json': JSON.stringify({
        name: 'm', version: '1.0.0',
        scripts: { build: 'tsc', test: 'vitest run' },
        devDependencies: { typescript: '^5.0.0' },
      }, null, 2),
      'pyproject.toml': '[project]\nname = "m"\nversion = "1.0.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'src/index.ts': 'export const x = 1\n',
      'main.py': 'print(1)\n',
    })
    const s = survey(dir)
    const ok = s.commands?.build === 'npm run build'
      && s.commands?.byEcosystem?.python?.test === 'python -m pytest'
      && s.commands?.test !== 'python -m pytest'
    check(ok, '扁平命令取声明强度最高者、不被后来者覆盖',
      JSON.stringify({ flat: s.commands?.test, py: s.commands?.byEcosystem?.python?.test }))
    report(ok, '扁平字段：先到者胜')
  }

  // 4) 包管理器是「声明 > 锁文件 > 默认」推出来的，不是「项目声明过」的证据。
  {
    const dir = fixture('pm-chain', {
      'package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'x' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'src/a.js': 'export const a = 1\n',
    })
    const s = survey(dir)
    const ok = s.commands?.packageManager === 'pnpm'
      && (s.commands?.install ?? '').startsWith('pnpm ')
    check(ok, '包管理器按锁文件推导', JSON.stringify({ pm: s.commands?.packageManager, install: s.commands?.install }))
    report(ok, '包管理器：按锁文件推导')
  }

  // 5) review 的 flag 全集必须在它自己的用法输出里（用户与 AI 只能从那儿拿到全集）。
  {
    const text = readSkill('scripts/review.mjs')
    const flags = [...text.matchAll(/^\s*'(--[a-z-]+)',/gm)].map((m) => m[1])
    const helpBlock = text.slice(text.indexOf('用法：node scripts/review.mjs'))
    const missing = flags.filter((f) => !helpBlock.includes(f))
    const documented = /review\.mjs --help/.test(readSkill('SKILL.md'))
    const ok = flags.length > 0 && missing.length === 0 && documented
    check(ok, 'review 的 flag 全部写在用法输出里，且文档指向它',
      `缺=${missing.join(',') || '无'} 文档指向=${documented}`)
    report(ok, 'review flag：用法输出即权威')
  }

  // 6) compose 的开关也要有人写下来（--budget 曾经只存在于脚本注释里）。
  {
    const text = readSkill('scripts/compose-agents.mjs')
    const flags = [...new Set([...text.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]))]
      .filter((f) => f !== '--help')
    const docs = `${readSkill('README.md')}\n${readSkill('SKILL.md')}\n${readSkill('references/docs-set.md')}`
    const missing = flags.filter((f) => !docs.includes(f))
    const ok = flags.length > 0 && missing.length === 0
    check(ok, 'compose 的开关都写进了文档', `缺=${missing.join(',') || '无'}`)
    report(ok, 'compose 开关：都有出处')
  }

  // 7) 模板里不钉第三方补丁版本：模板会被照抄，钉死的号几乎必然过时。
  {
    const dir = join(SKILL_ROOT, 'templates')
    const bad = []
    for (const e of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
      if (!e.isFile()) continue
      const hit = /npm@\d+\.\d+\.\d+/.exec(readSkill(`templates/${e.name}`))
      if (hit !== null) bad.push(`${e.name}: ${hit[0]}`)
    }
    const ok = bad.length === 0
    check(ok, '模板里不出现钉死的第三方补丁版本', bad.join(' / '))
    report(ok, '模板：不钉第三方版本号')
  }

  // 8) 通用文档不点名本机某个具体 skill。
  {
    const bad = []
    for (const rel of ['references/docs-set.md', 'references/plugin-project.md', 'templates/agents-project.md']) {
      if (/oil-tone/.test(readSkill(rel))) bad.push(rel)
    }
    const ok = bad.length === 0
    check(ok, '通用文档不点名具体某个 skill', bad.join(' / '))
    report(ok, '通用性：不点名本机 skill')
  }

  // 9) ci-release 的 TODO(1) 必须交代 job 级 if 条件也要改（否则裸版本标签永远进不来）。
  {
    const text = readSkill('templates/ci-release.yml')
    const todo = /# TODO\(1\)[\s\S]{0,500}?TODO\(2\)/.exec(text)?.[0] ?? ''
    const ok = /if:/.test(todo) && /refs\/tags\/v/.test(todo)
    check(ok, 'ci-release TODO(1) 覆盖 job 级 if 条件', todo.slice(0, 60).replace(/\n/g, ' '))
    report(ok, 'ci-release：TODO(1) 含 if 条件')
  }

  // 10) 模板 DSL（pf:if 等）在文档里有指针，改模板的人知道去哪查。
  {
    const ok = /pf:if/.test(readSkill('references/docs-set.md'))
      || /pf:if/.test(readSkill('SKILL.md'))
    check(ok, '模板标记 DSL 在文档里有指针')
    report(ok, 'DSL：文档里有指针')
  }

  // 11) 保鲜范围按「承载易变事实」判：总纲两份也在册，且都写了查法。
  {
    const bad = []
    for (const rel of ['references/publish.md', 'references/remote-github.md']) {
      const text = readSkill(rel)
      const hasSection = /^##\s*(?:[0-9一二三四五六七八九十百]+[、.．)）]\s*)?事实来源/m.test(text)
      const hasMarker = /<!--\s*[A-Za-z0-9-]+-verified:\s*[^>]*date=/.test(text)
      const hasWhere = /官方|文档|https?:\/\//.test(text.slice(text.search(/^##\s*.*事实来源/m)))
      if (!(hasSection && hasMarker && hasWhere)) bad.push(`${rel}(${hasSection}/${hasMarker}/${hasWhere})`)
    }
    const ok = bad.length === 0
    check(ok, '总纲也带事实来源节、标记与查法', bad.join(' / '))
    report(ok, '保鲜：总纲也在册')
  }

  // 12) 专章都要有「何时读本文件」——新增专章漏写时要拦住（此前只查顶层 references/）。
  {
    const dir = join(SKILL_ROOT, 'references', 'plugins')
    const bad = []
    for (const e of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      if (!/^## 何时读本文件[ \t]*$/m.test(readSkill(`references/plugins/${e.name}`))) bad.push(e.name)
    }
    const ok = bad.length === 0
    check(ok, '专章都写了「何时读本文件」', bad.join(' / '))
    report(ok, '专章结构：齐备')
  }

  // 13) Unlicense 是反向断言：没有版权行、没有占位符（好心补一行会让文档变假话）。
  {
    const text = readSkill('templates/license-unlicense.txt')
    const ok = !text.includes('Copyright (c)') && !text.includes('{{')
    check(ok, 'Unlicense 模板无版权行、无占位符')
    report(ok, 'Unlicense：反向断言成立')
  }

  // 14) dsh 专章要写明 host= 只能靠人维护（检查无法跨宿主比对），不让它悄悄过期。
  {
    const text = readSkill('references/plugins/dsh.md')
    const ok = /host=/.test(text) && /本机实际运行的宿主|跨宿主/.test(text)
    check(ok, 'dsh 专章交代了 host= 的维护边界')
    report(ok, 'dsh：host= 维护边界有交代')
  }

  // 15) survey.md 要记载判定结果是个数组、条件字段缺省即空——它们是判定与汇报的入口。
  {
    const text = readSkill('references/survey.md')
    const ok = /`kinds`/.test(text) && /条件字段：缺省即/.test(text)
    check(ok, 'survey.md 记载 kinds 与条件字段语义')
    report(ok, 'survey.md：字段语义完整')
  }

  // 16) kind 清单的对照**不在这里**：它由 [43] 用 `survey.mjs` 导出的 `kindVocabulary()`
  // 与文档做集合相等断言。曾经这里手抄了一份一模一样的清单——那既是第二份真相源
  // （新增生态时两处都要改），又是「拿实现给实现打分」的形状。
}

// ── [42] 本轮修复的回归网：每条断言都要能证伪 ─────────────────────────────────

group('[42] 高危四条：入口判定、徽章三态、围栏感知、锚点权威期望')
{
  // ── P1：入口判定按真实路径（junction / 符号链接下不许静默空跑） ──
  //
  // 旧判据是字面比较 argv[1] 与 import.meta.url：经 junction 调用时永不相等，脚本
  // 什么都不做并返回 0——实测 preflight 走 junction 就是 exit 0、零输出，那是
  // 「自检假绿」：CI 与人都会读成通过。
  {
    // 链接指向**技能根**：要测的是「经链接调用本脚本」，不是链接一个空 fixture。
    const linkDir = join(ROOT, 'mainmod-link')
    try {
      symlinkSync(SKILL_ROOT, linkDir, 'junction')
    } catch { /* 本机不许建链接就跳过下面的链接断言 */ }
    if (existsSync(join(linkDir, 'scripts', 'survey.mjs'))) {
      const realFile = join(SKILL_ROOT, 'scripts', 'survey.mjs')
      const metaUrl = pathToFileURL(realFile).href
      check(isMainModule(metaUrl, realFile) === true, '字面路径：判定为直接执行')
      check(isMainModule(metaUrl, join(linkDir, 'scripts', 'survey.mjs')) === true,
        '经 junction 调用：仍判定为直接执行（真实路径归一）', join(linkDir, 'scripts', 'survey.mjs'))
      check(isMainModule(metaUrl, join(SKILL_ROOT, 'scripts', 'preflight.mjs')) === false, '别的文件：判定为被 import')
      const viaLink = spawnSync(process.execPath, [join(linkDir, 'scripts', 'survey.mjs'), SKILL_ROOT, '--markdown'],
        { encoding: 'utf8' })
      const okLink = (viaLink.stdout ?? '').includes('勘察结果')
      check(okLink, '经 junction 调用 survey：有输出、不静默空跑', JSON.stringify((viaLink.stdout ?? '').slice(0, 40)))
      report(okLink, 'P1 入口判定：链接下不退化成空跑')
    } else {
      skipGroup('[42] 入口判定的链接断言', '本机不支持创建目录链接')
    }
  }

  // ── P2：徽章结论按「结论行 + 退出码」判，崩溃 / 未查完一律不读成通过 ──
  {
    const crash = badgeVerdict('C:\\x\\README.md：找到 1 个徽章\n', 'TypeError: terminated\n', 1)
    check(crash.state === 'unverified', '子进程崩溃（无结论行）→ unverified，不读成 ok', crash.state)
    check(badgeVerdict('check-badges: state=ok checked=1 bad=0 unverified=0\n', '', 0).state === 'ok', '结论行 ok + 退出码 0 → ok')
    check(badgeVerdict('check-badges: state=bad checked=1 bad=1 unverified=0\n', '', 1).state === 'bad', '结论行 bad + 退出码 1 → bad')
    check(badgeVerdict('check-badges: state=nobadge checked=0 bad=0 unverified=0\n', '', 0).state === 'nobadge', '没有徽章 → nobadge')
    const mismatch = badgeVerdict('check-badges: state=ok checked=1 bad=0 unverified=0\n', '', 1)
    check(mismatch.state === 'unverified', '结论行与退出码不一致 → unverified（两处证据必须同向）', mismatch.state)
    report(crash.state === 'unverified', 'P2 徽章裁决：崩溃不再落进「可显示」')

    // 端到端：徽章地址连不上（端口 9 拒绝连接）→ 检查未完成，退出码 3
    const badgeDir = fixture('badge-unreached', {
      'README.md': '# x\n\n![b](http://127.0.0.1:9/img.shields.io/badge.svg)\n',
    })
    const cb = spawnSync(process.execPath, [join(HERE, 'check-badges.mjs'), join(badgeDir, 'README.md')],
      { encoding: 'utf8' })
    check(cb.status === 3 && /state=unverified/.test(cb.stdout ?? ''),
      '连不上时：退出码 3 且结论行写 unverified', 'exit=' + cb.status)
    report(cb.status === 3, 'P2 端到端：没查完 → 退出码 3')
  }

  // ── P3：目录识别感知代码围栏（不再插进代码块、不删闭合行） ──
  {
    const sync = (file, ...extra) => spawnSync(process.execPath,
      [join(HERE, 'sync-toc.mjs'), file, ...extra], { encoding: 'utf8' })
    const fenced = fixture('toc-fenced-takeover', {
      'README.md': '# 项目\n\n用法示例：\n\n```md\n## 目录\n```\n\n## 一\n\n## 二\n\n## 三\n\n## 四\n\n## 五\n',
    })
    const p = join(fenced, 'README.md')
    sync(p)
    const out = readFileSync(p, 'utf8')
    const beforeFence = out.slice(0, out.indexOf('## 一'))
    check(beforeFence.includes('```md') && beforeFence.includes('```\n\n## 目录'),
      '目录插在围栏之外（围栏内那行仍是代码）', JSON.stringify(beforeFence.slice(-40)))
    check((out.match(/```/g) ?? []).length >= 2, '围栏闭合行没被吃掉（成对出现）')
    report(out.includes('## 目录') && beforeFence.indexOf('<!-- toc:start -->') > beforeFence.lastIndexOf('```'),
      'P3 围栏感知：目录在围栏闭合之后')

    // 损坏态（标记落在围栏内）→ 拒绝写入 + --check 必须红
    const damaged = fixture('toc-damaged-markers', {
      'README.md': '# x\n\n```md\n<!-- toc:start -->\n\n- [一](#一)\n\n<!-- toc:end -->\n```\n\n## 一\n\n## 二\n\n## 三\n\n## 四\n\n## 五\n',
    })
    const dp = join(damaged, 'README.md')
    const before = readFileSync(dp, 'utf8')
    const r1 = sync(dp)
    const r2 = sync(dp, '--check')
    check(r1.status === 2 && readFileSync(dp, 'utf8') === before,
      '标记落在围栏内：拒绝写入且文件一个字节没动', 'exit=' + r1.status)
    check(r2.status !== 0, '同一状态 --check 必须红（不能读成「已是当前状态」）', 'exit=' + r2.status)
    report(r1.status === 2 && r2.status !== 0, 'P3 损坏态：拒绝写 + --check 红')
  }

  // ── P4：锚点以**权威实现**的期望值为准 ──
  //
  // 这些期望值是拿真实 github-slugger@2 对同一批标题跑出来的结果抄进来的，
  // 不是「照本实现抄一遍」——那样等于自证式测试。
  {
    const cases = [
      ['A   B', 'a---b'],
      ['A B', 'a-b'],
      ['1. 局域网访问', '1-局域网访问'],
      ['一　二', '一二'],
      ['说明①', '说明'],
      ['第一步⑴', '第一步'],
      ['snake_case 与 README_CN.md', 'snake_case-与-readme_cnmd'],
      ['a__b 词内双下划线', 'a__b-词内双下划线'],
      ['~~删除线~~ 标题', '删除线-标题'],
      ['a_b_c', 'a_b_c'],
      [`${FAKE_EMOJI} 部署`, '-部署'],
      ['中文，标点：测试', '中文标点测试'],
      ['Node.js 20.x 支持', 'nodejs-20x-支持'],
      ['v1.2.3 发布', 'v123-发布'],
      ['ＦＵＬＬ　ＷＩＤＴＨ', 'ｆｕｌｌｗｉｄｔｈ'],
      ['_强调_ 标题', '强调-标题'],
      ['[引用式][ref] 标题', '引用式-标题'],
      ['<https://example.com/x> 链接', 'httpsexamplecomx-链接'],
    ]
    const md = '# 标题\n\n' + cases.map(([t]) => `## ${t}\n`).join('\n')
    const dir = fixture('toc-anchors', { 'README.md': md })
    const p = join(dir, 'README.md')
    spawnSync(process.execPath, [join(HERE, 'sync-toc.mjs'), p], { encoding: 'utf8' })
    const generated = readFileSync(p, 'utf8')
    const ids = []
    for (const line of generated.split('\n')) {
      const m = /^- \[(.*)\]\(#(.*)\)$/.exec(line.trim())
      if (m !== null) ids.push(m[2])
    }
    const diffs = []
    let same = ids.length === cases.length
    for (let i = 0; i < cases.length; i += 1) {
      if (ids[i] !== cases[i][1]) {
        same = false
        diffs.push(`${cases[i][0]} → ${ids[i]}（权威期望 ${cases[i][1]}）`)
      }
    }
    check(same, '锚点逐条与 github-slugger@2 的期望一致', diffs.join('；'))
    report(same, `P4 锚点：${cases.length} 条与权威实现一致`)
  }

  // ── N1：凭据按分案分档（未跟踪且已忽略的正常形态不拦） ──
  {
    const tracked = tierSecrets([{ path: 'a', tracked: true }])
    const safe = tierSecrets([{ path: 'b', tracked: false, ignored: true }])
    const exposed = tierSecrets([{ path: 'c', tracked: false, ignored: false }])
    const unknown = tierSecrets([{ path: 'd' }])
    check(tracked.blocking.length === 1 && safe.blocking.length === 0
      && exposed.blocking.length === 1 && unknown.blocking.length === 1,
      '分档：已跟踪 / 未忽略都拦，未跟踪且已忽略放行',
      JSON.stringify({ tracked: tracked.blocking.length, safe: safe.blocking.length, exposed: exposed.blocking.length }))
    report(safe.blocking.length === 0, 'N1 密钥分档：.gitignore 里的 .env 不再永久报缺')

    if (HAS_GIT) {
      const dir = fixture('secret-ignored', {
        '.gitignore': '.env\n',
        '.env': `K="ghp_${'d'.repeat(36)}"\n`,
        'README.md': '# x\n',
      })
      spawnSync('git', ['init', '-q'], { cwd: dir })
      const r = spawnSync(process.execPath, [join(HERE, 'review.mjs'), dir, '--no-bilingual', '--no-contributing',
        '--private-no-license', '--no-ci'], { encoding: 'utf8' })
      const out = r.stdout ?? ''
      const hits = out.split('\n').filter((l) => /凭据/.test(l)).join(' / ')
      check(!/\[缺\] 凭据形状/.test(out), '未跟踪且已忽略的 .env：不报凭据缺', hits)
      report(!/\[缺\] 凭据形状/.test(out), 'N1 端到端：已忽略的 .env 安静')
    } else {
      skipGroup('[42] 已忽略凭据的端到端断言', '环境里没有 git')
    }
  }

  // ── P5：待填写标记只有一处实现（单行与多行判据必须一致） ──
  {
    const dir = fixture('authors-onepass', {
      'package.json': '{"name":"a","version":"1.0.0","scripts":{"test":"x"}}\n',
    })
    compose(dir)
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, readFileSync(p, 'utf8')
      .replace(/<!--\s*pf:author:\s*([\s\S]*?)-->/g, (m, note) => `<!-- pf:author:\n${note.trim()} -->`), 'utf8')
    const multi = authorMarkers(readFileSync(p, 'utf8')).length
    const st = compose(dir, '--status')
    const composeCount = Number((/待填写 (\d+) 处/.exec(st.stdout ?? '') ?? [])[1] ?? -1)
    const rv = spawnSync(process.execPath, [join(HERE, 'review.mjs'), dir], { encoding: 'utf8' })
    const reviewCount = Number((/AGENTS\.md 待填写 (\d+) 处/.exec(rv.stdout ?? '') ?? [])[1] ?? -1)
    check(multi > 0 && composeCount === multi && reviewCount === multi,
      '多行标记：compose 与 review 数出同一个数（一处实现）',
      JSON.stringify({ multi, composeCount, reviewCount }))
    report(composeCount === multi && reviewCount === multi, 'P5 待填写计数：两处同源')
  }

  // ── P6：CONTRIBUTING 内容判据语言无关（合格英文版不许被判缺） ──
  {
    const dir = fixture('contributing-en', {
      'README.md': '# demo\n',
      'LICENSE': 'MIT\n',
      'package.json': '{"name":"demo","version":"1.0.0","scripts":{"verify":"node --test"}}\n',
      'CONTRIBUTING.md': '# Contributing\n\nThanks for your interest.\n\n'
        + '## Questions and feedback\n\nFor questions, open an issue or start a discussion.\n\n'
        + '## Before you start\n\nFork the repository, then create a branch named `feat/topic` from `main`.\n\n'
        + '## Running the checks\n\nInstall dependencies with `npm ci`, then run:\n\n'
        + '```sh\nnpm run verify\n```\n\nAll checks must be green.\n\n'
        + '## License\n\nBy contributing you agree that your work is released under the license in `LICENSE`.\n',
    })
    const r = spawnSync(process.execPath, [join(HERE, 'review.mjs'), dir, '--no-bilingual', '--no-ci',
      '--secrets-reviewed'], { encoding: 'utf8' })
    const bad = (r.stdout ?? '').split('\n').filter((l) => /\[缺\] CONTRIBUTING/.test(l))
    check(bad.length === 0, '英文 CONTRIBUTING 不再被判缺', bad.join(' / '))
    report(bad.length === 0, 'P6 语言无关：英文版不被误判')
  }

  // ── P7：扫描未覆盖范围必须报出来（超体积文件不再静默） ──
  {
    const bigDir = fixture('scan-oversize', { 'README.md': '# x\n' })
    writeFileSync(join(bigDir, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 64) + `\nK="ghp_${'e'.repeat(36)}"\n`, 'utf8')
    const s = survey(bigDir)
    const scan = s.risks?.contentScan ?? {}
    check((scan.skippedLarge ?? 0) >= 1, '超单文件上限的文件被计数（不再是静默跳过）', JSON.stringify(scan))
    report((scan.skippedLarge ?? 0) >= 1, 'P7 超体积：计数进报告')
  }

  // ── P8：门禁消费全部风险类别（新增类别自动进闸门） ──
  {
    const unhandled = unhandledRiskKeys({ secretFiles: [], contentScan: {}, futureRisk: 1 })
    check(unhandled.length === 1 && unhandled[0] === 'futureRisk',
      '勘察新增的风险类别会被点名为「未处理」，不会沉默', JSON.stringify(unhandled))
    report(unhandled.length === 1, 'P8 风险类别：加了字段就必须落结论')
  }

  // ── P9：嵌套产物目录（monorepo）不被漏掉 ──
  {
    if (HAS_GIT) {
      const dir = fixture('nested-outdir', {
        'packages/a/package.json': '{"name":"a","version":"1.0.0"}\n',
        'packages/a/dist/bundle.js': 'x\n',
        'packages/b/package.json': '{"name":"b","version":"1.0.0"}\n',
        'packages/b/dist/bundle.js': 'x\n',
        'dist/root.js': 'x\n',
        'README.md': '# x\n',
      })
      spawnSync('git', ['init', '-q'], { cwd: dir })
      const notIgnored = survey(dir).ignores?.unignoredOutputDirs ?? []
      const nested = notIgnored.filter((d) => /packages[/\\][ab][/\\]dist/.test(d))
      check(nested.length === 2, '两层的 packages/*/dist 都被报出来（不再只报顶层）', JSON.stringify(notIgnored))
      report(nested.length === 2, 'P9 嵌套产物目录：全深度')

      const single = fixture('single-outdir', { 'dist/a.js': 'x\n', 'README.md': '# x\n' })
      spawnSync('git', ['init', '-q'], { cwd: single })
      const one = survey(single).ignores?.unignoredOutputDirs ?? []
      check(one.includes('dist') && one.length === 1, '单包项目只报一个顶层产物目录', JSON.stringify(one))
      report(one.length === 1, 'P9 反例：单包不误报')
    } else {
      skipGroup('[42] 嵌套产物目录', '环境里没有 git')
    }
  }

  // ── P11 / P12：帮助开关与畸形清单（两条都曾是崩溃或静默错判） ──
  {
    const help = spawnSync(process.execPath, [join(HERE, 'survey.mjs'), '-h'], { encoding: 'utf8' })
    const okHelp = help.status === 0 && /用法：/.test(help.stdout ?? '')
    check(okHelp, '`-h` 给用法（曾被当成目录名，报「目录不存在」）', 'exit=' + help.status)
    report(okHelp, 'P11 -h：给用法而不是报目录不存在')

    const nullPkg = fixture('null-manifest', { 'package.json': 'null\n' })
    const r = spawnSync(process.execPath, [join(HERE, 'survey.mjs'), nullPkg, '--json'], { encoding: 'utf8' })
    const okNull = r.status === 0
    check(okNull, 'package.json 内容为 null 不再让勘察崩掉（清单形状统一归一）',
      (r.stderr ?? '').split('\n')[0])
    report(okNull, 'P12 畸形清单：不崩')
  }

  // ── P10：带点的仓库名不许被截断（仓库边界识别只有一处实现） ──
  {
    const cases = [
      ['https://github.com/acme/my.repo.git', 'acme/my.repo'],
      ['git@github.com:acme/my.repo.git', 'acme/my.repo'],
      ['https://github.com/acme/plain', 'acme/plain'],
      ['https://GitHub.com/acme/Plain.git', 'acme/Plain'],
      ['https://gitlab.com/a/b.git', undefined],
      ['https://github.com/acme', undefined],
    ]
    const diffs = []
    for (const [url, want] of cases) {
      const got = parseGitHubRepo(url)
      if (got !== want) diffs.push(`${url} → ${got}（期望 ${want}）`)
    }
    check(diffs.length === 0, 'owner/name 解析与期望一致（含带点仓库名）', diffs.join('；'))
    report(diffs.length === 0, 'P10 仓库边界：带点名字不截断')
  }
}

group('[43] host= 机制：三态比对、键形状、两键同批、查法判据、kind 清单')
{
  {
    const samePairs = [
      [normVersion('^1.2.3'), normVersion('1.2.3')],
      [normVersion('v0.1.6'), normVersion('0.1.6')],
      [normVersion('0.1.6-RC.1'), normVersion('0.1.6-rc.1')],
      [normVersion(' >= 0.1.6 '), normVersion('0.1.6')],
    ]
    const okSame = samePairs.every(([a, b]) => a === b)
    check(okSame, '归一等价：前缀 / v / 大小写 / 空白都算同一版', JSON.stringify(samePairs))
    check(normVersion('0.1.5-rc.1') !== normVersion('0.1.5'),
      '预发布与正式版**不同**（不折叠：那是两次不同的发布）')
    report(okSame, '归一化：只吃写法差异')
  }

  {
    const match = compareHostMarker('1.2.3', [{ source: 'cli', value: 'v1.2.3' }])
    const mismatch = compareHostMarker('1.2.3', [{ source: 'cli', value: '9.9.9' }])
    const none = compareHostMarker('1.2.3', [{ source: 'cli', value: undefined, reason: '未装' }])
    const conflict = compareHostMarker('1.2.3', [
      { source: 'cli', value: '1.2.3' },
      { source: 'metadata', value: '2.0.0' },
    ])
    check(match.state === 'match', '一致 → match（调用方据此静默）', match.state)
    check(mismatch.state === 'mismatch' && /1\.2\.3/.test(mismatch.reason) && /9\.9\.9/.test(mismatch.reason),
      '不同 → mismatch 且报出两个值', mismatch.reason)
    check(none.state === 'undetermined' && /取不到/.test(none.reason), '取不到 → undetermined（未核对 + 原因）', none.reason)
    check(conflict.state === 'undetermined' && /矛盾/.test(conflict.reason),
      '两条来源矛盾 → undetermined（无法确定，不是「不同」）', conflict.reason)
    const ok = match.state === 'match' && mismatch.state === 'mismatch'
      && none.state === 'undetermined' && conflict.state === 'undetermined'
    report(ok, 'host 机制：四态结论都可证伪')
  }

  {
    const good = parseMarkerKeys('host=9.9.9 date=2026-01-01')
    check(good.errors.length === 0 && good.keys.host === '9.9.9',
      'host=9.9.9 放行（合法形状，落「不同」态而不是形状错误）', JSON.stringify(good.errors))
    const empty = parseMarkerKeys('host=')
    check(empty.errors.length === 1 && /空/.test(empty.errors[0]), '空值 → 形状错误', JSON.stringify(empty.errors))
    const multi = parseMarkerKeys('host=1.2.3,2.0.0 date=2026-01-01')
    check(multi.errors.length === 1 && /单个/.test(multi.errors[0]), '多值 host= → 形状错误并提示改写', JSON.stringify(multi.errors))
    const spaced = parseMarkerKeys('note=two words')
    check(spaced.errors.length >= 1, '值里带空白 → 形状错误（值必须非空且单行）', JSON.stringify(spaced.errors))
    const unknownKey = parseMarkerKeys('hostv=1 date=2026-01-01')
    check(unknownKey.errors.length === 0 && unknownKey.notes.length === 1 && /没有认领/.test(unknownKey.notes[0]),
      '未登记的键：不失败，但提示「未核对」', JSON.stringify(unknownKey.notes))
    report(good.errors.length === 0 && empty.errors.length === 1 && multi.errors.length === 1, '标记键形状：四条判据各自可证伪')
  }

  {
    const mkGit = (logOut, beforeText, afterText) => (args) => {
      if (args.includes('log')) return logOut
      const target = args[1] ?? ''
      if (target.includes('^:')) return beforeText
      return afterText
    }
    const stale = hostDateBatchStatus('/x', 'references/plugins/dsh.md', '1.0.0',
      mkGit('abc1234\n', '<!-- dsh-verified: host=1.0.0 date=2026-01-01 -->\n', '<!-- dsh-verified: host=1.0.0 date=2026-01-01 -->\n'))
    check(stale.state === 'stale', 'host= 变了而 date= 没变 → stale（那条日期不可信）', stale.reason)
    const okBatch = hostDateBatchStatus('/x', 'references/plugins/dsh.md', '1.0.0',
      mkGit('abc1234\n', '<!-- dsh-verified: host=0.9.0 date=2026-01-01 -->\n', '<!-- dsh-verified: host=1.0.0 date=2026-03-01 -->\n'))
    check(okBatch.state === 'ok', '同批改动 → ok（安静）', okBatch.reason)
    const unknown = hostDateBatchStatus('/x', 'references/plugins/dsh.md', '1.0.0', mkGit('', '', ''))
    check(unknown.state === 'unverified' && /未提交|未跟踪|git 历史/.test(unknown.reason),
      '取不到那次提交 → unverified（不静默、不失败）', unknown.reason)
    report(stale.state === 'stale' && okBatch.state === 'ok' && unknown.state === 'unverified',
      '两键同批：stale / ok / unverified 三态都有正反例')
  }

  {
    const minimal = '# x\n\n## 事实来源\n\n<!-- npm-verified: date=2026-01-01 -->\n'
    const withLink = '# x\n\n## 事实来源\n\n字段上限见 https://docs.npmjs.com/cli/v10/commands/npm-publish 一节。\n\n<!-- npm-verified: date=2026-01-01 -->\n'
    const bodyMinimal = freshnessSectionBody(minimal)
    const bodyLink = freshnessSectionBody(withLink)
    check(!hasActionableSources(bodyMinimal), '只有标题 + 标记的「事实来源」节不通过（判据不再永真）', JSON.stringify(bodyMinimal))
    check(hasActionableSources(bodyLink), '写出链接的节通过（别把判据做宽到误报）', JSON.stringify(bodyLink.slice(0, 40)))
    report(!hasActionableSources(bodyMinimal) && hasActionableSources(bodyLink), '查法判据：正反例都能证伪')
  }

  {
    const doc = readFileSync(join(SKILL_ROOT, 'references', 'survey.md'), 'utf8')
    const para = /常见的 `kinds` 取值：([\s\S]*?)。\n/.exec(doc)
    const documented = para === null ? [] : [...para[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
    const code = kindVocabulary()
    const missing = code.filter((k) => !documented.includes(k))
    const extra = documented.filter((k) => !code.includes(k))
    check(missing.length === 0 && extra.length === 0,
      'references/survey.md 的 kind 清单与代码值域集合相等（新增生态必须同步文档）',
      JSON.stringify({ missing, extra }))
    report(missing.length === 0 && extra.length === 0, `kind 清单：${code.length} 个，文档与代码一致`)
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

rmSync(ROOT, { recursive: true, force: true })

const envNote = HAS_GIT ? '' : '（本机没有 git，已跳过依赖它的分组）'
process.stdout.write(`\n行为自检：${passed} 项通过，${failed} 项失败`
  + `${skipped > 0 ? `，${skipped} 组跳过` : ''}${envNote}\n`)
if (skips.length > 0) {
  process.stdout.write('\n跳过（环境不具备，不是缺陷）：\n')
  for (const s of skips) process.stdout.write(`  - ${s}\n`)
}
if (failed > 0) {
  process.stdout.write('\n失败项：\n')
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
}
process.exitCode = failed === 0 ? 0 : 1
