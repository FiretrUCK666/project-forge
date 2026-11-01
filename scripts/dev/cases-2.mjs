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

// ── 机制自身的假绿回归网 ────────────────────────────────────────────────────
//
// 这一组守的是「自检自己会不会被架空」这一类错误：判据写成永真、把硬证据当软证据、
// 检查的开关是一个可以随手改掉的字符串。每一段都用「放宽了会过、收紧了不过」构造，
// 所以判据被改松时这一组会立刻红。group('[44] 自检机制自身的假绿回归：硬证据优先、判据可证伪')
{
  // 1) 行为自检被换成哑弹（什么都不做、退出码 0）→ 必须报缺，且必须带出它的 stderr。
  //
  //    只看出身码的判据会放它过去，整套行为断言凭空消失而门禁全绿；把「有没有输出摘要
  //    行」与退出码并列才拦得住——「跑没跑到」是硬证据，「跑出来说什么」是佐证。
  if (!HAS_GIT) {
    skipGroup('[44.1-2] 哑弹自检与空转脚本的端到端判定', '本机没有 git')
  } else {
    const clone = skillClone('mech-mute', { selftest: SELFTEST_MUTE })
    const r = preflightIn(clone, { behavior: true })
    const caught = r.status === 1 && /没有输出摘要行/.test(r.out)
    check(caught, '哑弹自检（无摘要、退出码 0）→ preflight 失败',
      `exit=${r.status} ${r.out.split('\n').filter((l) => /FAIL/.test(l)).join(' / ')}`.slice(0, 220))
    report(caught, '空壳自检：被判缺')
    // 崩在中途要说得清：诊断片段必须带得出来，否则现场只能靠翻 stderr 猜。
    check(/MUTE-STUB-MARKER/.test(r.out), '摘要缺失的报错里带出了子进程 stderr（能一眼定位）',
      r.out.split('\n').filter((l) => /摘要/.test(l)).join(' / ').slice(0, 200))
    report(/MUTE-STUB-MARKER/.test(r.out), '诊断：带出 stderr')
  }

  // 2) 被实跑的脚本「先打印完报告、再以非零退出」→ 必须报缺。
  //
  //    失败判据必须是「非零退出 **且** 期望词缺席」同时成立：只看非零退出时，stdout 里
  //    已经出现「勘察结果」就足以把它豁免——P1 勘察在 markdown 模式下崩掉也会读成通过。
  //    这里把失败限定在 --markdown 路径，selftest 用的 --json 路径不受影响，所以这一段
  //    是唯一能抓住它的网。
  if (!HAS_GIT) {
    skipGroup('[44.2] 空转脚本的端到端判定', '本机没有 git')
  } else {
    // `skillClone` 给的副本里，行为自检是那个**只打印摘要行的替身**。这是刻意的：
    // 不做替身的话，副本里的 preflight 会去跑一整套真实自检，而那一套又会拉起副本的
    // preflight —— `preflight → selftest → preflight` 套娃，实测把副本的每一趟
    // preflight 从十几秒推到几十秒。判定逻辑由主检出那一趟覆盖，副本只需要一个
    // 「跑得起来、说得出一句话」的自检。
    const clone = skillClone('mech-survey')
    const p = join(clone, 'scripts', 'survey.mjs')
    const src = readFileSync(p, 'utf8')
    const anchor = 'process.exitCode = main(process.argv)'
    check(src.includes(anchor), '前提：找到了 survey 的主流程锚点')
    writeFileSync(p, `${src}\nif (isMainModule(import.meta.url, process.argv[1])\n  && process.argv.includes('--markdown')) {\n  process.stderr.write('LATE-STAGE-FAILURE-MARKER')\n  process.exitCode = 7\n}\n`, 'utf8')
    const r = preflightIn(clone)
    const caught = r.status === 1 && /survey\.mjs 以退出码 7 结束/.test(r.out)
    check(caught, '打印完报告再非零退出 → preflight 失败（退出码不被 stdout 豁免）',
      `exit=${r.status} ${r.out.split('\n').filter((l) => /survey/.test(l)).join(' / ')}`.slice(0, 220))
    report(caught, '非零退出：一律算失败')
  }

  // 3) 门禁命令表的一致性：改个标题就关掉的那块检查，必须自己喊。
  if (!HAS_GIT) {
    skipGroup('[44.3] 门禁命令表的端到端判定', '本机没有 git')
  } else {
    const clone = skillClone('mech-gate')
    const p = join(clone, 'CONTRIBUTING.md')
    const text = readFileSync(p, 'utf8')
    const renamed = text.replace(/^## 提交前门禁/m, '## 提交前的检查')
    check(renamed !== text, '前提：CONTRIBUTING 的门禁小节标题改掉了')
    writeFileSync(p, renamed, 'utf8')
    const r = preflightIn(clone, { only: "数量自称" })
    const caught = r.status === 1 && /没有「## 提交前门禁」这一节/.test(r.out)
    check(caught, '门禁小节改名 → 两处命令表无从比对 → preflight 失败（不再静默跳过）',
      `exit=${r.status}`)
    report(caught, '命令表：标题缺失即失败')
  }

  // 4) 凭据分档：--secrets-reviewed 只覆盖「未跟踪未忽略」那一档。
  //    已入库那一档的处置是「从索引移除并轮换」，没有「确认一下就算了」这个选项，
  //    所以任何 flag 都不该消它——flag 的语义是「这处是占位或测试数据」，而它不在其中。
  if (!HAS_GIT) {
    skipGroup('[44.4] 凭据分档与 flag 效力', '本机没有 git')
  } else {
    const exposed = fixture('mech-secret-exposed', {
      'README.md': '# x\n', 'LICENSE': 'MIT\n',
      'free.env': `${FAKE_NPM_TOKEN}\n`,
    })
    gitIn(exposed, 'init')
    const rv = (dir, ...a) => spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
    const base = ['--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci']
    const before = rv(exposed, ...base)
    const after = rv(exposed, ...base, '--secrets-reviewed')
    check(/\[缺\] 凭据形状/.test(before.stdout ?? ''), '未跟踪未忽略的凭据 → 报缺',
      (before.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
    check(!/\[缺\] 凭据形状/.test(after.stdout ?? ''), '这一档可被 --secrets-reviewed 消掉（语义对得上）',
      (after.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
    report(!/\[缺\] 凭据形状/.test(after.stdout ?? ''), '未跟踪档：flag 有效')

    const tracked = fixture('mech-secret-tracked', {
      'README.md': '# x\n', 'LICENSE': 'MIT\n',
      'src/a.py': `K = "${FAKE_GH_TOKEN}"\n`,
    })
    gitIn(tracked, 'init')
    gitIn(tracked, 'config', 'user.name', 'T')
    gitIn(tracked, 'config', 'user.email', 't@e.com')
    gitIn(tracked, 'add', '-A')
    gitIn(tracked, 'commit', '-q', '-m', 'i')
    const tFlag = rv(tracked, ...base, '--secrets-reviewed')
    const stillMissing = /已在版本库里/.test(tFlag.stdout ?? '')
    check(stillMissing, '已入库的凭据 + --secrets-reviewed → 仍然报缺（flag 消不掉它）',
      (tFlag.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
    report(stillMissing, '已入库档：flag 无效')
    check(tFlag.status !== 0, '已入库的凭据使门禁非零退出', `exit=${tFlag.status}`)
    report(tFlag.status !== 0, '已入库档：拦住')
  }

  // 5) 「有远端就得写清远端与发版」：判据必须落在内核之外。
  {
    const kernel = readFileSync(join(SKILL_ROOT, 'templates', 'agents-kernel.md'), 'utf8')
    const inKernel = outsideKernel(`<!-- project-forge:kernel:start -->\n${kernel}\n<!-- project-forge:kernel:end -->\n\n## 怎么跑\n\nnode .\n`)
    const okOut = !/远端|推送|发布|标签/i.test(inKernel)
    check(okOut, '内核区之外不残留远端/发布字样（否则这条判据拿内核给自己作证）',
      JSON.stringify(inKernel.slice(0, 80)))
    report(okOut, '判据范围：内核之外')
    const withBody = `${inKernel}\n## 版本节点\n\n打标签前先抬版本号，远端推上去。\n`
    check(/远端/.test(outsideKernel(withBody)) && /发布|标签/.test(outsideKernel(withBody)),
      '作者写了那两段 → 判据通过（不是恒假）')
    report(/远端/.test(outsideKernel(withBody)), '反侧：写了就通过')
    check(outsideKernel('没有标记的手写文件全文都算作者的部分') === '没有标记的手写文件全文都算作者的部分',
      '没有内核标记时返回全文（手写文件没有内核可依赖）')
  }

  // 6) 来源节判据的第三档：像人话但没有可定位物的套话，必须失败。
  //    只测空正文与带链接两极会漏掉中间那一档，而「不可证伪」恰恰藏在中间。
  {
    const vacuous = '本节的内容以前是核过的，读者可以自行查阅相关文档的对应章节确认；'
      + '若有疑问请按常规流程重核一次即可，不必另行处理。'
    const okVacuous = !hasActionableSources(vacuous)
    check(okVacuous, '纯套话（无链接、无对象、无查法句式）→ 不通过', vacuous.slice(0, 40))
    report(okVacuous, '套话：被拦')
    const byPath = hasActionableSources('字段语义见 `dsh-app-boot` 包里 bundlePatchFiles 的校验，以及 README.zh.md 的 Profile 一节。')
    check(byPath, '写出了具体对象（行内代码里的文件/文档）→ 通过')
    report(byPath, '有对象：放行')
    const byStep = hasActionableSources('去宿主文档的第 7 节核对字段名，再按本节列表逐条对一遍。')
    check(byStep, '查法句式（去 X 的第 N 节）→ 通过')
    report(byStep, '查法句式：放行')
  }

  // 7) 零依赖：四种说明符形状都收，内置与相对路径放行，注释里的举例不算数。
  //
  //    包名一律**运行时拼出**：本文件也在零依赖检查的射程内，字面量写在这里，
  //    那条检查就会把这份测试当成真导入——于是测试自己被自己的被测对象判红。
  {
    const Q = String.fromCharCode(39)
    const DQ = '"'
    const pkg = (...half) => half.join('')
    const probe = [
      `import a from ${Q}node:fs${Q}`,
      `import b from ${Q}./local.mjs${Q}`,
      `import c from ${DQ}${pkg('cha', 'lk')}${DQ}`,
      `const d = require(${Q}${pkg('k', 'leur')}${Q})`,
      `const e = await import(${DQ}${pkg('pico', 'colors')}${DQ})`,
      `import ${Q}side-effect-only${Q}`,
    ].join('\n')
    const specs = moduleSpecifiers(probe)
    const bad = specs.filter((s) => !['node:fs', './local.mjs'].includes(s))
    check(specs.includes('node:fs') && specs.includes('./local.mjs'), '内置模块与相对路径照常识别',
      JSON.stringify(specs))
    check(bad.length === 4 && bad.includes(pkg('cha', 'lk')) && bad.includes(pkg('k', 'leur'))
      && bad.includes(pkg('pico', 'colors')) && bad.includes('side-effect-only'),
      '双引号 / require / 动态导入 / 裸导入四种形状都被收（只认单引号 from 的写法会漏掉其余三种）', JSON.stringify(bad))
    report(bad.length === 4, '零依赖：四种形状都收')
    const prose = [
      `// 举例：动态导入写成 import(${Q}x${Q}) 就完事了`,
      `/* require(${DQ}y${DQ}) 也不许 */`,
      'const z = 1',
    ].join('\n')
    const fromProse = externalModules(prose)
    check(fromProse.length === 0, '整行注释里的举例不算数（否则文档注释会变成地雷）',
      JSON.stringify(fromProse))
    report(fromProse.length === 0, '注释：不算')

    // 反例：「变量名里含 from」不能被当成导入。
    //
    // 判据曾经是 `(?:\bfrom|\bimport)\s*\(?\s*(['"])(...)\1`，中间的 `\s*\(?\s*` 跨行时
    // 会一路吃掉换行，于是 `leaks` 里的 `from` 匹配到**下一行**开头的引号，被报成
    // 「引入了外部模块」。而它报的是「你必须先装东西才能用这个 skill」——一条会让人
    // 真的去装东西的假警报。
    const trap = [
      'const leaks = []',
      `  check(ok, ${DQ}这是断言消息${DQ})`,
      'const from = 1',
      'foo("another string")',
    ].join('\n')
    const fromTrap = externalModules(trap)
    check(fromTrap.length === 0, '变量名里含 from 不算导入（跨行不该被吃掉）', JSON.stringify(fromTrap))
    report(fromTrap.length === 0, '零依赖：含 from 的变量名不误报')
  }

  // 8) 引用完整性：行内代码与 Markdown 链接两种写法必须一起查。
  {
    const text = [
      '见 `references/survey.md`。',
      '另见 [勘察协议](references/docs-set.md) 与 [带锚点的](scripts/survey.mjs#L1) 与 [带标题](references/publish.md "标题")。',
      '占位示例：`references/<文件名>.md`。',
      '非资源目录：docs/architecture.md。',
    ].join('\n')
    const got = referencedPaths(text)
    check(got.includes('references/survey.md') && got.includes('references/docs-set.md'),
      '两种写法都被认出', JSON.stringify(got))
    report(got.includes('references/docs-set.md'), '链接写法：被认出')
    check(got.includes('scripts/survey.mjs') && got.includes('references/publish.md'),
      '链接带锚点与标题时仍取到路径（别把尾巴当成路径的一部分）', JSON.stringify(got))
    check(!got.some((p) => p.includes('<')), '尖括号占位示例不当成真实引用（否则误报）', JSON.stringify(got))
    report(!got.some((p) => p.includes('<')), '占位符：不报')
  }

  // 9) 约定名拼写：判据是「全仓只有一种拼写」，大小写敏感，注释里别照抄错拼法。
  {
    const good = 'a RELEASE_TOKEN b\nc RELEASE_TOKEN d\n'
    check(releaseTokenSpellings([good]).size === 1, '全仓统一 → 只有一种拼写')
    const sep = 'RELEASE' + '-' + 'TOKEN'
    const joined = 'RELEASE' + 'TOKEN'
    const bad = releaseTokenSpellings([good, `x ${sep} y`, `z ${joined} w`])
    check(bad.size === 3, '分隔符写错或连写 → 判为不一致（大小写敏感的扫描）', JSON.stringify([...bad]))
    report(bad.size === 3, '错拼法：被认出')
    const camel = 'usesReleaseToken / releaseToken / ReleaseToken'
    check(releaseTokenSpellings([good, camel]).size === 1,
      'camelCase 标识符不算约定名拼写（不敏感地扫会自造假阳性）', JSON.stringify([...releaseTokenSpellings([good, camel])]))
    report(releaseTokenSpellings([good, camel]).size === 1, 'camelCase：不算')
  }

  // 10) host= 不一致的提示必须渲染成提示本身。
  //     拼接写坏时，冒号后面接的会是源码片段，而那段源码里恰好又写着正确做法——
  //     看的人分不清哪句是给他的，整条提示作废。
  {
    const msg = hostMismatchMessage('references/plugins/dsh.md', '1.2.3', '本机实际是 1.2.4')
    check(!/\+\s*'/.test(msg), '提示正文里不出现源码拼接痕迹', JSON.stringify(msg.slice(0, 90)))
    check(/两种解释都成立/.test(msg) && /专章滞后/.test(msg) && /一起/.test(msg),
      '两种解释与处置指引都在', JSON.stringify(msg.slice(-40)))
    report(!/\+\s*'/.test(msg), '提示：渲染正常')
  }

  // 11) fixture 清理：清理由 exit 钩子兜底，抛异常也会执行；且残留必须报出来。
  {
    check(process.listeners('exit').includes(cleanupFixtures),
      '清理挂在 exit 上（抛异常也会执行；只写在末尾一句就等于没有兜底）')
    report(process.listeners('exit').includes(cleanupFixtures), '清理：exit 钩子已挂')
    check(existsSync(join(ROOT, 'owner.pid')),
      'fixture 根目录写着所有权标记（「别人正在用」与「上次遗留」才分得开）')
    const leftover = staleFixtureDirs()
    check(!leftover.includes(basename(ROOT)), '残留清单不含本次自己的目录（报数才有意义）',
      JSON.stringify(leftover.slice(0, 3)))
    report(!leftover.includes(basename(ROOT)), '残留清单：不含自己')
  }
}

group('[41] 文档与实现的一致性机制：互引、范围、取值、声明口径')
{
  // 这一组不测某个具体案例，测的是**这一类错误的可检性**：指错节、两处范围不一致、
  // 写死的取值、未登记的声明。每条都要能被单独证伪。

  // 1) 同文件内的「见第 N 节」必须真有那一节。跨文件引用（写「专章」或给出 references/
  //    路径的）不在本组判定范围内——那要靠人读目标文件。
  {
    const dir = join(SKILL_ROOT, 'references')
    const walk = (sub) => {
      const out = []
      for (const e of readdirSync(join(dir, sub), { withFileTypes: true, encoding: 'utf8' })) {
        const rel = sub === '' ? e.name : `${sub}/${e.name}`
        if (e.isDirectory()) { out.push(...walk(rel)); continue }
        if (e.isFile() && e.name.endsWith('.md')) out.push(rel)
      }
      return out
    }
    const bad = []
    for (const rel of walk('')) {
      const text = readSkill(`references/${rel}`)
      const headings = [...text.matchAll(/^##\s+([0-9一二三四五六七八九十百]+)、/gm)].map((m) => m[1])
      for (const m of text.matchAll(/见第([0-9一二三四五六七八九十百]+)节/g)) {
        const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 10)
        if (/专章|references\//.test(around)) continue // 跨文件引用，本组不判
        if (!headings.includes(m[1])) bad.push(`references/${rel} 的「${m[0]}」在本文件里没有对应标题`)
      }
    }
    const ok = bad.length === 0
    check(ok, '同文件互引指向真实存在的节', bad.slice(0, 4).join(' / '))
    report(ok, '互引：指到的节真实存在')
  }

  // 2) 宿主升级后要重核的范围，代码提示与专章必须说同一件事。
  {
    const dsh = readSkill('references/plugins/dsh.md')
    const compose = readSkill('scripts/compose-agents.mjs')
    const inDoc = /重核第([一二三四五六七八九十]+)节至第([一二三四五六七八九十]+)节/.exec(dsh)
    const inCode = /重核第([一二三四五六七八九十]+)节至第([一二三四五六七八九十]+)节/.exec(compose)
    const ok = inDoc !== null && inCode !== null
      && inDoc[1] === inCode[1] && inDoc[2] === inCode[2]
    check(ok, 'dsh 重核范围：代码提示与专章一致',
      `专章=${inDoc?.[0] ?? '(未写)'} 代码=${inCode?.[0] ?? '(未写)'}`)
    report(ok, '重核范围：两处一致')
  }

  // 3) 多生态的扁平命令字段是「先到者胜」：行为钉住，文档才不能凭想象改写机制。
  {
    const dir = fixture('flat-order', {
      'package.json': JSON.stringify({
        name: 'm', version: '1.0.0',
        scripts: { build: 'tsc', test: 'vitest run' },
        devDependencies: { typescript: '^5.0.0' },
      }, null, 2),
      'pyproject.toml': '[project]\nname = "m"\nversion = "1.0.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
      'src/index.ts': 'export const x = 1\n',
      'main.py': 'print(1)\n',
    })
    const s = survey(dir)
    const ok = s.commands?.build === 'npm run build'
      && s.commands?.byEcosystem?.python?.test === 'python -m pytest'
      && s.commands?.test !== 'python -m pytest'
    check(ok, '扁平命令取声明强度最高者、不被后来者覆盖',
      JSON.stringify({ flat: s.commands?.test, py: s.commands?.byEcosystem?.python?.test }))
    report(ok, '扁平字段：先到者胜')
  }

  // 4) 包管理器是「声明 > 锁文件 > 默认」推出来的，不是「项目声明过」的证据。
  {
    const dir = fixture('pm-chain', {
      'package.json': JSON.stringify({ name: 'p', version: '1.0.0', scripts: { test: 'x' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9\n',
      'src/a.js': 'export const a = 1\n',
    })
    const s = survey(dir)
    const ok = s.commands?.packageManager === 'pnpm'
      && (s.commands?.install ?? '').startsWith('pnpm ')
    check(ok, '包管理器按锁文件推导', JSON.stringify({ pm: s.commands?.packageManager, install: s.commands?.install }))
    report(ok, '包管理器：按锁文件推导')
  }

  // 5) review 的 flag 全集必须在它自己的用法输出里（用户与 AI 只能从那儿拿到全集）。
  {
    const text = readSkill('scripts/review.mjs')
    const flags = [...text.matchAll(/^\s*'(--[a-z-]+)',/gm)].map((m) => m[1])
    const helpBlock = text.slice(text.indexOf('用法：node scripts/review.mjs'))
    const missing = flags.filter((f) => !helpBlock.includes(f))
    const documented = /review\.mjs --help/.test(readSkill('SKILL.md'))
    const ok = flags.length > 0 && missing.length === 0 && documented
    check(ok, 'review 的 flag 全部写在用法输出里，且文档指向它',
      `缺=${missing.join(',') || '无'} 文档指向=${documented}`)
    report(ok, 'review flag：用法输出即权威')
  }

  // 6) compose 的开关也要有人写下来（只存在于脚本注释里的开关等于没有）。
  {
    const text = readSkill('scripts/compose-agents.mjs')
    const flags = [...new Set([...text.matchAll(/'(--[a-z-]+)'/g)].map((m) => m[1]))]
      .filter((f) => f !== '--help')
    const docs = `${readSkill('README.md')}\n${readSkill('SKILL.md')}\n${readSkill('references/docs-set.md')}`
    const missing = flags.filter((f) => !docs.includes(f))
    const ok = flags.length > 0 && missing.length === 0
    check(ok, 'compose 的开关都写进了文档', `缺=${missing.join(',') || '无'}`)
    report(ok, 'compose 开关：都有出处')
  }

  // 7) 模板里不钉第三方补丁版本：模板会被照抄，钉死的号几乎必然过时。
  {
    const dir = join(SKILL_ROOT, 'templates')
    const bad = []
    for (const e of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
      if (!e.isFile()) continue
      const hit = /npm@\d+\.\d+\.\d+/.exec(readSkill(`templates/${e.name}`))
      if (hit !== null) bad.push(`${e.name}: ${hit[0]}`)
    }
    const ok = bad.length === 0
    check(ok, '模板里不出现钉死的第三方补丁版本', bad.join(' / '))
    report(ok, '模板：不钉第三方版本号')
  }

  // 8) 通用文档不点名本机某个具体 skill。
  {
    const bad = []
    for (const rel of ['references/docs-set.md', 'references/plugin-project.md', 'templates/agents-project.md']) {
      if (/oil-tone/.test(readSkill(rel))) bad.push(rel)
    }
    const ok = bad.length === 0
    check(ok, '通用文档不点名具体某个 skill', bad.join(' / '))
    report(ok, '通用性：不点名本机 skill')
  }

  // 9) ci-release 的 TODO(1) 必须交代 job 级 if 条件也要改（否则裸版本标签永远进不来）。
  {
    const text = readSkill('templates/ci-release.yml')
    const todo = /# TODO\(1\)[\s\S]{0,500}?TODO\(2\)/.exec(text)?.[0] ?? ''
    const ok = /if:/.test(todo) && /refs\/tags\/v/.test(todo)
    check(ok, 'ci-release TODO(1) 覆盖 job 级 if 条件', todo.slice(0, 60).replace(/\n/g, ' '))
    report(ok, 'ci-release：TODO(1) 含 if 条件')
  }

  // 10) 模板 DSL（pf:if 等）在文档里有指针，改模板的人知道去哪查。
  {
    const ok = /pf:if/.test(readSkill('references/docs-set.md'))
      || /pf:if/.test(readSkill('SKILL.md'))
    check(ok, '模板标记 DSL 在文档里有指针')
    report(ok, 'DSL：文档里有指针')
  }

  // 11) 保鲜范围按「承载易变事实」判：总纲两份也在册，且都写了查法。
  {
    const bad = []
    for (const rel of ['references/publish.md', 'references/remote-github.md']) {
      const text = readSkill(rel)
      const hasSection = /^##\s*(?:[0-9一二三四五六七八九十百]+[、.．)）]\s*)?事实来源/m.test(text)
      const hasMarker = /<!--\s*[A-Za-z0-9-]+-verified:\s*[^>]*date=/.test(text)
      const hasWhere = /官方|文档|https?:\/\//.test(text.slice(text.search(/^##\s*.*事实来源/m)))
      if (!(hasSection && hasMarker && hasWhere)) bad.push(`${rel}(${hasSection}/${hasMarker}/${hasWhere})`)
    }
    const ok = bad.length === 0
    check(ok, '总纲也带事实来源节、标记与查法', bad.join(' / '))
    report(ok, '保鲜：总纲也在册')
  }

  // 12) 专章都要有「何时读本文件」——新增专章漏写时要拦住（此前只查顶层 references/）。
  {
    const dir = join(SKILL_ROOT, 'references', 'plugins')
    const bad = []
    for (const e of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue
      if (!/^## 何时读本文件[ \t]*$/m.test(readSkill(`references/plugins/${e.name}`))) bad.push(e.name)
    }
    const ok = bad.length === 0
    check(ok, '专章都写了「何时读本文件」', bad.join(' / '))
    report(ok, '专章结构：齐备')
  }

  // 13) Unlicense 是反向断言：没有版权行、没有占位符（好心补一行会让文档变假话）。
  {
    const text = readSkill('templates/license-unlicense.txt')
    const ok = !text.includes('Copyright (c)') && !text.includes('{{')
    check(ok, 'Unlicense 模板无版权行、无占位符')
    report(ok, 'Unlicense：反向断言成立')
  }

  // 14) dsh 专章要写明 host= 只能靠人维护（检查无法跨宿主比对），不让它悄悄过期。
  {
    const text = readSkill('references/plugins/dsh.md')
    const ok = /host=/.test(text) && /本机实际运行的宿主|跨宿主/.test(text)
    check(ok, 'dsh 专章交代了 host= 的维护边界')
    report(ok, 'dsh：host= 维护边界有交代')
  }

  // 15) survey.md 要记载判定结果是个数组、条件字段缺省即空——它们是判定与汇报的入口。
  {
    const text = readSkill('references/survey.md')
    const ok = /`kinds`/.test(text) && /条件字段：缺省即/.test(text)
    check(ok, 'survey.md 记载 kinds 与条件字段语义')
    report(ok, 'survey.md：字段语义完整')
  }

  // 16) kind 清单的对照**不在这里**：它由 [43] 用 `survey.mjs` 导出的 `kindVocabulary()`
  // 与文档做集合相等断言。在这里手抄一份一模一样的清单，既是第二份真相源
  // （新增生态时两处都要改），又是「拿实现给实现打分」的形状。
}


// ── [52] 结构守卫：依赖图无环、判据只有一份、临时文件三态 ──────────────────────

group('[52] 结构守卫：依赖图无环、判据只有一份、临时文件三态')
{
  // ── 1) 依赖图不能有环 ──
  // 两个模块互相 import 在 ESM 里不会立刻出事（函数声明在模块实例化阶段就完成
  // 初始化），所以环能一路绿灯地活下来——直到有人把一个 const 提到模块顶层，
  // 那时才开始踩时序差（TDZ）。而「无环」这件事没有任何症状会提醒人。
  // 所以把它变成常驻断言，而不是靠人记得。
  const scriptFiles = []
  const collectScripts = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
      if (e.isDirectory()) { collectScripts(join(dir, e.name)); continue }
      if (e.name.endsWith('.mjs')) scriptFiles.push(join(dir, e.name))
    }
  }
  collectScripts(join(SKILL_ROOT, 'scripts'))
  const edges = new Map()
  for (const f of scriptFiles) {
    // 说明符的提取复用 preflight 那一份实现，不在这里另写一个正则——两处各判一次
    // 同一类东西，迟早给出两个答案。
    const deps = moduleSpecifiers(readFileSync(f, 'utf8'))
      .filter((s) => s.startsWith('.'))
      .map((s) => resolve(dirname(f), s))
      .filter((t) => scriptFiles.includes(t))
    edges.set(f, deps)
  }
  const visiting = new Set()
  const finished = new Set()
  const cycles = []
  const visit = (f, stack) => {
    if (finished.has(f)) return
    if (visiting.has(f)) {
      cycles.push([...stack, f].map((p) => basename(p)).join(' → '))
      return
    }
    visiting.add(f)
    for (const d of edges.get(f) ?? []) visit(d, [...stack, f])
    visiting.delete(f)
    finished.add(f)
  }
  for (const f of scriptFiles) visit(f, [])
  check(cycles.length === 0,
    'scripts/ 的依赖图无环——环在 ESM 里能一路绿灯，直到有人把 const 提到模块顶层才炸',
    cycles.join('；'))
  report(cycles.length === 0, '依赖图：无环')

  // ── 2) 共享判据只能有一份实现 ──
  // 「围栏扫描」这一族判据曾经同时住在 survey.mjs 与 sync-toc.mjs 里，而 survey 的
  // 注释明写「实现也只有一个来源」——**注释说一份、代码两份**，是最坏的一种漂：
  // 它看上去是对的。注释靠不住，断言才靠得住。
  const sharedJudgements = ['scanLines', 'fencedSpans', 'markerPositions', 'isMainModule']
  const dupes = []
  for (const name of sharedJudgements) {
    const defRe = new RegExp(`export function ${name}\\s*\\(`)
    const hits = scriptFiles.filter((f) => defRe.test(readFileSync(f, 'utf8')))
    if (hits.length !== 1) {
      dupes.push(`${name}×${hits.length}（${hits.map((f) => basename(f)).join('、') || '无'}）`)
    }
  }
  check(dupes.length === 0, '共享判据在全仓只定义一次', dupes.join('；'))
  report(dupes.length === 0, '共享判据：各一份')

  // ── 2b) 共享判据不许被「另写一遍」 ──
  //
  // 上面那条只认 `export function <名字>`，抓得住「同名导出两份」，**抓不住
  // 「不 import、自己手写一个内联循环」**——而那正是实际发生过的事：`preflight.mjs`
  // 与 `compose-agents.mjs` 各写了一个 `inFence` 状态机，只比围栏符首字符、不校验
  // 闭合长度。守卫的存在反而给了「已经统一」的错觉。
  //
  // 判据改成「专属标识符只许出现在权威实现里」：`inFence` 这种名字不会自然出现。
  const RESTRICTED = {
    inFence: 'survey.mjs',           // 围栏状态机
    fenceEvent: 'survey.mjs',        // 同上
    fencedSpans: 'survey.mjs',       // 围栏区间
    scanLines: 'survey.mjs',         // 逐行扫描
    markerPositions: 'survey.mjs',   // 标记在围栏外的位置
  }
  const leaks = []
  for (const file of scriptFiles) {
    const base = basename(file)
    const text = readFileSync(file, 'utf8')
    for (const [token, owner] of Object.entries(RESTRICTED)) {
      if (base === owner) continue
      // 只看**定义或赋值**，不看 import 与注释：调用权威实现是应该的。
      const re = new RegExp(`^\\s*(?:let|const|var)\\s+${token}\\b`, 'm')
      const reFn = new RegExp(`^\\s*function\\s+${token}\\b`, 'm')
      if (re.test(text) || reFn.test(text)) leaks.push(`${base} 自己定义了 ${token}`)
    }
  }
  check(leaks.length === 0, '围栏扫描只在 survey.mjs 里实现，别处只能 import', leaks.join('；'))
  report(leaks.length === 0, '共享判据：不许另写一遍')

  // ── 3) 临时文件的归属三态 ──
  // 「同前缀全删」曾把使用者自己的备份、和另一个正在运行的进程手里的临时文件一起
  // 删掉：前者是毁掉别人的东西，后者会让那次运行的改名失败。判据现在分三态——
  // 已死进程留下的清掉、活着的留着、使用者自己的留着，而且留下的要说得出原因。
  const tmpDir = fixture('tmp-ownership', {})
  const target = join(tmpDir, 'AGENTS.md')
  writeFileSync(target, 'x', 'utf8')
  // 一个真的跑过又退出的进程，它的进程号此刻已不在了——这比随手写一个数字可靠。
  const deadPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8', windowsHide: true }).pid
  const own = `${basename(target)}.tmp-backup`
  const alive = `${basename(target)}.tmp-${process.pid}`
  const dead = `${basename(target)}.tmp-${deadPid}`
  writeFileSync(join(tmpDir, own), 'x', 'utf8')
  writeFileSync(join(tmpDir, alive), 'x', 'utf8')
  writeFileSync(join(tmpDir, dead), 'x', 'utf8')
  // 进程刚退出时系统可能还没回收它，等一下再问「它还活着吗」。
  for (let i = 0; i < 50 && processAlive(deadPid); i += 1) {
    spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},30)'], { windowsHide: true })
  }
  const cleared = clearStaleTemps(target)
  const tmpOk = cleared.removed.includes(dead)
    && cleared.kept.some((k) => k.name === alive)
    && cleared.kept.some((k) => k.name === own)
    && existsSync(join(tmpDir, alive))
    && existsSync(join(tmpDir, own))
    && !existsSync(join(tmpDir, dead))
  check(tmpOk,
    '临时文件按归属分三态：已死进程的清掉，活着的与使用者自己的留下并说得出原因',
    `removed=${cleared.removed.join('、') || '无'}；kept=${cleared.kept.map((k) => k.name).join('、') || '无'}`)
  report(tmpOk, '临时文件：三态分明')
}


// ── [48b] 落盘族的引用归属：模板不许带本 skill 自己的路径 ────────────────────

group('[28] DSH 插件：Bundle 与双半区按事实识别，不写死取值')
{
  // 最小 host-only bundle：有补丁声明 + 补丁含包名 + host 入口
  const hostOnly = fixture('dsh-hostonly', {
    'package.json': JSON.stringify({
      name: 'dsh-hello', version: '0.1.0', type: 'module',
      main: 'lib/index.js', exports: { '.': './lib/index.js' },
      files: ['lib/index.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: hello\n      name: 'dsh-hello'\n",
    'lib/index.js': 'export const name = "hello"\n',
  })
  const s1 = survey(hostOnly)
  const ok1 = (s1.ecosystem?.kinds ?? []).includes('dsh-plugin')
  check(ok1, 'host-only bundle 认出 dsh-plugin', JSON.stringify(s1.ecosystem?.kinds))
  report(ok1, 'host-only：认出 dsh-plugin')
  const ok2 = s1.dsh?.bundlePatch?.exists === true && s1.dsh?.hasClientDecl === false
  check(ok2, '补丁存在且无 client 声明', JSON.stringify(s1.dsh))
  report(ok2, 'host-only：补丁存在、无 client')
  const ok3 = s1.dsh?.discoveryCarrierLikely === true
  check(ok3, '补丁含包名 → 发现载体可能存在', String(s1.dsh?.discoveryCarrierLikely))
  report(ok3, 'host-only：载体检查通过')
  compose(hostOnly)
  const t1 = readFileSync(join(hostOnly, 'AGENTS.md'), 'utf8')
  const ok4 = /插件标识与加载/.test(t1) && !/双半区与浏览器产物/.test(t1)
  check(ok4, '生成契约含标识节、不含双半区节（按事实取舍）')
  report(ok4, 'host-only：条件段取舍正确')

  // 双面 bundle：client 声明 + 双入口 + 补丁含包名
  const dual = fixture('dsh-dual', {
    'package.json': JSON.stringify({
      name: '@scope/dsh-dual', version: '0.1.0', type: 'module',
      exports: { '.': './lib/index.js', './client': './lib/client.js' },
      files: ['lib/index.js', 'lib/client.js', 'cordis.patch.yml'],
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: dual\n      name: '@scope/dsh-dual'\n",
    'lib/index.js': 'export function apply() {}\n',
    'lib/client.js': 'globalThis.x = 1\n',
  })
  const s2 = survey(dual)
  const ok5 = s2.dsh?.hasClientDecl === true && s2.dsh?.hasClientEntry === true
  check(ok5, '双面：client 声明与入口同时识别', JSON.stringify(s2.dsh))
  report(ok5, '双面：client 识别')
  compose(dual)
  const t2 = readFileSync(join(dual, 'AGENTS.md'), 'utf8')
  const ok6 = /双半区与浏览器产物/.test(t2) && /补丁层与挂载/.test(t2)
  check(ok6, '双面契约含双半区与补丁层两节')
  report(ok6, '双面：两节都在')

  // 缺载体：补丁文本里没有包名 → 告警，不硬判失败
  const nocarrier = fixture('dsh-nocarrier', {
    'package.json': JSON.stringify({
      name: 'dsh-nocarrier', version: '0.1.0',
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: other\n      name: 'some-other-package'\n",
  })
  const s3 = survey(nocarrier)
  const ok7 = s3.dsh?.discoveryCarrierLikely === false
    && (s3.dsh?.warnings ?? []).some((w) => /载体/.test(w))
  check(ok7, '缺载体 → 报警告（不断言加载一定失败）', JSON.stringify(s3.dsh?.warnings))
  report(ok7, '缺载体：报警告')

  // 声明与入口不一致：有 client 声明无 ./client 入口 → 告警
  const mismatch = fixture('dsh-mismatch', {
    'package.json': JSON.stringify({
      name: 'dsh-mismatch', version: '0.1.0',
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: m\n      name: 'dsh-mismatch'\n",
  })
  const s4 = survey(mismatch)
  const ok8 = (s4.dsh?.warnings ?? []).some((w) => /.\/client/.test(w))
  check(ok8, 'client 声明无入口 → 报警告', JSON.stringify(s4.dsh?.warnings))
  report(ok8, '声明入口不一致：报警告')

  // 反向：普通 node 项目不出现 DSH 段
  const plain = fixture('dsh-plain', {
    'package.json': JSON.stringify({ name: 'plain', version: '1.0.0', scripts: { test: 'x' } }),
  })
  compose(plain)
  const t3 = readFileSync(join(plain, 'AGENTS.md'), 'utf8')
  const ok9 = !/插件标识与加载/.test(t3)
  check(ok9, '非插件项目不含 DSH 段（不制造噪音）')
  report(ok9, '非插件：不误报 DSH 段')
}

group('[23] 目录同步：从标题生成、锚点算对、三种现状都能接管')
{
  const toc = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'sync-toc.mjs'), join(dir, 'README.md'), ...a], { encoding: 'utf8' })

  // ① 有手写目录、没有标记 → 就地接管，**不新增第二个目录**
  const hand = fixture('toc-hand', {
    'README.md': [
      '# x', '', '## 目录', '', '- [旧的](#错的锚点)', '',
      '## 第一节', '', '正文', '', '## 第二节', '', '正文', '',
      '## 第三节', '', '正文', '', '## 第四节', '', '正文', '', '## 第五节', '', '正文', '',
    ].join('\n'),
  })
  const r1 = toc(hand)
  const t1 = readFileSync(join(hand, 'README.md'), 'utf8')
  const dirCount = (t1.match(/^## 目录$/gm) ?? []).length
  const ok1 = dirCount === 1
  check(ok1, '手写目录被接管，且没有出现第二个「目录」节', `目录节 ${dirCount} 个`)
  report(ok1, '手写目录：就地接管，不重复')
  const ok2 = !/错的锚点/.test(t1) && /#第一节/.test(t1)
  check(ok2, '内容被换成按标题算出的正确锚点')
  report(ok2, '锚点已重算')
  check(r1.status === 0, '接管成功退出码 0')

  // ② 幂等 + --check 能发现漂移
  const r2 = toc(hand, '--check')
  check(r2.status === 0, '接管后 --check 通过', `exit=${r2.status}`)
  report(r2.status === 0, '接管后 --check 通过')
  writeFileSync(join(hand, 'README.md'),
    readFileSync(join(hand, 'README.md'), 'utf8') + '\n## 第六节\n\n正文\n', 'utf8')
  const r3 = toc(hand, '--check')
  const ok3 = r3.status !== 0 && /不同步/.test(r3.stdout ?? '')
  check(ok3, '加了一节之后 --check 报不同步', `exit=${r3.status}`)
  report(ok3, '加节后 --check 报不同步')

  // ③ 锚点算法：中文、序号、中英混排、大小写
  const anchors = fixture('toc-anchor', {
    'README.md': [
      '# x', '',
      '## 环境要求', '', 'a', '',
      '## 1. 局域网访问', '', 'a', '',
      '## 3. 移动端交互与 PWA 独立全屏 App', '', 'a', '',
      '## What it does', '', 'a', '',
      '## 第六节', '', 'a', '',
    ].join('\n'),
  })
  toc(anchors)
  const t3 = readFileSync(join(anchors, 'README.md'), 'utf8')
  const wants = [
    ['中文标题', '#环境要求'],
    ['带序号的中文', '#1-局域网访问'],
    ['中英混排', '#3-移动端交互与-pwa-独立全屏-app'],
    ['英文标题', '#what-it-does'],
  ]
  for (const [label, anchor] of wants) {
    const ok = t3.includes(`(#${anchor.replace(/^#/, '')})`)
    check(ok, `锚点：${label} → ${anchor}`)
    report(ok, `锚点 ${label}`)
  }

  // ④ 代码块里的 `## x` 不是标题，不该进目录
  const fenced = fixture('toc-fence', {
    'README.md': [
      '# x', '', '## 真标题', '', '```md', '## 这是代码块里的假标题', '```', '',
      '## 二', '', 'a', '', '## 三', '', 'a', '', '## 四', '', 'a', '', '## 五', '', 'a', '',
    ].join('\n'),
  })
  toc(fenced)
  const t4 = readFileSync(join(fenced, 'README.md'), 'utf8')
  const ok4 = !/假标题/.test(t4.replace(/```md[\s\S]*?```/, ''))
  check(ok4, '围栏代码块里的 `## x` 不进目录')
  report(ok4, '代码块里的标题被跳过')

  // ⑤ 节数少时不加目录（短 README 加目录是累赘）
  const short = fixture('toc-short', { 'README.md': '# x\n\n## 一\n\na\n\n## 二\n\nb\n' })
  const r5 = toc(short)
  const ok5 = !/## 目录/.test(readFileSync(join(short, 'README.md'), 'utf8')) && /不需要目录/.test(r5.stdout ?? '')
  check(ok5, '节数少于阈值时不加目录，并说明原因')
  report(ok5, '短 README：不加目录')
}

group('[50] 命令推导的四种空：每一种都要说得出「为什么空」')
{
  // 这一组守的是 P7 那道验证门。命令推不出来本身不可怕，可怕的是**推不出来还不说为什么**
  // ——读的人会以为项目没有可跑的命令，于是把没验证过的东西汇报成「已验证」。
  const scriptsOf = (data) => data.commands ?? {}
  const noteOf = (data) => scriptsOf(data).note ?? ''

  // 1) 常规脚本名：推得出命令，且**不**该有说明（有说明就说明判据走进了别的分支）。
  const normal = survey(fixture('cmd-normal', {
    'package.json': '{"name":"n","scripts":{"build":"tsc","test":"vitest run","lint":"eslint ."}}\n',
  }))
  const normalOk = scriptsOf(normal).build === 'npm run build'
    && scriptsOf(normal).test === 'npm run test'
    && scriptsOf(normal).install === 'npm install'
    && noteOf(normal) === ''
  check(normalOk, '常规脚本名：推出命令、带上 install、没有多余的说明',
    JSON.stringify(scriptsOf(normal)))
  report(normalOk, '常规脚本名：有命令、无说明')

  // 2) 只有自定义脚本名：**说得出为什么空，并列出原始脚本名**。这是本组的主角。
  const custom = survey(fixture('cmd-custom', {
    'package.json': '{"name":"c","scripts":{"forge":"node forge.mjs","smelt":"node smelt.mjs"}}\n',
  }))
  const customNote = noteOf(custom)
  const customOk = scriptsOf(custom).build === undefined
    && customNote.includes('forge') && customNote.includes('smelt') && customNote.includes('常规名字')
  check(customOk, '自定义脚本名：一条命令都没有，但说明里列出了清单声明的脚本名',
    customNote === '' ? '(没有说明——这正是要防的静默)' : customNote.slice(0, 80))
  report(customOk, '自定义脚本名：说明里带出原始脚本名')

  // 3) 没有 scripts 字段：也要有说明，且**不能给 install**——给了它，扁平视图里就有了一条
  //    命令，「未推导出任何命令」这条诚实信号便不再出现。
  const bare = survey(fixture('cmd-bare', { 'package.json': '{"name":"b"}\n' }))
  const bareOk = scriptsOf(bare).install === undefined && noteOf(bare).includes('scripts')
  check(bareOk, '没有 scripts 字段：不给 install，且说明里说清原因', JSON.stringify(scriptsOf(bare)))
  report(bareOk, '没有 scripts 字段：有说明、无假命令')

  // 4) scripts 是空对象：与「没有这个字段」分得开（两句话不同）。
  const empty = survey(fixture('cmd-empty', { 'package.json': '{"name":"e","scripts":{}}\n' }))
  const emptyOk = noteOf(empty) !== '' && noteOf(empty) !== noteOf(bare)
  check(emptyOk, 'scripts 是空的：与「没有 scripts 字段」说得出不同的话', noteOf(empty).slice(0, 60))
  report(emptyOk, 'scripts 是空的：与另一种空分得开')

  // 5) 反过来证伪：上面那几条不能恒真——给一个**能**推出命令的项目，说明必须消失。
  const canBeSilent = noteOf(normal) === '' && scriptsOf(normal).build !== undefined
  check(canBeSilent, '前提：说明只出现在真的推不出命令时（否则上面几条是恒真的）')
  report(canBeSilent, '前提：有命令时没有说明')
}

// 交棒勘察的调用封装：**文件级**，因为不止一个分组要用它。
// 放在组内会让别的组引用不到，而那种错只在运行时炸出来（ReferenceError），
// 前面已经通过的断言全都白跑——一次真实的教训。

group('[14] 完成判据不能空转：只升级不填写时，必须报出缺失的节')
{
  const dir = fixture('vacuous', {
    'pyproject.toml': '[project]\nname = "x"\nversion = "1.0.0"\n',
    'main.py': 'print(1)\n',
  })
  writeFileSync(join(dir, 'AGENTS.md'), '# x\n\n说明。\n\n## 怎么跑\n\npython main.py\n', 'utf8')
  compose(dir, '--upgrade')
  const st = compose(dir, '--status')
  const out = st.stdout ?? ''
  // 只做升级、一个项目节都没写时，pf:author 数立刻是 0——只看这个数字会以为写完了。
  const noAuthors = /待填写 0 处/.test(out)
  check(noAuthors, '前提：升级后待填写确实是 0')
  const reportsMissing = /缺失 \d+ 节/.test(out)
  check(reportsMissing, '--status 报出缺失的节（否则完成判据会空转）', out.split('\n')[0])
  report(reportsMissing, '--status 报出缺失节数')
  const warns = /不算完成/.test(out)
  check(warns, '--status 明确说明这些节没写就不算完成')
  report(warns, '并说明不算完成')

  // 新生成的文件：节**都在**（来自模板），但都还没填——所以判据必须落在
  // 「待填写」上，且绝不能报「内容完整」。只看缺失节数会漏掉这种情况。
  const fresh = fixture('fresh', { 'README.md': '# x\n', 'src/a.js': 'export const a=1\n' })
  compose(fresh)
  const st2 = compose(fresh, '--status')
  const out2 = st2.stdout ?? ''
  const authorCount = Number((/待填写 (\d+) 处/.exec(out2) ?? [])[1] ?? -1)
  const ok1 = authorCount > 0
  check(ok1, '新生成的文件报出待填写项', String(authorCount))
  report(ok1, `新生成文件报待填写 ${authorCount} 处`)
  // 注意：提示语里有一句「写完后重跑本脚本，确认「内容完整」」，它**包含**这个短语。
  // 所以断言要匹配「以它开头的整行」，不能匹配子串——否则测试永远为假。
  const hasCompleteLine = (text) => text.split('\n').some((l) => l.trim().startsWith('内容完整'))
  const ok2 = !hasCompleteLine(out2)
  check(ok2, '新生成的文件不得报「内容完整」')
  report(ok2, '且不报「内容完整」')

  // 反例：两个数字都归零时才该报「内容完整」——用一个已填好的文件验证
  const done = fixture('done', {
    'package.json': JSON.stringify({ name: 'd', version: '1.0.0', private: true, scripts: { test: 'x' } }),
  })
  compose(done)
  const dpath = join(done, 'AGENTS.md')
  // 把待填写标记全部换成真实内容
  writeFileSync(dpath, readFileSync(dpath, 'utf8')
    .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写）'), 'utf8')
  const st3 = compose(done, '--status')
  const ok3 = hasCompleteLine(st3.stdout ?? '')
  check(ok3, '两个数字都归零时报「内容完整」')
  report(ok3, '填完后报「内容完整」')
}

group('[22] 双语文档的成对维护规则必须**写进项目契约**，不只是写在参考文件里')
{
  // 这一组测的是「机制缺口」：references 里写了双语会漂移、要成对改，但模板里没有
  // 对应段落——于是生成出来的契约里没有这条规则，项目也就不会照它做。
  // 实测后果：一个双语文档的项目，英文版漏掉了一条更新命令，而它的契约里一个字都没提。
  //
  // 规则写在参考文件里只对「读过那份文件的人」有效；写进项目自己的契约，
  // 才对以后每一次会话有效。所以断言落在**生成物**上，不是落在模板上。
  const bi = fixture('doc-bi', {
    'package.json': JSON.stringify({ name: 'bi', version: '1.0.0' }),
    'README.md': '# bi\n\n## 安装\n',
    'README.en.md': '# bi\n\n## Install\n',
  })
  compose(bi)
  const t = readFileSync(join(bi, 'AGENTS.md'), 'utf8')
  const ok1 = /双语说明文档要/.test(t)
  check(ok1, '有双语 README → 生成的契约含成对维护一节')
  report(ok1, '有双语 README：契约含那一节')
  const ok2 = /另一份同步了吗/.test(t)
  check(ok2, '含可自查的那句话（改完要能回答「另一份同步了吗」）')
  report(ok2, '含自查句')
  const ok3 = /漂移/.test(t) && /默认语言那份是权威/.test(t)
  check(ok3, '含「会漂移」与「哪份权威」两条关键判据')
  report(ok3, '含漂移与权威判据')

  // 反向：单语项目不该出现这一节（否则是噪音，而且会让 AI 去找不存在的第二份文档）
  const mono = fixture('doc-mono', {
    'package.json': JSON.stringify({ name: 'mono', version: '1.0.0' }),
    'README.md': '# mono\n',
  })
  compose(mono)
  const t2 = readFileSync(join(mono, 'AGENTS.md'), 'utf8')
  const ok4 = !/双语说明文档要/.test(t2)
  check(ok4, '单语 README → 不含这一节')
  report(ok4, '单语：不误报')

  // 变体的写法要认全：语言后缀有多种常见拼法，只认一种会漏
  for (const [label, name] of [['点分', 'README.en.md'], ['下划线', 'README_CN.md'], ['连字符', 'README.zh-CN.md']]) {
    const d = fixture(`doc-var-${label === '点分' ? 'dot' : label === '下划线' ? 'under' : 'dash'}`, {
      'package.json': JSON.stringify({ name: 'v', version: '1.0.0' }),
      'README.md': '# v\n',
      [name]: '# v\n',
    })
    const ok = survey(d).docs?.readmePair !== undefined
    check(ok, `变体写法「${name}」被认成一对`)
    report(ok, `变体写法 ${name}`)
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
  // 另一侧：无依赖则无“依赖版本同步”节（条件双向可验证非冻结）
  const nodeps = fixture('gen-nodeps', {
    'package.json': JSON.stringify({ name: 'bare', version: '0.1.0' }, null, 2),
  })
  compose(nodeps)
  const tn = readFileSync(join(nodeps, 'AGENTS.md'), 'utf8')
  const okNd = !/^## 依赖版本同步$/m.test(tn)
  check(okNd, '无依赖 → 不含依赖版本同步')
  report(okNd, '无依赖：该节隐藏')
}

group('[13] Python 测试命令：只在项目声明了框架时才给，不按生态惯例编')
{
  // 声明了 pytest → 给 pytest
  const withPytest = fixture('py-pytest', {
    'pyproject.toml': '[project]\nname = "p"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'tests/test_a.py': 'def test_a(): pass\n',
  })
  const c1 = survey(withPytest).commands ?? {}
  const ok1 = c1.test === 'python -m pytest'
  check(ok1, '声明了 pytest → 给 pytest', JSON.stringify(c1.test))
  report(ok1, '声明 pytest → 用 pytest')

  // **没有**声明框架（用标准库 unittest 的项目就是这样）→ 给标准库那条，
  // 且必须带说明。按生态惯例给 pytest，会让一个 unittest 项目拿到跑不通的
  // 「硬门禁」命令，还把 P7 的诚实分支遮住。
  const noDecl = fixture('py-nodecl', {
    'pyproject.toml': '[project]\nname = "p"\n',
    'tests/test_a.py': 'import unittest\n',
  })
  const c2 = survey(noDecl).commands ?? {}
  const ok2 = c2.test === 'python -m unittest discover -s tests -v'
  check(ok2, '未声明框架 → 给标准库那条', JSON.stringify(c2.test))
  report(ok2, '未声明框架 → 给标准库那条')
  const ok3 = typeof c2.testNote === 'string' && c2.testNote.length > 0
  check(ok3, '未声明框架时带「这是推断」的说明')
  report(ok3, '并注明这是推断，非项目声明')

  // 显式声明 unittest → 给 unittest 且不带推断说明（第三分支不断言会回退到惯例旧错）
  const withUnit = fixture('py-unit', {
    'pyproject.toml': '[project]\nname = "p"\n\n[tool.unittest]\n',
    'tests/test_a.py': 'import unittest\n',
  })
  const c3 = survey(withUnit).commands ?? {}
  const ok4 = c3.test === 'python -m unittest discover -s tests -v' && c3.testNote === undefined
  check(ok4, '声明 unittest → 给 unittest 且无推断说明', JSON.stringify(c3.test))
  report(ok4, '声明 unittest → 无推断说明')
}

group('[19] 发版规则：有版本号与没有版本号，两种写法都要有')
{
  // 有版本号 → 标签名对齐清单里那一处
  const withV = fixture('ver-with', {
    'package.json': JSON.stringify({ name: 'a', version: '1.2.3' }),
  })
  compose(withV)
  const t1 = readFileSync(join(withV, 'AGENTS.md'), 'utf8')
  const ok1 = /标签名必须与清单文件里的版本号一致/.test(t1)
  check(ok1, '有版本号 → 标签名要对齐它')
  report(ok1, '有版本号：标签名对齐清单')
  const ok2 = !/本项目没有版本号/.test(t1)
  check(ok2, '有版本号 → 不出现「没有版本号」分支')
  report(ok2, '有版本号：不误报「没有版本号」')

  // 没有版本号 → 命名自定，且**不得**出现「必须与版本号一致」（那会让执行者无从下手）
  const noV = fixture('ver-none', {
    'go.mod': 'module x\n\ngo 1.22\n',
    'main.go': 'package main\n',
  })
  compose(noV)
  const t2 = readFileSync(join(noV, 'AGENTS.md'), 'utf8')
  const ok3 = /本项目没有版本号/.test(t2) && /单调、不重复、可排序/.test(t2)
  check(ok3, '没有版本号 → 给出自定命名规则')
  report(ok3, '没有版本号：给出命名规则')
  const ok4 = !/标签名必须与清单文件里的版本号一致/.test(t2)
  check(ok4, '没有版本号 → 不出现「必须与版本号一致」')
  report(ok4, '没有版本号：不出现矛盾要求')
  const ok5 = /不要编一个出来/.test(t2)
  check(ok5, '没有版本号 → 明确禁止编造一个')
  report(ok5, '没有版本号：禁止编造')
}

if (!HAS_GIT) {
  skipGroup('[3] 仓库根的各种路径写法都必须判真', '环境里没有 git')
} else {
group('[3] 仓库根的各种路径写法都必须判真')
{
  const repo = fixture('repo-root', { 'README.md': '# r\n' })
  for (const args of [['init', '-q'], ['config', 'user.name', 'T'],
    ['config', 'user.email', 't@example.com']]) spawnSync('git', args, { cwd: repo })
  spawnSync('git', ['add', '-A'], { cwd: repo })
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: repo })

  const cases = [
    ['精确路径', repo],
    ['正斜杠', repo.replace(/\\/g, '/')],
    ['结尾分隔符', repo + (process.platform === 'win32' ? '\\' : '/')],
  ]
  // 大小写只在**大小写不敏感的**文件系统上才该判真。在 Linux 上，全大写的路径是一个
  // 真正不存在的路径，判假才是对的。所以这一条按平台能力条件化——把 Windows 的行为
  // 当成所有平台的行为，测试本身就成了错的（CI 在 Ubuntu 上就是这样红的）。
  const caseInsensitive = existsSync(repo.toUpperCase())
  if (caseInsensitive) cases.push(['大小写变化', repo.toUpperCase()])

  for (const [label, p] of cases) {
    const ok = survey(p).git?.isRepoRoot === true
    check(ok, `${label} → true`)
    report(ok, label)
  }
  process.stdout.write(`  （本机文件系统${caseInsensitive ? '不区分' : '区分'}大小写，`
    + `${caseInsensitive ? '已' : '未'}断言大小写场景）\n`)
}
}

group('[9] 多生态：命令按生态分组，不互相覆盖')
{
  // 两边都**显式声明**了测试框架：只有这样断言才有意义。若不声明，勘察给出的是
  // 「按标准库推断」的带说明命令（那是正确的行为，见第 13 组）。
  const dir = fixture('multi', {
    'package.json': JSON.stringify({
      name: 'mixed', version: '1.0.0',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2),
    'pyproject.toml': '[project]\nname = "mixed"\nversion = "1.0.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    'requirements.txt': 'pdfplumber>=0.10\n',
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


// ── [49] 命令行用法：打错了必须说出来 ────────────────────────────────────────

group('[49] 命令行用法：打错了必须说出来')
{
  const run = (args) => spawnSync(process.execPath,
    [join(SKILL_ROOT, 'scripts', 'dev', 'preflight.mjs'), ...args],
    { encoding: 'utf8', windowsHide: true })
  // 断的是「有输出」，不是只断退出码：只断退出码正是让「提示被 return 2 吃掉」这个缺陷
  // 溜过去的原因——退出码对了，人却什么都看不到。
  for (const [args, label] of [
    [['--bogus'], '未知参数'],
    [['--release'], '参数缺值'],
    [['--package'], '参数缺值'],
  ]) {
    const r = run(args)
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim()
    const ok = r.status === 2 && text !== ''
    check(ok, `用法错误（${label}）退出 2 且说得出话`, `exit=${r.status} 输出 ${text.length} 字节`)
    report(ok, `用法错误：${label}`)
  }
  const help = run(['--help'])
  const helpOk = help.status === 0 && /用法/.test(help.stdout ?? '')
  check(helpOk, '--help 退出 0 并打印用法', `exit=${help.status}`)
  report(helpOk, '--help 打印用法')
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


