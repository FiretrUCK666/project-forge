/**
 * injections-data-platform-core.mjs —— 多远端平台内核与安全传输层故障注入复验表（I1101–I1108）。
 *
 * 导出 `INJECTIONS_PLATFORM_CORE` 供 `injections-data.mjs` 自动发现加载。
 */

export const INJECTIONS_PLATFORM_CORE = [
  {
    id: 'I1101',
    what: 'platform-http.mjs: validateRequestUrl 放行公网明文 http:// 请求',
    file: 'kit/skills/lib/platform-http.mjs',
    alsoDropIn: ['.agents/skills/lib/platform-http.mjs'],
    from: "  if (proto === 'http:') {\n    if (!allowInsecureLan || !isLocalOrPrivate) {",
    to: "  if (proto === 'http:') {\n    if (false && (!allowInsecureLan || !isLocalOrPrivate)) {",
    expect: 'C4/C5：10 键能力矩阵、5 方言多级群组 resolveRemoteTarget、SSRF/元地址/3xx 脱敏、4 字节守卫与纯 Buffer multipart',
  },
  {
    id: 'I1102',
    what: 'platform-http.mjs: validateRequestUrl 跳过 169.254.169.254 与 fe80:: 链路本地/云元数据拦截',
    file: 'kit/skills/lib/platform-http.mjs',
    alsoDropIn: ['.agents/skills/lib/platform-http.mjs'],
    from: '  if (isBlockedMetaOrLinkLocalHost(hostname)) {',
    to: '  if (false && isBlockedMetaOrLinkLocalHost(hostname)) {',
    expect: 'C4/C5：10 键能力矩阵、5 方言多级群组 resolveRemoteTarget、SSRF/元地址/3xx 脱敏、4 字节守卫与纯 Buffer multipart',
  },
  {
    id: 'I1103',
    what: 'platform-http.mjs: platformHttpRequest 跳过 3xx 重定向拦截与 Location 脱敏',
    file: 'kit/skills/lib/platform-http.mjs',
    alsoDropIn: ['.agents/skills/lib/platform-http.mjs'],
    from: '        if (status >= 300 && status < 400) {',
    to: '        if (false && status >= 300 && status < 400) {',
    expect: 'C5/C6：纯 Node Mock Forge 5 方言鉴权头、429 退避、GitLab uploads、真 SHA + shaSource、GitCode 守卫、分支过滤与 RemoteApiBackend',
  },
  {
    id: 'I1104',
    what: 'github-parse.mjs: redactGhTokens 遗漏 glpat- 令牌脱敏',
    file: 'kit/skills/lib/github-parse.mjs',
    alsoDropIn: ['.agents/skills/lib/github-parse.mjs'],
    from: "    .replace(/\\bglpat-[A-Za-z0-9_-]{8,}\\b/g, '[redacted]')",
    to: "    .replace(/\\b__disabled_glpat__\\b/g, '[redacted]')",
    expect: 'C4/C5：10 键能力矩阵、5 方言多级群组 resolveRemoteTarget、SSRF/元地址/3xx 脱敏、4 字节守卫与纯 Buffer multipart',
  },
  {
    id: 'I1105',
    what: 'platform-http.mjs: sanitizeFourByteChars 失效不再替换四字节字符',
    file: 'kit/skills/lib/platform-http.mjs',
    alsoDropIn: ['.agents/skills/lib/platform-http.mjs'],
    from: 'export function sanitizeFourByteChars(text, replacement = \'\') {\n  return String(text ?? \'\').replace(FOUR_BYTE_CHAR_RE, String(replacement ?? \'\'))\n}',
    to: 'export function sanitizeFourByteChars(text) {\n  return String(text ?? \'\')\n}',
    expect: 'C4/C5：10 键能力矩阵、5 方言多级群组 resolveRemoteTarget、SSRF/元地址/3xx 脱敏、4 字节守卫与纯 Buffer multipart',
  },
  {
    id: 'I1106',
    what: 'platform-providers.mjs: findOpenPrForBranch 跳过客户端分支二次过滤',
    file: 'kit/skills/lib/platform-providers.mjs',
    alsoDropIn: ['.agents/skills/lib/platform-providers.mjs'],
    from: '    return { ok: true, prs: filterOpenPrsByBranch(mapped, { headBranch, base }) }',
    to: '    return { ok: true, prs: mapped }',
    expect: 'C5/C6：纯 Node Mock Forge 5 方言鉴权头、429 退避、GitLab uploads、真 SHA + shaSource、GitCode 守卫、分支过滤与 RemoteApiBackend',
  },
  {
    id: 'I1107',
    what: 'platform-providers.mjs: resolveGitLabMrHeadSha 忽略 refs/merge-requests/<iid>/head 真 SHA',
    file: 'kit/skills/lib/platform-providers.mjs',
    alsoDropIn: ['.agents/skills/lib/platform-providers.mjs'],
    from: "      if (m) return { headRefOid: m[1].toLowerCase(), shaSource: 'git-ls-remote' }",
    to: "      if (false && m) return { headRefOid: m[1].toLowerCase(), shaSource: 'git-ls-remote' }",
    expect: 'C5/C6：纯 Node Mock Forge 5 方言鉴权头、429 退避、GitLab uploads、真 SHA + shaSource、GitCode 守卫、分支过滤与 RemoteApiBackend',
  },
  {
    id: 'I1108',
    what: 'task-backend.mjs: createTaskBackend 恢复 provider.id !== github 硬退化',
    file: 'kit/skills/lib/task-backend.mjs',
    alsoDropIn: ['.agents/skills/lib/task-backend.mjs'],
    from: "  if (role === 'generic-git' || !provider || provider.capabilities?.api !== true || !targetRepo) {",
    to: "  if (role === 'generic-git' || !provider || provider.id !== 'github' || provider.capabilities?.api !== true || !targetRepo) {",
    expect: 'C5/C6：纯 Node Mock Forge 5 方言鉴权头、429 退避、GitLab uploads、真 SHA + shaSource、GitCode 守卫、分支过滤与 RemoteApiBackend',
  },
]
