import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitInit, loadPreflight,
  readDirRefs, rmTree, runAbs, runNode, survey, textsOf, tmpProject,
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

}
