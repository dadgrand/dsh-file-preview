/**
 * Office-document preview: bytes in, PDF out, through the shipped
 * `officeToPdf` service.
 *
 * The service is resolved lazily on every request, so the plugin mounts even
 * when the desktop composition has no `office-pdf` row: a missing service
 * becomes `{code:'office-unavailable'}` (HTTP 501 for the route) rather than
 * an activation throw. In-process `convert()` needs no other service
 * (research §5.5), so this module supplies its own deferred `source.read`.
 *
 * Converted PDFs are cached under `$DSH_HOME/cache/file-preview/`, keyed by
 * absolute path + mtimeMs + size (sha256), so a touched or resized source
 * misses the cache naturally. Writes are atomic (tmp + rename) and the cache
 * is best effort: a read-only cache directory never fails a preview.
 *
 * @module dsh-file-preview/host/office
 */

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { officeExtensionFor } from './mime.js'

/** Default conversion budget (LibreOffice cold start included). */
const DEFAULT_TIMEOUT_MS = 120_000

/**
 * Stable cache key for one source identity.
 * @param {string} absPath - absolute source path.
 * @param {number} mtimeMs - source mtime.
 * @param {number} size - source byte size.
 * @returns {string} sha256 hex prefix.
 */
export function cacheKeyFor(absPath, mtimeMs, size) {
  return createHash('sha256')
    .update(`${absPath}\u0000${mtimeMs}\u0000${size}`)
    .digest('hex')
    .slice(0, 48)
}

/**
 * Build the office conversion service for one Host app instance.
 * @param {object} options - service options.
 * @param {string} options.dshHome - `$DSH_HOME`.
 * @param {() => ({convert: Function}|undefined)} options.resolveService - lazy `officeToPdf` lookup.
 * @param {number} [options.timeoutMs] - conversion budget.
 * @returns {{cacheDir: string, convert: Function}} service.
 */
export function createOfficeService(options) {
  const cacheDir = join(options.dshHome, 'cache', 'file-preview')
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS
  /** In-flight conversions keyed by cache path (concurrent modal opens share one job). */
  const inFlight = new Map()

  /** Read a valid cached PDF, or null. */
  async function readCache(cachePath) {
    try {
      const bytes = await fsp.readFile(cachePath)
      return bytes.length > 5 && bytes.subarray(0, 4).toString('latin1') === '%PDF' ? bytes : null
    } catch {
      return null
    }
  }

  /** Convert one file and fill the cache. */
  async function produce(absPath, stat, extension, service, cachePath, cacheKey) {
    await fsp.mkdir(cacheDir, { recursive: true }).catch(() => {})
    const version = `${stat.mtimeMs}:${stat.size}`
    let result
    try {
      result = await service.convert({
        extension,
        priority: 'foreground',
        source: {
          key: absPath,
          version,
          bytes: stat.size,
          read: async (signal, maxBytes) => {
            if (typeof signal?.throwIfAborted === 'function') signal.throwIfAborted()
            if (typeof maxBytes === 'number' && stat.size > maxBytes) {
              throw new Error(`source exceeds the reserved ${String(maxBytes)} bytes`)
            }
            const bytes = await fsp.readFile(absPath)
            return { bytes: new Uint8Array(bytes), version }
          },
        },
      }, AbortSignal.timeout(timeoutMs))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const officeCode = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : null
      return { ok: false, code: 'office-failed', officeCode, message }
    }
    const pdf = result?.pdf
    if (!(pdf instanceof Uint8Array) || pdf.byteLength < 5) {
      return { ok: false, code: 'office-failed', officeCode: 'invalid-output', message: 'officeToPdf returned no PDF bytes' }
    }
    const buffer = Buffer.from(pdf)
    try {
      const temporary = `${cachePath}.${String(process.pid)}.${String(Date.now())}.tmp`
      await fsp.writeFile(temporary, buffer)
      await fsp.rename(temporary, cachePath)
    } catch {
      // A cache write failure must not hide a successful conversion.
    }
    return { ok: true, pdf: buffer, cacheKey, cached: false, missingFonts: result?.missingFonts ?? [] }
  }

  /**
   * Convert one Office file to PDF, reusing the disk cache.
   * @param {object} request - conversion facts.
   * @param {string} request.absPath - absolute source path.
   * @param {{mtimeMs: number, size: number}} request.stat - source stat.
   * @param {string} request.extension - extension with or without dot.
   * @returns {Promise<{ok: true, pdf: Buffer, cacheKey: string, cached: boolean}|{ok: false, code: string, message?: string, officeCode?: string|null}>} result.
   */
  async function convert({ absPath, stat, extension }) {
    const officeExt = officeExtensionFor(extension)
    if (officeExt === null) return { ok: false, code: 'not-office', message: `not an Office extension: ${String(extension)}` }
    const service = options.resolveService()
    if (service === undefined || service === null || typeof service.convert !== 'function') {
      return { ok: false, code: 'office-unavailable', message: 'the officeToPdf service is not mounted in this Host' }
    }
    const cacheKey = cacheKeyFor(absPath, stat.mtimeMs, stat.size)
    const cachePath = join(cacheDir, `${cacheKey}.pdf`)
    const cached = await readCache(cachePath)
    if (cached !== null) return { ok: true, pdf: cached, cacheKey, cached: true, missingFonts: [] }
    let pending = inFlight.get(cachePath)
    if (pending === undefined) {
      pending = produce(absPath, stat, officeExt, service, cachePath, cacheKey)
      inFlight.set(cachePath, pending)
      pending.then(() => inFlight.delete(cachePath), () => inFlight.delete(cachePath))
    }
    return pending
  }

  return { cacheDir, convert }
}
