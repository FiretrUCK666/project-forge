/**
 * credential-scan.mjs —— 敏感文件与 `.npmrc` 真实凭据正文判定单一真相原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 `scripts/lib/survey-workspace.mjs` 与
 * `kit/skills/dev-govern/scripts/govern-checks.mjs` 共用，杜绝无害工作区 `.npmrc` 配置误报。
 */

export const SECRET_FILE_RE = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519|ecdsa))$|\.(?:pem|key|p12|pfx|keystore)$/i
export const SAFE_ENV_RE = /^\.env\.(?:example|sample|template|defaults)$/i
export const NPMRC_FILE_RE = /^\.npmrc$/i

export const NPMRC_CREDENTIAL_RE = /(?:_authToken|_auth|_password|\/\/[^/\s]+\/:|\btoken\s*=|\bsecret\s*=)/i

export const SECRET_CONTENT_PATTERNS = Object.freeze([
  { label: 'GitHub classic token', zhLabel: 'GitHub 令牌', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { label: 'GitHub fine-grained token', zhLabel: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'npm token', zhLabel: 'npm 令牌', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'PyPI token', zhLabel: 'PyPI 令牌', re: /\bpypi-[A-Za-z0-9_-]{50,}\b/ },
  { label: 'AWS access key', zhLabel: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'API key sk-*', zhLabel: 'API 密钥', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { label: 'PEM private key block', zhLabel: '私钥块', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----\r?\n[A-Za-z0-9+/=]{16,}/ },
])

export function isNpmrcFile(fileName) {
  return NPMRC_FILE_RE.test(String(fileName ?? ''))
}

/**
 * 判定 `.npmrc` 正文是否仅含无害工作区配置（如 `node-linker=isolated`、`registry=...`）。
 * 跳过空行与 `#`/`;` 注释行；未提供文本时 fail-closed 返回 `false`。
 */
export function isHarmlessNpmrcContent(text) {
  if (typeof text !== 'string') return false
  const activeLines = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith(';'))
  return !activeLines.some((l) => NPMRC_CREDENTIAL_RE.test(l))
}

/**
 * 判定敏感命名文件是否真正构成凭据风险：
 * `.npmrc` 仅当正文命中真实凭据模式（或文本不可读时 fail-closed）才返回 `true`。
 */
export function isSensitiveSecretFile(fileName, contentText = undefined) {
  const name = String(fileName ?? '')
  if (!SECRET_FILE_RE.test(name) || SAFE_ENV_RE.test(name)) return false
  if (isNpmrcFile(name)) {
    if (typeof contentText !== 'string') return true
    return !isHarmlessNpmrcContent(contentText)
  }
  return true
}
