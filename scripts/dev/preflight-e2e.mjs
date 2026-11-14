/**
 * preflight-e2e.mjs —— CLI 帮助、纯文档渲染、真实目标执行、自举与临时项目端到端冒烟测试。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENTS_MAX_BYTES, conditionMarkers, templateVarsOf } from '../lib/protocol.mjs'

function run(ROOT, script, args, opts = {}) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', script), ...args], {
    encoding: 'utf8',
    timeout: 120000,
    ...opts,
  })
}

function checkHelps({ ROOT, fail }) {
  for (const name of ['survey.mjs', 'backup.mjs', 'compose-agents.mjs', 'review.mjs', 'handoff.mjs', 'sync-toc.mjs', 'update.mjs', 'equip.mjs']) {
    const p = join(ROOT, 'scripts', name)
    if (!existsSync(p)) { fail(`缺脚本 ${name}`); continue }
    const res = spawnSync(process.execPath, [p, '--help'], { encoding: 'utf8', timeout: 20000 })
    if (res.status !== 0) {
      fail(`${name} --help 跑不通（退出 ${res.status}）：${(res.stderr || '').trim().split('\n')[0]}`)
      continue
    }
    if (!/用法/.test(res.stdout || '')) fail(`${name} --help 没打印用法`)
  }
}

function checkTemplateRender({ ROOT, fail, note }) {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-render-'))
  try {
    writeFileSync(join(tmp, 'README.md'), '# demo\n\n一个纯文档项目，用来核对渲染产物。\n')
    const res = spawnSync(process.execPath, [join(ROOT, 'scripts', 'compose-agents.mjs'), tmp], {
      encoding: 'utf8',
      timeout: 60000,
    })
    if (res.status !== 0) { fail(`在纯文档项目上渲染 AGENTS.md 失败：${(res.stderr || '').trim()}`); return }
    const out = join(tmp, 'AGENTS.md')
    if (!existsSync(out)) { fail('渲染没有产出 AGENTS.md'); return }
    const text = readFileSync(out, 'utf8')

    const leaked = templateVarsOf(text)
    if (leaked.length > 0) fail(`渲染产物里还有未替换的占位符：${leaked.map((n) => `{{${n}}}`).join('、')}`)
    if (conditionMarkers(text, 'x.md').length > 0) fail('渲染产物里还有 if/endif——条件求值漏了一层')
    if (!/project-forge:\s*(?:begin|fill)/.test(text)) fail('渲染产物里没有任何受管标记——它从此没法被刷新')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > AGENTS_MAX_BYTES) fail(`纯文档项目渲染生成的 AGENTS.md 体积 ${bytes} 字节超过上限 ${AGENTS_MAX_BYTES}`)
    note(`渲染：纯文档项目上生成的 AGENTS.md（${bytes} 字节 <= ${AGENTS_MAX_BYTES}）没有残留占位符、没有残留条件块`)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 留给系统清理 */ }
  }
}

function checkRunsOnRealTarget({ ROOT, fail, note }) {
  const calls = [
    { script: 'survey.mjs', args: [ROOT], what: '勘察' },
    { script: 'handoff.mjs', args: [ROOT, '--json'], what: '交棒扫描' },
    { script: 'review.mjs', args: [ROOT, '--json'], what: '交付体检' },
    { script: 'compose-agents.mjs', args: [ROOT, '--status'], what: '契约状态' },
  ]
  for (const call of calls) {
    const res = run(ROOT, call.script, call.args)
    if (res.status !== 0) {
      const first = (res.stderr || '').trim().split('\n').find((line) => line && !/^\s+at /.test(line)) ?? ''
      fail(`${call.script} 在真实项目上跑${call.what}失败（退出 ${res.status}）：${first.slice(0, 200)}`)
    }
  }
  note(`真目标：${calls.length} 个入口都在本仓库上跑通（不是只在临时目录里跑）`)
}

function checkSelfHost({ ROOT, readText, fail, note }) {
  const res = run(ROOT, 'compose-agents.mjs', [ROOT, '--check'], { timeout: 60000 })
  if (res.status !== 0) {
    fail(`本仓库自己的 AGENTS.md 没通过自举校验：${(res.stderr || res.stdout || '').trim().split('\n').slice(0, 6).join(' / ')}`)
    return
  }
  const agentsBytes = Buffer.byteLength(readText(join(ROOT, 'AGENTS.md')), 'utf8')
  if (agentsBytes > AGENTS_MAX_BYTES) {
    fail(`本仓库自己的 AGENTS.md 体积 ${agentsBytes} 字节超过上限 ${AGENTS_MAX_BYTES}`)
    return
  }
  note(`自举：本仓库自己的 AGENTS.md（${agentsBytes} 字节 <= ${AGENTS_MAX_BYTES}）标记成对、没有未填占位、该有的节都在`)
}

function smoke({ ROOT, fail, note }) {
  const tmp = mkdtempSync(join(tmpdir(), 'pf-smoke-'))
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'demo-app', version: '0.1.0', private: true,
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2))
    writeFileSync(join(tmp, 'README.md'), '# demo-app\n\n一个用来跑冒烟验证的示例项目，说明足够长。\n')
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n')

    const s = run(ROOT, 'survey.mjs', [tmp])
    if (s.status !== 0) { fail(`survey 冒烟失败：${(s.stderr || '').trim()}`); return }
    let facts
    try { facts = JSON.parse(s.stdout) } catch { fail('survey 的输出不是 JSON'); return }
    for (const field of ['maturity', 'git', 'ecosystem', 'commands', 'docs', 'risks', 'gaps', 'questions']) {
      if (facts[field] === undefined) fail(`survey 的输出缺字段 ${field}`)
    }
    if (facts.maturity !== 'greenfield') fail(`空白项目的 maturity 应为 greenfield，实际是 ${facts.maturity}`)
    if (!facts.ecosystem.kinds.includes('node')) fail(`应识别出 node 生态，实际是 ${facts.ecosystem.kinds.join(',')}`)

    const c1 = run(ROOT, 'compose-agents.mjs', [tmp])
    if (c1.status !== 0 || !existsSync(join(tmp, 'AGENTS.md'))) { fail('compose-agents 没生成 AGENTS.md'); return }

    const before = readFileSync(join(tmp, 'AGENTS.md'))
    const c2 = run(ROOT, 'compose-agents.mjs', [tmp])
    if (c2.status !== 0) fail('compose-agents 第二遍跑失败')
    const after = readFileSync(join(tmp, 'AGENTS.md'))
    if (!before.equals(after)) fail('compose-agents 不幂等：第二遍改了文件')

    const check1 = run(ROOT, 'compose-agents.mjs', [tmp, '--check'])
    if (check1.status === 0) fail('AGENTS.md 还有未填占位，但 --check 放行了')

    for (const bad of ['.project-forge', join('scripts', 'review-record.mjs')]) {
      if (existsSync(join(tmp, bad))) fail(`compose-agents 在目标项目里留下了 ${bad}——侵入面必须为零`)
    }

    const r = run(ROOT, 'review.mjs', [tmp])
    if (!/交付体检/.test(r.stdout || '')) fail('review 没输出体检报告')
    if (!/没填|未填|fill/.test(r.stdout || '')) fail('review 没报出 AGENTS.md 里未填的占位')

    const h1 = run(ROOT, 'handoff.mjs', [tmp, '--verify'])
    if (h1.status === 0) fail('AGENTS.md 里还有标记，handoff --verify 却说干净')
    run(ROOT, 'compose-agents.mjs', [tmp, '--clean'])
    const h2 = run(ROOT, 'handoff.mjs', [tmp, '--verify'])
    if (h2.status !== 0) fail(`剥掉标记之后 handoff --verify 仍说脏：${(h2.stdout || '').trim()}`)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 留给系统清理 */ }
  }
  note('端到端：勘察 → 生成（幂等）→ 门禁 → 体检 → 交棒，全跑通')
}

export function runE2eChecks(ctx) {
  checkHelps(ctx)
  checkTemplateRender(ctx)
  checkRunsOnRealTarget(ctx)
  checkSelfHost(ctx)
  smoke(ctx)
}
