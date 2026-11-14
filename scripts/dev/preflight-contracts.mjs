/**
 * preflight-contracts.mjs —— 入口、引用、锚点、缺口覆盖、推送分档、同构、审查栏、收尾七步与 Mermaid 契约校验。
 */

import { existsSync, readdirSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  FULL_READ_MAX_LINES, FULL_READ_REFS, REFS_MAX_LINES,
  SKILL_MAX_BYTES, SKILL_MAX_LINES,
} from '../lib/protocol.mjs'
import { VERIFY_EXIT } from '../handoff.mjs'
import { markdownHeadings } from '../sync-toc.mjs'
import { checkGapCoverage as gapCoverage } from './gap-coverage.mjs'

const PATH_RE = /\b((?:references|templates|scripts)\/[A-Za-z0-9_./-]+\.(?:md|mjs|ya?ml|txt|json))\b/g
const HISTORY_PATHS = [/^docs\/work\//, /^docs\/archive\//, /^docs\/release-notes\//]

const PUSH_TIER_RULE = [
  {
    what: '分档判据是能不能撤回',
    any: [/能不能撤回/, /可撤回|撤得回来/, /can be undone|cannot be undone|whether they can be undone/],
  },
  {
    what: '推分支与开 PR 属于日常',
    any: [/推(?:自己|出)?的?分支|推分支/, /push(?:ing)? (?:your|the) (?:own )?branch|push-a-branch/],
  },
  {
    what: '审查通过就由审查者合',
    any: [/审查者(?:直接)?(?:合|合并)|审查通过[^\n]{0,20}(?:合|闭环)|由(?:那个)?审查/,
      /reviewer merges|merges? (?:it )?(?:directly|right away)|the reviewer finishes/i],
    everywhere: true,
  },
  {
    what: '弱化门禁必须人点头',
    any: [/弱化门禁/, /weaken\w* (?:a )?gate|loosen\w* (?:a )?gate|relax\w* (?:the )?gate/i],
    everywhere: true,
  },
]

const PUSH_TIER_DOCS = [
  'SKILL.md',
  'AGENTS.md',
  'templates/agents-project.md',
  'references/collaboration.md',
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'templates/contributing.md',
]

const MERGE_AUTHORITY_DOCS = [
  'templates/pull-request-template.md',
  '.github/pull_request_template.md',
]

const STALE_DAILY_END = /提交\s*[+＋]\s*推送/

const REVIEW_FIELDS = ['审查来源', '逐条标准状态', '故障注入记录', '止损记录']
const ACCEPTANCE_ID_RE = /^- \[[ xX]\] C\d+\b/m
const ACCEPTANCE_ID_SITES = ['templates/docs-todo.md', 'templates/docs-spec.md']

const FINISH_ANCHOR = /合并收尾/
const FINISH_STEPS = [
  /把要写的东西写完/,
  /合并 PR/,
  /回读确认/,
  /git switch/,
  /git worktree remove/,
  /git branch -d/,
  /git push origin --delete/,
]

const FINISH_REQUIRED = [
  {
    id: 'remote-probe',
    label: '删远端分支之前要先查远端还在不在',
    where: { stepMatching: /git push origin --delete/ },
    re: /ls-remote/,
  },
  {
    id: 'downstream-check',
    label: '删远端分支之前要先查有没有下游堆叠 PR 以它为 base',
    where: { stepMatching: /git push origin --delete/ },
    re: /(下游|堆叠)[^。；\n]*PR/,
  },
  {
    id: 'ask-before-delete',
    label: '删任何东西之前先把要删的清单列出来问一次',
    where: { chapterNonStep: true },
    test: (block) => /(worktree|工作树)/.test(block)
      && /本地分支/.test(block)
      && /远端分支/.test(block)
      && /(问|点头|确认)/.test(block),
  },
]

const FINISH_SITES = [
  'templates/agents-project.md',
  'AGENTS.md',
  'references/collaboration.md',
]

const FINISH_SITE_ROLES = [
  { role: '骨架（templates/ 下）', test: (s) => s.startsWith('templates/') },
  { role: '实例（AGENTS.md）', test: (s) => s === 'AGENTS.md' },
  { role: '判据源头（references/ 下）', test: (s) => s.startsWith('references/') },
]

const GATE_COMMANDS = [
  'node scripts/dev/preflight.mjs',
  'node scripts/dev/gap-coverage.mjs',
  'node scripts/dev/fixtures.mjs',
  'node scripts/compose-agents.mjs . --check',
  'node scripts/equip.mjs . --check',
  'node scripts/review.mjs .',
  'node scripts/sync-toc.mjs README.md README.en.md --check',
]

const SINGLE_SOURCE_RULES = [
  {
    what: 'S3 落盘顺序：版本控制 → 文档 → 远端 → 自动化',
    tests: [
      { file: 'README.md', re: /版本库\s*→\s*文档\s*→\s*远端\s*→\s*自动化/ },
      { file: 'README.en.md', re: /Repo\s*→\s*docs\s*→\s*remote\s*→\s*automation/ },
      { file: 'SKILL.md', re: /版本控制\s*→\s*文档\s*→\s*远端\s*→\s*自动化/ },
    ],
  },
  {
    what: '交棒的退出码（四个码必须与 handoff.mjs 的 VERIFY_EXIT 逐个相等）',
    tests: [
      { file: 'SKILL.md', re: /--verify[^\n]*/, exitCodes: true },
      { file: 'references/handoff.md', re: /四档退出码[\s\S]{0,400}/, exitCodes: true },
    ],
  },
  {
    what: '发版说明的「怎么升级」只能给包里真有的命令',
    releaseNotes: true,
  },
]

const FORBIDDEN_IN_RELEASE_NOTES = /scripts\/dev\//

function readBlockScalar(block, key) {
  const lines = block.split('\n')
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l))
  if (idx < 0) return undefined
  const inline = lines[idx].slice(`${key}:`.length).trim()
  if (inline !== '' && inline !== '|' && inline !== '>') return inline.replace(/^["']|["']$/g, '')
  const body = []
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '' && !/^\s/.test(lines[i])) break
    body.push(lines[i].trim())
  }
  return body.join(' ').trim() || undefined
}

export function completionRecordBeforeMerge(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => /^##\s+完成后的记录\s*$/.test(line))
  if (start === -1) return { ok: false, why: '没有「完成后的记录」这一节' }
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }
  const section = lines.slice(start, end).join('\n')
  if (!/合并之前写完/.test(section)) {
    return { ok: false, why: '「完成后的记录」里没有要求「在合并之前写完」' }
  }
  return { ok: true, why: '' }
}

export function reviewBlockMissing(text) {
  const blocks = String(text ?? '').replace(/\r\n/g, '\n').split(/\n\s*\n/)
  const complete = blocks.some((block) => REVIEW_FIELDS.every((field) => block.includes(field)))
  return complete ? [] : REVIEW_FIELDS
}

export function acceptanceIdMissing(text) {
  return !ACCEPTANCE_ID_RE.test(String(text ?? ''))
}

export function finishSiteRolesMissing(sites) {
  return FINISH_SITE_ROLES.filter(({ test }) => !sites.some(test)).map(({ role }) => role)
}

export function finishSectionRange(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex((line) => FINISH_ANCHOR.test(line))
  if (start === -1) return undefined
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#+\s+/.test(lines[i]) || /^- \*\*/.test(lines[i]) || /^<!--\s*project-forge:/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

export function finishStepBodies(text) {
  const range = finishSectionRange(text)
  if (range === undefined) return undefined
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n').slice(range.start, range.end)
  const bodies = []
  let current = null
  for (const line of lines) {
    if (/^\s*\d+\.\s/.test(line)) {
      if (current !== null) bodies.push(current)
      current = line
      continue
    }
    if (line.trim() === '') {
      if (current !== null) { bodies.push(current); current = null }
      continue
    }
    // 顶格的标题或新条目也是边界
    if (/^(#|- \*\*|<!--)/.test(line)) {
      if (current !== null) { bodies.push(current); current = null }
      continue
    }
    if (current !== null) current += '\n' + line
  }
  if (current !== null) bodies.push(current)
  return bodies
}

export function finishCommandsOf(text) {
  const bodies = finishStepBodies(text)
  if (bodies === undefined) return undefined
  const found = bodies.join('\n').match(/\bgit\s+([a-z][a-z-]*)/g) ?? []
  return [...new Set(found.map((one) => one.replace(/\s+/g, ' ')))].sort()
}

export function finishRequiredMissing(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const anchorAt = lines.findIndex((line) => FINISH_ANCHOR.test(line))
  if (anchorAt === -1) return FINISH_REQUIRED.map((one) => one.label)

  let start = anchorAt
  for (let i = anchorAt; i >= 0; i -= 1) {
    if (/^##\s+/.test(lines[i])) { start = i; break }
  }
  let end = lines.length
  for (let i = anchorAt + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) { end = i; break }
  }
  const chapter = lines.slice(start, end).join('\n')

  const stepBody = (pattern) => {
    const bodies = finishStepBodies(text)
    if (bodies === undefined) return undefined
    return bodies.find((body) => pattern.test(body))
  }

  const paragraphs = chapter.split(/\n\s*\n/)
  const nonStepLines = []
  let inStepItem = false
  for (const line of chapter.split('\n')) {
    if (/^\s*\d+\.\s/.test(line)) { inStepItem = true; continue }
    if (line.trim() === '' || /^#/.test(line) || /^\s*[-*]\s/.test(line) || /^<!--/.test(line)) {
      inStepItem = false
      nonStepLines.push(line)
      continue
    }
    if (inStepItem) continue
    nonStepLines.push(line)
  }
  const nonStepParagraphs = nonStepLines.join('\n').split(/\n\s*\n/)
  const windowHit = (paras, test) => {
    for (let i = 0; i < paras.length; i += 1) {
      if (test(paras.slice(i, i + 3).join('\n'))) return true
    }
    return false
  }

  const missing = []
  for (const one of FINISH_REQUIRED) {
    let ok = false
    if (one.where.stepMatching !== undefined) {
      const body = stepBody(one.where.stepMatching)
      ok = body !== undefined && one.re.test(body)
    } else if (one.where.chapterNonStep) {
      ok = windowHit(nonStepParagraphs, one.test)
    } else if (one.test !== undefined) {
      ok = windowHit(paragraphs, one.test)
    } else {
      ok = one.re.test(chapter)
    }
    if (!ok) missing.push(one.label)
  }
  return missing
}

export function finishStepsState(text) {
  const range = finishSectionRange(text)
  if (range === undefined) return { missing: FINISH_STEPS, outOfOrder: false }
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const section = lines.slice(range.start, range.end)
  const positions = FINISH_STEPS.map((re) => section.findIndex((line) => re.test(line)))
  const missing = FINISH_STEPS.filter((_, i) => positions[i] === -1)
  let outOfOrder = false
  for (let i = 1; i < positions.length; i += 1) {
    if (positions[i] === -1 || positions[i - 1] === -1) continue
    if (positions[i] < positions[i - 1]) { outOfOrder = true; break }
  }
  return { missing, outOfOrder }
}

export function matchHeadings(headings, section) {
  const wanted = String(section).replace(/`/g, '')
  return [...headings].filter((h) => h.replace(/`/g, '').startsWith(wanted))
}

export function validateDocTocAnchors(text) {
  const normalized = String(text ?? '').replace(/\r\n/g, '\n')
  const tocStart = /^##\s+目录\s*$/m.exec(normalized)
  if (!tocStart) return ['缺少 `## 目录` 章节']
  const afterStart = normalized.slice(tocStart.index + tocStart[0].length)
  const nextH2 = /\n##\s+/.exec(afterStart)
  const tocBody = nextH2 ? afterStart.slice(0, nextH2.index) : afterStart
  const links = [...tocBody.matchAll(/\[([^\]]+)\]\(#([^)\s]+)\)/g)]
  if (links.length === 0) return ['`## 目录` 内没有任何 `#anchor` 链接']

  const validIds = new Set(markdownHeadings(normalized, 6).map((h) => h.id))
  const errors = []
  for (const [, label, rawAnchor] of links) {
    let decoded = rawAnchor
    try { decoded = decodeURIComponent(rawAnchor) } catch { /* 保持原串 */ }
    if (!validIds.has(rawAnchor) && !validIds.has(decoded)) {
      errors.push(`目录项「${label}」的锚点 #${rawAnchor} 找不到对应真实标题`)
    }
  }
  return errors
}

function checkEntry({ ROOT, readText, countLines, isWorktreeCheckout, fail, note }) {
  const skillPath = join(ROOT, 'SKILL.md')
  if (!existsSync(skillPath)) { fail('缺少 SKILL.md'); return }
  const text = readText(skillPath)
  const bytes = Buffer.byteLength(text, 'utf8')
  const lines = countLines(text)

  if (lines > SKILL_MAX_LINES) {
    fail(`SKILL.md 有 ${lines} 行，超过预算 ${SKILL_MAX_LINES} 行——入口每多一行，每一次任务都要多付一次`)
  }
  if (bytes > SKILL_MAX_BYTES) fail(`SKILL.md 有 ${bytes} 字节，超过预算 ${SKILL_MAX_BYTES} 字节`)

  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n/g, '\n'))
  if (!fm) { fail('SKILL.md 缺少 frontmatter（首行的 ---）'); return }
  const name = /^name:\s*(.+)$/m.exec(fm[1])?.[1]?.trim()
  const desc = readBlockScalar(fm[1], 'description')
  if (!name) fail('frontmatter 缺 name')
  else {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      fail(`frontmatter 的 name「${name}」不合法：只能小写字母、数字、连字符`)
    }
    if (name !== basename(ROOT)) {
      if (isWorktreeCheckout(ROOT)) {
        note(`入口：name「${name}」与目录名「${basename(ROOT)}」不同——这是 worktree 检出，`
          + '目录名是隔离用的临时名字，不是安装位置，这一条在这里不适用')
      } else {
        fail(`frontmatter 的 name「${name}」与目录名「${basename(ROOT)}」不一致——宿主按目录名发现它`)
      }
    }
  }
  if (!desc || desc.length < 20) fail('frontmatter 缺 description，或它太短（宿主靠它决定要不要加载）')

  const camel = fm[1].match(/^[a-zA-Z]*[a-z][A-Z][a-zA-Z]*:/m)
  if (camel) fail(`frontmatter 里有驼峰键「${camel[0].replace(':', '')}」——扩展键一律用连字符形式，驼峰会让整份被丢弃`)
  note(`入口：${lines} 行 / ${bytes} 字节（预算 ${SKILL_MAX_LINES} 行 / ${SKILL_MAX_BYTES} 字节）`)
}

function checkLinks(ctx) {
  const { ROOT, rel, readText, countLines, walk, fail, note, isRepoOnlyPath, isProductLayerPath } = ctx
  const refDir = join(ROOT, 'references')
  const refs = walk(refDir, (f) => f.endsWith('.md'))
  if (refs.length === 0) fail('references/ 下没有任何 Markdown 文件')

  for (const file of refs) {
    const name = rel(file)
    const text = readText(file)
    if (!text.startsWith('# ')) fail(`${name} 的首行必须是一级标题`)
    if (!/^##\s+何时读本文件/m.test(text)) {
      fail(`${name} 缺「## 何时读本文件」——没有它，AI 不知道什么时候该读这一份`)
    }
  }

  const docsToScan = [join(ROOT, 'SKILL.md'), ...refs]
  const seen = new Set()
  for (const doc of docsToScan) {
    if (!existsSync(doc)) continue
    const name = rel(doc)
    const text = readText(doc)
    if (/\bexplorationStrategy\.mode\b/.test(text)) {
      fail(`${name} 仍使用过期字段 explorationStrategy.mode，必须改为 explorationStrategy.tier`)
    }
    for (const m of text.matchAll(PATH_RE)) {
      const target = m[1]
      if (target.includes('*')) continue
      seen.add(target)
      if (!existsSync(join(ROOT, target))) fail(`${name} 引用了不存在的路径：${target}`)
    }
  }

  for (const readmeName of ['README.md', 'README.en.md']) {
    const p = join(ROOT, readmeName)
    if (!existsSync(p)) continue
    const text = readText(p)
    for (const m of text.matchAll(/\b(assets\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+)\b/g)) {
      const target = m[1]
      if (!existsSync(join(ROOT, target))) { fail(`${readmeName} 引用的视觉资源不存在：${target}`); continue }
      if (isRepoOnlyPath(target) || !isProductLayerPath(target)) {
        fail(`${readmeName} 引用的视觉资源未纳入产品层用户包：${target}`)
      }
    }
  }

  const licenseFamily = /templates\/license-<[^>]+>\.txt/
  const licenseMentioned = docsToScan.some((doc) => existsSync(doc) && licenseFamily.test(readText(doc)))
  for (const file of walk(join(ROOT, 'templates'), () => true)) {
    const target = rel(file)
    if (seen.has(target)) continue
    if (/^templates\/license-.+\.txt$/.test(target) && licenseMentioned) continue
    fail(`${target} 没有被任何文档提到——写了却没人指得到，等于没写`)
  }

  const refLines = refs.reduce((sum, f) => sum + countLines(readText(f)), 0)
  if (refLines > REFS_MAX_LINES) fail(`references/ 合计 ${refLines} 行，超过预算 ${REFS_MAX_LINES} 行`)
  note(`参考文档：${refs.length} 篇 / ${refLines} 行`)

  let fullRead = countLines(readText(join(ROOT, 'SKILL.md')))
  for (const refPath of FULL_READ_REFS) {
    const p = join(ROOT, refPath)
    if (!existsSync(p)) { fail(`预算表里列的 ${refPath} 不存在`); continue }
    fullRead += countLines(readText(p))
  }
  if (fullRead > FULL_READ_MAX_LINES) {
    fail(`一次全量任务要读 ${fullRead} 行，超过预算 ${FULL_READ_MAX_LINES} 行——注意力被稀释的直接来源`)
  }
  note(`全量必读：${fullRead} 行（预算 ${FULL_READ_MAX_LINES}）`)
}

function checkReferenceTargets({ ROOT, readText, fail, note }) {
  const reviewPath = join(ROOT, 'scripts', 'review.mjs')
  if (!existsSync(reviewPath)) { fail('缺 scripts/review.mjs'); return }
  const src = readText(reviewPath)
  const pairs = [...src.matchAll(/file:\s*'([^']+)',\s*section:\s*'([^']+)'/g)]
  const headingsCache = new Map()
  let checked = 0

  for (const [, file, section] of pairs) {
    const full = join(ROOT, file)
    if (!existsSync(full)) { fail(`review.mjs 指路指向不存在的文件：${file}`); continue }
    if (!headingsCache.has(file)) {
      headingsCache.set(file, new Set(
        readText(full).replace(/\r\n/g, '\n').split('\n')
          .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1])
          .filter(Boolean),
      ))
    }
    checked += 1
    const hits = matchHeadings(headingsCache.get(file), section)
    if (hits.length === 0) {
      fail(`review.mjs 指向 ${file} 的「${section}」，但那份文件里没有以它开头的二级标题——指路会落空`)
    } else if (hits.length > 1) {
      fail(`review.mjs 指向 ${file} 的「${section}」，对上了 ${hits.length} 个标题（${hits.join(' ／ ')}）——指路要多写几个字让它唯一`)
    }
  }
  note(`指路核对：${checked} 处都指在真实标题上`)
}

function checkAnchors({ ROOT, rel, readText, walk, fail, note }) {
  const scanned = walk(ROOT, (f) => /\.(?:md|mjs|ya?ml)$/i.test(f))
  const SECTION_PTR = /第[一二三四五六七八九十]+节/
  let sectionHits = 0
  let scannedFiles = 0
  for (const file of scanned) {
    if (!existsSync(file)) continue
    const name = rel(file)
    if (HISTORY_PATHS.some((re) => re.test(name))) continue
    scannedFiles += 1
    const lines = readText(file).replace(/\r\n/g, '\n').split('\n')
    for (const [i, line] of lines.entries()) {
      if (!SECTION_PTR.test(line)) continue
      sectionHits += 1
      fail(`${name} 第 ${i + 1} 行用了节号指针——重排一次就全部指错，而它不会报错；改写成「标题名」`)
    }
  }
  if (sectionHits === 0) note(`指路形状：${scannedFiles} 份文件里没有节号指针，指路一律用标题名`)

  const headingsCache = new Map()
  const headingsOfFile = (file) => {
    if (!headingsCache.has(file)) {
      const full = join(ROOT, file)
      headingsCache.set(file, existsSync(full)
        ? new Set(readText(full).replace(/\r\n/g, '\n').split('\n')
          .map((l) => /^##\s+(.+?)\s*$/.exec(l)?.[1]).filter(Boolean))
        : null)
    }
    return headingsCache.get(file)
  }

  let checked = 0
  for (const file of scanned) {
    if (!existsSync(file)) continue
    const name = rel(file)
    if (HISTORY_PATHS.some((re) => re.test(name))) continue
    const text = readText(file).replace(/\r\n/g, '\n')
    for (const m of text.matchAll(/`(references\/[A-Za-z0-9_.-]+\.md)`\s*的?\s*「([^」]+)」/g)) {
      const [, refFile, section] = m
      const have = headingsOfFile(refFile)
      if (have === null) { fail(`${name} 指向不存在的文件 ${refFile}`); continue }
      checked += 1
      const hits = matchHeadings(have, section)
      if (hits.length === 0) {
        fail(`${name} 指向 ${refFile} 的「${section}」，但那份文件里没有以它开头的二级标题——指路落空`)
      } else if (hits.length > 1) {
        fail(`${name} 指向 ${refFile} 的「${section}」，对上了 ${hits.length} 个标题（${hits.join(' ／ ')}）——指路要多写几个字让它唯一`)
      }
    }
  }
  note(`指路核对：review.mjs 与正文共 ${checked} 处命名锚点都落在真实标题上`)
}

async function checkGapCoverage({ ROOT, fail, note }) {
  let state
  try {
    state = await gapCoverage(ROOT)
  } catch (error) {
    fail(`缺口覆盖：这条判据没跑成——${error instanceof Error ? error.message : String(error)}`)
    return
  }
  for (const one of state.duplicated) fail(`缺口覆盖：${one}——一条缺口只能落一档，写两档会让结论出现两个版本`)
  for (const one of state.dangling) fail(`缺口覆盖：${one} 在体检里没有这个 id——映射看着配好，实际指向一条永远不会出现的结论`)
  for (const id of state.unknown) fail(`缺口覆盖：${id} 出现在源码里却不在登记名单里——源码与导出名单对不上`)
  for (const id of state.missing) fail(`缺口覆盖：${id} 登记了却没能从源码里读出来——词法切块失灵，这一条从此没人查`)
  for (const id of state.unclaimed) {
    fail(`缺口覆盖：${id} 体检那边没人接——勘察报了、没人管；给 survey.mjs 那条规则补 review / decision / surveyOnly 三选一`)
  }
  if (state.ok.length > 0) note(`缺口覆盖：${state.ok.length} 条各有处置（体检 / 表态 / 仅勘察）`)
}

function checkPushSemantics({ ROOT, readText, fail, note }) {
  const groups = [
    { docs: PUSH_TIER_DOCS, label: '日常流程' },
    { docs: MERGE_AUTHORITY_DOCS, label: '提单模板' },
  ]
  for (const group of groups) {
    for (const name of group.docs) {
      const p = join(ROOT, name)
      if (!existsSync(p)) { fail(`推送分档核对：缺 ${name}`); continue }
      const text = readText(p)
      for (const rule of PUSH_TIER_RULE) {
        if (group.label === '提单模板' && rule.everywhere !== true) continue
        if (!rule.any.some((re) => re.test(text))) {
          fail(`${name} 里缺「${rule.what}」这条说法——同一件事在不同文件里说法不一，执行者会按错的那一份行事`)
        }
      }
      const stale = STALE_DAILY_END.exec(text)
      if (stale) {
        const line = text.slice(0, stale.index).split('\n').length
        fail(`${name} 第 ${line} 行还把「提交 + 推送」当作日常的终点——推自己的分支撤得回来，那一档的终点是合并`)
      }
    }
  }
  note(`推送分档：${PUSH_TIER_DOCS.length + MERGE_AUTHORITY_DOCS.length} 份文件说法一致（分档看可撤回性，推分支属日常，审查通过由审查者合，只有弱化门禁要人点头）`)
}

function checkSingleSources({ ROOT, readText, fail, note }) {
  for (const rule of SINGLE_SOURCE_RULES) {
    if (rule.releaseNotes === true) continue
    for (const test of rule.tests) {
      const p = join(ROOT, test.file)
      if (!existsSync(p)) { fail(`单一真相源核对：缺 ${test.file}`); continue }
      const hit = test.re.exec(readText(p))
      if (hit === null) {
        fail(`${test.file} 里对不上「${rule.what}」——同一件事在两份文件里说了两样，读的人会按错的那一份做`)
        continue
      }
      if (test.exitCodes === true) {
        const nums = [...new Set((hit[0].replace(/`/g, ' ').match(/(?<![\w.])\d(?![\w.])/g) ?? []))]
          .map(Number).sort((a, b) => a - b)
        const expect = Object.values(VERIFY_EXIT).sort((a, b) => a - b)
        if (nums.join(',') !== expect.join(',')) {
          fail(`${test.file} 里写的退出码是 ${nums.join('/')}，而 handoff.mjs 实际返回 ${expect.join('/')}——文档承诺了一个不会出现的码，还漏掉了真的会出现的那个`)
        }
      }
    }
  }

  const notesDir = join(ROOT, 'docs', 'release-notes')
  if (existsSync(notesDir)) {
    for (const n of readdirSync(notesDir).filter((f) => /\.md$/i.test(f)).sort()) {
      const file = `docs/release-notes/${n}`
      if (FORBIDDEN_IN_RELEASE_NOTES.test(readText(join(ROOT, file)))) {
        fail(`${file} 提到了 scripts/dev/——那几处不进用户包，照着跑的人会得到「找不到模块」`)
      }
    }
  }

  for (const file of ['AGENTS.md', 'CONTRIBUTING.md']) {
    const p = join(ROOT, file)
    if (!existsSync(p)) { fail(`门禁清单核对：缺 ${file}`); continue }
    const text = readText(p)
    for (const cmd of GATE_COMMANDS) {
      if (!text.includes(cmd)) fail(`${file} 的门禁清单里少一条：${cmd}——两份文档列的不是同一批命令，照少的那份跑会漏掉它`)
    }
  }

  const mustHave = [
    { what: '一级标题校验', re: /grep -qE '\^# \+\[\^ \]'/ },
    { what: '正文行数校验', re: /BODY_LINES/ },
    { what: '未填占位判据（独立注释行）', re: /<!--\[\[:space:\]\]\*project-forge/ },
  ]
  for (const pair of [{ file: 'templates/ci-release.yml', label: '模板' }, { file: '.github/workflows/release.yml', label: '本仓库实例' }]) {
    const p = join(ROOT, pair.file)
    if (!existsSync(p)) { fail(`工作流对拍：缺 ${pair.file}`); continue }
    const text = readText(p)
    for (const rule of mustHave) {
      if (!rule.re.test(text)) fail(`${pair.file}（${pair.label}）缺${rule.what}——两份工作流检查的东西不一样，CI 会放过模板能拦下的那种说明`)
    }
  }

  for (const c of [
    { file: 'templates/ci-check.yml', re: /permissions:\s*\n\s*contents:\s*read/ },
    { file: '.github/workflows/check.yml', re: /permissions:\s*\n\s*contents:\s*read/ },
  ]) {
    const p = join(ROOT, c.file)
    if (existsSync(p) && !c.re.test(readText(p))) {
      fail(`${c.file} 没有声明 permissions: contents: read——检查类工作流不该带写权限`)
    }
  }
  note(`单一真相源：${SINGLE_SOURCE_RULES.length} 组跨文件判据 + 工作流对拍 + 权限声明，全部一致`)
}

function checkReviewContract({ ROOT, readText, fail, note }) {
  for (const site of ['templates/pull-request-template.md', '.github/pull_request_template.md', 'references/collaboration.md']) {
    const path = join(ROOT, site)
    if (!existsSync(path)) { fail(`审查栏对拍：缺 ${site}`); continue }
    const missing = reviewBlockMissing(readText(path))
    if (missing.length === REVIEW_FIELDS.length) {
      fail(`${site} 里没有一块同时排着审查栏的这四个字段——模板、实例、判据三处必须是同一批词，`
        + `否则填了也没人按它判。字段表在 scripts/dev/preflight-contracts.mjs 的 REVIEW_FIELDS`)
    } else if (missing.length > 0 && missing.length < REVIEW_FIELDS.length) {
      fail(`${site} 的审查栏字段块不完整，缺「${missing.join('、')}」——四个字段要排在同一段里；分散在正文各处的同名文字不算`)
    }
  }
  note(`审查栏对拍：${REVIEW_FIELDS.length} 个字段在三处各排成一块`)

  for (const site of ACCEPTANCE_ID_SITES) {
    const path = join(ROOT, site)
    if (!existsSync(path)) { fail(`验收标准编号：缺 ${site}`); continue }
    if (acceptanceIdMissing(readText(path))) {
      fail(`${site} 里没有 \`C1\`/\`C2\` 形状的验收标准编号——审查栏写的是 \`fail: C4\`，编号形状一变，两处就永远对不起来，而人只会以为审查漏看了那一条`)
    }
  }
  note(`验收标准编号：${ACCEPTANCE_ID_SITES.length} 处都是 \`C<数字>\` 形状`)

  const todoTplPath = join(ROOT, 'templates/docs-todo.md')
  if (!existsSync(todoTplPath)) fail('完成后记录：缺 templates/docs-todo.md')
  else {
    const { ok, why } = completionRecordBeforeMerge(readText(todoTplPath))
    if (!ok) fail(`templates/docs-todo.md：${why}——这句一改，合并之后就得再开一个只改记录的提案，而那个提案没人审、也没和这件事绑在一起`)
  }
  note('完成后记录：模板要求「在合并之前写完」')

  let siteCount = 0
  let baseline = null
  for (const site of FINISH_SITES) {
    const path = join(ROOT, site)
    if (!existsSync(path)) { fail(`收尾步骤对拍：缺 ${site}`); continue }
    siteCount += 1
    const text = readText(path)
    const state = finishStepsState(text)
    if (state.missing.length > 0) {
      fail(`${site} 的合并收尾缺这几步：${state.missing.join('、')}——七步固定，少一步就会有人漏做`)
    } else if (state.outOfOrder) {
      fail(`${site} 的合并收尾步骤顺序不对——顺序是判据不是排版，worktree 没卸就删分支会失败，而报错说的是「未合并」`)
    }
    for (const label of finishRequiredMissing(text)) {
      fail(`${site} 的合并收尾没有交代「${label}」——三处一起漏掉时，互相比对永远说「一致」；只有拿内容去对，才看得见集体遗忘`)
    }
    const commands = finishCommandsOf(text)
    if (commands === undefined) {
      fail(`${site} 的合并收尾读不出命令集——七步要写成编号行（数字加点开头），叙述体里「第一步，…」这种写法读不到，对拍就静默通过`)
      continue
    }
    if (baseline === null) { baseline = { site, commands }; continue }
    const extra = commands.filter((c) => !baseline.commands.includes(c))
    const absent = baseline.commands.filter((c) => !commands.includes(c))
    if (extra.length > 0 || absent.length > 0) {
      const parts = []
      if (absent.length > 0) parts.push(`${site} 少了 ${absent.join('、')}`)
      if (extra.length > 0) parts.push(`${site} 多了 ${extra.join('、')}`)
      fail(`收尾步骤对拍：${baseline.site} 与 ${site} 教人敲的命令不一致——${parts.join('；')}。措辞可以各写各的，命令不行：同一件事在三处教人敲不同的东西，照着做会漏一半`)
    }
  }
  for (const role of finishSiteRolesMissing(FINISH_SITES)) {
    fail(`收尾步骤对拍：${role}这一处不在核对清单里——它改了不会有任何东西报错，而其余几处都跟着它走`)
  }
  note(`收尾步骤对拍：${FINISH_STEPS.length} 步在 ${siteCount} 处（模板 / 实例 / 判据源头）顺序与命令一致`)
}

export async function runContractChecks(ctx) {
  checkEntry(ctx)
  checkLinks(ctx)
  checkReferenceTargets(ctx)
  checkAnchors(ctx)
  await checkGapCoverage(ctx)
  checkPushSemantics(ctx)
  checkSingleSources(ctx)
  checkReviewContract(ctx)
}
