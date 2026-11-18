/**
 * injections-data.mjs —— 故障注入复验数据表（供 verify-injections.mjs 并行隔离注入）。
 */

import { INJECTIONS_CORE } from './injections-data-core.mjs'
import { INJECTIONS_WORKFLOW } from './injections-data-workflow.mjs'
import { INJECTIONS_GATES } from './injections-data-gates.mjs'
import { INJECTIONS_STAGEB } from './injections-data-stageb.mjs'

/** 每条注入：改哪个文件、把什么换成什么、期望哪条断言变红。 */
export const INJECTIONS = [
  ...INJECTIONS_CORE,
  ...INJECTIONS_WORKFLOW,
  ...INJECTIONS_GATES,
  ...INJECTIONS_STAGEB,
]
