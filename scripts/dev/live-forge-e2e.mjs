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

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildNonInteractiveEnv } from '../../kit/skills/lib/exec.mjs'
import { gitRun } from '../../kit/skills/lib/git.mjs'
import {
  buildDialectAuthHeaders,
  createProviderClient,
  isLanHost,
  platformHttpRequest,
  redactPlatformTokens,
} from '../../kit/skills/lib/platform.mjs'

const SUPPORTED_PROVIDERS = new Set(['github', 'gitlab', 'gitcode', 'gitee', 'gitea'])
const ONE_BY_ONE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
)

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
    '  - 完整实测：建仓 -> 克隆/推送 -> Issue/标签/里程碑 -> 附件上传(若支持) -> PR/MR 评论/核 SHA -> 合并 -> 销毁私仓。',
  ].join('\n') + '\n')
}

export function normalizeApiBase(providerId, rawUrl) {
  const clean = String(rawUrl ?? '').trim().replace(/\/+$/, '')
  if (providerId === 'github') {
    if (/\/api\/v3$|api\.github\.com$/i.test(clean)) return clean
    if (/github\.com$/i.test(clean)) return 'https://api.github.com'
    return `${clean}/api/v3`
  }
  if (providerId === 'gitlab' || providerId === 'gitcode') return /\/api\/v4$/i.test(clean) ? clean : `${clean}/api/v4`
  if (providerId === 'gitee') return /\/api\/v5$/i.test(clean) ? clean : `${clean}/api/v5`
  if (providerId === 'gitea') return /\/api\/v1$/i.test(clean) ? clean : `${clean}/api/v1`
  return clean
}

/** 当 PF_LIVE_FORGE_URL 为 https:// 时，将平台返回的 http:// cloneUrl 同步升级为 https://。 */
export function alignCloneUrlScheme(cloneUrl, forgeUrl) {
  const raw = String(cloneUrl ?? '').trim()
  if (!raw) return raw
  if (/^https:\/\//i.test(String(forgeUrl ?? '').trim()) && /^http:\/\//i.test(raw)) {
    return `https://${raw.slice('http://'.length)}`
  }
  return raw
}

/** 构造临时内存级 git `-c http.extraHeader=...` 参数（绝不将令牌写入 `.git/config`）。 */
export function buildHttpsAuthGitArgs(providerId, token) {
  const cleanToken = String(token ?? '').trim()
  if (!cleanToken) return []
  const user = providerId === 'gitlab' || providerId === 'gitcode' ? 'oauth2' : 'x-access-token'
  const b64 = Buffer.from(`${user}:${cleanToken}`, 'utf8').toString('base64')
  return ['-c', `http.extraHeader=Authorization: Basic ${b64}`]
}

/** 优先 SSH 克隆，失败或缺失时自动回退至协议对齐 + 内存鉴权的 HTTPS，并兼容空初始仓自动补齐首个基线提交。 */
export async function cloneAndPrepareRepo({
  workDir, created, providerId, forgeUrl, token, repoName = 'e2e', env = process.env, gitRunner = gitRun,
}) {
  const safeEnv = buildNonInteractiveEnv(env)
  const repoDir = join(workDir, 'repo')
  let usedTransport = null
  let pushAuthArgs = []
  let lastErr = ''

  if (created?.sshUrl) {
    const sshClone = await gitRunner(workDir, ['clone', created.sshUrl, 'repo'], { env: safeEnv })
    if (sshClone.ok) usedTransport = 'ssh'
    else {
      lastErr = sshClone.stderr || sshClone.stdout || 'ssh clone failed'
      if (existsSync(repoDir)) rmSync(repoDir, { recursive: true, force: true })
    }
  }
  if (!usedTransport) {
    const httpsUrl = alignCloneUrlScheme(created?.cloneUrl, forgeUrl)
    if (!httpsUrl) throw new Error(`缺少可用的克隆地址（SSH 失败：${lastErr || 'none'}）`)
    pushAuthArgs = buildHttpsAuthGitArgs(providerId, token)
    const httpsClone = await gitRunner(workDir, [...pushAuthArgs, 'clone', httpsUrl, 'repo'], { env: safeEnv })
    if (!httpsClone.ok) {
      throw new Error(`克隆临时仓失败：${redactPlatformTokens(httpsClone.stderr || httpsClone.stdout || lastErr, [token])}`)
    }
    usedTransport = 'https'
  }

  await gitRunner(repoDir, ['config', 'user.name', 'pf-e2e-bot'], { env: safeEnv })
  await gitRunner(repoDir, ['config', 'user.email', 'pf-e2e-bot@example.invalid'], { env: safeEnv })

  let seededEmptyRepo = false
  let baseBranch = created?.defaultBranch || null
  const headCheck = await gitRunner(repoDir, ['rev-parse', '--verify', 'HEAD'], { env: safeEnv })
  if (!headCheck.ok) {
    baseBranch = baseBranch || 'main'
    seededEmptyRepo = true
    await gitRunner(repoDir, ['checkout', '-B', baseBranch], { env: safeEnv })
    writeFileSync(join(repoDir, 'README.md'), `# ${repoName}\n`)
    await gitRunner(repoDir, ['add', 'README.md'], { env: safeEnv })
    await gitRunner(repoDir, ['commit', '-m', 'chore: initial e2e seed'], { env: safeEnv })
    const seedPush = await gitRunner(repoDir, [...pushAuthArgs, 'push', '-u', 'origin', baseBranch], { env: safeEnv })
    if (!seedPush.ok) {
      throw new Error(`空仓初始化基线推送失败：${redactPlatformTokens(seedPush.stderr || seedPush.stdout, [token])}`)
    }
  } else if (!baseBranch) {
    const sym = await gitRunner(repoDir, ['symbolic-ref', '--short', 'HEAD'], { env: safeEnv })
    baseBranch = (sym.ok && sym.stdout.trim()) ? sym.stdout.trim() : 'main'
  }

  return { repoDir, baseBranch, usedTransport, pushAuthArgs, seededEmptyRepo, safeEnv }
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
      name: repoName, private: true, auto_init: true,
    })
    if (!res.ok) throw new Error(`创建 GitHub 临时私仓失败 (HTTP ${res.status}): ${res.text}`)
    return {
      slug: res.data?.full_name,
      cloneUrl: res.data?.clone_url,
      sshUrl: res.data?.ssh_url ?? null,
      defaultBranch: res.data?.default_branch ?? null,
      id: res.data?.full_name,
    }
  }
  if (providerId === 'gitlab') {
    const res = await authReq(providerId, apiBaseUrl, '/projects', 'POST', token, {
      name: repoName,
      path: repoName,
      visibility: 'private',
      initialize_with_readme: true,
      ...(namespace && /^\d+$/.test(namespace) ? { namespace_id: Number(namespace) } : {}),
    })
    if (!res.ok) throw new Error(`创建 GitLab 临时私仓失败 (HTTP ${res.status}): ${res.text}`)
    return {
      slug: res.data?.path_with_namespace,
      cloneUrl: res.data?.http_url_to_repo,
      sshUrl: res.data?.ssh_url_to_repo ?? null,
      defaultBranch: res.data?.default_branch ?? null,
      id: res.data?.id,
    }
  }
  const res = await authReq(providerId, apiBaseUrl, '/user/repos', 'POST', token, {
    name: repoName, private: true, auto_init: true,
  })
  if (!res.ok) throw new Error(`创建 ${providerId} 临时私仓失败 (HTTP ${res.status}): ${res.text}`)
  const fallbackClone = res.data?.html_url ? `${res.data.html_url}.git` : res.data?.clone_url
  return {
    slug: res.data?.full_name,
    cloneUrl: res.data?.clone_url || fallbackClone,
    sshUrl: res.data?.ssh_url ?? null,
    defaultBranch: res.data?.default_branch ?? null,
    id: res.data?.full_name,
  }
}

async function deleteDisposableRepo({ providerId, apiBaseUrl, token, slug, id }) {
  if (!slug && !id) return
  if (providerId === 'gitlab' || providerId === 'gitcode') {
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
    process.stdout.write(`[1/7] 已创建一次性私有测试仓：${slug}\n`)

    const prep = await cloneAndPrepareRepo({ workDir, created, providerId, forgeUrl: rawUrl, token, repoName, env })
    const { repoDir, baseBranch, usedTransport, pushAuthArgs, safeEnv } = prep
    await gitRun(repoDir, ['checkout', '-b', 'feat/e2e-smoke'], { env: safeEnv })
    writeFileSync(join(repoDir, 'smoke.txt'), `e2e ${repoName}\n`)
    await gitRun(repoDir, ['add', 'smoke.txt'], { env: safeEnv })
    await gitRun(repoDir, ['commit', '-m', 'feat: e2e disposable smoke'], { env: safeEnv })
    const headSha = (await gitRun(repoDir, ['rev-parse', 'HEAD'], { env: safeEnv })).stdout.trim()
    const pushRes = await gitRun(repoDir, [...pushAuthArgs, 'push', '-u', 'origin', 'feat/e2e-smoke'], { env: safeEnv })
    if (!pushRes.ok) throw new Error(`推送测试分支失败：${redactPlatformTokens(pushRes.stderr, [token])}`)
    process.stdout.write(`[2/7] 已通过 ${usedTransport} 推送分支 feat/e2e-smoke（base=${baseBranch}, head=${headSha.slice(0, 7)}）\n`)

    const client = createProviderClient({ providerId, apiBaseUrl, repoSlug: slug, token, repoRoot: repoDir })
    const iss = await client.createIssue({ repo: slug, title: 'feat: disposable e2e issue', body: '- [ ] C1: live e2e smoke' })
    if (!iss.ok) throw new Error(`创建 Issue 失败：${iss.error}`)
    const addLbl = await client.addLabels({ repo: slug, number: iss.number, labels: ['e2e-smoke'] })
    if (!addLbl.ok) throw new Error(`Issue 添加标签失败：${addLbl.error}`)
    const rmLbl = await client.removeLabel({ repo: slug, number: iss.number, label: 'e2e-smoke' })
    if (!rmLbl.ok) throw new Error(`Issue 移除标签失败：${rmLbl.error}`)
    process.stdout.write(`[3/7] 已验证 Issue #${iss.number} 创建与标签增删\n`)

    const ms = await client.createMilestone({ repo: slug, title: `e2e-${Date.now()}`, description: 'disposable e2e milestone' })
    if (!ms.ok) throw new Error(`创建里程碑失败：${ms.error}`)
    const msAssign = await client.assignMilestone({ repo: slug, number: iss.number, milestone: ms.number })
    if (!msAssign.ok) throw new Error(`关联里程碑失败：${msAssign.error}`)
    const msClose = await client.closeMilestone({ repo: slug, number: ms.number })
    if (!msClose.ok) throw new Error(`关闭里程碑失败：${msClose.error}`)
    process.stdout.write(`[4/7] 已验证里程碑 #${ms.number} 创建/关联/关闭\n`)

    let attachmentMd = ''
    if (client.capabilities?.uploadAttachment === true) {
      const up = await client.uploadAttachment({
        repo: slug, filename: 'e2e-1x1.png', contentType: 'image/png', buffer: ONE_BY_ONE_PNG,
      })
      if (!up.ok || !up.markdown) throw new Error(`附件上传失败：${up.error ?? 'missing markdown'}`)
      attachmentMd = `\n\n### E2E 附件\n${up.markdown}`
    }

    const pr = await client.createPr({
      repo: slug, head: 'feat/e2e-smoke', base: baseBranch,
      title: 'feat: disposable e2e pr', body: `Closes #${iss.number}${attachmentMd}`,
    })
    if (!pr.ok) throw new Error(`创建 PR/MR 失败：${pr.error}`)
    process.stdout.write(`[5/7] 已创建 PR/MR #${pr.number}${attachmentMd ? '（含附件上传）' : ''}\n`)

    const cmt = await client.postComment({ repo: slug, number: pr.number, isPr: true, body: 'live-forge-e2e verification comment' })
    if (!cmt.ok) throw new Error(`PR/MR 发表评论失败：${cmt.error}`)
    const prAddLbl = await client.addLabels({ repo: slug, number: pr.number, labels: ['in-review'], isPr: true })
    if (!prAddLbl.ok) throw new Error(`PR/MR 添加标签失败：${prAddLbl.error}`)
    const prRmLbl = await client.removeLabel({ repo: slug, number: pr.number, label: 'in-review', isPr: true })
    if (!prRmLbl.ok) throw new Error(`PR/MR 移除标签失败：${prRmLbl.error}`)
    process.stdout.write('[6/7] 已验证 PR/MR 评论与标签闭环\n')

    const prInfo = await client.getPr(slug, pr.number)
    if (!prInfo.ok || prInfo.headRefOid !== headSha) {
      throw new Error(`PR/MR HEAD SHA 校验不一致：expected=${headSha}, actual=${prInfo.headRefOid} (${prInfo.error ?? prInfo.shaSource})`)
    }
    const merged = await client.mergePr({ repo: slug, number: pr.number, method: 'merge' })
    if (!merged.ok) throw new Error(`合并 PR/MR 失败：${merged.error}`)
    process.stdout.write('[7/7] 已完成 SHA 校验、合并与全链路真机实证 PASS\n')
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
