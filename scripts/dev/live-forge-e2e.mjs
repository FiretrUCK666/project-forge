#!/usr/bin/env node
/**
 * live-forge-e2e.mjs —— 可选（opt-in）真实多平台一次性私有测试仓 E2E 实测入口。
 *
 * 安全设计：
 * - 零硬编码企业域名、账号或令牌：全部从环境变量读取，缺失即打印用法并退出 2；
 * - 强制一次性私有仓命名 `pf-e2e-disposable-<timestamp>-<rand>`，绝不触碰任何既有/生产仓；
 * - 全程在 `try / finally` 中自动销毁临时私有仓与本地临时目录，并在所有日志中脱敏令牌。
 *
 * 环境变量：
 *   PF_LIVE_FORGE_PROVIDER   必填：github | gitlab | gitcode | gitee | gitea
 *   PF_LIVE_FORGE_URL        必填：平台基础地址，例如 https://gitlab.example.com 或 https://api.github.com
 *   PF_LIVE_FORGE_TOKEN      必填：具备临时私仓建/删权的个人访问令牌（仅内存使用，绝不落盘）
 *   PF_LIVE_FORGE_NAMESPACE  可选：归属用户或组织命名空间（不传则自动从当前令牌用户读取）
 *   PF_LIVE_FORGE_KEEP_REPO  可选：设为 1 时保留测试仓便于事后排查（默认自动删除）
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitRun } from '../../kit/skills/lib/git.mjs'
import {
  buildDialectAuthHeaders,
  createProviderClient,
  isLanHost,
  platformHttpRequest,
  redactPlatformTokens,
} from '../../kit/skills/lib/platform.mjs'

const SUPPORTED_PROVIDERS = new Set(['github', 'gitlab', 'gitcode', 'gitee', 'gitea'])

function printUsage() {
  process.stdout.write([
    '用法（opt-in 真机一次性私有测试仓 E2E，不进入默认 merge-gate / CI）：',
    '  PF_LIVE_FORGE_PROVIDER=<github|gitlab|gitcode|gitee|gitea> \\',
    '  PF_LIVE_FORGE_URL=<https://forge.example.com> \\',
    '  PF_LIVE_FORGE_TOKEN=<personal-access-token> \\',
    '  [PF_LIVE_FORGE_NAMESPACE=<owner-or-group>] \\',
    '  node scripts/dev/live-forge-e2e.mjs [--dry-run]',
    '',
    '说明：',
    '  - 严格创建一次性私有测试仓 pf-e2e-disposable-<ts>，绝不触碰生产仓；',
    '  - 完整实测：建仓 -> 推送分支 -> 建 Issue -> 建 PR/MR -> 附件上传(若支持) -> 评论 -> 合并 -> 销毁私仓。',
  ].join('\n') + '\n')
}

function normalizeApiBase(providerId, rawUrl) {
  const clean = String(rawUrl ?? '').trim().replace(/\/+$/, '')
  if (providerId === 'github') {
    if (/\/api\/v3$|api\.github\.com$/i.test(clean)) return clean
    if (/github\.com$/i.test(clean)) return 'https://api.github.com'
    return `${clean}/api/v3`
  }
  if (providerId === 'gitlab') return /\/api\/v4$/i.test(clean) ? clean : `${clean}/api/v4`
  if (providerId === 'gitcode' || providerId === 'gitee') return /\/api\/v5$/i.test(clean) ? clean : `${clean}/api/v5`
  if (providerId === 'gitea') return /\/api\/v1$/i.test(clean) ? clean : `${clean}/api/v1`
  return clean
}

function authReq(providerId, apiBaseUrl, path, method, token, body) {
  const parsed = new URL(apiBaseUrl)
  const headers = buildDialectAuthHeaders(providerId, token)
  const sep = path.includes('?') ? '&' : '?'
  const finalUrl = providerId === 'gitee'
    ? `${apiBaseUrl}${path}${sep}access_token=${encodeURIComponent(token)}`
    : `${apiBaseUrl}${path}`
  return platformHttpRequest({
    method,
    url: finalUrl,
    headers,
    body,
    allowInsecureLan: isLanHost(parsed.hostname),
  })
}

async function createDisposableRepo({ providerId, apiBaseUrl, token, repoName, namespace }) {
  if (providerId === 'github') {
    const res = await authReq(providerId, apiBaseUrl, '/user/repos', 'POST', token, {
      name: repoName,
      private: true,
      auto_init: true,
    })
    if (!res.ok) throw new Error(`创建 GitHub 临时私仓失败 (HTTP ${res.status}): ${res.body}`)
    return { slug: res.data?.full_name, cloneUrl: res.data?.clone_url, id: res.data?.full_name }
  }
  if (providerId === 'gitlab') {
    const res = await authReq(providerId, apiBaseUrl, '/projects', 'POST', token, {
      name: repoName,
      path: repoName,
      visibility: 'private',
      initialize_with_readme: true,
      ...(namespace && /^\d+$/.test(namespace) ? { namespace_id: Number(namespace) } : {}),
    })
    if (!res.ok) throw new Error(`创建 GitLab 临时私仓失败 (HTTP ${res.status}): ${res.body}`)
    return { slug: res.data?.path_with_namespace, cloneUrl: res.data?.http_url_to_repo, id: res.data?.id }
  }
  if (providerId === 'gitcode' || providerId === 'gitee') {
    const res = await authReq(providerId, apiBaseUrl, '/user/repos', 'POST', token, {
      name: repoName,
      private: true,
      auto_init: true,
    })
    if (!res.ok) throw new Error(`创建 ${providerId} 临时私仓失败 (HTTP ${res.status}): ${res.body}`)
    return { slug: res.data?.full_name, cloneUrl: res.data?.html_url ? `${res.data.html_url}.git` : res.data?.clone_url, id: res.data?.full_name }
  }
  const res = await authReq(providerId, apiBaseUrl, '/user/repos', 'POST', token, {
    name: repoName,
    private: true,
    auto_init: true,
  })
  if (!res.ok) throw new Error(`创建 Gitea 临时私仓失败 (HTTP ${res.status}): ${res.body}`)
  return { slug: res.data?.full_name, cloneUrl: res.data?.clone_url, id: res.data?.full_name }
}

async function deleteDisposableRepo({ providerId, apiBaseUrl, token, slug, id }) {
  if (!slug && !id) return
  if (providerId === 'gitlab') {
    await authReq(providerId, apiBaseUrl, `/projects/${encodeURIComponent(String(id ?? slug))}`, 'DELETE', token)
    return
  }
  const [owner, repo] = String(slug).split('/')
  if (!owner || !repo) return
  await authReq(providerId, apiBaseUrl, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, 'DELETE', token)
}

export async function runLiveForgeE2e(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    return 0
  }
  const dryRun = argv.includes('--dry-run')
  const providerId = String(env.PF_LIVE_FORGE_PROVIDER ?? '').trim().toLowerCase()
  const rawUrl = String(env.PF_LIVE_FORGE_URL ?? '').trim()
  const token = String(env.PF_LIVE_FORGE_TOKEN ?? '').trim()
  const namespace = String(env.PF_LIVE_FORGE_NAMESPACE ?? '').trim() || null
  const keepRepo = env.PF_LIVE_FORGE_KEEP_REPO === '1'

  if (!SUPPORTED_PROVIDERS.has(providerId) || !rawUrl || !token) {
    process.stderr.write('缺少必填环境变量（PF_LIVE_FORGE_PROVIDER / PF_LIVE_FORGE_URL / PF_LIVE_FORGE_TOKEN）。\n\n')
    printUsage()
    return 2
  }

  const apiBaseUrl = normalizeApiBase(providerId, rawUrl)
  const repoName = `pf-e2e-disposable-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  if (dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, dryRun: true, providerId, apiBaseUrl, repoName, keepRepo }, null, 2)}\n`)
    return 0
  }

  const workDir = mkdtempSync(join(tmpdir(), 'pf-live-e2e-'))
  let created = null
  try {
    created = await createDisposableRepo({ providerId, apiBaseUrl, token, repoName, namespace })
    const slug = created.slug
    process.stdout.write(`[1/6] 已创建一次性私有测试仓：${slug}\n`)

    const cloneRes = await gitRun(workDir, ['clone', created.cloneUrl, 'repo'])
    if (!cloneRes.ok) throw new Error(`克隆临时仓失败：${redactPlatformTokens(cloneRes.stderr, [token])}`)
    const repoDir = join(workDir, 'repo')
    await gitRun(repoDir, ['checkout', '-b', 'feat/e2e-smoke'])
    writeFileSync(join(repoDir, 'smoke.txt'), `e2e ${repoName}\n`)
    await gitRun(repoDir, ['add', 'smoke.txt'])
    await gitRun(repoDir, ['commit', '-m', 'feat: e2e disposable smoke'])
    const pushRes = await gitRun(repoDir, ['push', '-u', 'origin', 'feat/e2e-smoke'])
    if (!pushRes.ok) throw new Error(`推送测试分支失败：${redactPlatformTokens(pushRes.stderr, [token])}`)
    process.stdout.write('[2/6] 已推送特性分支 feat/e2e-smoke\n')

    const client = createProviderClient({ providerId, apiBaseUrl, repoSlug: slug, token, repoRoot: repoDir })
    const iss = await client.createIssue({ repo: slug, title: 'feat: disposable e2e issue', body: '- [ ] C1: live e2e smoke' })
    if (!iss.ok) throw new Error(`创建 Issue 失败：${iss.error}`)
    process.stdout.write(`[3/6] 已创建 Issue #${iss.number}\n`)

    const pr = await client.createPr({ repo: slug, head: 'feat/e2e-smoke', base: 'main', title: 'feat: disposable e2e pr', body: `Closes #${iss.number}` })
    if (!pr.ok) throw new Error(`创建 PR/MR 失败：${pr.error}`)
    process.stdout.write(`[4/6] 已创建 PR/MR #${pr.number}\n`)

    const cmt = await client.postComment({ repo: slug, number: pr.number, body: 'live-forge-e2e verification comment' })
    if (!cmt.ok) throw new Error(`发表评论失败：${cmt.error}`)
    process.stdout.write('[5/6] 已验证评论回写\n')

    const merged = await client.mergePr({ repo: slug, number: pr.number, method: 'merge' })
    if (!merged.ok) throw new Error(`合并 PR/MR 失败：${merged.error}`)
    process.stdout.write('[6/6] 已完成合并与全链路真机实证 PASS\n')
    return 0
  } catch (err) {
    process.stderr.write(`live-forge-e2e 失败：${redactPlatformTokens(err instanceof Error ? err.message : String(err), [token])}\n`)
    return 1
  } finally {
    if (created && !keepRepo) {
      await deleteDisposableRepo({ providerId, apiBaseUrl, token, slug: created.slug, id: created.id }).catch(() => null)
      process.stdout.write(`[cleanup] 已销毁一次性私有测试仓：${created.slug}\n`)
    }
    try { rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) process.exitCode = await runLiveForgeE2e()
