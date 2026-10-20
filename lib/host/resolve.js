/**
 * Resolve an attachment display name to a real path.
 *
 * User attachment cards in the chat DOM carry only the uploaded file name —
 * no path and no attachment id (research §3(c), §4.2). The browser half
 * therefore asks the Host to find a file with that basename.
 *
 * Root precedence is explicit and authoritative: `$DSH_HOME/attachments`
 * (where durable attachment objects and their named hard links live) is
 * searched first, and as soon as it holds at least one basename match the
 * answer comes from that root only — the newest by mtime, `ambiguous` on an
 * exact mtime tie. The request cwd is a fallback and is scanned only when the
 * attachment store has no match; a newer same-named workspace file can never
 * outrank the attachment the user clicked.
 *
 * The scan is bounded (depth + inspected-entry ceilings shared across the
 * roots), skips symlinks and unreadable directories, and compares basenames
 * case-insensitively on Windows.
 *
 * @module dsh-file-preview/host/resolve
 */

import { promises as fsp } from 'node:fs'
import { basename, isAbsolute, join, resolve as resolvePath } from 'node:path'

/** Default recursion depth below each root. */
const DEFAULT_MAX_DEPTH = 8
/** Default number of directory entries inspected across all roots. */
const DEFAULT_MAX_ENTRIES = 20_000

/**
 * Whether a file's basename matches the requested display name.
 * @param {string} candidate - filesystem basename.
 * @param {string} wanted - requested basename.
 * @param {string} platform - `process.platform` (win32 = case-insensitive).
 * @returns {boolean} true on a match.
 */
export function basenameMatches(candidate, wanted, platform = process.platform) {
  return platform === 'win32' ? candidate.toLowerCase() === wanted.toLowerCase() : candidate === wanted
}

/**
 * Scan one root for basename matches.
 * @param {string} root - directory to search.
 * @param {object} request - search facts (`name`).
 * @param {string} platform - `process.platform` override.
 * @param {number} maxDepth - recursion ceiling.
 * @param {number} budget - remaining inspected-entry budget.
 * @returns {Promise<{matches: object[], inspected: number, exhausted: boolean}>} scan result.
 */
async function scanRoot(root, request, platform, maxDepth, budget) {
  const matches = []
  const seen = new Set()
  const stack = [{ directory: root, depth: 0 }]
  let inspected = 0
  let exhausted = false

  while (stack.length > 0 && !exhausted) {
    const { directory, depth } = stack.pop()
    let entries
    try {
      entries = await fsp.readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (inspected >= budget) {
        exhausted = true
        break
      }
      inspected += 1
      const absolute = join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ directory: absolute, depth: depth + 1 })
        continue
      }
      if (!entry.isFile()) continue
      if (!basenameMatches(entry.name, request.name, platform)) continue
      if (seen.has(absolute)) continue
      seen.add(absolute)
      try {
        const stat = await fsp.stat(absolute)
        matches.push({
          path: absolute,
          absPath: absolute,
          name: basename(absolute),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      } catch {
        // The entry disappeared between readdir and stat: ignore it.
      }
    }
  }
  return { matches, inspected, exhausted }
}

/**
 * Find files by basename below the attachment store, falling back to the
 * request cwd only when the attachment store has no match.
 * @param {object} request - search facts.
 * @param {string} request.name - display basename.
 * @param {string} request.cwd - request cwd root.
 * @param {string} request.dshHome - `$DSH_HOME`.
 * @param {string} [request.platform] - `process.platform` override.
 * @param {number} [request.maxDepth] - recursion ceiling.
 * @param {number} [request.maxEntries] - inspected-entry ceiling.
 * @returns {Promise<{ok: true, path: string, absPath: string, name: string, size: number, mtimeMs: number}|{ok: false, code: 'not-found'|'ambiguous', candidates?: object[]}>} result.
 */
export async function resolveByName(request) {
  const platform = request.platform ?? process.platform
  const maxDepth = Number.isFinite(request.maxDepth) ? request.maxDepth : DEFAULT_MAX_DEPTH
  const maxEntries = Number.isFinite(request.maxEntries) ? request.maxEntries : DEFAULT_MAX_ENTRIES
  // Order is the precedence: the first root with a match wins and ends the search.
  const roots = [join(request.dshHome, 'attachments'), resolvePath(request.cwd)]
  let remaining = maxEntries
  let matches = []

  for (const root of roots) {
    if (remaining <= 0) break
    const scan = await scanRoot(root, request, platform, maxDepth, remaining)
    remaining -= scan.inspected
    if (scan.matches.length > 0) {
      matches = scan.matches
      break
    }
    if (scan.exhausted) break
  }

  if (matches.length === 0) return { ok: false, code: 'not-found' }
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs || left.absPath.localeCompare(right.absPath))
  const newest = matches[0]
  if (matches.length > 1 && matches[1].mtimeMs === newest.mtimeMs) {
    return { ok: false, code: 'ambiguous', candidates: matches.slice(0, 8) }
  }
  return { ok: true, ...newest }
}

/**
 * Whether a name is a plain basename (no separators, no NUL).
 * @param {unknown} name - candidate display name.
 * @returns {boolean} true when it is a basename.
 */
export function isPlainBasename(name) {
  return typeof name === 'string'
    && name.trim() !== ''
    && !name.includes('\u0000')
    && !name.includes('/')
    && !name.includes('\\')
    && !isAbsolute(name)
}
