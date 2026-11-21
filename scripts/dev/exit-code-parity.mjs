/**
 * exit-code-parity.mjs —— 阻断码与退出码档位的对拍。
 *
 * ## 它治的是什么
 *
 * 登记表说「这个码是事实档（3）」，代码实际返回的却是用法档（2）。两边都写得很整齐，
 * 没有任何东西会发现它们不一致——**直到有人照登记表去处理，做了一件本来不用做的事**。
 *
 * 这正是「登记表与实现脱节」这一类病：表看起来是权威，实际没人核。所以这里核三件事：
 *
 * 1. **每个带档位的阻断码都必须在册**。新增一个码却查不到档位，直接红——
 *    否则「未登记」这件事会一直藏在默认值里；
 * 2. **在册档位必须与返回处一致**。登记 3 而返回 2，同样红；
 * 3. **同一个码不许对应两个档位**。一个码只能表达一种情形；两种情形共用，
 *    读的人分不清该改命令还是该去找人。
 *
 * 三条都靠扫描源码得出，不靠人工维护第二份清单：第二份清单会和第一份一起过期。
 *
 * ## 覆盖边界（必须一起报，不能被读成「全部核过了」）
 *
 * 配对要求 `code` 与 `exitCode` 出现在同一个返回对象里。这条规则之外的情形有三类：
 *
 * 1. **`code` 只是标签**：函数只返回判定结果，退出码由调用方决定
 *    （例如 `evidence-substance.mjs` 的 `BLOCKED_SHALLOW_EVIDENCE`）。
 *    这类码在本条判据的视野之外——它的档位取决于「谁在调、当放行点还是当校验点」。
 * 2. **提示类**（`WARN_` / `ADVISORY_` / `SUGGEST_`）：本就不阻断，无档可定。
 * 3. **委派类**（`ACTION_REQUIRED_`）：语义是「这件事交给别人做」，退出码由出口处给。
 *
 * 所以本模块能保证的是「**配得上的**都一致」，不是「全部码都一致」。
 * 覆盖率随结果一起返回，让读的人知道这条判据管到哪为止。
 */

/** 档位字面量到数字的映射。扫描时只认这四个常量名。 */
const TIER_BY_CONST = Object.freeze({
  'EXIT.OK': 0,
  'EXIT.ACTION': 1,
  'EXIT.USAGE': 2,
  'EXIT.FACT': 3,
  'EXIT.HUMAN': 4,
})

const CODE_RE = /\bcode:\s*'([A-Z][A-Z0-9_]{3,})'/g
const EXIT_RE = /\bexitCode:\s*(EXIT\.[A-Z]+)/g
const PLAN_ERR_RE = /makePlanError\(\s*'([A-Z][A-Z0-9_]{3,})'\s*,\s*(EXIT\.[A-Z]+)/g

/**
 * 从一份源码里抽出「码 → 返回档位」的配对。
 *
 * 配对规则是结构性的，不靠距离猜：两半必须在**同一个对象字面量**里，中间不许夹
 * 花括号或分号，也不许夹另一个 `code:`。按这条规则，跨行书写的返回对象能配上；
 * 而 `exitCode` 来自变量（不是字面量档位）的情形自然配不上——它本来就不该在这里判。
 *
 * @returns {Array<{ code: string, tier: number, line: number, raw: string }>}
 */
export function extractEmittedPairs(text) {
  const source = String(text ?? '')
  const lineOf = (index) => source.slice(0, index).split('\n').length

  const codes = [...source.matchAll(CODE_RE)].map((m) => ({ code: m[1], at: m.index }))
  const exits = [...source.matchAll(EXIT_RE)]
    .map((m) => ({ tier: TIER_BY_CONST[m[1]], raw: m[1], at: m.index }))
    .filter((e) => e.tier !== undefined)

  const out = []
  for (const c of codes) {
    const partner = exits
      .map((e) => ({ e, lo: Math.min(e.at, c.at), hi: Math.max(e.at, c.at) }))
      .filter(({ lo, hi }) => {
        const between = source.slice(lo, hi)
        if (/[{};]/.test(between)) return false
        if (codes.some((o) => o.at !== c.at && o.at > lo && o.at < hi)) return false
        return true
      })
      .sort((a, b) => (a.hi - a.lo) - (b.hi - b.lo))[0]
    if (!partner) continue
    out.push({ code: c.code, tier: partner.e.tier, line: lineOf(c.at), raw: partner.e.raw })
  }

  for (const m of source.matchAll(PLAN_ERR_RE)) {
    const tier = TIER_BY_CONST[m[2]]
    if (tier === undefined) continue
    out.push({ code: m[1], tier, line: lineOf(m.index), raw: m[2] })
  }
  return out
}

/**
 * 把「配不上档位」的字面量按原因分类。
 *
 * 三类原因指向三种完全不同的处置：提示类不用管、委派类出口在别处、
 * 标签类取决于调用方。合成一个「未覆盖」数字，读的人没法判断要不要动手。
 */
function classifyUnpaired(sources) {
  const kinds = { label: new Set(), advisory: new Set(), delegated: new Set() }
  for (const { file, text } of sources) {
    if (isTestVector(file)) continue
    const source = String(text ?? '')
    const pairedCodes = new Set(extractEmittedPairs(source).map((p) => p.code))
    for (const m of source.matchAll(CODE_RE)) {
      const code = m[1]
      if (pairedCodes.has(code)) continue
      if (/^(?:WARN|ADVISORY|SUGGEST)_/.test(code)) kinds.advisory.add(code)
      else if (/^ACTION_REQUIRED_|_DELEGATED$/.test(code)) kinds.delegated.add(code)
      else kinds.label.add(code)
    }
  }
  return {
    label: [...kinds.label].sort(),
    advisory: [...kinds.advisory].sort(),
    delegated: [...kinds.delegated].sort(),
  }
}

/**
 * 对拍「登记表 vs 实际返回」。
 *
 * @param {Array<{file:string,text:string}>} sources
 * @param {(code: string) => number|null} lookup  登记表查询；返回 `null` 视为未登记
 * @returns {{ ok: boolean, failures: string[], checked: number, codes: number, coverage: {literals:number, paired:number, unpaired:number} }}
 */
/**
 * 测试向量不算实现。
 *
 * 夹具里必须故意写出「错误的档位搭配」才能证明判据抓得住它；把这些字符串也拿去对拍，
 * 只会逼着夹具给自己开口子——那正是「为过检查而改检查」。所以按文件名排除夹具与注入表，
 * 这是一条结构规则（这一层不是产品代码），不是逐条豁免。
 */
const TEST_VECTOR_RE = /(?:^|\/)(?:fixtures-|injections-)[^/]*\.mjs$/

export function isTestVector(file) {
  return TEST_VECTOR_RE.test(String(file ?? ''))
}

export function evaluateExitCodeParity(sources, lookup) {
  const failures = []
  const seen = new Map()
  let checked = 0
  let literals = 0

  for (const { file, text } of sources) {
    if (isTestVector(file)) continue
    // 所有 `code:` 字面量都数一遍，不管配没配上档位——覆盖率要能被看见。
    literals += [...String(text).matchAll(CODE_RE)].length
    for (const pair of extractEmittedPairs(text)) {
      checked += 1
      const registered = lookup(pair.code)
      if (registered === null) {
        failures.push(`${file}:${pair.line} 的阻断码 ${pair.code} 未在 exit-codes 里登记档位——`
          + '没登记的码拿不到确定档位，调用方只能猜该改命令还是该去补前置事实')
        continue
      }
      if (registered !== pair.tier) {
        failures.push(`${file}:${pair.line} 的 ${pair.code} 实际返回 ${pair.tier} 档，登记表写的是 ${registered} 档——`
          + '两边不一致时，照登记表去处理的人会做错事')
      }
      if (!seen.has(pair.code)) seen.set(pair.code, new Set())
      seen.get(pair.code).add(pair.tier)
    }
  }

  for (const [code, tiers] of seen) {
    if (tiers.size > 1) {
      failures.push(`${code} 在不同返回处用了 ${[...tiers].sort().join('/')} 两个档位——`
        + '一个码只能对应一种情形；两种情形共用同一个码，读的人分不清该改命令还是该找人')
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    checked,
    codes: seen.size,
    // paired 是真正核过的；unpaired 按原因分开，别让「判不了」与「不用判」混成一个数。
    coverage: {
      literals,
      paired: checked,
      unpaired: Math.max(0, literals - checked),
      byKind: classifyUnpaired(sources),
    },
  }
}
