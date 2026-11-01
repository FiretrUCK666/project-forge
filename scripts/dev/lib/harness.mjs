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
  evalFreshnessMarker, FRESHNESS_STALE_DAYS, listRepoFiles, compareHostMarker, hostDateBatchStatus, freshnessSectionBody, hasActionableSources, referencedPaths, moduleSpecifiers, externalModules, releaseTokenSpellings, hostMismatchMessage, } from '../preflight.mjs'
import {
  authorMarkers, kindVocabulary } from '../../survey.mjs'
import { isMainModule, parseGitHubRepo, skillVersion, skillSource, parseMarkerKeys, normVersion, repoPath, repoRelation, readFileMap } from '../../lib/text.mjs'
import { needsSummary } from '../../lib/protocol.mjs'
import { UPSTREAM, STALE_CHECK_MS, apiEndpoint, routesFor } from '../../update.mjs'
import { clearStaleTemps } from '../../lib/fs-atomic.mjs'
import { badgeVerdict, tierSecrets, unhandledRiskKeys, outsideKernel } from '../../review.mjs'
import { readZip, stripCommonPrefix } from '../../zip.mjs'

export const HERE = dirname(fileURLToPath(import.meta.url))
// harness 住在 scripts/dev/lib/，比原 selftest.mjs 深一层，所以上溯三级
export const SKILL_ROOT = resolve(HERE, '..', '..', '..')
export const SCRIPTS_DIR = join(HERE, '..', '..')
export const FIXTURE_PREFIX = 'project-forge-selftest-'
// 目录名 = 前缀 + pid + 随机后缀。**随机后缀不是装饰**：进程号会被系统回收，两次运行
// 完全可能拿到同一个号，而那次「同名」的后果是后一次把自己的 fixture 建进前一次正在用的
// 目录里——清理时 rmSync 会把别人正在读的文件一起删掉。实测撞过一次：行为自检跑到一半
// 报 `ENOENT …CONTRIBUTING.md`，被前置检查记成失败，看起来像代码坏了。
export const ROOT = process.env.PF_FIXTURE_ROOT
  ?? join(tmpdir(), `${FIXTURE_PREFIX}${process.pid}-${randomBytes(3).toString('hex')}`)

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
export function cleanupFixtures() {
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
export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH = 没有这个进程；其余（例如 EPERM）说明进程存在，只是问不动它。
    return error?.code !== 'ESRCH'
  }
}

export function staleFixtureDirs() {
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
export const FAKE_GH_TOKEN = `ghp_${'a'.repeat(36)}`
export const FAKE_NPM_TOKEN = `npm_${'b'.repeat(36)}`
export const FAKE_AWS_KEY = `AKIA${'C'.repeat(16)}`
// 锚点用例里要放一个 emoji（验证它不进锚点）。emoji 一律**运行时拼出**：
// 源码里留一个图形字符会被 preflight 的「禁 emoji」判红——那是项目的硬性规范。
export const FAKE_EMOJI = String.fromCodePoint(0x1f680)

/**
 * 环境能力探测。
 *
 * 「有没有 git」直接决定哪些断言可以跑：没有 git 时，`git init` 不起作用，涉及仓库
 * 状态的断言会全部失败——**那是环境缺失，不是代码缺陷**。把它们报成失败会误导人，
 * 也会让人开始怀疑一个其实正确的实现。所以按能力分组跳过，并说明跳过了什么。
 */
export const HAS_GIT = (() => {
  const r = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
  return r.error === undefined && r.status === 0
})()

export let passed = 0
export let failed = 0
export let skipped = 0
export const failures = []
export const skips = []

export function check(ok, label, detail) {
  if (ok) { passed += 1; return }
  failed += 1
  failures.push(`${label}${detail === undefined ? '' : `  —— ${detail}`}`)
}

/** 整组跳过（环境不具备），与「断言失败」严格区分。 */
export function skipGroup(title, why) {
  skipped += 1
  skips.push(`${title}（${why}）`)
  process.stdout.write(`\n${title}\n  跳过：${why}\n`)
}

export function group(title) {
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
export let lastGroupTitle = '（开场）'
export let lastGroupAt = Date.now()
export const groupTimes = []
export function markTime(next = '（收尾）') {
  const now = Date.now()
  groupTimes.push({ title: lastGroupTitle, ms: now - lastGroupAt })
  lastGroupTitle = next
  lastGroupAt = now
}

export function report(ok, label) {
  process.stdout.write(`  ${ok ? '通过' : '失败'}  ${label}\n`)
}

/** 造一个 fixture 目录。files 的键是相对路径。 */
export function fixture(name, files) {
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
export const observedKinds = new Set()

export function survey(dir, ...extra) {
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
export function compose(dir, ...extra) {
  const r = composeExpectingFailure(dir, ...extra)
  if (r.status !== 0) {
    const why = `${r.stderr ?? ''}${r.stdout ?? ''}`.trim().split('\n')
      .filter((l) => l.trim() !== '').slice(0, 4).join(' / ')
    throw new Error(`compose-agents.mjs ${extra.join(' ') || '(无参数)'} 以退出码 ${r.status} 结束：${why}`)
  }
  return r
}

/** 断言退出码本身的场景：返回原始结果，退出码由用例自己判。 */
export function composeExpectingFailure(dir, ...extra) {
  return spawnSync(process.execPath, [join(SCRIPTS_DIR, 'compose-agents.mjs'), dir, ...extra],
    { encoding: 'utf8' })
}

/** 把一棵目录树整份复制到 dest（跳过 skip 里的名字）。端到端跑 preflight 时用。 */
export function copyTree(src, dest, skip = new Set()) {
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
export function gitIn(dir, ...args) {
  return spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true })
}

/** 在某个目录里跑真实的 preflight.mjs——它按脚本自身位置推导检查对象。 */
export function preflightIn(dir) {
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
export const SELFTEST_STUB = [
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
export const SELFTEST_MUTE = [
  '#!/usr/bin/env node',
  '// 哑弹替身：刻意什么都不做，退出码 0。',
  '// 它模拟「行为自检被摘掉」：只看出身码的判据会把整套行为断言凭空消失读成全绿。',
  `process.stderr.write('MUTE-STUB-MARKER: 这一行是诊断用的\\n')`,
  'process.exitCode = 0',
  `// 填充到长度阈值以上，避免先被「内容异常短」拦下：` + 'x'.repeat(200),
  '',
].join('\n')

/** 造一棵可独立跑 preflight 的 skill 副本（目录名必须是 project-forge，否则 name 对账必红）。 */
export function skillClone(name, { selftest = SELFTEST_STUB } = {}) {
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

// ── 分片共用的小工具 ────────────────────────────────────────────────────────
//
// 这几个原先定义在组与组之间。分片之后，定义它的组和使用它的组可能不在同一个
// 文件里，留在原处必然报 ReferenceError，所以上移到共享层。

/** 读本 skill 自己的某个文件（测试断言常要对照原文）。 */
export const readSkill = (rel) => readFileSync(join(SKILL_ROOT, rel), 'utf8')

/** 跑交棒勘察（原始输出）。 */
export function handoff(dir, ...a) {
  return spawnSync(process.execPath, [join(SCRIPTS_DIR, 'handoff.mjs'), dir, ...a], { encoding: 'utf8' })
}

/** 跑交棒勘察并要求 JSON 输出。退出码 0 与 1 都算正常结果：0 = 干净，1 = 不干净。 */
export function handoffJson(dir, ...a) {
  const r = handoff(dir, '--json', ...a)
  if (r.status !== 0 && r.status !== 1) return { error: (r.stderr ?? '').slice(0, 300) }
  try {
    return JSON.parse((r.stdout ?? '').replace(/^﻿/, ''))
  } catch (error) {
    return { error: `输出不是合法 JSON：${error.message}` }
  }
}
