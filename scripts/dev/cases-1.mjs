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

// ── [42] 高危四条：入口判定、徽章三态、围栏感知、锚点权威期望 ─────────────────
// 这一组是回归网：每条断言都要能被单独证伪。

group('[42] 高危四条：入口判定、徽章三态、围栏感知、锚点权威期望')
{
  // ── P1：入口判定按真实路径（junction / 符号链接下不许静默空跑） ──
  //
  // 判据必须按**真实路径**比：字面比较 argv[1] 与 import.meta.url 时，经 junction 或
  // 符号链接调用永不相等，脚本什么都不做并返回 0——那是「自检假绿」，CI 与人都会读成通过。
  {
    // 链接指向**技能根**：要测的是「经链接调用本脚本」，不是链接一个空 fixture。
    const linkDir = join(ROOT, 'mainmod-link')
    try {
      symlinkSync(SKILL_ROOT, linkDir, 'junction')
    } catch { /* 本机不许建链接就跳过下面的链接断言 */ }
    if (existsSync(join(linkDir, 'scripts', 'survey.mjs'))) {
      const realFile = join(SKILL_ROOT, 'scripts', 'survey.mjs')
      const metaUrl = pathToFileURL(realFile).href
      check(isMainModule(metaUrl, realFile) === true, '字面路径：判定为直接执行')
      check(isMainModule(metaUrl, join(linkDir, 'scripts', 'survey.mjs')) === true,
        '经 junction 调用：仍判定为直接执行（真实路径归一）', join(linkDir, 'scripts', 'survey.mjs'))
      check(isMainModule(metaUrl, join(SKILL_ROOT, 'scripts', 'dev', 'preflight.mjs')) === false, '别的文件：判定为被 import')
      const viaLink = spawnSync(process.execPath, [join(linkDir, 'scripts', 'survey.mjs'), SKILL_ROOT, '--markdown'],
        { encoding: 'utf8' })
      const okLink = (viaLink.stdout ?? '').includes('勘察结果')
      check(okLink, '经 junction 调用 survey：有输出、不静默空跑', JSON.stringify((viaLink.stdout ?? '').slice(0, 40)))
      report(okLink, 'P1 入口判定：链接下不退化成空跑')
    } else {
      skipGroup('[42] 入口判定的链接断言', '本机不支持创建目录链接')
    }
  }

  // ── P2：徽章结论按「结论行 + 退出码」判，崩溃 / 未查完一律不读成通过 ──
  {
    const crash = badgeVerdict('C:\\x\\README.md：找到 1 个徽章\n', 'TypeError: terminated\n', 1)
    check(crash.state === 'unverified', '子进程崩溃（无结论行）→ unverified，不读成 ok', crash.state)
    check(badgeVerdict('check-badges: state=ok checked=1 bad=0 unverified=0\n', '', 0).state === 'ok', '结论行 ok + 退出码 0 → ok')
    check(badgeVerdict('check-badges: state=bad checked=1 bad=1 unverified=0\n', '', 1).state === 'bad', '结论行 bad + 退出码 1 → bad')
    check(badgeVerdict('check-badges: state=nobadge checked=0 bad=0 unverified=0\n', '', 0).state === 'nobadge', '没有徽章 → nobadge')
    const mismatch = badgeVerdict('check-badges: state=ok checked=1 bad=0 unverified=0\n', '', 1)
    check(mismatch.state === 'unverified', '结论行与退出码不一致 → unverified（两处证据必须同向）', mismatch.state)
    report(crash.state === 'unverified', 'P2 徽章裁决：崩溃不再落进「可显示」')

    // 端到端：徽章地址连不上（端口 9 拒绝连接）→ 检查未完成，退出码 3
    const badgeDir = fixture('badge-unreached', {
      'README.md': '# x\n\n![b](http://127.0.0.1:9/img.shields.io/badge.svg)\n',
    })
    const cb = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'check-badges.mjs'), join(badgeDir, 'README.md')],
      { encoding: 'utf8' })
    check(cb.status === 3 && /state=unverified/.test(cb.stdout ?? ''),
      '连不上时：退出码 3 且结论行写 unverified', 'exit=' + cb.status)
    report(cb.status === 3, 'P2 端到端：没查完 → 退出码 3')
  }

  // ── P3：目录识别感知代码围栏（不再插进代码块、不删闭合行） ──
  {
    const sync = (file, ...extra) => spawnSync(process.execPath,
      [join(SCRIPTS_DIR, 'sync-toc.mjs'), file, ...extra], { encoding: 'utf8' })
    const fenced = fixture('toc-fenced-takeover', {
      'README.md': '# 项目\n\n用法示例：\n\n```md\n## 目录\n```\n\n## 一\n\n## 二\n\n## 三\n\n## 四\n\n## 五\n',
    })
    const p = join(fenced, 'README.md')
    sync(p)
    const out = readFileSync(p, 'utf8')
    const beforeFence = out.slice(0, out.indexOf('## 一'))
    check(beforeFence.includes('```md') && beforeFence.includes('```\n\n## 目录'),
      '目录插在围栏之外（围栏内那行仍是代码）', JSON.stringify(beforeFence.slice(-40)))
    check((out.match(/```/g) ?? []).length >= 2, '围栏闭合行没被吃掉（成对出现）')
    report(out.includes('## 目录') && beforeFence.indexOf('<!-- toc:start -->') > beforeFence.lastIndexOf('```'),
      'P3 围栏感知：目录在围栏闭合之后')

    // 损坏态（标记落在围栏内）→ 拒绝写入 + --check 必须红
    const damaged = fixture('toc-damaged-markers', {
      'README.md': '# x\n\n```md\n<!-- toc:start -->\n\n- [一](#一)\n\n<!-- toc:end -->\n```\n\n## 一\n\n## 二\n\n## 三\n\n## 四\n\n## 五\n',
    })
    const dp = join(damaged, 'README.md')
    const before = readFileSync(dp, 'utf8')
    const r1 = sync(dp)
    const r2 = sync(dp, '--check')
    check(r1.status === 2 && readFileSync(dp, 'utf8') === before,
      '标记落在围栏内：拒绝写入且文件一个字节没动', 'exit=' + r1.status)
    check(r2.status !== 0, '同一状态 --check 必须红（不能读成「已是当前状态」）', 'exit=' + r2.status)
    report(r1.status === 2 && r2.status !== 0, 'P3 损坏态：拒绝写 + --check 红')
  }

  // ── P4：锚点以**权威实现**的期望值为准 ──
  //
  // 这些期望值是拿真实 github-slugger@2 对同一批标题跑出来的结果抄进来的，
  // 不是「照本实现抄一遍」——那样等于自证式测试。
  {
    const cases = [
      ['A   B', 'a---b'],
      ['A B', 'a-b'],
      ['1. 局域网访问', '1-局域网访问'],
      ['一　二', '一二'],
      ['说明①', '说明'],
      ['第一步⑴', '第一步'],
      ['snake_case 与 README_CN.md', 'snake_case-与-readme_cnmd'],
      ['a__b 词内双下划线', 'a__b-词内双下划线'],
      ['~~删除线~~ 标题', '删除线-标题'],
      ['a_b_c', 'a_b_c'],
      [`${FAKE_EMOJI} 部署`, '-部署'],
      ['中文，标点：测试', '中文标点测试'],
      ['Node.js 20.x 支持', 'nodejs-20x-支持'],
      ['v1.2.3 发布', 'v123-发布'],
      ['ＦＵＬＬ　ＷＩＤＴＨ', 'ｆｕｌｌｗｉｄｔｈ'],
      ['_强调_ 标题', '强调-标题'],
      ['[引用式][ref] 标题', '引用式-标题'],
      ['<https://example.com/x> 链接', 'httpsexamplecomx-链接'],
    ]
    const md = '# 标题\n\n' + cases.map(([t]) => `## ${t}\n`).join('\n')
    const dir = fixture('toc-anchors', { 'README.md': md })
    const p = join(dir, 'README.md')
    spawnSync(process.execPath, [join(SCRIPTS_DIR, 'sync-toc.mjs'), p], { encoding: 'utf8' })
    const generated = readFileSync(p, 'utf8')
    const ids = []
    for (const line of generated.split('\n')) {
      const m = /^- \[(.*)\]\(#(.*)\)$/.exec(line.trim())
      if (m !== null) ids.push(m[2])
    }
    const diffs = []
    let same = ids.length === cases.length
    for (let i = 0; i < cases.length; i += 1) {
      if (ids[i] !== cases[i][1]) {
        same = false
        diffs.push(`${cases[i][0]} → ${ids[i]}（权威期望 ${cases[i][1]}）`)
      }
    }
    check(same, '锚点逐条与 github-slugger@2 的期望一致', diffs.join('；'))
    report(same, `P4 锚点：${cases.length} 条与权威实现一致`)
  }

  // ── N1：凭据按分案分档（未跟踪且已忽略的正常形态不拦） ──
  {
    const tracked = tierSecrets([{ path: 'a', tracked: true }])
    const safe = tierSecrets([{ path: 'b', tracked: false, ignored: true }])
    const exposed = tierSecrets([{ path: 'c', tracked: false, ignored: false }])
    const unknown = tierSecrets([{ path: 'd' }])
    check(tracked.blocking.length === 1 && safe.blocking.length === 0
      && exposed.blocking.length === 1 && unknown.blocking.length === 1,
      '分档：已跟踪 / 未忽略都拦，未跟踪且已忽略放行',
      JSON.stringify({ tracked: tracked.blocking.length, safe: safe.blocking.length, exposed: exposed.blocking.length }))
    report(safe.blocking.length === 0, 'N1 密钥分档：.gitignore 里的 .env 不再永久报缺')

    if (HAS_GIT) {
      const dir = fixture('secret-ignored', {
        '.gitignore': '.env\n',
        '.env': `K="ghp_${'d'.repeat(36)}"\n`,
        'README.md': '# x\n',
      })
      spawnSync('git', ['init', '-q'], { cwd: dir })
      const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir, '--no-bilingual', '--no-contributing',
        '--private-no-license', '--no-ci'], { encoding: 'utf8' })
      const out = r.stdout ?? ''
      const hits = out.split('\n').filter((l) => /凭据/.test(l)).join(' / ')
      check(!/\[缺\] 凭据形状/.test(out), '未跟踪且已忽略的 .env：不报凭据缺', hits)
      report(!/\[缺\] 凭据形状/.test(out), 'N1 端到端：已忽略的 .env 安静')
    } else {
      skipGroup('[42] 已忽略凭据的端到端断言', '环境里没有 git')
    }
  }

  // ── P5：待填写标记只有一处实现（单行与多行判据必须一致） ──
  {
    const dir = fixture('authors-onepass', {
      'package.json': '{"name":"a","version":"1.0.0","scripts":{"test":"x"}}\n',
    })
    compose(dir)
    const p = join(dir, 'AGENTS.md')
    writeFileSync(p, readFileSync(p, 'utf8')
      .replace(/<!--\s*pf:author:\s*([\s\S]*?)-->/g, (m, note) => `<!-- pf:author:\n${note.trim()} -->`), 'utf8')
    const multi = authorMarkers(readFileSync(p, 'utf8')).length
    const st = compose(dir, '--status')
    const composeCount = Number((/待填写 (\d+) 处/.exec(st.stdout ?? '') ?? [])[1] ?? -1)
    const rv = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir], { encoding: 'utf8' })
    const reviewCount = Number((/AGENTS\.md 待填写 (\d+) 处/.exec(rv.stdout ?? '') ?? [])[1] ?? -1)
    check(multi > 0 && composeCount === multi && reviewCount === multi,
      '多行标记：compose 与 review 数出同一个数（一处实现）',
      JSON.stringify({ multi, composeCount, reviewCount }))
    report(composeCount === multi && reviewCount === multi, 'P5 待填写计数：两处同源')
  }

  // ── P6：CONTRIBUTING 内容判据语言无关（合格英文版不许被判缺） ──
  {
    const dir = fixture('contributing-en', {
      'README.md': '# demo\n',
      'LICENSE': 'MIT\n',
      'package.json': '{"name":"demo","version":"1.0.0","scripts":{"verify":"node --test"}}\n',
      'CONTRIBUTING.md': '# Contributing\n\nThanks for your interest.\n\n'
        + '## Questions and feedback\n\nFor questions, open an issue or start a discussion.\n\n'
        + '## Before you start\n\nFork the repository, then create a branch named `feat/topic` from `main`.\n\n'
        + '## Running the checks\n\nInstall dependencies with `npm ci`, then run:\n\n'
        + '```sh\nnpm run verify\n```\n\nAll checks must be green.\n\n'
        + '## License\n\nBy contributing you agree that your work is released under the license in `LICENSE`.\n',
    })
    const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'review.mjs'), dir, '--no-bilingual', '--no-ci',
      '--secrets-reviewed'], { encoding: 'utf8' })
    const bad = (r.stdout ?? '').split('\n').filter((l) => /\[缺\] CONTRIBUTING/.test(l))
    check(bad.length === 0, '英文 CONTRIBUTING 不再被判缺', bad.join(' / '))
    report(bad.length === 0, 'P6 语言无关：英文版不被误判')
  }

  // ── P7：扫描未覆盖范围必须报出来（超体积文件不再静默） ──
  {
    const bigDir = fixture('scan-oversize', { 'README.md': '# x\n' })
    writeFileSync(join(bigDir, 'big.txt'), 'x'.repeat(2 * 1024 * 1024 + 64) + `\nK="ghp_${'e'.repeat(36)}"\n`, 'utf8')
    const s = survey(bigDir)
    const scan = s.risks?.contentScan ?? {}
    check((scan.skippedLarge ?? 0) >= 1, '超单文件上限的文件被计数（不再是静默跳过）', JSON.stringify(scan))
    report((scan.skippedLarge ?? 0) >= 1, 'P7 超体积：计数进报告')
  }

  // ── P8：门禁消费全部风险类别（新增类别自动进闸门） ──
  {
    const unhandled = unhandledRiskKeys({ secretFiles: [], contentScan: {}, futureRisk: 1 })
    check(unhandled.length === 1 && unhandled[0] === 'futureRisk',
      '勘察新增的风险类别会被点名为「未处理」，不会沉默', JSON.stringify(unhandled))
    report(unhandled.length === 1, 'P8 风险类别：加了字段就必须落结论')
  }

  // ── P9：嵌套产物目录（monorepo）不被漏掉 ──
  {
    if (HAS_GIT) {
      const dir = fixture('nested-outdir', {
        'packages/a/package.json': '{"name":"a","version":"1.0.0"}\n',
        'packages/a/dist/bundle.js': 'x\n',
        'packages/b/package.json': '{"name":"b","version":"1.0.0"}\n',
        'packages/b/dist/bundle.js': 'x\n',
        'dist/root.js': 'x\n',
        'README.md': '# x\n',
      })
      spawnSync('git', ['init', '-q'], { cwd: dir })
      const notIgnored = survey(dir).ignores?.unignoredOutputDirs ?? []
      const nested = notIgnored.filter((d) => /packages[/\\][ab][/\\]dist/.test(d))
      check(nested.length === 2, '两层的 packages/*/dist 都被报出来（不再只报顶层）', JSON.stringify(notIgnored))
      report(nested.length === 2, 'P9 嵌套产物目录：全深度')

      const single = fixture('single-outdir', { 'dist/a.js': 'x\n', 'README.md': '# x\n' })
      spawnSync('git', ['init', '-q'], { cwd: single })
      const one = survey(single).ignores?.unignoredOutputDirs ?? []
      check(one.includes('dist') && one.length === 1, '单包项目只报一个顶层产物目录', JSON.stringify(one))
      report(one.length === 1, 'P9 反例：单包不误报')
    } else {
      skipGroup('[42] 嵌套产物目录', '环境里没有 git')
    }
  }

  // ── P11 / P12：帮助开关与畸形清单（两条都防崩溃或静默错判） ──
  {
    const help = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), '-h'], { encoding: 'utf8' })
    const okHelp = help.status === 0 && /用法：/.test(help.stdout ?? '')
    check(okHelp, '`-h` 给用法（防被当成目录名而报「目录不存在」）', 'exit=' + help.status)
    report(okHelp, 'P11 -h：给用法而不是报目录不存在')

    const nullPkg = fixture('null-manifest', { 'package.json': 'null\n' })
    const r = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), nullPkg, '--json'], { encoding: 'utf8' })
    const okNull = r.status === 0
    check(okNull, 'package.json 内容为 null 不再让勘察崩掉（清单形状统一归一）',
      (r.stderr ?? '').split('\n')[0])
    report(okNull, 'P12 畸形清单：不崩')
  }

  // ── P10：带点的仓库名不许被截断（仓库边界识别只有一处实现） ──
  {
    const cases = [
      ['https://github.com/acme/my.repo.git', 'acme/my.repo'],
      ['git@github.com:acme/my.repo.git', 'acme/my.repo'],
      ['https://github.com/acme/plain', 'acme/plain'],
      ['https://GitHub.com/acme/Plain.git', 'acme/Plain'],
      ['https://gitlab.com/a/b.git', undefined],
      ['https://github.com/acme', undefined],
    ]
    const diffs = []
    for (const [url, want] of cases) {
      const got = parseGitHubRepo(url)
      if (got !== want) diffs.push(`${url} → ${got}（期望 ${want}）`)
    }
    check(diffs.length === 0, 'owner/name 解析与期望一致（含带点仓库名）', diffs.join('；'))
    report(diffs.length === 0, 'P10 仓库边界：带点名字不截断')
  }
}


group('[30] 事实采全与门禁诚实：tracked/远端/发布链/截断/strict')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

  // 敏感文件名带 tracked 比特（无仓库时为尚未跟踪，不断言真值只断言形状）
  {
    const dir = fixture('facts-secretfile', { '.env': 'x=1\n', 'README.md': '# x\n' })
    const hits = survey(dir).risks?.secretFiles ?? []
    const ok = Array.isArray(hits) && hits.length > 0
      && hits.every((h) => typeof h.path === 'string' && typeof h.tracked === 'boolean')
      // 两个比特都要在：tracked 决定「能不能从这次提交排除」，ignored 决定
      // 「进不进版本库」。缺一个，门禁就只能一律报缺。
      && hits.every((h) => typeof h.ignored === 'boolean')
    check(ok, 'secretFiles 带 path/tracked（分案首问可答）', JSON.stringify(hits.slice(0, 2)))
    report(ok, 'secretFiles：形状正确')
  }

  // Obsidian 发布链：含 minAppVersion 即有可发布身份、版本号与下限
  {
    const dir = fixture('facts-obsidian', {
      'manifest.json': JSON.stringify({
        id: 'my-plugin', name: 'My Plugin', version: '1.2.3', minAppVersion: '1.0.0',
        description: 'd', author: 'a', isDesktopOnly: false,
      }),
      'main.js': 'module.exports = {}\n',
    })
    const s = survey(dir)
    const ok = (s.ecosystem?.kinds ?? []).includes('obsidian-plugin')
      && s.artifacts?.publishableManifest?.ecosystem === 'obsidian'
      && s.artifacts?.declaredVersion === '1.2.3'
      && (s.artifacts?.runtimeRequirements ?? []).some((r) => r.runtime === 'obsidian')
    check(ok, 'Obsidian 有发布身份/版本/下限', JSON.stringify(s.artifacts?.publishableManifest))
    report(ok, 'Obsidian：发布链不断')

    const pwa = fixture('facts-pwa', {
      'manifest.json': JSON.stringify({ name: 'App', short_name: 'App', start_url: '/' }),
      'index.html': '<html></html>\n',
    })
    const sp = survey(pwa)
    const okPwa = !(sp.ecosystem?.kinds ?? []).includes('obsidian-plugin')
      && sp.artifacts?.publishableManifest === undefined
    check(okPwa, 'PWA 同名文件不进发布链', JSON.stringify(sp.ecosystem?.kinds))
    report(okPwa, 'PWA：不误判发布身份')
  }

  // 工作流超 64KB 置 truncated，不把“没看到”当“没有”
  {
    const big = `# pad\n${'x'.repeat(70000)}\ngh release create\n`
    const dir = fixture('facts-bigwf', {
      'package.json': '{"name":"w","version":"1.0.0"}\n',
      '.github/workflows/release.yml': `name: release\non: [push]\njobs:\n  r:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n${big}`,
    })
    const auto = survey(dir).docs?.workflowAutomation
    const ok = auto?.truncated === true
    check(ok, '大工作流标 truncated', JSON.stringify({ truncated: auto?.truncated }))
    report(ok, '工作流截断：诚实')
  }

  // 双非默认 README 同样成对（缺默认需标出）
  {
    const dir = fixture('facts-bipair', {
      'README.zh-CN.md': '# 中文\n',
      'README.en.md': '# English\n',
      'src/a.js': 'export const a=1\n',
    })
    const pair = survey(dir).docs?.readmePair
    const ok = pair !== undefined && pair.defaultMissing === true
    check(ok, '双非默认成对并标 defaultMissing', JSON.stringify(pair))
    report(ok, '双语：双非默认不漏')
  }

  // --strict：仅剩待问时默认放行、严格拦住
  {
    const contrib = '# C\n\n## 提问与反馈\n到 Issue 区。\n\n## 报告缺陷\n四件事。\n\n'
      + '## 提出改动\n先 fork，在分支上开发，门禁全绿开请求。不推主干，不打标签，不发布。\n\n'
      + '## 开发环境\n用 pnpm 安装依赖。\n\n## 提交前门禁\n跑构建测试，全绿。\n\n'
      + '## 硬性规范\n完整规范以 AGENTS.md 为准。\n\n## 提交信息\n一句话。\n\n## 许可\n见 LICENSE。\n'
    const dir = fixture('facts-strict', {
      'package.json': JSON.stringify({ name: 't', version: '1.0.0', private: true, scripts: { test: 'x' } }),
      'README.md': '# t\n',
      'LICENSE': 'MIT\n',
      'CONTRIBUTING.md': contrib,
      '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
    })
    // 用脚本生成合法 AGENTS 并填实，使“仅剩双语待问”精确成立
    compose(dir)
    const apath = join(dir, 'AGENTS.md')
    writeFileSync(apath, readFileSync(apath, 'utf8')
      .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写）'), 'utf8')
    const r1 = review(dir)
    const ok1 = r1.status === 0 && /\[待问\]/.test(r1.stdout ?? '')
    check(ok1, '仅剩待问时默认 exit 0 但有待问', `exit=${r1.status}`)
    report(ok1, '默认：待问不拦但明示')
    const r2 = review(dir, '--strict')
    const ok2 = r2.status === 2 && /\[待问\]/.test(r2.stdout ?? '')
    check(ok2, '--strict 下待问 exit 2', `exit=${r2.status}`)
    report(ok2, '严格：待问拦得住')
  }

  if (!HAS_GIT) {
    skipGroup('[30] git 相关事实（远端/署名历史/标签对齐/上游）', '环境里没有 git')
  } else {
    // 远端全地址 + 历史署名（全局配置走临时文件，不碰本机真实全局配置）
    const dir = fixture('facts-git', { 'README.md': '# x\n' })
    for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.invalid/r.git'],
      ['remote', 'add', 'fork', 'https://example.invalid/f.git'],
      ['config', 'user.name', 'T'], ['config', 'user.email', 't@e.com']]) {
      spawnSync('git', args, { cwd: dir })
    }
    spawnSync('git', ['add', '-A'], { cwd: dir })
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
    writeFileSync(join(dir, 'fake-global-gitconfig'), '[user]\n\tname = G\n\temail = g@e.com\n', 'utf8')
    const prevGlobal = process.env.GIT_CONFIG_GLOBAL
    const prevNoSys = process.env.GIT_CONFIG_NOSYSTEM
    process.env.GIT_CONFIG_GLOBAL = join(dir, 'fake-global-gitconfig')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    let g = {}
    try {
      g = survey(dir).git ?? {}
    } finally {
      if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prevGlobal
      if (prevNoSys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
      else process.env.GIT_CONFIG_NOSYSTEM = prevNoSys
    }
    const okUrl = g.remoteUrls?.origin === 'https://example.invalid/r.git'
      && g.remoteUrls?.fork === 'https://example.invalid/f.git'
    check(okUrl, '远端全地址可查（fork 比对有米）', JSON.stringify(g.remoteUrls))
    report(okUrl, '远端：全地址')
    const okMail = g.identity?.globalEmail === 'g@e.com'
    check(okMail, '全局邮箱可查', String(g.identity?.globalEmail))
    report(okMail, '署名：全局邮箱')

    // 标签与版本号未对齐 → 事实 false，review 报待问
    const ver = fixture('facts-ver', {
      'package.json': JSON.stringify({ name: 'v', version: '1.2.3' }),
      'README.md': '# v\n',
    })
    for (const args of [['init', '-q'], ['config', 'user.name', 'T'], ['config', 'user.email', 't@e.com']]) {
      spawnSync('git', args, { cwd: ver })
    }
    spawnSync('git', ['add', '-A'], { cwd: ver })
    spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: ver })
    spawnSync('git', ['tag', 'v9.9.9'], { cwd: ver })
    const va = survey(ver).artifacts ?? {}
    const okVa = va.versionAligned === false
    check(okVa, '标签版本不一致判 false（不编造对齐）', String(va.versionAligned))
    report(okVa, '版本对齐：事实比对')
  }
}


// 这一组守的是「痕迹判定从猜变成查」。
//
// 在此之前，判断「这段是不是本 skill 写的」靠形状——而形状必然两头都错：
// Vue 的 `{{ title }}` 被误判（照做就是删使用者的代码），`<安装命令>` 被漏判
// （空壳工作流报成干净）。账本把「来历」变成记录：落盘时写下字节哈希，此后只比对。
group('[51c] 账本：痕迹判定查哈希，不再猜形状')
{
  const dir = fixture('ledger-basic', {
    'package.json': '{"name":"led","version":"1.0.0"}\n',
  })
  compose(dir)

  // 正例一：落盘之后账本必须存在，且记了内核区与受管节。
  const ledgerFile = join(dir, '.project-forge', 'ledger.json')
  check(existsSync(ledgerFile), '落盘后账本存在（此后判定有依据，不用猜）')
  report(existsSync(ledgerFile), '账本：落盘即记账')

  let led = {}
  if (existsSync(ledgerFile)) led = JSON.parse(readFileSync(ledgerFile, 'utf8'))
  const ids = Object.keys(led.segments?.['AGENTS.md'] ?? {})
  check(ids.includes('kernel'), '内核区按字节区间单独记一条', ids.slice(0, 4).join('、'))
  report(ids.includes('kernel'), '账本：内核区成段记')
  check(ids.some((i) => i.startsWith('section:')), '受管节按节分别记（整份记会让使用者改一个字就全失效）')
  report(ids.some((i) => i.startsWith('section:')), '账本：受管节分记')

  // 正例二：handoff 用账本确认「这一段是我写的」。
  const scanOut = handoffJson(dir, '--scan')
  const mine = (scanOut.groups?.ledger ?? []).filter((f) => f.kind === 'ledger-mine')
  check(mine.length > 0, '交棒时账本确认识别出自己的片段（这是「查」出来的，不是猜的）',
    `ledger-mine ${mine.length} 条`)
  report(mine.length > 0, '账本：确认自己的片段')

  // 正例三：使用者改过的节必须报「改过」，不能报「是我的」——
  // 报成「是我的」意味着撤除时会把使用者改过的内容一起删掉。
  const agents = join(dir, 'AGENTS.md')
  const edited = readFileSync(agents, 'utf8')
    .replace(/## 硬性规范(\r?\n)/, '## 硬性规范$1\n使用者补充的一行。\n')
  writeFileSync(agents, edited, 'utf8')
  const editedScan = handoffJson(dir, '--scan')
  const editedHits = (editedScan.groups?.ledger ?? []).filter((f) => f.kind === 'ledger-edited')
  check(editedHits.length > 0, '使用者改过的节报「改过」（撤除时会停下来问人，不会删掉他的字）',
    `ledger-edited ${editedHits.length} 条`)
  report(editedHits.length > 0, '账本：改过的一节被判为改过')

  // 正例四：使用者删掉的节报「不见了」，不能当成「没写过」重新插一遍。
  const gone = edited.replace(/(?:\r?\n)## 文档同步[\s\S]*?(?=\r?\n## |$)/, '')
  writeFileSync(agents, gone, 'utf8')
  const goneScan = handoffJson(dir, '--scan')
  const goneHits = (goneScan.groups?.ledger ?? []).filter((f) => f.kind === 'ledger-gone')
  check(goneHits.length > 0, '使用者删掉的节报「不见了」（不自动补回去，否则他的删除被撤销）',
    `ledger-gone ${goneHits.length} 条`)
  report(goneHits.length > 0, '账本：删掉的节报不见了')

  // ── 勘察不许联网 ──
  //
  // 曾经默认跑 `git ls-remote` 探远端可达性。网络受限的机器上一次要等 **21 秒**
  // （连接超时），而勘察本身不到一秒——一件「偶尔想知道」的事变成了每次调用都要付的
  // 代价，比它换来的信息贵得多。
  //
  // 判据是「不联网」，所以断言看的是**结果**：默认调用里网络那一档必须是「没有探测」，
  // 且整个 JSON 里不能出现 reachable/unreachable。
  {
    const dir = fixture('survey-no-network', {
      'package.json': '{"name":"n","version":"1.0.0"}\n',
    })
    if (HAS_GIT) {
      gitIn(dir, 'init')
      gitIn(dir, 'remote', 'add', 'origin', 'https://example.invalid/x.git')
    }
    const s = survey(dir)
    const net = s.git?.auth?.network
    check(net === 'undetermined' || net === 'n/a',
      '默认勘察不联网：网络那一档是「未探测」，不是去连一次', `得到 ${net}`)
    report(net === 'undetermined' || net === 'n/a', '勘察：默认不联网')
    check(String(s.git?.auth?.networkReason ?? '').includes('没有探测'),
      '并且说清「没有探测」，不让人以为探测过且通了',
      String(s.git?.auth?.networkReason ?? ''))
    report(String(s.git?.auth?.networkReason ?? '').includes('没有探测'), '勘察：说明没探测')
  }

  // 反例：完全没有账本的项目，不能因此误报。
  // 账本缺失是正常状态（老项目、被清理过），此时只应退化成「什么都不认」。
  const noLedger = fixture('ledger-absent', {
    'package.json': '{"name":"nl","version":"1.0.0"}\n',
    'AGENTS.md': '# 我自己写的\n\n## 构建与验证\n\n跑 make check。\n',
  })
  const nlScan = handoffJson(noLedger, '--scan')
  const nlHits = nlScan.groups?.ledger ?? []
  check(nlHits.length === 0, '反例：没有账本时不虚报任何账本结论', JSON.stringify(nlHits).slice(0, 120))
  report(nlHits.length === 0, '反例：无账本不虚报')

  // ── verify 的判决有三档，不是两档 ──
  //
  // 第三档（退出码 3）是「判不了」：扫描没覆盖全部时，「没发现」不等于「没有」。
  // 没有它，任何把 --verify 当关卡的地方在扫描被截断、有超大文件被跳过、或目录读不出时
  // 都会拿到 0，也就是把「没扫到」读成「扫过且干净」。
  {
    const cleanDir = fixture('verify-clean', {
      'package.json': '{"name":"v","version":"1.0.0"}\n',
    })
    const rClean = handoff(cleanDir, '--verify')
    check(rClean.status === 0, '干净且扫全时退出 0', `实际 ${rClean.status}`)
    report(rClean.status === 0, 'verify 三档：干净=0')

    // 造一个超过体积上限的文件：它会被跳过，于是扫描不完整。
    const gapDir = fixture('verify-gap', {
      'package.json': '{"name":"g","version":"1.0.0"}\n',
    })
    writeFileSync(join(gapDir, 'huge.txt'), 'x'.repeat(2300000), 'utf8')
    const rGap = handoff(gapDir, '--verify')
    check(rGap.status === 3, '有文件没扫到时退出 3（判不了，不是干净）', `实际 ${rGap.status}`)
    report(rGap.status === 3, 'verify 三档：没扫全=3')
    check(/判不了/.test(String(rGap.stdout ?? '')),
      '「判不了」在文字里也说清，不只靠退出码')
    report(/判不了/.test(String(rGap.stdout ?? '')), 'verify 三档：文字也说清')

    const dirtyDir = fixture('verify-dirty', {
      'package.json': '{"name":"d","version":"1.0.0"}\n',
      'AGENTS.md': '<!-- project-forge:kernel:start -->\n',
    })
    const rDirty = handoff(dirtyDir, '--verify')
    check(rDirty.status === 1, '有痕迹时退出 1（不被「扫描不完整」那一档吞掉）', `实际 ${rDirty.status}`)
    report(rDirty.status === 1, 'verify 三档：不干净=1')
  }
}


group('[34] Python/Go/Rust 发布事实与门禁：只认本生态清单')
{
  const rv = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const rvOut = (r) => r.stdout ?? ''

  // Python：有后端 → 有构建命令、无构建后端待问
  const pyFull = fixture('eco-pyfull', {
    'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\nrequires-python = ">=3.10"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
  })
  const sp = survey(pyFull)
  const okP1 = sp.artifacts?.pythonBuild?.hasBuildSystem === true
    && survey(pyFull).commands?.build === 'python -m build'
  check(okP1, 'Python 有后端 → 有构建命令', JSON.stringify(survey(pyFull).commands?.build))
  report(okP1, 'Python：构建命令有权威来源')
  const okP2 = !/构建后端/.test(rvOut(rv(pyFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okP2, 'Python 有后端 → 门禁不问构建后端')
  report(okP2, 'Python：门禁放行')
  const pyBare = fixture('eco-pybare', { 'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n' })
  const okP3 = survey(pyBare).artifacts?.pythonBuild?.hasBuildSystem === false
    && /构建后端/.test(rvOut(rv(pyBare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okP3, 'Python 无后端 → 事实为假且门禁待问')
  report(okP3, 'Python：缺后端拦得住')

  // Go：有 go 指令 → 无待问；无 → 待问；retract 照实读
  const goFull = fixture('eco-gofull', {
    'go.mod': 'module example.com/m\n\ngo 1.22\n',
  })
  const sg = survey(goFull)
  const okG1 = sg.artifacts?.goModule?.module === 'example.com/m'
    && sg.artifacts?.goModule?.goDirective === '1.22'
    && sg.artifacts?.goModule?.hasRetract === false
  check(okG1, 'Go 读出模块路径、指令与 retract', JSON.stringify(sg.artifacts?.goModule))
  report(okG1, 'Go：事实照实读')
  const okG2 = !/go 指令/.test(rvOut(rv(goFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okG2, 'Go 有指令 → 门禁不问')
  report(okG2, 'Go：门禁放行')
  const goBare = fixture('eco-gobare', { 'go.mod': 'module example.com/m\n' })
  const okG3 = /go 指令/.test(rvOut(rv(goBare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okG3, 'Go 无指令 → 门禁待问')
  report(okG3, 'Go：缺指令问得住')

  // Rust：元数据齐 → 放行；缺 license → 报缺；publish=false → 不可发布
  const rsFull = fixture('eco-rsfull', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\n',
  })
  const okR1 = !/Rust 缺/.test(rvOut(rv(rsFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release')))
  check(okR1, 'Rust 元数据齐 → 门禁不拦')
  report(okR1, 'Rust：门禁放行')
  const rsBare = fixture('eco-rsbare', { 'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\n' })
  const rBare = rvOut(rv(rsBare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okR2 = /Rust 缺 license/.test(rBare) && /Rust 缺 description/.test(rBare)
  check(okR2, 'Rust 缺元数据 → 报缺')
  report(okR2, 'Rust：缺项拦得住')
  const rsPriv = fixture('eco-rspriv', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\npublish = false\n',
  })
  const okR3 = survey(rsPriv).artifacts?.private === true
  check(okR3, 'Rust publish=false → 不可发布', String(survey(rsPriv).artifacts?.private))
  report(okR3, 'Rust：私有开关复用机器')
  compose(rsPriv)
  const okR4 = /不对外发布/.test(readFileSync(join(rsPriv, 'AGENTS.md'), 'utf8'))
  check(okR4, 'Rust 私有 → 契约写不对外发布')
  report(okR4, 'Rust：契约一致')

  // Rust 新增位：keywords 超 5 个报缺（服务端拒绝），edition 缺席只待问（可发布）。
  // 正反都要：超了拦得住，不超不误报——只验正面等于没验。
  const rsOver = fixture('eco-rsover', {
    'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\ndescription = "x"\nlicense = "MIT"\nkeywords = ["a", "b", "c", "d", "e", "f"]\n',
  })
  const rOver = rvOut(rv(rsOver, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okR5 = /keywords 6 个/.test(rOver)
  check(okR5, 'Rust keywords 超 5 → 报缺', rOver.split('\n').find((l) => /keywords/.test(l)) ?? '')
  report(okR5, 'Rust：超限拦得住')
  const rFull2 = rvOut(rv(rsFull, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okR6 = !/keywords/.test(rFull2) && /edition/.test(rFull2)
  check(okR6, 'Rust 元数据齐 → 不误报超限，但提示 edition 未声明')
  report(okR6, 'Rust：反向不误报')

  // Python 新增位：缺 readme/license 报缺（服务端大概率拒绝），缺 requires-python
  // 只待问（不挡发布），dynamic version 提示 tag 对齐按后端取值。
  const pyNoReadme = fixture('eco-pynoreadme', {
    'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
  })
  const rPyNo = rvOut(rv(pyNoReadme, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okPy4 = /Python 缺 readme/.test(rPyNo) && /Python 缺 license/.test(rPyNo)
  check(okPy4, 'Python 缺 readme/license → 报缺', rPyNo.split('\n').find((l) => /Python 缺/.test(l)) ?? '')
  report(okPy4, 'Python：缺元数据拦得住')
  const pyDyn = fixture('eco-pydyn', {
    'pyproject.toml': '[project]\nname = "p"\ndynamic = ["version"]\nreadme = "README.md"\nlicense = "MIT"\nrequires-python = ">=3.10"\n\n[build-system]\nrequires = ["hatchling"]\nbuild-backend = "hatchling.build"\n',
    'README.md': '# p\n',
  })
  const rPyDyn = rvOut(rv(pyDyn, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release'))
  const okPy5 = !/Python 缺/.test(rPyDyn) && /dynamic/.test(rPyDyn)
  check(okPy5, 'Python 元数据齐 + dynamic → 不报缺，但提示对齐按后端取值')
  report(okPy5, 'Python：dynamic 提示到位')
}


// ── [47] 发布说明：正文只来自被标签指到的那次提交，半成品发不出去 ────────────

if (!HAS_GIT) {
  skipGroup('[47] 发布说明起草与发送门禁', '本机没有 git')
} else {
  group('[47] 发布说明：来源单一、半成品发不出去')
  const ID = ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid']
  const repo = join(ROOT, 'notes-repo')
  mkdirSync(repo, { recursive: true })
  gitIn(repo, 'init')
  writeFileSync(join(repo, 'a.txt'), 'x\n', 'utf8')
  gitIn(repo, 'add', '-A')
  gitIn(repo, ...ID, 'commit', '-m', '第一条：没有正文')
  gitIn(repo, 'tag', 'v0.1.0')
  writeFileSync(join(repo, 'b.txt'), 'y\n', 'utf8')
  gitIn(repo, 'add', '-A')
  gitIn(repo, ...ID, 'commit', '-m', '第二条：也没有正文')
  gitIn(repo, 'tag', 'v0.2.0')

  const draft = (tag, out) => spawnSync(
    process.execPath, [join(SCRIPTS_DIR, 'draft-release-notes.mjs'), tag, out],
    { cwd: repo, encoding: 'utf8', windowsHide: true },
  )

  // 1) 被标签指到的提交没有正文 → 只能列出主题，并留下给维护者的标记
  const bare = join(ROOT, 'notes-bare.md')
  const r1 = draft('v0.2.0', bare)
  const bareText = existsSync(bare) ? readFileSync(bare, 'utf8') : ''
  const marked = r1.status === 0 && bareText.includes('pf:needs-summary')
  check(marked, '没有总述时写下 pf:needs-summary 标记（而不是冒充成品）', bareText.slice(0, 120))
  report(marked, '无总述：留下标记')

  // 2) 这份起草稿交给发送端 → 必须拒绝（exit 2），不许发出去
  //    给它一个假凭据与一个假仓库名：拒绝发生在任何网络动作之前，所以这条断言是纯本地的。
  const send = spawnSync(
    process.execPath,
    [join(SCRIPTS_DIR, 'release-notes.mjs'), 'v0.2.0', bare, '--repo', 'owner/name'],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, GITHUB_TOKEN: 'fixture-token-not-used' } },
  )
  const refused = send.status === 2
  check(refused, '起草稿被发送端拒绝（半成品发不出去）', `exit=${send.status} ${(send.stderr ?? '').slice(0, 120)}`)
  report(refused, '半成品：拒绝发送')

  // 3) 被标签指到的提交有正文 → 正文就是说明，且不留标记
  writeFileSync(join(repo, 'c.txt'), 'z\n', 'utf8')
  gitIn(repo, 'add', '-A')
  gitIn(repo, ...ID, 'commit', '-m', '第三条：有正文', '-m', '这一版把某个命令的参数改了，用的人需要跟着改一次。')
  gitIn(repo, 'tag', 'v0.3.0')
  const withBody = join(ROOT, 'notes-body.md')
  const r3 = draft('v0.3.0', withBody)
  const bodyText = existsSync(withBody) ? readFileSync(withBody, 'utf8') : ''
  const used = r3.status === 0
    && bodyText.includes('这一版把某个命令的参数改了')
    && !bodyText.includes('pf:needs-summary')
  check(used, '有正文时直接采用它，不再列提交主题', bodyText.slice(0, 160))
  report(used, '有总述：直接采用')

  // 4) 判据本身要能两面证伪：带标记的认出来、不带标记的放行。少了这一半，
  //    「拒绝发送」有可能是一句恒真的拒绝，而上面那条断言照样绿。
  check(needsSummary(bareText) && !needsSummary(bodyText),
    '「还没写完」的判据两面都分得清（带标记认出、不带标记放行）',
    `bare=${needsSummary(bareText)} body=${needsSummary(bodyText)}`)
  report(needsSummary(bareText) && !needsSummary(bodyText), '判据：两面都分得清')

  // 5) 没有上一个标签时（仓库的第一个版本），不许给出点不开的对比链接，
  //    也不许写「仅列最近 100 条」——有总述时页面上一句提交都没列，那句话是凭空多出来的。
  //
  //    两个都是实际发生过的事：第一次发版时页面底部挂着
  //    `compare/v1.0.0`（只有一个端点，点开 404），上面还写着「仅列最近 100 条」，
  //    而正文里一条都没列。
  const first = join(ROOT, 'notes-first.md')
  const fresh = spawnSync(
    process.execPath, [join(SCRIPTS_DIR, 'draft-release-notes.mjs'), 'v0.1.0', first],
    { cwd: repo, encoding: 'utf8', windowsHide: true },
  )
  const firstText = existsSync(first) ? readFileSync(first, 'utf8') : ''
  const noDeadLink = fresh.status === 0 && !/compare\//.test(firstText)
  check(noDeadLink, '第一个版本：不给点不开的对比链接', firstText.split('\n').slice(-3).join(' | ').slice(0, 160))
  report(noDeadLink, '首版：没有死链')
  const noPhantomCount = !firstText.includes('仅列最近 100 条')
  check(noPhantomCount, '没有列提交时不写「仅列最近 100 条」（那句话要真有列表才成立）',
    firstText.slice(0, 120))
  report(noPhantomCount, '没有假计数')
  // 反面对照：有上一个版本时，「完整改动」那一行必须给出两个端点组成的区间，
  // 否则上面那条「不给死链」会被「永远不给区间」这种退化解满足。
  // 这里不假定有 remote：没有 remote 时不给链接是对的（不编地址），但区间照写；
  // 区间是「上一个标签..这个标签」，即紧邻的那一个，不是最早的任何一个。
  const linked = /完整改动/.test(bodyText) && /v0\.2\.0\.\.v0\.3\.0/.test(bodyText)
  check(linked, '有上一个版本时照旧给出区间（否则「不给死链」可以靠从不给区间蒙过去）',
    bodyText.split('\n').filter((l) => l.includes('完整改动')).join(' | ').slice(0, 160))
  report(linked, '有上一版：区间照给')
}


group('[35] Obsidian 发布链：附件语境与触发器形状，机器说了算')
{
  const rv = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const rvOut = (r) => r.stdout ?? ''
  const baseFlags = ['--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--no-auto-release']
  const manifestOf = (id) => JSON.stringify({
    id, name: 'My Plugin', version: '1.2.3', minAppVersion: '1.0.0',
    description: 'd.', author: 'a', isDesktopOnly: false,
  })
  // 未构建态的 CONTRIBUTING 骨架：review 的 CONTRIBUTING 门只认关键词有无，
  // 这里给一份关键词齐全的，把变量固定在 Obsidian 门上，不让贡献指南门串扰。
  const OBS_CONTRIB = '# C\n\n提问与反馈到 Issue 区。\n\n报告缺陷四件事。\n\n'
    + '提出改动：先 fork，在分支上开发，门禁全绿开请求。不推主干，不打标签，不发布。\n\n'
    + '开发环境：构建测试。\n\n提交前门禁：跑构建测试，全绿。\n\n'
    + '硬性规范：完整规范以 AGENTS.md 为准。\n\n提交信息：一句话。\n\n许可：见 LICENSE。\n\n'
    + '产物与源码一起提交。本地挂载后重启宿主验证。\n'

  // 1) 官方模板态：main.js 被忽略、根目录无 main.js → 不报缺，只报附件待核。
  //    「仓库根无 main.js」不是缺失：官方模板要求它只进发布附件、不进库。
  const tplState = fixture('obs-tplstate', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
  })
  const sTpl = survey(tplState)
  const okT1 = sTpl.artifacts?.obsidianArtifacts?.mainJs === false
    && sTpl.artifacts?.obsidianArtifacts?.mainJsIgnored === true
  check(okT1, '模板态：main.js 缺但被忽略 → 事实分得清', JSON.stringify(sTpl.artifacts?.obsidianArtifacts))
  report(okT1, 'Obsidian：模板态事实正确')
  const rTpl = rvOut(rv(tplState, ...baseFlags))
  const okT2 = !/产物缺 main\.js/.test(rTpl) && /只进发布附件/.test(rTpl)
  check(okT2, '模板态：不报“产物缺”，报附件语境')
  report(okT2, 'Obsidian：模板态不误报')

  // 2) 反向：main.js 既不在根目录、也没被忽略 → 待问（还没构建 or 忽略漏了）。
  const noBuild = fixture('obs-nobuild', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    'README.md': '# p\n',
    'LICENSE': 'MIT\n',
    'CONTRIBUTING.md': OBS_CONTRIB,
    'AGENTS.md': '# p\n\n<!-- project-forge:kernel:start -->\n<!-- project-forge:kernel:end -->\n',
    '.github/workflows/check.yml': 'name: check\non: [push]\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const rNoBuild = rvOut(rv(noBuild, ...baseFlags))
  const okN1 = /还没构建/.test(rNoBuild)
  check(okN1, '未构建态 → 待问（不报缺）')
  report(okN1, 'Obsidian：未构建问得住')

  // 3) id 形状非法（含大写 obsidian 结尾 plugin 三毒俱全）→ 报缺，拦得住。
  const badId = fixture('obs-badid', {
    'manifest.json': `${manifestOf('Obsidian-Foo-Plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
  })
  const rBad = rvOut(rv(badId, ...baseFlags))
  const okB1 = /形状非法/.test(rBad)
  check(okB1, '非法 id → 报缺', rBad.split('\n').find((l) => /形状/.test(l)) ?? '')
  report(okB1, 'Obsidian：非法 id 拦得住')

  // 4) 触发器形状：v* 触发器 + refs/tags/v 条件 → 待问裸版本；裸版本触发器则安静。
  const vTrigger = fixture('obs-vtrigger', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["v*"]\njobs:\n  release:\n    if: startsWith(github.ref, \'refs/tags/v\')\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const rV = rvOut(rv(vTrigger, ...baseFlags))
  const okV1 = /裸版本/.test(rV)
  check(okV1, 'v* 触发器 → 待问裸版本')
  report(okV1, 'Obsidian：v 形状问得住')
  const bareTrigger = fixture('obs-baretrigger', {
    'manifest.json': `${manifestOf('my-plugin')}\n`,
    '.gitignore': 'main.js\n',
    'README.md': '# p\n',
    '.github/workflows/release.yml': 'name: release\non:\n  push:\n    tags: ["[0-9]*.[0-9]*.[0-9]*"]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
  })
  const rBare = rvOut(rv(bareTrigger, ...baseFlags))
  const okV2 = !/裸版本/.test(rBare)
  check(okV2, '裸版本触发器 → 不误报')
  report(okV2, 'Obsidian：裸形安静')
}


group('[31] DSH 专章滞后提醒：对齐安静，漂移警告，不拦流程')
{
  const mkDual = (ver) => fixture(`dsh-fresh-${ver.replace(/[^a-z0-9]+/gi, '_')}`, {
    'package.json': JSON.stringify({
      name: 'dsh-fresh', version: '0.1.0',
      devDependencies: { '@deepseek-ai/dsh-foo': ver },
      exports: { '.': './lib/index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2),
    'cordis.patch.yml': "- insert:\n    - id: fresh\n      name: 'dsh-fresh'\n",
    'lib/index.js': 'export const name = "fresh"\n',
  })
  // 与标记一致 → 安静（只断言无警告，不断言其他输出）
  //
  // 基准从专章的核对标记**现场取**，不写死版本号：写死就等于每次重核宿主后都要有人
  // 记得来改这个 fixture，而忘了改的症状恰好就是「对齐场景报红」——那会让人误以为
  // 实现坏了。对齐断言该问的只有一件事：**与标记相同的锁定版本，会不会被误报成漂移**。
  {
    const markerText = readFileSync(join(SKILL_ROOT, 'references', 'plugins', 'dsh.md'), 'utf8')
    const hostPin = /dsh-verified:\s*host=(\S+)/.exec(markerText)?.[1]
    check(typeof hostPin === 'string' && hostPin.length > 0,
      '专章核对标记的 host= 取得到（对齐 fixture 的基准）', String(hostPin))
    report(typeof hostPin === 'string' && hostPin.length > 0, `专章标记 host=${hostPin}`)
    const dir = mkDual(`^${hostPin}`)
    const pin = `^${hostPin}`
    const pinned = survey(dir).dsh?.pinnedVersions ?? []
    const okPin = pinned.includes(pin)
    check(okPin, '锁定版本被收录', JSON.stringify(pinned))
    report(okPin, '锁定版本：收录')
    const r = compose(dir)
    // 判据用**漂移提示独有的那句**，不用「兼容范围」这个通用词：后者在契约正文里
    // 也会出现（讲清声明与闸门的分工就得写它），拿它当判据，改一次文案就假红一次。
    const okQuiet = !/与专章核对时的宿主版本/.test(r.stdout ?? '')
    check(okQuiet, '兼容范围与标记一致时无提示', r.stdout ?? '')
    report(okQuiet, '对齐：安静')
  }
  // 漂移 → 提示但不失败。
  //
  // 哨兵值**从基准派生**，不写死 `9.9.9`：写死的话，专章标记恰好是 9.9.9 时这个
  // 反例会静默退化成「对齐」用例——一个不再能证伪的断言（实测过这类碰撞风险）。
  {
    const markerForDrift = readFileSync(join(SKILL_ROOT, 'references', 'plugins', 'dsh.md'), 'utf8')
    const base = /dsh-verified:\s*[^>]*?host=(\S+)/.exec(markerForDrift)?.[1] ?? '1.0.0'
    const driftPin = base === '9.9.9' ? '8.8.8' : '9.9.9'
    const dir = mkDual(`^${driftPin}`)
    const r = compose(dir)
    const okWarn = /与专章核对时的宿主版本/.test(r.stdout ?? '') && r.status === 0
    check(okWarn, '兼容范围与标记不同时提示且不拦流程', `exit=${r.status}`)
    report(okWarn, '漂移：提示')
  }
  // 未知 dsh 字段现形；已知字段不误报
  {
    const dir = fixture('dsh-unknownkey', {
      'package.json': JSON.stringify({
        name: 'dsh-unk', version: '0.1.0',
        exports: { '.': './lib/index.js' },
        dsh: { bundle: { patch: './cordis.patch.yml' }, frobnicate: {} },
      }, null, 2),
      'cordis.patch.yml': "- insert:\n    - id: unk\n      name: 'dsh-unk'\n",
    })
    const unk = survey(dir).dsh?.unknownKeys ?? []
    const okUnk = unk.includes('frobnicate')
    check(okUnk, '未知 dsh 字段被点名', JSON.stringify(unk))
    report(okUnk, '未知字段：现形')
    const md = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), dir, '--markdown'],
      { encoding: 'utf8' }).stdout ?? ''
    const okMd = /不认识的字段/.test(md) && /frobnicate/.test(md)
    check(okMd, '报告里写明未知字段名', 'markdown 含提示行')
    report(okMd, '未知字段：报告可读')
  }
}


group('[21] 插件类：三种生态各自认出，未知生态不被误判')
{
  // 三个生态的清单文件与判定字段都不同——这正说明「一个通用类型」不够用：
  // VS Code 用 package.json 的 engines.vscode，Obsidian 用独立的 manifest.json，
  // 混淆任何两个都会把产物入库、发布范围这类判断做错。
  const vsc = fixture('plug-vscode', {
    'package.json': JSON.stringify({
      name: 'myext', version: '1.0.0', publisher: 'me', engines: { vscode: '^1.80.0' },
    }, null, 2),
    'src/extension.ts': 'export function activate() {}\n',
  })
  const okVsc = (survey(vsc).ecosystem?.kinds ?? []).includes('vscode-extension')
  check(okVsc, 'VS Code 扩展被认出（engines.vscode）', JSON.stringify(survey(vsc).ecosystem?.kinds))
  report(okVsc, 'VS Code：认出 vscode-extension')

  const obs = fixture('plug-obsidian', {
    'manifest.json': JSON.stringify({
      id: 'my-plugin', name: 'My Plugin', version: '1.0.0', minAppVersion: '1.0.0',
    }, null, 2),
    'main.js': 'module.exports = class {}\n',
  })
  const okObs = (survey(obs).ecosystem?.kinds ?? []).includes('obsidian-plugin')
  check(okObs, 'Obsidian 插件被认出（manifest.json 的 minAppVersion）',
    JSON.stringify(survey(obs).ecosystem?.kinds))
  report(okObs, 'Obsidian：认出 obsidian-plugin')

  const dsh = fixture('plug-dsh', {
    'package.json': JSON.stringify({ name: 'p', version: '1.0.0', dsh: { bundle: {} } }),
    'cordis.patch.yml': '- id: p\n',
  })
  const okDsh = (survey(dsh).ecosystem?.kinds ?? []).includes('dsh-plugin')
  check(okDsh, 'DSH 插件仍被认出', JSON.stringify(survey(dsh).ecosystem?.kinds))
  report(okDsh, 'DSH：认出 dsh-plugin')

  // 关键的**反向**断言：一个普通的 `manifest.json`（不含 minAppVersion，例如 PWA 或
  // 浏览器扩展的清单）不该被误判成 Obsidian 插件——误判会让产物入库等判断全错。
  const pwa = fixture('plug-pwa', {
    'manifest.json': JSON.stringify({ name: 'App', short_name: 'App', start_url: '/', display: 'standalone' }, null, 2),
    'index.html': '<html></html>\n',
  })
  const pwaKinds = survey(pwa).ecosystem?.kinds ?? []
  const okPwa = !pwaKinds.includes('obsidian-plugin')
  check(okPwa, '普通 manifest.json 不被误判成 Obsidian 插件', JSON.stringify(pwaKinds))
  report(okPwa, '反向：PWA 清单不误判')

  // 未知生态：不该被硬塞进已知类型，应落到需要人判断的那一类
  const unknown = fixture('plug-unknown-host', {
    'myhost-extension.json': JSON.stringify({ hostVersion: '3.0', id: 'x' }, null, 2),
    'src/main.rs': 'fn main() {}\n',
  })
  const ukKinds = survey(unknown).ecosystem?.kinds ?? []
  const okUnknown = !ukKinds.some((k) => /plugin|extension/.test(k))
  check(okUnknown, '未知宿主不被硬塞进已知插件类型', JSON.stringify(ukKinds))
  report(okUnknown, '未知宿主：不硬塞已知类型')
}


group('[11] 本机路径分档：真泄漏要报，测试数据不要误导')
{
  const realHome = homedir().replace(/\\/g, '/')
  // 真泄漏：源码里写了本机真实主目录（用正斜杠写法——很多工具与配置都这么写，
  // 只认反斜杠的检测会完全漏掉它）
  const leak = fixture('leak-real', {
    'src/config.ts': `export const ROOT = '${realHome}/projects/thing'\n`,
  })
  const hits = survey(leak).risks?.homePathLeaks ?? []
  const ok1 = hits.some((h) => h.kind === 'leak')
  check(ok1, '源码里的本机真实路径判为 leak（正斜杠写法也要认）',
    JSON.stringify(hits.map((h) => [h.path, h.kind])))
  report(ok1, '真泄漏：判为 leak')

  // 测试数据：假路径不该被当成泄漏，且建议必须明确「不要改它」——
  // 把测试数据报成「本机私有路径」并建议改成相对路径，照着做会把测试改坏。
  const fake = fixture('leak-testdata', {
    'tests/controller.spec.ts': "sessions.setInfo('s-1', { cwd: '/home/me/deepseek' })\n",
  })
  const hits2 = survey(fake).risks?.homePathLeaks ?? []
  const ok2 = hits2.length > 0 && !hits2.some((h) => h.kind === 'leak')
  check(ok2, '测试文件里的假路径不判为 leak', JSON.stringify(hits2.map((h) => h.kind)))
  report(ok2, '测试数据：不判为 leak')
  const ok3 = hits2.every((h) => !/改成相对路径或环境变量/.test(h.advice ?? ''))
  check(ok3, '测试数据给出的建议不是「改成相对路径」')
  report(ok3, '测试数据：建议不改它')

  // 文档示例：文档里的路径判为 doc-example（提示确认即可）；模板文件放行不报
  const doc = fixture('leak-doc', {
    'README.md': '# x\n\n路径示例：/home/someone/projects/demo\n',
    '.env.example': 'API_KEY=your-key-here\n',
  })
  const hits3 = survey(doc).risks?.homePathLeaks ?? []
  // 非空前提：`every` 在空数组上恒真，缺了它「一个都没识别出来」也会显示通过。
  const ok4 = hits3.length > 0 && hits3.every((h) => h.kind !== 'leak')
  check(ok4, '文档里的示例路径不判为 leak', JSON.stringify(hits3.map((h) => h.kind)))
  report(ok4, '文档示例：不判为 leak')
  const files3 = survey(doc).risks?.secretFiles ?? []
  // 这一条是**否定**断言（这些文件不该出现在命中里）：空数组就是它想要的结果，
  // 所以不能像上面那样加「非空前提」——但否定断言只有在「检测器确实活着」时才可信，
  // 于是配一条正向断言：同目录里的真 `.env` 必须被报出来。
  const ok5 = !files3.some((f) => /env\.example/.test(typeof f === 'string' ? f : f.path))
  const probeFiles = survey(fixture('leak-doc-probe', { '.env': 'x=1\n', 'README.md': '# x\n' })).risks?.secretFiles ?? []
  const ok5b = probeFiles.some((f) => /(^|[\\/])\.env$/.test(typeof f === 'string' ? f : f.path))
  check(ok5b, '同一判定对真 .env 仍报出来（否定断言的前提：检测器活着）', JSON.stringify(probeFiles))
  report(ok5b, '模板放行的对照：真 .env 仍被报出')
  check(ok5, '.env.example 模板文件放行', JSON.stringify(files3))
  report(ok5, '模板文件：放行')
}


group('[20] 已有的 README：双语要认出来，结构不同不强行对齐')
{
  // 双语 README 必须被认成**一对**，而不是两个无关文件——只有知道它们是一对，
  // 「改一份要看另一份」这条才谈得上。
  const bi = fixture('readme-bilingual', {
    'README.md': '# 中文说明\n\n## 安装\n\n## 使用\n',
    'README.en.md': '# English\n\n## Installation\n\n## Usage\n',
    'src/a.js': 'export const a=1\n',
  })
  const pair = survey(bi).docs?.readmePair
  const ok1 = pair !== undefined && pair.default === 'README.md'
  check(ok1, '双语 README 被认成一对', JSON.stringify(pair))
  report(ok1, '双语 README：认成一对')
  const ok2 = Array.isArray(pair?.variants) && pair.variants.includes('README.en.md')
  check(ok2, '另一语言的文件列在 variants 里')
  report(ok2, '双语 README：列出另一语言')

  // 报告里要写明「两份都会随包发出」「会漂移」——否则「成对」这个事实没有可操作的后果
  const md = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), bi, '--markdown'],
    { encoding: 'utf8' }).stdout ?? ''
  const ok3 = /双语 README/.test(md) && /漂移/.test(md)
  check(ok3, '报告里写明成对关系的后果（随包发出 + 会漂移）')
  report(ok3, '报告写明后果')

  // 单语 README 不该被误报成一对（否则「成对」这个信号会贬值）
  const single = fixture('readme-single', { 'README.md': '# x\n\n## 安装\n', 'src/a.js': 'x\n' })
  const ok4 = survey(single).docs?.readmePair === undefined
  check(ok4, '单语 README 不报成一对')
  report(ok4, '单语 README：不误报')

  // 结构完全不同的 README：必须报出**它现有的节**（事实），而不是「缺哪几节」（结论）。
  // README 没有标准结构，脚本不该假装能判合格与否。
  const custom = fixture('readme-custom', {
    'README.md': '# tool\n\n## 它解决什么\n\n## 装在哪\n\n## 日常用法\n',
    'src/a.js': 'x\n',
  })
  const sections = survey(custom).docs?.readmeSections ?? []
  const ok5 = sections.includes('## 它解决什么') && sections.includes('## 日常用法')
  check(ok5, '报出自定义结构的实际节名（不按模板改名判断）', JSON.stringify(sections))
  report(ok5, '结构不同：报实际节名')
  const ok6 = sections.length === 3
  check(ok6, '不把模板的节名混进来', String(sections.length))
  report(ok6, '不混入模板节名')
}


group('[7] 刷新：条件随事实变化，人写的内容不被冲掉')
{
  // **自建 fixture，不吃上一组留下的目录。**
  //
  // 原先这里用 `join(ROOT, 'gen')`——那个目录由 [6] 组顺手建出来，两组之间因此有
  // 一条没写下来的依赖。串行跑时它碰巧成立，分片跑必然断：[6] 与 [7] 落在不同进程，
  // [7] 找不到 AGENTS.md，报的是「文件不存在」这种看不出根因的错。
  //
  // 组与组之间不该有隐式依赖。这里落一份与 [6] 等价的最小项目，[6] 在不在都不影响。
  const dir = fixture('gen-refresh', {
    'package.json': JSON.stringify({
      name: '@scope/my-tool', version: '0.1.0',
      scripts: { build: 'tsc', test: 'vitest run' },
      devDependencies: { typescript: '^5.0.0' },
    }, null, 2),
    'src/index.ts': 'export const x = 1\n',
  })
  compose(dir)
  const agents = join(dir, 'AGENTS.md')
  // 模拟 AI 填完待填写项
  writeFileSync(agents, readFileSync(agents, 'utf8')
    .replace(/<!--\s*pf:author[\s\S]*?-->/g, '（已填写的真实内容）'), 'utf8')

  if (HAS_GIT) {
    spawnSync('git', ['init', '-q'], { cwd: dir })
    spawnSync('git', ['remote', 'add', 'origin', 'https://example.invalid/x.git'], { cwd: dir })
  } else {
    // 没有 git 时用一个等价的替代信号：手写一个 .git 目录不足以让 git 认它，所以改为
    // 直接跳过「远端出现」这一组断言，其余（人写内容保留、幂等）照常验证。
    process.stdout.write('  （环境里没有 git，跳过「建好远端后角色判定出现」这一条）\n')
  }
  compose(dir)
  const t = readFileSync(agents, 'utf8')
  const checks = [
    ['人写的内容保留', /（已填写的真实内容）/.test(t)],
    ['没有重复的版本节', (t.match(/^## 版本管理（必守）$/gm) ?? []).length === 1],
    ['没有内核被追加多份', (t.match(/project-forge:kernel:start/g) ?? []).length === 1],
  ]
  if (HAS_GIT) {
    checks.unshift(
      ['建好远端后「角色判定」出现（防条件段落被永久冻结）', /^### 角色判定/m.test(t)],
      ['发版规则出现', /^### 发版规则/m.test(t)],
    )
  }
  for (const [label, ok] of checks) { check(ok, label); report(ok, label) }

  const r = compose(dir)
  const stable = readFileSync(agents, 'utf8') === t
  check(stable, '幂等：再跑一次内容不变')
  report(stable && /无需改动/.test(r.stdout), '幂等：再跑一次报「无需改动」')
}


if (!HAS_GIT) {
  skipGroup('[27] 署名门禁：有仓库无署名必报缺', '环境里没有 git')
} else {
group('[27] 署名门禁：有仓库无署名必报缺，有署名放行')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

  // 有仓库、无任何署名 → 缺。把全局配置从环境里隔离掉，测的是真缺失
  // （否则本机全局署名会继承进来，缺的数量永远是 0）。
  const bare = fixture('review-nosig', { 'README.md': '# x\n' })
  spawnSync('git', ['init', '-q'], { cwd: bare })
  const noGlobalEnv = {
    ...process.env,
    HOME: bare,
    USERPROFILE: bare,
    GIT_CONFIG_GLOBAL: join(bare, 'no-global-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
  }
  const reviewNoGlobal = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8', env: noGlobalEnv })
  const r1 = reviewNoGlobal(bare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const out1 = `${r1.stdout ?? ''}\n${r1.stderr ?? ''}`
  const ok1 = /署名缺失/.test(out1)
  check(ok1, '无署名报缺', out1.split('\n')[0])
  report(ok1, '无署名：报缺')

  // 同一仓库补上署名 → 放行（只看有无，占位值靠人眼是 G7 的事）
  spawnSync('git', ['config', 'user.name', 'T'], { cwd: bare })
  spawnSync('git', ['config', 'user.email', 't@e.com'], { cwd: bare })
  const r2 = reviewNoGlobal(bare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok2 = /提交署名有/.test(r2.stdout ?? '')
  check(ok2, '有署名放行')
  report(ok2, '有署名：放行')
}
}


group('[12] 生态与命令：细化不算第二套命令')
{
  // dsh-plugin 是 node 的细化，只有一套命令；把它算成多生态会让 AI 去找不存在的第二套。
  const plugin = fixture('eco-plugin', {
    'package.json': JSON.stringify({
      name: 'p', version: '1.0.0', private: true, scripts: { build: 'tsc', test: 'vitest' },
    }, null, 2),
    'cordis.patch.yml': '- id: p\n',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
  })
  const r1 = survey(plugin)
  const ok1 = r1.commands?.multipleEcosystems === undefined
  check(ok1, 'node + dsh-plugin 不报多生态', JSON.stringify(r1.commands?.multipleEcosystems))
  report(ok1, '插件项目：不误报多生态')
  const ok2 = r1.commands?.packageManager === 'pnpm'
  check(ok2, '包管理器取锁文件（pnpm），不写死 npm', String(r1.commands?.packageManager))
  report(ok2, '插件项目：沿用它自己的 pnpm')

  // 真两套命令仍要报
  const multi = fixture('eco-multi', {
    'package.json': JSON.stringify({ name: 'm', version: '1.0.0', scripts: { test: 'vitest' } }),
    'pyproject.toml': '[project]\nname = "m"\n',
    'tests/test_a.py': 'def test_a(): pass\n',
  })
  const ok3 = Array.isArray(survey(multi).commands?.multipleEcosystems)
  check(ok3, 'node + python 仍报多生态')
  report(ok3, '真多生态：仍然报')
}


group('[10] 运行环境下限：读项目自己的声明，读不到就是没有')
{
  const nodeProj = fixture('env-node', {
    'package.json': JSON.stringify({ name: 'e', version: '1.0.0', engines: { node: '>=20' } }),
  })
  const reqs = survey(nodeProj).artifacts?.runtimeRequirements ?? []
  const ok1 = reqs.some((r) => r.runtime === 'node' && r.range === '>=20')
  check(ok1, '读出 package.json 的 engines.node', JSON.stringify(reqs))
  report(ok1, '读出 package.json 的 engines.node')

  const pyProj = fixture('env-py', {
    'pyproject.toml': '[project]\nname = "e"\nrequires-python = ">=3.10"\n',
  })
  const reqs2 = survey(pyProj).artifacts?.runtimeRequirements ?? []
  const ok2 = reqs2.some((r) => r.runtime === 'python' && r.range === '>=3.10')
  check(ok2, '读出 pyproject.toml 的 requires-python', JSON.stringify(reqs2))
  report(ok2, '读出 pyproject.toml 的 requires-python')

  // 没声明时必须是空数组，不能凭空给一个值——文档套装禁止编造版本号，
  // 而「编造」的入口正是勘察这里给了一个看似合理的默认值。
  const bare = fixture('env-none', { 'README.md': '# x\n', 'src/a.js': 'export const a=1\n' })
  const reqs3 = survey(bare).artifacts?.runtimeRequirements ?? []
  const ok3 = reqs3.length === 0
  check(ok3, '未声明时为空（不得凭空给默认值）', JSON.stringify(reqs3))
  report(ok3, '未声明时为空，不编造')
}


// ── 二、仓库边界（防把外层仓库的远端当成目标目录的） ─────────────────────────

if (!HAS_GIT) {
  skipGroup('[2] 目录在别人的仓库里时必须识别出来', '环境里没有 git')
} else {
group('[2] 目录在别人的仓库里时必须识别出来')
{
  const outer = fixture('outer', { 'inner/README.md': '# inner\n', 'outer.txt': 'x\n' })
  for (const args of [['init', '-q'], ['remote', 'add', 'origin', 'https://example.invalid/o.git'],
    ['config', 'user.name', 'T'], ['config', 'user.email', 't@example.com']]) {
    spawnSync('git', args, { cwd: outer })
  }
  spawnSync('git', ['add', '-A'], { cwd: outer })
  spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: outer })

  const inner = join(outer, 'inner')
  const s = survey(inner)
  check(s.git?.isRepoRoot === false, '子目录 → isRepoRoot 为假',
    String(s.git?.isRepoRoot))
  check(typeof s.git?.note === 'string', '带 note 说明这些值属于外层仓库')
  check(s.git?.remote !== undefined, '（外层仓库确实有远端，说明这个误判有实际后果）')
  report(s.git?.isRepoRoot === false, '子目录不被当成仓库根')
}
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