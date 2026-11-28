/**
 * survey-gap-rules.mjs —— 勘察的缺口判据表。
 *
 * 每条缺口回答两件事：什么条件下它成立（`when`），以及它对用户意味着什么（`text`）。
 * 表本身不做判断，`survey.mjs` 的 `judgeGaps` 负责展开；`gap-coverage.mjs` 会按源码
 * 读这张表来核对「勘察报了、体检那边有没有人接」。
 *
 * 表放在单独文件里是为了让它能被照着读——一百多行规则夹在流程代码中间时，加一条
 * 新缺口要先翻过十几屏才能找到该插在哪。
 */

import { AGENTS_MANAGED_MAX_BYTES } from './protocol.mjs'

export const GAP_RULES = [
  {
    id: 'git.unavailable',
    when: (f) => f.git.available === false,
    text: '这台机器上找不到 git —— 版本管理这一整条路暂时走不了',
    machineLocal: true,
    review: 'git.unavailable',
  },
  {
    id: 'git.bare',
    when: (f) => f.git.available !== false && f.git.isBare === true,
    text: '这是一个**裸仓库**：没有工作区，改文件的地方根本不存在。要先克隆出工作区再改',
    surveyOnly: '裸仓库没有工作区，体检的「版本库就绪」那一条只看 present，判不出这一档',
  },
  {
    id: 'git.not-repo-root',
    when: (f) => f.git.available !== false && f.git.isBare !== true
      && f.git.present === true && f.git.isRepoRoot === false,
    text: (f) => `这个目录在外层仓库 \`${f.git.workTreeRoot}\` 里面，不是仓库根 —— 边界没说清之前不能提交或推送`,
    question: '这个目录该并入外层仓库，还是在这里单独建一个仓库？',
    review: 'git.nested',
  },
  {
    id: 'git.absent',
    when: (f) => f.git.available !== false && f.git.isBare !== true && f.git.present !== true,
    text: '还没有版本库',
    review: 'git.absent',
  },
  {
    id: 'git.nested-repos',
    when: (f) => (f.git.nestedRepos ?? []).length > 0,
    text: (f) => `子目录里还有独立仓库（${f.git.nestedRepos.slice(0, 3).join('、')}）—— 父目录建库会把它们变成「看着像目录、其实是独立仓库」的东西，两边的提交互不可见`,
    question: '这些子仓库该当子模块、各自独立，还是并入父仓库？三种处置互相不兼容，选错要拆历史',
    surveyOnly: '嵌套仓库要递归扫子目录才知道，体检不重扫——它读的是勘察给的 facts.git.nestedRepos',
  },
  {
    id: 'git.identity-name',
    when: (f) => f.git.present === true && !f.git.identity?.name,
    text: '提交署名缺 `user.name`',
    machineLocal: true,
    review: 'git.identity',
  },
  {
    id: 'git.identity-email',
    when: (f) => f.git.present === true && !f.git.identity?.email,
    text: '提交署名缺 `user.email`',
    machineLocal: true,
    review: 'git.identity',
  },
  {
    id: 'git.shallow',
    when: (f) => f.git.present === true && f.git.isShallow === true,
    text: '这是**浅克隆**（`--depth`）—— 扫历史找凭据会漏，而漏的方式是「看起来干净」',
    surveyOnly: '浅克隆只影响「扫历史找凭据」的完整性，体检那边由 secrets.scan-truncated 单独报「没扫全」——两处都报会让同一件事出现两条结论',
  },
  {
    id: 'ignores.output-dirs',
    when: (f) => (f.ignores.unignoredOutputDirs ?? []).length > 0,
    each: (f) => f.ignores.unignoredOutputDirs.map((dir) => ({
      text: `依赖或产物目录没有被忽略：\`${dir}\``,
    })),
    review: 'git.output-dirs',
  },
  {
    id: 'ignores.ignored-but-tracked',
    when: (f) => (f.ignores.ignoredButTracked ?? []).length > 0
      && !(f.decisions && 'ignore-tracked-legacy' in f.decisions),
    text: (f) => `有 ${f.ignores.ignoredButTracked.length} 个已入库文件同时命中忽略规则 —— 忽略规则对已入库的文件无效（若属历史遗留，可在「取舍」写 \`ignore-tracked-legacy\`）`,
    review: 'git.ignored-tracked',
  },
  {
    id: 'ignores.governance-shadowed',
    when: (f) => (f.ignores?.ignoredGovernancePaths?.length ?? 0) > 0,
    text: (f) => {
      const sample = f.ignores.ignoredGovernancePaths.slice(0, 3)
        .map((x) => `\`${x.path}\`（命中 \`${x.pattern}\`：${x.advice}）`)
        .join('；')
      return `关键治理路径被 \`.gitignore\` 规则遮蔽：${sample}`
    },
    review: 'git.ignored-governance',
  },
  {
    id: 'secrets.tracked',
    when: (f) => !(f.decisions && 'secrets-are-placeholders' in f.decisions)
      && (f.risks.secretFiles.some((x) => x.status === 'tracked')
        || f.risks.secretContent.some((c) => c.status === 'tracked')),
    text: (f) => {
      const where = [
        ...f.risks.secretFiles.filter((x) => x.status === 'tracked').map((x) => x.file),
        ...f.risks.secretContent.filter((c) => c.status === 'tracked').map((c) => `${c.file}:${c.line}`),
      ]
      return `凭据形状的东西已经在版本库里了（${where.join('、')}）—— 改文件不够，要轮换并把历史处理掉`
    },
    review: 'secrets.tracked',
  },
  {
    id: 'secrets.exposed',
    when: (f) => !(f.decisions && 'secrets-are-placeholders' in f.decisions)
      && f.risks.secretFiles.some((x) => x.status === 'exposed'),
    text: (f) => `有未忽略的敏感文件：${f.risks.secretFiles.filter((x) => x.status === 'exposed').map((x) => x.file).join('、')}`,
    review: 'secrets.exposed',
  },
  {
    id: 'docs.readme',
    when: (f) => !f.docs.readme,
    text: '没有 README —— 别人打开仓库第一眼没有说明',
    review: 'docs.readme',
  },
  {
    id: 'docs.agents',
    when: (f) => !f.docs.agents && f.scale.effectiveFiles > 0,
    text: '没有 AGENTS.md —— AI 每次新开会话都要重新摸一遍这个项目，摸出来的结论每次可能不同',
    review: 'agents.absent',
  },
  {
    id: 'ignores.gitattributes',
    when: (f) => f.git.present === true && !f.ignores.hasGitattributes && (f.git.trackedFiles ?? 0) > 0,
    text: '没有 `.gitattributes` —— 跨平台协作时同一份文件在两台机器上算出不同的字节，而已经入库的文件要重新规范化',
    review: 'git.gitattributes',
  },
  {
    id: 'docs.license-publishable',
    when: (f) => !f.docs.license && f.ecosystem.publishable === true,
    text: '清单声明了可发布的包，却没有 LICENSE —— 下游的合规检查会因为「授权不明」拒绝使用',
    review: 'license.publishable',
  },
  {
    id: 'ci.pull-request-target',
    when: (f) => (f.docs.workflowFacts?.unsafePullRequestTargetWorkflows?.length ?? 0) > 0
      || (f.docs.workflowFacts?.usesPullRequestTarget === true && f.docs.workflowFacts?.checkoutsPrHead === true),
    text: '工作流用了 `pull_request_target` 又检出了提案那边的代码 —— 这等于让任意陌生人拿你的密钥跑他的代码',
    review: 'ci.pwn-request',
  },
  {
    id: 'docs.agents-oversize',
    when: (f) => (f.docs.agentsManagedBytes ?? 0) > AGENTS_MANAGED_MAX_BYTES,
    text: (f) => `AGENTS.md 受管区体积超过 ${AGENTS_MANAGED_MAX_BYTES} 字节上限（当前受管区 ${f.docs.agentsManagedBytes} 字节，总计 ${f.docs.agentsBytes ?? f.docs.agentsManagedBytes} 字节）—— 请将长篇设计与实施细节外置到 docs/TDD.md`,
    review: 'agents.oversize',
  },
  {
    id: 'git.hooks',
    when: (f) => f.git.available !== false
      && f.git.isBare !== true
      && f.git.present === true
      && f.git.isRepoRoot !== false
      && f.git.hooks?.installed !== true
      && f.git.hooks?.hasConflict !== true
      && !(f.decisions && 'no-git-hooks' in f.decisions),
    text: '尚未启用跨宿主本地 .githooks/pre-push 防直推护栏（opt-in，运行 `equip.mjs --with-hooks` 安装，或在「取舍」写 `no-git-hooks`）',
    machineLocal: true,
    review: 'git.hooks',
  },
  {
    id: 'kit.drifted',
    when: (f) => f.kit?.manifestExists === true
      && (f.kit?.corrupted === true || (f.kit?.missingFiles?.length ?? 0) > 0),
    text: '受管 .agents/skills/ 清单损坏或存在未登记墓碑的缺失文件 —— 运行 equip.mjs 将登记 v3 删除墓碑（不写回用户删掉的文件）；清单损坏需修复，未经人点头严禁自动执行 --restore',
    review: 'kit.drifted',
  },
  {
    id: 'docs.architecture-map-drift',
    when: (f) => Boolean(f.docs?.featureMap)
      && !(f.decisions && 'no-architecture-html' in f.decisions)
      && Boolean(f.docs?.architectureMap)
      && f.docs?.architectureMapSync?.ok === false,
    text: '`docs/architecture-map.html` 与 `docs/feature-map.json` 存在漂移或签名不匹配 —— 运行 `verify-tools.mjs render` 重新生成（或在「取舍」写 `no-architecture-html`）',
    review: 'docs.architecture-map',
  },
]

