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
    from: "    when: (f) => !f.docs.agents && f.scale.effectiveFiles > 0,",
    to: "    when: () => false,",
    expect: 'AGENTS.md',
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
  {
    id: 'I7',
    what: '审查栏的四个字段表里删掉「止损记录」',
    file: 'scripts/dev/preflight.mjs',
    from: "const REVIEW_FIELDS = ['审查来源', '逐条标准状态', '故障注入记录', '止损记录']",
    to: "const REVIEW_FIELDS = ['审查来源', '逐条标准状态', '故障注入记录']",
    expect: '审查栏',
  },
  {
    id: 'I8',
    what: '模板里把「止损记录」改名成「止损」，三处说法不再一致',
    file: 'templates/pull-request-template.md',
    from: '- **止损记录**：触发过哪条止损',
    to: '- **止损**：触发过哪条止损',
    expect: '审查栏',
  },
  {
    id: 'I9',
    what: '合并收尾把第 5、6 步对调（先删分支再卸 worktree）',
    file: 'templates/agents-project.md',
    from: '  5. **先卸 worktree**：`git worktree remove <路径>`（先用 `worktree-deps` 解绑共享依赖链接再删；分支被 worktree 检出时下一步必败）；\n  6. 再删本地分支：`git branch -d <分支>`（不是 `-D`）；',
    to: '  5. **先删本地分支**：`git branch -d <分支>`（不是 `-D`）；\n  6. **再卸 worktree**：`git worktree remove <路径>`；',
    expect: '合并收尾',
  },
  {
    // 这条注入治的是「多出一个 PR」那个真实故障：把「写记录」挪到合并之后。
    // 工作记录是仓库里的文件，合并之后再改它，平台会拒掉直接推主干，只能另开一个只改记录的
    // 提案——那一个没人审、也没和原提案绑在一起。**顺序必须真的挪，只改序号判不出来**：
    // 判据按「这几句话的先后」比，不按前面的数字比。
    id: 'I9b',
    what: '合并收尾把「写记录」整块挪到合并之后（逼出多余 PR 的那个顺序）',
    file: 'templates/agents-project.md',
    from: '  1. **把要写的东西写完，并纳入这次 PR**：Todo「完成后的记录」与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、断点写成「已完成，无遗留」。**提交进同一个分支**——合并后再改文件就得另开 PR；\n  2. 合并 PR（**不勾选自动删分支**）；',
    to: '  1. 合并 PR（**不勾选自动删分支**）；\n  2. **把要写的东西写完，并纳入这次 PR**：Todo「完成后的记录」与勾选归档进 `docs/archive/todo/`、`docs/specs/` 标 `implemented`、断点写成「已完成，无遗留」。**提交进同一个分支**——合并后再改文件就得另开 PR；',
    expect: '合并收尾',
  },
  {
    // 判据源头那一份不在核对清单里时，它改了没有任何东西会报——而其余两处都跟着它走。
    id: 'I9c',
    what: '收尾步骤核对清单里删掉判据源头（references/ 那一份）',
    file: 'scripts/dev/preflight.mjs',
    from: "const FINISH_SITES = [\n  'templates/agents-project.md',\n  'AGENTS.md',\n  'references/collaboration.md',\n]",
    to: "const FINISH_SITES = [\n  'templates/agents-project.md',\n  'AGENTS.md',\n]",
    expect: '判据源头',
  },
  {
    // 同一件事在三处教人敲不同的命令，照着做会漏一半。顺序判据看不见这一类。
    id: 'I9d',
    what: '某一处的第 7 步少敲一条命令（命令对拍）',
    file: 'references/collaboration.md',
    from: '：远端还在不在（`git ls-remote --heads origin <分支>`）、有没有下游堆叠 PR',
    to: '：远端还在不在、有没有下游堆叠 PR',
    expect: '教人敲的命令不一致',
  },
  {
    // **三处一起漏**——这是互相比对永远抓不到的形状：对拍只有相对下限，三处一致就通过。
    // 而改规则的人恰恰会同时改三处，改错了也同时改错。内容下限是绝对下限。
    id: 'I9e',
    what: '三处一起删掉「下游堆叠 PR」这半句（集体遗忘）',
    file: 'references/collaboration.md',
    from: '、有没有下游堆叠 PR 以该分支为 base',
    to: '',
    expect: '没有交代',
    alsoDropIn: ['templates/agents-project.md', 'AGENTS.md'],
  },
  {
    // 判据自己少查一处——模板那一处曾被 `continue` 提前跳过，只有实例被查。
    // 这类毛病不报错，它只是安静地少查一处，所以必须有一条注入盯着。
    id: 'I9e2',
    what: '三处一起删掉「下游堆叠 PR」时，模板那一处也必须被报',
    file: 'templates/agents-project.md',
    from: '、有没有下游堆叠 PR 以该分支为 base',
    to: '',
    expect: 'templates/agents-project.md 的合并收尾没有交代',
  },
  {
    // 步正文切片不收口时，最后一步会吞掉本章余下内容，要素挪到哪都算数。
    // 这类毛病只在「最后一格」出现，前面的步骤看不出问题。
    id: 'I9f',
    what: '步正文切片不收口（最后一步吞掉整章余下内容）',
    file: 'scripts/dev/preflight.mjs',
    from: '      if (current !== null) { bodies.push(current); current = null }\n      continue\n    }\n    // 顶格的标题或新条目也是边界',
    to: '      continue\n    }\n    // 顶格的标题或新条目也是边界',
    expect: '步正文',
  },
  {
    id: 'I10',
    what: '验收标准的编号形状从 `C1` 改成 `1.`',
    file: 'templates/docs-todo.md',
    // 两条一起改：只改第一条的话，第二条 `C2` 还在，判据仍然看得到合法编号。
    from: '- [ ] C1: <第一条可判定的标准>\n- [ ] C2: <第二条>',
    to: '- [ ] 1. <第一条可判定的标准>\n- [ ] 2. <第二条>',
    expect: '验收标准编号',
  },
  {
    // 「完成后的记录」现在要求在合并之前写完。没有判据守着的话，把措辞改回「合并之后补」
    // 不会有任何信号——而那句话一改，第二个 PR 就又回来了。
    id: 'I10b',
    what: '工作记录模板把「在合并之前写完」改回「合并之后补」',
    file: 'templates/docs-todo.md',
    from: '**在合并之前写完，随这次改动一起提交。**',
    to: '**合并之后补。**',
    expect: '完成后的记录',
  },
  {
    id: 'I11',
    what: '勘察的某条缺口不再登记处置（体检那边从此没人接）',
    file: 'scripts/survey.mjs',
    from: "    text: '还没有版本库',\n    review: 'git.absent',",
    to: "    text: '还没有版本库',",
    expect: '缺口覆盖',
  },
  {
    id: 'I12',
    what: '某条缺口的处置指向一个体检里不存在的结论 id',
    file: 'scripts/survey.mjs',
    from: "    text: '还没有版本库',\n    review: 'git.absent',",
    to: "    text: '还没有版本库',\n    review: 'git.no-such-finding',",
    expect: '缺口覆盖',
  },
  {
    id: 'I13',
    what: '契约回查把「路径还在吗」削成恒真',
    file: 'scripts/lib/claims.mjs',
    from: '    const missing = allPaths.filter((p) => !exists(p))',
    to: '    const missing = []',
    expect: '契约回查',
  },
  {
    id: 'I14',
    what: '契约回查把「分支名对得上吗」削成恒真',
    file: 'scripts/lib/claims.mjs',
    from: '    const wrong = branches.filter((b) => b !== actual && b !== \'HEAD\')',
    to: '    const wrong = []',
    expect: '契约回查',
  },
  {
    id: 'I15',
    what: '锚点比对退回逐字相同（标题带副标题就再也指不上）',
    file: 'scripts/dev/preflight.mjs',
    from: "  return [...headings].filter((h) => h.replace(/`/g, '').startsWith(wanted))",
    to: "  return [...headings].filter((h) => h.replace(/`/g, '') === wanted)",
    expect: '指路落空',
  },
  {
    id: 'I16',
    what: '缺口覆盖把登记的 id 名单摘掉（双向比对被削成可选）',
    file: 'scripts/dev/gap-coverage.mjs',
    from: 'return { ...coverageOf(gapDeclarations(source), reviewIds(reviewSource), GAP_RULE_IDS), counts }',
    to: 'return { ...coverageOf(gapDeclarations(source), reviewIds(reviewSource), null), counts }',
    expect: '缺口覆盖',
  },
  {
    id: 'I17',
    what: '缺口表整段改名（词法切块彻底失灵，一条都读不出来）',
    file: 'scripts/survey.mjs',
    from: 'const GAP_RULES = [',
    to: 'const GAP_RULES_RENAMED = [',
    expect: '缺口覆盖',
  },
  {
    id: 'I18',
    what: '节号指针塞进 scripts/ 下的注释（门禁只扫文档就会漏掉）',
    file: 'scripts/lib/text.mjs',
    from: 'export ',
    // 用拼接构造那句指针：这个文件本身也要过「全仓库无节号指针」那条判据，
    // 直接写出来的话，注入还没跑，门禁先在检查器自己身上红了。
    to: `// 详见第` + `四` + `节。\nexport `,
    expect: '节号指针',
  },
  {
    id: 'I19',
    what: '破坏 .agents/skills/ 与 kit/skills/ 的字节级一致性',
    file: '.agents/skills/dev-flow/SKILL.md',
    from: 'name: dev-flow',
    to: 'name: dev-flow-drifted',
    expect: '内置套件一致性失败',
  },
  {
    id: 'I20',
    what: '把非 GitHub 平台词塞进 kit/ 产物层（验证双层平台禁词扫描）',
    file: 'kit/skills/dev-flow/SKILL.md',
    from: 'name: dev-flow',
    to: 'name: dev-flow\n# ' + 'Git' + 'Lab',
    expect: '别的托管平台不进产物层',
  },
  {
    id: 'I21',
    what: '拆掉 clone-readonly 防误判分支（他人公开仓退化成 maintainer）',
    file: 'scripts/lib/platform/github.mjs',
    from: `      return {\n        role: 'clone-readonly',\n        reason: \`origin 与 \${origin} 一致，但历史提交非本机作者且无写权限证明（按只读克隆处置）\`,\n      }`,
    to: `      return {\n        role: 'maintainer',\n        reason: \`origin 与 \${origin} 一致\`,\n      }`,
    expect: '他人公开仓被误判成',
  },
  {
    id: 'I22',
    what: '跳过 worktree-deps unmountSharedDeps 的 unlinkSync 解绑',
    file: 'kit/skills/dev-flow/scripts/worktree-deps.mjs',
    from: `      // 关键安全操作：只对符号链接/junction 本身调用 unlinkSync，绝不触碰目标目录内容\n      unlinkSync(dst)\n\n      if (lstatSafe(dst) !== null) {\n        throw new Error(\`解绑依赖链接失败，路径仍然存在：\${dst}\`)\n      }`,
    to: '      // 安全操作被跳过（未执行 unlinkSync 解绑）',
    expect: 'unmount 后 worktree node_modules 依然存在',
  },
  {
    id: 'I23',
    what: '放行外部 PR --untrusted-scan 高危 workflow/postinstall 拦截',
    file: 'kit/skills/dev-review/scripts/review-pack.mjs',
    from: '    if (hazards.length > 0 && !opts.humanApprovedExec) {',
    to: '    if (false && hazards.length > 0 && !opts.humanApprovedExec) {',
    expect: '高危 workflow/postinstall 未拦截',
  },
  {
    id: 'I24',
    what: '关闭 compose-agents.mjs 30720 字节上限阻断门禁',
    file: 'scripts/compose-agents.mjs',
    from: '    oversize: bytes > AGENTS_MAX_BYTES,',
    to: '    oversize: false,',
    expect: '30720',
  },
  {
    id: 'I25',
    what: '跳过 backup.mjs restoreBackup 对新增多余孤儿文件的 unlinkSync 清理',
    file: 'scripts/backup.mjs',
    from: '        unlinkSync(orphanAbs)',
    to: '        /* skip unlink */ void orphanAbs',
    expect: 'restore 未清理多余文件',
  },
  {
    id: 'I26',
    what: '废除 doc-plan.mjs approveSpec 的独立 Plan Critique 阻断门槛',
    file: 'kit/skills/dev-plan/scripts/doc-plan.mjs',
    from: '    if (!isPassed) {',
    to: '    if (false && !isPassed) {',
    expect: '未 critique-pass 的 SPEC 竟被 approve 放行',
  },
  {
    id: 'I27',
    what: '跳过 flow.mjs merge 的 detectGateWeakening 门禁弱化阻断检查',
    file: 'kit/skills/dev-flow/scripts/flow.mjs',
    from: '  const gateFindings = await detectGateWeakening(implRoot, ledger.baseSha, ledger.baseBranch)',
    to: '  const gateFindings = []',
    expect: '门禁弱化改动未被 merge 拦截',
  },
  {
    id: 'I28',
    what: '关闭 govern-audit.mjs checkMarkdownDeadLinks 的围栏代码块跳过判定',
    file: 'kit/skills/dev-govern/scripts/govern-audit.mjs',
    from: '      if (fenceChar) continue',
    to: '      if (false && fenceChar) continue',
    expect: '围栏代码块内相对链接被误判为死链接',
  },
  {
    id: 'I29',
    what: '关闭 backup.mjs treeSha256 同内容快照防重跳过逻辑',
    file: 'scripts/backup.mjs',
    from: '  if (!force && latest && latest.treeSha256 && treeSha256 && latest.treeSha256 === treeSha256) {',
    to: '  if (false && !force && latest && latest.treeSha256 && treeSha256 && latest.treeSha256 === treeSha256) {',
    expect: '相同工作区二次快照未触发 unchanged-since-latest 去重',
  },
  {
    id: 'I30',
    what: '关闭 claims.mjs verifyClaims 对 package.json 脚本的核对（claim.script）',
    file: 'scripts/lib/claims.mjs',
    from: '  if (scripts.length > 0 && Array.isArray(facts?.ecosystem?.packageScripts)) {',
    to: '  if (false && scripts.length > 0 && Array.isArray(facts?.ecosystem?.packageScripts)) {',
    expect: 'review.mjs 未拦截失效 package.json 脚本',
  },
  {
    id: 'I31',
    what: '置空 survey.mjs detectReentry 对 docs/TDD.md 失效源码路径的检测',
    file: 'scripts/survey.mjs',
    from: '  const staleTddPaths = detectTddStalePaths(root, docs?.tdd)',
    to: '  const staleTddPaths = []',
    expect: 'reentry.staleTddPaths 未检出失效 TDD 路径',
  },
  {
    id: 'I32',
    what: '关闭 compose-agents.mjs buildConditions 的 has-custom-skills 自有技能路由条件',
    file: 'scripts/compose-agents.mjs',
    from: "    'has-custom-skills': hasCustomSkills,",
    to: "    'has-custom-skills': false,",
    expect: 'AGENTS.md 未包含项目自有扩展技能路由块',
  },
  {
    id: 'I33',
    what: '破坏 survey.mjs computeArtifactPlan 对已有 README 的 preserve 保护判据',
    file: 'scripts/survey.mjs',
    from: "    ? { id: 'readme', artifact: 'README.md', status: `已存在（${(docs.readmes ?? [docs.readme]).join('、')}）`, action: 'preserve', detail: '保留原有排版、文风与结构，严禁套模板重写，仅在命令或入口失真时做最小校准' }",
    to: "    ? { id: 'readme', artifact: 'README.md', status: '缺失', action: 'create', detail: '覆盖重写' }",
    expect: 'computeArtifactPlan 未将已有 README 标为 preserve',
  },
  {
    id: 'I34',
    what: '关闭 preflight.mjs isProductLayerPath 对 assets/readme/*.svg 的白名单放行',
    file: 'scripts/dev/preflight.mjs',
    from: '  if (/^assets\\/readme\\/[a-z0-9_-]+\\.svg$/i.test(p)) return true',
    to: '  if (/^assets\\/readme\\/[a-z0-9_-]+\\.svg$/i.test(p)) return false',
    expect: 'isProductLayerPath 拒绝了 assets/readme',
  },
  {
    id: 'I35',
    what: '关闭 release-prep-lib.mjs 对含糊修改公开入口（unaccountedPublicFiles）的拦截提示',
    file: 'kit/skills/dev-govern/scripts/release-prep-lib.mjs',
    from: '    if (!hasClearUserCommit && !mentionedInSpecOrTodo && !hasMinRuntimeDiff) {',
    to: '    if (false && !hasClearUserCommit && !mentionedInSpecOrTodo && !hasMinRuntimeDiff) {',
    expect: 'unaccountedPublicFiles 未检出含糊公开入口',
  },
  {
    id: 'I36',
    what: '关闭 release-prep-lib.mjs 对纯测试/配置噪音提交的过滤',
    file: 'kit/skills/dev-govern/scripts/release-prep-lib.mjs',
    from: "  if (allInternalFiles) {\n    return { filtered: true, reason: 'tests-ci-or-worktree-only' }\n  }",
    to: "  if (false && allInternalFiles) {\n    return { filtered: true, reason: 'tests-ci-or-worktree-only' }\n  }",
    expect: 'release-prep 未过滤纯测试或配置噪音提交',
  },
]

function runFixtures(expect = '') {
  const args = [join(HERE, 'fixtures.mjs')]
  if (expect) args.push('--prefer', expect, '--bail-on', expect)
  const res = spawnSync(process.execPath, args, {
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

/**
 * 这一处注入该由哪套门禁核对。
 *
 * **答案是「两套都跑」。** 按路径前缀分派会让一部分注入永远不会红——不是因为判据不灵，
 * 是因为跑错了那一套，而「没红」会被当成一条结论。判据只有一条：**拆掉一处之后，只要有
 * 任何一道门禁报出来，就算有人看着它**。猜哪一套会看，是这套复验里最容易出错的一步。
 */
function runBoth(expect) {
  const pre = runPreflight()
  if (expect && pre.failed.some((line) => line.includes(expect))) return pre
  return { failed: [...pre.failed, ...runFixtures(expect).failed] }
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

  // 有些形状只有在**多处同时改**时才成立（集体遗忘）。它们额外带一份清单，
  // 把同一处改动也施加到别的文件上——只改一处的注入，抓不到「三处一起错」这一类。
  const extras = []
  if (Array.isArray(inj.alsoDropIn)) {
    for (const other of inj.alsoDropIn) {
      const otherPath = join(ROOT, other)
      const otherText = readFileSync(otherPath, 'utf8')
      if (!otherText.includes(inj.from)) {
        process.stdout.write(`${inj.id} 跳过：${other} 里找不到要替换的那一段\n`)
        bad += 1
        continue
      }
      extras.push([otherPath, otherText])
      writeFileSync(otherPath, otherText.replace(inj.from, inj.to), 'utf8')
    }
  }

  try {
    // **两套门禁都跑。** 判据只有一条：拆掉一处之后，只要有任何一道门禁报出来，就算有人
    // 看着它。按路径前缀猜「该由谁看」，猜错的那次注入就不会红，而「没红」会被读成
    // 「判据不灵」——那是把一次跑错当成了一条结论。
    const result = runBoth(inj.expect)
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
    for (const [path, text] of extras) writeFileSync(path, text, 'utf8')
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
