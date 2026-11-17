import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitCommitFast, gitInit, gitSync, issueTokenFor, loadPreflight,
  readDirRefs, rmTree, runAbsAsync, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'


/** 交接包与审核：角色边界、现在这一步、实证佐证。 */
export function registerHandoffReviewCases(cases) {
cases.push(["宿主模板语法在任何检查前就放过，本工具的三类错照样抛", async () => {
  const { renderVars } = await import("../../scripts/lib/template.mjs")

  // 正向：宿主的三种写法都不归本工具管
  for (const s of ["${{GITHUB_SHA}}", "${{ github.sha }}", "${{matrix.os}}"]) {
    try { renderVars(s, {}) } catch (e) { return `宿主语法被拦了：${s} → ${String(e.message).slice(0, 40)}` }
  }

  // 反向 1：未登记的全大写占位符仍必须抛（不是「全大写就放过」）
  let threw = false
  try { renderVars("{{NOT_REGISTERED_XYZ}}", {}) } catch { threw = true }
  if (!threw) return "未登记的占位符不再抛错——那会把模板写错变成静默失效"

  // 反向 2：形状不对的仍必须抛
  threw = false
  try { renderVars("{{ BAD_SHAPE }}", {}) } catch { threw = true }
  if (!threw) return "形状不对的占位符不再抛错"

  // 反向 3：缺取值的仍必须抛
  const { TEMPLATE_VARS } = await import("../lib/protocol.mjs")
  const known = TEMPLATE_VARS[0]
  threw = false
  try { renderVars(`{{${known}}}`, {}) } catch { threw = true }
  if (!threw) return `缺取值的 ${known} 不再抛错`

  return true
}])

// 命令展示长度上限是**字节**上限。按字符砍在中文/emoji 上会砍出超过上限的结果，
// 而门禁查的恰恰是「这一行有没有超 500 字节」——函数自己先超了，查了也白查。
cases.push(["命令截断按字节算，不是按字符算", async () => {
  const { truncateCommandForDisplay, COMMAND_DISPLAY_MAX_BYTES } = await import("../../kit/skills/lib/command-lex.mjs")

  const shorт = "npm test"
  const a = truncateCommandForDisplay(shorт)
  if (a.truncated || a.text !== shorт) return "短命令被改动了"

  // 中文一个字 3 字节：按字符砍会留下远超上限的字节数
  const cn = "node scripts/dev/fixtures.mjs --only 中文用例名称很长很长".repeat(20)
  const b = truncateCommandForDisplay(cn)
  const bBytes = Buffer.byteLength(b.text, "utf8")
  if (bBytes > COMMAND_DISPLAY_MAX_BYTES) {
    return `截断后 ${bBytes} 字节，超过上限 ${COMMAND_DISPLAY_MAX_BYTES}`
  }
  if (!b.truncated) return "超长命令没被标记为截断"
  if (b.total !== Buffer.byteLength(cn, "utf8")) return "总字节数没报对"
  if (!b.text.endsWith("字节）")) return "截断提示没说明总长度"

  // 纯 ASCII 也要守上限
  const c = truncateCommandForDisplay("x".repeat(2000))
  if (Buffer.byteLength(c.text, "utf8") > COMMAND_DISPLAY_MAX_BYTES) return "ASCII 超长命令超了上限"

  return true
}])

// 文档里写着一堆问号，然后一路通过 audit / critique / approve——这条流程最容易糊弄的地方。
// dev-plan 的说明写着「待拍板全部消解后才可进入 audit」，而这条门槛此前只存在于文档里。
cases.push(["待拍板没清空就拦下，清了才放行", async () => {
  const { analyzePendingDecisions, pendingDecisionErrors } =
    await import("../../kit/skills/lib/pending-decisions.mjs")

  // 正向：每条都有「已定：」→ 放行
  const decided = [
    "## 待拍板问题", "",
    "1. TTL 默认值", "   - 建议：5 分钟", "   - 已定：5 分钟",
    "2. 按 key 设 TTL", "   - 已定：不做", "",
  ].join("\n")
  if (pendingDecisionErrors(decided).length > 0) return "全都定了却仍被拦"

  // 反向 1：只有「建议」不算拍板——这正是最容易糊弄过去的地方
  const onlySuggestion = [
    "## 待拍板问题", "",
    "1. TTL 默认值", "   - 建议：5 分钟", "",
  ].join("\n")
  const errs = pendingDecisionErrors(onlySuggestion)
  if (errs.length === 0) return "只写建议就被放行了——建议不是结论"
  if (errs[0].code !== "BLOCKED_PENDING_DECISIONS") return `错误码不对：${errs[0].code}`
  if (!/还有 \d+\/\d+ 条/.test(errs[0].message)) return "报错没写清还剩几条"

  // 反向 2：整节写「无」→ 放行（没有遗留问题也是清空）
  for (const empty of ["## 待拍板问题\n\n- 待确认：无\n", "## 待拍板问题\n\n无\n"]) {
    if (pendingDecisionErrors(empty).length > 0) return `写了「无」却被拦：${empty}`
  }

  // 反向 3：没有这一节 → 不拦（短文档可以不设这一节，那是另一条判据的事）
  if (pendingDecisionErrors("## 背景\n\n一句话\n").length > 0) return "没有这一节却被拦"

  // 正向：节首说明文字不算事项——列表项才是事项
  const withIntro = [
    "## 待拍板问题", "",
    "以下八项是产品级取舍。", "",
    "1. 甲", "   - 已定：做", "2. 乙", "   - 已定：不做", "",
  ].join("\n")
  const r = analyzePendingDecisions(withIntro)
  if (r.total !== 2) return `节首说明被当成事项了：共 ${r.total} 条，应为 2 条`
  if (r.unresolved.length !== 0) return "全都定了却仍报未清"

  return true
}])

// 交接包是「主 Agent 派活给实现子代理」时唯一传过去的东西。
// 它此前只给三样：验收标准、影响路径、非目标——**唯独没有「怎么做」**。
// 缺了设计方案，子代理只能自己重新推导一遍；推错了就是「每条判据都过、实现却不对」。
cases.push(["交接包必须带设计方案，且不许把同一件事说两遍", async () => {
  const { buildHandoff } = await import("../../kit/skills/lib/handoff-package.mjs")

  const spec = [
    "---", "kind: spec", "title: h", "status: approved", "owner: me", "---", "",
    "# SPEC: h", "",
    "## 要解决的问题", "", "某功能要改。", "",
    "## 设计方案与契约变更", "", "### 接口变更", "",
    "loadThing(path) -> { ok, value }", "",
    "失败返回 { ok: false }，不抛异常。", "",
    "## 本期不做", "", "- **本期不做**：不引入第三方解析器；不做 LSP 级语义分析。", "",
    "## 冻结的验收标准", "", "- [ ] C1: 退出码 0", "",
  ].join("\n")

  const todo = [
    "---", "kind: todo", "title: h", "status: active", "owner: me", "---", "",
    "# Todo: h", "",
    "## 任务范围与验证基准", "", "- **影响路径**：`src/loader.mjs`", "",
    "- **本期不做**：第三方解析器、LSP 级语义分析", "",
    "## 验收标准与执行清单", "", "- [ ] C1: 退出码 0", "",
  ].join("\n")

  const dir = tmpProject({
    "README.md": "# h\n\n交接包测试。\n",
    "AGENTS.md": "```yaml\nquick-test: node --test\nfull-test: node --test\n```\n",
    "docs/specs/261117-issue7-h-spec.md": spec,
    "docs/todo/261117-issue7-h-todo.md": todo,
  })
  try {
    const r = buildHandoff({
      mainRoot: dir,
      ledger: {
        taskId: "h", specFile: "docs/specs/261117-issue7-h-spec.md",
        todoFile: "docs/todo/261117-issue7-h-todo.md", branch: "feat/h", baseBranch: "main", baseSha: "abc",
      },
      policy: { requiredGates: [] },
    })

    // 正向：设计方案必须进 prompt，而且内容要真的在里面
    if (!r.prompt.includes("怎么做（来自 SPEC 的设计方案）")) return "交接包里没有设计方案那一节"
    if (!r.prompt.includes("loadThing(path)")) return "设计方案抽出来了但内容不全"
    if (!r.prompt.includes("不抛异常")) return "设计方案的正文没带过来"

    // 正向：影响路径与非目标照旧
    if (!r.fields.paths.includes("src/loader.mjs")) return `影响路径没抽到：${JSON.stringify(r.fields.paths)}`
    if (r.fields.nonGoals.length === 0) return "非目标没抽到"

    // 反向：同一件事在 SPEC 与 Todo 各写一遍时，只该留一条
    if (r.fields.nonGoals.length > 1) {
      return `同一件事被说了两遍：${JSON.stringify(r.fields.nonGoals)}`
    }

    return true
  } finally { rmTree(dir) }
}])

// 审核慢的根因不是审核人笨，是分工错了：一百多条「文件在不在、名字有没有、命令跑不跑得通」
// 不需要判断，却让审核人每次拿手工去核。把这一半接过来，他的时间才花得在判断题上。
cases.push(["文档里的机械断言能自动核，判断类的不替人下结论", async () => {
  const { verifyDocClaims, renderVerificationForReviewer } =
    await import("../../kit/skills/lib/doc-verify.mjs")
  const { collectDocClaims, checkPathClaim } = await import("../../kit/skills/lib/doc-facts.mjs")

  // 名字要在运行时生成：写死在夹具里的话，夹具自己就在仓库里，扫源码时必然扫到它。
  const fake = `__FAKE_${Date.now()}_SYMBOL__`
  const doc = [
    "# 探针文档", "",
    "设计里会用到 `kit/skills/lib/verdict.mjs` 与 `kit/skills/lib/doc-verify.mjs`。",
    "要新建 `kit/skills/lib/brand-new-thing.mjs`(new)。",
    "判断函数叫 `collectDocClaims`，返回 `paths` 与 `commands`。",
    "还有一条命令：`node scripts/dev/preflight.mjs`。",
    "以及一个根本不存在的名字 `" + fake + "`。",
    "以及一条跑不通的命令：`node scripts/no-such-probe-script.mjs`。",
  ].join("\n")

  const claims = collectDocClaims(doc)
  if (claims.paths.length === 0) return "一条路径都没抽出来"
  if (!claims.paths.includes("kit/skills/lib/verdict.mjs")) return "真路径没抽到"
  if (claims.paths.includes("kit/skills/lib/brand-new-thing.mjs")) {
    return "(new) 标注的新文件被当成现存路径——这会造成假红灯"
  }

  const r = await verifyDocClaims(".", doc)

  // 正向：真实存在的路径与名字要核成成立
  if (!r.paths.find((x) => x.rel === "kit/skills/lib/verdict.mjs")?.ok) return "真路径被判不存在"
  if (!r.names.find((x) => x.name === "collectDocClaims")?.ok) return "真函数被判不存在"

  // 反向：编的名字要能被发现（但归到「待确认」那一类，不硬判错）
  const fakeEntry = r.names.find((x) => x.name === fake)
  if (!fakeEntry || fakeEntry.ok) return "编出来的名字没被发现"

  const text = renderVerificationForReviewer(r)
  if (!text.includes(fake)) return "待确认清单里没列出那个编的名字"
  if (!text.includes("请确认是「要新建」还是「写错了」")) {
    return "「找不到」没有被标成需要人确认——工具不该替人下这个结论"
  }

  // 反向：跑不通的命令是硬错，要单独列出来
  if (!text.includes("命令跑不通（硬错，文档要改）")) return "硬错区没出现"

  return true
}])

// 轮次派生式此前在五处各算一遍，两种算法并存：按条数（`length + 1`）与按最大值（`max + 1`）。
// 轮次有空档时（某轮撤销、某轮只审了一部分），前者算出来的轮次是错的——
// 令牌按 4 签、命令让人照 3 跑，于是 `REVIEW_TOKEN_ROUND_MISMATCH`，而且没有出口。
cases.push(["轮次只有一个派生式，空档不算错", async () => {
  const { nextReviewRound } = await import("../../kit/skills/lib/ledger.mjs")

  // 正向：空账本从 1 开始
  if (nextReviewRound({}) !== 1) return "空账本没从 1 开始"
  if (nextReviewRound({ rounds: [] }) !== 1) return "空数组没从 1 开始"

  // 正向：连续轮次
  if (nextReviewRound({ rounds: [{ round: 1 }, { round: 2 }] }) !== 3) return "连续轮次算错"

  // 反向：有空档时必须取最大值加一，不能按条数算
  const gap = { rounds: [{ round: 1 }, { round: 3 }] }
  const got = nextReviewRound(gap)
  if (got !== 4) return `空档时算成了 ${got}，应为 4（取最大轮次加一）`
  if (got === gap.rounds.length + 1) return "空档时退回了按条数算——那正是死锁的来源"

  // 反向：从中间起头也算得出来（历史被清理过）
  if (nextReviewRound({ rounds: [{ round: 3 }] }) !== 4) return "从中间起头时算错"

  // 反向：脏数据不许把轮次算成 0 或 NaN
  const dirty = nextReviewRound({ rounds: [{ round: "x" }, { round: null }, { round: 2 }] })
  if (!Number.isInteger(dirty) || dirty < 2) return `脏数据算出了 ${dirty}`

  return true
}])

// 交接包自称「机械生成、可以直接粘给子代理」，那它就得把「粘过去之后还要走什么」也带上。
// 少写一步，那一步就不会发生——而「做完了但没提交、没开 PR」看起来和「做完了」一模一样。
cases.push(["交接包给角色边界与状态机指针，不抄流程清单", async () => {
  const { buildHandoff } = await import("../../kit/skills/lib/handoff-package.mjs")
  const { join } = await import("node:path")

  const dir = tmpProject({
    "README.md": "# w\n\n角色边界测试。\n",
    "AGENTS.md": "```yaml\nquick-test: node --test\n```\n",
    "docs/specs/261117-issue7-w-spec.md": [
      "---", "kind: spec", "title: w", "status: approved", "owner: me", "---", "",
      "# SPEC: w", "", "## 要解决的问题", "", "某功能要改。", "",
      "## 冻结的验收标准", "", "- [ ] C1: 退出码 0", "",
    ].join("\n"),
  })
  try {
    const ledger = {
      taskId: "issue-7", linkedIssues: [7], role: "local-only",
      specFile: "docs/specs/261117-issue7-w-spec.md", todoFile: null,
      branch: "feat/w", baseBranch: "main", baseSha: "abc",
    }

    // 正向：四种角色各有各的边界，不许都落到同一个
    const labels = {}
    for (const role of ["implementer", "reviewer", "coordinator", "human"]) {
      const r = buildHandoff({ mainRoot: dir, ledger, policy: {}, ownerRole: role })
      const i = r.prompt.indexOf("你的角色与边界")
      if (i < 0) return `${role} 的交接包里没有角色边界那一节`
      const m = /\*\*(.+?)\*\*。/.exec(r.prompt.slice(i))
      if (!m) return `${role} 的角色名没写出来`
      labels[role] = m[1]
    }
    const distinct = new Set(Object.values(labels))
    if (distinct.size !== 4) {
      return `四种角色落成了 ${distinct.size} 种：${JSON.stringify(labels)}`
    }

    // 正向：必须指向状态机，不能让人凭记忆推断下一步
    const r = buildHandoff({ mainRoot: dir, ledger, policy: {}, ownerRole: "implementer" })
    if (!r.prompt.includes("flow.mjs next --task issue-7")) return "没给查下一步的命令"
    if (!r.prompt.includes("状态在账本里")) return "没说明「状态在账本、不在上下文」——被中断时接不上"

    // 反向：**不许**把状态机的流程清单抄进来。抄了就会漂移。
    for (const word of ["finalize --task", "submit --task", "verify --task"]) {
      if (r.prompt.includes(word)) {
        return `交接包抄了流程步骤「${word}」——那是状态机的活，两处写同一件事必然漂移`
      }
    }

    return true
  } finally { rmTree(dir) }
}])

// 审核侧此前完全拿不到交接包：协调者派 review 子代理时只能自己现编 prompt，
// 摘漏一条上一轮意见，那一轮就等于没审。这不是「实现侧的问题」，是两边的共同缺口。
cases.push(["审核角色拿到这一轮该看什么，实现角色不拿", async () => {
  const { buildHandoff } = await import("../../kit/skills/lib/handoff-package.mjs")

  const ledger = {
    taskId: "x", linkedIssues: [], role: "local-only",
    specFile: "docs/specs/261117-issue49-survey-honesty-spec.md", todoFile: null,
    branch: "b", baseBranch: "main", baseSha: "abc",
    rounds: [{ round: 1, verdict: "changes", headSha: "aaa", findings: [
      { severity: "must", text: "C7 的判红形式与真实输出对不上" },
      { severity: "should", text: "C3 措辞可再收窄" },
    ] }],
  }

  const rev = buildHandoff({ mainRoot: ".", ledger, policy: {}, ownerRole: "reviewer", headSha: "bbb" })

  // 正向：Round 2 必须提示新建独立子代理
  if (!rev.prompt.includes("Round 2")) return "没算出下一轮是 Round 2"
  if (!rev.prompt.includes("必须新建独立子代理")) return "Round 2 没提示必须换人"

  // 正向：上一轮意见要逐条带到（摘要都不给，等于让人重头审）
  if (!rev.prompt.includes("C7 的判红形式与真实输出对不上")) return "上一轮的意见没带过来"
  if (!rev.prompt.includes("必修")) return "没标出哪条是必修"

  // 正向：同一判据要提醒「只对着判据判断」
  if (!rev.prompt.includes("验收标准是冻结的")) return "没说明判据是冻结的"

  // 反向：实现角色不该看到审核侧的清单——那是别人的活
  const impl = buildHandoff({ mainRoot: ".", ledger, policy: {}, ownerRole: "implementer", headSha: "bbb" })
  if (impl.prompt.includes("这一轮该看什么")) return "实现角色拿到了审核清单"

  // 反向：HEAD 没变时要说清「同样的输入不会得出不同结论」
  const same = buildHandoff({ mainRoot: ".", ledger, policy: {}, ownerRole: "reviewer", headSha: "aaa" })
  if (!same.prompt.includes("当前 HEAD 与上一轮审查时相同")) return "HEAD 没变却没提醒"

  return true
}])

// `requiredGates` 里是层级名（gate / full / smoke / quick），不是命令。
// 交接包只印一个 `gate`，子代理不知道它对应哪条命令——等于什么都没说。
cases.push(["必过门要展开成能直接跑的命令，不是一个档位名", async () => {
  const { buildHandoff } = await import("../../kit/skills/lib/handoff-package.mjs")

  const ledger = { taskId: "x", linkedIssues: [], role: "local-only",
    specFile: null, todoFile: null, branch: "b", baseBranch: "main", baseSha: "a" }
  const profile = { mergeGate: "node scripts/dev/preflight.mjs && node scripts/dev/fixtures.mjs" }

  const r = buildHandoff({
    mainRoot: ".", ledger, ownerRole: "implementer", profile,
    policy: { riskTier: "high", requiredGates: ["gate"] },
  })

  // 正向：档位名旁边要给出真实命令
  if (!r.prompt.includes("`gate` 档")) return "没标出这是 gate 档"
  if (!r.prompt.includes("node scripts/dev/fixtures.mjs")) {
    return "只印了档位名，没展开成 Dev Profile 里的真实命令"
  }

  // 反向：Dev Profile 里没有这条命令时，要说清「按上面的怎么算做完跑」，不许瞎猜
  const noCmd = buildHandoff({
    mainRoot: ".", ledger, ownerRole: "implementer", profile: {},
    policy: { riskTier: "high", requiredGates: ["gate"] },
  })
  if (!noCmd.prompt.includes("没有对应命令")) return "缺命令时没说明怎么办"
  const gateSection = noCmd.prompt.slice(noCmd.prompt.indexOf("必过门"))
  const gateLine = gateSection.split("\n").find((l) => l.includes("`gate` 档")) ?? ""
  if (gateLine.includes("node scripts/dev/fixtures.mjs")) {
    return "缺命令时在必过门那一节编了一条出来"
  }

  return true
}])

// flow next 已经算出 phase / nextAction / command，丢了它们子代理就不知道此刻要干什么。
// 认领那一步就是这么漏掉的——一整包「做什么」里，唯独没有「现在做什么」。
cases.push(["交接包第一眼就是现在这一步", async () => {
  const { buildHandoff } = await import("../../kit/skills/lib/handoff-package.mjs")

  const ledger = { taskId: "issue-9", linkedIssues: [9], role: "local-only",
    specFile: null, todoFile: null, branch: "b", baseBranch: "main", baseSha: "a" }
  const current = {
    phase: "needs-claim", ownerRole: "implementer",
    nextAction: "先认领再动手",
    command: 'node ".agents/skills/dev-flow/scripts/flow.mjs" claim --task issue-9',
    blockingReasons: ["BLOCKED_NOT_CLAIMED"],
  }
  const r = buildHandoff({ mainRoot: ".", ledger, policy: {}, ownerRole: "implementer", current })
  const p = r.prompt

  if (!p.includes("## 现在这一步")) return "没有「现在这一步」那一节"

  // 必须在「你在做什么」之前——第一眼看到的要是此刻的动作，不是长清单
  const at = p.indexOf("## 现在这一步")
  const after = p.indexOf("## 你在做什么")
  if (after >= 0 && at > after) return "「现在这一步」排在了长清单后面"

  if (!p.includes("`needs-claim`")) return "没写出当前阶段"
  if (!p.includes("先认领再动手")) return "没写出这一步要做什么"
  if (!p.includes("claim --task issue-9")) return "没给出能直接跑的命令"
  if (!p.includes("BLOCKED_NOT_CLAIMED")) return "没写出挡住它的原因"

  // 关键：做完之后要再查一次，不许自己推断
  if (!p.includes("再跑一次 `flow next")) return "没说明做完要再查一次"

  // 反向：没有 current 时不许编一个出来
  const bare = buildHandoff({ mainRoot: ".", ledger, policy: {}, ownerRole: "implementer" })
  if (bare.prompt.includes("## 现在这一步")) return "没传 current 却凭空造了一节"

  return true
}])

// 同一个「写操作前不联网探」的洞，在认领、归档、提审、合并、清理四处各犯一次。
// 逐处加参数是打补丁——下一个写操作忘加，洞再来一次。
// 所以判据要盯住**接口语义**：写操作不许走「不联网」的探测。
cases.push(["写操作必须联网探通道，不许静默降级成本地记账", async () => {
  const { readFileSync: rf, readdirSync } = await import("node:fs")
  const { join } = await import("node:path")

  // 写操作所在的文件。清单来自「这些命令会不会改平台状态」。
  const writeFiles = [
    "kit/skills/dev-flow/scripts/flow-merge.mjs",
    "kit/skills/dev-flow/scripts/flow-lifecycle.mjs",
    "kit/skills/dev-flow/scripts/flow-cleanup.mjs",
    "kit/skills/dev-flow/scripts/flow-sync.mjs",
  ]

  for (const f of writeFiles) {
    const src = rf(f, "utf8")
    if (!src.includes("probeForWrite")) {
      return `${f} 是写操作，但没有走 probeForWrite`
    }
    // 反向：不许留下裸的「不联网」探测——那正是这个洞的形状
    const bare = /probeGitHubEnv\(\{\s*cwd:[^}]*\}\)/.exec(src)
    if (bare) {
      return `${f} 还留着一处裸探测：${bare[0].slice(0, 60)}`
    }
  }

  // 正向：probeForWrite 真的联网
  const { probeForWrite } = await import("../../kit/skills/lib/platform.mjs")
  if (typeof probeForWrite !== "function") return "probeForWrite 没导出"

  return true
}])

// 审核阶段在归档**之后**：文档已搬进 docs/archive/，而且搬动发生在实施位里，
// 还没合并回主仓。只读 specFile 会让审核交接包变成「没有登记验收标准」——
// 判据在，只是搬了家。两个根都要看。
cases.push(["归档之后审核交接包仍拿得到验收标准", async () => {
  const { buildHandoff } = await import("../../kit/skills/lib/handoff-package.mjs")
  const { join } = await import("node:path")

  const dir = tmpProject({ "README.md": "# a\n\n归档测试。\n" })
  try {
    gitInit(dir)
    gitCommitFast(dir, "init")
    // 建实施位，把归档文档放进**实施位**里（主仓没有）
    const wt = join(dir, ".worktrees", "impl-a")
    const fs = await import("node:fs")
    fs.mkdirSync(join(wt, "docs", "archive", "specs"), { recursive: true })
    fs.writeFileSync(join(wt, "docs", "archive", "specs", "x-spec.md"), [
      "---", "kind: spec", "title: x", "status: implemented", "owner: me", "---", "",
      "# SPEC: x", "", "## 冻结的验收标准", "", "- [x] C1: 退出码 0", "- [x] C2: 不误报", "",
    ].join("\n"))

    const r = buildHandoff({
      mainRoot: dir,
      ledger: {
        taskId: "a", role: "local-only", branch: "b", baseBranch: "main", baseSha: "c",
        worktreePath: ".worktrees/impl-a",
        specFile: "docs/archive/specs/x-spec.md",
        archivedSpecFile: "docs/archive/specs/x-spec.md",
        todoFile: null, archivedTodoFile: null,
      },
      policy: {}, ownerRole: "reviewer",
    })

    if (r.prompt.includes("没有登记验收标准")) {
      return "归档后的文档在主仓找不到，交接包就说没登记——判据在，只是搬了家"
    }
    if (!r.prompt.includes("C1")) return "没收出 C1"
    if (!r.prompt.includes("C2")) return "没收出 C2"
    if (r.fields.criteriaCount !== 2) return `条数算出 ${r.fields.criteriaCount}，应为 2`

    return true
  } finally { rmTree(dir) }
}])

// 审核的第一动作必须是**跑**，不是读。没有佐证的通过，与没通过是一回事——
// 因为「我跑过」和「我觉得」在账本里长得一模一样。
cases.push(["记审查结论必须交实证佐证", async () => {
  const { handleRecord } = await import("../../kit/skills/dev-review/scripts/review-ledger.mjs")
  const { issueTokenFor, gitCommitFast, gitInit, rmTree, tmpProject } = await import("./fixtures-helpers.mjs")
  const { readTaskLedger, writeTaskLedger } = await import("../../kit/skills/lib/ledger.mjs")
  const { join } = await import("node:path")

  const dir = tmpProject({ "src/a.mjs": "export const a = 1\n" })
  try {
    gitInit(dir)
    gitCommitFast(dir, "init")
    const { handleStart } = await import("../../kit/skills/dev-flow/scripts/flow-inspect.mjs")
    const { resolveRepoRoots } = await import("../../kit/skills/lib/shared.mjs")
    const roots = await resolveRepoRoots(dir)
    await handleStart({ task: "ev", case: "2", slug: "ev" }, roots)

    const base = { task: "ev", round: "1", verdict: "pass", "reviewer-id": "rev-x" }

    // 反向：不传 evidence 必须拒绝，且要说清为什么
    const noEv = await handleRecord({ ...base, "review-token": await issueTokenFor(dir, "ev", 1) }, roots)
    if (noEv === 0) return "不交实证也能记通过——「我跑过」和「我觉得」分不出来了"

    // 正向：交了 evidence 才放行
    const withEv = await handleRecord({
      ...base, "review-token": await issueTokenFor(dir, "ev", 1),
      evidence: "跑了 node scripts/dev/fixtures.mjs --only 某判据，输出 1 通过 0 失败",
    }, roots)
    if (withEv !== 0) return `交了实证仍被拒：exit=${withEv}`

    // 佐证要落进账本，否则下一轮复审看不到上一轮跑过什么
    const led = readTaskLedger(dir, "ev")
    const r1 = (led.rounds ?? []).find((r) => Number(r.round) === 1)
    if (!r1) return "账本里没有这一轮的记录"
    if (!r1.reviewEvidence) return "佐证没写进账本——下一轮复审看不到跑过什么"
    if (!String(r1.reviewEvidence).includes("fixtures.mjs")) return "账本里的佐证不是原文"

    return true
  } finally { rmTree(dir) }
}])
}
