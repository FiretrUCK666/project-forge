/**
 * tool-owned.mjs —— 工具严格托管的核心路径与用户合法扩展槽归属声明。
 *
 * 规模类判据（`codeFiles` / `effectiveFiles` / 行数 / 模块数）与可复用模块扫描
 * 只过滤工具自身托管的核心技能与运行库，正式放开同目录下用户自定义资产与扩展槽。
 */

/**
 * 工具严格托管的核心路径前缀（8 个内置技能、`lib/`、`templates/` 与清单账本）。
 * 用户自定义扩展（`.agents/forge-overlays/`、`.agents/extensions/`、`.agents/forge-hooks.json`
 * 及 `.agents/skills/<custom>/`）归项目自身所有，不再被误判为工具托管产物。
 */
export const TOOL_OWNED_PREFIXES = Object.freeze([
  '.agents/skills/dev-explore/',
  '.agents/skills/dev-plan/',
  '.agents/skills/dev-edit/',
  '.agents/skills/dev-flow/',
  '.agents/skills/dev-verify-tools/',
  '.agents/skills/dev-review/',
  '.agents/skills/dev-iterate/',
  '.agents/skills/dev-govern/',
  '.agents/skills/lib/',
  '.agents/skills/templates/',
  '.agents/skills/.pf-manifest.json',
])

/** 用户合法扩展槽路径前缀（由 `equip`、`govern-checks` 豁免，并由 `review-diff` 纳入供应链扫描）。 */
export const USER_EXTENSION_SLOTS = Object.freeze([
  '.agents/forge-overlays/',
  '.agents/extensions/',
  '.agents/forge-hooks.json',
  '.githooks/pre-push.local',
])

/** 工具建的空骨架文件：目录存在不代表项目有真实内容。 */
export const TOOL_SKELETON_FILES = Object.freeze([
  'docs/prd/.gitkeep',
  'docs/specs/.gitkeep',
  'docs/todo/.gitkeep',
])

/** 规范化成 posix 相对路径。 */
export function normalizeRelPath(rel) {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 这个相对路径属于工具严格托管的核心产物吗。 */
export function isToolOwnedPath(rel) {
  const p = normalizeRelPath(rel)
  if (!p) return false
  return TOOL_OWNED_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix))
}

/** 这个相对路径属于用户声明式扩展槽（overlay / extension / forge-hooks / pre-push.local）吗。 */
export function isUserExtensionSlot(rel) {
  const p = normalizeRelPath(rel)
  if (!p) return false
  return USER_EXTENSION_SLOTS.some((slot) => p === slot.replace(/\/$/, '') || p.startsWith(slot))
}

/** 这是工具建的空骨架文件吗（`.gitkeep` 一类，存在不代表有内容）。 */
export function isToolSkeletonFile(rel) {
  return TOOL_SKELETON_FILES.includes(normalizeRelPath(rel))
}

/** 「这个目录里有真内容吗」：存在至少一个非 `.gitkeep` 的文件。 */
export function hasRealContent(rels) {
  return (rels ?? []).some((rel) => {
    const p = normalizeRelPath(rel)
    if (!p) return false
    if (isToolSkeletonFile(p)) return false
    return !p.endsWith('/.gitkeep')
  })
}

/** 从一批相对路径里剔除工具核心产物，返回项目自身的那部分。 */
export function projectOwnedPaths(rels) {
  return (rels ?? []).filter((rel) => !isToolOwnedPath(rel))
}
