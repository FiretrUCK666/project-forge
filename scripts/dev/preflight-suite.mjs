/**
 * preflight-suite.mjs —— 脚本依赖、架构边界、Dev Profile 单源、孤儿脚本、平台语义对齐、模板与套件卫生校验。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import {
  FORBIDDEN_PLATFORM_RE, KIT_SKILL_MAX_LINES, PF_MANIFEST_REL,
  REPO_ONLY_DIRS, REPO_ONLY_FILES, UNIFIED_SKILL_NAMES, discoverKitSkillsDetailed, templateVarsOf,
} from '../lib/protocol.mjs'
import { checkEquip } from '../equip.mjs'
import { githubRepoPath as engineGithubRepoPath } from '../lib/text.mjs'
import { checkMermaidLabelWidth } from '../../kit/skills/lib/docs.mjs'
import { DOC_TEMPLATE_VARS } from '../../kit/skills/lib/doc-template-render.mjs'
import { buildNonInteractiveEnv as kitBuildNonInteractiveEnv } from '../../kit/skills/lib/git.mjs'
import { DEV_PROFILE_KEYS } from '../../kit/skills/lib/profile.mjs'
import {
  auditEntry, auditGlobalWhitelist, auditHandRolled, auditSkillDocsAndNextSteps,
  evaluateParity, ENTRY_SPECS, HAND_ROLLED_SPECS,
} from './cli-parity.mjs'
import { evaluateSubcommandParity } from './subcommand-parity.mjs'
import { evaluateExitCodeParity } from './exit-code-parity.mjs'
import { blockedExitOf } from '../../kit/skills/lib/exit-codes.mjs'
import { validateDocTocAnchors } from './preflight-contracts.mjs'
import { collectKitWriteProbeTargets, scanKitWriteProbeViolations } from './write-probe-audit.mjs'
import { runKernelParityChecks } from './preflight-kernel-parity.mjs'
import { findChangelogVoice, findNewChangelogVoice, readChangelogVoiceBaseline } from '../../kit/skills/lib/no-changelog-voice.mjs'
import { buildLexedViews } from '../../kit/skills/lib/static-gates-lexer.mjs'
import {
  checkEvergreenFreshness,
  checkOwnInstances,
  checkReadmeVisualsAndDocFrontmatter,
  checkTemplates,
  evergreenFreshnessErrors,
} from './preflight-suite-checks.mjs'

export { evergreenFreshnessErrors }

const EMOJI_RE = /\p{Extended_Pictographic}/u
const SVG_BANNED_JARGON_RE = /(?:FORGE\s+SPECIMEN|存量无损融合|跨月重入校准)/
const SVG_TINY_FONT_RE = /\bfont-size\s*=\s*["']\s*(?:[0-9]|1[0-5])(?:\.\d+)?(?:px)?\s*["']/i

const EXPECTED_DEV_PROFILE_KEYS = DEV_PROFILE_KEYS

function sameKeyList(a, b) {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((k, i) => k === sb[i])
}

function runSpawnCheckPool(files, concurrency = 8) {
  return new Promise((done) => {
    const errors = new Map()
    let idx = 0
    const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => new Promise((finishWorker) => {
      const next = () => {
        if (idx >= files.length) { finishWorker(); return }
        const file = files[idx++]
        const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
        let err = ''
        child.stderr?.on('data', (c) => { err += c })
        child.on('close', (code) => {
          if (code !== 0) errors.set(file, err.split('\n').slice(0, 3).join(' '))
          next()
        })
        child.on('error', (e) => {
          errors.set(file, e.message)
          next()
        })
      }
      next()
    }))
    Promise.all(workers).then(() => done(errors))
  })
}

async function batchSyntaxCheck(files) {
  if (files.length === 0) return new Map()
  const runnerScript = [
    "import { readFileSync } from 'node:fs';",
    "import { SourceTextModule } from 'node:vm';",
    "const files = JSON.parse(readFileSync(0, 'utf8'));",
    "const errors = [];",
    "for (const file of files) {",
    "  try {",
    "    new SourceTextModule(readFileSync(file, 'utf8'), { identifier: file });",
    "  } catch (err) {",
    "    errors.push({ file, msg: (err && err.message ? err.message : String(err)).split('\\n').slice(0, 3).join(' ') });",
    "  }",
    "}",
    "process.stdout.write(JSON.stringify(errors));",
  ].join('\n')

  const res = await new Promise((done) => {
    const child = spawn(
      process.execPath,
      ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '-e', runnerScript],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    const out = []
    const err = []
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 15000)
    timer.unref?.()
    child.stdout?.on('data', (c) => out.push(c))
    child.stderr?.on('data', (c) => err.push(c))
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ status: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      done({ status: 1, stdout: '', stderr: e.message })
    })
    child.stdin.end(JSON.stringify(files))
  })
  if (res.status === 0 && res.stdout) {
    try {
      const parsed = JSON.parse(res.stdout)
      if (Array.isArray(parsed)) {
        const errors = new Map()
        for (const item of parsed) {
          if (item?.file) errors.set(item.file, item.msg || '语法错误')
        }
        return errors
      }
    } catch { /* fallback below */ }
  }
  return runSpawnCheckPool(files)
}

function checkScripts({ ROOT, rel, readText, walk, fail, note }, syntaxErrors) {
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
    const synErr = syntaxErrors.get(file)
    if (synErr) fail(`${name} 语法错误：${synErr}`)
  }
  note(`脚本：${scripts.length} 个，全是内置依赖、语法都能解析`)
}

function checkArchBoundaries({ ROOT, rel, readText, walk, fail, note }) {
  const kitFiles = walk(join(ROOT, 'kit'), (f) => f.endsWith('.mjs'))
  const productScripts = [
    ...readdirSync(join(ROOT, 'scripts'), { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.mjs'))
      .map((d) => join(ROOT, 'scripts', d.name)),
    ...walk(join(ROOT, 'scripts', 'lib'), (f) => f.endsWith('.mjs')),
    ...kitFiles,
  ]

  const importSpecRe = /(?:^\s*(?:import|export)[\s\S]*?from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/gm
  for (const file of productScripts) {
    const name = rel(file)
    const text = readText(file)
    const isKit = name.startsWith('kit/')
    for (const m of text.matchAll(importSpecRe)) {
      const spec = m[1].trim()
      if (spec.startsWith('node:')) continue
      let targetRel = ''
      if (spec.startsWith('./') || spec.startsWith('../')) {
        targetRel = rel(resolve(dirname(file), spec))
      }
      const pointsToDev = /(?:^|\/)scripts\/dev(?:\/|$)/.test(spec)
        || targetRel === 'scripts/dev' || targetRel.startsWith('scripts/dev/')
      if (pointsToDev) {
        fail(`产品层架构越界：${name} 引用了开发门禁层「${spec}」（违反 kit/**、scripts/*.mjs、scripts/lib/** -> scripts/dev/** 禁引规则）`)
      }
      if (isKit) {
        const pointsToScriptsLib = /(?:^|\/)scripts\/lib(?:\/|$)/.test(spec)
          || targetRel === 'scripts/lib' || targetRel.startsWith('scripts/lib/')
        if (pointsToScriptsLib) {
          fail(`架构边界越界：${name} 引用了安装期库「${spec}」（违反 kit/** -> scripts/lib/** 禁引规则）`)
        }
      }
    }
  }
  note(`架构边界：${productScripts.length} 个产品层脚本均严守 dev 与 scripts/lib 单向隔离边界`)
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

  const defaultsText = readText(join(ROOT, 'scripts', 'lib', 'agents-defaults.mjs'))
  const expectedVarKeys = expected.map((k) => `PROFILE_${k.toUpperCase().replace(/-/g, '_')}`)
  const missingDefaults = expectedVarKeys.filter((vk) => !new RegExp(`\\b${vk}\\s*:`).test(defaultsText))
  if (missingDefaults.length > 0) {
    fail(`Dev Profile 键集核对：scripts/lib/agents-defaults.mjs buildDevProfileVars 缺少 ${missingDefaults.join(', ')}`)
  }

  note(`Dev Profile：templates + ${profileRel} + shared.mjs + agents-defaults.mjs ${expected.length} 键单源对齐，全仓零重复解析器副本`)
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

  // 动态按功能域前缀自动发现的夹具与故障注入模块，自动纳入对应调度器的可达边
  const autoFixtures = allScripts.filter((s) => /^scripts\/dev\/fixtures-[^/]+\.mjs$/.test(s) && s !== 'scripts/dev/fixtures-helpers.mjs')
  const autoInjections = allScripts.filter((s) => /^scripts\/dev\/injections-data-[^/]+\.mjs$/.test(s))
  if (graph.has('scripts/dev/fixtures.mjs')) graph.get('scripts/dev/fixtures.mjs').push(...autoFixtures)
  if (graph.has('scripts/dev/injections-data.mjs')) graph.get('scripts/dev/injections-data.mjs').push(...autoInjections)

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
  for (const k of [
    'GIT_TERMINAL_PROMPT',
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'SSH_ASKPASS_REQUIRE',
    'GCM_INTERACTIVE',
    'GH_PROMPT_DISABLED',
    'GIT_EDITOR',
    'GIT_SEQUENCE_EDITOR',
  ]) {
    if (envA[k] !== envB[k]) fail(`平台语义对齐：buildNonInteractiveEnv 键 ${k} 不一致（${envA[k]} vs ${envB[k]}）`)
  }
  if (envB.GIT_EDITOR !== 'true' || envB.GIT_SEQUENCE_EDITOR !== 'true') {
    fail('平台语义对齐：buildNonInteractiveEnv 必须固定 GIT_EDITOR/GIT_SEQUENCE_EDITOR 为 true')
  }

  const engProviders = enginePlatform.listHostingProviders().map((p) => p.id)
  const kitProviders = kitPlatform.listHostingProviders().map((p) => p.id)
  if (engProviders.join(',') !== 'github' || kitProviders.join(',') !== 'github') {
    fail(`平台语义对齐：注册表仅允许注册 github（engine=${engProviders}, kit=${kitProviders}）`)
  }

  const probeAdapterSrc = readText(join(ROOT, 'scripts', 'lib', 'platform', 'github-probe.mjs'))
  const ghAdapterSrc = readText(join(ROOT, 'scripts', 'lib', 'platform', 'github.mjs'))
  const kitProbeSrc = readText(join(ROOT, 'kit', 'skills', 'lib', 'platform-probe.mjs'))
  const kitPlatSrc = readText(join(ROOT, 'kit', 'skills', 'lib', 'platform.mjs'))
  if (!probeAdapterSrc.includes('kit/skills/lib/platform-probe.mjs')) {
    fail('平台语义对齐：scripts/lib/platform/github-probe.mjs 必须单源复用 kit/skills/lib/platform-probe.mjs')
  }
  if (!ghAdapterSrc.includes('kit/skills/lib/platform.mjs')) {
    fail('平台语义对齐：scripts/lib/platform/github.mjs 必须单源复用 kit/skills/lib/platform.mjs')
  }
  if (/accept-new/i.test(probeAdapterSrc) || /accept-new/i.test(kitProbeSrc) || /accept-new/i.test(kitPlatSrc)) {
    fail('平台语义对齐：禁止使用 StrictHostKeyChecking=accept-new 自动写盘')
  }
  if (!kitProbeSrc.includes('StrictHostKeyChecking=yes')) {
    fail('平台语义对齐：共享平台探测核心必须显式使用 StrictHostKeyChecking=yes')
  }
  if (!kitProbeSrc.includes('--hostname')) {
    fail('平台语义对齐：共享平台探测核心 gh auth status 必须显式指定 --hostname github.com')
  }

  const kitClientSrc = readText(join(ROOT, 'kit', 'skills', 'lib', 'github-client.mjs'))
  const engClientSrc = readText(join(ROOT, 'scripts', 'lib', 'platform', 'github-client.mjs'))
  if (!kitClientSrc.includes('AbortSignal.timeout') || !kitProbeSrc.includes('AbortSignal.timeout')) {
    fail('平台语义对齐：双端 HTTPS 请求必须显式设置 AbortSignal.timeout')
  }
  if (!engClientSrc.includes('kit/skills/lib/platform-probe.mjs')) {
    fail('平台语义对齐：scripts/lib/platform/github-client.mjs 必须单源复用 kit/skills/lib/platform-probe.mjs')
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

const KIT_PRIVATE_SYMBOL_RE = /\b(?:verify-injections|gap-coverage|write-probe-audit|preflight-suite|preflight\.mjs)\b|docs\/TDD\.md#(?:技术基线与运行约束|明确非目标)|AGENTS\.md#(?:版本管理与回滚底线|项目特有红线)|SKILL\.md#/
const KIT_SURVEY_CALL_RE = /\bscripts\/survey\.mjs\b/

function walkDirFiles(dir, pred, out = []) {
  if (!existsSync(dir)) return out
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules' || ent.name === '.worktrees') continue
    const full = join(dir, ent.name)
    if (ent.isDirectory()) walkDirFiles(full, pred, out)
    else if (ent.isFile() && pred(full)) out.push(full)
  }
  return out
}

/** 扫描 `kit/` 下全部 `.mjs` 与 `.md`，拦截本仓私有脚本、测试夹具及固定锚点泄漏。 */
export function scanKitPrivateLeaks(ROOT) {
  const leaks = []
  const files = walkDirFiles(join(ROOT, 'kit'), (f) => /\.(?:md|mjs)$/i.test(f))
  for (const abs of files) {
    const name = abs.slice(ROOT.length + 1).replace(/\\/g, '/')
    const text = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n')
    const lines = text.split('\n')
    const isMjs = name.endsWith('.mjs')
    const codeLines = isMjs ? buildLexedViews(text, 'mjs').codeLines : lines
    for (let i = 0; i < lines.length; i += 1) {
      const m = KIT_PRIVATE_SYMBOL_RE.exec(lines[i])
      if (m) {
        leaks.push(`${name}:${i + 1} 泄漏本仓私有符号「${m[0]}」`)
        continue
      }
      const lineToScan = isMjs ? codeLines[i] : lines[i]
      if (lineToScan && KIT_SURVEY_CALL_RE.test(lineToScan)) {
        leaks.push(`${name}:${i + 1} 泄漏本仓私有脚本调用「scripts/survey.mjs」`)
      }
    }
  }
  return leaks
}

export function checkKitSuite({ ROOT, rel, readText, countLines, walk, fail, note }, syntaxErrors) {
  const kitSkillsRoot = join(ROOT, 'kit', 'skills')
  const eq = checkEquip(ROOT, { kitDir: kitSkillsRoot })
  if (!eq.ok) {
    const details = [
      eq.reason,
      ...eq.missing.map((p) => `缺失：${p}`),
      ...eq.drifted.map((p) => (typeof p === 'string' ? `字节不一致：${p}` : `${p.state}：${p.path}`)),
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
  for (const leak of scanKitPrivateLeaks(ROOT)) {
    fail(`内置套件自用泄漏：${leak}`)
  }

  const { skills: discovered, diagnostics } = discoverKitSkillsDetailed(kitSkillsRoot)
  for (const diag of diagnostics) fail(`内置 Skill 元数据无效：${diag.message}`)
  if (discovered.length === 0) fail('kit/skills 下未发现任何合法内置 Skill')
  const discoveredSet = new Set(discovered.map((s) => s.dirName))
  const missingUnified = UNIFIED_SKILL_NAMES.filter((n) => !discoveredSet.has(n))
  if (missingUnified.length > 0) {
    fail(`内置 Skill 缺失必需核心技能（UNIFIED_SKILL_NAMES ${UNIFIED_SKILL_NAMES.length} 个）：缺少 [${missingUnified.join(', ')}]`)
  }

  for (const skill of discovered) {
    const entry = join(kitSkillsRoot, skill.dirName, 'SKILL.md')
    if (!existsSync(entry)) { fail(`kit/skills 缺必需内置 Skill：kit/skills/${skill.dirName}/SKILL.md`); continue }
    const lineCount = countLines(readText(entry))
    if (lineCount > KIT_SKILL_MAX_LINES) fail(`kit/skills/${skill.dirName}/SKILL.md 有 ${lineCount} 行，超过上限 ${KIT_SKILL_MAX_LINES} 行`)
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
    const synErr = syntaxErrors.get(file)
    if (synErr) fail(`${name} 语法错误：${synErr}`)
  }
  note(`工程套件：${discovered.length} 个 Skill（<= ${KIT_SKILL_MAX_LINES} 行）、${kitScripts.length} 个脚本（<= 800 行）自包含，与 .agents/skills/ 字节级一致`)
}

function checkHygiene({ ROOT, rel, walk, fail, changedSet }) {
  const files = walk(ROOT, (f) => /\.(?:md|mjs|ya?ml|json|txt|svg)$/i.test(f))
    .filter((f) => !changedSet || changedSet.has(rel(f)))
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

  // 「只写现状」这条规矩要能被机器检查，否则它只是一句口号。
  //
  // 但不该一上线就让存量全红：那会逼人把这条检查关掉。所以冻结基线，
  // **只报新增的履历体句子**——新写的能被抓住，旧的等它自然退役。
  const baseline = readChangelogVoiceBaseline(ROOT)
  const found = []
  for (const file of files) {
    const name = rel(file)
    if (!/\.(?:md|mjs|js|ya?ml|json)$/i.test(name)) continue
    // `.agents/` 是 `.kit/skills` 的镜像，同一个问题会在两处各报一次；
    // 镜像由 `equip --check` 保证字节一致，不需要在这里重复扫。
    if (/^(?:docs\/archive|docs\/release-notes|node_modules|\.agents)\//.test(name)) continue
    // 夹具的存在意义就是装错的样本：刻意保留履历例句是为了证明检测器抓得到。
    // 用同一条规则去判它，等于要求测谎仪自己不能说谎。
    if (/^scripts\/dev\/fixtures-[^/]+\.mjs$/.test(name)) continue
    for (const hit of findChangelogVoice(readFileSync(file, 'utf8'), { file: name })) found.push(hit)
  }
  const fresh = findNewChangelogVoice(found, baseline)
  for (const hit of fresh.slice(0, 5)) {
    fail(`${hit.file}:${hit.line} 出现履历体写法「${hit.word}」——只写现在为什么这样，改过什么留给提交记录`)
  }
  if (fresh.length > 5) fail(`另有 ${fresh.length - 5} 处新增履历体写法未列出`)
}

function checkTeamAndTddContracts({ ROOT, rel, readText, walk, fail, note }) {
  for (const relPath of ['references/collaboration.md', 'templates/agents-project.md', 'templates/contributing.md', 'CONTRIBUTING.md']) {
    const p = join(ROOT, relPath)
    if (!existsSync(p)) { fail(`团队协同核对：缺 ${relPath}`); continue }
    const text = readText(p)
    const missing = ['团队', '协作者', '--probe-auth', '接管', 'CODEOWNERS'].filter((k) => !text.includes(k))
    if (missing.length > 0) fail(`${relPath} 缺少多维护者团队协同要素：${missing.join('、')}`)
  }

  for (const docPath of ['docs/TDD.md', 'kit/skills/templates/docs-tdd.md']) {
    const p = join(ROOT, docPath)
    if (!existsSync(p)) { fail(`TDD 契约核对：缺 ${docPath}`); continue }
    const text = readText(p)
    for (const err of validateDocTocAnchors(text)) fail(`${docPath}：${err}`)
    if (docPath === 'docs/TDD.md') {
      if (!/```mermaid\b/.test(text)) fail('docs/TDD.md 缺少 mermaid 架构或状态图')
      if (!/\barch-rules\s*:/.test(text)) fail('docs/TDD.md 缺少 arch-rules 校验块')
      if (!text.includes('Feature Map')) fail('docs/TDD.md 缺少 Feature Map 功能入口地图')
    } else {
      // 可选章节用统一的 section 标记表达，不再靠一句人读的说明文字：
      // 说明文字可以被忽略，标记会被渲染器与审计真正执行。
      if (!/<!--\s*section:\s*[a-z-]+(\s+optional)?\s*-->/.test(text)) {
        fail('kit/skills/templates/docs-tdd.md 没有任何 section 标记——可选章节无法按项目形态裁剪')
      }
      if (!/<!--\s*section:\s*[a-z-]+\s+optional\s*-->/.test(text)) {
        fail('kit/skills/templates/docs-tdd.md 没有任何 optional 章节——所有章节都强制，等于不认项目形态')
      }
      if (text.includes('references/')) fail('kit/skills/templates/docs-tdd.md 不应硬编码本仓内部 references/ 路径')
      // TDD 模板同样用 {{VAR}} 填事实（技术栈、运行时、模块表都是读得出来的）。
      // 判据要的是「占位登记过」，不是「不许有占位」。
      const tddVars = new Set(DOC_TEMPLATE_VARS.tdd)
      for (const v of templateVarsOf(text)) {
        if (!tddVars.has(v)) {
          fail(`kit/skills/templates/docs-tdd.md 里的占位 {{${v}}} 没登记在 DOC_TEMPLATE_VARS.tdd——渲染会留下字面量`)
        }
      }
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

function checkKitWriteProbes({ ROOT, fail, note }) {
  const targets = collectKitWriteProbeTargets(ROOT)
  const violations = scanKitWriteProbeViolations(targets)
  for (const v of violations) fail(`写路径联网探测门禁（${v.file}:${v.line}）：${v.message}`)
  if (violations.length === 0) note(`写路径联网探测：${targets.length} 个脚本均已通过 probeForWrite 与显式 probeNetwork 门禁（0 违规）`)
}

/**
 * 参数三重对拍：注册表、帮助声明、读取点。
 *
 * 一个参数只活在三分之二处，比完全没有更坏——它看起来像能用。所以这里不查文档写得好不好，
 * 只查这三件事对不对得上：帮助里有的必须注册得上，注册了的必须有人读，暗参数只许少不许多。
 */
function checkCliParity({ ROOT, fail, note, walk }) {
  const audits = [
    ...ENTRY_SPECS.map((spec) => auditEntry(spec, { ROOT, walk })),
    ...HAND_ROLLED_SPECS.map((spec) => auditHandRolled(spec, { ROOT })),
  ]
  const { failures, notes } = evaluateParity(audits)
  const docParity = auditSkillDocsAndNextSteps({ ROOT })
  const allFailures = [...failures, ...docParity.failures]
  for (const message of allFailures) fail(`参数对拍：${message}`)
  const globalCheck = auditGlobalWhitelist({ ROOT })
  if (!globalCheck.ok) fail(`参数对拍：${globalCheck.error}`)
  if (allFailures.length === 0) note(`参数对拍：${notes.join('；')}；SKILL.md/printNextStep ${docParity.checkedCommands} 条命令零漂移`)
}

/**
 * 退出码档位对拍：登记表 vs 实际返回。
 *
 * 登记表说「事实档」，代码返「用法档」，两边都写得很整齐，没有任何东西会发现——
 * 直到有人照登记表去处理，做了一件本来不用做的事。所以按源码扫，不维护第二份清单。
 */
function checkExitCodeParity({ ROOT, readText, walk, fail, note }) {
  const sources = [
    ...walk(join(ROOT, 'scripts'), (f) => f.endsWith('.mjs')),
    ...walk(join(ROOT, 'kit', 'skills'), (f) => f.endsWith('.mjs')),
  ].map((abs) => ({ file: abs.slice(ROOT.length + 1).replace(/\\/g, '/'), text: readText(abs) }))
  const result = evaluateExitCodeParity(sources, blockedExitOf)
  for (const message of result.failures) fail(`退出码档位：${message}`)
  // 覆盖率必须一起报：只说「核过的都一致」而不说「有多少没核」，
  // 读的人会把前者当成全部——那正是本片要治的那种「看着很干净」。
  if (result.ok) {
    const { literals, paired, unpaired, byKind: kind } = result.coverage
    note(`退出码档位：${result.codes} 个在册阻断码的 ${paired} 处返回与登记一致；`
      + `另有 ${unpaired}/${literals} 处不在覆盖内：标签类 ${kind.label.length}（退出码由调用方给）、提示类 ${kind.advisory.length}（本就不阻断）、委派类 ${kind.delegated.length}`)
  }
}

export async function runSuiteChecks(ctx) {
  const filterChanged = (abs) => !ctx.changedSet || ctx.changedSet.has(ctx.rel(abs))
  const allMjs = [
    ...ctx.walk(join(ctx.ROOT, 'scripts'), (f) => f.endsWith('.mjs')),
    ...ctx.walk(join(ctx.ROOT, 'kit', 'skills'), (f) => f.endsWith('.mjs')),
  ]
  const syntaxTargets = [...new Set(allMjs)].filter(filterChanged)
  const syntaxErrors = await batchSyntaxCheck(syntaxTargets)
  checkScripts(ctx, syntaxErrors)
  checkArchBoundaries(ctx)
  checkDevProfileParity(ctx)
  checkOrphanScripts(ctx)
  await checkPlatformSemanticParity(ctx)
  checkOwnInstances(ctx)
  checkTeamAndTddContracts(ctx)
  checkEvergreenFreshness(ctx)
  checkReadmeVisualsAndDocFrontmatter(ctx)
  checkTemplates(ctx)
  checkPlatformLock(ctx)
  checkStructureRules(ctx)
  checkKitSuite(ctx, syntaxErrors)
  checkCliParity(ctx)
  const subParity = evaluateSubcommandParity(ctx.ROOT)
  for (const message of subParity.failures) ctx.fail(`子命令对拍：${message}`)
  if (subParity.ok) ctx.note(`子命令对拍：${subParity.notes.join('、')} 全部与 SUBCOMMAND_META 对齐`)
  checkExitCodeParity(ctx)
  checkKitWriteProbes(ctx)
  runKernelParityChecks(ctx)
  checkHygiene(ctx)
}
