/**
 * subcommand-meta.mjs —— 6 套核心 CLI 入口子命令元数据单一真源（{ name, mutating }）。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供各技能 CLI、doc-verify、triage-rules
 * 与开发期子命令对拍门禁共同消费，彻底消除多点重复维护导致的漂移。
 */

const entry = (name, mutating) => Object.freeze({ name, mutating: Boolean(mutating) })

export const SUBCOMMAND_META = Object.freeze({
  flow: Object.freeze({
    file: 'kit/skills/dev-flow/scripts/flow.mjs',
    subcommands: Object.freeze([
      entry('inspect', false),
      entry('next', false),
      entry('explore', true),
      entry('intake', true),
      entry('start', true),
      entry('promote', true),
      entry('issue', true),
      entry('close', true),
      entry('milestone', true),
      entry('claim', true),
      entry('release', true),
      entry('finalize', true),
      entry('verify', true),
      entry('submit', true),
      entry('rework', true),
      entry('sync', true),
      entry('merge', true),
      entry('cleanup', true),
      entry('status', false),
      entry('abort', true),
      entry('batch', true),
    ]),
  }),
  'doc-plan': Object.freeze({
    file: 'kit/skills/dev-plan/scripts/doc-plan.mjs',
    subcommands: Object.freeze([
      entry('next', false),
      entry('note', true),
      entry('brief', true),
      entry('triage', false),
      entry('init', true),
      entry('slice', true),
      entry('clarify', true),
      entry('link', true),
      entry('audit', false),
      entry('critique-scope', false),
      entry('critique-pass', true),
      entry('critique-reject', true),
      entry('critique-continue', true),
      entry('critique-override', true),
      entry('approve', true),
      entry('archive', true),
      entry('supersede', true),
      entry('list', false),
    ]),
  }),
  'govern-audit': Object.freeze({
    file: 'kit/skills/dev-govern/scripts/govern-audit.mjs',
    subcommands: Object.freeze([
      entry('audit', false),
      entry('reconcile', false),
      entry('plan', false),
      entry('issues', false),
      entry('record', true),
      entry('cluster', false),
      entry('sample', false),
      entry('retro', true),
      entry('release-prep', false),
    ]),
  }),
  'review-pack': Object.freeze({
    file: 'kit/skills/dev-review/scripts/review-pack.mjs',
    subcommands: Object.freeze([
      entry('pack', false),
      entry('record', true),
      entry('override', true),
      entry('check-empirical', true),
      entry('check-fault', true),
    ]),
  }),
  'verify-tools': Object.freeze({
    file: 'kit/skills/dev-verify-tools/scripts/verify-tools.mjs',
    subcommands: Object.freeze([
      entry('sync', true),
      entry('create', true),
      entry('run', true),
      entry('audit', false),
      entry('clean', true),
      entry('render', true),
    ]),
  }),
  iterate: Object.freeze({
    file: 'kit/skills/dev-iterate/scripts/iterate.mjs',
    subcommands: Object.freeze([
      entry('plan', false),
      entry('generate', true),
      entry('run', true),
      entry('cycle', true),
    ]),
  }),
})

/** 返回指定工具的全部子命令名列表（不可变新数组）。 */
export function subcommandNamesFor(toolKey) {
  const meta = SUBCOMMAND_META[toolKey]
  if (!meta) throw new Error(`Unknown tool key in SUBCOMMAND_META: ${toolKey}`)
  return meta.subcommands.map((item) => item.name)
}

/** 返回指定工具全部会写入或变更状态的子命令名列表。 */
export function mutatingSubcommandsFor(toolKey) {
  const meta = SUBCOMMAND_META[toolKey]
  if (!meta) throw new Error(`Unknown tool key in SUBCOMMAND_META: ${toolKey}`)
  return meta.subcommands.filter((item) => item.mutating).map((item) => item.name)
}

/** 返回全部 6 套工具去重后的子命令全集（按首次出现顺序）。 */
export function allSubcommandNames() {
  const seen = new Set()
  const out = []
  for (const meta of Object.values(SUBCOMMAND_META)) {
    for (const item of meta.subcommands) {
      if (!seen.has(item.name)) {
        seen.add(item.name)
        out.push(item.name)
      }
    }
  }
  return out
}
