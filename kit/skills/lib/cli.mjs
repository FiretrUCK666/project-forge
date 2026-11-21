/**
 * cli.mjs —— 内置研发技能套件统一的 CLI 参数解析、动态技能探测与降级导航输出。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 kit/skills/ 下全部脚本共用。
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { discoverKitSkills } from './skill-discovery.mjs'

export function getKnownKitSkills(kitDir) {
  return Object.freeze(discoverKitSkills(kitDir).map((s) => s.dirName))
}

/** 各技能声明的降级文案。正文生成与提示段共用这一份，避免两处各写一套。 */
export function getSkillFallbacks(kitDir) {
  const map = new Map()
  for (const s of discoverKitSkills(kitDir)) {
    if (s.fallback) map.set(s.dirName, s.fallback)
  }
  return map
}

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
 * 用于裁剪/降级 `[NEXT STEP]` 指引，兼容用户手动删减或禁用技能场景。
 */
export function resolveAvailableSkills(repoRoot = process.cwd(), { kitDir } = {}) {
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
    knownKitSkills: getKnownKitSkills(kitDir),
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

/**
 * 判断仓库是否支持指定内置技能：
 * - 若未装配 `.agents/skills/` 目录（`hasSkillsDir === false`），按默认完整基线兼容返回 `true`；
 * - 若已显式装配 `.agents/skills/`，则仅当目标技能真实存在时返回 `true`。
 */
export function hasSkillSupport(repoRoot = process.cwd(), skillName = 'dev-review') {
  const info = resolveAvailableSkills(repoRoot)
  if (!info.hasSkillsDir) return true
  return info.has(skillName)
}

/**
 * 把一行里指向未装配技能的命令降级成通用做法。
 *
 * 只做「字符串进、字符串出」，因为它要服务的两边形态不同：`printNextStep` 拿到的是
 * 结构化 step item，正文生成拿到的是拼好的整行字符串。两边各写一套判定，迟早分叉——
 * 而分叉的表现就是「提示降级了、正文没降」，那正是这条判据要治的病。
 *
 * 降级不是「把话说少」：替换结果必须仍指向一个可执行的动作类别。
 */
export function degradeSkillCommands(line, skillsInfo, fallbackMap = new Map()) {
  const text = String(line ?? '').trim()
  if (!text || !skillsInfo) return text
  const m = /\.agents\/skills\/([a-z0-9._-]+)\//i.exec(text)
  if (!m || skillsInfo.has(m[1])) return text
  return fallbackMap.get(m[1])
    ?? text.replace(/node\s+["']?\.agents\/skills\/[^"'\s]+["']?[^\n]*/g, '按原生 git 与项目测试流程手动执行')
}

function formatStepItem(item, skillsInfo, fallbackMap) {
  if (item && typeof item === 'object') {
    const skill = item.skill
    const text = String(item.text ?? '').trim()
    const defaultFb = skill ? `按原生 git 与项目流程手动执行（未装配 ${skill} 技能）` : text
    const fallback = String(item.fallback ?? fallbackMap.get(skill) ?? defaultFb).trim()
    if (skill && skillsInfo && !skillsInfo.has(skill)) {
      return fallback
    }
    return text
  }

  return degradeSkillCommands(String(item ?? ''), skillsInfo, fallbackMap)
}

/**
 * 在每个 CLI 输出末尾打印清晰的下一步唯一合法动作卡片。
 * 当传入 repoRoot 或 availableSkills 时，对缺失的兄弟技能自动降级为纯 Git / 人工指令。
 */
export function printNextStep(lines, { jsonMode = false, repoRoot, availableSkills, kitDir } = {}) {
  if (jsonMode) return
  const skillsInfo = availableSkills ?? (repoRoot ? resolveAvailableSkills(repoRoot, { kitDir }) : null)
  const fallbackMap = getSkillFallbacks(kitDir)
  const rawItems = Array.isArray(lines) ? lines : [lines]
  const rendered = []
  for (const item of rawItems) {
    if (!item) continue
    const line = formatStepItem(item, skillsInfo, fallbackMap)
    if (line && !rendered.includes(line)) rendered.push(line)
  }
  if (rendered.length === 0) return
  process.stdout.write('\n[NEXT STEP]\n')
  for (const line of rendered) {
    process.stdout.write(`  - ${line}\n`)
  }
}

function flushWritable(stream) {
  if (!stream || stream.destroyed || stream.writableEnded || stream.writableFinished || !stream.writable) {
    return Promise.resolve()
  }
  return new Promise((done) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      done()
    }
    const timer = setTimeout(finish, 2000)
    timer.unref?.()
    try {
      stream.write('', finish)
    } catch {
      finish()
    }
  })
}

/**
 * 在退出前显式排空 stdout 与 stderr 写入缓冲区（防止 macOS Node 18 并发管道截断大 JSON），
 * 随后调用 `process.exit(code)` 防止残留句柄导致子进程无限挂起。
 */
export async function flushAndExit(code = 0) {
  const exitCode = Number.isInteger(code) ? code : 0
  await Promise.all([flushWritable(process.stdout), flushWritable(process.stderr)])
  process.exit(exitCode)
}
