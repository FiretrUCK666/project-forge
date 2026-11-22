#!/usr/bin/env node
/**
 * review.mjs —— 目标项目的交付体检。
 *
 * 每条结论是一个结构化记录 `{ id, scope, level, title, decision?, ref? }`：
 *   - `missing`：会出事（凭据入史、高危工作流、缺 README、托管套件残缺）；
 *   - `pending`：只有使用者能定（写进 AGENTS.md「## 取舍」后消掉）；
 *   - `notice`：本机事实或可选项（署名、单语、没有 CI），不拦交付。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { survey } from './survey.mjs'
import { flushAndExit, isMainModule, readTextSafe } from './lib/text.mjs'
import { AGENTS_MAX_BYTES, AGENTS_WARN_BYTES, parseMarkers } from './lib/protocol.mjs'
import { CLAIM_IDS, verifyClaims } from './lib/claims.mjs'
import { inspectKitManifestForReview, validateDevProfileRegion } from './lib/agents-sections.mjs'
import {
  checkGovernancePrdCoverage,
  collectMissingRemoteCapabilities,
  collectReleaseTagIssues,
  collectSecretsSummary,
  collectStaleCommandsInfo,
  collectUnfilledReleaseNotes,
  inspectContract,
  placeholderIdentity,
  runReviewCli,
  summarizeReviewResults,
} from './lib/review-helpers.mjs'

import { findUnexecutableArtifacts } from './lib/artifact-executors.mjs'
import { readDecisionMap, readDecisions, resolveAuthoritativeTddPath } from '../kit/skills/lib/profile.mjs'

export { readDecisionMap, readDecisions }

function finding(level, scope, id, title, extra = {}) {
  return { level, scope, id, title, ...extra }
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

  const unexecutable = findUnexecutableArtifacts(facts.artifactPlan ?? [])
  if (unexecutable.length === 0) {
    add(finding('ok', 'artifacts', 'artifacts.executors', '产物计划中全部待建项均已对齐可执行入口'))
  } else {
    for (const item of unexecutable) {
      add(finding('missing', 'artifacts', item.code, item.message, {
        ref: { file: 'references/handoff.md', section: '四、交棒前四步清单' },
      }))
    }
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
    } else if (facts.git.role === 'clone-readonly') {
      add(finding('notice', 'git', 'git.role.readonly',
        `这是只读克隆的仓库（${facts.git.roleReason}）——不能直接向源仓库推送或打标签；如需贡献应先 Fork 再开 PR`))
    } else if (facts.git.role === 'local-only' && facts.git.remote) {
      add(finding('ok', 'git', 'git.role.local',
        '已启用纯本地模式（.git/pf-local-mode），按纯本地工作区处置'))
    }
    if (facts.git.isBare !== true) {
      const hs = facts.git.hooks
      if (hs?.installed) {
        add(finding('ok', 'git', 'git.hooks.ok',
          '已启用跨宿主 `.githooks/pre-push`（`core.hooksPath=.githooks`）防直推默认分支护栏'))
      } else if (hs?.hasConflict) {
        const conflictList = (hs.conflicts ?? []).map((c) => c.path).join('、') || '既有钩子'
        add(finding('ok', 'git', 'git.hooks.conflict-preserved',
          `检测到既有本地 Hook（${conflictList}），按 preserve 原则共存，不接管 core.hooksPath`))
      } else {
        add(finding('notice', 'git', 'git.hooks',
          '尚未启用跨宿主 `.githooks/pre-push` 防直推护栏（可运行 `equip.mjs --with-hooks`，或在「取舍」写 `no-git-hooks`）', {
            decision: 'no-git-hooks',
            ref: { file: 'references/version-control.md', section: '本地 Git Hooks（.githooks/pre-push）' },
          }))
      }
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
  const sec = collectSecretsSummary(facts)

  if (sec.trackedWhere.length > 0) {
    add(finding('missing', 'secrets', 'secrets.tracked',
      `凭据形状的东西已经进了版本库：${sec.trackedWhere.join('、')}——改文件不管用，要轮换凭据并把历史处理掉`, {
        ref: { file: 'references/version-control.md', section: '凭据门控' },
      }))
  }
  if (sec.exposedWhere.length > 0) {
    add(finding('missing', 'secrets', 'secrets.exposed',
      `有未忽略的敏感内容：${sec.exposedWhere.join('、')}——提交前要么加进忽略规则，要么确认真的是测试数据`, {
        decision: 'secrets-are-placeholders',
        ref: { file: 'references/version-control.md', section: '凭据门控' },
      }))
  }
  if (sec.trackedWhere.length === 0 && sec.exposedWhere.length === 0) {
    add(finding('ok', 'secrets', 'secrets.clean', '没扫到凭据形状的文本'))
  }
  if (sec.leaks.length > 0 || sec.benignCount > 0) {
    // 只报真泄露。测试夹具里的假路径、文档里的示例路径、工作记录里当时现场的路径都是数据不是缺陷。
    if (sec.leaks.length > 0) {
      const sample = sec.leaks.slice(0, 3).map((f) => `${f.file}:${f.line}`).join('、')
      add(finding('notice', 'secrets', 'secrets.home-paths',
        `有 ${sec.leaks.length} 处硬编码的本机绝对路径（${sample}）——换台机器就跑不通`, {
          ref: { file: 'references/docs-set.md', section: '四、`README`' },
        }))
    }
    if (sec.benignCount > 0) {
      add(finding('ok', 'secrets', 'secrets.home-paths-benign',
        `另有 ${sec.benignCount} 处本机路径属于测试夹具 / 文档示例 / 工作记录——是数据不是缺陷，不要改`))
    }
  }

  if (sec.unverified.length > 0) {
    // 「没扫」不是「干净」：敏感命名文件超 256 KB 未扫内容，状态为未知而非干净。
    add(finding('missing', 'secrets', 'secrets.unverified-large',
      `${sec.unverified.length} 个敏感命名的文件超过 256 KB，内容没扫：${sec.unverified.map((f) => f.file).join('、')}——`
      + '它们的状态是未知，不是干净。打开确认一下，或删掉', {
        ref: { file: 'references/version-control.md', section: '凭据门控' },
      }))
  }
  if (sec.largeFiles.length > 0) {
    add(finding('notice', 'secrets', 'secrets.large-files',
      `有大文件没被忽略：${sec.largeFiles.map((f) => `${f.file}（${f.sizeMB} MB）`).join('、')}——它们会永久留在历史里`, {
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
    const agentsBytes = facts.docs.agentsBytes ?? Buffer.byteLength(agentsText, 'utf8')
    const oversize = agentsBytes > AGENTS_MAX_BYTES
    if (oversize) {
      add(finding('missing', 'agents', 'agents.oversize',
        `${facts.docs.agents.file} 体积超过 ${AGENTS_MAX_BYTES} 字节上限（当前 ${agentsBytes} 字节）——请将长篇架构设计与细节外置到 docs/TDD.md`, {
          ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
        }))
    } else if (agentsBytes > AGENTS_WARN_BYTES) {
      add(finding('notice', 'agents', 'agents.near-limit',
        `${facts.docs.agents.file} 体积已接近上限（当前 ${agentsBytes} / ${AGENTS_MAX_BYTES} 字节）——新增内容请优先外置到 docs/TDD.md`))
    }

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
      const contract = await inspectContract(root, facts)
      if (contract.state === 'unavailable') {
        add(finding('missing', 'agents', 'agents.unavailable',
          `${facts.docs.agents.file} 的结构这一面这次算不出来（${contract.error}）——`
          + '它不等于「结构完整」，恰恰相反：说明这一步没有验过', {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else if (contract.health.broken.length > 0) {
        add(finding('missing', 'agents', 'agents.broken',
          `${facts.docs.agents.file} 的受管标记没成对：${contract.health.broken.join('、')}——半对锚点意味着文件被改坏了，刷新已经不敢动它`, {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else if (contract.health.handWritten) {
        // 手写契约是**允许的选择**（`compose --check` 只核它答了三件事），但它没有受管区，
        // 所以「与模板渲染结果是否一致」这件事**压根没有可比对的东西**。
        // 这里如果什么都不说，下一句就落到 `agents.ready`——「结构也完整」，
        // 而那正是这类判据最典型的假绿：没验过被读成验过了。
        // 它排在 `broken` 之后：标记没成对的文件不是「手写契约」，是被改坏的契约。
        add(finding('notice', 'agents', 'agents.unverified',
          `${facts.docs.agents.file} 是手写的，受管区一个都没有，所以「与模板一致」这一面没有可核对的东西——`
          + '这不是「结构完整」，是这一面没验', {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else if (contract.health.missing.length > 0) {
        add(finding('missing', 'agents', 'agents.missing-sections',
          `${facts.docs.agents.file} 缺 ${contract.health.missing.length} 节（条件为真却没有）：${contract.health.missing.join('、')}——跑一次不带参数的 compose-agents 就会补上`, {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else if (contract.health.drifted.length > 0) {
        add(finding('missing', 'agents', 'agents.drifted',
          `${facts.docs.agents.file} 有 ${contract.health.drifted.length} 段与模板不一致：${contract.health.drifted.join('、')}——这几段本该与模板渲染结果逐字相同`, {
            ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
          }))
      } else if (!oversize) {
        const dpChk = validateDevProfileRegion(agentsText)
        if (!dpChk.ok) {
          add(finding('missing', 'agents', 'agents.dev-profile-invalid',
            `${facts.docs.agents.file} 的 Dev Profile 未校验通过：${dpChk.reason}`, {
              ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
            }))
        } else {
          add(finding('ok', 'agents', 'agents.ready', `${facts.docs.agents.file} 已就绪，没有未填的占位，结构也完整`))
        }
      }
    }
    if (facts.docs.otherAiConventions.length > 0) {
      add(finding('notice', 'agents', 'agents.other-conventions',
        `还有别的 AI 约定文件（${facts.docs.otherAiConventions.join('、')}）——确认它们的命令与 AGENTS.md 说的是同一件事`))
    }
  }

  // ── 契约回查：已经写下的那句话现在还成立吗 ──────────────────────────
  //
  // `agents.*` 那半段判的是「这份文件与**这次渲染**是否一致」——它拿同一批事实
  // 两头各算一次，两边一起错时比出来的结果是「一致」。这一半换方向：从**文字本身**
  // 读出它承诺了什么，再拿项目现状核对。判据在 `lib/claims.mjs`，这里只接线。
  if (agentsText) {
    const existsRel = (rel) => existsSync(join(root, rel))
    for (const item of verifyClaims(agentsText, facts, existsRel)) {
      add(finding(item.ok ? 'ok' : 'missing', 'agents', item.id, item.detail, {
        ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
      }))
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

  const needsTdd = (facts.scale.codeFiles ?? 0) > 0 && !(facts.ecosystem.kinds ?? []).includes('docs-only')
  const staleTddPaths = facts.reentry?.staleTddPaths ?? []
  const decisionMap = readDecisionMap(agentsText)
  const authTddPath = resolveAuthoritativeTddPath(root, decisionMap)
  const existingArchDocs = facts.docs.existingDesignDocs ?? facts.docs.archDocs ?? facts.docs.designDocs ?? facts.docs.existingArchDocs ?? []
  if (staleTddPaths.length > 0) {
    add(finding('missing', 'docs', 'docs.tdd-stale-paths',
      `技术设计文档 \`${facts.docs.tdd || 'docs/TDD.md'}\` 中以下源码路径已不存在：${staleTddPaths.slice(0, 6).join('、')}——请随重构同步校准`, {
        ref: { file: 'references/docs-set.md', section: '二、四层设计文档体系' },
      }))
  } else if (needsTdd) {
    if (facts.docs.tdd) {
      add(finding('ok', 'docs', 'docs.tdd.ok', `技术设计文档已就绪（${facts.docs.tdd}）`))
    } else if (authTddPath) {
      add(finding('ok', 'docs', 'docs.tdd.ok', `已按 tdd-authority 声明使用存量设计文档（${authTddPath}）`))
    } else if (existingArchDocs.length > 0) {
      add(finding('ok', 'docs', 'docs.tdd.ok', `已存在存量架构设计文档（${existingArchDocs.slice(0, 3).join('、')}）`))
    } else if (!decisions.has('no-tdd')) {
      add(finding('notice', 'docs', 'docs.tddMissing',
        '代码项目缺少 `docs/TDD.md`——将长篇设计决策外置到 TDD.md 可防止 AGENTS.md 超过上下文预算', {
          decision: 'no-tdd',
        }))
    }
  }

  // ── 工程套件（.agents/skills/，兼容 v1/v2 manifest）─────────────────
  if ((facts.scale.effectiveFiles ?? 0) > 0 && !decisions.has('no-kit')) {
    const kit = facts.kit
    const kState = inspectKitManifestForReview(root, kit)
    if (kState.state === 'absent') {
      add(finding('notice', 'kit', 'kit.missing',
        '还没有配备 `.agents/skills/` 开发技能套件——可运行 `node scripts/equip.mjs .` 装配并跟踪清单', {
          decision: 'no-kit',
        }))
    } else if (kState.state === 'corrupted') {
      add(finding('missing', 'kit', 'kit.drifted',
        `受管 \`.agents/skills/\` 套件异常（${kit.manifestPath} JSON 损坏或结构无效）——请运行 \`node scripts/equip.mjs .\` 修复`))
    } else if (kState.missingFiles.length > 0) {
      add(finding('missing', 'kit', 'kit.drifted',
        `受管 \`.agents/skills/\` 套件异常（缺失托管文件：${kState.missingFiles.slice(0, 4).join('、')}）——请运行 \`node scripts/equip.mjs .\` 修复`))
    } else if (kState.modifiedFiles.length > 0 || kState.versionMismatch) {
      const reasons = []
      if (kState.versionMismatch) reasons.push(`清单版本 ${kState.forgeVersion} 与当前工具版本不一致`)
      if (kState.modifiedFiles.length > 0) reasons.push(`${kState.modifiedFiles.length} 个文件被本地修改（${kState.modifiedFiles.slice(0, 3).join('、')}）`)
      add(finding('notice', 'kit', 'kit.drifted',
        `受管 \`.agents/skills/\` 存在漂移（${reasons.join('；')}）——可运行 \`node scripts/equip.mjs .\` 做无损升级或 \`--adopt-custom\` 豁免`))
    } else {
      const extraNote = kState.customCount > 0 ? `，已豁免定制 ${kState.customCount} 项` : ''
      add(finding('ok', 'kit', 'kit.ready',
        `受管 \`.agents/skills/\` 套件已就绪（${kState.filesCount} 个托管文件，版本 ${kState.forgeVersion ?? '未知'}${extraNote}）`))
    }
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

  const checkWorkflows = facts.docs.workflowFacts.checkWorkflows?.length
    ? facts.docs.workflowFacts.checkWorkflows
    : facts.docs.workflows
  if (facts.ecosystem.kinds.includes('docs-only')) {
    add(finding('ok', 'ci', 'ci.docs-only', '纯文档项目不需要跑构建的 CI'))
  } else if (facts.docs.workflowFacts.hasCheck) {
    add(finding('ok', 'ci', 'ci.present', `CI 有（${checkWorkflows.join('、')}）`))
  } else {
    add(finding('notice', 'ci', 'ci.absent',
      '没有 CI——本机能过不等于换台机器能过。一个人用的小工具不配也是合理的', {
        decision: 'no-ci',
        ref: { file: 'references/remote-github.md', section: '七、持续集成' },
      }))
  }

  const hasRemote = typeof facts.git.remote === 'string' && facts.git.remote.length > 0
    && facts.git.isRepoRoot !== false
  const caps = facts.git.capabilities ?? null
  const onGithub = facts.git.providerId
    ? (facts.git.providerId === 'github' || Boolean(facts.git.topology?.providerIds?.includes('github')))
    : (typeof facts.git.remote === 'string' && /github\.com/i.test(facts.git.remote))
  const canReleasePlatform = caps
    ? (caps.known === true && caps.releases === true)
    : onGithub
  const releaseWorkflows = facts.docs.workflowFacts.releaseWorkflows ?? []
  if (facts.docs.workflowFacts.hasRelease) {
    add(finding('ok', 'release', 'release.present',
      releaseWorkflows.length > 0 ? `发布自动化有（${releaseWorkflows.join('、')}）` : '发布自动化有'))
  } else if (hasRemote && onGithub && canReleasePlatform
    && facts.ecosystem.publishable && !facts.ecosystem.private && !decisions.has('no-release')) {
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

  // 发布说明留在工作区里没填完，打标签时自动化会把它原样贴到发布页上。
  const emptyNotes = collectUnfilledReleaseNotes(root)
  if (emptyNotes.length > 0) {
    add(finding('missing', 'release', 'release.notes-unfilled',
      `发布说明里还有没填完的占位：${emptyNotes.join('、')}——打标签时自动化会把它原样贴到发布页上，而且看起来是成功的`, {
        ref: { file: 'references/docs-set.md', section: '七、`RELEASING`' },
      }))
  }

  const staleCmds = collectStaleCommandsInfo(agentsText, facts)
  if (staleCmds) {
    add(finding('notice', 'agents', 'agents.commands-stale',
      `${facts.docs.agents.file} 里没提到这些实际存在的命令：${staleCmds.shown.join('、')}`
      + `（共 ${staleCmds.missingCount} 条、${staleCmds.totalBytes} 字节）`
      + '——契约里的构建与验证节已经和项目现状脱节，照着它跑会漏掉这一步', {
        ref: { file: 'references/docs-set.md', section: '三、`AGENTS.md`' },
      }))
  }

  const tagIssues = collectReleaseTagIssues(facts)
  if (tagIssues.bareVTags.length > 0) {
    add(finding('missing', 'release', 'release.observed-v-tag',
      `插件的 Git 标签带了 \`v\` 前缀（${tagIssues.bareVTags.slice(0, 3).join('、')}）——`
      + '这个生态要求标签与清单里的版本号逐字相同，带前缀会导致市场不收录、用户装不上。'
      + '工作流的触发行也要从 `v*` 改成数字开头', {
        ref: { file: 'references/plugin-ecosystems.md', section: 'Obsidian 插件' },
      }))
  }
  if (tagIssues.tagMismatch) {
    add(finding('notice', 'release', 'release.tag-mismatch',
      `清单版本是 ${tagIssues.version}，而标签里没有它（有 ${tagIssues.tags.slice(0, 4).join('、')}）——自动化按标签取版本，对不上就发错东西`, {
        ref: { file: 'references/publish.md', section: '三、版本号语义' },
      }))
  }
  if (tagIssues.mixedTagShapes) {
    add(finding('notice', 'release', 'release.tag-shape-mixed',
      `标签的写法不统一：${tagIssues.tags.length} 个里有 ${tagIssues.withV} 个带 \`v\` 前缀——混用两套形状时，`
      + '自动化的触发条件只能覆盖其中一种', {
        ref: { file: 'references/remote-github.md', section: '六、版本节点与发布说明' },
      }))
  }

  if (facts.docs.releasing && !facts.ecosystem.publishable && (facts.ecosystem.kinds ?? []).includes('skill')) {
    add(finding('ok', 'release', 'release.skill-dist', '能力目录靠克隆或复制分发，不经过制品库——这是正常结果'))
  }

  // ── 协作基础设施 ──────────────────────────────────────────────────
  if (!hasRemote || facts.git.role === 'local-only' || facts.git.providerId === 'none') {
    add(finding('ok', 'collaboration', 'collab.no-remote',
      hasRemote ? '已启用本地模式：跳过远端协作基础设施检查' : '没有远端：谈不上收别人的改动'))
  } else {
    if (caps && caps.known === false) {
      add(finding('notice', 'collaboration', 'collab.remote-unknown',
        `认不出 ${caps.providerId ?? '这个'} 远端能做什么（Issue / PR / 发布 / 检查状态），`
        + '所以下面这些能力一律按「不确定」处理，不假设它和 GitHub 一样', {
          decision: 'remote-setup',
          ref: { file: 'references/remote-github.md', section: '一、双轨四级连接引擎' },
        }))
    } else {
      const missingCaps = collectMissingRemoteCapabilities(caps)
      if (missingCaps.length > 0) {
        add(finding('notice', 'collaboration', 'collab.remote-capability-gap',
          `这个远端做不了：${missingCaps.join('、')}——不是没配好，是这条路在它上面不成立；`
          + '涉及这些能力的动作请改走它自己的流程，别照搬 GitHub 的命令', {
            decision: 'remote-setup',
            ref: { file: 'references/remote-github.md', section: '一、双轨四级连接引擎' },
          }))
      }
    }
    const supportsPr = caps ? caps.pullRequests === true : onGithub
    const supportsIssues = caps ? caps.issues === true : onGithub
    const supportsBranchProtection = caps ? caps.branchProtection === true : onGithub
    if (supportsPr && !facts.docs.prTemplate) {
      add(finding('notice', 'collaboration', 'collab.pr-template',
        '有远端却没有 PR 模板——别人提改动时不知道该说明什么，审查的人只能从代码反推意图', {
          decision: 'no-collab-templates',
          ref: { file: 'references/collaboration.md', section: '八、谁能合' },
        }))
    }
    if (supportsIssues && !facts.docs.issueTemplates) {
      add(finding('notice', 'collaboration', 'collab.issue-templates',
        '有远端却没有 Issue 模板——每份缺陷报告都要来回追问「环境是什么、怎么复现」', {
          decision: 'no-collab-templates',
          ref: { file: 'references/collaboration.md', section: '五、收到别人的 Issue' },
        }))
    }
    if (facts.docs.workflowFacts.usesPullRequestTarget && !facts.docs.workflowFacts.checkoutsPrHead) {
      add(finding('ok', 'collaboration', 'collab.prt-safe',
        '用了 `pull_request_target` 但没检出提案的代码（合法用法）'))
    }
    if (supportsBranchProtection && facts.git.role !== 'contributor-fork' && !decisions.has('no-ci')) {
      if (decisions.has('branch-protection')) {
        add(finding('ok', 'collaboration', 'collab.branch-protection.ok', '已在 AGENTS.md「取舍」登记默认分支开关 A 保护策略'))
      } else if (!decisions.has('no-branch-protection')) {
        add(finding('notice', 'collaboration', 'collab.branch-protection',
          '尚未在「取舍」确认默认分支保护（开关 A：禁直推/强推/删分支，禁默认要求他人审批）', {
            decision: 'no-branch-protection',
            ref: { file: 'references/remote-github.md', section: '三、仓库设置、Rulesets 与分支保护' },
          }))
      }
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

  // ── 没有业务内容时，「没有缺口」是一句假话 ────────────────────────
  //
  // 一个只装了套件的仓：代码文件 0 个、清单一个都没有、连形态都认不出。这时候
  // 构建、测试、技术设计文档、CI 这几条判据的**前提全都不存在**，于是它们一条都不报。
  // 把这些「因为没东西可查而沉默」读成「没有会出事的缺口」，正好是自洽的假绿——
  // 什么都没验，所以什么都没缺。
  //
  // 只有使用者能回答「这个仓是做什么的、业务内容放哪」，所以它落在**待定**档：
  // 报出来、等人表态，而不是被压掉。
  const noManifests = (facts.ecosystem.manifests ?? []).length === 0
  const blankProject = (facts.scale.codeFiles ?? 0) === 0
    && noManifests
    && !decisions.has('project-kind')
  if (blankProject) {
    add(finding('pending', 'ecosystem', 'ecosystem.blank-content',
      '这个仓里没有代码文件、也没有任何生态清单——构建、测试、技术设计文档、CI 这几面都因为「前提不存在」而没报，那不等于它们没问题。先定这个仓是做什么的、业务内容放哪', {
        decision: 'project-kind',
        // 这一条不是「另一个待办」，它说明**别的判据根本没跑起来**。
        // 结论句要据此改口：没跑过的检查不能拿来当「没有缺口」的证据。
        verdictBlocked: true,
      }))
  }

  const govPrdCov = checkGovernancePrdCoverage(root, facts)
  if (govPrdCov.checked) {
    if (govPrdCov.missing.length > 0) {
      const missLabels = govPrdCov.missing.map((m) => `${m.id}(${m.action})`).join('、')
      add(finding('missing', 'docs', 'docs.governance-prd-coverage',
        `全仓治理 PRD（${govPrdCov.prdFiles.join('、')}）的 C1..Cn 验收条目尚未覆盖产物计划中的待处置项：${missLabels}`))
    } else {
      add(finding('ok', 'docs', 'docs.governance-prd-coverage',
        `全仓治理 PRD（${govPrdCov.prdFiles.join('、')}）已完整覆盖产物计划待处置条目`))
    }
  }

  return summarizeReviewResults(facts, results)
}

// ── 命令行入口 ──────────────────────────────────────────────────────────────

async function main(argv) {
  return runReviewCli(argv, reviewProject)
}

export { main as runCli }

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2))
    .then((code) => flushAndExit(code))
    .catch((err) => {
      process.stderr.write(`体检失败：${err instanceof Error ? err.message : String(err)}\n`)
      return flushAndExit(2)
    })
}
