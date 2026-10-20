/**
 * Path resolution and the allowed-root policy for the file-preview routes.
 *
 * Input may be absolute or relative (relative to the `cwd` query parameter,
 * else the Host process cwd), may use `~` for the user home, may be wrapped
 * in quotes or backticks (chat UIs quote paths), and may be a `file://` URL.
 *
 * Reading routes (`/meta`, `/raw`, `/text`, `/office-pdf`, `/resolve`) follow
 * the `readScope` config:
 *
 * - `any` (the default): any existing absolute path on this machine is
 *   readable. The owner's own page may preview any file the owner references,
 *   including paths outside the session cwd, home and temp directories.
 * - `roots`: the strict allow-list — the real path must be inside the request
 *   cwd, `$DSH_HOME`, `os.homedir()`, `os.tmpdir()` or Config `allowRoots`.
 *
 * In both modes the path is normalised and resolved with `node:path`, control
 * characters are refused, and the real path is used (symlinks are followed, so
 * strict mode cannot be escaped through a link). Windows comparisons are
 * case-insensitive. `/action` is user-initiated and accepts any existing path.
 *
 * Only Node built-ins; no state outside the returned policy object.
 *
 * @module dsh-file-preview/host/paths
 */

import { promises as fsp } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Strip one matching pair of surrounding quotes/backticks. */
export function stripWrappingQuotes(value) {
  if (typeof value !== 'string' || value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first === '"' || first === "'" || first === '`') && first === last) return value.slice(1, -1)
  return value
}

/**
 * Expand a leading `~` or `~/`/`~\` to the user home.
 * @param {string} value - path text.
 * @param {string} home - user home directory.
 * @returns {string} expanded text.
 */
export function expandHome(value, home) {
  if (typeof value !== 'string' || value === '') return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(home, value.slice(2))
  return value
}

/**
 * Resolve one path even when its tail does not exist yet: the nearest existing
 * ancestor is realpath'd and the remaining segments are appended as typed.
 * @param {string} target - absolute path.
 * @returns {Promise<string>} real path (or the resolved best effort).
 */
export async function realpathLoose(target) {
  let current = resolvePath(target)
  const missing = []
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      const real = await fsp.realpath(current)
      return missing.length === 0 ? real : join(real, ...missing)
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return resolvePath(target)
      const parent = dirname(current)
      if (parent === current) return resolvePath(target)
      missing.unshift(basename(current))
      current = parent
    }
  }
  return resolvePath(target)
}

/**
 * Whether `target` equals `root` or lives under it.
 * @param {string} root - allowed root.
 * @param {string} target - candidate path.
 * @param {string} platform - `process.platform` value (win32 = case-insensitive).
 * @returns {boolean} true when inside.
 */
export function isInside(root, target, platform = process.platform) {
  const normalize = value => platform === 'win32' ? value.toLowerCase() : value
  const rootPath = normalize(resolvePath(root))
  const targetPath = normalize(resolvePath(target))
  if (rootPath === targetPath) return true
  const rel = relative(rootPath, targetPath)
  return rel !== '' && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

/**
 * Build the path policy for one Host app instance.
 * @param {object} [options] - overrides (tests inject all of them).
 * @param {string} [options.cwd] - Host process cwd.
 * @param {string} [options.home] - user home.
 * @param {string} [options.dshHome] - DSH home directory.
 * @param {string} [options.tmpDir] - OS temporary directory.
 * @param {string[]} [options.allowRoots] - extra roots from Config.
 * @param {'any'|'roots'} [options.readScope] - reading policy; `any` by default.
 * @param {string} [options.platform] - `process.platform` override.
 * @returns {object} policy with expand/readPath/resolveAny helpers.
 */
export function createPathPolicy(options = {}) {
  const platform = options.platform ?? process.platform
  const readScope = options.readScope === 'roots' ? 'roots' : 'any'
  const home = resolvePath(options.home ?? homedir())
  const dshHome = resolvePath(options.dshHome ?? (process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
  const tempDir = resolvePath(options.tmpDir ?? tmpdir())
  const baseCwd = resolvePath(options.cwd ?? process.cwd())
  const extraRoots = Array.isArray(options.allowRoots)
    ? options.allowRoots.filter(value => typeof value === 'string' && value.trim() !== '').map(value => resolvePath(expandHome(stripWrappingQuotes(value.trim()), home)))
    : []

  /**
   * Resolve the request cwd: the query parameter when readable, else Host cwd.
   * @param {string|null|undefined} raw - `cwd` query value.
   * @returns {string} absolute cwd.
   */
  function cwdFrom(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') return baseCwd
    let value = stripWrappingQuotes(raw.trim())
    if (/^file:/i.test(value)) {
      try {
        value = fileURLToPath(value)
      } catch {
        return baseCwd
      }
    }
    value = expandHome(value, home)
    return isAbsolute(value) ? resolvePath(value) : resolvePath(baseCwd, value)
  }

  /**
   * Expand user input to an absolute path without any root check.
   * @param {unknown} input - raw `path` value.
   * @param {string|null|undefined} rawCwd - `cwd` query value.
   * @returns {{ok: true, input: string, absPath: string, cwd: string}|{ok: false, code: string}} expansion result.
   */
  function expand(input, rawCwd) {
    if (typeof input !== 'string') return { ok: false, code: 'bad-path' }
    let value = stripWrappingQuotes(input.trim())
    if (value === '') return { ok: false, code: 'bad-path' }
    if (/^file:/i.test(value)) {
      try {
        value = fileURLToPath(value)
      } catch {
        return { ok: false, code: 'bad-path' }
      }
    }
    value = stripWrappingQuotes(value.trim())
    if (value === '' || /[\u0000-\u001f\u007f]/.test(value)) return { ok: false, code: 'bad-path' }
    value = expandHome(value, home)
    const cwd = cwdFrom(rawCwd)
    const absPath = isAbsolute(value) ? resolvePath(value) : resolvePath(cwd, value)
    return { ok: true, input, absPath, cwd }
  }

  /**
   * Allowed roots for one request, realpath'd when they exist.
   * @param {string} cwd - request cwd.
   * @returns {Promise<string[]>} real roots.
   */
  async function rootsFor(cwd) {
    const roots = [cwd, home, dshHome, tempDir, ...extraRoots]
    const resolved = await Promise.all(roots.map(root => realpathLoose(root)))
    return [...new Set(resolved)]
  }

  /**
   * Expand a reading path and apply the configured read scope.
   * @param {unknown} input - raw `path` value.
   * @param {string|null|undefined} rawCwd - `cwd` query value.
   * @returns {Promise<{ok: true, input: string, absPath: string, cwd: string}|{ok: false, code: string}>} resolution.
   */
  async function readPath(input, rawCwd) {
    const expanded = expand(input, rawCwd)
    if (!expanded.ok) return expanded
    const real = await realpathLoose(expanded.absPath)
    if (readScope === 'roots') {
      const roots = await rootsFor(expanded.cwd)
      const allowed = roots.some(root => isInside(root, real, platform))
      if (!allowed) return { ok: false, code: 'outside-allowed-roots' }
    }
    return { ok: true, input: expanded.input, absPath: real, cwd: expanded.cwd }
  }

  /**
   * Expand a user-initiated path without a root check (`/action`).
   * @param {unknown} input - raw `path` value.
   * @param {string|null|undefined} rawCwd - `cwd` query value.
   * @returns {Promise<{ok: true, input: string, absPath: string, cwd: string}|{ok: false, code: string}>} resolution.
   */
  async function resolveAny(input, rawCwd) {
    const expanded = expand(input, rawCwd)
    if (!expanded.ok) return expanded
    return { ok: true, input: expanded.input, absPath: await realpathLoose(expanded.absPath), cwd: expanded.cwd }
  }

  return {
    platform,
    readScope,
    home,
    dshHome,
    tempDir,
    baseCwd,
    extraRoots,
    cwdFrom,
    expand,
    rootsFor,
    readPath,
    resolveAny,
    isInside: (root, target) => isInside(root, target, platform),
  }
}
