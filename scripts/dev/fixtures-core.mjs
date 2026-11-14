import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitInit, loadPreflight,
  readDirRefs, rmTree, runAbs, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'

export function registerCoreCases(cases) {
// ── 勘察：生态判定 ──────────────────────────────────────────────────

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

cases.push(['模板改了而有基线的实例没跟上时，--check 会红且刷新拉回；无基线默认 protect 不覆盖', async () => {
  const { regionBodySha } = await import('../lib/agents-sections.mjs')
  const { markerRegions } = await import('../lib/protocol.mjs')
  const noBaseDir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  const baseDir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    // 1. 无 .pf-manifest.json 基线时，非空受管区段修改后默认 protect，不强行覆盖
    await runNode('compose-agents.mjs', [noBaseDir, '--no-backup'])
    const noBaseFilled = readFileSync(join(noBaseDir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    const noBaseEdited = noBaseFilled.replace(/(- \*\*同步不变量\*\*)/, '- 无基线时的手工补充。\n\n$1')
    if (noBaseEdited === noBaseFilled) return '夹具没找到可插入的位置（noBaseDir）'
    writeFileSync(join(noBaseDir, 'AGENTS.md'), noBaseEdited)
    const protRun = await runNode('compose-agents.mjs', [noBaseDir, '--no-backup'])
    if (protRun.status !== 0) return `无基线 compose-agents 失败：${protRun.stderr}`
    if (!readFileSync(join(noBaseDir, 'AGENTS.md'), 'utf8').includes('无基线时的手工补充') || !/保护跳过/.test(protRun.stderr || '')) {
      return `无基线时未默认 protect 既有非空区段：stderr=${protRun.stderr}`
    }

    // 2. 配备 manifest 基线后，模板变化而实例停在旧基线（diskSha === baselineSha）：--check 红，刷新把规则拉回
    await runNode('equip.mjs', [baseDir, '--no-backup'])
    await runNode('compose-agents.mjs', [baseDir, '--no-backup'])
    const filled = readFileSync(join(baseDir, 'AGENTS.md'), 'utf8')
      .replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。')
    writeFileSync(join(baseDir, 'AGENTS.md'), filled)
    const good = await runNode('compose-agents.mjs', [baseDir, '--check'])
    if (good.status !== 0) return `填完之后就没过 --check：${(good.stderr || '').trim().split('\n')[0]}`

    const text = readFileSync(join(baseDir, 'AGENTS.md'), 'utf8')
    const tampered = text.replace(
      /(- \*\*同步不变量\*\*)/,
      '- 这是旧基线里多出来的一条，新版模板没有。\n\n$1',
    )
    if (tampered === text) return '夹具没找到可以插入的位置'
    writeFileSync(join(baseDir, 'AGENTS.md'), tampered)

    // 把磁盘上的旧版区段哈希写回 manifest agentsRegions，模拟「模板升级而实例尚未手工篡改」
    const manifestPath = join(baseDir, '.agents', 'skills', '.pf-manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const reg = markerRegions(tampered, 'AGENTS.md').regions.find((r) => r.id === '日常协作与风险分流')
    manifest.agentsRegions['日常协作与风险分流'] = {
      sha256: regionBodySha(tampered.split('\n').slice(reg.start + 1, reg.end)),
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

    const drifted = await runNode('compose-agents.mjs', [baseDir, '--check'])
    if (drifted.status === 0) return '内容与模板不一致，--check 却放行了'
    if (!/与模板不一致/.test(drifted.stderr || '')) return `报错了但不是漂移那条判据：${(drifted.stderr || '').trim().split('\n')[0]}`

    await runNode('compose-agents.mjs', [baseDir, '--no-backup'])
    const after = readFileSync(join(baseDir, 'AGENTS.md'), 'utf8')
    if (after.includes('旧基线里多出来的一条')) return '刷新没有把实例拉回模板（多出来的内容还在）'
    if (!after.includes('同步不变量')) return '刷新把模板里的规则弄丢了'
    const again = await runNode('compose-agents.mjs', [baseDir, '--check'])
    if (again.status !== 0) return `刷新之后 --check 仍然红：${(again.stderr || '').trim().split('\n')[0]}`
    return true
  } finally { rmTree(noBaseDir); rmTree(baseDir) }
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

}
