#!/usr/bin/env node
/**
 * compose-agents.mjs —— 生成或刷新目标项目的 AGENTS.md。
 *
 * - 支持 `--tier lightweight|full` 求值 `is-lightweight` / `is-full`。
 * - 兼容 `.pf-manifest.json` v1/v2：按 `disabledSkills` 从意图路由过滤已禁用技能，
 *   按 `removedAgentsRegions` 跳过用户主动删除的区间，无基线时对既有非空区段默认 `protect`。
 * - `--check` / `--status` / `--clean` / `--upgrade` 保持幂等与写前仓外快照保护。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { survey } from './survey.mjs'
import { isMainModule, readTextSafe } from './lib/text.mjs'
import { clearStaleTemps, writeAtomic } from './lib/fs-atomic.mjs'
import * as protocol from './lib/protocol.mjs'
import { renderTemplate, TemplateError } from './lib/template.mjs'
import {
  collectMissingSections,
  driftRegions,
  filterIntentRouting,
  handWrittenCoverage,
  headingLines,
  missingRegionsOf,
  refreshRegions,
  regionBodySha,
  sectionAlreadyPresent,
} from './lib/agents-sections.mjs'

const { LIKELY_DEFAULT_BRANCHES, markerRegions, parseMarkers, stripMarkers } = protocol
const KIT_SKILLS = protocol.KIT_SKILLS ?? ['dev-explore', 'dev-plan', 'dev-flow', 'dev-review', 'dev-govern']
const LIGHTWEIGHT_KIT_SKILLS = protocol.LIGHTWEIGHT_KIT_SKILLS ?? ['dev-explore', 'dev-plan', 'dev-flow']
const EQUIP_TIERS = protocol.EQUIP_TIERS ?? ['lightweight', 'full']
const AGENTS_MAX_BYTES = protocol.AGENTS_MAX_BYTES ?? 30720
const AGENTS_WARN_BYTES = protocol.AGENTS_WARN_BYTES ?? 24576
const PF_MANIFEST_REL = protocol.PF_MANIFEST_REL ?? '.agents/skills/.pf-manifest.json'

const HERE = dirname(fileURLToPath(import.meta.url))
const SKILL_ROOT = resolve(HERE, '..')
const TEMPLATE_PATH = join(SKILL_ROOT, 'templates', 'agents-project.md')

async function maybePreWriteBackup(root, existingText, noBackup) {
  if (noBackup || !String(existingText ?? '').trim()) return null
  const backupScript = join(HERE, 'backup.mjs')
  if (!existsSync(backupScript)) return null
  const mod = await import(pathToFileURL(backupScript).href)
  if (typeof mod?.ensurePreWriteBackup !== 'function') return null
  return await mod.ensurePreWriteBackup(root, { label: 'compose-agents' })
}

function checkAgentsBytes(text) {
  const bytes = Buffer.byteLength(String(text ?? ''), 'utf8')
  return {
    bytes,
    oversize: bytes > AGENTS_MAX_BYTES,
    warn: bytes >= AGENTS_WARN_BYTES && bytes <= AGENTS_MAX_BYTES,
  }
}

function readManifestSafe(root) {
  const manifestPath = join(root, PF_MANIFEST_REL)
  if (!existsSync(manifestPath)) return null
  const raw = readTextSafe(manifestPath)
  if (raw === undefined) return { path: manifestPath, raw: '', data: {}, invalid: true }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path: manifestPath, raw, data: {}, invalid: true }
    }
    return { path: manifestPath, raw, data: parsed, invalid: false }
  } catch {
    return { path: manifestPath, raw, data: {}, invalid: true }
  }
}

function resolveEffectiveTier(explicitTier, manifest, facts) {
  if (explicitTier) return explicitTier
  const mTier = !manifest?.invalid ? manifest?.data?.tier : undefined
  if (EQUIP_TIERS.includes(mTier)) return mTier
  const kTier = facts?.kit?.tier
  if (EQUIP_TIERS.includes(kTier)) return kTier
  const fTier = facts?.tier
  if (EQUIP_TIERS.includes(fTier)) return fTier
  return 'full'
}

function excludedSkillsFor(facts, manifest, tier) {
  const excluded = new Set()
  const fromManifest = !manifest?.invalid && Array.isArray(manifest?.data?.disabledSkills)
    ? manifest.data.disabledSkills
    : []
  const fromFacts = Array.isArray(facts?.kit?.disabledSkills) ? facts.kit.disabledSkills : []
  for (const s of [...fromManifest, ...fromFacts]) {
    if (typeof s === 'string' && s.trim()) excluded.add(s.trim())
  }
  if (tier === 'lightweight') {
    for (const s of KIT_SKILLS) {
      if (!LIGHTWEIGHT_KIT_SKILLS.includes(s)) excluded.add(s)
    }
  }
  return excluded
}

function writeManifestRegions(root, agentsText, protectedIds = [], removedIds = []) {
  const manifest = readManifestSafe(root)
  if (!manifest || manifest.invalid) return false
  const prevRegions = manifest.data.agentsRegions && typeof manifest.data.agentsRegions === 'object'
    ? manifest.data.agentsRegions
    : {}
  const protectedSet = new Set(protectedIds)
  const lines = String(agentsText ?? '').replace(/\r\n/g, '\n').split('\n')
  const { regions, broken } = markerRegions(agentsText, 'AGENTS.md')
  if (broken.length > 0) return false

  const nextRegions = {}
  const presentIds = new Set()
  for (const region of regions) {
    presentIds.add(region.id)
    if (protectedSet.has(region.id) && prevRegions[region.id]?.sha256) {
      nextRegions[region.id] = prevRegions[region.id]
    } else {
      const bodyLines = lines.slice(region.start + 1, region.end)
      nextRegions[region.id] = { sha256: regionBodySha(bodyLines) }
    }
  }

  const prevRemoved = Array.isArray(manifest.data.removedAgentsRegions) ? manifest.data.removedAgentsRegions : []
  const nextRemoved = [...new Set([...prevRemoved, ...removedIds])]
    .filter((id) => typeof id === 'string' && id && !presentIds.has(id))
    .sort()

  const nextData = {
    ...manifest.data,
    agentsRegions: nextRegions,
    ...(manifest.data.schemaVersion === 2 || nextRemoved.length > 0 || Array.isArray(manifest.data.removedAgentsRegions)
      ? { removedAgentsRegions: nextRemoved }
      : {}),
  }
  const nextRaw = `${JSON.stringify(nextData, null, 2)}\n`
  if (nextRaw === manifest.raw.replace(/\r\n/g, '\n')) return false
  writeAtomic(manifest.path, nextRaw)
  return true
}

const COMMAND_ORDER = ['install', 'build', 'typecheck', 'lint', 'test', 'verify']
const COMMAND_LABEL = {
  install: '安装依赖', build: '构建', typecheck: '类型检查', lint: '静态检查',
  test: '测试', verify: '综合验证',
}

function customSkillsOf(facts) {
  const kitSet = new Set(KIT_SKILLS)
  const raw = Array.isArray(facts?.kit?.customSkills)
    ? facts.kit.customSkills
    : (Array.isArray(facts?.localSkills) ? facts.localSkills : []).filter((s) => {
        const p = String(s?.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
        return /(?:^|\/)skills\/[^/]+$/i.test(p) && !/(?:^|\/)\.agents\/skills\/lib$/i.test(p)
      })

  const seen = new Set()
  const result = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || item.valid === false) continue
    const rawPath = String(item.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const rawName = String(item.name ?? '').trim()
    const normPath = rawPath || (rawName ? `.agents/skills/${rawName}` : '')
    if (!normPath) continue
    const dirName = normPath.split('/').pop()
    const displayName = rawName || dirName
    if (kitSet.has(dirName) || kitSet.has(displayName)) continue
    if (seen.has(normPath)) continue
    seen.add(normPath)
    result.push({
      path: normPath,
      name: displayName,
      summary: String(item.summary ?? '').replace(/\s+/g, ' ').trim(),
    })
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

export function buildConditions(facts, { tier } = {}) {
  const commands = facts.commands ?? {}
  const hasCommands = COMMAND_ORDER.some((k) => typeof commands[k] === 'string' && commands[k].trim())
  const kinds = facts.ecosystem?.kinds ?? []
  const tags = facts.git?.tags ?? []
  const hasRemote = Boolean(facts.git?.remote) && facts.git?.isRepoRoot !== false
  const hasCustomSkills = customSkillsOf(facts).length > 0
  const effectiveTier = resolveEffectiveTier(tier, null, facts)

  return {
    'has-commands': hasCommands,
    'no-commands': !hasCommands,
    'has-remote': hasRemote,
    'no-remote': !hasRemote,
    'has-release': Boolean(
      facts.ecosystem?.publishable
      || facts.ecosystem?.registryFree
      || facts.docs?.releasing
      || facts.docs?.workflowFacts?.hasRelease
      || tags.length > 0,
    ),
    'is-monorepo': Boolean(facts.workspace?.declared),
    'is-plugin-or-skill': kinds.some((k) => k === 'skill' || k.endsWith('-plugin') || k.endsWith('-extension')),
    'has-bilingual-docs': Boolean(facts.docs?.readmePair),
    'has-custom-skills': hasCustomSkills,
    'is-lightweight': effectiveTier === 'lightweight',
    'is-full': effectiveTier === 'full',
  }
}

function commandsBlock(facts) {
  const byEco = facts.commandsByEcosystem ?? {}
  const kinds = Object.keys(byEco).filter((k) => COMMAND_ORDER.some((key) => byEco[k]?.[key]))

  if (kinds.length > 1) {
    const blocks = []
    for (const kind of kinds) {
      const lines = [`# --- ${kind} ---`]
      for (const key of COMMAND_ORDER) {
        const value = byEco[kind]?.[key]
        if (typeof value === 'string' && value.trim()) lines.push(`${value}  # ${COMMAND_LABEL[key]}`)
      }
      blocks.push(lines.join('\n'))
    }
    return blocks.join('\n\n')
  }

  const source = kinds.length === 1 ? byEco[kinds[0]] : facts.commands ?? {}
  const lines = []
  for (const key of COMMAND_ORDER) {
    const value = source[key]
    if (typeof value === 'string' && value.trim()) lines.push(`${value}  # ${COMMAND_LABEL[key]}`)
  }
  return lines.join('\n')
}

function commitStyleHint(facts) {
  const style = facts.conventions?.commitStyle
  const observed = {
    conventional: '本项目历史提交用的是「类型: 说明」的约定式格式',
    gitmoji: '本项目历史提交以 emoji 标记开头',
    plain: '本项目历史提交是平铺的一句说明',
  }[style]
  if (!observed) return '提交风格：沿用项目既有历史的写法，不混用多套格式，不用内部编号充当说明'
  return `${observed}——沿用它，不要混用第二套格式，不用内部编号充当说明`
}

function conventionsHint(facts) {
  const bits = []
  const others = facts.docs?.otherAiConventions ?? []
  if (others.length > 0) {
    bits.push(`项目里已有这些 AI 约定文件：${others.map((f) => `\`${f}\``).join('、')}。`
      + '逐条读一遍，把其中仍然成立的规则合进本节；合完问用户要不要把旧文件改成'
      + '指向 `AGENTS.md` 的单行引用——留着两份，迟早各说各的')
  }
  const tooling = facts.conventions?.workflowTooling ?? []
  if (tooling.length > 0) {
    bits.push(`项目已在用这些发版/提交工具：${tooling.map((f) => `\`${f}\``).join('、')}。`
      + '本节的发布与提交规则按它们的实际行为写，不要照抄模板默认话术')
  }
  return bits.length === 0 ? '' : `\n\n${bits.join('\n\n')}`
}

function customSkillsBlock(facts) {
  const custom = customSkillsOf(facts)
  if (custom.length === 0) return ''
  return custom
    .map((s) => (s.summary
      ? `- \`${s.path}/SKILL.md\`（\`${s.name}\`）：${s.summary}`
      : `- \`${s.path}/SKILL.md\`（\`${s.name}\`）`))
    .join('\n')
}

export function buildVars(facts, root) {
  const conventions = facts.conventions ?? {}
  const releaseNotesTarget = conventions.releaseNotesMode === 'changelog'
    ? 'CHANGELOG.md 的对应版本节'
    : 'docs/release-notes/<标签>.md'
  const readmes = facts.docs?.readmes ?? []
  const packages = facts.workspace?.packages ?? []
  const targetRoot = root || facts.target?.path
  const legacyWorkExists = Boolean(targetRoot && existsSync(join(targetRoot, 'docs', 'work')) && !existsSync(join(targetRoot, 'docs', 'todo')))
  const resolvedWorkDir = conventions.workDir && conventions.workDir !== 'docs/work'
    ? conventions.workDir
    : (legacyWorkExists ? 'docs/work' : 'docs/todo')

  return {
    PROJECT_NAME: facts.target?.name ?? '这个项目',
    COMMANDS: commandsBlock(facts),
    RUNTIME_REQUIREMENTS: (facts.artifacts?.runtimeRequirements ?? []).join('、') || '见清单文件声明',
    DEFAULT_BRANCH: conventions.defaultBranch || 'main',
    VERSION_SOURCE: facts.ecosystem?.manifests?.[0] ?? '清单文件',
    RELEASING_DOC: facts.docs?.releasing ?? 'RELEASING.md',
    RELEASE_NOTES_TARGET: releaseNotesTarget,
    WORK_DIR: `${resolvedWorkDir}/`,
    COMMIT_STYLE_HINT: commitStyleHint(facts),
    README_LIST: readmes.length > 0 ? readmes.map((r) => `\`${r}\``).join('、') : '`README.md`',
    WORKSPACE_PACKAGES: packages.length > 0 ? packages.map((p) => `\`${p}\``).join('、') : '各子包',
    CONVENTIONS_HINT: conventionsHint(facts),
    CUSTOM_SKILLS_BLOCK: customSkillsBlock(facts),
  }
}

export function renderAgentsTemplate(facts, templateText, root, { tier, manifest } = {}) {
  const targetRoot = root || facts?.target?.path
  const resolvedManifest = manifest ?? (targetRoot ? readManifestSafe(targetRoot) : null)
  const effectiveTier = resolveEffectiveTier(tier, resolvedManifest, facts)
  const rendered = renderTemplate(
    templateText,
    buildConditions(facts, { tier: effectiveTier }),
    buildVars(facts, root),
    'template.md',
  )
  return filterIntentRouting(rendered, excludedSkillsFor(facts, resolvedManifest, effectiveTier))
}

function volatileValues(facts) {
  const detected = facts.conventions?.defaultBranch
  const values = [...LIKELY_DEFAULT_BRANCHES]
  if (typeof detected === 'string' && detected.length >= 2 && !values.includes(detected)) {
    values.push(detected)
  }
  return values
}

function clearTempsBeside(agentsPath, { dryRun = false } = {}) {
  return clearStaleTemps(agentsPath, { dryRun })
}

function inspect(agentsPath, rendered, removedRegions = null) {
  const text = readTextSafe(agentsPath)
  if (text === undefined) {
    return {
      state: 'unreadable', fills: [], regions: [], broken: [], missingRegions: [], customized: [],
    }
  }
  const markers = parseMarkers(text, 'AGENTS.md')
  const fills = markers.filter((m) => m.kind === 'fill')
  const regions = markerRegions(text, 'AGENTS.md')
  const present = new Set(regions.regions.map((r) => r.id))
  const customized = regions.regions.filter((r) => r.customized).map((r) => r.id)
  return {
    state: fills.length > 0 ? 'has-fills' : 'ok',
    fills,
    regions: regions.regions,
    broken: regions.broken,
    customized,
    missingRegions: missingRegionsOf(present, rendered, text, removedRegions),
    text,
  }
}

function report(agentsPath, info, { verbose = false } = {}) {
  const name = 'AGENTS.md'
  if (info.state === 'unreadable') {
    process.stdout.write(`${name} 读不出来（不是 UTF-8 文本？）。这不是「没有」，是「有但读不懂」——先看清它是什么。\n`)
    return
  }
  if (info.broken && info.broken.length > 0) {
    process.stdout.write(`${name} 的标记没成对：${info.broken.join('、')}。半对标记意味着文件被手工改坏了，不动它，先看清缺的是哪个 end。\n`)
    return
  }
  if (info.regions.length === 0) {
    process.stdout.write(`${name} 里没有任何 <!-- project-forge: begin … --> 标记。\n`
      + '这通常意味着它**是手写的**。按规矩不动它——手写的契约可能比模板更贴合这个项目。\n')
    const additions = collectMissingSections(renderedCache, info.text ?? '')
    if (additions.length > 0) {
      process.stdout.write(`\n模板里的这几节它还没有：共 ${additions.length} 段\n`
        + '要补的话加 `--upgrade`：只**追加**缺的节，每节带自己的标记，已有的字一个不动。\n')
    }
    return
  }
  process.stdout.write(`${name}：${info.regions.length} 段受管内容（${info.regions.map((r) => r.id).join('、')}）\n`)
  if (info.customized && info.customized.length > 0) {
    process.stdout.write(`${info.customized.length} 段已由你接管、脚本不再改动：${info.customized.join('、')}`
      + '（标记里带 `customized`；想交回去就删掉那个词）\n')
  }
  if (info.missingRegions.length > 0) {
    process.stdout.write(`还有 ${info.missingRegions.length} 节该有却没有：${info.missingRegions.join('、')}\n`
      + '（模板里的条件现在为真，所以这一节该在。跑一次不带参数就会补上，已有内容不动。）\n')
  }
  if (info.fills.length > 0) {
    process.stdout.write(`还有 ${info.fills.length} 处要人填：\n`)
    for (const fill of info.fills) {
      process.stdout.write(`  - 第 ${fill.line} 行：${fill.what}\n`)
    }
    if (verbose) {
      process.stdout.write('\n填完之后把那一整行标记删掉——留着它，看起来就像「这里已经填过了」。\n')
    }
  } else {
    process.stdout.write('没有未填的占位。\n')
  }
}

let renderedCache = ''

async function main(argv) {
  let target = process.cwd()
  let targetSpecified = false
  let mode = 'default'
  let verbose = false
  let noBackup = false
  let explicitTier
  let restoreRegions = false

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/compose-agents.mjs [目标目录] [选项]',
        '',
        '  （默认）                   文件不存在就建一份；已存在就刷新还带占位的区间、补上新增的节',
        '  --tier <lightweight|full>  按档位渲染（is-lightweight / is-full）',
        '  --restore-regions          允许重新补回此前已记入 removedAgentsRegions 的区间',
        '  --status                   只报现状，不写任何文件',
        '  --upgrade                  向手写文件追加缺失的节，每节带自己的标记，已有内容不动',
        '  --check                    门禁：标记成对、没有未填占位、该有的节都在时退出 0',
        '  --clean                    剥掉本 skill 留下的全部标记，正文保留',
        '  --no-backup                改写已有非空 AGENTS.md 前跳过自动快照备份',
        '  --verbose                  多说一点',
        '',
        '只碰 AGENTS.md 一个文件。',
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--status') mode = 'status'
    else if (arg === '--upgrade') mode = 'upgrade'
    else if (arg === '--check') mode = 'check'
    else if (arg === '--clean') mode = 'clean'
    else if (arg === '--no-backup') noBackup = true
    else if (arg === '--restore-regions') restoreRegions = true
    else if (arg === '--verbose') verbose = true
    else if (arg === '--tier') explicitTier = argv[++i]
    else if (arg.startsWith('--tier=')) explicitTier = arg.slice('--tier='.length)
    else if (!arg.startsWith('-') && !targetSpecified) { target = arg; targetSpecified = true }
    else {
      process.stderr.write(`未知选项：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  if (explicitTier !== undefined && !EQUIP_TIERS.includes(explicitTier)) {
    process.stderr.write(`--tier 必须是 ${EQUIP_TIERS.join(' | ')} 之一（收到：${explicitTier}）\n`)
    return 2
  }

  const root = resolve(target)
  if (!existsSync(root)) {
    process.stderr.write(`目标目录不存在：${root}\n`)
    return 2
  }
  const agentsPath = join(root, 'AGENTS.md')
  const template = readFileSync(TEMPLATE_PATH, 'utf8').replace(/\r\n/g, '\n')
  const manifest = readManifestSafe(root)

  if (!existsSync(agentsPath)) {
    if (mode === 'status' || mode === 'check') {
      process.stdout.write('AGENTS.md 还没有。\n')
      return mode === 'check' ? 1 : 0
    }
    if (mode === 'clean' || mode === 'upgrade') {
      process.stdout.write('没有 AGENTS.md，无从清理或追加。要生成就跑一次不带参数。\n')
      return 0
    }
    return await generate(root, agentsPath, template, { tier: explicitTier, manifest })
  }

  const existing = (readTextSafe(agentsPath) ?? '').replace(/\r\n/g, '\n')

  if (mode === 'clean') {
    const cleaned = stripMarkers(existing, 'AGENTS.md')
    if (cleaned !== existing) await maybePreWriteBackup(root, existing, noBackup)
    const temps = clearTempsBeside(agentsPath)
    if (temps.removed.length > 0) {
      process.stdout.write(`清掉了 ${temps.removed.length} 个上次写到一半留下的临时文件。\n`)
    }
    if (cleaned === existing) {
      process.stdout.write('没有标记可剥，文件未改动。\n')
      return 0
    }
    writeAtomic(agentsPath, cleaned)
    process.stdout.write('已剥掉全部标记，正文保留。\n')
    return 0
  }

  let rendered
  let facts
  try {
    facts = await factsOf(root)
    rendered = renderAgentsTemplate(facts, template, root, { tier: explicitTier, manifest })
  } catch (error) {
    process.stderr.write(`模板渲染失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  renderedCache = rendered

  const removedSet = restoreRegions
    ? new Set()
    : new Set(!manifest?.invalid && Array.isArray(manifest?.data?.removedAgentsRegions) ? manifest.data.removedAgentsRegions : [])

  const info = inspect(agentsPath, rendered, removedSet)

  if (mode === 'check') {
    if (info.state === 'unreadable') {
      process.stderr.write('AGENTS.md 读不出来（不是 UTF-8 文本？）\n')
      return 1
    }
    const sizeInfo = checkAgentsBytes(info.text)
    if (sizeInfo.warn) {
      process.stderr.write(`[警告] AGENTS.md 体积 ${sizeInfo.bytes} 字节，接近上限 ${AGENTS_MAX_BYTES} 字节（预警线 ${AGENTS_WARN_BYTES} 字节）。\n`)
    }
    if (info.broken && info.broken.length > 0) {
      process.stderr.write(`AGENTS.md 的标记没成对：${info.broken.join('、')}\n`)
      return 1
    }
    if (info.regions.length === 0) {
      const coverage = handWrittenCoverage(info.text ?? '')
      if (!coverage.ok) {
        const why = []
        if (coverage.chars < 400) why.push(`正文只有 ${coverage.chars} 个字符`)
        if (coverage.missing.length > 0) why.push(`缺这几类内容：${coverage.missing.join('、')}`)
        process.stderr.write(`AGENTS.md 是手写的，但它还不算一份契约：${why.join('；')}\n`
          + '  加 `--upgrade` 会追加缺的节，原有内容一个字节不动。\n')
        return 1
      }
      if (sizeInfo.oversize) {
        process.stderr.write(`AGENTS.md 体积 ${sizeInfo.bytes} 字节超过上限 ${AGENTS_MAX_BYTES} 字节（30KB），请精简或拆至子目录契约。\n`)
        return 1
      }
      process.stdout.write('AGENTS.md 是手写的（没有受管标记）——不判格式，只核对过它答了'
        + '「这是什么项目 / 怎么构建验证 / 改动的边界」这三件事。\n')
      return 0
    }
    let bad = false
    if (sizeInfo.oversize) {
      process.stderr.write(`AGENTS.md 体积 ${sizeInfo.bytes} 字节超过上限 ${AGENTS_MAX_BYTES} 字节（30KB），请精简过时条款或拆出细节至 docs/。\n`)
      bad = true
    }
    if (info.fills.length > 0) {
      process.stderr.write(`AGENTS.md 还有 ${info.fills.length} 处未填的占位\n`)
      for (const fill of info.fills) process.stderr.write(`  第 ${fill.line} 行：${fill.what}\n`)
      bad = true
    }
    if (info.missingRegions.length > 0) {
      process.stderr.write(`AGENTS.md 缺 ${info.missingRegions.length} 节（条件为真却没有）：${info.missingRegions.join('、')}\n`)
      bad = true
    }
    const drifted = driftRegions(existing, rendered, volatileValues(facts))
    if (drifted.length > 0) {
      process.stderr.write(`AGENTS.md 有 ${drifted.length} 段与模板不一致：${drifted.join('、')}\n`
        + '  这几段的内容完全由项目事实决定，本该与模板渲染结果逐字相同。跑一次不带参数就会刷新。\n')
      const baselineRegions = manifest && !manifest.invalid ? manifest.data.agentsRegions : null
      if (baselineRegions) {
        const existingLines = existing.split('\n')
        const modifiedByUser = drifted.filter((id) => {
          const region = info.regions.find((r) => r.id === id)
          const baseSha = baselineRegions[id]?.sha256
          if (!region || !baseSha) return false
          return regionBodySha(existingLines.slice(region.start + 1, region.end)) !== baseSha
        })
        if (modifiedByUser.length > 0) {
          process.stderr.write(`  [冲突提示] ${modifiedByUser.join('、')} 与 ${PF_MANIFEST_REL} 记录的旧基线不符：若有意保留手改请在 begin 行追加 customized，否则还原后重跑。\n`)
        }
      }
      bad = true
    }
    if (bad) return 1
    process.stdout.write('AGENTS.md：标记成对、没有未填占位、该有的节都在、内容与模板一致。\n')
    return 0
  }

  if (mode === 'upgrade') {
    if (info.regions.length > 0) {
      process.stdout.write('这份文件已经有受管标记，用默认模式刷新即可（--upgrade 只用于手写文件）。\n')
      return 0
    }
    const additions = collectMissingSections(rendered, existing)
    if (additions.length === 0) {
      process.stdout.write('模板里的节都已在文件中，无需追加。\n')
      return 0
    }
    const nextText = `${existing.trimEnd()}\n\n${additions.join('\n\n')}\n`
    const sizeInfo = checkAgentsBytes(nextText)
    if (sizeInfo.oversize) {
      process.stderr.write(`追加后 AGENTS.md 体积将达 ${sizeInfo.bytes} 字节，超过上限 ${AGENTS_MAX_BYTES} 字节（30KB），已中止写入。\n`)
      return 1
    }
    if (sizeInfo.warn) {
      process.stderr.write(`[警告] AGENTS.md 体积 ${sizeInfo.bytes} 字节接近上限 ${AGENTS_MAX_BYTES} 字节。\n`)
    }
    await maybePreWriteBackup(root, existing, noBackup)
    writeAtomic(agentsPath, nextText)
    writeManifestRegions(root, nextText)
    process.stdout.write(`已追加 ${additions.length} 节：只加不改，原有内容一个字节没动。\n`)
    process.stdout.write('接下来读代码填掉里面的「fill」标记，填完把标记行删掉。\n')
    return 0
  }

  if (mode === 'default' && info.regions.length > 0 && info.broken.length === 0) {
    const baselineRegions = manifest && !manifest.invalid ? (manifest.data.agentsRegions ?? {}) : null
    const presentIds = new Set(info.regions.map((r) => r.id))
    const existingHeadings = headingLines(existing)
    const newlyRemoved = []
    if (!restoreRegions && baselineRegions) {
      for (const prevId of Object.keys(baselineRegions)) {
        if (!presentIds.has(prevId) && !sectionAlreadyPresent(prevId, existingHeadings, rendered)) {
          removedSet.add(prevId)
          newlyRemoved.push(prevId)
        }
      }
    }

    const refreshed = refreshRegions(existing, rendered, volatileValues(facts), baselineRegions, removedSet)
    const nextText = refreshed.changed ? refreshed.text : existing
    const sizeInfo = checkAgentsBytes(nextText)
    if (sizeInfo.oversize) {
      process.stderr.write(`刷新后 AGENTS.md 体积 ${sizeInfo.bytes} 字节超过上限 ${AGENTS_MAX_BYTES} 字节（30KB），已中止写入。\n`)
      return 1
    }
    if (sizeInfo.warn) {
      process.stderr.write(`[警告] AGENTS.md 体积 ${sizeInfo.bytes} 字节已达预警线 ${AGENTS_WARN_BYTES} 字节（上限 ${AGENTS_MAX_BYTES} 字节）。\n`)
    }
    if (refreshed.changed) {
      await maybePreWriteBackup(root, existing, noBackup)
      writeAtomic(agentsPath, refreshed.text)
      const bits = []
      if (refreshed.filled.length > 0) bits.push(`填了 ${refreshed.filled.length} 段（${refreshed.filled.join('、')}）`)
      if (refreshed.synced.length > 0) bits.push(`跟上模板 ${refreshed.synced.length} 段（${refreshed.synced.join('、')}）`)
      if (refreshed.inserted.length > 0) bits.push(`插入 ${refreshed.inserted.length} 节（${refreshed.inserted.join('、')}）`)
      process.stdout.write(`已刷新受管区间：${bits.join('，')}。标记之外、以及人写过的区间一个字节没动。\n`)
    } else if (refreshed.protectedRegions.length === 0) {
      process.stdout.write('受管区间都已填过、也都与模板一致，文件未改动。\n')
    }
    if (refreshed.protectedRegions.length > 0) {
      process.stderr.write(`[保护跳过] 以下区间曾被手工修改或缺乏基线（与 ${PF_MANIFEST_REL} 不符且未标 customized），已保留你的改动未覆盖：${refreshed.protectedRegions.join('、')}。\n`)
    }
    writeManifestRegions(root, nextText, refreshed.protectedRegions, newlyRemoved)
    report(agentsPath, inspect(agentsPath, rendered, removedSet), { verbose })
    return 0
  }

  report(agentsPath, info, { verbose })
  return 0
}

async function factsOf(root) {
  return survey(root)
}

async function generate(root, agentsPath, template, { tier, manifest } = {}) {
  let content
  try {
    const facts = await factsOf(root)
    content = renderAgentsTemplate(facts, template, root, { tier, manifest })
  } catch (error) {
    process.stderr.write(`模板渲染失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }
  const sizeInfo = checkAgentsBytes(content)
  if (sizeInfo.oversize) {
    process.stderr.write(`生成的 AGENTS.md 体积 ${sizeInfo.bytes} 字节超过上限 ${AGENTS_MAX_BYTES} 字节（30KB），已中止写入。\n`)
    return 1
  }
  if (sizeInfo.warn) {
    process.stderr.write(`[警告] AGENTS.md 体积 ${sizeInfo.bytes} 字节已达预警线 ${AGENTS_WARN_BYTES} 字节（上限 ${AGENTS_MAX_BYTES} 字节）。\n`)
  }
  mkdirSync(dirname(agentsPath), { recursive: true })
  writeAtomic(agentsPath, content)
  writeManifestRegions(root, content)
  const fills = parseMarkers(content, 'AGENTS.md').filter((m) => m.kind === 'fill')
  process.stdout.write('已生成 AGENTS.md（按勘察到的事实填了一部分）。\n')
  if (fills.length > 0) {
    process.stdout.write(`还有 ${fills.length} 处要你读完代码后填：\n`)
    for (const fill of fills) process.stdout.write(`  - 第 ${fill.line} 行：${fill.what}\n`)
    process.stdout.write('\n填完把那一整行标记删掉，然后跑 `node scripts/review.mjs .` 确认归零。\n')
  }
  return 0
}

export async function contractHealth(root, { tier } = {}) {
  const template = readFileSync(TEMPLATE_PATH, 'utf8').replace(/\r\n/g, '\n')
  const facts = await factsOf(root)
  const manifest = readManifestSafe(root)
  const rendered = renderAgentsTemplate(facts, template, root, { tier, manifest })
  const agentsPath = join(root, 'AGENTS.md')
  const removedSet = new Set(!manifest?.invalid && Array.isArray(manifest?.data?.removedAgentsRegions)
    ? manifest.data.removedAgentsRegions : [])
  const info = inspect(agentsPath, rendered, removedSet)
  const existing = (readTextSafe(agentsPath) ?? '').replace(/\r\n/g, '\n')
  const { bytes, oversize } = checkAgentsBytes(existing)
  return {
    broken: info.broken ?? [],
    missing: info.regions.length === 0 ? [] : info.missingRegions ?? [],
    drifted: info.broken.length > 0 ? [] : driftRegions(existing, rendered, volatileValues(facts)),
    customized: info.customized ?? [],
    handWritten: info.regions.length === 0,
    bytes,
    oversize,
  }
}

export { TemplateError, refreshRegions, driftRegions, collectMissingSections, handWrittenCoverage }

if (isMainModule(import.meta.url, process.argv[1])) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => process.exit(code))
}
