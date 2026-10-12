#!/usr/bin/env node
/**
 * update.mjs —— 让这个 skill 的副本保持最新
 *
 * 为什么需要它：这个 skill 靠克隆或下载分发，不在任何包管理器里。没有这个脚本时，
 * 「有没有新版」只能靠人去发布页看——那是一条记性依赖的规则，而记性依赖的规则迟早
 * 失效：使用者会一直跑着一年前那份，而且没有任何迹象提示他。
 *
 * 判据是**这个副本有没有本地工作**，不是「它装在哪」：
 *   - 没有版本历史（下载的压缩包）      → 无法自更新，如实说明；
 *   - 有历史但有本地改动、领先上游、
 *     不在分支上、或没有上游           → 一概不碰，只报告；
 *   - 干净且能快进                      → 快进更新。
 *
 * 这样分的好处是**不需要知道「哪个地址才算正本」**：只要这个副本没有本地工作，
 * 快进就是安全的；有本地工作时，无论它指向正本还是别人的 fork，都一概不动。
 * 于是「贡献者的副本被自动合并了上游」这种事从结构上不会发生。
 *
 * 节流：默认 24 小时内只查一次（查一次要联网）。状态写在系统临时目录里，按副本路径
 * 分开——同一台机器上装了几份副本时，一份的检查不会替另一份做决定。
 *
 * 用法：
 *   node scripts/update.mjs [--quiet] [--check]
 *
 *   --quiet   只在「真的更新了」或「更新失败」时输出（skill 自己在任务开始时用这个）
 *   --check   只报告不更新，且不受节流限制（人主动问的时候用）
 *
 * 退出码：0 = 无事或已更新；1 = 尝试更新但失败；2 = 用法错误。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { skillVersion } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

/** 两次联网检查之间的最短间隔。查一次要一次网络往返，按每次任务都查就是白做。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 单次网络动作的上限。卡住的 git 会把整个任务拖住，宁可报「这次没核对成」。 */
const NETWORK_TIMEOUT_MS = 60 * 1000

/** 节流状态按副本路径分开：一份副本的检查结果不能替另一份做决定。 */
const STAMP_PATH = join(tmpdir(),
  `project-forge-update-${createHash('sha1').update(SKILL_ROOT).digest('hex').slice(0, 12)}.json`)

function usage() {
  return [
    '用法：node scripts/update.mjs [--quiet] [--check]',
    '',
    '  检查这个 skill 的副本有没有新版，能安全更新时快进更新它。',
    '  判据是「这个副本有没有本地工作」：有本地改动或未推送提交时一概不碰。',
    '',
    '  --quiet   只在「真的更新了」或「更新失败」时输出',
    '  --check   只报告不更新，且不受 24 小时节流限制',
    '',
  ].join('\n')
}

/**
 * 跑一条 git 命令。
 *
 * 三处细节都是为了「不让它把任务挂住或静默失败」：关掉终端凭据询问（没有交互终端时
 * git 会一直等），设超时（网络卡住时不会无限等），失败一律返回 ok=false 交给调用方
 * 分情况报告——**读不到与读到空必须可区分**。
 */
function git(args, { timeout = NETWORK_TIMEOUT_MS } = {}) {
  const r = spawnSync('git', args, {
    cwd: SKILL_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    timeout,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  })
  if (r.error !== undefined) return { ok: false, out: '' }
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() }
}

function localVersion() {
  const p = join(SKILL_ROOT, 'SKILL.md')
  if (!existsSync(p)) return undefined
  return skillVersion(readFileSync(p, 'utf8'))
}

/**
 * 这个副本的事实。每一条读不到就是「这项事实不存在」——按它分情况，不猜。
 *
 * `hasHistory` 为假 = 这是一份没有版本历史的副本（下载的压缩包，或直接复制过来的
 * 目录）。它与「有历史」是两种不同的处境，报告内容也不同。
 */
function readFacts() {
  const inside = git(['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.out !== 'true') return { hasHistory: false, version: localVersion() }
  const branch = git(['symbolic-ref', '--short', '-q', 'HEAD'])
  const upstream = branch.ok
    ? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    : { ok: false, out: '' }
  const dirty = git(['status', '--porcelain', '--untracked-files=no'])
  return {
    hasHistory: true,
    version: localVersion(),
    branch: branch.ok ? branch.out : undefined,
    upstream: upstream.ok ? upstream.out : undefined,
    // 只看已跟踪文件的改动：未跟踪的新文件不影响快进（git 自己会保护它们）。
    modified: dirty.ok ? dirty.out !== '' : undefined,
  }
}

/** 读取节流状态。读不到或坏了都当成「没查过」——多查一次无害，漏查才有害。 */
function lastCheckAt() {
  try {
    const raw = JSON.parse(readFileSync(STAMP_PATH, 'utf8'))
    const t = Number(raw?.checkedAt)
    return Number.isFinite(t) ? t : 0
  } catch {
    return 0
  }
}

function rememberCheck() {
  try {
    writeFileSync(STAMP_PATH, `${JSON.stringify({ checkedAt: Date.now() })}\n`, 'utf8')
  } catch {
    // 写不进去只是失去节流，不影响正确性：下次再查一遍就是了。
  }
}

/**
 * 输出。
 *
 * quiet 模式（skill 在每次任务开始时用的那个）只放行两类：**真的更新了**与**更新失败**。
 * 其余情况（已是最新、有本地改动、这次没联网）对使用者没有可动作的信息，而每次任务
 * 都念一遍的结果是让人学会忽略这一行——那时它真正要说的话也一起被忽略了。
 * 想看全部状态就加 `--check`。
 */
function report(lines, { quiet, always = false } = {}) {
  if (quiet && !always) return
  const text = lines.filter((l) => l !== undefined).join('\n')
  if (text !== '') process.stdout.write(`${text}\n`)
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage()); return 0 }
  const unknown = argv.filter((a) => a !== '--quiet' && a !== '--check')
  if (unknown.length > 0) {
    process.stderr.write(`错误：未知参数 ${unknown.join(' ')}\n\n${usage()}`)
    return 2
  }
  const checkOnly = argv.includes('--check')
  // --check 是人主动问的，它要看到全部状态；与 --quiet 同时给时以 --check 为准。
  const quiet = argv.includes('--quiet') && !checkOnly

  const facts = readFacts()
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version

  // 没有版本历史：这个副本无法自己核对新版，如实说明——不假装查过了。
  if (!facts.hasHistory) {
    report([
      `project-forge ${tag}：这个副本没有版本历史，无法自动核对新版。`,
      '  更新方式见 README 的「更新」一节（下载新版覆盖，或改用克隆安装）。',
    ], { quiet })
    return 0
  }

  // 有本地工作：一概不碰。这不是错误，是这类副本的正常状态。
  if (facts.branch === undefined || facts.upstream === undefined) {
    report([`project-forge ${tag}：不在分支上或没有上游，跳过更新。`], { quiet })
    return 0
  }
  if (facts.modified === undefined) {
    report([`project-forge ${tag}：读不到工作区状态，跳过更新（不猜）。`], { quiet })
    return 0
  }
  if (facts.modified) {
    report([`project-forge ${tag}：这个副本有未提交的改动，跳过更新。`], { quiet })
    return 0
  }

  if (!checkOnly && Date.now() - lastCheckAt() < CHECK_INTERVAL_MS) return 0

  const fetched = git(['fetch', '--quiet'])
  if (!fetched.ok) {
    // 「没比」与「比过且一致」必须可区分：网络不通时不能读成「已是最新」。
    // 仍然记下这次时间，否则离线时每次任务都会重试并重复报同一句话。
    rememberCheck()
    report([`project-forge ${tag}：这次没能联网核对（不是「已是最新」）。`], { quiet })
    return 0
  }
  rememberCheck()

  const counts = git(['rev-list', '--left-right', '--count', `${facts.upstream}...HEAD`])
  if (!counts.ok) {
    report([`project-forge ${tag}：读不到与上游的差距，跳过更新（不猜）。`], { quiet })
    return 0
  }
  const [behindText, aheadText] = counts.out.split(/\s+/)
  const behind = Number.parseInt(behindText ?? '', 10)
  const ahead = Number.parseInt(aheadText ?? '', 10)
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    report([`project-forge ${tag}：上游差距读不出来，跳过更新（不猜）。`], { quiet })
    return 0
  }
  if (ahead > 0) {
    report([`project-forge ${tag}：本地有 ${ahead} 个未推送的提交，跳过更新。`], { quiet })
    return 0
  }
  if (behind === 0) {
    report([`project-forge ${tag}：已是最新（${facts.upstream}）。`], { quiet })
    return 0
  }

  if (checkOnly) {
    report([`project-forge ${tag}：上游有 ${behind} 个新提交可更新（--check 只报告，没有更新）。`], { quiet })
    return 0
  }

  const before = git(['show', 'HEAD:SKILL.md'])
  const from = before.ok ? skillVersion(before.out) : undefined
  const pulled = git(['pull', '--ff-only'])
  if (!pulled.ok) {
    // 用 --ff-only 是有意的：它失败时工作区原样不动，所以这里报错是安全的，不需要回滚。
    report([
      `project-forge ${tag}：更新失败，这个副本没有改动。`,
      `  git 说：${pulled.out === '' ? '（没有输出）' : pulled.out.split('\n').join('\n  ')}`,
    ], { quiet, always: true })
    return 1
  }
  const to = localVersion()
  report([
    `project-forge 已更新：${from ?? tag} -> ${to ?? '（版本读不到）'}。`,
    '  这个 skill 的文件变了，重新读取 SKILL.md 后再继续。',
  ], { quiet, always: true })
  return 0
}

process.exitCode = main(process.argv.slice(2))
