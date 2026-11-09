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
import { executorVerdict, templateRegistrationIssues, contractSnippetIssues } from './preflight.mjs'
import {
  isHighRiskPath, highRiskChanged,
  readHighRiskTable, readHighRiskPaths, unquoteGitPath,
  readDoneBlock, readReviews, deriveOutcome, readWorkRecordPointer, readBasis,
  readClosingIssue, readProtocolParams, fieldBlocks,
  canonicalDoneSnippet, canonicalReviewSnippet,
  DONE_FENCE, REVIEW_FENCE, CONTRACT_SITES, DONE_SITES,
} from '../review-record.mjs'

/**
 * 造一条审查评论：正文随便写，机器只读字段块。
 *
 * **没有 verdict 参数**，这是刻意的——结论不由审查者声明。要它「不通过」就给它
 * 一条没过的标准（`fail`），要它「通过」就把 `fail` 留空并给了 `inject`。
 */
const reviewComment = (round, fail, inject = '删掉某处兜底分支 → 3 个用例变红 → 还原全绿', body = '') => [
  '## 独立审查 第 ' + String(round) + ' 轮',
  '',
  '```' + REVIEW_FENCE,
  'round: ' + String(round),
  'fail: ' + fail,
  'inject: ' + inject,
  '```',
  '',
  body,
].join('\n')

/** 造一份工作记录的正文：冻结若干条验收标准。 */
const workRecord = (...lines) => ['# 工作记录：示例', '', '## 目标与验收', '', '```' + DONE_FENCE,
  ...lines, '```', ''].join('\n')

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

  // 2) 改动清单去重、排序、只留高风险。
  const picked = highRiskChanged(['README.md', 'scripts/b.mjs', 'scripts/a.mjs', 'scripts/a.mjs'], RISK)
  const okPick = picked.length === 2 && picked[0] === 'scripts/a.mjs' && picked[1] === 'scripts/b.mjs'
  check(okPick, 'from 一份清单里挑出高风险项：去重且排序', picked.join('、'))
  report(okPick, '改动清单：挑得对')

  // 3) 冻结的验收标准：读得到、注释里不算、空块算未冻结。
  {
    const good = readDoneBlock(workRecord('C1: preflight 退出码 0', 'C2: selftest 全绿'))
    check(good.found && good.ids.size === 2 && good.broken.length === 0,
      '冻结块读得到两条标准', JSON.stringify([...good.ids.keys()]))
    report(good.found && good.ids.size === 2, '冻结标准：读得到')

    // **注释里的块不算**：模板与示例都写在注释里，它们是给人看的，不是记录。
    const inComment = readDoneBlock('<!--\n' + workRecord('C1: x') + '\n-->')
    check(inComment.found === false, '块写在 HTML 注释里 → 不算冻结', String(inComment.found))
    report(inComment.found === false, '冻结标准：注释里不算')

    // 有块但一条标准都没有 = 还没冻结，不是「通过」。
    const empty = readDoneBlock('## 目标与验收\n\n```' + DONE_FENCE + '\n```\n')
    check(empty.found && empty.ids.size === 0, '空块 → 有块但零条标准（未冻结）',
      JSON.stringify({ found: empty.found, n: empty.ids.size }))
    report(empty.found && empty.ids.size === 0, '冻结标准：空块算未冻结')

    // id 大小写不敏感：手写 c1 与 C1 是同一条。审查要按 id 回指，大小写不该成为陷阱。
    const lower = readDoneBlock(workRecord('c1: 小写写的'))
    check(lower.ids.has('C1'), '小写 id 归一成大写，查找不分大小写', JSON.stringify([...lower.ids.keys()]))
    report(lower.ids.has('C1'), '冻结标准：id 不分大小写')
  }

  // 3b) 审查块：只读 fail / inject / escalate，**没有 verdict**。
  {
    const one = readReviews([reviewComment(1, 'C2')])
    check(one.rounds.length === 1 && one.rounds[0].fail.join(',') === 'C2' && one.broken.length === 0,
      '一轮审查读得到 fail', JSON.stringify(one.rounds))
    report(one.rounds.length === 1, '审查块：读得到')

    // 同一轮出现两个不同的 fail 集合 → 机器判不了哪个作废，一律算格式错。
    const two = readReviews([reviewComment(1, 'C1'), reviewComment(1, 'C2')])
    check(two.broken.length > 0 && /两个不同的 fail 集合/.test(two.broken[0].why),
      '同一轮两个不同 fail 集合 → 格式错（要改口就删旧的那条）', JSON.stringify(two.broken.map((b) => b.why)))
    report(two.broken.length > 0, '审查块：同一轮一个说法')

    // 同一轮的两个说法完全相同时，不算冲突（重复发一条不该判红）。
    const same = readReviews([reviewComment(1, 'C1'), reviewComment(1, 'C1')])
    check(same.broken.length === 0 && same.rounds.length === 1, '同一轮两次说同一件事 → 不算冲突',
      JSON.stringify(same.rounds.length))
    report(same.broken.length === 0, '审查块：重复一致不算冲突')

    // 围栏被 `>` 引用的是别人的话，不是本评论的结论。
    const quoted = readReviews(['> ```' + REVIEW_FENCE + '\n> round: 1\n> fail: C1\n> ```'])
    check(quoted.rounds.length === 0, '被引用的块不算本评论的结论', JSON.stringify(quoted.rounds.length))
    report(quoted.rounds.length === 0, '审查块：引用不算')
  }

  // 3c) 结论由标准推导：**这是整套机制的枢纽**。
  {
    const ids = readDoneBlock(workRecord('C1: 第一', 'C2: 第二')).ids
    const out = (comments, opt = {}) => deriveOutcome({
      done: ids, rounds: readReviews(comments).rounds,
      reworkCap: opt.cap ?? 5, waived: opt.waived ?? false,
    })

    // 零轮：高风险改动没有审查记录，直接不成立。
    check(out([]).pass === false && /没有任何一轮/.test(out([]).why), '零轮 → 不通过', out([]).why)
    report(out([]).pass === false, '推导：零轮不通过')

    // 引用了清单里没有的标准 → 格式错。**审查不能发明标准。**
    const unknown = out([reviewComment(1, 'C99')])
    check(unknown.pass === false && /发明标准/.test(unknown.why), '未知 id → 拦下并说清「不能发明标准」', unknown.why)
    report(unknown.pass === false, '推导：不许发明标准')

    // fail 空 + 交了 inject → 通过。这是唯一的「通过」路径。
    const okOut = out([reviewComment(1, '')])
    check(okOut.pass === true, 'fail 空 + 有 inject → 通过', okOut.why)
    report(okOut.pass === true, '推导：通过')

    // fail 空但没交 inject → 不通过。「通过」必须交故障注入。
    const noInject = out([reviewComment(1, '', '')])
    check(noInject.pass === false && /故障注入/.test(noInject.why),
      'fail 空但没交 inject → 不通过（通过要交故障注入）', noInject.why)
    report(noInject.pass === false, '推导：通过要交故障注入')

    // 同一标准连续两轮 → 止损。这是抓「方向错了」的那条。
    const repeat = out([reviewComment(1, 'C1'), reviewComment(2, 'C1')])
    check(repeat.stopLoss === 'repeat', '同一标准连续两轮 → 止损', String(repeat.stopLoss))
    report(repeat.stopLoss === 'repeat', '推导：同标准连续两轮止损')

    // 同一标准隔一轮再出现 → **不**触发止损（否则正常的来回会被误停）。
    const apart = out([reviewComment(1, 'C1'), reviewComment(2, 'C2'), reviewComment(3, 'C1')])
    check(apart.stopLoss === null, '同标准隔一轮 → 不触发止损', String(apart.stopLoss))
    report(apart.stopLoss === null, '推导：隔轮不算止损')

    // 轮次超上限 → 止损 cap。
    const cap = out([reviewComment(1, 'C1'), reviewComment(2, 'C2'), reviewComment(3, 'C1')], { cap: 2 })
    check(cap.stopLoss === 'cap', '轮次超过上限 → 止损 cap', String(cap.stopLoss))
    report(cap.stopLoss === 'cap', '推导：超上限止损')

    // **豁免只免止损，不免「还有标准没过」**。这两条成对存在——
    // 少一条，就等于允许「带个标签就合」。
    const waivedFail = out([reviewComment(1, 'C1'), reviewComment(2, 'C1')], { waived: true })
    check(waivedFail.pass === false && /豁免不了/.test(waivedFail.why),
      '带豁免但最后一轮仍有标准没过 → 仍然不通过', waivedFail.why)
    report(waivedFail.pass === false, '推导：豁免不免标准没过')

    const waivedOk = out([reviewComment(1, 'C1'), reviewComment(2, 'C2'), reviewComment(3, '')],
      { cap: 2, waived: true })
    check(waivedOk.pass === true && /豁免/.test(waivedOk.why),
      '带豁免、最后一轮全过 → 通过，并在报告里说明豁免过', waivedOk.why)
    report(waivedOk.pass === true, '推导：豁免救止损')

    // escalate → 停自动返工交人。
    const esc = '```' + REVIEW_FENCE + '\nround: 1\nfail: C1\nescalate: 这条标准本身有问题\n```'
    const escOut = deriveOutcome({ done: ids, rounds: readReviews([esc]).rounds, reworkCap: 5, waived: false })
    check(escOut.pass === false && /交人/.test(escOut.why), 'escalate → 停自动返工、交人', escOut.why)
    report(escOut.pass === false, '推导：escalate 交人')
  }

  // 3d) 提案正文里那几行：工作记录指针、实现依据、关联问题。
  {
    check(readWorkRecordPointer('## 为什么\n\n工作记录: docs/work/a.md\n').path === 'docs/work/a.md',
      '工作记录指针读得到', '')
    check(readWorkRecordPointer('工作记录：`docs/work/b.md`').path === 'docs/work/b.md',
      '指针带反引号也读得到', '')
    check(readWorkRecordPointer('没有这一行').path === undefined, '没有指针 → undefined', '')
    report(readWorkRecordPointer('工作记录: x.md').path === 'x.md', '正文：工作记录指针')

    check(readBasis('## 实现依据\n\n无需设计文档：这是修一处判定笔误\n').ok === true,
      '实现依据写清了 → 通过', '')
    // **占位写法不认**：这几句共同的特征是「读者读完不知道改动凭什么成立」。
    const hollow = ['按 issue 实现', '按需求实现', '见 issue', '见需求', 'TBD', 'todo', '无', '同上', '略']
      .filter((v) => readBasis('## 实现依据\n\n' + v + '\n').ok === true)
    check(hollow.length === 0, '九种占位写法一个都不认', hollow.join('、'))
    report(hollow.length === 0, '正文：占位依据不认')
    check(readBasis('## 改了什么\n\nx').ok === false, '缺「## 实现依据」这一栏 → 不成立', '')
    report(readBasis('## 改了什么\n\nx').ok === false, '正文：缺栏目不成立')

    check(readClosingIssue('Closes #12') === '12' && readClosingIssue('Fixes #7') === '7'
      && readClosingIssue('resolve #3') === '3', '三种关联写法都认', '')
    check(readClosingIssue('没有关联') === undefined, '没有关联 → undefined', '')
    report(readClosingIssue('Fixes #1') === '1', '正文：关联问题')
  }

  // 3e) 协作参数从契约读：**这些是项目的决定，不是工具的默认值**。
  {
    const agents = ['## 协作参数', '', '| 参数 | 值 | 含义 |', '| --- | --- | --- |',
      '| `rework_cap` | 3 | x |', '| `waiver_label` | `pf:ok` | y |', ''].join('\n')
    const got = readProtocolParams(agents, { rework_cap: 2, waiver_label: 'z' })
    check(got.rework_cap === 3 && got.waiver_label === 'pf:ok',
      '参数表覆盖默认值', JSON.stringify(got))
    report(got.rework_cap === 3, '参数：从契约读')

    const fallback = readProtocolParams('', { rework_cap: 2, waiver_label: 'z' })
    check(fallback.rework_cap === 2 && fallback.waiver_label === 'z', '没有那张表 → 用默认值',
      JSON.stringify(fallback))
    report(fallback.rework_cap === 2, '参数：缺表用默认')

    // 占位行不该被当成取值——否则「还没填」会变成「上限是 <数字>」。
    const placeholder = readProtocolParams('## 协作参数\n\n| 参数 | 值 | 含义 |\n| --- | --- | --- |\n| `rework_cap` | `<数字>` | x |\n',
      { rework_cap: 2 })
    check(placeholder.rework_cap === 2, '占位值不当真 → 落回默认', String(placeholder.rework_cap))
    report(placeholder.rework_cap === 2, '参数：占位不生效')
  }

  // 3f) **机器契约逐字一致**：示例由脚本生成，落点必须逐字相同。
  //
  // **调判据本体，不复刻。**上一版这里自己写了一遍 `filter(...includes(...))` 循环——
  // 于是把 `preflight.mjs` 里那条判据改成 `() => true` 时，断言照样全绿。
  // 实例：`templateRegistrationIssues` 当初就是因为这个理由被抽成导出函数的，
  // 而契约比对这一条漏了，同一个文件里两种做法并存。
  {
    const real = contractSnippetIssues()
    check(Array.isArray(real) && real.length === 0,
      `契约示例在 ${CONTRACT_SITES.length + DONE_SITES.length} 处逐字一致`, JSON.stringify(real))
    report(real.length === 0, '契约：示例逐字一致')

    // **正向注入**：给一个「示例被改了一个字」的读法，判据必须报出来。
    // 反向用例比正向更重要——只有正向时，判据被削成永真也看不出来。
    const tampered = contractSnippetIssues({ reader: () => 'fail: WRONG（示例被改了）' })
    check(tampered.length > 0 && /不一致|缺失/.test(tampered[0]),
      '契约判据：喂一份被改过的落点 → 必须报出来', JSON.stringify(tampered.slice(0, 1)))
    report(tampered.length > 0, '契约：改过的落点会报')

    // 落点文件不存在时同样要报（不能因为「读不到」就当「一致」）。
    const absent = contractSnippetIssues({ reader: () => undefined })
    check(absent.length > 0 && /不存在/.test(absent[0]),
      '契约判据：落点文件不存在 → 必须报出来', JSON.stringify(absent.slice(0, 1)))
    report(absent.length > 0, '契约：缺落点会报')
  }

  // 4) 端到端：真的跑那个脚本。**每一条都对应一类必须防住的失败。**
  {
    const cli = (args, input) => spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review-record.mjs'), ...args],
      { encoding: 'utf8', input })
    const d = fixture('review-record', {})
    mkdirSync(join(d, 'docs', 'work'), { recursive: true })
    writeFileSync(join(d, 'AGENTS.md'), [
      '# 契约', '', '## 高风险路径', '', '| 路径 | 为什么 |', '| --- | --- |',
      '| `scripts/` | 判定逻辑 |', '', '## 协作参数', '', '| 参数 | 值 | 含义 |',
      '| --- | --- | --- |', '| `rework_cap` | 2 | x |', '| `waiver_label` | `pf:human-approved` | y |', '',
    ].join('\n'), 'utf8')
    const recRel = 'docs/work/2026-11-09-示例.md'
    writeFileSync(join(d, recRel), workRecord('C1: preflight 退出码 0', 'C2: selftest 全绿'), 'utf8')

    const bodyPath = join(d, 'body.md')
    const commentsPath = join(d, 'comments.md')
    const changedPath = join(d, 'changed.txt')
    const okBody = ['## 改了什么', '', 'x', '', '## 实现依据', '', '无需设计文档：修一处判定笔误', '',
      '工作记录: ' + recRel, '', '## 怎么验证的', '', '跑过了', ''].join('\n')
    writeFileSync(bodyPath, okBody, 'utf8')
    writeFileSync(changedPath, 'scripts/review-record.mjs\n' + recRel + '\n', 'utf8')
    writeFileSync(commentsPath, reviewComment(1, ''), 'utf8')

    const run = (extra = []) => cli(['--root', d, '--changed', changedPath, '--body', bodyPath,
      '--comments', commentsPath, '--expect-changes', ...extra])
    const label = (r) => `exit=${r.status} ${((r.stderr ?? '') + (r.stdout ?? '')).slice(0, 100)}`

    // 基准：全部成立 → 0。
    const base = run()
    check(base.status === 0, '端到端：冻结标准 + 审查通过 + 故障注入 → 退出码 0', label(base))
    report(base.status === 0, '端到端：通过')

    // 只改文档 → 不要求审查记录，且**明说**这一趟没查。
    const docOnly = cli(['--root', d, '--changed', '-', '--body', bodyPath, '--comments', commentsPath,
      '--expect-changes'], 'README.md\n')
    check(docOnly.status === 0 && /不落在高风险路径/.test(docOnly.stdout ?? ''),
      '只改文档 → 放行并明说不需要', label(docOnly))
    report(docOnly.status === 0, '端到端：低档免审')

    // 空清单 → 1。**「没算出来」不能读成「没动高风险路径」。**
    const emptyList = cli(['--root', d, '--changed', '-', '--body', bodyPath, '--comments', commentsPath,
      '--expect-changes'], '')
    check(emptyList.status === 1, '空改动清单 + --expect-changes → 退出码 1', label(emptyList))
    report(emptyList.status === 1, '端到端：空清单不放过')

    // 未知 id → 1。
    writeFileSync(commentsPath, reviewComment(1, 'C99'), 'utf8')
    const unknownRun = run()
    check(unknownRun.status === 1 && /发明标准/.test(unknownRun.stderr ?? ''), '未知 id → 退出码 1', label(unknownRun))
    report(unknownRun.status === 1, '端到端：未知 id 拦下')

    // 通过但没交故障注入 → 1。
    writeFileSync(commentsPath, reviewComment(1, '', ''), 'utf8')
    const noInject = run()
    check(noInject.status === 1 && /故障注入/.test(noInject.stderr ?? ''), '通过但无故障注入 → 退出码 1', label(noInject))
    report(noInject.status === 1, '端到端：通过要交注入')

    // 指针指向一个不在改动清单里的文件 → 1。**拿旧标准给新改动背书。**
    writeFileSync(commentsPath, reviewComment(1, ''), 'utf8')
    const stalePath = join(d, 'changed-stale.txt')
    writeFileSync(stalePath, 'scripts/review-record.mjs\n', 'utf8')
    const stale = cli(['--root', d, '--changed', stalePath, '--body', bodyPath,
      '--comments', commentsPath, '--expect-changes'])
    check(stale.status === 1 && /不在本次改动里/.test(stale.stderr ?? ''), '指针指向未改动文件 → 退出码 1', label(stale))
    report(stale.status === 1, '端到端：陈旧指针拦下')

    // 缺实现依据 → 1。
    writeFileSync(join(d, 'body-nobasis.md'),
      ['## 改了什么', '', 'x', '', '工作记录: ' + recRel, ''].join('\n'), 'utf8')
    const noBasis = cli(['--root', d, '--changed', changedPath, '--body', join(d, 'body-nobasis.md'),
      '--comments', commentsPath, '--expect-changes'])
    check(noBasis.status === 1 && /实现依据/.test(noBasis.stderr ?? ''), '缺实现依据 → 退出码 1', label(noBasis))
    report(noBasis.status === 1, '端到端：实现依据必填')

    // 没给 --comments → 1。**「没查」与「查过没问题」必须分得开。**
    const noComments = cli(['--root', d, '--changed', changedPath, '--body', bodyPath, '--expect-changes'])
    check(noComments.status === 1 && /未核对/.test(noComments.stderr ?? ''), '没给 --comments → 退出码 1', label(noComments))
    report(noComments.status === 1, '端到端：没核对不算通过')

    // 参数不全 → 2（用法错，不是判定错）。
    const misuse = cli(['--changed'], '')
    check(misuse.status === 2, '参数不全 → 退出码 2（用法错，与判定错分开）', label(misuse))
    report(misuse.status === 2, '端到端：用法错分开报')

    // 两种 stdin 同时用 → 2，并说清怎么改。
    const bothStdin = cli(['--changed', '-', '--body', '-'], '')
    check(bothStdin.status === 2 && /只能读一次/.test(bothStdin.stderr ?? ''), '两个 stdin 同用 → 退出码 2 并说明', label(bothStdin))
    report(bothStdin.status === 2, '端到端：双 stdin 报清楚')

    // **高风险表是骨架占位时**：明说「这一趟没查」，退出码 0（不卡死新项目）。
    const bare = fixture('review-record-bare', {})
    writeFileSync(join(bare, 'AGENTS.md'), '## 高风险路径\n\n| 路径 | 为什么 |\n| --- | --- |\n| `<替换成第一处>` | 占位 |\n', 'utf8')
    const bareRun = cli(['--root', bare, '--changed', '-', '--body', bodyPath, '--comments', commentsPath], 'README.md\n')
    check(bareRun.status === 0 && /没有做任何审查记录检查/.test(bareRun.stderr ?? ''),
      '高风险表还是占位 → 明说没查，退出码 0', label(bareRun))
    report(bareRun.status === 0, '端到端：空表明说没查')

    // 三种坏指针，**走真实 CLI**（不是复刻判据）。上面那条「陈旧指针」是其中之一，
    // 这里补齐另外两种：指针压根没写、指针指向的文件不存在。
    // 三条合起来才叫「三种坏指针都分得开」——少一条，那一类失败就没有东西看着。
    writeFileSync(join(d, 'body-noptr.md'),
      ['## 改了什么', '', 'x', '', '## 实现依据', '', '无需设计文档：修判定笔误', ''].join('\n'), 'utf8')
    const noPtr = cli(['--root', d, '--changed', changedPath, '--body', join(d, 'body-noptr.md'),
      '--comments', commentsPath, '--expect-changes'])
    check(noPtr.status === 1 && /缺少工作记录指针/.test(noPtr.stderr ?? ''), '提案里没有工作记录指针 → 退出码 1', label(noPtr))
    report(noPtr.status === 1, '端到端：缺指针拦下')

    writeFileSync(join(d, 'body-ghost.md'),
      ['## 改了什么', '', 'x', '', '## 实现依据', '', '无需设计文档：修判定笔误', '',
        '工作记录: docs/work/2026-11-09-不存在.md', ''].join('\n'), 'utf8')
    writeFileSync(join(d, 'changed-ghost.txt'), 'scripts/review-record.mjs\ndocs/work/2026-11-09-不存在.md\n', 'utf8')
    const ghost = cli(['--root', d, '--changed', join(d, 'changed-ghost.txt'), '--body', join(d, 'body-ghost.md'),
      '--comments', commentsPath, '--expect-changes'])
    check(ghost.status === 1 && /工作记录不存在/.test(ghost.stderr ?? ''), '指针指向不存在的文件 → 退出码 1', label(ghost))
    report(ghost.status === 1, '端到端：幽灵指针拦下')

    // 工作记录存在、但里面没有冻结的标准 → 也是 1。这一条最容易被漏：
    // 文件在、指针对，但那个块没写，验收标准就无从核对。
    writeFileSync(join(d, 'docs/work/2026-11-09-空.md'), '# 工作记录\n\n## 目标与验收\n\n还没冻结。\n', 'utf8')
    writeFileSync(join(d, 'body-empty-rec.md'),
      ['## 改了什么', '', 'x', '', '## 实现依据', '', '无需设计文档：修判定笔误', '',
        '工作记录: docs/work/2026-11-09-空.md', ''].join('\n'), 'utf8')
    writeFileSync(join(d, 'changed-empty-rec.txt'),
      'scripts/review-record.mjs\ndocs/work/2026-11-09-空.md\n', 'utf8')
    const noDone = cli(['--root', d, '--changed', join(d, 'changed-empty-rec.txt'),
      '--body', join(d, 'body-empty-rec.md'), '--comments', commentsPath, '--expect-changes'])
    check(noDone.status === 1 && /没有冻结的验收标准/.test(noDone.stderr ?? ''),
      '工作记录里没有冻结的 `pf-done` 块 → 退出码 1', label(noDone))
    report(noDone.status === 1, '端到端：没冻结标准拦下')
  }

  // 5) **判据本体必须被直接调用，不能复刻。**
  //
  // 这一组治的是最隐蔽的一类缺口：断言自己写了一遍「和判据相同的循环」，
  // 于是把判据削成永假时断言照样全绿——「判据坏了」没有任何东西看着。
  // 实测过：三处判据被改成永假，五个分片仍全绿。
  //
  // 判据必须导出成纯函数，断言直接调它。这样「判据被削弱」与「数据不对」是同一件事，
  // 都会让断言变红。
  {
    // 模板登记：给它一份「多了一个未登记文件」的清单，它必须报出来。
    const undeclared = templateRegistrationIssues({ files: ['contributing.md', 'zzz-新模板.md'] })
    check(undeclared.length > 0 && /没登记落点/.test(undeclared[0]),
      '模板登记判据：注入一个未登记的文件 → 必须报出来', JSON.stringify(undeclared))
    report(undeclared.length > 0, '判据本体：模板登记会报')

    // 反向：真实仓库那份必须是干净的（否则这条断言恒真、什么也没测）。
    const real = templateRegistrationIssues()
    check(Array.isArray(real) && real.length === 0, '模板登记判据：真实仓库当前是干净的',
      JSON.stringify(real))
    report(real.length === 0, '判据本体：真实仓库干净')

    // 幻影条目：登记了不存在的模板，同样要报。
    const phantom = templateRegistrationIssues({ files: [] })
    check(phantom.length > 0, '模板登记判据：登记了不存在的模板 → 必须报出来',
      JSON.stringify(phantom))
    report(phantom.length > 0, '判据本体：幻影条目会报')
  }

}

// ---- 分片收尾 ----
// 主入口靠这一行读计数。格式固定：`行为自检：N 项通过，M 项失败`。
// 不输出它，主入口会判「这片没跑完」并以退出码 2 中止——读不到计数不能当 0。
try { cleanupFixtures() } catch { /* 清不掉不算错，主入口兜底 */ }
process.stdout.write(`行为自检：${passed} 项通过，${failed} 项失败\n`)
if (failures.length > 0) {
  process.stdout.write('\n失败项：\n')
  for (const f of failures) process.stdout.write(`  - ${f}\n`)
}
process.exitCode = failed === 0 ? 0 : 1
