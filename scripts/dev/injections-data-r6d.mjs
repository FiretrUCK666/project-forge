/**
 * injections-data-r6d.mjs —— R6D 默认分支收口、CLI 契约对拍、权威指针与 A1/A2/A3 规则防回归故障注入数据。
 */

export const INJECTIONS_R6D_CONTRACTS = [
  {
    id: 'I630',
    what: '向 kit/skills/dev-review/SKILL.md 注回幽灵参数 --target <path>',
    file: 'kit/skills/dev-review/SKILL.md',
    alsoDropIn: ['.agents/skills/dev-review/SKILL.md'],
    from: 'check-empirical (--task <id> | --pr <M> | --local | --staged | --base <ref>)',
    to: 'check-empirical (--task <id> | --pr <M> | --local | --staged | --base <ref>) [--target <path>]',
    runner: 'preflight',
    expect: '--target',
  },
  {
    id: 'I631',
    what: '从 kit/skills/dev-flow/SKILL.md cleanup --confirm 删掉必填 --preview-hash <hash>',
    file: 'kit/skills/dev-flow/SKILL.md',
    alsoDropIn: ['.agents/skills/dev-flow/SKILL.md'],
    from: 'node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --confirm --preview-hash <hash>',
    to: 'node ".agents/skills/dev-flow/scripts/flow.mjs" cleanup --confirm',
    runner: 'preflight',
    expect: '缺少必填参数',
  },
  {
    id: 'I632',
    what: '破坏 SKILL.md 指向 references/collaboration.md「八、谁能合」的权威指针',
    file: 'SKILL.md',
    from: '`references/collaboration.md`「八、谁能合」「九、合并：收尾七步」',
    to: '（已移除权威协作指针）',
    runner: 'preflight',
    expect: '缺少指向',
  },
  {
    id: 'I633',
    what: '将 doc-plan-ops.mjs initDoc 默认分支判定退化回写死 main/master',
    file: 'kit/skills/dev-plan/scripts/doc-plan-ops.mjs',
    alsoDropIn: ['.agents/skills/dev-plan/scripts/doc-plan-ops.mjs'],
    from: '    if (curBranch && await isDefaultBranch(mainRoot, curBranch)) {',
    to: "    if (curBranch === 'main' || curBranch === 'master') {",
    expect: 'R6D-C13: 剩余 4 处非 main/master 默认分支',
  },
  {
    id: 'I634',
    what: '破坏 references/docs-set.md A1 口径回退为非平凡 todo 强制 Critique',
    file: 'references/docs-set.md',
    from: '自净化直通（Critique 仅建议不强制）',
    to: '非平凡 todo 强制独立 Critique',
    expect: 'R6D-C15: A1/A2/A3',
  },
]
