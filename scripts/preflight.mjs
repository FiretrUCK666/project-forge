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
 *   - 全文无 emoji（项目硬性规范）
 *   - 无 BOM；行尾一致（可复现构建的前提）
 *   - 不含构建机私有路径（换台机器就要能跑）
 *   - AGENTS.md 里的内核与 templates/agents-kernel.md 逐字一致
 *
 * 用法：
 *   node scripts/preflight.mjs [skill 目录]
 *
 * 退出码 0 = 全绿；1 = 有 FAIL；2 = 脚本自身用法错误。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')

/** 会话技能目录对 description 的截断长度（宿主实现事实，超出即不可见）。 */
const CATALOG_DESCRIPTION_MAX = 500
/** 会话上下文对工作区指令的字节预算。 */
const INSTRUCTION_BUDGET = 65536

const KERNEL_START = '<!-- project-forge:kernel:start -->'
const KERNEL_END = '<!-- project-forge:kernel:end -->'

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

/** 递归收集文本文件；跳过版本控制与依赖目录。 */
function collectTextFiles(root, out = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) { collectTextFiles(full, out); continue }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    const dot = entry.name.lastIndexOf('.')
    const ext = dot <= 0 ? '' : entry.name.slice(dot).toLowerCase()
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
  const docs = collectTextFiles(SKILL_ROOT).filter((f) => f.endsWith('.md'))
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
  const files = readdirSync(dir).filter((f) => f.endsWith('.md'))
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
    { file: 'license-unlicense.txt', tokens: [], note: '放弃权利，无版权行' },
  ]
  for (const { file, tokens } of LICENSE_TEMPLATES) {
    const p = join(dir, file)
    if (!existsSync(p)) { fail(`缺少 templates/${file}（许可证模板，docs-set 引用它）。`); continue }
    const text = readText(p)
    for (const token of tokens) {
      if (!text.includes(token)) fail(`templates/${file} 缺少占位符 ${token}。`)
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
  for (const marker of ['## 行事总纲', '## 本文件的定位与编辑规则', '## 任务编排方法论']) {
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
/** 与 survey.mjs 共用同一语义：双分隔符、用户名宽容（见 survey HOME_PATH_PATTERNS，真相源在 survey，改动需两边同步）。 */
const HOME_PATH = /[A-Za-z]:[\\/]Users[\\/][^\\/\s"'`]+|[\\/](?:home|Users)[\\/][^\\/\s"'`]+/

function checkGlobalRules() {
  const files = collectTextFiles(SKILL_ROOT)
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
  // 顶层目录整洁：多出来的条目必须有明确归属
  let entries = []
  try { entries = readdirSync(SKILL_ROOT, { withFileTypes: true, encoding: 'utf8' }).map((e) => e.name) } catch { /* 忽略 */ }
  for (const entry of entries) {
    if (!ALLOWED_TOP_LEVEL.has(entry) && !/^readme([._-][a-z]{2}([._-][a-z]{2})?)?\.(md|markdown|rst|txt|adoc)$/i.test(entry)) {
      warn(`顶层出现未登记的条目：${entry} —— 请确认它是否应该在这里。`)
    }
  }
}

// ── 检查七：脚本自身可执行 ──────────────────────────────────────────────────

function checkScripts() {
  const dir = join(SKILL_ROOT, 'scripts')
  if (!existsSync(dir)) { fail('缺少 scripts 目录。'); return }
  for (const f of ['survey.mjs', 'compose-agents.mjs', 'preflight.mjs', 'selftest.mjs',
    'release-notes.mjs', 'check-badges.mjs']) {
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
 * 这个 skill 自己就中过：硬门控从 6 道加到 7 道、脚本从 3 个加到 4 个之后，
 * README 与 AGENTS.md 里「六道硬门控」「三个脚本」还留着，直到人工核对才发现。
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
  // 这一步是必须的：计数检查原先只比「文件地图的行数」与「文档里写的数量」，
  // 而**两个文档同时漏掉同一个脚本时，它两边都对得上**——实测漏了 sync-toc.mjs 而
  // 检查全绿。文档之间互相印证不构成证据，得跟事实比。
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
  const readme = join(SKILL_ROOT, 'README.md')
  if (!existsSync(readme)) { warn('没有 README.md。'); return }
  const script = join(SKILL_ROOT, 'scripts', 'sync-toc.mjs')
  if (!existsSync(script)) { fail('缺少 scripts/sync-toc.mjs（README 目录的同步工具）。'); return }
  const r = spawnSync(process.execPath, [script, readme, '--check'], { encoding: 'utf8', env: process.env })
  if (r.error !== undefined) { fail(`目录同步检查无法执行：${r.error.message}`); return }
  if (r.status !== 0) {
    const detail = (r.stdout ?? '').trim().split('\n').filter((l) => l.trim() !== '').join(' / ')
    fail(`README 的目录与标题不同步：${detail}\n`
      + `      修正：node scripts/sync-toc.mjs README.md`)
    return
  }
  process.stdout.write('README 目录：与标题一致\n')
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
  checkReadmeToc()
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

process.exitCode = main()
