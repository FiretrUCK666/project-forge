/**
 * artifact-executors.mjs —— 「产物计划说要建」与「真的有东西会去建」之间那张对照表。
 *
 * ## 它治的病
 *
 * `survey` 会产出 `artifactPlan`，其中每一项带 `action`：`create` 表示「这东西缺，该建」。
 * 但**没有任何东西检查「该建」之后由谁建**。
 *
 * 实测形状：一个正常的 Node 仓，计划里报 `agents-contract`、`releasing`、`ci-check` 三项
 * `create`。前两项有明确落点（`compose-agents`、人写发版说明），`ci-check` 却没有任何
 * 执行入口——模板 `templates/ci-check.yml` 在仓库里躺着，没有被任何脚本读取，
 * 于是「计划说了要建 CI」可以永远停留在计划状态，而门禁是绿的。
 *
 * ## 判据：每个 `create` 必须指名一个执行者
 *
 * 表的键是 `artifactPlan` 的 `id`，值是「谁来做 + 怎么做 + 需要人点头吗」。
 * 缺一项即门禁红——**「该建但没人建」必须响，不能靠谁想起来。**
 *
 * `mode` 三档：
 *   - `auto`：工具可以直接落盘（有现成命令）;
 *   - `assisted`：工具给骨架，内容要人或 AI 填（半自动）;
 *   - `manual`：只能人或 AI 原创，工具最多给清单。
 *
 * 三档都必须写清 `command` 或 `how`——**「由人来做」不等于「没人负责」**，
 * 它也要说出从哪儿开始。
 */

/**
 * 执行者对照表。
 *
 * 加一个新产物类型 = 加一行；判据不用改。这是「写原则，不写死」的落地：
 * 换项目、换生态，表不用重写，因为每一项都是「怎么做到」的通则，不是某个文件的具体内容。
 */
export const ARTIFACT_EXECUTORS = Object.freeze({
  'pre-backup': {
    mode: 'auto',
    command: 'node scripts/backup.mjs create <目录> --label pre-forge',
    how: '写任何治理文件之前先打仓外快照',
  },
  'git-baseline': {
    mode: 'auto',
    command: 'node scripts/equip.mjs <目录>',
    how: '补齐 .gitattributes / .gitignore 并初始化仓库',
  },
  'docs-tdd': {
    mode: 'assisted',
    command: 'node scripts/equip.mjs <目录> --bootstrap-empty',
    how: '空白仓由初始化落盘骨架；存量仓由 dev-govern 报出该补哪些模块，人落笔',
  },
  'agents-contract': {
    mode: 'auto',
    command: 'node scripts/compose-agents.mjs <目录>',
    how: '按勘察事实生成受管区间，再填实剩余空白位',
  },
  'readme': {
    mode: 'manual',
    how: '基于真实入口与探测到的命令编写；不编造运行环境要求与假徽章',
  },
  'releasing': {
    mode: 'manual',
    how: '按实测的发版命令与版本节点写；模板见 templates/releasing.md',
  },
  'ci-check': {
    mode: 'auto',
    command: 'node scripts/equip-ci.mjs <目录> --kind check',
    how: '从 templates/ci-check.yml 生成，取值按勘察事实替换',
  },
  'ci-release': {
    mode: 'auto',
    command: 'node scripts/equip-ci.mjs <目录> --kind release',
    how: '从 templates/ci-release.yml 生成，非 GitHub 远端直接退出并说明原因',
  },
  'docs-set': {
    mode: 'assisted',
    command: 'node .agents/skills/dev-plan/scripts/doc-plan.mjs init --kind pair --slug <slug> --title <标题>',
    how: '按统一模板生成，再按五档分流补齐 C1..Cn',
  },
  'skills-kit': {
    mode: 'auto',
    command: 'node scripts/equip.mjs <目录>',
    how: '把 kit/skills/ 同步进 .agents/skills/ 并写清单校验',
  },
})

/**
 * 找出「计划说要建、但没人负责建」的项。
 *
 * 只查 `action === 'create'`：`calibrate` 已经有东西可校准（文件在），`preserve` 不动，
 * `ask-human` 本来就等人，`skip` 与 `snapshot` 都不产生产物内容。
 *
 * 返回空数组表示每一项都有人接。
 */
export function findUnexecutableArtifacts(artifactPlan = []) {
  const out = []
  for (const item of artifactPlan) {
    if (item?.action !== 'create') continue
    const id = item.id
    if (!id) {
      out.push({
        code: 'ARTIFACT_WITHOUT_ID',
        id: null,
        artifact: item.artifact ?? '(未命名)',
        message: `产物计划里有一项要建却没有 id：「${item.artifact ?? '(未命名)'}」——`
          + '没有 id 就无法对到执行者，这一项永远只会停在计划里',
      })
      continue
    }
    const executor = ARTIFACT_EXECUTORS[id]
    if (!executor) {
      out.push({
        code: 'ARTIFACT_WITHOUT_EXECUTOR',
        id,
        artifact: item.artifact ?? id,
        message: `产物计划说「${item.artifact ?? id}」该建（action=create），但对照表里没有它的执行者`
          + '——没人负责建的东西，永远建不出来。补一行 ARTIFACT_EXECUTORS，或把这一项改成 ask-human。',
      })
      continue
    }
    // 「由人来做」也得说从哪儿开始，不然等同于没人负责。
    if (executor.mode === 'manual' && !executor.how) {
      out.push({
        code: 'ARTIFACT_EXECUTOR_UNDESCRIBED',
        id,
        artifact: item.artifact ?? id,
        message: `产物计划里「${item.artifact ?? id}」标为人工执行，却没写从哪儿开始——`
          + '「由人来做」不等于「没人负责」，它也要说清第一步做什么。',
      })
    }
  }
  return out
}
