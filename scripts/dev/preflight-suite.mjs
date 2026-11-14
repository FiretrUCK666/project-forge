/**
 * preflight-suite.mjs —— 脚本依赖、架构边界、Dev Profile 单源、孤儿脚本、平台语义对齐、模板与套件卫生校验。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  FORBIDDEN_PLATFORM_RE, KIT_SKILL_MAX_LINES, KIT_SKILLS, PF_MANIFEST_REL,
  REPO_ONLY_DIRS, REPO_ONLY_FILES, TEMPLATE_CONDITIONS, TEMPLATE_VARS,
  conditionMarkers, templateVarsOf,
} from '../lib/protocol.mjs'
import { checkEquip } from '../equip.mjs'
import { githubRepoPath as engineGithubRepoPath } from '../lib/text.mjs'
import { checkMermaidLabelWidth } from '../../kit/skills/lib/docs.mjs'
import { buildNonInteractiveEnv as kitBuildNonInteractiveEnv } from '../../kit/skills/lib/git.mjs'
import { parseDocFrontmatter } from '../../kit/skills/lib/shared.mjs'
import { validateDocTocAnchors } from './preflight-contracts.mjs'

const HISTORY_PATHS = [/^docs\/work\//, /^docs\/archive\//, /^docs\/release-notes\//]
const OWN_INSTANCE_CHECKS = [
  { template: 'templates/pull-request-template.md', instance: '.github/pull_request_template.md' },
  { template: 'templates/issue-bug-report.md', instance: '.github/ISSUE_TEMPLATE/bug_report.md' },
  { template: 'templates/issue-feature-request.md', instance: '.github/ISSUE_TEMPLATE/feature_request.md' },
  { template: 'templates/releasing.md', instance: 'RELEASING.md' },
  { template: 'templates/contributing.md', instance: 'CONTRIBUTING.md' },
]
const RETIRED_NAMES = [
  'selftest.mjs', 'review-record.mjs', 'agents-kernel.md', 'pf-review',
  'check-badges.mjs', 'ecosystems.mjs', 'lib/ledger.mjs', 'lib/manifest.mjs',
  'task-runners.mjs', 'release-notes.mjs', 'render-svg.mjs', 'release-spec.md', 'work-item.md',
]

const EMOJI_RE = /\p{Extended_Pictographic}/u
const SVG_BANNED_JARGON_RE = /(?:FORGE\s+SPECIMEN|存量无损融合|跨月重入校准)/
const SVG_TINY_FONT_RE = /\bfont-size\s*=\s*["']\s*(?:[0-9]|1[0-5])(?:\.\d+)?(?:px)?\s*["']/i

const EXPECTED_DEV_PROFILE_KEYS = [
  'quick-test',
  'full-test',
  'smoke-verify',
  'merge-gate',
  'arch-rules',
  'high-risk',
  'do-not-edit',
]

const TEMPLATE_FORBIDDEN = [
  { re: /`?references\//, what: '指向 references/ 的路径（目标项目没有这个目录）' },
  { re: /\bproject-forge:\s*(?:kernel|managed|upgraded)/, what: '旧版标记语法' },
]

function sameKeyList(a, b) {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((k, i) => k === sb[i])
}

function checkScripts({ ROOT, rel, readText, walk, fail, note }) {
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
    if (syntax.status !== 0) fail(`${name} 语法错误：${(syntax.stderr || '').split('\n').slice(0, 3).join(' ')}`)
  }
  note(`脚本：${scripts.length} 个，全是内置依赖、语法都能解析`)
}

function checkArchBoundaries({ ROOT, rel, readText, walk, fail, note }) {
  const productScripts = [
    ...readdirSync(join(ROOT, 'scripts'), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.mjs'))
      .map((d) => join(ROOT, 'scripts', d.name)),
    ...walk(join(ROOT, 'scripts', 'lib'), (f) => f.endsWith('.mjs')),
    ...walk(join(ROOT, 'kit'), (f) => f.endsWith('.mjs')),
  ]

  const importSpecRe = /(?:^\s*(?:import|export)[\s\S]*?from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gm
  for (const file of productScripts) {
    const name = rel(file)
    const text = readText(file)
    for (const m of text.matchAll(importSpecRe)) {
      const spec = m[1].trim()
      if (spec.startsWith('node:')) continue
      let pointsToDev = /(?:^|\/)scripts\/dev(?:\/|$)/.test(spec)
      if (!pointsToDev && (spec.startsWith('./') || spec.startsWith('../'))) {
        const targetRel = rel(resolve(dirname(file), spec))
        pointsToDev = targetRel === 'scripts/dev' || targetRel.startsWith('scripts/dev/')
      }
      if (pointsToDev) {
        fail(`产品层架构越界：${name} 引用了开发门禁层「${spec}」（违反 kit/**、scripts/*.mjs、scripts/lib/** -> scripts/dev/** 禁引规则）`)
      }
    }
  }
  note(`架构边界：${productScripts.length} 个产品层脚本均未逆向引用 scripts/dev/`)
}

function checkDevProfileParity({ ROOT, rel, readText, walk, fail, note }) {
  const expected = [...EXPECTED_DEV_PROFILE_KEYS]

  const tplText = readText(join(ROOT, 'templates', 'agents-project.md'))
  const tplBlock = /<!--\s*project-forge:\s*begin\s+Dev Profile\s*-->[\s\S]*?```yaml\n([\s\S]*?)```[\s\S]*?<!--\s*project-forge:\s*end\s+Dev Profile\s*-->/.exec(tplText)
  if (!tplBlock) {
    fail('Dev Profile 键集核对：templates/agents-project.md 缺少 Dev Profile yaml 块')
  } else {
    const tplKeys = tplBlock[1].split('\n').map((l) => /^([a-z-]+)\s*:/.exec(l.trim())?.[1]).filter(Boolean)
    if (!sameKeyList(tplKeys, expected)) {
      fail(`Dev Profile 键集核对：templates/agents-project.md 键集 [${tplKeys.join(', ')}] 与基准 [${expected.join(', ')}] 不一致`)
    }
  }

  const profileRel = 'kit/skills/lib/profile.mjs'
  const profilePath = join(ROOT, profileRel)
  if (!existsSync(profilePath)) {
    fail(`Dev Profile 键集核对：缺少权威解析器 ${profileRel}`)
    return
  }
  const profileText = readText(profilePath)
  const arrMatch = /export const DEV_PROFILE_KEYS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(profileText)
  const kvMatch = /export function parseAgentsProfile[\s\S]*?\((quick-test\|[^)]+)\)`\?\s*\\s\*:/m.exec(profileText)
  if (!arrMatch || !kvMatch) {
    fail(`Dev Profile 键集核对：${profileRel} 缺少 DEV_PROFILE_KEYS 或 parseAgentsProfile 键集正则`)
  } else {
    const arrKeys = [...arrMatch[1].matchAll(/['"]([a-z-]+)['"]/g)].map((m) => m[1])
    const reKeys = kvMatch[1].split('|').map((s) => s.trim()).filter(Boolean)
    if (!sameKeyList(arrKeys, expected) || !sameKeyList(reKeys, expected)) {
      fail(`Dev Profile 键集核对：${profileRel} 键集（const=[${arrKeys.join(', ')}], regex=[${reKeys.join(', ')}]）与基准 [${expected.join(', ')}] 不一致`)
    }
  }

  const sharedText = readText(join(ROOT, 'kit', 'skills', 'lib', 'shared.mjs'))
  for (const sym of ['DEV_PROFILE_KEYS', 'parseAgentsProfile', 'parseDevProfile', 'resolveAuthoritativeTddPath']) {
    if (!new RegExp(`\\b${sym}\\b`).test(sharedText)) {
      fail(`Dev Profile 单源核对：kit/skills/lib/shared.mjs 未重导出 ${sym}`)
    }
  }

  const allProductAndKitScripts = [
    ...walk(join(ROOT, 'kit', 'skills'), (f) => f.endsWith('.mjs')),
    ...walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs') && !rel(f).startsWith('scripts/dev/')),
  ]
  for (const f of allProductAndKitScripts) {
    const name = rel(f)
    if (name === profileRel) continue
    const text = readText(f)
    if (/\bfunction\s+(?:parseDevProfile|parseAgentsProfile)\s*\(/.test(text) || /\bconst\s+DEV_PROFILE_KEYS\s*=/.test(text)) {
      fail(`Dev Profile 重复解析器副本：${name} 私自定义了重复的解析器或键表（必须统一从 kit/skills/lib/profile.mjs 导入）`)
    }
  }

  note(`Dev Profile：templates + ${profileRel} + shared.mjs 7 键单源对齐，全仓零重复解析器副本`)
}

function checkOrphanScripts({ ROOT, rel, readText, walk, fail, note }) {
  const allScripts = [
    ...walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs')),
    ...walk(join(ROOT, 'kit', 'skills'), (f) => f.endsWith('.mjs')),
  ].map((f) => rel(f)).sort()
  const scriptSet = new Set(allScripts)

  const entryDocs = [
    join(ROOT, 'SKILL.md'),
    join(ROOT, 'AGENTS.md'),
    join(ROOT, 'README.md'),
    join(ROOT, 'README.en.md'),
    join(ROOT, 'CONTRIBUTING.md'),
    join(ROOT, 'RELEASING.md'),
    join(ROOT, 'docs', 'TDD.md'),
    ...walk(join(ROOT, 'references'), (f) => f.endsWith('.md')),
    ...walk(join(ROOT, 'templates'), (f) => f.endsWith('.md') || f.endsWith('.yml') || f.endsWith('.yaml')),
    ...walk(join(ROOT, '.github', 'workflows'), (f) => /\.ya?ml$/i.test(f)),
    ...walk(join(ROOT, 'kit', 'skills'), (f) => basename(f) === 'SKILL.md'),
  ]

  const roots = new Set()
  const docScriptRe = /(?:\.agents\/skills|kit\/skills|scripts)\/[A-Za-z0-9_./-]+\.mjs/g
  for (const doc of entryDocs) {
    if (!existsSync(doc)) continue
    const text = readText(doc)
    for (const m of text.matchAll(docScriptRe)) {
      const norm = m[0].startsWith('.agents/skills/')
        ? `kit/skills/${m[0].slice('.agents/skills/'.length)}`
        : m[0]
      if (scriptSet.has(norm)) roots.add(norm)
    }
  }

  const graph = new Map()
  const importRe = /(?:^\s*(?:import|export)[\s\S]*?from\s+|import\s*\(\s*)['"]([^'"]+)['"]/gm
  for (const s of allScripts) {
    const abs = join(ROOT, s)
    const text = readText(abs)
    const deps = []
    for (const m of text.matchAll(importRe)) {
      const spec = m[1].trim()
      if (!spec.startsWith('./') && !spec.startsWith('../')) continue
      const resolved = rel(resolve(dirname(abs), spec))
      if (scriptSet.has(resolved)) deps.push(resolved)
    }
    graph.set(s, deps)
  }

  const reachable = new Set(roots)
  const queue = [...roots]
  while (queue.length > 0) {
    const cur = queue.shift()
    for (const next of graph.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next)
        queue.push(next)
      }
    }
  }

  const orphans = allScripts.filter((s) => !reachable.has(s))
  for (const orp of orphans) {
    fail(`孤儿脚本：${orp} 既未在入口文档/清单声明，也未被任何入口脚本直接或间接 import`)
  }
  note(`孤儿脚本检查：${allScripts.length} 个脚本全部可从入口可达（入口 ${roots.size} 个，零孤儿死文件）`)
}

async function checkPlatformSemanticParity({ ROOT, readText, fail, note }) {
  const enginePlatform = await import('../lib/platform/index.mjs')
  const kitPlatform = await import('../../kit/skills/lib/platform.mjs')

  if (enginePlatform.DEFAULT_PROBE_TIMEOUT_MS !== kitPlatform.DEFAULT_PROBE_TIMEOUT_MS) {
    fail(`平台语义对齐：DEFAULT_PROBE_TIMEOUT_MS 不一致（engine=${enginePlatform.DEFAULT_PROBE_TIMEOUT_MS}, kit=${kitPlatform.DEFAULT_PROBE_TIMEOUT_MS}）`)
  }
  const envA = enginePlatform.buildNonInteractiveEnv({})
  const envB = kitBuildNonInteractiveEnv({})
  for (const k of ['GIT_TERMINAL_PROMPT', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE', 'GCM_INTERACTIVE', 'GH_PROMPT_DISABLED']) {
    if (envA[k] !== envB[k]) fail(`平台语义对齐：buildNonInteractiveEnv 键 ${k} 不一致（${envA[k]} vs ${envB[k]}）`)
  }

  const engProviders = enginePlatform.listHostingProviders().map((p) => p.id)
  const kitProviders = kitPlatform.listHostingProviders().map((p) => p.id)
  if (engProviders.join(',') !== 'github' || kitProviders.join(',') !== 'github') {
    fail(`平台语义对齐：注册表仅允许注册 github（engine=${engProviders}, kit=${kitProviders}）`)
  }

  const probeSrc = readText(join(ROOT, 'scripts', 'lib', 'platform', 'github-probe.mjs'))
  const kitPlatSrc = readText(join(ROOT, 'kit', 'skills', 'lib', 'platform.mjs'))
  if (/accept-new/i.test(probeSrc) || /accept-new/i.test(kitPlatSrc)) {
    fail('平台语义对齐：禁止使用 StrictHostKeyChecking=accept-new 自动写盘')
  }
  if (!probeSrc.includes('StrictHostKeyChecking=yes') || !kitPlatSrc.includes('StrictHostKeyChecking=yes')) {
    fail('平台语义对齐：两端必须统一使用 StrictHostKeyChecking=yes')
  }
  if (!probeSrc.includes('--hostname') || !kitPlatSrc.includes('--hostname')) {
    fail('平台语义对齐：两端 gh auth status 必须显式指定 --hostname github.com')
  }

  const kitClientSrc = readText(join(ROOT, 'kit', 'skills', 'lib', 'github-client.mjs'))
  const engClientSrc = readText(join(ROOT, 'scripts', 'lib', 'platform', 'github-client.mjs'))
  if (!kitClientSrc.includes('AbortSignal.timeout') || !engClientSrc.includes('AbortSignal.timeout')) {
    fail('平台语义对齐：双端 HTTPS 请求必须显式设置 AbortSignal.timeout')
  }

  const sshMap = new Map([['gh-work', 'github.com']])
  if (engineGithubRepoPath('git@gh-work:Acme/Demo.git', sshMap) !== 'acme/demo'
    || enginePlatform.normalizeGitHubRepo('git@gh-work:Acme/Demo.git', sshMap) !== 'acme/demo'
    || kitPlatform.githubRepoPath('git@gh-work:Acme/Demo.git', sshMap) !== 'acme/demo') {
    fail('平台语义对齐：SSH Host 别名解析 githubRepoPath / normalizeGitHubRepo 行为不一致')
  }

  const idFork = kitPlatform.resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://github.com/me/app.git', upstream: 'https://github.com/org/app.git' },
  })
  const engFork = enginePlatform.classifyWorkspaceIdentity({
    gitFacts: { present: true, remoteUrls: { origin: 'https://github.com/me/app.git', upstream: 'https://github.com/org/app.git' } },
  })
  if (idFork.role !== 'contributor-fork' || engFork.role !== 'contributor-fork') {
    fail(`平台语义对齐：Fork 判定不一致（engine=${engFork.role}, kit=${idFork.role}）`)
  }

  const idGeneric = kitPlatform.resolveWorkspaceIdentity({
    remoteUrls: { origin: 'https://git.internal.corp/team/app.git' },
  })
  if (idGeneric.role !== 'generic-git' || idGeneric.providerId !== 'generic-git') {
    fail(`平台语义对齐：未知主机未安全退化为 generic-git（实际=${JSON.stringify(idGeneric)}）`)
  }

  note('平台语义对齐：scripts/lib/platform/ 与 kit/skills/lib/platform.mjs 无交互变量、StrictHostKeyChecking=yes、SSH 别名、generic-git 与身份分类全对齐')
}

function checkTemplates({ ROOT, rel, readText, walk, fail, note }) {
  const templates = walk(join(ROOT, 'templates'), () => true)
  if (templates.length === 0) { fail('templates/ 下没有任何文件'); return }
  const rendered = templates.filter((f) => !/^license-.+\.txt$/.test(basename(f)))

  for (const file of templates) {
    const name = rel(file)
    const text = readText(file)
    for (const rule of TEMPLATE_FORBIDDEN) {
      const m = rule.re.exec(text)
      if (m) fail(`${name} 第 ${text.slice(0, m.index).split('\n').length} 行有${rule.what}——它会原样落进目标项目，然后永远指空`)
    }
  }

  for (const file of rendered) {
    const name = rel(file)
    const text = readText(file)
    for (const mark of conditionMarkers(text, 'x.md')) {
      if (mark.kind === 'if' && !TEMPLATE_CONDITIONS.includes(mark.cond)) {
        fail(`${name} 第 ${mark.line} 行用了未登记的条件「${mark.cond}」——它会永远求值为假，那一块会静默消失`)
      }
    }
    for (const v of templateVarsOf(text)) {
      if (!TEMPLATE_VARS.includes(v)) fail(`${name} 里有未登记的占位符 {{${v}}}——渲染会直接失败`)
    }
  }

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

function checkPlatformLock({ ROOT, rel, readText, walk, fail, note }) {
  const targets = [
    join(ROOT, 'SKILL.md'), join(ROOT, 'README.md'), join(ROOT, 'README.en.md'),
    ...walk(join(ROOT, 'references'), (f) => f.endsWith('.md')),
    ...walk(join(ROOT, 'templates'), () => true),
    ...walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs') && !rel(f).startsWith('scripts/dev/')),
    ...walk(join(ROOT, 'kit'), (f) => /\.(?:md|mjs)$/i.test(f)),
    ...walk(join(ROOT, 'assets'), (f) => /\.svg$/i.test(f)),
  ]
  for (const file of targets) {
    if (!existsSync(file)) continue
    const text = readText(file)
    const m = FORBIDDEN_PLATFORM_RE.exec(text)
    if (m) fail(`${rel(file)} 第 ${text.slice(0, m.index).split('\n').length} 行提到了「${m[0]}」——这个 skill 只针对 GitHub，别的托管平台不进产物层`)
  }
  note(`平台锁定：${targets.length} 个产物层文件里没有提及其他托管平台`)
}

function checkStructureRules({ ROOT, readText, fail, note }) {
  const attrs = readText(join(ROOT, '.gitattributes')).replace(/\r\n/g, '\n')
  const ignored = attrs.split('\n')
    .map((line) => /^\s*\/?(\S+?)\s+export-ignore\s*$/.exec(line))
    .filter(Boolean).map((m) => m[1].replace(/^\/+/, '').replace(/\/+$/, ''))
  const codeDirs = REPO_ONLY_DIRS.map((d) => d.replace(/\/$/, ''))
  const codeFiles = [...REPO_ONLY_FILES]

  for (const d of ignored) {
    if (!codeDirs.includes(d) && !codeFiles.includes(d)) fail(`.gitattributes 排除了 ${d}，而 REPO_ONLY_* 里没有它——两处说法不一致`)
  }
  for (const d of codeDirs) if (!ignored.includes(d)) fail(`REPO_ONLY_DIRS 里有 ${d}，而 .gitattributes 没排除它`)
  for (const f of codeFiles) if (!ignored.includes(f)) fail(`REPO_ONLY_FILES 里有 ${f}，而 .gitattributes 没排除它`)
  note(`结构规则：.gitattributes 与 REPO_ONLY_* 一致（${codeDirs.length} 处目录、${codeFiles.length} 个文件）`)
}

function checkKitSuite({ ROOT, rel, readText, countLines, walk, fail, note }) {
  const eq = checkEquip(ROOT)
  if (!eq.ok) {
    const details = [
      eq.reason,
      ...eq.missing.map((p) => `缺失：${p}`),
      ...eq.drifted.map((p) => `字节不一致：${p}`),
      ...eq.unregistered.map((p) => `未登记哈希：${p}`),
      ...eq.extraManaged.map((p) => `多余托管文件：${p}`),
    ].filter(Boolean)
    fail(`内置套件一致性失败（${PF_MANIFEST_REL}）：${details.slice(0, 6).join('；')}`)
  }

  const privatePathRe = /\b(?:docs\/work|scripts\/dev|docs\/release-notes)\b/
  for (const file of [join(ROOT, 'SKILL.md'), ...walk(join(ROOT, 'kit'), (f) => /\.(?:md|mjs)$/i.test(f)), ...walk(join(ROOT, 'assets'), (f) => /\.svg$/i.test(f))]) {
    if (!existsSync(file)) continue
    const name = rel(file)
    for (const [i, line] of readText(file).replace(/\r\n/g, '\n').split('\n').entries()) {
      const m = privatePathRe.exec(line)
      if (m) fail(`${name} 第 ${i + 1} 行泄露了本仓私有路径「${m[0]}」——用户包里不存在该路径`)
    }
  }

  const kitSkillsRoot = join(ROOT, 'kit', 'skills')
  for (const skill of KIT_SKILLS) {
    const entry = join(kitSkillsRoot, skill, 'SKILL.md')
    if (!existsSync(entry)) { fail(`kit/skills 缺必需内置 Skill：kit/skills/${skill}/SKILL.md`); continue }
    const lineCount = countLines(readText(entry))
    if (lineCount > KIT_SKILL_MAX_LINES) fail(`kit/skills/${skill}/SKILL.md 有 ${lineCount} 行，超过上限 ${KIT_SKILL_MAX_LINES} 行`)
  }

  const kitScripts = walk(kitSkillsRoot, (f) => f.endsWith('.mjs'))
  for (const file of kitScripts) {
    const name = rel(file)
    const text = readText(file)
    const lines = countLines(text)
    if (lines > 800) fail(`${name} 有 ${lines} 行，超过内置套件单文件 800 行上限`)
    for (const m of text.matchAll(/^\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gm)) {
      const spec = m[1]
      if (spec.startsWith('node:')) continue
      if (!spec.startsWith('./') && !spec.startsWith('../')) { fail(`${name} 引入了非内置模块「${spec}」——必须保持零第三方依赖`); continue }
      if (!rel(resolve(dirname(file), spec)).startsWith('kit/skills/')) {
        fail(`${name} 越界引用了套件外部模块「${spec}」——kit/skills/ 必须自包含，否则复制到目标仓后无法运行`)
      }
    }
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (syntax.status !== 0) fail(`${name} 语法错误：${(syntax.stderr || '').split('\n').slice(0, 3).join(' ')}`)
  }
  note(`工程套件：${KIT_SKILLS.length} 个 Skill（<= ${KIT_SKILL_MAX_LINES} 行）、${kitScripts.length} 个脚本（<= 800 行）自包含，与 .agents/skills/ 字节级一致`)
}

function checkReadmeVisualsAndDocFrontmatter({ ROOT, readText, fail, note }) {
  const requiredSvgs = [
    'assets/readme/hero.svg', 'assets/readme/hero-en.svg',
    'assets/readme/workflow.svg', 'assets/readme/workflow-en.svg',
    'assets/readme/architecture.svg', 'assets/readme/architecture-en.svg',
  ]
  const heights = new Set()
  for (const relPath of requiredSvgs) {
    const abs = join(ROOT, relPath)
    if (!existsSync(abs)) { fail(`缺少 README 图解资产：${relPath}`); continue }
    const vb = /\bviewBox\s*=\s*["']\s*0\s+0\s+\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)\s*["']/i.exec(readText(abs))
    if (vb) heights.add(vb[1])
    else fail(`${relPath} 缺少标准 0 0 W H viewBox 尺寸`)
  }
  if (heights.size < 2) fail(`README SVG 图解高度过于单一（仅检测到 ${heights.size} 种高度），不同图表须按内容采用区分度明显的独立高度`)

  for (const readmeRel of ['README.md', 'README.en.md']) {
    if (!/https:\/\/img\.shields\.io\/badge\//i.test(readText(join(ROOT, readmeRel)))) fail(`${readmeRel} 缺少 shields.io 事实徽章行`)
  }

  for (const [tplRel, expectedKind] of [['templates/docs-prd.md', 'prd'], ['templates/docs-spec.md', 'spec'], ['templates/docs-todo.md', 'todo']]) {
    const fm = parseDocFrontmatter(readText(join(ROOT, tplRel)))
    if (!fm.hasFrontmatter) { fail(`${tplRel} 缺少 YAML Frontmatter（首行 --- ... ---）`); continue }
    if (fm.malformedFrontmatter) { fail(`${tplRel} YAML Frontmatter 格式错误：${fm.syntaxErrors.join('；')}`); continue }
    if (fm.data.kind !== expectedKind) fail(`${tplRel} YAML Frontmatter \`kind\` 应为「${expectedKind}」，实为「${fm.data.kind ?? ''}」`)
    for (const k of ['kind', 'status', 'created', 'updated', 'issue', 'pr', 'owner']) {
      if (!Object.prototype.hasOwnProperty.call(fm.data, k)) fail(`${tplRel} YAML Frontmatter 缺少必需字段「${k}」`)
    }
    for (const k of ['kind', 'status', 'created', 'updated', 'owner']) {
      if (typeof fm.data[k] !== 'string' || !fm.data[k].trim()) fail(`${tplRel} YAML Frontmatter 字段「${k}」不可为空`)
    }
  }
  note(`视觉与文档前导：6 张 README SVG（${heights.size} 种独立高度）、双语徽章与 3 份 docs-* YAML frontmatter 齐全合规`)
}

function checkHygiene({ ROOT, rel, walk, fail }) {
  const files = walk(ROOT, (f) => /\.(?:md|mjs|ya?ml|json|txt|svg)$/i.test(f))
  const home = homedir().replace(/\\/g, '/')
  const homeRe = home.length > 4 ? new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') : undefined
  for (const file of files) {
    const name = rel(file)
    const raw = readFileSync(file, 'utf8')
    if (raw.startsWith('\uFEFF')) fail(`${name} 有 UTF-8 BOM`)
    if (EMOJI_RE.test(raw)) fail(`${name} 有 emoji 字符`)
    if (homeRe && homeRe.test(raw)) fail(`${name} 里有本机绝对路径`)
    if (/^assets\/readme\/.+\.svg$/i.test(name)) {
      if (!/<svg\b/i.test(raw) || !/<\/svg>/i.test(raw)) fail(`${name} 缺少完整的 <svg>...</svg> 根结构`)
      if (!/\bviewBox\s*=\s*["'][^"']+["']/i.test(raw)) fail(`${name} 缺少 viewBox 属性`)
      if (!/<title\b[^>]*>[\s\S]*?<\/title>/i.test(raw)) fail(`${name} 缺少 <title> 无障碍标题`)
      if (/<script\b|<foreignObject\b|<image\b/i.test(raw)) fail(`${name} 包含禁止的 SVG 元素（script / foreignObject / image）`)
      const stripped = raw.replace(/\bxmlns(?::[a-z0-9_-]+)?\s*=\s*["']http:\/\/www\.w3\.org\/[^"']*["']/gi, '')
      if (/https?:\/\//i.test(stripped)) fail(`${name} 包含非标准外部 http(s) 资源引用——SVG 卡片必须 100% 自包含`)
      const tinyFont = SVG_TINY_FONT_RE.exec(raw)
      if (tinyFont) fail(`${name} 包含低于 16 的禁止微小字号（${tinyFont[0]}）`)
      const banned = SVG_BANNED_JARGON_RE.exec(raw)
      if (banned) fail(`${name} 包含禁止的内部黑话「${banned[0]}」`)
    }
  }
}

function checkOwnInstances({ ROOT, rel, readText, walk, fail, note }) {
  const headingsOf = (text) => (text.replace(/\r\n/g, '\n').match(/^##\s+.+$/gm) ?? []).map((s) => s.trim())
  for (const check of OWN_INSTANCE_CHECKS) {
    const tpl = join(ROOT, check.template)
    const inst = join(ROOT, check.instance)
    if (!existsSync(tpl)) { fail(`同构核对：缺模板 ${check.template}`); continue }
    if (!existsSync(inst)) { fail(`同构核对：缺本仓库实例 ${check.instance}`); continue }
    const have = new Set(headingsOf(readText(inst)))
    for (const h of headingsOf(readText(tpl))) {
      if (!have.has(h)) fail(`${check.instance} 缺模板里的这一节：${h}——模板改了、本仓库自己那份没跟上，两边从此各说各话`)
    }
  }
  note(`同构核对：${OWN_INSTANCE_CHECKS.length} 组实例与模板的核心章节一致`)

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
      if (text.includes(retired)) fail(`${name} 里还写着 ${retired}——那个脚本已经不存在，照着它做的人会找不到命令`)
    }
  }
}

function checkTeamAndTddContracts({ ROOT, rel, readText, walk, fail, note }) {
  for (const relPath of ['references/collaboration.md', 'templates/agents-project.md', 'templates/contributing.md', 'CONTRIBUTING.md']) {
    const p = join(ROOT, relPath)
    if (!existsSync(p)) { fail(`团队协同核对：缺 ${relPath}`); continue }
    const text = readText(p)
    const missing = ['团队', '协作者', '--probe-auth', '接管', 'CODEOWNERS'].filter((k) => !text.includes(k))
    if (missing.length > 0) fail(`${relPath} 缺少多维护者团队协同要素：${missing.join('、')}`)
  }

  for (const docPath of ['docs/TDD.md', 'templates/docs-tdd.md']) {
    const p = join(ROOT, docPath)
    if (!existsSync(p)) { fail(`TDD 契约核对：缺 ${docPath}`); continue }
    const text = readText(p)
    for (const err of validateDocTocAnchors(text)) fail(`${docPath}：${err}`)
    if (docPath === 'docs/TDD.md') {
      if (!/```mermaid\b/.test(text)) fail('docs/TDD.md 缺少 mermaid 架构或状态图')
      if (!/\barch-rules\s*:/.test(text)) fail('docs/TDD.md 缺少 arch-rules 校验块')
      if (!text.includes('Feature Map')) fail('docs/TDD.md 缺少 Feature Map 功能入口地图')
    } else {
      if (!text.includes('[按需保留，不适用整节删除]')) fail('templates/docs-tdd.md 缺少 `[按需保留，不适用整节删除]` 裁剪标记')
      if (text.includes('references/')) fail('templates/docs-tdd.md 不应硬编码本仓内部 references/ 路径')
      if (templateVarsOf(text).length > 0) fail('templates/docs-tdd.md 存在未登记模板变量占位')
    }
  }

  for (const relPath of ['SKILL.md', 'references/docs-set.md', 'kit/skills/dev-explore/SKILL.md']) {
    const p = join(ROOT, relPath)
    if (!existsSync(p)) { fail(`TDD 三场景协同核对：缺 ${relPath}`); continue }
    const text = readText(p)
    if (!text.includes('--bootstrap-empty')) fail(`${relPath} 缺少 --bootstrap-empty 起步协同说明`)
    if (!text.includes('explorationStrategy.tier')) fail(`${relPath} 缺少 explorationStrategy.tier 档位协同说明`)
    if (!/(?:不派[^\n]*子代理|禁止派发子代理)/.test(text)) fail(`${relPath} 未明确声明空白目录起步禁止派发探索子代理`)
  }

  const mermaidTargets = [
    join(ROOT, 'docs', 'TDD.md'),
    ...walk(join(ROOT, 'templates'), (f) => f.endsWith('.md')),
    ...walk(join(ROOT, 'docs', 'specs'), (f) => f.endsWith('.md')),
  ]
  let mermaidBlocks = 0
  let checkedMermaidDocs = 0
  for (const abs of mermaidTargets) {
    if (!existsSync(abs)) continue
    const res = checkMermaidLabelWidth(readText(abs))
    checkedMermaidDocs += 1
    mermaidBlocks += res.checkedBlocks
    for (const v of res.violations) {
      fail(`Mermaid 宽度/HTML 校验失败（${rel(abs)}:${v.line}）：${v.message}`)
    }
  }

  note(`协同与 TDD 契约：4 处团队多维护者口径、TDD 双份目录锚点、三场景协同及 ${checkedMermaidDocs} 份文档（${mermaidBlocks} 处 Mermaid 16/12 零 HTML）全部对齐`)
}

export async function runSuiteChecks(ctx) {
  checkScripts(ctx)
  checkArchBoundaries(ctx)
  checkDevProfileParity(ctx)
  checkOrphanScripts(ctx)
  await checkPlatformSemanticParity(ctx)
  checkOwnInstances(ctx)
  checkTeamAndTddContracts(ctx)
  checkReadmeVisualsAndDocFrontmatter(ctx)
  checkTemplates(ctx)
  checkPlatformLock(ctx)
  checkStructureRules(ctx)
  checkKitSuite(ctx)
  checkHygiene(ctx)
}
