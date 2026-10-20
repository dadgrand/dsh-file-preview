/**
 * The eight file-preview route handlers.
 *
 * Each handler is plain `node:http` (the carrier `ctx.webServer.register`
 * expects) and speaks the fixed JSON/bytes contract the browser half is
 * written against. The shared fence, method gate and `?seat=` recording live
 * in `app.js`; this module owns the route semantics only.
 *
 * @module dsh-file-preview/host/routes
 */

import { constants as fsConstants, createReadStream, promises as fsp } from 'node:fs'
import { basename } from 'node:path'
import { SUPPORTED_ACTIONS, performAction } from './actions.js'
import {
  contentTypeFor,
  extensionOf,
  isBinaryPreviewKind,
  mimeFor,
  officeExtensionFor,
  previewKind,
} from './mime.js'
import { fetchLinkMetadata, parseLinkUrl } from './link.js'
import { isPlainBasename, resolveByName } from './resolve.js'
import { isJsonRequest, readJsonObject, sendJson } from './fence.js'

/** Default text preview ceiling (bytes). */
const DEFAULT_TEXT_MAX_BYTES = 512 * 1024
/** Absolute text preview ceiling. */
const MAX_TEXT_BYTES = 8 * 1024 * 1024
/** POST /action body ceiling. */
const MAX_ACTION_BODY_BYTES = 64 * 1024

/** Map a path-policy failure to the route's HTTP status. */
function sendPolicyFailure(res, code) {
  if (code === 'outside-allowed-roots') {
    sendJson(res, 403, { ok: false, code })
    return
  }
  sendJson(res, 400, { ok: false, code: 'bad-path' })
}

/** Map a stat failure to a typed route failure. */
function statFailure(res, status, error) {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    sendJson(res, 404, { ok: false, code: 'not-found', message: 'path does not exist' })
    return
  }
  status.fail('stat', 'stat-failed', error instanceof Error ? error.message : String(error))
  sendJson(res, 500, { ok: false, code: 'stat-failed', message: error instanceof Error ? error.message : String(error) })
}

/** `filename*=UTF-8''…` plus an ASCII fallback for old clients. */
function contentDisposition(disposition, name) {
  const ascii = String(name).replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_')
  const encoded = encodeURIComponent(String(name)).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/**
 * Parse one `Range` header against a known size.
 * @param {unknown} header - raw `range` header.
 * @param {number} size - complete representation size.
 * @returns {{start: number, end: number}|{invalid: true}|null} byte range, invalid, or no range.
 */
export function parseRangeHeader(header, size) {
  if (typeof header !== 'string' || !/^bytes=/i.test(header)) return null
  const spec = header.slice(6).split(',', 1)[0]?.trim() ?? ''
  const match = /^(\d*)-(\d*)$/.exec(spec)
  if (match === null || size <= 0) return { invalid: true }
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return { invalid: true }
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true }
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  const start = Number(rawStart)
  const requestedEnd = rawEnd === '' ? size - 1 : Number(rawEnd)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return { invalid: true }
  if (start >= size || start > requestedEnd) return { invalid: true }
  return { start, end: Math.min(requestedEnd, size - 1) }
}

/** Cheap binary sniff for text previews. */
export function looksBinary(buffer, kind) {
  if (isBinaryPreviewKind(kind)) return true
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0)) return true
  let control = 0
  for (const byte of sample) {
    if (byte < 7 || (byte > 13 && byte < 32)) control += 1
  }
  return sample.length > 0 && control / sample.length > 0.15
}

/** Decode text as UTF-8, falling back to Windows-1251 when UTF-8 breaks. */
export function decodeText(buffer) {
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  const replacements = (utf8.match(/\uFFFD/g) ?? []).length
  if (replacements === 0) return { text: utf8, encoding: 'utf-8' }
  try {
    const cp1251 = new TextDecoder('windows-1251', { fatal: false }).decode(buffer)
    const cp1251Replacements = (cp1251.match(/\uFFFD/g) ?? []).length
    if (cp1251Replacements < replacements) return { text: cp1251, encoding: 'windows-1251' }
  } catch {
    // No Windows-1251 decoder in this Node build: keep the UTF-8 text.
  }
  return { text: utf8, encoding: 'utf-8' }
}

/** Read the first `limit + 1` bytes of one file. */
async function readHead(absPath, limit) {
  const handle = await fsp.open(absPath, 'r')
  try {
    const info = await handle.stat()
    const length = Math.min(info.size, limit + 1)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return { buffer: buffer.subarray(0, bytesRead), size: info.size }
  } finally {
    await handle.close()
  }
}

/** Parse a positive integer query value with a default and an upper clamp. */
function positiveInteger(raw, fallback, maximum) {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) return fallback
  return Math.min(value, maximum)
}

/**
 * Build the route handlers over one app context.
 * @param {object} context - app context (policy, office, status, seams).
 * @returns {Record<string, Function>} handlers keyed by route name.
 */
export function createRouteHandlers(context) {
  const { policy, office, status, platform } = context

  /** GET /meta */
  async function meta(req, res, url) {
    status.count('meta')
    const resolved = await policy.readPath(url.searchParams.get('path'), url.searchParams.get('cwd'))
    if (!resolved.ok) {
      status.fail('meta', resolved.code)
      sendPolicyFailure(res, resolved.code)
      return
    }
    let info
    try {
      info = await fsp.stat(resolved.absPath)
    } catch (error) {
      statFailure(res, status, error)
      return
    }
    const name = basename(resolved.absPath)
    if (info.isDirectory()) {
      sendJson(res, 200, {
        ok: true,
        path: resolved.input,
        absPath: resolved.absPath,
        name,
        ext: '',
        kind: 'directory',
        mime: 'inode/directory',
        size: info.size,
        mtimeMs: info.mtimeMs,
        preview: 'none',
        canRead: false,
        reason: 'directory',
      })
      return
    }
    if (!info.isFile()) {
      sendJson(res, 200, {
        ok: true,
        path: resolved.input,
        absPath: resolved.absPath,
        name,
        ext: '',
        kind: 'other',
        mime: 'application/octet-stream',
        size: info.size,
        mtimeMs: info.mtimeMs,
        preview: 'none',
        canRead: false,
        reason: 'not-a-file',
      })
      return
    }
    const ext = extensionOf(name)
    const preview = previewKind(name)
    const officeExt = officeExtensionFor(ext)
    let canRead = preview !== 'none'
    let reason
    if (!canRead) {
      reason = 'unsupported-format'
    } else {
      try {
        await fsp.access(resolved.absPath, fsConstants.R_OK)
      } catch {
        canRead = false
        reason = 'not-readable'
      }
    }
    sendJson(res, 200, {
      ok: true,
      path: resolved.input,
      absPath: resolved.absPath,
      name,
      ext,
      kind: 'file',
      mime: preview === 'text' && ext === '' ? 'text/plain' : mimeFor(ext),
      size: info.size,
      mtimeMs: info.mtimeMs,
      preview,
      ...(officeExt === null ? {} : { officeExt }),
      canRead,
      ...(reason === undefined ? {} : { reason }),
    })
  }

  /** GET/HEAD /raw */
  async function raw(req, res, url) {
    status.count('raw')
    const resolved = await policy.readPath(url.searchParams.get('path'), url.searchParams.get('cwd'))
    if (!resolved.ok) {
      status.fail('raw', resolved.code)
      sendPolicyFailure(res, resolved.code)
      return
    }
    let info
    try {
      info = await fsp.stat(resolved.absPath)
    } catch (error) {
      statFailure(res, status, error)
      return
    }
    if (!info.isFile()) {
      sendJson(res, 400, { ok: false, code: 'not-a-file' })
      return
    }
    const name = basename(resolved.absPath)
    const ext = extensionOf(name)
    const download = url.searchParams.get('download') === '1'
    const range = parseRangeHeader(req.headers.range, info.size)
    const headers = {
      'content-type': contentTypeFor(ext),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=30',
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition(download ? 'attachment' : 'inline', name),
    }
    if (range !== null && 'invalid' in range) {
      res.writeHead(416, {
        'content-range': `bytes */${String(info.size)}`,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end()
      return
    }
    const start = range === null ? 0 : range.start
    const end = range === null ? info.size - 1 : range.end
    const length = info.size === 0 ? 0 : end - start + 1
    if (range !== null) headers['content-range'] = `bytes ${String(start)}-${String(end)}/${String(info.size)}`
    headers['content-length'] = length
    res.writeHead(range === null ? 200 : 206, headers)
    if (req.method === 'HEAD' || length === 0) {
      res.end()
      return
    }
    const stream = createReadStream(resolved.absPath, { start, end })
    stream.on('error', error => {
      status.fail('raw', 'stream-failed', error instanceof Error ? error.message : String(error))
      if (res.headersSent) res.destroy()
      else sendJson(res, 500, { ok: false, code: 'stream-failed' })
    })
    stream.pipe(res)
  }

  /** GET /text */
  async function text(req, res, url) {
    status.count('text')
    const resolved = await policy.readPath(url.searchParams.get('path'), url.searchParams.get('cwd'))
    if (!resolved.ok) {
      status.fail('text', resolved.code)
      sendPolicyFailure(res, resolved.code)
      return
    }
    let info
    try {
      info = await fsp.stat(resolved.absPath)
    } catch (error) {
      statFailure(res, status, error)
      return
    }
    if (!info.isFile()) {
      sendJson(res, 400, { ok: false, code: 'not-a-file' })
      return
    }
    const maxBytes = positiveInteger(url.searchParams.get('maxBytes'), DEFAULT_TEXT_MAX_BYTES, MAX_TEXT_BYTES)
    let head
    try {
      head = await readHead(resolved.absPath, maxBytes)
    } catch (error) {
      statFailure(res, status, error)
      return
    }
    const preview = previewKind(resolved.absPath)
    if (looksBinary(head.buffer, preview)) {
      sendJson(res, 200, { ok: false, code: 'binary', bytes: head.buffer.length })
      return
    }
    const truncated = head.size > maxBytes
    const buffer = truncated ? head.buffer.subarray(0, maxBytes) : head.buffer
    const decoded = decodeText(buffer)
    sendJson(res, 200, {
      ok: true,
      text: decoded.text,
      truncated,
      encoding: decoded.encoding,
      bytes: buffer.length,
    })
  }

  /** GET /office-pdf */
  async function officePdf(req, res, url) {
    status.count('office')
    const resolved = await policy.readPath(url.searchParams.get('path'), url.searchParams.get('cwd'))
    if (!resolved.ok) {
      status.fail('office', resolved.code)
      sendPolicyFailure(res, resolved.code)
      return
    }
    let info
    try {
      info = await fsp.stat(resolved.absPath)
    } catch (error) {
      statFailure(res, status, error)
      return
    }
    if (!info.isFile()) {
      sendJson(res, 400, { ok: false, code: 'not-a-file' })
      return
    }
    const name = basename(resolved.absPath)
    const ext = extensionOf(name)
    if (officeExtensionFor(ext) === null) {
      status.fail('office', 'not-office')
      sendJson(res, 415, { ok: false, code: 'not-office' })
      return
    }
    const result = await office.convert({
      absPath: resolved.absPath,
      stat: { mtimeMs: info.mtimeMs, size: info.size },
      extension: ext,
    })
    if (!result.ok) {
      status.fail('office', result.code, result.message ?? null)
      if (result.code === 'office-unavailable') {
        sendJson(res, 501, { ok: false, code: 'office-unavailable', message: result.message })
      } else if (result.code === 'not-office') {
        sendJson(res, 415, { ok: false, code: 'not-office' })
      } else {
        sendJson(res, 500, {
          ok: false,
          code: result.code,
          message: result.message ?? null,
          ...(result.officeCode === undefined ? {} : { officeCode: result.officeCode }),
        })
      }
      return
    }
    const pdfName = name.replace(/\.[^.]+$/, '') + '.pdf'
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': result.pdf.length,
      'cache-control': 'private, max-age=30',
      'x-content-type-options': 'nosniff',
      'content-disposition': contentDisposition('inline', pdfName),
      'x-office-cache': result.cached ? 'hit' : 'miss',
    })
    res.end(result.pdf)
  }

  /** GET /link */
  async function link(req, res, url) {
    status.count('link')
    const result = await fetchLinkMetadata({
      url: url.searchParams.get('url'),
      fetchImpl: context.fetchImpl,
      timeoutMs: context.linkTimeoutMs,
      maxBytes: context.linkMaxBytes,
    })
    if (!result.ok) {
      status.fail('link', result.code)
      sendJson(res, 400, { ok: false, code: result.code })
      return
    }
    if (typeof result.error === 'string') status.fail('link', result.error)
    sendJson(res, 200, result)
  }

  /** POST /action */
  async function action(req, res, url) {
    status.count('action')
    if (!isJsonRequest(req)) {
      sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return
    }
    const parsed = await readJsonObject(req, MAX_ACTION_BODY_BYTES)
    if (!parsed.ok) {
      sendJson(res, parsed.status, { ok: false, code: parsed.code })
      return
    }
    const body = parsed.body
    const actionName = body.action
    if (typeof actionName !== 'string' || !SUPPORTED_ACTIONS.includes(actionName)) {
      sendJson(res, 400, {
        ok: false,
        code: 'bad-request',
        message: 'action must be one of: open, reveal, browser, copy-file',
      })
      return
    }
    const cwd = url.searchParams.get('cwd')
    const rawPath = body.path
    const rawUrl = body.url
    let actionPath
    let actionUrl
    let actionInfo

    if (actionName === 'browser' && typeof rawUrl === 'string' && rawUrl.trim() !== '') {
      if (parseLinkUrl(rawUrl) === null) {
        sendJson(res, 400, { ok: false, code: 'bad-url', message: 'url must be http(s)' })
        return
      }
      actionUrl = rawUrl.trim()
    } else {
      if (typeof rawPath !== 'string' || rawPath.trim() === '') {
        sendJson(res, 400, { ok: false, code: 'bad-path', message: 'action needs an existing path' })
        return
      }
      const resolved = await policy.resolveAny(rawPath, cwd)
      if (!resolved.ok) {
        sendJson(res, 400, { ok: false, code: 'bad-path', message: 'path is malformed' })
        return
      }
      try {
        actionInfo = await fsp.stat(resolved.absPath)
      } catch (error) {
        statFailure(res, status, error)
        return
      }
      actionPath = resolved.absPath
    }
    if (actionName === 'copy-file' && !actionInfo.isFile()) {
      sendJson(res, 400, { ok: false, code: 'not-a-file', message: 'copy-file needs a regular file' })
      return
    }

    const outcome = await performAction({
      action: actionName,
      path: actionPath,
      url: actionUrl,
      platform,
      launch: context.launch,
      wait: context.wait,
      copyTimeoutMs: context.copyFileTimeoutMs,
    })
    if (outcome.ok) {
      sendJson(res, 200, { ok: true })
      return
    }
    status.fail('action', outcome.code, outcome.message)
    const statusCode = outcome.code === 'action-unavailable'
      ? 501
      : outcome.code === 'bad-request' || outcome.code === 'bad-path' || outcome.code === 'not-a-file'
        ? 400
        : outcome.code === 'not-found'
          ? 404
          : 500
    sendJson(res, statusCode, { ok: false, code: outcome.code, message: outcome.message })
  }

  /** GET /resolve */
  async function resolve(req, res, url) {
    status.count('resolve')
    const rawName = url.searchParams.get('name')
    const name = typeof rawName === 'string' ? rawName.trim().replace(/^[`"']|[`"']$/g, '') : ''
    if (!isPlainBasename(name)) {
      sendJson(res, 400, { ok: false, code: 'bad-name' })
      return
    }
    const cwd = policy.cwdFrom(url.searchParams.get('cwd'))
    const result = await resolveByName({
      name,
      cwd,
      dshHome: policy.dshHome,
      platform,
      maxDepth: context.resolveMaxDepth,
      maxEntries: context.resolveMaxEntries,
    })
    if (!result.ok) {
      if (result.code === 'ambiguous') {
        sendJson(res, 409, { ok: false, code: 'ambiguous', candidates: result.candidates })
      } else {
        sendJson(res, 404, { ok: false, code: 'not-found' })
      }
      return
    }
    const resolved = await policy.readPath(result.absPath, url.searchParams.get('cwd'))
    if (!resolved.ok) {
      status.fail('resolve', resolved.code)
      sendPolicyFailure(res, resolved.code)
      return
    }
    sendJson(res, 200, {
      ok: true,
      path: resolved.absPath,
      absPath: resolved.absPath,
      name: result.name,
      size: result.size,
      mtimeMs: result.mtimeMs,
    })
  }

  /** GET /status */
  async function statusRoute(req, res) {
    sendJson(res, 200, status.snapshot())
  }

  return {
    meta,
    raw,
    text,
    office: officePdf,
    link,
    action,
    resolve,
    status: statusRoute,
  }
}
