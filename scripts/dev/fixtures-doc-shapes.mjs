import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitCommitFast, gitInit, gitSync, issueTokenFor, loadPreflight,
  readDirRefs, rmTree, runAbsAsync, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'


/** 模板与项目形态：裁剪、可选节、序号、履历体。 */
export function registerDocShapeCases(cases) {
cases.push(['冷启动全景把进度摆出来，且不猜', async () => {
  const { buildSessionOrientation } = await import('../../kit/skills/lib/session-orient.mjs')

  const dir = tmpProject({ 'README.md': '# o\n\n冷启动测试仓。\n' })
  try {
    mkdirSync(join(dir, 'docs', 'prd'), { recursive: true })
    mkdirSync(join(dir, 'docs', 'specs'), { recursive: true })
    mkdirSync(join(dir, 'docs', 'todo'), { recursive: true })

    // 空仓：不许编进度，要明说没有
    const empty = buildSessionOrientation(dir)
    if (empty.docs.prd.length !== 0 || empty.docs.specs.length !== 0) return '空仓却报出了文档'
    if (!/没有卡住的文档/.test(empty.text)) return '空仓时没说「没有卡住的文档」'
    if (empty.nextSteps.length === 0) return '空仓时没给下一步'

    // 有文档：要在全景里出现，且未批准要被判成「卡住」
    writeFileSync(join(dir, 'docs', 'prd', '261117-x-prd.md'), [
      '---', 'kind: prd', 'title: X', 'status: draft', 'issue: 7', '---', '',
      '# PRD: X', '', '## 要解决的问题', '- a', '', '## 本期不做', '- b', '',
      '## 门型与回滚路径', '- two-way', '', '- [ ] C1: c1', '- [ ] C2: c2', '',
    ].join('\n'))
    const filled = buildSessionOrientation(dir)
    if (filled.docs.prd.length !== 1) return `PRD 没被扫到：${filled.docs.prd.length}`
    if (!filled.docs.prd[0].issue) return '全景里没带 Issue 编号'
    if (!filled.stuck.some((s) => s.why.includes('未批准'))) return '未批准的 PRD 没被列进「卡在哪」'
    if (!/0\/2 条已勾|0\/2/.test(filled.text)) return '全景里没报勾选进度'
    if (!/未批准/.test(filled.text)) return '全景里没报阻塞原因'

    // 反向：已批准的 PRD 不该被列成卡住
    writeFileSync(join(dir, 'docs', 'prd', '261117-x-prd.md'), [
      '---', 'kind: prd', 'title: X', 'status: active', 'issue: 7', '---', '',
      '# PRD: X', '', '## 要解决的问题', '- a', '', '## 本期不做', '- b', '',
      '## 门型与回滚路径', '- two-way', '', '- [x] C1: c1', '',
    ].join('\n'))
    const approved = buildSessionOrientation(dir)
    if (approved.stuck.some((s) => s.file.includes('x-prd'))) return '已批准的 PRD 被误判成卡住'

    // 反向：勾选没做完却标 implemented，要报出来
    writeFileSync(join(dir, 'docs', 'specs', '261117-y-spec.md'), [
      '---', 'kind: spec', 'title: Y', 'status: implemented', '---', '',
      '# SPEC: Y', '', '## 要解决的问题', '- a', '', '## 本期不做', '- b', '',
      '## 门型与回滚路径', '- two-way', '', '- [x] C1: done', '- [ ] C2: not done', '',
    ].join('\n'))
    const inconsistent = buildSessionOrientation(dir)
    if (!inconsistent.stuck.some((s) => s.why.includes('勾选未完成'))) {
      return '标了 implemented 但勾选没做完，没被报出来'
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['模板文件就是产物来源，可选章节按项目声明增删', async () => {
  const { renderDocTemplate, readDocTemplate, templateSections } = await import('../../kit/skills/lib/doc-template-render.mjs')
  const { resolveDocRequirements } = await import('../../kit/skills/lib/doc-requirements.mjs')

  // 正向：三份模板都能读出来，且都声明了主干节
  for (const kind of ['prd', 'spec', 'todo']) {
    const raw = readDocTemplate(kind)
    if (!raw) return `读不到 ${kind} 模板`
    const ids = templateSections(raw).map((s) => s.id)
    for (const must of ['goal', 'acceptance']) {
      if (!ids.includes(must)) return `${kind} 模板缺少主干章节 ${must}`
    }
  }

  // 正向：渲染会真的把占位填掉，且不残留章节标记
  const rendered = renderDocTemplate('prd', {
    vars: {
      TITLE: '标题甲', TODAY: '2026-01-01', ISSUE: 'null', ISSUE_LABEL: '未关联',
      OWNER: '甲', OWNER_LABEL: '甲', NON_GOALS: '- 不做乙', REUSABLE: '- 复用丙',
      CRITERIA: '- [ ] C1: 命令退出码为 0', DOOR: 'two-way', ROLLBACK: '反向提交',
      QUICK_CMD: 'node --test',
    },
  })
  if (!rendered.includes('标题甲') || !rendered.includes('不做乙')) return '占位没有被填进产物'
  if (/\{\{[A-Z0-9_]+\}\}/.test(rendered)) return `产物里残留未填占位：${/\{\{[A-Z0-9_]+\}\}/.exec(rendered)[0]}`
  if (/<!--\s*\/?section:/.test(rendered)) return '产物里残留章节标记'

  // 反向：没给值时写「待补齐」，不许留空
  const sparse = renderDocTemplate('prd', { vars: { TITLE: '标题乙', TODAY: '2026-01-01' } })
  if (!sparse.includes('待补齐')) return '缺值时没有写「待补齐」，而是留了空'

  // 正向：项目声明 omit 的章节会被裁掉
  //
  // 挑「待拍板问题」来验：它模板里自带真实内容（`- 待确认：无`），
  // 不填也能留下来——于是「删掉它」这个动作才真的改变了产物。
  // 换成「复用既有模块」就测不出东西：那节本来就会因为没填而被剪掉。
  const dir = tmpProject({
    'README.md': '# o\n\n模板裁剪测试仓。\n',
    'docs/templates/prd.md': ['---', 'kind: prd', 'omit_sections: [pending, metrics]', '---', '', '# 项目自己的 PRD 模板', ''].join('\n'),
  })
  try {
    const req = resolveDocRequirements(dir, 'prd')
    if (!req.omit.has('pending')) return 'omit 声明没被读出来'
    const pruned = renderDocTemplate('prd', { vars: { TITLE: '丙', TODAY: '2026-01-01' }, dropSections: req.omit })
    if (pruned.includes('待拍板问题')) return '声明要删的章节还在'
    if (!pruned.includes('要解决的问题')) return '主干章节被误删了'

    // 反向：主干三节写进 omit 也不许删
    const guarded = tmpProject({
      'README.md': '# o\n\n主干保护测试仓。\n',
      'docs/templates/prd.md': ['---', 'kind: prd', 'omit_sections: [goal, acceptance]', '---', '', '# 模板', ''].join('\n'),
    })
    try {
      const req2 = resolveDocRequirements(guarded, 'prd')
      if (req2.omit.has('goal') || req2.omit.has('acceptance')) return '主干章节被允许列进 omit——那等于允许不写要做什么'
    } finally { rmTree(guarded) }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['文档模板按项目形态裁剪，且填不上的可选节不留占位', async () => {
  const { renderDocTemplate, templateSections, DOC_TEMPLATE_VARS } = await import('../../kit/skills/lib/doc-template-render.mjs')

  // 正向 1：三份模板都有主干三节。注意渲染后标记已被清除，
  // 所以要查**模板原文**而不是产物——产物里章节只剩标题。
  const fsMod = await import('node:fs')
  for (const kind of ['prd', 'spec', 'todo']) {
    const raw = fsMod.readFileSync(new URL(`../../kit/skills/templates/docs-${kind}.md`, import.meta.url), 'utf8')
    const ids = templateSections(raw).map((s) => s.id)
    for (const must of ['goal', 'acceptance']) {
      if (!ids.includes(must)) return `${kind} 模板没有主干章 ${must}`
    }
  }

  // 正向 2：真实项目形态能落地——PRD 的十节里，身份/流程/规则/非功能都是可选
  const prdSections = templateSections(await import('node:fs').then((fs) => fs.readFileSync(
    new URL('../../kit/skills/templates/docs-prd.md', import.meta.url), 'utf8')))
  const optionalIds = prdSections.filter((s) => s.optional).map((s) => s.id)
  for (const must of ['users', 'flow', 'rules', 'nfr']) {
    if (!optionalIds.includes(must)) return `PRD 模板的 ${must} 节不是可选的——纯工具类项目会被迫填「不适用」`
  }

  // 正向 3：不填 optional 时，那一节必须整节消失（否则会带着尖括号占位过不了审计）。
  // 主干**故意留着**占位让人看见该写什么，所以这里只查可选节对应的标题还在不在。
  const sparse = renderDocTemplate('prd', { vars: { TITLE: 'T', TODAY: '2026-01-01' } })
  for (const [id, title] of [['users', '用户身份与权限'], ['rules', '状态与业务规则'], ['nfr', '非功能要求'], ['reuse', '复用既有模块']]) {
    if (sparse.includes(title)) return `未填的可选节「${title}」没有被剪掉——它会带着尖括号占位过不了审计`
  }

  // 正向 4：**给了值就要保留**——否则等于把可选节全删了，模板再全也没用
  const rich = renderDocTemplate('prd', {
    vars: {
      TITLE: 'T', TODAY: '2026-01-01', NON_GOALS: '- 不做 X', REUSABLE: '- 复用 profile.mjs',
      CRITERIA: '- [ ] C1: x', DOOR: 'two-way', ROLLBACK: '反向提交',
    },
  })
  if (!rich.includes('复用既有模块')) return '给了复用模块却把这一节剪掉了'
  if (!rich.includes('门型与回滚')) return '给了门型却把这一节剪掉了'

  // 反向 1：主干填不上要留占位让人看见，不许静默删掉
  if (!/<[\u4e00-\u9fa5][^<>\n]{1,120}>/.test(sparse)) return '主干填不上时也没留占位——人不会知道这里要写东西'
  if (!sparse.includes('要解决的问题')) return '主干「要解决的问题」被误删了'

  // 反向 2：项目声明不要的章节要被裁掉
  const dropped = renderDocTemplate('prd', {
    vars: { TITLE: 'T', TODAY: '2026-01-01', NON_GOALS: '- 不做', REUSABLE: '- 复用', CRITERIA: '- [ ] C1: x', DOOR: 'two-way', ROLLBACK: 'r' },
    dropSections: new Set(['users', 'rules']),
  })
  if (dropped.includes('用户身份与权限')) return '声明要删的章节还在'
  if (!dropped.includes('要解决的问题')) return '主干被误删'

  // 占位登记表不能漂：模板里出现的每个占位都得能取值
  for (const kind of ['prd', 'spec', 'todo']) {
    const raw = await import('node:fs').then((fs) => fs.readFileSync(
      new URL(`../../kit/skills/templates/docs-${kind}.md`, import.meta.url), 'utf8'))
    const names = [...new Set([...raw.matchAll(/\{\{([A-Z0-9_]+)\}\}/g)].map((m) => m[1]))]
    const unreg = names.filter((n) => !DOC_TEMPLATE_VARS[kind].includes(n))
    if (unreg.length > 0) return `${kind} 模板有未登记占位：${unreg.join(',')}`
  }
  return true
}])

cases.push(['验收标准批准即冻结，改过要能被逐条指出来', async () => {
  const { extractCriteria, criteriaFingerprint, compareCriteria, describeCriteriaDrift } =
    await import('../../kit/skills/lib/criteria-lock.mjs')

  // 正向：抽出编号与正文
  const base = extractCriteria([
    '## 验收标准', '',
    '- [ ] C1: 退出码为 0',
    '- [ ] C2: 异常输入必须拒绝',
    '- [x] C3: 输出含预期字段',
    '', '```sh', '- [ ] C9: 代码块里的不算', '```', '',
  ].join('\n'))
  if (base.length !== 3) return `应抽出 3 条，实际 ${base.length}：${base.map((c) => c.id).join(',')}`
  if (!base.find((c) => c.id === 'C3')?.checked) return '勾选状态没读对'

  // 反向：勾选变化**不算**标准变化——那是实现进度，算进去会让门禁变成噪音
  const checked = extractCriteria('- [x] C1: 退出码为 0\n- [x] C2: 异常输入必须拒绝\n- [x] C3: 输出含预期字段')
  if (criteriaFingerprint(base) !== criteriaFingerprint(checked)) {
    return '只是打了勾就判成标准变了——这种噪音会让人直接把门禁关掉'
  }

  // 正向：正文改松要被抓到，并点名到 C 编号
  const relaxed = extractCriteria('- [ ] C1: 退出码为 0\n- [ ] C2: 异常输入允许通过\n- [ ] C3: 输出含预期字段')
  const drift = compareCriteria(base, relaxed)
  if (drift.same) return '把「必须拒绝」改成「允许通过」竟然没被发现'
  if (drift.changed.join(',') !== 'C2') return `改动的条目报错了：${drift.changed.join(',')}`
  if (!describeCriteriaDrift(drift).includes('C2')) return '说明里没点到 C2'

  // 正向：删掉一条、新增一条都要看得见
  const removed = compareCriteria(base, extractCriteria('- [ ] C1: 退出码为 0\n- [ ] C3: 输出含预期字段'))
  if (removed.removed.join(',') !== 'C2') return `删条目没报对：${removed.removed.join(',')}`
  const added = compareCriteria(base, extractCriteria('- [ ] C1: 退出码为 0\n- [ ] C2: 异常输入必须拒绝\n- [ ] C3: 输出含预期字段\n- [ ] C4: 新要求'))
  if (added.added.join(',') !== 'C4') return `新增条目没报对：${added.added.join(',')}`

  // 反向：顺序调换不算变化（排序后再比）
  const reordered = extractCriteria('- [ ] C3: 输出含预期字段\n- [ ] C1: 退出码为 0\n- [ ] C2: 异常输入必须拒绝')
  if (!compareCriteria(base, reordered).same) return '只是调了顺序就判成改标准了'

  return true
}])

// 认节要看内容，不能只看标题像不像模板。
//
// 同一个「不做什么」，有人写 `## 明确不做（Non-Goals）`，有人写 `## 不在本次范围`，
// 有人写 `## Out of scope`，还有人写在目标那节的最后一句里。全都写了，
// 按标题认会判成「没写」——那是最气人的一种误报：人明明写了，工具说没有。
cases.push(['认节看内容不看标题：换个写法也算写了', async () => {
  const { resolveDocRequirements, resolveSectionPresence, findMissingSections } =
    await import('../../kit/skills/lib/doc-requirements.mjs')

  const req = resolveDocRequirements(null, 'spec')
  if (req.sections.some((s) => s.id === 'door')) return '默认竟然还要求「门型与回滚」——没门的项目只能编一个'

  // 正向 1：中文标题但换了说法
  const zh = [
    '## 背景与动机', '',
    '现有流程每天凌晨跑批，上游变更后静默丢字段，需要改成强校验。', '',
    '## 不在本次范围', '', '- 不改调度器', '',
    '## 交付判据', '', '- [ ] C1: 退出码为 1', '',
  ].join('\n')
  const f1 = resolveSectionPresence(zh, req)
  const m1 = findMissingSections(req, f1, { hasInlineAcceptance: true })
  if (m1.length > 0) return `中文变体被判缺节：${m1.map((m) => m.id).join(',')}`

  // 正向 2：英文标题 + 隐式写法（非目标藏在目标那节里）
  const en = [
    '## Why', '',
    'The ETL job silently drops columns. We need to fail fast.', '',
    '## Approach', '',
    "Validate on read. We won't touch the scheduler this round.", '',
    '## Done when', '', '- [ ] C1: node x.mjs exits 1', '',
  ].join('\n')
  const f2 = resolveSectionPresence(en, req)
  const m2 = findMissingSections(req, f2, { hasInlineAcceptance: true })
  if (m2.length > 0) {
    return `英文/隐式写法被判缺节：${m2.map((m) => m.id + '/' + m.reason).join(',')}`
  }

  // 反向 1：真没写「不做什么」就要报出来——否则这条判据等于被删掉
  const noNonGoals = [
    '## 背景', '', '现有流程有问题，需要改。', '',
    '## 验收', '', '- [ ] C1: 退出码 0', '',
  ].join('\n')
  const f3 = resolveSectionPresence(noNonGoals, req)
  if (!findMissingSections(req, f3, { hasInlineAcceptance: true }).some((m) => m.id === 'non-goals')) {
    return '完全没写非目标，却也没报缺——那这条判据等于不存在'
  }

  // 反向 2：空壳章节不算写了（有标题没内容）
  const empty = '## 要解决的问题\n\n## 本期不做\n\n## 验收标准\n\n- [ ] C1: x\n'
  const f4 = resolveSectionPresence(empty, req)
  if (!findMissingSections(req, f4, { hasInlineAcceptance: true }).some((m) => m.id === 'goal')) {
    return '只有标题没内容的「要做什么」被判成写了'
  }

  return true
}])

// TDD 的主干判定同样要看内容：真实项目的标题千奇百怪。
//
// `## 2. 系统架构全景（双平面、四层正交）`、`## Architecture`、`## 部署架构` 里顺手写模块边界，
// 逐字比对标题会把一份写得比模板更细的文档判成缺节。
cases.push(['TDD 主干按内容认，空壳仍要报', async () => {
  const { checkTddStructure } = await import('../../kit/skills/lib/tdd-structure.mjs')

  // 正向 1：英文标题 + 异名标题，内容答全了
  const alt = [
    '# MyApp TDD', '',
    '## Version', '', '- 文档版本 0.1.0', '- 基线：当前源码与清单', '- 明确不做：不做多租户', '',
    '## Architecture', '',
    '| 模块 | 职责 | 依赖方向 |', '| --- | --- | --- |', '| core | 核心 | 仅基础层 |', '',
    '## Data flow', '', '主链路是 读入 -> 校验 -> 落盘。', '',
    '## Invariants', '', '- 单一真相源：配置只在 protocol.mjs', '',
  ].join('\n')
  const errs = checkTddStructure(alt)
  if (errs.length > 0) return `异名标题被判缺节：${errs.map((e) => e.code).join(',')}`

  // 正向 2：中文带编号的标题
  const numbered = [
    '# x TDD', '',
    '## 文档信息', '', '| 文档版本 | 1.0 |', '| --- | --- |', '',
    '## 1. 背景与非目标', '', '- 核心定位：给运维用', '- 非目标：不做多租户', '',
    '## 2. 系统架构全景（双平面）', '', '模块与目录职责见下表。', '| 模块 | 职责 |', '| --- | --- |', '| a | b |', '',
    '## 3. 主链路', '', '正常主链路：读入 -> 落盘。', '',
    '## 4. 不变量', '', '- 单一真相源', '',
  ].join('\n')
  const errs2 = checkTddStructure(numbered)
  if (errs2.length > 0) return `带编号中文标题被判缺节：${errs2.map((e) => e.code).join(',')}`

  // 反向 1：空壳必须报全——否则这条判据等于被删掉
  const bare = '# T\n\n## 随便写点\n\n一句话。\n'
  const errs3 = checkTddStructure(bare).map((e) => e.code)
  if (errs3.length < 5) return `空壳 TDD 只报了 ${errs3.length} 条：${errs3.join(',')}`

  // 反向 2：模块表只有表头要单独报
  const emptyTable = [
    '# x TDD', '',
    '## 文档信息', '', '- 文档版本 1.0', '- 基线：源码', '',
    '## 背景与非目标', '', '- 核心定位：给运维用', '- 非目标：不做多租户', '',
    '## 系统架构', '', '模块与目录职责：', '', '### 模块与目录职责', '', '| 模块 | 职责 | 依赖方向 | 入口文件 |', '| --- | --- | --- | --- |', '',
    '## 主链路', '', '正常主链路：读入 -> 落盘。', '',
    '## 不变量', '', '- 单一真相源', '',
  ].join('\n')
  if (!checkTddStructure(emptyTable).some((e) => e.code === 'EMPTY_TDD_MODULES')) {
    return '模块表只有表头却没报——那张表等于没写'
  }
  return true
}])

// 误报的代价是人开始忽略这条检查。
//
// 「讲不做什么」时会说「不动那条旧路径」，「讲实现说明」时会说「删掉了哪个文件」，
// 这些位置的路径本来就不该存在。在那里报幻觉路径，人第一次会改，第三次就不看了。
cases.push(['讲不做与讲删除的地方，不存在的路径不是幻觉', async () => {
  const { auditDoc } = await import('../../kit/skills/dev-plan/scripts/doc-audit.mjs')
  const fs = await import('node:fs')

  const dir = tmpProject({ 'README.md': '# p\n\n路径误报测试仓。\n' })
  const w = (rel, text) => { mkdirSync(join(dir, rel, '..'), { recursive: true }); fs.writeFileSync(join(dir, rel), text) }
  try {
    // 正向：这三处提到不存在的路径都该放过
    w('docs/specs/a.md', [
      '---', 'kind: spec', 'title: 探针', 'status: draft', 'owner: p', '---', '',
      '# 探针', '',
      '## 背景', '', '当前流程有问题，需要改。', '',
      '## 不在本次范围', '', '- 不动 legacy/old-runner.mjs', '',
      '## 删除清单', '', '- 已删除 src/removed-file.mjs', '',
      '## 验收标准', '', '- [ ] C1: 退出码 0', '',
    ].join('\n'))
    const r = auditDoc({ repoRoot: dir, file: 'docs/specs/a.md' })
    const fp = r.errors.filter((e) => e.code === 'HALLUCINATED_PATH')
    if (fp.length > 0) return `讲不做/讲删除的地方被误报：${fp.map((e) => e.message.slice(0, 40)).join('；')}`

    // 反向：真要引用一个不存在的新文件，必须报——否则这条检查等于被删掉
    w('docs/specs/b.md', [
      '---', 'kind: spec', 'title: 探针二', 'status: draft', 'owner: p', '---', '',
      '# 探针二', '',
      '## 背景', '', '当前流程有问题，需要改，改动落在 src/ghost-real.mjs。', '',
      '## 不在本次范围', '', '- 不动调度器', '',
      '## 验收标准', '', '- [ ] C1: 退出码 0', '',
    ].join('\n'))
    const r2 = auditDoc({ repoRoot: dir, file: 'docs/specs/b.md' })
    if (!r2.errors.some((e) => e.code === 'HALLUCINATED_PATH')) {
      return '正文里引用了不存在的文件却没报——那这条检查等于不存在'
    }
    return true
  } finally { rmTree(dir) }
}])

cases.push(['项目能在模板里点名要章节，也能点名不要', async () => {
  const { resolveDocRequirements } = await import('../../kit/skills/lib/doc-requirements.mjs')
  const fs = await import('node:fs')

  const dir = tmpProject({ 'README.md': '# d\n\n声明测试仓。\n' })
  try {
    mkdirSync(join(dir, 'docs/templates'), { recursive: true })

    // 正向 1：点名要「非功能要求」——必须真的被要求
    fs.writeFileSync(join(dir, 'docs/templates/spec.md'),
      '---\nkind: spec\nrequired_sections: [nfr]\nomit_sections: [door]\n---\n\n# 自己的模板\n')
    const req = resolveDocRequirements(dir, 'spec')
    const ids = req.sections.map((s) => s.id)
    if (!ids.includes('nfr')) return `点名要的 nfr 没被要求：${ids.join(',')}`
    if (ids.includes('door')) return '点名不要的 door 还在要求里'
    if (!req.omit.has('door')) return 'omit 集合里没有 door'

    // 反向 1：无声明时不许凭空多要求——那会把纯工具类项目逼着写「用户身份」
    const plain = resolveDocRequirements(null, 'spec')
    const plainIds = plain.sections.map((s) => s.id)
    for (const extra of ['nfr', 'users', 'risks', 'metrics']) {
      if (plainIds.includes(extra)) return `没有声明却要求了 ${extra}——这就是「不够通用」的来源`
    }
    if (plainIds.length !== 3) return `默认应该只要求主干三节，实际 ${plainIds.length} 节：${plainIds.join(',')}`

    // 反向 2：主干写进 omit 也不许被删
    fs.writeFileSync(join(dir, 'docs/templates/spec.md'),
      '---\nkind: spec\nomit_sections: [goal, acceptance]\n---\n\n# 模板\n')
    const guarded = resolveDocRequirements(dir, 'spec')
    if (guarded.omit.has('goal') || guarded.omit.has('acceptance')) {
      return '主干章节被允许列进 omit——那等于允许不写要做什么'
    }
    if (!guarded.sections.map((s) => s.id).includes('goal')) return '主干被 omit 挤掉了'

    return true
  } finally { rmTree(dir) }
}])

// TDD 生成器自己拼了一份章节清单，模板另有一份。两份分开写，迟早对不上：
// 模板加了新节，生成出来的 TDD 还是老结构，而没人会注意到。
//
// 这里不要求两者逐字相同（生成器只产主干，模板还带可选节），
// 但要求**生成器的每一节在模板里都有对应**——多出来的那个就是漂移。
cases.push(['TDD 生成器真的从模板渲染，章节不会两边各写一份', async () => {
  const { readDocTemplate, templateSections, renderDocTemplate } = await import('../../kit/skills/lib/doc-template-render.mjs')
  const { buildPreFilledTdd } = await import('../../kit/skills/lib/tdd-scaffold.mjs')
  const fs = await import('node:fs')

  const templateHeadings = [...readDocTemplate('tdd').matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
  if (templateHeadings.length === 0) return '读不到 TDD 模板的章节'

  const scaffold = fs.readFileSync(new URL('../../kit/skills/lib/tdd-scaffold.mjs', import.meta.url), 'utf8')
  // 生成器不该再自己拼章节——它只该把事实算成取值，结构交给模板。
  if (/'##\s/.test(scaffold)) {
    return '生成器里还写着自己的章节字面量——那就会和模板漂移，两份清单谁也管不了谁'
  }
  if (!scaffold.includes("renderDocTemplate('tdd'")) {
    return '生成器没有走模板渲染'
  }

  // 产物的每一节都必须在模板里存在（结构只有一个来源）
  const facts = {
    target: { path: null, name: 'probe' },
    ecosystem: { kinds: ['node'], manifests: ['package.json'] },
    artifacts: { runtimeRequirements: ['Node >=18'] },
    commands: { test: 'node --test' },
    reentry: { unregisteredTopDirs: [] },
    tddShape: { enabled: ['stack'], dropSections: [], filePaths: [], topLevelDirs: [] },
  }
  const md = buildPreFilledTdd(facts, { projectName: 'probe', today: '2026-01-01', topLevelDirs: [] })
  const produced = [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim())
  if (produced.length === 0) return '生成器产出了没有章节的文档'

  const unknown = produced.filter((h) => !templateHeadings.some((t) => t.includes(h) || h.includes(t)))
  if (unknown.length > 0) {
    return `产物里的这些章节在模板里没有对应：${unknown.join('、')}`
  }

  // 反向：可选节被裁掉时，那一节的两个标记都不能留在产物里
  const trimmed = renderDocTemplate('tdd', { vars: {}, dropSections: new Set(['data']), pruneUnfilled: false })
  if (/<!--\s*\/?section:/.test(trimmed)) return '产物里残留章节标记'
  if (trimmed.includes('数据模型与持久化契约')) return '声明要裁的章节还在'

  // 反向：主干少了任何一节，都不该被裁掉
  const coreIds = templateSections(readDocTemplate('tdd')).filter((s) => !s.optional).map((s) => s.id)
  if (coreIds.length === 0) return '模板里没有主干章节'

  return true
}])

// 真项目长什么样：这七种形态都是真实存在的，写法各不相同。
//
// 「通用」的验收标准不是「模板有十节」，而是：**这七种项目按自己习惯的写法写，
// 都能通过；而真的什么都没写，照样被拦下。** 前者少了就是误报，后者少了就是漏报。
cases.push(['七种真实项目形态都能通过，真没写照样被拦', async () => {
  const { resolveDocRequirements, resolveSectionPresence, findMissingSections } =
    await import('../../kit/skills/lib/doc-requirements.mjs')

  const samples = {
    SaaS: '## 背景\n\n现有审批靠邮件，无法追溯，需要系统化。\n\n## 不做\n\n- 不做移动端\n\n## 验收标准\n\n- [ ] C1: 可追溯\n',
    CLI: '## Why\n\nThe current CLI cannot handle >1000 files. We need streaming.\n\n## Out of scope\n\n- No GUI\n\n## Done when\n\n- [ ] C1: 10k under 2s\n',
    数据管道: '## 现状\n\n上游 schema 变更后静默丢字段，需要强校验。\n\n## 范围外\n\n- 不改调度器\n\n## 交付判据\n\n- [ ] C1: 退出码 1\n',
    硬件固件: '## 目标\n\n待机功耗降到 5uA 以下。\n\n## 不做\n\n- 不改 PCB\n\n## 验收\n\n- [ ] C1: 实测 <= 5uA\n',
    算法库: '## Problem\n\nSorting degrades to O(n^2). We must keep O(n log n).\n\n## Non-goals\n\n- No parallel version\n\n## Acceptance\n\n- [ ] C1: bench <= 50ms\n',
    论文: '## 研究问题\n\n现有方法在长文本上无法保持一致，需要新机制。\n\n## 不在本文范围\n\n- 不做多模态\n\n## Contributions\n\n- [ ] C1: LongBench 超基线 3 分\n',
    游戏: '## 玩法目标\n\n当前战斗节奏太慢，玩家平均流失在第 3 关，需要调整。\n\n## 不做\n\n- 不改美术资源\n\n## 验收标准\n\n- [ ] C1: 第 3 关通过率 >= 60%\n',
  }

  const bad = []
  for (const [name, text] of Object.entries(samples)) {
    for (const kind of ['prd', 'spec', 'todo']) {
      const req = resolveDocRequirements(null, kind)
      const miss = findMissingSections(req, resolveSectionPresence(text, req), { hasInlineAcceptance: true })
      if (miss.length > 0) bad.push(`${name}/${kind}: ${miss.map((m) => m.id).join(',')}`)
    }
  }
  if (bad.length > 0) return `这些真实写法被判缺节：${bad.join('；')}`

  // 反向 1：真的什么都没写，必须报全主干三节
  const req = resolveDocRequirements(null, 'spec')
  const bare = '## 随便写点\n\n一句话。\n'
  const all = findMissingSections(req, resolveSectionPresence(bare, req), { hasInlineAcceptance: false })
  if (all.length !== 3) return `空文档只报了 ${all.length} 节，应该 3 节：${all.map((m) => m.id).join(',')}`

  // 反向 2：只写目标不写非目标，要单独报出来
  const half = '## 背景\n\n现有方法无法保持一致，需要新机制。\n\n## 验收\n\n- [ ] C1: x\n'
  const m2 = findMissingSections(req, resolveSectionPresence(half, req), { hasInlineAcceptance: true })
  if (!m2.some((m) => m.id === 'non-goals')) return '缺非目标却没报'

  return true
}])

// 章节编号不该写死在模板里：章节是可变集合，序号必须由集合算出来。
//
// 裁掉几节之后如果编号不重排，就成了「一、二、八、九」——读的人会以为文档缺了东西，
// 而它只是被裁掉了。这是「模板写太死」的一个具体后果。
cases.push(['章节序号按裁剪结果重排，手改乱了要报出来', async () => {
  const { renumberHeadings, findNumberingGaps, numberingErrors } = await import('../../kit/skills/lib/doc-renumber.mjs')
  const { renderDocTemplate } = await import('../../kit/skills/lib/doc-template-render.mjs')

  // 正向：裁剪后编号连续
  const prd = renderDocTemplate('prd', {
    vars: { TITLE: 'T', TODAY: '2026-01-01', NON_GOALS: '- 不做', CRITERIA: '- [ ] C1: x' },
  })
  const gaps = findNumberingGaps(prd)
  if (gaps.length > 0) {
    return `裁剪后编号有空档：${gaps.map((g) => `${g.found}应为${g.expected}`).join('、')}`
  }

  // 正向：不带序号的标题不参与计数，也不打断计数
  const mixed = ['## 文档信息', '## 一、甲', '## 系统变更全景', '## 二、乙'].join('\n')
  if (findNumberingGaps(mixed).length > 0) return '不带序号的标题打断了计数'

  // 正向：重排会修掉空档
  const broken = ['## 一、甲', '## 三、丙', '## 四、丁'].join('\n')
  if (findNumberingGaps(broken).length === 0) return '空档没被检出——那报错就永远不会响'
  const fixed = renumberHeadings(broken)
  if (findNumberingGaps(fixed).length > 0) return '重排之后仍有空档'
  if (!fixed.includes('## 二、丙')) return `重排结果不对：${fixed}`

  // 反向：连续的就不要动它（别把对的改错）
  const already = ['## 一、甲', '## 二、乙'].join('\n')
  if (renumberHeadings(already) !== already) return '本来就连续的编号被改了'

  // 报错要带可定位的行号与期望值
  const errs = numberingErrors(broken)
  if (errs.length === 0 || !errs[0].code || !errs[0].fixHint) return '报错项缺字段'
  if (!/第 2 行/.test(errs[0].message)) return `报错没指到行：${errs[0].message}`

  return true
}])

// 「只写现状」这条规矩要能被机器检查，否则它只是一句口号。
//
// 代码里到处是「早先这里是 X，现在改成 Y」。写的时候觉得在解释原因，
// 下一个人读到的却是一份过期的对照表——他不知道「早先」是哪个版本，「现在」是不是还是现在。
cases.push(['履历体写法能被认出来，规则条文本身不算', async () => {
  const { findChangelogVoice, findNewChangelogVoice, buildChangelogVoiceBaseline } =
    await import('../../kit/skills/lib/no-changelog-voice.mjs')

  // 正向：强信号要抓到
  const bad = [
    '// 早先这里是 join 拼接，控制流被压平。',
    '// 以前是七节固定表单。',
    '// 原来这里是三节，后来改成七节。',
  ].join('\n')
  const hits = findChangelogVoice(bad, { file: 'x.mjs' })
  if (hits.length !== 3) return `应抓到 3 条，实际 ${hits.length}：${hits.map((h) => h.word).join(',')}`
  if (hits[0].line !== 1) return '行号不对'

  // 反向 1：讲现状的章节标题不算
  const legit = ['## 现状与痛点', '当前流程有问题。', '## 背景', '这里原来没有校验。'].join('\n')
  const legitHits = findChangelogVoice(legit, { file: 'd.md' })
  if (legitHits.length > 0) return `讲现状的章节被误判：${legitHits.map((h) => h.word).join(',')}`

  // 反向 2：规则条文举的例子不算——它是在**描述**这种写法，不是在写
  const rule = '扫描新增行里的履历墓碑注释（如「以前是/后来改成/deprecated since」）与压制标记。'
  if (findChangelogVoice(rule, { file: 'skill.md' }).length > 0) {
    return '规则条文里被引用的例子被当成了履历'
  }

  // 反向 3：普通技术描述不算
  const plain = [
    '// 这里用对象参数，便于以后扩展。',
    '// 校验失败返回非零退出码。',
  ].join('\n')
  if (findChangelogVoice(plain, { file: 'y.mjs' }).length > 0) return '普通技术注释被误判成履历'

  // 基线：存量冻结，只报新增
  const base = buildChangelogVoiceBaseline(hits)
  if ((base['x.mjs'] ?? 0) !== 3) return '基线生成不对'
  if (findNewChangelogVoice(hits, base).length !== 0) return '存量被当成新增'
  const more = findChangelogVoice(`${bad}\n// 曾经这里是另一套。`, { file: 'x.mjs' })
  if (findNewChangelogVoice(more, base).length !== 1) return '新增的那条没被报出来'

  return true
}])


// GitHub Actions 的表达式也是 `${{ }}`。它的名字常常是全大写（`${{GITHUB_SHA}}`），
// 正好落在「本工具的占位符」那一类里，于是用了 Actions 的项目一条命令都跑不了。
// 豁免必须在**所有**检查之前——只加在形状检查那一处，未登记检查照样会拦住它。
}
