/**
 * fixtures-review.mjs —— 导航指南、发布契约与判据指路夹具。
 */

import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCRIPTS, SKILL_ROOT, gitInit, gitSync, rmTree, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'

export function registerReviewCases(cases) {
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

    gitInit(bare, { origin: 'https://github.com/acme/demo.git' })
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

cases.push(['体检把系统占位与 RFC 2606 保留域署名判成缺，正常署名判成齐', async () => {
  const dir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  try {
    gitInit(dir, { name: 'Administrator', email: 'admin@localhost' })
    const r = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
    const bad = r.results.find((x) => x.id === 'git.identity.placeholder')
    if (!bad) return 'Administrator / admin@localhost 被当成了合法署名'
    if (bad.level !== 'missing') return `占位署名报成了 ${bad.level}`

    // 反面：RFC 2606 保留无效域（example.com/.invalid/.test）与 test-* 占位名均必须拦截
    for (const [n, e] of [
      ['Dev Person', 'dev@example.com'],
      ['Dev Person', 'dev@foo.invalid'],
      ['Dev Person', 'dev@bar.test'],
      ['test-bot', 'bot@acme-fixture.dev'],
    ]) {
      gitSync(dir, ['config', 'user.name', n])
      gitSync(dir, ['config', 'user.email', e])
      const rr = JSON.parse((await runNode('review.mjs', [dir, '--json'])).stdout)
      if (!rr.results.some((x) => x.id === 'git.identity.placeholder' && x.level === 'missing')) {
        return `RFC 2606 或 test-* 占位署名未被拦截：${n} <${e}>`
      }
    }

    // 正面：正常署名不许被误伤。
    gitSync(dir, ['config', 'user.name', 'Dev Person'])
    gitSync(dir, ['config', 'user.email', 'dev@acme-fixture.dev'])
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
    gitInit(elsewhere, { origin: 'https://git.example.com/team/demo.git' })
    gitInit(onGithub, { origin: 'https://github.com/acme/demo.git' })

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
    gitInit(dir, { origin: 'https://github.com/acme/privdemo.git' })
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
    try { renderVars(`x ${token} y`, { PROJECT_NAME: 'demo' }) } catch (error) { hit = /形状不对的占位符/.test(error.message) }
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
    const real = (after.match(/^## 高风险路径（/mg) ?? []).length
    if (real === 0) return '围栏里的同名标题被当成了「已有」，该补的节永远补不上'

    // 反面：再跑一遍不许插第二份。
    await runNode('compose-agents.mjs', [dir])
    const twice = (readFileSync(join(dir, 'AGENTS.md'), 'utf8').match(/^## 高风险路径（/mg) ?? []).length
    if (twice > 1) return `同一节被插了两份（${twice} 份）`
    return true
  } finally { rmTree(dir) }
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

// ── 判据自己没验过时，不能说「验过了」 ────────────────────────────────
//
// 手写的 AGENTS.md 没有受管区，于是「与模板一致」这一面**没有可比对的东西**。
// 这里如果什么都不说，输出里就只剩「结构完整」——那是这类判据最典型的假绿：
// 没验过被读成验过了。
cases.push(['手写契约要说清「这一面没验」，受管契约不许出现这句话', async () => {
  const dir = tmpProject({
    'README.md': '# hand\n\n手写契约测试仓，用于验证 review 的诚实措辞。\n',
    'package.json': '{"name":"hand","version":"1.0.0","scripts":{"test":"node --test"}}',
    'AGENTS.md': '# hand\n\n## 取舍\n\n- `no-ci`：不配，本地跑就够了\n',
  })
  try {
    const { reviewProject } = await import('../../scripts/review.mjs')
    const res = await reviewProject(dir, { scopes: new Set(['agents']) })
    const unverified = (res.results ?? []).find((f) => f.id === 'agents.unverified')
    if (!unverified) {
      return '手写 AGENTS.md 没有产出 agents.unverified——「没验过」被当成「验过了」'
    }
    if (unverified.level !== 'notice') {
      return `agents.unverified 的档位是 ${unverified.level}，它不是缺口，是「这一面没验」，应当是 notice`
    }
    if (!/没验|没有可核对/.test(unverified.title)) {
      return `agents.unverified 没把「这一面没验」说清楚：${unverified.title}`
    }
    if ((res.results ?? []).some((f) => f.id === 'agents.ready')) {
      return '手写契约同时报了 agents.ready——「没验过」与「验过且通过」不能同时成立'
    }

    // 反向：装过套件、有受管区的契约不该出现这句话。
    //
    // 注意生成顺序：仓里已经有一份手写契约时，`compose-agents` 默认**不覆盖**它
    // （那是「人接手了」的正常语义），所以先删掉再生成，才落到「受管契约」这一侧。
    const managedDir = tmpProject({
      'README.md': '# managed\n\n受管契约测试仓，用于验证反向。\n',
      'package.json': '{"name":"managed","version":"1.0.0","scripts":{"test":"node --test"}}',
    })
    try {
      await runNode('equip.mjs', [managedDir, '--no-backup'])
      await runNode('compose-agents.mjs', [managedDir, '--no-backup'])
      const managedText = readFileSync(join(managedDir, 'AGENTS.md'), 'utf8')
      if (!/project-forge: begin/.test(managedText)) return '反向仓没有生成受管标记，夹具前提不成立'
      writeFileSync(join(managedDir, 'AGENTS.md'),
        managedText.replace(/^<!-- project-forge: fill [^\n]*-->$/gm, '已填写。'))
      const managed = await reviewProject(managedDir, { scopes: new Set(['agents']) })
      if ((managed.results ?? []).some((f) => f.id === 'agents.unverified')) {
        return '受管契约仍然报 agents.unverified——这句话只对手写契约成立'
      }
      return true
    } finally { rmTree(managedDir) }
  } finally { rmTree(dir) }
}])

// ── 没有业务内容时，「没有缺口」是一句假话 ────────────────────────────
//
// 一个只装了套件的仓：代码文件 0 个、清单一个都没有。构建、测试、TDD、CI 这几条判据的
// 前提全都不存在，于是它们一条都不报。把这些沉默读成「没有会出事的缺口」，
// 就是自洽的假绿——什么都没验，所以什么都没缺。
cases.push(['空仓的结论不许说「没有会出事的缺口」，有业务内容时仍要照实报缺口', async () => {
  const empty = tmpProject({
    'README.md': '# toolgen\n\n这个仓只装了套件，没有任何业务文件，用于验证结论措辞。\n',
    'LICENSE': 'MIT License\n',
  })
  try {
    // 先把版本管理这一面弄干净：结论句验的是「没有缺口时怎么说」，
    // 留着「还不是版本库」这条缺，就永远走不到那一句，判据等于没测到。
    gitInit(empty, { branch: 'main' })
    gitSync(empty, ['add', '-A'])
    gitSync(empty, ['-c', 'user.name=t', '-c', 'user.email=t@t.t', 'commit', '-qm', 'init'])
    await runNode('equip.mjs', [empty, '--no-backup'])
    await runNode('compose-agents.mjs', [empty, '--no-backup'])
    writeFileSync(join(empty, 'AGENTS.md'),
      readFileSync(join(empty, 'AGENTS.md'), 'utf8').replace(/^<!-- project-forge: fill [^\n]*-->/gm, '已填写。'))

    const { reviewProject } = await import('../../scripts/review.mjs')
    const res = await reviewProject(empty)
    const blank = (res.results ?? []).find((f) => f.id === 'ecosystem.blank-content')
    if (!blank) return '空仓没有产出 ecosystem.blank-content——那几条没跑起来的判据被静默压掉了'
    if (blank.level !== 'pending') {
      return `空仓的「什么都没查」被放进了 ${blank.level} 档；它只有使用者能定，应当落在 pending`
    }
    if (!Array.isArray(res.unscanned) || res.unscanned.length === 0) {
      return '结果里没有 unscanned——结论句无法区分「验过没问题」与「没跑起来」'
    }
    const text = (await runNode('review.mjs', [empty])).stdout ?? ''
    for (const phrase of ['没有会出事的缺口', '可以交付']) {
      if (text.includes(phrase)) return `空仓的结论里出现了「${phrase}」——没查过不能当成没问题`
    }

    // 反向：真的写了业务代码，就要照实报缺口，不能拿「空仓」这条兜底糊过去。
    const real = tmpProject({
      'README.md': '# real\n\n有业务代码但没有技术设计文档的仓，用于验证反向。\n',
      'package.json': '{"name":"real","version":"1.0.0","scripts":{"test":"node --test"}}',
      'src/app.mjs': 'export const a = 1\n',
    })
    try {
      const realRes = await reviewProject(real)
      if ((realRes.results ?? []).some((f) => f.id === 'ecosystem.blank-content')) {
        return '有业务代码的仓被报成了空仓'
      }
      if ((realRes.missing ?? []).length === 0) {
        return '有业务代码但缺技术设计文档的仓，一条「缺」都没有——判据失明了'
      }
      return true
    } finally { rmTree(real) }
  } finally { rmTree(empty) }
}])


// 审核人拿到的 diff 必须是**补丁正文**，不是文件清单。
// `git diff --raw` 单独用只输出 40 行 name-status，一行补丁都没有——
// 而报告里「changedFiles: 40」看起来完全正常，审核人却什么都看不到。
// 这类「看起来有、实际是空」的洞最危险：门禁全绿，审核形同虚设。
cases.push(["审核 diff 里必须有补丁正文，不能只有文件清单", async () => {
  const { collectDiff } = await import("../../kit/skills/dev-review/scripts/review-diff.mjs")
  const { gitCommitFast, gitInit, rmTree, tmpProject } = await import("./fixtures-helpers.mjs")
  const { writeFileSync: wf, readFileSync: rf } = await import("node:fs")
  const { join } = await import("node:path")

  const dir = tmpProject({ "a.txt": "line1\nline2\nline3\n" })
  try {
    gitInit(dir)
    gitCommitFast(dir, "init")
    const base = rf(join(dir, ".git", "HEAD"), "utf8").trim()
    wf(join(dir, "a.txt"), "line1\nCHANGED\nline3\n")
    gitCommitFast(dir, "change")

    const d = await collectDiff(dir, { mode: "range", range: "HEAD~1..HEAD" })

    // 三个都要成立：字节数不为 0、正文里真有 +/- 行、hash 不是空串的 hash
    if (d.bytes === 0) return "diff 是 0 字节——审核人什么都看不到"
    if (!d.text.includes("+CHANGED")) return `正文里没有新增行：${JSON.stringify(d.text.slice(0, 120))}`
    if (!d.text.includes("-line2")) return "正文里没有删除行"
    if (d.hunkIndex.length === 0) return "hunk 索引是空的"

    // 空串的 sha256 是 e3b0c442…，这个值出现就说明算的是空内容
    if (d.sha256.startsWith("e3b0c442")) return "diff hash 是空串的 hash——正文没被读到"

    return true
  } finally { rmTree(dir) }
}])
}
