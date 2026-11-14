#!/usr/bin/env node
/**
 * doc-plan.mjs —— 五档需求分流、四层工程文档生成、SPEC 批准与实时全景扫描。
 *
 * 子命令：
 *   triage  --summary <text> [--files <n>] [--touches-contract] [--conflicts-tdd] [--doc-only] [--bugfix] [--json]
 *   init    --type prd|spec|todo --slug <slug> --title <title> [--task <id>] [--spec <path>] [--force] [--json]
 *   approve --file <specPath> [--json]
 *   list    [--json]
 */

import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  createDefaultLedger, ensureWorktreesIgnored, gitRun, isMainModule,
  parseAgentsProfile, posixPath, printNextStep, readTaskLedger, readTextSafe,
  resolveRepoRoots, sanitizeTaskId, slugify, writeAtomic, writeTaskLedger,
} from '../../lib/shared.mjs'

function yymmdd(date = new Date()) {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

function isoDate(date = new Date()) {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function scanActiveContracts(root) {
  const contracts = { tdd: existsSync(join(root, 'docs', 'TDD.md')), activeSpecs: [] }
  const specsDir = join(root, 'docs', 'specs')
  if (!existsSync(specsDir)) return contracts
  try {
    for (const name of readdirSync(specsDir).filter((n) => n.endsWith('.md')).sort()) {
      const text = readTextSafe(join(specsDir, name)) ?? ''
      const status = /^-\s+Status:\s*(\S+)/mi.exec(text)?.[1]?.toLowerCase() ?? 'unknown'
      if (status === 'approved' || status === 'implemented') {
        contracts.activeSpecs.push({ file: `docs/specs/${name}`, status })
      }
    }
  } catch { /* 忽略不可读目录 */ }
  return contracts
}

/** 严格五档分流判定逻辑。 */
export function triageTask({
  summary = '',
  files,
  touchesContract = false,
  conflictsTdd = false,
  docOnly = false,
  bugfix = false,
  repoRoot,
} = {}) {
  const text = String(summary ?? '').trim()
  const fileCount = Number.isFinite(files) ? Number(files) : undefined
  const activeContracts = repoRoot ? scanActiveContracts(repoRoot) : { tdd: false, activeSpecs: [] }

  const conflictRe = /(?:conflicts?\s+(?:with\s+)?tdd|与\s*tdd\s*冲突|打破\s*tdd|推翻.*(?:架构|契约|spec)|违背.*(?:tdd|spec))/i
  const contractRe = /(?:跨模块|cross[- ]?module|external\s+contract|breaking\s+change|外部契约|接口变更|协议变更|schema\s*变更|架构重构|新增命令|新增子命令|api\s*契约|refactor\s+architecture)/i
  const bugRe = /\b(?:fix|bug|bugfix|hotfix|crash|regression)\b|修复|报错|异常|缺陷|故障|崩溃|修一下|复现/i
  const docRe = /\b(?:typo|docs?(?:-only)?|readme|comment|explain|question)\b|文档|错别字|注释|问答|翻译|拼写|解释/i
  const explicitFeatureRe = /\b(?:feat|feature|implement)\b|新功能|新增功能|开发/i

  // Case 5: 与 docs/TDD.md 或生效 SPEC 冲突 -> 硬阻断
  if (conflictsTdd || conflictRe.test(text)) {
    return {
      caseType: 5,
      tier: 3,
      blocked: true,
      action: 'BLOCK_UPDATE_TDD_FIRST',
      reason: '该需求与 docs/TDD.md 或生效 SPEC 存在架构/契约冲突，必须先更新 TDD.md 并获人类确认后再拆解。',
      docsRequired: ['docs/TDD.md (先更新并确认)'],
      redGreenRequired: true,
      needsReview: true,
      specApprovalRequired: true,
      activeContracts,
    }
  }

  // Case 4: L3 跨模块 / 改外部契约 -> docs/specs/ + docs/todo/
  if (touchesContract || (fileCount !== undefined && fileCount >= 6) || contractRe.test(text)) {
    return {
      caseType: 4,
      tier: 2,
      blocked: false,
      action: 'SPEC_AND_TODO',
      reason: '涉及跨模块协作或外部契约变更（L3），需先编写 SPEC 经确认后，再落地 Todo 与实现。',
      docsRequired: ['docs/specs/', 'docs/todo/'],
      optionalDocs: ['docs/prd/'],
      redGreenRequired: true,
      needsReview: true,
      specApprovalRequired: true,
      activeContracts,
    }
  }

  // Case 1: 纯文档 / 问答 / 错别字 -> 0 文档
  const looksDocOnly = docOnly || (
    docRe.test(text) && !bugRe.test(text) && !explicitFeatureRe.test(text)
    && (fileCount === undefined || fileCount <= 2)
  )
  if (looksDocOnly) {
    return {
      caseType: 1,
      tier: 1,
      blocked: false,
      action: 'NO_DOC_DIRECT',
      reason: '属于文档完善或问答/错别字修正（Case 1），无需新增规划文档。',
      docsRequired: [],
      redGreenRequired: false,
      needsReview: false,
      specApprovalRequired: false,
      activeContracts,
    }
  }

  // Case 2: 明确局部 bugfix 且不改外部契约 -> 0 文档，但强制 Red-Green 回归测试
  if (bugfix || (bugRe.test(text) && !explicitFeatureRe.test(text) && (fileCount === undefined || fileCount <= 3))) {
    return {
      caseType: 2,
      tier: 1,
      blocked: false,
      action: 'NO_DOC_RED_GREEN',
      reason: '属于明确局部缺陷修复（Case 2），不建规划文档，但强制先补失败复现测试再修复（Red-Green）。',
      docsRequired: [],
      redGreenRequired: true,
      needsReview: false,
      specApprovalRequired: false,
      activeContracts,
    }
  }

  // Case 3: L2 局部功能不改外部契约 -> 只建 docs/todo/
  return {
    caseType: 3,
    tier: 2,
    blocked: false,
    action: 'TODO_ONLY',
    reason: '属于不改变外部契约的局部功能开发（L2），只需建立 docs/todo/ 冻结验收标准。',
    docsRequired: ['docs/todo/'],
    redGreenRequired: true,
    needsReview: true,
    specApprovalRequired: false,
    activeContracts,
  }
}

async function initDoc({
  repoRoot,
  mainRoot,
  gitDir,
  isGit,
  type,
  slug,
  title,
  taskId,
  relatedSpec,
  force = false,
}) {
  if (!['prd', 'spec', 'todo'].includes(type)) {
    throw new Error(`--type 必须是 prd、spec 或 todo，收到：${type}`)
  }
  const safeSlug = slugify(slug)
  const dateTag = yymmdd()
  const today = isoDate()
  const dirMap = { prd: 'docs/prd', spec: 'docs/specs', todo: 'docs/todo' }
  const relFile = `${dirMap[type]}/${dateTag}-${safeSlug}.md`
  const absFile = join(repoRoot, relFile)

  if (existsSync(absFile) && !force) {
    throw new Error(`目标文件已存在：${relFile}（如确需重建请加 --force）`)
  }

  const headRes = await gitRun(repoRoot, ['rev-parse', 'HEAD'])
  const headSha = headRes.ok && headRes.stdout ? headRes.stdout.trim() : 'uncommitted'
  const profile = parseAgentsProfile(repoRoot)
  const quickCmd = profile.quickTest ?? '<填写项目快测命令>'

  let content = ''
  if (type === 'prd') {
    content = [
      `# PRD: ${title}`,
      '',
      `- Created: ${today}`,
      `- Slug: ${safeSlug}`,
      '- Status: draft',
      '',
      '## 背景与目标',
      '',
      '<!-- 一两段说清用户痛点与预期业务收益 -->',
      '',
      '## 目标用户与场景',
      '',
      '- 主要使用者：',
      '- 核心使用路径：',
      '',
      '## 范围边界（做什么 / 不做什么）',
      '',
      '- 做：',
      '- 不做：',
      '',
      '## 验收标准（动手之前冻结）',
      '',
      '- [ ] C1: <第一条可判定的产品结果>',
      '- [ ] C2: <第二条>',
      '',
    ].join('\n')
  } else if (type === 'spec') {
    content = [
      `# SPEC: ${title}`,
      '',
      `- Created: ${today}`,
      `- Slug: ${safeSlug}`,
      '- Status: draft',
      '- Related PRD: 无',
      '',
      '## 目标与约束',
      '',
      '<!-- 明确本次变更的目标、边界以及不得破坏的既有不变量 -->',
      '',
      '## 接口与数据契约',
      '',
      '<!-- 列出新增或变更的 CLI、导出函数、数据结构或文件格式 -->',
      '',
      '## 影响范围',
      '',
      '- 预计涉及目录/模块：',
      '',
      '## 验收标准（动手之前冻结）',
      '',
      '- [ ] C1: <第一条可判定的标准>',
      '- [ ] C2: <第二条>',
      '',
      '## 实现说明',
      '',
      '<!-- 在合并之前补齐真实实现摘要与验证结果 -->',
      '',
    ].join('\n')
  } else {
    content = [
      `# Todo: ${title}`,
      '',
      `- Task: ${taskId ?? safeSlug}`,
      `- Created: ${today}`,
      `- Planned at: ${headSha}`,
      '- Status: pending',
      `- Related SPEC: ${relatedSpec ?? '无'}`,
      '',
      '## 影响范围',
      '',
      '- 预计改动文件：待补充',
      `- 快测命令：\`${quickCmd}\``,
      '',
      '## 验收标准（动手之前冻结）',
      '',
      '- [ ] C1: <第一条可判定的标准>',
      '- [ ] C2: <第二条>',
      '',
      '## 执行步骤',
      '',
      `1. 先补齐复现或验收测试 —— 验证：\`${quickCmd}\``,
      `2. 实现核心改动并补齐反面用例 —— 验证：\`${quickCmd}\``,
      '',
      '## 完成后的记录',
      '',
      '**在合并之前写完，随这次改动一起提交。**',
      '',
      '- 验证命令与结果：',
      '- 遇到的问题与回避方式：',
      '',
    ].join('\n')
  }

  mkdirSync(dirname(absFile), { recursive: true })
  writeAtomic(absFile, content)

  // 若关联了任务账本，自动创建（若尚无）或回写路径
  let ledgerUpdated = false
  if (taskId) {
    if (isGit) await ensureWorktreesIgnored(mainRoot, gitDir)
    const id = sanitizeTaskId(taskId)
    const ledger = readTaskLedger(mainRoot, id) ?? createDefaultLedger({
      taskId: id,
      slug: safeSlug,
      isolation: null,
      status: 'planned',
    })
    if (type === 'prd') ledger.prdFile = relFile
    else if (type === 'spec') ledger.specFile = relFile
    else ledger.todoFile = relFile
    writeTaskLedger(mainRoot, ledger)
    ledgerUpdated = true
  }

  return { type, file: relFile, absFile, plannedAt: headSha, ledgerUpdated }
}

function approveSpec({ repoRoot, file }) {
  const abs = resolve(repoRoot, file)
  if (!existsSync(abs)) {
    throw new Error(`找不到 SPEC 文件：${file}`)
  }
  const text = readTextSafe(abs)
  if (text === undefined) throw new Error(`无法读取文本文件：${file}`)

  const statusMatch = /^(-\s+Status:\s*)(\S+)(\s*)$/mi.exec(text)
  if (!statusMatch) {
    throw new Error(`${file} 缺少「- Status: draft」字段，无法切换状态`)
  }
  const curStatus = statusMatch[2].toLowerCase()
  if (curStatus === 'superseded' || curStatus === 'implemented') {
    throw new Error(`${file} 当前状态为 ${curStatus}，不允许直接 approve`)
  }

  if (!/^- \[[ xX]\] C1\b/m.test(text)) {
    throw new Error(`${file} 至少需要包含一条「- [ ] C1: ...」可判定验收标准才可批准`)
  }

  const hasPlaceholder = /^- \[[ xX]\] C\d+:\s*<[^>]+>/m.test(text)
  const updated = text.replace(
    /^(-\s+Status:\s*)\S+(\s*)$/mi,
    '$1approved$2',
  )
  writeAtomic(abs, updated)

  return {
    file: posixPath(relative(repoRoot, abs)),
    previousStatus: curStatus,
    status: 'approved',
    warning: hasPlaceholder ? '检测到仍有占位描述 <...>，动手实现前请替换成真实可判定条件' : null,
  }
}

function collectMarkdownFiles(dir, root) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectMarkdownFiles(full, root))
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.push({ rel: posixPath(relative(root, full)), abs: full })
    }
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function summarizeDoc(item) {
  const text = readTextSafe(item.abs) ?? ''
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? basename(item.rel)
  const status = /^-\s+Status:\s*(\S+)/mi.exec(text)?.[1]?.trim() ?? null
  const created = /^-\s+Created:\s*(\S+)/mi.exec(text)?.[1]?.trim() ?? null
  const plannedAt = /^-\s+Planned at:\s*(\S+)/mi.exec(text)?.[1]?.trim() ?? null
  const totalChecks = (text.match(/^- \[[ xX]\]/gm) ?? []).length
  const doneChecks = (text.match(/^- \[[xX]\]/gm) ?? []).length
  return { file: item.rel, title, status, created, plannedAt, totalChecks, doneChecks }
}

export function listDocs(repoRoot) {
  const tddPath = join(repoRoot, 'docs', 'TDD.md')
  const tdd = existsSync(tddPath)
    ? summarizeDoc({ rel: 'docs/TDD.md', abs: tddPath })
    : null
  const prds = collectMarkdownFiles(join(repoRoot, 'docs', 'prd'), repoRoot).map(summarizeDoc)
  const specs = collectMarkdownFiles(join(repoRoot, 'docs', 'specs'), repoRoot).map(summarizeDoc)
  const todos = collectMarkdownFiles(join(repoRoot, 'docs', 'todo'), repoRoot).map(summarizeDoc)
  const archived = collectMarkdownFiles(join(repoRoot, 'docs', 'archive'), repoRoot).map(summarizeDoc)
  return { tdd, prds, specs, todos, archived }
}

function parseCli(argv) {
  const sub = argv[0]
  const opts = { _: [] }
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--json') opts.json = true
    else if (a === '--touches-contract') opts.touchesContract = true
    else if (a === '--conflicts-tdd') opts.conflictsTdd = true
    else if (a === '--doc-only') opts.docOnly = true
    else if (a === '--bugfix') opts.bugfix = true
    else if (a === '--force') opts.force = true
    else if (a.startsWith('--')) {
      const eq = a.indexOf('=')
      if (eq > 0) {
        opts[a.slice(2, eq)] = a.slice(eq + 1)
      } else {
        opts[a.slice(2)] = argv[i + 1]
        i += 1
      }
    } else {
      opts._.push(a)
    }
  }
  return { sub, opts }
}

function printHelp() {
  process.stdout.write([
    '用法：node .agents/skills/dev-plan/scripts/doc-plan.mjs <子命令> [选项]',
    '',
    '子命令：',
    '  triage   --summary <文本> [--files <n>] [--touches-contract] [--conflicts-tdd] [--json]',
    '  init     --type <prd|spec|todo> --slug <slug> --title <标题> [--task <id>] [--json]',
    '  approve  --file <specPath> [--json]',
    '  list     [--json]',
  ].join('\n') + '\n')
}

async function main(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }

  const { sub, opts } = parseCli(argv)
  if (opts.help) { printHelp(); return 0 }

  const targetDir = resolve(opts.dir ?? process.cwd())
  const roots = await resolveRepoRoots(targetDir)
  const repoRoot = roots.isGit ? roots.workTreeRoot : targetDir
  const mainRoot = roots.isGit ? roots.mainRoot : targetDir

  try {
    if (sub === 'triage') {
      const summary = opts.summary ?? opts._.join(' ')
      if (!summary) throw new Error('triage 需要传入 --summary "<需求描述>"')
      const filesNum = opts.files !== undefined ? Number(opts.files) : undefined
      const result = triageTask({
        summary,
        files: filesNum,
        touchesContract: Boolean(opts.touchesContract),
        conflictsTdd: Boolean(opts.conflictsTdd),
        docOnly: Boolean(opts.docOnly),
        bugfix: Boolean(opts.bugfix),
        repoRoot,
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      } else {
        process.stdout.write(`分流结论：Case ${result.caseType} (${result.action})${result.blocked ? ' [BLOCKED]' : ''}\n`)
        process.stdout.write(`- 理由: ${result.reason}\n`)
        process.stdout.write(`- 必建文档: ${result.docsRequired.join(', ') || '无 (0 文档)'}\n`)
        process.stdout.write(`- Red-Green 回归测试: ${result.redGreenRequired ? '强制' : '不需要'} | 独立审查: ${result.needsReview ? '需要' : '低风险免除'}\n`)
        if (result.caseType === 5) {
          printNextStep([
            '已阻断直接拆解！请先更新 docs/TDD.md 解决冲突并取得维护者确认，然后再重新分流。',
          ])
        } else if (result.caseType === 4) {
          printNextStep([
            '1. 创建 SPEC: node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --type spec --slug <slug> --title "<标题>"',
            '2. 填好 C1..Cn 后请维护者确认：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file <specPath>',
            '3. 创建 Todo 并启动实施隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 4',
          ])
        } else if (result.caseType === 3) {
          printNextStep([
            '1. 启动任务隔离：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case 3 --slug <slug>',
            '2. 生成 Todo：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" init --type todo --slug <slug> --title "<标题>" --task <id>',
          ])
        } else {
          printNextStep([
            `启动任务流转：node ".agents/skills/dev-flow/scripts/flow.mjs" start --task <id> --case ${result.caseType} --slug <slug>`,
          ])
        }
      }
      return 0
    }

    if (sub === 'init') {
      if (!opts.type || !opts.slug || !opts.title) {
        throw new Error('init 需要 --type <prd|spec|todo>、--slug <slug> 与 --title <title>')
      }
      const res = await initDoc({
        repoRoot,
        mainRoot,
        gitDir: roots.gitDir,
        isGit: roots.isGit,
        type: opts.type,
        slug: opts.slug,
        title: opts.title,
        taskId: opts.task,
        relatedSpec: opts.spec,
        force: Boolean(opts.force),
      })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else {
        process.stdout.write(`已生成 ${res.type.toUpperCase()}：${res.file}（Planned at: ${res.plannedAt}）\n`)
        if (res.type === 'spec') {
          printNextStep([
            `补齐 C1..Cn 后执行批准：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "${res.file}"`,
          ])
        } else if (res.type === 'todo') {
          printNextStep([
            '补齐真实改动范围与 C1..Cn 后开始实施，完成验证后执行 flow.mjs finalize。',
          ])
        }
      }
      return 0
    }

    if (sub === 'approve') {
      if (!opts.file) throw new Error('approve 需要 --file <specPath>')
      const res = approveSpec({ repoRoot, file: opts.file })
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(res, null, 2)}\n`)
      } else {
        process.stdout.write(`SPEC 已切换为 approved：${res.file}（原状态：${res.previousStatus}）\n`)
        if (res.warning) process.stdout.write(`提示：${res.warning}\n`)
        printNextStep([
          '可继续创建或关联 docs/todo/ 后进入 flow.mjs start / 编码实施阶段。',
        ])
      }
      return 0
    }

    if (sub === 'list') {
      const data = listDocs(repoRoot)
      if (opts.json) {
        process.stdout.write(`${JSON.stringify(data, null, 2)}\n`)
      } else {
        process.stdout.write('# 工程文档全景（实时扫描）\n')
        process.stdout.write(`- docs/TDD.md: ${data.tdd ? `${data.tdd.title}` : '缺失'}\n`)
        const sections = [
          ['PRD (docs/prd/)', data.prds],
          ['SPEC (docs/specs/)', data.specs],
          ['Todo (docs/todo/)', data.todos],
          ['Archive (docs/archive/)', data.archived],
        ]
        for (const [label, items] of sections) {
          process.stdout.write(`\n## ${label} (${items.length})\n`)
          for (const it of items) {
            const checkInfo = it.totalChecks > 0 ? ` [${it.doneChecks}/${it.totalChecks}]` : ''
            const st = it.status ? ` status=${it.status}` : ''
            process.stdout.write(`- ${it.file}: ${it.title}${st}${checkInfo}\n`)
          }
        }
        printNextStep([
          '新建或分流任务请运行：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" triage --summary "<任务描述>"',
        ])
      }
      return 0
    }

    throw new Error(`未知子命令：${sub}（支持 triage / init / approve / list）`)
  } catch (err) {
    process.stderr.write(`doc-plan 错误：${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code))
}
