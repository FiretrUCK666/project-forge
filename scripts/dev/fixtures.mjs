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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPTS = resolve(HERE, '..')

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

// ── 跑 ──────────────────────────────────────────────────────────────

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
