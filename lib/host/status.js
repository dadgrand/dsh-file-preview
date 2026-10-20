/**
 * Live counters for the file-preview routes.
 *
 * `/status` is how the owner (and the verification run) proves the overlay is
 * really talking to the Host: one counter per route, the last error, and the
 * last `?seat=<state>` the browser half reported. State lives in the Host app
 * instance, so a plugin reload starts it over.
 *
 * @module dsh-file-preview/host/status
 */

/** Route names counted by `/status`. */
export const COUNTER_NAMES = Object.freeze(['meta', 'raw', 'text', 'office', 'link', 'action', 'resolve'])

/**
 * Create one app instance's status ledger.
 * @param {object} options - ledger options.
 * @param {string} options.version - package version.
 * @param {number} [options.startedAt] - epoch ms of activation.
 * @returns {object} status ledger.
 */
export function createStatusLedger(options) {
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now()
  const requests = Object.fromEntries(COUNTER_NAMES.map(name => [name, 0]))
  let lastError = null
  let lastClientSeat = null

  return {
    /**
     * Count one route hit.
     * @param {string} route - route name.
     */
    count(route) {
      requests[route] = (requests[route] ?? 0) + 1
    },
    /**
     * Remember the last route failure (and keep it for `/status`).
     * @param {string} route - route name.
     * @param {string} code - typed error code.
     * @param {string} [message] - human detail.
     */
    fail(route, code, message = null) {
      lastError = { route, code, message, at: Date.now() }
    },
    /**
     * Record the browser half's mount seat (`?seat=` on any GET).
     * @param {string} seat - state reported by the client.
     */
    seat(seat) {
      lastClientSeat = seat
    },
    /**
     * Snapshot for `GET /status`.
     * @returns {object} the JSON body.
     */
    snapshot() {
      return {
        ok: true,
        version: options.version,
        startedAt: new Date(startedAt).toISOString(),
        requests: { ...requests },
        lastError,
        lastClientSeat,
      }
    },
  }
}
