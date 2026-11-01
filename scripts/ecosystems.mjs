/**
 * ecosystems.mjs —— 声明式生态描述符。
 *
 * 存在的理由只有一个：**加一个生态不该动主引擎。**
 *
 * 在此之前，「DSH 插件」这套知识散在五处：survey 的 detectDsh（一百多行勘察）、
 * compose-agents 的专属事实槽位与兼容性提示、templates 里 8 段 pf:if 专属条件、
 * review 的发布范围检查、以及一份专章。加第二个生态就得把同样的五处再走一遍，
 * 而漏掉任何一处的症状都是**静默的**：该有的段落没出现，没人报错。
 *
 * 现在每个生态是一个对象，写明它怎么被认出来、要额外读什么、给模板补哪些条件。
 * 主引擎只遍历这张表，不认识任何一个具体生态的名字。
 *
 * **描述符里可以出现生态名，主引擎里不可以。** 这条界线就是整个文件的意义。
 */

/**
 * 宿主类生态：被宿主加载的扩展。
 *
 * 它们通常是一种语言项目的**细化**（DSH 插件就是 node 项目），所以不带来第二套命令。
 *
 * 字段：
 *   - `id`            生态标识，与勘察产出的 kind 同名；
 *   - `manifest`      判据所依据的清单文件名；
 *   - `marker`        （可选）清单里必须出现的内容特征，用来区分同名的别的东西；
 *   - `patchFiles`    （可选）承载宿主补丁的文件名候选；
 *   - `publicKeys`    宿主公开给作者写的清单字段；
 *   - `hostInternalKeys` 宿主自己写进清单的内部字段（不算作者的错）；
 *   - `runtimeScopes` / `runtimePackages` 宿主运行时的包名，该在 peer 而非 dependencies；
 *   - `chapter`       专章文件名（不含 .md），与 references/plugins/ 下对应。
 */
export const HOST_ECOSYSTEMS = [
  {
    id: 'dsh-plugin',
    manifest: 'package.json',
    patchFiles: ['cordis.patch.yml', 'cordis.patch.yaml', 'cordis.yml'],
    publicKeys: ['manifestVersion', 'bundle', 'profile', 'client'],
    hostInternalKeys: ['sessionFormatMigration'],
    runtimeScopes: ['@deepseek-ai/'],
    runtimePackages: ['cordis', 'schemastery'],
    chapter: 'dsh',
  },
]

/**
 * 判断这个项目是不是某类宿主生态。
 *
 * 判据一律来自**项目自己的声明**（清单字段或补丁文件），不按目录形状猜。
 * 返回命中的描述符，没有则 undefined。
 */
export function detectHost(descriptors, ctx) {
  for (const d of descriptors) {
    const pkg = ctx.manifest(d.manifest)
    if (pkg !== undefined && typeof pkg === 'object' && pkg !== null) {
      // 清单里有该宿主的字段对象：最直接的声明。字段名取 id 的前缀
      // （`dsh-plugin` → `dsh`），不另开一列——那一列对每一行都一样。
      const field = d.id.split('-')[0]
      if (typeof pkg[field] === 'object' && pkg[field] !== null) return d
    }
    if (Array.isArray(d.patchFiles) && d.patchFiles.some((f) => ctx.exists(f))) return d
  }
  return undefined
}

/**
 * 从清单与文件里提取这类宿主要求的事实。
 *
 * 每个宿主关心的字段不同，所以这段由描述符自己声明；主引擎只把上下文交给它，
 * 拿回一个扁平对象挂到勘察结果的 `host` 字段上。
 */
export function deriveHostFacts(descriptor, ctx) {
  if (descriptor === undefined) return undefined
  const pkg = ctx.manifest(descriptor.manifest)
  if (pkg === undefined || pkg === null || typeof pkg !== 'object') return undefined
  if (pkg.__corrupt === true) return undefined

  const field = descriptor.id.split('-')[0]
  const decl = typeof pkg[field] === 'object' && pkg[field] !== null ? pkg[field] : {}
  const out = { id: descriptor.id }

  // 补丁文件：候选名里第一个存在的。
  const patchFile = Array.isArray(descriptor.patchFiles)
    ? descriptor.patchFiles.find((f) => ctx.exists(f))
    : undefined
  out.patchFile = patchFile

  // 补丁声明与它指向的文件是否真的在。
  const bundleDecl = decl.bundle
  const patchPath = typeof bundleDecl === 'object' && bundleDecl !== null
    && typeof bundleDecl.patch === 'string' ? bundleDecl.patch : undefined
  out.bundlePatch = patchPath === undefined ? undefined
    : { path: patchPath, exists: ctx.exists(patchPath.replace(/^\.\//, '')) }

  // 客户端声明与出口是否对得上。
  out.hasClientDecl = decl.client !== undefined
  const exportsField = pkg.exports
  const hasExport = (key) => (typeof exportsField === 'object' && exportsField !== null
    && Object.prototype.hasOwnProperty.call(exportsField, key))
    || exportsField === key
  out.hasHostEntry = hasExport('.') || typeof pkg.main === 'string'
  out.hasClientEntry = hasExport('./client')

  out.packageName = typeof pkg.name === 'string' ? pkg.name : undefined

  // 未认领的键：可扩展，但要报出来——它不会被校验、也不参与比对。
  // 已知字段分两类，两类都不该报「不认识」：报了是假警报，假警报会让人连真警报一起忽略。
  out.unknownKeys = Object.keys(decl)
    .filter((k) => !descriptor.publicKeys.includes(k) && !descriptor.hostInternalKeys.includes(k))

  // 发现载体：补丁文本里有没有出现包名。只是文本包含，不解析 YAML。
  if (patchFile !== undefined && typeof out.packageName === 'string' && out.packageName.length > 0) {
    const text = ctx.readText(patchFile)
    if (text !== undefined) out.discoveryCarrierLikely = text.includes(out.packageName)
  }

  // 锁定的宿主版本：各依赖段里宿主作用域包的声明值（去重，原样保留范围符号）。
  const scopes = descriptor.runtimeScopes ?? []
  const pkgs = descriptor.runtimePackages ?? []
  const isHostRuntime = (name) => scopes.some((s) => name.startsWith(s)) || pkgs.includes(name)
  out.pinnedVersions = [...new Set(
    ['dependencies', 'devDependencies', 'peerDependencies'].flatMap((k) => {
      const deps = pkg[k]
      if (typeof deps !== 'object' || deps === null) return []
      return Object.entries(deps)
        .filter(([name, range]) => isHostRuntime(name) && typeof range === 'string')
        .map(([, range]) => range)
    }),
  )]

  // 宿主运行时放对位置没有：该在 peer，被打进 dependencies 就会随包发出去。
  const deps = pkg.dependencies
  out.hostRuntimeInDeps = typeof deps === 'object' && deps !== null
    && Object.keys(deps).some(isHostRuntime)

  // 发布范围：files 是否含构建产物与补丁。只做包含判断，不解释语义。
  const filesList = Array.isArray(pkg.files) ? pkg.files.map(String) : []
  out.filesHasLib = filesList.some((f) => /(^|\/)lib(\/|\$)/.test(f) || /^lib/.test(f))
  out.filesHasPatch = patchFile !== undefined && filesList.some((f) => f.includes(patchFile.replace(/\.[^.]+$/, '')))

  out.exportsKeys = typeof exportsField === 'object' && exportsField !== null
    ? Object.keys(exportsField) : []

  // 声明式元数据：只报「有没有」与原文，不解释语义——**声明不等于闸门**，
  // 是否真的强制执行由宿主当前实现决定。
  out.hasManifestVersion = decl.manifestVersion !== undefined

  // 一致性检查：声明与实现对不上时**只报警告，不判失败**。
  // 「补丁声明了但文件不在」「声明了 client 但没有出口」都是**可能**出问题的信号，
  // 不是确定的故障——宿主当前实现未必把这两件事绑死，断死会制造假警报。
  const warnings = []
  if (patchPath !== undefined && out.bundlePatch?.exists === false) {
    warnings.push(`清单声明了补丁路径 ${patchPath}，但该文件不存在`)
  }
  if (out.hasClientDecl === true && out.hasClientEntry !== true) {
    warnings.push(`清单声明了 ${field}.client，但 exports 里没有 ./client 入口`)
  }
  if (out.hasClientDecl !== true && out.hasClientEntry === true) {
    warnings.push(`exports 里有 ./client 入口，但清单没有 ${field}.client 声明`)
  }
  if (out.discoveryCarrierLikely === false) {
    warnings.push('补丁文本里没有出现包名，可能缺发现载体行（name 等于包名自身的那一行）')
  }
  out.warnings = warnings
  // 字段名与勘察结果的历史形状保持一致：改它对调用方是破坏性变更，不在这次改动范围内。
  out.enginesDsh = typeof pkg.engines?.[field] === 'string' ? pkg.engines[field] : undefined
  out.hasIcon = typeof pkg.icon === 'string'

  return out
}
