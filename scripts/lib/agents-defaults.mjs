/**
 * agents-defaults.mjs —— AGENTS.md 模板变量计算、命令折叠、探索策略与 Dev Profile 智能预填。
 *
 * 从 scripts/compose-agents.mjs 拆出以控制主模块体量；仅依赖 node:* 内置模块与同层 lib/。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { hasDotGitInAncestors } from '../../kit/skills/lib/git-fast.mjs'
import { DEFAULT_HIGH_RISK_PATHS, defaultHighRiskPaths } from '../../kit/skills/lib/profile.mjs'
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

const SUBDIR_CMD_AGGREGATE_THRESHOLD = 6
const COMMANDS_BLOCK_MAX_BYTES = 4096

function renderEcoBucket(header, bucket, kindTag, sources, skipped) {
  const pairs = COMMAND_ORDER
    .map((key) => [key, bucket?.[key]])
    .filter(([, value]) => typeof value === 'string' && value.trim())
  const lines = [header]
  const rendered = []
  const omittedHere = []
  for (const [key, value] of pairs) {
    const text = `${value}  # ${COMMAND_LABEL[key]}`
    if (Buffer.byteLength(text, 'utf8') > INLINE_COMMAND_MAX_BYTES) {
      omittedHere.push({ text: value, kind: kindTag, label: COMMAND_LABEL[key], source: sources[key] })
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
    lines.push(`# ${kindTag} 的命令都太长，见本节下方「去哪看」`)
  }
  return lines
}

export function commandsBlock(facts) {
  const byEco = facts.commandsByEcosystem ?? {}
  const sources = facts.commandSources ?? {}
  const kinds = Object.keys(byEco).filter((k) => COMMAND_ORDER.some((key) => byEco[k]?.[key]))

  if (kinds.length > 1) {
    const blocks = []
    const skipped = []
    const rootKinds = kinds.filter((k) => !k.includes('/'))
    const subdirKinds = kinds.filter((k) => k.includes('/'))
    const shouldAggregateSubdirs = subdirKinds.length > SUBDIR_CMD_AGGREGATE_THRESHOLD

    for (const kind of (shouldAggregateSubdirs ? rootKinds : kinds)) {
      blocks.push(renderEcoBucket(`# --- ${kind} ---`, byEco[kind], kind, sources, skipped).join('\n'))
    }

    if (shouldAggregateSubdirs) {
      const groups = new Map()
      for (const dir of subdirKinds) {
        const top = dir.split('/')[0] || dir
        if (!groups.has(top)) groups.set(top, [])
        groups.get(top).push(dir)
      }
      for (const [top, dirs] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (dirs.length === 1) {
          blocks.push(renderEcoBucket(`# --- ${dirs[0]} ---`, byEco[dirs[0]], dirs[0], sources, skipped).join('\n'))
          continue
        }
        const rep = dirs[0]
        const lines = renderEcoBucket(`# --- ${top}/*（共 ${dirs.length} 个子包，示例 ${rep}） ---`, byEco[rep], top, sources, skipped)
        lines.push(`# 其余 ${dirs.length - 1} 个 ${top}/* 子包按各自清单命令运行`)
        blocks.push(lines.join('\n'))
      }
    }

    let combined = blocks.join('\n\n')
    if (shouldAggregateSubdirs && Buffer.byteLength(combined, 'utf8') > COMMANDS_BLOCK_MAX_BYTES) {
      const compact = []
      for (const kind of rootKinds) {
        compact.push(renderEcoBucket(`# --- ${kind} ---`, byEco[kind], kind, sources, []).join('\n'))
      }
      if (subdirKinds.length > 0) {
        const groups = new Map()
        for (const dir of subdirKinds) {
          const top = dir.split('/')[0] || dir
          groups.set(top, (groups.get(top) ?? 0) + 1)
        }
        compact.push([
          `# --- 子包聚合（共 ${subdirKinds.length} 个） ---`,
          ...[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([t, n]) => `# ${t}/*：${n} 个子包（命令见各子包清单）`),
        ].join('\n'))
      }
      combined = compact.join('\n\n')
    }
    return { block: combined, tooLong: skipped }
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

/** 探测仓库中受 Git 跟踪的 `dist/` / `build/` 构建产物路径，避免将其错误归入 `do-not-edit`。 */
export function detectTrackedBuildArtifacts(facts, targetRoot) {
  const trackedFiles = []
  if (Array.isArray(facts?.git?.trackedPaths)) {
    for (const raw of facts.git.trackedPaths) {
      const p = String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
      if (p.startsWith('dist/') || p.startsWith('build/')) trackedFiles.push(p)
    }
  } else if (targetRoot && (existsSync(join(targetRoot, '.git')) || hasDotGitInAncestors(targetRoot))) {
    const res = spawnSync('git', ['-c', 'core.quotepath=false', '--no-optional-locks', 'ls-files', '-z', '--', 'dist', 'build'], {
      cwd: targetRoot, encoding: 'utf8', timeout: 3000, windowsHide: true,
    })
    if (res.status === 0 && res.stdout) {
      for (const raw of res.stdout.split('\0')) {
        const p = String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
        if (p.startsWith('dist/') || p.startsWith('build/')) trackedFiles.push(p)
      }
    }
  }
  const dirs = []
  if (trackedFiles.some((f) => f.startsWith('dist/'))) dirs.push('dist/')
  if (trackedFiles.some((f) => f.startsWith('build/'))) dirs.push('build/')
  return { dirs, files: trackedFiles }
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
  const trackedBuild = detectTrackedBuildArtifacts(facts, targetRoot)
  const plan = commandPlanOf(facts ?? {})
  const hasCommands = plan.block.trim().length > 0
    || COMMAND_ORDER.some((k) => typeof cmds[k] === 'string' && cmds[k].trim())
    || Boolean(cmds.check || cmds.smoke)
  const hasCodeManifests = manifests.length > 0 || (facts?.scale?.codeFiles ?? 0) > 0 || kinds.some((k) => k && k !== 'docs-only' && k !== 'empty' && k !== 'unknown')

  if (!hasCommands && !hasCodeManifests) {
    const hasGithub = Boolean(targetRoot && existsSync(join(targetRoot, '.github')))
      || (Array.isArray(facts?.docs?.workflows) && facts.docs.workflows.length > 0)
    const baseHighRisk = hasGithub ? [...DEFAULT_HIGH_RISK_PATHS] : ['AGENTS.md', '.gitattributes']
    for (const bd of trackedBuild.dirs) if (!baseHighRisk.includes(bd)) baseHighRisk.push(bd)
    return {
      PROFILE_QUICK_TEST: 'none',
      PROFILE_FULL_TEST: 'none',
      PROFILE_SMOKE_VERIFY: 'none',
      PROFILE_MERGE_GATE: 'none',
      PROFILE_ARCH_RULES: 'none',
      PROFILE_HIGH_RISK: baseHighRisk.join(', '),
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
  const highRisk = trackedBuild.dirs.length > 0
    ? [...defaultHighRiskPaths(targetRoot), ...trackedBuild.dirs].join(', ')
    : '<高风险路径前缀或文件，逗号分隔>'
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

function formatWorkspacePackages(packages) {
  if (!Array.isArray(packages) || packages.length === 0) return '各子包'
  if (packages.length <= 12) return packages.map((p) => `\`${p}\``).join('、')
  const byTop = new Map()
  for (const p of packages) {
    const top = String(p).split('/')[0] || p
    byTop.set(top, (byTop.get(top) ?? 0) + 1)
  }
  return [...byTop.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([top, cnt]) => (cnt > 1 ? `\`${top}/*\`（${cnt} 个）` : `\`${top}\``))
    .join('、')
}

export function buildVars(facts, root, { kitDir } = {}) {
  const conventions = facts.conventions ?? {}
  const releaseNotesTarget = conventions.releaseNotesMode === 'changelog'
    ? 'CHANGELOG.md 的对应版本节'
    : 'docs/release-notes/<标签>.md'
  const readmes = facts.docs?.readmes ?? []
  const subdirAgents = facts.docs?.subdirAgentsFiles ?? []
  const packages = facts.workspace?.packages ?? []
  const targetRoot = root || facts.target?.path
  const legacyWorkExists = Boolean(targetRoot && existsSync(join(targetRoot, 'docs', 'work')) && !existsSync(join(targetRoot, 'docs', 'todo')))
  const resolvedWorkDir = conventions.workDir && conventions.workDir !== 'docs/work'
    ? conventions.workDir
    : (legacyWorkExists ? 'docs/work' : 'docs/todo')

  const commandPlan = commandPlanOf(facts)
  const hasRemote = Boolean(facts?.git?.remote) && facts?.git?.isRepoRoot !== false && !facts?.git?.localMode
  const customSkills = customSkillsOf(facts)
  const discoveredSkills = protocol.discoverKitSkills(kitDir)

  return {
    PROJECT_NAME: facts.target?.name ?? '这个项目',
    COMMANDS: commandPlan.block,
    COMMANDS_OMITTED: commandsOmittedNote(facts, commandPlan.tooLong),
    EXPLORATION_STRATEGY: explorationStrategyBlock(facts),
    RUNTIME_REQUIREMENTS: (facts.artifacts?.runtimeRequirements ?? []).join('、') || '见清单文件声明',
    DEFAULT_BRANCH: conventions.defaultBranch || 'main',
    VERSION_SOURCE: facts.ecosystem?.versionSource ?? facts.ecosystem?.manifests?.[0] ?? '清单文件',
    RELEASING_DOC: facts.docs?.releasing ?? 'RELEASING.md',
    RELEASE_NOTES_TARGET: releaseNotesTarget,
    WORK_DIR: `${resolvedWorkDir}/`,
    COMMIT_STYLE_HINT: commitStyleHint(facts),
    README_LIST: readmes.length > 0 ? readmes.map((r) => `\`${r}\``).join('、') : '`README.md`',
    SUBDIR_AGENTS_POINTER: subdirAgents.length > 0 ? subdirAgents.map((f) => `\`${f}\``).join('、') : '`<subdir>/AGENTS.md`',
    WORKSPACE_PACKAGES: formatWorkspacePackages(packages),
    KIT_ROUTING_ROWS: renderKitRoutingRows({ customSkills, discoveredSkills, hasRemote }),
    CUSTOM_SKILLS_BLOCK: customSkillsBlock(facts),
    ...buildDevProfileVars(facts, targetRoot),
  }
}
