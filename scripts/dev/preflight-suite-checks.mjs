/**
 * preflight-suite-checks.mjs —— 从 preflight-suite.mjs 拆出的模板、视觉、同构实例与常青保鲜检查。
 */

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  TEMPLATE_CONDITIONS, TEMPLATE_VARS, conditionMarkers, templateVarsOf,
} from '../lib/protocol.mjs'
import { parseDocFrontmatter } from '../../kit/skills/lib/shared.mjs'

const HISTORY_PATHS = [/^docs\/work\//, /^docs\/archive\//, /^docs\/release-notes\//]
const OWN_INSTANCE_CHECKS = [
  { template: 'templates/pull-request-template.md', instance: '.github/pull_request_template.md' },
  { template: 'templates/issue-bug-report.md', instance: '.github/ISSUE_TEMPLATE/bug_report.md' },
  { template: 'templates/issue-feature-request.md', instance: '.github/ISSUE_TEMPLATE/feature_request.md' },
  { template: 'templates/releasing.md', instance: 'RELEASING.md' },
  { template: 'templates/contributing.md', instance: 'CONTRIBUTING.md' },
]
const RETIRED_NAMES = [
  'selftest.mjs', 'review-record.mjs', 'agents-kernel.md', 'pf-review',
  'check-badges.mjs', 'ecosystems.mjs', 'lib/ledger.mjs', 'lib/manifest.mjs',
  'task-runners.mjs', 'release-notes.mjs', 'render-svg.mjs', 'release-spec.md', 'work-item.md',
]

const TEMPLATE_FORBIDDEN = [
  { re: /`?references\//, what: '指向 references/ 的路径（目标项目没有这个目录）' },
  { re: /\bproject-forge:\s*(?:kernel|managed|upgraded)/, what: '旧版标记语法' },
]

export function checkTemplates({ ROOT, rel, readText, walk, fail, note }) {
  const templates = walk(join(ROOT, 'templates'), () => true)
  if (templates.length === 0) { fail('templates/ 下没有任何文件'); return }
  const rendered = templates.filter((f) => !/^license-.+\.txt$/.test(basename(f)))

  for (const file of templates) {
    const name = rel(file)
    const text = readText(file)
    for (const rule of TEMPLATE_FORBIDDEN) {
      const m = rule.re.exec(text)
      if (m) fail(`${name} 第 ${text.slice(0, m.index).split('\n').length} 行有${rule.what}——它会原样落进目标项目，然后永远指空`)
    }
  }

  for (const file of rendered) {
    const name = rel(file)
    const text = readText(file)
    for (const mark of conditionMarkers(text, 'x.md')) {
      if (mark.kind === 'if' && !TEMPLATE_CONDITIONS.includes(mark.cond)) {
        fail(`${name} 第 ${mark.line} 行用了未登记的条件「${mark.cond}」——它会永远求值为假，那一块会静默消失`)
      }
    }
    for (const v of templateVarsOf(text)) {
      if (!TEMPLATE_VARS.includes(v)) fail(`${name} 里有未登记的占位符 {{${v}}}——渲染会直接失败`)
    }
  }

  const usedConds = new Set()
  const usedVars = new Set()
  for (const file of rendered) {
    const text = readText(file)
    for (const mark of conditionMarkers(text, 'x.md')) if (mark.kind === 'if') usedConds.add(mark.cond)
    for (const v of templateVarsOf(text)) usedVars.add(v)
  }
  for (const c of TEMPLATE_CONDITIONS) {
    if (!usedConds.has(c)) fail(`条件「${c}」登记了却没有任何模板用它——要么删掉登记，要么补上模板`)
  }
  for (const v of TEMPLATE_VARS) {
    if (!usedVars.has(v)) fail(`占位符 {{${v}}} 登记了却没有任何模板用它——要么删掉登记，要么补上模板`)
  }
  note(`模板：${templates.length} 份，无越界指针；条件 ${usedConds.size} 个、变量 ${usedVars.size} 个全部登记且都在用`)
}

export function checkReadmeVisualsAndDocFrontmatter({ ROOT, readText, fail, note }) {
  const requiredSvgs = [
    'assets/readme/hero.svg', 'assets/readme/hero-en.svg',
    'assets/readme/workflow.svg', 'assets/readme/workflow-en.svg',
    'assets/readme/architecture.svg', 'assets/readme/architecture-en.svg',
    'assets/readme/skills-cycle.svg', 'assets/readme/skills-cycle-en.svg',
    'assets/readme/docs-layers.svg', 'assets/readme/docs-layers-en.svg',
  ]
  const heights = new Set()
  for (const relPath of requiredSvgs) {
    const abs = join(ROOT, relPath)
    if (!existsSync(abs)) { fail(`缺少 README 图解资产：${relPath}`); continue }
    const vb = /\bviewBox\s*=\s*["']\s*0\s+0\s+\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)\s*["']/i.exec(readText(abs))
    if (vb) heights.add(vb[1])
    else fail(`${relPath} 缺少标准 0 0 W H viewBox 尺寸`)
  }
  if (heights.size < 2) fail(`README SVG 图解高度过于单一（仅检测到 ${heights.size} 种高度），不同图表须按内容采用区分度明显的独立高度`)

  for (const readmeRel of ['README.md', 'README.en.md']) {
    if (!/https:\/\/img\.shields\.io\/badge\//i.test(readText(join(ROOT, readmeRel)))) fail(`${readmeRel} 缺少 shields.io 事实徽章行`)
  }

  for (const [tplRel, expectedKind] of [['kit/skills/templates/docs-prd.md', 'prd'], ['kit/skills/templates/docs-spec.md', 'spec'], ['kit/skills/templates/docs-todo.md', 'todo']]) {
    const fm = parseDocFrontmatter(readText(join(ROOT, tplRel)))
    if (!fm.hasFrontmatter) { fail(`${tplRel} 缺少 YAML Frontmatter（首行 --- ... ---）`); continue }
    if (fm.malformedFrontmatter) { fail(`${tplRel} YAML Frontmatter 格式错误：${fm.syntaxErrors.join('；')}`); continue }
    if (fm.data.kind !== expectedKind) fail(`${tplRel} YAML Frontmatter \`kind\` 应为「${expectedKind}」，实为「${fm.data.kind ?? ''}」`)
    for (const k of ['kind', 'status', 'created', 'updated', 'issue', 'pr', 'owner']) {
      if (!Object.prototype.hasOwnProperty.call(fm.data, k)) fail(`${tplRel} YAML Frontmatter 缺少必需字段「${k}」`)
    }
    for (const k of ['kind', 'status', 'created', 'updated', 'owner']) {
      if (typeof fm.data[k] !== 'string' || !fm.data[k].trim()) fail(`${tplRel} YAML Frontmatter 字段「${k}」不可为空`)
    }
  }
  note(`视觉与文档前导：${requiredSvgs.length} 张 README SVG（${heights.size} 种独立高度）、双语徽章与 3 份 docs-* YAML frontmatter 齐全合规`)
}

export function checkOwnInstances({ ROOT, rel, readText, walk, fail, note }) {
  const headingsOf = (text) => (text.replace(/\r\n/g, '\n').match(/^##\s+.+$/gm) ?? []).map((s) => s.trim())
  for (const check of OWN_INSTANCE_CHECKS) {
    const tpl = join(ROOT, check.template)
    const inst = join(ROOT, check.instance)
    if (!existsSync(tpl)) { fail(`同构核对：缺模板 ${check.template}`); continue }
    if (!existsSync(inst)) { fail(`同构核对：缺本仓库实例 ${check.instance}`); continue }
    const have = new Set(headingsOf(readText(inst)))
    for (const h of headingsOf(readText(tpl))) {
      if (!have.has(h)) fail(`${check.instance} 缺模板里的这一节：${h}——模板改了、本仓库自己那份没跟上，两边从此各说各话`)
    }
  }
  note(`同构核对：${OWN_INSTANCE_CHECKS.length} 组实例与模板的核心章节一致`)

  const targets = [
    join(ROOT, 'SKILL.md'), join(ROOT, 'AGENTS.md'), join(ROOT, 'README.md'),
    join(ROOT, 'README.en.md'), join(ROOT, 'CONTRIBUTING.md'), join(ROOT, 'RELEASING.md'),
    ...walk(join(ROOT, '.github'), (f) => /\.(?:md|ya?ml)$/i.test(f)),
    ...walk(join(ROOT, 'templates'), () => true),
  ]
  for (const file of targets) {
    if (!existsSync(file)) continue
    const name = rel(file)
    if (HISTORY_PATHS.some((re) => re.test(name))) continue
    const text = readText(file)
    for (const retired of RETIRED_NAMES) {
      if (text.includes(retired)) fail(`${name} 里还写着 ${retired}——那个脚本已经不存在，照着它做的人会找不到命令`)
    }
  }
}

/** 校验常青文档不漂移过时：禁止未发布高版本号、M* 阶段代号及 README 徽章版本与 SKILL.md 脱节。 */
export function evergreenFreshnessErrors({ skillVersion, docs = [] }) {
  const errs = []
  const verMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(skillVersion ?? '').trim())
  const skillMajor = verMatch ? Number(verMatch[1]) : null
  for (const { name, text } of docs) {
    if (!name || text === undefined) continue
    if (name === 'README.md' || name === 'README.en.md') {
      const bm = /img\.shields\.io\/badge\/version-v([0-9]+\.[0-9]+\.[0-9]+)/.exec(text)
      if (bm && skillVersion && bm[1] !== skillVersion) {
        errs.push(`${name} 版本徽章写着 v${bm[1]}，而 SKILL.md metadata.version 是 ${skillVersion}`)
      }
      const suf = /\bproject-forge-v[0-9]+\b/.exec(text)
      if (suf) errs.push(`${name} 示例使用了会过时的版本目录后缀「${suf[0]}」，改用「project-forge-main」`)
    }
    const ms = /\bM[0-9]+\b/.exec(text)
    if (ms) {
      errs.push(`${name} 含内部施工阶段代号「${ms[0]}」——常青文档只陈述当前真实结构，阶段记录留在 docs/archive/`)
    }
    if (skillMajor !== null) {
      for (const m of text.matchAll(/\bv([0-9]+)\.([0-9]+)(?:\.([0-9]+))?\b/g)) {
        const maj = Number(m[1])
        if (maj > skillMajor) {
          errs.push(`${name} 出现了高于 SKILL.md（${skillVersion}）的未发布版本号「${m[0]}」`)
          break
        }
        if (name === 'docs/TDD.md' && m[3] !== undefined && `${m[1]}.${m[2]}.${m[3]}` !== skillVersion) {
          errs.push(`docs/TDD.md 显式版本号「${m[0]}」与 SKILL.md（${skillVersion}）不一致`)
          break
        }
      }
    }
  }
  return errs
}

export function checkEvergreenFreshness({ ROOT, rel, readText, walk, fail, note }) {
  const skillRaw = existsSync(join(ROOT, 'SKILL.md')) ? readText(join(ROOT, 'SKILL.md')) : ''
  const skillVer = /^ {2}version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+)["']?/m.exec(skillRaw)?.[1] ?? ''
  const docPaths = [
    join(ROOT, 'SKILL.md'),
    join(ROOT, 'AGENTS.md'),
    join(ROOT, 'docs', 'TDD.md'),
    join(ROOT, 'README.md'),
    join(ROOT, 'README.en.md'),
    ...walk(join(ROOT, 'references'), (f) => f.endsWith('.md')),
    ...walk(join(ROOT, 'templates'), (f) => f.endsWith('.md')),
    ...walk(join(ROOT, 'kit', 'skills'), (f) => basename(f) === 'SKILL.md'),
  ]
  const docs = docPaths.filter((p) => existsSync(p)).map((p) => ({ name: rel(p), text: readText(p) }))
  const errs = evergreenFreshnessErrors({ skillVersion: skillVer, docs })
  for (const e of errs) fail(`常青保鲜：${e}`)
  if (errs.length === 0) note(`常青保鲜：${docs.length} 份常青文档无未发布版本号（基准 ${skillVer || 'none'}）或 M* 阶段残留，双语徽章对齐`)
}
