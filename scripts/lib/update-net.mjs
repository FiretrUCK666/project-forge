/**
 * update-net.mjs —— 自更新网络层：代理解析、HTTP/HTTPS CONNECT 下载、Release 探针与包拉取。
 */

import { get as httpGet, request as httpRequest } from 'node:http'
import { get as httpsGet, request as httpsRequest } from 'node:https'
import tls from 'node:tls'

import { apiTarget } from './protocol.mjs'
import { skillVersion } from './text.mjs'
import { decodeTagSegment, plainVersion } from './update-ops.mjs'
import { readZip, stripCommonPrefix } from '../zip.mjs'

export const NETWORK_TIMEOUT_MS = 10 * 1000
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1000
export const ASSET = 'project-forge.zip'

export function matchesNoProxy(hostname, noProxyEnv = '') {
  const host = String(hostname ?? '').toLowerCase()
  const raw = String(noProxyEnv ?? '').trim()
  if (!raw || !host) return false
  for (const token of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (token === '*') return true
    const clean = token.replace(/:\d+$/, '').replace(/^\./, '')
    if (!clean) continue
    if (host === clean || host.endsWith(`.${clean}`)) return true
  }
  return false
}

export function resolveProxyFor(targetUrl, env = process.env) {
  let parsed
  try { parsed = new URL(targetUrl) } catch { return undefined }
  if (matchesNoProxy(parsed.hostname, env.NO_PROXY || env.no_proxy)) return undefined
  const raw = parsed.protocol === 'https:'
    ? (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy)
    : (env.HTTP_PROXY || env.http_proxy)
  const trimmed = String(raw ?? '').trim()
  if (!trimmed) return undefined
  try {
    const pUrl = new URL(trimmed)
    if (pUrl.protocol !== 'http:' && pUrl.protocol !== 'https:') return undefined
    return pUrl
  } catch {
    return undefined
  }
}

export function openRequestThroughProxy(targetParsed, proxyUrl, reqHeaders, signal) {
  const proxyAuth = proxyUrl.username || proxyUrl.password
    ? `Basic ${Buffer.from(`${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`).toString('base64')}`
    : undefined

  if (targetParsed.protocol === 'http:') {
    const pPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80)
    return Promise.resolve({
      request: (proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest)({
        hostname: proxyUrl.hostname,
        port: pPort,
        path: targetParsed.toString(),
        method: 'GET',
        headers: {
          ...reqHeaders,
          Host: targetParsed.host,
          ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}),
        },
        timeout: NETWORK_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      }),
    })
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const targetPort = Number(targetParsed.port) || 443
    const authority = `${targetParsed.hostname}:${targetPort}`
    const proxyPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80)
    const connectReq = (proxyUrl.protocol === 'https:' ? httpsRequest : httpRequest)({
      hostname: proxyUrl.hostname,
      port: proxyPort,
      method: 'CONNECT',
      path: authority,
      headers: {
        Host: authority,
        ...(proxyAuth ? { 'Proxy-Authorization': proxyAuth } : {}),
      },
      timeout: NETWORK_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        rejectPromise(new Error(`proxy CONNECT ${res.statusCode}`))
        return
      }
      const tlsSocket = tls.connect({ socket, servername: targetParsed.hostname })
      const req = httpsRequest({
        hostname: targetParsed.hostname,
        port: targetPort,
        path: `${targetParsed.pathname}${targetParsed.search}`,
        method: 'GET',
        headers: reqHeaders,
        createConnection: () => tlsSocket,
        timeout: NETWORK_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      })
      resolvePromise({ request: req })
    })
    connectReq.on('error', rejectPromise)
    connectReq.on('timeout', () => {
      connectReq.destroy()
      rejectPromise(new Error('proxy CONNECT timeout'))
    })
    connectReq.end()
  })
}

export function download(url, { redirects = 5, accept = '*/*', final, env = process.env } = {}) {
  return new Promise((resolvePromise) => {
    let parsed
    try { parsed = new URL(url) } catch {
      resolvePromise({ ok: false, status: 0, final })
      return
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      resolvePromise({ ok: false, status: 0, final })
      return
    }

    const reqHeaders = { 'user-agent': 'project-forge-update', accept }
    const ghToken = (typeof env?.GH_TOKEN === 'string' && env.GH_TOKEN.trim())
      || (typeof env?.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.trim())
      || ''
    if (ghToken && parsed.hostname.toLowerCase() === 'api.github.com') {
      reqHeaders.Authorization = `Bearer ${ghToken}`
      reqHeaders['X-GitHub-Api-Version'] = '2022-11-28'
    }

    const signal = typeof AbortSignal?.timeout === 'function'
      ? AbortSignal.timeout(NETWORK_TIMEOUT_MS)
      : undefined
    const proxyUrl = resolveProxyFor(url, env)

    const attachHandlers = (request) => {
      request.on('response', (res) => {
        const { statusCode, headers } = res
        const location = headers.location
        if (statusCode !== undefined && statusCode >= 300 && statusCode < 400
          && location !== undefined && redirects > 0) {
          res.resume()
          let next
          try {
            next = new URL(location, url).toString()
          } catch {
            resolvePromise({ ok: false, status: 0, final })
            return
          }
          resolvePromise(download(next, { redirects: redirects - 1, accept, final: next, env }))
          return
        }
        if (statusCode !== 200) {
          res.resume()
          resolvePromise({ ok: false, status: statusCode ?? 0, final })
          return
        }
        const declared = Number(headers['content-length'])
        if (Number.isFinite(declared) && declared > MAX_DOWNLOAD_BYTES) {
          res.resume()
          resolvePromise({ ok: false, status: 0, final, tooLarge: true })
          return
        }
        const chunks = []
        let received = 0
        let aborted = false
        res.on('data', (c) => {
          if (aborted) return
          received += c.length
          if (received > MAX_DOWNLOAD_BYTES) {
            aborted = true
            chunks.length = 0
            res.destroy()
            resolvePromise({ ok: false, status: 0, final, tooLarge: true })
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          if (!aborted) resolvePromise({ ok: true, status: 200, final, body: Buffer.concat(chunks) })
        })
        res.on('error', () => { if (!aborted) resolvePromise({ ok: false, status: 0, final }) })
      })
      request.on('timeout', () => { request.destroy(); resolvePromise({ ok: false, status: 0, final }) })
      request.on('error', () => resolvePromise({ ok: false, status: 0, final }))
      request.end()
    }

    if (proxyUrl) {
      openRequestThroughProxy(parsed, proxyUrl, reqHeaders, signal)
        .then(({ request }) => attachHandlers(request))
        .catch(() => resolvePromise({ ok: false, status: 0, final }))
      return
    }

    const req = (parsed.protocol === 'https:' ? httpsGet : httpGet)(url, {
      headers: reqHeaders,
      timeout: NETWORK_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    })
    attachHandlers(req)
  })
}

export function apiEndpoint(source) {
  return apiTarget(source)?.latest
}

export function routesFor(source) {
  const routes = []
  const api = apiEndpoint(source)
  if (api !== undefined) routes.push({ kind: 'api', endpoint: api })
  routes.push({ kind: 'web', endpoint: `${source}/releases/latest` })
  return routes
}

export function latestPackageUrl(source) {
  return `${source}/releases/latest/download/${ASSET}`
}

export function webPackageUrls(source) {
  return [{ url: latestPackageUrl(source), accept: '*/*' }]
}

export async function probeApi(endpoint, source) {
  const res = await download(endpoint, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }
  let payload
  try {
    payload = JSON.parse(res.body.toString('utf8'))
  } catch {
    return { state: 'unreachable' }
  }
  const version = plainVersion(payload?.tag_name)
  if (version === '') return { state: 'unreachable' }
  const asset = Array.isArray(payload.assets)
    ? payload.assets.find((a) => a?.name === ASSET) : undefined
  const packageUrls = []
  if (typeof asset?.url === 'string' && /^https?:/.test(asset.url)) {
    packageUrls.push({ url: asset.url, accept: 'application/octet-stream' })
  }
  packageUrls.push(...webPackageUrls(source))
  return { state: 'ok', version, packageUrls }
}

export async function probeWeb(endpoint, source) {
  const res = await download(endpoint, { accept: 'application/vnd.github+json' })
  if (!res.ok) return { state: res.status === 404 ? 'absent' : 'unreachable' }

  const fromUrl = /\/releases\/tag\/([^/?#]+)/.exec(res.final ?? '')
  if (fromUrl !== null) {
    const version = decodeTagSegment(fromUrl[1])
    if (version !== '') return { state: 'ok', version, packageUrls: webPackageUrls(source) }
  }

  const text = res.body.toString('utf8')
  if (/^\s*[[{]/.test(text)) {
    try {
      const tag = JSON.parse(text)?.tag_name
      const version = typeof tag === 'string' ? plainVersion(tag) : ''
      if (version !== '') return { state: 'ok', version, packageUrls: webPackageUrls(source) }
    } catch { /* ignore */ }
  }
  return { state: 'absent' }
}

export async function fetchPackage(url, accept = '*/*') {
  const res = await download(url, { accept })
  if (!res.ok) return { ok: false, why: res.status === 404 ? '没有这一版' : '没能取回', status: res.status }
  let entries
  try {
    entries = stripCommonPrefix(readZip(res.body))
  } catch (error) {
    return { ok: false, why: `取回的不是一份能读的包（${error.message}）`, status: 200 }
  }
  const skill = entries.find((e) => e.name === 'SKILL.md')
  if (skill === undefined) return { ok: false, why: '包里没有 SKILL.md', status: 200 }
  return { ok: true, entries, version: skillVersion(skill.data.toString('utf8')) }
}
