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
group('[46] 自动更新：比版本、整份覆盖、24 小时窗口')
{
  // 每个副本一份自己的状态目录：状态按副本路径分开记，测试之间不能互相串。
  const stateTmp = join(ROOT, 'update-state')
  mkdirSync(stateTmp, { recursive: true })
  const runUpdate = (skillDir, ...extra) => new Promise((resolvePromise) => {
    const opts = typeof extra[extra.length - 1] === 'object' && extra[extra.length - 1] !== null
      ? extra.pop() : {}
    const child = spawn(process.execPath, [join(skillDir, 'scripts', 'update.mjs'), ...extra],
      { windowsHide: true,
        env: { ...process.env, TEMP: stateTmp, TMPDIR: stateTmp, ...(opts.env ?? {}) } })
    let text = ''
    child.stdout.on('data', (d) => { text += d })
    child.stderr.on('data', (d) => { text += d })
    child.on('close', (code) => resolvePromise({ status: code, out: text.trim() }))
  })

  /**
   * 造一份副本：只放跑得起来的那几个文件，不复制整棵树——这一组验的是判定，不是包边界。
   *
   * 关键是**副本自己也是一个 git 仓库**：下面要发的「新版压缩包」由它导出，这样
   * 包里的文件与副本里的文件天然逐字节一致（行尾也一致），测的才是判定本身。
   */
  const makeCopy = (name, { withGit = false, source, version = '0.14.0' } = {}) => {
    const dir = join(fixture(name, {}), 'project-forge')
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    // 副本要跟**用户包**一样能用：包里任何一个脚本被 import 的模块都得在。
    // 判据取自磁盘结构而不是一份手写清单——清单会在新增模块那天悄悄失准，
    // 而失准的表现是「跑副本时 ERR_MODULE_NOT_FOUND」，离原因很远。
    for (const f of ['SKILL.md', 'scripts/update.mjs', 'scripts/survey.mjs', 'scripts/sync-toc.mjs', 'scripts/zip.mjs']) {
      writeFileSync(join(dir, f), readFileSync(join(SKILL_ROOT, f)))
    }
    const libDir = join(SKILL_ROOT, 'scripts', 'lib')
    if (existsSync(libDir)) {
      mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true })
      for (const e of readdirSync(libDir, { withFileTypes: true, encoding: 'utf8' })) {
        if (!e.isFile() || !e.name.endsWith('.mjs')) continue
        writeFileSync(join(dir, 'scripts', 'lib', e.name), readFileSync(join(libDir, e.name)))
      }
    }
    const skillPath = join(dir, 'SKILL.md')
    let text = readFileSync(skillPath, 'utf8')
      .replace(/^[ \t]+version:[ \t]*"[^"]*"[ \t]*$/m, `  version: "${version}"`)
    text = source === undefined
      ? text.replace(/^[ \t]+source:[ \t]*"[^"]*"[ \t]*$\n/m, '')
      : text.replace(/^[ \t]+source:[ \t]*"[^"]*"[ \t]*$/m, `  source: "${source}"`)
    writeFileSync(skillPath, text, 'utf8')
    if (withGit) {
      gitIn(dir, 'init')
      gitIn(dir, 'add', '-A')
      gitIn(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'fixture')
    }
    return dir
  }

  /**
   * 从一份副本导出一个「新版压缩包」，并验它自带完整元数据。
   *
   * 这条前提断言不是形式主义：下面几个用例全靠包里那份 `SKILL.md` 把来源一路带下去，
   * 包里少了来源，副本更新完就不知道自己该问谁了——而现象会表现成「更新莫名其妙停了」。
   *
   * `declareVersion` 让「包里声明的版本」与「标签说的版本」分开：两者不一致是真实存在的
   * 情形（附件被换过、缓存顶着旧包），而它对使用者的后果很重（静默降级、或白写一遍文件），
   * 所以要有办法造出这种包来验「它会被拦下」。
   */
  const buildPackage = (name, { version, source, declareVersion, mutate }) => {
    const src = makeCopy(name, { withGit: true, version, source })
    if (declareVersion !== undefined) {
      const p = join(src, 'SKILL.md')
      writeFileSync(p, readFileSync(p, 'utf8')
        .replace(/^([ \t]+version:[ \t]*)"[^"]*"/m, `$1"${declareVersion}"`), 'utf8')
      gitIn(src, 'add', '-A')
      gitIn(src, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'declare')
    }
    // 造「不一样的包」：改法由用例给，这里只管把它提交进导出源。
    // 有些判据（例如「包里的表格能不能决定删到哪儿」）必须靠一份**内容被改过**的包才验得到。
    if (typeof mutate === 'function') {
      mutate(src)
      gitIn(src, 'add', '-A')
      gitIn(src, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '-m', 'mutate')
    }
    const zipPath = join(ROOT, `${name}.zip`)
    const archived = spawnSync('git',
      ['-C', src, 'archive', '--format=zip', '--prefix=project-forge-/', '-o', zipPath, 'HEAD'],
      { encoding: 'utf8', windowsHide: true })
    if (archived.status !== 0) {
      check(false, '前提：git archive 产得出新版压缩包', (archived.stderr ?? '').slice(0, 160))
      return { body: Buffer.alloc(0), version }
    }
    const body = readFileSync(zipPath)
    rmSync(zipPath, { force: true })
    const entries = stripCommonPrefix(readZip(body))
    const packed = entries.find((e) => e.name === 'SKILL.md')?.data.toString('utf8') ?? ''
    const meta = /metadata:[\s\S]*/.exec(/---\r?\n([\s\S]*?)\r?\n---/.exec(packed)?.[1] ?? '')?.[0] ?? '（无）'
    check(skillVersion(packed) === (declareVersion ?? version) && skillSource(packed) !== undefined,
      '前提：造出来的新版包自带版本与来源（用例才有对象）',
      `包里 metadata 段是 ${JSON.stringify(meta)}；磁盘上是 `
      + `${JSON.stringify(/^[ \t]+source:.*$/m.exec(readFileSync(join(src, 'SKILL.md'), 'utf8'))?.[0])}`)
    return { body, version: skillVersion(packed), dir: src }
  }

  const makePackage = (name, opts) => buildPackage(name, opts)

  /**
   * 本机服务端扮演发布方：一个地址回「最新版是哪个标签」，一个地址回压缩包。
   *
   * 用真服务端而不是打桩，是因为要验的东西里有一半是**协议**：问哪个地址、问几次、
   * 有没有在「只比版本」的时候把整包也拉下来。这些只有真的发过请求才数得清。
   * 监听随机端口，不依赖外网，也不会撞端口。
   */
  const stats = { api: 0, zip: 0, apiBytes: 0, zipBytes: 0 }
  const serve = (handler) => new Promise((resolvePromise) => {
    const s = createServer(handler)
    s.listen(0, '127.0.0.1', () => resolvePromise(s))
  })
  const closeServer = (s) => new Promise((resolvePromise) => s.close(() => resolvePromise()))

  const resetStats = () => { stats.api = 0; stats.zip = 0; stats.apiBytes = 0; stats.zipBytes = 0 }

  /**
   * 一个用例失败时把它看见的输出打出来。
   *
   * 失败只报「断言不成立」是不够的：这条链路上任何一个环节（问标签、下包、写盘）断了，
   * 现象都是同一个「没更新」。把输出留在这里，读日志的人不用再跑第二遍去猜。
   */
  const failWith = (ok, label, r) => {
    check(ok, label, ok ? undefined : `实际输出：${JSON.stringify(r.out.slice(0, 300))}`)
  }

  /** 写副本的状态文件。文件名按副本目录算，与 update.mjs 自己那一套必须一致。 */
  const writeState = (dir, patch) => {
    const hash = createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 12)
    writeFileSync(join(stateTmp, `project-forge-update-${hash}.json`),
      `${JSON.stringify(patch)}\n`, 'utf8')
  }

  /** 覆盖状态文件里的更新时间。写 0 = 当作「很久没更新过」。 */
  const setWindow = (dir, lastUpdateAt) => writeState(dir, { lastUpdateAt })

  /** 读状态文件里的更新时间（没有就是 0）。用来验「这次有没有占掉 24 小时窗口」。 */
  const readStateFile = (dir) => {
    const hash = createHash('sha1').update(resolve(dir)).digest('hex').slice(0, 12)
    const p = join(stateTmp, `project-forge-update-${hash}.json`)
    if (!existsSync(p)) return 0
    try {
      return Number(JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))?.lastUpdateAt ?? 0) || 0
    } catch {
      return 0
    }
  }

  const main = async () => {
    // 发布方「最新版是哪个标签」由它决定，用例改它来换场景。
    const state = { tag: '9.9.9' }
    // 「那边没有最新发布」的场景：把这个开关打开。
    const opts = { noLatest: false, tagPage: false }
    const port = { value: 0 }
    const source = () => `http://127.0.0.1:${port.value}/owner/repo`

    const server = await serve((req, res) => {
      const path = req.url ?? ''
      const isLatest = path.includes('/releases/latest') && !path.includes('/download/')
      if (isLatest) {
        stats.api += 1
        if (opts.noLatest) { res.writeHead(404).end(); return }
        const body = Buffer.from(JSON.stringify({ tag_name: `v${state.tag}` }))
        stats.apiBytes += body.length
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': body.length })
        res.end(body)
        return
      }
      if (path.endsWith('/project-forge.zip')) {
        stats.zip += 1
        const body = pkg.body
        stats.zipBytes += body.length
        res.writeHead(200, { 'content-type': 'application/zip', 'content-length': body.length })
        res.end(body)
        return
      }
      // 托管平台形状的探针：`releases/latest` 跳到那一版的页面，**地址里带着标签**。
      // 这一支要单独验，因为它是真实 GitHub 上唯一会发生的那一支：跟着跳到页面会把
      // 一整页 HTML（近 200 KB）拉回来，正文里没有 JSON，于是退回「下载整包读版本」
      // ——每次任务开头 546 KB。判据因此不能只看「版本认得出来」，必须看**没去下包**。
      if (path.endsWith('/releases/tag/tag-page')) {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><body><h1>Release v${state.tag}</h1>${'x'.repeat(2000)}</body></html>`)
        return
      }
      if (path.endsWith('/releases/latest') && opts.tagPage === true) {
        stats.api += 1
        res.writeHead(302, { location: new URL('/o/r/releases/tag/tag-page', source()).toString() })
        res.end()
        return
      }
      res.writeHead(404).end()
    })
    port.value = server.address().port
    // 包由「以这个服务端为来源」的副本导出，所以副本更新完仍然知道自己该问谁。
    const pkg = makePackage('update-newpkg', { version: '9.9.9', source: source() })

    // 一、没有新版：只比版本，**不下整包**。这是绝大多数时候走的那条路，
    //     也是「更新不该每次拖走整包」那条要求的判据。
    {
      state.tag = '0.1.0'
      const dir = makeCopy('up-to-date', { source: source() })
      resetStats()
      const r = await runUpdate(dir, '--check')
      failWith(/已是最新/.test(r.out), '版本比本地旧时报「已是最新」', r)
      report(/已是最新/.test(r.out), '比版本：认得出来')
      const lean = stats.api === 1 && stats.zip === 0
      check(lean, '没有新版时只问一次标签，一个字节的整包都没下',
        `标签请求 ${stats.api} 次、整包请求 ${stats.zip} 次`)
      report(lean, `没有新版：只发 ${stats.api} 次请求，整包 0 次`)
      check(stats.apiBytes > 0 && stats.apiBytes < 1000, '那次请求的体积是几十字节级别，不是整包',
        `${stats.apiBytes} 字节（整包 ${pkg.body.length} 字节）`)
      report(stats.apiBytes < 1000, `那次请求 ${stats.apiBytes} 字节（整包 ${pkg.body.length} 字节）`)
    }

    // 一之二、托管平台形状：`releases/latest` 跳到那一版的页面，标签就在地址里。
    //     判据是**没有去下整包**——只验「版本认得出来」的话，跟着跳到页面、把 HTML
    //     拉回来、再退回下载整包那条路也会显示通过，而那正是每次任务 546 KB 的成因。
    {
      state.tag = '9.9.9'
      opts.tagPage = true
      const dir = makeCopy('tag-page', { source: source() })
      resetStats()
      const r = await runUpdate(dir, '--check')
      opts.tagPage = false
      failWith(/有新版本 9\.9\.9/.test(r.out), '跳转地址里带着标签时，版本照样认得出来', r)
      report(/有新版本 9\.9\.9/.test(r.out), '跳转探针：版本从落点地址里读出来')
      const noPackage = stats.zip === 0
      check(noPackage, '标签从落点地址读到时，不去下整包（这一条就是「每次任务 546 KB」的判据）',
        `整包请求 ${stats.zip} 次`)
      report(noPackage, '跳转探针：一个字节的整包都没下')
    }

    // 二、有新版：整份覆盖。本地改过的内容**照样被覆盖**——这是明确的规则，
    //     不是漏判：使用者要的是「用的时候是最新版」。
    {
      state.tag = '9.9.9'
      const dir = makeCopy('overwrite', { source: source() })
      const skillPath = join(dir, 'SKILL.md')
      // 改一处包内文件、放一个包里没有的文件，然后把窗口清零（等于过了 24 小时）。
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8')
        .replace('description:', 'description: 我改过的说明。'), 'utf8')
      const marker = join(dir, 'NOTES.md')
      writeFileSync(marker, 'x\n', 'utf8')
      setWindow(dir, 0)
      resetStats()
      const r = await runUpdate(dir, '--quiet')
      failWith(/已更新到最新版 9\.9\.9/.test(r.out), '有新版时整份换成新版，并报出前后两个版本', r)
      report(/已更新到最新版/.test(r.out), '更新：版本号变了')
      const v = skillVersion(readFileSync(skillPath, 'utf8'))
      check(v === '9.9.9', '更新之后 SKILL.md 里就是新版本号', `读到 ${v}`)
      report(v === '9.9.9', '更新：磁盘上的版本号真的变了')
      const mine = readFileSync(skillPath, 'utf8').includes('我改过的说明。')
      check(!mine, '本地改动被覆盖（规则就是整份覆盖，不替使用者判断）')
      report(!mine, '更新：本地改动被覆盖')
      // 覆盖的是**包覆盖到的地方**。使用者放在同一个目录里的其它文件（笔记、自己的临时
      // 文件）不属于这个 skill，不该被它顺手删掉——那不叫覆盖，那叫越权。
      check(existsSync(marker), '包外的文件不动（覆盖的是这个 skill，不是整个目录）')
      report(existsSync(marker), '更新：包外文件保留')
      const once = stats.api === 1 && stats.zip === 1
      check(once, '这一次更新只问了标签一次、下了整包一次', `标签 ${stats.api} 次、整包 ${stats.zip} 次`)
      report(once, '更新：各请求一次，没有重复下载')
      const tells = /你之前用的是 0\.14\.0/.test(r.out)
      check(tells, '更新完把「之前是哪一版」也说出来（使用者才知道自己跳过了什么）', r.out.slice(0, 160))
      report(tells, '更新：说清了从哪一版到哪一版')
    }

    // 三、24 小时窗口：刚更新过就不换文件，但**照常比版本**，并且说出来还要等多久。
    //     这一条正是「同一份副本一天不换好几次」那条要求的判据。
    {
      state.tag = '9.9.9'
      const dir = makeCopy('window', { source: source() })
      const skillPath = join(dir, 'SKILL.md')
      setWindow(dir, 0)
      const first = await runUpdate(dir, '--quiet')
      failWith(skillVersion(readFileSync(skillPath, 'utf8')) === '9.9.9',
        '前提：窗口用例先真的更新过一次（否则下面的窗口断言没有对象）', first)
      // 退回旧版，模拟「同一版又被跑了一次」：这一次不该换文件。
      writeFileSync(skillPath, readFileSync(skillPath, 'utf8')
        .replace(/^([ \t]+version:[ \t]*)"[^"]*"/m, '$1"0.14.0"'), 'utf8')
      resetStats()
      const r = await runUpdate(dir, '--check')
      const says = /刚更新过/.test(r.out) && /之后再自动换/.test(r.out)
      check(says, '窗口内报出「刚更新过，等多久再换」', r.out.slice(0, 200))
      report(says, '窗口：说得出还要等多久')
      check(stats.api === 1 && stats.zip === 0, '窗口内只比版本，不下整包',
        `标签 ${stats.api} 次、整包 ${stats.zip} 次`)
      report(stats.api === 1 && stats.zip === 0, '窗口：不下载、不换文件')
      const stayed = skillVersion(readFileSync(skillPath, 'utf8')) === '0.14.0'
      check(stayed, '窗口内一个文件都没被换掉')
      report(stayed, '窗口：文件没动')
      check(!/已更新到最新版/.test(r.out), '窗口内不会谎报「已更新」')
      report(!/已更新到最新版/.test(r.out), '窗口：不谎报已更新')
      // 人在 --check 之外主动问时也看得到同一句话，不需要猜为什么没更新。
      const again = await runUpdate(dir)
      check(/刚更新过/.test(again.out), '默认模式下也说得出「还要等多久」', again.out.slice(0, 200))
      report(/刚更新过/.test(again.out), '窗口：默认模式不沉默')
    }

    // 四、发布方那边没有「最新发布」时：退回取整包读版本，路照样走得通。
    //     这条兜的是「平台不是 GitHub」或「还没建过 Release」——真发生时不能就此停住。
    {
      const dir = makeCopy('fallback', { source: source() })
      opts.noLatest = true
      setWindow(dir, 0)
      resetStats()
      const r = await runUpdate(dir, '--quiet')
      opts.noLatest = false
      failWith(/已更新到最新版 9\.9\.9/.test(r.out), '问不到标签时退回取整包，仍能更新到最新版', r)
      report(/已更新到最新版/.test(r.out), '退回路径：照样更新')
      check(stats.zip >= 1, '退回路径确实取了整包', `整包 ${stats.zip} 次`)
      report(stats.zip >= 1, '退回路径：取整包读版本')
    }

    // 五、下成了 GitHub 的 Source code：仓库自用文件该被清掉，否则它们会一直碍事
    //     （宿主可能把 AGENTS.md 当成这个 skill 的项目契约读进去）。
    {
      const dir = makeCopy('prune', { source: source() })
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
      writeFileSync(join(dir, '.github', 'workflows', 'check.yml'), 'x\n', 'utf8')
      mkdirSync(join(dir, 'scripts', 'dev'), { recursive: true })
      writeFileSync(join(dir, 'scripts', 'dev', 'preflight.mjs'), 'x\n', 'utf8')
      writeFileSync(join(dir, 'AGENTS.md'), 'x\n', 'utf8')
      setWindow(dir, 0)
      const r = await runUpdate(dir, '--quiet')
      failWith(skillVersion(readFileSync(join(dir, 'SKILL.md'), 'utf8')) === '9.9.9',
        '前提：清理用例真的更新过一次', r)
      const leftovers = ['.github', 'AGENTS.md', 'scripts/dev']
        .filter((f) => existsSync(join(dir, ...f.split('/'))))
      check(leftovers.length === 0,
        '更新时清掉「仓库里另有」那些文件（下成 Source code 的副本会变干净）',
        `还留着：${leftovers.join('、') || '（无）'}`)
      report(leftovers.length === 0, '清理：仓库自用文件被清掉')
      const kept = ['SKILL.md', 'scripts/update.mjs', 'scripts/survey.mjs', 'scripts/zip.mjs']
        .every((f) => existsSync(join(dir, ...f.split('/'))))
      check(kept, '清理没有连包内文件一起删掉')
      report(kept, '清理：包内文件完好')
      check(/顺手清掉了/.test(r.out), '清掉了什么，报告里说得出来')
      report(/顺手清掉了/.test(r.out), '清理：报告里说了')
    }

    // 五之二、旧版遗留的文件：**只报，不删**。
    //
    // 「这个文件旧版分发过、新版没有」与「这是使用者自己的笔记」在磁盘上长得一模一样，
    // 包里的 SKILL.md 只说得出「我现在有什么」。分不开这两种，就只能选那个不会造成损失的
    // 做法：列出来，让人自己判断。
    {
      const dir = makeCopy('stale-report', { source: source() })
      // 一个像旧版遗留的（在 `scripts/` 下、新版包里没有），一个像使用者笔记的
      // （在 `references/` 下、新版包里也没有）。
      writeFileSync(join(dir, 'scripts', 'legacy.mjs'), '#!/usr/bin/env node\nexport const LEGACY = 1\n', 'utf8')
      const mine = join(dir, 'references', 'my-own-note.md')
      mkdirSync(join(dir, 'references'), { recursive: true })
      writeFileSync(mine, '# 我的笔记\n', 'utf8')
      const rootNote = join(dir, 'my-notes.txt')
      writeFileSync(rootNote, 'mine\n', 'utf8')
      setWindow(dir, 0)
      const r = await runUpdate(dir, '--quiet')
      failWith(skillVersion(readFileSync(join(dir, 'SKILL.md'), 'utf8')) === '9.9.9',
        '前提：遗留清理用例真的更新过一次', r)
      check(/legacy\.mjs/.test(r.out), '新包里没有的文件要在报告里列出来', r.out.slice(0, 300))
      report(/legacy\.mjs/.test(r.out), '遗留：报告里列出来了')
      check(existsSync(join(dir, 'scripts', 'legacy.mjs')),
        '但只要分不清「旧版遗留」与「使用者自己放的」，就一个字节都不删')
      report(existsSync(join(dir, 'scripts', 'legacy.mjs')), '遗留：没有擅自删除')
      check(existsSync(mine), 'references/ 里的使用者文件同样保留')
      report(existsSync(mine), '遗留：references 下的笔记保留')
      check(existsSync(rootNote), '根目录的使用者文件不在清点范围里')
      report(existsSync(rootNote), '遗留：根目录文件不受影响')
    }


    // 五之三、节流的边界：`--quiet` 那条路一小时内不重复联网，人自己敲的要照旧答。
    //
    // 这条容易被写成「全都节流」——省下的正好是使用者**最有理由期待答案**的那一次：
    // 他问「有没有新版」，而回答是「刚问过所以不问了」。
    {
      const dir = makeCopy('throttle', { source: source() })
      setWindow(dir, 0)
      resetStats()
      await runUpdate(dir, '--quiet')
      const firstApi = stats.api
      check(firstApi >= 1, '前提：节流用例第一次真的联过网', `标签 ${stats.api} 次`)
      // 紧接着再跑一次（同一个状态目录，距上次不到一小时）：不该再联网。
      resetStats()
      const quietAgain = await runUpdate(dir, '--quiet')
      check(stats.api === 0 && stats.zip === 0, '一小时内再跑不重复联网（`--quiet` 那条路）',
        `标签 ${stats.api} 次、整包 ${stats.zip} 次，输出=${quietAgain.out.slice(0, 160)}`)
      report(stats.api === 0, '节流：一小时内不再联网')
      check(quietAgain.out === '', '节流时不输出（自动那条路要安静）', JSON.stringify(quietAgain.out.slice(0, 160)))
      report(quietAgain.out === '', '节流：安静')
      // 人主动问的两条路都不受节流：它们要看到「有没有新版」的当次结论。
      resetStats()
      const asked = await runUpdate(dir, '--check')
      check(stats.api >= 1 && /已是最新|有新版本/.test(asked.out),
        '`--check` 不受节流（人主动问就要当次结论）',
        `标签 ${stats.api} 次，输出=${asked.out.slice(0, 160)}`)
      report(stats.api >= 1, '节流：--check 照旧联网')
      resetStats()
      const plain = await runUpdate(dir)
      check(stats.api >= 1 && plain.out !== '', '不带参数时也不受节流（同样是人在问）',
        `标签 ${stats.api} 次，输出=${plain.out.slice(0, 160)}`)
      report(stats.api >= 1, '节流：默认模式照旧联网')
    }

    // 五之四、`PF_NO_UPDATE` 整个关掉自动检查：不联网、不写盘、不出声。
    //     宿主禁止 skill 自改、离线构建机需要的是「一次都不许连」，而不是「少连几次」。
    {
      const dir = makeCopy('no-update', { source: source() })
      setWindow(dir, 0)
      resetStats()
      const r = await runUpdate(dir, '--quiet', { env: { PF_NO_UPDATE: '1' } })
      check(stats.api === 0 && stats.zip === 0, 'PF_NO_UPDATE=1 时一次网都不联',
        `标签 ${stats.api} 次、整包 ${stats.zip} 次`)
      report(stats.api === 0, '关掉开关：不联网')
      check(r.status === 0 && r.out === '', 'PF_NO_UPDATE=1 时静默退出 0', JSON.stringify(r.out.slice(0, 160)))
      report(r.status === 0 && r.out === '', '关掉开关：静默')
      // 人主动问的那条路不受它管：一声不响地退出会让人以为开关坏了。
      resetStats()
      const asked = await runUpdate(dir, '--check', { env: { PF_NO_UPDATE: '1' } })
      check(asked.out !== '', '`--check` 不受 PF_NO_UPDATE 管（人要的是真话）',
        JSON.stringify(asked.out.slice(0, 160)))
      report(asked.out !== '', '关掉开关：--check 照旧说话')
    }

    // 五之五、**清理的授权来自代码里的结构规则，不来自下载回来的那份包**。
    //
    // 这一支走的是 `rmSync(recursive: true)`，所以「删什么」必须有本地可信的依据。
    // 依据是 `lib/protocol.mjs` 的 `REPO_ONLY_DIRS` / `REPO_ONLY_FILES`——随代码走、
    // 不随包走，伪造包改不动它。两条边界：
    //   1. 包里的内容**不能让清理删到技能目录之外**（越界防护）；
    //   2. 包里的内容**不能让清理删掉使用者的文件**（授权防护）。
    {
      const dir = makeCopy('cleanup-guard', { source: source() })
      // 邻居：一个目录（里面有文件）与一个同前缀目录——后者专测「字符串前缀」那种错判。
      const sideDir = resolve(dir, '..', 'victim')
      mkdirSync(sideDir, { recursive: true })
      writeFileSync(join(sideDir, 'important.txt'), 'IMPORTANT\n', 'utf8')
      const prefixed = resolve(dir, '..', 'project-forge-secret')
      mkdirSync(join(prefixed, 'inner'), { recursive: true })
      writeFileSync(join(prefixed, 'inner', 'precious.txt'), 'PRECIOUS\n', 'utf8')

      // 使用者的文件：任何清理都不许碰。
      const mineA = join(dir, 'my-notes.md')
      const mineB = join(dir, 'references', 'my-own-note.md')
      mkdirSync(join(dir, 'references'), { recursive: true })
      writeFileSync(mineA, '# 我的笔记\n', 'utf8')
      writeFileSync(mineB, '# 我的另一份笔记\n', 'utf8')

      // 恶意新版：在 SKILL.md 里写一张「这些文件该删」的表，并混进越界条目。
      const evil = buildPackage('cleanup-pkg', {
        version: '9.9.9', source: source(), mutate: (src) => {
          const p = join(src, 'SKILL.md')
          const text = readFileSync(p, 'utf8')
          writeFileSync(p, `${text}\n### 仓库里另有\n\n| 文件 | 何时读 |\n| --- | --- |\n`
            + '| `../victim/` | evil |\n'
            + '| `../project-forge-secret/` | evil |\n'
            + '| `my-notes.md` | evil |\n'
            + '| `references/my-own-note.md` | evil |\n', 'utf8')
        },
      })
      setWindow(dir, 0)
      const servedBefore = pkg.body
      pkg.body = evil.body
      const r = await runUpdate(dir, '--quiet')
      pkg.body = servedBefore

      const neighborKept = existsSync(sideDir) && existsSync(join(sideDir, 'important.txt'))
      check(neighborKept, '清理不许删到技能目录之外', `victim 目录还在=${neighborKept}`)
      report(neighborKept, '越界防护：邻居目录没被删')
      check(existsSync(join(prefixed, 'inner', 'precious.txt')),
        '同前缀目录（project-forge-secret）不许被当成「在之内」')
      report(existsSync(join(prefixed, 'inner', 'precious.txt')), '越界防护：同前缀目录没被删')
      check(existsSync(mineA) && existsSync(mineB),
        '包里写着「这个文件该删」不算数——授权来自代码里的结构规则，不来自包',
        `my-notes=${existsSync(mineA)} note=${existsSync(mineB)}`)
      report(existsSync(mineA) && existsSync(mineB), '授权防护：使用者的文件没被删')
    }

    // 五之六、**结构规则指到的那几处照旧清掉**。
    //
    // 缺了这一条，「下成 Source code 的副本」永远清不干净——那些副本里多出
    // `.github/`、`AGENTS.md`、`scripts/dev/` 一类只在仓库里存在的文件，留着会一直碍事。
    {
      const legacy = makeCopy('cleanup-legacy', { source: source() })
      mkdirSync(join(legacy, '.github', 'workflows'), { recursive: true })
      writeFileSync(join(legacy, '.github', 'workflows', 'check.yml'), 'x\n', 'utf8')
      writeFileSync(join(legacy, 'AGENTS.md'), '# 契约\n', 'utf8')
      mkdirSync(join(legacy, 'scripts', 'dev'), { recursive: true })
      writeFileSync(join(legacy, 'scripts', 'dev', 'preflight.mjs'), '// x\n', 'utf8')
      setWindow(legacy, 0)
      const r2 = await runUpdate(legacy, '--quiet')
      const gone = !existsSync(join(legacy, '.github'))
        && !existsSync(join(legacy, 'AGENTS.md'))
        && !existsSync(join(legacy, 'scripts', 'dev'))
      check(gone, '结构规则列过的那几处照旧清掉（\`Source code\` 副本要能变干净）',
        `还留着=${[existsSync(join(legacy, '.github')), existsSync(join(legacy, 'AGENTS.md')), existsSync(join(legacy, 'scripts', 'dev'))].join(',')}`
        + ` 输出=${r2.out.slice(0, 160)}`)
      report(gone, '清理：结构规则指到的照删')
      // 随包的脚本一个都不许被误删。
      check(existsSync(join(legacy, 'scripts', 'survey.mjs')),
        '随包的脚本不在结构规则里，清理不许动它')
      report(existsSync(join(legacy, 'scripts', 'survey.mjs')), '清理：随包脚本没被误删')
    }


    // 十、副本里读不到来源（`metadata.source` 被删掉、或宿主不认这个扩展字段）：
    //     这时走的是兜底地址，而兜底地址可以被 `PF_UPDATE_SOURCE` 改——**测试就是靠它
    //     把这一支做成确定的**：不需要真去问外网，也不依赖网络通不通。
    //
    //     这一用例同时验两件事：兜底**真的被用起来了**（把兜底改到本机服务端，它就在
    //     那儿问到了版本），以及副本自己的来源**优先于**兜底（另一条断言）。
    {
      const dir = makeCopy('no-source', {})
      opts.noLatest = true
      const r = await runUpdate(dir, '--check', { env: { PF_UPDATE_SOURCE: source() } })
      opts.noLatest = false
      const usedFallback = /有新版本 9\.9\.9/.test(r.out)
      failWith(usedFallback, '读不到来源时用兜底地址继续核对（PF_UPDATE_SOURCE 真的生效）', r)
      report(usedFallback, '无来源：兜底地址被用起来了')

      // 兜底地址可以**只有主机名、没有路径**：自建镜像与内网发布常常就是一个裸的
      // `http://host:port`。以前靠一条「主机后面必须还有一段路径」的正则判它，裸地址被
      // 静默拒绝——改环境变量的人以为指到了内网，实际还在打硬编码的那个仓库。
      // 这里连**请求路径**一起断言：地址被接受不等于拼出来的地址是对的。
      const bare = `http://127.0.0.1:${server.address().port}`
      resetStats()
      const rBare = await runUpdate(makeCopy('no-source-bare', {}), '--check',
        { env: { PF_UPDATE_SOURCE: bare } })
      const bareAccepted = /有新版本 9\.9\.9/.test(rBare.out)
      failWith(bareAccepted, '兜底地址只有主机名（没有路径）时也要被接受', rBare)
      report(bareAccepted, '无来源：裸主机名的兜底地址被接受')
      check(stats.api > 0, '裸主机名的地址拼出来的问询路径是对的（服务端真的收到了请求）',
        `约定端点收到 ${stats.api} 次请求`)
      report(stats.api > 0, '裸主机名：请求真的到了服务端')

      // 副本自己的来源优先：它指着本机服务端时，兜底指向哪儿都不该被用。
      const own = makeCopy('own-source-wins', { source: source() })
      const r2 = await runUpdate(own, '--check', { env: { PF_UPDATE_SOURCE: 'http://127.0.0.1:1/owner/repo' } })
      const ownWins = /有新版本 9\.9\.9/.test(r2.out)
      failWith(ownWins, '副本自己记的来源优先于兜底（fork 出去发版的人更新他自己的）', r2)
      report(ownWins, '来源优先级：副本自己记的优先')
    }

    // 十一、兜底也不成立时（这里是「连不上」这一支）：**如实说自己核对不了**，并给出
    //      恢复的办法。只说「无法自动核对」而不说缺哪一样、怎么补，使用者只能看到
    //      「更新不灵了」。
    {
      const dir = makeCopy('no-source-offline', {})
      const r = await runUpdate(dir, '--check', { env: { PF_UPDATE_SOURCE: 'http://127.0.0.1:1/owner/repo' } })
      const tells = /(没能联网核对|没能连上发布方)/.test(r.out) && /不是「已是最新」/.test(r.out)
      const quietEnough = !/已更新到最新版/.test(r.out)
      failWith(tells && quietEnough, '兜底也连不上时如实报「没能联网核对」，不谎报已更新', r)
      report(tells && quietEnough, '核对不了：如实说，不假装')
    }

    // 七、兜底地址必须真的是一条能拼出下载地址的仓库地址。
    //     副本里没有来源时，更新就靠它——它不成立，兜底就是假的，而现象仍然是「静默不更新」。
    {
      const path = repoPath(UPSTREAM)
      check(path !== undefined, 'update.mjs 的兜底来源是一条认得出的仓库地址', `读到的 UPSTREAM 是 ${UPSTREAM}`)
      report(path !== undefined, '兜底来源：形状可用')
      check(/^https:\/\//.test(UPSTREAM), '兜底来源是 https 地址（更新要走网络取包）', UPSTREAM)
      report(/^https:\/\//.test(UPSTREAM), '兜底来源：https')
      check(repoPath(UPSTREAM) !== undefined,
        '兜底来源归一成 owner/name 之后仍然认得出（发版门禁按这个形状比对）', repoPath(UPSTREAM))
    }

    // 七之一、仓库身份比对：三值，不是布尔。
    //
    // 判据曾是 `repoPath(a) !== repoPath(b)`。两个都认不出时它是 `undefined !== undefined`
    // = false，也就是「判为一致」——而「两个都认不出」正是最该停下的时候。
    // `git@host:owner/name` 这种 git 最常见的克隆写法当时就归一不出来，于是 fork 比对
    // 静默通过，用户包副本可能被指去别人的仓库而门禁一路绿。
    {
      const pairs = [
        ['git@github.com:acme/plain.git', 'https://github.com/acme/plain'],
        ['ssh://git@github.com/acme/x.git', 'git@github.com:acme/x'],
        ['https://user:token@github.com/acme/y.git', 'https://github.com/acme/y.git'],
      ]
      for (const [a, b] of pairs) {
        const rel = repoRelation(a, b)
        check(rel === 'same', `同一仓库的不同写法判为 same：${a}`, `得到 ${rel}`)
        report(rel === 'same', `身份归一：${a.slice(0, 26)}`)
      }

      const diff = repoRelation('https://github.com/acme/one', 'https://github.com/acme/two')
      check(diff === 'different', '不同仓库判为 different（不是「看起来像就算了」）', `得到 ${diff}`)
      report(diff === 'different', '身份归一：不同仓库')

      // 本组重点：把「没法比」读成「比过且一致」是最坏的一种失效。
      const unknown = repoRelation('not a url at all', 'also not one')
      check(unknown === 'unknown', '两个都认不出时判 unknown —— 不许当成 same', `得到 ${unknown}`)
      report(unknown === 'unknown', '身份归一：认不出报 unknown')

      const half = repoRelation('https://github.com/acme/x', '???')
      check(half === 'unknown', '只有一个认得出时也是 unknown', `得到 ${half}`)
      report(half === 'unknown', '身份归一：单边认不出')
    }

    // 七之二、问版本有两条路，按优先顺序排：认得出的托管平台先给接口路，认不出的只给
    //         网页路。**认不出就不猜**——给自建镜像硬拼一个接口地址，换来的是一句看起来
    //         像事实的「那边没有最新发布」，而正确结论是「这里问不出来」。
    //
    //         这是规则本身的断言（不发网络请求），而它值得单独验：排错一条路的现象是
    //         「更新莫名其妙不灵了」，而上面那一串用例照样全绿——它们走的都是网页路。
    {
      const gh = routesFor('https://github.com/owner/repo')
      const twoRoutes = gh.length === 2 && gh[0].kind === 'api' && gh[1].kind === 'web'
      check(twoRoutes, '托管平台形状的来源排得出两条路，接口路在前', JSON.stringify(gh))
      report(twoRoutes, '排路：托管平台给两条')
      const apiOk = gh[0].endpoint === 'https://api.github.com/repos/owner/repo/releases/latest'
      check(apiOk, '接口地址按平台公布的规律拼出来', gh[0].endpoint)
      report(apiOk, '排路：接口地址拼得对')
      const webKept = gh[1].endpoint === 'https://github.com/owner/repo/releases/latest'
      check(webKept, '网页路问的还是原来那个地址（退路不该是新的猜测）', gh[1].endpoint)
      report(webKept, '排路：网页地址没变')

      // 反例：认不出来的形状只留网页路，接口那一支完全不出现。
      const unrecognized = [
        ['自建镜像', 'http://127.0.0.1:9000/mirror'],
        ['别的托管平台', 'https://gitee.com/owner/repo'],
        ['多出几段路径', 'https://github.com/owner/repo/tree/main'],
      ]
      for (const [label, bad] of unrecognized) {
        const routes = routesFor(bad)
        check(routes.length === 1 && routes[0].kind === 'web' && apiEndpoint(bad) === undefined,
          `${label}：认不出就不给接口路（宁可少一条，也不猜一个地址出来）`, JSON.stringify(routes))
      }
      report(unrecognized.every(([, bad]) => routesFor(bad).length === 1), '排路：认不出的只给网页路')
    }

    await closeServer(server)
  }

  await main()

  // 六、连不上：退出码 0、**一个字节都不写**，并且不吵。指向本机一个没人监听的端口，
  //     连接立刻被拒——不依赖外网，也不会慢。
  //     静默的判据是「上次还核对得上」，不是「这次没连上」：后者会在网络抖一下时也出声。
  {
    const dir = makeCopy('unreachable', { source: 'http://127.0.0.1:1/owner/repo' })
    // 阈值的四分之一以前还核对得上：这属于「抖了一下」，下次再用就自己好了。
    writeState(dir, { lastUpdateAt: 0, lastOkAt: Date.now() - STALE_CHECK_MS / 4 })
    const before = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    // skill 自己在任务开头用的就是 --quiet 这一档，所以「静默」要按这一档来验。
    const r = await runUpdate(dir, '--quiet')
    check(r.status === 0, '连不上时退出码仍是 0（它挂在每个任务开头，不能把任务弄红）',
      `退出码 ${r.status}：${r.out.slice(0, 120)}`)
    report(r.status === 0, '连不上：退出码 0')
    check(r.out === '', '刚核对得上、这次没连上时保持静默（网络抖一下不该念一遍）',
      r.out.slice(0, 160))
    report(r.out === '', '连不上：偶尔一次静默')
    const forced = await runUpdate(dir, '--check')
    check(/没能联网核对/.test(forced.out) && /不是「已是最新」/.test(forced.out),
      '--check 下如实报「没能联网核对」，不说成「已是最新」', forced.out.slice(0, 160))
    report(/没能联网核对/.test(forced.out), '连不上：--check 说真话')
    check(readFileSync(join(dir, 'SKILL.md'), 'utf8') === before, '连不上时一个字节都没写')
    report(readFileSync(join(dir, 'SKILL.md'), 'utf8') === before, '连不上：零写入')
  }

  // 六之二、一直核对不上就要说出来。一路静默会被读成「一切正常」，而真相是这份停在了
  //         某一版——那正是「网络不通的人永远不知道自己落后了」的成因。判据落在「已经
  //         多久没能核对上」而不是「这次有没有连上」，所以它不会变成每次任务都念的噪音。
  {
    const stale = makeCopy('stale-speaks', { source: 'http://127.0.0.1:1/owner/repo' })
    writeState(stale, { lastUpdateAt: 0, lastOkAt: Date.now() - STALE_CHECK_MS * 3 })
    const r = await runUpdate(stale, '--quiet')
    const speaks = /没能核对新版/.test(r.out) && /不是「已是最新」/.test(r.out)
    failWith(speaks, '隔了好几天没能核对上时，--quiet 下也要说一句，并说清那不是「已是最新」', r)
    report(speaks, '连不上：隔久了会说')
    // 说完要安静一阵，否则它就从「提醒」变成了「每次任务都念一遍」。
    const again = await runUpdate(stale, '--quiet')
    check(again.out === '', '提醒过之后不再重复念（同一份副本按同一节奏才再说一次）',
      again.out.slice(0, 160))
    report(again.out === '', '连不上：说过就安静一阵')
    // 从没核对成功过也算「隔久了」：刚装上就撞上连不上，这件事本身值得知道。
    const never = makeCopy('never-checked-speaks', { source: 'http://127.0.0.1:1/owner/repo' })
    const rNever = await runUpdate(never, '--quiet')
    check(/一直没能连上发布方/.test(rNever.out) && /不是「已是最新」/.test(rNever.out),
      '从没核对成功过的副本也要说出来（新装的副本一用就撞上，不能一声不吭）',
      rNever.out.slice(0, 200))
    report(/一直没能连上发布方/.test(rNever.out), '连不上：从没成功过会说')
    // --check 是人主动问的，它每次都得说真话，不受上面那个节奏管。
    const ask = await runUpdate(stale, '--check')
    check(ask.out !== '' && /不是「已是最新」/.test(ask.out),
      '--check 每次都说真话，不因为刚提醒过就沉默', ask.out.slice(0, 160))
    report(ask.out !== '', '连不上：--check 照说')
  }

  // 七、有 .git = 源码副本：只读报告，**一个字节都不写**。
  {
    const dir = makeCopy('role-source', { withGit: true })
    const probe = join(dir, 'scripts', 'survey.mjs')
    const before = readFileSync(probe, 'utf8')
    const r = await runUpdate(dir, '--check')
    const says = /源码副本/.test(r.out) && /git pull/.test(r.out)
    check(says, '有 .git 的副本被认成源码副本，并指路 git pull', r.out.slice(0, 120))
    report(says, '源码副本：认得出')
    const untouched = readFileSync(probe, 'utf8') === before
    check(untouched, '源码副本一个字节都没被写', '文件内容变了')
    report(untouched, '源码副本：不写')
  }

  // 八、没有 .git、也没有来源 = 身份不明：这时走的是兜底地址，而**兜底地址可以被
  //     `PF_UPDATE_SOURCE` 改**——用例把它指到一个连不上的地址上，于是这一支
  //     （既没记来源、也核对不了）成为确定行为：报「没能联网核对」，不假装查过。
  //     指到外网的话这条断言会随网络抖动而变，那不是一个自检该有的性质。
  {
    const dir = makeCopy('role-nosource', {})
    const r = await runUpdate(dir, '--check', { env: { PF_UPDATE_SOURCE: 'http://127.0.0.1:1/owner/repo' } })
    const ok = /不是「已是最新」/.test(r.out) && !/已更新到最新版/.test(r.out)
    check(ok, '既没有来源也核对不了时，报「没能联网核对」并说清那不是「已是最新」', r.out.slice(0, 140))
    report(ok, '包副本：没有来源')
  }

  // 九、zip 读得动：拿 git archive 真产出的包来读，内容与磁盘逐字节一致。
  //     包从**这份 fixture 自己**产出，不从本仓库——工作区随时有未提交的改动，
  //     拿 HEAD 的包去比工作区的文件，会在每个改到一半的时刻假红。
  {
    const dir = makeCopy('zipread', { withGit: true })
    const zipPath = join(ROOT, 'zipread.zip')
    const archived = spawnSync('git',
      ['-C', dir, 'archive', '--format=zip', '--prefix=project-forge-0.14.0/', '-o', zipPath, 'HEAD'],
      { encoding: 'utf8', windowsHide: true })
    if (archived.status !== 0) {
      check(false, '前提：git archive 产得出 zip（否则下面的读包断言没有对象）',
        (archived.stderr ?? '').slice(0, 160))
      report(false, 'zip：前提')
    } else {
      const entries = stripCommonPrefix(readZip(readFileSync(zipPath)))
      const skill = entries.find((e) => e.name === 'SKILL.md')
      // 比内容，不比行尾：git archive 会按机器的 core.autocrlf 写出行尾（Windows 上是 CRLF），
      // 而库里存的是 LF。这一条要验的是「读得对」，不是「这台机器的行尾设置是什么」。
      const lf = (s) => String(s).replace(/\r\n/g, '\n')
      const ok = entries.length >= 4 && skill !== undefined
        && lf(skill.data.toString('utf8')) === lf(readFileSync(join(dir, 'SKILL.md'), 'utf8'))
      check(ok, 'zip 读得动：条目数合理，且 SKILL.md 与磁盘那一份逐字节一致（行尾除外）',
        `条目 ${entries.length}，SKILL.md ${skill === undefined ? '缺失' : '在'}`)
      report(ok, 'zip：读得动且内容一致')
      const prefixed = entries.every((e) => !e.name.startsWith('project-forge-0.14.0/'))
      check(prefixed, 'zip 读出来的路径已经去掉打包前缀（比对的是包内路径）')
      report(prefixed, 'zip：前缀已去掉')
    }
    rmSync(zipPath, { force: true })
  }

  // 九之二、前缀剥离不依赖条目顺序。
  //
  // 归档里条目的先后由写入顺序决定，第一个条目完全可能落在子目录里（`repo-1.0/assets/a.svg`）。
  // 剥前缀时若按「最后一个斜杠」切，剥出来的是一份**少了半截路径**的集合：`SKILL.md` 随之
  // 消失，调用方报的是「包里没有 SKILL.md」——而包本身完好，错的是这层剥离。
  {
    const strip = (names) => stripCommonPrefix(names.map((name) => ({ name, data: Buffer.alloc(0) })))
      .map((e) => e.name)

    const deepFirst = strip(['repo-1.0/assets/a.svg', 'repo-1.0/SKILL.md', 'repo-1.0/scripts/x.mjs'])
    const okDeep = deepFirst.includes('SKILL.md') && deepFirst.includes('assets/a.svg')
      && deepFirst.includes('scripts/x.mjs')
    check(okDeep, '首项在子目录时，前缀只剥到第一段（SKILL.md 仍在）', JSON.stringify(deepFirst))
    report(okDeep, '前缀剥离：与条目顺序无关')

    const rootFirst = strip(['repo-1.0/SKILL.md', 'repo-1.0/assets/a.svg'])
    const okRoot = rootFirst.includes('SKILL.md') && rootFirst.includes('assets/a.svg')
    check(okRoot, '首项在根时，前缀照常剥掉', JSON.stringify(rootFirst))
    report(okRoot, '前缀剥离：首项在根也成立')

    // 验不过就原样返回：宁可不剥（后面按原名找不到文件会如实报错），
    // 也不要剥出一份看起来正常、实际错位的集合。
    const mixed = strip(['repo-1.0/SKILL.md', 'other/x.md'])
    const okMixed = mixed.includes('repo-1.0/SKILL.md') && mixed.includes('other/x.md')
    check(okMixed, '条目不共享前缀时不剥（原样返回）', JSON.stringify(mixed))
    report(okMixed, '前缀剥离：不共享时不动')

    const flat = strip(['SKILL.md', 'README.md'])
    const okFlat = flat.includes('SKILL.md') && flat.includes('README.md')
    check(okFlat, '没有目录层时原样返回', JSON.stringify(flat))
    report(okFlat, '前缀剥离：无目录层')
  }

  // ── 装完之后必须验收：版本号对得上，不等于内容是好的 ──
  //
  // 这条路径没有退路：包副本是 git archive 解出来的，**没有 .git**，写坏了没有
  // git checkout 可退。而「版本号读得回来」证明不了「SKILL.md 没被截断、脚本都在」——
  // 旧写法正是在这里直接宣布成功，读不到版本时甚至拿远端版本号顶上。
  {
    const src = readFileSync(join(SKILL_ROOT, 'scripts', 'update.mjs'), 'utf8')

    check(/function verifyInstalled\(/.test(src),
      '装完验收是一个独立函数（不与写入混在一段里，才验得清）')
    report(/function verifyInstalled\(/.test(src), '装后验收：实现存在')

    check(/装完之后读不到版本号/.test(src),
      '版本号读不到时判「不健康」，而不是用远端版本号顶上')
    report(/装完之后读不到版本号/.test(src), '装后验收：读不到版本号不算成功')

    check(/if \(health\.ok\) rememberState/.test(src),
      '验收不通过时不烧掉 24 小时窗口（否则修复后要白等一天）')
    report(/if \(health\.ok\) rememberState/.test(src), '装后验收：失败不烧窗口')

    check(/包里带了的 \$\{missing\.length\} 个脚本没有落盘/.test(src),
      '包里带的脚本没落盘时要判不健康（缺共用模块会让别的脚本一跑就崩）')
    report(/包里带了的/.test(src), '装后验收：缺脚本判不健康')
  }
}

group('[37] 保鲜标记判据：好标记放行，坏标记各有断言')
{
  // 测的是 preflight 导出的纯函数，不是整次 preflight——整次跑只能看到本仓库
  // 现状，覆盖不了“坏标记长什么样”。日期相对今天算，不写死：写死的那天起，
  // 用例自己就过期了（那正是本检查要消灭的东西）。
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayMs = Date.parse(`${todayStr}T00:00:00Z`)
  const daysAgo = (n) => new Date(todayMs - n * 86400000).toISOString().slice(0, 10)
  const tomorrowStr = new Date(todayMs + 86400000).toISOString().slice(0, 10)
  const doc = (marker) => `# x\n\n## 事实来源\n\n来源略。\n\n${marker}\n`
  const run = (rel, text) => evalFreshnessMarker(rel, text, todayStr, tomorrowStr)

  // 1) 好标记：当天 → 无错无警告，scope/date/ageDays 正确。
  {
    const r = run('references/publish-npm.md', doc(`<!-- npm-verified: date=${todayStr} -->`))
    const ok = r.errors.length === 0 && r.warnings.length === 0
      && r.scope === 'npm' && r.date === todayStr && r.ageDays === 0
    check(ok, '好标记放行且读出 scope/date/age', JSON.stringify({ scope: r.scope, date: r.date, ageDays: r.ageDays }))
    report(ok, '好标记：放行')
  }

  // 2) 扩展键允许：dsh 的 host= 是合法扩展，检查只认 date。
  {
    const r = run('references/plugins/dsh.md', doc(`<!-- dsh-verified: host=9.9.9 date=${todayStr} -->`))
    const ok = r.errors.length === 0 && r.scope === 'dsh'
    check(ok, '扩展键不拦', JSON.stringify(r.errors))
    report(ok, '扩展键：允许')
  }

  // 3) 坏日期：月份 13、不存在的 2 月 30 日 → 各报一个错。
  {
    const r1 = run('references/publish-go.md', doc('<!-- go-verified: date=2026-13-40 -->'))
    const r2 = run('references/publish-go.md', doc('<!-- go-verified: date=2026-02-30 -->'))
    const ok = r1.errors.length === 1 && r2.errors.length === 1
    check(ok, '坏日期拦得住', `${r1.errors[0] ?? ''} / ${r2.errors[0] ?? ''}`)
    report(ok, '坏日期：拦得住')
  }

  // 4) 未来日期 → 错（笔误）；缺 date → 错。
  {
    const r1 = run('references/publish-go.md', doc('<!-- go-verified: date=9999-01-01 -->'))
    const r2 = run('references/publish-go.md', doc('<!-- go-verified: -->'))
    const ok = r1.errors.some((e) => /未来/.test(e)) && r2.errors.length === 1
    check(ok, '未来与缺 date 拦得住')
    report(ok, '未来/缺 date：拦得住')
  }

  // 5) scope 错位：从别的文件复制忘了改 → 点名双方。
  {
    const r = run('references/publish-npm.md', doc(`<!-- rust-verified: date=${todayStr} -->`))
    const ok = r.errors.some((e) => /rust/.test(e) && /npm/.test(e))
    check(ok, 'scope 错位点名双方', r.errors[0] ?? '')
    report(ok, '错 scope：点名')
  }

  // 6) 超期：阈值之外 → 无错、有警告且报出天数；阈值之内 → 安静。
  {
    const stale = run('references/publish-go.md', doc(`<!-- go-verified: date=${daysAgo(FRESHNESS_STALE_DAYS + 10)} -->`))
    const fresh = run('references/publish-go.md', doc(`<!-- go-verified: date=${daysAgo(FRESHNESS_STALE_DAYS - 10)} -->`))
    const ok = stale.errors.length === 0 && stale.warnings.length === 1
      && /天前/.test(stale.warnings[0]) && fresh.warnings.length === 0
    check(ok, '超期警告、期内安静', stale.warnings[0] ?? '')
    report(ok, '超期：只警告不失败')
  }

  // 7) 双标记 → 错；无标记 → 判据函数无错（“是否必需”由 preflight 按文件家族定）。
  {
    const r1 = run('references/publish-go.md', doc(`<!-- go-verified: date=${todayStr} -->\n\n<!-- go-verified: date=${todayStr} -->`))
    const r2 = run('references/publish-go.md', doc('# x\n\n## 事实来源\n\n来源略。\n'))
    const ok = r1.errors.length === 1 && r2.errors.length === 0 && r2.count === 0
    check(ok, '双标记拦、无标记不判')
    report(ok, '数量：只认恰好一个')
  }

  // 8) 标记落在节之前（结构漂移的形状）→ 错；无节有标记（悬空）→ 错。
  {
    const r1 = run('references/publish-npm.md', `<!-- npm-verified: date=${todayStr} -->\n\n## 事实来源\n\n来源略。\n`)
    const r2 = run('references/publish-npm.md', `# x\n\n<!-- npm-verified: date=${todayStr} -->\n`)
    const ok = r1.errors.some((e) => /之前/.test(e)) && r2.errors.some((e) => /悬空|没有对应/.test(e))
    check(ok, '错位与悬空拦得住')
    report(ok, '位置：必须在节末尾')
  }
}


// 这一组守的是「占位符判据按归属而不是形状」。
//
// 只看形状时两头都错：`{{ title }}` 是 Vue/Jinja 的正常语法却被判成没填完（照着做
// 就是删掉使用者的变量名），而 `<安装命令>` 这种真占位符反而看不见（工作流是空壳，
// 却说「已经干净」）。判据改成「这个名字是不是本 skill 模板里的」之后，两头都对。

group('[51b] 占位符判据：认自己家的取值名，不认别人的模板语法')
{
  const handoff = (dir, flag = '--verify') => spawnSync(process.execPath,
    [join(SKILL_ROOT, 'scripts', 'handoff.mjs'), dir, flag],
    { encoding: 'utf8', windowsHide: true })

  // 反例一：Vue / Jinja / Handlebars 的变量名 —— 一个字都不该被判成占位符。
  // 这是原先的误伤：一个正常前端项目跑 --verify 会退出 1 并被建议「填掉或删掉」。
  const vue = fixture('ho-vue', {
    'package.json': '{"name":"v","version":"1.0.0"}\n',
    'src/App.vue': '<template>\n  <h1>{{ title }}</h1>\n  <p>{{ user_name }}</p>\n</template>\n',
    'templates/card.hbs': '<div>{{ cardTitle }}</div>\n',
    'templates/page.jinja': '<h1>{{ page_title }}</h1>\n',
  })
  const rVue = handoff(vue)
  check(rVue.status === 0, '反例：Vue/Jinja/Handlebars 变量不判成未填占位符',
    String(rVue.stdout ?? '').split('\n').filter((l) => /\{\{|待处理/.test(l)).join(' | ').slice(0, 220))
  report(rVue.status === 0, '反例：别人的模板语法放行')

  // 反例二：HTML 标签、TS 泛型、比较运算里的 `<` 不能被当成占位符。
  const html = fixture('ho-html', {
    'package.json': '{"name":"h","version":"1.0.0"}\n',
    'index.html': '<div class="x"><span>hello</span><br/></div>\n',
    'a.ts': 'const x: Array<string> = []; if (a < b) {}\n',
  })
  const rHtml = handoff(html)
  check(rHtml.status === 0, '反例：HTML/JSX/泛型里的尖括号不判',
    String(rHtml.stdout ?? '').split('\n').filter((l) => /待处理/.test(l)).join(' | ').slice(0, 220))
  report(rHtml.status === 0, '反例：尖括号的普通用法放行')

  // 正例：本 skill 模板真用过的取值名 → 必须判出来。
  const real = fixture('ho-realtoken', {
    'LICENSE': 'Copyright (c) {{YEAR}} {{HOLDER}}\n',
  })
  const rReal = handoff(real)
  const caught = rReal.status === 1 && /YEAR|HOLDER/.test(String(rReal.stdout ?? ''))
  check(caught, '正例：本 skill 模板的取值名（YEAR/HOLDER）必须被判出来',
    String(rReal.stdout ?? '').split('\n').filter((l) => /待处理|占位/.test(l)).join(' | ').slice(0, 220))
  report(caught, '正例：自家取值名被抓')

  // 正例：CI 里没换掉的尖括号占位符 → 必须判出来。
  // 这是原先的漏判：把模板注释块删掉后 --verify 报「已经干净」，而工作流是空壳。
  const ci = fixture('ho-angle', {
    'package.json': '{"name":"c","version":"1.0.0"}\n',
    '.github/workflows/check.yml': [
      'name: check',
      'on:',
      '  push:',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      "      - run: '<安装命令>'",
      '',
    ].join('\n'),
  })
  const rCi = handoff(ci)
  const ciCaught = rCi.status === 1 && /安装命令/.test(String(rCi.stdout ?? ''))
  check(ciCaught, '正例：尖括号占位符（安装命令）必须被判出来',
    String(rCi.stdout ?? '').split('\n').filter((l) => /待处理|占位/.test(l)).join(' | ').slice(0, 220))
  report(ciCaught, '正例：尖括号占位符被抓')

  // 反例三：中文技术文档里的**指路写法**不能当占位符。
  // `<生产环境>`、`<部署文档>`、`<项目邮箱>` 是读者要去的地方，不是要替换的洞；
  // 判成占位符会让人去删掉自己的文档。判据收在「以操作位名词结尾」这一类上。
  const cjkDoc = fixture('ho-cjk-angle', {
    'package.json': '{"name":"d","version":"1.0.0"}\n',
    'README.md': '部署到 <生产环境> 之前先备份。反馈发到 <项目邮箱>。详见 <部署文档>。\n',
  })
  const rCjk = handoff(cjkDoc)
  check(rCjk.status === 0, '反例：中文指路写法（生产环境/部署文档/项目邮箱）不判成占位符',
    String(rCjk.stdout ?? '').split('\n').filter((l) => /待处理|占位/.test(l)).join(' | ').slice(0, 220))
  report(rCjk.status === 0, '反例：中文指路写法放行')
}


// 这一组守的是「升级之后再刷新，用户写的东西不能消失」。
//
// 判据曾经是「节标题在不在模板里」——而节标题是人和模板都会用的公共词汇，
// 「构建与验证」「版本管理」几乎人人这么起名。于是撞名时用户的正文被当成生成内容
// 整节替换掉，而那次刷新是流程里标着「强制」的一步，事后没有任何痕迹。
// 现在判据变成「这段字节是谁写的」：--upgrade 给保留下来的每一节打 pf:keep。

group('[7b] 升级后刷新：用户手写的节一个字都不能丢')
{
  const dir = fixture('upgrade-keep', {
    'package.json': '{"name":"keep-demo","version":"1.0.0","scripts":{"test":"echo ok"}}\n',
    'AGENTS.md': [
      '# 项目说明',
      '',
      '## 构建与验证',
      '',
      '我们用 Perforce 镜像，不走 git flow。这一行绝不能丢。',
      '',
      '## 版本管理（必守）',
      '',
      '发版由 release manager 手工执行，任何人不得自行打标签。',
      '',
    ].join('\n'),
  })

  compose(dir, '--upgrade')
  const upgraded = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  check(/<!--\s*pf:keep\s*-->/.test(upgraded),
    '升级时给保留下来的节打上归使用者所有的标记',
    upgraded.split('\n').filter((l) => /^##|pf:keep/.test(l)).join(' | ').slice(0, 200))
  report(/<!--\s*pf:keep\s*-->/.test(upgraded), '升级：打上 pf:keep')

  // 内核区不能被打标记：那段归内核模板独占，刷新时本来就该换。
  const kernelStart = upgraded.indexOf('project-forge:kernel:start')
  const kernelEnd = upgraded.indexOf('project-forge:kernel:end')
  const insideKernel = upgraded.slice(kernelStart, kernelEnd)
  const noKeepInKernel = !insideKernel.includes('pf:keep')
  check(noKeepInKernel, '内核区里不打 pf:keep（那段归内核独占，本就该换）')
  report(noKeepInKernel, '升级：内核区不打标记')

  // 关键断言：强制刷新之后，用户那两句话必须还在。
  compose(dir)
  const refreshed = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  const keepPerforce = refreshed.includes('Perforce')
  const keepReleaseManager = refreshed.includes('release manager')
  check(keepPerforce && keepReleaseManager,
    '刷新后用户写的正文仍然在（这正是原先静默丢失的那两行）',
    `Perforce=${keepPerforce} releaseManager=${keepReleaseManager}`)
  report(keepPerforce && keepReleaseManager, '刷新：用户正文零丢失')

  // 幂等：再刷一次不该继续变动。
  const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  compose(dir)
  const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  check(before === after, '打了标记之后刷新是幂等的')
  report(before === after, '刷新：幂等')
}

group('[18] 手工改坏的文件：一律拒绝写坏，并说清怎么修')
{
  const base = { 'package.json': JSON.stringify({ name: 'r', version: '1.0.0', scripts: { test: 'x' } }) }

  // 三态判定：手写 / 受管 / **受损**。受损必须停下——把它压进「手写」，
  // --upgrade 就会把 14KB 内核又插一遍，文件里出现两份内核，而 --check 与 --status
  // 同时报绿（--check 只看第一对标记，--status 数不到缺节）。
  const damaged = [
    ['只删掉结束标记', (t) => t.replace('<!-- project-forge:kernel:end -->', '')],
    ['只删掉开始标记', (t) => t.replace('<!-- project-forge:kernel:start -->', '')],
    ['整段内核被复制两份', (t) => {
      const S = '<!-- project-forge:kernel:start -->'
      const E = '<!-- project-forge:kernel:end -->'
      const s = t.indexOf(S)
      const e = t.indexOf(E) + E.length
      return `${t.slice(0, e)}\n${t.slice(s, e)}\n${t.slice(e)}`
    }],
  ]
  // fixture 名用**序号**，不要从中文标签里剥字母：剥完三个都是空串，于是三个用例共用
  // 同一个目录，后两个跑在被前一个改坏的文件上——测试自己就成了污染源。
  for (const [i, [label, mutate]] of damaged.entries()) {
    const dir = fixture(`damaged-${i}`, base)
    compose(dir)
    const f = join(dir, 'AGENTS.md')
    const broken = mutate(readFileSync(f, 'utf8'))
    if (broken === readFileSync(f, 'utf8')) { check(false, `${label}：测试构造失败`); continue }
    writeFileSync(f, broken, 'utf8')
    const hashBefore = readFileSync(f, 'utf8')

    const r1 = composeExpectingFailure(dir)
    const ok1 = r1.status === 2
    check(ok1, `${label} → 普通运行拒绝（exit 2）`, `exit=${r1.status}`)
    const r2 = composeExpectingFailure(dir, '--upgrade')
    const ok2 = r2.status === 2
    check(ok2, `${label} → --upgrade 也拒绝`, `exit=${r2.status}`)
    const r3 = composeExpectingFailure(dir, '--check')
    const ok3 = r3.status !== 0
    check(ok3, `${label} → --check 报失败`, `exit=${r3.status}`)
    const untouched = readFileSync(f, 'utf8') === hashBefore
    check(untouched, `${label} → 文件一个字节没动`)
    const hints = /标记受损|标记/.test(r1.stderr ?? '')
    check(hints, `${label} → 报错说明是标记问题并给出修法`)
    report(ok1 && ok2 && ok3 && untouched, `${label}：三条路径都拒绝且文件未动`)
  }

  // 正常受管文件仍应照常工作（别把守卫做得太紧）
  const good = fixture('still-works', base)
  compose(good)
  const ok4 = composeExpectingFailure(good, '--check').status === 0
  check(ok4, '正常文件仍然通过 --check')
  report(ok4, '正常文件不受影响')
}


// 这一组守的是「文档勘察按声明判，不按文件名清单判」。
//
// 固定清单一定会漏，而漏的后果不是「少报一个文件」，是**诱导去补一份不该存在的**：
// Rust 的标准双许可布局是两个 LICENSE-* 加清单里的 `license = "MIT OR Apache-2.0"`，
// 根本没有单个 LICENSE；按清单判成「缺」之后补一个，就与清单里的声明打架。

group('[10b] 文档勘察按声明判：许可证文件族与别的宿主约定文件')
{
  // 正例：双许可不该判成「缺」。
  const dual = fixture('docs-dual-license', {
    'Cargo.toml': '[package]\nname = "demo"\nversion = "0.1.0"\nlicense = "MIT OR Apache-2.0"\n',
    'LICENSE-MIT': 'MIT text\n',
    'LICENSE-APACHE': 'Apache text\n',
  })
  const sDual = survey(dual)
  check(sDual.docs?.license !== undefined, '双许可：认得出许可证存在（不判「缺」）',
    JSON.stringify(sDual.docs?.license))
  report(sDual.docs?.license !== undefined, '双许可：不判缺')
  check(Array.isArray(sDual.docs?.licenseFamily) && sDual.docs.licenseFamily.length === 2,
    '双许可：把整个文件族都报出来（上层才不会去补单个 LICENSE）',
    JSON.stringify(sDual.docs?.licenseFamily))
  report(sDual.docs?.licenseFamily?.length === 2, '双许可：文件族报全')

  // 反例：没有许可证文件时仍然是「缺」——放宽不能放到丢掉这个事实。
  const nolic = fixture('docs-no-license', {
    'package.json': '{"name":"a","version":"1.0.0"}\n',
  })
  const sNo = survey(nolic)
  check(sNo.docs?.license === undefined, '反例：确实没有许可证时，仍是「缺」')
  report(sNo.docs?.license === undefined, '反例：真缺仍是缺')

  // 正例：多份 AI 宿主约定文件要全部报出来。
  // 只认 AGENTS.md + CLAUDE.md 时，`.cursorrules` / `GEMINI.md` 里的矛盾完全看不见，
  // 而新生成的那份看起来最权威，矛盾就被永久留下了。
  const hosts = fixture('docs-hosts', {
    'AGENTS.md': 'Use pnpm.\n',
    'CLAUDE.md': 'Use yarn.\n',
    '.cursorrules': 'Use npm.\n',
    'GEMINI.md': 'Use bun.\n',
  })
  const sHosts = survey(hosts)
  const found = (sHosts.docs?.aiConventions ?? []).map((c) => c.file)
  check(found.length === 4, '多宿主：四份约定文件全部报出（不只认两个文件名）', found.join('、'))
  report(found.length === 4, '多宿主：全部报出')

  // 反例：只有一份时不该多话。
  const one = fixture('docs-one-host', { 'AGENTS.md': 'Use pnpm.\n' })
  const sOne = survey(one)
  check((sOne.docs?.aiConventions ?? []).length === 1, '反例：只有一份时不虚报')
  report((sOne.docs?.aiConventions ?? []).length === 1, '反例：单份不虚报')
}

group('[25] 交付门禁：缺项拦得住，待问消得掉')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })

  // 空项目：AGENTS 缺失 → 缺，退出码非零
  const bare = fixture('review-bare', { 'README.md': '# x\n' })
  const r1 = review(bare)
  const ok1 = r1.status !== 0 && /\[缺\]/.test(r1.stdout ?? '')
  check(ok1, '缺 AGENTS 时报缺且非零退出', `exit=${r1.status}`)
  report(ok1, '缺项：拦得住')

  // 待问全部用 flag 消掉（除 AGENTS 缺失仍是缺）→ 待问清零
  //
  // `--scope=agents` 是这里必需的一环：**「这个目录不是 git 仓库」是一条不可能被 flag
  // 消掉的待问**（它说的是「这一面没有可验的对象」，不是「用户还没决定」）。夹具目录本来
  // 就没有 `.git`，所以全量模式下它必然出现在待问里——那是真话，不是噪音。
  // 这一组测的是「flag 能不能消掉待问」，就把它限制在能验证这件事的那一面。
  const r2 = review(bare, '--scope=agents', '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok2 = !/\[待问\]/.test(r2.stdout ?? '') && /\[缺\]/.test(r2.stdout ?? '')
  check(ok2, 'flag 能消掉待问，只剩真缺项', (r2.stdout ?? '').split('\n')[0])
  report(ok2, '待问：消得掉')

  // 另一半：全量模式下「不是 git 仓库」必须说出来，不能被读成「齐备」。
  const r2b = review(bare, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok2b = /不是 git 仓库/.test(r2b.stdout ?? '')
  check(ok2b, '全量模式下「不是 git 仓库」也要报出来（没查不等于查过没问题）')
  report(ok2b, '待问：没查的会说')

  // 未知 flag 直接报错，不静默忽略
  const r3 = review(bare, '--no-whatever')
  const ok3 = r3.status !== 0 && /无法识别/.test(r3.stderr ?? '')
  check(ok3, '未知 flag 报错')
  report(ok3, '未知 flag：报错')

  // `--scope=ci` 必须真的查 CI。
  //
  // 这个切面曾经是一个空块：用户说「帮我配 CI」，AI 按协议记下范围、交付时传
  // `--scope=ci`，它回「全部齐备，可以交付」——项目一行 CI 都没有，门禁说齐了。
  // 「这个切面不查它名字里那件事」比没有这个切面更坏：它让跳过看起来像通过。
  {
    const noCi = fixture('review-scope-ci', { 'package.json': '{"name":"t","version":"1.0.0"}\n' })
    const r = review(noCi, '--scope=ci')
    const caught = /CI 缺失/.test(r.stdout ?? '')
    check(caught, '--scope=ci 在没有 CI 的项目上报缺（切面不能报绿但不查）',
      (r.stdout ?? '').split('\n').filter((l) => /CI|结论/.test(l)).join(' | ').slice(0, 220))
    report(caught, '切面 ci：真的查 CI')
    // 同一件事的另一面：有 CI 时要报「齐」，不能一概否定。
    const withCi = fixture('review-scope-ci-ok', {
      'package.json': '{"name":"t","version":"1.0.0"}\n',
      '.github/workflows/check.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    })
    const r2 = review(withCi, '--scope=ci')
    const saysOk = /工作流有/.test(r2.stdout ?? '') && !/CI 缺失/.test(r2.stdout ?? '')
    check(saysOk, '--scope=ci 在有 CI 时报「有」（不是一概否定）',
      (r2.stdout ?? '').split('\n').filter((l) => /工作流|结论/.test(l)).join(' | ').slice(0, 220))
    report(saysOk, '切面 ci：有则报有')
  }

  // 「本地齐备」不等于「远端齐备」。
  //
  // P5 的顺序是「推送 → 回跑 compose 补远端节 → 落盘 CI」，后两步发生在推送之后；
  // 不补一次提交推送，远端就永远缺它们，而本地看上去一切正常。勘察早就采到了这两个事实
  // （`dirty` / `ahead`），只是 review 从没读过——「产出了但没消费」与「没有这个能力」
  // 在报告上长得一模一样，所以要有断言钉住。
  if (!HAS_GIT) {
    skipGroup('[25] 未提交与未推送的判定', '本机没有 git')
  } else {
    const repo = join(fixture('review-dirty', {}), 'r')
    mkdirSync(repo, { recursive: true })
    gitIn(repo, 'init')
    writeFileSync(join(repo, 'a.txt'), 'x\n', 'utf8')
    gitIn(repo, 'add', '-A')
    gitIn(repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init')
    // 干净时不该报这两条
    const clean = review(repo, '--scope=git')
    const noFalse = !/未提交的改动/.test(clean.stdout ?? '')
    check(noFalse, '工作区干净时不报「未提交改动」（否则这条会变成常驻噪音）',
      (clean.stdout ?? '').split('\n').filter((l) => /未提交|干净/.test(l)).join(' | ').slice(0, 200))
    report(noFalse, '未提交：干净时不误报')
    // 有未提交改动时要报出来
    writeFileSync(join(repo, 'b.txt'), 'y\n', 'utf8')
    const dirty = review(repo, '--scope=git')
    const caught = /未提交的改动/.test(dirty.stdout ?? '')
    check(caught, '有未提交改动时报出来（本地全绿、远端缺东西的根源）',
      (dirty.stdout ?? '').split('\n').filter((l) => /未提交/.test(l)).join(' | ').slice(0, 200))
    report(caught, '未提交：报得出来')
  }

  // 凭据命中拦得住，确认为占位后 flag 消得掉（flag 本身就是用户答复的载体）。
  // 断言认的是 `[缺]` 那行而不是「凭据形状」四个字：被确认之后它会出现在 `[齐]` 里
  // 作为「已确认」的说明，认字面词就分不出「已消掉」与「仍在报缺」。
  const sec = fixture('review-secret', {
    'README.md': '# x\n',
    'src/a.py': `K = "${FAKE_GH_TOKEN}"\n`,
  })
  const r4 = review(sec, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci')
  const ok4 = /\[缺\] 凭据形状/.test(r4.stdout ?? '') && r4.status !== 0
  check(ok4, '凭据命中 → 报缺且非零退出', `exit=${r4.status}`)
  report(ok4, '凭据：拦得住')
  const r5 = review(sec, '--no-bilingual', '--no-contributing', '--private-no-license', '--no-ci', '--secrets-reviewed')
  const ok5 = !/\[缺\] 凭据形状/.test(r5.stdout ?? '')
  check(ok5, '--secrets-reviewed 消掉未跟踪未忽略的那一档', (r5.stdout ?? '').split('\n').find((l) => /凭据/.test(l)) ?? '')
  report(ok5, '确认后：消得掉')
}


// ── [48] 包自洽性：包里的相对引用必须落在包内 ────────────────────────────────

group('[48] 包自洽性：包里的相对引用必须落在包内')
{
  const clone = skillClone('selfcontained')
  const before = preflightIn(clone)
  const green = before.status === 0
  check(green, '前提：未改动的副本本来是全绿的（否则下面两条断言没有对象）',
    before.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(green, '前提：未改动副本全绿')

  // 反例一：随包分发的脚本导入了只在仓库里的脚本。
  // 这正是实测撞过的那一次：**文件集合完全正确**（39 个文件、两张表都对得上），
  // 而用户拿到的包里 compose-agents.mjs 一跑就报 ERR_MODULE_NOT_FOUND。
  //
  // 造夹具的方式是**加一行副作用导入**，不是把原有的相对导入改道。改道的写法会把
  // `survey`、`authorMarkers`、`isNoteKey` 三个绑定一起指到一个不导出它们的模块上，
  // 于是副本里 compose-agents.mjs 直接 SyntaxError——被验的 preflight 还没跑到包边界
  // 那一步就已经崩了。断言可能照样通过（它只看退出码和文案），但同一趟里行为自检也崩，
  // 那句「分片没有输出计数行」是**夹具造成的假故障**，不是被测代码的缺陷。
  // 判据要的是「包里 import 了包外的东西」，一行副作用导入就精确表达了这件事。
  const compose = join(clone, 'scripts', 'compose-agents.mjs')
  const composeBefore = readFileSync(compose, 'utf8')
  writeFileSync(compose, `${composeBefore}\nimport './dev/preflight.mjs'\n`, 'utf8')
  gitIn(clone, 'add', '-A')
  const brokenImport = preflightIn(clone, { only: "用户包边界" })
  const importCaught = brokenImport.status === 1 && /不在用户包里/.test(brokenImport.out)
  check(importCaught, '包里的脚本导入仓库自用脚本 → 当场红（「集合对、包却崩」那类问题）',
    brokenImport.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(importCaught, '反例一：包内导入越界')
  writeFileSync(compose, composeBefore, 'utf8')

  // 反例二：包里的文档把读者指到包外。同样是「集合正确、读者点开是死链」。
  const readme = join(clone, 'README.md')
  const readmeBefore = readFileSync(readme, 'utf8')
  writeFileSync(readme,
    readmeBefore.replace('https://github.com/FiretrUCK666/project-forge/blob/main/CONTRIBUTING.md', 'CONTRIBUTING.md'),
    'utf8')
  gitIn(clone, 'add', '-A')
  const deadLink = preflightIn(clone, { only: "用户包边界" })
  const linkCaught = deadLink.status === 1 && /不在用户包里/.test(deadLink.out)
  check(linkCaught, '包里的文档链接指向仓库自用文件 → 当场红（拿到包的人点了是死链）',
    deadLink.out.split('\n').filter((l) => /FAIL/.test(l)).join(' | ').slice(0, 220))
  report(linkCaught, '反例二：包内链接越界')
}

group('[17] 忽略规则：交叉核对「目录存在」与「是否已忽略」')
{
  if (!HAS_GIT) {
    skipGroup('[17] 忽略规则交叉核对', '环境里没有 git')
  } else {
    // venv 就在那里，而忽略规则没覆盖它——下一次 git add -A 会把整个虚拟环境写进历史。
    // 勘察本来两边都看得到，却不做交叉核对，于是这件事要人自己去发现。
    const gap = fixture('ignore-gap', {
      'src/a.py': 'x = 1\n',
      'venv/lib/thing.py': 'y = 2\n',
      '.gitignore': '*.pyc\n',
    })
    spawnSync('git', ['init', '-q'], { cwd: gap })
    const s = survey(gap)
    const notIgnored = s.ignores?.unignoredOutputDirs ?? []
    const ok1 = notIgnored.includes('venv')
    check(ok1, '报出「存在但未被忽略」的目录', JSON.stringify(notIgnored))
    report(ok1, 'venv 存在但未忽略 → 报出来')

    // 反向：忽略规则覆盖了它之后，就不该再报（否则成噪音，人会开始忽略这条提示）
    writeFileSync(join(gap, '.gitignore'), '*.pyc\nvenv/\n', 'utf8')
    const s2 = survey(gap)
    const ok2 = (s2.ignores?.unignoredOutputDirs ?? []).length === 0
    check(ok2, '已忽略后不再报', JSON.stringify(s2.ignores?.unignoredOutputDirs))
    report(ok2, '补上忽略规则后不再报')

    // 缺忽略文件本身也要报（没有它，产物与依赖会被提交）
    const noIgnore = fixture('ignore-none', { 'src/a.py': 'x = 1\n', 'venv/lib/y.py': 'z\n' })
    spawnSync('git', ['init', '-q'], { cwd: noIgnore })
    const md = spawnSync(process.execPath, [join(SCRIPTS_DIR, 'survey.mjs'), noIgnore, '--markdown'],
      { encoding: 'utf8' }).stdout ?? ''
    const ok3 = /忽略文件：\*\*缺\*\*/.test(md)
    check(ok3, '缺忽略文件时明确报「缺」')
    report(ok3, '缺忽略文件 → 明确报缺')
  }
}

group('[15] 非 JS 项目必须照样拿到发布那一半契约')
{
  // 判「能不能发布」时只认 package.json，会让所有非 JS 项目都被写成
  // 「本项目不对外发布」，版本号语义、抬版本号判据、发版规则全没了。
  for (const [label, files] of [
    ['Python', { 'pyproject.toml': '[project]\nname = "p"\nversion = "1.0.0"\n' }],
    ['Rust', { 'Cargo.toml': '[package]\nname = "p"\nversion = "1.0.0"\n' }],
    ['Go', { 'go.mod': 'module p\n\ngo 1.22\n' }],
  ]) {
    const dir = fixture(`pub-${label.toLowerCase()}`, files)
    compose(dir)
    const t = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    const ok1 = !/不对外发布/.test(t)
    check(ok1, `${label}：不判成「不对外发布」`)
    report(ok1, `${label}：不判成不可发布`)
    const ok2 = /^### 版本号语义$/m.test(t) && /^### 发版规则$/m.test(t)
    check(ok2, `${label}：含版本号语义与发版规则`)
    report(ok2, `${label}：含版本号语义与发版规则`)
  }
  // 反侧：private 明确不可发布 → 写“不对外发布”，且无版本号语义与发版规则
  const priv = fixture('pub-private', {
    'package.json': JSON.stringify({ name: 'p', version: '1.0.0', private: true }, null, 2),
  })
  compose(priv)
  const tp = readFileSync(join(priv, 'AGENTS.md'), 'utf8')
  const okP = /不对外发布/.test(tp) && !/^### 版本号语义$/m.test(tp) && !/^### 发版规则$/m.test(tp)
  check(okP, 'private：写不对外发布且无发版规则')
  report(okP, 'private：反侧正确')
}


// ── [53] 落盘模板自身：不能带着只有本 skill 才有的可执行调用 ───────────────────

group('[53] 落盘模板自身不得含悬空调用：模板落进别的项目后要能真的跑起来')
{
  // [48b] 判的是「模板里不许有本 skill 的路径」。这一组补另一半：**可执行上下文**。
  // 一个模板即使路径写法正确，只要 `run:` 下调用了一本项目没有的脚本，落盘后就是
  // 发版当天才红的那种失败——而它比读不到更贵。
  const ciRelease = join(SKILL_ROOT, 'templates', 'ci-release.yml')
  const text = readFileSync(ciRelease, 'utf8')

  // 逐行找出所有非注释的 `node <路径>` 调用。注释里的说明可以提，`run:` 下真的会被执行。
  const executableCalls = text.split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /^\s*node\s+\S+/.test(line))
    .filter(({ line }) => !/^\s*#/.test(line))

  const ok = executableCalls.length === 0
  check(ok, 'templates/ci-release.yml 里没有可直接执行的 node 调用（都要先换成项目自己的实现）',
    executableCalls.map(({ line, no }) => `L${no}: ${line.trim()}`).join(' | '))
  report(ok, '落盘模板：无可执行的本 skill 调用')

  // 反向：占位必须留下来，否则落盘的人会以为那一段已经写好了。
  const hasPlaceholder = /<[^<>\n]{2,60}>/.test(text.split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n'))
  check(hasPlaceholder, '落盘前后要替换的位置仍留着显式占位（不能看起来像已经写好）')
  report(hasPlaceholder, '落盘模板：占位仍在')
}


// ── 四、生态判定（防把有代码的项目判成纯文档目录） ───────────────────────────

group('[4] 生态判定：代码在子目录里也不能判成纯文档')
{
  const cases = [
    ['readme+src', { 'README.md': '# x\n', 'src/app.js': 'export const a=1\n' }, 'node'],
    ['cmake', { 'README.md': '# x\n', 'src/CMakeLists.txt': 'cmake_minimum_required(VERSION 3.10)\n', 'src/main.cpp': 'int main(){return 0;}\n' }, 'cpp'],
    ['monorepo', { 'README.md': '# x\n', 'packages/a/package.json': '{"name":"a"}\n' }, 'node'],
    ['plugin-no-manifest', { 'README.md': '# x\n', 'cordis.patch.yml': '- id: f\n' }, 'dsh-plugin'],
  ]
  for (const [name, files, expect] of cases) {
    const dir = fixture(`eco-${name}`, files)
    const kinds = survey(dir).ecosystem?.kinds ?? []
    const ok = kinds.includes(expect) && !kinds.includes('docs-only')
    check(ok, `${name} → ${expect} 且不是 docs-only`, JSON.stringify(kinds))
    report(ok, `${name} → ${expect}`)
  }
}

group('[33] 易漏生态分支：skill、损坏清单、dotnet 各有出口')
{
  // 根 SKILL.md 即 skill（被宿主加载的能力目录），不因无清单被判 unknown
  const sk = fixture('eco-skill', { 'SKILL.md': '---\nname: my-skill\ndescription: 做 X 时用\n---\n\n# my-skill\n' })
  const okS = (survey(sk).ecosystem?.kinds ?? []).includes('skill')
  check(okS, '根 SKILL.md → skill', JSON.stringify(survey(sk).ecosystem?.kinds))
  report(okS, 'skill：认出 skill')
  // 损坏的 package.json 仍按 node 处理（ corruption 是事实，不是换生态的理由）
  const bad = fixture('eco-corrupt', { 'package.json': '{oops' })
  const okC = (survey(bad).ecosystem?.kinds ?? []).includes('node')
  check(okC, '损坏清单 → 仍判 node 并带损坏证据', JSON.stringify(survey(bad).ecosystem?.kinds))
  report(okC, '损坏清单：不换生态')
  // dotnet csproj 即 dotnet，不落空
  const dn = fixture('eco-dotnet', { 'app.csproj': '<Project></Project>\n' })
  const okD = (survey(dn).ecosystem?.kinds ?? []).includes('dotnet')
  check(okD, 'csproj → dotnet', JSON.stringify(survey(dn).ecosystem?.kinds))
  report(okD, 'dotnet：认出')
}

group('[54] 宿主生态描述符：清单不叫 package.json 也要真的被读')
{
  // 这一组守的是「描述符写好了、主引擎却读不到清单」那一类：清单文件名由描述符声明，
  // 而主引擎只认 package.json 时，凡是不用 package.json 当清单的宿主（Obsidian 用
  // manifest.json）**整段事实静默为空**——报告看起来一切正常，只是少了半页。
  {
    const ob = fixture('host-obsidian', {
      'manifest.json': JSON.stringify({
        id: 'my-plugin', name: 'My Plugin', version: '1.2.3',
        minAppVersion: '1.0.0', description: 'd', author: 'a', isDesktopOnly: false,
      }),
      'main.js': 'module.exports = {}\n',
      'README.md': '# d\n',
    })
    const h = survey(ob).host
    const okId = h?.id === 'obsidian-plugin'
    check(okId, 'Obsidian 插件 → 认出宿主，且事实不是空的', JSON.stringify(h?.id))
    report(okId, 'Obsidian：认出')
    const okFacts = h?.pluginId === 'my-plugin' && h?.enginesHost === '1.0.0'
      && h?.declaredVersion === '1.2.3'
    check(okFacts, 'Obsidian：清单字段都读到了（id / minAppVersion / version）',
      JSON.stringify({ id: h?.pluginId, eng: h?.enginesHost, ver: h?.declaredVersion }))
    report(okFacts, 'Obsidian：字段读全')
  }
  // 反例：同名 manifest.json 的 PWA 不是插件。少了这一条，「读 manifest.json」可以靠
  // 「凡有 manifest.json 就当插件」满足——而到处都是 PWA。
  {
    const pwa = fixture('host-pwa', {
      'manifest.json': JSON.stringify({ name: 'App', start_url: '/', display: 'standalone' }),
      'index.html': '<!doctype html>\n',
    })
    const h2 = survey(pwa).host
    const okPwa = h2 === undefined
    check(okPwa, 'PWA 的 manifest.json（无 minAppVersion）→ 不判成插件', JSON.stringify(h2?.id))
    report(okPwa, 'PWA：不误判')
  }
  // 损坏的 manifest.json 不能把勘察打断，也不该编出一段事实。
  {
    const broken = fixture('host-broken', {
      'manifest.json': '{oops',
      'main.js': 'x\n',
    })
    const h3 = survey(broken).host
    const okBroken = h3 === undefined
    check(okBroken, 'manifest.json 损坏 → 不崩、也不编事实', JSON.stringify(h3?.id))
    report(okBroken, '损坏清单：不崩')
  }
  // VS Code 扩展：判据是 engines.vscode，事实要读到 publisher 与贡献点。
  {
    const vs = fixture('host-vscode', {
      'package.json': JSON.stringify({
        name: 'ext', version: '0.0.1', publisher: 'me', main: './out/extension.js',
        engines: { vscode: '^1.80.0' },
        contributes: { commands: [{ command: 'x.y', title: 'Y' }] },
      }),
      'out/extension.js': 'x\n',
    })
    const h4 = survey(vs).host
    const okVs = h4?.id === 'vscode-extension' && h4?.enginesHost === '^1.80.0'
      && h4?.hasPublisher === true
    check(okVs, 'VS Code 扩展：认出来并读到 engines.vscode / publisher',
      JSON.stringify({ id: h4?.id, eng: h4?.enginesHost, pub: h4?.hasPublisher }))
    report(okVs, 'VS Code：认出来')
  }
  // 没有 main 却有需要代码的贡献点 → 报警告（只告警，不断言一定加载不起来）。
  {
    const noMain = fixture('host-vscode-nomain', {
      'package.json': JSON.stringify({
        name: 'ext2', version: '0.0.1', publisher: 'me',
        engines: { vscode: '^1.80.0' },
        contributes: { commands: [{ command: 'x.y', title: 'Y' }] },
      }),
    })
    const h5 = survey(noMain).host
    const okWarn = (h5?.warnings ?? []).some((w) => /main/.test(w))
    check(okWarn, '无 main 但有需要代码的贡献点 → 报警告', JSON.stringify(h5?.warnings))
    report(okWarn, 'VS Code：缺 main 有告警')
  }
}

group('[7c] 手写契约升级：缺的节补成骨架，而不是让人手抄标题')
{
  const dir = fixture('upgrade-stub', {
    'package.json': '{"name":"stub-demo","version":"1.0.0"}\n',
    'README.md': '# stub\n',
    'AGENTS.md': ['# 项目说明', '', '## 我自己的节', '', '这一行要留。', ''].join('\n'),
  })
  compose(dir, '--upgrade')
  const text = readFileSync(join(dir, 'AGENTS.md'), 'utf8')

  // 模板里的节标题必须**全部**到齐：完成信号是逐字比对标题得出的，差一个字就到不了，
  // 而且没有任何提示说明差在哪。
  const want = [
    '## 项目定位',
    '## 架构与关键不变量',
    '## 构建与验证（改完必跑，全绿才算完成）',
    '## 硬性规范',
    '## 测试（约定）',
    '## 文档同步',
  ]
  const lacking = want.filter((h) => !text.includes(h))
  check(lacking.length === 0, '升级后模板的节标题全部到齐（不用手抄）', `缺：${lacking.join('、') || '无'}`)
  report(lacking.length === 0, '升级：节标题到齐')

  const hasAuthor = /<!--\s*pf:author/.test(text)
  check(hasAuthor, '需要人写的节补成带指引的骨架（pf:author）')
  report(hasAuthor, '升级：补的是骨架')

  const kept = text.includes('这一行要留。')
  check(kept, '升级不删用户原文')
  report(kept, '升级：原文保留')

  // 升级完 `--check` 直接通过：卡点是「待填写」，不是「缺节」。
  const chk = composeExpectingFailure(dir, '--check')
  check(chk.status === 0, '升级后 --check 直接通过（缺节不再是失败点）',
    (chk.stdout ?? '').trim().split('\n').slice(0, 2).join(' / '))
  report(chk.status === 0, '升级：--check 通过')

  // 再跑一次：节结构必须稳定（不新增、不重复）。字节级逐字相等的不变量由 [7b] 那组守着，
  // 这里只断言「不会越跑越长」——那才是用户感觉得到的退化。
  const before = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  compose(dir, '--upgrade')
  const after = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
  const heads = (t) => (t.match(/^## /gm) ?? []).length
  check(heads(before) === heads(after), '再跑一次 --upgrade 不会多出节（节结构稳定）',
    `${heads(before)} → ${heads(after)}`)
  report(heads(before) === heads(after), '升级：节结构稳定')
}

group('[25b] 问题模板：缺陷与需求的要求不同，别拿一份的标准套另一份')
{
  const review = (dir, ...a) => spawnSync(process.execPath,
    [join(SCRIPTS_DIR, 'review.mjs'), dir, ...a], { encoding: 'utf8' })
  const base = {
    'package.json': '{"name":"tpl","version":"1.0.0"}\n',
    'README.md': '# t\n',
    'AGENTS.md': '# 契约\n\n## 协作与模板\n\n提案模板见 .github/pull_request_template.md，问题时用 .github/ISSUE_TEMPLATE。\n',
    '.github/workflows/check.yml': 'on: push\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
    '.github/pull_request_template.md': '## 怎么验证\n\n## 回滚点\n',
  }
  const quiet = ['--no-bilingual', '--no-contributing', '--private-no-license']

  // 缺陷模板缺「环境」：要报出来，且报的正是缺的那一条。
  const bugDir = fixture('review-tpl-bug', {
    ...base,
    '.github/ISSUE_TEMPLATE/bug_report.md': '---\nname: 报告缺陷\nabout: 有东西不工作\n---\n\n## 期望发生什么\n\n## 实际发生什么\n\n## 怎么复现\n',
  })
  const r1 = review(bugDir, ...quiet)
  const hit = /缺这几栏：在什么环境上/.test(r1.stdout ?? '')
  check(hit, '缺陷模板缺「环境」被指出（缺哪条报哪条）',
    (r1.stdout ?? '').split('\n').filter((l) => /缺这几栏/.test(l)).join(' | ').slice(0, 200))
  report(hit, '问题模板：缺哪条报哪条')

  // 需求模板不该被要求「实际发生什么 / 在什么环境上」——拿错标准，那条提示会永远为真。
  const featDir = fixture('review-tpl-feat', {
    ...base,
    '.github/ISSUE_TEMPLATE/feature_request.md': '---\nname: 提出需求\nabout: 想要新能力\n---\n\n## 想解决什么问题\n\n## 期望的行为\n',
  })
  const r2 = review(featDir, ...quiet)
  const noBugFields = !/缺这几栏：.*(实际发生|在什么环境上)/.test(r2.stdout ?? '')
  check(noBugFields, '需求模板不被要求补缺陷报告那四要素',
    (r2.stdout ?? '').split('\n').filter((l) => /缺这几栏/.test(l)).join(' | ').slice(0, 200))
  report(noBugFields, '问题模板：不拿错标准')

  // 契约没指向 CONTRIBUTING 时要说一声；手写契约用既有开关消掉（不新增 flag）。
  const noPointer = fixture('review-agents-pointer', {
    ...base,
    'AGENTS.md': '# 契约\n\n## 构建与验证\n\nnpm test\n',
    'CONTRIBUTING.md': '# 贡献指南\n\n## 提问与反馈\n\n发 Issue。\n\n## 提出改动\n\nfork 后开拉取请求。\n\n## 提交前门禁\n\nnpm test\n\n## 许可\n\nMIT\n',
    '.github/ISSUE_TEMPLATE/bug_report.md': '---\nname: 报告缺陷\n---\n\n## 期望发生什么\n\n## 实际发生什么\n\n## 怎么复现\n\n## 环境\n',
  })
  const r3 = review(noPointer, '--no-bilingual', '--private-no-license')
  const pointed = /没有指向 CONTRIBUTING/.test(r3.stdout ?? '')
  check(pointed, '契约没指向 CONTRIBUTING 时给出待问',
    (r3.stdout ?? '').split('\n').filter((l) => /CONTRIBUTING/.test(l)).join(' | ').slice(0, 200))
  report(pointed, '契约指针：缺了会说')
  const r4 = review(noPointer, '--no-bilingual', '--private-no-license', '--handwritten-agents')
  const silenced = !/没有指向 CONTRIBUTING/.test(r4.stdout ?? '')
  check(silenced, '--handwritten-agents 能消掉这条待问（不新增开关）')
  report(silenced, '契约指针：开关消得掉')

  // Fork 模式：发布自动化是维护者那一侧的事，不该要求贡献者去配。
  const forkDir = fixture('review-fork', {
    ...base,
    'package.json': '{"name":"f","version":"1.0.0","repository":"https://github.com/upstream/f"}\n',
    'AGENTS.md': '# 契约\n\n## 协作\n\n提案模板见 .github/pull_request_template.md。\n',
  })
  if (HAS_GIT) {
    gitIn(forkDir, 'init', '-q')
    gitIn(forkDir, 'remote', 'add', 'origin', 'https://github.com/me/f.git')
    const r5 = review(forkDir, ...quiet, '--handwritten-agents')
    const quietRelease = !/发布 job 缺失/.test(r5.stdout ?? '')
    check(quietRelease, 'Fork 模式下不要求贡献者配发布自动化',
      (r5.stdout ?? '').split('\n').filter((l) => /发布/.test(l)).join(' | ').slice(0, 200))
    report(quietRelease, 'Fork 模式：不判发布')
  } else skipGroup('[25b] Fork 模式的发布判据', '环境里没有 git')

  // 凭据：内置令牌与约定 Secret 都算接上了；两者都没有才报。
  const relWorkflow = (envLine) => [
    'on:',
    '  push:',
    "    tags: ['v*']",
    'jobs:',
    '  release:',
    '    permissions:',
    '      contents: write',
    '    steps:',
    '      - run: gh release create "$TAG" --notes-file x.md',
    ...(envLine === undefined ? [] : ['        env:', `          ${envLine}`]),
  ].join('\n')

  const builtinDir = fixture('review-token-builtin', {
    ...base,
    'AGENTS.md': '# 契约\n\n## 发版\n\n发版见 RELEASING.md。协作见 .github/pull_request_template.md。\n',
    'RELEASING.md': '# 发版规范\n\n说明写在 docs/release-notes/<标签>.md。\n',
    '.github/workflows/release.yml': relWorkflow('GH_TOKEN: ${{ github.token }}'),
    '.github/ISSUE_TEMPLATE/bug_report.md': '---\nname: 报告缺陷\n---\n\n## 期望发生什么\n\n## 实际发生什么\n\n## 怎么复现\n\n## 环境\n',
  })
  const r6 = review(builtinDir, ...quiet, '--handwritten-agents')
  const noTokenComplaint = !/没接上任何凭据/.test(r6.stdout ?? '')
  check(noTokenComplaint, '用内置令牌接线时不报「没接上凭据」',
    (r6.stdout ?? '').split('\n').filter((l) => /凭据/.test(l)).join(' | ').slice(0, 200))
  report(noTokenComplaint, '凭据：内置令牌算接上')

  const noTokenDir = fixture('review-token-none', {
    ...base,
    'AGENTS.md': '# 契约\n\n## 发版\n\n发版见 RELEASING.md。协作见 .github/pull_request_template.md。\n',
    'RELEASING.md': '# 发版规范\n\n说明写在 docs/release-notes/<标签>.md。\n',
    '.github/workflows/release.yml': relWorkflow(undefined),
    '.github/ISSUE_TEMPLATE/bug_report.md': '---\nname: 报告缺陷\n---\n\n## 期望发生什么\n\n## 实际发生什么\n\n## 怎么复现\n\n## 环境\n',
  })
  const r7 = review(noTokenDir, ...quiet, '--handwritten-agents')
  const complains = /没接上任何凭据/.test(r7.stdout ?? '')
  check(complains, '完全没接凭据时报出来（否则发版当天才在日志里看到「认证失败」）')
  report(complains, '凭据：完全没有会说')
}

// ---- 分片收尾 ----// 主入口靠这一行读计数。格式固定。
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
