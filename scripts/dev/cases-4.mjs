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
import { isHighRiskPath, highRiskChanged, reviewRecordState } from '../review-record.mjs'

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
group('[52] 账本登记：多份一次记，失败时一份都不记')
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
group('[55] 引用断链：docs/ 是历史快照不判，活文档照判')
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

group('[57] 架构升级与逻辑补全：决策持久化、工具链推导与行内反引号隔离')
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
    '# 一件事\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 进行中 |\n| 建单日期 | 2026-11-08 |\n| 最近更新 | 2026-11-08 |\n\n## 断点\n\n等审查。\n', 'utf8')
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
    '# 一件事\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 进行中 |\n| 建单日期 | 2026-11-08 |\n| 最近更新 | 2026-11-08 |\n\n## 断点\n\n## 完成后的记录\n\n已经合并，无遗留。\n', 'utf8')
  gitIn(clone, 'add', '-A')
  const emptyBreak = preflightIn(clone, { only: '本仓库工作记录' })
  check(emptyBreak.status === 1 && /断点/.test(emptyBreak.out),
    '断点被清空、后面那节有内容 → 仍报出来', emptyBreak.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))

  // 正例：补齐之后放行（同时证明上一条不是「永远失败」）。
  writeFileSync(goodName,
    '# 一件事\n\n| 项 | 值 |\n| --- | --- |\n| 状态 | 进行中 |\n| 建单日期 | 2026-11-08 |\n| 最近更新 | 2026-11-08 |\n\n## 断点\n\n等审查。\n', 'utf8')
  gitIn(clone, 'add', '-A')
  const ok = preflightIn(clone, { only: '本仓库工作记录' })
  check(ok.status === 0, '补齐之后放行', ok.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 160))
  report(badName.status === 1 && badHead.status === 1 && emptyBreak.status === 1 && ok.status === 0,
    '工作记录结构：命名、表头、断点、正例四面都分得清')
}
group('[40] 审查记录：高风险改动必须有可核对的痕迹')
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
  const r2 = cli(['--changed', '-', '--body', bodyPath], 'scripts/survey.mjs\n')
  check(r2.status === 0, '脚本：填过 → 退出码 0', `exit=${r2.status} ${(r2.stderr ?? '').slice(0, 120)}`)
  report(r2.status === 0, '脚本：放行填过的')

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
