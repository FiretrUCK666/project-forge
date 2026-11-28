/**
 * fixtures-preflight-perf.mjs —— preflight-suite 语法子进程重叠执行、单次文件读取与私有泄漏扫描回归夹具。
 */

import { spawn } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { rmTree, SKILL_ROOT, tmpProject, trackTempDir } from './fixtures-helpers.mjs'
import { scanKitPrivateLeaks } from './preflight-suite.mjs'

const SUITE_MODULE_URL = pathToFileURL(join(SKILL_ROOT, 'scripts', 'dev', 'preflight-suite.mjs')).href
const STATIC_GATES_URL = pathToFileURL(join(SKILL_ROOT, 'kit', 'skills', 'lib', 'static-gates.mjs')).href

const CHILD_RUNNER = [
  "import { existsSync, readdirSync, readFileSync } from 'node:fs';",
  "import { join, relative } from 'node:path';",
  'const { countTextLines } = await import(process.env.PF_STATIC_GATES_URL);',
  'const { runSuiteChecks } = await import(process.env.PF_SUITE_MODULE_URL);',
  'const root = process.env.PF_TARGET_ROOT;',
  'const failures = [];',
  'const notes = [];',
  'const textCache = new Map();',
  'const walkCache = new Map();',
  "const rel = (abs) => relative(root, abs).split('\\\\').join('/');",
  'const readText = (abs) => {',
  '  let v = textCache.get(abs);',
  '  if (v === undefined) {',
  "    v = readFileSync(abs, 'utf8').replace(/^\\uFEFF/, '');",
  '    textCache.set(abs, v);',
  '  }',
  '  return v;',
  '};',
  'const walkAll = (dir) => {',
  '  const cached = walkCache.get(dir);',
  '  if (cached) return cached;',
  '  const out = [];',
  '  if (existsSync(dir)) {',
  '    for (const ent of readdirSync(dir, { withFileTypes: true })) {',
  "      if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.worktrees') continue;",
  '      const full = join(dir, ent.name);',
  '      if (ent.isDirectory()) out.push(...walkAll(full));',
  '      else if (ent.isFile()) out.push(full);',
  '    }',
  '  }',
  '  walkCache.set(dir, out);',
  '  return out;',
  '};',
  'const walk = (dir, pred) => {',
  '  const all = walkAll(dir);',
  '  return pred === undefined ? [...all] : all.filter(pred);',
  '};',
  'await runSuiteChecks({',
  '  ROOT: root,',
  '  rel,',
  '  readText,',
  '  countLines: countTextLines,',
  '  walk,',
  '  fail: (msg) => failures.push(msg),',
  '  note: (msg) => notes.push(msg),',
  '});',
  'process.stdout.write(JSON.stringify({ failures, notes }));',
].join('\n')

function runSuiteChecksInChild(targetRoot) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', CHILD_RUNNER], {
      cwd: targetRoot,
      env: {
        ...process.env,
        PF_TARGET_ROOT: targetRoot,
        PF_SUITE_MODULE_URL: SUITE_MODULE_URL,
        PF_STATIC_GATES_URL: STATIC_GATES_URL,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out = []
    const err = []
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 60000)
    timer.unref?.()
    child.stdout?.on('data', (c) => out.push(c))
    child.stderr?.on('data', (c) => err.push(c))
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0) {
        done({ ok: false, error: `子进程退出码 ${code}：${stderr || stdout}` })
        return
      }
      try {
        done({ ok: true, ...JSON.parse(stdout) })
      } catch (e) {
        done({ ok: false, error: `解析子进程输出失败：${e.message}` })
      }
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ ok: false, error: e.message })
    })
  })
}

function copyRepoSnapshot() {
  const dir = trackTempDir(mkdtempSync(join(tmpdir(), 'pf-suite-perf-')))
  cpSync(SKILL_ROOT, dir, {
    recursive: true,
    filter: (src) => {
      const name = basename(src)
      return name !== '.git' && name !== 'node_modules' && name !== '.worktrees'
    },
  })
  return dir
}

export function registerPreflightPerfCases(cases) {
  cases.push(['preflight-suite 正向：batchSyntaxCheck 与非语法检查重叠执行，且 scanKitPrivateLeaks 复用读取回调', async () => {
    const cleanDir = copyRepoSnapshot()
    try {
      const suite = await runSuiteChecksInChild(cleanDir)
      if (!suite.ok) return suite.error
      if (suite.failures.length > 0) {
        return `洁净仓库副本 runSuiteChecks 意外失败：${suite.failures.slice(0, 5).join('；')}`
      }
      const archIdx = suite.notes.findIndex((n) => n.startsWith('架构边界：'))
      const probeIdx = suite.notes.findIndex((n) => n.startsWith('写路径联网探测：'))
      const scriptsIdx = suite.notes.findIndex((n) => n.startsWith('脚本：'))
      const kitIdx = suite.notes.findIndex((n) => n.startsWith('工程套件：'))
      if (archIdx < 0 || probeIdx < archIdx || scriptsIdx < probeIdx || kitIdx < scriptsIdx) {
        return `runSuiteChecks 未先执行非语法主线程检查再等待语法子进程：${JSON.stringify({ archIdx, probeIdx, scriptsIdx, kitIdx })}`
      }

      let readCalls = 0
      const spyLeaks = scanKitPrivateLeaks(cleanDir, (abs) => {
        readCalls += 1
        return readFileSync(abs, 'utf8')
      })
      if (spyLeaks.length > 0 || readCalls === 0) {
        return `scanKitPrivateLeaks(ROOT, readTextFn) 未复用回调或误报：readCalls=${readCalls}, leaks=${JSON.stringify(spyLeaks)}`
      }
      const standaloneLeaks = scanKitPrivateLeaks(cleanDir)
      if (standaloneLeaks.length > 0) {
        return `scanKitPrivateLeaks(ROOT) 单参模式误报：${JSON.stringify(standaloneLeaks)}`
      }
    } finally {
      rmTree(cleanDir)
    }
    return true
  }])

  cases.push(['preflight-suite 反向：重叠与单次读取复用仍 100% 捕获语法错误、UTF-8 BOM、新增履历体与私有符号泄漏', async () => {
    const dirtyDir = copyRepoSnapshot()
    try {
      const badScript = join(dirtyDir, 'scripts', 'survey.mjs')
      writeFileSync(badScript, `${readFileSync(badScript, 'utf8')}\nconst = ;\n`, 'utf8')

      const badKitScript = join(dirtyDir, 'kit', 'skills', 'lib', 'git.mjs')
      writeFileSync(badKitScript, `${readFileSync(badKitScript, 'utf8')}\nfunction () {}\n`, 'utf8')

      const badReadme = join(dirtyDir, 'README.md')
      writeFileSync(badReadme, `\uFEFF${readFileSync(badReadme, 'utf8')}\n原来的做法是手写脚本。\n`, 'utf8')

      const suite = await runSuiteChecksInChild(dirtyDir)
      if (!suite.ok) return suite.error

      const hasScriptSyntaxErr = suite.failures.some((f) => f.includes('scripts/survey.mjs') && f.includes('语法错误'))
      const hasKitSyntaxErr = suite.failures.some((f) => f.includes('kit/skills/lib/git.mjs') && f.includes('语法错误'))
      const hasBomErr = suite.failures.some((f) => f.includes('README.md') && f.includes('UTF-8 BOM'))
      const hasVoiceErr = suite.failures.some((f) => f.includes('README.md:') && f.includes('履历体'))
      if (!hasScriptSyntaxErr || !hasKitSyntaxErr || !hasBomErr || !hasVoiceErr) {
        return `runSuiteChecks 漏报失败项：${JSON.stringify({ hasScriptSyntaxErr, hasKitSyntaxErr, hasBomErr, hasVoiceErr, failures: suite.failures })}`
      }
    } finally {
      rmTree(dirtyDir)
    }

    const leakDir = tmpProject({
      'kit/skills/lib/bad-leak.mjs': "export const sym = 'verify-injections'\nexport const cmd = 'node scripts/survey.mjs .'\n",
    })
    try {
      const standalone = scanKitPrivateLeaks(leakDir)
      let spyCount = 0
      const withReader = scanKitPrivateLeaks(leakDir, (abs) => {
        spyCount += 1
        return readFileSync(abs, 'utf8')
      })
      for (const [label, leaks] of [['standalone', standalone], ['withReader', withReader]]) {
        if (!leaks.some((l) => l.includes('verify-injections')) || !leaks.some((l) => l.includes('scripts/survey.mjs'))) {
          return `scanKitPrivateLeaks(${label}) 漏报私有符号或脚本泄漏：${JSON.stringify(leaks)}`
        }
      }
      if (spyCount !== 1) return `scanKitPrivateLeaks 回调次数异常：${spyCount}`
    } finally {
      rmTree(leakDir)
    }
    return true
  }])
}
