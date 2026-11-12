#!/usr/bin/env node
/**
 * 故障注入复验：逐个把关键判据拆掉，确认对应的断言真的变红，再还原确认变绿。
 *
 * 这不是测试的一部分，是**证明测试不是空的**。测试全绿有两种可能——代码对了，或者
 * 测试什么都没测；只有亲眼看到它红过，才排除后一种。
 *
 * 用法：node scripts/dev/verify-injections.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

/** 每条注入：改哪个文件、把什么换成什么、期望哪条断言变红。 */
const INJECTIONS = [
  {
    id: 'I1',
    what: '临时文件清理不看「属主还活着」',
    file: 'scripts/lib/fs-atomic.mjs',
    from: 'if (pid === process.pid || processAlive(pid)) { kept.push(join(dir, name)); continue }',
    to: 'if (pid === process.pid) { kept.push(join(dir, name)); continue }',
    expect: '临时文件清理',
  },
  {
    id: 'I2',
    what: 'apiTarget 拼出的地址里留 undefined',
    file: 'scripts/lib/protocol.mjs',
    from: 'latest: `https://api.github.com/repos/${repo}/releases/latest`,',
    to: 'latest: `https://api.github.com/repos/${undefined}/${undefined}/releases/latest`,',
    expect: 'apiTarget',
  },
  {
    id: 'I3',
    what: '受管区间的 customized 标记失效',
    file: 'scripts/lib/protocol.mjs',
    from: '  return { id: m[1].trim(), customized: true }',
    to: '  return { id: m[1].trim(), customized: false }',
    expect: 'customized',
  },
  {
    id: 'I4',
    what: '缺口清单不再报「缺 AGENTS.md」',
    file: 'scripts/survey.mjs',
    from: '  if (!facts.docs.agents && facts.scale.effectiveFiles > 0) {',
    to: '  if (false) {',
    expect: 'mature',
  },
  {
    id: 'I5',
    what: '导航不再推 docs-set',
    file: 'scripts/lib/render.mjs',
    from: '  if (docsTriggers.some(Boolean)) {',
    to: '  if (false) {',
    expect: 'docs-set',
  },
  {
    id: 'I6',
    what: 'README.en.md 的 S3 顺序改反',
    file: 'README.en.md',
    from: 'Repo → docs → remote → automation',
    to: 'Repo → remote → docs → automation',
    expect: 'S3 落盘顺序',
  },
]

function runFixtures() {
  const res = spawnSync(process.execPath, [join(HERE, 'fixtures.mjs')], {
    encoding: 'utf8', timeout: 300000,
  })
  const all = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  return {
    failed: all.split('\n').filter((l) => l.startsWith('FAIL')),
    summary: all.split('\n').filter((l) => /行为断言/.test(l)).join(' '),
  }
}

function runPreflight() {
  const res = spawnSync(process.execPath, [join(HERE, 'preflight.mjs')], {
    encoding: 'utf8', timeout: 300000,
  })
  const all = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  return { failed: all.split('\n').filter((l) => l.startsWith('FAIL')) }
}

let bad = 0
for (const inj of INJECTIONS) {
  const full = join(ROOT, inj.file)
  const original = readFileSync(full, 'utf8')
  if (!original.includes(inj.from)) {
    process.stdout.write(`${inj.id} 跳过：${inj.file} 里找不到要替换的那一段\n`)
    bad += 1
    continue
  }
  writeFileSync(full, original.replace(inj.from, inj.to), 'utf8')
  try {
    const result = inj.file.startsWith('README') || inj.file.startsWith('scripts/dev')
      ? runPreflight() : runFixtures()
    const hit = result.failed.some((line) => line.includes(inj.expect))
    if (hit) {
      const sample = result.failed.find((line) => line.includes(inj.expect))
      process.stdout.write(`${inj.id} 红了（正确）：${inj.what}\n    ${sample.slice(0, 110)}\n`)
    } else {
      process.stdout.write(`${inj.id} **没红**（判据被拆掉却没人报）：${inj.what}\n`)
      bad += 1
    }
  } finally {
    writeFileSync(full, original, 'utf8')
  }
}

// 还原之后必须全绿——否则注入留下的痕迹本身成了故障。
const after = runFixtures()
const pre = runPreflight()
if (after.failed.length === 0 && pre.failed.length === 0) {
  process.stdout.write(`\n还原后全绿：${after.summary}\n`)
} else {
  process.stdout.write(`\n还原后仍红：\n${[...after.failed, ...pre.failed].join('\n')}\n`)
  bad += 1
}

process.stdout.write(bad === 0
  ? `\n故障注入复验：${INJECTIONS.length} 条判据都能被抓到，还原后全绿。\n`
  : `\n故障注入复验未通过：${bad} 处有问题。\n`)
process.exit(bad === 0 ? 0 : 1)
