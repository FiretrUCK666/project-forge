import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  HERE, SCRIPTS, SKILL_ROOT, existingKept, gitCommitFast, gitInit, gitSync, issueTokenFor, loadPreflight,
  readDirRefs, rmTree, runAbs, runAbsAsync, runNode, survey, textsOf, tmpProject,
} from './fixtures-helpers.mjs'
import { collectKitWriteProbeTargets, scanKitWriteProbeViolations } from './write-probe-audit.mjs'


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

// 同一个「写操作前不联网探」的洞，在认领、归档、提审、合并、清理各处反复出现。
// 所以判据要盯住全量静态门禁、shared 导出、只读惰性非回归，以及不传 mock 的真实子进程双态。
cases.push(["写操作必须联网探通道，不许静默降级成本地记账", async () => {
  const sharedMod = await import("../../kit/skills/lib/shared.mjs")
  if (typeof sharedMod.probeForWrite !== "function") return "shared.mjs 缺少 probeForWrite 导出"
  const { probeForWrite } = await import("../../kit/skills/lib/platform.mjs")
  if (typeof probeForWrite !== "function") return "platform.mjs probeForWrite 没导出"

  // C3：全量 kit/skills/ 静态门禁 + 合成正反双向（含注释欺骗/键序倒置/多行/probeNetwork:false）
  const realViolations = scanKitWriteProbeViolations(collectKitWriteProbeTargets(SKILL_ROOT))
  if (realViolations.length > 0) {
    return `全量扫描检出写路径未联网探测：${realViolations.map((v) => `${v.file}:${v.line}(${v.rule})`).join("; ")}`
  }
  const synOk = scanKitWriteProbeViolations([
    { file: "kit/skills/dev-flow/scripts/ro.mjs", text: "await probeGitHubEnv({ cwd, remoteUrls, probeNetwork: Boolean(opts.probeAuth) })\n" },
    { file: "kit/skills/dev-flow/scripts/ro2.mjs", text: "await probeGitHubEnv({\n  remoteUrls,\n  cwd,\n  probeNetwork: true,\n})\n" },
  ])
  if (synOk.length > 0) return `合法只读 probeGitHubEnv 被误报：${JSON.stringify(synOk)}`

  const synBadSamples = [
    ["键序倒置", "await probeGitHubEnv({ remoteUrls, cwd })"],
    ["多行参数", "await probeGitHubEnv({\n  remoteUrls,\n  cwd,\n})"],
    ["probeNetwork:false", "await probeGitHubEnv({ cwd, remoteUrls, probeNetwork: false })"],
    ["写入口缺probeForWrite", "await ghClient.createIssue({ repo, title })\nawait backend.postComment({ repo, number, body })"],
    ["仅注释出现probeForWrite", "// await probeForWrite({ cwd })\nawait backend.postComment({ repo, number, body })"],
  ]
  for (const [label, sample] of synBadSamples) {
    const hits = scanKitWriteProbeViolations([{ file: "kit/skills/dev-flow/scripts/syn.mjs", text: sample }])
    if (hits.length === 0) return `静态扫描器漏放合成违规样本（${label}）`
  }

  // C2 + C1：真实 fake-gh 沙盒与孤立 Git/Home 环境（绝不传 _ghProbe/_ghClient）
  const sb = tmpProject({})
  const binDir = join(sb, "bin")
  const isoHome = join(sb, "home")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(isoHome, { recursive: true })
  const fakeGhJs = join(binDir, "fake-gh.mjs")
  writeFileSync(fakeGhJs, [
    "import { appendFileSync } from 'node:fs'",
    "const args = process.argv.slice(2)",
    "if (process.env.FAKE_GH_LOG) appendFileSync(process.env.FAKE_GH_LOG, args.join(' ') + '\\n')",
    "const ok = process.env.FAKE_GH_AUTH === '1'",
    "if (args[0] === 'auth' && args[1] === 'status') {",
    "  if (ok) { process.stdout.write('github.com\\n  Logged in to github.com account alice (oauth_token)\\n'); process.exit(0) }",
    "  process.stderr.write('You are not logged in to any GitHub hosts.\\n'); process.exit(1)",
    "}",
    "if (!ok) process.exit(1)",
    "if (args[0] === 'issue' && args[1] === 'create') { process.stdout.write('https://github.com/acme/demo/issues/101\\n'); process.exit(0) }",
    "if (args[0] === 'issue' && args[1] === 'edit') process.exit(0)",
    "if (args[0] === 'pr' && (args[1] === 'merge' || args[1] === 'edit')) process.exit(0)",
    "if (args[0] === 'pr' && args[1] === 'view') {",
    "  process.stdout.write(JSON.stringify({ number: Number(args[2]) || 91, title: 'p', state: 'MERGED', body: '', url: 'https://github.com/acme/demo/pull/91', headRefName: 'fix/mq', baseRefName: 'main', mergedAt: '2026-11-18T00:00:00Z', author: { login: 'alice' } })); process.exit(0)",
    "}",
    "if (args[0] === 'api') {",
    "  const ep = args[1] || ''",
    "  if (ep.includes('/comments')) { process.stdout.write(JSON.stringify({ id: 1, html_url: 'https://github.com/acme/demo/issues/1#c1', body: '' })); process.exit(0) }",
    "  if (ep.includes('/check-runs')) { process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [{ name: 'ci', status: 'completed', conclusion: 'success' }] })); process.exit(0) }",
    "  if (ep.includes('/status')) { process.stdout.write(JSON.stringify({ state: 'success', statuses: [] })); process.exit(0) }",
    "}",
    "process.exit(1)",
  ].join("\n"), "utf8")
  if (process.platform === "win32") {
    writeFileSync(join(binDir, "gh.cmd"), `@echo off\r\n"${process.execPath}" "${fakeGhJs}" %*\r\n`, "utf8")
  } else {
    const shPath = join(binDir, "gh")
    writeFileSync(shPath, `#!/bin/sh\nexec "${process.execPath}" "${fakeGhJs}" "$@"\n`, "utf8")
    chmodSync(shPath, 0o755)
  }

  const sepPath = process.platform === "win32" ? ";" : ":"
  const childEnv = (authOk, logFile) => {
    const env = { ...process.env }
    delete env.GH_TOKEN; delete env.GITHUB_TOKEN; delete env.PF_MCP_GITHUB; delete env.MCP_GITHUB_AVAILABLE; delete env.Path
    env.PATH = `${binDir}${sepPath}${process.env.PATH ?? process.env.Path ?? ""}`
    env.PF_NO_REAL_AUTH_PROBE = "0"
    env.FAKE_GH_AUTH = authOk ? "1" : "0"
    env.FAKE_GH_LOG = logFile
    env.HOME = isoHome; env.USERPROFILE = isoHome; env.XDG_CONFIG_HOME = isoHome
    env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_CONFIG_GLOBAL = ""; env.SSH_AUTH_SOCK = ""
    return env
  }

  const dir = tmpProject({
    ".gitignore": ".worktrees/\n",
    "package.json": '{"name":"demo","version":"1.0.0","repository":"https://github.com/acme/demo.git"}\n',
    "AGENTS.md": "```yaml\nquick-test: exit 0\nfull-test: exit 0\nsmoke-verify: none\nmerge-gate: exit 0\n```\n",
    "README.md": "# demo\n",
    "src/app.mjs": "export const v = 1\n",
  })
  try {
    gitInit(dir, { branch: "main", name: "alice", email: "alice@example.com", origin: "https://github.com/acme/demo.git" })
    gitSync(dir, ["config", "core.autocrlf", "false"])
    gitSync(dir, ["branch", "old-base"])
    writeFileSync(join(dir, "upstream.mjs"), "export const up = 1\n")
    gitCommitFast(dir, "advance main", { files: ["upstream.mjs"], name: "alice", email: "alice@example.com" })

    const { resolveRepoRoots } = await import("../../kit/skills/lib/shared.mjs")
    const { inspectWorkspace } = await import("../../kit/skills/dev-flow/scripts/flow-inspect.mjs")
    const { writeTaskLedger, readTaskLedger } = await import("../../kit/skills/lib/ledger.mjs")
    const { runCli: runGovernCli } = await import("../../kit/skills/dev-govern/scripts/govern-audit.mjs")
    const roots = await resolveRepoRoots(dir)

    // 非回归：只读 inspectWorkspace 在无 --probe-auth 时绝不调 gh auth status
    const logRo = join(sb, "ro.log")
    const envKeys = ["PF_NO_REAL_AUTH_PROBE", "GH_TOKEN", "GITHUB_TOKEN", "PF_MCP_GITHUB", "MCP_GITHUB_AVAILABLE", "FAKE_GH_LOG", "FAKE_GH_AUTH", "HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "SSH_AUTH_SOCK"]
    const saved = Object.fromEntries(envKeys.map((k) => [k, Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined]))
    const savedPaths = Object.getOwnPropertyNames(process.env).filter((k) => k.toLowerCase() === "path").map((k) => [k, process.env[k]])
    try {
      delete process.env.Path
      delete process.env.PATH
      Object.assign(process.env, childEnv(true, logRo))
      delete process.env.GH_TOKEN
      delete process.env.GITHUB_TOKEN
      if (!process.env.PATH || !process.env.PATH.includes(binDir)) {
        return `测试隔离环境丢失 PATH：PATH=${String(process.env.PATH)}`
      }
      const ro = await inspectWorkspace(dir, { roots })
      if (ro.github.trackB.tier !== "none" || existsSync(logRo)) {
        return `只读 inspectWorkspace 破坏了惰性默认：tier=${ro.github.trackB.tier}, logged=${existsSync(logRo)}`
      }
    } finally {
      delete process.env.Path
      delete process.env.PATH
      for (const [pk, pv] of savedPaths) if (pv !== undefined) process.env[pk] = pv
      for (const k of envKeys) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
      }
    }

    // 1. flow.mjs start --create-issue（正向进 gh-cli 建单 + 反向进 ACTION_REQUIRED_CREATE_ISSUE_DELEGATED exit 4）
    const logCiPos = join(sb, "ci-pos.log")
    const ciPos = runAbs("kit/skills/dev-flow/scripts/flow.mjs", ["start", "--task", "ci-pos", "--slug", "ci-pos", "--create-issue", "--title", "Real Issue", "--case", "3", "--json"], { cwd: dir, env: childEnv(true, logCiPos), windowsHide: true })
    if (ciPos.status !== 0) return `start --create-issue 正向失败(${ciPos.status})：${ciPos.stderr || ciPos.stdout}`
    const ciPosJson = JSON.parse(ciPos.stdout)
    if (ciPosJson.createdIssue?.number !== 101 || !readFileSync(logCiPos, "utf8").includes("issue create")) {
      return `start --create-issue 未走 gh-cli 建单：${ciPos.stdout}`
    }
    const logCiNeg = join(sb, "ci-neg.log")
    const ciNeg = runAbs("kit/skills/dev-flow/scripts/flow.mjs", ["start", "--task", "ci-neg", "--slug", "ci-neg", "--create-issue", "--title", "Neg Issue", "--case", "3", "--json"], { cwd: dir, env: childEnv(false, logCiNeg), windowsHide: true })
    if (ciNeg.status !== 4 || !ciNeg.stdout.includes("ACTION_REQUIRED_CREATE_ISSUE_DELEGATED")) {
      return `start --create-issue 反向未阻断为 exit 4：status=${ciNeg.status}, out=${ciNeg.stdout}, err=${ciNeg.stderr}`
    }

    // 2. review-pack.mjs record（正向 real gh-cli 双写 + 反向 offlineOrNoCreds + delegatedPayloads）
    const wtPos = join(dir, ".worktrees", "impl-ci-pos")
    writeFileSync(join(wtPos, "src/app.mjs"), "export const v = 3\n")
    gitCommitFast(wtPos, "r1", { files: ["src/app.mjs"], name: "alice", email: "alice@example.com" })
    writeTaskLedger(dir, { ...readTaskLedger(dir, "ci-pos"), prNumber: 88, linkedIssues: [77] })
    const logRecPos = join(sb, "rec-pos.log")
    const recPos = runAbs("kit/skills/dev-review/scripts/review-pack.mjs", [
      "record", "--task", "ci-pos", "--round", "1", "--verdict", "pass", "--reviewer-id", "rev-x",
      "--review-token", await issueTokenFor(dir, "ci-pos", 1), "--evidence", "real fake-gh verified", "--json",
    ], { cwd: dir, env: childEnv(true, logRecPos), windowsHide: true })
    const recPosJson = recPos.status === 0 ? JSON.parse(recPos.stdout) : null
    if (!recPosJson?.githubSync?.synced || !readFileSync(logRecPos, "utf8").includes("/issues/88/comments")) {
      return `review-pack record 正向未走 gh-cli 双写：status=${recPos.status}, out=${recPos.stdout}, err=${recPos.stderr}`
    }
    writeFileSync(join(wtPos, "src/app.mjs"), "export const v = 4\n")
    gitCommitFast(wtPos, "r2", { files: ["src/app.mjs"], name: "alice", email: "alice@example.com" })
    const logRecNeg = join(sb, "rec-neg.log")
    const recNeg = runAbs("kit/skills/dev-review/scripts/review-pack.mjs", [
      "record", "--task", "ci-pos", "--round", "2", "--verdict", "pass", "--reviewer-id", "rev-y",
      "--review-token", await issueTokenFor(dir, "ci-pos", 2), "--evidence", "real fake-gh negative", "--json",
    ], { cwd: dir, env: childEnv(false, logRecNeg), windowsHide: true })
    const recNegSync = recNeg.status === 0 ? JSON.parse(recNeg.stdout).githubSync : null
    if (recNeg.status !== 0 || recNegSync?.offlineOrNoCreds !== true || recNegSync?.tier !== "none" || (recNegSync?.delegatedPayloads?.targets?.length ?? 0) < 2) {
      return `review-pack record 反向未安全降级：status=${recNeg.status}, out=${recNeg.stdout}`
    }

    // 3. flow-batch merge-queue（正向真合并 + 反向绝不虚报 merged）
    for (const [tid, pr] of [["mq-pos", 91], ["mq-neg", 92]]) {
      await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["start", "--task", tid, "--case", "2", "--slug", tid, "--implementer", "alice"], { cwd: dir })
      const wt = join(dir, ".worktrees", `impl-${tid}`)
      writeFileSync(join(wt, "src/app.mjs"), `export const v = '${tid}'\n`)
      gitCommitFast(wt, tid, { files: ["src/app.mjs"], name: "alice", email: "alice@example.com" })
      await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["verify", "--task", tid, "--mode", "full"], { cwd: dir })
      await runAbsAsync("kit/skills/dev-review/scripts/review-pack.mjs", ["record", "--task", tid, "--round", "1", "--verdict", "pass", "--reviewer-id", "rev-mq", "--review-token", await issueTokenFor(dir, tid, 1), "--evidence", "mq verified"], { cwd: dir })
      writeTaskLedger(dir, { ...readTaskLedger(dir, tid), prNumber: pr, explored: { at: "2026-01-01T00:00:00Z", tier: "direct-read", symbolCount: 1, by: "alice" } })
    }
    const logMqPos = join(sb, "mq-pos.log")
    const mqPos = runAbs("kit/skills/dev-flow/scripts/flow.mjs", ["batch", "merge-queue", "--tasks", "mq-pos", "--json"], { cwd: dir, env: childEnv(true, logMqPos), windowsHide: true })
    const mqPosJson = mqPos.status === 0 ? JSON.parse(mqPos.stdout) : null
    if (!mqPosJson?.ok || mqPosJson?.processed?.[0]?.status !== "merged" || !readFileSync(logMqPos, "utf8").includes("pr merge 91")) {
      return `flow-batch 正向未走 gh-cli 合并：status=${mqPos.status}, out=${mqPos.stdout}, err=${mqPos.stderr}`
    }
    const logMqNeg = join(sb, "mq-neg.log")
    const mqNeg = runAbs("kit/skills/dev-flow/scripts/flow.mjs", ["batch", "merge-queue", "--tasks", "mq-neg", "--json"], { cwd: dir, env: childEnv(false, logMqNeg), windowsHide: true })
    const mqNegJson = mqNeg.stdout ? JSON.parse(mqNeg.stdout) : null
    if (mqNeg.status === 0 || mqNegJson?.ok !== false || mqNegJson?.processed?.[0]?.status === "merged") {
      return `flow-batch 反向虚报合并成功：status=${mqNeg.status}, out=${mqNeg.stdout}`
    }

    // 4. flow-sync（有 prNumber / parentPrNumber 时无需 --probe-auth 自动联网探通道；无则不探）
    await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["start", "--task", "sy-pr", "--case", "2", "--slug", "sy-pr", "--base", "old-base", "--implementer", "alice"], { cwd: dir })
    const wtSy = join(dir, ".worktrees", "impl-sy-pr")
    writeFileSync(join(wtSy, "sy-pr.mjs"), "export const s = 1\n")
    gitCommitFast(wtSy, "sy-pr commit", { files: ["sy-pr.mjs"], name: "alice", email: "alice@example.com" })
    writeTaskLedger(dir, { ...readTaskLedger(dir, "sy-pr"), prNumber: 95 })
    const logSy = join(sb, "sy.log")
    const syRes = runAbs("kit/skills/dev-flow/scripts/flow.mjs", ["sync", "--task", "sy-pr", "--onto", "main", "--json"], { cwd: dir, env: childEnv(true, logSy), windowsHide: true })
    const syJson = syRes.status === 0 ? JSON.parse(syRes.stdout) : null
    if (!syJson?.prBaseUpdate?.ok || !readFileSync(logSy, "utf8").includes("pr edit 95")) {
      return `flow-sync 有 prNumber 时未自动触发 probeForWrite：status=${syRes.status}, out=${syRes.stdout}, err=${syRes.stderr}`
    }
    await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["start", "--task", "sy-par", "--case", "2", "--slug", "sy-par", "--base", "old-base", "--implementer", "alice"], { cwd: dir })
    writeTaskLedger(dir, { ...readTaskLedger(dir, "sy-par"), parentBranch: "main", parentPrNumber: 94 })
    const logSyPar = join(sb, "sy-par.log")
    const syParRes = runAbs("kit/skills/dev-flow/scripts/flow.mjs", ["sync", "--task", "sy-par", "--json"], { cwd: dir, env: childEnv(true, logSyPar), windowsHide: true })
    if (syParRes.status !== 0 || !readFileSync(logSyPar, "utf8").includes("pr view 94")) {
      return `flow-sync 有 parentPrNumber 时未自动触发 probeForWrite：status=${syParRes.status}, log=${existsSync(logSyPar) ? readFileSync(logSyPar, "utf8") : "none"}`
    }
    await runAbsAsync("kit/skills/dev-flow/scripts/flow.mjs", ["start", "--task", "sy-none", "--case", "2", "--slug", "sy-none", "--base", "old-base", "--implementer", "alice"], { cwd: dir })
    const logSyNone = join(sb, "sy-none.log")
    const syNoneRes = runAbs("kit/skills/dev-flow/scripts/flow.mjs", ["sync", "--task", "sy-none", "--onto", "main", "--json"], { cwd: dir, env: childEnv(true, logSyNone), windowsHide: true })
    if (syNoneRes.status !== 0 || existsSync(logSyNone)) {
      return `flow-sync 无 PR/父 PR 且无 --probe-auth 时不应探测网络：status=${syNoneRes.status}, logged=${existsSync(logSyNone)}`
    }

    // 5. govern-state / govern-audit（正向 real gh-cli 建单 + 反向报 gh CLI / GitHub token 错误 + runtimeOpts 透传）
    writeFileSync(join(dir, "src/leak.mjs"), `const tok = '${"ghp_" + "x".repeat(36)}'\n`)
    gitCommitFast(dir, "add finding", { files: ["src/leak.mjs"], name: "alice", email: "alice@example.com" })
    const logGovPos = join(sb, "gov-pos.log")
    const govPos = runAbs("kit/skills/dev-govern/scripts/govern-audit.mjs", ["issues", dir, "--apply-issues", "--json"], { cwd: dir, env: childEnv(true, logGovPos), windowsHide: true })
    const govPosJson = govPos.status === 0 ? JSON.parse(govPos.stdout) : null
    if (!govPosJson?.applyResult?.applied?.length || !readFileSync(logGovPos, "utf8").includes("issue create")) {
      return `govern-audit issues 正向未走 gh-cli 建单：status=${govPos.status}, out=${govPos.stdout}, err=${govPos.stderr}`
    }
    const logGovNeg = join(sb, "gov-neg.log")
    const govNeg = runAbs("kit/skills/dev-govern/scripts/govern-audit.mjs", ["issues", dir, "--apply-issues", "--json"], { cwd: dir, env: childEnv(false, logGovNeg), windowsHide: true })
    if (govNeg.status === 0 || !/gh.*CLI|GitHub token/i.test(govNeg.stderr)) {
      return `govern-audit issues 反向未返回 gh CLI / GitHub token 错误：status=${govNeg.status}, err=${govNeg.stderr}`
    }
    let forwarded = false
    const origOut = process.stdout.write.bind(process.stdout)
    process.stdout.write = () => true
    let rtCode = 1
    try {
      rtCode = await runGovernCli(["issues", dir, "--apply-issues", "--json"], {
        _ghProbe: { env: { providerId: "github", trackB: { tier: "gh-cli" } }, client: { tier: "gh-cli", createIssue: async () => { forwarded = true; return { ok: true, number: 1, url: "u" } } } },
      })
    } finally {
      process.stdout.write = origOut
    }
    if (rtCode !== 0 || !forwarded) return `govern-audit main/runCli 未透传 runtimeOpts._ghProbe：code=${rtCode}, forwarded=${forwarded}`

    return true
  } finally {
    rmTree(dir)
    rmTree(sb)
  }
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

cases.push(["子进程 stdio 流错误与早期关闭不崩溃", async () => {
  const { EventEmitter } = await import("node:events")
  const { attachChildStreamErrorGuards, execSafe, execShellCommand } = await import("../../kit/skills/lib/exec.mjs")

  const fakeChild = { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() }
  attachChildStreamErrorGuards(fakeChild)
  for (const name of ["stdin", "stdout", "stderr"]) {
    if (fakeChild[name].listenerCount("error") < 1) return `未挂载 ${name} error 监听器`
    fakeChild[name].emit("error", Object.assign(new Error("read ENOTCONN"), { code: "ENOTCONN" }))
  }
  attachChildStreamErrorGuards(null)
  attachChildStreamErrorGuards({ stdin: null, stdout: new EventEmitter(), stderr: null })

  const r1 = await execSafe(process.execPath, ["-e", "process.stdout.destroy();process.stderr.destroy();"], { input: "x".repeat(512), cwd: process.cwd(), timeout: 5000 })
  if (r1.timedOut) return "execSafe 早期销毁 stdio 后超时"

  const r2 = await execShellCommand(`${JSON.stringify(process.execPath)} -e "process.stdout.destroy();process.stderr.destroy();"`, process.cwd(), { timeoutMs: 5000 })
  if (r2.timedOut) return "execShellCommand 早期销毁 stdio 后超时"

  return true
}])
}
