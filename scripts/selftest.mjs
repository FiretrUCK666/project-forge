#!/usr/bin/env node
/**
 * selftest.mjs —— 行为自检
 *
 * preflight.mjs 检查的是**结构性**契约（引用完整、内核一致、规范合规），它抓不到
 * 「判定逻辑写错了」这类问题——因为静态检查看不出 survey 把 CMake 项目判成了纯文档目录。
 *
 * 这个脚本补上另一半：**造出能证伪每条判定的 fixture，实跑，断言结果**。
 * 它的价值已经被验证过三次：密钥门控失效、仓库边界误判、条件段落冻结，三个都是
 * 「静态检查全绿、实际行为错误」，而且都是靠手工造 fixture 才发现的。手工造一次就丢，
 * 下一个改动会把同样的错误再引入一遍。所以把它固化成常驻检查。
 *
 * 用法：node scripts/selftest.mjs
 * 退出码 0 = 全部通过；1 = 有失败。临时 fixture 用完即删。
 */

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const ROOT = join(tmpdir(), `project-forge-selftest-${process.pid}`)

let passed = 0
let failed = 0
const failures = []

function check(ok, label, detail) {
  if (ok) { passed += 1; return }
  failed += 1
  failures.push(`${label}${detail === undefined ? '' : `  —— ${detail}`}`)
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

// ── 一、未初始化 git 时的密钥扫描（曾静默退化成只扫顶层） ────────────────────

group('[1] 无 git 仓库时的密钥扫描必须覆盖子目录')
{
  const dir = fixture('secrets', {
    'README.md': '# app\n',
    'src/config.py': 'API_KEY = "ghp_1234567890abcdefghijklmnopqrstuvwx"\n',
    'tests/fixtures/token.json': '{"t":"npm_abcdefghijklmnopqrstuvwxyz0123456789"}\n',
    'bin/.env': 'AWS_KEY=AKIAIOSFODNN7EXAMPLE\n',
    '中文目录/泄漏.txt': 'token = "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"\n',
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
  for (const [label, ok] of [['密钥覆盖子目录', /config\.py/.test(hits)],
    ['密钥覆盖 bin/', /\.env/.test(hits)], ['密钥覆盖中文路径', /泄漏/.test(hits)]]) report(ok, label)
}

// ── 二、仓库边界（曾把外层仓库的远端当成目标目录的） ─────────────────────────

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

group('[3] 仓库根的各种路径写法都必须判真')
{
  const repo = fixture('repo-root', { 'README.md': '# r\n' })
  for (const args of [['init', '-q'], ['config', 'user.name', 'T'],
    ['config', 'user.email', 't@example.com']]) spawnSync('git', args, { cwd: repo })
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

  const cases = [
    ['精确路径', repo],
    ['大小写变化', repo.toUpperCase()],
    ['正斜杠', repo.replace(/\\/g, '/')],
    ['结尾分隔符', repo + (process.platform === 'win32' ? '\\' : '/')],
  ]
  for (const [label, p] of cases) {
    const ok = survey(p).git?.isRepoRoot === true
    check(ok, `${label} → true`)
    report(ok, label)
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
}

group('[7] 刷新：条件随事实变化，人写的内容不被冲掉')
{
  const dir = join(ROOT, 'gen')
  const agents = join(dir, 'AGENTS.md')
  // 模拟 AI 填完待填写项
  writeFileSync(agents, readFileSync(agents, 'utf8')
    .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写的真实内容）'), 'utf8')

  spawnSync('git', ['init', '-q'], { cwd: dir })
  spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: dir })
  compose(dir)
  const t = readFileSync(agents, 'utf8')
  const checks = [
    ['建好远端后「角色判定」出现（曾永久冻结）', /^### 角色判定/m.test(t)],
    ['发版规则出现', /^### 发版规则/m.test(t)],
    ['人写的内容保留', /（已填写的真实内容）/.test(t)],
    ['没有重复的版本节', (t.match(/^## 版本管理（必守）$/gm) ?? []).length === 1],
    ['没有内核被追加多份', (t.match(/project-forge:kernel:start/g) ?? []).length === 1],
  ]
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
  check(r1.status === 0, '默认运行不报错（曾以退出码 2 失败）', `退出码 ${r1.status}`)
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
    ['升级后可正常校验', compose(dir, '--check').status === 0],
  ]
  for (const [label, ok] of checks) { check(ok, label, lost.length > 0 ? `丢失：${lost.join(' | ')}` : undefined); report(ok, label) }
}

group('[9] 多生态：命令按生态分组，不互相覆盖')
{
  const dir = fixture('multi', {
    'package.json': JSON.stringify({
      name: 'mixed', version: '1.0.0',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2),
    'requirements.txt': 'pdfplumber>=0.10\n',
    'pyproject.toml': '[project]\nname = "mixed"\nversion = "1.0.0"\n',
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

// ── 汇总 ────────────────────────────────────────────────────────────────────

rmSync(ROOT, { recursive: true, force: true })

process.stdout.write(`\n行为自检：${passed} 项通过，${failed} 项失败\n`)
if (failed > 0) {
  process.stdout.write('\n失败项：\n')
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
}
process.exitCode = failed === 0 ? 0 : 1
