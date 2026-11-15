/**
 * preflight-e2e.mjs —— CLI 帮助、纯文档渲染、真实目标执行、自举与临时项目端到端并发冒烟测试。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AGENTS_MAX_BYTES, conditionMarkers, templateVarsOf } from '../lib/protocol.mjs'

let e2eDepsPromise
function loadE2eDeps() {
  if (!e2eDepsPromise) {
    e2eDepsPromise = Promise.all([
      import('../compose-agents.mjs'),
      import('../survey.mjs'),
      import('../review.mjs'),
      import('../handoff.mjs'),
    ]).then(([ca, sv, rv, hf]) => ({
      renderAgentsTemplate: ca.renderAgentsTemplate,
      runSurvey: sv.survey,
      reviewProject: rv.reviewProject,
      handoffScan: hf.scan,
    }))
  }
  return e2eDepsPromise
}

function runAsync(ROOT, script, args, opts = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, 'scripts', script), ...args], {
      windowsHide: true,
      ...opts,
    })
    const out = []
    const err = []
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
    }, opts.timeout ?? 120000)
    child.stdout?.on('data', (c) => out.push(c))
    child.stderr?.on('data', (c) => err.push(c))
    child.on('close', (code) => {
      clearTimeout(timer)
      done({
        status: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ status: 1, stdout: '', stderr: error.message })
    })
  })
}

async function checkHelps({ ROOT, fail }) {
  const names = ['survey.mjs', 'backup.mjs', 'compose-agents.mjs', 'review.mjs', 'handoff.mjs', 'sync-toc.mjs', 'update.mjs', 'equip.mjs']
  await Promise.all(names.map(async (name) => {
    const p = join(ROOT, 'scripts', name)
    if (!existsSync(p)) { fail(`缺脚本 ${name}`); return }
    const res = await runAsync(ROOT, name, ['--help'], { timeout: 20000 })
    if (res.status !== 0) {
      fail(`${name} --help 跑不通（退出 ${res.status}）：${(res.stderr || '').trim().split('\n')[0]}`)
      return
    }
    if (!/用法/.test(res.stdout || '')) fail(`${name} --help 没打印用法`)
  }))
}

async function checkTemplateRender({ ROOT, fail, note }) {
  const { renderAgentsTemplate, runSurvey } = await loadE2eDeps()
  const tmp = mkdtempSync(join(tmpdir(), 'pf-render-'))
  try {
    writeFileSync(join(tmp, 'README.md'), '# demo\n\n一个纯文档项目，用来核对渲染产物。\n')
    const template = readFileSync(join(ROOT, 'templates', 'agents-project.md'), 'utf8').replace(/\r\n/g, '\n')
    const facts = await runSurvey(tmp)
    const text = renderAgentsTemplate(facts, template, tmp)
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

async function checkRunsOnRealTarget({ ROOT, readText, fail, note }) {
  const [surveyRes, handoffRes, reviewRes, statusRes, checkRes] = await Promise.all([
    runAsync(ROOT, 'survey.mjs', [ROOT]),
    runAsync(ROOT, 'handoff.mjs', [ROOT, '--json']),
    runAsync(ROOT, 'review.mjs', [ROOT, '--json']),
    runAsync(ROOT, 'compose-agents.mjs', [ROOT, '--status']),
    runAsync(ROOT, 'compose-agents.mjs', [ROOT, '--check'], { timeout: 60000 }),
  ])

  const calls = [
    { script: 'survey.mjs', what: '勘察', res: surveyRes },
    { script: 'handoff.mjs', what: '交棒扫描', res: handoffRes },
    { script: 'review.mjs', what: '交付体检', res: reviewRes },
    { script: 'compose-agents.mjs', what: '契约状态', res: statusRes },
  ]
  for (const call of calls) {
    if (call.res.status !== 0) {
      let detail = (call.res.stderr || '').trim().split('\n').find((line) => line && !/^\s+at /.test(line)) ?? ''
      if (!detail && call.res.stdout) {
        try {
          const parsed = JSON.parse(call.res.stdout)
          const miss = Array.isArray(parsed?.missing)
            ? parsed.missing
            : (Array.isArray(parsed?.results) ? parsed.results.filter((r) => r.level === 'missing') : [])
          if (miss.length > 0) detail = miss.slice(0, 3).map((m) => `${m.id}: ${m.summary}`).join('；')
        } catch { /* not json */ }
        if (!detail) detail = call.res.stdout.trim().split('\n').find((l) => l.trim()) ?? ''
      }
      fail(`${call.script} 在真实项目上跑${call.what}失败（退出 ${call.res.status}）：${detail.slice(0, 200)}`)
    }
  }
  note(`真目标：${calls.length} 个入口都在本仓库上跑通（不是只在临时目录里跑）`)

  if (checkRes.status !== 0) {
    fail(`本仓库自己的 AGENTS.md 没通过自举校验：${(checkRes.stderr || checkRes.stdout || '').trim().split('\n').slice(0, 6).join(' / ')}`)
    return
  }
  const agentsBytes = Buffer.byteLength(readText(join(ROOT, 'AGENTS.md')), 'utf8')
  if (agentsBytes > AGENTS_MAX_BYTES) {
    fail(`本仓库自己的 AGENTS.md 体积 ${agentsBytes} 字节超过上限 ${AGENTS_MAX_BYTES}`)
    return
  }
  note(`自举：本仓库自己的 AGENTS.md（${agentsBytes} 字节 <= ${AGENTS_MAX_BYTES}）标记成对、没有未填占位、该有的节都在`)
}

async function smoke({ ROOT, fail, note }) {
  const { reviewProject, handoffScan } = await loadE2eDeps()
  const tmp = mkdtempSync(join(tmpdir(), 'pf-smoke-'))
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'demo-app', version: '0.1.0', private: true,
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2))
    writeFileSync(join(tmp, 'README.md'), '# demo-app\n\n一个用来跑冒烟验证的示例项目，说明足够长。\n')
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n')

    const s = await runAsync(ROOT, 'survey.mjs', [tmp])
    if (s.status !== 0) { fail(`survey 冒烟失败：${(s.stderr || '').trim()}`); return }
    let facts
    try { facts = JSON.parse(s.stdout) } catch { fail('survey 的输出不是 JSON'); return }
    for (const field of ['maturity', 'git', 'ecosystem', 'commands', 'docs', 'risks', 'gaps', 'questions']) {
      if (facts[field] === undefined) fail(`survey 的输出缺字段 ${field}`)
    }
    if (facts.maturity !== 'greenfield') fail(`空白项目的 maturity 应为 greenfield，实际是 ${facts.maturity}`)
    if (!facts.ecosystem.kinds.includes('node')) fail(`应识别出 node 生态，实际是 ${facts.ecosystem.kinds.join(',')}`)

    const c1 = await runAsync(ROOT, 'compose-agents.mjs', [tmp])
    if (c1.status !== 0 || !existsSync(join(tmp, 'AGENTS.md'))) { fail('compose-agents 没生成 AGENTS.md'); return }

    const before = readFileSync(join(tmp, 'AGENTS.md'))
    const c2 = await runAsync(ROOT, 'compose-agents.mjs', [tmp])
    if (c2.status !== 0) fail('compose-agents 第二遍跑失败')
    const after = readFileSync(join(tmp, 'AGENTS.md'))
    if (!before.equals(after)) fail('compose-agents 不幂等：第二遍改了文件')

    for (const bad of ['.project-forge', join('scripts', 'review-record.mjs')]) {
      if (existsSync(join(tmp, bad))) fail(`compose-agents 在目标项目里留下了 ${bad}——侵入面必须为零`)
    }

    const [check1, revRes, h1Report] = await Promise.all([
      runAsync(ROOT, 'compose-agents.mjs', [tmp, '--check']),
      reviewProject(tmp),
      Promise.resolve(handoffScan(tmp)),
    ])
    if (check1.status === 0) fail('AGENTS.md 还有未填占位，但 --check 放行了')
    if (!revRes.missing.some((m) => m.id === 'agents.unfilled')) {
      fail('review 没报出 AGENTS.md 里未填的占位')
    }
    if (h1Report.clean !== false) fail('AGENTS.md 里还有标记，handoff --verify 却说干净')

    await runAsync(ROOT, 'compose-agents.mjs', [tmp, '--clean'])
    const h2Report = handoffScan(tmp)
    if (!h2Report.clean || h2Report.markers.length > 0) {
      fail(`剥掉标记之后 handoff 仍说脏：${JSON.stringify(h2Report.markers)}`)
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 留给系统清理 */ }
  }
  note('端到端：勘察 → 生成（幂等）→ 门禁 → 体检 → 交棒，全跑通')
}

export async function runE2eChecks(ctx) {
  await Promise.all([
    checkTemplateRender(ctx).catch((err) => ctx.fail(`模板渲染异常：${err instanceof Error ? err.message : String(err)}`)),
    checkHelps(ctx),
    checkRunsOnRealTarget(ctx),
    smoke(ctx).catch((err) => ctx.fail(`端到端冒烟异常：${err instanceof Error ? err.message : String(err)}`)),
  ])
}
