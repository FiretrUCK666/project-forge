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
