// 行为自检的一个分片。主入口 scripts/dev/selftest.mjs 并行 spawn 全部 cases-N.mjs，
// 各自跑自己那几组，最后由主入口合并计数。
//
// 能并行的前提是**组与组之间没有共享可变状态**：每组用自己的 fixture 目录（带 pid 与
// 随机串），断言只累加到本进程的计数器上。
//
// 不要在这里做「跑完全部组之后」的事（汇总、清理）——那是主入口的职责。

import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, readdirSync, symlinkSync, unlinkSync, } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir, homedir } from 'node:os'
import {
  evalFreshnessMarker, FRESHNESS_STALE_DAYS, listRepoFiles, compareHostMarker, hostDateBatchStatus, freshnessSectionBody, hasActionableSources, referencedPaths, moduleSpecifiers, externalModules, releaseTokenSpellings, hostMismatchMessage, } from './preflight.mjs'
import {
  authorMarkers, kindVocabulary } from '../survey.mjs'
import { isMainModule, parseGitHubRepo, skillVersion, skillSource, parseMarkerKeys, normVersion, repoPath, repoRelation, readFileMap } from '../lib/text.mjs'
import { needsSummary } from '../lib/protocol.mjs'
import { UPSTREAM, STALE_CHECK_MS, apiEndpoint, routesFor } from '../update.mjs'
import { clearStaleTemps } from '../lib/fs-atomic.mjs'
import { badgeVerdict, tierSecrets, unhandledRiskKeys, outsideKernel } from '../review.mjs'
import { readZip, stripCommonPrefix } from '../zip.mjs'

// 工具函数、计数器、fixture 工厂、跨组共用的小工具都住在 harness 里。
// 分片只 import，不重复实现——两份实现迟早会给出两个答案。
import {
  HERE,
  SKILL_ROOT,
  SCRIPTS_DIR,
  FIXTURE_PREFIX,
  ROOT,
  cleanupFixtures,
  processAlive,
  staleFixtureDirs,
  FAKE_GH_TOKEN,
  FAKE_NPM_TOKEN,
  FAKE_AWS_KEY,
  FAKE_EMOJI,
  HAS_GIT,
  passed,
  failed,
  skipped,
  failures,
  skips,
  check,
  skipGroup,
  group,
  lastGroupTitle,
  lastGroupAt,
  groupTimes,
  markTime,
  report,
  fixture,
  observedKinds,
  survey,
  compose,
  composeExpectingFailure,
  copyTree,
  gitIn,
  preflightIn,
  SELFTEST_STUB,
  SELFTEST_MUTE,
  skillClone,
  readSkill,
  handoff,
  handoffJson,
} from './lib/harness.mjs'
group('[51] 交棒勘察：痕迹找得到、干净的判得对、通用标记不误伤')
{
  const handoff = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'handoff.mjs'), dir, ...a], { encoding: 'utf8' })
  const handoffJson = (dir, ...a) => {
    const r = handoff(dir, '--json', ...a)
    // 退出码 0 与 1 都是正常结果：0 = 干净，1 = 不干净。2 才是失败。
    if (r.status !== 0 && r.status !== 1) return { error: (r.stderr ?? '').slice(0, 300) }
    try {
      return JSON.parse((r.stdout ?? '').replace(/^\uFEFF/, ''))
    } catch (error) {
      return { error: `输出不是合法 JSON：${error.message}` }
    }
  }
  const pick = (groups, path, kind) => (groups ?? []).find(
    (f) => f.path === path && (kind === undefined || f.kind === kind),
  )
  const every = (groups) => Object.values(groups ?? {}).flat()
  const blockingOf = (data) => every(data.groups).filter((f) => f.blocks === true).length

  // ── 1) 正例：每一类痕迹都要被找到，且行号与相对路径都对 ──
  const dirty = fixture('handoff-dirty', {
    'AGENTS.md': [
      '# 项目',
      '',
      '<!-- project-forge:kernel:start -->',
      '内核正文',
      '<!-- project-forge:kernel:end -->',
      '',
      '## 一节',
      '',
      '<!-- pf:author: 说明本项目的运行前提 -->',
      '',
    ].join('\n'),
    'notes/managed.md': '<!-- project-forge:managed -->\n',
    'notes/author.md': '<!-- pf:author: 待补 -->\n',
    'LICENSE': 'MIT License\n\nCopyright (c) {{YEAR}} {{HOLDER}}\n',
    'AGENTS.md.tmp-123': '半成品\n',
  })
  const j1 = handoffJson(dirty, '--scan')
  const m1 = j1.groups?.markers ?? []
  const u1 = j1.groups?.unfinished ?? []
  const p1 = j1.groups?.placeholders ?? []
  const r1 = j1.groups?.residue ?? []

  const kStart = pick(m1, 'AGENTS.md', 'kernel-start')
  const kEnd = pick(m1, 'AGENTS.md', 'kernel-end')
  const managed = pick(m1, 'notes/managed.md', 'managed')
  const author = pick(u1, 'notes/author.md', 'author-placeholder')
  const year = pick(p1, 'LICENSE', 'placeholder')
  const tmp = pick(r1, 'AGENTS.md.tmp-123', 'tmp-file')

  const foundOk = kStart?.line === 3 && kEnd?.line === 5 && managed?.line === 1
    && author?.line === 1 && year?.line === 3 && tmp !== undefined
  check(foundOk, '每一类痕迹都被找到，且行号正确',
    `kernel=${kStart?.line}/${kEnd?.line} managed=${managed?.line} author=${author?.line} 占位=${year?.line} 残留=${tmp === undefined ? '无' : '有'}`)
  report(foundOk, '正例：痕迹全找到、行号对')

  // pf:author 必须**单独成组**：它与「skill 装进来的」标识符不是一类东西，混在一组里
  // 会被顺手删掉——删掉标记而不补内容，交出去的是一份干净但空的契约。
  const ownGroupOk = m1.every((f) => f.kind !== 'author-placeholder')
    && u1.some((f) => f.kind === 'author-placeholder')
  check(ownGroupOk, 'pf:author 单独成组（不在标识符那一组里）',
    `标识符组 ${m1.length} 条，未完成组 ${u1.length} 条`)
  report(ownGroupOk, '未完成的占位：单独成组')

  // 相对路径必须是**相对项目目录**的：报告里的路径要能直接对着项目核对，
  // 绝对路径在换台机器后就没法核对了。分隔符统一用正斜杠。
  const relOk = [kStart, kEnd, managed, author, year, tmp].every((f) => f !== undefined)
    && managed?.path === 'notes/managed.md'
    && !/^[A-Za-z]:/.test(String(managed?.path))
    && !String(managed?.path).startsWith('/')
  check(relOk, '相对路径相对项目目录，且用正斜杠', `path=${managed?.path}`)
  report(relOk, '相对路径：正确')

  const scanExit = handoff(dirty, '--scan').status
  const verifyExit = handoff(dirty, '--verify').status
  const exitOk = scanExit === 0 && verifyExit === 1
  check(exitOk, 'scan 恒为 0（它是报告），verify 不干净为 1', `scan=${scanExit} verify=${verifyExit}`)
  report(exitOk, '退出码：scan=0 / verify=1')

  const cleanOk = j1.clean === false && j1.blocking === blockingOf(j1)
  check(cleanOk, '不干净时 clean=false，且 blocking 只数挡判定的那些',
    `clean=${j1.clean} blocking=${j1.blocking}`)
  report(cleanOk, '判定：不干净')

  // ── 2) 反例（防误伤）：通用标记不算痕迹，疑似项要标出来 ──
  const innocent = fixture('handoff-innocent', {
    'README.md': '# 项目\n\n<!-- toc:start -->\n- 目录\n<!-- toc:end -->\n\n## 安装\n',
    'cards.md': '<!-- pf:claims update-interval=24h -->\n',
  })
  const j2 = handoffJson(innocent, '--scan')
  const all2 = every(j2.groups)
  // toc 标记是 sync-toc 的通用目录标记，不专属本 skill：它**根本不出现**在报告里。
  const tocOk = all2.every((f) => !/toc:start|toc:end/.test(String(f.literal ?? f.match)))
  check(tocOk, 'toc 标记不算痕迹（一条都不报）',
    all2.map((f) => String(f.literal ?? f.match)).join('、') || '(无)')
  report(tocOk, '通用目录标记：不误伤')
  // pf:claims 出现在目标项目属异常，要报；但它是「疑似」，不是确定的痕迹。
  const claims = pick(j2.groups?.markers, 'cards.md', 'claims')
  const claimsOk = claims !== undefined && claims.suspect === true
  check(claimsOk, 'pf:claims 报出来但标为「疑似」（不是确定的痕迹）',
    claims === undefined ? '没报出来' : JSON.stringify(claims.suspect))
  report(claimsOk, '本 skill 自己的标记：报为疑似')

  // ── 3) 干净 fixture：没有痕迹 → verify 退出 0，且说得出「已经是干净状态」 ──
  const cleanDir = fixture('handoff-clean', {
    'README.md': '# 项目\n\n## 安装\n\n装它。\n',
    'main.js': "console.log('hi')\n",
  })
  const j3 = handoffJson(cleanDir, '--verify')
  const v3 = handoff(cleanDir, '--verify')
  const s3 = handoff(cleanDir, '--scan')
  const cleanFixtureOk = v3.status === 0 && j3.clean === true && j3.findings === 0
    && /已经是干净状态/.test(s3.stdout ?? '')
  check(cleanFixtureOk, '干净项目：verify 退出 0、clean=true、scan 说「已经是干净状态」',
    `exit=${v3.status} clean=${j3.clean} findings=${j3.findings}`)
  report(cleanFixtureOk, '干净项目：判得过')

  // ── 4) 不干净 fixture：verify 退出 1，且列出的命中与实际一致 ──
  const j4 = handoffJson(dirty, '--verify')
  const v4 = handoff(dirty, '--verify')
  const listed = blockingOf(j4)
  const dirtyFixtureOk = v4.status === 1 && j4.clean === false && listed === j4.blocking
    && (v4.stdout ?? '').includes('不干净')
  check(dirtyFixtureOk, '不干净项目：verify 退出 1，列出的命中数与 blocking 一致',
    `exit=${v4.status} listed=${listed} blocking=${j4.blocking}`)
  report(dirtyFixtureOk, '不干净项目：拦得住')

  // ── 5) 报告里**不出现处置文字** ──
  // 处置是判断，它归协议管。脚本与协议各写一份，协议改了一句而脚本还在给旧答案，
  // 两边都没有检查盯得住。所以脚本只说「哪里有、是什么」。
  const noAction = every(j1.groups).every((f) => f.action === undefined)
  const textHasNoVerdict = !/规则搬进|删掉指针句子|必须留在项目里|改写成项目自己的做法/
    .test(handoff(dirty, '--scan').stdout ?? '')
  const actionOk = noAction && textHasNoVerdict
  check(actionOk, '报告里没有处置文字（处置归协议）',
    actionOk ? '' : (noAction ? '文字输出里出现了处置句' : 'finding 里还有 action 字段'))
  report(actionOk, '处置文字：不在脚本里')

  // ── 6) 悬空指针：指向本 skill、而目标项目里没有的路径 ──
  // 这一类的判据是**两份事实交叉比对**（本 skill 的文件树 + 目标项目的文件树），
  // 标识符那种「一份事实就够」的判据套不上，所以每个分支都得单独证伪。
  const dangle = fixture('handoff-dangle', {
    'AGENTS.md': [
      '# 项目',
      '',
      '发布规则见 `references/publish.md` 一节。',
      '专章见 `references/publish-<生态>.md`。',
      '插件见 `references/plugins/dsh.md`。',
      '',
      '```sh',
      '# 这里只是举例：references/publish.md',
      '```',
      '',
    ].join('\n'),
  })
  const j5 = handoffJson(dangle, '--scan')
  const d5 = j5.groups?.dangling ?? []
  const exact = pick(d5, 'AGENTS.md', 'dangling-rule')
  const wild = d5.find((f) => /publish-<生态>/.test(String(f.match)))
  // 精确形态：行号 3，指向 references/publish.md。
  const exactOk = exact !== undefined && exact.line === 3
    && exact.match === 'references/publish.md'
    && Array.isArray(exact.targets) && exact.targets.includes('references/publish.md')
  check(exactOk, '悬空指针：精确形态被检出，行号与指向都对',
    exact === undefined ? '没检出' : `${exact.match}@${exact.line}`)
  report(exactOk, '悬空指针：精确形态')
  // 通配形态：<生态> 展开成通配，匹配上那一族专章。
  const wildOk = wild !== undefined && wild.line === 4
    && (wild.targets ?? []).length > 1
    && (wild.targets ?? []).includes('references/publish-npm.md')
  check(wildOk, '悬空指针：尖括号通配形态被检出，且匹配到一族文件',
    wild === undefined ? '没检出' : (wild.targets ?? []).join('、'))
  report(wildOk, '悬空指针：通配形态')
  // 子目录形态：名字里带一层目录，探针不能在这里被截断——截断了就永远查不出来，
  // 而插件类项目恰恰是靠这一层指针引专章的。
  const sub = d5.find((f) => f.match === 'references/plugins/dsh.md')
  const subOk = sub !== undefined && sub.line === 5
    && (sub.targets ?? []).includes('references/plugins/dsh.md')
  check(subOk, '悬空指针：带子目录的指针能查出来（references/plugins/dsh.md）',
    sub === undefined ? '没检出' : `${sub.match}@${sub.line}`)
  report(subOk, '悬空指针：子目录形态')
  // 围栏里的那一处是举例说明，不是引用——不算。
  const fenceOk = d5.every((f) => f.line !== 7)
  check(fenceOk, '围栏代码块里的示例路径不算引用', `行号：${d5.map((f) => f.line).join('、')}`)
  report(fenceOk, '悬空指针：围栏内的示例不算')
  // 悬空指针计入 blocking：不搬规则就不算干净。
  const blockingOk = j5.blocking === blockingOf(j5) && j5.clean === false
  check(blockingOk, '悬空指针计入 blocking（不搬规则就不算干净）',
    `blocking=${j5.blocking} 悬空=${d5.length}`)
  report(blockingOk, '悬空指针：计入 blocking')

  // 反例：目标项目**自己就有**那个文件 → 不是悬空（它是自己项目的文档，不是本 skill 的）。
  const hasOwn = fixture('handoff-has-own', {
    'AGENTS.md': '# 项目\n\n见 `references/publish.md` 一节。\n',
    'references/publish.md': '# 本项目自己的发布说明\n',
  })
  const j6 = handoffJson(hasOwn, '--scan')
  const ownOk = (j6.groups?.dangling ?? []).length === 0
  check(ownOk, '目标项目自己就有那个文件 → 不报悬空',
    `报出 ${(j6.groups?.dangling ?? []).length} 条`)
  report(ownOk, '悬空指针：自己的文件不算')

  // ── 7) 同名不同物：文档里提到一个本 skill 也有、但项目自己没有的脚本名 ──
  // 机器分不出「那是项目自己的脚本」还是「那是本 skill 的脚本」，所以它**不计入**
  // 干净判定：计入的话，用户唯一的出路就是造个同名空文件骗过检查。
  const collide = fixture('handoff-collide', {
    'SKILL.md': '# 另一个 skill\n\n打包用 `node scripts/zip.mjs` 跑。\n',
  })
  const j7 = handoffJson(collide, '--scan')
  const c7 = pick(j7.groups?.dangling, 'SKILL.md', 'dangling-name-collision')
  const collideOk = c7 !== undefined && c7.blocks === false && c7.suspect === true
    && j7.clean === true && j7.blocking === 0
  check(collideOk, '同名不同物：标为疑似且不计入 blocking（不挡验收）',
    c7 === undefined ? '没报出来' : `blocks=${c7.blocks} blocking=${j7.blocking}`)
  report(collideOk, '同名不同物：不挡验收')

  // ── 8) 工作流里对本 skill 脚本的调用：处置与文档里那一类不同 ──
  // 引用出现在机器会照着跑的配置里 → 那条调用会真的被执行，脚本没了就是坏了。
  // 所以它与「同名不同物」分开，并且计入 blocking。
  //
  // 这里**手工写一个带悬空调用的工作流**，而不是拿 `templates/ci-release.yml` 当夹具：
  // 模板自己已经不含这种调用（模板就该落盘成能跑的东西，指向别人家的脚本是错的）。
  // 拿模板当夹具曾让这条用例在模板改对之后变成空测——它测的其实是「模板有没有那个 bug」，
  // 而不是「判据认不认得出这种情况」。
  const wfDir = fixture('handoff-workflow', {
    '.github/workflows/release.yml': [
      'name: release',
      'on:',
      '  push:',
      "    tags: ['v*']",
      'jobs:',
      '  release:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: notes',
      '        run: node scripts/release-notes.mjs "$TAG" notes.md',
      '',
    ].join('\n'),
  })
  const j8 = handoffJson(wfDir, '--scan')
  const w8 = (j8.groups?.dangling ?? []).filter((f) => f.kind === 'dangling-script-in-automation')
  const wfOk = w8.length > 0 && w8.every((f) => f.blocks === true)
    && w8.some((f) => f.match === 'scripts/release-notes.mjs')
  check(wfOk, '工作流里对本 skill 脚本的调用：单独一类，计入 blocking',
    `命中 ${w8.length} 条`)
  report(wfOk, '工作流里的脚本调用：单独一类')
  // 落盘的模板顶部注释块里有本 skill 的名字——验收的总判据是「全项目搜名字零命中」，
  // 而机器原来看不见它。同样用**自造的**夹具，不拿真模板当输入：真模板哪天改成
  // 不含名字，这条用例就会静默失去对象，而它要守的是判据本身。
  const nameDir = fixture('handoff-name-in-comment', {
    '.github/workflows/release.yml': [
      '# project-forge 发布自动化骨架：打标签即写发布说明。',
      'name: release',
      'on:',
      '  push:',
      "    tags: ['v*']",
      'jobs:',
      '  release:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo ok',
      '',
    ].join('\n'),
  })
  const jName = handoffJson(nameDir, '--scan')
  const nameHit = pick(jName.groups?.markers, '.github/workflows/release.yml', 'skill-name-in-comment')
  const nameOk = nameHit !== undefined && nameHit.blocks === true
  check(nameOk, '落盘模板的注释块里出现本 skill 的名字 → 被检出',
    nameHit === undefined ? '没检出' : `第 ${nameHit.line} 行`)
  report(nameOk, '模板注释块：被检出')

  // ── 9) 临时文件：只有本 skill 自己的写法是确定痕迹 ──
  // 别的工具也留 `build.tmp-4242` 这种形状的临时文件，那不是本 skill 留下的，
  // 不该由本 skill 的报告说「删掉」，更不该因此挡住验收。
  const tmpDir = fixture('handoff-tmp', {
    'AGENTS.md.tmp-123': '半成品\n',
    'build.tmp-4242': '别家的缓存\n',
  })
  const j9 = handoffJson(tmpDir, '--scan')
  const ownTmp = pick(j9.groups?.residue, 'AGENTS.md.tmp-123', 'tmp-file')
  const otherTmp = pick(j9.groups?.residue, 'build.tmp-4242', 'tmp-file-suspect')
  const tmpOk = ownTmp?.blocks === true
    && otherTmp?.blocks === false && otherTmp?.suspect === true
    && j9.blocking === 1
  check(tmpOk, '临时文件：只有 AGENTS.md.tmp-<数字> 是确定痕迹，其余疑似且不挡验收',
    `own=${ownTmp?.blocks} other=${otherTmp?.blocks} blocking=${j9.blocking}`)
  report(tmpOk, '临时文件：分清是谁的')

  // ── 10) 发布说明草稿：可排除，且不挡验收 ──
  // 草稿里的 needs-summary 标记不单独报：文件名已经认出它是草稿了，再报一次就是
  // 把同一个文件数两遍，而两处的说法还不一样。
  const draft = fixture('handoff-draft', {
    'v0.9.1-notes.md': '# 草稿\n\n<!-- pf:needs-summary 缺总述 -->\n',
  })
  const j10 = handoffJson(draft, '--scan')
  const draftHits = every(j10.groups).filter((f) => f.path === 'v0.9.1-notes.md')
  const draftOk = draftHits.length === 1 && draftHits[0].kind === 'notes-draft'
    && draftHits[0].blocks === false && j10.blocking === 0 && j10.clean === true
  check(draftOk, '发布说明草稿：只报一次、不计入 blocking（用户可以决定保留）',
    `命中 ${draftHits.length} 次：${draftHits.map((f) => f.kind).join('、')}`)
  report(draftOk, '发布说明草稿：可排除')

  // ── 11) 注入中断的四种控制标记：各报各的名字 ──
  const ctrl = fixture('handoff-control', {
    'AGENTS.md': [
      '<!-- pf:if has-x -->',
      '<!-- pf:endif -->',
      '<!-- pf:scaffold -->',
      '<!-- pf:endscaffold -->',
      '',
    ].join('\n'),
  })
  const j11 = handoffJson(ctrl, '--scan')
  const c11 = (j11.groups?.markers ?? []).filter((f) => f.kind === 'inject-control')
  const ctrlOk = c11.length === 4
    && ['pf:if', 'pf:endif', 'pf:scaffold', 'pf:endscaffold']
      .every((n) => c11.some((f) => f.literal === n))
  check(ctrlOk, '四种控制标记各报各的名字（处置不同，不能报成一个串）',
    c11.map((f) => f.literal).join('、'))
  report(ctrlOk, '控制标记：各报各的')

  // ── 12) 目标给成文件：结论不能是肯定句 ──
  // 「没扫到」被读成「扫过了、很干净」是这个工具最不该有的误读，而零命中 + 一句
  // 「已经是干净状态」正是它的长相。
  const oneFile = handoff(join(cleanDir, 'README.md'), '--scan')
  const oneFileOk = /没扫到全部/.test(oneFile.stdout ?? '')
    && !/已经是干净状态/.test(oneFile.stdout ?? '')
  check(oneFileOk, '目标给成文件时，结论不是肯定句',
    (oneFile.stdout ?? '').split('\n').filter((l) => l.includes('结论')).join(' / '))
  report(oneFileOk, '只扫一部分：不肯定')
}

group('[32] DSH 新事实与本地 skills：按分发判、不写死名单')
{
  // files 缺 lib：成品包路线应报缺（review 拦），勘察只报事实
  const nofiles = fixture('dsh-nofiles', {
    'package.json': JSON.stringify({
      name: 'dsh-nofiles', version: '0.1.0', type: 'module',
      main: 'lib/index.js', exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: n\n      name: 'dsh-nofiles'\n",
    'lib/index.js': 'export const name = "n"\n',
  })
  const sn = survey(nofiles)
  const okN1 = sn.dsh?.filesHasLib === false
  check(okN1, 'files 缺 lib → 事实为假', JSON.stringify(sn.dsh?.filesHasLib))
  report(okN1, 'files 缺 lib：勘察报假')

  // 「已知 `dsh.*` 键」分两类，两类都不该报「不认识」，真不认识的要照报。
  // 正反必须一起写：只测「manifestVersion 不报」的话，一个把 unknownKeys 整个清空的
  // 实现也能过，而那正是下一版宿主加字段时最危险的那种退化。
  const keys = fixture('dsh-keys', {
    'package.json': JSON.stringify({
      name: 'dsh-keys', version: '0.1.0', type: 'module',
      exports: { '.': './lib/index.js' },
      files: ['lib/index.js', 'cordis.patch.yml'],
      icon: './icon.svg',
      engines: { node: '>=24', dsh: '0.2.1-alpha.1' },
      dsh: {
        manifestVersion: 1,
        sessionFormatMigration: { from: 3, to: 4 },
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        mystery: true,
      },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: k\n      name: 'dsh-keys'\n",
    'lib/index.js': 'export const name = "k"\n',
    'icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>\n',
  })
  const sk = survey(keys)
  const knownNoNoise = (sk.dsh?.unknownKeys ?? []).join() === 'mystery'
  check(knownNoNoise, '公开/内部字段不报，真不认识的照报',
    JSON.stringify({ unknown: sk.dsh?.unknownKeys }))
  report(knownNoNoise, '已知键：内部字段与公开字段均不误报，真未知键仍报出')
  const declFacts = sk.dsh?.hasManifestVersion === true && sk.dsh?.enginesDsh === '0.2.1-alpha.1'
    && sk.dsh?.hasIcon === true
  check(declFacts, '声明式元数据逐项读出', JSON.stringify({
    v: sk.dsh?.hasManifestVersion, engines: sk.dsh?.enginesDsh, icon: sk.dsh?.hasIcon,
  }))
  report(declFacts, '声明式元数据：格式版本、宿主范围、图标均读出')
  const noStale = sk.dsh !== undefined && sk.dsh.hasInvariantEntry === undefined
  check(noStale, '事实集里不再有宿主已移除的伴生入口字段', JSON.stringify(Object.keys(sk.dsh ?? {})))
  report(noStale, '陈旧字段：已随宿主移除而清干净')

  // 宿主运行时放错位置
  const baddep = fixture('dsh-baddep', {
    'package.json': JSON.stringify({
      name: 'dsh-baddep', version: '0.1.0',
      exports: { '.': './lib/index.js' },
      files: ['lib/index.js', 'cordis.patch.yml'],
      dependencies: { cordis: '^4.0.0' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: b\n      name: 'dsh-baddep'\n",
    'lib/index.js': 'export const name = "b"\n',
  })
  const sb = survey(baddep)
  const okN3 = sb.dsh?.hostRuntimeInDeps === true
  check(okN3, '宿主运行时进 dependencies → 标出', JSON.stringify(sb.dsh?.hostRuntimeInDeps))
  report(okN3, '依赖放错：标出')

  // 本地 skills 通用盘点：完全不同的名字也能认出，不写死名单
  const wskills = fixture('localskills', {
    'package.json': JSON.stringify({ name: 'w', version: '1.0.0' }),
    '.claude/skills/my-helper/SKILL.md': '---\nname: my-helper\ndescription: 帮我整理发布说明的本地 workflow\n---\n\n# my-helper\n',
  })
  const sw = survey(wskills)
  const okN4 = Array.isArray(sw.localSkills) && sw.localSkills.some((x) => x.path === '.claude/skills/my-helper')
  check(okN4, '本地 skills 按位置盘点（不写死名单）', JSON.stringify(sw.localSkills))
  report(okN4, '本地 skills：盘点出')
  compose(wskills)
  const tw = readFileSync(join(wskills, 'AGENTS.md'), 'utf8')
  const okN4b = /仓库本地 skills/.test(tw)
  check(okN4b, '有 skills → 契约含本地 skills 段')
  report(okN4b, '本地 skills：契约渲染')

  // 位置表加了新的一处之后，旧的位置**不能因此消失**——只测新位置的话，一个把表整个
  // 换掉的实现照样全绿。所以一处已有的、一处新加的、一个平铺文件，一起断言。
  const bases = fixture('skillbases', {
    'package.json': JSON.stringify({ name: 'b', version: '1.0.0' }),
    '.dsh/skills/proj-one/SKILL.md': '---\nname: proj-one\ndescription: 项目内那份本地 workflow，用来做勘察\n---\n',
    '.agents/skills/proj-two/SKILL.md': '---\nname: proj-two\ndescription: 另一处项目内的本地 workflow\n---\n',
    '.claude/skills/old-three/SKILL.md': '---\nname: old-three\ndescription: 原有位置那份，本轮不该被挤掉\n---\n',
    '.dsh/skills/flat-four.md': '---\nname: flat-four\ndescription: 平铺文件形态的能力目录\n---\n',
  })
  const sb2 = survey(bases)
  const paths = (sb2.localSkills ?? []).map((x) => x.path)
  const okBases = ['.dsh/skills/proj-one', '.agents/skills/proj-two', '.claude/skills/old-three', '.dsh/skills/flat-four.md']
    .every((p) => paths.includes(p))
  check(okBases, '各处位置都收（旧位置不因新增而消失）', JSON.stringify(paths))
  report(okBases, '本地 skills 位置：新旧并存，平铺文件也收')

  // 「装上了却像不存在」是这一类最常见也最难查的故障：宿主不加载，而且**不告诉模型**。
  // 三种成因各要能单独报出来，正向的（正常 skill）也必须干净，否则一个「一律报坏」的
  // 实现也能让上面那条通过。
  const dropped = fixture('skilldropped', {
    'package.json': JSON.stringify({ name: 'd', version: '1.0.0' }),
    '.dsh/skills/fine/SKILL.md': '---\nname: fine\ndescription: 完全正常的一份本地 workflow\n---\n',
    '.dsh/skills/legacy-key/SKILL.md': '---\nname: legacy-key\ndescription: 驼峰调用键\nuserInvocable: true\n---\n',
    '.dsh/skills/bad-value/SKILL.md': '---\nname: bad-value\ndescription: 取值非法\ndisable-model-invocation: maybe\n---\n',
    '.dsh/skills/too-deep/deeper/SKILL.md': '---\nname: too-deep\ndescription: 比发现深度多一层\n---\n',
  })
  const sd = survey(dropped)
  const byPath = Object.fromEntries((sd.localSkills ?? []).map((x) => [x.path, x]))
  const okDropKey = /userInvocable/.test(byPath['.dsh/skills/legacy-key']?.dropped ?? '')
  check(okDropKey, '驼峰调用键 → 报出丢弃成因', JSON.stringify(byPath['.dsh/skills/legacy-key']?.dropped))
  report(okDropKey, '丢弃成因：驼峰调用键')
  const okDropVal = /disable-model-invocation/.test(byPath['.dsh/skills/bad-value']?.dropped ?? '')
  check(okDropVal, '取值非法 → 报出丢弃成因', JSON.stringify(byPath['.dsh/skills/bad-value']?.dropped))
  report(okDropVal, '丢弃成因：调用键取值非法')
  const okDropDeep = /deeper/.test(byPath['.dsh/skills/too-deep']?.dropped ?? '')
  check(okDropDeep, '入口多一层 → 报出宿主走不到那里', JSON.stringify(byPath['.dsh/skills/too-deep']?.dropped))
  report(okDropDeep, '丢弃成因：入口比发现深度多一层')
  const okFine = byPath['.dsh/skills/fine']?.dropped === undefined && byPath['.dsh/skills/fine']?.corrupt !== true
  check(okFine, '正常 skill 不误报坏', JSON.stringify(byPath['.dsh/skills/fine']))
  report(okFine, '反向：正常 skill 不误报')
  compose(dropped)
  const td = readFileSync(join(dropped, 'AGENTS.md'), 'utf8')
  const okDropSec = /宿主不会加载的 skills/.test(td)
  check(okDropSec, '有被丢弃的 → 契约含专门一节')
  report(okDropSec, '被丢弃的 skills：契约渲染')
  compose(wskills)
  const tw2 = readFileSync(join(wskills, 'AGENTS.md'), 'utf8')
  const okNoDropSec = !/宿主不会加载的 skills/.test(tw2)
  check(okNoDropSec, '没有被丢弃的 → 不渲染那一节（不制造噪音）')
  report(okNoDropSec, '反向：无丢弃则不渲染该节')

  // 反向：无 skills 时为空数组，不误报
  const noskills = fixture('noskills', {
    'package.json': JSON.stringify({ name: 'n', version: '1.0.0' }),
  })
  const sn2 = survey(noskills)
  const okN5 = Array.isArray(sn2.localSkills) && sn2.localSkills.length === 0
  check(okN5, '无 skills 时为空（不误报）', JSON.stringify(sn2.localSkills))
  report(okN5, '无 skills：为空')
}


// ── 检查域与判据的适用范围（守的是一类错误，不是一次） ──────────────────────

group('[38] 文本检查域 = 仓库定义域：本机状态目录不参与，仓库内的照旧全查')
{
  // 这一组守的是**一类**错误：检查器走文件系统，把「工作目录里现在有什么」当成「这个
  // 仓库的内容」。于是依赖目录、编辑器缓存、多智能体协作的团队清单都被拿去查 emoji 与
  // 私有路径，还被要求解释「为什么在这」——而它们 `git ls-files` 计数为 0，根本不属于
  // 这个仓库。
  //
  // 判据必须是仓库的定义域（受跟踪 + 未忽略），且**不能靠往豁免名单里加目录名**：那样
  // 每来一个工具就要再加一条。下面同时给正例与反例：被忽略的目录必须缺席，未忽略的新
  // 目录必须照旧被抓——否则「缺席」可能只是检查失灵。
  const EMOJI_MARK = String.fromCodePoint(0x2795)
  const FAKE_HOME = ['C:', 'Users', 'someone', 'work.md'].join('\\')

  // 1) 判定本身：受跟踪的、未忽略的新文件都在域内，被忽略的不在。
  if (HAS_GIT) {
    const repo = fixture('domain-git', {
      '.gitignore': 'generated-state/\n',
      'tracked.md': '# tracked\n',
      'untracked.md': '# untracked\n',
      'generated-state/state.json': '{ "note": "本机状态" }\n',
    })
    gitIn(repo, 'init')
    gitIn(repo, 'add', 'tracked.md')
    const d = listRepoFiles(repo)
    const ok = d.source === 'git'
      && d.files.includes('tracked.md')
      && d.files.includes('untracked.md')
      && d.files.includes('.gitignore')
      && !d.files.some((p) => p.startsWith('generated-state/'))
      && !d.files.some((p) => p.startsWith('.git/'))
    check(ok, '定义域 = 受跟踪 + 未忽略', JSON.stringify({ source: d.source, files: d.files }))
    report(ok, '定义域：被忽略的目录不进')
  } else {
    skipGroup('[38.1] 定义域的版本控制判定', '本机没有 git')
  }

  // 2) 没有 git 时：退回文件系统扫描（跳过两个一定不属于仓库的目录），判定要如实交代来源。
  {
    const plain = fixture('domain-fs', {
      'a.md': '# a\n',
      'node_modules/pkg/index.js': 'x\n',
      '.git/config': 'y\n',
    })
    const d = listRepoFiles(plain)
    const ok = d.source === 'fs' && d.files.includes('a.md')
      && !d.files.some((p) => p.startsWith('node_modules/') || p.startsWith('.git/'))
    check(ok, '无 git 时降级但可用', JSON.stringify({ source: d.source, files: d.files }))
    report(ok, '降级：退回文件系统扫描')
  }

  // 3) 端到端（正例）：整棵 skill 树 + 被忽略的本机状态目录 → 全绿，且那些目录一个字都不提。
  if (!HAS_GIT) {
    skipGroup('[38.3] 检查域的端到端判定', '本机没有 git')
  } else {
    const clone = join(fixture('domain-e2e', {}), 'project-forge')
    copyTree(SKILL_ROOT, clone, new Set(['.git', '.agent-teams', 'node_modules', 'selftest.mjs']))
    writeFileSync(join(clone, 'scripts', 'dev', 'selftest.mjs'), SELFTEST_STUB, 'utf8')
    // 两个本机状态目录：一个被仓库自己的 .gitignore 兜住（真实场景），一个由本 fixture
    // 新加一条忽略规则兜住——后者证明判据认的是「被忽略」这件事，不是某个目录名。
    mkdirSync(join(clone, '.agent-teams'), { recursive: true })
    writeFileSync(join(clone, '.agent-teams', 'team.json'),
      `{"note":"本机状态","mark":"${EMOJI_MARK}","path":"${FAKE_HOME}"}\n`, 'utf8')
    writeFileSync(join(clone, '.gitignore'),
      `${readFileSync(join(clone, '.gitignore'), 'utf8')}**/.other-tool/\n`, 'utf8')
    mkdirSync(join(clone, '.other-tool'), { recursive: true })
    writeFileSync(join(clone, '.other-tool', 'cache.json'), `{"mark":"${EMOJI_MARK}"}\n`, 'utf8')
    gitIn(clone, 'init')
    gitIn(clone, 'add', '-A')

    const r1 = preflightIn(clone)
    const silent = !/\.agent-teams|\.other-tool/.test(r1.out)
    check(silent, '被忽略的本机状态目录不进检查域、不做顶层告警',
      r1.out.split('\n').filter((l) => /FAIL|WARN/.test(l)).join(' / '))
    report(silent, '本机状态：不进域、不告警')
    const green = r1.status === 0 && /0 项失败/.test(r1.out)
    check(green, '植入本机状态后仍然全绿', `exit=${r1.status}`)
    report(green, '结果：0 项失败')

    // 4) 端到端（反例，证伪用）：同一个仓库里，未忽略的新目录必须照旧被抓——内容与顶层归属都报。
    mkdirSync(join(clone, '.unregistered-tool'), { recursive: true })
    writeFileSync(join(clone, '.unregistered-tool', 'state.json'),
      `{"mark":"${EMOJI_MARK}"}\n`, 'utf8')
    const r2 = preflightIn(clone, { only: "硬性规范" })
    const caught = r2.status === 1 && /\.unregistered-tool\/state\.json/.test(r2.out)
      && /未登记的条目：\.unregistered-tool/.test(r2.out)
    check(caught, '未忽略的新目录照旧被抓（内容与顶层归属都报）',
      r2.out.split('\n').filter((l) => /FAIL|WARN/.test(l)).join(' / '))
    report(caught, '对照：未忽略的新目录照旧被抓')
  }

  // 5) 端到端（降级）：没有版本控制时，提示必须出现（不许静默假装成功），且正常文件照旧查。
  {
    const plain = join(fixture('domain-nogit', {}), 'project-forge')
    copyTree(SKILL_ROOT, plain, new Set(['.git', '.agent-teams', 'node_modules', 'selftest.mjs']))
    writeFileSync(join(plain, 'scripts', 'dev', 'selftest.mjs'), SELFTEST_STUB, 'utf8')
    writeFileSync(join(plain, 'notes-with-emoji.md'), `# 正常文件\n\n${EMOJI_MARK}\n`, 'utf8')
    const r = preflightIn(plain)
    const declared = /退回文件系统扫描/.test(r.out)
    check(declared, '无 git 时显式报告降级', r.out.split('\n').filter((l) => /WARN/.test(l)).join(' / '))
    report(declared, '降级：显式报告，不静默')
    const stillScanned = /notes-with-emoji\.md/.test(r.out) && /自检完成/.test(r.out)
    check(stillScanned, '降级时正常文件照旧全查，且不崩')
    report(stillScanned, '降级：正常文件照旧查')
  }
}

group('[43] host= 机制：三态比对、键形状、两键同批、查法判据、kind 清单')
{
  {
    const samePairs = [
      [normVersion('^1.2.3'), normVersion('1.2.3')],
      [normVersion('v0.1.6'), normVersion('0.1.6')],
      [normVersion('0.1.6-RC.1'), normVersion('0.1.6-rc.1')],
      [normVersion(' >= 0.1.6 '), normVersion('0.1.6')],
    ]
    const okSame = samePairs.every(([a, b]) => a === b)
    check(okSame, '归一等价：前缀 / v / 大小写 / 空白都算同一版', JSON.stringify(samePairs))
    check(normVersion('0.1.5-rc.1') !== normVersion('0.1.5'),
      '预发布与正式版**不同**（不折叠：那是两次不同的发布）')
    report(okSame, '归一化：只吃写法差异')
  }

  {
    const match = compareHostMarker('1.2.3', [{ source: 'cli', value: 'v1.2.3' }])
    const mismatch = compareHostMarker('1.2.3', [{ source: 'cli', value: '9.9.9' }])
    const none = compareHostMarker('1.2.3', [{ source: 'cli', value: undefined, reason: '未装' }])
    const conflict = compareHostMarker('1.2.3', [
      { source: 'cli', value: '1.2.3' },
      { source: 'metadata', value: '2.0.0' },
    ])
    check(match.state === 'match', '一致 → match（调用方据此静默）', match.state)
    check(mismatch.state === 'mismatch' && /1\.2\.3/.test(mismatch.reason) && /9\.9\.9/.test(mismatch.reason),
      '不同 → mismatch 且报出两个值', mismatch.reason)
    check(none.state === 'undetermined' && /取不到/.test(none.reason), '取不到 → undetermined（未核对 + 原因）', none.reason)
    check(conflict.state === 'undetermined' && /矛盾/.test(conflict.reason),
      '两条来源矛盾 → undetermined（无法确定，不是「不同」）', conflict.reason)
    const ok = match.state === 'match' && mismatch.state === 'mismatch'
      && none.state === 'undetermined' && conflict.state === 'undetermined'
    report(ok, 'host 机制：四态结论都可证伪')
  }

  {
    const good = parseMarkerKeys('host=9.9.9 date=2026-01-01')
    check(good.errors.length === 0 && good.keys.host === '9.9.9',
      'host=9.9.9 放行（合法形状，落「不同」态而不是形状错误）', JSON.stringify(good.errors))
    const empty = parseMarkerKeys('host=')
    check(empty.errors.length === 1 && /空/.test(empty.errors[0]), '空值 → 形状错误', JSON.stringify(empty.errors))
    const multi = parseMarkerKeys('host=1.2.3,2.0.0 date=2026-01-01')
    check(multi.errors.length === 1 && /单个/.test(multi.errors[0]), '多值 host= → 形状错误并提示改写', JSON.stringify(multi.errors))
    const spaced = parseMarkerKeys('note=two words')
    check(spaced.errors.length >= 1, '值里带空白 → 形状错误（值必须非空且单行）', JSON.stringify(spaced.errors))
    const unknownKey = parseMarkerKeys('hostv=1 date=2026-01-01')
    check(unknownKey.errors.length === 0 && unknownKey.notes.length === 1 && /没有认领/.test(unknownKey.notes[0]),
      '未登记的键：不失败，但提示「未核对」', JSON.stringify(unknownKey.notes))
    report(good.errors.length === 0 && empty.errors.length === 1 && multi.errors.length === 1, '标记键形状：四条判据各自可证伪')
  }

  {
    const mkGit = (logOut, beforeText, afterText) => (args) => {
      if (args.includes('log')) return logOut
      const target = args[1] ?? ''
      if (target.includes('^:')) return beforeText
      return afterText
    }
    const stale = hostDateBatchStatus('/x', 'references/plugins/dsh.md', '1.0.0',
      mkGit('abc1234\n', '<!-- dsh-verified: host=1.0.0 date=2026-01-01 -->\n', '<!-- dsh-verified: host=1.0.0 date=2026-01-01 -->\n'))
    check(stale.state === 'stale', 'host= 变了而 date= 没变 → stale（那条日期不可信）', stale.reason)
    const okBatch = hostDateBatchStatus('/x', 'references/plugins/dsh.md', '1.0.0',
      mkGit('abc1234\n', '<!-- dsh-verified: host=0.9.0 date=2026-01-01 -->\n', '<!-- dsh-verified: host=1.0.0 date=2026-03-01 -->\n'))
    check(okBatch.state === 'ok', '同批改动 → ok（安静）', okBatch.reason)
    const unknown = hostDateBatchStatus('/x', 'references/plugins/dsh.md', '1.0.0', mkGit('', '', ''))
    check(unknown.state === 'unverified' && /未提交|未跟踪|git 历史/.test(unknown.reason),
      '取不到那次提交 → unverified（不静默、不失败）', unknown.reason)
    report(stale.state === 'stale' && okBatch.state === 'ok' && unknown.state === 'unverified',
      '两键同批：stale / ok / unverified 三态都有正反例')
  }

  {
    const minimal = '# x\n\n## 事实来源\n\n<!-- npm-verified: date=2026-01-01 -->\n'
    const withLink = '# x\n\n## 事实来源\n\n字段上限见 https://docs.npmjs.com/cli/v10/commands/npm-publish 一节。\n\n<!-- npm-verified: date=2026-01-01 -->\n'
    const bodyMinimal = freshnessSectionBody(minimal)
    const bodyLink = freshnessSectionBody(withLink)
    check(!hasActionableSources(bodyMinimal), '只有标题 + 标记的「事实来源」节不通过（判据不再永真）', JSON.stringify(bodyMinimal))
    check(hasActionableSources(bodyLink), '写出链接的节通过（别把判据做宽到误报）', JSON.stringify(bodyLink.slice(0, 40)))
    report(!hasActionableSources(bodyMinimal) && hasActionableSources(bodyLink), '查法判据：正反例都能证伪')
  }

  {
    const doc = readFileSync(join(SKILL_ROOT, 'references', 'survey.md'), 'utf8')
    const para = /常见的 `kinds` 取值：([\s\S]*?)。\n/.exec(doc)
    const documented = para === null ? [] : [...para[1].matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1])
    const code = kindVocabulary()
    const missing = code.filter((k) => !documented.includes(k))
    const extra = documented.filter((k) => !code.includes(k))
    check(missing.length === 0 && extra.length === 0,
      'references/survey.md 的 kind 清单与代码值域集合相等（新增生态必须同步文档）',
      JSON.stringify({ missing, extra }))
    report(missing.length === 0 && extra.length === 0, `kind 清单：${code.length} 个，文档与代码一致`)
  }
}

group('[29] CONTRIBUTING 内容门：通用齐全才放行，专属按生态查')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const GOOD = `# C 贡献指南

## 提问与反馈

到 Issue 区提出。

## 报告缺陷

四件事。

## 提出改动

先 fork，在分支上开发，跑完门禁全绿再提交开请求。不推主干，不打标签，不发布。

## 开发环境

用 pnpm 安装依赖后构建测试。

## 提交前门禁

跑构建测试，全绿才算完成。

## 硬性规范

完整规范以 AGENTS.md 为准。

## 提交信息

一句话。

## 许可

见 LICENSE。
`

  // 好文件：node+插件生态下无 CONTRIBUTING 缺项
  const good = fixture('contrib-good', {
    'package.json': JSON.stringify({
      name: 'p', version: '1.0.0', scripts: { build: 'tsc', test: 'vitest run' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: p\n      name: 'p'\n",
    'AGENTS.md': '# p\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    'README.md': '# p\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': `${GOOD}产物与源码一起提交。本地挂载后重启宿主验证。\n`,
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const r1 = review(good, '--no-bilingual', '--no-auto-release')
  const ok1 = !/CONTRIBUTING 缺/.test(r1.stdout ?? '')
  check(ok1, '好文件不报 CONTRIBUTING 缺', (r1.stdout ?? '').split('\n').find((l) => /CONTRIBUTING/.test(l)) ?? '')
  report(ok1, '好文件：放行')

  // 缺 fork 与门禁 → 报缺
  const bad = fixture('contrib-bad', {
    'package.json': JSON.stringify({ name: 'q', version: '1.0.0', scripts: { test: 'x' } }),
    'AGENTS.md': '# q\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    'README.md': '# q\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': '# 贡献\n\n随便改改就行。\n',
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const r2 = review(bad, '--no-bilingual', '--no-auto-release')
  const ok2 = r2.status !== 0 && /CONTRIBUTING 缺/.test(r2.stdout ?? '')
  check(ok2, '缺核心节报缺且非零退出', `exit=${r2.status}`)
  report(ok2, '坏文件：拦得住')

  // 插件缺产物同提交 → 报缺
  const noartifact = fixture('contrib-noartifact', {
    'package.json': JSON.stringify({
      name: 'r', version: '1.0.0', scripts: { test: 'x' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: r\n      name: 'r'\n",
    'AGENTS.md': '# r\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    'README.md': '# r\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': GOOD,
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const r3 = review(noartifact, '--no-bilingual', '--no-auto-release')
  const ok3 = /产物同提交/.test(r3.stdout ?? '')
  check(ok3, '插件缺产物同提交报缺', (r3.stdout ?? '').split('\n').find((l) => /产物/.test(l)) ?? '')
  report(ok3, '插件专属：拦得住')
}

group('[39] 缺节判据只对结构由脚本决定的文件成立')
{
  // 这一组守的是「拿骨架的 H2 标题字面差集当缺节判据」这一类错误：**写了但措辞不同**
  // （本 skill 自己的「版本管理流程」对骨架的「版本管理」）会被永远报成没写，而作者
  // 并没有「补」的义务——脚本从来不会替他补这些节。判据必须先问结构是谁定的：
  //   生成 → 缺节是缺陷（防空壳契约过 CI）；升级 → 缺节是待办；作者编排 → 判据不适用。
  const pkg = '{"name":"t","version":"1.0.0","scripts":{"test":"x"}}\n'

  // 1) 生成的文件：掏空一节 → --check 必须失败。
  {
    const dir = fixture('sec-managed', { 'package.json': pkg })
    compose(dir)
    const f = join(dir, 'AGENTS.md')
    const before = readFileSync(f, 'utf8')
    check(before.includes('<!-- project-forge:managed -->'), '前提：生成物带 managed 标记')
    const gutted = before.replace(/^## 版本管理（必守）[\s\S]*?(?=^## |(?![\s\S]))/m, '')
    check(gutted !== before && gutted.length < before.length, '前提：成功删掉一节')
    writeFileSync(f, gutted, 'utf8')
    const r = composeExpectingFailure(dir, '--check')
    const ok = r.status === 1 && /缺失/.test(r.stderr ?? '')
    check(ok, '生成的文件缺节 → --check 失败', `exit=${r.status}`)
    report(ok, '生成：缺节是缺陷')
  }

  // 2) 作者编排的文件：抹掉 managed 标记并删掉一整节 → 判据不适用：--check 通过且不报缺节。
  {
    const dir = fixture('sec-authored', { 'package.json': pkg })
    compose(dir)
    const f = join(dir, 'AGENTS.md')
    const text = readFileSync(f, 'utf8')
      .replace('<!-- project-forge:managed -->\n\n', '')
      .replace(/^## 测试（约定）[\s\S]*?(?=^## |(?![\s\S]))/m, '')
      .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写）')
    writeFileSync(f, text, 'utf8')
    const r1 = composeExpectingFailure(dir, '--check')
    const ok1 = r1.status === 0 && !/缺失/.test(`${r1.stdout ?? ''}${r1.stderr ?? ''}`)
    check(ok1, '作者编排的文件：不判缺节，--check 通过', `exit=${r1.status} ${(r1.stdout ?? '').trim()}`)
    report(ok1, '作者编排：不判缺节')
    const r2 = compose(dir, '--status')
    const out2 = r2.stdout ?? ''
    // 「没查」与「查过没有」必须可区分：作者编排的文件，脚本不按模板的标题清单判缺节，
    // 所以它既不能报「内容完整」（那是拿没查充数），也不该报缺。
    const ok2 = /缺节判据不适用|判据不适用/.test(out2)
      && !out2.split('\n').some((l) => l.trim().startsWith('内容完整'))
    check(ok2, '作者编排的文件：声明缺节判据不适用，且不拿它充「内容完整」', out2.trim().split('\n')[1] ?? '')
    report(ok2, '作者编排：不判缺节，也不报完整')
  }

  // 3) 升级的文件：--upgrade 落一个 upgraded 标记（判据有据可依，不靠猜），缺节仍作待办报出。
  {
    const dir = fixture('sec-upgraded', { 'package.json': pkg })
    writeFileSync(join(dir, 'AGENTS.md'), '# x\n\n说明。\n\n## 怎么跑\n\nnpm test\n', 'utf8')
    compose(dir, '--upgrade')
    const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const marked = after.includes('<!-- project-forge:upgraded -->')
    check(marked, '--upgrade 留下 upgraded 标记（判据有据可依）', after.slice(0, 80).replace(/\n/g, ' '))
    report(marked, '升级：标记落盘')
    const r = composeExpectingFailure(dir, '--check')
    const ok = r.status === 0 && /提示：缺失/.test(r.stdout ?? '')
    check(ok, '升级的文件：缺节是待办（提示），不是缺陷', `exit=${r.status}`)
    report(ok, '升级：缺节只提示')

    // 4) 同一批缺节只打印一次：两处报告说同一件事就会给出两个结论——一处说
    //    「这些节没写，文档就不算完成」，紧接着另一处说「未自动添加，需要就手动补」。
    const r2 = compose(dir)
    const text = `${r2.stdout ?? ''}${r2.stderr ?? ''}`
    const heads = (text.match(/缺失 \d+ 个节|模板里有、本文件没有的节/g) ?? []).length
    const ok2 = heads <= 1
    check(ok2, '同一批缺节只报一次（两处矛盾的报告已合并）', `出现 ${heads} 次`)
    report(ok2, '缺节报告：只出现一次')
  }
}

group('[8] 手写的 AGENTS.md：默认不动，--upgrade 只做加法')
{
  const dir = fixture('handwritten', {
    'package.json': '{"name":"legacy","version":"1.0.0"}\n',
    'src/index.ts': 'export const x = 1\n',
  })
  const original = `# legacy\n\n一句说明。\n\n## 项目简介\n\n做报表用的。\n\n## 怎么跑\n\nnpm test。\n\n## 注意事项\n\n- 别乱改数据库\n`
  writeFileSync(join(dir, 'AGENTS.md'), original, 'utf8')

  const r1 = composeExpectingFailure(dir)
  const untouched = readFileSync(join(dir, 'AGENTS.md'), 'utf8') === original
  check(r1.status === 0, '默认运行不报错', `退出码 ${r1.status}`)
  check(untouched, '默认运行不动手写文件')
  check(/缺少这些节/.test(r1.stdout), '输出了缺口报告')
  report(r1.status === 0 && untouched, '默认运行：不报错、不动文件、给出体检')

  const r2 = composeExpectingFailure(dir, '--upgrade')
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
  ]
  for (const [label, ok] of checks) { check(ok, label, lost.length > 0 ? `丢失：${lost.join(' | ')}` : undefined); report(ok, label) }

  // `--check` 会验「有没有缺失的节」，但**按文件性质区别对待**：
  //   - 脚本生成的文件（带 managed 标记）→ 缺节是缺陷，失败；
  //   - 作者手写后被升级的 → 作者的编排是权威，缺节只提示。
  // 前者防「被掏空的契约过 CI」，后者防「逼作者改成模板的样子」——两种错法都要挡住。
  const upCheck = composeExpectingFailure(dir, '--check')
  const okUp = upCheck.status === 0 && /提示：缺失/.test(upCheck.stdout ?? '')
  check(okUp, '作者编排的文件：缺节只提示，--check 仍通过', `exit=${upCheck.status}`)
  report(okUp, '作者编排的文件：缺节只提示')

  // 生成的文件删掉一整节 → 必须失败（否则一份被掏空的契约能过 CI）
  const gdir = fixture('gutted', { 'package.json': '{"name":"g","version":"1.0.0"}\n' })
  compose(gdir)
  const gf = join(gdir, 'AGENTS.md')
  const gt = readFileSync(gf, 'utf8')
  // 删「文档同步」——它对任何项目都会生成，不像「依赖版本同步」只在有依赖时才有。
  // 注意结束锚点用 `(?![\s\S])` 而不是 `\Z`：后者不是 JavaScript 的正则转义，
  // 会被当成字面量 Z，于是当这一节位于文件末尾时匹配不上。
  const killed = gt.replace(/^## 文档同步[\s\S]*?(?=^## |(?![\s\S]))/m, '')
  check(killed !== gt && killed.length < gt.length, '前提：成功删掉一节',
    `${gt.length} -> ${killed.length}`)
  writeFileSync(gf, killed, 'utf8')
  const gcheck = composeExpectingFailure(gdir, '--check')
  const okGut = gcheck.status !== 0 && /缺失/.test(gcheck.stderr ?? '')
  check(okGut, '生成的文件被掏空 → --check 失败', `exit=${gcheck.status}`)
  report(okGut, '生成的文件被掏空 → --check 失败')

  // 在正文里合法地加一行注释，不该被指控成「内核不一致」
  const cdir = fixture('comment-added', { 'package.json': '{"name":"c","version":"1.0.0"}\n' })
  compose(cdir)
  const cf = join(cdir, 'AGENTS.md')
  writeFileSync(cf, readFileSync(cf, 'utf8')
    .replace('### 提交纪律', '<!-- 我们自己的补充说明 -->\n### 提交纪律'), 'utf8')
  const ccheck = composeExpectingFailure(cdir, '--check')
  const okComment = ccheck.status === 0
  check(okComment, '正文合法编辑不被误指为内核不一致', `exit=${ccheck.status}`)
  report(okComment, '正文合法编辑不被误报')
}

group('[36] 发布自动化接线：动作痕迹无 OIDC 即待问，有 OIDC 即安静')
{
  const rv = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const rvOut = (r) => r.stdout ?? ''
  const baseFlags = ['--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release']
  const relBase = (extraStep) => 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n'
    + `      - run: ${extraStep}\n        env:\n          GH_TOKEN: \${{ secrets.RELEASE_TOKEN }}\n`

  // npm：有 publish 无 OIDC → 待问；加了 id-token 即安静。
  const npmNo = fixture('auto-npmno', {
    'package.json': '{"name":"p","version":"1.0.0"}\n',
    '.github/workflows/release.yml': `${relBase('npm publish')}`,
  })
  const okN1 = /npm 有发布动作但无 OIDC/.test(rvOut(rv(npmNo, ...baseFlags)))
  check(okN1, 'npm 无 OIDC → 待问')
  report(okN1, 'npm 接线：问得住')
  const npmYes = fixture('auto-npmyes', {
    'package.json': '{"name":"p","version":"1.0.0"}\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\n  contents: write\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n        env:\n          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}\n',
  })
  const okN2 = !/npm 有发布动作但无 OIDC/.test(rvOut(rv(npmYes, ...baseFlags)))
  check(okN2, 'npm 有 OIDC → 不误报')
  report(okN2, 'npm 接线：安静')

  // PyPI：twine 痕迹无 OIDC → 待问。
  const pyNo = fixture('auto-pyno', {
    'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n',
    '.github/workflows/release.yml': `${relBase('twine upload dist/*')}`,
  })
  const okP1 = /PyPI 有发布动作但无 OIDC/.test(rvOut(rv(pyNo, ...baseFlags)))
  check(okP1, 'PyPI 无 OIDC → 待问')
  report(okP1, 'PyPI 接线：问得住')

  // cargo：cargo publish 痕迹无 OIDC → 待问。
  const rsNo = fixture('auto-rsno', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\n',
    '.github/workflows/release.yml': `${relBase('cargo publish')}`,
  })
  const okR1 = /crates\.io 有发布动作但无 OIDC/.test(rvOut(rv(rsNo, ...baseFlags)))
  check(okR1, 'cargo 无 OIDC → 待问')
  report(okR1, 'cargo 接线：问得住')

  // Release 形状三件套：缺 contents:write 即待问；齐了即安静。
  const noContents = fixture('auto-nocontents', {
    'package.json': '{"name":"p","version":"1.0.0"}\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          fetch-depth: 0\n      - run: gh release create test --notes-file n\n        env:\n          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}\n',
  })
  const okC1 = /contents: write/.test(rvOut(rv(noContents, ...baseFlags)))
  check(okC1, '缺 contents:write → 待问')
  report(okC1, 'Release 形状：问得住')
}

group('[40] 保鲜节标题：编号与括注是装饰，不该让专章判成缺节')
{
  // 专章模板的骨架写的是 `## 八、事实来源（必填）`：编号让它在文件里定位得到，括注提醒
  // 写的人这一节必填。判据要抓的是「这一节在不在」，不是标题那一串字——按字面匹配会让
  // 照模板新建的专章被判成没有来源节，模板与检查器互相打架。
  const todayStr = new Date().toISOString().slice(0, 10)
  const tomorrowStr = new Date(Date.parse(`${todayStr}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  const withHeading = (h) => `# 测试生态 插件\n\n## 何时读本文件\n\n- 略\n\n${h}\n\n来源略。\n\n`
    + `<!-- foo-verified: date=${todayStr} -->\n`
  const run = (text) => evalFreshnessMarker('references/plugins/foo.md', text, todayStr, tomorrowStr)

  for (const [label, heading] of [
    ['裸标题', '## 事实来源'],
    ['中文编号', '## 八、事实来源'],
    ['尾部括注', '## 事实来源（必填）'],
    ['编号 + 括注（专章模板的写法）', '## 八、事实来源（必填）'],
    ['阿拉伯编号', '## 3. 事实来源'],
  ]) {
    const r = run(withHeading(heading))
    const ok = r.hasSection && r.errors.length === 0
    check(ok, `标题形状放行：${label}`, JSON.stringify(r.errors))
    report(ok, `放行：${label}`)
  }

  // 反例：放宽的是装饰，不是判据本身——真缺节仍然红。
  {
    const r = run(`# x\n\n## 何时读本文件\n\n- 略\n\n来源略。\n\n<!-- foo-verified: date=${todayStr} -->\n`)
    const ok = !r.hasSection && r.errors.some((e) => /没有对应/.test(e))
    check(ok, '真缺节仍然红', JSON.stringify(r.errors))
    report(ok, '反例：真缺节仍然红')
  }
  // 反例：改名不算这一节（判据没有被放宽成「有来源二字就算」）。
  {
    const ok = !run(withHeading('## 事实来源与更新')).hasSection
    check(ok, '改名不算这一节（判据没被放宽成永真）')
    report(ok, '反例：改名不算')
  }
  // 反例：三级标题不算——要求的是二级标题。
  {
    const ok = !run(withHeading('### 事实来源')).hasSection
    check(ok, '三级标题不算（要求二级标题）')
    report(ok, '反例：三级标题不算')
  }
}

// ── 机制类断言：把「文档与实现不一致」这一类错误固定下来 ──────────────────────

group('[1] 无 git 仓库时的密钥扫描必须覆盖子目录')
{
  const dir = fixture('secrets', {
    'README.md': '# app\n',
    'src/config.py': `API_KEY = "${FAKE_GH_TOKEN}"\n`,
    'tests/fixtures/token.json': `{"t":"${FAKE_NPM_TOKEN}"}\n`,
    'bin/.env': `AWS_KEY=${FAKE_AWS_KEY}\n`,
    '中文目录/泄漏.txt': `token = "${FAKE_GH_TOKEN}"\n`,
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
  // 深度超限：25 层嵌套必触发 depthLimited，“没扫到深层”不能读成干净
  const deepFiles = {}
  let deepPath = ''
  for (let i = 0; i < 25; i += 1) deepPath += `d${i}/`
  deepFiles[`${deepPath}deep.py`] = 'x = 1\n'
  const deepDir = fixture('deep-limit', deepFiles)
  const sd = survey(deepDir)
  const okDepth = (sd.risks?.contentScan?.depthLimited ?? 0) > 0
  check(okDepth, '超深目录 → depthLimited 计数大于 0', JSON.stringify(sd.risks?.contentScan?.depthLimited))
  report(okDepth, '深度超限：如实标记')
  // 文件数超限：超 5000 候选必触发 truncated，“0 命中”不能读成干净
  const manyFiles = {}
  for (let i = 0; i < 5100; i += 1) manyFiles[`f${String(i).padStart(4, '0')}.txt`] = 'x\n'
  const manyDir = fixture('many-files', manyFiles)
  const sm = survey(manyDir)
  const okTrunc = sm.risks?.contentScan?.truncated === true
  check(okTrunc, '超量文件 → truncated 为真', String(sm.risks?.contentScan?.filesScanned))
  report(okTrunc, '文件超限：如实标记')
  for (const [label, ok] of [['密钥覆盖子目录', /config\.py/.test(hits)],
    ['密钥覆盖 bin/', /\.env/.test(hits)], ['密钥覆盖中文路径', /泄漏/.test(hits)]]) report(ok, label)
}

group('[24] 工作流自动化现状：有无发布 job、用没用 Secrets 要能读出来')
{
  // 正向：带发布 job 且引用 Secrets 的工作流
  const withRelease = fixture('auto-with', {
    'package.json': '{"name":"demo","version":"0.1.0"}\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create "$TAG" --generate-notes\n        env:\n          GH_TOKEN: ${{ secrets.RELEASE_TOKEN }}\n',
  })
  const a1 = survey(withRelease).docs?.workflowAutomation
  const ok1 = a1?.hasReleaseJob === true && a1?.usesSecrets === true
  check(ok1, '带发布 job 的工作流被认出', JSON.stringify(a1))
  report(ok1, '有发布 job：认出')

  // OIDC 短时身份也要认出来——npm 自动发布靠它，没有就是没接线
  const withOidc = fixture('auto-oidc', {
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\npermissions:\n  id-token: write\n  contents: write\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n',
  })
  const a3 = survey(withOidc).docs?.workflowAutomation
  const ok3 = a3?.usesOidc === true
  check(ok3, 'OIDC 声明被认出', JSON.stringify(a3))
  report(ok3, '有 OIDC：认出')

  // 反向：纯检查工作流不误报发布 job
  const plain = fixture('auto-plain', {
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const a2 = survey(plain).docs?.workflowAutomation
  const ok2 = a2?.hasReleaseJob === false
  check(ok2, '纯检查工作流不误报发布 job', JSON.stringify(a2))
  report(ok2, '无发布 job：不误报')

  // 英文模板模式要被点名：有 generate-notes、无 notes-file → review 必须待问
  const rEn = spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), withRelease], { encoding: 'utf8' })
  const okEn = /英文模板模式/.test(rEn.stdout ?? '')
  check(okEn, '纯英文模板触发待问', (rEn.stdout ?? '').split('\n')[0])
  report(okEn, '英文模板：待问，不默过')
}

group('[26] 起草发布说明：中文提交即中文说明，无上一版不交白卷')
{
  if (!HAS_GIT) {
    skipGroup('[26] 起草发布说明', '环境里没有 git')
  } else {
    const draft = (dir, ...a) => spawnSync(process.execPath,
      [join(SCRIPTS_DIR, 'draft-release-notes.mjs'), ...a], { encoding: 'utf8', cwd: dir })
    const repo = fixture('draft-repo', { 'README.md': '# x\n' })
    for (const args of [['init', '-q'], ['config', 'user.name', 'T'],
      ['config', 'user.email', 't@e.com'], ['add', '-A'], ['commit', '-q', '-m', '中文首版']]) {
      spawnSync('git', args, { cwd: repo })
    }
    spawnSync('git', ['tag', 'v9.9.1'], { cwd: repo })
    writeFileSync(join(repo, 'CHANGE.txt'), 'more\n', 'utf8')
    for (const args of [['add', '-A'], ['commit', '-q', '-m', '中文第二版']]) {
      spawnSync('git', args, { cwd: repo })
    }
    spawnSync('git', ['tag', 'v9.9.2'], { cwd: repo })

    const r1 = draft(repo, 'v9.9.2', join(repo, 'notes.md'))
    const t1 = existsSync(join(repo, 'notes.md')) ? readFileSync(join(repo, 'notes.md'), 'utf8') : ''
    const ok1 = r1.status === 0 && /中文第二版/.test(t1) && !/中文首版/.test(t1)
    check(ok1, '区间提交逐条列出，不含上一版之前', t1.split('\n')[0])
    report(ok1, '区间正确：只含本版提交')
    const ok2 = /完整改动/.test(t1)
    check(ok2, '带完整改动对比行')
    report(ok2, '对比行：有')

    const r2 = draft(repo, 'v0.0.0-nope', join(repo, 'bad.md'))
    const ok3 = r2.status !== 0 && /不存在/.test(r2.stderr ?? '')
    check(ok3, '不存在的标签拒绝并指路（先打标签）')
    report(ok3, '坏标签：拒绝')
  }
}

group('[45] 勘察吐出的 kind 必须落在值域内：词表外当场红，不等真实项目踩到')
{
  const vocab = kindVocabulary()
  const outsideOf = (kinds) => [...kinds].filter((k) => !vocab.includes(k)).sort()

  // 判据本身必须分得清词表内外——这一条只依赖词表，不依赖观测历史，所以留在分片里。
  const canDetect = outsideOf(['node', 'a-kind-that-does-not-exist']).length === 1
  check(canDetect, '前提：判据分得清词表内外（否则值域判定是恒真的）')
  report(canDetect, '判据：分得清内外')

  // **值域判定与覆盖度提示由主入口做**：它们要看「全部 fixture 跑出的 kind」，
  // 而分片之后没有任何一个进程看得到全集。留在分片里只有两个结局——观测太少时
  // 恒真、门槛够不着时恒假，两种都是假判定。搬到主入口，判据反而比原来更强：
  // 它看到的是四片合并后的全集。


}

group('[16] 报告要给到行，并说明在不在版本库里')
{
  const dir = fixture('line-num', {
    'src/c.py': `# a\n# b\nK = "${FAKE_GH_TOKEN}"\n`,
    'free.env': `${FAKE_NPM_TOKEN}\n`,
  })
  if (HAS_GIT) {
    for (const args of [['init', '-q'], ['config', 'user.name', 'T'],
      ['config', 'user.email', 't@e.com'], ['add', 'src'], ['commit', '-q', '-m', 'i']]) {
      spawnSync('git', args, { cwd: dir })
    }
  }
  const hits = survey(dir).risks?.secretContent ?? []
  // 同上：必须有命中，否则这条断言在「扫描整个失效」时也会通过。
  const ok1 = hits.length > 0 && hits.every((h) => Number.isInteger(h.line) && h.line > 0)
  check(ok1, '凭据命中带行号（只给文件名不构成可执行的报告）', JSON.stringify(hits))
  report(ok1, '凭据命中带行号')
  if (HAS_GIT) {
    const tracked = hits.find((h) => /c\.py/.test(h.path))
    const untracked = hits.find((h) => /env/.test(h.path))
    const ok2 = tracked?.tracked === true && untracked?.tracked === false
    check(ok2, '区分「已在版本库里」与「尚未跟踪」（决定处置方式）',
      JSON.stringify(hits.map((h) => [h.path, h.tracked])))
    report(ok2, '区分已跟踪 / 未跟踪')
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
  // 边界另一侧：陌生非文档文件不是纯文档，空目录不是“没扫到”
  const unrec = survey(fixture('docs-unrec', { 'README.md': '# x\n', 'data.xyz': '???\n' }))
  const okU = (unrec.ecosystem?.kinds ?? []).includes('unrecognized')
  check(okU, '陌生文件 → unrecognized（不误判 docs-only 跳过发布链）', JSON.stringify(unrec.ecosystem?.kinds))
  report(okU, '陌生文件 → unrecognized')
  const unk = survey(fixture('docs-empty', {}))
  const okN = (unk.ecosystem?.kinds ?? []).includes('unknown')
  check(okN, '空目录 → unknown（停下问，不编生态）', JSON.stringify(unk.ecosystem?.kinds))
  report(okN, '空目录 → unknown')
}

// ---- 分片收尾 ----
// 主入口靠这一行读计数。格式固定。
// 不输出它，主入口会判「这片没跑完」并以退出码 2 中止——读不到计数不能当 0。
try { cleanupFixtures() } catch { /* 清不掉不算错，主入口兜底 */ }
process.stdout.write(`行为自检：${passed} 项通过，${failed} 项失败\n`)
// 本进程观测到的 kind。分片后每片只看到自己那几组，值域判定要靠主入口合并四片。
process.stdout.write(`OBSERVED_KINDS=${[...observedKinds].join(',')}\n`)
if (failures.length > 0) {
  process.stdout.write('\n失败项：\n')
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
}
process.exitCode = failed === 0 ? 0 : 1
