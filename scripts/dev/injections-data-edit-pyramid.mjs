#!/usr/bin/env node
/**
 * injections-data-edit-pyramid.mjs —— dev-edit 词法门禁、过程工件命名拦截、三层倒金字塔与 dev-govern 自动触发故障注入复验数据表（I187–I196）。
 *
 * 导出 `INJECTIONS_EDIT_PYRAMID` 供 `injections-data.mjs` 自动发现加载，
 * 也可直接运行 `node scripts/dev/injections-data-edit-pyramid.mjs` 在隔离临时副本中逐条实证。
 */

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushAndExit } from '../../kit/skills/lib/cli.mjs'
import { isMainModule } from '../../kit/skills/lib/git.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const INJECTIONS_EDIT_PYRAMID = [
  {
    id: 'I187',
    what: 'C5 edit-gate 放行无正当锚点的压制注释（suppression-bypass 漏报）',
    file: 'kit/skills/lib/static-gates.mjs',
    alsoDropIn: ['.agents/skills/lib/static-gates.mjs'],
    from: 'if (!hasJustify && ((commentText && (EXCUSE_COMMENT_RE.test(commentText) || EXCUSE_TEMP_RE.test(commentText))) || RUST_ALLOW_RE.test(views.codeNoLiteralLines[i]))) {',
    to: 'if (false && !hasJustify && ((commentText && (EXCUSE_COMMENT_RE.test(commentText) || EXCUSE_TEMP_RE.test(commentText))) || RUST_ALLOW_RE.test(views.codeNoLiteralLines[i]))) {',
    expect: 'StageC C5',
  },
  {
    id: 'I188',
    what: 'C5 edit-gate 允许 --final 最终验证阶段经 --skip-edit-gate 绕过门禁',
    file: 'kit/skills/dev-edit/scripts/edit-gate.mjs',
    alsoDropIn: ['.agents/skills/dev-edit/scripts/edit-gate.mjs'],
    from: '  if (opts.skipEditGate) {\n    if (opts.final) {',
    to: '  if (opts.skipEditGate) {\n    if (false && opts.final) {',
    expect: 'StageC C5',
  },
  {
    id: 'I189',
    what: 'C5 通用过程工件文件名门禁 checkProcessArtifactFilename 失效漏报',
    file: 'kit/skills/lib/static-gates-lexer.mjs',
    alsoDropIn: ['.agents/skills/lib/static-gates-lexer.mjs'],
    from: '  const m = PROCESS_ARTIFACT_FILENAME_RE.exec(stem)\n  if (!m) return null',
    to: '  const m = null\n  if (!m) return null',
    expect: 'StageC C5',
  },
  {
    id: 'I190',
    what: 'C6 signals.mjs 读旧无指纹日志时跳过实时虚拟指纹补全',
    file: 'kit/skills/lib/signals.mjs',
    alsoDropIn: ['.agents/skills/lib/signals.mjs'],
    from: '      if (obj && typeof obj === \'object\') events.push(enrichSignalEvent(obj))',
    to: '      if (obj && typeof obj === \'object\') events.push(obj)',
    expect: 'StageC C6：signals 指纹兼容',
  },
  {
    id: 'I191',
    what: 'C6 review-sync 退回忽略 labelRes 失败（始终报 labelSynced=true）',
    file: 'kit/skills/dev-review/scripts/review-sync.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-sync.mjs'],
    from: '    if (failed) {',
    to: '    if (false && failed) {',
    expect: 'StageC C6：signals 指纹兼容',
  },
  {
    id: 'I192',
    what: 'C6 补强#1 普通审查跳过范围外/存量高危发现的确定性分级建单',
    file: 'kit/skills/dev-review/scripts/review-sync.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-sync.mjs'],
    from: "    if (tier !== 'escalated-issue') continue",
    to: '    continue',
    expect: 'StageC C6：signals 指纹兼容',
  },
  {
    id: 'I193',
    what: 'C6 review-sync 跳过 PR 审查评论验收标准表格无损竖线转义',
    file: 'kit/skills/dev-review/scripts/review-sync.mjs',
    alsoDropIn: ['.agents/skills/dev-review/scripts/review-sync.mjs'],
    from: "    .replace(/(?<!\\\\)\\|/g, '\\\\|')",
    to: "    .replace(/__disabled_pipe__/g, '\\\\|')",
    expect: 'StageC C6：signals 指纹兼容',
  },
  {
    id: 'I194',
    what: 'C6 govern-retro 忽略 --allow-tier3-fallback 开关重新默认向 AGENTS.md 追加规则',
    file: 'kit/skills/dev-govern/scripts/govern-retro.mjs',
    alsoDropIn: ['.agents/skills/dev-govern/scripts/govern-retro.mjs'],
    from: '  if (opts.allowTier3Fallback && !String(opts.reason ?? \'\').trim()) {',
    to: '  if (false && opts.allowTier3Fallback && !String(opts.reason ?? \'\').trim()) {',
    expect: 'StageC C6：严格三层倒金字塔',
  },
  {
    id: 'I195',
    what: 'C7 govern-state recordGovernSkip 跳过空 reason 校验',
    file: 'kit/skills/dev-govern/scripts/govern-state.mjs',
    alsoDropIn: ['.agents/skills/dev-govern/scripts/govern-state.mjs'],
    from: "  if (!cleanReason) return { ok: false, error: '--skip-govern requires non-empty --reason \"<text>\"' }",
    to: "  if (false && !cleanReason) return { ok: false, error: '--skip-govern requires non-empty --reason \"<text>\"' }",
    expect: 'StageC C7',
  },
  {
    id: 'I196',
    what: 'C8 govern-tests 退回对小型单层 5+ 测试仓误报 tests.unfiltered-quick-test',
    file: 'kit/skills/dev-govern/scripts/govern-tests.mjs',
    alsoDropIn: ['.agents/skills/dev-govern/scripts/govern-tests.mjs'],
    from: '  const needsQuickFilter = testFiles.length >= 15 || totalTestLines >= 2500 || (hasNonUnitTier && testFiles.length >= 5)',
    to: '  const needsQuickFilter = testFiles.length >= 5',
    expect: 'StageC C8',
  },
]

function copyRepoForSandbox(srcRoot, dstRoot) {
  for (const rel of ['kit', '.agents', 'scripts']) {
    cpSync(join(srcRoot, rel), join(dstRoot, rel), { recursive: true })
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const sandbox = mkdtempSync(join(tmpdir(), 'pf-ep-inj-'))
  let failed = 0
  try {
    copyRepoForSandbox(ROOT, sandbox)
    for (const inj of INJECTIONS_EDIT_PYRAMID) {
      const targets = [inj.file, ...(inj.alsoDropIn ?? [])]
      const backups = []
      let applied = true
      for (const rel of targets) {
        const abs = join(sandbox, rel)
        const orig = readFileSync(abs, 'utf8')
        if (!orig.includes(inj.from)) {
          process.stderr.write(`FAIL [${inj.id}]: target snippet not found in ${rel}\n`)
          applied = false
          break
        }
        backups.push({ abs, orig })
        writeFileSync(abs, orig.replace(inj.from, inj.to), 'utf8')
      }
      if (!applied) {
        failed += 1
        for (const b of backups) writeFileSync(b.abs, b.orig, 'utf8')
        continue
      }
      const res = spawnSync(process.execPath, [join(sandbox, 'scripts', 'dev', 'fixtures-edit-pyramid.mjs')], {
        cwd: sandbox,
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      })
      for (const b of backups) writeFileSync(b.abs, b.orig, 'utf8')
      const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
      if (res.status === 0 || !combined.includes(inj.expect)) {
        failed += 1
        process.stderr.write(`FAIL [${inj.id}] ${inj.what}: expected red with "${inj.expect}", got exit=${res.status}\n${combined.slice(0, 400)}\n`)
      } else {
        process.stdout.write(`CAUGHT [${inj.id}] ${inj.what}\n`)
      }
    }
    process.stdout.write(`\nedit-pyramid 故障注入汇总：${INJECTIONS_EDIT_PYRAMID.length - failed}/${INJECTIONS_EDIT_PYRAMID.length} 精准拦截，${failed} 失败。\n`)
    await flushAndExit(failed === 0 ? 0 : 1)
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
}
