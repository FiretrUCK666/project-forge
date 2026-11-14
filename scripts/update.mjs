#!/usr/bin/env node
/**
 * update.mjs —— 让这个 skill 的副本保持最新
 *
 * - 目录里有 `.git` → 源码副本，只读报告，绝不自动改写文件。
 * - 没有 `.git` → 包副本，经「同盘 staging 解包校验 -> 先备后写 -> 最后原子写 SKILL.md -> 异常回滚」更新。
 * - 状态文件按 `realpathSync.native` 归一后的路径隔离保存在用户专属缓存目录（受限时回退 `os.tmpdir()`），
 *   内置 1h 核对节流、15m 失败冷却（`FAILURE_COOLDOWN_MS`）与 24h 替换窗口，绝不隐式写入 `process.cwd()`。
 *
 * 用法：
 *   node scripts/update.mjs [--quiet] [--check]
 *
 * 退出码：0 = 无事或已更新；1 = 尝试更新但失败；2 = 用法错误。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { skillSource, skillVersion, isMainModule } from './lib/text.mjs'
import {
  REPO_ONLY_FILES, REPO_ONLY_PREFIXES, isRepoOnlyPath, apiTarget,
} from './lib/protocol.mjs'
import { equip } from './equip.mjs'
import { readZip, stripCommonPrefix } from './zip.mjs'
import { clearStaleTemps, tempPathFor, writeAtomic } from './lib/fs-atomic.mjs'
import {
  FAILURE_COOLDOWN_MS,
  canonicalRealPath,
  collectDeepStaleAndRetired,
  decodeTagSegment,
  durationText,
  isNewer,
  plainVersion,
  readStateFrom,
  rememberStateAt,
  resolveStatePath,
  rollbackAppliedWrites,
  snapshotTargetBackups,
  stageAndValidatePackage,
} from './lib/update-ops.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

const UPSTREAM = 'https://github.com/FiretrUCK666/project-forge'
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000
const STALE_CHECK_MS = 24 * 60 * 60 * 1000
const CHECK_INTERVAL_MS = 60 * 60 * 1000
const NETWORK_TIMEOUT_MS = 10 * 1000
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
const ASSET = 'project-forge.zip'

function usage() {
  return [
    '用法：node scripts/update.mjs [--quiet] [--check] [--equip <目录>]',
    '',
    '  检查这个 skill 的副本有没有新版；有就整份原子换成新版。',
    '',
    '  有 .git 的副本是源码副本：只读报告，一个字节都不写（更新请自己 git pull）。',
    '  没有 .git 的是包副本：经 staging 校验后原子更新，不隐式改写当前工作目录。',
    '',
    '  --quiet          只在「真的更新了」时输出',
    '  --check          只报告不更新，也不受节流、失败冷却与 24 小时窗口限制',
    '  --equip <目录>   显式指定目标项目，在更新完成后刷新其 `.agents/skills/`',
    '',
    '  可用环境变量 PF_UPDATE_SOURCE 改来源；设 PF_NO_UPDATE 为非空值可关掉自动检查（--check 不受影响）。',
    '',
  ].join('\n')
}

function skillText(root = SKILL_ROOT) {
  const p = join(root, 'SKILL.md')
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined
}

function localVersion(root = SKILL_ROOT) {
  const text = skillText(root)
  return text === undefined ? undefined : skillVersion(text)
}

function localSource(root = SKILL_ROOT) {
  const text = skillText(root)
  return text === undefined ? undefined : skillSource(text)
}

function readFacts() {
  return {
    hasGit: existsSync(join(SKILL_ROOT, '.git')),
    version: localVersion(),
    source: localSource(),
  }
}

function readState(statePath = resolveStatePath(SKILL_ROOT), now = Date.now()) {
  return readStateFrom(statePath, now)
}

function rememberState(patch, statePath = resolveStatePath(SKILL_ROOT), now = Date.now()) {
  return rememberStateAt(statePath, patch, now)
}

function report(lines, { quiet, always = false } = {}) {
  if (quiet && !always) return
  const text = lines.filter((l) => l !== undefined).join('\n')
  if (text !== '') process.stdout.write(`${text}\n`)
}

function download(url, { redirects = 5, accept = '*/*', final } = {}) {
  return new Promise((resolvePromise) => {
    const secure = url.startsWith('https:')
    const request = (secure ? httpsGet : httpGet)(url, {
      headers: { 'user-agent': 'project-forge-update', accept },
      timeout: NETWORK_TIMEOUT_MS,
    }, (res) => {
      const { statusCode, headers } = res
      const location = headers.location
      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400
        && location !== undefined && redirects > 0) {
        res.resume()
        let next
        try {
          next = new URL(location, url).toString()
        } catch {
          resolvePromise({ ok: false, status: 0, final })
          return
        }
        resolvePromise(download(next, { redirects: redirects - 1, accept, final: next }))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        resolvePromise({ ok: false, status: statusCode ?? 0, final })
        return
      }
      const declared = Number(headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
        res.resume()
        resolvePromise({ ok: false, status: 0, final, tooLarge: true })
        return
      }
      const chunks = []
      let received = 0
      let aborted = false
      res.on('data', (c) => {
        if (aborted) return
        received += c.length
        if (received > MAX_DOWNLOAD_BYTES) {
          aborted = true
          chunks.length = 0
          res.destroy()
          resolvePromise({ ok: false, status: 0, final, tooLarge: true })
          return
        }
        chunks.push(c)
      })
      res.on('end', () => {
        if (!aborted) resolvePromise({ ok: true, status: 200, final, body: Buffer.concat(chunks) })
      })
      res.on('error', () => { if (!aborted) resolvePromise({ ok: false, status: 0, final }) })
    })
    request.on('timeout', () => { request.destroy(); resolvePromise({ ok: false, status: 0, final }) })
    request.on('error', () => resolvePromise({ ok: false, status: 0 }))
  })
}

function apiEndpoint(source) {
  return apiTarget(source)?.latest
}

function routesFor(source) {
  const routes = []
  const api = apiEndpoint(source)
  if (api !== undefined) routes.push({ kind: 'api', endpoint: api })
  routes.push({ kind: 'web', endpoint: `${source}/releases/latest` })
  return routes
}

function latestPackageUrl(source) {
  return `${source}/releases/latest/download/${ASSET}`
}

function webPackageUrls(source) {
  return [{ url: latestPackageUrl(source), accept: '*/*' }]
}

async function probeApi(endpoint, source) {
  const res = await download(endpoint, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }
  let payload
  try {
    payload = JSON.parse(res.body.toString('utf8'))
  } catch {
    return { state: 'unreachable' }
  }
  const version = plainVersion(payload?.tag_name)
  if (version === '') return { state: 'unreachable' }
  const asset = Array.isArray(payload.assets)
    ? payload.assets.find((a) => a?.name === ASSET) : undefined
  const packageUrls = []
  if (typeof asset?.url === 'string' && /^https?:/.test(asset.url)) {
    packageUrls.push({ url: asset.url, accept: 'application/octet-stream' })
  }
  packageUrls.push(...webPackageUrls(source))
  return { state: 'ok', version, packageUrls }
}

async function probeWeb(endpoint, source) {
  const res = await download(endpoint, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }

  const fromUrl = /\/releases\/tag\/([^/?#]+)/.exec(res.final ?? '')
  if (fromUrl !== null) {
    const version = decodeTagSegment(fromUrl[1])
    if (version !== '') return { state: 'ok', version, packageUrls: webPackageUrls(source) }
  }

  const text = res.body.toString('utf8')
  if (/^\s*[[{]/.test(text)) {
    try {
      const tag = JSON.parse(text)?.tag_name
      const version = typeof tag === 'string' ? plainVersion(tag) : ''
      if (version !== '') return { state: 'ok', version, packageUrls: webPackageUrls(source) }
    } catch { /* ignore */ }
  }
  return { state: 'absent' }
}

async function fetchPackage(url, accept = '*/*') {
  const res = await download(url, { accept })
  if (!res.ok) return { ok: false, why: res.status === 404 ? '没有这一版' : '没能取回', status: res.status }
  let entries
  try {
    entries = stripCommonPrefix(readZip(res.body))
  } catch (error) {
    return { ok: false, why: `取回的不是一份能读的包（${error.message}）`, status: 200 }
  }
  const skill = entries.find((e) => e.name === 'SKILL.md')
  if (skill === undefined) return { ok: false, why: '包里没有 SKILL.md', status: 200 }
  return { ok: true, entries, version: skillVersion(skill.data.toString('utf8')) }
}

function insideRoot(baseRoot, target) {
  const root = resolve(baseRoot)
  const full = resolve(target)
  if (full === root) return true
  const inByName = full.startsWith(root.endsWith(sep) ? root : root + sep)
  if (!inByName) return false
  const realRoot = canonicalRealPath(root)
  const realFull = canonicalRealPath(full)
  if (realFull === realRoot) return true
  return realFull.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep)
}

function insideSkill(target) {
  return insideRoot(SKILL_ROOT, target)
}

function pruneEmptyDirsWithin(dir, baseRoot = SKILL_ROOT) {
  let current = dir
  const targetRoot = resolve(baseRoot)
  while (current !== targetRoot && insideRoot(targetRoot, current)) {
    try {
      if (!existsSync(current) || !statSync(current).isDirectory()) break
      if (readdirSync(current).length > 0) break
      rmSync(current, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      break
    }
    const up = dirname(current)
    if (up === current) break
    current = up
  }
}

/**
 * 整包原子替换流程：
 *   1. 同盘 staging 解包并核验目录结构与 SKILL.md 版本；
 *   2. 写前备份将被触及的旧文件；
 *   3. 先写入除 `SKILL.md` 外的全部文件，最后原子写回 `SKILL.md`；
 *   4. 任何写入失败（如 Windows EPERM）立即回滚已写文件且不更新 `SKILL.md`；
 *   5. 仅在包副本上清理仓库专属文件并全深度递归清理 `kit/skills/**` 与 `scripts/lib/**` 退役文件。
 */
function applyPackage(entries, {
  skillRoot = SKILL_ROOT,
  expectedVersion,
  writeFile = writeAtomic,
  requireFullStructure = true,
} = {}) {
  const targetRoot = resolve(skillRoot)
  const insideTarget = (p) => insideRoot(targetRoot, p)
  const pruneTargetDir = (d) => pruneEmptyDirsWithin(d, targetRoot)

  const staged = stageAndValidatePackage(entries, targetRoot, {
    expectedVersion,
    insideSkillFn: insideTarget,
    requireFullStructure,
  })
  if (!staged.ok) {
    try { if (staged.stageDir) rmSync(staged.stageDir, { recursive: true, force: true }) } catch { /* ignore */ }
    return {
      ok: false,
      why: staged.why,
      rolledBack: false,
      removed: [],
      retiredFiles: [],
      skipped: staged.skipped,
      keptTemps: [],
      staleFiles: [],
      mapRead: false,
    }
  }

  const keptTemps = []
  const skipped = [...staged.skipped]
  const appliedDests = []
  const backups = snapshotTargetBackups(staged.stagedEntries, targetRoot)

  const nonSkillEntries = staged.stagedEntries.filter((e) => e.rel !== 'SKILL.md')
  const skillEntry = staged.stagedEntries.find((e) => e.rel === 'SKILL.md')

  try {
    try {
      for (const item of nonSkillEntries) {
        const dest = join(targetRoot, item.rel)
        if (!insideTarget(dest) || !insideTarget(tempPathFor(dest))) {
          skipped.push(item.rel)
          continue
        }
        mkdirSync(dirname(dest), { recursive: true })
        for (const k of clearStaleTemps(dest).kept) keptTemps.push(basename(k))
        const payload = readFileSync(item.stagedPath)
        writeFile(dest, payload)
        appliedDests.push(dest)
      }

      if (skillEntry) {
        const skillDest = join(targetRoot, 'SKILL.md')
        if (!insideTarget(skillDest) || !insideTarget(tempPathFor(skillDest))) {
          throw new Error('SKILL.md 目标路径越界')
        }
        mkdirSync(dirname(skillDest), { recursive: true })
        for (const k of clearStaleTemps(skillDest).kept) keptTemps.push(basename(k))
        const skillPayload = readFileSync(skillEntry.stagedPath)
        writeFile(skillDest, skillPayload)
        appliedDests.push(skillDest)
      }
    } catch (err) {
      rollbackAppliedWrites(appliedDests, backups, pruneTargetDir)
      return {
        ok: false,
        why: err instanceof Error ? err.message : String(err),
        rolledBack: true,
        removed: [],
        retiredFiles: [],
        skipped,
        keptTemps: [...new Set(keptTemps)],
        staleFiles: [],
        mapRead: true,
      }
    }

    const removed = []
    const now = new Set(staged.stagedEntries.map((e) => e.rel))
    const remove = (p) => {
      rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      return !existsSync(p)
    }

    const isPackageCopy = !existsSync(join(SKILL_ROOT, '.git'))
    const targetIsPackageCopy = targetRoot === SKILL_ROOT ? isPackageCopy : !existsSync(join(targetRoot, '.git'))
    const shouldRemove = (name) => isPackageCopy
      && isRepoOnlyPath(name) && !now.has(name) && insideSkill(join(SKILL_ROOT, name))
    const shouldRemoveAtTarget = (name) => targetRoot === SKILL_ROOT
      ? shouldRemove(name)
      : (targetIsPackageCopy && isRepoOnlyPath(name) && !now.has(name) && insideTarget(join(targetRoot, name)))

    for (const dir of REPO_ONLY_PREFIXES) {
      const p = join(targetRoot, dir)
      if (!shouldRemoveAtTarget(dir)) continue
      if (existsSync(p) && remove(p)) {
        removed.push(dir)
        pruneTargetDir(dirname(p))
      }
    }
    for (const file of REPO_ONLY_FILES) {
      const p = join(targetRoot, file)
      if (!shouldRemoveAtTarget(file)) continue
      if (existsSync(p) && statSync(p).isFile() && remove(p)) {
        removed.push(file)
        pruneTargetDir(dirname(p))
      }
    }

    const { retiredFiles, staleFiles } = collectDeepStaleAndRetired(targetRoot, now, {
      isPackageCopy: targetIsPackageCopy,
      insideSkillFn: insideTarget,
      pruneDirFn: pruneTargetDir,
    })
    removed.push(...retiredFiles)

    return {
      ok: true,
      removed,
      retiredFiles,
      skipped,
      keptTemps: [...new Set(keptTemps)],
      staleFiles,
      mapRead: true,
    }
  } finally {
    try {
      if (staged.stageDir) rmSync(staged.stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch { /* ignore */ }
  }
}

function verifyInstalled(entries, after, remote) {
  const root = SKILL_ROOT
  const skillFile = join(root, 'SKILL.md')
  if (!existsSync(skillFile)) {
    return { ok: false, why: '装完之后 SKILL.md 不见了', hint: '这份副本已经不能用了。' }
  }
  const text = readFileSync(skillFile, 'utf8')
  const name = /^name:[ \t]*(.+)$/m.exec(text)?.[1]?.trim()
  if (name === undefined || name === '') {
    return {
      ok: false,
      why: 'SKILL.md 的 frontmatter 里读不到 name（文件可能被截断）',
      hint: '宿主不会加载没有 name 的技能。',
    }
  }
  const expectScripts = (entries ?? [])
    .map((e) => String(e.name).replace(/\\/g, '/'))
    .filter((n) => /^scripts\/(?:lib\/(?:[^/]+\/)*)?[^/]+\.mjs$/.test(n))
  const missing = expectScripts.filter((rel) => !existsSync(join(root, rel)))
  if (missing.length > 0) {
    return {
      ok: false,
      why: `包里带了的 ${missing.length} 个脚本没有落盘（${missing.slice(0, 3).join('、')}）`,
      hint: '缺共用模块时，别的脚本一跑就会报找不到模块。',
    }
  }
  if (after === undefined) {
    return { ok: false, why: '装完之后读不到版本号', hint: `这次要装的是 ${remote}。` }
  }
  if (remote !== undefined && after !== remote) {
    return { ok: false, why: `装完的版本是 ${after}，而要装的是 ${remote}`, hint: '装进去的可能不是那一版。' }
  }
  return { ok: true }
}

function fallbackSource() {
  const fromEnv = originUrl(process.env.PF_UPDATE_SOURCE)
  return fromEnv ?? originUrl(UPSTREAM)
}

function originUrl(source) {
  const s = String(source ?? '').trim()
  if (s === '') return undefined
  let url
  try {
    url = new URL(s)
  } catch {
    return undefined
  }
  if (!/^https?:$/.test(url.protocol) || url.host === '') return undefined
  if (url.search !== '' || url.hash !== '') return undefined
  return (url.origin + url.pathname).replace(/\/+$/, '')
}

function reportSourceCopy(facts, { quiet }) {
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version
  if (!facts.hasGit) return 0
  report([
    `project-forge ${tag}：这是源码副本（目录里有 .git），不自动更新。`,
    '  它是拿来改的，工具不碰它；要更新就自己 git pull。',
  ], { quiet })
  return 0
}

function reportUnverifiable(facts, { quiet }) {
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version
  const missing = facts.source === undefined
    ? '这份副本没有记着自己是从哪儿来的（SKILL.md 的 metadata.source 没有或不成地址）'
    : '这份副本读不到自己属于哪一版（SKILL.md 的 metadata.version）'
  report([
    `project-forge ${tag}：${missing}，无法自动核对新版（这不是「已是最新」）。`,
    '  要更新就自己下载新版覆盖；写上一行 metadata.source（仓库地址）就能恢复自动核对。',
  ], { quiet })
  return 0
}

/** 仅在显式指定目录时执行刷新；绝不隐式触碰 process.cwd()。 */
function refreshEquippedWorkspace(targetDir, { explicit = false, quiet = false } = {}) {
  if (!explicit || !targetDir) return { skipped: true, reason: 'implicit-disabled' }
  const root = resolve(targetDir)
  const kitDir = join(SKILL_ROOT, 'kit', 'skills')
  if (!existsSync(kitDir)) return { skipped: true, reason: 'no-kit-source' }
  try {
    const res = equip(root, { kitDir })
    const summary = []
    if (res.added.length > 0) summary.push(`新增 ${res.added.length}`)
    if (res.upgraded.length > 0) summary.push(`升级 ${res.upgraded.length}`)
    if (res.retired.length > 0) summary.push(`退役清理 ${res.retired.length}`)
    if (res.conflicts.length > 0) summary.push(`保留魔改 ${res.conflicts.length}`)
    if (res.orphanedModified.length > 0) summary.push(`保留退役魔改 ${res.orphanedModified.length}`)
    if (summary.length > 0 || explicit) {
      report([
        `  已刷新 ${root} 的 .agents/skills/：${summary.length > 0 ? summary.join('、') : '已是最新（幂等跳过）'}。`,
      ], { quiet, always: summary.length > 0 })
    }
    return { skipped: false, result: res }
  } catch (err) {
    report([
      `  刷新 .agents/skills/ 未成功（${err instanceof Error ? err.message : String(err)}），请稍后手动运行 equip.mjs。`,
    ], { quiet, always: true })
    return { skipped: true, reason: 'error' }
  }
}

function runDiskEquip(equipTarget, { quiet = false } = {}) {
  if (!equipTarget) return
  const equipScript = join(SKILL_ROOT, 'scripts', 'equip.mjs')
  const res = spawnSync(process.execPath, [equipScript, resolve(equipTarget)], {
    encoding: 'utf8',
    timeout: 60000,
  })
  if (res.status === 0) {
    report([`  已按磁盘新版套件刷新 ${resolve(equipTarget)} 的 .agents/skills/。`], { quiet })
  } else {
    report([`  刷新 .agents/skills/ 未成功（退出码 ${res.status}），请稍后手动运行 equip.mjs。`], { quiet, always: true })
  }
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage()); return 0 }
  let checkOnly = false
  let quietFlag = false
  let equipTarget
  const unknown = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--quiet') quietFlag = true
    else if (arg === '--check') checkOnly = true
    else if (arg === '--equip') {
      const next = argv[++i]
      if (!next) { unknown.push('--equip'); break }
      equipTarget = next
    } else if (arg.startsWith('--equip=')) {
      const val = arg.slice('--equip='.length)
      if (!val) { unknown.push(arg); break }
      equipTarget = val
    } else {
      unknown.push(arg)
    }
  }

  if (unknown.length > 0) {
    process.stderr.write(`错误：未知参数 ${unknown.join(' ')}\n\n${usage()}`)
    return 2
  }
  const quiet = quietFlag && !checkOnly
  if (!checkOnly && (process.env.PF_NO_UPDATE ?? '') !== '') return 0

  const facts = readFacts()
  const tag = facts.version === undefined ? '（版本读不到）' : facts.version

  if (facts.hasGit) {
    const code = reportSourceCopy(facts, { quiet })
    if (equipTarget && !checkOnly) refreshEquippedWorkspace(equipTarget, { explicit: true, quiet })
    return code
  }

  const source = originUrl(facts.source) ?? fallbackSource()
  if (source === undefined || facts.version === undefined) return reportUnverifiable(facts, { quiet })

  const statePath = resolveStatePath(SKILL_ROOT)
  const now = Date.now()
  const state = readState(statePath, now)
  const sinceUpdate = now - state.lastUpdateAt
  const inWindow = sinceUpdate < UPDATE_INTERVAL_MS

  if (quiet && state.lastOkAt !== 0 && now - state.lastOkAt < CHECK_INTERVAL_MS) {
    return 0
  }
  if (!checkOnly && state.lastFailAt !== 0 && now - state.lastFailAt < FAILURE_COOLDOWN_MS) {
    const left = FAILURE_COOLDOWN_MS - (now - state.lastFailAt)
    report([
      `project-forge ${tag}：最近核对失败，处于 ${durationText(FAILURE_COOLDOWN_MS)} 冷却中（剩余约 ${durationText(left)}；可用 --check 立即核对）。`,
    ], { quiet })
    return 0
  }

  let found = { state: 'unreachable' }
  let absent = false
  for (const route of routesFor(source)) {
    const probe = route.kind === 'api'
      ? await probeApi(route.endpoint, source)
      : await probeWeb(route.endpoint, source)
    if (probe.state === 'ok') { found = probe; break }
    if (probe.state === 'absent') absent = true
  }
  if (found.state !== 'ok' && absent) found = { state: 'absent' }

  if (found.state === 'unreachable') {
    const neverChecked = state.lastOkAt === 0
    const staleFor = neverChecked ? 0 : Date.now() - state.lastOkAt
    const spokeRecently = Date.now() - state.lastNoticeAt < STALE_CHECK_MS
    if (!spokeRecently && (neverChecked || staleFor >= STALE_CHECK_MS)) {
      if (!checkOnly) rememberState({ lastFailAt: Date.now(), lastNoticeAt: Date.now() }, statePath)
      report([
        neverChecked
          ? `project-forge ${tag}：一直没能连上发布方核对新版，这份停在 ${tag}（不是「已是最新」）。`
          : `project-forge ${tag}：已经 ${durationText(staleFor)}没能核对新版了，这份停在 ${tag}（不是「已是最新」）。`,
        '  核对不上不影响它干活，只是会一直停在这个版本；换一个能连上发布方的网络就能恢复。',
      ], { quiet, always: true })
      return 0
    }
    if (!checkOnly) rememberState({ lastFailAt: Date.now() }, statePath)
    report([`project-forge ${tag}：这次没能联网核对（不是「已是最新」）。`], { quiet })
    return 0
  }

  let latest
  let remote
  if (found.state === 'ok') {
    remote = found.version
    rememberState({ lastOkAt: Date.now(), lastFailAt: 0 }, statePath)
  } else {
    latest = await fetchPackage(latestPackageUrl(source))
    if (!latest.ok) {
      if (!checkOnly) rememberState({ lastFailAt: Date.now() }, statePath)
      report([`project-forge ${tag}：这次没能联网核对（不是「已是最新」）。`], { quiet })
      return 0
    }
    remote = latest.version
    rememberState({ lastOkAt: Date.now(), lastFailAt: 0 }, statePath)
  }

  if (remote === undefined) {
    report([`project-forge ${tag}：最新版读不到版本号，无法判断有没有新版。`], { quiet })
    return 0
  }
  const newer = isNewer(remote, facts.version)
  if (newer === undefined) {
    report([`project-forge ${tag}：版本号形状认不出来（远端是 ${remote}），跳过（不猜）。`], { quiet })
    return 0
  }
  if (!newer) {
    report([`project-forge ${tag}：已是最新。`], { quiet })
    return 0
  }
  if (inWindow) {
    const left = UPDATE_INTERVAL_MS - sinceUpdate
    report([
      `project-forge ${tag}：有新版本 ${remote}。这份副本刚更新过，`,
      `  ${durationText(left)}之后再自动换；这次继续用现在这份就够（想马上要新版，去发布页下载覆盖）。`,
    ], { quiet, always: true })
    return 0
  }
  if (checkOnly) {
    report([`project-forge ${tag}：有新版本 ${remote}（--check 只报告，没有更新）。`], { quiet })
    return 0
  }

  if (latest === undefined) {
    for (const candidate of found.packageUrls ?? webPackageUrls(source)) {
      latest = await fetchPackage(candidate.url, candidate.accept)
      if (latest.ok) break
    }
  }
  if (!latest.ok) {
    rememberState({ lastFailAt: Date.now() }, statePath)
    report([`project-forge ${tag}：新版没取回来（${latest.why}），没有更新，这份还是原样。`], { quiet, always: true })
    return 1
  }

  if (found.state === 'ok' && latest.version !== remote) {
    rememberState({ lastFailAt: Date.now() }, statePath)
    report([
      `project-forge ${tag}：最新发布是 ${remote}，但那个安装包里的却是 ${latest.version ?? '读不到版本'} —— 两处对不上，这次没有更新。`,
    ], { quiet, always: true })
    return 1
  }

  const applyRes = applyPackage(latest.entries, { expectedVersion: found.state === 'ok' ? remote : undefined })
  if (!applyRes.ok) {
    rememberState({ lastFailAt: Date.now() }, statePath)
    report([
      `project-forge ${tag}：更新在 staging 校验或落盘阶段中止（${applyRes.why}）${applyRes.rolledBack ? '，已回滚到原文件' : ''}。`,
    ], { quiet, always: true })
    return 1
  }

  const { removed, skipped, keptTemps, staleFiles } = applyRes
  const after = localVersion()
  const health = verifyInstalled(latest.entries, after, remote)
  if (health.ok) rememberState({ lastUpdateAt: Date.now(), lastFailAt: 0 }, statePath)

  const versionText = after === undefined
    ? `project-forge 的文件已换成 ${remote} 那一份，但版本号读不出来`
    : `project-forge 已更新到最新版 ${after} —— 你之前用的是 ${tag}。`
  report([
    health.ok ? versionText : `project-forge 更新了文件，但验收没过：${health.why}`,
    health.ok ? '  这个 skill 的文件换了，我重新读一遍 SKILL.md 再继续。' : `  你这份副本可能已经不可用。${health.hint ?? ''}`,
    removed.length > 0 ? `  清掉了 ${removed.length} 处残留或退役文件（${removed.slice(0, 3).join('、')}${removed.length > 3 ? ' 等' : ''}）。` : undefined,
    skipped.length > 0 ? `  有 ${skipped.length} 个条目指向本领目录之外，已跳过（${skipped.slice(0, 3).join('、')}）。` : undefined,
    keptTemps.length > 0 ? `  有 ${keptTemps.length} 个属于其他进程的临时文件，没动（${keptTemps.slice(0, 3).join('、')}）。` : undefined,
    staleFiles.length > 0 ? `  这几个非核心目录文件在新版包里没有，未擅删：${staleFiles.slice(0, 5).join('、')}${staleFiles.length > 5 ? ' 等' : ''}。` : undefined,
  ], { quiet, always: true })

  if (health.ok && equipTarget) {
    runDiskEquip(equipTarget, { quiet })
  }
  return health.ok ? 0 : 1
}

export {
  UPSTREAM,
  UPDATE_INTERVAL_MS,
  STALE_CHECK_MS,
  CHECK_INTERVAL_MS,
  FAILURE_COOLDOWN_MS,
  apiEndpoint,
  routesFor,
  refreshEquippedWorkspace,
  applyPackage,
  readState,
  rememberState,
  resolveStatePath,
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((error) => {
      process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
