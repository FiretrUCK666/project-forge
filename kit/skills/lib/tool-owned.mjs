/**
 * tool-owned.mjs —— 哪些路径是「工具自己装进来的」，不是项目自己的东西。
 *
 * ## 它治的病
 *
 * 判据的输入不该包含判据自己的产物。实测出现的两次事故都是这个形状：
 *
 *   - 装套件前 `codeFiles = 40`，装完变 `86`——多出来的 46 个是本工具写进
 *     `.agents/skills/` 的技能源码。规模判据（tier）读了这个数，于是**「先装套件
 *     还是先勘察」决定了这个项目该不该并行探索**。因果是倒的。
 *   - `repo-map` 把 `.agents/skills/` 下的 20 个模块当成「这个项目最值得复用的模块」
 *     推荐出去，项目自己的 92 个源码文件一个都没被认成可复用。
 *
 * ## 为什么不是「逐个排除目录」
 *
 * 逐个排除只解决今天装的那几个。工具以后往项目里写什么，就又多一处要记得排除，
 * 而漏掉的那一处不会报错——它只是悄悄把数字改大。
 *
 * 所以这里换一个方向：**按来源声明归属**。一组路径前缀，声明「这些属于工具」，
 * 规模判据只读剩下的部分。以后工具多写一个位置，在那组前缀里加一行即可；
 * 没加的那些仍然算项目自己的，判断是保守的（宁可高估项目规模，不可低估）。
 */

/**
 * 工具所有权前缀。规模类判据（`codeFiles` / `effectiveFiles` / 行数 / 模块数）
 * 一律不得把它们算进项目自身。
 *
 * `.agents/` 整目录：里面是 `equip.mjs` 写入的受管技能与账本。项目自己的
 * 自有技能也放在这里，它不是「项目源码规模」——它是给 AI 的说明书，不是业务代码。
 */
export const TOOL_OWNED_PREFIXES = Object.freeze([
  '.agents/',
])

/**
 * 工具建的**空骨架**：目录存在不代表项目有内容。
 *
 * 「重入（re-entry）」判的是「这个项目以前被人治理过」，证据必须是**有内容**的
 * 文档，不是三个空目录。实测：只加 `docs/{prd,specs,todo}/.gitkeep` 之后，
 * `isReentryProject` 从 `false` 翻成 `true`，再叠一处误报就改写了探索策略——
 * 三个条件里两个是工具自己造的。
 */
export const TOOL_SKELETON_FILES = Object.freeze([
  'docs/prd/.gitkeep',
  'docs/specs/.gitkeep',
  'docs/todo/.gitkeep',
])

/** 规范化成 posix 相对路径。判据一律按它比，避免 `\` 与 `/` 各说各话。 */
export function normalizeRelPath(rel) {
  return String(rel ?? '').replace(/\\/g, '/').replace(/^\.\//, '')
}

/** 这个相对路径属于工具产物吗。 */
export function isToolOwnedPath(rel) {
  const p = normalizeRelPath(rel)
  if (!p) return false
  return TOOL_OWNED_PREFIXES.some((prefix) => p === prefix.replace(/\/$/, '') || p.startsWith(prefix))
}

/** 这是工具建的空骨架文件吗（`.gitkeep` 一类，存在不代表有内容）。 */
export function isToolSkeletonFile(rel) {
  return TOOL_SKELETON_FILES.includes(normalizeRelPath(rel))
}

/**
 * 「这个目录里有真内容吗」。
 *
 * 判据：里面存在**至少一个**不是 `.gitkeep` 一类空骨架的文件。
 * 只数「文件存不存在」会让工具刚建的空目录冒充「项目已有文档」。
 *
 * @param {string[]} rels 该目录下所有文件的相对路径
 */
export function hasRealContent(rels) {
  return (rels ?? []).some((rel) => {
    const p = normalizeRelPath(rel)
    if (!p) return false
    if (isToolSkeletonFile(p)) return false
    return !p.endsWith('/.gitkeep')
  })
}

/** 从一批相对路径里剔除工具产物，返回项目自身的那部分。 */
export function projectOwnedPaths(rels) {
  return (rels ?? []).filter((rel) => !isToolOwnedPath(rel))
}
