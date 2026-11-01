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
 * 用法：node scripts/dev/selftest.mjs
 * 退出码 0 = 全部通过；1 = 有失败。临时 fixture 用完即删。
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync, symlinkSync, unlinkSync, } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import {
  evalFreshnessMarker, FRESHNESS_STALE_DAYS, listRepoFiles, compareHostMarker, hostDateBatchStatus, freshnessSectionBody, hasActionableSources, referencedPaths, moduleSpecifiers, externalModules, releaseTokenSpellings, hostMismatchMessage, } from './preflight.mjs'
import {
  authorMarkers, parseGitHubRepo, kindVocabulary, needsSummary } from '../survey.mjs'
import { isMainModule } from '../lib/text.mjs'
import { skillVersion, skillSource, parseMarkerKeys, normVersion, repoPath, repoRelation, readFileMap } from '../lib/text.mjs'
import { UPSTREAM, STALE_CHECK_MS, apiEndpoint, routesFor } from '../update.mjs'
import { clearStaleTemps } from '../lib/fs-atomic.mjs'
import { badgeVerdict, tierSecrets, unhandledRiskKeys, outsideKernel } from '../review.mjs'
import { readZip, stripCommonPrefix } from '../zip.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
// 本文件住在 scripts/dev/ 下（自用脚本，不进用户包），所以根目录要退两级。
const SKILL_ROOT = resolve(HERE, '..', '..')
/** 随包分发的脚本在 scripts/ 顶层；本文件与 preflight 住在 scripts/dev/（自用，不进包）。 */
const SCRIPTS_DIR = join(HERE, '..')
const FIXTURE_PREFIX = 'project-forge-selftest-'
// 目录名 = 前缀 + pid + 随机后缀。**随机后缀不是装饰**：进程号会被系统回收，两次运行
// 完全可能拿到同一个号，而那次「同名」的后果是后一次把自己的 fixture 建进前一次正在用的
// 目录里——清理时 rmSync 会把别人正在读的文件一起删掉。实测撞过一次：行为自检跑到一半
// 报 `ENOENT …CONTRIBUTING.md`，被前置检查记成失败，看起来像代码坏了。
const ROOT = join(tmpdir(), `${FIXTURE_PREFIX}${process.pid}-${randomBytes(3).toString('hex')}`)

// 目录名已经带随机后缀，两次运行不可能同名；所有权标记仍然留着——它让**清理流程**能分辨
// 「上次遗留」与「别人正在用」，也顺手把这次用的是哪个目录告诉跑的人。
mkdirSync(ROOT, { recursive: true })
writeFileSync(join(ROOT, 'owner.pid'), `${process.pid}\n`, 'utf8')

/**
 * fixture 的清理。
 *
 * 挂在 `exit` 上而不是只写在末尾一句：这份文件有近三千行顶层的造目录逻辑，任何一处
 * 抛出都会让「末尾那句 rmSync」根本执行不到，于是整棵树（含 5000 多个文件的压力用例）
 * 留在临时目录里。所以末尾显式调一次，`exit` 再兜一次——两次都幂等。
 *
 * `maxRetries` 是给文件系统留的余量：Windows 上刚写完的目录可能被索引器短暂占住，
 * 默认不重试就直接放弃了（`force` 只吞「本来就不存在」，不吞这个）。
 */
function cleanupFixtures() {
  try {
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    process.stderr.write(`提示：临时 fixture 没能清干净（${ROOT}）：${error instanceof Error ? error.message : String(error)}\n`)
  }
}

process.once('exit', cleanupFixtures)

/**
 * 上一次运行留下的 fixture。
 *
 * 报出来而不是默默留着：清理失败过一次就说明这台机器上还会再失败，而「看不见的债」
 * 是最容易被当成没有的那种债。这里只报数，不替别人删——并发的另一次运行可能正用着它。
 *
 * 「正用着」是**判出来的，不是猜的**：每个 fixture 根目录写着它的进程号，那个进程还活着
 * 就不算遗留。少了这一半，另一次并发运行的活目录会被报成「上次没清干净」，
 * 报告里就多出一笔不存在的债。
 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH = 没有这个进程；其余（例如 EPERM）说明进程存在，只是问不动它。
    return error?.code !== 'ESRCH'
  }
}

function staleFixtureDirs() {
  let entries = []
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true, encoding: 'utf8' })
  } catch { return [] }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(FIXTURE_PREFIX) && join(tmpdir(), e.name) !== ROOT)
    .filter((e) => {
      try {
        const pid = Number.parseInt(readFileSync(join(tmpdir(), e.name, 'owner.pid'), 'utf8').trim(), 10)
        return !processAlive(pid)
      } catch {
        // 读不到标记（这个标记之前留下的目录）→ 只能按遗留算，如实报出来。
        return true
      }
    })
    .map((e) => e.name)
}

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
  markTime(title)
  process.stdout.write(`\n${title}\n`)
}

/**
 * 记下「刚才是哪一组、花了多久」。
 *
 * 这一趟要跑几分钟，而慢的地方**不一定是看起来最大的那一组**：实测大头是几处
 * 「拿一整份副本当真跑一遍 preflight」——它们每次都把整套结构检查重跑一遍。
 * 没有这个计时，优化只能靠猜；有了它，末尾那张表直接指出该动哪一处。
 */
let lastGroupTitle = '（开场）'
let lastGroupAt = Date.now()
const groupTimes = []
function markTime(next = '（收尾）') {
  const now = Date.now()
  groupTimes.push({ title: lastGroupTitle, ms: now - lastGroupAt })
  lastGroupTitle = next
  lastGroupAt = now
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

/**
 * 所有 fixture 实际跑出来的 kind（去重）。
 *
 * 记在**唯一的出口**上，而不是逐个用例去登记：那样每加一个 fixture 就要记得补一句，
 * 忘了就等于没断言——而这正是它要防的那类遗漏。`survey()` 是全文件所有勘察调用的收口，
 * 所以在这里记一次就等于记了全部。
 */
const observedKinds = new Set()

function survey(dir, ...extra) {
  const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), dir, '--json', ...extra],
    { encoding: 'utf8' })
  if (r.status !== 0) return { error: (r.stderr ?? '').slice(0, 300) }
  try {
    const data = JSON.parse((r.stdout ?? '').replace(/^\uFEFF/, ''))
    for (const k of data.ecosystem?.kinds ?? []) observedKinds.add(k)
    return data
  } catch (error) {
    return { error: `输出不是合法 JSON：${error.message}` }
  }
}

/**
 * 跑 compose-agents。**失败即抛**，错误里带上子进程自己的 stderr。
 *
 * 不抛的话，调用方下一行去读 AGENTS.md 会拿到一个 ENOENT——「生成失败」被显示成
 * 「文件不存在」，指向错误的现象比没有现象更贵：真因（脚本崩了）在报告里找不到一个字。
 *
 * 需要断言「它本来就该失败」的用例用 composeExpectingFailure。
 */
function compose(dir, ...extra) {
  const r = composeExpectingFailure(dir, ...extra)
  if (r.status !== 0) {
    const why = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n')
      .filter((l) => l.trim() !== '').slice(0, 4).join(' / ')
    throw new Error(`compose-agents.mjs ${extra.join(' ') || '(无参数)'} 以退出码 ${r.status} 结束：${why}`)
  }
  return r
}

/** 断言退出码本身的场景：返回原始结果，退出码由用例自己判。 */
function composeExpectingFailure(dir, ...extra) {
  return spawnSync(process.execPath, [join(SCRIPTS_DIR, 'compose-agents.mjs'), dir, ...extra],
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
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'dev', 'preflight.mjs')],
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

/**
 * 端到端自检用的**哑弹** selftest：什么都不做，退出码 0，连摘要行都不打。
 *
 * 它是「行为自检被换成空壳」那个场景的构造物。长度要够（否则被「内容异常短」那条先拦下，
 * 测不到想测的东西），但必须不输出摘要行——那正是要抓住的形状。
 */
const SELFTEST_MUTE = [
  '#!/usr/bin/env node',
  '// 哑弹替身：刻意什么都不做，退出码 0。',
  '// 它模拟「行为自检被摘掉」：只看出身码的判据会把整套行为断言凭空消失读成全绿。',
  `process.stderr.write('MUTE-STUB-MARKER: 这一行是诊断用的\\n')`,
  'process.exitCode = 0',
  `// 填充到长度阈值以上，避免先被「内容异常短」拦下：` + 'x'.repeat(200),
  '',
].join('\n')

/** 造一棵可独立跑 preflight 的 skill 副本（目录名必须是 project-forge，否则 name 对账必红）。 */
function skillClone(name, { selftest = SELFTEST_STUB } = {}) {
  const clone = join(fixture(name, {}), 'project-forge')
  copyTree(SKILL_ROOT, clone, new Set(['.git', '.agent-teams', 'node_modules', 'selftest.mjs']))
  writeFileSync(join(clone, 'scripts', 'dev', 'selftest.mjs'), selftest, 'utf8')
  if (HAS_GIT) {
    gitIn(clone, 'init')
    gitIn(clone, 'add', '-A')
  }
  return clone
}

// ── 一、未初始化 git 时的密钥扫描（防退化成只扫顶层） ────────────────────────

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

// ── 二、仓库边界（防把外层仓库的远端当成目标目录的） ─────────────────────────

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

// ── 四、生态判定（防把有代码的项目判成纯文档目录） ───────────────────────────

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
      ['建好远端后「角色判定」出现（防条件段落被永久冻结）', /^### 角色判定/m.test(t)],
      ['发版规则出现', /^### 发版规则/m.test(t)],
    )
  }
  for (const [label, ok] of checks) { check(ok, label); report(ok, label) }

  const r = compose(dir)
  const stable = readFileSync(agents, 'utf8') === t
  check(stable, '幂等：再跑一次内容不变')
  report(stable && /无需改动/.test(r.stdout), '幂等：再跑一次报「无需改动」')
}

// 这一组守的是「升级之后再刷新，用户写的东西不能消失」。
//
// 判据曾经是「节标题在不在模板里」——而节标题是人和模板都会用的公共词汇，
// 「构建与验证」「版本管理」几乎人人这么起名。于是撞名时用户的正文被当成生成内容
// 整节替换掉，而那次刷新是流程里标着「强制」的一步，事后没有任何痕迹。
// 现在判据变成「这段字节是谁写的」：--upgrade 给保留下来的每一节打 pf:keep。
group('[7b] 升级后刷新：用户手写的节一个字都不能丢')
{
  const dir = fixture('upgrade-keep', {
    'package.json': '{"name":"keep-demo","version":"1.0.0","scripts":{"test":"echo ok"}}\n',
    'AGENTS.md': [
      '# 项目说明',
      '',
      '## 构建与验证',
      '',
      '我们用 Perforce 镜像，不走 git flow。这一行绝不能丢。',
      '',
      '## 版本管理（必守）',
      '',
      '发版由 release manager 手工执行，任何人不得自行打标签。',
      '',
    ].join('\n'),
  })

  compose(dir, '--upgrade')
  const upgraded = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  check(/<!--\s*pf:keep\s*-->/.test(upgraded),
    '升级时给保留下来的节打上归使用者所有的标记',
    upgraded.split('\n').filter((l) => /^##|pf:keep/.test(l)).join(' | ').slice(0, 200))
  report(/<!--\s*pf:keep\s*-->/.test(upgraded), '升级：打上 pf:keep')

  // 内核区不能被打标记：那段归内核模板独占，刷新时本来就该换。
  const kernelStart = upgraded.indexOf('project-forge:kernel:start')
  const kernelEnd = upgraded.indexOf('project-forge:kernel:end')
  const insideKernel = upgraded.slice(kernelStart, kernelEnd)
  const noKeepInKernel = !insideKernel.includes('pf:keep')
  check(noKeepInKernel, '内核区里不打 pf:keep（那段归内核独占，本就该换）')
  report(noKeepInKernel, '升级：内核区不打标记')

  // 关键断言：强制刷新之后，用户那两句话必须还在。
  compose(dir)
  const refreshed = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  const keepPerforce = refreshed.includes('Perforce')
  const keepReleaseManager = refreshed.includes('release manager')
  check(keepPerforce && keepReleaseManager,
    '刷新后用户写的正文仍然在（这正是原先静默丢失的那两行）',
    `Perforce=${keepPerforce} releaseManager=${keepReleaseManager}`)
  report(keepPerforce && keepReleaseManager, '刷新：用户正文零丢失')

  // 幂等：再刷一次不该继续变动。
  const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  compose(dir)
  const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  check(before === after, '打了标记之后刷新是幂等的')
  report(before === after, '刷新：幂等')
}

group('[8] 手写的 AGENTS.md：默认不动，--upgrade 只做加法')
{
  const dir = fixture('handwritten', {
    'package.json': '{"name":"legacy","version":"1.0.0"}\n',
    'src/index.ts': 'export const x = 1\n',
  })
  const original = `# legacy\n\n一句说明。\n\n## 项目简介\n\n做报表用的。\n\n## 怎么跑\n\nnpm test。\n\n## 注意事项\n\n- 别乱改数据库\n`
  writeFileSync(join(dir, 'AGENTS.md'), original, 'utf8')

  const r1 = composeExpectingFailure(dir)
  const untouched = readFileSync(join(dir, 'AGENTS.md'), 'utf8') === original
  check(r1.status === 0, '默认运行不报错', `退出码 ${r1.status}`)
  check(untouched, '默认运行不动手写文件')
  check(/缺少这些节/.test(r1.stdout), '输出了缺口报告')
  report(r1.status === 0 && untouched, '默认运行：不报错、不动文件、给出体检')

  const r2 = composeExpectingFailure(dir, '--upgrade')
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
  // 前者防「被掏空的契约过 CI」，后者防「逼作者改成模板的样子」——两种错法都要挡住。
  const upCheck = composeExpectingFailure(dir, '--check')
  const okUp = upCheck.status === 0 && /提示：缺失/.test(upCheck.stdout ?? '')
  check(okUp, '作者编排的文件：缺节只提示，--check 仍通过', `exit=${upCheck.status}`)
  report(okUp, '作者编排的文件：缺节只提示')

  // 生成的文件删掉一整节 → 必须失败（否则一份被掏空的契约能过 CI）
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
  const gcheck = composeExpectingFailure(gdir, '--check')
  const okGut = gcheck.status !== 0 && /缺失/.test(gcheck.stderr ?? '')
  check(okGut, '生成的文件被掏空 → --check 失败', `exit=${gcheck.status}`)
  report(okGut, '生成的文件被掏空 → --check 失败')

  // 在正文里合法地加一行注释，不该被指控成「内核不一致」
  const cdir = fixture('comment-added', { 'package.json': '{"name":"c","version":"1.0.0"}\n' })
  compose(cdir)
  const cf = join(cdir, 'AGENTS.md')
  writeFileSync(cf, readFileSync(cf, 'utf8')
    .replace('### 提交纪律', '<!-- 我们自己的补充说明 -->\n### 提交纪律'), 'utf8')
  const ccheck = composeExpectingFailure(cdir, '--check')
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
  // 且必须带说明。按生态惯例给 pytest，会让一个 unittest 项目拿到跑不通的
  // 「硬门禁」命令，还把 P7 的诚实分支遮住。
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

// 这一组守的是「文档勘察按声明判，不按文件名清单判」。
//
// 固定清单一定会漏，而漏的后果不是「少报一个文件」，是**诱导去补一份不该存在的**：
// Rust 的标准双许可布局是两个 LICENSE-* 加清单里的 `license = "MIT OR Apache-2.0"`，
// 根本没有单个 LICENSE；按清单判成「缺」之后补一个，就与清单里的声明打架。
group('[10b] 文档勘察按声明判：许可证文件族与别的宿主约定文件')
{
  // 正例：双许可不该判成「缺」。
  const dual = fixture('docs-dual-license', {
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nlicense = "MIT OR Apache-2.0"\n',
    'LICENSE-MIT': 'MIT text\n',
    'LICENSE-APACHE': 'Apache text\n',
  })
  const sDual = survey(dual)
  check(sDual.docs?.license !== undefined, '双许可：认得出许可证存在（不判「缺」）',
    JSON.stringify(sDual.docs?.license))
  report(sDual.docs?.license !== undefined, '双许可：不判缺')
  check(Array.isArray(sDual.docs?.licenseFamily) && sDual.docs.licenseFamily.length === 2,
    '双许可：把整个文件族都报出来（上层才不会去补单个 LICENSE）',
    JSON.stringify(sDual.docs?.licenseFamily))
  report(sDual.docs?.licenseFamily?.length === 2, '双许可：文件族报全')

  // 反例：没有许可证文件时仍然是「缺」——放宽不能放到丢掉这个事实。
  const nolic = fixture('docs-no-license', {
    'package.json': '{"name":"a","version":"1.0.0"}\n',
  })
  const sNo = survey(nolic)
  check(sNo.docs?.license === undefined, '反例：确实没有许可证时，仍是「缺」')
  report(sNo.docs?.license === undefined, '反例：真缺仍是缺')

  // 正例：多份 AI 宿主约定文件要全部报出来。
  // 只认 AGENTS.md + CLAUDE.md 时，`.cursorrules` / `GEMINI.md` 里的矛盾完全看不见，
  // 而新生成的那份看起来最权威，矛盾就被永久留下了。
  const hosts = fixture('docs-hosts', {
    'AGENTS.md': 'Use pnpm.\n',
    'CLAUDE.md': 'Use yarn.\n',
    '.cursorrules': 'Use npm.\n',
    'GEMINI.md': 'Use bun.\n',
  })
  const sHosts = survey(hosts)
  const found = (sHosts.docs?.aiConventions ?? []).map((c) => c.file)
  check(found.length === 4, '多宿主：四份约定文件全部报出（不只认两个文件名）', found.join('、'))
  report(found.length === 4, '多宿主：全部报出')

  // 反例：只有一份时不该多话。
  const one = fixture('docs-one-host', { 'AGENTS.md': 'Use pnpm.\n' })
  const sOne = survey(one)
  check((sOne.docs?.aiConventions ?? []).length === 1, '反例：只有一份时不虚报')
  report((sOne.docs?.aiConventions ?? []).length === 1, '反例：单份不虚报')
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
  // 把测试数据报成「本机私有路径」并建议改成相对路径，照着做会把测试改坏。
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
  // 判「能不能发布」时只认 package.json，会让所有非 JS 项目都被写成
  // 「本项目不对外发布」，版本号语义、抬版本号判据、发版规则全没了。
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
    const md = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), noIgnore, '--markdown'],
      { encoding: 'utf8' }).stdout ?? ''
    const ok3 = /忽略文件：\*\*缺\*\*/.test(md)
    check(ok3, '缺忽略文件时明确报「缺」')
    report(ok3, '缺忽略文件 → 明确报缺')
  }
}

group('[18] 手工改坏的文件：一律拒绝写坏，并说清怎么修')
{
  const base = { 'package.json': JSON.stringify({ name: 'r', version: '1.0.0', scripts: { test: 'x' } }) }

  // 三态判定：手写 / 受管 / **受损**。受损必须停下——把它压进「手写」，
  // --upgrade 就会把 14KB 内核又插一遍，文件里出现两份内核，而 --check 与 --status
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

    const r1 = composeExpectingFailure(dir)
    const ok1 = r1.status === 2
    check(ok1, `${label} → 普通运行拒绝（exit 2）`, `exit=${r1.status}`)
    const r2 = composeExpectingFailure(dir, '--upgrade')
    const ok2 = r2.status === 2
    check(ok2, `${label} → --upgrade 也拒绝`, `exit=${r2.status}`)
    const r3 = composeExpectingFailure(dir, '--check')
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
  const ok4 = composeExpectingFailure(good, '--check').status === 0
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
  const md = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), bi, '--markdown'],
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
    [join(SCRIPTS_DIR, 'sync-toc.mjs'), join(dir, 'README.md'), ...a], { encoding: 'utf8' })

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
    [join(SCRIPTS_DIR, 'review.mjs'), withRelease], { encoding: 'utf8' })
  const okEn = /英文模板模式/.test(rEn.stdout ?? '')
  check(okEn, '纯英文模板触发待问', (rEn.stdout ?? '').split('\n')[0])
  report(okEn, '英文模板：待问，不默过')
}

group('[25] 交付门禁：缺项拦得住，待问消得掉')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

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

  // 凭据命中拦得住，确认为占位后 flag 消得掉（flag 本身就是用户答复的载体）。
  // 断言认的是 `[缺]` 那行而不是「凭据形状」四个字：被确认之后它会出现在 `[齐]` 里
  // 作为「已确认」的说明，认字面词就分不出「已消掉」与「仍在报缺」。
  const sec = fixture('review-secret', {
    'README.md': '# x\n',
    'src/a.py': `K = "${FAKE_GH_TOKEN}"\n`,
  })
  const r4 = review(sec, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok4 = /\[缺\] 凭据形状/.test(r4.stdout ?? '') && r4.status !== 0
  check(ok4, '凭据命中 → 报缺且非零退出', `exit=${r4.status}`)
  report(ok4, '凭据：拦得住')
  const r5 = review(sec, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--secrets-reviewed')
  const ok5 = !/\[缺\] 凭据形状/.test(r5.stdout ?? '')
  check(ok5, '--secrets-reviewed 消掉未跟踪未忽略的那一档', (r5.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
  report(ok5, '确认后：消得掉')
}

group('[26] 起草发布说明：中文提交即中文说明，无上一版不交白卷')
{
  if (!HAS_GIT) {
    skipGroup('[26] 起草发布说明', '环境里没有 git')
  } else {
    const draft = (dir, ...a) => spawnSync(process.execPath,
      [join(SCRIPTS_DIR, 'draft-release-notes.mjs'), ...a], { encoding: 'utf8', cwd: dir })
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
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

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
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8', env: noGlobalEnv })
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

  // 「已知 `dsh.*` 键」分两类，两类都不该报「不认识」，真不认识的要照报。
  // 正反必须一起写：只测「manifestVersion 不报」的话，一个把 unknownKeys 整个清空的
  // 实现也能过，而那正是下一版宿主加字段时最危险的那种退化。
  const keys = fixture('dsh-keys', {
    'package.json': JSON.stringify({
      name: 'dsh-keys', version: '0.1.0', type: 'module',
      exports: { '.': './lib/index.js' },
      files: ['lib/index.js', 'cordis.patch.yml'],
      icon: './icon.svg',
      engines: { node: '>=24', dsh: '0.2.1-alpha.1' },
      dsh: {
        manifestVersion: 1,
        sessionFormatMigration: { from: 3, to: 4 },
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        mystery: true,
      },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: k\n      name: 'dsh-keys'\n",
    'lib/index.js': 'export const name = "k"\n',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  })
  const sk = survey(keys)
  const knownNoNoise = (sk.dsh?.unknownKeys ?? []).join() === 'mystery'
  check(knownNoNoise, '公开/内部字段不报，真不认识的照报',
    JSON.stringify({ unknown: sk.dsh?.unknownKeys }))
  report(knownNoNoise, '已知键：内部字段与公开字段均不误报，真未知键仍报出')
  const declFacts = sk.dsh?.hasManifestVersion === true && sk.dsh?.enginesDsh === '0.2.1-alpha.1'
    && sk.dsh?.hasIcon === true
  check(declFacts, '声明式元数据逐项读出', JSON.stringify({
    v: sk.dsh?.hasManifestVersion, engines: sk.dsh?.enginesDsh, icon: sk.dsh?.hasIcon,
  }))
  report(declFacts, '声明式元数据：格式版本、宿主范围、图标均读出')
  const noStale = sk.dsh !== undefined && sk.dsh.hasInvariantEntry === undefined
  check(noStale, '事实集里不再有宿主已移除的伴生入口字段', JSON.stringify(Object.keys(sk.dsh ?? {})))
  report(noStale, '陈旧字段：已随宿主移除而清干净')

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

  // 位置表加了新的一处之后，旧的位置**不能因此消失**——只测新位置的话，一个把表整个
  // 换掉的实现照样全绿。所以一处已有的、一处新加的、一个平铺文件，一起断言。
  const bases = fixture('skillbases', {
    'package.json': JSON.stringify({ name: 'b', version: '1.0.0' }),
    '.dsh/skills/proj-one/SKILL.md': '---\nname: proj-one\ndescription: 项目内那份本地 workflow，用来做勘察\n---\n',
    '.agents/skills/proj-two/SKILL.md': '---\nname: proj-two\ndescription: 另一处项目内的本地 workflow\n---\n',
    '.claude/skills/old-three/SKILL.md': '---\nname: old-three\ndescription: 原有位置那份，本轮不该被挤掉\n---\n',
    '.dsh/skills/flat-four.md': '---\nname: flat-four\ndescription: 平铺文件形态的能力目录\n---\n',
  })
  const sb2 = survey(bases)
  const paths = (sb2.localSkills ?? []).map((x) => x.path)
  const okBases = ['.dsh/skills/proj-one', '.agents/skills/proj-two', '.claude/skills/old-three', '.dsh/skills/flat-four.md']
    .every((p) => paths.includes(p))
  check(okBases, '各处位置都收（旧位置不因新增而消失）', JSON.stringify(paths))
  report(okBases, '本地 skills 位置：新旧并存，平铺文件也收')

  // 「装上了却像不存在」是这一类最常见也最难查的故障：宿主不加载，而且**不告诉模型**。
  // 三种成因各要能单独报出来，正向的（正常 skill）也必须干净，否则一个「一律报坏」的
  // 实现也能让上面那条通过。
  const dropped = fixture('skilldropped', {
    'package.json': JSON.stringify({ name: 'd', version: '1.0.0' }),
    '.dsh/skills/fine/SKILL.md': '---\nname: fine\ndescription: 完全正常的一份本地 workflow\n---\n',
    '.dsh/skills/legacy-key/SKILL.md': '---\nname: legacy-key\ndescription: 驼峰调用键\nuserInvocable: true\n---\n',
    '.dsh/skills/bad-value/SKILL.md': '---\nname: bad-value\ndescription: 取值非法\ndisable-model-invocation: maybe\n---\n',
    '.dsh/skills/too-deep/deeper/SKILL.md': '---\nname: too-deep\ndescription: 比发现深度多一层\n---\n',
  })
  const sd = survey(dropped)
  const byPath = Object.fromEntries((sd.localSkills ?? []).map((x) => [x.path, x]))
  const okDropKey = /userInvocable/.test(byPath['.dsh/skills/legacy-key']?.dropped ?? '')
  check(okDropKey, '驼峰调用键 → 报出丢弃成因', JSON.stringify(byPath['.dsh/skills/legacy-key']?.dropped))
  report(okDropKey, '丢弃成因：驼峰调用键')
  const okDropVal = /disable-model-invocation/.test(byPath['.dsh/skills/bad-value']?.dropped ?? '')
  check(okDropVal, '取值非法 → 报出丢弃成因', JSON.stringify(byPath['.dsh/skills/bad-value']?.dropped))
  report(okDropVal, '丢弃成因：调用键取值非法')
  const okDropDeep = /deeper/.test(byPath['.dsh/skills/too-deep']?.dropped ?? '')
  check(okDropDeep, '入口多一层 → 报出宿主走不到那里', JSON.stringify(byPath['.dsh/skills/too-deep']?.dropped))
  report(okDropDeep, '丢弃成因：入口比发现深度多一层')
  const okFine = byPath['.dsh/skills/fine']?.dropped === undefined && byPath['.dsh/skills/fine']?.corrupt !== true
  check(okFine, '正常 skill 不误报坏', JSON.stringify(byPath['.dsh/skills/fine']))
  report(okFine, '反向：正常 skill 不误报')
  compose(dropped)
  const td = readFileSync(join(dropped, 'AGENTS.md'), 'utf8')
  const okDropSec = /宿主不会加载的 skills/.test(td)
  check(okDropSec, '有被丢弃的 → 契约含专门一节')
  report(okDropSec, '被丢弃的 skills：契约渲染')
  compose(wskills)
  const tw2 = readFileSync(join(wskills, 'AGENTS.md'), 'utf8')
  const okNoDropSec = !/宿主不会加载的 skills/.test(tw2)
  check(okNoDropSec, '没有被丢弃的 → 不渲染那一节（不制造噪音）')
  report(okNoDropSec, '反向：无丢弃则不渲染该节')

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
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
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
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

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
    // 判据用**漂移提示独有的那句**，不用「兼容范围」这个通用词：后者在契约正文里
    // 也会出现（讲清声明与闸门的分工就得写它），拿它当判据，改一次文案就假红一次。
    const okQuiet = !/与专章核对时的宿主版本/.test(r.stdout ?? '')
    check(okQuiet, '兼容范围与标记一致时无提示', r.stdout ?? '')
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
    const okWarn = /与专章核对时的宿主版本/.test(r.stdout ?? '') && r.status === 0
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
    const md = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), dir, '--markdown'],
      { encoding: 'utf8' }).stdout ?? ''
    const okMd = /不认识的字段/.test(md) && /frobnicate/.test(md)
    check(okMd, '报告里写明未知字段名', 'markdown 含提示行')
    report(okMd, '未知字段：报告可读')
  }
}

group('[34] Python/Go/Rust 发布事实与门禁：只认本生态清单')
{
  const rv = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
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
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
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
  //    「仓库根无 main.js」不是缺失：官方模板要求它只进发布附件、不进库。
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
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
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

  // 8) 标记落在节之前（结构漂移的形状）→ 错；无节有标记（悬空）→ 错。
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
    writeFileSync(join(clone, 'scripts', 'dev', 'selftest.mjs'), SELFTEST_STUB, 'utf8')
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
    writeFileSync(join(plain, 'scripts', 'dev', 'selftest.mjs'), SELFTEST_STUB, 'utf8')
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
    const r = composeExpectingFailure(dir, '--check')
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
    const r1 = composeExpectingFailure(dir, '--check')
    const ok1 = r1.status === 0 && !/缺失/.test(`${r1.stdout ?? ''}${r1.stderr ?? ''}`)
    check(ok1, '作者编排的文件：不判缺节，--check 通过', `exit=${r1.status} ${(r1.stdout ?? '').trim()}`)
    report(ok1, '作者编排：不判缺节')
    const r2 = compose(dir, '--status')
    const out2 = r2.stdout ?? ''
    // 「没查」与「查过没有」必须可区分：作者编排的文件，脚本不按模板的标题清单判缺节，
    // 所以它既不能报「内容完整」（那是拿没查充数），也不该报缺。
    const ok2 = /缺节判据不适用|判据不适用/.test(out2)
      && !out2.split('\n').some((l) => l.trim().startsWith('内容完整'))
    check(ok2, '作者编排的文件：声明缺节判据不适用，且不拿它充「内容完整」', out2.trim().split('\n')[1] ?? '')
    report(ok2, '作者编排：不判缺节，也不报完整')
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
    const r = composeExpectingFailure(dir, '--check')
    const ok = r.status === 0 && /提示：缺失/.test(r.stdout ?? '')
    check(ok, '升级的文件：缺节是待办（提示），不是缺陷', `exit=${r.status}`)
    report(ok, '升级：缺节只提示')

    // 4) 同一批缺节只打印一次：两处报告说同一件事就会给出两个结论——一处说
    //    「这些节没写，文档就不算完成」，紧接着另一处说「未自动添加，需要就手动补」。
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

// ── 机制类断言：把「文档与实现不一致」这一类错误固定下来 ──────────────────────

const readSkill = (rel) => readFileSync(join(SKILL_ROOT, rel), 'utf8')

group('[41] 文档与实现的一致性机制：互引、范围、取值、声明口径')
{
  // 这一组不测某个具体案例，测的是**这一类错误的可检性**：指错节、两处范围不一致、
  // 写死的取值、未登记的声明。每条都要能被单独证伪。

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

  // 6) compose 的开关也要有人写下来（只存在于脚本注释里的开关等于没有）。
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
  // 与文档做集合相等断言。在这里手抄一份一模一样的清单，既是第二份真相源
  // （新增生态时两处都要改），又是「拿实现给实现打分」的形状。
}

// ── [42] 高危四条：入口判定、徽章三态、围栏感知、锚点权威期望 ─────────────────
// 这一组是回归网：每条断言都要能被单独证伪。

group('[42] 高危四条：入口判定、徽章三态、围栏感知、锚点权威期望')
{
  // ── P1：入口判定按真实路径（junction / 符号链接下不许静默空跑） ──
  //
  // 判据必须按**真实路径**比：字面比较 argv[1] 与 import.meta.url 时，经 junction 或
  // 符号链接调用永不相等，脚本什么都不做并返回 0——那是「自检假绿」，CI 与人都会读成通过。
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
      check(isMainModule(metaUrl, join(SKILL_ROOT, 'scripts', 'dev', 'preflight.mjs')) === false, '别的文件：判定为被 import')
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
    const cb = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'check-badges.mjs'), join(badgeDir, 'README.md')],
      { encoding: 'utf8' })
    check(cb.status === 3 && /state=unverified/.test(cb.stdout ?? ''),
      '连不上时：退出码 3 且结论行写 unverified', 'exit=' + cb.status)
    report(cb.status === 3, 'P2 端到端：没查完 → 退出码 3')
  }

  // ── P3：目录识别感知代码围栏（不再插进代码块、不删闭合行） ──
  {
    const sync = (file, ...extra) => spawnSync(process.execPath,
      [join(SCRIPTS_DIR, 'sync-toc.mjs'), file, ...extra], { encoding: 'utf8' })
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
    spawnSync(process.execPath, [join(SCRIPTS_DIR, 'sync-toc.mjs'), p], { encoding: 'utf8' })
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
      const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir, '--no-bilingual', '--no-contributing',
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
    const rv = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir], { encoding: 'utf8' })
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
    const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir, '--no-bilingual', '--no-ci',
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

  // ── P11 / P12：帮助开关与畸形清单（两条都防崩溃或静默错判） ──
  {
    const help = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), '-h'], { encoding: 'utf8' })
    const okHelp = help.status === 0 && /用法：/.test(help.stdout ?? '')
    check(okHelp, '`-h` 给用法（防被当成目录名而报「目录不存在」）', 'exit=' + help.status)
    report(okHelp, 'P11 -h：给用法而不是报目录不存在')

    const nullPkg = fixture('null-manifest', { 'package.json': 'null\n' })
    const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), nullPkg, '--json'], { encoding: 'utf8' })
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

// ── 机制自身的假绿回归网 ────────────────────────────────────────────────────
//
// 这一组守的是「自检自己会不会被架空」这一类错误：判据写成永真、把硬证据当软证据、
// 检查的开关是一个可以随手改掉的字符串。每一段都用「放宽了会过、收紧了不过」构造，
// 所以判据被改松时这一组会立刻红。

group('[44] 自检机制自身的假绿回归：硬证据优先、判据可证伪')
{
  // 1) 行为自检被换成哑弹（什么都不做、退出码 0）→ 必须报缺，且必须带出它的 stderr。
  //
  //    只看出身码的判据会放它过去，整套行为断言凭空消失而门禁全绿；把「有没有输出摘要
  //    行」与退出码并列才拦得住——「跑没跑到」是硬证据，「跑出来说什么」是佐证。
  if (!HAS_GIT) {
    skipGroup('[44.1-2] 哑弹自检与空转脚本的端到端判定', '本机没有 git')
  } else {
    const clone = skillClone('mech-mute', { selftest: SELFTEST_MUTE })
    const r = preflightIn(clone)
    const caught = r.status === 1 && /没有输出摘要行/.test(r.out)
    check(caught, '哑弹自检（无摘要、退出码 0）→ preflight 失败',
      `exit=${r.status} ${r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' / ')}`.slice(0, 220))
    report(caught, '空壳自检：被判缺')
    // 崩在中途要说得清：诊断片段必须带得出来，否则现场只能靠翻 stderr 猜。
    check(/MUTE-STUB-MARKER/.test(r.out), '摘要缺失的报错里带出了子进程 stderr（能一眼定位）',
      r.out.split('\n').filter((l) => /摘要/.test(l)).join(' / ').slice(0, 200))
    report(/MUTE-STUB-MARKER/.test(r.out), '诊断：带出 stderr')
  }

  // 2) 被实跑的脚本「先打印完报告、再以非零退出」→ 必须报缺。
  //
  //    失败判据必须是「非零退出 **且** 期望词缺席」同时成立：只看非零退出时，stdout 里
  //    已经出现「勘察结果」就足以把它豁免——P1 勘察在 markdown 模式下崩掉也会读成通过。
  //    这里把失败限定在 --markdown 路径，selftest 用的 --json 路径不受影响，所以这一段
  //    是唯一能抓住它的网。
  if (!HAS_GIT) {
    skipGroup('[44.2] 空转脚本的端到端判定', '本机没有 git')
  } else {
    // `skillClone` 给的副本里，行为自检是那个**只打印摘要行的替身**。这是刻意的：
    // 不做替身的话，副本里的 preflight 会去跑一整套真实自检，而那一套又会拉起副本的
    // preflight —— `preflight → selftest → preflight` 套娃，实测把副本的每一趟
    // preflight 从十几秒推到几十秒。判定逻辑由主检出那一趟覆盖，副本只需要一个
    // 「跑得起来、说得出一句话」的自检。
    const clone = skillClone('mech-survey')
    const p = join(clone, 'scripts', 'survey.mjs')
    const src = readFileSync(p, 'utf8')
    const anchor = 'process.exitCode = main(process.argv)'
    check(src.includes(anchor), '前提：找到了 survey 的主流程锚点')
    writeFileSync(p, `${src}\nif (isMainModule(import.meta.url, process.argv[1])\n  && process.argv.includes('--markdown')) {\n  process.stderr.write('LATE-STAGE-FAILURE-MARKER')\n  process.exitCode = 7\n}\n`, 'utf8')
    const r = preflightIn(clone)
    const caught = r.status === 1 && /survey\.mjs 以退出码 7 结束/.test(r.out)
    check(caught, '打印完报告再非零退出 → preflight 失败（退出码不被 stdout 豁免）',
      `exit=${r.status} ${r.out.split('\n').filter((l) => /survey/.test(l)).join(' / ')}`.slice(0, 220))
    report(caught, '非零退出：一律算失败')
  }

  // 3) 门禁命令表的一致性：改个标题就关掉的那块检查，必须自己喊。
  if (!HAS_GIT) {
    skipGroup('[44.3] 门禁命令表的端到端判定', '本机没有 git')
  } else {
    const clone = skillClone('mech-gate')
    const p = join(clone, 'CONTRIBUTING.md')
    const text = readFileSync(p, 'utf8')
    const renamed = text.replace(/^## 提交前门禁/m, '## 提交前的检查')
    check(renamed !== text, '前提：CONTRIBUTING 的门禁小节标题改掉了')
    writeFileSync(p, renamed, 'utf8')
    const r = preflightIn(clone)
    const caught = r.status === 1 && /没有「## 提交前门禁」这一节/.test(r.out)
    check(caught, '门禁小节改名 → 两处命令表无从比对 → preflight 失败（不再静默跳过）',
      `exit=${r.status}`)
    report(caught, '命令表：标题缺失即失败')
  }

  // 4) 凭据分档：--secrets-reviewed 只覆盖「未跟踪未忽略」那一档。
  //    已入库那一档的处置是「从索引移除并轮换」，没有「确认一下就算了」这个选项，
  //    所以任何 flag 都不该消它——flag 的语义是「这处是占位或测试数据」，而它不在其中。
  if (!HAS_GIT) {
    skipGroup('[44.4] 凭据分档与 flag 效力', '本机没有 git')
  } else {
    const exposed = fixture('mech-secret-exposed', {
      'README.md': '# x\n', 'LICENSE': 'MIT\n',
      'free.env': `${FAKE_NPM_TOKEN}\n`,
    })
    gitIn(exposed, 'init')
    const rv = (dir, ...a) => spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
    const base = ['--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci']
    const before = rv(exposed, ...base)
    const after = rv(exposed, ...base, '--secrets-reviewed')
    check(/\[缺\] 凭据形状/.test(before.stdout ?? ''), '未跟踪未忽略的凭据 → 报缺',
      (before.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
    check(!/\[缺\] 凭据形状/.test(after.stdout ?? ''), '这一档可被 --secrets-reviewed 消掉（语义对得上）',
      (after.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
    report(!/\[缺\] 凭据形状/.test(after.stdout ?? ''), '未跟踪档：flag 有效')

    const tracked = fixture('mech-secret-tracked', {
      'README.md': '# x\n', 'LICENSE': 'MIT\n',
      'src/a.py': `K = "${FAKE_GH_TOKEN}"\n`,
    })
    gitIn(tracked, 'init')
    gitIn(tracked, 'config', 'user.name', 'T')
    gitIn(tracked, 'config', 'user.email', 't@e.com')
    gitIn(tracked, 'add', '-A')
    gitIn(tracked, 'commit', '-q', '-m', 'i')
    const tFlag = rv(tracked, ...base, '--secrets-reviewed')
    const stillMissing = /已在版本库里/.test(tFlag.stdout ?? '')
    check(stillMissing, '已入库的凭据 + --secrets-reviewed → 仍然报缺（flag 消不掉它）',
      (tFlag.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
    report(stillMissing, '已入库档：flag 无效')
    check(tFlag.status !== 0, '已入库的凭据使门禁非零退出', `exit=${tFlag.status}`)
    report(tFlag.status !== 0, '已入库档：拦住')
  }

  // 5) 「有远端就得写清远端与发版」：判据必须落在内核之外。
  {
    const kernel = readFileSync(join(SKILL_ROOT, 'templates', 'agents-kernel.md'), 'utf8')
    const inKernel = outsideKernel(`<!-- project-forge:kernel:start -->\n${kernel}\n<!-- project-forge:kernel:end -->\n\n## 怎么跑\n\nnode .\n`)
    const okOut = !/远端|推送|发布|标签/i.test(inKernel)
    check(okOut, '内核区之外不残留远端/发布字样（否则这条判据拿内核给自己作证）',
      JSON.stringify(inKernel.slice(0, 80)))
    report(okOut, '判据范围：内核之外')
    const withBody = `${inKernel}\n## 版本节点\n\n打标签前先抬版本号，远端推上去。\n`
    check(/远端/.test(outsideKernel(withBody)) && /发布|标签/.test(outsideKernel(withBody)),
      '作者写了那两段 → 判据通过（不是恒假）')
    report(/远端/.test(outsideKernel(withBody)), '反侧：写了就通过')
    check(outsideKernel('没有标记的手写文件全文都算作者的部分') === '没有标记的手写文件全文都算作者的部分',
      '没有内核标记时返回全文（手写文件没有内核可依赖）')
  }

  // 6) 来源节判据的第三档：像人话但没有可定位物的套话，必须失败。
  //    只测空正文与带链接两极会漏掉中间那一档，而「不可证伪」恰恰藏在中间。
  {
    const vacuous = '本节的内容以前是核过的，读者可以自行查阅相关文档的对应章节确认；'
      + '若有疑问请按常规流程重核一次即可，不必另行处理。'
    const okVacuous = !hasActionableSources(vacuous)
    check(okVacuous, '纯套话（无链接、无对象、无查法句式）→ 不通过', vacuous.slice(0, 40))
    report(okVacuous, '套话：被拦')
    const byPath = hasActionableSources('字段语义见 `dsh-app-boot` 包里 bundlePatchFiles 的校验，以及 README.zh.md 的 Profile 一节。')
    check(byPath, '写出了具体对象（行内代码里的文件/文档）→ 通过')
    report(byPath, '有对象：放行')
    const byStep = hasActionableSources('去宿主文档的第 7 节核对字段名，再按本节列表逐条对一遍。')
    check(byStep, '查法句式（去 X 的第 N 节）→ 通过')
    report(byStep, '查法句式：放行')
  }

  // 7) 零依赖：四种说明符形状都收，内置与相对路径放行，注释里的举例不算数。
  //
  //    包名一律**运行时拼出**：本文件也在零依赖检查的射程内，字面量写在这里，
  //    那条检查就会把这份测试当成真导入——于是测试自己被自己的被测对象判红。
  {
    const Q = String.fromCharCode(39)
    const DQ = '"'
    const pkg = (...half) => half.join('')
    const probe = [
      `import a from ${Q}node:fs${Q}`,
      `import b from ${Q}./local.mjs${Q}`,
      `import c from ${DQ}${pkg('cha', 'lk')}${DQ}`,
      `const d = require(${Q}${pkg('k', 'leur')}${Q})`,
      `const e = await import(${DQ}${pkg('pico', 'colors')}${DQ})`,
      `import ${Q}side-effect-only${Q}`,
    ].join('\n')
    const specs = moduleSpecifiers(probe)
    const bad = specs.filter((s) => !['node:fs', './local.mjs'].includes(s))
    check(specs.includes('node:fs') && specs.includes('./local.mjs'), '内置模块与相对路径照常识别',
      JSON.stringify(specs))
    check(bad.length === 4 && bad.includes(pkg('cha', 'lk')) && bad.includes(pkg('k', 'leur'))
      && bad.includes(pkg('pico', 'colors')) && bad.includes('side-effect-only'),
      '双引号 / require / 动态导入 / 裸导入四种形状都被收（只认单引号 from 的写法会漏掉其余三种）', JSON.stringify(bad))
    report(bad.length === 4, '零依赖：四种形状都收')
    const prose = [
      `// 举例：动态导入写成 import(${Q}x${Q}) 就完事了`,
      `/* require(${DQ}y${DQ}) 也不许 */`,
      'const z = 1',
    ].join('\n')
    const fromProse = externalModules(prose)
    check(fromProse.length === 0, '整行注释里的举例不算数（否则文档注释会变成地雷）',
      JSON.stringify(fromProse))
    report(fromProse.length === 0, '注释：不算')

    // 反例：「变量名里含 from」不能被当成导入。
    //
    // 判据曾经是 `(?:\bfrom|\bimport)\s*\(?\s*(['"])(...)\1`，中间的 `\s*\(?\s*` 跨行时
    // 会一路吃掉换行，于是 `leaks` 里的 `from` 匹配到**下一行**开头的引号，被报成
    // 「引入了外部模块」。而它报的是「你必须先装东西才能用这个 skill」——一条会让人
    // 真的去装东西的假警报。
    const trap = [
      'const leaks = []',
      `  check(ok, ${DQ}这是断言消息${DQ})`,
      'const from = 1',
      'foo("another string")',
    ].join('\n')
    const fromTrap = externalModules(trap)
    check(fromTrap.length === 0, '变量名里含 from 不算导入（跨行不该被吃掉）', JSON.stringify(fromTrap))
    report(fromTrap.length === 0, '零依赖：含 from 的变量名不误报')
  }

  // 8) 引用完整性：行内代码与 Markdown 链接两种写法必须一起查。
  {
    const text = [
      '见 `references/survey.md`。',
      '另见 [勘察协议](references/docs-set.md) 与 [带锚点的](scripts/survey.mjs#L1) 与 [带标题](references/publish.md "标题")。',
      '占位示例：`references/<文件名>.md`。',
      '非资源目录：docs/architecture.md。',
    ].join('\n')
    const got = referencedPaths(text)
    check(got.includes('references/survey.md') && got.includes('references/docs-set.md'),
      '两种写法都被认出', JSON.stringify(got))
    report(got.includes('references/docs-set.md'), '链接写法：被认出')
    check(got.includes('scripts/survey.mjs') && got.includes('references/publish.md'),
      '链接带锚点与标题时仍取到路径（别把尾巴当成路径的一部分）', JSON.stringify(got))
    check(!got.some((p) => p.includes('<')), '尖括号占位示例不当成真实引用（否则误报）', JSON.stringify(got))
    report(!got.some((p) => p.includes('<')), '占位符：不报')
  }

  // 9) 约定名拼写：判据是「全仓只有一种拼写」，大小写敏感，注释里别照抄错拼法。
  {
    const good = 'a RELEASE_TOKEN b\nc RELEASE_TOKEN d\n'
    check(releaseTokenSpellings([good]).size === 1, '全仓统一 → 只有一种拼写')
    const sep = 'RELEASE' + '-' + 'TOKEN'
    const joined = 'RELEASE' + 'TOKEN'
    const bad = releaseTokenSpellings([good, `x ${sep} y`, `z ${joined} w`])
    check(bad.size === 3, '分隔符写错或连写 → 判为不一致（大小写敏感的扫描）', JSON.stringify([...bad]))
    report(bad.size === 3, '错拼法：被认出')
    const camel = 'usesReleaseToken / releaseToken / ReleaseToken'
    check(releaseTokenSpellings([good, camel]).size === 1,
      'camelCase 标识符不算约定名拼写（不敏感地扫会自造假阳性）', JSON.stringify([...releaseTokenSpellings([good, camel])]))
    report(releaseTokenSpellings([good, camel]).size === 1, 'camelCase：不算')
  }

  // 10) host= 不一致的提示必须渲染成提示本身。
  //     拼接写坏时，冒号后面接的会是源码片段，而那段源码里恰好又写着正确做法——
  //     看的人分不清哪句是给他的，整条提示作废。
  {
    const msg = hostMismatchMessage('references/plugins/dsh.md', '1.2.3', '本机实际是 1.2.4')
    check(!/\+\s*'/.test(msg), '提示正文里不出现源码拼接痕迹', JSON.stringify(msg.slice(0, 90)))
    check(/两种解释都成立/.test(msg) && /专章滞后/.test(msg) && /一起/.test(msg),
      '两种解释与处置指引都在', JSON.stringify(msg.slice(-40)))
    report(!/\+\s*'/.test(msg), '提示：渲染正常')
  }

  // 11) fixture 清理：清理由 exit 钩子兜底，抛异常也会执行；且残留必须报出来。
  {
    check(process.listeners('exit').includes(cleanupFixtures),
      '清理挂在 exit 上（抛异常也会执行；只写在末尾一句就等于没有兜底）')
    report(process.listeners('exit').includes(cleanupFixtures), '清理：exit 钩子已挂')
    check(existsSync(join(ROOT, 'owner.pid')),
      'fixture 根目录写着所有权标记（「别人正在用」与「上次遗留」才分得开）')
    const leftover = staleFixtureDirs()
    check(!leftover.includes(basename(ROOT)), '残留清单不含本次自己的目录（报数才有意义）',
      JSON.stringify(leftover.slice(0, 3)))
    report(!leftover.includes(basename(ROOT)), '残留清单：不含自己')
  }
}


group('[45] 勘察吐出的 kind 必须落在值域内：词表外当场红，不等真实项目踩到')
{
  const vocab = kindVocabulary()
  const outsideOf = (kinds) => [...kinds].filter((k) => !vocab.includes(k)).sort()

  // 非空前提：filter 在空集合上恒真，缺了它「一个都没观测到」也会显示通过。
  const observedEnough = observedKinds.size >= 5
  check(observedEnough, '前提：确实观测到了多个 fixture 跑出的 kind',
    `${observedKinds.size} 个：${[...observedKinds].sort().join('、')}`)
  report(observedEnough, `观测到 ${observedKinds.size} 个 kind`)

  // 判据可证伪：塞一个词表外的 kind，必须被点出来。少了这一步，上面那条有可能恒真。
  const canDetect = outsideOf([...observedKinds, 'a-kind-that-does-not-exist']).length === 1
  check(canDetect, '前提：判据分得清词表内外（否则上面那条是恒真的）')
  report(canDetect, '判据：分得清内外')

  const outside = outsideOf(observedKinds)
  check(outside.length === 0,
    '任何 fixture 实际跑出的 kind 都在 kindVocabulary() 里（文档声称值域以它为准）',
    `词表外：${outside.join('、')}`)
  report(outside.length === 0, `值域：${observedKinds.size} 个 kind 全部在册`)

  // 反向：值域里的 kind 若没有 fixture 覆盖到，说明有生态只存在于清单里、从没被验过
  // 跑得出来。报出来让人决定要不要补 fixture——只提示，不拦（补 fixture 是加覆盖，
  // 不是修缺陷）。
  const neverSeen = vocab.filter((k) => !observedKinds.has(k))
  if (neverSeen.length > 0) {
    process.stdout.write(`         （值域里有 ${neverSeen.length} 个 kind 还没有 fixture 覆盖：${neverSeen.join('、')}）\n`)
  }
}

// ── [46] 自动更新：源码副本只读，包副本比版本、整份覆盖 ────────────────────────

group('[46] 自动更新：比版本、整份覆盖、24 小时窗口')
{
  // 每个副本一份自己的状态目录：状态按副本路径分开记，测试之间不能互相串。
  const stateTmp = join(ROOT, 'update-state')
  mkdirSync(stateTmp, { recursive: true })
  const runUpdate = (skillDir, ...extra) => new Promise((resolvePromise) => {
    const opts = typeof extra[extra.length - 1] === 'object' && extra[extra.length - 1] !== null
      ? extra.pop() : {}
    const child = spawn(process.execPath, [join(skillDir, 'scripts', 'update.mjs'), ...extra],
      { windowsHide: true,
        env: { ...process.env, TEMP: stateTmp, TMPDIR: stateTmp, ...(opts.env ?? {}) } })
    let text = ''
    child.stdout.on('data', (d) => { text += d })
    child.stderr.on('data', (d) => { text += d })
    child.on('close', (code) => resolvePromise({ status: code, out: text.trim() }))
  })

  /**
   * 造一份副本：只放跑得起来的那几个文件，不复制整棵树——这一组验的是判定，不是包边界。
   *
   * 关键是**副本自己也是一个 git 仓库**：下面要发的「新版压缩包」由它导出，这样
   * 包里的文件与副本里的文件天然逐字节一致（行尾也一致），测的才是判定本身。
   */
  const makeCopy = (name, { withGit = false, source, version = '0.14.0' } = {}) => {
    const dir = join(fixture(name, {}), 'project-forge')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    // 副本要跟**用户包**一样能用：包里任何一个脚本被 import 的模块都得在。
    // 判据取自磁盘结构而不是一份手写清单——清单会在新增模块那天悄悄失准，
    // 而失准的表现是「跑副本时 ERR_MODULE_NOT_FOUND」，离原因很远。
    for (const f of ['SKILL.md', 'scripts/update.mjs', 'scripts/survey.mjs', 'scripts/sync-toc.mjs', 'scripts/zip.mjs']) {
      writeFileSync(join(dir, f), readFileSync(join(SKILL_ROOT, f)))
    }
    const libDir = join(SKILL_ROOT, 'scripts', 'lib')
    if (existsSync(libDir)) {
      mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
      for (const e of readdirSync(libDir, { withFileTypes: true, encoding: 'utf8' })) {
        if (!e.isFile() || !e.name.endsWith('.mjs')) continue
        writeFileSync(join(dir, 'scripts', 'lib', e.name), readFileSync(join(libDir, e.name)))
      }
    }
    const skillPath = join(dir, 'SKILL.md')
    let text = readFileSync(skillPath, 'utf8')
      .replace(/^[ \t]+version:[ \t]*"[^"]*"[ \t]*$/m, `  version: "${version}"`)
    text = source === undefined
      ? text.replace(/^[ \t]+source:[ \t]*"[^"]*"[ \t]*$\n/m, '')
      : text.replace(/^[ \t]+source:[ \t]*"[^"]*"[ \t]*$/m, `  source: "${source}"`)
    writeFileSync(skillPath, text, 'utf8')
    if (withGit) {
      gitIn(dir, 'init')
      gitIn(dir, 'add', '-A')
      gitIn(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'fixture')
    }
    return dir
  }

  /**
   * 从一份副本导出一个「新版压缩包」，并验它自带完整元数据。
   *
   * 这条前提断言不是形式主义：下面几个用例全靠包里那份 `SKILL.md` 把来源一路带下去，
   * 包里少了来源，副本更新完就不知道自己该问谁了——而现象会表现成「更新莫名其妙停了」。
   *
   * `declareVersion` 让「包里声明的版本」与「标签说的版本」分开：两者不一致是真实存在的
   * 情形（附件被换过、缓存顶着旧包），而它对使用者的后果很重（静默降级、或白写一遍文件），
   * 所以要有办法造出这种包来验「它会被拦下」。
   */
  const buildPackage = (name, { version, source, declareVersion }) => {
    const src = makeCopy(name, { withGit: true, version, source })
    if (declareVersion !== undefined) {
      const p = join(src, 'SKILL.md')
      writeFileSync(p, readFileSync(p, 'utf8')
        .replace(/^([ \t]+version:[ \t]*)"[^"]*"/m, `$1"${declareVersion}"`), 'utf8')
      gitIn(src, 'add', '-A')
      gitIn(src, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'declare')
    }
    const zipPath = join(ROOT, `${name}.zip`)
    const archived = spawnSync('git',
      ['-C', src, 'archive', '--format=zip', '--prefix=project-forge-/', '-o', zipPath, 'HEAD'],
      { encoding: 'utf8', windowsHide: true })
    if (archived.status !== 0) {
      check(false, '前提：git archive 产得出新版压缩包', (archived.stderr ?? '').slice(0, 160))
      return { body: Buffer.alloc(0), version }
    }
    const body = readFileSync(zipPath)
    rmSync(zipPath, { force: true })
    const entries = stripCommonPrefix(readZip(body))
    const packed = entries.find((e) => e.name === 'SKILL.md')?.data.toString('utf8') ?? ''
    const meta = /metadata:[\s\S]*/.exec(/---\r?\n([\s\S]*?)\r?\n---/.exec(packed)?.[1] ?? '')?.[0] ?? '（无）'
    check(skillVersion(packed) === (declareVersion ?? version) && skillSource(packed) !== undefined,
      '前提：造出来的新版包自带版本与来源（用例才有对象）',
      `包里 metadata 段是 ${JSON.stringify(meta)}；磁盘上是 `
      + `${JSON.stringify(/^[ \t]+source:.*$/m.exec(readFileSync(join(src, 'SKILL.md'), 'utf8'))?.[0])}`)
    return { body, version: skillVersion(packed), dir: src }
  }

  const makePackage = (name, opts) => buildPackage(name, opts)

  /**
   * 本机服务端扮演发布方：一个地址回「最新版是哪个标签」，一个地址回压缩包。
   *
   * 用真服务端而不是打桩，是因为要验的东西里有一半是**协议**：问哪个地址、问几次、
   * 有没有在「只比版本」的时候把整包也拉下来。这些只有真的发过请求才数得清。
   * 监听随机端口，不依赖外网，也不会撞端口。
   */
  const stats = { api: 0, zip: 0, apiBytes: 0, zipBytes: 0 }
  const serve = (handler) => new Promise((resolvePromise) => {
    const s = createServer(handler)
    s.listen(0, '127.0.0.1', () => resolvePromise(s))
  })
  const closeServer = (s) => new Promise((resolvePromise) => s.close(() => resolvePromise()))

  const resetStats = () => { stats.api = 0; stats.zip = 0; stats.apiBytes = 0; stats.zipBytes = 0 }

  /**
   * 一个用例失败时把它看见的输出打出来。
   *
   * 失败只报「断言不成立」是不够的：这条链路上任何一个环节（问标签、下包、写盘）断了，
   * 现象都是同一个「没更新」。把输出留在这里，读日志的人不用再跑第二遍去猜。
   */
  const failWith = (ok, label, r) => {
    check(ok, label, ok ? undefined : `实际输出：${JSON.stringify(r.out.slice(0, 300))}`)
  }

  /** 写副本的状态文件。文件名按副本目录算，与 update.mjs 自己那一套必须一致。 */
  const writeState = (dir, patch) => {
    const hash = createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 12)
    writeFileSync(join(stateTmp, `project-forge-update-${hash}.json`),
      `${JSON.stringify(patch)}\n`, 'utf8')
  }

  /** 覆盖状态文件里的更新时间。写 0 = 当作「很久没更新过」。 */
  const setWindow = (dir, lastUpdateAt) => writeState(dir, { lastUpdateAt })

  /** 读状态文件里的更新时间（没有就是 0）。用来验「这次有没有占掉 24 小时窗口」。 */
  const readStateFile = (dir) => {
    const hash = createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 12)
    const p = join(stateTmp, `project-forge-update-${hash}.json`)
    if (!existsSync(p)) return 0
    try {
      return Number(JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))?.lastUpdateAt ?? 0) || 0
    } catch {
      return 0
    }
  }

  const main = async () => {
    // 发布方「最新版是哪个标签」由它决定，用例改它来换场景。
    const state = { tag: '9.9.9' }
    // 「那边没有最新发布」的场景：把这个开关打开。
    const opts = { noLatest: false, tagPage: false }
    const port = { value: 0 }
    const source = () => `http://127.0.0.1:${port.value}/owner/repo`

    const server = await serve((req, res) => {
      const path = req.url ?? ''
      const isLatest = path.includes('/releases/latest') && !path.includes('/download/')
      if (isLatest) {
        stats.api += 1
        if (opts.noLatest) { res.writeHead(404).end(); return }
        const body = Buffer.from(JSON.stringify({ tag_name: `v${state.tag}` }))
        stats.apiBytes += body.length
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length })
        res.end(body)
        return
      }
      if (path.endsWith('/project-forge.zip')) {
        stats.zip += 1
        const body = pkg.body
        stats.zipBytes += body.length
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length })
        res.end(body)
        return
      }
      // 托管平台形状的探针：`releases/latest` 跳到那一版的页面，**地址里带着标签**。
      // 这一支要单独验，因为它是真实 GitHub 上唯一会发生的那一支：跟着跳到页面会把
      // 一整页 HTML（近 200 KB）拉回来，正文里没有 JSON，于是退回「下载整包读版本」
      // ——每次任务开头 546 KB。判据因此不能只看「版本认得出来」，必须看**没去下包**。
      if (path.endsWith('/releases/tag/tag-page')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><body><h1>Release v${state.tag}</h1>${'x'.repeat(2000)}</body></html>`)
        return
      }
      if (path.endsWith('/releases/latest') && opts.tagPage === true) {
        stats.api += 1
        res.writeHead(302, { location: new URL('/o/r/releases/tag/tag-page', source()).toString() })
        res.end()
        return
      }
      res.writeHead(404).end()
    })
    port.value = server.address().port
    // 包由「以这个服务端为来源」的副本导出，所以副本更新完仍然知道自己该问谁。
    const pkg = makePackage('update-newpkg', { version: '9.9.9', source: source() })

    // 一、没有新版：只比版本，**不下整包**。这是绝大多数时候走的那条路，
    //     也是「更新不该每次拖走整包」那条要求的判据。
    {
      state.tag = '0.1.0'
      const dir = makeCopy('up-to-date', { source: source() })
      resetStats()
      const r = await runUpdate(dir, '--check')
      failWith(/已是最新/.test(r.out), '版本比本地旧时报「已是最新」', r)
      report(/已是最新/.test(r.out), '比版本：认得出来')
      const lean = stats.api === 1 && stats.zip === 0
      check(lean, '没有新版时只问一次标签，一个字节的整包都没下',
        `标签请求 ${stats.api} 次、整包请求 ${stats.zip} 次`)
      report(lean, `没有新版：只发 ${stats.api} 次请求，整包 0 次`)
      check(stats.apiBytes > 0 && stats.apiBytes < 1000, '那次请求的体积是几十字节级别，不是整包',
        `${stats.apiBytes} 字节（整包 ${pkg.body.length} 字节）`)
      report(stats.apiBytes < 1000, `那次请求 ${stats.apiBytes} 字节（整包 ${pkg.body.length} 字节）`)
    }

    // 一之二、托管平台形状：`releases/latest` 跳到那一版的页面，标签就在地址里。
    //     判据是**没有去下整包**——只验「版本认得出来」的话，跟着跳到页面、把 HTML
    //     拉回来、再退回下载整包那条路也会显示通过，而那正是每次任务 546 KB 的成因。
    {
      state.tag = '9.9.9'
      opts.tagPage = true
      const dir = makeCopy('tag-page', { source: source() })
      resetStats()
      const r = await runUpdate(dir, '--check')
      opts.tagPage = false
      failWith(/有新版本 9\.9\.9/.test(r.out), '跳转地址里带着标签时，版本照样认得出来', r)
      report(/有新版本 9\.9\.9/.test(r.out), '跳转探针：版本从落点地址里读出来')
      const noPackage = stats.zip === 0
      check(noPackage, '标签从落点地址读到时，不去下整包（这一条就是「每次任务 546 KB」的判据）',
        `整包请求 ${stats.zip} 次`)
      report(noPackage, '跳转探针：一个字节的整包都没下')
    }

    // 二、有新版：整份覆盖。本地改过的内容**照样被覆盖**——这是明确的规则，
    //     不是漏判：使用者要的是「用的时候是最新版」。
    {
      state.tag = '9.9.9'
      const dir = makeCopy('overwrite', { source: source() })
      const skillPath = join(dir, 'SKILL.md')
      // 改一处包内文件、放一个包里没有的文件，然后把窗口清零（等于过了 24 小时）。
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8')
        .replace('description:', 'description: 我改过的说明。'), 'utf8')
      const marker = join(dir, 'NOTES.md')
      writeFileSync(marker, 'x\n', 'utf8')
      setWindow(dir, 0)
      resetStats()
      const r = await runUpdate(dir, '--quiet')
      failWith(/已更新到最新版 9\.9\.9/.test(r.out), '有新版时整份换成新版，并报出前后两个版本', r)
      report(/已更新到最新版/.test(r.out), '更新：版本号变了')
      const v = skillVersion(readFileSync(skillPath, 'utf8'))
      check(v === '9.9.9', '更新之后 SKILL.md 里就是新版本号', `读到 ${v}`)
      report(v === '9.9.9', '更新：磁盘上的版本号真的变了')
      const mine = readFileSync(skillPath, 'utf8').includes('我改过的说明。')
      check(!mine, '本地改动被覆盖（规则就是整份覆盖，不替使用者判断）')
      report(!mine, '更新：本地改动被覆盖')
      // 覆盖的是**包覆盖到的地方**。使用者放在同一个目录里的其它文件（笔记、自己的临时
      // 文件）不属于这个 skill，不该被它顺手删掉——那不叫覆盖，那叫越权。
      check(existsSync(marker), '包外的文件不动（覆盖的是这个 skill，不是整个目录）')
      report(existsSync(marker), '更新：包外文件保留')
      const once = stats.api === 1 && stats.zip === 1
      check(once, '这一次更新只问了标签一次、下了整包一次', `标签 ${stats.api} 次、整包 ${stats.zip} 次`)
      report(once, '更新：各请求一次，没有重复下载')
      const tells = /你之前用的是 0\.14\.0/.test(r.out)
      check(tells, '更新完把「之前是哪一版」也说出来（使用者才知道自己跳过了什么）', r.out.slice(0, 160))
      report(tells, '更新：说清了从哪一版到哪一版')
    }

    // 三、24 小时窗口：刚更新过就不换文件，但**照常比版本**，并且说出来还要等多久。
    //     这一条正是「同一份副本一天不换好几次」那条要求的判据。
    {
      state.tag = '9.9.9'
      const dir = makeCopy('window', { source: source() })
      const skillPath = join(dir, 'SKILL.md')
      setWindow(dir, 0)
      const first = await runUpdate(dir, '--quiet')
      failWith(skillVersion(readFileSync(skillPath, 'utf8')) === '9.9.9',
        '前提：窗口用例先真的更新过一次（否则下面的窗口断言没有对象）', first)
      // 退回旧版，模拟「同一版又被跑了一次」：这一次不该换文件。
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8')
        .replace(/^([ \t]+version:[ \t]*)"[^"]*"/m, '$1"0.14.0"'), 'utf8')
      resetStats()
      const r = await runUpdate(dir, '--check')
      const says = /刚更新过/.test(r.out) && /之后再自动换/.test(r.out)
      check(says, '窗口内报出「刚更新过，等多久再换」', r.out.slice(0, 200))
      report(says, '窗口：说得出还要等多久')
      check(stats.api === 1 && stats.zip === 0, '窗口内只比版本，不下整包',
        `标签 ${stats.api} 次、整包 ${stats.zip} 次`)
      report(stats.api === 1 && stats.zip === 0, '窗口：不下载、不换文件')
      const stayed = skillVersion(readFileSync(skillPath, 'utf8')) === '0.14.0'
      check(stayed, '窗口内一个文件都没被换掉')
      report(stayed, '窗口：文件没动')
      check(!/已更新到最新版/.test(r.out), '窗口内不会谎报「已更新」')
      report(!/已更新到最新版/.test(r.out), '窗口：不谎报已更新')
      // 人在 --check 之外主动问时也看得到同一句话，不需要猜为什么没更新。
      const again = await runUpdate(dir)
      check(/刚更新过/.test(again.out), '默认模式下也说得出「还要等多久」', again.out.slice(0, 200))
      report(/刚更新过/.test(again.out), '窗口：默认模式不沉默')
    }

    // 四、发布方那边没有「最新发布」时：退回取整包读版本，路照样走得通。
    //     这条兜的是「平台不是 GitHub」或「还没建过 Release」——真发生时不能就此停住。
    {
      const dir = makeCopy('fallback', { source: source() })
      opts.noLatest = true
      setWindow(dir, 0)
      resetStats()
      const r = await runUpdate(dir, '--quiet')
      opts.noLatest = false
      failWith(/已更新到最新版 9\.9\.9/.test(r.out), '问不到标签时退回取整包，仍能更新到最新版', r)
      report(/已更新到最新版/.test(r.out), '退回路径：照样更新')
      check(stats.zip >= 1, '退回路径确实取了整包', `整包 ${stats.zip} 次`)
      report(stats.zip >= 1, '退回路径：取整包读版本')
    }

    // 五、下成了 GitHub 的 Source code：仓库自用文件该被清掉，否则它们会一直碍事
    //     （宿主可能把 AGENTS.md 当成这个 skill 的项目契约读进去）。
    {
      const dir = makeCopy('prune', { source: source() })
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
      writeFileSync(join(dir, '.github', 'workflows', 'check.yml'), 'x\n', 'utf8')
      mkdirSync(join(dir, 'scripts', 'dev'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'dev', 'preflight.mjs'), 'x\n', 'utf8')
      writeFileSync(join(dir, 'AGENTS.md'), 'x\n', 'utf8')
      setWindow(dir, 0)
      const r = await runUpdate(dir, '--quiet')
      failWith(skillVersion(readFileSync(join(dir, 'SKILL.md'), 'utf8')) === '9.9.9',
        '前提：清理用例真的更新过一次', r)
      const leftovers = ['.github', 'AGENTS.md', 'scripts/dev']
        .filter((f) => existsSync(join(dir, ...f.split('/'))))
      check(leftovers.length === 0,
        '更新时清掉「仓库里另有」那些文件（下成 Source code 的副本会变干净）',
        `还留着：${leftovers.join('、') || '（无）'}`)
      report(leftovers.length === 0, '清理：仓库自用文件被清掉')
      const kept = ['SKILL.md', 'scripts/update.mjs', 'scripts/survey.mjs', 'scripts/zip.mjs']
        .every((f) => existsSync(join(dir, ...f.split('/'))))
      check(kept, '清理没有连包内文件一起删掉')
      report(kept, '清理：包内文件完好')
      check(/顺手清掉了/.test(r.out), '清掉了什么，报告里说得出来')
      report(/顺手清掉了/.test(r.out), '清理：报告里说了')
    }

    // 八、同源校验：标签说 9.9.9，附件里却是另一个版本 —— 一个字节都不许写。
    //     不核对时的后果有两种，都很重：静默**降级**（装进旧版还说「已更新到最新版」），
    //     或白写一遍文件并占掉 24 小时窗口。判据是「两个版本都报出来 + 目录原样」。
    {
      state.tag = '9.9.9'
      const mismatched = buildPackage('mismatch-pkg', {
        version: '9.9.9', source: source(), declareVersion: '0.0.1',
      })
      const dir = makeCopy('mismatch', { source: source() })
      setWindow(dir, 0)
      const before = readFileSync(join(dir, 'SKILL.md'), 'utf8')
      const served = pkg.body
      pkg.body = mismatched.body
      resetStats()
      const r = await runUpdate(dir, '--quiet')
      pkg.body = served
      const tells = /9\.9\.9/.test(r.out) && /0\.0\.1/.test(r.out) && /没有更新/.test(r.out)
      failWith(tells, '标签版本与附件里的版本不一致时，两个版本都报出来并拒绝更新', r)
      report(tells, '同源校验：不一致就说出来')
      check(!/已更新到最新版/.test(r.out), '不一致时不会谎报「已更新到最新版」', r.out.slice(0, 200))
      report(!/已更新到最新版/.test(r.out), '同源校验：不谎报成功')
      check(readFileSync(join(dir, 'SKILL.md'), 'utf8') === before, '不一致时一个字节都没被改写')
      report(readFileSync(join(dir, 'SKILL.md'), 'utf8') === before, '同源校验：零写入')
      const free = readStateFile(dir)
      check(free === 0, '不一致时没有写下窗口（否则 24 小时内真更新会被挡掉）', `状态文件里是 ${free}`)
      report(free === 0, '同源校验：不占窗口')
    }

    // 九之前：文件地图读不出来时，**清理那一半会说自己在摸黑走**。
    //     判据分两层：解析器对「没有那两张表的文本」返回两张空表（这是它的约定），
    //     而调用方拿到空表必须能分辨「没东西要清」与「地图没读出来」——后者要报出来，
    //     否则使用者的副本里 `.github/`、`AGENTS.md` 会一直留着，而报告说这次一切正常。
    {
      const noMap = readFileMap('---\nname: x\n---\n\n# 没有文件地图的文件\n')
      const asExpected = noMap.shipped.length === 0 && noMap.repoOnly.length === 0
      check(asExpected, '例：没有文件地图的文本解析成两张空表（调用方据此分辨摸黑走）',
        JSON.stringify(noMap))
      report(asExpected, '文件地图：读不出来时是两张空表，不是半份')
      const src = readFileSync(join(SKILL_ROOT, 'scripts', 'update.mjs'), 'utf8')
      const guards = /mapRead: map\.shipped\.length > 0 \|\| map\.repoOnly\.length > 0/.test(src)
        && /这份包里的文件地图读不出来/.test(src)
      check(guards, 'update.mjs 会分辨「没东西要清」与「地图没读出来」，并把后者报出来')
      report(guards, '文件地图：摸黑走会说')
    }

    // 九、条目名带 `..`：**不许写到本领目录之外**。判据是目录外的那个东西还在、内容没变。
    //     包与文件地图都来自网络上的那一份，让它们决定写到哪儿，等于把本机路径交给别人。
    //     造法是把越界名字写进包内 `SKILL.md` 的「仓库里另有」表——那是**清理**那一半的
    //     判据来源，也是真会被解析成路径的地方。
    {
      state.tag = '9.9.9'
      const outsideDir = fixture('escape-outside', {})
      const outside = join(outsideDir, 'victim.txt')
      writeFileSync(outside, '原始内容\n', 'utf8')
      const evil = buildPackage('escape-pkg', { version: '9.9.9', source: source() })
      const skillPath = join(evil.dir, 'SKILL.md')
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8')
        .replace(/^### 仓库里另有$/m, '### 仓库里另有\n\n| `../victim.txt` | 越界条目（构造出来的） |'), 'utf8')
      gitIn(evil.dir, 'add', '-A')
      gitIn(evil.dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'escape')
      const zipped = spawnSync('git',
        ['-C', evil.dir, 'archive', '--format=zip', '--prefix=project-forge-/', '-o', join(ROOT, 'escape.zip'), 'HEAD'],
        { encoding: 'utf8', windowsHide: true })
      const dir = makeCopy('escape', { source: source() })
      setWindow(dir, 0)
      const served = pkg.body
      if (zipped.status === 0) pkg.body = readFileSync(join(ROOT, 'escape.zip'))
      resetStats()
      const r = await runUpdate(dir, '--quiet')
      pkg.body = served
      rmSync(join(ROOT, 'escape.zip'), { force: true })
      const survived = existsSync(outside) && readFileSync(outside, 'utf8') === '原始内容\n'
      failWith(survived, '文件地图里带 `..` 的条目不会动到本领目录之外的东西', r)
      report(survived, '边界：越界条目被挡住')
      check(/本领目录之外/.test(r.out), '越界条目要在报告里说出来，不静默忽略', r.out.slice(0, 240))
      report(/本领目录之外/.test(r.out), '边界：越界条目被报出来')
    }

    // 十、副本里读不到来源（`metadata.source` 被删掉、或宿主不认这个扩展字段）：
    //     这时走的是兜底地址，而兜底地址可以被 `PF_UPDATE_SOURCE` 改——**测试就是靠它
    //     把这一支做成确定的**：不需要真去问外网，也不依赖网络通不通。
    //
    //     这一用例同时验两件事：兜底**真的被用起来了**（把兜底改到本机服务端，它就在
    //     那儿问到了版本），以及副本自己的来源**优先于**兜底（另一条断言）。
    {
      const dir = makeCopy('no-source', {})
      opts.noLatest = true
      const r = await runUpdate(dir, '--check', { env: { PF_UPDATE_SOURCE: source() } })
      opts.noLatest = false
      const usedFallback = /有新版本 9\.9\.9/.test(r.out)
      failWith(usedFallback, '读不到来源时用兜底地址继续核对（PF_UPDATE_SOURCE 真的生效）', r)
      report(usedFallback, '无来源：兜底地址被用起来了')

      // 兜底地址可以**只有主机名、没有路径**：自建镜像与内网发布常常就是一个裸的
      // `http://host:port`。以前靠一条「主机后面必须还有一段路径」的正则判它，裸地址被
      // 静默拒绝——改环境变量的人以为指到了内网，实际还在打硬编码的那个仓库。
      // 这里连**请求路径**一起断言：地址被接受不等于拼出来的地址是对的。
      const bare = `http://127.0.0.1:${server.address().port}`
      resetStats()
      const rBare = await runUpdate(makeCopy('no-source-bare', {}), '--check',
        { env: { PF_UPDATE_SOURCE: bare } })
      const bareAccepted = /有新版本 9\.9\.9/.test(rBare.out)
      failWith(bareAccepted, '兜底地址只有主机名（没有路径）时也要被接受', rBare)
      report(bareAccepted, '无来源：裸主机名的兜底地址被接受')
      check(stats.api > 0, '裸主机名的地址拼出来的问询路径是对的（服务端真的收到了请求）',
        `约定端点收到 ${stats.api} 次请求`)
      report(stats.api > 0, '裸主机名：请求真的到了服务端')

      // 副本自己的来源优先：它指着本机服务端时，兜底指向哪儿都不该被用。
      const own = makeCopy('own-source-wins', { source: source() })
      const r2 = await runUpdate(own, '--check', { env: { PF_UPDATE_SOURCE: 'http://127.0.0.1:1/owner/repo' } })
      const ownWins = /有新版本 9\.9\.9/.test(r2.out)
      failWith(ownWins, '副本自己记的来源优先于兜底（fork 出去发版的人更新他自己的）', r2)
      report(ownWins, '来源优先级：副本自己记的优先')
    }

    // 十一、兜底也不成立时（这里是「连不上」这一支）：**如实说自己核对不了**，并给出
    //      恢复的办法。只说「无法自动核对」而不说缺哪一样、怎么补，使用者只能看到
    //      「更新不灵了」。
    {
      const dir = makeCopy('no-source-offline', {})
      const r = await runUpdate(dir, '--check', { env: { PF_UPDATE_SOURCE: 'http://127.0.0.1:1/owner/repo' } })
      const tells = /(没能联网核对|没能连上发布方)/.test(r.out) && /不是「已是最新」/.test(r.out)
      const quietEnough = !/已更新到最新版/.test(r.out)
      failWith(tells && quietEnough, '兜底也连不上时如实报「没能联网核对」，不谎报已更新', r)
      report(tells && quietEnough, '核对不了：如实说，不假装')
    }

    // 七、兜底地址必须真的是一条能拼出下载地址的仓库地址。
    //     副本里没有来源时，更新就靠它——它不成立，兜底就是假的，而现象仍然是「静默不更新」。
    {
      const path = repoPath(UPSTREAM)
      check(path !== undefined, 'update.mjs 的兜底来源是一条认得出的仓库地址', `读到的 UPSTREAM 是 ${UPSTREAM}`)
      report(path !== undefined, '兜底来源：形状可用')
      check(/^https:\/\//.test(UPSTREAM), '兜底来源是 https 地址（更新要走网络取包）', UPSTREAM)
      report(/^https:\/\//.test(UPSTREAM), '兜底来源：https')
      check(repoPath(UPSTREAM) !== undefined,
        '兜底来源归一成 owner/name 之后仍然认得出（发版门禁按这个形状比对）', repoPath(UPSTREAM))
    }

    // 七之一、仓库身份比对：三值，不是布尔。
    //
    // 判据曾是 `repoPath(a) !== repoPath(b)`。两个都认不出时它是 `undefined !== undefined`
    // = false，也就是「判为一致」——而「两个都认不出」正是最该停下的时候。
    // `git@host:owner/name` 这种 git 最常见的克隆写法当时就归一不出来，于是 fork 比对
    // 静默通过，用户包副本可能被指去别人的仓库而门禁一路绿。
    {
      const pairs = [
        ['git@github.com:acme/plain.git', 'https://github.com/acme/plain'],
        ['ssh://git@github.com/acme/x.git', 'git@github.com:acme/x'],
        ['https://user:token@github.com/acme/y.git', 'https://github.com/acme/y.git'],
      ]
      for (const [a, b] of pairs) {
        const rel = repoRelation(a, b)
        check(rel === 'same', `同一仓库的不同写法判为 same：${a}`, `得到 ${rel}`)
        report(rel === 'same', `身份归一：${a.slice(0, 26)}`)
      }

      const diff = repoRelation('https://github.com/acme/one', 'https://github.com/acme/two')
      check(diff === 'different', '不同仓库判为 different（不是「看起来像就算了」）', `得到 ${diff}`)
      report(diff === 'different', '身份归一：不同仓库')

      // 本组重点：把「没法比」读成「比过且一致」是最坏的一种失效。
      const unknown = repoRelation('not a url at all', 'also not one')
      check(unknown === 'unknown', '两个都认不出时判 unknown —— 不许当成 same', `得到 ${unknown}`)
      report(unknown === 'unknown', '身份归一：认不出报 unknown')

      const half = repoRelation('https://github.com/acme/x', '???')
      check(half === 'unknown', '只有一个认得出时也是 unknown', `得到 ${half}`)
      report(half === 'unknown', '身份归一：单边认不出')
    }

    // 七之二、问版本有两条路，按优先顺序排：认得出的托管平台先给接口路，认不出的只给
    //         网页路。**认不出就不猜**——给自建镜像硬拼一个接口地址，换来的是一句看起来
    //         像事实的「那边没有最新发布」，而正确结论是「这里问不出来」。
    //
    //         这是规则本身的断言（不发网络请求），而它值得单独验：排错一条路的现象是
    //         「更新莫名其妙不灵了」，而上面那一串用例照样全绿——它们走的都是网页路。
    {
      const gh = routesFor('https://github.com/owner/repo')
      const twoRoutes = gh.length === 2 && gh[0].kind === 'api' && gh[1].kind === 'web'
      check(twoRoutes, '托管平台形状的来源排得出两条路，接口路在前', JSON.stringify(gh))
      report(twoRoutes, '排路：托管平台给两条')
      const apiOk = gh[0].endpoint === 'https://api.github.com/repos/owner/repo/releases/latest'
      check(apiOk, '接口地址按平台公布的规律拼出来', gh[0].endpoint)
      report(apiOk, '排路：接口地址拼得对')
      const webKept = gh[1].endpoint === 'https://github.com/owner/repo/releases/latest'
      check(webKept, '网页路问的还是原来那个地址（退路不该是新的猜测）', gh[1].endpoint)
      report(webKept, '排路：网页地址没变')

      // 反例：认不出来的形状只留网页路，接口那一支完全不出现。
      const unrecognized = [
        ['自建镜像', 'http://127.0.0.1:9000/mirror'],
        ['别的托管平台', 'https://gitee.com/owner/repo'],
        ['多出几段路径', 'https://github.com/owner/repo/tree/main'],
      ]
      for (const [label, bad] of unrecognized) {
        const routes = routesFor(bad)
        check(routes.length === 1 && routes[0].kind === 'web' && apiEndpoint(bad) === undefined,
          `${label}：认不出就不给接口路（宁可少一条，也不猜一个地址出来）`, JSON.stringify(routes))
      }
      report(unrecognized.every(([, bad]) => routesFor(bad).length === 1), '排路：认不出的只给网页路')
    }

    await closeServer(server)
  }

  await main()

  // 六、连不上：退出码 0、**一个字节都不写**，并且不吵。指向本机一个没人监听的端口，
  //     连接立刻被拒——不依赖外网，也不会慢。
  //     静默的判据是「上次还核对得上」，不是「这次没连上」：后者会在网络抖一下时也出声。
  {
    const dir = makeCopy('unreachable', { source: 'http://127.0.0.1:1/owner/repo' })
    // 阈值的四分之一以前还核对得上：这属于「抖了一下」，下次再用就自己好了。
    writeState(dir, { lastUpdateAt: 0, lastOkAt: Date.now() - STALE_CHECK_MS / 4 })
    const before = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    // skill 自己在任务开头用的就是 --quiet 这一档，所以「静默」要按这一档来验。
    const r = await runUpdate(dir, '--quiet')
    check(r.status === 0, '连不上时退出码仍是 0（它挂在每个任务开头，不能把任务弄红）',
      `退出码 ${r.status}：${r.out.slice(0, 120)}`)
    report(r.status === 0, '连不上：退出码 0')
    check(r.out === '', '刚核对得上、这次没连上时保持静默（网络抖一下不该念一遍）',
      r.out.slice(0, 160))
    report(r.out === '', '连不上：偶尔一次静默')
    const forced = await runUpdate(dir, '--check')
    check(/没能联网核对/.test(forced.out) && /不是「已是最新」/.test(forced.out),
      '--check 下如实报「没能联网核对」，不说成「已是最新」', forced.out.slice(0, 160))
    report(/没能联网核对/.test(forced.out), '连不上：--check 说真话')
    check(readFileSync(join(dir, 'SKILL.md'), 'utf8') === before, '连不上时一个字节都没写')
    report(readFileSync(join(dir, 'SKILL.md'), 'utf8') === before, '连不上：零写入')
  }

  // 六之二、一直核对不上就要说出来。一路静默会被读成「一切正常」，而真相是这份停在了
  //         某一版——那正是「网络不通的人永远不知道自己落后了」的成因。判据落在「已经
  //         多久没能核对上」而不是「这次有没有连上」，所以它不会变成每次任务都念的噪音。
  {
    const stale = makeCopy('stale-speaks', { source: 'http://127.0.0.1:1/owner/repo' })
    writeState(stale, { lastUpdateAt: 0, lastOkAt: Date.now() - STALE_CHECK_MS * 3 })
    const r = await runUpdate(stale, '--quiet')
    const speaks = /没能核对新版/.test(r.out) && /不是「已是最新」/.test(r.out)
    failWith(speaks, '隔了好几天没能核对上时，--quiet 下也要说一句，并说清那不是「已是最新」', r)
    report(speaks, '连不上：隔久了会说')
    // 说完要安静一阵，否则它就从「提醒」变成了「每次任务都念一遍」。
    const again = await runUpdate(stale, '--quiet')
    check(again.out === '', '提醒过之后不再重复念（同一份副本按同一节奏才再说一次）',
      again.out.slice(0, 160))
    report(again.out === '', '连不上：说过就安静一阵')
    // 从没核对成功过也算「隔久了」：刚装上就撞上连不上，这件事本身值得知道。
    const never = makeCopy('never-checked-speaks', { source: 'http://127.0.0.1:1/owner/repo' })
    const rNever = await runUpdate(never, '--quiet')
    check(/一直没能连上发布方/.test(rNever.out) && /不是「已是最新」/.test(rNever.out),
      '从没核对成功过的副本也要说出来（新装的副本一用就撞上，不能一声不吭）',
      rNever.out.slice(0, 200))
    report(/一直没能连上发布方/.test(rNever.out), '连不上：从没成功过会说')
    // --check 是人主动问的，它每次都得说真话，不受上面那个节奏管。
    const ask = await runUpdate(stale, '--check')
    check(ask.out !== '' && /不是「已是最新」/.test(ask.out),
      '--check 每次都说真话，不因为刚提醒过就沉默', ask.out.slice(0, 160))
    report(ask.out !== '', '连不上：--check 照说')
  }

  // 七、有 .git = 源码副本：只读报告，**一个字节都不写**。
  {
    const dir = makeCopy('role-source', { withGit: true })
    const probe = join(dir, 'scripts', 'survey.mjs')
    const before = readFileSync(probe, 'utf8')
    const r = await runUpdate(dir, '--check')
    const says = /源码副本/.test(r.out) && /git pull/.test(r.out)
    check(says, '有 .git 的副本被认成源码副本，并指路 git pull', r.out.slice(0, 120))
    report(says, '源码副本：认得出')
    const untouched = readFileSync(probe, 'utf8') === before
    check(untouched, '源码副本一个字节都没被写', '文件内容变了')
    report(untouched, '源码副本：不写')
  }

  // 八、没有 .git、也没有来源 = 身份不明：这时走的是兜底地址，而**兜底地址可以被
  //     `PF_UPDATE_SOURCE` 改**——用例把它指到一个连不上的地址上，于是这一支
  //     （既没记来源、也核对不了）成为确定行为：报「没能联网核对」，不假装查过。
  //     指到外网的话这条断言会随网络抖动而变，那不是一个自检该有的性质。
  {
    const dir = makeCopy('role-nosource', {})
    const r = await runUpdate(dir, '--check', { env: { PF_UPDATE_SOURCE: 'http://127.0.0.1:1/owner/repo' } })
    const ok = /不是「已是最新」/.test(r.out) && !/已更新到最新版/.test(r.out)
    check(ok, '既没有来源也核对不了时，报「没能联网核对」并说清那不是「已是最新」', r.out.slice(0, 140))
    report(ok, '包副本：没有来源')
  }

  // 九、zip 读得动：拿 git archive 真产出的包来读，内容与磁盘逐字节一致。
  //     包从**这份 fixture 自己**产出，不从本仓库——工作区随时有未提交的改动，
  //     拿 HEAD 的包去比工作区的文件，会在每个改到一半的时刻假红。
  {
    const dir = makeCopy('zipread', { withGit: true })
    const zipPath = join(ROOT, 'zipread.zip')
    const archived = spawnSync('git',
      ['-C', dir, 'archive', '--format=zip', '--prefix=project-forge-0.14.0/', '-o', zipPath, 'HEAD'],
      { encoding: 'utf8', windowsHide: true })
    if (archived.status !== 0) {
      check(false, '前提：git archive 产得出 zip（否则下面的读包断言没有对象）',
        (archived.stderr ?? '').slice(0, 160))
      report(false, 'zip：前提')
    } else {
      const entries = stripCommonPrefix(readZip(readFileSync(zipPath)))
      const skill = entries.find((e) => e.name === 'SKILL.md')
      // 比内容，不比行尾：git archive 会按机器的 core.autocrlf 写出行尾（Windows 上是 CRLF），
      // 而库里存的是 LF。这一条要验的是「读得对」，不是「这台机器的行尾设置是什么」。
      const lf = (s) => String(s).replace(/\r\n/g, '\n')
      const ok = entries.length >= 4 && skill !== undefined
        && lf(skill.data.toString('utf8')) === lf(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
      check(ok, 'zip 读得动：条目数合理，且 SKILL.md 与磁盘那一份逐字节一致（行尾除外）',
        `条目 ${entries.length}，SKILL.md ${skill === undefined ? '缺失' : '在'}`)
      report(ok, 'zip：读得动且内容一致')
      const prefixed = entries.every((e) => !e.name.startsWith('project-forge-0.14.0/'))
      check(prefixed, 'zip 读出来的路径已经去掉打包前缀（比对的是包内路径）')
      report(prefixed, 'zip：前缀已去掉')
    }
    rmSync(zipPath, { force: true })
  }

  // ── 装完之后必须验收：版本号对得上，不等于内容是好的 ──
  //
  // 这条路径没有退路：包副本是 git archive 解出来的，**没有 .git**，写坏了没有
  // git checkout 可退。而「版本号读得回来」证明不了「SKILL.md 没被截断、脚本都在」——
  // 旧写法正是在这里直接宣布成功，读不到版本时甚至拿远端版本号顶上。
  {
    const src = readFileSync(join(SKILL_ROOT, 'scripts', 'update.mjs'), 'utf8')

    check(/function verifyInstalled\(/.test(src),
      '装完验收是一个独立函数（不与写入混在一段里，才验得清）')
    report(/function verifyInstalled\(/.test(src), '装后验收：实现存在')

    check(/装完之后读不到版本号/.test(src),
      '版本号读不到时判「不健康」，而不是用远端版本号顶上')
    report(/装完之后读不到版本号/.test(src), '装后验收：读不到版本号不算成功')

    check(/if \(health\.ok\) rememberState/.test(src),
      '验收不通过时不烧掉 24 小时窗口（否则修复后要白等一天）')
    report(/if \(health\.ok\) rememberState/.test(src), '装后验收：失败不烧窗口')

    check(/包里带了的 \$\{missing\.length\} 个脚本没有落盘/.test(src),
      '包里带的脚本没落盘时要判不健康（缺共用模块会让别的脚本一跑就崩）')
    report(/包里带了的/.test(src), '装后验收：缺脚本判不健康')
  }
}

// ── [47] 发布说明：正文只来自被标签指到的那次提交，半成品发不出去 ────────────

if (!HAS_GIT) {
  skipGroup('[47] 发布说明起草与发送门禁', '本机没有 git')
} else {
  group('[47] 发布说明：来源单一、半成品发不出去')
  const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid']
  const repo = join(ROOT, 'notes-repo')
  mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init')
  writeFileSync(join(repo, 'a.txt'), 'x\n', 'utf8')
  gitIn(repo, 'add', '-A')
  gitIn(repo, ...ID, 'commit', '-m', '第一条：没有正文')
  gitIn(repo, 'tag', 'v0.1.0')
  writeFileSync(join(repo, 'b.txt'), 'y\n', 'utf8')
  gitIn(repo, 'add', '-A')
  gitIn(repo, ...ID, 'commit', '-m', '第二条：也没有正文')
  gitIn(repo, 'tag', 'v0.2.0')

  const draft = (tag, out) => spawnSync(
    process.execPath, [join(SCRIPTS_DIR, 'draft-release-notes.mjs'), tag, out],
    { cwd: repo, encoding: 'utf8', windowsHide: true },
  )

  // 1) 被标签指到的提交没有正文 → 只能列出主题，并留下给维护者的标记
  const bare = join(ROOT, 'notes-bare.md')
  const r1 = draft('v0.2.0', bare)
  const bareText = existsSync(bare) ? readFileSync(bare, 'utf8') : ''
  const marked = r1.status === 0 && bareText.includes('pf:needs-summary')
  check(marked, '没有总述时写下 pf:needs-summary 标记（而不是冒充成品）', bareText.slice(0, 120))
  report(marked, '无总述：留下标记')

  // 2) 这份起草稿交给发送端 → 必须拒绝（exit 2），不许发出去
  //    给它一个假凭据与一个假仓库名：拒绝发生在任何网络动作之前，所以这条断言是纯本地的。
  const send = spawnSync(
    process.execPath,
    [join(SCRIPTS_DIR, 'release-notes.mjs'), 'v0.2.0', bare, '--repo', 'owner/name'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_TOKEN: 'fixture-token-not-used' } },
  )
  const refused = send.status === 2
  check(refused, '起草稿被发送端拒绝（半成品发不出去）', `exit=${send.status} ${(send.stderr ?? '').slice(0, 120)}`)
  report(refused, '半成品：拒绝发送')

  // 3) 被标签指到的提交有正文 → 正文就是说明，且不留标记
  writeFileSync(join(repo, 'c.txt'), 'z\n', 'utf8')
  gitIn(repo, 'add', '-A')
  gitIn(repo, ...ID, 'commit', '-m', '第三条：有正文', '-m', '这一版把某个命令的参数改了，用的人需要跟着改一次。')
  gitIn(repo, 'tag', 'v0.3.0')
  const withBody = join(ROOT, 'notes-body.md')
  const r3 = draft('v0.3.0', withBody)
  const bodyText = existsSync(withBody) ? readFileSync(withBody, 'utf8') : ''
  const used = r3.status === 0
    && bodyText.includes('这一版把某个命令的参数改了')
    && !bodyText.includes('pf:needs-summary')
  check(used, '有正文时直接采用它，不再列提交主题', bodyText.slice(0, 160))
  report(used, '有总述：直接采用')

  // 4) 判据本身要能两面证伪：带标记的认出来、不带标记的放行。少了这一半，
  //    「拒绝发送」有可能是一句恒真的拒绝，而上面那条断言照样绿。
  check(needsSummary(bareText) && !needsSummary(bodyText),
    '「还没写完」的判据两面都分得清（带标记认出、不带标记放行）',
    `bare=${needsSummary(bareText)} body=${needsSummary(bodyText)}`)
  report(needsSummary(bareText) && !needsSummary(bodyText), '判据：两面都分得清')

  // 5) 没有上一个标签时（仓库的第一个版本），不许给出点不开的对比链接，
  //    也不许写「仅列最近 100 条」——有总述时页面上一句提交都没列，那句话是凭空多出来的。
  //
  //    两个都是实际发生过的事：第一次发版时页面底部挂着
  //    `compare/v1.0.0`（只有一个端点，点开 404），上面还写着「仅列最近 100 条」，
  //    而正文里一条都没列。
  const first = join(ROOT, 'notes-first.md')
  const fresh = spawnSync(
    process.execPath, [join(SCRIPTS_DIR, 'draft-release-notes.mjs'), 'v0.1.0', first],
    { cwd: repo, encoding: 'utf8', windowsHide: true },
  )
  const firstText = existsSync(first) ? readFileSync(first, 'utf8') : ''
  const noDeadLink = fresh.status === 0 && !/compare\//.test(firstText)
  check(noDeadLink, '第一个版本：不给点不开的对比链接', firstText.split('\n').slice(-3).join(' | ').slice(0, 160))
  report(noDeadLink, '首版：没有死链')
  const noPhantomCount = !firstText.includes('仅列最近 100 条')
  check(noPhantomCount, '没有列提交时不写「仅列最近 100 条」（那句话要真有列表才成立）',
    firstText.slice(0, 120))
  report(noPhantomCount, '没有假计数')
  // 反面对照：有上一个版本时，「完整改动」那一行必须给出两个端点组成的区间，
  // 否则上面那条「不给死链」会被「永远不给区间」这种退化解满足。
  // 这里不假定有 remote：没有 remote 时不给链接是对的（不编地址），但区间照写；
  // 区间是「上一个标签..这个标签」，即紧邻的那一个，不是最早的任何一个。
  const linked = /完整改动/.test(bodyText) && /v0\.2\.0\.\.v0\.3\.0/.test(bodyText)
  check(linked, '有上一个版本时照旧给出区间（否则「不给死链」可以靠从不给区间蒙过去）',
    bodyText.split('\n').filter((l) => l.includes('完整改动')).join(' | ').slice(0, 160))
  report(linked, '有上一版：区间照给')
}

// ── [48] 包自洽性：包里的相对引用必须落在包内 ────────────────────────────────

group('[48] 包自洽性：包里的相对引用必须落在包内')
{
  const clone = skillClone('selfcontained')
  const before = preflightIn(clone)
  const green = before.status === 0
  check(green, '前提：未改动的副本本来是全绿的（否则下面两条断言没有对象）',
    before.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(green, '前提：未改动副本全绿')

  // 反例一：随包分发的脚本导入了只在仓库里的脚本。
  // 这正是实测撞过的那一次：**文件集合完全正确**（39 个文件、两张表都对得上），
  // 而用户拿到的包里 compose-agents.mjs 一跑就报 ERR_MODULE_NOT_FOUND。
  const compose = join(clone, 'scripts', 'compose-agents.mjs')
  const composeBefore = readFileSync(compose, 'utf8')
  writeFileSync(compose, composeBefore.replace("from './survey.mjs'", "from './dev/preflight.mjs'"), 'utf8')
  gitIn(clone, 'add', '-A')
  const brokenImport = preflightIn(clone)
  const importCaught = brokenImport.status === 1 && /不在用户包里/.test(brokenImport.out)
  check(importCaught, '包里的脚本导入仓库自用脚本 → 当场红（「集合对、包却崩」那类问题）',
    brokenImport.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(importCaught, '反例一：包内导入越界')
  writeFileSync(compose, composeBefore, 'utf8')

  // 反例二：包里的文档把读者指到包外。同样是「集合正确、读者点开是死链」。
  const readme = join(clone, 'README.md')
  const readmeBefore = readFileSync(readme, 'utf8')
  writeFileSync(readme,
    readmeBefore.replace('https://github.com/FiretrUCK666/project-forge/blob/main/CONTRIBUTING.md', 'CONTRIBUTING.md'),
    'utf8')
  gitIn(clone, 'add', '-A')
  const deadLink = preflightIn(clone)
  const linkCaught = deadLink.status === 1 && /不在用户包里/.test(deadLink.out)
  check(linkCaught, '包里的文档链接指向仓库自用文件 → 当场红（拿到包的人点了是死链）',
    deadLink.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(linkCaught, '反例二：包内链接越界')
}

// ── [48b] 落盘族的引用归属：模板不许带本 skill 自己的路径 ────────────────────

group('[48b] 落盘族引用归属：模板带了自己的路径就必须红，别人的文件不许误判')
{
  // 这一组守的是「文件集合正确、包自身也对，但落盘到别人家之后读者扑空」那一类。
  // 判据的**方向**与前一组相反：前一组问「本包里有吗」，这一组问「这是谁的文件」。 
  // 两个方向都必须有用例，否则改任何一边都不会有人知道。
  const clone = skillClone('delivered-attribution')
  const before = preflightIn(clone)
  const green = before.status === 0
  check(green, '前提：未改动的副本本来是全绿的（否则下面几条断言没有对象）',
    before.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(green, '前提：未改动副本全绿')

  const probe = (mutate, label) => {
    mutate()
    gitIn(clone, 'add', '-A')
    const r = preflightIn(clone)
    return { ok: r.status === 1 && /落盘族|本 skill 自己的路径/.test(r.out), out: r.out, label }
  }

  const readmePath = join(clone, 'templates', 'readme.md')
  const readmeBefore = readFileSync(readmePath, 'utf8')

  // 正例一：本包独占命名空间 → 红。这就是「读者点进去扑空」的最小形态。
  {
    const r = probe(() => writeFileSync(readmePath,
      `${readmeBefore}\n见 \`references/publish.md\` 的说明。\n`, 'utf8'))
    check(r.ok, '正例：templates/ 里指向 references/ → 红',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(r.ok, '正例：指向 references/ 被抓住')
    writeFileSync(readmePath, readmeBefore, 'utf8')
  }

  // 正例二：指向本包真实存在的脚本 → 红。读者会照着跑，而目标项目没有那个文件。
  {
    const r = probe(() => writeFileSync(readmePath,
      `${readmeBefore}\n跑 \`scripts/sync-toc.mjs\` 生成目录。\n`, 'utf8'))
    check(r.ok, '正例：templates/ 里指向本包脚本 → 红',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(r.ok, '正例：指向本包脚本被抓住')
    writeFileSync(readmePath, readmeBefore, 'utf8')
  }

  // 正例三：**新建**一个模板，不登记任何清单 → 仍然被抓。
  // 这条验的是「定义域由目录结构给出，不靠人工清单」这个通则本身；
  // 没有它，新增模板就得靠谁记得去改名单，而名单迟早漏。
  {
    const newTemplate = join(clone, 'templates', 'security.md')
    const r = probe(() => writeFileSync(newTemplate, '# 安全\n\n判据见 `references/handoff.md`。\n', 'utf8'))
    check(r.ok, '正例：新建模板无需登记，自动化纳入判据',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(r.ok, '正例：新增模板自动纳入')
    // 清理必须验证：一个静默失败的 catch 会让这个文件留在副本里，
    // 把后面每一条反例都污染成红——症状出现在别处，根因却在这里。
    if (existsSync(newTemplate)) unlinkSync(newTemplate)
    check(!existsSync(newTemplate), '前置：新模板已删除（否则后续复位用例无意义）')
  }

  // 正例四：尖括号通配形态 —— 读者看到的也是一个路径，不能因为含 `<>` 就对门禁隐形。
  {
    const r = probe(() => writeFileSync(readmePath,
      `${readmeBefore}\n另有 \`references/publish-<生态>.md\`。\n`, 'utf8'))
    check(r.ok, '正例：尖括号通配形态也被判（读者看它就是路径）',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(r.ok, '正例：尖括号通配')
    writeFileSync(readmePath, readmeBefore, 'utf8')
  }

  // 正例五：命名空间对、但文件在本包里也不存在 → 同样红，且措辞要说清是另一种错。
  // 归属只看命名空间，不看文件在不在：`references/` 是本 skill 的布局，目标项目不会
  // 自然长出来，所以「写错名字」不该比「写对名字」更容易过门。
  {
    writeFileSync(readmePath, `${readmeBefore}\n见 \`references/does-not-exist.md\`。\n`, 'utf8')
    gitIn(clone, 'add', '-A')
    const r = preflightIn(clone)
    const ok = r.status === 1 && /在两个项目里都找不到/.test(r.out)
    check(ok, '正例：命名空间内的不存在路径也红，措辞区分「本包也没有」',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(ok, '正例：不存在的命名空间路径')
    writeFileSync(readmePath, readmeBefore, 'utf8')
  }

  // 反例一：目标项目自己的文件 → 不判。
  // 这几份**本来就应该**出现在目标项目的模板里；判它们会让好的模板变红。
  {
    writeFileSync(readmePath,
      `${readmeBefore}\n[English](README.en.md) | [贡献](CONTRIBUTING.md) | [许可](LICENSE)\n`, 'utf8')
    gitIn(clone, 'add', '-A')
    const r = preflightIn(clone)
    const ok = r.status === 0
    check(ok, '反例：指向目标项目自有文件（README.en.md 等）→ 不判',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(ok, '反例：目标项目自有文件放行')
    writeFileSync(readmePath, readmeBefore, 'utf8')
  }

  // 反例二：目标项目自己的脚本名（本包**没有**这个文件）→ 不判。
  // 不这样分，「同名不同物」就会天天误报，而误报的门禁会被当成坏了。
  {
    writeFileSync(readmePath, `${readmeBefore}\n跑 \`scripts/build.mjs\` 构建。\n`, 'utf8')
    gitIn(clone, 'add', '-A')
    const r = preflightIn(clone)
    const ok = r.status === 0
    check(ok, '反例：本包没有的脚本名（目标项目自己的）→ 不判',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(ok, '反例：同名不同物放行')
    writeFileSync(readmePath, readmeBefore, 'utf8')
  }

  // 反例三：受管标记本身不是引用，不能因为带 `pf:` 就红。
  {
    writeFileSync(readmePath,
      `${readmeBefore}\n<!-- project-forge:kernel:start -->\n<!-- pf:author: 测试 -->\n`, 'utf8')
    gitIn(clone, 'add', '-A')
    const r = preflightIn(clone)
    const ok = r.status === 0
    check(ok, '反例：受管围栏标记（pf: / kernel:）→ 不判',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(ok, '反例：受管标记放行')
    writeFileSync(readmePath, readmeBefore, 'utf8')
  }

  // 反例四：YAML 里在注释中提到本包路径也要红（它是落盘族的文件，注释同样会被读者看到）。
  {
    const ciPath = join(clone, 'templates', 'ci-check.yml')
    const ciBefore = readFileSync(ciPath, 'utf8')
    writeFileSync(ciPath, `# 判据见 references/remote-github.md 第八节。\n${ciBefore}`, 'utf8')
    gitIn(clone, 'add', '-A')
    const r = preflightIn(clone)
    const ok = r.status === 1 && /本 skill 自己的路径/.test(r.out)
    check(ok, '正例：.yml 模板也要判（原先只扫 .md，8 处漏检就出在这里）',
      r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
    report(ok, '.yml 模板纳入判据')
    writeFileSync(ciPath, ciBefore, 'utf8')
  }

  gitIn(clone, 'add', '-A')
  const final = preflightIn(clone)
  check(final.status === 0, '末尾：全部复位后应回到全绿',
    final.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(final.status === 0, '末尾：复位后回绿')
}

// 这一组守的是「占位符判据按归属而不是形状」。
//
// 只看形状时两头都错：`{{ title }}` 是 Vue/Jinja 的正常语法却被判成没填完（照着做
// 就是删掉使用者的变量名），而 `<安装命令>` 这种真占位符反而看不见（工作流是空壳，
// 却说「已经干净」）。判据改成「这个名字是不是本 skill 模板里的」之后，两头都对。
group('[51b] 占位符判据：认自己家的取值名，不认别人的模板语法')
{
  const handoff = (dir, flag = '--verify') => spawnSync(process.execPath,
    [join(SKILL_ROOT, 'scripts', 'handoff.mjs'), dir, flag],
    { encoding: 'utf8', windowsHide: true })

  // 反例一：Vue / Jinja / Handlebars 的变量名 —— 一个字都不该被判成占位符。
  // 这是原先的误伤：一个正常前端项目跑 --verify 会退出 1 并被建议「填掉或删掉」。
  const vue = fixture('ho-vue', {
    'package.json': '{"name":"v","version":"1.0.0"}\n',
    'src/App.vue': '<template>\n  <h1>{{ title }}</h1>\n  <p>{{ user_name }}</p>\n</template>\n',
    'templates/card.hbs': '<div>{{ cardTitle }}</div>\n',
    'templates/page.jinja': '<h1>{{ page_title }}</h1>\n',
  })
  const rVue = handoff(vue)
  check(rVue.status === 0, '反例：Vue/Jinja/Handlebars 变量不判成未填占位符',
    String(rVue.stdout ?? '').split('\n').filter((l) => /\{\{|待处理/.test(l)).join(' | ').slice(0, 220))
  report(rVue.status === 0, '反例：别人的模板语法放行')

  // 反例二：HTML 标签、TS 泛型、比较运算里的 `<` 不能被当成占位符。
  const html = fixture('ho-html', {
    'package.json': '{"name":"h","version":"1.0.0"}\n',
    'index.html': '<div class="x"><span>hello</span><br/></div>\n',
    'a.ts': 'const x: Array<string> = []; if (a < b) {}\n',
  })
  const rHtml = handoff(html)
  check(rHtml.status === 0, '反例：HTML/JSX/泛型里的尖括号不判',
    String(rHtml.stdout ?? '').split('\n').filter((l) => /待处理/.test(l)).join(' | ').slice(0, 220))
  report(rHtml.status === 0, '反例：尖括号的普通用法放行')

  // 正例：本 skill 模板真用过的取值名 → 必须判出来。
  const real = fixture('ho-realtoken', {
    'LICENSE': 'Copyright (c) {{YEAR}} {{HOLDER}}\n',
  })
  const rReal = handoff(real)
  const caught = rReal.status === 1 && /YEAR|HOLDER/.test(String(rReal.stdout ?? ''))
  check(caught, '正例：本 skill 模板的取值名（YEAR/HOLDER）必须被判出来',
    String(rReal.stdout ?? '').split('\n').filter((l) => /待处理|占位/.test(l)).join(' | ').slice(0, 220))
  report(caught, '正例：自家取值名被抓')

  // 正例：CI 里没换掉的尖括号占位符 → 必须判出来。
  // 这是原先的漏判：把模板注释块删掉后 --verify 报「已经干净」，而工作流是空壳。
  const ci = fixture('ho-angle', {
    'package.json': '{"name":"c","version":"1.0.0"}\n',
    '.github/workflows/check.yml': [
      'name: check',
      'on:',
      '  push:',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      "      - run: '<安装命令>'",
      '',
    ].join('\n'),
  })
  const rCi = handoff(ci)
  const ciCaught = rCi.status === 1 && /安装命令/.test(String(rCi.stdout ?? ''))
  check(ciCaught, '正例：尖括号占位符（安装命令）必须被判出来',
    String(rCi.stdout ?? '').split('\n').filter((l) => /待处理|占位/.test(l)).join(' | ').slice(0, 220))
  report(ciCaught, '正例：尖括号占位符被抓')

  // 反例三：中文技术文档里的**指路写法**不能当占位符。
  // `<生产环境>`、`<部署文档>`、`<项目邮箱>` 是读者要去的地方，不是要替换的洞；
  // 判成占位符会让人去删掉自己的文档。判据收在「以操作位名词结尾」这一类上。
  const cjkDoc = fixture('ho-cjk-angle', {
    'package.json': '{"name":"d","version":"1.0.0"}\n',
    'README.md': '部署到 <生产环境> 之前先备份。反馈发到 <项目邮箱>。详见 <部署文档>。\n',
  })
  const rCjk = handoff(cjkDoc)
  check(rCjk.status === 0, '反例：中文指路写法（生产环境/部署文档/项目邮箱）不判成占位符',
    String(rCjk.stdout ?? '').split('\n').filter((l) => /待处理|占位/.test(l)).join(' | ').slice(0, 220))
  report(rCjk.status === 0, '反例：中文指路写法放行')
}

// ── [49] 命令行用法：打错了必须说出来 ────────────────────────────────────────

group('[49] 命令行用法：打错了必须说出来')
{
  const run = (args) => spawnSync(process.execPath,
    [join(SKILL_ROOT, 'scripts', 'dev', 'preflight.mjs'), ...args],
    { encoding: 'utf8', windowsHide: true })
  // 断的是「有输出」，不是只断退出码：只断退出码正是让「提示被 return 2 吃掉」这个缺陷
  // 溜过去的原因——退出码对了，人却什么都看不到。
  for (const [args, label] of [
    [['--bogus'], '未知参数'],
    [['--release'], '参数缺值'],
    [['--package'], '参数缺值'],
  ]) {
    const r = run(args)
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    const ok = r.status === 2 && text !== ''
    check(ok, `用法错误（${label}）退出 2 且说得出话`, `exit=${r.status} 输出 ${text.length} 字节`)
    report(ok, `用法错误：${label}`)
  }
  const help = run(['--help'])
  const helpOk = help.status === 0 && /用法/.test(help.stdout ?? '')
  check(helpOk, '--help 退出 0 并打印用法', `exit=${help.status}`)
  report(helpOk, '--help 打印用法')
}

group('[50] 命令推导的四种空：每一种都要说得出「为什么空」')
{
  // 这一组守的是 P7 那道验证门。命令推不出来本身不可怕，可怕的是**推不出来还不说为什么**
  // ——读的人会以为项目没有可跑的命令，于是把没验证过的东西汇报成「已验证」。
  const scriptsOf = (data) => data.commands ?? {}
  const noteOf = (data) => scriptsOf(data).note ?? ''

  // 1) 常规脚本名：推得出命令，且**不**该有说明（有说明就说明判据走进了别的分支）。
  const normal = survey(fixture('cmd-normal', {
    'package.json': '{"name":"n","scripts":{"build":"tsc","test":"vitest run","lint":"eslint ."}}\n',
  }))
  const normalOk = scriptsOf(normal).build === 'npm run build'
    && scriptsOf(normal).test === 'npm run test'
    && scriptsOf(normal).install === 'npm install'
    && noteOf(normal) === ''
  check(normalOk, '常规脚本名：推出命令、带上 install、没有多余的说明',
    JSON.stringify(scriptsOf(normal)))
  report(normalOk, '常规脚本名：有命令、无说明')

  // 2) 只有自定义脚本名：**说得出为什么空，并列出原始脚本名**。这是本组的主角。
  const custom = survey(fixture('cmd-custom', {
    'package.json': '{"name":"c","scripts":{"forge":"node forge.mjs","smelt":"node smelt.mjs"}}\n',
  }))
  const customNote = noteOf(custom)
  const customOk = scriptsOf(custom).build === undefined
    && customNote.includes('forge') && customNote.includes('smelt') && customNote.includes('常规名字')
  check(customOk, '自定义脚本名：一条命令都没有，但说明里列出了清单声明的脚本名',
    customNote === '' ? '(没有说明——这正是要防的静默)' : customNote.slice(0, 80))
  report(customOk, '自定义脚本名：说明里带出原始脚本名')

  // 3) 没有 scripts 字段：也要有说明，且**不能给 install**——给了它，扁平视图里就有了一条
  //    命令，「未推导出任何命令」这条诚实信号便不再出现。
  const bare = survey(fixture('cmd-bare', { 'package.json': '{"name":"b"}\n' }))
  const bareOk = scriptsOf(bare).install === undefined && noteOf(bare).includes('scripts')
  check(bareOk, '没有 scripts 字段：不给 install，且说明里说清原因', JSON.stringify(scriptsOf(bare)))
  report(bareOk, '没有 scripts 字段：有说明、无假命令')

  // 4) scripts 是空对象：与「没有这个字段」分得开（两句话不同）。
  const empty = survey(fixture('cmd-empty', { 'package.json': '{"name":"e","scripts":{}}\n' }))
  const emptyOk = noteOf(empty) !== '' && noteOf(empty) !== noteOf(bare)
  check(emptyOk, 'scripts 是空的：与「没有 scripts 字段」说得出不同的话', noteOf(empty).slice(0, 60))
  report(emptyOk, 'scripts 是空的：与另一种空分得开')

  // 5) 反过来证伪：上面那几条不能恒真——给一个**能**推出命令的项目，说明必须消失。
  const canBeSilent = noteOf(normal) === '' && scriptsOf(normal).build !== undefined
  check(canBeSilent, '前提：说明只出现在真的推不出命令时（否则上面几条是恒真的）')
  report(canBeSilent, '前提：有命令时没有说明')
}

// 交棒勘察的调用封装：**文件级**，因为不止一个分组要用它。
// 放在组内会让别的组引用不到，而那种错只在运行时炸出来（ReferenceError），
// 前面已经通过的断言全都白跑——一次真实的教训。
function handoff(dir, ...a) {
  return spawnSync(process.execPath, [join(SCRIPTS_DIR, 'handoff.mjs'), dir, ...a], { encoding: 'utf8' })
}

function handoffJson(dir, ...a) {
  const r = handoff(dir, '--json', ...a)
  // 退出码 0 与 1 都是正常结果：0 = 干净，1 = 不干净。2 才是失败。
  if (r.status !== 0 && r.status !== 1) return { error: (r.stderr ?? '').slice(0, 300) }
  try {
    return JSON.parse((r.stdout ?? '').replace(/^\uFEFF/, ''))
  } catch (error) {
    return { error: `输出不是合法 JSON：${error.message}` }
  }
}

group('[51] 交棒勘察：痕迹找得到、干净的判得对、通用标记不误伤')
{
  const handoff = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'handoff.mjs'), dir, ...a], { encoding: 'utf8' })
  const handoffJson = (dir, ...a) => {
    const r = handoff(dir, '--json', ...a)
    // 退出码 0 与 1 都是正常结果：0 = 干净，1 = 不干净。2 才是失败。
    if (r.status !== 0 && r.status !== 1) return { error: (r.stderr ?? '').slice(0, 300) }
    try {
      return JSON.parse((r.stdout ?? '').replace(/^\uFEFF/, ''))
    } catch (error) {
      return { error: `输出不是合法 JSON：${error.message}` }
    }
  }
  const pick = (groups, path, kind) => (groups ?? []).find(
    (f) => f.path === path && (kind === undefined || f.kind === kind),
  )
  const every = (groups) => Object.values(groups ?? {}).flat()
  const blockingOf = (data) => every(data.groups).filter((f) => f.blocks === true).length

  // ── 1) 正例：每一类痕迹都要被找到，且行号与相对路径都对 ──
  const dirty = fixture('handoff-dirty', {
    'AGENTS.md': [
      '# 项目',
      '',
      '<!-- project-forge:kernel:start -->',
      '内核正文',
      '<!-- project-forge:kernel:end -->',
      '',
      '## 一节',
      '',
      '<!-- pf:author: 说明本项目的运行前提 -->',
      '',
    ].join('\n'),
    'notes/managed.md': '<!-- project-forge:managed -->\n',
    'notes/author.md': '<!-- pf:author: 待补 -->\n',
    'LICENSE': 'MIT License\n\nCopyright (c) {{YEAR}} {{HOLDER}}\n',
    'AGENTS.md.tmp-123': '半成品\n',
  })
  const j1 = handoffJson(dirty, '--scan')
  const m1 = j1.groups?.markers ?? []
  const u1 = j1.groups?.unfinished ?? []
  const p1 = j1.groups?.placeholders ?? []
  const r1 = j1.groups?.residue ?? []

  const kStart = pick(m1, 'AGENTS.md', 'kernel-start')
  const kEnd = pick(m1, 'AGENTS.md', 'kernel-end')
  const managed = pick(m1, 'notes/managed.md', 'managed')
  const author = pick(u1, 'notes/author.md', 'author-placeholder')
  const year = pick(p1, 'LICENSE', 'placeholder')
  const tmp = pick(r1, 'AGENTS.md.tmp-123', 'tmp-file')

  const foundOk = kStart?.line === 3 && kEnd?.line === 5 && managed?.line === 1
    && author?.line === 1 && year?.line === 3 && tmp !== undefined
  check(foundOk, '每一类痕迹都被找到，且行号正确',
    `kernel=${kStart?.line}/${kEnd?.line} managed=${managed?.line} author=${author?.line} 占位=${year?.line} 残留=${tmp === undefined ? '无' : '有'}`)
  report(foundOk, '正例：痕迹全找到、行号对')

  // pf:author 必须**单独成组**：它与「skill 装进来的」标识符不是一类东西，混在一组里
  // 会被顺手删掉——删掉标记而不补内容，交出去的是一份干净但空的契约。
  const ownGroupOk = m1.every((f) => f.kind !== 'author-placeholder')
    && u1.some((f) => f.kind === 'author-placeholder')
  check(ownGroupOk, 'pf:author 单独成组（不在标识符那一组里）',
    `标识符组 ${m1.length} 条，未完成组 ${u1.length} 条`)
  report(ownGroupOk, '未完成的占位：单独成组')

  // 相对路径必须是**相对项目目录**的：报告里的路径要能直接对着项目核对，
  // 绝对路径在换台机器后就没法核对了。分隔符统一用正斜杠。
  const relOk = [kStart, kEnd, managed, author, year, tmp].every((f) => f !== undefined)
    && managed?.path === 'notes/managed.md'
    && !/^[A-Za-z]:/.test(String(managed?.path))
    && !String(managed?.path).startsWith('/')
  check(relOk, '相对路径相对项目目录，且用正斜杠', `path=${managed?.path}`)
  report(relOk, '相对路径：正确')

  const scanExit = handoff(dirty, '--scan').status
  const verifyExit = handoff(dirty, '--verify').status
  const exitOk = scanExit === 0 && verifyExit === 1
  check(exitOk, 'scan 恒为 0（它是报告），verify 不干净为 1', `scan=${scanExit} verify=${verifyExit}`)
  report(exitOk, '退出码：scan=0 / verify=1')

  const cleanOk = j1.clean === false && j1.blocking === blockingOf(j1)
  check(cleanOk, '不干净时 clean=false，且 blocking 只数挡判定的那些',
    `clean=${j1.clean} blocking=${j1.blocking}`)
  report(cleanOk, '判定：不干净')

  // ── 2) 反例（防误伤）：通用标记不算痕迹，疑似项要标出来 ──
  const innocent = fixture('handoff-innocent', {
    'README.md': '# 项目\n\n<!-- toc:start -->\n- 目录\n<!-- toc:end -->\n\n## 安装\n',
    'cards.md': '<!-- pf:claims update-interval=24h -->\n',
  })
  const j2 = handoffJson(innocent, '--scan')
  const all2 = every(j2.groups)
  // toc 标记是 sync-toc 的通用目录标记，不专属本 skill：它**根本不出现**在报告里。
  const tocOk = all2.every((f) => !/toc:start|toc:end/.test(String(f.literal ?? f.match)))
  check(tocOk, 'toc 标记不算痕迹（一条都不报）',
    all2.map((f) => String(f.literal ?? f.match)).join('、') || '(无)')
  report(tocOk, '通用目录标记：不误伤')
  // pf:claims 出现在目标项目属异常，要报；但它是「疑似」，不是确定的痕迹。
  const claims = pick(j2.groups?.markers, 'cards.md', 'claims')
  const claimsOk = claims !== undefined && claims.suspect === true
  check(claimsOk, 'pf:claims 报出来但标为「疑似」（不是确定的痕迹）',
    claims === undefined ? '没报出来' : JSON.stringify(claims.suspect))
  report(claimsOk, '本 skill 自己的标记：报为疑似')

  // ── 3) 干净 fixture：没有痕迹 → verify 退出 0，且说得出「已经是干净状态」 ──
  const cleanDir = fixture('handoff-clean', {
    'README.md': '# 项目\n\n## 安装\n\n装它。\n',
    'main.js': "console.log('hi')\n",
  })
  const j3 = handoffJson(cleanDir, '--verify')
  const v3 = handoff(cleanDir, '--verify')
  const s3 = handoff(cleanDir, '--scan')
  const cleanFixtureOk = v3.status === 0 && j3.clean === true && j3.findings === 0
    && /已经是干净状态/.test(s3.stdout ?? '')
  check(cleanFixtureOk, '干净项目：verify 退出 0、clean=true、scan 说「已经是干净状态」',
    `exit=${v3.status} clean=${j3.clean} findings=${j3.findings}`)
  report(cleanFixtureOk, '干净项目：判得过')

  // ── 4) 不干净 fixture：verify 退出 1，且列出的命中与实际一致 ──
  const j4 = handoffJson(dirty, '--verify')
  const v4 = handoff(dirty, '--verify')
  const listed = blockingOf(j4)
  const dirtyFixtureOk = v4.status === 1 && j4.clean === false && listed === j4.blocking
    && (v4.stdout ?? '').includes('不干净')
  check(dirtyFixtureOk, '不干净项目：verify 退出 1，列出的命中数与 blocking 一致',
    `exit=${v4.status} listed=${listed} blocking=${j4.blocking}`)
  report(dirtyFixtureOk, '不干净项目：拦得住')

  // ── 5) 报告里**不出现处置文字** ──
  // 处置是判断，它归协议管。脚本与协议各写一份，协议改了一句而脚本还在给旧答案，
  // 两边都没有检查盯得住。所以脚本只说「哪里有、是什么」。
  const noAction = every(j1.groups).every((f) => f.action === undefined)
  const textHasNoVerdict = !/规则搬进|删掉指针句子|必须留在项目里|改写成项目自己的做法/
    .test(handoff(dirty, '--scan').stdout ?? '')
  const actionOk = noAction && textHasNoVerdict
  check(actionOk, '报告里没有处置文字（处置归协议）',
    actionOk ? '' : (noAction ? '文字输出里出现了处置句' : 'finding 里还有 action 字段'))
  report(actionOk, '处置文字：不在脚本里')

  // ── 6) 悬空指针：指向本 skill、而目标项目里没有的路径 ──
  // 这一类的判据是**两份事实交叉比对**（本 skill 的文件树 + 目标项目的文件树），
  // 标识符那种「一份事实就够」的判据套不上，所以每个分支都得单独证伪。
  const dangle = fixture('handoff-dangle', {
    'AGENTS.md': [
      '# 项目',
      '',
      '发布规则见 `references/publish.md` 一节。',
      '专章见 `references/publish-<生态>.md`。',
      '插件见 `references/plugins/dsh.md`。',
      '',
      '```sh',
      '# 这里只是举例：references/publish.md',
      '```',
      '',
    ].join('\n'),
  })
  const j5 = handoffJson(dangle, '--scan')
  const d5 = j5.groups?.dangling ?? []
  const exact = pick(d5, 'AGENTS.md', 'dangling-rule')
  const wild = d5.find((f) => /publish-<生态>/.test(String(f.match)))
  // 精确形态：行号 3，指向 references/publish.md。
  const exactOk = exact !== undefined && exact.line === 3
    && exact.match === 'references/publish.md'
    && Array.isArray(exact.targets) && exact.targets.includes('references/publish.md')
  check(exactOk, '悬空指针：精确形态被检出，行号与指向都对',
    exact === undefined ? '没检出' : `${exact.match}@${exact.line}`)
  report(exactOk, '悬空指针：精确形态')
  // 通配形态：<生态> 展开成通配，匹配上那一族专章。
  const wildOk = wild !== undefined && wild.line === 4
    && (wild.targets ?? []).length > 1
    && (wild.targets ?? []).includes('references/publish-npm.md')
  check(wildOk, '悬空指针：尖括号通配形态被检出，且匹配到一族文件',
    wild === undefined ? '没检出' : (wild.targets ?? []).join('、'))
  report(wildOk, '悬空指针：通配形态')
  // 子目录形态：名字里带一层目录，探针不能在这里被截断——截断了就永远查不出来，
  // 而插件类项目恰恰是靠这一层指针引专章的。
  const sub = d5.find((f) => f.match === 'references/plugins/dsh.md')
  const subOk = sub !== undefined && sub.line === 5
    && (sub.targets ?? []).includes('references/plugins/dsh.md')
  check(subOk, '悬空指针：带子目录的指针能查出来（references/plugins/dsh.md）',
    sub === undefined ? '没检出' : `${sub.match}@${sub.line}`)
  report(subOk, '悬空指针：子目录形态')
  // 围栏里的那一处是举例说明，不是引用——不算。
  const fenceOk = d5.every((f) => f.line !== 7)
  check(fenceOk, '围栏代码块里的示例路径不算引用', `行号：${d5.map((f) => f.line).join('、')}`)
  report(fenceOk, '悬空指针：围栏内的示例不算')
  // 悬空指针计入 blocking：不搬规则就不算干净。
  const blockingOk = j5.blocking === blockingOf(j5) && j5.clean === false
  check(blockingOk, '悬空指针计入 blocking（不搬规则就不算干净）',
    `blocking=${j5.blocking} 悬空=${d5.length}`)
  report(blockingOk, '悬空指针：计入 blocking')

  // 反例：目标项目**自己就有**那个文件 → 不是悬空（它是自己项目的文档，不是本 skill 的）。
  const hasOwn = fixture('handoff-has-own', {
    'AGENTS.md': '# 项目\n\n见 `references/publish.md` 一节。\n',
    'references/publish.md': '# 本项目自己的发布说明\n',
  })
  const j6 = handoffJson(hasOwn, '--scan')
  const ownOk = (j6.groups?.dangling ?? []).length === 0
  check(ownOk, '目标项目自己就有那个文件 → 不报悬空',
    `报出 ${(j6.groups?.dangling ?? []).length} 条`)
  report(ownOk, '悬空指针：自己的文件不算')

  // ── 7) 同名不同物：文档里提到一个本 skill 也有、但项目自己没有的脚本名 ──
  // 机器分不出「那是项目自己的脚本」还是「那是本 skill 的脚本」，所以它**不计入**
  // 干净判定：计入的话，用户唯一的出路就是造个同名空文件骗过检查。
  const collide = fixture('handoff-collide', {
    'SKILL.md': '# 另一个 skill\n\n打包用 `node scripts/zip.mjs` 跑。\n',
  })
  const j7 = handoffJson(collide, '--scan')
  const c7 = pick(j7.groups?.dangling, 'SKILL.md', 'dangling-name-collision')
  const collideOk = c7 !== undefined && c7.blocks === false && c7.suspect === true
    && j7.clean === true && j7.blocking === 0
  check(collideOk, '同名不同物：标为疑似且不计入 blocking（不挡验收）',
    c7 === undefined ? '没报出来' : `blocks=${c7.blocks} blocking=${j7.blocking}`)
  report(collideOk, '同名不同物：不挡验收')

  // ── 8) 工作流里对本 skill 脚本的调用：处置与文档里那一类不同 ──
  // 引用出现在机器会照着跑的配置里 → 那条调用会真的被执行，脚本没了就是坏了。
  // 所以它与「同名不同物」分开，并且计入 blocking。
  //
  // 这里**手工写一个带悬空调用的工作流**，而不是拿 `templates/ci-release.yml` 当夹具：
  // 模板自己已经不含这种调用（模板就该落盘成能跑的东西，指向别人家的脚本是错的）。
  // 拿模板当夹具曾让这条用例在模板改对之后变成空测——它测的其实是「模板有没有那个 bug」，
  // 而不是「判据认不认得出这种情况」。
  const wfDir = fixture('handoff-workflow', {
    '.github/workflows/release.yml': [
      'name: release',
      'on:',
      '  push:',
      "    tags: ['v*']",
      'jobs:',
      '  release:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: notes',
      '        run: node scripts/release-notes.mjs "$TAG" notes.md',
      '',
    ].join('\n'),
  })
  const j8 = handoffJson(wfDir, '--scan')
  const w8 = (j8.groups?.dangling ?? []).filter((f) => f.kind === 'dangling-script-in-automation')
  const wfOk = w8.length > 0 && w8.every((f) => f.blocks === true)
    && w8.some((f) => f.match === 'scripts/release-notes.mjs')
  check(wfOk, '工作流里对本 skill 脚本的调用：单独一类，计入 blocking',
    `命中 ${w8.length} 条`)
  report(wfOk, '工作流里的脚本调用：单独一类')
  // 落盘的模板顶部注释块里有本 skill 的名字——验收的总判据是「全项目搜名字零命中」，
  // 而机器原来看不见它。同样用**自造的**夹具，不拿真模板当输入：真模板哪天改成
  // 不含名字，这条用例就会静默失去对象，而它要守的是判据本身。
  const nameDir = fixture('handoff-name-in-comment', {
    '.github/workflows/release.yml': [
      '# project-forge 发布自动化骨架：打标签即写发布说明。',
      'name: release',
      'on:',
      '  push:',
      "    tags: ['v*']",
      'jobs:',
      '  release:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo ok',
      '',
    ].join('\n'),
  })
  const jName = handoffJson(nameDir, '--scan')
  const nameHit = pick(jName.groups?.markers, '.github/workflows/release.yml', 'skill-name-in-comment')
  const nameOk = nameHit !== undefined && nameHit.blocks === true
  check(nameOk, '落盘模板的注释块里出现本 skill 的名字 → 被检出',
    nameHit === undefined ? '没检出' : `第 ${nameHit.line} 行`)
  report(nameOk, '模板注释块：被检出')

  // ── 9) 临时文件：只有本 skill 自己的写法是确定痕迹 ──
  // 别的工具也留 `build.tmp-4242` 这种形状的临时文件，那不是本 skill 留下的，
  // 不该由本 skill 的报告说「删掉」，更不该因此挡住验收。
  const tmpDir = fixture('handoff-tmp', {
    'AGENTS.md.tmp-123': '半成品\n',
    'build.tmp-4242': '别家的缓存\n',
  })
  const j9 = handoffJson(tmpDir, '--scan')
  const ownTmp = pick(j9.groups?.residue, 'AGENTS.md.tmp-123', 'tmp-file')
  const otherTmp = pick(j9.groups?.residue, 'build.tmp-4242', 'tmp-file-suspect')
  const tmpOk = ownTmp?.blocks === true
    && otherTmp?.blocks === false && otherTmp?.suspect === true
    && j9.blocking === 1
  check(tmpOk, '临时文件：只有 AGENTS.md.tmp-<数字> 是确定痕迹，其余疑似且不挡验收',
    `own=${ownTmp?.blocks} other=${otherTmp?.blocks} blocking=${j9.blocking}`)
  report(tmpOk, '临时文件：分清是谁的')

  // ── 10) 发布说明草稿：可排除，且不挡验收 ──
  // 草稿里的 needs-summary 标记不单独报：文件名已经认出它是草稿了，再报一次就是
  // 把同一个文件数两遍，而两处的说法还不一样。
  const draft = fixture('handoff-draft', {
    'v0.9.1-notes.md': '# 草稿\n\n<!-- pf:needs-summary 缺总述 -->\n',
  })
  const j10 = handoffJson(draft, '--scan')
  const draftHits = every(j10.groups).filter((f) => f.path === 'v0.9.1-notes.md')
  const draftOk = draftHits.length === 1 && draftHits[0].kind === 'notes-draft'
    && draftHits[0].blocks === false && j10.blocking === 0 && j10.clean === true
  check(draftOk, '发布说明草稿：只报一次、不计入 blocking（用户可以决定保留）',
    `命中 ${draftHits.length} 次：${draftHits.map((f) => f.kind).join('、')}`)
  report(draftOk, '发布说明草稿：可排除')

  // ── 11) 注入中断的四种控制标记：各报各的名字 ──
  const ctrl = fixture('handoff-control', {
    'AGENTS.md': [
      '<!-- pf:if has-x -->',
      '<!-- pf:endif -->',
      '<!-- pf:scaffold -->',
      '<!-- pf:endscaffold -->',
      '',
    ].join('\n'),
  })
  const j11 = handoffJson(ctrl, '--scan')
  const c11 = (j11.groups?.markers ?? []).filter((f) => f.kind === 'inject-control')
  const ctrlOk = c11.length === 4
    && ['pf:if', 'pf:endif', 'pf:scaffold', 'pf:endscaffold']
      .every((n) => c11.some((f) => f.literal === n))
  check(ctrlOk, '四种控制标记各报各的名字（处置不同，不能报成一个串）',
    c11.map((f) => f.literal).join('、'))
  report(ctrlOk, '控制标记：各报各的')

  // ── 12) 目标给成文件：结论不能是肯定句 ──
  // 「没扫到」被读成「扫过了、很干净」是这个工具最不该有的误读，而零命中 + 一句
  // 「已经是干净状态」正是它的长相。
  const oneFile = handoff(join(cleanDir, 'README.md'), '--scan')
  const oneFileOk = /没扫到全部/.test(oneFile.stdout ?? '')
    && !/已经是干净状态/.test(oneFile.stdout ?? '')
  check(oneFileOk, '目标给成文件时，结论不是肯定句',
    (oneFile.stdout ?? '').split('\n').filter((l) => l.includes('结论')).join(' / '))
  report(oneFileOk, '只扫一部分：不肯定')
}

// 这一组守的是「痕迹判定从猜变成查」。
//
// 在此之前，判断「这段是不是本 skill 写的」靠形状——而形状必然两头都错：
// Vue 的 `{{ title }}` 被误判（照做就是删使用者的代码），`<安装命令>` 被漏判
// （空壳工作流报成干净）。账本把「来历」变成记录：落盘时写下字节哈希，此后只比对。
group('[51c] 账本：痕迹判定查哈希，不再猜形状')
{
  const dir = fixture('ledger-basic', {
    'package.json': '{"name":"led","version":"1.0.0"}\n',
  })
  compose(dir)

  // 正例一：落盘之后账本必须存在，且记了内核区与受管节。
  const ledgerFile = join(dir, '.project-forge', 'ledger.json')
  check(existsSync(ledgerFile), '落盘后账本存在（此后判定有依据，不用猜）')
  report(existsSync(ledgerFile), '账本：落盘即记账')

  let led = {}
  if (existsSync(ledgerFile)) led = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  const ids = Object.keys(led.segments?.['AGENTS.md'] ?? {})
  check(ids.includes('kernel'), '内核区按字节区间单独记一条', ids.slice(0, 4).join('、'))
  report(ids.includes('kernel'), '账本：内核区成段记')
  check(ids.some((i) => i.startsWith('section:')), '受管节按节分别记（整份记会让使用者改一个字就全失效）')
  report(ids.some((i) => i.startsWith('section:')), '账本：受管节分记')

  // 正例二：handoff 用账本确认「这一段是我写的」。
  const scanOut = handoffJson(dir, '--scan')
  const mine = (scanOut.groups?.ledger ?? []).filter((f) => f.kind === 'ledger-mine')
  check(mine.length > 0, '交棒时账本确认识别出自己的片段（这是「查」出来的，不是猜的）',
    `ledger-mine ${mine.length} 条`)
  report(mine.length > 0, '账本：确认自己的片段')

  // 正例三：使用者改过的节必须报「改过」，不能报「是我的」——
  // 报成「是我的」意味着撤除时会把使用者改过的内容一起删掉。
  const agents = join(dir, 'AGENTS.md')
  const edited = readFileSync(agents, 'utf8')
    .replace(/## 硬性规范(\r?\n)/, '## 硬性规范$1\n使用者补充的一行。\n')
  writeFileSync(agents, edited, 'utf8')
  const editedScan = handoffJson(dir, '--scan')
  const editedHits = (editedScan.groups?.ledger ?? []).filter((f) => f.kind === 'ledger-edited')
  check(editedHits.length > 0, '使用者改过的节报「改过」（撤除时会停下来问人，不会删掉他的字）',
    `ledger-edited ${editedHits.length} 条`)
  report(editedHits.length > 0, '账本：改过的一节被判为改过')

  // 正例四：使用者删掉的节报「不见了」，不能当成「没写过」重新插一遍。
  const gone = edited.replace(/(?:\r?\n)## 文档同步[\s\S]*?(?=\r?\n## |$)/, '')
  writeFileSync(agents, gone, 'utf8')
  const goneScan = handoffJson(dir, '--scan')
  const goneHits = (goneScan.groups?.ledger ?? []).filter((f) => f.kind === 'ledger-gone')
  check(goneHits.length > 0, '使用者删掉的节报「不见了」（不自动补回去，否则他的删除被撤销）',
    `ledger-gone ${goneHits.length} 条`)
  report(goneHits.length > 0, '账本：删掉的节报不见了')

  // ── 勘察不许联网 ──
  //
  // 曾经默认跑 `git ls-remote` 探远端可达性。网络受限的机器上一次要等 **21 秒**
  // （连接超时），而勘察本身不到一秒——一件「偶尔想知道」的事变成了每次调用都要付的
  // 代价，比它换来的信息贵得多。
  //
  // 判据是「不联网」，所以断言看的是**结果**：默认调用里网络那一档必须是「没有探测」，
  // 且整个 JSON 里不能出现 reachable/unreachable。
  {
    const dir = fixture('survey-no-network', {
      'package.json': '{"name":"n","version":"1.0.0"}\n',
    })
    if (HAS_GIT) {
      gitIn(dir, 'init')
      gitIn(dir, 'remote', 'add', 'origin', 'https://example.invalid/x.git')
    }
    const s = survey(dir)
    const net = s.git?.auth?.network
    check(net === 'undetermined' || net === 'n/a',
      '默认勘察不联网：网络那一档是「未探测」，不是去连一次', `得到 ${net}`)
    report(net === 'undetermined' || net === 'n/a', '勘察：默认不联网')
    check(String(s.git?.auth?.networkReason ?? '').includes('没有探测'),
      '并且说清「没有探测」，不让人以为探测过且通了',
      String(s.git?.auth?.networkReason ?? ''))
    report(String(s.git?.auth?.networkReason ?? '').includes('没有探测'), '勘察：说明没探测')
  }

  // 反例：完全没有账本的项目，不能因此误报。
  // 账本缺失是正常状态（老项目、被清理过），此时只应退化成「什么都不认」。
  const noLedger = fixture('ledger-absent', {
    'package.json': '{"name":"nl","version":"1.0.0"}\n',
    'AGENTS.md': '# 我自己写的\n\n## 构建与验证\n\n跑 make check。\n',
  })
  const nlScan = handoffJson(noLedger, '--scan')
  const nlHits = nlScan.groups?.ledger ?? []
  check(nlHits.length === 0, '反例：没有账本时不虚报任何账本结论', JSON.stringify(nlHits).slice(0, 120))
  report(nlHits.length === 0, '反例：无账本不虚报')

  // ── verify 的判决有三档，不是两档 ──
  //
  // 第三档（退出码 3）是「判不了」：扫描没覆盖全部时，「没发现」不等于「没有」。
  // 没有它，任何把 --verify 当关卡的地方在扫描被截断、有超大文件被跳过、或目录读不出时
  // 都会拿到 0，也就是把「没扫到」读成「扫过且干净」。
  {
    const cleanDir = fixture('verify-clean', {
      'package.json': '{"name":"v","version":"1.0.0"}\n',
    })
    const rClean = handoff(cleanDir, '--verify')
    check(rClean.status === 0, '干净且扫全时退出 0', `实际 ${rClean.status}`)
    report(rClean.status === 0, 'verify 三档：干净=0')

    // 造一个超过体积上限的文件：它会被跳过，于是扫描不完整。
    const gapDir = fixture('verify-gap', {
      'package.json': '{"name":"g","version":"1.0.0"}\n',
    })
    writeFileSync(join(gapDir, 'huge.txt'), 'x'.repeat(2300000), 'utf8')
    const rGap = handoff(gapDir, '--verify')
    check(rGap.status === 3, '有文件没扫到时退出 3（判不了，不是干净）', `实际 ${rGap.status}`)
    report(rGap.status === 3, 'verify 三档：没扫全=3')
    check(/判不了/.test(String(rGap.stdout ?? '')),
      '「判不了」在文字里也说清，不只靠退出码')
    report(/判不了/.test(String(rGap.stdout ?? '')), 'verify 三档：文字也说清')

    const dirtyDir = fixture('verify-dirty', {
      'package.json': '{"name":"d","version":"1.0.0"}\n',
      'AGENTS.md': '<!-- project-forge:kernel:start -->\n',
    })
    const rDirty = handoff(dirtyDir, '--verify')
    check(rDirty.status === 1, '有痕迹时退出 1（不被「扫描不完整」那一档吞掉）', `实际 ${rDirty.status}`)
    report(rDirty.status === 1, 'verify 三档：不干净=1')
  }
}

// ── [52] 结构守卫：依赖图无环、判据只有一份、临时文件三态 ──────────────────────
group('[52] 结构守卫：依赖图无环、判据只有一份、临时文件三态')
{
  // ── 1) 依赖图不能有环 ──
  // 两个模块互相 import 在 ESM 里不会立刻出事（函数声明在模块实例化阶段就完成
  // 初始化），所以环能一路绿灯地活下来——直到有人把一个 const 提到模块顶层，
  // 那时才开始踩时序差（TDZ）。而「无环」这件事没有任何症状会提醒人。
  // 所以把它变成常驻断言，而不是靠人记得。
  const scriptFiles = []
  const collectScripts = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
      if (e.isDirectory()) { collectScripts(join(dir, e.name)); continue }
      if (e.name.endsWith('.mjs')) scriptFiles.push(join(dir, e.name))
    }
  }
  collectScripts(join(SKILL_ROOT, 'scripts'))
  const edges = new Map()
  for (const f of scriptFiles) {
    // 说明符的提取复用 preflight 那一份实现，不在这里另写一个正则——两处各判一次
    // 同一类东西，迟早给出两个答案。
    const deps = moduleSpecifiers(readFileSync(f, 'utf8'))
      .filter((s) => s.startsWith('.'))
      .map((s) => resolve(dirname(f), s))
      .filter((t) => scriptFiles.includes(t))
    edges.set(f, deps)
  }
  const visiting = new Set()
  const finished = new Set()
  const cycles = []
  const visit = (f, stack) => {
    if (finished.has(f)) return
    if (visiting.has(f)) {
      cycles.push([...stack, f].map((p) => basename(p)).join(' → '))
      return
    }
    visiting.add(f)
    for (const d of edges.get(f) ?? []) visit(d, [...stack, f])
    visiting.delete(f)
    finished.add(f)
  }
  for (const f of scriptFiles) visit(f, [])
  check(cycles.length === 0,
    'scripts/ 的依赖图无环——环在 ESM 里能一路绿灯，直到有人把 const 提到模块顶层才炸',
    cycles.join('；'))
  report(cycles.length === 0, '依赖图：无环')

  // ── 2) 共享判据只能有一份实现 ──
  // 「围栏扫描」这一族判据曾经同时住在 survey.mjs 与 sync-toc.mjs 里，而 survey 的
  // 注释明写「实现也只有一个来源」——**注释说一份、代码两份**，是最坏的一种漂：
  // 它看上去是对的。注释靠不住，断言才靠得住。
  const sharedJudgements = ['scanLines', 'fencedSpans', 'markerPositions', 'isMainModule']
  const dupes = []
  for (const name of sharedJudgements) {
    const defRe = new RegExp(`export function ${name}\\s*\\(`)
    const hits = scriptFiles.filter((f) => defRe.test(readFileSync(f, 'utf8')))
    if (hits.length !== 1) {
      dupes.push(`${name}×${hits.length}（${hits.map((f) => basename(f)).join('、') || '无'}）`)
    }
  }
  check(dupes.length === 0, '共享判据在全仓只定义一次', dupes.join('；'))
  report(dupes.length === 0, '共享判据：各一份')

  // ── 2b) 共享判据不许被「另写一遍」 ──
  //
  // 上面那条只认 `export function <名字>`，抓得住「同名导出两份」，**抓不住
  // 「不 import、自己手写一个内联循环」**——而那正是实际发生过的事：`preflight.mjs`
  // 与 `compose-agents.mjs` 各写了一个 `inFence` 状态机，只比围栏符首字符、不校验
  // 闭合长度。守卫的存在反而给了「已经统一」的错觉。
  //
  // 判据改成「专属标识符只许出现在权威实现里」：`inFence` 这种名字不会自然出现。
  const RESTRICTED = {
    inFence: 'survey.mjs',           // 围栏状态机
    fenceEvent: 'survey.mjs',        // 同上
    fencedSpans: 'survey.mjs',       // 围栏区间
    scanLines: 'survey.mjs',         // 逐行扫描
    markerPositions: 'survey.mjs',   // 标记在围栏外的位置
  }
  const leaks = []
  for (const file of scriptFiles) {
    const base = basename(file)
    const text = readFileSync(file, 'utf8')
    for (const [token, owner] of Object.entries(RESTRICTED)) {
      if (base === owner) continue
      // 只看**定义或赋值**，不看 import 与注释：调用权威实现是应该的。
      const re = new RegExp(`^\\s*(?:let|const|var)\\s+${token}\\b`, 'm')
      const reFn = new RegExp(`^\\s*function\\s+${token}\\b`, 'm')
      if (re.test(text) || reFn.test(text)) leaks.push(`${base} 自己定义了 ${token}`)
    }
  }
  check(leaks.length === 0, '围栏扫描只在 survey.mjs 里实现，别处只能 import', leaks.join('；'))
  report(leaks.length === 0, '共享判据：不许另写一遍')

  // ── 3) 临时文件的归属三态 ──
  // 「同前缀全删」曾把使用者自己的备份、和另一个正在运行的进程手里的临时文件一起
  // 删掉：前者是毁掉别人的东西，后者会让那次运行的改名失败。判据现在分三态——
  // 已死进程留下的清掉、活着的留着、使用者自己的留着，而且留下的要说得出原因。
  const tmpDir = fixture('tmp-ownership', {})
  const target = join(tmpDir, 'AGENTS.md')
  writeFileSync(target, 'x', 'utf8')
  // 一个真的跑过又退出的进程，它的进程号此刻已不在了——这比随手写一个数字可靠。
  const deadPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', windowsHide: true }).pid
  const own = `${basename(target)}.tmp-backup`
  const alive = `${basename(target)}.tmp-${process.pid}`
  const dead = `${basename(target)}.tmp-${deadPid}`
  writeFileSync(join(tmpDir, own), 'x', 'utf8')
  writeFileSync(join(tmpDir, alive), 'x', 'utf8')
  writeFileSync(join(tmpDir, dead), 'x', 'utf8')
  // 进程刚退出时系统可能还没回收它，等一下再问「它还活着吗」。
  for (let i = 0; i < 50 && processAlive(deadPid); i += 1) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},30)'], { windowsHide: true })
  }
  const cleared = clearStaleTemps(target)
  const tmpOk = cleared.removed.includes(dead)
    && cleared.kept.some((k) => k.name === alive)
    && cleared.kept.some((k) => k.name === own)
    && existsSync(join(tmpDir, alive))
    && existsSync(join(tmpDir, own))
    && !existsSync(join(tmpDir, dead))
  check(tmpOk,
    '临时文件按归属分三态：已死进程的清掉，活着的与使用者自己的留下并说得出原因',
    `removed=${cleared.removed.join('、') || '无'}；kept=${cleared.kept.map((k) => k.name).join('、') || '无'}`)
  report(tmpOk, '临时文件：三态分明')
}

// ── [53] 落盘模板自身：不能带着只有本 skill 才有的可执行调用 ───────────────────

group('[53] 落盘模板自身不得含悬空调用：模板落进别的项目后要能真的跑起来')
{
  // [48b] 判的是「模板里不许有本 skill 的路径」。这一组补另一半：**可执行上下文**。
  // 一个模板即使路径写法正确，只要 `run:` 下调用了一本项目没有的脚本，落盘后就是
  // 发版当天才红的那种失败——而它比读不到更贵。
  const ciRelease = join(SKILL_ROOT, 'templates', 'ci-release.yml')
  const text = readFileSync(ciRelease, 'utf8')

  // 逐行找出所有非注释的 `node <路径>` 调用。注释里的说明可以提，`run:` 下真的会被执行。
  const executableCalls = text.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /^\s*node\s+\S+/.test(line))
    .filter(({ line }) => !/^\s*#/.test(line))

  const ok = executableCalls.length === 0
  check(ok, 'templates/ci-release.yml 里没有可直接执行的 node 调用（都要先换成项目自己的实现）',
    executableCalls.map(({ line, no }) => `L${no}: ${line.trim()}`).join(' | '))
  report(ok, '落盘模板：无可执行的本 skill 调用')

  // 反向：占位必须留下来，否则落盘的人会以为那一段已经写好了。
  const hasPlaceholder = /<[^<>\n]{2,60}>/.test(text.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n'))
  check(hasPlaceholder, '落盘前后要替换的位置仍留着显式占位（不能看起来像已经写好）')
  report(hasPlaceholder, '落盘模板：占位仍在')
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

markTime()
cleanupFixtures()

const envNote = HAS_GIT ? '' : '（本机没有 git，已跳过依赖它的分组）'
const stale = staleFixtureDirs()
const staleNote = stale.length > 0
  ? `；另有 ${stale.length} 个上次遗留的临时 fixture 目录未清（${stale.slice(0, 3).join('、')}${stale.length > 3 ? '…' : ''}）`
  : ''
process.stdout.write(`\n行为自检：${passed} 项通过，${failed} 项失败`
  + `${skipped > 0 ? `，${skipped} 组跳过` : ''}${envNote}${staleNote}\n`)
// 最慢的几组直接列出来：这份自检要跑几分钟，而下一次想让它更快的人需要知道**花在哪儿**
// ——没有这张表，优化只能靠猜。
const slowest = [...groupTimes].sort((a, b) => b.ms - a.ms).slice(0, 5).filter((g) => g.ms >= 1000)
if (slowest.length > 0) {
  process.stdout.write('\n最慢的几组（毫秒）：\n')
  for (const g of slowest) process.stdout.write(`  ${String(g.ms).padStart(7)}  ${g.title}\n`)
}
if (skips.length > 0) {
  process.stdout.write('\n跳过（环境不具备，不是缺陷）：\n')
  for (const s of skips) process.stdout.write(`  - ${s}\n`)
}
if (failed > 0) {
  process.stdout.write('\n失败项：\n')
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
}
process.exitCode = failed === 0 ? 0 : 1
