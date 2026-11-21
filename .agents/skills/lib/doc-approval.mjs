/**
 * doc-approval.mjs —— 「什么状态算已批准」与「谁在这份文档上有话语权」的唯一取值处。
 *
 * 两件事放在一起，因为它们判的是同一件事实的两面：一份文档「生效」由状态与批准标记
 * 共同表达，而「谁说了算」决定这个人能不能以复核人身份再出现。两处各写一份取值，
 * 迟早出现「状态说已回退、批准仍为真」以及「原负责人换个身份回来给自己放行」。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块）。
 */

/** 历史负责人集合的字段名。自审判定按「历史 ∪ 当前」比对，不只看当前字段。 */
export const PREVIOUS_OWNERS_KEY = 'previous_owners'

/**
 * 各文档类型里「已批准」的档位。
 *
 * 不在这个集合里的档位一旦写进去，批准标记必须同批置假：否则「回退到草稿、批准仍为真」，
 * 而分诊豁免只看那个标记——回退之后文档继续享受「已核准内部规划」的豁免。
 */
export const APPROVING_STATUS = Object.freeze({
  prd: new Set(['active']),
  spec: new Set(['approved', 'implementing']),
  todo: new Set(['active']),
})

function normStatus(value) {
  return String(value ?? '').trim().toLowerCase()
}

/** 给定的状态是不是该类型的「已批准」档位。 */
export function isApprovingStatus(kind, status) {
  const set = APPROVING_STATUS[kind]
  return Boolean(set) && set.has(normStatus(status))
}

/**
 * 给定的状态值是否属于任何一种文档的「已批准」档位（与具体类型无关）。
 *
 * 生命周期同步拿到的是裸状态值、还不知道要写进哪种文档，所以先按值拦一次：
 * 任何批准档位都不许由 `link` 写入，批准只有 `approve` 一个入口。
 */
export function isApprovingStatusValue(status) {
  const st = normStatus(status)
  return Object.values(APPROVING_STATUS).some((set) => set.has(st))
}

/** 归一化参与人标识（去前导 `@`、小写）。 */
export function normOwnerId(value) {
  return String(value ?? '').trim().replace(/^@/, '').toLowerCase()
}

/**
 * 历史负责人集合 ∪ 当前负责人（去重保序）。
 *
 * 只看当前 `owner` 是不够的：负责人可以被一次性改写，改写之后原负责人以复核人身份
 * 执行评审仍会被放行——而他写的稿子还在那里。所以三处自审判定都按这份集合比对。
 */
export function collectOwnerHistory(fmData) {
  const out = []
  const seen = new Set()
  const push = (v) => {
    const s = String(v ?? '').trim()
    if (!s || s === 'null') return
    const key = normOwnerId(s)
    if (!key || seen.has(key)) return
    seen.add(key)
    out.push(s)
  }
  push(fmData?.owner)
  const prev = fmData?.[PREVIOUS_OWNERS_KEY]
  if (Array.isArray(prev)) for (const p of prev) push(p)
  else if (typeof prev === 'string') for (const p of prev.split(',')) push(p)
  return out
}
