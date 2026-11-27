/**
 * preflight-e2e.mjs —— CLI 帮助、纯文档渲染、真实目标执行、自举与临时项目端到端并发冒烟测试。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { AGENTS_MAX_BYTES, conditionMarkers, parseMarkers, templateVarsOf } from '../lib/protocol.mjs'

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
      contractHealth: ca.contractHealth,
      runSurvey: sv.survey,
      reviewProject: rv.reviewProject,
      handoffScan: hf.scan,
    }))
  }
  return e2eDepsPromise
}

const HELP_CHILD_CODE = [
  'const targets = JSON.parse(process.env.PF_HELP_TARGETS || "[]");',
  'const origOut = process.stdout.write.bind(process.stdout);',
  'const origErr = process.stderr.write.bind(process.stderr);',
  'const results = [];',
  'for (const item of targets) {',
  '  const outChunks = [];',
  '  const errChunks = [];',
  '  const cap = (b) => (c, enc, cb) => {',
  '    if (typeof enc === "function") { cb = enc; enc = undefined; }',
  '    b.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c), typeof enc === "string" ? enc : "utf8"));',
  '    if (typeof cb === "function") cb();',
  '    return true;',
  '  };',
  '  const prevExit = process.exitCode;',
  '  process.exitCode = undefined;',
  '  process.stdout.write = cap(outChunks);',
  '  process.stderr.write = cap(errChunks);',
  '  let status = 0;',
  '  try {',
  '    const mod = await import(item.url);',
  '    const entry = typeof mod?.runCli === "function" ? mod.runCli : (typeof mod?.main === "function" ? mod.main : null);',
  '    if (!entry) { errChunks.push(Buffer.from("missing runCli export\\n")); status = 1; }',
  '    else {',
  '      const code = await Promise.resolve(entry(["--help"]));',
  '      status = typeof code === "number" ? code : (typeof process.exitCode === "number" ? process.exitCode : 0);',
  '    }',
  '  } catch (err) {',
  '    errChunks.push(Buffer.from(err instanceof Error ? (err.message + "\\n") : (String(err) + "\\n")));',
  '    status = 1;',
  '  } finally {',
  '    process.exitCode = prevExit;',
  '    process.stdout.write = origOut;',
  '    process.stderr.write = origErr;',
  '  }',
  '  results.push({',
  '    name: item.name,',
  '    status,',
  '    stdout: Buffer.concat(outChunks).toString("utf8"),',
  '    stderr: Buffer.concat(errChunks).toString("utf8"),',
  '  });',
  '}',
  'origOut(JSON.stringify({ results }));',
].join('\n')

function runHelpsInSingleChild(targets) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', HELP_CHILD_CODE], {
      env: { ...process.env, PF_HELP_TARGETS: JSON.stringify(targets) },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out = []
    const err = []
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 25000)
    timer.unref?.()
    child.stdout?.on('data', (c) => out.push(c))
    child.stderr?.on('data', (c) => err.push(c))
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0) {
        done({ error: `--help 批量校验子进程失败（退出 ${code}）：${(stderr || stdout).trim().split('\n')[0]}` })
        return
      }
      try {
        done(JSON.parse(stdout))
      } catch (e) {
        done({ error: `--help 批量校验子进程输出解析失败：${e.message}` })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ error: `--help 批量校验子进程启动失败：${error.message}` })
    })
  })
}

export async function checkHelps({ ROOT, fail }) {
  const names = ['survey.mjs', 'backup.mjs', 'compose-agents.mjs', 'review.mjs', 'handoff.mjs', 'sync-toc.mjs', 'update.mjs', 'equip.mjs']
  const targets = []
  for (const name of names) {
    const p = join(ROOT, 'scripts', name)
    if (!existsSync(p)) { fail(`缺脚本 ${name}`); continue }
    targets.push({ name, url: pathToFileURL(p).href })
  }
  if (targets.length === 0) return
  const batch = await runHelpsInSingleChild(targets)
  if (batch.error) { fail(batch.error); return }
  const byName = new Map((batch.results ?? []).map((r) => [r.name, r]))
  for (const { name } of targets) {
    const res = byName.get(name)
    if (!res) { fail(`${name} --help 未返回校验结果`); continue }
    if (res.status !== 0) {
      fail(`${name} --help 跑不通（退出 ${res.status}）：${(res.stderr || '').trim().split('\n')[0]}`)
      continue
    }
    if (!/用法/.test(res.stdout || '')) fail(`${name} --help 没打印用法`)
  }
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
  const { runSurvey, reviewProject, handoffScan, contractHealth } = await loadE2eDeps()
  const facts = await runSurvey(ROOT)
  if (!facts || !facts.target) {
    fail('survey.mjs 在真实项目上跑勘察失败：返回结果缺少 target')
    return
  }
  const hRes = handoffScan(ROOT)
  if (!hRes || typeof hRes.total !== 'number') {
    fail('handoff.mjs 在真实项目上跑交棒扫描失败：返回结果缺少 total')
    return
  }
  const [revRes, health] = await Promise.all([
    reviewProject(ROOT, { facts }),
    contractHealth(ROOT, { facts }),
  ])
  const missing = revRes?.missing ?? []
  if (missing.length > 0) {
    fail(`review.mjs 在真实项目上跑交付体检失败：${missing.slice(0, 3).map((m) => `${m.id}: ${m.title}`).join('；')}`)
  }
  note('真目标：4 个入口都在本仓库上跑通（不是只在临时目录里跑）')

  const agentsText = readText(join(ROOT, 'AGENTS.md'))
  const fills = parseMarkers(agentsText, 'AGENTS.md').filter((m) => m.kind === 'fill')
  const contractIssues = [
    ...(health.broken ?? []).map((b) => `标记没成对：${b}`),
    ...(fills.length > 0 ? [`还有 ${fills.length} 处未填占位`] : []),
    ...(health.missing ?? []).map((m) => `缺节：${m}`),
    ...(health.drifted ?? []).map((d) => `漂移：${d}`),
    ...(health.oversize ? [`体积超限（${health.bytes} > ${AGENTS_MAX_BYTES}）`] : []),
  ]
  if (contractIssues.length > 0) {
    fail(`本仓库自己的 AGENTS.md 没通过自举校验：${contractIssues.slice(0, 6).join(' / ')}`)
    return
  }
  const agentsBytes = Buffer.byteLength(agentsText, 'utf8')
  if (agentsBytes > AGENTS_MAX_BYTES) {
    fail(`本仓库自己的 AGENTS.md 体积 ${agentsBytes} 字节超过上限 ${AGENTS_MAX_BYTES}`)
    return
  }
  note(`自举：本仓库自己的 AGENTS.md（${agentsBytes} 字节 <= ${AGENTS_MAX_BYTES}）标记成对、没有未填占位、该有的节都在`)
}

const SMOKE_CHILD_CODE = [
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  'const tmp = process.env.PF_SMOKE_TMP;',
  'const { runCli } = await import(process.env.PF_COMPOSE_URL);',
  'const { reviewProject } = await import(process.env.PF_REVIEW_URL);',
  'const { scan: handoffScan } = await import(process.env.PF_HANDOFF_URL);',
  'const origOut = process.stdout.write.bind(process.stdout);',
  'const origErr = process.stderr.write.bind(process.stderr);',
  'const noop = () => true;',
  'process.stdout.write = noop;',
  'process.stderr.write = noop;',
  'const failures = [];',
  'const c1 = await runCli([tmp]);',
  "if (c1 !== 0 || !existsSync(join(tmp, 'AGENTS.md'))) failures.push('compose-agents 没生成 AGENTS.md');",
  'else {',
  "  const before = readFileSync(join(tmp, 'AGENTS.md'));",
  '  const c2 = await runCli([tmp]);',
  "  if (c2 !== 0) failures.push('compose-agents 第二遍跑失败');",
  "  const after = readFileSync(join(tmp, 'AGENTS.md'));",
  "  if (!before.equals(after)) failures.push('compose-agents 不幂等：第二遍改了文件');",
  "  for (const bad of ['.project-forge', join('scripts', 'review-record.mjs')]) {",
  '    if (existsSync(join(tmp, bad))) failures.push(`compose-agents 在目标项目里留下了 ${bad}——侵入面必须为零`);',
  '  }',
  "  const [check1, revRes, h1Report] = await Promise.all([runCli([tmp, '--check']), reviewProject(tmp), Promise.resolve(handoffScan(tmp))]);",
  "  if (check1 === 0) failures.push('AGENTS.md 还有未填占位，但 --check 放行了');",
  "  if (!revRes.missing.some((m) => m.id === 'agents.unfilled')) failures.push('review 没报出 AGENTS.md 里未填的占位');",
  "  if (h1Report.clean !== false) failures.push('AGENTS.md 里还有标记，handoff --verify 却说干净');",
  "  await runCli([tmp, '--clean']);",
  '  const h2Report = handoffScan(tmp);',
  '  if (!h2Report.clean || h2Report.markers.length > 0) failures.push(`剥掉标记之后 handoff 仍说脏：${JSON.stringify(h2Report.markers)}`);',
  '}',
  'process.stdout.write = origOut;',
  'process.stderr.write = origErr;',
  'process.stdout.write(JSON.stringify({ failures }));',
].join('\n')

function runSmokeInSingleChild(ROOT, tmp) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', SMOKE_CHILD_CODE], {
      env: {
        ...process.env,
        PF_SMOKE_TMP: tmp,
        PF_COMPOSE_URL: pathToFileURL(join(ROOT, 'scripts', 'compose-agents.mjs')).href,
        PF_REVIEW_URL: pathToFileURL(join(ROOT, 'scripts', 'review.mjs')).href,
        PF_HANDOFF_URL: pathToFileURL(join(ROOT, 'scripts', 'handoff.mjs')).href,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out = []
    const err = []
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 60000)
    timer.unref?.()
    child.stdout?.on('data', (c) => out.push(c))
    child.stderr?.on('data', (c) => err.push(c))
    child.on('close', (code) => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0) {
        done({ failures: [`端到端冒烟子进程失败（退出 ${code}）：${(stderr || stdout).trim().split('\n')[0]}`] })
        return
      }
      try {
        done(JSON.parse(stdout))
      } catch (e) {
        done({ failures: [`端到端冒烟子进程输出解析失败：${e.message}`] })
      }
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      done({ failures: [`端到端冒烟子进程启动失败：${error.message}`] })
    })
  })
}

async function smoke({ ROOT, fail, note }) {
  const { runSurvey } = await loadE2eDeps()
  const tmp = mkdtempSync(join(tmpdir(), 'pf-smoke-'))
  try {
    writeFileSync(join(tmp, 'package.json'), JSON.stringify({
      name: 'demo-app', version: '0.1.0', private: true,
      scripts: { test: 'node -e "process.exit(0)"' },
    }, null, 2))
    writeFileSync(join(tmp, 'README.md'), '# demo-app\n\n一个用来跑冒烟验证的示例项目，说明足够长。\n')
    writeFileSync(join(tmp, '.gitignore'), 'node_modules/\n')

    const facts = await runSurvey(tmp)
    for (const field of ['maturity', 'git', 'ecosystem', 'commands', 'docs', 'risks', 'gaps', 'questions']) {
      if (facts[field] === undefined) fail(`survey 的输出缺字段 ${field}`)
    }
    if (facts.maturity !== 'greenfield') fail(`空白项目的 maturity 应为 greenfield，实际是 ${facts.maturity}`)
    if (!facts.ecosystem.kinds.includes('node')) fail(`应识别出 node 生态，实际是 ${facts.ecosystem.kinds.join(',')}`)

    const res = await runSmokeInSingleChild(ROOT, tmp)
    for (const msg of res.failures ?? []) fail(msg)
  } finally {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) } catch { /* 留给系统清理 */ }
  }
  note('端到端：勘察 → 生成（幂等）→ 门禁 → 体检 → 交棒，全跑通')
}

export async function runE2eChecks(ctx) {
  await Promise.all([
    checkTemplateRender(ctx).catch((err) => ctx.fail(`模板渲染异常：${err instanceof Error ? err.message : String(err)}`)),
    checkHelps(ctx),
    checkRunsOnRealTarget(ctx).catch((err) => ctx.fail(`真目标异常：${err instanceof Error ? err.message : String(err)}`)),
    smoke(ctx).catch((err) => ctx.fail(`端到端冒烟异常：${err instanceof Error ? err.message : String(err)}`)),
  ])
}
