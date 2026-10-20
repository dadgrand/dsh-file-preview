/**
 * dsh-file-preview — Host half.
 *
 * Registers the `/api/dsh-file-preview` route family on the composition's
 * `webServer` carrier. The browser half (built in parallel by the client
 * task) is the in-chat preview modal: it calls `/meta` + `/raw` for images,
 * PDFs and raw bytes, `/text` for text/markdown/code, `/office-pdf` for the
 * six Office formats, `/link` for website cards, `/resolve` for user
 * attachment cards that expose only a display name, and `/action` for
 * open / reveal / open-in-browser.
 *
 * Everything valuable lives in `lib/host/`; this file is only the Cordis
 * wiring. The office service and the optional connection fence are resolved
 * lazily per request, so the plugin mounts on a composition that has neither
 * and answers `office-unavailable` instead of throwing.
 *
 * @module dsh-file-preview
 */

import { createHostApp } from './lib/host/app.js'

/** Package version reported by `/status`. */
export const VERSION = '0.1.0'

/** Host plugin name; the Loader row id in the bundle patch is `file-preview`. */
export const name = 'dsh-file-preview'

/** The browser HTTP carrier is the only required service. */
export const inject = ['webServer']

/** Read an optional service without failing activation. */
function optionalService(ctx, serviceName) {
  try {
    return ctx.get(serviceName)
  } catch {
    return undefined
  }
}

/**
 * Host body: compose the app once, then register each route inside its own
 * `ctx.effect` with a disposer.
 * @param {object} ctx - host root context (needs `webServer`).
 * @param {object} [config] - bundle-row config: `readScope` ('any' default |
 *   'roots'), `allowRoots`, `officeTimeoutMs`, `linkTimeoutMs`, `linkMaxBytes`,
 *   `resolveMaxDepth`, `resolveMaxEntries`.
 */
export function apply(ctx, config = {}) {
  const app = createHostApp({
    version: VERSION,
    config,
    getOfficeToPdf: () => optionalService(ctx, 'officeToPdf'),
    getConnection: () => optionalService(ctx, 'connection'),
  })
  for (const route of app.routes) {
    ctx.effect(() => {
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path: route.path,
        handler: route.handler,
      })
      return () => {
        try {
          dispose()
        } catch {
          // The route fiber is already gone during shutdown.
        }
      }
    }, `dsh-file-preview: ${route.method} ${route.path}`)
  }
}
