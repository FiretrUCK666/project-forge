#!/usr/bin/env node
/**
 * fixtures.mjs —— 行为断言：造临时项目实跑，确认判定没写错。
 *
 * 结构自检查不出「判定写错了」：勘察把一个 CMake 项目判成纯文档目录时，
 * 引用与格式全都正常。这类错误只能靠**造出能证伪它的 fixture** 发现——
 * 一个该被判成 X 的目录，和一个容易被误判成 X 的目录。
 *
 * 只覆盖「判错了会给出错的动作」的那些判定。风格偏好不测。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = resolve(HERE, '..')
const SKILL_ROOT = resolve(HERE, '..', '..')

let passed = 0
const failures = []

function check(name, fn) {
  try {
    const outcome = fn()
    if (outcome === true || outcome === undefined) { passed += 1; return }
    failures.push(`${name} —— ${outcome}`)
  } catch (error) {
    failures.push(`${name} —— 抛异常：${error instanceof Error ? error.message : String(error)}`)
  }
}

function tmpProject(files) {
  const dir = mkdtempSync(join(tmpdir(), 'pf-fix-'))
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content)
  }
  return dir
}

/**
 * 删掉一个临时项目。
 *
 * Windows 上刚被 git 或子进程碰过的目录会被锁一小会儿，第一次删不掉很正常。
 * 删不掉**不是测试失败**：把清理动作的失败读成判据失败，等于让一次系统抖动
 * 把一整趟行为断言打成红——而红的那一条与它要证明的东西毫无关系。
 */
function rmTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch { /* 留给系统清理 */ }
}

/** kept 里有没有「属于某个 pid」的那一项。 */
function existingKept(result, pid) {
  return (result.kept ?? []).some((p) => p.endsWith(`.tmp-${pid}`))
}

function gitInit(dir) {
  const opts = { cwd: dir, encoding: 'utf8', stdio: 'ignore' }
  spawnSync('git', ['init', '-q'], opts)
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'add', '-A'], opts)
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init'], opts)
}

async function survey(dir) {
  const { survey: run } = await import('../survey.mjs')
  return run(dir)
}

async function runNode(script, args) {
  return spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', timeout: 60000 })
}

// ── 勘察：生态判定 ──────────────────────────────────────────────────

const cases = []

cases.push(['node 项目被判成 node', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0","scripts":{"test":"node --test"}}' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('node')) return `kinds=${f.ecosystem.kinds}`
    if (f.commands.test !== 'npm test') return `test 命令是 ${f.commands.test}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['CMake 项目被判成 cpp，不是 docs-only', async () => {
  const dir = tmpProject({ 'CMakeLists.txt': 'cmake_minimum_required(VERSION 3.20)\nproject(x CXX)\n' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('cpp')) return `kinds=${f.ecosystem.kinds}`
    if (f.ecosystem.kinds.includes('docs-only')) return '同时被判成 docs-only'
    if (f.maturity !== 'greenfield') return `maturity=${f.maturity}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['纯 md 但没 README 判成 unknown，不是 docs-only', async () => {
  const dir = tmpProject({ 'notes.md': '# 随手记\n' })
  try {
    const f = await survey(dir)
    if (f.ecosystem.kinds.includes('docs-only')) return '被误判成 docs-only'
    if (!f.ecosystem.kinds.includes('unknown')) return `kinds=${f.ecosystem.kinds}`
    if (!f.questions.some((q) => /什么项目/.test(q))) return '没问用户这是什么项目'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['README + 只有 md 判成 docs-only', async () => {
  const dir = tmpProject({ 'README.md': '# 手册\n\n内容。\n', 'guide.md': '# 指南\n' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('docs-only')) return `kinds=${f.ecosystem.kinds}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['能力目录：frontmatter 缺 description 时判为不合法', async () => {
  const dir = tmpProject({ 'SKILL.md': '---\nname: demo-skill\n---\n\n# demo\n' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('skill')) return `kinds=${f.ecosystem.kinds}`
    if (f.ecosystem.skillMeta.hasValidFrontmatter !== false) return '把不合法的入口判成合法'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['Go 项目：registryFree 为真且不设 publishable', async () => {
  const dir = tmpProject({ 'go.mod': 'module github.com/acme/demo\n\ngo 1.22\n' })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('go')) return `kinds=${f.ecosystem.kinds}`
    if (f.ecosystem.registryFree !== true) return 'registryFree 不是真'
    if (f.ecosystem.publishable === true) return 'Go 被标成需要发制品库'
    if (f.ecosystem.declaredRepo !== 'acme/demo') return `declaredRepo=${f.ecosystem.declaredRepo}`
    return true
  } finally { rmTree(dir) }
}])

// ── 勘察：git 与角色 ────────────────────────────────────────────────

cases.push(['isRepoRoot 为假时停下并问边界', async () => {
  const outer = tmpProject({ 'package.json': '{"name":"o","version":"1.0.0"}', 'sub/README.md': '# sub\n' })
  gitInit(outer)
  try {
    const f = await survey(join(outer, 'sub'))
    if (f.git.isRepoRoot !== false) return 'isRepoRoot 没判成假'
    if (!f.gaps.some((g) => /不是仓库根|外层仓库/.test(g))) return `gaps=${JSON.stringify(f.gaps)}`
    if (!f.questions.some((q) => /并入|单独/.test(q))) return '没问边界'
    return true
  } finally { rmTree(outer) }
}])

cases.push(['没有远端时角色是 maintainer（本地提交不涉及别人）', async () => {
  const dir = tmpProject({ 'README.md': '# a\n' })
  gitInit(dir)
  try {
    const f = await survey(dir)
    if (f.git.role !== 'maintainer') return `role=${f.git.role}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['有远端但没声明源仓库时角色是 undetermined', async () => {
  const dir = tmpProject({ 'README.md': '# a\n' })
  gitInit(dir)
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/x/y.git'], { cwd: dir, stdio: 'ignore' })
  try {
    const f = await survey(dir)
    if (f.git.role !== 'undetermined') return `role=${f.git.role}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['origin 与声明源仓库不一致时是 contributor-fork', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"a","version":"1.0.0","repository":"https://github.com/upstream/real"}',
  })
  gitInit(dir)
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/me/fork.git'], { cwd: dir, stdio: 'ignore' })
  try {
    const f = await survey(dir)
    if (f.git.role !== 'contributor-fork') return `role=${f.git.role}`
    return true
  } finally { rmTree(dir) }
}])

// ── 勘察：凭据与忽略 ────────────────────────────────────────────────

cases.push(['未忽略的 .env 判 exposed，忽略的判 ignored', async () => {
  const dir = tmpProject({ '.gitignore': '.env.local\n', 'README.md': '# a\n' })
  gitInit(dir)
  // 提交之后再写这两个文件，它们才是「未跟踪」的——之前写会被 init 一起提交进去。
  writeFileSync(join(dir, '.env'), 'TOKEN=abc\n')
  writeFileSync(join(dir, '.env.local'), 'TOKEN=abc\n')
  try {
    const f = await survey(dir)
    const byFile = Object.fromEntries(f.risks.secretFiles.map((x) => [x.file, x.status]))
    if (byFile['.env'] !== 'exposed') return `.env 状态是 ${byFile['.env']}`
    if (byFile['.env.local'] !== 'ignored') return `.env.local 状态是 ${byFile['.env.local']}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['没有版本库时敏感文件判 undetermined（没查，不是没忽略）', async () => {
  const dir = tmpProject({ '.gitignore': '.env.local\n', '.env.local': 'TOKEN=abc\n', 'README.md': '# a\n' })
  try {
    const f = await survey(dir)
    const hit = f.risks.secretFiles.find((x) => x.file === '.env.local')
    if (!hit) return '没扫到这个文件'
    if (hit.status !== 'undetermined') return `status=${hit.status}`
    if (f.gaps.some((g) => /未忽略的敏感文件/.test(g))) return '把它报成了未忽略的缺口'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['已入库的凭据形状判 tracked', async () => {
  // **夹具里的凭据形状在运行时拼出来**，源码里不留字面量。
  // 留了的话，这个仓库自己的交付体检会把 fixtures.mjs 报成「凭据已进版本库」——
  // 那条判据是对的，错的是把假凭据当成源码写进去。
  const fake = `ghp_${'abcdefghijklmnopqrstuvwxyz0123456789'}`
  const dir = tmpProject({ 'config.js': `const k = "${fake}"\n` })
  gitInit(dir)
  try {
    const f = await survey(dir)
    const hit = f.risks.secretContent.find((c) => c.file === 'config.js')
    if (!hit) return '没扫到凭据形状'
    if (hit.status !== 'tracked') return `status=${hit.status}`
    if (!hit.line) return '没给行号'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['未忽略的 node_modules 判成缺口', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0"}', 'node_modules/x/i.js': '1\n' })
  gitInit(dir)
  try {
    const f = await survey(dir)
    if (!f.ignores.unignoredOutputDirs.includes('node_modules')) {
      return `unignoredOutputDirs=${JSON.stringify(f.ignores.unignoredOutputDirs)}`
    }
    return true
  } finally { rmTree(dir) }
}])

// ── 门禁：结论与提示 ────────────────────────────────────────────────

cases.push(['没有 CI 时提示的 flag 键必须是 no-ci（文案漂移回归）', async () => {
  const dir = tmpProject({ 'README.md': '# a\n\n一个小项目，说明足够长以通过长度检查。\n', 'package.json': '{"name":"a","version":"1.0.0"}' })
  try {
    const r = await runNode('review.mjs', [dir, '--json'])
    const data = JSON.parse(r.stdout)
    const item = data.results.find((x) => x.id === 'ci.absent')
    if (!item) return '没有 ci.absent 这一条'
    if (item.decision !== 'no-ci') return `decision=${item.decision}`
    if (item.level !== 'notice') return `level=${item.level}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['有远端但缺 PR 模板时提示的键是 no-collab-templates（文案漂移回归）', async () => {
  const dir = tmpProject({ 'README.md': '# a\n\n说明足够长以通过长度检查，内容真实。\n' })
  gitInit(dir)
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/x/y.git'], { cwd: dir, stdio: 'ignore' })
  try {
    const r = await runNode('review.mjs', [dir, '--json'])
    const data = JSON.parse(r.stdout)
    const item = data.results.find((x) => x.id === 'collab.pr-template')
    if (!item) return '没有 collab.pr-template 这一条'
    if (item.decision !== 'no-collab-templates') return `decision=${item.decision}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['LICENSE 相关的指路指向 docs-set.md 的「LICENSE」节（章节号漂移回归）', async () => {
  const dir = tmpProject({ 'README.md': '# a\n\n说明足够长以通过长度检查，内容真实。\n', 'package.json': '{"name":"a","version":"1.0.0","license":"MIT"}' })
  try {
    const r = await runNode('review.mjs', [dir, '--json'])
    const data = JSON.parse(r.stdout)
    const item = data.results.find((x) => x.id === 'license.publishable')
    if (!item) return '没有 license.publishable 这一条'
    if (!item.ref || item.ref.file !== 'references/docs-set.md') return `ref=${JSON.stringify(item.ref)}`
    // 断言「指到 LICENSE 那一节」，而不是「指到第几节」：节号会随增删章节失效，
    // 标题不会。preflight 另有一条判据核对这个标题真的存在。
    if (!/LICENSE/.test(item.ref.section)) return `section=${item.ref.section}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['pwn request 形状判 [缺]，只用了触发器但没检出提案代码则放行', async () => {
  const bad = tmpProject({
    'README.md': '# a\n',
    '.github/workflows/ci.yml': 'on: pull_request_target\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n',
  })
  const good = tmpProject({
    'README.md': '# a\n',
    '.github/workflows/ci.yml': 'on: pull_request_target\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo label\n',
  })
  try {
    const rb = JSON.parse((await runNode('review.mjs', [bad, '--json'])).stdout)
    const rbm = rb.results.find((x) => x.id === 'ci.pwn-request')
    if (!rbm || rbm.level !== 'missing') return `危险形状被判成 ${rbm && rbm.level}`
    const rg = JSON.parse((await runNode('review.mjs', [good, '--json'])).stdout)
    const rgm = rg.results.find((x) => x.id === 'ci.pwn-request')
    if (rgm) return `合法用法被误报成 ${rgm.level}`
    return true
  } finally {
    rmTree(bad)
    rmTree(good)
  }
}])

cases.push(['「## 取舍」里表过态的决定不再报 [待定]', async () => {
  const dir = tmpProject({
    'README.md': '# a\n\n说明足够长以通过长度检查，内容真实。\n',
    'AGENTS.md': '# a\n\n## 取舍\n\n- `license`：不放，个人项目\n- `no-ci`：不配\n',
  })
  try {
    const r = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
    const license = r.results.find((x) => x.id === 'license.missing')
    if (!license) return '没有 license.missing 这一条'
    if (license.level !== 'ok') return `表态后仍是 ${license.level}`
    const ci = r.results.find((x) => x.id === 'ci.absent')
    if (ci && ci.level !== 'ok') return `no-ci 表态后仍是 ${ci.level}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['CLI 上不再有 --remember / --no-* 这类开关', async () => {
  const r = await runNode('review.mjs', ['--help'])
  for (const bad of ['--remember', '--forget', '--no-ci', '--no-bilingual', '--pr-template-kept']) {
    if ((r.stdout || '').includes(bad)) return `help 里还有 ${bad}`
  }
  return true
}])

// ── 生成：标记与幂等 ────────────────────────────────────────────────

cases.push(['生成后在目标项目里零侵入：没有隐藏目录、没有拷进来的脚本', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0","private":true}' })
  try {
    await runNode('compose-agents.mjs', [dir])
    if (existsSync(join(dir, '.project-forge'))) return '留下了 .project-forge/'
    if (existsSync(join(dir, 'scripts'))) return '留下了 scripts/'
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const nonMarker = agents.split('\n').filter((l) => l.includes('project-forge') && !/project-forge:\s*(begin|end|fill)/.test(l))
    if (nonMarker.length > 0) return `非标记行里出现了 project-forge：${nonMarker[0]}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['手写的 AGENTS.md 不被改动', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"a","version":"1.0.0"}',
    'AGENTS.md': '# 我手写的\n\n## 项目定位\n\n这是我自己写的，别动。\n',
  })
  try {
    const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    await runNode('compose-agents.mjs', [dir])
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (before !== after) return '手写文件被改了'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['连跑三次 compose，第二次起字节不变（幂等）', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0","scripts":{"test":"node --test"}}' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const h1 = readFileSync(join(dir, 'AGENTS.md'))
    await runNode('compose-agents.mjs', [dir])
    const h2 = readFileSync(join(dir, 'AGENTS.md'))
    await runNode('compose-agents.mjs', [dir])
    const h3 = readFileSync(join(dir, 'AGENTS.md'))
    if (!h1.equals(h2) || !h2.equals(h3)) return '第二遍或第三遍改了文件'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['未填占位时 --check 红；填完删掉标记后转绿', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0"}' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const c1 = await runNode('compose-agents.mjs', [dir, '--check'])
    if (c1.status === 0) return '未填占位时 --check 放行了'
    const filled = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace(/<!-- project-forge: fill [^>]*-->/g, '已填写。')
    writeFileSync(join(dir, 'AGENTS.md'), filled)
    const c2 = await runNode('compose-agents.mjs', [dir, '--check'])
    if (c2.status !== 0) return `填完之后 --check 仍红：${(c2.stderr || '').trim().split('\n')[0]}`
    return true
  } finally { rmTree(dir) }
}])

// ── 交棒 ────────────────────────────────────────────────────────────

cases.push(['handoff 扫得到标记，剥掉之后判干净', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0"}' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const h1 = await runNode('handoff.mjs', [dir, '--verify'])
    if (h1.status === 0) return '还有标记时 --verify 说干净'
    await runNode('compose-agents.mjs', [dir, '--clean'])
    const h2 = await runNode('handoff.mjs', [dir, '--verify'])
    if (h2.status !== 0) return '剥掉标记后 --verify 仍说脏'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['handoff 不动手：--scan 前后项目字节完全一致', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0"}' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const before = readFileSync(join(dir, 'AGENTS.md'))
    await runNode('handoff.mjs', [dir, '--scan'])
    const after = readFileSync(join(dir, 'AGENTS.md'))
    if (!before.equals(after)) return '--scan 改了文件'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['handoff 认得出旧版留下的账本目录', async () => {
  const dir = tmpProject({ 'README.md': '# a\n', '.project-forge/ledger.json': '{"version":1}\n' })
  try {
    const r = await runNode('handoff.mjs', [dir, '--json'])
    const data = JSON.parse(r.stdout)
    if (!data.legacyPaths.some((p) => p.path === '.project-forge')) return '没报出旧版账本目录'
    if (data.clean === true) return '有旧版残留却判成干净'
    return true
  } finally { rmTree(dir) }
}])

// ── 生成：占位符与条件块 ────────────────────────────────────────────

cases.push(['没有命令的项目：产物里没有残留占位符，且留了要人填的位', async () => {
  const dir = tmpProject({ 'README.md': '# 手册\n\n一个纯文档项目，说明足够长。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    // 反面：占位符原样留在用户文件里。它看起来像「这里本来就该有一段命令」，
    // 于是没人发现，直到有人照着它去找命令。
    const leftover = [...agents.matchAll(/\{\{[A-Z0-9_]+\}\}/g)].map((m) => m[0])
    if (leftover.length > 0) return `产物里还有未替换的占位符：${leftover.join('、')}`
    if (!/project-forge:\s*fill 构建与验证命令/.test(agents)) return '没有留下「构建与验证命令」的待填位'
    // 条件块必须一个都不剩：它回答的是「这个项目该不该有这一节」，那个问题在生成时就答完了。
    if (/project-forge:\s*(?:if|endif)/.test(agents)) return '产物里还有 if/endif 条件块'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['有命令的项目：命令写进产物，且不再留占位', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0","scripts":{"test":"node --test"}}' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!agents.includes('npm test')) return '产物里没有探到的测试命令'
    if (/project-forge:\s*fill 构建与验证命令/.test(agents)) return '有命令了还留着「还没声明命令」的待填位'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['多生态项目：两套命令都在产物里，不只留一份', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"web","version":"1.0.0","private":true,"scripts":{"test":"node --test"}}',
    'pyproject.toml': '[project]\nname = "api"\nversion = "1.0.0"\n',
    // 后端也给一份测试证据：命令只按**项目里真实存在的东西**给，不按生态惯例编。
    'tests/test_api.py': 'def test_ok():\n    assert True\n',
  })
  try {
    const f = await survey(dir)
    const buckets = Object.keys(f.commandsByEcosystem ?? {})
    if (!buckets.includes('node') || !buckets.includes('python')) return `commandsByEcosystem=${buckets.join(',')}`
    await runNode('compose-agents.mjs', [dir])
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!agents.includes('npm test')) return '产物里没有前端命令'
    if (!agents.includes('pytest')) return '产物里没有后端命令——只测一半的 CI 看起来完全正常'
    if (!/^# --- node ---$/m.test(agents) || !/^# --- python ---$/m.test(agents)) return '多生态命令没有按生态分段'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['受管区间被手删之后，重跑会把它补回来，且填过的人工内容不动', async () => {
  const dir = tmpProject({ 'README.md': '# a\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const first = readFileSync(join(dir, 'AGENTS.md'), 'utf8')

    // 填掉项目定位，模拟维护者读过并写过了。
    const filled = first.replace(
      /<!-- project-forge: begin 项目定位 -->\n## 项目定位\n\n[\s\S]*?<!-- project-forge: end 项目定位 -->/,
      '<!-- project-forge: begin 项目定位 -->\n## 项目定位\n\n我手写的定位，一个字都不许动。\n<!-- project-forge: end 项目定位 -->',
    )
    // 再把「高风险路径」整段删掉，模拟一份来自更早模板的文件。
    const trimmed = filled.replace(
      /<!-- project-forge: begin 高风险路径 -->[\s\S]*?<!-- project-forge: end 高风险路径 -->\n*/,
      '',
    )
    if (/begin 高风险路径/.test(trimmed)) throw new Error('夹具没删掉那一节')
    writeFileSync(join(dir, 'AGENTS.md'), trimmed)
    writeFileSync(join(dir, 'package.json'), '{"name":"a","version":"1.0.0","scripts":{"test":"node --test"}}')

    await runNode('compose-agents.mjs', [dir])
    const second = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!second.includes('我手写的定位，一个字都不许动。')) return '填过的项目定位被覆盖了'
    if (!/project-forge: begin 高风险路径/.test(second)) return '缺的受管区间没有被补回来'
    if (!second.includes('npm test')) return '新出现的测试命令没有被写进契约'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['手写 AGENTS.md --upgrade：补齐核心节，原节一字未动，不重复追加同义节', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"a","version":"1.0.0"}',
    'AGENTS.md': '# a\n\n## 项目定位\n\n手写的。\n\n## 构建与测试\n\n自己那套。\n',
  })
  try {
    const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    await runNode('compose-agents.mjs', [dir, '--upgrade'])
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!after.startsWith(before.trimEnd())) return '原有内容被改动了（--upgrade 只许追加）'
    if (!/## 架构与关键不变量/.test(after)) return '没有补上「架构与关键不变量」'
    if (!/## 高风险路径/.test(after)) return '没有补上「高风险路径」'
    // 「## 构建与测试」与模板的「构建与验证」是同一件事：按标题名精确匹配会导致
    // 整节被重复追加一遍，而重复的那节通常没人读，两份内容从此各自漂移。
    const buildHits = (after.match(/^##\s+(?:环境与)?构建与(?:验证|测试)/gm) ?? []).length
    if (buildHits > 1) return `「构建与验证」被追加了 ${buildHits} 份——同义标题没有认出来`
    return true
  } finally { rmTree(dir) }
}])

// ── 风险：本机路径分类 ──────────────────────────────────────────────

cases.push(['测试夹具里的本机路径判 test-data，源码里的同一条判 leak', async () => {
  const { homedir: home } = await import('node:os')
  const leak = `${home()}${home().includes('\\') ? '\\' : '/'}secret-config`
  const dir = tmpProject({
    'tests/fixture.txt': `path=${leak}\n`,
    'src/config.js': `const p = "${leak}"\n`,
    'README.md': '# a\n',
  })
  try {
    const f = await survey(dir)
    const byFile = Object.fromEntries(f.risks.homePathLeaks.map((x) => [x.file, x.category]))
    if (byFile['tests/fixture.txt'] !== 'test-data') return `tests/fixture.txt 判成 ${byFile['tests/fixture.txt']}`
    if (byFile['src/config.js'] !== 'leak') return `src/config.js 判成 ${byFile['src/config.js']}`
    const r = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
    const hit = r.results.find((x) => x.id === 'secrets.home-paths')
    if (!hit) return '体检没报真泄露'
    if (hit.title.includes('tests/fixture.txt')) return '体检把测试夹具报成了泄露——修它的人会先去改掉那份有用的夹具'
    return true
  } finally { rmTree(dir) }
}])

// ── 发布：标签形状 ──────────────────────────────────────────────────

cases.push(['插件项目打了带 v 的标签判 [缺]，裸版本号放行', async () => {
  const files = {
    'package.json': '{"name":"demo","version":"1.0.0"}',
    'manifest.json': '{"id":"demo","name":"Demo","version":"1.0.0","minAppVersion":"1.0.0"}\n',
    'README.md': '# a\n\n说明足够长以通过长度检查。\n',
  }
  const bad = tmpProject(files)
  const good = tmpProject(files)
  try {
    gitInit(bad)
    spawnSync('git', ['tag', 'v1.0.0'], { cwd: bad, stdio: 'ignore' })
    const rb = JSON.parse((await runNode('review.mjs', [bad, '--json'])).stdout)
    const hit = rb.results.find((x) => x.id === 'release.observed-v-tag')
    if (!hit || hit.level !== 'missing') return `带 v 的标签被判成 ${hit && hit.level}`

    gitInit(good)
    spawnSync('git', ['tag', '1.0.0'], { cwd: good, stdio: 'ignore' })
    const rg = JSON.parse((await runNode('review.mjs', [good, '--json'])).stdout)
    const falsePositive = rg.results.find((x) => x.id === 'release.observed-v-tag')
    if (falsePositive) return `裸版本号被误报成 ${falsePositive.level}`
    return true
  } finally {
    rmTree(bad)
    rmTree(good)
  }
}])

// ── 交棒：退出码三档 ────────────────────────────────────────────────

cases.push(['handoff 的 --verify 干净退出 0，有痕迹退出 1', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0"}' })
  try {
    const clean = await runNode('handoff.mjs', [dir, '--verify'])
    if (clean.status !== 0) return `本来就干净却退出 ${clean.status}`
    await runNode('compose-agents.mjs', [dir])
    const dirty = await runNode('handoff.mjs', [dir, '--verify'])
    if (dirty.status !== 1) return `有痕迹却退出 ${dirty.status}（1 才是「还有东西」）`
    return true
  } finally { rmTree(dir) }
}])

// ── 围栏里的标记：不能当标记，也不能当「已填」 ────────────────────

cases.push(['围栏里的 fill 不算数：--check 与 handoff 数到的一样多，且不会冲掉人填的内容', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n纯文档项目，说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')

    // 三处必须给出同一个数：文件里肉眼能数到的、--check 报的、handoff 认到的。
    // 三处不一致的后果是这一条：用户填完之后 --check 绿了，再跑一次生成又被冲回占位。
    const rawCount = (agents.match(/project-forge:\s*fill/g) ?? []).length
    const check = await runNode('compose-agents.mjs', [dir, '--check'])
    const checkCount = Number((/还有 (\d+) 处未填/.exec(check.stderr) ?? [])[1])
    const handoff = JSON.parse((await runNode('handoff.mjs', [dir, '--json'])).stdout)
    if (checkCount !== rawCount) return `--check 报 ${checkCount} 处，文件里有 ${rawCount} 处`
    if (handoff.placeholders.length !== rawCount) return `handoff 认到 ${handoff.placeholders.length} 处，文件里有 ${rawCount} 处`

    // 用真实的填法：删掉整行 fill 标记，在代码块里写命令。再跑一次不能把它冲掉。
    const filled = agents.replace(
      /^<!-- project-forge: fill 构建与验证命令[^\n]*-->$/m,
      'node --test  # 测试',
    )
    writeFileSync(join(dir, 'AGENTS.md'), filled)
    await runNode('compose-agents.mjs', [dir])
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!after.includes('node --test  # 测试')) return '人填的命令被刷新冲掉了'
    if (after.includes('填这个项目真实的构建')) return '该节被冲回了占位'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['插入的新节按模板顺序排，不颠倒', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    // 把前两节删掉，模拟一份来自更早模板的文件。
    let text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    for (const id of ['项目定位', '架构与关键不变量']) {
      text = text.replace(new RegExp(`<!-- project-forge: begin ${id} -->[\\s\\S]*?<!-- project-forge: end ${id} -->\\n*`), '')
    }
    writeFileSync(join(dir, 'AGENTS.md'), text)
    await runNode('compose-agents.mjs', [dir])
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const order = [...after.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1])
    const posProject = order.findIndex((h) => h.includes('项目定位'))
    const posArch = order.findIndex((h) => h.includes('架构'))
    if (posProject < 0 || posArch < 0) return `补回来的节不齐：${order.join(' | ')}`
    if (posProject > posArch) return `顺序反了：项目定位在第 ${posProject} 位，架构在第 ${posArch} 位`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['同义标题：带编号的认得出、泛指的「验证流程」不算构建节、正文里提到也不算已有', async () => {
  const dir = tmpProject({ 'package.json': '{"name":"a","version":"1.0.0"}' })
  try {
    const cases = [
      // 带编号的标题必须认出来，否则已有节会被重复追加
      { body: '# a\n\n## 1. 项目定位\n\n手写。\n\n## 2. 构建与验证\n\n手写命令。\n', expect: 'no-dup-build' },
      // 「验证流程」讲的是审查流程，不是构建命令；构建节必须补进来
      { body: '# a\n\n## 项目定位\n\n手写。\n\n## 验证流程\n\n讲审查流程的。\n', expect: 'need-build' },
      // 正文里偶然提到那几个字，不等于已经有那一节
      { body: '# a\n\n## 项目定位\n\n手写。\n\n正文里顺口提到一句构建与验证的事。\n', expect: 'need-build' },
    ]
    for (const c of cases) {
      writeFileSync(join(dir, 'AGENTS.md'), c.body)
      await runNode('compose-agents.mjs', [dir, '--upgrade'])
      const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      // 构建节的标题可能叫「构建与验证」或「环境与构建验证」，判据是它同时含这两个词。
      const buildHits = [...after.matchAll(/^##\s+.*$/gm)]
        .map((m) => m[0])
        .filter((h) => h.includes('构建') && h.includes('验证')).length
      if (c.expect === 'need-build' && buildHits === 0) return `该补的构建节没补：${c.body.slice(0, 30)}`
      if (c.expect === 'no-dup-build' && buildHits > 1) return `构建节被重复追加了 ${buildHits} 份`
      const projectHits = (after.match(/^##\s+.*项目定位/gm) ?? []).length
      if (projectHits > 1) return `项目定位被重复追加了 ${projectHits} 份`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['目标项目自带 references/ 时，里面的标记照样扫得到', async () => {
  const dir = tmpProject({
    'README.md': '# a\n',
    'references/arch.md': '<!-- project-forge: begin 架构 -->\n# arch\n<!-- project-forge: end 架构 -->\n',
  })
  try {
    // 这条治的是一个假「干净」：把 references/ 一律当成 skill 自己的目录跳过，
    // 于是目标项目自己的 references/ 里那些标记永远扫不到，而 --verify 是交棒前唯一一道关。
    const r = await runNode('handoff.mjs', [dir, '--verify'])
    if (r.status === 0) return '目标项目 references/ 里有标记，--verify 却说干净'
    const j = JSON.parse((await runNode('handoff.mjs', [dir, '--json'])).stdout)
    if (!j.markers.some((m) => m.file === 'references/arch.md')) return '没扫到 references/ 里的标记'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['模板改了而本仓库实例没跟上时，--check 会红；刷新能把规则带回来', async () => {
  // 这一条守的是「自举只有结构、没有内容」：受管区间里没有 fill 的那几段，正文完全由事实
  // 推出来，本该与模板渲染结果逐字相同。模板加了规则而实例没跟上，必须有东西报出来，
  // 否则「它教别人做、自己没做到」会一路绿着过去。
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])

    // 先把所有占位填掉：漂移判据只在「已经填完」的契约上才有意义。
    const filled = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(dir, 'AGENTS.md'), filled)
    const good = await runNode('compose-agents.mjs', [dir, '--check'])
    if (good.status !== 0) return `填完之后就没过 --check：${(good.stderr || '').trim().split('\n')[0]}`

    // 模拟「模板加了规则、实例还停在旧版」：往受管区间里塞一条模板没有的内容。
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const tampered = text.replace(
      /(- \*\*一票否决红线\*\*)/,
      '- 这是实例里多出来的一条，模板里没有。\n\n$1',
    )
    if (tampered === text) return '夹具没找到可以插入的位置'
    writeFileSync(join(dir, 'AGENTS.md'), tampered)

    const drifted = await runNode('compose-agents.mjs', [dir, '--check'])
    if (drifted.status === 0) return '内容与模板不一致，--check 却放行了'
    if (!/与模板不一致/.test(drifted.stderr || '')) return `报错了但不是漂移那条判据：${(drifted.stderr || '').trim().split('\n')[0]}`

    await runNode('compose-agents.mjs', [dir])
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (after.includes('实例里多出来的一条')) return '刷新没有把实例拉回模板（多出来的内容还在）'
    if (!after.includes('一票否决红线')) return '刷新把模板里的规则弄丢了'
    const again = await runNode('compose-agents.mjs', [dir, '--check'])
    if (again.status !== 0) return `刷新之后 --check 仍然红：${(again.stderr || '').trim().split('\n')[0]}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['默认分支名换个环境算出来不一样，不算漂移；真加了规则才算', async () => {
  // 受管区间里有一部分正文来自「跑在哪台机器上」：默认分支名可能取自 origin/HEAD（本地有、
  // 浅检出里常常没有），也可能取自 init.defaultBranch（开发机设了、CI 上没有）。同一个项目
  // 在两台机器上渲染出两个不同的分支名——那是换了个地方跑，不是模板变了。
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const filled = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(dir, 'AGENTS.md'), filled)

    const ok = await runNode('compose-agents.mjs', [dir, '--check'])
    if (ok.status !== 0) return `填完之后没过：${(ok.stderr || '').trim().split('\n')[0]}`

    // 模拟另一台机器：同一个项目、换一个默认分支名。
    const renamed = filled.replace(/git switch main\b/g, 'git switch trunk')
    if (renamed === filled) return '夹具没找到分支名'
    writeFileSync(join(dir, 'AGENTS.md'), renamed)
    const renamedCheck = await runNode('compose-agents.mjs', [dir, '--check'])
    if (renamedCheck.status !== 0) {
      return `换个分支名就被判成漂移了：${(renamedCheck.stderr || '').trim().split('\n')[0]}`
    }

    // 但真的多了一条模板里没有的规则，必须报。
    const drifted = renamed.replace(/(- \*\*一票否决红线\*\*)/, '- 实例里多出来的一条。\n\n$1')
    writeFileSync(join(dir, 'AGENTS.md'), drifted)
    const driftCheck = await runNode('compose-agents.mjs', [dir, '--check'])
    if (driftCheck.status === 0) return '真漂移被掩码掩盖了'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['交棒扫到自己家时给「不适用」，既不是「干净」也不是「有痕迹」', async () => {
  // 交棒是「把一个项目从这套流程里摘出来」。skill 自己的仓库摘不出来——它就是这套流程，
  // 它的 templates/ 与 references/ 里的标记是语法与讲解，删掉会把工具弄坏。
  // 这里守的是「这个判断得由代码做，不是靠文档里写一句话」：
  // 判据是「目标目录等于脚本所在的 skill 根」，一条结构性事实，与它叫什么都无关。
  const self = SKILL_ROOT
  const verify = await runNode('handoff.mjs', [self, '--verify'])
  if (verify.status === 0) return '扫到自己家时说了「干净」——那会让下一个人以为可以删'
  if (verify.status === 1) return '扫到自己家时说了「还有痕迹」——那会让人去删自己的语法'
  if (verify.status !== 4) return `退出码应是 4（不适用），实际 ${verify.status}`

  const json = JSON.parse((await runNode('handoff.mjs', [self, '--json'])).stdout)
  if (json.selfScan !== true) return 'JSON 结果里没标出这是自扫'

  // 反面：换一个普通项目（哪怕它也有一份 SKILL.md），就必须按正常规则扫，不能误判成自扫。
  const other = tmpProject({
    'SKILL.md': '---\nname: project-forge\ndescription: 一个长得一样的副本\n---\n\n# 副本\n',
    'templates/x.md': '<!-- project-forge: begin x -->\n# x\n<!-- project-forge: end x -->\n',
  })
  try {
    const otherJson = JSON.parse((await runNode('handoff.mjs', [other, '--json'])).stdout)
    if (otherJson.selfScan !== false) return '一个同名的副本被误判成 skill 自己的仓库了'
    if (otherJson.total === 0) return '副本里的标记没扫到'
    const otherVerify = await runNode('handoff.mjs', [other, '--verify'])
    if (otherVerify.status !== 1) return `副本应报「还有痕迹」（1），实际 ${otherVerify.status}`
    return true
  } finally { rmTree(other) }
}])

cases.push(['有远端与没远端拿到的是两段不同的正文，不是同一段加一句', async () => {
  // 早先模板里写着「没有远端时只有本地提交」，但它不在任何条件块里——于是**有远端**的项目
  // 也照抄了这一句。读的人会以为自己漏了一步（远端明明配好了）。这类错误不报错，
  // 只让文档自相矛盾，所以两面都要立夹具。
  const withRemote = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  const withoutRemote = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: withRemote })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'add', '-A'], { cwd: withRemote })
    spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init'], { cwd: withRemote })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/a/b.git'], { cwd: withRemote })
    await runNode('compose-agents.mjs', [withRemote])
    await runNode('compose-agents.mjs', [withoutRemote])

    const a = readFileSync(join(withRemote, 'AGENTS.md'), 'utf8')
    const b = readFileSync(join(withoutRemote, 'AGENTS.md'), 'utf8')

    // 有远端：讲分支与 PR，不能出现「还没有远端」
    if (!a.includes('先核对远端与源仓库')) return '有远端的项目里缺了维护者/贡献者那段'
    if (a.includes('还没有远端')) return '有远端的项目里出现了「还没有远端」——自相矛盾'
    // 没远端：反过来，不能出现「从 main 拉新分支」这种要求
    if (!b.includes('还没有远端')) return '没远端的项目里缺了「只有本地提交」那段'
    if (b.includes('先核对远端与源仓库')) return '没远端的项目里出现了远端那一段'
    // 两边都必须保留独立审查这条底线——它不依赖远端
    if (!a.includes('独立审查') || !b.includes('独立审查')) return '两边都该讲独立审查，其中一边漏了'
    return true
  } finally { rmTree(withRemote); rmTree(withoutRemote) }
}])

cases.push(['契约里明确写了「日常只到推送、说发版才发」', async () => {
  // 这条守的是一条**行为边界**，不是措辞：默认只做提交 + 推送，发版要人点头。
  // 它容易在改写时被顺手删掉——因为读起来像一句废话。删掉之后没有东西会报错，
  // 只会在某一天由执行者自己判断「该发版了」，然后把一个撤不回的版本推出去。
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const need = [
      ['日常', '不打标签'],
      ['发版', '明确说'],
      ['不自己判断'],
      ['日常到此为止'],
    ]
    for (const words of need) {
      if (!words.every((w) => text.includes(w))) return `契约里缺了「${words.join(' + ')}」这条边界`
    }
    return true
  } finally { rmTree(dir) }
}])

// ── W1：lib 契约与围栏状态机 ─────────────────────────────────────────

cases.push(['apiTarget 只交出能直接用的地址；拼错的零件不会漏到调用方', async () => {
  const { apiTarget } = await import('../lib/protocol.mjs')
  const { apiEndpoint } = await import('../update.mjs')

  const target = apiTarget('https://github.com/acme/demo')
  if (!target) return '一个合法的 GitHub 地址却认不出来'
  if (!/^https:\/\/api\.github\.com\/repos\/acme\/demo\/releases\/latest$/.test(target.latest)) {
    return `latest 拼错：${target.latest}`
  }

  // 正面：主路真的拼得出一个完整地址，任何一段都不是 undefined。
  const endpoint = apiEndpoint('https://github.com/acme/demo')
  if (!endpoint || /undefined/.test(endpoint)) return `接口地址里有洞：${endpoint}`

  // 反面：不是 GitHub 的来源不猜，宁可让调用方走网页路。
  if (apiTarget('https://code.example.com/acme/demo') !== undefined) return '非 GitHub 地址也被拼出了接口地址'
  if (apiTarget('not a url') !== undefined) return '一段乱码被当成了地址'

  // 反面：排路时不能凭空多出接口路。
  const { routesFor } = await import('../update.mjs')
  const routes = routesFor('https://mirror.internal:9000')
  if (routes.some((r) => r.kind === 'api')) return '认不出的来源却排出了接口路'
  if (!routes.some((r) => r.kind === 'web')) return '网页路这条兜底没了'
  return true
}])

cases.push(['临时文件清理：传文件只清这个文件，传目录才扫全部；活的进程的不动', async () => {
  const { clearStaleTemps } = await import('../lib/fs-atomic.mjs')
  const d = mkdtempSync(join(tmpdir(), 'pf-temp-'))
  // 造一个**真的还活着**的别的进程：本进程自己的 pid 挡不住「属主活着」那条判据
  // （那条判据里另有 `pid === process.pid` 这一半），所以这里必须是一个陌生 pid。
  const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
  try {
    const f = join(d, 'a.md')
    writeFileSync(f, 'x')
    writeFileSync(`${f}.tmp-999999`, 'stale')                  // 死进程，该清
    writeFileSync(join(d, 'b.md.tmp-999998'), 'other stale')    // 别的文件，文件级不该碰
    writeFileSync(`${f}.tmp-${process.pid}`, 'mine')            // 本进程，不动
    writeFileSync(`${f}.tmp-${other.pid}`, 'live neighbour')    // 活着的别的进程，不动
    writeFileSync(`${f}.tmp-backup`, 'not ours')                // 后缀不是数字，不动

    // 正面：返回形状是对象，取 .kept 不抛（旧实现在这里当场 TypeError）。
    const one = clearStaleTemps(f)
    if (!Array.isArray(one.removed) || !Array.isArray(one.kept)) return '返回值不是 { removed, kept }'
    if (one.removed.length !== 1) return `文件级清掉了 ${one.removed.length} 个，应该只有 1 个`
    if (!one.kept.some((p) => p.endsWith(`.tmp-${process.pid}`))) return '本进程的临时文件没进 kept'
    // 关键的反面：活着的邻居进程那一份不许动。删掉「属主活着就留」这条判据时，
    // 唯一能抓到它的就是这个断言。
    if (!existsSync(`${f}.tmp-${other.pid}`)) return '删掉了另一个仍在运行的进程的临时文件'
    if (!existingKept(one, other.pid)) return '活进程的临时文件没进 kept，报告会漏说'
    if (!existsSync(join(d, 'b.md.tmp-999998'))) return '文件级清理越界删了别的文件的临时文件'
    if (!existsSync(`${f}.tmp-backup`)) return '后缀不是数字的也被删了'

    // 反面：换目录级，那一份就该被清掉。
    const all = clearStaleTemps(d, { dryRun: true })
    if (!all.removed.some((p) => p.endsWith('b.md.tmp-999998'))) return '目录级没有扫到别的临时文件'
    if (!existsSync(join(d, 'b.md.tmp-999998'))) return 'dryRun 模式下删了文件'
    return true
  } finally {
    other.kill()
    rmTree(d)
  }
}])

cases.push(['剥标记不碰围栏里的示例，也不碰行内代码里的举例', async () => {
  const { stripMarkers, parseMarkers } = await import('../lib/protocol.mjs')
  const F = '`'.repeat(3)
  const text = [
    '<!-- project-forge: begin 真节 -->',
    '正文。',
    '<!-- project-forge: end 真节 -->',
    '',
    `${F}md`,
    '<!-- project-forge: begin 示例 -->',
    F,
    '',
    '正文里举例：`<!-- project-forge: fill 行内示例 -->`',
  ].join('\n')

  // 正面：围栏外的真标记被剥掉。
  const stripped = stripMarkers(text, 'x.md')
  if (stripped.includes('begin 真节')) return '围栏外的真标记没被剥'
  // 反面：围栏里的示例与行内举例必须留着——那是内容，删掉就是删使用者自己的正文。
  if (!stripped.includes('begin 示例')) return '围栏里的示例被剥掉了'
  if (!stripped.includes('fill 行内示例')) return '行内代码里的举例被剥掉了'
  if (!stripped.includes(F)) return '围栏本身被剥掉了'

  // 解析这一侧也要一致：围栏里的不算标记。
  const kinds = parseMarkers(text, 'x.md').map((m) => `${m.kind}:${m.id ?? m.what}`)
  if (!kinds.includes('begin:真节')) return `真标记没解析出来：${kinds.join(',')}`
  if (kinds.some((k) => k.includes('示例'))) return `围栏里的示例被当成了真标记：${kinds.join(',')}`
  return true
}])

cases.push(['交棒扫描：行内代码里的路径不算悬空指针，临时文件单列一档', async () => {
  const d = tmpProject({
    'README.md': '正文里举例：`` `references/arch.md` `` 这句是示例。\n\n真引用：references/survey.md\n',
    'AGENTS.md.tmp-999999': 'stale tmp',
  })
  try {
    const r = JSON.parse((await runNode('handoff.mjs', [d, '--json'])).stdout)
    const targets = r.danglingPointers.map((p) => p.target)

    // 正面：真正的悬空指针还是报。
    if (!targets.includes('references/survey.md')) return `真悬空指针漏报了：${targets.join(',')}`
    // 反面：行内代码里举例的那个不许报。
    if (targets.includes('references/arch.md')) return '行内代码里的举例被当成了悬空指针'

    // 临时文件必须被扫到，而且是可清理的那一档。
    if (!Array.isArray(r.staleTemps) || r.staleTemps.length === 0) return '临时文件没被扫到'
    if (r.staleTemps.some((t) => t.alive)) return '把活进程的临时文件也当成了痕迹'
    if (r.clean) return '还有临时文件却说干净'
    return true
  } finally { rmTree(d) }
}])

cases.push(['compose --clean 顺手清掉自己写到一半留下的临时文件', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const stale = join(dir, 'AGENTS.md.tmp-999999')
    writeFileSync(stale, 'half written')
    await runNode('compose-agents.mjs', [dir, '--clean'])
    if (existsSync(stale)) return '--clean 之后那个临时文件还在'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['入口守卫按真实路径判：经链接调用也真跑', async () => {
  // 反面（结构）：六个脚本都必须从 lib/text.mjs 取入口判定，不再各写一份。
  const files = ['survey.mjs', 'compose-agents.mjs', 'review.mjs', 'handoff.mjs', 'sync-toc.mjs', 'update.mjs']
  for (const name of files) {
    const text = readFileSync(join(SCRIPTS, name), 'utf8')
    if (!/isMainModule\(/.test(text)) return `${name} 没有用 isMainModule 判入口`
    if (/process\.argv\[1\]\s*&&\s*samePath/.test(text)) return `${name} 还留着一份自己的入口判定`
  }

  // 正面：通过一条符号链接调用，脚本必须真的跑。
  // 字面比较在链接上永远不相等，那种实现在这里是「退出 0、零输出」——而调用方
  // 会把它读成「检查通过」。这就是这一条要守的东西。
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  const link = join(dir, 'linked-survey.mjs')
  try {
    try {
      symlinkSync(join(SCRIPTS, 'survey.mjs'), link, 'file')
    } catch {
      return true  // 限制环境下建不了链接：结构断言已经足够，不把环境限制当成失败
    }
    const out = spawnSync(process.execPath, [link, dir], { encoding: 'utf8', timeout: 60000 })
    if (out.status !== 0) return `经链接调用失败了：${(out.stderr || '').trim().split('\n')[0]}`
    if (!/"maturity"/.test(out.stdout)) return '经链接调用时什么都没输出——入口判定把它挡在了门外'
    return true
  } finally { rmTree(dir) }
}])

// ── W3：存量项目融合 ────────────────────────────────────────────────

cases.push(['受管区间标 customized 之后，改它不报漂移、刷新也不冲掉', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const fillAll = (text) => text.replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')

    // 正面：把「版本与发布」标成 customized，再塞一条项目自己的规矩。
    const customized = fillAll(readFileSync(join(dir, 'AGENTS.md'), 'utf8'))
      .replace('<!-- project-forge: begin 版本与发布 -->', '<!-- project-forge: begin 版本与发布 customized -->')
      .replace('## 版本管理与回滚底线\n', '## 版本管理与回滚底线\n\n- 本项目用 changesets 发版，发布由 CI 完成。\n')
    writeFileSync(join(dir, 'AGENTS.md'), customized)

    const ok = await runNode('compose-agents.mjs', [dir, '--check'])
    if (ok.status !== 0) return `标了 customized 还被判漂移：${(ok.stderr || '').trim().split('\n')[0]}`

    await runNode('compose-agents.mjs', [dir])
    if (!readFileSync(join(dir, 'AGENTS.md'), 'utf8').includes('changesets')) return '刷新把定制的那一段冲掉了'

    // 反面：把 flag 去掉，同一条定制必须重新算漂移——否则这个标记就成了「免检章」。
    const plain = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace('<!-- project-forge: begin 版本与发布 customized -->', '<!-- project-forge: begin 版本与发布 -->')
    writeFileSync(join(dir, 'AGENTS.md'), plain)
    const bad = await runNode('compose-agents.mjs', [dir, '--check'])
    if (bad.status === 0) return '去掉 customized 之后，定制内容仍被当成合格——那这条判据等于没有'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['手写契约删掉某一节的标记、留下同名小节时，不再追插一份', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      // 模拟「人把它接管了」：删掉这一对标记，正文原样留下。
      .replace('<!-- project-forge: begin 高风险路径 -->\n', '')
      .replace('<!-- project-forge: end 高风险路径 -->\n', '')
    writeFileSync(join(dir, 'AGENTS.md'), text)

    await runNode('compose-agents.mjs', [dir])
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const hits = (after.match(/^## 高风险路径.*$/gm) ?? []).length

    // 正面：标题还在，就不该插第二份。
    if (hits > 1) return `同一节被插了两份（${hits} 份）——接管过的节被追插了`
    if (hits === 0) return '正文被一起删掉了，那是另一回事'

    // 反面：连正文一起删掉时，照常补回来。
    const gone = after.replace(/^## 高风险路径[\s\S]*?(?=\n## |\n<!-- project-forge: begin |$)/m, '')
    writeFileSync(join(dir, 'AGENTS.md'), gone)
    await runNode('compose-agents.mjs', [dir])
    const restored = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!/^## 高风险路径/m.test(restored)) return '整节被删掉之后没有补回来'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['空壳手写 AGENTS.md 不放行；内容充实的仍放行', async () => {
  const shell = tmpProject({
    'README.md': '# d\n\n说明足够长以通过长度检查。\n',
    'AGENTS.md': '# AGENTS\n\n一句话。\n',
  })
  try {
    // 正面：一行标题的空壳必须被拦下——它看起来像有契约，实际什么都没有。
    const bad = await runNode('compose-agents.mjs', [shell, '--check'])
    if (bad.status === 0) return '空壳手写契约被放行了'
    if (!/不算一份契约/.test(bad.stderr || '')) return `报错了但不是空壳那条判据：${(bad.stderr || '').trim().split('\n')[0]}`

    // 反面：一份认真的手写契约不许被误伤。
    const real = tmpProject({
      'README.md': '# d\n\n说明足够长以通过长度检查。\n',
      'AGENTS.md': [
        '# demo 工程契约',
        '',
        '## 定位',
        '',
        '这是一个命令行工具，负责把目录整理成规范项目。不做部署、不做选型。',
        '',
        '## 构建与测试',
        '',
        '```sh',
        'npm ci',
        'npm test',
        '```',
        '',
        '## 修改规范',
        '',
        '- 先看再动，贴合既有结构；',
        '- 改完跑一遍上面两条命令，全绿才算完成；',
        '- 不引入第三方依赖。',
        '',
        '这几条合起来讲清了「这是什么、怎么验、改动边界在哪」，长度也够。',
      ].join('\n'),
    })
    try {
      const ok = await runNode('compose-agents.mjs', [real, '--check'])
      if (ok.status !== 0) return `内容充实的手写契约被拦下了：${(ok.stderr || '').trim().split('\n')[0]}`
      return true
    } finally { rmTree(real) }
  } finally { rmTree(shell) }
}])

cases.push(['既有 AI 约定文件按文件展开、报告里点名、fill 提示列出', async () => {
  const dir = tmpProject({
    'README.md': '# d\n\n说明足够长以通过长度检查。\n',
    'package.json': '{"name":"d","version":"1.0.0","scripts":{"test":"node --test"}}',
    'CLAUDE.md': '# claude\n',
    '.clinerules': 'rule\n',
    '.cursor/rules/a.mdc': 'rule a\n',
    '.cursor/rules/b.mdc': 'rule b\n',
    '.changeset/config.json': '{}\n',
    'commitlint.config.js': 'module.exports = {}\n',
  })
  try {
    const f = await survey(dir)
    const others = f.docs.otherAiConventions
    // 正面：目录要展开成具体文件，不能只报一个目录名。
    if (!others.includes('.cursor/rules/a.mdc') || !others.includes('.cursor/rules/b.mdc')) {
      return `目录没展开：${others.join('、')}`
    }
    if (!others.includes('.clinerules')) return '漏了 .clinerules'
    if (!f.conventions.workflowTooling.includes('.changeset/')) return '没探到 .changeset/'
    if (!f.conventions.workflowTooling.includes('commitlint.config.js')) return '没探到 commitlint'

    // 报告里必须点名，否则读报告的人不知道项目里还有另一份约定。
    const md = (await runNode('survey.mjs', [dir, '--markdown'])).stdout
    if (!/既有 AI 规则文件/.test(md)) return 'Markdown 报告里没提别的 AI 约定文件'
    if (!md.includes('.cursor/rules/a.mdc')) return '报告里没列出具体文件'

    // fill 提示里也要列出来，AI 才有机会去合流。
    await runNode('compose-agents.mjs', [dir])
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    if (!agents.includes('CLAUDE.md')) return 'fill 提示里没列出现有的约定文件'
    if (!agents.includes('.changeset/')) return 'fill 提示里没列出发版工具链'

    // 反面：一个干净的目录不该凭空多出这两项。
    const clean = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
    try {
      const g = await survey(clean)
      if (g.docs.otherAiConventions.length > 0) return '干净目录里凭空报出了别的约定文件'
      if (g.conventions.workflowTooling.length > 0) return '干净目录里凭空报出了发版工具链'
      return true
    } finally { rmTree(clean) }
  } finally { rmTree(dir) }
}])

// ── W4：场景适配 ────────────────────────────────────────────────────

cases.push(['命令按证据给：没有测试证据就不编一条', async () => {
  // 只有 requirements.txt 的 Python 项目：既不能 pip install -e .（没有 pyproject），
  // 也不该给 pytest（没有任何测试证据）。
  const plain = tmpProject({
    'README.md': '# d\n\n说明足够长。\n',
    'main.py': 'print(1)\n',
    'requirements.txt': 'requests\n',
  })
  try {
    const f = await survey(plain)
    if (f.commands.install !== 'pip install -r requirements.txt') return `install 是 ${f.commands.install}`
    if (f.commands.test !== undefined) return `凭空给了测试命令 ${f.commands.test}`

    // 反面（该有时必须有）：有 tests/ 就该给。
    const tested = tmpProject({
      'README.md': '# d\n\n说明足够长。\n',
      'main.py': 'print(1)\n',
      'requirements.txt': 'requests\n',
      'tests/test_a.py': 'def test_a():\n    assert True\n',
    })
    try {
      const g = await survey(tested)
      if (g.commands.test !== 'pytest') return `有 tests/ 却不给 pytest：${g.commands.test}`
      return true
    } finally { rmTree(tested) }
  } finally { rmTree(plain) }
}])

cases.push(['没有 gradlew 的 Gradle 项目用 gradle，有则用 ./gradlew', async () => {
  const noWrapper = tmpProject({
    'README.md': '# d\n\n说明足够长。\n',
    'build.gradle': 'plugins { id "java" }\n',
  })
  try {
    const f = await survey(noWrapper)
    if (!String(f.commands.build).startsWith('gradle ')) return `没有 gradlew 却用 ${f.commands.build}`
    if (String(f.commands.build).includes('./gradlew')) return './gradlew 在没有它的时候被用了'

    const withWrapper = tmpProject({
      'README.md': '# d\n\n说明足够长。\n',
      'build.gradle': 'plugins { id "java" }\n',
      'gradlew': '#!/bin/sh\n',
      'src/test/java/A.java': 'class A {}\n',
    })
    try {
      const g = await survey(withWrapper)
      if (!String(g.commands.build).startsWith('./gradlew')) return `有 gradlew 却用 ${g.commands.build}`
      if (g.commands.test !== './gradlew test') return `有测试证据却不给 test：${g.commands.test}`
      return true
    } finally { rmTree(withWrapper) }
  } finally { rmTree(noWrapper) }
}])

cases.push(['残缺血库不判 mature；六项齐全才是', async () => {
  const base = {
    'README.md': '# d\n\n说明足够长。\n',
    'index.js': 'console.log(1)\n',
    '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
  }
  const incomplete = tmpProject(base)
  const complete = tmpProject({
    ...base,
    // 六项齐全 = 有仓库 + README + AGENTS.md + .gitattributes + 远端 + CI。
    // 许可证不在「成熟度」里：放不放是**只有使用者能定**的事，它归体检的「待定」那一档。
    'LICENSE': 'MIT\n',
    'AGENTS.md': [
      '# d 工程契约', '', '## 定位', '',
      '这是一个演示项目，只用来跑夹具，不做别的事。', '',
      '## 构建与验证', '', '```sh', 'npm test', '```', '',
      '## 修改规范', '', '- 改完跑上面那条命令；', '- 不引入第三方依赖。',
    ].join('\n'),
    '.gitattributes': '* text=auto\n',
  })
  try {
    gitInit(incomplete)
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: incomplete, stdio: 'ignore' })
    gitInit(complete)
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo2.git'], { cwd: complete, stdio: 'ignore' })
    // 本机署名是**本机事实**，不参与成熟度判定——但夹具要在两台虚拟机器上都稳定，
    // 所以给它一份确定的本地配置，免得依赖跑夹具那台机器的全局设置。
    for (const d of [incomplete, complete]) {
      spawnSync('git', ['config', 'user.name', 'fixture'], { cwd: d, stdio: 'ignore' })
      spawnSync('git', ['config', 'user.email', 'fixture@example.com'], { cwd: d, stdio: 'ignore' })
    }

    // 正面：缺 AGENTS.md 与 .gitattributes 的仓库，不该被当成「该有的都有」。
    const a = await survey(incomplete)
    if (a.maturity === 'mature') return '缺 AGENTS.md 与 .gitattributes 仍被判 mature'
    if (!a.gaps.some((g) => /AGENTS\.md/.test(g))) return 'gaps 里没有「缺 AGENTS.md」'
    if (!a.gaps.some((g) => /gitattributes/.test(g))) return 'gaps 里没有「缺 .gitattributes」'

    // 反面：六项齐全时必须是 mature——这条一旦翻车，所有正常项目都会被拖着做一遍多余的事。
    const b = await survey(complete)
    if (b.maturity !== 'mature') return `六项齐全却不是 mature（${b.maturity}）：${b.gaps.join(' / ')}`
    return true
  } finally { rmTree(incomplete); rmTree(complete) }
}])

cases.push(['只有系统垃圾文件的目录判 empty，有一个真文件就不是', async () => {
  const junk = tmpProject({
    '.DS_Store': 'x',
    '.vscode/settings.json': '{}',
    'Thumbs.db': 'x',
  })
  const real = tmpProject({ '.DS_Store': 'x', 'notes.md': '# 随手记\n' })
  try {
    const a = await survey(junk)
    if (a.maturity !== 'empty') return `只有垃圾文件却判 ${a.maturity}`

    // 反面：有一个真文件，就不是「空目录」。
    const b = await survey(real)
    if (b.maturity === 'empty') return '有一个 .md 还被判成 empty'
    return true
  } finally { rmTree(junk); rmTree(real) }
}])

cases.push(['前后端分离：根目录没有清单时，一阶子目录里的生态要被认出来', async () => {
  const dir = tmpProject({
    'README.md': '# split\n\n前后端分离。\n',
    'frontend/package.json': '{"name":"web","version":"1.0.0","scripts":{"test":"vitest"}}',
    'backend/pyproject.toml': '[project]\nname = "api"\nversion = "1.0.0"\n',
    'backend/tests/test_api.py': 'def test_ok():\n    assert True\n',
  })
  try {
    const f = await survey(dir)
    if (!f.ecosystem.kinds.includes('node')) return `没认出前端：${f.ecosystem.kinds.join(',')}`
    if (!f.ecosystem.kinds.includes('python')) return `没认出后端：${f.ecosystem.kinds.join(',')}`
    const dirs = (f.ecosystem.subdirs ?? []).map((s) => s.dir)
    if (!dirs.includes('frontend') || !dirs.includes('backend')) return `subdirs 不全：${dirs.join(',')}`

    // 反面：根目录已经有清单时不下潜——那里的东西多半是依赖或示例，
    // 跟着扫会凭空多出几个生态，而多出来的会让 CI 去装根本不需要的工具链。
    const rooted = tmpProject({
      'README.md': '# d\n\n说明足够长。\n',
      'package.json': '{"name":"d","version":"1.0.0"}',
      'vendor/package.json': '{"name":"v","version":"0.0.1"}',
    })
    try {
      const g = await survey(rooted)
      if ((g.ecosystem.subdirs ?? []).length > 0) return '根目录已有清单，却还去扫了子目录'
      return true
    } finally { rmTree(rooted) }
  } finally { rmTree(dir) }
}])

cases.push(['纯 .vue 组件库不是「纯文档项目」', async () => {
  const dir = tmpProject({
    'README.md': '# ui\n\n一个组件库。\n',
    'Button.vue': '<template><button /></template>\n',
    'Card.svelte': '<div />\n',
  })
  try {
    const f = await survey(dir)
    if (f.scale.codeFiles === 0) return '.vue / .svelte 没有被算成代码文件'
    if (f.ecosystem.kinds.includes('docs-only')) return '被判成了纯文档项目'

    // 反面：真的只有 Markdown 时，还得是 docs-only。
    const docs = tmpProject({ 'README.md': '# 手册\n\n内容。\n', 'guide.md': '# 指南\n' })
    try {
      const g = await survey(docs)
      if (!g.ecosystem.kinds.includes('docs-only')) return `纯 .md 项目不再是 docs-only：${g.ecosystem.kinds.join(',')}`
      return true
    } finally { rmTree(docs) }
  } finally { rmTree(dir) }
}])

cases.push(['裸仓库判成「裸仓库」，不是「还没有版本库」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pf-bare-'))
  try {
    spawnSync('git', ['init', '-q', '--bare', dir], { stdio: 'ignore' })
    const f = await survey(dir)
    if (f.git.isBare !== true) return `isBare 是 ${f.git.isBare}`
    if (f.git.present !== true) return '裸仓库被判成「没有版本库」'
    if (!f.gaps.some((g) => /裸仓库/.test(g))) return 'gaps 里没有「裸仓库」这一条'
    if (f.gaps.some((g) => /还没有版本库/.test(g))) return 'gaps 里还写着「还没有版本库」——照着它会去 git init'

    // 反面：普通仓库的 isBare 必须是假，否则每个项目都会被劝去克隆一遍。
    const normal = tmpProject({ 'README.md': '# d\n\n说明足够长。\n' })
    try {
      gitInit(normal)
      const g = await survey(normal)
      if (g.git.isBare !== false) return '普通仓库被标成了裸仓库'
      return true
    } finally { rmTree(normal) }
  } finally { rmTree(dir) }
}])

cases.push(['子目录里的独立仓库会被点名，并给出边界问题', async () => {
  const dir = tmpProject({ 'README.md': '# outer\n\n说明足够长。\n' })
  try {
    gitInit(dir)
    mkdirSync(join(dir, 'sub'))
    spawnSync('git', ['init', '-q'], { cwd: join(dir, 'sub'), stdio: 'ignore' })
    const f = await survey(dir)
    if (!(f.git.nestedRepos ?? []).includes('sub')) return `nestedRepos=${JSON.stringify(f.git.nestedRepos)}`
    if (!f.gaps.some((g) => /独立仓库/.test(g))) return 'gaps 里没有嵌套仓库这一条'
    if (!f.questions.some((q) => /子模块|并入/.test(q))) return '没问边界怎么处置'

    // 反面：干净的仓库不该凭空报嵌套。
    const clean = tmpProject({ 'README.md': '# d\n\n说明足够长。\n' })
    try {
      gitInit(clean)
      const g = await survey(clean)
      if ((g.git.nestedRepos ?? []).length > 0) return '干净仓库报出了嵌套仓库'
      return true
    } finally { rmTree(clean) }
  } finally { rmTree(dir) }
}])

cases.push(['清单声明了源仓库，角色就判得出来；没声明时提问而不是猜', async () => {
  const declared = tmpProject({
    'README.md': '# d\n\n说明足够长。\n',
    'pyproject.toml': '[project]\nname = "api"\nversion = "1.0.0"\n\n[project.urls]\nRepository = "https://github.com/acme/api"\n',
  })
  try {
    gitInit(declared)
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: declared, stdio: 'ignore' })
    const f = await survey(declared)
    if (f.ecosystem.declaredRepo !== 'acme/api') return `declaredRepo=${f.ecosystem.declaredRepo}`
    if (f.git.role !== 'maintainer') return `role=${f.git.role}（声明与 origin 一致，本该是维护者）`

    // 反面：没声明时不许猜成维护者，而且要把问题问出来。
    const undeclared = tmpProject({ 'README.md': '# d\n\n说明足够长。\n', 'main.py': 'print(1)\n' })
    try {
      gitInit(undeclared)
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/unknown.git'], { cwd: undeclared, stdio: 'ignore' })
      const g = await survey(undeclared)
      if (g.git.role !== 'undetermined') return `role=${g.git.role}（没声明源仓库却判成了别的）`
      if (!g.questions.some((q) => /正本|源仓库/.test(q))) return '角色比不出来却没有提问'
      return true
    } finally { rmTree(undeclared) }
  } finally { rmTree(declared) }
}])

// ── W5：导航与交付体检 ──────────────────────────────────────────────

cases.push(['导航：缺文档推 docs-set，缺远端推 remote-github，skill 不推插件', async () => {
  // 正面：一份什么都没有的项目，导航必须把「写文档」与「建远端」这两件事的判据指出来。
  const bare = tmpProject({ 'README.md': '# d\n\n说明足够长。\n', 'index.js': 'console.log(1)\n' })
  try {
    const f = await survey(bare)
    const nav = f.navigation ?? []
    if (nav.length === 0) return 'JSON 里没有 navigation 字段'
    if (!nav.some((x) => x.includes('docs-set.md'))) return '缺文档却没推 docs-set.md'
    if (!nav.some((x) => x.includes('version-control.md'))) return '缺 .gitattributes / 没版本库，却没推 version-control.md'

    gitInit(bare)
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: bare, stdio: 'ignore' })
    const g = await survey(bare)
    const nav2 = g.navigation ?? []
    if (!nav2.some((x) => x.includes('remote-github.md'))) return '没有 CI / PR 模板，却没推 remote-github.md'

    // JSON 与 Markdown 必须是同一份：两条路各算一遍迟早分叉。
    const md = (await runNode('survey.mjs', [bare, '--markdown'])).stdout
    for (const item of nav2) {
      const head = item.split('——')[0].replace(/^\*\*/, '').slice(0, 20)
      if (!md.includes(head)) return `Markdown 报告里少了一条导航：${head}`
    }
    return true
  } finally { rmTree(bare) }
}])

cases.push(['导航：能力目录只推 skill 那一份，不推插件与制品库', async () => {
  const skill = tmpProject({
    'SKILL.md': '---\nname: demo\ndescription: 一个示例能力目录。\n---\n\n# demo\n',
    'README.md': '# d\n\n说明足够长。\n',
  })
  try {
    const f = await survey(skill)
    const nav = f.navigation ?? []
    if (!nav.some((x) => x.includes('skill-project.md'))) return 'skill 项目没推 skill-project.md'
    // 反面：能力目录靠克隆分发，插件与制品库那两套判据对它不成立。
    if (nav.some((x) => x.includes('plugin-ecosystems.md'))) return '把插件判据推给了能力目录'
    if (nav.some((x) => x.includes('publish.md'))) return '把制品库判据推给了能力目录'

    // 另一面：真插件项目必须推插件那一份。
    const plugin = tmpProject({
      'README.md': '# p\n\n说明足够长。\n',
      'manifest.json': '{"id":"demo","minAppVersion":"1.0.0"}',
      'main.js': 'module.exports = {}\n',
    })
    try {
      const g = await survey(plugin)
      if (!(g.navigation ?? []).some((x) => x.includes('plugin-ecosystems.md'))) return '插件项目没推插件判据'
      return true
    } finally { rmTree(plugin) }
  } finally { rmTree(skill) }
}])

cases.push(['Markdown 报告带上运行环境、多生态命令与既有约定，不写成 undefined', async () => {
  const dir = tmpProject({
    'README.md': '# d\n\n说明足够长。\n',
    'package.json': '{"name":"web","version":"1.0.0","engines":{"node":">=20"},"scripts":{"test":"node --test"}}',
    'pyproject.toml': '[project]\nname = "api"\nversion = "1.0.0"\nrequires-python = ">=3.11"\n',
    'tests/test_api.py': 'def test_ok():\n    assert True\n',
  })
  try {
    const md = (await runNode('survey.mjs', [dir, '--markdown'])).stdout
    if (!/运行环境要求/.test(md)) return '报告里没有运行环境要求'
    if (!md.includes('Node >=20') && !md.includes('>=20')) return '运行环境没写出具体版本'
    if (!/按生态分开的命令/.test(md)) return '多生态项目没有逐生态列命令'
    if (!/项目已有的约定/.test(md)) return '报告里没有「已有约定」这一节'
    if (md.includes('undefined')) return '报告里出现了 undefined'

    // 反面：纯文档项目没有这些内容时，不许留空标题或 undefined。
    const docs = tmpProject({ 'README.md': '# 手册\n\n内容。\n', 'guide.md': '# 指南\n' })
    try {
      const md2 = (await runNode('survey.mjs', [docs, '--markdown'])).stdout
      if (md2.includes('undefined')) return '纯文档项目的报告里出现了 undefined'
      return true
    } finally { rmTree(docs) }
  } finally { rmTree(dir) }
}])

cases.push(['体检拦下结构坏掉的契约', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    // 正面：标记不成对时，体检必须报缺——只看「有没有未填的 fill」是看不出来的。
    await runNode('compose-agents.mjs', [dir])
    const fillAll = (text) => text.replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    const good = fillAll(readFileSync(join(dir, 'AGENTS.md'), 'utf8'))
    writeFileSync(join(dir, 'AGENTS.md'), good)

    // 基线：一把修好的契约必须是「齐」，否则下面那条判据永远红、也证明不了什么。
    const clean = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
    if (clean.results.some((x) => x.id === 'agents.broken')) return '一份完好的契约被报成了「标记不成对」'

    const broken = good.replace('<!-- project-forge: end 项目定位 -->\n', '')
    writeFileSync(join(dir, 'AGENTS.md'), broken)
    const r = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
    const hit = r.results.find((x) => x.id === 'agents.broken')
    if (!hit) return '标记不成对，体检没报出来'
    if (hit.level !== 'missing') return `标记不成对报成了 ${hit.level}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['体检把系统占位署名判成缺，正常署名判成齐', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    gitInit(dir)
    spawnSync('git', ['config', 'user.name', 'Administrator'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'admin@localhost'], { cwd: dir, stdio: 'ignore' })
    const r = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
    const bad = r.results.find((x) => x.id === 'git.identity.placeholder')
    if (!bad) return 'Administrator / admin@localhost 被当成了合法署名'
    if (bad.level !== 'missing') return `占位署名报成了 ${bad.level}`

    // 反面：正常署名不许被误伤。
    spawnSync('git', ['config', 'user.name', 'Dev Person'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: dir, stdio: 'ignore' })
    const r2 = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
    if (r2.results.some((x) => x.id === 'git.identity.placeholder')) return '正常署名被当成了占位'
    if (!r2.results.some((x) => x.id === 'git.identity.ok')) return '正常署名没有被判成齐'
    return true
  } finally { rmTree(dir) }
}])

cases.push(['远端不在 GitHub 上时，导航给「不适用」而不是塞一份 GitHub 文档', async () => {
  const elsewhere = tmpProject({ 'README.md': '# d\n\n说明足够长。\n', 'index.js': 'console.log(1)\n' })
  const onGithub = tmpProject({ 'README.md': '# d\n\n说明足够长。\n', 'index.js': 'console.log(1)\n' })
  try {
    gitInit(elsewhere)
    spawnSync('git', ['remote', 'add', 'origin', 'https://git.example.com/team/demo.git'], { cwd: elsewhere, stdio: 'ignore' })
    gitInit(onGithub)
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/demo.git'], { cwd: onGithub, stdio: 'ignore' })

    // 正面：非 GitHub 远端时，不推那份通篇 `gh` / Actions 的文档，改成一句「不适用」。
    const a = await survey(elsewhere)
    const navA = a.navigation ?? []
    if (navA.some((x) => x.includes('remote-github.md') && x.includes('建仓库'))) {
      return '远端不在 GitHub 上，却推了通篇讲 gh 与 Actions 的文档'
    }
    if (!navA.some((x) => x.includes('远端不在 GitHub 上'))) return '既没推文档也没说明不适用，读的人会以为这项没事'

    // 反面：GitHub 远端时该推还得推，且不许误报「不适用」。
    const b = await survey(onGithub)
    const navB = b.navigation ?? []
    if (!navB.some((x) => x.includes('remote-github.md'))) return 'GitHub 远端却没推那份文档'
    if (navB.some((x) => x.includes('远端不在 GitHub 上'))) return 'GitHub 远端被误报成「不在 GitHub 上」'
    return true
  } finally { rmTree(elsewhere); rmTree(onGithub) }
}])

cases.push(['许可证不是缺口：不可发布的项目缺许可证照样能 mature', async () => {
  const dir = tmpProject({
    'README.md': '# demo\n\n私有工具，说明足够长。\n',
    'index.js': 'console.log(1)\n',
    'package.json': '{"name":"demo","version":"1.0.0","private":true}',
    '.gitattributes': '* text=auto\n',
    '.github/workflows/ci.yml': 'name: ci\non: [push]\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: node index.js\n',
    'AGENTS.md': [
      '# d 工程契约', '', '## 定位', '',
      '私有工具，只在本机跑，不对外发布，也不做部署与选型。', '',
      '## 构建与验证', '', '```sh', 'node index.js', '```', '',
      '## 修改规范', '', '- 先看再动；', '- 改完跑上面那条命令；', '- 不引入第三方依赖。',
    ].join('\n'),
  })
  try {
    gitInit(dir)
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/privdemo.git'], { cwd: dir, stdio: 'ignore' })
    const f = await survey(dir)
    // 正面：私有项目不放许可证是对的，它不该被算成「该修的东西」，也不该把 maturity 拖下来。
    if ((f.projectGaps ?? []).some((g) => /LICENSE/.test(g))) return '不可发布的项目缺许可证被写成了缺口'
    if (f.maturity !== 'mature') return `私有项目六项齐全却是 ${f.maturity}：${(f.gaps ?? []).join(' / ')}`
    // 该问的还是要问：放不放是使用者的事。
    if (!(f.questions ?? []).some((q) => /授权|许可证/.test(q))) return '没有把「要不要授权」问出来'

    // 反面：声明了可发布的包却没许可证时，它确实是缺口——下游合规检查会拒。
    const pub = tmpProject({
      'README.md': '# lib\n\n一个要发出去的库。\n',
      'index.js': 'module.exports = {}\n',
      'package.json': '{"name":"mylib","version":"1.0.0"}',
    })
    try {
      const g = await survey(pub)
      if (!(g.gaps ?? []).some((x) => /LICENSE/.test(x))) return '可发布的包缺许可证却没报缺口'
      return true
    } finally { rmTree(pub) }
  } finally { rmTree(dir) }
}])

for (const [name, fn] of cases) {
  try {
    const outcome = await fn()
    if (outcome === true) { passed += 1; continue }
    failures.push(`${name} —— ${outcome}`)
  } catch (error) {
    failures.push(`${name} —— 抛异常：${error instanceof Error ? error.message : String(error)}`)
  }
}

if (failures.length === 0) {
  process.stdout.write(`行为断言：${passed} 项通过，0 项失败。\n`)
  process.exit(0)
}
for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
process.stderr.write(`\n行为断言：${passed} 通过 / ${failures.length} 失败。\n`)
process.exit(1)
