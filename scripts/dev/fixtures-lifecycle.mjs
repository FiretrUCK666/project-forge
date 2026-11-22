/**
 * fixtures-lifecycle.mjs —— 整条流转走一遍。
 *
 * 已有的 210 项夹具都是**单点**判据：某个函数对某个输入返回什么。
 * 没有一项验过「从 start 到 merge，每一步的阶段对不对、命令跑不跑得通」。
 * 于是每个环节各自绿，接起来走不通——认领那一步就是这么漏掉的。
 *
 * 这一条不测某个函数，测的是**流转本身**：每推进一步，阶段必须前进；
 * 卡住时必须给出能跑的命令；命令跑完之后必须真的进入下一格。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { gitCommitFast, gitInit, rmTree, runAbsAsync, tmpProject } from './fixtures-helpers.mjs'

/** 状态机的全部阶段。出现表外的值就是拼错了，比「漏一整个状态」容易发现得多。 */
const KNOWN_PHASES = new Set([
  'idle', 'ambiguous', 'blocked', 'released', 'needs-claim', 'needs-explore', 'needs-issue-context',
  'implementing', 'needs-finalize', 'needs-verify', 'needs-submit', 'needs-review',
  'needs-rework', 'ready-to-merge', 'needs-cleanup', 'stop-loss-escalated',
  'awaiting-upstream-merge', 'awaiting-remote-mr',
])

/** 每个阶段对应的 flow 子命令（没有命令的阶段写 null）。 */
const PHASE_COMMAND = {
  'needs-claim': 'claim',
  implementing: 'next',
  'needs-finalize': 'finalize',
  'needs-verify': 'verify',
  'needs-submit': 'submit',
  'needs-review': null,
  'needs-cleanup': 'cleanup',
}

async function nextOf(dir, taskId) {
  const res = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['next', '--task', taskId, '--json'], { cwd: dir })
  if (res.status !== 0) return { err: `flow next 退出码 ${res.status}：${String(res.stderr).slice(0, 200)}` }
  try {
    return { out: JSON.parse(res.stdout) }
  } catch {
    return { err: `flow next 输出不是 JSON：${String(res.stdout).slice(0, 120)}` }
  }
}

export function registerLifecycleCases(cases) {
  cases.push(['整条流转：每一步都前进，卡住时给得出能跑的命令', async () => {
    const dir = tmpProject({
      'README.md': '# lc\n\n流转测试仓。\n',
      'AGENTS.md': [
        '```yaml',
        'quick-test: node -e "process.exit(0)"',
        'full-test: node -e "process.exit(0)"',
        'smoke-verify: node -e "process.exit(0)"',
        'merge-gate: node -e "process.exit(0)"',
        'high-risk: src/',
        'do-not-edit: docs/archive/',
        '```',
        '',
      ].join('\n'),
      'docs/specs/261117-issue9-lc-spec.md': [
        '---', 'kind: spec', 'title: lc', 'status: approved', 'owner: me', 'approved: true', 'plan_critique: passed', '---', '',
        '# SPEC: lc', '', '## 要解决的问题', '', '流转测试。', '',
        '## 冻结的验收标准', '', '- [ ] C1: 退出码 0', '',
        '## 影响范围', '', '- `src/a.mjs`', '',
      ].join('\n'),
      'docs/todo/261117-issue9-lc-todo.md': [
        '---', 'kind: todo', 'title: lc', 'status: active', 'owner: me', '---', '',
        '# Todo: lc', '', '## 验收标准与执行清单', '', '- [ ] C1: 退出码 0', '',
      ].join('\n'),
      'src/a.mjs': 'export const a = 1\n',
    })

    try {
      gitInit(dir)
      gitCommitFast(dir, 'init')

      // 造一个挂 Issue 的任务：认领那一格才会出现
      const start = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', [
        'start', '--task', 'lc', '--case', '4',
        '--spec', 'docs/specs/261117-issue9-lc-spec.md',
        '--todo', 'docs/todo/261117-issue9-lc-todo.md',
        '--json',
      ], { cwd: dir })
      if (start.status !== 0) return `start 失败：${String(start.stderr).slice(0, 250)}`

      const seen = []
      let last = null

      // 走前 12 步。每一步：阶段必须已知、不许倒退、不许停在原地打转。
      for (let step = 0; step < 12; step += 1) {
        const r = await nextOf(dir, 'lc')
        if (r.err) return r.err
        const out = r.out

        if (!KNOWN_PHASES.has(out.phase)) {
          return `第 ${step + 1} 步出现了表外的阶段 ${out.phase}——不是漏了状态，就是拼错了`
        }

        // 实施这一格本来就要等人写代码，不是自走的——原地不动是对的。
        // 其余任何一格原地不动都是缺陷（跑完命令阶段没前进）。
        const waitingOnHuman = out.phase === "implementing"
        if (!waitingOnHuman && last && last.phase === out.phase && last.command === out.command) {
          return `卡在 ${out.phase} 不动了（第 ${step} 与第 ${step + 1} 步完全相同）`
        }

        // 卡住时必须给得出能跑的命令——给不出就等于让人自己猜
        const blocked = (out.blockingReasons ?? []).length > 0
        if (blocked && !out.command) {
          return `${out.phase} 判了阻塞 ${out.blockingReasons.join(',')}，却没给出任何命令`
        }

        // 命令必须是真的子命令，不是随手拼的字符串
        if (out.command) {
          const m = /flow\.mjs"?\s+([a-z-]+)/.exec(out.command)
          if (m) {
            const known = ['inspect', 'next', 'explore', 'start', 'claim', 'release', 'finalize', 'verify', 'submit',
              'rework', 'sync', 'merge', 'cleanup', 'status', 'abort', 'batch']
            if (!known.includes(m[1])) return `${out.phase} 给的命令用了不存在的子命令 ${m[1]}`
          }
        }

        seen.push(out.phase)
        last = out

        // 认领之后立刻推进一步，验证命令真的能跑通
        if (out.phase === 'needs-claim') {
          const claim = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['claim', '--task', 'lc', '--json'], { cwd: dir })
          if (claim.status !== 0) return `认领命令跑不通：${String(claim.stderr).slice(0, 200)}`
          // 就在这一刻核：认领必须落进账本，否则「认领过」只活在这一屏。
          const led = JSON.parse(readFileSync(join(dir, '.worktrees', '.state', 'tasks', 'lc.json'), 'utf8'))
          if (!led.claimedAt) return '认领跑完了但账本没记 claimedAt'
          if (led.status !== 'claimed') return `认领之后 status 是 ${led.status}`
        }
        if (out.phase === 'needs-explore') {
          const exp = await runAbsAsync('kit/skills/dev-flow/scripts/flow.mjs', ['explore', '--task', 'lc', '--json'], { cwd: dir })
          if (exp.status !== 0) return `探索命令跑不通：${String(exp.stderr).slice(0, 200)}`
          const led = JSON.parse(readFileSync(join(dir, '.worktrees', '.state', 'tasks', 'lc.json'), 'utf8'))
          if (!led.explored?.at || !led.explored?.tier) return `explore 跑完了但账本没记 explored：${JSON.stringify(led.explored)}`
        }
        // 实施格：模拟子代理写代码并提交，验证阶段真的会前进
        if (out.phase === "implementing") {
          const wt = out.worktreePath ? join(dir, out.worktreePath) : dir
          writeFileSync(join(wt, "src", "a.mjs"), "export const a = 2\n")
          gitCommitFast(wt, "实施一点东西")
          const after = await nextOf(dir, "lc")
          if (after.err) return after.err
          if (after.out.phase === "implementing") {
            return `提交之后仍停在 implementing：${after.out.nextAction}`
          }
        }

        // 归档 / 实证 / 提审：这三步实施者能自己推，必须真的跑
        if (out.phase === "needs-finalize") {
          // 实施者要先勾选验收条目——finalize 会拒「还有未勾选的」，那是对的。
          const wtRoot = join(dir, ".worktrees", "impl-lc")
          for (const rel of ["docs/todo/261117-issue9-lc-todo.md", "docs/specs/261117-issue9-lc-spec.md"]) {
            for (const base of [dir, wtRoot]) {
              const abs = join(base, rel)
              if (!existsSync(abs)) continue
              writeFileSync(abs, readFileSync(abs, "utf8").replace(/- \[ \]/g, "- [x]"))
            }
          }
          // 勾选要提交进分支，否则 finalize 看的是另一个 HEAD
          if (existsSync(wtRoot)) gitCommitFast(wtRoot, "勾选验收条目")
          const fin = await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["finalize", "--task", "lc", "--json"], { cwd: dir })
          if (fin.status !== 0) return `finalize 跑不通：${String(fin.stderr).slice(0, 220)}`
        }
        if (out.phase === "needs-verify") {
          const ver = await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["verify", "--task", "lc", "--mode", "gate", "--e2e-evidence", "lifecycle cli exit=0", "--json"], { cwd: dir })
          if (ver.status !== 0) return `verify 跑不通：${String(ver.stderr).slice(0, 220)}`
        }

        if (out.phase === "needs-submit") {
          const sub = await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["submit", "--task", "lc", "--agent", "local-agent", "--json"], { cwd: dir })
          if (sub.status !== 0) return `submit 跑不通：${String(sub.stderr).slice(0, 220)}`
        }

        // 只读阶段（等审查、等合并）不是实施者能推进的，停在这里
        if (out.phase === 'needs-review' || out.phase === 'ready-to-merge') break
      }

      if (seen.length < 2) return `全程只经过 ${seen.length} 个阶段：${seen.join(' → ')}`
      if (!seen.includes('needs-claim')) return '新任务没经过认领那一格'

      // 终态断言：一路走下来必须真的推进到提审之后，而不是停在原地
      const finalLedger = JSON.parse(readFileSync(join(dir, '.worktrees', '.state', 'tasks', 'lc.json'), 'utf8'))
      if (!finalLedger.claimedAt) return '整条走完但账本里没有 claimedAt'
      if (!finalLedger.finalized) return '整条走完但账本没记 finalized'
      if (!finalLedger.verifiedHead) return '整条走完但账本没有实证记录'

      return true
    } finally {
      rmTree(dir)
    }
  }])
}
