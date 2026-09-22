#!/usr/bin/env node
/**
 * preflight.mjs —— skill 自检
 *
 * 这个 skill 教别人「先属性后提交、文档要一致、引用要完整」。它自己必须先做到，
 * 否则它讲的每一条都在自我否定。这个脚本就是那条要求的自动化形式：让 skill 自己
 * 不会腐坏。
 *
 * 它检查的是一组「坏了就一定会出问题」的性质，而不是风格偏好：
 *   - SKILL.md 能被宿主识别（frontmatter 合法、name 与目录名一致、name 形状正确）
 *   - description 不会被会话目录截断
 *   - SKILL.md 引用的每一个文件都真实存在（引用断链 = AI 按图索骥走到死路）
 *   - 每份 reference 都有标题与「何时读本文件」节（缺了 AI 不知道何时该读它）
 *   - 每份模板都具备脚本依赖的标记
 *   - 检查域 = 仓库的定义域：只查属于这个仓库的文本文件——被忽略的本机状态目录
 *     （编辑器缓存、依赖、多智能体协作状态……）一律不参与，脚本不需要认识它们
 *   - 全文无 emoji（项目硬性规范）
 *   - 无 BOM；行尾一致（可复现构建的前提）
 *   - 不含构建机私有路径（换台机器就要能跑）
 *   - AGENTS.md 里的内核与 templates/agents-kernel.md 逐字一致
 *   - 带外部易变事实的章节文件都有统一核对标记（缺标记、错 scope、坏日期即失败；
 *     超期只警告——时间流逝不是破损）
 *
 * 用法：
 *   node scripts/preflight.mjs
 *
 * 检查对象由脚本自身位置推导（根 = 本文件所在目录的上一级），不接受目录参数——
 * 换目录检查的做法会让「检查了谁」变成一个可传错的值。
 *
 * 退出码 0 = 全绿；1 = 有 FAIL；2 = 脚本自身用法错误。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule, README_NAME_RE, HOME_PATH_RE } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

/** 会话技能目录对 description 的截断长度（宿主实现事实，超出即不可见）。 */
const CATALOG_DESCRIPTION_MAX = 500
/** 会话上下文对工作区指令的字节预算。 */
const INSTRUCTION_BUDGET = 65536

const KERNEL_START = '<!-- project-forge:kernel:start -->'
const KERNEL_END = '<!-- project-forge:kernel:end -->'

/**
 * 保鲜超期阈值（天）。超过这么多天没重核即警告。
 *
 * 只警告不失败：时间流逝不是破损，红了就是误报——那种检查很快会被无视，
 * 而被无视的检查等于不存在。阈值只在这里定义一处，文档里不写死数字
 * （写了就会漂移）；警告信息里会报出已过期天数与重核哪几节。
 */
export const FRESHNESS_STALE_DAYS = 180

/**
 * 「含构建机私有路径」这一项要豁免的文件，每个都写明豁免理由。
 *
 * 两类都合法，但理由不同：
 *   - **定义模式的文件**：它们必须写出各种路径形状才能检测别人（survey、preflight 自己）；
 *   - **测试数据的文件**：selftest 故意在 fixture 里放 `/home/me` 这类假路径，用来验证
 *     「真泄漏要报、测试数据不要误导」这条判定。删掉它就等于删掉那组测试。
 *
 * 顺带说明为什么不用「自动识别测试目录」来豁免：那会让检查逻辑与 survey 的判定逻辑
 * 缠在一起，而这一项检查的意义恰恰是**独立**看一眼有没有真路径漏进产物。宁可维护一份
 * 带理由的短名单，也不要让它学会忽略。
 */
const HOME_PATH_EXEMPT = new Map([
  ['scripts/preflight.mjs', '定义路径检测模式，必须写出各种路径形状'],
  ['scripts/survey.mjs', '定义路径检测模式，必须写出各种路径形状'],
  ['scripts/selftest.mjs', '故意在 fixture 里放假路径，验证分档判定'],
])

/**
 * 参与文本检查的文件。
 *
 * 按扩展名判断会漏掉一整类重要的文件：`.gitignore`、`.gitattributes`、`LICENSE`、
 * `Makefile` 这些**没有扩展名**或名字特殊的文件，恰恰是配置与许可证所在。
 * 所以除了扩展名，另外按已知的特殊文件名与「无扩展名但不大」的规则收进来。
 */
const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt'])
const TEXT_SPECIAL_NAMES = new Set([
  '.gitignore', '.gitattributes', '.npmignore', '.editorconfig', '.env.example',
  'license', 'licence', 'makefile', 'dockerfile', 'procfile',
])
const MAX_TEXTLESS_BYTES = 256 * 1024

/** SKILL.md 之外允许存在的顶层条目。多出来的东西要有人解释它为什么在这。 */
const ALLOWED_TOP_LEVEL = new Set([
  'SKILL.md', 'AGENTS.md', 'README.md', 'CONTRIBUTING.md', 'LICENSE',
  'references', 'templates', 'scripts', '.github', '.gitignore', '.gitattributes', '.git',
])

const failures = []
const warnings = []

function fail(message) { failures.push(message) }
function warn(message) { warnings.push(message) }

function rel(p) { return relative(SKILL_ROOT, p).split('\\').join('/') }

function readText(p) {
  return readFileSync(p, 'utf8')
}

/**
 * 这个仓库的文件全集（相对仓库根，POSIX 分隔符）。
 *
 * 判据是**仓库的定义域**，不是「工作目录里现在有什么」：受版本控制跟踪的文件，
 * 加上尚未被忽略的新文件——这正是「这个仓库包含什么」，由项目自己的版本控制给出。
 *
 * 为什么不维护「该跳过哪些目录」的黑名单：那种写法每来一个工具就要再加一条
 * （编辑器缓存、依赖、构建产物、多智能体协作状态……），而这份名单永远追不上环境
 * 的变化；它还会把「检查了谁」变成一个需要人记得维护的取值。按定义域判则一视同仁：
 * 只要这些目录被忽略（正常项目都会忽略），就自动落在定义之外，脚本不需要认识
 * 其中任何一个——通则即稳定。
 *
 * 为什么不用 git 之外的手段判断忽略规则：忽略语法有通配、否定、层级差异，自己解析
 * 必然有偏差，而这里的偏差代价是「该查的没查」或「不该查的被查」。项目自身的忽略
 * 规则才是权威来源（它同时覆盖仓库级、本机级与全局级）。
 *
 * git 不可用（没装、或这个目录还不是仓库）时退回纯文件系统扫描：此时没有权威的忽略
 * 规则，只能跳过两个一定不属于仓库的目录，并把降级如实报告出来。静默降级会让检查
 * 看起来覆盖了全部文件而实际没有——那比不查更坏。
 *
 * 导出给 selftest：判定要能被直接证伪，而不是只能靠跑整棵 skill 树观察（同 evalFreshnessMarker）。
 */
export function listRepoFiles(root) {
  const r = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  })
  if (r.error === undefined && r.status === 0 && typeof r.stdout === 'string') {
    // -z：路径按字节给、不做引号转义，含空格或中文的路径才不会被改写成另一个字符串。
    return { files: r.stdout.split('\0').filter((p) => p !== ''), source: 'git' }
  }
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (entry.isFile()) files.push(relative(root, full).split(/[\\/]/).join('/'))
    }
  }
  walk(root)
  return { files, source: 'fs' }
}

/** 定义域只算一次；降级提示也只报一次（两个调用方共用同一份结果）。 */
let repoDomainCache
function repoDomain() {
  if (repoDomainCache === undefined) {
    repoDomainCache = listRepoFiles(SKILL_ROOT)
    if (repoDomainCache.source === 'fs') {
      warn('git 不可用：文本检查域退回文件系统扫描（只跳过 .git 与依赖目录）——'
        + '本机状态目录可能被一并计入，覆盖面与「仓库定义域」不同。这是降级，不是全查。')
    }
  }
  return repoDomainCache
}

/** 定义域里参与逐字检查的文本文件（绝对路径）。 */
function repoTextFiles() {
  const out = []
  for (const rel of repoDomain().files) {
    const full = join(SKILL_ROOT, rel)
    // 索引里有、工作区里没有（已暂存删除）的条目要跳过，否则读文件时直接抛错。
    if (!existsSync(full)) continue
    const lower = rel.split('/').pop().toLowerCase()
    const dot = lower.lastIndexOf('.')
    const ext = dot <= 0 ? '' : lower.slice(dot)
    if (TEXT_EXTENSIONS.has(ext) || TEXT_SPECIAL_NAMES.has(lower)) { out.push(full); continue }
    // 无扩展名的文件也纳入，但要排除明显的二进制大文件
    if (dot <= 0) {
      try {
        if (statSync(full).size <= MAX_TEXTLESS_BYTES) out.push(full)
      } catch { /* 读不到就跳过 */ }
    }
  }
  return out
}

// ── 检查一：SKILL.md 能否被宿主识别 ─────────────────────────────────────────

function checkSkillFile() {
  const path = join(SKILL_ROOT, 'SKILL.md')
  if (!existsSync(path)) { fail('缺少 SKILL.md —— 宿主不会识别这个 skill。'); return undefined }
  const raw = readText(path)
  const text = raw.replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if (lines[0] !== '---') { fail('SKILL.md 第一行必须是 ---（YAML frontmatter 起始）。'); return undefined }
  let end = -1
  for (let i = 1; i < lines.length; i += 1) if (lines[i] === '---') { end = i; break }
  if (end < 0) { fail('SKILL.md 的 frontmatter 没有结束标记 ---。'); return undefined }
  const block = lines.slice(1, end).join('\n')

  const nameMatch = /^name:[ \t]*(.+)$/m.exec(block)
  if (nameMatch === null) { fail('SKILL.md frontmatter 缺少 name。'); return undefined }
  const name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    fail(`SKILL.md 的 name「${name}」不符合宿主规则 ^[a-z0-9]+(?:-[a-z0-9]+)*$ —— 宿主会忽略整个 skill。`)
  }
  const dirName = basename(SKILL_ROOT)
  if (name !== dirName) {
    fail(`SKILL.md 的 name「${name}」与目录名「${dirName}」不一致 —— 两者必须相同。`)
  }
  if (!/^description:[ \t]*\|?/m.test(block)) {
    fail('SKILL.md frontmatter 缺少 description —— 宿主不识别没有描述的技能。')
  } else {
    // 取 description 的值（支持块标量），只用于长度估算
    const descLines = []
    let collecting = false
    for (const line of block.split('\n')) {
      if (/^description:/.test(line)) { collecting = true; descLines.push(line.replace(/^description:[ \t]*\|?[ \t]*/, '')); continue }
      if (collecting) {
        if (/^[A-Za-z-]+:/.test(line)) break
        descLines.push(line)
      }
    }
    const desc = descLines.join('\n').trim()
    if (desc.length === 0) fail('SKILL.md 的 description 为空。')
    else if (desc.length > CATALOG_DESCRIPTION_MAX) {
      fail(
        `description 长度 ${desc.length} 超过 ${CATALOG_DESCRIPTION_MAX} —— `
        + '超出部分在会话技能目录里会被截断，等于不存在。请把触发词前置、精简表述。',
      )
    }
  }
  // 驼峰旧键会让宿主直接拒绝加载
  for (const legacy of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (new RegExp(`^${legacy}:`, 'm').test(block)) {
      fail(`frontmatter 使用了已废弃的驼峰键 ${legacy}，宿主会拒绝加载；请改用连字符形式。`)
    }
  }
  return { text, name }
}

// ── 检查二：引用完整性 ──────────────────────────────────────────────────────

/**
 * 扫描所有 Markdown 里的资源引用，逐个确认文件存在。
 *
 * 覆盖全部文档而不只是 SKILL.md：reference 之间互相引用是常态，只查入口等于只守住了
 * 一扇门。引用断链的代价很高——AI 按图索骥走到死路，然后开始猜。
 */
function checkReferencesResolve() {
  const docs = repoTextFiles().filter((f) => f.endsWith('.md'))
  if (docs.length === 0) { fail('没有找到任何 Markdown 文件。'); return }
  // 只认这三种路径形状：本 skill 的资源就在这三类目录下。
  // 占位示例请写成 `references/<文件名>.md`——尖括号不在字符类里，因此不会被当成真实
  // 路径去检查。这是刻意的：占位符不是引用，报它属于误报。
  const re = /`((?:references|templates|scripts)\/[A-Za-z0-9._/-]+)`/g
  let total = 0
  for (const full of docs) {
    const name = rel(full)
    const text = readText(full).replace(/^\uFEFF/, '')
    const seen = new Set()
    for (const m of text.matchAll(re)) seen.add(m[1])
    for (const target of [...seen].sort()) {
      total += 1
      if (!existsSync(join(SKILL_ROOT, target))) {
        fail(`${name} 引用了不存在的文件：${target} —— AI 会按图索骥走到死路。`)
      }
    }
  }
  if (total === 0) warn('全文没有引用任何 references / templates / scripts 路径。')
}

// ── 检查三：references 的结构约定 ───────────────────────────────────────────

function checkReferences() {
  const dir = join(SKILL_ROOT, 'references')
  if (!existsSync(dir)) { fail('缺少 references 目录。'); return }
  const files = []
  const collect = (sub) => {
    let entries = []
    try {
      entries = readdirSync(join(dir, sub), { withFileTypes: true, encoding: 'utf8' })
    } catch { return }
    for (const e of entries) {
      if (e.isDirectory()) { collect(sub === '' ? e.name : `${sub}/${e.name}`); continue }
      if (e.isFile() && e.name.endsWith('.md')) files.push(sub === '' ? e.name : `${sub}/${e.name}`)
    }
  }
  collect('')
  if (files.length === 0) { fail('references 目录里没有任何 Markdown 文件。'); return }
  for (const file of files) {
    const text = readText(join(dir, file)).replace(/^\uFEFF/, '')
    const lines = text.split(/\r?\n/)
    const first = lines.find((l) => l.trim() !== '')
    if (first === undefined || !first.startsWith('# ')) {
      fail(`references/${file} 的第一行必须是一级标题（# 标题）。`)
    }
    if (!/^## 何时读本文件[ \t]*$/m.test(text)) {
      fail(`references/${file} 缺少二级标题「## 何时读本文件」—— AI 无法判断何时该读它。`)
    }
    if (text.trim().length < 400) {
      warn(`references/${file} 内容过短（${text.trim().length} 字符），可能不足以支撑决策。`)
    }
  }
}

// ── 检查四：templates 的标记与内核一致性 ────────────────────────────────────

function checkTemplates() {
  const dir = join(SKILL_ROOT, 'templates')
  if (!existsSync(dir)) { fail('缺少 templates 目录。'); return }
  for (const f of ['agents-kernel.md', 'agents-project.md', 'readme.md', 'contributing.md']) {
    if (!existsSync(join(dir, f))) fail(`缺少 templates/${f}。`)
  }
  // 许可证模板：docs-set 让使用者从这里取用而不是凭记忆写，缺了就等于没守住那条规则。
  //
  // 占位符按模板逐个声明，不用统一规则：Unlicense 是「放弃权利」，**全文没有版权行**
  // ——没有年份也没有持有人，这是它与其他许可证的实质区别。给它硬塞占位符反而是错的。
  const LICENSE_TEMPLATES = [
    { file: 'license-mit.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    { file: 'license-isc.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    { file: 'license-bsd-2-clause.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    { file: 'license-bsd-3-clause.txt', tokens: ['{{YEAR}}', '{{HOLDER}}'] },
    // Unlicense 是**反向**断言：它的实质是放弃权利，所以既没有占位符、也没有版权行。
    // 只查「占位符存在」会漏掉这一类——有人好心地补一行 `Copyright (c)` 进去，
    // 文档里那句「全文没有版权行」就变成了假话，而检查什么都不会说。
    {
      file: 'license-unlicense.txt',
      tokens: [],
      absent: ['Copyright (c)', '{{'],
      note: '放弃权利，无版权行',
    },
  ]
  for (const { file, tokens, absent } of LICENSE_TEMPLATES) {
    const p = join(dir, file)
    if (!existsSync(p)) { fail(`缺少 templates/${file}（许可证模板，docs-set 引用它）。`); continue }
    const text = readText(p)
    for (const token of tokens) {
      if (!text.includes(token)) fail(`templates/${file} 缺少占位符 ${token}。`)
    }
    for (const marker of absent ?? []) {
      if (text.includes(marker)) {
        fail(`templates/${file} 出现了不该有的内容「${marker}」——它是放弃权利的标准文本，`
          + '没有版权行也没有占位符；补上它们会与 docs-set 的说明和许可证性质矛盾。')
      }
    }
    if (text.trim().length < 200) fail(`templates/${file} 内容异常短，可能不是完整许可证文本。`)
  }
  // docs-set 里列出的模板表必须与实际文件一致
  const docsSet = join(SKILL_ROOT, 'references', 'docs-set.md')
  if (existsSync(docsSet)) {
    const text = readText(docsSet)
    for (const m of text.matchAll(/`(templates\/license-[a-z0-9-]+\.txt)`/g)) {
      if (!existsSync(join(SKILL_ROOT, m[1]))) {
        fail(`references/docs-set.md 引用了不存在的许可证模板：${m[1]}。`)
      }
    }
  }
  const kernelPath = join(dir, 'agents-kernel.md')
  if (!existsSync(kernelPath)) return

  const kernel = readText(kernelPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  for (const marker of ['## 行事总纲', '## 本文件的定位与编辑规则']) {
    if (!kernel.includes(marker)) fail(`templates/agents-kernel.md 缺少必需章节：${marker}`)
  }

  const skeletonPath = join(dir, 'agents-project.md')
  if (!existsSync(skeletonPath)) return
  const skeleton = readText(skeletonPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!skeleton.includes(KERNEL_START) || !skeleton.includes(KERNEL_END)) {
    fail('templates/agents-project.md 缺少内核标记，脚本无法注入。')
  }
  const si = skeleton.indexOf(KERNEL_START)
  const ei = skeleton.indexOf(KERNEL_END)
  if (si >= 0 && ei > si && skeleton.slice(si + KERNEL_START.length, ei).trim() !== '') {
    warn('templates/agents-project.md 的内核标记之间不是空的 —— 注入时会被覆盖，这是预期的，但请确认没有把项目特有内容放进去。')
  }
}

// ── 检查五：AGENTS.md 的内核与模板一致 ──────────────────────────────────────

function checkAgentsKernel() {
  const agentsPath = join(SKILL_ROOT, 'AGENTS.md')
  if (!existsSync(agentsPath)) { warn('本 skill 还没有 AGENTS.md。'); return }
  const kernelPath = join(SKILL_ROOT, 'templates', 'agents-kernel.md')
  if (!existsSync(kernelPath)) return
  const agents = readText(agentsPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const kernel = readText(kernelPath).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
    .replaceAll(KERNEL_START, '').replaceAll(KERNEL_END, '')
    .replace(/^\n+/, '').replace(/\n+$/, '')
  const si = agents.indexOf(KERNEL_START)
  const ei = agents.indexOf(KERNEL_END)
  if (si < 0 || ei < 0) { fail('AGENTS.md 缺少内核标记。'); return }
  const embedded = agents.slice(si + KERNEL_START.length, ei).replace(/^\n/, '').replace(/\n$/, '')
  if (embedded !== kernel) {
    fail('AGENTS.md 里的内核与 templates/agents-kernel.md 不一致。修正：node scripts/compose-agents.mjs .')
  }
  const bytes = Buffer.byteLength(agents, 'utf8')
  if (bytes > INSTRUCTION_BUDGET) {
    fail(`AGENTS.md 共 ${bytes} 字节，超出 ${INSTRUCTION_BUDGET} 预算，注入时会被截断。`)
  } else if (bytes > INSTRUCTION_BUDGET * 0.8) {
    warn(`AGENTS.md 已占预算 ${((bytes / INSTRUCTION_BUDGET) * 100).toFixed(1)}%，余量不多。`)
  }
}

// ── 检查六：全文硬性规范（emoji / BOM / 行尾 / 私有路径） ───────────────────

/** Extended_Pictographic 覆盖绝大多数 emoji；箭头、对勾一类符号不在其内，可正常使用。 */
const EMOJI = /\p{Extended_Pictographic}/u
/** 本机私有路径的判据与 survey 同源（survey 导出 HOME_PATH_RE，两份手写正则必然漂移）。 */
const HOME_PATH = HOME_PATH_RE

function checkGlobalRules() {
  const files = repoTextFiles()
  if (files.length === 0) { fail('没有收集到任何文本文件。'); return }
  for (const full of files) {
    const name = rel(full)
    const raw = readText(full)
    if (raw.startsWith('\uFEFF')) fail(`${name} 含 BOM，会让产物在不同工具下出现差异。`)
    if (EMOJI.test(raw)) {
      const hit = raw.match(EMOJI)
      fail(`${name} 含 emoji 字符（${JSON.stringify(hit?.[0])}）—— 项目硬性规范禁止。`)
    }
    if (/\r\n/.test(raw)) {
      warn(`${name} 含 CRLF 行尾。若在 Windows 上检出后出现，执行 git add --renormalize . 重新规范化。`)
    }
    if (!HOME_PATH_EXEMPT.has(name) && HOME_PATH.test(raw)) {
      fail(`${name} 含构建机私有路径 —— 换台机器就会失准。`
        + '（若这是有意的测试数据或模式定义，请把它加进 preflight.mjs 的 HOME_PATH_EXEMPT 并写明理由。）')
    }
  }
  // 顶层目录整洁：多出来的条目必须有明确归属。
  //
  // 判据同样取**仓库定义域**：本机状态目录（被忽略、不属于这个仓库）不该在这里被要求
  // 解释——它不是这个仓库的内容，工具下次还会生成它。只有属于仓库的条目才需要有人
  // 说明它为什么在这。
  let entries = []
  try { entries = readdirSync(SKILL_ROOT, { withFileTypes: true, encoding: 'utf8' }).map((e) => e.name) } catch { /* 忽略 */ }
  const domainFiles = repoDomain().files
  for (const entry of entries) {
    if (ALLOWED_TOP_LEVEL.has(entry)) continue
    if (README_NAME_RE.test(entry)) continue
    if (!domainFiles.some((p) => p === entry || p.startsWith(`${entry}/`))) continue
    warn(`顶层出现未登记的条目：${entry} —— 请确认它是否应该在这里。`)
  }
}

// ── 检查七：脚本自身可执行 ──────────────────────────────────────────────────

function checkScripts() {
  const dir = join(SKILL_ROOT, 'scripts')
  if (!existsSync(dir)) { fail('缺少 scripts 目录。'); return }
  for (const f of ['survey.mjs', 'compose-agents.mjs', 'preflight.mjs', 'selftest.mjs',
    'release-notes.mjs', 'draft-release-notes.mjs', 'review.mjs', 'check-badges.mjs', 'sync-toc.mjs']) {
    const p = join(dir, f)
    if (!existsSync(p)) { fail(`缺少 scripts/${f}。`); continue }
    const text = readText(p)
    if (!text.startsWith('#!/usr/bin/env node')) warn(`scripts/${f} 缺少 node shebang。`)
    if (statSync(p).size < 200) fail(`scripts/${f} 内容异常短。`)
    // 零依赖的含义是「不要求使用者先装东西」，因此允许两类：
    //   - `node:` 前缀的内置模块；
    //   - 相对路径（本 skill 自己的其他脚本，随仓库一起走）。
    // 其余裸模块名一律拒绝：那是要装的东西。
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue
      fail(`scripts/${f} 引入了外部模块「${spec}」—— 这个 skill 必须零依赖。`)
    }
  }

  // scripts/ 里只允许 JavaScript。
  //
  // README 对外承诺「Python 完全不需要」，那条承诺必须由机制守住，否则某天有人为了
  // 图方便加一个 .py 辅助脚本，承诺就悄悄变成假话，而没有任何检查会提示。
  const entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  for (const entry of entries) {
    if (entry.isDirectory()) { fail(`scripts/ 下不应有子目录：${entry.name}。`); continue }
    if (!/\.mjs$/.test(entry.name)) {
      fail(`scripts/${entry.name} 不是 .mjs —— 这个 skill 只允许 JavaScript 脚本`
        + '（README 承诺「Python 完全不需要」，别让那句变成假话）。')
    }
  }
}

// ── 检查八：脚本真的能跑起来 ────────────────────────────────────────────────

/**
 * 静态检查抓不到「import 写错、运行时抛错、参数解析有 bug」这类问题——本 skill 的
 * survey.mjs 就曾因为少一个 import 直接崩溃，而当时的自检全绿放行了它。
 * 所以这里实际执行一遍，只看退出码与是否吐出应有结构的输出。
 *
 * 只跑只读或幂等的模式：--markdown 只读，--check/--status 不写文件。
 */
function checkScriptsRun() {
  const cases = [
    { file: 'survey.mjs', args: [SKILL_ROOT, '--markdown'], expect: /勘察结果/ },
    { file: 'compose-agents.mjs', args: [SKILL_ROOT, '--check'], expect: /内核一致|校验失败/ },
    { file: 'compose-agents.mjs', args: [SKILL_ROOT, '--status'], expect: /字节|手写/ },
  ]
  for (const { file, args, expect } of cases) {
    const p = join(SKILL_ROOT, 'scripts', file)
    if (!existsSync(p)) continue
    const r = spawnSync(process.execPath, [p, ...args], { encoding: 'utf8', env: process.env })
    const label = `${file} ${args.slice(1).join(' ') || '(无参数)'}`
    if (r.error !== undefined) {
      fail(`scripts/${file} 无法执行：${r.error.message}`)
      continue
    }
    if (r.status !== 0 && !expect.test(r.stdout ?? '')) {
      // 首行通常只是位置信息，真正的错误在更靠后的行——把整段 stderr 收进来，
      // 否则最需要的那句（SyntaxError、ReferenceError 之类）会被切掉。
      const detail = (r.stderr ?? '').trim().split('\n').filter((l) => l.trim() !== '')
        .slice(0, 6).join(' / ')
      fail(`scripts/${file} 以退出码 ${r.status} 结束（${label}）：${detail}`)
      continue
    }
    if (r.status === 0 && !expect.test(r.stdout ?? '')) {
      fail(`scripts/${file} 退出码为 0，但没有输出预期内容（${label}）—— 可能被静默改坏。`)
    }
  }
}

/**
 * 跑行为自检。
 *
 * 静态检查抓不到「判定写错了」——survey 把 CMake 项目判成纯文档目录，引用与格式全都
 * 正常。而这类错误在这个 skill 上已经出现过三次（密钥门控失效、仓库边界误判、条件段落
 * 冻结），每次都是靠手工造 fixture 才发现的。所以把 fixture 固化成常驻检查：改动之后
 * 跑一遍，行为退化立刻可见。
 */
function checkBehavior() {
  const p = join(SKILL_ROOT, 'scripts', 'selftest.mjs')
  if (!existsSync(p)) { fail('缺少 scripts/selftest.mjs（行为自检）。'); return }
  const r = spawnSync(process.execPath, [p], { encoding: 'utf8', env: process.env })
  const out = r.stdout ?? ''
  if (r.error !== undefined) { fail(`行为自检无法执行：${r.error.message}`); return }
  // 摘要是以「行为自检：」开头的那一行。不能用「最后一行」——环境不具备时后面还会跟
  // 一段「跳过」清单，取最后一行会取到清单里的最后一项。
  const summary = out.split('\n').find((l) => l.startsWith('行为自检：')) ?? '(未输出摘要)'
  if (r.status !== 0) {
    const body = out.split('失败项：')[1] ?? ''
    const fails = body.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
    fail(`行为自检未通过（${summary.replace(/^行为自检：/, '')}）:\n       ${fails.join('\n       ')}`)
    return
  }
  process.stdout.write(`${summary.replace(/^行为自检：/, '行为自检：')}\n`)
  // 有跳过时一并转述：跳过是环境不具备，不是缺陷，但它改变了这次检查的覆盖面，
  // 不说明就等于悄悄缩小了验证范围。
  const skipBlock = out.split('跳过（环境不具备，不是缺陷）：')[1]
  if (skipBlock !== undefined) {
    const items = skipBlock.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- '))
    for (const s of items) process.stdout.write(`         ${s}\n`)
  }
}

// ── 检查九：文档里的「数量自称」必须与现实相符 ──────────────────────────────

/** 中文数字 → 数值。只覆盖文档里实际会用到的那几个。 */
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12 }

/**
 * 文档里写「三道门控」「四个脚本」这类数量时，**必须与实际相符**。
 *
 * 这类数字是典型的快照：加了东西忘了改，文档就开始说假话，而假话没有任何症状——
 * 没有检查时它只能靠人工核对发现，而人工核对恰恰是这类数字失准的盲区。
 *
 * 判据是「文档里的数字 vs 实际数出来的数量」，全自动，不需要人记得。
 */
function checkStatedCounts() {
  const actual = {
    硬不变量: countNumberedItems('SKILL.md', /^## 硬不变量/, /^\d+\.\s+\*\*/),
    硬门控: countMatches('SKILL.md', /^\|\s*G\d+\s*\|/gm),
    // 数文件地图里那一节的行，而不是全文匹配：正文里提到某个脚本（例如「本 skill 自身的
    // 自检（`scripts/preflight.mjs`）」）也会命中，那是叙述不是清单。
    脚本: countTableRows('SKILL.md', /^## 文件地图/, /^\|\s*`scripts\/[a-z-]+\.mjs`/),
    参考文档: countTableRows('SKILL.md', /^## 文件地图/, /^\|\s*`references\/[a-z-]+\.md`/),
    骨架模板: countTableRows('SKILL.md', /^## 文件地图/, /^\|\s*`templates\/[a-z-]+\.md`/),
  }

  // **与磁盘对账**，不只是两份文档互相对。
  //
  // 这一步是必须的：只比「文件地图的行数」与「文档里写的数量」时，**两个文档同时
  // 漏掉同一个脚本，它两边都对得上**——文档之间互相印证不构成证据，得跟磁盘上的
  // 事实比。
  const scriptsDir = join(SKILL_ROOT, 'scripts')
  if (existsSync(scriptsDir)) {
    const onDisk = readdirSync(scriptsDir, { withFileTypes: true, encoding: 'utf8' })
      .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
      .map((e) => e.name)
    for (const f of onDisk) {
      if (!readText(join(SKILL_ROOT, 'SKILL.md')).includes(`scripts/${f}`)) {
        fail(`scripts/${f} 没有登记在 SKILL.md 的文件地图里 —— 写了却没人知道它存在，等于没写。`)
      }
    }
    for (const f of ['survey.mjs', 'compose-agents.mjs', 'preflight.mjs', 'selftest.mjs']) {
      if (!onDisk.includes(f)) fail(`磁盘上缺少 scripts/${f}。`)
    }
  }
  // 磁盘对账：references 与 templates ——新文件加了却没登记在文件地图里即隐身。
  // 只查顶层 .md（子目录专章由插件索引检查覆盖）与全部模板文件。
  {
    const skillText = readText(join(SKILL_ROOT, 'SKILL.md'))
    const refDir = join(SKILL_ROOT, 'references')
    if (existsSync(refDir)) {
      for (const e of readdirSync(refDir, { withFileTypes: true, encoding: 'utf8' })) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue
        if (!skillText.includes(`references/${e.name}`)) {
          fail(`references/${e.name} 没有登记在 SKILL.md 的文件地图里 —— 写了却没人知道它存在，等于没写。`)
        }
      }
    }
    const tplDir = join(SKILL_ROOT, 'templates')
    if (existsSync(tplDir)) {
      for (const e of readdirSync(tplDir, { withFileTypes: true, encoding: 'utf8' })) {
        if (!e.isFile()) continue
        if (!skillText.includes(`templates/${e.name}`)) {
          fail(`templates/${e.name} 没有登记在 SKILL.md 的文件地图里 —— 写了却没人知道它存在，等于没写。`)
        }
      }
    }
  }
  // README 方向的对账：README 面向的是「刚拿到这个 skill 的人」，它的脚本表与文件表
  // 就是他的全景图。**只查 SKILL.md 那一侧会漏掉这一半**——README 少列一个文件时
  // 别的检查不会出声（读者照着 README 找东西，找不到就是找不到）。
  // 两份 README 都要查：它们成对维护，只查一份等于放另一半漂移。
  for (const readme of ['README.md', 'README.en.md']) {
    const p = join(SKILL_ROOT, readme)
    if (!existsSync(p)) continue
    const text = readText(p).replace(/^\uFEFF/, '')
    const missing = []
    const scan = (dir, prefix, filter) => {
      if (!existsSync(dir)) return
      for (const e of readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })) {
        if (!filter(e)) continue
        if (!text.includes(`${prefix}${e.name}`)) missing.push(`${prefix}${e.name}`)
      }
    }
    scan(join(SKILL_ROOT, 'scripts'), 'scripts/', (e) => e.isFile() && e.name.endsWith('.mjs'))
    scan(join(SKILL_ROOT, 'references'), 'references/', (e) => e.isFile() && e.name.endsWith('.md'))
    if (missing.length > 0) {
      fail(`${readme} 没有列出这些磁盘上存在的文件：${missing.join('、')} —— `
        + '读者照着它找东西，找不到就是找不到；补进文件表再提交。')
    }
  }
  // 门禁命令表在 AGENTS.md 与 CONTRIBUTING 各写了一份，**两处必须说同一件事**：
  // 贡献者按 CONTRIBUTING 自查、CI 与维护者按 AGENTS.md 自查，少一个参数就是
  // 「照做的人拿到的命令不是真命令」（实测 sync-toc 漏了 README.en.md 那次）。
  {
    const commands = (file, headingRe) => {
      const p = join(SKILL_ROOT, file)
      if (!existsSync(p)) return undefined
      const lines = readText(p).replace(/^\uFEFF/, '').split('\n')
      const at = lines.findIndex((l) => headingRe.test(l))
      if (at < 0) return undefined
      // 只看标题之后的**第一个围栏代码块**：那一节里可能还有别的命令示例（例如
      // 「改了内核后要重新注入」那一小段），把它们算进「门禁命令表」是读错了范围。
      const out = new Set()
      let inFence = false
      let seenFence = false
      for (let i = at + 1; i < lines.length; i += 1) {
        if (/^##\s/.test(lines[i])) break
        if (/^\s*```/.test(lines[i])) {
          if (!inFence) {
            if (seenFence) break
            inFence = true
            seenFence = true
          } else inFence = false
          continue
        }
        if (!inFence) continue
        const line = lines[i].trim()
        if (!line.startsWith('node ')) continue
        out.add(line.split(/\s+#/)[0].replace(/\s+/g, ' ').trim())
      }
      return out
    }
    const a = commands('AGENTS.md', /^## 构建与验证/)
    const c = commands('CONTRIBUTING.md', /^## 提交前门禁/)
    if (a !== undefined && c !== undefined) {
      const onlyA = [...a].filter((x) => !c.has(x))
      const onlyC = [...c].filter((x) => !a.has(x))
      if (onlyA.length > 0 || onlyC.length > 0) {
        fail('提交前门禁的命令表在两处不一致：'
          + `${onlyA.length > 0 ? `只有 AGENTS.md 有 ${onlyA.join(' / ')}；` : ''}`
          + `${onlyC.length > 0 ? `只有 CONTRIBUTING.md 有 ${onlyC.join(' / ')}；` : ''}`
          + '两处必须是同一批命令（含参数）。')
      }
    }
  }
  // 常量一致性：两处预算必须相等；约定名 RELEASE_TOKEN 必须在模板与文档同拼写。
  // 改一处忘另一处是本类最常见的 drift，注释写“同步”不如机器断言。
  {
    const composeText = existsSync(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs'))
      ? readText(join(SKILL_ROOT, 'scripts', 'compose-agents.mjs')) : ''
    const budgetA = /DEFAULT_BUDGET\s*=\s*(\d+)/.exec(composeText)?.[1]
    const budgetB = /INSTRUCTION_BUDGET\s*=\s*(\d+)/.exec(readText(join(SKILL_ROOT, 'scripts', 'preflight.mjs')))?.[1]
    if (budgetA !== undefined && budgetB !== undefined && budgetA !== budgetB) {
      fail(`字节预算不一致：compose-agents.mjs 为 ${budgetA}，preflight.mjs 为 ${budgetB} —— 两处必须是同一数。`)
    }
    const tokenSpellings = new Set()
    for (const f of ['templates/ci-release.yml', '.github/workflows/check.yml', 'references/remote-github.md', 'AGENTS.md', 'SKILL.md']) {
      const p = join(SKILL_ROOT, f)
      if (!existsSync(p)) continue
      for (const m of readText(p).matchAll(/RELEASE[_-]?TOKEN/ig)) tokenSpellings.add(m[0])
    }
    if (tokenSpellings.size > 1) {
      fail(`约定名拼写不一致：${[...tokenSpellings].join('、')} —— 必须统一为 RELEASE_TOKEN。`)
    }
  }
  const readmeText = existsSync(join(SKILL_ROOT, 'README.md'))
    ? readText(join(SKILL_ROOT, 'README.md')).replace(/^\uFEFF/, '') : ''
  for (const m of readmeText.matchAll(/`scripts\/([a-z-]+\.mjs)`/g)) {
    if (!existsSync(join(SKILL_ROOT, 'scripts', m[1]))) {
      fail(`README.md 提到了不存在的脚本 scripts/${m[1]}。`)
    }
  }

  // 文档里出现的「<中文数字><量词>」与「<阿拉伯数字> 个<量词>」
  const WATCHED = [
    { word: '硬不变量', key: '硬不变量' },
    { word: '硬门控', key: '硬门控' },
  ]
  const docs = ['SKILL.md', 'README.md', 'AGENTS.md', 'CONTRIBUTING.md']
  for (const doc of docs) {
    const p = join(SKILL_ROOT, doc)
    if (!existsSync(p)) continue
    const text = readText(p).replace(/^\uFEFF/, '')
    for (const { word, key } of WATCHED) {
      // 要求数字前不是「第」——「第一硬不变量」是序数（「第一个」），不是数量断言，
      // 误报它只会让人去改一句其实正确的话。
      const re = new RegExp(`(?<!第)([一二三四五六七八九十]+|\\d+)\\s*(?:道|条|个)?${word}`, 'g')
      for (const m of text.matchAll(re)) {
        const raw = m[1]
        const n = /^\d+$/.test(raw) ? Number(raw) : CN_NUM[raw]
        if (n === undefined) continue
        if (n !== actual[key]) {
          fail(`${doc} 写着「${raw}${word}」，实际是 ${actual[key]} —— 数量自称与代码不符。`
            + '要么改数字，要么去掉数字（数量是快照，会过期）。')
        }
      }
    }
    // 脚本数量：写成「N 个脚本」时核对
    for (const m of text.matchAll(/(?<!第)([一二三四五六七八九十]+|\d+)\s*个?\s*脚本/g)) {
      const raw = m[1]
      const n = /^\d+$/.test(raw) ? Number(raw) : CN_NUM[raw]
      if (n !== undefined && n !== actual['脚本']) {
        fail(`${doc} 写着「${raw}个脚本」，实际是 ${actual['脚本']} 个 —— 数量自称与代码不符。`)
      }
    }
  }
}

/** 在某个二级标题之下，数匹配到的行数。用于「文件地图」这类表格清单。 */
function countTableRows(file, headingRe, rowRe) {
  const p = join(SKILL_ROOT, file)
  if (!existsSync(p)) return -1
  const lines = readText(p).replace(/^\uFEFF/, '').split('\n')
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start < 0) return -1
  let count = 0
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    if (rowRe.test(lines[i])) count += 1
  }
  return count
}

/** 数某个文件里匹配到的个数。 */
function countMatches(file, re) {
  const p = join(SKILL_ROOT, file)
  if (!existsSync(p)) return -1
  return (readText(p).replace(/^\uFEFF/, '').match(re) ?? []).length
}

/** 数「某个二级标题之下、某个模式的编号项」有几条。 */
function countNumberedItems(file, headingRe, itemRe) {
  const p = join(SKILL_ROOT, file)
  if (!existsSync(p)) return -1
  const lines = readText(p).replace(/^\uFEFF/, '').split('\n')
  const start = lines.findIndex((l) => headingRe.test(l))
  if (start < 0) return -1
  let count = 0
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) break
    if (itemRe.test(lines[i])) count += 1
  }
  return count
}

// ── 检查十：插件专章必须都登记在索引里 ──────────────────────────────────────

/**
 * `references/plugins/` 下的每个专章，都必须出现在 `plugin-project.md` 的索引表里。
 *
 * 这个结构有个隐蔽的失效方式：**专章写了，但没人知道它存在**——通用文件是入口
 * （G6 只强制读它），索引表是唯一的路标。漏登记的专章等于没写，而文件确实在那儿、
 * 检查也全绿。
 *
 * 反向也查：索引里列了、文件却不在（引用断链）。
 */
function checkPluginChapters() {
  const dir = join(SKILL_ROOT, 'references', 'plugins')
  const index = join(SKILL_ROOT, 'references', 'plugin-project.md')
  if (!existsSync(dir)) {
    if (existsSync(index)) fail('references/plugin-project.md 存在，但没有 references/plugins/ 目录。')
    return
  }
  if (!existsSync(index)) {
    fail('缺少 references/plugin-project.md —— 插件类项目的入口文件，专章靠它索引。')
    return
  }
  const indexText = readText(index).replace(/^\uFEFF/, '')

  const files = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)

  for (const f of files) {
    const rel = `references/plugins/${f}`
    if (!indexText.includes(rel)) {
      fail(`${rel} 没有登记在 references/plugin-project.md 的「专章索引」里 ——`
        + '专章写了却没人知道它存在，等于没写。')
    }
  }
  // 索引里指向不存在文件的引用，由 checkReferencesResolve 统一查；这里只补一条：
  // 索引表里出现的 plugins 路径必须真有对应文件
  for (const m of indexText.matchAll(/`(references\/plugins\/[a-z0-9-]+\.md)`/g)) {
    if (!existsSync(join(SKILL_ROOT, m[1]))) {
      fail(`references/plugin-project.md 的索引引用了不存在的专章：${m[1]}。`)
    }
  }
  if (files.length === 0) warn('references/plugins/ 下还没有任何专章。')
  // 「事实来源」节与核对标记的校验已收敛到 checkFreshness（检查十三）统一处理，
  // 这里不再另起一套——两处各判一遍，迟早漏一边。
}

// ── 检查十三：外部事实保鲜（统一核对标记） ──────────────────────────────────

/**
 * 根因：外部事实（字段名、数量上限、UI 路径、版本下限）会过期，而文档把它当永久
 * 知识存，过期后没有任何声音。所以每份“带外部易变事实”的章节文件，都在
 * 「事实来源」节末尾带一个机器可读的核对标记；本检查校验它。
 *
 * 标记形状（向后兼容：现存标记本来就长这样，这里只是第一次把它写下来）：
 *   <!-- <scope>-verified: date=YYYY-MM-DD [key=value ...] -->
 * scope 必须与文件名对应，date 必须是真实日历日期；key=value 允许扩展
 * （如 dsh 的 host=，compose 靠它判断滞后），本检查只认 date。
 *
 * 分工（判据见 AGENTS.md「外部事实保鲜」节，此处只实现，不复述）：
 *   - 章节家族（references/plugins/*.md 与 references/publish-*.md）：
 *     节与标记双向缺一不可——缺节说明来源没交代，缺标记说明核对没落到纸面。
 *   - 其他 references 文件（机制稳定的，如 publish.md、survey.md）：
 *     不强制要求；但一旦带了标记，就按同一套规则校验（不能悬空、不能错位）。
 *   - 超期只警告不失败；格式/归属/位置错才失败。
 */

/** 按文件名推导标记作用域：dsh.md→dsh，publish-npm.md→npm。 */
function expectedFreshnessScope(rel) {
  const base = rel.split('/').pop().replace(/\.md$/, '')
  return base.replace(/^publish-/, '')
}

/**
 * 「事实来源」节的标题形状。
 *
 * 判的是**这一节在不在**，不是「标题这一串字长得对不对」。专章模板的骨架写成
 * `## 八、事实来源（必填）`——编号让它在文件里定位得到，括注提醒写的人这一节必填；
 * 若按字面匹配，照着模板新建的专章会被判成「没有来源节」，于是模板与检查器互相打架。
 * 所以容忍两类**装饰**：编号前缀（`八、`、`3.`）与尾部括注（`（必填）`）。
 *
 * 不容忍的是**改名**：`## 事实来源与更新` 之类不算这一节——那已经不是同一节了，
 * 而放行它等于让「有没有交代来源」这个问题失去判据。要放宽这条，先想清楚新的
 * 失效模式是什么，别为了少报一次失败把判据调成永真。
 */
const FRESHNESS_SECTION_RE =
  /^##[ \t]*(?:[0-9一二三四五六七八九十百]+[、.．)）][ \t]*)?事实来源(?:[ \t]*[（(][^）)\n]*[）)])?[ \t]*$/m

/**
 * 纯函数：判定一份文档里的保鲜标记。只管格式，不管“该不该有”
 * （“该不该有”由 checkFreshness 按文件家族定——混在一起，单测就写不清了）。
 *
 * 返回 { hasSection, count, scope, date, ageDays, errors[], warnings[] }。
 * 无标记时 errors/warnings 为空，调用方按家族规则决定要不要 fail。
 */
export function evalFreshnessMarker(rel, text, todayStr, tomorrowStr) {
  const result = {
    hasSection: false, count: 0,
    scope: undefined, date: undefined, ageDays: undefined,
    keys: {},
    errors: [], warnings: [],
  }
  const clean = text.replace(/^\uFEFF/, '')
  const sectionAt = clean.search(FRESHNESS_SECTION_RE)
  result.hasSection = sectionAt >= 0
  const found = [...clean.matchAll(/<!--\s*([A-Za-z0-9-]+)-verified:\s*([^>]*?)\s*-->/g)]
  result.count = found.length
  if (found.length === 0) return result
  if (found.length > 1) {
    result.errors.push(`有 ${found.length} 个核对标记，只能恰好一个 —— 删掉重复的，留日期最新的那一个。`)
    return result
  }
  const marker = found[0]
  if (!result.hasSection) {
    result.errors.push('核对标记没有对应的「事实来源」节 —— 标记必须住在该节末尾，不能悬空。')
    return result
  }
  if (marker.index < sectionAt) {
    result.errors.push('核对标记在「事实来源」节之前 —— 把它移到该节末尾（见兄弟文件的同名节）。')
    return result
  }
  const scope = marker[1]
  result.scope = scope
  const expected = expectedFreshnessScope(rel)
  if (scope !== expected) {
    result.errors.push(`核对标记的作用域是「${scope}」，按文件名应为「${expected}」—— 从别的文件复制时忘了改吧？`)
  }
  const dateMatch = /(?:^|\s)date=([0-9-]+)(?:\s|$)/.exec(` ${marker[2].trim()} `)
  if (dateMatch === null) {
    result.errors.push('核对标记里没有 date=YYYY-MM-DD —— 格式见 AGENTS.md「外部事实保鲜」节。')
    return result
  }
  const dateStr = dateMatch[1]
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)
    || Number.isNaN(Date.parse(dateStr))
    || new Date(`${dateStr}T00:00:00Z`).toISOString().slice(0, 10) !== dateStr) {
    result.errors.push(`核对标记的日期「${dateStr}」不是真实日历日期 —— 按 YYYY-MM-DD 写真实日期。`)
    return result
  }
  result.date = dateStr
  if (dateStr > tomorrowStr) {
    // 允许一天宽限：写标记的人与跑检查的机器可能有时区差；超过一天就是笔误。
    result.errors.push(`核对标记的日期「${dateStr}」在未来 —— 把 date 改成重核的当天日期。`)
    return result
  }
  const ageDays = Math.floor(
    (Date.parse(`${todayStr}T00:00:00Z`) - Date.parse(`${dateStr}T00:00:00Z`)) / 86400000,
  )
  result.ageDays = ageDays
  if (ageDays > FRESHNESS_STALE_DAYS) {
    result.warnings.push(`上次核对是 ${dateStr}（${ageDays} 天前），超期了 —— 按「事实来源」节写明的范围重核官方文档，确认无误后把 date 改成当天。`)
  }
  // 其余键的形状校验：**机器无关的那一半进失败区**（零成本纯收益）；
  // 没认领的键只提示「未核对」，不失败——扩展键是允许的，但它的含义得有人认领。
  const parsed = parseMarkerKeys(marker[2])
  result.keys = parsed.keys
  for (const e of parsed.errors) result.errors.push(e)
  for (const note of parsed.notes) result.warnings.push(note)
  return result
}

/**
 * 取「事实来源」节的**正文**：标题行之后，到下一个同级或更高级标题（或文件尾）为止。
 *
 * 不能用 `text.slice(text.search(RE))`——那从标题本身切起，而标题里就含「来源」二字，
 * 判据于是恒真。按 markdown 语义取正文，判据才可能真的失败。
 */
export function freshnessSectionBody(text) {
  const lines = String(text).split('\n')
  const at = lines.findIndex((l) => FRESHNESS_SECTION_RE.test(l))
  if (at < 0) return ''
  const level = (/^#+/.exec(lines[at].trim())?.[0].length) ?? 2
  const body = []
  for (let i = at + 1; i < lines.length; i += 1) {
    const h = /^(#+)\s+/.exec(lines[i])
    if (h !== null && h[1].length <= level) break
    body.push(lines[i])
  }
  return body.join('\n')
}

/**
 * 这一节的来源说明能不能照着做：链接 / 文档名 / 具体步骤，至少得有一类。
 * 判据按「有」而不是「没有」写，避免把措辞差异判成缺陷；但**空节必须失败**。
 */
export function hasActionableSources(body) {
  const textBody = String(body ?? '')
  if (textBody.trim() === '') return false
  const hasLink = /https?:\/\/\S+/.test(textBody)
  const hasDocName = /官方|文档|手册|指南|manual|docs?\.|reference|changelog|release notes/i.test(textBody)
  const hasSteps = /节|章|页|section|chapter|查|核对|重核|步骤|命令|search|look up|check/i.test(textBody)
    && textBody.trim().length >= 40
  return hasLink || hasDocName || hasSteps
}

/**
 * 已认领的标记键：含义与形状**只在这里定义一次**。
 *
 * 没认领的键不是错误（可扩展），但要按「未核对」提示出来——它不会被校验、也不参与
 * 比对。值一律要求**非空且单行**（标记解析按空白切分，值里带空白本身就写不成单行）。
 * `host=` 的语义是「上次核对时**本机实际运行**的那套宿主版本」——不是兼容下界，
 * 也不是某个目标项目锁定的版本；多值写法已否决（它表达不了「本机跑的是哪一版」）。
 */
export const CLAIMED_MARKER_KEYS = {
  date: { note: '核对日期' },
  host: { reject: /[,\s]/, note: '上次核对时本机实际运行的那套宿主版本' },
}

/** 解析标记里的 key=value，返回 { keys, errors, notes }。纯函数，直接可证伪。 */
export function parseMarkerKeys(raw) {
  const errors = []
  const notes = []
  const keys = {}
  for (const part of String(raw ?? '').trim().split(/\s+/).filter(Boolean)) {
    const eq = part.indexOf('=')
    if (eq <= 0) {
      errors.push(`核对标记里的「${part}」不是 key=value 形状——每个键写成 key=value，值不许含空白（值必须非空且单行）。`)
      continue
    }
    const name = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) {
      errors.push(`核对标记的键名「${name}」形状非法——用字母开头，其后是字母、数字、下划线或连字符。`)
      continue
    }
    if (value === '') {
      errors.push(`核对标记的「${name}=」值是空的——值必须非空且单行。`)
      continue
    }
    if (keys[name] !== undefined) {
      errors.push(`核对标记里「${name}」出现了多次——每个键只写一次。`)
      continue
    }
    const claimed = CLAIMED_MARKER_KEYS[name]
    if (claimed === undefined) {
      notes.push(`核对标记里的「${name}=」没有认领的含义——它不会被校验，也不能参与比对（未登记即未核对）。`)
    } else if (claimed.reject !== undefined && claimed.reject.test(value)) {
      errors.push(`核对标记的「${name}=${value}」格式非法——${name} 应是单个不含量空白与逗号的值。`)
    }
    keys[name] = value
  }
  return { keys, errors, notes }
}

/**
 * 版本串归一：**只吃写法差异，不做版本序、不折叠预发布**。
 * 顺序：trim → 去开头 `^ ~ > = <` 与空白 → 去开头 v/V（后面紧跟数字时）→ 小写。
 *
 * **只实现这一处**：compose-agents 与 preflight 共用同一份（两处各判一次同类问题，
 * 迟早给出两种答案）。`0.1.5-rc.1` 与 `0.1.5` 归一后**不同**——那是两次不同的发布，
 * 折叠掉等于隐瞒「章里核的是 rc、本机装的是正式版」这个事实。
 */
export function normVersion(value) {
  return String(value ?? '')
    .trim()
    .replace(/^[\^~>=<\s]+/, '')
    .replace(/^[vV](?=\d)/, '')
    .toLowerCase()
}

/**
 * 标记里的 host= 与本机宿主的三态比对。**纯函数**（来源由调用方给），fixture 才喂得进
 * 数据。三态各有确定文本，于是断言可以只锁确定的那部分、不锁「本机装了什么」。
 *
 * sources: [{ source, value, reason }]，value 为 undefined 表示这条来源取不到。
 */
export function compareHostMarker(markerHost, sources) {
  const usable = (sources ?? []).filter((s) => typeof s?.value === 'string' && s.value.trim() !== '')
  if (usable.length === 0) {
    const why = (sources ?? []).map((s) => `${s.source}${s.reason ? `（${s.reason}）` : ''}`).join('；')
    return { state: 'undetermined', reason: `本机取不到宿主版本（未装、查询失败或没有可用的取值途径）${why ? `：${why}` : ''}`, values: [] }
  }
  const values = usable.map((s) => ({ source: s.source, value: normVersion(s.value) }))
  const distinct = [...new Set(values.map((v) => v.value))]
  if (distinct.length > 1) {
    return {
      state: 'undetermined',
      reason: `本机两条来源互相矛盾（无法确定本机跑的是哪一版）：${values.map((v) => `${v.source} ⇒ ${v.value}`).join('；')}`,
      values,
    }
  }
  const mine = distinct[0]
  const theirs = normVersion(markerHost)
  if (mine === theirs) return { state: 'match', reason: '', values }
  return { state: 'mismatch', reason: `标记里是 ${markerHost}，本机实际是 ${usable[0].value}`, values }
}

/** 探针超时：宿主 CLI 启动可能慢，但一次卡住不能挂住整次自检。超时 = 未核对。 */
const HOST_PROBE_TIMEOUT_MS = 20000

/**
 * 按 scope 登记的取值途径。**只有登记过的宿主参与比对**；没登记就是「未核对」。
 *
 * 通用代码里不出现任何宿主的名字、命令或路径——名字与参数都在这张表里；每条登记项
 * 给两个**独立来源**：宿主自己的版本查询入口 + 它自己的安装元数据。
 */
const HOST_PROBES = {
  dsh: {
    cli: { command: 'dsh', args: ['--version'] },
    metadata: { manager: 'npm', package: '@deepseek-ai/dsh' },
  },
}

/** 跑登记表里的命令。失败返回 undefined（不抛错，调用方按「取不到」处理）。 */
function runRegisteredCommand(command, args) {
  const first = spawnSync(command, args, { encoding: 'utf8', windowsHide: true, timeout: HOST_PROBE_TIMEOUT_MS })
  if (first.error === undefined && first.status === 0) return first.stdout ?? ''
  if (process.platform !== 'win32') return undefined
  // Windows 上的两级退让：Node 不套 PATHEXT（裸名 ENOENT），也拒绝直接 spawn
  // `.cmd`/`.bat`（EINVAL，CVE-2024-27980 起的加固）。于是走 `cmd.exe /d /s /c`——
  // 命令行与参数**全部来自上面的登记表字面量**，不插入任何项目派生内容或用户输入。
  // `cmd.exe` 是平台胶水，对所有登记项一视同仁，所以它不进登记表。
  // 不用 `shell: true`：它在 Node 里已废弃（DEP0190，且参数只拼接不转义）——
  // 把弃用路径写进常驻检查，将来红的会是我们的自检，而不是使用者的代码。
  const line = [command, ...args].join(' ')
  const viaCmd = spawnSync('cmd.exe', ['/d', '/s', '/c', line], { encoding: 'utf8', windowsHide: true, timeout: HOST_PROBE_TIMEOUT_MS })
  if (viaCmd.error === undefined && viaCmd.status === 0) return viaCmd.stdout ?? ''
  return undefined
}

/** 从命令输出里取版本：只认**唯一**的版本形状 token，出现两个不同值就视为取不到。 */
function versionFromOutput(out) {
  const tokens = String(out ?? '').match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?/g) ?? []
  const distinct = [...new Set(tokens)]
  return distinct.length === 1 ? distinct[0] : undefined
}

/** 安装元数据来源：分发根**运行时查**，路径由「分发根 + 登记项里的包名」拼出，不写死。 */
function hostMetadataValue(entry) {
  const meta = entry?.metadata
  if (meta === undefined) return undefined
  const rootOut = runRegisteredCommand(meta.manager, ['root', '-g'])
  const root = String(rootOut ?? '').trim().split('\n').map((l) => l.trim()).filter(Boolean)[0]
  if (root === undefined || root === '') return undefined
  try {
    const pkg = JSON.parse(readFileSync(join(root, ...meta.package.split('/'), 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

const hostProbeCache = new Map()

/**
 * 取本机宿主版本。**惰性 + 每进程每 scope 只跑一次**（同 repoDomainCache 的做法）。
 * 返回 { scope, registered, sources }；sources 里每条都带取不到的原因。
 */
export function probeHost(scope) {
  if (hostProbeCache.has(scope)) return hostProbeCache.get(scope)
  const entry = HOST_PROBES[scope]
  let result
  if (entry === undefined) {
    result = { scope, registered: false, sources: [], reason: `没有登记「${scope}」的取值途径——未登记即未核对` }
  } else {
    const sources = []
    if (entry.cli !== undefined) {
      const out = runRegisteredCommand(entry.cli.command, entry.cli.args)
      const value = out === undefined ? undefined : versionFromOutput(out)
      sources.push({
        source: `${entry.cli.command} ${entry.cli.args.join(' ')}`,
        value,
        reason: out === undefined
          ? '命令取不到（未装或查询失败）'
          : (value === undefined ? `输出里没有唯一的版本形状（原文首行：${String(out).split('\n')[0].slice(0, 60)}）` : ''),
      })
    }
    if (entry.metadata !== undefined) {
      const value = hostMetadataValue(entry)
      sources.push({
        source: `${entry.metadata.package} 的安装元数据`,
        value,
        reason: value === undefined ? '分发根或包元数据读不到（没有对应的包管理器，或该包不在全局安装里）' : '',
      })
    }
    result = { scope, registered: true, sources }
  }
  hostProbeCache.set(scope, result)
  return result
}

/**
 * 「改 host= 必须与 date= 同批」——做成机制，不是注释提醒。
 *
 * 判据：找出最后一次改动 `host=` 的那个提交 A（`git log -S`），再看 A 与 A^ 两版里
 * `date=` 是否同时变化。A 里 host= 变了而 date= 没变，就是那次只改了版本号、日期还停在
 * 上一次核对日：比对会喊「一致」，而日期是假的——最难发现的一种假绿。
 *
 * 取不到 A（值尚未提交、文件未跟踪、浅克隆或无 git）→ 报「未核对」，不静默也不失败：
 * 换台机器或浅克隆不该因此变红。`runGit` 可注入，fixture 直接喂数据。
 */
export function hostDateBatchStatus(repoRoot, rel, hostValue, runGit) {
  const git = runGit ?? ((args) => {
    const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
    return r.error === undefined && r.status === 0 ? (r.stdout ?? '') : undefined
  })
  const found = git(['-c', 'core.quotepath=false', 'log', '-1', '--format=%H', '-S', `host=${hostValue}`, '--', rel])
  const commit = String(found ?? '').trim().split('\n')[0].trim()
  if (commit === '') {
    return { state: 'unverified', reason: '版本控制里找不到改动 host= 的提交（值尚未提交、文件未跟踪，或没有可用的 git 历史）' }
  }
  const after = git(['show', `${commit}:${rel}`])
  const before = git(['show', `${commit}^:${rel}`])
  if (after === undefined || before === undefined) {
    return { state: 'unverified', reason: `读不到提交 ${commit.slice(0, 8)} 前后的内容（可能是根提交或浅克隆）` }
  }
  const dateOf = (text) => /(?:^|\s)date=([0-9-]+)/.exec(String(text))?.[1]
  if (dateOf(after) !== dateOf(before)) return { state: 'ok', reason: '' }
  return {
    state: 'stale',
    reason: `最后一次改 host= 的提交 ${commit.slice(0, 8)} 没有同时改 date=（两版里都是 ${dateOf(after) ?? '未声明'}）——只改了版本号的日期是不可信的`,
  }
}

function checkFreshness() {
  const todayStr = new Date().toISOString().slice(0, 10)
  const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10)
  const files = []
  try {
    for (const e of readdirSync(join(SKILL_ROOT, 'references'), { withFileTypes: true, encoding: 'utf8' })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(`references/${e.name}`)
    }
  } catch { /* 缺目录由检查三报，这里不重复 */ }
  try {
    const plugDir = join(SKILL_ROOT, 'references', 'plugins')
    for (const e of readdirSync(plugDir, { withFileTypes: true, encoding: 'utf8' })) {
      if (e.isFile() && e.name.endsWith('.md')) files.push(`references/plugins/${e.name}`)
    }
  } catch { /* 缺目录由检查十报，这里不重复 */ }
  for (const rel of files.sort()) {
    let text
    try {
      text = readText(join(SKILL_ROOT, rel))
    } catch { continue }
    // 判据是「这个文件承载了外部易变事实」，**不是文件名模式**：总纲 publish.md 与
    // remote-github.md 同样带着跨生态的易变取值（制品库行为、令牌有效期、界面路径），
    // 按文件名匹配会把它们漏在保鲜之外——而它们恰恰是最常被照抄的那两页。
    const isChapter = /^references\/plugins\/[a-z0-9-]+\.md$/.test(rel)
      || /^references\/publish-[a-z0-9-]+\.md$/.test(rel)
      || rel === 'references/publish.md'
      || rel === 'references/remote-github.md'
    const r = evalFreshnessMarker(rel, text, todayStr, tomorrowStr)
    if (isChapter && !r.hasSection) {
      fail(`${rel} 缺少「事实来源」节——带外部易变事实的章节必须写来源与核实方式（插件专章见 plugin-project.md 骨架的「事实来源（必填）」节，发布专章见兄弟文件的同名节）。`)
    }
    if (isChapter && r.count === 0) {
      fail(`${rel} 缺少统一核对标记——在「事实来源」节末尾附一个（格式与用法见 references/publish.md 的『专章的「事实来源」标记』一节）。`)
    }
    // 「事实来源」不能只是一句套话：它必须写出**能照着做的查法**（来源链接，或
    // 去哪个文档的哪一节怎么核），否则「上次看到的值」过期时读的人无处可查。
    //
    // 这条判据曾经是**永真**的：它从 `text.slice(text.search(FRESHNESS_SECTION_RE))`
    // 取「正文」，而那一段从**标题本身**切起——标题里就有「来源」二字，于是
    // `/https?:\/\/|官方|文档|来源/` 恒命中，fail 是死代码（实测：一份只有标题加标记的
    // 最简文档照样 0 失败通过）。现在按 markdown 语义取节正文，并在 selftest 里
    // 用「只有标题的最简文档必须报错」证伪它。
    if (isChapter && r.hasSection) {
      if (!hasActionableSources(freshnessSectionBody(text))) {
        fail(`${rel} 的「事实来源」节没有写出可执行的查法——至少要有来源链接，或写明去哪个文档的哪一节怎么核；只有一句套话等于没有。`)
      }
    }
    for (const e of r.errors) fail(`${rel} ${e}`)
    for (const w of r.warnings) warn(`${rel} ${w}`)

    // host= 的三态比对：**只有带这个键的专章参与**，按 scope 查登记的取值途径。
    // 全部落在提示区、绝不失败：换台机器校验、宿主回滚、同机多份宿主都能造出
    // 「不同」，脚本判不了是不是真滞后——判不了罪就不能失败，而且进失败区就是
    // 「换台机器必红」，那是本项目明确要避免的检查。
    if (isChapter && r.keys?.host !== undefined) {
      const scope = expectedFreshnessScope(rel)
      const probe = probeHost(scope)
      if (probe.registered !== true) {
        warn(`${rel} 的 host=${r.keys.host} 未核对：${probe.reason}。**「没比」与「比过且一致」是两回事，不要读成通过。**`)
      } else {
        const cmp = compareHostMarker(r.keys.host, probe.sources)
        if (cmp.state === 'match') {
          // 一致 → 静默（不产生噪音，这一态是绝大多数情况）
        } else if (cmp.state === 'mismatch') {
          warn(`${rel} 的 host=${r.keys.host} 与本机实际宿主不同（${cmp.reason}）——两种解释都成立："
            + '专章滞后（宿主升级后没重核），或换台机器校验 / 宿主回滚 / 同机存在多份宿主。'
            + '**只提示不失败**：脚本判不了是不是真滞后。按该文件的「事实来源」节重核后，把 host= 与 date= **一起**改。`)
        } else {
          warn(`${rel} 的 host= 未核对：${cmp.reason}。**「没比」与「比过且一致」是两回事，不要读成通过。**`)
        }
      }
      // 两键同批：只改 host= 而不改 date= 的假绿在这里现形（同样只提示不失败——
      // 历史提交改不了，判成失败等于留下一条永远消不掉的红色）。
      const batch = hostDateBatchStatus(SKILL_ROOT, rel, r.keys.host)
      if (batch.state === 'stale') warn(`${rel} 的 host= 与 date= 不是同批更新的：${batch.reason}`)
      else if (batch.state === 'unverified') warn(`${rel} 的 host= 与 date= 是否同批**未核对**：${batch.reason}`)
    }
  }
  process.stdout.write('保鲜标记：格式与归属一致\n')
}

// ── 检查十一：README 的目录与标题同步 ───────────────────────────────────────

/**
 * README 的目录是派生内容（由各节标题决定），因此必须与标题保持同步。
 *
 * 这条检查的价值在于「漂移会当场暴露」：加了一节忘了加目录项、改了标题忘了改锚点，
 * 而**锚点写错的表现是「点了没反应」**——不报错、不显眼，作者也不会去点自己的目录。
 * 所以不能靠记得，得靠检查。
 *
 * 只查本地能算的东西（目录 vs 标题），**不查徽章**：徽章要联网、依赖外部服务，
 * 放进检查会因为对方抖动而误报，那种检查很快就会被无视。
 */
function checkReadmeToc() {
  // 中英文两份都查：CI 查两份，只查中文会让英文漂移漏网。
  const readmes = [join(SKILL_ROOT, 'README.md'), join(SKILL_ROOT, 'README.en.md')]
    .filter((p) => existsSync(p))
  if (readmes.length === 0) { warn('没有 README.md。'); return }
  const script = join(SKILL_ROOT, 'scripts', 'sync-toc.mjs')
  if (!existsSync(script)) { fail('缺少 scripts/sync-toc.mjs（README 目录的同步工具）。'); return }
  const r = spawnSync(process.execPath, [script, ...readmes, '--check'], { encoding: 'utf8', env: process.env })
  if (r.error !== undefined) { fail(`目录同步检查无法执行：${r.error.message}`); return }
  if (r.status !== 0) {
    const detail = (r.stdout ?? '').trim().split('\n').filter((l) => l.trim() !== '').join(' / ')
    fail(`README 的目录与标题不同步：${detail}\n`
      + `      修正：node scripts/sync-toc.mjs README.md README.en.md`)
    return
  }
  process.stdout.write('README 目录：与标题一致\n')
}

// ── 检查十二：取值污染（单样本个案值不得回流进通用文档） ─────────────────────
//
// references/ 与 templates/ 是通用规则，只能写查法与判据。task-board 这类单样本的
// 具体取值（包名、存储键、插槽座位、列名、路由）一旦写进来，就会被 AI 当成结论照抄
// 到别的插件上。判据是字面出现，不是语义：出现即红。
function checkValuePollution() {
  const targets = []
  const collect = (dir) => {
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
    } catch { return }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { collect(full); continue }
      if (!/\.(md|mjs|yml)$/.test(e.name)) continue
      targets.push(full)
    }
  }
  collect(join(SKILL_ROOT, 'references'))
  collect(join(SKILL_ROOT, 'templates'))
  const banned = ['dsh-task-board', 'dsh_task_board', 'dsh.taskBoard', '@firetruck666']
  let hits = 0
  for (const f of targets) {
    let text = ''
    try {
      text = readText(f)
    } catch { continue }
    for (const b of banned) {
      if (text.includes(b)) {
        const rel = relative(SKILL_ROOT, f).split('\\').join('/')
        fail(`取值污染：${rel} 出现单样本字面「${b}」——通用文档只写查法，个案值须现场读。`)
        hits += 1
        break
      }
    }
  }
  if (hits === 0) process.stdout.write('取值无污染：通用文档无单样本字面\n')
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

function main() {
  const skill = checkSkillFile()
  checkReferencesResolve()
  checkReferences()
  checkTemplates()
  checkAgentsKernel()
  checkGlobalRules()
  checkScripts()
  checkScriptsRun()
  checkStatedCounts()
  checkPluginChapters()
  checkFreshness()
  checkReadmeToc()
  checkValuePollution()
  checkBehavior()
  // SKILL.md 自己也要有「何时使用」——它要求每份 reference 都写「何时读本文件」，
  // 入口本身不能例外。
  if (skill !== undefined && !/^## 何时使用[ \t]*$/m.test(skill.text)) {
    fail('SKILL.md 缺少二级标题「## 何时使用」—— 入口必须说清什么情况下该用它。')
  }

  for (const w of warnings) process.stdout.write(`WARN  ${w}\n`)
  for (const f of failures) process.stdout.write(`FAIL  ${f}\n`)
  process.stdout.write(
    `\n自检完成：${failures.length} 项失败，${warnings.length} 项提示`
    + `（目录：${SKILL_ROOT}）\n`,
  )
  return failures.length === 0 ? 0 : 1
}

// 与 survey.mjs 同一模式：直接执行才跑 main，被 import（selftest 测保鲜判据时
// 会 import 本文件）时只取导出的纯函数，不产生副作用。
//
// 判据是**真实路径**比较（survey 的 isMainModule，只此一处实现）：字面比较在经
// junction 或符号链接调用时永不相等，脚本于是什么都不做并返回 0——实测「preflight
// 走 junction」就是 exit 0、零输出，CI 与人都会读成自检通过。
if (isMainModule(import.meta.url, process.argv[1])) process.exitCode = main()
