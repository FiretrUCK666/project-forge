/**
 * agents-defaults.mjs —— AGENTS.md 模板变量计算、命令折叠、探索策略与 Dev Profile 智能预填。
 *
 * 从 scripts/compose-agents.mjs 拆出以控制主模块体量；仅依赖 node:* 内置模块与同层 lib/。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import * as protocol from './protocol.mjs'
import { ECO_COMMANDS_SHOWN_PER_KIND } from './render.mjs'

const INLINE_COMMAND_MAX_BYTES = protocol.COMMAND_DISPLAY_MAX_BYTES ?? 500
const PF_MANIFEST_REL = protocol.PF_MANIFEST_REL ?? '.agents/skills/.pf-manifest.json'

export const COMMAND_ORDER = ['install', 'build', 'typecheck', 'lint', 'test', 'verify']
export const COMMAND_LABEL = {
  install: '安装依赖', build: '构建', typecheck: '类型检查', lint: '静态检查',
  test: '测试', verify: '综合验证',
}

export function customSkillsOf(facts) {
  const kitSet = new Set(protocol.getKitSkills())
  const hasKitCustom = Array.isArray(facts?.kit?.customSkills)
  const raw = hasKitCustom
    ? facts.kit.customSkills
    : (Array.isArray(facts?.localSkills) ? facts.localSkills : []).filter((s) => {
        if (s?.isMirror === true) return false
        const p = String(s?.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
        if (/^(?:[^./][^/]*\/)*skills\/[^/]+$/i.test(p)) return true
        if (/^\.[^/]+\/skills\/[^/]+$/i.test(p)) {
          const dirName = p.split('/').pop()
          if (/^\.agents\/skills\//i.test(p) && kitSet.has(dirName)) return false
          return true
        }
        return false
      })

  const seen = new Set()
  const result = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || item.valid === false || item.isMirror === true) continue
    const rawPath = String(item.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    const rawName = String(item.name ?? '').trim()
    const normPath = rawPath || (rawName ? `.agents/skills/${rawName}` : '')
    if (!normPath) continue
    const dirName = normPath.split('/').pop()
    const displayName = rawName || dirName
    if (!hasKitCustom && /^\.agents\/skills\//i.test(normPath) && kitSet.has(dirName)) continue
    if (seen.has(normPath)) continue
    seen.add(normPath)
    const description = String(item.description ?? '').replace(/\s+/g, ' ').trim()
    const summary = String(item.summary ?? description).replace(/\s+/g, ' ').trim()
    result.push({
      path: normPath,
      name: displayName,
      ...(description ? { description } : {}),
      summary,
      ...(item.container ? { container: item.container } : {}),
    })
  }
  return result.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/**
 * 命令块在多处被读：`buildConditions` 要判「有没有命令 / 有没有被略掉的」，
 * `buildVars` 要填正文。同一份 facts 只算一次，免得两处各算一遍算出两种结果。
 */
const COMMAND_PLAN_CACHE = new WeakMap()

export function commandPlanOf(facts) {
  if (facts && typeof facts === 'object') {
    const cached = COMMAND_PLAN_CACHE.get(facts)
    if (cached) return cached
    const plan = commandsBlock(facts)
    COMMAND_PLAN_CACHE.set(facts, plan)
    return plan
  }
  return commandsBlock(facts ?? {})
}

/** 超长命令在块外的去向：源文件优先，其次是这个仓里真实存在的 CI / 任务运行器文件。 */
function whereToLook(facts, cmd) {
  if (cmd.source) return cmd.source
  const workflows = (facts.docs?.workflowFacts?.checkWorkflows ?? facts.docs?.workflows ?? [])
    .map((w) => `.github/workflows/${w}`)
  if (workflows.length > 0) return workflows[0]
  for (const candidate of ['Makefile', 'justfile', 'Taskfile.yml', 'Taskfile.yaml']) {
    if (facts.commandSources && Object.values(facts.commandSources).includes(candidate)) return candidate
  }
  return null
}

/** 超长命令的去向说明（块外）。没有任何超长命令时返回空串。 */
export function commandsOmittedNote(facts, tooLong) {
  if (!tooLong || tooLong.length === 0) return ''
  const parts = tooLong.map((cmd) => {
    const where = whereToLook(facts, cmd)
    return where
      ? `- ${cmd.label}：这条命令太长，见 \`${where}\` 里对应的那一步`
      : `- ${cmd.label}：这条命令太长，见 CI 工作流里对应的那一步`
  })
  return ['这条命令太长，不写进上面那个代码块（照抄会被截断的尾巴带坏）：', ...parts].join('\n')
}

export function commandsBlock(facts) {
  const byEco = facts.commandsByEcosystem ?? {}
  const sources = facts.commandSources ?? {}
  const kinds = Object.keys(byEco).filter((k) => COMMAND_ORDER.some((key) => byEco[k]?.[key]))

  if (kinds.length > 1) {
    const blocks = []
    const skipped = []
    for (const kind of kinds) {
      const pairs = COMMAND_ORDER
        .map((key) => [key, byEco[kind]?.[key]])
        .filter(([, value]) => typeof value === 'string' && value.trim())
      const lines = [`# --- ${kind} ---`]
      const rendered = []
      const omittedHere = []
      for (const [key, value] of pairs) {
        const text = `${value}  # ${COMMAND_LABEL[key]}`
        if (Buffer.byteLength(text, 'utf8') > INLINE_COMMAND_MAX_BYTES) {
          omittedHere.push({ text: value, kind, label: COMMAND_LABEL[key], source: sources[key] })
          continue
        }
        rendered.push(text)
      }
      skipped.push(...omittedHere)
      for (const line of rendered.slice(0, ECO_COMMANDS_SHOWN_PER_KIND)) lines.push(line)
      const hidden = Math.max(0, rendered.length - ECO_COMMANDS_SHOWN_PER_KIND)
      if (hidden > 0) {
        lines.push(`# 另有 ${hidden} 条同类命令未展开，完整清单见该生态的 CI 配置与任务运行器文件`)
      }
      if (rendered.length === 0 && omittedHere.length > 0) {
        lines.push(`# ${kind} 的命令都太长，见本节下方「去哪看」`)
      }
      blocks.push(lines.join('\n'))
    }
    return { block: blocks.join('\n\n'), tooLong: skipped }
  }

  const source = kinds.length === 1 ? byEco[kinds[0]] : facts.commands ?? {}
  const lines = []
  const skipped = []
  for (const key of COMMAND_ORDER) {
    const value = source[key]
    if (typeof value !== 'string' || !value.trim()) continue
    const text = `${value}  # ${COMMAND_LABEL[key]}`
    if (Buffer.byteLength(text, 'utf8') > INLINE_COMMAND_MAX_BYTES) {
      skipped.push({ text: value, kind: key, label: COMMAND_LABEL[key], source: sources[key] })
      continue
    }
    lines.push(text)
  }
  return { block: lines.join('\n'), tooLong: skipped }
}

/** 探索策略写进 `AGENTS.md` 受管区，保留跨档重入可比对依据。 */
export function explorationStrategyBlock(facts) {
  const strategy = facts.explorationStrategy
  if (!strategy || strategy.tier === 'none') return ''
  const lines = [`- **策略级别**：\`${strategy.tier}\``]
  const dims = strategy.oversizeDims ?? []
  if (dims.length > 0) lines.push(`- **越线的维度**：${dims.join('、')}`)
  if (strategy.multiPackage) lines.push('- **布局**：存在多包或多生态子目录')
  if (strategy.reentryComplex) lines.push('- **重入**：存在契约漂移、未登记模块或既有 AI 约定')
  const shards = strategy.shards ?? []
  if (shards.length > 0) {
    lines.push(`- **分片**：共 ${shards.length} 片`)
    for (const shard of shards) {
      lines.push(`  - \`${shard.id}\`（${shard.scope}）：${shard.focus}`)
    }
  }
  return lines.join('\n')
}

export function commitStyleHint(facts) {
  const style = facts.conventions?.commitStyle
  const observed = {
    conventional: '本项目历史提交用的是「类型: 说明」的约定式格式',
    gitmoji: '本项目历史提交以 emoji 标记开头',
    plain: '本项目历史提交是平铺的一句说明',
  }[style]
  if (!observed) return '提交风格：沿用项目既有历史的写法，不混用多套格式，不用内部编号充当说明'
  return `${observed}——沿用它，不要混用第二套格式，不用内部编号充当说明`
}

export function conventionsHint(facts) {
  const bits = []
  const others = facts.docs?.otherAiConventions ?? []
  if (others.length > 0) {
    bits.push(`项目里已有这些 AI 约定文件：${others.map((f) => `\`${f}\``).join('、')}。`
      + '逐条读一遍，把其中仍然成立的规则合进本节；合完问用户要不要把旧文件改成'
      + '指向 `AGENTS.md` 的单行引用——留着两份，迟早各说各的')
  }
  const subdirAgents = facts.docs?.subdirAgentsFiles ?? []
  if (subdirAgents.length > 0) {
    bits.push(`检测到子目录分段契约：${subdirAgents.map((f) => `\`${f}\``).join('、')}——进入对应子目录前按需加读，原样保留不回并覆盖。`)
  }
  const tooling = facts.conventions?.workflowTooling ?? []
  if (tooling.length > 0) {
    bits.push(`项目已在用这些发版/提交工具：${tooling.map((f) => `\`${f}\``).join('、')}。`
      + '本节的发布与提交规则按它们的实际行为写，不要照抄模板默认话术')
  }
  return bits.length === 0 ? '' : `\n\n${bits.join('\n\n')}`
}

export function customSkillsBlock(facts) {
  const custom = customSkillsOf(facts)
  if (custom.length === 0) return ''
  return custom
    .map((s) => {
      const detail = s.description || s.summary
      return detail
        ? `- \`${s.path}/SKILL.md\`（\`${s.name}\`）：${detail}`
        : `- \`${s.path}/SKILL.md\`（\`${s.name}\`）`
    })
    .join('\n')
}

function formatScriptCell(script, skillPath) {
  const s = String(script ?? '').trim()
  if (!s) return `按 \`${skillPath}\` 指引执行`
  return s.includes('`') ? s : `\`${s}\``
}

/**
 * 动态渲染 `AGENTS.md` `意图路由` 表格行，合并按 `order` 排序的已落盘内置技能与项目自有技能。
 */
export function renderKitRoutingRows({
  customSkills = [],
  discoveredSkills,
  hasRemote = true,
} = {}) {
  const skills = Array.isArray(discoveredSkills) ? discoveredSkills : protocol.discoverKitSkills()
  const entries = []
  let seq = 0

  for (const skill of skills) {
    const skillPath = skill.path || `.agents/skills/${skill.dirName || skill.name}/SKILL.md`
    const intentText = (hasRemote === false && skill.intentLocal ? skill.intentLocal : skill.intent)
      || skill.summary || skill.description || skill.name
    entries.push({
      order: Number.isFinite(Number(skill.order)) ? Number(skill.order) : 100,
      seq: seq++,
      intent: String(intentText).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'),
      target: `\`${skillPath}\``,
      script: formatScriptCell(skill.script, skillPath),
    })
    for (const extra of skill.extraRoutes ?? []) {
      const erIntent = hasRemote === false ? (extra.intentLocal ?? extra.intent) : extra.intent
      if (!erIntent) continue
      entries.push({
        order: Number.isFinite(Number(extra.order)) ? Number(extra.order) : 100,
        seq: seq++,
        intent: String(erIntent).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'),
        target: `\`${skillPath}\``,
        script: formatScriptCell(extra.script, skillPath),
      })
    }
  }

  entries.sort((a, b) => (a.order - b.order) || (a.seq - b.seq))
  const rows = entries.map((e) => `| ${e.intent} | ${e.target} | ${e.script} |`)

  for (const cs of customSkills ?? []) {
    if (!cs || cs.valid === false) continue
    const csPath = String(cs.path ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
    if (!csPath) continue
    const csName = String(cs.name ?? csPath.split('/').pop()).trim()
    const csDesc = String(cs.description || cs.summary || csName).replace(/\s+/g, ' ').trim()
    const skillMdPath = csPath.endsWith('/SKILL.md') ? csPath : `${csPath}/SKILL.md`
    const safeIntent = `${csName}：${csDesc}`.replace(/\|/g, '\\|')
    rows.push(`| ${safeIntent} | \`${skillMdPath}\` | 静默读取 \`${skillMdPath}\` 并按指引执行 |`)
  }

  return rows.join('\n')
}

export function excludedSkillsFor(facts, manifest, root, { kitDir } = {}) {
  const excluded = new Set()
  const fromManifest = !manifest?.invalid && Array.isArray(manifest?.data?.disabledSkills)
    ? manifest.data.disabledSkills
    : []
  const fromFacts = Array.isArray(facts?.kit?.disabledSkills) ? facts.kit.disabledSkills : []
  for (const s of [...fromManifest, ...fromFacts]) {
    if (typeof s === 'string' && s.trim()) excluded.add(s.trim())
  }
  const discovered = protocol.discoverKitSkills(kitDir)
  const kitSkillNames = discovered.map((s) => s.dirName)
  if (root && (existsSync(join(root, '.agents')) || existsSync(join(root, PF_MANIFEST_REL)))) {
    for (const s of kitSkillNames) {
      if (!existsSync(join(root, '.agents', 'skills', s, 'SKILL.md'))) excluded.add(s)
    }
  }
  return excluded
}

/**
 * 基于 survey 探测到的命令与生态清单预填 7 键 Dev Profile：
 * - 纯文档或无清单无命令仓默认值收口为 `none` / `AGENTS.md` / `docs/archive/` 且不留 fill 提示；
 * - 有命令代码仓填入真实命令，未检出项保留可读尖括号占位并附 fill 提示。
 */
export function buildDevProfileVars(facts, targetRoot) {
  const cmds = facts?.commands ?? {}
  const manifests = Array.isArray(facts?.ecosystem?.manifests) ? facts.ecosystem.manifests : []
  const kinds = Array.isArray(facts?.ecosystem?.kinds) ? facts.ecosystem.kinds : []
  const plan = commandPlanOf(facts ?? {})
  const hasCommands = plan.block.trim().length > 0
    || COMMAND_ORDER.some((k) => typeof cmds[k] === 'string' && cmds[k].trim())
    || Boolean(cmds.check || cmds.smoke)
  const hasCodeManifests = manifests.length > 0 || kinds.some((k) => k && k !== 'docs-only' && k !== 'empty')

  if (!hasCommands && !hasCodeManifests) {
    const hasGithub = Boolean(targetRoot && existsSync(join(targetRoot, '.github')))
      || (Array.isArray(facts?.docs?.workflows) && facts.docs.workflows.length > 0)
    return {
      PROFILE_QUICK_TEST: 'none',
      PROFILE_FULL_TEST: 'none',
      PROFILE_SMOKE_VERIFY: 'none',
      PROFILE_MERGE_GATE: 'none',
      PROFILE_ARCH_RULES: 'none',
      PROFILE_HIGH_RISK: hasGithub ? '.github/, AGENTS.md' : 'AGENTS.md',
      PROFILE_DO_NOT_EDIT: 'docs/archive/',
      PROFILE_FILL_HINT: '',
    }
  }

  const pkgScripts = new Set(Array.isArray(facts?.ecosystem?.packageScripts) ? facts.ecosystem.packageScripts : [])
  const pm = facts?.ecosystem?.packageManager ?? 'npm'
  const pmRun = pm === 'npm' ? 'npm run' : pm

  const quickTest = (typeof cmds.test === 'string' && cmds.test.trim()) || '<单文件或快测命令>'
  const fullTest = (typeof cmds.verify === 'string' && cmds.verify.trim())
    || (typeof cmds.check === 'string' && cmds.check.trim())
    || (typeof cmds.test === 'string' && cmds.test.trim())
    || '<全量构建与测试命令>'
  const smokeVerify = (typeof cmds.smoke === 'string' && cmds.smoke.trim()) || '<运行时端到端冒烟验证命令，或 none>'
  let mergeGate = ''
  if (typeof cmds.verify === 'string' && cmds.verify.trim()) mergeGate = cmds.verify.trim()
  else if (pkgScripts.has('ci')) mergeGate = `${pmRun} ci`
  else if (cmds.lint && cmds.test) mergeGate = `${cmds.lint} && ${cmds.test}`
  else if (cmds.build && cmds.test) mergeGate = `${cmds.build} && ${cmds.test}`
  else if (typeof cmds.test === 'string' && cmds.test.trim()) mergeGate = cmds.test.trim()
  else mergeGate = '<合并前必跑完整门禁命令>'

  const archRules = '<跨层禁引规则如 src/lib/** -> src/ui/**，逗号分隔或 none>'
  const highRisk = '<高风险路径前缀或文件，逗号分隔>'
  const doNotEdit = '<禁止自动修改的路径，逗号分隔>'

  const anyPlaceholder = [quickTest, fullTest, smokeVerify, mergeGate, archRules, highRisk, doNotEdit]
    .some((v) => /<[^>\n]+>/.test(v))

  return {
    PROFILE_QUICK_TEST: quickTest,
    PROFILE_FULL_TEST: fullTest,
    PROFILE_SMOKE_VERIFY: smokeVerify,
    PROFILE_MERGE_GATE: mergeGate,
    PROFILE_ARCH_RULES: archRules,
    PROFILE_HIGH_RISK: highRisk,
    PROFILE_DO_NOT_EDIT: doNotEdit,
    PROFILE_FILL_HINT: anyPlaceholder
      ? '\n<!-- project-forge: fill Dev Profile：核对并补齐上方 quick-test / full-test / smoke-verify / merge-gate / arch-rules / high-risk / do-not-edit 真实取值后删掉本行 -->'
      : '',
  }
}

export function buildVars(facts, root, { kitDir } = {}) {
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

  const commandPlan = commandPlanOf(facts)
  const hasRemote = Boolean(facts?.git?.remote) && facts?.git?.isRepoRoot !== false
  const customSkills = customSkillsOf(facts)
  const discoveredSkills = protocol.discoverKitSkills(kitDir)

  return {
    PROJECT_NAME: facts.target?.name ?? '这个项目',
    COMMANDS: commandPlan.block,
    COMMANDS_OMITTED: commandsOmittedNote(facts, commandPlan.tooLong),
    EXPLORATION_STRATEGY: explorationStrategyBlock(facts),
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
    KIT_ROUTING_ROWS: renderKitRoutingRows({ customSkills, discoveredSkills, hasRemote }),
    CUSTOM_SKILLS_BLOCK: customSkillsBlock(facts),
    ...buildDevProfileVars(facts, targetRoot),
  }
}
