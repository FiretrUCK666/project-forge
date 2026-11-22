/**
 * credential-scan.mjs —— 敏感文件与 `.npmrc` 真实凭据正文判定单一真相原语。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），供 `scripts/lib/survey-workspace.mjs` 与
 * `kit/skills/dev-govern/scripts/govern-checks.mjs` 共用，杜绝无害工作区 `.npmrc` 配置误报。
 */

export const SECRET_FILE_RE = /^(?:\.env(?:\..+)?|\.npmrc|\.pypirc|id_(?:rsa|ed25519|ecdsa))$|\.(?:pem|key|p12|pfx|keystore)$/i
export const SAFE_ENV_RE = /^\.env\.(?:example|sample|template|defaults)$/i
export const NPMRC_FILE_RE = /^\.npmrc$/i
export const ENV_FILE_RE = /^\.env(?:\..+)?$/i

export const NPMRC_CREDENTIAL_RE = /(?:_authToken|_auth|_password|\/\/[^/\s]+\/:|\btoken\s*=|\bsecret\s*=)/i

const TEST_FIXTURE_PATH_RE = /(?:^|\/)(?:tests?|specs?|__tests__|fixtures?|examples?|__mocks__|testdata)(?:\/|$)/i
const ENV_PLACEHOLDER_VAL_RE = /^(?:$|""|''|<[^>\n]+>|\$\{[^}]+\}|\{\{[^}]+\}\}|(?:x+|dummy|mock|fake|placeholder|example|sample|test|changeme|replace_me|todo|none|null|true|false|\d+|localhost|127\.0\.0\.1)|(?:https?|postgres(?:ql)?|mysql|redis|mongodb):\/\/(?:[^@/\s]+@)?(?:localhost|127\.0\.0\.1|example\.com)\b[^\s]*|(?:your|my|test|demo|sample|fake|dummy|placeholder|example|mock|changeme|local|dev)[_-][a-z0-9_.-]+|[a-z0-9_.-]+[_-](?:placeholder|example|sample|dummy|mock|fake|test))$/i
const ENV_SENSITIVE_KEY_RE = /(?:secret|token|password|passwd|pwd|api[_-]?key|private[_-]?key|auth|credential|access[_-]?key)/i

export const SECRET_CONTENT_PATTERNS = Object.freeze([
  { label: 'GitHub classic token', zhLabel: 'GitHub 令牌', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { label: 'GitHub fine-grained token', zhLabel: 'GitHub 细粒度令牌', re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/ },
  { label: 'npm token', zhLabel: 'npm 令牌', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { label: 'PyPI token', zhLabel: 'PyPI 令牌', re: /\bpypi-[A-Za-z0-9_-]{50,}\b/ },
  { label: 'AWS access key', zhLabel: 'AWS 访问密钥', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'API key sk-*', zhLabel: 'API 密钥', re: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { label: 'PEM private key block', zhLabel: '私钥块', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |[A-Z ]*)?PRIVATE KEY-----/ },
])

export function isNpmrcFile(fileName) {
  return NPMRC_FILE_RE.test(String(fileName ?? ''))
}

export function isEnvFile(fileName) {
  return ENV_FILE_RE.test(String(fileName ?? ''))
}

/** 识别单行模板字面量中的动态 PEM 插值构造，避免误判为真实静态私钥块。 */
export function isDynamicPemTemplateLine(line) {
  const s = String(line ?? '')
  return /-----BEGIN\b[^\n]*PRIVATE KEY-----/.test(s) && /\$\{[^}]+\}/.test(s)
}

/** 匹配单行凭据正文，自动豁免含 `${...}` 插值的动态 PEM 模板表达。 */
export function matchSecretContentLine(line) {
  const s = String(line ?? '')
  const hits = []
  const dynPem = isDynamicPemTemplateLine(s)
  for (const pat of SECRET_CONTENT_PATTERNS) {
    if (pat.label === 'PEM private key block' && dynPem) continue
    if (pat.re.test(s)) hits.push(pat)
  }
  return hits
}

/**
 * 判定 `.env*` 测试夹具是否为无害占位文件：
 * 仅当位于测试/夹具路径（或 `.env.test`）且正文可读、未命中真实秘钥并均为占位值时返回 `harmless: true`。
 */
export function classifyEnvFixture(relPath, contentText) {
  const norm = String(relPath ?? '').replace(/\\/g, '/')
  const base = norm.split('/').pop() ?? ''
  const isTestFixture = TEST_FIXTURE_PATH_RE.test(norm) || /^\.env\.(?:test|mock|fixture)(?:\..+)?$/i.test(base)
  if (!isTestFixture || typeof contentText !== 'string') {
    return { isTestFixture, harmless: false }
  }
  const lines = contentText.replace(/\r\n/g, '\n').split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (matchSecretContentLine(line).length > 0) {
      return { isTestFixture: true, harmless: false }
    }
    const eq = line.indexOf('=')
    if (eq > 0) {
      const key = line.slice(0, eq).replace(/^export\s+/, '').trim()
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '')
      if (ENV_SENSITIVE_KEY_RE.test(key) && val && !ENV_PLACEHOLDER_VAL_RE.test(val)) {
        return { isTestFixture: true, harmless: false }
      }
    }
  }
  return { isTestFixture: true, harmless: true }
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
 * `.npmrc` 仅当正文命中真实凭据模式（或文本不可读时 fail-closed）才返回 `true`；
 * 测试夹具内的 `.env*` 若正文确认为无害占位符则豁免返回 `false`。
 */
export function isSensitiveSecretFile(fileName, contentText = undefined, relPath = '') {
  const name = String(fileName ?? '')
  if (!SECRET_FILE_RE.test(name) || SAFE_ENV_RE.test(name)) return false
  if (isNpmrcFile(name)) {
    if (typeof contentText !== 'string') return true
    return !isHarmlessNpmrcContent(contentText)
  }
  if (isEnvFile(name) && typeof contentText === 'string') {
    if (classifyEnvFixture(relPath || name, contentText).harmless) return false
  }
  return true
}
