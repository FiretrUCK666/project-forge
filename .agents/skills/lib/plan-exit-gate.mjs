/**
 * plan-exit-gate.mjs —— 规划退场硬门禁：没有过审的规划，不许开工。
 *
 * ## 它治的是什么
 *
 * `dev-plan` 早就写着「待拍板事项清零、SPEC 经 Critique 后 `approve` 才能进实现」，
 * 但这条规矩只存在于文档里。于是「先开工作位再说」「边做边拍」永远跑得比规划快一步，
 * 而**带着未拍板的问号开工，出错要到很久以后才暴露**——那时改的是别人已经依赖的东西。
 *
 * 本模块把这条规矩变成 `flow.mjs start` 前的确定性判据：读已绑定的规划文档，
 * 逐条核对「能不能退场」，不能就以退出码 `3` 拦住。
 *
 * ## 为什么是一个独立模块
 *
 * `dev-plan`（规划侧自审）与 `dev-flow`（开工侧门禁）都要用同一套判据。写在任一侧，
 * 另一侧就得复制一遍，两边迟早分叉；分叉之后「规划说能走、开工说不能走」就有了两个真相。
 *
 * ## 适用边界
 *
 * 三档，逐档写清，避免「处处拦」把整套流程拦死：
 *
 * 1. **Case 1 / Case 2 / Case 5**：不适用。前两档本就不建规划文档，第五档在更早就被拦下。
 * 2. **已绑定规划文档**：硬校验。这是常态——文档写在那里了，就得是能退场的那一版。
 * 3. **一份都没绑，但仓库确实在用规划文档**：也拦。仓库有 `docs/{prd,specs,todo}` 的受管规划，
 *    这次开工却一份都没带上，说明规划被跳过了——这正是要拦的形状。
 * 4. **一份都没绑，仓库也没有任何受管规划**：不适用。还没进入规划体系的小仓或纯脚本仓，
 *    拿规划门槛拦它只会逼人关掉整套流程。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { evaluateCritiqueOverride } from './critique-rounds.mjs'
import { posixPath, readTextSafe } from './git.mjs'
import { analyzePendingDecisions, planModeErrors } from './pending-decisions.mjs'

/** 阻断码与退出码：与 `flow-inspect.mjs` 的 `EXIT_POLICY_BLOCK` 同义。 */
export const PLAN_EXIT_BLOCK_CODE = 'BLOCKED_PLAN_NOT_READY'
export const PLAN_EXIT_EXIT_CODE = 3

/** 规划退场豁免开关的 CLI 名。 */
export const PLAN_BOOTSTRAP_FLAG = 'allow-plan-bootstrap'

/**
 * 每种文档「算能退场」的状态集合。
 *
 * 取值来自各文档自己的生命周期枚举，不是另起一套：
 * - PRD 没有 `approved` 字段（模板里就没有），所以按 `status` 判——`draft` 表示还没定稿；
 * - SPEC 有 `approved` 布尔与 `status`，两者任一表明已过审即可，因为 `link --approve`
 *   只写 `status`，而 `approve` 命令同时写两个，历史文档两种写法都存在；
 * - Todo 从不要求 `approved`（模板默认 `false`），只看它没被废弃。
 */
const READY_STATUS = Object.freeze({
  prd: new Set(['active', 'in_review', 'done']),
  spec: new Set(['approved', 'implementing', 'in_review', 'implemented']),
  todo: new Set(['active', 'in_review', 'done', 'archived']),
})

/**
 * 各档位对「过审」的要求。
 *
 * 差异来自流程本身，不是这里重新发明：`Case 3` 的规矩是「建 Todo 冻结 `C1..Cn`，
 * 跑 `audit` 直通」，没有 Critique 也没有 `approve`——拿 `approved` 去卡 `L2` 会把整档卡死。
 * `Case 4` 则明确要求 SPEC 经独立 Critique 后由人 `approve`，那时 `approved` 就该是 `true`。
 */
const APPROVAL_REQUIRED = Object.freeze({ 3: false, 4: true })
/** 已作废的文档不参与判定：它们已经不代表当前规划。 */
const INERT_STATUS = new Set(['superseded', 'dropped'])

/** 内审状态里表示「还没过、过不了」的两档。 */
const UNREADY_CRITIQUE = new Set(['pending', 'rejected'])

function normalizeStatus(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/** 读一份规划文档；不存在时返回 `{ exists: false }`，不抛错——缺文档本身就是一种结论。 */
function readPlanDoc(repoRoot, rel) {
  if (!rel) return null
  const normRel = posixPath(String(rel).trim())
  if (!normRel) return null
  const abs = resolve(repoRoot, normRel)
  if (!existsSync(abs)) return { rel: normRel, abs, exists: false }
  const text = readTextSafe(abs)
  if (text === undefined) return { rel: normRel, abs, exists: false, unreadable: true }
  const fm = parseDocFrontmatter(text)
  return {
    rel: normRel,
    abs,
    exists: true,
    text,
    data: fm.data ?? {},
    hasFrontmatter: Boolean(fm.hasFrontmatter),
  }
}

/** 同一份文档可能被 spec/todo/issue 三条路径同时命中，去重后只看一次。 */
function collectBoundDocs(repoRoot, docs) {
  const seen = new Set()
  const out = []
  for (const [kind, rel] of Object.entries(docs ?? {})) {
    if (!rel) continue
    const doc = readPlanDoc(repoRoot, rel)
    if (!doc || seen.has(doc.rel)) continue
    seen.add(doc.rel)
    out.push({ kind, ...doc })
  }
  return out
}

/** 仓库里有没有受管规划文档——决定「一份都没绑」时是拦还是不拦。 */
function repoUsesPlanDocs(repoRoot) {
  return ['docs/prd', 'docs/specs', 'docs/todo'].some((dirRel) => {
    const abs = join(repoRoot, dirRel)
    if (!existsSync(abs)) return false
    return readDirMarkdownSafe(abs).length > 0
  })
}

function readDirMarkdownSafe(dirAbs) {
  try {
    return readdirSync(dirAbs, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.md'))
      .map((e) => join(dirAbs, e.name))
  } catch {
    return []
  }
}

/**
 * 内审是否「未过」——先看人类 override，再看 `plan_critique`。
 *
 * ## 为什么不能只看 `plan_critique`
 *
 * 停损之后由人签字放行（`critique-override --human-approved`），随后 `approve` 通过。
 * 但 `approveSpec` 走 override 分支时只改 `status`/`approved`，**不会改写** `plan_critique`，
 * 于是文档里仍留着 `rejected (reviewer=…, round=3, …)`。那是**当初被拒过**的历史，
 * 不是**现在仍未过审**。把两者等价，人签的字就白签了：门禁拦住已经获批的规划。
 *
 * ## 但 override 只对签字时那份正文有效
 *
 * 签字后正文再被改动，人批的就不是当前这一版了。判据是正文指纹，
 * 与 `approve` 的 `BLOCKED_CRITIQUE_STALE` 用同一个函数（`evaluateCritiqueOverride`），
 * 两处若各算一次，「approve 说有效、门禁说过期」就会同时成立。
 *
 * @param {{rel: string, text: string, data: object}} doc
 * @returns {{blocked: boolean, message: string, fixHint: string, basis: string}}
 */
export function resolveCritiqueReadiness(doc) {
  const overrideState = evaluateCritiqueOverride(doc.text ?? '', doc.data ?? {})

  if (overrideState.approved && !overrideState.stale) {
    return { blocked: false, message: '', fixHint: '', basis: 'human-override' }
  }
  if (overrideState.approved && overrideState.stale) {
    return {
      blocked: true,
      basis: 'override-stale',
      message: `在人类 critique-override 之后正文又改动了（override=${overrideState.sha} !== current=${overrideState.currentSha}），`
        + '人批的是当时那一版，不是现在这一版',
      fixHint: '要么撤销那处改动，要么重新跑 critique-override 签字；改完再走 approve。',
    }
  }

  const critique = normalizeStatus(doc.data?.plan_critique).split(/\s+/)[0]
  if (!critique || !UNREADY_CRITIQUE.has(critique)) {
    return { blocked: false, message: '', fixHint: '', basis: 'passed' }
  }
  return {
    blocked: true,
    basis: 'critique-unready',
    message: `的规划内审仍是 ${critique}（plan_critique: ${doc.data?.plan_critique}）`,
    fixHint: '内审非得是 passed 才能退场；退回的意见要改完再重审，不能带着未过审的稿子开工。'
      + '若已由人裁决放行，须先跑 critique-override --human-approved --reason "<裁决说明>"。',
  }
}

/**
 * 单份文档的退场判据。返回 `reasons` 数组，空数组即合格。
 *
 * 每条理由都写成「哪里不对 + 怎么改」，因为这道门是要给人看的：
 * 只说「规划未就绪」，人还是不知道该补什么。
 */
function evaluateDoc(doc, { requireApproval = true } = {}) {
  const reasons = []
  if (!doc.exists) {
    reasons.push({
      code: PLAN_EXIT_BLOCK_CODE,
      file: doc.rel,
      message: `${doc.rel} 不存在${doc.unreadable ? '（或不可读）' : ''}`,
      fixHint: `先用 doc-plan.mjs init 生成，或把 --${doc.kind} 指向真实存在的文件。`,
    })
    return reasons
  }

  const data = doc.data ?? {}
  const status = normalizeStatus(data.status)
  if (INERT_STATUS.has(status)) {
    reasons.push({
      code: PLAN_EXIT_BLOCK_CODE,
      file: doc.rel,
      message: `${doc.rel} 已作废（status: ${status}）`,
      fixHint: '作废的规划不能作为开工依据，请指向当前生效的那一版。',
    })
    return reasons
  }

  // 待拍板清零：两种规划态的共同下限。区别只在谁来拍板，不在要不要拍。
  const pending = analyzePendingDecisions(doc.text ?? '')
  if (pending.found && pending.unresolved.length > 0) {
    reasons.push({
      code: 'BLOCKED_PENDING_DECISIONS',
      file: doc.rel,
      line: pending.unresolved[0].line,
      message: `${doc.rel} 还有 ${pending.unresolved.length}/${pending.total} 条待拍板事项：`
        + pending.unresolved.slice(0, 3).map((u) => u.text).join('；'),
      fixHint: 'interactive 逐题问到零，autonomous 自行拍板后写进文档——两种都要落到「已定：…」。'
        + '把问号留给实现，等于让写代码的人替你拍板，而他手上没有你的上下文。',
    })
  }

  // 规划态写了非法值时，这一份文档的规划流根本无从判定。
  for (const err of planModeErrors(doc.text ?? '')) reasons.push({ ...err, file: doc.rel })

  // 过审与内审只对「流程里真有这道关口」的档位判。
  //
  // Case 3 的规矩是「建 Todo 冻结 C1..Cn，跑 audit 直通」——没有 Critique，也没有 approve，
  // 模板生成的 SPEC 就是 `status: draft` / `plan_critique: pending`。拿这两项去卡 L2，
  // 会把整个 Case 3 卡死；卡死的门禁只有一个下场：人给它加豁免，然后连该拦的也一起放过了。
  if (requireApproval) {
    const readyStatuses = READY_STATUS[doc.kind] ?? null
    const approvedFlag = data.approved === true
    if (readyStatuses && !readyStatuses.has(status) && !approvedFlag) {
      reasons.push({
        code: PLAN_EXIT_BLOCK_CODE,
        file: doc.rel,
        message: `${doc.rel} 尚未过审（status: ${status || '未声明'}，approved: ${data.approved === true}）`,
        fixHint: doc.kind === 'spec'
          ? 'Case 4 须先跑 audit、经独立 Critique 后 approve：node ".agents/skills/dev-plan/scripts/doc-plan.mjs" approve --file "<spec>"'
          : `先让它进入生效状态（${[...readyStatuses].join(' / ')}）再开工。`,
      })
    }

    // 内审是否「未过」由 `resolveCritiqueReadiness` 判：它会先看人类 override 有没有签字放行。
    // 「有过 rejected 记录」与「现在仍未过审」是两件事——把前者当后者，等于让人签的字不生效。
    const readiness = resolveCritiqueReadiness(doc)
    if (readiness.blocked) {
      reasons.push({
        code: PLAN_EXIT_BLOCK_CODE,
        file: doc.rel,
        message: `${doc.rel} ${readiness.message}`,
        fixHint: readiness.fixHint,
      })
    }
  }

  return reasons
}

/**
 * 关联总控 PRD 的退场判据。
 *
 * 只在切片 SPEC 指向的 PRD 声明了 `multi_spec: true` 时才看——单份 PRD 带单份 SPEC 时，
 * SPEC 过审就够；一旦是 1:N 拆分，总纲本身没定稿，切片就算各自过审也只是各说各话。
 */
function evaluateMasterPrd(repoRoot, specDoc, { requireApproval = true } = {}) {
  const raw = specDoc?.data?.related_prd
  if (typeof raw !== 'string' || !raw.trim() || /^(?:无|none|null)$/i.test(raw.trim())) return []
  const prdAbs = resolve(dirname(specDoc.abs), raw.trim())
  const prdRelFromRoot = posixPath(prdAbs).startsWith(posixPath(repoRoot))
    ? posixPath(prdAbs).slice(posixPath(repoRoot).length + 1)
    : posixPath(join(dirname(specDoc.rel), raw.trim()))
  const prd = readPlanDoc(repoRoot, prdRelFromRoot)
  if (!prd || !prd.exists) return []
  if (prd.data?.multi_spec !== true) return []
  return evaluateDoc({ ...prd, kind: 'prd' }, { requireApproval }).map((r) => ({
    ...r,
    message: `${r.message}（作为 ${specDoc.rel} 认领的总控 PRD）`,
  }))
}

/**
 * 规划退场门禁。
 *
 * @param {string} repoRoot 判据读取根（主仓，因为规划文档在那里才算数）
 * @param {object} opts
 * @param {number|string} opts.caseType 五档分流结论
 * @param {string|null} opts.slug 切片短名
 * @param {string|null} opts.taskId 任务编号
 * @param {number|null} opts.issue 关联 Issue
 * @param {{spec?: string, todo?: string, prd?: string}} opts.docs 已绑定的规划文档（调用方负责解析）
 * @param {boolean} opts.allowBootstrap 规划 PR 自举豁免
 * @returns {{ok: boolean, blocked: boolean, applicable: boolean, code?: string, exitCode?: number,
 *   reasons: Array<object>, checked: Array<string>, bootstrap?: boolean, wouldBlock?: boolean}}
 */
export function evaluatePlanExitGate(repoRoot, {
  caseType = null,
  slug = null,
  taskId = null,
  issue = null,
  docs = {},
  allowBootstrap = false,
  reusePrRef = false,
} = {}) {
  const num = Number(caseType)
  // 一、二档不建规划文档，第五档在更早处已被拦下——对它们判「规划是否过审」没有对象。
  if (!Number.isInteger(num) || num <= 2 || num === 5) {
    return { ok: true, blocked: false, applicable: false, reasons: [], checked: [] }
  }
  // 接管既有 PR 的工作（`--pr-ref`）：这次的规划在那边已经走过一遍了，
  // 本仓看不到也无从判定。对它拦「没绑定规划」只会逼人给一个无关的任务补一份假文档。
  if (reusePrRef) {
    return { ok: true, blocked: false, applicable: false, reasons: [], checked: [], reason: 'pr-continuation' }
  }

  const bound = collectBoundDocs(repoRoot, docs)
  const reasons = []
  const checked = bound.map((d) => d.rel)
  const requireApproval = APPROVAL_REQUIRED[num] !== false

  if (bound.length === 0) {
    // 一份规划都没绑：**不拦，但要留痕**。
    //
    // 判据只能判它拿得到的东西。这里它拿不到「这次该不该有规划」——本仓的 `dev-plan`
    // 明确支持「先 `flow.mjs start` 建工作位、再 `doc-plan.mjs init --task` 把规划单
    // 落进工作位」的顺序。按「没绑文档就拦」办，会把这条已经在用的合法顺序判死。
    //
    // 所以缺席只记一条警告，写进返回值让人看得见；「这一档到底该不该有规划」由 `triage`
    // 与 `doc-plan.mjs audit` 在更早的位置回答，那里有需求原文可读，不是靠猜。
    const gap = repoUsesPlanDocs(repoRoot)
      ? `本仓 docs/ 下已有受管规划，但这次 Case ${num} 没有绑定任何一份（任务 ${taskId ?? slug ?? '(未命名)'}）`
      : null
    return {
      ok: true,
      blocked: false,
      applicable: false,
      reasons: [],
      checked,
      ...(gap ? { warnings: [{ code: 'WARN_PLAN_NOT_BOUND', message: gap }] } : {}),
    }
  }
  for (const doc of bound) {
    reasons.push(...evaluateDoc(doc, { requireApproval }))
    if (doc.kind === 'spec' && doc.exists) reasons.push(...evaluateMasterPrd(repoRoot, doc, { requireApproval }))
  }

  if (reasons.length === 0) {
    return { ok: true, blocked: false, applicable: true, reasons: [], checked }
  }

  // 自举豁免：规划 PR 本身要在「还没有规划」的状态下开工，否则谁也开不了头。
  // 但它只放行，不隐瞒——把本该拦的理由原样带回去，方便事后核对豁免是否用得正当。
  if (allowBootstrap) {
    return {
      ok: true, blocked: false, applicable: true, reasons: [], checked,
      bootstrap: true, wouldBlock: reasons,
    }
  }

  return {
    ok: false,
    blocked: true,
    applicable: true,
    code: PLAN_EXIT_BLOCK_CODE,
    exitCode: PLAN_EXIT_EXIT_CODE,
    reasons,
    checked,
    message: `${PLAN_EXIT_BLOCK_CODE}: 规划未就绪，不能开工（${reasons[0].message}）`,
  }
}

/** 把门禁结论排成人能读的几行，供文本模式输出。 */
export function formatPlanExitGate(gate) {
  if (!gate) return []
  if (gate.blocked) {
    const lines = [`${PLAN_EXIT_BLOCK_CODE}: 规划未就绪，先补齐再开工（已检查：${gate.checked.join(', ') || '无绑定文档'}）`]
    for (const r of gate.reasons) {
      lines.push(`  - ${r.file ? `${r.file}：` : ''}${r.message}`)
      if (r.fixHint) lines.push(`    改法：${r.fixHint}`)
    }
    return lines
  }
  if (gate.bootstrap && gate.wouldBlock?.length > 0) {
    return [`规划退场门禁已被 --${PLAN_BOOTSTRAP_FLAG} 豁免（${gate.wouldBlock[0].message}）`]
  }
  return []
}
