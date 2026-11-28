/**
 * fixtures-plan-wave-helpers.mjs —— 规划与切片夹具共用的造仓与拼文档工具。
 *
 * 不是测试域：本文件不导出 `register*Cases`，`fixtures.mjs` 的自动发现会直接跳过它。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { gitInit, tmpProject } from './fixtures-helpers.mjs'

const PLAN_AGENTS = [
  '# plan-wave',
  '',
  '```yaml',
  'quick-test: exit 0',
  'full-test: exit 0',
  'smoke-verify: none',
  'merge-gate: exit 0',
  'high-risk: none',
  '```',
  '',
].join('\n')

/** 拼一份规划文档：只列本次判据关心的字段，其余按模板最小形状给。 */
function makeDoc({ kind, title = 'T', status, extra = [], body = [] }) {
  return [
    '---',
    `kind: ${kind}`,
    `title: "${title}"`,
    `status: ${status}`,
    'created: 2026-11-20',
    'updated: 2026-11-20',
    ...extra,
    '---',
    '',
    `# ${title}`,
    '',
    '## 要解决的问题',
    '- 判据测试。',
    '',
    '## 本期不做',
    '- 不做别的。',
    '',
    '## 门型与回滚路径',
    '- two-way；revert',
    '',
    ...body,
    '',
  ].join('\n')
}

function makeMaster({ criteria = ['C1', 'C2'], status = 'active', extra = [] } = {}) {
  return makeDoc({
    kind: 'prd',
    title: 'Master',
    status,
    extra: ['owner: p', 'multi_spec: true', 'plan_critique: passed', 'related_spec: null', 'related_todo: null', ...extra],
    body: ['## 五、验收标准', ...criteria.map((c) => `- [ ] ${c}: 切片 ${c}`)],
  })
}

function makeSpec({ taskId, issue = 1, status = 'approved', approved = true, critique = 'passed', scope = [], deps = [], criteria = ['C1'], extra = [] } = {}) {
  const extraLines = [
    `issue: ${issue}`,
    'pr: null',
    'branch: null',
    'owner: p',
    `approved: ${approved}`,
    'implemented: false',
    `plan_critique: ${critique}`,
    'related_prd: ../prd/261120-master-prd.md',
    'related_todo: null',
    'high_risk_paths: []',
    `task_id: ${taskId}`,
    `depends_on: [${deps.join(', ')}]`,
    `scope_files: [${scope.join(', ')}]`,
    ...extra,
  ]
  // 正文里的写域清单是 `flow batch plan` 用的那一份：它从「改动文件」这类标题下
  // 抽反引号包住的带扩展名路径。与 Frontmatter 的 `scope_files` 是同一件事的两个入口，
  // 两边都要给，波次编排才排得出并行；glob 写法只进 Frontmatter（正文抽取只认具体文件）。
  const plainScope = scope.map((s) => String(s).replace(/^"|"$/g, '')).filter((s) => !s.includes('*'))
  const scopeBody = plainScope.length > 0
    ? ['## 改动文件', '', ...plainScope.map((s) => `- \`${s}\``), '']
    : []
  return makeDoc({
    kind: 'spec',
    title: `S-${taskId}`,
    status,
    extra: ['tier: L3', ...extraLines],
    body: [...scopeBody, '## 验收标准', ...criteria.map((c) => `- [x] ${c}: 已完成`)],
  })
}

function makeWaveRepo({ specs = [], master = null } = {}) {
  const files = {
    '.gitignore': '.worktrees/\n',
    'AGENTS.md': PLAN_AGENTS,
    'src/app.mjs': 'export const v = 1\n',
  }
  if (master !== null) files['docs/prd/261120-master-prd.md'] = master
  for (const { file, text } of specs) files[file] = text
  const dir = tmpProject(files)
  gitInit(dir, { branch: 'main', name: 'alice', email: 'alice@example.com' })
  return dir
}

export { PLAN_AGENTS, makeDoc, makeMaster, makeSpec, makeWaveRepo }
