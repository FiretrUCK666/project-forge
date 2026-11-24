/**
 * doc-facts-commands.mjs —— 多生态只读命令识别、SUBCOMMAND_META 变更拦截与 Dev Profile 校验策略。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 `doc-facts.mjs` 与 `doc-verify.mjs` 共用。
 */

import { mutatingSubcommandsFor } from './subcommand-meta.mjs'

/** 识别文档反引号中可能为可核实 CLI 命令的前缀。 */
export const DOC_CMD_RE = /^(?:node|npm|npx|pnpm|yarn|bun|bunx|deno|python|python3|pytest|uv|cargo|go|dotnet|mvn|mvnw|gradle|gradlew|make|just|task|bundle|mix|swift|dart|ctest|meson|cmake|rspec|git)\s+/i

const UNSAFE_SHELL_SYNTAX_RE = /(?:&&|\|\||[;|><`\n]|\$\()/
const UNSAFE_SIDE_EFFECT_RE = /(?:cleanup|--confirm\b|--force\b|--hard\b|--apply\b|--fix\b|--write\b|\brm\s|\bremove\b|\bpush\b|\bdelete\b|\binstall\b|\bpublish\b|\bdeploy\b|\badd\b|\bupgrade\b|\b-e\b|--eval\b|\b-c\b)/i

function escapeAlt(items) {
  return items.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
}

const TOOL_MUTATING_RULES = Object.freeze([
  { scriptRe: /(?:^|[\s/"'])flow\.mjs\s+([a-z0-9-]+)/i, mutating: new Set(mutatingSubcommandsFor('flow')) },
  { scriptRe: /(?:^|[\s/"'])doc-plan\.mjs\s+([a-z0-9-]+)/i, mutating: new Set(mutatingSubcommandsFor('doc-plan')) },
  { scriptRe: /(?:^|[\s/"'])govern-audit\.mjs\s+([a-z0-9-]+)/i, mutating: new Set(mutatingSubcommandsFor('govern-audit')) },
  { scriptRe: /(?:^|[\s/"'])review-pack\.mjs\s+([a-z0-9-]+)/i, mutating: new Set(mutatingSubcommandsFor('review-pack')) },
  { scriptRe: /(?:^|[\s/"'])verify-tools\.mjs\s+([a-z0-9-]+)/i, mutating: new Set(mutatingSubcommandsFor('verify-tools')) },
  { scriptRe: /(?:^|[\s/"'])iterate\.mjs\s+([a-z0-9-]+)/i, mutating: new Set(mutatingSubcommandsFor('iterate')) },
])

/** 判断是否命中内置套件或安装器脚本的状态变更命令。 */
export function isMutatingScaffoldOrKitCommand(cmd) {
  const text = String(cmd ?? '').trim()
  if (/^node\s+[^\n]*(?:equip(?:-ci)?\.mjs|compose-agents\.mjs|update\.mjs)(?!.*(?:--check|--status|--help)\b)/i.test(text)) {
    return true
  }
  if (/^node\s+[^\n]*backup\.mjs(?!\s+(?:list|--help|-h)\b)/i.test(text)) {
    return true
  }
  if (/^node\s+[^\n]*govern-audit\.mjs\b[^\n]*(?:--write-todo|--apply-issues|--save-baseline|--apply-patches|--execute|--loop)/i.test(text)) {
    return true
  }
  if (/^node\s+[^\n]*verify-tools\.mjs\b[^\n]*(?:--apply|--confirm|--promote)/i.test(text)) {
    return true
  }
  if (/^node\s+[^\n]*iterate\.mjs\b[^\n]*--write\b/i.test(text)) {
    return true
  }
  for (const rule of TOOL_MUTATING_RULES) {
    const m = rule.scriptRe.exec(text)
    if (m && rule.mutating.has(m[1].toLowerCase())) return true
  }
  return false
}

function normalizeCmdWhitespace(cmd) {
  return String(cmd ?? '').trim().replace(/\s+/g, ' ')
}

function collectConfiguredReadonlyCommands(profile) {
  const cmds = new Set()
  if (!profile || typeof profile !== 'object') return cmds
  for (const prop of ['quickTest', 'fullTest', 'smokeVerify', 'mergeGate']) {
    const val = profile[prop]
    if (typeof val === 'string' && val.trim() && !/^none$/i.test(val.trim())) {
      cmds.add(normalizeCmdWhitespace(val))
    }
  }
  return cmds
}

const READONLY_GIT_RE = /^git\s+(?:status|log|diff|show|ls-files|rev-parse|describe|symbolic-ref|check-ignore)(?:\s|$)|^git\s+(?:branch|tag)\s+--list(?:\s|$)|^git\s+--version$/i
const SAFE_SCRIPT_SUB_RE = escapeAlt(['test', 'lint', 'typecheck', 'check', 'build', 'verify'])

/**
 * 判定一条命令是否允许作为无副作用文档断言执行。
 *
 * @param {string} cmd
 * @param {object|null} [profile] `parseDevProfile` 返回值
 * @returns {{ allowed: boolean, why?: string }}
 */
export function evaluateReadonlyDocCommand(cmd, profile = null) {
  const clean = normalizeCmdWhitespace(cmd)
  if (!clean) return { allowed: false, why: '空命令，未执行' }
  if (UNSAFE_SHELL_SYNTAX_RE.test(clean)) {
    return { allowed: false, why: '含复合 shell 语法，未执行' }
  }
  if (UNSAFE_SIDE_EFFECT_RE.test(clean)) {
    return { allowed: false, why: '命令带副作用标志，未执行' }
  }
  if (isMutatingScaffoldOrKitCommand(clean)) {
    return { allowed: false, why: '状态变更或写入型子命令，未执行' }
  }

  const configured = collectConfiguredReadonlyCommands(profile)
  if (configured.has(clean)) return { allowed: true }

  if (/^git\s+/i.test(clean)) {
    return READONLY_GIT_RE.test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读 Git 子命令，未执行' }
  }
  if (/^node\s+/i.test(clean)) {
    if (/^node\s+(?:--version|-v|--help|-h)\s*$/i.test(clean)) return { allowed: true }
    if (/^node\s+(?:--check|--test)\s+/i.test(clean)) return { allowed: true }
    if (/^node\s+["']?[^\s"']+\.m?js["']?(?:\s|$)/i.test(clean)) return { allowed: true }
    return { allowed: false, why: '非只读 Node 命令，未执行' }
  }
  if (/^(?:npm|pnpm|yarn|bun)\s+/i.test(clean)) {
    if (new RegExp(`^(?:npm|pnpm|yarn|bun)\\s+(?:--version|-v|test\\b|run\\s+(?:${SAFE_SCRIPT_SUB_RE})\\b)`, 'i').test(clean)) {
      return { allowed: true }
    }
    if (new RegExp(`^(?:pnpm|yarn|bun)\\s+(?:${SAFE_SCRIPT_SUB_RE}|list)\\b`, 'i').test(clean)) {
      return { allowed: true }
    }
    return { allowed: false, why: '包管理命令存在副作用风险，未执行' }
  }
  if (/^deno\s+/i.test(clean)) {
    return new RegExp(`^deno\\s+(?:--version|test|check|lint|info|task\\s+(?:${SAFE_SCRIPT_SUB_RE}))\\b`, 'i').test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读 Deno 命令，未执行' }
  }
  if (/^(?:pytest|python3?)\s+/i.test(clean)) {
    if (/^pytest(?:\s|$)/i.test(clean)) return { allowed: true }
    if (/^python3?\s+(?:--version|-V|-m\s+(?:pytest|unittest|py_compile|mypy|ruff|flake8)(?:\s|$))/i.test(clean)) {
      return { allowed: true }
    }
    return { allowed: false, why: '非只读 Python 命令，未执行' }
  }
  if (/^uv\s+/i.test(clean)) {
    return /^uv\s+(?:--version|version|tree|run\s+(?:pytest|ruff|mypy|python3?\s+-m\s+(?:pytest|unittest|py_compile|mypy|ruff|flake8)))\b/i.test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读 uv 命令，未执行' }
  }
  if (/^cargo\s+/i.test(clean)) {
    return /^cargo\s+(?:--version|test|check|clippy|metadata|tree)\b/i.test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读 Cargo 命令，未执行' }
  }
  if (/^go\s+/i.test(clean)) {
    return /^go\s+(?:version|test|vet|list|env)\b/i.test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读 Go 命令，未执行' }
  }
  if (/^dotnet\s+/i.test(clean)) {
    return /^dotnet\s+(?:--version|--info|test|build|vstest)\b/i.test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读 dotnet 命令，未执行' }
  }
  if (/^(?:\.\/)?(?:mvnw?|gradlew?)\s+/i.test(clean)) {
    return /^(?:\.\/)?(?:mvnw?|gradlew?)\s+(?:--version|test|check|verify|compile|testClasses)\b/i.test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读 JVM 构建命令，未执行' }
  }
  if (/^(?:swift|dart|mix)\s+/i.test(clean)) {
    return /^(?:swift\s+(?:--version|test|build)|dart\s+(?:--version|test|analyze)|mix\s+(?:--version|test|compile))\b/i.test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非只读构建命令，未执行' }
  }
  if (/^(?:ctest(?:\s|$)|meson\s+test\b|bundle\s+exec\s+(?:rspec|rake\s+test)\b)/i.test(clean)) {
    return { allowed: true }
  }
  if (/^(?:make|just|task)\s+/i.test(clean)) {
    return new RegExp(`^(?:make|just|task)\\s+(?:--dry-run|-n|--list|${SAFE_SCRIPT_SUB_RE}|status)\\b`, 'i').test(clean)
      ? { allowed: true }
      : { allowed: false, why: '非白名单任务目标，未执行' }
  }
  return { allowed: false, why: '非只读命令或未在白名单/Dev Profile登记，未执行' }
}
