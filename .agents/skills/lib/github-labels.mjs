/**
 * github-labels.mjs —— 有限并发执行器、自动建标写后回读、HTTP 403 显式降级与 PR 关闭辅助。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 github-client.mjs 复用。
 */

export const DEFAULT_GITHUB_CONCURRENCY = 4

export const DEFAULT_LABEL_STYLES = Object.freeze({
  'in-progress': Object.freeze({ color: 'fbca04', description: 'Work currently in progress' }),
  'in-review': Object.freeze({ color: '0e8a16', description: 'Ready for independent review' }),
  'changes-requested': Object.freeze({ color: 'd93f0b', description: 'Changes requested by reviewer' }),
  reviewed: Object.freeze({ color: '1d76db', description: 'Independent review passed' }),
  wontfix: Object.freeze({ color: 'ffffff', description: 'This will not be worked on' }),
  'out-of-scope': Object.freeze({ color: 'e99695', description: 'Outside project scope or non-goals' }),
  duplicate: Object.freeze({ color: 'cfd3d7', description: 'Duplicate of an existing or archived proposal' }),
  'needs-info': Object.freeze({ color: 'd876e3', description: 'More information is requested' }),
  deferred: Object.freeze({ color: 'c5def5', description: 'Deferred for future scheduling' }),
})

/** 规范化并去重标签名列表（兼容字符串数组与 GitHub 标签对象数组）。 */
export function normalizeLabelList(labels) {
  if (!Array.isArray(labels)) return []
  const seen = new Set()
  const out = []
  for (const item of labels) {
    const raw = typeof item === 'string' ? item : item?.name
    const clean = String(raw ?? '').trim()
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(clean)
  }
  return out
}

/** 有限并发映射执行器（默认最大并发度 4，保序返回结果）。 */
export async function mapWithConcurrency(items, limit = DEFAULT_GITHUB_CONCURRENCY, fn) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) return []
  if (typeof fn !== 'function') throw new TypeError('mapWithConcurrency requires a worker function')
  const rawLimit = Number(limit)
  const cap = Number.isFinite(rawLimit) && rawLimit >= 1
    ? Math.min(Math.floor(rawLimit), list.length)
    : Math.min(DEFAULT_GITHUB_CONCURRENCY, list.length)
  const results = new Array(list.length)
  let nextIdx = 0
  const worker = async () => {
    while (true) {
      const idx = nextIdx
      nextIdx += 1
      if (idx >= list.length) return
      results[idx] = await fn(list[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: cap }, () => worker()))
  return results
}

function extractResMessage(res) {
  if (!res || typeof res !== 'object') return ''
  return String(res.stderr ?? res.data?.message ?? res.error ?? res.reason ?? '').trim()
}

export function isForbidden403(res) {
  if (!res || res.ok) return false
  if (Number(res.status) === 403) return true
  return /\b403\b|forbidden|permission|not authorized|resource not accessible/i.test(extractResMessage(res))
}

export function isMissingLabelFailure(res) {
  if (!res || res.ok) return false
  const status = Number(res.status)
  if (status === 422 || status === 404) return true
  const msg = extractResMessage(res)
  return /not found|does not exist|could not resolve|label.*not.*found|validation failed/i.test(msg)
}

function isUnsupportedMockFallback(res) {
  if (!res || res.ok) return false
  const status = Number(res.status || 0)
  return status === 0 && /^unsupported$/i.test(extractResMessage(res))
}

function buildLabelPayload(name, opts = {}) {
  const cleanName = String(name ?? '').trim()
  const preset = DEFAULT_LABEL_STYLES[cleanName.toLowerCase()] ?? {}
  const color = String(opts.color ?? preset.color ?? 'ededed').replace(/^#/, '').trim() || 'ededed'
  const description = String(opts.description ?? preset.description ?? '').trim()
  return { name: cleanName, color, ...(description ? { description } : {}) }
}

/** 经 REST `POST /repos/{owner}/{repo}/labels` 创建仓库标签（已存在幂等放行，403 显式降级）。 */
export async function createLabelViaApi({
  tier,
  repo,
  name,
  color,
  description,
  callHttps,
  callGh,
  withTempFile,
  makeMcpDelegate,
} = {}) {
  const cleanRepo = String(repo ?? '').trim()
  const cleanName = String(name ?? '').trim()
  if (!cleanRepo || !cleanName) return { ok: false, error: 'missing-repo-or-label-name' }
  const payload = buildLabelPayload(cleanName, { color, description })
  if (tier !== 'gh-cli' && tier !== 'node-https-token') {
    return typeof makeMcpDelegate === 'function'
      ? makeMcpDelegate('create_label', { repo: cleanRepo, ...payload })
      : { ok: false, delegated: true, action: 'create_label', repo: cleanRepo, ...payload }
  }
  const res = tier === 'node-https-token'
    ? await callHttps('POST', `/repos/${cleanRepo}/labels`, payload)
    : await withTempFile('pf-create-label', JSON.stringify(payload), (tmp) => (
        callGh(['api', `repos/${cleanRepo}/labels`, '-X', 'POST', '--input', tmp])
      ))
  if (res?.ok) return { ok: true, name: cleanName, color: payload.color, created: true }
  const msg = extractResMessage(res)
  const errors = Array.isArray(res?.data?.errors) ? res.data.errors : []
  if (Number(res?.status) === 422 && (/already[_\s]?exists/i.test(msg) || errors.some((e) => e?.code === 'already_exists'))) {
    return { ok: true, name: cleanName, alreadyExists: true }
  }
  if (isForbidden403(res)) {
    return { ok: false, degraded: true, skipped: true, status: 403, name: cleanName, reason: 'forbidden-403', error: msg || 'HTTP 403 Forbidden' }
  }
  return { ok: false, status: Number(res?.status || res?.code || 0), name: cleanName, error: msg || 'create-label-failed' }
}

/** 便携式建标导出（支持传入已构造的 client 或底层回调）。 */
export async function createLabel(repo, name, opts = {}) {
  if (repo && typeof repo === 'object') {
    return createLabel(repo.repo, repo.name, repo)
  }
  if (opts?.client && typeof opts.client.createLabel === 'function') {
    return opts.client.createLabel(repo, name, opts)
  }
  return createLabelViaApi({ repo, name, ...opts })
}

/**
 * 经 REST `POST /repos/{owner}/{repo}/issues/{number}/labels` 贴标：
 * - 若仓库缺失标签（422/404/缺失）自动建标后重试；
 * - 贴后立即二次回读目标 Issue/PR 验证落盘（`verifiedReadback`）；
 * - HTTP 403 权限不足显式记录 `{ ok: false, degraded: true, status: 403, reason }` 并降级返回。
 */
export async function addLabelsWithEnsureAndReadback({
  tier,
  repo,
  number,
  labels = [],
  isPr = false,
  readTarget = null,
  listRepoLabels = null,
  callHttps,
  callGh,
  withTempFile,
  makeMcpDelegate,
  concurrency = DEFAULT_GITHUB_CONCURRENCY,
  labelStyles = {},
} = {}) {
  const cleanLabels = normalizeLabelList(labels)
  if (cleanLabels.length === 0) return { ok: true, skipped: true, labels: [], verifiedReadback: true }
  const num = Number(number)
  if (!repo || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
  if (tier !== 'gh-cli' && tier !== 'node-https-token') {
    return typeof makeMcpDelegate === 'function'
      ? makeMcpDelegate('add_labels', { repo, number: num, labels: cleanLabels })
      : { ok: false, delegated: true, action: 'add_labels', repo, number: num, labels: cleanLabels }
  }

  const postLabels = async () => {
    if (tier === 'node-https-token') {
      return callHttps('POST', `/repos/${repo}/issues/${num}/labels`, { labels: cleanLabels })
    }
    const apiRes = await withTempFile('pf-add-labels', JSON.stringify({ labels: cleanLabels }), (tmp) => (
      callGh(['api', `repos/${repo}/issues/${num}/labels`, '-X', 'POST', '--input', tmp])
    ))
    if (apiRes?.ok || !isUnsupportedMockFallback(apiRes)) return apiRes
    const args = [isPr ? 'pr' : 'issue', 'edit', String(num), '--repo', repo]
    for (const l of cleanLabels) args.push('--add-label', l)
    const editRes = await callGh(args)
    if (!editRes?.ok && isPr && isUnsupportedMockFallback(editRes)) {
      const issueArgs = ['issue', 'edit', String(num), '--repo', repo]
      for (const l of cleanLabels) issueArgs.push('--add-label', l)
      return callGh(issueArgs)
    }
    return editRes
  }

  const ensureMissingLabels = async (targetNames) => {
    const namesToCreate = normalizeLabelList(targetNames)
    if (namesToCreate.length === 0) return { ok: true, created: [], forbidden: null }
    let existingSet = null
    if (typeof listRepoLabels === 'function') {
      const listed = await Promise.resolve(listRepoLabels({ repo })).catch(() => null)
      if (listed?.ok && Array.isArray(listed.labels)) {
        existingSet = new Set(listed.labels.map((l) => String(l).toLowerCase()))
      }
    }
    const missing = existingSet
      ? namesToCreate.filter((n) => !existingSet.has(n.toLowerCase()))
      : namesToCreate
    const toCreate = missing.length > 0 ? missing : namesToCreate
    const outcomes = await mapWithConcurrency(toCreate, concurrency, (lbl) => {
      const style = labelStyles?.[lbl] ?? labelStyles?.[lbl.toLowerCase()] ?? {}
      return createLabelViaApi({
        tier, repo, name: lbl, color: style.color, description: style.description,
        callHttps, callGh, withTempFile, makeMcpDelegate,
      })
    })
    const forbidden = outcomes.find((o) => o?.degraded && Number(o?.status) === 403) ?? null
    const created = outcomes.filter((o) => o?.ok && o?.created).map((o) => o.name)
    return { ok: !forbidden, created, forbidden, outcomes }
  }

  let res = await postLabels()
  let createdLabels = []

  if (!res?.ok && isForbidden403(res)) {
    return {
      ok: false,
      degraded: true,
      skipped: true,
      status: 403,
      reason: 'forbidden-403',
      error: extractResMessage(res) || 'HTTP 403 Forbidden',
      labels: cleanLabels,
      verifiedReadback: false,
    }
  }

  if (!res?.ok && isMissingLabelFailure(res)) {
    const ensured = await ensureMissingLabels(cleanLabels)
    if (ensured.forbidden) {
      return {
        ok: false,
        degraded: true,
        skipped: true,
        status: 403,
        reason: 'forbidden-403',
        error: ensured.forbidden.error ?? 'HTTP 403 Forbidden while creating missing labels',
        labels: cleanLabels,
        verifiedReadback: false,
      }
    }
    createdLabels = ensured.created
    res = await postLabels()
    if (!res?.ok && isForbidden403(res)) {
      return {
        ok: false,
        degraded: true,
        skipped: true,
        status: 403,
        reason: 'forbidden-403',
        error: extractResMessage(res) || 'HTTP 403 Forbidden',
        labels: cleanLabels,
        createdLabels,
        verifiedReadback: false,
      }
    }
  }

  if (!res?.ok) {
    return {
      ok: false,
      skipped: true,
      status: Number(res?.status || res?.code || 0),
      reason: extractResMessage(res) || `http-${res?.status ?? 'error'}`,
      labels: cleanLabels,
      createdLabels,
      verifiedReadback: false,
    }
  }

  let verifiedReadback = false
  let readbackSkipped = false
  let actualLabels = []
  let missingAfterWrite = []

  if (typeof readTarget === 'function') {
    const readRes = await Promise.resolve(readTarget(repo, num, { isPr })).catch(() => null)
    if (readRes?.ok && Array.isArray(readRes.labels)) {
      actualLabels = normalizeLabelList(readRes.labels)
      const actualLow = new Set(actualLabels.map((l) => l.toLowerCase()))
      missingAfterWrite = cleanLabels.filter((l) => !actualLow.has(l.toLowerCase()))
      if (missingAfterWrite.length > 0 && createdLabels.length === 0) {
        const ensured = await ensureMissingLabels(missingAfterWrite)
        if (!ensured.forbidden && ensured.created.length > 0) {
          createdLabels = [...new Set([...createdLabels, ...ensured.created])]
          const retryRes = await postLabels()
          if (retryRes?.ok) {
            const secondRead = await Promise.resolve(readTarget(repo, num, { isPr })).catch(() => null)
            if (secondRead?.ok && Array.isArray(secondRead.labels)) {
              actualLabels = normalizeLabelList(secondRead.labels)
              const secondLow = new Set(actualLabels.map((l) => l.toLowerCase()))
              missingAfterWrite = cleanLabels.filter((l) => !secondLow.has(l.toLowerCase()))
            }
          }
        }
      }
      verifiedReadback = missingAfterWrite.length === 0
    } else {
      readbackSkipped = true
    }
  } else {
    readbackSkipped = true
  }

  return {
    ok: true,
    number: num,
    labels: actualLabels.length > 0 ? actualLabels : cleanLabels,
    requestedLabels: cleanLabels,
    ...(createdLabels.length > 0 ? { createdLabels } : {}),
    verifiedReadback,
    ...(readbackSkipped ? { readbackSkipped: true } : {}),
    ...(missingAfterWrite.length > 0 ? { missingLabels: missingAfterWrite } : {}),
  }
}

/** 经 REST `PATCH /repos/{owner}/{repo}/pulls/{number}` (`{ state: "closed" }`) 执行先评后标再关 PR。 */
export async function closePrViaRest({
  tier,
  repo,
  number,
  comment = '',
  labels = [],
  dryRun = false,
  statePayload = {},
  postCommentFn = null,
  addLabelsFn = null,
  readPrFn = null,
  callHttps,
  callGh,
  withTempFile,
  makeMcpDelegate,
} = {}) {
  const num = Number(number)
  if (!repo || !Number.isInteger(num) || num <= 0) return { ok: false, error: 'missing-repo-or-number' }
  const cleanComment = String(comment ?? '').trim()
  const cleanLabels = normalizeLabelList(labels)

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      repo,
      number: num,
      state: 'OPEN',
      planned: { comment: Boolean(cleanComment), labels: cleanLabels, close: true },
    }
  }

  if (tier !== 'gh-cli' && tier !== 'node-https-token') {
    const delegated = typeof makeMcpDelegate === 'function'
      ? makeMcpDelegate('close_pr', {
          repo,
          number: num,
          ...(cleanComment ? { body: cleanComment } : {}),
          ...(cleanLabels.length > 0 ? { labels: cleanLabels } : {}),
        }, statePayload)
      : { ok: false, delegated: true, action: 'close_pr', repo, number: num }
    return {
      ...delegated,
      delegatedPayload: {
        action: 'close-pr',
        repo,
        number: num,
        comment: cleanComment || null,
        labels: cleanLabels,
        state: 'closed',
        statePayload,
      },
    }
  }

  let commentResult = null
  if (cleanComment && typeof postCommentFn === 'function') {
    commentResult = await postCommentFn({ repo, number: num, body: cleanComment, statePayload })
  }

  let labelResult = null
  if (cleanLabels.length > 0 && typeof addLabelsFn === 'function') {
    labelResult = await addLabelsFn({ repo, number: num, labels: cleanLabels, isPr: true })
  }

  if (typeof readPrFn === 'function') {
    const cur = await Promise.resolve(readPrFn(repo, num)).catch(() => null)
    if (cur?.ok && ['CLOSED', 'MERGED'].includes(String(cur.state ?? '').toUpperCase())) {
      return {
        ok: true,
        number: num,
        state: String(cur.state).toUpperCase(),
        alreadyClosed: true,
        ...(commentResult ? { commentResult } : {}),
        ...(labelResult ? { labelResult } : {}),
      }
    }
  }

  let closeRes
  if (tier === 'node-https-token') {
    closeRes = await callHttps('PATCH', `/repos/${repo}/pulls/${num}`, { state: 'closed' })
  } else {
    closeRes = await withTempFile('pf-close-pr', JSON.stringify({ state: 'closed' }), (tmp) => (
      callGh(['api', `repos/${repo}/pulls/${num}`, '-X', 'PATCH', '--input', tmp])
    ))
    if (!closeRes?.ok && isUnsupportedMockFallback(closeRes)) {
      closeRes = await callGh(['pr', 'close', String(num), '--repo', repo])
    }
  }

  if (!closeRes?.ok) {
    if (isForbidden403(closeRes)) {
      return {
        ok: false,
        degraded: true,
        status: 403,
        number: num,
        reason: 'forbidden-403',
        error: extractResMessage(closeRes) || 'HTTP 403 Forbidden',
        ...(commentResult ? { commentResult } : {}),
        ...(labelResult ? { labelResult } : {}),
      }
    }
    const msg = extractResMessage(closeRes)
    if (/already\s+closed/i.test(msg)) {
      return {
        ok: true,
        number: num,
        state: 'CLOSED',
        alreadyClosed: true,
        ...(commentResult ? { commentResult } : {}),
        ...(labelResult ? { labelResult } : {}),
      }
    }
    return {
      ok: false,
      status: Number(closeRes?.status || closeRes?.code || 0),
      number: num,
      error: msg || 'close-pr-failed',
      ...(commentResult ? { commentResult } : {}),
      ...(labelResult ? { labelResult } : {}),
    }
  }

  return {
    ok: true,
    number: num,
    state: 'CLOSED',
    alreadyClosed: false,
    ...(commentResult ? { commentResult } : {}),
    ...(labelResult ? { labelResult } : {}),
  }
}
