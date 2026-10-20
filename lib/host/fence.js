/**
 * Request fence and JSON responder for the file-preview routes.
 *
 * Every route answers only a loopback caller: the socket peer must be in
 * 127/8, ::1 or IPv4-mapped 127/8; the `Host` header must name a loopback
 * host (defeats DNS rebinding); `sec-fetch-site`, when a browser sends it,
 * must be same-origin, same-site or none; and an `Origin`, when present, must
 * equal the `Host`. POST additionally requires `application/json`.
 *
 * The shapes mirror the shipped host-route pattern (`dsh-host-open-in-app`)
 * and the local `dsh-tinyfish-wallet` route, both of which answer JSON with
 * `no-store` and refuse anything the browser would send cross-site.
 *
 * This module is pure request/response plumbing; it never touches the
 * filesystem.
 *
 * @module dsh-file-preview/host/fence
 */

/** `sec-fetch-site` values a same-origin (or non-browser) caller may carry. */
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'same-site', 'none'])

/** IPv4 127/8 predicate. */
export function isIPv4Loopback(value) {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket remote address names the loopback range.
 * @param {string|undefined} address - `req.socket.remoteAddress`.
 * @returns {boolean} true for 127/8, ::1 and IPv4-mapped 127/8.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string' || address === '') return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * Parse one `Host`/`Origin` authority as loopback.
 * @param {string} authority - host header value or URL authority.
 * @returns {{host: string, hostname: string}|null} parsed authority, null when not loopback.
 */
function loopbackAuthority(authority) {
  if (typeof authority !== 'string' || authority === '') return null
  let parsed
  try {
    parsed = new URL('http://' + authority)
  } catch {
    return null
  }
  const hostname = parsed.hostname
  const loopback = hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname)
  return loopback ? { host: parsed.host, hostname } : null
}

/**
 * Request-level trust fence shared by every route.
 * @param {import('node:http').IncomingMessage} request - incoming HTTP request.
 * @returns {boolean} true when the request may reach a file-preview route.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const hostHeader = request.headers.host
  if (typeof hostHeader !== 'string') return false
  const host = loopbackAuthority(hostHeader)
  if (host === null) return false
  const fetchSite = request.headers['sec-fetch-site']
  if (typeof fetchSite === 'string' && fetchSite !== '' && !ALLOWED_FETCH_SITES.has(fetchSite)) return false
  const origin = request.headers.origin
  if (origin === undefined || origin === '') return true
  let originUrl
  try {
    originUrl = new URL(origin)
  } catch {
    return false
  }
  return originUrl.host === host.host
}

/**
 * Write one JSON response with the route family's headers.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
export function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(payload)
}

/**
 * Answer 405 with the allow header.
 * @param {import('node:http').ServerResponse} res - response.
 * @param {string} allow - comma-separated method list.
 */
export function sendMethodNotAllowed(res, allow) {
  res.writeHead(405, { allow, 'cache-control': 'no-store' })
  res.end()
}

/**
 * Media type of a request body, without parameters.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {string} lower-case media type or ''.
 */
export function requestMediaType(request) {
  const raw = request.headers['content-type']
  if (typeof raw !== 'string') return ''
  return raw.split(';', 1)[0].trim().toLowerCase()
}

/**
 * Collect a bounded request body as UTF-8 text; null past the ceiling.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @param {number} maxBytes - body ceiling.
 * @returns {Promise<string|null>} body text, null when too large.
 */
export async function readBoundedBody(request, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.byteLength
    if (size > maxBytes) {
      request.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/**
 * Parse a loopback JSON POST body into an object.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @param {number} maxBytes - body ceiling.
 * @returns {Promise<{ok: true, body: Record<string, unknown>}|{ok: false, status: number, code: string}>} parsed body or typed failure.
 */
export async function readJsonObject(request, maxBytes) {
  let text
  try {
    text = await readBoundedBody(request, maxBytes)
  } catch {
    return { ok: false, status: 400, code: 'bad-request' }
  }
  if (text === null) return { ok: false, status: 413, code: 'payload-too-large' }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, status: 400, code: 'bad-request' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, status: 400, code: 'bad-request' }
  }
  return { ok: true, body }
}

/**
 * Whether one request carries the JSON content type a POST route requires.
 * @param {import('node:http').IncomingMessage} request - incoming request.
 * @returns {boolean} true for `application/json` (parameters allowed).
 */
export function isJsonRequest(request) {
  return requestMediaType(request) === 'application/json'
}
