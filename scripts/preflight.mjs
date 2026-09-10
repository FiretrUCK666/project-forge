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

/** 本文件自身含私有路径的形状定义，按惯例豁免；理由与豁免范围一并写在这里。 */
const SELF_EXEMPT = new Set(['scripts/preflight.mjs', 'scripts/survey.mjs'])

const TEXT_EXTENSIONS = new Set(['.md', '.mjs', '.js', '.json', '.yml', '.yaml', '.txt'])

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
    const ext = entry.name.slice(entry.name.lastIndexOf('.'))
    if (TEXT_EXTENSIONS.has(ext)) out.push(full)
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
  // 只认这三种路径形状：本 skill 的资源就在这三类目录下
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
const HOME_PATH = /[A-Za-z]:\\Users\\|\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\//

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
    if (!SELF_EXEMPT.has(name) && HOME_PATH.test(raw)) {
      fail(`${name} 含构建机私有路径 —— 换台机器就会失准。`)
    }
  }
  // 顶层目录整洁：多出来的条目必须有明确归属
  let entries = []
  try { entries = readdirSync(SKILL_ROOT, { withFileTypes: true, encoding: 'utf8' }).map((e) => e.name) } catch { /* 忽略 */ }
  for (const entry of entries) {
    if (!ALLOWED_TOP_LEVEL.has(entry)) {
      warn(`顶层出现未登记的条目：${entry} —— 请确认它是否应该在这里。`)
    }
  }
}

// ── 检查七：脚本自身可执行 ──────────────────────────────────────────────────

function checkScripts() {
  const dir = join(SKILL_ROOT, 'scripts')
  if (!existsSync(dir)) { fail('缺少 scripts 目录。'); return }
  for (const f of ['survey.mjs', 'compose-agents.mjs', 'preflight.mjs']) {
    const p = join(dir, f)
    if (!existsSync(p)) { fail(`缺少 scripts/${f}。`); continue }
    const text = readText(p)
    if (!text.startsWith('#!/usr/bin/env node')) warn(`scripts/${f} 缺少 node shebang。`)
    if (statSync(p).size < 200) fail(`scripts/${f} 内容异常短。`)
    // 脚本必须只用内置模块：这个 skill 不能要求使用者先装依赖
    for (const m of text.matchAll(/from\s+'([^']+)'/g)) {
      const spec = m[1]
      if (!spec.startsWith('node:')) {
        fail(`scripts/${f} 引入了非内置模块「${spec}」—— 这个 skill 必须零依赖。`)
      }
    }
  }
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
