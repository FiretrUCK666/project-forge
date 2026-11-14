import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitInit, loadPreflight,
  readDirRefs, rmTree, runAbs, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'

export function registerContractCases(cases) {
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

cases.push(['契约里明确写了「日常只到推送、说发版才发」，且纯 README 非发布项目不误塞发版节', async () => {
  const docsDir = tmpProject({ 'README.md': '# d\n\n说明足够长以通过长度检查。\n' })
  const relDir = tmpProject({
    'README.md': '# d\n\n说明足够长以通过长度检查。\n',
    'package.json': '{"name":"d","version":"1.0.0"}\n',
  })
  try {
    // 反面：纯 README 非发布项目不误触发 has-release（不塞「版本号与发版死锁防护」）
    await runNode('compose-agents.mjs', [docsDir])
    const docsText = readFileSync(join(docsDir, 'AGENTS.md'), 'utf8')
    if (docsText.includes('版本号与发版死锁防护')) return '纯 README 非发布项目被误注入了发版节'
    if (!docsText.includes('日常到此为止')) return '纯 README 项目缺少「日常到此为止」边界'

    // 正面：可发布项目触发 has-release，必须明确写「日常不打标签 / 发版明确说 / 不自己判断」
    await runNode('compose-agents.mjs', [relDir])
    const text = readFileSync(join(relDir, 'AGENTS.md'), 'utf8')
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
  } finally { rmTree(docsDir); rmTree(relDir) }
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

}
