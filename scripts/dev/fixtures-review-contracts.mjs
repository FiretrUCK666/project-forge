/**
 * fixtures-review-contracts.mjs —— 审查栏四字段与收尾七步判据本体夹具。
 */

import { join } from 'node:path'
import { loadPreflight } from './fixtures-helpers.mjs'

export function registerReviewContractsCases(cases) {
// ── 审查栏与收尾步骤：判据本体（不是复刻一份循环） ──────────────────────
//
// 这几条 import `preflight.mjs` 里的**判据本体**来验。复刻一份循环的断言不会因为判据被
// 削弱而变红，于是「判据坏了」这件事没有任何东西看着——那正是这次要消灭的形状。
// 反面用例同样重要：判据如果会误伤正常写法，修的人第一件事是把判据放宽，而放宽之后
// 它就再也拦不住真问题了。

cases.push(['审查栏：四个字段必须排在同一段里', async () => {
  const { reviewBlockMissing } = await loadPreflight()
  const block = [
    '- **审查来源**：子代理',
    '- **逐条标准状态**：fail: 无',
    '- **故障注入记录**：删了一行，红了',
    '- **止损记录**：未触发',
  ].join('\n')
  if (reviewBlockMissing(block).length !== 0) return '四行排在一起却仍报缺'

  // 正面：删掉一行，那一块就不完整了。
  for (const drop of [0, 1, 2, 3]) {
    const lines = block.split('\n')
    lines.splice(drop, 1)
    if (reviewBlockMissing(lines.join('\n')).length === 0) return `删掉第 ${drop + 1} 行仍被判成完整`
  }

  // 正面（这是这次修的形状）：同样的四个词散落在不相邻的段落里，不算一块。
  // 「出现过就算」的判据在这里会假绿——而正文里解释这些字段时本来就会用到这些词。
  const scattered = [
    '- **审查来源**：子代理',
    '',
    '这段正文解释什么叫逐条标准状态。',
    '',
    '这段正文又提到故障注入记录。',
    '',
    '- **止损记录**：未触发',
  ].join('\n')
  if (reviewBlockMissing(scattered).length === 0) {
    return '分散在正文里的同名文字被当成了一个字段块——这正是「出现过就算」的假绿形状'
  }

  // 反面：一条都没有时，四项全报，不许说齐了。
  if (reviewBlockMissing('## 独立审查\n\n什么都没写\n').length !== 4) return '一条都没有时应当四项全缺'
  return true
}])

cases.push(['验收标准编号：可勾选那一行必须是 C 加数字', async () => {
  const { acceptanceIdMissing } = await loadPreflight()
  if (acceptanceIdMissing('- [ ] C1: 能跑通')) return '`C1` 这种形状被误判成缺编号'
  if (acceptanceIdMissing('- [ ] C12: 也是合法编号')) return '两位数字被误判'
  if (acceptanceIdMissing('- [x] C3: 勾掉的也算')) return '已勾选的那一行被误判'

  // 正面：三种常见的「看起来像编号」都不是判据认的形状。
  for (const bad of ['- [ ] 1. 能跑通', '- [ ] 第一条能跑通', '- [ ] (C) 能跑通']) {
    if (!acceptanceIdMissing(bad)) return `${bad} 这种写法被当成了合法编号`
  }

  // 反面：**别处的举例不算数。** 填写指引里本来就举了个 `C1` 的例子；按「文里出现过」判
  // 的话，清单被改成 `1.` 也照样绿——判据被那句举例削成了恒真。
  const withExample = [
    '<!-- 写法：一条一行，id 用 `C1`、`C2` 这样的短标识 -->',
    '',
    '- [ ] 1. 清单本身已经改成序号了',
  ].join('\n')
  if (!acceptanceIdMissing(withExample)) return '指引里的举例把判据撑成了恒真'
  return true
}])

cases.push(['收尾七步：齐且有序才通过，缺一步或顺序乱都要报', async () => {
  const { finishStepsState } = await loadPreflight()
  const line = (n) => `  ${n}. `
  const body = [
    line(1) + '把要写的东西写完，并纳入这次 PR：工作记录的「完成后的记录」、验收标准勾选；',
    line(2) + '合并 PR（**不勾选自动删分支**）；',
    line(3) + '回读确认 `state=MERGED`；',
    line(4) + '`git switch main && git pull`；',
    line(5) + '`git worktree remove <路径>`；',
    line(6) + '`git branch -d <分支>`；',
    line(7) + '`git push origin --delete <分支>`。',
  ]
  const wrap = (steps) => ['## 日常协作', '', '- **第四步：合并收尾与平台交互防乱码**——固定 7 步：', ...steps, '', '- **日常到此为止**'].join('\n')

  const good = finishStepsState(wrap(body))
  if (good.missing.length !== 0) return `七步齐全却报缺：${good.missing.map(String).join('、')}`
  if (good.outOfOrder) return '七步按顺序写却报顺序错'

  // 正面一：缺一步。
  const missingOne = finishStepsState(wrap(body.filter((s) => !s.includes('worktree remove'))))
  if (missingOne.missing.length !== 1) return `删掉 worktree remove 后应报缺 1 步，实际 ${missingOne.missing.length}`

  // 正面二：worktree remove 与 branch -d 对调——这是真实会犯的错，报错还会说「未合并」。
  const swapped = [...body]
  const i5 = swapped.findIndex((s) => s.includes('worktree remove'))
  const i6 = swapped.findIndex((s) => s.includes('git branch -d'))
  ;[swapped[i5], swapped[i6]] = [swapped[i6], swapped[i5]]
  const bad = finishStepsState(wrap(swapped))
  if (bad.missing.length !== 0) return '对调两步不应报缺'
  if (!bad.outOfOrder) return 'worktree remove 与 branch -d 对调没有被判成顺序错'

  // 正面三：**把「写记录」挪到合并之后**——这正是逼出多余 PR 的那个顺序。
  const recordLate = [
    body[1], body[2], body[0], body[3], body[4], body[5], body[6],
  ]
  const late = finishStepsState(wrap(recordLate))
  if (!late.outOfOrder) return '把「写记录」挪到合并之后没有被判成顺序错——那正是逼出多余 PR 的顺序'

  // 反面：整份文档里别处提到某一步，不算数——判据只看那一段的行范围。
  const noise = ['七步之外的正文里提到 git worktree remove 与 git branch -d。', '', wrap(body.slice(0, 2))].join('\n')
  const partial = finishStepsState(noise)
  if (partial.missing.length !== 5) return `正文里的提及被算成了步骤（应缺 5 步，实际 ${partial.missing.length}）`
  return true
}])

cases.push(['收尾清单没有锚点时报「七步全缺」，不是静默通过', async () => {
  const { finishStepsState } = await loadPreflight()
  // 一条判据在锚点找不到时静默返回「没问题」，等于它被削成了恒真。
  const state = finishStepsState('## 别的节\n\n- 什么也没有\n')
  if (state.missing.length !== 7) return `没有锚点时应报缺 7 步，实际 ${state.missing.length}`
  return true
}])

cases.push(['收尾步骤核对清单：三种角色一个都不能少', async () => {
  // 「个数等于列表长度」是恒真的：列表删短，两个数一起变小。所以判据按**角色**查。
  // 这条断言调的是判据本体——复刻一份循环的话，判据被改松时复制品不会红。
  const { finishSiteRolesMissing } = await loadPreflight()

  const full = ['templates/agents-project.md', 'AGENTS.md', 'references/collaboration.md']
  if (finishSiteRolesMissing(full).length !== 0) {
    return `三处都在却报缺角色：${finishSiteRolesMissing(full).join('、')}`
  }

  const cases = [
    ['删掉判据源头', full.filter((s) => s !== 'references/collaboration.md'), '判据源头'],
    ['删掉实例', full.filter((s) => s !== 'AGENTS.md'), '实例'],
    ['删掉骨架', full.filter((s) => s !== 'templates/agents-project.md'), '骨架'],
  ]
  for (const [name, sites, want] of cases) {
    const missing = finishSiteRolesMissing(sites)
    if (!missing.some((role) => role.includes(want))) {
      return `${name}后没有报缺「${want}」，实际：${missing.join('、') || '（空）'}——`
        + '那一处从此没人查，而它会一直显示「一致」'
    }
  }

  // 反面：把三处换成别的文件，角色对不上就该报，避免判据退化成「非空即过」。
  const wrong = ['README.md', 'CONTRIBUTING.md', 'SKILL.md']
  if (finishSiteRolesMissing(wrong).length !== 3) {
    return `换成不承担这三种角色的文件后，应报缺 3 个角色，实际 ${finishSiteRolesMissing(wrong).length}`
  }
  return true
}])

cases.push(['收尾七步：插入一步不该让内容下限假红', async () => {
  const { finishRequiredMissing } = await loadPreflight()

  const steps = (extra) => [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '  3. 回读确认 `state=MERGED`；',
    '  4. `git switch main && git pull`；',
    '  5. `git worktree remove <路径>`；',
    '  6. `git branch -d <分支>`；',
    ...extra,
    '  删远端分支之前查两件事：远端还在不在（`git ls-remote --heads origin <分支>`）、'
      + '有没有下游堆叠 PR 以该分支为 base；两件都清了才 `git push origin --delete <分支>`。',
    '',
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '',
  ].join('\n')

  const seven = steps(['  7. '])
  if (finishRequiredMissing(seven).length !== 0) {
    return `标准七步却报缺：${finishRequiredMissing(seven).join('、')}`
  }

  // 插入一步：原来教 `git push origin --delete` 的那一步变成第 8 步。
  const eight = steps(['  7. `git status` 看一眼；', '  8. '])
  const missing = finishRequiredMissing(eight)
  if (missing.length !== 0) {
    return `插入一步后假红：${missing.join('、')}——判据按编号认步骤，不是按内容认`
  }

  // 反面：把教 `git push origin --delete` 的那一步整条删掉，必须报（说明它是真的在认内容）。
  const noPush = [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '',
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '',
  ].join('\n')
  if (!finishRequiredMissing(noPush).some((l) => l.includes('远端还在不在'))) {
    return '把教 push --delete 的那一步删掉之后没有报缺'
  }

  return true
}])

cases.push(['收尾七步：三处教人敲的命令必须一致，措辞可以不同', async () => {
  // 顺序判据看不见「同一件事的两半各写一处」：第 7 步一边写「查下游堆叠 PR」、
  // 一边写「git ls-remote」，两句话读起来都对，照着做会漏一半。这条断言盯命令，不盯措辞。
  const { finishCommandsOf } = await loadPreflight()

  const base = [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '  3. 回读确认 `state=MERGED`；',
    '  4. `git switch main && git pull`；',
    '  5. `git worktree remove <路径>`；',
    '  6. `git branch -d <分支>`；',
    '  7. 先查（`git ls-remote --heads origin <分支>`）再 `git push origin --delete <分支>`。',
    '',
  ].join('\n')

  const want = finishCommandsOf(base)
  // 粒度是**子命令**（`git branch`、`git worktree`），不带后面的参数：
  // 参数在一处写成 `<路径>`、另一处写成 `<worktree 路径>`，那是措辞差异，不该报。
  // 带不带 `-d` 这类真正的参数差异，由七步的存在性判据（`FINISH_STEPS` 里的 `/git branch -d/`）管。
  if (!want || want.length !== 6) {
    return `七步里应读出 6 条 git 子命令，实际：${want ? want.join('、') : 'undefined'}`
  }
  for (const cmd of ['git switch', 'git pull', 'git worktree', 'git branch', 'git ls-remote', 'git push']) {
    if (!want.includes(cmd)) return `漏了 ${cmd}，实际：${want.join('、')}`
  }

  // **正面：只改白话，六条命令一字不动**——必须判成一致。
  //
  // 这一面是判据的全部价值所在：如果「说法不同」也报，两份文档就被焊死了，以后想给不同
  // 读者写不同的话都不行。所以样本得**保留每一条行内代码**，只换外面的字。
  const reworded = base
    .replace('1. 把要写的东西写完；', '1. 该写的先写完，跟着这次改动一起提交；')
    .replace('2. 合并 PR；', '2. 把 PR 合掉；')
    .replace('3. 回读确认 `state=MERGED`；', '3. 回去看一眼，状态得是 `state=MERGED`；')
    .replace('先查（`git ls-remote --heads origin <分支>`）再', '先看远端还在不在（`git ls-remote --heads origin <分支>`），确认了再')
  const rew = finishCommandsOf(reworded)
  if (!rew || rew.length !== 6) {
    return `只改白话时命令数应保持 6 条，实际：${rew ? rew.join('、') : 'undefined'}`
  }
  if (rew.join('|') !== want.join('|')) {
    return `只改白话却读出了不同的命令集：${want.join('、')} → ${rew.join('、')}`
  }

  // **反面一：连命令一起删**——这才是不一致。
  const dropOne = base.replace('先查（`git ls-remote --heads origin <分支>`）再', '先看远端还在不在，确认之后再')
  const dropped = finishCommandsOf(dropOne)
  if (!dropped) return '删掉 ls-remote 那条命令后读不出命令集'
  if (dropped.includes('git ls-remote')) return '删掉 ls-remote 之后仍然读得到它'
  if (dropped.length !== 5) return `删掉一条命令后应剩 5 条，实际 ${dropped.length}`

  // **反面二：没有七步锚点时返回 undefined，不是空数组**——
  // 空数组会被上层当成「没有命令」，于是「找不到」和「一个都没写」长得一样。
  if (finishCommandsOf('## 别的节\n\n什么也没有\n') !== undefined) {
    return '没有锚点时应返回 undefined，不能返回空数组'
  }
  return true
}])

cases.push(['收尾章：内容下限抓得住「三处一起漏」', async () => {
  // 三处互相比对只有**相对下限**：三处一起删掉一条命令，对拍永远说「一致」。
  // 而改规则的人恰恰会同时改三处——集体遗忘比单点漂移更常见。这条断言盯的是绝对下限。
  const { finishRequiredMissing } = await loadPreflight()

  const full = [
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '  3. 回读确认 `state=MERGED`；',
    '  4. `git switch main && git pull`；',
    '  5. `git worktree remove <路径>`；',
    '  6. `git branch -d <分支>`；',
    '  7. 删远端分支之前查两件事：远端还在不在（`git ls-remote --heads origin <分支>`）、'
      + '有没有下游堆叠 PR 以该分支为 base；两件都清了才 `git push origin --delete <分支>`。',
    '',
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '',
  ].join('\n')

  if (finishRequiredMissing(full).length !== 0) {
    return `要素齐全却报缺：${finishRequiredMissing(full).join('、')}`
  }

  // 反面一：删掉「下游堆叠 PR」那半句。
  const noDownstream = full.replace('、有没有下游堆叠 PR 以该分支为 base', '')
  if (!finishRequiredMissing(noDownstream).some((l) => l.includes('下游堆叠'))) {
    return '删掉「下游堆叠 PR」之后没有报缺——这一半又没有守卫了'
  }

  // 反面二：把「查远端」这一整半删掉（命令和白话一起删）。
  const noProbe = full
    .replace('远端还在不在（`git ls-remote --heads origin <分支>`）、', '')
  if (!finishRequiredMissing(noProbe).some((l) => l.includes('远端还在不在'))) {
    return '删掉「查远端」这一整半之后没有报缺'
  }

  // 反面二之二：**只删命令、留着那句白话，也必须报。**
  // 这一面治的是「把断言放宽成认白话」——那样一来「三处一起删掉命令」就静默通过了。
  const cmdGone = full.replace('`git ls-remote --heads origin <分支>`', '')
  if (!finishRequiredMissing(cmdGone).some((l) => l.includes('远端还在不在'))) {
    return '只删 ls-remote 命令、留白话，仍然算交代——断言被放宽了'
  }

  // 反面三：删掉「删之前先问」那一整段。
  const noAsk = full.replace('  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。\n', '')
  if (!finishRequiredMissing(noAsk).some((l) => l.includes('问一次'))) {
    return '删掉「删之前先问」之后没有报缺'
  }

  // 反面三之二（回归防线）：即使七步正文里出现了 worktree、本地分支、远端分支、回读确认，
  // 删掉独立散文段仍必须报缺——七步本身不能自凑齐 ask-before-delete。
  const stepsHaveKeywords = full
    .replace('`git branch -d <分支>`；', '再删本地分支 `git branch -d <分支>`；')
    .replace('  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。\n', '')
  if (!finishRequiredMissing(stepsHaveKeywords).some((l) => l.includes('问一次'))) {
    return '七步里凑齐了四个词但独立问询段被删，ask-before-delete 却放行了（假阴性漏检复发）'
  }

  // 反面四：**同一章里别处的正常用法不能算交代**——
  // 「产物清单」「卸之前先问人」「弱化门禁要人点头」都在这一章里，但都不是这条要求。
  const decoys = full.replace(
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。\n',
    '  这一章别处还会说「产物清单」「卸之前先问人」「弱化门禁必须人点头」。\n',
  )
  if (!finishRequiredMissing(decoys).some((l) => l.includes('问一次'))) {
    return '别处的「产物清单 / 卸之前先问人 / 要人点头」被当成了交代——这一条又被蒙混了'
  }

  // 反面四：**同一个词出现在章外的别处，不算交代**——
  // 这正是先前那类「话说得比扫过的范围大」的毛病。范围是本章，不是全文。
  const outside = [
    '## 别的节', '',
    '这里顺嘴提到 git ls-remote、下游堆叠 PR、问人点头。', '',
    '## 日常协作', '',
    '- **第四步：合并收尾**——固定 7 步：',
    '  1. 把要写的东西写完；',
    '  2. 合并 PR；',
    '',
    '## 下一节', '',
    '什么也没有。', '',
  ].join('\n')
  if (finishRequiredMissing(outside).length !== 3) {
    return `章外提到不算交代：应报缺 3 项，实际 ${finishRequiredMissing(outside).length} 项`
  }

  const stepScoped = full.replace(
    '  7. 删远端分支之前查两件事：远端还在不在（`git ls-remote --heads origin <分支>`）、'
      + '有没有下游堆叠 PR 以该分支为 base；两件都清了才 `git push origin --delete <分支>`。',
    '  7. 删远端分支之前查有没有下游堆叠 PR；两件都清了才 `git push origin --delete <分支>`。',
  ).replace(
    '  **第 5 步之前先把要删的清单列出来问一次**',
    '  解释段：远端用 `git ls-remote --heads origin <分支>` 查一下。\n\n  **第 5 步之前先把要删的清单列出来问一次**',
  )
  if (!finishRequiredMissing(stepScoped).some((l) => l.includes('远端还在不在'))) {
    return '要素挪到第 7 步之后的解释段仍然算数——步正文没有收口'
  }

  const reordered = full.replace(
    '  哪个 worktree、哪条本地分支、哪条远端分支。',
    '  哪条本地分支、哪个 worktree、哪条远端分支。',
  )
  if (finishRequiredMissing(reordered).length !== 0) {
    return `清单换序被误报：${finishRequiredMissing(reordered).join('、')}`
  }

  const multiline = full.replace(
    '  **第 5 步之前先把要删的清单列出来问一次**：哪个 worktree、哪条本地分支、哪条远端分支。',
    '  **第 5 步之前先把要删的清单列出来问一次**：\n\n```text\n- worktree\n- 本地分支\n- 远端分支\n```',
  )
  if (finishRequiredMissing(multiline).length !== 0) {
    return `清单改成分行被误报：${finishRequiredMissing(multiline).join('、')}`
  }

  return true
}])
}
