/**
 * git-fast.mjs —— 零子进程 Git 配置、Ref 解析与 porcelain=v2 增量解析原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 flow-inspect / git / ledger 共用。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { LIKELY_DEFAULT_BRANCHES, readTextSafe } from './git.mjs'

/** 零子进程解析当前工作区 `.git` 目录（兼容普通仓与 linked worktree）。 */
export function resolveGitDirFast(repoRoot) {
  if (!repoRoot) return null
  const dotGit = join(repoRoot, '.git')
  if (!existsSync(dotGit)) return null
  try {
    const st = statSync(dotGit)
    if (st.isDirectory()) return dotGit
    if (st.isFile()) {
      const content = readFileSync(dotGit, 'utf8')
      const m = /^gitdir:\s*(.+)$/im.exec(content)
      if (m) return resolve(repoRoot, m[1].trim())
    }
  } catch { /* ignore */ }
  return null
}

/** 解析 `git status --porcelain=v2 --branch -z` 输出。 */
export function parsePorcelainV2BranchZ(buf) {
  const tokens = Buffer.isBuffer(buf) ? buf.toString('utf8').split('\0') : String(buf ?? '').split('\0')
  let head = null
  let branch = null
  let dirty = 0
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]
    if (!tok) continue
    if (tok.startsWith('# branch.oid ')) {
      const val = tok.slice(13).trim()
      head = val && val !== '(initial)' ? val : null
    } else if (tok.startsWith('# branch.head ')) {
      const val = tok.slice(14).trim()
      branch = val || null
    } else if (!tok.startsWith('#')) {
      dirty += 1
      if (tok.startsWith('2 ')) i += 1
    }
  }
  if (branch === '(detached)' && !head) branch = null
  return { head, branch, dirty }
}

/** 从 `for-each-ref` 输出推算默认分支。 */
export function resolveDefaultBranchFromRefs(refsStdout, curBranch, initDefaultBranch) {
  const localHeads = new Set()
  const originHeads = new Set()
  let originHeadTarget
  for (const rawLine of String(refsStdout ?? '').split('\n')) {
    if (!rawLine) continue
    const [refName, symTarget = ''] = rawLine.split('\t')
    if (refName === 'refs/remotes/origin/HEAD' && symTarget.trim()) {
      originHeadTarget = symTarget.trim().replace(/^origin\//, '')
    } else if (refName.startsWith('refs/heads/')) {
      localHeads.add(refName.slice(11))
    } else if (refName.startsWith('refs/remotes/origin/')) {
      const name = refName.slice(20)
      if (name !== 'HEAD') originHeads.add(name)
    }
  }
  if (originHeadTarget) return originHeadTarget
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (localHeads.has(cand) || originHeads.has(cand)) return cand
  }
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return initDefaultBranch || 'main'
}

/** 零子进程解析全局与本地 `.git/config`（遇 include/url rewrite 时返回 null 回退 git CLI）。 */
export function readGitConfigFast(gitCommonDir) {
  if (!gitCommonDir) return null
  if (process.env.GIT_CONFIG_GLOBAL || process.env.GIT_CONFIG_SYSTEM || process.env.GIT_CONFIG_COUNT) return null
  const localCfg = readTextSafe(join(gitCommonDir, 'config'))
  if (localCfg === undefined) return null
  const xdgHome = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  const globalPaths = [join(homedir(), '.gitconfig'), join(xdgHome, 'git', 'config')]
  let globalCfg = ''
  for (const gp of globalPaths) {
    const txt = readTextSafe(gp)
    if (txt) { globalCfg = txt; break }
  }
  const combined = `${globalCfg}\n${localCfg}`
  if (/^\s*\[(?:url\b|include\b|includeif\b)/im.test(combined)) return null

  const remoteLines = []
  let curSection = ''
  let curRemote = null
  const remotes = new Map()
  let userName
  let userEmail
  let initDefaultBranch

  for (const rawCfg of [globalCfg, localCfg]) {
    curSection = ''
    curRemote = null
    for (const rawLine of rawCfg.split('\n')) {
      const line = rawLine.replace(/(?:^|\s)[;#].*$/, '').trim()
      if (!line) continue
      const sec = /^\[([a-z0-9-]+)(?:\s+"([^"]*)")?\]$/i.exec(line)
      if (sec) {
        curSection = sec[1].toLowerCase()
        curRemote = curSection === 'remote' ? (sec[2] ?? '') : null
        if (curSection === 'remote' && curRemote && !remotes.has(curRemote)) {
          remotes.set(curRemote, { urls: [], pushUrls: [] })
        }
        continue
      }
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const k = line.slice(0, eq).trim().toLowerCase()
      const v = line.slice(eq + 1).trim()
      if (curSection === 'user') {
        if (k === 'name') userName = v
        else if (k === 'email') userEmail = v
      } else if (curSection === 'init' && k === 'defaultbranch') {
        initDefaultBranch = v
      } else if (curSection === 'remote' && curRemote) {
        const entry = remotes.get(curRemote)
        if (k === 'url' && v) entry.urls.push(v)
        else if (k === 'pushurl' && v) entry.pushUrls.push(v)
      }
    }
  }

  for (const [name, entry] of remotes.entries()) {
    const fetchUrl = entry.urls[0]
    const pushUrl = entry.pushUrls[0] ?? fetchUrl
    if (fetchUrl) remoteLines.push(`${name}\t${fetchUrl} (fetch)`)
    if (pushUrl) remoteLines.push(`${name}\t${pushUrl} (push)`)
  }
  return {
    userName,
    userEmail,
    initDefaultBranch,
    remoteText: remoteLines.join('\n'),
    hasIdentity: Boolean(userName && userEmail),
  }
}

/** 解析 loose/packed ref 的 commit SHA（reftable 或不存在返回 null）。 */
export function resolveRefShaFast(gitCommonDir, fullRef) {
  if (!gitCommonDir || !fullRef || existsSync(join(gitCommonDir, 'reftable'))) return null
  const cleanRef = String(fullRef).replace(/^\/+/, '')
  const looseAbs = join(gitCommonDir, ...cleanRef.split('/'))
  const looseTxt = readTextSafe(looseAbs)
  if (looseTxt) {
    const t = looseTxt.trim()
    if (/^[0-9a-f]{40,64}$/i.test(t)) return t
    if (t.startsWith('ref:')) return resolveRefShaFast(gitCommonDir, t.slice(4).trim())
  }
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs'))
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const sha = line.slice(0, sp).trim()
      const refName = line.slice(sp + 1).trim()
      if (refName === cleanRef && /^[0-9a-f]{40,64}$/i.test(sha)) return sha
    }
  }
  return null
}

/** 零子进程读取工作区 HEAD 与关联 branch / oid（reftable 或异常返回 null）。 */
export function readHeadFast(wtGitDir, gitCommonDir = wtGitDir) {
  if (!wtGitDir || existsSync(join(gitCommonDir || wtGitDir, 'reftable'))) return null
  const headTxt = readTextSafe(join(wtGitDir, 'HEAD'))
  if (!headTxt) return null
  const t = headTxt.trim()
  if (t.startsWith('ref:')) {
    const targetRef = t.slice(4).trim()
    const branch = targetRef.startsWith('refs/heads/') ? targetRef.slice(11) : targetRef
    const oid = resolveRefShaFast(gitCommonDir || wtGitDir, targetRef)
    return { detached: false, ref: targetRef, branch, oid }
  }
  if (/^[0-9a-f]{40,64}$/i.test(t)) {
    return { detached: true, ref: null, branch: null, oid: t }
  }
  return null
}

/** 零子进程读取 loose/packed refs 推导默认分支（reftable 仓返回 null）。 */
export function readRefsFast(gitCommonDir, curBranch, initDefaultBranch) {
  if (!gitCommonDir || existsSync(join(gitCommonDir, 'reftable'))) return null
  const origHeadPath = join(gitCommonDir, 'refs', 'remotes', 'origin', 'HEAD')
  const origHeadText = readTextSafe(origHeadPath)
  if (origHeadText) {
    const m = /^ref:\s*refs\/remotes\/origin\/(.+)$/im.exec(origHeadText.trim())
    if (m) return m[1].trim()
  }
  const localHeads = new Set()
  const originHeads = new Set()
  const scanLoose = (dirAbs, bucket) => {
    if (!existsSync(dirAbs)) return
    const stack = [{ abs: dirAbs, rel: '' }]
    while (stack.length > 0) {
      const cur = stack.pop()
      let entries = []
      try { entries = readdirSync(cur.abs, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        const name = cur.rel ? `${cur.rel}/${e.name}` : e.name
        if (e.isDirectory()) stack.push({ abs: join(cur.abs, e.name), rel: name })
        else if (e.isFile() && name !== 'HEAD') bucket.add(name)
      }
    }
  }
  scanLoose(join(gitCommonDir, 'refs', 'heads'), localHeads)
  scanLoose(join(gitCommonDir, 'refs', 'remotes', 'origin'), originHeads)
  const packed = readTextSafe(join(gitCommonDir, 'packed-refs'))
  if (packed) {
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const refName = line.slice(sp + 1).trim()
      if (refName.startsWith('refs/heads/')) localHeads.add(refName.slice(11))
      else if (refName.startsWith('refs/remotes/origin/')) {
        const n = refName.slice(20)
        if (n !== 'HEAD') originHeads.add(n)
      }
    }
  }
  if (curBranch && LIKELY_DEFAULT_BRANCHES.includes(curBranch)) return curBranch
  for (const cand of LIKELY_DEFAULT_BRANCHES) {
    if (localHeads.has(cand) || originHeads.has(cand)) return cand
  }
  if (curBranch && curBranch !== 'HEAD' && curBranch !== '(detached)') return curBranch
  return initDefaultBranch || 'main'
}
