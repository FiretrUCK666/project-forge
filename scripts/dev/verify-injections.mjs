#!/usr/bin/env node
/**
 * 故障注入复验：逐个把关键判据拆掉，确认对应的断言真的变红。
 *
 * 这不是测试的一部分，是**证明测试不是空的**。测试全绿有两种可能——代码对了，或者
 * 测试什么都没测；只有亲眼看到它红过，才排除后一种。
 *
 * 用法：node scripts/dev/verify-injections.mjs [--only I12] [--jobs 6]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { isMainModule } from '../lib/text.mjs'

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
    file: 'scripts/lib/survey-gap-rules.mjs',
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
    file: 'scripts/dev/preflight-contracts.mjs',
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
    file: 'scripts/dev/preflight-contracts.mjs',
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
    file: 'scripts/dev/preflight-contracts.mjs',
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
    file: 'scripts/lib/survey-gap-rules.mjs',
    from: "    text: '还没有版本库',\n    review: 'git.absent',",
    to: "    text: '还没有版本库',",
    expect: '缺口覆盖',
  },
  {
    id: 'I12',
    what: '某条缺口的处置指向一个体检里不存在的结论 id',
    file: 'scripts/lib/survey-gap-rules.mjs',
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
    file: 'scripts/dev/preflight-contracts.mjs',
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
    file: 'scripts/lib/survey-gap-rules.mjs',
    from: 'export const GAP_RULES = [',
    to: 'export const GAP_RULES_RENAMED = [',
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
    file: 'kit/skills/lib/platform.mjs',
    from: `    if (hasHistory && authors.length > 0) {\n      return {\n        role: 'clone-readonly',\n        providerId: 'github',\n        reason: \`origin 与 \${origin} 一致，但历史提交非本机作者且无写权限证明（按只读克隆处置）\`,\n      }\n    }`,
    to: `    if (hasHistory && authors.length > 0) {\n      return {\n        role: 'maintainer',\n        providerId: 'github',\n        reason: \`origin 与 \${origin} 一致\`,\n      }\n    }`,
    expect: '他人公开仓被误判成',
  },
  {
    id: 'I22',
    what: '跳过 worktree-deps unmountSharedDeps 的 unlinkSync 解绑',
    file: 'kit/skills/dev-flow/scripts/worktree-deps.mjs',
    from: `      unlinkSync(dst)\n      if (lstatSafe(dst) !== null) throw new Error(\`解绑依赖链接失败，路径仍然存在：\${dst}\`)`,
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
    from: '    if (!/^passed\\b/i.test(critiqueVal)) {',
    to: '    if (false && !/^passed\\b/i.test(critiqueVal)) {',
    expect: '未 critique-pass 的 SPEC 竟被 approve 放行',
  },
  {
    id: 'I27',
    what: '跳过 flow.mjs merge 的 detectGateWeakening 门禁弱化阻断检查',
    file: 'kit/skills/dev-flow/scripts/flow-merge.mjs',
    from: '    detectGateWeakening(implRoot, ledger.baseSha, ledger.baseBranch),',
    to: '    Promise.resolve([]),',
    expect: '门禁弱化改动未被 merge 拦截',
  },
  {
    id: 'I28',
    what: '关闭 govern-audit.mjs checkMarkdownDeadLinks 的围栏代码块跳过判定',
    file: 'kit/skills/dev-govern/scripts/govern-docs.mjs',
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
  {
    id: 'I37',
    what: '破坏单源 platform.mjs 写权限协作者判为 team-collaborator 的逻辑',
    file: 'kit/skills/lib/platform.mjs',
    from: '  if (apiWrite) {\n    const isTeamCollaborator = Boolean(credLogin && credLogin.toLowerCase() !== originOwnerLow)',
    to: '  if (apiWrite) {\n    const isTeamCollaborator = false',
    expect: 'github.mjs 未将写权限团队协作者判为 team-collaborator',
  },
  {
    id: 'I38',
    what: '移除单源 platform.mjs 离线同源 clone-readonly 分支的 teamProbeHint 提示',
    file: 'kit/skills/lib/platform.mjs',
    from: '  if (apiProbed) return res\n  return { ...res, teamProbeHint: TEAM_PROBE_HINT }',
    to: '  if (apiProbed) return res\n  return res',
    expect: '未保留 clone-readonly + teamProbeHint',
  },
  {
    id: 'I39',
    what: '禁用 preflight.mjs validateDocTocAnchors 对失效目录锚点的拦截',
    file: 'scripts/dev/preflight-contracts.mjs',
    from: 'if (!validIds.has(rawAnchor) && !validIds.has(decoded)) {\n      errors.push(`目录项「${label}」的锚点 #${rawAnchor} 找不到对应真实标题`)',
    to: 'if (false && !validIds.has(rawAnchor) && !validIds.has(decoded)) {\n      errors.push(`目录项「${label}」的锚点 #${rawAnchor} 找不到对应真实标题`)',
    expect: 'validateDocTocAnchors 未拦截失效目录锚点',
  },
  {
    id: 'I40',
    what: '向 assets/readme/hero.svg 注入低于 16 的微小字号',
    file: 'assets/readme/hero.svg',
    from: '<text x="64" y="68" class="mono" font-size="16" font-weight="600" letter-spacing="2" fill="#526075">GIT WORKFLOW HARNESS · GITHUB</text>',
    to: '<text x="64" y="68" class="mono" font-size="11" font-weight="600" letter-spacing="2" fill="#526075">GIT WORKFLOW HARNESS · GITHUB</text>',
    expect: '禁止微小字号',
  },
  {
    id: 'I41',
    what: '架空 docs.mjs evaluateCoupledSync 的改哪看哪联动同步检查',
    file: 'kit/skills/lib/docs.mjs',
    from: '  if (normalizedChanged.length === 0 || !Array.isArray(rules) || rules.length === 0) return []',
    to: '  if (true || normalizedChanged.length === 0 || !Array.isArray(rules) || rules.length === 0) return []',
    expect: 'evaluateCoupledSync 单边修改未命中 docs/api.md',
  },
  {
    id: 'I42',
    what: '剥除 templates/docs-spec.md 头部 YAML Frontmatter 分隔符',
    file: 'templates/docs-spec.md',
    from: '---\nkind: spec',
    to: 'kind: spec',
    expect: '缺少 YAML Frontmatter',
  },
  {
    id: 'I43',
    what: '禁用 govern-tests.mjs 对单测硬编码长 sleep 的检查',
    file: 'kit/skills/dev-govern/scripts/govern-tests.mjs',
    from: 'if (HARD_SLEEP_RULES.some((re) => re.test(codeLines[i]))) {',
    to: 'if (false && HARD_SLEEP_RULES.some((re) => re.test(codeLines[i]))) {',
    // 断言报的是带文件名的 finding id（`tests.hard-sleep.test/sleep.test.mjs`），
    // 拿光秃秃的 `tests.hard-sleep` 去匹配，`--only` 一条都命不中。
    expect: 'tests.hard-sleep',
  },
  {
    id: 'I44',
    what: '禁用 update.mjs applyPackage 写入异常时的旧文件原地回滚（验证回滚保留旧版本与文件）',
    file: 'scripts/update.mjs',
    from: '    } catch (err) {\n      rollbackAppliedWrites(appliedDests, backups, pruneTargetDir)',
    to: '    } catch (err) {\n      // skipped rollback',
    expect: '回滚未还原已写入的 references/survey.md',
  },
  {
    id: 'I45',
    what: '跳过 equip.mjs 对 v2 删除墓碑 disabledSkills/removedFiles 的写入跳过判定',
    file: 'scripts/equip.mjs',
    from: '    } else {\n      if (disabledSet.has(top) || removedMap[rel]) continue\n      pendingWrites.push({ dest, buf: src.buf })',
    to: '    } else {\n      if (false && (disabledSet.has(top) || removedMap[rel])) continue\n      pendingWrites.push({ dest, buf: src.buf })',
    expect: '违反墓碑原则',
  },
  {
    id: 'I46',
    what: '架空 flow-merge.mjs 对 reviewPassedHead === currentHead 的陈旧审查拦截',
    file: 'kit/skills/dev-flow/scripts/flow-merge.mjs',
    from: '      const reviewHeadOk = ledger.reviewPassed === true\n        && (!currentHead || ledger.reviewPassedHead === currentHead)\n        && (!ledger.lastReview || !currentHead || ledger.lastReview.headSha === currentHead)\n        && (!lastRound || !currentHead || lastRound.headSha === currentHead)',
    to: '      const reviewHeadOk = ledger.reviewPassed === true',
    expect: 'reviewPassedHead 校验失效',
  },
  {
    id: 'I47',
    what: '禁用 doc-templates.mjs checkMermaidLabelWidth 的节点/边宽度超限校验',
    file: 'kit/skills/lib/doc-templates.mjs',
    from: '      if (w > maxWidth) {',
    to: '      if (false && w > maxWidth) {',
    expect: 'Mermaid 超宽/HTML 门禁未拦截',
  },
  {
    id: 'I48',
    what: '禁用 flow-merge.mjs claim 对已被他人认领 Issue 的互斥阻断检查',
    file: 'kit/skills/dev-flow/scripts/flow-merge.mjs',
    from: '        if (!isTakeover) {',
    to: '        if (false && !isTakeover) {',
    expect: '他人重复 claim 未阻断',
  },
  {
    id: 'I49',
    what: '移除 .github/workflows/check.yml 汇总 job check 的 if: always() 防止假绿',
    file: '.github/workflows/check.yml',
    from: '  check:\n    needs: gates\n    if: always()',
    to: '  check:\n    needs: gates',
    expect: '汇总 job `check` 缺少 `if: always()`',
  },
  {
    id: 'I50',
    what: '禁用 flow-merge.mjs 对远端 CI fail 状态的合并阻断',
    file: 'kit/skills/dev-flow/scripts/flow-merge.mjs',
    from: "        if (checks.bucket === 'fail' && !opts['human-approved']) {",
    to: "        if (false && checks.bucket === 'fail' && !opts['human-approved']) {",
    expect: '远端 CI 失败未阻断合并：',
  },
  {
    // 两张语言清单各写各的：「能生成骨架」里加了一种语言，「能识别」里忘了登记，
    // 不会有任何东西报错——用户拿到的 README 一边说支持、一边静默走兜底分支。
    id: 'I51',
    what: '往起步骨架语言清单里加一种勘察根本认不出来的语言',
    file: 'scripts/lib/starter-templates.mjs',
    from: "export const BOOTSTRAP_LANGS = new Set(['node', 'python', 'go', 'rust', 'java', 'docs'])",
    to: "export const BOOTSTRAP_LANGS = new Set(['node', 'python', 'go', 'rust', 'java', 'docs', 'cobol'])",
    expect: '生态清单里没有对应识别项',
  },
  {
    id: 'I52',
    what: '破坏 platform-probe.mjs 惰性原则（默认不联网也强行调外部探针）',
    file: 'kit/skills/lib/platform-probe.mjs',
    from: '  const shouldProbeExternal = offline !== true && !disableRealProbe && (probeNetwork === true || hasCustomRunner)',
    to: '  const shouldProbeExternal = true',
    expect: '惰性鉴权破坏：',
  },
  {
    id: 'I53',
    what: '跳过 zip.mjs readZip 的 CRC32 完整性校验',
    file: 'scripts/zip.mjs',
    from: '    if (actualCrc !== expectedCrc) {',
    to: '    if (false && actualCrc !== expectedCrc) {',
    expect: '损坏 CRC32 的 .zip 未被拦截',
  },
  {
    id: 'I54',
    what: '允许 update.mjs --check 违规写入本地节流状态',
    file: 'scripts/update.mjs',
    from: '    if (!checkOnly) rememberState({ lastOkAt: Date.now(), lastFailAt: 0 }, statePath)',
    to: '    rememberState({ lastOkAt: Date.now(), lastFailAt: 0 }, statePath)',
    expect: 'update.mjs --check 篡改了节流状态',
  },
]


/**
 * 复验必须在**独立副本**里做，而且每条注入各用一份。
 *
 * 两件事一起治：
 *
 * 1. **就地改再还原**取决于「这个进程能一直跑到底」。中途被 Ctrl-C、被超时杀掉、机器休眠，
 *    仓库就停在「判据被拆掉」的状态里——那时 `git status` 上只是一行 M，看着像正常改动，
 *    下一次门禁报的是假故障，改的人会去查一个不存在的问题。
 * 2. **串行注入跑不完**。五十多条注入串行跑，每条都要付一次门禁的代价，加起来是按小时计的。
 *    有条数就是有上限，而得不出一条结论的等待等于没跑。
 *
 * 所以：先把工作树复制一份当母版，每条注入从母版再复制一份自己的副本，各自并行。
 * 谁也不碰真正的工作区，谁也碰不到别人。
 */
const SANDBOX = mkdtempSync(join(tmpdir(), 'pf-inj-'))
const STAGING = join(SANDBOX, 'base')

/** 复制时跳过的相对目录：`.git` 复验用不上，`node_modules` 与 `.worktrees` 是本地状态（基于相对路径校验以兼容在 worktree 内直接运行）。 */
const COPY_SKIP = /(?:^|[\\/])(?:\.git|node_modules|\.worktrees)(?:[\\/]|$)/

function cloneTree(from, to) {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => src === from || !COPY_SKIP.test(relative(from, src)),
  })
  return to
}

function removeTree(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  } catch { /* 留给系统清理 */ }
}

/** 用 spawn + Promise 而不是 spawnSync：同步阻塞会让「并行」只并行了个说法。 */
function runNodeAsync(scriptPath, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.stderr.on('data', (chunk) => { err += chunk })
    child.on('close', () => resolve({ out, err }))
    child.on('error', (error) => resolve({ out, err: `${err}\n${error.message}` }))
  })
}

async function runFixturesIn(root, expect = '') {
  const args = []
  if (expect) args.push('--only', expect)
  const { out, err } = await runNodeAsync(join(root, 'scripts', 'dev', 'fixtures.mjs'), args, root)
  const all = `${out}\n${err}`
  return {
    failed: all.split('\n').filter((l) => l.startsWith('FAIL')),
    summary: all.split('\n').filter((l) => /行为断言/.test(l)).join(' '),
  }
}

async function runPreflightIn(root) {
  const { out, err } = await runNodeAsync(join(root, 'scripts', 'dev', 'preflight.mjs'), [], root)
  return { failed: `${out}\n${err}`.split('\n').filter((l) => l.startsWith('FAIL')) }
}

/**
 * 两套门禁都问，但按代价排序。
 *
 * 判据只有一条：拆掉一处之后，只要有任何一道门禁报出来，就算有人看着它。按路径前缀猜
 * 「该由谁看」，猜错的那次注入就不会红，而「没红」会被读成「判据不灵」——那是把一次
 * 跑错当成了一条结论。定向跑命中时是亚秒级，没命中时 `--only` 直接以非零退出，
 * 也不会被读成「全过」；只有它没能证伪这条注入时，才付整套 preflight 的代价。
 */
async function runBothIn(root, expect) {
  if (!expect) {
    return { failed: [...(await runPreflightIn(root)).failed, ...(await runFixturesIn(root)).failed] }
  }
  const fix = await runFixturesIn(root, expect)
  if (fix.failed.some((line) => line.includes(expect))) return fix
  const pre = await runPreflightIn(root)
  if (pre.failed.some((line) => line.includes(expect))) return pre
  return { failed: [...pre.failed, ...fix.failed] }
}

/** 把一条注入施加到它自己的副本上，跑门禁，返回结论。副本用完即删。 */
async function runInjection(inj) {
  const root = cloneTree(STAGING, join(SANDBOX, `run-${inj.id}`))
  try {
    const targets = [[inj.file, inj.from, inj.to]]
    for (const other of inj.alsoDropIn ?? []) targets.push([other, inj.from, inj.to])

    for (const [rel, from, to] of targets) {
      const full = join(root, rel)
      const original = readFileSync(full, 'utf8')
      if (!original.includes(from)) {
        return { id: inj.id, what: inj.what, skipped: `${rel} 里找不到要替换的那一段` }
      }
      writeFileSync(full, original.replace(from, to), 'utf8')
    }

    const result = await runBothIn(root, inj.expect)
    const sample = result.failed.find((line) => line.includes(inj.expect))
    return { id: inj.id, what: inj.what, hit: Boolean(sample), sample }
  } finally {
    removeTree(root)
  }
}

/** 有限并发：每条注入要起几个 node 子进程，并发太高会把机器拖成彼此等 I/O。 */
async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index])
    }
  })
  await Promise.all(lanes)
  return results
}

if (isMainModule(import.meta.url, process.argv[1])) {
  cloneTree(ROOT, STAGING)
  process.on('exit', () => removeTree(SANDBOX))

  const onlyIndex = process.argv.indexOf('--only')
  const argvOnly = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined
  const jobsIndex = process.argv.indexOf('--jobs')
  const jobs = jobsIndex >= 0 ? Number(process.argv[jobsIndex + 1]) || 6 : 6

  const selected = argvOnly ? INJECTIONS.filter((i) => i.id === argvOnly) : INJECTIONS
  if (argvOnly && selected.length === 0) {
    process.stderr.write(`没有注入匹配 --only ${argvOnly}：编号写错时会一条都不跑，而「没跑」看着和「全过」一样。\n`)
    process.exit(1)
  }

  const results = await runWithConcurrency(selected, jobs, runInjection)

  let bad = 0
  for (const result of results) {
    if (result.skipped) {
      process.stdout.write(`${result.id} 跳过：${result.skipped}\n`)
      bad += 1
    } else if (result.hit) {
      process.stdout.write(`${result.id} 红了（正确）：${result.what}\n    ${result.sample.slice(0, 110)}\n`)
    } else {
      process.stdout.write(`${result.id} **没红**（判据被拆掉却没人报）：${result.what}\n`)
      bad += 1
    }
  }

  process.stdout.write(bad === 0
    ? `\n故障注入复验：${selected.length} 条判据都能被抓到。\n`
    : `\n故障注入复验未通过：${bad} 处有问题。\n`)
  process.exit(bad === 0 ? 0 : 1)
}
