/**
 * cli.mjs —— 五套研发技能统一的 CLI 参数解析、动态技能探测与降级导航输出。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 kit/skills/ 下全部脚本共用。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const KNOWN_KIT_SKILLS = Object.freeze([
  'dev-explore',
  'dev-plan',
  'dev-flow',
  'dev-review',
  'dev-govern',
])

function toSet(list) {
  if (!list) return new Set()
  return list instanceof Set ? new Set(list) : new Set(list)
}

function parseBooleanValue(flagName, raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (v === '' || v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  throw new Error(`布尔选项 --${flagName} 不支持参数值「${raw}」（仅允许 true | false）`)
}

/**
 * 统一标准 CLI 参数解析器：
 *   - 同时支持位置目标目录、`--dir`、`--repo` 与 `--k=v`；
 *   - 布尔标志支持 `--flag` 与 `--flag=true|false`；
 *   - 未知 flag 立刻抛出错误，绝不静默吞掉后续位置参数；
 *   - 任何位置传 `--help` / `-h` 均不因缺少参数报错，交给调用方输出帮助。
 */
export function parseStandardCli(argv = [], schema = {}) {
  const args = Array.isArray(argv) ? argv : []
  const subcommands = schema.subcommands ? [...schema.subcommands] : null
  const booleanFlags = toSet(['help', 'json', ...(schema.booleanFlags ?? [])])
  const valueFlags = toSet(['dir', 'repo', ...(schema.valueFlags ?? [])])
  const multiFlags = toSet(schema.multiFlags ?? [])
  const aliases = { h: 'help', repo: 'dir', ...(schema.aliases ?? {}) }
  const strict = schema.strict !== false

  let sub = null
  let startIdx = 0
  if (subcommands && args.length > 0 && !String(args[0]).startsWith('-')) {
    if (subcommands.includes(args[0])) {
      sub = args[0]
      startIdx = 1
    } else if (!schema.allowPositionalWithoutSubcommand) {
      sub = args[0]
      startIdx = 1
    }
  }

  const opts = { _: [] }
  for (const mf of multiFlags) opts[mf] = []

  const setOpt = (key, val, isMulti) => {
    if (isMulti) {
      if (!Array.isArray(opts[key])) opts[key] = []
      opts[key].push(val)
    } else {
      opts[key] = val
    }
  }

  let endOfFlags = false
  for (let i = startIdx; i < args.length; i += 1) {
    const raw = String(args[i])
    if (endOfFlags) {
      opts._.push(raw)
      continue
    }
    if (raw === '--') {
      endOfFlags = true
      continue
    }
    if (raw === '-h') {
      opts.help = true
      continue
    }
    if (!raw.startsWith('-')) {
      opts._.push(raw)
      continue
    }
    if (!raw.startsWith('--')) {
      throw new Error(`未知短参数：${raw}（请使用 --help 查看可用选项）`)
    }

    const eq = raw.indexOf('=')
    const rawKey = eq > 0 ? raw.slice(2, eq) : raw.slice(2)
    const canonicalKey = aliases[rawKey] ?? rawKey
    const hasInlineVal = eq > 0
    const inlineVal = hasInlineVal ? raw.slice(eq + 1) : undefined

    if (booleanFlags.has(canonicalKey) || booleanFlags.has(rawKey)) {
      const targetKey = booleanFlags.has(canonicalKey) ? canonicalKey : rawKey
      opts[targetKey] = hasInlineVal ? parseBooleanValue(rawKey, inlineVal) : true
      continue
    }

    const isMulti = multiFlags.has(canonicalKey) || multiFlags.has(rawKey)
    const isVal = isMulti || valueFlags.has(canonicalKey) || valueFlags.has(rawKey)
    if (isVal) {
      const targetKey = (valueFlags.has(canonicalKey) || multiFlags.has(canonicalKey)) ? canonicalKey : rawKey
      if (hasInlineVal) {
        setOpt(targetKey, inlineVal, isMulti)
      } else {
        if (i + 1 >= args.length) {
          throw new Error(`选项 --${rawKey} 缺少参数值`)
        }
        i += 1
        setOpt(targetKey, String(args[i]), isMulti)
      }
      continue
    }

    if (!strict) {
      if (hasInlineVal) {
        opts[canonicalKey] = inlineVal
      } else if (i + 1 < args.length && !String(args[i + 1]).startsWith('--')) {
        i += 1
        opts[canonicalKey] = String(args[i])
      } else {
        opts[canonicalKey] = true
      }
      continue
    }

    const hint = schema.usageHint ? `；${schema.usageHint}` : ''
    throw new Error(`未知参数：--${rawKey}（使用 --help 查看支持选项${hint}）`)
  }

  let targetDir = process.cwd()
  if (opts.dir !== undefined && String(opts.dir).trim() !== '') {
    targetDir = resolve(String(opts.dir))
  } else if (schema.positionalDir === 'first' && opts._.length > 0) {
    targetDir = resolve(String(opts._[0]))
  } else if (schema.positionalDir === 'auto' && opts._.length > 0) {
    const cand = resolve(String(opts._[0]))
    try {
      if (existsSync(cand) && statSync(cand).isDirectory()) targetDir = cand
    } catch { /* 保持 process.cwd() */ }
  }

  return {
    sub,
    opts,
    flags: opts,
    positionals: opts._,
    _: opts._,
    targetDir,
    help: Boolean(opts.help),
    json: Boolean(opts.json),
  }
}

/**
 * 现场探测目标仓库 `.agents/skills/` 下实际已装配的技能目录，
 * 用于裁剪/降级 `[NEXT STEP]` 指引，兼容 lightweight 档与用户手动删减技能场景。
 */
export function resolveAvailableSkills(repoRoot = process.cwd()) {
  const skillsDir = join(resolve(repoRoot), '.agents', 'skills')
  const available = new Set()
  let hasSkillsDir = false

  if (existsSync(skillsDir)) {
    try {
      if (statSync(skillsDir).isDirectory()) {
        hasSkillsDir = true
        for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
          const entryDir = join(skillsDir, entry.name)
          if (existsSync(join(entryDir, 'SKILL.md')) || existsSync(join(entryDir, 'scripts'))) {
            available.add(entry.name)
          }
        }
      }
    } catch { /* 读取受限时按空集合降级 */ }
  }

  return {
    hasSkillsDir,
    skillsDir,
    skills: [...available].sort(),
    available,
    knownKitSkills: KNOWN_KIT_SKILLS,
    has(skillName) {
      return available.has(skillName)
    },
    scriptPath(skillName, scriptRel) {
      if (!available.has(skillName)) return null
      const rel = String(scriptRel ?? '').replace(/^\/+/, '')
      return `.agents/skills/${skillName}/${rel}`
    },
  }
}

const DEFAULT_SKILL_FALLBACKS = Object.freeze({
  'dev-explore': '手工查看项目清单、CI 工作流与入口源码（未装配 dev-explore 技能）',
  'dev-plan': '按改动影响面人工分级（L3 改契约先写 docs/specs/ 与 docs/todo/，完成后用 git mv 归档；未装配 dev-plan 技能）',
  'dev-flow': '用原生 git switch -c <branch> 隔离改动并运行项目本地测试验证后再提交（未装配 dev-flow 技能）',
  'dev-review': '由独立上下文审查者核对 git diff 与本地测试实证，确认无误后再推进合入（未装配 dev-review 技能）',
  'dev-govern': '手工运行项目测试与 git status / git worktree list 检查工作区干净状态（未装配 dev-govern 技能）',
})

function formatStepItem(item, skillsInfo) {
  if (item && typeof item === 'object') {
    const skill = item.skill
    const text = String(item.text ?? '').trim()
    const fallback = String(item.fallback ?? DEFAULT_SKILL_FALLBACKS[skill] ?? text).trim()
    if (skill && skillsInfo && !skillsInfo.has(skill)) {
      return fallback
    }
    return text
  }

  const line = String(item ?? '').trim()
  if (!line || !skillsInfo) return line

  const m = /\.agents\/skills\/([a-z0-9-]+)\//i.exec(line)
  if (m && !skillsInfo.has(m[1])) {
    return DEFAULT_SKILL_FALLBACKS[m[1]] ?? line.replace(/node\s+["']?\.agents\/skills\/[^"'\s]+["']?[^\n]*/g, '按原生 git 与项目测试流程手动执行')
  }
  return line
}

/**
 * 在每个 CLI 输出末尾打印清晰的下一步唯一合法动作卡片。
 * 当传入 repoRoot 或 availableSkills 时，对缺失的兄弟技能自动降级为纯 Git / 人工指令。
 */
export function printNextStep(lines, { jsonMode = false, repoRoot, availableSkills } = {}) {
  if (jsonMode) return
  const skillsInfo = availableSkills ?? (repoRoot ? resolveAvailableSkills(repoRoot) : null)
  const rawItems = Array.isArray(lines) ? lines : [lines]
  const rendered = []
  for (const item of rawItems) {
    if (!item) continue
    const line = formatStepItem(item, skillsInfo)
    if (line && !rendered.includes(line)) rendered.push(line)
  }
  if (rendered.length === 0) return
  process.stdout.write('\n[NEXT STEP]\n')
  for (const line of rendered) {
    process.stdout.write(`  - ${line}\n`)
  }
}
