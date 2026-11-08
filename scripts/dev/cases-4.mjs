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
import { isMainModule, parseGitHubRepo, skillVersion, skillSource, parseMarkerKeys, normVersion, repoPath, repoRelation } from '../lib/text.mjs'
import { UPSTREAM, STALE_CHECK_MS, apiEndpoint, routesFor } from '../update.mjs'
import { clearStaleTemps } from '../lib/fs-atomic.mjs'
import { badgeVerdict, tierSecrets, unhandledRiskKeys, outsideKernel } from '../review.mjs'
import { readZip, stripCommonPrefix } from '../zip.mjs'
import { markerPositions } from '../lib/markdown.mjs'
import { executorVerdict } from './preflight.mjs'
import {
  isHighRiskPath, highRiskChanged, reviewRecordState, matchRoundsToComments,
  readHighRiskTable, readHighRiskPaths, unquoteGitPath,
  saysSomething, roundMarks, roundVerdict,
} from '../review-record.mjs'

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

// ── [46] 自动更新：源码副本只读，包副本比版本、整份覆盖 ────────────────────────
group('[48b] 落盘族引用归属：模板带了自己的路径就必须红，别人的文件不许误判')
{
  // 这一组守的是「文件集合正确、包自身也对，但落盘到别人家之后读者扑空」那一类。
  // 判据的**方向**与前一组相反：前一组问「本包里有吗」，这一组问「这是谁的文件」。
  //
  // 实现上刻意把**五条正例合并成一次检查**：preflight 的这项检查会收集全部违规
  // 再统一报出，所以一次写入五种违规、再核对输出里五种是否都在，比跑五遍更强——
  // 逐条跑只证明「单独违反时会红」，合并跑还额外证明「同时违反时一个都不漏」。
  //
  // 这不是为了快而放松判据：断言从「某一条会红」变成「五类全都点到」，更严。
  const clone = skillClone('delivered-attribution')

  const before = preflightIn(clone)
  check(before.status === 0, '前提：未改动的副本本来是全绿的（否则下面几条断言没有对象）',
    before.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(before.status === 0, '前提：未改动副本全绿')

  const readmePath = join(clone, 'templates', 'readme.md')
  const readmeBefore = readFileSync(readmePath, 'utf8')

  // ── 五条正例，一次全写进去 ───────────────────────────────────────────────
  //
  //   1. 指向 references/（本包独占命名空间，目标项目不会自然长出来）
  //   2. 指向本包真实存在的脚本（读者会照着跑，而目标项目没有那个文件）
  //   3. 新建一个模板，不登记任何清单（定义域由目录结构给出，不靠人工名单）
  //   4. 尖括号通配形态（读者看它就是路径，不能因为含 <> 就对门禁隐形）
  //   5. 命名空间内但文件在本包里也不存在（措辞要区分「两个项目里都找不到」）
  const newTemplate = join(clone, 'templates', 'security.md')
  writeFileSync(readmePath, [
    readmeBefore,
    '见 `references/publish.md` 的说明。',
    '跑 `scripts/sync-toc.mjs` 生成目录。',
    '另有 `references/publish-<生态>.md`。',
    '见 `references/does-not-exist.md`。',
  ].join('\n'), 'utf8')
  writeFileSync(newTemplate, '# 安全\n\n判据见 `references/handoff.md`。\n', 'utf8')
  gitIn(clone, 'add', '-A')

  const all = preflightIn(clone, { only: "落盘族引用归属" })
  const out = all.out
  check(all.status === 1, '五条违规同时写入 → 整体判红', out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 2).join(' | ').slice(0, 200))
  check(/references\/publish\.md|references\//.test(out), '正例：templates/ 里指向 references/ → 红')
  check(/scripts\/sync-toc\.mjs|本 skill 自己的路径|落盘族/.test(out), '正例：指向本包脚本 → 红')
  check(/security\.md|references\/handoff\.md|落盘族/.test(out), '正例：新建模板无需登记，自动化纳入判据')
  check(/publish-<|尖括号|references\//.test(out), '正例：尖括号通配形态也被判（读者看它就是路径）')
  check(/在两个项目里都找不到/.test(out), '正例：命名空间内的不存在路径也红，措辞区分「本包也没有」')
  report(all.status === 1, '正例：五条违规一次全抓到')

  // 复位：删掉新模板、恢复 README，否则后面每一条反例都会被污染成红。
  // 清理必须验证——一个静默失败的 catch 会让这个文件留在副本里，
  // 把后续用例全带偏，症状出现在别处而根因在这里。
  if (existsSync(newTemplate)) unlinkSync(newTemplate)
  writeFileSync(readmePath, readmeBefore, 'utf8')
  check(!existsSync(newTemplate), '前置：新模板已删除（否则后续复位用例无意义）')

  // ── 四条反例，同样一次全写进去 ───────────────────────────────────────────
  //
  //   1. 目标项目自己的文件（这几份本来就应该出现在目标项目的模板里）
  //   2. 目标项目自己的脚本名（本包没有这个文件，同名不同物）
  //   3. 受管围栏标记（它们是本 skill 的围栏，不是写给目标项目的引用）
  //   4. YAML 模板里的注释（落盘族文件，注释同样会被读者看到）
  const ciPath = join(clone, 'templates', 'ci-check.yml')
  const ciBefore = readFileSync(ciPath, 'utf8')
  writeFileSync(readmePath, [
    readmeBefore,
    '[English](README.en.md) | [贡献](CONTRIBUTING.md) | [许可](LICENSE)',
    '跑 `scripts/build.mjs` 打包。',
    '<!-- project-forge:kernel:start -->',
    '<!-- pf:author: 测试 -->',
  ].join('\n'), 'utf8')
  gitIn(clone, 'add', '-A')

  const clean = preflightIn(clone, { only: "用户包边界" })
  check(clean.status === 0, '反例：目标项目自有文件、同名不同物、受管标记 → 一律不判',
    clean.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(clean.status === 0, '反例：三类不该判的都放行')
  writeFileSync(readmePath, readmeBefore, 'utf8')

  // YAML 单独一条：它必须**红**（与上面三条方向相反），因为注释里的本包路径
  // 同样会让读者扑空。
  writeFileSync(ciPath, `# 判据见 references/remote-github.md 第八节。\n${ciBefore}`, 'utf8')
  gitIn(clone, 'add', '-A')
  const yml = preflightIn(clone, { only: "落盘族引用归属" })
  check(yml.status === 1 && /本 skill 自己的路径/.test(yml.out), '正例：.yml 模板也要判（原先只扫 .md，8 处漏检就出在这里）',
    yml.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(yml.status === 1 && /本 skill 自己的路径/.test(yml.out), '.yml 模板纳入判据')
  writeFileSync(ciPath, ciBefore, 'utf8')

  gitIn(clone, 'add', '-A')
  const final = preflightIn(clone)
  check(final.status === 0, '末尾：全部复位后应回到全绿',
    final.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(final.status === 0, '末尾：复位后回绿')
}

// ── [52] 账本登记：一次记多份，且全有或全无 ──────────────────────────────────
//
// 分成多次调用是账本机制最容易出错的地方：写 README 时记得调、写 CONTRIBUTING 时忘了，
// 账本就少一条，交棒时那一份退化成按形状猜——而账本存在的唯一理由就是不再猜。
// 更要紧的是**失败时不能留半套账**：账本看起来有内容，比它空着更坏。
group('[65] 账本登记：多份一次记，失败时一份都不记')
{
  const dir = fixture('ledger-record', {})
  for (const f of ['README.md', 'CONTRIBUTING.md', 'LICENSE']) {
    writeFileSync(join(dir, f), `# ${f}\n`, 'utf8')
  }
  const compose = (...args) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'compose-agents.mjs'), dir, ...args], { encoding: 'utf8', windowsHide: true })
  const ledgerPath = join(dir, '.project-forge', 'ledger.json')
  const recorded = () => {
    if (!existsSync(ledgerPath)) return []
    try {
      return Object.keys(JSON.parse(readFileSync(ledgerPath, 'utf8').replace(/^\uFEFF/, ''))?.segments ?? {})
    } catch { return [] }
  }

  // 一次给三份：账本里就该有三条。
  const all = compose('--record', 'README.md', 'CONTRIBUTING.md', 'LICENSE')
  const three = recorded()
  check(all.status === 0 && three.length === 3,
    '--record 一次给多份，全部入账（不必为每份各调一次）',
    `exit=${all.status} 账本里是 ${JSON.stringify(three)}`)
  report(all.status === 0 && three.length === 3, '多份登记：三份都在账本里')

  // 含一份不存在的：整批拒绝，账本**一条都不写**。
  rmSync(join(dir, '.project-forge'), { recursive: true, force: true })
  const bad = compose('--record', 'README.md', 'MISSING.md', 'LICENSE')
  const afterBad = recorded()
  check(bad.status !== 0, '有一份不存在时整批失败（不静默只记一部分）',
    `exit=${bad.status} 输出=${(bad.stderr ?? '').slice(0, 160)}`)
  report(bad.status !== 0, '全有或全无：失败')
  check(afterBad.length === 0, '失败时一个字节都没写（半套账比没有账更坏）',
    `账本里是 ${JSON.stringify(afterBad)}`)
  report(afterBad.length === 0, '全有或全无：账本没动')
  check(/MISSING\.md/.test(bad.stderr ?? ''), '失败时说清是哪一份（否则要靠自己找）')
  report(/MISSING\.md/.test(bad.stderr ?? ''), '全有或全无：说清缺哪份')

  // 重复给 --record 与一次给多份等价。
  rmSync(join(dir, '.project-forge'), { recursive: true, force: true })
  const repeated = compose('--record', 'README.md', '--record', 'LICENSE')
  const two = recorded()
  check(repeated.status === 0 && two.length === 2,
    '--record 可以重复给，与一次给多份等价',
    `exit=${repeated.status} 账本里是 ${JSON.stringify(two)}`)
  report(repeated.status === 0 && two.length === 2, '重复 --record：等价')

  // 后面不跟值：用法错误，不许当成「没有要记的」静默通过。
  const bare = compose('--record')
  check(bare.status === 2 && /需要一个相对路径/.test(bare.stderr ?? ''),
    '--record 后面不跟路径 → 用法错误（退出 2）',
    `exit=${bare.status} ${(bare.stderr ?? '').slice(0, 120)}`)
  report(bare.status === 2, '只给开关不给值：报用法错误')
}

// ── [55] 引用断链：历史快照不算，活文档照判 ──────────────────────────────────
//
// 判据问的是「照着这份现在能不能走通」。`docs/` 是**历史快照**（各版本发布说明），它描述的
// 是那一版的仓库长什么样——里面提到一个后来被删掉的文件，是**正确**的历史陈述，不是断链。
// 要求它跟着今天的仓库走，等于逼人改写已发布的历史。
//
// 两面对称才成立：如果只验「docs/ 不算」，判据可能整个失效而没人发现；如果只验「活文档
// 照判」，docs/ 一旦被加进去就会误红。所以一次验两条，方向相反。
group('[66] 引用断链：docs/ 是历史快照不判，活文档照判')
{
  const clone = skillClone('docs-refs')
  const histDir = join(clone, 'docs', 'release-notes')
  mkdirSync(histDir, { recursive: true })

  // 历史说明里提到一个本仓库没有的脚本（真实场景：它后来被删掉了）。
  // 说明本身要有节：它同时被「发布说明是一份成品」那条检查看着，空壳不是历史陈述。
  writeFileSync(join(histDir, 'v9.9.9.md'),
    '# v9.9.9\n\n## 这一版更新了什么、修复了什么\n\n这一版删掉了 `scripts/gone-forever.mjs`，改用别的做法。\n', 'utf8')
  gitIn(clone, 'add', '-A')

  const okHist = preflightIn(clone, { only: '引用能否解析' })
  const noHit = !/gone-forever/.test(okHist.out)
  check(okHist.status === 0 && noHit,
    '历史快照里提到已删除的文件 → 不算断链（那是正确的历史陈述）',
    okHist.out.split('\n').filter((l) => /FAIL|gone-forever/.test(l)).join(' | ').slice(0, 200))
  report(okHist.status === 0 && noHit, '历史快照：不误判')

  // 反侧：同一句话放进活文档，必须红。少了这一条，「docs/ 不判」可以靠「整条判据失效」满足。
  const liveDoc = join(clone, 'references', 'survey.md')
  const liveBefore = readFileSync(liveDoc, 'utf8')
  writeFileSync(liveDoc, `${liveBefore}\n跑 \`scripts/gone-forever.mjs\` 即可。\n`, 'utf8')
  gitIn(clone, 'add', '-A')

  const badLive = preflightIn(clone, { only: '引用能否解析' })
  check(badLive.status === 1 && /gone-forever/.test(badLive.out),
    '同一个路径放进活文档 → 断链照判（否则「不判 docs/」可以靠判据整体失效满足）',
    badLive.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 200))
  report(badLive.status === 1, '活文档：照判')

  writeFileSync(liveDoc, liveBefore, 'utf8')

  // 第三条：`docs/` 底下**不全是历史快照**。工作记录是活文档，它引用的文件必须走得通。
  //
  // 少了这一条，「`docs/` 不判」可以靠「豁免整个目录」满足——而那会让 `docs/` 变成引用
  // 检查的盲区，偏偏那正是 AI 最常去读的地方之一。判据分开，两面都要断言。
  const workDir = join(clone, 'docs', 'work')
  mkdirSync(workDir, { recursive: true })
  writeFileSync(join(workDir, 'task-a.md'),
    '# 任务 A\n\n改动落在 `scripts/gone-forever.mjs`。\n', 'utf8')
  gitIn(clone, 'add', '-A')

  const badWork = preflightIn(clone, { only: '引用能否解析' })
  check(badWork.status === 1 && /gone-forever/.test(badWork.out),
    '工作记录（docs/ 下的活文档）引用不存在的文件 → 断链照判',
    badWork.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 200))
  report(badWork.status === 1, '工作记录：照判，不跟着历史快照一起豁免')

  rmSync(workDir, { recursive: true, force: true })
}

group('[67] 架构升级与逻辑补全：决策持久化、工具链推导与行内反引号隔离')
{
  // 1. markerPositions: 行内反引号内的标记被忽略，独占一行的标记被正确解析
  const sampleDoc = [
    '# 标题',
    '',
    '正文举例：`- \`<!-- toc:start -->\` / \`<!-- toc:end -->\`` 这一行不应被匹配。',
    '',
    '```markdown',
    '<!-- toc:start -->',
    '围栏内部的不应被匹配',
    '<!-- toc:end -->',
    '```',
    '',
    '<!-- toc:start -->',
    '- [标题](#标题)',
    '<!-- toc:end -->',
  ].join('\n')

  const posStart = markerPositions(sampleDoc, '<!-- toc:start -->')
  const posEnd = markerPositions(sampleDoc, '<!-- toc:end -->')
  const okMarker = posStart.length === 1 && posEnd.length === 1
  check(okMarker, 'markerPositions：行内反引号与围栏内标记均被排除，仅匹配独占一行的真标记')
  report(okMarker, '标记位置：行内反引号与围栏隔离')

  // 2. Cargo workspace.package 继承版本号
  const cargoWs = fixture('cargo-ws-pkg', {
    'Cargo.toml': [
      '[workspace]',
      'members = ["crates/*"]',
      '',
      '[workspace.package]',
      'version = "1.9.9"',
      'edition = "2021"',
    ].join('\n'),
    'crates/sub/Cargo.toml': [
      '[package]',
      'name = "sub-crate"',
      'version.workspace = true',
    ].join('\n'),
    'crates/sub/src/lib.rs': 'pub fn hi() {}\n',
  })
  const sCargo = survey(cargoWs)
  const okCargo = sCargo.artifacts?.declaredVersion === '1.9.9'
  check(okCargo, 'Cargo 多包仓库：根表 [workspace.package] 版本被正确识别为 declaredVersion')
  report(okCargo, 'Cargo workspace：继承版本号')

  // 3. Python uv 工具链推导
  const pyUv = fixture('py-uv-tool', {
    'pyproject.toml': [
      '[project]',
      'name = "uv-demo"',
      'version = "0.1.0"',
      '',
      '[tool.uv]',
      'dev-dependencies = ["pytest"]',
    ].join('\n'),
    'uv.lock': '',
    'tests/test_demo.py': 'def test_pass(): assert True\n',
  })
  const sPy = survey(pyUv)
  const okUv = /uv run pytest/.test(sPy.commands?.test ?? '')
  check(okUv, 'Python uv 工具链：检测到 uv.lock 或 tool.uv 时自动推导 uv run 测试命令')
  report(okUv, 'Python uv：推导命令')

  // 4. Turbo task runner 推导
  const turboProj = fixture('turbo-proj', {
    'package.json': JSON.stringify({
      name: 'turbo-monorepo',
    }),
    'pnpm-lock.yaml': '',
    'turbo.json': JSON.stringify({
      tasks: {
        build: { dependsOn: ['^build'] },
        test: { dependsOn: ['build'] },
      },
    }),
  })
  const sTurbo = survey(turboProj)
  const okTurbo = /pnpm turbo run test/.test(sTurbo.commands?.test ?? '')
  check(okTurbo, 'Turbo task runner：结合 pnpm 锁文件自动推导 pnpm turbo run test')
  report(okTurbo, 'Turbo 运行器：推导命令')

  // 5. review 决策持久化（--remember / --forget 与 ledger 同步）
  const decProj = fixture('decision-proj', {
    'README.md': '# Demo\n',
    'LICENSE': 'MIT\n',
  })
  // 运行 review.mjs --remember --no-publish
  const runRem = spawnSync(process.execPath, [
    join(SCRIPTS_DIR, 'review.mjs'), decProj, '--remember', '--no-publish',
  ], { encoding: 'utf8', windowsHide: true })
  const ledgerPath = join(decProj, '.project-forge', 'ledger.json')
  const l1 = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {}
  const okRem = l1.decisions?.['no-publish'] === true
  check(okRem, '决策记忆：review.mjs --remember 成功写入 .project-forge/ledger.json')
  report(okRem, '决策记忆：写入账本')

  // 运行 review.mjs --forget --no-publish
  const runFor = spawnSync(process.execPath, [
    join(SCRIPTS_DIR, 'review.mjs'), decProj, '--forget', '--no-publish',
  ], { encoding: 'utf8', windowsHide: true })
  const l2 = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, 'utf8')) : {}
  const okFor = l2.decisions?.['no-publish'] === undefined
  check(okFor, '决策遗忘：review.mjs --forget 成功从账本清除已记忆项')
  report(okFor, '决策遗忘：清除账本')

  // 6. 交棒 graduation mode（账本记录为 blocks: false，不阻塞交棒）
  const gradProj = fixture('grad-proj', {
    'README.md': '# Grad\n',
    'LICENSE': 'MIT\n',
    '.project-forge/ledger.json': JSON.stringify({
      version: 1,
      deliverables: {
        'README.md': { hash: 'abcd1234ef', at: '2026-11-08T00:00:00Z', section: 'whole' },
      },
      decisions: {},
    }),
  })
  const runHandoff = spawnSync(process.execPath, [
    join(SCRIPTS_DIR, 'handoff.mjs'), gradProj, '--scan',
  ], { encoding: 'utf8', windowsHide: true })
  check(runHandoff.status === 0, '交棒毕业状态：账本交付物记录不再阻塞交棒完成')
  report(runHandoff.status === 0, '交棒毕业：非阻塞交付物账本')
}

group('[58] 本仓库发布说明自检：空壳会被拦住，好说明放行')
{
  const clone = skillClone('notes-self-check')
  const notesDir = join(clone, 'docs', 'release-notes')
  mkdirSync(notesDir, { recursive: true })

  // 空壳：标题在、节在、节里只有一句注释。这种「看着写完了」的最容易被放过。
  writeFileSync(join(notesDir, 'v9.9.9.md'),
    '# v9.9.9\n\n## 这一版变了什么\n\n<!-- 待补 -->\n', 'utf8')
  gitIn(clone, 'add', '-A')
  const bad = preflightIn(clone, { only: '本仓库发布说明' })
  check(bad.status === 1 && /不像一份成品/.test(bad.out),
    '只有注释的空节 → 自检失败', bad.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))

  // 修好之后必须放行：否则上一条可以靠「永远失败」满足。
  writeFileSync(join(notesDir, 'v9.9.9.md'),
    '# v9.9.9\n\n## 这一版变了什么\n\n导出不再缺页。\n', 'utf8')
  gitIn(clone, 'add', '-A')
  const good = preflightIn(clone, { only: '本仓库发布说明' })
  check(good.status === 0, '补上内容之后放行', good.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))
  report(bad.status === 1 && good.status === 0, '发布说明自检：空壳拦得住、成品放得过')
}
group('[59] 本仓库工作记录：命名、表头、断点各有一条结构判据')
{
  const clone = skillClone('work-record-check')
  const dir = join(clone, 'docs', 'work')
  mkdirSync(dir, { recursive: true })

  // 反例一：文件名没带日期（最常见的那种「顺手起个名」）。
  writeFileSync(join(dir, '随手的名字.md'),
    '# 一件事\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 进行中 |\n| 建单日期 | 2026-11-08 |\n| 最近更新 | 2026-11-08 |\n| 执行者 | test <a@b.c> |\n\n## 断点\n\n等审查。\n', 'utf8')
  gitIn(clone, 'add', '-A')
  const badName = preflightIn(clone, { only: '本仓库工作记录' })
  check(badName.status === 1 && /YYYY-MM-DD/.test(badName.out),
    '文件名没带日期 → 报出来', badName.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))

  // 反例二：名字对了、表头缺「最近更新」。
  const goodName = join(dir, '2026-11-08-一件事.md')
  writeFileSync(goodName,
    '# 一件事\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 进行中 |\n| 建单日期 | 2026-11-08 |\n\n## 断点\n\n等审查。\n', 'utf8')
  rmSync(join(dir, '随手的名字.md'))
  gitIn(clone, 'add', '-A')
  const badHead = preflightIn(clone, { only: '本仓库工作记录' })
  check(badHead.status === 1 && /缺 最近更新|表头缺/.test(badHead.out),
    '表头缺一行 → 报出来', badHead.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))

  // 反例三：断点被清空、但后面那节有正文。截取范围若只删标题行，这条会误判「非空」。
  writeFileSync(goodName,
    '# 一件事\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 进行中 |\n| 建单日期 | 2026-11-08 |\n| 最近更新 | 2026-11-08 |\n| 执行者 | test <a@b.c> |\n\n## 断点\n\n## 完成后的记录\n\n已经合并，无遗留。\n', 'utf8')
  gitIn(clone, 'add', '-A')
  const emptyBreak = preflightIn(clone, { only: '本仓库工作记录' })
  check(emptyBreak.status === 1 && /断点/.test(emptyBreak.out),
    '断点被清空、后面那节有内容 → 仍报出来', emptyBreak.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))

  // 正例：补齐之后放行（同时证明上一条不是「永远失败」）。
  writeFileSync(goodName,
    '# 一件事\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 进行中 |\n| 建单日期 | 2026-11-08 |\n| 最近更新 | 2026-11-08 |\n| 执行者 | test <a@b.c> |\n\n## 断点\n\n等审查。\n', 'utf8')
  gitIn(clone, 'add', '-A')
  const ok = preflightIn(clone, { only: '本仓库工作记录' })
  check(ok.status === 0, '补齐之后放行', ok.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))
  report(badName.status === 1 && badHead.status === 1 && emptyBreak.status === 1 && ok.status === 0,
    '工作记录结构：命名、表头、断点、正例四面都分得清')
}
group('[68] 审查记录：高风险改动必须有可核对的痕迹')
{
  // 1) 高风险路径的判据：**目录前缀**，不是逐文件清单。
  //    清单要人记得改；目录不会长出新的一处。
  const RISK = ['scripts/', 'templates/', '.github/workflows/', '.gitattributes']
  const high = ['scripts/survey.mjs', 'templates/x.md', '.github/workflows/check.yml', '.gitattributes', 'scripts/lib/text.mjs']
  const low = ['README.md', 'references/a.md', 'docs/work/x.md', 'scripts-dev/x.mjs']
  const missed = high.filter((p) => !isHighRiskPath(p, RISK))
  const over = low.filter((p) => isHighRiskPath(p, RISK))
  check(missed.length === 0 && over.length === 0, '高风险路径按目录前缀判，且不误伤同名近似路径',
    `漏=${missed.join('、') || '无'} 误判=${over.join('、') || '无'}`)
  report(missed.length === 0 && over.length === 0, '高风险路径：分得清')

  // 反例：`scripts-dev/` 不是 `scripts/` 的子串匹配。前缀判据写错（`includes`）时它会误判。
  check(!isHighRiskPath('scripts-dev/a.mjs', RISK), '前缀判据不是 includes：scripts-dev 不算 scripts')

  // 1b) 契约 → 判据那条**真实链路**：表怎么写才读得出来。
  //
  // 这一组之前是缺的：用例只测 `isHighRiskPath`（手写前缀表），从来不测「从 AGENTS.md
  // 里读」——而后者才是那个门禁真正的输入。三种人类最常写的形状，全都在这里。
  {
    const table = (row) => `## 高风险路径\n\n| 路径 | 为什么 |\n| --- | --- |\n| ${row} | x |\n`

    // 目录不带尾斜杠 → 补成前缀形式。漏一个斜杠的后果是这条判据对整棵树失效，
    // 而症状完全不可见——所以它必须被认。
    // 归一化不再猜「文件还是目录」，所以这里断言的是「规范形式 + 真的命中」。
    // 判据变了但强度没降：能命中才是这条用例要证明的东西。
    check(JSON.stringify(readHighRiskPaths(table('`src/rules`'))) === '["src/rules"]'
      && isHighRiskPath('src/rules/a.js', readHighRiskPaths(table('`src/rules`'))),
      '目录不带尾斜杠 → 规范成 src/rules，且改 src/rules/a.js 仍判高风险',
      JSON.stringify(readHighRiskPaths(table('`src/rules`'))))
    // 格子里带说明 → 取反引号里那一段。
    check(JSON.stringify(readHighRiskPaths(table('`src/rules/` 下的判定'))) === '["src/rules"]'
      && isHighRiskPath('src/rules/a.js', readHighRiskPaths(table('`src/rules/` 下的判定'))),
      '格子里带说明 → 取反引号里那一段，且仍然命中',
      JSON.stringify(readHighRiskPaths(table('`src/rules/` 下的判定'))))
    // 一格两个路径 → 全都收。
    const twoPaths = readHighRiskPaths(table('`a/`,`b/`'))
    check(JSON.stringify(twoPaths) === '["a","b"]'
      && isHighRiskPath('a/x', twoPaths) && isHighRiskPath('b/x', twoPaths),
      '一格写两个路径 → 全部收下，且两个都能命中', JSON.stringify(twoPaths))
    // 单个文件照原样，不补斜杠。
    check(JSON.stringify(readHighRiskPaths(table('`AGENTS.md`'))) === '["AGENTS.md"]',
      '单个文件不补斜杠（`AGENTS.md` 不会被写成 `AGENTS.md/`）',
      JSON.stringify(readHighRiskPaths(table('`AGENTS.md`'))))
    // 占位符不算路径——模板里那些尖括号占位不该变成判据。
    check(readHighRiskPaths(table('`<替换成这个项目的第一处>`')).length === 0,
      '尖括号占位不算路径（模板没填时不该凭空多出一条判据）')
    // 认不出来的行要单独给出来，让调用方报错——**认不出来不等于没有**。
    const skipped = readHighRiskTable(table('<替换成第一处>'))
    check(skipped.paths.length === 0 && skipped.skipped.length === 1,
      '认不出来的行收进 skipped（由调用方报错，不静默跳过）', JSON.stringify(skipped))
    // 没有那一节 → found 为 false，调用方才好说「这一趟没查」。
    check(readHighRiskTable('# 没有那一节\n').found === false,
      '没有「## 高风险路径」这一节 → found=false（调用方据此报「没查」）')
    // 复算一遍再报：把上面几条的关键结论重新算一次，全对才算这组通过。
    // 传字面量 true 时它永远通过，而它会算进通过总数——那个下限应该度量「有多少条判据
    // 在守着」，掺进恒真项就失去意义。
    const tableOk = (row, want) => JSON.stringify(readHighRiskPaths(table(row))) === want
    const allTable = tableOk('`src/rules`', '["src/rules"]')
      && tableOk('`src/rules/` 下的判定', '["src/rules"]')
      && tableOk('`a/`,`b/`', '["a","b"]')
      && tableOk('`AGENTS.md`', '["AGENTS.md"]')
      && tableOk('`.github/`', '[".github"]')
      && readHighRiskPaths(table('`<替换成这个项目的第一处>`')).length === 0
    const reported = readHighRiskTable(table('<替换成第一处>')).skipped.length === 1
    const absent = readHighRiskTable('# 没有那一节\n').found === false
    report(allTable && reported && absent, '契约到判据：五种写法都认，认不出来的会说出来')
  }

  // 1c) git 的 C 风格转义。中文名的风险改动以前会被判成非高风险、绿着放行。
  {
    const esc = '"templates/\\345\\256\\241\\346\\237\\245.md"'
    check(unquoteGitPath(esc) === 'templates/审查.md', 'C 风格转义还原成真实路径', unquoteGitPath(esc))
    // **转义还原与「算不算高风险」是两步**，这条要验的是「还原之后仍判高风险」。
    // 上一版直接把转义原文喂给 isHighRiskPath —— 那一步它不做还原（也不该做：
    // 还原是 unquoteGitPath 的事，两处各做一次迟早给出两个答案），所以判 false
    // 不是判据坏了，是断言写错了。`highRiskChanged` 里那两步是这个顺序。
    check(isHighRiskPath(unquoteGitPath(esc), ['templates']) === true,
      '转义过的中文路径，还原之后照样判成高风险（不依赖调用方记得关 core.quotepath）')
    check(unquoteGitPath('templates/审查.md') === 'templates/审查.md', '没转义的原样返回', '')
    report(unquoteGitPath(esc) === 'templates/审查.md', '转义还原：中文路径不再漏判')
  }

  // 1d) 中文数字轮次。契约与示例全是中文，写「第一轮」不该判无效。
  {
    const mk = (row) => `## 审查记录\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n| --- | --- | --- | --- |\n| ${row} | s | 通过 | 0 / 1 |\n`
    const cases = [['1', '1'], ['第 1 轮', '1'], ['第一轮', '1'], ['第九轮', '9'],
      ['第十轮', '10'], ['第十一轮', '11'], ['第十二轮', '12'], ['第二十轮', '20']]
    const wrong = cases.filter(([input, want]) => reviewRecordState(mk(input)).rows?.[0]?.round !== want)
    check(wrong.length === 0, '八种写法都解析成正确的轮次（第一轮 → 1、第十二轮 → 12）',
      JSON.stringify(wrong))

    const st = reviewRecordState(mk('1'))
    // 判据从「字数 ≥ 80」换成「有没有说到具体东西」，所以这条 fixture 也要说具体东西——
    // 否则它验的是旧判据，而不是「三种轮次写法都认」这件事。
    const cmt = (h) => `${h}\n\n审了 \`scripts/review-record.mjs\` 的判定逻辑，零阻塞，`
      + '两条建议都在 review-record.mjs:322 那一带。'
    const heads = ['## 第一轮独立审查 —— 通过', '## 第 1 轮 —— 通过', '## round 1 —— 通过']
    const missAll = heads.filter((h) => !matchRoundsToComments(st, [cmt(h)]).ok)

    // 反向仍然成立：中文写法不该把「不通过」放过去（整词判定不能被这次改动弄坏）。
    const stillBlocks = matchRoundsToComments(st, [cmt('## 第一轮 —— 不通过')]).ok === false

    check(missAll.length === 0 && stillBlocks,
      '评论侧三种写法都认得出「第 1 轮」，而「不通过」仍然被拦住', JSON.stringify(missAll))
    report(wrong.length === 0 && missAll.length === 0 && stillBlocks,
      '中文数字轮次：索引侧与评论侧都认，不通过仍拦住')
  }

  // 2) 改动清单去重、排序、只留高风险。
  const picked = highRiskChanged(['README.md', 'scripts/b.mjs', 'scripts/a.mjs', 'scripts/a.mjs'], RISK)
  const okPick = picked.length === 2 && picked[0] === 'scripts/a.mjs' && picked[1] === 'scripts/b.mjs'
  check(okPick, 'from 一份清单里挑出高风险项：去重且排序', picked.join('、'))
  report(okPick, '改动清单：挑得对')

  // 3) 审查记录的三种状态必须分得开：没有那一节 / 有但空着 / 填过了。
  //    「有但空着」是最容易漏判的一种——模板本来就在，注释里还写着怎么填。
  const bodyMissing = '## 改了什么\n\n改了判定逻辑。\n'
  const bodyEmpty = '## 改了什么\n\n改。\n\n## 审查记录\n\n'
    + '<!-- 怎么填：每轮一行 -->\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n| --- | --- | --- | --- |\n|  |  |  |  |\n'
  const bodyFilled = '## 审查记录\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n| --- | --- | --- | --- |\n| 1 | sub-audit | 通过 | 0 / 2 |\n'
  const bodyExempt = '## 审查记录\n\n本档不需要审查（只改了注释）。\n'
  const sMissing = reviewRecordState(bodyMissing)
  const sEmpty = reviewRecordState(bodyEmpty)
  const sFilled = reviewRecordState(bodyFilled)
  const sExempt = reviewRecordState(bodyExempt)
  check(sMissing.section === false && sMissing.filled === false, '没有「审查记录」这一节 → 判为缺', JSON.stringify(sMissing))
  report(sMissing.section === false, '审查记录：连节都没有')
  check(sEmpty.section === true && sEmpty.filled === false,
    '有那一节但只有表头空行（模板没填）→ 判为缺 —— 这是最容易漏判的一种', JSON.stringify(sEmpty))
  report(sEmpty.filled === false, '审查记录：空模板不算填过')
  check(sFilled.filled === true, '真的填了结论行 → 判为有', JSON.stringify(sFilled))
  report(sFilled.filled === true, '审查记录：填过就认')
  check(sExempt.filled === false,
    '只在正文里写「本档不需要审查」→ **不算**有效记录（免审由机器按改动路径自己算，'
    + '不由人自称；一句话谁都能写，而审查记录的作用是让漏审事后可核对）', JSON.stringify(sExempt))
  report(sExempt.filled === false, '审查记录：免审不能靠自称')

  // 半空的表格行也不算：只有轮次、审查者与结论都填了才认。
  const bodyHalf = '## 审查记录\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n| --- | --- | --- | --- |\n'
    + '| 1 |  |  |  |\n'
  check(reviewRecordState(bodyHalf).filled === false, '只有轮次、审查者与结论空着的行 → 判为缺',
    JSON.stringify(reviewRecordState(bodyHalf)))
  report(reviewRecordState(bodyHalf).filled === false, '审查记录：半空的行不算')

  // 结论是「需要返工」而后面没补轮次 → 还没修完，不算通过。
  const bodyRework = '## 审查记录\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n| --- | --- | --- | --- |\n'
    + '| 1 | sub-a | 需要返工 | 3 / 1 |\n'
  check(reviewRecordState(bodyRework).filled === false,
    '最后一轮结论是「需要返工」→ 判为缺（改完要再派一轮并在表里追加）',
    JSON.stringify(reviewRecordState(bodyRework)))
  report(reviewRecordState(bodyRework).filled === false, '审查记录：返工未复核不算通过')

  // 两轮：先返工后通过 → 算通过，而且是按**最后一轮**判的。
  const bodyTwoRounds = '## 审查记录\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n| --- | --- | --- | --- |\n'
    + '| 1 | sub-a | 需要返工 | 3 / 1 |\n| 2 | sub-b | 通过 | 0 / 2 |\n'
  check(reviewRecordState(bodyTwoRounds).filled === true, '两轮、最后一轮通过 → 判为通过',
    JSON.stringify(reviewRecordState(bodyTwoRounds)))
  report(reviewRecordState(bodyTwoRounds).filled === true, '审查记录：两轮按最后一轮判')

  // 3b) 评论那一层：正文是索引，评论才是痕迹。
  //
  // 判据的两半各管一件事：正文说「有哪几轮」，评论说「那些轮次真的发生过」。
  // 只核正文时，执行者自己写一行就够了——而独立审查的全部意义恰恰是它不是执行者给的。
  {
    const state = reviewRecordState('## 审查记录\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n'
      + '| --- | --- | --- | --- |\n| 1 | sub-a | 通过 | 0 / 2 |\n')

    // 没给评论文件 → 不判评论那一层，而且明说「没查」。
    const none = matchRoundsToComments(state, undefined)
    check(none.checked === false && none.ok === true,
      '调用方没提供评论时：不判评论那一层，并标明「没查」——「没查」与「查过没问题」必须分得开',
      JSON.stringify(none))
    report(none.checked === false, '评论层：没给就明说没查')

    // 评论里没有那一轮 → 不通过。
    const miss = matchRoundsToComments(state, ['这条评论只说工作记录更新了，没提轮次与结论'])
    check(miss.ok === false && miss.problems.length === 1 && /第 1 轮/.test(miss.problems[0]),
      '正文索引了第 1 轮、评论里找不到 → 不通过，并点名是哪一轮', JSON.stringify(miss.problems))
    report(miss.ok === false, '评论层：找不到就不通过')

    // **「写得够不够清楚」不判了**（见 saysSomething 的注释：七种判法都误伤真结论）。
    // 这里只验「空评论被排掉」——那是这条判据唯一还敢断言的内容质量下限。
    const empty = matchRoundsToComments(state, [''])
    check(empty.ok === false,
      '空评论 → 不算这一轮的痕迹（连「发过」都不算）',
      JSON.stringify(empty.problems))
    report(empty.ok === false, '评论层：空评论不算')

    // 评论里有一轮内容对得上 → 通过。
    const good = '## 独立审查 第 1 轮 —— 通过\n\n审了 scripts/ 下的判定逻辑。逐条：三条建议、'
      + '零阻塞。文件与行都核过，判定与用例能对上，没有发现门禁被改松的地方。'
    const ok = matchRoundsToComments(state, [good])
    check(ok.ok === true && ok.checked === true && ok.matched.length === 1,
      '评论里找得到那一轮且内容对得上 → 通过', JSON.stringify(ok))
    report(ok.ok === true, '评论层：对得上就通过')

    // 两轮：第一轮不通过、第二轮通过。评论里只有第一条 → 不通过，因为缺第二轮。
    const twoRounds = reviewRecordState('## 审查记录\n\n| 轮次 | 谁审的 | 结论 | 阻塞 / 建议 |\n'
      + '| --- | --- | --- | --- |\n| 1 | sub-a | 需要返工 | 3 / 1 |\n| 2 | sub-b | 通过 | 0 / 1 |\n')
    const partial = matchRoundsToComments(twoRounds, [good])
    check(partial.ok === false && partial.problems.some((p) => /第 2 轮/.test(p)),
      '两轮里只发了一条评论 → 不通过，缺的那轮要点名', JSON.stringify(partial.problems))
    report(partial.ok === false, '评论层：缺一轮也算缺')
  }

  // 3d) saysSomething：砍到只剩「是不是空的」。
  //
  // 这里**故意只留三条**，而且都是**能证伪**的：把实现改成「永远返回 true」，
  // 第一条就红；改成「永远 false」，后两条就红。
  //
  // 为什么不再验「写得够不够清楚」：试过七种判法，每种都误伤真结论。
  // 边界写在 references/collaboration.md 的判据表里——**这条判据证明「有痕迹」，
  // 不证明「审得认真」**。用例不该假装它证明了更多。
  {
    check(saysSomething('') === false, '空评论 → 不算（连「发过」都不算）')
    check(saysSomething('   \n  ') === false, '只有空白 → 不算')
    check(saysSomething('通过') === true,
      '「通过」两个字 → 放行（写得够不够好不归机器判，见判据表里的边界说明）')
    report(saysSomething('') === false && saysSomething('通过') === true,
      'saysSomething：只判空不空，不判内容质量')
  }

  // 反例：注释里的说明文字不算记录。去掉注释这一步漏了的话，模板自带的例句会让它永远通过。
  const onlyComment = '## 审查记录\n\n<!-- | 1 | 别人 | 通过 | -->\n'
  check(reviewRecordState(onlyComment).filled === false,
    '注释里的示例不算填过（去掉注释这一步不能漏）')
  report(reviewRecordState(onlyComment).filled === false, '审查记录：注释不算')

  // 4) 端到端：真的跑那个脚本，三种输入三种退出码。
  const cli = (args, input) => spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review-record.mjs'), ...args],
    { encoding: 'utf8', input })
  const dir2 = fixture('review-record', {})
  const bodyPath = join(dir2, 'body.md')
  writeFileSync(bodyPath, bodyEmpty, 'utf8')
  const r1 = cli(['--changed', '-', '--body', bodyPath], 'scripts/survey.mjs\n')
  check(r1.status === 1 && /审查记录缺失/.test(r1.stderr ?? ''), '脚本：高风险改动 + 空模板 → 退出码 1',
    `exit=${r1.status} ${(r1.stderr ?? '').slice(0, 120)}`)
  report(r1.status === 1, '脚本：拦住没填的')

  writeFileSync(bodyPath, bodyFilled, 'utf8')
  // 给了正文还不算：**评论那一层必须也对得上**。这两条用例成对存在——
  // 少一条，就等于允许「只填正文、评论一条不发」通过，而那正是这次返工要治的病。
  const commentsPath = join(dir2, 'comments.md')
  writeFileSync(commentsPath, '## 独立审查 第 1 轮 —— 通过\n\n'
    + '审了 scripts/ 下的判定逻辑。逐条：三条建议、零阻塞。文件与行都核过，'
    + '判定与用例能对上，没有发现门禁被改松的地方。\n', 'utf8')

  const rNoComments = cli(['--changed', '-', '--body', bodyPath], 'scripts/survey.mjs\n')
  check(rNoComments.status === 1 && /评论那一层未核对/.test(rNoComments.stderr ?? ''),
    '脚本：正文填了但没给评论 → 退出码 1（索引对不上评论，不算通过）',
    `exit=${rNoComments.status} ${(rNoComments.stderr ?? '').slice(0, 120)}`)
  report(rNoComments.status === 1, '脚本：只填正文不写评论 → 拦住')

  const r2 = cli(['--changed', '-', '--body', bodyPath, '--comments', commentsPath], 'scripts/survey.mjs\n')
  check(r2.status === 0 && /评论核对/.test(r2.stdout ?? ''), '脚本：正文与评论都对得上 → 退出码 0',
    `exit=${r2.status} ${(r2.stderr ?? '').slice(0, 120)}`)
  report(r2.status === 0, '脚本：两层都对上才放行')

  const r3 = cli(['--changed', '-', '--body', bodyPath], 'README.md\n')
  check(r3.status === 0 && /不需要审查记录/.test(r3.stdout ?? ''), '脚本：只改文档 → 不要求审查记录',
    `exit=${r3.status} ${(r3.stdout ?? '').slice(0, 120)}`)
  report(r3.status === 0, '脚本：低档免审')

  const r4 = cli(['--changed'], '')
  check(r4.status === 2 && /都要给/.test(r4.stderr ?? ''), '脚本：参数不全 → 退出码 2（用法错，不是判定错）',
    `exit=${r4.status}`)
  report(r4.status === 2, '脚本：用法错分得开')

  // 空清单 + --expect-changes：**空不能被读成「没动高风险路径」**。
  // 浅克隆里没有合并基点时 diff 会返回空，而那会被读成通过——门禁绿着放行，什么都没拦。
  const r5 = cli(['--changed', '-', '--body', bodyPath, '--expect-changes'], '')
  check(r5.status === 1 && /清单是空的/.test(r5.stderr ?? ''),
    '清单为空 + --expect-changes → 退出码 1（不许把「没算出来」读成「没动高风险路径」）',
    `exit=${r5.status} ${(r5.stderr ?? '').slice(0, 120)}`)
  report(r5.status === 1, '脚本：空清单不当通过')

  // 反例：不带那个开关时，空清单是允许的（本地「这轮只改了别处」是正当用法）。
  const r6 = cli(['--changed', '-', '--body', bodyPath], '')
  check(r6.status === 0, '不带 --expect-changes 时空清单放行（本地用法不该被绑死）', `exit=${r6.status}`)
  report(r6.status === 0, '脚本：本地空清单放行')
}

group('[69] 工作记录的「执行者」：写身份，不写代词')
{
  const rec = (who) => `# 一件事

| 项 | 值 |
| --- | --- |
| 状态 | 进行中 |
| 建单日期 | 2026-11-09 |
| 最近更新 | 2026-11-09 |
| 执行者 | ${who} |

## 断点

等审查。
`

  // 代词：这一格的用处是「该找谁问」，代词指不到人。
  check(executorVerdict(rec('本次会话')).verdict === 'pronoun',
    '写「本次会话」→ 判为代词（换个人打开就找不到人）')
  check(executorVerdict(rec('我')).verdict === 'pronoun', '写「我」→ 同样判为代词')
  check(executorVerdict(rec('AI')).verdict === 'pronoun', '写「AI」→ 同样判为代词')

  // 写不出身份（没有 @）：既不是代词，也不是人 —— 仍然不合格。
  check(executorVerdict(rec('小明')).verdict === 'no-identity',
    '写了名字但没有可联系的账号 → 判为「写不出身份」（这一格的用处是找人）')

  // **「取不到就写未署名并说明原因」是契约允许的终态，判据必须认。**
  // 不认的后果很具体：照契约做必然红，使用者唯一的出路是编一个邮箱（契约禁止）。
  // 但光写「未署名」三个字仍然是零信息——下一个人不知道是不能取还是懒得取。
  check(executorVerdict(rec('未署名')).verdict === 'no-identity',
    '光写「未署名」→ 不合格（零信息：不知道是不能取还是懒得取）')
  check(executorVerdict(rec('未署名（这个克隆里没有配置提交署名）')).verdict === 'ok',
    '「未署名 + 原因」→ 合格（契约允许的终态，不认就是把人往「编一个」上逼）')

  // 有身份：署名 + 邮箱。
  check(executorVerdict(rec('FiretrUCK666 <326200973+FiretrUCK666@users.noreply.github.com>')).verdict === 'ok',
    '写得出署名与邮箱 → 放行')
  check(executorVerdict(rec('@someone')).verdict === 'ok', '只写平台账号也算（有 @ 就能找到人）')

  // 反例：整格缺失时**不在这里报**——那是表头缺字段那条判据的事，两件事别混。
  check(executorVerdict('# 只有正文\n').verdict === 'absent', '没有这一格 → absent，不重复报')
  check(executorVerdict(rec('<!-- 待填 -->')).verdict === 'absent', '只有注释 → absent（等于没填）')

  // 复算一遍再报：这一组的结论是「三态都分得开」，把它算成一个布尔再交给 report。
  // 传字面量 true 时这条永远通过，而它会算进通过总数——那个下限本应是「有多少条判据
  // 在守着」的度量，掺进恒真项就失去意义。
  const ev = (v) => executorVerdict(rec(v)).verdict
  const allExecutor = ev('本次会话') === 'pronoun' && ev('我') === 'pronoun' && ev('AI') === 'pronoun'
    && ev('小明') === 'no-identity' && ev('未署名') === 'no-identity'
    && ev('FiretrUCK666 <a@b.c>') === 'ok' && ev('@someone') === 'ok'
    && ev('未署名（这个克隆里没有配置提交署名）') === 'ok'
  report(allExecutor, '执行者：代词与光写未署名都拦，有身份与「未署名+原因」都放行')
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
