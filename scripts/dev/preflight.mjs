#!/usr/bin/env node
/**
 * preflight.mjs —— 这个 skill 自己的结构自检。
 *
 * ## 它查什么，不查什么
 *
 * 只查**坏了会让用户拿到一个用不了、或者说假话的产物**的东西。风格偏好、措辞一致性、
 * 文档里的中文数字与列表项数对不对得上——一律不查。那些检查的代价是「改一句文档就红」，
 * 而它们换来的防线，一条真正的判据都换不来。
 *
 * 六类：
 *   1. 入口能被宿主认出来：frontmatter 合法、`name` 与目录名一致、体积在预算内
 *   2. 引用不断链：文档里提到的每个相对路径都真实存在；每份参考有标题与「何时读本文件」
 *   3. 零依赖：`scripts/` 只用内置模块，每个脚本能解析
 *   4. 会跑的都真跑：几个入口脚本的 `--help` 能跑通
 *   5. 端到端冒烟：在临时项目上跑一遍勘察 → 生成 → 体检 → 交棒
 *   6. 卫生：无 BOM、无 emoji、无本机绝对路径
 *
 * ## 为什么它这么短
 *
 * 上一版有 3,636 行，配套的行为夹具 6,955 行——比它检查的产品代码还长。而它检查的内容
 * 里有「注释里的四字词组」「中文数字与列表项数是否一致」这类东西，任何正常的文档润色
 * 都会让它红。
 *
 * 判据：**一条检查如果被削成恒真也不会有任何东西变坏，它就不该存在。**
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FULL_READ_MAX_LINES, FULL_READ_REFS, REFS_MAX_LINES, REPO_ONLY_DIRS, REPO_ONLY_FILES,
  SKILL_MAX_BYTES, SKILL_MAX_LINES, TEMPLATE_CONDITIONS, TEMPLATE_VARS,
  conditionMarkers, isRepoOnlyPath, templateVarsOf,
} from '../lib/protocol.mjs'
import { VERIFY_EXIT } from '../handoff.mjs'
import { isMainModule } from '../lib/text.mjs'
import { checkGapCoverage as gapCoverage } from './gap-coverage.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const failures = []
const notes = []
const fail = (msg) => failures.push(msg)
const note = (msg) => notes.push(msg)

function rel(p) {
  return relative(ROOT, p).split('\\').join('/')
}

/**
 * 这个目录是不是 `git worktree add` 建出来的检出。
 *
 * 判据是**结构事实**：worktree 里的 `.git` 是一个文件（内容是一行 `gitdir: <路径>`），
 * 普通仓库里它是一个目录。不看目录叫什么——名字是给人看的，结构才是事实。
 *
 * 这个判断只服务于「哪些判据在临时检出里不适用」：目录名与 `name` 一致、安装位置这些
 * 概念只对真正的安装副本成立。把临时检出判成缺陷，等于让每个审查者先撞一次假故障。
 */
function isWorktreeCheckout(dir) {
  const dotGit = join(dir, '.git')
  try {
    return statSync(dotGit).isFile()
  } catch {
    return false
  }
}

function readText(p) {
  return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
}

function countLines(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.length
}

/**
 * 读 frontmatter 里的一个标量，**支持块标量**（`key: |` 后面跟缩进的若干行）。
 *
 * 只读一行会把 `description: |` 读成两个字 —— 于是「描述太短」的检查会在一份完全合格的
 * 入口上报错，而修法看起来是「把描述写成一行」，那反而更难读。
 */
function readBlockScalar(block, key) {
  const lines = block.split('\n')
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l))
  if (idx < 0) return undefined
  const inline = lines[idx].slice(`${key}:`.length).trim()
  if (inline !== '' && inline !== '|' && inline !== '>') return inline.replace(/^["']|["']$/g, '')
  const body = []
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) break
    body.push(lines[i].trim())
  }
  return body.join(' ').trim() || undefined
}

function walk(dir, pred) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, pred))
    else if (entry.isFile() && (pred === undefined || pred(full))) out.push(full)
  }
  return out
}

// ── 1. 入口 ─────────────────────────────────────────────────────────

function checkEntry() {
  const skillPath = join(ROOT, 'SKILL.md')
  if (!existsSync(skillPath)) {
    fail('缺少 SKILL.md')
    return
  }
  const text = readText(skillPath)
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = countLines(text)

  if (lines > SKILL_MAX_LINES) {
    fail(`SKILL.md 有 ${lines} 行，超过预算 ${SKILL_MAX_LINES} 行——入口每多一行，每一次任务都要多付一次`)
  }
  if (bytes > SKILL_MAX_BYTES) {
    fail(`SKILL.md 有 ${bytes} 字节，超过预算 ${SKILL_MAX_BYTES} 字节`)
  }

  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
  if (!fm) {
    fail('SKILL.md 缺少 frontmatter（首行的 ---）')
    return
  }
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
  // `description` 允许写成块标量（`|` / `>` 后面跟缩进的若干行），那是常见写法，
  // 所以取「这一行之后所有缩进更深的行」拼起来，而不是只读这一行。
  const desc = readBlockScalar(fm[1], 'description')
  if (!name) fail('frontmatter 缺 name')
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      fail(`frontmatter 的 name「${name}」不合法：只能小写字母、数字、连字符`)
    }
    // **在 worktree 里这一条不成立，且不是缺陷。**
    //
    // 宿主按目录名发现能力目录，所以安装位置里 `name` 必须等于目录名。而审查位是
    // `.worktrees/review-<短SHA>/`——那是**临时检出**，目录名是给隔离用的，不是安装位置。
    // 在这一条上判红，会让审查者花一轮排查一个假故障；而假装它通过，又等于把判据悄悄关掉。
    //
    // 所以：认得出是 worktree 时**换一种说法**（note，说明它在这里不适用），认不出时照旧判红。
    // 判据用结构事实（`.git` 是文件而不是目录，即被 `git worktree add` 建出来的），不看目录叫什么。
    if (name !== basename(ROOT)) {
      if (isWorktreeCheckout(ROOT)) {
        note(`入口：name「${name}」与目录名「${basename(ROOT)}」不同——这是 worktree 检出，`
          + '目录名是隔离用的临时名字，不是安装位置，这一条在这里不适用')
      } else {
        fail(`frontmatter 的 name「${name}」与目录名「${basename(ROOT)}」不一致——宿主按目录名发现它`)
      }
    }
  }
  if (!desc || desc.length < 20) fail('frontmatter 缺 description，或它太短（宿主靠它决定要不要加载）')

  // 驼峰旧键会让整份被丢弃。这一条值得单独查：症状是「装了但不生效」，没有任何报错。
  const camel = fm[1].match(/^[a-zA-Z]*[a-z][A-Z][a-zA-Z]*:/m)
  if (camel) fail(`frontmatter 里有驼峰键「${camel[0].replace(':', '')}」——扩展键一律用连字符形式，驼峰会让整份被丢弃`)

  note(`入口：${lines} 行 / ${bytes} 字节（预算 ${SKILL_MAX_LINES} 行 / ${SKILL_MAX_BYTES} 字节）`)
}

// ── 2. 引用与预算 ───────────────────────────────────────────────────

const PATH_RE = /\b((?:references|templates|scripts)\/[A-Za-z0-9_./-]+\.(?:md|mjs|ya?ml|txt|json))\b/g

function docsToScan() {
  const refs = walk(join(ROOT, 'references'), (f) => f.endsWith('.md'))
  return [join(ROOT, 'SKILL.md'), ...refs]
}

/**
 * 模板里**不许**出现的东西。
 *
 * 目标项目没有 `references/` 目录，也没有本 skill 的 `scripts/`。模板里写一句
 * 「详见 `references/xxx.md`」，落到目标项目就是一条**注定指空**的指针——而它指的
 * 位置上原本写着一条规则。用户会去点它，点不到，然后以为是自己装错了。
 *
 * 判据是文本里出现 `references/` 这类前缀，而不是「链接能不能解析」：模板不是给本仓库
 * 用的，它的相对路径本来就不该按本仓库的结构去解释。
 */
const TEMPLATE_FORBIDDEN = [
  { re: /`?references\//, what: '指向 references/ 的路径（目标项目没有这个目录）' },
  { re: /\bproject-forge:\s*(?:kernel|managed|upgraded)/, what: '旧版标记语法' },
]

function checkTemplates() {
  const templates = walk(join(ROOT, 'templates'), () => true)
  if (templates.length === 0) { fail('templates/ 下没有任何文件'); return }

  // 许可证全文是**逐字的标准文本**，里面的 `{{YEAR}}` / `{{HOLDER}}` 是让人手工替换的
  // 占位，不经过渲染器。把它们算进「模板变量」等于让一份法律文本去迁就代码。
  const rendered = templates.filter((f) => !/^license-.+\.txt$/.test(basename(f)))

  for (const file of templates) {
    const name = rel(file)
    const text = readText(file)

    for (const rule of TEMPLATE_FORBIDDEN) {
      const m = rule.re.exec(text)
      if (m) {
        const line = text.slice(0, m.index).split('\n').length
        fail(`${name} 第 ${line} 行有${rule.what}——它会原样落进目标项目，然后永远指空`)
      }
    }
  }

  for (const file of rendered) {
    const name = rel(file)
    const text = readText(file)

    // 条件名与变量名必须是登记过的。写错一个字母的后果不是报错，而是那一整块
    // 被当成「条件为假」静默消失——读者看到的是一份缺了一节的契约。
    for (const mark of conditionMarkers(text, 'x.md')) {
      if (mark.kind === 'if' && !TEMPLATE_CONDITIONS.includes(mark.cond)) {
        fail(`${name} 第 ${mark.line} 行用了未登记的条件「${mark.cond}」——它会永远求值为假，那一块会静默消失`)
      }
    }
    for (const v of templateVarsOf(text)) {
      if (!TEMPLATE_VARS.includes(v)) {
        fail(`${name} 里有未登记的占位符 {{${v}}}——渲染会直接失败`)
      }
    }
  }

  // 反方向：登记了却没人用的条件与变量，会让人以为「有这能力」。
  const usedConds = new Set()
  const usedVars = new Set()
  for (const file of rendered) {
    const text = readText(file)
    for (const mark of conditionMarkers(text, 'x.md')) if (mark.kind === 'if') usedConds.add(mark.cond)
    for (const v of templateVarsOf(text)) usedVars.add(v)
  }
  for (const c of TEMPLATE_CONDITIONS) {
    if (!usedConds.has(c)) fail(`条件「${c}」登记了却没有任何模板用它——要么删掉登记，要么补上模板`)
  }
  for (const v of TEMPLATE_VARS) {
    if (!usedVars.has(v)) fail(`占位符 {{${v}}} 登记了却没有任何模板用它——要么删掉登记，要么补上模板`)
  }

  note(`模板：${templates.length} 份，无越界指针；条件 ${usedConds.size} 个、变量 ${usedVars.size} 个全部登记且都在用`)
}

/**
 * 「推到哪一档」的说法必须处处一致。
 *
 * ## 这条判据治的是什么
 *
 * 「推送」在同一个仓库里被两种口径各说了一遍：入口把它当成**要等人确认的对外动作**，
 * 协作判据把它当成**日常**。两句话单独看都成立，放在一起就把执行者逼进一个二选一——
 * 而它选错的那一次，是「明明该开 PR，却停下来问人要批准」。
 *
 * 根因不是措辞不统一，是**判据没写死**：分档的判据是「能不能撤回」，而不是「是不是对外」。
 * 一旦按后者分，推自己的分支（可撤回）就会被错划进「对外动作」那一栏。
 *
 * ## 为什么用「必备说法」而不是逐字比对
 *
 * 逐字比对会把每一份文档的排版、语气、详略都锁死，改一个词就红——那种检查最后一定会
 * 被加一个例外表绕过去。这里只断言**判据本身在里面**：同一组语义必须能在每一份讲这件事的
 * 文件里找到。排版怎么排不管，判据少了就红。
 */
const PUSH_TIER_RULE = [
  {
    // 说法：分档看「能不能撤回」，不看「是不是对外」。
    what: '分档判据是能不能撤回',
    any: [/能不能撤回/, /可撤回|撤得回来/, /can be undone|cannot be undone|whether they can be undone/],
  },
  {
    // 说法：推自己的分支、开 PR 属于日常，不必等人点头。
    what: '推分支与开 PR 属于日常',
    any: [/推(?:自己|出)?的?分支|推分支/, /push(?:ing)? (?:your|the) (?:own )?branch|push-a-branch/],
  },
  {
    // 说法：合并由审查者做完，不再往人手里递一道。
    what: '审查通过就由审查者合',
    any: [/审查者(?:直接)?(?:合|合并)|审查通过[^\n]{0,20}(?:合|闭环)|由(?:那个)?审查/,
      /reviewer merges|merges? (?:it )?(?:directly|right away)|the reviewer finishes/i],
    // 提案模板也要讲这一条：作者读到的就是它。但前两条（撤回性、推分支属日常）是给
    // 实现者看的流程说明，塞进模板只会让填表的人多读一段与填表无关的话。
    everywhere: true,
  },
  {
    // 说法：唯一必须人点头的一类是弱化门禁。
    what: '弱化门禁必须人点头',
    any: [/弱化门禁/, /weaken\w* (?:a )?gate|loosen\w* (?:a )?gate|relax\w* (?:the )?gate/i],
    everywhere: true,
  },
]

/** 讲「日常怎么落地」的那几份。缺一份，就有一处会按旧口径行事。 */
const PUSH_TIER_DOCS = [
  'SKILL.md',
  'AGENTS.md',
  'templates/agents-project.md',
  'references/collaboration.md',
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'templates/contributing.md',
]

/**
 * 只讲「谁能合」的那几份。
 *
 * 两份提案模板会落进用户项目，作者读到的就是它们——所以 `everywhere: true` 那两条必须
 * 也在里面。但「能不能撤回」「推分支属日常」是实现流程，不是填表要读的东西，只在上面那批。
 *
 * 少列它们的后果是实测过的：模板里还写着被废弃的旧口径（高风险与人合、外部 PR 人合），
 * 而上面八份文件全都对——**冲突发生在清单之外，没有门禁看得到**。
 */
const MERGE_AUTHORITY_DOCS = [
  'templates/pull-request-template.md',
  '.github/pull_request_template.md',
]

/**
 * 旧口径：把「提交 + 推送」写成日常的终点。
 *
 * 它不是错字，是一个**已经过时的结论**：那句话成立的前提是「推送撤不回来」，
 * 而推自己的分支恰恰撤得回来。留着它，读的人就会停在推送、不开 PR。
 */
const STALE_DAILY_END = /提交\s*[+＋]\s*推送/

function checkPushSemantics() {
  const groups = [
    { docs: PUSH_TIER_DOCS, label: '日常流程' },
    { docs: MERGE_AUTHORITY_DOCS, label: '提单模板' },
  ]
  for (const group of groups) {
    for (const name of group.docs) {
      const p = join(ROOT, name)
      if (!existsSync(p)) { fail(`推送分档核对：缺 ${name}`); continue }
      const text = readText(p)
      for (const rule of PUSH_TIER_RULE) {
        if (group.label === '提单模板' && rule.everywhere !== true) continue
        if (!rule.any.some((re) => re.test(text))) {
          fail(`${name} 里缺「${rule.what}」这条说法——同一件事在不同文件里说法不一，执行者会按错的那一份行事`)
        }
      }
      const stale = STALE_DAILY_END.exec(text)
      if (stale) {
        const line = text.slice(0, stale.index).split('\n').length
        fail(`${name} 第 ${line} 行还把「提交 + 推送」当作日常的终点——推自己的分支撤得回来，那一档的终点是合并`)
      }
    }
  }
  const total = PUSH_TIER_DOCS.length + MERGE_AUTHORITY_DOCS.length
  note(`推送分档：${total} 份文件说法一致（分档看可撤回性，推分支属日常，审查通过由审查者合，只有弱化门禁要人点头）`)
}

/**
 * 本仓库实例与模板的同构核对。
 *
 * 这条判据治的是一个具体的事故：模板改了，本仓库自己那份没跟上——于是「它教的」
 * 和「它做的」是两套，而读者照着模板做，维护者照着自己那份做，两边都不报错。
 *
 * 判的是**核心二级标题**是否都在，不是逐字相同（实例本来就该有自己独有的节）。
 */
const OWN_INSTANCE_CHECKS = [
  { template: 'templates/pull-request-template.md', instance: '.github/pull_request_template.md' },
  { template: 'templates/issue-bug-report.md', instance: '.github/ISSUE_TEMPLATE/bug_report.md' },
  { template: 'templates/issue-feature-request.md', instance: '.github/ISSUE_TEMPLATE/feature_request.md' },
  { template: 'templates/releasing.md', instance: 'RELEASING.md' },
  { template: 'templates/contributing.md', instance: 'CONTRIBUTING.md' },
]

/** 已经删掉的脚本与文件名。任何文件里出现它们，都是没跟上的引用。 */
const RETIRED_NAMES = ['selftest.mjs', 'review-record.mjs', 'agents-kernel.md', 'pf-review', 'check-badges.mjs', 'ecosystems.mjs', 'lib/ledger.mjs', 'lib/manifest.mjs', 'task-runners.mjs', 'release-notes.mjs', 'render-svg.mjs', 'release-spec.md']

/** 历史记录是**当时的事实**，不改写它。它们记的是那一次改动的现场，不是现行约定。 */
const HISTORY_PATHS = [/^docs\/work\//, /^docs\/release-notes\//]

/**
 * 审查栏的四个字段名。**这是唯一一份**——模板、本仓库实例、判据三处都从这里取。
 *
 * 为什么它必须是一份常量：这四个词同时要出现在「发给用户的 PR 模板」「本仓库自己的 PR 模板」
 * 「`references/collaboration.md` 的『七、审查循环』」三处。三处各写一遍，改一处就会有两处说旧话，
 * 而症状是「填了审查栏，但没人按它判」——没有任何东西会因此报错。
 *
 * 字段名本身就是判据：它们分别对应「谁审的」「判了哪几条」「测试是不是空的」「循环有没有停」。
 * 少一个，那一项就没人填；改一个名字，审查报告与模板就对不上。
 */
const REVIEW_FIELDS = ['审查来源', '逐条标准状态', '故障注入记录', '止损记录']

/**
 * 验收标准的编号形状。**这是一条规则，不是一个快照**：可勾选的一行，编号是 `C` 加数字。
 *
 * 「编号长什么样」看起来像格式洁癖，实际是**审查栏能不能对上标准**的前提：审查写的是
 * `fail: C4`，标准那一节写成 `1.` 或 `-`，两处就永远对不起来，而人只会以为「审查漏看了 C4」。
 *
 * 判据盯的是**可勾选那一行**，不是「文里出现过 C1」：`work-item.md` 的填写指引里本来就
 * 举了个 `C1` 的例子，按「出现过」判的话，清单被改成 `1.` 也照样绿——判据就被那句举例
 * 削成了恒真。
 */
const ACCEPTANCE_ID_RE = /^- \[[ xX]\] C\d+\b/m
const ACCEPTANCE_ID_SITES = ['templates/work-item.md']

/**
 * 工作记录模板里，「完成后的记录」是不是**要求合并之前写完**。
 *
 * 这句话没有判据守着时，改回「合并之后补」不会有任何信号——而那句话一改，第二个 PR 就又
 * 回来了：合并之后再改这份文件，平台会拒掉直接推主干，只能另开一个只改记录的提案。
 *
 * 判据盯的是「那一节里的那句话」，不是「文里出现过『合并之前』」：同一份模板的别处、
 * 以及其他文档，都会自然提到这两个词，按「出现过」判等于恒真。
 */
export function completionRecordBeforeMerge(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^##\s+完成后的记录\s*$/.test(line))
  if (start === -1) return { ok: false, why: '没有「完成后的记录」这一节' }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }
  const section = lines.slice(start, end).join('\n')
  if (!/合并之前写完/.test(section)) {
    return { ok: false, why: '「完成后的记录」里没有要求「在合并之前写完」' }
  }
  return { ok: true, why: '' }
}

/**
 * 审查栏那四行必须**排在一起形成一块**，不是「文件里出现过这四个词」。
 *
 * 按「出现过」判会让两个字段完全失守：`references/collaboration.md` 讲那两个字段的正文里本来就有
 * 这些词，于是把字段块里的某一行改名或整行删掉，判据照样绿——它验的是「这个词在这份文件里
 * 存在」，而要求是「三处列出同一批字段名」。两个字之差，两个字段就完全没人看守。
 *
 * 块的定义：**空行分隔的一个连续段落**。四行列表、四行围栏代码块里的内容，都是块；
 * 一处出现在段首、另一处出现在三段之后，不算。
 */
export function reviewBlockMissing(text) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/)
  const complete = blocks.some((block) => REVIEW_FIELDS.every((field) => block.includes(field)))
  return complete ? [] : REVIEW_FIELDS
}

/** 这份文本里的验收标准编号是不是 `C<数字>` 的形状。缺了返回 true。**纯函数**。 */
export function acceptanceIdMissing(text) {
  return !ACCEPTANCE_ID_RE.test(String(text ?? ''))
}

/**
 * 收尾清单的步骤。**数字与顺序都是判据。**
 *
 * 两条顺序都不是排版偏好，各自对着一处会真出事的地方：
 *
 *   - **第 1 步（把要写的东西写完并纳入本次 PR）在合并之前**：工作记录是仓库里的文件。
 *     合并之后再改它，平台会拒掉直接推主干，执行者只能另开一个只改记录的提案——那一个
 *     没人审、也没和原提案绑在一起，而它看起来像「又提了一个提案」。把「写记录」放在
 *     「合并」之后，等于要求每件事都多出一个 PR。
 *   - **`worktree remove` 在 `branch -d` 之前**：分支还被某个 worktree 检出着时，
 *     `git branch -d` 一定失败，而报错说的是「未合并」。顺序反了，人就会去用 `-D` 强删，
 *     而那会把没合进去的东西一起删掉。
 *
 * ## 锚点是「合并收尾」四个字，不是「第几步：合并收尾」
 *
 * 章节编号会随文档增删而变，绑在编号上的锚点一重排就找不到——找不到时的表现是
 * 「七步全缺」，一条**永远为真**的判据，比没有更坏。这里只认那句话本身。
 */
const FINISH_ANCHOR = /合并收尾/
const FINISH_STEPS = [
  /把要写的东西写完/,
  /合并 PR/,
  /回读确认/,
  /git switch/,
  /git worktree remove/,
  /git branch -d/,
  /git push origin --delete/,
]

const FINISH_SITES = [
  'templates/agents-project.md',
  'AGENTS.md',
  'references/collaboration.md',
]

/**
 * 这三处不是「顺手挑的三份文件」，而是**三种角色**，各缺一不可：
 *
 *   - **骨架**：写给别的项目的模板（`templates/` 下）。
 *   - **实例**：本仓库照着骨架生成的那一份（`AGENTS.md`）。
 *   - **判据源头**：讲清「为什么是这七步」的那份参考（`references/` 下）。
 *
 * ## 为什么按角色判，不按个数判
 *
 * 「个数必须等于 3」这种写法**自己就是恒真的**：`FINISH_SITES` 删掉一个元素时，
 * 循环里核对的个数和列表长度一起变小，两边永远相等。实测过——删到只剩一项，
 * 门禁照样绿。这就是「判据的守卫自己没人守」又一次长出来。
 *
 * 角色不会跟着列表缩水：删掉哪一份，对应的那个角色就没人填，当场红。
 */
const FINISH_SITE_ROLES = [
  { role: '骨架（templates/ 下）', test: (s) => s.startsWith('templates/') },
  { role: '实例（AGENTS.md）', test: (s) => s === 'AGENTS.md' },
  { role: '判据源头（references/ 下）', test: (s) => s.startsWith('references/') },
]

/**
 * 核对清单里缺了哪些角色。**纯函数**，供门禁与行为断言共用。
 *
 * 单独抽出来是为了让行为断言能调判据本体：断言里复刻一份循环的话，判据被削弱时
 * 复制品不会红，「判据坏了」这件事就又没人看着了。
 */
export function finishSiteRolesMissing(sites) {
  return FINISH_SITE_ROLES.filter(({ test }) => !sites.some(test)).map(({ role }) => role)
}

/**
 * 收尾七步的**正文**（含每步的续行），按编号切成七块。
 *
 * 只取编号开头的行和它的续行，不取这一节里的解释段落：解释是写给某一处的读者看的，
 * 允许各写各的；**步骤正文是给人照着敲的**，那里不能分叉。
 */
function finishStepBodies(text) {
  const range = finishSectionRange(text)
  if (range === undefined) return undefined
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').slice(range.start, range.end)
  const bodies = []
  let current = null
  for (const line of lines) {
    if (/^\s*\d+\.\s/.test(line)) {
      if (current !== null) bodies.push(current)
      current = line
      continue
    }
    if (current !== null) current += '\n' + line
  }
  if (current !== null) bodies.push(current)
  return bodies
}

/**
 * 七步里出现的 `git` 子命令集合。
 *
 * ## 为什么比这个，而不比措辞
 *
 * 措辞是给人读的，同一个意思可以写成「先卸 worktree」或「`git worktree remove`」；
 * 但**命令是给人敲的**，同一步在三处教人敲不同的命令，就是三处会分叉的地方。
 *
 * 这不是抽象担忧：实测过一次——第 7 步在模板里写「先查有没有下游堆叠 PR」，
 * 在参考文档里写「`git ls-remote` 查远端分支还在不在」，两句话讲的是同一件事的两半，
 * 而顺序判据只看「`git push origin --delete` 排在哪」，所以两份可以长期各说各的。
 * 把「这一步该敲哪些命令」也比一遍，这种半句话分叉就藏不住了。
 */
export function finishCommandsOf(text) {
  const bodies = finishStepBodies(text)
  if (bodies === undefined) return undefined
  const found = bodies.join('\n').match(/\bgit\s+([a-z][a-z-]*)/g) ?? []
  return [...new Set(found.map((one) => one.replace(/\s+/g, ' ')))].sort()
}

/**
 * 找出收尾清单的行范围，返回 `{ start, end }`；没有那一段返回 `undefined`。
 *
 * 锚在**那一行**而不是某个标题：收尾清单本来就不是独立一节，它是第四步的正文。
 * 按标题锚会找不到，于是判据永远报「缺七步」——一条永远为真的判据比没有更坏。
 *
 * 结束位置是下一个同级条目或标题（`- **` 开头的新条目、任何 `#` 标题、或受管区间标记）。
 * 判据按结构写，不写死行号：清单上下挪几行、多写一段说明，范围跟着走。
 */
export function finishSectionRange(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => FINISH_ANCHOR.test(line))
  if (start === -1) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#+\s+/.test(lines[i]) || /^- \*\*/.test(lines[i]) || /^<!--\s*project-forge:/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/**
 * 收尾七步在这一节里是否齐、是否按顺序。
 *
 * 返回 `{ missing, outOfOrder }`：`missing` 是缺掉的步骤正则，`outOfOrder` 指示顺序。
 * **纯函数**，供门禁与行为断言共用——断言要调判据本体，不要复刻一份循环：
 * 复刻的那份不会因为判据被削弱而变红，于是「判据坏了」这件事没有任何东西看着。
 */
export function finishStepsState(text) {
  const range = finishSectionRange(text)
  if (range === undefined) return { missing: FINISH_STEPS, outOfOrder: false }
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const section = lines.slice(range.start, range.end)
  const positions = FINISH_STEPS.map((re) => {
    const index = section.findIndex((line) => re.test(line))
    return index
  })
  const missing = FINISH_STEPS.filter((_, i) => positions[i] === -1)
  let outOfOrder = false
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] === -1 || positions[i - 1] === -1) continue
    if (positions[i] < positions[i - 1]) { outOfOrder = true; break }
  }
  return { missing, outOfOrder }
}

function headingsOf(text) {
  return (text.replace(/\r\n/g, '\n').match(/^##\s+.+$/gm) ?? []).map((s) => s.trim())
}

/**
 * 跨文件对拍：同一件事在三处的说法必须逐字一致。
 *
 * 这一类漂移现在没有任何东西看着：模板、实例、判据是三个人分别维护的，而它们要求的是同一批词。
 * 不一致时的表现不是报错，是「按模板填了，判据不认」或者反过来。
 *
 * ## 判的是「四行排在一起」，不是「四个词出现在这份文件里」
 *
 * 后者看起来一样，实际差两个字：`references/collaboration.md` 讲这两个字段的正文里本来
 * 就带着这些词，于是字段块里删掉两行，判据照样绿。改成「某一段里四个都在」之后，删一行
 * 那一块就不完整，红。
 */
function checkReviewContract() {
  const sites = [
    'templates/pull-request-template.md',
    '.github/pull_request_template.md',
    'references/collaboration.md',
  ]
  for (const site of sites) {
    const path = join(ROOT, site)
    if (!existsSync(path)) { fail(`审查栏对拍：缺 ${site}`); continue }
    const missing = reviewBlockMissing(readText(path))
    if (missing.length === REVIEW_FIELDS.length) {
      fail(`${site} 里没有一块同时排着审查栏的这四个字段——模板、实例、判据三处必须是同一批词，`
        + `否则填了也没人按它判。字段表在 scripts/dev/preflight.mjs 的 REVIEW_FIELDS`)
    } else if (missing.length > 0 && missing.length < REVIEW_FIELDS.length) {
      fail(`${site} 的审查栏字段块不完整，缺「${missing.join('、')}」——`
        + '四个字段要排在同一段里；分散在正文各处的同名文字不算')
    }
  }
  note(`审查栏对拍：${REVIEW_FIELDS.length} 个字段在三处各排成一块`)

  // 验收标准的编号形状：审查写 `fail: C4`，标准那节写成 `1.` 就对不上。
  //
  // **逐处各判一次，不是「有一处有就算过」。** 判据是「每一处都能对上编号」；把两处合成
  // 一次判定的话，其中一处被改坏时另一处还在，整条判据就永远绿——那正是它要防的形状。
  for (const site of ACCEPTANCE_ID_SITES) {
    const path = join(ROOT, site)
    if (!existsSync(path)) { fail(`验收标准编号：缺 ${site}`); continue }
    if (acceptanceIdMissing(readText(path))) {
      fail(`${site} 里没有 \`C1\`/\`C2\` 形状的验收标准编号——审查栏写的是 \`fail: C4\`，`
        + '编号形状一变，两处就永远对不起来，而人只会以为审查漏看了那一条')
    }
  }
  note(`验收标准编号：${ACCEPTANCE_ID_SITES.length} 处都是 \`C<数字>\` 形状`)

  // 「完成后的记录」必须在合并之前写完。这句话一松，第二个 PR 就回来了。
  {
    const site = 'templates/work-item.md'
    const path = join(ROOT, site)
    if (!existsSync(path)) { fail(`完成后记录：缺 ${site}`) }
    else {
      const { ok, why } = completionRecordBeforeMerge(readText(path))
      if (!ok) {
        fail(`${site}：${why}——这句一改，合并之后就得再开一个只改记录的提案，`
          + '而那个提案没人审、也没和这件事绑在一起')
      }
    }
  }
  note('完成后记录：模板要求「在合并之前写完」')

  // 收尾步骤：三处都要有，顺序要一致，**每一步教人敲的命令也要一致**。
  //
  // 顺序是判据不是排版：`worktree remove` 挪到 `branch -d` 后面，那段流程就会在「分支被占用」
  // 上卡住。命令同理，而且更隐蔽——两处写的是同一件事的两半时，读起来都没错，照着做会漏一半。
  //
  // 三处不是随意挑的：`templates/agents-project.md` 是写给别的项目的骨架，
  // `AGENTS.md` 是本仓库照着它生成的实例，`references/collaboration.md` 是判据源头。
  // **判据源头不在核对清单里时，它改了没有任何东西会报**——那是最坏的一处漏网：
  // 其余两处都跟着它走，源头漂了却要等别人发现。
  let siteCount = 0
  let baseline = null
  for (const site of FINISH_SITES) {
    const path = join(ROOT, site)
    if (!existsSync(path)) { fail(`收尾步骤对拍：缺 ${site}`); continue }
    siteCount += 1
    const text = readText(path)
    const state = finishStepsState(text)
    if (state.missing.length > 0) {
      fail(`${site} 的合并收尾缺这几步：${state.missing.join('、')}——七步固定，少一步就会有人漏做`)
    } else if (state.outOfOrder) {
      fail(`${site} 的合并收尾步骤顺序不对——顺序是判据不是排版，`
        + 'worktree 没卸就删分支会失败，而报错说的是「未合并」')
    }

    // 命令对拍：以第一处（模板）为基准，其余每一处都必须与它一致。
    const commands = finishCommandsOf(text)
    if (commands === undefined) continue
    if (baseline === null) {
      baseline = { site, commands }
      continue
    }
    const extra = commands.filter((c) => !baseline.commands.includes(c))
    const absent = baseline.commands.filter((c) => !commands.includes(c))
    if (extra.length > 0 || absent.length > 0) {
      const parts = []
      if (absent.length > 0) parts.push(`${site} 少了 ${absent.join('、')}`)
      if (extra.length > 0) parts.push(`${site} 多了 ${extra.join('、')}`)
      fail(`收尾步骤对拍：${baseline.site} 与 ${site} 教人敲的命令不一致——${parts.join('；')}。`
        + '措辞可以各写各的，命令不行：同一件事在三处教人敲不同的东西，照着做会漏一半')
    }
  }
  // **角色也要齐。** 「个数等于列表长度」是恒真的——列表被删短，两个数一起变小。
  // 按角色判才真正看得见：删掉哪一份，对应的角色就没人填。
  for (const role of finishSiteRolesMissing(FINISH_SITES)) {
    fail(`收尾步骤对拍：${role}这一处不在核对清单里——`
      + '它改了不会有任何东西报错，而其余几处都跟着它走')
  }
  note(`收尾步骤对拍：${FINISH_STEPS.length} 步在 ${siteCount} 处（模板 / 实例 / 判据源头）顺序与命令一致`)
}

function checkOwnInstances() {
  for (const check of OWN_INSTANCE_CHECKS) {
    const tpl = join(ROOT, check.template)
    const inst = join(ROOT, check.instance)
    if (!existsSync(tpl)) { fail(`同构核对：缺模板 ${check.template}`); continue }
    if (!existsSync(inst)) { fail(`同构核对：缺本仓库实例 ${check.instance}`); continue }
    const wanted = headingsOf(readText(tpl))
    const have = new Set(headingsOf(readText(inst)))
    for (const h of wanted) {
      if (!have.has(h)) {
        fail(`${check.instance} 缺模板里的这一节：${h}——模板改了、本仓库自己那份没跟上，两边从此各说各话`)
      }
    }
  }
  note(`同构核对：${OWN_INSTANCE_CHECKS.length} 组实例与模板的核心章节一致`)

  // 退休名字的残留扫描。**历史记录不扫**：工作记录与发版说明记的是当时的事实，
  // 把它们按现行约定改写一遍，等于伪造一份从没发生过的历史。
  const targets = [
    join(ROOT, 'SKILL.md'), join(ROOT, 'AGENTS.md'), join(ROOT, 'README.md'),
    join(ROOT, 'README.en.md'), join(ROOT, 'CONTRIBUTING.md'), join(ROOT, 'RELEASING.md'),
    ...walk(join(ROOT, '.github'), (f) => /\.(?:md|ya?ml)$/i.test(f)),
    ...walk(join(ROOT, 'templates'), () => true),
  ]
  for (const file of targets) {
    if (!existsSync(file)) continue
    const name = rel(file)
    if (HISTORY_PATHS.some((re) => re.test(name))) continue
    const text = readText(file)
    for (const retired of RETIRED_NAMES) {
      if (!text.includes(retired)) continue
      fail(`${name} 里还写着 ${retired}——那个脚本已经不存在，照着它做的人会找不到命令`)
    }
  }
}

/**
 * 渲染一遍模板，确认产物里**一个占位符都不剩**。
 *
 * `{{COMMANDS}}` 曾经原样落进过用户的 `AGENTS.md`：它在文件里看起来像「这里本来就该有
 * 一段命令」，于是没人发现，直到有人照着它去找命令。这一条直接在生成产物上核对，
 * 而不是在渲染代码里核对——判据要落在「用户拿到什么」上。
 */
function checkTemplateRender() {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-render-'))
  try {
    // 一个**没有任何命令**的纯文档项目：这曾经是泄漏最容易发生的那种输入。
    writeFileSync(join(tmp, 'README.md'), '# demo\n\n一个纯文档项目，用来核对渲染产物。\n')
    const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'compose-agents.mjs'), tmp], {
      encoding: 'utf8', timeout: 60000,
    })
    if (res.status !== 0) { fail(`在纯文档项目上渲染 AGENTS.md 失败：${(res.stderr || '').trim()}`); return }
    const out = join(tmp, 'AGENTS.md')
    if (!existsSync(out)) { fail('渲染没有产出 AGENTS.md'); return }
    const text = readFileSync(out, 'utf8')

    const leaked = templateVarsOf(text)
    if (leaked.length > 0) fail(`渲染产物里还有未替换的占位符：${leaked.map((n) => `{{${n}}}`).join('、')}`)
    if (conditionMarkers(text, 'x.md').length > 0) fail('渲染产物里还有 if/endif——条件求值漏了一层')

    if (!/project-forge:\s*(?:begin|fill)/.test(text)) fail('渲染产物里没有任何受管标记——它从此没法被刷新')
    note('渲染：纯文档项目上生成的 AGENTS.md 没有残留占位符、没有残留条件块')
  } finally {
    // Windows 上刚被别的进程打开的目录会被锁一小会儿，删不掉不是失败——
    // 用重试把它让过去，不要让一条清理动作把整趟自检打成崩溃。
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 留给系统清理 */ }
  }
}

/**
 * 平台锁定：产物层只提 GitHub，不提别的托管平台。
 *
 * **只扫产品层**（入口、判据、落盘骨架、脚本）。历史记录（`docs/work/`、`docs/release-notes/`）
 * 不扫：那里记的是当时的事实，把「清掉了哪些平台的提及」这句话本身也改掉，等于伪造历史。
 *
 * 判据是「出现了别的平台名」，不是「提到了托管平台这个词」——后者在描述清理动作时正当。
 */
const FOREIGN_PLATFORMS = [/\bGitLab\b/i, /\bGitee\b/i, /\bBitbucket\b/i, /\bsvn\b/i]

function checkPlatformLock() {
  const targets = [
    join(ROOT, 'SKILL.md'),
    ...walk(join(ROOT, 'references'), (f) => f.endsWith('.md')),
    ...walk(join(ROOT, 'templates'), () => true),
    ...walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs')),
  ]
  for (const file of targets) {
    if (!existsSync(file)) continue
    const name = rel(file)
    const text = readText(file)
    for (const re of FOREIGN_PLATFORMS) {
      const m = re.exec(text)
      if (!m) continue
      const line = text.slice(0, m.index).split('\n').length
      fail(`${name} 第 ${line} 行提到了「${m[0]}」——这个 skill 只针对 GitHub，别的托管平台不进产物层`)
    }
  }
  note(`平台锁定：${targets.length} 个产物层文件里没有提及其他托管平台`)
}

/**
 * 会跑的都真跑——**包括在真项目上跑一遍每一个入口**。
 *
 * 这一条是从一次事故里补出来的：`handoff.mjs` 里有个函数被删了，但调用点写成
 * `selfScan && isSkillOwnPath(rel)`——非自扫时短路，那个未定义的函数压根不会被调用。
 * 于是 `--help` 通、语法通、端到端冒烟也通（冒烟在临时目录上跑，走的正是短路那一支），
 * 而**在真实项目上调用它当场 ReferenceError**。
 *
 * 判据因此要落在「在真项目上跑一次」而不是「能不能解析」：临时目录里跑得通，只证明了
 * 一个特定分支。所以这一段拿本仓库自己当靶子——它的目录结构最复杂，走的分支最多。
 */
function checkRunsOnRealTarget() {
  const calls = [
    { script: 'survey.mjs', args: [ROOT], what: '勘察' },
    { script: 'handoff.mjs', args: [ROOT, '--json'], what: '交棒扫描' },
    { script: 'review.mjs', args: [ROOT, '--json'], what: '交付体检' },
    { script: 'compose-agents.mjs', args: [ROOT, '--status'], what: '契约状态' },
  ]
  for (const call of calls) {
    const res = spawnSync(process.execPath, [join(ROOT, 'scripts', call.script), ...call.args], {
      encoding: 'utf8', timeout: 120000,
    })
    if (res.status !== 0) {
      const first = (res.stderr || '').trim().split('\n').find((line) => line && !/^\s+at /.test(line)) ?? ''
      fail(`${call.script} 在真实项目上跑${call.what}失败（退出 ${res.status}）：${first.slice(0, 200)}`)
    }
  }
  note(`真目标：${calls.length} 个入口都在本仓库上跑通（不是只在临时目录里跑）`)
}

/**
 * 本仓库自己过一遍生成门禁。
 *
 * 这个仓库是这套规范的第一个用户：`templates/` 里写的结构，这里必须自己做到。
 * 自举断了不会报错，只会让「它教的」和「它做的」从此是两套。
 */
function checkSelfHost() {
  const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'compose-agents.mjs'), ROOT, '--check'], {
    encoding: 'utf8', timeout: 60000,
  })
  if (res.status !== 0) {
    fail(`本仓库自己的 AGENTS.md 没通过自举校验：${(res.stderr || res.stdout || '').trim().split('\n').slice(0, 6).join(' / ')}`)
    return
  }
  note('自举：本仓库自己的 AGENTS.md 标记成对、没有未填占位、该有的节都在')
}

function checkLinks() {
  const refDir = join(ROOT, 'references')
  const refs = walk(refDir, (f) => f.endsWith('.md'))
  if (refs.length === 0) fail('references/ 下没有任何 Markdown 文件')

  for (const file of refs) {
    const name = rel(file)
    const text = readText(file)
    if (!text.startsWith('# ')) fail(`${name} 的首行必须是一级标题`)
    if (!/^##\s+何时读本文件/m.test(text)) {
      fail(`${name} 缺「## 何时读本文件」——没有它，AI 不知道什么时候该读这一份`)
    }
  }

  const seen = new Set()
  for (const doc of docsToScan()) {
    if (!existsSync(doc)) continue
    const name = rel(doc)
    const text = readText(doc)
    for (const m of text.matchAll(PATH_RE)) {
      const target = m[1]
      if (target.includes('*')) continue
      seen.add(target)
      if (!existsSync(join(ROOT, target))) {
        fail(`${name} 引用了不存在的路径：${target}`)
      }
    }
  }

  // 反过来：每个模板都要有人指得到。「写了却没人指得到」等于没写。
  //
  // 一个例外：**许可证全文按家族提到一次就够**。五种 SPDX 文本不是五个独立产物，
  // 它们是同一格的候选值——要求逐个列出名字，只是在逼文档写一张会过期的清单。
  const licenseFamily = /templates\/license-<[^>]+>\.txt/
  const licenseMentioned = docsToScan().some((doc) => existsSync(doc) && licenseFamily.test(readText(doc)))
  for (const file of walk(join(ROOT, 'templates'), () => true)) {
    const target = rel(file)
    if (seen.has(target)) continue
    if (/^templates\/license-.+\.txt$/.test(target) && licenseMentioned) continue
    fail(`${target} 没有被任何文档提到——写了却没人指得到，等于没写`)
  }

  const refLines = refs.reduce((sum, f) => sum + countLines(readText(f)), 0)
  if (refLines > REFS_MAX_LINES) fail(`references/ 合计 ${refLines} 行，超过预算 ${REFS_MAX_LINES} 行`)
  note(`参考文档：${refs.length} 篇 / ${refLines} 行`)

  let fullRead = countLines(readText(join(ROOT, 'SKILL.md')))
  for (const refPath of FULL_READ_REFS) {
    const p = join(ROOT, refPath)
    if (!existsSync(p)) { fail(`预算表里列的 ${refPath} 不存在`); continue }
    fullRead += countLines(readText(p))
  }
  if (fullRead > FULL_READ_MAX_LINES) {
    fail(`一次全量任务要读 ${fullRead} 行，超过预算 ${FULL_READ_MAX_LINES} 行——注意力被稀释的直接来源`)
  }
  note(`全量必读：${fullRead} 行（预算 ${FULL_READ_MAX_LINES}）`)

  checkReferenceTargets()
}

/**
 * 全仓库不许出现节号指针，并且每一处「指路」都真的落在目标文件的二级标题上。
 *
 * ## 两条判据，治的是同一件事：指针绑在会动的东西上
 *
 * **节号会随重排失效，标题不会。** 一份文档插进一节，后面全部节号加一——十几处指路同时
 * 指错，而它们不会报错，只会让人点进去发现「这一节讲的是别的事」。所以节号一律不许出现，
 * 指路只写标题，并由这里核对标题真的在。
 *
 * 光禁节号不够：改成标题之后，标题也可能被改名。两种错法的表现一样（指路落空），
 * 所以放在同一个检查里，一次说清。
 */
function checkAnchors() {
  // 一、不许有「第 N 节」。
  //
  // ## 扫的是「会被读者照着做的地方」，不是一份挑出来的文件名单
  //
  // 判据是**这一处文字会不会被谁读到并照它跳转**。`scripts/` 下的注释也算：维护者看着
  // 注释去找某一节，找错了就把另一节改错。早先只扫文档，于是同一个仓库里同时存在
  // 两种口径——门禁报「全仓库没有节号指针」，而它只数了自己认识的那几份。
  //
  // 扫的范围因此是**整个版本库**，减去两类**历史记录**（它们记的是当时的事实，不改写）。
  // `walk` 自己跳过 `.git` 与 `node_modules`，所以不必在这里再滤一遍。
  const scanned = walk(ROOT, (f) => /\.(?:md|mjs|ya?ml)$/i.test(f))
  const SECTION_PTR = /第[一二三四五六七八九十]+节/
  let sectionHits = 0
  let scannedFiles = 0
  for (const file of scanned) {
    if (!existsSync(file)) continue
    const name = rel(file)
    if (HISTORY_PATHS.some((re) => re.test(name))) continue
    scannedFiles += 1
    const lines = readText(file).replace(/\r\n/g, '\n').split('\n')
    for (const [i, line] of lines.entries()) {
      if (!SECTION_PTR.test(line)) continue
      sectionHits += 1
      fail(`${name} 第 ${i + 1} 行用了节号指针——重排一次就全部指错，而它不会报错；改写成「标题名」`)
    }
  }
  if (sectionHits === 0) {
    note(`指路形状：${scannedFiles} 份文件里没有节号指针，指路一律用标题名`)
  }

  // 二、每一处「反引号里的 references 文件 + 「标题」」都要解析到真实的二级标题。
  const headingsCache = new Map()
  const headingsOfFile = (file) => {
    if (!headingsCache.has(file)) {
      const full = join(ROOT, file)
      headingsCache.set(file, existsSync(full)
        ? new Set(readText(full).replace(/\r\n/g, '\n').split('\n')
          .map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1]).filter(Boolean))
        : null)
    }
    return headingsCache.get(file)
  }

  let checked = 0
  for (const file of scanned) {
    if (!existsSync(file)) continue
    const name = rel(file)
    if (HISTORY_PATHS.some((re) => re.test(name))) continue
    const text = readText(file).replace(/\r\n/g, '\n')
    // 两种写法都认：带反引号的文件名 + 「标题」，以及同文件内的「N、标题」简写不算。
    for (const m of text.matchAll(/`(references\/[A-Za-z0-9_.-]+\.md)`\s*的?\s*「([^」]+)」/g)) {
      const [, refFile, section] = m
      const have = headingsOfFile(refFile)
      if (have === null) { fail(`${name} 指向不存在的文件 ${refFile}`); continue }
      checked += 1
      const hits = matchHeadings(have, section)
      if (hits.length === 0) {
        fail(`${name} 指向 ${refFile} 的「${section}」，但那份文件里没有以它开头的二级标题——指路落空`)
      } else if (hits.length > 1) {
        fail(`${name} 指向 ${refFile} 的「${section}」，对上了 ${hits.length} 个标题（${hits.join(' ／ ')}）——`
          + '指路要多写几个字让它唯一')
      }
    }
  }
  note(`指路核对：review.mjs 与正文共 ${checked} 处命名锚点都落在真实标题上`)
}

/**
 * 勘察报的每条缺口，体检那边都必须有人接。
 *
 * 判据在 `scripts/dev/gap-coverage.mjs` 里（它是唯一实现，执行器与断言共用）。
 * 这一条治的是「勘察说了、没人管」：加了一条新缺口却忘了接线，报告里会永远挂着一条
 * 悬空结论，而没有任何东西报错。
 *
 * ## 五类都要报，包括「一条都没读出来」
 *
 * 只报 `unclaimed` / `dangling` / `duplicated` 三类是不够的：词法切块失灵时读出来是空数组，
 * 那三类全空，检查静默通过——「0 条各有处置」。`missing`（登记了却没读出来）与
 * `unknown`（读出来了却没登记）才守得住这一层。
 */
async function checkGapCoverage() {
  // **崩了也要变成一行 FAIL。**
  //
  // `gap-coverage.mjs` 里有一条「登记的 id 名单必填、不给就抛错」的判断。它抛出来时，
  // 如果没人接，preflight 会带着几十行调用栈退出——而调用栈不叫「失败」，它叫
  // 「不知道算不算失败」：按 `FAIL` 开头的行判红的那些地方，一行都匹配不上，于是
  // 一次正确的崩溃会被记成「判据被拆掉却没人报」，把失守误读成失守的反面。
  //
  // 崩溃是一种失败，而且是最该被看见的那种：它意味着这一整条判据没跑。
  let state
  try {
    state = await gapCoverage(ROOT)
  } catch (error) {
    fail(`缺口覆盖：这条判据没跑成——${error instanceof Error ? error.message : String(error)}`)
    return
  }
  for (const one of state.duplicated) {
    fail(`缺口覆盖：${one}——一条缺口只能落一档，写两档会让结论出现两个版本`)
  }
  for (const one of state.dangling) {
    fail(`缺口覆盖：${one} 在体检里没有这个 id——映射看着配好，实际指向一条永远不会出现的结论`)
  }
  for (const id of state.unknown) {
    fail(`缺口覆盖：${id} 出现在源码里却不在登记名单里——源码与导出名单对不上`)
  }
  for (const id of state.missing) {
    fail(`缺口覆盖：${id} 登记了却没能从源码里读出来——词法切块失灵，这一条从此没人查`)
  }
  for (const id of state.unclaimed) {
    fail(`缺口覆盖：${id} 体检那边没人接——勘察报了、没人管；给 survey.mjs 那条规则补 `
      + "review / decision / surveyOnly 三选一")
  }
  if (state.ok.length > 0) note(`缺口覆盖：${state.ok.length} 条各有处置（体检 / 表态 / 仅勘察）`)
}

/**
 * 一处指路能不能落在那份文件的某个二级标题上。**纯函数**，两处调用者共用。
 *
 * ## 前缀匹配，不是逐字相同
 *
 * 指路可以只写「七、审查循环」，不必抄全那个长标题。要求逐字相同会把标题锁死——改一个
 * 副标题就红，最后一定会被加一个例外表绕过去。
 *
 * 前缀够用是因为**唯一性由下面那条判据保证**：两节同前缀时返回多个命中，调用方报红。
 * 于是「写得短」与「指得准」两件事同时成立，而代价只是多写几个字。
 */
export function matchHeadings(headings, section) {
  const wanted = String(section).replace(/`/g, '')
  return [...headings].filter((h) => h.replace(/`/g, '').startsWith(wanted))
}

/**
 * `review.mjs` 里每条指路（`file:` + `section:`）都必须落在真实存在的二级标题上。
 *
 * 这一条治的是一个实际发生过的错：指路写「许可协议那一节」，而那一节实际讲的是 README。
 * **节号会随增删章节失效，标题不会**——所以指路只写标题，这里核对标题存在。
 *
 * 比对规则与 `checkAnchors` 共用 `matchHeadings`：一处指路在两处判据下得到两个答案是
 * 最坏的情况——修了一个还红着，而红的原因看起来像「指路写错了」。
 */
function checkReferenceTargets() {
  const reviewPath = join(ROOT, 'scripts', 'review.mjs')
  if (!existsSync(reviewPath)) { fail('缺 scripts/review.mjs'); return }
  const src = readText(reviewPath)
  const pairs = [...src.matchAll(/file:\s*'([^']+)',\s*section:\s*'([^']+)'/g)]
  const headingsCache = new Map()
  let checked = 0

  for (const [, file, section] of pairs) {
    const full = join(ROOT, file)
    if (!existsSync(full)) { fail(`review.mjs 指路指向不存在的文件：${file}`); continue }
    if (!headingsCache.has(file)) {
      headingsCache.set(file, new Set(
        readText(full).replace(/\r\n/g, '\n').split('\n')
          .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1])
          .filter(Boolean),
      ))
    }
    checked += 1
    const hits = matchHeadings(headingsCache.get(file), section)
    if (hits.length === 0) {
      fail(`review.mjs 指向 ${file} 的「${section}」，但那份文件里没有以它开头的二级标题——指路会落空`)
    } else if (hits.length > 1) {
      fail(`review.mjs 指向 ${file} 的「${section}」，对上了 ${hits.length} 个标题（${hits.join(' ／ ')}）——指路要多写几个字让它唯一`)
    }
  }
  note(`指路核对：${checked} 处都指在真实标题上`)
}

// ── 3. 零依赖与可解析 ───────────────────────────────────────────────

function checkScripts() {
  const scripts = walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs'))
  if (scripts.length === 0) { fail('scripts/ 下没有任何 .mjs'); return }

  for (const file of scripts) {
    const name = rel(file)
    const text = readText(file)
    for (const m of text.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1]
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue
      fail(`${name} 引入了非内置模块「${spec}」——必须保持零第三方依赖`)
    }
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (syntax.status !== 0) {
      fail(`${name} 语法错误：${(syntax.stderr || '').split('\n').slice(0, 3).join(' ')}`)
    }
  }
  note(`脚本：${scripts.length} 个，全是内置依赖、语法都能解析`)
}

// ── 4. 会跑的都真跑 ─────────────────────────────────────────────────

function checkHelps() {
  for (const name of ['survey.mjs', 'compose-agents.mjs', 'review.mjs', 'handoff.mjs', 'sync-toc.mjs', 'update.mjs']) {
    const p = join(ROOT, 'scripts', name)
    if (!existsSync(p)) { fail(`缺脚本 ${name}`); continue }
    const res = spawnSync(process.execPath, [p, '--help'], { encoding: 'utf8', timeout: 20000 })
    if (res.status !== 0) {
      fail(`${name} --help 跑不通（退出 ${res.status}）：${(res.stderr || '').trim().split('\n')[0]}`)
      continue
    }
    if (!/用法/.test(res.stdout || '')) fail(`${name} --help 没打印用法`)
  }
}

// ── 5. 端到端冒烟 ───────────────────────────────────────────────────

function run(script, args, opts = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8', timeout: 120000, ...opts,
  })
}

function smoke() {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-smoke-'))
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'demo-app', version: '0.1.0', private: true,
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2))
    writeFileSync(join(tmp, 'README.md'), '# demo-app\n\n一个用来跑冒烟验证的示例项目，说明足够长。\n')
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n')

    const s = run('survey.mjs', [tmp])
    if (s.status !== 0) { fail(`survey 冒烟失败：${(s.stderr || '').trim()}`); return }
    let facts
    try { facts = JSON.parse(s.stdout) } catch { fail('survey 的输出不是 JSON'); return }
    for (const field of ['maturity', 'git', 'ecosystem', 'commands', 'docs', 'risks', 'gaps', 'questions']) {
      if (facts[field] === undefined) fail(`survey 的输出缺字段 ${field}`)
    }
    if (facts.maturity !== 'greenfield') fail(`空白项目的 maturity 应为 greenfield，实际是 ${facts.maturity}`)
    if (!facts.ecosystem.kinds.includes('node')) fail(`应识别出 node 生态，实际是 ${facts.ecosystem.kinds.join(',')}`)

    const c1 = run('compose-agents.mjs', [tmp])
    if (c1.status !== 0 || !existsSync(join(tmp, 'AGENTS.md'))) { fail('compose-agents 没生成 AGENTS.md'); return }

    // 幂等：第二遍字节必须相同。
    const before = readFileSync(join(tmp, 'AGENTS.md'))
    const c2 = run('compose-agents.mjs', [tmp])
    if (c2.status !== 0) fail('compose-agents 第二遍跑失败')
    const after = readFileSync(join(tmp, 'AGENTS.md'))
    if (!before.equals(after)) fail('compose-agents 不幂等：第二遍改了文件')

    // 未填占位时 --check 必须红。
    const check1 = run('compose-agents.mjs', [tmp, '--check'])
    if (check1.status === 0) fail('AGENTS.md 还有未填占位，但 --check 放行了')

    // 侵入面：不能出现隐藏目录与被拷进来的脚本。
    for (const bad of ['.project-forge', join('scripts', 'review-record.mjs')]) {
      if (existsSync(join(tmp, bad))) fail(`compose-agents 在目标项目里留下了 ${bad}——侵入面必须为零`)
    }

    // 体检能跑，且能认出未填占位。
    const r = run('review.mjs', [tmp])
    if (!/交付体检/.test(r.stdout || '')) fail('review 没输出体检报告')
    if (!/没填|未填|fill/.test(r.stdout || '')) fail('review 没报出 AGENTS.md 里未填的占位')

    // 交棒能扫到标记，剥掉之后能判干净。
    const h1 = run('handoff.mjs', [tmp, '--verify'])
    if (h1.status === 0) fail('AGENTS.md 里还有标记，handoff --verify 却说干净')
    run('compose-agents.mjs', [tmp, '--clean'])
    const h2 = run('handoff.mjs', [tmp, '--verify'])
    if (h2.status !== 0) fail(`剥掉标记之后 handoff --verify 仍说脏：${(h2.stdout || '').trim()}`)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 留给系统清理 */ }
  }
  note('端到端：勘察 → 生成（幂等）→ 门禁 → 体检 → 交棒，全跑通')
}

// ── 6. 卫生 ─────────────────────────────────────────────────────────

/**
 * 提交前门禁的**命令清单**。这是唯一一份，两份文档都必须逐条对得上。
 *
 * 为什么放在这里：`AGENTS.md` 那一节由模板生成、`CONTRIBUTING.md` 那一节是人手写的，
 * 两边各自维护一份清单时，「加了一道门禁但只写进一处」不会报错——直到有人照着少的那份
 * 跑，然后宣布「全绿」。
 */
const GATE_COMMANDS = [
  'node scripts/dev/preflight.mjs',
  'node scripts/dev/fixtures.mjs',
  'node scripts/compose-agents.mjs . --check',
  'node scripts/review.mjs .',
  'node scripts/sync-toc.mjs README.md README.en.md --check',
]

/**
 * 同一件事在几份文件里说法必须一致的那几组判据。
 *
 * 每一组都治一次**真实发生过的漂移**：两处各自写一遍时，改一处而漏另一处不会报错，
 * 只会在某一天由读者发现「文档说的和做的不一样」。这里不追求逐字相同（那会把排版
 * 与语气锁死，改个词就红，最后一定会被加一个例外绕过去），只断言**判据本身在场**。
 */
const SINGLE_SOURCE_RULES = [
  {
    what: 'S3 落盘顺序：版本控制 → 文档 → 远端 → 自动化',
    // 文档里能承载这个顺序的写法：箭头式或顿号式，顺序必须一致。
    tests: [
      { file: 'README.md', re: /版本库\s*→\s*文档\s*→\s*远端\s*→\s*自动化/ },
      { file: 'README.en.md', re: /Repo\s*→\s*docs\s*→\s*remote\s*→\s*automation/ },
      { file: 'SKILL.md', re: /版本控制\s*→\s*文档\s*→\s*远端\s*→\s*自动化/ },
    ],
  },
  {
    what: '交棒的退出码（四个码必须与 handoff.mjs 的 VERIFY_EXIT 逐个相等）',
    // **只看「四档退出码」这几个字是不够的。** 把文档里的码改成 0/1/2/5，那句话仍然命中，
    // 而代码返回的是 0/1/3/4——文档于是承诺了一个永远不会出现的码，还漏掉了真的会出现的
    // 那个。判据必须是**码本身**：把命中段落里的单数字提出来，与常量逐个比。
    tests: [
      // SKILL.md 那一行逐字列出四个码，用 `--verify` 定位到行尾。
      { file: 'SKILL.md', re: /--verify[^\n]*/, exitCodes: true },
      // 参考文档是一张表：从「四档退出码」一直取到表末那几行。
      { file: 'references/handoff.md', re: /四档退出码[\s\S]{0,400}/, exitCodes: true },
    ],
  },
  {
    what: '发版说明的「怎么升级」只能给包里真有的命令',
    // 用户包按 `.gitattributes` 排除 `scripts/dev/`，所以它不存在于用户手里。
    // 发版说明是**给拿到包的人**看的，里面出现那两条命令等于教人跑一条必失败的命令。
    //
    // 名单**不写死**：扫 `docs/release-notes/` 下所有说明。写死三份时，第四份说明
    // 写错命令不会有任何东西碰到它。
    releaseNotes: true,
  },
]

/** 这三份文件里**不许**出现的东西。 */
const FORBIDDEN_IN_RELEASE_NOTES = /scripts\/dev\//

/**
 * 发版说明的名单**从磁盘上取**，不写死。
 *
 * 写死三份时，第四份说明写错命令不会有任何东西碰到它——而它正是最新那一份，
 * 也就是最多人照着跑的那一份。
 */
function releaseNoteFiles() {
  const dir = join(ROOT, 'docs', 'release-notes')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((n) => /\.md$/i.test(n))
    .sort()
    .map((n) => `docs/release-notes/${n}`)
}

function checkSingleSources() {
  for (const rule of SINGLE_SOURCE_RULES) {
    // 「发版说明」那一组没有固定文件，单独走下面那段。
    if (rule.releaseNotes === true) continue
    for (const test of rule.tests) {
      const p = join(ROOT, test.file)
      if (!existsSync(p)) { fail(`单一真相源核对：缺 ${test.file}`); continue }
      const text = readText(p)
      const hit = test.re.exec(text)
      if (hit === null) {
        fail(`${test.file} 里对不上「${rule.what}」——同一件事在两份文件里说了两样，读的人会按错的那一份做`)
        continue
      }
      // 需要比对具体数字的那几组：把命中段落里的单数字提出来，与代码里的常量逐个比。
      // 只断言「这句话在」是不够的——把四个码改成另一批数字，那句话照样在。
      // 反引号先抹成空格：`3` 这种写法里的数字同样是「文档承诺的码」，不能因为被括起来就漏掉。
      if (test.exitCodes === true) {
        const nums = [...new Set((hit[0].replace(/`/g, ' ').match(/(?<![\w.])\d(?![\w.])/g) ?? []))]
          .map(Number)
          .sort((a, b) => a - b)
        const expect = Object.values(VERIFY_EXIT).sort((a, b) => a - b)
        if (nums.join(',') !== expect.join(',')) {
          fail(`${test.file} 里写的退出码是 ${nums.join('/')}，而 handoff.mjs 实际返回 ${expect.join('/')}`
            + '——文档承诺了一个不会出现的码，还漏掉了真的会出现的那个')
        }
      }
    }
  }

  for (const file of releaseNoteFiles()) {
    const p = join(ROOT, file)
    if (!existsSync(p)) continue
    if (FORBIDDEN_IN_RELEASE_NOTES.test(readText(p))) {
      fail(`${file} 提到了 scripts/dev/——那几处不进用户包，照着跑的人会得到「找不到模块」`)
    }
  }

  // 提交前门禁的命令清单：两份文档都要逐条在场。
  //
  // 判据是「这条命令的**可执行形态**出现了」，不是逐字相同——注释、对齐的空格、行尾说明
  // 都可以不同，但命令本身少一条就不行。少那一条的症状是：有人照着少的那份跑完，
  // 宣布全绿，而那道门禁一次都没跑过。
  for (const file of ['AGENTS.md', 'CONTRIBUTING.md']) {
    const p = join(ROOT, file)
    if (!existsSync(p)) { fail(`门禁清单核对：缺 ${file}`); continue }
    const text = readText(p)
    for (const cmd of GATE_COMMANDS) {
      if (!text.includes(cmd)) {
        fail(`${file} 的门禁清单里少一条：${cmd}——两份文档列的不是同一批命令，照少的那份跑会漏掉它`)
      }
    }
  }

  // 工作流那一对：模板与本仓库实例都在校验同一批东西。
  // 模板改了实例没跟上（或反过来）时，CI 里跑的和本仓库做的是两套门。
  const workflowPair = [
    { file: 'templates/ci-release.yml', label: '模板' },
    { file: '.github/workflows/release.yml', label: '本仓库实例' },
  ]
  const mustHave = [
    { what: '一级标题校验', re: /grep -qE '\^# \+\[\^ \]'/ },
    { what: '正文行数校验', re: /BODY_LINES/ },
    { what: '未填占位判据（独立注释行）', re: /<!--\[\[:space:\]\]\*project-forge/ },
  ]
  for (const pair of workflowPair) {
    const p = join(ROOT, pair.file)
    if (!existsSync(p)) { fail(`工作流对拍：缺 ${pair.file}`); continue }
    const text = readText(p)
    for (const rule of mustHave) {
      if (!rule.re.test(text)) fail(`${pair.file}（${pair.label}）缺${rule.what}——两份工作流检查的东西不一样，CI 会放过模板能拦下的那种说明`)
    }
  }

  // CI 的权限声明：不写时拿到的是仓库默认设置，默认被改成可写时它就悄悄多了一份写权限。
  const checks = [
    { file: 'templates/ci-check.yml', re: /permissions:\s*\n\s*contents:\s*read/ },
    { file: '.github/workflows/check.yml', re: /permissions:\s*\n\s*contents:\s*read/ },
  ]
  for (const c of checks) {
    const p = join(ROOT, c.file)
    if (!existsSync(p)) continue
    if (!c.re.test(readText(p))) fail(`${c.file} 没有声明 permissions: contents: read——检查类工作流不该带写权限`)
  }

  note(`单一真相源：${SINGLE_SOURCE_RULES.length} 组跨文件判据 + 工作流对拍 + 权限声明，全部一致`)
}

const EMOJI_RE = /\p{Extended_Pictographic}/u

function checkHygiene() {
  const files = walk(ROOT, (f) => /\.(?:md|mjs|ya?ml|json|txt)$/i.test(f))
  const home = homedir().replace(/\\/g, '/')
  const homeRe = home.length > 4 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined
  for (const file of files) {
    const name = rel(file)
    const raw = readFileSync(file, 'utf8')
    if (raw.startsWith('\uFEFF')) fail(`${name} 有 UTF-8 BOM`)
    if (EMOJI_RE.test(raw)) fail(`${name} 有 emoji 字符`)
    if (homeRe && homeRe.test(raw)) fail(`${name} 里有本机绝对路径`)
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function main() {
  const argv = process.argv.slice(2)
  const pkgIndex = argv.indexOf('--package')
  if (pkgIndex >= 0) {
    const listPath = argv[pkgIndex + 1]
    if (!listPath) {
      process.stderr.write('用法：node scripts/dev/preflight.mjs --package <条目清单文件>\n')
      return 2
    }
    return checkPackage(listPath)
  }

  checkEntry()
  checkLinks()
  checkReferenceTargets()
  checkAnchors()
  await checkGapCoverage()
  checkScripts()
  checkTemplates()
  checkPlatformLock()
  checkStructureRules()
  checkPushSemantics()
  checkSingleSources()
  checkOwnInstances()
  checkReviewContract()
  checkHelps()
  checkTemplateRender()
  checkRunsOnRealTarget()
  checkSelfHost()
  smoke()
  checkHygiene()

  for (const n of notes) process.stdout.write(`  ${n}\n`)
  if (failures.length === 0) {
    process.stdout.write(`\n自检通过：0 项失败（${notes.length} 项读数）。\n`)
    return 0
  }
  process.stderr.write('\n')
  for (const f of failures) process.stderr.write(`FAIL  ${f}\n`)
  process.stderr.write(`\n自检未通过：${failures.length} 项失败。\n`)
  return 1
}

/**
 * `.gitattributes` 与 `REPO_ONLY_*` 必须说同一件事。
 *
 * 两处各写一份是刻意的：前者是 git 认识的文本形态，后者是代码里要用的。但**两份真相
 * 迟早会漂**，所以核对这一步不能省。不核对时的症状是：某个目录明明只服务本仓库，
 * 却出现在用户包里——而拿到包的人打开一看是个他看不懂的协作设施。
 */
function checkStructureRules() {
  const attrs = readText(join(ROOT, '.gitattributes')).replace(/\r\n/g, '\n')
  const ignored = attrs.split('\n')
    .map((line) => /^\s*\/?(\S+?)\s+export-ignore\s*$/.exec(line))
    .filter(Boolean)
    .map((m) => m[1].replace(/^\/+/, '').replace(/\/+$/, ''))

  const codeDirs = REPO_ONLY_DIRS.map((d) => d.replace(/\/$/, ''))
  const codeFiles = [...REPO_ONLY_FILES]

  for (const d of ignored) {
    if (codeDirs.includes(d) || codeFiles.includes(d)) continue
    fail(`.gitattributes 排除了 ${d}，而 REPO_ONLY_* 里没有它——两处说法不一致`)
  }
  for (const d of codeDirs) {
    if (ignored.includes(d)) continue
    fail(`REPO_ONLY_DIRS 里有 ${d}，而 .gitattributes 没排除它`)
  }
  for (const f of codeFiles) {
    if (ignored.includes(f)) continue
    fail(`REPO_ONLY_FILES 里有 ${f}，而 .gitattributes 没排除它`)
  }
  note(`结构规则：.gitattributes 与 REPO_ONLY_* 一致（${codeDirs.length} 处目录、${codeFiles.length} 个文件）`)
}

/**
 * 核对真跑出来的那份用户包。
 *
 * 条目清单来自 `git archive`（CI 里生成），这里做两件事：
 *
 *   一、**每个条目要么属于产品层，要么命中「不进包」的结构规则**。两处都不占的那个条目
 *       就是「没有归属」——它出现在包里但没人知道该不该在。
 *   二、**产品层白名单也要核**：`SKILL.md`、`references/`、`templates/`、`scripts/`
 *       这几处之外的东西进了包，就是「一个没人认领的目录被顺手打进用户手里」。
 *       只查黑名单时，一个新增的顶层目录会静默跟着发出去。
 *
 * 结构规则在 `lib/protocol.mjs` 里（与 `.gitattributes` 同源）。这个函数**不翻译**
 * `.gitattributes`——那份翻译工作在 `checkStructureRules` 里做一次，做的是「两处说法
 * 是否一致」这件事。这里只问一个问题：拿到包的人是不是收到了不该给他的东西。
 */
function checkPackage(listPath) {
  if (!existsSync(listPath)) {
    process.stderr.write(`找不到条目清单：${listPath}\n`)
    return 2
  }
  const all = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
  if (all.length === 0) {
    process.stderr.write('条目清单是空的——`git archive` 那一步失败时，空清单会被读成「没漏」，那是假绿。\n')
    return 1
  }
  // 目录项单独数：`git archive | tar -t` 会把目录也列出来，而「包里有多少文件」问的是文件。
  // 两个数混在一起时，同一份包在两处会报出两个不同的答案。
  const entries = all.filter((e) => !e.endsWith('/'))
  const dirs = all.length - entries.length

  // 越界判定只问 `isRepoOnlyPath`。再加一个 `startsWith('.github/')` 是多余的：
  // `.github/` 本来就在 `REPO_ONLY_DIRS` 里，写两遍只会在改名单时留下一个不同步的地方。
  const leaked = entries.filter((e) => isRepoOnlyPath(e))
  if (leaked.length > 0) {
    for (const e of leaked) process.stderr.write(`FAIL  ${e} 属于「不进包」的结构规则，却出现在用户包里\n`)
    process.stderr.write(`\n用户包核对未通过：${leaked.length} 个条目不该在包里。\n`)
    return 1
  }

  // 产品层：拿到包的人需要的只有这几处。其余一律要问「它凭什么在包里」。
  const unclaimed = entries.filter((e) => !isProductLayerPath(e))
  if (unclaimed.length > 0) {
    for (const e of unclaimed) process.stderr.write(`FAIL  ${e} 不在产品层（SKILL.md / references/ / templates/ / scripts/），也没被排除——它凭什么在用户包里？\n`)
    process.stderr.write(`\n用户包核对未通过：${unclaimed.length} 个条目没有归属。要发就归进产品层，不发就写进 .gitattributes 的 export-ignore。\n`)
    return 1
  }

  // 必需项：没有它们，拿到包的人用不了。
  let missingRequired = 0
  const required = ['SKILL.md', 'LICENSE', 'README.md']
  for (const r of required) {
    if (entries.includes(r)) continue
    process.stderr.write(`FAIL  用户包里没有 ${r}\n`)
    missingRequired += 1
  }

  if (missingRequired > 0) {
    process.stderr.write(`\n用户包核对未通过：缺 ${missingRequired} 个必需项。\n`)
    return 1
  }
  process.stdout.write(`用户包：${entries.length} 个文件（另有 ${dirs} 个目录项），没有越界，没有无归属条目，必需项齐全。\n`)
  return 0
}

/**
 * 这个相对路径是不是「产品层」——拿到包的人真正需要的那几处。
 *
 * 判据是**位置**，不是逐文件列表：新加一个文件只要放进这几处，就自动算产品层；
 * 放进别处，就会被下面那条「没有归属」的判据拦下。清单会漏，位置不会。
 */
function isProductLayerPath(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/')
  if (p === 'SKILL.md' || p === 'README.md' || p === 'LICENSE') return true
  if (/^README\.[a-z0-9_-]+\.md$/i.test(p)) return true
  return /^(?:references|templates|scripts)\//.test(p)
}

// **只有自己被运行时才跑主流程。** 行为断言要 import 上面的 `finishStepsState` 来验判据本体
// （复刻一份循环的断言不会因为判据被削弱而变红），而 import 时不该顺手跑一遍全量自检。
if (isMainModule(import.meta.url, process.argv[1])) {
  Promise.resolve(main()).then((code) => process.exit(code))
}
