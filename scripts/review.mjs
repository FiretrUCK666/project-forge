#!/usr/bin/env node
/**
 * review.mjs —— 目标项目的交付体检。
 *
 * 它回答一个问题：**这个项目现在拿去交，会在哪里出事？**
 *
 * ## 为什么结论是记录，不是字符串
 *
 * 早先版本里每条结论都是一句话，然后「下一步该做什么」那个函数回头去 `includes`
 * 这些句子里有没有某个词。结果是：改一个字的措辞，路由就静默失效——实测有三处已经
 * 永远匹配不上了（CI 缺失给错了 flag、提案模板缺失给错了 flag、参考章节号指错）。
 *
 * 那不是三个 bug，是同一个结构病的三个实例。所以这里的每条结论是一个记录：
 *
 *     { id, scope, level, title, decision?, ref? }
 *
 * 渲染与「下一步」读的是**同一个对象**，物理上不可能漂移。`ref` 里的节标题由
 * `preflight.mjs` 机器核对它真的存在于那份文件里，所以指路也不会过期。
 *
 * ## 三档，而不是一档
 *
 * 判据只有一条：**不说会出事吗？**
 *
 *   - `missing`：会。凭据进了历史、工作流把密钥交给陌生人、README 都没有。
 *   - `pending`：不会出事，但只有使用者能定（要不要许可、手写的契约留不留）。
 *   - `notice`：不会出事，只是可以更好（单语 README、没有 CI、本机署名没配）。
 *
 * 把 `notice` 当缺陷，是「每个项目都欠一笔还不完的债」的来源——而还债的方式通常是
 * 加一个 flag 把它压下去。所以它只提示，不拦。`--strict` 留给自己用（把 pending 也拦）。
 *
 * ## 户口本还是体检表
 *
 * **本机事实进 `notice`，项目事实才进 `missing`。** 判断依据：
 *
 *   - 换一台机器就变的东西（提交署名、凭据助手、gh 登录态）→ `notice`。
 *     它们在干净克隆里必然缺失，判成项目缺陷会让每一次新机器上的检查都红一次。
 *   - 跟着仓库走的东西（有没有 README、工作流安不安全、凭据进没进历史）→ `missing`。
 *
 * ## 决定写在哪
 *
 * `pending` 的答案写进项目自己的 `AGENTS.md` 的「## 取舍」节，形如
 * `- \`license\`：不放许可证（个人项目）`。**没有 flag、没有隐藏状态**：
 * 决定是项目事实，就该和项目一起被读、被争论、被接手。
 */

import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { survey } from './survey.mjs'
import { isMainModule, readTextSafe } from './lib/text.mjs'
import { parseMarkers } from './lib/protocol.mjs'

/** 读目录名；读不到就返回空数组——「读不到」由别的判据报，这里不制造第二个报错。 */
function readdirSyncSafe(dir) {
  try { return readdirSync(dir) } catch { return [] }
}

const SCOPES = new Set([
  'git', 'agents', 'docs', 'license', 'secrets', 'ci', 'release', 'collaboration', 'ecosystem',
])

/** 从 AGENTS.md 的「## 取舍」节读出已表态的决定，返回 `Set<id>`。 */
export function readDecisions(agentsText) {
  const decisions = new Set()
  if (typeof agentsText !== 'string') return decisions
  const lines = agentsText.replace(/\r\n/g, '\n').split('\n')
  let inSection = false
  for (const line of lines) {
    if (/^##\s+取舍\s*$/.test(line.trim())) { inSection = true; continue }
    if (inSection && /^#{1,2}\s+/.test(line)) break
    if (!inSection) continue
    const m = /^\s*[-*]\s*`?([a-z][a-z0-9._-]*)`?\s*[:：]/.exec(line)
    if (m) decisions.add(m[1])
  }
  return decisions
}

function finding(level, scope, id, title, extra = {}) {
  return { level, scope, id, title, ...extra }
}

/**
 * 契约的结构健康度：标记成对、该有的节都在、内容与模板一致。
 *
 * **不在这里重算**：三项判据都住在 `compose-agents.mjs` 里（`inspect` 与
 * `driftRegions`），这里只把它的结论取过来。两处各写一份的话，`--check` 说红、
 * 体检说绿的那种事迟早发生，而信哪一个都不对。
 *
 * 渲染失败（模板有洞、勘察出错）时返回「都空」并附一句原因：体检不该因为
 * 契约那一面算不出来就整个崩掉，那一面本来只是它的一项。
 */
async function inspectContract(root) {
  try {
    const { contractHealth } = await import('./compose-agents.mjs')
    return await contractHealth(root)
  } catch (error) {
    return {
      broken: [], missing: [], drifted: [], error: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * 系统占位署名：推上去之后历史里的提交追溯不到人。
 *
 * 判据分两半——名字是这一组系统默认值之一，**或**邮箱落在本地无效域名上。
 * 两半都要查：只查名字会漏掉 `dev@localhost` 这类「名字像人、邮箱是假的」；
 * 只查邮箱会漏掉 `Administrator <real@company.com>` 这类「邮箱真、署名是系统装出来的」。
 *
 * 为什么这不是 `notice` 而是 `missing`：它不会当场报错（推得上去），但**推上去就撤不回**，
 * 而且清起来要重写历史。这是「坏了看着还是一片绿」的典型形状。
 */
const PLACEHOLDER_NAME = /^(?:administrator|admin|root|user|default|ubuntu|ec2-user|vagrant|runner|builder)$/i
const PLACEHOLDER_EMAIL_DOMAIN = /@(?:localhost|.*\.local|.*\.localdomain|.*\.internal)$/i

function placeholderIdentity(name, email) {
  const hits = []
  if (typeof name === 'string' && PLACEHOLDER_NAME.test(name.trim())) hits.push(`署名是系统默认值「${name.trim()}」`)
  if (typeof email === 'string' && PLACEHOLDER_EMAIL_DOMAIN.test(email.trim())) hits.push(`邮箱落在本地无效域名上（${email.trim()}）`)
  return hits
}

/**
 * 走一遍全部判据，返回扁平的结果记录。
 *
 * 每条判据都必须给 `id` 与 `scope`——`id` 是「决定写在哪」的键，`scope` 是
 * `--scope` 局部验收的切面。没有 id 的结论就没法在项目里表态，也就永远消不掉。
 */
export async function reviewProject(targetDir, { scopes } = {}) {
  const facts = await survey(targetDir)
  const root = facts.target.path
  const wants = (face) => !scopes || scopes.has(face)

  const agentsPath = facts.docs.agents ? join(root, facts.docs.agents.file) : undefined
  const agentsText = agentsPath ? (readTextSafe(agentsPath) ?? '') : undefined
  const decisions = readDecisions(agentsText)

  const results = []
  const add = (f) => {
    if (!wants(f.scope)) return
    if (f.decision && decisions.has(f.decision)) {
      results.push({ ...f, level: 'ok', title: `${f.title}（已在 AGENTS.md 的「取舍」里表态：沿用现状）` })
      return
    }
    results.push(f)
  }

  // ── 版本控制 ──────────────────────────────────────────────────────
  if (facts.git.available === false) {
    // git 不在是**这台机器**的事，不是项目的事。项目本身可能完全健康。
    add(finding('notice', 'git', 'git.unavailable',
      '这台机器上找不到 git——版本管理这一整条路暂时走不了'))
  } else if (facts.git.present !== true) {
    add(finding('missing', 'git', 'git.absent', '还不是版本库', {
      ref: { file: 'references/version-control.md', section: '执行顺序（顺序本身就是正确性）' },
    }))
  } else if (facts.git.isRepoRoot === false) {
    add(finding('missing', 'git', 'git.nested',
      `这个目录在外层仓库 \`${facts.git.workTreeRoot}\` 里面，不是仓库根——边界的决定权在用户那里`, {
        decision: 'nested-repo',
        ref: { file: 'references/version-control.md', section: '判据：什么该进版本库' },
      }))
  } else {
    add(finding('ok', 'git', 'git.ready',
      `版本库就绪（分支 \`${facts.git.branch ?? 'HEAD'}\`，${facts.git.commits ?? 0} 个提交，角色 ${facts.git.role}）`))

    if (!facts.git.identity?.name || !facts.git.identity?.email) {
      const missing = [
        !facts.git.identity?.name ? '`user.name`' : null,
        !facts.git.identity?.email ? '`user.email`' : null,
      ].filter(Boolean).join(' 与 ')
      // 归「可以更好」：它**自己会喊**——没有署名时 `git commit` 当场拒绝并报
      // `Please tell me who you are`，不会静默做错事。而且它是**本机事实**，
      // 全新克隆里必然没有它；判成项目缺陷，会让每一次在新机器上跑的检查都红一次。
      add(finding('notice', 'git', 'git.identity',
        `这台机器的提交署名没配（缺 ${missing}）——第一次提交会被 git 拒掉`, {
          ref: { file: 'references/version-control.md', section: '提交署名' },
        }))
    } else {
      const placeholder = placeholderIdentity(facts.git.identity.name, facts.git.identity.email)
      if (placeholder.length > 0) {
        // 报 `missing` 而不报「齐」，也不报「可以更好」：这类署名推上去之后
        // 历史里的提交追溯不到人，而写下来的动作收不回来。确认是本人之后补上真署名即可。
        add(finding('missing', 'git', 'git.identity.placeholder',
          `${placeholder.join('；')}——推上去之后历史里的提交追溯不到人，而写下来就撤不回来。先确认这是谁`, {
            ref: { file: 'references/version-control.md', section: '提交署名' },
          }))
      } else {
        add(finding('ok', 'git', 'git.identity.ok',
          `提交署名是 ${facts.git.identity.name} <${facts.git.identity.email}>（来自 ${facts.git.identity.scope} 层）`))
      }
    }

    if (facts.git.role === 'undetermined') {
      add(finding('notice', 'git', 'git.role.undetermined',
        '比不出自己是正本还是 fork（项目没有声明源仓库）——按贡献者处置：拉分支、推自己的分支、开 PR，不推主干、不打标签'))
    } else if (facts.git.role === 'contributor-fork') {
      add(finding('notice', 'git', 'git.role.fork',
        `这是别人的仓库的 fork（${facts.git.roleReason}）——拉分支、推自己的分支、开 PR，不推主干、不打标签`))
    }
  }

  if (facts.git.present === true || facts.scale.totalFiles > 0) {
    if (facts.ignores.unignoredOutputDirs.length > 0) {
      add(finding('missing', 'git', 'git.output-dirs',
        `依赖或产物目录没被忽略：${facts.ignores.unignoredOutputDirs.join('、')}——它们会被提交进版本库`, {
          ref: { file: 'references/version-control.md', section: '忽略规则' },
        }))
    }
    if (facts.ignores.ignoredButTracked.length > 0) {
      add(finding('missing', 'git', 'git.ignored-tracked',
        `有 ${facts.ignores.ignoredButTracked.length} 个已入库文件同时命中忽略规则（${facts.ignores.ignoredButTracked.slice(0, 3).join('、')}）——忽略规则对已入库的文件无效，要 \`git rm --cached\``, {
          ref: { file: 'references/version-control.md', section: '忽略规则' },
        }))
    }
    if (!facts.ignores.hasGitattributes) {
      add(finding('notice', 'git', 'git.gitattributes',
        '没有 .gitattributes——跨平台协作时行尾会因机器而异，同一份文件在两台机器上算出不同的字节', {
          ref: { file: 'references/version-control.md', section: '文本属性' },
        }))
    }
  }

  // ── 凭据与敏感信息 ────────────────────────────────────────────────
  const trackedFiles = facts.risks.secretFiles.filter((f) => f.status === 'tracked')
  const exposedFiles = facts.risks.secretFiles.filter((f) => f.status === 'exposed')
  const trackedContent = facts.risks.secretContent.filter((c) => c.status === 'tracked')
  const exposedContent = facts.risks.secretContent.filter((c) => c.status === 'exposed')

  if (trackedFiles.length > 0 || trackedContent.length > 0) {
    const where = [
      ...trackedFiles.map((f) => f.file),
      ...trackedContent.map((c) => `${c.file}:${c.line}（${c.kind}）`),
    ]
    add(finding('missing', 'secrets', 'secrets.tracked',
      `凭据形状的东西已经进了版本库：${where.join('、')}——改文件不管用，要轮换凭据并把历史处理掉`, {
        ref: { file: 'references/version-control.md', section: '凭据门控' },
      }))
  }
  if (exposedFiles.length > 0 || exposedContent.length > 0) {
    const where = [
      ...exposedFiles.map((f) => f.file),
      ...exposedContent.map((c) => `${c.file}:${c.line}（${c.kind}）`),
    ]
    add(finding('missing', 'secrets', 'secrets.exposed',
      `有未忽略的敏感内容：${where.join('、')}——提交前要么加进忽略规则，要么确认真的是测试数据`, {
        decision: 'secrets-are-placeholders',
        ref: { file: 'references/version-control.md', section: '凭据门控' },
      }))
  }
  if (trackedFiles.length === 0 && trackedContent.length === 0
    && exposedFiles.length === 0 && exposedContent.length === 0) {
    add(finding('ok', 'secrets', 'secrets.clean', '没扫到凭据形状的文本'))
  }
  if (facts.risks.homePathLeaks.length > 0) {
    // 只报真泄露。测试夹具里的假路径、文档里的示例路径、工作记录里当时现场的路径
    // 都是**数据**，不是缺陷——把它们报出来，修的人第一件事就是把那一行改掉，
    // 而改掉的正好是一份有用的夹具。
    const leaks = facts.risks.homePathLeaks.filter((f) => f.category === 'leak' || f.category === undefined)
    const benign = facts.risks.homePathLeaks.length - leaks.length
    if (leaks.length > 0) {
      const sample = leaks.slice(0, 3).map((f) => `${f.file}:${f.line}`).join('、')
      add(finding('notice', 'secrets', 'secrets.home-paths',
        `有 ${leaks.length} 处硬编码的本机绝对路径（${sample}）——换台机器就跑不通`, {
          ref: { file: 'references/docs-set.md', section: '四、`README`' },
        }))
    }
    if (benign > 0) {
      add(finding('ok', 'secrets', 'secrets.home-paths-benign',
        `另有 ${benign} 处本机路径属于测试夹具 / 文档示例 / 工作记录——是数据不是缺陷，不要改`))
    }
  }

  const unverified = facts.risks.secretFiles.filter((f) => f.status === 'unverified-large')
  if (unverified.length > 0) {
    // 「没扫」不是「干净」。这一档之所以判 `missing` 而不是 `notice`：一个叫 `.env` 的
    // 文件超过 256 KB 没扫内容，它里面有没有真凭据**没有答案**，而报告会替它说「没扫到」。
    add(finding('missing', 'secrets', 'secrets.unverified-large',
      `${unverified.length} 个敏感命名的文件超过 256 KB，内容没扫：${unverified.map((f) => f.file).join('、')}——`
      + '它们的状态是未知，不是干净。打开确认一下，或删掉', {
        ref: { file: 'references/version-control.md', section: '凭据门控' },
      }))
  }
  if (facts.risks.largeFiles.length > 0) {
    add(finding('notice', 'secrets', 'secrets.large-files',
      `有大文件没被忽略：${facts.risks.largeFiles.map((f) => `${f.file}（${f.sizeMB} MB）`).join('、')}——它们会永久留在历史里`, {
        ref: { file: 'references/version-control.md', section: '大文件' },
      }))
  }

  const coverage = facts.risks.scanCoverage
  if (coverage?.truncated) {
    // 截断必须被读成「没查完」，不能读成「查完没发现」。这是这一档存在的全部理由。
    add(finding('notice', 'secrets', 'secrets.scan-truncated',
      `扫描被截断（只走到第 ${coverage.depthReached} 层、前 20000 个文件）——上面的「没扫到」覆盖不到更深的地方`, {
        ref: { file: 'references/survey.md', section: '三、字段含义' },
      }))
  }

  // ── 契约文件 ──────────────────────────────────────────────────────
  if (!facts.docs.agents) {
    add(finding('missing', 'agents', 'agents.absent',
      '没有 AGENTS.md——AI 每次新开会话都要重新摸一遍这个项目', {
        ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
      }))
  } else if (agentsText === undefined) {
    add(finding('missing', 'agents', 'agents.unreadable',
      `${facts.docs.agents.file} 读不出来（不是 UTF-8 文本？）——这不是「没有」，是「有但读不懂」`, {
        ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
      }))
  } else {
    const fills = parseMarkers(agentsText, facts.docs.agents.file).filter((m) => m.kind === 'fill')
    if (fills.length > 0) {
      add(finding('missing', 'agents', 'agents.unfilled',
        `${facts.docs.agents.file} 还有 ${fills.length} 处没填：${fills.slice(0, 4).map((f) => `第 ${f.line} 行「${f.what}」`).join('、')}——空着的契约比没有更糟，它看起来像有`, {
          ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
        }))
    } else {
      // **光「没有未填的占位」不代表契约完好。**
      //
      // 三种坏法都不带 fill，却都让这份契约不再可用：标记没成对（有人手改坏了）、
      // 缺了本该有的节（建好远端之后没重跑生成）、内容与模板脱节（模板加了规则而
      // 这份还停在旧版）。只查 fill 那一档，这三种会一起报「已就绪」——而它是假绿。
      // 判据直接取 `compose-agents` 的，不在这里重算一遍。
      const health = await inspectContract(root)
      if (health.broken.length > 0) {
        add(finding('missing', 'agents', 'agents.broken',
          `${facts.docs.agents.file} 的受管标记没成对：${health.broken.join('、')}——半对锚点意味着文件被改坏了，刷新已经不敢动它`, {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else if (health.missing.length > 0) {
        add(finding('missing', 'agents', 'agents.missing-sections',
          `${facts.docs.agents.file} 缺 ${health.missing.length} 节（条件为真却没有）：${health.missing.join('、')}——跑一次不带参数的 compose-agents 就会补上`, {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else if (health.drifted.length > 0) {
        add(finding('missing', 'agents', 'agents.drifted',
          `${facts.docs.agents.file} 有 ${health.drifted.length} 段与模板不一致：${health.drifted.join('、')}——这几段本该与模板渲染结果逐字相同`, {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else {
        add(finding('ok', 'agents', 'agents.ready', `${facts.docs.agents.file} 已就绪，没有未填的占位，结构也完整`))
      }
    }
    if (facts.docs.otherAiConventions.length > 0) {
      add(finding('notice', 'agents', 'agents.other-conventions',
        `还有别的 AI 约定文件（${facts.docs.otherAiConventions.join('、')}）——确认它们的命令与 AGENTS.md 说的是同一件事`))
    }
  }

  // ── 文档 ──────────────────────────────────────────────────────────
  if (!facts.docs.readme) {
    add(finding('missing', 'docs', 'docs.readme',
      '没有 README——别人打开仓库第一眼没有说明', {
        ref: { file: 'references/docs-set.md', section: '四、`README`' },
      }))
  } else {
    const text = readTextSafe(join(root, facts.docs.readme)) ?? ''
    if (text.trim().length < 30) {
      add(finding('missing', 'docs', 'docs.readme-thin',
        `${facts.docs.readme} 只有 ${text.trim().length} 个字符——等于没有`, {
          ref: { file: 'references/docs-set.md', section: '四、`README`' },
        }))
    } else {
      add(finding('ok', 'docs', 'docs.readme.ok', `README 有（${facts.docs.readmes.join('、')}）`))
    }
    if (facts.docs.readmes.length === 1) {
      add(finding('notice', 'docs', 'docs.single-language',
        '只有一份 README——单语项目是正常的，不必为了「规范」硬加一份翻译'))
    }
  }

  if (!facts.docs.contributing) {
    add(finding('notice', 'docs', 'docs.contributing',
      '没有 CONTRIBUTING——只有确实要收外部贡献时才需要它；一个人用的项目不加是对的', {
        decision: 'no-contributing',
        ref: { file: 'references/docs-set.md', section: '五、`CONTRIBUTING`' },
      }))
  }

  // ── 许可证 ────────────────────────────────────────────────────────
  if (facts.docs.license) {
    add(finding('ok', 'license', 'license.present', `LICENSE 有（${facts.docs.license}）`))
  } else if (facts.ecosystem.publishable) {
    add(finding('missing', 'license', 'license.publishable',
      '清单声明了可发布的包，却没有 LICENSE——下游的合规检查会因为「授权不明」拒绝使用', {
        decision: 'license',
        ref: { file: 'references/docs-set.md', section: '六、`LICENSE`' },
      }))
  } else {
    add(finding('pending', 'license', 'license.missing',
      '没有 LICENSE——公开项目需要它；私有项目不放是对的。这一项只有你能定', {
        decision: 'license',
        ref: { file: 'references/docs-set.md', section: '六、`LICENSE`' },
      }))
  }

  // ── 持续集成与发布 ────────────────────────────────────────────────
  if (facts.docs.workflowFacts.usesPullRequestTarget && facts.docs.workflowFacts.checkoutsPrHead) {
    add(finding('missing', 'ci', 'ci.pwn-request',
      '工作流同时用了 `pull_request_target` 并检出提案那边的代码——这等于让任意陌生人拿你的密钥跑他的代码。'
      + '改成「无特权工作流跑检查 + 有特权工作流只消费产物」，或把触发器换成 `pull_request`', {
        ref: { file: 'references/remote-github.md', section: '七、持续集成' },
      }))
  }

  if (facts.ecosystem.kinds.includes('docs-only')) {
    add(finding('ok', 'ci', 'ci.docs-only', '纯文档项目不需要跑构建的 CI'))
  } else if (facts.docs.workflowFacts.hasCheck) {
    add(finding('ok', 'ci', 'ci.present', `CI 有（${facts.docs.workflows.join('、')}）`))
  } else {
    add(finding('notice', 'ci', 'ci.absent',
      '没有 CI——本机能过不等于换台机器能过。一个人用的小工具不配也是合理的', {
        decision: 'no-ci',
        ref: { file: 'references/remote-github.md', section: '七、持续集成' },
      }))
  }

  if (facts.docs.workflowFacts.hasRelease) {
    add(finding('ok', 'release', 'release.present', '发布自动化有'))
  } else if (facts.ecosystem.publishable && !facts.ecosystem.private) {
    add(finding('notice', 'release', 'release.absent',
      '项目有可发布形态，但没有发布自动化——可以手发，也可以让标签触发', {
        decision: 'no-auto-release',
        ref: { file: 'references/remote-github.md', section: '七、持续集成' },
      }))
  }

  if (!facts.docs.releasing && facts.ecosystem.publishable) {
    add(finding('notice', 'release', 'release.spec',
      '要发版的项目没有 RELEASING——发布说明写在哪、分哪几节、按什么顺序发，每次都要重新商量', {
        decision: 'no-release-spec',
        ref: { file: 'references/docs-set.md', section: '七、`RELEASING`' },
      }))
  }

  // 发布说明留在工作区里没填完，是「看起来有、其实是空的」最典型的一种。
  // 它必须在打标签之前被发现——标签一旦推上去，自动化读到这份空壳会照样把它贴在
  // 发布页上，而这次发版看起来还是绿的。
  const notesDir = join(root, 'docs', 'release-notes')
  if (existsSync(notesDir)) {
    const empty = []
    for (const name of readdirSyncSafe(notesDir)) {
      if (!/\.md$/i.test(name)) continue
      const text = readTextSafe(join(notesDir, name)) ?? ''
      if (parseMarkers(text, name).some((m) => m.kind === 'fill')) empty.push(`docs/release-notes/${name}`)
    }
    if (empty.length > 0) {
      add(finding('missing', 'release', 'release.notes-unfilled',
        `发布说明里还有没填完的占位：${empty.join('、')}——打标签时自动化会把它原样贴到发布页上，而且看起来是成功的`, {
          ref: { file: 'references/docs-set.md', section: '七、`RELEASING`' },
        }))
    }
  }

  // 受管区间的命令与当前事实脱节：契约说一套、项目实际是另一套。
  //
  // 这一条只报「可以更好」而不拦，理由是它不会当场出事——但它确实是「AI 照着契约跑
  // 一条已经改名的命令、失败后以为是代码坏了」的来源。
  if (agentsText && facts.commands && Object.keys(facts.commands).length > 0) {
    const declared = Object.values(facts.commands).filter((v) => typeof v === 'string' && v.trim())
    const missing = declared.filter((cmd) => !agentsText.includes(cmd))
    if (missing.length > 0) {
      add(finding('notice', 'agents', 'agents.commands-stale',
        `${facts.docs.agents.file} 里没提到这些实际存在的命令：${missing.slice(0, 3).join('、')}`
        + '——契约里的构建与验证节已经和项目现状脱节，照着它跑会漏掉这一步', {
          ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
        }))
    }
  }

  // 版本号与标签对不上，是自动化最常翻车的地方。
  //
  // 三件事分开判，因为它们各自错法的后果不同：
  //   一、**标签形状**：插件市场一类要求裸版本号，带了 `v` 前缀用户就装不上——
  //       这是「立即失败」，而且失败很安静（市场不收录，没有任何报错）；
  //   二、**版本号与标签对不上**：自动化按标签取版本，对不上就发错东西；
  //   三、`v` 前缀与裸版本混用：手工发版时最容易积累的一种漂移。
  const version = facts.ecosystem.declaredVersion
  const tags = facts.git.tags ?? []
  const kinds = facts.ecosystem.kinds ?? []
  const needsBareTag = kinds.some((k) => k === 'obsidian-plugin')

  if (needsBareTag && tags.some((t) => /^v\d/.test(t))) {
    add(finding('missing', 'release', 'release.observed-v-tag',
      `插件的 Git 标签带了 \`v\` 前缀（${tags.filter((t) => /^v\d/.test(t)).slice(0, 3).join('、')}）——`
      + '这个生态要求标签与清单里的版本号逐字相同，带前缀会导致市场不收录、用户装不上。'
      + '工作流的触发行也要从 `v*` 改成数字开头', {
        ref: { file: 'references/plugin-ecosystems.md', section: 'Obsidian 插件' },
      }))
  }

  if (version && tags.length > 0) {
    const numeric = tags.map((t) => t.replace(/^v/, ''))
    if (!numeric.includes(version)) {
      add(finding('notice', 'release', 'release.tag-mismatch',
        `清单版本是 ${version}，而标签里没有它（有 ${tags.slice(0, 4).join('、')}）——自动化按标签取版本，对不上就发错东西`, {
          ref: { file: 'references/publish.md', section: '三、版本号语义' },
        }))
    }
    const withV = tags.filter((t) => /^v/.test(t)).length
    if (withV > 0 && withV < tags.length) {
      add(finding('notice', 'release', 'release.tag-shape-mixed',
        `标签的写法不统一：${tags.length} 个里有 ${withV} 个带 \`v\` 前缀——混用两套形状时，`
        + '自动化的触发条件只能覆盖其中一种', {
          ref: { file: 'references/remote-github.md', section: '六、版本节点与发布说明' },
        }))
    }
  }

  if (facts.docs.releasing && !facts.ecosystem.publishable && kinds.includes('skill')) {
    add(finding('ok', 'release', 'release.skill-dist', '能力目录靠克隆或复制分发，不经过制品库——这是正常结果'))
  }

  // ── 协作基础设施 ──────────────────────────────────────────────────
  const hasRemote = typeof facts.git.remote === 'string' && facts.git.remote.length > 0
    && facts.git.isRepoRoot !== false
  if (!hasRemote) {
    add(finding('ok', 'collaboration', 'collab.no-remote', '没有远端：谈不上收别人的改动'))
  } else {
    if (!facts.docs.prTemplate) {
      add(finding('notice', 'collaboration', 'collab.pr-template',
        '有远端却没有 PR 模板——别人提改动时不知道该说明什么，审查的人只能从代码反推意图', {
          decision: 'no-collab-templates',
          ref: { file: 'references/collaboration.md', section: '六、谁能合：按「收不收得回来」分档' },
        }))
    }
    if (!facts.docs.issueTemplates) {
      add(finding('notice', 'collaboration', 'collab.issue-templates',
        '有远端却没有 Issue 模板——每份缺陷报告都要来回追问「环境是什么、怎么复现」', {
          decision: 'no-collab-templates',
          ref: { file: 'references/collaboration.md', section: '三、收到别人的 Issue' },
        }))
    }
    if (facts.docs.workflowFacts.usesPullRequestTarget && !facts.docs.workflowFacts.checkoutsPrHead) {
      add(finding('ok', 'collaboration', 'collab.prt-safe',
        '用了 `pull_request_target` 但没检出提案的代码（合法用法）'))
    }
  }

  // ── 生态专属 ──────────────────────────────────────────────────────
  if (facts.ecosystem.kinds.includes('skill')) {
    const meta = facts.ecosystem.skillMeta
    if (!meta?.hasValidFrontmatter) {
      add(finding('missing', 'ecosystem', 'ecosystem.skill-frontmatter',
        'SKILL.md 的 frontmatter 缺 `name` 或 `description`——缺任一项，宿主会**整份丢弃**而且不报错', {
          ref: { file: 'references/skill-project.md', section: '二、能力目录' },
        }))
    } else {
      add(finding('ok', 'ecosystem', 'ecosystem.skill-frontmatter.ok',
        `能力目录入口合法（name: ${meta.name}）`))
    }
  }
  for (const skill of facts.localSkills) {
    if (!skill.valid) {
      add(finding('missing', 'ecosystem', 'ecosystem.local-skill-invalid',
        `仓库自带的 skills 里有一份不合法：${skill.path}——宿主会静默丢掉它`, {
          ref: { file: 'references/skill-project.md', section: '二、能力目录' },
        }))
    }
  }
  if (facts.ecosystem.kinds.includes('unknown')) {
    add(finding('pending', 'ecosystem', 'ecosystem.unknown',
      '认不出这是什么项目——生态决定该做哪几件事，猜错会把不合适的流程套上去', {
        decision: 'project-kind',
      }))
  }

  return summarize(facts, results)
}

function summarize(facts, results) {
  const by = (level) => results.filter((r) => r.level === level)
  const missing = by('missing')
  const pending = by('pending')
  const notice = by('notice')
  const ok = by('ok')
  return {
    target: facts.target,
    maturity: facts.maturity,
    facts,
    results,
    missing,
    pending,
    notice,
    ok,
    verdict: missing.length > 0 ? 'missing'
      : pending.length > 0 ? 'pending'
        : notice.length > 0 ? 'notice' : 'ok',
  }
}

// ── 渲染 ────────────────────────────────────────────────────────────

function renderRef(ref) {
  if (!ref) return ''
  return `\n        读：\`${ref.file}\` 的「${ref.section}」`
}

function render(result, strict) {
  const lines = []
  lines.push(`交付体检：${result.target.name}（成熟度 ${result.maturity}）`)
  lines.push('')

  const order = ['git', 'secrets', 'agents', 'docs', 'license', 'ci', 'release', 'collaboration', 'ecosystem']
  const label = { missing: '缺', pending: '待定', notice: '可以更好', ok: '齐' }

  for (const scope of order) {
    const group = result.results.filter((r) => r.scope === scope)
    if (group.length === 0) continue
    lines.push(`【${scope}】`)
    for (const r of group) {
      lines.push(`  [${label[r.level]}] ${r.title}${renderRef(r.ref)}`)
    }
    lines.push('')
  }

  if (result.missing.length > 0) {
    lines.push(`结论：${result.missing.length} 处会出事，改完重跑。`)
  } else if (result.pending.length > 0) {
    lines.push(`结论：没有会出事的缺口，但有 ${result.pending.length} 项只有使用者能定。问完把答案写进 AGENTS.md 的「## 取舍」节，重跑即可。`)
  } else if (result.notice.length > 0) {
    lines.push(`结论：可以交付。（另有 ${result.notice.length} 项「可以更好」，不拦）`)
  } else {
    lines.push('结论：可以交付。')
  }

  if (result.pending.length > 0) {
    lines.push('')
    lines.push('要问的事：')
    for (const r of result.pending) {
      lines.push(`  - ${r.title}（表态写法：\`- \\\`${r.decision}\\\`：<你的选择>\` 写进 AGENTS.md 的「## 取舍」）`)
    }
  }

  return lines.join('\n')
}

// ── 命令行 ──────────────────────────────────────────────────────────

async function main(argv) {
  let target = process.cwd()
  let scopes
  let strict = false
  let asJson = false

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        '用法：node scripts/review.mjs [目标目录] [选项]',
        '',
        '  --scope=git,agents,docs  只验这几面（逗号分隔）',
        `                           可用：${[...SCOPES].join(', ')}`,
        '  --strict                 把「待定」也算没通过（CI 用）',
        '  --json                   输出机器可读的结果',
        '',
        '三档结论：缺（会出事）/ 待定（只有使用者能定）/ 可以更好（不拦）。',
        '待定项的答案写进目标项目 AGENTS.md 的「## 取舍」节，不用记 flag。',
      ].join('\n') + '\n')
      return 0
    }
    if (arg === '--strict') strict = true
    else if (arg === '--json') asJson = true
    else if (arg.startsWith('--scope=')) {
      const list = arg.slice('--scope='.length).split(',').map((s) => s.trim()).filter(Boolean)
      const bad = list.filter((s) => !SCOPES.has(s))
      if (bad.length > 0) {
        process.stderr.write(`未知切面：${bad.join('、')}（可用：${[...SCOPES].join(', ')}）\n`)
        return 2
      }
      scopes = new Set(list)
    } else if (!arg.startsWith('-')) target = arg
    else {
      process.stderr.write(`未知选项：${arg}（用 --help 看用法）\n`)
      return 2
    }
  }

  try {
    const result = await reviewProject(target, { scopes })
    if (asJson) {
      process.stdout.write(`${JSON.stringify({
        target: result.target,
        maturity: result.maturity,
        verdict: result.verdict,
        results: result.results,
      }, null, 2)}\n`)
    } else {
      process.stdout.write(`${render(result, strict)}\n`)
    }

    if (result.missing.length > 0) return 1
    if (strict && result.pending.length > 0) return 2
    return 0
  } catch (err) {
    process.stderr.write(`体检失败：${err instanceof Error ? err.message : String(err)}\n`)
    return 2
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
