/**
 * preflight-contract-rules.mjs —— 契约规则常量、收尾步骤解析、目录锚点校验与通用 E2E 门禁静态校验。
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { markdownHeadings } from '../sync-toc.mjs'

export const PUSH_TIER_RULE = [
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

export const PUSH_TIER_DOCS = [
  'SKILL.md',
  'AGENTS.md',
  'templates/agents-project.md',
  'references/collaboration.md',
  'README.md',
  'README.en.md',
  'CONTRIBUTING.md',
  'templates/contributing.md',
]

export const MERGE_AUTHORITY_DOCS = [
  'templates/pull-request-template.md',
  '.github/pull_request_template.md',
]

export const STALE_DAILY_END = /提交\s*[+＋]\s*推送/

export const REVIEW_FIELDS = ['审查来源', '逐条标准状态', '故障注入记录', '止损记录']
export const ACCEPTANCE_ID_RE = /^- \[[ xX]\] C\d+\b/m
export const ACCEPTANCE_ID_SITES = ['kit/skills/templates/docs-todo.md', 'kit/skills/templates/docs-spec.md']

export const FINISH_ANCHOR = /合并收尾/
export const FINISH_STEPS = [
  /把要写的东西写完/,
  /合并 PR/,
  /回读确认/,
  /git switch/,
  /git worktree remove/,
  /git branch -d/,
  /git push origin --delete/,
]

export const FINISH_REQUIRED = [
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

export const FINISH_SITES = [
  'templates/agents-project.md',
  'AGENTS.md',
  'references/collaboration.md',
]

export const FINISH_SITE_ROLES = [
  { role: '骨架（templates/ 下）', test: (s) => s.startsWith('templates/') },
  { role: '实例（AGENTS.md）', test: (s) => s === 'AGENTS.md' },
  { role: '判据源头（references/ 下）', test: (s) => s.startsWith('references/') },
]

export const GATE_COMMANDS = [
  'node scripts/dev/preflight.mjs',
  'node scripts/dev/gap-coverage.mjs',
  'node scripts/dev/fixtures.mjs',
  'node scripts/compose-agents.mjs . --check',
  'node scripts/equip.mjs . --check',
  'node scripts/review.mjs .',
  'node scripts/sync-toc.mjs README.md README.en.md --check',
]

export const SINGLE_SOURCE_RULES = [
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

export const FORBIDDEN_IN_RELEASE_NOTES = /scripts\/dev\//

const FORBIDDEN_E2E_TOOLS_RE = /\b(?:playwright|cypress|puppeteer|selenium|webdriver(?:io)?|testcafe|chromedriver|geckodriver|appdriver)\b/i
const GENERIC_E2E_CONTRACT_PATHS = [
  'kit/skills/lib/workflow-policy.mjs',
  'kit/skills/dev-flow/scripts/flow.mjs',
  'kit/skills/dev-flow/scripts/flow-lifecycle.mjs',
  'kit/skills/dev-flow/scripts/flow-lifecycle-helpers.mjs',
  'kit/skills/dev-flow/scripts/flow-merge.mjs',
  'kit/skills/dev-review/scripts/review-gates.mjs',
  'kit/skills/dev-review/scripts/review-empirical.mjs',
  'kit/skills/dev-review/scripts/review-empirical-state.mjs',
  'kit/skills/dev-review/scripts/review-pack.mjs',
  'templates/agents-project.md',
  'AGENTS.md',
  'SKILL.md',
  'kit/skills/dev-flow/SKILL.md',
  'kit/skills/dev-review/SKILL.md',
  'references/collaboration.md',
]

export function readBlockScalar(block, key) {
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

/** 校验通用 E2E 门禁契约：保留 smoke-verify 键名且严禁硬编码具体外部 E2E/驱动工具名。 */
export function checkGenericE2eContracts({ ROOT, readText, fail, note }) {
  for (const rel of ['AGENTS.md', 'templates/agents-project.md', 'kit/skills/lib/profile.mjs']) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) { fail(`通用 E2E 契约缺失：${rel} 不存在`); continue }
    if (!/smoke-verify/.test(readText(abs))) {
      fail(`通用 E2E 契约失效：${rel} 必须保留 \`smoke-verify\` 键名以兼容 7 键 Dev Profile`)
    }
  }
  for (const rel of GENERIC_E2E_CONTRACT_PATHS) {
    const abs = join(ROOT, rel)
    if (!existsSync(abs)) continue
    const text = readText(abs)
    const hit = text.match(FORBIDDEN_E2E_TOOLS_RE)
    if (hit) {
      fail(`通用 E2E 契约违规（${rel}）：严禁硬编码具体外部 E2E/驱动工具名「${hit[0]}」，应保持框架中立的运行与观察契约`)
    }
  }
  note(`通用 E2E 契约：${GENERIC_E2E_CONTRACT_PATHS.length} 个核心契约/门禁文件均无具体外部驱动工具硬编码且保留 smoke-verify 键`)
}
