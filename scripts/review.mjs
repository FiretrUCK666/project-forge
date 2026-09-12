#!/usr/bin/env node
/**
 * review.mjs —— 目标项目交付门禁（P4/P5 是否写完，机器说了算）
 *
 * 存在的理由：P4/P5 的完成标准里只有 AGENTS.md 有机器数（双数字归零），
 * README/双语/徽章/LICENSE/工作流全靠“汇报里写明”——没有机器门的东西，
 * AI 一忙就忘，忘了一点声音都没有。所以这里把“写完”变成可执行的检查：
 *
 *   node scripts/review.mjs <项目目录> [决策 flag...]
 *
 * 状态只有三种：
 *   [齐]   事实已满足；
 *   [缺]   事实缺失且无用户决策 → 退出码 1，必须补；
 *   [待问] 机器判不了，需要问用户 → 问完用对应的 --no-* flag 把答案记下来再跑，
 *           不允许“没问就当不要”。flag 本身就是用户答复的机器载体。
 *
 * 退出码：0 = 无[缺]（[待问]须已用 flag 消掉）；1 = 有[缺]或用法错误。
 * 只读（会跑 check-badges 联网验徽章，离线时如实报跳过）；不写任何文件。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { survey } from './survey.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const KERNEL_START = '<!-- project-forge:kernel:start -->'
const KERNEL_END = '<!-- project-forge:kernel:end -->'
const AUTHOR_RE = /<!--\s*pf:author\s*(?::[\s\S]*?)?-->/g

const FLAGS = new Set([
  '--no-bilingual', // 用户确认：单语即可，不要英文版
  '--no-contributing', // 用户确认：自用项目，不要贡献指南
  '--private-no-license', // 用户确认：保留所有权利，不落盘 LICENSE
  '--no-ci', // 用户确认：暂不要 CI
  '--no-auto-release', // 用户确认：暂不要自动发布
  '--secrets-reviewed', // 用户确认：已按密钥门控逐条核对剩余命中，均为占位或测试数据
  '--strict', // 严格模式：待问事项同样拦住（exit 2），用于 CI；默认待问只提示不拦
])

function readText(p) {
  try {
    return readFileSync(p, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

function parseArgs(argv) {
  const positional = []
  const flags = new Set()
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') return { help: true }
    if (a.startsWith('--')) {
      if (!FLAGS.has(a)) throw new Error(`无法识别的参数：${a}（可用：${[...FLAGS].join('、')}）`)
      flags.add(a)
      continue
    }
    positional.push(a)
  }
  return { target: positional[0] ?? process.cwd(), flags }
}

/** 跑徽章检查。返回 ok / bad / offline / nobadge 四态，不抛错。 */
function checkBadges(root, readmes) {
  if (readmes.length === 0) return { state: 'nobadge' }
  const r = spawnSync(process.execPath, [join(HERE, 'check-badges.mjs'),
    ...readmes.map((f) => join(root, f))], { encoding: 'utf8' })
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  if (/没有徽章/.test(out)) return { state: 'nobadge' }
  if (/显示不出来/.test(out)) return { state: 'bad', detail: out }
  if (/没能检查|请求失败|注意：/.test(out)) return { state: 'offline' }
  return { state: 'ok' }
}

function main(argv) {
  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`)
    return 2
  }
  if (parsed.help) {
    process.stdout.write(
      '用法：node scripts/review.mjs <项目目录> [--no-bilingual] [--no-contributing]\n'
      + '      [--private-no-license] [--no-ci] [--no-auto-release] [--secrets-reviewed] [--strict]\n\n'
      + '  无[缺]即退出码 0。[待问]必须问用户后用对应 flag 消掉，不许默跳。\n'
      + '  默认[待问]不拦（exit 0 但结论写“还有待问”）；--strict 下[待问]同样拦住（exit 2），用于 CI。\n'
      + '  无对应 flag 的[待问]（徽章离线、DSH 挂载建议、英文模板、纯文档构建命令）只能改文件消掉。\n',
    )
    return 0
  }
  const { target, flags } = parsed
  const root = resolve(target)

  let s
  try {
    s = survey(root)
  } catch (error) {
    process.stderr.write(`勘察失败：${error instanceof Error ? error.message : String(error)}\n`)
    return 2
  }

  const missing = []
  const pending = []
  const ok = []
  const line = (st, text) => process.stdout.write(`  [${st}] ${text}\n`)
  process.stdout.write(`交付门禁：${s.target.name}（${s.target.path}）\n`)

  // 1. AGENTS.md：一致性真相源是 compose --check 的字节比对，本门只转述。
  // 自己另起一套“有标记即一致”必然漂移其一，故不自判，只调用。
  const agentsPath = join(root, 'AGENTS.md')
  const agents = readText(agentsPath)
  if (agents === undefined) {
    missing.push('AGENTS.md 缺失')
  } else {
    const authors = (agents.match(AUTHOR_RE) ?? []).length
    const kernel = agents.includes(KERNEL_START) && agents.includes(KERNEL_END)
    if (!kernel) {
      missing.push('AGENTS.md 缺少内核标记（跑 compose-agents 生成或升级）')
    } else if (authors > 0) {
      missing.push(`AGENTS.md 待填写 ${authors} 处（读代码填实，删标记）`)
    } else {
      const cc = spawnSync(process.execPath, [join(HERE, 'compose-agents.mjs'), root, '--check'],
        { encoding: 'utf8' })
      const ccOut = `${cc.stdout ?? ''}\n${cc.stderr ?? ''}`
      if (cc.status !== 0) {
        const first = ccOut.split('\n').map((l) => l.trim()).filter(Boolean)
          .find((l) => /缺失|不一致/.test(l)) ?? '与模板不一致或有缺节'
        missing.push(`AGENTS.md 未通过 compose --check：${first}（跑 compose-agents 补齐重验）`)
      } else {
        ok.push('AGENTS.md 通过 compose --check（内核一致、待填写归零）')
      }
    }
  }

  // 2. 提交署名：没有仓库时跳过（P3 建库时再定）；有仓库而署名缺失必须补——
  // 否则首个提交永久带着错误署名。占位值靠人眼（G7），机器只卡缺失。
  const git = s.git ?? {}
  if (git.present === true) {
    const id = git.identity ?? {}
    if (!id.name || !id.email) {
      missing.push('提交署名缺失（只写仓库级，见版本管理署名审计清单）')
    } else {
      ok.push(`提交署名有（${id.name}，${id.scope === 'repo' ? '仓库级' : '继承全局'}；占位值须人眼确认）`)
    }
  }

  // 2b. 上游跟踪：有远端而未设跟踪时，首推需显式指定。只提示，不阻断。
  if (git.present === true && typeof git.remote === 'string' && git.remote.length > 0
    && git.upstream === undefined && git.isRepoRoot !== false) {
    pending.push('上游跟踪未设置：首推用显式分支并设跟踪（改文件消不掉，推一次即有）')
  }

  // 2c. 标签与版本号：只报事实比对，不下结论（形生态各异，见 publish.md）。
  if (s.artifacts?.declaredVersion !== undefined && s.artifacts?.versionAligned === false) {
    pending.push(`标签与版本号未对齐：清单 ${s.artifacts.declaredVersion}，标签 ${(s.artifacts.versionAlignedTags ?? []).join('、') || '无'}（自动化会对不上，先确认）`)
  }

  // 2d. 密钥与扫描可信度：凭据命中即拦；扫描被截断时“无命中”不可信，转待问。
  // 这是 G2 的机器落点：人不记得扫描，门就替他记得。
  const risks = s.risks ?? {}
  const secretHits = [...(risks.secretFiles ?? []), ...(risks.secretContent ?? [])]
  if (secretHits.length > 0) {
    if (flags.has('--secrets-reviewed')) ok.push(`凭据命中 ${secretHits.length} 处（用户已按门控确认为占位或测试数据）`)
    else missing.push(`凭据形状 ${secretHits.length} 处（按版本管理密钥门控分案处置后重跑；确认为占位或测试数据时加 --secrets-reviewed，位置见勘察报告）`)
  }
  if (risks.contentScan?.truncated === true) {
    pending.push('内容扫描被截断：“无命中”不可信，提高上限重扫或在汇报里写明覆盖范围')
  }

  // 2e. 忽略规则：未忽略的产物目录与“已跟踪又被忽略”是提交前必须消掉的两项。
  const ig = s.ignores ?? {}
  if (Array.isArray(ig.unignoredOutputDirs) && ig.unignoredOutputDirs.length > 0) {
    missing.push(`未忽略的产物目录：${ig.unignoredOutputDirs.join('、')}（下次提交会整个写进历史，先补忽略规则）`)
  }
  if (Array.isArray(ig.ignoredButTracked) && ig.ignoredButTracked.length > 0) {
    pending.push(`已被跟踪又被忽略 ${ig.ignoredButTracked.length} 个（忽略对它们无效，需从索引移除；确认后逐个处理）`)
  }
  if (ig.gitattributes === undefined && git.present === true) {
    pending.push('文本属性声明缺失：首次提交前补上，否则跨机器产物字节不可复现')
  }
  // 3. README：必须有；双语要么成对，要么用户明确说单语。
  const readmes = s.docs?.readme ?? []
  if (readmes.length === 0) {
    missing.push('README 缺失')
  } else {
    ok.push(`README 有（${readmes.join('、')}）`)
    if (s.docs?.readmePair !== undefined) ok.push('双语 README 成对')
    else if (flags.has('--no-bilingual')) ok.push('单语（用户已确认不要英文版）')
    else pending.push('双语：只有一份 README，问用户要不要英文版（要→补，不要→加 --no-bilingual）')
  }

  // 4. 徽章：有就必须验（联网跑 check-badges，离线如实报）；没有徽章不强求。
  const badgeResult = checkBadges(root, readmes)
  if (badgeResult.state === 'bad') missing.push('徽章显示不出来（见上文输出，删掉或修好）')
  else if (badgeResult.state === 'offline') pending.push('徽章未能联网验证：在汇报里写明未验及原因')
  else ok.push(badgeResult.state === 'ok' ? '徽章全部可显示' : '无徽章（可选，不强求）')

  // 5. CONTRIBUTING / LICENSE：缺了必须问，不能默跳；有了要看内容是否齐全。
  // 内容检查只认关键词的有无，不判措辞好坏：措辞无法用机器判，判了就是误报源。
  if (s.docs?.contributing !== undefined) {
    ok.push('CONTRIBUTING 有')
    const contributingFile = typeof s.docs.contributing === 'string'
      ? s.docs.contributing
      : s.docs.contributing.file
    const contributing = readText(join(root, contributingFile)) ?? ''
    const coreChecks = [
      [/提问|Issue|反馈/, '提问与反馈'],
      [/fork/i, 'fork 指引'],
      [/分支|branch/i, '分支指引'],
      [/门禁|全绿|测试|构建/, '提交前门禁'],
      [/AGENTS\.md/, 'AGENTS 指向'],
      [/许可|LICENSE/, '许可'],
    ]
    for (const [re, label] of coreChecks) {
      if (!re.test(contributing)) missing.push(`CONTRIBUTING 缺${label}（补对应节，见 docs-set 第五节通用骨架）`)
    }
    const kinds = s.ecosystem?.kinds ?? []
    const isNode = kinds.includes('node')
    const isPlugin = kinds.some((k) => /plugin|extension/.test(k))
    const isDsh = kinds.includes('dsh-plugin')
    const isDocsOnly = kinds.includes('docs-only')
    if (isNode && !/(npm|pnpm|yarn|bun|安装依赖|安装)/.test(contributing)) {
      missing.push('CONTRIBUTING 缺包管理器或安装说明（node 项目：沿用它自己的包管理器）')
    }
    if (isPlugin) {
      if (!/(产物|一起提交)/.test(contributing)) {
        missing.push('CONTRIBUTING 缺产物同提交（插件类：安装方不构建，产物缺了即加载失败）')
      }
      if (!/(主干|标签|发布)/.test(contributing)) {
        missing.push('CONTRIBUTING 缺三类越权（不推主干、不打标签、不发布）')
      }
    }
    if (isDsh && !/(挂载|重启|刷新|分发)/.test(contributing)) {
      pending.push('CONTRIBUTING 可补本地挂载与生效规则（DSH 插件：两条路差别是最高频问题）')
    }
    if (isDocsOnly && /```sh[\s\S]*?(npm|pnpm|cargo|pytest|go test)/.test(contributing)) {
      pending.push('纯文档项目的 CONTRIBUTING 含构建命令：确认是否真的需要开发环境节')
    }
  }
  else if (flags.has('--no-contributing')) ok.push('无 CONTRIBUTING（用户已确认自用）')
  else pending.push('CONTRIBUTING 缺失：问用户会不会给别人用（会→补，不会→加 --no-contributing）')
  if (s.docs?.license !== undefined) ok.push('LICENSE 有')
  else if (flags.has('--private-no-license')) ok.push('无 LICENSE（用户已选保留所有权利）')
  else pending.push('LICENSE 缺失：问用户选哪个许可证（保留权利→加 --private-no-license）')

  // 6. 工作流：CI 与自动发布要么落盘，要么用户明确说暂不要。
  // 6b. DSH 插件：只在判定为 dsh-plugin 时检查，不猜取值。
  const dshKinds = s.ecosystem?.kinds ?? []
  if (dshKinds.includes('dsh-plugin') && s.dsh !== undefined) {
    const d = s.dsh
    if (d.filesHasLib === false) missing.push('DSH 发布范围缺 lib（成品包路线要求 files 含构建产物，以 pack 清单为准）')
    if (d.filesHasPatch === false) missing.push('DSH 发布范围缺补丁（声明 bundle 时 files 应含补丁文件）')
    if (d.libTracked === true && d.filesHasLib !== true) {
      missing.push('DSH 产物跟踪与发布范围矛盾：lib 被跟踪但 files 未含，先定成品还是源码路线')
    }
    if (d.hostRuntimeInDeps === true) missing.push('DSH 依赖放错：宿主运行时进了 dependencies，应为 peer')
    if (d.discoveryCarrierLikely === false) {
      missing.push('DSH 发现载体可能缺失：补丁文本里没有出现包名（补 name 等于包名自身的一行）')
    }
    if ((d.hasClientEntry === true) !== (d.hasClientDecl === true)) {
      pending.push('DSH 三态不明：exports 与 dsh.client 声明打架，先对齐再定 host-only 还是双面')
    }
  }
  // 非 DSH 插件：无专属门禁，按通用协议六问核对产物与标识（无专章时现场查宿主文档）。
  if (dshKinds.some((k) => /plugin|extension/.test(k)) && !dshKinds.includes('dsh-plugin')) {
    pending.push('非 DSH 插件：按通用协议核对产物同提交、两标识与挂载分发两条路（见 plugin-project.md）')
  }
  // Obsidian 发布三件套：缺 main.js 即安装断链。
  if (dshKinds.includes('obsidian-plugin') && s.artifacts?.obsidianArtifacts !== undefined
    && s.artifacts.obsidianArtifacts.mainJs !== true) {
    missing.push('Obsidian 产物缺 main.js（安装时从发布下载三件，缺一件即断链）')
  }

  // 6c. 本地 skills：只盘点，不强求；已有被改坏才拦。
  if (Array.isArray(s.localSkills) && s.localSkills.length > 0) {
    ok.push(`本地 skills 有（${s.localSkills.map((x) => x.path).join('、')}）`)
    for (const x of s.localSkills) {
      if (x.corrupt === true) missing.push(`本地 skill 损坏：${x.path} 缺 SKILL.md 或首部非法`)
      else if (x.nameOk === false) missing.push(`本地 skill 名实不符：${x.path} 目录名与 name 不一致`)
      else if (x.descriptionHead === undefined || x.descriptionHead.length < 10) {
        pending.push(`本地 skill 描述过短：${x.path}（触发语不明，改完再验）`)
      }
    }
  }
  const auto = s.docs?.workflowAutomation
  if (auto === undefined || auto.files.length === 0) {
    if (flags.has('--no-ci')) ok.push('无 CI（用户已确认暂不要）')
    else pending.push('CI 缺失：问用户要不要检查自动化与自动发布（不要→加 --no-ci，不要默跳）')
  } else {
    ok.push(`工作流有（${auto.files.join('、')}）`)
    if (auto.truncated === true && auto.hasReleaseJob !== true) {
      pending.push(`工作流只读了前 ${auto.headLimit ?? '若干'} 字符：“无发布 job”不可信，大文件需手工确认后再定`)
    }
    if (s.artifacts?.publishableManifest !== undefined && s.artifacts?.private !== true) {
      if (auto.hasReleaseJob) {
        ok.push('发布 job 有')
        // 英文回退确认：纯 --generate-notes 出来是英文模板（首版更是白卷）。
        // 有 notes-file 模式即中文链；没有就必须问一句，不能默认英文可接受。
        if (!auto.usesNotesFile && auto.usesGenerateNotes) {
          pending.push('发布说明是英文模板模式：确认英文可接受，否则换 notes-file 中文链（见模板 TODO(2)）')
        }
      }
      else if (flags.has('--no-auto-release')) ok.push('无发布 job（用户已确认暂不要自动发布）')
      else pending.push('发布 job 缺失：可发布项目问用户要不要自动写 Release（不要→加 --no-auto-release）')
    }
  }

  // 6d. 生态发布门禁：只判本生态清单事实，不拼他生态命令。
  const ecoKinds = s.ecosystem?.kinds ?? []
  if (ecoKinds.includes('python') && s.artifacts?.pythonBuild !== undefined
    && s.artifacts.pythonBuild.hasBuildSystem !== true) {
    pending.push('Python 缺构建后端声明：无 [build-system] 即无权威构建入口，补上再定发布预演')
  }
  if (ecoKinds.includes('go') && s.artifacts?.goModule !== undefined
    && s.artifacts.goModule.goDirective === undefined) {
    pending.push('Go 缺 go 指令：最低版本不明，补上再定兼容承诺')
  }
  if (ecoKinds.includes('rust') && s.artifacts?.cargoMeta !== undefined) {
    if (s.artifacts.cargoMeta.license !== true) missing.push('Rust 缺 license 声明（发布必填其一：license 或 license-file）')
    if (s.artifacts.cargoMeta.description !== true) missing.push('Rust 缺 description 声明（发布必填）')
  }

  for (const t of ok) line('齐', t)
  for (const t of pending) line('待问', t)
  for (const t of missing) line('缺', t)
  if (missing.length > 0) {
    process.stdout.write(`\n结论：${missing.length} 处缺失，补完重跑。待问事项问完用户后用 flag 消掉。\n`)
    return 1
  }
  if (pending.length > 0) {
    if (flags.has('--strict')) {
      process.stdout.write(`\n结论：--strict 下 ${pending.length} 处待问同样拦住，问完消掉重跑。\n`)
      return 2
    }
    process.stdout.write('\n结论：无缺失，但有待问事项——问完用户、加 flag 重跑，全齐才算交付。\n')
    return 0
  }
  process.stdout.write('\n结论：全部齐备，可以交付。\n')
  return 0
}

process.exitCode = main(process.argv)
