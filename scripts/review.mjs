#!/usr/bin/env node
/**
 * review.mjs —— 目标项目交付门禁（P4/P5 是否写完，机器说了算）
 *
 * 存在的理由：P4/P5 的完成标准里只有 AGENTS.md 有机器数（双数字归零），
 * README/双语/徽章/LICENSE/工作流全靠“汇报里写明”——没有机器门的东西，
 * AI 一忙就忘，忘了一点声音都没有。所以这里把“写完”变成可执行的检查：
 *
 *   node scripts/review.mjs <项目目录> [决策 flag...]
 *
 * 状态只有三种：
 *   [齐]   事实已满足；
 *   [缺]   事实缺失且无用户决策 → 退出码 1，必须补；
 *   [待问] 机器判不了，需要问用户 → 问完用对应的 --no-* flag 把答案记下来再跑，
 *           不允许“没问就当不要”。flag 本身就是用户答复的机器载体。
 *
 * 退出码：0 = 无[缺]（默认模式有[待问]也退出 0，结论写明还有待问）；1 = 有[缺]；
 *          2 = 用法错误、勘察失败，或 --strict 拦下[待问]。
 * 只读（会跑 check-badges 联网验徽章；没查完时如实报「未核对」，绝不读成通过）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey, authorMarkers, isMainModule } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const KERNEL_START = '<!-- project-forge:kernel:start -->'
const KERNEL_END = '<!-- project-forge:kernel:end -->'

const FLAGS = new Set([
  '--no-bilingual', // 用户确认：单语即可，不要英文版
  '--no-contributing', // 用户确认：自用项目，不要贡献指南
  '--private-no-license', // 用户确认：保留所有权利，不落盘 LICENSE
  '--no-ci', // 用户确认：暂不要 CI
  '--no-auto-release', // 用户确认：暂不要自动发布
  '--secrets-reviewed', // 用户确认：未跟踪未忽略的命中均为占位或测试数据（已入库那一档不在此列）
  '--strict', // 严格模式：待问事项同样拦住（exit 2），用于 CI；默认待问只提示不拦
])

function readText(p) {
  try {
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

function parseArgs(argv) {
  const positional = []
  const flags = new Set()
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (a.startsWith('--')) {
      if (!FLAGS.has(a)) throw new Error(`无法识别的参数：${a}（可用：${[...FLAGS].join('、')}）`)
      flags.add(a)
      continue
    }
    positional.push(a)
  }
  return { target: positional[0] ?? process.cwd(), flags }
}

/**
 * 徽章检查的结论行（check-badges.mjs 输出）与退出码的对应关系。
 *
 * 判定**只认这一行与退出码**，不去嗅探人话：子进程崩掉时（坏 gzip 在未包裹的
 * `res.text()` 上抛 `TypeError: terminated`）输出里一条结论字样都没有，而按文字
 * 嗅探分不清「没有结论」与「没问题」，猜错的方向就是把崩溃读成通过。拿不到结论行、
 * 或结论行与退出码不一致，一律判「没查完」。
 */
const BADGE_STATE_RE = /check-badges: state=(ok|bad|unverified|nobadge)\b/
const BADGE_EXPECT_EXIT = { ok: 0, nobadge: 0, bad: 1, unverified: 3 }

/**
 * 由子进程原始输出与退出码推出徽章结论。纯函数，供 selftest 直接喂数据证伪。
 * 返回 { state: 'ok'|'bad'|'unverified'|'nobadge', why }。
 */
export function badgeVerdict(stdout, stderr, status) {
  const out = `${stdout ?? ''}\n${stderr ?? ''}`
  const m = BADGE_STATE_RE.exec(out)
  if (m === null) return { state: 'unverified', why: `子进程没有给出结论行（退出码 ${status}）` }
  if (BADGE_EXPECT_EXIT[m[1]] !== status) {
    return { state: 'unverified', why: `结论行说 ${m[1]}，退出码却是 ${status}` }
  }
  return { state: m[1], why: '' }
}

/**
 * 凭据命中按处置分档。纯函数，供 selftest 直接喂数据证伪。
 *
 * 判据来自版本管理那套分案（version-control.md 的密钥门控、SKILL.md 的 G2）：
 *   tracked=true               → blocking（已在版本库里，只能移除并轮换）
 *   tracked=false, ignored=true→ safe（不进版本库；这是 .gitignore 里 .env 的正常形态）
 *   tracked=false, ignored≠true→ blocking（`git add -A` 会把它带进去）
 * 注意 `ignored` 为 undefined 时按「未忽略」处理——没证据就当没被忽略，
 * 免得勘察拿不到忽略比特时这里悄悄放行。
 */
export function tierSecrets(hits) {
  const list = Array.isArray(hits) ? hits : []
  const tracked = list.filter((h) => h.tracked === true)
  const safe = list.filter((h) => h.tracked !== true && h.ignored === true)
  const exposed = list.filter((h) => h.tracked !== true && h.ignored !== true)
  // 保守方向：读不到仍按最坏情况算进 blocking——凭据误信「未忽略」就等于把它提交进
  // 历史，而拦下来只是多看一眼。但**报告文案不能陈述一个没验证过的事实**：把读不到
  // 的那批与「读到确实没忽略」分开，前者要的处置是手工核对，后者才是加 flag。
  const unknown = exposed.filter((h) => h.tracked === undefined || h.ignored === undefined)
  const confirmed = exposed.filter((h) => h.tracked !== undefined && h.ignored !== undefined)
  return { tracked, safe, exposed, unknown, confirmed, blocking: [...tracked, ...exposed] }
}

/**
 * 三态比特的分档。`true` / `false` / `undefined`（读不到）的正确处置各不相同：
 * 读到的可以按事实判，读不到的必须让人**手工核对**。并进 `false` 会让人对一个没
 * 验证过的判断采取行动，方向还可能是反的。
 *
 * 只负责分开数。保守方向由调用点自己定——凭据那边偏严、私有路径那边偏松。
 */
function splitTri(list, bit) {
  const arr = Array.isArray(list) ? list : []
  return {
    yes: arr.filter((h) => bit(h) === true),
    no: arr.filter((h) => bit(h) === false),
    unknown: arr.filter((h) => bit(h) === undefined),
  }
}

/**
 * 契约里「作者自己写的那部分」——内核标记之外的正文。
 *
 * 注入的内核由 `templates/agents-kernel.md` 独占，它自带「远端」「发布」「版本」这些词。
 * 判「这份契约有没有写清远端与发版」时若按全文判，内核会替作者答上来，判据于是恒真。
 * 没有结束标记时（手写文件）返回全文——那时没有内核可依赖，全文就是作者的部分。
 */
export function outsideKernel(text) {
  const s = String(text ?? '')
  const at = s.indexOf(KERNEL_END)
  if (at < 0) return s
  return s.slice(at + KERNEL_END.length)
}

/**
 * 这个门禁**已经消费**的风险类别。新增一类风险时，这里与下面的处理必须一起加：
 * 只加 survey 的字段、不在门禁里落结论，新类别就会悄悄没人管（下一个维护者
 * 一定会忘）。所以判据不是「这里有没有写」，而是「survey 报的每个键都在这个集合里」，
 * 缺一个就报「未处理的风险类别」——由 unhandledRiskKeys 兜底。
 */
export const HANDLED_RISK_KEYS = new Set([
  'secretFiles', 'secretContent', 'contentScan', 'homePathLeaks', 'largeFiles', 'symlinks', 'nestedRepos',
])

/** 勘察报了、但门禁没有落结论的风险类别。纯函数，供 selftest 直接喂数据证伪。 */
export function unhandledRiskKeys(risks) {
  return Object.keys(risks ?? {}).filter((key) => !HANDLED_RISK_KEYS.has(key))
}

/** 跑徽章检查。返回 ok / bad / unverified / nobadge 四态，不抛错。 */
function checkBadges(root, readmes) {
  if (readmes.length === 0) return { state: 'nobadge' }
  const r = spawnSync(process.execPath, [join(HERE, 'check-badges.mjs'),
    ...readmes.map((f) => join(root, f))], { encoding: 'utf8' })
  return badgeVerdict(r.stdout, r.stderr, r.status)
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(
      '用法：node scripts/review.mjs <项目目录> [--no-bilingual] [--no-contributing]\n'
      + '      [--private-no-license] [--no-ci] [--no-auto-release] [--secrets-reviewed] [--strict]\n\n'
      + '  无[缺]即退出码 0。[待问]必须问用户后用对应 flag 消掉，不许默跳。\n'
      + '  默认[待问]不拦（exit 0 但结论写“还有待问”）；--strict 下[待问]同样拦住（exit 2），用于 CI。\n'
      + '  --secrets-reviewed 只覆盖「未跟踪且未忽略」的命中；已经进了版本库的凭据改文件不解决，\n'
      + '  任何 flag 都不消那一档——从索引移除并轮换。\n'
      + '  无对应 flag 的[待问]（徽章没查完、DSH 挂载建议、英文模板、纯文档构建命令、扫描未覆盖范围）只能改文件消掉。\n',
    )
    return 0
  }
  const { target, flags } = parsed
  const root = resolve(target)

  let s
  try {
    s = survey(root)
  } catch (error) {
    process.stderr.write(`勘察失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const missing = []
  const pending = []
  const ok = []
  const line = (st, text) => process.stdout.write(`  [${st}] ${text}\n`)
  process.stdout.write(`交付门禁：${s.target.name}（${s.target.path}）\n`)

  // 1. AGENTS.md：一致性真相源是 compose --check 的字节比对，本门只转述。
  // 自己另起一套“有标记即一致”必然漂移其一，故不自判，只调用。
  const agentsPath = join(root, 'AGENTS.md')
  const agents = readText(agentsPath)
  if (agents === undefined) {
    missing.push('AGENTS.md 缺失')
  } else {
    // 待填写的数法**只有一处实现**：survey 导出的 authorMarkers（整篇扫描）。
    // 若两处各写一份扫描（一个逐行、一个整篇），同一份文件在多行标记下会得到
    // 两个互相矛盾的结论——所以数法必须共用这一份。
    const authors = authorMarkers(agents).length
    const kernel = agents.includes(KERNEL_START) && agents.includes(KERNEL_END)
    if (!kernel) {
      missing.push('AGENTS.md 缺少内核标记（跑 compose-agents 生成或升级）')
    } else if (authors > 0) {
      missing.push(`AGENTS.md 待填写 ${authors} 处（读代码填实，删标记）`)
    } else {
      const cc = spawnSync(process.execPath, [join(HERE, 'compose-agents.mjs'), root, '--check'],
        { encoding: 'utf8' })
      const ccOut = `${cc.stdout ?? ''}\n${cc.stderr ?? ''}`
      if (cc.status !== 0) {
        const first = ccOut.split('\n').map((l) => l.trim()).filter(Boolean)
          .find((l) => /缺失|不一致/.test(l)) ?? '与模板不一致或有缺节'
        missing.push(`AGENTS.md 未通过 compose --check：${first}（跑 compose-agents 补齐重验）`)
      } else {
        ok.push('AGENTS.md 通过 compose --check（内核一致、待填写归零）')
      }
    }
  }

  // 2. 提交署名：没有仓库时跳过（P3 建库时再定）；有仓库而署名缺失必须补——
  // 否则首个提交永久带着错误署名。占位值靠人眼（G7），机器只卡缺失。
  const git = s.git ?? {}
  if (git.present === true) {
    const id = git.identity ?? {}
    if (!id.name || !id.email) {
      missing.push('提交署名缺失（只写仓库级，见版本管理署名审计清单）')
    } else {
      ok.push(`提交署名有（${id.name}，${id.scope === 'repo' ? '仓库级' : '继承全局'}；占位值须人眼确认）`)
    }
  }

  // 2b. 上游跟踪：有远端而未设跟踪时，首推需显式指定。只提示，不阻断。
  if (git.present === true && typeof git.remote === 'string' && git.remote.length > 0
    && git.upstream === undefined && git.isRepoRoot !== false) {
    pending.push('上游跟踪未设置：首推用显式分支并设跟踪（改文件消不掉，推一次即有）')
  }

  // 2b-2. 「P5 之后强制回跑 P4」这条规则以前没有任何机器落点：有远端却与发布无关的
  // 契约照样交付，用户拿到的 AGENTS.md 永远缺发布那半部分。判据是**事实 + 文本**
  // 两条都有：有远端（`git.remote` 非空）时，契约里必须提到远端与发布/标签——
  // 否则那次回跑没做。中英文都认，避免语言假设。
  //
  // 只看**内核标记之外**的正文。注入的内核自带「远端」「发布」这些词（「本文件的定位
  // 与编辑规则」那张表、还有「最小可用…不为未来需求提版本」里的「版本」），按全文判
  // 等于拿内核给自己作证：一份删到只剩内核的契约照样通过，这条检查对每一个由本
  // skill 生成的项目都是死代码，而它本该是这条规则唯一的机器落点。
  if (git.present === true && typeof git.remote === 'string' && git.remote.length > 0
    && git.isRepoRoot !== false && agents !== undefined) {
    const body = outsideKernel(agents)
    const hasRemoteText = /远端|remote|origin|推送|push/i.test(body)
    const hasReleaseText = /发布|release|标签|tag/i.test(body)
    if (!hasRemoteText || !hasReleaseText) {
      const lack = [!hasRemoteText ? '远端/推送' : null, !hasReleaseText ? '发布/标签' : null]
        .filter((x) => x !== null).join('与')
      missing.push(`AGENTS.md 的内核之外缺${lack}部分（有远端就必须写清怎么推、怎么发版：`
        + 'P5 之后要回跑 P4 的 compose-agents）')
    }
  }

  // 2c. 标签与版本号：只报事实比对，不下结论（形生态各异，见 publish.md）。
  if (s.artifacts?.declaredVersion !== undefined && s.artifacts?.versionAligned === false) {
    pending.push(`标签与版本号未对齐：清单 ${s.artifacts.declaredVersion}，标签 ${(s.artifacts.versionAlignedTags ?? []).join('、') || '无'}（自动化会对不上，先确认）`)
  }

  // 2d. 密钥与扫描可信度。**按分案判，不再一律报缺**（判据与 version-control.md 的
  // 密钥门控同源，SKILL.md 的 G2 也写「未跟踪排除、已历史轮换、占位继续」）：
  //   - 已跟踪（已经在版本库里）→ 缺：只能从索引移除并轮换凭据；
  //   - 未跟踪且**已被忽略** → 报「齐」：这是最常见的正常形态（.gitignore 里的 .env），
  //     一律报缺会把门禁变成噪音，操作者的对策就是条件反射式加 flag——安全信号被稀释；
  //   - 未跟踪且未被忽略 → 缺：`git add -A` 会把它带进历史。
  const risks = s.risks ?? {}
  const secretHits = [...(risks.secretFiles ?? []), ...(risks.secretContent ?? [])]
  const secretTiers = tierSecrets(secretHits)
  // flag 的效力按**处置档**分开：`--secrets-reviewed` 的语义是「这一处是占位或测试数据」，
  // 而「已经进了版本库」不在这个语义里——那一档的处置是从索引移除并轮换，没有「确认一下
  // 就算了」这个选项。所以它只覆盖 `exposed`（未跟踪未忽略），`tracked` 永不被 flag 消。
  // 否则一个 flag 就能把「凭据已写进 git 历史」读成「全部齐备」，纪律挡不住机制缺失。
  if (secretTiers.confirmed.length > 0) {
    if (flags.has('--secrets-reviewed')) {
      ok.push(`未跟踪未忽略的凭据 ${secretTiers.confirmed.length} 处已确认为占位或测试数据（不进版本库）`)
    } else {
      missing.push(`凭据形状 ${secretTiers.confirmed.length} 处（未跟踪且未忽略，下次提交会带进历史；`
        + '确认为占位或测试数据时加 --secrets-reviewed，位置见勘察报告）')
    }
  }
  if (secretTiers.unknown.length > 0) {
    missing.push(`凭据形状 ${secretTiers.unknown.length} 处无法确认是否已入库或被忽略（受控文件清单没取到，`
      + '常见于仓库过大或版本控制不可用）：已按最坏情况拦下，但**先手工核对再处置**——'
      + '加 --secrets-reviewed 会消掉一个可能真的没问题的项，也可能放走一个真的会进历史的项')
  }
  if (secretTiers.tracked.length > 0) {
    missing.push(`凭据形状 ${secretTiers.tracked.length} 处已在版本库里（git 历史已含它，`
      + '改文件不解决问题）：从索引移除并轮换该凭据后重跑；这不是 flag 能消的一项')
  }
  if (secretTiers.safe.length > 0) {
    ok.push(`未跟踪且已被忽略的敏感文件 ${secretTiers.safe.length} 处（不进版本库就不拦；确认忽略规则真的覆盖它们）`)
  }
  // 扫描覆盖：**「没扫到」必须与「扫过没命中」可区分**。截断、超体积、扩展名黑名单、
  // 读失败、非 UTF-8——五类都进这一条，任何一类非零都要问一句，不能读成干净。
  const scan = risks.contentScan ?? {}
  const uncovered = []
  if (scan.truncated === true) uncovered.push('文件数达上限被截断')
  if (typeof scan.skippedLarge === 'number' && scan.skippedLarge > 0) uncovered.push(`${scan.skippedLarge} 个文件超过单文件上限未扫`)
  if (typeof scan.skippedByExtension === 'number' && scan.skippedByExtension > 0) uncovered.push(`${scan.skippedByExtension} 个文件按扩展名跳过`)
  if (typeof scan.unreadable === 'number' && scan.unreadable > 0) uncovered.push(`${scan.unreadable} 个文件读不出来（权限或占用）`)
  if (typeof scan.notUtf8 === 'number' && scan.notUtf8 > 0) uncovered.push(`${scan.notUtf8} 个文件不是 UTF-8（编码未嗅探）`)
  if (typeof scan.depthLimited === 'number' && scan.depthLimited > 0) uncovered.push(`${scan.depthLimited} 个子目录因嵌套过深未进入`)
  if (uncovered.length > 0) {
    pending.push(`内容扫描有未覆盖范围（${uncovered.join('；')}）——“无命中”不可信，写明覆盖范围或提高上限重扫`)
  }

  // 2d-2. 其余风险类别：**逐类落结论，不许沉默**。
  // 这里做成表驱动并带兜底：勘察将来新增一类风险而这里没处理，下面那条兜底会把它
  // 报成待问——「加了字段但没人消费」不会再悄悄发生。
  for (const key of unhandledRiskKeys(risks)) {
    pending.push(`勘察报了未处理的风险类别「${key}」：新类别必须在交付门禁里落一个结论（缺 / 待问），不能沉默`)
  }
  const allLeaks = (risks.homePathLeaks ?? []).filter((h) => h.kind === 'leak')
  // 已被忽略规则覆盖的本机路径不进版本库：与凭据同一分案，报事实但不拦。
  // 否则一个只在本机存在、且已忽略的状态文件（工具生成的那种）会让门禁永远叫喊。
  // 读不到忽略状态时归「待问」而不是「缺」：路径本身确实该改，但**是否已经暴露**
  // 是没验证过的，不该用「缺」这种断言语气。
  const leakBits = splitTri(allLeaks, (h) => h.ignored)
  if (leakBits.no.length > 0) {
    missing.push(`本机私有路径 ${leakBits.no.length} 处（换台机器就失准，也可能已经暴露了目录结构；改成相对路径或环境变量）`)
  }
  if (leakBits.yes.length > 0) {
    pending.push(`本机私有路径 ${leakBits.yes.length} 处已被忽略规则覆盖（不进版本库；确认忽略规则真的覆盖它们）`)
  }
  if (leakBits.unknown.length > 0) {
    pending.push(`本机私有路径 ${leakBits.unknown.length} 处无法确认是否已被忽略规则覆盖（请手工核对；改法同上）`)
  }
  const big = splitTri(risks.largeFiles, (f) => f.tracked)
  if (big.yes.length > 0) {
    missing.push(`已在版本库里的大文件 ${big.yes.length} 个（≥20MB，克隆与历史都会长期承担；先确认该不该入库）`)
  }
  if (big.no.length > 0) {
    pending.push(`未跟踪的大文件 ${big.no.length} 个（≥20MB；提交前先决定忽略还是入库）`)
  }
  if (big.unknown.length > 0) {
    pending.push(`大文件 ${big.unknown.length} 个无法确认是否已入库（受控文件清单没取到；请手工核对）`)
  }
  if (Array.isArray(risks.symlinks) && risks.symlinks.length > 0) {
    pending.push(`符号链接目录 ${risks.symlinks.length} 个未进入扫描（链接指向仓库外时不该扫；确认里面没有该查的东西）`)
  }
  if (Array.isArray(risks.nestedRepos) && risks.nestedRepos.length > 0) {
    pending.push(`嵌套仓库 ${risks.nestedRepos.length} 个（子目录里另有 .git；确认是有意为之，否则它不会被外层仓库跟踪）`)
  }

  // 2e. 忽略规则：未忽略的产物目录与“已跟踪又被忽略”是提交前必须消掉的两项。
  const ig = s.ignores ?? {}
  if (Array.isArray(ig.unignoredOutputDirs) && ig.unignoredOutputDirs.length > 0) {
    missing.push(`未忽略的产物目录：${ig.unignoredOutputDirs.join('、')}（下次提交会整个写进历史，先补忽略规则）`)
  }
  if (Array.isArray(ig.ignoredButTracked) && ig.ignoredButTracked.length > 0) {
    pending.push(`已被跟踪又被忽略 ${ig.ignoredButTracked.length} 个（忽略对它们无效，需从索引移除；确认后逐个处理）`)
  }
  if (ig.gitattributes === undefined && git.present === true) {
    pending.push('文本属性声明缺失：首次提交前补上，否则跨机器产物字节不可复现')
  }
  // 3. README：必须有；双语要么成对，要么用户明确说单语。
  const readmes = s.docs?.readme ?? []
  if (readmes.length === 0) {
    missing.push('README 缺失')
  } else {
    ok.push(`README 有（${readmes.join('、')}）`)
    if (s.docs?.readmePair !== undefined) ok.push('双语 README 成对')
    else if (flags.has('--no-bilingual')) ok.push('单语（用户已确认不要英文版）')
    else pending.push('双语：只有一份 README，问用户要不要英文版（要→补，不要→加 --no-bilingual）')
  }

  // 4. 徽章：有就必须验（联网跑 check-badges）；没有徽章不强求。
  // 「没查完」与「查过且可显示」是两回事——第三态走待问，绝不并进齐。
  const badgeResult = checkBadges(root, readmes)
  if (badgeResult.state === 'bad') missing.push('徽章显示不出来（见上文输出，删掉或修好）')
  else if (badgeResult.state === 'unverified') pending.push(`徽章没能查完（${badgeResult.why}）：在汇报里写明未验及原因，不要读成通过`)
  else ok.push(badgeResult.state === 'ok' ? '徽章全部可显示' : '无徽章（可选，不强求）')

  // 5. CONTRIBUTING / LICENSE：缺了必须问，不能默跳；有了要看内容是否齐全。
  //
  // 内容判据**必须语言无关**：写 CONTRIBUTING 的人用哪种语言是他的自由，而门禁
  // 用中文关键词会让一份合格的英文贡献指南被判三处缺（实测过），于是「合格产物
  // 过不了门」——那比不判更坏。所以每条判据都同时认中英文，且大小写不敏感；
  // 只与项目约定有关的指向（例如 AGENTS.md）降为待问，不当成缺失。
  if (s.docs?.contributing !== undefined) {
    ok.push('CONTRIBUTING 有')
    const contributingFile = typeof s.docs.contributing === 'string'
      ? s.docs.contributing
      : s.docs.contributing.file
    const contributing = readText(join(root, contributingFile)) ?? ''
    const coreChecks = [
      [/提问|问题|反馈|issue|question|feedback|support|discussion|help/i, '提问与反馈'],
      [/fork/i, 'fork 指引'],
      [/分支|branch/i, '分支指引'],
      [/门禁|全绿|测试|构建|check|test|build|verify|ci\b|lint|gate/i, '提交前门禁'],
      [/许可|licen[cs]e/i, '许可'],
    ]
    for (const [re, label] of coreChecks) {
      if (!re.test(contributing)) {
        missing.push(`CONTRIBUTING 缺${label}（补对应节，见 docs-set 第五节通用骨架；中英文皆可）`)
      }
    }
    if (!/AGENTS\.md/.test(contributing)) {
      pending.push('CONTRIBUTING 未指向 AGENTS.md：项目契约在哪、改动前先读什么，写清楚更省事（不是缺失，按项目习惯定）')
    }
    const kinds = s.ecosystem?.kinds ?? []
    const isNode = kinds.includes('node')
    const isPlugin = kinds.some((k) => /plugin|extension/.test(k))
    const isDsh = kinds.includes('dsh-plugin')
    const isDocsOnly = kinds.includes('docs-only')
    if (isNode && !/(npm|pnpm|yarn|bun|安装依赖|安装|dependenc|install)/i.test(contributing)) {
      missing.push('CONTRIBUTING 缺包管理器或安装说明（node 项目：沿用它自己的包管理器）')
    }
    if (isPlugin) {
      if (!/(产物|一起提交|artifact|commit.*build|build.*artifact|dist)/i.test(contributing)) {
        missing.push('CONTRIBUTING 缺产物同提交（插件类：安装方不构建，产物缺了即加载失败）')
      }
      if (!/(主干|标签|发布|main|tag|release|publish)/i.test(contributing)) {
        missing.push('CONTRIBUTING 缺三类越权（不推主干、不打标签、不发布）')
      }
    }
    if (isDsh && !/(挂载|重启|刷新|分发)/.test(contributing)) {
      pending.push('CONTRIBUTING 可补本地挂载与生效规则（DSH 插件：两条路差别是最高频问题）')
    }
    if (isDocsOnly && /```sh[\s\S]*?(npm|pnpm|cargo|pytest|go test)/.test(contributing)) {
      pending.push('纯文档项目的 CONTRIBUTING 含构建命令：确认是否真的需要开发环境节')
    }
  }
  else if (flags.has('--no-contributing')) ok.push('无 CONTRIBUTING（用户已确认自用）')
  else pending.push('CONTRIBUTING 缺失：问用户会不会给别人用（会→补，不会→加 --no-contributing）')
  if (s.docs?.license !== undefined) ok.push('LICENSE 有')
  else if (flags.has('--private-no-license')) ok.push('无 LICENSE（用户已选保留所有权利）')
  else pending.push('LICENSE 缺失：问用户选哪个许可证（保留权利→加 --private-no-license）')

  // 6. 工作流：CI 与自动发布要么落盘，要么用户明确说暂不要。
  // 6b. DSH 插件：只在判定为 dsh-plugin 时检查，不猜取值。
  const dshKinds = s.ecosystem?.kinds ?? []
  if (dshKinds.includes('dsh-plugin') && s.dsh !== undefined) {
    const d = s.dsh
    if (d.filesHasLib === false) missing.push('DSH 发布范围缺 lib（成品包路线要求 files 含构建产物，以 pack 清单为准）')
    if (d.filesHasPatch === false) missing.push('DSH 发布范围缺补丁（声明 bundle 时 files 应含补丁文件）')
    if (d.libTracked === true && d.filesHasLib !== true) {
      missing.push('DSH 产物跟踪与发布范围矛盾：lib 被跟踪但 files 未含，先定成品还是源码路线')
    }
    if (d.hostRuntimeInDeps === true) missing.push('DSH 依赖放错：宿主运行时进了 dependencies，应为 peer')
    if (d.discoveryCarrierLikely === false) {
      missing.push('DSH 发现载体可能缺失：补丁文本里没有出现包名（补 name 等于包名自身的一行）')
    }
    if ((d.hasClientEntry === true) !== (d.hasClientDecl === true)) {
      pending.push('DSH 三态不明：exports 与 dsh.client 声明打架，先对齐再定 host-only 还是双面')
    }
  }
  // 非 DSH 插件：无专属门禁，按通用协议六问核对产物与标识（无专章时现场查宿主文档）。
  // Obsidian 项目在上面已有附件与触发器两条待问，这里不再重复通用提示。
  if (dshKinds.some((k) => /plugin|extension/.test(k)) && !dshKinds.includes('dsh-plugin')
    && !dshKinds.includes('obsidian-plugin')) {
    pending.push('非 DSH 插件：按通用协议核对产物同提交、两标识与挂载分发两条路（见 plugin-project.md）')
  }
  // Obsidian 发布链：四件事各有各的判据，不要压成一句“缺 main.js 即断链”——
  //   旧判据把“仓库根无 main.js”直接报缺，而官方模板要求它只进发布附件不进库，
  //   于是按官方模板做的项目永远过不了门。正确分工：
  //   缺 = 仓库侧事实缺（manifest id 形状非法——提交审核会被拒）；
  //   待问 = 附件侧只能人去看发布页（附件齐不齐、tag 与版本三方一致、触发器是不是裸版本）。
  if (dshKinds.includes('obsidian-plugin') && s.artifacts?.obsidianArtifacts !== undefined) {
    const o = s.artifacts.obsidianArtifacts
    if (o.manifestIdShapeOk === false) {
      missing.push(`Obsidian 插件 id 形状非法：${o.manifestId ?? '（读不到）'}（应为小写字母与连字符、不含 obsidian、不以 plugin 结尾，提交审核会被拒）`)
    } else if (o.manifestId !== undefined) {
      ok.push(`Obsidian 插件 id 形状符合（${o.manifestId}）`)
    }
    if (o.mainJs !== true && o.mainJsIgnored !== true) {
      pending.push('Obsidian main.js 不在仓库根且未被忽略：要么还没构建，要么忽略规则漏了 main.js（官方模板要求它只进发布附件；确认构建与忽略规则后消掉）')
    } else {
      ok.push(o.mainJs === true ? 'Obsidian main.js 在仓库根（构建过；发布前确认附件即可）' : 'Obsidian main.js 被忽略（符合官方模板：只进发布附件）')
    }
    if (o.hasVersionsJson !== true) {
      pending.push('Obsidian 缺 versions.json：只在 minAppVersion 变化时才需要；加文件可消（加上它），确认旧宿主无需回退时在汇报里记一笔')
    }
    // 附件侧只能人去发布页看，机器只负责把“看什么”列全，不替人下结论。
    // 无标签、无发布 job 时无 release 可看，不问；一旦开始发版，每版都要看。
    const hasAnyTag = Array.isArray(s.git?.tags) && s.git.tags.length > 0
    const hasRelJob = s.docs?.workflowAutomation?.hasReleaseJob === true
    if (hasAnyTag || hasRelJob) {
      pending.push('Obsidian 发布附件待核：去该版本 Release 页确认 main.js + manifest.json (+styles.css 如有) 都在附件列表，且 tag 与两处 manifest.json 版本三方一致')
    }
    // 触发器形状：裸版本（1.2.3）才对；v* 只对 npm 一类成立。
    // releaseTriggerTags 取的是各工作流 on.push.tags 原文；releaseJobConditionTagsV
    // 说明条件里写死了 refs/tags/v（裸标签永远进不来）。两者任一命中 v 即问。
    const trig = s.docs?.workflowAutomation?.releaseTriggerTags ?? []
    const condV = s.docs?.workflowAutomation?.releaseJobConditionTagsV === true
    const trigHasV = trig.some((t) => /(^|[^0-9])v\*?/i.test(t) || /^v/i.test(t))
    if (trigHasV || condV) {
      pending.push(`Obsidian 标签触发器是 v 形状（触发器原文：${trig.join('、') || '未读到'}${condV ? '；条件写死了 refs/tags/v' : ''}）：宿主要求裸版本 tag（如 1.2.3），v* 推上去认不出——按专章第七节改触发器`)
    }
  }

  // 6c. 本地 skills：只盘点，不强求；已有被改坏才拦。
  if (Array.isArray(s.localSkills) && s.localSkills.length > 0) {
    ok.push(`本地 skills 有（${s.localSkills.map((x) => x.path).join('、')}）`)
    for (const x of s.localSkills) {
      if (x.corrupt === true) missing.push(`本地 skill 损坏：${x.path} 缺 SKILL.md 或首部非法`)
      else if (x.nameOk === false) missing.push(`本地 skill 名实不符：${x.path} 目录名与 name 不一致`)
      else if (x.descriptionHead === undefined || x.descriptionHead.length < 10) {
        pending.push(`本地 skill 描述过短：${x.path}（触发语不明，改完再验）`)
      }
    }
  }
  const auto = s.docs?.workflowAutomation
  if (auto === undefined || auto.files.length === 0) {
    if (flags.has('--no-ci')) ok.push('无 CI（用户已确认暂不要）')
    else pending.push('CI 缺失：问用户要不要检查自动化与自动发布（不要→加 --no-ci，不要默跳）')
  } else {
    ok.push(`工作流有（${auto.files.join('、')}）`)
    if (auto.truncated === true && auto.hasReleaseJob !== true) {
      pending.push(`工作流只读了前 ${auto.headLimit ?? '若干'} 字符：“无发布 job”不可信，大文件需手工确认后再定`)
    }
    if (s.artifacts?.publishableManifest !== undefined && s.artifacts?.private !== true) {
      if (auto.hasReleaseJob) {
        ok.push('发布 job 有')
        // 英文回退确认：纯 --generate-notes 出来是英文模板（首版更是白卷）。
        // 有 notes-file 模式即中文链；没有就必须问一句，不能默认英文可接受。
        if (!auto.usesNotesFile && auto.usesGenerateNotes) {
          pending.push('发布说明是英文模板模式：确认英文可接受，否则换 notes-file 中文链（见模板 TODO(2)）')
        }
      }
      else if (flags.has('--no-auto-release')) ok.push('无发布 job（用户已确认暂不要自动发布）')
      else pending.push('发布 job 缺失：可发布项目问用户要不要自动写 Release（不要→加 --no-auto-release）')
    }
  }

  // 6d. 生态发布门禁：只判本生态清单事实，不拼他生态命令。
  const ecoKinds = s.ecosystem?.kinds ?? []
  // Python：后端缺了即无权威构建入口（待问）；readme/license 缺了服务端大概率
  // 拒绝（报缺——长描述渲染炸是最常见的 400）；requires-python 缺了只待问
  // （装到旧版难定位，但不挡发布）；dynamic version 只提示 tag 对齐按后端取值。
  if (ecoKinds.includes('python') && s.artifacts?.pythonBuild !== undefined) {
    if (s.artifacts.pythonBuild.hasBuildSystem !== true) {
      pending.push('Python 缺构建后端声明：无 [build-system] 即无权威构建入口，补上再定发布预演')
    }
    const pm = s.artifacts.pythonMeta
    if (pm !== undefined) {
      if (pm.hasReadme !== true) missing.push('Python 缺 readme 声明（长描述渲染失败是服务端最常见的拒绝原因，先补再发）')
      if (pm.hasLicense !== true) missing.push('Python 缺 license 声明（新后端要求 SPDX 字符串 + license-files，旧写法会报“应为 dict”）')
      if (pm.hasRequiresPython !== true) {
        pending.push('Python 缺 requires-python：不挡发布，但用户装到旧版时难定位；确认支持下限后补上')
      }
      if (pm.hasDynamicVersion === true) {
        pending.push('Python 版本号走 dynamic：tag 对齐按后端取值（如 tag 或源码），不要照抄文件里的字面版本号')
      }
    }
  }
  if (ecoKinds.includes('go') && s.artifacts?.goModule !== undefined
    && s.artifacts.goModule.goDirective === undefined) {
    pending.push('Go 缺 go 指令：最低版本不明，补上再定兼容承诺')
  }
  // Rust：license/description 缺了服务端拒绝（报缺）；keywords/categories 超 5 个
  // 同样拒绝（报缺——勘察已数好个数）；edition 未声明只待问（缺省 2015 可发布）。
  if (ecoKinds.includes('rust') && s.artifacts?.cargoMeta !== undefined) {
    if (s.artifacts.cargoMeta.license !== true) missing.push('Rust 缺 license 声明（发布必填其一：license 或 license-file）')
    if (s.artifacts.cargoMeta.description !== true) missing.push('Rust 缺 description 声明（发布必填）')
    const cm = s.artifacts.cargoMeta
    if (typeof cm.keywordsCount === 'number' && cm.keywordsCount > 5) {
      missing.push(`Rust keywords ${cm.keywordsCount} 个（上限 5 个，超了服务端拒绝）`)
    }
    if (typeof cm.categoriesCount === 'number' && cm.categoriesCount > 5) {
      missing.push(`Rust categories ${cm.categoriesCount} 个（上限 5 个，超了服务端拒绝）`)
    }
    if (cm.hasEdition !== true) {
      pending.push('Rust 未声明 edition（缺省 2015 可发布，建议显式声明当前版本）')
    }
  }
  // 发布自动化接线：有发布动作痕迹的生态，按对应专章逐项核对“登记了没有”。
  // 机器只认“动作痕迹 + OIDC 有无”两个比特，不猜登记内容对不对——对不对只能人去
  // 制品库设置页逐字对，错了只在发布那一刻爆错。三种都是待问（问完消不掉，只能改文件）。
  const auto2 = s.docs?.workflowAutomation
  if (auto2 !== undefined && s.artifacts?.private !== true) {
    if (auto2.hasNpmPublish === true && auto2.usesOidc !== true) {
      pending.push('npm 有发布动作但无 OIDC 声明：可信发布要 id-token: write + 制品库侧登记（组织/仓库/工作流文件名逐字一致）；用长期令牌则规划迁移（见 publish-npm 接线步骤）')
    }
    if (auto2.hasPypiPublish === true && auto2.usesOidc !== true) {
      pending.push('PyPI 有发布动作但无 OIDC 声明：可信发布要 pending publisher（包名/仓库/工作流文件名/environment）+ 发布 job 的 id-token: write，且构建与发布分 job；用 API Token 则确认已放机密存储（见 publish-python 认证一节）')
    }
    if (auto2.hasCargoPublish === true && auto2.usesOidc !== true) {
      pending.push('crates.io 有发布动作但无 OIDC 声明：可信发布要用官方认证 action 换短期令牌 + job 的 id-token: write，且先手动发布过一次（见 publish-rust 认证一节）；用 API Token 则确认已放机密存储')
    }
    // Release job 的形状三件套：引用约定名、写权限、全历史检出。缺一即待问。
    if (auto2.hasReleaseJob === true) {
      if (auto2.usesReleaseToken !== true) {
        pending.push('发布 job 未引用约定的 RELEASE_TOKEN：凭据名拼错会静默空跑出 401，先查名（只看有没有，不看值）')
      }
      if (auto2.hasContentsWrite !== true) {
        pending.push('发布 job 未声明 contents: write：建 Release 需要写权限（npm OIDC 的 id-token 与它是两回事，不要以为写了一个另一个顺带有了）')
      }
      if (auto2.hasFetchDepthZero !== true) {
        pending.push('发布 job 检出缺 fetch-depth: 0：起草脚本要读上一个标签，无全历史首版取全量与区间都算不对')
      }
    }
  }

  for (const t of ok) line('齐', t)
  for (const t of pending) line('待问', t)
  for (const t of missing) line('缺', t)
  if (missing.length > 0) {
    process.stdout.write(`\n结论：${missing.length} 处缺失，补完重跑。待问事项问完用户后用 flag 消掉。\n`)
    return 1
  }
  if (pending.length > 0) {
    if (flags.has('--strict')) {
      process.stdout.write(`\n结论：--strict 下 ${pending.length} 处待问同样拦住，问完消掉重跑。\n`)
      return 2
    }
    process.stdout.write('\n结论：无缺失，但有待问事项——问完用户、加 flag 重跑，全齐才算交付。\n')
    return 0
  }
  process.stdout.write('\n结论：全部齐备，可以交付。\n')
  return 0
}

// 与 survey / preflight 同一模式：直接执行才跑 main；被 import（selftest 单测本文件的
// 纯函数）时不产生副作用。判据按真实路径比较，经 junction 调用也算直接执行。
if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main(process.argv)
