/**
 * Compose the file-preview Host app: path policy, status ledger, office
 * bridge and the fenced route handlers.
 *
 * `index.js` only maps {@link createHostApp}`().routes` onto
 * `ctx.webServer.register` inside `ctx.effect`. Keeping the route table here
 * means the unit harness can run the exact handlers over a real `node:http`
 * server with the Electron/office/fetch seams stubbed — no DSH process, no
 * app restart.
 *
 * Lazy resolution: the office service is looked up on each `/office-pdf`
 * request through `getOfficeToPdf`, the optional `connection` fence through
 * `getConnection`, and fetch through `globalThis.fetch` at request time.
 * Nothing here touches the filesystem at import or construction time.
 *
 * @module dsh-file-preview/host/app
 */

import { isJsonRequest, isLoopbackRequest, sendJson, sendMethodNotAllowed } from './fence.js'
import { createOfficeService } from './office.js'
import { createPathPolicy } from './paths.js'
import { createRouteHandlers } from './routes.js'
import { createStatusLedger } from './status.js'

/** Route family base path. */
export const ROUTE_BASE = '/api/dsh-file-preview'

/** POST bodies are tiny JSON objects; anything larger is hostile. */
const MAX_ACTION_BODY_BYTES = 64 * 1024

/**
 * The fixed route table (path + method, contract order).
 * `allowHead` is used by `/raw` so a browser can probe size before fetching.
 */
export const ROUTE_DEFINITIONS = Object.freeze([
  Object.freeze({ name: 'meta', method: 'GET', path: `${ROUTE_BASE}/meta`, allowHead: false }),
  Object.freeze({ name: 'raw', method: 'GET', path: `${ROUTE_BASE}/raw`, allowHead: true }),
  Object.freeze({ name: 'text', method: 'GET', path: `${ROUTE_BASE}/text`, allowHead: false }),
  Object.freeze({ name: 'office', method: 'GET', path: `${ROUTE_BASE}/office-pdf`, allowHead: false }),
  Object.freeze({ name: 'link', method: 'GET', path: `${ROUTE_BASE}/link`, allowHead: false }),
  Object.freeze({ name: 'action', method: 'POST', path: `${ROUTE_BASE}/action`, allowHead: false }),
  Object.freeze({ name: 'status', method: 'GET', path: `${ROUTE_BASE}/status`, allowHead: false }),
  Object.freeze({ name: 'resolve', method: 'GET', path: `${ROUTE_BASE}/resolve`, allowHead: false }),
])

/** Parse a request URL defensively. */
function requestUrl(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1')
  } catch {
    return new URL('http://127.0.0.1/')
  }
}

/**
 * Build one Host app instance.
 * @param {object} [options] - app options.
 * @param {string} [options.version] - package version for `/status`.
 * @param {object} [options.config] - bundle-row config (`readScope`, `allowRoots`, timeouts, resolve limits).
 * @param {() => {convert: Function}|undefined} [options.getOfficeToPdf] - lazy office service lookup.
 * @param {() => object|undefined} [options.getConnection] - lazy `connection` service lookup.
 * @param {Function} [options.fetchImpl] - link fetch seam.
 * @param {Function} [options.launch] - OS launcher seam.
 * @param {Function} [options.wait] - clipboard waiter seam.
 * @param {string} [options.platform] - platform override (tests).
 * @param {string} [options.cwd] - cwd override (tests).
 * @param {string} [options.home] - home override (tests).
 * @param {string} [options.dshHome] - DSH home override (tests).
 * @param {string} [options.tmpDir] - temp root override (tests).
 * @param {string[]} [options.allowRoots] - extra allowed roots (tests).
 * @param {number} [options.startedAt] - epoch ms for `/status`.
 * @returns {object} host app: `{routes, dispatch, status, policy, office, version}`.
 */
export function createHostApp(options = {}) {
  const config = typeof options.config === 'object' && options.config !== null ? options.config : {}
  const platform = options.platform ?? process.platform
  const allowRoots = [
    ...(Array.isArray(config.allowRoots) ? config.allowRoots : []),
    ...(Array.isArray(options.allowRoots) ? options.allowRoots : []),
  ]
  const policy = createPathPolicy({
    platform,
    cwd: options.cwd,
    home: options.home,
    dshHome: options.dshHome,
    tmpDir: options.tmpDir,
    allowRoots,
    readScope: config.readScope,
  })
  const status = createStatusLedger({
    version: options.version ?? '0.1.0',
    startedAt: options.startedAt,
  })
  const getOfficeToPdf = typeof options.getOfficeToPdf === 'function'
    ? options.getOfficeToPdf
    : () => options.officeToPdf
  const office = createOfficeService({
    dshHome: policy.dshHome,
    timeoutMs: config.officeTimeoutMs,
    resolveService: getOfficeToPdf,
  })
  const handlers = createRouteHandlers({
    policy,
    office,
    status,
    platform,
    fetchImpl: options.fetchImpl,
    launch: options.launch,
    wait: options.wait,
    copyFileTimeoutMs: config.copyFileTimeoutMs,
    linkTimeoutMs: config.linkTimeoutMs,
    linkMaxBytes: config.linkMaxBytes,
    resolveMaxDepth: config.resolveMaxDepth,
    resolveMaxEntries: config.resolveMaxEntries,
  })

  /** Ask the composition's connection service for its rejection (when mounted). */
  function connectionRejection(req) {
    if (typeof options.getConnection !== 'function') return undefined
    let connection
    try {
      connection = options.getConnection()
    } catch {
      return undefined
    }
    if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') return undefined
    try {
      return connection.requestRejection(req)
    } catch {
      return 403
    }
  }

  /** Fence + seat recording; null means the request was already answered. */
  function guard(req, res) {
    if (!isLoopbackRequest(req)) {
      sendJson(res, 403, { ok: false, code: 'forbidden', message: 'loopback-only route' })
      return null
    }
    const rejection = connectionRejection(req)
    if (rejection !== undefined && rejection !== null && rejection !== false) {
      sendJson(res, 403, { ok: false, code: 'forbidden', message: 'connection fence rejected the request' })
      return null
    }
    const url = requestUrl(req)
    const seat = url.searchParams.get('seat')
    if (typeof seat === 'string' && seat.trim() !== '') status.seat(seat.slice(0, 80))
    return url
  }

  /** Method + body-type gate, then the route handler, with one error boundary. */
  async function invoke(route, req, res, url) {
    const allowed = route.allowHead ? ['GET', 'HEAD'] : [route.method]
    if (!allowed.includes(req.method ?? '')) {
      sendMethodNotAllowed(res, allowed.join(', '))
      return
    }
    if (route.method === 'POST' && !isJsonRequest(req)) {
      sendJson(res, 415, { ok: false, code: 'unsupported-media-type', message: 'content-type must be application/json' })
      return
    }
    try {
      await handlers[route.name](req, res, url)
    } catch (error) {
      status.fail(route.name, 'handler-failed', error instanceof Error ? error.message : String(error))
      if (res.headersSent) {
        res.destroy()
        return
      }
      sendJson(res, 500, {
        ok: false,
        code: 'handler-failed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const byPath = new Map(ROUTE_DEFINITIONS.map(route => [route.path, route]))
  const routes = ROUTE_DEFINITIONS.map(route => ({
    name: route.name,
    method: route.method,
    path: route.path,
    allowHead: route.allowHead,
    handler: async (req, res) => {
      const url = guard(req, res)
      if (url === null) return
      await invoke(route, req, res, url)
    },
  }))

  /**
   * Test/server dispatch: fence, exact-path lookup, method gate, handler.
   * @param {import('node:http').IncomingMessage} req - request.
   * @param {import('node:http').ServerResponse} res - response.
   * @returns {Promise<void>} resolves after the response settled.
   */
  async function dispatch(req, res) {
    const url = guard(req, res)
    if (url === null) return
    const route = byPath.get(url.pathname)
    if (route === undefined) {
      sendJson(res, 404, { ok: false, code: 'not-found', message: 'unknown file-preview route' })
      return
    }
    await invoke(route, req, res, url)
  }

  return { routes, dispatch, status, policy, office, version: options.version ?? '0.1.0' }
}

/** Exported for the method gate's body ceiling documentation/tests. */
export { MAX_ACTION_BODY_BYTES }
