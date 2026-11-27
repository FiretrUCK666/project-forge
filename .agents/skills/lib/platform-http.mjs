/**
 * platform-http.mjs —— 多远端平台零依赖安全 HTTP/HTTPS 与二进制安全 Multipart 传输内核。
 *
 * 严格零第三方依赖（仅 Node 18+ 内置模块），核心安全不变量：
 * 1. 公网 `http://` 与云元数据/链路本地地址（`169.254.0.0/16`、`fe80::/10`）一律 Fail-Closed 拦截；
 * 2. 仅允许 loopback（`127.0.0.1`/`::1`/`localhost`）或 RFC1918 私有局域网网段走明文 `http://`；
 * 3. 全量显式设置 `AbortSignal.timeout`、`redirect: 'manual'`，遇 3xx 拒跟并对 `Location` 与异常全量脱敏；
 * 4. Multipart 上传采用随机 boundary、filename 清洗与纯 `Buffer.concat` 二进制拼接，绝不经 UTF-8 损毁二进制字节。
 */

import { randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'

import {
  MAX_RETRY_DELAY_MS,
  isRetryableHttpOutcome,
  parseRetryAfterMs,
  redactPlatformTokens,
} from './github-parse.mjs'

export { MAX_RETRY_DELAY_MS, isRetryableHttpOutcome, parseRetryAfterMs, redactPlatformTokens }

export const DEFAULT_HTTP_TIMEOUT_MS = 10000

const FOUR_BYTE_CHAR_RE = /[\u{10000}-\u{10FFFF}]/gu
const BLOCKED_META_HOSTS = Object.freeze(new Set([
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]))

function normalizeHostname(rawHost) {
  let h = String(rawHost ?? '').trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  const zoneIdx = h.indexOf('%')
  if (zoneIdx >= 0) h = h.slice(0, zoneIdx)
  return h
}

function parseIpv4Octets(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const octets = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return octets.every((n) => n >= 0 && n <= 255) ? octets : null
}

function extractMappedIpv4(host) {
  const mappedDec = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(host)
  if (mappedDec) return parseIpv4Octets(mappedDec[1])
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host)
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]
  }
  return null
}

/** 判定主机是否属于云元数据或链路本地地址（无论 HTTP 或 HTTPS 均须 Fail-Closed 拦截）。 */
export function isBlockedMetaOrLinkLocalHost(rawHost) {
  const host = normalizeHostname(rawHost)
  if (!host) return true
  if (BLOCKED_META_HOSTS.has(host)) return true
  if (host === '0.0.0.0' || host === '::' || host === '0:0:0:0:0:0:0:0') return true
  if (host === 'fd00:ec2::254') return true

  const v4 = parseIpv4Octets(host) ?? extractMappedIpv4(host)
  if (v4) {
    // 169.254.0.0/16（含 AWS/GCP/Azure 云元数据 169.254.169.254）与 0.0.0.0/8
    if (v4[0] === 169 && v4[1] === 254) return true
    if (v4[0] === 0) return true
    return false
  }

  if (isIP(host) === 6) {
    // fe80::/10 链路本地 IPv6（fe80..febf）
    const firstGroup = host.split(':')[0]
    if (/^fe[89ab][0-9a-f]?$/i.test(firstGroup) && firstGroup.length === 4) return true
  }
  return false
}

/** 判定主机是否为本机回环地址（localhost / 127.0.0.0/8 / ::1）。 */
export function isLoopbackHost(rawHost) {
  const host = normalizeHostname(rawHost)
  if (!host) return false
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true
  const v4 = parseIpv4Octets(host) ?? extractMappedIpv4(host)
  return Boolean(v4 && v4[0] === 127)
}

/** 判定主机是否为 RFC1918 私有局域网 IP（10/8、172.16/12、192.168/16）。 */
export function isRfc1918Host(rawHost) {
  const host = normalizeHostname(rawHost)
  if (!host) return false
  const v4 = parseIpv4Octets(host) ?? extractMappedIpv4(host)
  if (!v4) return false
  if (v4[0] === 10) return true
  if (v4[0] === 172 && v4[1] >= 16 && v4[1] <= 31) return true
  if (v4[0] === 192 && v4[1] === 168) return true
  return false
}

/** 判定主机是否为合法局域网/回环目标（已排除链路本地与云元地址）。 */
export function isLanHost(rawHost) {
  if (isBlockedMetaOrLinkLocalHost(rawHost)) return false
  return isLoopbackHost(rawHost) || isRfc1918Host(rawHost)
}

/** 校验目标请求 URL 的传输协议与 SSRF 边界（公网明文 http:// 与云元地址一律 Fail-Closed 拦截）。 */
export function validateRequestUrl(rawUrl, { allowInsecureLan = true } = {}) {
  let parsed
  try {
    parsed = new URL(String(rawUrl ?? ''))
  } catch {
    return { ok: false, code: 'ERR_INVALID_URL', message: `非法的请求 URL：${redactPlatformTokens(rawUrl)}` }
  }

  const proto = parsed.protocol.toLowerCase()
  if (proto !== 'https:' && proto !== 'http:') {
    return { ok: false, code: 'ERR_UNSUPPORTED_PROTOCOL', message: `不支持的传输协议：${proto}` }
  }

  const hostname = normalizeHostname(parsed.hostname)
  if (isBlockedMetaOrLinkLocalHost(hostname)) {
    return {
      ok: false,
      code: 'ERR_BLOCKED_LINK_LOCAL_OR_META',
      message: `出于 SSRF 安全边界，已拦截链路本地或云元数据目标：${hostname}`,
    }
  }

  const isLocalOrPrivate = isLoopbackHost(hostname) || isRfc1918Host(hostname)
  if (proto === 'http:') {
    if (!allowInsecureLan || !isLocalOrPrivate) {
      return {
        ok: false,
        code: 'ERR_INSECURE_PUBLIC_HTTP',
        message: `禁止对公网或未授权主机发送明文 HTTP 请求（仅允许 loopback/RFC1918 局域网）：${hostname}`,
      }
    }
  }

  return {
    ok: true,
    url: parsed,
    hostname,
    isHttp: proto === 'http:',
    isLan: isLocalOrPrivate,
  }
}

/** 检测文本是否包含 UTF-8 四字节字符（U+10000..U+10FFFF）。 */
export function hasFourByteChars(text) {
  FOUR_BYTE_CHAR_RE.lastIndex = 0
  return FOUR_BYTE_CHAR_RE.test(String(text ?? ''))
}

/** 安全替换非 BMP 四字节字符，避免部分托管平台 MySQL utf8（3 字节）接口写入报错。 */
export function sanitizeFourByteChars(text, replacement = '') {
  return String(text ?? '').replace(FOUR_BYTE_CHAR_RE, String(replacement ?? ''))
}

/** 递归清洗对象/数组中的全部字符串字段，移除四字节字符。 */
export function sanitizePayloadFourByteChars(value, replacement = '') {
  if (typeof value === 'string') return sanitizeFourByteChars(value, replacement)
  if (Array.isArray(value)) return value.map((item) => sanitizePayloadFourByteChars(item, replacement))
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = sanitizePayloadFourByteChars(v, replacement)
    }
    return out
  }
  return value
}

/** 清洗 Multipart `filename` 参数：剥离路径段、CRLF、控制字符、引号与反斜杠防头注入。 */
export function sanitizeMultipartFilename(filename) {
  const raw = String(filename ?? '')
  const base = raw.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[\r\n\0\x00-\x1f\x7f"\\]/g, '')
    .trim()
  return cleaned || 'attachment.bin'
}

function sanitizeHeaderParam(value, fallback) {
  const cleaned = String(value ?? '').replace(/[\r\n\0\x00-\x1f\x7f"\\]/g, '').trim()
  return cleaned || fallback
}

/**
 * 构造纯 `Buffer.concat` 二进制安全的 `multipart/form-data` 请求体。
 * 使用随机 boundary 并清洗 filename/fieldName，确保二进制图片零 UTF-8 损毁。
 */
export function buildMultipartBody({
  fieldName = 'file',
  filename = 'attachment.bin',
  contentType = 'application/octet-stream',
  buffer,
  fields = {},
} = {}) {
  const boundary = `----pfFormBoundary${randomBytes(16).toString('hex')}`
  const safeField = sanitizeHeaderParam(fieldName, 'file')
  const safeFilename = sanitizeMultipartFilename(filename)
  const safeMime = sanitizeHeaderParam(contentType, 'application/octet-stream')
  const fileBuf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? '')

  const parts = []
  if (fields && typeof fields === 'object') {
    for (const [key, val] of Object.entries(fields)) {
      if (val === undefined || val === null) continue
      const k = sanitizeHeaderParam(key, '')
      if (!k) continue
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${String(val)}\r\n`,
          'utf8',
        ),
      )
    }
  }

  const headBuf = Buffer.from(
    `--${boundary}\r\n`
    + `Content-Disposition: form-data; name="${safeField}"; filename="${safeFilename}"\r\n`
    + `Content-Type: ${safeMime}\r\n\r\n`,
    'utf8',
  )
  const tailBuf = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const body = Buffer.concat([...parts, headBuf, fileBuf, tailBuf])

  return {
    boundary,
    filename: safeFilename,
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength: body.length,
    body,
  }
}

function redactResponseHeaders(headers = {}) {
  const out = {}
  for (const [k, v] of Object.entries(headers ?? {})) {
    const low = k.toLowerCase()
    if (low === 'location' || low === 'authorization' || low === 'set-cookie') {
      out[k] = Array.isArray(v) ? v.map((item) => redactPlatformTokens(item)) : redactPlatformTokens(v)
    } else {
      out[k] = v
    }
  }
  return out
}

/**
 * 零依赖统一 HTTP/HTTPS 请求原语：
 * - Fail-Closed 拦截公网 `http://` 与 `169.254.0.0/16`/`fe80::/10` 元地址；
 * - 显式绑定 `AbortSignal.timeout`；
 * - 强制 `redirect: 'manual'` 拒跟 3xx 并对 `Location` 脱敏。
 */
export function platformHttpRequest({
  method = 'GET',
  url,
  headers = {},
  body,
  rawBody,
  contentType,
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  allowInsecureLan = true,
  redirect = 'manual',
} = {}) {
  const check = validateRequestUrl(url, { allowInsecureLan })
  if (!check.ok) {
    return Promise.resolve({
      ok: false,
      status: 0,
      blocked: true,
      code: check.code,
      headers: {},
      text: '',
      data: { message: redactPlatformTokens(check.message) },
    })
  }

  return new Promise((done) => {
    let settled = false
    const finish = (res) => { if (!settled) { settled = true; done(res) } }

    const parsed = check.url
    const transport = check.isHttp ? http : https
    const effectiveRedirect = redirect === 'manual' ? 'manual' : 'manual'

    let payload = null
    const reqHeaders = { 'User-Agent': 'project-forge', ...headers }
    if (rawBody !== undefined && rawBody !== null) {
      payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)
      if (contentType && !reqHeaders['Content-Type']) reqHeaders['Content-Type'] = contentType
      reqHeaders['Content-Length'] = String(payload.length)
    } else if (body !== undefined && body !== null) {
      const serialized = typeof body === 'string' ? body : JSON.stringify(body)
      payload = Buffer.from(serialized, 'utf8')
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = contentType || 'application/json; charset=utf-8'
      }
      reqHeaders['Content-Length'] = String(payload.length)
    }

    const signal = timeoutMs > 0 && typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(timeoutMs)
      : undefined

    const req = transport.request({
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (check.isHttp ? 80 : 443),
      path: `${parsed.pathname}${parsed.search}`,
      method: String(method).toUpperCase(),
      headers: reqHeaders,
      timeout: timeoutMs,
      redirect: effectiveRedirect,
      ...(signal ? { signal } : {}),
    }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const status = res.statusCode ?? 0
        const resHeaders = redactResponseHeaders(res.headers ?? {})
        if (status >= 300 && status < 400) {
          const safeLocation = resHeaders.location ? redactPlatformTokens(resHeaders.location) : null
          finish({
            ok: false,
            status,
            headers: resHeaders,
            isRedirect: true,
            redirectLocation: safeLocation,
            text: '',
            data: { message: `Redirect rejected (HTTP ${status})${safeLocation ? ` -> ${safeLocation}` : ''}` },
          })
          return
        }
        const text = Buffer.concat(chunks).toString('utf8')
        let data = null
        try { data = text ? JSON.parse(text) : null } catch { data = text }
        finish({
          ok: status >= 200 && status < 300,
          status,
          headers: resHeaders,
          text,
          data,
        })
      })
    })

    req.on('timeout', () => {
      req.destroy()
      finish({
        ok: false,
        status: 408,
        timedOut: true,
        code: 'ETIMEDOUT',
        headers: {},
        text: '',
        data: { message: 'Platform HTTP request timeout' },
      })
    })

    req.on('error', (err) => {
      const isAbort = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      finish({
        ok: false,
        status: isAbort ? 408 : 0,
        timedOut: isAbort,
        code: err?.code ?? (isAbort ? 'ETIMEDOUT' : null),
        headers: {},
        text: '',
        data: { message: redactPlatformTokens(err?.message ?? 'request-error') },
      })
    })

    if (payload) req.write(payload)
    req.end()
  })
}

function defaultSleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}

/** 统一 HTTP 重试退避执行器（遵守 429 Retry-After 上限、拒跟 3xx、绝不重试 4xx 非 408/429）。 */
export async function requestWithRetry(fn, {
  maxRetries = 2,
  retryBaseDelayMs = 150,
  maxRetryDelayMs = MAX_RETRY_DELAY_MS,
  sleep = defaultSleep,
} = {}) {
  const retries = Math.max(0, Number(maxRetries ?? 2))
  const capMs = Math.min(MAX_RETRY_DELAY_MS, Math.max(0, Number(maxRetryDelayMs ?? MAX_RETRY_DELAY_MS)))
  let lastOutcome = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let outcome
    try {
      outcome = await fn()
    } catch (err) {
      outcome = {
        ok: false,
        status: Number(err?.status ?? 0),
        code: err?.code ?? null,
        name: err?.name ?? null,
        timedOut: Boolean(err?.timedOut),
        headers: err?.headers ?? {},
        data: { message: redactPlatformTokens(err?.message ?? 'request-error') },
      }
    }
    if (outcome && outcome.status >= 300 && outcome.status < 400) {
      const safeLoc = outcome.redirectLocation
        ? redactPlatformTokens(outcome.redirectLocation)
        : (outcome.headers?.location ? redactPlatformTokens(outcome.headers.location) : null)
      return {
        ok: false,
        status: outcome.status,
        headers: redactResponseHeaders(outcome.headers ?? {}),
        isRedirect: true,
        redirectLocation: safeLoc,
        data: { message: `Redirect rejected (HTTP ${outcome.status})${safeLoc ? ` -> ${safeLoc}` : ''}` },
      }
    }
    lastOutcome = outcome
    if (outcome?.ok || outcome?.blocked || attempt >= retries || !isRetryableHttpOutcome(outcome)) {
      return outcome
    }
    const retryAfterMs = parseRetryAfterMs(outcome.headers, capMs)
    const expMs = Math.min(capMs, Math.max(0, Number(retryBaseDelayMs ?? 150)) * (2 ** attempt))
    const waitMs = retryAfterMs !== null ? Math.min(capMs, retryAfterMs) : expMs
    if (waitMs > 0) await sleep(waitMs)
  }
  return lastOutcome
}
