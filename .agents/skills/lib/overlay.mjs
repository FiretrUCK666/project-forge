/**
 * overlay.mjs —— 跨代双向演化用户扩展层解析、声明式钩子校验与供应链高危载荷扫描。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），统一管理三大合法用户自定义层：
 *   1. `.agents/forge-overlays/` — 局部补充规则、示例片段与覆盖策略；
 *   2. `.agents/extensions/`     — 用户自有领域技能扩展；
 *   3. `.agents/forge-hooks.json` 与 `.githooks/pre-push.local` — 声明式生命周期与本地推送钩子。
 */

import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, posix, resolve } from 'node:path'

import { isMacOsJunkPath, posixPath, readJsonSafe, readTextSafe } from './git.mjs'
import { normalizeRelPath } from './tool-owned.mjs'

export const FORGE_OVERLAYS_REL = '.agents/forge-overlays'
export const FORGE_EXTENSIONS_REL = '.agents/extensions'
export const FORGE_HOOKS_REL = '.agents/forge-hooks.json'
export const LOCAL_PRE_PUSH_REL = '.githooks/pre-push.local'

export const VALID_HOOK_STAGES = Object.freeze([
  'finalize',
  'verify',
  'submit',
  'merge',
  'cleanup',
  'beforeFinalize',
  'afterFinalize',
  'beforeVerify',
  'afterVerify',
  'beforeSubmit',
  'afterSubmit',
  'beforeMerge',
  'afterMerge',
])

const EXTENSION_HAZARD_PATTERNS = [
  { id: 'pipe-to-shell', re: /\b(?:curl|wget|fetch)\b[^\n|]*\|\s*(?:sh|bash|zsh|pwsh|powershell|node|python3?)\b/i, reason: 'Downloads remote payload and pipes directly into shell/interpreter' },
  { id: 'remote-download-exec', re: /\b(?:curl|wget)\b[^\n]*(?:-o|-O|--output)[^\n]*&&[^\n]*(?:sh|bash|chmod\s+\+x|node|python3?)/i, reason: 'Downloads remote binary/script and executes it' },
  { id: 'privilege-escalation', re: /\b(?:sudo|doas|su\s+-|chmod\s+[u+]*s|setuid|pkexec)\b/i, reason: 'Attempts privilege escalation or setuid modification' },
  { id: 'git-bypass-verify', re: /\bgit\s+(?:push|commit)\b[^\n]*(?:--no-verify|--force\b|-f\b)|PF_ALLOW_DIRECT_PUSH\s*=\s*(?:1|true|yes)/i, reason: 'Attempts to bypass git hooks, pre-push guards, or force-push' },
  { id: 'shell-eval-injection', re: /\b(?:eval\s+["'$`]|sh\s+-c\s+["'][^"']*\$\(|bash\s+-c\s+["'][^"']*\$\(|powershell[^\n]*-enc(?:odedcommand)?\b)/i, reason: 'Dynamic command evaluation or encoded shell execution' },
  { id: 'exfil-env-secrets', re: /\b(?:curl|wget|nc|ncat)\b[^\n]*(?:\$GITHUB_TOKEN|\$GH_TOKEN|\$NPM_TOKEN|\$AWS_SECRET|\$\{?SECRET)/i, reason: 'Potential credential exfiltration from environment variables' },
]

/** 判断路径是否属于合法用户扩展槽（仓库相对路径或 `.agents/` 相对路径）。 */
export function isAllowedExtensionPath(relPath) {
  const p = normalizeRelPath(relPath)
  if (!p) return false
  return p === FORGE_OVERLAYS_REL
    || p.startsWith(`${FORGE_OVERLAYS_REL}/`)
    || p === FORGE_EXTENSIONS_REL
    || p.startsWith(`${FORGE_EXTENSIONS_REL}/`)
    || p === FORGE_HOOKS_REL
    || p === LOCAL_PRE_PUSH_REL
    || p.startsWith('forge-overlays/')
    || p.startsWith('extensions/')
    || p === 'forge-hooks.json'
}

/** 读取并列出 `.agents/forge-overlays/` 下的全部合法覆盖片段与策略文件。 */
export function loadForgeOverlays(repoRoot) {
  const root = resolve(repoRoot)
  const dir = join(root, FORGE_OVERLAYS_REL)
  if (!existsSync(dir)) return { present: false, overlays: [] }
  const overlays = []
  const seenReal = new Set()

  const walk = (absDir, relPrefix, depth) => {
    if (depth > 8) return
    let real
    try { real = realpathSync(absDir) } catch { return }
    if (seenReal.has(real)) return
    seenReal.add(real)
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const e of entries) {
      if (isMacOsJunkPath(e.name) || e.name.startsWith('.')) continue
      const abs = join(absDir, e.name)
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        walk(abs, rel, depth + 1)
      } else if (e.isFile()) {
        const ext = posix.extname(e.name).toLowerCase()
        if (!['.md', '.json', '.yml', '.yaml', '.txt'].includes(ext)) continue
        const content = readTextSafe(abs, 256 * 1024) ?? ''
        let parsed = null
        if (ext === '.json') {
          try { parsed = JSON.parse(content) } catch { parsed = null }
        }
        overlays.push({
          id: rel.replace(/\.[^.]+$/, ''),
          path: posixPath(`${FORGE_OVERLAYS_REL}/${rel}`),
          ext,
          bytes: Buffer.byteLength(content, 'utf8'),
          content,
          ...(parsed ? { data: parsed } : {}),
        })
      }
    }
  }
  walk(dir, '', 0)
  return { present: true, overlays }
}

/** 扫描 `.agents/extensions/` 中的用户自有领域扩展技能。 */
export function discoverForgeExtensions(repoRoot) {
  const root = resolve(repoRoot)
  const dir = join(root, FORGE_EXTENSIONS_REL)
  if (!existsSync(dir)) return { present: false, extensions: [] }
  const extensions = []
  const seenReal = new Set()

  const walk = (absDir, relPrefix, depth) => {
    if (depth > 8) return
    let real
    try { real = realpathSync(absDir) } catch { return }
    if (seenReal.has(real)) return
    seenReal.add(real)
    let entries = []
    try { entries = readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)) } catch { return }
    for (const e of entries) {
      if (isMacOsJunkPath(e.name) || e.name.startsWith('.')) continue
      const abs = join(absDir, e.name)
      const rel = relPrefix ? `${relPrefix}/${e.name}` : e.name
      if (e.isDirectory()) {
        const hasSkill = existsSync(join(abs, 'SKILL.md')) || existsSync(join(abs, 'skill.md'))
        if (hasSkill) {
          extensions.push({
            name: e.name,
            path: posixPath(`${FORGE_EXTENSIONS_REL}/${rel}`),
            entry: existsSync(join(abs, 'SKILL.md'))
              ? posixPath(`${FORGE_EXTENSIONS_REL}/${rel}/SKILL.md`)
              : posixPath(`${FORGE_EXTENSIONS_REL}/${rel}/skill.md`),
          })
        } else {
          walk(abs, rel, depth + 1)
        }
      }
    }
  }
  walk(dir, '', 0)
  return { present: true, extensions }
}

/** 校验 `.agents/forge-hooks.json` 声明结构是否合法。 */
export function validateForgeHooksConfig(config) {
  const errors = []
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, errors: ['forge-hooks.json 根节点必须为 JSON 对象'] }
  }
  const checkCmdItem = (item, ctx) => {
    if (typeof item === 'string') {
      if (!item.trim()) errors.push(`${ctx} 不能为空字符串`)
      return
    }
    if (item && typeof item === 'object') {
      if (typeof item.command !== 'string' || !item.command.trim()) {
        errors.push(`${ctx} 必须包含非空 command 字符串`)
      }
      return
    }
    errors.push(`${ctx} 必须为命令字符串或 { command, strict?, enabled? } 对象`)
  }
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {}
  for (const [stage, entry] of Object.entries(hooks)) {
    if (typeof entry === 'boolean' || entry === null) continue
    if (Array.isArray(entry)) {
      entry.forEach((it, idx) => checkCmdItem(it, `hooks.${stage}[${idx}]`))
    } else if (typeof entry === 'object') {
      if (entry.commands !== undefined) {
        if (!Array.isArray(entry.commands)) errors.push(`hooks.${stage}.commands 必须为数组`)
        else entry.commands.forEach((it, idx) => checkCmdItem(it, `hooks.${stage}.commands[${idx}]`))
      }
      if (entry.command !== undefined && (typeof entry.command !== 'string' || !entry.command.trim())) {
        errors.push(`hooks.${stage}.command 必须为非空字符串`)
      }
    } else if (typeof entry === 'string') {
      if (!entry.trim()) errors.push(`hooks.${stage} 不能为空`)
    } else {
      errors.push(`hooks.${stage} 类型无效`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/** 读取并校验 `.agents/forge-hooks.json`（按 `implRoot` 优先回退 `mainRoot`）。 */
export function loadForgeHooksConfig(mainRoot, implRoot = null) {
  for (const root of [implRoot, mainRoot].filter(Boolean)) {
    const abs = join(root, FORGE_HOOKS_REL)
    if (!existsSync(abs)) continue
    const parsed = readJsonSafe(abs)
    if (!parsed || typeof parsed !== 'object') {
      return { path: abs, valid: false, config: null, errors: ['forge-hooks.json 不是有效 JSON 对象'] }
    }
    const validation = validateForgeHooksConfig(parsed)
    return { path: abs, valid: validation.ok, config: parsed, errors: validation.errors }
  }
  return null
}

/** 提取指定生命周期阶段在 `.agents/forge-hooks.json` 中声明的自定义可执行钩子列表。 */
export function resolveStageHookCommands(config, stage) {
  if (!config || typeof config !== 'object') return []
  const stageKeys = [
    stage,
    `before${stage.charAt(0).toUpperCase()}${stage.slice(1)}`,
    `after${stage.charAt(0).toUpperCase()}${stage.slice(1)}`,
  ]
  const out = []
  const hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {}
  for (const key of stageKeys) {
    const raw = hooks[key] ?? config[key]
    if (!raw || raw === false) continue
    if (typeof raw === 'string' && raw.trim()) {
      out.push({ stageKey: key, command: raw.trim(), strict: false })
    } else if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === 'string' && item.trim()) {
          out.push({ stageKey: key, command: item.trim(), strict: false })
        } else if (item && typeof item === 'object' && item.enabled !== false && typeof item.command === 'string' && item.command.trim()) {
          out.push({ stageKey: key, command: item.command.trim(), strict: Boolean(item.strict) })
        }
      }
    } else if (typeof raw === 'object' && raw.enabled !== false) {
      if (typeof raw.command === 'string' && raw.command.trim()) {
        out.push({ stageKey: key, command: raw.command.trim(), strict: Boolean(raw.strict) })
      }
      if (Array.isArray(raw.commands)) {
        for (const item of raw.commands) {
          if (typeof item === 'string' && item.trim()) {
            out.push({ stageKey: key, command: item.trim(), strict: Boolean(raw.strict) })
          } else if (item && typeof item === 'object' && item.enabled !== false && typeof item.command === 'string' && item.command.trim()) {
            out.push({ stageKey: key, command: item.command.trim(), strict: Boolean(item.strict ?? raw.strict) })
          }
        }
      }
    }
  }
  return out
}

/** 静态扫描用户扩展槽载荷中的高危供应链/提权/绕过命令模式（供 untrusted-scan 与钩子执行前守卫复用）。 */
export function scanExtensionSlotHazards(fileRel, text) {
  const rel = normalizeRelPath(fileRel)
  const content = String(text ?? '')
  const hits = []
  for (const rule of EXTENSION_HAZARD_PATTERNS) {
    const m = rule.re.exec(content)
    if (m) {
      hits.push({
        ruleId: rule.id,
        file: rel,
        reason: rule.reason,
        sample: m[0].slice(0, 120),
      })
    }
  }
  return hits
}

/** 检查 `.githooks/pre-push.local` 状态。 */
export function inspectLocalPrePushHook(repoRoot) {
  const abs = join(resolve(repoRoot), LOCAL_PRE_PUSH_REL)
  if (!existsSync(abs)) return { present: false, path: LOCAL_PRE_PUSH_REL, hazards: [] }
  let isFile = false
  try { isFile = statSync(abs).isFile() } catch { isFile = false }
  if (!isFile) return { present: false, path: LOCAL_PRE_PUSH_REL, hazards: [] }
  const content = readTextSafe(abs, 128 * 1024) ?? ''
  return {
    present: true,
    path: LOCAL_PRE_PUSH_REL,
    hazards: scanExtensionSlotHazards(LOCAL_PRE_PUSH_REL, content),
  }
}
