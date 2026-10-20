/**
 * Website link metadata for the preview modal's link card.
 *
 * One GET is followed by a 5 s budget, redirects are followed, and at most
 * 512 KiB of the body is read. Only `http:`/`https:` targets are accepted.
 * The function never throws: every failure is reported as `error` on an
 * otherwise well-formed `{ok:true, url, host, ...}` result, so the client can
 * render a plain link card instead of an error state.
 *
 * The fetch implementation is a seam (tests inject one); production uses
 * `globalThis.fetch`. No HTML parser dependency: the handful of `<title>`,
 * `<meta>` and `<link rel=icon>` fields a link card needs are read with
 * bounded regular expressions and entity-decoded.
 *
 * @module dsh-file-preview/host/link
 */

/** Default request budget. */
const DEFAULT_TIMEOUT_MS = 5_000
/** Default body ceiling. */
const DEFAULT_MAX_BYTES = 512 * 1024
/** Longest text field kept from one page. */
const FIELD_LIMIT = 600

const NAMED_ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»',
  copy: '©', reg: '®', trade: '™', middot: '·', bull: '•',
}))

/**
 * Normalize a link target: absolute http(s) URL or null.
 * @param {unknown} raw - raw `url` query value.
 * @returns {URL|null} parsed URL.
 */
export function parseLinkUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url : null
}

/** Decode the HTML entities a title/description realistically contains. */
export function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X'
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES.get(entity.toLowerCase()) ?? match
  })
}

/** Strip tags, decode entities, collapse whitespace, cap length. */
function cleanText(value) {
  if (typeof value !== 'string') return undefined
  const text = decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
  if (text === '') return undefined
  return text.length > FIELD_LIMIT ? text.slice(0, FIELD_LIMIT) : text
}

/** Resolve one href against the page URL; undefined when unusable. */
function resolveUrl(href, baseUrl) {
  if (typeof href !== 'string' || href.trim() === '') return undefined
  try {
    return new URL(href.trim(), baseUrl).href
  } catch {
    return undefined
  }
}

/** Parse the attributes of one tag (quoted, single-quoted or bare values). */
function parseAttributes(tag) {
  const attributes = new Map()
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g
  let match
  while ((match = pattern.exec(tag)) !== null) {
    attributes.set(match[1].toLowerCase(), match[3] ?? match[4] ?? match[5] ?? '')
  }
  return attributes
}

/**
 * Extract the link-card fields from one HTML document.
 * @param {string} html - decoded document text.
 * @param {string} pageUrl - final (redirected) URL used to resolve relative refs.
 * @returns {{title?: string, description?: string, siteName?: string, icon?: string, image?: string}} fields.
 */
export function parseLinkMetadata(html, pageUrl) {
  const document = typeof html === 'string' ? html : ''
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(document)
  const openGraph = new Map()
  const named = new Map()
  for (const tag of document.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag)
    const content = attributes.get('content')
    if (content === undefined) continue
    const property = attributes.get('property') ?? attributes.get('name') ?? attributes.get('itemprop')
    if (property === undefined) continue
    const key = property.toLowerCase()
    if (!openGraph.has(key)) openGraph.set(key, content)
    if (!named.has(key)) named.set(key, content)
  }
  let icon
  for (const tag of document.match(/<link\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag)
    const rel = (attributes.get('rel') ?? '').toLowerCase()
    if (!rel.split(/\s+/).includes('icon')) continue
    const href = resolveUrl(attributes.get('href'), pageUrl)
    if (href !== undefined) {
      icon = href
      break
    }
  }
  const title = cleanText(openGraph.get('og:title') ?? named.get('twitter:title') ?? titleMatch?.[1])
  const description = cleanText(
    openGraph.get('og:description')
    ?? named.get('description')
    ?? named.get('twitter:description'),
  )
  const siteName = cleanText(openGraph.get('og:site_name'))
  const image = resolveUrl(
    openGraph.get('og:image:secure_url') ?? openGraph.get('og:image') ?? named.get('twitter:image'),
    pageUrl,
  )
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(siteName === undefined ? {} : { siteName }),
    icon: icon ?? resolveUrl('/favicon.ico', pageUrl),
    ...(image === undefined ? {} : { image }),
  }
}

/** Decode a fetched body using the declared charset, with a UTF-8 default. */
function decodeBody(bytes, contentType) {
  const charset = /charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType ?? '')?.[1]?.toLowerCase()
  const candidates = []
  if (charset !== undefined) {
    if (charset === 'utf-8' || charset === 'utf8') candidates.push('utf-8')
    else if (charset === 'windows-1251' || charset === 'cp1251') candidates.push('windows-1251')
    else if (charset === 'iso-8859-1' || charset === 'latin1' || charset === 'us-ascii') candidates.push('windows-1252')
  }
  candidates.push('utf-8')
  for (const candidate of candidates) {
    try {
      return new TextDecoder(candidate, { fatal: false }).decode(bytes)
    } catch {
      // Encoding not available in this Node build: try the next candidate.
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Read at most `maxBytes` of a fetch Response body. */
async function readCappedBody(response, maxBytes) {
  const body = response?.body
  if (body !== null && typeof body === 'object' && typeof body.getReader === 'function') {
    const reader = body.getReader()
    const chunks = []
    let size = 0
    let truncated = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = value instanceof Uint8Array ? value : Buffer.from(value)
        if (size + chunk.byteLength > maxBytes) {
          chunks.push(Buffer.from(chunk).subarray(0, maxBytes - size))
          size = maxBytes
          truncated = true
          await reader.cancel().catch(() => {})
          break
        }
        chunks.push(Buffer.from(chunk))
        size += chunk.byteLength
      }
    } finally {
      try {
        reader.releaseLock?.()
      } catch {
        // Already released by cancel().
      }
    }
    return { bytes: Buffer.concat(chunks, size), truncated }
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  return { bytes: buffer.subarray(0, maxBytes), truncated: buffer.length > maxBytes }
}

/**
 * Fetch link metadata for one URL. Never throws.
 * @param {object} request - request facts.
 * @param {string} request.url - raw http(s) URL.
 * @param {Function} [request.fetchImpl] - fetch implementation seam.
 * @param {number} [request.timeoutMs] - request budget.
 * @param {number} [request.maxBytes] - body ceiling.
 * @returns {Promise<object>} `{ok:true, url, host, title?, ...}` or `{ok:false, code:'bad-url'}`.
 */
export async function fetchLinkMetadata(request) {
  const parsed = parseLinkUrl(request.url)
  if (parsed === null) return { ok: false, code: 'bad-url' }
  const base = { ok: true, url: parsed.href, host: parsed.host }
  const fetchImpl = request.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ...base, error: 'fetch-unavailable' }
  const timeoutMs = Number.isFinite(request.timeoutMs) ? request.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxBytes = Number.isFinite(request.maxBytes) ? request.maxBytes : DEFAULT_MAX_BYTES
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let response
    try {
      response = await fetchImpl(parsed.href, {
        method: 'GET',
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
          'accept-language': 'en;q=0.8,ru;q=0.7',
          'user-agent': 'dsh-file-preview/0.1 (local DSH plugin)',
        },
      })
    } catch (error) {
      const aborted = controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
      return { ...base, error: aborted ? 'timeout' : (error instanceof Error ? error.message : String(error)) }
    }
    const finalUrl = typeof response?.url === 'string' && response.url !== '' ? response.url : parsed.href
    const contentType = String(response?.headers?.get?.('content-type') ?? '')
    const status = Number(response?.status ?? 0)
    if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return { ...base, ...(response?.ok === false ? { error: `http-${String(status)}` } : { error: 'not-html' }) }
    }
    let body
    try {
      body = await readCappedBody(response, maxBytes)
    } catch (error) {
      const aborted = controller.signal.aborted
      return { ...base, error: aborted ? 'timeout' : (error instanceof Error ? error.message : String(error)) }
    }
    const fields = parseLinkMetadata(decodeBody(body.bytes, contentType), finalUrl)
    return {
      ...base,
      ...fields,
      ...(body.truncated ? { truncated: true } : {}),
      ...(response?.ok === false ? { error: `http-${String(status)}` } : {}),
    }
  } finally {
    clearTimeout(timer)
  }
}
