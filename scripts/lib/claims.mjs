/**
 * claims.mjs —— 契约回查：已经写进项目里的那句话，现在还成立吗。
 *
 * ## 它治的病
 *
 * `compose-agents.mjs` 把项目事实渲染进 `AGENTS.md` 之后，那些字就成了**死文字**。
 * 项目换了默认分支、删了脚本、搬了工作记录目录，契约仍然写着旧值——**没有任何门禁看得见**。
 * 表现不是报错，是后来的人照着契约跑，得到「命令不存在」「文件不存在」。
 *
 * `compose-agents --check` 看不出这一种：它比的是「这份文件与**这次渲染**是否一致」，
 * 而渲染用的还是同一批事实，两边一起错，比出来的结果是「一致」。
 *
 * 所以这里换一个方向：**从已写下的文字里读出它承诺了什么，再拿项目现状去核对。**
 *
 * ## 为什么按形状判，不按清单判
 *
 * 逐项清单（默认分支、工作目录、版本来源、发布说明、运行环境……）每加一种契约就要加一段
 * 代码，而漏掉的那一段不会有人发现。这里只认**会失效的形状**，两条：
 *
 *   - 文中的仓库内路径 → 它得真的在；
 *   - 文中的分支名 → 它得就是现在那个默认分支。
 *
 * 这两条覆盖的正是「项目变了而契约没变」这一类：换分支、删脚本、搬目录。新增一种契约时，
 * 只要它写成路径或分支，就自动被覆盖，不用改这里。
 *
 * 不判命令：一条写对的命令与一条写错的命令在文本上长得一样，要判就得**真的执行它**，
 * 而交付体检不该跑用户项目的构建。那一层由项目自己的门禁负责。
 */

/** 当成路径看的后缀。**刻意不含 `.md`**：文档之间互相引用的 `.md` 由 `preflight` 的引用
 *  核对负责，两套判据都管同一件事时会给出两个答案。 */
const PATH_EXT = /\.(?:mjs|cjs|js|ts|py|sh|ps1|rs|go|java|json|ya?ml|toml|lock|txt|cfg|ini)$/i

/** 一眼就知道不是本仓库路径的东西。 */
const NOT_A_PATH = [
  /^https?:/i,
  /^mailto:/i,
  /^[A-Za-z]:[\\/]/,          // Windows 绝对路径
  /^\//,                       // 绝对路径
  /^<.*>$/,                    // 占位符
  /[<>*?]/,                    // 占位符或通配
  /\/$/,                       // 目录尾斜杠：目录可能是有意不建的，不在这里判
]

/** 反引号里的行内代码：`` `xxx` ``。 */
const INLINE_CODE = /`([^`\n]+)`/g

/** 围栏代码块里的正文。 */
const FENCE_BLOCK = /```[a-zA-Z]*\n([\s\S]*?)```/g

/** `git switch <名>` / `git checkout <名>`。 */
const BRANCH_CMD = /\bgit\s+(?:switch|checkout)\s+(?:-c\s+)?([A-Za-z0-9._/-]+)/g

/** 一个 token 看起来是不是本仓库里的相对路径。 */
function looksLikeRepoPath(token) {
  const raw = String(token ?? '').trim().replace(/^['"]|['"]$/g, '')
  if (raw.length === 0) return false
  if (NOT_A_PATH.some((re) => re.test(raw))) return false
  if (!raw.includes('/')) return false
  return PATH_EXT.test(raw)
}

/**
 * 把文中出现的路径与分支名抽出来。
 *
 * 只看**两处**：反引号里的行内代码，与围栏代码块里的整行。正文散文里出现的「像路径的词」
 * 不算——那是叙述，不是承诺；把叙述也算进来，报出来的会是满屏假阳性，而假阳性多了
 * 这条判据就会被关掉。
 *
 * @returns {{ paths: string[], branches: string[] }}
 */
export function claimsOf(text) {
  const source = String(text ?? '').replace(/\r\n/g, '\n')
  const paths = new Set()
  const branches = new Set()

  const fenceBodies = []
  for (const block of source.matchAll(FENCE_BLOCK)) fenceBodies.push(block[1])

  // 行内代码里也可能是 `git switch main`
  for (const m of source.matchAll(INLINE_CODE)) {
    const token = m[1].trim()
    if (looksLikeRepoPath(token)) paths.add(token)
    for (const b of token.matchAll(BRANCH_CMD)) branches.add(b[1])
  }

  for (const body of fenceBodies) {
    for (const line of body.split('\n')) {
      // 行尾注释剥掉再看，否则 `node x.mjs  # 说明` 里的说明会被当成路径
      const code = line.replace(/\s+#.*$/, '').trim()
      if (code.length === 0 || code.startsWith('#')) continue
      for (const b of code.matchAll(BRANCH_CMD)) branches.add(b[1])
      for (const word of code.split(/\s+/)) {
        if (looksLikeRepoPath(word)) paths.add(word.replace(/^['"]|['"]$/g, ''))
      }
    }
  }

  return { paths: [...paths].sort(), branches: [...branches].sort() }
}

/**
 * 核对一批承诺，返回每条的判定。
 *
 * `exists` 由调用方注入：这个模块不认识文件系统，好让它能被夹具直接调用——造一堆真实
 * 文件去测「文件不存在时会不会报」既慢又会误伤。
 *
 * 没有承诺可查时**不返回任何条目**，而不是返回一条「通过」：一条恒真的判据看起来在工作，
 * 实际什么都没验，而那正是这类检查最容易退化的形状。
 *
 * @param {string} text 已写下的契约（通常是项目里的 `AGENTS.md`）
 * @param {object} facts 勘察事实
 * @param {(rel: string) => boolean} exists 这个相对路径在这个项目里存在吗
 * @returns {Array<{ id: string, ok: boolean, detail: string }>}
 */
export function verifyClaims(text, facts, exists) {
  const out = []
  const { paths, branches } = claimsOf(text)

  const actual = facts?.conventions?.defaultBranch ?? facts?.git?.originHeadBranch
  if (branches.length > 0 && actual) {
    const wrong = branches.filter((b) => b !== actual && b !== 'HEAD')
    out.push({
      id: 'claim.branch',
      ok: wrong.length === 0,
      detail: wrong.length === 0
        ? `契约里的分支名与当前默认分支（${actual}）一致`
        : `契约里写着 ${wrong.join('、')}，而当前默认分支是 ${actual}——照它跑会切到一条不存在的分支`,
    })
  }

  if (paths.length > 0) {
    const missing = paths.filter((p) => !exists(p))
    out.push({
      id: 'claim.path',
      ok: missing.length === 0,
      detail: missing.length === 0
        ? `${paths.length} 个契约里点名的路径都还在`
        : `契约里点名的这些路径已经不在了：${missing.join('、')}——照着它做的人会找不到东西`,
    })
  }

  return out
}

/** 这条承诺可能产出哪些 id。供 `review.mjs` 与门禁共用，免得两边各写一份。 */
export const CLAIM_IDS = Object.freeze(['claim.branch', 'claim.path'])
