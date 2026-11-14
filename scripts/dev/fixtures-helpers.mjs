/**
 * fixtures-helpers.mjs —— 行为断言共享沙盒夹具与执行辅助原语。
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

import { textsOf, survey as runSurvey } from '../survey.mjs'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS = resolve(HERE, '..')
export const SKILL_ROOT = resolve(HERE, '..', '..')

export { textsOf }

export function initTestBackupDir() {
  if (!String(process.env.PF_BACKUP_DIR ?? '').trim()) {
    const testBackupRoot = mkdtempSync(join(tmpdir(), 'pf-test-bk-'))
    process.env.PF_BACKUP_DIR = testBackupRoot
    process.on('exit', () => {
      try {
        rmSync(testBackupRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch { /* 留给系统清理 */ }
    })
  }
}

export function tmpProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-fix-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

export function rmTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch { /* 留给系统清理 */ }
}

export function existingKept(result, pid) {
  return (result.kept ?? []).some((p) => p.endsWith(`.tmp-${pid}`))
}

export function gitInit(dir) {
  const opts = { cwd: dir, encoding: 'utf8', stdio: 'ignore' }
  spawnSync('git', ['init', '-q'], opts)
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'add', '-A'], opts)
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init'], opts)
}

export async function survey(dir, opts) {
  return runSurvey(dir, opts)
}

export function readDirRefs(dir) {
  const prefix = dir.slice(SKILL_ROOT.length + 1).replace(/\\/g, '/')
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => `${prefix}/${n}`)
  } catch { return [] }
}

export async function runNode(script, args, opts = {}) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    ...opts,
  })
}

export function runAbs(scriptRel, args, opts = {}) {
  return spawnSync(process.execPath, [join(SKILL_ROOT, scriptRel), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    ...opts,
  })
}

let preflightLib
export async function loadPreflight() {
  if (preflightLib === undefined) preflightLib = await import('./preflight.mjs')
  return preflightLib
}

export function createTempHookEnv(extra = {}) {
  return { ...process.env, ...extra }
}

export function hasFile(root, rel) {
  return existsSync(join(root, rel))
}
