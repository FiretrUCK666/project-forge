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
 * 3. **一份都没绑，仓库确实在用规划文档**：**放行但记 `WARN_PLAN_NOT_BOUND`**。
 *    不拦的理由是本仓的流程本来就允许「先 `flow.mjs start`，再 `doc-plan.mjs init --task`」
 *    这个顺序（`init` 的 `--task` 参数就是为它准备的）。一份都没绑时无从判断「规划被跳过了」
 *    还是「规划马上要写」，按拦死处理会把这条合法路径判死；判死之后人只会去加豁免，
 *    然后连该拦的也一起放过。所以这里出声警告、把判断留给`audit`与审查。
 * 4. **一份都没绑，仓库也没有任何受管规划**：不适用。还没进入规划体系的小仓或纯脚本仓，
 *    拿规划门槛拦它只会逼人关掉整套流程。
 */

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { parseDocFrontmatter } from './doc-frontmatter.mjs'
import { critiqueTextFingerprint, evaluateCritiqueOverride, parseCritiqueStamp, readPlanCritiqueEntrySync } from './critique-rounds.mjs'
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

function normalizeStatus(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

function isArchivedFinalizedPrd(doc) {
  return posixPath(String(doc?.rel ?? '')).toLowerCase().startsWith('docs/archive/prd/')
    && normalizeStatus(doc?.data?.status) === 'done'
}

function isArchivedFinalizedSpec(doc) {
  return posixPath(String(doc?.rel ?? '')).toLowerCase().startsWith('docs/archive/specs/')
    && normalizeStatus(doc?.data?.status) === 'implemented'
    && doc?.data?.approved === true
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
 * 「这条批准凭什么成立」的全部合法取值。
 *
 * 只列真有依据的三种，另加几个描述「为什么不成立」的档：判据要能说清缺什么。
 */
export const APPROVAL_BASIS = Object.freeze({
  PASSED: 'passed',
  SKIPPED: 'skipped',
  HUMAN_OVERRIDE: 'human-override',
  CRITIQUE_STALE: 'critique-stale',
  CRITIQUE_UNREADY: 'critique-unready',
  OVERRIDE_STALE: 'override-stale',
  MISSING: 'missing',
  NOT_APPLICABLE: 'not-applicable',
})

/** 跳过评审的理由至少要有这么多字符，少于它就是占位词而不是理由。 */
const SKIPPED_REASON_MIN_CHARS = 6

/** 从 `skipped (reason=…)` 里取出理由原文；没有理由返回空串。 */
function skippedReasonOf(stamp) {
  const m = /reason=([^)]*)/i.exec(String(stamp ?? ''))
  return m ? m[1].replace(/^\s*["'`]|["'`]\s*$/g, '').trim() : ''
}

/** 文档类型到「这里到底有没有批准这道关口」的映射，理由见本函数体。 */
function approvalAppliesTo(docType) {
  // `todo` 档不适用，理由必须写死在代码里而不是散在文档里：
  //
  // `Case 3` 的规矩是「建 Todo 冻结 `C1..Cn`、跑 `audit` 直通」——整条流程里
  // 既没有独立 Critique，也没有 `approve` 动作。拿「批准依据」去卡它，等于要求
  // 一件流程里根本不存在的事，会把整档卡死。卡死的门禁只有一个下场：人给它加
  // 豁免，然后连该拦的一起放过。所以这里按**类型**判「不适用」，不是靠豁免。
  //
  // `spec` 与 `prd` 适用：`Case 4` 明写要求这两档经独立 Critique 后由人 `approve`。
  return docType === 'spec' || docType === 'prd'
}

/**
 * 从文档路径推断类型；推断不出来返回空串。
 *
 * 适用性按类型判，而调用方未必都带着类型：有的只给 `rel`。按约定目录推断
 * 是同一份事实的另一种拿法，不另立判据。
 */
function inferDocTypeOf(doc) {
  const explicit = normalizeStatus(doc?.docType ?? doc?.kind ?? '')
  if (explicit) return explicit
  const rel = posixPath(String(doc?.rel ?? '')).toLowerCase()
  if (rel.startsWith('docs/specs/') || rel.startsWith('docs/archive/specs/')) return 'spec'
  if (rel.startsWith('docs/prd/') || rel.startsWith('docs/archive/prd/')) return 'prd'
  if (rel.startsWith('docs/todo/') || rel.startsWith('docs/archive/todo/')) return 'todo'
  return ''
}

/**
 * 「这条批准有没有依据」——**全仓唯一实现**。
 *
 * ## 为什么必须只有一处
 *
 * 退场门禁（本文件）与文档审计（`doc-audit.mjs` 的 `auditDoc`）判的是同一份事实。
 * 两处各写一遍，迟早对同一份文档给出相反结论：一份正在生效的规划单「门禁说能开工、
 * 审计说依据缺失」，而审计的失败又把那份文档自己的验收判红——**两边都没错，结果对不上**。
 * 所以判法收敛在这里，两处都调它，谁也不许自己再判一遍。
 *
 * ## 三种合法依据，不是两种
 *
 * 1. `plan_critique` 以 `passed` 开头——正常过审；
 * 2. `plan_critique` 以 `skipped` 开头**且带实质理由**——显式跳过评审，理由要够长；
 * 3. `evaluateCritiqueOverride` 判为有效（`approved && !stale`）——人类签字放行。
 *
 * 第三种最容易漏。停损之后由人签字放行（`critique-override --human-approved`），
 * 但 `approveSpec` 走 override 分支时只改 `status`/`approved`，**不改写** `plan_critique`，
 * 于是文档里仍留着 `rejected (reviewer=…, round=3, …)`。那是**当初被拒过**的历史，
 * 不是**现在仍未过审**。只认前两种，就会把已由人签字放行的文档判成「依据缺失」——
 * 人签的字白签了。
 *
 * ## 但 override 只对签字时那份正文有效
 *
 * 签字后正文再被改动，人批的就不是当前这一版了。判据是正文指纹，与 `approve` 的
 * `BLOCKED_CRITIQUE_STALE` 用同一个函数（`evaluateCritiqueOverride`）；两处若各算一次，
 * 「approve 说有效、门禁说过期」就会同时成立。
 *
 * @param {{rel?: string, kind?: string, docType?: string, text?: string, data?: object}} doc
 * @returns {{applicable: boolean, hasBasis: boolean, basis: string, evidence: string|null}}
 */
export function resolveApprovalBasis(doc) {
  const docType = inferDocTypeOf(doc)
  if (!approvalAppliesTo(docType)) {
    return {
      applicable: false,
      hasBasis: true,
      basis: APPROVAL_BASIS.NOT_APPLICABLE,
      evidence: `文档类型 ${docType || '(未识别)'} 的流程里没有批准动作，本判据不适用于它`,
      warning: null,
    }
  }

  const data = doc?.data ?? {}
  const text = doc?.text ?? ''
  const stamp = typeof data.plan_critique === 'string' ? data.plan_critique.trim() : ''
  const critique = normalizeStatus(stamp).split(/[\s(]+/)[0]
  const ledgerEntry = doc?.ledgerEntry ?? doc?.planCritiqueEntry ?? null

  // 严格白名单依据一：`passed`；带 sha= 必须与当前正文指纹完全一致，无 sha= 兼容放行并告警。
  if (critique === 'passed') {
    const rawSha = /\bsha=([^\s,)]+)/i.exec(stamp)?.[1]?.trim() ?? ''
    const stampSha = parseCritiqueStamp(stamp)?.sha ?? ''
    const ledgerRounds = Array.isArray(ledgerEntry?.rounds) ? ledgerEntry.rounds : []
    const lastPassed = [...ledgerRounds].reverse().find((r) => r?.verdict === 'passed') ?? null
    const ledgerSha = String(lastPassed?.artifact_baseline?.shortSha ?? lastPassed?.sha ?? '').trim()
    const recordedSha = (rawSha || stampSha || ledgerSha).toLowerCase()
    if (recordedSha) {
      const currentSha = critiqueTextFingerprint(text).toLowerCase()
      if (recordedSha !== currentSha) {
        return {
          applicable: true,
          hasBasis: false,
          basis: APPROVAL_BASIS.CRITIQUE_STALE,
          evidence: `passed sha=${recordedSha} !== current=${currentSha}`,
          warning: null,
        }
      }
      return { applicable: true, hasBasis: true, basis: APPROVAL_BASIS.PASSED, evidence: stamp, warning: null }
    }
    return {
      applicable: true,
      hasBasis: true,
      basis: APPROVAL_BASIS.PASSED,
      evidence: stamp,
      warning: {
        code: 'WARN_CRITIQUE_LEGACY_NO_SHA',
        file: doc?.rel ?? null,
        message: `${doc?.rel ?? '计划文档'} 使用不含 sha= 的历史 passed 记录，建议补跑 critique-pass 绑定正文指纹`,
      },
    }
  }

  // 严格白名单依据二：显式跳过且实质理由达标。
  if (critique === 'skipped') {
    const reason = skippedReasonOf(stamp)
    if (reason.length >= SKIPPED_REASON_MIN_CHARS) {
      return { applicable: true, hasBasis: true, basis: APPROVAL_BASIS.SKIPPED, evidence: reason, warning: null }
    }
  }

  // 严格白名单依据三：人类签字放行（approved === true、SHA 一致且带非空 reason）。
  const overrideState = evaluateCritiqueOverride(text, data, ledgerEntry)
  const overrideReason = typeof overrideState.override?.reason === 'string'
    ? overrideState.override.reason.trim()
    : ''
  if (overrideState.approved && !overrideState.stale && overrideReason.length > 0) {
    return {
      applicable: true,
      hasBasis: true,
      basis: APPROVAL_BASIS.HUMAN_OVERRIDE,
      evidence: `human-override sha=${overrideState.sha ?? '(未记录)'}`,
      warning: null,
    }
  }
  if (overrideState.approved && overrideState.stale) {
    return {
      applicable: true,
      hasBasis: false,
      basis: APPROVAL_BASIS.OVERRIDE_STALE,
      evidence: `override=${overrideState.sha} !== current=${overrideState.currentSha}`,
      warning: null,
    }
  }

  // 其余任何值（缺失、空值、pending、rejected、无效 skipped/override、未知状态）一律阻断。
  return {
    applicable: true,
    hasBasis: false,
    basis: stamp ? APPROVAL_BASIS.CRITIQUE_UNREADY : APPROVAL_BASIS.MISSING,
    evidence: stamp || null,
    warning: null,
  }
}

/**
 * 内审是否「未过」——门禁给人看的那一侧措辞。
 *
 * 判法本身在 `resolveApprovalBasis` 里，这里只负责把结论翻译成「哪里不对 + 怎么改」。
 * 两处各判一遍就等于两份真相，所以这里**只格式化，不判断**。
 *
 * @param {{rel: string, text: string, data: object}} doc
 * @returns {{blocked: boolean, message: string, fixHint: string, basis: string}}
 */
export function resolveCritiqueReadiness(doc) {
  const verdict = resolveApprovalBasis(doc)
  if (verdict.hasBasis) {
    return {
      blocked: false,
      message: '',
      fixHint: '',
      basis: verdict.basis,
      ...(verdict.warning ? { warning: verdict.warning } : {}),
    }
  }
  if ((verdict.basis === APPROVAL_BASIS.CRITIQUE_STALE || verdict.basis === APPROVAL_BASIS.OVERRIDE_STALE)
    && isArchivedFinalizedSpec(doc)) {
    return {
      blocked: false,
      message: '',
      fixHint: '',
      basis: verdict.basis === APPROVAL_BASIS.OVERRIDE_STALE ? APPROVAL_BASIS.HUMAN_OVERRIDE : APPROVAL_BASIS.PASSED,
    }
  }

  if (verdict.basis === APPROVAL_BASIS.OVERRIDE_STALE) {
    return {
      blocked: true,
      basis: verdict.basis,
      message: `在人类 critique-override 之后正文又改动了（${verdict.evidence}），`
        + '人批的是当时那一版，不是现在这一版',
      fixHint: '要么撤销那处改动，要么重新跑 critique-override 签字；改完再走 approve。',
    }
  }
  if (verdict.basis === APPROVAL_BASIS.CRITIQUE_STALE) {
    return {
      blocked: true,
      basis: verdict.basis,
      message: `在 critique-pass 之后正文已改动或 SHA 不匹配（${verdict.evidence}），当前版本尚未复核`,
      fixHint: '修改正文后必须由新独立复核人重跑 critique-pass（并重新 approve），不能沿用旧 SHA 过审印记。',
    }
  }
  const stamp = doc?.data?.plan_critique
  return {
    blocked: true,
    basis: verdict.basis,
    message: verdict.basis === APPROVAL_BASIS.CRITIQUE_UNREADY
      ? `的规划内审状态未就绪（plan_critique: ${stamp}）`
      : '的规划内审没有任何记录（plan_critique 缺失或为空）',
    fixHint: '内审非得是有效 passed / 带实质理由的 skipped / 有效 human-override 才能退场。'
      + '若已停损并由人裁决放行，须先跑 critique-override --human-approved --reason "<裁决说明>"。',
  }
}

/**
 * 单份文档的退场判据。返回 `reasons` 数组，空数组即合格。
 */
function evaluateDoc(doc, { requireApproval = true, warnings = null } = {}) {
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
  if (doc.kind === 'prd' && isArchivedFinalizedPrd(doc)) return reasons

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
    if (readiness.warning && Array.isArray(warnings)) {
      warnings.push(readiness.warning)
    }
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
 */
function evaluateMasterPrd(repoRoot, specDoc, { requireApproval = true, warnings = null, planCritique = null } = {}) {
  const raw = specDoc?.data?.related_prd
  if (typeof raw !== 'string' || !raw.trim() || /^(?:无|none|null)$/i.test(raw.trim())) return []
  const prdAbs = resolve(dirname(specDoc.abs), raw.trim())
  const prdRelFromRoot = posixPath(prdAbs).startsWith(posixPath(repoRoot))
    ? posixPath(prdAbs).slice(posixPath(repoRoot).length + 1)
    : posixPath(join(dirname(specDoc.rel), raw.trim()))
  const prd = readPlanDoc(repoRoot, prdRelFromRoot)
  if (!prd || !prd.exists) return []
  if (prd.data?.multi_spec !== true) return []
  if (isArchivedFinalizedPrd(prd)) return []
  const ledgerEntry = planCritique?.[prd.rel] ?? null
  return evaluateDoc({ ...prd, kind: 'prd', ledgerEntry }, { requireApproval, warnings }).map((r) => ({
    ...r,
    message: `${r.message}（作为 ${specDoc.rel} 认领的总控 PRD）`,
  }))
}

/**
 * 规划退场门禁。
 */
export function evaluatePlanExitGate(repoRoot, {
  caseType = null,
  slug = null,
  taskId = null,
  issue = null,
  docs = {},
  allowBootstrap = false,
  reusePrRef = false,
  planCritique = null,
} = {}) {
  const num = Number(caseType)
  if (!Number.isInteger(num) || num <= 2 || num === 5) {
    return { ok: true, blocked: false, applicable: false, reasons: [], checked: [] }
  }
  if (reusePrRef) {
    return { ok: true, blocked: false, applicable: false, reasons: [], checked: [], reason: 'pr-continuation' }
  }

  const bound = collectBoundDocs(repoRoot, docs)
  const reasons = []
  const warnings = []
  const checked = bound.map((d) => d.rel)
  const requireApproval = APPROVAL_REQUIRED[num] !== false

  if (bound.length === 0) {
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
    const ledgerEntry = planCritique?.[doc.rel]
      ?? (doc.exists ? readPlanCritiqueEntrySync({ repoRoot, taskId, fmData: doc.data, relDoc: doc.rel }).entry : null)
    reasons.push(...evaluateDoc({ ...doc, ledgerEntry }, { requireApproval, warnings }))
    if (doc.kind === 'spec' && doc.exists) {
      reasons.push(...evaluateMasterPrd(repoRoot, doc, { requireApproval, warnings, planCritique }))
    }
  }

  if (reasons.length === 0) {
    return {
      ok: true,
      blocked: false,
      applicable: true,
      reasons: [],
      checked,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  if (allowBootstrap) {
    return {
      ok: true, blocked: false, applicable: true, reasons: [], checked,
      bootstrap: true, wouldBlock: reasons,
      ...(warnings.length > 0 ? { warnings } : {}),
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
    ...(warnings.length > 0 ? { warnings } : {}),
    message: `${PLAN_EXIT_BLOCK_CODE}: 规划未就绪，不能开工（${reasons[0].message}）`,
  }
}

/** 把门禁结论排成人能读的几行，供文本模式输出。 */
export function formatPlanExitGate(gate) {
  if (!gate) return []
  const warningLines = Array.isArray(gate.warnings)
    ? gate.warnings.map((w) => `[WARN] ${w.code ? `${w.code}: ` : ''}${w.message}`)
    : []
  if (gate.blocked) {
    const lines = [`${PLAN_EXIT_BLOCK_CODE}: 规划未就绪，先补齐再开工（已检查：${gate.checked.join(', ') || '无绑定文档'}）`]
    for (const r of gate.reasons) {
      lines.push(`  - ${r.file ? `${r.file}：` : ''}${r.message}`)
      if (r.fixHint) lines.push(`    改法：${r.fixHint}`)
    }
    return [...lines, ...warningLines]
  }
  if (gate.bootstrap && gate.wouldBlock?.length > 0) {
    return [
      `规划退场门禁已被 --${PLAN_BOOTSTRAP_FLAG} 豁免（${gate.wouldBlock[0].message}）`,
      ...warningLines,
    ]
  }
  return warningLines
}
